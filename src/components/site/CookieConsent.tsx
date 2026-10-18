'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

const KEY = 'l2d_cookie_ack';

// Don't pop the cookie banner on flows where the user is already actively
// engaged (sign-in, signed-in admin/app, paying at checkout). It overlaps the
// payment form's country dropdown and turns into a footgun. Marketing pages
// (/, /marketplace, /blog, etc.) still see it.
const HIDE_ON = ['/auth', '/checkout', '/admin', '/app'];

/**
 * The cookie notice: a slim bar along the bottom edge. While it shows, the
 * page gets the same amount of bottom padding, so everything under the bar
 * (a form's submit button, the sign-in / create-account buttons of a gate) can
 * be scrolled above it — the old floating card covered them with no way round.
 * Its height is also published as --cookie-bar-h on <html> for screen-high
 * pinned sections (the homepage stations), which no padding can move.
 */
export function CookieConsent() {
  const pathname = usePathname();
  const [show, setShow] = useState(false);
  const bar = useRef<HTMLDivElement | null>(null);
  const hidden = HIDE_ON.some((p) => pathname?.startsWith(p));
  useEffect(() => {
    if (hidden) return;
    try {
      if (!localStorage.getItem(KEY)) setShow(true);
    } catch {
      /* storage blocked — don't nag */
    }
  }, [hidden]);

  const visible = show && !hidden;
  useEffect(() => {
    const el = bar.current;
    if (!visible || !el) return;
    const body = document.body;
    const root = document.documentElement;
    const before = body.style.paddingBottom;
    const reserve = () => {
      const h = `${Math.ceil(el.getBoundingClientRect().height)}px`;
      body.style.paddingBottom = h;
      root.style.setProperty('--cookie-bar-h', h);
    };
    reserve();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reserve);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      body.style.paddingBottom = before;
      root.style.removeProperty('--cookie-bar-h');
    };
  }, [visible]);

  if (!visible) return null;
  return (
    <div
      ref={bar}
      role="region"
      aria-label="Cookie notice"
      className="fixed inset-x-0 bottom-0 z-[90] border-t border-border bg-card shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.5)]"
    >
      <div className="container-px mx-auto flex max-w-5xl items-center gap-3 py-2.5 sm:gap-4 sm:py-3">
        <p className="flex-1 text-xs leading-snug text-muted-foreground sm:text-sm">
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
          className="shrink-0 rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-sm font-semibold hover:bg-primary/90 sm:px-5 sm:py-2"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
