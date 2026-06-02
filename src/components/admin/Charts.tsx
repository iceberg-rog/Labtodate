/**
 * Tiny dependency-free SVG chart kit for admin analytics.
 * Server-rendered (no client JS), accessible, theme-aware.
 */

type LinePoint = { label: string; value: number };

export function LineChart({
  data,
  height = 160,
  yFormat,
  caption,
  color = 'hsl(var(--primary))',
}: {
  data: LinePoint[];
  height?: number;
  yFormat?: (n: number) => string;
  caption?: string;
  color?: string;
}) {
  if (data.length === 0) {
    return <EmptyCard caption={caption} reason="No data in this window yet." />;
  }
  const w = 720;
  const h = height;
  const pad = { l: 44, r: 12, t: 12, b: 22 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const max = Math.max(1, ...data.map((d) => d.value));
  const min = 0;
  const xStep = data.length > 1 ? innerW / (data.length - 1) : innerW;
  const points = data.map((d, i) => {
    const x = pad.l + (data.length > 1 ? i * xStep : innerW / 2);
    const y = pad.t + innerH - ((d.value - min) / (max - min || 1)) * innerH;
    return { x, y, ...d };
  });
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = `${path} L ${points[points.length - 1].x.toFixed(1)} ${pad.t + innerH} L ${points[0].x.toFixed(1)} ${pad.t + innerH} Z`;
  const fmt = yFormat ?? ((n: number) => String(n));
  const ticks = [0, 0.5, 1].map((t) => ({ y: pad.t + innerH - t * innerH, v: max * t }));

  return (
    <figure className="rounded-2xl border border-border bg-card p-5">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} className="overflow-visible" role="img" aria-label={caption ?? 'Trend chart'}>
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={w - pad.r} y1={t.y} y2={t.y} stroke="currentColor" strokeOpacity="0.08" strokeDasharray="3 3" />
            <text x={pad.l - 8} y={t.y + 4} textAnchor="end" fontSize="10" fill="currentColor" opacity="0.5">
              {fmt(t.v)}
            </text>
          </g>
        ))}
        <path d={area} fill="url(#trendFill)" />
        <path d={path} stroke={color} strokeWidth="2" fill="none" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={3} fill={color} />
          </g>
        ))}
        {data.map((d, i) => {
          if (data.length > 14 && i % Math.ceil(data.length / 8) !== 0 && i !== data.length - 1) return null;
          const x = pad.l + (data.length > 1 ? i * xStep : innerW / 2);
          return (
            <text key={i} x={x} y={h - 4} textAnchor="middle" fontSize="10" fill="currentColor" opacity="0.5">
              {d.label}
            </text>
          );
        })}
      </svg>
      {caption && <figcaption className="text-[11px] text-muted-foreground mt-2">{caption}</figcaption>}
    </figure>
  );
}

export function BarList({
  data,
  caption,
  valueFormat,
}: {
  data: { label: string; value: number; sub?: string }[];
  caption?: string;
  valueFormat?: (n: number) => string;
}) {
  if (data.length === 0) {
    return <EmptyCard caption={caption} reason="Nothing to rank yet." />;
  }
  const max = Math.max(1, ...data.map((d) => d.value));
  const fmt = valueFormat ?? ((n: number) => String(n));
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      {caption && <h3 className="text-sm font-bold mb-3">{caption}</h3>}
      <ul className="space-y-2.5">
        {data.map((d, i) => {
          const pct = Math.round((d.value / max) * 100);
          return (
            <li key={`${d.label}-${i}`}>
              <div className="flex items-center justify-between gap-3 text-xs mb-1">
                <span className="truncate font-semibold text-foreground">{d.label}</span>
                <span className="tabular-nums text-muted-foreground flex-shrink-0">
                  {fmt(d.value)} {d.sub && <span className="opacity-60">· {d.sub}</span>}
                </span>
              </div>
              <div className="h-2 rounded-full bg-foreground/5 overflow-hidden">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function FunnelChart({
  stages,
  caption,
}: {
  stages: { label: string; value: number; sub?: string }[];
  caption?: string;
}) {
  if (stages.length === 0 || stages[0].value === 0) {
    return <EmptyCard caption={caption} reason="No funnel data — needs at least one quote in the window." />;
  }
  const top = stages[0].value;
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      {caption && <h3 className="text-sm font-bold mb-4">{caption}</h3>}
      <ol className="space-y-2">
        {stages.map((s, i) => {
          const pct = Math.round((s.value / top) * 100);
          const drop = i === 0 ? null : Math.round(((stages[i - 1].value - s.value) / Math.max(1, stages[i - 1].value)) * 100);
          return (
            <li key={s.label}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="font-semibold">{s.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {s.value} ({pct}%)
                  {drop !== null && drop > 0 && <span className="ml-2 text-amber-600">−{drop}% drop</span>}
                  {s.sub && <span className="ml-2 opacity-60">· {s.sub}</span>}
                </span>
              </div>
              <div className="h-7 rounded-lg bg-foreground/5 overflow-hidden relative">
                <div
                  className="h-full bg-primary/80 flex items-center px-3"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function Donut({
  data,
  caption,
  centerLabel,
}: {
  data: { label: string; value: number; color: string }[];
  caption?: string;
  centerLabel?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return <EmptyCard caption={caption} reason="No data yet." />;
  const r = 50;
  const c = 2 * Math.PI * r;
  const segments = data.reduce<Array<{ label: string; value: number; color: string; len: number; offset: number }>>((acc, d) => {
    const len = (d.value / total) * c;
    const offset = acc.length === 0 ? 0 : acc[acc.length - 1].offset + acc[acc.length - 1].len;
    return [...acc, { ...d, len, offset }];
  }, []);

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      {caption && <h3 className="text-sm font-bold mb-3">{caption}</h3>}
      <div className="flex items-center gap-5 flex-wrap">
        <svg viewBox="0 0 140 140" width="140" height="140" className="flex-shrink-0">
          <g transform="translate(70,70)">
            <circle r={r} fill="none" stroke="currentColor" strokeOpacity="0.05" strokeWidth="16" />
            {segments.map((d, i) => (
                <circle
                  key={i}
                  r={r}
                  fill="none"
                  stroke={d.color}
                  strokeWidth="16"
                  strokeDasharray={`${d.len.toFixed(2)} ${(c - d.len).toFixed(2)}`}
                  strokeDashoffset={(-d.offset).toFixed(2)}
                  transform="rotate(-90)"
                />
            ))}
            <text textAnchor="middle" dy="-2" fontSize="13" fontWeight="700" fill="currentColor">
              {total}
            </text>
            {centerLabel && (
              <text textAnchor="middle" dy="14" fontSize="9" fill="currentColor" opacity="0.6">
                {centerLabel}
              </text>
            )}
          </g>
        </svg>
        <ul className="flex-1 space-y-1.5 text-xs min-w-[160px]">
          {data.map((d) => {
            const pct = Math.round((d.value / total) * 100);
            return (
              <li key={d.label} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ background: d.color }} />
                <span className="flex-1 truncate text-foreground">{d.label}</span>
                <span className="tabular-nums text-muted-foreground">{d.value} · {pct}%</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function EmptyCard({ caption, reason }: { caption?: string; reason: string }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-border bg-card p-6 text-center">
      {caption && <h3 className="text-sm font-bold mb-1.5">{caption}</h3>}
      <p className="text-xs text-muted-foreground">{reason}</p>
    </div>
  );
}
