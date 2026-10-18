import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, CheckCircle2, XCircle } from 'lucide-react';
import { hasCapability, requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { resolveProductSlug } from '@/lib/products/slug';
import { AdminProductForm } from '@/components/admin/AdminProductForm';
import { adminUpdateProduct, adminDeleteProduct, setProductStatus, type AdminProductInputType } from '@/app/admin/actions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatPrice } from '@/lib/utils';
import { redirect } from 'next/navigation';
import type { IllustrationName } from '@/components/illustrations/instruments';
import type { Prisma } from '@prisma/client';
import { DeleteProductButton } from './DeleteProductButton';
import { ProductSyncPanel } from '@/components/admin/ProductSyncPanel';
import { getCatalogPolicy, getConditionGrades, type CatalogPolicy, type GradeInfo } from '@/lib/catalog/policy';
import { resolveInspection, resolveWarranty } from '@/lib/catalog/warranty';
import { isOwnStoredImage, ownMediaPath } from '@/lib/media/public-src';
import { sellPriceOf } from '@/lib/pricing/server';
import { sanitizeRichHtml } from '@/lib/sanitize';
import { companyPriceRule, sellerListingPublishProblem } from '@/lib/sellers/listing-rules';
import { ensureSettingsLoaded, settingBool, settingEnum } from '@/lib/settings';

export const dynamic = 'force-dynamic';

const PRODUCT_INCLUDE = {
  company: { select: { name: true, slug: true, syncPolicy: true, pricingMode: true, pricingMarkupBp: true } },
  seller: { select: { id: true, name: true, email: true, role: true } },
  category: { select: { name: true } },
  brand: { select: { name: true } },
} satisfies Prisma.ProductInclude;
type ReviewProduct = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;

/**
 * Moderation goes through setProductStatus (products:approve). It takes an
 * optional reason for the supplier once the moderation notices of PKG-04 are
 * in; until then the reason is not stored.
 */
const moderate: (slug: string, status: 'PUBLISHED' | 'DRAFT', reason?: string | null) => Promise<unknown> = setProductStatus;

/** setProductStatus answers { ok: false, message } when it refuses (PKG-04). */
function refused(r: unknown): boolean {
  return typeof r === 'object' && r !== null && 'ok' in r && (r as { ok: unknown }).ok === false;
}

const MODERATED: Record<string, { ok: boolean; text: string }> = {
  published: { ok: true, text: 'Listing approved: it is live.' },
  rejected: { ok: true, text: 'Listing rejected: it is back to draft and hidden from buyers.' },
  unpublished: { ok: true, text: 'Listing unpublished: it is hidden from buyers.' },
  'no-company': { ok: false, text: 'Not published: the supplier is not linked to a company yet, so the listing has no price rule. Link one on the supplier’s user page (Supplier company).' },
  failed: { ok: false, text: 'The status could not be changed — check your permissions and try again.' },
};

export function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  return adminDetailTitle('products:view', 'Product', async () => {
    const { slug } = await props.params;
    const p = await prisma.product.findUnique({ where: { slug: await resolveProductSlug(slug) }, select: { title: true } });
    return p && `Product: ${p.title}`;
  });
}

