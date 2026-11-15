#!/usr/bin/env node
// Bancada do construtor do mapa (app/js/mapping/mapmodel.js).
//
//   node tests/mapping/map-eval.mjs [--truth | --solver <módulo>] [--export nome] [--set dev|val] [--only <trecho>]
//        [--json] [--svg <pasta>] [--jobs N] [--budget-ms N] [--cache <pasta>] [--noise <m>]
//        [--no-labels] [--auto-rooms] [--own track|all] [--describe] [--param chave=valor ...]
//
// Para cada cenário de desenvolvimento (os mesmos de harness.mjs) monta o levantamento, obtém
// uma solução, chama buildMap e compara o mapa com a planta de verdade, depois do MESMO
// alinhamento rígido que a bancada dos solucionadores usa (Procrustes dos pontos, sem escala).
//
//   --truth   a "solução" são as posições reais: isola o erro do construtor do erro do solucionador;
//   sem ele   roda o solucionador numa thread que só recebe o levantamento (padrão: solver.js, se
//             existir; senão candidates/geo.js).
//
// Medidas (por cenário):
//   IoU / razão  área estimada x contorno real, por andar (média dos andares);
//   esc          tamanho da nuvem de pontos desenhada / real (raio quadrático médio em torno do centro);
//   ARI          índice de Rand ajustado entre os ambientes estimados e os cômodos reais nas células
//                realmente de dentro (célula que o mapa deixou de fora = um grupo à parte);
//                ARIin = o mesmo só onde o mapa tem área;
//   amb          quantos ambientes o mapa tem / quantos cômodos existem;
//                (no JSON: roomPurity = de cada ambiente desenhado, a parte que é de um cômodo só;
//                roomComplete = de cada cômodo, a parte que ficou num ambiente só; nameAcc = das células
//                de um ambiente com nome dado pelo usuário, quantas são mesmo do cômodo com esse nome);
//   calor        RMSE (dB) entre heatField e o sinal real da rede da casa COM O CELULAR NA MÃO (o campo
//                médio menos a perda média do corpo de quem segura o aparelho: é o que o app mede e o
//                que o usuário terá naquele lugar; rede com vários BSSIDs = o maior entre eles), nas
//                células de dentro; c>.5 = só onde a confiança do campo passa de 0,5; viés = média
//                (estimado - real). No JSON, heatRmseFree / heatBiasFree comparam com o campo sem corpo;
//   rot          erro de posição do roteador da casa (mediana entre os aparelhos), em metros;
//   parP / parR  divisões internas: fração do comprimento estimado que tem parede real a até 0,6 m
//                (parPc = a mesma fração pesada pela confiança de cada divisão: maior que parP quando a
//                confiança separa as divisões certas das erradas), e fração das paredes internas reais
//                com divisão estimada a até 0,75 m;
//   errE / errR  erro de posição esperado (quality.expectedErrorM) x erro mediano real dos pontos.
//
// Conjuntos: dev (padrão) e val (--set val: outras sementes e casas sorteadas, daqui mesmo). O
// holdout de harness.mjs é para julgar solucionadores, não para ajustar o mapa: não entra aqui.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createRng, hashSeed } from '../../app/js/sim/prng.js';
import { distToSegment, pointInPolygon } from '../../app/js/sim/world.js';
import { FLOOR_HEIGHT } from '../../app/js/mapping/types.js';
import { buildMap, heatField, coverage, suggestRouterSpot, describeMap } from '../../app/js/mapping/mapmodel.js';
import { listScenarios, buildScenario, DEFAULT_BUDGET_MS } from './harness.mjs';
import { procrustes, quantile } from './metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_MAPPING = path.resolve(HERE, '..', '..', 'app', 'js', 'mapping');
const EVAL_STEP = 0.2; // malha de avaliação sobre a planta real (m)
const ROUTER_MISSING_M = 50;

/** Solucionador padrão: o oficial, se já existir; senão o candidato geométrico. */
export function defaultSolver() {
  const official = path.join(APP_MAPPING, 'solver.js');
  return fs.existsSync(official) ? official : path.join(APP_MAPPING, 'candidates', 'geo.js');
}

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------

const VAL_SEEDS = [5, 6];
const VAL_SIZES = ['pequena', 'media', 'grande'];

/**
 * Cenários desta bancada.
 *   dev  os 32 de desenvolvimento de harness.mjs (onde as constantes do construtor foram ajustadas);
 *   val  conferência de que um ajuste não é decoreba do dev: os mesmos quatro mundos com outras
 *        sementes (outra vizinhança, outro usuário, outra caminhada) e 24 casas sorteadas com a
 *        propagação variando ±20%. As sementes são daqui (prefixo próprio): nada a ver com o
 *        holdout de harness.mjs, que continua reservado para julgar solucionadores.
 * @param {'dev'|'val'} set
 */
