'use server';

/**
 * Admin actions for catalog truthfulness: supplier sync (dry run / run),
 * per-shop sync policy, supplier verification + agreement, condition grades
 * (warranty defaults), photo re-hosting and per-product sync locks.
 * Kept apart from admin/actions.ts (shared by every team) on purpose.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ProductCondition } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapability } from '@/lib/auth-server';
import { audit } from '@/lib/observability';
import { runWooSync } from '@/lib/marketplace/woo-sync';
import { getImportSettings } from '@/lib/catalog/import-settings';
import { AUDIT_SELECT, AUDIT_WHERE, auditProduct, cleanSupplierTexts } from '@/lib/catalog/audit';
import { getCatalogPolicy, getConditionGrades } from '@/lib/catalog/policy';
import { notifyAdmins } from '@/lib/observability';
import { ensureSettingsLoaded, settingEnum } from '@/lib/settings';
import { isLockableField } from '@/lib/marketplace/woo-sync-plan';
import { localizeImageList } from '@/lib/media/localize';
import { isOwnStoredImage, ownMediaPath, publicProductImages } from '@/lib/media/public-src';

type Result = { ok: boolean; message: string };

async function adminEmail(cap: string): Promise<string> {
  const session = await requireCapability(cap, { redirectTo: '/admin' });
  return session.user.email;
}

function revalidateShop(slug: string) {
  revalidatePath('/admin/companies');
  revalidatePath(`/admin/companies/${slug}`);
  revalidatePath('/admin/products');
  revalidatePath('/marketplace');
}

// ─── Supplier sync ───────────────────────────────────────────────────────────

export async function syncShop(slug: string, dryRun: boolean, opts: { allowMassArchive?: boolean } = {}): Promise<Result & { runId?: string | null; attention?: string[] }> {
  const email = await adminEmail('companies:manage');
  const co = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
  if (!co) return { ok: false, message: 'Shop not found — it may have been deleted.' };
  const r = await runWooSync({ companyId: co.id, dryRun, trigger: 'ADMIN', actorEmail: email, allowMassArchive: !dryRun && !!opts.allowMassArchive });
  if (!dryRun) revalidateShop(slug);
  else revalidatePath(`/admin/companies/${slug}`);
  return { ok: r.ok, message: r.message, runId: r.runId, attention: r.attention };
}

const SyncSettingsInput = z.object({
  syncPolicy: z.enum(['PRICE_STOCK_ONLY', 'CONTENT_TOO']),
  syncStockMode: z.enum(['SUBTRACT_LOCAL_SALES', 'SOURCE_IS_TRUTH']),
  autoPublishImports: z.boolean(),
  archiveMissingAtSource: z.boolean(),
  importCondition: z.enum(['NEW', 'REFURBISHED', 'USED']),
  importDefaultQuantity: z.number().int().min(1).max(1000),
  syncIntervalMinutes: z.number().int().min(15).max(10080).nullable(),
  importPricesIncludeVat: z.boolean(),
  /** null = the home standard rate (Settings → Tax & VAT). */
  importVatRateBp: z.number().int().min(0).max(5000).nullable(),
});

export async function updateShopSyncSettings(slug: string, input: z.infer<typeof SyncSettingsInput>): Promise<Result> {
  await adminEmail('companies:manage');
  const r = SyncSettingsInput.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = String(issue?.path[0] ?? '');
    const msg =
      field === 'syncIntervalMinutes'
        ? 'Automatic sync interval must be between 15 minutes and 7 days (or off).'
        : field === 'importDefaultQuantity'
          ? 'Default quantity must be a whole number between 1 and 1000.'
          : field === 'importVatRateBp'
            ? 'The VAT rate of the source prices must be between 0 and 50% (or empty for the standard rate).'
            : 'Some sync settings are invalid. Nothing was saved.';
    return { ok: false, message: msg };
  }
  const co = await prisma.company.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!co) return { ok: false, message: 'Shop not found — it may have been deleted.' };
  await prisma.company.update({ where: { id: co.id }, data: r.data });
  await audit('company.sync.settings', slug, JSON.stringify(r.data));
  revalidatePath(`/admin/companies/${slug}`);
  return { ok: true, message: `Sync settings saved for ${co.name}.` };
}

// ─── Verification + agreement ────────────────────────────────────────────────

