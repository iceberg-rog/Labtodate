'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ShoppingCart, Menu, X, Search, LayoutGrid, Radar, Tag, Newspaper, BookOpen, FlaskConical, LifeBuoy, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/site/Logo';
import { HeaderUserMenu } from '@/components/site/HeaderUserMenu';
import { SearchTypeahead } from '@/components/site/SearchTypeahead';
import { CartCountBadge } from '@/components/site/CartCountBadge';
import { useSession } from '@/lib/auth-client';
import type { SiteBrand } from '@/lib/brand/site-logo';

// `primary` links show inline in the glass pill from xl; the rest only from
// 2xl, where the whole row fits without wrapping. Below 2xl the menu button
// lists every link.
const NAV = [
  { label: 'Marketplace', href: '/marketplace', primary: true },
  { label: 'Let Us Find It', href: '/let-us-find-it', primary: true },
  { label: 'Sell your equipment', href: '/sell', primary: true },
  { label: 'Blog', href: '/blog', primary: true },
  { label: 'Lab Rental', href: '/lab-rental', primary: false },
  { label: 'Wiki', href: '/wiki', primary: false },
  { label: 'Support', href: '/support', primary: false },
];

// The menu panel: what you do here first (with a line on each), then the reading and help pages as compact tiles.
const MENU_MAIN = [
  { label: 'Marketplace', href: '/marketplace', icon: LayoutGrid, hint: 'Every instrument we list' },
  { label: 'Let Us Find It', href: '/let-us-find-it', icon: Radar, hint: 'Tell us what you need' },
  { label: 'Sell your equipment', href: '/sell', icon: Tag, hint: 'Send us your surplus' },
];
const MENU_MORE = [
  { label: 'Blog', href: '/blog', icon: Newspaper },
  { label: 'Wiki', href: '/wiki', icon: BookOpen },
  { label: 'Lab Rental', href: '/lab-rental', icon: FlaskConical },
  { label: 'Support', href: '/support', icon: LifeBuoy },
];

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

