import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Versioned store for editable business content (document templates, e-mails,
 * site texts, settings groups). One ContentEntry row per key holds the current
 * JSON; every save also writes a ContentVersion, so the admin History tab can
 * show who changed what and restore any earlier state (a restore is itself a
 * new version, so it can be undone too).
 *
 * Values are plain JSON validated by the caller's schema — never code. A key
 * that was never saved has no row: readers fall back to the built-in defaults,
 * so a fresh install works without seeding anything.
 */

export interface Actor {
  id?: string | null;
  email?: string | null;
}

const TTL_MS = 5_000;
type CacheHit = { at: number; data: unknown | null };
const g = globalThis as unknown as { __cmsCache?: Map<string, CacheHit> };
const cache: Map<string, CacheHit> = (g.__cmsCache ??= new Map());

/** The stored JSON for a key, or null when it was never saved (5 s cache). */
export async function readEntry(key: string): Promise<unknown | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  let data: unknown | null = null;
  try {
    const row = await prisma.contentEntry.findUnique({ where: { key }, select: { data: true } });
    data = row ? (row.data as unknown) : null;
  } catch {
    // Table missing (migration not applied yet) → behave as "never saved".
    data = null;
  }
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** Several keys at once (one query), e.g. every e-mail template. */
export async function readEntries(keys: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const missing = keys.filter((k) => {
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < TTL_MS) {
      if (hit.data !== null) out.set(k, hit.data);
      return false;
    }
    return true;
  });
  if (missing.length) {
    let rows: { key: string; data: Prisma.JsonValue }[] = [];
    try {
      rows = await prisma.contentEntry.findMany({ where: { key: { in: missing } }, select: { key: true, data: true } });
    } catch {
      rows = [];
    }
    const found = new Map(rows.map((r) => [r.key, r.data as unknown]));
    for (const k of missing) {
      const d = found.has(k) ? found.get(k)! : null;
      cache.set(k, { at: Date.now(), data: d });
      if (d !== null) out.set(k, d);
    }
  }
  return out;
}

export function invalidateEntry(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

/**
 * Save a new version of a key. Returns the new version number, or the current
 * one when nothing changed (no empty versions in the history).
 */
export async function saveEntry(key: string, data: unknown, actor: Actor, note = 'saved'): Promise<number> {
  const json = data as Prisma.InputJsonValue;
  const version = await prisma.$transaction(async (tx) => {
    const current = await tx.contentEntry.findUnique({ where: { key }, select: { version: true, data: true } });
    if (current && JSON.stringify(current.data) === JSON.stringify(data)) return current.version;
    const next = (current?.version ?? 0) + 1;
    await tx.contentEntry.upsert({
      where: { key },
      create: { key, data: json, version: next, updatedById: actor.id ?? null },
      update: { data: json, version: next, updatedById: actor.id ?? null },
    });
    await tx.contentVersion.create({
      data: { entryKey: key, version: next, data: json, note, createdById: actor.id ?? null, createdByEmail: actor.email ?? null },
    });
    return next;
  });
  invalidateEntry(key);
  return version;
}

export interface VersionRow {
  version: number;
  note: string | null;
  createdAt: Date;
  createdByEmail: string | null;
  data: unknown;
}

export async function listVersions(key: string, take = 50): Promise<VersionRow[]> {
  try {
    const rows = await prisma.contentVersion.findMany({
      where: { entryKey: key },
      orderBy: { version: 'desc' },
      take,
      select: { version: true, note: true, createdAt: true, createdByEmail: true, data: true },
    });
    return rows.map((r) => ({ ...r, data: r.data as unknown }));
  } catch {
    return [];
  }
}

/** Recent changes across every key (or every key with a prefix). */
export async function recentChanges(prefix?: string, take = 100) {
  try {
    return await prisma.contentVersion.findMany({
      where: prefix ? { entryKey: { startsWith: prefix } } : undefined,
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, entryKey: true, version: true, note: true, createdAt: true, createdByEmail: true },
    });
  } catch {
    return [];
  }
}

export async function getVersion(key: string, version: number): Promise<unknown | null> {
  const row = await prisma.contentVersion.findUnique({
    where: { entryKey_version: { entryKey: key, version } },
    select: { data: true },
  });
  return row ? (row.data as unknown) : null;
}

/**
 * Field-level differences between two JSON values, as dotted paths with the
 * old and new value. Used by the History tab ("Intro text (EN): old → new").
 */
export function diffJson(before: unknown, after: unknown, path = ''): { path: string; before: unknown; after: unknown }[] {
  const out: { path: string; before: unknown; after: unknown }[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) out.push(...diffJson(before[k], after[k], path ? `${path}.${k}` : k));
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, before, after });
  return out;
}
