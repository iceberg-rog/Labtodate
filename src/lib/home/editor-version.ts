/**
 * What Admin → Homepage was opened on, posted back with every submit so one
 * admin's save never silently undoes another's: `live` stands for the
 * published homepage (count and time of its newest Change-history row), `draft`
 * for the draft (its savedAt, '' = none). The editor posts every homepage key,
 * so a save from a stale editor would put back the values it was opened with.
 * Pure: the database reads are in src/lib/home/draft.ts.
 */
export interface HomeEditorVersion {
  live: string;
  draft: string;
}

export type HomeIntent = 'draft' | 'publish' | 'discard';

export const encodeHomeVersion = (v: HomeEditorVersion): string => JSON.stringify([v.live, v.draft]);

/** The posted version, or null (missing or malformed: an editor opened before versions were posted). */
export function decodeHomeVersion(raw: unknown): HomeEditorVersion | null {
  if (typeof raw !== 'string' || !raw || raw.length > 200) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? { live: v[0], draft: v[1] } : null;
  } catch {
    return null;
  }
}

/**
 * What changed since the editor was opened that this submit would overwrite:
 * 'live' (a homepage change was published or reverted), 'draft' (the draft was
 * saved, published or discarded by someone else) or 'unknown' (no version
 * posted); null = nothing, go ahead. A draft carries every homepage value, so
 * saving one over a newer live page would put the old values back on Publish;
 * discarding only drops the draft, so for it the live page does not matter.
 */
export function homeVersionConflict(intent: HomeIntent, opened: HomeEditorVersion | null, now: HomeEditorVersion): 'live' | 'draft' | 'unknown' | null {
  if (!opened) return 'unknown';
  if (intent !== 'discard' && opened.live !== now.live) return 'live';
  if (opened.draft !== now.draft) return 'draft';
  return null;
}
