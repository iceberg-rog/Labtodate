'use client';

import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Eye, Plus, Rocket, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AdminActionForm, AdminActionStatus } from '@/components/admin/AdminActionForm';
import { HomepagePreview, HomepageReorder, type ModuleRow } from '@/components/admin/HomepageReorder';
import { CategoryIcon } from '@/components/home/CategoryIcon';
import {
  HOME_EXTRAS,
  HOME_FIELDS,
  HOME_GROUP_SECTION,
  HOME_GROUP_TITLE,
  HOME_SECTION_LABEL,
  HOME_STATIONS,
  type HomeField,
  type HomeFieldGroup,
  parseRailNames,
  parseSlugList,
  parseStations,
} from '@/lib/home-sections';
import { submitHomepage } from './actions';

export interface EditorCategory {
  slug: string;
  name: string;
  icon: string | null;
  live: number;
  hasImage: boolean;
  showOnHome: boolean;
}
export interface EditorProduct {
  slug: string;
  title: string;
}

const input = 'w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';
const small = 'h-9 px-2.5 rounded-lg border border-input bg-background text-xs';

/** “Label|/link” as two inputs (one setting). */
function LinkField({ f, value, changed }: { f: HomeField; value: string; changed: boolean }) {
  const [l0, ...rest] = value.split('|');
  const [label, setLabel] = useState(l0 ?? '');
  const [href, setHref] = useState(rest.join('|'));
  return (
    <div className="block">
      <FieldLabel f={f} changed={changed} />
      <div className="grid sm:grid-cols-[1.4fr_1fr] gap-2">
        <input aria-label={`${f.label} — label`} value={label} onChange={(e) => setLabel(e.target.value)} className={`${input} h-10`} />
        <input aria-label={`${f.label} — link`} value={href} onChange={(e) => setHref(e.target.value)} placeholder="/page or https://…" className={`${input} h-10 font-mono text-xs`} />
      </div>
      <input type="hidden" name={f.key} value={label.trim() ? `${label.trim()}${href.trim() ? `|${href.trim()}` : ''}` : ''} />
      {f.hint && <span className="text-xs text-muted-foreground">{f.hint}</span>}
    </div>
  );
}

function FieldLabel({ f, changed }: { f: HomeField; changed: boolean }) {
  return (
    <span className="flex items-center gap-2 text-sm font-semibold mb-1.5">
      {f.label}
      {changed && <span className="text-[10px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5 bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">draft</span>}
    </span>
  );
}

function TextField({ f, value, changed }: { f: HomeField; value: string; changed: boolean }) {
  if (f.kind === 'link') return <LinkField f={f} value={value} changed={changed} />;
  return (
    <label className="block">
      <FieldLabel f={f} changed={changed} />
      {f.kind === 'text' ? (
        <textarea name={f.key} defaultValue={value} rows={Math.min(8, Math.max(2, value.split('\n').length + 1))} className={`${input} font-mono text-xs leading-relaxed`} />
      ) : f.kind === 'int' ? (
        <input name={f.key} type="number" min={f.min} max={f.max} defaultValue={value} className={`${input} h-10 w-32`} />
      ) : (
        <input name={f.key} defaultValue={value} className={`${input} h-10`} />
      )}
      {f.hint && <span className="text-xs text-muted-foreground">{f.hint}</span>}
    </label>
  );
}

type CatRow = { slug: string; label: string; image: string; link: string };

