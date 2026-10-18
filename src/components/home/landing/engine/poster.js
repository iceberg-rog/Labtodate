// The intro's first-paint poster, ported from the Shelter landing (src/landing/poster.js): the lab2date wordmark and the
// molecule mark as the particles the 3D scene will show, drawn in 2D (intro.mjs drawPoster) right after the first
// frame, without waiting for three.js. The scene adopts these particles (window.__l2dPoster.shapes()) and, once it is
// drawing, the poster fades out over it (scene.js). Reduced motion and no WebGL: the poster stays (core.js fades it
// with the scroll).
// lab2date port: no worker flight (Shelter's fly-boot/fly.mjs start from the page's <head>, which a Next.js route does
// not own); the still frame comes into focus instead (Shelter's "reveal" path, CSS). initPoster() runs on every mount.
import { introShapes, introMobile, glDpr, drawPoster, themeLight, setWord } from './intro.mjs';

export function initPoster() {
  const html = document.documentElement; const box = document.getElementById('poster');
  if (!box) { window.__l2dPoster = null; return null; }   // (the intro is switched off in Admin → Homepage: no poster)
  const cv = box.firstElementChild; const gl = document.getElementById('gl');
  const VW = () => Math.max(1, innerWidth || html.clientWidth || 1280);
  const VH = () => Math.max(1, (gl && gl.offsetHeight) || innerHeight || html.clientHeight || 720);
  const mark = (n) => { try { performance.mark(n); } catch (e) { /* old browsers */ } };
  let shapes = null, failed = false, size = null, settle = null, nearR = null, gone = false;
  let lt = themeLight();
  const ltClass = () => html.classList.toggle('poster-lt', lt);
  ltClass();
  const word = (box.dataset.word || 'Labtodate').trim();
  const family = getComputedStyle(document.body).fontFamily;
  setWord(word, family);
  const P = window.__l2dPoster = {
    drawn: false,
    flying: false,
    settled: new Promise((r) => { settle = r; }),
    near: new Promise((r) => { nearR = r; }),
    shapes() {
      if (!shapes && !failed) { try { shapes = introShapes(introMobile(VW())); } catch (e) { shapes = null; } failed = !shapes; }
      return shapes;
    },
    draw() {
      if (gone || html.classList.contains('poster-gone')) return;
      const s = P.shapes(); if (!s) return;
      const vw = VW(), vh = size ? size[1] : VH();
      try { drawPoster(cv, size ? { clientWidth: size[0] } : box, s, vw, vh, glDpr(vw, vh, s.mobile), lt); P.drawn = true; html.classList.add('poster-drawn'); mark('intro:poster'); } catch (e) { /* the scene still draws the lockup */ }
    },
    release() { gone = true; ro && ro.disconnect(); mo && mo.disconnect(); },
    toStill() { /* no flight canvas to swap: the still frame is already up */ },
  };
  const near = () => { if (nearR) { const r = nearR; nearR = null; mark('intro:near'); r(); } };
  const done = () => { near(); if (!settle) return; P.flying = false; const r = settle; settle = null; mark('intro:settled'); r(); };
  const reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const reveal = () => {
    if (!P.drawn) P.draw();
    if (reduced || !P.drawn) { done(); return; }
    P.flying = true; html.classList.add('poster-reveal'); near(); setTimeout(done, 1150);
  };
  const first = () => { if (html.classList.contains('poster-gone')) { done(); return; } reveal(); };

  // the theme switched while the poster is up: the still frame in the new one
  const mo = 'MutationObserver' in window ? new MutationObserver(() => {
    const nl = themeLight(); if (nl === lt || gone || html.classList.contains('poster-gone')) return;
    lt = nl; ltClass(); if (P.drawn) P.draw();
  }) : null;
  if (mo) mo.observe(html, { attributes: true, attributeFilter: ['class'] });

  // the box's size (the scene canvas's: 100% x 100lvh) once the first frame has laid it out: the still frame is drawn in
  // the next frame, so the copy's first paint never waits for it; again on every resize
  let ro = null;
  const draw0 = () => {
    // the word is drawn in the page's font: wait for it (briefly) so the poster and the scene sample the same letters
    const f = document.fonts && document.fonts.load ? document.fonts.load(`800 100px ${family}`).catch(() => null) : Promise.resolve();
    Promise.race([f, new Promise((r) => setTimeout(r, 400))]).then(() => { setWord(word, family); requestAnimationFrame(first); });
  };
  if ('ResizeObserver' in window) {
    let firstR = true;
    ro = new ResizeObserver((es) => {
      const r = es[0].contentRect; if (!r.width || !r.height) return;
      size = [r.width, r.height];
      if (firstR) { firstR = false; draw0(); return; }
      P.draw();
    });
    ro.observe(box);
  } else draw0();
  return P;
}
