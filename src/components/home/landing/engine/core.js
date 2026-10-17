// Ported from the Shelter landing (src/landing/core.js): config, helpers, the scroll model and the DOM side of every
// frame. Shared by the shell (LandingShell → shell.js) and the WebGL scene (scene.js).
// lab2date port: the page is a Next.js route, so everything that reads the DOM is (re)initialised by initCore() on
// every mount instead of at import; the exports are live bindings, so importers always see the current values.
/* ------------------------------------------------------------------ config */
export let CFG = { links: {}, games: [], text: {} };
export let GAMES = [];
export let TEXT = {};
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export let params = new URLSearchParams('');
// hero visual: always the brand mark (lab2date's chrome molecule)
export const HERO = 'logo';
export let DEBUG = false;
export const tune = (k, d) => { if (!DEBUG || !params.has(k)) return d; const v = parseFloat(params.get(k)); return Number.isFinite(v) ? v : d; };
export let reduced = false;
export let finePointer = false;
export let PHONE_UA = false;
export const pad = (n) => String(n).padStart(2, '0');
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
export const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const lerp = (a, b, t) => a + (b - a) * t;

// the viewport's width and the scroll position are kept from their events: read from the window in the middle of a
// frame (after the DOM loop's writes) they force a style and layout pass, every frame
let vwNow = 0;
const readVW = () => { vwNow = Math.max(1, innerWidth || document.documentElement.clientWidth || 1280); };
export const VW = () => vwNow || (readVW(), vwNow);
let syNow = -1;
export const scrollNow = () => (syNow < 0 ? (syNow = window.scrollY) : syNow);
export let glEl = null;
let vhNow = 0;
export const readVH = () => { vhNow = Math.max(1, (glEl && glEl.offsetHeight) || innerHeight || document.documentElement.clientHeight || 720); };
export const VH = () => vhNow || (readVH(), vhNow);
// yield to the browser between long jobs, so input and paint get a turn (scheduler.yield where it exists)
export const yieldNow = () => (window.scheduler && window.scheduler.yield ? window.scheduler.yield() : new Promise((r) => setTimeout(r, 0)));
// a function to run once the main thread is idle (or after `timeout` ms at the latest)
export const whenIdle = (fn, timeout = 1500) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 60));

export let sections = [];
export let stepEls = [];
let SEC_NAMES = [];
export let railBtns = [];

/* listener bookkeeping: everything the landing attaches is removed on unmount (an SPA route, unlike Shelter's page) */
let offs = [];
export const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); offs.push(() => target.removeEventListener(type, fn, opts)); };
export const onCleanup = (fn) => { offs.push(fn); };

/* ------------------------------------------------------------------ text scramble */
const GLYPHS = '!<>-_\\/[]{}=+*^?#01ABCDEFGHJKLMNPQRSTUVWXYZ';
export function scramble(el, text) {
  if (reduced) { el.textContent = text; return; }
  const len = Math.max(el.textContent.length, text.length);
  const q = [];
  for (let i = 0; i < len; i++) q.push({ to: text[i] || '', start: Math.floor(Math.random() * 10), end: 10 + Math.floor(Math.random() * 16) });
  let f = 0; cancelAnimationFrame(el._raf);
  const tick = () => {
    let out = '', done = 0;
    for (const c of q) {
      if (f >= c.end) { done++; out += c.to; }
      else if (f >= c.start) out += GLYPHS[(Math.random() * GLYPHS.length) | 0];
      else out += ' ';
    }
    el.textContent = out;
    if (done < q.length) { f++; el._raf = requestAnimationFrame(tick); }
  };
  tick();
}

export const state = { mx: 0, my: 0, tmx: 0, tmy: 0, scroll: 0, active: -1, game: -1, pointer: false, story: null };
// set by the scene: the glitch a card plays when the list moves to it
export const hooks = { cardGlitch: null };

