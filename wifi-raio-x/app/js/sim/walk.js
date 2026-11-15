// Caminhada simulada: planeja por onde o usuário anda (respeitando paredes e portas)
// e gera o levantamento (Survey) que o app gravaria — mais a verdade, à parte, para
// a bancada medir o erro do mapa.

import { FLOOR_HEIGHT } from '../mapping/types.js';
import { createRng } from './prng.js';
import { PHONE_HEIGHT } from './world.js';

/** Tamanho da célula da grade de navegação (m). */
export const NAV_CELL = 0.25;
// Folga mínima até a parede para uma célula ser "pisável" e folga preferida ao cortar caminho.
const MIN_CLEAR = 0.15;
const GOOD_CLEAR = 0.3;

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
// Grade de navegação
// ---------------------------------------------------------------------------

const navCache = new WeakMap();

/**
 * Grade de células livres de cada andar, com as ligações permitidas entre vizinhas.
 * Fica guardada junto do mundo: montar custa alguns milissegundos.
 */
export function navGrid(world) {
  let nav = navCache.get(world);
  if (nav) return nav;
  const { minX, minY, width, height } = world.bounds;
  const nx = Math.max(1, Math.ceil(width / NAV_CELL));
  const ny = Math.max(1, Math.ceil(height / NAV_CELL));
  const cx = (i) => minX + (i + 0.5) * NAV_CELL;
  const cy = (j) => minY + (j + 0.5) * NAV_CELL;
  const floors = [];
  for (let f = 0; f < world.floors; f++) {
    const free = new Uint8Array(nx * ny);
    const clear = new Float32Array(nx * ny);
    const room = new Int16Array(nx * ny).fill(-1);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (!world.isFree(cx(i), cy(j), f, MIN_CLEAR)) continue;
        free[c] = 1;
        clear[c] = world.wallDistance(cx(i), cy(j), f);
        const r = world.roomAt(cx(i), cy(j), f);
        room[c] = r ? r.index : -1;
      }
    }
    // Ligações: as duas células livres, sem cortar quina e sem parede no meio.
    const adj = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (!free[c]) continue;
        for (let d = 0; d < 8; d++) {
          const i2 = i + DIRS[d][0];
          const j2 = j + DIRS[d][1];
          if (i2 < 0 || j2 < 0 || i2 >= nx || j2 >= ny || !free[j2 * nx + i2]) continue;
          if (d % 2 === 1 && (!free[j * nx + i2] || !free[j2 * nx + i])) continue;
          if (world.crossesWall(cx(i), cy(j), cx(i2), cy(j2), f)) continue;
          adj[c] |= 1 << d;
        }
      }
    }
    floors.push({ free, clear, room, adj, comp: new Int32Array(nx * ny).fill(-1) });
  }

  nav = { nx, ny, cx, cy, floors, main: -1 };
  labelComponents(world, nav);
  navCache.set(world, nav);
  return nav;
}

// Marca as regiões ligadas entre si (as escadas juntam os andares) e escolhe a maior:
// só nela o usuário anda.
function labelComponents(world, nav) {
  const { nx, ny } = nav;
  const size = nx * ny;
  let count = 0;
  const sizes = [];
  for (let f = 0; f < nav.floors.length; f++) {
    const g = nav.floors[f];
    for (let c = 0; c < size; c++) {
      if (!g.free[c] || g.comp[c] >= 0) continue;
      let n = 0;
      const queue = [c];
      g.comp[c] = count;
      while (queue.length) {
        const cur = queue.pop();
        n++;
        const i = cur % nx;
        const j = (cur - i) / nx;
        for (let d = 0; d < 8; d++) {
          if (!(g.adj[cur] & (1 << d))) continue;
          const nb = (j + DIRS[d][1]) * nx + i + DIRS[d][0];
          if (g.comp[nb] < 0) {
            g.comp[nb] = count;
            queue.push(nb);
          }
        }
      }
      sizes.push(n);
      count++;
    }
  }
  // Une as regiões que as escadas ligam.
  const parent = sizes.map((_, i) => i);
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  for (const s of world.stairs) {
    const a = nearestCell(nav, s.fromFloor, s.x, s.y, null, false);
    const b = nearestCell(nav, s.toFloor, s.x2, s.y2, null, false);
    if (a < 0 || b < 0) continue;
    const ra = find(nav.floors[s.fromFloor].comp[a]);
    const rb = find(nav.floors[s.toFloor].comp[b]);
    if (ra !== rb) {
      parent[rb] = ra;
      sizes[ra] += sizes[rb];
    }
  }
  let best = -1;
  for (let i = 0; i < sizes.length; i++) if (find(i) === i && (best < 0 || sizes[i] > sizes[best])) best = i;
  for (const g of nav.floors) for (let c = 0; c < size; c++) if (g.comp[c] >= 0) g.comp[c] = find(g.comp[c]) === best ? 1 : 0;
  nav.main = 1;
}

