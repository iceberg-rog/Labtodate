'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Play, Eye, BadgeCheck, FileSignature, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  syncShop,
  updateShopSyncSettings,
  verifyShop,
  unverifyShop,
  setShopAgreement,
  agreementEndImpact,
} from '@/app/admin/catalog-actions';

type Msg = { ok: boolean; text: string } | null;

function Status({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <p
      role="status"
      className={`text-sm font-medium rounded-lg px-3 py-2 border ${
        msg.ok
          ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-300'
          : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300'
      }`}
    >
      {msg.text}
    </p>
  );
}

const input =
  'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

// ─── Run ─────────────────────────────────────────────────────────────────────

export function ShopSyncRunButtons({ slug, blockedReason }: { slug: string; blockedReason: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<'dry' | 'real' | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [attention, setAttention] = useState<string[]>([]);
  const [allowMass, setAllowMass] = useState(false);

  function go(dryRun: boolean) {
    if (!dryRun && !confirm(allowMass
      ? 'Run the sync now and archive EVERY item that is missing at the source, even beyond the safety stop? Use this only after you checked the source.'
      : 'Run the sync now? It changes prices and availability (large price changes wait for your review), (per this shop’s policy) content, archives items removed at the source, and adds new items.')) return;
    setMsg(null);
    setRunId(null);
    setAttention([]);
    setWhich(dryRun ? 'dry' : 'real');
    start(async () => {
      try {
        const r = await syncShop(slug, dryRun, { allowMassArchive: allowMass });
        setMsg({ ok: r.ok, text: r.message });
        setRunId(r.runId ?? null);
        setAttention(r.attention ?? []);
        if (!dryRun) setAllowMass(false);
        router.refresh();
      } catch {
        setMsg({ ok: false, text: 'The sync request did not complete (connection or server error). Open the run list below to see whether it ran.' });
      } finally {
        setWhich(null);
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={() => go(true)} disabled={pending} className="rounded-full font-semibold">
          {which === 'dry' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
          Dry run (show what would change)
        </Button>
        <Button type="button" onClick={() => go(false)} disabled={pending || !!blockedReason} className="rounded-full font-semibold" title={blockedReason ?? undefined}>
          {which === 'real' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run sync now
        </Button>
      </div>
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input type="checkbox" className="mt-0.5 accent-primary" checked={allowMass} onChange={(e) => setAllowMass(e.target.checked)} name="allowMassArchive" />
        <span>For the next real sync only: archive items missing at the source even beyond the safety stop (Settings → Import &amp; suppliers). Use it after a safety stop when you checked that they really are gone.</span>
      </label>
      {blockedReason && <p className="text-xs text-amber-800 dark:text-amber-300">{blockedReason}</p>}
      {pending && <p className="text-xs text-muted-foreground">Reading the whole source catalogue first — this can take a minute for large shops.</p>}
      <Status msg={msg} />
      {attention.length > 0 && (
        <ul className="text-sm rounded-lg px-3 py-2 border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-300 space-y-1" data-testid="sync-attention">
          {attention.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      {runId && (
        <Link href={`/admin/companies/${slug}/runs/${runId}`} className="text-sm font-semibold text-primary hover:underline">
          Open the full report →
        </Link>
      )}
    </div>
  );
}

// ─── Policy ──────────────────────────────────────────────────────────────────

export interface SyncSettingsValue {
  syncPolicy: 'PRICE_STOCK_ONLY' | 'CONTENT_TOO';
  syncStockMode: 'SUBTRACT_LOCAL_SALES' | 'SOURCE_IS_TRUTH';
  autoPublishImports: boolean;
  archiveMissingAtSource: boolean;
  importCondition: 'NEW' | 'REFURBISHED' | 'USED';
  importDefaultQuantity: number;
  syncIntervalMinutes: number | null;
  /** A26: the source shows prices incl. VAT → converted to net on import. */
  importPricesIncludeVat: boolean;
  importVatRateBp: number | null;
}

export function ShopSyncSettingsForm({ slug, initial, conditionLabels }: { slug: string; initial: SyncSettingsValue; conditionLabels: Record<string, string> }) {
  const router = useRouter();
  const [v, setV] = useState<SyncSettingsValue>(initial);
  const [qty, setQty] = useState(String(initial.importDefaultQuantity));
  const [intervalStr, setIntervalStr] = useState(initial.syncIntervalMinutes ? String(initial.syncIntervalMinutes) : '');
  const [vatRateStr, setVatRateStr] = useState(initial.importVatRateBp != null ? String(initial.importVatRateBp / 100) : '');
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);

  function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const payload: SyncSettingsValue = {
      ...v,
      importDefaultQuantity: Number(qty),
      syncIntervalMinutes: intervalStr ? Number(intervalStr) : null,
      importVatRateBp: vatRateStr.trim() ? Math.round(Number(vatRateStr.replace(',', '.')) * 100) : null,
    };
    start(async () => {
      try {
        const r = await updateShopSyncSettings(slug, payload);
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh();
      } catch {
        setMsg({ ok: false, text: 'Not saved (connection or server error). Reload the page and try again.' });
      }
    });
  }

  return (
    <form onSubmit={save} className="space-y-4" data-testid="sync-settings">
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block">
          <span className="block text-sm font-semibold mb-1">What a sync may change</span>
          <select className={input} value={v.syncPolicy} onChange={(e) => setV({ ...v, syncPolicy: e.target.value as SyncSettingsValue['syncPolicy'] })} name="syncPolicy">
            <option value="PRICE_STOCK_ONLY">Price and availability only (recommended)</option>
            <option value="CONTENT_TOO">Also title, texts and photos (except locked fields)</option>
          </select>
          <span className="block text-xs text-muted-foreground mt-1">Category, brand, condition, warranty and publish status are always yours.</span>
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1">Stock</span>
          <select className={input} value={v.syncStockMode} onChange={(e) => setV({ ...v, syncStockMode: e.target.value as SyncSettingsValue['syncStockMode'] })} name="syncStockMode">
            <option value="SUBTRACT_LOCAL_SALES">Source stock minus units sold on lab2date</option>
            <option value="SOURCE_IS_TRUTH">Source stock as-is (supplier updates it after our orders)</option>
          </select>
          <span className="block text-xs text-muted-foreground mt-1">Out of stock / backorder / removed at the source always means not available here.</span>
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1">New items from this shop are</span>
          <select className={input} value={v.autoPublishImports ? 'yes' : 'no'} onChange={(e) => setV({ ...v, autoPublishImports: e.target.value === 'yes' })} name="autoPublishImports">
            <option value="no">Held for review (Pending review)</option>
            <option value="yes">Published immediately</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1">Items removed at the source</span>
          <select className={input} value={v.archiveMissingAtSource ? 'archive' : 'keep'} onChange={(e) => setV({ ...v, archiveMissingAtSource: e.target.value === 'archive' })} name="archiveMissingAtSource">
            <option value="archive">Archive them (never re-published automatically)</option>
            <option value="keep">Keep listed as “not available”</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1">Condition given to new items</span>
          <select className={input} value={v.importCondition} onChange={(e) => setV({ ...v, importCondition: e.target.value as SyncSettingsValue['importCondition'] })} name="importCondition">
            {(['USED', 'REFURBISHED', 'NEW'] as const).map((c) => (
              <option key={c} value={c}>{conditionLabels[c] ?? c}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1">Quantity when the source shows “in stock” without a number</span>
          <input className={input} type="number" min={1} max={1000} step={1} value={qty} onChange={(e) => setQty(e.target.value)} name="importDefaultQuantity" />
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1">Automatic sync every … minutes</span>
          <input className={input} type="number" min={15} max={10080} step={5} value={intervalStr} onChange={(e) => setIntervalStr(e.target.value)} placeholder="Off — manual only" name="syncIntervalMinutes" />
          <span className="block text-xs text-muted-foreground mt-1">Blank = manual only. Runs from the cron job (every 15 min check). Failures notify admins.</span>
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1">Prices at the source</span>
          <select className={input} value={v.importPricesIncludeVat ? 'incl' : 'excl'} onChange={(e) => setV({ ...v, importPricesIncludeVat: e.target.value === 'incl' })} name="importPricesIncludeVat">
            <option value="excl">Are excl. VAT — imported as they are</option>
            <option value="incl">Include VAT — converted to excl. VAT on import</option>
          </select>
          <span className="block text-xs text-muted-foreground mt-1">Our catalogue stores net prices. Check how the shop displays its prices (e.g. “incl. BTW”) before the first sync; it applies to every price the next sync reads.</span>
        </label>
        {v.importPricesIncludeVat && (
          <label className="block">
            <span className="block text-sm font-semibold mb-1">VAT rate included in those prices (%)</span>
            <input className={input} inputMode="decimal" value={vatRateStr} onChange={(e) => setVatRateStr(e.target.value)} placeholder="Standard rate (Settings → Tax & VAT)" name="importVatRate" />
          </label>
        )}
      </div>
      <Button type="submit" disabled={pending} className="rounded-full font-semibold">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save sync settings
      </Button>
      <Status msg={msg} />
    </form>
  );
}

// ─── Verification ────────────────────────────────────────────────────────────

export function ShopVerifyForm({ slug, verified }: { slug: string; verified: { at: string; by: string | null; note: string | null } | null }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);

  function run(fn: () => Promise<{ ok: boolean; message: string }>) {
    setMsg(null);
    start(async () => {
      try {
        const r = await fn();
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) {
          setNote('');
          router.refresh();
        }
      } catch {
        setMsg({ ok: false, text: 'Not saved (connection or server error). Reload the page and try again.' });
      }
    });
  }

  return (
    <div className="space-y-3" data-testid="verify-form">
      {verified ? (
        <div className="text-sm">
          <p className="inline-flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-300">
            <BadgeCheck className="h-4 w-4" /> Verified on {new Date(verified.at).toLocaleDateString('en-GB', { dateStyle: 'medium' })}
            {verified.by ? ` by ${verified.by}` : ''}
          </p>
          {verified.note && <p className="text-muted-foreground mt-1">Checked: {verified.note}</p>}
          <Button type="button" variant="outline" size="sm" className="rounded-full mt-2" disabled={pending} onClick={() => run(() => unverifyShop(slug))}>
            Remove verification
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Not verified. Product pages say “Sourced from a supplier we verified” only after you record what you checked.
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={1000}
            name="verificationNote"
            placeholder="What did you check? e.g. KvK 12345678 and VAT NL… valid in VIES on 3 Oct 2026; called two references."
            className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm"
          />
          <Button type="button" size="sm" className="rounded-full font-semibold" disabled={pending} onClick={() => run(() => verifyShop(slug, note))}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Mark verified
          </Button>
        </>
      )}
      <Status msg={msg} />
    </div>
  );
}

// ─── Agreement ───────────────────────────────────────────────────────────────

export function ShopAgreementForm({
  slug,
  initial,
}: {
  slug: string;
  initial: { status: 'NONE' | 'SENT' | 'SIGNED' | 'OWN_SHOP' | 'TERMINATED'; signedAt: string | null; note: string | null };
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initial.status);
  const [signedAt, setSignedAt] = useState(initial.signedAt ?? '');
  const [note, setNote] = useState(initial.note ?? '');
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);

  function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      try {
        if (status === 'TERMINATED' && initial.status !== 'TERMINATED') {
          const impact = await agreementEndImpact(slug);
          const what = impact
            ? impact.action === 'ARCHIVE_LISTINGS'
              ? `${impact.live} listing(s) of this shop will be ARCHIVED and no longer sold.`
              : `Its ${impact.live} listing(s) stay on sale (Settings say “only warn”).`
            : '';
          const open = impact && (impact.openOrders || impact.openQuotes) ? ` ${impact.openOrders} open order(s) and ${impact.openQuotes} open quote(s) include its items.` : '';
          if (!confirm(`Terminate the supplier agreement? ${what}${open} Syncs will be blocked.`)) return;
        }
        const r = await setShopAgreement(slug, { status, signedAt: signedAt || null, note: note || null });
        setMsg({ ok: r.ok, text: r.message });
        if (r.ok) router.refresh();
      } catch {
        setMsg({ ok: false, text: 'Not saved (connection or server error). Reload the page and try again.' });
      }
    });
  }

  return (
    <form onSubmit={save} className="space-y-3" data-testid="agreement-form">
      <div className="grid sm:grid-cols-3 gap-3">
        <label className="block">
          <span className="block text-sm font-semibold mb-1">Status</span>
          <select className={input} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} name="agreementStatus">
            <option value="NONE">No agreement</option>
            <option value="SENT">Sent, not signed</option>
            <option value="SIGNED">Signed</option>
            <option value="OWN_SHOP">Our own shop (no agreement needed)</option>
            <option value="TERMINATED">Terminated</option>
          </select>
        </label>
        {status === 'SIGNED' && (
          <label className="block">
            <span className="block text-sm font-semibold mb-1">Signed on</span>
            <input className={input} type="date" value={signedAt} onChange={(e) => setSignedAt(e.target.value)} name="agreementSignedAt" />
          </label>
        )}
        <label className={`block ${status === 'SIGNED' ? '' : 'sm:col-span-2'}`}>
          <span className="block text-sm font-semibold mb-1">Note</span>
          <input className={input} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Version, where the signed copy is filed…" name="agreementNote" />
        </label>
      </div>
      <Button type="submit" size="sm" disabled={pending} className="rounded-full font-semibold">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSignature className="h-4 w-4" />} Save agreement status
      </Button>
      <Status msg={msg} />
    </form>
  );
}
