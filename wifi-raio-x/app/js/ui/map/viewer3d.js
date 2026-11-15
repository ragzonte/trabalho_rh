// Visualizador 3D do mapa feito só com Wi-Fi (three.js / WebGL2), com queda automática
// para o mapa 2D (viewer2d.js) quando o aparelho não tem WebGL2 ou o contexto se perde de vez.
//
//   import { createViewer } from './viewer3d.js';
//   const viewer = createViewer(container, { theme: 'dark', onPick: (pick) => ... });
//   viewer.setModel(model);            // MapModel de mapping/types.js (ou null)
//   viewer.setHeat(fields);            // HeatField[] na ordem de model.floors, ou null (cor por ambiente)
//   viewer.setLayers({ relief: true });
//   ...
//   viewer.destroy();
//
// Interface (igual nos dois visualizadores; no 2D, o que não se aplica é aceito e ignorado):
//   kind                         '3d' | '2d' (muda sozinho para '2d' se o 3D se perder; avisa em options.onFallback)
//   setModel(model, {keepView})  mantém a câmera quando é uma atualização do mesmo mapa (levantamento ao vivo);
//                                reenquadra quando é outro mapa. `keepView` (true/false) passa por cima do palpite
//   setHeat(fields | null)       setLayers(parcial)        getLayers()
//   setView('orbit' | 'top')     resetView()               setExplode(0..1)
//   setFocusFloor(andar | null)  setWalker({x, y, z} | null)   setTheme('dark' | 'light')
//   setPadding({top, right, bottom, left})   área (px) coberta por controles da tela: o mapa é enquadrado no resto
//   setOnPick(fn)                worldToScreen({x, y, z | floor}) -> {x, y, visible}
//   pickAt(x, y) -> pick | null  (mesmo objeto do onPick, sem chamar o onPick)
//   snapshot() -> Promise<Blob>  PNG da vista atual           resize()   destroy()   stats()
//
// onPick recebe { kind: 'room' | 'cell' | 'router' | 'spot', x, y, floor, floorIndex, label, ... }:
//   room/cell: room (MapRoom | null), roomId, dbm (com mapa de calor), conf, cell, ix, iy
//   router: ap (MapAp), id, own        spot: spot (MapSpot), id
//
// Opções: theme, onPick, onFallback(motivo), renderer ('auto' | '3d' | '2d'), padding, label (aria),
//         ambient (false desliga a pulsação dos roteadores), maxPixelRatio (padrão 2),
//         reducedMotion (padrão: o que o sistema pede), contextRestoreMs (espera pelo contexto: 4000)
//
// Honestidade: o mapa é aproximado. Por isso o contorno é um vidro baixo de quinas macias,
// as divisões internas são tracejadas e o piso fica neutro e hachurado onde a confiança é baixa.
//
// Desempenho: só desenha quando algo muda (toque, animação, dado novo); a pulsação dos
// roteadores roda a ~30 quadros/s e dorme depois de um tempo sem toque; a resolução cai
// durante o movimento se o aparelho não dá conta e volta quando a cena para.

import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Group,
  Mesh,
  Sprite,
  SpriteMaterial,
  ShaderMaterial,
  MeshBasicMaterial,
  BufferGeometry,
  BufferAttribute,
  PlaneGeometry,
  CylinderGeometry,
  SphereGeometry,
  OctahedronGeometry,
  CircleGeometry,
  RingGeometry,
  DataTexture,
  CanvasTexture,
  Color,
  Vector2,
  Vector3,
  Vector4,
  Raycaster,
  SRGBColorSpace,
  NoColorSpace,
  LinearFilter,
  ClampToEdgeWrapping,
  RGBAFormat,
  UnsignedByteType,
  DoubleSide,
  AdditiveBlending,
  NormalBlending,
  OrbitControls,
  MOUSE,
  TOUCH,
} from '../../../vendor/three.min.js';

import { mapTheme, paintFloorCells, hexToRgb, signalHeight01, CONF_NONE, CONF_FULL, CONF_TINT } from './map-colors.js';
import {
  createViewer2d,
  DEFAULT_LAYERS,
  prepareOutline,
  prepareInnerWalls,
  modelExtent,
  floorIndexOf,
  nearestFloorIndex,
  placeAps,
  pathRuns,
  declutter,
  niceScale,
  isSameMap,
  approxMeters,
  layoutLabel,
  paintLabel,
  createScaleBar,
  paintScaleBar,
  floorPick,
  namesRoom,
  routerLabel,
  prefersReducedMotion,
} from './viewer2d.js';

export { DEFAULT_LAYERS };

const RELIEF_MAX = 1.2; // altura máxima do relevo de sinal (m)
const SLAB = 0.12; // espessura da laje desenhada (m)
const FOV = 32;
const POLAR_ORBIT = 0.93; // inclinação padrão da vista em órbita (rad a partir da vertical)
const POLAR_MAX = 1.4; // a câmera nunca desce abaixo disto: não passa para baixo do piso
const POLAR_TOP = 1e-4;
const GHOST = 0.22; // quanto sobra do contorno de um andar fora de foco
const AMBIENT_SLEEP_MS = 20000; // sem toque nem dado novo por este tempo, a pulsação dorme
const TAP_DELAY_MS = 230; // espera pelo segundo toque antes de avisar o onPick

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const vec3Of = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return new Vector3(r / 255, g / 255, b / 255);
};
const setVec3 = (v, hex) => {
  const [r, g, b] = hexToRgb(hex);
  v.set(r / 255, g / 255, b / 255);
};

// ---------------------------------------------------------------------------
// Shaders (escritos como GLSL 1; o three.js converte para WebGL2).
// As cores entram e saem em sRGB, sem conversão: o que está na paleta é o que aparece.
// ---------------------------------------------------------------------------

const FLOOR_VERT = /* glsl */ `
attribute float aH;
attribute vec2 aG;
attribute float aKind;
uniform float uRelief;
varying vec3 vPos;
varying vec2 vG;
varying float vKind;
varying float vH;
void main() {
  vec3 p = position;
  p.z += aH * uRelief;
  vPos = p;
  vG = aG;
  vKind = aKind;
  vH = aH;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FLOOR_FRAG = /* glsl */ `