// Célula livre mais próxima de um ponto (opcionalmente dentro de um cômodo).
function nearestCell(nav, floor, x, y, roomIndex = null, onlyMain = true) {
  const g = nav.floors[floor];
  if (!g) return -1;
  const { nx, ny } = nav;
  const i0 = Math.floor((x - nav.cx(0)) / NAV_CELL + 0.5);
  const j0 = Math.floor((y - nav.cy(0)) / NAV_CELL + 0.5);
  let best = -1;
  let bestD = Infinity;
  const maxR = Math.max(nx, ny);
  for (let r = 0; r <= maxR; r++) {
    if (best >= 0 && (r - 1) * NAV_CELL > bestD) break;
    for (let j = j0 - r; j <= j0 + r; j++) {
      if (j < 0 || j >= ny) continue;
      const edge = j === j0 - r || j === j0 + r;
      for (let i = i0 - r; i <= i0 + r; i += edge ? 1 : 2 * r || 1) {
        if (i < 0 || i >= nx) continue;
        const c = j * nx + i;
        if (!g.free[c]) continue;
        if (onlyMain && g.comp[c] !== nav.main) continue;
        if (roomIndex !== null && g.room[c] !== roomIndex) continue;
        const d = Math.hypot(nav.cx(i) - x, nav.cy(j) - y);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
  }
  return best;
}

// Fila de prioridade mínima (heap binário) para o A*.
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

// A* na grade de um andar. Andar rente à parede custa mais: o caminho passa pelo
// meio das portas, como uma pessoa faria.
function findPath(nav, floor, from, to) {
  if (from === to) return [from];
  const g = nav.floors[floor];
  const { nx } = nav;
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
    for (let d = 0; d < 8; d++) {
      if (!(g.adj[cur] & (1 << d))) continue;
      const i2 = i + DIRS[d][0];
      const j2 = j + DIRS[d][1];
      const nb = j2 * nx + i2;
      const tight = Math.max(0, (0.5 - g.clear[nb]) / 0.5);
      const c = cost[cur] + DIRS[d][2] * NAV_CELL * (1 + 2 * tight * tight);
      if (c < cost[nb]) {
        cost[nb] = c;
        prev[nb] = cur;
        const dx = Math.abs(i2 - ti);
        const dy = Math.abs(j2 - tj);
        const h = (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * NAV_CELL;
        heapPush(heap, [c + h, nb]);
      }
    }
  }
  if (prev[to] < 0) return null;
  const path = [];
  for (let c = to; c >= 0; c = prev[c]) path.push(c);
  return path.reverse();
}

// O trecho reto está livre, com folga? (amostra a cada 8 cm)
function clearSegment(world, ax, ay, bx, by, floor, clearance) {
  if (world.crossesWall(ax, ay, bx, by, floor)) return false;
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(len / 0.08));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (!world.isFree(ax + (bx - ax) * t, ay + (by - ay) * t, floor, clearance)) return false;
  }
  return true;
}

