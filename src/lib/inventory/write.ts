import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { MAX_PRICE_CENTS } from '@/lib/products/validation';
import { foldAccents } from '@/lib/slug';
import { COLUMN_BY_KEY, FIELD_LABEL, enumLabel, matchEnum, type EditableField, type InventoryRow } from './fields';
import { ROW_INCLUDE, loadInventoryRows, toInventoryRow } from './rows';
import type { InventorySettings } from './settings';
import { reservedByProduct } from './stock';
import { cleanMultiline, cleanText, formatCents, hasArabicScript, parseMoneyToCents, parseWholeNumber } from './text';

type Tx = Prisma.TransactionClient;

export type WriteSource = 'GRID' | 'BULK' | 'IMPORT' | 'SYSTEM';

/**
 * One cell edit. `base` is the value the editor saw (in InventoryRow form);
 * when given, the save is refused if the stored value moved since, so nobody
 * silently overwrites a sale or another admin's edit. Omit it for relative
 * operations that are computed inside the transaction.
 */
export type CellChange = { field: EditableField; value: unknown; base?: unknown };

export type WriteContext = {
  actorEmail: string | null;
  source: WriteSource;
  batchId?: string;
  canCost: boolean;
  canApprove: boolean;
  settings: InventorySettings;
};

export type FieldIssue = { field: string; message: string; kind: 'error' | 'conflict'; current?: unknown };

export type WriteResult = {
  ok: boolean;
  issues: FieldIssue[];
  changed: string[];
  row: InventoryRow | null;
  /** Notes for the user, e.g. "Sale mode switched to Buy now + quote". */
  notes: string[];
};

export const MAX_ON_HAND = 100_000;
const LIMITS = { title: 200, sku: 40, mpn: 80, location: 60, notes: 2000, brand: 80, supplier: 120 } as const;

class Abort extends Error {
  constructor(public issues: FieldIssue[]) {
    super('inventory write aborted');
  }
}

type Parsed = { ok: true; value: string | number | null } | { ok: false; message: string };

/** Turn what a person typed (or a spreadsheet cell) into the stored form of one field. */
export function parseFieldValue(field: EditableField, raw: unknown, settings: InventorySettings): Parsed {
  const col = COLUMN_BY_KEY.get(field)!;
  const label = col.header;
  const languageRule = settings.INVENTORY_LATIN_ONLY;
  const checkScript = (s: string): Parsed | null =>
    s && hasArabicScript(s) && (languageRule === 'all' || (languageRule === 'public' && col.public))
      ? { ok: false, message: `${label}: Persian/Arabic text is not allowed (Inventory settings → Language). Use English.` }
      : null;

  switch (col.kind) {
    case 'money': {
      const cents = parseMoneyToCents(raw);
      if (cents === null) return { ok: true, value: null };
      if (Number.isNaN(cents)) return { ok: false, message: `${label}: "${cleanText(raw)}" is not an amount. Use e.g. 1250 or 1250.50.` };
      if (cents < 0) return { ok: false, message: `${label} can not be negative.` };
      if (cents > MAX_PRICE_CENTS) return { ok: false, message: `${label} can be at most 1,000,000.00.` };
      return { ok: true, value: cents };
    }
    case 'int': {
      const n = parseWholeNumber(raw);
      if (n === null) {
        if (field === 'onHand') return { ok: false, message: 'On hand needs a number (0 if there are none).' };
        return { ok: true, value: null };
      }
      if (Number.isNaN(n)) return { ok: false, message: `${label}: "${cleanText(raw)}" is not a whole number.` };
      if (n < 0) return { ok: false, message: `${label} can not be negative.` };
      if (n > MAX_ON_HAND) return { ok: false, message: `${label} can be at most ${MAX_ON_HAND.toLocaleString('en-US')}.` };
      return { ok: true, value: n };
    }
    case 'enum': {
      const s = cleanText(raw);
      if (!s) return { ok: false, message: `${label} can not be empty.` };
      const v = matchEnum(field, s);
      if (!v) return { ok: false, message: `${label}: "${s}" is not one of the choices.` };
      return { ok: true, value: v };
    }
    case 'longtext': {
      const s = cleanMultiline(raw);
      const bad = checkScript(s);
      if (bad) return bad;
      if (s.length > LIMITS.notes) return { ok: false, message: `${label}: at most ${LIMITS.notes} characters.` };
      return { ok: true, value: s || null };
    }
    case 'text':
    case 'ref': {
      const s = cleanText(raw);
      const bad = checkScript(s);
      if (bad) return bad;
      if (!s) {
        if (!col.clearable) return { ok: false, message: `${label} can not be empty.` };
        return { ok: true, value: null };
      }
      const max = (LIMITS as Record<string, number>)[field] ?? 200;
      if (s.length > max) return { ok: false, message: `${label}: at most ${max} characters.` };
      if (field === 'title' && s.length < 2) return { ok: false, message: 'Name needs at least 2 characters.' };
      return { ok: true, value: s };
    }
    default:
      return { ok: false, message: `${label} can not be changed.` };
  }
}