export async function verifyShop(slug: string, note: string): Promise<Result> {
  const email = await adminEmail('companies:manage');
  const text = note.trim();
  if (text.length < 10) {
    return { ok: false, message: 'Write down what you checked (at least 10 characters), e.g. “KvK 12345678 + VAT checked in VIES, references called”.' };
  }
  const co = await prisma.company.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!co) return { ok: false, message: 'Shop not found — it may have been deleted.' };
  await prisma.company.update({
    where: { id: co.id },
    data: { isVerified: true, verifiedAt: new Date(), verifiedByEmail: email, verificationNote: text.slice(0, 1000) },
  });
  await audit('company.verify', slug, text.slice(0, 500));
  revalidateShop(slug);
  return { ok: true, message: `${co.name} is now verified (recorded with your note).` };
}

export async function unverifyShop(slug: string): Promise<Result> {
  await adminEmail('companies:manage');
  const co = await prisma.company.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!co) return { ok: false, message: 'Shop not found — it may have been deleted.' };
  await prisma.company.update({
    where: { id: co.id },
    data: { isVerified: false, verifiedAt: null, verifiedByEmail: null, verificationNote: null },
  });
  await audit('company.unverify', slug);
  revalidateShop(slug);
  return { ok: true, message: `${co.name} is no longer marked verified.` };
}

const AgreementInput = z.object({
  status: z.enum(['NONE', 'SENT', 'SIGNED', 'OWN_SHOP', 'TERMINATED']),
  signedAt: z.string().nullable(),
  note: z.string().max(1000).nullable(),
});

/** What ending the agreement would do now (shown in the confirmation before saving). */
export async function agreementEndImpact(slug: string): Promise<{ live: number; openOrders: number; openQuotes: number; action: 'ARCHIVE_LISTINGS' | 'WARN_ONLY' } | null> {
  await adminEmail('companies:manage');
  const co = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
  if (!co) return null;
  await ensureSettingsLoaded();
  const [live, openOrders, openQuotes] = await Promise.all([
    prisma.product.count({ where: { companyId: co.id, status: { in: ['PUBLISHED', 'PENDING_REVIEW'] } } }),
    prisma.order.count({ where: { status: { in: ['PENDING_PAYMENT', 'PAID', 'PROCESSING'] }, items: { some: { product: { companyId: co.id } } } } }),
    prisma.sourcingRequest.count({ where: { status: { notIn: ['CLOSED', 'DECLINED'] }, product: { companyId: co.id } } }),
  ]);
  return { live, openOrders, openQuotes, action: settingEnum<'ARCHIVE_LISTINGS' | 'WARN_ONLY'>('AGREEMENT_END_ACTION') };
}

export async function setShopAgreement(slug: string, input: z.infer<typeof AgreementInput>): Promise<Result> {
  await adminEmail('companies:manage');
  const r = AgreementInput.safeParse(input);
  if (!r.success) return { ok: false, message: 'Invalid agreement details. Nothing was saved.' };
  const { status, note } = r.data;
  let signedAt: Date | null = null;
  if (status === 'SIGNED') {
    if (!r.data.signedAt) return { ok: false, message: 'Enter the date the agreement was signed.' };
    signedAt = new Date(`${r.data.signedAt}T12:00:00Z`);
    if (Number.isNaN(signedAt.getTime()) || signedAt.getTime() > Date.now() + 86_400_000) {
      return { ok: false, message: 'The signing date is not a valid past date.' };
    }
  }
  const co = await prisma.company.findUnique({ where: { slug }, select: { id: true, name: true, agreementStatus: true } });
  if (!co) return { ok: false, message: 'Shop not found — it may have been deleted.' };
  await prisma.company.update({
    where: { id: co.id },
    data: { agreementStatus: status, agreementSignedAt: signedAt, agreementNote: note?.trim() || null },
  });
  await audit('company.agreement', slug, `${status}${signedAt ? ` ${signedAt.toISOString().slice(0, 10)}` : ''}`);
  revalidatePath(`/admin/companies/${slug}`);
  // Ending the agreement ends the right to resell: stop selling the shop's
  // items (Settings → Import & suppliers → AGREEMENT_END_ACTION), say what is
  // still open, and tell every admin.
  if (status === 'TERMINATED' && co.agreementStatus !== 'TERMINATED') {
    const impact = await agreementEndImpact(slug);
    const open =
      impact && (impact.openOrders || impact.openQuotes)
        ? `${impact.openOrders} open order(s) and ${impact.openQuotes} open quote(s) include its items — handle them under Orders and Quotes.`
        : 'No open order or quote includes its items.';
    if (impact?.action === 'ARCHIVE_LISTINGS') {
      const r = await prisma.product.updateMany({
        where: { companyId: co.id, status: { in: ['PUBLISHED', 'PENDING_REVIEW'] } },
        data: { status: 'ARCHIVED' },
      });
      await audit('company.agreement.terminated.archive', slug, `archived=${r.count} openOrders=${impact.openOrders} openQuotes=${impact.openQuotes}`);
      await notifyAdmins(`Supplier agreement terminated: ${co.name}`, `${r.count} listing(s) archived and no longer sold. ${open}`, `/admin/companies/${slug}`);
      revalidatePath('/admin/products');
      revalidatePath('/marketplace', 'layout');
      revalidatePath('/');
      return { ok: true, message: `Agreement with ${co.name} terminated: ${r.count} listing(s) archived — no longer sold or shown. Syncs are blocked. ${open}`.trim() };
    }
    await notifyAdmins(`Supplier agreement terminated: ${co.name}`, `Its ${impact?.live ?? 0} listing(s) stay on sale (Settings → Import & suppliers says “only warn”). ${open}`, `/admin/companies/${slug}`);
    return { ok: true, message: `Agreement with ${co.name} terminated. Its ${impact?.live ?? 0} listing(s) are STILL ON SALE (Settings → Import & suppliers → “When a supplier agreement is terminated” = only warn). Syncs are blocked. ${open}`.trim() };
  }
  return { ok: true, message: `Agreement status for ${co.name}: ${status.replace('_', ' ').toLowerCase()}.` };
}