export default async function AdminProductEditPage(props: { params: Promise<{ slug: string }>; searchParams: Promise<{ moderated?: string }> }) {
  const [params, searchParams] = await Promise.all([props.params, props.searchParams]);
  // Editors get the form; a moderator with products:approve but not
  // products:edit opens the listing read-only to approve or reject it (G5).
  const [canEdit, canApprove] = await Promise.all([hasCapability('products:edit'), hasCapability('products:approve')]);
  if (!canEdit && !canApprove) await requireCapability('products:edit');
  await ensureSettingsLoaded();

  // Matches imported slugs stored with a literal '%c2%b5' (see resolveProductSlug).
  const product = await prisma.product.findUnique({
    where: { slug: await resolveProductSlug(params.slug) },
    include: PRODUCT_INCLUDE,
  });
  if (!product) notFound();

  const slug = product.slug;
  const publishProblem = sellerListingPublishProblem({ sellerRole: product.seller.role, companyId: product.companyId });

  async function approve() {
    'use server';
    await requireCapability('products:approve');
    const p = await prisma.product.findUnique({ where: { slug }, select: { companyId: true, seller: { select: { role: true } } } });
    if (!p) redirect('/admin/products');
    // A supplier's listing needs its company's price rule before it goes live (D84).
    if (sellerListingPublishProblem({ sellerRole: p.seller.role, companyId: p.companyId })) redirect(`/admin/products/${slug}?moderated=no-company`);
    const r = await moderate(slug, 'PUBLISHED');
    redirect(`/admin/products/${slug}?moderated=${refused(r) ? 'failed' : 'published'}`);
  }
  async function reject(formData: FormData) {
    'use server';
    await requireCapability('products:approve');
    const reason = String(formData.get('reason') ?? '').trim().slice(0, 500) || null;
    const live = (await prisma.product.findUnique({ where: { slug }, select: { status: true } }))?.status === 'PUBLISHED';
    const r = await moderate(slug, 'DRAFT', reason);
    redirect(`/admin/products/${slug}?moderated=${refused(r) ? 'failed' : live ? 'unpublished' : 'rejected'}`);
  }

  const moderated = MODERATED[searchParams.moderated ?? ''] ?? null;
  const bar = canApprove ? (
    <ModerationBar status={product.status} publishProblem={publishProblem} sellerHref={`/admin/users/${product.seller.id}`} approve={approve} reject={reject} />
  ) : null;
  const notice = moderated ? (
    <p
      role={moderated.ok ? 'status' : 'alert'}
      className={`rounded-xl border px-4 py-3 text-sm ${moderated.ok ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300' : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300'}`}
    >
      {moderated.text}
    </p>
  ) : null;

  const [policy, grades] = await Promise.all([getCatalogPolicy(), getConditionGrades()]);

  if (!canEdit) {
    return (
      <ListingReview
        product={product}
        policy={policy}
        grade={grades[product.condition]}
        defaultShippingClass={settingEnum('SHIPPING_DEFAULT_CLASS')}
        notice={notice}
        bar={bar}
      />
    );
  }

  const [categories, brands, companies, orderLines] = await Promise.all([
    prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true } }),
    prisma.brand.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.company.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.orderItem.count({ where: { productId: product.id } }),
  ]);

  const initial: Partial<AdminProductInputType> = {
    title: product.title,
    summary: product.summary ?? null,
    description: product.description ?? null,
    categoryId: product.categoryId,
    brandId: product.brandId ?? null,
    companyId: product.companyId ?? null,
    condition: product.condition,
    mode: product.mode,
    priceCents: product.priceCents ?? null,
    currency: product.currency,
    quantity: product.quantity,
    yearMade: product.yearMade ?? null,
    illustration: (product.illustration as IllustrationName | null) ?? null,
    images: product.images,
    specs: (product.specs as Record<string, string> | null) ?? {},
    status: product.status,
    warrantyMonths: product.warrantyMonths,
    warrantyText: product.warrantyText,
    conditionNotes: product.conditionNotes,
    inspectedAt: product.inspectedAt ? product.inspectedAt.toISOString().slice(0, 10) : null,
    inspectionReportUrl: product.inspectionReportUrl,
    inspectionNotes: product.inspectionNotes,
    sku: product.sku,
    mpn: product.mpn,
    vatScheme: product.vatScheme,
    purchaseCostCents: product.purchaseCostCents,
  };

  async function handleSave(input: AdminProductInputType) {
    'use server';
    return adminUpdateProduct(slug, input);
  }
  async function handleDelete() {
    'use server';
    const r = await adminDeleteProduct(slug);
    if (!r.ok) redirect('/admin/products');
    // Say what really happened: products with orders are archived, not deleted.
    redirect(r.outcome === 'archived' ? '/admin/products?archived=1' : '/admin/products?deleted=1');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <Link
            href="/admin/products"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground mb-2"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to products
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Edit product</h1>
          <p className="text-muted-foreground mt-1 truncate max-w-xl">{product.title}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="rounded-full">
            <Link href={`/marketplace/${product.slug}`} target="_blank">
              <ExternalLink className="h-3.5 w-3.5" /> View live
            </Link>
          </Button>
          <form action={handleDelete}>
            <DeleteProductButton title={product.title} hasOrders={orderLines > 0} />
          </form>
        </div>
      </div>
      {notice}
      {bar}
      {product.pendingPriceCents !== null && (
        <div className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 px-4 py-3 text-sm" data-testid="pending-price-notice">
          <strong>A supplier price change waits for your review:</strong>{' '}
          {product.priceCents !== null ? formatPrice(product.priceCents, product.currency) : 'no price'} →{' '}
          {formatPrice(product.pendingPriceCents, product.pendingPriceCurrency || product.currency)}.{' '}
          {product.priceOnHold ? 'The listing cannot be bought until you decide. ' : 'It is still sold at the current price. '}
          <Link href="/admin/catalog/price-review" className="font-semibold underline">Price review</Link> — or set a price below (that decides it too).
        </div>
      )}
      <ProductSyncPanel
        slug={product.slug}
        shopName={product.company?.name ?? null}
        shopSlug={product.company?.slug ?? null}
        syncPolicy={product.company?.syncPolicy ?? null}
        externalId={product.externalId}
        sourceUrl={product.sourceUrl}
        sourceAvailability={product.sourceAvailability}
        lastSyncedAt={product.lastSyncedAt ? product.lastSyncedAt.toISOString() : null}
        removedAtSourceAt={product.removedAtSourceAt ? product.removedAtSourceAt.toISOString() : null}
        lockedFields={product.lockedFields}
        foreignPhotos={product.images.filter((u) => !isOwnStoredImage(u)).length}
      />
      <AdminProductForm
        initial={initial}
        categories={categories}
        brands={brands}
        companies={companies}
        grades={grades}
        warrantyFallbackText={policy.warrantyFallbackText}
        warrantyMonthsFormat={policy.warrantyMonthsFormat}
        inspectionRequiresReport={policy.inspectionRequiresReport}
        marginSchemeEnabled={settingBool('TAX_MARGIN_SCHEME_ENABLED')}
        photoMode={policy.missingPhotoMode}
        photoLabels={{ noPhoto: policy.noPhotoLabel, illustration: policy.illustrationLabel }}
        publicPaths={Object.fromEntries(product.images.map((u) => [u, ownMediaPath(u)]))}
        onSubmit={handleSave}
        submitLabel="Save changes"
      />
    </div>
  );
}

