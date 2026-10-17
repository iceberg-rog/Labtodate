/**
 * A small in-process cache for public page data that is the same for every visitor and costly to compute on each
 * request (the homepage's live counts and category cards). A value is served as is for `ttlMs`; after that it is
 * still served while a fresh one is computed in the background, so after the first request no visitor waits on
 * these queries. A failed refresh keeps the last good value (the next request tries again).
 */
type Entry = { at: number; has: boolean; value: unknown; pending: Promise<unknown> | null };

const entries = new Map<string, Entry>();

export function staleWhileRevalidate<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  let e = entries.get(key);
  if (!e) {
    e = { at: 0, has: false, value: undefined, pending: null };
    entries.set(key, e);
  }
  const entry = e;
  const refresh = () => {
    if (!entry.pending) {
      entry.pending = load()
        .then((v) => {
          entry.value = v;
          entry.has = true;
          entry.at = Date.now();
          return v;
        })
        .finally(() => {
          entry.pending = null;
        });
    }
    return entry.pending as Promise<T>;
  };
  if (!entry.has) return refresh();
  if (Date.now() - entry.at > ttlMs) refresh().catch(() => {});
  return Promise.resolve(entry.value as T);
}
