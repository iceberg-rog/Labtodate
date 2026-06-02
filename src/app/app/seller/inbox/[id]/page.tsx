import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { AutoRefresh } from '@/components/util/AutoRefresh';
import { QuoteThread } from '@/components/quotes/QuoteThread';

export const dynamic = 'force-dynamic';

export default async function SellerQuoteDetailPage({ params }: { params: { id: string } }) {
  const session = await requireSession({ roles: ['SELLER', 'ADMIN'], redirectTo: `/app/seller/inbox/${params.id}` });
  const role = (session.user as { role?: string }).role;
  const sellerIsAdmin = role === 'ADMIN';

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: params.id },
    include: {
      product: { select: { title: true, slug: true } },
      messages: {
        // Sellers should not see admin internal notes (admin chatter about
        // the seller). Admins see everything.
        where: sellerIsAdmin ? undefined : { isInternalNote: false },
        orderBy: { createdAt: 'asc' },
        include: { author: { select: { id: true, name: true, email: true } } },
      },
    },
  });
  if (!sr) notFound();

  if (sr.assignedToId !== session.user.id && role !== 'ADMIN') notFound();

  // Sellers never see who the buyer is — lab2date mediates. Admins (acting as
  // the mediator) still see the real buyer to coordinate.
  const isAdmin = role === 'ADMIN';
  const buyerName = isAdmin ? sr.buyerName : 'lab2date Buyer';
  const buyerEmail = isAdmin ? sr.buyerEmail : 'Hidden — reply here, lab2date relays it';

  return (
    <>
    <AutoRefresh />
    {sr.quotedPriceCents != null && (
      <div className="mb-5 rounded-2xl border-2 border-accent/40 bg-accent/[0.05] p-5 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">Quoted price (proforma sent)</p>
          <p className="text-2xl font-bold data mt-1">
            {(sr.quotedPriceCents / 100).toLocaleString()} {sr.quotedCurrency || 'EUR'}
          </p>
        </div>
        <a
          href={`/app/quotes/${sr.id}/proforma`}
          className="rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90"
        >
          View proforma
        </a>
      </div>
    )}
    <QuoteThread
      sourcingRequestId={sr.id}
      buyerName={buyerName}
      buyerEmail={buyerEmail}
      description={sr.description}
      status={sr.status}
      product={sr.product}
      messages={sr.messages.map((m) => ({
        id: m.id,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        authorName: m.author?.id === session.user.id ? 'You' : isAdmin ? (m.author?.name ?? null) : 'lab2date Buyer',
        authorEmail: isAdmin ? (m.author?.email ?? null) : null,
        isMine: m.author?.id === session.user.id,
      }))}
      viewerRole="SELLER"
      createdAt={sr.createdAt.toISOString()}
    />
    </>
  );
}
