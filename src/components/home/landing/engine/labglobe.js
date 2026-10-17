/*
 * lab2date's route globe, ported from the Shelter landing's src/globe.js (same planet, line system, story machinery and
 * API; see spec/globe.md). The story here is the marketplace's: labs across Europe send their requests to the lab2date
 * hub in the Netherlands (dashed), the hub sources from its supply lanes worldwide (dashed), offers come back (solid)
 * and the instruments are delivered from the hub to the labs (solid, flowing on). The hub, the lanes and the labels
 * come from Admin -> Homepage (texts.hub, texts.lanes, texts.labs). Instead of a country polygon the hub region is a
 * soft radial glow. The legacy comet routes, pins, ripples and orbit ring of the original are not built.
 *
 * Route globe: "Black Marble Night", production build for three r186.
 *
 * One photoreal planet lit from behind: NASA Black Marble 2016 (moonlit land + lights), Solar System
 * Scope city lights / bump / land mask / clouds (CC BY 4.0), NASA Blue Marble NG (July) for the thin
 * sunrise crescent, Natural Earth for Iran. The surface maths is a GLSL port of three.js
 * examples/webgpu_tsl_earth.html (MIT), written as a plain ShaderMaterial (no ShaderChunk surgery, so
 * a three bump can't silently break it). The sun is private and defined relative to the line of sight,
 * so the crescent is identical in every framing and never relights the rest of the page.
 *
 * Grading: the planet was art-directed under ACES. Production tone-maps with PBR Neutral, so every
 * surface layer runs the ACES curve itself and then pre-inverts Neutral (sgPreTone): OutputPass lands
 * on the intended colours, and nothing on the surface crosses the bloom threshold (1.0). Only the
 * sunrise arc, the IRAN bead and comet heads are allowed to bloom.
 *
 * createGlobe({ renderer, files, quality, reduced })
 *   -> { group, update(dt, time, mouse, draw, { fade, park }), layout({ camera, portrait }), labels, textures,
 *        dispose(), ringK, radius, regional }
 * The host places/scales a parent of `group` (GLOBE_RADIUS / GLOBE_RING_K / GLOBE_RING_TILT are exported so it
 * can size the planet in screen terms before the module has loaded); layout() takes a camera posed at the
 * globe's station. Base textures are required (a failure rejects, with everything freed); the desktop regional
 * tile is optional. With `reduced` nothing travels or pulses: routes are drawn statically.
 * (The prototype took THREE as its first argument; passing the namespace around defeats esbuild's
 * tree-shaking (+190 KB), so three is imported here. createGlobe(THREE, opts) is still accepted.)
 */
import * as THREE from 'three';
import { LT } from './theme-light.mjs';

const DEG = Math.PI / 180;
const GR = 3.6;
const RING_K = 1.1; // orbit ring radius / planet radius (desktop)
// the host sizes and places the planet in screen terms, so it needs these before the module has loaded
export const GLOBE_RADIUS = GR;
export const GLOBE_RING_K = RING_K;
export const GLOBE_RING_TILT = [1.2, 0, -0.42]; // desktop orbit-ring Euler (the host measures its screen extent)
const LILAC = 0xa4e335;   // (lab2date: lime)
const CYAN = 0x2fd6c3;    // (lab2date: teal)

// lead = leader end relative to the bead in px for a planet of 300 px radius (the host scales it with the
// planet's on-screen size); the label hangs off that end, on the side the leader points to. Leaders steer
// the text off the city-light carpet onto dark water: FRA out over the North Sea, IST onto the Aegean,
// DXB onto the Gulf of Oman. prio = which label survives a collision.
const HUB0 = { lat: 52.37, lon: 4.9, label: 'Labtodate hub' };
const LANES0 = [['NYC', 40.71, -74.0], ['GRU', -23.55, -46.63], ['MAD', 40.42, -3.7], ['STO', 59.33, 18.07], ['IST', 41.01, 28.97], ['CAI', 30.04, 31.24], ['DXB', 25.2, 55.27], ['BOM', 19.08, 72.88], ['JNB', -26.2, 28.05]].map(([label, lat, lon]) => ({ label, lat, lon }));
const CITIES = [];   // (the original's comet routes: not built)
const FACE = { lat: 26, lon: 4 };   // the whole network: the Americas' east coast to India, Scandinavia to South Africa
// comet schedule: one launch every STEP s, so at most two comets are ever in flight
const STEP = 1.25;
const SEQ = STEP * CITIES.length;
const TRAVEL = 1.55;
const RIPPLE = 0.8;
const LAUNCH = [0, 2, 3, 1]; // launch slot per route: FRA, STO, IST, DXB -> FRA, DXB, STO, IST
// the hub region's glow boxes (lon/lat), set round the hub in createGlobe()

/* ---------------------------------------------------------------- shared GLSL */
const GRADE_GLSL = /* glsl */`
  // three.js ACESFilmicToneMapping (exposure 1), the curve the planet was art-directed under
  vec3 sgAces( vec3 c ) {
    const mat3 IN = mat3( vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ), vec3( 0.04823, 0.01566, 0.83777 ) );
    const mat3 OUT = mat3( vec3( 1.60475, -0.10208, -0.00327 ), vec3( -0.53108, 1.10813, -0.07276 ), vec3( -0.07367, -0.00605, 1.07602 ) );
    c = IN * ( c / 0.6 );
    vec3 a = c * ( c + 0.0245786 ) - 0.000090537;
    vec3 b = c * ( 0.983729 * c + 0.4329510 ) + 0.238081;
    return clamp( OUT * ( a / b ), 0.0, 1.0 );
  }
  // the value that PBR Neutral (the production OutputPass) maps onto display-linear d
  vec3 sgPreTone( vec3 d ) {
    d = max( d, 0.0 );
    float P = max( d.r, max( d.g, d.b ) );
    if ( P > 0.76 ) d *= ( 0.0576 / max( 1.0 - P, 0.004 ) + 0.52 ) / P;
    float y = min( d.r, min( d.g, d.b ) );
    float x = y >= 0.04 ? y + 0.04 : sqrt( y ) * 0.4;
    return d + ( x - y );
  }
  // ACES look, display peak capped below the bloom threshold, expressed for the Neutral pipeline
  vec3 sgGrade( vec3 c, float peak ) {
    vec3 d = sgAces( c );
    float P = max( d.r, max( d.g, d.b ) );
    if ( P > peak ) d *= peak / P;
    return sgPreTone( d );
  }
`;