export function listMapScenarios(set = 'dev') {
  const dev = listScenarios('dev');
  if (set === 'dev') return dev;
  if (set !== 'val') throw new Error(`conjunto desconhecido: ${set} (use dev ou val)`);
  const out = [];
  const modes = [...new Set(dev.map((d) => d.mode))];
  for (const base of dev.filter((d) => d.name.endsWith('-s1'))) {
    const m = modes.indexOf(base.mode);
    for (const seed of VAL_SEEDS) {
      out.push({
        ...base,
        name: base.name.replace(/-s1$/, `-v${seed}`),
        set: 'val',
        world: { ...base.world, seed },
        walk: { ...base.walk, seed: 10 * seed + m },
        survey: { ...base.survey, seed: 10 * seed + m },
      });
    }
  }
  const kinds = Object.fromEntries(dev.map((d) => [d.mode, d]));
  for (let i = 0; i < 24; i++) {
    const mode = modes[i % modes.length];
    const size = VAL_SIZES[Math.floor(i / modes.length) % VAL_SIZES.length];
    const name = `casa-v${String(i + 1).padStart(2, '0')}-${size}-${mode}`;
    const seed = (what) => hashSeed('wrx-map-val', name, what);
    const rng = createRng('wrx-map-val-rf', name);
    const vary = (v) => Math.round(v * rng.float(0.8, 1.2) * 1000) / 1000;
    out.push({
      name,
      set: 'val',
      group: 'casa-sorteada',
      mode,
      world: { type: 'random', seed: seed('world'), size },
      rf: {
        n: Math.round(2.1 * rng.float(0.88, 1.2) * 1000) / 1000,
        wallScale: vary(1),
        shadowSigmaDb: vary(3),
        fadeSigmaDb: vary(1.4),
        noiseSigmaDb: vary(1.4),
        bodyLossDb: [vary(5), vary(6), vary(6)],
        staleCarry: rng.chance(0.5),
      },
      walk: { kind: kinds[mode].walk.kind, seed: seed('walk'), auto: true },
      survey: { scanIntervalS: kinds[mode].survey.scanIntervalS, stillScans: kinds[mode].survey.stillScans, seed: seed('survey') },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Soluções
// ---------------------------------------------------------------------------

/**
 * "Solução" com as posições reais (e os roteadores reais): o teto para o construtor.
 * `noiseM` soma um erro suave e correlacionado no tempo (desvio-padrão por eixo), para ver
 * como o mapa degrada sem depender de nenhum solucionador.
 */
export function truthSolution(scenario, noiseM = 0) {
  const { survey, truth, desc } = scenario;
  const rng = createRng('map-eval-noise', desc.name);
  let ex = 0;
  let ey = 0;
  const keep = 0.85;
  const points = truth.points.map((p, i) => {
    if (noiseM > 0) {
      const s = i === 0 ? noiseM : noiseM * Math.sqrt(1 - keep * keep);
      ex = (i === 0 ? 0 : keep * ex) + rng.gaussian(0, s);
      ey = (i === 0 ? 0 : keep * ey) + rng.gaussian(0, s);
    }
    return { x: p.x + ex, y: p.y + ey, z: survey.scans[i].floor * FLOOR_HEIGHT, conf: noiseM > 0 ? 0.5 : 1 };
  });
  const aps = {};
  for (const id of Object.keys(survey.aps)) {
    const a = truth.world.ap(id);
    if (!a) continue;
    aps[id] = { x: a.x, y: a.y, z: a.z - (truth.startFloor ?? 0) * FLOOR_HEIGHT, p0: a.p0, n: a.n, conf: noiseM > 0 ? 0.5 : 1 };
  }
  return { points, aps, scaleConf: noiseM > 0 ? 0.5 : 1 };
}

// A thread do solucionador recebe só o levantamento e as opções; a verdade fica deste lado.
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const num = (v) => (typeof v === 'number' ? v : NaN);
(async () => {
  try {
    const mod = await import(workerData.solverUrl);
    const solve = mod[workerData.exportName];
    if (typeof solve !== 'function') throw new Error('o módulo não exporta a função "' + workerData.exportName + '"');
    const t0 = performance.now();
    const s = await solve(workerData.survey, workerData.options);
    const ms = performance.now() - t0;
    if (!s || !Array.isArray(s.points)) throw new Error('saída inválida');
    const aps = {};
    for (const [id, a] of Object.entries(s.aps || {})) if (a) aps[id] = { x: num(a.x), y: num(a.y), z: num(a.z), p0: num(a.p0), n: num(a.n), conf: num(a.conf) };
    const points = s.points.map((p) => (p ? { x: num(p.x), y: num(p.y), z: num(p.z), conf: num(p.conf) } : null));
    // O resumo que o solucionador declara (motores, discordância, erro esperado) vai junto se for pequeno,
    // como no app (worker.js): o construtor pode usá-lo.
    let debug;
    try {
      const text = JSON.stringify(s.debug);
      if (typeof text === 'string' && text.length <= 4000) debug = JSON.parse(text);
    } catch (_) {}
    parentPort.postMessage({ ok: true, ms, solution: { points, aps, scaleConf: num(s.scaleConf), debug } });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
})();
`;

function solveInWorker(solverPath, exportName, survey, budgetMs) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { solverUrl: pathToFileURL(solverPath).href, exportName, survey, options: { budgetMs } },
    });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `passou do tempo (${budgetMs} ms)` }), budgetMs + 5000);
    worker.once('message', finish);
    worker.once('error', (err) => finish({ ok: false, error: String((err && err.stack) || err) }));
    worker.once('exit', (code) => finish({ ok: false, error: `a thread terminou sem resposta (código ${code})` }));
  });
}

// Com --cache, a solução de cada cenário fica guardada (chave: o conteúdo do solucionador):
// dá para iterar no construtor sem esperar o solucionador de novo.
async function solveCached(run, desc, survey) {
  let file = null;
  if (run.cacheDir) {
    const tag = `${path.basename(run.solverPath, path.extname(run.solverPath))}-${run.exportName}-${run.solverHash}`;
    file = path.join(run.cacheDir, tag, `${desc.name}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'), (k, v) => (v === null && k !== '' ? NaN : v));
  }
  const reply = await solveInWorker(run.solverPath, run.exportName, survey, run.budgetMs);
  if (file && reply.ok) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(reply));
  }
  return reply;
}

// ---------------------------------------------------------------------------
// Medidas
// ---------------------------------------------------------------------------

const comb2 = (n) => (n * (n - 1)) / 2;

/** Índice de Rand ajustado a partir da tabela de contingência Map("a|b" -> quantidade). */
export function adjustedRand(table) {
  const rows = new Map();
  const cols = new Map();
  let n = 0;
  let sumIJ = 0;
  for (const [key, count] of table) {
    const [a, b] = key.split('|');
    rows.set(a, (rows.get(a) || 0) + count);
    cols.set(b, (cols.get(b) || 0) + count);
    n += count;
    sumIJ += comb2(count);
  }
  if (n < 2) return null;
  let sumA = 0;
  let sumB = 0;
  for (const v of rows.values()) sumA += comb2(v);
  for (const v of cols.values()) sumB += comb2(v);
  const expected = (sumA * sumB) / comb2(n);
  const max = (sumA + sumB) / 2;
  if (Math.abs(max - expected) < 1e-12) return 1; // as duas partições têm um grupo só
  return (sumIJ - expected) / (max - expected);
}

// Rádio mais forte do roteador da casa: o de maior sinal médio nas varreduras.
function strongestOwnRadio(world, survey) {
  let best = null;
  let bestLevel = -Infinity;
  for (const ap of world.aps) {
    if (!ap.own || !survey.aps[ap.bssid]) continue;
    let sum = 0;
    for (const s of survey.scans) {
      const r = s.readings.find((q) => q.id === ap.bssid);
      sum += r ? r.rssi : -100;
    }
    const level = sum / Math.max(1, survey.scans.length);
    if (level > bestLevel) {
      bestLevel = level;
      best = ap;
    }
  }
  return best;
}

/**
 * Monta o mapa de um cenário e compara com a verdade.
 * @returns {{metrics: Object, model: Object, fit: Object, net: Object|null}}
 */
export function evaluateMap(scenario, solution, options = {}) {
  const { survey, truth, world } = scenario;
  // (options.own pode ser a própria lista de BSSIDs "da casa", como o app a monta: tests/e2e/quality.mjs)
  const own = Array.isArray(options.own)
    ? options.own
    : options.own === 'all' || !survey.track || !survey.track.length
      ? world.aps.filter((a) => a.own && survey.aps[a.bssid]).map((a) => a.bssid)
      : [...new Set(survey.track.map((s) => s.id))];
  const t0 = performance.now();
  const model = buildMap(survey, solution, { own, labels: options.labels, autoRooms: options.autoRooms, tune: options.tune, debug: true });
  const buildMs = performance.now() - t0;
  if (typeof options.alter === 'function') options.alter(model); // (estudos: troca algo do modelo antes de medir)

  // O alinhamento é o das posições que o MAPA desenha (model.path): o construtor pode corrigir o
  // tamanho da nuvem do solucionador, e tudo o que ele desenha está nesse referencial.
  const drawn = solution.points.map((p) => p);
  for (const p of model.path) drawn[p.i] = p;
  const fit = procrustes(drawn, truth.points, { scale: false });
  const M = fit.matrix;
  const T = fit.translation;
  // Planta real -> coordenadas do mapa: inverso do alinhamento (a matriz é ortogonal).
  const cellOf = (x, y) => {
    const dx = x - T[0];
    const dy = y - T[1];
    const mx = M[0][0] * dx + M[1][0] * dy;
    const my = M[0][1] * dx + M[1][1] * dy;
    const ix = Math.floor((mx - model.bounds.minX) / model.cell);
    const iy = Math.floor((my - model.bounds.minY) / model.cell);
    return ix < 0 || iy < 0 || ix >= model.nx || iy >= model.ny ? -1 : iy * model.nx + ix;
  };
  const startFloor = truth.startFloor ?? 0;
  const floorIndex = (k) => model.floors.findIndex((f) => f.floor === k - startFloor);

  // Rede da casa para o mapa de calor.
  const radio = strongestOwnRadio(world, survey);
  const net = radio ? model.networks.find((n) => n.bssids.includes(radio.bssid)) : null;
  const netAps = net ? net.bssids.map((b) => world.ap(b)).filter(Boolean) : [];
  let heatMs = 0;

  const b = world.bounds;
  const ious = [];
  const ratios = [];
  const tableAll = new Map();
  const tableIn = new Map();
  const bump = (table, key) => table.set(key, (table.get(key) || 0) + 1);
  let hN = 0;
  let hSum = 0;
  let hSq = 0;
  let cN = 0;
  let cSq = 0;
  let fSum = 0;
  let fSq = 0;
  let namedN = 0;
  let namedHit = 0;
  // Sinal "na mão": o celular é segurado por uma pessoa, e o corpo dela tira alguns dB dos
  // roteadores que ficam às costas. É isso que o app mede e é isso que o usuário vai ter naquele
  // lugar; a referência é portanto o campo médio MENOS a perda média do corpo (média sobre a
  // direção para onde a pessoa está virada: E[((1 - cos θ) / 2)²] = 3/8).
  const bodyDb = (world.rf && world.rf.bodyLossDb) || [0, 0, 0];
  const inHand = (ap, pos) => {
    const horiz = Math.hypot(ap.x - pos.x, ap.y - pos.y);
    const d = Math.hypot(horiz, ap.z - pos.z);
    return world.meanRssi(ap, pos) - (d > 1e-6 ? 0.375 * (bodyDb[ap.band] || 0) * (horiz / d) : 0);
  };
  for (let k = 0; k < world.floors; k++) {
    const fi = floorIndex(k);
    const floor = fi >= 0 ? model.floors[fi] : null;
    let field = null;
    if (floor && net) {
      const th = performance.now();
      field = heatField(model, fi, net.key);
      heatMs = Math.max(heatMs, performance.now() - th);
    }
    const outline = world.outline(k);
    let inter = 0;
    let union = 0;
    let est = 0;
    let real = 0;
    for (let y = b.minY - 3 + EVAL_STEP / 2; y < b.maxY + 3; y += EVAL_STEP) {
      for (let x = b.minX - 3 + EVAL_STEP / 2; x < b.maxX + 3; x += EVAL_STEP) {
        const realIn = pointInPolygon(x, y, outline);
        const c = floor ? cellOf(x, y) : -1;
        const estIn = c >= 0 && floor.inside[c] === 1;
        if (!realIn && !estIn) continue;
        union++;
        if (realIn) real++;
        if (estIn) est++;
        if (realIn && estIn) inter++;
        if (!realIn) continue;
        const room = world.roomAt(x, y, k);
        if (room) {
          const guess = estIn ? `${fi}:${floor.room[c]}` : 'fora';
          bump(tableAll, `${room.index}|${guess}`);
          if (estIn) bump(tableIn, `${room.index}|${guess}`);
          // Ambiente com nome dado pelo usuário: a célula é mesmo do cômodo com esse nome?
          const drawnRoom = estIn ? floor.rooms[floor.room[c]] : null;
          if (drawnRoom && !drawnRoom.auto) {
            namedN++;
            if (drawnRoom.label.trim().toLowerCase() === String(room.name).trim().toLowerCase()) namedHit++;
          }
        }
        if (estIn && field && field.dbm[c] === field.dbm[c]) {
          let real = -Infinity;
          let free = -Infinity;
          const pos = { x, y, z: world.phoneZ(k) };
          for (const ap of netAps) {
            real = Math.max(real, inHand(ap, pos));
            free = Math.max(free, world.meanRssi(ap, pos));
          }
          const d = field.dbm[c] - real;
          hN++;
          hSum += d;
          hSq += d * d;
          fSum += field.dbm[c] - free;
          fSq += (field.dbm[c] - free) ** 2;
          if (field.conf[c] > 0.5) {
            cN++;
            cSq += d * d;
          }
        }
      }
    }
    ious.push(union ? inter / union : 0);
    ratios.push(real ? est / real : 0);
  }
  const mean = (v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);

  // Roteadores da casa: mesmo alinhamento dos pontos.
  const devices = new Map();
  for (const ap of world.aps) {
    if (!ap.own || !survey.aps[ap.bssid]) continue;
    if (!devices.has(ap.device)) devices.set(ap.device, { ap, ids: [] });
    devices.get(ap.device).ids.push(ap.bssid);
  }
  const routerErr = [];
  let floorOk = 0;
  for (const { ap, ids } of devices.values()) {
    const guess = model.aps.find((a) => a.bssids.some((id) => ids.includes(id)));
    if (!guess) {
      routerErr.push(ROUTER_MISSING_M);
      continue;
    }
    const g = fit.apply(guess);
    routerErr.push(Math.hypot(g.x - ap.x, g.y - ap.y));
    if (guess.floor === Math.floor(ap.z / FLOOR_HEIGHT) - startFloor) floorOk++;
  }

  // Divisões internas x paredes reais.
  let wallLen = 0;
  let wallHit = 0;
  let confLen = 0;
  let confHit = 0;
  const innerByFloor = [];
  for (let k = 0; k < world.floors; k++) {
    const fi = floorIndex(k);
    const inner = [];
    if (fi >= 0) {
      for (const w of model.floors[fi].walls) {
        if (w.kind !== 'inner') continue;
        const p1 = fit.apply({ x: w.x1, y: w.y1 });
        const p2 = fit.apply({ x: w.x2, y: w.y2 });
        inner.push([p1.x, p1.y, p2.x, p2.y]);
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const steps = Math.max(1, Math.round(len / 0.2));
        for (let s = 0; s < steps; s++) {
          const u = (s + 0.5) / steps;
          const hit = world.wallDistance(p1.x + (p2.x - p1.x) * u, p1.y + (p2.y - p1.y) * u, k) <= 0.6;
          wallLen += len / steps;
          confLen += (w.conf * len) / steps;
          if (hit) {
            wallHit += len / steps;
            confHit += (w.conf * len) / steps;
          }
        }
      }
    }
    innerByFloor.push(inner);
  }
  let realLen = 0;
  let realHit = 0;
  for (const w of world.walls) {
    if (w.passable) continue;
    const outline = world.outline(w.floor);
    const steps = Math.max(1, Math.round(w.length / 0.2));
    for (let s = 0; s < steps; s++) {
      const u = (s + 0.5) / steps;
      const x = w.x1 + (w.x2 - w.x1) * u;
      const y = w.y1 + (w.y2 - w.y1) * u;
      // Parede do contorno não conta: só as de dentro.
      let edge = Infinity;
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        edge = Math.min(edge, distToSegment(x, y, outline[j][0], outline[j][1], outline[i][0], outline[i][1]));
      }
      if (edge < 0.3) continue;
      realLen += w.length / steps;
      for (const q of innerByFloor[w.floor]) {
        if (distToSegment(x, y, q[0], q[1], q[2], q[3]) <= 0.75) {
          realHit += w.length / steps;
          break;
        }
      }
    }
  }

  // Pureza: de cada ambiente desenhado, a parte que é de um cômodo só (o dominante); completude: de
  // cada cômodo real, a parte que ficou num ambiente só. Médias pesadas pela área, só onde o mapa
  // tem área. Um ambiente único por andar tem completude 1 e pureza = fatia do maior cômodo.
  const byEst = new Map();
  const byReal = new Map();
  let cellsIn = 0;
  for (const [key, count] of tableIn) {
    const [a, g] = key.split('|');
    if (!byEst.has(g)) byEst.set(g, []);
    if (!byReal.has(a)) byReal.set(a, []);
    byEst.get(g).push(count);
    byReal.get(a).push(count);
    cellsIn += count;
  }
  const dominant = (groups) => [...groups.values()].reduce((s, list) => s + Math.max(...list), 0);
  const errs = fit.aligned.map((p, i) => Math.hypot(p.x - truth.points[i].x, p.y - truth.points[i].y));
  const roomsEst = model.floors.reduce((s, f) => s + f.rooms.length, 0);
  // Tamanho da nuvem (raio quadrático médio em torno do centro): desenhada / real, e a do solucionador / real.
  const radius = (pts) => {
    const n = pts.length || 1;
    const cx = pts.reduce((s, p) => s + p.x, 0) / n;
    const cy = pts.reduce((s, p) => s + p.y, 0) / n;
    return Math.sqrt(pts.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / n);
  };
  const realRadius = radius(truth.points);
  const metrics = {
    iou: mean(ious),
    ratio: mean(ratios),
    iouFloors: ious,
    ari: adjustedRand(tableAll),
    ariIn: adjustedRand(tableIn),
    rooms: roomsEst,
    roomsTrue: world.rooms.length,
    roomPurity: cellsIn ? dominant(byEst) / cellsIn : null,
    roomComplete: cellsIn ? dominant(byReal) / cellsIn : null,
    nameAcc: namedN ? namedHit / namedN : null,
    namedShare: cellsIn ? namedN / cellsIn : null,
    heatRmse: hN ? Math.sqrt(hSq / hN) : null,
    heatRmseConf: cN ? Math.sqrt(cSq / cN) : null,
    heatBias: hN ? hSum / hN : null,
    heatRmseFree: hN ? Math.sqrt(fSq / hN) : null,
    heatBiasFree: hN ? fSum / hN : null,
    heatConfShare: hN ? cN / hN : null,
    scale: realRadius > 1e-9 ? radius(drawn) / realRadius : null,
    scaleRaw: realRadius > 1e-9 ? radius(solution.points) / realRadius : null,
    routerErr: routerErr.length ? quantile(routerErr, 0.5) : null,
    routerFloorOk: routerErr.length ? floorOk / routerErr.length : null,
    wallP: wallLen ? wallHit / wallLen : null,
    wallPConf: confLen ? confHit / confLen : null,
    wallR: realLen ? realHit / realLen : null,
    expErr: model.quality.expectedErrorM,
    realErr: quantile(errs, 0.5),
    level: model.quality.level,
    areaM2: model.quality.areaM2,
    buildMs,
    heatMs,
  };
  return { metrics, model, fit, net };
}