/** Station 3's categories: chosen ones in order (label, image, link), or automatic. Posted as HOME_CAT_ITEMS. */
function CategoryPicker({ value, categories, products, auto }: { value: string; categories: EditorCategory[]; products: EditorProduct[]; auto: string[] }) {
  const [rows, setRows] = useState<CatRow[]>(() =>
    value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [slug = '', label = '', image = '', link = ''] = l.split('|').map((s) => s.trim());
      return { slug, label, image, link };
    }),
  );
  const [pick, setPick] = useState('');
  const bySlug = useMemo(() => new Map(categories.map((c) => [c.slug, c])), [categories]);
  const free = categories.filter((c) => !rows.some((r) => r.slug === c.slug));
  const set = (i: number, patch: Partial<CatRow>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: number) => setRows((rs) => {
    const j = i + d; if (j < 0 || j >= rs.length) return rs;
    const n = rs.slice(); [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const serialized = rows.map((r) => [r.slug, r.label.trim(), r.image.trim(), r.link.trim()].join('|').replace(/\|+$/, '')).join('\n');
  return (
    <div className="space-y-3">
      <span className="block text-sm font-semibold">Categories on the station</span>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground rounded-xl border border-dashed border-border p-3">
          Automatic: the categories marked “show on homepage” in Admin → Categories, in their homepage order, then by live listings.
          {auto.length > 0 && <> Now: {auto.join(' · ')}.</>} Add categories below to choose them yourself.
        </p>
      ) : (
        <ol className="space-y-2">
          {rows.map((r, i) => {
            const c = bySlug.get(r.slug);
            const linkKind = r.link.startsWith('product:') ? 'product' : 'category';
            return (
              <li key={r.slug} className="rounded-xl border border-border p-3 space-y-2" data-cat-row={r.slug}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-mono w-6 text-center rounded bg-foreground/5 px-1.5 py-0.5 tabular-nums">{i + 1}</span>
                  <CategoryIcon name={c?.icon} className="h-4 w-4 text-primary" />
                  <b className="text-sm flex-1 min-w-[8rem]">{c?.name ?? r.slug}</b>
                  <span className={`text-[11px] ${c && c.live > 0 ? 'text-muted-foreground' : 'text-red-600 dark:text-red-400 font-semibold'}`}>
                    {c ? (c.live > 0 ? `${c.live} live` : 'no live listings — not shown') : 'category not found'}
                  </span>
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${c?.name ?? r.slug} up`} className="h-8 w-8 inline-grid place-items-center rounded-full border border-border disabled:opacity-30"><ArrowUp className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move ${c?.name ?? r.slug} down`} className="h-8 w-8 inline-grid place-items-center rounded-full border border-border disabled:opacity-30"><ArrowDown className="h-3.5 w-3.5" /></button>
                  <button type="button" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))} aria-label={`Remove ${c?.name ?? r.slug}`} className="h-8 w-8 inline-grid place-items-center rounded-full border border-border text-red-600"><X className="h-3.5 w-3.5" /></button>
                </div>
                <div className="grid sm:grid-cols-3 gap-2">
                  <input aria-label="Label" value={r.label} onChange={(e) => set(i, { label: e.target.value.replace(/[|\n]/g, ' ') })} placeholder={`Label (empty = ${c?.name ?? 'the name'})`} className={small} />
                  <input aria-label="Image" value={r.image} onChange={(e) => set(i, { image: e.target.value.replace(/[|\n\s]/g, '') })} list="home-product-images" placeholder={c?.hasImage ? 'Image (empty = category picture)' : 'Image (empty = best listing photo)'} className={`${small} font-mono`} />
                  <div className="flex gap-2">
                    <select aria-label="Link" value={linkKind} onChange={(e) => set(i, { link: e.target.value === 'product' ? 'product:' : '' })} className={small}>
                      <option value="category">Opens the category</option>
                      <option value="product">Opens a listing</option>
                    </select>
                    {linkKind === 'product' && (
                      <input aria-label="Listing slug" value={r.link.slice('product:'.length)} onChange={(e) => set(i, { link: `product:${e.target.value.replace(/[|\n\s]/g, '')}` })} list="home-products" placeholder="listing slug" className={`${small} flex-1 min-w-0 font-mono`} />
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <select aria-label="Category to add" value={pick} onChange={(e) => setPick(e.target.value)} className={`${small} min-w-[14rem]`}>
          <option value="">Add a category…</option>
          {free.map((c) => <option key={c.slug} value={c.slug}>{c.name} ({c.live} live)</option>)}
        </select>
        <Button type="button" variant="outline" size="sm" className="rounded-full" disabled={!pick || rows.length >= 12} onClick={() => { setRows((rs) => [...rs, { slug: pick, label: '', image: '', link: '' }]); setPick(''); }}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
        {rows.length > 0 && <Button type="button" variant="ghost" size="sm" className="rounded-full" onClick={() => setRows([])}>Back to automatic</Button>}
      </div>
      <span className="block text-xs text-muted-foreground">
        Up to 12. Image: a photo address from your media store (/media/…), or <code>product:&lt;listing-slug&gt;</code> for that listing’s photo. The icon and the category picture are set in Admin → Categories.
      </span>
      <datalist id="home-product-images">{products.map((p) => <option key={p.slug} value={`product:${p.slug}`}>{p.title}</option>)}</datalist>
      <input type="hidden" name="HOME_CAT_ITEMS" value={serialized} />
    </div>
  );
}

/** One listing (the demo) or an ordered list of up to eight (featured), by slug. */
function ProductPicker({ name, value, products, multi, label, hint }: { name: string; value: string; products: EditorProduct[]; multi: boolean; label: string; hint?: string }) {
  const titles = useMemo(() => new Map(products.map((p) => [p.slug, p.title])), [products]);
  const [list, setList] = useState<string[]>(() => (multi ? parseSlugList(value) : value ? [value] : []));
  const [add, setAdd] = useState('');
  const commit = () => {
    const s = add.trim().toLowerCase();
    if (!s) return;
    setList((l) => (multi ? (l.includes(s) || l.length >= 8 ? l : [...l, s]) : [s]));
    setAdd('');
  };
  const move = (i: number, d: number) => setList((l) => {
    const j = i + d; if (j < 0 || j >= l.length) return l;
    const n = l.slice(); [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  return (
    <div className="space-y-2">
      <span className="block text-sm font-semibold">{label}</span>
      {list.length > 0 && (
        <ol className="space-y-1.5">
          {list.map((s, i) => (
            <li key={s} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm" data-product-row={s}>
              {multi && <span className="text-[10px] font-mono w-6 text-center rounded bg-foreground/5 px-1.5 py-0.5 tabular-nums">{i + 1}</span>}
              <span className="flex-1 min-w-0 truncate">{titles.get(s) ?? <span className="text-red-600 dark:text-red-400">not a live listing</span>} <code className="text-[11px] text-muted-foreground">{s}</code></span>
              {multi && <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" className="h-7 w-7 inline-grid place-items-center rounded-full border border-border disabled:opacity-30"><ArrowUp className="h-3 w-3" /></button>}
              {multi && <button type="button" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label="Move down" className="h-7 w-7 inline-grid place-items-center rounded-full border border-border disabled:opacity-30"><ArrowDown className="h-3 w-3" /></button>}
              <button type="button" onClick={() => setList((l) => l.filter((x) => x !== s))} aria-label={`Remove ${s}`} className="h-7 w-7 inline-grid place-items-center rounded-full border border-border text-red-600"><X className="h-3 w-3" /></button>
            </li>
          ))}
        </ol>
      )}
      {(multi ? list.length < 8 : list.length === 0) && (
        <div className="flex items-center gap-2">
          <input
            aria-label={`${label} — add a listing`}
            value={add}
            onChange={(e) => setAdd(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
            list="home-products"
            placeholder="Type a title or slug…"
            className={`${small} flex-1 font-mono`}
          />
          <Button type="button" variant="outline" size="sm" className="rounded-full" onClick={commit} disabled={!add.trim()}><Plus className="h-3.5 w-3.5" /> {multi ? 'Add' : 'Choose'}</Button>
        </div>
      )}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      <input type="hidden" name={name} value={list.join(',')} />
    </div>
  );
}

export interface HomepageEditorProps {
  values: Record<string, string>;
  /** Keys whose draft value differs from the live one. */
  changed: string[];
  draft: { token: string; savedAt: string; by: string | null } | null;
  categories: EditorCategory[];
  products: EditorProduct[];
  autoCategories: string[];
  siteName: string;
}

const GROUPS: HomeFieldGroup[] = ['intro', 'hero', 'categories', 'route', 'demo', 'ways', 'cta', 'featured', 'trustbar', 'blog', 'testimonials'];

/**
 * Admin → Homepage: stations (show / hide, order, rail label), extra modules,
 * the instruments' categories, the demo and featured listings and every text,
 * saved as a draft (shown in the preview), then published through the
 * settings registry (Change history, Revert).
 */
export function HomepageEditor({ values, changed, draft, categories, products, autoCategories, siteName }: HomepageEditorProps) {
  const changedSet = new Set(changed);
  const stationsShown = parseStations(values.HOME_STATIONS ?? '');
  const stationRows: ModuleRow[] = [
    ...stationsShown.map((k) => ({ key: k, label: HOME_SECTION_LABEL[k], enabled: true })),
    ...HOME_STATIONS.filter((k) => !stationsShown.includes(k)).map((k) => ({ key: k, label: HOME_SECTION_LABEL[k], enabled: false })),
  ];
  const extrasShown = (values.HOME_EXTRAS ?? '').split(',').map((s) => s.trim()).filter((s) => (HOME_EXTRAS as readonly string[]).includes(s));
  const extraRows: ModuleRow[] = [
    ...extrasShown.map((k) => ({ key: k, label: HOME_SECTION_LABEL[k as (typeof HOME_EXTRAS)[number]], enabled: true })),
    ...HOME_EXTRAS.filter((k) => !extrasShown.includes(k)).map((k) => ({ key: k, label: HOME_SECTION_LABEL[k], enabled: false })),
  ];
  const [rail, setRail] = useState<Record<string, string>>(() => parseRailNames(values.HOME_RAIL_NAMES ?? ''));
  const railValue = HOME_STATIONS.map((s) => `${s}|${(rail[s] ?? '').replace(/[|\n]/g, ' ').trim() || parseRailNames('')[s]}`).join('\n');
  const field = (f: HomeField) => <TextField key={f.key} f={f} value={values[f.key] ?? ''} changed={changedSet.has(f.key)} />;
  const savedAt = draft ? new Date(draft.savedAt) : null;

  return (
    <div className="grid xl:grid-cols-[1fr_640px] gap-6 items-start">
      <AdminActionForm
        action={submitHomepage}
        className="space-y-6 min-w-0"
        statusInChildren
        confirmMessage={(fd) =>
          fd.get('intent') === 'publish'
            ? 'Publish these values? The homepage changes for every visitor now (each change can be reverted from the history).'
            : fd.get('intent') === 'discard'
              ? 'Discard the draft? Its unpublished changes are lost.'
              : null}
      >
        {draft && (
          <div className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm" role="status">
            <b>Unpublished draft</b> — saved {savedAt && !Number.isNaN(savedAt.getTime()) ? savedAt.toLocaleString('en-GB') : ''}{draft.by ? ` by ${draft.by}` : ''}.
            {' '}{changed.length ? `${changed.length} field${changed.length === 1 ? '' : 's'} differ from the live homepage (marked “draft”).` : 'It matches the live homepage.'}
            {' '}Visitors still see the live homepage until you publish.
          </div>
        )}

        <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Stations</h2>
          <p className="text-xs text-muted-foreground">
            Show or hide each 3D station and set its order (arrows or drag). The intro opens the page, so it stays first; at least one station stays shown.
            The label is the station’s name in the section rail.
          </p>
          <HomepageReorder
            initial={stationRows}
            name="HOME_STATIONS"
            pinned={['intro']}
            minShown={1}
            renderExtra={(row) => (
              <input
                aria-label={`Rail label of ${row.label}`}
                value={rail[row.key] ?? ''}
                onChange={(e) => setRail((r) => ({ ...r, [row.key]: e.target.value.slice(0, 24) }))}
                className={`${small} w-36 font-mono`}
              />
            )}
          />
          <input type="hidden" name="HOME_RAIL_NAMES" value={railValue} />
          {HOME_FIELDS.filter((f) => f.group === 'layout' && !f.picker).map(field)}
        </section>

        <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Extra modules below the stations</h2>
          <p className="text-xs text-muted-foreground">Ordinary sections after the 3D story. Drag or use the arrows to order them; the pill shows or hides each one.</p>
          <HomepageReorder initial={extraRows} name="HOME_EXTRAS" />
        </section>

        {GROUPS.map((g) => {
          const sec = HOME_GROUP_SECTION[g];
          const hidden = sec && (HOME_STATIONS as readonly string[]).includes(sec) ? !stationsShown.includes(sec as (typeof HOME_STATIONS)[number]) : sec ? !extrasShown.includes(sec) : false;
          return (
            <section key={g} className="rounded-2xl border border-border bg-card p-6 space-y-4" data-group={g}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">{HOME_GROUP_TITLE[g]}</h2>
                {hidden && <span className="text-[11px] font-semibold text-muted-foreground inline-flex items-center gap-1"><Eye className="h-3 w-3" /> hidden on the homepage now</span>}
              </div>
              {g === 'categories' && <CategoryPicker value={values.HOME_CAT_ITEMS ?? ''} categories={categories} products={products} auto={autoCategories} />}
              {g === 'demo' && (
                <ProductPicker name="HOME_DEMO_PRODUCT" value={values.HOME_DEMO_PRODUCT ?? ''} products={products} multi={false} label="Listing in the demo"
                  hint="The demo shows this live listing as sample data. Empty = the newest live listing with a photo." />
              )}
              {g === 'featured' && (
                <ProductPicker name="HOME_FEATURED_PRODUCTS" value={values.HOME_FEATURED_PRODUCTS ?? ''} products={products} multi label="Listings"
                  hint="Up to eight live listings, in this order; each card opens its listing. Empty = the eight newest live listings." />
              )}
              {HOME_FIELDS.filter((f) => f.group === g && !f.picker).map(field)}
            </section>
          );
        })}

        <datalist id="home-products">{products.map((p) => <option key={p.slug} value={p.slug}>{p.title}</option>)}</datalist>

        <div className="sticky bottom-3 z-10 flex items-center gap-3 flex-wrap bg-background/95 backdrop-blur p-3 rounded-2xl border border-border shadow-sm">
          <Button type="submit" name="intent" value="draft" variant="outline" size="lg" className="rounded-2xl font-semibold">
            <Save className="h-4 w-4" /> Save draft
          </Button>
          <Button type="submit" name="intent" value="publish" size="lg" className="rounded-2xl font-semibold">
            <Rocket className="h-4 w-4" /> Publish
          </Button>
          {draft && (
            <Button type="submit" name="intent" value="discard" variant="ghost" size="lg" className="rounded-2xl font-semibold text-red-700 dark:text-red-300" formNoValidate>
              <Trash2 className="h-4 w-4" /> Discard draft
            </Button>
          )}
          <AdminActionStatus />
        </div>
        <p className="text-[11px] text-muted-foreground">
          “{'{SITE}'}” in a text becomes the site name ({siteName}). Every published change is listed in the Change history below (and in Settings → Change history) with Revert.
        </p>
      </AdminActionForm>

      <aside className="xl:sticky xl:top-20 min-w-0">
        <HomepagePreview token={draft?.token ?? null} version={draft?.savedAt ?? 'live'} />
      </aside>
    </div>
  );
}