// Troca o zigue-zague da grade por trechos retos (sempre conferindo as paredes).
function smoothPath(world, nav, floor, cells) {
  const pts = cells.map((c) => {
    const i = c % nav.nx;
    return [nav.cx(i), nav.cy((c - i) / nav.nx)];
  });
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let next = i + 1;
    for (let j = Math.min(pts.length - 1, i + 80); j > i + 1; j--) {
      if (clearSegment(world, pts[i][0], pts[i][1], pts[j][0], pts[j][1], floor, GOOD_CLEAR)) {
        next = j;
        break;
      }
    }
    out.push(pts[next]);
    i = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planejamento
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WalkStep
 * @property {'move'|'stairs'|'spot'} type
 *           move: anda em linha reta até (x, y) no mesmo andar;
 *           stairs: sobe ou desce a escada até (x, y) no andar `floor`;
 *           spot: fica parado aqui e marca o ponto `spot`
 * @property {number} x
 * @property {number} y
 * @property {number} floor
 * @property {number} [spot]   id do ponto marcado (repetido quando o usuário volta ao mesmo lugar)
 * @property {string} [room]   cômodo onde o ponto fica
 */

/**
 * @typedef {Object} WalkPlan
 * @property {'tour'|'perimeter'|'spots'} kind
 * @property {{x:number, y:number, floor:number}} start
 * @property {WalkStep[]} steps
 * @property {{x:number, y:number, floor:number, room:string|null, spot?:number}[]} waypoints  destinos, em ordem
 * @property {number} lengthM   distância andada
 */

/**
 * Planeja a caminhada do levantamento.
 *
 * - 'tour': visita todos os cômodos (centro e mais alguns pontos), passa pelas portas, e
 *   repete voltas até completar `minLengthM`, sempre voltando ao começo (fecha o circuito);
 * - 'perimeter': contorna cada cômodo a meio metro da parede e segue para o próximo;
 * - 'spots': para em 2 a 4 pontos por cômodo (ou `count` no total) e marca cada um.
 *
 * @param {ReturnType<import('./world.js').createWorld>} world
 * @param {Object} [options]
 * @param {'tour'|'perimeter'|'spots'} [options.kind]
 * @param {number} [options.seed]
 * @param {number[]} [options.floorOrder]  ordem dos andares (padrão: 0, 1, ...)
 * @param {number} [options.minLengthM]    tour/perimeter: repete voltas até andar pelo menos isto
 * @param {number} [options.count]         spots: total de pontos (padrão: 2 a 4 por cômodo)
 * @param {number} [options.revisits]      spots: quantos pontos antigos o usuário revisita no fim (padrão 1)
 * @returns {WalkPlan}
 */
export function planWalk(world, options = {}) {
  const kind = options.kind || 'tour';
  const rng = createRng('walk', world.seed, options.seed ?? 1, kind);
  const nav = navGrid(world);
  const floorOrder = (options.floorOrder || Array.from({ length: world.floors }, (_, k) => k)).filter((f) => f >= 0 && f < world.floors);

  const cellXY = (c) => {
    const i = c % nav.nx;
    return [nav.cx(i), nav.cy((c - i) / nav.nx)];
  };
  // Células em que dá para parar, por cômodo (longe da parede quando possível).
  const roomCells = new Map();
  for (const r of world.rooms) {
    const g = nav.floors[r.floor];
    const good = [];
    const any = [];
    for (let c = 0; c < g.free.length; c++) {
      if (g.room[c] !== r.index || g.comp[c] !== nav.main) continue;
      any.push(c);
      if (g.clear[c] >= 0.4) good.push(c);
    }
    roomCells.set(r.index, good.length >= 4 ? good : any);
  }
  const reachable = (r) => roomCells.get(r.index).length > 0;

  // Começo: centro do primeiro cômodo do primeiro andar.
  const firstRoom = world.rooms.find((r) => r.floor === floorOrder[0] && reachable(r));
  if (!firstRoom) throw new Error('mundo sem cômodo alcançável');
  const centerCell = (r) => nearestCell(nav, r.floor, r.centroid.x, r.centroid.y, r.index);
  const startCell = centerCell(firstRoom);
  const [sx, sy] = cellXY(startCell);

  const plan = { kind, start: { x: sx, y: sy, floor: firstRoom.floor }, steps: [], waypoints: [], lengthM: 0 };
  const at = { x: sx, y: sy, floor: firstRoom.floor, cell: startCell };

  // Sequência de escadas para ir de um andar a outro.
  function stairRoute(fromFloor, toFloor) {
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

  function walkTo(cell, floor) {
    const path = findPath(nav, floor, at.cell, cell);
    if (!path) throw new Error('sem caminho entre dois pontos do mesmo andar');
    const pts = smoothPath(world, nav, floor, path);
    for (let k = 1; k < pts.length; k++) {
      plan.steps.push({ type: 'move', x: pts[k][0], y: pts[k][1], floor });
      plan.lengthM += Math.hypot(pts[k][0] - at.x, pts[k][1] - at.y);
      at.x = pts[k][0];
      at.y = pts[k][1];
    }
    at.cell = cell;
  }

  // Vai até uma célula de qualquer andar, usando as escadas quando precisa.
  function goTo(cell, floor) {
    if (floor !== at.floor) {
      const hops = stairRoute(at.floor, floor);
      if (!hops) throw new Error(`não há escada entre os andares ${at.floor} e ${floor}`);
      for (const { stair, up } of hops) {
        const foot = up ? [stair.x, stair.y, stair.fromFloor] : [stair.x2, stair.y2, stair.toFloor];
        const head = up ? [stair.x2, stair.y2, stair.toFloor] : [stair.x, stair.y, stair.fromFloor];
        walkTo(nearestCell(nav, foot[2], foot[0], foot[1]), foot[2]);
        const landing = nearestCell(nav, head[2], head[0], head[1]);
        const [lx, ly] = cellXY(landing);
        plan.steps.push({ type: 'stairs', x: lx, y: ly, floor: head[2] });
        plan.lengthM += Math.hypot(lx - at.x, ly - at.y, FLOOR_HEIGHT);
        at.x = lx;
        at.y = ly;
        at.floor = head[2];
        at.cell = landing;
      }
    }
    walkTo(cell, floor);
  }

  function visit(cell, room, extra = {}) {
    goTo(cell, room.floor);
    plan.waypoints.push({ x: at.x, y: at.y, floor: room.floor, room: room.name, ...extra });
  }

  // Próximo cômodo ainda não visitado: o mais perto andando (busca em largura a partir daqui).
  function nearestRoom(floor, pending) {
    if (at.floor !== floor) {
      // Acabou de mudar de andar na cabeça do usuário: começa pelo cômodo da chegada da escada.
      const hops = stairRoute(at.floor, floor);
      const last = hops && hops[hops.length - 1];
      if (last) {
        const hx = last.up ? last.stair.x2 : last.stair.x;
        const hy = last.up ? last.stair.y2 : last.stair.y;
        const r = world.roomAt(hx, hy, floor);
        if (r && pending.has(r.index)) return r;
        let best = null;
        let bestD = Infinity;
        for (const idx of pending) {
          const room = world.rooms[idx];
          const d = Math.hypot(room.centroid.x - hx, room.centroid.y - hy);
          if (d < bestD) {
            bestD = d;
            best = room;
          }
        }
        return best;
      }
    }
    const g = nav.floors[floor];
    const seen = new Uint8Array(g.free.length);
    const queue = [at.cell];
    seen[at.cell] = 1;
    for (let q = 0; q < queue.length; q++) {
      const cur = queue[q];
      if (pending.has(g.room[cur])) return world.rooms[g.room[cur]];
      const i = cur % nav.nx;
      const j = (cur - i) / nav.nx;
      for (let d = 0; d < 8; d++) {
        if (!(g.adj[cur] & (1 << d))) continue;
        const nb = (j + DIRS[d][1]) * nav.nx + i + DIRS[d][0];
        if (!seen[nb]) {
          seen[nb] = 1;
          queue.push(nb);
        }
      }
    }
    return world.rooms[[...pending][0]];
  }

  // Percorre os cômodos de todos os andares na ordem natural de quem anda pela casa.
  function forEachRoom(fn) {
    for (const floor of floorOrder) {
      const pending = new Set(world.rooms.filter((r) => r.floor === floor && reachable(r)).map((r) => r.index));
      while (pending.size) {
        const room = nearestRoom(floor, pending);
        pending.delete(room.index);
        fn(room);
      }
    }
  }

  // Pontos bem espalhados dentro de um cômodo (o melhor de alguns candidatos sorteados).
  function spread(room, n, taken = []) {
    const cells = roomCells.get(room.index);
    const chosen = [];
    for (let k = 0; k < n; k++) {
      let best = -1;
      let bestD = -1;
      for (let tries = 0; tries < 14; tries++) {
        const c = rng.pick(cells);
        const [x, y] = cellXY(c);
        let d = Infinity;
        for (const o of [...taken, ...chosen]) d = Math.min(d, Math.hypot(o[0] - x, o[1] - y));
        if (d > bestD) {
          bestD = d;
          best = c;
        }
      }
      chosen.push([...cellXY(best), best]);
    }
    return chosen;
  }

  // Ordena pontos pelo vizinho mais próximo, a partir de onde o usuário está.
  function byNearest(points) {
    const rest = points.slice();
    const out = [];
    let x = at.x;
    let y = at.y;
    while (rest.length) {
      let bi = 0;
      for (let i = 1; i < rest.length; i++) {
        if (Math.hypot(rest[i][0] - x, rest[i][1] - y) < Math.hypot(rest[bi][0] - x, rest[bi][1] - y)) bi = i;
      }
      const [p] = rest.splice(bi, 1);
      out.push(p);
      x = p[0];
      y = p[1];
    }
    return out;
  }

  const minLength = options.minLengthM ?? 0;
  // A primeira volta passa por todos os cômodos; as seguintes param assim que a meta é atingida.
  const enough = (lap) => lap > 0 && plan.lengthM >= minLength;

  if (kind === 'tour') {
    for (let lap = 0; lap < 40; lap++) {
      forEachRoom((room) => {
        if (enough(lap)) return;
        const extra = Math.max(1, Math.min(6, Math.round(room.area / 10) + (rng.chance(0.5) ? 1 : 0)));
        const pts = spread(room, extra);
        if (lap === 0) pts.unshift([...cellXY(centerCell(room)), centerCell(room)]);
        for (const p of byNearest(pts)) visit(p[2], room);
      });
      // Fecha o circuito: volta ao ponto de partida.
      visit(startCell, firstRoom);
      if (plan.lengthM >= minLength) break;
    }
  } else if (kind === 'perimeter') {
    for (let lap = 0; lap < 40; lap++) {
      // Cada volta contorna um pouco mais para dentro: cobre melhor o miolo dos cômodos.
      const inset = 0.5 + 0.45 * (lap % 3);
      forEachRoom((room) => {
        if (enough(lap)) return;
        const ring = insetPolygon(room.polygon, inset);
        const cells = [];
        for (const [x, y] of ring) {
          const c = nearestCell(nav, room.floor, x, y, room.index);
          if (c >= 0 && cells[cells.length - 1] !== c) cells.push(c);
        }
        if (!cells.length) return;
        // Começa pelo canto mais perto e dá a volta inteira (sentido sorteado).
        let first = 0;
        for (let i = 1; i < cells.length; i++) {
          const [x, y] = cellXY(cells[i]);
          const [bx, by] = cellXY(cells[first]);
          if (Math.hypot(x - at.x, y - at.y) < Math.hypot(bx - at.x, by - at.y)) first = i;
        }
        const dir = rng.chance(0.5) ? 1 : -1;
        for (let k = 0; k <= cells.length; k++) {
          const c = cells[(((first + dir * k) % cells.length) + cells.length) % cells.length];
          visit(c, room);
        }
      });
      visit(startCell, firstRoom);
      if (plan.lengthM >= minLength) break;
    }
  } else if (kind === 'spots') {
    const rooms = world.rooms.filter(reachable);
    // Quantos pontos por cômodo: 2 a 4 conforme o tamanho, ou a divisão de `count` pela área.
    const quota = new Map();
    if (options.count) {
      const total = rooms.reduce((s, r) => s + r.area, 0);
      let left = options.count;
      const minEach = options.count >= 2 * rooms.length ? 2 : 1;
      for (const r of rooms) {
        quota.set(r.index, minEach);
        left -= minEach;
      }
      const shares = rooms.map((r) => ({ r, want: (r.area / total) * options.count - minEach }));
      while (left > 0) {
        shares.sort((p, q) => q.want - p.want);
        quota.set(shares[0].r.index, quota.get(shares[0].r.index) + 1);
        shares[0].want -= 1;
        left--;
      }
    } else {
      for (const r of rooms) quota.set(r.index, Math.max(2, Math.min(4, Math.round(r.area / 6))));
    }
    let spotId = 0;
    const marked = [];
    forEachRoom((room) => {
      const pts = byNearest(spread(room, quota.get(room.index)));
      for (const p of pts) {
        visit(p[2], room, { spot: spotId });
        plan.steps.push({ type: 'spot', x: at.x, y: at.y, floor: room.floor, spot: spotId, room: room.name });
        marked.push({ cell: p[2], room, spot: spotId });
        spotId++;
      }
    });
    // "Voltei ao ponto X": o usuário revisita pontos antigos (começando pelo primeiro) e
    // marca de novo com o mesmo id. É o fechamento de circuito deste modo.
    const revisits = Math.min(options.revisits ?? 1, marked.length);
    const again = [marked[0], ...rng.shuffle(marked.slice(1, Math.max(1, marked.length - 3)))].slice(0, revisits);
    for (const m of again) {
      // Ninguém para exatamente no mesmo lugar: até um passo de diferença.
      const near = nearestCell(
        nav,
        m.room.floor,
        cellXY(m.cell)[0] + rng.float(-0.3, 0.3),
        cellXY(m.cell)[1] + rng.float(-0.3, 0.3),
        m.room.index,
      );
      visit(near >= 0 ? near : m.cell, m.room, { spot: m.spot });
      plan.steps.push({ type: 'spot', x: at.x, y: at.y, floor: m.room.floor, spot: m.spot, room: m.room.name });
    }
  } else {
    throw new Error(`tipo de caminhada desconhecido: ${kind}`);
  }

  plan.lengthM = Math.round(plan.lengthM * 100) / 100;
  return plan;
}

// Encolhe um polígono para dentro (cantos em esquadria ou não).
function insetPolygon(poly, dist) {
  let area = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    area += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    minX = Math.min(minX, poly[i][0]);
    maxX = Math.max(maxX, poly[i][0]);
    minY = Math.min(minY, poly[i][1]);
    maxY = Math.max(maxY, poly[i][1]);
  }
  const sign = area > 0 ? 1 : -1; // anti-horário: a normal para dentro fica à esquerda
  const d = Math.min(dist, 0.3 * Math.min(maxX - minX, maxY - minY));
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[(i + poly.length - 1) % poly.length];
    const c = poly[i];
    const n = poly[(i + 1) % poly.length];
    const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1;
    const l2 = Math.hypot(n[0] - c[0], n[1] - c[1]) || 1;
    const n1 = [(-(c[1] - p[1]) / l1) * sign, ((c[0] - p[0]) / l1) * sign];
    const n2 = [(-(n[1] - c[1]) / l2) * sign, ((n[0] - c[0]) / l2) * sign];
    const k = d / Math.max(0.3, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
    out.push([c[0] + (n1[0] + n2[0]) * k, c[1] + (n1[1] + n2[1]) * k]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Levantamento simulado
// ---------------------------------------------------------------------------

/**
 * Simula o usuário fazendo a caminhada com o app gravando.
 *
 * @param {ReturnType<import('./world.js').createWorld>} world
 * @param {WalkPlan} plan
 * @param {Object} [options]
 * @param {number} [options.scanIntervalS]  3.5 = limite de varreduras desligado; 30 = limite padrão do Android
 * @param {number|number[]} [options.speed] passo do usuário em m/s, ou faixa [mín, máx] (padrão 0.4 a 0.9)
 * @param {number} [options.stillScans]     varreduras feitas em cada ponto marcado (padrão 3; com limite, 1)
 * @param {boolean} [options.track]         grava o sinal da rede conectada a cada 2 s (padrão true)
 * @param {number} [options.labelRate]      fração dos pontos marcados que o usuário batiza com o nome do cômodo
 * @param {number} [options.seed]
 * @returns {{survey: import('../mapping/types.js').Survey, truth: Object}}
 *          `truth` nunca entra no solucionador: posição real de cada varredura (no meio da varredura),
 *          posição real dos roteadores e o próprio mundo.
 */
export function simulateSurvey(world, plan, options = {}) {
  const interval = Math.max(3, options.scanIntervalS ?? 3.5);
  const stillScans = Math.max(1, options.stillScans ?? (interval > 10 ? 1 : 3));
  const rng = createRng('survey', world.seed, options.seed ?? 1, plan.kind, interval);
  const speedRange = Array.isArray(options.speed) ? options.speed : options.speed ? [options.speed, options.speed] : [0.4, 0.9];
  const labelRate = options.labelRate ?? 0.8;

  // Horário de entrega das varreduras: relógio próprio, independente de onde o usuário está.
  const scanTimes = [rng.float(3.0, 3.6)];
  const scanTime = (k) => {
    while (scanTimes.length <= k) scanTimes.push(scanTimes[scanTimes.length - 1] + interval + rng.float(-0.1, 0.1));
    return scanTimes[k];
  };

  // --- movimento: lista de trechos [t0, t1] com posição inicial e final ---
  // Cada pessoa tem o seu passo (no miolo da faixa); ele ainda varia de trecho em trecho.
  const pace = rng.float(speedRange[0] + 0.25 * (speedRange[1] - speedRange[0]), speedRange[1] - 0.25 * (speedRange[1] - speedRange[0]));
  const segs = [];
  const stills = []; // {t0, t1, spot, label}
  const floorMarks = []; // {t, floor}: quando o usuário avisou o app que mudou de andar
  let t = 0;
  let cur = { x: plan.start.x, y: plan.start.y, z: plan.start.floor * FLOOR_HEIGHT + PHONE_HEIGHT, floor: plan.start.floor };
  let heading = rng.float(0, 2 * Math.PI);
  let nextScan = 0;
  const labelOf = new Map(); // spot -> nome dado pelo usuário (ou null)

  const hold = (dur, h = heading) => {
    segs.push({ t0: t, t1: t + dur, a: cur, b: cur, heading: h });
    t += dur;
  };
  hold(rng.float(1.5, 3)); // o usuário aperta "começar" e sai andando

  for (const step of plan.steps) {
    if (step.type === 'move') {
      const len = Math.hypot(step.x - cur.x, step.y - cur.y);
      if (len < 1e-6) continue;
      const v = Math.max(speedRange[0], Math.min(speedRange[1], pace * rng.float(0.8, 1.2)));
      heading = Math.atan2(step.y - cur.y, step.x - cur.x);
      const next = { x: step.x, y: step.y, z: cur.z, floor: cur.floor };
      segs.push({ t0: t, t1: t + len / v, a: cur, b: next, heading });
      t += len / v;
      cur = next;
      if (rng.chance(0.06)) hold(rng.float(1.5, 5)); // parada para olhar a tela
    } else if (step.type === 'stairs') {
      const run = Math.hypot(step.x - cur.x, step.y - cur.y);
      const dur = Math.max(6, Math.hypot(run, FLOOR_HEIGHT) / 0.45) * rng.float(0.9, 1.2);
      if (run > 1e-6) heading = Math.atan2(step.y - cur.y, step.x - cur.x);
      const next = { x: step.x, y: step.y, z: step.floor * FLOOR_HEIGHT + PHONE_HEIGHT, floor: step.floor };
      segs.push({ t0: t, t1: t + dur, a: cur, b: next, heading });
      // O usuário toca em "subi/desci um andar" mais ou menos no meio da escada.
      floorMarks.push({ t: t + dur * rng.float(0.35, 0.95), floor: step.floor });
      t += dur;
      cur = next;
    } else if (step.type === 'spot') {
      // Para, vira para um lado qualquer e espera as varreduras deste ponto.
      const h = rng.float(0, 2 * Math.PI);
      const ready = t + rng.float(0.4, 1.2);
      while (world.sweepWindow(scanTime(nextScan)).start < ready) nextScan++;
      const last = nextScan + stillScans - 1;
      const leave = scanTime(last) + rng.float(0.3, 1.0);
      if (!labelOf.has(step.spot)) labelOf.set(step.spot, rng.chance(labelRate) ? step.room : null);
      // Só vale como "parado" a partir do toque em "marcar ponto".
      stills.push({ t0: ready, t1: leave, spot: step.spot, label: labelOf.get(step.spot) });
      hold(leave - t, h);
      nextScan = last + 1;
    }
  }
  // No fim de uma caminhada o usuário espera a varredura em curso terminar antes de parar a gravação.
  hold(plan.kind === 'spots' ? 0.5 : Math.min(interval, 3.5) + 0.5);
  const endT = t;

  // Posição do usuário num instante qualquer.
  let cursor = 0;
  function posAt(time) {
    if (time <= 0) time = 0;
    if (time >= endT) time = endT;
    if (segs[cursor].t0 > time) cursor = 0;
    while (cursor < segs.length - 1 && segs[cursor].t1 < time) cursor++;
    const s = segs[cursor];
    const u = s.t1 > s.t0 ? Math.min(1, Math.max(0, (time - s.t0) / (s.t1 - s.t0))) : 0;
    return {
      x: s.a.x + (s.b.x - s.a.x) * u,
      y: s.a.y + (s.b.y - s.a.y) * u,
      z: s.a.z + (s.b.z - s.a.z) * u,
      heading: s.heading,
    };
  }
  const markedFloor = (time) => {
    let f = plan.start.floor;
    for (const m of floorMarks) if (m.t <= time) f = m.floor;
    return f;
  };

  // --- varreduras ---
  const scans = [];
  const points = [];
  const truthFloors = [];
  const truthRooms = [];
  const truthTimes = [];
  const meta = {};
  const deviceIds = new Map();
  let prev = null;
  for (let k = 0; scanTime(k) <= endT; k++) {
    const tk = scanTime(k);
    const win = world.sweepWindow(tk);
    const mid = posAt(win.mid);
    const aps = world.scan({ ...mid, t: tk, prev, path: posAt });
    prev = { t: tk, aps };

    const still = stills.find((s) => win.start >= s.t0 && tk <= s.t1) || null;
    const scan = {
      t: round(tk, 3),
      floor: markedFloor(tk) - plan.start.floor,
      still: !!still,
      spot: still ? still.spot : null,
      // Do mais forte para o mais fraco, como o app guarda (a ordem não revela nada do mundo).
      readings: aps
        .map((a) => ({ id: a.bssid, rssi: a.level, freq: a.frequency, ageMs: a.ageMs }))
        .sort((p, q) => q.rssi - p.rssi || (p.id < q.id ? -1 : 1)),
    };
    if (still && still.label) scan.label = still.label;
    scans.push(scan);

    // Dados de cada rede, na ordem em que foram aparecendo; o aparelho ganha um id neutro.
    for (const r of scan.readings) {
      if (meta[r.id]) continue;
      const ap = world.ap(r.id);
      if (!deviceIds.has(ap.device)) deviceIds.set(ap.device, `d${deviceIds.size + 1}`);
      meta[r.id] = { ssid: ap.ssid, freq: ap.freq, device: deviceIds.get(ap.device) };
    }

    points.push({ x: mid.x, y: mid.y, z: mid.z });
    const floor = Math.max(0, Math.min(world.floors - 1, Math.floor(mid.z / FLOOR_HEIGHT)));
    truthFloors.push(floor);
    const room = world.roomAt(mid.x, mid.y, floor);
    truthRooms.push(room ? room.name : null);
    truthTimes.push(win.mid);
  }

  // --- sinal da rede conectada, a cada 2 s ---
  const survey = { version: 1, scans, aps: meta };
  const own = world.aps.filter((a) => a.own);
  if (options.track !== false && own.length) {
    const track = [];
    let link = null;
    for (let tt = 1; tt <= endT; tt += 2) {
      const p = posAt(tt);
      const level = (a) => world.meanRssi(a, p) + (a.band > 0 ? 4 : 0); // o celular prefere 5 GHz
      if (!link) link = own.reduce((best, a) => (level(a) > level(best) ? a : best));
      else if (world.meanRssi(link, p) < -72) {
        // Celular "grudento": só troca de rádio quando o atual está ruim e há outro bem melhor.
        const best = own.reduce((b, a) => (level(a) > level(b) ? a : b));
        if (best !== link && level(best) > level(link) + 8) link = best;
      }
      track.push({ t: tt, id: link.bssid, rssi: world.track(link, p, p.heading, tt) });
      if (!meta[link.bssid]) {
        if (!deviceIds.has(link.device)) deviceIds.set(link.device, `d${deviceIds.size + 1}`);
        meta[link.bssid] = { ssid: link.ssid, freq: link.freq, device: deviceIds.get(link.device) };
      }
    }
    survey.track = track;
  }

  const truth = {
    points,
    aps: Object.fromEntries(world.aps.map((a) => [a.bssid, { x: a.x, y: a.y, z: a.z }])),
    world,
    floors: truthFloors,
    rooms: truthRooms,
    times: truthTimes,
    startFloor: plan.start.floor,
    durationS: round(endT, 1),
  };
  return { survey, truth };
}

function round(v, digits) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
