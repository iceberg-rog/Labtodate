import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
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

const draftRow = () => prisma.setting.findUnique({ where: { key: HOME_DRAFT_KEY } }).catch(() => null);

export async function readHomeDraft(): Promise<HomeDraft | null> {
  return parseDraft((await draftRow())?.value);
}

/**
 * Save `values` as the draft (the preview token stays the same while a draft
 * exists). With `expectSavedAt` ('' = no draft) it saves only over that draft —
 * compared and written in one statement — and returns null when another admin
 * saved, published or discarded the draft meanwhile (nothing is written).
 */
export async function writeHomeDraft(values: Record<string, string>, by: string | null, expectSavedAt?: string): Promise<HomeDraft | null> {
  const row = await draftRow();
  const old = parseDraft(row?.value);
  if (expectSavedAt !== undefined && (old?.savedAt ?? '') !== expectSavedAt) return null;
  const draft: HomeDraft = { token: old?.token ?? randomBytes(18).toString('base64url'), savedAt: new Date().toISOString(), by, values };
  const value = JSON.stringify(draft);
  if (expectSavedAt === undefined) {
    await prisma.setting.upsert({ where: { key: HOME_DRAFT_KEY }, update: { value }, create: { key: HOME_DRAFT_KEY, value } });
    return draft;
  }
  if (row) {
    const r = await prisma.setting.updateMany({ where: { key: HOME_DRAFT_KEY, value: row.value }, data: { value } });
    return r.count ? draft : null;
  }
  try {
    await prisma.setting.create({ data: { key: HOME_DRAFT_KEY, value } });
    return draft;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null; // created meanwhile
    throw e;
  }
}

/**
 * Delete the draft. With `expectSavedAt` only that draft ('' = none: nothing to
 * delete); false when another admin saved a newer draft meanwhile, which is kept.
 */
export async function clearHomeDraft(expectSavedAt?: string): Promise<boolean> {
  if (expectSavedAt === undefined) {
    await prisma.setting.deleteMany({ where: { key: HOME_DRAFT_KEY } });
    delete process.env[HOME_DRAFT_KEY];
    return true;
  }
  const row = await draftRow();
  if (!row) return true;
  if ((parseDraft(row.value)?.savedAt ?? '') !== expectSavedAt) return false;
  const r = await prisma.setting.deleteMany({ where: { key: HOME_DRAFT_KEY, value: row.value } });
  if (r.count) delete process.env[HOME_DRAFT_KEY];
  return r.count > 0;
}

/**
 * The published homepage's version (see src/lib/home/editor-version.ts): how
 * many homepage changes the Change history holds and when the newest was made.
 * Every publish, revert or Settings save of a homepage key adds a row, and rows
 * are never deleted, so the version moves with each of them. Read it BEFORE
 * the values an editor is opened with: a change in between then refuses the
 * save instead of letting it slip through.
 */
export async function homeLiveVersion(): Promise<string> {
  const a = await prisma.settingChange.aggregate({ where: { key: { in: [...HOME_KEYS] } }, _count: { _all: true }, _max: { createdAt: true } });
  return `${a._count._all}@${a._max.createdAt?.toISOString() ?? '-'}`;
}

/** The newest published homepage change (for the “changed since you opened it” message). */
export function latestHomeChange() {
  return prisma.settingChange.findFirst({
    where: { key: { in: [...HOME_KEYS] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { key: true, actorEmail: true, createdAt: true },
  });
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
