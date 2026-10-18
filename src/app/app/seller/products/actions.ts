'use server';

import { publicProductImages } from '@/lib/media/public-src';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { deleteOrArchiveProduct, productDeleteDbFrom } from '@/lib/products/delete-guard';
import { getAdminCaps, requireSession } from '@/lib/auth-server';
import { capsAllow } from '@/lib/capabilities';
import { audit } from '@/lib/observability';
import { dispatchWebhook } from '@/lib/webhooks';
import { ensureSettingsLoaded } from '@/lib/settings';
import { offerCurrencies } from '@/lib/quotes/policy';
import { MAX_PRICE_CENTS, MAX_PRICE_MESSAGE, zodFieldErrors, zodMessage } from '@/lib/products/validation';
import { isOwnMediaUrl, isSafeImageUrl } from '@/lib/products/image-urls';
import {
  DIMENSIONS_SPEC_KEY,
  isListingModerator,
  listingChanges,
  liveEditOutcome,
  panelAccess,
  sellerListingPublishProblem,
  type ListingFields,
  type PanelActor,
} from '@/lib/sellers/listing-rules';
import { Prisma, type ProductCondition, type ProductMode } from '@prisma/client';

const ProductInput = z.object({
  title: z.string().trim().min(6).max(180),
  summary: z.string().max(300).optional().nullable(),
  description: z.string().max(8000, 'Description is too long (max 8,000 characters including formatting). Please shorten it.').optional().nullable(),
  categoryId: z.string().min(1),
  brandId: z.string().optional().nullable(),
  condition: z.enum(['NEW', 'REFURBISHED', 'USED']),
  mode: z.enum(['BUY_NOW', 'QUOTE_ONLY', 'HYBRID']),
  priceCents: z.number().int().nonnegative().max(MAX_PRICE_CENTS, MAX_PRICE_MESSAGE).nullable(),
  // One of the currencies staff quote in (Settings → Quotes & offers); checked in parseInput.
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Choose a currency from the list.').default('EUR'),
  quantity: z.number().int().min(0).max(100_000).default(1),
  yearMade: z.number().int().min(1900).max(2100).nullable(),
  illustration: z.enum(['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector']),
  // Where each photo may point is checked by checkImages() below.
  images: z.array(z.string().max(2048)).max(8).default([]),
  specs: z.record(z.string()).default({}),
  // What is promised about THIS unit (src/lib/catalog/warranty.ts):
  // warrantyMonths null = the condition's default, 0 = no warranty (sold as-is).
  warrantyMonths: z.number().int().min(0).max(120).nullable().default(null),
  warrantyText: z.string().trim().max(500).nullish(),
  conditionNotes: z.string().trim().max(1000).nullish(),
  inspectedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Inspection date must be a date.').nullish(),
  inspectionNotes: z.string().trim().max(1000).nullish(),
  // Drives the freight quote at checkout (null = Settings → Shipping → default class).
  shippingClass: z.enum(['PARCEL', 'PALLET', 'FREIGHT_QUOTE']).nullable().default(null),
  weightKg: z.number().positive('Weight must be more than 0 kg.').max(100_000).nullable().default(null),
  // Kept as the “Dimensions” row of the spec table (shown to buyers).
  dimensions: z.string().trim().max(120).nullish(),
  vatScheme: z.enum(['STANDARD', 'MARGIN']).default('STANDARD'),
}).superRefine((p, ctx) => {
  if (p.vatScheme === 'MARGIN' && p.condition === 'NEW') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vatScheme'], message: 'The margin scheme is only for second-hand goods (Refurbished / Used).' });
  }
  if (p.vatScheme === 'MARGIN' && p.priceCents == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['priceCents'], message: 'The margin scheme needs your price: it is what we pay you for the unit.' });
  }
  if (p.inspectedAt && p.inspectedAt > new Date().toISOString().slice(0, 10)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inspectedAt'], message: 'The inspection date cannot be in the future.' });
  }
});

