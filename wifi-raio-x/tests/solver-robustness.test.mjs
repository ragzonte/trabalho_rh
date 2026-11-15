// Robustez do solucionador do mapa (app/js/mapping/solver.js) contra o mundo real.
//
// O solucionador roda num Web Worker no celular do usuário, com levantamentos bem mais sujos do que
// os do simulador. Aqui:
//   1. FUZZ: levantamentos sintéticos estragados de dezenas de jeitos (campos faltando, tipos errados,
//      tempos negativos/NaN/repetidos/fora de ordem, andares e pontos marcados absurdos, leituras com
//      lixo, distâncias medidas inválidas, solução anterior corrompida...). Exigência: nunca lança
//      erro, nunca trava, devolve um ponto finito por varredura e não mexe na entrada. Roda numa
//      thread à parte, com corte de tempo: um laço infinito derruba o teste em vez de pendurá-lo.
//   2. REGRESSÕES dos defeitos achados na revisão (cada teste diz qual era o defeito).
//   3. REALISMO que o simulador não tem (rede que liga no meio, usuário parado, levantamento enorme,
//      prédio com centenas de redes): degradar com elegância em vez de desabar.
//
// Mais casos de fuzz:   WRX_FUZZ_CASES=2000 WRX_FUZZ_SEED=7 node --test tests/solver-robustness.test.mjs
// No Chromium (opcional, precisa do Playwright):   WRX_BROWSER=1 node --test tests/solver-robustness.test.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { solve, solveQuick } from '../app/js/mapping/solver.js';
import { FLOOR_HEIGHT } from '../app/js/mapping/types.js';

// ---------------------------------------------------------------------------
// Gerador: levantamento sintético com geometria de verdade + mutações
// ---------------------------------------------------------------------------

function rngOf(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    f: (lo = 0, hi = 1) => lo + (hi - lo) * next(),
    i: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    gauss: () => {
      let s = 0;
      for (let k = 0; k < 6; k++) s += next();
      return (s - 3) * Math.SQRT2;
    },
  };
  return r;
}

const hex = (v) => v.toString(16).padStart(2, '0');

/** Levantamento sintético com geometria de verdade (lei de distância + ruído). */
function synth(rng, o = {}) {
  const nScans = o.scans ?? 40;
  const nAps = o.aps ?? 10;
  const cadence = o.cadence ?? 3.5;
  const size = o.size ?? 8;
  const floors = o.floors ?? [0];
  const mode = o.mode ?? 'walk'; // walk | spots | mixed
  const stale = o.stale ?? true;
  const perSpot = o.perSpot ?? 3;
  const aps = {};
  const boxes = [];
  for (let k = 0; k < nAps; k++) {
    const inside = k < Math.max(1, Math.round(nAps * 0.15));
    const reach = inside ? size : 3 * size;
    const box = { x: rng.f(-reach + size, reach), y: rng.f(-reach + size, reach), floor: rng.pick(floors), p0: rng.f(-45, -33), n: rng.f(2.2, 3.4), ids: [] };
    const dev = `d${k + 1}`;
    const mac = `${hex(rng.i(0, 255))}:${hex(rng.i(0, 255))}:${hex(k & 255)}:${hex((k >> 8) & 255)}`;
    const f24 = rng.pick([2412, 2437, 2462]);
    box.ids.push({ id: `${mac}:00`, freq: f24, drop: 0 });
    aps[`${mac}:00`] = { ssid: `rede-${k}`, freq: f24, device: dev };
    if (rng.chance(0.6)) {
      box.ids.push({ id: `${mac}:04`, freq: 5180, drop: 7 });
      aps[`${mac}:04`] = { ssid: `rede-${k}-5G`, freq: 5180, device: dev };
    }
    boxes.push(box);
  }
  const scans = [];
  const track = [];
  const truth = [];
  let x = rng.f(1, size - 1);
  let y = rng.f(1, size - 1);
  let dir = rng.f(0, 6.28);
  let t = rng.f(1, 4);
  let floorAt = 0;
  let spotId = 0;
  let prev = null;
  const home = boxes[0].ids[0];
  for (let i = 0; i < nScans; ) {
    const floor = floors[Math.min(floors.length - 1, Math.floor((i / nScans) * floors.length))];
    floorAt = floor;
    const still = mode === 'spots' || (mode === 'mixed' && rng.chance(0.3));
    const reps = still ? perSpot : 1;
    const spot = still ? ++spotId : null;
    for (let r = 0; r < reps && i < nScans; r++, i++) {
      const readings = [];
      for (const b of boxes) {
        const dz = (b.floor - floorAt) * 2.8;
        const d = Math.max(0.5, Math.hypot(b.x - x, b.y - y, dz));
        for (const q of b.ids) {
          const v = b.p0 - q.drop - 10 * b.n * Math.log10(d) - 12 * Math.abs(b.floor - floorAt) + 3 * rng.gauss();
          if (v > -90 && rng.chance(0.93)) readings.push({ id: q.id, rssi: Math.round(v), freq: q.freq, ageMs: Math.round(rng.f(200, 2800)) });
          else if (stale && prev && rng.chance(0.25)) {
            const old = prev.readings.find((p) => p.id === q.id);
            if (old) readings.push({ ...old, ageMs: Math.round(old.ageMs + (t - prev.t) * 1000) });
          }
        }
      }
      const scan = { t: Math.round(t * 1000) / 1000, floor: floorAt, still, spot, readings };
      if (still && rng.chance(0.7)) scan.label = `Ponto ${spot}`;
      scans.push(scan);
      truth.push({ x, y });
      prev = scan;
      const dh = Math.max(0.5, Math.hypot(boxes[0].x - x, boxes[0].y - y));
      for (let tt = t - cadence + 1; tt <= t; tt += 2) if (tt > 0) track.push({ t: Math.round(tt * 100) / 100, id: home.id, rssi: Math.round(boxes[0].p0 - 10 * boxes[0].n * Math.log10(dh) + 2 * rng.gauss()) });
      t += cadence * rng.f(0.9, 1.1);
    }
    // anda até o próximo
    const walkS = still ? rng.f(3, 9) : cadence;
    if (still) t += walkS;
    const dist = 0.6 * Math.min(walkS, 10);
    dir += rng.f(-0.9, 0.9);
    let nx = x + dist * Math.cos(dir);
    let ny = y + dist * Math.sin(dir);
    if (nx < 0.3 || nx > size - 0.3) {
      dir = Math.PI - dir;
      nx = Math.min(size - 0.3, Math.max(0.3, nx));
    }
    if (ny < 0.3 || ny > size - 0.3) {
      dir = -dir;
      ny = Math.min(size - 0.3, Math.max(0.3, ny));
    }
    x = nx;
    y = ny;
  }
  return { survey: { version: 1, scans, aps, track }, truth };
}

const JUNK = [NaN, Infinity, -Infinity, null, undefined, '', 'x', '12', {}, [], true, false, 0, -1, 1e300, -1e300, 1e-300, 2 ** 53, () => 1];

