'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  BadgeCheck, Star, ExternalLink, Sparkles, Package, Cloud, Settings as SettingsIcon,
  ChevronRight, ShieldCheck, AlertTriangle, Loader2, Ban,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ShopPreviewDialog } from '@/components/admin/ShopPreviewDialog';
import { ShopPricingDialog } from '@/components/admin/ShopPricingDialog';
import { setCompanyVerified, setCompanyFeatured, blockSupplier } from '@/app/admin/actions';

export interface ShopRow {
  id: string;
  slug: string;
  name: string;
  country: string | null;
  isVerified: boolean;
  isFeatured: boolean;
  productCount: number;
  userCount: number;
  importSourceUrl: string | null;
  lastImportedAt: string | null;
  pricingMode: string;
  pricingMarkupBp: number;
  suggestedByAi: boolean;
  aiRiskScore: number | null;
  aiRiskNotes: string | null;
  aiAnalyzedAt: string | null;
}

type Bucket = 'imported' | 'suggested' | 'manual';

function bucketOf(s: ShopRow): Bucket {
  if (s.lastImportedAt || s.productCount > 0) return 'imported';
  if (s.suggestedByAi) return 'suggested';
  return 'manual';
}

export function CompaniesBoard({ shops, categories }: { shops: ShopRow[]; categories: { slug: string; name: string }[] }) {
  const [openShop, setOpenShop] = useState<ShopRow | null>(null);
  const [pricingShop, setPricingShop] = useState<ShopRow | null>(null);

  const grouped: Record<Bucket, ShopRow[]> = { imported: [], suggested: [], manual: [] };
  for (const s of shops) grouped[bucketOf(s)].push(s);

  return (
    <div className="space-y-6">
      {grouped.imported.length > 0 && (
        <Section
          title="Imported"
          subtitle="Live in your marketplace — products visible to buyers."
          tone="emerald"
          count={grouped.imported.length}
        >
          {grouped.imported.map((s) => (
            <ShopCard key={s.id} shop={s} bucket="imported" onOpen={() => setOpenShop(s)} onOpenPricing={() => setPricingShop(s)} />
          ))}
        </Section>
      )}

      {grouped.suggested.length > 0 && (
        <Section
          title="AI suggested"
          subtitle="Claude proposed these. Click each to preview and decide whether to import."
          tone="purple"
          count={grouped.suggested.length}
        >
          {grouped.suggested.map((s) => (
            <ShopCard key={s.id} shop={s} bucket="suggested" onOpen={() => setOpenShop(s)} onOpenPricing={() => setPricingShop(s)} />
          ))}
        </Section>
      )}

      {grouped.manual.length > 0 && (
        <Section
          title="Manual / awaiting import"
          subtitle="Created manually with no Cloud API URL, or import URL set but never run."
          tone="muted"
          count={grouped.manual.length}
        >
          {grouped.manual.map((s) => (
            <ShopCard key={s.id} shop={s} bucket="manual" onOpen={() => setOpenShop(s)} onOpenPricing={() => setPricingShop(s)} />
          ))}
        </Section>
      )}

      {shops.length === 0 && (
        <div className="rounded-2xl border-2 border-dashed border-border bg-foreground/[0.02] p-12 text-center">
          <p className="font-semibold">No shops yet</p>
          <p className="text-sm text-muted-foreground mt-1">Use “Add shop” or “Find more shops with AI” to start.</p>
        </div>
      )}

      <ShopPreviewDialog open={!!openShop} shop={openShop} categories={categories} onClose={() => setOpenShop(null)} />
      <ShopPricingDialog open={!!pricingShop} shop={pricingShop} onClose={() => setPricingShop(null)} />
    </div>
  );
}

function Section({
  title, subtitle, count, tone, children,
}: {
  title: string;
  subtitle: string;
  count: number;
  tone: 'emerald' | 'purple' | 'muted';
  children: React.ReactNode;
}) {
  const dot =
    tone === 'emerald' ? 'bg-emerald-500' :
    tone === 'purple' ? 'bg-purple-500' :
    'bg-foreground/30';
  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <h2 className="text-sm font-bold uppercase tracking-wider">{title}</h2>
        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-foreground/10 text-foreground text-[10px] font-bold uppercase tracking-wider tabular-nums">{count}</span>
        <p className="text-xs text-muted-foreground hidden sm:block">{subtitle}</p>
      </div>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">{children}</ul>
    </section>
  );
}

