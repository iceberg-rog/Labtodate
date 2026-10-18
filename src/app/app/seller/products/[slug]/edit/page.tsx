import { notFound } from 'next/navigation';
import { hasCapability, requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ProductForm } from '@/components/seller/ProductForm';
import { updateProduct } from '../../actions';
import { sellerFormOptions } from '../../form-options';
import type { IllustrationName } from '@/components/illustrations/instruments';
import type { ProductInputType } from '../../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Edit listing' };

export default async function EditProductPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: `/app/seller/products/${params.slug}/edit` });

  const product = await prisma.product.findUnique({
    where: { slug: params.slug },
    include: { seller: { select: { role: true, email: true } } },
  });
  if (!product) notFound();

  const role = (session.user as { role?: string }).role;
  const own = product.sellerId === session.user.id;
  // Somebody else's listing: staff with products:edit only (D05) — the same
  // rule updateProduct applies; anyone else gets a 404, not a form.
  if (!own && !(role === 'ADMIN' && (await hasCapability('products:edit')))) notFound();
  const moderator = role === 'ADMIN' && (await hasCapability('products:approve'));

  const options = await sellerFormOptions(product.currency);

  const initial: Partial<ProductInputType> & { slug: string; inspectionReportUrl: string | null } = {
    slug: product.slug,
    title: product.title,
    summary: product.summary ?? null,
    description: product.description ?? null,
    categoryId: product.categoryId,
    brandId: product.brandId ?? null,
    condition: product.condition,
    mode: product.mode,
    priceCents: product.priceCents ?? null,
    currency: product.currency,
    quantity: product.quantity,
    yearMade: product.yearMade ?? null,
    illustration: (product.illustration ?? 'balance') as IllustrationName,
    images: product.images,
    specs: (product.specs as Record<string, string> | null) ?? {},
    warrantyMonths: product.warrantyMonths,
    warrantyText: product.warrantyText,
    conditionNotes: product.conditionNotes,
    inspectedAt: product.inspectedAt ? product.inspectedAt.toISOString().slice(0, 10) : null,
    inspectionNotes: product.inspectionNotes,
    inspectionReportUrl: product.inspectionReportUrl,
    shippingClass: product.shippingClass,
    weightKg: product.weightKg,
    vatScheme: product.vatScheme,
  };

  const slug = product.slug;
  async function handleSubmit(input: ProductInputType) {
    'use server';
    return updateProduct(slug, input);
  }
  // Commercial changes to a live listing go back to review; text and photo
  // changes stay live and are checked by a moderator (INVARIANTS A3, D69).
  const reReview = product.status === 'PUBLISHED' && !moderator;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Edit listing</h1>
        <p className="text-muted-foreground mt-1 truncate">{product.title}</p>
      </div>
      {!own && (
        <div className="rounded-xl border border-border bg-foreground/[0.03] px-4 py-3 text-sm max-w-3xl">
          You are editing a listing of <strong>{product.seller.email}</strong> as staff. Every change is logged.
        </div>
      )}
      {reReview && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 px-4 py-3 text-sm max-w-3xl">
          This listing is live. A change to the price, currency, buying mode, condition, warranty, inspection date or VAT
          scheme sends it back to admin review: it is hidden from buyers until it is approved again. Changes to texts,
          photos, specs and shipping details stay live and our team checks them; a new stock quantity applies at once.
        </div>
      )}
      <ProductForm
        initial={initial}
        options={options}
        supplierPrice={product.seller.role === 'SELLER'}
        onSubmit={handleSubmit}
        submitLabel="Save changes"
      />
    </div>
  );
}
