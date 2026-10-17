import { ArrowRight, CheckCircle2, Truck, User, Building2 } from 'lucide-react';
import type { NextStep } from '@/lib/fulfilment/rules';

/**
 * “What happens next — and who does it” on both order pages (owner report 6:
 * no dead ends). The steps come from lib/fulfilment/rules.ts orderNextSteps.
 */
const WHO: Record<string, { buyer: string; staff: string; icon: React.ReactNode; cls: string }> = {
  buyer: { buyer: 'You', staff: 'Buyer', icon: <User className="h-3.5 w-3.5" />, cls: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800' },
  staff: { buyer: 'lab2date', staff: 'Us', icon: <Building2 className="h-3.5 w-3.5" />, cls: 'bg-sky-100 text-sky-900 border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800' },
  carrier: { buyer: 'Carrier', staff: 'Carrier', icon: <Truck className="h-3.5 w-3.5" />, cls: 'bg-violet-100 text-violet-900 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800' },
  none: { buyer: 'Done', staff: 'Done', icon: <CheckCircle2 className="h-3.5 w-3.5" />, cls: 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800' },
};

export function NextSteps({ steps, audience }: { steps: NextStep[]; audience: 'buyer' | 'staff' }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-5" data-testid="next-steps" aria-labelledby="next-steps-h">
      <h2 id="next-steps-h" className="text-xs font-bold uppercase tracking-[0.16em] text-muted-foreground mb-3 inline-flex items-center gap-1.5">
        <ArrowRight className="h-3.5 w-3.5" /> What happens next
      </h2>
      <ul className="space-y-2">
        {steps.map((s, i) => {
          const w = WHO[s.who] ?? WHO.none;
          return (
            <li key={i} className="flex items-start gap-2.5 text-sm">
              <span className={`mt-0.5 inline-flex items-center gap-1 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${w.cls}`}>
                {w.icon} {audience === 'buyer' ? w.buyer : w.staff}
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{s.text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
