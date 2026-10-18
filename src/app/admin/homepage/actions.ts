'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db';
import { getServerSession, requireCapability } from '@/lib/auth-server';
import {
  ensureSettingsLoaded,
  normaliseInput,
  revertSettingChange,
  saveSettings,
  settingDef,
  validateSettingValue,
  type SettingActor,
} from '@/lib/settings';
import { audit } from '@/lib/observability';
import { LIVE_PRODUCT_WHERE } from '@/lib/marketplace/queries';
import { ownMediaPath } from '@/lib/media/public-src';
import { HOME_KEYS, HOME_LEGACY_KEYS, envRead, homeField, homeValue, isHomeKey, parseCategoryItems, parseSlugList } from '@/lib/home-sections';
import { clearHomeDraft, homeEditorValues, homeLiveVersion, latestHomeChange, readHomeDraft, writeHomeDraft } from '@/lib/home/draft';
import { decodeHomeVersion, homeVersionConflict, type HomeIntent } from '@/lib/home/editor-version';
import { invalidateHomeLanding } from '@/lib/home-landing-data';

type Result = { ok: boolean; message: string };

async function actor(): Promise<SettingActor> {
  const s = await getServerSession();
  let ip: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    ip = (h.get('x-real-ip') || h.get('x-forwarded-for')?.split(',')[0] || '').trim() || null;
    userAgent = h.get('user-agent');
  } catch {
    /* outside a request */
  }
  return { id: s?.user.id ?? null, email: s?.user.email ?? null, ip, userAgent, source: 'ADMIN' };
}

const label = (key: string) => homeField(key)?.label ?? key;

/** The homepage values in the form (keys of the homepage only), as typed. */
function formValues(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of HOME_KEYS) {
    const v = fd.get(k);
    if (typeof v === 'string') out[k] = v.replace(/\r\n/g, '\n').trim();
  }
  return out;
}

/**
 * Every rule a value must pass before it may be saved (as a draft or live):
 * the registry's format checks, then what only the database can tell — the
 * categories and listings named exist, photos are in our own media store.
 * Returns problems (nothing is saved) and warnings (saved, but said).
 */
async function checkValues(values: Record<string, string>): Promise<{ problems: string[]; warnings: string[] }> {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const [k, raw] of Object.entries(values)) {
    const d = settingDef(k);
    if (!d) continue;
    const why = validateSettingValue(d, normaliseInput(d, raw));
    if (why) problems.push(`${d.label}: ${why}`);
  }
  if (problems.length) return { problems, warnings };

  const items = parseCategoryItems(values.HOME_CAT_ITEMS ?? '');
  const productSlugs = new Set<string>([
    ...items.flatMap((i) => [i.image.kind === 'product' ? i.image.slug : '', i.link.kind === 'product' ? i.link.slug : '']).filter(Boolean),
    ...parseSlugList(values.HOME_FEATURED_PRODUCTS ?? ''),
    ...(values.HOME_DEMO_PRODUCT ? [values.HOME_DEMO_PRODUCT.toLowerCase()] : []),
  ]);
  const [cats, products] = await Promise.all([
    items.length
      ? prisma.category.findMany({ where: { slug: { in: items.map((i) => i.slug) } }, select: { slug: true, name: true, _count: { select: { products: { where: LIVE_PRODUCT_WHERE } } } } })
      : [],
    productSlugs.size ? prisma.product.findMany({ where: { slug: { in: [...productSlugs] } }, select: { slug: true, status: true, quantity: true } }) : [],
  ]);
  const cat = new Map(cats.map((c) => [c.slug, c]));
  const prod = new Map(products.map((p) => [p.slug, p]));
  const isLive = (s: string) => {
    const p = prod.get(s);
    return !!p && p.status === 'PUBLISHED' && p.quantity > 0;
  };
  const missingProduct = (s: string, where: string) => {
    if (!prod.has(s)) problems.push(`${where}: no listing has the slug “${s}”.`);
    else if (!isLive(s)) warnings.push(`${where}: “${s}” is not live (sold, hidden or a draft), so it is not shown.`);
  };
  for (const i of items) {
    const c = cat.get(i.slug);
    if (!c) {
      problems.push(`${label('HOME_CAT_ITEMS')}: no category has the slug “${i.slug}”.`);
      continue;
    }
    if (c._count.products === 0) warnings.push(`“${c.name}” has no live listings, so the homepage leaves it out until it has.`);
    if (i.image.kind === 'url' && !ownMediaPath(i.image.value)) problems.push(`Image of “${c.name}”: use a photo from your own media store (/media/…), not another site’s address.`);
    if (i.image.kind === 'product') missingProduct(i.image.slug, `Image of “${c.name}”`);
    if (i.link.kind === 'product') missingProduct(i.link.slug, `Link of “${c.name}”`);
  }
  for (const s of parseSlugList(values.HOME_FEATURED_PRODUCTS ?? '')) missingProduct(s, label('HOME_FEATURED_PRODUCTS'));
  if (values.HOME_DEMO_PRODUCT) missingProduct(values.HOME_DEMO_PRODUCT.toLowerCase(), label('HOME_DEMO_PRODUCT'));
  return { problems, warnings };
}

