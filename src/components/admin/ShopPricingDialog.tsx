'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { updateCompanyPricing } from '@/app/admin/actions';
import { PRICING_MODE_LABEL, type ShopPricingMode } from '@/lib/shop-pricing';

interface Props {
  open: boolean;
  shop: { slug: string; name: string; pricingMode: string; pricingMarkupBp: number } | null;
  onClose: () => void;
}

export function ShopPricingDialog({ open, shop, onClose }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<ShopPricingMode>('PASS_THROUGH');
  const [pct, setPct] = useState<string>('0');
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!shop) return;
    setMode(shop.pricingMode as ShopPricingMode);
    setPct((shop.pricingMarkupBp / 100).toString());
    setRes(null);
  }, [shop]);

  if (!open || !shop) return null;

  function save() {
    setRes(null);
    const n = pct.trim() === '' ? 0 : parseFloat(pct);
    if (!Number.isFinite(n) || n < -90 || n > 500) {
      setRes({ ok: false, message: 'Markup must be between -90% and +500%.' });
      return;
    }
    start(async () => {
      const r = await updateCompanyPricing(shop!.slug, { pricingMode: mode, pricingMarkupBp: Math.round(n * 100) });
      setRes(r);
      if (r.ok) {
        router.refresh();
        setTimeout(onClose, 350);
      }
    });
  }

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center" role="dialog" aria-modal>
      <button type="button" onClick={onClose} className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-label="Close" />
      <div className="relative w-full max-w-lg bg-card border border-border rounded-2xl shadow-xl m-4">
        <div className="p-5 border-b border-border flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold">Pricing rule</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Applied at display time for every product from <strong>{shop.name}</strong>.
            </p>
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
                <label key={m} className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                  mode === m ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border hover:bg-foreground/[0.03]'
                }`}>
                  <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} className="mt-1" />
                  <span className="text-sm font-medium">{PRICING_MODE_LABEL[m]}</span>
                </label>
              ))}
            </div>
          </div>
          {mode === 'MARKUP_PERCENT' && (
            <label className="block">
              <span className="block text-sm font-semibold mb-1">Markup percent</span>
              <span className="block text-xs text-muted-foreground mb-1.5">
                Positive raises the price (e.g. <code>5</code> = +5%). Negative discounts.
              </span>
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
