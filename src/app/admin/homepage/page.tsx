import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireCapability } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { saveHomepage } from '../actions';
import {
  HOME_EXTRAS,
  HOME_SECTION_LABEL,
  HOME_STATIONS,
  HOME_TEXT_FIELDS,
  type HomeExtra,
  type TextGroup,
  getHomeContent,
  getHomeSectionOrder,
  isStation,
  parseHeroStats,
} from '@/lib/home-sections';
import { getLiveHeroStats } from '@/lib/home-stats';
import { HomepageReorder, HomepagePreview, type ModuleRow } from '@/components/admin/HomepageReorder';
import { AdminActionForm, AdminActionStatus } from '@/components/admin/AdminActionForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Homepage' };

export default async function AdminHomepagePage() {
  await requireCapability('content:cms');
  await ensureSettingsLoaded();

  const extras = getHomeSectionOrder().filter((k): k is HomeExtra => !isStation(k));
  const hc = getHomeContent();
  const popular = hc.popular.join(', ');
  // Only explicit admin stats are pre-filled. When unset the box stays EMPTY
  // (= live counts) — pre-filling the zero placeholders made every unrelated
  // save ship "0 instruments listed" to the live hero.
  const customStats = parseHeroStats(process.env.HERO_STATS);
  const statsText = customStats ? customStats.map((s) => `${s.value}|${s.suffix}|${s.label}`).join('\n') : '';
  const live = customStats ? null : await getLiveHeroStats().catch(() => null);

  const rows: ModuleRow[] = [
    ...extras.map((k) => ({ key: k, label: HOME_SECTION_LABEL[k], enabled: true })),
    ...HOME_EXTRAS.filter((k) => !extras.includes(k)).map((k) => ({ key: k, label: HOME_SECTION_LABEL[k], enabled: false })),
  ];
  const GROUPS: { id: TextGroup; title: string; note?: string }[] = [
    { id: 'intro', title: 'Station 1 — Intro' },
    { id: 'categories', title: 'Station 3 — Instruments', note: 'The cards and the list are the live categories with their real photos and counts.' },
    { id: 'route', title: 'Station 4 — Route (globe)' },
    { id: 'demo', title: 'Station 5 — Buying demo', note: 'The panel shows a real live listing as sample data, and says so.' },
    { id: 'ways', title: 'Station 6 — Ways to buy' },
    { id: 'cta', title: 'Station 7 — Call to action' },
  ];
  const textField = (f: (typeof HOME_TEXT_FIELDS)[number]) => (
    <label key={f.key} className="block">
      <span className="block text-sm font-semibold mb-1.5">{f.label}</span>
      {f.multiline ? (
        <textarea name={f.field} defaultValue={String(hc[f.field] ?? '')} rows={4} className={field} />
      ) : (
        <input name={f.field} defaultValue={String(hc[f.field] ?? '')} className={`${field} h-10`} />
      )}
      {f.hint && <span className="text-xs text-muted-foreground">{f.hint}</span>}
    </label>
  );

  const field =
    'w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Homepage</h1>
        <p className="text-muted-foreground mt-1">
          The homepage is seven 3D stations in a fixed order (every text below is editable), then any extra modules you switch on. Preview the change live on the right.
        </p>
      </div>

      <div className="grid xl:grid-cols-[1fr_640px] gap-6 items-start">
        <AdminActionForm action={saveHomepage} className="space-y-6 min-w-0" statusInChildren>
          <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Stations &amp; extra modules</h2>
            <ol className="grid sm:grid-cols-2 gap-1.5 text-xs text-muted-foreground">
              {HOME_STATIONS.map((k) => <li key={k} className="rounded-lg border border-border px-3 py-2">{HOME_SECTION_LABEL[k]}</li>)}
            </ol>
            <p className="text-xs text-muted-foreground">
              The stations always show, in this order (the 3D story is built on it). Below them you can add extra modules:
              drag to order, toggle the pill to show or hide.
            </p>
            <HomepageReorder initial={rows} />
          </section>

          <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Station 2 — Hero</h2>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">Badge</span>
              <input name="heroBadge" defaultValue={hc.heroBadge} className={`${field} h-10`} />
            </label>
            <div className="grid sm:grid-cols-[2fr_1fr] gap-3">
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">Title</span>
                <input name="heroTitle" defaultValue={hc.heroTitle} className={`${field} h-10`} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">Accent word</span>
                <input name="heroAccent" defaultValue={hc.heroAccent} className={`${field} h-10`} />
              </label>
            </div>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">Subtitle</span>
              <textarea name="heroSubtitle" defaultValue={hc.heroSubtitle} rows={2} className={field} />
            </label>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">Stats</span>
              <textarea
                name="heroStats"
                defaultValue={statsText}
                rows={3}
                placeholder="Empty = live counts from the catalogue"
                className={field}
              />
              <span className="text-xs text-muted-foreground">
                One per line — <code>value|suffix|label</code> (e.g. <code>12400|+|instruments listed</code>).
                Leave empty to show live counts
                {live ? <> (now: {live.map((s) => `${s.value} ${s.label}`).join(' · ')})</> : null}.
              </span>
            </label>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">“Popular:” quick links</span>
              <input name="popular" defaultValue={popular} className={`${field} h-10`} />
              <span className="text-xs text-muted-foreground">
                Comma-separated. Each becomes a search link in the hero.
              </span>
            </label>
          </section>

          <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Call to action &amp; testimonials</h2>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">Testimonials heading</span>
              <input name="testHeading" defaultValue={hc.testHeading} className={`${field} h-10`} />
            </label>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">Testimonials meta line</span>
              <input name="testMeta" defaultValue={hc.testMeta} className={`${field} h-10`} />
            </label>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">CTA heading</span>
              <input name="ctaHeading" defaultValue={hc.ctaHeading} className={`${field} h-10`} />
            </label>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">CTA subtitle</span>
              <textarea name="ctaSubtitle" defaultValue={hc.ctaSubtitle} rows={2} className={field} />
            </label>
          </section>

          {GROUPS.map((g) => (
            <section key={g.id} className="rounded-2xl border border-border bg-card p-6 space-y-4">
              <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">{g.title}</h2>
              {g.note && <p className="text-xs text-muted-foreground">{g.note}</p>}
              {HOME_TEXT_FIELDS.filter((f) => f.group === g.id).map(textField)}
            </section>
          ))}

          <div className="sticky bottom-3 z-10 flex items-center gap-3 bg-background/95 backdrop-blur p-3 rounded-2xl border border-border shadow-sm">
            <Button type="submit" size="lg" className="rounded-2xl font-semibold">
              <Save className="h-4 w-4" /> Save homepage
            </Button>
            <AdminActionStatus />
          </div>
        </AdminActionForm>

        <aside className="xl:sticky xl:top-20 min-w-0">
          <HomepagePreview />
        </aside>
      </div>
    </div>
  );
}
