// Mapa de mentira para os testes e a página de demonstração do visualizador.
//
// Monta um MapModel (e os HeatField) direto da VERDADE de um mundo do simulador, com
// erro de posição, deformação e borrão ajustáveis, para ficar com a cara do que o
// construtor de verdade (app/js/mapping/mapmodel.js) produz a partir de um levantamento.
// Não é o construtor: serve só para desenhar. Roda no Node e no navegador.
//
//   const fake = fakeMap('sobrado', { seed: 1, noiseM: 0.7 });
//   fake.model                      MapModel
//   fake.heat(fake.model.networks[0].key)   HeatField[] (um por andar, na ordem de model.floors)
//   fake.world, fake.truth          o mundo e a verdade usados
//
//   fakeBigMap({ nx: 200, ny: 200, floors: 3, pathPoints: 300 })   modelo grande e sintético (desempenho)
//   relabel(model, ['texto 1', ...])                               troca os nomes (textos longos, emoji, hostis)
//   HOSTILE_LABELS                                                 nomes para esses testes

import { FLOOR_HEIGHT } from '../../app/js/mapping/types.js';
import { presetWorld, listPresets } from '../../app/js/sim/presets.js';
import { planWalk, simulateSurvey } from '../../app/js/sim/walk.js';
import { createRng } from '../../app/js/sim/prng.js';

export { listPresets };

/** Textos que um usuário (ou um vizinho mal-intencionado) pode pôr num nome. */
export const HOSTILE_LABELS = Object.freeze([
  '<img src=x onerror=alert(1)>',
  'Sala de estar e jantar integrada com a varanda gourmet',
  '🛋️ Sala 📺',
  '"><script>alert(2)</script>',
  'Quarto do João Pedro & da Maria Clara (beliche)',
  '🚿',
  'مرحبا بالعالم',
  'a'.repeat(80),
  '   ',
  'Cozinha\nnova\tlinha',
]);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Do mundo ao mapa
// ---------------------------------------------------------------------------

/**
 * @param {string|object} worldOrId  id de um mundo pronto ('apartamento', 'sobrado', 'escritorio', 'kitnet') ou o mundo
 * @param {object} [options]
 * @param {number} [options.seed]         semente do mundo e do ruído (padrão 1)
 * @param {number} [options.noiseM]       erro típico de posição (m): deformação suave + tremor (padrão 0.7)
 * @param {number} [options.blurM]        borrão do sinal e dos ambientes (m) (padrão 0.6)
 * @param {number} [options.scale]        erro de escala (1 = certo; padrão sorteado em ±12%)
 * @param {number} [options.cell]         lado da célula (padrão: 0.25 em casa, até 0.4 em área grande)
 * @param {number} [options.reachM]       até onde em volta do caminho conta como "área da casa" (padrão 1.25)
 * @param {number} [options.progress]     0..1: só o começo do levantamento (pré-visualização ao vivo)
 * @param {number} [options.lengthM]      comprimento mínimo da caminhada
 * @param {number} [options.unnamed]      quantos ambientes ficam sem nome dado pelo usuário (padrão 1)
 * @param {number} [options.neighbours]   quantas redes vizinhas entram em model.networks (padrão 2)
 */
