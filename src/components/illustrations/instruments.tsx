/**
 * Hand-drawn SVG illustrations of laboratory instruments.
 * Style: front-elevation silhouettes with subtle 2-color fills + accent highlights.
 * Used in Hero cards, marketplace product cards, and category teasers.
 */

import { cn } from '@/lib/utils';

type Props = { className?: string };

const base = 'w-full h-full';

export function MicroscopeIllustration({ className }: Props) {
  return (
    <svg viewBox="0 0 240 180" className={cn(base, className)} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="mi-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(168 70% 14%)" />
        </linearGradient>
      </defs>
      {/* base */}
      <rect x="42" y="148" width="156" height="18" rx="3" fill="url(#mi-body)" />
      <rect x="58" y="142" width="124" height="8" rx="2" fill="hsl(var(--primary) / 0.85)" />
      {/* main vertical arm */}
      <path d="M 142 38 Q 178 56 178 96 L 178 146 L 158 146 L 158 96 Q 158 70 132 60 Z" fill="url(#mi-body)" />
      {/* stage */}
      <rect x="70" y="100" width="80" height="10" rx="1" fill="hsl(var(--primary))" />
      <rect x="84" y="106" width="46" height="3" fill="hsl(var(--accent))" />
      {/* light below stage */}
      <rect x="98" y="118" width="18" height="22" rx="2" fill="hsl(var(--primary) / 0.55)" />
      <circle cx="107" cy="129" r="3" fill="hsl(var(--accent))" />
      {/* objective lens turret */}
      <ellipse cx="140" cy="92" rx="14" ry="6" fill="hsl(var(--primary))" />
      <rect x="135" y="92" width="10" height="14" fill="hsl(var(--primary))" />
      {/* eyepiece tube */}
      <path d="M 130 60 L 122 32 L 90 32 L 90 50 L 116 56 Z" fill="hsl(var(--primary))" />
      {/* eyepiece */}
      <rect x="76" y="22" width="22" height="12" rx="3" fill="hsl(168 70% 12%)" />
      <circle cx="87" cy="28" r="3" fill="hsl(var(--accent))" />
      {/* focus knobs */}
      <circle cx="170" cy="118" r="9" fill="hsl(var(--primary))" />
      <circle cx="170" cy="118" r="4" fill="hsl(var(--accent))" />
      <circle cx="186" cy="130" r="6" fill="hsl(var(--primary))" />
    </svg>
  );
}

export function CentrifugeIllustration({ className }: Props) {
  return (
    <svg viewBox="0 0 240 180" className={cn(base, className)} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="ce-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(168 70% 26%)" />
          <stop offset="100%" stopColor="hsl(168 70% 16%)" />
        </linearGradient>
      </defs>
      {/* main body */}
      <rect x="34" y="44" width="172" height="116" rx="14" fill="url(#ce-body)" />
      {/* feet */}
      <rect x="44" y="158" width="14" height="10" rx="2" fill="hsl(168 70% 12%)" />
      <rect x="182" y="158" width="14" height="10" rx="2" fill="hsl(168 70% 12%)" />
      {/* circular rotor cavity (top-down view through transparent lid) */}
      <circle cx="120" cy="92" r="44" fill="hsl(var(--background))" />
      <circle cx="120" cy="92" r="44" fill="none" stroke="hsl(var(--primary))" strokeWidth="2" />
      {/* rotor with sample tubes */}
      <circle cx="120" cy="92" r="28" fill="hsl(168 60% 25%)" />
      <g fill="hsl(var(--accent))">
        <circle cx="120" cy="72" r="5" />
        <circle cx="140" cy="84" r="5" />
        <circle cx="140" cy="100" r="5" />
        <circle cx="120" cy="112" r="5" />
        <circle cx="100" cy="100" r="5" />
        <circle cx="100" cy="84" r="5" />
      </g>
      <circle cx="120" cy="92" r="6" fill="hsl(var(--primary))" />
      {/* control panel */}
      <rect x="48" y="138" width="100" height="14" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="54" y="142" width="44" height="6" rx="1" fill="hsl(var(--accent))" opacity="0.85" />
      <circle cx="120" cy="145" r="3" fill="hsl(var(--accent))" />
      <circle cx="132" cy="145" r="3" fill="white" opacity="0.6" />
      {/* power LED */}
      <circle cx="190" cy="64" r="3" fill="hsl(var(--accent))" />
    </svg>
  );
}

