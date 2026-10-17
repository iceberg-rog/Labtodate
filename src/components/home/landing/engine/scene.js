import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { NOISE } from './noise.glsl.js';
import { createGlobe, GLOBE_RADIUS, GLOBE_RING_K, GLOBE_RING_TILT } from './labglobe.js';
import {
  CFG, GAMES, $, $$, params, HERO, DEBUG, tune, reduced, PHONE_UA, clamp, smooth, easeIO, lerp, VW, VH, state, metrics, measure,
  computeScroll, updateDom, hooks, boot, endBoot, fullBoot, noGL, yieldNow, whenIdle, scrollNow, on, IDX, TEXT,
} from './core.js';
import { LOOK, LOOK_LIGHT, introLook, PAPER, themeLight, INTRO_BLOOM, introLayout, introShapes } from './intro.mjs';

/* ================================================================== WebGL
   lab2date port of the Shelter landing's scene (src/landing/scene.js): the same stations, camera rig, boot and theme
   machinery; the hero is the brand's chrome molecule in a storm of particle tracks, the instruments' column a chain of
   structural formulas, the route the supply lanes from the Netherlands. run() resolves to a handle the shell disposes
   on unmount (a Next.js route, not a page of its own): { dispose(), setWay(i) }.
   The landing's 3D scene. run() is called by the shell (src/main.js) once the first frame with the copy and the
   intro's poster (poster.js) has been painted. It builds the intro first (the poster's particles, the nebula and the
   post chain), shows it and hands the lockup over from the poster; then, in slices with yields between them while the
   intro runs, it builds and warms every other station (see "boot" at the end). Without a WebGL context the page stays
   in its DOM-only mode (noGL), with the poster.
   Two themes (html[data-theme], switchable at any time: see "theme" below). The night sky is the original; daylight
   (light, "Pearl Iridescent") draws the same scene on the page's warm pearl paper (intro.mjs PAPER, landing.css --bg):
   a paper sky with drifts of thin film (lilac, aqua, rose) and paper fog, the page's deep inks instead of light (normal
   compositing where light was added), pearl materials with a thin film and a spectral rim in a pearl studio, no tone
   mapping (the paper is the page's own colour) and hardly any bloom. Every theme switch only changes uniforms, blend states and the environment map (both are PMREM'd at the same
   size): nothing is ever recompiled but the two small output passes. */
