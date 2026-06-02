/**
 * SSRF-safe HTTP fetcher for the URL import pipeline.
 *
 * Why hand-rolled instead of plain `fetch`: a naive admin-side fetch can be
 * weaponised to hit internal services (RDS metadata, MinIO admin port,
 * docker-internal API, localhost dev tools). Untrusted URLs supplied by an
 * admin still pass through this code, so we enforce:
 *
 *  1. scheme allowlist (http/https only)
 *  2. DNS resolution → IP check against private / loopback / link-local /
 *     reserved ranges, BEFORE the socket connects
 *  3. lookup pin: the resolved IP is fed back into Node's `lookup` hook so
 *     a rebinding DNS server can't switch the IP between check and connect
 *  4. manual redirect handling: each Location is re-validated end-to-end
 *  5. read timeout + maximum response body size (10 MB)
 *
 * This file deliberately has zero `@/lib/db` / `@/lib/auth` imports — keep it
 * pure so the extractor pipeline can be reasoned about in isolation.
 */

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 10 * 1024 * 1024;     // 10 MB
const DEFAULT_TIMEOUT_MS = 12_000;
const USER_AGENT = 'lab2date-url-importer/1.0 (+https://labtodate.com/admin)';

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;            // UTF-8 decoded (we hand-decode after size check)
  bytes: number;
}

export class SafeFetchError extends Error {
  constructor(message: string, readonly code: 'BAD_SCHEME' | 'BAD_HOST' | 'PRIVATE_IP' | 'DNS_FAIL' | 'TOO_MANY_REDIRECTS' | 'TIMEOUT' | 'TOO_LARGE' | 'STATUS' | 'NETWORK') {
    super(message);
  }
}

/**
 * Is this IPv4 or IPv6 address in a private / reserved range we must NOT
 * connect to? Returns the matching reason or null if it's public.
 */
export function classifyIp(ip: string): string | null {
  const family = isIP(ip);
  if (family === 0) return 'not-an-ip';

  if (family === 4) {
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return 'malformed-ipv4';
    }
    const [a, b] = parts;
    if (a === 0) return 'zeronet';
    if (a === 10) return 'private-10/8';
    if (a === 127) return 'loopback-127/8';
    if (a === 169 && b === 254) return 'link-local-169.254/16';
    if (a === 172 && b >= 16 && b <= 31) return 'private-172.16/12';
    if (a === 192 && b === 168) return 'private-192.168/16';
    if (a === 192 && b === 0 && parts[2] === 0) return 'reserved-192.0.0/24';
    if (a === 192 && b === 0 && parts[2] === 2) return 'doc-192.0.2/24';
    if (a === 198 && (b === 18 || b === 19)) return 'benchmark-198.18/15';
    if (a === 198 && b === 51 && parts[2] === 100) return 'doc-198.51.100/24';
    if (a === 203 && b === 0 && parts[2] === 113) return 'doc-203.0.113/24';
    if (a >= 224 && a <= 239) return 'multicast-224/4';
    if (a >= 240) return 'reserved-240/4';
    if (a === 100 && b >= 64 && b <= 127) return 'cgnat-100.64/10';
    if (a === 255 && b === 255 && parts[2] === 255 && parts[3] === 255) return 'broadcast';
    return null;
  }

  // IPv6: do a simpler textual check. Lowercased canonical form is fine.
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return 'loopback-ipv6';
  if (v.startsWith('fe80:') || v.startsWith('fe80::')) return 'link-local-ipv6';
  if (v.startsWith('fc') || v.startsWith('fd')) return 'ula-fc00::/7';
  if (v.startsWith('ff')) return 'multicast-ipv6';
  // IPv4-mapped / 4-in-6 — recheck the embedded v4 address.
  const v4 = v.match(/^::ffff:([\d.]+)$/);
  if (v4) return classifyIp(v4[1]) ?? null;
  return null;
}

interface ResolvedHost {
  ip: string;
  family: 4 | 6;
}