/** Labels of the fields whose value differs from what the homepage shows now. */
function changedLabels(values: Record<string, string>): string[] {
  const live = homeEditorValues(envRead);
  return Object.keys(values).filter((k) => {
    const d = settingDef(k);
    const a = d ? normaliseInput(d, values[k]) : values[k];
    const b = d ? normaliseInput(d, live[k] ?? '') : live[k];
    return (a || homeValue(() => '', k)) !== (b || homeValue(() => '', k));
  }).map(label);
}

const fmtWhen = (d: Date) => d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const RELOAD = 'Nothing was saved — reload the page to see it, then make your change again (copy anything you typed first).';

/** Why this submit must not go ahead: what changed since the editor was opened. */
async function staleEditorMessage(conflict: 'live' | 'draft' | 'unknown'): Promise<string> {
  if (conflict === 'unknown') return 'This editor was opened before the last update of Admin → Homepage. Nothing was saved — reload the page and make your change again.';
  if (conflict === 'live') {
    const c = await latestHomeChange();
    const what = c ? ` (latest: “${label(c.key)}”${c.actorEmail ? ` by ${c.actorEmail}` : ''}, ${fmtWhen(c.createdAt)})` : '';
    return `The homepage changed since you opened it${what}. ${RELOAD}`;
  }
  const d = await readHomeDraft();
  const what = d ? `was saved${d.by ? ` by ${d.by}` : ''}${d.savedAt ? `, ${fmtWhen(new Date(d.savedAt))}` : ''}` : 'was published or discarded';
  return `The homepage draft ${what} since you opened the editor. ${RELOAD}`;
}

const list = (labels: string[], max = 6) =>
  labels.length > max ? `${labels.slice(0, max).map((l) => `“${l}”`).join(', ')} and ${labels.length - max} more` : labels.map((l) => `“${l}”`).join(', ');

/**
 * Admin → Homepage submits here: “Save draft” keeps the values as the draft
 * (the preview shows it, the live page does not change), “Publish” saves them
 * through the settings registry — validation, one Change-history row per
 * changed key, Revert — and clears the draft, “Discard draft” drops it.
 *
 * The form posts every homepage key, so each submit also posts the version the
 * editor was opened on (homeVersion): when another admin published, reverted or
 * saved a draft since, the submit is refused instead of putting the values this
 * editor was opened with back over theirs (and crediting this admin with it).
 */
