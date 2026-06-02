import Link from 'next/link';
import { Banknote, ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

const PILL: Record<string, { variant: 'success' | 'warning' | 'accent' | 'secondary'; label: string }> = {
  PENDING: { variant: 'warning', label: 'Under review' },
  RESPONDED: { variant: 'accent', label: 'We replied' },
  ACCEPTED: { variant: 'success', label: 'Accepted' },
  DECLINED: { variant: 'secondary', label: 'Declined' },
  CLOSED: { variant: 'secondary', label: 'Closed' },
};

export default async function MySellSubmissionsPage() {
  const session = await requireSession({ redirectTo: '/app/sell-submissions' });

  const subs = await prisma.sellSubmission.findMany({
    where: {
      OR: [{ submittedById: session.user.id }, { email: session.user.email }],
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, itemTitle: true, status: true, createdAt: true, brand: true, model: true },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My equipment offers</h1>
        <p className="text-muted-foreground mt-1">Equipment you submitted to lab2date.</p>
      </div>

      {subs.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <Banknote className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No submissions yet</p>
          <p className="text-sm text-muted-foreground mt-2">
            Got idle equipment? Submit it and our acquisitions team will value it.
          </p>
          <Link
            href="/sell"
            className="inline-flex items-center gap-1 mt-5 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90"
          >
            Sell your equipment <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      ) : (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
          {subs.map((s) => {
            const pill = PILL[s.status] ?? { variant: 'secondary' as const, label: s.status.toLowerCase() };
            return (
              <li key={s.id}>
                <Link
                  href={`/app/sell-submissions/${s.id}`}
                  className="flex items-center gap-4 p-5 hover:bg-foreground/5 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                      {[s.brand, s.model].filter(Boolean).join(' ') || 'Equipment'}
                    </p>
                    <p className="font-semibold truncate">{s.itemTitle}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Submitted {new Date(s.createdAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                    </p>
                  </div>
                  <Badge variant={pill.variant}>{pill.label}</Badge>
                  <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
