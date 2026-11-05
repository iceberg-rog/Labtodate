'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, Printer } from 'lucide-react';

/**
 * Shows an issued document exactly as its PDF: the page it is printed from,
 * in a same-origin frame scaled to the screen. "Print" prints that frame
 * only (never the website around it); "Download PDF" serves the stored PDF.
 * The browser's own Ctrl+P also prints just the document (print CSS below).
 */
export function DocumentViewer({ htmlUrl, pdfUrl, title, compact = false }: { htmlUrl: string; pdfUrl: string; title: string; compact?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(1123);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1, el.clientWidth / 794)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function onLoad() {
    setLoaded(true);
    try {
      const doc = frame.current?.contentDocument;
      if (doc) setHeight(Math.max(1123, doc.documentElement.scrollHeight));
    } catch {
      /* cross-origin: keep A4 height */
    }
  }

  function print() {
    const w = frame.current?.contentWindow;
    if (w) {
      w.focus();
      w.print();
    } else {
      window.open(pdfUrl, '_blank');
    }
  }

  return (
    <div data-doc-viewer className="space-y-3">
      <style>{`@media print {
        html, body { background: #fff !important; }
        body * { visibility: hidden !important; }
        [data-doc-viewer], [data-doc-viewer] * { visibility: visible !important; }
        [data-doc-viewer] { position: absolute !important; left: 0; top: 0; width: 100% !important; }
        [data-doc-viewer] .doc-actions { display: none !important; }
        [data-doc-viewer] .doc-frame-wrap { height: auto !important; border: 0 !important; overflow: visible !important; }
        [data-doc-viewer] iframe { transform: none !important; width: 100% !important; }
      }`}</style>
      <div className="doc-actions flex items-center gap-2 flex-wrap">
        <button type="button" onClick={print} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90">
          <Printer className="h-4 w-4" /> Print
        </button>
        <a href={`${pdfUrl}${pdfUrl.includes('?') ? '&' : '?'}download=1`} className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg border border-border bg-background text-sm font-semibold hover:bg-foreground/[0.04]">
          <Download className="h-4 w-4" /> Download PDF
        </a>
        {!loaded && <span className="text-xs text-muted-foreground inline-flex items-center gap-1"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</span>}
      </div>
      <div
        ref={wrap}
        className="doc-frame-wrap w-full max-w-[794px] mx-auto overflow-hidden rounded-2xl border border-border bg-white shadow-sm"
        style={{ height: compact ? Math.min(Math.round(height * scale), 640) : Math.round(height * scale) }}
      >
        <iframe
          ref={frame}
          title={title}
          src={htmlUrl}
          onLoad={onLoad}
          style={{ width: 794, height, transform: `scale(${scale})`, transformOrigin: '0 0', border: 0, background: '#fff', display: 'block' }}
        />
      </div>
    </div>
  );
}
