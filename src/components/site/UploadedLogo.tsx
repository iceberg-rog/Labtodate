'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * The logo set in Admin → Settings, fitted into a fixed box (left-aligned,
 * aspect ratio kept). `onLight`: a logo made for white (the document logo)
 * sits on a white tile, so a dark logo stays readable on the dark site. When
 * the file can't be loaded (deleted, moved, host down) the built-in lock-up
 * (`fallback`) is shown instead of a broken-image icon.
 */
export function UploadedLogo({
  src,
  alt,
  width,
  height,
  priority,
  onLight = false,
  className,
  fallback,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  priority?: boolean;
  onLight?: boolean;
  className?: string;
  fallback: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement | null>(null);
  // An error before hydration fires no onError: check the loaded state once
  // (and start over when the logo changes).
  useEffect(() => {
    const img = ref.current;
    setFailed(!!img && img.complete && img.naturalWidth === 0);
  }, [src]);

  if (failed) return <>{fallback}</>;
  const img = (
    // An admin-uploaded file of any aspect ratio on our own /media path; the
    // box below reserves its space, next/image would need the size up front.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={src}
      alt={alt}
      width={width}
      height={height}
      // Never lazy: header, footer and admin bar share one small, cached file.
      decoding="async"
      fetchPriority={priority ? 'high' : undefined}
      onError={() => setFailed(true)}
      className={cn('block object-contain object-left', !onLight && className)}
      style={{ width, height }}
    />
  );
  if (!onLight) return img;
  // The tile pads the box (the logo keeps its size): white as the documents
  // and e-mails it was made for.
  return (
    <span className={cn('inline-flex rounded-lg bg-white px-2.5 py-1 shadow-sm ring-1 ring-black/5', className)}>
      {img}
    </span>
  );
}
