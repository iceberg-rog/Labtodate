// The intro lockup: the lab2date wordmark in particles, the molecule mark standing behind it.
// Ported from the Shelter landing (src/landing/intro.mjs). Shelter sampled its particles from inline SVG symbols; here
// the word is drawn in the page's own font and the mark from the logo's circles (no polygon paths needed), and the
// outline share comes from the raster's edge pixels.
// Shared by the first-paint poster (poster.js: inlined in the page, drawn in 2D before any 3D exists) and the WebGL
// scene (scene.js). Both take their particles from the page's own vector symbols (#shelter-word, #shelter-mark, no
// image to wait for) and place, size, colour and light them the same way: the poster is the scene's first frame, so
// the hand-off between them shows no jump. The scene adopts the poster's very particles (window.__l2dPoster).
// The poster runs inside the page's first frame, so everything here is written to be cheap (~10 ms on a desktop).

export const FOV = 42;                   // the scene camera (vertical, degrees)
// the word's height / width depends on the font: set by setWord() before the first sample (0.28 is Inter 800's)
export let WORD_AR = 0.28;
export const MARK_AR = 46 / 64;          // the molecule mark's viewBox (0 0 64 46)
let WORD = 'Labtodate', FONT = 'Inter, system-ui, sans-serif';
/** the particle word and the page's font family (call before introShapes / the poster) */
export function setWord(word, family) {
  WORD = word || WORD; FONT = family || FONT;
  if (typeof document === 'undefined') return;
  const g = document.createElement('canvas').getContext('2d'); g.font = `800 200px ${FONT}`;
  const w = g.measureText(WORD).width; WORD_AR = w > 0 ? 210 / w : 0.28;
  for (const k of Object.keys(rasters)) delete rasters[k];
}
const LOGO = [[8, 31, 2.4], [17, 22, 3.6], [27, 11, 6.2], [38, 16, 4.4], [47, 24, 3.2], [55, 31, 2.2]];
const PHONE = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i;   // as core.js PHONE_UA
export const introMobile = (vw) => vw < 860 || PHONE.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

/* The look of each layer. n / size: [desktop, phone]. Colours are sRGB (three.js linearises them; so does the poster).
   alpha: particle opacity; core: where the dot's soft edge starts (0.05 soft .. 0.3 crisp); gain: colour gain;
   spark: extra gain of the brightest 6 % (they reach the bloom on desktop); edge: share of particles on the outline
   (what keeps a letter's edge crisp); op: the layer's opacity; glow: the soft light the layer stands in (its shape on a
   coarse grid, `cells` across, blurred: k = strength, s = blur radii in cells for the body and the halo, mix = halo
   share, margin = cells of room all round). */
import { LT } from './theme-light.mjs';
export const LOOK = {
  word: { n: [30000, 12000], size: [2.0, 2.3], a: 0xf4ffe0, b: 0xc8fbf2, alpha: 1, core: 0.2, gain: 1, spark: 0.55, edge: 0.24, op: 1,
    glow: { k: 0.16, a: 0xbdf05f, b: 0x5fe3cf, cells: 175, margin: 14, s: [1.6, 6], mix: 0.35 } },
  roof: { n: [17000, 6600], size: [1.9, 2.25], a: 0xa4e335, b: 0x2fd6c3, alpha: 1, core: 0.16, gain: 0.95, spark: 0, edge: 0.32, op: 0.82,
    glow: { k: 0.2, a: 0x7fd11f, b: 0x1fb8a6, cells: 150, margin: 18, s: [2.2, 8], mix: 0.4 } },
};

/* The light theme (html[data-theme=light]): pearl. The same particles as iridescent ink on the page's warm pearl paper.
   Not light added to a dark sky but ink laid over the page (normal "over" compositing in linear light): alpha is each
   dot's coverage, gain 1, no sparks. The wordmark must read from across the room, so its body is deep ink: a dark thin
   film, violet -> sapphire -> magenta along the letters (three stops, m in the middle, reached over a short transition:
   smoothstep .3 .. .7 of the width, ink3 below: every blend between neighbouring stops stays a clean deep hue, never a
   muddy one), and the dots inside the letters are drawn larger (fill: the size factor of a particle well inside the
   shape, 1 + (fill - 1) x (1 - its edge measure)) so the letters close into solid ink. The iridescence lives on the
   edges and in the halo: the outline's particles take a luminous rim (rim: a second film, shifted one hue along:
   violet letters edged in cyan, sapphire in rose, magenta in lilac; mixed in by k x the particle's edge measure, 0 well
   inside the shape .. 1 on its outline, from the glow grid: introShapes `edge`, smoothstep(hi, lo) of the grid value
   where the particle sits), and the glow becomes a pastel film aura round the letters. The roof behind is the same film
   in luminous pastel-saturated tones, a lighter pearl house. The glow is laid under each layer's particles, from the
   same blurred grid (fractions of the layer's width; coverage = grid value x k):
     shadow: a soft coloured shadow (sc, an indigo: light through tinted glass, never a grey), moved down by dy;
     knock:  the paper itself (PAPER) at the shape's place: under the wordmark it clears the roof's dust, so the roof
             never shows through the letters;
     k:      the body, a pastel film of lilac -> aqua -> rose: the aura round each letter, the roof a filled pearl house;
     deep:   the ink's own underlay inside the letters (coverage k x smoothstep(lo, hi) of the grid value: only well
             inside a stroke; the particles' film lifted `lift` towards the paper), so the gaps between the dots read as
             a lighter print of the same ink, never as bare paper: the letters stay solid at any distance.
   Sampling (n, edge) and the glow grid (cells, margin, s, mix) stay the dark look's: the particles are sampled once, and the
   scene may switch theme while it runs. */
