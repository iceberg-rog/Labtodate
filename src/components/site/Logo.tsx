import { cn } from '@/lib/utils';

/**
 * Labtodate identity — molecular scatter mark.
 *
 *  A cluster of nodes of varying size rising to a peak then trailing
 *  off, set above a baseline — reads as a chromatogram peak / molecular
 *  scatter over an axis. Wordmark (the site name, "Labtodate") with a small
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
  name = 'Labtodate',
}: {
  className?: string;
  withWordmark?: boolean;
  withTagline?: boolean;
  size?: 'sm' | 'md' | 'lg';
  name?: string;
}) {
  const mark = size === 'lg' ? 'h-10 w-14' : size === 'sm' ? 'h-7 w-10' : 'h-9 w-12';
  const word = size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-2xl';
  const tag = size === 'lg' ? 'text-[11px]' : 'text-[9px]';

  return (
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
}