// ---------------------------------------------------------------------------
// Desenho (SVG)
// ---------------------------------------------------------------------------

// Tinta e superfície neutras (as mesmas de harness.mjs). Ambientes: quatro tons validados
// para todos os pares; como num mapa político, vizinhos nunca repetem a cor, e o nome escrito
// em cada ambiente é o que o identifica. Sinal: um tom só, do claro (fraco) ao escuro (forte).
const INK = { surface: '#fcfcfb', room: '#f3f2ee', text: '#0b0b0b', text2: '#52514e', muted: '#8a8983', truth: '#b5b4ac' };
const ROOM_FILL = ['#2a78d6', '#eda100', '#e87ba4', '#008300'];
const ROOM_EXTRA = '#8a8983'; // quinto vizinho (raro): neutro
const HEAT_BINS = [
  { from: -55, color: '#0d366b', label: '-55 dBm ou mais' },
  { from: -67, color: '#1c5cab', label: '-67 a -55' },
  { from: -75, color: '#3987e5', label: '-75 a -67' },
  { from: -82, color: '#86b6ef', label: '-82 a -75' },
  { from: -Infinity, color: '#cde2fb', label: 'abaixo de -82' },
];
const AP_COLOR = '#eb6834';
const OUTLINE_COLOR = '#6250d6';
const WALL_COLOR = '#e34948';
const TRUE_WALL = {
  concrete: 'stroke="#3a3a37" stroke-width="3"',
  brick: 'stroke="#6b6a65" stroke-width="2.5"',
  drywall: 'stroke="#a3a29b" stroke-width="2"',
  glass: 'stroke="#a3a29b" stroke-width="1.5" stroke-dasharray="5 3"',
  wood: 'stroke="#d0cfc8" stroke-width="1.5"',
};
const heatColor = (v) => HEAT_BINS.find((bin) => v >= bin.from).color;
const br = (v, digits = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits).replace('.', ','));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Cor de cada ambiente de um andar: gulosa sobre o grafo de vizinhança (vizinhos diferem).
function roomColours(model, floor) {
  const K = floor.rooms.length;
  const adj = Array.from({ length: K }, () => new Set());
  for (let j = 0; j < model.ny; j++) {
    for (let i = 0; i < model.nx; i++) {
      const r = floor.room[j * model.nx + i];
      if (r < 0) continue;
      for (const nb of [i + 1 < model.nx ? floor.room[j * model.nx + i + 1] : -1, j + 1 < model.ny ? floor.room[(j + 1) * model.nx + i] : -1]) {
        if (nb >= 0 && nb !== r) {
          adj[r].add(nb);
          adj[nb].add(r);
        }
      }
    }
  }
  const colour = new Array(K).fill(-1);
  for (let r = 0; r < K; r++) {
    const taken = new Set([...adj[r]].map((q) => colour[q]));
    let c = 0;
    while (taken.has(c)) c++;
    colour[r] = c;
  }
  return colour.map((c) => ROOM_FILL[c] || ROOM_EXTRA);
}

