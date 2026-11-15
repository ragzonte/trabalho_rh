// Mapa em 2D (vista de cima, num canvas comum): é o que aparece quando o aparelho não
// tem WebGL2 ou quando o contexto 3D se perde de vez. Mesma interface do visualizador 3D
// (viewer3d.js); o que não faz sentido em 2D (relevo, afastar andares, girar) é aceito e ignorado.
//
//   const viewer = createViewer2d(container, { theme: 'dark', onPick });
//
// Este arquivo também guarda as contas que os dois visualizadores usam (sem DOM, salvo os
// rótulos, que precisam de um contexto de canvas para medir texto):
//   prepareOutline · prepareInnerWalls · modelExtent · cellAt · floorIndexOf · nearestFloorIndex
//   placeAps · pathRuns · declutter · niceScale · isSameMap · floorTag · cleanText
//   layoutLabel · paintLabel · DEFAULT_LAYERS
//
// Todo texto que vem de fora (nome de ambiente, de rede, de ponto) é desenhado com
// fillText: nunca vira HTML.

import { mapTheme, paintFloorCells, timeRgb, confWeight, hexToRgb, smoothInside } from './map-colors.js';

export const DEFAULT_LAYERS = Object.freeze({
  rooms: true,
  walls: true,
  path: true,
  spots: true,
  routers: true,
  neighbours: false,
  labels: true,
  relief: false,
  grid: true,
});

const NBSP_THIN = '\u202f';
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------

function pointLineDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1);
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

/** Douglas-Peucker numa linha aberta: tira os pontos que desviam menos que `eps`. */
export function simplifyOpen(points, eps) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = -1;
    let worstD = eps;
    for (let i = a + 1; i < b; i++) {
      const d = pointLineDist(points[i], points[a], points[b]);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Douglas-Peucker num anel fechado (sem repetir o primeiro ponto no fim). */
export function simplifyClosed(ring, eps) {
  const n = ring.length;
  if (n <= 4) return ring.slice();
  // âncoras: o ponto mais à esquerda e o mais longe dele
  let a = 0;
  for (let i = 1; i < n; i++) if (ring[i][0] < ring[a][0] || (ring[i][0] === ring[a][0] && ring[i][1] < ring[a][1])) a = i;
  let b = a;
  let far = -1;
  for (let i = 0; i < n; i++) {
    const d = (ring[i][0] - ring[a][0]) ** 2 + (ring[i][1] - ring[a][1]) ** 2;
    if (d > far) {
      far = d;
      b = i;
    }
  }
  const walk = (from, to) => {
    const out = [];
    for (let i = from; ; i = (i + 1) % n) {
      out.push(ring[i]);
      if (i === to) break;
    }
    return out;
  };
  const first = simplifyOpen(walk(a, b), eps);
  const second = simplifyOpen(walk(b, a), eps);
  const out = first.slice(0, -1).concat(second.slice(0, -1));
  return out.length >= 3 ? out : ring.slice();
}

/**
 * Arredonda as quinas: cada vértice vira um pequeno arco (curva quadrática) que começa e
 * termina a no máximo `radius` do vértice. Trechos retos compridos continuam retos.
 */
export function roundCorners(points, radius, closed, steps = 4) {
  const n = points.length;
  if (n < 3 || !(radius > 0)) return points.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = points[i];
    if (!closed && (i === 0 || i === n - 1)) {
      out.push(b);
      continue;
    }
    const a = points[(i + n - 1) % n];
    const c = points[(i + 1) % n];
    const la = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (la < 1e-6 || lc < 1e-6) continue;
    const ux = (a[0] - b[0]) / la;
    const uy = (a[1] - b[1]) / la;
    const vx = (c[0] - b[0]) / lc;
    const vy = (c[1] - b[1]) / lc;
    // quase em linha reta: não há quina para arredondar
    if (ux * vx + uy * vy < -0.985) {
      out.push(b);
      continue;
    }
    const d = Math.min(radius, la * 0.45, lc * 0.45);
    const p1 = [b[0] + ux * d, b[1] + uy * d];
    const p2 = [b[0] + vx * d, b[1] + vy * d];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const s = 1 - t;
      out.push([s * s * p1[0] + 2 * s * t * b[0] + t * t * p2[0], s * s * p1[1] + 2 * s * t * b[1] + t * t * p2[1]]);
    }
  }
  return out;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

// Contorno a partir da máscara (só quando o modelo não traz `outline`).
function traceMask(mask, nx, ny) {
  const at = (ix, iy) => (ix < 0 || iy < 0 || ix >= nx || iy >= ny ? 0 : mask[iy * nx + ix]);
  const key = (ix, iy) => iy * (nx + 1) + ix;
  const out = new Map();
  const add = (x0, y0, x1, y1) => {
    const k = key(x0, y0);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push([x0, y0, x1, y1, false]);
  };
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (!mask[iy * nx + ix]) continue;
      if (!at(ix, iy - 1)) add(ix, iy, ix + 1, iy);
      if (!at(ix + 1, iy)) add(ix + 1, iy, ix + 1, iy + 1);
      if (!at(ix, iy + 1)) add(ix + 1, iy + 1, ix, iy + 1);
      if (!at(ix - 1, iy)) add(ix, iy + 1, ix, iy);
    }
  }
  const rings = [];
  for (const list of out.values()) {
    for (const first of list) {
      if (first[4]) continue;
      const ring = [];
      let e = first;
      while (e && !e[4]) {
        e[4] = true;
        ring.push([e[0], e[1]]);
        const next = (out.get(key(e[2], e[3])) || []).filter((o) => !o[4]);
        if (!next.length) break;
        const dx = e[2] - e[0];
        const dy = e[3] - e[1];
        next.sort((p, q) => dx * (q[3] - q[1]) - dy * (q[2] - q[0]) - (dx * (p[3] - p[1]) - dy * (p[2] - p[0])));
        e = next[0];
      }
      if (ring.length >= 4) rings.push(ring);
    }
  }
  return rings;
}

/**
 * Contorno pronto para desenhar: os anéis do modelo, sem degraus de grade e com as quinas
 * arredondadas. O mapa é aproximado; um contorno "macio" diz isso melhor que uma escadinha
 * de células (que pareceria precisão que não existe).
 * @returns {number[][][]} anéis [[x, y], ...] sem repetir o primeiro ponto
 */