// ─── Condition grades (warranty defaults per condition) ─────────────────────

const SCHEMA_CONDITIONS = ['NewCondition', 'RefurbishedCondition', 'UsedCondition', 'DamagedCondition'] as const;

export async function saveConditionGrades(formData: FormData): Promise<Result> {
  await adminEmail('products:edit');
  const codes: ProductCondition[] = ['NEW', 'REFURBISHED', 'USED'];
  const rows: { code: ProductCondition; label: string; description: string | null; schemaOrgCondition: string; defaultWarrantyMonths: number | null; warrantyScope: string | null }[] = [];
  for (const code of codes) {
    const label = String(formData.get(`${code}.label`) ?? '').trim();
    if (label.length < 2 || label.length > 60) return { ok: false, message: `${code}: the label must be 2–60 characters. Nothing was saved.` };
    const schemaOrg = String(formData.get(`${code}.schema`) ?? '');
    if (!(SCHEMA_CONDITIONS as readonly string[]).includes(schemaOrg)) return { ok: false, message: `${code}: choose a search-engine condition. Nothing was saved.` };
    const monthsRaw = String(formData.get(`${code}.months`) ?? '').trim();
    let months: number | null = null;
    if (monthsRaw) {
      const n = Number(monthsRaw);
      if (!Number.isInteger(n) || n < 0 || n > 120) return { ok: false, message: `${label}: warranty months must be a whole number 0–120 (or empty for none). Nothing was saved.` };
      months = n === 0 ? null : n;
    }
    rows.push({
      code,
      label,
      description: String(formData.get(`${code}.description`) ?? '').trim().slice(0, 600) || null,
      schemaOrgCondition: schemaOrg,
      defaultWarrantyMonths: months,
      warrantyScope: String(formData.get(`${code}.scope`) ?? '').trim().slice(0, 300) || null,
    });
  }
  await prisma.$transaction(
    rows.map((r, i) =>
      prisma.conditionGrade.upsert({
        where: { code: r.code },
        update: { ...r, sortOrder: i },
        create: { ...r, sortOrder: i },
      }),
    ),
  );
  await audit(
    'catalog.conditions',
    undefined,
    rows.map((r) => `${r.code}=${r.label}/${r.defaultWarrantyMonths ?? 0}m`).join(' '),
  );
  revalidatePath('/admin/catalog/conditions');
  revalidatePath('/marketplace', 'layout');
  return { ok: true, message: 'Conditions & warranty defaults saved. Product pages use them right away; orders already placed keep the warranty they were sold with.' };
}

// ─── Photo re-hosting ───────────────────────────────────────────────────────

export interface LocalizeBatchResult extends Result {
  processed: number;
  /** Foreign photos that now point at our store (downloaded now or already stored). */
  hosted: number;
  downloaded: number;
  normalized: number;
  failed: { slug: string; url: string; error: string }[];
  remaining: number;
  /** Pass back as `after` to continue; null when the whole catalogue was walked. */
  nextCursor: string | null;
}