function ShopCard({
  shop, bucket, onOpen, onOpenPricing,
}: {
  shop: ShopRow;
  bucket: Bucket;
  onOpen: () => void;
  onOpenPricing: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const bg =
    bucket === 'imported' ? 'border-emerald-200 hover:border-emerald-400' :
    bucket === 'suggested' ? 'border-purple-200 hover:border-purple-400' :
    'border-border hover:border-foreground/30';

  let host = '';
  try { if (shop.importSourceUrl) host = new URL(shop.importSourceUrl).hostname.replace(/^www\./, ''); } catch {}

  function toggleVerified(e: React.MouseEvent) {
    e.stopPropagation();
    start(async () => { await setCompanyVerified(shop.slug, !shop.isVerified); router.refresh(); });
  }
  function toggleFeatured(e: React.MouseEvent) {
    e.stopPropagation();
    start(async () => { await setCompanyFeatured(shop.slug, !shop.isFeatured); router.refresh(); });
  }
  function block(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Block “${shop.name}” permanently?\nIt will be removed and its hostname added to the AI-suggest blocklist.`)) return;
    start(async () => { await blockSupplier(shop.slug, 'rejected from list'); router.refresh(); });
  }

  return (
    <li>
      <div className={`relative rounded-2xl border-2 bg-card p-4 transition-colors ${bg}`}>
        <button
          type="button"
          onClick={onOpen}
          className="absolute inset-0 z-0"
          aria-label={`Open ${shop.name}`}
        />
        <div className="relative z-10 pointer-events-none">
          <div className="flex items-start gap-3">
            <div className="h-12 w-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold flex-shrink-0">
              {shop.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className="font-bold truncate">{shop.name}</p>
                {shop.isVerified && (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-[9px] font-bold uppercase tracking-wider">
                    <BadgeCheck className="h-2.5 w-2.5" /> Verified
                  </span>
                )}
                {shop.isFeatured && <Badge variant="accent">Featured</Badge>}
                {bucket === 'imported' && (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-900 text-[9px] font-bold uppercase tracking-wider">
                    ✓ Imported
                  </span>
                )}
                {bucket === 'suggested' && (
                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-900 text-[9px] font-bold uppercase tracking-wider">
                    <Sparkles className="h-2.5 w-2.5" /> AI suggested
                  </span>
                )}
                <PricingChip mode={shop.pricingMode} bp={shop.pricingMarkupBp} />
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                <span>{shop.country ?? '—'}</span>
                <span className="inline-flex items-center gap-1">
                  <Package className="h-3 w-3" /> <span className="tabular-nums font-semibold">{shop.productCount}</span>
                </span>
                {host && <span className="inline-flex items-center gap-0.5"><ExternalLink className="h-3 w-3" /> {host}</span>}
                {shop.lastImportedAt && <span className="text-muted-foreground/80">last sync {new Date(shop.lastImportedAt).toLocaleDateString()}</span>}
              </p>
              {shop.aiRiskScore != null && shop.aiRiskNotes && (
                <p className={`text-[11px] mt-1.5 inline-flex items-start gap-1 px-2 py-1 rounded-md ${
                  shop.aiRiskScore >= 70 ? 'bg-emerald-50 text-emerald-900' :
                  shop.aiRiskScore >= 40 ? 'bg-amber-50 text-amber-900' :
                  'bg-red-50 text-red-900'
                }`}>
                  {shop.aiRiskScore >= 70 ? <ShieldCheck className="h-3 w-3 mt-0.5" /> : <AlertTriangle className="h-3 w-3 mt-0.5" />}
                  <span className="line-clamp-2"><strong>AI {shop.aiRiskScore}/100:</strong> {shop.aiRiskNotes}</span>
                </p>
              )}
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
          </div>
        </div>

        {/* Action buttons (pointer-events-auto raises above the absolute-positioned hit area) */}
        <div className="relative z-10 mt-3 flex items-center gap-1.5 flex-wrap pointer-events-auto">
          <Button type="button" variant="outline" size="sm" onClick={toggleVerified} disabled={pending} className="rounded-full text-xs">
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {shop.isVerified ? 'Unverify' : 'Verify'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={toggleFeatured} disabled={pending} className="rounded-full text-xs">
            <Star className="h-3 w-3" /> {shop.isFeatured ? 'Unfeature' : 'Feature'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); onOpenPricing(); }} className="rounded-full text-xs">
            <SettingsIcon className="h-3 w-3" /> Pricing
          </Button>
          {shop.importSourceUrl && (
            <Button type="button" variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); onOpen(); }} className="rounded-full text-xs">
              <Cloud className="h-3 w-3" /> {bucket === 'imported' ? 'Preview / sync' : 'Preview'}
            </Button>
          )}
          {bucket === 'suggested' && (
            <Button type="button" variant="outline" size="sm" onClick={block} disabled={pending} className="rounded-full text-xs text-red-700 border-red-200 hover:bg-red-50 ml-auto">
              <Ban className="h-3 w-3" /> Block
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function PricingChip({ mode, bp }: { mode: string; bp: number }) {
  if (mode === 'PASS_THROUGH') return null;
  const tone =
    mode === 'FORCE_QUOTE' ? 'bg-amber-100 text-amber-900' :
    mode === 'HIDE_PRICE'  ? 'bg-foreground/10 text-foreground' :
    bp > 0 ? 'bg-emerald-100 text-emerald-900' :
    bp < 0 ? 'bg-red-100 text-red-900' : 'bg-foreground/10 text-foreground';
  const label =
    mode === 'FORCE_QUOTE' ? 'Quote-only' :
    mode === 'HIDE_PRICE'  ? 'Hide price' :
    mode === 'MARKUP_PERCENT' ? `${bp >= 0 ? '+' : ''}${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%` : '';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${tone}`}>
      {label}
    </span>
  );
}
