import { cache } from 'react';
import { readEntries, saveEntry, type Actor } from '@/lib/cms/store';
import { checkLinks, checkText, fillPlain, fillRich, placeholdersIn, stripLinks, type LinkValue, type Vars } from '@/lib/cms/text';
import { ensureSettingsLoaded } from '@/lib/settings';
import { prisma } from '@/lib/db';
import { staleWhileRevalidate } from '@/lib/stale-cache';
import { SITE_GROUPS, siteDef, siteGroup } from './defs';
import { SITE_FIELDS, type SiteTextGroup } from './types';

/**
 * Reader for editable site content. One stored JSON object per group
 * ("site:<group>"), merged over the built-in defaults. The whole set is read
 * once per request (React cache + the store's 5 s cache).
 */

/** Before the first save of their group, a value set in the server .env still wins. */
const ENV_FALLBACK: Record<string, string> = {
  'claims.warranty': 'WARRANTY_TEXT',
  'claims.inspection': 'INSPECTION_TEXT',
  'claims.quote_turnaround': 'QUOTE_TURNAROUND',
  'footer.tagline': 'FOOTER_TAGLINE',
  'footer.linkedin': 'SOCIAL_LINKEDIN',
  'footer.twitter': 'SOCIAL_TWITTER',
  'footer.github': 'SOCIAL_GITHUB',
};

const CLAIMS = ['claims.warranty', 'claims.inspection', 'claims.quote_turnaround'] as const;

export const groupKey = (id: string) => `site:${id}`;

async function load(): Promise<Record<string, string>> {
  await ensureSettingsLoaded();
  const stored = await readEntries(SITE_GROUPS.map((g) => groupKey(g.id)));
  const out: Record<string, string> = {};
  for (const g of SITE_GROUPS) {
    const s = (stored.get(groupKey(g.id)) ?? null) as Record<string, unknown> | null;
    for (const f of g.fields) {
      const v = s && typeof s[f.key] === 'string' ? (s[f.key] as string) : undefined;
      const env = !s && ENV_FALLBACK[f.key] ? (process.env[ENV_FALLBACK[f.key]] || '').trim() : '';
      out[f.key] = v ?? (env || f.default);
    }
  }
  return out;
}

export const getSiteTexts = cache(load);

/** Is a claim shown? (switched on and not empty) */
function claimOn(t: Record<string, string>, c: string): boolean {
  return t[`${c}_show`] !== 'off' && !!(t[c] || '').trim();
}

/** The three claims as visitors see them: a switched-off or empty claim is ''. */
export async function siteClaims(): Promise<{ warranty: string; inspection: string; quoteTurnaround: string }> {
  const t = await getSiteTexts();
  const v = (c: string) => (claimOn(t, c) ? t[c].trim() : '');
  return { warranty: v('claims.warranty'), inspection: v('claims.inspection'), quoteTurnaround: v('claims.quote_turnaround') };
}

/** The contact link pages use: the support e-mail, or the contact page when none is set. */
function contactLink(email: string): LinkValue {
  return email ? { href: `mailto:${email}`, label: email } : { href: '/contact', label: 'our contact page' };
}

/** Values for {{fields}} in site texts. */
export const siteVars = cache(async (): Promise<Vars> => {
  const t = await getSiteTexts();
  const e = (k: string) => (process.env[k] || '').trim();
  // Same number the header search and sign-up show: the admin's STAT_LISTINGS, else the live count.
  let listings = e('STAT_LISTINGS');
  if (!listings) {
    try {
      listings = String(await prisma.product.count({ where: { status: 'PUBLISHED' } }));
    } catch {
      listings = '';
    }
  }
  let quoteDays = '14';
  let payDays = '5';
  try {
    const { getOptions } = await import('@/lib/documents/config');
    quoteDays = String((await getOptions('QUOTE')).days);
    payDays = String((await getOptions('INVOICE')).days);
  } catch {
    /* defaults */
  }
  const name = e('COMPANY_LEGAL_NAME') || e('SITE_NAME') || 'Labtodate';
  const address = e('COMPANY_ADDRESS').split(/\r?\n+/).map((s) => s.trim()).filter(Boolean).join(', ');
  const country = e('COMPANY_COUNTRY');
  const supportEmail = e('SUPPORT_EMAIL') || e('COMPANY_EMAIL') || e('SUPPORT_INTAKE_EMAIL');
  return {
    'site.name': e('SITE_NAME') || 'Labtodate',
    'site.url': (e('BETTER_AUTH_URL') || 'https://labtodate.com').replace(/\/+$/, ''),
    'company.name': name,
    'company.address': address,
    'company.country': country,
    'company.email': e('COMPANY_EMAIL'),
    'company.phone': e('COMPANY_PHONE'),
    'company.vat': e('COMPANY_VAT'),
    'company.kvk': e('COMPANY_KVK'),
    'company.name_country': country ? `${name} (${country})` : name,
    'company.name_address': [name, address, country].filter(Boolean).join(', '),
    'support.email': supportEmail,
    'support.contact': contactLink(supportEmail).label,
    'claims.warranty': claimOn(t, 'claims.warranty') ? t['claims.warranty'] : '',
    'claims.inspection': claimOn(t, 'claims.inspection') ? t['claims.inspection'] : '',
    'claims.quote_turnaround': claimOn(t, 'claims.quote_turnaround') ? t['claims.quote_turnaround'] : '',
    'rules.quote_valid_days': quoteDays,
    'rules.payment_term_days': payDays,
    'rules.return_days': t['rules.return_days'],
    'rules.payment_verify_time': t['rules.payment_verify_time'],
    'rules.contact_reply_time': t['rules.contact_reply_time'],
    'rules.sell_reply_time': t['rules.sell_reply_time'],
    'rules.support_reply_time': t['rules.support_reply_time'],
    'stats.listings': listings,
    'date.year': String(new Date().getFullYear()),
  };
});

