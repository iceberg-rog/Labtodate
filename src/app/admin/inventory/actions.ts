'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getAdminCaps, requireCapability } from '@/lib/auth-server';
import { capsAllow } from '@/lib/capabilities';
import { audit } from '@/lib/observability';
import { invalidateStale } from '@/lib/stale-cache';
import { checkLowStock } from '@/lib/inventory/alerts';
import { COLUMNS, type EditableField, type InventoryRow } from '@/lib/inventory/fields';
import { loadInventoryRows } from '@/lib/inventory/rows';
import {
  INVENTORY_SETTING_DEFS,
  getInventorySettings,
  invalidateInventorySettings,
  inventorySettingDef,
  validateSettingInput,
} from '@/lib/inventory/settings';
import { reservationsFor, type ReservationLine } from '@/lib/inventory/stock';
import { cleanMultiline, cleanText, hasArabicScript } from '@/lib/inventory/text';
import {
  applyInventoryChanges,
  assignMissingSkus,
  createInventoryProduct,
  type CellChange,
  type FieldIssue,
  type WriteContext,
  type WriteSource,
} from '@/lib/inventory/write';

const EDITABLE = COLUMNS.filter((c) => c.editable).map((c) => c.key) as [EditableField, ...EditableField[]];

async function writeContext(source: WriteSource, cap = 'inventory:edit', batchId?: string): Promise<WriteContext & { userId: string }> {
  const session = await requireCapability(cap);
  const caps = await getAdminCaps();
  return {
    userId: session.user.id,
    actorEmail: session.user.email,
    source,
    batchId,
    canCost: capsAllow(caps, 'inventory:cost'),
    canApprove: capsAllow(caps, 'products:approve'),
    settings: await getInventorySettings(),
  };
}

/** Make every public page that shows these items recompute now. */
async function publish(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { slug: true } });
  for (const p of products) revalidatePath(`/marketplace/${p.slug}`);
  revalidatePath('/marketplace');
  revalidatePath('/');
  revalidatePath('/admin/inventory');
  invalidateStale('home:'); // homepage counts and cards (60 s in-process cache)
  await checkLowStock(ids);
}

export type RowResult = { id: string; ok: boolean; issues: FieldIssue[]; row: InventoryRow | null; notes: string[]; changed: string[] };

const valueSchema = z.union([z.string().max(5000), z.number(), z.null()]);
const EditsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(64),
      changes: z
        .array(z.object({ field: z.enum(EDITABLE), value: valueSchema, base: valueSchema.optional() }))
        .min(1)
        .max(30),
    }),
  )
  .min(1)
  .max(500);

/** Save cell edits from the sheet (typing, paste, undo). Each row: all its changes or none. */
export async function saveInventoryRows(edits: { id: string; changes: CellChange[] }[]): Promise<{ results: RowResult[] }> {
  const ctx = await writeContext('GRID');
  const parsed = EditsSchema.safeParse(edits);
  if (!parsed.success) {
    return { results: edits.map((e) => ({ id: e.id, ok: false, issues: [{ field: '*', kind: 'error', message: 'Invalid edit.' }], row: null, notes: [], changed: [] })) };
  }
  const results: RowResult[] = [];
  for (const e of parsed.data) {
    const r = await applyInventoryChanges(e.id, e.changes as CellChange[], ctx);
    results.push({ id: e.id, ...r });
  }
  await publish(results.filter((r) => r.ok && r.changed.length).map((r) => r.id));
  return { results };
}

export type BulkOp =
  | { type: 'set'; field: EditableField; value: string | number | null }
  | { type: 'price'; mode: 'percent' | 'amount'; amount: number }
  | { type: 'onHand'; delta: number }
  | { type: 'assignSku' };

const BulkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set'), field: z.enum(EDITABLE), value: valueSchema }),
  z.object({ type: z.literal('price'), mode: z.enum(['percent', 'amount']), amount: z.number().finite().min(-1_000_000).max(1_000_000) }),
  z.object({ type: z.literal('onHand'), delta: z.number().int().min(-100_000).max(100_000) }),
  z.object({ type: z.literal('assignSku') }),
]);