// Mutações: cada uma estraga o levantamento de um jeito que um aparelho ou um arquivo corrompido poderia.
const MUTATORS = {
  dropScanFields(rng, s) {
    for (const sc of s.scans) if (sc && rng.chance(0.3)) delete sc[rng.pick(['t', 'floor', 'still', 'spot', 'readings', 'label'])];
  },
  junkScanFields(rng, s) {
    for (const sc of s.scans) if (sc && rng.chance(0.25)) sc[rng.pick(['t', 'floor', 'still', 'spot', 'readings', 'label'])] = rng.pick(JUNK);
  },
  junkScans(rng, s) {
    for (let i = 0; i < s.scans.length; i++) if (rng.chance(0.15)) s.scans[i] = rng.pick(JUNK);
  },
  junkReadings(rng, s) {
    for (const sc of s.scans) {
      if (!sc || !Array.isArray(sc.readings)) continue;
      for (let j = 0; j < sc.readings.length; j++) {
        if (!rng.chance(0.2)) continue;
        if (rng.chance(0.3)) sc.readings[j] = rng.pick(JUNK);
        else sc.readings[j] = { ...sc.readings[j], [rng.pick(['id', 'rssi', 'freq', 'ageMs'])]: rng.pick(JUNK) };
      }
    }
  },
  timesNegative(rng, s) {
    for (const sc of s.scans) if (sc) sc.t = -sc.t - 1000;
  },
  timesReversed(rng, s) {
    const ts = s.scans.map((sc) => sc && sc.t).reverse();
    s.scans.forEach((sc, i) => sc && (sc.t = ts[i]));
  },
  timesShuffled(rng, s) {
    for (const sc of s.scans) if (sc && rng.chance(0.4)) sc.t = rng.f(-50, 500);
  },
  timesDuplicated(rng, s) {
    let last = 0;
    for (const sc of s.scans) {
      if (!sc) continue;
      if (rng.chance(0.6)) sc.t = last;
      else last = sc.t;
    }
  },
  timesAllEqual(rng, s) {
    const v = rng.pick([0, 7, -3, 1e9]);
    for (const sc of s.scans) if (sc) sc.t = v;
  },
  timesEpochMs(rng, s) {
    for (const sc of s.scans) if (sc && Number.isFinite(sc.t)) sc.t = 1.7e12 + sc.t * 1000;
  },
  timesTiny(rng, s) {
    for (const sc of s.scans) if (sc && Number.isFinite(sc.t)) sc.t *= 1e-6;
  },
  timesHugeGaps(rng, s) {
    let add = 0;
    for (const sc of s.scans) {
      if (!sc || !Number.isFinite(sc.t)) continue;
      if (rng.chance(0.1)) add += rng.pick([600, 3600, 86400, 1e7]);
      sc.t += add;
    }
  },
  timesJunk(rng, s) {
    for (const sc of s.scans) if (sc && rng.chance(0.3)) sc.t = rng.pick([NaN, Infinity, -Infinity, '5', null, 1e300, -1e300]);
  },
  rssiJunk(rng, s) {
    for (const sc of s.scans) for (const r of (sc && Array.isArray(sc.readings) ? sc.readings : [])) if (r && rng.chance(0.3)) r.rssi = rng.pick([NaN, Infinity, -Infinity, 0, 20, 21, -150, -151, 5, -200, '−50', -50.5, 1e9]);
  },
  rssiIdentical(rng, s) {
    const v = rng.pick([-50, -90, 0, -150, 20]);
    for (const sc of s.scans) for (const r of (sc && Array.isArray(sc.readings) ? sc.readings : [])) if (r) r.rssi = v;
  },
  rssiIdenticalPerAp(rng, s) {
    const level = new Map();
    for (const sc of s.scans) for (const r of (sc && Array.isArray(sc.readings) ? sc.readings : [])) {
      if (!r) continue;
      if (!level.has(r.id)) level.set(r.id, r.rssi);
      r.rssi = level.get(r.id);
    }
  },
  ageJunk(rng, s) {
    for (const sc of s.scans) for (const r of (sc && Array.isArray(sc.readings) ? sc.readings : [])) if (r && rng.chance(0.4)) r.ageMs = rng.pick([NaN, -500, Infinity, 1e12, '300', null, 0, 4499, 4501, 60000]);
  },
  ageAllStale(rng, s) {
    for (const sc of s.scans) for (const r of (sc && Array.isArray(sc.readings) ? sc.readings : [])) if (r) r.ageMs = 90000;
  },
  ageAbsent(rng, s) {
    for (const sc of s.scans) for (const r of (sc && Array.isArray(sc.readings) ? sc.readings : [])) if (r) delete r.ageMs;
  },
  oneReadingEach(rng, s) {
    for (const sc of s.scans) if (sc && Array.isArray(sc.readings) && sc.readings.length) sc.readings = [rng.pick(sc.readings)];
  },
  oneReadingTotal(rng, s) {
    let kept = false;
    for (const sc of s.scans) {
      if (!sc || !Array.isArray(sc.readings)) continue;
      if (!kept && sc.readings.length && rng.chance(0.3)) {
        sc.readings = [sc.readings[0]];
        kept = true;
      } else sc.readings = [];
    }
  },
  noReadings(rng, s) {
    for (const sc of s.scans) if (sc) sc.readings = [];
  },
  floorsSparse(rng, s) {
    const set = rng.pick([[0, 3, -2], [0, 3], [-2, 5, 9], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [100, -20, 200]]);
    const n = s.scans.length;
    s.scans.forEach((sc, i) => sc && (sc.floor = set[Math.min(set.length - 1, Math.floor((i / n) * set.length))]));
  },
  floorsRandom(rng, s) {
    for (const sc of s.scans) if (sc) sc.floor = rng.i(-25, 60);
  },
  floorsMany(rng, s) {
    s.scans.forEach((sc, i) => sc && (sc.floor = i % rng.pick([31, 40, 64, 200])));
  },
  floorsJunk(rng, s) {
    for (const sc of s.scans) if (sc && rng.chance(0.4)) sc.floor = rng.pick([NaN, '1', 'térreo', 1.5, -0.5, null, {}, 1e300, -Infinity, true]);
  },
  spotsSingle(rng, s) {
    s.scans.forEach((sc, i) => sc && ((sc.spot = i + 1), (sc.still = true)));
  },
  spotsReused(rng, s) {
    const k = rng.pick([1, 2, 3, 5]);
    s.scans.forEach((sc, i) => sc && ((sc.spot = (i % k) + 1), (sc.still = true)));
  },
  spotsReusedBlocks(rng, s) {
    const n = s.scans.length;
    s.scans.forEach((sc, i) => {
      if (!sc) return;
      const u = i / n;
      if (u < 0.1 || u > 0.9) {
        sc.spot = 77;
        sc.still = true;
      }
    });
  },
  spotsAllSame(rng, s) {
    for (const sc of s.scans) if (sc) (sc.spot = rng.pick([1, 'a', 0])), (sc.still = true);
  },
  spotsJunk(rng, s) {
    for (const sc of s.scans) if (sc && rng.chance(0.4)) sc.spot = rng.pick([NaN, 'sala', '', {}, [], true, false, 0, -1, 1.5, 1e300, '__proto__']);
  },
  spotsAcrossFloors(rng, s) {
    s.scans.forEach((sc, i) => sc && ((sc.spot = (i % 4) + 1), (sc.floor = i % 3), (sc.still = true)));
  },
  labelsWeird(rng, s) {
    for (const sc of s.scans) if (sc) sc.label = rng.pick(['🛋️ Sala 🛋️', 'x'.repeat(100000), '', 'Quarto\u0000\n', '‮abc', 12, null, {}]);
  },
  knownJunk(rng, s) {
    const n = s.scans.length;
    s.knownDistances = [];
    for (let k = 0; k < rng.i(1, 12); k++) {
      s.knownDistances.push(
        rng.pick([
          null,
          5,
          {},
          { a: 0, b: 0, meters: 3 },
          { a: -1, b: 2, meters: 3 },
          { a: 0, b: n, meters: 3 },
          { a: 0, b: n + 1000, meters: 3 },
          { a: 0, b: Math.max(0, n - 1), meters: 1e9 },
          { a: 0, b: Math.max(0, n - 1), meters: 1e308 },
          { a: 0, b: Math.max(0, n - 1), meters: 1e-9 },
          { a: 0, b: Math.max(0, n - 1), meters: -4 },
          { a: 0, b: Math.max(0, n - 1), meters: NaN },
          { a: 0, b: Math.max(0, n - 1), meters: '4' },
          { a: '0', b: '3', meters: 4 },
          { a: 0.5, b: 3, meters: 4 },
          { a: rng.i(0, Math.max(0, n - 1)), b: rng.i(0, Math.max(0, n - 1)), meters: rng.f(0.01, 40) },
          { a: rng.i(0, Math.max(0, n - 1)), b: rng.i(0, Math.max(0, n - 1)), meters: rng.f(0.01, 40) },
          { a: rng.i(0, Math.max(0, n - 1)), b: rng.i(0, Math.max(0, n - 1)), meters: 500 },
        ]),
      );
    }
    if (rng.chance(0.2)) s.knownDistances = rng.pick([null, 'x', {}, 7]);
  },
  knownMany(rng, s) {
    const n = s.scans.length;
    s.knownDistances = [];
    for (let k = 0; k < 300; k++) s.knownDistances.push({ a: rng.i(0, Math.max(0, n - 1)), b: rng.i(0, Math.max(0, n - 1)), meters: rng.f(0.5, 12) });
  },
  apsMissingSome(rng, s) {
    for (const id of Object.keys(s.aps || {})) if (rng.chance(0.5)) delete s.aps[id];
  },
  apsMissingAll(rng, s) {
    if (rng.chance(0.5)) delete s.aps;
    else s.aps = rng.pick([null, [], 'x', 3, {}]);
  },
  apsOneDevice(rng, s) {
    for (const a of Object.values(s.aps || {})) a.device = rng.pick(['d1', 'd1', 0, '']);
  },
  apsJunk(rng, s) {
    for (const id of Object.keys(s.aps || {})) if (rng.chance(0.5)) s.aps[id] = rng.pick([null, 3, 'x', {}, { freq: NaN }, { freq: 'x', device: {} }, { freq: -5, device: null }, { freq: 60000, device: 12 }, { freq: 5180, device: ['a'] }]);
  },
  idsWeird(rng, s) {
    const map = new Map();
    const pool = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', '0', '1', '🛜', 'a'.repeat(5000), 'AA:BB', 'aa:bb', 123, 1.5, true];
    for (const sc of s.scans) for (const r of (sc && Array.isArray(sc.readings) ? sc.readings : [])) {
      if (!r) continue;
      if (!map.has(r.id)) map.set(r.id, map.size < pool.length ? pool[map.size] : r.id);
      r.id = map.get(r.id);
    }
    for (const t of (Array.isArray(s.track) ? s.track : [])) if (t && map.has(t.id)) t.id = map.get(t.id);
  },
  trackOnly(rng, s) {
    for (const sc of s.scans) if (sc) sc.readings = [];
  },
  trackJunk(rng, s) {
    if (!Array.isArray(s.track)) s.track = [];
    for (let k = 0; k < 30; k++) s.track.splice(rng.i(0, s.track.length), 0, rng.pick([null, 4, {}, { t: NaN, id: 'x', rssi: -50 }, { t: 5, id: null, rssi: -50 }, { t: 5, id: 'desconhecida', rssi: -50 }, { t: -1e9, id: 'x', rssi: -50 }, { t: 1e300, id: 'x', rssi: 1e300 }, { t: 3, id: 'x', rssi: 'forte' }]));
    if (rng.chance(0.15)) s.track = rng.pick([null, 'x', {}, 7]);
  },
  trackShuffled(rng, s) {
    if (!Array.isArray(s.track)) return;
    for (let i = s.track.length - 1; i > 0; i--) {
      const j = rng.i(0, i);
      [s.track[i], s.track[j]] = [s.track[j], s.track[i]];
    }
  },
  trackHuge(rng, s) {
    const id = Object.keys(s.aps || {})[0] || 'x';
    const t1 = (s.scans[s.scans.length - 1] && s.scans[s.scans.length - 1].t) || 100;
    s.track = Array.from({ length: 40000 }, (_, i) => ({ t: (i / 40000) * t1, id, rssi: -50 - (i % 7) }));
  },
  trackMultiId(rng, s) {
    const ids = Object.keys(s.aps || {});
    if (!ids.length || !Array.isArray(s.track)) return;
    for (const t of s.track) if (t && rng.chance(0.3)) t.id = rng.pick(ids);
  },
  rttPresent(rng, s) {
    const id = Object.keys(s.aps || {})[0] || 'x';
    s.rtt = Array.from({ length: 50 }, (_, i) => rng.pick([{ t: i * 2, id, distM: rng.f(0.5, 9), stdM: 0.5 }, null, { t: NaN, id, distM: -1, stdM: NaN }]));
  },
  versionJunk(rng, s) {
    s.version = rng.pick([undefined, 2, '1', null]);
  },
  levelJump(rng, s) {
    const ids = Object.keys(s.aps || {});
    const id = ids[0];
    const half = s.scans.length >> 1;
    s.scans.forEach((sc, i) => {
      if (i < half || !sc || !Array.isArray(sc.readings)) return;
      for (const r of sc.readings) if (r && r.id === id) r.rssi -= 8;
    });
  },
};

