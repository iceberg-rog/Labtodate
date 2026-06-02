import Link from 'next/link';
import { CheckCircle2, LifeBuoy, Mail, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getServerSession } from '@/lib/auth-server';

export const metadata = { title: 'Ticket received' };
export const dynamic = 'force-dynamic';

export default async function SupportThanksPage(props: { searchParams: Promise<{ ref?: string }> }) {
  const searchParams = await props.searchParams;
  const session = await getServerSession();
  const signedIn = !!session?.user;

  return (
    <div className="container-px py-20 max-w-xl mx-auto text-center">
      <div className="mx-auto h-16 w-16 rounded-full bg-accent/15 flex items-center justify-center mb-6">
        <CheckCircle2 className="h-8 w-8 text-primary" />
      </div>
      <h1 className="text-4xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }}>
        Ticket received.
      </h1>

      {searchParams.ref && (
        <p className="mt-4 text-sm">
          Reference: <span className="font-mono font-semibold">{searchParams.ref}</span>
        </p>
      )}

      <p className="mt-3 text-muted-foreground">
        {signedIn
          ? 'Our team replies within 1 business day. You can follow the conversation right from your account.'
          : 'Check your inbox — we sent a confirmation with a magic link so you can read replies and follow up without signing up.'}
      </p>

      <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
        {signedIn ? (
          <>
            <Button asChild size="lg" className="rounded-2xl font-semibold">
              <Link href="/app/support">
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
            <Button asChild size="lg" className="rounded-2xl font-semibold">
              <Link href="/">
                <Mail className="h-4 w-4" /> Check your email
              </Link>
            </Button>
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