/** The site header's client part; `Header` (./Header.tsx) passes the live brand in. */
export function HeaderBar({
  searchPlaceholder = 'Search instruments…',
  brand,
}: {
  searchPlaceholder?: string;
  /** SITE_NAME and the website logo (siteBrand(); logoUrl '' = the built-in mark). */
  brand: SiteBrand;
}) {
  const [open, setOpen] = useState(false);
  // On md+ the search opens as a full-width row under the header: squeezed
  // inline between the nav and the account buttons it was only 54–78px wide.
  const [searchOpen, setSearchOpen] = useState(false);
  const { data: session, isPending } = useSession();
  const pathname = usePathname() || '/';
  // the menu closes on navigation and on Escape
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40">
      {/* Desktop: fades the page out under the floating chrome instead of a hard bar.
          Keep it the header's first child: landing.css drops its blur over the live
          canvas through `body > header > div[aria-hidden]:first-child`. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 hidden lg:block bg-gradient-to-b from-background/90 via-background/70 to-background/0 backdrop-blur-[6px] [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"
      />
      {/* Phones and tablets: a solid bar — under the fade, scrolled text ran
          through the logo and tagline (QA at 390 px). */}
      <div aria-hidden className="absolute inset-0 -z-10 border-b border-border/60 bg-background lg:hidden" />
      <div className="container-px flex h-[76px] items-center gap-4">
        <Link href="/" className="flex-shrink-0" aria-label={`${brand.name} home`}>
          <Logo name={brand.name} logoUrl={brand.logoUrl} logoOnLight={brand.logoOnLight} priority />
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <nav className="nav-pill hidden xl:flex mr-1" aria-label="Main">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                className={item.primary ? '' : 'hidden 2xl:inline-flex'}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <button
            type="button"
            className="hud-round hidden md:inline-grid"
            onClick={() => {
              setSearchOpen((v) => !v);
              setOpen(false);
            }}
            aria-label={searchOpen ? 'Close search' : 'Search'}
            aria-expanded={searchOpen}
            aria-controls="header-search"
          >
            {searchOpen ? <X className="h-[18px] w-[18px]" /> : <Search className="h-[18px] w-[18px]" />}
          </button>
          <Link href="/app/cart" aria-label="Cart" className="hud-round relative hidden sm:inline-grid">
            <ShoppingCart className="h-[18px] w-[18px]" />
            <Suspense fallback={null}>
              <CartCountBadge />
            </Suspense>
          </Link>
          <HeaderUserMenu />
          <button
            type="button"
            className="hud-round inline-grid 2xl:hidden"
            onClick={() => {
              setOpen(!open);
              setSearchOpen(false);
            }}
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {open ? <X className="h-[18px] w-[18px]" /> : <Menu className="h-[18px] w-[18px]" />}
          </button>
        </div>
      </div>

      {searchOpen && (
        <div id="header-search" className="hidden md:block">
          <div className="container-px pb-4">
            <div className="glass-panel max-w-2xl mx-auto rounded-2xl p-2">
              <SearchTypeahead
                autoFocus
                className="w-full"
                placeholder={searchPlaceholder}
                onNavigate={() => setSearchOpen(false)}
                onDismiss={() => setSearchOpen(false)}
              />
            </div>
          </div>
        </div>
      )}

      {open && (
        <>
          {/* a click anywhere outside the panel closes it */}
          <button type="button" aria-label="Close menu" tabIndex={-1} className="fixed inset-0 -z-10 cursor-default" onClick={() => setOpen(false)} />
          <div className="absolute inset-x-0 top-full">
            <div className="container-px flex justify-end">
              <div className="site-menu" role="dialog" aria-label="Menu">
                <div className="pb-2 md:hidden">
                  <SearchTypeahead className="w-full" placeholder={searchPlaceholder} onNavigate={() => setOpen(false)} />
                </div>
                <p className="site-menu-k">Buy &amp; sell</p>
                <nav className="grid gap-1" aria-label="Main">
                  {MENU_MAIN.map(({ label, href, icon: Icon, hint }) => (
                    <Link key={href} href={href} aria-current={isActive(pathname, href) ? 'page' : undefined} className="site-menu-row" onClick={() => setOpen(false)}>
                      <span className="site-menu-ico"><Icon aria-hidden /></span>
                      <span className="min-w-0 flex-1"><b>{label}</b><small>{hint}</small></span>
                      <ArrowUpRight className="site-menu-go" aria-hidden />
                    </Link>
                  ))}
                </nav>
                <p className="site-menu-k">Resources</p>
                <nav className="grid grid-cols-2 gap-1" aria-label="Resources">
                  {MENU_MORE.map(({ label, href, icon: Icon }) => (
                    <Link key={href} href={href} aria-current={isActive(pathname, href) ? 'page' : undefined} className="site-menu-tile" onClick={() => setOpen(false)}>
                      <Icon aria-hidden />
                      {label}
                    </Link>
                  ))}
                </nav>
                {/* The header's Sign in button is hidden below sm, so phones need it here. Signed-in users keep the avatar menu. */}
                {!isPending && !session && (
                  <div className="sm:hidden mt-3 grid grid-cols-2 gap-2">
                    <Button variant="outline" asChild className="rounded-full font-medium">
                      <Link href="/auth/sign-in" onClick={() => setOpen(false)}>Sign in</Link>
                    </Button>
                    <Link href="/auth/sign-up" onClick={() => setOpen(false)} className="btn-lime inline-flex h-10 items-center justify-center rounded-full text-sm font-semibold">
                      Create account
                    </Link>
                  </div>
                )}
                <div className="site-menu-foot">
                  <Link href="/app/cart" className="site-menu-tile" onClick={() => setOpen(false)}>
                    <ShoppingCart aria-hidden /> Cart
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </header>
  );
}
