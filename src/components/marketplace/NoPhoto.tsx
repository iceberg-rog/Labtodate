import { Camera } from 'lucide-react';
import { InstrumentIllustration, ILLUSTRATIONS, type IllustrationName } from '@/components/illustrations/instruments';
import { cn } from '@/lib/utils';

export type MissingPhotoMode = 'PLACEHOLDER' | 'LABELLED_ILLUSTRATION';

/**
 * What a listing without its own photos shows instead (Settings → Catalog &
 * claims → “Listings without photos show”). Never a stock photo of another
 * instrument: either a neutral “Photo on request” tile, or our generic drawing
 * with a visible “Illustration – not the actual item” label.
 * Hook-free, so it renders in server and client components alike.
 */
export function NoPhoto({
  mode,
  illustration,
  labels,
  compact = false,
  className,
}: {
  mode: MissingPhotoMode;
  illustration?: string | null;
  /** Settings → Catalog & claims (NO_PHOTO_LABEL / ILLUSTRATION_LABEL). */
  labels?: { noPhoto?: string; illustration?: string };
  compact?: boolean;
  className?: string;
}) {
  // A drawing only when the item has one that fits it (set from its category);
  // otherwise the neutral placeholder — never a balance standing in for a motor.
  const fitting = illustration && illustration in ILLUSTRATIONS ? (illustration as IllustrationName) : null;
  if (mode === 'LABELLED_ILLUSTRATION' && fitting) {
    const name = fitting;
    return (
      <div className={cn('relative w-full h-full bg-muted flex items-center justify-center', className)} data-no-photo="illustration">
        <InstrumentIllustration name={name} className={compact ? 'p-4 opacity-80' : 'p-10 opacity-80'} />
        <span
          className={cn(
            'absolute left-2 bottom-2 rounded-md bg-background/90 border border-border font-semibold text-muted-foreground',
            compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-[11px]',
          )}
        >
          {labels?.illustration || 'Illustration – not the actual item'}
        </span>
      </div>
    );
  }
  return (
    <div
      className={cn('w-full h-full bg-muted flex flex-col items-center justify-center gap-1.5 text-muted-foreground', className)}
      data-no-photo="placeholder"
    >
      <Camera className={compact ? 'h-6 w-6' : 'h-10 w-10'} aria-hidden />
      <span className={cn('font-semibold', compact ? 'text-[11px]' : 'text-sm')}>{labels?.noPhoto || 'Photo on request'}</span>
    </div>
  );
}
