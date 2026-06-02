import { Suspense } from 'react';
import { Sparkles, Clock, ShieldCheck, Globe } from 'lucide-react';
import { SourcingForm } from './SourcingForm';
import { prisma } from '@/lib/db';
import { getMarketing } from '@/lib/marketing';

export const metadata = { title: 'Let Us Find It' };
export const dynamic = 'force-dynamic';

export default async function LetUsFindItPage(props: { searchParams: Promise<{ product?: string }> }) {
  const searchParams = await props.searchParams;
  const mk = await getMarketing();
  const slug = searchParams.product;
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
            Our sourcing team works with {mk.suppliers} suppliers worldwide. Most requests get matched within{' '}
            <strong className="text-foreground">{mk.quoteTurnaround}</strong> with vetted quotes from multiple suppliers.
          </p>

          <ul className="mt-8 space-y-4">
            <Bullet icon={Clock}      title="5-day turnaround" body="Average time to first vetted quote." />
            <Bullet icon={Globe}      title="Global supplier network" body="EU, US, and Asia-Pacific coverage." />
            <Bullet icon={ShieldCheck} title="Free for buyers" body="No commission until you accept a quote." />
          </ul>
        </div>

        <Suspense>
          <SourcingForm
            anchor={anchor ? { slug: anchor.slug, title: anchor.title, brand: anchor.brand?.name ?? null } : null}
          />
        </Suspense>
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