/** Products whose photo list still has a foreign URL or a non-normalised own URL. */
async function productsNeedingHosting(): Promise<{ id: string; slug: string; images: string[]; sourceImageUrls: string[] }[]> {
  const all = await prisma.product.findMany({
    select: { id: true, slug: true, images: true, sourceImageUrls: true },
    orderBy: { id: 'asc' },
  });
  return all.filter((p) => p.images.some((u) => ownMediaPath(u) !== u));
}

export async function countImagesToLocalize(): Promise<{ products: number; foreignImages: number }> {
  await adminEmail('products:edit');
  const todo = await productsNeedingHosting();
  return { products: todo.length, foreignImages: todo.reduce((n, p) => n + p.images.filter((u) => !isOwnStoredImage(u)).length, 0) };
}

/** Copy foreign product photos into our media store, a batch at a time.
 *  Walks the catalogue by id (`after` = cursor), so a photo that keeps failing
 *  never blocks the rest; failures stay hidden from buyers and are retried
 *  on the next full pass. */
export async function localizeProductImagesBatch(after: string | null = null, batchSize = 25): Promise<LocalizeBatchResult> {
  await adminEmail('products:edit');
  const todo = (await productsNeedingHosting()).filter((p) => !after || p.id > after);
  const batch = todo.slice(0, Math.max(1, Math.min(100, batchSize)));
  const nextCursor = todo.length > batch.length ? batch[batch.length - 1].id : null;
  let downloaded = 0;
  let hosted = 0;
  let normalized = 0;
  const failed: LocalizeBatchResult['failed'] = [];
  for (const p of batch) {
    const remote = p.images.filter((u) => !isOwnStoredImage(u));
    const loc = await localizeImageList(p.images);
    downloaded += loc.downloaded;
    hosted += remote.length - loc.failures.length;
    normalized += p.images.filter((u) => isOwnStoredImage(u) && ownMediaPath(u) !== u).length;
    for (const f of loc.failures) failed.push({ slug: p.slug, url: f.url, error: f.error });
    if (loc.changed) {
      const provenance = Array.from(new Set([...p.sourceImageUrls, ...remote]));
      await prisma.product.update({
        where: { id: p.id },
        data: { images: loc.images, hasImages: publicProductImages(loc.images).length > 0, sourceImageUrls: provenance },
      });
    }
  }
  const remaining = (await productsNeedingHosting()).length;
  await audit('catalog.images.localize', undefined, `processed=${batch.length} hosted=${hosted} downloaded=${downloaded} normalized=${normalized} failed=${failed.length} remaining=${remaining}`);
  revalidatePath('/admin/products');
  revalidatePath('/marketplace', 'layout');
  const msg = `${batch.length} product(s) processed: ${hosted} photo(s) now served from our media store (${downloaded} downloaded, the rest were already stored), ${normalized} address(es) tidied${failed.length ? `, ${failed.length} photo(s) could not be copied (hidden from buyers; retried next time)` : ''}. ${remaining} product(s) left.`;
  return { ok: failed.length === 0, message: msg, processed: batch.length, hosted, downloaded, normalized, failed: failed.slice(0, 50), remaining, nextCursor };
}

// ─── Per-product sync locks ─────────────────────────────────────────────────

export async function setProductFieldLock(slug: string, field: string, locked: boolean): Promise<Result> {
  await adminEmail('products:edit');
  if (!isLockableField(field)) return { ok: false, message: 'That field cannot be locked.' };
  const p = await prisma.product.findUnique({ where: { slug }, select: { id: true, lockedFields: true } });
  if (!p) return { ok: false, message: 'Product not found.' };
  const next = new Set(p.lockedFields);
  if (locked) next.add(field);
  else next.delete(field);
  await prisma.product.update({ where: { id: p.id }, data: { lockedFields: [...next] } });
  await audit(locked ? 'product.lock' : 'product.unlock', slug, field);
  revalidatePath(`/admin/products/${slug}`);
  return {
    ok: true,
    message: locked
      ? `“${field}” is locked: supplier syncs will not change it.`
      : `“${field}” is unlocked: the next sync may update it (if the shop's policy syncs it).`,
  };
}

// ─── Supplier price changes waiting for review (8f) ─────────────────────────