export async function createGlobe(a = {}, b) {
  const opts = (a && a.REVISION ? b : a) || {};
  // fetcher: the host may hand in responses it started downloading earlier (see prefetchGlobe in main.js)
  const { renderer = null, files = {}, quality = 'high', reduced = false, fetcher = (u) => fetch(u, { priority: 'low' }), texts = {}, light = false } = opts;
  const ok = (p) => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lon);
  const HOME = ok(texts.hub) ? { lat: +texts.hub.lat, lon: +texts.hub.lon, label: String(texts.hub.label || HUB0.label) } : HUB0;
  const LANES = (Array.isArray(texts.lanes) ? texts.lanes.filter(ok) : []).slice(0, 12);
  const POPS = (LANES.length ? LANES : LANES0).map((q) => ({ lat: +q.lat, lon: +q.lon, label: String(q.label).slice(0, 12),
    lead: [q.lon < HOME.lon ? -28 : 26, q.lat > HOME.lat - 8 ? -20 : 16] }));
  const IRAN_BOX = [HOME.lon - 7.5, HOME.lon + 7.5, HOME.lat - 5, HOME.lat + 5];          // (the hub's glow, night)
  const IRAN_GLOW_BOX = [HOME.lon - 14, HOME.lon + 14, HOME.lat - 9, HOME.lat + 9];       // (daylight: the wider glow)
  const HI = quality !== 'low';
  const textures = [];
  const geometries = [];
  const materials = [];
  const keepG = (g) => { geometries.push(g); return g; };
  const keepM = (m) => { m.fog = false; materials.push(m); return m; };

  const ll = (lat, lon, r = GR) => {
    const phi = (90 - lat) * DEG, th = (lon + 180) * DEG;
    return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th));
  };

  /* ------------------------------------------------------------ assets (decoded off the main thread) */
  const aniso = renderer ? Math.min(HI ? 4 : 2, renderer.capabilities.getMaxAnisotropy()) : 2;
  const decode = async (url) => {
    const res = await fetcher(url); // low priority: never ahead of fonts / game art
    if (!res.ok) throw new Error(`globe asset ${url}: ${res.status}`);
    const blob = await res.blob();
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch (e) { /* fall through */ }
    }
    const img = new Image(); const u = URL.createObjectURL(blob);
    img.src = u; await img.decode(); URL.revokeObjectURL(u);
    return img;
  };
  // flipY stays false for both ImageBitmap and <img>: row 0 (north) is v = 0; shaders sample (u, 1 - v)
  const tex = (url, srgb, wrap = true) => decode(url).then((img) => {
    const t = new THREE.Texture(img);
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = aniso;
    t.wrapS = wrap ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    textures.push(t);
    return t;
  });
  const wantRegion = !!(HI && files.regionNight && files.regionLights);
  const freeTex = (t) => {
    if (!t) return;
    t.dispose();
    if (t.image && typeof t.image.close === 'function') t.image.close();
    const i = textures.indexOf(t); if (i >= 0) textures.splice(i, 1);
  };
  const freeTextures = () => textures.slice().forEach(freeTex);
  // allSettled, not all: every request is allowed to land before we decide, so nothing that decodes
  // after a failure is left un-freed. The base set is required; the desktop regional tile is optional.
  const settled = await Promise.allSettled([
    tex(files.night, true),
    tex(files.lights, true),
    tex(files.day, true),
    tex(files.pack, false),
    Promise.resolve({ rings: [] }),   // (no country polygon: the hub's glow is drawn below)
    wantRegion ? tex(files.regionNight, true, false) : null,
    wantRegion ? tex(files.regionLights, true, false) : null,
  ]);
  const fatal = settled.slice(0, 5).find((r) => r.status === 'rejected');
  if (fatal) { freeTextures(); throw fatal.reason; } // a 404 / filtered path: host keeps an empty slot
  const val = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : null);
  const [nightT, lightsT, dayT, packT, iran] = [0, 1, 2, 3, 4].map(val);
  let regNightT = val(5), regLightsT = val(6);
  const region = !!(regNightT && regLightsT);
  if (wantRegion && !region) { // half a pair is useless: drop it and keep the base 2k maps
    console.warn('route globe: regional tile unavailable, using the base maps', settled[5].reason || settled[6].reason);
    freeTex(regNightT); freeTex(regLightsT); regNightT = regLightsT = null;
  }

  try { performance.mark('globe:assets'); } catch (e) { /* noop */ }
  /* the hub's glow mask: a soft disc round the hub (the shader reads it as Shelter read Iran's fill) */
  const iranMaskT = (() => {
    const W = 192, H = 160; const [lo0, lo1, la0, la1] = IRAN_BOX;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const px = (lon, lat) => [((lon - lo0) / (lo1 - lo0)) * W, ((la1 - lat) / (la1 - la0)) * H];
    const fill = (blur) => {
      if (blur && 'filter' in g) g.filter = `blur(${blur}px)`;
      g.fillStyle = '#fff'; g.beginPath();
      for (const ring of iran.rings) ring.forEach(([lon, lat], i) => { const [x, y] = px(lon, lat); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.fill();
      g.filter = 'none';
    };
    { const [x, y] = px(HOME.lon, HOME.lat); const gr = g.createRadialGradient(x, y, 0, x, y, H * 0.42);
      gr.addColorStop(0, '#fff'); gr.addColorStop(0.45, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
    void fill;
    const t = new THREE.CanvasTexture(c);
    t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    textures.push(t);
    return t;
  })();
  // (daylight: Iran's glow, the same rings in a wider box blurred wide, the soft light round the country. The blur is
  // the shape's shadow, cast back onto the canvas from off-canvas: shadowBlur works where ctx.filter does not)
  const iranGlowT = (() => {
    const W = 160, H = 128; const [lo0, lo1, la0, la1] = IRAN_GLOW_BOX;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const px = (lon, lat) => [((lon - lo0) / (lo1 - lo0)) * W - W * 2, ((la1 - lat) / (la1 - la0)) * H];
    { const [x, y] = px(HOME.lon, HOME.lat); const gx = x + W * 2, gr = g.createRadialGradient(gx, y, 0, gx, y, H * 0.45);
      gr.addColorStop(0, '#fff'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H); }
    const t = new THREE.CanvasTexture(c);
    t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
    textures.push(t);
    return t;
  })();

  /* ------------------------------------------------------------ hierarchy
     group (host parent places it) > pivot (pointer parallax) > tilt (face lat) > spin (face lon + sway) */
  const group = new THREE.Group(); group.name = 'routeGlobe';
  const pivot = new THREE.Group(); group.add(pivot);
  const tilt = new THREE.Group(); pivot.add(tilt);
  const spin = new THREE.Group(); tilt.add(spin);
  const hv = ll(FACE.lat, FACE.lon).normalize();
  const baseYaw = -Math.atan2(hv.x, hv.z);
  spin.rotation.y = baseYaw;
  tilt.rotation.x = Math.asin(hv.y);

  /* shared uniforms; the sun lives in VIEW space */
  const SUN_LOCAL = new THREE.Vector3(0.52, 0.36, -0.77).normalize();
  const sunDir = SUN_LOCAL.clone();
  const res = new THREE.Vector2(1440, 860);
  const PR = { value: renderer ? renderer.getPixelRatio() : 1 };
  const S = {
    uSunDir: { value: sunDir },
    uSunColor: { value: new THREE.Color(1.0, 0.96, 0.9).multiplyScalar(3.6) },
    // rim: soft teal core on the sun side, lilac at twilight (was a hot #2fd0f0 hairline)
    uAtmDay: { value: new THREE.Color(0x7fdcd0) },
    uAtmTwi: { value: new THREE.Color(0x8fd8a8) },
    uRes: { value: res },
    uLimbFade: { value: 0 },
    uTime: { value: 0 },
    uFade: { value: 1 }, // appear ramp: every layer's alpha (or additive colour) is scaled by it
    // the page's daylight theme (setTheme): the planet as a pearl atlas on the page's pearl paper (its sea a luminous
    // blue-violet deepening away from the coasts, its land the day map's relief graded to warm pearl, crisp coastlines,
    // Iran in the thin film with a glow), its lines and points in the film's inks (landing.css tokens), laid over the
    // paper instead of added as light
    uLt: { value: 0 },
    uLPaper: { value: new THREE.Color(LT.paper) },
    // (the sea: a luminous ramp on the baked depth, shelf aqua-glass -> periwinkle -> violet-blue -> the deepest, never
    // darker than L 45; the land: champagne pearl, lilac in the hill shade's shadows, cream on the lit slopes)
    uLS0: { value: new THREE.Color(0xbfeee6) }, uLS1: { value: new THREE.Color(0x9fdccf) }, uLS2: { value: new THREE.Color(0x7cc7bb) }, uLS3: { value: new THREE.Color(0x5fb3a8) },
    uLFoam: { value: new THREE.Color(0xf2fffb) }, uLRose: { value: new THREE.Color(0xd9f7b0) },
    uLLandB: { value: new THREE.Color(0xece6d6) }, uLLand: { value: new THREE.Color(0x8fa88a) }, uLCream: { value: new THREE.Color(0xfdfaf2) },
    uLInk: { value: new THREE.Color(0x0e4f40) },
    uLF1: { value: new THREE.Color(LT.film1) }, uLF2: { value: new THREE.Color(LT.film2) }, uLF3: { value: new THREE.Color(LT.film3) }, uLGlow: { value: new THREE.Color(0xa4e335) },
    uLViolet: { value: new THREE.Color(LT.violet) }, uLTeal: { value: new THREE.Color(LT.azure) }, uLAtm: { value: new THREE.Color(0x8fd6c8) }, uLShell: { value: 1.04 },
  };
  const LTU = { uLt: S.uLt, uLPaper: S.uLPaper, uLViolet: S.uLViolet, uLTeal: S.uLTeal };

  /* ------------------------------------------------------------ planet */
  const regionBox = new THREE.Vector4(0, 0, 1, 1); // in (u, 1 - v) texture space: u0, top, du, dv
  if (files.regionBox) {
    const [lo0, lo1, la0, la1] = files.regionBox;
    regionBox.set((lo0 + 180) / 360, (90 - la1) / 180, (lo1 - lo0) / 360, (la1 - la0) / 180);
  }
  const BLANK = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1); BLANK.needsUpdate = true; textures.push(BLANK);
  const G = {
    uDay: { value: dayT }, uNight: { value: nightT }, uLights: { value: lightsT }, uPack: { value: packT },
    uRegN: { value: regNightT || nightT }, uRegL: { value: regLightsT || lightsT },
    uRegion: { value: regionBox }, uRegOn: { value: region ? 1 : 0 },
    uIran: { value: iranMaskT }, uIranGlow: { value: iranGlowT },
    // (daylight: the baked atlas, globe_light_assets.py: R coast distance, G relief, B sea depth; global + the route's box)
    uAtlas: { value: BLANK }, uAtlasR: { value: BLANK }, uAtlasOn: { value: 0 }, uAtlasBox: { value: new THREE.Vector4(5, 5, 1, 1) },   // (no box: out of reach)
    uGlowBox: { value: new THREE.Vector4((IRAN_GLOW_BOX[0] + 180) / 360, (90 - IRAN_GLOW_BOX[3]) / 180, (IRAN_GLOW_BOX[1] - IRAN_GLOW_BOX[0]) / 360, (IRAN_GLOW_BOX[3] - IRAN_GLOW_BOX[2]) / 180) },
    uIranBox: { value: new THREE.Vector4((IRAN_BOX[0] + 180) / 360, (90 - IRAN_BOX[3]) / 180, (IRAN_BOX[1] - IRAN_BOX[0]) / 360, (IRAN_BOX[3] - IRAN_BOX[2]) / 180) },
    uIranFill: { value: new THREE.Color(LILAC).multiplyScalar(0.07) },
    uIranEdge: { value: new THREE.Color(LILAC).multiplyScalar(0.03) },
    uHome: { value: ll(HOME.lat, HOME.lon, 1).normalize() },
    // Tehran-centred falloff (radians): full brightness inside NEAR, MIN beyond FAR
    uFocus: { value: new THREE.Vector3(0.3, 0.92, 0.52) },
    uNightGain: { value: 0.9 },
    uLightsGain: { value: 1.7 },
    uOceanRough: { value: 0.3 },
    uSpecGain: { value: 0.6 },
    uSpecMax: { value: 0.9 },
    uRimNight: { value: 0.06 },
    uBump: { value: HI ? 0.03 : 0.02 }, // three bumpScale units
    uNightTint: { value: new THREE.Vector3(0.62, 0.92, 1.04) },
    uLightsTint: { value: new THREE.Vector3(1.0, 0.74, 0.44) },
    uPeak: { value: 0.86 },
    // sunrise crescent: ~25 % darker than before, deeper ocean, more contrast, its own lower display peak,
    // so it reads as sunlit Earth rather than milky fog and never competes with the IRAN bead
    uDayGain: { value: 0.74 },
    uOcean: { value: 0.5 },
    uDayGamma: { value: 1.32 },
    uDayPeak: { value: 0.44 },
    uRimGain: { value: 0.62 },
  };
  const planetMat = keepM(new THREE.ShaderMaterial({
    transparent: true, // only so the portrait limb can dissolve into the page; depth is still written
    uniforms: { ...G, uSunDir: S.uSunDir, uSunColor: S.uSunColor, uAtmDay: S.uAtmDay, uAtmTwi: S.uAtmTwi, uLimbFade: S.uLimbFade, uFade: S.uFade,
      uLt: S.uLt, uLPaper: S.uLPaper, uLS0: S.uLS0, uLS1: S.uLS1, uLS2: S.uLS2, uLS3: S.uLS3, uLFoam: S.uLFoam, uLRose: S.uLRose, uLLandB: S.uLLandB, uLLand: S.uLLand, uLCream: S.uLCream,
      uLInk: S.uLInk, uLF1: S.uLF1, uLF2: S.uLF2, uLF3: S.uLF3, uLGlow: S.uLGlow },
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vObjN;
      void main(){
        vUv = uv; vObjN = normal;
        vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vN = normalize( normalMatrix * normal ); vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uDay, uNight, uLights, uPack, uRegN, uRegL, uIran, uIranGlow, uAtlas, uAtlasR;
      uniform vec4 uRegion, uIranBox, uGlowBox, uAtlasBox; uniform float uRegOn, uAtlasOn;
      uniform vec3 uSunDir, uSunColor, uAtmDay, uAtmTwi, uHome, uFocus, uIranFill, uIranEdge;
      uniform float uNightGain, uLightsGain, uOceanRough, uSpecGain, uSpecMax, uRimNight, uBump, uPeak, uLimbFade, uFade;
      uniform float uDayGain, uOcean, uDayGamma, uDayPeak, uRimGain;
      uniform vec3 uNightTint, uLightsTint;
      uniform float uLt; uniform vec3 uLPaper, uLS0, uLS1, uLS2, uLS3, uLFoam, uLRose, uLLandB, uLLand, uLCream, uLInk, uLF1, uLF2, uLF3, uLGlow;
      float lHash( vec2 p ){ return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
      vec3 lFilm( float h, vec3 a, vec3 b, vec3 c ){ h = fract( h ); return h < 0.3333 ? mix( a, b, h * 3.0 ) : h < 0.6667 ? mix( b, c, h * 3.0 - 1.0 ) : mix( c, a, h * 3.0 - 2.0 ); }
      varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying vec3 vObjN;
      ${GRADE_GLSL}
      void main(){
        vec2 tuv = vec2( vUv.x, 1.0 - vUv.y );
        vec3 pk = texture2D( uPack, tuv ).rgb;          // r bump, g land, b clouds
        vec3 Ng = normalize( vN );
        vec3 V = normalize( vV );

        // bump (three.js perturbNormalArb, screen-space derivatives of the height)
        vec3 N = Ng; vec3 bGrad = vec3( 0.0 ); float bDet = 1.0;
        {
          vec2 dH = vec2( dFdx( pk.r ), dFdy( pk.r ) ) * uBump;
          vec3 sx = normalize( dFdx( -vV ) ), sy = normalize( dFdy( -vV ) );
          vec3 R1 = cross( sy, N ), R2 = cross( N, sx );
          float det = dot( sx, R1 );
          vec3 grad = sign( det ) * ( dH.x * R1 + dH.y * R2 );
          N = normalize( abs( det ) * N - grad );
          bGrad = grad; bDet = abs( det );
        }

        // day crescent: Lambert + capped GGX glint on water (three's physical BRDF terms, 1 light)
        vec3 L = uSunDir;
        float NdL = max( dot( N, L ), 0.0 );
        vec3 albedo = texture2D( uDay, tuv ).rgb;
        albedo = pow( albedo, vec3( uDayGamma ) ) * mix( uOcean, 1.0, pk.g ) * 1.12; // contrast, deeper water
        vec3 dayCol = albedo * ( 1.0 / 3.14159265 ) * NdL * uSunColor * uDayGain;
        {
          float rough = mix( uOceanRough, 1.0, pk.g );
          vec3 H = normalize( L + V );
          float NdH = max( dot( N, H ), 0.0 ), NdV = max( dot( N, V ), 1e-3 ), VdH = max( dot( V, H ), 0.0 );
          float a2 = pow( rough, 4.0 );
          float dd = NdH * NdH * ( a2 - 1.0 ) + 1.0;
          float D = a2 / ( 3.14159265 * dd * dd );
          float gv = NdL * sqrt( NdV * NdV * ( 1.0 - a2 ) + a2 ), gl = NdV * sqrt( NdL * NdL * ( 1.0 - a2 ) + a2 );
          float Vis = 0.5 / max( gv + gl, 1e-5 );
          float F = 0.04 + 0.96 * pow( 1.0 - VdH, 5.0 );
          vec3 spec = vec3( F * Vis * D * NdL ) * uSunColor;
          dayCol += min( spec * uSpecGain, vec3( uSpecMax ) );
        }

        // Tehran-centred focus: Europe's carpet steps back, Iran stays the brightest place on the disc
        float ang = acos( clamp( dot( normalize( vObjN ), uHome ), -1.0, 1.0 ) );
        float focus = smoothstep( uFocus.y, uFocus.x, ang );
        float lightsFocus = mix( uFocus.z, 1.0, focus );

        // night side (Black Marble) + regional 3 km tile where it exists
        vec3 nightTex = texture2D( uNight, tuv ).rgb;
        vec3 lightsTex = texture2D( uLights, tuv ).rgb;
        if ( uRegOn > 0.5 ) {
          vec2 r = ( tuv - uRegion.xy ) / uRegion.zw;
          float w = smoothstep( 0.0, 0.05, r.x ) * smoothstep( 1.0, 0.95, r.x ) * smoothstep( 0.0, 0.06, r.y ) * smoothstep( 1.0, 0.94, r.y );
          if ( w > 0.0 ) {
            nightTex = mix( nightTex, texture2D( uRegN, r ).rgb, w );
            lightsTex = mix( lightsTex, texture2D( uRegL, r ).rgb, w );
          }
        }
        float sunDot = dot( Ng, L );
        float fres = 1.0 - abs( dot( V, Ng ) );
        float lat = ( vUv.y - 0.5 ) * 180.0;
        float ice = 1.0 - 0.5 * smoothstep( 60.0, 64.0, abs( lat ) );
        float ndv = clamp( dot( V, Ng ), 0.0, 1.0 );
        vec3 night = nightTex * uNightGain * ice * uNightTint * mix( 0.42, 1.0, smoothstep( 0.0, 0.75, ndv ) );
        night *= mix( 0.78, 1.0, focus );
        float dayStrength = smoothstep( -0.25, 0.5, sunDot );
        vec3 col = mix( night, dayCol, dayStrength );
        col += lightsTex * uLightsTint * uLightsGain * lightsFocus * ( 1.0 - dayStrength );

        // Iran: lit from inside rather than outlined
        vec2 iu = ( tuv - uIranBox.xy ) / uIranBox.zw;
        float im = texture2D( uIran, clamp( iu, 0.0, 1.0 ) ).r * step( 0.0, iu.x ) * step( iu.x, 1.0 ) * step( 0.0, iu.y ) * step( iu.y, 1.0 );
        if ( uLt > 0.5 ) {
          // daylight: a pearl atlas, drawn from the baked atlas (globe_light_assets.py: Natural Earth's coast as a signed
          // distance, a multi-directional hill shade, the sea's depth), the route's box at the 4096 map's resolution over
          // the global 2k. The coast is the distance field's zero line, measured in screen pixels (fwidth): a crisp ink
          // hairline at any zoom with a pale foam on the water side. The sea a luminous ramp on its depth (shelf aqua-glass
          // -> periwinkle -> violet-blue -> the deepest, never darker than L 45) with a nacre sheen (rose towards the limb, a
          // faint cyan glint of the key light). The land champagne pearl, its hue from the day map (desaturated), its relief
          // lilac in the shadows and cream on the lit slopes. City lights: a pastel glow and, where a city is bright, a small
          // near-white core in a thin ink ring. Iran in the thin film (its hue drifting over the relief: it shimmers over the
          // Zagros and the Alborz) with a luminous inner edge and a soft glow round it; the film's spectral rim in the limb
          vec3 KL = normalize( vec3( -0.45, 0.6, 0.66 ) );   // the key light (view space): high on the upper left
          float lit = smoothstep( -0.2, 0.9, dot( Ng, KL ) );
          vec3 at = vec3( pk.g, 0.5, 1.0 - pk.g );          // (until the atlas has landed: the pack's soft land mask)
          vec2 tq = tuv * vec2( textureSize( uAtlas, 0 ) );
          if ( uAtlasOn > 0.5 ) {
            at = texture2D( uAtlas, tuv ).rgb;
            vec2 ra = ( tuv - uAtlasBox.xy ) / uAtlasBox.zw;
            float wa = smoothstep( 0.0, 0.04, ra.x ) * smoothstep( 1.0, 0.96, ra.x ) * smoothstep( 0.0, 0.05, ra.y ) * smoothstep( 1.0, 0.95, ra.y );
            if ( wa > 0.0 ) at = mix( at, texture2D( uAtlasR, clamp( ra, 0.0, 1.0 ) ).rgb, wa );
          }
          float f = at.r - 0.5, fw = max( fwidth( f ), 1e-4 );
          float cd = f / fw;                                   // signed distance to the coast in px (land > 0)
          float land = smoothstep( -0.5, 0.5, cd );
          float sh = ( at.g - 0.5 ) * 2.0;                     // the hill shade: -1 shadow .. +1 lit
          // the land: champagne pearl tinted by the day map's own hue (desaturated three quarters), a breath darker where
          // it is green, lighter in the deserts; the relief in lilac and cream
          vec3 dm = texture2D( uDay, tuv ).rgb; float dlum = dot( dm, vec3( 0.2126, 0.7152, 0.0722 ) );
          vec3 hue = clamp( mix( vec3( dlum ), dm, 0.25 ) / max( dlum, 0.02 ), 0.8, 1.25 );
          vec3 earth = uLLandB * mix( vec3( 1.0 ), hue, 0.35 ) * mix( 0.94, 1.02, smoothstep( 0.03, 0.3, dlum ) );
          earth = mix( earth, uLLand, clamp( -sh, 0.0, 1.0 ) * 0.66 );
          earth = mix( earth, uLCream, clamp( sh, 0.0, 1.0 ) * 0.55 );
          earth *= 0.93 + 0.1 * lit;
          // the sea
          float dep = at.b;
          vec3 sea = mix( uLS0, uLS1, smoothstep( 0.0, 0.34, dep ) );
          sea = mix( sea, uLS2, smoothstep( 0.3, 0.68, dep ) );
          sea = mix( sea, uLS3, smoothstep( 0.62, 1.0, dep ) );
          sea *= 0.9 + 0.14 * lit;
          sea = mix( sea, uLRose, smoothstep( 0.5, 0.98, fres ) * 0.42 );
          sea += vec3( 0.55, 0.85, 1.0 ) * pow( max( dot( Ng, normalize( KL + V ) ), 0.0 ), 28.0 ) * 0.22;
          vec3 lc = mix( sea, earth, land );
          // the coast (the hairline lighter where the atlas is under ~2 px a texel: zoomed out, coasts crowd)
          float tpx = 1.0 / max( max( length( dFdx( tq ) ), length( dFdy( tq ) ) ), 1e-4 );
          float coastA = uAtlasOn * mix( 0.42, 0.72, smoothstep( 0.8, 2.4, tpx ) );
          lc = mix( lc, uLFoam, ( 1.0 - smoothstep( 0.5, 3.5, -cd ) ) * step( cd, 0.0 ) * 0.62 * uAtlasOn );
          lc = mix( lc, uLInk, ( 1.0 - smoothstep( 0.3, 1.1, abs( cd ) ) ) * coastA );
          // Iran: its glow (land and water alike), the country in the film over its relief, a luminous inner edge
          vec2 gu = ( tuv - uGlowBox.xy ) / uGlowBox.zw;
          float gm = texture2D( uIranGlow, clamp( gu, 0.0, 1.0 ) ).r * step( 0.0, gu.x ) * step( gu.x, 1.0 ) * step( 0.0, gu.y ) * step( gu.y, 1.0 );
          lc = mix( lc, uLGlow, smoothstep( 0.04, 0.7, gm ) * ( 1.0 - im ) * 0.45 );
          float ix = clamp( iu.x, 0.0, 1.0 ), iy = clamp( iu.y, 0.0, 1.0 );
          vec3 film = lFilm( ix * 0.5 + iy * 0.1 + fres * 0.22 + sh * 0.07, uLF1, uLF2, uLF3 );
          lc = mix( lc, film * ( 0.88 + 0.26 * sh ), im * 0.84 );
          lc = mix( lc, mix( film, vec3( 1.0 ), 0.55 ), im * ( 1.0 - smoothstep( 0.45, 0.9, gm ) ) * 0.5 );
          // city lights (the rest of the world steps back with the focus, as at night; in Iran they are all there)
          float lt = dot( lightsTex, vec3( 0.3, 0.5, 0.2 ) );
          float ltG = dot( texture2D( uLights, tuv, 3.0 ).rgb, vec3( 0.3, 0.5, 0.2 ) );
          float lf = mix( mix( 0.35, 1.0, focus ), 1.0, im ) * land;
          lc = mix( lc, mix( uLF1, uLF2, smoothstep( 0.04, 0.25, ltG ) ), smoothstep( 0.012, 0.16, ltG ) * 0.42 * lf * ( 1.0 - im * 0.6 ) );
          // (only the brightest cores, soft: the lights map's blobs are no shapes to print hard)
          float core = smoothstep( 0.38, 0.8, lt ) * lf;
          lc = mix( lc, uLInk, smoothstep( 0.16, 0.3, lt ) * ( 1.0 - core ) * 0.28 * lf * ( 1.0 - im ) );
          lc = mix( lc, vec3( 0.985, 0.975, 1.0 ), core * 0.8 );
          // the limb: the film's spectral rim, then the paper
          lc = mix( lc, lFilm( atan( Ng.y, Ng.x ) / 6.2832 + 0.2, uLF1, uLF2, uLF3 ), smoothstep( 0.55, 1.0, fres ) * 0.45 );
          lc = mix( lc, uLPaper, pow( fres, 3.0 ) * 0.35 );
          gl_FragColor = vec4( lc, ( 1.0 - uLimbFade * smoothstep( -0.38, -0.95, Ng.y ) ) * uFade );
          return;
        }
        col += ( uIranFill * im + uIranEdge * smoothstep( 0.0, 0.5, im ) * smoothstep( 1.0, 0.5, im ) ) * ( 1.0 - dayStrength );

        // inner atmosphere rim (webgpu_tsl_earth), thinner than the original so the crescent keeps its contrast
        vec3 atmCol = mix( uAtmTwi, uAtmDay, smoothstep( -0.25, 0.75, sunDot ) );
        float atmMix = clamp( smoothstep( -0.5, 1.0, sunDot ) * pow( fres, 3.4 ) * uRimGain, 0.0, 1.0 );
        atmMix = max( atmMix, uRimNight * pow( fres, 4.0 ) );
        col = mix( col, atmCol, atmMix );

        float a = ( 1.0 - uLimbFade * smoothstep( -0.38, -0.95, Ng.y ) ) * uFade;
        gl_FragColor = vec4( sgGrade( col, mix( uPeak, uDayPeak, min( 1.0, dayStrength * 4.0 ) ) ), a ); // the whole terminator zone gets the low peak
      }`,
  }));
  const planet = new THREE.Mesh(keepG(new THREE.SphereGeometry(GR, HI ? 160 : 112, HI ? 112 : 80)), planetMat);
  planet.name = 'planet';
  planet.renderOrder = 0;
  spin.add(planet);
  const _c = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  planet.onBeforeRender = (_r, _s, cam) => {
    _c.setFromMatrixPosition(group.matrixWorld).applyMatrix4(cam.matrixWorldInverse).negate().normalize(); // planet -> camera
    _x.crossVectors(_up, _c).normalize(); _y.crossVectors(_c, _x);
    sunDir.copy(_x).multiplyScalar(SUN_LOCAL.x).addScaledVector(_y, SUN_LOCAL.y).addScaledVector(_c, SUN_LOCAL.z).normalize();
  };

  /* ------------------------------------------------------------ clouds (1.008 GR, packed B) */
  const cloudMat = keepM(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uPack: { value: packT }, uSunDir: S.uSunDir, uSunColor: S.uSunColor, uNightTint: { value: new THREE.Color(0x7fa8a0) }, uNightAlpha: { value: 0.1 }, uLimbFade: S.uLimbFade, uFade: S.uFade, uLit: { value: 0.34 }, uDayAlpha: { value: 0.62 }, uPeak: { value: 0.4 }, ...LTU },
    vertexShader: /* glsl */`
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vN = normalize( normalMatrix * normal ); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      uniform sampler2D uPack; uniform vec3 uSunDir, uSunColor, uNightTint; uniform float uNightAlpha, uLimbFade, uFade, uLit, uDayAlpha, uPeak;
      uniform float uLt; uniform vec3 uLPaper;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      ${GRADE_GLSL}
      void main(){
        // tighter ramp than the source map: crisper cloud edges, clear gaps between the decks
        float d = smoothstep( 0.32, 0.82, texture2D( uPack, vec2( vUv.x, 1.0 - vUv.y ) ).b );
        vec3 N = normalize( vN ); vec3 V = normalize( vV );
        float sd = dot( N, uSunDir );
        float day = smoothstep( -0.12, 0.3, sd );
        vec3 lit = uSunColor * ( max( sd, 0.0 ) * 0.8 + 0.03 ) * uLit;
        vec3 col = mix( uNightTint * 0.35, lit, day );
        float a = d * mix( uNightAlpha, uDayAlpha, day );
        float fres = 1.0 - abs( dot( N, V ) );
        a *= 1.0 - 0.7 * smoothstep( 0.7, 1.0, fres );
        a *= ( 1.0 - uLimbFade * smoothstep( -0.38, -0.95, N.y ) ) * uFade;
        if ( uLt > 0.5 ) discard;   // daylight: no clouds (their wisps mottle the printed map)
        gl_FragColor = vec4( sgGrade( col, uPeak ), a );
      }`,
  }));
  const clouds = new THREE.Mesh(keepG(new THREE.SphereGeometry(GR * 1.008, HI ? 112 : 80, HI ? 80 : 56)), cloudMat);
  clouds.name = 'clouds';
  clouds.renderOrder = 2;
  spin.add(clouds);

  /* ------------------------------------------------------------ atmosphere shell (1.04 GR, BackSide)
     Base glow is graded like the surface; only the sun-facing arc gets a raw HDR lift (the one bloom). */
  const atmMat = keepM(new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false,
    uniforms: { uSunDir: S.uSunDir, uAtmDay: S.uAtmDay, uAtmTwi: S.uAtmTwi, uNightFloor: { value: 0.05 }, uGain: { value: 0.9 }, uHot: { value: 0.3 }, uLimbFade: S.uLimbFade, uFade: S.uFade, uLt: S.uLt, uLAtm: S.uLAtm, uLShell: S.uLShell },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix * vec4( position, 1.0 );
        vN = normalize( normalMatrix * normal ); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir, uAtmDay, uAtmTwi; uniform float uNightFloor, uGain, uHot, uLimbFade, uFade;
      uniform float uLt, uLShell; uniform vec3 uLAtm;
      varying vec3 vN; varying vec3 vV;
      ${GRADE_GLSL}
      void main(){
        vec3 N = normalize( vN );
        float fres = 1.0 - abs( dot( normalize( vV ), N ) );
        float sd = dot( N, uSunDir );
        float a = pow( 1.0 - clamp( ( fres - 0.73 ) / 0.27, 0.0, 1.0 ), 3.0 );
        a *= mix( uNightFloor, 1.0, smoothstep( -0.5, 1.0, sd ) ) * uGain;
        a *= 1.0 - uLimbFade * smoothstep( -0.3, -0.92, N.y );
        // the rim dies out across the lower-right quarter instead of running the whole right limb
        float ang = atan( N.y, N.x );
        a *= 1.0 - smoothstep( 0.15, -1.25, ang ) * smoothstep( -3.35, -2.3, ang );
        if ( uLt > 0.5 ) {   // daylight: the film's halo on the paper, violet -> cyan -> rose round the limb: a bright
          // spectral rim on the limb itself fading out over a tenth of the radius (h: the line of sight's height above the
          // limb, in radii; the shell is scaled to uLShell radii in daylight, setTheme)
          float s = abs( dot( normalize( vV ), N ) );
          float h = uLShell * sqrt( max( 1.0 - s * s, 0.0 ) ) - 1.0;
          float al = ( exp( -max( h, 0.0 ) * 26.0 ) * 0.7 + exp( -max( h, 0.0 ) * 9.0 ) * 0.3 ) * smoothstep( uLShell - 1.0, ( uLShell - 1.0 ) * 0.7, h );
          al *= 1.0 - uLimbFade * smoothstep( -0.3, -0.92, N.y );
          float hh = fract( atan( N.y, N.x ) / 6.2832 + 0.2 );
          vec3 fc = hh < 0.3333 ? mix( uLAtm, vec3( 0.25, 0.82, 0.74 ), hh * 3.0 ) : hh < 0.6667 ? mix( vec3( 0.25, 0.82, 0.74 ), vec3( 0.7, 0.9, 0.3 ), hh * 3.0 - 1.0 ) : mix( vec3( 0.7, 0.9, 0.3 ), uLAtm, hh * 3.0 - 2.0 );
          gl_FragColor = vec4( fc, min( 1.0, al * 0.85 ) * uFade ); return; }
        vec3 c = mix( uAtmTwi, uAtmDay, smoothstep( -0.25, 0.75, sd ) );
        vec3 col = sgGrade( c * 1.2, 0.72 );
        col += c * uHot * smoothstep( 0.45, 0.95, sd ) * smoothstep( 0.6, 0.97, a );   // only the arc facing the sun
        gl_FragColor = vec4( col, a * uFade );
      }`,
  }));
  const atmosphere = new THREE.Mesh(keepG(new THREE.SphereGeometry(GR * 1.04, 96, 64)), atmMat);
  atmosphere.name = 'atmosphere';
  atmosphere.renderOrder = 1;
  tilt.add(atmosphere);

  /* ------------------------------------------------------------ screen-space AA ribbons */
  const LINE_VS = /* glsl */`
    uniform vec2 uRes; uniform float uWidth;
    attribute vec3 aPrev; attribute vec3 aNext; attribute float aSide; attribute float aU;
    varying float vU; varying float vSide; varying vec3 vRel;
    void main(){
      mat4 mvp = projectionMatrix * modelViewMatrix;
      vec4 c = mvp * vec4( position, 1.0 );
      vec4 p = mvp * vec4( aPrev, 1.0 );
      vec4 n = mvp * vec4( aNext, 1.0 );
      vec2 dir = ( n.xy / n.w - p.xy / p.w ) * uRes;
      float l = length( dir ); dir = l > 1e-6 ? dir / l : vec2( 1.0, 0.0 );
      c.xy += vec2( -dir.y, dir.x ) * aSide * ( uWidth + 2.0 ) / uRes * c.w;
      gl_Position = c; vU = aU; vSide = aSide;
      vRel = ( modelViewMatrix * vec4( position, 1.0 ) ).xyz - ( modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
    }`;
  const lineGeometry = (pts, closed = false) => {
    const n = pts.length;
    const pos = new Float32Array(n * 6), prv = new Float32Array(n * 6), nxt = new Float32Array(n * 6);
    const side = new Float32Array(n * 2), u = new Float32Array(n * 2);
    const len = [0];
    for (let i = 1; i < n; i++) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const tmp = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = i > 0 ? pts[i - 1] : closed ? pts[n - 2] : tmp.copy(p).multiplyScalar(2).sub(pts[1]).clone();
      const b = i < n - 1 ? pts[i + 1] : closed ? pts[1] : tmp.copy(p).multiplyScalar(2).sub(pts[n - 2]).clone();
      for (let s = 0; s < 2; s++) {
        const k = i * 2 + s;
        pos.set([p.x, p.y, p.z], k * 3); prv.set([a.x, a.y, a.z], k * 3); nxt.set([b.x, b.y, b.z], k * 3);
        side[k] = s ? 1 : -1; u[k] = len[i] / len[n - 1];
      }
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aPrev', new THREE.BufferAttribute(prv, 3));
    g.setAttribute('aNext', new THREE.BufferAttribute(nxt, 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aU', new THREE.BufferAttribute(u, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return keepG(g);
  };
  const cov = /* glsl */`float coverage( float w ){ float d = abs( vSide ) * ( uWidth + 2.0 ) * 0.5; return clamp( w * 0.5 + 0.5 - d, 0.0, 1.0 ); }`;

  /* Iran outline: a 1 px lilac hairline at about a third, the inner glow does the rest */
  const outlineMat = keepM(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uRes: S.uRes, uWidth: { value: 1 }, uColor: { value: new THREE.Color(LILAC) }, uAlpha: { value: 0.34 }, uFade: S.uFade },
    vertexShader: LINE_VS,
    fragmentShader: /* glsl */`
      uniform float uWidth, uAlpha, uFade; uniform vec3 uColor; varying float vU; varying float vSide;
      ${cov}
      void main(){ gl_FragColor = vec4( uColor, coverage( uWidth ) * uAlpha * uFade ); }`,
  }));
  for (const ring of iran.rings) {
    if (ring.length < 8) continue; // skip specks (tiny Gulf islands) that would read as noise
    const pts = ring.map(([lon, lat]) => ll(lat, lon, GR * 1.0025));
    const m = new THREE.Mesh(lineGeometry(pts, true), outlineMat);
    m.renderOrder = 3; m.frustumCulled = false; m.name = 'iranOutline';
    spin.add(m);
  }

  /* routes: great-circle arcs lifted 5-8 % of GR at the apex, so they stand off the city-light carpet and
     parallax against it with the sway; a soft dark contact shadow runs underneath on the surface.
     Lilac base at ~40 % over a dark under-stroke, cyan only at the comet head. */
  const home = ll(HOME.lat, HOME.lon, 1).normalize();
  const angles = CITIES.map((c) => home.angleTo(ll(c.lat, c.lon, 1).normalize()));
  const maxAng = Math.max(...angles);
  const DARK = new THREE.Color(0x02100e);
  const shadowMats = [];
  const routes = CITIES.map((c, k) => {
    const end = ll(c.lat, c.lon, 1).normalize();
    const w = angles[k];
    const lift = 0.05 + 0.03 * (w / maxAng);
    const N = 160; const pts = []; const flat = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const a = Math.sin((1 - t) * w) / Math.sin(w), b = Math.sin(t * w) / Math.sin(w);
      const p = home.clone().multiplyScalar(a).addScaledVector(end, b).normalize();
      flat.push(p.clone().multiplyScalar(GR * 1.0015));
      pts.push(p.multiplyScalar(GR * (1.003 + lift * Math.sin(Math.PI * t))));
    }
    const uDraw = { value: 0 };
    const mat = keepM(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        uRes: S.uRes, uWidth: { value: 1.3 }, uHalo: { value: 1.1 }, uDraw, uHead: { value: -1 }, uHeadA: { value: 0 },
        uBase: { value: new THREE.Color(LILAC).multiplyScalar(0.92) }, uBaseA: { value: 0.42 },
        uDark: { value: DARK }, uDarkA: { value: 0.55 },
        uCyan: { value: new THREE.Color(CYAN) }, uFade: S.uFade,
      },
      vertexShader: LINE_VS.replace('( uWidth + 2.0 )', '( uWidth + 2.0 * uHalo + 2.0 )').replace('uniform float uWidth;', 'uniform float uWidth, uHalo;'),
      fragmentShader: /* glsl */`
        uniform float uWidth, uHalo, uDraw, uHead, uHeadA, uBaseA, uDarkA, uFade; uniform vec3 uBase, uDark, uCyan;
        varying float vU; varying float vSide;
        void main(){
          if ( vU > uDraw ) discard;
          float d = abs( vSide ) * ( uWidth + 2.0 * uHalo + 2.0 ) * 0.5;
          float core = clamp( uWidth * 0.5 + 0.5 - d, 0.0, 1.0 );
          float halo = clamp( uWidth * 0.5 + uHalo + 0.5 - d, 0.0, 1.0 );
          float ends = smoothstep( 0.0, 0.04, vU ) * ( 0.6 + 0.4 * smoothstep( 1.0, 0.9, vU ) );
          float behind = uHead - vU;
          float tail = behind >= 0.0 ? exp( -behind * 9.0 ) * uHeadA : 0.0;
          float hot = behind >= 0.0 ? exp( -behind * 70.0 ) * uHeadA : 0.0;
          // tail stays lilac and only turns cyan right at the head
          vec3 lit = mix( uBase, uCyan * 2.2, hot );
          float aCore = max( uBaseA * ends, max( tail * 0.75, hot ) );
          vec3 col = mix( uDark, lit * ( 1.0 + tail * 0.6 ), core );
          float a = max( halo * uDarkA * ends, core * aCore );
          gl_FragColor = vec4( col, a * uFade );
        }`,
    }));
    const mesh = new THREE.Mesh(lineGeometry(pts), mat);
    mesh.renderOrder = 4; mesh.frustumCulled = false; mesh.name = `route-${c.label}`;
    spin.add(mesh);
    // contact shadow: same great circle on the ground, a soft ~3 px dark band (shares the route's draw)
    const sMat = keepM(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uRes: S.uRes, uWidth: { value: 3.2 }, uDraw, uColor: { value: DARK }, uAlpha: { value: 0.42 }, uFade: S.uFade },
      vertexShader: LINE_VS,
      fragmentShader: /* glsl */`
        uniform float uWidth, uDraw, uAlpha, uFade; uniform vec3 uColor; varying float vU; varying float vSide;
        void main(){
          if ( vU > uDraw ) discard;
          float d = abs( vSide );                      // 0 centre .. 1 outer edge of the quad
          float k = exp( -d * d * 5.0 ) * ( 1.0 - d );
          float ends = smoothstep( 0.0, 0.08, vU ) * smoothstep( 1.0, 0.85, vU );
          gl_FragColor = vec4( uColor, k * ends * uAlpha * uFade );
        }`,
    }));
    shadowMats.push(sMat);
    const shadow = new THREE.Mesh(lineGeometry(flat), sMat);
    shadow.renderOrder = 3; shadow.frustumCulled = false; shadow.name = `routeShadow-${c.label}`;
    spin.add(shadow);
    return { mat, pts, end: ll(c.lat, c.lon, GR), slot: LAUNCH[k] };
  });

  /* beads: comet heads + city pins + the IRAN beacon (HDR points, additive) */
  const POINT_VS = /* glsl */`
    attribute float aSize; attribute vec3 aColor; attribute float aAlpha;
    uniform float uPR, uLt; varying vec3 vColor; varying float vAlpha;
    void main(){ vec4 mv = modelViewMatrix * vec4( position, 1.0 ); gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * uPR * ( uLt > 0.5 ? 1.6 : 1.0 ); vColor = aColor; vAlpha = aAlpha; }`;
  // (daylight: a glowing point on paper: a pearl-white core in a thin ring of its ink (the teal or the violet), a soft
  // pastel halo of the film round it, laid over the paper: a few px across, it reads as a light, not as a speck of dirt)
  const POINT_FS = /* glsl */`
    uniform float uFade, uLt; uniform vec3 uLViolet, uLTeal; varying vec3 vColor; varying float vAlpha;
    void main(){ float r = length( gl_PointCoord - 0.5 ) * 2.0; if ( r > 1.0 ) discard;
      float core = exp( -r * r * 10.0 ); float halo = exp( -r * r * 3.0 ) * 0.22;
      if ( uLt > 0.5 ) {
        bool tl = vColor.g > vColor.r;
        float c0 = 1.0 - smoothstep( 0.24, 0.38, r ), rg = smoothstep( 0.28, 0.4, r ) * ( 1.0 - smoothstep( 0.5, 0.64, r ) );
        float hl = ( 1.0 - smoothstep( 0.46, 1.0, r ) ) * 0.34;
        vec3 c = mix( tl ? vec3( 0.3, 0.84, 0.76 ) : vec3( 0.64, 0.86, 0.3 ), tl ? uLTeal : uLViolet, rg );
        c = mix( c, vec3( 0.99, 0.985, 1.0 ), c0 );
        gl_FragColor = vec4( c, min( 1.0, max( max( c0, rg ), hl ) * vAlpha * uFade ) ); return; }
      gl_FragColor = vec4( vColor * ( core + halo ) * vAlpha * uFade, 1.0 ); }`;
  const pointsMat = () => keepM(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uPR: PR, uFade: S.uFade, ...LTU }, vertexShader: POINT_VS, fragmentShader: POINT_FS,
  }));
  const mkPoints = (n) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n), 1));
    return keepG(g);
  };
  // IRAN is the brightest bead; heads and cities sit around 70 % of it once tone-mapped
  const ptMat = pointsMat();
  const headGeo = mkPoints(routes.length);
  const headCol = new THREE.Color(CYAN).multiplyScalar(2.1);
  routes.forEach((r, k) => { headGeo.attributes.aSize.array[k] = 8; headCol.toArray(headGeo.attributes.aColor.array, k * 3); });
  const heads = new THREE.Points(headGeo, ptMat);
  heads.frustumCulled = false; heads.renderOrder = 6; heads.name = 'cometHeads';
  spin.add(heads);

  const pinGeo = mkPoints(6);
  const iranCol = new THREE.Color(CYAN).lerp(new THREE.Color(0xffffff), 0.45).multiplyScalar(2.7);
  [HOME, ...CITIES].forEach((c, k) => {
    ll(c.lat, c.lon, GR * 1.004).toArray(pinGeo.attributes.position.array, k * 3);
    pinGeo.attributes.aSize.array[k] = k ? 6.5 : 11;
    (k ? new THREE.Color(LILAC).multiplyScalar(1.4) : iranCol).toArray(pinGeo.attributes.aColor.array, k * 3);
    pinGeo.attributes.aAlpha.array[k] = 1;
  });
  // slow beacon halo around Tehran (index 5)
  ll(HOME.lat, HOME.lon, GR * 1.004).toArray(pinGeo.attributes.position.array, 15);
  pinGeo.attributes.aSize.array[5] = 34;
  new THREE.Color(CYAN).multiplyScalar(0.55).toArray(pinGeo.attributes.aColor.array, 15);
  const pins = new THREE.Points(pinGeo, ptMat);
  pins.renderOrder = 5; pins.name = 'pins'; pins.frustumCulled = false;
  spin.add(pins);

  /* landing ripple: one 1 px ring, at most ~1.5x the bead, gone in under a second */
  const rippleGeo = keepG(new THREE.PlaneGeometry(0.2, 0.2));
  routes.forEach((r) => {
    const m = new THREE.Mesh(rippleGeo, keepM(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uP: { value: -1 }, uColor: { value: new THREE.Color(CYAN).multiplyScalar(0.4) }, uFade: S.uFade },
      vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: /* glsl */`
        uniform float uP, uFade; uniform vec3 uColor; varying vec2 vUv;
        void main(){ if ( uP < 0.0 || uP >= 1.0 ) discard;
          float r = length( vUv - 0.5 ) * 2.0;
          float e = 0.3 + 0.62 * ( 1.0 - pow( 1.0 - uP, 2.4 ) );
          float w = fwidth( r );
          float ring = 1.0 - smoothstep( 0.0, w * 1.1, abs( r - e ) );
          float a = smoothstep( 0.0, 0.12, uP ) * pow( 1.0 - uP, 1.4 );
          gl_FragColor = vec4( uColor * ring * a * uFade, 1.0 ); }`,
    })));
    const n = r.end.clone().normalize();
    m.position.copy(n).multiplyScalar(GR * 1.003);
    m.lookAt(n.clone().multiplyScalar(GR * 2));
    m.renderOrder = 4; m.name = 'ripple';
    spin.add(m); r.ripple = m.material;
  });

  /* ------------------------------------------------------------ the one bespoke touch: a hairline orbit
     ring at 1.1 GR (echo of the reference's chrome ring). It is depth-tested, so the planet hides its
     far side; the near half is brighter and a soft cyan-white glint travels round it every ~24 s.
     The host keeps it inside the viewport and clear of the page chrome (RING_K is exported for that). */
  const RING_R = GR * RING_K;
  const ringPts = [];
  for (let i = 0; i <= 360; i++) { const a = (i / 360) * Math.PI * 2; ringPts.push(new THREE.Vector3(Math.cos(a) * RING_R, 0, Math.sin(a) * RING_R)); }
  const ringMat = keepM(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uRes: S.uRes, uWidth: { value: 1.25 }, uColor: { value: new THREE.Color(LILAC) }, uGlintColor: { value: new THREE.Color(0xd9f7ff) }, uAlpha: { value: 0.44 }, uTime: S.uTime, uR: { value: RING_R }, uLimbFade: S.uLimbFade, uOn: { value: 0 }, uFade: S.uFade },
    vertexShader: LINE_VS,
    fragmentShader: /* glsl */`
      uniform float uWidth, uAlpha, uTime, uR, uLimbFade, uOn, uFade; uniform vec3 uColor, uGlintColor;
      varying float vU; varying float vSide; varying vec3 vRel;
      ${cov}
      void main(){
        float front = smoothstep( -0.6, 0.8, vRel.z / uR );
        float g = fract( vU - uTime / 24.0 ); g = min( g, 1.0 - g );
        float glint = exp( -g * g * 700.0 );
        float a = uAlpha * mix( 0.3, 1.0, front ) * ( 1.0 + glint * 1.4 );
        a *= 1.0 - uLimbFade * smoothstep( -0.55, -1.05, vRel.y / uR );
        vec3 c = mix( uColor, uGlintColor * 1.15, glint );
        gl_FragColor = vec4( c, min( coverage( uWidth ) * a, 1.0 ) * uOn * uFade );
      }`,
  }));
  const ringMesh = new THREE.Mesh(lineGeometry(ringPts, true), ringMat);
  ringMesh.renderOrder = 3; ringMesh.frustumCulled = false; ringMesh.name = 'orbitRing';
  const ringHolder = new THREE.Group();
  ringHolder.rotation.set(...GLOBE_RING_TILT);
  ringHolder.add(ringMesh);
  // (the orbit ring is no longer shown: the story's own path is the one graphic line)

  /* ------------------------------------------------------------ depth: sparse small motes behind the focus
     plane (circle-of-confusion sizing), at most one very soft foreground disc tucked into the lower-left
     corner on wide screens, and a faint teal-indigo haze behind the planet's upper-left limb. Placed by
     layout() in screen terms with a parallax margin: never over the disc, the header band or the copy
     column. All camera-facing quads, so size never depends on the GPU's point-size limit. */
  const NB = HI ? 16 : 10;
  const bokehGeo = (() => {
    const n = NB + 1; // + haze
    const g = new THREE.BufferGeometry();
    const corner = new Float32Array(n * 8), center = new Float32Array(n * 12), data = new Float32Array(n * 16), col = new Float32Array(n * 12);
    const idx = [];
    for (let i = 0; i < n; i++) {
      corner.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
      const b = i * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    g.setAttribute('position', new THREE.BufferAttribute(center, 3));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('aData', new THREE.BufferAttribute(data, 4));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    return keepG(g);
  })();
  const bokehMat = keepM(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uRes: S.uRes, uTime: S.uTime, uFocus: { value: 14.5 }, uCoC: { value: 1500 }, uPR: PR, uOn: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec2 aCorner; attribute vec4 aData; attribute vec3 aColor;   // aData: alpha, size, seed, kind
      uniform vec2 uRes; uniform float uTime, uFocus, uCoC, uPR;
      varying vec2 vC; varying vec3 vCol; varying float vA, vSoft, vKind;
      void main(){
        vec3 p = position;
        if ( aData.w < 1.5 ) p += vec3( sin( uTime * 0.05 + aData.z * 40.0 ), cos( uTime * 0.04 + aData.z * 23.0 ), 0.0 ) * 0.1;
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        float z = max( -mv.z, 0.5 );
        float worldPerPx = 2.0 * z / ( projectionMatrix[ 1 ][ 1 ] * uRes.y );
        float coc = abs( 1.0 / z - 1.0 / uFocus ) * uCoC * aData.y * uPR;
        float sizePx = clamp( coc, 2.2 * uPR, 520.0 * uPR );
        float hs = aData.w > 1.5 ? aData.y : sizePx * 0.5 * worldPerPx;
        mv.xy += aCorner * hs;
        gl_Position = projectionMatrix * mv;
        vC = aCorner; vCol = aColor; vKind = aData.w;
        vSoft = clamp( ( sizePx / uPR - 3.0 ) / 60.0, 0.0, 1.0 );
        float twinkle = 0.85 + 0.15 * sin( uTime * 0.5 + aData.z * 30.0 );
        vA = aData.x * ( aData.w > 0.5 ? 1.0 : twinkle );
      }`,
    fragmentShader: /* glsl */`
      uniform float uOn;
      varying vec2 vC; varying vec3 vCol; varying float vA, vSoft, vKind;
      void main(){
        float r = length( vC ); if ( r > 1.0 ) discard;
        float k;
        if ( vKind > 1.5 ) { k = exp( -r * r * 3.2 ) * ( 1.0 - r * r ); }          // haze
        else {
          float edge = mix( 0.35, 0.75, vSoft );
          float disc = smoothstep( 1.0, 1.0 - edge, r );
          float rim = smoothstep( 0.5, 0.92, r ) * disc * vSoft * 0.3;            // faint lens rim
          k = disc * 0.85 + rim;
        }
        gl_FragColor = vec4( vCol * k * vA * uOn, 1.0 );
      }`,
  }));
  const bokeh = new THREE.Mesh(bokehGeo, bokehMat);
  bokeh.frustumCulled = false; bokeh.renderOrder = 7; bokeh.name = 'depthBokeh';
  group.add(bokeh);


  /* ------------------------------------------------------------ the story: what a DNS service actually does,
     for everyone at once. Facts from the owner: Shelter is DNS only, its DNS servers are in Tehran, and
     thousands of gamers all over Iran use them. So: gamers in every city ask Shelter's servers in Tehran for
     their game server's address (control plane, dashed), get the answer back, and then each one talks to its
     game server abroad DIRECTLY (data plane, solid, both ways); the DNS exchange is no longer in the path.
     Each act is ONE draw: every line of the act lives in a merged ribbon with a per-line delay and phase, and
     the shader draws / animates them (staggered reveal, head glow, endless two-way flow). */
  spin.children.forEach((o) => { if (/^(route|routeShadow|cometHeads|ripple|pins)$/.test(o.name) || /^route/.test(o.name)) o.visible = false; });
  const TEH = { lat: HOME.lat, lon: HOME.lon };   // (the hub)
  // where the labs are (European research and industry cities; each also seeds a cloud of lab dots)
  const USERS = [[51.92, 4.48], [50.85, 4.35], [51.22, 4.4], [48.86, 2.35], [51.51, -0.13], [52.2, 0.12], [51.75, -1.26], [50.11, 8.68],
    [52.52, 13.4], [48.14, 11.58], [53.55, 9.99], [50.94, 6.96], [55.68, 12.57], [47.37, 8.54], [47.56, 7.59], [45.76, 4.84],
    [45.46, 9.19], [48.21, 16.37], [50.08, 14.44], [52.23, 21.01], [51.44, 5.48], [53.22, 6.57], [53.35, -6.26], [49.0, 8.4]]
    .filter(([la, lo]) => Math.hypot(la - HOME.lat, (lo - HOME.lon) * 0.62) > 0.4);
  const dir = (lat, lon) => ll(lat, lon, 1).normalize();
  const tDir = dir(TEH.lat, TEH.lon);
  const slerpDir = (a, b, t) => { const w = a.angleTo(b); if (w < 1e-5) return a.clone(); return a.clone().multiplyScalar(Math.sin((1 - t) * w) / Math.sin(w)).addScaledVector(b, Math.sin(t * w) / Math.sin(w)).normalize(); };
  const arc = (a, b, lift, lane = 0, n = 48) => {
    const side = new THREE.Vector3().crossVectors(a, b).normalize();
    return Array.from({ length: n + 1 }, (_, i) => { const t = i / n; return slerpDir(a, b, t).addScaledVector(side, lane * Math.sin(Math.PI * t)).normalize().multiplyScalar(GR * (1.004 + lift * Math.sin(Math.PI * t))); });
  };
  // merged ribbons: lineGeometry per curve, concatenated, plus per-line aDelay / aPhase
  const mergeLines = (curves) => {
    const parts = curves.map((c) => lineGeometry(c.pts));
    const n = parts.reduce((k, g) => k + g.attributes.position.count, 0);
    const out = new THREE.BufferGeometry(); const idx = []; let base = 0;
    const cat = (name, size) => { const arr = new Float32Array(n * size); let o = 0; for (const g of parts) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; } out.setAttribute(name, new THREE.BufferAttribute(arr, size)); };
    cat('position', 3); cat('aPrev', 3); cat('aNext', 3); cat('aSide', 1); cat('aU', 1);
    const dl = new Float32Array(n), ph = new Float32Array(n); let o = 0;
    parts.forEach((g, k) => { const c = g.attributes.position.count; dl.fill(curves[k].delay, o, o + c); ph.fill(curves[k].phase, o, o + c); for (let i = 0; i < g.index.count; i++) idx.push(g.index.array[i] + base); base += c; o += c; g.dispose(); });
    out.setAttribute('aDelay', new THREE.BufferAttribute(dl, 1)); out.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    out.setIndex(idx); out.computeBoundingSphere();
    return keepG(out);
  };
  const flowMat = (base, hot, width, dash, alpha) => keepM(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uRes: S.uRes, uWidth: { value: width }, uDash: { value: dash }, uProg: { value: 0 }, uSpread: { value: 0.55 }, uLoop: { value: 0 }, uTime: S.uTime,
      uBase: { value: new THREE.Color(base) }, uHot: { value: new THREE.Color(hot).multiplyScalar(2.3) }, uA: { value: alpha }, uFade: S.uFade, uLt: S.uLt, uHub: { value: tDir.clone().multiplyScalar(GR * 1.004) }, uPR: PR },
    vertexShader: LINE_VS.replace('varying float vU;', 'attribute float aDelay, aPhase; uniform vec3 uHub; varying float vDelay, vPhase, vHub; varying float vU;')
      .replace('gl_Position = c;', 'gl_Position = c; vDelay = aDelay; vPhase = aPhase; vec4 hq = mvp * vec4( uHub, 1.0 ); vHub = length( ( c.xy / c.w - hq.xy / hq.w ) * 0.5 * uRes );'),
    fragmentShader: /* glsl */`
      uniform float uWidth, uDash, uProg, uSpread, uLoop, uTime, uA, uFade, uLt, uPR; uniform vec3 uBase, uHot;
      varying float vU, vSide, vDelay, vPhase, vHub;
      ${cov}
      void main(){
        float p = clamp( ( uProg - vDelay * uSpread ) / ( 1.0 - uSpread ), 0.0, 1.0 );   // this line's own progress
        if ( vU > p ) discard;
        float head = p < 1.0 ? p : -1.0; float hw = p > 0.0 && p < 1.0 ? 1.0 : 0.0;
        if ( uLoop > 0.0 ) { head = fract( uTime * 0.45 + vPhase ); hw = uLoop; }
        float behind = head - vU;
        float tail = behind >= 0.0 ? exp( -behind * 7.0 ) * hw : 0.0;
        float hot = behind >= 0.0 ? exp( -behind * 60.0 ) * hw : 0.0;
        if ( uDash > 0.0 && fract( vU * uDash ) > 0.55 && hot < 0.5 ) discard;
        vec3 col = mix( uBase, uHot, hot ) * ( uLt > 0.5 ? 1.0 : 1.0 + tail * 0.6 );
        float a = coverage( uWidth + hot * 1.2 ) * max( uA, max( tail * 0.9, hot ) );
        if ( uLt > 0.5 ) a *= smoothstep( 7.0 * uPR, 15.0 * uPR, vHub );   // (daylight: out of the hub's ring, not into a knot)
        gl_FragColor = vec4( col, a * uFade );
      }`,
  }));
  const rnd = (() => { let z = 7; return () => ((z = (z * 16807) % 2147483647) / 2147483647); })();
  const acts = [
    { curves: USERS.map(([la, lo]) => ({ pts: arc(dir(la, lo), tDir, 0.012 + 0.01 * rnd()), delay: rnd(), phase: rnd() })), base: 0xa4e335, hot: 0xffffff, w: 1.1, dash: 7, a: 0.32 },          // the labs' requests -> the hub
    { curves: POPS.flatMap((q) => [0, 1].map((j) => ({ pts: arc(tDir, dir(q.lat, q.lon), 0.04 + 0.03 * rnd(), j ? 0.012 : 0, 64), delay: rnd(), phase: rnd() }))), base: 0x2fd6c3, hot: 0xe6fffb, w: 1.1, dash: 7, a: 0.32 },   // sourcing: the hub asks its lanes
    { curves: POPS.flatMap((q) => [0, 1].map((j) => ({ pts: arc(dir(q.lat, q.lon), tDir, 0.06 + 0.04 * rnd(), j ? -0.014 : 0.006, 64), delay: rnd(), phase: rnd() }))), base: 0xa4e335, hot: 0xffffff, w: 1.25, dash: 0, a: 0.22 },   // offers / instruments in
    { curves: USERS.map(([la, lo]) => ({ pts: arc(tDir, dir(la, lo), 0.03 + 0.02 * rnd(), 0.01), delay: rnd(), phase: rnd() })), base: 0x2fd6c3, hot: 0xe6fffb, w: 1.25, dash: 0, a: 0.22 }, // delivery to the labs
  ].map((A, i) => {
    const mat = flowMat(A.base, A.hot, A.w, A.dash, A.a);
    const mesh = new THREE.Mesh(mergeLines(A.curves), mat); mesh.renderOrder = 5; mesh.frustumCulled = false; mesh.name = `storyAct${i}`;
    spin.add(mesh); return { mat };
  });
  // thousands of gamers: a cloud of tiny dots around every city (weighted toward the big ones)
  const DOTS = HI ? 420 : 240;
  const dGeo = mkPoints(DOTS);
  const dcol = new THREE.Color(0xe4f9c0).multiplyScalar(1.5);
  for (let i = 0; i < DOTS; i++) {
    const c = USERS[Math.floor(Math.pow(rnd(), 1.6) * USERS.length)];
    const g = () => (rnd() + rnd() + rnd() - 1.5) * 0.8;
    ll(c[0] + g(), c[1] + g() * 1.2, GR * 1.004).toArray(dGeo.attributes.position.array, i * 3);
    dGeo.attributes.aSize.array[i] = 3.2 + rnd() * 2.8; (rnd() < 0.3 ? new THREE.Color(0x5fe3cf).multiplyScalar(1.4) : dcol).toArray(dGeo.attributes.aColor.array, i * 3);
  }
  const dots = new THREE.Points(dGeo, ptMat); dots.renderOrder = 6; dots.frustumCulled = false; dots.name = 'storyGamers'; spin.add(dots);
  const dA = dGeo.attributes.aAlpha.array; const dSeed = Float32Array.from({ length: DOTS }, () => rnd());
  // the hub (a small cluster) and the supply lanes
  const sGeo = mkPoints(3 + POPS.length);
  [[0, 0], [0.12, 0.1], [-0.1, 0.12]].forEach(([dy, dx], i) => { ll(TEH.lat + dy, TEH.lon + dx, GR * 1.005).toArray(sGeo.attributes.position.array, i * 3); sGeo.attributes.aSize.array[i] = i ? 6 : 9; new THREE.Color(0xa4e335).lerp(new THREE.Color(0xffffff), 0.35).multiplyScalar(2.1).toArray(sGeo.attributes.aColor.array, i * 3); });
  POPS.forEach((q, k) => { ll(q.lat, q.lon, GR * 1.004).toArray(sGeo.attributes.position.array, (3 + k) * 3); sGeo.attributes.aSize.array[3 + k] = 7; new THREE.Color(0x7ff0e0).multiplyScalar(1.6).toArray(sGeo.attributes.aColor.array, (3 + k) * 3); });
  const sPts = new THREE.Points(sGeo, ptMat); sPts.renderOrder = 6; sPts.frustumCulled = false; sPts.name = 'storyNodes'; spin.add(sPts);
  const sA = sGeo.attributes.aAlpha.array;
  // pulse rings: the Tehran cluster and each POP
  const ringPos = [tDir, ...POPS.map((q) => dir(q.lat, q.lon))].map((d) => d.clone().multiplyScalar(GR * 1.004));
  const rGeo = new THREE.BufferGeometry();
  rGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ringPos.flatMap((v) => v.toArray())), 3));
  rGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array([0.72, 1.0, 0.35, ...POPS.flatMap(() => [0.4, 0.95, 0.85])]), 3));
  rGeo.setAttribute('aP', new THREE.BufferAttribute(new Float32Array(ringPos.length).fill(-1), 1));
  rGeo.setAttribute('aW', new THREE.BufferAttribute(new Float32Array(ringPos.length), 1));
  keepG(rGeo);
  const rings = new THREE.Points(rGeo, keepM(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPR: PR, uFade: S.uFade, ...LTU },
    vertexShader: /* glsl */`attribute vec3 aColor; attribute float aP, aW; uniform float uPR; varying vec3 vC; varying float vP, vW;
      void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); gl_PointSize = 58.0 * uPR; vC = aColor; vP = aP; vW = aW; }`,
    fragmentShader: /* glsl */`uniform float uFade, uLt; uniform vec3 uLViolet, uLTeal; varying vec3 vC; varying float vP, vW;
      void main(){ if ( vP < 0.0 || vW < 0.01 ) discard;
        float r = length( gl_PointCoord - 0.5 ) * 2.0; float e = 0.18 + 0.78 * ( 1.0 - pow( 1.0 - vP, 2.2 ) );
        float w = fwidth( r ) * 1.3; float ring = 1.0 - smoothstep( 0.0, w, abs( r - e ) );
        float a = smoothstep( 0.0, 0.1, vP ) * pow( 1.0 - vP, 1.3 ) * vW;
        if ( uLt > 0.5 ) { gl_FragColor = vec4( vC.g > vC.r ? uLTeal : uLViolet, min( 1.0, ring * a * uFade * 1.1 ) ); return; }
        gl_FragColor = vec4( vC * 1.6 * ring * a * uFade, 1.0 ); }`,
  })));
  rings.renderOrder = 6; rings.frustumCulled = false; rings.name = 'storyRings'; spin.add(rings);
  const rP = rGeo.attributes.aP.array, rW = rGeo.attributes.aW.array;
  const ringAt = (i, w, period, time, phase = 0) => { rW[i] = Math.min(1, w); rP[i] = w > 0.01 ? ((time + phase) / period) % 1 : -1; };
  // the host hangs the hub's chip here
  const shelterAnchor = new THREE.Object3D(); shelterAnchor.position.copy(tDir.clone().multiplyScalar(GR * 1.004)); shelterAnchor.name = 'shelterNode'; spin.add(shelterAnchor);
  // camera beats
  const F0 = [FACE.lat, FACE.lon];
  // (the beats: 0.12 at the hub, zoomed in on Europe; 0.18-0.36 the labs' requests; 0.4-0.56 the pull-back to the
  // world while the hub sources from its lanes (0.42-0.6); 0.62-0.76 the offers come in; 0.76-0.9 the deliveries go
  // out; from 0.9 offers and deliveries flow on. core.js lights the route's four steps on the same clock)
  const HUBF = [HOME.lat - 2.5, HOME.lon + 3];
  const FACE_K = [[0, F0], [0.12, HUBF], [0.4, HUBF], [0.56, F0]];
  const ZOOM_K = [[0, 1], [0.12, 1.9], [0.4, 1.9], [0.56, 1]];
  const ACT_T = [[0.18, 0.36], [0.42, 0.6], [0.62, 0.76], [0.76, 0.9]];
  const KF = (keys, x) => {
    if (x <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (x <= keys[i][0]) {
      const [x0, a] = keys[i - 1], [x1, b] = keys[i]; const t = (x - x0) / Math.max(1e-6, x1 - x0); const e = t * t * (3 - 2 * t);
      return Array.isArray(a) ? a.map((v, k) => v + (b[k] - v) * e) : a + (b - a) * e;
    }
    return keys[keys.length - 1][1];
  };
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const bump = (x, c, w) => Math.exp(-((x - c) / w) * ((x - c) / w));
  const storyOut = { zoom: 1, node: 0 };
  function updateStory(st, time) {
    const live = !reduced;
    const face = live ? KF(FACE_K, st) : F0;
    const hv2 = ll(face[0], face[1], 1).normalize();
    storyYaw = -Math.atan2(hv2.x, hv2.z); tilt.rotation.x = Math.asin(hv2.y);
    storyOut.zoom = live ? KF(ZOOM_K, st) : 1;
    storyOut.node = sm(0.1, 0.16, st);
    const loop = live ? sm(0.9, 0.94, st) : 0;
    acts.forEach((A, i) => {
      const [a, b] = ACT_T[i]; const u = A.mat.uniforms;
      u.uProg.value = Math.min(1, Math.max(0, (st - a) / (b - a)));
      u.uLoop.value = i >= 2 ? loop : 0;
    });
    // the requests and the sourcing step back once the instruments are moving
    const dnsDim = 1 - 0.55 * sm(0.66, 0.8, st);
    acts[0].mat.uniforms.uA.value = 0.45 * dnsDim * inkK; acts[1].mat.uniforms.uA.value = 0.45 * dnsDim * inkK;
    // the labs twinkle in as the camera arrives
    const g = sm(0.06, 0.16, st);
    for (let i = 0; i < DOTS; i++) dA[i] = g * (0.55 + 0.45 * Math.sin(time * 1.3 + dSeed[i] * 40));
    dGeo.attributes.aAlpha.needsUpdate = true;
    sA[0] = sA[1] = sA[2] = Math.max(0.35, storyOut.node);
    for (let k = 0; k < POPS.length; k++) sA[3 + k] = 0.35 + 0.65 * sm(0.44, 0.54, st);
    sGeo.attributes.aAlpha.needsUpdate = true;
    ringAt(0, storyOut.node * (0.35 + 0.65 * (bump(st, 0.38, 0.04) + bump(st, 0.76, 0.04) + sm(0.18, 0.28, st) * (1 - sm(0.4, 0.46, st)))), 1.1, time);
    for (let k = 0; k < POPS.length; k++) ringAt(1 + k, sm(0.5, 0.6, st) * (0.35 + 0.65 * Math.max(loop, bump(st, 0.6, 0.05))), 1.7, time, k * 0.4);
    rGeo.attributes.aP.needsUpdate = true; rGeo.attributes.aW.needsUpdate = true;
    storyLabels[0].state.a = sm(0.1, 0.18, st) * (1 - 0.6 * sm(0.42, 0.52, st));
    for (let k = 0; k < POPS.length; k++) storyLabels[1 + k].state.a = sm(0.46, 0.56, st);
    return storyOut;
  }
  let storyYaw = baseYaw;

  /* ------------------------------------------------------------ labels (projected by the host) */
  const mkLabel = (text, pos, lead, prio, home = false, fa = true) => {
    const o = new THREE.Object3D(); o.position.copy(pos); spin.add(o);
    return { text, object: o, home, fa, side: lead[0] < 0 ? 'l' : 'r', prio, lead, state: { a: 0 } };
  };
  const storyLabels = [
    mkLabel(String(texts.labs || 'Labs across Europe').slice(0, 40), ll(47.2, 11.5, GR * 1.004), [26, 34], 0, true, false),   // hangs right-down, over the Alps
    ...POPS.map((q, k) => mkLabel(q.label, ll(q.lat, q.lon, GR * 1.004), q.lead, 1 + k, false, false)),
  ];
  const labels = storyLabels;

  /* ------------------------------------------------------------ layout (host calls after placing the parent) */
  const _w = new THREE.Vector3(), _d = new THREE.Vector3(), _cen = new THREE.Vector3(), _ndc = new THREE.Vector3();
  function layout({ camera, portrait = false } = {}) {
    S.uLimbFade.value = portrait ? 1 : 0;
    ringMesh.scale.setScalar(portrait ? 1.08 / RING_K : 1);
    if (portrait) ringHolder.rotation.set(1.28, 0, -0.3); else ringHolder.rotation.set(...GLOBE_RING_TILT);
    if (!camera) return;
    camera.updateMatrixWorld(); group.updateWorldMatrix(true, false);
    const aspect = camera.aspect || 1.6;
    // where the planet sits on screen, so nothing lands on the disc
    _cen.setFromMatrixPosition(group.matrixWorld);
    const dist = _cen.distanceTo(camera.position);
    const scale = group.matrixWorld.getMaxScaleOnAxis();
    _ndc.copy(_cen).project(camera);
    const rad = Math.tan(Math.asin(Math.min(0.99, (GR * scale) / dist))) / Math.tan((camera.fov * DEG) / 2); // ndc-y radius
    bokehMat.uniforms.uFocus.value = dist;
    let s = 4242;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const lil = new THREE.Color(LILAC).multiplyScalar(0.8), teal = new THREE.Color(0x5eead4);
    // where a quad may sit: off the disc (+ its own radius + a parallax margin), out of the header band
    // and out of the copy column (desktop: right half; portrait: below the planet)
    const free = (x, y, r = 0, margin = 0) => {
      if (y + r > 0.7) return false;
      if (!portrait && x - r / aspect < 0.04) return false;
      if (portrait && y - r < -0.1) return false;
      return Math.hypot((x - _ndc.x) * aspect, y - _ndc.y) > rad * 1.1 + r + margin;
    };
    // the one foreground disc: lower-left corner, very low alpha, only where it clears everything
    // (ndc x, ndc y, distance from camera, size, alpha); none on portrait (no room that isn't copy)
    const BIG = portrait ? [] : [[1.0, -0.86, 4.6, 0.8, 0.1]];
    const posA = bokehGeo.attributes.position.array, dataA = bokehGeo.attributes.aData.array, colA = bokehGeo.attributes.aColor.array;
    dataA.fill(0); // unused slots stay invisible (alpha 0)
    const put = (i, wx, wy, wz, alpha, size, kind, c) => {
      _w.set(wx, wy, wz); group.worldToLocal(_w);
      const seed = rnd(); // one per quad, or the corners drift apart
      for (let v = 0; v < 4; v++) {
        posA.set([_w.x, _w.y, _w.z], (i * 4 + v) * 3);
        dataA.set([alpha, size, seed, kind], (i * 4 + v) * 4);
        c.toArray(colA, (i * 4 + v) * 3);
      }
    };
    const toWorld = (x, y, d) => { _d.set(x, y, 0.5).unproject(camera).sub(camera.position).normalize(); return _w.copy(camera.position).addScaledVector(_d, d).clone(); };
    const vh = renderer ? renderer.getDrawingBufferSize(res).y / renderer.getPixelRatio() : 860;
    let i = 0;
    for (const [x, y, d, sz, a] of BIG) {
      // CoC diameter (CSS px, as in the shader) -> ndc-y radius; the pointer sway moves a quad 4-5 units
      // from the camera by up to ~0.25 ndc, hence the margin
      const r = (Math.abs(1 / d - 1 / dist) * bokehMat.uniforms.uCoC.value * sz) / vh;
      if (!free(x, y, r, 0.25)) continue;
      const p = toWorld(x, y, d); put(i++, p.x, p.y, p.z, a, sz, 1, lil);
    }
    // small motes behind the focus plane, off the disc, the header and the copy side
    let guard = 0;
    while (i < NB && guard++ < 900) {
      const x = portrait ? rnd() * 2 - 1 : 0.02 + rnd() * 0.98;
      const y = portrait ? 0.08 + rnd() * 0.9 : rnd() * 2 - 1;
      if (!free(x, y, 0.02, 0.04)) continue;
      const p = toWorld(x, y, dist + 3 + rnd() * 9);
      put(i++, p.x, p.y, p.z, 0.06 + rnd() * 0.1, 0.09 + rnd() * 0.1, 0, rnd() < 0.75 ? lil : teal);
    }
    // haze: behind the planet, upper-left of it
    const hp = toWorld(_ndc.x + rad * (portrait ? 0.2 : 0.55) / aspect * 1.6, _ndc.y + rad * (portrait ? 0.35 : 0.5), dist + 9);
    put(NB, hp.x, hp.y, hp.z, portrait ? 0.16 : 0.2, portrait ? 9 : 14, 2, new THREE.Color(0x1f8f80).lerp(new THREE.Color(0x2f5a12), 0.45));
    bokehGeo.attributes.position.needsUpdate = true;
    bokehGeo.attributes.aData.needsUpdate = true;
    bokehGeo.attributes.aColor.needsUpdate = true;
    bokehGeo.computeBoundingSphere();
  }

  /* ------------------------------------------------------------ update */
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const headPos = headGeo.attributes.position.array, headAlpha = headGeo.attributes.aAlpha.array;
  const pinAlpha = pinGeo.attributes.aAlpha.array;
  const tmpV = new THREE.Vector3();
  let px = 0, py = 0;
  /* update(dt, time, mouse, draw, { fade, park })
     draw: scroll-driven reveal (routes, ring); fade: appear ramp when the globe arrives on screen;
     park: 1 while the camera rests at the route station (the depth quads sit a few units from the
     camera and would sweep across the frame during the fly-through, so they only live while parked). */
  function update(dt = 0.016, time = 0, mouse = { x: 0, y: 0 }, draw = 1, { fade = 1, park = 1, story = 0 } = {}) {
    if (renderer) { renderer.getDrawingBufferSize(res); PR.value = renderer.getPixelRatio(); }
    borderMat.uniforms.uWidth.value = 0.9 * PR.value;
    // reduced motion: nothing travels or pulses. Bokeh drift / twinkle and the ring glint read uTime.
    S.uTime.value = reduced ? 0 : time;
    S.uFade.value = Math.min(1, Math.max(0, fade));
    const k = 1 - Math.exp(-(dt || 0.016) * 2.5);
    px += ((mouse?.x || 0) - px) * k; py += ((mouse?.y || 0) - py) * k;
    pivot.rotation.y = px * 2 * DEG;
    pivot.rotation.x = -py * 2 * DEG;
    const sway = reduced ? 0 : Math.sin((time * 2 * Math.PI) / 40) * 5 * DEG;
    const so = updateStory(Math.min(1, Math.max(0, story)), reduced ? 0 : time, dt);
    const zoomed = Math.min(1, Math.max(0, (so.zoom - 1) / 0.3));
    spin.rotation.y = storyYaw + sway * (1 - zoomed);
    clouds.rotation.y = reduced ? 0 : sway * 0.15 + time * 0.0015;
    ringMat.uniforms.uOn.value = Math.min(1, Math.max(0, (draw - 0.3) / 0.5));
    bokehMat.uniforms.uOn.value = Math.min(1, draw * 1.6) * Math.min(1, Math.max(0, park)) * S.uFade.value * (1 - zoomed) * (S.uLt.value > 0.5 ? 0 : 1);   // daylight: no lens motes
    bokeh.visible = bokehMat.uniforms.uOn.value > 0.002;   // the haze quad is ~2.5k px across: skip it when it shows nothing
    // (lab2date: the planet stays in the transparent pass: flipping the flag per frame made a second program, compiled
    // synchronously on the route when the fade-in ended. At alpha 1 the result is the same)
    pinAlpha[5] = (reduced ? 0.7 : 0.55 + 0.25 * Math.sin(time * 1.9)) * Math.min(1, draw * 1.5);
    pinGeo.attributes.aAlpha.needsUpdate = true;

    routes.forEach((r, i) => {
      const dr = Math.min(1, Math.max(0, draw * 1.3 - i * 0.05));
      r.mat.uniforms.uDraw.value = dr;
      const live = dr > 0.999 && !reduced; // reduced motion: routes drawn statically, no comets or ripples
      const f = ((((time - r.slot * STEP) % SEQ) + SEQ) % SEQ); // seconds since this route's launch
      if (live && f < TRAVEL) {
        const t = ease(f / TRAVEL);
        const fadeIn = Math.min(1, f / 0.12);
        r.mat.uniforms.uHead.value = t;
        r.mat.uniforms.uHeadA.value = fadeIn;
        const fi = t * (r.pts.length - 1); const i0 = Math.floor(fi); const i1 = Math.min(r.pts.length - 1, i0 + 1);
        tmpV.copy(r.pts[i0]).lerp(r.pts[i1], fi - i0).toArray(headPos, i * 3);
        headAlpha[i] = fadeIn * (1 - 0.6 * Math.max(0, (f / TRAVEL - 0.9) / 0.1));
        r.ripple.uniforms.uP.value = -1;
      } else {
        const after = f - TRAVEL;
        r.mat.uniforms.uHead.value = live ? 1 + after * 2.2 : -1;
        r.mat.uniforms.uHeadA.value = live ? Math.max(0, 1 - after * 5) : 0;
        headAlpha[i] = 0;
        r.ripple.uniforms.uP.value = live && after < RIPPLE ? after / RIPPLE : -1;
      }
    });
    headGeo.attributes.position.needsUpdate = true;
    headGeo.attributes.aAlpha.needsUpdate = true;
    return so;
  }

  function dispose() {
    disposed = true;
    group.removeFromParent();
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    freeTextures();
    planet.onBeforeRender = () => {};
  }

  /* daylight's own assets (globe_light_assets.py): the atlas (global, and the route's box at the 4096 map's resolution)
     and the land borders round the region. Fetched the first time the page is in daylight (never at night). At creation
     (the page already in daylight) the host uploads them with the rest (textures); fetched later (a switch), they are
     uploaded at once and switched on. Until then the daylight planet draws from the pack's land mask */
  let ltLoad = null, borders = null, disposed = false;
  const borderMat = keepM(new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uRes: S.uRes, uWidth: { value: 0.9 }, uColor: { value: new THREE.Color(0x0e4f40) }, uAlpha: { value: 0.3 }, uFade: S.uFade },
    vertexShader: LINE_VS, fragmentShader: outlineMat.fragmentShader,
  }));
  const mergePlain = (parts) => {
    const n = parts.reduce((k, g) => k + g.attributes.position.count, 0);
    const out = new THREE.BufferGeometry(); const idx = []; let base = 0;
    for (const [name, size] of [['position', 3], ['aPrev', 3], ['aNext', 3], ['aSide', 1], ['aU', 1]]) {
      const arr = new Float32Array(n * size); let o = 0;
      for (const g of parts) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
      out.setAttribute(name, new THREE.BufferAttribute(arr, size));
    }
    for (const g of parts) { for (let i = 0; i < g.index.count; i++) idx.push(g.index.array[i] + base); base += g.attributes.position.count; g.dispose(); }
    out.setIndex(idx); out.computeBoundingSphere();
    return keepG(out);
  };
  function loadLight(upload) {
    if (ltLoad || !files.atlas) return ltLoad || Promise.resolve();
    ltLoad = (async () => {
      const [aT, rT, bj] = await Promise.all([
        tex(files.atlas, false),
        files.atlasRegion && files.atlasBox ? tex(files.atlasRegion, false, false).catch(() => null) : null,
        files.borders ? fetcher(files.borders).then((r) => (r.ok ? r.json() : null)).catch(() => null) : null,
      ]);
      if (disposed) { freeTex(aT); freeTex(rT); return; }
      if (upload && renderer) { renderer.initTexture(aT); if (rT) renderer.initTexture(rT); }
      G.uAtlas.value = aT;
      if (rT) { const [lo0, lo1, la0, la1] = files.atlasBox; G.uAtlasR.value = rT; G.uAtlasBox.value.set((lo0 + 180) / 360, (90 - la1) / 180, (lo1 - lo0) / 360, (la1 - la0) / 180); }
      G.uAtlasOn.value = 1;
      if (bj && Array.isArray(bj.lines)) {
        const parts = bj.lines.filter((l) => l.length > 1).map((l) => lineGeometry(l.map(([lon, lat]) => ll(lat, lon, GR * 1.0012))));
        if (parts.length) {
          borders = new THREE.Mesh(mergePlain(parts), borderMat);
          borders.renderOrder = 3; borders.frustumCulled = false; borders.name = 'borders'; borders.visible = S.uLt.value > 0.5;
          spin.add(borders);
        }
      }
    })().catch((e) => console.warn('route globe: the daylight atlas is unavailable', e));
    return ltLoad;
  }
  if (light) await loadLight(false);

  /* the page's theme: daylight lays the globe's ink over the paper (normal blending) where the night adds light. Only
     uniforms, colours and blend states change: nothing is recompiled */
  const NIGHT = { iran: outlineMat.uniforms.uColor.value.clone(), iranA: outlineMat.uniforms.uAlpha.value, iranW: outlineMat.uniforms.uWidth.value,
    acts: acts.map((A) => ({ base: A.mat.uniforms.uBase.value.clone(), hot: A.mat.uniforms.uHot.value.clone(), a: A.mat.uniforms.uA.value })) };
  // (daylight: the queries and the traffic out in violet with a cyan head, the answers and the traffic back in azure with a rose head)
  const ACT_INK = [[0x2f6a12, 0x14b8a6], [0x0b6b5e, 0x5fae1a], [0x3f7f0e, 0x14b8a6], [0x0b6b5e, 0x5fae1a]];
  let inkK = 1;   // the DNS exchange's lines: a touch stronger as ink on paper (updateStory)
  function setTheme(light) {
    const lt = !!light; S.uLt.value = lt ? 1 : 0; inkK = lt ? 1.45 : 1;
    if (lt) loadLight(true);
    if (borders) borders.visible = lt;
    S.uLShell.value = lt ? 1.1 : 1.04; atmosphere.scale.setScalar(S.uLShell.value / 1.04);   // (daylight: room for the film's halo)
    if (lt) outlineMat.uniforms.uColor.value.set(0x2f6a12); else outlineMat.uniforms.uColor.value.copy(NIGHT.iran);
    outlineMat.uniforms.uAlpha.value = lt ? 0.85 : NIGHT.iranA; outlineMat.uniforms.uWidth.value = lt ? 1.6 : NIGHT.iranW;   // daylight: Iran's violet contour
    acts.forEach((A, i) => {
      const u = A.mat.uniforms;
      if (lt) { u.uBase.value.set(ACT_INK[i][0]); u.uHot.value.set(ACT_INK[i][1]); if (i >= 2) u.uA.value = NIGHT.acts[i].a * 1.6; }
      else { u.uBase.value.copy(NIGHT.acts[i].base); u.uHot.value.copy(NIGHT.acts[i].hot); if (i >= 2) u.uA.value = NIGHT.acts[i].a; }
    });
    for (const m of [ptMat, rings.material]) m.blending = lt ? THREE.NormalBlending : THREE.AdditiveBlending;
  }
  update(0, 0, { x: 0, y: 0 }, 0, { story: 0 });
  group.userData.tune = { S, G, cloudMat, atmMat, outlineMat, planetMat, ringMat, bokehMat, routes, shadowMats, SUN_LOCAL };
  return { group, update, layout, labels, textures, dispose, setTheme, ringK: RING_K, radius: GR, regional: region, anchors: { shelter: shelterAnchor } };
}