const MUTATOR_NAMES = Object.keys(MUTATORS);

/** Caso número `c` do fuzz (determinístico: a semente decide tudo). */
function makeCase(seed, c) {
  const rng = rngOf(seed * 100003 + c);
  const scans = rng.pick([0, 1, 2, 3, 4, 5, 8, 8, 12, 12, 16, 20, 20, 30, 30, 45]);
  const aps = rng.pick([1, 2, 3, 5, 8, 12, 20, 40]);
  const mode = rng.pick(['walk', 'walk', 'spots', 'mixed']);
  const cadence = rng.pick([3.5, 3.5, 30, 1, 10]);
  const floors = rng.pick([[0], [0], [0, 1], [0, 1, 2], [-1, 0]]);
  const { survey } = synth(rng, { scans, aps, mode, cadence, floors, perSpot: rng.pick([1, 3, 3, 10]), stale: rng.chance(0.6) });
  const applied = [];
  for (let k = rng.pick([0, 1, 1, 1, 2, 2, 3]); k > 0; k--) {
    const name = rng.pick(MUTATOR_NAMES);
    try {
      MUTATORS[name](rng, survey);
      applied.push(name);
    } catch {
      applied.push(`${name} (não se aplica)`);
    }
  }
  const options = rng.pick([undefined, {}, { budgetMs: 3000 }, { budgetMs: 30000 }, { seed: 5, budgetMs: 30000 }]);
  if (options && rng.chance(0.3)) {
    const n = Array.isArray(survey.scans) ? survey.scans.length : 0;
    options.previous = rng.pick([
      null,
      'x',
      { points: 'x' },
      { points: [] },
      { points: Array.from({ length: n + 5 }, (_, i) => ({ x: i * 1e200, y: -i * 1e200, z: 0, conf: 1 })) },
      { points: Array.from({ length: n }, (_, i) => ({ x: i % 2 ? NaN : i, y: i % 3 ? Infinity : -i })) },
      { points: Array.from({ length: Math.max(0, n - 3) }, (_, i) => ({ x: Math.cos(i), y: Math.sin(2 * i), z: 0, conf: 1 })) },
      { points: Array.from({ length: n }, () => ({ x: 4, y: 4 })) },
      { points: Array.from({ length: n }, (_, i) => (i % 2 ? null : { x: '1', y: {} })) },
    ]);
  }
  const label = `caso ${c}: ${scans} varreduras, ${aps} aparelhos, ${mode}, a cada ${cadence} s, andares ${floors.join('/')}, mutações [${applied.join(', ')}], opções ${options ? Object.keys(options).join('+') || '{}' : 'nenhuma'}`;
  return { survey, options, label };
}

