'use client';

import Link from 'next/link';
import { ChevronLeft, Printer } from 'lucide-react';

export function InvoiceActions({ backHref }: { backHref: string }) {
  return (
    <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-border bg-card text-xs font-semibold hover:bg-foreground/5"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> Back to order
      </Link>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          Use your browser&apos;s print dialog → &ldquo;Save as PDF&rdquo;
        </span>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90"
        >
          <Printer className="h-3.5 w-3.5" /> Print / Save PDF
        </button>
      </div>
    </div>
  );
}
