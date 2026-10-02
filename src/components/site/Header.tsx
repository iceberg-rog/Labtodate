'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ShoppingCart, Menu, X, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/site/Logo';
import { HeaderUserMenu } from '@/components/site/HeaderUserMenu';
import { SearchTypeahead } from '@/components/site/SearchTypeahead';
import { ThemeToggle } from '@/components/site/ThemeToggle';
import { useSession } from '@/lib/auth-client';

// `primary` links show inline from xl; the rest only from 2xl, where the whole
// row fits without wrapping. Below 2xl the menu button lists every link.
const NAV = [
  { label: 'Marketplace', href: '/marketplace', primary: true },
  { label: 'Let Us Find It', href: '/let-us-find-it', primary: true },
  { label: 'Sell your equipment', href: '/sell', primary: true },
  { label: 'Lab Rental', href: '/lab-rental', primary: false },
  { label: 'Wiki', href: '/wiki', primary: false },
  { label: 'Blog', href: '/blog', primary: false },
  { label: 'Support', href: '/support', primary: false },
];

export function Header({ searchPlaceholder = 'Search instruments…' }: { searchPlaceholder?: string }) {
  const [open, setOpen] = useState(false);
  // On md+ the search opens as a full-width row under the header: squeezed
  // inline between the nav and the account buttons it was only 54–78px wide.
  const [searchOpen, setSearchOpen] = useState(false);
  const { data: session, isPending } = useSession();

  return (
    <header className="sticky top-0 z-40 border-b border-foreground/5 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="container-px flex h-16 items-center gap-4">
        <Link href="/" className="flex-shrink-0">
          <Logo />
        </Link>

        <nav className="hidden xl:flex items-center gap-1 text-sm ml-4">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${item.primary ? 'inline-flex' : 'hidden 2xl:inline-flex'} whitespace-nowrap px-3 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors font-medium`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            onClick={() => {
              setSearchOpen((v) => !v);
              setOpen(false);
            }}
            aria-label={searchOpen ? 'Close search' : 'Search'}
            aria-expanded={searchOpen}
            aria-controls="header-search"
          >
            {searchOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
          </Button>
          <ThemeToggle className="hidden sm:inline-flex" />
          <Button variant="ghost" size="icon" className="hidden sm:flex" asChild>
            <Link href="/app/cart" aria-label="Cart">
              <ShoppingCart className="h-5 w-5" />
            </Link>
          </Button>
          <HeaderUserMenu />
          <Button
            variant="ghost"
            size="icon"
            className="2xl:hidden"
            onClick={() => {
              setOpen(!open);
              setSearchOpen(false);
            }}
            aria-label="Toggle menu"
            aria-expanded={open}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {searchOpen && (
        <div id="header-search" className="hidden md:block border-t border-foreground/5 bg-background">
          <div className="container-px py-3">
            <SearchTypeahead
              autoFocus
              className="max-w-2xl mx-auto"
              placeholder={searchPlaceholder}
              onNavigate={() => setSearchOpen(false)}
              onDismiss={() => setSearchOpen(false)}
            />
          </div>
        </div>
      )}

      {open && (
        <div className="2xl:hidden border-t border-foreground/5 bg-background">
          <div className="container-px py-3 md:hidden">
            <SearchTypeahead className="w-full" placeholder={searchPlaceholder} onNavigate={() => setOpen(false)} />
          </div>
          <nav className="container-px pb-4 flex flex-col gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="px-3 py-2.5 rounded-lg text-sm hover:bg-foreground/5 font-medium"
                onClick={() => setOpen(false)}
              >
                {item.label}
              </Link>
            ))}
            {/* The header's Sign in / Get started buttons are hidden below sm,
                so phones need them here. Signed-in users keep the avatar menu. */}
            {!isPending && !session && (
              <div className="sm:hidden mt-2 grid grid-cols-2 gap-2 border-t border-foreground/5 pt-3">
                <Button variant="outline" asChild className="rounded-full font-medium">
                  <Link href="/auth/sign-in" onClick={() => setOpen(false)}>Sign in</Link>
                </Button>
                <Button asChild className="rounded-full font-semibold">
                  <Link href="/auth/sign-up" onClick={() => setOpen(false)}>Create account</Link>
                </Button>
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
      )}
    </header>
  );
}