// Casos fixos: os que travaram ou explodiram na revisão, mais alguns extremos. Montados dentro da
// thread (têm NaN, Infinity e funções, que não atravessam bem uma mensagem).
const SPECIAL = {
  // solver-chain: a grade de bases por andar entrava num laço sem fim com 31 andares ou mais.
  '40 andares distintos': () => {
    const { survey } = synth(rngOf(7), { scans: 60, aps: 4, mode: 'spots', cadence: 10 });
    survey.scans.forEach((s, i) => (s.floor = i % 40));
    return { survey };
  },
  '200 andares distintos, andando': () => {
    const { survey } = synth(rngOf(8), { scans: 90, aps: 12 });
    survey.scans.forEach((s, i) => (s.floor = (i * 7) % 200));
    return { survey };
  },
  // solver-fields: um nó por andar -> mapa sem tamanho -> escala multiplicada por bilhões a cada rodada.
  'um ponto marcado por andar': () => {
    const { survey } = synth(rngOf(5), { scans: 9, aps: 40, mode: 'spots', cadence: 30, floors: [0, 1, 2], perSpot: 3 });
    return { survey, maxRadius: 60 };
  },
  'um ponto marcado por andar, poucas redes': () => {
    const { survey } = synth(rngOf(1), { scans: 9, aps: 12, mode: 'spots', cadence: 30, floors: [0, 1, 2], perSpot: 3 });
    return { survey, maxRadius: 60 };
  },
  'o mesmo ponto marcado em três andares': () => {
    const { survey } = synth(rngOf(10), { scans: 12, aps: 3, floors: [0, 1, 2] });
    survey.scans.forEach((s, i) => ((s.spot = ['1', 'a', 0][i % 3]), (s.still = true)));
    return { survey, maxRadius: 60 };
  },
  'quatro pontos marcados alternando entre três andares': () => {
    const { survey } = synth(rngOf(11), { scans: 60, aps: 8, floors: [0, 1] });
    survey.scans.forEach((s, i) => ((s.spot = (i % 4) + 1), (s.floor = i % 3), (s.still = true)));
    return { survey, maxRadius: 60 };
  },
  'uma única leitura no levantamento inteiro': () => {
    const { survey } = synth(rngOf(12), { scans: 30, aps: 5 });
    survey.scans.forEach((s, i) => (s.readings = i === 11 ? s.readings.slice(0, 1) : []));
    return { survey };
  },
  'só o sinal da rede conectada, nenhuma leitura': () => {
    const { survey } = synth(rngOf(13), { scans: 30, aps: 5 });
    for (const s of survey.scans) s.readings = [];
    return { survey };
  },
  'todas as leituras idênticas': () => {
    const { survey } = synth(rngOf(14), { scans: 40, aps: 6 });
    for (const s of survey.scans) for (const r of s.readings) r.rssi = -60;
    return { survey };
  },
  'todos os tempos iguais': () => {
    const { survey } = synth(rngOf(15), { scans: 40, aps: 6 });
    for (const s of survey.scans) s.t = 1e9;
    return { survey };
  },
  'BSSIDs com nomes de propriedades do objeto': () => {
    const { survey } = synth(rngOf(16), { scans: 30, aps: 3 });
    const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '0'];
    const map = new Map();
    for (const s of survey.scans) for (const r of s.readings) r.id = map.get(r.id) || (map.set(r.id, names[map.size % names.length]), map.get(r.id));
    survey.aps = {};
    return { survey };
  },
  'distâncias medidas absurdas': () => {
    const { survey } = synth(rngOf(17), { scans: 30, aps: 6 });
    survey.knownDistances = [{ a: 0, b: 29, meters: 1e308 }, { a: 1, b: 20, meters: 1e9 }, { a: 2, b: 10, meters: 5000 }, { a: 3, b: 3, meters: 2 }, { a: 4, b: 400, meters: 2 }, { a: 5, b: 9, meters: -1 }];
    return { survey, maxRadius: 60 };
  },
  'rótulos enormes e com emoji': () => {
    const { survey } = synth(rngOf(18), { scans: 24, aps: 5, mode: 'spots' });
    survey.scans.forEach((s, i) => (s.label = i % 2 ? '🛋️'.repeat(20000) : `Sala\u0000\n${'x'.repeat(100000)}`));
    return { survey };
  },
  'mil pontos marcados, uma varredura em cada': () => {
    const { survey } = synth(rngOf(19), { scans: 1000, aps: 6 });
    survey.scans.forEach((s, i) => ((s.spot = i), (s.still = true)));
    return { survey, options: { budgetMs: 3000 } };
  },
  'dois pontos marcados revezando mil vezes': () => {
    const { survey } = synth(rngOf(20), { scans: 1000, aps: 6 });
    survey.scans.forEach((s, i) => ((s.spot = i % 2), (s.still = true)));
    return { survey, options: { budgetMs: 3000 } };
  },
  'seiscentas varreduras num ponto marcado só': () => {
    const { survey } = synth(rngOf(21), { scans: 600, aps: 10 });
    survey.scans.forEach((s) => ((s.spot = 'aqui'), (s.still = true)));
    return { survey, options: { budgetMs: 3000 } };
  },
};