async function resolvePublicIp(host: string): Promise<ResolvedHost> {
  // If host is itself an IP literal, validate directly.
  const literal = isIP(host);
  if (literal !== 0) {
    const reason = classifyIp(host);
    if (reason) throw new SafeFetchError(`Blocked IP literal (${reason}).`, 'PRIVATE_IP');
    return { ip: host, family: literal as 4 | 6 };
  }
  let lookup: Awaited<ReturnType<typeof dns.lookup>>;
  try {
    // verbatim true preserves the order the resolver gives us; we take the
    // first answer and pin it for the connection.
    lookup = await dns.lookup(host, { all: false, verbatim: true });
  } catch (e) {
    throw new SafeFetchError(`DNS lookup failed for ${host}: ${e instanceof Error ? e.message : 'unknown'}`, 'DNS_FAIL');
  }
  const reason = classifyIp(lookup.address);
  if (reason) throw new SafeFetchError(`Host ${host} resolves to blocked IP ${lookup.address} (${reason}).`, 'PRIVATE_IP');
  return { ip: lookup.address, family: lookup.family as 4 | 6 };
}

/**
 * Single-hop fetch with IP pinning. Manually walks redirects (revalidating
 * each hop), caps body size, decodes UTF-8.
 */
export async function safeFetch(rawUrl: string, options: { timeoutMs?: number; maxBytes?: number; accept?: string } = {}): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const accept = options.accept ?? '*/*';

  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (hop === MAX_REDIRECTS) throw new SafeFetchError(`Too many redirects (>${MAX_REDIRECTS}).`, 'TOO_MANY_REDIRECTS');
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new SafeFetchError(`Invalid URL: ${url}`, 'BAD_HOST'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SafeFetchError(`Disallowed scheme ${parsed.protocol} (only http/https).`, 'BAD_SCHEME');
    }
    if (!parsed.hostname) throw new SafeFetchError('Missing host.', 'BAD_HOST');

    const pinned = await resolvePublicIp(parsed.hostname);

    const result = await doRequest(parsed, pinned, accept, timeoutMs, maxBytes);
    if (result.kind === 'redirect') {
      if (!result.location) throw new SafeFetchError('Redirect without Location header.', 'NETWORK');
      url = new URL(result.location, parsed).toString();
      continue;
    }
    return result.value;
  }
  throw new SafeFetchError('Unreachable.', 'NETWORK');
}

interface RedirectOutcome { kind: 'redirect'; location: string | null }
interface BodyOutcome { kind: 'ok'; value: SafeFetchResult }

function doRequest(
  url: URL,
  pinned: ResolvedHost,
  accept: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<RedirectOutcome | BodyOutcome> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    // We already validated `pinned.ip` is a public IP. Connect directly to
    // that IP but send the original hostname in Host and SNI servername so
    // both HTTP and TLS routing resolve correctly. Bypassing DNS at the
    // socket level prevents DNS-rebinding attacks between check and connect.
    const req = mod.request({
      method: 'GET',
      host: pinned.ip,
      family: pinned.family,
      port: url.port ? parseInt(url.port, 10) : undefined,
      path: (url.pathname || '/') + (url.search || ''),
      headers: {
        'Host': url.hostname + (url.port ? `:${url.port}` : ''),
        'User-Agent': USER_AGENT,
        'Accept': accept,
        'Accept-Encoding': 'identity',
      },
      ...(isHttps ? { servername: url.hostname } : {}),
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode ?? 0;
      // 3xx with Location → redirect
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ kind: 'redirect', location: res.headers.location as string });
        return;
      }
      // disallow non-success here so the caller doesn't have to deal with HTML 5xx
      if (status === 0 || status >= 500) {
        res.resume();
        reject(new SafeFetchError(`HTTP ${status} from ${url.hostname}.`, 'STATUS'));
        return;
      }
      const contentType = (res.headers['content-type'] as string | undefined) ?? '';
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          res.destroy(new SafeFetchError(`Response > ${maxBytes} bytes.`, 'TOO_LARGE'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          kind: 'ok',
          value: {
            status,
            finalUrl: url.toString(),
            contentType,
            body: buf.toString('utf8'),
            bytes: buf.length,
          },
        });
      });
      res.on('error', (e) => reject(e instanceof SafeFetchError ? e : new SafeFetchError(`Stream error: ${e.message}`, 'NETWORK')));
    });
    req.on('timeout', () => { req.destroy(new SafeFetchError(`Timeout after ${timeoutMs}ms.`, 'TIMEOUT')); });
    req.on('error', (e) => {
      if (e instanceof SafeFetchError) reject(e);
      else {
        const code = (e as NodeJS.ErrnoException).code ?? 'NETERR';
        reject(new SafeFetchError(`Network error [${code}]: ${e.message}`, 'NETWORK'));
      }
    });
    req.end();
  });
}