export function PCRIllustration({ className }: Props) {
  return (
    <svg viewBox="0 0 240 180" className={cn(base, className)} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="pcr-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(168 65% 24%)" />
          <stop offset="100%" stopColor="hsl(168 70% 15%)" />
        </linearGradient>
      </defs>
      {/* base box */}
      <rect x="28" y="62" width="184" height="104" rx="12" fill="url(#pcr-body)" />
      {/* feet */}
      <rect x="40" y="164" width="16" height="8" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="184" y="164" width="16" height="8" rx="2" fill="hsl(168 70% 10%)" />
      {/* lid wedge */}
      <path d="M 28 62 L 212 62 L 200 38 L 40 38 Z" fill="hsl(168 70% 28%)" />
      {/* display */}
      <rect x="44" y="78" width="74" height="38" rx="3" fill="hsl(168 70% 10%)" />
      <rect x="50" y="84" width="62" height="4" rx="1" fill="hsl(var(--accent))" />
      <rect x="50" y="92" width="42" height="3" rx="1" fill="hsl(var(--accent) / 0.5)" />
      <rect x="50" y="98" width="56" height="3" rx="1" fill="hsl(var(--accent) / 0.5)" />
      <rect x="50" y="104" width="32" height="3" rx="1" fill="hsl(var(--accent) / 0.5)" />
      {/* well grid (8x12 tubes simulated as dots) */}
      <g fill="hsl(var(--accent))">
        {Array.from({ length: 6 }).map((_, r) =>
          Array.from({ length: 10 }).map((_, c) => (
            <circle key={`${r}-${c}`} cx={132 + c * 7} cy={84 + r * 7} r="1.8" />
          )),
        )}
      </g>
      {/* control buttons */}
      <circle cx="60" cy="138" r="6" fill="hsl(var(--accent))" />
      <circle cx="80" cy="138" r="6" fill="white" opacity="0.85" />
      <circle cx="100" cy="138" r="6" fill="hsl(168 70% 10%)" stroke="white" strokeOpacity="0.4" />
      <rect x="130" y="132" width="70" height="14" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="136" y="136" width="58" height="6" rx="1" fill="hsl(var(--accent) / 0.7)" />
    </svg>
  );
}

export function HPLCIllustration({ className }: Props) {
  return (
    <svg viewBox="0 0 240 180" className={cn(base, className)} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="hp-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(168 65% 24%)" />
          <stop offset="100%" stopColor="hsl(168 70% 14%)" />
        </linearGradient>
      </defs>
      {/* stacked modules */}
      <rect x="58" y="22" width="124" height="32" rx="4" fill="url(#hp-body)" />
      <rect x="58" y="58" width="124" height="32" rx="4" fill="url(#hp-body)" />
      <rect x="58" y="94" width="124" height="32" rx="4" fill="url(#hp-body)" />
      <rect x="58" y="130" width="124" height="32" rx="4" fill="url(#hp-body)" />
      {/* display screens */}
      <rect x="66" y="30" width="46" height="16" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="70" y="34" width="22" height="3" rx="1" fill="hsl(var(--accent))" />
      <rect x="70" y="40" width="34" height="3" rx="1" fill="hsl(var(--accent) / 0.55)" />
      {/* buttons & LEDs */}
      <circle cx="126" cy="38" r="3.5" fill="hsl(var(--accent))" />
      <circle cx="138" cy="38" r="3.5" fill="white" opacity="0.7" />
      <circle cx="150" cy="38" r="3.5" fill="hsl(168 70% 10%)" />
      {/* sample vial carousel */}
      <rect x="66" y="66" width="62" height="16" rx="2" fill="hsl(168 70% 10%)" />
      <g fill="hsl(var(--accent))">
        {Array.from({ length: 8 }).map((_, i) => (
          <circle key={i} cx={72 + i * 7} cy="74" r="2" />
        ))}
      </g>
      <circle cx="160" cy="74" r="6" fill="hsl(var(--accent))" />
      {/* column oven */}
      <rect x="66" y="102" width="100" height="16" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="72" y="106" width="80" height="8" rx="1" fill="hsl(var(--accent) / 0.4)" />
      <circle cx="172" cy="110" r="3" fill="hsl(var(--accent))" />
      {/* detector */}
      <rect x="66" y="138" width="46" height="16" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="72" y="142" width="34" height="8" rx="1" fill="hsl(var(--accent))" opacity="0.85" />
      <circle cx="126" cy="146" r="3" fill="hsl(var(--accent))" />
      <circle cx="138" cy="146" r="3" fill="white" opacity="0.7" />
      <circle cx="150" cy="146" r="3" fill="hsl(168 70% 10%)" />
      {/* side tubing hint */}
      <path d="M 46 26 L 46 158" stroke="hsl(var(--primary))" strokeWidth="2" strokeDasharray="3 3" opacity="0.4" />
      <path d="M 194 26 L 194 158" stroke="hsl(var(--primary))" strokeWidth="2" strokeDasharray="3 3" opacity="0.4" />
    </svg>
  );
}