export type ProductInputType = z.infer<typeof ProductInput>;

/** Returned (never thrown) when a save is rejected, so the form can show a
 *  readable message — production builds redact thrown server-action errors. */
export type ProductActionError = { ok: false; message: string; fieldErrors?: Record<string, string> };

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  summary: 'Short summary',
  description: 'Description',
  categoryId: 'Category',
  brandId: 'Brand',
  condition: 'Condition',
  mode: 'Buying mode',
  priceCents: 'Price',
  currency: 'Currency',
  quantity: 'Quantity in stock',
  yearMade: 'Year made',
  illustration: 'Fallback illustration',
  images: 'Photos',
  specs: 'Technical specs',
  warrantyMonths: 'Warranty (months)',
  warrantyText: 'Warranty terms',
  conditionNotes: 'Condition notes',
  inspectedAt: 'Inspection date',
  inspectionNotes: 'Inspection notes',
  shippingClass: 'Shipping class',
  weightKg: 'Weight',
  dimensions: 'Dimensions',
  vatScheme: 'VAT scheme',
};

function parseInput(input: ProductInputType, keepCurrency?: string): { data: ProductInputType } | { error: ProductActionError } {
  const r = ProductInput.safeParse(input);
  if (!r.success) {
    return {
      error: {
        ok: false,
        message: zodMessage(r.error, FIELD_LABELS),
        fieldErrors: zodFieldErrors(r.error, FIELD_LABELS),
      },
    };
  }
  // A listing already priced in a currency that was later dropped from the
  // list stays editable in it.
  const allowed = offerCurrencies();
  if (!allowed.includes(r.data.currency) && r.data.currency !== keepCurrency) {
    const message = `Choose one of the currencies: ${allowed.join(', ')}.`;
    return { error: { ok: false, message, fieldErrors: { currency: message } } };
  }
  return { data: r.data };
}

/**
 * Photos must be files from our own upload store (the form's "Add image" →
 * /api/upload). A URL already on the listing — e.g. a supplier photo from a
 * shop import — may stay if it is a plain http(s) address, so such listings
 * remain editable; no new outside URL can be added. javascript:, data: and
 * other schemes are refused always.
 */
function checkImages(images: string[], alreadyOnListing: readonly string[] = []): ProductActionError | null {
  for (const [i, url] of images.entries()) {
    if (isOwnMediaUrl(url)) continue;
    if (alreadyOnListing.includes(url) && isSafeImageUrl(url)) continue;
    const message = isSafeImageUrl(url)
      ? `Photo ${i + 1} is not one of your uploads. Remove it and add the picture with “Add image” instead.`
      : `Photo ${i + 1} has an address we can't use. Remove it and add the picture with “Add image” instead.`;
    return { ok: false, message, fieldErrors: { images: message } };
  }
  return null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

/** The signed-in supplier or admin, with the admin's permissions (D05). */
async function getActor(): Promise<PanelActor & { email: string }> {
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: '/app/seller' });
  const role = (session.user as { role?: string }).role || 'SELLER';
  await ensureSettingsLoaded();
  return { userId: session.user.id, email: session.user.email, role, caps: role === 'ADMIN' ? await getAdminCaps() : [] };
}

/** The spec table with the dimensions row (the form edits it as its own field). */
function specsWithDimensions(specs: Record<string, string>, dimensions: string | null | undefined): Record<string, string> {
  const out = Object.fromEntries(Object.entries(specs).filter(([k]) => k !== DIMENSIONS_SPEC_KEY));
  if (dimensions?.trim()) out[DIMENSIONS_SPEC_KEY] = dimensions.trim();
  return out;
}