export async function submitHomepage(fd: FormData): Promise<Result> {
  const session = await requireCapability('content:cms', { redirectTo: '/admin' });
  await ensureSettingsLoaded();
  const raw = String(fd.get('intent') ?? 'draft');
  const intent: HomeIntent = raw === 'publish' || raw === 'discard' ? raw : 'draft';
  const opened = decodeHomeVersion(fd.get('homeVersion'));
  const [liveNow, draftNow] = await Promise.all([homeLiveVersion(), readHomeDraft()]);
  const stale = homeVersionConflict(intent, opened, { live: liveNow, draft: draftNow?.savedAt ?? '' });
  if (stale || !opened) return { ok: false, message: await staleEditorMessage(stale ?? 'unknown') };

  if (intent === 'discard') {
    if (!(await clearHomeDraft(opened.draft))) return { ok: false, message: await staleEditorMessage('draft') };
    await audit('homepage.draft.discard');
    revalidatePath('/admin/homepage');
    return { ok: true, message: 'Draft discarded — the editor shows the live homepage again.' };
  }

  const values = formValues(fd);
  if (!Object.keys(values).length) return { ok: false, message: 'Nothing to save — the form sent no homepage fields.' };
  const { problems, warnings } = await checkValues(values);
  if (problems.length) return { ok: false, message: `${problems.join(' · ')} Nothing was saved.` };
  let note = warnings.length ? ` Note: ${warnings.join(' · ')}` : '';

  if (intent === 'draft') {
    const changed = changedLabels(values);
    // saved only over the draft this editor was opened on (one compare-and-write)
    if (!(await writeHomeDraft(values, session.user.email ?? null, opened.draft))) return { ok: false, message: await staleEditorMessage('draft') };
    await audit('homepage.draft', undefined, changed.join(', ').slice(0, 900));
    revalidatePath('/admin/homepage');
    return {
      ok: true,
      message: `Draft saved${changed.length ? ` (${changed.length} change${changed.length === 1 ? '' : 's'} from the live page)` : ' (same as the live page)'} — the preview shows it; nothing is live until you publish.${note}`,
    };
  }

  const who = await actor();
  let saved: Awaited<ReturnType<typeof saveSettings>>;
  try {
    saved = await saveSettings(values, who);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Publish failed: ${e.message.slice(0, 900)}` : 'Publish failed.' };
  }
  // The extras list saved before the registry (HOMEPAGE_SECTIONS + version
  // marker) now lives in HOME_EXTRAS: remove it, so “no extras” can be chosen.
  if ('HOME_EXTRAS' in values) {
    await prisma.setting.deleteMany({ where: { key: { in: [...HOME_LEGACY_KEYS] } } });
    for (const k of HOME_LEGACY_KEYS) delete process.env[k];
  }
  // the draft just published — a newer one saved meanwhile by another admin is kept
  const draftKept = !(await clearHomeDraft(opened.draft));
  if (draftKept) note += ' A newer draft saved meanwhile by another admin was kept — open the editor again to see it.';
  invalidateHomeLanding();
  await audit('homepage.publish', undefined, saved.changedKeys.join(',').slice(0, 900));
  revalidatePath('/');
  revalidatePath('/admin/homepage');
  revalidatePath('/admin/settings');
  if (!saved.changedKeys.length) return { ok: true, message: `Nothing changed — the homepage already shows this.${draftKept ? '' : ' The draft was cleared.'}${note}` };
  return {
    ok: true,
    message: `Published ✓ — ${saved.changedKeys.length} change${saved.changedKeys.length === 1 ? '' : 's'} live: ${list(saved.changedKeys.map(label))}. Each is in the Change history below, with Revert.${note}`,
  };
}

/** Revert one homepage change from the history on Admin → Homepage (content:cms; other settings are reverted in Settings). */
export async function revertHomepageChange(fd: FormData): Promise<Result> {
  await requireCapability('content:cms', { redirectTo: '/admin' });
  const id = String(fd.get('changeId') ?? '');
  const ch = id ? await prisma.settingChange.findUnique({ where: { id }, select: { key: true } }) : null;
  if (!ch) return { ok: false, message: 'That change no longer exists.' };
  if (!isHomeKey(ch.key)) return { ok: false, message: 'Only homepage changes are reverted here — use Settings → Change history for the others.' };
  try {
    const r = await revertSettingChange(id, await actor());
    if (r.ok) {
      await audit('homepage.revert', id, r.message.slice(0, 200));
      invalidateHomeLanding();
      revalidatePath('/');
      revalidatePath('/admin/homepage');
    }
    return r;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Revert failed: ${e.message.slice(0, 400)}` : 'Revert failed.' };
  }
}
