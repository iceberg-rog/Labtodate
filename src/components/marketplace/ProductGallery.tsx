'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import { X, ChevronLeft, ChevronRight, ZoomIn } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { NoPhoto, type MissingPhotoMode } from '@/components/marketplace/NoPhoto';

/** How the unit can be bought now (“Buy now”, “Quote only”) or why it cannot
 *  (“Sold”, “Reserved”…) — decided by the product page from its stock. */
export interface GalleryStatusBadge {
  label: string;
  tone: 'success' | 'accent' | 'muted';
}

const BADGE_VARIANT = { success: 'success', accent: 'accent', muted: 'secondary' } as const;

function Badges({ conditionLabel, statusBadge }: { conditionLabel: string; statusBadge?: GalleryStatusBadge | null }) {
  return (
    <>
      <Badge variant="secondary">{conditionLabel}</Badge>
      {statusBadge && (
        <Badge variant={BADGE_VARIANT[statusBadge.tone]} data-testid="gallery-status-badge">
          {statusBadge.label}
        </Badge>
      )}
    </>
  );
}

/** `images` must already be buyer-facing (our own /media paths only — see
 *  publicProductImages). With none, the configured no-photo tile is shown. */
export function ProductGallery({
  images,
  photoMode,
  illustration,
  title,
  conditionLabel,
  statusBadge,
}: {
  images: string[];
  photoMode: MissingPhotoMode;
  illustration?: string | null;
  title: string;
  conditionLabel: string;
  statusBadge?: GalleryStatusBadge | null;
}) {
  const pics = images;
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

  if (pics.length === 0) {
    return (
      <div className="relative aspect-[5/4] w-full rounded-3xl overflow-hidden border border-border bg-card">
        <NoPhoto mode={photoMode} illustration={illustration} />
        <div className="absolute top-5 left-5 flex gap-2">
          <Badges conditionLabel={conditionLabel} statusBadge={statusBadge} />
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Main image */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative aspect-[5/4] w-full rounded-3xl overflow-hidden border border-border bg-card block cursor-zoom-in"
        aria-label="Open image viewer"
      >
        {/* The photo sits below the badge strip, so a badge never covers it. */}
        <div className="absolute inset-x-0 bottom-0 top-14">
          <Image
            src={pics[active]}
            alt={title}
            fill
            priority
            sizes="(min-width:1024px) 55vw, 100vw"
            className="object-contain px-4 pb-4 transition-transform duration-500 group-hover:scale-[1.03]"
          />
        </div>
        <div className="absolute top-4 left-4 right-16 flex flex-wrap gap-2">
          <Badges conditionLabel={conditionLabel} statusBadge={statusBadge} />
        </div>
        <div className="absolute top-3 right-4 h-9 w-9 rounded-full bg-card/90 backdrop-blur flex items-center justify-center text-foreground opacity-0 group-hover:opacity-100 transition-opacity">
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
              className={`relative h-20 w-24 rounded-xl overflow-hidden border-2 bg-card transition-colors ${
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