/** Approve / reject for moderators (products:approve), on both views. */
function ModerationBar({
  status,
  publishProblem,
  sellerHref,
  approve,
  reject,
}: {
  status: string;
  publishProblem: string | null;
  sellerHref: string;
  approve: () => Promise<void>;
  reject: (formData: FormData) => Promise<void>;
}) {
  if (status === 'ARCHIVED') return null;
  const live = status === 'PUBLISHED';
  return (
    <div className="rounded-2xl border border-border bg-card p-5 space-y-3" data-testid="moderation-bar">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-sm font-bold">Moderation</p>
        <StatusBadge status={status} />
      </div>
      {publishProblem && !live && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          {publishProblem}{' '}
          <Link href={sellerHref} className="font-semibold underline">Open the supplier</Link>
        </p>
      )}
      <div className="flex flex-col sm:flex-row gap-3 sm:items-start">
        {!live && (
          <form action={approve}>
            <Button type="submit" size="sm" className="rounded-full" disabled={!!publishProblem}>
              <CheckCircle2 className="h-3.5 w-3.5" /> Approve and publish
            </Button>
          </form>
        )}
        {status !== 'DRAFT' && (
          <form action={reject} className="flex-1 flex flex-col sm:flex-row gap-2">
            <input
              name="reason"
              maxLength={500}
              placeholder={live ? 'Why it is taken offline (optional, for the supplier)' : 'Reason for the supplier (optional)'}
              className="h-9 flex-1 px-3 rounded-lg border border-input bg-background text-sm"
              aria-label="Reason"
            />
            <Button type="submit" size="sm" variant="outline" className="rounded-full">
              <XCircle className="h-3.5 w-3.5" /> {live ? 'Unpublish' : 'Reject to draft'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: 'success' | 'warning' | 'secondary'; label: string }> = {
    PUBLISHED: { variant: 'success', label: 'Published' },
    PENDING_REVIEW: { variant: 'warning', label: 'Awaiting review' },
    DRAFT: { variant: 'secondary', label: 'Draft' },
    ARCHIVED: { variant: 'secondary', label: 'Archived' },
  };
  const m = map[status] ?? { variant: 'secondary' as const, label: status };
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

const SHIPPING_CLASS_LABEL: Record<string, string> = { PARCEL: 'Parcel', PALLET: 'Pallet', FREIGHT_QUOTE: 'Freight — quote per order' };

/** Read-only view of a listing for a moderator without products:edit. */
function ListingReview({
  product: p,
  policy,
  grade,
  defaultShippingClass,
  notice,
  bar,
}: {
  product: ReviewProduct;
  policy: CatalogPolicy;
  grade: GradeInfo;
  defaultShippingClass: string;
  notice: React.ReactNode;
  bar: React.ReactNode;
}) {
  const price = sellPriceOf(p);
  const warranty = resolveWarranty({ warrantyMonths: p.warrantyMonths, warrantyText: p.warrantyText }, grade, policy.warrantyFallbackText, policy.warrantyMonthsFormat);
  const inspection = resolveInspection({ inspectedAt: p.inspectedAt, inspectionReportUrl: p.inspectionReportUrl }, policy.inspectionRequiresReport);
  const rule = p.company ? companyPriceRule(p.company.pricingMode, p.company.pricingMarkupBp) : null;
  const specs = Object.entries((p.specs as Record<string, string> | null) ?? {});
  const facts: Array<[string, React.ReactNode]> = [
    ['Seller', <>{p.seller.name} · {p.seller.email} <span className="text-muted-foreground">({p.seller.role === 'SELLER' ? 'internal supplier' : p.seller.role.toLowerCase()})</span></>],
    ['Company', p.company ? <>{p.company.name} <span className="text-muted-foreground">· {rule?.rule}</span></> : p.seller.role === 'SELLER' ? <span className="text-amber-800 dark:text-amber-300">not linked</span> : 'our own stock'],
    ['Category · brand', `${p.category.name} · ${p.brand?.name ?? 'no brand'}`],
    ['Condition', `${grade.label}${p.yearMade ? ` · made ${p.yearMade}` : ''}`],
    ['Buying mode', p.mode.toLowerCase().replace('_', ' ')],
    [p.seller.role === 'SELLER' ? 'Supplier price' : 'Price', p.priceCents != null ? `${formatPrice(p.priceCents, p.currency)} excl. VAT` : 'none (quote only)'],
    ['Buyer price', price.sellPriceCents != null ? `${formatPrice(price.sellPriceCents, price.currency)} excl. VAT` : price.reasons[0] ?? 'not shown'],
    ['Stock', p.quantity > 0 ? `${p.quantity} in stock` : 'sold out'],
    ['Warranty', warranty.full],
    ['Inspection', inspection.claim ? `inspected ${inspection.date?.toISOString().slice(0, 10)}` : inspection.reason === 'NO_REPORT' ? 'date recorded, no report — no claim shown' : 'none'],
    ['Condition notes', p.conditionNotes || '—'],
    ['Shipping', `${SHIPPING_CLASS_LABEL[p.shippingClass ?? defaultShippingClass] ?? p.shippingClass ?? defaultShippingClass}${p.shippingClass ? '' : ' (default)'}${p.weightKg ? ` · ${p.weightKg} kg` : ' · no weight'}`],
    ['VAT scheme', p.vatScheme === 'MARGIN' ? 'margin scheme (second-hand)' : 'standard'],
    ['Photos', String(p.images.length)],
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <Link href="/admin/products" className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground mb-2">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to products
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Review listing</h1>
          <p className="text-muted-foreground mt-1 truncate max-w-xl" dir="auto">{p.title}</p>
        </div>
        <Button asChild variant="outline" size="sm" className="rounded-full">
          <Link href={`/marketplace/${p.slug}`} target="_blank">
            <ExternalLink className="h-3.5 w-3.5" /> Preview the product page
          </Link>
        </Button>
      </div>
      {notice}
      {bar}
      <p className="text-xs text-muted-foreground">Read-only: changing the listing needs the products:edit permission.</p>
      <dl className="rounded-2xl border border-border bg-card divide-y divide-border text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-1 px-5 py-2.5">
            <dt className="text-muted-foreground">{label}</dt>
            <dd dir="auto">{value}</dd>
          </div>
        ))}
      </dl>
      {(p.summary || p.description) && (
        <div className="rounded-2xl border border-border bg-card p-5 space-y-3">
          {p.summary && <p className="font-semibold" dir="auto">{p.summary}</p>}
          {p.description && <div className="prose-article text-sm" dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(p.description) }} />}
        </div>
      )}
      {specs.length > 0 && (
        <dl className="rounded-2xl border border-border bg-card divide-y divide-border text-sm">
          {specs.map(([k, v]) => (
            <div key={k} className="grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-1 px-5 py-2">
              <dt className="text-muted-foreground" dir="auto">{k}</dt>
              <dd dir="auto">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
