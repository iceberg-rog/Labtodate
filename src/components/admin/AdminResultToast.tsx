'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

export type AdminResult = { ok: boolean; message: string };

const EVENT = 'admin:result';

/**
 * Show an action's result in the admin-wide toast. For actions whose own
 * controls disappear on success — a deleted or archived order row, a bulk
 * action that empties the list, a refund that removes the "Order actions"
 * card — an inline message would vanish with them after router.refresh().
 */
export function announceAdminResult(result: AdminResult) {
  if (typeof window === 'undefined' || !result?.message) return;
  window.dispatchEvent(new CustomEvent<AdminResult>(EVENT, { detail: result }));
}

/** Mounted once in the admin layout, which survives router.refresh(). */
export function AdminResultToast() {
  const [toast, setToast] = useState<(AdminResult & { at: number }) | null>(null);

  useEffect(() => {
    function onResult(e: Event) {
      const r = (e as CustomEvent<AdminResult>).detail;
      if (r?.message) setToast({ ok: !!r.ok, message: r.message, at: Date.now() });
    }
    window.addEventListener(EVENT, onResult);
    return () => window.removeEventListener(EVENT, onResult);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ok ? 8_000 : 15_000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    // The live region stays mounted so screen readers announce each message.
    <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[75] w-[min(92vw,440px)] pointer-events-none">
      {toast && (
        <div
          key={toast.at}
          className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-card px-4 py-3 text-sm font-semibold shadow-lg animate-in slide-in-from-bottom-4 duration-300 ${
            toast.ok
              ? 'border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300'
              : 'border-red-300 text-red-800 dark:border-red-800 dark:text-red-300'
          }`}
        >
          {toast.ok ? <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" /> : <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />}
          <span className="flex-1">{toast.message}</span>
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