export function fakeMap(worldOrId, options = {}) {
  const seed = options.seed ?? 1;
  const world = typeof worldOrId === 'string' ? presetWorld(worldOrId, seed) : worldOrId;
  const rng = createRng('fake-map', world.key ?? seed, seed);
  const noiseM = options.noiseM ?? 0.7;
  const blurM = options.blurM ?? 0.6;
  const reachM = options.reachM ?? 1.25;
  const area = world.bounds.width * world.bounds.height;
  const lengthM = options.lengthM ?? clamp(area * 1.9 * world.floors, 55, 420);

  const plan = planWalk(world, { kind: 'tour', seed, minLengthM: lengthM });
  const sim = simulateSurvey(world, plan, { seed, scanIntervalS: 3.5 });
  const { survey, truth } = sim;
  const total = survey.scans.length;
  const count = Math.max(2, Math.round(total * clamp(options.progress ?? 1, 0, 1)));

  // --- deformação: o erro de um solucionador é suave no espaço (o mapa entorta), com um tremor por cima ---
  const waves = Array.from({ length: 4 }, () => ({
    kx: rng.float(-1, 1) / rng.float(4, 9),
    ky: rng.float(-1, 1) / rng.float(4, 9),
    kz: rng.float(-0.3, 0.3),
    ph: rng.float(0, Math.PI * 2),
    ax: rng.gaussian(0, 0.55),
    ay: rng.gaussian(0, 0.55),
  }));
  const warp = (x, y, z) => {
    let dx = 0;
    let dy = 0;
    for (const w of waves) {
      const s = Math.sin((x * w.kx + y * w.ky + z * w.kz) * Math.PI * 2 + w.ph);
      dx += w.ax * s;
      dy += w.ay * s;
    }
    return [dx * noiseM, dy * noiseM];
  };

  // --- convenção de saída: origem no centro dos pontos, x na direção de maior espalhamento, espelho ao acaso ---
  const startFloor = truth.startFloor;
  const raw = [];
  for (let i = 0; i < count; i++) {
    const p = truth.points[i];
    const [dx, dy] = warp(p.x, p.y, p.z);
    raw.push([p.x + dx + rng.gaussian(0, noiseM * 0.28), p.y + dy + rng.gaussian(0, noiseM * 0.28)]);
  }
  let mx = 0;
  let my = 0;
  for (const p of raw) {
    mx += p[0];
    my += p[1];
  }
  mx /= raw.length;
  my /= raw.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of raw) {
    sxx += (p[0] - mx) ** 2;
    sxy += (p[0] - mx) * (p[1] - my);
    syy += (p[1] - my) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const mirror = (options.mirror ?? rng.chance(0.5)) ? -1 : 1;
  const scale = options.scale ?? 1 + rng.float(-0.12, 0.12);
  const toMap = (x, y) => {
    const ux = (x - mx) * scale;
    const uy = (y - my) * scale;
    return [ux * cos - uy * sin, (ux * sin + uy * cos) * mirror];
  };
  const toWorld = (x, y) => {
    const vy = y * mirror;
    const ux = x * cos + vy * sin;
    const uy = -x * sin + vy * cos;
    return [ux / scale + mx, uy / scale + my];
  };

  // --- caminho ---
  const floorOf = (i) => truth.floors[i] - startFloor;
  const path = [];
  for (let i = 0; i < count; i++) {
    const [x, y] = toMap(raw[i][0], raw[i][1]);
    const scan = survey.scans[i];
    const f = floorOf(i);
    // trechos de pouca confiança aparecem em ondas, como quando o sinal fica ambíguo
    const wobble = 0.5 + 0.5 * Math.sin(i * 0.37 + rng.seed * 1e-9) * Math.sin(i * 0.11 + 1.3);
    path.push({ i, t: scan.t, x, y, z: f * FLOOR_HEIGHT, floor: f, conf: clamp(0.3 + 0.7 * wobble, 0.15, 1), still: false });
  }

  // --- grade ---
  const margin = reachM + 0.6;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of path) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  minX -= margin;
  minY -= margin;
  maxX += margin;
  maxY += margin;
  const span = Math.max(maxX - minX, maxY - minY);
  const cell = options.cell ?? clamp(Math.round((span / 90) * 20) / 20, 0.25, 0.5);
  const nx = Math.max(4, Math.ceil((maxX - minX) / cell));
  const ny = Math.max(4, Math.ceil((maxY - minY) / cell));
  maxX = minX + nx * cell;
  maxY = minY + ny * cell;
  const bounds = { minX, minY, maxX, maxY };
  const cx = (ix) => minX + (ix + 0.5) * cell;
  const cy = (iy) => minY + (iy + 0.5) * cell;

  const floorNumbers = [...new Set(path.map((p) => p.floor))].sort((a, b) => a - b);

  // nome verdadeiro do cômodo de cada varredura (com um pouco de borrão: vota entre as vizinhas)
  const trueRoom = (i) => truth.rooms[i];

  const floors = floorNumbers.map((f) => {
    const pts = path.filter((p) => p.floor === f);
    const n = nx * ny;
    const dist = new Float32Array(n).fill(Infinity);
    const nearest = new Int32Array(n).fill(-1);
    const r = reachM + cell * 3;
    for (const p of pts) {
      const ix0 = Math.max(0, Math.floor((p.x - r - minX) / cell));
      const ix1 = Math.min(nx - 1, Math.floor((p.x + r - minX) / cell));
      const iy0 = Math.max(0, Math.floor((p.y - r - minY) / cell));
      const iy1 = Math.min(ny - 1, Math.floor((p.y + r - minY) / cell));
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const d = Math.hypot(cx(ix) - p.x, cy(iy) - p.y);
          const c = iy * nx + ix;
          if (d < dist[c]) {
            dist[c] = d;
            nearest[c] = p.i;
          }
        }
      }
    }
    let inside = new Uint8Array(n);
    for (let c = 0; c < n; c++) if (dist[c] <= reachM) inside[c] = 1;
    // fecha buracos e frestas menores que ~0.8 m
    const k = Math.max(1, Math.round(0.4 / cell));
    inside = morph(morph(inside, nx, ny, k, 1), nx, ny, k, 0);
    inside = keepLargest(inside, nx, ny);

    const conf = new Float32Array(n);
    const sigma = reachM * 0.8;
    for (let c = 0; c < n; c++) {
      if (!inside[c]) continue;
      const d = Number.isFinite(dist[c]) ? dist[c] : reachM * 1.5;
      conf[c] = clamp(Math.exp(-((d / sigma) ** 2)), 0.02, 1);
    }

    // ambientes: cada célula fica com o cômodo (verdadeiro) da varredura mais próxima, depois um filtro de maioria
    const names = [];
    const nameIndex = new Map();
    let room = new Int16Array(n).fill(-1);
    for (let c = 0; c < n; c++) {
      if (!inside[c]) continue;
      let i = nearest[c];
      if (i < 0) i = nearestPoint(pts, cx(c % nx), cy((c - (c % nx)) / nx));
      const name = trueRoom(i) ?? '?';
      if (!nameIndex.has(name)) {
        nameIndex.set(name, names.length);
        names.push(name);
      }
      room[c] = nameIndex.get(name);
    }
    const passes = Math.max(1, Math.round(blurM / cell));
    for (let pass = 0; pass < passes; pass++) room = majority(room, inside, nx, ny, names.length);

    return { floor: f, z: f * FLOOR_HEIGHT, inside, conf, room, names, pts };
  });

  // --- ambientes e pontos marcados: um ponto por ambiente, com o nome que o usuário deu ---
  let spotId = 0;
  let autoCount = 0;
  const spots = [];
  const unnamed = options.unnamed ?? 1;
  const modelFloors = floors.map((fl, floorIndex) => {
    const n = nx * ny;
    const acc = fl.names.map(() => ({ sx: 0, sy: 0, cells: 0, scans: 0 }));
    for (let c = 0; c < n; c++) {
      const r = fl.room[c];
      if (r < 0) continue;
      acc[r].sx += cx(c % nx);
      acc[r].sy += cy((c - (c % nx)) / nx);
      acc[r].cells++;
    }
    // ambientes que sumiram no filtro de maioria saem da lista
    const keep = [];
    const remap = new Int16Array(fl.names.length).fill(-1);
    fl.names.forEach((name, r) => {
      if (acc[r].cells < 4) return;
      remap[r] = keep.length;
      keep.push(r);
    });
    for (let c = 0; c < n; c++) if (fl.room[c] >= 0) fl.room[c] = remap[fl.room[c]];
    // células órfãs (ambiente removido) ficam com o vizinho
    for (let pass = 0; pass < 6; pass++) {
      let orphans = 0;
      for (let c = 0; c < n; c++) {
        if (!fl.inside[c] || fl.room[c] >= 0) continue;
        const ix = c % nx;
        const iy = (c - ix) / nx;
        for (const [jx, jy] of [[ix + 1, iy], [ix - 1, iy], [ix, iy + 1], [ix, iy - 1]]) {
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
          if (fl.room[jy * nx + jx] >= 0) {
            fl.room[c] = fl.room[jy * nx + jx];
            break;
          }
        }
        if (fl.room[c] < 0) orphans++;
      }
      if (!orphans) break;
    }
    for (const p of fl.pts) {
      const c = cellIndex(p.x, p.y);
      if (c >= 0 && fl.room[c] >= 0) acc[keep[fl.room[c]]].scans++;
    }

    // o usuário marca um ponto em cada ambiente e dá o nome; os `unnamed` menores do último andar ele não batizou
    const skipped = new Set(
      floorIndex === floors.length - 1 && keep.length > 1
        ? keep
            .map((r, id) => [acc[r].cells, id])
            .sort((p, q) => p[0] - q[0])
            .slice(0, unnamed)
            .map((p) => p[1])
        : [],
    );
    const rooms = keep.map((r, id) => {
      const a = acc[r];
      const centre = [a.sx / a.cells, a.sy / a.cells];
      const pole = roomPole(fl.room, id, nx, ny, centre, cx, cy);
      const named = fl.names[r] !== '?' && !skipped.has(id);
      const label = named ? fl.names[r] : `Ambiente ${++autoCount}`;
      const near = fl.pts.length ? fl.pts[nearestPoint(fl.pts, pole[0], pole[1], true)] : null;
      if (near && named) {
        near.still = true;
        spots.push({ id: spotId++, label, x: near.x, y: near.y, z: fl.z, floor: fl.floor, scans: 3 });
      }
      return { id, label, auto: !named, cx: pole[0], cy: pole[1], areaM2: round1(a.cells * cell * cell), scans: a.scans };
    });

    const outline = traceOutline(fl.inside, nx, ny).map((ring) => ring.map(([ix, iy]) => [round3(minX + ix * cell), round3(minY + iy * cell)]));
    const walls = buildWalls(fl, outline, { nx, ny, cell, minX, minY });
    return { floor: fl.floor, z: fl.z, inside: fl.inside, conf: fl.conf, room: fl.room, outline, rooms, walls };
  });

  function cellIndex(x, y) {
    const ix = Math.floor((x - minX) / cell);
    const iy = Math.floor((y - minY) / cell);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return -1;
    return iy * nx + ix;
  }

  // --- roteadores: um por aparelho, os da casa primeiro ---
  const best = new Map();
  for (let i = 0; i < count; i++) for (const r of survey.scans[i].readings) if (!(best.get(r.id) >= r.rssi)) best.set(r.id, r.rssi);
  const devices = new Map();
  for (const ap of world.aps) {
    if (!best.has(ap.bssid)) continue;
    if (!devices.has(ap.device)) devices.set(ap.device, []);
    devices.get(ap.device).push(ap);
  }
  const floorByNumber = new Map(modelFloors.map((f, i) => [f.floor, i]));
  const aps = [];
  for (const [, list] of devices) {
    list.sort((a, b) => best.get(b.bssid) - best.get(a.bssid));
    const head = list[0];
    const own = list.some((a) => a.own);
    const [wx, wy] = warp(head.x, head.y, head.z);
    const centreDist = Math.hypot(head.x - mx, head.y - my);
    const err = own ? noiseM * 0.6 : noiseM * 1.2 + centreDist * 0.18;
    const [x, y] = toMap(head.x + wx + rng.gaussian(0, err), head.y + wy + rng.gaussian(0, err));
    const f = Math.floor(head.z / FLOOR_HEIGHT) - startFloor;
    const fi = floorByNumber.get(f);
    const c = cellIndex(x, y);
    const inside = fi !== undefined && c >= 0 && modelFloors[fi].inside[c] === 1;
    aps.push({
      id: head.bssid,
      bssids: list.map((a) => a.bssid),
      ssid: (list.find((a) => a.ssid) || head).ssid,
      own,
      x,
      y,
      z: head.z - startFloor * FLOOR_HEIGHT,
      floor: own || rng.chance(0.7) ? f : null,
      conf: own ? clamp(0.85 - noiseM * 0.15, 0.3, 0.95) : clamp(0.6 - centreDist * 0.03 + rng.float(-0.1, 0.1), 0.08, 0.6),
      inside,
      distanceM: round1(Math.hypot(x, y)),
      bearing: Math.atan2(y, x),
      bestRssi: best.get(head.bssid),
    });
  }
  aps.sort((a, b) => Number(b.own) - Number(a.own) || b.bestRssi - a.bestRssi);

  // --- redes que podem colorir o mapa ---
  const netMap = new Map();
  for (const ap of world.aps) {
    if (!best.has(ap.bssid) || !ap.ssid) continue;
    const key = `${ap.ssid}|${ap.band === 0 ? '2.4' : ap.band === 1 ? '5' : '6'}`;
    if (!netMap.has(key)) netMap.set(key, { key, ssid: ap.ssid, own: ap.own, bssids: [], bestRssi: -Infinity });
    const net = netMap.get(key);
    net.bssids.push(ap.bssid);
    net.bestRssi = Math.max(net.bestRssi, best.get(ap.bssid));
  }
  const allNets = [...netMap.values()].sort((a, b) => Number(b.own) - Number(a.own) || b.bestRssi - a.bestRssi);
  const networks = [...allNets.filter((n) => n.own), ...allNets.filter((n) => !n.own).slice(0, options.neighbours ?? 2)];

  let areaM2 = 0;
  for (const f of modelFloors) for (let c = 0; c < f.inside.length; c++) areaM2 += f.inside[c];
  areaM2 = round1(areaM2 * cell * cell);
  const expected = round1(Math.max(0.5, noiseM * 1.6));
  const model = {
    version: 1,
    bounds,
    cell,
    nx,
    ny,
    floors: modelFloors,
    aps,
    networks,
    path,
    spots,
    quality: {
      scans: count,
      spots: spots.length,
      aps: aps.length,
      areaM2,
      scaleConf: 0.6,
      expectedErrorM: expected,
      level: expected <= 1 ? 'boa' : expected <= 2 ? 'razoavel' : 'fraca',
      notes: ['Marque mais pontos parados para o mapa ficar mais firme.'],
    },
  };

  // --- campo de sinal: a verdade do mundo, borrada como um campo estimado de poucas medições ---
  const heatCache = new Map();
  function heat(key) {
    if (heatCache.has(key)) return heatCache.get(key);
    const net = networks.find((n) => n.key === key) || allNets.find((n) => n.key === key);
    if (!net) throw new Error(`rede desconhecida: ${key}`);
    const radios = net.bssids.map((b) => world.ap(b));
    const fields = modelFloors.map((fl) => {
      const n = nx * ny;
      const rawDbm = new Float32Array(n).fill(NaN);
      const z = (fl.floor + startFloor) * FLOOR_HEIGHT + 1.2;
      for (let c = 0; c < n; c++) {
        if (!fl.inside[c]) continue;
        const ix = c % nx;
        const [ax, ay] = toWorld(cx(ix), cy((c - ix) / nx));
        const [dx, dy] = warp(ax, ay, z);
        const pos = { x: ax - dx, y: ay - dy, z };
        let v = -Infinity;
        for (const ap of radios) v = Math.max(v, world.meanRssi(ap, pos));
        rawDbm[c] = Math.max(-100, v);
      }
      const dbm = blurField(rawDbm, fl.inside, nx, ny, Math.max(1, Math.round(blurM / cell)));
      const conf = new Float32Array(n);
      let min = Infinity;
      let max = -Infinity;
      for (let c = 0; c < n; c++) {
        if (!fl.inside[c]) continue;
        conf[c] = fl.conf[c];
        if (dbm[c] < min) min = dbm[c];
        if (dbm[c] > max) max = dbm[c];
      }
      return { dbm, conf, min, max };
    });
    heatCache.set(key, fields);
    return fields;
  }

  return { model, heat, heatField: (floorIndex, key) => heat(key)[floorIndex], world, truth, survey, toMap, toWorld };
}