export const LOOK_LIGHT = {
  word: { ...LOOK.word, size: [2.3, 2.5], fill: 1.7, a: 0x2f6a12, m: 0x0b6b5e, b: 0x0e4f40, alpha: 1, core: 0.36, gain: 1, spark: 0, op: 1,
    rim: { a: 0x5fae1a, m: 0x14b8a6, b: 0x2f8f6e, k: 0.8, lo: 0.46, hi: 0.64 },
    glow: { ...LOOK.word.glow, a: 0xd9f79e, m: 0xa7f0dd, b: 0xc9f2b0, k: 0.5, knock: 1.06, shadow: 0.18, dy: 0.02, sc: 0x0f3d33,
      deep: { k: 0.9, lo: 0.55, hi: 0.8, lift: 0.14 } } },
  roof: { ...LOOK.roof, size: [2.1, 2.45], fill: 1, a: 0x6aa619, m: 0x18a394, b: 0x2c7a5b, alpha: 0.85, core: 0.22, gain: 1, spark: 0, op: 1,
    rim: { a: 0x3f7f0e, m: 0x0b6b5e, b: 0x14532d, k: 0.7, lo: 0.45, hi: 0.75 },
    glow: { ...LOOK.roof.glow, a: 0xe3f9c2, m: 0xc4f3ea, b: 0xd9f7b0, k: 0.5, knock: 0, shadow: 0.07, dy: 0.012, sc: 0x134e40 } },
};
// the three-stop ink (linear colours A, M, B at x in 0 .. 1 of the width, into o): the GPU's smoothstep(.3, .7, x), then
// A -> M -> B (scene.js, fly.mjs use the same)
export function ink3(A, M, B, x, o) {
  let t = (x - 0.3) / 0.4; t = t < 0 ? 0 : t > 1 ? 1 : t; t = t * t * (3 - 2 * t);
  if (t < 0.5) { const k = t * 2; o[0] = A[0] + (M[0] - A[0]) * k; o[1] = A[1] + (M[1] - A[1]) * k; o[2] = A[2] + (M[2] - A[2]) * k; }
  else { const k = t * 2 - 1; o[0] = M[0] + (B[0] - M[0]) * k; o[1] = M[1] + (B[1] - M[1]) * k; o[2] = M[2] + (B[2] - M[2]) * k; }
  return o;
}
export const introLook = (light) => (light ? LOOK_LIGHT : LOOK);
// the light theme's paper (sRGB; the page's --bg in src/theme-light-tokens.css, the scene's sky and fog): warm pearl, ivory with a
// breath of rose. The poster and the entrance lay their ink over it exactly as the scene does over its sky, so the hand-off
// shows no jump
export const PAPER = LT.paper;
// the theme the page shows now (the head's inline script sets it before the first paint)
// lab2date: the site's theme class (html.dark = night; the light theme is everything else)
export const themeLight = () => typeof document !== 'undefined' && !document.documentElement.classList.contains('dark');

// the share of the scene's bloom kept while the lockup is on screen (the poster cannot draw a bloom: the lockup's glow is
// its own, LOOK.glow, drawn alike by both)
export const INTRO_BLOOM = 0.3;

/* world layout of the lockup for a viewport (the scene's camera sits at z = D looking down -z at the station) */
export function introLayout(vw, vh) {
  const portrait = vw / vh < 0.9; const D = portrait ? 24 : 16;
  const visW = 2 * D * Math.tan((FOV * Math.PI) / 360) * (vw / vh);
  const w = Number.isFinite(visW) ? Math.min(15.5, visW * 0.84) : 12;
  const wt = portrait ? Math.min(w * 0.92, 9) : Math.min(11.5, w * 0.7);    // wordmark width
  const wr = portrait ? Math.min(w * 1.05, 10) : Math.min(15, w * 0.94);    // roof width
  return { portrait, D, w, wt, wr, wordY: 0.25, roofY: 0.25 + wr * MARK_AR * 0.2, roofZ: -2.6 };
}

