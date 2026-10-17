'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Truck, Loader2, Pencil, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { DetailsPrefill, VatIdRule } from '@/lib/orders/details';
import { OrderDetailsFields, type CountryOption } from './OrderDetailsFields';

type SaveResult = { error?: string; notice?: string; warning?: string; fieldErrors?: Record<string, string>; ok?: boolean; message?: string };

/**
 * Billing + delivery details of an unpaid order, with an inline editor. Used
 * on the buyer's payment page (save = buyerSaveOrderDetails) and the admin
 * order page (save = adminSetOrderDetails). Typed values are kept when the
 * server refuses them; the server's message (incl. a new proforma revision or
 * a bounced email) is shown as it came.
 */
export function OrderDetailsCard({
  title = 'Billing & delivery details',
  prefill,
  countries,
  homeCountry,
  missing,
  summary,
  editable,
  lockedReason,
  save,
  showSaveProfile = true,
  startOpen,
  testId = 'order-details-card',
  vatIdRule,
}: {
  title?: string;
  prefill: DetailsPrefill;
  countries: CountryOption[];
  homeCountry: string;
  /** What is still missing (empty = complete). */
  missing: string[];
  /** Read-only lines: billing and delivery (already formatted). */
  summary: { billing: string[]; delivery: string[]; vatId: string | null; po: string | null };
  editable: boolean;
  lockedReason?: string | null;
  save: (details: Record<string, string>, saveProfile: boolean) => Promise<SaveResult>;
  showSaveProfile?: boolean;
  startOpen?: boolean;
  testId?: string;
  vatIdRule?: VatIdRule;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(startOpen ?? (editable && missing.length > 0));
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SaveResult | null>(null);
  const [saveProfile, setSaveProfile] = useState(true);
  const complete = missing.length === 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    const fd = new FormData(formRef.current!);
    const details: Record<string, string> = {};
    fd.forEach((v, k) => { if (typeof v === 'string') details[k] = v; });
    start(async () => {
      try {
        const r = await save(details, saveProfile);
        setErrors(r.fieldErrors ?? {});
        const failed = !!r.error || r.ok === false;
        setResult(failed ? { error: r.error ?? r.message } : { notice: r.notice ?? (r.ok ? r.message : undefined), warning: r.warning });
        if (!failed) { setOpen(false); router.refresh(); }
      } catch {
        setResult({ error: 'The details could not be saved — the request failed. Nothing you typed is lost; try again.' });
      }
    });
  }

  return (
    <section className={`rounded-2xl border-2 bg-card p-4 sm:p-6 space-y-4 min-w-0 ${complete ? 'border-border' : 'border-amber-300 dark:border-amber-800'}`} data-testid={testId} data-complete={complete ? '1' : '0'}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-bold inline-flex items-center gap-2"><Building2 className="h-5 w-5 text-primary" /> {title}</h2>
        {complete
          ? <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Complete</span>
          : <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800 dark:text-amber-300"><AlertTriangle className="h-4 w-4" /> Missing: {missing.join(', ')}</span>}
      </div>

      {!open && (
        <div className="grid sm:grid-cols-2 gap-4 text-sm">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Invoice to</p>
            {summary.billing.length ? summary.billing.map((l, i) => <p key={i} dir="auto" className={`[overflow-wrap:anywhere] ${i === 0 ? 'font-semibold' : 'text-muted-foreground'}`}><bdi>{l}</bdi></p>) : <p className="text-muted-foreground italic">Not given yet</p>}
            {summary.vatId && <p className="text-muted-foreground">VAT ID <span className="font-mono">{summary.vatId}</span></p>}
            {summary.po && <p className="text-muted-foreground">PO <span className="font-mono">{summary.po}</span></p>}
          </div>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1 inline-flex items-center gap-1"><Truck className="h-3 w-3" /> Deliver to</p>
            {summary.delivery.length ? summary.delivery.map((l, i) => <p key={i} dir="auto" className={`[overflow-wrap:anywhere] ${i === 0 ? 'font-semibold' : 'text-muted-foreground'}`}><bdi>{l}</bdi></p>) : <p className="text-muted-foreground italic">Not given yet</p>}
          </div>
        </div>
      )}
      {!open && editable && (
        <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-foreground/5" data-testid="details-edit">
          <Pencil className="h-4 w-4" /> {complete ? 'Change details' : 'Add billing & delivery details'}
        </button>
      )}
      {!editable && lockedReason && <p className="text-xs text-muted-foreground">{lockedReason}</p>}

      {open && (
        <form ref={formRef} onSubmit={submit} noValidate className="space-y-4">
          <OrderDetailsFields prefill={prefill} countries={countries} errors={errors} homeCountry={homeCountry} idPrefix={testId} vatIdRule={vatIdRule} />
          {showSaveProfile && (
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} className="mt-1 h-4 w-4" />
              <span>Save these billing details for my next orders</span>
            </label>
          )}
          <p className="text-[11px] text-muted-foreground">Changing these details before payment issues a new proforma revision (the VAT follows the billing / delivery country and VAT ID).</p>
          {result?.error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 dark:text-red-300 dark:bg-red-950/40 dark:border-red-800 [overflow-wrap:anywhere]">{result.error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 disabled:opacity-60" data-testid="details-save">
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save details
            </button>
            {complete && (
              <button type="button" onClick={() => { setOpen(false); setResult(null); setErrors({}); }} disabled={pending} className="inline-flex items-center rounded-full border border-border px-5 py-2.5 text-sm font-semibold hover:bg-foreground/5 disabled:opacity-60">
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      {!open && result?.notice && <p role="status" className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-800 [overflow-wrap:anywhere]" data-testid="details-result">{result.notice}</p>}
      {!open && result?.warning && <p role="status" className="text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded-lg px-3 py-2 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-800 [overflow-wrap:anywhere]" data-testid="details-result">{result.warning}</p>}
    </section>
  );
}
