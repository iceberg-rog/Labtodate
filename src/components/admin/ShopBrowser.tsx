'use client';

import { useRef, useState, useEffect } from 'react';
import { Loader2, Globe, RefreshCw, ExternalLink, ArrowLeft, Sparkles, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  initialUrl: string;
  companySlug: string;
}

/**
 * Mini in-app browser. Renders the supplier site inside an iframe pointed at
 * our same-origin /api/admin/source-proxy endpoint. The proxy injects a
 * toolbar with "Add via AI" so the user can navigate the supplier and import
 * products from the page they're looking at. Links are rewritten by the
 * proxy to stay inside the iframe; external links open in a new tab.
 */
export function ShopBrowser({ initialUrl }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState<string>(`/api/admin/source-proxy?url=${encodeURIComponent(initialUrl)}`);
  const [loading, setLoading] = useState(true);
  const [currentSourceUrl, setCurrentSourceUrl] = useState<string>(initialUrl);
  const [history, setHistory] = useState<string[]>([initialUrl]);

  // Track navigation inside the iframe by reading the data-source-href the
  // proxy injects on every <a> tag. We poll the iframe's URL post-load.
  useEffect(() => {
    setLoading(true);
  }, [src]);

  function onLoad() {
    setLoading(false);
    // After load, try to read the iframe's location.search to find the proxied URL.
    try {
      const ifr = iframeRef.current;
      if (!ifr) return;
      const loc = ifr.contentWindow?.location;
      if (loc && loc.pathname === '/api/admin/source-proxy') {
        const u = new URLSearchParams(loc.search).get('url');
        if (u) {
          setCurrentSourceUrl(u);
          setHistory((h) => (h[h.length - 1] === u ? h : [...h, u]));
        }
      }
    } catch {
      // cross-origin shouldn't trigger since we're same-origin, but be defensive.
    }
  }

  function reload() {
    if (iframeRef.current) iframeRef.current.contentWindow?.location.reload();
  }

  function back() {
    if (history.length < 2) return;
    const newHistory = history.slice(0, -1);
    const target = newHistory[newHistory.length - 1];
    setHistory(newHistory);
    setSrc(`/api/admin/source-proxy?url=${encodeURIComponent(target)}`);
  }

  function goToUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) return;
    setHistory((h) => [...h, url]);
    setSrc(`/api/admin/source-proxy?url=${encodeURIComponent(url)}`);
  }

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      {/* Outer toolbar (controls the iframe). Inner toolbar is injected by the proxy itself
       *  and shows "Add via AI" + already-imported badge for the current page.  */}
      <div className="border-b border-border bg-foreground/[0.02] p-2.5 flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="outline" onClick={back} disabled={history.length < 2} className="rounded-full h-8">
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="outline" onClick={reload} className="rounded-full h-8">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <UrlInput value={currentSourceUrl} onSubmit={goToUrl} />
        <a href={currentSourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2.5 h-8 rounded-full border border-border text-xs font-semibold hover:bg-foreground/5">
          <ExternalLink className="h-3 w-3" /> Open
        </a>
      </div>

      <div className="relative bg-muted" style={{ height: 640 }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/85 backdrop-blur-sm z-10 pointer-events-none">
            <div className="text-center">
              <Loader2 className="h-7 w-7 animate-spin text-primary mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">Fetching {(() => { try { return new URL(currentSourceUrl).hostname.replace(/^www\./, ''); } catch { return currentSourceUrl; } })()}…</p>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={src}
          onLoad={onLoad}
          // The proxy serves with X-Frame-Options: SAMEORIGIN so the iframe accepts us.
          sandbox="allow-same-origin allow-top-navigation-by-user-activation"
          style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
          title="Source site preview"
        />
      </div>

      <div className="border-t border-border bg-foreground/[0.02] px-3 py-2 text-[11px] text-muted-foreground flex items-start gap-1.5">
        <Info className="h-3 w-3 mt-0.5 flex-shrink-0" />
        <span>
          Browsing through a sanitised proxy (no scripts / forms / iframes). When you land on a product page,
          a yellow <strong>Add via AI</strong> button appears in the green toolbar — click it to extract the product into a DRAFT.
          Duplicate URLs are detected and the toolbar links to the existing draft instead.
        </span>
      </div>
    </div>
  );
}

function UrlInput({ value, onSubmit }: { value: string; onSubmit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSubmit(draft); }}
      className="flex-1 min-w-[200px]"
    >
      <div className="flex items-center gap-1.5 bg-background rounded-full border border-input px-3 h-8">
        <Globe className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://example.com/product/…"
          className="flex-1 min-w-0 bg-transparent outline-none text-xs font-mono"
          spellCheck={false}
        />
        <button type="submit" className="text-xs font-bold text-primary flex-shrink-0">Go ↵</button>
      </div>
    </form>
  );
}
