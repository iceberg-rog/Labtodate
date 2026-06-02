'use client';

import { useEffect, useRef } from 'react';

/**
 * Flowing wireframe ribbon — MinIO-style animated mesh.
 * Stacked sine polylines woven into a 3D-feeling surface, plus drifting
 * particles. Cyan→teal on near-black. Respects prefers-reduced-motion.
 */
export function WaveCanvas({
  className = '',
  light = false,
  centered = false,
}: {
  className?: string;
  light?: boolean;
  centered?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let w = 0;
    let h = 0;
    let dpr = 1;

    function resize() {
      const parent = canvas!.parentElement!;
      w = parent.clientWidth;
      h = parent.clientHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    // particles
    const PARTICLES = 46;
    const parts = Array.from({ length: PARTICLES }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.6 + 0.4,
      s: Math.random() * 0.00018 + 0.00004,
      a: Math.random() * 0.5 + 0.15,
    }));

    const LINES = 16;
    const STEP = 14;

    function draw(t: number) {
      ctx!.clearRect(0, 0, w, h);

      // The ribbon sits in the lower portion, flowing left→right.
      const baseY = h * 0.68;
      for (let li = 0; li < LINES; li++) {
        const lp = li / (LINES - 1); // 0..1
        const depth = 1 - lp; // back lines fainter/higher
        const yOffset = baseY - lp * h * 0.16;
        const amp = (h * 0.16) * (0.35 + lp * 0.9);
        const phase = li * 0.55;

        ctx!.beginPath();
        for (let x = -STEP; x <= w + STEP; x += STEP) {
          const nx = x / w;
          // envelope concentrates motion toward the centre-right (like MinIO)
          const env = Math.sin(nx * Math.PI) ** 1.4;
          const y =
            yOffset +
            amp *
              env *
              (Math.sin(nx * 6.0 + t * 0.45 + phase) * 0.6 +
                Math.sin(nx * 11.0 - t * 0.32 + phase * 1.7) * 0.3 +
                Math.sin(nx * 2.3 + t * 0.18) * 0.25);
          if (x === -STEP) ctx!.moveTo(x, y);
          else ctx!.lineTo(x, y);
        }
        const alpha = light ? 0.18 + lp * 0.6 : 0.06 + lp * 0.42;
        const grad = ctx!.createLinearGradient(0, 0, w, 0);
        if (light && centered) {
          // symmetric bloom — fades into both edges for centred sections
          grad.addColorStop(0, 'rgba(16,110,86,0)');
          grad.addColorStop(0.16, `rgba(16,120,90,${alpha * 0.5})`);
          grad.addColorStop(0.5, `rgba(120,190,55,${alpha})`);
          grad.addColorStop(0.84, `rgba(16,120,90,${alpha * 0.5})`);
          grad.addColorStop(1, 'rgba(16,110,86,0)');
        } else if (light) {
          // clean on the left (behind text), blooms toward the empty right
          grad.addColorStop(0, 'rgba(14,79,64,0)');
          grad.addColorStop(0.34, 'rgba(14,79,64,0)');
          grad.addColorStop(0.52, `rgba(16,120,90,${alpha * 0.7})`);
          grad.addColorStop(0.74, `rgba(120,190,55,${alpha})`);
          grad.addColorStop(1, `rgba(16,110,86,${alpha * 0.85})`);
        } else {
          grad.addColorStop(0, `rgba(120,190,225,${alpha * 0.25})`);
          grad.addColorStop(0.45, `rgba(150,225,235,${alpha})`);
          grad.addColorStop(0.7, `rgba(120,210,200,${alpha})`);
          grad.addColorStop(1, `rgba(90,150,200,${alpha * 0.3})`);
        }
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = light ? 1.15 : 1;
        // soft luminous glow on the front lines (MinIO-like)
        ctx!.shadowBlur = lp > 0.5 ? (light ? 6 : 8) : 0;
        ctx!.shadowColor = light ? 'rgba(20,130,95,0.5)' : 'rgba(150,225,235,0.6)';
        ctx!.stroke();
        ctx!.shadowBlur = 0;
        void depth;
      }

      // (no vertical ties — keep it a clean flowing ribbon, not a grid)

      // particles
      for (const p of parts) {
        if (!reduce) p.x += p.s * 1000 * 0.016;
        if (p.x > 1.05) p.x = centered ? -0.05 : 0.32;
        // hero keeps particles off the left text column; centred fades both edges
        const fade =
          light && centered
            ? Math.max(0, Math.min(1, Math.min(p.x, 1 - p.x) / 0.14))
            : light
              ? Math.max(0, Math.min(1, (p.x - 0.34) / 0.2))
              : 1;
        if (fade <= 0) continue;
        const px = p.x * w;
        const py = p.y * h;
        ctx!.beginPath();
        ctx!.arc(px, py, p.r, 0, Math.PI * 2);
        ctx!.fillStyle = light ? `rgba(20,120,90,${p.a * 0.7 * fade})` : `rgba(170,225,235,${p.a})`;
        ctx!.fill();
      }
    }

    let raf = 0;
    let start = performance.now();
    function loop(now: number) {
      const t = (now - start) / 1000;
      draw(t);
      raf = requestAnimationFrame(loop);
    }

    if (reduce) {
      draw(2.2);
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [light, centered]);

  return <canvas ref={ref} className={className} aria-hidden />;
}