export function prepareOutline(model, floorIndex) {
  const floor = model.floors[floorIndex];
  const { cell, bounds, nx, ny } = model;
  let rings = (floor.outline || []).filter((r) => Array.isArray(r) && r.length >= 3);
  if (!rings.length && floor.inside) {
    rings = traceMask(floor.inside, nx, ny).map((r) => r.map(([ix, iy]) => [bounds.minX + ix * cell, bounds.minY + iy * cell]));
  }
  const out = [];
  for (const raw of rings) {
    let ring = raw.map((p) => [Number(p[0]), Number(p[1])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (ring.length > 1 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-6) ring.pop();
    if (ring.length < 3) continue;
    const area = Math.abs(ringArea(ring));
    if (area < cell * cell * 2) continue;
    ring = simplifyClosed(ring, cell * 0.8);
    if (ring.length < 3) continue;
    ring = roundCorners(ring, Math.max(cell * 1.6, 0.45), true, 4);
    out.push(ring);
  }
  return out;
}

/**
 * Divisões internas prontas para desenhar: os trechos do modelo emendados em linhas,
 * sem degraus de grade, com a confiança média de cada linha.
 * @returns {{points:number[][], conf:number, length:number}[]}
 */
export function prepareInnerWalls(model, floorIndex) {
  const floor = model.floors[floorIndex];
  const cell = model.cell;
  const walls = (floor.walls || []).filter((w) => w && w.kind === 'inner');
  if (!walls.length) return [];
  const q = cell / 4;
  const keyOf = (x, y) => `${Math.round(x / q)},${Math.round(y / q)}`;
  const nodes = new Map(); // chave -> {p, edges: []}
  const node = (x, y) => {
    const k = keyOf(x, y);
    let nd = nodes.get(k);
    if (!nd) {
      nd = { p: [x, y], edges: [] };
      nodes.set(k, nd);
    }
    return nd;
  };
  const edges = [];
  for (const w of walls) {
    const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
    if (!(len > 1e-6)) continue;
    const a = node(w.x1, w.y1);
    const b = node(w.x2, w.y2);
    if (a === b) continue;
    const e = { a, b, len, conf: Number.isFinite(w.conf) ? clamp(w.conf, 0, 1) : 0.5, used: false };
    a.edges.push(e);
    b.edges.push(e);
    edges.push(e);
  }
  const chains = [];
  const walk = (start, first) => {
    const points = [start.p];
    let conf = 0;
    let length = 0;
    let at = start;
    let e = first;
    while (e && !e.used) {
      e.used = true;
      at = e.a === at ? e.b : e.a;
      points.push(at.p);
      conf += e.conf * e.len;
      length += e.len;
      if (at.edges.length !== 2) break; // ponta ou entroncamento
      e = at.edges[0].used ? at.edges[1] : at.edges[0];
    }
    if (length > 0) chains.push({ points, conf: conf / length, length });
  };
  for (const nd of nodes.values()) if (nd.edges.length !== 2) for (const e of nd.edges) if (!e.used) walk(nd, e);
  for (const e of edges) if (!e.used) walk(e.a, e); // laços fechados
  const out = [];
  for (const c of chains) {
    if (c.length < Math.max(cell * 2.5, 0.6)) continue; // toquinho: é ruído do agrupamento, não uma divisão
    const points = roundCorners(simplifyOpen(c.points, cell * 0.8), Math.max(cell * 1.2, 0.3), false, 3);
    out.push({ points, conf: c.conf, length: c.length });
  }
  return out;
}

/**
 * Retângulo que envolve a área de todos os andares, com centro e "raio" (meia diagonal).
 * Sem área nenhuma, cai nos limites da grade.
 */
export function modelExtent(model) {
  const { nx, ny, cell, bounds } = model;
  let ix0 = nx;
  let ix1 = -1;
  let iy0 = ny;
  let iy1 = -1;
  for (const f of model.floors) {
    for (let iy = 0; iy < ny; iy++) {
      const row = iy * nx;
      for (let ix = 0; ix < nx; ix++) {
        if (!f.inside[row + ix]) continue;
        if (ix < ix0) ix0 = ix;
        if (ix > ix1) ix1 = ix;
        if (iy < iy0) iy0 = iy;
        if (iy > iy1) iy1 = iy;
      }
    }
  }
  let minX = bounds.minX;
  let minY = bounds.minY;
  let maxX = bounds.maxX;
  let maxY = bounds.maxY;
  if (ix1 >= ix0 && iy1 >= iy0) {
    minX = bounds.minX + ix0 * cell;
    maxX = bounds.minX + (ix1 + 1) * cell;
    minY = bounds.minY + iy0 * cell;
    maxY = bounds.minY + (iy1 + 1) * cell;
  }
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  return { minX, minY, maxX, maxY, w, h, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, radius: Math.hypot(w, h) / 2 };
}

/** Índice da célula que contém (x, y), ou -1 fora da grade. */
export function cellAt(model, x, y) {
  const ix = Math.floor((x - model.bounds.minX) / model.cell);
  const iy = Math.floor((y - model.bounds.minY) / model.cell);
  if (ix < 0 || iy < 0 || ix >= model.nx || iy >= model.ny) return -1;
  return iy * model.nx + ix;
}

/** Posição em model.floors do andar de número `floor`, ou -1. */
export function floorIndexOf(model, floor) {
  if (floor === null || floor === undefined) return -1;
  for (let i = 0; i < model.floors.length; i++) if (model.floors[i].floor === floor) return i;
  return -1;
}

/** Andar do modelo cujo piso está mais perto (por baixo) da altura z. */
export function nearestFloorIndex(model, z) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < model.floors.length; i++) {
    // um objeto a 1,2 m do piso pertence a esse andar, não ao de cima
    const d = Math.abs(z - 1.2 - model.floors[i].z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** "Andar de partida", "1 andar acima", "2 andares abaixo". */
export function floorTag(floor) {
  if (!floor) return 'Andar de partida';
  const n = Math.abs(floor);
  return `${n} ${n === 1 ? 'andar' : 'andares'} ${floor > 0 ? 'acima' : 'abaixo'}`;
}

/** Distância para pessoas: "≈ 14 m" (com vírgula abaixo de 10 m). */
export function approxMeters(m) {
  if (!Number.isFinite(m)) return '';
  const text = m < 9.5 ? (Math.round(m * 10) / 10).toFixed(1).replace('.', ',').replace(/,0$/, '') : String(Math.round(m));
  return `≈${NBSP_THIN}${text}${NBSP_THIN}m`;
}

/**
 * Onde desenhar cada roteador. Os da casa e os que caem perto da área ficam na posição
 * estimada; os distantes são presos a um anel em volta da área, com a direção e a distância.
 *
 * @returns {{ring:number, items:{ap:object, x:number, y:number, floorIndex:number, clamped:boolean,
 *            angle:number, distanceM:number, storey:number}[]}}  storey: +1/-1 = fica em outro andar (acima/abaixo), 0 = neste
 */
export function placeAps(model, extent = modelExtent(model), maxNeighbours = 24) {
  const ring = extent.radius + Math.max(1, extent.radius * 0.14);
  const items = [];
  let neighbours = 0;
  const lowest = model.floors.length ? model.floors[0].floor : 0;
  const highest = model.floors.length ? model.floors[model.floors.length - 1].floor : 0;
  for (const ap of model.aps || []) {
    if (!ap || !Number.isFinite(ap.x) || !Number.isFinite(ap.y)) continue;
    if (!ap.own && ++neighbours > maxNeighbours) continue;
    const dx = ap.x - extent.cx;
    const dy = ap.y - extent.cy;
    const d = Math.hypot(dx, dy);
    const angle = d > 1e-6 ? Math.atan2(dy, dx) : Number.isFinite(ap.bearing) ? ap.bearing : 0;
    let floorIndex = floorIndexOf(model, ap.floor);
    let storey = 0;
    if (floorIndex < 0) {
      if (ap.floor !== null && ap.floor !== undefined && Number.isFinite(ap.floor)) {
        storey = ap.floor > highest ? 1 : ap.floor < lowest ? -1 : 0;
        floorIndex = ap.floor > highest ? model.floors.length - 1 : 0;
      } else {
        floorIndex = nearestFloorIndex(model, Number.isFinite(ap.z) ? ap.z : 0);
      }
    }
    const clamped = !ap.inside && d > ring - 0.5;
    const distanceM = Number.isFinite(ap.distanceM) ? ap.distanceM : d;
    items.push({
      ap,
      x: clamped ? extent.cx + Math.cos(angle) * ring : ap.x,
      y: clamped ? extent.cy + Math.sin(angle) * ring : ap.y,
      floorIndex: Math.max(0, floorIndex),
      clamped,
      angle,
      distanceM,
      storey,
    });
  }
  return { ring, items };
}

/**
 * O caminho em trechos contínuos por andar, já suavizado (Catmull-Rom).
 * @returns {{runs:{floorIndex:number, points:{x:number, y:number, t:number, conf:number, d:number}[]}[],
 *            links:{from:{x:number,y:number,floorIndex:number}, to:{x:number,y:number,floorIndex:number}, t:number}[]}}
 *          t = 0..1 ao longo do levantamento; d = metros desde o começo do trecho
 */
export function pathRuns(model, subdivisions = 5) {
  const path = (model.path || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const runs = [];
  const links = [];
  if (path.length < 2) return { runs, links };
  const t0 = path[0].t;
  const span = Math.max(1e-6, path[path.length - 1].t - t0);
  const time = (p, i) => (Number.isFinite(p.t) ? clamp((p.t - t0) / span, 0, 1) : i / (path.length - 1));
  let current = null;
  let prev = null;
  path.forEach((p, i) => {
    const fi = floorIndexOf(model, p.floor);
    const floorIndex = fi >= 0 ? fi : nearestFloorIndex(model, p.z ?? 0);
    const node = { x: p.x, y: p.y, t: time(p, i), conf: Number.isFinite(p.conf) ? clamp(p.conf, 0, 1) : 0.5 };
    if (!current || current.floorIndex !== floorIndex) {
      if (prev) links.push({ from: { x: prev.node.x, y: prev.node.y, floorIndex: prev.floorIndex }, to: { x: node.x, y: node.y, floorIndex }, t: node.t });
      current = { floorIndex, nodes: [] };
      runs.push(current);
    }
    current.nodes.push(node);
    prev = { node, floorIndex };
  });
  const out = [];
  for (const run of runs) {
    if (run.nodes.length < 2) continue;
    // tira o tremor de ponto a ponto (cada posição tem 1 a 2 m de erro); as pontas ficam onde estão
    const n = run.nodes.map((p, i, all) => {
      if (i === 0 || i === all.length - 1) return p;
      return { ...p, x: (all[i - 1].x + 2 * p.x + all[i + 1].x) / 4, y: (all[i - 1].y + 2 * p.y + all[i + 1].y) / 4 };
    });
    const points = [];
    let d = 0;
    const push = (x, y, t, conf) => {
      const last = points[points.length - 1];
      if (last) {
        const step = Math.hypot(x - last.x, y - last.y);
        if (step < 1e-4) return;
        d += step;
      }
      points.push({ x, y, t, conf, d });
    };
    for (let i = 0; i < n.length - 1; i++) {
      const p0 = n[Math.max(0, i - 1)];
      const p1 = n[i];
      const p2 = n[i + 1];
      const p3 = n[Math.min(n.length - 1, i + 2)];
      for (let k = 0; k < subdivisions; k++) {
        const u = k / subdivisions;
        const u2 = u * u;
        const u3 = u2 * u;
        // Catmull-Rom com tensão 0,5: passa por todos os pontos sem laços exagerados
        const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3);
        const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3);
        push(x, y, p1.t + (p2.t - p1.t) * u, p1.conf + (p2.conf - p1.conf) * u);
      }
    }
    const last = n[n.length - 1];
    push(last.x, last.y, last.t, last.conf);
    if (points.length >= 2) out.push({ floorIndex: run.floorIndex, points });
  }
  return { runs: out, links };
}

/**
 * Escolhe quais rótulos aparecem: do mais importante para o menos, some quem bate em
 * um já colocado. `boxes`: {x, y, w, h} em px (canto de cima à esquerda), `priority` maior = fica.
 * @returns {boolean[]} visível ou não, na ordem de entrada
 */
export function declutter(boxes, gap = 4) {
  const order = boxes.map((_, i) => i).sort((a, b) => (boxes[b].priority || 0) - (boxes[a].priority || 0) || a - b);
  const placed = [];
  const visible = new Array(boxes.length).fill(false);
  for (const i of order) {
    const b = boxes[i];
    if (b.skip) continue;
    let hit = false;
    for (const p of placed) {
      if (b.x < p.x + p.w + gap && b.x + b.w + gap > p.x && b.y < p.y + p.h + gap && b.y + b.h + gap > p.y) {
        hit = true;
        break;
      }
    }
    if (hit) continue;
    placed.push(b);
    visible[i] = true;
  }
  return visible;
}

/** Barra de escala "redonda" (1, 2, 5, 10... m) que caiba em `maxPx`. */
export function niceScale(pxPerMeter, maxPx = 96) {
  if (!(pxPerMeter > 0)) return null;
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100, 200];
  let meters = steps[0];
  for (const s of steps) if (s * pxPerMeter <= maxPx) meters = s;
  const label = `≈${NBSP_THIN}${String(meters).replace('.', ',')}${NBSP_THIN}m`;
  return { meters, px: meters * pxPerMeter, label };
}

/**
 * O modelo novo é uma atualização do mesmo mapa (levantamento em andamento)?
 * Vale quando o caminho começa no mesmo instante e só cresceu, e o tamanho não mudou de repente.
 */
export function isSameMap(prev, next) {
  if (!prev || !next) return false;
  if (prev === next) return true;
  const a = prev.path || [];
  const b = next.path || [];
  if (!a.length || !b.length) return false;
  if (a[0].t !== b[0].t || b.length < a.length) return false;
  if (next.floors.length < prev.floors.length) return false;
  const ea = modelExtent(prev);
  const eb = modelExtent(next);
  const ratio = eb.radius / ea.radius;
  return ratio > 0.5 && ratio < 2.5;
}

// ---------------------------------------------------------------------------
// Rótulos
// ---------------------------------------------------------------------------

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Texto de fora, pronto para desenhar: sem caracteres de controle, espaços em excesso nem tamanho absurdo. */
export function cleanText(text, fallback = '') {
  const s = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return fallback;
  const chars = Array.from(s);
  return chars.length > 96 ? chars.slice(0, 96).join('') : s;
}

// corta por grafema quando dá (emoji compostos não se partem ao meio)
function graphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
    } catch {
      /* cai no corte por ponto de código */
    }
  }
  return Array.from(text);
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const parts = graphemes(text);
  let lo = 0;
  let hi = parts.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${parts.slice(0, mid).join('').trimEnd()}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${parts.slice(0, lo).join('').trimEnd()}…`;
}

const LABEL_FALLBACK = { room: 'Sem nome', spot: 'Ponto', router: 'Rede oculta', neighbour: 'Rede oculta', floor: '' };

/**
 * Mede um rótulo e decide o que cabe.
 * spec: { kind: 'room'|'spot'|'router'|'neighbour'|'floor', text, auto?, detail? }
 * @returns {{w:number, h:number, spec:object, text:string, detail:string, font:string, detailFont:string,
 *            pill:boolean, icon:boolean, textX:number, detailX:number}} medidas em px de CSS
 */
export function layoutLabel(ctx, spec, themeName) {
  const t = mapTheme(themeName);
  const kind = spec.kind;
  const raw = cleanText(spec.text, LABEL_FALLBACK[kind] ?? '');
  const detail = cleanText(spec.detail, '');
  let font;
  let maxWidth;
  let pill = false;
  let icon = false;
  let h;
  if (kind === 'room') {
    font = spec.auto ? `500 12px ${FONT}` : `600 13px ${FONT}`;
    maxWidth = 150;
    h = 22;
  } else if (kind === 'router') {
    font = `600 12px ${FONT}`;
    maxWidth = 132;
    pill = true;
    icon = true;
    h = 26;
  } else if (kind === 'neighbour') {
    font = `500 12px ${FONT}`;
    maxWidth = 104;
    pill = true;
    h = 22;
  } else if (kind === 'floor') {
    font = `600 12px ${FONT}`;
    maxWidth = 170;
    h = 20;
  } else {
    font = `500 12px ${FONT}`;
    maxWidth = 120;
    h = 20;
  }
  const detailFont = `500 12px ${FONT}`;
  ctx.font = font;
  const text = spec.iconOnly ? '' : fitText(ctx, raw, maxWidth);
  const textW = Math.ceil(ctx.measureText(text).width);
  let detailW = 0;
  if (detail) {
    ctx.font = detailFont;
    detailW = Math.ceil(ctx.measureText(detail).width);
  }
  const padX = pill ? (spec.iconOnly ? 6 : 9) : 5;
  const iconW = icon ? (spec.iconOnly ? 14 : 18) : 0;
  const gap = detail && text ? 6 : 0;
  const w = padX * 2 + iconW + textW + gap + detailW;
  return {
    w,
    h,
    spec,
    text,
    detail,
    font,
    detailFont,
    pill,
    icon,
    textX: padX + iconW,
    detailX: padX + iconW + textW + gap,
    theme: t,
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// O "leque" do Wi-Fi: um ponto e dois arcos, no traço dos ícones do app.
function wifiGlyph(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size * 0.13;
  ctx.lineCap = 'round';
  const by = cy + size * 0.32;
  ctx.beginPath();
  ctx.arc(cx, by, size * 0.09, 0, Math.PI * 2);
  ctx.fill();
  for (const r of [0.34, 0.62]) {
    ctx.beginPath();
    ctx.arc(cx, by, size * r, -Math.PI * 0.76, -Math.PI * 0.24);
    ctx.stroke();
  }
  ctx.restore();
}

/** Desenha um rótulo já medido, com o canto de cima à esquerda em (x, y). */
export function paintLabel(ctx, layout, x, y, alpha = 1) {
  const t = layout.theme;
  const { spec, w, h } = layout;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const midY = y + h / 2 + 0.5;
  if (layout.pill) {
    const own = spec.kind === 'router';
    roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, (h - 1) / 2);
    ctx.fillStyle = t.pillBg;
    ctx.globalAlpha = alpha * (own ? 0.94 : 0.86);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = own ? 1.25 : 1;
    ctx.strokeStyle = own ? t.router : t.pillLine;
    ctx.stroke();
    if (layout.icon) wifiGlyph(ctx, x + (spec.iconOnly ? 6 : 9) + 7, y + h / 2, 14, t.router);
    ctx.font = layout.font;
    ctx.fillStyle = own ? t.labelText : t.labelMuted;
    ctx.fillText(layout.text, x + layout.textX, midY);
    if (layout.detail) {
      ctx.font = layout.detailFont;
      ctx.fillStyle = own ? t.labelMuted : t.labelText;
      ctx.fillText(layout.detail, x + layout.detailX, midY);
    }
  } else {
    const muted = spec.kind === 'floor' || (spec.kind === 'room' && spec.auto);
    ctx.font = layout.font;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = t.labelHalo;
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeText(layout.text, x + layout.textX, midY);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = muted ? t.labelMuted : t.labelText;
    ctx.fillText(layout.text, x + layout.textX, midY);
  }
  ctx.restore();
}

/** Cor '#rrggbb' -> 'rgba(r, g, b, a)'. */
export function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** O usuário pediu menos movimento? */
export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Monta a barra de escala (HTML do visualizador; só texto fixo e números). */
export function createScaleBar(doc) {
  const el = doc.createElement('div');
  el.className = 'mapv__scale';
  el.setAttribute('aria-hidden', 'true');
  const bar = doc.createElement('span');
  bar.className = 'mapv__scale-bar';
  const text = doc.createElement('span');
  text.className = 'mapv__scale-text';
  el.append(bar, text);
  let last = '';
  return {
    el,
    /** @param {{px:number, label:string}|null} scale */
    set(scale) {
      const key = scale ? `${Math.round(scale.px)}|${scale.label}` : '';
      if (key === last) return;
      last = key;
      el.hidden = !scale;
      if (!scale) return;
      bar.style.width = `${Math.round(scale.px)}px`;
      text.textContent = scale.label;
    },
    get: () => last,
  };
}

/** Desenha a barra de escala numa foto (canvas 2D), no canto de baixo à esquerda. */
export function paintScaleBar(ctx, scale, themeName, x, y) {
  if (!scale) return;
  const t = mapTheme(themeName);
  ctx.save();
  ctx.strokeStyle = t.muted;
  ctx.fillStyle = t.muted;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y);
  ctx.lineTo(x + scale.px, y);
  ctx.lineTo(x + scale.px, y - 5);
  ctx.stroke();
  ctx.font = `500 12px ${FONT}`;
  ctx.textBaseline = 'bottom';
  ctx.fillText(scale.label, x + scale.px + 8, y + 3);
  ctx.restore();
}

/**
 * Rótulo de um roteador da casa. Quando vários aparelhos têm o mesmo nome (rede mesh,
 * pontos de acesso de escritório), só o primeiro mostra o nome; os outros, só o ícone.
 * `seen` é um Set com os nomes já usados neste desenho.
 */
export function routerLabel(item, seen) {
  const name = cleanText(item.ap.ssid).toLowerCase();
  item.repeat = !!name && seen.has(name);
  seen.add(name);
  return { kind: 'router', text: item.ap.ssid, detail: item.clamped ? approxMeters(item.distanceM) : '', iconOnly: item.repeat && !item.clamped };
}

/** Há um ambiente neste andar com este mesmo nome? (o rótulo do ponto marcado seria repetido) */
export function namesRoom(floor, label) {
  const name = cleanText(label).toLowerCase();
  if (!name) return false;
  return (floor.rooms || []).some((r) => cleanText(r.label).toLowerCase() === name);
}

/** Dados do toque que os dois visualizadores entregam em onPick para uma célula do piso. */
export function floorPick(model, heat, floorIndex, x, y) {
  const c = cellAt(model, x, y);
  if (c < 0) return null;
  const floor = model.floors[floorIndex];
  if (!floor || !floor.inside[c]) return null;
  const roomIndex = floor.room ? floor.room[c] : -1;
  const room = roomIndex >= 0 ? floor.rooms[roomIndex] || null : null;
  const field = heat && heat[floorIndex];
  const dbm = field && Number.isFinite(field.dbm[c]) ? field.dbm[c] : null;
  const base = {
    x,
    y,
    floor: floor.floor,
    floorIndex,
    cell: c,
    ix: c % model.nx,
    iy: Math.floor(c / model.nx),
    conf: floor.conf ? floor.conf[c] : 1,
    dbm,
    room,
    roomId: room ? room.id : null,
    label: room ? room.label : null,
  };
  // com o mapa de calor ligado o toque fala do lugar (sinal ali); sem ele, do ambiente
  return { kind: room && !field ? 'room' : 'cell', ...base };
}

// ---------------------------------------------------------------------------
// Visualizador 2D
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} container
 * @param {{theme?:'dark'|'light', onPick?:(pick:object)=>void, label?:string, padding?:object}} [options]
 */
export function createViewer2d(container, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  let theme = mapTheme(options.theme);
  let onPick = typeof options.onPick === 'function' ? options.onPick : null;
  let model = null;
  let heat = null;
  let layers = { ...DEFAULT_LAYERS };
  let focus = null; // número do andar
  let walker = null;
  let padding = { top: 0, right: 0, bottom: 0, left: 0, ...(options.padding || {}) };
  let destroyed = false;
  let frames = 0;

  const root = doc.createElement('div');
  root.className = 'mapv mapv--2d';
  root.dataset.theme = theme.name;
  root.dataset.kind = '2d';
  root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
  const canvas = doc.createElement('canvas');
  canvas.className = 'mapv__canvas';
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', options.label || 'Mapa da casa visto de cima, feito com o sinal do Wi-Fi.');
  canvas.tabIndex = 0;
  const scaleBar = createScaleBar(doc);
  root.append(canvas, scaleBar.el);
  container.append(root);
  const ctx = canvas.getContext('2d');

  let width = 0;
  let height = 0;
  let dpr = 1;
  // o que se calcula uma vez por modelo
  let prep = null;
  // vista: zoom e deslocamento por cima do enquadramento automático
  const view = { zoom: 1, panX: 0, panY: 0 };
  let layout = null;
  let lastScale = null;
  let labelBoxes = [];
  let markers = [];
  let seenNames = new Set();
  let raf = 0;

  function invalidate() {
    if (destroyed || raf) return;
    raf = win.requestAnimationFrame(() => {
      raf = 0;
      draw();
    });
  }

  // --- preparação por modelo ---
  function prepare() {
    prep = null;
    if (!model || !model.floors.length) return;
    const extent = modelExtent(model);
    const floors = model.floors.map((_, i) => ({
      rings: prepareOutline(model, i),
      inner: prepareInnerWalls(model, i),
      tile: null,
    }));
    prep = { extent, floors, aps: placeAps(model, extent), path: pathRuns(model, 4) };
  }

  function invalidateTiles() {
    if (prep) for (const f of prep.floors) f.tile = null;
  }

  // Piso de um andar num canvas à parte: cores (interpoladas), hachura onde a confiança é baixa, recorte pelo contorno.
  function floorTile(i) {
    const f = prep.floors[i];
    if (f.tile) return f.tile;
    const { nx, ny, cell, bounds } = model;
    const k = Math.max(2, Math.min(12, Math.floor(1400 / Math.max(nx, ny))));
    const tile = doc.createElement('canvas');
    tile.width = nx * k;
    tile.height = ny * k;
    const g = tile.getContext('2d');
    const small = doc.createElement('canvas');
    small.width = nx;
    small.height = ny;
    const sg = small.getContext('2d');
    const data = paintFloorCells(model, i, { heat: heat ? heat[i] : null, theme, rooms: layers.rooms, bake: true });
    sg.putImageData(new ImageData(data, nx, ny), 0, 0);
    const toTile = (p) => [((p[0] - bounds.minX) / cell) * k, ((p[1] - bounds.minY) / cell) * k];
    g.save();
    g.beginPath();
    for (const ring of f.rings) {
      ring.forEach((p, j) => {
        const [u, v] = toTile(p);
        if (j === 0) g.moveTo(u, v);
        else g.lineTo(u, v);
      });
      g.closePath();
    }
    g.clip('evenodd');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(small, 0, 0, tile.width, tile.height);

    // hachura: linhas na diagonal, mais fortes quanto menor a confiança
    const floor = model.floors[i];
    const field = heat ? heat[i] : null;
    const alpha = new Uint8ClampedArray(nx * ny * 4);
    const [hr, hg, hb] = hexToRgb(theme.hatch);
    const raw = new Float32Array(nx * ny);
    for (let c = 0; c < nx * ny; c++) {
      if (!floor.inside[c]) continue;
      let conf = floor.conf ? floor.conf[c] : 1;
      if (field && (Number.isNaN(field.dbm[c]) || (field.conf && field.conf[c] < conf))) conf = Number.isNaN(field.dbm[c]) ? 0 : field.conf[c];
      raw[c] = conf;
    }
    const smooth = smoothInside(raw, floor.inside, nx, ny, 2);
    let any = false;
    for (let c = 0; c < nx * ny; c++) {
      const a = floor.inside[c] ? (1 - confWeight(smooth[c])) * 150 : 0;
      if (a > 4) any = true;
      alpha[c * 4] = hr;
      alpha[c * 4 + 1] = hg;
      alpha[c * 4 + 2] = hb;
      alpha[c * 4 + 3] = a;
    }
    if (any) {
      const hatch = doc.createElement('canvas');
      hatch.width = tile.width;
      hatch.height = tile.height;
      const hgx = hatch.getContext('2d');
      const period = ((0.23 * clamp(prep.extent.radius / 6, 0.8, 2.2)) / cell) * k;
      hgx.strokeStyle = theme.hatch;
      hgx.lineWidth = Math.max(1, period * 0.26);
      hgx.beginPath();
      for (let d = -tile.height; d < tile.width; d += period) {
        hgx.moveTo(d, 0);
        hgx.lineTo(d + tile.height, tile.height);
      }
      hgx.stroke();
      sg.clearRect(0, 0, nx, ny);
      sg.putImageData(new ImageData(alpha, nx, ny), 0, 0);
      hgx.globalCompositeOperation = 'destination-in';
      hgx.imageSmoothingEnabled = true;
      hgx.drawImage(small, 0, 0, tile.width, tile.height);
      g.drawImage(hatch, 0, 0);
    }
    g.restore();
    f.tile = { canvas: tile, k };
    return f.tile;
  }

  // --- enquadramento ---
  function visibleFloors() {
    if (!model) return [];
    const fi = floorIndexOf(model, focus);
    if (fi >= 0) return [fi];
    return model.floors.map((_, i) => i);
  }

  function computeLayout() {
    layout = null;
    if (!prep || !width || !height) return;
    const list = visibleFloors();
    const e = prep.extent;
    const availW = Math.max(40, width - padding.left - padding.right - 32);
    const availH = Math.max(40, height - padding.top - padding.bottom - 56);
    const portrait = availH >= availW;
    // gira 90° quando isso aproveita melhor a tela (o mapa não tem norte mesmo)
    const options = [false, true].map((rot) => {
      const tw = rot ? e.h : e.w;
      const th = rot ? e.w : e.h;
      const n = list.length;
      const gap = 0.14;
      const cols = portrait ? 1 : n;
      const rows = portrait ? n : 1;
      const totalW = tw * cols + tw * gap * (cols - 1);
      const totalH = th * rows + th * gap * (rows - 1);
      const s = Math.min(availW / totalW, availH / totalH);
      return { rot, tw, th, s, cols, rows, gap };
    });
    const best = options[1].s > options[0].s * 1.08 ? options[1] : options[0];
    const { rot, tw, th, s, cols, rows, gap } = best;
    const totalW = (tw * cols + tw * gap * (cols - 1)) * s;
    const totalH = (th * rows + th * gap * (rows - 1)) * s;
    const left = padding.left + (width - padding.left - padding.right - totalW) / 2;
    const top = padding.top + (height - padding.top - padding.bottom - totalH) / 2;
    const tiles = list.map((floorIndex, k) => {
      // em retrato o andar mais alto fica em cima; em paisagem o mais baixo fica à esquerda
      const col = portrait ? 0 : k;
      const row = portrait ? list.length - 1 - k : 0;
      const cxp = left + (col * (1 + gap) + 0.5) * tw * s;
      const cyp = top + (row * (1 + gap) + 0.5) * th * s;
      return { floorIndex, cx: cxp, cy: cyp, w: tw * s, h: th * s };
    });
    layout = { tiles, s, rot };
  }

  // mundo -> tela (px de CSS) para o andar de índice i
  function toScreen(tile, x, y) {
    const e = prep.extent;
    const s = layout.s * view.zoom;
    const dx = x - e.cx;
    const dy = y - e.cy;
    const rx = layout.rot ? -dy : dx;
    const ry = layout.rot ? dx : dy;
    const ox = width / 2 + (tile.cx - width / 2) * view.zoom + view.panX;
    const oy = height / 2 + (tile.cy - height / 2) * view.zoom + view.panY;
    return [ox + rx * s, oy - ry * s];
  }

  function toWorld(tile, px, py) {
    const e = prep.extent;
    const s = layout.s * view.zoom;
    const ox = width / 2 + (tile.cx - width / 2) * view.zoom + view.panX;
    const oy = height / 2 + (tile.cy - height / 2) * view.zoom + view.panY;
    const rx = (px - ox) / s;
    const ry = -(py - oy) / s;
    const dx = layout.rot ? ry : rx;
    const dy = layout.rot ? -rx : ry;
    return [e.cx + dx, e.cy + dy];
  }

  function tileFor(floorIndex) {
    return layout ? layout.tiles.find((t) => t.floorIndex === floorIndex) || null : null;
  }

  // --- desenho ---
  function draw() {
    if (destroyed || !width || !height) return;
    frames++;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);
    labelBoxes = [];
    markers = [];
    lastScale = null;
    if (!prep || !layout) {
      scaleBar.set(null);
      return;
    }
    const s = layout.s * view.zoom;
    const labels = [];
    seenNames = new Set();
    for (const tile of layout.tiles) drawFloor(tile, s, labels);
    drawLabels(labels);
    lastScale = niceScale(s, Math.min(110, width * 0.3));
    scaleBar.set(lastScale);
  }

  function ringPath(tile, ring, closed = true) {
    ring.forEach((p, j) => {
      const [x, y] = toScreen(tile, p[0], p[1]);
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (closed) ctx.closePath();
  }

  function drawFloor(tile, s, labels) {
    const i = tile.floorIndex;
    const f = prep.floors[i];
    const floor = model.floors[i];
    const e = prep.extent;
    const { bounds, cell } = model;

    if (layers.grid) {
      // linhas de 1 m em volta do andar, até a borda da tela quando há um andar só
      const single = layout.tiles.length === 1;
      const pad = single ? Math.hypot(width, height) / s : Math.max(1, e.radius * 0.1);
      const x0 = Math.floor(e.minX - pad);
      const x1 = Math.ceil(e.maxX + pad);
      const y0 = Math.floor(e.minY - pad);
      const y1 = Math.ceil(e.maxY + pad);
      ctx.save();
      ctx.lineWidth = 1;
      const line = (ax, ay, bx, by, major) => {
        const a = toScreen(tile, ax, ay);
        const b = toScreen(tile, bx, by);
        ctx.strokeStyle = rgba(theme.grid, theme.gridAlpha * (major ? 1.7 : 1));
        ctx.beginPath();
        ctx.moveTo(Math.round(a[0]) + 0.5, Math.round(a[1]) + 0.5);
        ctx.lineTo(Math.round(b[0]) + 0.5, Math.round(b[1]) + 0.5);
        ctx.stroke();
      };
      if (s >= 6) {
        for (let gx = x0; gx <= x1; gx++) line(gx, y0, gx, y1, gx % 5 === 0);
        for (let gy = y0; gy <= y1; gy++) line(x0, gy, x1, gy, gy % 5 === 0);
      }
      ctx.restore();
    }

    // piso: a imagem pronta, levada para o lugar com uma transformação
    const t = floorTile(i);
    const o = toScreen(tile, bounds.minX, bounds.minY);
    const ux = toScreen(tile, bounds.minX + cell, bounds.minY);
    const uy = toScreen(tile, bounds.minX, bounds.minY + cell);
    ctx.save();
    ctx.transform((ux[0] - o[0]) / t.k, (ux[1] - o[1]) / t.k, (uy[0] - o[0]) / t.k, (uy[1] - o[1]) / t.k, o[0], o[1]);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(t.canvas, 0, 0);
    ctx.restore();

    // anéis do sinal em volta dos roteadores da casa, só por cima do piso
    const own = prep.aps.items.filter((a) => a.ap.own && a.floorIndex === i && !a.clamped);
    if (layers.routers && own.length && f.rings.length) {
      ctx.save();
      ctx.beginPath();
      for (const ring of f.rings) ringPath(tile, ring);
      ctx.clip('evenodd');
      ctx.lineWidth = 1.5;
      for (const a of own) {
        const [x, y] = toScreen(tile, a.x, a.y);
        [0.9, 1.8, 2.7].forEach((r, k) => {
          ctx.strokeStyle = rgba(theme.router, 0.42 - k * 0.12);
          ctx.beginPath();
          ctx.arc(x, y, r * s, 0, Math.PI * 2);
          ctx.stroke();
        });
      }
      ctx.restore();
    }

    if (layers.walls) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const w of f.inner) {
        ctx.strokeStyle = rgba(theme.inner, 0.22 + 0.55 * w.conf);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ringPath(tile, w.points, false);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.beginPath();
      for (const ring of f.rings) ringPath(tile, ring);
      ctx.strokeStyle = rgba(theme.glass, 0.22);
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = theme.edge;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }

    if (layers.path) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const rgb = [0, 0, 0];
      for (const run of prep.path.runs) {
        if (run.floorIndex !== i) continue;
        const pts = run.points.map((p) => toScreen(tile, p.x, p.y));
        ctx.strokeStyle = rgba(theme.pathCasing, 0.55);
        ctx.lineWidth = 5;
        ctx.beginPath();
        pts.forEach((p, j) => (j === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
        ctx.stroke();
        ctx.lineWidth = 2.5;
        for (let j = 1; j < pts.length; j++) {
          const p = run.points[j];
          timeRgb(p.t, theme, rgb);
          ctx.strokeStyle = `rgba(${rgb[0] | 0}, ${rgb[1] | 0}, ${rgb[2] | 0}, ${0.3 + 0.7 * confWeight(p.conf + 0.1)})`;
          ctx.beginPath();
          ctx.moveTo(pts[j - 1][0], pts[j - 1][1]);
          ctx.lineTo(pts[j][0], pts[j][1]);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    if (layers.spots) {
      for (const sp of model.spots || []) {
        if (floorIndexOf(model, sp.floor) !== i) continue;
        const [x, y] = toScreen(tile, sp.x, sp.y);
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = theme.pin;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.labelHalo;
        ctx.stroke();
        markers.push({ kind: 'spot', x, y, r: 18, data: sp, floorIndex: i });
        // ponto sem nome fica só com o marcador; o que deu nome a um ambiente não repete o nome
        if (cleanText(sp.label) && !namesRoom(floor, sp.label)) {
          labels.push({ spec: { kind: 'spot', text: sp.label }, x, y: y - 9, ax: 0.5, ay: 1, priority: 20, pick: { kind: 'spot', data: sp, floorIndex: i } });
        }
      }
    }

    // roteadores
    for (const a of prep.aps.items) {
      if (a.floorIndex !== i) continue;
      const [x, y] = toScreen(tile, a.x, a.y);
      if (a.ap.own) {
        if (!layers.routers) continue;
        ctx.beginPath();
        ctx.arc(x, y, 10, 0, Math.PI * 2);
        ctx.fillStyle = theme.router;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = theme.labelHalo;
        ctx.stroke();
        wifiGlyph(ctx, x, y - 1, 13, theme.accentInk);
        markers.push({ kind: 'router', x, y, r: 22, data: a.ap, floorIndex: i });
        const spec = routerLabel(a, seenNames);
        // nome repetido: no 2D o próprio marcador já é o ícone
        if (!spec.iconOnly) labels.push({ spec, x, y: y - 15, ax: 0.5, ay: 1, priority: 60, pick: { kind: 'router', data: a.ap, floorIndex: i } });
      } else {
        if (!layers.neighbours) continue;
        ctx.save();
        ctx.fillStyle = theme.neighbour;
        ctx.strokeStyle = theme.labelHalo;
        ctx.lineWidth = 1.5;
        if (a.clamped) {
          // seta para fora, na direção do vizinho
          const far = toScreen(tile, a.x + Math.cos(a.angle), a.y + Math.sin(a.angle));
          const ang = Math.atan2(far[1] - y, far[0] - x);
          ctx.translate(x, y);
          ctx.rotate(ang);
          ctx.beginPath();
          ctx.moveTo(8, 0);
          ctx.lineTo(-4, -5.5);
          ctx.lineTo(-1.5, 0);
          ctx.lineTo(-4, 5.5);
          ctx.closePath();
          ctx.stroke();
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fill();
        }
        ctx.restore();
        markers.push({ kind: 'router', x, y, r: 16, data: a.ap, floorIndex: i });
        const arrow = a.storey > 0 ? ' ↑' : a.storey < 0 ? ' ↓' : '';
        labels.push({
          spec: { kind: 'neighbour', text: a.ap.ssid, detail: a.clamped ? `${approxMeters(a.distanceM)}${arrow}` : arrow.trim() },
          x,
          y: y - 9,
          ax: 0.5,
          ay: 1,
          priority: 5 + clamp((a.ap.bestRssi + 100) / 20, 0, 4),
          pick: { kind: 'router', data: a.ap, floorIndex: i },
        });
      }
    }
    if (layers.neighbours && i === (layout.tiles[0] && layout.tiles[0].floorIndex)) {
      const [x, y] = toScreen(tile, e.cx, e.cy);
      ctx.save();
      ctx.setLineDash([3, 6]);
      ctx.strokeStyle = rgba(theme.neighbour, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, prep.aps.ring * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (walker && nearestFloorIndex(model, walker.z ?? 0) === i) {
      const [x, y] = toScreen(tile, walker.x, walker.y);
      ctx.beginPath();
      ctx.arc(x, y, 15, 0, Math.PI * 2);
      ctx.fillStyle = rgba(theme.router, 0.22);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = theme.router;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    if (layers.labels) {
      if (layers.rooms || heat) {
        for (const room of floor.rooms) {
          const [x, y] = toScreen(tile, room.cx, room.cy);
          labels.push({
            spec: { kind: 'room', text: room.label, auto: !!room.auto },
            x,
            y,
            ax: 0.5,
            ay: 0.5,
            priority: (room.auto ? 30 : 50) + clamp(room.areaM2 / 10, 0, 9),
            pick: { kind: 'room', data: room, floorIndex: i },
          });
        }
      }
      if (layout.tiles.length > 1) {
        // etiqueta do andar no canto de cima à esquerda do seu quadro
        const [mx, my] = toScreen(tile, e.cx, e.cy);
        labels.push({ spec: { kind: 'floor', text: floorTag(floor.floor) }, x: mx - (tile.w / 2) * view.zoom, y: my - (tile.h / 2) * view.zoom - 4, ax: 0, ay: 1, priority: 95 });
      }
    }
  }

  function drawLabels(labels) {
    if (!layers.labels) return;
    const boxes = labels.map((l) => {
      const lay = layoutLabel(ctx, l.spec, theme);
      return { ...l, lay, w: lay.w, h: lay.h, x: Math.round(l.x - lay.w * l.ax), y: Math.round(l.y - lay.h * l.ay) };
    });
    const visible = declutter(boxes);
    boxes.forEach((b, i) => {
      if (!visible[i]) return;
      paintLabel(ctx, b.lay, b.x, b.y);
      if (b.pick) labelBoxes.push(b);
    });
  }

  // --- toque ---
  function pickAt(px, py) {
    if (!prep || !layout) return null;
    for (const b of labelBoxes) {
      if (px >= b.x - 4 && px <= b.x + b.w + 4 && py >= b.y - 4 && py <= b.y + b.h + 4) return fromMarker(b.pick);
    }
    let best = null;
    let bestD = Infinity;
    for (const m of markers) {
      const d = Math.hypot(m.x - px, m.y - py);
      if (d <= m.r && d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (best) return fromMarker(best);
    for (const tile of layout.tiles) {
      const [x, y] = toWorld(tile, px, py);
      const hit = floorPick(model, heat, tile.floorIndex, x, y);
      if (hit) return hit;
    }
    return null;
  }

  function fromMarker(m) {
    const d = m.data;
    const floor = model.floors[m.floorIndex];
    if (m.kind === 'room') return { kind: 'room', x: d.cx, y: d.cy, floor: floor.floor, floorIndex: m.floorIndex, room: d, roomId: d.id, label: d.label, dbm: null };
    if (m.kind === 'spot') return { kind: 'spot', x: d.x, y: d.y, floor: d.floor, floorIndex: m.floorIndex, spot: d, id: d.id, label: d.label };
    return { kind: 'router', x: d.x, y: d.y, floor: d.floor ?? floor.floor, floorIndex: m.floorIndex, ap: d, id: d.id, label: d.ssid, own: !!d.own };
  }

  const pointers = new Map();
  let gesture = null;
  let lastTap = null;
  let tapTimer = 0;

  function local(ev) {
    const r = canvas.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }

  function onDown(ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    canvas.setPointerCapture?.(ev.pointerId);
    const [x, y] = local(ev);
    pointers.set(ev.pointerId, { x, y });
    if (pointers.size === 1) gesture = { kind: 'pan', x, y, startX: x, startY: y, t: ev.timeStamp, moved: false };
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, moved: true };
    }
  }

  function zoomAbout(px, py, factor) {
    const next = clamp(view.zoom * factor, 0.6, 10);
    const k = next / view.zoom;
    // mantém parado o ponto sob os dedos
    view.panX = px - width / 2 - (px - width / 2 - view.panX) * k;
    view.panY = py - height / 2 - (py - height / 2 - view.panY) * k;
    view.zoom = next;
  }

  function onMove(ev) {
    if (!pointers.has(ev.pointerId) || !gesture) return;
    const [x, y] = local(ev);
    pointers.set(ev.pointerId, { x, y });
    if (gesture.kind === 'pan' && pointers.size === 1) {
      if (!gesture.moved && Math.hypot(x - gesture.startX, y - gesture.startY) > 8) gesture.moved = true;
      if (gesture.moved) {
        view.panX += x - gesture.x;
        view.panY += y - gesture.y;
        invalidate();
      }
      gesture.x = x;
      gesture.y = y;
    } else if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (gesture.dist > 0) zoomAbout(mx, my, dist / gesture.dist);
      view.panX += mx - gesture.mx;
      view.panY += my - gesture.my;
      gesture.dist = dist;
      gesture.mx = mx;
      gesture.my = my;
      invalidate();
    }
  }

  function onUp(ev) {
    if (!pointers.has(ev.pointerId)) return;
    const [x, y] = local(ev);
    pointers.delete(ev.pointerId);
    const g = gesture;
    if (pointers.size === 0) gesture = null;
    else if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      gesture = { kind: 'pan', x: p.x, y: p.y, startX: p.x, startY: p.y, t: ev.timeStamp, moved: true };
    }
    if (ev.type === 'pointercancel' || !g || g.kind !== 'pan' || g.moved || ev.timeStamp - g.t > 450) return;
    // toque duplo: volta ao enquadramento
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
      const hit = pickAt(x, y);
      if (hit && onPick) onPick(hit);
    }, 230);
  }

  function onWheel(ev) {
    ev.preventDefault();
    const [x, y] = local(ev);
    zoomAbout(x, y, Math.exp(-ev.deltaY * 0.0015));
    invalidate();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // --- tamanho ---
  function resize() {
    if (destroyed) return;
    const w = root.clientWidth;
    const h = root.clientHeight;
    const ratio = Math.min(win.devicePixelRatio || 1, 2);
    if (!w || !h) {
      width = 0;
      height = 0;
      return;
    }
    if (w === width && h === height && ratio === dpr) return;
    width = w;
    height = h;
    dpr = ratio;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    computeLayout();
    draw();
  }
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => resize()) : null;
  observer?.observe(root);

  const api = {
    kind: '2d',
    el: root,
    setModel(next, opts = {}) {
      const keep = opts.keepView ?? isSameMap(model, next);
      model = next || null;
      if (!model) heat = null;
      else if (heat && heat.length !== model.floors.length) heat = null;
      prepare();
      if (!keep) Object.assign(view, { zoom: 1, panX: 0, panY: 0 });
      computeLayout();
      invalidate();
    },
    setHeat(fields) {
      heat = Array.isArray(fields) && model && fields.length === model.floors.length ? fields : null;
      invalidateTiles();
      invalidate();
    },
    setLayers(partial) {
      const before = layers.rooms;
      layers = { ...layers, ...(partial || {}) };
      if (before !== layers.rooms) invalidateTiles();
      invalidate();
    },
    getLayers: () => ({ ...layers }),
    setView() {
      invalidate();
    },
    resetView() {
      Object.assign(view, { zoom: 1, panX: 0, panY: 0 });
      invalidate();
    },
    setExplode() {},
    setFocusFloor(floor) {
      focus = floor ?? null;
      computeLayout();
      invalidate();
    },
    setWalker(pos) {
      walker = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: pos.x, y: pos.y, z: pos.z ?? 0 } : null;
      invalidate();
    },
    setTheme(name) {
      theme = mapTheme(name);
      root.dataset.theme = theme.name;
      invalidateTiles();
      invalidate();
    },
    setPadding(p) {
      padding = { top: 0, right: 0, bottom: 0, left: 0, ...(p || {}) };
      computeLayout();
      invalidate();
    },
    setOnPick(fn) {
      onPick = typeof fn === 'function' ? fn : null;
    },
    /** Posição na tela (px dentro do visualizador) de um ponto do mapa. */
    worldToScreen(pos) {
      if (!prep || !layout) return null;
      const fi = pos.floor !== undefined && pos.floor !== null ? floorIndexOf(model, pos.floor) : nearestFloorIndex(model, pos.z ?? 0);
      const tile = tileFor(fi);
      if (!tile) return null;
      const [x, y] = toScreen(tile, pos.x, pos.y);
      return { x, y, visible: x >= 0 && y >= 0 && x <= width && y <= height };
    },
    pickAt(x, y) {
      draw();
      return pickAt(x, y);
    },
    snapshot() {
      draw();
      const out = doc.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const g = out.getContext('2d');
      g.drawImage(canvas, 0, 0);
      g.scale(dpr, dpr);
      paintScaleBar(g, lastScale, theme, 16 + padding.left, height - 18 - padding.bottom);
      return new Promise((resolve, reject) => out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('não foi possível gerar a imagem'))), 'image/png'));
    },
    resize,
    stats: () => ({ kind: '2d', frames, width, height, pixelRatio: dpr, running: raf !== 0 }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      win.cancelAnimationFrame(raf);
      win.clearTimeout(tapTimer);
      observer?.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      prep = null;
      model = null;
      heat = null;
      root.remove();
    },
  };
  resize();
  return api;
}