export function sameValue(field: string, a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined || v === '' ? null : v);
  const x = norm(a);
  const y = norm(b);
  if (x === null || y === null) return x === y;
  if (typeof x === 'number' || typeof y === 'number') return Number(x) === Number(y);
  const col = COLUMN_BY_KEY.get(field as EditableField);
  if (col?.kind === 'ref') return String(x).trim().toLowerCase() === String(y).trim().toLowerCase();
  return String(x).trim() === String(y).trim();
}

/** Human-readable value for the history log. */
export function displayValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const col = COLUMN_BY_KEY.get(field as EditableField);
  if (col?.kind === 'money') return formatCents(Number(v));
  if (col?.kind === 'enum') return enumLabel(col.key, String(v));
  return String(v);
}

async function nextSku(tx: Tx, settings: InventorySettings): Promise<string> {
  const prefix = settings.INVENTORY_SKU_PREFIX;
  const digits = settings.INVENTORY_SKU_DIGITS;
  const rows = await tx.productInventory.findMany({
    where: { sku: { startsWith: prefix, mode: 'insensitive' } },
    select: { sku: true },
  });
  let max = 0;
  for (const r of rows) {
    const tail = r.sku!.slice(prefix.length);
    if (/^\d+$/.test(tail)) max = Math.max(max, Number(tail));
  }
  return `${prefix}${String(max + 1).padStart(digits, '0')}`;
}

function slugFor(name: string): string {
  return (
    foldAccents(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) ||
    Math.random().toString(36).slice(2, 8)
  );
}

async function brandIdFor(tx: Tx, name: string): Promise<string> {
  const found = await tx.brand.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
  if (found) return found.id;
  let slug = slugFor(name);
  while (await tx.brand.findUnique({ where: { slug }, select: { id: true } })) slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
  const b = await tx.brand.create({ data: { name, slug }, select: { id: true } });
  return b.id;
}

export async function findCategory(db: Tx | typeof prisma, nameOrSlug: string) {
  return db.category.findFirst({
    where: { OR: [{ name: { equals: nameOrSlug, mode: 'insensitive' } }, { slug: nameOrSlug.toLowerCase() }] },
    select: { id: true, name: true },
  });
}

async function supplierIdFor(tx: Tx, name: string): Promise<string> {
  const found = await tx.supplier.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } });
  if (found) return found.id;
  const s = await tx.supplier.create({ data: { name }, select: { id: true } });
  return s.id;
}

function isUniqueViolation(e: unknown, field?: string): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  if (!field) return true;
  const target = (e.meta as { target?: string[] | string } | undefined)?.target;
  return Array.isArray(target) ? target.includes(field) : String(target ?? '').includes(field);
}

