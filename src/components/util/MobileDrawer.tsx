'use client';

import { useState, useEffect } from 'react';
import { Menu, X } from 'lucide-react';

/**
 * Mobile slide-in nav drawer. Renders a fixed hamburger trigger pinned to the
 * top-left (visible only below lg breakpoint via the wrapping `lg:hidden`).
 *
 * Implementation deliberately tiny — no shadcn Sheet dep, no animation lib.
 * - Backdrop fades in, panel slides from the left
 * - ESC closes, click on backdrop closes
 * - Body scroll-lock while open so the bg page doesn't bleed
 */
export function MobileDrawer({
  triggerLabel = 'Menu',
  title,
  children,
}: {
  triggerLabel?: string;
  title?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={triggerLabel}
        className="inline-flex items-center gap-2 h-10 px-3 rounded-lg border border-border bg-card text-sm font-semibold shadow-sm active:scale-95 transition lg:hidden"
      >
        <Menu className="h-4 w-4" />
        <span>{triggerLabel}</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-in fade-in"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute left-0 top-0 bottom-0 w-[86%] max-w-[320px] bg-card shadow-2xl flex flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3 flex-shrink-0">
              <p className="text-sm font-bold">{title ?? triggerLabel}</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="h-9 w-9 rounded-md inline-flex items-center justify-center hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-3" onClick={(e) => {
              // Auto-close after clicking a nav link inside.
              const t = e.target as HTMLElement;
              if (t.closest('a, button[type="submit"]')) setOpen(false);
            }}>
              {children}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