/**
 * Um desenho por cenário. Linha de cima: planta real (paredes e nomes em cinza) com a área
 * estimada, os ambientes coloridos, as divisões e os roteadores. Linha de baixo: o campo de
 * sinal estimado da rede da casa, com as medições por cima.
 */
export function renderMapSvg(scenario, evaluated, result) {
  const { world, survey, truth } = scenario;
  const { model, fit, net } = evaluated;
  const b = world.bounds;
  const margin = 2.5;
  const scale = Math.min(56, 600 / (b.width + 2 * margin));
  const panelW = (b.width + 2 * margin) * scale;
  const panelH = (b.height + 2 * margin) * scale;
  const top = 64;
  const rowGap = 26;
  const legendH = 86;
  const W = Math.max(panelW * world.floors + 24, 1040);
  const H = top + 2 * panelH + rowGap + legendH;
  const X = (x, f) => 12 + f * panelW + (x - b.minX + margin) * scale;
  const Y = (y, row) => top + row * (panelH + rowGap) + panelH - (y - b.minY + margin) * scale;
  const startFloor = truth.startFloor ?? 0;
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" font-family="system-ui, sans-serif">`,
    `<rect width="100%" height="100%" fill="${INK.surface}"/>`,
    `<text x="12" y="24" font-size="16" font-weight="600" fill="${INK.text}">${esc(result.name)} · ${esc(result.source)}</text>`,
    `<text x="12" y="46" font-size="12" fill="${INK.text2}">IoU ${br(result.iou)} · área ${br(result.ratio)}x · ARI ${br(result.ari)} (dentro ${br(result.ariIn)}) · ambientes ${result.rooms}/${result.roomsTrue} · calor ${br(result.heatRmse, 1)} dB (conf&gt;0,5: ${br(result.heatRmseConf, 1)}; viés ${br(result.heatBias, 1)}) · roteador ${br(result.routerErr, 1)} m · divisões P ${br(result.wallP)} R ${br(result.wallR)} · erro esperado ${br(result.expErr, 1)} m, real ${br(result.realErr, 1)} m</text>`,
  );

  // Uma fileira de células seguidas com o mesmo valor vira um quadrilátero só.
  const runs = (floor, valueOf, row, f, opacity) => {
    const { nx, ny, cell } = model;
    const corner = (ix, iy) => {
      const p = fit.apply({ x: model.bounds.minX + ix * cell, y: model.bounds.minY + iy * cell });
      return `${X(p.x, f).toFixed(1)},${Y(p.y, row).toFixed(1)}`;
    };
    for (let j = 0; j < ny; j++) {
      let i = 0;
      while (i < nx) {
        const v = floor.inside[j * nx + i] ? valueOf(j * nx + i) : null;
        if (v === null) {
          i++;
          continue;
        }
        let e = i + 1;
        while (e < nx && floor.inside[j * nx + e] && valueOf(j * nx + e) === v) e++;
        out.push(`<polygon points="${corner(i, j)} ${corner(e, j)} ${corner(e, j + 1)} ${corner(i, j + 1)}" fill="${v}" fill-opacity="${opacity}" stroke="${v}" stroke-opacity="${opacity}" stroke-width="0.4"/>`);
        i = e;
      }
    }
  };
  const truePlan = (k, row, withNames) => {
    for (const w of world.wallsOn(k)) {
      out.push(`<line x1="${X(w.x1, k).toFixed(1)}" y1="${Y(w.y1, row).toFixed(1)}" x2="${X(w.x2, k).toFixed(1)}" y2="${Y(w.y2, row).toFixed(1)}" ${TRUE_WALL[w.material]} stroke-linecap="round"/>`);
    }
    if (!withNames) return;
    for (const r of world.roomsOn(k)) {
      out.push(`<text x="${X(r.centroid.x, k).toFixed(1)}" y="${(Y(r.centroid.y, row) + 14).toFixed(1)}" font-size="10" font-style="italic" text-anchor="middle" fill="${INK.muted}">${esc(r.name)}</text>`);
    }
  };
  const routers = (k, row) => {
    const seen = new Set();
    for (const ap of world.aps) {
      if (!ap.own || seen.has(ap.device) || Math.max(0, Math.min(world.floors - 1, Math.floor(ap.z / FLOOR_HEIGHT))) !== k) continue;
      seen.add(ap.device);
      const ax = X(ap.x, k);
      const ay = Y(ap.y, row);
      const guess = model.aps.find((a) => a.bssids.includes(ap.bssid));
      if (guess) {
        const g = fit.apply(guess);
        const gx = Math.max(6, Math.min(W - 6, X(g.x, k)));
        const gy = Math.max(top, Math.min(H - legendH, Y(g.y, row)));
        out.push(
          `<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${gx.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${AP_COLOR}" stroke-width="1"/>`,
          `<circle cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" r="6" fill="${INK.surface}" stroke="${AP_COLOR}" stroke-width="2"><title>${esc(guess.ssid || '(oculta)')} estimado · andar ${guess.floor} · ${guess.inside ? 'dentro' : 'fora'} · erro ${br(Math.hypot(g.x - ap.x, g.y - ap.y))} m</title></circle>`,
        );
      }
      out.push(`<rect x="${(ax - 5).toFixed(1)}" y="${(ay - 5).toFixed(1)}" width="10" height="10" rx="2" fill="${AP_COLOR}" stroke="${INK.surface}" stroke-width="1.5"><title>${esc(ap.ssid || '(oculta)')} · posição real</title></rect>`);
    }
  };

  for (let k = 0; k < world.floors; k++) {
    const fi = model.floors.findIndex((f) => f.floor === k - startFloor);
    const floor = fi >= 0 ? model.floors[fi] : null;
    const title = world.floors > 1 ? (k === 0 ? 'Térreo · ' : `${k}º andar · `) : '';
    out.push(
      `<text x="${X(b.minX - margin, k) + 4}" y="${Y(b.maxY + margin, 0) + 12}" font-size="11" fill="${INK.text2}">${title}ambientes e divisões estimados sobre a planta real</text>`,
      `<text x="${X(b.minX - margin, k) + 4}" y="${Y(b.maxY + margin, 1) + 12}" font-size="11" fill="${INK.text2}">${title}sinal estimado${net ? ` de "${esc(net.ssid)}"` : ''} e medições</text>`,
    );
    // Contorno real, bem claro, por baixo de tudo (mostra o que o mapa deixou de fora).
    for (const row of [0, 1]) {
      out.push(`<polygon points="${world.outline(k).map((p) => `${X(p[0], k).toFixed(1)},${Y(p[1], row).toFixed(1)}`).join(' ')}" fill="${INK.room}"/>`);
    }
    if (floor) {
      // --- linha 0: ambientes ---
      const colours = roomColours(model, floor);
      runs(floor, (c) => colours[floor.room[c]] || ROOM_EXTRA, 0, k, 0.32);
    }
    truePlan(k, 0, true);
    if (floor) {
      for (const ring of floor.outline) {
        out.push(`<polygon points="${ring.map((p) => fit.apply({ x: p[0], y: p[1] })).map((p) => `${X(p.x, k).toFixed(1)},${Y(p.y, 0).toFixed(1)}`).join(' ')}" fill="none" stroke="${OUTLINE_COLOR}" stroke-width="2" stroke-linejoin="round"/>`);
      }
      for (const w of floor.walls) {
        if (w.kind !== 'inner') continue;
        const p1 = fit.apply({ x: w.x1, y: w.y1 });
        const p2 = fit.apply({ x: w.x2, y: w.y2 });
        out.push(`<line x1="${X(p1.x, k).toFixed(1)}" y1="${Y(p1.y, 0).toFixed(1)}" x2="${X(p2.x, k).toFixed(1)}" y2="${Y(p2.y, 0).toFixed(1)}" stroke="${WALL_COLOR}" stroke-width="3" stroke-opacity="${(0.25 + 0.75 * w.conf).toFixed(2)}" stroke-linecap="round"><title>divisão estimada · confiança ${br(w.conf)}</title></line>`);
      }
      for (const p of model.path) {
        if (p.floor !== floor.floor) continue;
        const q = fit.apply(p);
        out.push(`<circle cx="${X(q.x, k).toFixed(1)}" cy="${Y(q.y, 0).toFixed(1)}" r="1.6" fill="${INK.text2}" fill-opacity="0.55"/>`);
      }
      for (const r of floor.rooms) {
        const q = fit.apply({ x: r.cx, y: r.cy });
        out.push(`<text x="${X(q.x, k).toFixed(1)}" y="${Y(q.y, 0).toFixed(1)}" font-size="11" font-weight="600" text-anchor="middle" fill="${INK.text}" stroke="${INK.surface}" stroke-width="2.5" paint-order="stroke">${esc(r.label)}<title>${esc(r.label)} · ${br(r.areaM2, 1)} m² · ${r.scans} varreduras</title></text>`);
      }
    }
    routers(k, 0);

    // --- linha 1: sinal ---
    if (floor && net) {
      const field = heatField(model, fi, net.key);
      runs(floor, (c) => (field.dbm[c] === field.dbm[c] ? heatColor(field.dbm[c]) : null), 1, k, 1);
      truePlan(k, 1, false);
      const values = model._heat.nets[net.key];
      model.path.forEach((p, idx) => {
        if (p.floor !== floor.floor || values[idx] !== values[idx]) return;
        const q = fit.apply(p);
        out.push(`<circle cx="${X(q.x, k).toFixed(1)}" cy="${Y(q.y, 1).toFixed(1)}" r="4" fill="${heatColor(values[idx])}" stroke="${INK.surface}" stroke-width="1.5"><title>varredura ${p.i + 1} · ${br(values[idx], 0)} dBm medido</title></circle>`);
      });
    } else truePlan(k, 1, false);
    routers(k, 1);
  }

  // Legenda.
  const ly = top + 2 * panelH + rowGap + 22;
  let lx = 12;
  const item = (mark, label, width) => {
    out.push(mark(lx, ly), `<text x="${lx + 22}" y="${ly + 4}" font-size="11" fill="${INK.text2}">${label}</text>`);
    lx += width;
  };
  item((x, y) => `<line x1="${x}" y1="${y}" x2="${x + 16}" y2="${y}" stroke="#6b6a65" stroke-width="2.5"/>`, 'parede real', 96);
  item((x, y) => `<line x1="${x}" y1="${y}" x2="${x + 16}" y2="${y}" stroke="${OUTLINE_COLOR}" stroke-width="2"/>`, 'contorno estimado', 132);
  item((x, y) => `<line x1="${x}" y1="${y}" x2="${x + 16}" y2="${y}" stroke="${WALL_COLOR}" stroke-width="3"/>`, 'divisão estimada (mais forte = mais confiança)', 276);
  item((x, y) => `<rect x="${x + 3}" y="${y - 5}" width="10" height="10" rx="2" fill="${AP_COLOR}"/>`, 'roteador real', 104);
  item((x, y) => `<circle cx="${x + 8}" cy="${y}" r="5" fill="${INK.surface}" stroke="${AP_COLOR}" stroke-width="2"/>`, 'roteador estimado', 130);
  item((x, y) => `<circle cx="${x + 8}" cy="${y}" r="1.6" fill="${INK.text2}"/>`, 'varredura (posição estimada)', 180);
  lx = 12;
  const ly2 = ly + 24;
  out.push(`<text x="${lx}" y="${ly2 + 4}" font-size="11" fill="${INK.text2}">sinal:</text>`);
  lx += 40;
  for (const bin of [...HEAT_BINS].reverse()) {
    out.push(`<rect x="${lx}" y="${ly2 - 6}" width="14" height="12" fill="${bin.color}" stroke="${INK.truth}" stroke-width="0.5"/>`, `<text x="${lx + 20}" y="${ly2 + 4}" font-size="11" fill="${INK.text2}">${bin.label}</text>`);
    lx += 34 + bin.label.length * 6;
  }
  out.push(`<text x="12" y="${ly2 + 22}" font-size="11" fill="${INK.muted}">as cores dos ambientes só separam vizinhos · nome em negrito = ambiente do mapa · nome em itálico = cômodo real</text>`);
  out.push('</svg>');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