/* ================================================================== boot
   Until the scene's frame loop takes over, a light DOM loop keeps the sections, rail and HUD in step with the
   scroll, so the copy is there from the first paint. Without WebGL that loop simply never stops. */
export const boot = { up: true, sceneLoop: false, disposed: false };
const emit = (n) => { try { document.dispatchEvent(new Event(n)); } catch (e) { /* very old engines */ } };
// the scene draws the intro: its canvas fades in (CSS) under the first-paint poster
export function endBoot(cb) {
  document.documentElement.classList.add('gl-ready');
  boot.up = false;
  cb();
  emit('l2d:visible');
}
// every station is built and warmed (the rest of the page's deferred work may start)
export function fullBoot() {
  document.documentElement.classList.add('gl-full');
  emit('l2d:full');
}
let domLoopOn = false;
export function startDomLoop() {
  if (domLoopOn) return; domLoopOn = true;
  const loop = () => { if (boot.sceneLoop || boot.disposed) { domLoopOn = false; return; } updateDom(computeScroll(scrollNow())); requestAnimationFrame(loop); };
  loop();
}
export function noGL() {
  document.documentElement.classList.add('no-webgl');
  const PS = window.__l2dPoster; if (PS && PS.toStill) PS.toStill();
  boot.sceneLoop = false;
  endBoot(() => {}); fullBoot();
  on(window, 'resize', measure); if (document.fonts) document.fonts.ready.then(() => { if (!boot.disposed) measure(); });
  startDomLoop();
}

/* ================================================================== scroll model */
export const metrics = [];   // filled in place: importers keep one live reference
export function measure() {
  const vh = VH();
  metrics.length = 0;
  for (const el of sections) {
    const top = el.offsetTop; const h = el.offsetHeight;
    metrics.push({ a: top, b: Math.max(top, top + h - vh) });
  }
}

/** -> { i, j, t, local[] }  i/j = stations blended, t = 0..1 between them */
export function computeScroll(s) {
  const m = metrics; const local = m.map((k) => clamp((s - k.a) / Math.max(1, k.b - k.a)));
  for (let i = 0; i < m.length; i++) {
    if (s <= m[i].b) {
      if (i === 0 || s >= m[i].a) return { i, j: i, t: 0, local };
      const t = clamp((s - m[i - 1].b) / Math.max(1, m[i].a - m[i - 1].b));
      return { i: i - 1, j: i, t, local };
    }
  }
  const n = Math.max(0, m.length - 1); return { i: n, j: n, t: 0, local };
}

/* station indices by kind (the admin may switch stations off: the scene and the DOM look them up by id) */
export const IDX = { intro: -1, hero: -1, categories: -1, suppliers: -1, process: -1, ways: -1, cta: -1 };

/* DOM side of the scroll (works with or without WebGL) */
let hudSec = null, posterEl = null, posterO = -1, gpI = null, gpName = null, wkOpen = null, wkOpenName = null;
export function updateDom(sc, real = sc) {
  // the first-paint poster leaves with the intro's scroll (where it stays: reduced motion, no WebGL, or before the scene)
  if (posterEl && IDX.intro >= 0) { const o = Math.round((1 - smooth(0.06, 0.55, sc.local[IDX.intro] || 0)) * 100) / 100; if (o !== posterO) { posterO = o; posterEl.style.setProperty('--poster-o', o); } }
  const active = real.t < 0.5 ? real.i : real.j;
  if (active !== state.active) {
    state.active = active;
    sections.forEach((el, k) => el.classList.toggle('on', k === active));
    railBtns.forEach((b, k) => b.classList.toggle('on', k === active));
    if (hudSec) hudSec.textContent = `SEC ${pad(active + 1)} // ${SEC_NAMES[active] || ''}`;
    document.documentElement.classList.toggle('at-end', active === sections.length - 1);
    document.documentElement.classList.toggle('past-hero', active >= 2);
  }
  // categories panel
  if (GAMES.length && IDX.categories >= 0) {
    const g = Math.round((sc.local[IDX.categories] || 0) * (GAMES.length - 1));
    if (g !== state.game) { state.game = g; showGame(g); }
  }
  // route steps (the globe story's beats)
  if (IDX.suppliers >= 0) {
    // (the globe's clock, labglobe.js ACT_T: request 0.18-0.36, sourcing 0.42-0.6, offer 0.62-0.76, delivery 0.76-0.9;
    // without the globe the station's own scroll steps through the four)
    const st = state.story; const k = st != null ? (st < 0.4 ? 0 : st < 0.61 ? 1 : st < 0.76 ? 2 : 3) : Math.min(3, Math.floor((sc.local[IDX.suppliers] || 0) * 4));
    stepEls.forEach((li, idx) => li.classList.toggle('on', active === IDX.suppliers && idx === k));
  }
}

