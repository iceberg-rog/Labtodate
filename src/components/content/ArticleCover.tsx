import type { ReactNode } from 'react';
import { InstrumentIllustration, ILLUSTRATIONS, type IllustrationName } from '@/components/illustrations/instruments';

const FALLBACK_GRADIENT = 'from-[hsl(168_62%_20%)] via-[hsl(168_52%_27%)] to-[hsl(82_42%_44%)]';

function resolveName(illustration: string | null | undefined): IllustrationName {
  if (illustration && illustration in ILLUSTRATIONS) return illustration as IllustrationName;
  return 'detector';
}

function stamp(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h.toString(16).slice(0, 4).toUpperCase().padStart(4, '0');
}

/**
 * Editorial article cover. If `coverImage` is supplied, the real photo wins
 * (full-bleed with a brand gradient + dark overlay so light text stays
 * readable). Otherwise it falls back to a gradient + SVG illustration.
 *
 * In `card` variant the eyebrow + FIG/REV stamps live inside the cover. To
 * avoid double-labeling with a parent `<Badge>` the caller can pass
 * `eyebrow={null}` (or omit it).
 */
export function ArticleCover({
  illustration,
  coverImage,
  coverGradient,
  className,
  eyebrow,
  seed = '',
  variant = 'card',
  title,
  showStamps = true,
  children,
}: {
  illustration: string | null | undefined;
  coverImage?: string | null;
  coverGradient: string | null | undefined;
  className?: string;
  eyebrow?: string | null;
  seed?: string;
  variant?: 'card' | 'hero';
  title?: string;
  /** Hide the FIG/REV stamp pair (useful on small thumbs / when stamps clutter). */
  showStamps?: boolean;
  children?: ReactNode;
}) {
  const gradient = coverGradient || FALLBACK_GRADIENT;
  const hero = variant === 'hero';
  const code = stamp(seed || (illustration ?? 'fig'));
  const hasPhoto = !!coverImage;

  return (
    <div className={`relative overflow-hidden bg-gradient-to-br ${gradient} ${className ?? ''}`}>
      {hasPhoto ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={coverImage!}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            aria-hidden
          />
          {/* dark editorial wash so light text stays legible on any photo */}
          <div
            className="absolute inset-0"
            style={{
              background:
                hero
                  ? 'linear-gradient(115deg, rgba(3,22,17,0.85) 0%, rgba(3,22,17,0.55) 38%, rgba(3,22,17,0.15) 70%, rgba(3,22,17,0.55) 100%)'
                  : 'linear-gradient(180deg, rgba(3,22,17,0.45) 0%, rgba(3,22,17,0.20) 50%, rgba(3,22,17,0.65) 100%)',
            }}
            aria-hidden
          />
        </>
      ) : (
        <>
          {/* editorial depth wash */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(115deg, rgba(5,34,28,0.78) 0%, rgba(5,34,28,0.30) 46%, rgba(5,34,28,0.08) 70%, rgba(5,34,28,0.40) 100%)',
            }}
            aria-hidden
          />

          {/* subtle blueprint grid (kept faint so it never dominates) */}
          <div
            className="absolute inset-0 opacity-[0.10]"
            style={{
              backgroundImage:
                'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)',
              backgroundSize: hero ? '120px 120px' : '88px 88px',
            }}
            aria-hidden
          />

          {/* spotlight glow behind the subject */}
          <div
            className="absolute rounded-full"
            style={{
              right: hero ? '4%' : '-6%',
              top: '50%',
              width: hero ? '46%' : '70%',
              aspectRatio: '1',
              transform: 'translateY(-50%)',
              background:
                'radial-gradient(circle, rgba(186,242,90,0.30) 0%, rgba(186,242,90,0.10) 38%, transparent 68%)',
            }}
            aria-hidden
          />

          {/* the instrument as a clear, spotlit subject */}
          <div
            className="absolute drop-shadow-[0_24px_50px_rgba(3,24,18,0.55)]"
            style={{
              right: hero ? '2%' : '-8%',
              top: '50%',
              width: hero ? '40%' : '66%',
              transform: 'translateY(-50%) rotate(-3deg)',
            }}
            aria-hidden
          >
            <InstrumentIllustration name={resolveName(illustration)} />
          </div>
        </>
      )}

      {/* registration / crop marks */}
      {([
        'left-5 top-5 border-l-2 border-t-2',
        'right-5 top-5 border-r-2 border-t-2',
        'left-5 bottom-5 border-l-2 border-b-2',
        'right-5 bottom-5 border-r-2 border-b-2',
      ] as const).map((pos) => (
        <span
          key={pos}
          className={`absolute ${pos} border-white/30`}
          style={{ width: hero ? 22 : 16, height: hero ? 22 : 16 }}
          aria-hidden
        />
      ))}

      {/* accent hairline */}
      <div
        className="absolute left-0 top-0 h-1 bg-[hsl(var(--accent))]"
        style={{ width: hero ? '34%' : '46%' }}
        aria-hidden
      />

      {hero ? (
        /* HERO: headline + meta live inside the composition */
        <div className="relative z-10 flex h-full flex-col justify-between p-10 md:p-14">
          {eyebrow ? (
            <p className="data text-xs font-bold uppercase tracking-[0.26em] text-[hsl(var(--accent))]">
              {eyebrow}
            </p>
          ) : (
            <span />
          )}
          <div className="max-w-[68%]">
            {title && (
              <h1
                className="text-3xl md:text-5xl font-bold leading-[1.08] text-white"
                style={{ letterSpacing: '-0.035em', textShadow: '0 2px 24px rgba(3,22,17,0.55)' }}
              >
                {title}
              </h1>
            )}
            <div className="mt-5 h-px w-16 bg-white/30" />
            {children && (
              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-white/75">
                {children}
              </div>
            )}
          </div>
          {showStamps && (
            <div className="data flex items-center gap-3 text-[11px] font-medium tracking-[0.18em] text-white/50">
              <span>FIG. {code}</span>
              <span className="h-3 w-px bg-white/25" />
              <span>REV. 2026</span>
            </div>
          )}
        </div>
      ) : (
        /* CARD: texture only — the card lays out its own title below */
        <>
          {eyebrow && (
            <div
              className="data absolute left-7 top-6 text-[10px] font-bold uppercase tracking-[0.22em] text-white/70"
              aria-hidden
            >
              {eyebrow}
            </div>
          )}
          {showStamps && (
            <div
              className="data absolute left-7 bottom-6 flex items-center gap-3 text-[9px] font-medium tracking-[0.18em] text-white/50"
              aria-hidden
            >
              <span>FIG. {code}</span>
              <span className="h-3 w-px bg-white/25" />
              <span>REV. 2026</span>
            </div>
          )}
        </>
      )}

      {/* soft vignette */}
      <div
        className="absolute inset-0"
        style={{ boxShadow: 'inset 0 0 130px rgba(3,22,17,0.5)' }}
        aria-hidden
      />
    </div>
  );
}
