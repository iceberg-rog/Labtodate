'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ShoppingCart, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Logo } from '@/components/site/Logo';
import { HeaderUserMenu } from '@/components/site/HeaderUserMenu';
import { SearchTypeahead } from '@/components/site/SearchTypeahead';

const NAV = [
  { label: 'Marketplace', href: '/marketplace' },
  { label: 'Let Us Find It', href: '/let-us-find-it' },
  { label: 'Sell your equipment', href: '/sell' },
  { label: 'Lab Rental', href: '/lab-rental' },
  { label: 'Wiki', href: '/wiki' },
  { label: 'Blog', href: '/blog' },
  { label: 'Support', href: '/support' },
];

export function Header({ searchPlaceholder = 'Search instruments…' }: { searchPlaceholder?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-foreground/5 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="container-px flex h-16 items-center gap-4">
        <Link href="/" className="flex-shrink-0">
          <Logo />
        </Link>

        <nav className="hidden lg:flex items-center gap-1 text-sm ml-4">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="px-3 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors font-medium"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="hidden md:flex flex-1 max-w-sm mx-auto">
          <SearchTypeahead className="w-full" placeholder={searchPlaceholder} />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="icon" className="hidden sm:flex" asChild>
            <Link href="/app/cart" aria-label="Cart">
              <ShoppingCart className="h-5 w-5" />
            </Link>
          </Button>
          <HeaderUserMenu />
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setOpen(!open)}
            aria-label="Toggle menu"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {open && (
        <div className="lg:hidden border-t border-foreground/5 bg-background">
          <nav className="container-px py-4 flex flex-col gap-1">
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
          </nav>
        </div>
      )}
    </header>
  );
}
