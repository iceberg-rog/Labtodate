import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import type { ReportItem } from '@/lib/marketplace/woo-sync';
import { formatPrice } from '@/lib/utils';
import { getConditionGrades } from '@/lib/catalog/policy';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sync report' };

const ACTIONS = ['CREATED', 'UPDATED', 'ARCHIVED', 'REMOVED_AT_SOURCE', 'FAILED', 'UNCHANGED'] as const;
const ACTION_LABEL: Record<string, string> = {
  CREATED: 'New',
  UPDATED: 'Updated',
  ARCHIVED: 'Archived (removed at source)',
  REMOVED_AT_SOURCE: 'Removed at source',
  FAILED: 'Failed',
  UNCHANGED: 'Unchanged',
};
const PAGE = 300;
const FIELD_LABEL: Record<string, string> = {
  priceCents: 'Price',
  currency: 'Currency',
  mode: 'Buying mode',
  quantity: 'Available',
  status: 'Status',
  condition: 'Condition',
  title: 'Title',
  summary: 'Summary',
  description: 'Description',
  images: 'Photos',
  sourceImageUrls: 'Source photo list',
  sourceAvailability: 'Source says',
  sourceUrl: 'Source URL',
  sourceSlug: 'Source slug',
  externalId: 'Source item id',
  externalSource: 'Source type',
  removedAtSourceAt: 'Removed at source',
  sku: 'SKU',
  mpn: 'MPN',
  brand: 'Brand',
  category: 'Category',
  pendingPriceCents: 'Price waiting for your review',
  pendingPriceCurrency: 'Currency waiting for review',
  priceOnHold: 'Not buyable until reviewed',
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  // Dates are stored as ISO UTC strings: shown in Dutch time, readable.
  if (typeof v === 'string' && ISO_RE.test(v)) {
    return new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
  }
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

const STATUS_LABEL: Record<string, string> = { PUBLISHED: 'Published', PENDING_REVIEW: 'Pending review', DRAFT: 'Draft', ARCHIVED: 'Archived' };
const MODE_LABEL: Record<string, string> = { BUY_NOW: 'Buy now', HYBRID: 'Buy now or quote', QUOTE_ONLY: 'Quote only' };
const AVAILABILITY_LABEL: Record<string, string> = { instock: 'In stock', outofstock: 'Out of stock', onbackorder: 'On backorder', removed: 'Removed' };

/** Prices with their currency (the item's), labels instead of codes. */
function showField(field: string, v: unknown, currency: string, conditionLabels: Record<string, string>): string {
  if ((field === 'priceCents' || field === 'pendingPriceCents') && typeof v === 'number') return formatPrice(v, currency || 'EUR');
  if (typeof v === 'string') {
    if (field === 'status' && STATUS_LABEL[v]) return STATUS_LABEL[v];
    if (field === 'mode' && MODE_LABEL[v]) return MODE_LABEL[v];
    if (field === 'condition' && conditionLabels[v]) return conditionLabels[v];
    if (field === 'sourceAvailability' && AVAILABILITY_LABEL[v]) return AVAILABILITY_LABEL[v];
  }
  return show(v);
}

export default async function SyncRunPage(props: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ action?: string; page?: string }>;
}) {
  await requireCapability('companies:manage');
  const { slug, id } = await props.params;
  const sp = await props.searchParams;
  const run = await prisma.importRun.findUnique({ where: { id }, include: { company: { select: { slug: true, name: true } } } });
  if (!run || run.company.slug !== slug) notFound();
  const items = (run.items ?? []) as unknown as ReportItem[];
  const grades = await getConditionGrades();
  const conditionLabels: Record<string, string> = Object.fromEntries(Object.entries(grades).map(([k, g]) => [k, g.label]));
  const counts = (run.counts ?? {}) as Record<string, unknown>;
  const warnings = Array.isArray(counts.warnings) ? (counts.warnings as string[]) : [];
  const requested = sp.action ?? '';
  const filter =
    requested === 'ALL' || requested === 'CHANGED' || (ACTIONS as readonly string[]).includes(requested)
      ? requested
      : 'CHANGED';
  // "Changes & notes": every item the run changed, plus unchanged items that
  // carry something the owner should see (a locked field kept, a status kept…).
  const noteworthy = (i: ReportItem) => i.action !== 'UNCHANGED' || !!i.notes?.length || !!i.review?.length || !!i.skipped?.some((x) => x.reason === 'locked');
  const filtered = items.filter((i) => (filter === 'ALL' ? true : filter === 'CHANGED' ? noteworthy(i) : i.action === filter));
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);
  const shown = filtered.slice((page - 1) * PAGE, page * PAGE);
  const byAction: Record<string, number> = Object.fromEntries(ACTIONS.map((a) => [a, items.filter((i) => i.action === a).length]));
  const qs = (a: string, p = 1) => `?action=${a}${p > 1 ? `&page=${p}` : ''}`;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <Link href={`/admin/companies/${slug}`} className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to {run.company.name}
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">
          {run.dryRun ? 'Dry run' : 'Sync'} report · {run.company.name}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {run.startedAt.toLocaleString('en-GB')} · {run.trigger.toLowerCase()}
          {run.actorEmail ? ` by ${run.actorEmail}` : ''} ·{' '}
          <strong className={run.status === 'SUCCEEDED' ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'}>{run.status}</strong>
          {run.dryRun && ' · nothing was changed by this run'}
          {typeof counts.sourceProducts === 'number' ? ` · ${counts.sourceProducts} products at the source` : ''}
        </p>
      </div>
      {run.error && (
        <p className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300 px-4 py-3 text-sm">{run.error}</p>
      )}
      {warnings.map((w) => (
        <p key={w} className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 px-4 py-3 text-sm">
          {w}
        </p>
      ))}

      <nav className="flex flex-wrap gap-2 text-xs" data-testid="run-filters">
        {['CHANGED', 'ALL', ...ACTIONS].map((a) => {
          const n = a === 'ALL' ? items.length : a === 'CHANGED' ? items.filter(noteworthy).length : byAction[a];
          return (
            <Link
              key={a}
              href={qs(a)}
              className={`px-3 py-1.5 rounded-full border font-semibold ${filter === a ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-foreground/[0.03]'}`}
            >
              {a === 'ALL' ? 'All' : a === 'CHANGED' ? 'Changes & notes' : ACTION_LABEL[a]} · {n}
            </Link>
          );
        })}
      </nav>

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in this group.</p>
      ) : (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border" data-testid="run-items">
          {shown.map((i, k) => (
            <li key={`${i.externalId}-${i.slug}-${k}`} className="p-4 space-y-1.5 text-sm" data-action={i.action}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-foreground/10">{ACTION_LABEL[i.action] ?? i.action}</span>
                {i.productId ? (
                  <Link href={`/admin/products/${i.slug}`} className="font-semibold hover:text-primary">
                    {i.title ?? i.slug}
                  </Link>
                ) : (
                  <span className="font-semibold">{i.title ?? i.slug}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  {i.slug}
                  {i.externalId ? ` · source #${i.externalId}` : ''}
                </span>
              </div>
              {i.changes && i.changes.length > 0 && (
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  {i.changes.map((c, j) => (
                    <li key={j}>
                      <span className="font-semibold text-foreground">{FIELD_LABEL[c.field] ?? c.field}</span>: {showField(c.field, c.from, i.currency ?? 'EUR', conditionLabels)} → {showField(c.field, c.to, i.currency ?? 'EUR', conditionLabels)}
                    </li>
                  ))}
                </ul>
              )}
              {i.skipped && i.skipped.length > 0 && (
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  Kept yours:{' '}
                  {i.skipped
                    .map((s) => `${(FIELD_LABEL[s.field] ?? s.field).toLowerCase()} (${s.reason === 'locked' ? 'locked' : s.reason === 'policy' ? 'shop policy' : 'source has no name'})`)
                    .join(', ')}
                </p>
              )}
              {i.review && i.review.length > 0 && (
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-300" data-testid="run-item-review">
                  Needs review: {i.review.join('; ')}.
                </p>
              )}
              {i.notes?.map((n) => (
                <p key={n} className={`text-xs ${/held for review|waiting for price review/i.test(n) ? 'font-semibold text-amber-800 dark:text-amber-300' : 'text-muted-foreground'}`}>
                  {n}
                </p>
              ))}
              {i.error && <p className="text-xs text-red-700 dark:text-red-300">{i.error}</p>}
            </li>
          ))}
        </ul>
      )}
      {filtered.length > PAGE && (
        <div className="flex gap-3 text-sm">
          {page > 1 && (
            <Link href={qs(filter, page - 1)} className="text-primary font-semibold">
              ← Previous
            </Link>
          )}
          <span className="text-muted-foreground">
            Page {page} of {Math.ceil(filtered.length / PAGE)}
          </span>
          {page * PAGE < filtered.length && (
            <Link href={qs(filter, page + 1)} className="text-primary font-semibold">
              Next →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
