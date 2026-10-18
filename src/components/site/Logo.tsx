import { cn } from '@/lib/utils';
import { UploadedLogo } from './UploadedLogo';

// The box an uploaded logo is fitted into (any aspect ratio; left-aligned):
// fixed, so the header never shifts while it loads. Height matches the mark.
const UPLOADED_BOX = { sm: { width: 150, height: 32 }, md: { width: 190, height: 40 }, lg: { width: 230, height: 48 } } as const;

/**
 * The site logo. With a logo set in Admin → Settings (passed in as `logoUrl`
 * by siteBrand(), src/lib/brand/site-logo.ts) that image, with the site name
 * as its alt text — on a white tile when it is the document logo, made for
 * white (`logoOnLight`); without one — or when it fails to load — the
 * built-in lock-up:
 *
 *  A cluster of nodes of varying size rising to a peak then trailing
 *  off, set above a baseline — reads as a chromatogram peak / molecular
 *  scatter over an axis. Wordmark (the site name) with a small
 *  "MOLECULAR ANALYSIS" tagline lock-up.
 *
 *  Dark theme: the mark glows lime → teal (the redesign's accent gradient)
 *  and the wordmark is set in the foreground colour; light theme keeps the
 *  forest-green mark.
 */
export function Logo({
  className,
  withWordmark = true,
  withTagline = true,
  size = 'md',
  name,
  logoUrl,
  logoOnLight = false,
  priority = false,
}: {
  className?: string;
  withWordmark?: boolean;
  withTagline?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** The brand (SITE_NAME): wordmark, and the alt text of an uploaded logo. */
  name: string;
  /** The logo to show (SiteBrand.logoUrl); empty = the built-in lock-up. */
  logoUrl?: string | null;
  /** The logo is made for a light background: set it on a white tile on the dark site. */
  logoOnLight?: boolean;
  /** Above the fold (the header): fetch the uploaded logo first. */
  priority?: boolean;
}) {
  const mark = size === 'lg' ? 'h-10 w-14' : size === 'sm' ? 'h-7 w-10' : 'h-9 w-12';
  const word = size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-2xl';
  const tag = size === 'lg' ? 'text-[11px]' : 'text-[9px]';

  const lockup = (
    <div className={cn('inline-flex items-center gap-3', className)}>
      <svg
        viewBox="0 0 64 46"
        className={cn(mark, 'text-primary dark:drop-shadow-[0_0_10px_hsl(82_76%_55%/0.35)]')}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label={name}
        role="img"
      >
        <defs>
          {/* Identical definition in every instance, so a repeated id is harmless. */}
          <linearGradient id="l2d-mark-grad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#2fd6c3" />
            <stop offset="0.55" stopColor="#a4e335" />
            <stop offset="1" stopColor="#e2ff9c" />
          </linearGradient>
        </defs>
        {/* baseline / axis */}
        <line x1="4" y1="40" x2="34" y2="40" className="stroke-current dark:[stroke:url(#l2d-mark-grad)]" strokeWidth="2.4" strokeLinecap="round" />
        {/* scatter nodes rising to a peak, then trailing */}
        <g className="fill-current dark:[fill:url(#l2d-mark-grad)]">
          <circle cx="8"  cy="31" r="2.4" />
          <circle cx="17" cy="22" r="3.6" />
          <circle cx="27" cy="11" r="6.2" />
          <circle cx="38" cy="16" r="4.4" />
          <circle cx="47" cy="24" r="3.2" />
          <circle cx="55" cy="31" r="2.2" />
        </g>
      </svg>

      {withWordmark && (
        <div className="flex flex-col leading-none">
          <span
            className={cn(word, 'font-bold text-primary dark:text-foreground')}
            style={{ letterSpacing: '-0.03em' }}
          >
            {name}
          </span>
          {withTagline && (
            <span
              className={cn(tag, 'mt-1 font-semibold uppercase text-primary/55 dark:font-mono dark:font-normal dark:text-muted-foreground')}
              style={{ letterSpacing: '0.32em' }}
            >
              Molecular Analysis
            </span>
          )}
        </div>
      )}
    </div>
  );

  const src = logoUrl?.trim();
  if (!src) return lockup;
  return <UploadedLogo src={src} alt={name} {...UPLOADED_BOX[size]} onLight={logoOnLight} priority={priority} className={className} fallback={lockup} />;
}
