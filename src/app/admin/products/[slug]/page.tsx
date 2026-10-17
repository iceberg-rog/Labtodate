import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { resolveProductSlug } from '@/lib/products/slug';
import { AdminProductForm } from '@/components/admin/AdminProductForm';
import { adminUpdateProduct, adminDeleteProduct, type AdminProductInputType } from '@/app/admin/actions';
import { Button } from '@/components/ui/button';
import { formatPrice } from '@/lib/utils';
import { redirect } from 'next/navigation';
import type { IllustrationName } from '@/components/illustrations/instruments';
import { DeleteProductButton } from './DeleteProductButton';
import { ProductSyncPanel } from '@/components/admin/ProductSyncPanel';
import { getCatalogPolicy, getConditionGrades } from '@/lib/catalog/policy';
import { isOwnStoredImage, ownMediaPath } from '@/lib/media/public-src';
import { ensureSettingsLoaded, settingBool } from '@/lib/settings';

export const dynamic = 'force-dynamic';

export function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  return adminDetailTitle('products:edit', 'Edit product', async () => {
    const { slug } = await props.params;
    const p = await prisma.product.findUnique({ where: { slug: await resolveProductSlug(slug) }, select: { title: true } });
    return p && `Edit: ${p.title}`;
  });
}

export default async function AdminProductEditPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  await requireCapability('products:edit');
  await ensureSettingsLoaded();

  // Matches imported slugs stored with a literal '%c2%b5' (see resolveProductSlug).
  const product = await prisma.product.findUnique({
    where: { slug: await resolveProductSlug(params.slug) },
    include: { company: { select: { name: true, slug: true, syncPolicy: true } } },
  });
  if (!product) notFound();

  const [policy, grades, categories, brands, companies, orderLines] = await Promise.all([
    getCatalogPolicy(),
    getConditionGrades(),
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

  const slug = product.slug;
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