// ---------------------------------------------------------------------------
// Operações de grade
// ---------------------------------------------------------------------------

// dilata (grow = 1) ou erode (grow = 0) `k` células, vizinhança de 8
function morph(mask, nx, ny, k, grow) {
  let cur = mask;
  for (let pass = 0; pass < k; pass++) {
    const next = new Uint8Array(cur.length);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        let hit = grow ? 0 : 1;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const jx = ix + dx;
            const jy = iy + dy;
            const v = jx < 0 || jy < 0 || jx >= nx || jy >= ny ? 0 : cur[jy * nx + jx];
            if (grow) hit |= v;
            else hit &= v;
          }
        }
        next[iy * nx + ix] = hit;
      }
    }
    cur = next;
  }
  return cur;
}

// fica só com o maior pedaço ligado (ilhas soltas confundiriam o contorno)
function keepLargest(mask, nx, ny) {
  const label = new Int32Array(mask.length).fill(-1);
  let bestLabel = -1;
  let bestSize = 0;
  let count = 0;
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    let size = 0;
    stack.push(start);
    label[start] = count;
    while (stack.length) {
      const c = stack.pop();
      size++;
      const ix = c % nx;
      const iy = (c - ix) / nx;
      for (const [jx, jy] of [[ix + 1, iy], [ix - 1, iy], [ix, iy + 1], [ix, iy - 1]]) {
        if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
        const j = jy * nx + jx;
        if (mask[j] && label[j] < 0) {
          label[j] = count;
          stack.push(j);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = count;
    }
    count++;
  }
  const out = new Uint8Array(mask.length);
  for (let c = 0; c < mask.length; c++) if (label[c] === bestLabel) out[c] = 1;
  return out;
}

function majority(room, inside, nx, ny, count) {
  const out = new Int16Array(room);
  const votes = new Uint16Array(Math.max(1, count));
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const c = iy * nx + ix;
      if (!inside[c]) continue;
      votes.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx;
          const jy = iy + dy;
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
          const r = room[jy * nx + jx];
          if (r >= 0) votes[r] += dx === 0 && dy === 0 ? 2 : 1;
        }
      }
      let bestR = room[c];
      let bestV = -1;
      for (let r = 0; r < count; r++) {
        if (votes[r] > bestV) {
          bestV = votes[r];
          bestR = r;
        }
      }
      out[c] = bestR;
    }
  }
  return out;
}