uniform sampler2D uColA;
uniform sampler2D uColB;
uniform sampler2D uMask;
uniform float uMix;
uniform float uFade;
uniform float uRelief;
uniform float uTime;
uniform float uContour;
uniform float uRings;
uniform float uRingGap;
uniform float uRingReach;
uniform float uHatchFreq;
uniform vec2 uOrigin;
uniform vec2 uInvSize;
uniform vec3 uNeutral;
uniform vec3 uHatch;
uniform vec3 uSlab;
uniform vec3 uRingColor;
uniform vec4 uRouters[4];
varying vec3 vPos;
varying vec2 vG;
varying float vKind;
varying float vH;
void main() {
  vec2 uv = (vPos.xy - uOrigin) * uInvSize;
  vec4 tex = mix(texture2D(uColA, uv), texture2D(uColB, uv), uMix);
  // pouca confiança: a cor some no tom neutro (a mesma curva de confWeight em map-colors.js)
  float w = smoothstep(${CONF_NONE.toFixed(3)}, ${CONF_FULL.toFixed(3)}, tex.a);
  vec3 col = mix(uNeutral, tex.rgb, ${CONF_TINT.toFixed(3)} + ${(1 - CONF_TINT).toFixed(3)} * w);
  float alpha = 1.0;
  if (vKind > 1.5) {
    col = uSlab; // lateral da laje
  } else if (vKind > 0.5) {
    col = mix(uSlab, col, 0.5) * (0.82 + 0.18 * vH); // "barranco" do relevo
  } else {
    float m = texture2D(uMask, uv).r;
    float aa = max(fwidth(m), 0.0005);
    alpha = clamp((m - 0.5) / aa + 0.5, 0.0, 1.0);
    if (alpha < 0.02) discard;

    // hachura na diagonal onde o mapa é um palpite; de longe vira um tom médio (sem moiré)
    float s = (vPos.x + vPos.y) * uHatchFreq;
    float fs = fwidth(s);
    float tri = abs(fract(s) - 0.5) * 2.0;
    float line = 1.0 - smoothstep(0.26 - fs, 0.26 + fs, tri);
    float crisp = clamp(1.6 - fs * 3.2, 0.0, 1.0);
    col = mix(col, uHatch, (1.0 - w) * 0.6 * mix(0.26, line, crisp));

    // curvas de nível do sinal
    float c = vH * 11.0;
    float fc = fwidth(c);
    float iso = 1.0 - smoothstep(0.0, 1.4 * fc, abs(fract(c + 0.5) - 0.5));
    col *= 1.0 - 0.2 * iso * uContour * clamp(1.0 - fc * 3.5, 0.0, 1.0) * w;

    // relevo: luz vinda de um lado
    vec3 n = normalize(vec3(-vG * uRelief, 1.0));
    float lambert = dot(n, vec3(-0.46, -0.36, 0.81));
    col *= clamp(1.0 + (lambert - 0.81) * 0.95, 0.62, 1.22);

    // ondas do sinal saindo dos roteadores da casa (e o círculo tracejado de incerteza da posição)
    float acc = 0.0;
    for (int i = 0; i < 4; i++) {
      vec4 r = uRouters[i];
      if (r.w > 0.0) {
        vec2 dv = vPos.xy - r.xy;
        float d = length(dv);
        float ph = d / uRingGap - uTime * 0.42;
        float band = pow(0.5 + 0.5 * cos(6.2831853 * ph), 10.0);
        float fall = smoothstep(uRingReach, 0.15, d);
        float fd = fwidth(d) / uRingGap;
        acc += band * fall * fall * r.w * clamp(1.0 - fd * 3.0, 0.0, 1.0);
        if (r.z > 0.0) {
          float fw = max(fwidth(d), 0.0005);
          float edge = 1.0 - smoothstep(fw * 0.8, fw * 2.2, abs(d - r.z));
          float ang = atan(dv.y, dv.x) * r.z * 2.4;
          float fa = fwidth(ang);
          float dash = smoothstep(0.5 - fa, 0.5 + fa, abs(fract(ang) - 0.5) * 2.0);
          acc += edge * dash * 0.9 * r.w * step(fa, 0.5);
        }
      }
    }
    col = mix(col, uRingColor, clamp(acc * 0.5, 0.0, 0.7) * uRings);
    if (!gl_FrontFacing) col = uSlab;
  }
  gl_FragColor = vec4(col, alpha * uFade);
}`;

const WALL_VERT = /* glsl */ `
attribute float aH;
attribute float aA;
attribute vec2 aDash;
attribute float aTone;
attribute vec2 aOff;
uniform float uRelief;
uniform float uWiden;
varying float vA;
varying vec2 vDash;
varying float vTone;
void main() {
  // com o relevo ligado as paredes encolhem e passam a acompanhar o terreno
  float shrink = mix(1.0, 0.3, clamp(uRelief / ${RELIEF_MAX.toFixed(2)}, 0.0, 1.0));
  vec3 p = position;
  p.xy += aOff * (uWiden - 1.0); // de longe a aresta engrossa para não virar um fio serrilhado
  p.z = p.z * shrink + aH * uRelief + 0.004;
  vA = aA;
  vDash = aDash;
  vTone = aTone;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const WALL_FRAG = /* glsl */ `
uniform vec3 uGlass;
uniform vec3 uEdge;
uniform vec3 uInner;
uniform vec3 uNeighbour;
uniform float uFade;
uniform float uCut;
varying float vA;
varying vec2 vDash;
varying float vTone;
void main() {
  vec3 col = vTone < 0.5 ? uGlass : (vTone < 1.5 ? uEdge : (vTone < 2.5 ? uInner : uNeighbour));
  float mask = 1.0;
  if (vDash.y > 0.0) {
    float s = vDash.x / vDash.y;
    float f = fwidth(s);
    mask = 1.0 - smoothstep(0.56 - f, 0.56 + f, abs(fract(s) - 0.5) * 2.0);
    mask = mix(0.55, mask, clamp(1.4 - f * 2.8, 0.0, 1.0));
  }
  if (uCut > 0.5 && mask < 0.3) discard;
  gl_FragColor = vec4(col, vA * mask * uFade);
}`;

const PATH_VERT = /* glsl */ `
attribute float aH;
attribute float aSide;
attribute float aT;
attribute float aConf;
attribute float aDist;
attribute vec2 aOff;
uniform float uRelief;
uniform float uWiden;
varying float vSide;
varying float vT;
varying float vConf;
varying float vDist;
void main() {
  vec3 p = position;
  p.xy += aOff * (uWiden - 1.0);
  p.z += aH * uRelief;
  vSide = aSide;
  vT = aT;
  vConf = aConf;
  vDist = aDist;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const PATH_FRAG = /* glsl */ `
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uCasing;
uniform float uFade;
varying float vSide;
varying float vT;
varying float vConf;
varying float vDist;
void main() {
  vec3 col = vT < 0.5 ? mix(uC0, uC1, vT * 2.0) : mix(uC1, uC2, vT * 2.0 - 1.0);
  float e = abs(vSide);
  float fe = max(fwidth(e), 0.001);
  col = mix(col, uCasing, smoothstep(0.6 - fe, 0.6 + fe, e) * 0.85);
  float body = 1.0 - smoothstep(1.0 - 1.5 * fe, 1.0, e);
  // onde a posição é duvidosa o traço fica tracejado e mais apagado
  float s = vDist / 0.4;
  float fs = fwidth(s);
  float dash = 1.0 - smoothstep(0.58 - fs, 0.58 + fs, abs(fract(s) - 0.5) * 2.0);
  dash = mix(0.6, dash, clamp(1.4 - fs * 2.8, 0.0, 1.0));
  float sure = smoothstep(0.3, 0.55, vConf);
  float alpha = body * mix(dash * 0.7, 1.0, sure) * mix(0.45, 1.0, smoothstep(0.1, 0.6, vConf));
  gl_FragColor = vec4(col, alpha * uFade);
}`;

const GROUND_VERT = /* glsl */ `
varying vec2 vXY;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vXY = wp.xy;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const GROUND_FRAG = /* glsl */ `
uniform vec3 uBg;
uniform vec3 uGround;
uniform vec3 uLine;
uniform float uAlpha;
uniform float uRadius;
uniform vec2 uCenter;
uniform sampler2D uShadow;
uniform vec4 uShadowRect;
uniform float uShadowAmt;
varying vec2 vXY;
void main() {
  float d = distance(vXY, uCenter) / uRadius;
  float fade = 1.0 - smoothstep(0.35, 1.0, d);
  vec3 col = mix(uBg, uGround, fade * fade);
  // sombra de contato sob a casa
  vec2 suv = (vXY - uShadowRect.xy) * uShadowRect.zw;
  float sh = texture2D(uShadow, suv).r * step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0);
  col = mix(col, uBg * 0.55, sh * uShadowAmt);
  // grade de 1 m, com as linhas de 5 m mais fortes; some onde ficaria apertada demais
  vec2 f1 = fwidth(vXY);
  vec2 g1 = abs(fract(vXY - 0.5) - 0.5) / max(f1, vec2(1e-5));
  float minor = (1.0 - min(min(g1.x, g1.y), 1.0)) * clamp(1.0 - max(f1.x, f1.y) * 5.0, 0.0, 1.0);
  vec2 p5 = vXY / 5.0;
  vec2 f5 = fwidth(p5);
  vec2 g5 = abs(fract(p5 - 0.5) - 0.5) / max(f5, vec2(1e-5));
  float major = (1.0 - min(min(g5.x, g5.y), 1.0)) * clamp(1.0 - max(f5.x, f5.y) * 5.0, 0.0, 1.0);
  float a = max(minor, major * 1.7) * uAlpha * fade;
  col = mix(col, uLine, clamp(a, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// Fábrica: escolhe 3D ou 2D
// ---------------------------------------------------------------------------

/** O navegador consegue criar um contexto WebGL2? (cria e solta um contexto de teste) */
export function webgl2Available(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return false;
  try {
    const gl = doc.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * Cria o visualizador do mapa dentro de `container` (que deve ter tamanho definido).
 * @param {HTMLElement} container
 * @param {object} [options]  ver o cabeçalho do arquivo
 */
export function createViewer(container, options = {}) {
  // o que a tela pediu até agora: se o 3D cair, o 2D recomeça do mesmo ponto
  const state = { model: null, heat: null, layers: {}, focus: null, walker: null, theme: options.theme || 'dark', padding: options.padding || null, onPick: options.onPick || null };
  let impl = null;
  let destroyed = false;

  function fallback(reason) {
    if (destroyed || (impl && impl.kind === '2d')) return;
    try {
      impl?.destroy();
    } catch {
      /* o contexto já se foi: não há o que liberar */
    }
    impl = createViewer2d(container, { ...options, theme: state.theme, onPick: state.onPick, padding: state.padding || undefined });
    impl.setLayers(state.layers);
    if (state.model) impl.setModel(state.model, { keepView: false });
    if (state.heat) impl.setHeat(state.heat);
    if (state.focus !== null) impl.setFocusFloor(state.focus);
    if (state.walker) impl.setWalker(state.walker);
    if (typeof options.onFallback === 'function') options.onFallback(reason);
  }

  const want = options.renderer || 'auto';
  if (want !== '2d') {
    try {
      impl = createViewer3d(container, { ...options, onFatal: fallback });
    } catch (err) {
      impl = null;
      if (want === '3d') throw err;
    }
  }
  if (!impl) impl = createViewer2d(container, options);

  return {
    get kind() {
      return impl.kind;
    },
    get el() {
      return impl.el;
    },
    setModel(model, opts) {
      state.model = model || null;
      if (!model) state.heat = null;
      impl.setModel(model, opts);
    },
    setHeat(fields) {
      state.heat = fields || null;
      impl.setHeat(fields);
    },
    setLayers(partial) {
      Object.assign(state.layers, partial || {});
      impl.setLayers(partial);
    },
    getLayers: () => impl.getLayers(),
    setView: (mode) => impl.setView(mode),
    resetView: () => impl.resetView(),
    setExplode: (k) => impl.setExplode(k),
    setFocusFloor(floor) {
      state.focus = floor ?? null;
      impl.setFocusFloor(floor);
    },
    setWalker(pos) {
      state.walker = pos || null;
      impl.setWalker(pos);
    },
    setTheme(theme) {
      state.theme = theme;
      impl.setTheme(theme);
    },
    setPadding(p) {
      state.padding = p || null;
      impl.setPadding(p);
    },
    setOnPick(fn) {
      state.onPick = fn || null;
      impl.setOnPick(fn);
    },
    worldToScreen: (pos) => impl.worldToScreen(pos),
    pickAt: (x, y) => impl.pickAt(x, y),
    snapshot: () => impl.snapshot(),
    resize: () => impl.resize(),
    stats: () => impl.stats(),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      impl.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Construção de malhas
// ---------------------------------------------------------------------------

// Junta vértices e índices aos poucos e entrega uma BufferGeometry.
function meshBuilder(attrs) {
  const data = Object.fromEntries(Object.keys(attrs).map((k) => [k, []]));
  const index = [];
  let count = 0;
  return {
    get count() {
      return count;
    },
    vertex(values) {
      for (const k in attrs) {
        const v = values[k];
        if (attrs[k] === 1) data[k].push(v);
        else for (let i = 0; i < attrs[k]; i++) data[k].push(v[i]);
      }
      return count++;
    },
    quad(a, b, c, d) {
      index.push(a, b, c, a, c, d);
    },
    tri(a, b, c) {
      index.push(a, b, c);
    },
    build() {
      const g = new BufferGeometry();
      for (const k in attrs) g.setAttribute(k, new BufferAttribute(new Float32Array(data[k]), attrs[k]));
      g.setIndex(new BufferAttribute(count > 65535 ? new Uint32Array(index) : new Uint16Array(index), 1));
      return g;
    },
  };
}

// Deslocamento para os dois lados de cada ponto de uma linha, com emenda em esquadria (limitada).
function offsets(points, closed) {
  const n = points.length;
  const out = [];
  let dist = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const a = points[closed ? (i + n - 1) % n : Math.max(0, i - 1)];
    const b = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    let d0x = p[0] - a[0];
    let d0y = p[1] - a[1];
    let d1x = b[0] - p[0];
    let d1y = b[1] - p[1];
    const l0 = Math.hypot(d0x, d0y);
    const l1 = Math.hypot(d1x, d1y);
    if (l0 < 1e-9) {
      d0x = d1x;
      d0y = d1y;
    } else {
      d0x /= l0;
      d0y /= l0;
    }
    if (l1 < 1e-9) {
      d1x = d0x;
      d1y = d0y;
    } else {
      d1x /= l1;
      d1y /= l1;
    }
    if (l0 < 1e-9 && l1 >= 1e-9) {
      d0x = d1x;
      d0y = d1y;
    }
    let mx = -d0y - d1y;
    let my = d0x + d1x;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = -d1y;
      my = d1x;
    } else {
      mx /= ml;
      my /= ml;
    }
    const k = 1 / Math.max(0.5, mx * -d1y + my * d1x);
    if (i > 0) dist += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]);
    out.push({ x: p[0], y: p[1], nx: mx * k, ny: my * k, dist });
  }
  if (closed && n > 1) out.closing = dist + Math.hypot(points[0][0] - points[n - 1][0], points[0][1] - points[n - 1][1]);
  return out;
}

const WALL_ATTRS = { position: 3, aH: 1, aA: 1, aDash: 2, aTone: 1, aOff: 2 };

/**
 * Parede baixa ao longo de uma linha: a folha de vidro (em `sheets`) e a aresta de cima,
 * um prisma fino que se vê de qualquer ângulo (em `caps`).
 */
function addWall(sheets, caps, points, closed, o) {
  const off = offsets(points, closed);
  const n = off.length;
  const segs = closed ? n : n - 1;
  const hw = o.capW / 2;
  const top = o.height;
  const under = Math.max(0, top - o.capH);
  const period = o.dash || 0;
  const row = (i, dist) => {
    const p = off[i];
    const dash = [dist, period];
    const out = {};
    if (sheets && o.sheet0 + o.sheet1 > 0) {
      out.s0 = sheets.vertex({ position: [p.x, p.y, 0], aH: 0, aA: o.sheet0, aDash: [dist, 0], aTone: o.tone, aOff: [0, 0] });
      out.s1 = sheets.vertex({ position: [p.x, p.y, under], aH: 0, aA: o.sheet1, aDash: [dist, 0], aTone: o.tone, aOff: [0, 0] });
    }
    const lx = p.x + p.nx * hw;
    const ly = p.y + p.ny * hw;
    const rx = p.x - p.nx * hw;
    const ry = p.y - p.ny * hw;
    const offL = [p.nx * hw, p.ny * hw];
    const offR = [-p.nx * hw, -p.ny * hw];
    out.lt = caps.vertex({ position: [lx, ly, top], aH: 0, aA: o.capA, aDash: dash, aTone: o.capTone, aOff: offL });
    out.rt = caps.vertex({ position: [rx, ry, top], aH: 0, aA: o.capA, aDash: dash, aTone: o.capTone, aOff: offR });
    out.lb = caps.vertex({ position: [lx, ly, under], aH: 0, aA: o.capA * 0.8, aDash: dash, aTone: o.capTone, aOff: offL });
    out.rb = caps.vertex({ position: [rx, ry, under], aH: 0, aA: o.capA * 0.8, aDash: dash, aTone: o.capTone, aOff: offR });
    return out;
  };
  let prev = row(0, 0);
  for (let s = 0; s < segs; s++) {
    const j = (s + 1) % n;
    const cur = row(j, j === 0 ? off.closing : off[j].dist);
    if (prev.s0 !== undefined) sheets.quad(prev.s0, cur.s0, cur.s1, prev.s1);
    caps.quad(prev.lt, prev.rt, cur.rt, cur.lt);
    if (o.capH > 0) {
      caps.quad(prev.lb, prev.lt, cur.lt, cur.lb);
      caps.quad(prev.rt, prev.rb, cur.rb, cur.rt);
    }
    prev = cur;
  }
}

const PATH_ATTRS = { position: 3, aH: 1, aSide: 1, aT: 1, aConf: 1, aDist: 1, aOff: 2 };

function addRibbon(builder, pts, halfWidth, z) {
  const off = offsets(
    pts.map((p) => [p.x, p.y]),
    false,
  );
  let prev = null;
  off.forEach((p, i) => {
    const src = pts[i];
    const common = { aH: 0, aT: src.t, aConf: src.conf, aDist: src.d };
    const l = builder.vertex({ position: [p.x + p.nx * halfWidth, p.y + p.ny * halfWidth, z], aSide: 1, aOff: [p.nx * halfWidth, p.ny * halfWidth], ...common });
    const r = builder.vertex({ position: [p.x - p.nx * halfWidth, p.y - p.ny * halfWidth, z], aSide: -1, aOff: [-p.nx * halfWidth, -p.ny * halfWidth], ...common });
    if (prev) builder.quad(prev[0], prev[1], r, l);
    prev = [l, r];
  });
}

// Junta geometrias simples (só posição) numa só: menos chamadas de desenho por marcador.
function mergePositions(parts) {
  let total = 0;
  const flat = parts.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    total += ng.attributes.position.count;
    return ng;
  });
  const pos = new Float32Array(total * 3);
  let o = 0;
  for (const g of flat) {
    pos.set(g.attributes.position.array, o);
    o += g.attributes.position.array.length;
  }
  for (let i = 0; i < parts.length; i++) {
    if (flat[i] !== parts[i]) flat[i].dispose();
    parts[i].dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  return out;
}

// ---------------------------------------------------------------------------
// Visualizador 3D
// ---------------------------------------------------------------------------

function createViewer3d(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  let theme = mapTheme(options.theme);
  let onPick = typeof options.onPick === 'function' ? options.onPick : null;
  const maxPixelRatio = clamp(options.maxPixelRatio ?? 2, 0.5, 3);

  // --- DOM ---
  const root = doc.createElement('div');
  root.className = 'mapv mapv--3d';
  root.dataset.theme = theme.name;
  root.dataset.kind = '3d';
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  const canvas = doc.createElement('canvas');
  canvas.className = 'mapv__canvas';
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline-offset:-2px;';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', options.label || 'Mapa 3D da casa feito com o sinal do Wi-Fi. Arraste para girar; use dois dedos para aproximar e mover.');
  canvas.tabIndex = 0;

  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'default' });
  if (!gl) throw new Error('WebGL2 indisponível');
  const msaa = gl.getParameter(gl.SAMPLES) > 0;

  const renderer = new WebGLRenderer({ canvas, context: gl, antialias: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.sortObjects = true;
  const scaleBar = createScaleBar(doc);
  const message = doc.createElement('div');
  message.className = 'mapv__msg';
  message.hidden = true;
  message.setAttribute('role', 'status');
  root.append(canvas, scaleBar.el, message);
  container.append(root);

  // --- estado ---
  let model = null;
  let heat = null;
  let layers = { ...DEFAULT_LAYERS };
  let viewMode = 'orbit';
  let explode = 0; // valor pedido (0..1)
  let explodeNow = 0; // valor animado
  let reliefNow = 0; // 0..1 animado
  let focus = null; // número do andar em foco
  let walker = null;
  let padding = { top: 0, right: 0, bottom: 0, left: 0, ...(options.padding || {}) };
  let destroyed = false;
  let contextLost = false;
  let lostTimer = 0;
  let width = 0;
  let height = 0;
  let baseRatio = 1;
  let motionScale = 1; // cai quando o aparelho não acompanha o movimento
  let appliedRatio = 0;
  let userMoved = false;
  let needsFit = true;
  let extent = null;
  let unit = 1; // tamanho dos marcadores em relação ao da casa
  let frames = 0;
  let floorsState = []; // por andar: grupo, materiais, texturas...
  let labels = []; // rótulos ativos
  let markers = []; // alvos de toque: roteadores e pontos
  let anchors = []; // objetos que sobem com o relevo
  let apsPlaced = null;
  const reduceQuery = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => options.reducedMotion ?? (reduceQuery ? reduceQuery.matches : prefersReducedMotion());

  // --- cena ---
  const scene = new Scene();
  scene.background = new Color(theme.bg);
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 500);
  camera.up.set(0, 0, 1); // o mapa usa z para cima; tem de valer antes de criar os controles
  camera.position.set(8, -8, 8);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = 0.75;
  controls.zoomSpeed = 0.9;
  controls.screenSpacePanning = false; // mover desliza sobre o piso, como num mapa
  controls.maxPolarAngle = POLAR_MAX;
  controls.minPolarAngle = 0.02;
  controls.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
  const raycaster = new Raycaster();
  const world = new Group(); // tudo que é do modelo
  scene.add(world);

  // uniformes divididos por todos os materiais do mesmo tipo
  const shared = {
    uRelief: { value: 0 },
    uTime: { value: 0 },
    uNeutral: { value: vec3Of(theme.neutral) },
    uHatch: { value: vec3Of(theme.hatch) },
    uSlab: { value: vec3Of(theme.slab) },
    uRingColor: { value: vec3Of(theme.router) },
    uGlass: { value: vec3Of(theme.glass) },
    uEdge: { value: vec3Of(theme.edge) },
    uInner: { value: vec3Of(theme.inner) },
    uNeighbour: { value: vec3Of(theme.neighbour) },
    uC0: { value: vec3Of(theme.path[0]) },
    uC1: { value: vec3Of(theme.path[1]) },
    uC2: { value: vec3Of(theme.path[2]) },
    uCasing: { value: vec3Of(theme.pathCasing) },
    uRings: { value: 1 },
    uWidenWall: { value: 1 },
    uWidenPath: { value: 1 },
  };

  // textura de 1 pixel para quando ainda não há sombra/máscara
  const blankTex = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  blankTex.needsUpdate = true;

  // --- chão: grade de 1 m, clarão e sombra ---
  const groundMat = new ShaderMaterial({
    vertexShader: GROUND_VERT,
    fragmentShader: GROUND_FRAG,
    uniforms: {
      uBg: { value: vec3Of(theme.bg) },
      uGround: { value: vec3Of(theme.ground) },
      uLine: { value: vec3Of(theme.grid) },
      uAlpha: { value: theme.gridAlpha },
      uRadius: { value: 30 },
      uCenter: { value: new Vector2() },
      uShadow: { value: blankTex },
      uShadowRect: { value: new Vector4(0, 0, 1, 1) },
      uShadowAmt: { value: 0 },
    },
  });
  const ground = new Mesh(new PlaneGeometry(1, 1), groundMat);
  ground.renderOrder = -10;
  ground.frustumCulled = false;
  scene.add(ground);
  let shadowTex = null;

  // --- peças que não dependem do modelo: geometrias e materiais dos marcadores ---
  const kit = buildKit();

  function buildKit() {
    const unitBeam = new CylinderGeometry(0.026, 0.05, 1, 12, 1, true);
    unitBeam.rotateX(Math.PI / 2);
    unitBeam.translate(0, 0, 0.5); // do piso (z = 0) até z = 1
    const stem = new CylinderGeometry(0.012, 0.012, 0.52, 6, 1, true);
    stem.rotateX(Math.PI / 2);
    stem.translate(0, 0, 0.26);
    const head = new SphereGeometry(0.075, 14, 10);
    head.translate(0, 0, 0.56);
    const nStem = new CylinderGeometry(0.01, 0.01, 0.4, 5, 1, true);
    nStem.rotateX(Math.PI / 2);
    nStem.translate(0, 0, 0.2);
    const nHead = new OctahedronGeometry(0.085, 0);
    nHead.translate(0, 0, 0.46);
    const glowCanvas = doc.createElement('canvas');
    glowCanvas.width = 64;
    glowCanvas.height = 64;
    const g = glowCanvas.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const glowTex = new CanvasTexture(glowCanvas);
    glowTex.colorSpace = SRGBColorSpace;
    const flat = (hex, extra = {}) => new MeshBasicMaterial({ color: new Color(hex), ...extra });
    return {
      beam: unitBeam,
      orb: new SphereGeometry(0.1, 20, 14),
      pin: mergePositions([stem, head]),
      neighbour: mergePositions([nStem, nHead]),
      disc: new CircleGeometry(1, 40),
      ring: new RingGeometry(0.72, 1, 48),
      glowTex,
      mats: {
        router: flat(theme.router),
        routerCore: flat(theme.routerCore),
        routerBase: flat(theme.router, { transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
        glow: new SpriteMaterial({ map: glowTex, color: new Color(theme.router), transparent: true, depthWrite: false, opacity: 0.8, blending: theme.name === 'dark' ? AdditiveBlending : NormalBlending }),
        pin: flat(theme.pin),
        neighbour: flat(theme.neighbour),
        arrows: flat(theme.neighbour, { side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
        pathStart: flat(theme.path[0], { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
        pathEnd: flat(theme.path[2], { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
        walker: flat(theme.router, { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
        walkerCore: flat('#ffffff', { polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }),
        walkerHalo: flat(theme.router, { transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
        tap: flat(theme.text, { transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
      },
    };
  }

  function recolorKit() {
    const m = kit.mats;
    m.router.color.set(theme.router);
    m.routerCore.color.set(theme.routerCore);
    m.routerBase.color.set(theme.router);
    m.glow.color.set(theme.router);
    m.glow.blending = theme.name === 'dark' ? AdditiveBlending : NormalBlending;
    m.glow.opacity = theme.name === 'dark' ? 0.8 : 0.35;
    m.pin.color.set(theme.pin);
    m.neighbour.color.set(theme.neighbour);
    m.arrows.color.set(theme.neighbour);
    m.pathStart.color.set(theme.path[0]);
    m.pathEnd.color.set(theme.path[2]);
    m.walker.color.set(theme.router);
    m.walkerHalo.color.set(theme.router);
    m.tap.color.set(theme.text);
  }
  recolorKit();

  // marcador "você está aqui" e a onda do toque: existem sempre, aparecem quando preciso
  const walkerGroup = new Group();
  walkerGroup.visible = false;
  const walkerHalo = new Mesh(kit.ring, kit.mats.walkerHalo);
  const walkerDisc = new Mesh(kit.disc, kit.mats.walker);
  const walkerCore = new Mesh(kit.disc, kit.mats.walkerCore);
  const walkerBeam = new Mesh(kit.beam, kit.mats.walker);
  const walkerOrb = new Mesh(kit.orb, kit.mats.walkerCore);
  walkerGroup.add(walkerHalo, walkerDisc, walkerCore, walkerBeam, walkerOrb);
  world.add(walkerGroup);
  const tapRing = new Mesh(kit.ring, kit.mats.tap);
  tapRing.visible = false;
  tapRing.renderOrder = 20;
  world.add(tapRing);

  // --- recursos por parte do modelo (para liberar tudo ao trocar) ---
  function makeBin() {
    const items = [];
    return {
      add(obj) {
        items.push(obj);
        return obj;
      },
      dispose() {
        for (const it of items) {
          if (it.isObject3D) it.removeFromParent();
          else it.dispose?.();
        }
        items.length = 0;
      },
    };
  }
  const bins = { floors: makeBin(), markers: makeBin(), shadow: makeBin() };

  // --- rótulos: uma textura por texto, guardada entre atualizações do modelo ---
  const labelCache = new Map();
  const measureCtx = doc.createElement('canvas').getContext('2d');

  function labelEntry(spec) {
    const key = `${theme.name}|${spec.kind}|${spec.auto ? 1 : 0}${spec.iconOnly ? 1 : 0}|${spec.text}|${spec.detail || ''}`;
    let entry = labelCache.get(key);
    if (!entry) {
      const lay = layoutLabel(measureCtx, spec, theme);
      const scale = 2; // textura no dobro: nítida em telas densas, e a 1x o filtro suaviza
      const pad = 3; // folga para o contorno do texto não ser cortado
      const cv = doc.createElement('canvas');
      cv.width = Math.ceil((lay.w + pad * 2) * scale);
      cv.height = Math.ceil((lay.h + pad * 2) * scale);
      const g = cv.getContext('2d');
      g.scale(scale, scale);
      paintLabel(g, lay, pad, pad);
      const tex = new CanvasTexture(cv);
      tex.colorSpace = SRGBColorSpace;
      tex.minFilter = LinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = false;
      entry = { key, tex, w: lay.w + pad * 2, h: lay.h + pad * 2, pad, used: true };
      labelCache.set(key, entry);
    }
    entry.used = true;
    return entry;
  }

  function sweepLabelCache() {
    for (const [key, entry] of labelCache) {
      if (entry.used) continue;
      entry.tex.dispose();
      labelCache.delete(key);
    }
  }

  function addLabel(bin, group, floorIndex, spec, pos, o = {}) {
    const entry = labelEntry(spec);
    const mat = bin.add(new SpriteMaterial({ map: entry.tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, opacity: 0 }));
    const sprite = bin.add(new Sprite(mat));
    sprite.center.set(o.ax ?? 0.5, o.ay ?? 0.5);
    sprite.position.set(pos[0], pos[1], pos[2]);
    sprite.renderOrder = 30;
    sprite.visible = false;
    group.add(sprite);
    const label = { sprite, mat, w: entry.w, h: entry.h, ax: o.ax ?? 0.5, ay: o.ay ?? 0.5, priority: o.priority ?? 0, layer: o.layer || spec.kind, floorIndex, pick: o.pick || null, shown: 0, target: 0, box: null };
    labels.push(label);
    anchors.push({ obj: sprite, floorIndex, x: pos[0], y: pos[1], z0: pos[2] });
    return label;
  }

  // -------------------------------------------------------------------------
  // Construção da cena a partir do modelo
  // -------------------------------------------------------------------------

  function clearModel() {
    bins.floors.dispose();
    bins.markers.dispose();
    floorsState = [];
    labels = [];
    markers = [];
    anchors = [];
    apsPlaced = null;
  }

  function rebuildAll() {
    clearModel();
    for (const entry of labelCache.values()) entry.used = false;
    walkerGroup.removeFromParent();
    world.add(walkerGroup);
    if (!model || !model.floors.length) {
      extent = null;
      sweepLabelCache();
      updateGround();
      return;
    }
    extent = modelExtent(model);
    unit = clamp(extent.radius / 6, 0.8, 2.2);
    floorsState = model.floors.map((floor, i) => buildFloor(floor, i));
    computeHeights();
    paintFloors(true);
    buildMarkers();
    sweepLabelCache();
    updateGround();
    applyExplode();
    applyFocus(true);
    applyLayers();
    placeWalker(true);
  }

  function buildFloor(floor, i) {
    const bin = bins.floors;
    const { nx, ny, cell, bounds } = model;
    const group = bin.add(new Group());
    group.position.z = floor.z;
    world.add(group);
    const rings = prepareOutline(model, i);
    const inner = prepareInnerWalls(model, i);

    // máscara: o contorno suave desenhado numa textura; o shader corta o piso por ela
    const k = clamp(Math.floor(1024 / Math.max(nx, ny)), 2, 12);
    const maskCanvas = doc.createElement('canvas');
    maskCanvas.width = nx * k;
    maskCanvas.height = ny * k;
    const mg = maskCanvas.getContext('2d');
    mg.fillStyle = '#000';
    mg.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    mg.fillStyle = '#fff';
    mg.beginPath();
    for (const ring of rings) {
      ring.forEach((p, j) => {
        const u = ((p[0] - bounds.minX) / cell) * k;
        const v = ((p[1] - bounds.minY) / cell) * k;
        if (j === 0) mg.moveTo(u, v);
        else mg.lineTo(u, v);
      });
      mg.closePath();
    }
    mg.fill('evenodd');
    const mask = bin.add(new CanvasTexture(maskCanvas));
    mask.flipY = false;
    mask.colorSpace = NoColorSpace;
    mask.minFilter = LinearFilter;
    mask.magFilter = LinearFilter;
    mask.generateMipmaps = false;
    mask.wrapS = ClampToEdgeWrapping;
    mask.wrapT = ClampToEdgeWrapping;

    const makeColorTex = () => {
      const tex = bin.add(new DataTexture(new Uint8Array(nx * ny * 4), nx, ny, RGBAFormat, UnsignedByteType));
      tex.colorSpace = NoColorSpace;
      tex.minFilter = LinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      return tex;
    };
    const colA = makeColorTex();
    const colB = makeColorTex();

    // --- piso: malha na grade (com passo maior em grades grandes) + barranco do relevo + lateral da laje ---
    const step = Math.max(1, Math.ceil(Math.max(nx, ny) / 110));
    const gx = Math.ceil(nx / step);
    const gy = Math.ceil(ny / step);
    const need = new Uint8Array(gx * gy);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if (!floor.inside[iy * nx + ix]) continue;
        // a célula e as vizinhas: o contorno suavizado pode passar um pouco da área
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const qx = Math.floor((ix + dx) / step);
            const qy = Math.floor((iy + dy) / step);
            if (qx >= 0 && qy >= 0 && qx < gx && qy < gy) need[qy * gx + qx] = 1;
          }
        }
      }
    }
    const fb = meshBuilder({ position: 3, aH: 1, aG: 2, aKind: 1 });
    const vid = new Int32Array((gx + 1) * (gy + 1)).fill(-1);
    const vert = (qx, qy) => {
      const key = qy * (gx + 1) + qx;
      if (vid[key] < 0) vid[key] = fb.vertex({ position: [bounds.minX + qx * step * cell, bounds.minY + qy * step * cell, 0], aH: 0, aG: [0, 0], aKind: 0 });
      return vid[key];
    };
    for (let qy = 0; qy < gy; qy++) {
      for (let qx = 0; qx < gx; qx++) {
        if (!need[qy * gx + qx]) continue;
        fb.quad(vert(qx, qy), vert(qx + 1, qy), vert(qx + 1, qy + 1), vert(qx, qy + 1));
      }
    }
    const surfaceCount = fb.count;
    // contorno com pontos a cada célula (ou passo) para o barranco acompanhar o terreno
    const dense = rings.map((ring) => {
      const out = [];
      const maxSeg = Math.max(cell * step, 0.2);
      for (let j = 0; j < ring.length; j++) {
        const a = ring[j];
        const b = ring[(j + 1) % ring.length];
        const parts = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxSeg));
        for (let s = 0; s < parts; s++) out.push([a[0] + ((b[0] - a[0]) * s) / parts, a[1] + ((b[1] - a[1]) * s) / parts]);
      }
      return out;
    });
    const cliffTop = []; // vértices que recebem a altura do terreno
    for (const ring of dense) {
      let prev = null;
      let first = null;
      for (let j = 0; j <= ring.length; j++) {
        let cur;
        if (j === ring.length) cur = first;
        else {
          const p = ring[j];
          cur = {
            top: fb.vertex({ position: [p[0], p[1], 0], aH: 0, aG: [0, 0], aKind: 1 }),
            base: fb.vertex({ position: [p[0], p[1], 0], aH: 0, aG: [0, 0], aKind: 1 }),
            s0: fb.vertex({ position: [p[0], p[1], 0], aH: 0, aG: [0, 0], aKind: 2 }),
            s1: fb.vertex({ position: [p[0], p[1], -SLAB], aH: 0, aG: [0, 0], aKind: 2 }),
          };
          cliffTop.push(cur.top);
          if (!first) first = cur;
        }
        if (prev) {
          fb.quad(prev.base, cur.base, cur.top, prev.top);
          fb.quad(prev.s1, cur.s1, cur.s0, prev.s0);
        }
        prev = cur;
      }
    }
    const floorGeom = bin.add(fb.build());
    const floorMat = bin.add(
      new ShaderMaterial({
        vertexShader: FLOOR_VERT,
        fragmentShader: FLOOR_FRAG,
        side: DoubleSide,
        alphaToCoverage: msaa,
        uniforms: {
          uColA: { value: colA },
          uColB: { value: colB },
          uMask: { value: mask },
          uMix: { value: 1 },
          uFade: { value: 1 },
          uRelief: shared.uRelief,
          uTime: shared.uTime,
          uContour: { value: 0 },
          uRings: shared.uRings,
          uRingGap: { value: 0.85 * unit },
          uRingReach: { value: 3.4 * unit },
          uHatchFreq: { value: 2.4 / unit },
          uOrigin: { value: new Vector2(bounds.minX, bounds.minY) },
          uInvSize: { value: new Vector2(1 / (nx * cell), 1 / (ny * cell)) },
          uNeutral: shared.uNeutral,
          uHatch: shared.uHatch,
          uSlab: shared.uSlab,
          uRingColor: shared.uRingColor,
          uRouters: { value: [new Vector4(), new Vector4(), new Vector4(), new Vector4()] },
        },
      }),
    );
    const floorMesh = bin.add(new Mesh(floorGeom, floorMat));
    floorMesh.frustumCulled = false; // o relevo mexe os vértices no shader
    group.add(floorMesh);

    // --- paredes: contorno de vidro e divisões internas tracejadas ---
    const wallH = clamp(0.085 * extent.radius, 0.4, 0.8);
    const sheets = meshBuilder(WALL_ATTRS);
    const caps = meshBuilder(WALL_ATTRS);
    for (const ring of rings) {
      addWall(sheets, caps, ring, true, { height: wallH, capW: 0.065 * unit, capH: 0.035 * unit, sheet0: 0.07, sheet1: 0.32, capA: 1, tone: 0, capTone: 1, dash: 0 });
    }
    for (const w of inner) {
      const a = 0.25 + 0.6 * w.conf;
      addWall(sheets, caps, w.points, false, { height: wallH * 0.5, capW: 0.045 * unit, capH: 0.02 * unit, sheet0: 0.03 * a, sheet1: 0.2 * a, capA: a, tone: 0, capTone: 2, dash: 0.42 * unit });
    }
    const wallUniforms = (cut) => ({
      uRelief: shared.uRelief,
      uWiden: shared.uWidenWall,
      uGlass: shared.uGlass,
      uEdge: shared.uEdge,
      uInner: shared.uInner,
      uNeighbour: shared.uNeighbour,
      uFade: { value: 1 },
      uCut: { value: cut },
    });
    const sheetGeom = bin.add(sheets.build());
    const sheetMat = bin.add(new ShaderMaterial({ vertexShader: WALL_VERT, fragmentShader: WALL_FRAG, uniforms: wallUniforms(0), transparent: true, depthWrite: false, side: DoubleSide }));
    const sheetMesh = bin.add(new Mesh(sheetGeom, sheetMat));
    sheetMesh.renderOrder = 4;
    sheetMesh.frustumCulled = false;
    const capGeom = bin.add(caps.build());
    const capMat = bin.add(new ShaderMaterial({ vertexShader: WALL_VERT, fragmentShader: WALL_FRAG, uniforms: wallUniforms(1), transparent: true, depthWrite: true, side: DoubleSide }));
    const capMesh = bin.add(new Mesh(capGeom, capMat));
    capMesh.renderOrder = 2;
    capMesh.frustumCulled = false;
    group.add(sheetMesh, capMesh);

    const markerGroup = bin.add(new Group());
    group.add(markerGroup);

    return {
      floor,
      index: i,
      group,
      markerGroup,
      rings,
      mask,
      colA,
      colB,
      floorGeom,
      floorMat,
      floorMesh,
      surfaceCount,
      cliffTop,
      step,
      gx,
      gy,
      vid,
      sheetGeom,
      sheetMat,
      sheetMesh,
      capGeom,
      capMat,
      capMesh,
      pathMesh: null,
      pathMat: null,
      pathGeom: null,
      heights: null,
      fade: 1,
      wallH,
      painted: false,
    };
  }

  // --- relevo: altura por célula (0..1), espalhada para fora da área e suavizada ---
  function computeHeights() {
    if (!model) return;
    const { nx, ny } = model;
    for (const fs of floorsState) {
      const field = heat ? heat[fs.index] : null;
      if (!field) {
        fs.heights = null;
        continue;
      }
      const n = nx * ny;
      let h = new Float32Array(n).fill(NaN);
      for (let c = 0; c < n; c++) if (fs.floor.inside[c] && !Number.isNaN(field.dbm[c])) h[c] = signalHeight01(field.dbm[c]);
      // espalha para fora (a malha passa um pouco do contorno) e alisa
      for (let pass = 0; pass < 4; pass++) {
        const next = h.slice();
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            const c = iy * nx + ix;
            if (!Number.isNaN(h[c])) continue;
            let sum = 0;
            let cnt = 0;
            if (ix > 0 && !Number.isNaN(h[c - 1])) (sum += h[c - 1]), cnt++;
            if (ix < nx - 1 && !Number.isNaN(h[c + 1])) (sum += h[c + 1]), cnt++;
            if (iy > 0 && !Number.isNaN(h[c - nx])) (sum += h[c - nx]), cnt++;
            if (iy < ny - 1 && !Number.isNaN(h[c + nx])) (sum += h[c + nx]), cnt++;
            if (cnt) next[c] = sum / cnt;
          }
        }
        h = next;
      }
      for (let c = 0; c < n; c++) if (Number.isNaN(h[c])) h[c] = 0;
      for (let pass = 0; pass < 2; pass++) {
        const next = new Float32Array(n);
        for (let iy = 0; iy < ny; iy++) {
          for (let ix = 0; ix < nx; ix++) {
            let sum = 0;
            let cnt = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const jy = iy + dy;
              if (jy < 0 || jy >= ny) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const jx = ix + dx;
                if (jx < 0 || jx >= nx) continue;
                sum += h[jy * nx + jx];
                cnt++;
              }
            }
            next[iy * nx + ix] = sum / cnt;
          }
        }
        h = next;
      }
      fs.heights = h;
    }
    for (const fs of floorsState) applyHeights(fs);
    updateAnchors();
  }

  // altura do terreno (0..1) num ponto, interpolando entre os centros das células
  function heightAt(fs, x, y) {
    const h = fs.heights;
    if (!h) return 0;
    const { nx, ny, cell, bounds } = model;
    const fx = clamp((x - bounds.minX) / cell - 0.5, 0, nx - 1);
    const fy = clamp((y - bounds.minY) / cell - 0.5, 0, ny - 1);
    const ix = Math.min(nx - 2, Math.floor(fx));
    const iy = Math.min(ny - 2, Math.floor(fy));
    if (ix < 0 || iy < 0) return h[0];
    const tx = fx - ix;
    const ty = fy - iy;
    const c = iy * nx + ix;
    return (h[c] * (1 - tx) + h[c + 1] * tx) * (1 - ty) + (h[c + nx] * (1 - tx) + h[c + nx + 1] * tx) * ty;
  }

  function fillHeights(fs, geom, from = 0, to = Infinity) {
    const pos = geom.attributes.position;
    const aH = geom.attributes.aH;
    const end = Math.min(to, pos.count);
    for (let v = from; v < end; v++) aH.array[v] = heightAt(fs, pos.array[v * 3], pos.array[v * 3 + 1]);
    aH.needsUpdate = true;
  }

  function applyHeights(fs) {
    const g = fs.floorGeom;
    const pos = g.attributes.position.array;
    const aH = g.attributes.aH;
    const aG = g.attributes.aG;
    const d = model.cell * fs.step;
    for (let v = 0; v < fs.surfaceCount; v++) {
      const x = pos[v * 3];
      const y = pos[v * 3 + 1];
      aH.array[v] = heightAt(fs, x, y);
      // inclinação da altura 0..1 por metro; o shader multiplica pela altura atual do relevo
      aG.array[v * 2] = (heightAt(fs, x + d, y) - heightAt(fs, x - d, y)) / (2 * d);
      aG.array[v * 2 + 1] = (heightAt(fs, x, y + d) - heightAt(fs, x, y - d)) / (2 * d);
    }
    for (const v of fs.cliffTop) aH.array[v] = heightAt(fs, pos[v * 3], pos[v * 3 + 1]);
    aH.needsUpdate = true;
    aG.needsUpdate = true;
    fillHeights(fs, fs.sheetGeom);
    fillHeights(fs, fs.capGeom);
    if (fs.pathGeom) fillHeights(fs, fs.pathGeom);
  }

  function updateAnchors() {
    const lift = reliefNow * RELIEF_MAX;
    for (const a of anchors) {
      const fs = floorsState[a.floorIndex];
      a.obj.position.z = a.z0 + (fs && lift > 0 ? heightAt(fs, a.x, a.y) * lift : 0);
    }
  }

  // --- cores do piso: a textura B é a atual; ao trocar, a anterior vai para A e as duas se fundem ---
  function paintFloors(instant) {
    if (!model) return;
    for (const fs of floorsState) {
      const field = heat ? heat[fs.index] : null;
      const a = fs.colA.image.data;
      const b = fs.colB.image.data;
      a.set(b);
      paintFloorCells(model, fs.index, { heat: field, theme, rooms: layers.rooms, out: new Uint8ClampedArray(b.buffer, b.byteOffset, b.length) });
      fs.colA.needsUpdate = true;
      fs.colB.needsUpdate = true;
      fs.floorMat.uniforms.uContour.value = field ? 1 : 0;
      const first = instant || !fs.painted;
      fs.painted = true;
      const u = fs.floorMat.uniforms.uMix;
      if (first) u.value = 1;
      else {
        u.value = 0;
        tween(`mix${fs.index}`, 260, (k) => {
          u.value = k;
        });
      }
    }
    invalidate();
  }

  // --- caminho, pontos, roteadores, rótulos ---
  function buildMarkers() {
    bins.markers.dispose();
    labels = [];
    markers = [];
    anchors = [];
    for (const entry of labelCache.values()) entry.used = false;
    const bin = bins.markers;
    for (const fs of floorsState) {
      fs.pathMesh = null;
      fs.pathGeom = null;
      fs.pathMat = null;
      fs.markerGroup.clear();
      for (const v of fs.floorMat.uniforms.uRouters.value) v.set(0, 0, 0, 0);
      fs.routerCount = 0;
    }
    if (!model) return;
    const expected = Number.isFinite(model.quality?.expectedErrorM) ? model.quality.expectedErrorM : 1.5;

    // caminho: uma fita por andar
    const runs = pathRuns(model, 5);
    const half = clamp(0.0085 * extent.radius, 0.04, 0.1);
    pathHalf = half;
    const lift = 0.035;
    for (const fs of floorsState) {
      const mine = runs.runs.filter((r) => r.floorIndex === fs.index);
      if (!mine.length) continue;
      const pb = meshBuilder(PATH_ATTRS);
      for (const run of mine) addRibbon(pb, run.points, half, lift);
      fs.pathGeom = bin.add(pb.build());
      fs.pathMat = bin.add(
        new ShaderMaterial({
          vertexShader: PATH_VERT,
          fragmentShader: PATH_FRAG,
          transparent: true,
          depthWrite: false,
          side: DoubleSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          uniforms: { uRelief: shared.uRelief, uWiden: shared.uWidenPath, uC0: shared.uC0, uC1: shared.uC1, uC2: shared.uC2, uCasing: shared.uCasing, uFade: { value: fs.fade } },
        }),
      );
      fs.pathMesh = bin.add(new Mesh(fs.pathGeom, fs.pathMat));
      fs.pathMesh.renderOrder = 6;
      fs.pathMesh.frustumCulled = false;
      fs.group.add(fs.pathMesh);
      fillHeights(fs, fs.pathGeom);
    }
    // começo (anel) e fim (disco) do caminho
    const allRuns = runs.runs;
    if (allRuns.length) {
      const first = allRuns[0];
      const last = allRuns[allRuns.length - 1];
      const s = first.points[0];
      const e = last.points[last.points.length - 1];
      const startMesh = bin.add(new Mesh(kit.ring, kit.mats.pathStart));
      startMesh.scale.setScalar(half * 2.6);
      startMesh.position.set(s.x, s.y, lift + 0.01);
      startMesh.userData.layer = 'path';
      floorsState[first.floorIndex].markerGroup.add(startMesh);
      anchors.push({ obj: startMesh, floorIndex: first.floorIndex, x: s.x, y: s.y, z0: lift + 0.01 });
      const endMesh = bin.add(new Mesh(kit.disc, kit.mats.pathEnd));
      endMesh.scale.setScalar(half * 2.1);
      endMesh.position.set(e.x, e.y, lift + 0.012);
      endMesh.userData.layer = 'path';
      floorsState[last.floorIndex].markerGroup.add(endMesh);
      anchors.push({ obj: endMesh, floorIndex: last.floorIndex, x: e.x, y: e.y, z0: lift + 0.012 });
    }

    // ambientes
    for (const fs of floorsState) {
      for (const room of fs.floor.rooms || []) {
        if (!Number.isFinite(room.cx) || !Number.isFinite(room.cy)) continue;
        addLabel(bin, fs.markerGroup, fs.index, { kind: 'room', text: room.label, auto: !!room.auto }, [room.cx, room.cy, 0.12], {
          priority: (room.auto ? 30 : 50) + clamp((room.areaM2 || 0) / 10, 0, 9),
          layer: 'room',
          pick: { kind: 'room', data: room, floorIndex: fs.index },
        });
      }
    }

    // pontos marcados: alfinete + nome (o ponto que deu nome ao ambiente não repete o nome)
    for (const sp of model.spots || []) {
      if (!Number.isFinite(sp.x) || !Number.isFinite(sp.y)) continue;
      const fi = floorIndexOf(model, sp.floor);
      const fs = floorsState[fi >= 0 ? fi : nearestFloorIndex(model, sp.z ?? 0)];
      if (!fs) continue;
      const pin = bin.add(new Mesh(kit.pin, kit.mats.pin));
      pin.scale.setScalar(unit);
      pin.position.set(sp.x, sp.y, 0);
      pin.userData.layer = 'spots';
      fs.markerGroup.add(pin);
      anchors.push({ obj: pin, floorIndex: fs.index, x: sp.x, y: sp.y, z0: 0 });
      const pick = { kind: 'spot', data: sp, floorIndex: fs.index };
      markers.push({ layer: 'spots', floorIndex: fs.index, x: sp.x, y: sp.y, z: 0.56 * unit, radius: 22, pick });
      if (!namesRoom(fs.floor, sp.label)) addLabel(bin, fs.markerGroup, fs.index, { kind: 'spot', text: sp.label }, [sp.x, sp.y, 0.68 * unit], { ay: 0, priority: 20, layer: 'spots', pick });
    }

    // roteadores
    apsPlaced = placeAps(model, extent);
    const seenNames = new Set();
    const arrows = meshBuilder({ position: 3 });
    for (const item of apsPlaced.items) {
      const fs = floorsState[item.floorIndex];
      if (!fs) continue;
      const ap = item.ap;
      const pick = { kind: 'router', data: ap, floorIndex: fs.index };
      if (ap.own) {
        const h = clamp(Number.isFinite(ap.z) ? ap.z - fs.floor.z : 1.2, 0.7, 2.3) * Math.sqrt(unit);
        const g = bin.add(new Group());
        g.position.set(item.x, item.y, 0);
        g.userData.layer = 'routers';
        const base = bin.add(new Mesh(kit.disc, kit.mats.routerBase));
        base.scale.setScalar(0.17 * unit);
        base.position.z = 0.02;
        const beam = bin.add(new Mesh(kit.beam, kit.mats.router));
        beam.scale.set(unit, unit, h);
        const orb = bin.add(new Mesh(kit.orb, kit.mats.routerCore));
        orb.scale.setScalar(unit);
        orb.position.z = h;
        const glow = bin.add(new Sprite(kit.mats.glow));
        glow.scale.setScalar(0.95 * unit);
        glow.position.z = h;
        glow.renderOrder = 8;
        g.add(base, beam, orb, glow);
        fs.markerGroup.add(g);
        anchors.push({ obj: g, floorIndex: fs.index, x: item.x, y: item.y, z0: 0 });
        markers.push({ layer: 'routers', floorIndex: fs.index, x: item.x, y: item.y, z: h, radius: 26, pick });
        const spec = routerLabel(item, seenNames);
        addLabel(bin, fs.markerGroup, fs.index, spec, [item.x, item.y, h + 0.22 * unit], { ay: 0, priority: item.repeat ? 58 : 60, layer: 'routers', pick });
        if (!item.clamped && fs.routerCount < 4) {
          const conf = Number.isFinite(ap.conf) ? clamp(ap.conf, 0, 1) : 0.5;
          // posição pouco confiável: um círculo tracejado mostra até onde o roteador pode estar
          const doubt = conf < 0.7 ? expected * (0.6 + 1.6 * (1 - conf)) : 0;
          fs.floorMat.uniforms.uRouters.value[fs.routerCount++].set(item.x, item.y, doubt, 0.55 + 0.45 * conf);
        }
      } else {
        const zTip = item.clamped ? 0.1 : 0.46 * unit;
        if (item.clamped) {
          // seta deitada no chão, apontando para fora, na direção do vizinho
          const c = Math.cos(item.angle);
          const s = Math.sin(item.angle);
          const L = 0.34 * unit;
          const W = 0.2 * unit;
          const z = 0.03;
          const tip = arrows.vertex({ position: [item.x + c * L, item.y + s * L, z] });
          const l = arrows.vertex({ position: [item.x - c * L * 0.5 - s * W, item.y - s * L * 0.5 + c * W, z] });
          const m = arrows.vertex({ position: [item.x - c * L * 0.2, item.y - s * L * 0.2, z] });
          const r = arrows.vertex({ position: [item.x - c * L * 0.5 + s * W, item.y - s * L * 0.5 - c * W, z] });
          arrows.tri(tip, l, m);
          arrows.tri(tip, m, r);
        } else {
          const mk = bin.add(new Mesh(kit.neighbour, kit.mats.neighbour));
          mk.scale.setScalar(unit);
          mk.position.set(item.x, item.y, 0);
          mk.userData.layer = 'neighbours';
          fs.markerGroup.add(mk);
          anchors.push({ obj: mk, floorIndex: fs.index, x: item.x, y: item.y, z0: 0 });
        }
        markers.push({ layer: 'neighbours', floorIndex: fs.index, x: item.x, y: item.y, z: zTip, radius: 20, pick, clamped: item.clamped });
        const storey = item.storey > 0 ? ' ↑' : item.storey < 0 ? ' ↓' : '';
        addLabel(bin, fs.markerGroup, fs.index, { kind: 'neighbour', text: ap.ssid, detail: item.clamped ? `${approxMeters(item.distanceM)}${storey}` : storey.trim() }, [item.x, item.y, zTip + 0.12 * unit], {
          ay: 0,
          priority: 5 + clamp(((ap.bestRssi ?? -90) + 100) / 20, 0, 4),
          layer: 'neighbours',
          pick,
        });
      }
    }
    // setas dos vizinhos distantes e o anel onde elas ficam
    const lowest = floorsState[0];
    if (arrows.count) {
      const mesh = bin.add(new Mesh(bin.add(arrows.build()), kit.mats.arrows));
      mesh.userData.layer = 'neighbours';
      lowest.markerGroup.add(mesh);
    }
    const ringPts = [];
    for (let k = 0; k < 96; k++) ringPts.push([extent.cx + Math.cos((k / 96) * Math.PI * 2) * apsPlaced.ring, extent.cy + Math.sin((k / 96) * Math.PI * 2) * apsPlaced.ring]);
    const rb = meshBuilder(WALL_ATTRS);
    addWall(null, rb, ringPts, true, { height: 0.02, capW: 0.05 * unit, capH: 0, sheet0: 0, sheet1: 0, capA: 0.7, tone: 3, capTone: 3, dash: 0.5 * unit });
    const ringMat = bin.add(
      new ShaderMaterial({
        vertexShader: WALL_VERT,
        fragmentShader: WALL_FRAG,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: { uRelief: { value: 0 }, uWiden: shared.uWidenWall, uGlass: shared.uGlass, uEdge: shared.uEdge, uInner: shared.uInner, uNeighbour: shared.uNeighbour, uFade: { value: 1 }, uCut: { value: 1 } },
      }),
    );
    const ringMesh = bin.add(new Mesh(bin.add(rb.build()), ringMat));
    ringMesh.userData.layer = 'neighbours';
    ringMesh.position.z = -SLAB + 0.01;
    ringMesh.renderOrder = 1;
    lowest.markerGroup.add(ringMesh);
    updateAnchors();
  }

  // --- chão: tamanho, centro e sombra de contato ---
  function updateGround() {
    bins.shadow.dispose();
    shadowTex = null;
    const u = groundMat.uniforms;
    if (!model || !extent) {
      ground.visible = false;
      u.uShadow.value = blankTex;
      u.uShadowAmt.value = 0;
      return;
    }
    ground.visible = true;
    const r = Math.max(extent.radius * 5, 28);
    ground.scale.set(r * 2, r * 2, 1);
    ground.position.set(extent.cx, extent.cy, model.floors[0].z - SLAB - 0.02);
    u.uRadius.value = r * 0.92;
    u.uCenter.value.set(extent.cx, extent.cy);
    // sombra: o contorno do andar de baixo, borrado
    const fs = floorsState[0];
    if (!fs) return;
    const pad = Math.max(1.2, extent.radius * 0.25);
    const x0 = extent.minX - pad;
    const y0 = extent.minY - pad;
    const w = extent.w + pad * 2;
    const h = extent.h + pad * 2;
    const size = 160;
    const cv = doc.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const g = cv.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    g.filter = `blur(${Math.max(2, Math.round((0.45 * unit * size) / Math.max(w, h)))}px)`;
    g.fillStyle = '#fff';
    g.beginPath();
    for (const ring of fs.rings) {
      ring.forEach((p, j) => {
        const px = ((p[0] - x0) / w) * size;
        const py = ((p[1] - y0) / h) * size;
        if (j === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.closePath();
    }
    g.fill('evenodd');
    shadowTex = bins.shadow.add(new CanvasTexture(cv));
    shadowTex.flipY = false;
    shadowTex.colorSpace = NoColorSpace;
    shadowTex.minFilter = LinearFilter;
    shadowTex.magFilter = LinearFilter;
    shadowTex.generateMipmaps = false;
    u.uShadow.value = shadowTex;
    u.uShadowRect.value.set(x0, y0, 1 / w, 1 / h);
    u.uShadowAmt.value = theme.name === 'dark' ? 0.55 : 0.16;
  }

  // -------------------------------------------------------------------------
  // Camadas, foco, afastamento, relevo
  // -------------------------------------------------------------------------

  function applyLayers() {
    for (const fs of floorsState) {
      const on = fs.fade > 0.5;
      fs.sheetMesh.visible = layers.walls;
      fs.capMesh.visible = layers.walls;
      if (fs.pathMesh) fs.pathMesh.visible = layers.path;
      fs.markerGroup.visible = on;
      for (const child of fs.markerGroup.children) {
        const layer = child.userData.layer;
        if (layer) child.visible = !!layers[layer];
      }
    }
    shared.uRings.value = layers.routers ? 1 : 0;
    groundMat.uniforms.uAlpha.value = layers.grid ? theme.gridAlpha : 0;
    const wantRelief = layers.relief && heat ? 1 : 0;
    if (wantRelief !== reliefTarget) {
      reliefTarget = wantRelief;
      const from = reliefNow;
      tween('relief', 520, (k) => {
        reliefNow = from + (reliefTarget - from) * k;
        shared.uRelief.value = reliefNow * RELIEF_MAX;
        updateAnchors();
      });
    }
    labelsDirty = true;
    invalidate();
  }
  let reliefTarget = 0;

  function explodeGap() {
    return extent ? clamp(extent.radius * 0.95, 3, 14) : 0;
  }

  function applyExplode() {
    const gap = explodeGap() * explodeNow;
    floorsState.forEach((fs, i) => {
      fs.group.position.z = fs.floor.z + gap * i;
    });
    placeWalker(true);
    labelsDirty = true;
  }

  function applyFocus(instant) {
    const fi = model ? floorIndexOf(model, focus) : -1;
    floorsState.forEach((fs, i) => {
      const to = fi < 0 || fi === i ? 1 : 0;
      const from = fs.fade;
      const set = (k) => {
        fs.fade = from + (to - from) * k;
        setFloorFade(fs);
      };
      if (instant || from === to) set(1);
      else tween(`fade${i}`, 280, set);
    });
  }

  function setFloorFade(fs) {
    const f = fs.fade;
    fs.floorMat.uniforms.uFade.value = f;
    fs.floorMat.transparent = f < 0.999;
    fs.floorMesh.visible = f > 0.01;
    fs.sheetMat.uniforms.uFade.value = f;
    fs.capMat.uniforms.uFade.value = Math.max(f, GHOST);
    if (fs.pathMat) fs.pathMat.uniforms.uFade.value = f;
    fs.markerGroup.visible = f > 0.5;
    labelsDirty = true;
    invalidate();
  }

  // -------------------------------------------------------------------------
  // Câmera
  // -------------------------------------------------------------------------

  const tmpV = new Vector3();
  const tmpV2 = new Vector3();

  function readCamera() {
    const t = controls.target;
    const dx = camera.position.x - t.x;
    const dy = camera.position.y - t.y;
    const dz = camera.position.z - t.z;
    const dist = Math.hypot(dx, dy, dz) || 1;
    return { tx: t.x, ty: t.y, tz: t.z, dist, polar: Math.acos(clamp(dz / dist, -1, 1)), azim: Math.atan2(dy, dx) };
  }

  function placeCamera(c) {
    const polar = Math.max(POLAR_TOP, c.polar);
    const sp = Math.sin(polar);
    controls.target.set(c.tx, c.ty, c.tz);
    camera.position.set(c.tx + c.dist * sp * Math.cos(c.azim), c.ty + c.dist * sp * Math.sin(c.azim), c.tz + c.dist * Math.cos(polar));
    camera.near = Math.max(0.05, c.dist * 0.03);
    camera.far = c.dist * 12 + 200;
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
  }

  function availableRect() {
    const w = Math.max(40, width - padding.left - padding.right);
    const h = Math.max(40, height - padding.top - padding.bottom);
    return { w, h };
  }

  function applyViewOffset() {
    if (!width || !height) return;
    const ox = (padding.left - padding.right) / 2;
    const oy = (padding.bottom - padding.top) / 2;
    if (ox || oy) camera.setViewOffset(width, height, -ox, oy, width, height);
    else camera.clearViewOffset();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  // Vista padrão do modo atual: alvo, ângulos e a distância em que tudo cabe na área livre da tela.
  function defaultCamera(mode = viewMode) {
    if (!extent || !model) return null;
    const avail = availableRect();
    const portrait = avail.h >= avail.w;
    const longX = extent.w >= extent.h;
    // de cima, o lado comprido do mapa acompanha o lado comprido da tela (o mapa não tem norte)
    const azimTop = portrait === longX ? Math.PI : -Math.PI / 2;
    const fi = floorIndexOf(model, focus);
    const shown = fi >= 0 ? [floorsState[fi]] : floorsState;
    const zLow = shown[0].group.position.z;
    const zHigh = shown[shown.length - 1].group.position.z;
    const stacked = zHigh - zLow > 0.5;
    // em pé sobra altura na tela: dá para olhar mais de cima, e os nomes se atropelam menos
    const tilt = portrait ? 0.84 : 0.98;
    const polar = mode === 'top' ? POLAR_TOP : stacked ? tilt + 0.14 : tilt;
    const azim = mode === 'top' ? azimTop : azimTop + 0.62;
    const lift = layers.relief && heat ? RELIEF_MAX : 0;
    const target = { x: extent.cx, y: extent.cy, z: mode === 'top' ? zHigh : (zLow + zHigh) / 2 + 0.3 };

    // o que precisa caber: o contorno de cada andar (embaixo e em cima da parede) e os roteadores da casa
    const pts = [];
    for (const fs of shown) {
      const z = fs.group.position.z;
      for (const ring of fs.rings) {
        const stepN = Math.max(1, Math.floor(ring.length / 48));
        for (let j = 0; j < ring.length; j += stepN) pts.push([ring[j][0], ring[j][1], z - SLAB], [ring[j][0], ring[j][1], z + fs.wallH + lift]);
      }
    }
    for (const m of markers) {
      if (m.layer !== 'routers') continue;
      const fs = floorsState[m.floorIndex];
      if (shown.includes(fs)) pts.push([m.x, m.y, fs.group.position.z + m.z + lift + 0.35 * unit]);
    }
    if (layers.neighbours && apsPlaced && fi < 0) {
      // o anel dos vizinhos distantes também tem de aparecer
      for (let k = 0; k < 24; k++) pts.push([extent.cx + Math.cos((k / 24) * Math.PI * 2) * apsPlaced.ring, extent.cy + Math.sin((k / 24) * Math.PI * 2) * apsPlaced.ring, zLow]);
    }
    if (!pts.length) pts.push([extent.minX, extent.minY, zLow], [extent.maxX, extent.maxY, zHigh]);

    // base da câmera para estes ângulos
    const sp = Math.sin(polar);
    const zc = tmpV.set(sp * Math.cos(azim), sp * Math.sin(azim), Math.cos(polar));
    const xc = new Vector3(-Math.sin(azim), Math.cos(azim), 0);
    const yc = tmpV2.crossVectors(zc, xc);
    const tanY = Math.tan((FOV * Math.PI) / 360);
    const tanX = tanY * (width / height);
    // margem fixa em px: rótulos em cima, barra de escala embaixo
    const mX = Math.max(0.2, (avail.w - 36) / width);
    const mY = Math.max(0.2, (avail.h - 96) / height);
    let dist = 1;
    for (const p of pts) {
      const rx = p[0] - target.x;
      const ry = p[1] - target.y;
      const rz = p[2] - target.z;
      const along = rx * zc.x + ry * zc.y + rz * zc.z;
      const sx = Math.abs(rx * xc.x + ry * xc.y + rz * xc.z);
      const sy = Math.abs(rx * yc.x + ry * yc.y + rz * yc.z);
      dist = Math.max(dist, sx / (mX * tanX) + along, sy / (mY * tanY) + along);
    }
    return { tx: target.x, ty: target.y, tz: target.z, dist, polar, azim };
  }

  let fitDist = 20;

  function applyLimits() {
    const top = viewMode === 'top';
    controls.minPolarAngle = top ? 0 : 0.02;
    controls.maxPolarAngle = top ? 0 : POLAR_MAX;
    controls.enableRotate = !top;
    // de cima o dedo arrasta o mapa; em órbita, gira
    controls.touches.ONE = top ? TOUCH.PAN : TOUCH.ROTATE;
    controls.mouseButtons.LEFT = top ? MOUSE.PAN : MOUSE.ROTATE;
    controls.minDistance = Math.max(1.2, fitDist * 0.12);
    controls.maxDistance = fitDist * 3;
  }

  function goTo(c, duration) {
    if (!c) return;
    const from = readCamera();
    // gira pelo caminho mais curto
    let da = c.azim - from.azim;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    controls.enabled = false;
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    tween(
      'camera',
      duration,
      (k) => {
        placeCamera({
          tx: from.tx + (c.tx - from.tx) * k,
          ty: from.ty + (c.ty - from.ty) * k,
          tz: from.tz + (c.tz - from.tz) * k,
          dist: from.dist + (c.dist - from.dist) * k,
          polar: from.polar + (c.polar - from.polar) * k,
          azim: from.azim + da * k,
        });
        labelsDirty = true;
      },
      () => {
        controls.enabled = true;
        applyLimits();
        controls.update();
        labelsDirty = true;
      },
    );
  }

  function fit(animated) {
    if (!width || !height) {
      needsFit = true;
      return;
    }
    const c = defaultCamera();
    if (!c) return;
    needsFit = false;
    fitDist = c.dist;
    goTo(c, animated ? 520 : 0);
  }

  // mantém o alvo perto do mapa: não dá para "perder" a casa arrastando
  function clampTarget() {
    if (!extent || !floorsState.length) return;
    const t = controls.target;
    const m = extent.radius * 0.6;
    const x = clamp(t.x, extent.minX - m, extent.maxX + m);
    const y = clamp(t.y, extent.minY - m, extent.maxY + m);
    const z = clamp(t.z, floorsState[0].group.position.z - 0.5, floorsState[floorsState.length - 1].group.position.z + 3);
    if (x !== t.x || y !== t.y || z !== t.z) {
      camera.position.x += x - t.x;
      camera.position.y += y - t.y;
      camera.position.z += z - t.z;
      t.set(x, y, z);
    }
  }

  // -------------------------------------------------------------------------
  // Animações e laço de desenho (só roda quando há o que mudar)
  // -------------------------------------------------------------------------

  const tweens = new Map();
  let raf = 0;
  let dirty = true;
  let labelsDirty = true;
  let lastFrame = 0;
  let lastRender = 0;
  let lastActivity = 0;
  let slowFrames = 0;
  let fastFrames = 0;
  let frameAvg = 16;
  let sharpTimer = 0;
  let ambientOk = options.ambient !== false;
  let pageVisible = !doc.hidden;

  function tween(key, duration, update, done) {
    if (reduced() || duration <= 0) {
      tweens.delete(key);
      update(1);
      done?.();
      invalidate();
      return;
    }
    tweens.set(key, { start: -1, duration, update, done });
    invalidate();
  }

  function invalidate() {
    dirty = true;
    schedule();
  }

  function wake() {
    lastActivity = win.performance.now();
    schedule();
  }

  function schedule() {
    if (raf || destroyed || contextLost || !pageVisible || !width || !height) return;
    raf = win.requestAnimationFrame(frame);
  }

  function hasAmbient() {
    if (!ambientOk || reduced() || !model) return false;
    if (walkerGroup.visible) return true;
    if (!layers.routers) return false;
    for (const fs of floorsState) if (fs.routerCount > 0 && fs.fade > 0.5) return true;
    return false;
  }

  function frame(now) {
    raf = 0;
    if (destroyed || contextLost) return;
    const dt = lastFrame ? Math.min(100, now - lastFrame) : 16;
    lastFrame = now;
    let active = false;

    for (const [key, tw] of tweens) {
      if (tw.start < 0) tw.start = now;
      const k = Math.min(1, (now - tw.start) / tw.duration);
      tw.update(easeInOut(k));
      dirty = true;
      if (k >= 1) {
        tweens.delete(key);
        tw.done?.();
      } else active = true;
    }

    cameraMoved = false;
    if (!tweens.has('camera') && controls.enabled) {
      if (controls.update()) {
        clampTarget();
        dirty = true;
        labelsDirty = true;
        active = true;
        cameraMoved = true;
      }
    }

    const ambient = hasAmbient() && now - lastActivity < AMBIENT_SLEEP_MS;
    if (ambient) {
      active = true;
      // a pulsação não precisa de mais que ~30 quadros por segundo
      if (now - lastRender >= 30) {
        shared.uTime.value += Math.min(0.1, (now - lastRender) / 1000);
        animateWalker(now);
        dirty = true;
      }
    }

    if (labelsDirty) {
      updateLabels();
      labelsDirty = false;
    }
    if (easeLabels(dt)) {
      dirty = true;
      active = true;
    }
    if (tapAnim(now)) {
      dirty = true;
      active = true;
    }

    if (dirty) {
      // "em movimento" = toque, inércia ou transição; a pulsação sozinha não conta
      const moving = tweens.size > 0 || controlsBusy || cameraMoved;
      if (moving) {
        adaptResolution(dt);
        lastMotion = now;
      } else {
        if (appliedRatio < baseRatio - 1e-3 && now - lastMotion > 140) applyRatio(baseRatio);
        // aparelho lento demais até para a pulsação: melhor desligar o enfeite que gastar bateria
        if (ambient && dt > 80 && ++ambientSlow > 12) ambientOk = false;
      }
      render(now);
    }
    if (active || dirty) schedule();
    else settle();
  }
  let controlsBusy = false;
  let cameraMoved = false;
  let lastMotion = 0;
  let ambientSlow = 0;

  // Resolução: cai um degrau quando os quadros demoram demais durante o movimento e volta ao parar.
  function adaptResolution(dt) {
    frameAvg += (dt - frameAvg) * 0.2;
    if (frameAvg > 34) {
      fastFrames = 0;
      if (++slowFrames >= 6 && motionScale > 0.5) {
        motionScale = Math.max(0.5, motionScale - 0.17);
        slowFrames = 0;
        frameAvg = 24;
      }
    } else if (frameAvg < 15) {
      slowFrames = 0;
      if (++fastFrames >= 45 && motionScale < 1) {
        motionScale = Math.min(1, motionScale + 0.17);
        fastFrames = 0;
      }
    }
    win.clearTimeout(sharpTimer);
    applyRatio(baseRatio * motionScale);
  }

  // parou: um último quadro na resolução cheia
  function settle() {
    if (appliedRatio >= baseRatio - 1e-3) return;
    win.clearTimeout(sharpTimer);
    sharpTimer = win.setTimeout(() => {
      if (destroyed || contextLost || tweens.size) return;
      applyRatio(baseRatio);
      render(win.performance.now());
    }, 140);
  }

  function applyRatio(ratio) {
    if (Math.abs(ratio - appliedRatio) < 1e-3 || !width || !height) return;
    appliedRatio = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
  }

  function render(now) {
    if (!width || !height || contextLost) return;
    dirty = false;
    lastRender = now;
    frames++;
    updateLineWidths();
    renderer.render(scene, camera);
    updateScaleBar();
  }

  let lastScale = null;
  let pathHalf = 0.05;
  function pxPerMeter() {
    return height / 2 / (Math.tan((FOV * Math.PI) / 360) * camera.position.distanceTo(controls.target));
  }

  function updateScaleBar() {
    if (!model || !extent) {
      lastScale = null;
      scaleBar.set(null);
      return;
    }
    lastScale = niceScale(pxPerMeter(), Math.min(110, width * 0.3));
    scaleBar.set(lastScale);
  }

  // largura mínima na tela para as arestas e o caminho (px de CSS, medidos na distância do alvo)
  function updateLineWidths() {
    const k = pxPerMeter();
    shared.uWidenWall.value = clamp(1.6 / (0.065 * unit * k), 1, 8);
    shared.uWidenPath.value = clamp(2.4 / (2 * pathHalf * k), 1, 8);
  }

  // -------------------------------------------------------------------------
  // Rótulos: tamanho fixo na tela, somem quando se sobrepõem ou ficam atrás de outro andar
  // -------------------------------------------------------------------------

  const proj = new Vector3();

  function projectLocal(group, x, y, z) {
    proj.set(x, y, z + (group ? group.position.z : 0)).project(camera);
    return { x: (proj.x * 0.5 + 0.5) * width, y: (-proj.y * 0.5 + 0.5) * height, behind: proj.z > 1 || proj.z < -1 };
  }

  function layerOn(layer) {
    if (!layers.labels) return false;
    if (layer === 'room') return layers.rooms || !!heat;
    return !!layers[layer];
  }

  // o ponto fica escondido atrás do piso de outro andar?
  function occluded(floorIndex, wx, wy, wz) {
    if (floorsState.length < 2) return false;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    for (const other of floorsState) {
      if (other.index === floorIndex || other.fade < 0.5) continue;
      const pz = other.group.position.z;
      if ((cz - pz) * (wz - pz) >= 0) continue; // câmera e ponto do mesmo lado desse piso
      const t = (pz - cz) / (wz - cz);
      const hit = floorPick(model, null, other.index, cx + (wx - cx) * t, cy + (wy - cy) * t);
      if (hit) return true;
    }
    return false;
  }

  function updateLabels() {
    if (!labels.length || !width || !height) return;
    camera.updateMatrixWorld(); // a câmera pode ter mudado depois do último quadro
    // tamanho fixo em px: a escala do sprite compensa a perspectiva
    const k = (2 * Math.tan((FOV * Math.PI) / 360)) / height;
    const boxes = [];
    for (const l of labels) {
      const fs = floorsState[l.floorIndex];
      l.sprite.scale.set(l.w * k, l.h * k, 1);
      let ok = layerOn(l.layer) && fs && fs.fade > 0.5;
      let box = { x: 0, y: 0, w: l.w, h: l.h, priority: l.priority, skip: true };
      if (ok) {
        const p = l.sprite.position;
        const s = projectLocal(fs.group, p.x, p.y, p.z);
        let x = s.x - l.w * l.ax;
        const y = s.y - l.h * (1 - l.ay);
        // encosta o rótulo na borda da tela em vez de cortá-lo, sem soltá-lo do seu ponto
        let shift = 0;
        if (x < 6) shift = 6 - x;
        else if (x + l.w > width - 6) shift = width - 6 - (x + l.w);
        shift = clamp(shift, -Math.max(0, l.w * (1 - l.ax) - 14), Math.max(0, l.w * l.ax - 14));
        x += shift;
        l.sprite.center.x = l.ax - shift / l.w;
        ok = !s.behind && x > -l.w * 0.25 && x + l.w < width + l.w * 0.25 && y > -l.h * 0.5 && y + l.h < height + l.h * 0.5 && !occluded(l.floorIndex, p.x, p.y, p.z + fs.group.position.z);
        box = { x, y, w: l.w, h: l.h, priority: l.priority, skip: !ok };
      }
      l.box = box;
      boxes.push(box);
    }
    const visible = declutter(boxes, 3);
    labels.forEach((l, i) => {
      l.target = visible[i] ? 1 : 0;
    });
  }

  function easeLabels(dt) {
    let moving = false;
    const stepK = reduced() ? 1 : Math.min(1, dt / 140);
    for (const l of labels) {
      if (l.shown !== l.target) {
        l.shown = l.target > l.shown ? Math.min(l.target, l.shown + stepK) : Math.max(l.target, l.shown - stepK);
        l.mat.opacity = l.shown;
        l.sprite.visible = l.shown > 0.01;
        if (l.shown !== l.target) moving = true;
        dirty = true;
      }
    }
    return moving;
  }

  // -------------------------------------------------------------------------
  // "Você está aqui" e a onda do toque
  // -------------------------------------------------------------------------

  let walkerFloor = -1;

  function placeWalker(instant) {
    if (!walker || !model || !floorsState.length) {
      walkerGroup.visible = false;
      return;
    }
    const fi = nearestFloorIndex(model, walker.z);
    const fs = floorsState[fi];
    const lift = reliefNow * RELIEF_MAX * heightAt(fs, walker.x, walker.y);
    const z = fs.group.position.z + 0.05 + lift;
    const s = unit;
    walkerHalo.scale.setScalar(0.42 * s);
    walkerDisc.scale.setScalar(0.24 * s);
    walkerCore.scale.setScalar(0.11 * s);
    walkerCore.position.z = 0.004;
    walkerDisc.position.z = 0.002;
    walkerBeam.scale.set(s * 0.6, s * 0.6, 1.05 * Math.sqrt(s));
    walkerOrb.scale.setScalar(s * 0.9);
    walkerOrb.position.z = 1.05 * Math.sqrt(s);
    const from = walkerGroup.position.clone();
    const jump = instant || !walkerGroup.visible || walkerFloor !== fi;
    walkerFloor = fi;
    walkerGroup.visible = fs.fade > 0.5;
    if (jump) {
      tweens.delete('walker');
      walkerGroup.position.set(walker.x, walker.y, z);
      invalidate();
    } else {
      tween('walker', 450, (k) => {
        walkerGroup.position.set(from.x + (walker.x - from.x) * k, from.y + (walker.y - from.y) * k, from.z + (z - from.z) * k);
      });
    }
  }

  function animateWalker(now) {
    if (!walkerGroup.visible) return;
    const k = (now % 1800) / 1800;
    walkerHalo.scale.setScalar(unit * (0.3 + 0.5 * k));
    kit.mats.walkerHalo.opacity = 0.45 * (1 - k);
  }

  let tapStart = -1;
  function showTap(point) {
    if (reduced() || !point) return;
    tapRing.position.copy(point);
    tapRing.visible = true;
    tapStart = -2;
    invalidate();
  }

  function tapAnim(now) {
    if (tapStart === -1) return false;
    if (tapStart === -2) tapStart = now;
    const k = (now - tapStart) / 380;
    if (k >= 1) {
      tapStart = -1;
      tapRing.visible = false;
      kit.mats.tap.opacity = 0;
      return false;
    }
    tapRing.scale.setScalar(unit * (0.12 + 0.3 * k));
    kit.mats.tap.opacity = 0.55 * (1 - k);
    return true;
  }

  // -------------------------------------------------------------------------
  // Toque
  // -------------------------------------------------------------------------

  const ndc = new Vector2();

  function pick(px, py, withPoint) {
    if (!model || !floorsState.length || !width || !height) return null;
    camera.updateMatrixWorld();
    // 1) rótulos visíveis
    let best = null;
    for (const l of labels) {
      if (!l.pick || l.shown < 0.5 || !l.box) continue;
      const b = l.box;
      if (px >= b.x - 4 && px <= b.x + b.w + 4 && py >= b.y - 4 && py <= b.y + b.h + 4) {
        if (!best || l.priority > best.priority) best = l;
      }
    }
    if (best) return fromPick(best.pick, withPoint);
    // 2) marcadores (roteadores e pontos), com folga para o dedo
    let near = null;
    let nearD = Infinity;
    for (const m of markers) {
      const fs = floorsState[m.floorIndex];
      if (!layers[m.layer] || !fs || fs.fade < 0.5) continue;
      const lift = reliefNow * RELIEF_MAX * heightAt(fs, m.x, m.y);
      for (const z of [m.z + lift, lift]) {
        const s = projectLocal(fs.group, m.x, m.y, z);
        if (s.behind) continue;
        const d = Math.hypot(s.x - px, s.y - py);
        if (d <= m.radius && d < nearD) {
          nearD = d;
          near = m;
        }
      }
    }
    if (near) return fromPick(near.pick, withPoint);
    // 3) piso: o raio do toque contra o plano de cada andar, do mais próximo da câmera para o mais distante
    ndc.set((px / width) * 2 - 1, -(py / height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    if (Math.abs(d.z) < 1e-6) return null;
    const hits = [];
    for (const fs of floorsState) {
      if (fs.fade < 0.5) continue;
      let z = fs.group.position.z;
      let t = (z - o.z) / d.z;
      // com relevo, o piso está mais alto: duas correções bastam para acertar a célula
      for (let it = 0; it < 3 && reliefNow > 0.01 && fs.heights; it++) {
        const h = heightAt(fs, o.x + d.x * t, o.y + d.y * t) * reliefNow * RELIEF_MAX;
        z = fs.group.position.z + h;
        t = (z - o.z) / d.z;
      }
      if (t <= 0) continue;
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      const hit = floorPick(model, heat, fs.index, x, y);
      if (hit && maskAt(fs, x, y)) hits.push({ t, hit, point: new Vector3(x, y, z + 0.03) });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.t - b.t);
    if (withPoint) withPoint.point = hits[0].point;
    return hits[0].hit;
  }

  // dentro do contorno suavizado? (a célula pode estar na área e o ponto, fora do contorno arredondado)
  function maskAt(fs, x, y) {
    let inside = false;
    for (const ring of fs.rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  function fromPick(p, withPoint) {
    const d = p.data;
    const fs = floorsState[p.floorIndex];
    const floor = fs.floor;
    let out;
    if (p.kind === 'room') out = { kind: 'room', x: d.cx, y: d.cy, floor: floor.floor, floorIndex: p.floorIndex, room: d, roomId: d.id, label: d.label, dbm: null };
    else if (p.kind === 'spot') out = { kind: 'spot', x: d.x, y: d.y, floor: d.floor, floorIndex: p.floorIndex, spot: d, id: d.id, label: d.label };
    else out = { kind: 'router', x: d.x, y: d.y, floor: d.floor ?? floor.floor, floorIndex: p.floorIndex, ap: d, id: d.id, label: d.ssid, own: !!d.own };
    if (withPoint) withPoint.point = null;
    return out;
  }

  const pointers = new Map();
  let tapCandidate = null;
  let lastTap = null;
  let tapTimer = 0;

  function localXY(ev) {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  function onPointerDown(ev) {
    wake();
    const [x, y] = localXY(ev);
    pointers.set(ev.pointerId, true);
    controlsBusy = true;
    tapCandidate = pointers.size === 1 && (ev.pointerType !== 'mouse' || ev.button === 0) ? { id: ev.pointerId, x, y, t: ev.timeStamp } : null;
  }

  function onPointerMove(ev) {
    if (!tapCandidate || tapCandidate.id !== ev.pointerId) return;
    const [x, y] = localXY(ev);
    if (Math.hypot(x - tapCandidate.x, y - tapCandidate.y) > 8) tapCandidate = null;
  }

  function onPointerUp(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size === 0) controlsBusy = false;
    wake();
    const cand = tapCandidate;
    tapCandidate = null;
    if (!cand || cand.id !== ev.pointerId || ev.type === 'pointercancel' || ev.timeStamp - cand.t > 450) return;
    const [x, y] = localXY(ev);
    // toque duplo: volta ao enquadramento (e o primeiro toque não vira seleção)
    if (lastTap && ev.timeStamp - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 32) {
      win.clearTimeout(tapTimer);
      lastTap = null;
      api.resetView();
      return;
    }
    lastTap = { t: ev.timeStamp, x, y };
    win.clearTimeout(tapTimer);
    tapTimer = win.setTimeout(() => {
      if (destroyed) return;
      const extra = {};
      const hit = pick(x, y, extra);
      if (!hit) return;
      showTap(extra.point);
      if (onPick) onPick(hit);
    }, TAP_DELAY_MS);
  }

  function onKeyDown(ev) {
    if (!model || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const c = readCamera();
    const top = viewMode === 'top';
    const stepA = 0.2;
    const stepP = c.dist * 0.12;
    const fwd = [-Math.cos(c.azim), -Math.sin(c.azim)];
    const right = [-Math.sin(c.azim), Math.cos(c.azim)];
    switch (ev.key) {
      case 'ArrowLeft':
        if (top) (c.tx -= right[0] * stepP), (c.ty -= right[1] * stepP);
        else c.azim -= stepA;
        break;
      case 'ArrowRight':
        if (top) (c.tx += right[0] * stepP), (c.ty += right[1] * stepP);
        else c.azim += stepA;
        break;
      case 'ArrowUp':
        if (top) (c.tx += fwd[0] * stepP), (c.ty += fwd[1] * stepP);
        else c.polar = clamp(c.polar - 0.12, 0.05, POLAR_MAX);
        break;
      case 'ArrowDown':
        if (top) (c.tx -= fwd[0] * stepP), (c.ty -= fwd[1] * stepP);
        else c.polar = clamp(c.polar + 0.12, 0.05, POLAR_MAX);
        break;
      case '+':
      case '=':
        c.dist = Math.max(controls.minDistance, c.dist * 0.82);
        break;
      case '-':
      case '_':
        c.dist = Math.min(controls.maxDistance, c.dist / 0.82);
        break;
      case '0':
      case 'Home':
        ev.preventDefault();
        api.resetView();
        return;
      default:
        return;
    }
    ev.preventDefault();
    userMoved = true;
    wake();
    goTo(c, 160);
  }

  const onControlsStart = () => {
    userMoved = true;
    tweens.delete('camera');
    wake();
  };
  const onControlsChange = () => {
    labelsDirty = true;
    invalidate();
  };
  controls.addEventListener('start', onControlsStart);
  controls.addEventListener('change', onControlsChange);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', wake, { passive: true });
  canvas.addEventListener('keydown', onKeyDown);

  // -------------------------------------------------------------------------
  // Tamanho, visibilidade, perda de contexto
  // -------------------------------------------------------------------------

  function resize() {
    if (destroyed) return;
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (!w || !h) {
      // escondido: nada a desenhar até voltar
      width = 0;
      height = 0;
      return;
    }
    const ratio = Math.min(win.devicePixelRatio || 1, maxPixelRatio);
    const changed = w !== width || h !== height || ratio !== baseRatio;
    const wasHidden = !width || !height;
    width = w;
    height = h;
    baseRatio = ratio;
    if (changed) {
      appliedRatio = 0;
      applyRatio(baseRatio * (tweens.size ? motionScale : 1));
      applyViewOffset();
      labelsDirty = true;
      if (needsFit || (!userMoved && model)) fit(false);
      else if (model) {
        const c = defaultCamera();
        if (c) {
          fitDist = c.dist;
          applyLimits();
        }
      }
    }
    if (changed || wasHidden) {
      dirty = true;
      // desenha já: quem redimensiona não pode ver um quadro esticado
      if (!contextLost) {
        if (labelsDirty) {
          updateLabels();
          labelsDirty = false;
          easeLabels(1000);
        }
        render(win.performance.now());
      }
      schedule();
    }
  }
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => resize()) : null;
  observer?.observe(root);

  const onVisibility = () => {
    pageVisible = !doc.hidden;
    if (pageVisible) {
      lastFrame = 0;
      invalidate();
    }
  };
  doc.addEventListener('visibilitychange', onVisibility);

  const onReduceChange = () => invalidate();
  reduceQuery?.addEventListener?.('change', onReduceChange);

  function onContextLost(ev) {
    ev.preventDefault(); // sem isto o navegador não devolve o contexto
    contextLost = true;
    win.cancelAnimationFrame(raf);
    raf = 0;
    message.textContent = 'Recuperando o mapa 3D…';
    message.hidden = false;
    win.clearTimeout(lostTimer);
    lostTimer = win.setTimeout(() => {
      if (!destroyed && contextLost && typeof options.onFatal === 'function') options.onFatal('context-lost');
    }, options.contextRestoreMs ?? 4000);
  }

  function onContextRestored() {
    win.clearTimeout(lostTimer);
    contextLost = false;
    message.hidden = true;
    // tudo o que estava na placa se foi: refaz as texturas e malhas do modelo
    for (const entry of labelCache.values()) entry.tex.dispose();
    labelCache.clear();
    rebuildAll();
    appliedRatio = 0;
    applyRatio(baseRatio);
    labelsDirty = true;
    invalidate();
  }
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  // -------------------------------------------------------------------------
  // Tema
  // -------------------------------------------------------------------------

  function applyTheme() {
    root.dataset.theme = theme.name;
    scene.background.set(theme.bg);
    setVec3(shared.uNeutral.value, theme.neutral);
    setVec3(shared.uHatch.value, theme.hatch);
    setVec3(shared.uSlab.value, theme.slab);
    setVec3(shared.uRingColor.value, theme.router);
    setVec3(shared.uGlass.value, theme.glass);
    setVec3(shared.uEdge.value, theme.edge);
    setVec3(shared.uInner.value, theme.inner);
    setVec3(shared.uNeighbour.value, theme.neighbour);
    setVec3(shared.uC0.value, theme.path[0]);
    setVec3(shared.uC1.value, theme.path[1]);
    setVec3(shared.uC2.value, theme.path[2]);
    setVec3(shared.uCasing.value, theme.pathCasing);
    const u = groundMat.uniforms;
    setVec3(u.uBg.value, theme.bg);
    setVec3(u.uGround.value, theme.ground);
    setVec3(u.uLine.value, theme.grid);
    u.uAlpha.value = layers.grid ? theme.gridAlpha : 0;
    u.uShadowAmt.value = shadowTex ? (theme.name === 'dark' ? 0.55 : 0.16) : 0;
    recolorKit();
  }

  // -------------------------------------------------------------------------
  // Interface pública
  // -------------------------------------------------------------------------

  const api = {
    kind: '3d',
    el: root,
    setModel(next, opts = {}) {
      const prev = model;
      const same = opts.keepView ?? isSameMap(prev, next);
      model = next || null;
      if (!model) heat = null;
      else if (heat && heat.length !== model.floors.length) heat = null;
      if (focus !== null && model && floorIndexOf(model, focus) < 0) focus = null;
      rebuildAll();
      wake();
      if (!model) {
        needsFit = true;
        invalidate();
        return;
      }
      if (!same || !prev) {
        userMoved = false;
        fit(false);
      } else if (!userMoved) {
        fit(true); // o levantamento cresceu: acompanha, a menos que o usuário já tenha mexido na vista
      } else {
        const c = defaultCamera();
        if (c) {
          fitDist = c.dist;
          applyLimits();
        }
      }
      labelsDirty = true;
      invalidate();
    },
    setHeat(fields) {
      const next = Array.isArray(fields) && model && fields.length === model.floors.length ? fields : null;
      if (next === heat) return;
      heat = next;
      computeHeights();
      paintFloors(false);
      applyLayers();
      wake();
    },
    setLayers(partial) {
      const before = layers;
      layers = { ...layers, ...(partial || {}) };
      if (before.rooms !== layers.rooms) paintFloors(false);
      applyLayers();
      wake();
      // o que muda o tamanho da cena (anel dos vizinhos, relevo) pede novo enquadramento
      if (model && !userMoved && (before.neighbours !== layers.neighbours || before.relief !== layers.relief)) fit(true);
    },
    getLayers: () => ({ ...layers }),
    setView(mode) {
      const next = mode === 'top' ? 'top' : 'orbit';
      if (next === viewMode) return;
      viewMode = next;
      userMoved = false;
      wake();
      if (!model || !width) {
        needsFit = true;
        applyLimits();
        return;
      }
      const c = defaultCamera();
      fitDist = c.dist;
      goTo(c, 650);
    },
    resetView() {
      userMoved = false;
      wake();
      if (model) fit(true);
    },
    setExplode(k) {
      const to = clamp(Number(k) || 0, 0, 1);
      if (to === explode) return;
      explode = to;
      const from = explodeNow;
      wake();
      tween(
        'explode',
        420,
        (t) => {
          explodeNow = from + (to - from) * t;
          applyExplode();
        },
        () => {
          if (!userMoved && model) fit(true);
        },
      );
    },
    setFocusFloor(floor) {
      const next = floor === null || floor === undefined ? null : Number(floor);
      if (next === focus) return;
      focus = next;
      applyFocus(false);
      wake();
      if (model && !userMoved) fit(true);
    },
    setWalker(pos) {
      walker = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: pos.x, y: pos.y, z: Number.isFinite(pos.z) ? pos.z : 0 } : null;
      placeWalker(false);
      wake();
      invalidate();
    },
    setTheme(name) {
      const next = mapTheme(name);
      if (next === theme) return;
      theme = next;
      applyTheme();
      if (model) {
        paintFloors(true);
        buildMarkers();
        sweepLabelCache();
        applyLayers();
        applyFocus(true);
      }
      labelsDirty = true;
      invalidate();
    },
    setPadding(p) {
      padding = { top: 0, right: 0, bottom: 0, left: 0, ...(p || {}) };
      applyViewOffset();
      if (model && !userMoved) fit(true);
      labelsDirty = true;
      invalidate();
    },
    setOnPick(fn) {
      onPick = typeof fn === 'function' ? fn : null;
    },
    worldToScreen(pos) {
      if (!model || !floorsState.length || !width) return null;
      camera.updateMatrixWorld();
      let z = Number.isFinite(pos.z) ? pos.z : 0;
      if (pos.floor !== undefined && pos.floor !== null) {
        const fi = floorIndexOf(model, pos.floor);
        if (fi < 0) return null;
        const fs = floorsState[fi];
        z = fs.group.position.z + reliefNow * RELIEF_MAX * heightAt(fs, pos.x, pos.y);
      }
      const s = projectLocal(null, pos.x, pos.y, z);
      return { x: s.x, y: s.y, visible: !s.behind && s.x >= 0 && s.y >= 0 && s.x <= width && s.y <= height };
    },
    pickAt(x, y) {
      flush();
      return pick(x, y, null);
    },
    snapshot() {
      if (contextLost) return Promise.reject(new Error('o mapa 3D não está disponível agora'));
      flush(true);
      // o desenho do WebGL só vale até o fim desta tarefa: copia já para um canvas comum
      const out = doc.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const g = out.getContext('2d');
      g.drawImage(canvas, 0, 0);
      const k = canvas.width / width;
      g.scale(k, k);
      paintScaleBar(g, lastScale, theme, 16 + padding.left, height - 18 - padding.bottom);
      return new Promise((resolve, reject) => out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('não foi possível gerar a imagem'))), 'image/png'));
    },
    resize,
    stats() {
      const info = renderer.info;
      return {
        kind: '3d',
        frames,
        width,
        height,
        pixelRatio: appliedRatio,
        motionScale,
        running: raf !== 0,
        contextLost,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs ? info.programs.length : 0,
        calls: info.render.calls,
        triangles: info.render.triangles,
        labels: labels.length,
        labelsShown: labels.filter((l) => l.target > 0).length,
        camera: readCamera(),
      };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win.cancelAnimationFrame(raf);
      win.clearTimeout(tapTimer);
      win.clearTimeout(lostTimer);
      win.clearTimeout(sharpTimer);
      observer?.disconnect();
      doc.removeEventListener('visibilitychange', onVisibility);
      reduceQuery?.removeEventListener?.('change', onReduceChange);
      controls.removeEventListener('start', onControlsStart);
      controls.removeEventListener('change', onControlsChange);
      controls.dispose();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', wake);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      tweens.clear();
      clearModel();
      bins.shadow.dispose();
      for (const entry of labelCache.values()) entry.tex.dispose();
      labelCache.clear();
      for (const key of ['beam', 'orb', 'pin', 'neighbour', 'disc', 'ring', 'glowTex']) kit[key].dispose();
      for (const m of Object.values(kit.mats)) m.dispose();
      ground.geometry.dispose();
      groundMat.dispose();
      blankTex.dispose();
      model = null;
      heat = null;
      renderer.dispose();
      // solta o contexto já: o WebView tem um limite pequeno de contextos WebGL vivos
      renderer.forceContextLoss?.();
      root.remove();
    },
  };

  // Aplica já o que estiver pendente (animações vão para o fim) e desenha um quadro.
  function flush(sharp) {
    if (!width || !height) resize();
    if (!width || !height || contextLost) return;
    const now = win.performance.now();
    for (const [key, tw] of tweens) {
      tw.update(1);
      tweens.delete(key);
      tw.done?.();
    }
    controls.update();
    if (sharp) applyRatio(baseRatio);
    updateLabels();
    labelsDirty = false;
    easeLabels(1000);
    render(now);
  }

  resize();
  applyLimits();
  return api;
}
