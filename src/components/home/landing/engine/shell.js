// lab2date homepage shell, ported from the Shelter landing's src/main.js. Everything a visitor reads or clicks works
// from this file alone (the categories list and pager, the buying demo, the ways-to-buy tabs, the auto tour, the
// section rail); the WebGL scene (scene.js, three.js) is a separate chunk started after the first paint and fades in
// when it is ready. startLanding() runs on every mount of the homepage and returns its teardown.
import {
  GAMES, $, $$, params, reduced, finePointer, clamp, state, metrics, measure, sections, railBtns, noGL, startDomLoop,
  initCore, disposeCore, on, onCleanup, boot, IDX, whenIdle,
} from './core.js';
import { initPoster } from './poster.js';

export function startLanding(config) {
  initCore(config);
  const html = document.documentElement;
  html.classList.add('is-landing');
  let scene = null, stopped = false;
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (!stopped) fn(); }, ms); timers.add(id); return id; };

  /* ---------------------------------------------------------------- categories: list + pager (the games' list) */
  const list = $('#game-list');
  const goGame = (i) => {
    if (!metrics.length || IDX.categories < 0 || !GAMES.length) return;
    const k = clamp(i, 0, GAMES.length - 1); const m = metrics[IDX.categories];
    window.scrollTo({ top: m.a + (m.b - m.a) * (k / Math.max(1, GAMES.length - 1)), behavior: reduced ? 'auto' : 'smooth' });
  };
  if (list) on(list, 'click', (e) => { const b = e.target.closest('button[data-i]'); if (b) goGame(+b.dataset.i); });
  const prev = $('#wk-prev'), next = $('#wk-next');
  if (prev) on(prev, 'click', () => goGame(state.game - 1));
  if (next) on(next, 'click', () => goGame(state.game + 1));

  /* ---------------------------------------------------------------- ways to buy: tabs (the plans station) */
  {
    const tabs = $$('.ways-tabs button[data-way]'), panels = $$('.ways-panel'), code = $('#ways-code');
    const pick = (i, focus = false) => {
      tabs.forEach((b, k) => { b.classList.toggle('on', k === i); b.setAttribute('aria-selected', String(k === i)); b.tabIndex = k === i ? 0 : -1; });
      panels.forEach((p, k) => { p.hidden = k !== i; p.classList.toggle('on', k === i); });
      $('[data-way-emb]').forEach((e, k) => e.classList.toggle('on', k === i));
      if (code) code.textContent = `WAY ${String(i + 1).padStart(2, '0')} // ${(tabs[i]?.querySelector('em')?.textContent || '').toUpperCase()}`;
      if (focus) tabs[i]?.focus();
      if (scene && scene.setWay) scene.setWay(i);
      document.dispatchEvent(new CustomEvent('l2d:way', { detail: { index: i } }));
    };
    tabs.forEach((b, i) => {
      on(b, 'click', () => pick(i));
      on(b, 'keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); pick((i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length, true); }
      });
    });
  }

  /* ---------------------------------------------------------------- the buying panel demo (the app station)
     A replica of the lab2date buying panel: a quote moves from request to shipment while a ghost cursor accepts the
     offer. Plays by itself while on screen; the first real touch or click inside it stops the ghost. Sample data
     (the note under it says so). */
  const demo = (() => {
    const root = $('#app-demo'); if (!root) return null;
    const q = (x) => root.querySelector(x), qa = (x) => [...root.querySelectorAll(x)];
    const status = q('#ad-status'), offer = q('#ad-offer'), accept = q('#ad-accept'), toastEl = q('#ad-toast'), cursor = q('#ad-cursor');
    const steps = qa('#ad-timeline li');
    const LABEL = ['Requested', 'Offer received', 'Accepted', 'Paid', 'Shipped'];
    const sleep = (ms) => new Promise((r) => later(r, ms));
    const toast = (t) => { toastEl.textContent = t; toastEl.classList.add('on'); clearTimeout(toast.k); toast.k = later(() => toastEl.classList.remove('on'), 1700); };
    const setStep = (k) => {
      steps.forEach((li, i) => { li.classList.toggle('done', i < k || (k === 4 && i === 4)); li.classList.toggle('now', i === k && k < 4); });
      status.textContent = LABEL[k];
      offer.classList.toggle('live', k === 1);
    };
    setStep(0);
    let took = false, running = false, visible = false;
    const STOP = {};
    const guard = () => { if (took || stopped) throw STOP; };
    const moveTo = async (el) => {
      const r = root.getBoundingClientRect(), b = el.getBoundingClientRect();
      cursor.style.transform = `translate(${(b.left - r.left + b.width * 0.5).toFixed(1)}px,${(b.top - r.top + b.height * 0.55).toFixed(1)}px)`;
      cursor.classList.add('on'); await sleep(820); guard();
    };
    const play = async () => {
      if (running || took || reduced) return; running = true;
      try {
        while (!took && !stopped) {
          if (!visible || document.hidden) { await sleep(400); continue; }
          setStep(0); await sleep(1400); guard();
          setStep(1); toast('Offer received — proforma attached'); await sleep(1500); guard();
          await moveTo(accept); accept.classList.add('press'); await sleep(260); accept.classList.remove('press'); guard();
          setStep(2); toast('Offer accepted'); cursor.classList.remove('on'); await sleep(1600); guard();
          setStep(3); toast('Proforma paid — VAT invoice issued'); await sleep(1700); guard();
          setStep(4); toast('Shipped'); await sleep(2600); guard();
        }
      } catch (e) { if (e !== STOP) throw e; }
      cursor.classList.remove('on'); running = false;
    };
    const takeOver = (e) => { if (e.isTrusted && !took) { took = true; cursor.classList.remove('on'); } };
    on(root, 'pointerdown', takeOver, true); on(root, 'keydown', takeOver, true);
    // the visitor can play it too
    on(accept, 'click', () => { setStep(2); toast('Offer accepted'); });
    if (!reduced) {
      on(root, 'pointermove', (e) => {
        if (e.pointerType === 'touch') return; const r = root.getBoundingClientRect();
        root.style.setProperty('--ry', `${(((e.clientX - r.left) / r.width) - 0.5) * -5}deg`); root.style.setProperty('--rx', `${-(((e.clientY - r.top) / r.height) - 0.5) * 4}deg`);
      });
      on(root, 'pointerleave', () => { root.style.setProperty('--ry', '0deg'); root.style.setProperty('--rx', '0deg'); });
    } else setStep(2);
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) play(); }, { threshold: 0.45 });
      io.observe(root); onCleanup(() => io.disconnect());
    }
    return { root };
  })();

  /* ---------------------------------------------------------------- leaving the 3D story
     The canvas is fixed: once the last station stops being pinned its copy would slide over the particle word. The
     canvas fades out over the first ~20% of a screen of that exit and the scene stops drawing (html.gl-gone). */
  {
    const last = sections[sections.length - 1];
    let pend = false, prevX = -1;
    const upd = () => {
      pend = false; if (!last || stopped) return;
      const vh = innerHeight; const x = Math.min(1, Math.max(0, (vh - last.getBoundingClientRect().bottom) / (vh * 0.2)));
      if (Math.abs(x - prevX) < 0.003) return; prevX = x;
      html.style.setProperty('--gl-exit', x.toFixed(3));
      html.classList.toggle('gl-exiting', x > 0); html.classList.toggle('gl-gone', x >= 1);
    };
    on(window, 'scroll', () => { if (!pend) { pend = true; requestAnimationFrame(upd); } }, { passive: true });
    on(window, 'resize', upd); upd();
  }

  /* ---------------------------------------------------------------- below the stage: the extras and the footer hide the HUD */
  {
    const foot = document.querySelector('body > footer, footer');
    const extras = $$('.lnd > section, .lnd-extras');
    if ('IntersectionObserver' in window && (foot || extras.length)) {
      const seen = new Set();
      const io = new IntersectionObserver((es) => {
        es.forEach((e) => (e.isIntersecting ? seen.add(e.target) : seen.delete(e.target)));
        html.classList.toggle('in-foot', seen.size > 0);
      }, { rootMargin: '0px 0px -30% 0px' });
      [foot, ...extras].forEach((el) => el && io.observe(el));
      onCleanup(() => io.disconnect());
    }
  }

  /* ---------------------------------------------------------------- auto tour
     If a visitor lands at the top and does nothing for a few seconds the page plays itself: the molecule, a few
     categories, the whole route story, the buying demo, and comes to rest on the ways to buy. Any wheel, touch, key or
     click hands control back at once, and it never starts again on its own in that visit. */
  const TOUR = (() => {
    const btn = $('#lnd-tour-btn'), bar = $('#lnd-tour-bar'), stopBtn = $('#lnd-tour-stop');
    if (!btn || !bar) return null;
    const fill = bar.querySelector('.tb-fill');
    const at = (sec, p) => () => { const mm = metrics[sec]; return mm ? mm.a + (mm.b - mm.a) * p : 0; };
    const G = Math.max(1, GAMES.length - 1);
    const STEPS = [
      IDX.hero >= 0 && { to: at(IDX.hero, 0.3), go: 2.8, stay: 4.4 },
      IDX.categories >= 0 && { to: at(IDX.categories, 0), go: 2.4, stay: 3.6 },
      ...(IDX.categories >= 0 ? [Math.round(G / 2), G].filter((k) => k > 0).map((k) => ({ to: at(IDX.categories, k / G), go: 1.9, stay: 3.4 })) : []),
      IDX.suppliers >= 0 && { to: at(IDX.suppliers, 0.3), go: 2.6, stay: 4.5 },
      IDX.process >= 0 && { to: at(IDX.process, 0.4), go: 2.6, stay: 9 },
      IDX.ways >= 0 && { to: at(IDX.ways, 0.35), go: 2.6, stay: 0 },
    ].filter(Boolean);
    if (!STEPS.length) return null;
    const TOTAL = STEPS.reduce((k, st) => k + st.go + st.stay, 0);
    let running = false, idx = 0, t0 = 0, y0 = 0, done = 0, lastY = -1, raf = 0;
    const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
    const show = (v) => { html.classList.toggle('touring', v); bar.setAttribute('aria-hidden', String(!v)); };
    const stop = () => { if (!running) return; running = false; cancelAnimationFrame(raf); show(false); };
    const frame = (now) => {
      if (!running || stopped) return;
      if (lastY >= 0 && Math.abs(window.scrollY - lastY) > 80) { stop(); return; }
      const st = STEPS[idx]; const el = (now - t0) / 1000;
      const target = st.to();
      const y = el < st.go ? y0 + (target - y0) * ease(el / st.go) : target;
      window.scrollTo(0, y); lastY = window.scrollY;
      fill.style.transform = `scaleX(${Math.min(1, (done + Math.min(el, st.go + st.stay)) / TOTAL).toFixed(4)})`;
      if (el >= st.go + st.stay) {
        done += st.go + st.stay; idx++;
        if (idx >= STEPS.length) { stop(); return; }
        t0 = now; y0 = window.scrollY;
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (running || !metrics.length) return;
      measure(); running = true; idx = 0; done = 0; lastY = -1; t0 = performance.now(); y0 = window.scrollY;
      if (y0 > STEPS[0].to() - 10) { window.scrollTo(0, 0); y0 = 0; }
      show(true); raf = requestAnimationFrame(frame);
    };
    let touched = false, lastAct = performance.now();
    on(btn, 'click', () => { touched = true; start(); });
    if (stopBtn) on(stopBtn, 'click', () => { touched = true; stop(); });
    const act = (e) => {
      if (e.target && e.target.closest && e.target.closest('#lnd-tour-btn, #lnd-tour-bar')) return;
      lastAct = performance.now();
      if (e.type !== 'pointermove') { touched = true; stop(); }
    };
    ['wheel', 'touchstart', 'keydown', 'pointerdown', 'pointermove'].forEach((ev) => on(window, ev, act, { capture: true, passive: true }));
    const AUTO = 8000, ARM = 3000;
    if (!reduced && !params.has('s') && !params.has('notour')) {
      const tick = () => {
        if (touched || running) { btn.style.setProperty('--arm', 0); return; }
        if (window.scrollY > 40) { touched = true; btn.style.setProperty('--arm', 0); return; }
        const idle = performance.now() - lastAct;
        btn.style.setProperty('--arm', Math.max(0, Math.min(1, (idle - (AUTO - ARM)) / ARM)).toFixed(3));
        if (idle >= AUTO && document.visibilityState === 'visible' && html.classList.contains('gl-full')) { touched = true; btn.style.setProperty('--arm', 0); start(); return; }
        later(tick, 100);
      };
      later(tick, 600);
    }
    onCleanup(() => { stop(); });
    return { start, stop };
  })();

  /* ---------------------------------------------------------------- refresh opens at the top; in-page links and the rail */
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  onCleanup(() => { if ('scrollRestoration' in history) history.scrollRestoration = 'auto'; });
  const goSection = (el) => window.scrollTo({ top: el.offsetTop + (el.dataset.station === 'categories' ? 2 : 0), behavior: reduced ? 'auto' : 'smooth' });
  on(document, 'click', (e) => {
    const a = e.target.closest && e.target.closest('.lnd a[href^="#"]'); if (!a || e.defaultPrevented) return;
    const id = a.getAttribute('href').slice(1); e.preventDefault();
    const el = id && document.getElementById(id); if (el) goSection(el);
  });
  if (!params.has('s')) {
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
    window.scrollTo(0, 0);
  }
  railBtns.forEach((b) => on(b, 'click', () => { const s = document.getElementById(b.dataset.go); if (s) goSection(s); }));

  /* ---------------------------------------------------------------- pointer + custom cursor */
  const cur = $('#lnd-cur');
  const cursorOn = finePointer && !reduced && !!cur;
  if (cursorOn) on(document, 'pointerover', (e) => cur.classList.toggle('hot', !!e.target.closest('a,button')));
  on(window, 'pointermove', (e) => {
    // a real mouse / touchpad / pen (never a finger) switches mouse effects and hover styles on, whatever the device's
    // media queries claim (touchscreen laptops report pointer: coarse)
    if (e.pointerType === 'touch') return;
    if (!state.pointer) html.classList.add('can-hover');
    state.pointer = true;
    state.tmx = (e.clientX / innerWidth) * 2 - 1;
    state.tmy = -((e.clientY / innerHeight) * 2 - 1);
    if (cursorOn) {
      cur.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
      if (!cur.dataset.on && html.classList.contains('gl-settled')) { cur.dataset.on = '1'; html.classList.add('cursor'); }
    }
  }, { passive: true });

  /* ---------------------------------------------------------------- start */
  startDomLoop();
  if (document.fonts) document.fonts.ready.then(() => { if (!stopped) measure(); });
  on(window, 'load', measure, { once: true });
  const PS = initPoster();
  const startScene = () => {
    if (stopped) return;
    import('./scene.js').then((m) => m.run()).then((h) => {
      if (stopped) { if (h && h.dispose) h.dispose(); return; }
      scene = h || null;
    }).catch((e) => { console.warn('3D scene unavailable', e); if (!stopped) noGL(); });
  };
  if (params.has('nogl')) noGL();
  else {
    const go = () => requestAnimationFrame(() => later(startScene, 0));
    if (PS && PS.near) Promise.race([PS.near, new Promise((r) => later(r, 6000))]).then(go); else go();
  }
  whenIdle(() => { if (!stopped) html.classList.add('below-ready'); }, 3000);

  return {
    dispose() {
      stopped = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      if (TOUR) TOUR.stop();
      if (scene && scene.dispose) scene.dispose();
      if (PS && PS.release) PS.release();
      boot.sceneLoop = false;
      disposeCore();
      void demo;
    },
  };
}