/** Link fields of rich site texts ({{support.contact}} → a mailto: or /contact link). */
async function linkVars(): Promise<Record<string, LinkValue>> {
  const v = await siteVars();
  const email = String(v['support.email'] ?? '');
  return { 'support.contact': contactLink(email) };
}

/**
 * A text that states a claim — with a {{claims.…}} field or through its
 * definition's `needs` — vanishes entirely while that claim is off.
 */
function usesHiddenClaim(key: string, raw: string, t: Record<string, string>): boolean {
  const used = new Set(placeholdersIn(raw));
  for (const n of siteDef(key)?.def.needs ?? []) used.add(n);
  return CLAIMS.some((c) => used.has(c) && !claimOn(t, c));
}

/**
 * Rich texts and pages lose only the lines (sentences, bullets) that use a
 * switched-off claim, so one claim never takes a whole page with it.
 */
function withoutHiddenClaimLines(key: string, raw: string, t: Record<string, string>): string {
  if ((siteDef(key)?.def.needs ?? []).some((c) => !claimOn(t, c))) return '';
  const hidden = CLAIMS.filter((c) => !claimOn(t, c)) as string[];
  if (!hidden.length) return raw;
  return raw
    .split(/\r?\n/)
    .filter((line) => !placeholdersIn(line).some((p) => hidden.includes(p)))
    .join('\n');
}

/** A text with its fields filled (plain). '' when it uses a switched-off claim. */
export async function siteText(key: string, extra: Vars = {}): Promise<string> {
  const [t, v] = await Promise.all([getSiteTexts(), siteVars()]);
  const raw = t[key] ?? '';
  if (usesHiddenClaim(key, raw, t)) return '';
  return fillPlain(stripLinks(raw), { ...v, ...extra }).trim();
}

/** Several plain texts at once, keyed by their key (e.g. a form's labels for a client component). */
export async function siteTexts<K extends string>(keys: readonly K[], extra: Vars = {}): Promise<Record<K, string>> {
  const values = await Promise.all(keys.map((k) => siteText(k, extra)));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]])) as Record<K, string>;
}

/** A rich text as HTML (paragraphs, lists, bold, links; pages also get headings). */
export async function siteRich(key: string, opts: { headings?: boolean; extra?: Vars } = {}): Promise<string> {
  const [t, v, links] = await Promise.all([getSiteTexts(), siteVars(), linkVars()]);
  const raw = withoutHiddenClaimLines(key, t[key] ?? '', t);
  return fillRich(raw, { ...v, ...opts.extra }, { headings: opts.headings, links: true, linkVars: links });
}

/**
 * A one-line text as inline HTML (**bold** and links, no paragraph around it),
 * for a sentence that sits inside an existing <p>/<span>.
 */
export async function siteInline(key: string, extra: Vars = {}): Promise<string> {
  const html = await siteRich(key, { extra });
  if (!html.startsWith('<p>') || !html.endsWith('</p>') || /<(ul|h2|h3)>/.test(html)) return html;
  return html.slice(3, -4).replace(/<\/p><p>/g, '<br><br>');
}

/**
 * A rule's raw value ("1 business day"), never empty: an empty stored value
 * falls back to the built-in default, so a sentence quoting it stays whole.
 */
