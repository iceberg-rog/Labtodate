import Link from 'next/link';
import { MailX, CheckCircle2 } from 'lucide-react';
import { verifyUnsubscribeToken } from '@/lib/security/marketing';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Unsubscribe', robots: { index: false } };

function mask(email: string): string {
  const [n, d] = email.split('@');
  return `${n.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, n.length - 2)))}@${d}`;
}

/** Landing page of the unsubscribe link in marketing e-mails (no sign-in needed). */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ t?: string; done?: string; error?: string }> }) {
  const sp = await searchParams;
  const target = verifyUnsubscribeToken(sp.t);
  const site = process.env.SITE_NAME || 'Labtodate';
  const suppressed = target
    ? !!(await prisma.emailSuppression.findUnique({ where: { email_scope: { email: target.email, scope: target.scope } } }))
    : false;

  return (
    <div className="container-px py-16 flex justify-center">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-sm space-y-4" data-testid="unsubscribe-card">
        {!target || sp.error ? (
          <>
            <h1 className="text-xl font-bold">This unsubscribe link is not valid</h1>
            <p className="text-sm text-muted-foreground">
              It may be incomplete. Sign in and change your choice under{' '}
              <Link href="/app/email-preferences" className="underline">E-mail preferences</Link>.
            </p>
          </>
        ) : sp.done || suppressed ? (
          <>
            <h1 className="text-xl font-bold inline-flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" /> You are unsubscribed
            </h1>
            <p className="text-sm text-muted-foreground">
              {mask(target.email)} will no longer receive offers or news from {site}. Messages about your own orders, quotes
              and account still arrive.
            </p>
            <p className="text-xs text-muted-foreground">
              Changed your mind? Sign in and switch it back on under <Link href="/app/email-preferences" className="underline">E-mail preferences</Link>.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold inline-flex items-center gap-2">
              <MailX className="h-5 w-5 text-primary" /> Unsubscribe from offers and news
            </h1>
            <p className="text-sm text-muted-foreground">
              Stop marketing e-mail from {site} to <strong className="text-foreground">{mask(target.email)}</strong>. Messages
              about your own orders, quotes and account are not affected.
            </p>
            <form method="post" action={`/api/email/unsubscribe?t=${encodeURIComponent(sp.t ?? '')}`}>
              <button type="submit" className="w-full h-10 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
                Unsubscribe
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