/**
 * Roda a bancada do mapa.
 * @param {Object} run  truth, solverPath, exportName, only, jobs, budgetMs, cacheDir, svgDir, noise, labels, own, tune, onResult
 */
export async function runMapBench(run) {
  let scenarios = listMapScenarios(run.set || 'dev');
  if (run.only) scenarios = scenarios.filter((s) => s.name.includes(run.only));
  if (!scenarios.length) throw new Error(`nenhum cenário tem "${run.only}" no nome`);
  const source = run.truth ? (run.noise > 0 ? `posições reais + ruído de ${run.noise} m` : 'posições reais') : `solucionador ${path.basename(run.solverPath)}`;
  const results = new Array(scenarios.length);
  let next = 0;
  let printed = 0;
  const flush = () => {
    while (printed < results.length && results[printed]) {
      if (run.onResult) run.onResult(results[printed]);
      printed++;
    }
  };
  const one = async (desc) => {
    const scenario = buildScenario(desc);
    const base = { name: desc.name, group: desc.group, mode: desc.mode, scans: scenario.survey.scans.length, source };
    let solution;
    let solveMs = null;
    if (run.truth) solution = truthSolution(scenario, run.noise || 0);
    else {
      const reply = await solveCached(run, desc, structuredClone(scenario.survey));
      if (!reply.ok) return { ...base, ok: false, error: reply.error };
      solution = reply.solution;
      solveMs = reply.ms;
    }
    try {
      // Posições reais + ruído NÃO são uma estimativa encolhida (o ruído soma espalhamento em vez de
      // tirar): a correção de tamanho do construtor (alcance alargado pelo erro) não se aplica a elas.
      const tune = run.truth && run.noise > 0 ? { areaErr: 0, ...run.tune } : run.tune;
      const evaluated = evaluateMap(scenario, solution, { labels: run.labels, autoRooms: run.autoRooms, own: run.own, tune });
      const result = { ...base, ok: true, solveMs, ...evaluated.metrics };
      if (run.svgDir) {
        fs.mkdirSync(run.svgDir, { recursive: true });
        fs.writeFileSync(path.join(run.svgDir, `${desc.name}.svg`), renderMapSvg(scenario, evaluated, result));
      }
      if (run.describe) result.description = describeMap(evaluated.model);
      if (evaluated.net) {
        const cov = coverage(evaluated.model, evaluated.net.key);
        result.coverage = { good: cov.good, fair: cov.fair, weak: cov.weak, dead: cov.dead, deadZones: cov.deadZones.length };
        const tip = suggestRouterSpot(evaluated.model, evaluated.net.key);
        result.suggestion = tip ? (tip.currentIsCentral ? 'central' : 'mudar') : 'nada';
      }
      return result;
    } catch (err) {
      return { ...base, ok: false, error: String((err && err.stack) || err) };
    }
  };
  const jobs = Math.max(1, Math.min(run.truth ? 1 : (run.jobs ?? 2), scenarios.length));
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < scenarios.length) {
        const i = next++;
        results[i] = await one(scenarios[i]);
        flush();
      }
    }),
  );
  const by = (key) => {
    const groups = {};
    for (const r of results) (groups[r[key]] ||= []).push(r);
    return Object.fromEntries(Object.entries(groups).map(([k, list]) => [k, summarise(list)]));
  };
  return { source, results, groups: by('group'), modes: by('mode'), total: summarise(results) };
}

