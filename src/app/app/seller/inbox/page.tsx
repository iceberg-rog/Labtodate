import Link from 'next/link';
import { FileText, ArrowRight } from 'lucide-react';
import { requireSession, hasCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { computeDealState } from '@/lib/quotes/deal-state';
import { DealStateBadge } from '@/components/quotes/DealStateBadge';
import { sellerSeesSellPrice } from '@/lib/quotes/policy';
import { ensureSettingsLoaded } from '@/lib/settings';
import { formatPrice } from '@/lib/utils';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Quote inbox' };

export default async function SellerInboxPage() {
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: '/app/seller/inbox' });
  const role = (session.user as { role?: string }).role;
  // Staff see other people's quotes / offers only with the permission for them (A31).
  const staffView = role === 'ADMIN' && (await hasCapability('quotes:view'));
  await ensureSettingsLoaded();

  const items = await prisma.sourcingRequest.findMany({
    where: staffView ? {} : { assignedToId: session.user.id },
    orderBy: { updatedAt: 'desc' },
    include: {
      product: { select: { title: true } },
      // Last customer-visible message: who wrote last decides whose move it is.
      messages: {
        where: { isInternalNote: false },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { fromStaff: true },
      },
    },
  });

  const linked = items.length
    ? await prisma.order.findMany({
        where: { sourcingRequestId: { in: items.map((q) => q.id) } },
        select: { sourcingRequestId: true, status: true, paymentSubmittedAt: true },
      })
    : [];
  const orderByQuote = new Map(linked.map((o) => [o.sourcingRequestId!, o]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Quote inbox</h1>
        <p className="text-muted-foreground mt-1">
          {staffView ? 'All sourcing requests across the platform.' : 'Quote requests routed to you.'}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <FileText className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No incoming requests</p>
          <p className="text-sm text-muted-foreground mt-2">Quote requests from buyers will appear here.</p>
        </div>
      ) : (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
          {items.map((q) => (
            <li key={q.id}>
              <Link href={`/app/seller/inbox/${q.id}`} className="p-5 flex items-center gap-4 hover:bg-foreground/5 transition-colors">
                <div className="flex-1 min-w-0">
                  {/* Sellers never see who the buyer is — lab2date mediates (same
                      rule as the detail page). Admins see the real buyer. */}
                  <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 truncate">
                    {staffView ? `${q.buyerName} · ${q.buyerEmail}` : 'lab2date Buyer'}
                  </p>
                  <p dir="auto" className="font-semibold truncate">
                    {q.product?.title ?? q.productCategory ?? 'General sourcing request'}
                  </p>
                  <p dir="auto" className="text-sm text-muted-foreground line-clamp-1 mt-1">{q.description}</p>
                </div>
                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                  <DealStateBadge
                    size="sm"
                    badge={computeDealState({
                      status: q.status,
                      // Who wrote last decides whose move it is.
                      lastReplyByStaff: q.messages[0] ? q.messages[0].fromStaff : q.lastReplyByStaff,
                      proformaNumber: q.proformaNumber,
                      quotedPriceCents: q.quotedPriceCents,
                      validUntilAt: q.validUntilAt,
                      linkedOrder: orderByQuote.get(q.id) ?? null,
                    }, 'staff')}
                  />
                  {/* Suppliers see their own proposal, not lab2date's buyer price (SELLER_SEES_SELL_PRICE). */}
                  {staffView || sellerSeesSellPrice()
                    ? q.quotedPriceCents != null && <p className="text-sm font-bold tabular-nums">{formatPrice(q.offerTotalCents ?? q.offerSubtotalCents ?? q.quotedPriceCents, q.quotedCurrency ?? 'EUR')}{q.offerTotalCents == null ? ' excl. VAT' : ''}</p>
                    : q.sellerProposalCents != null && <p className="text-sm font-bold tabular-nums">Your price {formatPrice(q.sellerProposalCents, q.sellerProposalCurrency ?? 'EUR')}</p>}
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {new Date(q.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