// ---------------------------------------------------------------------------
// Contrato da saída
// ---------------------------------------------------------------------------

function floorOf(scan) {
  const f = Math.round(Number(scan && scan.floor));
  return Number.isFinite(f) ? Math.max(-20, Math.min(200, f)) : 0;
}

/** Lista o que a solução tem de errado (vazia = contrato cumprido). `maxRadius`: nenhuma coordenada além disto (m). */
function contractProblems(solution, survey, maxRadius = 2000) {
  const problems = [];
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : [];
  if (!solution || typeof solution !== 'object' || solution instanceof Promise) return ['não devolveu um objeto'];
  if (!Array.isArray(solution.points)) return ['points não é uma lista'];
  if (solution.points.length !== scans.length) return [`${solution.points.length} pontos para ${scans.length} varreduras`];
  const spots = new Map();
  for (let i = 0; i < scans.length && problems.length < 5; i++) {
    const p = solution.points[i];
    if (!p || ![p.x, p.y, p.z, p.conf].every(Number.isFinite)) {
      problems.push(`ponto ${i} não é finito`);
      continue;
    }
    if (!(p.conf >= 0 && p.conf <= 1)) problems.push(`confiança do ponto ${i} = ${p.conf}`);
    if (Math.hypot(p.x, p.y) > maxRadius) problems.push(`ponto ${i} a ${Math.hypot(p.x, p.y).toExponential(1)} m do centro`);
    const s = scans[i] && typeof scans[i] === 'object' ? scans[i] : {};
    if (Math.abs(p.z - floorOf(s) * FLOOR_HEIGHT) > 1e-9) problems.push(`z do ponto ${i} = ${p.z} com andar ${String(s.floor)}`);
    if (s.spot != null) {
      const key = String(s.spot);
      const first = spots.get(key);
      if (!first) spots.set(key, p);
      else if (Math.hypot(first.x - p.x, first.y - p.y) > 1e-6) problems.push(`varreduras do ponto marcado "${key.slice(0, 20)}" em posições diferentes`);
    }
  }
  if (!solution.aps || typeof solution.aps !== 'object') problems.push('aps não é um objeto');
  else {
    for (const [id, a] of Object.entries(solution.aps)) {
      if (!a || ![a.x, a.y, a.z, a.p0, a.n, a.conf].every(Number.isFinite)) problems.push(`roteador ${id.slice(0, 20)} não é finito`);
      else if (!(a.conf >= 0 && a.conf <= 1)) problems.push(`confiança do roteador = ${a.conf}`);
      else if (Math.hypot(a.x, a.y) > 1e6) problems.push(`roteador ${id.slice(0, 20)} a ${Math.hypot(a.x, a.y).toExponential(1)} m`);
      if (problems.length >= 5) break;
    }
  }
  if (!(Number.isFinite(solution.scaleConf) && solution.scaleConf >= 0 && solution.scaleConf <= 1)) problems.push(`scaleConf = ${solution.scaleConf}`);
  if (solution.debug) {
    try {
      if (JSON.stringify(solution.debug).length > 4000) problems.push('debug grande demais para uma mensagem');
      structuredClone(solution);
    } catch (err) {
      problems.push(`a solução não atravessa um postMessage: ${err.message}`);
    }
  }
  return problems;
}

/** Retrato da entrada, para conferir que o solucionador não mexeu nela. */
function snapshot(value) {
  try {
    return JSON.stringify(value, (key, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : typeof v === 'function' ? 'função' : typeof v === 'string' && v.length > 64 ? `texto de ${v.length}` : v));
  } catch {
    return null;
  }
}

/** Roda solve e solveQuick num caso e devolve os problemas encontrados. */
async function runCase({ survey, options, maxRadius }) {
  const problems = [];
  const before = snapshot(survey);
  let t0 = performance.now();
  let solution;
  try {
    solution = solve(survey, options);
    if (!(solution instanceof Promise)) problems.push('solve não devolveu uma Promise');
    solution = await solution;
  } catch (err) {
    return { problems: [`solve lançou: ${err && err.message}`], ms: 0, quickMs: 0 };
  }
  const ms = performance.now() - t0;
  problems.push(...contractProblems(solution, survey, maxRadius).map((p) => `solve: ${p}`));
  const error = solution && solution.debug && solution.debug.error;
  if (error && error !== 'sem leituras') problems.push(`solve: erro interno engolido: ${error}`);
  const budget = options && Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : 6000;
  if (ms > 1.5 * budget + 2000) problems.push(`solve: levou ${Math.round(ms)} ms com ${budget} ms pedidos`);
  t0 = performance.now();
  let quick;
  try {
    quick = solveQuick(survey, options);
  } catch (err) {
    return { problems: [...problems, `solveQuick lançou: ${err && err.message}`], ms, quickMs: 0 };
  }
  const quickMs = performance.now() - t0;
  problems.push(...contractProblems(quick, survey, maxRadius).map((p) => `solveQuick: ${p}`));
  const quickError = quick && quick.debug && quick.debug.error;
  if (quickError && quickError !== 'sem leituras') problems.push(`solveQuick: erro interno engolido: ${quickError}`);
  if (quickMs > 6000) problems.push(`solveQuick: levou ${Math.round(quickMs)} ms`);
  if (snapshot(survey) !== before) problems.push('a entrada foi alterada');
  return { problems, ms, quickMs };
}

// ---------------------------------------------------------------------------
// Dentro da thread: roda os casos e avisa antes de cada um (quem trava fica com o nome)
// ---------------------------------------------------------------------------

async function threadMain() {
  const { seed, cases, special } = workerData;
  for (let c = 0; c < cases; c++) {
    const made = makeCase(seed, c);
    parentPort.postMessage({ start: made.label });
    parentPort.postMessage({ done: made.label, ...(await runCase(made)) });
  }
  for (const name of special) {
    parentPort.postMessage({ start: name });
    parentPort.postMessage({ done: name, ...(await runCase(SPECIAL[name]())) });
  }
  parentPort.postMessage({ end: true });
}

/** Roda casos numa thread com corte de tempo. Devolve { results, hung } (hung = caso que não terminou). */
function runInThread(job, timeoutMs) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    const results = [];
    let current = null;
    const finish = (hung) => {
      clearTimeout(timer);
      worker.terminate();
      resolve({ results, hung });
    };
    const timer = setTimeout(() => finish(current || '(antes do primeiro caso)'), timeoutMs);
    worker.on('message', (msg) => {
      if (msg.start) current = msg.start;
      else if (msg.done) {
        results.push({ label: msg.done, problems: msg.problems, ms: msg.ms, quickMs: msg.quickMs });
        current = null;
      } else if (msg.end) finish(null);
    });
    worker.on('error', (err) => {
      results.push({ label: current || 'thread', problems: [`a thread caiu: ${err && err.message}`], ms: 0, quickMs: 0 });
      finish(null);
    });
  });
}