function revalidateProduct(slug: string) {
  revalidatePath('/admin/catalog/price-review');
  revalidatePath('/admin/products');
  revalidatePath(`/admin/products/${slug}`);
  revalidatePath(`/marketplace/${slug}`);
  revalidatePath('/marketplace');
  revalidatePath('/');
}

/** Approve: the source's new price becomes the live price; the listing is buyable again. */
export async function approvePendingPrice(slug: string): Promise<Result> {
  const email = await adminEmail('products:edit');
  const p = await prisma.product.findUnique({
    where: { slug },
    select: { id: true, title: true, priceCents: true, currency: true, mode: true, pendingPriceCents: true, pendingPriceCurrency: true },
  });
  if (!p) return { ok: false, message: 'Product not found.' };
  if (p.pendingPriceCents === null) return { ok: false, message: 'There is no price change waiting for this product (it may have been decided already). Nothing was changed.' };
  const currency = p.pendingPriceCurrency || p.currency;
  await prisma.product.update({
    where: { id: p.id },
    data: {
      priceCents: p.pendingPriceCents,
      currency,
      // Quote-only for lack of a price → buyable again (same rule as a sync).
      ...(p.priceCents === null && p.mode === 'QUOTE_ONLY' ? { mode: 'HYBRID' as const } : {}),
      pendingPriceCents: null,
      pendingPriceCurrency: null,
      pendingPriceAt: null,
      pendingPriceNote: null,
      priceOnHold: false,
    },
  });
  await audit('product.price.review.approve', slug, `${p.priceCents ?? 'none'} ${p.currency} -> ${p.pendingPriceCents} ${currency} by ${email}`);
  revalidateProduct(slug);
  return { ok: true, message: `“${p.title}”: new price ${(p.pendingPriceCents / 100).toFixed(2)} ${currency} is live — the listing can be bought again.` };
}

/** Reject: keep our current price, release the hold, and lock the price so syncs stop proposing that change. */
export async function rejectPendingPrice(slug: string): Promise<Result> {
  const email = await adminEmail('products:edit');
  const p = await prisma.product.findUnique({
    where: { slug },
    select: { id: true, title: true, priceCents: true, currency: true, pendingPriceCents: true, pendingPriceCurrency: true, lockedFields: true },
  });
  if (!p) return { ok: false, message: 'Product not found.' };
  if (p.pendingPriceCents === null) return { ok: false, message: 'There is no price change waiting for this product (it may have been decided already). Nothing was changed.' };
  const locks = Array.from(new Set([...p.lockedFields, 'price']));
  await prisma.product.update({
    where: { id: p.id },
    data: { pendingPriceCents: null, pendingPriceCurrency: null, pendingPriceAt: null, pendingPriceNote: null, priceOnHold: false, lockedFields: locks },
  });
  await audit('product.price.review.reject', slug, `kept ${p.priceCents ?? 'none'} ${p.currency}; rejected ${p.pendingPriceCents} ${p.pendingPriceCurrency ?? p.currency}; price locked; by ${email}`);
  revalidateProduct(slug);
  const kept = p.priceCents !== null ? `${(p.priceCents / 100).toFixed(2)} ${p.currency}` : 'no price (quote only)';
  return {
    ok: true,
    message: `“${p.title}”: kept ${kept} and locked the price — syncs no longer change it (unlock it on the product page). ${p.priceCents !== null ? 'The listing can be bought again.' : ''}`.trim(),
  };
}

export async function approvePendingPriceForm(formData: FormData): Promise<Result> {
  return approvePendingPrice(String(formData.get('slug') ?? ''));
}

export async function rejectPendingPriceForm(formData: FormData): Promise<Result> {
  return rejectPendingPrice(String(formData.get('slug') ?? ''));
}

// ─── Catalog audit actions ───────────────────────────────────────────────────

/** Remove supplier claims, other prices and cross-sell tails from every supplier listing's texts. */
export async function cleanSupplierTextsAction(): Promise<Result> {
  const email = await adminEmail('products:edit');
  const rules = await getImportSettings();
  const r = await cleanSupplierTexts(prisma, rules, { apply: true });
  await audit('catalog.audit.clean', undefined, `checked=${r.checked} cleaned=${r.cleaned} sentences=${r.sentences} lockedSkipped=${r.skippedLocked} ${JSON.stringify(r.byReason)} by ${email}`);
  revalidatePath('/admin/catalog/audit');
  revalidatePath('/marketplace', 'layout');
  revalidatePath('/');
  const reasons = Object.entries(r.byReason).map(([k, n]) => `${k.toLowerCase().replace('_', '-')} ×${n}`).join(', ');
  return {
    ok: true,
    message: r.cleaned
      ? `${r.cleaned} listing(s) cleaned: ${r.sentences} sentence(s) removed (${reasons}).${r.skippedLocked ? ` ${r.skippedLocked} listing(s) with texts you edited were left alone — edit them by hand.` : ''}`
      : `Nothing to clean${r.skippedLocked ? ` — ${r.skippedLocked} listing(s) with texts you edited still need a look by hand` : ''}.`,
  };
}

