'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getAdminCaps, requireCapability } from '@/lib/auth-server';
import { capsAllow } from '@/lib/capabilities';
import { audit } from '@/lib/observability';
import { invalidateStale } from '@/lib/stale-cache';
import { checkLowStock } from '@/lib/inventory/alerts';
import { getInventorySettings } from '@/lib/inventory/settings';
import {
  applyPreview,
  autoMapping,
  buildPreview,
  dropStoredPreview,
  getStoredPreview,
  readUpload,
  type ApplyLineResult,
  type Preview,
  type Target,
} from '@/lib/inventory/import';
import type { WriteContext } from '@/lib/inventory/write';

async function importContext(batchId?: string): Promise<WriteContext & { userId: string }> {
  const session = await requireCapability('inventory:import');
  const caps = await getAdminCaps();
  return {
    userId: session.user.id,
    actorEmail: session.user.email,
    source: 'IMPORT',
    batchId,
    canCost: capsAllow(caps, 'inventory:cost'),
    canApprove: capsAllow(caps, 'products:approve'),
    settings: await getInventorySettings(),
  };
}

const TARGETS = z.array(z.string().max(40)).max(200);

/** Read the uploaded file and work out what would change. Writes nothing. */
export async function previewImport(form: FormData): Promise<{ ok: true; preview: Preview } | { ok: false; message: string }> {
  const ctx = await importContext();
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose an .xlsx or .csv file first.' };
  let mapping: Target[] | null = null;
  const rawMap = form.get('mapping');
  if (typeof rawMap === 'string' && rawMap) {
    const p = TARGETS.safeParse(JSON.parse(rawMap));
    if (p.success) mapping = p.data as Target[];
  }
  try {
    const sheet = await readUpload(file.name, Buffer.from(await file.arrayBuffer()));
    if (!sheet.headers.some(Boolean)) return { ok: false, message: 'The first line of the file must hold the column names.' };
    const map = mapping && mapping.length === sheet.headers.length ? mapping : autoMapping(sheet.headers);
    const preview = await buildPreview(file.name.slice(0, 200), sheet, map, ctx);
    return { ok: true, preview };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The file could not be read.' };
  }
}

/** Apply a preview the admin confirmed. Only lines shown in the preview are touched. */
export async function applyImport(
  previewId: string,
  opts: { useFileForConflicts: number[]; skipLines: number[] },
): Promise<{ ok: boolean; message: string; results: ApplyLineResult[] }> {
  const ctx = await importContext(String(previewId).slice(0, 80));
  const stored = getStoredPreview(String(previewId), ctx.actorEmail);
  if (!stored) return { ok: false, message: 'This preview has expired (or the server restarted). Upload the file again.', results: [] };
  const o = z.object({ useFileForConflicts: z.array(z.number().int()).max(10000), skipLines: z.array(z.number().int()).max(10000) }).safeParse(opts);
  if (!o.success) return { ok: false, message: 'Invalid request.', results: [] };
  dropStoredPreview(stored.preview.id); // one apply per preview
  const results = await applyPreview(stored, { ...o.data, sellerId: ctx.userId }, ctx);
  const ids = results.filter((r) => r.ok && r.productId).map((r) => r.productId!);
  if (ids.length) {
    const products = await prisma.product.findMany({ where: { id: { in: ids } }, select: { slug: true } });
    for (const p of products) revalidatePath(`/marketplace/${p.slug}`);
    revalidatePath('/marketplace');
    revalidatePath('/');
    invalidateStale('home:');
    await checkLowStock(ids);
  }
  revalidatePath('/admin/inventory');
  const okCount = results.filter((r) => r.ok).length;
  const failed = results.length - okCount;
  await audit('inventory.import', stored.preview.fileName, `${okCount} lines applied, ${failed} refused (batch ${stored.preview.id})`);
  return {
    ok: failed === 0,
    message: failed ? `${okCount} line${okCount === 1 ? '' : 's'} applied, ${failed} refused (see below).` : `${okCount} line${okCount === 1 ? '' : 's'} applied.`,
    results,
  };
}