const SUMMARY_KEYS = ['iou', 'ratio', 'scale', 'scaleRaw', 'ari', 'ariIn', 'rooms', 'roomsTrue', 'roomPurity', 'roomComplete', 'nameAcc', 'namedShare', 'heatRmse', 'heatRmseConf', 'heatBias', 'heatRmseFree', 'heatBiasFree', 'heatConfShare', 'routerErr', 'wallP', 'wallPConf', 'wallR', 'expErr', 'realErr', 'buildMs', 'heatMs'];

/** Médias das medidas de uma lista de resultados (as falhas ficam de fora e são contadas). */
export function summarise(list) {
  const ok = list.filter((r) => r.ok);
  const out = { count: list.length, failures: list.length - ok.length };
  for (const key of SUMMARY_KEYS) {
    const values = ok.map((r) => r[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    out[key] = values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  }
  out.maxBuildMs = ok.length ? Math.max(...ok.map((r) => r.buildMs)) : null;
  out.maxHeatMs = ok.length ? Math.max(...ok.map((r) => r.heatMs)) : null;
  return out;
}

// ---------------------------------------------------------------------------
// Linha de comando
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { exportName: 'solve', budgetMs: DEFAULT_BUDGET_MS, jobs: 2, tune: {}, own: 'track' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`falta o valor de ${a}`);
      return argv[++i];
    };
    if (a === '--truth') args.truth = true;
    else if (a === '--solver') args.solverPath = value();
    else if (a === '--export') args.exportName = value();
    else if (a === '--only') args.only = value();
    else if (a === '--set') args.set = value();
    else if (a === '--json') args.json = true;
    else if (a === '--svg') args.svgDir = value();
    else if (a === '--jobs') args.jobs = Number(value());
    else if (a === '--budget-ms') args.budgetMs = Number(value());
    else if (a === '--cache') args.cacheDir = value();
    else if (a === '--noise') args.noise = Number(value());
    else if (a === '--no-labels') args.labels = false;
    else if (a === '--auto-rooms') args.autoRooms = true;
    else if (a === '--own') args.own = value();
    else if (a === '--describe') args.describe = true;
    else if (a === '--param') {
      const [k, v] = value().split('=');
      if (!k || !Number.isFinite(Number(v))) throw new Error('--param espera chave=número');
      args.tune[k] = Number(v);
    } else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`opção desconhecida: ${a}`);
  }
  if (!Number.isFinite(args.jobs) || args.jobs < 1) throw new Error('--jobs precisa ser 1 ou mais');
  if (!Number.isFinite(args.budgetMs) || args.budgetMs <= 0) throw new Error('--budget-ms precisa ser um número positivo');
  if (args.noise !== undefined && !(args.noise >= 0)) throw new Error('--noise precisa ser um número de metros');
  if (!['track', 'all'].includes(args.own)) throw new Error('--own aceita track ou all');
  if (args.set !== undefined && !['dev', 'val'].includes(args.set)) throw new Error('--set aceita dev ou val (o holdout é só para julgar solucionadores)');
  return args;
}