function showGame(i) {
  const g = GAMES[i];
  if (!g) return;
  if (gpI) gpI.textContent = pad(i + 1);
  if (gpName) scramble(gpName, g.name);
  if (wkOpen && g.slug) wkOpen.setAttribute('href', `/marketplace?category=${encodeURIComponent(g.slug)}`);
  if (wkOpenName) wkOpenName.textContent = g.name;
  $$('#game-list button').forEach((b, k) => { b.classList.toggle('on', k === i); b.toggleAttribute('aria-current', k === i); });
  if (hooks.cardGlitch) hooks.cardGlitch(i);
}

/** (Re)read the page: called once per mount, before anything else of the landing runs. */
export function initCore(config) {
  CFG = config || { links: {}, games: [], text: {} };
  GAMES = CFG.games || [];
  TEXT = CFG.text || {};
  params = new URLSearchParams(location.search);
  DEBUG = params.has('debug');
  reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  finePointer = matchMedia('(pointer: fine)').matches;
  PHONE_UA = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  glEl = document.getElementById('gl');
  vwNow = 0; vhNow = 0; syNow = -1;
  sections = $$('.lnd [data-station]');
  stepEls = $$('.lnd .steps li');
  railBtns = $$('.lnd-rail button');
  SEC_NAMES = sections.map((s) => s.dataset.name || '');
  for (const k of Object.keys(IDX)) IDX[k] = sections.findIndex((s) => s.dataset.station === k);
  hudSec = $('#lnd-sec'); posterEl = document.getElementById('poster'); posterO = -1;
  gpI = $('#gp-i'); gpName = $('#gp-name'); wkOpen = $('#wk-open'); wkOpenName = $('#wk-open-name');
  Object.assign(state, { mx: 0, my: 0, tmx: 0, tmy: 0, scroll: window.scrollY, active: -1, game: -1, pointer: false, story: null });
  hooks.cardGlitch = null;
  boot.up = true; boot.sceneLoop = false; boot.disposed = false;
  domLoopOn = false;
  offs = [];
  on(window, 'scroll', () => { syNow = window.scrollY; }, { passive: true });
  on(window, 'resize', () => { readVW(); readVH(); syNow = -1; });   // registered first: every other resize handler sees the fresh values
  measure();
}

/** Unmount: stop the loops and remove every listener the landing attached. */
export function disposeCore() {
  boot.disposed = true;
  for (const f of offs.splice(0)) { try { f(); } catch (e) { /* already gone */ } }
  const cl = document.documentElement.classList;
  for (const c of ['gl-ready', 'gl-full', 'gl-settled', 'gl-gone', 'gl-exiting', 'gl-lost', 'no-webgl', 'at-end', 'past-hero', 'in-foot', 'touring', 'poster-off', 'poster-gone', 'poster-reveal', 'poster-lt', 'cursor', 'can-hover', 'is-landing', 'below-ready', 'poster-drawn']) cl.remove(c);
  document.documentElement.style.removeProperty('--gl-exit');
}
