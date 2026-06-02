'use client';

import { useEffect, useState } from 'react';
import { X, Eye, ExternalLink, Award } from 'lucide-react';

type Item = {
  id: string;
  slug: string;
  title: string;
  customer: string;
  outcomeMetric: string;
  excerpt: string;
  body: string;
  published: boolean;
};

export function CaseStudyPreviewButton({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    if (open) {
      window.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold hover:bg-foreground/5"
      >
        <Eye className="h-3.5 w-3.5" /> Preview
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          />
          <div className="relative w-full md:max-w-3xl bg-card border border-border md:rounded-2xl shadow-xl max-h-[92vh] overflow-auto">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 p-5 border-b border-border bg-card">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
                  Case study preview {item.published ? '· live' : '· DRAFT'}
                </p>
                <h2 className="text-lg font-bold truncate">{item.title}</h2>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {item.published && (
                  <a
                    href={`/case-studies/${item.slug}`}
                    target="_blank"
                    className="inline-flex items-center gap-1 rounded-full border border-border px-3 h-8 text-xs font-semibold hover:bg-foreground/5"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Open live
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="p-1.5 rounded-lg hover:bg-foreground/5 text-muted-foreground"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <article className="p-6 md:p-10 prose prose-sm md:prose-base max-w-none">
              <div className="not-prose flex items-center gap-2 text-xs uppercase tracking-wider font-bold text-primary">
                <Award className="h-3.5 w-3.5" /> Customer story
              </div>
              <h1 className="!mt-2">{item.title}</h1>
              <p className="not-prose text-sm text-muted-foreground">
                <strong className="text-foreground">{item.customer}</strong>
                {item.outcomeMetric && (
                  <>
                    {' · outcome: '}
                    <strong className="text-foreground">{item.outcomeMetric}</strong>
                  </>
                )}
              </p>
              {item.excerpt && (
                <p className="lead text-base md:text-lg text-muted-foreground border-l-2 border-primary pl-4">
                  {item.excerpt}
                </p>
              )}
              {item.body ? (
                <div
                  className="whitespace-pre-wrap text-[15px] leading-relaxed"
                  // Body is plain text only; rendered verbatim with line breaks preserved.
                >
                  {item.body}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">No body text yet — add it in the edit form.</p>
              )}
            </article>
          </div>
        </div>
      )}
    </>
  );
}
