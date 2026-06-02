import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { UrlImportForm } from '@/components/admin/UrlImportForm';

export const dynamic = 'force-dynamic';

export default async function ImportProductFromUrlPage() {
  await requireCapability('products:edit');

  const [categories, companies] = await Promise.all([
    prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, select: { slug: true, name: true } }),
    prisma.company.findMany({ orderBy: { name: 'asc' }, select: { slug: true, name: true } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/products"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground mb-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to products
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Import product from URL</h1>
        <p className="text-muted-foreground mt-1 max-w-2xl">
          Paste any product-page URL. The importer detects WooCommerce / Shopify / JSON-LD / OpenGraph automatically
          and falls back to AI extraction on the raw HTML for everything else. Result is a <strong>DRAFT</strong> —
          review and publish from the product list.
        </p>
      </div>
      <UrlImportForm categories={categories} companies={companies} />
    </div>
  );
}
