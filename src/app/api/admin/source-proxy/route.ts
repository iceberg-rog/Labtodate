/**
 * Admin-only HTML proxy used by the in-app "shop browser". Fetches a remote
 * page via the SSRF-safe pipeline, sanitises it (no scripts, no forms, no
 * iframes, no event handlers), rewrites internal links so navigation stays
 * inside the proxy, and injects a sticky toolbar with an "Add via AI" button.
 *
 * Security model:
 *   - GET only, admin-gated (better-auth session with capability check)
 *   - safe-fetch enforces public-IP allowlist; private/loopback blocked
 *   - response stripped of <script>, <form>, <iframe>, <object>, event
 *     handlers, and CSP/X-Frame-Options/Refresh headers that could escape
 *   - all <a href> rewritten through this same route → user can't navigate
 *     out of the proxy by accident; external links open in a new tab
 *   - relative URLs absolutised so images load directly from origin
 *   - we drop request/response cookies → no session forwarding
 */

import { NextResponse } from 'next/server';
import { getServerSession, getAdminCaps } from '@/lib/auth-server';
import { capsAllow } from '@/lib/capabilities';
import { safeFetch, SafeFetchError } from '@/lib/import/safe-fetch';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function selfProxyUrl(target: string): string {
  return `/api/admin/source-proxy?url=${encodeURIComponent(target)}`;
}

/** Strip dangerous elements + rewrite links. Plain-text regex pass — fast,
 *  good enough for a one-page admin tool. Not a real HTML parser. */