const CONDITIONS = ['NEW', 'REFURBISHED', 'USED'] as const;

/** Set the condition the listing's own title / text states (one listing, or every listing the audit flags). */
export async function applyStatedConditionAction(formData: FormData): Promise<Result> {
  const email = await adminEmail('products:edit');
  const slug = String(formData.get('slug') ?? '');
  const rules = await getImportSettings();
  const [policy, grades] = await Promise.all([getCatalogPolicy(), getConditionGrades()]);
  const categories = await prisma.category.findMany({ select: { slug: true, name: true } });
  const names = new Map(categories.map((c) => [c.slug, c.name]));
  const rows = await prisma.product.findMany({ where: slug ? { slug, ...AUDIT_WHERE } : AUDIT_WHERE, select: AUDIT_SELECT });
  let changed = 0;
  let last = '';
  for (const p of rows) {
    const a = auditProduct(p, rules, policy.placeholderBrands, names);
    if (!a.statedCondition || !(CONDITIONS as readonly string[]).includes(a.statedCondition)) continue;
    await prisma.product.update({ where: { id: p.id }, data: { condition: a.statedCondition } });
    await audit('catalog.audit.condition', p.slug, `${p.condition} -> ${a.statedCondition} by ${email}`);
    last = `“${p.title}” is now “${grades[a.statedCondition]?.label ?? a.statedCondition}”`;
    changed++;
  }
  revalidatePath('/admin/catalog/audit');
  revalidatePath('/marketplace', 'layout');
  if (!changed) return { ok: false, message: 'No listing needed a condition change (it may have been fixed already). Nothing was changed.' };
  return {
    ok: true,
    message: slug
      ? `${last}. Its warranty default and search-engine condition follow the new grade.`
      : `${changed} listing(s) now carry the condition their own text states.`,
  };
}

/** Give listings without a (real) brand the brand their title names. */
export async function applySuggestedBrandsAction(formData: FormData): Promise<Result> {
  const email = await adminEmail('products:edit');
  const slug = String(formData.get('slug') ?? '');
  const rules = await getImportSettings();
  const policy = await getCatalogPolicy();
  const categories = await prisma.category.findMany({ select: { slug: true, name: true } });
  const names = new Map(categories.map((c) => [c.slug, c.name]));
  const rows = await prisma.product.findMany({ where: slug ? { slug, ...AUDIT_WHERE } : AUDIT_WHERE, select: AUDIT_SELECT });
  let changed = 0;
  const cache = new Map<string, string>();
  for (const p of rows) {
    const a = auditProduct(p, rules, policy.placeholderBrands, names);
    if (!a.suggestedBrand) continue;
    // In bulk only listings WITHOUT a real brand; one listing on request also replaces a wrong one.
    if (!slug && a.brand) continue;
    const key = a.suggestedBrand.toLowerCase();
    let brandId = cache.get(key);
    if (!brandId) {
      const bslug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      const found =
        (await prisma.brand.findUnique({ where: { slug: bslug }, select: { id: true } })) ??
        (await prisma.brand.findFirst({ where: { name: { equals: a.suggestedBrand, mode: 'insensitive' } }, select: { id: true } }));
      brandId = found?.id ?? (await prisma.brand.create({ data: { slug: bslug, name: a.suggestedBrand.slice(0, 80) }, select: { id: true } })).id;
      cache.set(key, brandId);
    }
    await prisma.product.update({ where: { id: p.id }, data: { brandId } });
    await audit('catalog.audit.brand', p.slug, `${a.brand ?? 'none'} -> ${a.suggestedBrand} by ${email}`);
    changed++;
  }
  revalidatePath('/admin/catalog/audit');
  revalidatePath('/marketplace', 'layout');
  return changed
    ? { ok: true, message: `${changed} listing(s) now carry the brand their title names.` }
    : { ok: false, message: 'No listing had a brand suggestion to apply. Nothing was changed.' };
}
