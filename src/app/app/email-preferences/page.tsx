import { Mail, CheckCircle2 } from 'lucide-react';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { marketingStatus } from '@/lib/security/marketing';
import { MarketingToggle } from './MarketingToggle';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'E-mail preferences' };

const fmt = (d: Date) => d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' });

export default async function EmailPreferencesPage() {
  const session = await requireSession({ redirectTo: '/app/email-preferences' });
  const status = await marketingStatus(session.user.id);
  const history = await prisma.consentEvent.findMany({
    where: { OR: [{ userId: session.user.id }, { email: session.user.email.toLowerCase() }], kind: 'MARKETING_EMAIL' },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  const site = process.env.SITE_NAME || 'Labtodate';

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <Mail className="h-7 w-7 text-primary" /> E-mail preferences
        </h1>
        <p className="text-muted-foreground mt-1">Choose which e-mails {site} sends to {session.user.email}.</p>
      </div>

      <section className="rounded-2xl border border-border bg-card p-5 space-y-2">
        <h2 className="font-bold">Always sent (needed for your orders and account)</h2>
        <ul className="text-sm text-muted-foreground space-y-1">
          {[
            'Sign-in codes, password resets and security notices',
            'Quotes and offers you asked for, order confirmations, proformas and invoices',
            'Payment, shipping and delivery updates',
            'Replies to your support tickets and messages',
          ].map((l) => (
            <li key={l} className="inline-flex items-start gap-2 w-full">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" /> {l}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5 space-y-3" data-testid="marketing-pref">
        <h2 className="font-bold">Offers and news</h2>
        <p className="text-sm text-muted-foreground">
          New stock, special offers and company news — at most a few times a month. You can stop them at any time (every such
          e-mail has an unsubscribe link).
        </p>
        <MarketingToggle receiving={status.receiving} />
        <p className="text-xs text-muted-foreground">
          {status.basis === 'opted-in' && 'You asked to receive these.'}
          {status.basis === 'customer' &&
            'You receive these because you bought from us (Dutch “soft opt-in” for existing customers). Switch it off if you don’t want them.'}
          {status.basis === 'unsubscribed' && 'You unsubscribed.'}
          {status.basis === 'none' && 'You don’t receive these.'}
        </p>
        {history.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">History of your choices</summary>
            <ul className="mt-2 space-y-0.5">
              {history.map((h) => (
                <li key={h.id}>
                  {fmt(h.createdAt)} — {h.action === 'GRANTED' ? 'subscribed' : 'unsubscribed'} ({h.source})
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