function transformHtml(html: string, base: URL): { html: string; productLikely: boolean } {
  let out = html;

  // Remove scripts, styles? — keep styles for visual fidelity.
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  // Remove forms — we don't want POSTs from inside the proxy.
  out = out.replace(/<form\b[\s\S]*?<\/form>/gi, '');
  // Remove iframes (some sites embed analytics) — we already disallow them in CSP.
  out = out.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '');
  out = out.replace(/<object\b[\s\S]*?<\/object>/gi, '');
  out = out.replace(/<embed\b[\s\S]*?>/gi, '');
  // Remove inline event handlers like onclick="…"
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  // Remove meta refresh (could escape the proxy)
  out = out.replace(/<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]*>/gi, '');
  // Remove <base> so relative URLs resolve against base we control
  out = out.replace(/<base\b[^>]*>/gi, '');
  // Keep <link rel="stylesheet"> and rewrite href to absolute (otherwise the
  // iframe resolves it against /api/admin/source-proxy and 404s, leaving
  // the page totally unstyled). Strip every other <link> rel (preload as=
  // script, manifest, etc.) since the source can't function inside our
  // sandboxed iframe anyway.
  out = out.replace(/<link\b([^>]*?)>/gi, (m, attrs) => {
    if (!/rel\s*=\s*["']?stylesheet["']?/i.test(attrs)) return '';
    return '<link ' + attrs.replace(/href\s*=\s*("([^"]*)"|'([^']*)')/i, (_h: string, _full: string, dq: string, sq: string) => {
      const raw = (dq ?? sq ?? '').trim();
      if (!raw) return '';
      try { return `href="${escapeHtml(new URL(raw, base).toString())}"`; } catch { return ''; }
    }) + '>';
  });
  // <link rel="icon"> (favicon) — also worth absolutising before stripping so
  // the iframe doesn't request 404s. But we strip the lot above; favicons are
  // cosmetic-only inside a drawer so the trade-off is fine.

  // Rewrite anchor hrefs:
  //   - http(s) absolute → proxy
  //   - relative → resolve against base then proxy
  //   - other (mailto:, javascript:, etc.) → strip
  out = out.replace(/<a\b([^>]*?)href\s*=\s*("([^"]*)"|'([^']*)')([^>]*)>/gi, (m, pre, _full, dq, sq, post) => {
    const raw = (dq ?? sq ?? '').trim();
    if (!raw || /^javascript:/i.test(raw) || /^mailto:/i.test(raw) || /^tel:/i.test(raw)) return `<a ${pre}${post} href="javascript:void(0)" data-stripped="1">`;
    let absolute: string;
    try { absolute = new URL(raw, base).toString(); } catch { return `<a ${pre}${post} data-bad-href="1">`; }
    return `<a ${pre}href="${escapeHtml(selfProxyUrl(absolute))}" data-source-href="${escapeHtml(absolute)}" target="_top"${post}>`;
  });

  // Absolutise <img src> and srcset so they load directly from the origin (no proxy bandwidth).
  out = out.replace(/<img\b([^>]*?)src\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, pre, _full, dq, sq) => {
    const raw = (dq ?? sq ?? '').trim();
    if (!raw || raw.startsWith('data:')) return m;
    try {
      const abs = new URL(raw, base).toString();
      return `<img ${pre}src="${escapeHtml(abs)}"`;
    } catch { return m; }
  });
  // <source srcset> + <picture>
  out = out.replace(/srcset\s*=\s*"([^"]+)"/gi, (m, val) => {
    const fixed = val.split(',').map((part: string) => {
      const [u, d] = part.trim().split(/\s+/, 2);
      try { return `${new URL(u, base).toString()}${d ? ' ' + d : ''}`; } catch { return part; }
    }).join(', ');
    return `srcset="${escapeHtml(fixed)}"`;
  });

  // Quick heuristic: does this page look like a product detail page?
  // (single "add to cart" or schema.org Product or single h1 + price-ish text)
  const productLikely =
    /(application\/ld\+json)/.test(out) && /"@type"\s*:\s*"Product"/i.test(out)
    || /add to cart|add-to-cart|buy[\s-]now/i.test(out)
    || /<meta[^>]+(property|name)\s*=\s*["']og:type["'][^>]+content\s*=\s*["']product["']/i.test(out)
    || /<meta[^>]+itemprop\s*=\s*["']price["']/i.test(out);

  return { html: out, productLikely };
}

const TOOLBAR_CSS = `
  body { margin-top: 64px !important; }
  #l2d-toolbar { position: fixed; top: 0; left: 0; right: 0; height: 56px; z-index: 2147483647;
    background: #064e3b; color: #fff; display: flex; align-items: center; gap: 12px; padding: 0 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 13px;
    box-shadow: 0 2px 6px rgba(0,0,0,0.18); }
  #l2d-toolbar a, #l2d-toolbar button { color: #fff; }
  #l2d-toolbar .l2d-url { flex: 1; min-width: 0; background: rgba(255,255,255,0.12); padding: 7px 10px;
    border-radius: 8px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #l2d-toolbar button { background: #fbbf24; color: #064e3b; border: 0; padding: 8px 14px; border-radius: 999px;
    font-weight: 700; font-size: 12px; cursor: pointer; white-space: nowrap; }
  #l2d-toolbar button:hover { background: #fde047; }
  #l2d-toolbar button.l2d-secondary { background: rgba(255,255,255,0.12); color: #fff; }
  #l2d-toolbar .l2d-badge { padding: 4px 8px; border-radius: 999px; font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.04em; }
  #l2d-toolbar .l2d-badge.ok { background: #d1fae5; color: #064e3b; }
  #l2d-toolbar .l2d-badge.warn { background: #fef3c7; color: #78350f; }
`;

function toolbarHtml(currentUrl: string, productLikely: boolean, alreadyImported: { slug: string; title: string } | null, shopSlug?: string | null): string {
  const importHref = `/admin/products/import-url?url=${encodeURIComponent(currentUrl)}${shopSlug ? `&shop=${encodeURIComponent(shopSlug)}` : ''}`;
  const status = alreadyImported
    ? `<span class="l2d-badge ok">Already imported · ${escapeHtml(alreadyImported.slug)}</span>`
    : productLikely
      ? `<span class="l2d-badge warn">Product page detected</span>`
      : `<span class="l2d-badge">Browse</span>`;
  const addBtn = alreadyImported
    ? `<a href="/admin/products/${escapeHtml(alreadyImported.slug)}" target="_top"><button>Open existing draft →</button></a>`
    : `<a href="${escapeHtml(importHref)}" target="_top"><button>+ Add this product via AI</button></a>`;
  return `
<div id="l2d-toolbar">
  <a href="javascript:history.back()" title="Back"><button class="l2d-secondary">←</button></a>
  <span class="l2d-url" title="${escapeHtml(currentUrl)}">${escapeHtml(currentUrl)}</span>
  ${status}
  <a href="${escapeHtml(currentUrl)}" target="_blank" rel="noreferrer"><button class="l2d-secondary">Open in new tab ↗</button></a>
  ${addBtn}
</div>
<style>${TOOLBAR_CSS}</style>`;
}

export async function GET(req: Request) {
  const session = await getServerSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!session || role !== 'ADMIN') {
    return new NextResponse('Forbidden', { status: 403 });
  }
  const caps = await getAdminCaps();
  if (!capsAllow(caps, 'companies:manage')) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const u = new URL(req.url).searchParams.get('url');
  if (!u) return new NextResponse('Missing url', { status: 400 });
  let target: URL;
  try { target = new URL(u); } catch { return new NextResponse('Bad url', { status: 400 }); }

  let res;
  try {
    res = await safeFetch(target.toString(), { accept: 'text/html,application/xhtml+xml', maxBytes: 6 * 1024 * 1024, timeoutMs: 15_000 });
  } catch (e) {
    const msg = e instanceof SafeFetchError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : 'unknown';
    return errorPage(target.toString(), msg);
  }
  // Only transform HTML responses; for non-HTML (PDF, images), redirect the
  // browser directly to the original origin URL — they don't need the toolbar.
  if (!/html|xml/i.test(res.contentType)) {
    return NextResponse.redirect(res.finalUrl, { status: 302 });
  }

  const finalUrl = new URL(res.finalUrl);
  const { html, productLikely } = transformHtml(res.body, finalUrl);

  // Check whether this URL was already imported.
  const existing = await prisma.product.findUnique({
    where: { sourceUrl: res.finalUrl },
    select: { slug: true, title: true },
  });

  // Resolve which supplier this hostname belongs to so the "Add via AI"
  // link can pre-fill the Shop / supplier field on the importer.
  const hostNoWww = finalUrl.hostname.replace(/^www\./, '');
  const shopMatch = await prisma.company.findFirst({
    where: { importSourceUrl: { contains: hostNoWww } },
    select: { slug: true },
  });

  const toolbar = toolbarHtml(res.finalUrl, productLikely, existing, shopMatch?.slug ?? null);
  const headerInjection = /<body[^>]*>/i.test(html)
    ? html.replace(/<body([^>]*)>/i, `<body$1>${toolbar}`)
    : toolbar + html;

  return new NextResponse(headerInjection, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Tighten CSP: only allow inline styles + images from origin.
      'Content-Security-Policy':
        "default-src 'none'; img-src * data: blob:; style-src 'self' 'unsafe-inline' *; font-src * data:; connect-src 'self'; frame-ancestors 'self'",
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
    },
  });
}

function errorPage(url: string, message: string): NextResponse {
  const safeUrl = escapeHtml(url);
  const safeMsg = escapeHtml(message);
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Source unavailable</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;padding:48px;background:#fef2f2;color:#7f1d1d;line-height:1.6}
.box{background:#fff;border:1px solid #fecaca;border-radius:16px;padding:32px;max-width:640px;margin:0 auto;box-shadow:0 4px 14px rgba(0,0,0,0.08)}
.code{font-family:ui-monospace,monospace;background:#fee2e2;padding:6px 10px;border-radius:6px;font-size:13px;display:inline-block;margin-top:8px}
a.btn{display:inline-block;margin-top:18px;background:#7f1d1d;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none;font-weight:700}</style></head>
<body><div class="box">
<h2>Couldn't load this page through the proxy</h2>
<p>The source server returned an error or refused our request.</p>
<div class="code">${safeMsg}</div>
<p style="margin-top:18px">You can still open this URL in a new tab and paste its product URL into the URL importer.</p>
<a class="btn" href="${safeUrl}" target="_blank" rel="noreferrer">Open ${safeUrl} ↗</a>
</div></body></html>`;
  return new NextResponse(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
}