/** The columns a seller-panel save writes. */
function listingData(p: ProductInputType) {
  const specs = specsWithDimensions(p.specs, p.dimensions);
  return {
    title: p.title,
    summary: p.summary ?? null,
    description: p.description ?? null,
    condition: p.condition as ProductCondition,
    mode: p.mode as ProductMode,
    priceCents: p.priceCents,
    currency: p.currency,
    quantity: p.quantity,
    yearMade: p.yearMade,
    illustration: p.illustration,
    images: p.images,
    // Ranks like admin listings with photos (marketplace sorts by hasImages).
    hasImages: publicProductImages(p.images).length > 0,
    specs: Object.keys(specs).length ? (specs as Prisma.InputJsonValue) : Prisma.JsonNull,
    categoryId: p.categoryId,
    brandId: p.brandId || null,
    warrantyMonths: p.warrantyMonths,
    warrantyText: p.warrantyText || null,
    conditionNotes: p.conditionNotes || null,
    inspectedAt: p.inspectedAt ? new Date(`${p.inspectedAt}T00:00:00Z`) : null,
    inspectionNotes: p.inspectionNotes || null,
    shippingClass: p.shippingClass,
    weightKg: p.weightKg,
    vatScheme: p.vatScheme,
    // We buy the unit at the supplier's price: under the margin scheme that is
    // the purchase cost the margin VAT is computed from.
    ...(p.vatScheme === 'MARGIN' ? { purchaseCostCents: p.priceCents } : {}),
  };
}

/** A stored listing or a save's data, in the shape the review rules compare. */
function fieldsOf(p: Omit<ListingFields, 'inspectedAt' | 'specs' | 'illustration'> & { inspectedAt: Date | null; specs: unknown; illustration: string | null }): ListingFields {
  return {
    ...p,
    illustration: p.illustration ?? 'balance',
    specs: p.specs === Prisma.JsonNull ? null : p.specs,
    inspectedAt: p.inspectedAt ? p.inspectedAt.toISOString().slice(0, 10) : null,
  };
}

/**
 * In-app notice (and webhook) for the admins who approve listings
 * (products:approve) — the people who act on it, not every admin.
 */
async function notifyModerators(title: string, body: string, href: string): Promise<void> {
  try {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN', suspendedAt: null }, select: { id: true, adminCaps: true } });
    const to = admins.filter((a) => capsAllow(a.adminCaps, 'products:approve'));
    if (to.length) {
      await prisma.notification.createMany({
        data: to.map((a) => ({ userId: a.id, title: title.slice(0, 140), body: body.slice(0, 500), href, kind: 'SYSTEM' as const })),
      });
    }
  } catch {
    /* never break the save */
  }
  try {
    await dispatchWebhook('SYSTEM', title, body, href);
  } catch {
    /* ignore */
  }
}