let renderer;
export async function run() {
  await yieldNow();   // the module has just been evaluated (three.js): the renderer starts in a task of its own
  try {
    renderer = new THREE.WebGLRenderer({ canvas: $('#gl'), antialias: false, powerPreference: 'high-performance' });
    if (!renderer.getContext()) throw new Error('no ctx');
    renderer.debug.checkShaderErrors = DEBUG;   // (each check is a synchronous query of the GPU process; QA keeps them)
  } catch (e) {
    renderer = null; noGL(); return null;
  }
  let gone = false;   // disposed (the route unmounted): every async step of the boot checks it
  const ABORT = {};
  const live = () => !gone && !boot.disposed;
  const step = async () => { await yieldNow(); if (!live()) throw ABORT; };
  // the page's own fonts (next/font: the family names are generated)
  const cssVar = (n) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); } catch (e) { return ''; } };
  const SANS = (() => { try { return getComputedStyle(document.body).fontFamily || 'Inter, system-ui, sans-serif'; } catch (e) { return 'Inter, system-ui, sans-serif'; } })();
  const MONO = `${cssVar('--font-mono') || "'JetBrains Mono'"}, ui-monospace, Consolas, monospace`;
  const WORD = ((document.getElementById('poster') || {}).dataset || {}).word || 'Labtodate';
  const OUTRO_WORD = (TEXT && TEXT.outro) || (((document.querySelector('.play-word') || {}).dataset || {}).word) || 'SOURCED.';
  // asset URLs come from the page config (hashed files of the hosted build, data: URIs in the single file)
  const ASSET = (k, d) => (CFG.assets && CFG.assets[k]) || d;
  const markB = (n) => { try { performance.mark(`scene:${n}`); } catch (e) { /* old browsers */ } };
  markB('start');

  // the light tier is for phones and tablets: a touchscreen laptop (Surface: `pointer: coarse`, no hover) is a
  // desktop with a GPU and a touchpad and gets the full scene
  const mobile = VW() < 860 || PHONE_UA;
  /* Resolution follows a pixel budget per GPU class, not devicePixelRatio alone: a Surface (DPR 2, 1440x960
     CSS px) asked for 2520x1680 = 4.2 MP from an integrated GPU and ran at ~30 fps; on the same machine 1.3 MP
     runs at 90. The budget picks the starting DPR; the live governor below keeps adjusting it. */
  const GPU = (() => {
    try { const gl = renderer.getContext(); const ext = gl.getExtension('WEBGL_debug_renderer_info'); return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch (e) { return ''; }
  })();
  const STRONG = /nvidia|geforce|rtx|quadro|radeon (rx|pro)|apple m\d|apple gpu/i.test(GPU) && !/swiftshader|llvmpipe|basic render/i.test(GPU);
  /* the material tier. MeshPhysicalMaterial with iridescence + clearcoat + sheen (the night pearl) is the costliest
     program three has: on an integrated GPU under ANGLE / Direct3D 11 each variant takes seconds to translate and link,
     and its fragments are the heaviest on screen. Phones and integrated GPUs (Intel, AMD APUs, anything not STRONG) get
     the MeshStandardMaterial versions (the mobile tier's, same colours and env light), discrete GPUs the full pearl.
     ?lite / ?full3d override it for QA */
  const LITE = params.has('full3d') ? false : mobile || !STRONG || params.has('lite');
  const BUDGET = mobile ? 1.0e6 : STRONG ? 4.2e6 : 2.0e6;   // drawing-buffer pixels (raised once the scene got cheaper; the governor still steps down if a device can't hold it)
  // Quality headroom: the page starts at BUDGET, and a device that keeps a steady ~60 fps there is stepped up
  // by the governor toward this ceiling (a sharper scene on strong GPUs and high-DPI screens), never past it
  const BUDGET_UP = mobile ? (STRONG ? 1.6e6 : 1.25e6) : STRONG ? 8.3e6 : 3.0e6;
  const DPR_MAX = Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2);
  const DPR_UP = Math.min(devicePixelRatio || 1, mobile ? (STRONG ? 2 : 1.75) : 2);
  // the floors: a phone never draws below one buffer pixel per CSS pixel, a desktop never below 0.75 (under that the
  // picture turns visibly soft; the governor sheds the bloom first and keeps a step down only where it made frames faster)
  const DPR_MIN = mobile ? Math.min(1, devicePixelRatio || 1) : 0.75;
  const budgetDpr = () => clamp(Math.sqrt(BUDGET / (VW() * VH())), DPR_MIN, DPR_MAX);
  const ceilDpr = () => clamp(Math.sqrt(BUDGET_UP / (VW() * VH())), DPR_MIN, DPR_UP);
  const Q = {
    dpr: budgetDpr(),
    logo: mobile ? 9000 : 20000,
    packets: mobile ? 900 : 2200,
    dust: mobile ? 700 : 1600,
    oct: LITE ? 2 : 3,
  };

  renderer.setPixelRatio(Q.dpr);
  renderer.setSize(VW(), VH(), false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral keeps sRGB artwork (official game art) true to colour; only HDR (>1) emitters bloom
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  let LIGHT = themeLight();   // the page's theme (see "theme" below)
  const LOOKS = () => introLook(LIGHT);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, VW() / VH(), 0.1, 600);
  scene.fog = new THREE.FogExp2(0x02100e, 0.012);

  /* ---------- environment for chrome reflections
     Start with the procedural neon box (instant), then swap in a real studio HDRI: Poly Haven
     Ferndale Studio 12 (CC0), graded on brand and baked to an 8 KB 8-bit equirect by env_assets.py,
     decoded back to HDR on the GPU. Both are PMREM'd at the same 256 cube size, so the swap only
     changes a uniform and never recompiles a lit material. */
  const pmrem = new THREE.PMREMGenerator(renderer);
  // (the reflections' cube size. Every bake (PMREM: a 256-sample GGX filter over every mip) is ~1 s of GPU time on an
  // integrated GPU at 256, during which nothing else is drawn: 128 there, a quarter of the work; every bake of a session
  // uses the same size, so a swap of light never changes a program)
  const ENV_SIZE = LITE ? 128 : 256;
  // (on integrated GPUs every mip after the first is made by the spherical Gaussian blur chain three's PMREM used before
  // r170 (20 samples a texel) instead of the 256-sample GGX importance filter: ~1 s of GPU per bake down to a tenth.
  // At the chrome's low roughness the two read the same)
  if (LITE && typeof pmrem._blur === 'function' && Array.isArray(pmrem._sizeLods || [])) {
    const EXTRA = [0.125, 0.215, 0.35, 0.446, 0.526, 0.582];
    pmrem._applyPMREM = function (rt) {
      const r = this._renderer, ac = r.autoClear; r.autoClear = false;
      const n = this._lodMeshes.length, top = this._lodMax - 4;
      const sig = (i) => (i === 0 ? 0 : i > top ? EXTRA[Math.min(EXTRA.length - 1, i - top - 1)] : 1 / this._sizeLods[i]);
      for (let i = 1; i < n; i++) this._blur(rt, i - 1, i, Math.sqrt(Math.max(0, sig(i) * sig(i) - sig(i - 1) * sig(i - 1))));
      r.autoClear = ac;
    };
  }
  // brand practicals (soft violet/cyan/pink panels) that give the flat shield face its colour sweep
  const PANEL_K = tune('panels', 0.3);
  const SWEEP_K = tune('sweep', 0.5); // strip peak x envMapIntensity 1.7 stays under the bloom threshold (1.0)
  const SWEEP_Y = tune('sweepy', -0.4);
  const addPanels = (env, k) => {
    const panel = (c, i, x, y, z, w, h) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i * k), side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    };
    panel(0x84cc16, 4, -6, 3, 4, 6, 3);
    panel(0x2dd4bf, 3, 6, -1, 5, 3, 6);
    panel(0x0ea5a4, 2.5, 0, 6, -6, 8, 2);
    panel(0xffffff, 2, 2, 8, 2, 4, 1);
    panel(0x065f46, 2, -4, -6, -3, 8, 3);
  };
  const disposeScene = (env) => env.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  // the night light (the procedural one, then the studio) and the daylight studio are kept apart; the scene shows the
  // theme's (setEnv). Both are PMREM'd at the same 256 cube size: a switch changes a uniform, never a program
  let envDark = null, envLight = null, envOn = false;
  const setEnv = () => {
    if (!envOn) return;   // (from the boot's second part on: the intro has no lit material)
    if (LIGHT && !envLight) buildLightEnv();
    scene.environment = (LIGHT && envLight) || envDark;
  };
  const buildNeonEnv = () => {
    const env = new THREE.Scene(); const old = envDark;
    env.add(new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), new THREE.MeshBasicMaterial({ color: 0x03110e, side: THREE.BackSide })));
    addPanels(env, 1);
    envDark = pmrem.fromScene(env, 0.03, 0.1, 100, { size: ENV_SIZE }).texture; envOn = true; setEnv();
    disposeScene(env); if (old) old.dispose();
  };
  /* the daylight studio (pearl): a lilac-grey floor under a bright pearl room with a crisp horizon, a softbox strip just
     above it and two dark (indigo, not grey) strips higher up: what gives chrome its bands in daylight (a mirror of an
     even white room reads as plastic); the pearl's film as three coloured softboxes (violet, cyan, rose) round the
     subject: what the pearl's faces and edges pick up as spectral light. The floor is mid-tone, not dark: the occluded
     faces stay lilac instead of going muddy on the paper */
  function buildLightEnv() {
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: `varying vec3 vP;
        void main(){ vec3 d = normalize(vP); float y = d.y;
          vec3 c = mix(vec3(.5, .6, .55), vec3(1.0, 1.0, .97), smoothstep(-.08, -.01, y));    // the floor (sage grey) | the room
          c += vec3(1.95, 1.94, 2.02) * exp(-pow((y - .07) / .03, 2.));                          // a softbox strip
          c *= 1. - vec3(.8, .8, .7) * exp(-pow((y - .22) / .035, 2.)) - vec3(.52, .52, .44) * exp(-pow((y - .45) / .07, 2.)); // two indigo strips
          c += vec3(.44, .43, .48) * smoothstep(.6, 1., y);                                     // the top light
          gl_FragColor = vec4(c, 1.); }`,
    })));
    const panel = (c, i, x, y, z, w, h) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i), side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    };
    panel(0xc5ef7a, 0.95, -6, 3, 4, 6, 3);
    panel(0x8be8db, 0.85, 6, -1, 5, 3, 6);
    panel(0xd9f7b0, 0.75, 0, 6, -6, 8, 2);
    panel(0xfbfaf4, 2.4, 2, 8, 2, 4, 1);
    envLight = pmrem.fromScene(env, 0.02, 0.1, 100, { size: ENV_SIZE }).texture;
    disposeScene(env);
  }
  /* the daylight pearl's own studio (the games' column, the hero roof): what a pearl shows is what it
     reflects, and an even pearl room makes it milk. So: an indigo floor (#5b4fa0: deep enough to model the form, never
     the near-black that a grazing reflection would print as specks along a silhouette) rising through lilac walls to a
     pale sky, a soft horizon band, and the film as large FEATHERED softboxes round it (radial falloff, no hard edge to
     mirror as a seam): violet on the left, aqua on the right, rose behind and above, a white one high in front. The
     faces turn violet, teal and rose with their curvature in smooth nacre gradients. Same PMREM size as the scene's: a
     swap never recompiles */
  let envSpine = null;
  function buildSpineEnv() {
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: `varying vec3 vP;
        void main(){ vec3 d = normalize(vP); float y = d.y;
          vec3 c = mix(vec3(.04, .16, .13), vec3(.32, .55, .48), smoothstep(-.6, .05, y));   // the forest floor | sage walls
          c = mix(c, vec3(.86, .96, .9), smoothstep(.15, .85, y));                            // the pale sky
          c += vec3(.92, 1., .94) * exp(-pow((y - .1) / .08, 2.));                            // a soft horizon band
          gl_FragColor = vec4(c, 1.); }`,
    })));
    const soft = (c, i, x, y, z, w, h) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.ShaderMaterial({
        side: THREE.DoubleSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uC: { value: new THREE.Color(c).multiplyScalar(i) } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
        fragmentShader: 'uniform vec3 uC; varying vec2 vUv; void main(){ vec2 p = (vUv - .5) * 2.; float k = exp(-dot(p, p) * 2.6) * (1. - smoothstep(.75, 1., max(abs(p.x), abs(p.y)))); gl_FragColor = vec4(uC * k, 1.); }',
      }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
    };
    soft(0x8fd11f, 1.9, -7, 1, 2, 8, 11);
    soft(0x2fd6c3, 2.1, 7, 0, 2, 8, 11);
    soft(0xd4f56a, 2.3, 0, 4, -7, 13, 8);
    soft(0xffffff, 3.2, -2, 7, 4, 9, 3);
    envSpine = pmrem.fromScene(env, 0.02, 0.1, 100, { size: ENV_SIZE }).texture;
    disposeScene(env);
  }
  // (built only if the studio light below has not landed by the warm-up: it never costs a frame otherwise)
  const ENV_YAW = tune('envyaw', 2.1);
  const ENV_GAIN = tune('envgain', 1.0);
  const ENV_ROOM = tune('envroom', 0.05); // walls/floor crushed to 5 %: the chrome's dark bands stay dark
  const loadStudioTex = () => new THREE.TextureLoader().loadAsync(ASSET('env', '/home3d/env/studio_env_512.webp'));
  async function bakeStudioEnv(src) {
    // (each program of the bake is compiled in parallel first (KHR_parallel_shader_compile) into a render target of the
    // bake's own kind: the bake itself is then a few draws, not a stall of the main thread while the visitor moves)
    const race = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
    const tmp = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    const preCompile = (obj, cam) => { const prev0 = renderer.getRenderTarget(); renderer.setRenderTarget(tmp); const w = renderer.compileAsync(obj, cam); renderer.setRenderTarget(prev0); return race(w, 20000); };
    src.colorSpace = THREE.NoColorSpace; src.generateMipmaps = false; src.minFilter = THREE.LinearFilter;
    const rt = new THREE.WebGLRenderTarget(src.image.width, src.image.height, { type: THREE.HalfFloatType, depthBuffer: false });
    const quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { t: { value: src }, uGain: { value: ENV_GAIN }, uRoom: { value: ENV_ROOM } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
      // stored = (x / (1 + x)) ^ (1 / 2.2)  ->  x ; then crush the room, keep the practicals, cap the softbox
      fragmentShader: `uniform sampler2D t; uniform float uGain, uRoom; varying vec2 vUv;
        void main(){ vec3 y = pow(texture2D(t, vUv).rgb, vec3(2.2)); vec3 x = y / max(1. - y, 4e-3);
          float l = dot(x, vec3(.2126, .7152, .0722));
          x *= mix(uRoom, 1., smoothstep(1., 8., l));
          x *= min(1., 1.8 / max(l, 1e-4)); // softbox / tube peaks: small highlights may bloom, never a blown patch
          gl_FragColor = vec4(x * uGain, 1.); }`,
    }));
    await preCompile(quad._mesh, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    if (!live()) return;
    const prev = renderer.getRenderTarget();
    markB("bake:pre-quad"); renderer.setRenderTarget(rt); quad.render(renderer); renderer.setRenderTarget(prev); if (DEBUG && params.has('gpusync')) { renderer.getContext().finish(); } markB("bake:quad");
    quad.material.dispose(); quad.dispose(); src.dispose();
    const env = new THREE.Scene();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), new THREE.MeshBasicMaterial({ map: rt.texture, side: THREE.BackSide }));
    sky.rotation.y = ENV_YAW;
    env.add(sky);
    if (PANEL_K > 0) addPanels(env, PANEL_K);
    // a broad violet -> cyan soft light behind the viewer: what the shield's flat chrome band mirrors,
    // so the sway sweeps an iridescent gradient across it instead of a dark void
    if (SWEEP_K > 0) {
      const sweep = new THREE.Mesh(new THREE.PlaneGeometry(16, 9), new THREE.ShaderMaterial({
        side: THREE.DoubleSide, uniforms: { k: { value: SWEEP_K } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
        fragmentShader: `uniform float k; varying vec2 vUv;
          void main(){ vec2 p = vUv - .5; float soft = smoothstep(.5, .2, abs(p.x)) * smoothstep(.5, .3, abs(p.y));
            vec3 hue = mix(vec3(.55, .86, .2), vec3(.2, .84, .76), smoothstep(.2, .8, vUv.x));
            // studio strips: a crisp horizon line and two softer bars with dark gaps between them, so the
            // flat chrome band shows bright/dark bands that slide as the emblem sways (reads as chrome, not satin)
            // (no broad fill: between the strips the room stays black, which is what reads as chrome)
            float g = 0.;
            g += exp(-pow((p.y - .01) / .012, 2.)) * 1.1;
            g += exp(-pow((p.y + .11) / .03, 2.)) * .6;
            g += exp(-pow((p.y + .27) / .055, 2.)) * .3;
            vec3 c = mix(hue, vec3(1.), .3 * smoothstep(.5, 1.1, g)) * g;
            gl_FragColor = vec4(c * soft * k, 1.); }`,
      }));
      sweep.position.set(0, SWEEP_Y, 9); sweep.lookAt(0, 0, 0); env.add(sweep);
    }
    markB("bake:env-built"); await preCompile(env, new THREE.PerspectiveCamera(90, 1, 0.1, 100)); tmp.dispose(); markB("bake:env-compiled");
    if (!live()) return;
    const old = envDark;
    envDark = pmrem.fromScene(env, 0.02, 0.1, 100, { size: ENV_SIZE }).texture; if (DEBUG && params.has('gpusync')) { renderer.getContext().finish(); } markB("bake:pmrem"); envOn = true; setEnv();
    if (old) old.dispose();
    disposeScene(env); rt.dispose();
  }
  const loadStudioEnv = () => loadStudioTex().then(bakeStudioEnv);
  // the download starts now; the bake (PMREM: GPU work) waits until the intro is on screen (boot, part 2)
  const studioTex = DEBUG && params.has('neonenv') ? Promise.resolve(null) : loadStudioTex().catch((e) => { console.warn('studio env unavailable, keeping the procedural one', e); return null; });
  markB('env'); await yieldNow();   // the construction is cut into slices: input and paint get a turn between them
  on(renderer.domElement, 'webglcontextlost', () => document.documentElement.classList.add('gl-lost'));
  on(renderer.domElement, 'webglcontextrestored', () => {
    document.documentElement.classList.remove('gl-lost');
    envLight = null; envSpine = null; buildNeonEnv(); if (!(DEBUG && params.has('neonenv'))) loadStudioEnv().catch(() => {}); themeTower();
  });

  /* ---------- world layout (stations, y down) */
  const portrait = () => VW() / VH() < 0.9;
  const ST = [0, -45, -90, -135, -180, -225, -270];
  const stations = () => {
    const p = portrait();
    return [
      { pos: [0, 0, p ? 24 : 16], look: [0, 0, 0] },
      { pos: [0, ST[1], p ? 17 : 13], look: [0, ST[1] + (p ? -2.2 : 0), 0] },
      { pos: [0, ST[2] + (p ? 0.4 : 0.35), p ? 17.5 : 12.6], look: [0, ST[2] + (p ? -2.2 : 0), 0] },
      { pos: [0, ST[3], p ? 19 : 14.5], look: [0, ST[3] + (p ? -2.6 : 0), 0] },
      { pos: [0, ST[4], p ? 17 : 13.5], look: [0, ST[4] + (p ? -2.4 : 0), 0] },
      { pos: [0, ST[5], 12.5], look: [0, ST[5], -4] },
      { pos: [0, ST[6] + 0.4, p ? 26 : 16], look: [0, ST[6] + (p ? -0.4 : 0.8), 0] },
    ];
  };
  let STN = stations();

  /* ---------- background: nebula + stars sphere that follows the camera */
  const nebula = new THREE.Mesh(
    new THREE.SphereGeometry(400, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uTime: { value: 0 }, uShift: { value: 0 }, uC1: { value: new THREE.Color(0x0d4a3f) }, uC2: { value: new THREE.Color(0x2f5a12) }, uC3: { value: new THREE.Color(0x0b5f63) },
        uLight: { value: 0 }, uP: { value: new THREE.Color(PAPER) }, uL1: { value: new THREE.Color() }, uL2: { value: new THREE.Color() }, uL3: { value: new THREE.Color() }, uInk: { value: new THREE.Color(0x4a3452) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `${NOISE}
        uniform float uTime, uShift, uLight; uniform vec3 uC1, uC2, uC3, uP, uL1, uL2, uL3, uInk; varying vec3 vDir;
        float fbm(vec3 p){ float a=.5, s=0.; for(int i=0;i<${Q.oct};i++){ s+=a*snoise(p); p*=2.03; a*=.5; } return s; }
        float hash(vec3 p){ p=fract(p*.3183099+.1); p*=17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
        void main(){
          vec3 d = normalize(vDir);
          vec3 q = d*1.5 + vec3(0., uShift*.004, uTime*.006);
          float n = fbm(q), n2 = fbm(q*2.1 + n + 4.2);
          vec3 sp = d*240.; vec3 c = floor(sp); float h = hash(c);
          float st = step(.9962, h) * smoothstep(.45, .0, length(fract(sp)-.5));
          if (uLight > .5) {   // daylight (pearl): the warm paper, a thin film marbled over it in drifts (its hue cycling
            // lilac -> aqua -> rose across the sky and with the scroll, uShift), the paper left bare between them, a warm
            // pearl sheen towards the top, the stars as iridescent motes
            float fh = fract(n * .55 + n2 * .3 + d.x * .16 + d.y * .08 + uShift * .0032);
            vec3 film = fh < .3333 ? mix(uL1, uL2, fh * 3.) : fh < .6667 ? mix(uL2, uL3, fh * 3. - 1.) : mix(uL3, uL1, fh * 3. - 2.);
            float th = smoothstep(.06, .82, smoothstep(-.4, .8, n) * .6 + smoothstep(.05, .95, n2) * .4);
            vec3 lc = mix(uP, film, th * .74);
            lc += (vec3(1., .985, .965) - lc) * .2 * smoothstep(.1, .9, d.y + n2 * .35);
            lc *= .985 + .015*smoothstep(-.6,.6,d.y);
            lc = mix(lc, film * .42, st * .42 * (.55 + .45*sin(uTime*1.7 + h*90.)));
            gl_FragColor = vec4(lc, 1.);
            return;
          }
          vec3 col = vec3(.005,.016,.014);
          col += uC1 * smoothstep(-.25,.9,n) * .42;
          col += uC2 * smoothstep(.15,1.,n2) * .30;
          col += uC3 * pow(max(0., n*n2*2.), 1.6) * .35;
          col *= .65 + .35*smoothstep(-.6,.6,d.y);
          col += st * (.55 + .45*sin(uTime*1.7 + h*90.)) * vec3(.85,1.,.92);
          gl_FragColor = vec4(col, 1.);
        }`,
    }),
  );
  nebula.renderOrder = 10;   // after the opaque meshes: early-z skips the sky behind them (it has no depth of its own)
  const NEB_BASE = [0x0d4a3f, 0x2f5a12, 0x0b5f63].map((h) => new THREE.Color(h));
  const NEB_WORK = [0x0a3a33, 0x14594f, 0x1d4a1a].map((h) => new THREE.Color(h));
  // daylight: the pearl's thin film, lilac -> aqua -> rose (the games: lilac, aqua and periwinkle, calmer behind the cards)
  const NEB_LBASE = [0xd9f2a8, 0xb5ece2, 0xe9f7c8].map((h) => new THREE.Color(h));
  const NEB_LWORK = [0xe4f5c8, 0xcdeee6, 0xdcefe0].map((h) => new THREE.Color(h));
  scene.add(nebula);
  markB('nebula'); await yieldNow();

  /* ---------- dust column: parallax particles along the whole descent */
  {
    const n = Q.dust; const pos = new Float32Array(n * 3); const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 60; pos[i * 3 + 1] = 15 - Math.random() * 305; pos[i * 3 + 2] = (Math.random() - 0.5) * 50 - 6; seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const dust = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPR: { value: Q.dpr }, uVel: { value: 0 }, uCol: { value: new THREE.Vector3(0.7, 1, 0.85) }, uK: { value: 1 }, uLt: { value: 0 } },
      vertexShader: `attribute float aSeed; uniform float uTime, uPR, uVel, uLt; varying float vA, vS;
        void main(){ vec3 p = position; p.x += sin(uTime*.2 + aSeed*30.)*.4; p.y += cos(uTime*.15 + aSeed*20.)*.4;
          vec4 mv = modelViewMatrix*vec4(p,1.); gl_Position = projectionMatrix*mv;
          gl_PointSize = (1.2 + aSeed*2.2) * uPR * (16./-mv.z) * (1. + min(abs(uVel)*.05, 2.5));
          vA = (.25 + aSeed*.5) * smoothstep(80., 6., -mv.z); vS = fract(aSeed * 7.31);
          if (uLt > .5) gl_PointSize *= fract(aSeed * 3.17) < .3 ? 2.4 : 0.; }`,
      // (daylight: a few soft pastel bokeh of the film, lilac, aqua and rose by its seed: ink specks read as dirt on paper)
      fragmentShader: `uniform vec3 uCol; uniform float uK, uLt; varying float vA, vS; void main(){ float d = length(gl_PointCoord-.5);
        if (uLt > .5) { vec3 c = vS < .34 ? vec3(.62, .85, .2) : vS < .67 ? vec3(.2, .76, .68) : vec3(.75, .9, .45); gl_FragColor = vec4(c, smoothstep(.5, .1, d) * vA * .55); return; }
        vec3 c = uCol;
        gl_FragColor = vec4(c, smoothstep(.5,0.,d)*vA*uK); }`,
    }));
    dust.frustumCulled = false;
    scene.add(dust);
    var dustMat = dust.material;
  }

  /* ---------- particle logo (canvas text -> points) */
  // (edgeOut: each particle's edge measure, 1 within 4 px of the glyphs' outline, else 0: the daylight rim, LOOK_LIGHT)
  function sampleText(text, count, worldW, edgeOut = null) {
    const W = 1400, H = 300; const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `800 ${Math.round(H * 0.62)}px ${SANS}`;
    const tw = g.measureText(text).width; const fs = Math.min(1, (W * 0.94) / tw);
    g.font = `800 ${Math.round(H * 0.62 * fs)}px ${SANS}`;
    g.fillText(text, W / 2, H / 2);
    const data = g.getImageData(0, 0, W, H).data; const pts = [];
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (data[(y * W + x) * 4 + 3] > 128) pts.push(x, y);
    const out = new Float32Array(count * 3); const sc = worldW / W;
    const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4 + 3] > 128;
    for (let i = 0; i < count; i++) {
      const k = ((Math.random() * pts.length) / 2 | 0) * 2;
      if (edgeOut) { const x = pts[k], y = pts[k + 1]; edgeOut[i] = inside(x - 4, y) && inside(x + 4, y) && inside(x, y - 4) && inside(x, y + 4) ? 0 : 1; }
      out[i * 3] = (pts[k] - W / 2 + (Math.random() - 0.5) * 2) * sc;
      out[i * 3 + 1] = -(pts[k + 1] - H / 2 + (Math.random() - 0.5) * 2) * sc;
      out[i * 3 + 2] = (Math.random() - 0.5) * 0.25;
    }
    return out;
  }

  // particle targets from any alpha mask drawn by `draw(g, W, H)`; the mask is scaled to `worldW` wide
  // (only where the page's vector symbols cannot be drawn: intro.mjs samples the intro's own lockup)
  function sampleMask(draw, W, H, count, worldW) {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
    draw(g, W, H);
    const data = g.getImageData(0, 0, W, H).data; const pts = [];
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (data[(y * W + x) * 4 + 3] > 128) pts.push(x, y);
    const out = new Float32Array(count * 3); const sc = worldW / W;
    if (!pts.length) return out;
    for (let i = 0; i < count; i++) {
      const k = ((Math.random() * pts.length) / 2 | 0) * 2;
      out[i * 3] = (pts[k] - W / 2 + (Math.random() - 0.5) * 2) * sc;
      out[i * 3 + 1] = -(pts[k + 1] - H / 2 + (Math.random() - 0.5) * 2) * sc;
      out[i * 3 + 2] = (Math.random() - 0.5) * 0.25;
    }
    return out;
  }
  // the molecule mark (the logo's six atoms and its baseline, viewBox 64 x 46)
  const drawMark = (g, W, H) => {
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.save(); g.scale(W / 64, H / 46);
    for (const [x, y, r] of [[8, 31, 2.4], [17, 22, 3.6], [27, 11, 6.2], [38, 16, 4.4], [47, 24, 3.2], [55, 31, 2.2]]) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
    g.lineWidth = 2.4; g.lineCap = 'round'; g.beginPath(); g.moveTo(4, 40); g.lineTo(34, 40); g.stroke(); g.restore();
  };
  const ROOF_AR = 46 / 64;   // height / width of the mark

  /* particle text / logo. The intro's two layers take the look of intro.mjs (LOOK: size, colours, alpha, a crisper dot
     core, a few brighter sparks) and rest exactly where the poster drew them (uWake 0: no shimmer, no pointer) until the
     poster has gone; the outro keeps the defaults (the old look). */
  function logoPoints(target, seed, mix, worldW, spread, edge = null) {
    const count = seed.length; const scatter = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = (6 + Math.pow(Math.random(), 0.6) * 22) * spread; const th = Math.random() * Math.PI * 2; const ph = Math.acos(2 * Math.random() - 1);
      scatter[i * 3] = r * Math.sin(ph) * Math.cos(th); scatter[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.7; scatter[i * 3 + 2] = r * Math.cos(ph) - 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(target, 3));
    g.setAttribute('aScatter', new THREE.BufferAttribute(scatter, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aMix', new THREE.BufferAttribute(mix, 1));
    g.setAttribute('aEdge', new THREE.BufferAttribute(edge || new Float32Array(count), 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 }, uAssemble: { value: 0 }, uExplode: { value: 0 }, uMouse: { value: new THREE.Vector3(99, 99, 0) },
        uPush: { value: 1 }, uRad: { value: clamp(worldW / 7.5, 0.9, 2) }, uPR: { value: Q.dpr }, uSize: { value: mobile ? 2.4 : 2.0 }, uOpacity: { value: 1 },
        uA: { value: new THREE.Color(0xa4e335) }, uB: { value: new THREE.Color(0x2fd6c3) },
        uGain: { value: 0.9 }, uSpark: { value: 0 }, uCore: { value: 0.05 }, uAlpha: { value: 0.9 }, uWake: { value: 1 },
        uM: { value: new THREE.Color() }, uTri: { value: 0 },
        uRA: { value: new THREE.Color() }, uRM: { value: new THREE.Color() }, uRB: { value: new THREE.Color() }, uRk: { value: 0 }, uFill: { value: 0 },
      },
      vertexShader: `${NOISE}
        attribute vec3 aScatter; attribute float aSeed, aMix, aEdge;
        uniform float uTime, uAssemble, uExplode, uPush, uRad, uPR, uSize, uAlpha, uSpark, uWake, uFill; uniform vec3 uMouse;
        varying float vMix, vA, vHot, vSp, vEdge;
        void main(){
          float k = clamp(uAssemble*1.45 - aSeed*.45, 0., 1.); k = k*k*(3.-2.*k);
          vec3 drift = vec3(snoise(aScatter*.08 + uTime*.12), snoise(aScatter*.08 + 9. + uTime*.12), snoise(aScatter*.08 + 17. + uTime*.1)) * 2.2;
          vec3 p = mix(aScatter + drift, position, k);
          p += vec3(snoise(vec3(position.xy*.6, uTime*.35 + aSeed*4.)), snoise(vec3(position.yx*.6, uTime*.35 + aSeed*7.)), 0.) * .045 * k * uWake;
          vec2 dv = p.xy - uMouse.xy; float dist = length(dv);
          float f = smoothstep(uRad, 0., dist) * uPush * k;
          p.xy += normalize(dv + 1e-4) * f * 1.25; p.z += f * 1.6;
          vec3 dir = normalize(aScatter + vec3(0., 0., 8.));
          float e = uExplode * uExplode;
          p += dir * e * (2.5 + aSeed * 11.) + vec3(0., e * (aSeed - .3) * 3., e * aSeed * 9.);
          p.xy += vec2(snoise(position*.5 + uTime*.3), snoise(position*.5 + 5. + uTime*.3)) * e * 3.;
          vec4 mv = modelViewMatrix * vec4(p, 1.); gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * (.55 + aSeed*.9) * uPR * (14. / -mv.z) * (1. + f*.8 + e*.6) * (1. + uFill * (1. - aEdge));   // (daylight: larger dots inside a letter, LOOK_LIGHT fill)
          vMix = aMix; vHot = f; vA = (.3 + .6*k) / .9 * uAlpha * (1. - e*.65) * (1. - f*.55);
          vSp = 1. + uSpark * step(.94, aSeed); vEdge = aEdge;
        }`,
      // (daylight: uTri, a thin film of three stops, uM in the middle, reached over a short transition: violet -> azure ->
      // magenta; the outline's particles take the rim's film, uRA -> uRM -> uRB, by vEdge x uRk: intro.mjs LOOK_LIGHT.rim)
      fragmentShader: `uniform vec3 uA, uB, uM, uRA, uRM, uRB; uniform float uOpacity, uGain, uCore, uTri, uRk; varying float vMix, vA, vHot, vSp, vEdge;
        vec3 film(vec3 a, vec3 m, vec3 b, float x){ float t = smoothstep(.3, .7, x); return t < .5 ? mix(a, m, t * 2.) : mix(m, b, t * 2. - 1.); }
        void main(){ float d = length(gl_PointCoord-.5); float a = smoothstep(.5, uCore, d);
          vec3 c = (uTri > .5 ? mix(film(uA, uM, uB, vMix), film(uRA, uRM, uRB, vMix), vEdge * uRk) : mix(uA, uB, vMix)) * uGain * (1. + vHot*.78) * vSp + vec3(1.)*vHot*.12;
          gl_FragColor = vec4(c, a * vA * uOpacity); }`,
    });
    const pts = new THREE.Points(g, mat); pts.frustumCulled = false;
    return pts;
  }
  function particleLogo(text, count, worldW, spread = 1, targetIn = null) {
    const edge = targetIn ? null : new Float32Array(count);
    const target = targetIn || sampleText(text, count, worldW, edge);
    const seed = new Float32Array(count), mix = new Float32Array(count);
    for (let i = 0; i < count; i++) { seed[i] = Math.random(); mix[i] = clamp(target[i * 3] / worldW + 0.5 + (Math.random() - 0.5) * 0.25); }
    return logoPoints(target, seed, mix, worldW, spread, edge);
  }
  // an intro layer from intro.mjs particles ([u, v, seed, mix], u / v in fractions of the width) and its look, with the
  // soft light it stands in (the layer's blurred shape on a plane: the same grid the poster drew)
  function introLayer(sh, worldW, look, spread, tier) {
    const P = sh.pts; const n = P.length / 4;
    const target = new Float32Array(n * 3), seed = new Float32Array(n), mix = new Float32Array(n);
    for (let i = 0; i < n; i++) { target[i * 3] = P[i * 4] * worldW; target[i * 3 + 1] = -P[i * 4 + 1] * worldW; seed[i] = P[i * 4 + 2]; mix[i] = P[i * 4 + 3]; }
    const pts = logoPoints(target, seed, mix, worldW, spread, sh.edge);
    const u = pts.material.uniforms;
    u.uA.value.set(look.a); u.uB.value.set(look.b); u.uSize.value = look.size[tier]; u.uGain.value = look.gain; u.uSpark.value = look.spark; u.uCore.value = look.core; u.uAlpha.value = look.alpha;
    const G = sh.glow, data = new Uint8Array(G.w * G.h * 4);
    for (let y = 0; y < G.h; y++) for (let x = 0; x < G.w; x++) { const v = Math.round(G.g[y * G.w + x] * 255); const o = ((G.h - 1 - y) * G.w + x) * 4; data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255; }
    const tex = new THREE.DataTexture(data, G.w, G.h); tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(G.du * worldW, G.dv * worldW), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTex: { value: tex }, uOn: { value: 0 }, uK: { value: look.glow.k }, uU0: { value: G.u0 }, uDu: { value: G.du }, uA: { value: new THREE.Color(look.glow.a) }, uB: { value: new THREE.Color(look.glow.b) },
        uLt: { value: 0 }, uX: { value: 1 }, uW: { value: new THREE.Vector3() }, uS: { value: new THREE.Color() }, uP: { value: new THREE.Color(PAPER) }, uM: { value: new THREE.Color() },
        uIA: { value: new THREE.Color() }, uIM: { value: new THREE.Color() }, uIB: { value: new THREE.Color() }, uDp: { value: new THREE.Vector4(0, 2, 3, 0) } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      // the light theme's wash (intro.mjs LOOK_LIGHT, laid as the poster and the entrance lay it): the shadow (sampled
      // uW.z of the grid's height above), the paper knock-out, the body; the plane runs uX of the grid's height, downwards
      fragmentShader: `uniform sampler2D uTex; uniform float uOn, uK, uU0, uDu, uLt, uX; uniform vec3 uA, uB, uW, uS, uP, uM, uIA, uIM, uIB; uniform vec4 uDp; varying vec2 vUv;
        void main(){ vec3 c = mix(uA, uB, clamp(uU0 + vUv.x * uDu + .5, 0., 1.));
          if (uLt > .5) {
            float tx = smoothstep(.3, .7, uU0 + vUv.x * uDu + .5); c = tx < .5 ? mix(uA, uM, tx * 2.) : mix(uM, uB, tx * 2. - 1.);
            float ty = 1. - (1. - vUv.y) * uX;
            float g0 = ty >= 0. ? texture2D(uTex, vec2(vUv.x, ty)).r : 0., gs = texture2D(uTex, vec2(vUv.x, ty + uW.z)).r;
            float aS = min(1., gs * uW.y * uOn), aK = min(1., g0 * uW.x * uOn), aT = min(1., g0 * uK * uOn);
            vec3 C = uS * aS; float A = aS;
            C = uP * aK + C * (1. - aK); A = aK + A * (1. - aK);
            C = c * aT + C * (1. - aT); A = aT + A * (1. - aT);
            // (the ink's underlay inside the letters: LOOK_LIGHT glow.deep)
            float aD = smoothstep(uDp.y, uDp.z, g0) * uDp.x * uOn; vec3 cd = mix(tx < .5 ? mix(uIA, uIM, tx * 2.) : mix(uIM, uIB, tx * 2. - 1.), uP, uDp.w);
            C = cd * aD + C * (1. - aD); A = aD + A * (1. - aD);
            gl_FragColor = A > 1e-4 ? vec4(C / A, A) : vec4(0.); return;
          }
          gl_FragColor = vec4(c * texture2D(uTex, vUv).r * uK * uOn, 1.); }`,
    }));
    glow.position.set((G.u0 + G.du / 2) * worldW, -(G.v0 + G.dv / 2) * worldW, 0); glow.frustumCulled = false;
    glow.userData.y0 = glow.position.y; glow.userData.dv = G.dv; pts.userData.W = worldW; pts.userData.part = look === LOOK.roof ? 'roof' : 'word';
    pts.add(glow); pts.userData.glow = glow;
    return pts;
  }

  /* ---------- emblem (hero): chrome shield ring + glowing core */
  const emblem = new THREE.Group();
  if (HERO === 'emblem') {
    const shield = (s) => {
      const sh = new THREE.Shape();
      sh.moveTo(0, 1.3 * s);
      sh.bezierCurveTo(0.5 * s, 1.08 * s, 0.9 * s, 1.0 * s, 1.08 * s, 0.98 * s);
      sh.lineTo(1.08 * s, 0.12 * s);
      sh.bezierCurveTo(1.08 * s, -0.62 * s, 0.56 * s, -1.08 * s, 0, -1.36 * s);
      sh.bezierCurveTo(-0.56 * s, -1.08 * s, -1.08 * s, -0.62 * s, -1.08 * s, 0.12 * s);
      sh.lineTo(-1.08 * s, 0.98 * s);
      sh.bezierCurveTo(-0.9 * s, 1.0 * s, -0.5 * s, 1.08 * s, 0, 1.3 * s);
      return sh;
    };
    const outer = shield(1.75); outer.holes.push(new THREE.Path(shield(1.32).getPoints(80)));
    const chrome = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 1, roughness: 0.14, iridescence: 0.7, iridescenceIOR: 1.7, envMapIntensity: 1.7 });
    const frameGeo = new THREE.ExtrudeGeometry(outer, { depth: 0.38, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.09, bevelSegments: 6, curveSegments: 48 });
    /* The flat front band of the shield is the emblem's biggest chrome surface, and a flat mirror can only
       show one reflection direction per frame (a solid teal / lavender / grey band). Give it a rounded-bar
       profile instead: aBand runs 0 at the inner edge to 1 at the outer edge of the front cap, and the
       fragment normal leans toward the nearer edge, so one frame sweeps a range of env directions and
       shows dark-light-dark chrome bands that slide as the emblem sways. */
    {
      frameGeo.computeBoundingBox();
      const off = frameGeo.boundingBox.getCenter(new THREE.Vector3()).negate();
      const outerPts = shield(1.75).getPoints(160).map((q) => [q.x + off.x, q.y + off.y]);
      const innerPts = shield(1.32).getPoints(160).map((q) => [q.x + off.x, q.y + off.y]);
      const dist = (pts, x, y) => { let m = Infinity; for (let i = 0; i < pts.length - 1; i++) { const [ax, ay] = pts[i], [bx, by] = pts[i + 1]; const vx = bx - ax, vy = by - ay; const tt = clamp(((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy || 1)); m = Math.min(m, Math.hypot(ax + vx * tt - x, ay + vy * tt - y)); } return m; };
      frameGeo.center();
      const pos = frameGeo.attributes.position, nor = frameGeo.attributes.normal;
      const band = new Float32Array(pos.count).fill(-1);
      for (let i = 0; i < pos.count; i++) {
        if (nor.getZ(i) < 0.99) continue; // front cap only
        const x = pos.getX(i), y = pos.getY(i), di = dist(innerPts, x, y), dO = dist(outerPts, x, y);
        band[i] = di / Math.max(di + dO, 1e-5);
      }
      frameGeo.setAttribute('aBand', new THREE.BufferAttribute(band, 1));
    }
    const frameMat = chrome.clone();
    frameMat.onBeforeCompile = (sh) => {
      sh.uniforms.uBulge = { value: 0.62 };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aBand; varying float vBand; varying vec3 vBandDir;`)
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          vBand = aBand; vBandDir = normalize( normalMatrix * vec3( normalize( position.xy + vec2( 1e-5 ) ), 0.0 ) );`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uBulge; varying float vBand; varying vec3 vBandDir;`)
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          if ( vBand >= 0.0 ) { float bb = vBand * 2.0 - 1.0; normal = normalize( normal + normalize( vBandDir ) * bb * ( 0.55 + 0.45 * bb * bb ) * uBulge ); }`);
    };
    frameMat.customProgramCacheKey = () => 'shield-band-v1';
    const frame = new THREE.Mesh(frameGeo, frameMat);
    emblem.add(frame);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.25, 0.07, 24, 220), chrome);
    emblem.add(ring);
    // outer glow ring: chrome-teal, ~45 % less emission than the old 2.2x cyan and under the bloom
    // threshold; only one small highlight travels round it and blooms
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(3.7, 0.018, 8, 220), new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBase: { value: new THREE.Color(0x22d3ee).lerp(new THREE.Color(0xbfe9f0), 0.38).multiplyScalar(1.15) },
        uHot: { value: new THREE.Color(0xe6fbff).multiplyScalar(2.4) },
      },
      vertexShader: `varying float vU; void main(){ vU = uv.x; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform float uTime; uniform vec3 uBase, uHot; varying float vU;
        void main(){ float g = fract(vU - uTime*.04); g = min(g, 1. - g); float h = exp(-g*g*1400.);
          gl_FragColor = vec4(uBase*(.8 + .2*smoothstep(.12, 0., g)) + uHot*h, 1.); }`,
    }));
    emblem.add(ring2);
    var ring2Mat = ring2.material;
    // pulse line (ping) inside the shield
    const pts = [[-1.25, -0.05], [-0.55, -0.05], [-0.3, 0.55], [0.12, -0.75], [0.48, 0.2], [0.68, -0.05], [1.25, -0.05]].map(([x, y]) => new THREE.Vector3(x, y, 0));
    const pulse = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.05), 120, 0.055, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xc4b5fd).multiplyScalar(2.4), toneMapped: false }));
    emblem.add(pulse);
    // orbiting sparks
    const n = 600; const p = new Float32Array(n * 3); const s = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2; const r = 3.4 + (Math.random() - 0.5) * 0.9; p[i * 3] = Math.cos(a) * r; p[i * 3 + 1] = Math.sin(a) * r; p[i * 3 + 2] = (Math.random() - 0.5) * 0.6; s[i] = Math.random(); }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(p, 3)); sg.setAttribute('aSeed', new THREE.BufferAttribute(s, 1));
    const sparks = new THREE.Points(sg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uTime: { value: 0 }, uPR: { value: Q.dpr } },
      vertexShader: `attribute float aSeed; uniform float uTime, uPR; varying float vA;
        void main(){ float a = uTime*(.15 + aSeed*.25); mat2 r = mat2(cos(a),-sin(a),sin(a),cos(a)); vec3 p = position; p.xy = r*p.xy;
          vec4 mv = modelViewMatrix*vec4(p,1.); gl_Position = projectionMatrix*mv; gl_PointSize = (1. + aSeed*2.5)*uPR*(12./-mv.z);
          vA = .3 + .7*abs(sin(uTime*2. + aSeed*40.)); }`,
      fragmentShader: `varying float vA; void main(){ float d=length(gl_PointCoord-.5); gl_FragColor = vec4(vec3(.7,.85,1.)*1.6, smoothstep(.5,0.,d)*vA); }`,
    }));
    emblem.add(sparks);
    var sparksMat = sparks.material;
  }
  scene.add(emblem);

  /* ---------- hero: the lab2date molecule. The brand mark's six atoms (logo viewBox 64 x 46) as a molecule of pearl
     chrome: spheres joined by chrome bonds (one double bond), given depth. A storm of particle tracks pours down on it as
     through a detector: a streak that meets an atom rides round it glowing and drips off its equator, while underneath
     it stays dry and calm. One instanced draw for the whole storm: every streak's path (fall, hit, ride, drip) is solved
     analytically in the vertex shader against the atoms (each a circle in the streak's own depth plane). */
  const roof = new THREE.Group();
  const ROOF_W = 6.6;   // the molecule's width (world units, desktop)
  let roofU = null, roofRain = null, roofWind = 0, roofFlash = 0, roofNextFlash = 4;
  // [x, y, r] in the logo's viewBox, + depth (world units): centred on (31.4, 19), y up
  const ATOMS = [[8, 31, 2.4, 0.45], [17, 22, 3.6, -0.32], [27, 11, 6.2, 0], [38, 16, 4.4, 0.38], [47, 24, 3.2, -0.28], [55, 31, 2.2, 0.34]]
    .map(([x, y, r, z]) => new THREE.Vector4(((x - 31.4) / 52) * ROOF_W, (-(y - 19) / 52) * ROOF_W, z, (r / 52) * ROOF_W * 1.06));
  const roofMat = LITE
    ? new THREE.MeshStandardMaterial({ color: 0xf2fbf6, metalness: 0.6, roughness: 0.12, envMapIntensity: 3.8, emissive: 0x123a30, emissiveIntensity: 1 })
    : new THREE.MeshPhysicalMaterial({ color: 0xe9f6ef, metalness: 0.62, roughness: 0.09, iridescence: 1, iridescenceIOR: 2.2, iridescenceThicknessRange: [300, 1400], clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 3.4, emissive: 0x0a2620, emissiveIntensity: 1, sheen: 1, sheenColor: 0x000000, sheenRoughness: 0.35 });   // (sheen black at night: see spineMat)
  // daylight: a spectral rim light on the pearl (molecule, column): the faces turning away from the viewer catch the
  // film, lime -> teal -> pale lime with the angle, so every edge is lit in colour. uRim 0 at night: nothing is added
  const SPECTRAL_RIM = `if (uRim > 0.) { float fr = pow(1. - clamp(dot(normal, normalize(vViewPosition)), 0., 1.), 2.2);
          vec3 sp = fr < .5 ? mix(vec3(.55, .85, .2), vec3(.15, .8, .72), fr * 2.) : mix(vec3(.15, .8, .72), vec3(.85, .95, .4), fr * 2. - 1.);
          totalEmissiveRadiance += sp * fr * uRim; }`;
  // daylight: the chrome tinted lime -> pale -> teal across the molecule (three stops). uTK 0 at night: no tint
  const tint = (a, m, b) => ({ uTA: { value: new THREE.Color(a) }, uTM: { value: new THREE.Color(m) }, uTB: { value: new THREE.Color(b) }, uTK: { value: 0 }, uRim: { value: 0 } });
  const ROOF_TINT = tint(0x9ad94a, 0xe8f7c8, 0x5fd6c4);
  roofMat.onBeforeCompile = function (sh) {
    sh.uniforms.uRW = { value: ROOF_W }; Object.assign(sh.uniforms, (this && this.userData && this.userData.tint) || ROOF_TINT);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vRP;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRP = position;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uRW, uTK, uRim; uniform vec3 uTA, uTM, uTB; varying vec3 vRP;
        vec3 tint3(float x){ float t = smoothstep(.2, .8, x); return t < .5 ? mix(uTA, uTM, t * 2.) : mix(uTM, uTB, t * 2. - 1.); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= mix(vec3(1.), tint3(vRP.x / uRW + .5), uTK);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= mix(vec3(1.), tint3(vRP.x / uRW + .5) * 1.5, uTK);
        ${SPECTRAL_RIM}`);
  };
  roofMat.customProgramCacheKey = () => 'mol-chrome-v1';
  // (built in the boot's second part, once the intro is on screen)
  const buildRoof = () => {
    if (HERO !== 'logo' || roofU) return;
    { // the molecule: atoms + bonds, one merged mesh
      // (geodesic spheres, finer for the two big atoms: ~6k triangles for the whole molecule instead of ~26k, the same
      // silhouette to a fraction of a pixel; all parts non-indexed so they merge)
      const parts = [];
      for (const a of ATOMS) { const g = new THREE.IcosahedronGeometry(a.w, a.w > 0.5 ? (LITE ? 4 : 5) : (LITE ? 3 : 4)); g.translate(a.x, a.y, a.z); parts.push(g); }
      const Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
      const bond = (a, b, rb, off) => {
        const A = new THREE.Vector3(a.x, a.y, a.z), B = new THREE.Vector3(b.x, b.y, b.z), d = B.clone().sub(A), L = d.length();
        const g = new THREE.CylinderGeometry(rb, rb, L, mobile ? 10 : 14, 1, true).toNonIndexed();
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y, d.clone().normalize()));
        const mid = A.add(B).multiplyScalar(0.5).addScaledVector(new THREE.Vector3().crossVectors(d, Z).normalize(), off);
        g.translate(mid.x, mid.y, mid.z); parts.push(g);
      };
      for (let i = 0; i < ATOMS.length - 1; i++) {
        if (i === 2) { bond(ATOMS[i], ATOMS[i + 1], 0.055, 0.1); bond(ATOMS[i], ATOMS[i + 1], 0.055, -0.1); }   // a double bond
        else bond(ATOMS[i], ATOMS[i + 1], 0.08, 0);
      }
      const mg = mergeGeometries(parts.map((g) => { g.deleteAttribute('uv'); return g; }));
      parts.forEach((g) => g.dispose());
      roof.add(new THREE.Mesh(mg, roofMat));
    }

    // the storm
    const NR = mobile ? 900 : 2000;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    const sd = new Float32Array(NR * 4);
    for (let i = 0; i < NR; i++) {
      const back = Math.random() < 0.28;   // a dim curtain far behind, for depth
      sd[i * 4] = Math.random();
      sd[i * 4 + 1] = back ? -2.5 - Math.random() * 5 : (Math.random() - 0.5) * 1.3;
      sd[i * 4 + 2] = 0.8 + Math.random() * 0.5;
      sd[i * 4 + 3] = Math.random();
    }
    g.setAttribute('aS', new THREE.InstancedBufferAttribute(sd, 4));
    g.instanceCount = NR;
    const rain = new THREE.Mesh(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true,   // streak quads flip winding with their direction
      uniforms: { uTime: { value: 0 }, uWind: { value: 0 }, uW: { value: ROOF_W }, uTop: { value: 6.5 }, uBot: { value: -6.5 }, uRes: { value: new THREE.Vector2(VW(), VH()) }, uHot: { value: mobile ? 1 : 2.2 }, uFlash: { value: 0 },
        uAt: { value: ATOMS },
        uLt: { value: 0 }, uInkC: { value: new THREE.Color(0x2f6a12) }, uInkC2: { value: new THREE.Color(0x0b6b5e) }, uInkC3: { value: new THREE.Color(0x3f7f0e) }, uInkH: { value: new THREE.Color(0x0e7c6b) }, uTail: { value: 1 }, uWk: { value: 1 }, uSplash: { value: 0 } },
      vertexShader: `uniform float uTime, uWind, uW, uTop, uBot, uTail, uWk, uSplash, uLt; uniform vec2 uRes; uniform vec4 uAt[${ATOMS.length}]; attribute vec4 aS;
        varying float vA, vHot, vSide, vEnd, vHue, vSpl, vLay, vPh;
        float h1(float n){ return fract(sin(n * 91.345) * 47453.21); }
        // the first atom a streak falling from (X0, uTop) at depth Z meets: the distance fallen (1e5: none) and the circle
        // (centre, radius) the atom cuts in the streak's depth plane
        float hitAtoms(float X0, float Z, float w, out vec3 cr){
          float sHit = 1e5; cr = vec3(0., 0., 1.);
          for (int i = 0; i < ${ATOMS.length}; i++) {
            vec4 a = uAt[i]; float dz = Z - a.z; float rc2 = a.w * a.w - dz * dz;
            if (rc2 <= 0.) continue;
            float ox = X0 - a.x, oy = uTop - a.y;
            float A = w * w + 1., B = ox * w - oy, C = ox * ox + oy * oy - rc2, D = B * B - A * C;
            if (D < 0.) continue;
            float sh = (-B - sqrt(D)) / A;
            if (sh > 0. && sh < sHit) { sHit = sh; cr = vec3(a.xy, sqrt(rc2)); }
          }
          return sHit;
        }
        // position after tau seconds; hot = 1 while riding an atom, then fading as it drips
        // (daylight: spl = 1 for a share of the drops, which splash off the atom instead of riding it, sp = the splash's
        // life, 1 -> 0, or -1 while the drop is not splashing; 0 at night: the same paths as ever)
        vec3 path(float tau, float X0, float Z, float V, float spl, float sHit, vec3 cr, out float hot, out float sp){
          float w = uWind, s = V * tau; hot = 0.; sp = -1.;
          if (s < sHit) return vec3(X0 + w * s, uTop - s, Z);
          float tHit = sHit / V, ts = tau - tHit; vec2 ph = vec2(X0 + w * sHit, uTop - sHit);
          if (spl > .5) {   // a splash: a droplet thrown up and out off the atom, falling back within half a second
            float r1 = fract(X0 * 17.13 + Z * 5.7), r2 = fract(X0 * 9.71 + Z * 13.3);
            hot = 1.; sp = 1. - smoothstep(.15, .55, ts);
            return vec3(ph.x + (r1 - .5) * 3. * ts, ph.y + .1 + (1.6 + 2. * r2) * ts - 9. * ts * ts, Z);
          }
          // ride round the atom, from where it hit down to the equator on that side, then drip off it
          vec2 rel = ph - cr.xy; float th0 = atan(rel.x, rel.y), side = th0 >= 0. ? 1. : -1.;
          float L = max(0., 1.5708 - abs(th0)) * cr.z;
          float vs = V * .3, acc = 5.;
          float dd = vs * ts + .5 * acc * ts * ts;
          if (dd < L) { hot = 1.; float th = th0 + side * dd / cr.z; return vec3(cr.xy + vec2(sin(th), cos(th)) * (cr.z + .05), Z); }
          float tl = (-vs + sqrt(vs * vs + 2. * acc * L)) / acc; float tf = ts - tl;
          vec2 pe = cr.xy + vec2(side * (cr.z + .05), 0.); hot = exp(-tf * 9.) * .8;
          float spread = .3 + .9 * fract(X0 * 7.31 + Z * 3.7);
          return vec3(pe.x + side * spread * tf, pe.y - (V * .25 * tf + 7. * tf * tf), Z + (fract(X0 * 3.1) - .5) * tf * .8);
        }
        // (daylight: a splash off an atom is a small bead thrown up and out, gone in a third of a second)
        vec3 bead(float tau, float X0, float Z, float V, float sHit, out float sp){
          float w = uWind; sp = -1.;
          float s = V * tau; if (s < sHit) return vec3(X0 + w * s, uTop - s, Z);
          float ts = tau - sHit / V, r1 = fract(X0 * 17.13 + Z * 5.7), r2 = fract(X0 * 9.71 + Z * 13.3);
          sp = 1. - smoothstep(.06, .32, ts);
          return vec3(X0 + w * sHit + (r1 - .5) * 2.2 * ts, uTop - sHit + .05 + (.5 + 1.9 * r2 * r2) * ts - 7. * ts * ts, Z + (r1 - .5) * .3);
        }
        void main(){
          float V = 7. * aS.z, Z = aS.y;
          float T = (uTop - uBot) / V + 1.6;
          float cyc = uTime / T + aS.w; float tau = fract(cyc) * T; float id = floor(cyc);
          float X0 = (h1(aS.x * 13.7 + id * 1.31) - .5) * 1.25 * uW - uWind * (uTop - uBot) * .5;
          float spl = step(fract(aS.x * 7.13 + id * .71), uSplash);
          vec3 cr = vec3(0., 0., 1.); float sHit = Z < -1. ? 1e5 : hitAtoms(X0, Z, uWind, cr);
          float hh = 0., ht = 0., sh = 0., st = 0.; vec3 head = path(tau, X0, Z, V, spl, sHit, cr, hh, sh); vec3 tail = path(max(tau - .05 * uTail, 0.), X0, Z, V, spl, sHit, cr, ht, st);
          if (sh >= 0.) hh = sh * .8;   // (a splash droplet: thin, in the sheet's colour)
          vec4 ch = projectionMatrix * modelViewMatrix * vec4(head, 1.), ct = projectionMatrix * modelViewMatrix * vec4(tail, 1.);
          vec2 sdir = (ch.xy / ch.w - ct.xy / ct.w) * uRes; float sl = length(sdir);
          vec2 nrm = sl > 1e-3 ? vec2(-sdir.y, sdir.x) / sl : vec2(1., 0.);
          vec4 c = mix(ct, ch, position.y);
          float wpx = ((Z < -1. ? .8 : 1.15) + hh * 1.1) * uWk;
          c.xy += nrm * wpx * 2. / uRes * position.x * c.w;
          gl_Position = c;
          float yy = head.y;
          float edge = 1. - smoothstep(.42, .62, abs(X0 + uWind * (uTop - uBot) * .5) / uW);
          vA = edge * (1. - smoothstep(uTop - 1.2, uTop, yy)) * smoothstep(uBot, uBot + 1.5, yy) * (Z < -1. ? .22 : .55);
          if (sh >= 0.) vA = .62 * sh;   // (a splash: fading out)
          vHot = hh; vSide = position.x; vEnd = position.y; vHue = fract(aS.x * 5.31 + id * .37); vSpl = step(0., sh);
          vLay = 0.; vPh = 0.;
          if (uLt > .5) {
            // daylight: three depths of thread, each one ink thread of the film, the hue sweeping across the sheet with
            // the screen's x and the depth; riding an atom: thin bright glints; off it: ribbons; a splash: a bead
            float lay = Z < -1. ? 0. : (fract(aS.w * 13.7) < .45 ? 2. : 1.);
            float sp = -1.; vec3 hd = head;
            if (spl > .5) hd = bead(tau, X0, Z, V, sHit, sp);
            vec4 hc = projectionMatrix * modelViewMatrix * vec4(hd, 1.);
            if (sp >= 0.) {   // the bead: a round dot of ~3 px round its head
              c = hc; c.xy += vec2(position.x, position.y * 2. - 1.) * 1.6 * 2. / uRes * c.w;
              vA = .9 * sp; vPh = 3.;
            } else {
              float ride = step(.99, hh), drip = (1. - ride) * step(.001, hh);
              vPh = ride + 2. * drip;
              float wl = ride > .5 ? .95 : drip > .5 ? 1.25 : lay > 1.5 ? 1.6 : lay > .5 ? 1.05 : .8;
              c = mix(ct, ch, position.y); c.xy += nrm * wl * 2. / uRes * position.x * c.w;
              vA = edge * (1. - smoothstep(uTop - 1.2, uTop, yy)) * smoothstep(uBot, uBot + 1.5, yy) * (lay > 1.5 ? .8 : lay > .5 ? .5 : .2);
              if (ride > .5) vA = .85 * edge; else if (drip > .5) vA = .72 * smoothstep(0., .25, hh) * edge;
            }
            gl_Position = c;
            vLay = lay; vHot = hh;
            vHue = fract(.58 + hc.x / hc.w * .5 + (Z < -1. ? .2 : Z * .3) + uTime * .012);
          }
        }`,
      fragmentShader: `uniform float uHot, uFlash, uLt; uniform vec3 uInkC, uInkC2, uInkC3, uInkH; varying float vA, vHot, vSide, vEnd, vHue, vSpl, vLay, vPh;
        void main(){
          float a = (1. - vSide * vSide) * mix(.15, 1., vEnd) * (vA * (1. + uFlash * 2.2) + vHot * .55);
          if (uLt > .5) {
            float fl = 1. + uFlash * 1.2;
            if (vPh > 2.5) {
              float d = length(vec2(vSide, vEnd * 2. - 1.));
              float co = 1. - smoothstep(.3, .55, d), rg = smoothstep(.35, .55, d) * (1. - smoothstep(.75, 1., d));
              gl_FragColor = vec4(mix(vec3(.06, .5, .42), vec3(1.), co), min(1., max(co, rg * .9) * vA * fl)); return; }
            float fh = vHue;
            vec3 ink = fh < .3333 ? mix(uInkC, uInkC2, fh * 3.) : fh < .6667 ? mix(uInkC2, uInkC3, fh * 3. - 1.) : mix(uInkC3, uInkC, fh * 3. - 2.);
            if (vLay < .5) ink = mix(ink, vec3(.36, .52, .46), .55);
            if (vPh > .5 && vPh < 1.5) ink = uInkH;
            if (vPh > 1.5) ink = uInkH * .82;
            float body = 1. - smoothstep(.6, 1., abs(vSide));
            float hi = exp(-pow((vSide + .42) / .16, 2.)) * (vLay > 1.5 || vPh > .5 ? 1. : .3) * smoothstep(0., .35, vEnd);
            float prof = smoothstep(0., .55, vEnd) * .8 + .2;
            if (vPh > 1.5) prof *= mix(1., smoothstep(.15, .6, sin(vEnd * 18.85 + vHot * 30.) * .5 + .5), smoothstep(.75, .25, vHot));   // (the ribbon breaks into beads)
            vec3 col = mix(ink, vec3(1.), hi * (vPh > .5 && vPh < 1.5 ? .85 : .55));
            gl_FragColor = vec4(col, min(1., body * prof * vA * fl)); return; }
          vec3 cold = vec3(.62, .95, .85), hot = vec3(.72, 1., .3) * uHot;
          gl_FragColor = vec4(mix(cold, hot, vHot), a);
        }`,
    }));
    rain.frustumCulled = false; roof.add(rain);
    roofU = rain.material.uniforms; roofRain = rain.material;
    themeRoof();
  };
  scene.add(roof);
  // lights live at scene level and never toggle: a changing light count would recompile every lit shader
  const keyLight = new THREE.PointLight(0xc6f57a, 40, 30); const rimLight = new THREE.PointLight(0x2fd6c3, 30, 30);
  scene.add(keyLight, rimLight);
  // the work scene's coloured key lights on the column (scene level, fixed count: no recompiles)
  const workTeal = new THREE.PointLight(0x5eead4, 10, 14), workPink = new THREE.PointLight(0xbef264, 8, 14);
  // (not added to the scene: the hero's pair is retargeted for the games, see setLights)

  /* ---------- games: Active-Theory "work" scene. A tall iridescent vertebral column; glass card slabs sit
     on a helix around it (one per game, stepping down); the camera descends the column and orbits it as you
     scroll, so each card in turn comes round to face the viewer while the vertebrae slide past. */
  const BLANK_TEX = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1); BLANK_TEX.needsUpdate = true;
  const CARD_LT = { value: 0 };   // the card faces' daylight switch (one uniform shared by every face)
  const SPINE_RIM = { value: 0 };   // the column's spectral rim (daylight)
  const SPINE_FILM = { value: 0 };   // the column's thin film across its curvature (daylight)
  const SPINE_AO = { value: 0 };     // the column's occlusion (daylight; its cavity term is baked on first need: bakeSpineAO)
  const SLAB_LT = { value: 0 };      // the card slabs as iridescent glass panes (daylight)
  const tower = new THREE.Group();
  const cards = [];           // face meshes (ShaderMaterial with uTex …) — one per game
  const cardGroups = [];      // slab + face, placed once on the helix
  const CARD_W = 4.9, CARD_H = 3.08, CARD_D = 0.22;
  const G_DY = 1.35, G_ANG = 0.98, G_RC = 5.3; // helix: height step, angle step, radius
  let spine, spineHolder, petalsMat, spineSpin = 0;
  // (built in the boot's second part, once the intro is on screen)
  const buildTower = () => {
    if (spine) return;
    // --- one unit of the chain: an aromatic ring (six atoms, six bonds and the ring of its delocalised electrons) in
    // the vertical plane, two substituents (a bond out to a small atom) and the linker up to the next ring. The units
    // are stacked with a twist of 60 degrees each: from the orbiting camera a turning chain of structural formulas
    const RR = 0.62, LINK = 0.36, parts = [];
    const UY = new THREE.Vector3(0, 1, 0);
    const rod = (a, b, r) => {
      const d = b.clone().sub(a), g = new THREE.CylinderGeometry(r, r, d.length(), mobile ? 6 : 8, 1, true).toNonIndexed();
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UY, d.clone().normalize()));
      const m = a.clone().add(b).multiplyScalar(0.5); g.translate(m.x, m.y, m.z); parts.push(g);
    };
    const ball = (p, r) => { const g = new THREE.IcosahedronGeometry(r, mobile ? 1 : 2); g.translate(p.x, p.y, p.z); parts.push(g); };
    const V = Array.from({ length: 6 }, (_, k) => { const a = Math.PI / 2 + (k * Math.PI) / 3; return new THREE.Vector3(Math.cos(a) * RR, Math.sin(a) * RR, 0); });
    V.forEach((p, k) => { ball(p, k === 3 ? 0.16 : 0.12); rod(p, V[(k + 1) % 6], 0.05); });
    { const tg = new THREE.TorusGeometry(RR * 0.6, 0.032, 6, mobile ? 24 : 32).toNonIndexed(); parts.push(tg); }
    for (const k of [1, 4]) { const out = V[k].clone().normalize().multiplyScalar(RR + 0.42); rod(V[k], out, 0.045); ball(out, 0.1); }
    rod(V[0], new THREE.Vector3(0, RR + LINK, 0), 0.05);   // the linker (the next ring's lowest atom closes it)
    const vg = mergeGeometries(parts.map((g) => { g.deleteAttribute('uv'); return g; }));
    parts.forEach((g) => g.dispose());
    // --- the column: tall enough for the whole descent (cards from y = 0 down to -9 * G_DY)
    const TOP = 9, BOT = -(GAMES.length - 1) * G_DY - 10, GAP = 2 * RR + LINK;
    const NV = Math.ceil((TOP - BOT) / GAP);
    // (the desktop pearl carries a sheen whose colour is black at night: three's sheen then adds nothing and scales nothing,
    // so the night is the night as ever, and daylight only sets its colour: a theme switch never recompiles)
    const spineMat = LITE
      ? new THREE.MeshStandardMaterial({ color: 0xd6efe4, metalness: 0.6, roughness: 0.16, envMapIntensity: 3.0, emissive: 0x0a2420, emissiveIntensity: 1 })
      : new THREE.MeshPhysicalMaterial({ color: 0xd6efe4, metalness: 0.58, roughness: 0.11, iridescence: 1, iridescenceIOR: 2.2, iridescenceThicknessRange: [300, 1400], clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 3.4, emissive: 0x0a2420, emissiveIntensity: 1, sheen: 1, sheenColor: 0x000000, sheenRoughness: 0.35 });
    // (daylight: the thin film across the column's curvature, uFilm, laid by the fresnel only (pow(1 - N.V, 1.5)): the
    // pearl's body keeps its own colour where it faces the viewer, its shoulders turn violet -> teal -> rose towards the
    // edge; the pearl's spectral rim, SPECTRAL_RIM; and its occlusion, uAO (a per-vertex cavity term baked once the first
    // time daylight needs it, bakeSpineAO): the crevices go deep indigo, the open faces stay pearl. All three 0 at night:
    // every term multiplies by exactly 1, nothing changes)
    spineMat.onBeforeCompile = (sh) => {
      sh.uniforms.uRim = SPINE_RIM; sh.uniforms.uFilm = SPINE_FILM; sh.uniforms.uAOk = SPINE_AO;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n        attribute float aAO; varying float vAO;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n        vAO = aAO;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n        uniform float uRim, uFilm, uAOk; varying float vAO;')
        .replace('#include <color_fragment>', `#include <color_fragment>
        float sAO = mix(1., vAO, uAOk);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.02, .12, .09), (1. - sAO) * .82 * uAOk);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (uFilm > 0.) { float fh = 1. - clamp(dot(normal, normalize(vViewPosition)), 0., 1.);
          vec3 tf = fh < .3333 ? mix(vec3(.62, .86, .22), vec3(.2, .82, .74), fh * 3.) : fh < .6667 ? mix(vec3(.2, .82, .74), vec3(.86, .96, .5), fh * 3. - 1.) : mix(vec3(.86, .96, .5), vec3(.62, .86, .22), fh * 3. - 2.);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * tf * 1.3, uFilm * pow(fh, 1.5)); }
        totalEmissiveRadiance *= mix(1., sAO, uAOk);
        ${SPECTRAL_RIM}`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= sAO; reflectedLight.indirectSpecular *= mix(1., sAO, .85);
        reflectedLight.directDiffuse *= mix(1., sAO, .75); reflectedLight.directSpecular *= mix(1., sAO, .7);
        #ifdef USE_CLEARCOAT
          clearcoatSpecularIndirect *= sAO;
        #endif
        #ifdef USE_SHEEN
          sheenSpecularIndirect *= sAO;
        #endif`)
        .replace('#include <opaque_fragment>', `outgoingLight = mix(outgoingLight, vec3(.04, .2, .15) * (.55 + .45 * dot(outgoingLight, vec3(.333))), (1. - sAO) * .7 * uAOk);   // (daylight: the crevices in deep forest)
        #include <opaque_fragment>`);
    };
    spineMat.customProgramCacheKey = () => 'formula-rim-v1';
    spine = new THREE.InstancedMesh(vg, spineMat, NV);
    { const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
      for (let i = 0; i < NV; i++) {
        const y = TOP - i * GAP;
        e.set(0, i * (Math.PI / 3) + Math.sin(i * 0.7) * 0.1, 0);   // the chain twists 60 degrees per ring
        m.compose(v.set(Math.sin(y * 0.16) * 0.05, y, Math.cos(y * 0.13) * 0.04), q.setFromEuler(e), sc.set(1, 1, 1)); spine.setMatrixAt(i, m);
      } }
    spine.frustumCulled = false;
    spineHolder = new THREE.Group(); spineHolder.add(spine); spineHolder.scale.setScalar(1.5);
    tower.add(spineHolder);
    // --- spectral threads wound round the column (they replace the old rainbow confetti): a double helix of two fine
    // threads of light on one slow spiral (the cards' handedness), each in a soft aura of dust, a twisting ribbon of
    // finer dust between them and a few loose motes, all following the column's own axis and spin. Brand hues only
    // (violet, berry, cyan) through a thin film that shifts along the strand, with the viewing angle and in time; the
    // threads flow as one (their beads keep their spacing) while pulses of light run down them. In focus a crisp
    // point, out of focus an even disc with a delicate brighter rim. Night: additive spectral light. Daylight:
    // ink-cored discs in a faint coloured halo, normal blending (themeTower). Fewer particles than the confetti had.
    const NP = mobile ? 760 : 2000;
    const PY0 = -18.5, PY1 = 7, PSPAN = PY1 - PY0;      // the strands' span (the column runs ~ -17.6 .. 5.5)
    const AX_N = 28, AX_Y0 = -21;                       // the column's axis, one sample per unit of height
    const axNow = Array.from({ length: AX_N }, () => new THREE.Vector2()), axTo = axNow.map(() => new THREE.Vector2());
    const pos = new Float32Array(NP * 3), strand = new Float32Array(NP * 4), seed = new Float32Array(NP);
    const nrm = () => { let s = 0; for (let k = 0; k < 4; k++) s += Math.random(); return (s - 2) * 1.73; };   // ~N(0, 1)
    // position = (across, height, out), aP = (phase, radius, hue, size), aSeed = kind (0 thread, 1 aura, 2 ribbon, 3 mote) + random
    let pi = 0;
    const put = (kind, ph, r, hue, w, y, e, size) => { pos.set([w, y, e], pi * 3); strand.set([ph, r, hue, size], pi * 4); seed[pi++] = kind + Math.random() * 0.999; };
    const nCore = Math.round(NP * 0.27), nAura = Math.round(NP * 0.1), nRib = Math.round(NP * 0.14);
    for (const [ph, hue] of [[0, 0], [Math.PI, 0.5]]) {
      for (let j = 0; j < nCore; j++) put(0, ph, 2.6, hue, nrm() * 0.03, PY0 + ((j + 0.5 + (Math.random() - 0.5) * 0.6) / nCore) * PSPAN, nrm() * 0.025, 0.7 + Math.random() * 1.1);
      for (let j = 0; j < nAura; j++) put(1, ph, 2.6, hue, nrm() * 0.16, PY0 + Math.random() * PSPAN, nrm() * 0.12, 0.9 + Math.random() * 1.2);
    }
    for (let j = 0; j < nRib; j++) put(2, Math.PI / 2, 3.15, 0.25, Math.max(-2.4, Math.min(2.4, nrm())) * 0.2, PY0 + Math.random() * PSPAN, nrm() * 0.05, 0.3 + Math.random() * 0.8);
    while (pi < NP) put(3, (pi % 3) * 2.094, 2.8, Math.random(), nrm() * 0.8, PY0 + Math.random() * PSPAN, 0.2 + Math.abs(nrm()) * 0.5, 1.8 + Math.random() * 2.2);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); pg.setAttribute('aP', new THREE.BufferAttribute(strand, 4)); pg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const C3 = (h) => new THREE.Color(h), F1 = (v) => v.toFixed(1);
    petalsMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPR: { value: Q.dpr }, uFocus: { value: 10 }, uLt: { value: 0 }, uSpin: { value: 0 }, uFadeLo: { value: -1.4 }, uAx: { value: axNow },
        uDA: { value: C3(0xa4e335) }, uDB: { value: C3(0x2fd6c3) }, uDC: { value: C3(0xd9f99d) }, uLA: { value: C3(0x3f7f0e) }, uLB: { value: C3(0x0b6b5e) }, uLC: { value: C3(0x0e7c6b) } },
      vertexShader: `attribute vec4 aP; attribute float aSeed; uniform float uTime, uPR, uFocus, uLt, uSpin, uFadeLo; uniform vec2 uAx[${AX_N}];
        uniform vec3 uDA, uDB, uDC, uLA, uLB, uLC; varying vec3 vC, vC2; varying float vA, vSoft, vGlint, vInk;
        vec2 axisAt(float y){   // Catmull-Rom through the axis samples, turned with the column
          float f = clamp(y - ${F1(AX_Y0)}, 0., ${F1(AX_N - 1)}); int i = int(min(floor(f), ${F1(AX_N - 2)})); float t = f - float(i);
          vec2 p0 = uAx[max(i - 1, 0)], p1 = uAx[i], p2 = uAx[i + 1], p3 = uAx[min(i + 2, ${AX_N - 1})];
          vec2 c = .5 * (2. * p1 + (p2 - p0) * t + (2. * p0 - 5. * p1 + 4. * p2 - p3) * t * t + (3. * p1 - p0 - 3. * p2 + p3) * t * t * t);
          float cs = cos(uSpin), sn = sin(uSpin); return vec2(c.x * cs + c.y * sn, c.y * cs - c.x * sn); }
        vec3 film(float h, vec3 a, vec3 b, vec3 c){   // violet > berry > violet > cyan: never berry straight into cyan (mud)
          h = fract(h) * 4.; float k = fract(h); k = k * k * (3. - 2. * k);
          return h < 1. ? mix(a, b, k) : h < 2. ? mix(b, a, k) : h < 3. ? mix(a, c, k) : mix(c, a, k); }
        void main(){
          float kind = floor(aSeed), sd = fract(aSeed), thread = step(kind, .5);
          float u = ${F1(PY0)} + mod(position.y - ${F1(PY0)} - uTime * mix(.05 + sd * .06, .08, thread), ${F1(PSPAN)});   // the dust flows down the strand
          float th = aP.x - u * .42 + uSpin + uTime * .025;
          float ph = u * .7 + aP.x * 1.7 + uTime * .11;   // the ribbon twists as it winds
          float w = position.x + sin(uTime * .45 + sd * 40.) * mix(.03, .008, thread);
          float rr = aP.y + .2 * sin(u * .45 + aP.x * 1.3 + uTime * .17) + position.z + w * cos(ph);
          float y = u + w * sin(ph) + sin(uTime * .5 + sd * 31.) * mix(.04, .01, thread);
          vec2 dir = vec2(sin(th), cos(th)), ax = axisAt(y);
          vec4 mv = modelViewMatrix * vec4(ax.x + dir.x * rr, y, ax.y + dir.y * rr, 1.); gl_Position = projectionMatrix * mv;
          float face = dot(normalize((modelViewMatrix * vec4(dir.x, 0., dir.y, 0.)).xyz), normalize(-mv.xyz));
          vSoft = smoothstep(1., 4.8, abs(-mv.z - uFocus));
          gl_PointSize = min((1.7 + aP.w * 1.4) * uPR * (uFocus / -mv.z) * (1. + vSoft * 3.) * (uLt > .5 ? 2.4 : 1.), 44. * uPR);
          float h = aP.z + u * .045 + face * .2 + uTime * .018;
          vC = uLt > .5 ? film(h, uLA, uLB, uLC) : film(h, uDA, uDB, uDC);
          vC2 = uLt > .5 ? film(h + .22, uLA, uLB, uLC) : film(h + .22, uDA, uDB, uDC);   // the film's next fringe: halos and bokeh rims
          vec2 nd = gl_Position.xy / gl_Position.w;
          float edge = smoothstep(${F1(PY0)}, ${F1(PY0 + 3)}, u) * smoothstep(${F1(PY1)}, ${F1(PY1 - 3)}, u)
            * smoothstep(1.06, .78, nd.y) * smoothstep(uFadeLo, uFadeLo + .32, nd.y);   // fades at the strands' ends, the screen's top, and above the phone's copy
          float pulse = .5 + .5 * sin(u * .9 + uTime * .42 + aP.x * 2.);   // pulses of light run down the threads
          float tw = .8 + .2 * sin(uTime * (.9 + sd * 1.8) + sd * 60.);
          float kA = kind < .5 ? 1. : kind < 1.5 ? .6 : kind < 2.5 ? .7 : .36;
          vA = edge * (.45 + .55 * pulse * pulse) * tw * kA / (1. + vSoft * (uLt > .5 ? .6 : 1.1)) * (uLt > .5 ? 1.5 : 1.15);
          vInk = kind < .5 ? 1. : kind < 2.5 ? .55 : 0.;
          vGlint = uLt > .5 ? 0. : pow(max(sin(uTime * (.3 + sd * .5) + sd * 90.), 0.), 40.) * step(.8, fract(sd * 7.13)) * thread * (1. - vSoft); }`,
      fragmentShader: `uniform float uLt; varying vec3 vC, vC2; varying float vA, vSoft, vGlint, vInk;
        void main(){ float d = length(gl_PointCoord - .5) * 2.; if (d > 1.) discard;
          float disc = smoothstep(1., .8, d), rim = smoothstep(.45, .92, d);
          if (uLt < .5) {   // night: a crisp spark with a hot centre in focus; out of focus an even disc with a brighter rim
            float prof = mix(exp(-d * d * 5.), disc * (.56 + .44 * smoothstep(.62, .9, d)), vSoft);
            vec3 c = mix(vC, vC2, rim * vSoft * .7) * (1. + vGlint) + vec3(.9, 1., .92) * exp(-d * d * 16.) * (1. - vSoft) * (.5 + vGlint);
            gl_FragColor = vec4(c, prof * vA); return; }
          // daylight: an ink core inside a faint halo of the film's next fringe; out of focus a soft pale film disc (no hard rim: on paper rims read as chain links)
          vec3 ink = vC * .36 + vec3(.006, .03, .02);
          float core = smoothstep(.44, .28, d) * vInk, halo = (1. - smoothstep(.15, 1., d)) * .55;
          float a = mix(max(core, halo), smoothstep(1., .55, d) * (.3 + .12 * rim), vSoft);
          vec3 c = mix(mix(vC2, vC, smoothstep(.75, .3, d)), ink, core);   // core ink, the film's own hue round it, the next fringe outside
          gl_FragColor = vec4(mix(c, mix(vC, vC2, d), vSoft), min(a * vA, 1.)); }`,
    });
    // the axis the strands wind round: the box centre of whichever column is showing, per unit of height (tower space,
    // before its spin), smoothed; a swap (procedural column -> anatomy) eases over instead of jumping
    let axSrc = null, axSnap = true;
    const fitAxis = (o) => {
      const hs = spineHolder.scale.x, box = axTo.map(() => [1e9, -1e9, 1e9, -1e9]), v = new THREE.Vector3();
      o.updateMatrix(); const M = o.matrix;
      const add = () => { v.applyMatrix4(M).multiplyScalar(hs); const q = box[Math.round(v.y - AX_Y0)]; if (!q) return;
        q[0] = Math.min(q[0], v.x); q[1] = Math.max(q[1], v.x); q[2] = Math.min(q[2], v.z); q[3] = Math.max(q[3], v.z); };
      if (o.isInstancedMesh) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const c = o.geometry.boundingBox.getCenter(new THREE.Vector3()), m = new THREE.Matrix4();
        for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); v.copy(c).applyMatrix4(m); add(); }
      } else { const p = o.geometry.attributes.position; for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); add(); } }
      const ok = box.map((q) => q[0] < 1e9); if (!ok.includes(true)) return;
      box.forEach((q, b) => { if (ok[b]) axTo[b].set((q[0] + q[1]) / 2, (q[2] + q[3]) / 2); });
      for (let b = 0; b < AX_N; b++) if (!ok[b]) { let n = 1; while (!ok[b - n] && !ok[b + n]) n++; axTo[b].copy(axTo[ok[b - n] ? b - n : b + n]); }
      for (let pass = 0; pass < 2; pass++) { const t = axTo.map((p) => p.clone()); for (let b = 0; b < AX_N; b++) axTo[b].copy(t[b]).multiplyScalar(0.5).addScaledVector(t[Math.max(b - 1, 0)], 0.25).addScaledVector(t[Math.min(b + 1, AX_N - 1)], 0.25); }
    };
    petalsMat.userData.tick = (t, dt) => {
      const u = petalsMat.uniforms; u.uTime.value = t; u.uSpin.value = spineHolder.rotation.y;
      const src = spineIn ? spineMesh : spine; if (src && src !== axSrc) { axSrc = src; fitAxis(src); }
      const k = axSnap ? 1 : 1 - Math.exp(-dt * 1.5); axSnap = false; for (const [b, p] of axNow.entries()) p.lerp(axTo[b], k);
      const tp = tower.position, ts = tower.scale.x;
      u.uFocus.value = Math.max(4, Math.hypot(camera.position.x - tp.x, camera.position.z - tp.z) - 2.6 * ts);   // the strands' near side is sharp
      u.uFadeLo.value = portrait() ? -0.42 : -1.4;
    };
    const petals = new THREE.Points(pg, petalsMat); petals.frustumCulled = false; tower.add(petals);
    // --- glass card slabs: a thick rounded slab catches the light on its bevels, the frosted face sits on its front
    const slabGeo = new RoundedBoxGeometry(CARD_W, CARD_H, CARD_D, mobile ? 3 : 5, 0.34);
    const faceGeo = new THREE.PlaneGeometry(CARD_W - 0.02, CARD_H - 0.02, 1, 1);
    GAMES.forEach((game, i) => {
      const tint = new THREE.Color(game.c[0]).lerp(new THREE.Color(0xa9c4c0), 0.72);
      const slabMat = LITE
        ? new THREE.MeshStandardMaterial({ color: tint, metalness: 0.15, roughness: 0.22, transparent: true, opacity: 0.42, envMapIntensity: 1.5, depthWrite: false })
        : new THREE.MeshPhysicalMaterial({ color: tint, metalness: 0.08, roughness: 0.12, transparent: true, opacity: 0.4, envMapIntensity: 1.8, depthWrite: false });
      slabMat.userData.night = slabMat.color.getHex(); slabMat.userData.day = new THREE.Color(game.c[0]).lerp(new THREE.Color(0xf7faf2), 0.62).getHex();
      // (daylight: the slab is a pane of iridescent glass, not a board: its faces almost clear, its edges and bevels
      // holding the alpha, a thin film along them; SLAB_LT 0 at night: nothing changes)
      slabMat.onBeforeCompile = (sh) => {
        sh.uniforms.uSlabLt = SLAB_LT;
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n        uniform float uSlabLt;')
          .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          if (uSlabLt > 0.) { float sfr = pow(1. - abs(dot(normal, normalize(vViewPosition))), 1.4);
            vec3 sf = sfr < .5 ? mix(vec3(.62, .86, .25), vec3(.25, .83, .75), sfr * 2.) : mix(vec3(.25, .83, .75), vec3(.85, .96, .52), sfr * 2. - 1.);
            diffuseColor.a *= mix(1., .22 + .78 * sfr, uSlabLt); totalEmissiveRadiance += sf * sfr * .35 * uSlabLt; }`);
      };
      slabMat.customProgramCacheKey = () => 'slab-glass-v1';
      const slab = new THREE.Mesh(slabGeo, slabMat);
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: { uTex: { value: null }, uTitle: { value: BLANK_TEX }, uVid: { value: BLANK_TEX }, uPlay: { value: 0 }, uTime: { value: 0 }, uActive: { value: 0 }, uGlitch: { value: 0 }, uVis: { value: 0 }, uSeed: { value: i * 1.7 },
          uSize: { value: new THREE.Vector2(CARD_W, CARD_H) }, uLt: CARD_LT, uTint: { value: new THREE.Color(game.c[0]) } },
        vertexShader: 'varying vec2 vUv; varying vec3 vN, vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
        fragmentShader: `uniform sampler2D uTex, uTitle, uVid; uniform float uTime, uActive, uGlitch, uVis, uSeed, uPlay, uLt; uniform vec2 uSize; uniform vec3 uTint; varying vec2 vUv; varying vec3 vN, vV;
          float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
          float sdR(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
          void main(){
            vec2 uv = vUv; float act = smoothstep(0., 1., uActive);
            // away from focus the title smears into pixel streaks (the reference's back cards); in focus it resolves
            float g = uGlitch + (1. - act) * .07 * (1. - uLt);   // (the back cards: a faint smear, still legible; the card in focus: none at rest)
            float t = floor(uTime * 10.);
            float band = floor(uv.y * 34.);
            float smear = step(.6, rnd(vec2(band, t * .3 + uSeed))) * g;
            float off = (rnd(vec2(band, t + uSeed)) - .5) * smear * .3;
            vec2 guv = uv; guv.x += off; guv.x = mix(guv.x, floor(guv.x * 9.) / 9. + .05, smear * (1. - act) * .5);
            float ca = g * .014;   // (a colour fringe only while glitching: the photo stays clean in focus)
            vec3 img = vec3(texture2D(uTex, guv + vec2(ca, 0.)).r, texture2D(uTex, guv).g, texture2D(uTex, guv - vec2(ca, 0.)).b);
            vec3 art = img;
            img *= mix(.62, 1., act);
            // daylight: clear glass over the art in its own vivid colours: the build ships a clear daylight cut of the art
            // (build.mjs clearArt: no blur, no grade; cardTexture draws it as is), lifted a breath in colour; the frost only
            // in a narrow band at the glass's edge (a pearl frost with the film's tint over the art blurred), a breath more
            // on the cards away from focus (depth); the glass's thin film turns with the angle (violet -> aqua -> rose) in
            // its rim and a faint sheen
            float fa = dot(vN, vV);
            float fh = fract(uv.x * .55 + uv.y * .3 + fa * .9 + uSeed * .13 + uTime * .015);
            vec3 tf = fh < .3333 ? mix(vec3(.7, .9, .35), vec3(.4, .9, .82), fh * 3.) : fh < .6667 ? mix(vec3(.4, .9, .82), vec3(.88, .97, .6), fh * 3. - 1.) : mix(vec3(.88, .97, .6), vec3(.7, .9, .35), fh * 3. - 2.);
            vec2 p = (vUv - .5) * uSize; float d = sdR(p, uSize * .5 - .01, .34);
            vec3 sf = texture2D(uTex, guv, 4.).rgb;
            vec3 al = max(mix(vec3(dot(art, vec3(.2126, .7152, .0722))), art, 1.08), 0.);
            float frost = clamp(smoothstep(-.15, -.02, d) * .45 + (1. - act) * .12, 0., 1.);
            vec3 glass = mix(al, mix(sf, vec3(.96, .99, .96) * mix(vec3(1.), tf, .35), .55), frost);
            glass *= mix(vec3(1.), tf * 1.12, .08);
            img = mix(img, glass, uLt);
            // gameplay: the crisp video replaces the frosted art on the card in focus
            vec3 vid = texture2D(uVid, vUv).rgb; vid = mix(vid / 12.92, pow((vid + .055) / 1.055, vec3(2.4)), step(.04045, vid));   // sRGB -> linear
            img = mix(img, vid, uPlay);
            img *= 1. - uPlay * .5 * smoothstep(.5, 0., length((vUv - vec2(.23, .14)) * vec2(1., 1.7)));   // scrim under the corner title
            // title layer: centred while frosted, slides (smaller) into the lower-left corner while the video plays
            float tsc = mix(1., 2.15, uPlay); vec2 anchor = mix(vec2(.5), vec2(.25, .17), uPlay);
            vec2 tuv = (guv - anchor) * tsc + .5;
            vec4 tt = texture2D(uTitle, tuv) * step(0., tuv.x) * step(tuv.x, 1.) * step(0., tuv.y) * step(tuv.y, 1.);
            // (daylight: the ink title and its pearl halo; over the video the ink turns pearl-white and the halo goes)
            tt.a *= 1. - uLt * uPlay * smoothstep(.25, .75, dot(tt.rgb, vec3(.333)));
            tt.rgb = mix(tt.rgb, vec3(.93, .92, .98), uLt * uPlay);
            img = mix(img, tt.rgb, tt.a);
            float mask = 1. - smoothstep(-.01, .01, d);
            float fres = pow(1. - abs(dot(vN, vV)), 3.); img += mix(vec3(.6, .75, .8), tf, uLt) * fres * mix(.18, .5, uLt);
            float streak = smoothstep(.12, 0., abs(uv.x * .75 + uv.y - 1.15 - sin(uTime * .25 + uSeed) * .55)) * .05;
            img += streak * mix(vec3(1.), mix(vec3(.4, 2., 1.6), vec3(1.6, 2.2, .5), uv.y) * 2.2, uLt);   // (daylight: a thin-film streak)
            // (daylight: the glass's rim catches the film, a bright spectral hairline round the card)
            img += tf * uLt * .7 * (1. - smoothstep(-.035, -.004, d)) * smoothstep(-.065, -.035, d) * (1. - uPlay * .5);
            img = mix(img, vec3(.04, .2, .15), uLt * .42 * smoothstep(-.024, -.012, d));   // (and a deep ink edge: the glass's outline on paper)
            float gr = rnd(floor(vUv * vec2(520., 330.)) + fract(uTime * .5));
            img *= .985 + .03 * gr;   // (a breath of grain on the glass; the photo stays clean)
            gl_FragColor = vec4(img, mask * mix(mix(mix(.7, .95, uLt), mix(.92, 1., uLt), act), 1., uPlay) * uVis);
          }`,
      });
      const face = new THREE.Mesh(faceGeo, mat); face.position.z = CARD_D / 2 + 0.004; face.renderOrder = 2; slab.renderOrder = 1;
      const grp = new THREE.Group(); grp.add(slab, face);
      const a = i * G_ANG; grp.position.set(Math.sin(a) * G_RC, -i * G_DY, Math.cos(a) * G_RC);
      grp.rotation.set(-0.05, a + 0.38, Math.sin(i * 1.3) * 0.05); grp.userData = { a, slabMat };
      cards.push(face); cardGroups.push(grp); tower.add(grp);
    });
    themeTower();
  };
  scene.add(tower);

  // Real anatomy replaces the procedural column once loaded: NIH 3D 3DPX-016835 "Spine_Human Skeleton"
  // (My Segmenter, CC BY 4.0). 24 vertebrae are dequantised, merged into one mesh (one draw call) and
  // scaled so C1..L5 spans the whole descent; the procedural column stays as the fallback. The model is not on the
  // critical path: if it has landed by the warm-up it is swapped in before compiling; later, it is compiled and
  // uploaded off-screen first (lateSpine) and only then replaces the procedural column.
  const SPINE_TOP = 5.5, SPINE_BOT = -(GAMES.length - 1) * G_DY - 5.5;
  let spineMesh = null, spineIn = false;
  const spineSwap = () => { if (!spineMesh || spineIn) return; spineHolder.remove(spine); spineHolder.add(spineMesh); spineIn = true; if (LIGHT) whenIdle(bakeSpineAO); };
  const loadSpineModel = () => Promise.resolve();   // (lab2date: the formula chain is the column, nothing to load)

  /* the column's occlusion for daylight: per vertex, how much of the surface within R rises above its tangent plane (a
     crevice between two vertebrae, the root of a process: high; an open face or a ridge: none), relaxed over the mesh
     twice, stored as aAO (1 open .. 0 deep). Baked once, the first time daylight shows the column, in slices (yields
     between them: no long task); the night never needs it (uAOk 0) */
  const aoDone = new WeakSet(); let aoBusy = false;
  async function bakeAO(geo, R) {
    if (aoDone.has(geo) || geo.getAttribute('aAO')) return; aoDone.add(geo);
    const P = geo.attributes.position.array, Nn = geo.attributes.normal.array, N = P.length / 3, inv = 1 / R, R2 = R * R;
    const grid = new Map(), key = (x, y, z) => `${x},${y},${z}`;
    const step = Math.max(1, Math.round(N / 24000));   // occluders: a subsample is plenty
    for (let i = 0; i < N; i += step) { const k = key(Math.floor(P[i * 3] * inv), Math.floor(P[i * 3 + 1] * inv), Math.floor(P[i * 3 + 2] * inv)); let b = grid.get(k); if (!b) grid.set(k, (b = [])); b.push(i); }
    const occ = new Float32Array(N); let t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], nx = Nn[i * 3], ny = Nn[i * 3 + 1], nz = Nn[i * 3 + 2];
      const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv); let o = 0, ws = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const b = grid.get(key(cx + dx, cy + dy, cz + dz)); if (!b) continue;
        for (let q = 0; q < b.length; q++) {
          const j = b[q] * 3, vx = P[j] - x, vy = P[j + 1] - y, vz = P[j + 2] - z, d2 = vx * vx + vy * vy + vz * vz;
          if (d2 > R2 || d2 < 1e-12) continue;
          const d = Math.sqrt(d2), w = 1 - d / R, c = (vx * nx + vy * ny + vz * nz) / d;
          if (c > 0.08) o += (c - 0.08) * w; ws += w;
        }
      }
      occ[i] = ws > 0 ? o / ws : 0;
      if ((i & 2047) === 0 && performance.now() - t0 > 8) { await yieldNow(); t0 = performance.now(); }
    }
    // relax over the triangles (twice), then map: 1 open .. 0 deep
    const idx = geo.index ? geo.index.array : null;
    if (idx) for (let pass = 0; pass < 2; pass++) {
      const sum = new Float32Array(N), cnt = new Float32Array(N);
      for (let t = 0; t < idx.length; t += 3) { const a = idx[t], b = idx[t + 1], c = idx[t + 2], m = (occ[a] + occ[b] + occ[c]) / 3; sum[a] += m; sum[b] += m; sum[c] += m; cnt[a]++; cnt[b]++; cnt[c]++; }
      for (let i = 0; i < N; i++) if (cnt[i]) occ[i] = occ[i] * 0.4 + (sum[i] / cnt[i]) * 0.6;
      await yieldNow();
    }
    const ao = new Float32Array(N);
    for (let i = 0; i < N; i++) { const v = Math.min(1, Math.max(0, (occ[i] - 0.015) / 0.16)); ao[i] = 1 - v * v * (3 - 2 * v); }
    geo.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
  }
  const bakeSpineAO = () => {
    if (aoBusy || !spine) return; aoBusy = true;
    const jobs = [[spine.geometry, 0.16]];
    if (spineMesh) { const bb = spineMesh.geometry.boundingBox; jobs.push([spineMesh.geometry, (bb.max.y - bb.min.y) / 70]); }
    (async () => { for (const [g, r] of jobs) await bakeAO(g, r); })().catch((e) => console.warn('spine occlusion', e)).finally(() => { aoBusy = false; if (spineMesh && !aoDone.has(spineMesh.geometry)) whenIdle(bakeSpineAO); });
  };

  // camera pose for the games station: on the circle around the column, at the active card's height,
  // turned a little past the card so the column stays visible beside it
  const GP = { pos: [0, 0, 0], look: [0, 0, 0] };
  const gamesSnap = (af) => { const i = Math.floor(af); return i + smooth(0.1, 0.9, af - i); };
  const gamesPose = (af) => {
    const p = portrait(); const tp = tower.position, ts = tower.scale.x;
    const a = af * G_ANG; const off = p ? 0.16 : 0.6; const R = p ? 16.5 : 12.8;
    const ca = a + off; const y = tp.y - af * G_DY * ts;
    GP.pos[0] = tp.x + Math.sin(ca) * R; GP.pos[1] = y + (p ? 1.6 : 0.7); GP.pos[2] = tp.z + Math.cos(ca) * R;
    const la = a + off * 0.5, lr = p ? 0.8 : 0.4;
    GP.look[0] = tp.x + Math.sin(la) * lr; GP.look[1] = y + (p ? -1.9 : -0.15); GP.look[2] = tp.z + Math.cos(la) * lr;
    return GP;
  };

  /* the scene's two tweens (the card glitch, the intro logo assembling): uniform.value from -> to, eased, on rAF time.
     A frame that took over half a second counts as one ordinary frame (like GSAP's lag smoothing), and a new tween on the
     same uniform replaces the running one. */
  const EASE = { power3Out: (k) => 1 - Math.pow(1 - k, 3), sineOut: (k) => Math.sin((k * Math.PI) / 2) };
  const tweening = new Map();
  const tween = (u, from, to, dur, ease, done) => {
    const id = {}; tweening.set(u, id); u.value = from; let el = 0, last = performance.now();
    const step = (now) => {
      if (tweening.get(u) !== id) return;
      const d = now - last; last = now; el += d > 500 ? 33 : d;
      const k = Math.min(1, el / (dur * 1000)); u.value = from + (to - from) * ease(k);
      if (k < 1) requestAnimationFrame(step); else { tweening.delete(u); if (done) done(); }
    };
    requestAnimationFrame(step);
  };
  hooks.cardGlitch = (i) => {
    const c = cards[i]; if (!c || reduced) return;
    tween(c.material.uniforms.uGlitch, 0.7, 0, 0.45, EASE.power3Out);
  };

  /* landscape card face: official wide art seen through frosted glass, grain, crisp mono title with colour fringe.
     The build ships the art already frosted (cover-cropped to the card, blurred and graded exactly like the
     canvas filter below: game.art), so the page only lays the grain and vignette over it; a raw image (game.wide
     only) still goes through the filter here. */
  const CANVAS_FILTER = 'filter' in CanvasRenderingContext2D.prototype;
  // (daylight, light = true: no mottling and no vignette, the art stays clean: the card's shader keeps the frost to the
  // glass's edges. clear = img is the build's clear daylight cut (game.artLt); a raw image is cover-cropped unfiltered)
  /* the card's art: the category's photo whole and sharp in a rounded frame on the right (product photos come in every
     shape and size: cropping them to the card zoomed portraits until they broke up), over an ambient fill of the same
     photo blurred and dark; the left side shaded for the title. No photo: a structural formula in the category's colour */
  const FACE_W = mobile ? 768 : 1024;
  const texAniso = () => Math.min(8, renderer.capabilities.getMaxAnisotropy());
  function cardTexture(game, i, img) {
    const W = FACE_W, H = Math.round(W * (CARD_H / CARD_W)), u = W / 1024;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    g.fillStyle = game.c[1]; g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    if (img && img.naturalWidth) {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      // the ambient fill: the photo cover-cropped, heavily blurred and dark
      const sc = Math.max(W / iw, H / ih) * 1.15, cw = iw * sc, ch = ih * sc;
      if (CANVAS_FILTER) { g.filter = `blur(${Math.round(26 * u)}px) saturate(1.15) brightness(.42)`; g.drawImage(img, (W - cw) / 2, (H - ch) / 2, cw, ch); g.filter = 'none'; }
      else { g.globalAlpha = 0.35; g.drawImage(img, (W - cw) / 2, (H - ch) / 2, cw, ch); g.globalAlpha = 1; }
      // the title's side shaded
      const sh = g.createLinearGradient(0, 0, W, 0);
      sh.addColorStop(0, 'rgba(3,14,12,.94)'); sh.addColorStop(0.42, 'rgba(3,14,12,.72)'); sh.addColorStop(0.62, 'rgba(3,14,12,.18)'); sh.addColorStop(1, 'rgba(3,14,12,.05)');
      g.fillStyle = sh; g.fillRect(0, 0, W, H);
      // the photo itself, contained (never upscaled past 1.6x), in a rounded frame
      const bx = W * 0.45, by = H * 0.08, bw = W * 0.5, bh = H * 0.84;
      const k = Math.min(bw / iw, bh / ih, 1.6), dw = iw * k, dh = ih * k, dx = bx + (bw - dw) / 2, dy = by + (bh - dh) / 2, rr = 16 * u;
      g.save(); g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = 30 * u; g.shadowOffsetY = 10 * u;
      g.beginPath(); g.roundRect(dx, dy, dw, dh, rr); g.fillStyle = '#0a1513'; g.fill(); g.restore();
      g.save(); g.beginPath(); g.roundRect(dx, dy, dw, dh, rr); g.clip(); g.drawImage(img, dx, dy, dw, dh); g.restore();
      g.strokeStyle = 'rgba(255,255,255,.1)'; g.lineWidth = 1.5 * u; g.beginPath(); g.roundRect(dx, dy, dw, dh, rr); g.stroke();
    } else {
      g.save(); g.strokeStyle = game.c[0]; g.globalAlpha = 0.28; g.lineWidth = 3 * u; g.lineJoin = 'round';
      const hex = (cx, cy, r) => { g.beginPath(); for (let k = 0; k <= 6; k++) { const an = Math.PI / 6 + (k * Math.PI) / 3; g[k ? 'lineTo' : 'moveTo'](cx + Math.cos(an) * r, cy + Math.sin(an) * r); } g.stroke(); };
      const r = H * 0.16, x0 = W * (0.52 + 0.04 * (i % 3)), y0 = H * 0.5;
      for (let k = 0; k < 3; k++) { const cx = x0 + k * r * Math.sqrt(3), cy = y0 + (k % 2 ? r * 0.5 : -r * 0.5); hex(cx, cy, r); g.beginPath(); g.arc(cx, cy, r * 0.55, 0, Math.PI * 2); g.stroke(); }
      g.restore();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = texAniso(); t.generateMipmaps = true;
    return t;
  }

  /* the title layer (transparent), in the card's lower left (the upper left meets the page's station rail): the leading brands in mono, the category's name large in the mono
     face, its live count under it. Clean type with a soft shadow (the card's shader adds its glitch on a change) */
  function titleTexture(game) {
    const W = FACE_W, H = Math.round(W * (CARD_H / CARD_W)), u = W / 1024;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
    const x0 = W * 0.09, maxW = W * 0.33;
    const words = game.name.split(' '); const lines = []; let line = '';
    g.letterSpacing = `${Math.round(2 * u)}px`; g.font = `600 ${Math.round(64 * u)}px ${MONO}`;
    for (const w of words) { const tl = line ? `${line} ${w}` : w; if (g.measureText(tl).width > maxW && line) { lines.push(line); line = w; } else line = tl; }
    lines.push(line);
    const fs = Math.max(30 * u, Math.min(64 * u, Math.floor(64 * u * maxW / Math.max(...lines.map((l) => g.measureText(l).width)))));
    g.font = `600 ${fs}px ${MONO}`; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    const lh = fs * 1.08, last = H * 0.86 - (game.fa ? 44 * u : 0), top = last - (lines.length - 1) * lh;
    g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 16 * u; g.fillStyle = '#f2fff8';
    lines.forEach((l, k) => g.fillText(l, x0, top + k * lh));
    g.shadowBlur = 8 * u;
    if (game.plat && game.plat.length) {
      g.letterSpacing = `${Math.round(3 * u)}px`; g.font = `500 ${Math.round(17 * u)}px ${MONO}`; g.fillStyle = 'rgba(164,227,53,.92)';
      g.fillText(game.plat.join(' · ').toUpperCase(), x0, top - fs - 22 * u, maxW + W * 0.04);
    }
    if (game.fa) {
      g.letterSpacing = '0px'; g.font = `600 ${Math.round(24 * u)}px ${SANS}`; g.fillStyle = 'rgba(225,250,240,.82)';
      g.fillText(game.fa, x0, top + (lines.length - 1) * lh + 44 * u);
    }
    // a hairline under the brands, the HUD's accent
    g.shadowBlur = 0; g.fillStyle = 'rgba(164,227,53,.55)'; g.fillRect(x0, top - fs - 12 * u, 36 * u, 2 * u);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = texAniso(); t.generateMipmaps = true;
    return t;
  }

  /* official art: load every image, build textures once loaded (late images swap in) */
  const loadImg = (src) => new Promise((res) => { if (!src) return res(null); const im = new Image(); im.decoding = 'async'; im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
  const artImgs = GAMES.map(() => null); const cardArt = GAMES.map(() => null); let cardsReady = false;
  // each card's art in the theme's version (the other one is made on a switch, once)
  const artTex = GAMES.map(() => [null, null]);
  const setCardTex = (i) => {
    if (!live()) return;
    cardArt[i] = artImgs[i]; if (full) markB(`card-late-${i}`);
    const u = cards[i].material.uniforms; const old = artTex[i]; artTex[i] = [null, null];
    showArt(i); for (const t of old) if (t) t.dispose();
    if (u.uTitle.value === BLANK_TEX) setTitle(i);
  };
  const showArt = (i) => {
    if (!live()) return;
    const k = LIGHT ? 1 : 0; let t = artTex[i][k];
    if (!t) { const clr = k ? artImgsLt[i] : null; t = artTex[i][k] = cardTexture(GAMES[i], i, clr || artImgs[i], !!k, !!clr); renderer.initTexture(t); }
    cards[i].material.uniforms.uTex.value = t;
  };
  // daylight's clear art (game.artLt): fetched the first time the page is in daylight; a face that has it redraws once
  const artImgsLt = GAMES.map(() => null); let artLtLoads = null;
  const loadArtLt = () => {
    if (artLtLoads) return artLtLoads;
    artLtLoads = GAMES.map((g, i) => loadImg((mobile && g.artLtSm) || g.artLt).then((img) => {
      if (!img) return; artImgsLt[i] = img;
      if (cardsReady) whenIdle(() => { const old = artTex[i][1]; artTex[i][1] = null; if (LIGHT && cards[i].material.uniforms.uTex.value === old) showArt(i); if (old) old.dispose(); });
    }));
    return artLtLoads;
  };
  // each card's title in the theme's version (made on first need: a switch makes the other one once)
  const titles = GAMES.map(() => [null, null]);
  const setTitle = (i) => {
    const k = LIGHT ? 1 : 0; let t = titles[i][k];
    if (!t) { t = titles[i][k] = titleTexture(GAMES[i], !!k); renderer.initTexture(t); }
    cards[i].material.uniforms.uTitle.value = t;
  };

  /* gameplay video on the card in focus. One player (gv) plays the card in focus; a second one (sb, standby) holds the
     clip of the next card in the direction of travel, loaded and its first frame decoded, so when that card comes into
     focus the two swap and the clip moves at once (no load, no decoder start). Both unlocked by the first tap, so on
     iOS either can play with sound. Sound comes on with the first click / tap / key anywhere (browsers forbid
     autoplay with sound) or with the sound button. */
  const VIDEO_ON = false && !reduced && !params.has('novideo') && !(navigator.connection && (navigator.connection.saveData || /(^|-)2g$/.test(navigator.connection.effectiveType || '')));
  const mkPlayer = () => {
    const v = document.createElement('video');
    v.loop = true; v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    const t = new THREE.VideoTexture(v); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
    return [v, t];
  };
  let [gv, gvTex] = mkPlayer();
  let [sb, sbTex] = mkPlayer(); let sbIdx = -1, gvDir = 1;
  let gvIdx = -1, gvReady = false, gvBad = -1, gvFocus = false, gvDwell = 0, gvBlocked = false, soundOn = false, soundTouched = false;
  /* which encode: each game may carry 1600 / 1024 / 640 px wide clips (g.vids). The one picked is the smallest that is
     at least 1.2x the focused card's width in drawing-buffer pixels (measured through the camera when a clip starts,
     so viewport, DPR and the governor's resolution all count; the margin keeps the downscale crisp), capped by the
     connection: 3G-class or a slow downlink -> 640, a middling one -> 1024. Never below what the page always played
     (phones 640, everything else 1024) unless the line is slow: a 1366x768 laptop measures a ~490 px card, and the
     640 encode (lower bitrate) would look softer there than before. Big or high-DPI screens on a good line get the
     1600 encode when the game has one. */
  const VID_CAP = (() => {
    const c = navigator.connection || {}; const et = c.effectiveType || ''; const dl = +c.downlink || 0;
    if (/(^|-)[23]g$/.test(et) || (dl && dl < 1.5)) return 640;
    if (dl && dl < 5) return 1024;
    return 1600;
  })();
  // until a clip has started (and measured it), the card's width is estimated from the viewport: in focus it spans
  // 0.68 (landscape) / 0.4 (portrait) of the viewport's height (measured 1366x768 to 2560x1440 and 360-430 px phones),
  // so a clip fetched ahead, on the way to the games, is the encode the card will ask for
  // (the clip is sized for the screen's own pixels (up to 2x), not the governor's 3D resolution: a phone or laptop that
  // draws the scene at a lower resolution still gets a sharp clip)
  let vidNeed = 0;
  const vidPR = () => Math.max(Q.dpr, Math.min(devicePixelRatio || 1, 2));
  const need = () => vidNeed || (portrait() ? 0.4 : 0.68) * VH() * vidPR();
  const _ve = new THREE.Vector3();
  const cardPx = (i) => {
    const grp = cardGroups[i]; if (!grp) return need();
    grp.updateMatrixWorld(true); camera.updateMatrixWorld();
    const x0 = _ve.set(-CARD_W / 2, 0, 0).applyMatrix4(grp.matrixWorld).project(camera).x;
    const x1 = _ve.set(CARD_W / 2, 0, 0).applyMatrix4(grp.matrixWorld).project(camera).x;
    const px = Math.abs(x1 - x0) * 0.5 * VW() * vidPR();
    return Number.isFinite(px) && px > 50 ? px : need();
  };
  const vidSrc = (g) => {
    const v = g.vids || {}; const ok = [1600, 1024, 640].filter((w) => v[w] && w <= VID_CAP);
    if (!ok.length) { const any = [640, 1024, 1600].find((w) => v[w]); return any ? v[any] : (mobile ? g.videoSm || g.video : g.video || g.videoSm) || ''; }
    const want = Math.max(need() * 1.2, mobile ? 0 : 1024);
    const fit = [...ok].reverse().find((w) => w >= want);
    return v[fit || ok[0]];
  };
  // iOS keeps video.volume at 1 (read-only): there the sound is gated by mute instead of faded
  const volLocked = (() => { try { gv.volume = 0.5; const l = gv.volume !== 0.5; gv.volume = 1; return l; } catch (e) { return true; } })();
  const blobUrls = new Map();   // src -> blob: URL (prefetched clips, and the single file's inlined ones)
  const playable = (src) => {
    const c = blobUrls.get(src); if (c) return c;
    if (!src.startsWith('data:')) return src;
    // single file, clip not prefetched yet: decode now (prefetchVid normally does this off the main thread)
    const bin = atob(src.slice(src.indexOf(',') + 1)); const arr = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
    const u = URL.createObjectURL(new Blob([arr], { type: 'video/mp4' })); blobUrls.set(src, u);
    return u;
  };
  for (const v of [gv, sb]) {
    v.addEventListener('playing', () => { if (v === gv) { gvReady = true; gvBlocked = false; } });   // once a clip shows a frame it stays up; a stall just holds the frame
    v.addEventListener('error', () => { if (v === gv) { gvBad = gvIdx; gvReady = false; } else sbIdx = -1; });
  }
  const sndBtn = $('#wk-sound'); if (sndBtn && !VIDEO_ON) sndBtn.hidden = true;
  const showSound = () => { if (sndBtn) { sndBtn.setAttribute('aria-pressed', String(soundOn)); sndBtn.classList.toggle('on', soundOn); } };
  // play(). Refused with sound: keep the picture, muted. Refused even muted (iOS Low Power Mode, thermal
  // limits): stop asking every frame and wait for the next tap, which may start it (pointerup below).
  const tryPlay = () => gv.play().then(() => { gvBlocked = false; }).catch((e) => {
    if (!e || e.name !== 'NotAllowedError') return;
    if (!gv.muted) { gv.muted = true; soundOn = false; showSound(); tryPlay(); return; }
    gvBlocked = true;
  });
  on(window, 'pointerup', () => { if (gvBlocked && gvFocus) { gvBlocked = false; tryPlay(); } }, true);   // a tap, never a scroll (that ends in pointercancel)
  // inside a gesture: play a paused player once so iOS unlocks it for sound. This is done muted (a muted play() unlocks
  // it just as well) so a first tap elsewhere never sounds, or stops the visitor's music; then it is left as it was
  // (the standby always muted)
  const unlock = (v) => {
    if (!v.src) return;
    if (!v.paused) { v.__ok = true; if (v === gv && gvFocus) v.muted = false; return; }
    v.muted = true;
    v.play().then(() => { v.__ok = true; if (v !== gv || !gvFocus) v.pause(); v.muted = v !== gv || !soundOn; }).catch(() => { v.muted = v !== gv || !soundOn; });
  };
  const setSound = (on) => {
    soundOn = on; showSound();
    if (!on || !VIDEO_ON) { gv.muted = true; return; }
    if (!gv.src) { const k = Math.max(0, gvIdx); const src = clipFor(GAMES[k] || {}); if (!src) return; gvIdx = k; gvReady = false; if (!blobUrls.has(src) && !src.startsWith('data:')) noFetch.add(src); gv.src = playable(src); }
    unlock(gv); unlock(sb);
  };
  if (sndBtn) on(sndBtn, 'click', () => { soundTouched = true; setSound(!soundOn); });
  const GESTURES = ['pointerdown', 'pointerup', 'keydown'];   // no touchend: the end of a scroll swipe fires one too
  const firstGesture = (e) => {
    if (soundTouched || (e.target && e.target.closest && e.target.closest('#wk-sound'))) return;
    const ua = navigator.userActivation;   // only an activating gesture (a tap, a click, a key; not a scroll) may unmute
    if (ua ? !ua.isActive : e.type === 'pointerdown' && e.pointerType !== 'mouse') return;
    soundTouched = true; GESTURES.forEach((ev) => window.removeEventListener(ev, firstGesture, true));
    if (VIDEO_ON) setSound(true);
  };
  if (VIDEO_ON) GESTURES.forEach((ev) => on(window, ev, firstGesture, true));
  // the render loop sleeps in a background tab, so the clip (and its sound) must be stopped here
  on(document, 'visibilitychange', () => { if (document.hidden && !gv.paused) gv.pause(); });
  // neighbours are fetched whole into blobs: Safari's media loader asks for byte ranges, which a plain fetch()
  // in the HTTP cache can never answer, so it would download every clip twice. data: URIs (single file) are
  // decoded by fetch() off the main thread. A clip on its way is never raced by a second download of it (below).
  const prefetched = new Map();   // src -> { got, total, t1, ctl } while it is on its way
  const noFetch = new Set();      // clips that failed, or that the player streamed itself (never downloaded a second time)
  const prefetchVid = (i) => {
    const g = GAMES[i]; const src = g && vidSrc(g); if (!src || prefetched.has(src) || blobUrls.has(src) || noFetch.has(src)) return;
    const job = { got: 0, total: 0, t1: performance.now(), ctl: src.startsWith('data:') ? null : new AbortController() }; prefetched.set(src, job);
    fetch(src, job.ctl ? { priority: 'low', signal: job.ctl.signal } : undefined).then(async (r) => {
      if (!r.ok) throw new Error(String(r.status));
      job.total = +r.headers.get('content-length') || 0; job.t1 = performance.now(); const parts = [];
      if (job.ctl && r.body && r.body.getReader) { const rd = r.body.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); job.got += value.length; } }
      else parts.push(await r.blob());
      if (!blobUrls.has(src)) blobUrls.set(src, URL.createObjectURL(new Blob(parts, { type: 'video/mp4' })));
    }).catch(() => { if (!(job.ctl && job.ctl.signal.aborted)) noFetch.add(src); }).finally(() => { if (prefetched.get(src) === job) prefetched.delete(src); });
  };
  // the clip to play for a game: the wanted encode, or a larger one already in memory / on its way
  const clipFor = (g) => {
    const src = vidSrc(g); if (blobUrls.has(src) || prefetched.has(src)) return src;
    const v = g.vids || {}; const w = +Object.keys(v).find((k) => v[k] === src) || 0;
    for (const k of [640, 1024, 1600]) if (k >= w && v[k] && (blobUrls.has(v[k]) || prefetched.has(v[k]))) return v[k];
    return src;
  };
  // video budget: only a device that falls under ~12 fps while a clip plays (a page that would no longer scroll) keeps
  // the frosted cards instead; anything faster keeps its clips (the governor sheds other work first)
  let vN = 0, vSlow = 0, vKilled = false;
  function updateVideos(af, dt, onStage) {
    const ai = Math.round(af); const focus = !vKilled && onStage && Math.abs(ai - af) < 0.3 && VIDEO_ON && !!vidSrc(GAMES[ai] || {});
    gvFocus = focus; gvDwell = focus ? gvDwell + dt : 0;
    // on the way to the games (from the first scroll down the intro, or the route coming back up): the clip of the card
    // the visitor arrives at is fetched ahead (one clip: 0.5 MB at 640, 1.2 MB at 1024) and loaded into the player (its
    // first frame decoded), so it starts the moment the card is in focus. A 3G-class line needs the whole way for it.
    const onWay = (state.active >= 1 && state.active <= 3) || (state.active === 0 && scrollNow() > VH() * 0.3);
    if (!onStage && gvIdx < 0 && VIDEO_ON && !vKilled && onWay) {
      const e = clamp(ai, 0, GAMES.length - 1); const s = GAMES[e] && clipFor(GAMES[e]);   // af: 0 above the games, the last card below
      if (s && blobUrls.has(s)) { gvIdx = e; gvReady = false; gv.muted = !soundOn; gv.src = blobUrls.get(s); } else if (s) prefetchVid(e);
    }
    // a card has to hold the focus for a beat before its clip is streamed: flying past cards never starts (and
    // downloads) their clips. A clip in memory or on its way starts at once.
    const want = focus ? vidSrc(GAMES[ai]) : '';
    if (focus && gvIdx !== ai && sbIdx === ai && (!soundOn || !volLocked || sb.__ok)) {
      // the standby holds this card's clip: swap the players (the one leaving keeps its frame for its fade-out and
      // stays loaded, should the visitor turn back)
      gv.pause(); gv.muted = true;
      [gv, sb] = [sb, gv]; [gvTex, sbTex] = [sbTex, gvTex];
      if (gvIdx >= 0) gvDir = ai > gvIdx ? 1 : -1;
      sbIdx = gvIdx; gvIdx = ai; gvReady = false; gvBad = -1; gv.muted = !soundOn; vidNeed = cardPx(ai); tryPlay();
    } else if (focus && gvIdx !== ai && gvDwell > 0.35 && want.startsWith('data:') && !blobUrls.has(want)) prefetchVid(ai);
    else if (focus && gvIdx !== ai && (gvDwell > 0.35 || blobUrls.has(clipFor(GAMES[ai])) || prefetched.has(clipFor(GAMES[ai])))) {
      vidNeed = cardPx(ai);
      const src = clipFor(GAMES[ai]); const job = prefetched.get(src);
      // on its way: about to be in (under half a second at the speed it arrives, 1.5 s on a 3G-class line where a fresh
      // stream takes about as long to show a frame, or 70 % in) -> wait for it; otherwise drop it and stream the clip now
      if (job && job.ctl) {
        const ms = performance.now() - job.t1; const eta = job.total && job.got && ms > 40 ? (job.total - job.got) / (job.got / ms) : Infinity;
        if (!(eta < (VID_CAP <= 640 ? 1500 : 500) || (job.total && job.got > job.total * 0.7))) { job.ctl.abort(); prefetched.delete(src); }
      }
      if (!prefetched.has(src)) {
        if (!blobUrls.has(src) && !src.startsWith('data:')) noFetch.add(src);
        if (gvIdx >= 0) gvDir = ai > gvIdx ? 1 : -1;
        if (sbIdx === ai) sbIdx = -1;
        gvIdx = ai; gvReady = false; gv.muted = !soundOn; gv.src = playable(src); tryPlay();
      }
    }
    // once the clip in focus plays (so nothing competes with its start): the neighbours are fetched ahead, and the one
    // in the direction of travel (else the other) is loaded into the standby, its first frame decoded
    if (focus && gvIdx === ai && gvReady) {
      prefetchVid(ai + 1); prefetchVid(ai - 1);
      // (not while the card it holds is still fading out)
      for (const k of (sbIdx >= 0 && cards[sbIdx] && cards[sbIdx].material.uniforms.uPlay.value > 0.01) ? [] : [ai + gvDir, ai - gvDir]) {
        const g = GAMES[k]; if (!g) continue;
        const s = clipFor(g); const b = blobUrls.get(s); if (!b) continue;
        if (sbIdx !== k || sb.src !== b) { sb.pause(); sb.muted = true; sb.src = b; sbIdx = k; }
        break;
      }
    }
    if (!focus && !gv.paused) gv.pause();
    if (focus && gv.paused && gvIdx === ai && gvBad !== ai && !gvBlocked) tryPlay();
    if (!gvReady && gvIdx >= 0 && gv.readyState >= 2 && gv.currentTime > 0) gvReady = true;
    if (focus && gvReady && !gv.paused) {
      vN++; if (dt > 0.08) vSlow++;
      if (vN >= 150) { if (vSlow > vN * 0.6) { vKilled = true; gv.pause(); if (sndBtn) sndBtn.hidden = true; } vN = vSlow = 0; }
    }
    cards.forEach((c, i) => {
      const u = c.material.uniforms; const want = focus && i === gvIdx && gvReady ? 1 : 0;
      u.uPlay.value = lerp(u.uPlay.value, want, 1 - Math.exp(-dt * (want ? 5 : 9)));
      u.uVid.value = u.uPlay.value > 0.001 ? (i === gvIdx ? gvTex : i === sbIdx ? sbTex : BLANK_TEX) : BLANK_TEX;
    });
    const pv = gvIdx >= 0 ? cards[gvIdx].material.uniforms.uPlay.value : 0;
    if (soundOn) {   // the clip's sound swells in and out with the picture; iOS: on once the picture is mostly up
      if (!volLocked) gv.volume = Math.min(1, pv);
      else { const m = pv < 0.5; if (gv.muted !== m) gv.muted = m; }
    }
  }
  // the warm-up waits a moment for the art (it is small now: the build ships it frosted); a face that lands later is redrawn when idle
  let artLoads = [];
  const loadArt = () => { artLoads = GAMES.map((g, i) => loadImg((mobile && g.artSm) || g.art || g.wide).then((img) => { artImgs[i] = img; if (img && cardsReady) whenIdle(() => setCardTex(i)); })); if (LIGHT) artLoads.push(...loadArtLt()); };

  /* ---------- route: Black Marble night globe (src/globe.js)
     Never on the critical path and never allowed to hold the boot screen: its 0.25-0.55 MB of textures are
     fetched at low priority after first paint (or, with Save-Data / 2G, only once the visitor is within one
     station of the route) and decoded off the main thread; its programs compile in parallel
     (KHR_parallel_shader_compile) for the composer's render-target state. If it is fully compiled before the
     boot screen lifts it is warmed with the other stations behind it; otherwise textures upload one per frame
     and its meshes are drawn a few per frame offscreen. Either way scrolling to it never compiles anything,
     and when it does arrive while on screen it fades in instead of popping. */
  const globeHolder = new THREE.Group(); globeHolder.name = 'globeHolder'; globeHolder.visible = false;
  let globeBaseS = 1, globeBaseX = 0;
  scene.add(globeHolder);
  // literal paths: build.mjs inlines every assets/... reference for the single-file build. That build is
  // compiled with __SINGLE_FILE__ = true, so the desktop set below is dropped from it and only the ~250 KB
  // phone set is inlined (the hosted build serves both sets as separate cacheable files).
  // (daylight's atlas, globe_light_assets.py: fetched only when the page is in daylight; the route's box at the 4096 map's
  // resolution on every device, the global atlas at 1k on phones)
  const LIGHT_GLOBE = (big) => ({
    atlas: big ? ASSET('globe/atlas_2k', '/home3d/globe/atlas_2k.jpg') : ASSET('globe/atlas_1k', '/home3d/globe/atlas_1k.jpg'),
    atlasRegion: ASSET('globe/atlas_region', '/home3d/globe/atlas_region.jpg'), borders: ASSET('globe/borders', '/home3d/globe/borders-50m.json'),
    atlasBox: [-15.0293, 79.9805, 12.0410, 69.9609],   // lon0, lon1, lat0, lat1 (the night's region box: see globe_assets.py)
  });
  const LOW_GLOBE = () => ({
    night: ASSET('globe/night_1k', '/home3d/globe/night_1k.webp'), lights: ASSET('globe/lights_1k', '/home3d/globe/lights_1k.webp'), day: ASSET('globe/day_1k', '/home3d/globe/day_1k.webp'),
    pack: ASSET('globe/pack_1k', '/home3d/globe/pack_1k.jpg'), ...LIGHT_GLOBE(false),
  });
  const GLOBE_FILES = mobile ? LOW_GLOBE() : LITE ? {
    ...LOW_GLOBE(), regionNight: ASSET('globe/region_night', '/home3d/globe/region_night.webp'), regionLights: ASSET('globe/region_lights', '/home3d/globe/region_lights.webp'),
    regionBox: [-15.0293, 79.9805, 12.0410, 69.9609],
  } : {
    night: ASSET('globe/night_2k', '/home3d/globe/night_2k.webp'), lights: ASSET('globe/lights_2k', '/home3d/globe/lights_2k.webp'), day: ASSET('globe/day_2k', '/home3d/globe/day_2k.webp'),
    pack: ASSET('globe/pack_1k', '/home3d/globe/pack_1k.jpg'),
    regionNight: ASSET('globe/region_night', '/home3d/globe/region_night.webp'), regionLights: ASSET('globe/region_lights', '/home3d/globe/region_lights.webp'),
    regionBox: [-15.0293, 79.9805, 12.0410, 69.9609], // lon0, lon1, lat0, lat1 (see globe_assets.py)
    ...LIGHT_GLOBE(true),
  };
  let globe = null; let nodeChip = null, nodeOn = 0, nodeO = -1, nodeX = -1e4, nodeY = -1e4; let globeState = 'idle'; // idle > loading > compiling > upload > warm > ready | failed
  // the downloads start right here, before the rest of the scene is built (low priority, nothing waits on
  // them); createGlobe() later consumes these responses. Each body is read exactly once.
  const globePrefetch = new Map();
  const globeFetch = (url) => {
    const r = globePrefetch.get(url); globePrefetch.delete(url);
    return r || fetch(url, { priority: 'low' });
  };
  const lazyQA = params.has('lazyglobe');
  const conn = navigator.connection || {};
  const frugal = !!conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '');
  const prefetchGlobe = () => {
    if (lazyQA || frugal) return;
    for (const k of ['night', 'lights', 'day', 'pack', 'regionNight', 'regionLights', ...(LIGHT ? ['atlas', 'atlasRegion', 'borders'] : [])]) {
      if (!GLOBE_FILES[k]) continue;
      const r = fetch(GLOBE_FILES[k], { priority: 'low' }); r.catch(() => {}); // createGlobe reports failures
      globePrefetch.set(GLOBE_FILES[k], r);
    }
  };
  let globeLoad = null; let warmList = null; let warmRT = null;
  const globeUploads = [];
  const geoEl = $('#geo'); let geoLabels = [];
  function startGlobe() {
    if (DEBUG && params.has('noglobe')) return null;   // (QA: the route without its globe)
    if (!globeLoad) globeLoad = loadGlobe();
    return globeLoad;
  }
  const mark = (n) => { try { performance.mark(`globe:${n}`); } catch (e) { /* old browsers */ } };
  async function loadGlobe() {
    globeState = 'loading'; mark('start');
    try {
      globe = await createGlobe({ renderer, files: GLOBE_FILES, quality: mobile ? 'low' : 'high', reduced, fetcher: globeFetch, texts: { labs: TEXT.globe_labs, hub: CFG.hub, lanes: CFG.lanes }, light: LIGHT });
      if (!live()) { globe.dispose(); globe = null; return; }
      globeHolder.add(globe.group); mark('created'); globeState = 'compiling';
      if (globe.setTheme) globe.setTheme(LIGHT);
      if (globe.anchors && globe.anchors.shelter && geoEl) {   // the hub: a glass chip with the brand mark (crisp at any DPR)
        nodeChip = document.createElement('div'); nodeChip.className = 'geo-node';
        nodeChip.innerHTML = '<i></i><b><svg viewBox="0 0 64 46" aria-hidden="true"><g fill="url(#l2d-mark-grad)"><circle cx="8" cy="31" r="2.4"/><circle cx="17" cy="22" r="3.6"/><circle cx="27" cy="11" r="6.2"/><circle cx="38" cy="16" r="4.4"/><circle cx="47" cy="24" r="3.2"/><circle cx="55" cy="31" r="2.2"/></g></svg><em></em></b>';
        nodeChip.querySelector('em').textContent = TEXT.geo_node || 'Labtodate hub · Netherlands';
        geoEl.appendChild(nodeChip);
      }
      layoutGlobe();
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(composer.renderTarget1); // compile the variants the RenderPass will ask for
      const ready = renderer.compileAsync(globe.group, camera, scene);
      renderer.setRenderTarget(prev);
      await ready;
      if (!live() || !globe) return;
      globeUploads.push(...globe.textures);
      geoLabels = !geoEl ? [] : globe.labels.map((l) => {
        const el = document.createElement('span'); el.className = `${l.home ? 'home ' : ''}${l.fa ? 'fa ' : ''}${l.side}`;
        // label text can come from the dashboard (home.texts.globe_gamers): always text, never markup
        const lb = document.createElement('b'); lb.textContent = l.text; el.append(document.createElement('i'), lb); geoEl.appendChild(el);
        return { ...l, el, w: 0, o: -1, dx: 0, dy: 0 };
      }).sort((a, b) => a.prio - b.prio);
      geoFs = 0;
      globeState = 'upload'; mark('compiled');
    } catch (e) {
      console.warn('route globe unavailable', e);
      globeState = 'failed';
      if (globe) { globe.dispose(); globe = null; }
    }
  }
  const stCam = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
  function layoutGlobe() {
    if (!globe) return;
    const s = STN[3];
    stCam.aspect = VW() / VH(); stCam.updateProjectionMatrix();
    stCam.position.set(...s.pos); stCam.lookAt(...s.look); stCam.updateMatrixWorld();
    globeHolder.updateMatrixWorld(true);
    globe.layout({ camera: stCam, portrait: portrait() });
  }
  const _lp = new THREE.Vector3(), _ln = new THREE.Vector3(), _lc = new THREE.Vector3(), _lv = new THREE.Vector3(), _lr = new THREE.Vector3();
  const _rects = [];
  let geoScale = 0, geoFs = 0;
  // labels: the mono face on a halo of the page, hung off a visible leader that steers each one onto dark water.
  // Type and leaders scale with the planet's on-screen size (12 px on a small planet, 14 px past 650 px).
  function styleGeoLabels(R, W) {
    const fs = W < 860 ? 13 : 2 * R > 650 ? 14 : 2 * R > 540 ? 13 : 12;
    const ls = clamp(R / 300, 0.72, 1.3);
    if (fs === geoFs && Math.abs(ls - geoScale) < 0.03) return;
    const fsChanged = fs !== geoFs; geoFs = fs; geoScale = ls;
    for (const g of geoLabels) {
      const dx = g.lead[0] * ls, dy = g.lead[1] * ls, len = Math.hypot(dx, dy);
      const st = g.el.style;
      st.setProperty('--fs', `${fs}px`);
      st.setProperty('--dx', `${dx.toFixed(1)}px`); st.setProperty('--dy', `${dy.toFixed(1)}px`);
      st.setProperty('--sx', `${(dx / len * 5).toFixed(1)}px`); st.setProperty('--sy', `${(dy / len * 5).toFixed(1)}px`);
      st.setProperty('--len', `${(len - 5).toFixed(1)}px`); st.setProperty('--ang', `${Math.atan2(dy, dx).toFixed(4)}rad`);
      g.dx = dx; g.dy = dy; if (fsChanged) g.w = 0;
    }
  }
  function updateGeoLabels(show) {
    if (!geoLabels.length) return;
    if (!show) { for (const g of geoLabels) if (g.o !== 0) { g.el.style.opacity = 0; g.o = 0; } if (nodeChip && nodeO !== 0) { nodeChip.style.opacity = 0; nodeO = 0; } return; }
    const W = VW(), H = VH(); _rects.length = 0;
    // planet radius on screen: project the centre and a point one radius to the camera's right
    _lc.setFromMatrixPosition(globe.group.matrixWorld);
    const rw = GLOBE_RADIUS * globe.group.matrixWorld.getMaxScaleOnAxis();
    _lr.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar(rw).add(_lc).project(camera);
    _lv.copy(_lc).project(camera);
    styleGeoLabels(Math.abs(_lr.x - _lv.x) * 0.5 * W, W);
    if (nodeChip) {
      globe.anchors.shelter.getWorldPosition(_lp); _lp.project(camera);
      const x = (_lp.x * 0.5 + 0.5) * W, y = (-_lp.y * 0.5 + 0.5) * H;
      if (Math.abs(x - nodeX) > 0.4 || Math.abs(y - nodeY) > 0.4) { nodeChip.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`; nodeX = x; nodeY = y; }
      const o = Math.round(nodeOn * 20) / 20; if (o !== nodeO) { nodeChip.style.opacity = o; nodeO = o; }
      _rects.push([x - 80, y - 60, x + 80, y]);   // the chip's box: labels keep clear of it
    }
    const fs = geoFs;
    for (const g of geoLabels) { // sorted by priority: the labs, then the supply lanes
      g.object.getWorldPosition(_lp);
      const facing = _ln.copy(_lp).sub(_lc).normalize().dot(_lv.copy(camera.position).sub(_lp).normalize());
      _lp.project(camera);
      const x = (_lp.x * 0.5 + 0.5) * W, y = (-_lp.y * 0.5 + 0.5) * H;
      // write to the DOM only when the label really moved: per-frame style writes cost ~8 fps on phones
      if (!(Math.abs(x - (g.px ?? -1e4)) < 0.4 && Math.abs(y - (g.py ?? -1e4)) < 0.4)) {
        g.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`; g.px = x; g.py = y;
      }
      let vis = facing > 0.2;
      if (vis) {
        if (!g.w) g.w = g.el.lastChild.offsetWidth || fs * 3;
        const ex = x + g.dx, ey = y + g.dy;
        const x0 = g.side === 'l' ? ex - 5 - g.w : ex + 5;
        const r = [x0 - 3, ey - fs * 0.5 - 3, x0 + g.w + 3, ey + fs * 0.5 + 3];
        if (r[0] < 4 || r[2] > W - 4 || _rects.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) vis = false;
        else _rects.push(r);
      }
      const o = vis ? Math.round(0.92 * (g.state ? g.state.a : 1) * 20) / 20 : 0;   // quantised: no per-frame style churn
      if (g.o !== o) { g.el.style.opacity = o; g.o = o; }
    }
  }

  /* ---------- logos: the intro's lockup and the outro.
     The lockup takes the poster's own particles (poster.js -> intro.mjs: the same positions, sizes and colours, so the
     hand-off shows no jump) and is laid out by the same formulas (introLayout); the outro is drawn from Silkscreen. */
  let logoA = null, logoB = null, logoR = null, builtAspect = 0, logoBReady = false;
  const PST = window.__l2dPoster;
  const SH = (PST && PST.shapes && PST.shapes()) || (() => { try { return introShapes(mobile); } catch (e) { return null; } })();
  const dropLogo = (l) => {
    if (!l) return; scene.remove(l);
    l.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { const tx = o.material.uniforms && o.material.uniforms.uTex; if (tx && tx.value) tx.value.dispose(); o.material.dispose(); } });
  };
  const buildIntroLogos = () => {
    const L = introLayout(VW(), VH());
    builtAspect = camera.aspect;
    dropLogo(logoA); dropLogo(logoR);
    if (SH) {
      const tier = SH.mobile ? 1 : 0;
      logoA = introLayer(SH.word, L.wt, LOOK.word, 0.42, tier);
      logoR = introLayer(SH.roof, L.wr, LOOK.roof, 0.6, tier);
    } else {   // the poster's shapes are unavailable: the word in the page's font, the molecule mark, no glow
      const nR = Math.round(Q.logo * 0.6);
      logoA = particleLogo(WORD, Q.logo, L.wt, 0.42, sampleMask((g, W, H) => { g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `800 ${Math.round(H * 0.8)}px ${SANS}`; g.fillText(WORD, W / 2, H / 2, W * 0.98); }, 1400, 360, Q.logo, L.wt));
      logoR = particleLogo('', nR, L.wr, 0.6, sampleMask(drawMark, 1200, Math.round(1200 * ROOF_AR), nR, L.wr));
      for (const [l, look] of [[logoA, LOOK.word], [logoR, LOOK.roof]]) { const u = l.material.uniforms; u.uA.value.set(look.a); u.uB.value.set(look.b); u.uSize.value = look.size[mobile ? 1 : 0]; u.uGain.value = look.gain; u.uCore.value = look.core; u.uAlpha.value = look.alpha; }
    }
    logoA.position.set(0, ST[0] + L.wordY, 0);
    logoR.position.set(0, ST[0] + L.roofY, L.roofZ);
    logoR.material.uniforms.uRad.value *= 1.4;
    logoA.renderOrder = 2;
    logoA.userData.part = 'word'; logoR.userData.part = 'roof';
    logoA.userData.tier = logoR.userData.tier = SH ? (SH.mobile ? 1 : 0) : (mobile ? 1 : 0); logoA.userData.fallback = logoR.userData.fallback = !SH;
    scene.add(logoR, logoA);
    themeIntro();
  };
  const buildOutro = () => {
    const L = introLayout(VW(), VH());
    dropLogo(logoB);
    logoB = particleLogo(OUTRO_WORD, Math.round(Q.logo * 0.8), L.w * 0.92); logoB.position.set(0, ST[6] + (!portrait() && VH() < 560 ? 3.1 : 2.1), 0);   // short landscape: lift it clear of the closing copy
    logoB.material.uniforms.uA.value.set(0x2fd6c3); logoB.material.uniforms.uB.value.set(0xa4e335);
    scene.add(logoB);
    themeOutro();
  };

  /* ---------- post-processing */
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Q.dpr);
  composer.setSize(VW(), VH());
  composer.addPass(new RenderPass(scene, camera));
  const BLOOM_K = mobile ? 0.7 : 0.85;
  const bloom = new UnrealBloomPass(new THREE.Vector2(VW(), VH()), BLOOM_K, 0.5, 1.0);
  { const bs = bloom.setSize.bind(bloom); bloom.setSize = (w, h) => bs(Math.max(2, w / 2), Math.max(2, h / 2)); bloom.radius = 0.42; }
  composer.addPass(bloom);
  // phones: bloom is the single biggest frame cost (44 -> 64 fps at 4x CPU when off); HDR emitters stay bright without it
  if (mobile) bloom.enabled = false;
  const CA_REST = 0.0005;
  const finalPass = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uCA: { value: CA_REST }, uGlitchCA: { value: 0 }, uGrain: { value: 0.045 }, uFlash: { value: 0 }, uRes: { value: new THREE.Vector2(VW(), VH()) }, uLight: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uCA, uGlitchCA, uGrain, uFlash, uLight; uniform vec2 uRes; varying vec2 vUv;
      // sin-free hash (Dave Hoskins): stable on mediump mobile GPUs, per device pixel
      float hash(vec2 p){ vec3 q = fract(vec3(p.xyx)*.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y)*q.z); }
      // lens CA lives only at the frame's edge (corners), so city lights, route hairlines and type in the
      // middle of the frame stay one crisp colour; the transition glitch adds a full-frame split on top
      // (daylight: no resting lens fringe, a third of the transition's: colour fringes read as misregistration on ink)
      void main(){ vec2 c = vUv - .5; float r = length(c); vec2 d = c*(uCA*smoothstep(.55, .85, r)*(1. - uLight) + uGlitchCA*(1. - .7*uLight))*(.6 + r*2.2);
        vec3 col = vec3(texture2D(tDiffuse, vUv + d).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - d).b);
        // (what the OutputPass did, a full-screen pass of its own until now: tone mapping and the sRGB encode)
        gl_FragColor = vec4(col, 1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        col = gl_FragColor.rgb;
        if (uLight > .5) col *= mix(vec3(1.), vec3(.955, .975, .95), (1. - smoothstep(1.1, .3, r*1.25)) * .55);   // daylight: the paper, a breath of sage at its corners
        else col *= smoothstep(1.1, .3, r*1.25);
        vec2 fc = gl_FragCoord.xy + fract(uTime*7.)*vec2(91.7, 53.3);
        float n1 = hash(fc), n2 = hash(fc + 47.11);
        col += (n1 - .5)*uGrain;
        // dither floor: triangular +-1 LSB, independent of luminance, so bloom halos never band
        col += (n1 + n2 - 1.)/255.;
        col += uFlash*vec3(.8,1.,.9);
        gl_FragColor = vec4(col, 1.); }`,
  });
  composer.addPass(finalPass);

  // the globe starts once the intro is on screen (boot, part 2). Visitors on Save-Data or a 2G-class link don't pay
  // for it up front: it starts within one station of the route instead (frame loop). ?lazyglobe is a QA switch that
  // forces the late path.
  markB('composer'); await yieldNow();

  /* ---------- resize */
  let wasPortrait = portrait();
  let lastW = VW(), lastH = VH();
  const onResize = (force) => {
    if (force !== true && VW() === lastW && VH() === lastH) return;   // toolbar-only changes (iOS) end here
    lastW = VW(); lastH = VH();
    if (force !== true && govResize()) return;   // the new size changed the resolution budget (applyDpr re-runs this)
    renderer.setSize(VW(), VH(), false); composer.setSize(VW(), VH());
    camera.aspect = VW() / VH(); camera.updateProjectionMatrix();
    finalPass.uniforms.uRes.value.set(VW(), VH());
    measure(); STN = stations();
    if (logoA && (portrait() !== wasPortrait || Math.abs(camera.aspect - builtAspect) > 0.3)) { wasPortrait = portrait(); buildIntroLogos(); if (logoB) buildOutro(); if (introDone) logoA.material.uniforms.uAssemble.value = 1; }
    placeGroups(); // re-places the globe for the new viewport (and lays out its depth quads)
  };
  on(window, 'resize', onResize);

  const GLOBE_PY = tune('gpy', -0.25);
  const GLOBE_PS = tune('gps', 0.84);
  /* Desktop: size and place the planet in screen terms, per viewport. The planet's left limb clears the
     section rail ("04 ROUTE" + ticks) and the orbit ring clears the rail's label and stays inside the frame;
     the right limb (and ring) keep a gap to the copy column; on very wide screens the planet stays within
     250 px of the copy so the route never shrinks to a small patch in dead space. Extents are measured by
     projecting the real silhouette and ring through the station camera (perspective and the off-axis
     stretch included), then the scale and offset are corrected; 22 px of slack absorbs pointer parallax. */
  const _pc = new THREE.Vector3(), _pv = new THREE.Vector3(), _pa = new THREE.Vector3(), _pb = new THREE.Vector3(), _pp = new THREE.Vector3();
  const _ringQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(...GLOBE_RING_TILT));
  function measureGlobe(hx, s, W, H) {
    const st = STN[3];
    stCam.aspect = W / H; stCam.updateProjectionMatrix();
    stCam.position.set(...st.pos); stCam.lookAt(...st.look); stCam.updateMatrixWorld();
    const r = GLOBE_RADIUS * s; _pc.set(hx, ST[3], 0);
    _pv.copy(_pc).sub(stCam.position); const d = _pv.length(); _pv.divideScalar(d);
    _pa.set(0, 1, 0).cross(_pv).normalize(); _pb.copy(_pv).cross(_pa);
    const cr = r * Math.sqrt(1 - (r * r) / (d * d)), back = (r * r) / d; // tangent circle of the silhouette
    const m = { pL: Infinity, pR: -Infinity, pT: Infinity, rL: Infinity, rR: -Infinity, rT: Infinity, rB: -Infinity };
    const px = (v) => [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      _pp.copy(_pc).addScaledVector(_pv, -back).addScaledVector(_pa, Math.cos(a) * cr).addScaledVector(_pb, Math.sin(a) * cr).project(stCam);
      const [x, y] = px(_pp); m.pL = Math.min(m.pL, x); m.pR = Math.max(m.pR, x); m.pT = Math.min(m.pT, y);
      _pp.set(Math.cos(a) * r * GLOBE_RING_K, 0, Math.sin(a) * r * GLOBE_RING_K).applyQuaternion(_ringQ).add(_pc).project(stCam);
      const [rx, ry] = px(_pp); m.rL = Math.min(m.rL, rx); m.rR = Math.max(m.rR, rx); m.rT = Math.min(m.rT, ry); m.rB = Math.max(m.rB, ry);
    }
    return m;
  }
  function globePlacement() {
    if (portrait()) return { x: 0, y: ST[3] + GLOBE_PY, s: GLOBE_PS };
    const W = VW(), H = VH();
    const camZ = STN[3].pos[2];
    const wpp = (2 * camZ * Math.tan((camera.fov * Math.PI) / 360)) / H; // world units per CSS px at z = 0
    const gutter = clamp(W * 0.04, 16, 56);
    const copyR = gutter + Math.min(150, W * 0.095) + Math.min(520, W * 0.42);   // .route-copy's right edge
    const slack = 22;
    const left = copyR + Math.max(40, W * 0.03) + slack;   // the planet's left limb clears the copy
    const right = W - gutter - slack;
    const top = 74 + slack;   // the header pill
    // first guess from a flat model, then measured corrections (the planet's silhouette through the station camera)
    let R = Math.max(H * 0.2, Math.min((right - left) / 2, H * 0.37));
    let hx = ((left + right) / 2 - W / 2) * wpp;
    let s = (R * wpp) / camZ * Math.hypot(hx, camZ) / GLOBE_RADIUS;
    for (let it = 0; it < 3; it++) {
      const m = measureGlobe(hx, s, W, H);
      const room = Math.min((right - left) / (m.pR - m.pL), (H / 2 - top) / Math.max(1, H / 2 - m.pT), (H * 0.74) / (m.pR - m.pL));
      s *= Math.max(room, (H * 0.4) / (m.pR - m.pL)); // floor: 40 % of the height, even if it must overlap
      const n = measureGlobe(hx, s, W, H);
      const lo = left - n.pL, hi = right - n.pR;
      let shift = lo <= hi ? (lo + hi) / 2 : lo;
      shift = Math.min(shift, Math.max(lo, copyR + 250 - n.pL)); // within 250 px of the copy on wide screens
      hx += shift * wpp;
    }
    return { x: hx, y: ST[3], s };
  }
  // the hero's key/rim lights, retargeted for the games' column (scene-level, fixed count: moving them is free)
  let lightsAt = 'hero';
  // (daylight: the same lights in the paper's pastels, warm lilac and sage-teal: the night's neon would turn the chrome
  // cold on paper; on the column a sage key and a rose rim at 0.6 of the night's strength. A colour change only)
  const KEY_COL = keyLight.color.clone(), RIM_COL = rimLight.color.clone();
  const KEY_DAY = new THREE.Color(0xf3fbe6), RIM_DAY = new THREE.Color(0x8be8db);
  const KEY_K = () => (LIGHT && HERO === 'logo' ? 0.55 : 1);   // (daylight: no tone mapping, the pearl's apex would clip white)
  const setLights = (mode) => {
    if (lightsAt === mode) return; lightsAt = mode;
    if (mode === 'games') {
      // (daylight: a real key and rim on the pearl: a warm lilac-white key high in front on the camera's left and an aqua
      // rim behind the column on its right, placed round the camera each frame, so every card's view is lit the same way)
      if (LIGHT) { keyLight.color.set(0xf6fbef); keyLight.intensity = 60; rimLight.color.set(0x9fe8dc); rimLight.intensity = 34; keyLight.distance = 22; rimLight.distance = 18; return; }   // (a soft pale-aqua rim: a hot one prints neon seams on the scan's facets)
      keyLight.color.set(0x5eead4); keyLight.intensity = 10; rimLight.color.set(0xbef264); rimLight.intensity = 8;
      keyLight.distance = 14; rimLight.distance = 14; return;
    }
    keyLight.color.copy(LIGHT ? KEY_DAY : KEY_COL); rimLight.color.copy(LIGHT ? RIM_DAY : RIM_COL); keyLight.distance = 30; rimLight.distance = 30;
    heroLights();
  };
  const heroLights = () => {
    const p = portrait();
    keyLight.position.set((p ? 0 : 4.6) - 4, ST[1] + 3, 6); rimLight.position.set((p ? 0 : 4.6) + 5, ST[1] - 2, 3); keyLight.intensity = 40; rimLight.intensity = 30;
    if (HERO === 'logo') { keyLight.position.set((p ? 0 : 4.6) - 1.5, ST[1] + 7.5, 9); keyLight.intensity = 26 * KEY_K(); }   // high and soft: no hot spots on the brushed arms (daylight: softer still, KEY_K)
  };
  function placeGroups() {
    const p = portrait();
    heroLights(); lightsAt = 'hero';
    emblem.position.set(p ? 0 : -4.6, ST[1] + (p ? 1.4 : 0), 0); emblem.scale.setScalar(p ? 0.52 : 1);
    roof.position.set(p ? 0 : 4.1, ST[1] + (p ? 1.2 : 0.2), 0); roof.scale.setScalar(p ? 0.62 : 1);
    if (roofU) { roofU.uTop.value = p ? 7.6 : 6.8; roofU.uBot.value = p ? -4.4 : -6.8; roofU.uRes.value.set(VW(), VH()); }
    tower.position.set(p ? 0 : 0.35, ST[2], 0); tower.scale.setScalar(p ? 0.78 : 1);
    workTeal.position.set(tower.position.x - 2.4, ST[2] - 6, 3.5); workPink.position.set(tower.position.x + 2.2, ST[2] - 20, 3.2);
    // portrait: planet ~90 % of the viewport width in the top half, lower limb dissolving above the copy
    const gp = globePlacement();
    globeHolder.position.set(gp.x, gp.y, 0); globeHolder.scale.setScalar(gp.s); globeBaseS = gp.s; globeBaseX = gp.x;
    layoutGlobe();
  }
  placeGroups();

  /* ---------- pointer -> world (z = 0 plane of a group) */
  const ray = new THREE.Raycaster(); const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); const hit = new THREE.Vector3(); const ndc = new THREE.Vector2();
  const pointerOn = (obj, out) => {
    ndc.set(state.mx, state.my); ray.setFromCamera(ndc, camera);
    plane.constant = -obj.position.z;
    if (ray.ray.intersectPlane(plane, hit)) out.set(hit.x - obj.position.x, hit.y - obj.position.y, 0);
  };
  let shock = 0;
  on(window, 'pointerdown', (e) => {
    if (state.active === 1 && HERO === 'logo' && !reduced && !(e.target.closest && e.target.closest('a,button'))) { roofFlash = 1; roofNextFlash = 6 + Math.random() * 4; return; }   // call the lightning
    if (state.active !== 0 && state.active !== 6) return;
    state.tmx = state.mx = (e.clientX / VW()) * 2 - 1; state.tmy = state.my = -((e.clientY / VH()) * 2 - 1); shock = 1;
  });

  /* ---------- intro choreography: the hand-off from the poster.
     The particles start where the poster drew them, assembled and still. The canvas fades in as the poster fades out
     (CSS, 0.7 s, the poster's light added over the canvas: the lockup's brightness holds), then the particles wake:
     their shimmer and the pointer's push ease in. Reduced motion keeps the poster and the scene does not draw the
     lockup. A poster that has not been drawn by then (a tab opened in the background) never is: the particles
     gather from a near cloud as they used to. */
  let introDone = false;
  let posterOn = !!(PST && PST.drawn), posterHold = reduced && posterOn;
  let wakeAt = posterOn && !reduced ? Infinity : -1e9;
  const startIntro = () => {
    const html = document.documentElement;
    posterOn = !!(PST && PST.drawn); posterHold = reduced && posterOn;
    if (!posterOn) { html.classList.add('poster-gone'); wakeAt = -1e9; }
    const u = logoA.material.uniforms;
    if (reduced || posterOn) { u.uAssemble.value = 1; introDone = true; }
    else tween(u.uAssemble, 0.12, 1, 3.6, EASE.sineOut, () => { introDone = true; });
    if (posterOn && !reduced) {
      wakeAt = Infinity; html.classList.add('poster-off');
      setTimeout(() => {
        html.classList.add('poster-gone'); wakeAt = performance.now();
        const c = $('#poster canvas'); if (c) { c.width = 0; c.height = 0; }   // free its pixels
        if (PST && PST.release) PST.release();                                  // and the entrance's
      }, 760);
    }
  };

  /* ---------- resolution governor (every device, all the time)
     Averages frame time over ~1 s windows. Two slow windows in a row (under ~48 fps) step the drawing buffer down
     (one is a hiccup: a decode, a collection, a late texture); a sustained run of fast frames (4 s at ~60 fps) steps
     it up one notch at a time, past the starting budget up to the quality ceiling (BUDGET_UP), but never to a level
     that already proved too slow. Every step down (and the bloom going off) is a trial: the first window after it
     must run clearly faster, else the frame time was not the pixels' (a display or power mode capped at 30 fps, a busy
     main thread, a slow phone CPU) and the sharper picture comes back, with a pause before the next try. Known one-off
     work (a theme switch, a clip swap) is not measured (govQuiet). Changes are rare and quantised, so render targets
     are not reallocated constantly. */
  const STEPS_DPR = [2, 1.75, 1.5, 1.33, 1.2, 1.1, 1, 0.9, 0.8, 0.75, 0.67, 0.6].filter((v) => v <= DPR_UP + 1e-3 && v >= DPR_MIN - 1e-3);
  let dprCeil = ceilDpr() + 1e-3, winT = 0, winN = 0, winSlow = 0, fastRun = 0, slowRun = 0, lastChange = 0, bloomOff = false;
  let trial = null, fails = 0, noTryTo = 0, quietTo = 0;
  const govQuiet = (ms) => { quietTo = Math.max(quietTo, performance.now() + ms); };
  const applyDpr = (v) => {
    if (Math.abs(v - Q.dpr) < 0.01) return;
    Q.dpr = v; renderer.setPixelRatio(v); composer.setPixelRatio(v);
    for (const mt of [dustMat, petalsMat, sparksMat, logoA && logoA.material, logoB && logoB.material, logoR && logoR.material]) if (mt && mt.uniforms && mt.uniforms.uPR) mt.uniforms.uPR.value = v;
    if (DEBUG) console.info('[governor] dpr', v.toFixed(2), 'buffer', renderer.getDrawingBufferSize(new THREE.Vector2()).toArray().join('x'));
  };
  var govOn = true;   // var + function declaration: onResize (defined earlier) may call govResize safely
  function govResize() { if (!govOn) return false; const bd = budgetDpr(); dprCeil = ceilDpr() + 1e-3; if (Math.abs(bd - Q.dpr) > 0.05) { applyDpr(bd); return true; } return false; }
  const nextDown = () => STEPS_DPR.find((v) => v < (pendingDpr || Q.dpr) - 1e-3);
  const nextUp = () => [...STEPS_DPR].reverse().find((v) => v > Q.dpr + 1e-3);
  let pendingDpr = 0, pendingAt = 0, winCpu = 0, lastCpu = 0;
  const reset = () => { winT = winN = winSlow = winCpu = 0; };
  const tryBloomOff = (avg, now) => { bloomOff = true; bloom.enabled = false; lastChange = now; trial = { bloom: true, avg }; reset(); };
  const guard = (dt, now) => {
    if (pendingDpr && ((Math.abs(scrollNow() - state.scroll) < 2 && Math.abs(vel) < 0.02 && stillFrames > 10) || now - pendingAt > 9000)) { applyDpr(pendingDpr); pendingDpr = 0; lastChange = now; reset(); }
    if (dt > 0.25 || document.hidden || boot.up || !full) return;   // tab switches, the boot (both parts): not a measure
    if (now < quietTo) { reset(); return; }
    winT += dt; winN++; winCpu += lastCpu; if (dt > 0.026) winSlow++;
    if (winT < 1) return;
    const avg = winT / winN, slowShare = winSlow / winN, cpuShare = winCpu / winN / 1000 / avg;
    reset();
    if (pendingDpr) return;
    if (trial) {   // the first window after a step down decides it: kept only if frames got clearly faster
      if (avg > trial.avg * 0.88) {
        if (trial.bloom) { bloomOff = false; bloom.enabled = true; } else { applyDpr(trial.from); dprCeil = trial.ceil; }
        fails++; noTryTo = now + 30000 * fails;
        if (DEBUG) console.info('[governor] no faster (', (trial.avg * 1000).toFixed(1), '->', (avg * 1000).toFixed(1), 'ms): back');
      }
      trial = null; slowRun = 0; lastChange = now; return;
    }
    if (now - lastChange < 1200) return;
    if (avg > 0.0205 || slowShare > 0.35) {
      fastRun = 0;
      if (++slowRun < 2 || now < noTryTo) return;
      slowRun = 0;
      // (no CPU/GPU split: GL calls block while the GPU is busy, so main-thread time cannot tell them apart)
      if (!bloomOff && bloom.enabled && Q.dpr <= 1.0 + 1e-3) { tryBloomOff(avg, now); return; }
      const want = Q.dpr * Math.sqrt(0.0155 / avg);   // fill-rate scales with pixels: aim straight at ~64 fps
      const d = STEPS_DPR.find((v) => v <= want + 1e-3 && v < Q.dpr - 1e-3) || nextDown();
      if (d) { trial = { from: Q.dpr, ceil: dprCeil, avg }; dprCeil = Math.min(dprCeil, Q.dpr); pendingDpr = d; pendingAt = now; lastChange = now; }
      else if (!bloomOff && bloom.enabled && avg > 0.024) tryBloomOff(avg, now);   // already at the floor
    } else if (avg < 0.0175 && slowShare < 0.05) {
      slowRun = 0;
      if (++fastRun >= 4) {
        fastRun = 0; const u = nextUp();
        if (u && u < dprCeil - 1e-3 && u <= ceilDpr() + 1e-3) { pendingDpr = u; pendingAt = now; lastChange = now; }
      }
    } else { fastRun = 0; slowRun = 0; }
  };

  /* ---------- main loop. Until `full` (every station built and warmed: boot, part 2) only the intro is drawn: the
     other stations' groups stay hidden (their copy is on screen), so nothing is ever compiled or uploaded mid-frame. */
  let full = false;
  let tPrev = performance.now(), t = 0;
  const camPos = new THREE.Vector3(); const camLook = new THREE.Vector3(); const tmpA = new THREE.Vector3(); const tmpB = new THREE.Vector3();
  const mouseLocal = new THREE.Vector3(99, 99, 0); const camDir = new THREE.Vector3();
  let stillFrames = 0, plansTick = 0;
  /* the route, in one shot: when the station is reached the camera pulls back from the Shelter servers in Tehran (the
     gamers' lines already drawn) to the whole route, the direct lines to the game servers abroad drawing in on the way
     (~2.6 s), then the whole route stays and keeps flowing. No steps, nothing to scroll through, and a small scroll
     never rewinds it; it plays again only after the route was left. Reduced motion: the whole route at once. */
  const STORY_S = 7, STORY_FROM = 0.1;   // (labglobe.js: the whole story from the hub zoom on: request, sourcing, offer, delivery)
  let storyT = 0;
  let lastScroll = window.scrollY, vel = 0, glitch = 0, ledTimer = 0, gAppear = 0;
  // smoothing rate by input: touch / precision touchpads already arrive smooth (follow tightly), notched wheels a little softer
  let scrollK = 14;
  on(window, 'touchstart', () => { scrollK = 20; }, { passive: true });
  on(window, 'wheel', (e) => { scrollK = e.deltaMode || Math.abs(e.deltaY) >= 50 ? 12 : 18; }, { passive: true });
  const v3 = (a) => tmpA.set(a[0], a[1], a[2]);

  const frame = () => {
    // past the story (main.js: html.gl-gone once the last station has scrolled away and the canvas is faded out): draw nothing
    if (document.documentElement.classList.contains('gl-gone')) { tPrev = performance.now(); return; }
    const now = performance.now(); const rawDt = (now - tPrev) / 1000; const dt = Math.min(rawDt, 0.05), sdt = Math.min(rawDt, 0.25); tPrev = now; t += dt;
    guard(rawDt, now);
    // lazy globe (only when it missed the boot warm-up): one texture upload per frame, then its meshes
    // are drawn a few per frame into a tiny offscreen target from the station camera. Same render-target
    // state as the RenderPass, so the programs, buffers and driver-side shader variants are all warm.
    // (while the boot screen still covers the page the whole job is done in one go: nobody can see it)
    stillFrames = Math.abs(scrollNow() - state.scroll) < 1 ? stillFrames + 1 : 0;
    const globeWork = boot.up || stillFrames > 20 || state.active >= 2;
    if (globeState === 'upload' && globeWork) {
      for (let n = boot.up ? globeUploads.length : 1; n > 0 && globeUploads.length; n--) renderer.initTexture(globeUploads.shift());
      if (!globeUploads.length) globeState = 'warm';
    }
    else if (globeState === 'warm' && globeWork) {
      if (!warmList) {
        warmList = []; globe.update(0.016, t, { x: 0, y: 0 }, 1); layoutGlobe();
        globe.group.traverse((o) => { if (o.isMesh || o.isPoints) warmList.push(o); });
        warmRT = new THREE.WebGLRenderTarget(64, 64, { type: THREE.HalfFloatType });
      }
      // render the real scene (same lights / fog / env => same program variants as the RenderPass) with
      // everything but this batch of globe meshes hidden
      const batch = warmList.splice(0, boot.up ? warmList.length : 3);
      const hidden = scene.children.filter((c) => c !== globeHolder && !c.isLight && c.visible);
      hidden.forEach((c) => { c.visible = false; });
      const holderVis = globeHolder.visible; globeHolder.visible = true;
      const flags = [];
      globe.group.traverse((o) => { if (o.isMesh || o.isPoints) { flags.push([o, o.visible]); o.visible = batch.includes(o); } });
      const prev = renderer.getRenderTarget(); renderer.setRenderTarget(warmRT);
      renderer.render(scene, stCam);
      renderer.setRenderTarget(prev);
      flags.forEach(([o, v]) => { o.visible = v; }); hidden.forEach((c) => { c.visible = true; }); globeHolder.visible = holderVis;
      if (!warmList.length) { warmRT.dispose(); globeState = 'ready'; mark('ready-lazy'); }
    }
    // input smoothing
    state.mx = lerp(state.mx, state.tmx, 1 - Math.exp(-dt * 6)); state.my = lerp(state.my, state.tmy, 1 - Math.exp(-dt * 6));
    const target = scrollNow();
    state.scroll = reduced ? target : lerp(state.scroll, target, 1 - Math.exp(-sdt * scrollK));
    { const cap = 0.35 * VH(); state.scroll = clamp(state.scroll, target - cap, target + cap); }   // never more than a third of a screen behind
    vel = lerp(vel, (target - lastScroll) / Math.max(sdt, 1e-3) / VH(), 0.15); lastScroll = target;

    const sc = computeScroll(state.scroll);
    updateDom(sc, computeScroll(target));
    if (globeState === 'idle' && Math.max(sc.i, sc.j) >= 2) startGlobe(); // within one station of the route

    // camera between stations
    let A = STN[sc.i], B = STN[sc.j]; const k = easeIO(sc.t);
    if (sc.i === 2 || sc.j === 2) {
      const gl = GAMES.length - 1;
      const af = sc.i === 2 && sc.j === 2 ? gamesSnap(sc.local[2] * gl) : (sc.j === 2 && sc.i !== 2 ? 0 : gl);
      const pose = gamesPose(af); const cp = { pos: pose.pos.slice(), look: pose.look.slice() };
      if (sc.i === 2) A = cp; if (sc.j === 2) B = cp;
    }
    camPos.copy(v3(A.pos)).lerp(tmpB.set(...B.pos), k);
    camLook.copy(v3(A.look)).lerp(tmpB.set(...B.look), k);
    const fly = Math.sin(Math.PI * sc.t);
    camPos.z += fly * 7; camPos.x += fly * Math.sin(sc.i * 1.7) * 3;
    const mx = reduced ? 0 : state.mx, my = reduced ? 0 : state.my;
    camPos.x += mx * 0.7; camPos.y += my * 0.45;
    camera.position.copy(camPos); camera.lookAt(camLook.x + mx * 0.25, camLook.y + my * 0.15, camLook.z);

    // transition glitch + chromatic aberration. Near the route the glitch's colour split is cut to 20 %:
    // on the globe's point-like city lights and 1 px hairlines it reads as an RGB anaglyph, not as a lens
    glitch = reduced ? 0 : Math.max(fly * 0.9, Math.min(Math.abs(vel) * 0.06, 0.6));
    const routeNear = smooth(40, 20, Math.abs(camera.position.y - ST[3]));
    finalPass.uniforms.uGlitchCA.value = glitch * 0.012 * lerp(1, 0.2, routeNear);
    finalPass.uniforms.uTime.value = t;

    // background
    nebula.position.copy(camera.position);
    nebula.material.uniforms.uTime.value = t; nebula.material.uniforms.uShift.value = camera.position.y;
    { const w = clamp(1 - Math.abs(camera.position.y - ST[2]) / 26); const nu = nebula.material.uniforms;
      nu.uC1.value.copy(NEB_BASE[0]).lerp(NEB_WORK[0], w); nu.uC2.value.copy(NEB_BASE[1]).lerp(NEB_WORK[1], w); nu.uC3.value.copy(NEB_BASE[2]).lerp(NEB_WORK[2], w);
      if (LIGHT) { nu.uL1.value.copy(NEB_LBASE[0]).lerp(NEB_LWORK[0], w); nu.uL2.value.copy(NEB_LBASE[1]).lerp(NEB_LWORK[1], w); nu.uL3.value.copy(NEB_LBASE[2]).lerp(NEB_LWORK[2], w); }
      // (daylight, at the games: a deeper paper fog, so the far card slabs melt into the paper instead of standing as blank sheets)
      scene.fog.density = LIGHT ? 0.012 * (1 + 0.6 * w) : 0.012; }
    dustMat.uniforms.uTime.value = t; dustMat.uniforms.uVel.value = vel;
    const near = (y) => Math.abs(camera.position.y - y) < 40;

    // intro logo (reduced motion: the poster stands in for it)
    const L = sc.local;
    logoA.visible = near(ST[0]) && !posterHold;
    if (logoA.visible) {
      const wk = smooth(0, 1400, now - wakeAt);   // 0 while the poster is over it, then eases in
      const u = logoA.material.uniforms; u.uTime.value = t; u.uWake.value = wk;
      const ex = sc.i === 0 ? (sc.j === 0 ? smooth(0.12, 1, L[0]) * 0.7 : 0.7 + sc.t * 0.3) : 1;
      u.uExplode.value = ex; u.uOpacity.value = 1 - smooth(0.6, 1, ex) * 0.7;   // the snow stays bright until late in the scroll
      pointerOn(logoA, mouseLocal); u.uMouse.value.copy(mouseLocal);
      u.uPush.value = ((state.pointer ? 1 : 0) + shock * 2.5) * wk;
      const r = logoR.material.uniforms; r.uTime.value = t * 0.8; r.uWake.value = wk;
      r.uAssemble.value = Math.min(1, u.uAssemble.value * 1.12); r.uExplode.value = Math.min(1, ex * 1.08); r.uOpacity.value = u.uOpacity.value * LOOKS().roof.op;
      pointerOn(logoR, mouseLocal); r.uMouse.value.copy(mouseLocal); r.uPush.value = u.uPush.value * 0.8;
      const on = smooth(0.2, 1, u.uAssemble.value) * (1 - smooth(0.05, 0.6, ex));
      for (const l of [logoA, logoR]) { const gw = l.userData.glow; if (gw) { gw.material.uniforms.uOn.value = on; gw.visible = on > 0.002; } }
    }
    logoR.visible = logoA.visible;
    // outro logo
    if (logoB) logoB.visible = full && logoBReady && near(ST[6]);
    if (logoB && logoB.visible) {
      const u = logoB.material.uniforms; u.uTime.value = t;
      u.uAssemble.value = sc.j === 6 ? (sc.i === 6 ? 0.35 + smooth(0, 0.8, L[6]) * 0.65 : sc.t * 0.35) : 0;
      pointerOn(logoB, mouseLocal); u.uMouse.value.copy(mouseLocal); u.uPush.value = (state.pointer ? 1 : 0) + shock * 2.5;
    }
    shock = Math.max(0, shock - dt * 1.6);

    // emblem
    roof.visible = full && HERO === 'logo' && near(ST[1]);
    if (roof.visible) {
      roof.rotation.y = Math.sin(t * 0.3) * 0.16 + mx * 0.3; roof.rotation.x = -my * 0.1 + Math.sin(t * 0.23) * 0.04;
      roofWind = lerp(roofWind, mx * 0.32 + Math.sin(t * 0.4) * 0.04, 1 - Math.exp(-dt * 1.5));
      roofU.uTime.value = reduced ? 3 : t; roofU.uWind.value = roofWind;
      if (!reduced && (roofNextFlash -= dt) <= 0) { roofFlash = 1; roofNextFlash = 5 + Math.random() * 5; }
      roofFlash = Math.max(0, roofFlash - dt * 2.4);
      const fl = roofFlash * (0.6 + 0.4 * Math.abs(Math.sin(t * 47)));   // flicker
      roofU.uFlash.value = fl; if (lightsAt === 'hero') keyLight.intensity = (26 + fl * 140) * KEY_K();
    }
    emblem.visible = full && HERO === 'emblem' && near(ST[1]);
    if (emblem.visible) {
      emblem.rotation.y = Math.sin(t * 0.35) * 0.35 + mx * 0.45 + L[1] * 0.8;
      emblem.rotation.x = Math.sin(t * 0.27) * 0.12 - my * 0.3;
      emblem.children[1].rotation.x = t * 0.25; emblem.children[1].rotation.y = t * 0.18;
      emblem.children[2].rotation.y = -t * 0.12; emblem.children[2].rotation.x = Math.sin(t * 0.3) * 0.4;
      sparksMat.uniforms.uTime.value = t; ring2Mat.uniforms.uTime.value = reduced ? 0.3 : t;
    }

    // games: the camera does the travelling; cards hold their places on the helix
    tower.visible = full && (near(ST[2]) || (sc.i === 2 || sc.j === 2));
    if (full) updateVideos(gamesSnap(L[2] * (GAMES.length - 1)), dt, sc.i === 2 && sc.j === 2);
    if (tower.visible) {
      const n = cards.length; const af = gamesSnap(L[2] * (n - 1));
      spineSpin += dt * (reduced ? 0 : 0.04 + Math.min(Math.abs(vel), 3) * 0.12);
      spineHolder.rotation.y = spineSpin;
      if (sc.i === 2 || (sc.j === 2 && sc.t > 0.5)) {   // the column's key lights travel with the camera
        setLights('games');
        if (LIGHT) {
          const tp = tower.position, dx = camera.position.x - tp.x, dz = camera.position.z - tp.z, l = Math.hypot(dx, dz) || 1, cx = dx / l, cz = dz / l;
          keyLight.position.set(tp.x + cx * 5 - cz * 3.4, camera.position.y + 3.8, tp.z + cz * 5 + cx * 3.4);
          rimLight.position.set(tp.x - cx * 3.2 + cz * 3, camera.position.y - 0.8, tp.z - cz * 3.2 - cx * 3);
        } else { keyLight.position.set(tower.position.x - 2.4, camera.position.y + 3.2, 3.5); rimLight.position.set(tower.position.x + 2.2, camera.position.y - 3.4, 3.2); }
      }
      petalsMat.userData.tick(reduced ? 0 : t, dt);
      cards.forEach((c, i) => {
        const u = c.material.uniforms; u.uTime.value = t;
        const d = Math.abs(i - af);
        u.uActive.value = lerp(u.uActive.value, 1 - smooth(0, 0.7, d), 1 - Math.exp(-dt * 8));
        u.uVis.value = smooth(3.4, 2.2, d);
        const grp = cardGroups[i]; grp.visible = u.uVis.value > 0.002 && !(DEBUG && params.has('nocards'));
        grp.userData.slabMat.opacity = LIGHT ? 0.5 * u.uVis.value * (0.3 + 0.7 * u.uActive.value) : (mobile ? 0.42 : 0.4) * u.uVis.value;   // (daylight: far panes fade)
        grp.position.y = -i * G_DY + Math.sin(t * 0.6 + i) * 0.05;
      });
    }

    // globe (driven entirely by the module: sway, parallax, comets)
    globeHolder.visible = globeState === 'ready' && (sc.i === 3 || sc.j === 3);
    let gDraw = 0;
    if (globeHolder.visible) {
      // appear ramp: if the globe lands while it is on screen (deep link, header link, slow phone) it
      // fades in over ~0.7 s instead of popping in at full strength
      gAppear = Math.min(1, gAppear + dt / 0.7);
      const inRoute = sc.i === 3 && sc.j === 3;
      // (the clock runs while the route is the station on screen, in its transitions too, and the globe shows it as it
      // is at any scroll: a small scroll back never sends it to the start)
      if (state.active === 3) storyT = reduced ? 1 : Math.min(1, storyT + dt / STORY_S);
      const drawIn = 0.35 + Math.max(inRoute ? smooth(0, 0.5, L[3]) : 0, smooth(0, 0.1, storyT)) * 0.65;   // (continuous into the transitions)
      gDraw = sc.j === 3 ? (inRoute ? drawIn : sc.t * drawIn) : (sc.i === 3 ? 1 : 0);
      const park = inRoute ? 1 : sc.j === 3 ? smooth(0.75, 1, sc.t) : sc.i === 3 ? 1 - smooth(0, 0.25, sc.t) : 0;
      const story = STORY_FROM + (1 - STORY_FROM) * easeIO(storyT);
      const so = globe.update(dt, t, { x: mx, y: my }, gDraw, { fade: easeIO(gAppear), park, story }) || { zoom: 1, node: 0 };
      globeHolder.scale.setScalar(globeBaseS * (1 + (so.zoom - 1) * (portrait() ? 0.62 : 1)));
      // while zoomed, the planet slides toward the middle of the free (left) area so the zoomed region isn't cut by the screen edge
      if (!portrait()) { const zk = clamp((so.zoom - 1) / 0.6); const wW = 2 * STN[3].pos[2] * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect; globeHolder.position.x = lerp(globeBaseX, 0.075 * wW, zk); }
      globeHolder.updateMatrixWorld(true);
      nodeOn = so.node;
      state.story = story;   // the route's steps light up with the story (core.js)
    }
    if (!globeHolder.visible) { storyT = 0; state.story = null; }   // (away from the route: the next visit plays it again)
    updateGeoLabels(globeHolder.visible && sc.i === 3 && sc.j === 3 && gDraw * gAppear > 0.6);

    // the plans station has no 3D of its own (the plan emblems are crisp SVG in the cards: src/plans.css); the hero's
    // lights stay where the hero has them, except while the games' column is on screen
    if (!(tower.visible && (sc.i === 2 || (sc.j === 2 && sc.t > 0.5)))) setLights('hero');

    // the intro's lockup carries its own glow (LOOK.glow, which the poster draws too): over it the bloom is held low,
    // so the letters stay crisp and the hand-off from the poster matches; the other stations get the full bloom
    // (none at all until the poster has gone, so the hand-off from it shows no jump in brightness; then it eases in)
    if (bloom.enabled) bloom.strength = BLOOM_K * lerp(INTRO_BLOOM * smooth(0, 1400, now - wakeAt), 1, smooth(3, 24, Math.abs(camera.position.y - ST[0]))) * (LIGHT ? 0.12 : 1);
    // (the plans station has no 3D of its own: behind its deal only the slow sky shows, drawn at a third of the rate, so the
    // deal's own light (the emblem, the motes) has the GPU; every other station at the full rate)
    const skyOnly = sc.i === sc.j && !logoA.visible && !roof.visible && !tower.visible && !globeHolder.visible && !(logoB && logoB.visible) && Math.abs(vel) < 0.05;
    if (!skyOnly || (plansTick = (plansTick + 1) % 3) === 0) composer.render(dt);
    lastCpu = performance.now() - now;   // main-thread ms this frame (the governor's CPU/GPU split)
  };

  /* ---------- theme. html[data-theme] (the head's script, the header toggle: main.js) picks the night sky or daylight;
     a switch reaches every part already built, and each part built later takes the theme as it is built. Only uniforms,
     blend states and the environment change (and the two output passes: tone mapping, vignette). */
  const ADD = THREE.AdditiveBlending, NORMAL = THREE.NormalBlending;
  // (daylight dust: a dusty lilac #7d6c9e in linear light, sparse: motes on paper read as specks, so they are barely there)
  const INK_DUST = new THREE.Vector3(0.06, 0.22, 0.17), STAR_DUST = new THREE.Vector3(0.7, 1, 0.85);
  function themeIntro() {
    for (const l of [logoA, logoR]) {
      if (!l) continue;
      const look = LOOKS()[l.userData.part]; const u = l.material.uniforms;
      u.uA.value.set(look.a); u.uB.value.set(look.b); u.uSize.value = look.size[l.userData.tier]; u.uGain.value = look.gain; u.uCore.value = look.core; u.uAlpha.value = look.alpha;
      u.uTri.value = look.m != null ? 1 : 0; if (look.m != null) u.uM.value.set(look.m);
      u.uRk.value = look.rim ? look.rim.k : 0; if (look.rim) { u.uRA.value.set(look.rim.a); u.uRM.value.set(look.rim.m); u.uRB.value.set(look.rim.b); }
      u.uFill.value = LIGHT && look.fill ? look.fill - 1 : 0;
      if (!l.userData.fallback) u.uSpark.value = look.spark;
      l.material.blending = LIGHT ? NORMAL : ADD;
      const gw = l.userData.glow;
      if (gw) {
        const g = gw.material.uniforms; g.uK.value = look.glow.k; g.uA.value.set(look.glow.a); g.uB.value.set(look.glow.b); g.uLt.value = LIGHT ? 1 : 0;
        g.uM.value.set(look.glow.m != null ? look.glow.m : look.glow.a);
        gw.material.blending = LIGHT ? NORMAL : ADD;
        // daylight: the plane reaches the shadow's offset further down (its top edge stays the grid's own)
        const dy = LIGHT ? (look.glow.dy || 0) : 0, dv = gw.userData.dv, x = (dv + dy) / dv;
        g.uX.value = x; gw.scale.y = x; gw.position.y = gw.userData.y0 - (dy * l.userData.W) / 2;
        if (LIGHT) { g.uW.value.set(look.glow.knock || 0, look.glow.shadow || 0, dy / dv); g.uS.value.set(look.glow.sc || 0); }
        const D = LIGHT && look.glow.deep; g.uDp.value.set(D ? D.k : 0, D ? D.lo : 2, D ? D.hi : 3, D ? D.lift : 0);
        if (D) { g.uIA.value.set(look.a); g.uIM.value.set(look.m); g.uIB.value.set(look.b); }
      }
    }
    // daylight: each layer's wash under its own dots, the roof's under the wordmark's (ink is laid in order; light adds up)
    if (logoR) { logoR.renderOrder = LIGHT ? -2 : 0; if (logoR.userData.glow) logoR.userData.glow.renderOrder = LIGHT ? -3 : 0; }
    if (logoA && logoA.userData.glow) logoA.userData.glow.renderOrder = LIGHT ? -1 : 0;
  }
  function themeOutro() {
    if (!logoB) return;
    const u = logoB.material.uniforms; logoB.material.blending = LIGHT ? NORMAL : ADD;
    // daylight: the lockup's look (intro.mjs LOOK_LIGHT.word): deep film ink, violet -> sapphire -> magenta (three
    // stops, uTri), firmer dots, larger inside the glyphs (uFill: they close into solid ink), the outline's dots in the
    // rim's luminous film (ink on paper has no glow to fill a soft dot out)
    const W = LOOK_LIGHT.word, R = W.rim;
    u.uA.value.set(LIGHT ? W.a : 0x2fd6c3); u.uB.value.set(LIGHT ? W.b : 0xa4e335); u.uGain.value = LIGHT ? 1 : 0.9;
    u.uTri.value = LIGHT ? 1 : 0; u.uM.value.set(W.m);
    u.uRk.value = LIGHT ? R.k : 0; u.uRA.value.set(R.a); u.uRM.value.set(R.m); u.uRB.value.set(R.b); u.uFill.value = LIGHT ? 0.45 : 0;
    u.uCore.value = LIGHT ? 0.38 : 0.05; u.uAlpha.value = LIGHT ? 1 : 0.9; u.uSize.value = (mobile ? 2.4 : 2.0) * (LIGHT ? (mobile ? 1.3 : 1.2) : 1);
  }
  function themeRoofMat() { pearl(roofMat, ROOF_NIGHT, { color: 0xf4faee, emissive: 0x1f5a3c, env: 1.2, metal: 0.2, rough: 0.24 }); }
  function themeRoof() {
    themeRoofMat();   // (the pearl's studio exists from the boot's second part on: the roof is built there)
    if (!roofRain) return;
    roofRain.blending = LIGHT ? NORMAL : ADD; roofRain.uniforms.uLt.value = LIGHT ? 1 : 0; roofRain.uniforms.uTail.value = LIGHT ? 3 : 1; roofRain.uniforms.uWk.value = 1; roofRain.uniforms.uSplash.value = LIGHT ? 0.38 : 0;
  }
  // the games: the column as iridescent pearl in the pearl studio (a lower env gain: the room is bright; a thin film and
  // the spectral rim), the card slabs as pearl glass tinted by their game, the confetti in the film's inks
  function themeTower() {
    if (!spine) return;
    const m = spine.material;
    if (!m.userData.night) m.userData.night = { color: m.color.getHex(), emissive: m.emissive.getHex(), env: m.envMapIntensity, metal: m.metalness, rough: m.roughness, irid: m.iridescence, ior: m.iridescenceIOR, thick: m.iridescenceThicknessRange ? m.iridescenceThicknessRange.slice() : null, cc: m.clearcoat, ccr: m.clearcoatRoughness };
    const n = m.userData.night;
    // (daylight: pearl on a lavender base, deep enough to hold its form, in its own coloured studio (envSpine); the
    // clearcoat's grazing Fresnel would print black specks along the silhouette on paper, so it is all but off (still
    // > 0: the same program); a thin film (iridescence on the desktop) and the film across the curvature (uFilm, every
    // device), the spectral rim on the edges)
    // (daylight: a dielectric pearl, not a mirror: low metalness and a satin roughness in the column's own feathered studio
    // (envSpine), a pale-cyan sheen, a thin film (iridescence, IOR 1.3, 250-650 nm: violet -> teal -> pink), a light
    // clearcoat, a lavender-white base; the film across the curvature by the fresnel, the occlusion in the crevices)
    if (LIGHT) {
      if (!envSpine && envOn) buildSpineEnv();
      m.envMap = envSpine; m.color.set(0xd3eedc); m.emissive.set(0x0a2a20); m.envMapIntensity = 1.0; m.metalness = 0.16; m.roughness = 0.34;
      if (n.irid != null) { m.iridescence = 1; m.iridescenceIOR = 1.3; m.iridescenceThicknessRange = [250, 650]; }
      if (n.cc != null) { m.clearcoat = 0.5; m.clearcoatRoughness = 0.12; }
      if (m.sheenColor) { m.sheenColor.set(0xd8f7c8); m.sheenRoughness = 0.35; }
      bakeSpineAO();
    } else {
      m.envMap = null; m.color.setHex(n.color); m.emissive.setHex(n.emissive); m.envMapIntensity = n.env; m.metalness = n.metal; m.roughness = n.rough;
      if (n.irid != null) { m.iridescence = n.irid; m.iridescenceIOR = n.ior; m.iridescenceThicknessRange = n.thick.slice(); }
      if (n.cc != null) { m.clearcoat = n.cc; m.clearcoatRoughness = n.ccr; }
      if (m.sheenColor) m.sheenColor.set(0x000000);
    }
    SPINE_RIM.value = LIGHT ? 0.24 : 0; SPINE_FILM.value = LIGHT ? 0.6 : 0; SPINE_AO.value = LIGHT ? 1 : 0;
    if (petalsMat) { petalsMat.uniforms.uLt.value = LIGHT ? 1 : 0; petalsMat.blending = LIGHT ? THREE.NormalBlending : THREE.AdditiveBlending; }
    CARD_LT.value = LIGHT ? 1 : 0; SLAB_LT.value = LIGHT ? 1 : 0; if (LIGHT && cards.length) loadArtLt();
    for (const g of cardGroups) { const sm = g.userData.slabMat; sm.color.setHex(LIGHT ? sm.userData.day : sm.userData.night); }
    cards.forEach((c, i) => { if (c.material.uniforms.uTitle.value !== BLANK_TEX) setTitle(i); if (c.material.uniforms.uTex.value) showArt(i); });
  }
  const ROOF_NIGHT = { color: roofMat.color.getHex(), emissive: roofMat.emissive.getHex(), env: roofMat.envMapIntensity, metal: roofMat.metalness, irid: roofMat.iridescence,
    ior: roofMat.iridescenceIOR, thick: roofMat.iridescenceThicknessRange ? roofMat.iridescenceThicknessRange.slice() : null, rough: roofMat.roughness, cc: roofMat.clearcoat, ccr: roofMat.clearcoatRoughness };
  // the daylight pearl's studio (buildSpineEnv), shared by the column and the hero roof: one pearl
  const pearlEnv = () => { if (!envSpine && envOn) buildSpineEnv(); return envSpine; };
  // (daylight: the pearl recipe: a dielectric, satin, with a pale-cyan sheen, a thin film (IOR 1.3, 250-650 nm), a light
  // clearcoat, in the pearl's studio; the night's values back at night)
  const pearl = (m, night, o) => {
    if (LIGHT) {
      m.envMap = pearlEnv(); m.color.set(o.color); m.emissive.set(o.emissive); m.envMapIntensity = o.env; m.metalness = o.metal; m.roughness = o.rough;
      if (night.irid != null) { m.iridescence = 1; m.iridescenceIOR = 1.3; m.iridescenceThicknessRange = [250, 650]; }
      if (night.cc != null) { m.clearcoat = 0.5; m.clearcoatRoughness = 0.12; }
      if (m.sheenColor) { m.sheenColor.set(0xd8f7c8); m.sheenRoughness = 0.35; }
    } else {
      m.envMap = null; m.color.setHex(night.color); m.emissive.setHex(night.emissive); m.envMapIntensity = night.env; m.metalness = night.metal; m.roughness = night.rough;
      if (night.irid != null) { m.iridescence = night.irid; m.iridescenceIOR = night.ior; m.iridescenceThicknessRange = night.thick.slice(); }
      if (night.cc != null) { m.clearcoat = night.cc; m.clearcoatRoughness = night.ccr; }
      if (m.sheenColor) m.sheenColor.set(0x000000);
    }
  };
  function applyTheme() {
    govQuiet(1500);   // (the switch is one-off work: not a measure for the governor)
    renderer.toneMapping = LIGHT ? THREE.NoToneMapping : THREE.NeutralToneMapping;   // daylight: the paper is the page's own colour
    scene.fog.color.set(LIGHT ? PAPER : 0x02100e);
    const nu = nebula.material.uniforms; nu.uLight.value = LIGHT ? 1 : 0;
    dustMat.blending = LIGHT ? NORMAL : ADD; dustMat.uniforms.uCol.value.copy(LIGHT ? INK_DUST : STAR_DUST); dustMat.uniforms.uK.value = LIGHT ? 0.3 : 1; dustMat.uniforms.uLt.value = LIGHT ? 1 : 0;
    finalPass.uniforms.uLight.value = LIGHT ? 1 : 0; finalPass.uniforms.uGrain.value = LIGHT ? 0.026 : 0.045;
    ROOF_TINT.uTK.value = LIGHT ? 1 : 0;
    // daylight: pearl rather than mirror (lower metalness), lilac in the occluded faces, a thin film (lower IOR, thinner
    // than the night's: a soft pink-violet-aqua sheen, not a rainbow) and the spectral rim on its edges
    themeRoofMat();
    ROOF_TINT.uRim.value = LIGHT ? 0.85 : 0;
    { const at = lightsAt; lightsAt = ''; setLights(at); }   // the lights' colours for the theme
    themeIntro(); themeOutro(); themeRoof(); themeTower(); setEnv();
    if (globe && globe.setTheme) globe.setTheme(LIGHT);
  }
  applyTheme();
  // the site's theme is html.dark (ThemeScript, the header toggle)
  const themeMo = 'MutationObserver' in window ? new MutationObserver(() => { const l = themeLight(); if (l !== LIGHT) { LIGHT = l; applyTheme(); } }) : null;
  if (themeMo) themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  /* the other theme, made ahead. A few seconds after the boot, while the visitor is not scrolling, the theme not on
     screen is prepared in idle slices: its studio light (PMREM), each card's face and title, the daylight art and
     globe; then every program it uses is compiled in parallel (the theme flipped and back within one task: no frame is
     drawn in between). A switch then flips uniforms and textures only, and the sweep across the screen (main.js) runs
     with nothing being built under it. */
  let otherDone = false;
  const prepOther = async () => {
    if (otherDone || !full || LITE) return; otherDone = true;   // (LITE: a theme switch makes what it needs then)
    const to = !LIGHT, k = to ? 1 : 0;
    const calm = async () => {
      if (!live()) return false;
      await new Promise((r) => whenIdle(r, 3000));
      for (let w = 0; (stillFrames < 30 || document.hidden) && w < 40; w++) await new Promise((r) => setTimeout(r, 400));
      return live() && LIGHT !== to;   // (false: the visitor switched meanwhile, and the switch made what it needed)
    };
    try {
      if (to) {
        if (!(await calm())) return; if (!envLight) buildLightEnv();
        if (!(await calm())) return; if (!envSpine && envOn) buildSpineEnv();
        loadArtLt();
      }
      for (let i = 0; i < cards.length; i++) {
        if (!(await calm())) return;
        const u = cards[i].material.uniforms;
        if (u.uTitle.value !== BLANK_TEX && !titles[i][k]) { titles[i][k] = titleTexture(GAMES[i], !!k); renderer.initTexture(titles[i][k]); }
        if (u.uTex.value && !artTex[i][k]) { const clr = k ? artImgsLt[i] : null; artTex[i][k] = cardTexture(GAMES[i], i, clr || artImgs[i], !!k, !!clr); renderer.initTexture(artTex[i][k]); }
      }
      if (!(await calm())) return;
      LIGHT = to; applyTheme();
      const prev = renderer.getRenderTarget(); renderer.setRenderTarget(composer.renderTarget1);
      const done = renderer.compileAsync(scene, camera); renderer.setRenderTarget(prev);
      LIGHT = !to; applyTheme();
      await Promise.race([done, new Promise((r) => setTimeout(r, 8000))]);
      if (DEBUG) console.info('[theme] the other theme is ready');
    } catch (e) { if (DEBUG) console.warn('theme prep', e); }
  };

  /* ---------- boot, in two parts. The copy and the intro's lockup are on screen from the first paint (the shell and the
     poster), so nothing here holds what a visitor first sees.
     1. The intro: the poster's particles over the nebula. Their few programs are compiled in parallel, one frame is
        drawn, and the canvas fades in under the poster, which then hands the lockup over (startIntro).
     2. Everything else, cut into slices with yields between them while the intro runs: the stations' meshes, the studio
        light, the games' art and the spine model (waited for a moment, as before), the outro, the card faces; then every
        program is compiled in parallel and every station drawn once off screen (buffers and textures uploaded), and
        only then are the other stations drawn (full): reaching one never compiles or uploads anything. Whatever misses
        its moment (slow line) is swapped in later, compiled and uploaded off screen first; the globe never holds the boot. */
  const until = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  // (a compile wait ends when the programs are ready, or the page is gone / the context lost; the long cap is only a
  // last resort for a driver that never reports completion)
  const ready = (p, ms = 60000) => new Promise((res) => {
    let iv = 0; const end = () => { clearInterval(iv); res(); };
    Promise.resolve(p).then(end, end);
    iv = setInterval(() => { if (!live() || renderer.getContext().isContextLost()) end(); }, 250);
    setTimeout(end, ms);
  });
  // every program the scene needs, compiled in parallel (KHR_parallel_shader_compile) for the composer's render-target
  // state, so the driver works off the main thread
  // (the programs are linked in parallel off the main thread (KHR_parallel_shader_compile); the first draw that meets
  // one still linking waits for it on the main thread, which on ANGLE / D3D11 froze the page for seconds. So nothing is
  // drawn before its program is ready: the boot awaits these, the intro keeps running meanwhile)
  const startCompile = (root = scene) => {
    const prev = renderer.getRenderTarget(); renderer.setRenderTarget(composer.renderTarget1);
    try { return renderer.compileAsync(root, camera, scene); } finally { renderer.setRenderTarget(prev); }
  };
  const compileAll = (ms) => ready(startCompile(), ms);
  // the programs no scene object carries: the post chain (bloom; the final pass, drawn to the screen) and PMREM's own
  // (the environment bakes), compiled with the intro instead of synchronously by their first use
  const compileSupport = () => {
    const geo = new THREE.PlaneGeometry(2, 2), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), own = [];
    const quad = (m) => new THREE.Mesh(geo, m);
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    try { pmrem._setSize(ENV_SIZE); pmrem._allocateTargets().dispose(); } catch (e) { /* internals changed: they compile on first use */ }
    const offscreen = new THREE.Scene(), onscreen = new THREE.Scene();
    for (const m of [pmrem._blurMaterial, pmrem._ggxMaterial, bloom.materialHighPassFilter, ...(bloom.separableBlurMaterials || []), bloom.compositeMaterial, bloom.blendMaterial]) if (m) offscreen.add(quad(m));
    for (const side of [THREE.BackSide, THREE.DoubleSide]) { const m = new THREE.MeshBasicMaterial({ side }); own.push(m); offscreen.add(quad(m)); }   // (the env scenes' boxes and panels)
    onscreen.add(quad(finalPass.material));
    const prev = renderer.getRenderTarget(); let a, b;
    try { renderer.setRenderTarget(rt); a = renderer.compileAsync(offscreen, cam); renderer.setRenderTarget(null); b = renderer.compileAsync(onscreen, cam); }
    finally { renderer.setRenderTarget(prev); }
    return Promise.all([a, b]).finally(() => { rt.dispose(); geo.dispose(); own.forEach((m) => m.dispose()); });
  };

  /* the handle the shell keeps: dispose() frees the GPU and the DOM the scene made (the listeners go with core's
     registry); setWay(i) follows the ways-to-buy tabs (no 3D of its own there yet) */
  const teardown = () => {
    if (gone) return; gone = true;
    try { renderer.setAnimationLoop(null); } catch (e) { /* lost context */ }
    if (themeMo) themeMo.disconnect();
    try { for (const v of [gv, sb]) { v.pause(); v.removeAttribute('src'); v.load(); } } catch (e) { /* no media */ }
    for (const u of blobUrls.values()) URL.revokeObjectURL(u);
    if (globe) { globe.dispose(); globe = null; }
    if (nodeChip) nodeChip.remove(); geoLabels.forEach((g) => g.el.remove()); geoLabels = [];
    const texs = new Set();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of ms) { for (const k in m) { const v = m[k]; if (v && v.isTexture) texs.add(v); } if (m.uniforms) for (const k in m.uniforms) { const v = m.uniforms[k] && m.uniforms[k].value; if (v && v.isTexture) texs.add(v); } m.dispose(); }
    });
    for (const arr of [artTex, titles]) for (const pair of arr) for (const tx of pair) if (tx) texs.add(tx);
    texs.forEach((tx) => tx.dispose());
    for (const e of [envDark, envLight, envSpine]) if (e) e.dispose();
    try { pmrem.dispose(); composer.dispose(); } catch (e) { /* already gone */ }
    try { renderer.dispose(); renderer.forceContextLoss(); } catch (e) { /* already gone */ }
    renderer = null;
    if (DEBUG) delete window.__s;
  };
  const handle = { dispose: teardown, setWay: () => {} };

  // 1. the intro
  buildIntroLogos();
  camera.position.set(...STN[0].pos); camera.lookAt(...STN[0].look); nebula.position.copy(camera.position);
  await Promise.all([compileAll(), ready(compileSupport())]);
  if (!live()) { teardown(); return handle; }
  markB('intro-compiled');
  // the poster's entrance (its particles flying in, poster.js) plays out first (main.js normally starts the scene only
  // once it has): the canvas shows and takes the lockup over once it stands still; the rest of the boot goes on meanwhile
  const showIntro = () => {
    if (!live()) return;
    boot.sceneLoop = true;   // the shell's DOM loop stops: frame() drives the DOM from here
    frame();                 // a first frame (the post chain's small programs compile here) before the canvas shows
    renderer.setAnimationLoop(frame);
    endBoot(startIntro);
    markB('visible');
  };
  if (PST && PST.flying && PST.settled) until(PST.settled, 4500).then(showIntro); else showIntro();
  // and the heavy part of the boot waits for that too (main.js starts the scene as the flight is nearly down)
  if (PST && PST.flying && PST.settled) await until(PST.settled, 4500);
  if (!live()) { teardown(); return handle; }

  // 2. everything else: in the background (the handle is the shell's from here on; every slice checks it is still wanted)
  (async () => {
  await step();
  if (LIGHT) { envOn = true; setEnv(); }   // the daylight studio (the night one is baked when its light has landed)
  const envReady = studioTex.then((src) => (src ? bakeStudioEnv(src) : null)).catch((e) => console.warn('studio env unavailable, keeping the procedural one', e));
  prefetchGlobe();
  if (!lazyQA && !frugal) requestAnimationFrame(() => setTimeout(startGlobe, 0));
  buildRoof(); markB('roof'); await step();
  buildTower(); markB('tower-built'); loadArt(); const spineModelLoad = loadSpineModel(); markB('tower'); await step();
  placeGroups(); markB('groups');
  // (the programs' keys depend on the environment's kind, so it is in place before they compile: the studio light,
  // which is small and on its way since the start (one bake); the procedural one only if the studio is late)
  await ready(envReady, 4000); if (!live()) throw ABORT;
  if (!LIGHT && !envDark) buildNeonEnv();
  markB('neon');
  const stationsCompiled = compileAll(); markB('compile-start');
  await step();
  await until(document.fonts.ready, 1500);
  try { await until(Promise.all([document.fonts.load(`800 40px ${SANS}`), document.fonts.load(`500 40px ${MONO}`)]), 3000); } catch (e) { /* fall back to system fonts */ }
  await until(envReady, 1200); if (!live()) throw ABORT;
  // the games' art and the spine model are warmed with everything else when they land in time, so nothing is
  // compiled or uploaded once the visitor scrolls
  await until(Promise.all(artLoads), 1500);
  await until(spineModelLoad, 2500);
  markB('assets');
  // the globe never holds the boot. If it is fully compiled by now it is warmed here with everything else;
  // if it lands later the frame loop uploads and warms it in small batches
  if (globeState === 'upload' && !LITE) { globeUploads.splice(0).forEach((tx) => renderer.initTexture(tx)); globeState = 'ready'; mark('ready-boot'); }   // (LITE: the frame loop's lazy path, one map per calm frame)
  mark('boot-warm');
  // card faces: what has landed is drawn now (titles need the fonts loaded above), a card per slice
  for (let i = 0; i < cards.length; i++) { setCardTex(i); await step(); }
  cardsReady = true;
  cards.forEach((c, i) => { if (artImgs[i] && cardArt[i] !== artImgs[i]) whenIdle(() => setCardTex(i)); });   // landed during those slices
  spineSwap();
  measure();
  markB('built');
  await step();
  if (!envDark) buildNeonEnv();   // the studio light is late: start with the procedural one (same cube size: no recompile when it swaps)
  mark('boot-compile');
  await stationsCompiled; await compileAll(); if (!live()) throw ABORT;   // (the second call only waits for anything added since)
  markB('compiled');
  if (globeState === 'upload' && !LITE) { globeUploads.splice(0).forEach((tx) => renderer.initTexture(tx)); globeState = 'ready'; mark('ready-boot'); }
  // every station drawn once off screen, into a small target in the RenderPass's state (the same program variants),
  // so its buffers and textures are uploaded; the intro keeps running on screen between the slices. A globe that is
  // still compiling stays out of this pass (it takes the lazy path in the frame loop instead).
  {
    const warmRT = new THREE.WebGLRenderTarget(64, 64, { type: THREE.HalfFloatType }); const cam = camera.clone();
    for (const st of STN) {
      const vis = []; scene.traverse((o) => { vis.push([o, o.visible]); o.visible = true; });
      globeHolder.visible = globeState === 'ready';
      cam.position.set(...st.pos); cam.lookAt(...st.look); cam.updateMatrixWorld();
      const prev = renderer.getRenderTarget(); renderer.setRenderTarget(warmRT); renderer.render(scene, cam); renderer.setRenderTarget(prev);
      vis.forEach(([o, v]) => { o.visible = v; });
      await step();
    }
    warmRT.dispose();
  }
  full = true;
  fullBoot();
  /* what only the last station needs, made after the boot in a quiet moment: the outro's lockup (its text sampled, then
     its program compiled in parallel before it is ever drawn); then the page counts as settled (html.gl-settled: main.js
     hands the pointer to the custom cursor only then, so the cursor never stalls under the boot's work) */
  (async () => {
    await new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 2500 }) : setTimeout(r, 60)));
    if (!logoB) {
      buildOutro();
      if (logoB) { await ready(startCompile(logoB)); logoBReady = true; }
    }
    await until(envReady, 6000);
    setTimeout(() => { if (live()) document.documentElement.classList.add('gl-settled'); }, 600);
  })().catch(() => { if (live()) document.documentElement.classList.add('gl-settled'); });
  setTimeout(() => { if (live()) prepOther(); }, mobile ? 12000 : 8000);   // (well after the first seconds, when the visitor starts to move)
  mark('boot-done'); markB('warm');
  // deep links for review: ?s=games|route|plans|play
  const jump = { intro: IDX.intro, hero: IDX.hero, categories: IDX.categories, games: IDX.categories, suppliers: IDX.suppliers, route: IDX.suppliers, process: IDX.process, ways: IDX.ways, cta: IDX.cta }[params.get('s')];
  if (jump != null && jump >= 0 && metrics[jump]) { measure(); const m = metrics[jump]; const y = m.a + (m.b - m.a) * clamp(+params.get('p') || 0); window.scrollTo(0, y); state.scroll = y; }
  if (DEBUG) window.__s = { scene, camera, renderer, composer, bloom, finalPass, get logoA() { return logoA; }, get dpr() { return Q.dpr; }, GPU, get logoR() { return logoR; }, emblem, roof, tower, globe: globeHolder, get globeApi() { return globe; }, get globeState() { return globeState; }, get spine() { return spineIn ? 'model' : spineMesh ? 'loaded' : 'procedural'; }, get vid() { return { vKilled, gvIdx, gvReady, gvFocus, gvBad, soundOn, paused: gv.paused, muted: gv.muted, rs: gv.readyState, err: gv.error && gv.error.code, t: gv.currentTime, src: gv.src.slice(0, 60), need: Math.round(vidNeed), cap: VID_CAP, play: cards.map((c) => +c.material.uniforms.uPlay.value.toFixed(2)) }; } };
  if (lazyQA) setTimeout(startGlobe, 500);

  /* the spine model, if it landed after the warm-up: a different program (not instanced), so it is compiled in
     parallel first, then its buffers are uploaded with one off-screen draw, and only then does it replace the
     procedural column (no frame ever compiles or uploads it) */
  let warmRT1 = null;
  const warmOnly = (obj) => {
    if (!warmRT1) warmRT1 = new THREE.WebGLRenderTarget(64, 64, { type: THREE.HalfFloatType });
    const flags = [], anc = [];
    scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine || o.isSprite) { flags.push([o, o.visible]); o.visible = o === obj; } });
    for (let p = obj.parent; p; p = p.parent) { anc.push([p, p.visible]); p.visible = true; }
    const prev = renderer.getRenderTarget(); renderer.setRenderTarget(warmRT1); renderer.render(scene, camera); renderer.setRenderTarget(prev);
    flags.forEach(([o, v]) => { o.visible = v; }); anc.forEach(([o, v]) => { o.visible = v; });
  };
  const lateSpine = async () => {
    if (!spineMesh || spineIn) return;
    const prev = renderer.getRenderTarget(); renderer.setRenderTarget(composer.renderTarget1);
    const ready = renderer.compileAsync(spineMesh, camera, scene); renderer.setRenderTarget(prev);
    await until(ready, 4000);
    whenIdle(() => {
      if (spineIn) return;
      markB('spine-late'); spineHolder.add(spineMesh); warmOnly(spineMesh); spineHolder.remove(spine); spineIn = true; markB('spine-late-done');
      if (LIGHT) whenIdle(bakeSpineAO);
      if (DEBUG) console.info('[scene] spine model swapped in after the boot');
    }, 2000);
  };
  spineModelLoad.then(() => { if (spineMesh && !spineIn) whenIdle(lateSpine, 3000); });
  })().catch((e) => { if (e !== ABORT) console.warn('3D scene boot', e); if (!live()) teardown(); });
  return handle;
}
