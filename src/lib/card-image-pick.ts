/**
 * The homepage's category cards show a product photo whole, in a near-square frame. Among a category's photos this
 * picks one with enough pixels to fill that frame sharply (catalogue photos range from 300 px thumbnails to 4K phone
 * shots). Sizes are read from the first bytes of each file (JPEG / PNG / WebP headers, a ranged request), measured in
 * the background a few at a time and cached for the life of the server process; until a category's sizes are known
 * the caller's fallback is used, so no page ever waits on this.
 */
type Size = { w: number; h: number };

const sizes = new Map<string, Size | null>();
const queued = new Set<string>();
const queue: string[] = [];
let running = 0;
const PARALLEL = 4;
const FRAME_PX = 520; // the frame's short side on a desktop card, in texture pixels

const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** Width and height from an image file's first bytes (JPEG, PNG, WebP), or null. */
export function parseImageSize(b: Uint8Array): Size | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: u32(b, 16), h: u32(b, 20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) { i += m === 0xff ? 1 : 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === 'VP8L') return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
  }
  return null;
}

const hostOf = (v: string | undefined): string | null => {
  try {
    return v ? new URL(v).host.toLowerCase() : null;
  } catch {
    return null;
  }
};

/**
 * The "/media/<bucket>/<key>" path of a photo in our own media store, or null. Only those are ever read: a
 * host-relative /media/ path, or the same path on the site's own origin (BETTER_AUTH_URL, S3_PUBLIC_URL). A supplier
 * URL is never fetched by the server (it is also never picked: the card keeps the caller's fallback for it).
 */
export function ownMediaPathOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url, 'http://relative.invalid');
  } catch {
    return null;
  }
  const relative = u.host === 'relative.invalid' && url.startsWith('/');
  const own = [process.env.BETTER_AUTH_URL, process.env.NEXT_PUBLIC_BETTER_AUTH_URL, process.env.S3_PUBLIC_URL].map(hostOf);
  if (!relative && !(u.protocol === 'https:' && own.includes(u.host.toLowerCase()))) return null;
  // (the URL parser has resolved any ".."; what is left must still be inside /media/)
  return u.pathname.startsWith('/media/') && u.pathname.length > '/media/'.length ? u.pathname : null;
}

// Where the server reads one of our photos: straight from the object store (what the /media/ proxy serves), then
// through the site's own origin.
const sources = (url: string): string[] => {
  const path = ownMediaPathOf(url);
  if (!path) return [];
  const out: string[] = [];
  const store = process.env.S3_ENDPOINT, site = process.env.BETTER_AUTH_URL;
  if (store) out.push(`${store.replace(/\/+$/, '')}/${path.slice('/media/'.length)}`);
  if (site) out.push(`${site.replace(/\/+$/, '')}${path}`);
  return out;
};

async function measure(url: string) {
  for (const src of sources(url)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const res = await fetch(src, { headers: { Range: 'bytes=0-131071' }, signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) continue;
      const size = parseImageSize(new Uint8Array(await res.arrayBuffer()));
      if (size) { sizes.set(url, size); return; }
    } catch {
      /* try the next source */
    } finally {
      clearTimeout(timer);
    }
  }
  sizes.set(url, null);
}

function pump() {
  while (running < PARALLEL && queue.length) {
    const url = queue.shift() as string;
    running++;
    void measure(url).finally(() => { running--; queued.delete(url); pump(); });
  }
}

/**
 * Among candidates ranked best-first by the caller (how well each product shows its category), the first one with
 * enough pixels to fill the card's frame: a sharp photo a few places down the ranking beats a blurry first choice.
 * Until the sizes are known, the fallback.
 */
export function pickCardImage(candidates: string[], fallback: string | null): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const [rank, url] of candidates.entries()) {
    if (!ownMediaPathOf(url)) continue;   // (never a supplier's photo: those keep the caller's fallback)
    if (!sizes.has(url)) {
      if (!queued.has(url)) { queued.add(url); queue.push(url); }
      continue;
    }
    const s = sizes.get(url);
    if (!s || !s.w || !s.h) continue;
    const short = Math.min(s.w, s.h), ratio = Math.max(s.w, s.h) / short;
    const score = Math.min(1, short / FRAME_PX) * (ratio > 2.2 ? 0.5 : 1) - rank * 0.02;
    if (score > bestScore) { bestScore = score; best = url; }
  }
  pump();
  return best ?? fallback;
}