export async function siteValue(key: string): Promise<string> {
  const t = await getSiteTexts();
  return (t[key] ?? '').trim() || siteDef(key)?.def.default || '';
}

/** Is a toggle on? */
export async function siteOn(key: string): Promise<boolean> {
  const t = await getSiteTexts();
  return t[key] !== 'off';
}

/** When a group was last saved in the admin, or `fallback` (the built-in texts' date) when never. */
export async function siteUpdatedAt(groupId: string, fallback: Date): Promise<Date> {
  try {
    const row = await prisma.contentEntry.findUnique({ where: { key: groupKey(groupId) }, select: { updatedAt: true } });
    return row?.updatedAt ?? fallback;
  } catch {
    return fallback;
  }
}

// ─── navigation ────────────────────────────────────────────────────────

const NAV_SECTIONS = {
  blog: { href: '/blog', count: () => prisma.blogPost.count({ where: { status: 'PUBLISHED' } }) },
  wiki: { href: '/wiki', count: () => prisma.wikiArticle.count({ where: { status: 'PUBLISHED' } }) },
  // The same filter /lab-rental lists with.
  lab_rental: { href: '/lab-rental', count: () => prisma.labFacility.count({ where: { isPublished: true } }) },
  case_studies: { href: '/case-studies', count: () => prisma.caseStudy.count({ where: { status: 'PUBLISHED' } }) },
} as const;

/**
 * The section paths the menu and footer must hide right now. The counts run on
 * every page (root layout), so they are kept for a minute; a database error
 * counts as "has content" (the item stays visible).
 */
export const hiddenNavHrefs = cache(async (): Promise<string[]> => {
  const t = await getSiteTexts();
  const hidden: string[] = [];
  await Promise.all(
    Object.entries(NAV_SECTIONS).map(async ([k, s]) => {
      const mode = t[`nav.${k}`] ?? 'auto';
      if (mode === 'hide') hidden.push(s.href);
      else if (mode === 'auto') {
        const n = await staleWhileRevalidate(`nav:count:${k}`, 60_000, () => s.count().catch(() => 1)).catch(() => 1);
        if (n === 0) hidden.push(s.href);
      }
    }),
  );
  return hidden;
});

// ─── saving (admin) ────────────────────────────────────────────────────

export class SiteTextError extends Error {
  constructor(public problems: string[]) {
    super(problems.join(' · '));
  }
}

export function cleanGroup(group: SiteTextGroup, input: Record<string, unknown>): Record<string, string> {
  const allowed = SITE_FIELDS.map((f) => f.name);
  const out: Record<string, string> = {};
  const problems: string[] = [];
  for (const f of group.fields) {
    let v = typeof input[f.key] === 'string' ? (input[f.key] as string) : f.kind === 'toggle' ? (input[f.key] ? 'on' : 'off') : '';
    v = v.replace(/\r\n?/g, '\n');
    if (f.kind === 'toggle') v = v === 'on' || v === 'true' ? 'on' : 'off';
    else if (f.kind === 'select') {
      if (!f.options?.some((o) => o.value === v)) problems.push(`${f.label}: pick one of the options.`);
    } else if (f.kind === 'number') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < (f.min ?? 0) || n > (f.maxValue ?? 1_000_000)) problems.push(`${f.label}: a whole number from ${f.min ?? 0} to ${f.maxValue ?? 1_000_000}.`);
    } else if (f.format === 'url') {
      v = v.trim();
      if (v && !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:[/?#][^\s<>"']*)?$/i.test(v)) problems.push(`${f.label}: a full address starting with https://, or empty.`);
    } else {
      problems.push(...checkText(f.label, v, allowed, { required: f.required, max: f.max ?? (f.kind === 'page' ? 30_000 : 2_000) }));
      problems.push(...checkLinks(f.label, v));
    }
    out[f.key] = v;
  }
  if (problems.length) throw new SiteTextError(problems);
  return out;
}

export async function saveGroup(id: string, input: Record<string, unknown>, actor: Actor, note?: string): Promise<number> {
  const g = siteGroup(id);
  if (!g) throw new SiteTextError([`Unknown content group “${id}”.`]);
  return saveEntry(groupKey(id), cleanGroup(g, input), actor, note);
}

/** Current values of one group (for the admin form). */
export async function groupValues(id: string): Promise<Record<string, string>> {
  const g = siteGroup(id);
  if (!g) return {};
  const t = await load();
  return Object.fromEntries(g.fields.map((f) => [f.key, t[f.key] ?? f.default]));
}
