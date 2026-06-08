'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { X, ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export function ProductGallery({
  images,
  fallback,
  title,
  conditionLabel,
  mode,
}: {
  images: string[];
  fallback: string;
  title: string;
  conditionLabel: string;
  mode: 'BUY_NOW' | 'QUOTE_ONLY' | 'HYBRID';
}) {
  const pics = images.length > 0 ? images : [fallback];
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);

  const next = useCallback(() => setActive((i) => (i + 1) % pics.length), [pics.length]);
  const prev = useCallback(() => setActive((i) => (i - 1 + pics.length) % pics.length), [pics.length]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
    }
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, next, prev]);

  return (
    <div>
      {/* Main image */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative aspect-[5/4] w-full rounded-3xl overflow-hidden border border-border bg-white block cursor-zoom-in"
        aria-label="Open image viewer"
      >
        <Image
          src={pics[active]}
          alt={title}
          fill
          priority
          sizes="(min-width:1024px) 55vw, 100vw"
          className="object-contain p-4 transition-transform duration-500 group-hover:scale-[1.03]"
        />
        <div className="absolute top-5 left-5 flex gap-2">
          <Badge variant="secondary">{conditionLabel}</Badge>
          {mode === 'BUY_NOW' && <Badge variant="success">Buy now</Badge>}
          {mode === 'QUOTE_ONLY' && <Badge variant="accent">Quote only</Badge>}
        </div>
        <div className="absolute top-5 right-5 h-9 w-9 rounded-full bg-white/90 backdrop-blur flex items-center justify-center text-foreground opacity-0 group-hover:opacity-100 transition-opacity">
          <ZoomIn className="h-4 w-4" />
        </div>
      </button>

      {/* Thumbnails */}
      {pics.length > 1 && (
        <div className="mt-4 flex gap-3 flex-wrap">
          {pics.map((src, i) => (
            <button
              key={src + i}
              type="button"
              onClick={() => setActive(i)}
              className={`relative h-20 w-24 rounded-xl overflow-hidden border-2 bg-white transition-colors ${
                i === active ? 'border-primary' : 'border-border hover:border-primary/40'
              }`}
              aria-label={`View image ${i + 1}`}
            >
              <Image src={src} alt="" fill sizes="96px" className="object-contain p-1.5" />
            </button>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {open && (
        <div
          className="fixed inset-0 z-[100] bg-foreground/90 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute top-5 right-5 h-11 w-11 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>

          {pics.length > 1 && (
            <>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); prev(); }}
                className="absolute left-4 md:left-8 h-12 w-12 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center"
                aria-label="Previous"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); next(); }}
                className="absolute right-4 md:right-8 h-12 w-12 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center"
                aria-label="Next"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          )}

          <div
            className="relative w-full max-w-5xl aspect-[4/3]"
            onClick={(e) => e.stopPropagation()}
          >
            <Image
              src={pics[active]}
              alt={title}
              fill
              sizes="100vw"
              className="object-contain"
            />
          </div>

          {pics.length > 1 && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-2">
              {pics.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${i === active ? 'w-6 bg-white' : 'w-1.5 bg-white/40'}`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
