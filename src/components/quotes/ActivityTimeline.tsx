import {
  ArrowUpRight, FileText, Lock, MessageSquare, ShieldAlert, ShoppingBag,
  Check, X, Inbox, UserPlus, RefreshCw,
} from 'lucide-react';
import type { TimelineEvent } from '@/lib/quotes/activity-timeline';

const ICON: Record<TimelineEvent['kind'], JSX.Element> = {
  submitted:             <Inbox className="h-3.5 w-3.5" />,
  assigned:              <UserPlus className="h-3.5 w-3.5" />,
  staff_reply:           <MessageSquare className="h-3.5 w-3.5" />,
  buyer_reply:           <ArrowUpRight className="h-3.5 w-3.5" />,
  internal_note:         <Lock className="h-3.5 w-3.5" />,
  proforma_sent:         <FileText className="h-3.5 w-3.5" />,
  proforma_valid_until:  <FileText className="h-3.5 w-3.5" />,
  sla_breached:          <ShieldAlert className="h-3.5 w-3.5" />,
  accepted:              <Check className="h-3.5 w-3.5" />,
  declined:              <X className="h-3.5 w-3.5" />,
  closed:                <X className="h-3.5 w-3.5" />,
  order_created:         <ShoppingBag className="h-3.5 w-3.5" />,
  order_paid:            <ShoppingBag className="h-3.5 w-3.5" />,
  magic_link_reissued:   <RefreshCw className="h-3.5 w-3.5" />,
};

const TONE: Record<TimelineEvent['kind'], string> = {
  submitted:             'bg-slate-200 text-slate-700',
  assigned:              'bg-primary/15 text-primary',
  staff_reply:           'bg-sky-100 text-sky-800',
  buyer_reply:           'bg-amber-100 text-amber-800',
  internal_note:         'bg-amber-50 text-amber-700 border border-amber-200',
  proforma_sent:         'bg-purple-100 text-purple-800',
  proforma_valid_until:  'bg-slate-100 text-slate-600',
  sla_breached:          'bg-red-100 text-red-800',
  accepted:              'bg-emerald-100 text-emerald-800',
  declined:              'bg-red-100 text-red-800',
  closed:                'bg-slate-100 text-slate-700',
  order_created:         'bg-purple-100 text-purple-800',
  order_paid:            'bg-emerald-100 text-emerald-900',
  magic_link_reissued:   'bg-sky-100 text-sky-800',
};

function dtFmt(d: Date): string {
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ActivityTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) return null;
  return (
    <ol className="relative ml-3 border-l-2 border-border space-y-3 py-1">
      {events.map((e, i) => (
        <li key={i} className="relative pl-5">
          <span
            className={`absolute -left-[14px] top-0.5 h-6 w-6 rounded-full inline-flex items-center justify-center ${TONE[e.kind]}`}
          >
            {ICON[e.kind]}
          </span>
          <div className="text-[12px]">
            <p className="font-semibold">{e.title}</p>
            {e.detail && <p className="text-muted-foreground line-clamp-2">{e.detail}</p>}
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">{dtFmt(e.at)}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