/** Change many rows at once. Each row is saved on its own; failures are listed, the rest still apply. */
export async function bulkInventory(ids: string[], op: BulkOp): Promise<{ ok: number; failed: { id: string; title: string; message: string }[]; results: RowResult[] }> {
  const batchId = `bulk-${Date.now().toString(36)}`;
  const ctx = await writeContext('BULK', 'inventory:edit', batchId);
  const opP = BulkSchema.safeParse(op);
  const idsP = z.array(z.string().min(1).max(64)).min(1).max(2000).safeParse(ids);
  if (!opP.success || !idsP.success) return { ok: 0, failed: [{ id: '*', title: '', message: 'Invalid bulk edit.' }], results: [] };
  const o = opP.data;

  if (o.type === 'assignSku') {
    const n = await assignMissingSkus(idsP.data, ctx);
    const rows = await loadInventoryRows({ ids: idsP.data, canCost: ctx.canCost });
    revalidatePath('/admin/inventory');
    return { ok: n, failed: [], results: rows.map((row) => ({ id: row.id, ok: true, issues: [], row, notes: [], changed: ['sku'] })) };
  }

  const current = new Map((await loadInventoryRows({ ids: idsP.data, canCost: true })).map((r) => [r.id, r]));
  const results: RowResult[] = [];
  const failed: { id: string; title: string; message: string }[] = [];
  for (const id of idsP.data) {
    const row = current.get(id);
    if (!row) continue;
    let changes: CellChange[];
    if (o.type === 'set') {
      changes = [{ field: o.field, value: o.value }];
    } else if (o.type === 'price') {
      if (row.priceCents === null) {
        failed.push({ id, title: row.title, message: 'Has no selling price; skipped.' });
        continue;
      }
      const next = o.mode === 'percent' ? Math.round(row.priceCents * (1 + o.amount / 100)) : row.priceCents + Math.round(o.amount * 100);
      changes = [{ field: 'priceCents', value: Math.max(0, next) / 100, base: row.priceCents }];
    } else {
      changes = [{ field: 'onHand', value: row.onHand + o.delta, base: row.onHand }];
    }
    const r = await applyInventoryChanges(id, changes, ctx);
    results.push({ id, ...r });
    if (!r.ok) failed.push({ id, title: row.title, message: r.issues.map((i) => i.message).join(' ') });
  }
  await publish(results.filter((r) => r.ok && r.changed.length).map((r) => r.id));
  await audit('inventory.bulk', batchId, `${o.type} on ${idsP.data.length} items, ${failed.length} failed`);
  return { ok: results.filter((r) => r.ok).length, failed, results };
}

/** Add a stock item: creates its listing (draft unless chosen otherwise) and saves the first values. */
export async function createInventoryItem(input: {
  title: string;
  category: string;
  condition?: string;
  mode?: string;
  onHand?: string;
  priceCents?: string;
  publish?: boolean;
}): Promise<{ ok: true; row: InventoryRow; notes: string[] } | { ok: false; message: string }> {
  const ctx = await writeContext('GRID');
  const created = await createInventoryProduct(
    { title: input.title, category: input.category, condition: input.condition, mode: input.mode, status: input.publish ? 'PUBLISHED' : 'DRAFT' },
    ctx.userId,
    ctx,
  );
  if (!created.ok) return created;
  const changes: CellChange[] = [];
  if (input.onHand && cleanText(input.onHand)) changes.push({ field: 'onHand', value: input.onHand });
  if (input.priceCents && cleanText(input.priceCents)) changes.push({ field: 'priceCents', value: input.priceCents });
  // Always run once, so the automatic SKU (if on) is assigned at creation.
  const r = await applyInventoryChanges(created.id, changes.length ? changes : [{ field: 'onHand', value: 0 }], ctx);
  await publish([created.id]);
  await audit('inventory.create', created.slug);
  if (!r.ok || !r.row) {
    const [row] = await loadInventoryRows({ ids: [created.id], canCost: ctx.canCost });
    return { ok: true, row, notes: [`Created, but: ${r.issues.map((i) => i.message).join(' ')}`] };
  }
  return { ok: true, row: r.row, notes: r.notes };
}

export async function getReservations(productId: string): Promise<ReservationLine[]> {
  await requireCapability('inventory:view');
  return reservationsFor(String(productId).slice(0, 64));
}

export type HistoryEntry = {
  at: string;
  kind: 'change' | 'order';
  field?: string;
  from?: string | null;
  to?: string | null;
  source?: string;
  actor?: string | null;
  order?: { id: string; number: string; status: string; quantity: number };
};

/** One item's change history and orders, newest first. */
export async function getItemHistory(productId: string): Promise<HistoryEntry[]> {
  await requireCapability('inventory:view');
  const caps = await getAdminCaps();
  const canCost = capsAllow(caps, 'inventory:cost');
  const id = String(productId).slice(0, 64);
  const [events, orders] = await Promise.all([
    prisma.inventoryEvent.findMany({ where: { productId: id }, orderBy: { createdAt: 'desc' }, take: 300 }),
    prisma.orderItem.findMany({
      where: { productId: id },
      select: { quantity: true, order: { select: { id: true, orderNumber: true, status: true, createdAt: true } } },
      orderBy: { order: { createdAt: 'desc' } },
      take: 100,
    }),
  ]);
  const out: HistoryEntry[] = [
    ...events
      .filter((e) => canCost || e.field !== 'costCents')
      .map((e) => ({ at: e.createdAt.toISOString(), kind: 'change' as const, field: e.field, from: e.oldValue, to: e.newValue, source: e.source, actor: e.actorEmail })),
    ...orders.map((o) => ({
      at: o.order.createdAt.toISOString(),
      kind: 'order' as const,
      order: { id: o.order.id, number: o.order.orderNumber, status: o.order.status, quantity: o.quantity },
    })),
  ];
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

// ─── Suppliers ──────────────────────────────────────────────

const SupplierSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().max(120),
  contactName: z.string().max(120).optional(),
  email: z.string().max(200).optional(),
  phone: z.string().max(60).optional(),
  website: z.string().max(300).optional(),
  notes: z.string().max(2000).optional(),
});

