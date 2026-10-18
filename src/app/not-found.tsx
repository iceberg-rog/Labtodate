import Link from 'next/link';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { ArrowRight, Home, LifeBuoy, Radar, Search, Store, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { catalogPolicyFrom, getCatalogPolicy } from '@/lib/catalog/policy';
import { isBuildPhase } from '@/lib/build-phase';

// Never indexed (Next also marks every 404 noindex).
export const metadata: Metadata = { title: 'Page not found', robots: { index: false, follow: true } };

const LINKS = [
  { href: '/marketplace', label: 'Browse the marketplace', icon: Store },
  { href: '/let-us-find-it', label: 'Let us find an instrument for you', icon: Radar },
  { href: '/sell', label: 'Sell your equipment', icon: Tag },
  { href: '/support', label: 'Contact support', icon: LifeBuoy },
  { href: '/', label: 'Home', icon: Home },
] as const;

/**
 * The site's "page not found" page: an unknown address, a listing that is not
 * public (any more), or anything that calls notFound(). Inside the site
 * layout (header, footer) and drawn with the theme tokens, so it reads in the
 * light and the dark theme. Heading and text: Settings → Site texts & pages.
 */
export default async function NotFound() {
  // The texts are settings: render per request, never a build-time copy.
  if (!isBuildPhase()) await connection();
  const policy = isBuildPhase() ? catalogPolicyFrom(() => '') : await getCatalogPolicy();
  return (
    <div className="container-px py-16 md:py-24">
      <div className="max-w-2xl mx-auto text-center">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Error 404</p>
        <h1 className="mt-3 text-4xl md:text-5xl font-bold text-foreground" style={{ letterSpacing: '-0.035em' }}>
          {policy.texts.notFoundTitle}
        </h1>
        <p className="mt-4 text-lg text-muted-foreground leading-relaxed">{policy.texts.notFoundText}</p>

        <form action="/marketplace" method="get" role="search" className="mt-8 flex flex-col sm:flex-row gap-3">
          <label htmlFor="not-found-search" className="sr-only">
            Search the marketplace
          </label>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              id="not-found-search"
              name="q"
              type="search"
              placeholder="Make, model or instrument type"
              className="w-full h-12 pl-10 pr-3 rounded-2xl border border-input bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
          </div>
          <Button type="submit" size="lg" className="rounded-2xl font-semibold">
            Search
          </Button>
        </form>
      </div>

      <ul className="mt-12 max-w-2xl mx-auto grid gap-3 sm:grid-cols-2">
        {LINKS.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="group flex items-center gap-3 rounded-2xl border border-border bg-card p-4 text-foreground hover:border-primary/40 transition-colors"
            >
              <span className="h-9 w-9 shrink-0 rounded-xl bg-accent/15 text-primary flex items-center justify-center">
                <Icon className="h-4 w-4" />
              </span>
              <span className="flex-1 text-sm font-semibold">{label}</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
