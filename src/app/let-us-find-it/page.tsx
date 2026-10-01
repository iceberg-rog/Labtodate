import { Suspense } from 'react';
import Link from 'next/link';
import { Sparkles, Clock, ShieldCheck, LogIn } from 'lucide-react';
import { SourcingForm } from './SourcingForm';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { prisma } from '@/lib/db';
import { getServerSession } from '@/lib/auth-server';
import { getMarketing } from '@/lib/marketing';

export const metadata = { title: 'Let Us Find It' };
export const dynamic = 'force-dynamic';

export default async function LetUsFindItPage({ searchParams }: { searchParams: Promise<{ product?: string }> }) {
  const mk = await getMarketing();
  const session = await getServerSession();
  const slug = (await searchParams).product;
  const anchor = slug
    ? await prisma.product.findUnique({
        where: { slug },
        select: { slug: true, title: true, brand: { select: { name: true } } },
      })
    : null;

  return (
    <div className="container-px py-12 md:py-20">
      <div className="grid lg:grid-cols-[1fr_1.2fr] gap-12 items-start max-w-6xl mx-auto">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-accent/15 border border-accent/30 px-3 py-1 text-xs font-bold text-primary mb-5">
            <Sparkles className="h-3.5 w-3.5" />
            Concierge sourcing
          </div>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-foreground leading-[1.05]" style={{ letterSpacing: '-0.04em' }}>
            Tell us what you need.<br />
            <span className="text-primary">We&apos;ll find it.</span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground leading-relaxed">
            Tell us the make, model or use-case and we&apos;ll come back with a quote{mk.quoteTurnaround ? <>{' '}within <strong className="text-foreground">{mk.quoteTurnaround}</strong></> : null}.
          </p>

          <ul className="mt-8 space-y-4">
            <Bullet icon={Clock} title="Quote turnaround" body="We come back as soon as we have something solid — typically a few business days." />
            <Bullet icon={ShieldCheck} title="Free for buyers" body="No commission until you accept a quote." />
          </ul>
        </div>

        {session ? (
          <Suspense>
            <SourcingForm
              anchor={anchor ? { slug: anchor.slug, title: anchor.title, brand: anchor.brand?.name ?? null } : null}
              buyer={{ name: session.user.name ?? '', email: session.user.email }}
            />
          </Suspense>
        ) : (
          <SignInToRequest
            anchor={anchor ? { title: anchor.title, brand: anchor.brand?.name ?? null } : null}
            back={anchor ? `/let-us-find-it?product=${encodeURIComponent(anchor.slug)}` : '/let-us-find-it'}
          />
        )}
      </div>
    </div>
  );
}

// Guests see this instead of the form: a quote is tied to an account so the
// buyer can follow it in their dashboard. `back` returns them to this form.
function SignInToRequest({
  anchor,
  back,
}: {
  anchor: { title: string; brand: string | null } | null;
  back: string;
}) {
  const redirect = encodeURIComponent(back);
  return (
    <div className="rounded-2xl border border-border bg-card p-6 md:p-8 space-y-5 shadow-sm">
      {anchor && (
        <div className="rounded-xl bg-foreground/[0.03] border border-border p-4">
          <p className="text-[10px] uppercase tracking-[0.15em] font-bold text-muted-foreground mb-1">
            Quote about
          </p>
          <p className="font-semibold">{anchor.title}</p>
          {anchor.brand && <Badge variant="secondary" className="mt-2">{anchor.brand}</Badge>}
        </div>
      )}
      <div className="space-y-2">
        <p className="text-lg font-bold">Sign in to request a quote</p>
        <p className="text-sm text-muted-foreground">
          Quotes are linked to your account, so you can follow replies and proformas in your dashboard.
          It takes a minute to create one.
        </p>
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        <Button asChild size="lg" className="rounded-2xl font-semibold flex-1">
          <Link href={`/auth/sign-in?redirect=${redirect}`}><LogIn className="h-4 w-4" /> Sign in</Link>
        </Button>
        <Button asChild size="lg" variant="outline" className="rounded-2xl font-semibold flex-1">
          <Link href={`/auth/sign-up?redirect=${redirect}`}>Create account</Link>
        </Button>
      </div>
    </div>
  );
}

function Bullet({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-4">
      <div className="flex-shrink-0 h-10 w-10 rounded-xl bg-accent/15 text-primary flex items-center justify-center">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="font-bold">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </li>
  );
}