function blurField(field, inside, nx, ny, k) {
  let cur = field;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(cur.length).fill(NaN);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const c = iy * nx + ix;
        if (!inside[c]) continue;
        let sum = 0;
        let w = 0;
        for (let dy = -k; dy <= k; dy++) {
          for (let dx = -k; dx <= k; dx++) {
            const jx = ix + dx;
            const jy = iy + dy;
            if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
            const j = jy * nx + jx;
            if (!inside[j]) continue;
            sum += cur[j];
            w++;
          }
        }
        next[c] = sum / w;
      }
    }
    cur = next;
  }
  return cur;
}

function nearestPoint(pts, x, y, localIndex = false) {
  let bestI = 0;
  let bestD = Infinity;
  for (let k = 0; k < pts.length; k++) {
    const d = (pts[k].x - x) ** 2 + (pts[k].y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      bestI = k;
    }
  }
  return localIndex ? bestI : pts[bestI].i;
}

// Um ponto "bem dentro" do ambiente para o rótulo: a célula do ambiente mais perto do centro de massa.
function roomPole(room, id, nx, ny, centre, cx, cy) {
  let best = centre;
  let bestD = Infinity;
  for (let c = 0; c < room.length; c++) {
    if (room[c] !== id) continue;
    const ix = c % nx;
    const x = cx(ix);
    const y = cy((c - ix) / nx);
    const d = (x - centre[0]) ** 2 + (y - centre[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = [x, y];
    }
  }
  return best;
}

/**
 * Contorno de uma máscara: anéis de vértices (ix, iy) na malha de cantos das células,
 * com a área à esquerda (externo anti-horário, buraco horário) e sem pontos colineares.
 */
export function traceOutline(mask, nx, ny) {
  const at = (ix, iy) => (ix < 0 || iy < 0 || ix >= nx || iy >= ny ? 0 : mask[iy * nx + ix]);
  const key = (ix, iy) => iy * (nx + 1) + ix;
  const out = new Map(); // vértice de partida -> arestas [x0, y0, x1, y1]
  const add = (x0, y0, x1, y1) => {
    const k = key(x0, y0);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push([x0, y0, x1, y1, false]);
  };
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (!mask[iy * nx + ix]) continue;
      if (!at(ix, iy - 1)) add(ix, iy, ix + 1, iy); // embaixo: para a direita
      if (!at(ix + 1, iy)) add(ix + 1, iy, ix + 1, iy + 1); // direita: para cima
      if (!at(ix, iy + 1)) add(ix + 1, iy + 1, ix, iy + 1); // em cima: para a esquerda
      if (!at(ix - 1, iy)) add(ix, iy + 1, ix, iy); // esquerda: para baixo
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
        const options = (out.get(key(e[2], e[3])) || []).filter((o) => !o[4]);
        if (!options.length) break;
        // em quina dupla (duas células se tocando pela ponta) vira para a esquerda: não junta as duas áreas
        const dx = e[2] - e[0];
        const dy = e[3] - e[1];
        options.sort((p, q) => turn(dx, dy, q) - turn(dx, dy, p));
        e = options[0];
      }
      if (ring.length >= 4) rings.push(dropCollinear(ring));
    }
  }
  return rings;
}

