import Link from 'next/link';
import {
  Inbox, MessageSquare, CheckCheck, XCircle, Archive, Clock, ArrowRight,
  Building2, MapPin, Package, Banknote, TrendingUp, Image as ImageIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { QuoteStatus, Prisma } from '@prisma/client';
import { AdminSearch, AdminPager } from '@/components/admin/AdminListControls';
import { computeSellState, sellToneClasses, type SellState } from '@/lib/sell/deal-state';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/**
 * Tab definitions mirror the Quote requests pattern: Open carves out the
 * stuff that needs operator attention; In review = waiting on the seller;
 * Accepted/Declined are the closed branches. The "All" tab is everything.
 */
const TAB_DEFS: Array<{
  key: string;
  label: string;
  matchesState?: (s: SellState) => boolean;
  statusFilter?: QuoteStatus[];
  extraWhere?: Prisma.SellSubmissionWhereInput;
}> = [
  {
    key: 'open',
    label: 'Open',
    statusFilter: ['PENDING'],
  },
  {
    key: 'in_review',
    label: 'In review',
    statusFilter: ['RESPONDED'],
  },
  {
    key: 'accepted',
    label: 'Accepted',
    statusFilter: ['ACCEPTED'],
  },
  {
    key: 'declined',
    label: 'Declined',
    statusFilter: ['DECLINED', 'CLOSED'],
  },
  { key: 'all', label: 'All' },
];

function smartDate(d: Date | null | undefined): string {
  if (!d) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400e3);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export default async function AdminSellPage({
  searchParams,
}: {
  searchParams: { tab?: string; q?: string; page?: string };
}) {
  await requireCapability('sell:view');

  const tab = TAB_DEFS.find((t) => t.key === searchParams.tab) ?? TAB_DEFS[0];
  const q = (searchParams.q ?? '').trim();
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);

  const where: Prisma.SellSubmissionWhereInput = {
    ...(tab.statusFilter ? { status: { in: tab.statusFilter } } : {}),
    ...(tab.extraWhere ?? {}),
    ...(q
      ? {
          OR: [
            { contactName: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
            { companyName: { contains: q, mode: 'insensitive' as const } },
            { brand: { contains: q, mode: 'insensitive' as const } },
            { model: { contains: q, mode: 'insensitive' as const } },
            { itemTitle: { contains: q, mode: 'insensitive' as const } },
            { description: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  // Per-tab counts so the chips show real numbers, not stale defaults.
  const tabCounts: Record<string, number> = {};
  for (const t of TAB_DEFS) {
    const w: Prisma.SellSubmissionWhereInput = {
      ...(t.statusFilter ? { status: { in: t.statusFilter } } : {}),
      ...(t.extraWhere ?? {}),
    };
    tabCounts[t.key] = await prisma.sellSubmission.count({ where: w });
  }

  const [total, subs] = await Promise.all([
    prisma.sellSubmission.count({ where }),
    prisma.sellSubmission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, itemTitle: true, brand: true, model: true, category: true,
        condition: true, quantity: true, askingPrice: true, sellerType: true,
        contactName: true, email: true, companyName: true, country: true,
        location: true, status: true, images: true, yearMade: true,
        createdAt: true, updatedAt: true,
        messages: {
          select: { fromStaff: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: { select: { messages: true } },
      },
    }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Acquisitions</h1>
        <p className="text-muted-foreground mt-1">
          Used &amp; surplus equipment offered to us by sellers. {total} {total === 1 ? 'offer' : 'offers'} · {tab.label.toLowerCase()}
          {q ? ` · matching "${q}"` : ''}
          {totalPages > 1 ? ` · page ${page}/${totalPages}` : ''}
        </p>
      </div>

      <AdminSearch basePath="/admin/sell" q={q} placeholder="Search seller, email, brand, model, item…" />

      <div className="flex gap-2 flex-wrap">
        {TAB_DEFS.map((t) => {
          const active = t.key === tab.key;
          return (
            <Link
              key={t.key}
              href={t.key === 'open' ? '/admin/sell' : `/admin/sell?tab=${t.key}`}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-semibold transition ${
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {t.label}
              <span className={`tabular-nums ${active ? 'opacity-80' : 'opacity-60'}`}>{tabCounts[t.key] ?? 0}</span>
            </Link>
          );
        })}
      </div>

      {subs.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 text-primary inline-flex items-center justify-center mb-4">
            <Inbox className="h-7 w-7" />
          </div>
          <p className="text-lg font-bold">Nothing in {tab.label.toLowerCase()}</p>
          <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
            New equipment offers from the public <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">Sell your equipment</code> page land here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {subs.map((s) => {
            const lastReplyByStaff = s.messages[0]?.fromStaff ?? false;
            const deal = computeSellState({
              status: s.status,
              lastReplyByStaff,
              messageCount: s._count.messages,
            });
            const t = sellToneClasses(deal.tone);
            const subtitle = [s.brand, s.model].filter(Boolean).join(' ') || s.category || s.sellerType.toLowerCase();
            const photo = s.images?.[0] ?? null;
            return (
              <li
                key={s.id}
                className={`relative rounded-2xl border border-border bg-card overflow-hidden transition-shadow hover:shadow-[0_10px_30px_-15px_rgba(15,79,64,0.25)]
                  before:content-[''] before:absolute before:inset-y-0 before:left-0 before:w-1 ${t.stripe}`}
              >
                <Link href={`/admin/sell/${s.id}`} className="block hover:bg-foreground/[0.02]">
                  <div className="pl-5 pr-5 py-4 grid grid-cols-[64px_minmax(0,1fr)_auto] gap-4 items-start">
                    {/* Photo (real seller-uploaded image) or fallback icon */}
                    <div className="h-16 w-16 rounded-xl bg-gradient-to-br from-[hsl(82_55%_95%)] to-[hsl(168_30%_94%)] border border-border flex items-center justify-center overflow-hidden flex-shrink-0">
                      {photo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={photo} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon className="h-6 w-6 text-muted-foreground" />
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          #{s.id.slice(-6).toUpperCase()}
                        </span>
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${t.pill}`}>
                          {deal.label}
                        </span>
                        {s.sellerType === 'COMPANY' && (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider rounded-full bg-violet-50 text-violet-800 border border-violet-200 px-1.5 py-0.5">
                            <Building2 className="h-3 w-3" /> company
                          </span>
                        )}
                        {s.images.length > 0 && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground" title={`${s.images.length} photo${s.images.length === 1 ? '' : 's'}`}>
                            <ImageIcon className="h-3 w-3" /> {s.images.length}
                          </span>
                        )}
                      </div>
                      <h3 className="font-bold text-[15px] leading-tight truncate">
                        {s.itemTitle}
                        {subtitle && <span className="text-muted-foreground font-normal text-[13px]"> · {subtitle}</span>}
                      </h3>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1.5 flex-wrap">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="h-5 w-5 rounded-full bg-primary/10 text-primary text-[9px] font-bold inline-flex items-center justify-center">
                            {initials(s.contactName)}
                          </span>
                          <span className="font-semibold text-foreground">{s.contactName}</span>
                        </span>
                        {s.companyName && (
                          <span className="inline-flex items-center gap-1">
                            <Building2 className="h-3 w-3" /> {s.companyName}
                          </span>
                        )}
                        {s.location && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3" /> {s.location}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1">
                          <Package className="h-3 w-3" /> ×{s.quantity} · {s.condition.toLowerCase()}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {smartDate(s.createdAt)}
                          {s._count.messages > 0 && <> · {s._count.messages} msg{s._count.messages === 1 ? '' : 's'}</>}
                        </span>
                      </div>
                    </div>

                    <div className="text-right flex flex-col items-end gap-1 flex-shrink-0">
                      {s.askingPrice ? (
                        <p className="text-base font-bold tabular-nums leading-none inline-flex items-center gap-1.5">
                          <Banknote className="h-4 w-4 text-emerald-600" />{s.askingPrice}
                        </p>
                      ) : (
                        <p className="text-xs text-muted-foreground italic">no asking price</p>
                      )}
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {s.yearMade ? `made ${s.yearMade}` : s.sellerType.toLowerCase()}
                      </p>
                    </div>
                  </div>
                  <div className="border-t border-border bg-foreground/[0.015] px-5 py-2 flex items-center justify-end gap-3">
                    <span className="text-xs font-semibold text-primary inline-flex items-center gap-1">
                      Open <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <AdminPager basePath="/admin/sell" page={page} totalPages={totalPages} total={total} q={q} tab={tab.key !== 'open' ? tab.key : undefined} />
    </div>
  );
}
