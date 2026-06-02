import {
  Building2, Globe2, Repeat, TrendingUp, CheckCircle2, XCircle, Clock, Inbox,
  CreditCard, Users,
} from 'lucide-react';
import type { BuyerIntel } from '@/lib/quotes/buyer-intel';

function fmtEUR(cents: number): string {
  if (cents === 0) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(cents / 100);
}

export function BuyerIntelCard({ intel, buyerName, buyerEmail, company, isGuest }: {
  intel: BuyerIntel;
  buyerName: string;
  buyerEmail: string;
  company: string | null;
  isGuest: boolean;
}) {
  const total = intel.totalRfqs;
  const won = intel.rfqsByOutcome.won;
  const winRate = total > 0 ? (won / total) : 0;

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      {/* Header */}
      <div>
        <p className="font-bold text-sm">{buyerName}</p>
        <p className="text-[11px] text-muted-foreground truncate">{buyerEmail}</p>
        {company && (
          <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1 mt-0.5">
            <Building2 className="h-3 w-3" /> {company}
          </p>
        )}
        {isGuest && (
          <p className="mt-2 inline-flex items-center gap-1 text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
            Guest — no account
          </p>
        )}
      </div>

      {/* RFQ funnel */}
      <div className="pt-3 border-t border-border">
        <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
          RFQ history ({total})
        </p>
        {total > 0 ? (
          <>
            {/* Tri-color bar */}
            <div className="flex h-2 rounded-full overflow-hidden border border-border">
              <span className="bg-emerald-400" style={{ width: `${(intel.rfqsByOutcome.won / total) * 100}%` }} />
              <span className="bg-amber-400" style={{ width: `${(intel.rfqsByOutcome.open / total) * 100}%` }} />
              <span className="bg-slate-300" style={{ width: `${(intel.rfqsByOutcome.lost / total) * 100}%` }} />
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2 text-[10px]">
              <Mini icon={<CheckCircle2 className="h-3 w-3 text-emerald-700" />} label="Won" value={intel.rfqsByOutcome.won} />
              <Mini icon={<Clock className="h-3 w-3 text-amber-700" />} label="Open" value={intel.rfqsByOutcome.open} />
              <Mini icon={<XCircle className="h-3 w-3 text-slate-600" />} label="Lost" value={intel.rfqsByOutcome.lost} />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5">
              Win rate: <strong>{Math.round(winRate * 100)}%</strong>
            </p>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground italic">This is their first RFQ.</p>
        )}
      </div>

      {/* Order intelligence */}
      <div className="pt-3 border-t border-border">
        <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
          Orders &amp; payments
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Stat icon={<Repeat className="h-3 w-3" />} label="Paid orders" value={String(intel.paidOrders)} />
          <Stat icon={<TrendingUp className="h-3 w-3" />} label="LTV" value={fmtEUR(intel.lifetimeCents)} />
          <Stat icon={<CreditCard className="h-3 w-3" />} label="Avg deal" value={fmtEUR(intel.avgDealCents)} />
          <Stat
            icon={<CheckCircle2 className="h-3 w-3" />}
            label="On-time pay"
            value={intel.paymentReliability != null ? `${Math.round(intel.paymentReliability * 100)}%` : '—'}
          />
        </div>
      </div>

      {/* Relationship */}
      <div className="pt-3 border-t border-border">
        <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
          Relationship
        </p>
        <div className="space-y-1.5">
          <Row icon={<Users className="h-3 w-3" />} label="Suppliers engaged" value={String(intel.suppliersInteracted || 0)} />
          <Row icon={<Globe2 className="h-3 w-3" />} label="Ship-to" value={intel.countries.length > 0 ? intel.countries.slice(0, 3).join(', ') : '—'} />
          <Row
            icon={<Inbox className="h-3 w-3" />}
            label="Last outcome"
            value={
              intel.lastOutcome === 'won' ? 'Won' :
              intel.lastOutcome === 'lost' ? 'Lost' :
              intel.lastOutcome === 'open' ? 'Open' : '—'
            }
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: JSX.Element; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-foreground/[0.04] p-2">
      <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground inline-flex items-center gap-1">
        {icon}{label}
      </p>
      <p className="font-bold text-sm tabular-nums">{value}</p>
    </div>
  );
}
function Mini({ icon, label, value }: { icon: JSX.Element; label: string; value: number }) {
  return (
    <div className="inline-flex items-center gap-1 text-muted-foreground">
      {icon}<span>{label}</span><strong className="text-foreground ml-auto">{value}</strong>
    </div>
  );
}
function Row({ icon, label, value }: { icon: JSX.Element; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="text-muted-foreground inline-flex items-center gap-1">{icon}{label}</span>
      <strong className="text-foreground">{value}</strong>
    </div>
  );
}
