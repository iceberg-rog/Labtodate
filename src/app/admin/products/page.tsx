import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ProductStatus, Prisma } from '@prisma/client';
import { ProductBrowser, type ProductRow } from '@/components/admin/ProductQuickEdit';
import { AdminSearch, AdminPager } from '@/components/admin/AdminListControls';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 60;

export default async function AdminProductsPage(
  props: {
    searchParams: Promise<{ status?: string; q?: string; page?: string; category?: string; qty?: string; shop?: string; created?: string; deleted?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireCapability('products:view');

  const status = searchParams.status as ProductStatus | undefined;
  const q = (searchParams.q ?? '').trim();
  const categorySlug = (searchParams.category ?? '').trim();
  const shopSlug = (searchParams.shop ?? '').trim();          // '' | 'own' | <company slug>
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const qtyFilter = (searchParams.qty ?? '').trim(); // 'lastcopy' | 'oos' | ''

  const qtyWhere: Prisma.ProductWhereInput['quantity'] =
    qtyFilter === 'lastcopy' ? { equals: 1 } : qtyFilter === 'oos' ? { equals: 0 } : undefined;

  const shopWhere: Prisma.ProductWhereInput =
    shopSlug === 'own'
      ? { companyId: null }
      : shopSlug
        ? { company: { slug: shopSlug } }
        : {};

  const where: Prisma.ProductWhereInput = {
    ...(status ? { status } : {}),
    ...(qtyWhere ? { quantity: qtyWhere } : {}),
    ...(categorySlug ? { category: { slug: categorySlug } } : {}),
    ...shopWhere,
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: 'insensitive' } },
            { slug: { contains: q, mode: 'insensitive' } },
            { brand: { name: { contains: q, mode: 'insensitive' } } },
            { category: { name: { contains: q, mode: 'insensitive' } } },
            { seller: { name: { contains: q, mode: 'insensitive' } } },
            { seller: { email: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [total, products, categories, statusCounts, shopCounts, ownCount] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: [{ category: { name: 'asc' } }, { updatedAt: 'desc' }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        brand: { select: { name: true } },
        category: { select: { name: true, slug: true } },
        seller: { select: { name: true, email: true } },
        company: { select: { name: true, slug: true } },
      },
    }),
    prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: { slug: true, name: true, _count: { select: { products: true } } },
    }),
    prisma.product.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.company.findMany({
      orderBy: { name: 'asc' },
      select: { slug: true, name: true, _count: { select: { products: true } } },
    }),
    prisma.product.count({ where: { companyId: null } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows: ProductRow[] = products.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    brand: p.brand?.name ?? null,
    category: p.category.name,
    condition: p.condition,
    status: p.status,
    priceCents: p.priceCents,
    currency: p.currency,
    quantity: p.quantity,
    seller: { name: p.seller.name, email: p.seller.email },
    shop: p.company ? { name: p.company.name, slug: p.company.slug } : null,
    image: p.images[0] ?? null,
  }));

  const counts: Record<string, number> = {};
  for (const s of statusCounts) counts[s.status] = s._count._all;

  const baseHref = (overrides: Partial<{ status?: string; category?: string; q?: string; shop?: string }>) => {
    const sp = new URLSearchParams();
    const next = {
      status: overrides.status !== undefined ? overrides.status : status,
      category: overrides.category !== undefined ? overrides.category : categorySlug,
      q: overrides.q !== undefined ? overrides.q : q,
      shop: overrides.shop !== undefined ? overrides.shop : shopSlug,
    };
    if (next.status) sp.set('status', next.status);
    if (next.category) sp.set('category', next.category);
    if (next.q) sp.set('q', next.q);
    if (next.shop) sp.set('shop', next.shop);
    const s = sp.toString();
    return s ? `/admin/products?${s}` : '/admin/products';
  };

  return (
    <div className="space-y-6">
      {(searchParams.created || searchParams.deleted) && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-sm font-medium">
          {searchParams.created ? `✓ Product created — slug ${searchParams.created}.` : '✓ Product deleted.'}
        </div>
      )}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Products</h1>
          <p className="text-muted-foreground mt-1">
            {total} listing{total === 1 ? '' : 's'}
            {status ? ` · ${status.replace('_', ' ').toLowerCase()}` : ''}
            {qtyFilter === 'lastcopy' ? ' · last-copy (qty = 1)' : qtyFilter === 'oos' ? ' · sold out' : ''}
            {categorySlug ? ` · ${categories.find((c) => c.slug === categorySlug)?.name ?? categorySlug}` : ''}
            {shopSlug === 'own' ? ' · lab2date own inventory' : shopSlug ? ` · ${shopCounts.find((s) => s.slug === shopSlug)?.name ?? shopSlug}` : ''}
            {q ? ` · matching “${q}”` : ''}
            {totalPages > 1 ? ` · page ${page}/${totalPages}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button asChild variant="outline" size="sm" className="rounded-full font-semibold">
            <Link href="/admin/companies">Manage shops</Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="rounded-full font-semibold">
            <Link href="/admin/brands">Manage brands</Link>
          </Button>
          <Button asChild variant="outline" size="sm" className="rounded-full font-semibold">
            <Link href="/admin/products/import-url">Import from URL</Link>
          </Button>
          <Button asChild size="sm" className="rounded-full font-semibold">
            <Link href="/admin/products/new">+ Add product</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <CountPill label="Total" value={products.length === 0 && Object.keys(counts).length === 0 ? '0' : String(Object.values(counts).reduce((a, b) => a + b, 0))} href={baseHref({ status: '' })} active={!status} />
        <CountPill label="Pending review" value={String(counts['PENDING_REVIEW'] ?? 0)} href={baseHref({ status: 'PENDING_REVIEW' })} active={status === 'PENDING_REVIEW'} accent="amber" />
        <CountPill label="Published" value={String(counts['PUBLISHED'] ?? 0)} href={baseHref({ status: 'PUBLISHED' })} active={status === 'PUBLISHED'} accent="emerald" />
        <CountPill label="Draft" value={String(counts['DRAFT'] ?? 0)} href={baseHref({ status: 'DRAFT' })} active={status === 'DRAFT'} />
        <CountPill label="Archived" value={String(counts['ARCHIVED'] ?? 0)} href={baseHref({ status: 'ARCHIVED' })} active={status === 'ARCHIVED'} />
      </div>

      <AdminSearch basePath="/admin/products" q={q} status={status} placeholder="Search title, brand, category, slug, seller…" />

      <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mr-1 min-w-[64px]">Source</span>
          <Link
            href={baseHref({ shop: '' })}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
              !shopSlug ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-foreground hover:bg-foreground/10'
            }`}
          >
            All sources <span className="opacity-60 ml-1 tabular-nums">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
          </Link>
          <Link
            href={baseHref({ shop: 'own' })}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
              shopSlug === 'own' ? 'bg-primary text-primary-foreground' : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100 ring-1 ring-emerald-200'
            }`}
          >
            ★ lab2date own <span className="opacity-60 ml-1 tabular-nums">{ownCount}</span>
          </Link>
          {shopCounts.filter((s) => s._count.products > 0).map((s) => (
            <Link
              key={s.slug}
              href={baseHref({ shop: s.slug })}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                shopSlug === s.slug ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-foreground hover:bg-foreground/10'
              }`}
            >
              {s.name} <span className="opacity-60 ml-1 tabular-nums">{s._count.products}</span>
            </Link>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mr-1 min-w-[64px]">Category</span>
          <Link
            href={baseHref({ category: '' })}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
              !categorySlug ? 'bg-primary text-primary-foreground' : 'bg-foreground/5 text-foreground hover:bg-foreground/10'
            }`}
          >
            All
          </Link>
          {categories.map((c) => (
            <Link
              key={c.slug}
              href={baseHref({ category: c.slug })}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                categorySlug === c.slug
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-foreground/5 text-foreground hover:bg-foreground/10'
              }`}
            >
              {c.name} <span className="opacity-60 ml-1 tabular-nums">{c._count.products}</span>
            </Link>
          ))}
        </div>
      </div>

      <ProductBrowser rows={rows} />

      <AdminPager
        basePath="/admin/products"
        page={page}
        totalPages={totalPages}
        total={total}
        q={q}
        status={status}
      />
      <p className="text-[11px] text-muted-foreground -mt-2">
        Click any product card to open the quick-edit popup — change price, stock, or status without leaving this page.
      </p>
    </div>
  );
}

function CountPill({
  label,
  value,
  href,
  active,
  accent,
}: {
  label: string;
  value: string;
  href: string;
  active: boolean;
  accent?: 'amber' | 'emerald';
}) {
  const tint =
    accent === 'amber'
      ? 'text-amber-700'
      : accent === 'emerald'
        ? 'text-emerald-700'
        : 'text-foreground';
  return (
    <Link
      href={href}
      className={`rounded-2xl border p-4 transition-colors ${
        active
          ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
          : 'border-border bg-card hover:bg-foreground/[0.03]'
      }`}
    >
      <p className={`text-2xl font-bold tabular-nums ${tint}`}>{value}</p>
      <p className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground mt-0.5">
        {label}
      </p>
    </Link>
  );
}
