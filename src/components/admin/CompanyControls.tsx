'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, RefreshCw, Loader2, X, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { updateCompanyPricing, importShopProducts } from '@/app/admin/actions';
import { PRICING_MODE_LABEL, type ShopPricingMode } from '@/lib/shop-pricing';

interface Props {
  slug: string;
  name: string;
  pricingMode: ShopPricingMode;
  pricingMarkupBp: number;
  importSourceUrl: string | null;
}

export function CompanyControls({ slug, name, pricingMode, pricingMarkupBp, importSourceUrl }: Props) {
  const router = useRouter();
  const [openPricing, setOpenPricing] = useState(false);
  const [importing, startImport] = useTransition();
  const [importMsg, setImportMsg] = useState<{ ok: boolean; message: string } | null>(null);

  function runImport() {
    setImportMsg(null);
    startImport(async () => {
      const r = await importShopProducts(slug);
      setImportMsg(r);
      if (r.ok) router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="rounded-full font-medium"
        onClick={() => setOpenPricing(true)}
      >
        <Settings className="h-3.5 w-3.5" /> Pricing
      </Button>
      {importSourceUrl && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full font-medium"
          onClick={runImport}
          disabled={importing}
        >
          {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Sync products
        </Button>
      )}
      {importMsg && (
        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${importMsg.ok ? 'text-emerald-700' : 'text-red-700'}`}>
          {importMsg.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
          {importMsg.message}
        </span>
      )}

      {openPricing && (
        <PricingDialog
          slug={slug}
          name={name}
          initialMode={pricingMode}
          initialBp={pricingMarkupBp}
          onClose={() => setOpenPricing(false)}
          onSaved={() => { setOpenPricing(false); router.refresh(); }}
        />
      )}
    </>
  );
}

function PricingDialog({
  slug, name, initialMode, initialBp, onClose, onSaved,
}: {
  slug: string;
  name: string;
  initialMode: ShopPricingMode;
  initialBp: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<ShopPricingMode>(initialMode);
  const [pct, setPct] = useState<string>((initialBp / 100).toString());
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);

  function save() {
    setRes(null);
    const pctNum = pct.trim() === '' ? 0 : parseFloat(pct);
    if (!Number.isFinite(pctNum) || pctNum < -90 || pctNum > 500) {
      setRes({ ok: false, message: 'Markup must be between -90% and +500%.' });
      return;
    }
    start(async () => {
      const r = await updateCompanyPricing(slug, { pricingMode: mode, pricingMarkupBp: Math.round(pctNum * 100) });
      setRes(r);
      if (r.ok) setTimeout(onSaved, 400);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal>
      <button type="button" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-label="Close" />
      <div className="relative w-full max-w-lg bg-card border border-border rounded-2xl shadow-xl m-4">
        <div className="p-5 border-b border-border flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold">Pricing rule</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Applied at display time for every product from <strong>{name}</strong>.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-foreground/5">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="space-y-1.5">
            <span className="text-sm font-semibold">Mode</span>
            <div className="space-y-1.5">
              {(['PASS_THROUGH', 'MARKUP_PERCENT', 'FORCE_QUOTE', 'HIDE_PRICE'] as ShopPricingMode[]).map((m) => (
                <label key={m} className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${mode === m ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border hover:bg-foreground/[0.03]'}`}>
                  <input
                    type="radio"
                    name="mode"
                    checked={mode === m}
                    onChange={() => setMode(m)}
                    className="mt-1"
                  />
                  <span className="text-sm font-medium">{PRICING_MODE_LABEL[m]}</span>
                </label>
              ))}
            </div>
          </div>
          {mode === 'MARKUP_PERCENT' && (
            <label className="block">
              <span className="block text-sm font-semibold mb-1">Markup percent</span>
              <span className="block text-xs text-muted-foreground mb-1.5">Positive raises the price (e.g. <code>5</code> = +5%). Negative discounts (e.g. <code>-2.5</code>).</span>
              <input
                type="number"
                step="0.1"
                min={-90}
                max={500}
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
              />
            </label>
          )}
          {res && (
            <p className={`text-xs font-semibold ${res.ok ? 'text-emerald-700' : 'text-red-700'}`}>{res.message}</p>
          )}
        </div>
        <div className="p-5 border-t border-border flex gap-2 justify-end">
          <Button type="button" variant="ghost" onClick={onClose} className="rounded-full">Cancel</Button>
          <Button type="button" onClick={save} disabled={pending} className="rounded-full font-semibold">
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save rule
          </Button>
        </div>
      </div>
    </div>
  );
}
