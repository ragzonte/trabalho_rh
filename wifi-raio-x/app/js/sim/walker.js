// Pessoa virtual que anda pela casa simulada com o celular na mão.
//
// É o que permite demonstrar (e testar) o mapa 3D sentado numa mesa: a posição avança
// com o tempo SIMULADO e o simulador faz as varreduras de onde ela está.
//
// Modos:
//   'auto'    passeia sem parar pelos cômodos (roteiros de planWalk), com pausas;
//   'still'   fica parada;
//   'manual'  vai aonde mandarem (goTo / setFloor), desviando das paredes e usando
//             portas e escadas, e espera lá.
//
// A caminhada é uma linha do tempo de trechos retos; os trechos futuros só são criados
// quando alguém pergunta por aquele instante, então nada roda "por fora".

import { FLOOR_HEIGHT } from '../mapping/types.js';
import { createRng } from './prng.js';
import { NAV_CELL, navGrid, planWalk } from './walk.js';
import { PHONE_HEIGHT } from './world.js';

export const WALK_MODES = Object.freeze(['auto', 'still', 'manual']);

// Guarda este tanto de passado (s): uma varredura pergunta onde a pessoa estava nos
// últimos ~3 s; o resto pode ser esquecido.
const KEEP_S = 30;
const MANUAL_SPEED = 0.85; // m/s
const GOOD_CLEAR = 0.3; // folga da parede ao cortar caminho (igual à de walk.js)

const DIRS = [
  [1, 0, 1],
  [1, 1, Math.SQRT2],
  [0, 1, 1],
  [-1, 1, Math.SQRT2],
  [-1, 0, 1],
  [-1, -1, Math.SQRT2],
  [0, -1, 1],
  [1, -1, Math.SQRT2],
];

// ---------------------------------------------------------------------------
// Rota entre dois pontos quaisquer
// ---------------------------------------------------------------------------
// planWalk só sabe fazer o passeio completo. Para "vá até ali" é preciso achar o caminho
// entre dois pontos; usa a mesma grade de navGrid (células livres), mas confere as
// paredes direto no mundo, para não depender dos detalhes internos de walk.js.

function cellXY(nav, c) {
  const i = c % nav.nx;
  return [nav.cx(i), nav.cy((c - i) / nav.nx)];
}

// Célula livre (da parte da casa onde dá para andar) mais próxima de um ponto.
function nearestCell(nav, floor, x, y) {
  const g = nav.floors[floor];
  if (!g) return -1;
  let best = -1;
  let bestD = Infinity;
  for (let c = 0; c < g.free.length; c++) {
    if (!g.free[c] || g.comp[c] !== nav.main) continue;
    const [px, py] = cellXY(nav, c);
    const d = (px - x) * (px - x) + (py - y) * (py - y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heap[p][0] <= heap[i][0]) break;
    [heap[p], heap[i]] = [heap[i], heap[p]];
    i = p;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
      if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
      if (m === i) break;
      [heap[m], heap[i]] = [heap[i], heap[m]];
      i = m;
    }
  }
  return top;
}

// A* num andar. Passar rente à parede custa mais: o caminho cruza as portas pelo meio.
function findPath(world, nav, floor, from, to) {
  if (from === to) return [from];
  const g = nav.floors[floor];
  const { nx, ny } = nav;
  const ti = to % nx;
  const tj = (to - ti) / nx;
  const cost = new Float64Array(g.free.length).fill(Infinity);
  const prev = new Int32Array(g.free.length).fill(-1);
  const heap = [];
  cost[from] = 0;
  heapPush(heap, [0, from]);
  while (heap.length) {
    const [, cur] = heapPop(heap);
    if (cur === to) break;
    const i = cur % nx;
    const j = (cur - i) / nx;
    for (const [di, dj, len] of DIRS) {
      const i2 = i + di;
      const j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny) continue;
      const nb = j2 * nx + i2;
      if (!g.free[nb]) continue;
      if (di !== 0 && dj !== 0 && (!g.free[j * nx + i2] || !g.free[j2 * nx + i])) continue; // não corta quina
      const tight = Math.max(0, (0.5 - g.clear[nb]) / 0.5);
      const c = cost[cur] + len * NAV_CELL * (1 + 2 * tight * tight);
      if (c >= cost[nb]) continue;
      if (world.crossesWall(nav.cx(i), nav.cy(j), nav.cx(i2), nav.cy(j2), floor)) continue;
      cost[nb] = c;
      prev[nb] = cur;
      const dx = Math.abs(i2 - ti);
      const dy = Math.abs(j2 - tj);
      heapPush(heap, [c + (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * NAV_CELL, nb]);
    }
  }
  if (prev[to] < 0) return null;
  const path = [];
  for (let c = to; c >= 0; c = prev[c]) path.push(c);
  return path.reverse();
}

