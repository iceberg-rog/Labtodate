'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ShoppingCart, Menu, X, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/site/Logo';
import { HeaderUserMenu } from '@/components/site/HeaderUserMenu';
import { SearchTypeahead } from '@/components/site/SearchTypeahead';
import { ThemeToggle } from '@/components/site/ThemeToggle';
import { CartCountBadge } from '@/components/site/CartCountBadge';
import { useSession } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

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

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

export function Header({ searchPlaceholder = 'Search instruments…' }: { searchPlaceholder?: string }) {
  const [open, setOpen] = useState(false);
  // On md+ the search opens as a full-width row under the header: squeezed
  // inline between the nav and the account buttons it was only 54–78px wide.
  const [searchOpen, setSearchOpen] = useState(false);
  const { data: session, isPending } = useSession();
  const pathname = usePathname() || '/';

  return (
    <header className="sticky top-0 z-40">
      {/* Fades the page out under the floating chrome instead of a hard bar. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-gradient-to-b from-background/90 via-background/70 to-background/0 backdrop-blur-[6px] [mask-image:linear-gradient(to_bottom,black_60%,transparent)]"
      />
      <div className="container-px flex h-[76px] items-center gap-4">
        <Link href="/" className="flex-shrink-0" aria-label="lab2date home">
          <Logo />
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
          <ThemeToggle className="hud-round hidden sm:inline-grid" />
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
        <div className="2xl:hidden">
          <div className="container-px pb-4">
            <div className="glass-panel rounded-2xl p-3">
              <div className="pb-3 md:hidden">
                <SearchTypeahead className="w-full" placeholder={searchPlaceholder} onNavigate={() => setOpen(false)} />
              </div>
              <nav className="flex flex-col gap-1" aria-label="Main">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                    className={cn(
                      'px-3 py-2.5 rounded-xl text-sm font-medium hover:bg-foreground/5',
                      isActive(pathname, item.href) && 'bg-primary/10 text-foreground',
                    )}
                    onClick={() => setOpen(false)}
                  >
                    {item.label}
                  </Link>
                ))}
                {/* The header's Sign in button is hidden below sm, so phones
                    need it here. Signed-in users keep the avatar menu. */}
                {!isPending && !session && (
                  <div className="sm:hidden mt-2 grid grid-cols-2 gap-2 border-t border-foreground/5 pt-3">
                    <Button variant="outline" asChild className="rounded-full font-medium">
                      <Link href="/auth/sign-in" onClick={() => setOpen(false)}>Sign in</Link>
                    </Button>
                    <Link
                      href="/auth/sign-up"
                      onClick={() => setOpen(false)}
                      className="btn-lime inline-flex h-10 items-center justify-center rounded-full text-sm font-semibold"
                    >
                      Create account
                    </Link>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between border-t border-foreground/5 pt-3">
                  <Link
                    href="/app/cart"
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium hover:bg-foreground/5"
                    onClick={() => setOpen(false)}
                  >
                    <ShoppingCart className="h-4 w-4" /> Cart
                  </Link>
                  <ThemeToggle />
                </div>
              </nav>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
