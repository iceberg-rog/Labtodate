import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireCapability } from '@/lib/auth-server';
import { ensureSettingsLoaded } from '@/lib/settings';
import { saveHomepage } from '../actions';
import {
  HOME_SECTIONS,
  HOME_SECTION_LABEL,
  type HomeSection,
  getHomeContent,
} from '@/lib/home-sections';
import { HomepageReorder, HomepagePreview, type ModuleRow } from '@/components/admin/HomepageReorder';

export const dynamic = 'force-dynamic';

export default async function AdminHomepagePage() {
  await requireCapability('content:cms');
  await ensureSettingsLoaded();

  const configured = (process.env.HOMEPAGE_SECTIONS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is HomeSection => (HOME_SECTIONS as readonly string[]).includes(s));
  const order: HomeSection[] = configured.length ? configured : [...HOME_SECTIONS];
  const hc = getHomeContent();
  const popular = hc.popular.join(', ');
  const statsText = hc.stats.map((s) => `${s.value}|${s.suffix}|${s.label}`).join('\n');

  const rows: ModuleRow[] = [
    ...order.map((k) => ({ key: k, label: HOME_SECTION_LABEL[k], enabled: true })),
    ...HOME_SECTIONS.filter((k) => !order.includes(k)).map((k) => ({
      key: k,
      label: HOME_SECTION_LABEL[k],
      enabled: false,
    })),
  ];

  const field =
    'w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Homepage</h1>
        <p className="text-muted-foreground mt-1">
          Drag modules to reorder, toggle to show/hide, edit hero copy + stats — preview the change live on the right.
        </p>
      </div>

      <div className="grid xl:grid-cols-[1fr_640px] gap-6 items-start">
        <form action={saveHomepage} className="space-y-6 min-w-0">
          <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Modules &amp; order</h2>
            <p className="text-xs text-muted-foreground">
              Order is the position you see; toggle the right-hand pill to hide a module entirely.
            </p>
            <HomepageReorder initial={rows} />
          </section>

          <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Hero content</h2>
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
              <textarea name="heroStats" defaultValue={statsText} rows={3} className={field} />
              <span className="text-xs text-muted-foreground">
                One per line — <code>value|suffix|label</code> (e.g. <code>12400|+|instruments listed</code>).
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
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Testimonials &amp; CTA</h2>
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

          <div className="sticky bottom-3 z-10 flex items-center gap-3 bg-background/95 backdrop-blur p-3 rounded-2xl border border-border shadow-sm">
            <Button type="submit" size="lg" className="rounded-2xl font-semibold">
              <Save className="h-4 w-4" /> Save homepage
            </Button>
            <span className="text-xs text-muted-foreground">
              Then click ↻ Refresh in the preview panel to see the result.
            </span>
          </div>
        </form>

        <aside className="xl:sticky xl:top-20 min-w-0">
          <HomepagePreview />
        </aside>
      </div>
    </div>
  );
}