// O trecho reto está livre, com folga? (amostra a cada 8 cm)
function clearSegment(world, ax, ay, bx, by, floor) {
  if (world.crossesWall(ax, ay, bx, by, floor)) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.08));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (!world.isFree(ax + (bx - ax) * t, ay + (by - ay) * t, floor, GOOD_CLEAR)) return false;
  }
  return true;
}

// Troca o zigue-zague da grade por trechos retos.
function smooth(world, floor, pts) {
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    let next = i + 1;
    for (let j = Math.min(pts.length - 1, i + 80); j > i + 1; j--) {
      if (clearSegment(world, pts[i][0], pts[i][1], pts[j][0], pts[j][1], floor)) {
        next = j;
        break;
      }
    }
    out.push(pts[next]);
    i = next;
  }
  return out;
}

// Escadas a usar, em ordem, para ir de um andar a outro (busca em largura).
function stairHops(world, fromFloor, toFloor) {
  const prev = new Map([[fromFloor, null]]);
  const queue = [fromFloor];
  while (queue.length) {
    const f = queue.shift();
    if (f === toFloor) break;
    for (const s of world.stairs) {
      for (const [a, b, up] of [
        [s.fromFloor, s.toFloor, true],
        [s.toFloor, s.fromFloor, false],
      ]) {
        if (a !== f || prev.has(b)) continue;
        prev.set(b, { stair: s, up, from: a });
        queue.push(b);
      }
    }
  }
  if (!prev.has(toFloor)) return null;
  const hops = [];
  for (let f = toFloor; prev.get(f); f = prev.get(f).from) hops.push(prev.get(f));
  return hops.reverse();
}

/**
 * Caminho a pé entre dois pontos da casa, por portas e escadas.
 * @param {ReturnType<import('./world.js').createWorld>} world
 * @param {{x:number, y:number, floor:number}} from
 * @param {{x?:number, y?:number, floor:number}} to  sem x/y: basta chegar ao andar
 * @returns {{type:'move'|'stairs', x:number, y:number, floor:number}[]|null} null = não há caminho
 */
export function planRoute(world, from, to) {
  const nav = navGrid(world);
  if (!nav.floors[from.floor] || !nav.floors[to.floor]) return null;
  const steps = [];
  let at = { x: from.x, y: from.y, floor: from.floor };

  const walk = (cell) => {
    const start = nearestCell(nav, at.floor, at.x, at.y);
    if (start < 0 || cell < 0) return false;
    const path = findPath(world, nav, at.floor, start, cell);
    if (!path) return false;
    // Parte de onde a pessoa está de verdade (quase nunca é o centro de uma célula).
    const pts = [[at.x, at.y], ...path.map((c) => cellXY(nav, c))];
    for (const [x, y] of smooth(world, at.floor, pts)) {
      if (Math.hypot(x - at.x, y - at.y) < 1e-6) continue;
      steps.push({ type: 'move', x, y, floor: at.floor });
      at = { x, y, floor: at.floor };
    }
    return true;
  };

  if (to.floor !== at.floor) {
    const hops = stairHops(world, at.floor, to.floor);
    if (!hops) return null;
    for (const { stair, up } of hops) {
      const foot = up ? [stair.x, stair.y, stair.fromFloor] : [stair.x2, stair.y2, stair.toFloor];
      const head = up ? [stair.x2, stair.y2, stair.toFloor] : [stair.x, stair.y, stair.fromFloor];
      if (!walk(nearestCell(nav, foot[2], foot[0], foot[1]))) return null;
      const landing = nearestCell(nav, head[2], head[0], head[1]);
      if (landing < 0) return null;
      const [lx, ly] = cellXY(nav, landing);
      steps.push({ type: 'stairs', x: lx, y: ly, floor: head[2] });
      at = { x: lx, y: ly, floor: head[2] };
    }
  }
  if (Number.isFinite(to.x) && Number.isFinite(to.y)) {
    if (!walk(nearestCell(nav, to.floor, to.x, to.y))) return null;
  }
  return steps;
}

