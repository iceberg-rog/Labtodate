'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Counts up to `value` once it scrolls into view.
 *
 * SSR renders the final value (no `0` flash). Once mounted client-side, if
 * the element is *not yet* on screen we reset to 0 and animate up; if it's
 * already visible we leave the final value in place.
 */
export function CountUp({
  value,
  durationMs = 1400,
  className = '',
}: {
  value: number;
  durationMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  // Start at the real value so SSR + initial client render match (no 0 flash,
  // no hydration warning). We only swap to 0 + animate if we know the user
  // hasn't seen the element yet.
  const [display, setDisplay] = useState(value);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const rect = el.getBoundingClientRect();
    const alreadyOnScreen = rect.top < window.innerHeight && rect.bottom > 0;
    if (alreadyOnScreen) return; // no replay if it was already in view

    setDisplay(0);
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !started.current) {
        started.current = true;
        const start = performance.now();
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / durationMs);
          const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
          setDisplay(Math.round(value * eased));
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        io.disconnect();
      }
    }, { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, [value, durationMs]);

  return (
    <span ref={ref} className={className}>
      {display.toLocaleString()}
    </span>
  );
}