async function attempt(productId: string, changes: CellChange[], ctx: WriteContext): Promise<{ changed: string[]; notes: string[] }> {
  return prisma.$transaction(async (tx) => {
    const p = await tx.product.findUnique({ where: { id: productId }, include: ROW_INCLUDE });
    if (!p) throw new Abort([{ field: '*', kind: 'error', message: 'This item no longer exists.' }]);
    const reserved = (await reservedByProduct(tx, [productId])).get(productId) ?? 0;
    const current = toInventoryRow(p, reserved, true);

    const issues: FieldIssue[] = [];
    const parsed = new Map<EditableField, string | number | null>();
    for (const ch of changes) {
      const col = COLUMN_BY_KEY.get(ch.field);
      if (!col || !col.editable) {
        issues.push({ field: ch.field, kind: 'error', message: `${FIELD_LABEL[ch.field] ?? ch.field} can not be changed.` });
        continue;
      }
      if (col.cost && !ctx.canCost) {
        issues.push({ field: ch.field, kind: 'error', message: 'You do not have permission to change the purchase cost.' });
        continue;
      }
      if (ch.field === 'status' && !ctx.canApprove) {
        issues.push({ field: ch.field, kind: 'error', message: 'You do not have permission to publish or unpublish items.' });
        continue;
      }
      const cur = (current as unknown as Record<string, unknown>)[ch.field];
      if (ch.base !== undefined && !sameValue(ch.field, cur, ch.base)) {
        issues.push({
          field: ch.field,
          kind: 'conflict',
          current: ch.field === 'costCents' && !ctx.canCost ? null : cur,
          message: `${col.header} was changed elsewhere (now ${displayValue(ch.field, cur) || 'empty'}). Your value was not saved.`,
        });
        continue;
      }
      const r = parseFieldValue(ch.field, ch.value, ctx.settings);
      if (!r.ok) {
        issues.push({ field: ch.field, kind: 'error', message: r.message });
        continue;
      }
      if (ch.field === 'mpn' && current.mpnFromSpecs && r.value !== null && sameValue('mpn', cur, r.value)) {
        // Confirming the part number read from the specs stores it for real.
        parsed.set(ch.field, r.value);
        continue;
      }
      if (sameValue(ch.field, cur, r.value)) continue;
      parsed.set(ch.field, r.value);
    }
    if (issues.length) throw new Abort(issues);

    const productData: Prisma.ProductUpdateInput = {};
    const invData: Prisma.ProductInventoryUncheckedUpdateInput = {};
    const events: { field: string; oldValue: string; newValue: string }[] = [];
    const notes: string[] = [];
    const log = (field: string, oldV: unknown, newV: unknown) =>
      events.push({ field, oldValue: displayValue(field, oldV), newValue: displayValue(field, newV) });
    let expectQuantity: number | null = null;

    for (const [field, value] of parsed) {
      const cur = (current as unknown as Record<string, unknown>)[field];
      switch (field) {
        case 'title':
          productData.title = value as string;
          break;
        case 'condition':
          productData.condition = value as Prisma.ProductUpdateInput['condition'];
          break;
        case 'mode':
          productData.mode = value as Prisma.ProductUpdateInput['mode'];
          break;
        case 'status':
          productData.status = value as Prisma.ProductUpdateInput['status'];
          break;
        case 'priceCents':
          break; // placed below, once the final sale mode is known
        case 'brand':
          productData.brand = value === null ? { disconnect: true } : { connect: { id: await brandIdFor(tx, value as string) } };
          break;
        case 'category': {
          const c = await findCategory(tx, value as string);
          if (!c) throw new Abort([{ field, kind: 'error', message: `Category "${value}" does not exist. Add it under Categories first.` }]);
          productData.category = { connect: { id: c.id } };
          break;
        }
        case 'onHand': {
          const onHand = value as number;
          if (onHand < reserved) {
            throw new Abort([
              {
                field,
                kind: 'error',
                message: `${reserved} unit${reserved === 1 ? ' is' : 's are'} reserved in orders that have not shipped, so On hand can not be lower than ${reserved}.`,
              },
            ]);
          }
          productData.quantity = onHand - reserved;
          expectQuantity = p.quantity;
          break;
        }
        case 'sku': {
          if (value !== null) {
            const taken = await tx.productInventory.findFirst({
              where: { sku: { equals: value as string, mode: 'insensitive' }, productId: { not: productId } },
              select: { product: { select: { title: true } } },
            });
            if (taken) throw new Abort([{ field, kind: 'error', message: `SKU ${value} is already used by "${taken.product.title}".` }]);
          }
          invData.sku = value as string | null;
          break;
        }
        case 'supplier':
          invData.supplierId = value === null ? null : await supplierIdFor(tx, value as string);
          break;
        case 'mpn':
        case 'location':
        case 'notes':
          (invData as Record<string, unknown>)[field] = value;
          break;
        case 'costCents':
          invData.costCents = value as number | null;
          break;
        case 'lowStockAt':
          invData.lowStockAt = value as number | null;
          break;
      }
      log(field, cur, value);
    }

    // Where the selling price lives depends on the sale mode: a quote-only
    // item's price is internal (ProductInventory.quotePriceCents) so it can
    // never reach a card, search or the structured data; a buyable item's is
    // the public Product.priceCents. Changing the mode moves it across.
    const wasQuote = p.mode === 'QUOTE_ONLY';
    let finalMode = (productData.mode as string | undefined) ?? p.mode;
    const newPrice = parsed.has('priceCents') ? (parsed.get('priceCents') as number | null) : undefined;
    if (
      ctx.settings.INVENTORY_QUOTE_PRICE === 'buy_now' &&
      finalMode === 'QUOTE_ONLY' &&
      newPrice !== undefined &&
      newPrice !== null &&
      newPrice > 0 &&
      !parsed.has('mode')
    ) {
      finalMode = 'HYBRID';
      productData.mode = 'HYBRID';
      log('mode', p.mode, 'HYBRID');
      notes.push('Sale mode switched to "Buy now + quote" so the price shows (Inventory settings).');
    }
    const internalNow = p.inventory?.quotePriceCents ?? null;
    if (finalMode === 'QUOTE_ONLY') {
      if (newPrice !== undefined) invData.quotePriceCents = newPrice;
      else if (!wasQuote && p.priceCents !== null) invData.quotePriceCents = p.priceCents; // becomes internal
      if (p.priceCents !== null) productData.priceCents = null; // never public on a quote-only item
    } else {
      if (newPrice !== undefined) productData.priceCents = newPrice;
      else if (wasQuote && p.priceCents === null && internalNow !== null) productData.priceCents = internalNow; // becomes public
      if (internalNow !== null) invData.quotePriceCents = null;
    }
    if (newPrice !== undefined && finalMode === 'QUOTE_ONLY' && !wasQuote) notes.push('The item is quote-only, so its selling price is internal and not shown on the site.');

    const needsRow = !p.inventory && (Object.keys(invData).length > 0 || Object.keys(productData).length > 0);
    if (needsRow && ctx.settings.INVENTORY_SKU_AUTO && invData.sku === undefined) {
      invData.sku = await nextSku(tx, ctx.settings);
      log('sku', null, invData.sku);
    }

    if (Object.keys(productData).length) {
      if (expectQuantity !== null) {
        // Compare-and-set on the stock: a checkout that took a unit in between makes this a conflict.
        // updateMany can not set relations, so brand/category go in a second update.
        const { brand, category, ...scalars } = productData;
        const { count } = await tx.product.updateMany({
          where: { id: productId, quantity: expectQuantity },
          data: scalars as Prisma.ProductUpdateManyMutationInput,
        });
        if (count !== 1) {
          throw new Abort([{ field: 'onHand', kind: 'conflict', message: 'Stock changed a moment ago (an order?). Your value was not saved; check the new numbers.' }]);
        }
        if (brand || category) await tx.product.update({ where: { id: productId }, data: { ...(brand ? { brand } : {}), ...(category ? { category } : {}) } });
      } else {
        await tx.product.update({ where: { id: productId }, data: productData });
      }
    }
    if (Object.keys(invData).length) {
      await tx.productInventory.upsert({
        where: { productId },
        create: { ...(invData as Omit<Prisma.ProductInventoryUncheckedCreateInput, 'productId'>), productId },
        update: invData,
      });
    }
    if (events.length) {
      await tx.inventoryEvent.createMany({
        data: events.map((e) => ({
          productId,
          label: (productData.title as string | undefined) ?? p.title,
          field: e.field,
          oldValue: e.oldValue || null,
          newValue: e.newValue || null,
          source: ctx.source,
          batchId: ctx.batchId ?? null,
          actorEmail: ctx.actorEmail,
        })),
      });
    }
    return { changed: events.map((e) => e.field), notes };
  });
}