export function MassSpecIllustration({ className }: Props) {
  return (
    <svg viewBox="0 0 240 180" className={cn(base, className)} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="ms-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(168 65% 24%)" />
          <stop offset="100%" stopColor="hsl(168 70% 14%)" />
        </linearGradient>
      </defs>
      {/* main hull */}
      <rect x="22" y="46" width="196" height="108" rx="12" fill="url(#ms-body)" />
      {/* feet */}
      <rect x="38" y="152" width="18" height="10" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="184" y="152" width="18" height="10" rx="2" fill="hsl(168 70% 10%)" />
      {/* ion source cylinder (left) */}
      <rect x="10" y="68" width="22" height="64" rx="6" fill="hsl(168 70% 14%)" />
      <rect x="6" y="80" width="8" height="40" rx="2" fill="hsl(var(--primary))" />
      <circle cx="21" cy="100" r="5" fill="hsl(var(--accent))" />
      {/* large display showing spectrum */}
      <rect x="36" y="60" width="108" height="64" rx="4" fill="hsl(168 70% 8%)" />
      {/* mass spectrum bars */}
      <g fill="hsl(var(--accent))">
        <rect x="44" y="108" width="3" height="10" />
        <rect x="50" y="98" width="3" height="20" />
        <rect x="56" y="84" width="3" height="34" />
        <rect x="62" y="76" width="3" height="42" />
        <rect x="68" y="92" width="3" height="26" />
        <rect x="74" y="100" width="3" height="18" />
        <rect x="80" y="86" width="3" height="32" />
        <rect x="86" y="106" width="3" height="12" />
        <rect x="92" y="72" width="3" height="46" />
        <rect x="98" y="94" width="3" height="24" />
        <rect x="104" y="102" width="3" height="16" />
        <rect x="110" y="88" width="3" height="30" />
        <rect x="116" y="98" width="3" height="20" />
        <rect x="122" y="104" width="3" height="14" />
        <rect x="128" y="110" width="3" height="8" />
        <rect x="134" y="106" width="3" height="12" />
      </g>
      {/* spectrum axes */}
      <line x1="40" y1="118" x2="140" y2="118" stroke="hsl(var(--accent) / 0.4)" strokeWidth="1" />
      <line x1="40" y1="68" x2="40" y2="118" stroke="hsl(var(--accent) / 0.4)" strokeWidth="1" />
      {/* right side controls */}
      <rect x="156" y="60" width="50" height="34" rx="3" fill="hsl(168 70% 10%)" />
      <rect x="162" y="66" width="38" height="3" rx="1" fill="hsl(var(--accent))" />
      <rect x="162" y="74" width="28" height="3" rx="1" fill="hsl(var(--accent) / 0.6)" />
      <rect x="162" y="82" width="32" height="3" rx="1" fill="hsl(var(--accent) / 0.6)" />
      <circle cx="166" cy="108" r="6" fill="hsl(var(--accent))" />
      <circle cx="184" cy="108" r="6" fill="white" opacity="0.8" />
      <circle cx="202" cy="108" r="6" fill="hsl(168 70% 8%)" />
      {/* status LED bar */}
      <rect x="156" y="124" width="50" height="22" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="160" y="128" width="42" height="4" rx="1" fill="hsl(var(--accent))" opacity="0.85" />
      <rect x="160" y="136" width="28" height="4" rx="1" fill="hsl(var(--accent) / 0.4)" />
    </svg>
  );
}

