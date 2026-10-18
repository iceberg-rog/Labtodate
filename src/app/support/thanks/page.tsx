import Link from 'next/link';
import { CheckCircle2, LifeBuoy, Mail, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getServerSession } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { legalIdentity } from '@/lib/brand/identity';
import { supportReplyPromise } from '@/lib/support/policy';

export const metadata = { title: 'Ticket received' };
export const dynamic = 'force-dynamic';

/**
 * After a new ticket. `mail=0` means the confirmation e-mail could not be
 * sent (throttled, blocked or failed): then the page says so and asks the
 * customer to keep the reference instead of promising a link in their inbox.
 */
export default async function SupportThanksPage(props: { searchParams: Promise<{ ref?: string; mail?: string }> }) {
  const searchParams = await props.searchParams;
  const session = await getServerSession();
  await ensureSettingsLoaded();
  const signedIn = !!session?.user;
  const ref = /^TKT-[A-Z0-9-]{4,20}$/i.test(searchParams.ref ?? '') ? searchParams.ref!.toUpperCase() : '';
  const mailed = searchParams.mail !== '0';
  const promise = supportReplyPromise();
  const supportEmail = legalIdentity().supportEmail;

  return (
    <div className="container-px py-20 max-w-xl mx-auto text-center">
      <div className="mx-auto h-16 w-16 rounded-full bg-accent/15 flex items-center justify-center mb-6">
        <CheckCircle2 className="h-8 w-8 text-primary" />
      </div>
      <h1 className="text-4xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }}>
        Ticket received.
      </h1>

      {ref && (
        <p className="mt-4 text-sm">
          Reference: <span className="font-mono font-semibold">{ref}</span>
        </p>
      )}

      <p className="mt-3 text-muted-foreground">
        {signedIn
          ? `${promise ? `Our team replies within ${promise}. ` : ''}You can follow the conversation right from your account.`
          : mailed
          ? 'Check your inbox — we sent a confirmation with a private link so you can read replies and follow up without signing up.'
          : 'We could not send the confirmation e-mail just now, so please note your reference. Our reply will come by e-mail with a private link to follow up.'}
      </p>
      {!signedIn && !mailed && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="ack-not-sent">
          Nothing arrived after a while? {supportEmail
            ? <>Write to <a href={`mailto:${supportEmail}`} className="text-primary font-semibold hover:underline">{supportEmail}</a> and mention {ref || 'your reference'}.</>
            : <>Open a new ticket and mention {ref || 'your reference'}.</>}
        </p>
      )}

      <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
        {signedIn ? (
          <>
            <Button asChild size="lg" className="rounded-2xl font-semibold">
              <Link href={ref ? `/app/support?open=${encodeURIComponent(ref)}` : '/app/support'}>
                <LifeBuoy className="h-4 w-4" /> View my tickets
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="rounded-2xl font-semibold">
              <Link href="/support">
                <Plus className="h-4 w-4" /> Open another
              </Link>
            </Button>
          </>
        ) : (
          <>
            {mailed && (
              <Button asChild size="lg" className="rounded-2xl font-semibold">
                <Link href="/">
                  <Mail className="h-4 w-4" /> Check your email
                </Link>
              </Button>
            )}
            <Button asChild size="lg" variant="outline" className="rounded-2xl font-semibold">
              <Link href="/support">
                <Plus className="h-4 w-4" /> Open another
              </Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