/** Apply a set of cell edits to one item: all of them, or none (with the reasons). */
export async function applyInventoryChanges(productId: string, changes: CellChange[], ctx: WriteContext): Promise<WriteResult> {
  for (let tries = 0; ; tries++) {
    try {
      const { changed, notes } = await attempt(productId, changes, ctx);
      const [row] = await loadInventoryRows({ ids: [productId], canCost: ctx.canCost });
      return { ok: true, issues: [], changed, row: row ?? null, notes };
    } catch (e) {
      if (e instanceof Abort) {
        const [row] = await loadInventoryRows({ ids: [productId], canCost: ctx.canCost });
        return { ok: false, issues: e.issues, changed: [], row: row ?? null, notes: [] };
      }
      // Two saves picked the same automatic SKU at once: the loser simply retries.
      if (isUniqueViolation(e, 'sku') && tries < 3 && !changes.some((c) => c.field === 'sku')) continue;
      if (isUniqueViolation(e, 'sku')) {
        const [row] = await loadInventoryRows({ ids: [productId], canCost: ctx.canCost });
        return { ok: false, issues: [{ field: 'sku', kind: 'error', message: 'That SKU is already used by another item.' }], changed: [], row: row ?? null, notes: [] };
      }
      if (isUniqueViolation(e, 'name') && tries < 3) continue; // supplier created concurrently
      throw e;
    }
  }
}

