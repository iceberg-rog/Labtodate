'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

const KEY = 'l2d_cookie_ack';

// Don't pop the cookie banner on flows where the user is already actively
// engaged (sign-in, signed-in admin/app, paying at checkout). It overlaps the
// payment form's country dropdown and turns into a footgun. Marketing pages
// (/, /marketplace, /blog, etc.) still see it.
const HIDE_ON = ['/auth', '/checkout', '/admin', '/app'];

export function CookieConsent() {
  const pathname = usePathname();
  const [show, setShow] = useState(false);
  const hidden = HIDE_ON.some((p) => pathname?.startsWith(p));
  useEffect(() => {
    if (hidden) return;
    try {
      if (!localStorage.getItem(KEY)) setShow(true);
    } catch {
      /* storage blocked — don't nag */
    }
  }, [hidden]);
  if (hidden || !show) return null;
  return (
    // The full-width wrapper is click-through and keeps clear of the
    // bottom-right corner (below lg), where the assistant button sits —
    // otherwise the notice blocked "Open assistant" until dismissed.
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[90] p-3 pr-24 sm:p-4 sm:pr-24 lg:pr-4">
      <div className="pointer-events-auto mx-auto max-w-3xl rounded-2xl border border-border bg-card shadow-lg p-4 flex flex-col sm:flex-row items-start sm:items-center gap-4">
        <p className="text-sm text-muted-foreground flex-1">
          We use only essential cookies to keep you signed in and secure — no tracking or ads.{' '}
          <Link href="/legal/cookies" className="text-primary underline underline-offset-2">
            Cookie policy
          </Link>
          .
        </p>
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.setItem(KEY, '1');
            } catch {
              /* ignore */
            }
            setShow(false);
          }}
          className="shrink-0 rounded-full bg-primary text-primary-foreground px-5 py-2 text-sm font-semibold hover:bg-primary/90"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
