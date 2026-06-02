import Link from 'next/link';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AdminSearch, AdminPager } from '@/components/admin/AdminListControls';
import { CreateShopButton } from '@/components/admin/CreateShopButton';
import { AiSuggestShopsButton } from '@/components/admin/AiSuggestShopsButton';
import { CompaniesBoard, type ShopRow } from '@/components/admin/CompaniesBoard';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function AdminCompaniesPage({
  searchParams,
}: {
  searchParams: { q?: string; page?: string; created?: string; imported?: string };
}) {
  await requireCapability('companies:manage');
  const q = (searchParams.q ?? '').trim();
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const where = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' as const } },
          { country: { contains: q, mode: 'insensitive' as const } },
          { slug: { contains: q, mode: 'insensitive' as const } },
        ],
      }
    : {};
  const [total, companies] = await Promise.all([
    prisma.company.count({ where }),
    prisma.company.findMany({
      where,
      orderBy: { name: 'asc' },
      select: {
        id: true, slug: true, name: true, country: true, isVerified: true, isFeatured: true,
        importSourceUrl: true, lastImportedAt: true,
        pricingMode: true, pricingMarkupBp: true,
        suggestedByAi: true, aiRiskScore: true, aiRiskNotes: true, aiAnalyzedAt: true,
        _count: { select: { products: true, users: true } },
      },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const shops: ShopRow[] = companies.map((co) => ({
    id: co.id,
    slug: co.slug,
    name: co.name,
    country: co.country,
    isVerified: co.isVerified,
    isFeatured: co.isFeatured,
    productCount: co._count.products,
    userCount: co._count.users,
    importSourceUrl: co.importSourceUrl,
    lastImportedAt: co.lastImportedAt ? co.lastImportedAt.toISOString() : null,
    pricingMode: co.pricingMode,
    pricingMarkupBp: co.pricingMarkupBp,
    suggestedByAi: co.suggestedByAi,
    aiRiskScore: co.aiRiskScore,
    aiRiskNotes: co.aiRiskNotes,
    aiAnalyzedAt: co.aiAnalyzedAt ? co.aiAnalyzedAt.toISOString() : null,
  }));

  // Compute summary buckets using the SAME predicate as CompaniesBoard so
  // numbers always agree with the list rendered below.
  const importedCount = shops.filter((s) => s.lastImportedAt || s.productCount > 0).length;
  const suggestedCount = shops.filter((s) => s.suggestedByAi && s.productCount === 0 && !s.lastImportedAt).length;
  const manualCount = shops.filter((s) => !s.lastImportedAt && s.productCount === 0 && !s.suggestedByAi).length;
  const totalProducts = shops.reduce((a, s) => a + s.productCount, 0);

  return (
    <div className="space-y-6">
      {(searchParams.created || searchParams.imported) && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-sm font-medium">
          {searchParams.created
            ? `✓ Shop “${searchParams.created}” added.`
            : `✓ Imported ${searchParams.imported} product${searchParams.imported === '1' ? '' : 's'}.`}
        </div>
      )}

      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Shops & suppliers</h1>
          <p className="text-muted-foreground mt-1">
            {total} shop{total === 1 ? '' : 's'} · {totalProducts} products imported
            {q ? ` · matching “${q}”` : ''}
            {totalPages > 1 ? ` · page ${page}/${totalPages}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <AiSuggestShopsButton />
          <CreateShopButton />
        </div>
      </div>

      {/* State summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="Total shops" value={total} tone="default" />
        <SummaryCard label="Imported" value={importedCount} tone="emerald" />
        <SummaryCard label="AI suggested" value={suggestedCount} tone="purple" />
        <SummaryCard label="Manual / empty" value={manualCount} tone="muted" />
      </div>

      <AdminSearch basePath="/admin/companies" q={q} placeholder="Search company, country, slug…" />

      <CompaniesBoard shops={shops} />

      <AdminPager basePath="/admin/companies" page={page} totalPages={totalPages} total={total} q={q} />

      <div className="text-[11px] text-muted-foreground -mt-2">
        Click any shop card to open the preview drawer — current catalogue, live source preview, and AI risk analysis.
      </div>

      {/* Hidden link so /admin/companies search params can be referenced */}
      <Link href="/admin/companies" className="sr-only">refresh</Link>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: 'default' | 'emerald' | 'purple' | 'muted' }) {
  const t =
    tone === 'emerald' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' :
    tone === 'purple'  ? 'border-purple-200 bg-purple-50 text-purple-900' :
    tone === 'muted'   ? 'border-border bg-foreground/[0.02] text-muted-foreground' :
                         'border-border bg-card';
  return (
    <div className={`rounded-2xl border p-4 ${t}`}>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-[11px] uppercase tracking-wider font-bold mt-0.5">{label}</p>
    </div>
  );
}