/** Give every listed item without a SKU the next number. */
export async function assignMissingSkus(productIds: string[], ctx: WriteContext): Promise<number> {
  let n = 0;
  for (const id of productIds) {
    const has = await prisma.productInventory.findUnique({ where: { productId: id }, select: { sku: true } });
    if (has?.sku) continue;
    for (let tries = 0; tries < 4; tries++) {
      try {
        await prisma.$transaction(async (tx) => {
          const sku = await nextSku(tx, ctx.settings);
          await tx.productInventory.upsert({ where: { productId: id }, create: { productId: id, sku }, update: { sku } });
          const p = await tx.product.findUnique({ where: { id }, select: { title: true } });
          await tx.inventoryEvent.create({
            data: { productId: id, label: p?.title ?? null, field: 'sku', oldValue: null, newValue: sku, source: ctx.source, batchId: ctx.batchId ?? null, actorEmail: ctx.actorEmail },
          });
        });
        n++;
        break;
      } catch (e) {
        if (!isUniqueViolation(e, 'sku')) throw e;
      }
    }
  }
  return n;
}

export type NewItemInput = {
  title: unknown;
  category: unknown;
  condition?: unknown;
  mode?: unknown;
  status?: 'DRAFT' | 'PUBLISHED';
  brand?: unknown;
  summary?: string | null;
  description?: string | null;
  specs?: Record<string, string> | null;
  yearMade?: number | null;
};

/** Create a listing (draft by default) for a new stock item; inventory fields are applied afterwards. */
export async function createInventoryProduct(
  input: NewItemInput,
  sellerId: string,
  ctx: WriteContext,
): Promise<{ ok: true; id: string; slug: string } | { ok: false; message: string }> {
  const s = ctx.settings;
  const title = parseFieldValue('title', input.title, s);
  if (!title.ok) return { ok: false, message: title.message };
  const catName = cleanText(input.category) || s.INVENTORY_IMPORT_DEFAULT_CATEGORY;
  if (!catName) return { ok: false, message: 'A new item needs a category (or set a default category in Inventory settings → Import).' };
  const cat = await findCategory(prisma, catName);
  if (!cat) return { ok: false, message: `Category "${catName}" does not exist.` };
  const cond = input.condition !== undefined && cleanText(input.condition) ? parseFieldValue('condition', input.condition, s) : { ok: true as const, value: s.INVENTORY_NEW_CONDITION };
  if (!cond.ok) return { ok: false, message: cond.message };
  const mode = input.mode !== undefined && cleanText(input.mode) ? parseFieldValue('mode', input.mode, s) : { ok: true as const, value: s.INVENTORY_NEW_MODE };
  if (!mode.ok) return { ok: false, message: mode.message };
  const brand = input.brand !== undefined ? parseFieldValue('brand', input.brand, s) : { ok: true as const, value: null };
  if (!brand.ok) return { ok: false, message: brand.message };
  if (input.status === 'PUBLISHED' && !ctx.canApprove) return { ok: false, message: 'You do not have permission to publish items.' };
  for (const [label, text] of [['Summary', input.summary], ['Description', input.description]] as const) {
    if (text && hasArabicScript(text) && s.INVENTORY_LATIN_ONLY !== 'off') return { ok: false, message: `${label}: Persian/Arabic text is not allowed. Use English.` };
  }

  let slug = slugFor(title.value as string);
  if (slug.length < 3) slug = `item-${Date.now().toString(36)}`;
  while (await prisma.product.findUnique({ where: { slug }, select: { id: true } })) slug = `${slug.slice(0, 60)}-${Math.random().toString(36).slice(2, 6)}`;

  const created = await prisma.$transaction(async (tx) => {
    const brandId = brand.value ? await brandIdFor(tx, brand.value as string) : null;
    const p = await tx.product.create({
      data: {
        slug,
        title: title.value as string,
        summary: input.summary ? cleanText(input.summary).slice(0, 300) : null,
        description: input.description ? cleanMultiline(input.description).slice(0, 100_000) : null,
        condition: cond.value as Prisma.ProductCreateInput['condition'],
        mode: mode.value as Prisma.ProductCreateInput['mode'],
        status: input.status ?? 'DRAFT',
        priceCents: null,
        currency: 'EUR',
        quantity: 0,
        specs: input.specs && Object.keys(input.specs).length ? input.specs : undefined,
        yearMade: input.yearMade ?? null,
        illustration: 'balance',
        images: [],
        hasImages: false,
        categoryId: cat.id,
        brandId,
        sellerId,
        companyId: null,
      },
      select: { id: true, slug: true, title: true },
    });
    await tx.inventoryEvent.create({
      data: { productId: p.id, label: p.title, field: 'created', oldValue: null, newValue: input.status === 'PUBLISHED' ? 'Published listing' : 'Draft listing', source: ctx.source, batchId: ctx.batchId ?? null, actorEmail: ctx.actorEmail },
    });
    return p;
  });
  return { ok: true, id: created.id, slug: created.slug };
}
