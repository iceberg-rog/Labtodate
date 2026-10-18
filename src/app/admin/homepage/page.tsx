import { Clock } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, listSettingChanges, normaliseInput, settingDef } from '@/lib/settings';
import { HOME_KEYS, draftRead, envRead, isHomeKey, homeValue } from '@/lib/home-sections';
import { LIVE_PRODUCT_WHERE } from '@/lib/marketplace/queries';
import { getStationCategories } from '@/lib/home-landing-data';
import { homeEditorValues, readHomeDraft } from '@/lib/home/draft';
import { siteName } from '@/lib/brand/identity';
import { SettingRevertButton } from '@/components/admin/SettingRevertButton';
import { HomepageEditor } from './HomepageEditor';
import { revertHomepageChange } from './actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Homepage' };

const fmtWhen = (d: Date) => d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export default async function AdminHomepagePage() {
  await requireCapability('content:cms');
  await ensureSettingsLoaded();

  const draft = await readHomeDraft();
  const live = homeEditorValues(envRead);
  const values = draft ? homeEditorValues(draftRead(draft.values)) : live;
  const norm = (k: string, v: string) => {
    const d = settingDef(k);
    return (d ? normaliseInput(d, v) : v) || homeValue(() => '', k);
  };
  const changed = draft ? HOME_KEYS.filter((k) => norm(k, values[k] ?? '') !== norm(k, live[k] ?? '')) : [];

  const [cats, products, auto, history] = await Promise.all([
    prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { slug: true, name: true, icon: true, imageUrl: true, showOnHome: true, _count: { select: { products: { where: LIVE_PRODUCT_WHERE } } } },
    }),
    prisma.product.findMany({ where: LIVE_PRODUCT_WHERE, orderBy: { createdAt: 'desc' }, take: 3000, select: { slug: true, title: true } }),
    getStationCategories([], Number(live.HOME_CAT_MAX) || 9, { photos: false }).catch(() => []),
    listSettingChanges({ take: 400 }),
  ]);
  const homeHistory = history.filter((h) => isHomeKey(h.key)).slice(0, 50);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Homepage</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl">
          Choose which 3D stations show and in what order, the categories and listings they show, and every text, button and link on them.
          Save a draft to see it in the preview, then publish it. Category names, icons and pictures are edited in Admin → Categories.
        </p>
      </div>

      <HomepageEditor
        key={draft?.savedAt ?? 'live'}
        values={values}
        changed={changed}
        draft={draft ? { token: draft.token, savedAt: draft.savedAt, by: draft.by } : null}
        categories={cats.map((c) => ({ slug: c.slug, name: c.name, icon: c.icon, live: c._count.products, hasImage: !!c.imageUrl, showOnHome: c.showOnHome }))}
        products={products}
        autoCategories={auto.map((c) => c.name)}
        siteName={siteName()}
      />

      <section className="rounded-2xl border border-border bg-card p-6 space-y-3" data-tool="homepage-history">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Change history</h2>
        </div>
        <p className="text-xs text-muted-foreground">Every published homepage change, newest first. “Revert” puts the old value back on the live homepage — itself recorded as a new change.</p>
        {homeHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">No homepage changes published yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-1.5 pr-3">When</th><th className="py-1.5 pr-3">Field</th><th className="py-1.5 pr-3">From</th><th className="py-1.5 pr-3">To</th><th className="py-1.5 pr-3">By</th><th className="py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {homeHistory.map((h) => (
                  <tr key={h.id} className="border-t border-border align-top" data-change={h.key}>
                    <td className="py-2 pr-3 whitespace-nowrap text-xs">{fmtWhen(h.createdAt)}</td>
                    <td className="py-2 pr-3"><span className="font-semibold">{h.label}</span>{h.source !== 'ADMIN' && <span className="block text-[11px] text-muted-foreground">{h.source.toLowerCase()}</span>}</td>
                    <td className="py-2 pr-3 text-xs font-mono max-w-64 break-words whitespace-pre-wrap">{h.oldValue ?? <span className="text-muted-foreground">(default)</span>}</td>
                    <td className="py-2 pr-3 text-xs font-mono max-w-64 break-words whitespace-pre-wrap">{h.newValue ?? <span className="text-muted-foreground">(default)</span>}</td>
                    <td className="py-2 pr-3 text-xs">{h.actorEmail ?? '—'}</td>
                    <td className="py-2">
                      {h.revertable && (
                        <SettingRevertButton action={revertHomepageChange} changeId={h.id} confirmText={`Put “${h.label}” back to ${h.oldValue ? `“${h.oldValue.slice(0, 80)}”` : 'its default'} on the live homepage?`} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