export async function createProduct(input: ProductInputType): Promise<ProductActionError | void> {
  const actor = await getActor();
  const result = parseInput(input);
  if ('error' in result) return result.error;
  const parsed = result.data;
  const imageError = checkImages(parsed.images);
  if (imageError) return imageError;

  const me = await prisma.user.findUnique({ where: { id: actor.userId }, select: { role: true, companyId: true } });

  // Ensure unique slug — append a short random suffix if needed.
  let slug = slugify(parsed.title);
  if (slug.length < 3) slug = `product-${Date.now().toString(36)}`;
  while (await prisma.product.findUnique({ where: { slug } })) {
    slug = `${slug.slice(0, 80)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  await prisma.product.create({
    data: {
      ...listingData(parsed),
      slug,
      // Every new listing is moderated (A3); a moderator publishes it from the list.
      status: 'PENDING_REVIEW',
      sellerId: actor.userId,
      // The supplier's company decides our margin on its price (lib/pricing/resolve.ts).
      companyId: me?.companyId ?? null,
    },
  });
  await audit('product.seller-panel.create', slug, `${parsed.title} · ${parsed.mode} · ${parsed.priceCents ?? 'no price'} ${parsed.currency}`);
  const noCompany = sellerListingPublishProblem({ sellerRole: me?.role, companyId: me?.companyId });
  await notifyModerators(
    'New listing to review',
    `${actor.email} submitted “${parsed.title}”.${noCompany ? ' The supplier is not linked to a company yet: link one (Admin → Users) before you publish it.' : ''}`,
    `/admin/products/${slug}`,
  );

  revalidatePath('/app/seller/products');
  redirect('/app/seller/products?created=1');
}

export async function updateProduct(slug: string, input: ProductInputType): Promise<ProductActionError | void> {
  const actor = await getActor();
  const existing = await prisma.product.findUnique({ where: { slug } });
  if (!existing) return { ok: false, message: 'This listing no longer exists.' };
  const access = panelAccess(actor, existing.sellerId, 'edit');
  if (!access.ok) return { ok: false, message: access.message };
  const result = parseInput(input, existing.currency);
  if ('error' in result) return result.error;
  const parsed = result.data;
  const imageError = checkImages(parsed.images, existing.images);
  if (imageError) return imageError;

  // INVARIANTS A3 + D69: an approved listing can't be swapped for different
  // terms unseen. A change to what is promised commercially (price, mode,
  // condition, warranty, inspection, VAT) sends a live listing back to review;
  // a text or photo change keeps it live and moderators are asked to check it.
  // Moderators' own edits need no review.
  const data = listingData(parsed);
  const changes = listingChanges(fieldsOf(existing), fieldsOf(data));
  const outcome = liveEditOutcome(existing.status, changes, isListingModerator(actor));

  await prisma.product.update({
    where: { id: existing.id },
    data: { ...data, ...(outcome === 'review' ? { status: 'PENDING_REVIEW' as const } : {}) },
  });

  const changed = [...changes.commercial, ...changes.content, ...(changes.stock ? [`quantity ${existing.quantity} → ${parsed.quantity}`] : [])];
  await audit(
    'product.seller-panel.update',
    slug,
    `${access.asStaff ? 'staff edit of another supplier’s listing · ' : ''}${changed.length ? `changed: ${changed.join(', ')}` : 'no change'}${outcome === 'review' ? ' · back to review' : outcome === 'flagged' ? ' · stays live, flagged for a check' : ''}`,
  );
  const who = actor.email;
  if (outcome === 'review') {
    await notifyModerators(
      'Live listing changed — needs re-review',
      `${who} changed the ${changes.commercial.join(', ')} of “${parsed.title}”. It is hidden from buyers until you approve it again.`,
      `/admin/products/${slug}`,
    );
  } else if (outcome === 'flagged') {
    await notifyModerators(
      'Live listing edited — check the changes',
      `${who} changed the ${changes.content.join(', ')} of “${parsed.title}”. The listing stays live.`,
      `/admin/products/${slug}`,
    );
  } else if (existing.status === 'PENDING_REVIEW' && !isListingModerator(actor) && (changes.commercial.length || changes.content.length)) {
    await notifyModerators('Listing in review was changed', `${who} changed “${parsed.title}” while it waits for review.`, `/admin/products/${slug}`);
  }

  revalidatePath('/app/seller/products');
  revalidatePath(`/marketplace/${slug}`);
  redirect(
    outcome === 'review' ? '/app/seller/products?updated=1&review=1'
    : outcome === 'flagged' ? '/app/seller/products?updated=1&check=1'
    : '/app/seller/products?updated=1',
  );
}

/**
 * Delete a product.
 *
 * BUG-004 fix: previously a seller could nuke a product that had pending
 * orders, silently cascading away reviews/wishlists/cart items and
 * orphaning OrderItems (productId → null). Any product with order history is
 * ARCHIVED instead of hard-deleted — for EVERYONE, sellers and admins alike.
 * The OrderItem.productId FK is ON DELETE RESTRICT (defense-in-depth), so even a
 * stray hard-delete cannot sever the audit link; the shared deleteOrArchiveProduct
 * helper (src/lib/products/delete-guard.ts) enforces this and is also TOCTOU-safe.
 * Staff delete somebody else's listing only with products:edit (D05).
 */
export async function deleteProduct(slug: string) {
  const actor = await getActor();
  const existing = await prisma.product.findUnique({
    where: { slug },
    select: { id: true, sellerId: true, title: true },
  });
  if (!existing) return;
  const access = panelAccess(actor, existing.sellerId, 'delete');
  if (!access.ok) {
    await audit('product.seller-panel.delete.refused', slug, access.message);
    throw new Error('Forbidden');
  }

  const outcome = await deleteOrArchiveProduct(productDeleteDbFrom(prisma), existing.id);
  await audit('product.seller-panel.delete', slug, `${outcome}${access.asStaff ? ' · staff action on another supplier’s listing' : ''} · ${existing.title}`);
  revalidatePath('/app/seller/products');
  revalidatePath(`/marketplace/${slug}`);
  redirect(outcome === 'archived' ? '/app/seller/products?archived=1' : '/app/seller/products?deleted=1');
}

/**
 * Seller-side publish toggle.
 *
 * BUG-001 fix: previously sellers could flip DRAFT → PUBLISHED directly,
 * bypassing admin moderation. Now:
 *  - a moderator (ADMIN with products:approve) publishes / unpublishes — a
 *    supplier's listing only once the supplier is linked to a company (D84);
 *  - everybody else (suppliers, admins without products:approve):
 *    DRAFT → PENDING_REVIEW ("request approval"), PUBLISHED → DRAFT
 *    ("unpublish"). They CANNOT push to PUBLISHED.
 *  - somebody else's listing: only a moderator (D05).
 */
export async function publishProduct(slug: string, publish: boolean) {
  const actor = await getActor();
  const existing = await prisma.product.findUnique({
    where: { slug },
    select: { id: true, sellerId: true, status: true, title: true, companyId: true, seller: { select: { role: true } } },
  });
  if (!existing) return;
  const access = panelAccess(actor, existing.sellerId, 'publish');
  if (!access.ok) {
    await audit('product.seller-panel.publish.refused', slug, access.message);
    throw new Error('Forbidden');
  }

  // Each outcome redirects with a flag so the list page can say what happened.
  let notice: 'published' | 'requested' | 'in-review' | 'unpublished';
  let next: 'PUBLISHED' | 'PENDING_REVIEW' | 'DRAFT';
  if (isListingModerator(actor)) {
    if (publish && sellerListingPublishProblem({ sellerRole: existing.seller.role, companyId: existing.companyId })) {
      redirect('/app/seller/products?notice=no-company');
    }
    next = publish ? 'PUBLISHED' : 'DRAFT';
    notice = publish ? 'published' : 'unpublished';
  } else if (publish) {
    if (existing.status === 'PUBLISHED' || existing.status === 'PENDING_REVIEW') {
      // Already live / already queued; idempotent no-op.
      revalidatePath('/app/seller/products');
      redirect(`/app/seller/products?notice=${existing.status === 'PUBLISHED' ? 'published' : 'in-review'}`);
    }
    // Asking to go live → enter moderation queue. A moderator must approve.
    next = 'PENDING_REVIEW';
    notice = 'requested';
  } else {
    next = 'DRAFT';
    notice = 'unpublished';
  }
  await prisma.product.update({ where: { id: existing.id }, data: { status: next } });
  await audit('product.seller-panel.publish', slug, `${existing.status} → ${next}${access.asStaff ? ' · staff action on another supplier’s listing' : ''}`);
  if (next === 'PENDING_REVIEW') {
    await notifyModerators('Listing to review', `${actor.email} asks to publish “${existing.title}”.`, `/admin/products/${slug}`);
  }

  revalidatePath('/app/seller/products');
  revalidatePath(`/marketplace/${slug}`);
  redirect(`/app/seller/products?notice=${notice}`);
}