function turn(dx, dy, e) {
  return dx * (e[3] - e[1]) - dy * (e[2] - e[0]);
}

function dropCollinear(ring) {
  const out = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n];
    const b = ring[i];
    const c = ring[(i + 1) % n];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
  }
  return out;
}

// Paredes como um construtor simples faria: o contorno em trechos e as fronteiras entre ambientes
// em degraus alinhados à grade (o visualizador é que alisa).
function buildWalls(fl, outline, { nx, ny, cell, minX, minY }) {
  const walls = [];
  const confAt = (x, y) => {
    const ix = clamp(Math.floor((x - minX) / cell), 0, nx - 1);
    const iy = clamp(Math.floor((y - minY) / cell), 0, ny - 1);
    let best = 0;
    for (let dy = -1; dy <= 0; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        const jx = clamp(ix + dx, 0, nx - 1);
        const jy = clamp(iy + dy, 0, ny - 1);
        best = Math.max(best, fl.conf[jy * nx + jx]);
      }
    }
    return best;
  };
  for (const ring of outline) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      walls.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], kind: 'outer', conf: round3(confAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) });
    }
  }
  const differ = (a, b) => a >= 0 && b >= 0 && a !== b;
  // fronteiras verticais (entre ix e ix + 1), juntando as células seguidas da mesma coluna
  for (let ix = 0; ix + 1 < nx; ix++) {
    let start = -1;
    let pair = '';
    for (let iy = 0; iy <= ny; iy++) {
      const a = iy < ny ? fl.room[iy * nx + ix] : -1;
      const b = iy < ny ? fl.room[iy * nx + ix + 1] : -1;
      const now = iy < ny && differ(a, b) ? `${a}|${b}` : '';
      if (now !== pair) {
        if (pair) pushInner(minX + (ix + 1) * cell, minY + start * cell, minX + (ix + 1) * cell, minY + iy * cell);
        pair = now;
        start = iy;
      }
    }
  }
  for (let iy = 0; iy + 1 < ny; iy++) {
    let start = -1;
    let pair = '';
    for (let ix = 0; ix <= nx; ix++) {
      const a = ix < nx ? fl.room[iy * nx + ix] : -1;
      const b = ix < nx ? fl.room[(iy + 1) * nx + ix] : -1;
      const now = ix < nx && differ(a, b) ? `${a}|${b}` : '';
      if (now !== pair) {
        if (pair) pushInner(minX + start * cell, minY + (iy + 1) * cell, minX + ix * cell, minY + (iy + 1) * cell);
        pair = now;
        start = ix;
      }
    }
  }
  function pushInner(x1, y1, x2, y2) {
    walls.push({ x1: round3(x1), y1: round3(y1), x2: round3(x2), y2: round3(y2), kind: 'inner', conf: round3(confAt((x1 + x2) / 2, (y1 + y2) / 2) * 0.85) });
  }
  return walls;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}