export function BalanceIllustration({ className }: Props) {
  return (
    <svg viewBox="0 0 240 180" className={cn(base, className)} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="ba-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(168 65% 24%)" />
          <stop offset="100%" stopColor="hsl(168 70% 16%)" />
        </linearGradient>
      </defs>
      {/* base */}
      <rect x="36" y="124" width="168" height="40" rx="4" fill="url(#ba-body)" />
      {/* display in front of base */}
      <rect x="58" y="136" width="124" height="20" rx="3" fill="hsl(168 70% 10%)" />
      <text x="120" y="151" textAnchor="middle" fontFamily="ui-monospace, Menlo, monospace" fontSize="11" fontWeight="bold" fill="hsl(var(--accent))">
        125.4382 g
      </text>
      {/* glass draft shield (transparent box) */}
      <rect x="64" y="38" width="112" height="86" rx="3" fill="hsl(var(--accent) / 0.06)" stroke="hsl(var(--primary) / 0.4)" strokeWidth="1.5" />
      {/* shield grids - vertical */}
      <line x1="92" y1="38" x2="92" y2="124" stroke="hsl(var(--primary) / 0.18)" strokeWidth="1" />
      <line x1="120" y1="38" x2="120" y2="124" stroke="hsl(var(--primary) / 0.18)" strokeWidth="1" />
      <line x1="148" y1="38" x2="148" y2="124" stroke="hsl(var(--primary) / 0.18)" strokeWidth="1" />
      {/* weighing pan */}
      <ellipse cx="120" cy="110" rx="34" ry="6" fill="hsl(var(--primary))" />
      <ellipse cx="120" cy="106" rx="34" ry="6" fill="hsl(168 65% 30%)" />
      {/* sample */}
      <circle cx="120" cy="100" r="10" fill="hsl(var(--accent))" />
      {/* support column behind pan */}
      <rect x="116" y="110" width="8" height="14" fill="hsl(168 70% 10%)" />
      {/* base buttons */}
      <circle cx="50" cy="146" r="4" fill="hsl(var(--accent))" />
      <circle cx="194" cy="146" r="4" fill="white" opacity="0.7" />
    </svg>
  );
}

export function GCIllustration({ className }: Props) {
  return (
    <svg viewBox="0 0 240 180" className={cn(base, className)} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="gc-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(168 65% 24%)" />
          <stop offset="100%" stopColor="hsl(168 70% 14%)" />
        </linearGradient>
      </defs>
      {/* main cabinet */}
      <rect x="30" y="34" width="180" height="118" rx="12" fill="url(#gc-body)" />
      <rect x="44" y="152" width="16" height="10" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="180" y="152" width="16" height="10" rx="2" fill="hsl(168 70% 10%)" />
      {/* oven door (round window) */}
      <circle cx="96" cy="96" r="40" fill="hsl(var(--background))" />
      <circle cx="96" cy="96" r="40" fill="none" stroke="hsl(var(--primary))" strokeWidth="2.5" />
      {/* coiled GC column inside oven */}
      <g stroke="hsl(var(--accent))" strokeWidth="3" fill="none">
        <circle cx="96" cy="96" r="26" />
        <circle cx="96" cy="96" r="17" />
        <circle cx="96" cy="96" r="9" />
      </g>
      <circle cx="96" cy="96" r="3.5" fill="hsl(var(--primary))" />
      {/* door hinge + handle */}
      <rect x="54" y="62" width="4" height="68" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="132" y="90" width="6" height="14" rx="2" fill="hsl(168 70% 10%)" />
      {/* control panel */}
      <rect x="150" y="50" width="48" height="34" rx="3" fill="hsl(168 70% 10%)" />
      <rect x="156" y="56" width="36" height="4" rx="1" fill="hsl(var(--accent))" />
      <rect x="156" y="64" width="26" height="3" rx="1" fill="hsl(var(--accent) / 0.55)" />
      <rect x="156" y="71" width="30" height="3" rx="1" fill="hsl(var(--accent) / 0.55)" />
      {/* buttons */}
      <circle cx="158" cy="108" r="6" fill="hsl(var(--accent))" />
      <circle cx="176" cy="108" r="6" fill="white" opacity="0.8" />
      <circle cx="194" cy="108" r="6" fill="hsl(168 70% 10%)" />
      <rect x="150" y="124" width="48" height="18" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="155" y="129" width="38" height="4" rx="1" fill="hsl(var(--accent) / 0.7)" />
      {/* gas line on top */}
      <path d="M 70 34 L 70 18 L 150 18" stroke="hsl(var(--primary))" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="150" cy="18" r="4" fill="hsl(var(--accent))" />
    </svg>
  );
}

