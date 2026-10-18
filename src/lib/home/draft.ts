import { randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '@/lib/db';
import { HOME_KEYS, homeValue, envRead, getHomeLayout, type HomeRead } from '@/lib/home-sections';

/**
 * The homepage draft (Admin → Homepage → “Save draft”): every homepage value as
 * the editor left it, kept in one Setting row outside the registry, so a draft
 * never touches the live page, the Change history or the settings cache. The
 * draft is shown at /?homepreview=<token> (a random token, new for each draft)
 * and goes live only through Publish, which saves its values through the
 * registry (validation, Change history, Revert) and deletes the draft.
 */
export const HOME_DRAFT_KEY = 'HOME_DRAFT_JSON';

export interface HomeDraft {
  token: string;
  savedAt: string;
  by: string | null;
  values: Record<string, string>;
}

function parseDraft(raw: string | null | undefined): HomeDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<HomeDraft>;
    if (typeof d.token !== 'string' || !d.values || typeof d.values !== 'object') return null;
    const values: Record<string, string> = {};
    for (const k of HOME_KEYS) if (typeof d.values[k] === 'string') values[k] = d.values[k];
    return { token: d.token, savedAt: String(d.savedAt ?? ''), by: d.by ?? null, values };
  } catch {
    return null;
  }
}

export async function readHomeDraft(): Promise<HomeDraft | null> {
  const row = await prisma.setting.findUnique({ where: { key: HOME_DRAFT_KEY } }).catch(() => null);
  return parseDraft(row?.value);
}

/** Save `values` as the draft (the preview token stays the same while a draft exists). */
export async function writeHomeDraft(values: Record<string, string>, by: string | null): Promise<HomeDraft> {
  const old = await readHomeDraft();
  const draft: HomeDraft = { token: old?.token ?? randomBytes(18).toString('base64url'), savedAt: new Date().toISOString(), by, values };
  const value = JSON.stringify(draft);
  await prisma.setting.upsert({ where: { key: HOME_DRAFT_KEY }, update: { value }, create: { key: HOME_DRAFT_KEY, value } });
  return draft;
}

export async function clearHomeDraft(): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: HOME_DRAFT_KEY } });
  delete process.env[HOME_DRAFT_KEY];
}

/** The draft whose preview token is `token`, or null (wrong, stale or missing token). */
export async function draftForToken(token: string | null | undefined): Promise<HomeDraft | null> {
  const t = (token ?? '').trim();
  if (!t || t.length > 64) return null;
  const draft = await readHomeDraft();
  if (!draft) return null;
  const a = Buffer.from(draft.token), b = Buffer.from(t);
  return a.length === b.length && timingSafeEqual(a, b) ? draft : null;
}

/** Every homepage value as the editor shows it: the effective value, defaults filled in. */
export function homeEditorValues(read: HomeRead = envRead): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of HOME_KEYS) out[k] = homeValue(read, k);
  // the extras as they show now (a list saved before the registry still counts)
  out.HOME_EXTRAS = getHomeLayout(read).extras.join(',');
  return out;
}