if (!isMainThread) {
  await threadMain();
} else {
  defineTests();
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

function defineTests() {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const radius = (points) => {
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
    return Math.sqrt(points.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / points.length);
  };
  const report = (results) => results.filter((r) => r.problems.length).map((r) => `${r.label}\n      ${r.problems.join('\n      ')}`).join('\n');

  // A bancada (cenários simulados com a verdade) só é carregada aqui, na thread principal.
  let bench = null;
  const loadBench = async () => {
    if (!bench) {
      const [harness, metrics, presets, world, walk] = await Promise.all([import('./mapping/harness.mjs'), import('./mapping/metrics.mjs'), import('../app/js/sim/presets.js'), import('../app/js/sim/world.js'), import('../app/js/sim/walk.js')]);
      bench = { ...harness, ...metrics, ...presets, ...world, ...walk };
    }
    return bench;
  };
  const scenario = async (name) => {
    const b = await loadBench();
    return b.buildScenario(b.listScenarios('dev').find((d) => d.name === name));
  };
  /** Nota da solução medida só nas varreduras originais `orig` (que estão em `map` no levantamento perturbado). */
  const scoreOn = async (solution, sc, orig, map) => {
    const b = await loadBench();
    const sub = { points: map.map((j) => solution.points[j]), aps: solution.aps, scaleConf: solution.scaleConf };
    const truth = { ...sc.truth, points: orig.map((i) => sc.truth.points[i]), floors: sc.truth.floors ? orig.map((i) => sc.truth.floors[i]) : undefined };
    return b.evaluate(sub, truth, { ...sc.survey, scans: orig.map((i) => sc.survey.scans[i]) });
  };
  const identity = (n) => Array.from({ length: n }, (_, i) => i);

  // -------------------------------------------------------------------------
  // 1. Fuzz e casos fixos, com corte de tempo
  // -------------------------------------------------------------------------

  test('fuzz: nunca lança, nunca trava, sempre devolve um ponto finito por varredura', async () => {
    const cases = Number(process.env.WRX_FUZZ_CASES) || 70;
    const seed = Number(process.env.WRX_FUZZ_SEED) || 1;
    const { results, hung } = await runInThread({ seed, cases, special: [] }, 20000 + 600 * cases);
    assert.equal(hung, null, `travou (ou passou do tempo) em: ${hung}`);
    assert.equal(results.length, cases, 'todos os casos rodaram');
    assert.equal(report(results), '', 'casos com problema');
  });

  test('casos fixos: os que travavam ou explodiam antes da revisão, e os extremos', async () => {
    const special = Object.keys(SPECIAL);
    const { results, hung } = await runInThread({ seed: 1, cases: 0, special }, 60000);
    assert.equal(hung, null, `travou em: ${hung}`);
    assert.equal(results.length, special.length);
    assert.equal(report(results), '', 'casos com problema');
    for (const r of results) assert.ok(r.ms < 12000 && r.quickMs < 5000, `${r.label}: solve ${Math.round(r.ms)} ms, prévia ${Math.round(r.quickMs)} ms`);
  });

  // -------------------------------------------------------------------------
  // 2. Regressões pontuais
  // -------------------------------------------------------------------------

  test('uma leitura NaN (ou Infinity, ou absurda) não contamina nada: é como se não existisse', async () => {
    const { survey } = synth(rngOf(31), { scans: 40, aps: 8 });
    const dirty = clone(survey);
    dirty.scans[7].readings.push({ id: 'ff:ff:ff:ff:ff:01', rssi: NaN, freq: 2437, ageMs: 500 });
    dirty.scans[9].readings.unshift({ id: dirty.scans[9].readings[0].id, rssi: Infinity, freq: 2437, ageMs: 500 });
    dirty.scans[11].readings.push({ id: 'ff:ff:ff:ff:ff:02', rssi: 1e9, freq: NaN, ageMs: NaN }, null, 7);
    const a = await solve(survey);
    const b = await solve(dirty);
    assert.deepEqual(b.points, a.points);
    assert.deepEqual(solveQuick(dirty).points, solveQuick(survey).points);
  });

  test('idades das leituras imprestáveis (outra unidade) não deixam o levantamento sem leituras', async () => {
    const { survey } = synth(rngOf(36), { scans: 40, aps: 8, stale: false });
    const base = await solve(survey);
    // Microssegundos no lugar de milissegundos: toda leitura parece ter minutos de idade.
    const micro = clone(survey);
    for (const s of micro.scans) for (const r of s.readings) r.ageMs *= 1000;
    const solution = await solve(micro);
    assert.equal(solution.debug.error, undefined);
    assert.equal(solution.debug.members.length, 4);
    assert.ok(Math.abs(radius(solution.points) - radius(base.points)) < 0.5 * radius(base.points), 'o mapa tem o tamanho de sempre (antes: tudo num ponto, confiança zero)');
    // Uma varredura só com leituras antigas, no meio de outras boas, continua sendo tratada como antiga.
    const one = clone(survey);
    for (const r of one.scans[10].readings) r.ageMs = 60000;
    assert.ok((await solve(one)).points[10].conf < base.points[10].conf);
  });

  test('duas soluções ao mesmo tempo (e prévias no meio) não se misturam: nenhum estado dividido', async () => {
    const one = synth(rngOf(32), { scans: 45, aps: 8 }).survey;
    const two = synth(rngOf(33), { scans: 30, aps: 5, mode: 'spots' }).survey;
    const aloneOne = await solve(one);
    const aloneTwo = await solve(two);
    const quickOne = solveQuick(one);
    // solve() cede a vez entre os motores: as duas correm intercaladas, com prévias entre uma etapa e outra.
    const previews = [];
    const [bothOne, bothTwo] = await Promise.all([
      solve(one, { onProgress: () => previews.push(solveQuick(two)) }),
      solve(two, { onProgress: () => previews.push(solveQuick(one)) }),
    ]);
    assert.deepEqual(bothOne.points, aloneOne.points);
    assert.deepEqual(bothOne.aps, aloneOne.aps);
    assert.deepEqual(bothTwo.points, aloneTwo.points);
    assert.ok(previews.length >= 8, 'as prévias rodaram no meio das soluções');
    assert.deepEqual(solveQuick(one).points, quickOne.points);
    // A ordem das chaves de survey.aps não muda nada.
    const shuffled = { ...one, aps: Object.fromEntries(Object.entries(one.aps).reverse()) };
    assert.deepEqual((await solve(shuffled)).points, aloneOne.points);
  });

  test('distância medida absurda é ignorada (antes: 1e308 m colapsava o mapa, 500 m arremessava dois pontos)', async () => {
    const { survey } = synth(rngOf(34), { scans: 40, aps: 8 });
    const base = await solve(survey);
    for (const meters of [1e308, 1e12, 5000, 151, 20 * radius(base.points) + 10]) {
      const withKnown = await solve({ ...survey, knownDistances: [{ a: 2, b: 30, meters }] });
      assert.deepEqual(withKnown.points, base.points, `${meters} m não mexe no mapa`);
      assert.equal(withKnown.scaleConf, base.scaleConf);
    }
    // Uma medida plausível continua valendo, exata.
    const d0 = dist(base.points[2], base.points[30]);
    const good = await solve({ ...survey, knownDistances: [{ a: 2, b: 30, meters: 1.2 * d0 + 0.5 }, { a: 2, b: 30, meters: 1e308 }] });
    assert.ok(Math.abs(dist(good.points[2], good.points[30]) - (1.2 * d0 + 0.5)) < 1e-6);
  });

  test('solução anterior corrompida não leva o mapa junto (antes: coordenadas de 1e200 m na saída)', async () => {
    const { survey } = synth(rngOf(35), { scans: 40, aps: 8 });
    const base = await solve(survey);
    const n = survey.scans.length;
    for (const points of [
      Array.from({ length: n }, (_, i) => ({ x: i * 1e200, y: -i * 1e200 })),
      Array.from({ length: n }, (_, i) => ({ x: 1e7 + i, y: 3e7 - 2 * i })),
      Array.from({ length: n }, (_, i) => ({ x: i % 2 ? NaN : 1e300, y: Infinity })),
    ]) {
      for (const solution of [await solve(survey, { previous: { points } }), solveQuick(survey, { previous: { points } })]) {
        assert.deepEqual(contractProblems(solution, survey, 100), []);
      }
      assert.ok(Math.abs(radius((await solve(survey, { previous: { points } })).points) - radius(base.points)) < 1e-6, 'o mapa é o mesmo');
    }
    // Uma anterior boa, só deslocada e girada, continua sendo seguida.
    const turned = { points: base.points.map((p) => ({ x: 50 - p.y, y: 20 + p.x })) };
    const aligned = await solve(survey, { previous: turned });
    assert.ok(Math.max(...aligned.points.map((p, i) => dist(p, turned.points[i]))) < 1e-6);
  });

  test('motor que degenera fica fora do consenso (debug.outliers) em vez de puxar a média', async () => {
    // Um nó por andar: três dos quatro motores devolvem um mapa sem tamanho ou de tamanho absurdo.
    const { survey } = SPECIAL['um ponto marcado por andar']();
    const solution = await solve(survey);
    assert.deepEqual(contractProblems(solution, survey, 60), []);
    assert.ok(Array.isArray(solution.debug.outliers));
    assert.ok(solution.debug.members.length - solution.debug.outliers.length >= 1, 'sobra pelo menos um motor na média');
    assert.ok(radius(solution.points) < 30, `mapa de ${radius(solution.points).toFixed(1)} m de raio (antes: milhões de metros)`);
  });

  // -------------------------------------------------------------------------
  // 3. O que o mundo real faz e o simulador não
  // -------------------------------------------------------------------------

  test('redes que ligam no meio do levantamento são escondidas dos motores (antes: nota 167, pior que um ponto só)', async () => {
    const sc = await scenario('kitnet-tour-3.5s-s1');
    const survey = clone(sc.survey);
    const own = new Set(Object.keys(survey.aps).filter((id) => sc.world.ap(id) && sc.world.ap(id).own));
    const heard = new Map();
    for (const s of survey.scans) for (const r of s.readings) if (!own.has(r.id) && r.ageMs < 3400) heard.set(r.id, (heard.get(r.id) || 0) + 1);
    const late = [...heard.entries()].sort((p, q) => q[1] - p[1]).slice(0, 3).map((e) => e[0]);
    const half = survey.scans.length >> 1;
    for (let i = 0; i < half; i++) survey.scans[i].readings = survey.scans[i].readings.filter((r) => !late.includes(r.id));
    const solution = await solve(survey);
    assert.deepEqual(contractProblems(solution, survey, 100), []);
    assert.deepEqual([...solution.debug.unstable].sort(), [...late].sort(), 'as três redes tardias foram reconhecidas');
    for (const id of late) assert.ok(solution.aps[id] && solution.aps[id].conf <= 0.2, 'o roteador escondido ainda sai no mapa, com confiança baixa');
    const m = await scoreOn(solution, sc, identity(survey.scans.length), identity(survey.scans.length));
    assert.ok(m.score < 75, `nota ${m.score.toFixed(1)} (sem a proteção: 167; sem as três redes desde o começo: ~61)`);
    // A prévia tem a mesma proteção.
    assert.deepEqual([...solveQuick(survey).debug.unstable].sort(), [...late].sort());
    // E o levantamento original, sem nada de estranho, não aciona nada.
    const plain = await solve(sc.survey);
    assert.deepEqual(plain.debug.unstable, []);
    assert.equal(plain.debug.standstills, 0);
    assert.equal(plain.debug.blocks, 1);
  });

  test('cinco minutos parado sem marcar ponto viram um ponto só (antes: 85 pontos espalhados e mapa deformado)', async () => {
    const sc = await scenario('kitnet-tour-3.5s-s1');
    const survey = clone(sc.survey);
    const rng = rngOf(4242);
    const n = survey.scans.length;
    const m = n >> 1;
    const src = survey.scans[m];
    assert.equal(src.spot, null);
    const extra = [];
    const count = 85;
    for (let k = 1; k <= count; k++) {
      const readings = [];
      for (const r of src.readings) {
        if (r.ageMs > 3400 || rng.chance(0.07)) continue; // 7% de beacons perdidos
        readings.push({ ...r, rssi: Math.round(r.rssi + 2 * rng.gauss()), ageMs: Math.round(rng.f(300, 2800)) });
      }
      extra.push({ t: src.t + 3.5 * k, floor: src.floor, still: false, spot: null, readings });
    }
    for (let i = m + 1; i < n; i++) survey.scans[i].t += 3.5 * count;
    survey.track = (survey.track || []).filter((q) => q.t <= src.t).concat((survey.track || []).filter((q) => q.t > src.t).map((q) => ({ ...q, t: q.t + 3.5 * count })));
    survey.scans.splice(m + 1, 0, ...extra);
    const solution = await solve(survey);
    assert.deepEqual(contractProblems(solution, survey, 100), []);
    assert.equal(solution.debug.standstills, 1);
    const still = solution.points.slice(m + 1, m + 1 + count);
    assert.ok(radius(still) < 0.05, `as varreduras paradas ficam juntas (espalhamento ${radius(still).toFixed(2)} m; antes 0,95 m)`);
    const map = identity(n).map((i) => (i <= m ? i : i + count));
    const score = await scoreOn(solution, sc, identity(n), map);
    assert.ok(score.score < 70, `nota ${score.score.toFixed(1)} no resto do mapa (antes 73,6; sem a parada 54,4)`);
  });

  test('pausa de dez minutos (celular bloqueado) não junta nem separa as duas metades', async () => {
    const sc = await scenario('apartamento-tour-3.5s-s2');
    const survey = clone(sc.survey);
    const m = survey.scans.length >> 1;
    const t0 = survey.scans[m].t;
    for (let i = m + 1; i < survey.scans.length; i++) survey.scans[i].t += 600;
    survey.track = (survey.track || []).map((q) => (q.t > t0 ? { ...q, t: q.t + 600 } : q));
    const solution = await solve(survey);
    const score = await scoreOn(solution, sc, identity(survey.scans.length), identity(survey.scans.length));
    assert.ok(score.score < 45, `nota ${score.score.toFixed(1)} (sem a pausa: 32,0)`);
    assert.ok(dist(solution.points[m], solution.points[m + 1]) < 4, 'quem ficou no lugar continua no lugar');
  });

  test('celular de varredura lenta no modo de 30 s: as leituras do começo da varredura não são jogadas fora (antes: nota 107)', async () => {
    // A varredura completa leva 6,4 s em vez de 2,9: a idade das leituras passa de 4,5 s, o teto fixo
    // que as tratava como repetidas de varreduras anteriores (quase todo o 2,4 GHz sumia).
    const sc = await scenario('kitnet-pontos-30s-s2');
    const slow = clone(sc.survey);
    for (const s of slow.scans) for (const r of s.readings) r.ageMs = Math.round(r.ageMs * 2.2);
    const b = await loadBench();
    const fast = b.evaluate(await solve(sc.survey), sc.truth, sc.survey);
    const solution = await solve(slow);
    const m = b.evaluate(solution, sc.truth, sc.survey);
    assert.ok(m.score < fast.score + 10, `nota ${m.score.toFixed(1)} com a varredura lenta e ${fast.score.toFixed(1)} com a rápida`);
    assert.ok(m.score < 55);
  });

  test('levantamento enorme: resolvido em blocos com a cadência de verdade (antes: raleado por igual, mapa 35% menor)', async () => {
    const b = await loadBench();
    const desc = b.listScenarios('dev').find((d) => d.name === 'apartamento-tour-3.5s-s1');
    const world = b.createWorld(b.presetSpec(desc.world.id, desc.world.seed), desc.world.seed, {});
    const { survey, truth } = b.simulateSurvey(world, b.planWalk(world, { ...desc.walk, minLengthM: 1300 }), desc.survey);
    assert.ok(survey.scans.length > 550, `${survey.scans.length} varreduras`);
    const t0 = performance.now();
    const solution = await solve(survey);
    const ms = performance.now() - t0;
    assert.deepEqual(contractProblems(solution, survey, 100), []);
    assert.equal(solution.debug.blocks, 2);
    const m = b.evaluate(solution, truth, survey);
    assert.ok(m.score < 66, `nota ${m.score.toFixed(1)} (raleando por igual: 72,0; em blocos: ~57)`);
    assert.ok(m.medianRigid < 1.3, `erro mediano ${m.medianRigid.toFixed(2)} m (antes 1,43)`);
    assert.ok(ms < 9000, `${Math.round(ms)} ms com o tempo padrão`);
    const quick = solveQuick(survey);
    assert.deepEqual(contractProblems(quick, survey, 100), []);
  });

  test('escritório andado por uma hora (1500 varreduras x 150 aparelhos): cabe no tempo e na memória', async () => {
    const { survey } = synth(rngOf(99), { scans: 1500, aps: 150, size: 22 });
    assert.ok(Object.keys(survey.aps).length > 200, 'mais de 200 BSSIDs');
    const t0 = performance.now();
    const solution = await solve(survey, { budgetMs: 5000 });
    const ms = performance.now() - t0;
    assert.deepEqual(contractProblems(solution, survey, 200), []);
    assert.ok(solution.debug.members.length >= 1 && radius(solution.points) > 1);
    assert.ok(ms < 9000, `solve em ${Math.round(ms)} ms com 5000 pedidos (antes do teto de rádios: só um motor cabia)`);
    assert.ok(Object.keys(solution.aps).length > 150, 'os rádios que os motores não viram também saem no mapa');
    const t1 = performance.now();
    const quick = solveQuick(survey);
    const quickMs = performance.now() - t1;
    assert.deepEqual(contractProblems(quick, survey, 200), []);
    assert.ok(quickMs < 4000, `prévia em ${Math.round(quickMs)} ms (antes: mais de 3 s nesta máquina, sem carga)`);
  });

  // -------------------------------------------------------------------------
  // 4. Web Worker de módulo no Chromium (opcional)
  // -------------------------------------------------------------------------

  test('carrega e resolve como Worker de módulo no Chromium', { skip: process.env.WRX_BROWSER ? false : 'defina WRX_BROWSER=1 para rodar (precisa do Playwright)' }, async () => {
    const { chromium } = createRequire(import.meta.url)('playwright');
    const { startServer } = await import('../tools/serve.mjs');
    const sc = await scenario('escritorio-tour-3.5s-s1');
    const server = await startServer(0);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const origin = `http://127.0.0.1:${server.address().port}`;
      await page.goto(`${origin}/css/`); // qualquer endereço do app: só interessa a origem
      const result = await page.evaluate(
        async ({ survey, origin }) => {
          const code = `
            import { solve, solveQuick } from '${origin}/js/mapping/solver.js';
            self.onmessage = async (e) => {
              const stages = [];
              const t0 = performance.now();
              const solution = await solve(e.data.survey, { onProgress: (f, s) => { stages.push(s); self.postMessage({ progress: f }); } });
              const ms = performance.now() - t0;
              self.postMessage({ solution, ms, stages, quick: solveQuick(e.data.survey).points.length });
            };`;
          const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), { type: 'module' });
          // Uma função não atravessa o postMessage: o andamento tem de ser ligado do lado de dentro.
          let cloneError = null;
          try {
            worker.postMessage({ survey, options: { onProgress: () => {} } });
          } catch (err) {
            cloneError = err.name;
          }
          return await new Promise((resolve) => {
            let progress = 0;
            worker.onerror = (e) => resolve({ error: e.message });
            worker.onmessage = (e) => (e.data.solution ? resolve({ ...e.data, progress, cloneError }) : progress++);
            worker.postMessage({ survey });
          });
        },
        { survey: clone(sc.survey), origin },
      );
      assert.equal(result.error, undefined, `o worker falhou: ${result.error}`);
      assert.equal(result.cloneError, 'DataCloneError');
      assert.deepEqual(contractProblems(result.solution, sc.survey, 100), []);
      assert.equal(result.solution.debug.members.length, 4);
      assert.ok(result.progress >= 6 && result.stages.at(-1) === 'Pronto');
      assert.equal(result.quick, sc.survey.scans.length);
      const b = await loadBench();
      assert.ok(b.evaluate(result.solution, sc.truth, sc.survey).score < 60);
      assert.ok(result.ms < 15000, `${Math.round(result.ms)} ms no Chromium`);
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
