'use client';

import { useEffect, useRef } from 'react';

/** The footer's giant site word: outlined letters that light up under the pointer (the Shelter landing's .sfoot-word). */
export function FooterWord({ word }: { word: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const foot = el.closest('footer') ?? el;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
      el.style.setProperty('--my', `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
    };
    foot.addEventListener('pointermove', move as EventListener, { passive: true });
    return () => foot.removeEventListener('pointermove', move as EventListener);
  }, []);
  return (
    <div ref={ref} className="sfoot-word" aria-hidden>
      {word}
    </div>
  );
}