// ---------------------------------------------------------------------------
// A pessoa
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<import('./world.js').createWorld>} world
 * @param {{seed?:number, mode?:'auto'|'still'|'manual', t?:number}} [options]  t = instante inicial (s)
 */
export function createWalker(world, options = {}) {
  const seed = options.seed ?? 1;
  const rng = createRng('walker', world.key ?? world.seed, seed);
  let mode = WALK_MODES.includes(options.mode) ? options.mode : 'auto';
  let lap = 0;
  // Cada pessoa tem o seu passo; ele ainda varia um pouco de trecho em trecho.
  const pace = rng.float(0.6, 0.8);

  const tour = (k) => planWalk(world, { kind: 'tour', seed: seed * 1009 + k });
  const point = (x, y, floor) => ({ x, y, z: floor * FLOOR_HEIGHT + PHONE_HEIGHT, floor });

  // O primeiro roteiro também diz onde a pessoa começa (o meio do primeiro cômodo).
  let nextTour = tour(0);
  const t0 = options.t ?? 0;
  const start = point(nextTour.start.x, nextTour.start.y, nextTour.start.floor);
  /** Linha do tempo: trechos {kind, t0, t1, a, b, heading}, sem buracos. */
  let segs = [{ kind: 'hold', t0, t1: t0, a: start, b: start, heading: rng.float(0, 2 * Math.PI) }];
  /** Passos já decididos que ainda não viraram trecho. */
  let queue = [];

  const last = () => segs[segs.length - 1];

  function pushHold(dur, heading) {
    const l = last();
    segs.push({ kind: 'hold', t0: l.t1, t1: l.t1 + dur, a: l.b, b: l.b, heading: heading ?? l.heading });
  }

  function pushStep(step) {
    const l = last();
    const a = l.b;
    if (step.type === 'hold') {
      pushHold(step.dur, step.look ? rng.float(0, 2 * Math.PI) : l.heading);
      return;
    }
    const run = Math.hypot(step.x - a.x, step.y - a.y);
    const heading = run > 1e-6 ? Math.atan2(step.y - a.y, step.x - a.x) : l.heading;
    if (step.type === 'stairs') {
      // Escada: devagar, e nunca em menos de 6 s.
      const dur = Math.max(6, Math.hypot(run, FLOOR_HEIGHT) / 0.45) * rng.float(0.9, 1.2);
      segs.push({ kind: 'stairs', t0: l.t1, t1: l.t1 + dur, a, b: point(step.x, step.y, step.floor), heading });
      return;
    }
    if (run < 1e-6) return;
    const v = step.speed ?? pace * rng.float(0.85, 1.15);
    segs.push({ kind: 'move', t0: l.t1, t1: l.t1 + run / v, a, b: point(step.x, step.y, a.floor), heading });
  }

  // Enfileira a próxima volta pela casa (voltando antes ao ponto de partida, se preciso).
  function queueTour() {
    const plan = nextTour || tour(lap);
    nextTour = null;
    lap += 1;
    const here = last().b;
    if (here.floor !== plan.start.floor || Math.hypot(here.x - plan.start.x, here.y - plan.start.y) > 0.05) {
      const back = planRoute(world, here, plan.start);
      if (back) queue.push(...back);
      else segs.push({ kind: 'hold', t0: last().t1, t1: last().t1, a: start, b: start, heading: last().heading }); // sem caminho: reaparece no começo
    }
    const stops = new Set(plan.waypoints.map((w) => `${w.x}|${w.y}|${w.floor}`));
    for (const s of plan.steps) {
      if (s.type !== 'move' && s.type !== 'stairs') continue;
      queue.push({ type: s.type, x: s.x, y: s.y, floor: s.floor });
      // Em parte dos destinos a pessoa para e olha em volta.
      if (s.type === 'move' && stops.has(`${s.x}|${s.y}|${s.floor}`) && rng.chance(0.35)) {
        queue.push({ type: 'hold', dur: rng.float(2, 6), look: true });
      }
    }
    queue.push({ type: 'hold', dur: rng.float(4, 9), look: true }); // respiro entre uma volta e outra
  }

  // Garante que a linha do tempo chega até o instante t.
  function extend(t) {
    let guard = 0;
    while (last().t1 < t && guard++ < 100000) {
      if (queue.length) pushStep(queue.shift());
      else if (mode === 'auto') queueTour();
      else pushHold(Infinity); // parada até segunda ordem
    }
    while (segs.length > 1 && segs[0].t1 < t - KEEP_S) segs.shift();
  }

  function segAt(t) {
    for (let i = segs.length - 1; i > 0; i--) if (segs[i].t0 <= t) return segs[i];
    return segs[0];
  }

  function interpolate(s, t) {
    const span = s.t1 - s.t0;
    const u = span > 0 && Number.isFinite(span) ? Math.min(1, Math.max(0, (t - s.t0) / span)) : t >= s.t1 ? 1 : 0;
    const z = s.a.z + (s.b.z - s.a.z) * u;
    return {
      x: s.a.x + (s.b.x - s.a.x) * u,
      y: s.a.y + (s.b.y - s.a.y) * u,
      z,
      floor: Math.max(0, Math.min(world.floors - 1, Math.floor(z / FLOOR_HEIGHT))),
      heading: s.heading,
      moving: s.kind !== 'hold' && t < s.t1,
    };
  }

  /**
   * Onde a pessoa está (ou estava) no instante t.
   * @returns {{x:number, y:number, z:number, floor:number, heading:number, moving:boolean}}
   */
  function posAt(t) {
    extend(t);
    return interpolate(segAt(t), t);
  }

  // Corta a linha do tempo em t: o que vinha depois deixa de valer. Quem está no meio
  // da escada termina de subir (ou descer) antes de obedecer, a não ser com `hard`.
  function cut(t, hard = false) {
    extend(t);
    const s = segAt(t);
    const keep = segs.indexOf(s);
    segs.length = keep + 1;
    queue = [];
    if (s.kind === 'stairs' && !hard && t < s.t1) return;
    if (t < s.t1) {
      const p = interpolate(s, t);
      s.b = { x: p.x, y: p.y, z: p.z, floor: p.floor };
      s.t1 = Math.max(s.t0, t);
    }
  }

  // De onde um caminho novo partiria se fosse pedido agora (sem mexer em nada).
  function anchor(t) {
    extend(t);
    const s = segAt(t);
    if (s.kind === 'stairs' && t < s.t1) return s.b;
    return interpolate(s, t);
  }

  function follow(route, t) {
    cut(t);
    mode = 'manual';
    queue = route.map((s) => ({ ...s, speed: MANUAL_SPEED }));
  }

  return {
    get mode() {
      return mode;
    },
    posAt,

    /** Estado completo num instante: posição, cômodo, para onde olha, se está andando. */
    stateAt(t) {
      const p = posAt(t);
      const room = world.roomAt(p.x, p.y, p.floor);
      return { ...p, room: room ? room.name : null, mode };
    },

    /** Troca o modo a partir do instante t. */
    setMode(next, t) {
      if (!WALK_MODES.includes(next) || next === mode) return;
      cut(t);
      mode = next;
    },

    /**
     * Anda até (x, y) — do mesmo andar ou de outro — e fica lá. Passa ao modo manual.
     * @returns {boolean} false quando não há caminho (aí nada muda)
     */
    goTo(x, y, floor, t) {
      const here = anchor(t);
      const target = { x, y, floor: Number.isInteger(floor) ? floor : here.floor };
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      const route = planRoute(world, here, target);
      if (!route) return false;
      follow(route, t);
      return true;
    },

    /** Sobe ou desce até o andar pedido e para no fim da escada. */
    setFloor(floor, t) {
      if (!Number.isInteger(floor) || floor < 0 || floor >= world.floors) return false;
      const here = anchor(t);
      if (here.floor === floor) return true;
      const route = planRoute(world, here, { floor });
      if (!route) return false;
      follow(route, t);
      return true;
    },

    /** Põe a pessoa num ponto, sem andar (para testes e para "comece daqui"). Fica parada. */
    teleport(x, y, floor, t) {
      const here = anchor(t);
      const f = Number.isInteger(floor) && floor >= 0 && floor < world.floors ? floor : here.floor;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      const nav = navGrid(world);
      let px = x;
      let py = y;
      if (!world.isFree(x, y, f, 0.15)) {
        const c = nearestCell(nav, f, x, y);
        if (c < 0) return false;
        [px, py] = cellXY(nav, c);
      }
      cut(t, true);
      mode = 'still';
      const l = last();
      const p = point(px, py, f);
      segs.push({ kind: 'hold', t0: l.t1, t1: l.t1, a: p, b: p, heading: l.heading });
      return true;
    },

    /** Quantos trechos estão guardados (para conferir que a memória não cresce). */
    size: () => segs.length + queue.length,
  };
}
