import { Inbox, MessageSquare, FileText, Check, ShoppingBag } from 'lucide-react';
import type { DealStateBadge } from '@/lib/quotes/deal-state';

/**
 * Horizontal funnel stepper — visually anchors the deal in its lifecycle.
 * 5 fixed steps: Submitted → Engaged → Proforma → Accepted → Paid.
 *
 * Mobile (<640px): hide labels, keep just the dots + connectors so the row
 * fits a 390px viewport cleanly. Current step still gets a label below for
 * orientation.
 *
 * Desktop (sm+): full label below every dot.
 */
export function ProformaStepper({ badge }: { badge: DealStateBadge }) {
  const steps = [
    { label: 'Submitted',  icon: <Inbox className="h-3 w-3" />,         n: 1 as const },
    { label: 'Engaged',    icon: <MessageSquare className="h-3 w-3" />, n: 2 as const },
    { label: 'Proforma',   icon: <FileText className="h-3 w-3" />,      n: 3 as const },
    { label: 'Accepted',   icon: <Check className="h-3 w-3" />,         n: 4 as const },
    { label: 'Paid',       icon: <ShoppingBag className="h-3 w-3" />,   n: 5 as const },
  ];
  const isLost = badge.state === 'lost_declined' || badge.state === 'lost_closed';
  const currentStep = steps.find((s) => s.n === badge.funnelStep);

  return (
    <div className="w-full">
      <div className="flex items-center gap-0.5 w-full">
        {steps.map((s, i) => {
          const done = !isLost && s.n < badge.funnelStep;
          const current = !isLost && s.n === badge.funnelStep;
          return (
            <div key={s.label} className="flex items-center flex-1 last:flex-initial min-w-0">
              <div className="flex flex-col items-center flex-shrink-0">
                <span
                  className={`h-7 w-7 rounded-full inline-flex items-center justify-center border-2 transition ${
                    current
                      ? 'bg-primary border-primary text-primary-foreground shadow-sm'
                      : done
                      ? 'bg-emerald-500 border-emerald-500 text-white'
                      : isLost && s.n <= badge.funnelStep
                      ? 'bg-slate-200 border-slate-300 text-slate-500'
                      : 'bg-card border-border text-muted-foreground'
                  }`}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : s.icon}
                </span>
                {/* Desktop labels — hidden on narrow viewports. */}
                <span className={`hidden sm:block text-[9px] uppercase tracking-wider font-bold mt-1 whitespace-nowrap ${
                  current ? 'text-primary' : done ? 'text-emerald-700' : 'text-muted-foreground'
                }`}>
                  {s.label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <span
                  className={`h-0.5 flex-1 mx-1 ${
                    done ? 'bg-emerald-400' : current ? 'bg-primary/30' : 'bg-border'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
      {/* Mobile label — only the current stage, centered under the row. */}
      {currentStep && !isLost && (
        <p className="sm:hidden text-[10px] uppercase tracking-wider font-bold text-primary text-center mt-2">
          Stage {badge.funnelStep} / 5 · {currentStep.label}
        </p>
      )}
    </div>
  );
}