function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Variações para os testes
// ---------------------------------------------------------------------------

/**
 * Cópia do modelo com os nomes trocados (ambientes, pontos marcados e roteadores), em rodízio.
 * @param {import('../../app/js/mapping/types.js').MapModel} model
 * @param {string[]} [labels]
 */
export function relabel(model, labels = HOSTILE_LABELS) {
  let k = 0;
  const next = () => labels[k++ % labels.length];
  return {
    ...model,
    floors: model.floors.map((f) => ({ ...f, rooms: f.rooms.map((r) => ({ ...r, label: next(), auto: false })) })),
    spots: model.spots.map((s) => ({ ...s, label: next() })),
    aps: model.aps.map((a) => ({ ...a, ssid: next() })),
  };
}

/**
 * Modelo grande e sintético, sem simulador: para medir desempenho e vazamento.
 * @param {{nx?:number, ny?:number, floors?:number, pathPoints?:number, cell?:number, seed?:number, rooms?:number}} [options]
 * @returns {{model: import('../../app/js/mapping/types.js').MapModel, heat: (key?:string) => import('../../app/js/mapping/types.js').HeatField[]}}
 */
export function fakeBigMap(options = {}) {
  const { nx = 200, ny = 200, floors: floorCount = 3, pathPoints = 300, cell = 0.25, seed = 1, rooms: roomCount = 12 } = options;
  const rng = createRng('fake-big', seed, nx, ny);
  const w = nx * cell;
  const h = ny * cell;
  const bounds = { minX: -w / 2, minY: -h / 2, maxX: w / 2, maxY: h / 2 };
  const cx = (ix) => bounds.minX + (ix + 0.5) * cell;
  const cy = (iy) => bounds.minY + (iy + 0.5) * cell;
  const n = nx * ny;
  const lobes = Array.from({ length: 5 }, () => ({ k: rng.int(2, 6), a: rng.float(0.03, 0.09), ph: rng.float(0, 6.28) }));
  const floors = [];
  const path = [];
  const spots = [];
  for (let f = 0; f < floorCount; f++) {
    const inside = new Uint8Array(n);
    const conf = new Float32Array(n);
    const room = new Int16Array(n).fill(-1);
    const seeds = Array.from({ length: roomCount }, () => [rng.float(-0.38, 0.38) * w, rng.float(-0.38, 0.38) * h]);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = cx(ix);
        const y = cy(iy);
        const ang = Math.atan2(y / h, x / w);
        let radius = 0.42 - f * 0.03;
        for (const l of lobes) radius += l.a * Math.sin(ang * l.k + l.ph + f);
        const d = Math.hypot(x / w, y / h);
        if (d > radius) continue;
        const c = iy * nx + ix;
        inside[c] = 1;
        conf[c] = clamp(0.25 + 0.75 * (0.5 + 0.5 * Math.sin(x * 0.35 + f) * Math.cos(y * 0.3 - f)) * (1 - (d / radius) ** 6), 0.03, 1);
        let bestR = 0;
        let bestD = Infinity;
        for (let r = 0; r < seeds.length; r++) {
          const dd = (seeds[r][0] - x) ** 2 + (seeds[r][1] - y) ** 2;
          if (dd < bestD) {
            bestD = dd;
            bestR = r;
          }
        }
        room[c] = bestR;
      }
    }
    const acc = seeds.map(() => ({ sx: 0, sy: 0, cells: 0 }));
    for (let c = 0; c < n; c++) {
      if (room[c] < 0) continue;
      acc[room[c]].sx += cx(c % nx);
      acc[room[c]].sy += cy((c - (c % nx)) / nx);
      acc[room[c]].cells++;
    }
    const used = acc.map((a, r) => (a.cells > 0 ? r : -1)).filter((r) => r >= 0);
    const remap = new Int16Array(seeds.length).fill(-1);
    used.forEach((r, i) => (remap[r] = i));
    for (let c = 0; c < n; c++) if (room[c] >= 0) room[c] = remap[room[c]];
    const rooms = used.map((r, id) => ({ id, label: `Sala ${f * roomCount + id + 1}`, auto: id % 4 === 3, cx: acc[r].sx / acc[r].cells, cy: acc[r].sy / acc[r].cells, areaM2: round1(acc[r].cells * cell * cell), scans: 10 }));
    const outline = traceOutline(inside, nx, ny).map((ring) => ring.map(([ix, iy]) => [bounds.minX + ix * cell, bounds.minY + iy * cell]));
    const fl = { floor: f, z: f * FLOOR_HEIGHT, inside, conf, room, names: [], pts: [] };
    const walls = buildWalls(fl, outline, { nx, ny, cell, minX: bounds.minX, minY: bounds.minY });
    floors.push({ floor: f, z: f * FLOOR_HEIGHT, inside, conf, room, outline, rooms, walls });
    const per = Math.ceil(pathPoints / floorCount);
    for (let k = 0; k < per && path.length < pathPoints; k++) {
      const u = k / per;
      const ang = u * Math.PI * 7 + f;
      const rad = 0.3 * (0.25 + 0.75 * Math.abs(Math.sin(u * Math.PI * 3)));
      const i = path.length;
      path.push({ i, t: i * 3.5, x: Math.cos(ang) * rad * w, y: Math.sin(ang) * rad * h, z: f * FLOOR_HEIGHT, floor: f, conf: 0.3 + 0.7 * Math.abs(Math.sin(i * 0.21)), still: k % 25 === 0 });
      if (k % 25 === 0) spots.push({ id: spots.length, label: `Ponto ${spots.length + 1}`, x: path[i].x, y: path[i].y, z: f * FLOOR_HEIGHT, floor: f, scans: 3 });
    }
  }
  const aps = [];
  for (let k = 0; k < 2 + 10; k++) {
    const own = k < 2;
    const ang = rng.float(0, 6.28);
    const rad = own ? rng.float(0.05, 0.2) * w : rng.float(0.3, 1.4) * w;
    const x = Math.cos(ang) * rad;
    const y = Math.sin(ang) * rad;
    const c = Math.floor((y - bounds.minY) / cell) * nx + Math.floor((x - bounds.minX) / cell);
    aps.push({
      id: `0a:00:00:00:00:${k.toString(16).padStart(2, '0')}`,
      bssids: [`0a:00:00:00:00:${k.toString(16).padStart(2, '0')}`],
      ssid: own ? `Rede da casa ${k + 1}` : `Vizinho ${k - 1}`,
      own,
      x,
      y,
      z: 1.2,
      floor: 0,
      conf: own ? 0.8 : 0.3,
      inside: rad < 0.3 * w && floors[0].inside[c] === 1,
      distanceM: round1(rad),
      bearing: ang,
      bestRssi: own ? -40 : -70 - k,
    });
  }
  const networks = [{ key: 'casa', ssid: 'Rede da casa', own: true, bssids: aps.filter((a) => a.own).map((a) => a.id), bestRssi: -40 }];
  let areaM2 = 0;
  for (const f of floors) for (let c = 0; c < n; c++) areaM2 += f.inside[c];
  const model = {
    version: 1,
    bounds,
    cell,
    nx,
    ny,
    floors,
    aps,
    networks,
    path,
    spots,
    quality: { scans: path.length, spots: spots.length, aps: aps.length, areaM2: round1(areaM2 * cell * cell), scaleConf: 0.5, expectedErrorM: 2, level: 'razoavel', notes: [] },
  };
  let fields = null;
  const heat = () => {
    if (fields) return fields;
    fields = floors.map((fl, f) => {
      const dbm = new Float32Array(n).fill(NaN);
      const conf = new Float32Array(n);
      let min = Infinity;
      let max = -Infinity;
      for (let c = 0; c < n; c++) {
        if (!fl.inside[c]) continue;
        const ix = c % nx;
        const x = cx(ix);
        const y = cy((c - ix) / nx);
        let v = -Infinity;
        for (const ap of aps) {
          if (!ap.own) continue;
          const d = Math.max(0.5, Math.hypot(x - ap.x, y - ap.y, f * FLOOR_HEIGHT));
          v = Math.max(v, -38 - 26 * Math.log10(d) - f * 9 + 3 * Math.sin(x * 0.7) * Math.cos(y * 0.6));
        }
        dbm[c] = v;
        conf[c] = fl.conf[c];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return { dbm, conf, min, max };
    });
    return fields;
  };
  return { model, heat };
}