export function AutosamplerIllustration({ className }: Props) {
  return (
    <svg viewBox="0 0 240 180" className={cn(base, className)} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="as-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(168 65% 24%)" />
          <stop offset="100%" stopColor="hsl(168 70% 15%)" />
        </linearGradient>
      </defs>
      {/* base unit */}
      <rect x="34" y="92" width="172" height="72" rx="10" fill="url(#as-body)" />
      <rect x="46" y="164" width="16" height="8" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="178" y="164" width="16" height="8" rx="2" fill="hsl(168 70% 10%)" />
      {/* display */}
      <rect x="48" y="106" width="70" height="44" rx="3" fill="hsl(168 70% 10%)" />
      <rect x="54" y="112" width="58" height="5" rx="1" fill="hsl(var(--accent))" />
      <rect x="54" y="122" width="40" height="3" rx="1" fill="hsl(var(--accent) / 0.5)" />
      <rect x="54" y="129" width="48" height="3" rx="1" fill="hsl(var(--accent) / 0.5)" />
      <rect x="54" y="136" width="30" height="3" rx="1" fill="hsl(var(--accent) / 0.5)" />
      {/* control buttons */}
      <circle cx="140" cy="116" r="6" fill="hsl(var(--accent))" />
      <circle cx="160" cy="116" r="6" fill="white" opacity="0.8" />
      <circle cx="180" cy="116" r="6" fill="hsl(168 70% 10%)" />
      <rect x="132" y="132" width="60" height="16" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="138" y="137" width="48" height="6" rx="1" fill="hsl(var(--accent) / 0.7)" />
      {/* sample carousel tray on top */}
      <ellipse cx="120" cy="62" rx="64" ry="22" fill="hsl(168 60% 22%)" />
      <ellipse cx="120" cy="58" rx="64" ry="22" fill="hsl(168 65% 28%)" />
      {/* vials around the carousel */}
      <g fill="hsl(var(--accent))">
        {Array.from({ length: 14 }).map((_, i) => {
          const ang = (i / 14) * Math.PI * 2;
          const cx = 120 + Math.cos(ang) * 50;
          const cy = 58 + Math.sin(ang) * 15;
          return <circle key={i} cx={cx} cy={cy} r="3.4" />;
        })}
      </g>
      <circle cx="120" cy="58" r="7" fill="hsl(var(--primary))" />
      {/* injector arm */}
      <rect x="116" y="20" width="8" height="40" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="100" y="16" width="40" height="8" rx="2" fill="hsl(var(--primary))" />
      <circle cx="100" cy="20" r="5" fill="hsl(var(--accent))" />
    </svg>
  );
}

export function DetectorIllustration({ className }: Props) {
  return (
    <svg viewBox="0 0 240 180" className={cn(base, className)} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="dt-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(168 65% 24%)" />
          <stop offset="100%" stopColor="hsl(168 70% 14%)" />
        </linearGradient>
      </defs>
      {/* slim module */}
      <rect x="26" y="58" width="188" height="78" rx="10" fill="url(#dt-body)" />
      <rect x="40" y="136" width="18" height="8" rx="2" fill="hsl(168 70% 10%)" />
      <rect x="182" y="136" width="18" height="8" rx="2" fill="hsl(168 70% 10%)" />
      {/* signal screen with chromatogram trace */}
      <rect x="40" y="70" width="118" height="54" rx="3" fill="hsl(168 70% 8%)" />
      <polyline
        points="46,116 62,114 74,112 84,86 92,70 100,90 110,112 122,108 132,112 138,80 146,108 154,116"
        fill="none"
        stroke="hsl(var(--accent))"
        strokeWidth="2.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <line x1="44" y1="120" x2="156" y2="120" stroke="hsl(var(--accent) / 0.35)" strokeWidth="1" />
      {/* right controls + LEDs */}
      <rect x="170" y="70" width="34" height="22" rx="3" fill="hsl(168 70% 10%)" />
      <rect x="175" y="75" width="24" height="3" rx="1" fill="hsl(var(--accent))" />
      <rect x="175" y="81" width="18" height="3" rx="1" fill="hsl(var(--accent) / 0.55)" />
      <circle cx="177" cy="106" r="5" fill="hsl(var(--accent))" />
      <circle cx="192" cy="106" r="5" fill="white" opacity="0.8" />
      {/* I/O ports on side */}
      <rect x="18" y="78" width="10" height="10" rx="2" fill="hsl(var(--primary))" />
      <rect x="18" y="96" width="10" height="10" rx="2" fill="hsl(var(--primary))" />
      <circle cx="23" cy="118" r="4" fill="hsl(var(--accent))" />
    </svg>
  );
}

// Map slug → component for convenient lookup.
export const ILLUSTRATIONS = {
  microscope: MicroscopeIllustration,
  centrifuge: CentrifugeIllustration,
  pcr: PCRIllustration,
  hplc: HPLCIllustration,
  massspec: MassSpecIllustration,
  balance: BalanceIllustration,
  gc: GCIllustration,
  autosampler: AutosamplerIllustration,
  detector: DetectorIllustration,
} as const;

export type IllustrationName = keyof typeof ILLUSTRATIONS;

export function InstrumentIllustration({
  name,
  className,
}: {
  name: IllustrationName;
  className?: string;
}) {
  const C = ILLUSTRATIONS[name];
  return <C className={className} />;
}