/* the drawing-buffer pixel ratio the scene will most likely start at (its budget for an ordinary GPU; scene.js) */
export const glDpr = (vw, vh, mobile) => Math.min(Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2), Math.max(mobile ? 0.75 : 0.6, Math.sqrt((mobile ? 1.0e6 : 2.0e6) / (vw * vh))));

/* a shape drawn `W` px wide (offset by `pad` px all round) into a canvas of w x h; returns the alpha bytes
   (anti-aliased: on a coarse grid that is the shape's coverage per cell). 'word': the particle word in the page's font;
   'mark': the molecule logo (its six atoms and their bonds). */
const rasters = {};
function raster(id, W, ar, pad, w, h) {
  const key = `${id}:${W}:${pad}:${w}:${h}`;
  if (rasters[key]) return rasters[key];
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.strokeStyle = '#fff';
  if (id === 'word') {
    const px = (W * ar) / 1.05;   // setWord: height = 1.05 x the font size
    g.font = `800 ${px}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(WORD, pad + W / 2, pad + (W * ar) / 2 + px * 0.04);
  } else {
    g.translate(pad, pad); g.scale(W / 64, (W * ar) / 46);
    for (const [x, y, r] of LOGO) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
    // the bonds between the atoms (the mark read as a molecule, as the hero's chrome one)
    g.lineWidth = 1.5; g.lineCap = 'round'; g.beginPath(); LOGO.forEach(([x, y], k) => g[k ? 'lineTo' : 'moveTo'](x, y)); g.stroke();
  }
  const d = g.getImageData(0, 0, w, h).data; const a = new Uint8Array(w * h);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
  rasters[key] = a;
  return a;
}

/* n particles on a shape: [u, v, seed, colour mix] each; u, v in fractions of the shape's width, centred, y down.
   A share of them sits on the outline (what keeps the shape's edge crisp): the raster's edge pixels (inside, with an
   outside neighbour), picked evenly; the rest land on random inside pixels of the shape rasterised 700 px wide, drawn
   by rejection. */
function sample(id, ar, n, edgeShare) {
  const W = 700, H = Math.round(W * ar);
  const a = raster(id, W, ar, 0, W, H); if (!a) return null;
  const P = new Float32Array(n * 4); const nEdge = Math.round(n * edgeShare);
  const put = (k, u, v) => { P[k * 4] = u; P[k * 4 + 1] = v; P[k * 4 + 2] = Math.random(); P[k * 4 + 3] = Math.min(1, Math.max(0, u + 0.5 + (Math.random() - 0.5) * 0.25)); };
  const edge = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x; if (a[i] < 128) continue;
    if (a[i - 1] < 128 || a[i + 1] < 128 || a[i - W] < 128 || a[i + W] < 128) edge.push(x, y);
  }
  let k = 0;
  if (edge.length) for (; k < nEdge; k++) {
    const e = ((Math.random() * edge.length) / 2 | 0) * 2;
    put(k, (edge[e] + Math.random() - W / 2) / W, (edge[e + 1] + Math.random() - H / 2) / W);
  }
  for (let tries = 0; k < n && tries < n * 200; tries++) {
    const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
    if (a[y * W + x] < 128) continue;
    put(k++, (x + Math.random() - W / 2) / W, (y + Math.random() - H / 2) / W);
  }
  return P;
}

/* the layer's glow: the shape's coverage on a coarse grid (o.cells across, o.margin cells of room all round), blurred
   twice (body + halo; box passes, near-Gaussian), faded to zero at the grid's border, quantised to 8 bits:
   the scene uploads it as a texture and samples it with linear filtering, the poster samples the same values
   bilinearly. u0 / v0 / du / dv: the grid's box in the shape's units. */
function glowGrid(id, ar, o) {
  const C = o.cells, m = o.margin; const gw = Math.ceil(C) + 2 * m, gh = Math.ceil(C * ar) + 2 * m; const N = gw * gh;
  const a = raster(id, C, ar, m, gw, gh); if (!a) return null;
  const cov = new Float32Array(N); for (let i = 0; i < N; i++) cov[i] = a[i] / 255;
  const box = (src, dst, r, horiz) => {   // running-sum box blur of radius r along one axis (zero outside)
    const len = horiz ? gw : gh, lines = horiz ? gh : gw, step = horiz ? 1 : gw, lstep = horiz ? gw : 1, k = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const b = l * lstep; let s = 0;
      for (let i = 0; i <= r && i < len; i++) s += src[b + i * step];
      for (let i = 0; i < len; i++) {
        dst[b + i * step] = s * k;
        const add = i + r + 1, sub = i - r;
        if (add < len) s += src[b + add * step];
        if (sub >= 0) s -= src[b + sub * step];
      }
    }
  };
  const blur = (s) => {   // two box passes per axis (a triangle filter) of the spread of a Gaussian of sigma s
    const r = Math.max(1, Math.round((Math.sqrt(6 * s * s + 1) - 1) / 2)); const t1 = new Float32Array(N), t2 = new Float32Array(N);
    box(cov, t1, r, true); box(t1, t2, r, true); box(t2, t1, r, false); box(t1, t2, r, false);
    return t2;
  };
  const b1 = blur(o.s[0]), b2 = blur(o.s[1]); const g = new Float32Array(N);
  const edge = (i, n) => { const e = Math.min(i, n - 1 - i) / 4; return e >= 1 ? 1 : e * e * (3 - 2 * e); };
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const i = y * gw + x;
    g[i] = Math.round(Math.min(1, b1[i] * (1 - o.mix) + b2[i] * o.mix) * edge(x, gw) * edge(y, gh) * 255) / 255;
  }
  return { w: gw, h: gh, g, u0: (-m - C / 2) / C, v0: (-m - (C * ar) / 2) / C, du: gw / C, dv: gh / C };
}

/* each particle's edge measure (the light theme's luminous rim): the layer's glow grid sampled bilinearly where the
   particle sits (as the poster samples it), smoothstep(hi, lo) of it: 0 well inside the shape, 1 on its outline */
function edgeOf(pts, g, r) {
  const n = pts.length / 4, e = new Float32Array(n), gw = g.w, gh = g.h, gv = g.g;
  for (let i = 0; i < n; i++) {
    let fx = ((pts[i * 4] - g.u0) / g.du) * gw - 0.5, fy = ((pts[i * 4 + 1] - g.v0) / g.dv) * gh - 0.5;
    fx = Math.min(gw - 1.001, Math.max(0, fx)); fy = Math.min(gh - 1.001, Math.max(0, fy));
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, o = iy * gw + ix;
    const v = (gv[o] + (gv[o + 1] - gv[o]) * tx) * (1 - ty) + (gv[o + gw] + (gv[o + gw + 1] - gv[o + gw]) * tx) * ty;
    let k = (v - r.hi) / (r.lo - r.hi); k = k < 0 ? 0 : k > 1 ? 1 : k; e[i] = k * k * (3 - 2 * k);
  }
  return e;
}

/* both layers' particles and glows (null when the page has no symbols or the browser no Path2D) */
export function introShapes(mobile) {
  const t = mobile ? 1 : 0;
  const word = { pts: sample('word', WORD_AR, LOOK.word.n[t], LOOK.word.edge), glow: glowGrid('word', WORD_AR, LOOK.word.glow) };
  const roof = { pts: sample('mark', MARK_AR, LOOK.roof.n[t], LOOK.roof.edge), glow: glowGrid('mark', MARK_AR, LOOK.roof.glow) };
  if (!(word.pts && word.glow && roof.pts && roof.glow)) return null;
  word.edge = edgeOf(word.pts, word.glow, LOOK_LIGHT.word.rim); roof.edge = edgeOf(roof.pts, roof.glow, LOOK_LIGHT.roof.rim);
  return { mobile, word, roof };
}

/* ------------------------------------------------------------------ the poster: the scene's first frame, in 2D
   A software copy of what the GPU does with these particles: each one a square point sprite of the shader's size with
   the shader's soft disc, added in linear light; the glow added under them; then the scene's Neutral tone mapping and
   sRGB output. Only the lockup is drawn (the page shows through: the poster's light is added to it, plus-lighter), on
   a canvas just big enough for it, at the pixel ratio the scene will draw at, on the scene canvas's pixel grid. */
const lin = (h, k) => { const c = ((h >> k) & 255) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const rgb = (h) => [lin(h, 16), lin(h, 8), lin(h, 0)];
let ENC = null;   // linear [0, 1] -> sRGB [0, 1], 4096 steps
export function drawPoster(cv, box, s, vw, vh, dpr, light = false) {
  if (!ENC) { ENC = new Float32Array(4097); for (let i = 0; i <= 4096; i++) { const c = i / 4096; ENC[i] = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; } }
  if (light) { drawPosterLight(cv, box, s, vw, vh, dpr); return; }
  const L = introLayout(vw, vh); const tan = Math.tan((FOV * Math.PI) / 360);
  const ppu = (z) => vh / 2 / (tan * (L.D - z));   // CSS px per world unit at depth z
  const layers = [
    { look: LOOK.roof, sh: s.roof, dist: L.D - L.roofZ, cx: vw / 2, cy: vh / 2 - L.roofY * ppu(L.roofZ), W: L.wr * ppu(L.roofZ) },
    { look: LOOK.word, sh: s.word, dist: L.D, cx: vw / 2, cy: vh / 2 - L.wordY * ppu(0), W: L.wt * ppu(0) },
  ];
  // the canvas: the glows' boxes (they reach furthest), snapped to the scene's pixel grid
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const l of layers) { const g = l.sh.glow; x0 = Math.min(x0, l.cx + g.u0 * l.W); x1 = Math.max(x1, l.cx + (g.u0 + g.du) * l.W); y0 = Math.min(y0, l.cy + g.v0 * l.W); y1 = Math.max(y1, l.cy + (g.v0 + g.dv) * l.W); }
  const X0 = Math.max(0, Math.floor(x0 * dpr)), Y0 = Math.max(0, Math.floor(y0 * dpr));
  const X1 = Math.min(Math.round(vw * dpr), Math.ceil(x1 * dpr)), Y1 = Math.min(Math.round(vh * dpr), Math.ceil(y1 * dpr));
  const bw = Math.max(1, X1 - X0), bh = Math.max(1, Y1 - Y0);
  const acc = new Float32Array(bw * bh * 3);
  for (const l of layers) {
    const { look, sh } = l; const A = rgb(look.a), B = rgb(look.b);
    // glow: the grid sampled bilinearly (texel centres at i + .5, like the GPU) once per 2x2 pixel block (it is far
    // smoother than that)
    { const g = sh.glow, G = look.glow; const gA = rgb(G.a), gB = rgb(G.b); const gw = g.w, gh = g.h, gv = g.g;
      const sc = l.W * dpr; const ox = l.cx * dpr - X0, oy = l.cy * dpr - Y0;
      const px0 = Math.max(0, Math.floor(ox + g.u0 * sc)) & ~1, px1 = Math.min(bw, Math.ceil(ox + (g.u0 + g.du) * sc));
      const py0 = Math.max(0, Math.floor(oy + g.v0 * sc)) & ~1, py1 = Math.min(bh, Math.ceil(oy + (g.v0 + g.dv) * sc));
      const nx = Math.ceil((px1 - px0) / 2); const IX = new Int32Array(nx), TX = new Float32Array(nx), CR = new Float32Array(nx), CG = new Float32Array(nx), CB = new Float32Array(nx);
      for (let k = 0; k < nx; k++) {
        const u = (px0 + 2 * k + 1 - ox) / sc; let f = ((u - g.u0) / g.du) * gw - 0.5; f = Math.min(gw - 1.001, Math.max(0, f));
        IX[k] = f | 0; TX[k] = f - (f | 0);
        const mm = Math.min(1, Math.max(0, u + 0.5)); CR[k] = (gA[0] + (gB[0] - gA[0]) * mm) * G.k; CG[k] = (gA[1] + (gB[1] - gA[1]) * mm) * G.k; CB[k] = (gA[2] + (gB[2] - gA[2]) * mm) * G.k;
      }
      const row = new Float32Array(gw);
      for (let py = py0; py < py1; py += 2) {
        const v = (py + 1 - oy) / sc; let f = ((v - g.v0) / g.dv) * gh - 0.5; f = Math.min(gh - 1.001, Math.max(0, f));
        const iy = f | 0, ty = f - iy, r0 = iy * gw, r1 = r0 + gw;
        let any = false; for (let x = 0; x < gw; x++) { const q = gv[r0 + x] + (gv[r1 + x] - gv[r0 + x]) * ty; row[x] = q; if (q > 0) any = true; }
        if (!any) continue;
        const two = py + 1 < bh;
        for (let k = 0; k < nx; k++) {
          const ix = IX[k]; const val = row[ix] + (row[ix + 1] - row[ix]) * TX[k]; if (val <= 0) continue;
          const r = CR[k] * val, gg = CG[k] * val, b = CB[k] * val; const px = px0 + 2 * k;
          let o = (py * bw + px) * 3; acc[o] += r; acc[o + 1] += gg; acc[o + 2] += b;
          if (px + 1 < bw) { acc[o + 3] += r; acc[o + 4] += gg; acc[o + 5] += b; }
          if (two) { o += bw * 3; acc[o] += r; acc[o + 1] += gg; acc[o + 2] += b; if (px + 1 < bw) { acc[o + 3] += r; acc[o + 4] += gg; acc[o + 5] += b; } }
        }
      }
    }
    // particles: gl_PointSize = size * (.55 + seed * .9) * dpr * 14 / distance (at least a pixel); alpha = smoothstep(.5, core, d)
    const pts = sh.pts; const n = pts.length / 4; const size = look.size[s.mobile ? 1 : 0] * dpr * (14 / l.dist);
    const e = look.core, ie = 1 / (e - 0.5); const aK = look.alpha * look.op; const gain = look.gain;
    for (let i = 0; i < n; i++) {
      const seed = pts[i * 4 + 2], mx = pts[i * 4 + 3];
      const cx = (l.cx + pts[i * 4] * l.W) * dpr - X0, cy = (l.cy + pts[i * 4 + 1] * l.W) * dpr - Y0;
      const sz = Math.max(1, size * (0.55 + seed * 0.9)); const h = sz / 2, isz = 1 / sz;
      const gk = gain * (seed > 0.94 ? 1 + look.spark : 1) * aK;
      const r = (A[0] + (B[0] - A[0]) * mx) * gk, gg = (A[1] + (B[1] - A[1]) * mx) * gk, b = (A[2] + (B[2] - A[2]) * mx) * gk;
      const pxa = Math.max(0, Math.ceil(cx - h - 0.5)), pxb = Math.min(bw - 1, Math.floor(cx + h - 0.5));
      const pya = Math.max(0, Math.ceil(cy - h - 0.5)), pyb = Math.min(bh - 1, Math.floor(cy + h - 0.5));
      for (let py = pya; py <= pyb; py++) for (let px = pxa; px <= pxb; px++) {
        const dx = px + 0.5 - cx, dy = py + 0.5 - cy; const d = Math.sqrt(dx * dx + dy * dy) * isz;
        let t = (d - 0.5) * ie; if (t <= 0) continue; if (t > 1) t = 1; const a = t * t * (3 - 2 * t);
        const o = (py * bw + px) * 3; acc[o] += r * a; acc[o + 1] += gg * a; acc[o + 2] += b * a;
      }
    }
  }
  // the scene's output: Neutral tone mapping, sRGB; the light goes out as premultiplied colour + alpha (the canvas adds it)
  const img = new ImageData(bw, bh); const D8 = img.data;
  for (let i = 0, j = 0; i < acc.length; i += 3, j += 4) {
    let r = acc[i], g = acc[i + 1], b = acc[i + 2];
    if (r + g + b < 1e-4) continue;
    const x = r < g ? (r < b ? r : b) : (g < b ? g : b); const off = x < 0.08 ? x - 6.25 * x * x : 0.04; r -= off; g -= off; b -= off;
    const peak = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (peak >= 0.76) {
      const np = 1 - 0.0576 / (peak - 0.52); const f = np / peak; r *= f; g *= f; b *= f;
      const q = 1 - 1 / (0.15 * (peak - np) + 1); r += (np - r) * q; g += (np - g) * q; b += (np - b) * q;
    }
    r = ENC[r <= 0 ? 0 : r >= 1 ? 4096 : (r * 4096) | 0]; g = ENC[g <= 0 ? 0 : g >= 1 ? 4096 : (g * 4096) | 0]; b = ENC[b <= 0 ? 0 : b >= 1 ? 4096 : (b * 4096) | 0];
    const a = r > g ? (r > b ? r : b) : (g > b ? g : b); if (a < 0.002) continue;
    const k = 255 / a; D8[j] = r * k; D8[j + 1] = g * k; D8[j + 2] = b * k; D8[j + 3] = a * 255;
  }
  put(cv, box, img, X0, Y0, bw, bh, vw, dpr);
}
function put(cv, box, img, X0, Y0, bw, bh, vw, dpr) {
  cv.width = bw; cv.height = bh;
  cv.getContext('2d').putImageData(img, 0, 0);
  // the scene's canvas spans the wrapper's width with a vw * dpr buffer: map device px to the wrapper's CSS px the same way
  const kx = (box.clientWidth || vw) / vw;
  const st = cv.style; st.left = `${(X0 / dpr) * kx}px`; st.top = `${Y0 / dpr}px`; st.width = `${(bw / dpr) * kx}px`; st.height = `${bh / dpr}px`;
}

/* The light theme's still frame: what the scene draws with LOOK_LIGHT, in software. Per layer (the roof, then the
   wordmark) its wash (LOOK_LIGHT glow: the shadow, the paper knock-out, the body), then its particles, each laid "over"
   what is there in linear light (premultiplied colour C, coverage A); then over the paper (C + paper x (1 - A)), sRGB
   out (the scene's light output: no tone mapping), and back to the page as ink with alpha: premultiplied
   R - paper x (1 - A), which the browser lays over the page's paper (normal compositing) to give R again. */
function drawPosterLight(cv, box, s, vw, vh, dpr) {
  const L = introLayout(vw, vh); const tan = Math.tan((FOV * Math.PI) / 360);
  const ppu = (z) => vh / 2 / (tan * (L.D - z));
  const layers = [
    { look: LOOK_LIGHT.roof, sh: s.roof, dist: L.D - L.roofZ, cx: vw / 2, cy: vh / 2 - L.roofY * ppu(L.roofZ), W: L.wr * ppu(L.roofZ) },
    { look: LOOK_LIGHT.word, sh: s.word, dist: L.D, cx: vw / 2, cy: vh / 2 - L.wordY * ppu(0), W: L.wt * ppu(0) },
  ];
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const l of layers) { const g = l.sh.glow, dy = l.look.glow.dy * l.W; x0 = Math.min(x0, l.cx + g.u0 * l.W); x1 = Math.max(x1, l.cx + (g.u0 + g.du) * l.W); y0 = Math.min(y0, l.cy + g.v0 * l.W); y1 = Math.max(y1, l.cy + (g.v0 + g.dv) * l.W + dy); }
  const X0 = Math.max(0, Math.floor(x0 * dpr)), Y0 = Math.max(0, Math.floor(y0 * dpr));
  const X1 = Math.min(Math.round(vw * dpr), Math.ceil(x1 * dpr)), Y1 = Math.min(Math.round(vh * dpr), Math.ceil(y1 * dpr));
  const bw = Math.max(1, X1 - X0), bh = Math.max(1, Y1 - Y0);
  const acc = new Float32Array(bw * bh * 4);   // premultiplied linear colour + coverage
  const over = (o, r, gg, b, a) => { const ia = 1 - a; acc[o] = r * a + acc[o] * ia; acc[o + 1] = gg * a + acc[o + 1] * ia; acc[o + 2] = b * a + acc[o + 2] * ia; acc[o + 3] = a + acc[o + 3] * ia; };
  const P = rgb(PAPER);
  for (const l of layers) {
    const { look, sh } = l; const A = rgb(look.a), B = rgb(look.b);
    // the wash: the grid sampled bilinearly once per 2x2 block, at the shape's place (knock-out, body) and `dy` above it
    // (the shadow below the shape)
    { const g = sh.glow, G = look.glow; const gA = rgb(G.a), gM = rgb(G.m), gB = rgb(G.b), gS = rgb(G.sc); const gw = g.w, gh = g.h, gv = g.g; const q3 = [0, 0, 0];
      const kS = G.shadow || 0, kK = G.knock || 0, kT = G.k || 0, Dp = G.deep, LM = rgb(look.m);
      const sc = l.W * dpr; const ox = l.cx * dpr - X0, oy = l.cy * dpr - Y0, dyp = G.dy * l.W * dpr;
      const px0 = Math.max(0, Math.floor(ox + g.u0 * sc)) & ~1, px1 = Math.min(bw, Math.ceil(ox + (g.u0 + g.du) * sc));
      const py0 = Math.max(0, Math.floor(oy + g.v0 * sc)) & ~1, py1 = Math.min(bh, Math.ceil(oy + (g.v0 + g.dv) * sc + dyp));
      const nx = Math.ceil((px1 - px0) / 2); const IX = new Int32Array(nx), TX = new Float32Array(nx), CR = new Float32Array(nx), CG = new Float32Array(nx), CB = new Float32Array(nx);
      const DR = new Float32Array(nx), DG = new Float32Array(nx), DB = new Float32Array(nx);
      for (let k = 0; k < nx; k++) {
        const u = (px0 + 2 * k + 1 - ox) / sc; let f = ((u - g.u0) / g.du) * gw - 0.5; f = Math.min(gw - 1.001, Math.max(0, f));
        IX[k] = f | 0; TX[k] = f - (f | 0);
        ink3(gA, gM, gB, u + 0.5, q3); CR[k] = q3[0]; CG[k] = q3[1]; CB[k] = q3[2];
        if (Dp) { ink3(A, LM, B, u + 0.5, q3); DR[k] = q3[0] + (P[0] - q3[0]) * Dp.lift; DG[k] = q3[1] + (P[1] - q3[1]) * Dp.lift; DB[k] = q3[2] + (P[2] - q3[2]) * Dp.lift; }
      }
      // one row of the grid at the shape's v (bilinear in y), into `row`; false: nothing there
      const rowAt = (v, row) => {
        let f = ((v - g.v0) / g.dv) * gh - 0.5; if (f < -0.5 || f > gh - 0.5) return false; f = Math.min(gh - 1.001, Math.max(0, f));
        const iy = f | 0, ty = f - iy, r0 = iy * gw, r1 = r0 + gw; let any = false;
        for (let x = 0; x < gw; x++) { const q = gv[r0 + x] + (gv[r1 + x] - gv[r0 + x]) * ty; row[x] = q; if (q > 0) any = true; }
        return any;
      };
      const row = new Float32Array(gw), rowS = new Float32Array(gw);
      const lay = (py, px, r, gg, b, a) => { let o = (py * bw + px) * 4; over(o, r, gg, b, a); if (px + 1 < bw) over(o + 4, r, gg, b, a); if (py + 1 < bh) { o += bw * 4; over(o, r, gg, b, a); if (px + 1 < bw) over(o + 4, r, gg, b, a); } };
      for (let py = py0; py < py1; py += 2) {
        const v = (py + 1 - oy) / sc;
        const on = rowAt(v, row), onS = kS > 0 && rowAt(v - G.dy, rowS);
        if (!on && !onS) continue;
        for (let k = 0; k < nx; k++) {
          const ix = IX[k], tx = TX[k], px = px0 + 2 * k;
          if (onS) { const val = rowS[ix] + (rowS[ix + 1] - rowS[ix]) * tx; if (val > 0) lay(py, px, gS[0], gS[1], gS[2], Math.min(1, val * kS)); }
          if (!on) continue;
          const val = row[ix] + (row[ix + 1] - row[ix]) * tx; if (val <= 0) continue;
          if (kK > 0) lay(py, px, P[0], P[1], P[2], Math.min(1, val * kK));
          if (kT > 0) lay(py, px, CR[k], CG[k], CB[k], Math.min(1, val * kT));
          if (Dp && val > Dp.lo) { let d = (val - Dp.lo) / (Dp.hi - Dp.lo); d = d > 1 ? 1 : d; lay(py, px, DR[k], DG[k], DB[k], d * d * (3 - 2 * d) * Dp.k); }
        }
      }
    }
    // the particles: the scene's point sprites, each laid over what is there with its soft disc as coverage; the ones on
    // the outline take the rim's film (the particle's edge measure x rim.k), the ones inside are larger (look.fill)
    const pts = sh.pts; const n = pts.length / 4; const size = look.size[s.mobile ? 1 : 0] * dpr * (14 / l.dist);
    const e = look.core, ie = 1 / (e - 0.5); const aK = look.alpha * look.op; const gain = look.gain; const M = rgb(look.m), q = [0, 0, 0];
    const R = look.rim, RA = rgb(R.a), RM = rgb(R.m), RB = rgb(R.b), q2 = [0, 0, 0], edge = sh.edge, fl = (look.fill || 1) - 1;
    for (let i = 0; i < n; i++) {
      const seed = pts[i * 4 + 2], mx = pts[i * 4 + 3];
      const cx = (l.cx + pts[i * 4] * l.W) * dpr - X0, cy = (l.cy + pts[i * 4 + 1] * l.W) * dpr - Y0;
      const sz = Math.max(1, size * (0.55 + seed * 0.9)) * (edge ? 1 + fl * (1 - edge[i]) : 1); const h = sz / 2, isz = 1 / sz;
      const gk = gain * (seed > 0.94 ? 1 + look.spark : 1);
      ink3(A, M, B, mx, q);
      const ek = edge ? edge[i] * R.k : 0;
      if (ek > 0) { ink3(RA, RM, RB, mx, q2); q[0] += (q2[0] - q[0]) * ek; q[1] += (q2[1] - q[1]) * ek; q[2] += (q2[2] - q[2]) * ek; }
      const r = q[0] * gk, gg = q[1] * gk, b = q[2] * gk;
      const pxa = Math.max(0, Math.ceil(cx - h - 0.5)), pxb = Math.min(bw - 1, Math.floor(cx + h - 0.5));
      const pya = Math.max(0, Math.ceil(cy - h - 0.5)), pyb = Math.min(bh - 1, Math.floor(cy + h - 0.5));
      for (let py = pya; py <= pyb; py++) for (let px = pxa; px <= pxb; px++) {
        const dx = px + 0.5 - cx, dy = py + 0.5 - cy; const d = Math.sqrt(dx * dx + dy * dy) * isz;
        let t = (d - 0.5) * ie; if (t <= 0) continue; if (t > 1) t = 1; const a = t * t * (3 - 2 * t) * aK; const ia = 1 - a;
        const o = (py * bw + px) * 4; acc[o] = r * a + acc[o] * ia; acc[o + 1] = gg * a + acc[o + 1] * ia; acc[o + 2] = b * a + acc[o + 2] * ia; acc[o + 3] = a + acc[o + 3] * ia;
      }
    }
  }
  // over the paper, sRGB out, back as premultiplied ink: R - paper x (1 - A)
  const Ps = [((PAPER >> 16) & 255) / 255, ((PAPER >> 8) & 255) / 255, (PAPER & 255) / 255];
  const enc = (v) => ENC[v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096) | 0];
  const img = new ImageData(bw, bh); const D8 = img.data;
  for (let i = 0; i < acc.length; i += 4) {
    const a = acc[i + 3]; if (a < 0.002) continue;
    const ia = 1 - a; const ka = 255 / a;
    D8[i] = Math.min(255, Math.max(0, (enc(acc[i] + P[0] * ia) - Ps[0] * ia) * ka));
    D8[i + 1] = Math.min(255, Math.max(0, (enc(acc[i + 1] + P[1] * ia) - Ps[1] * ia) * ka));
    D8[i + 2] = Math.min(255, Math.max(0, (enc(acc[i + 2] + P[2] * ia) - Ps[2] * ia) * ka));
    D8[i + 3] = a * 255;
  }
  put(cv, box, img, X0, Y0, bw, bh, vw, dpr);
}