export async function saveSupplier(input: z.infer<typeof SupplierSchema>): Promise<{ ok: boolean; message: string; id?: string }> {
  await requireCapability('inventory:edit');
  const p = SupplierSchema.safeParse(input);
  if (!p.success) return { ok: false, message: 'Check the fields: one of them is too long.' };
  const settings = await getInventorySettings();
  const data = {
    name: cleanText(p.data.name),
    contactName: cleanText(p.data.contactName) || null,
    email: cleanText(p.data.email) || null,
    phone: cleanText(p.data.phone) || null,
    website: cleanText(p.data.website) || null,
    notes: cleanMultiline(p.data.notes) || null,
  };
  if (data.name.length < 2) return { ok: false, message: 'The supplier needs a name.' };
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return { ok: false, message: 'That e-mail address does not look right.' };
  if (settings.INVENTORY_LATIN_ONLY === 'all' && Object.values(data).some((v) => v && hasArabicScript(v))) {
    return { ok: false, message: 'Persian/Arabic text is not allowed (Inventory settings → Language). Use English.' };
  }
  const clash = await prisma.supplier.findFirst({
    where: { name: { equals: data.name, mode: 'insensitive' }, ...(p.data.id ? { id: { not: p.data.id } } : {}) },
    select: { id: true },
  });
  if (clash) return { ok: false, message: `A supplier called "${data.name}" already exists.` };
  const saved = p.data.id
    ? await prisma.supplier.update({ where: { id: p.data.id }, data, select: { id: true } })
    : await prisma.supplier.create({ data, select: { id: true } });
  await audit(p.data.id ? 'inventory.supplier.update' : 'inventory.supplier.create', data.name);
  revalidatePath('/admin/inventory/suppliers');
  revalidatePath('/admin/inventory');
  return { ok: true, message: 'Saved.', id: saved.id };
}

export async function deleteSupplier(id: string): Promise<{ ok: boolean; message: string }> {
  await requireCapability('inventory:edit');
  const s = await prisma.supplier.findUnique({ where: { id: String(id).slice(0, 64) }, select: { id: true, name: true } });
  if (!s) return { ok: false, message: 'Supplier not found.' };
  await prisma.supplier.delete({ where: { id: s.id } }); // items keep their data; their supplier becomes empty
  await audit('inventory.supplier.delete', s.name);
  revalidatePath('/admin/inventory/suppliers');
  revalidatePath('/admin/inventory');
  return { ok: true, message: `Deleted "${s.name}".` };
}

// ─── Settings ───────────────────────────────────────────────

export async function saveInventorySettings(values: Record<string, string>): Promise<{ ok: boolean; message: string; errors?: Record<string, string> }> {
  await requireCapability('settings:write');
  const errors: Record<string, string> = {};
  const toSave: { key: string; value: string }[] = [];
  for (const def of INVENTORY_SETTING_DEFS) {
    if (!(def.key in values)) continue;
    const r = validateSettingInput(def, String(values[def.key] ?? ''));
    if ('error' in r) errors[def.key] = r.error;
    else toSave.push({ key: def.key, value: r.value });
  }
  for (const k of Object.keys(values)) if (!inventorySettingDef(k)) errors[k] = 'Unknown setting.';
  const cat = toSave.find((x) => x.key === 'INVENTORY_IMPORT_DEFAULT_CATEGORY');
  if (cat?.value && !(await prisma.category.findFirst({ where: { slug: cat.value }, select: { id: true } }))) {
    errors[cat.key] = 'That category no longer exists.';
  }
  const low = toSave.find((x) => x.key === 'INVENTORY_LOW_STOCK_EMAIL');
  const to = toSave.find((x) => x.key === 'INVENTORY_LOW_STOCK_EMAIL_TO');
  if (low?.value === 'true' && !to?.value) errors.INVENTORY_LOW_STOCK_EMAIL_TO = 'Enter the address the low-stock e-mail goes to, or switch the e-mail off.';
  if (Object.keys(errors).length) return { ok: false, message: 'Nothing was saved: fix the marked fields.', errors };

  const before = new Map((await prisma.setting.findMany({ where: { key: { in: toSave.map((x) => x.key) } } })).map((r) => [r.key, r.value]));
  // Compare with what applies now (stored value, else the default): saving an untouched
  // default writes nothing and logs nothing.
  const effective = (key: string) => before.get(key) ?? String(inventorySettingDef(key)!.default);
  const changed = toSave.filter((x) => effective(x.key) !== x.value);
  await prisma.$transaction(changed.map((x) => prisma.setting.upsert({ where: { key: x.key }, create: x, update: { value: x.value } })));
  invalidateInventorySettings();
  for (const x of changed) {
    await audit('inventory.settings', x.key, `${effective(x.key)} -> ${x.value}`);
  }
  // Rules like "hide at zero" change what every public page shows.
  revalidatePath('/', 'layout');
  invalidateStale('home:');
  return { ok: true, message: changed.length ? `Saved ${changed.length} change${changed.length === 1 ? '' : 's'}.` : 'No changes.' };
}