// Desenhos e soluções guardadas nunca vão para dentro do repositório.
function assertOutsideRepo(dir, flag) {
  let root = path.resolve(HERE, '..', '..');
  for (let p = root; ; p = path.dirname(p)) {
    if (fs.existsSync(path.join(p, '.git'))) root = p;
    if (p === path.dirname(p)) break;
  }
  const rel = path.relative(root, path.resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error(`${flag}: escolha uma pasta fora do repositório (${root})`);
}

const HELP = `Bancada do construtor do mapa (mapmodel.js)

  node tests/mapping/map-eval.mjs [opções]

  --truth              usa as posições reais como solução (isola o erro do construtor)
  --noise <m>          com --truth: soma um erro suave de <m> metros às posições reais
  --solver <caminho>   módulo que exporta solve(survey, options) (padrão: solver.js ou candidates/geo.js)
  --export <nome>      nome da função exportada (padrão: solve)
  --set dev|val        dev (padrão): os 32 cenários de desenvolvimento; val: outras sementes e casas
                       sorteadas, para conferir que um ajuste do construtor não é decoreba do dev
  --only <trecho>      só os cenários cujo nome contém o trecho
  --jobs <n>           solucionadores em paralelo (padrão: 2; a máquina é compartilhada)
  --budget-ms <n>      tempo máximo do solucionador por cenário (padrão: ${DEFAULT_BUDGET_MS})
  --cache <pasta>      guarda/reaproveita a solução de cada cenário (fora do repositório)
  --svg <pasta>        grava um desenho por cenário (fora do repositório)
  --json               imprime tudo em JSON
  --no-labels          ignora os nomes dos pontos marcados (o mapa sai sem divisão em ambientes)
  --auto-rooms         força o agrupamento automático em ambientes mesmo sem nomes (o app não faz isso:
                       serve para medir de novo por que não faz)
  --own track|all      quais BSSIDs entram como "da casa": a rede conectada (padrão) ou todos os do roteador
  --describe           inclui describeMap() de cada cenário no JSON
  --param chave=valor  troca uma constante do construtor (experimentos)
`;

function f(v, width, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '–'.padStart(width);
  let text = v.toFixed(digits);
  for (let d = digits - 1; text.length > width - 1 && d >= 0; d--) text = v.toFixed(d);
  return text.padStart(width);
}

const HEADER =
  'cenário'.padEnd(32) + ' var' + '   IoU' + ' razão' + '   esc' + '   ARI' + ' ARIin' + '   amb' + ' calor' + '  c>.5' + '  viés' + '   rot' + '  parP' + ' parPc' + '  parR' + '  errE' + '  errR' + '  mapa ms' + ' calor ms';

function row(r) {
  if (!r.ok) return `${r.name.padEnd(32)}${String(r.scans).padStart(4)}  FALHOU: ${String(r.error).split('\n')[0].slice(0, 100)}`;
  return (
    r.name.padEnd(32) +
    String(r.scans).padStart(4) +
    f(r.iou, 6) +
    f(r.ratio, 6) +
    f(r.scale, 6) +
    f(r.ari, 6) +
    f(r.ariIn, 6) +
    `${r.rooms}/${r.roomsTrue}`.padStart(6) +
    f(r.heatRmse, 6, 1) +
    f(r.heatRmseConf, 6, 1) +
    f(r.heatBias, 6, 1) +
    f(r.routerErr, 6, 1) +
    f(r.wallP, 6) +
    f(r.wallPConf, 6) +
    f(r.wallR, 6) +
    f(r.expErr, 6, 1) +
    f(r.realErr, 6, 1) +
    f(r.buildMs, 9, 0) +
    f(r.heatMs, 9, 1)
  );
}

const SUMMARY_HEADER =
  'grupo'.padEnd(18) + '  n' + ' falhas' + '   IoU' + ' razão' + '   esc' + '   ARI' + ' ARIin' + '      amb' + ' calor' + '  c>.5' + '  viés' + '   rot' + '  parP' + ' parPc' + '  parR' + '  errE' + '  errR' + '  mapa ms' + ' calor ms';

function summaryRow(name, a) {
  return (
    name.padEnd(18) +
    String(a.count).padStart(3) +
    String(a.failures).padStart(7) +
    f(a.iou, 6) +
    f(a.ratio, 6) +
    f(a.scale, 6) +
    f(a.ari, 6) +
    f(a.ariIn, 6) +
    `${f(a.rooms, 4, 1)}/${f(a.roomsTrue, 4, 1).trim()}`.padStart(9) +
    f(a.heatRmse, 6, 1) +
    f(a.heatRmseConf, 6, 1) +
    f(a.heatBias, 6, 1) +
    f(a.routerErr, 6, 1) +
    f(a.wallP, 6) +
    f(a.wallPConf, 6) +
    f(a.wallR, 6) +
    f(a.expErr, 6, 1) +
    f(a.realErr, 6, 1) +
    f(a.buildMs, 9, 0) +
    f(a.heatMs, 9, 1)
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (!args.truth) {
    args.solverPath = path.resolve(args.solverPath || defaultSolver());
    if (!fs.existsSync(args.solverPath)) throw new Error(`módulo não encontrado: ${args.solverPath}`);
    args.solverHash = crypto.createHash('sha1').update(fs.readFileSync(args.solverPath)).digest('hex').slice(0, 10);
  }
  if (args.svgDir) assertOutsideRepo(args.svgDir, '--svg');
  if (args.cacheDir) assertOutsideRepo(args.cacheDir, '--cache');

  const started = performance.now();
  if (!args.json) {
    console.log(`mapa a partir de: ${args.truth ? (args.noise > 0 ? `posições reais + ruído de ${args.noise} m` : 'posições reais') : `${args.solverPath}#${args.exportName}`}${args.labels === false ? ' · sem nomes' : ''}`);
    console.log('distâncias em metros, sinal em dB · ARI: 1 = ambientes iguais aos cômodos, 0 = ao acaso');
    console.log(HEADER);
  }
  const bench = await runMapBench({ ...args, onResult: args.json ? null : (r) => console.log(row(r)) });
  if (args.json) {
    console.log(JSON.stringify({ ...bench, wallMs: Math.round(performance.now() - started) }, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2));
    return;
  }
  console.log('\nresumo (médias)');
  console.log(SUMMARY_HEADER);
  for (const [name, a] of Object.entries(bench.groups)) console.log(summaryRow(name, a));
  console.log('');
  for (const [name, a] of Object.entries(bench.modes)) console.log(summaryRow(name, a));
  console.log('');
  console.log(summaryRow('TOTAL', bench.total));
  console.log(`\n${bench.results.length} cenários, ${bench.total.failures} falhas, ${((performance.now() - started) / 1000).toFixed(1)} s · buildMap: máximo ${f(bench.total.maxBuildMs, 1, 0).trim()} ms · heatField: máximo ${f(bench.total.maxHeatMs, 1, 1).trim()} ms`);
  if (args.svgDir) console.log(`desenhos em ${path.resolve(args.svgDir)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`erro: ${err.message}`);
    process.exitCode = 1;
  });
}
