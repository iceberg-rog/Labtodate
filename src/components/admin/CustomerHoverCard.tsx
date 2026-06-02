'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { UserCircle2, Mail, Building2, Repeat, TrendingUp, ExternalLink, X } from 'lucide-react';

export type CustomerHoverInfo = {
  userId?: string | null;
  name: string;
  email: string;
  company?: string | null;
  joinedAtISO?: string | null;
  paidOrderCount?: number;
  lifetimeCents?: number;
  isGuest?: boolean;
};

function fmtEUR(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

export function CustomerHoverCard({
  info,
  trigger,
}: {
  info: CustomerHoverInfo;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="cursor-pointer hover:underline decoration-dotted underline-offset-2 inline-flex items-center gap-1"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="dialog"
          className="absolute z-50 left-0 top-full mt-2 w-[300px] rounded-2xl border border-border bg-card shadow-[0_20px_50px_-20px_rgba(15,79,64,0.45)] p-4 text-left animate-in fade-in slide-in-from-top-1 duration-150"
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="absolute top-2 right-2 opacity-60 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>

          <div className="flex items-start gap-3 mb-3">
            <div className="h-10 w-10 rounded-full bg-primary/10 text-primary inline-flex items-center justify-center font-bold text-sm shrink-0">
              <UserCircle2 className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="font-bold text-sm truncate">{info.name}</p>
              <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1 truncate">
                <Mail className="h-3 w-3 shrink-0" />
                <a href={`mailto:${info.email}`} className="hover:text-foreground truncate">
                  {info.email}
                </a>
              </p>
              {info.company && (
                <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1 truncate">
                  <Building2 className="h-3 w-3 shrink-0" /> {info.company}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="rounded-lg bg-foreground/[0.04] p-2">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground inline-flex items-center gap-1">
                <Repeat className="h-3 w-3" /> Paid
              </p>
              <p className="font-bold text-sm tabular-nums">{info.paidOrderCount ?? 0}</p>
            </div>
            <div className="rounded-lg bg-foreground/[0.04] p-2">
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground inline-flex items-center gap-1">
                <TrendingUp className="h-3 w-3" /> LTV
              </p>
              <p className="font-bold text-sm tabular-nums">
                {info.lifetimeCents && info.lifetimeCents > 0 ? fmtEUR(info.lifetimeCents) : '—'}
              </p>
            </div>
          </div>

          {info.joinedAtISO && (
            <p className="text-[10px] text-muted-foreground mb-2">
              Joined{' '}
              {new Date(info.joinedAtISO).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
            </p>
          )}

          {info.isGuest && (
            <p className="text-[10px] text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2 mb-2">
              Guest ticket — no account on file.
            </p>
          )}

          {info.userId && (
            <Link
              href={`/admin/users/${info.userId}`}
              onClick={() => setOpen(false)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
            >
              View full profile <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </div>
      )}
    </span>
  );
}
