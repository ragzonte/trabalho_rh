// Construtor do mapa (app/js/mapping/mapmodel.js): formato do MapModel, casos degenerados,
// ambientes com nome, campo de sinal, cobertura, sugestão de roteador e desempenho.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, heatField, coverage, suggestRouterSpot, describeMap, _dev } from '../app/js/mapping/mapmodel.js';
import { FLOOR_HEIGHT } from '../app/js/mapping/types.js';
import { presetWorld } from '../app/js/sim/presets.js';
import { planWalk, simulateSurvey } from '../app/js/sim/walk.js';

// ---------------------------------------------------------------------------
// Levantamentos feitos à mão
// ---------------------------------------------------------------------------

// Ruído repetível (LCG + Box-Muller): os testes não dependem de Math.random.
function makeNoise(seed) {
  let s = seed >>> 0 || 1;
  const uniform = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/**
 * Levantamento sintético: sinal = p0 - 10 n log10(d) - paredes + ruído; abaixo de -90 dBm não é ouvido.
 * `walls` são retas verticais x = cte que tiram `loss` dB de quem está do outro lado do roteador.
 * A "solução" são as posições exatas (o construtor é que está em teste, não o solucionador).
 */
function synth({ points, aps, walls = [], noise = 1.2, seed = 7, interval = 3.5, conf = 0.9 }) {
  const gauss = makeNoise(seed);
  const meta = {};
  for (const ap of aps) meta[ap.id] = { ssid: ap.ssid ?? '', freq: ap.freq ?? 2437, ...(ap.device ? { device: ap.device } : {}) };
  const scans = points.map((p, i) => {
    const readings = [];
    for (const ap of aps) {
      const floorGap = Math.abs((p.floor ?? 0) - (ap.floor ?? 0));
      const d = Math.max(0.5, Math.hypot(ap.x - p.x, ap.y - p.y, 1 + floorGap * FLOOR_HEIGHT));
      let v = (ap.p0 ?? -38) - 10 * (ap.n ?? 2.6) * Math.log10(d) - 14 * floorGap;
      for (const w of walls) if (ap.x < w.x !== p.x < w.x) v -= w.loss;
      v = Math.round(v + noise * gauss());
      if (v > -90) readings.push({ id: ap.id, rssi: Math.min(v, -20), freq: ap.freq ?? 2437, ageMs: 900 });
    }
    readings.sort((a, b) => b.rssi - a.rssi || (a.id < b.id ? -1 : 1));
    const scan = { t: p.t ?? 3 + i * interval, floor: p.floor ?? 0, still: p.spot != null, spot: p.spot ?? null, readings };
    if (p.label) scan.label = p.label;
    return scan;
  });
  const solution = {
    points: points.map((p) => ({ x: p.x, y: p.y, z: (p.floor ?? 0) * FLOOR_HEIGHT, conf })),
    aps: Object.fromEntries(aps.filter((a) => a.solved !== false).map((a) => [a.id, { x: a.x, y: a.y, z: (a.floor ?? 0) * FLOOR_HEIGHT + 1, p0: a.p0 ?? -38, n: a.n ?? 2.6, conf: 0.8 }])),
    scaleConf: 0.8,
  };
  return { survey: { version: 1, scans, aps: meta }, solution };
}

// Vizinhos em volta: dão "impressão digital" aos lugares sem serem da casa.
const NEIGHBOURS = [
  { id: 'n1', ssid: 'Vizinho 1', x: -9, y: 4, p0: -40 },
  { id: 'n2', ssid: 'Vizinho 2', x: 18, y: -6, p0: -40 },
  { id: 'n3', ssid: 'Vizinho 3', x: 4, y: 14, p0: -41, freq: 5180 },
  { id: 'n4', ssid: '', x: 12, y: 12, p0: -42 },
];

// Vai e volta cobrindo um retângulo, um ponto a cada `step` metros.
function serpentine(x0, y0, x1, y1, lanes, step) {
  const out = [];
  for (let l = 0; l < lanes; l++) {
    const y = y0 + ((y1 - y0) * (l + 0.5)) / lanes;
    const n = Math.max(1, Math.round((x1 - x0) / step));
    for (let k = 0; k <= n; k++) {
      const u = l % 2 ? 1 - k / n : k / n;
      out.push({ x: x0 + (x1 - x0) * u, y });
    }
  }
  return out;
}

// Duas salas lado a lado (parede em x = 4, porta em y = 1,5), com pontos marcados e batizados.
function twoRooms() {
  const points = [];
  const spot = (id, x, y, label) => {
    for (let k = 0; k < 2; k++) points.push({ x, y, spot: id, label });
  };
  const walk = (x, y) => points.push({ x, y });
  spot(0, 1, 1, 'Sala');
  walk(1.6, 2);
  spot(1, 2.4, 2.6, 'Sala');
  walk(2.6, 1.6);
  spot(2, 1.2, 2.5, 'Sala');
  walk(2.2, 1.6);
  walk(3.3, 1.5);
  walk(4.7, 1.5); // atravessou a porta
  walk(5.8, 1.4);
  spot(3, 6.8, 1, 'Quarto');
  walk(6.4, 2);
  spot(4, 5.6, 2.6, 'Quarto');
  walk(6.4, 2.4);
  spot(5, 7, 2.5, 'Quarto');
  walk(5.9, 1.6);
  walk(4.6, 1.5);
  walk(3.4, 1.5); // voltou pela mesma porta
  walk(2, 1.2);
  const aps = [
    { id: 'aa:00', ssid: 'Casa', device: 'r1', x: 1.5, y: 0.4, p0: -36 },
    { id: 'aa:01', ssid: 'Casa', device: 'r1', x: 1.5, y: 0.4, p0: -39, freq: 5180 },
    { id: 'bb:00', ssid: 'Vizinho B', x: 9.5, y: 2, p0: -40 },
    ...NEIGHBOURS,
  ];
  return synth({ points, aps, walls: [{ x: 4, loss: 12 }], noise: 1 });
}

// Casa comprida (16 x 4 m, três paredes) com o roteador numa ponta ou no meio.
function longHouse(routerX) {
  const points = serpentine(0.8, 0.6, 15.2, 3.4, 3, 1.3);
  const aps = [{ id: 'cc:00', ssid: 'Casa Longa', device: 'r1', x: routerX, y: 2, p0: -38, n: 3 }, ...NEIGHBOURS];
  return synth({ points, aps, walls: [{ x: 4.2, loss: 6 }, { x: 8.2, loss: 6 }, { x: 12.2, loss: 6 }], noise: 1 });
}

// 230 varreduras, 35 BSSIDs: o tamanho de um levantamento longo de verdade.
function bigSurvey() {
  const points = serpentine(0.6, 0.6, 13.4, 9.4, 10, 0.55).slice(0, 230);
  const aps = [
    { id: 'own:24', ssid: 'Casa Grande', device: 'r1', x: 3, y: 2, p0: -37 },
    { id: 'own:5', ssid: 'Casa Grande', device: 'r1', x: 3, y: 2, p0: -40, freq: 5220 },
  ];
  for (let k = 0; k < 33; k++) {
    const ang = (k / 33) * 2 * Math.PI;
    aps.push({ id: `v${k}`, ssid: `Vizinho ${k}`, device: `d${k >> 1}`, x: 7 + (11 + (k % 5)) * Math.cos(ang), y: 5 + (10 + (k % 4)) * Math.sin(ang), p0: -40, freq: k % 2 ? 5180 : 2412 });
  }
  return synth({ points, aps, noise: 1.5, seed: 11 });
}

// Levantamento simulado de um mundo pronto, com as posições reais como solução.
function simulated(preset, kind, options = {}) {
  const world = presetWorld(preset, 1);
  const plan = planWalk(world, { kind, seed: 3, ...(kind === 'spots' ? { count: options.count ?? 20 } : { minLengthM: options.length ?? 150 }) });
  const { survey, truth } = simulateSurvey(world, plan, { scanIntervalS: 3.5, seed: 3 });
  const solution = {
    points: truth.points.map((p, i) => ({ x: p.x, y: p.y, z: survey.scans[i].floor * FLOOR_HEIGHT, conf: 0.8 })),
    aps: Object.fromEntries(
      Object.keys(survey.aps).map((id) => {
        const a = world.ap(id);
        return [id, { x: a.x, y: a.y, z: a.z, p0: a.p0, n: a.n, conf: 0.8 }];
      }),
    ),
    scaleConf: 0.8,
  };
  const own = world.aps.filter((a) => a.own && survey.aps[a.bssid]).map((a) => a.bssid);
  return { world, survey, solution, own, truth };
}

// ---------------------------------------------------------------------------
// Conferência do formato (types.js)
// ---------------------------------------------------------------------------

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function assertShape(model, scanCount) {
  assert.equal(model.version, 1);
  const { bounds, cell, nx, ny } = model;
  assert.ok(finite(bounds.minX) && finite(bounds.minY) && finite(bounds.maxX) && finite(bounds.maxY));
  assert.ok(cell >= 0.2 && cell <= 0.5, `cell ${cell}`);
  assert.ok(Number.isInteger(nx) && Number.isInteger(ny) && nx > 0 && ny > 0);
  assert.ok(Math.abs(bounds.minX + nx * cell - bounds.maxX) < 1e-6 && Math.abs(bounds.minY + ny * cell - bounds.maxY) < 1e-6, 'a grade cobre exatamente os limites');
  const size = nx * ny;

  assert.ok(Array.isArray(model.floors) && model.floors.length >= 1);
  let areaCells = 0;
  const roomIds = new Set();
  model.floors.forEach((f, fi) => {
    assert.ok(Number.isInteger(f.floor));
    if (fi > 0) assert.ok(f.floor > model.floors[fi - 1].floor, 'andares em ordem crescente');
    assert.equal(f.z, f.floor * FLOOR_HEIGHT);
    assert.ok(f.inside instanceof Uint8Array && f.inside.length === size);
    assert.ok(f.conf instanceof Float32Array && f.conf.length === size);
    assert.ok(f.room instanceof Int16Array && f.room.length === size);
    const cellsOf = new Array(f.rooms.length).fill(0);
    let floorCells = 0;
    for (let c = 0; c < size; c++) {
      assert.ok(f.inside[c] === 0 || f.inside[c] === 1);
      assert.ok(f.conf[c] >= 0 && f.conf[c] <= 1);
      if (f.inside[c]) {
        areaCells++;
        floorCells++;
        // Andar sem divisão em ambientes (menos de dois lugares com nome): rooms vazio e -1 em todas as células.
        if (!f.rooms.length) assert.equal(f.room[c], -1, 'andar sem ambientes: nenhuma célula tem ambiente');
        else {
          assert.ok(f.room[c] >= 0 && f.room[c] < f.rooms.length, `célula de dentro sem ambiente válido (${f.room[c]})`);
          cellsOf[f.room[c]]++;
        }
      } else {
        assert.equal(f.room[c], -1);
        assert.equal(f.conf[c], 0);
      }
    }
    // Nada encosta na borda da grade (há margem).
    for (let i = 0; i < nx; i++) assert.ok(!f.inside[i] && !f.inside[(ny - 1) * nx + i]);
    for (let j = 0; j < ny; j++) assert.ok(!f.inside[j * nx] && !f.inside[j * nx + nx - 1]);

    f.rooms.forEach((r, ri) => {
      assert.ok(Number.isInteger(r.id) && !roomIds.has(r.id), 'id de ambiente único no mapa');
      roomIds.add(r.id);
      assert.ok(typeof r.label === 'string' && r.label.length > 0);
      assert.equal(typeof r.auto, 'boolean');
      if (r.auto) assert.match(r.label, /^Ambiente \d+$/);
      assert.ok(finite(r.cx) && finite(r.cy));
      assert.ok(cellsOf[ri] > 0, 'todo ambiente tem células');
      assert.ok(Math.abs(r.areaM2 - cellsOf[ri] * cell * cell) < 0.011);
      assert.ok(Number.isInteger(r.scans) && r.scans >= 0);
      // O centro cai numa célula do próprio ambiente.
      const c = Math.floor((r.cy - bounds.minY) / cell) * nx + Math.floor((r.cx - bounds.minX) / cell);
      assert.equal(f.room[c], ri);
    });

    assert.ok(Array.isArray(f.outline));
    if (floorCells) assert.ok(f.outline.length >= 1, 'área sem contorno');
    for (const ring of f.outline) {
      assert.ok(ring.length >= 4, 'anel com pelo menos 3 vértices + fechamento');
      assert.deepEqual(ring[0], ring[ring.length - 1], 'anel fechado (primeiro ponto repetido no fim)');
      for (const p of ring) {
        assert.ok(p.length === 2 && finite(p[0]) && finite(p[1]));
        assert.ok(p[0] >= bounds.minX && p[0] <= bounds.maxX && p[1] >= bounds.minY && p[1] <= bounds.maxY);
      }
    }
    for (const w of f.walls) {
      assert.ok(finite(w.x1) && finite(w.y1) && finite(w.x2) && finite(w.y2));
      assert.ok(w.kind === 'outer' || w.kind === 'inner');
      assert.ok(w.conf >= 0 && w.conf <= 1);
      assert.ok(Math.hypot(w.x2 - w.x1, w.y2 - w.y1) > 1e-6, 'parede de comprimento zero');
    }
    if (floorCells) assert.ok(f.walls.some((w) => w.kind === 'outer'));
    if (f.rooms.length < 2) assert.ok(!f.walls.some((w) => w.kind === 'inner'));
  });

  assert.ok(Array.isArray(model.aps));
  const apIds = new Set();
  model.aps.forEach((a, i) => {
    assert.ok(typeof a.id === 'string' && !apIds.has(a.id));
    apIds.add(a.id);
    assert.ok(Array.isArray(a.bssids) && a.bssids.includes(a.id));
    assert.equal(typeof a.ssid, 'string');
    assert.equal(typeof a.own, 'boolean');
    assert.ok(finite(a.x) && finite(a.y) && finite(a.z));
    assert.ok(a.floor === null || Number.isInteger(a.floor));
    assert.ok(a.conf >= 0 && a.conf <= 1);
    assert.equal(typeof a.inside, 'boolean');
    assert.ok(finite(a.distanceM) && a.distanceM >= 0 && finite(a.bearing) && Math.abs(a.bearing) <= Math.PI + 1e-9);
    assert.ok(finite(a.bestRssi));
    if (i > 0) assert.ok(Number(model.aps[i - 1].own) >= Number(a.own), 'os da casa primeiro');
  });

  assert.ok(Array.isArray(model.networks));
  const keys = new Set();
  model.networks.forEach((n, i) => {
    assert.ok(typeof n.key === 'string' && !keys.has(n.key));
    keys.add(n.key);
    assert.equal(typeof n.ssid, 'string');
    assert.equal(typeof n.own, 'boolean');
    assert.ok(Array.isArray(n.bssids) && n.bssids.length > 0);
    assert.ok(finite(n.bestRssi));
    if (i > 0) {
      const prev = model.networks[i - 1];
      assert.ok(Number(prev.own) > Number(n.own) || (prev.own === n.own && prev.bestRssi >= n.bestRssi), 'as da casa primeiro, depois as mais fortes');
    }
  });

  assert.ok(Array.isArray(model.path) && model.path.length <= scanCount);
  model.path.forEach((p, k) => {
    assert.ok(Number.isInteger(p.i) && p.i >= 0 && p.i < scanCount);
    if (k > 0) assert.ok(p.i > model.path[k - 1].i, 'caminho na ordem das varreduras');
    assert.ok(finite(p.t) && finite(p.x) && finite(p.y));
    assert.equal(p.z, p.floor * FLOOR_HEIGHT);
    assert.ok(model.floors.some((f) => f.floor === p.floor));
    assert.ok(p.conf >= 0 && p.conf <= 1);
    assert.equal(typeof p.still, 'boolean');
  });
  for (const s of model.spots) {
    assert.equal(typeof s.label, 'string');
    assert.ok(finite(s.x) && finite(s.y) && finite(s.z) && Number.isInteger(s.floor));
    assert.ok(Number.isInteger(s.scans) && s.scans >= 1);
  }

  const q = model.quality;
  assert.equal(q.scans, model.path.length);
  assert.equal(q.spots, model.spots.length);
  assert.equal(q.aps, model.aps.length);
  assert.ok(Math.abs(q.areaM2 - areaCells * cell * cell) < 0.06);
  assert.ok(q.scaleConf >= 0 && q.scaleConf <= 1);
  assert.ok(finite(q.expectedErrorM) && q.expectedErrorM > 0);
  assert.ok(['boa', 'razoavel', 'fraca'].includes(q.level));
  assert.ok(Array.isArray(q.notes) && q.notes.every((n) => typeof n === 'string' && n.length > 0));
}

// As funções de análise aceitam qualquer modelo e qualquer chave sem lançar erro.
function assertAnalyses(model) {
  const size = model.nx * model.ny;
  for (const key of [...model.networks.slice(0, 3).map((n) => n.key), 'rede-que-nao-existe']) {
    for (let fi = -1; fi <= model.floors.length; fi++) {
      const h = heatField(model, fi, key);
      assert.ok(h.dbm instanceof Float32Array && h.dbm.length === size && h.conf instanceof Float32Array && h.conf.length === size);
      assert.ok(finite(h.min) && finite(h.max) && h.min <= h.max);
    }
    const cov = coverage(model, key);
    assert.ok(Math.abs(cov.good + cov.fair + cov.weak + cov.dead - 1) < 1e-9);
    const tip = suggestRouterSpot(model, key);
    assert.ok(tip === null || (typeof tip.gainText === 'string' && typeof tip.currentIsCentral === 'boolean'));
  }
  const text = describeMap(model);
  assert.ok(Array.isArray(text) && text.length >= 1 && text.every((s) => typeof s === 'string' && s.trim().length > 0));
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

test('formato do MapModel num levantamento de um andar', () => {
  const { survey, solution, own } = simulated('apartamento', 'tour');
  const model = buildMap(survey, solution, { own });
  assertShape(model, survey.scans.length);
  assert.equal(model.floors.length, 1);
  assert.equal(model.path.length, survey.scans.length);
  assert.ok(model.quality.areaM2 > 30 && model.quality.areaM2 < 80, `área ${model.quality.areaM2} m² num apartamento de 63 m²`);
  // Caminhada sem nenhum lugar com nome: o mapa NÃO inventa ambientes (uma área só, sem divisões
  // internas), e diz o que fazer para tê-los.
  assert.equal(model.floors[0].rooms.length, 0);
  assert.ok(!model.floors[0].walls.some((w) => w.kind === 'inner'));
  assert.match(model.quality.notes.join(' | '), /não separa os ambientes porque nenhum lugar tem nome/);
  assert.match(describeMap(model)[0], /sem divisão em ambientes/);
  assertAnalyses(model);

  // O agrupamento automático pelo sinal continua existindo para a bancada medir (autoRooms).
  const auto = buildMap(survey, solution, { own, autoRooms: true });
  assertShape(auto, survey.scans.length);
  const rooms = auto.floors[0].rooms.length;
  assert.ok(rooms >= 3 && rooms <= 9, `${rooms} ambientes automáticos num apartamento de 6 cômodos`);
  assert.ok(auto.floors[0].rooms.every((r) => r.auto));
  assert.equal(auto.quality.areaM2, model.quality.areaM2, 'a área não depende de haver ambientes');
  assertAnalyses(auto);
});

test('formato do MapModel com dois andares e pontos marcados', () => {
  const { survey, solution, own, world } = simulated('sobrado', 'spots', { count: 26 });
  const model = buildMap(survey, solution, { own });
  assertShape(model, survey.scans.length);
  assert.deepEqual(
    model.floors.map((f) => f.floor),
    [0, 1],
  );
  // Os nomes dados pelo usuário viram ambientes; cada nome aparece uma vez só por andar.
  for (const f of model.floors) {
    const named = f.rooms.filter((r) => !r.auto).map((r) => r.label);
    assert.ok(named.length >= 3);
    assert.equal(new Set(named).size, named.length);
  }
  // Um roteador da casa em cada andar (malha): o andar de cada um sai de onde ele é ouvido mais forte.
  const ownAps = model.aps.filter((a) => a.own);
  assert.equal(ownAps.length, 2);
  for (const a of ownAps) {
    const real = world.ap(a.id);
    assert.equal(a.floor, Math.floor(real.z / FLOOR_HEIGHT));
    assert.ok(a.inside);
  }
  assert.ok(model.spots.length >= 20 && model.spots.every((s) => s.scans >= 1));
  assertAnalyses(model);
});

test('determinístico e sem alterar as entradas', () => {
  const { survey, solution } = twoRooms();
  const surveyCopy = structuredClone(survey);
  const solutionCopy = structuredClone(solution);
  const a = buildMap(survey, solution, { own: ['aa:00'] });
  const b = buildMap(structuredClone(survey), structuredClone(solution), { own: ['aa:00'] });
  assert.deepEqual(a, b);
  assert.deepEqual(survey, surveyCopy);
  assert.deepEqual(solution, solutionCopy);
  assert.deepEqual(heatField(a, 0, a.networks[0].key), heatField(b, 0, b.networks[0].key));
  assert.deepEqual(describeMap(a), describeMap(b));
});

test('o modelo sobrevive a um postMessage (structuredClone) e as análises continuam valendo', () => {
  const { survey, solution } = twoRooms();
  const model = buildMap(survey, solution, { own: ['aa:00'] });
  const copy = structuredClone(model);
  assertShape(copy, survey.scans.length);
  const key = model.networks[0].key;
  assert.deepEqual(heatField(copy, 0, key), heatField(model, 0, key));
  assert.deepEqual(coverage(copy, key), coverage(model, key));
});

// ---------------------------------------------------------------------------
// Entradas degeneradas
// ---------------------------------------------------------------------------

test('entradas vazias ou inválidas dão um modelo vazio, mas válido', () => {
  const inputs = [
    [undefined, undefined],
    [null, null],
    [{}, {}],
    [{ version: 1, scans: [], aps: {} }, { points: [], aps: {}, scaleConf: 0 }],
    [{ scans: 'x', aps: 3 }, { points: 'y', aps: 7 }],
    [{ scans: [null, {}, { readings: 'z' }] }, { points: [null, {}, { x: NaN, y: 1 }] }],
  ];
  for (const [survey, solution] of inputs) {
    const model = buildMap(survey, solution, undefined);
    assertShape(model, Array.isArray(survey?.scans) ? survey.scans.length : 0);
    assert.equal(model.path.length, 0);
    assert.equal(model.quality.areaM2, 0);
    assert.equal(model.quality.level, 'fraca');
    assert.ok(model.quality.notes.length >= 1);
    assertAnalyses(model);
  }
});

test('de 1 a 3 varreduras, um ponto só e pontos em linha', () => {
  const aps = [{ id: 'aa:00', ssid: 'Casa', x: 1, y: 1 }, ...NEIGHBOURS];
  const cases = {
    'uma varredura': [{ x: 0, y: 0 }],
    'duas varreduras': [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
    ],
    'três varreduras': [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ],
    'tudo no mesmo lugar': Array.from({ length: 12 }, () => ({ x: 3, y: 3 })),
    'tudo em linha': Array.from({ length: 20 }, (_, i) => ({ x: i * 0.8, y: 5 })),
    'um ponto marcado só': Array.from({ length: 4 }, () => ({ x: 1, y: 1, spot: 0, label: 'Sala' })),
  };
  for (const [name, points] of Object.entries(cases)) {
    const { survey, solution } = synth({ points, aps });
    const model = buildMap(survey, solution, { own: ['aa:00'] });
    assertShape(model, points.length);
    assert.equal(model.path.length, points.length, name);
    // Onde houve varredura há área, e pouca: nada de inflar. (As soluções de synth() têm confiança
    // 0,9 = erro esperado de 0,5 m, e o alcance de cada ponto soma esse erro em quadratura:
    // raiz(1 + 1,44 x 0,25) = 1,17 m em vez de 1 m, ou 1,36 vez a área.)
    assert.ok(model.quality.areaM2 > 0.5, `${name}: área ${model.quality.areaM2}`);
    assert.ok(model.quality.areaM2 < 1.36 * (4 + 2.2 * points.length), `${name}: área ${model.quality.areaM2}`);
    assert.equal(model.floors[0].rooms.length, 0, `${name}: menos de dois lugares com nome, nenhum ambiente`);
    for (const p of model.path) {
      const c = Math.floor((p.y - model.bounds.minY) / model.cell) * model.nx + Math.floor((p.x - model.bounds.minX) / model.cell);
      assert.equal(model.floors[0].inside[c], 1, `${name}: varredura fora da área`);
    }
    assertAnalyses(model);
  }
  const one = buildMap(...Object.values(synth({ points: cases['uma varredura'], aps })), {});
  assert.equal(one.quality.level, 'fraca');
  assert.equal(one.quality.usable, false, 'uma leitura só não é um mapa');
  assert.match(one.quality.notes[0], /^Só 1 leitura: é pouco para desenhar um mapa/);
});

test('solução ruim: pontos sem posição, tudo no zero, coordenadas absurdas, roteadores faltando', () => {
  const { survey, solution } = twoRooms();
  const n = survey.scans.length;

  // Metade dos pontos sem posição e nenhum roteador resolvido.
  const holes = { points: solution.points.map((p, i) => (i % 2 ? p : { x: NaN, y: NaN, z: 0, conf: 0 })), aps: {}, scaleConf: NaN };
  let model = buildMap(survey, holes, { own: ['aa:00'] });
  assertShape(model, n);
  assert.equal(model.path.length, Math.floor(n / 2));
  assert.ok(model.aps.length > 0, 'roteador sem posição resolvida ganha um palpite');
  assert.ok(model.aps.every((a) => a.conf <= 0.1));
  assert.equal(model.quality.scaleConf, 0);
  assertAnalyses(model);

  // Solucionador que desistiu: tudo em (0, 0) com confiança zero.
  const zero = { points: survey.scans.map(() => ({ x: 0, y: 0, z: 0, conf: 0 })), aps: {}, scaleConf: 0 };
  model = buildMap(survey, zero, {});
  assertShape(model, n);
  assert.ok(model.quality.areaM2 < 8);
  assert.equal(model.quality.level, 'fraca');
  assert.ok(model.quality.expectedErrorM >= 4);
  assertAnalyses(model);

  // Menos pontos que varreduras, e um ponto a quilômetros.
  const short = { points: solution.points.slice(0, 10).map((p, i) => (i === 3 ? { ...p, x: 5e4 } : p)), aps: solution.aps, scaleConf: 0.5 };
  model = buildMap(survey, short, {});
  assertShape(model, n);
  assert.equal(model.path.length, 10);
  assert.ok(model.nx * model.ny <= 200000, 'a grade não explode com um ponto absurdo');
  assertAnalyses(model);

  // Varreduras sem leitura nenhuma.
  const mute = { ...survey, scans: survey.scans.map((s) => ({ ...s, readings: [] })), aps: {} };
  model = buildMap(mute, solution, {});
  assertShape(model, n);
  assert.equal(model.networks.length, 0);
  assert.equal(model.aps.length, 0);
  assertAnalyses(model);
});

test('ponto de pouca confiança, longe de tudo, não incha a área', () => {
  const points = serpentine(0.5, 0.5, 5.5, 4.5, 4, 0.8);
  const aps = [{ id: 'aa:00', ssid: 'Casa', x: 2, y: 2 }, ...NEIGHBOURS];
  const { survey, solution } = synth({ points, aps });
  const base = buildMap(survey, solution, {});
  // O mesmo levantamento com três varreduras jogadas a 15 m, com confiança quase nula.
  const bad = structuredClone(solution);
  for (const i of [10, 11, 12]) bad.points[i] = { x: 15 + (i - 10), y: 12, z: 0, conf: 0.02 };
  const model = buildMap(survey, bad, {});
  assertShape(model, points.length);
  assert.ok(model.quality.areaM2 < base.quality.areaM2 + 1, `área ${model.quality.areaM2} x ${base.quality.areaM2}`);
  // Com confiança normal, os mesmos pontos contam como lugar visitado.
  for (const i of [10, 11, 12]) bad.points[i].conf = 0.9;
  const trusted = buildMap(survey, bad, {});
  assertShape(trusted, points.length);
  assert.ok(trusted.quality.areaM2 > base.quality.areaM2 + 2, `área ${trusted.quality.areaM2} x ${base.quality.areaM2}`);
});

test('tamanho: o alcance de cada ponto soma o erro esperado dele; posição exata não muda nada', () => {
  const points = serpentine(0.5, 0.5, 6.5, 5.5, 5, 0.8);
  const aps = [{ id: 'aa:00', ssid: 'Casa', x: 2, y: 2 }, ...NEIGHBOURS];
  const { survey, solution } = synth({ points, aps, conf: 1 });
  const exact = buildMap(survey, solution, {});
  assertShape(exact, points.length);
  // Confiança 1 = erro esperado zero: igual a desligar a correção.
  assert.equal(exact.quality.areaM2, buildMap(survey, solution, { tune: { areaErr: 0 } }).quality.areaM2);

  // Confiança 0,5 = erro mediano esperado de 1,5 m: alcance raiz(1 + 1,44 x 1,5²) = 2,06 m em vez de 1 m.
  const withConf = (conf) => ({ ...solution, points: solution.points.map((p) => ({ ...p, conf })) });
  const wide = buildMap(survey, withConf(0.5), {});
  assertShape(wide, points.length);
  const ratio = wide.quality.areaM2 / exact.quality.areaM2;
  assert.ok(ratio > 1.3 && ratio < 2.1, `área ${exact.quality.areaM2} -> ${wide.quality.areaM2} m²`);
  // O que era área continua sendo, e a faixa que entrou só pela incerteza aparece como incerta.
  let core = 0;
  let fringe = 0;
  let fringeConf = 0;
  for (let c = 0; c < wide.nx * wide.ny; c++) {
    const x = wide.bounds.minX + ((c % wide.nx) + 0.5) * wide.cell;
    const y = wide.bounds.minY + (Math.floor(c / wide.nx) + 0.5) * wide.cell;
    const ix = Math.floor((x - exact.bounds.minX) / exact.cell);
    const iy = Math.floor((y - exact.bounds.minY) / exact.cell);
    const was = ix >= 0 && iy >= 0 && ix < exact.nx && iy < exact.ny && exact.floors[0].inside[iy * exact.nx + ix] === 1;
    if (was) {
      core++;
      assert.equal(wide.floors[0].inside[c], 1, 'a área de antes continua dentro');
    } else if (wide.floors[0].inside[c]) {
      fringe++;
      fringeConf += wide.floors[0].conf[c];
    }
  }
  assert.ok(core > 0 && fringe > 0);
  assert.ok(fringeConf / fringe < 0.45, `confiança média da faixa de incerteza: ${fringeConf / fringe}`);
  // As posições não saem do lugar: o que cresce é a área em volta delas.
  assert.deepEqual(
    wide.path.map((p) => [p.x, p.y]),
    exact.path.map((p) => [p.x, p.y]),
  );

  // O alcance tem teto: confiança quase nula não vale mais do que 0,3 (erro esperado de 2,3 m).
  assert.equal(buildMap(survey, withConf(0.02), {}).quality.areaM2, buildMap(survey, withConf(0.3), {}).quality.areaM2);
  assert.ok(buildMap(survey, withConf(0.02), {}).quality.areaM2 < 3.2 * exact.quality.areaM2);

  // Solução que colapsou (todos os pontos no mesmo lugar): não há nuvem para crescer.
  const zero = { points: survey.scans.map(() => ({ x: 0, y: 0, z: 0, conf: 0.2 })), aps: {}, scaleConf: 0 };
  assert.ok(buildMap(survey, zero, {}).quality.areaM2 < 8);
});

test('o que foi andado de A a B continua ligado, mesmo com varreduras espaçadas', () => {
  // Dois cômodos a 9 m um do outro, ligados por um corredor com uma varredura a cada 3 m.
  const points = [
    ...serpentine(0.5, 0.5, 3.5, 3.5, 3, 0.8),
    { x: 5.5, y: 2 },
    { x: 8.5, y: 2.2 },
    { x: 11.5, y: 2 },
    ...serpentine(13, 0.5, 16, 3.5, 3, 0.8),
  ];
  const { survey, solution } = synth({ points, aps: [{ id: 'aa:00', ssid: 'Casa', x: 2, y: 2 }, ...NEIGHBOURS] });
  const model = buildMap(survey, solution, {});
  assertShape(model, points.length);
  const outer = _dev.traceRings(model.floors[0].inside, model.nx, model.ny).filter((r) => ringSign(r, model.nx) > 0);
  assert.equal(outer.length, 1, 'a área é um pedaço só');
  // O corredor é fino: tem área em cima dele, não a um metro e meio para o lado.
  const inside = (m, x, y) => m.floors[0].inside[Math.floor((y - m.bounds.minY) / m.cell) * m.nx + Math.floor((x - m.bounds.minX) / m.cell)];
  assert.equal(inside(model, 8.5, 2.2), 1);
  assert.equal(inside(model, 8.5, 4.0), 0);
  assert.equal(inside(model, 8.5, 0.4), 0);
  assert.ok(model.quality.areaM2 < 75, `área ${model.quality.areaM2}`);
  // Mesmo com a confiança do trecho do corredor lá embaixo, os dois cômodos continuam ligados.
  const shaky = structuredClone(solution);
  shaky.points.forEach((p) => {
    if (p.x > 4 && p.x < 12.5) p.conf = 0.1;
  });
  const linked = buildMap(survey, shaky, {});
  assertShape(linked, points.length);
  assert.equal(_dev.traceRings(linked.floors[0].inside, linked.nx, linked.ny).filter((r) => ringSign(r, linked.nx) > 0).length, 1);
  assert.ok(linked.quality.areaM2 < model.quality.areaM2, 'trecho de pouca confiança ocupa menos área');
});

// Sinal da área de um anel de vértices da malha (positivo = anti-horário = contorno de fora).
function ringSign(ring, nx) {
  const W = nx + 1;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += (p % W) * Math.floor(q / W) - (q % W) * Math.floor(p / W);
  }
  return Math.sign(a);
}

test('andares que não começam no zero nem são seguidos', () => {
  const points = [...serpentine(0, 0, 5, 3, 3, 1).map((p) => ({ ...p, floor: -1 })), ...serpentine(0, 0, 5, 3, 3, 1).map((p) => ({ ...p, floor: 2 }))];
  const aps = [{ id: 'aa:00', ssid: 'Casa', x: 2, y: 1, floor: 2 }, ...NEIGHBOURS];
  const { survey, solution } = synth({ points, aps });
  const model = buildMap(survey, solution, { own: ['aa:00'] });
  assertShape(model, points.length);
  assert.deepEqual(
    model.floors.map((f) => f.floor),
    [-1, 2],
  );
  assert.equal(model.aps[0].floor, 2);
  const key = model.networks[0].key;
  // O sinal é mais forte no andar do roteador.
  assert.ok(heatField(model, 1, key).max > heatField(model, 0, key).max + 8);
  assertAnalyses(model);
});

// ---------------------------------------------------------------------------
// Ambientes e divisões
// ---------------------------------------------------------------------------

test('duas salas com nome viram dois ambientes, com uma abertura onde o caminho atravessa', () => {
  const { survey, solution } = twoRooms();
  const model = buildMap(survey, solution, { own: ['aa:00'] });
  assertShape(model, survey.scans.length);
  const floor = model.floors[0];
  assert.deepEqual(floor.rooms.map((r) => r.label).sort(), ['Quarto', 'Sala']);
  assert.ok(floor.rooms.every((r) => !r.auto));
  const sala = floor.rooms.findIndex((r) => r.label === 'Sala');
  const quarto = floor.rooms.findIndex((r) => r.label === 'Quarto');
  const roomAt = (x, y) => floor.room[Math.floor((y - model.bounds.minY) / model.cell) * model.nx + Math.floor((x - model.bounds.minX) / model.cell)];
  // Cada ponto marcado está no ambiente com o nome dele, e os centros ficam cada um do seu lado.
  for (const s of model.spots) assert.equal(roomAt(s.x, s.y), s.label === 'Sala' ? sala : quarto);
  assert.ok(floor.rooms[sala].cx < 3.5 && floor.rooms[quarto].cx > 4.5);
  assert.ok(floor.rooms[sala].scans >= 6 && floor.rooms[quarto].scans >= 6);

  // A divisão fica perto da parede de verdade (x = 4) e tem confiança: o usuário deu dois nomes.
  const inner = floor.walls.filter((w) => w.kind === 'inner');
  assert.ok(inner.length >= 2, 'a abertura parte a divisão em pelo menos dois trechos');
  for (const w of inner) {
    assert.ok(Math.abs((w.x1 + w.x2) / 2 - 4) < 1.2, `divisão em x = ${(w.x1 + w.x2) / 2}`);
    assert.ok(w.conf >= 0.7);
  }
  // A porta (y = 1,5): nenhum trecho de divisão a menos de 30 cm de onde o caminho cruzou.
  const crossing = { x: 4, y: 1.5 };
  const crossX = inner.reduce((s, w) => s + (w.x1 + w.x2) / 2, 0) / inner.length;
  for (const w of inner) {
    const lo = Math.min(w.y1, w.y2);
    const hi = Math.max(w.y1, w.y2);
    assert.ok(hi < crossing.y - 0.3 || lo > crossing.y + 0.3 || Math.abs(crossX - crossing.x) > 1, `trecho de divisão fechando a porta: y de ${lo} a ${hi}`);
  }
  const length = inner.reduce((s, w) => s + Math.hypot(w.x2 - w.x1, w.y2 - w.y1), 0);
  assert.ok(length > 1 && length < 4, `comprimento da divisão: ${length} m`);

  // Sem os nomes (labels: false) não há ambientes; forçando o agrupamento (bancada), são todos automáticos.
  const plain = buildMap(survey, solution, { labels: false });
  assertShape(plain, survey.scans.length);
  assert.equal(plain.floors[0].rooms.length, 0);
  assert.equal(plain.quality.areaM2, model.quality.areaM2);
  const auto = buildMap(survey, solution, { labels: false, autoRooms: true });
  assertShape(auto, survey.scans.length);
  assert.ok(auto.floors[0].rooms.length >= 1 && auto.floors[0].rooms.every((r) => r.auto));

  // Um nome só não divide nada: o andar fica como uma área só (e o lugar marcado continua no mapa).
  const one = structuredClone(survey);
  for (const sc of one.scans) if (sc.label === 'Quarto') delete sc.label;
  const single = buildMap(one, solution, { own: ['aa:00'] });
  assertShape(single, survey.scans.length);
  assert.equal(single.floors[0].rooms.length, 0);
  assert.ok(single.spots.some((sp) => sp.label === 'Sala'));
  // (três lugares marcados, todos "Sala": a nota diz isso, e não que "só um lugar tem nome")
  assert.match(single.quality.notes.join(' | '), /Os lugares marcados têm todos o mesmo nome/);
  assert.doesNotMatch(single.quality.notes.join(' | '), /Só um lugar tem nome/);
  // Um lugar com nome, de verdade: aí sim.
  const lone = structuredClone(survey);
  for (const sc of lone.scans) if (sc.spot !== 0) delete sc.label;
  const loneModel = buildMap(lone, solution, { own: ['aa:00'] });
  assert.equal(loneModel.floors[0].rooms.length, 0);
  assert.match(loneModel.quality.notes.join(' | '), /Só um lugar tem nome/);
});

test('o nome vale perto de onde foi dado: o resto do andar fica sem nome, sem ser repartido', () => {
  // Corredor comprido (16 x 3 m) andado de ponta a ponta; só as duas pontas de um lado têm nome.
  const points = [];
  const spot = (id, x, y, label) => {
    for (let k = 0; k < 3; k++) points.push({ x, y, spot: id, label });
  };
  spot(0, 1, 1.5, 'Sala');
  for (const p of serpentine(1.5, 0.6, 3.6, 2.4, 2, 0.7)) points.push(p);
  spot(1, 4.2, 1.5, 'Cozinha');
  for (const p of serpentine(4.8, 0.6, 15.4, 2.4, 2, 0.7)) points.push(p);
  const aps = [{ id: 'aa:00', ssid: 'Casa', x: 1, y: 0.4, p0: -36 }, { id: 'bb:00', ssid: 'Vizinho B', x: 17, y: 1.5, p0: -40 }, ...NEIGHBOURS];
  const { survey, solution } = synth({ points, aps });
  const model = buildMap(survey, solution, { own: ['aa:00'] });
  assertShape(model, points.length);
  const floor = model.floors[0];
  const named = floor.rooms.filter((r) => !r.auto);
  const rest = floor.rooms.filter((r) => r.auto);
  assert.deepEqual(named.map((r) => r.label).sort(), ['Cozinha', 'Sala']);
  // A sobra é UM trecho só (nada de dividir pelo sinal o que não tem nome) e fica com a maior parte do corredor.
  assert.equal(rest.length, 1, `trechos sem nome: ${rest.map((r) => r.label).join(', ')}`);
  assert.match(rest[0].label, /^Ambiente \d+$/);
  const namedArea = named.reduce((s, r) => s + r.areaM2, 0);
  assert.ok(rest[0].areaM2 > namedArea, `sem nome ${rest[0].areaM2} m² x com nome ${namedArea} m²`);
  // Nenhuma célula a mais de ~5 m das duas marcas leva o nome delas.
  const roomAt = (x, y) => floor.room[Math.floor((y - model.bounds.minY) / model.cell) * model.nx + Math.floor((x - model.bounds.minX) / model.cell)];
  for (const x of [10, 12, 14, 15]) assert.ok(floor.rooms[roomAt(x, 1.5)].auto, `x = ${x} m ficou com o nome "${floor.rooms[roomAt(x, 1.5)].label}"`);
  assert.ok(!floor.rooms[roomAt(1, 1.5)].auto && !floor.rooms[roomAt(4.2, 1.5)].auto);
  // A nota convida a dar nome ao resto.
  assert.match(model.quality.notes.join(' | '), /Parte do mapa está sem nome/);

  // Com todos os trechos batizados não sobra retalho sem nome nem a nota.
  const full = structuredClone(survey);
  let id = 10;
  for (const x of [7, 10, 13]) {
    const near = full.scans.map((s, i) => ({ i, d: Math.hypot(solution.points[i].x - x, solution.points[i].y - 1.5) })).filter((q) => full.scans[q.i].spot == null).sort((p, q) => p.d - q.d)[0];
    full.scans[near.i] = { ...full.scans[near.i], spot: id++, still: true, label: `Quarto ${id}` };
  }
  const all = buildMap(full, solution, { own: ['aa:00'] });
  assertShape(all, points.length);
  assert.ok(all.floors[0].rooms.filter((r) => !r.auto).length === 5);
  assert.doesNotMatch(all.quality.notes.join(' | '), /Parte do mapa está sem nome/);
  assert.ok(all.floors[0].rooms.filter((r) => r.auto).reduce((s, r) => s + r.areaM2, 0) < 8, 'sobra sem nome menor que um cômodo pequeno');
});

test('nomes em andares diferentes não dividem nenhum deles, e a nota explica', () => {
  const up = serpentine(0.6, 0.6, 5.4, 3.4, 3, 0.7).map((p) => ({ ...p, floor: 1 }));
  const down = serpentine(0.6, 0.6, 5.4, 3.4, 3, 0.7).map((p) => ({ ...p, floor: 0 }));
  const points = [];
  for (let k = 0; k < 2; k++) points.push({ x: 1, y: 1, floor: 0, spot: 0, label: 'Sala' });
  points.push(...down);
  for (let k = 0; k < 2; k++) points.push({ x: 1, y: 1, floor: 1, spot: 1, label: 'Quarto' });
  points.push(...up);
  const { survey, solution } = synth({ points, aps: [{ id: 'aa:00', ssid: 'Casa', x: 2.5, y: 2 }, ...NEIGHBOURS] });
  const model = buildMap(survey, solution, {});
  assertShape(model, points.length);
  assert.equal(model.floors.length, 2);
  assert.ok(model.floors.every((f) => f.rooms.length === 0));
  const notes = model.quality.notes.join(' | ');
  assert.match(notes, /Nenhum andar tem dois lugares com nomes diferentes/);
  assert.doesNotMatch(notes, /Só um lugar tem nome/);
});

test('mesmo nome = mesmo ambiente; nomes diferentes nunca se juntam, mesmo com sinal igual', () => {
  // Um cômodo só, sem parede nenhuma, mas o usuário batizou três cantos com nomes diferentes.
  const points = [];
  const names = ['Estar', 'Jantar', 'Estar', 'Leitura'];
  [
    [1, 1],
    [4, 1],
    [1.5, 3.5],
    [4, 3.5],
  ].forEach(([x, y], id) => {
    for (let k = 0; k < 3; k++) points.push({ x, y, spot: id, label: names[id] });
    points.push({ x: x + 0.8, y: y + 0.3 });
  });
  const { survey, solution } = synth({ points, aps: [{ id: 'aa:00', ssid: 'Casa', x: 2.5, y: 2 }, ...NEIGHBOURS] });
  const model = buildMap(survey, solution, {});
  assertShape(model, points.length);
  assert.deepEqual(model.floors[0].rooms.map((r) => r.label).sort(), ['Estar', 'Jantar', 'Leitura']);
  const estar = model.floors[0].rooms.find((r) => r.label === 'Estar');
  assert.ok(estar.scans >= 6, 'os dois pontos "Estar" contam para o mesmo ambiente');
});

test('sem nomes não há ambientes; e o agrupamento automático de um cômodo só não vira uma colcha de retalhos', () => {
  const points = serpentine(0.5, 0.5, 4.5, 3.5, 4, 0.7);
  const { survey, solution } = synth({ points, aps: [{ id: 'aa:00', ssid: 'Casa', x: 1, y: 1 }, ...NEIGHBOURS] });
  const model = buildMap(survey, solution, {});
  assertShape(model, points.length);
  assert.ok(model.quality.areaM2 > 12 && model.quality.areaM2 < 30, `área ${model.quality.areaM2}`);
  assert.equal(model.floors[0].rooms.length, 0);
  const auto = buildMap(survey, solution, { autoRooms: true });
  assertShape(auto, points.length);
  assert.ok(auto.floors[0].rooms.length >= 1 && auto.floors[0].rooms.length <= 2, `${auto.floors[0].rooms.length} ambientes em 20 m²`);
});

// ---------------------------------------------------------------------------
// Redes e roteadores
// ---------------------------------------------------------------------------

test('redes agrupadas por nome, aparelhos por `device`, os da casa primeiro', () => {
  const { survey, solution } = twoRooms();
  // Só o BSSID conectado é informado; o outro rádio do mesmo aparelho tem o mesmo nome.
  const model = buildMap(survey, solution, { own: ['aa:01'] });
  const casa = model.networks[0];
  assert.equal(casa.ssid, 'Casa');
  assert.ok(casa.own);
  assert.deepEqual([...casa.bssids].sort(), ['aa:00', 'aa:01']);
  assert.equal(model.networks.filter((n) => n.own).length, 1);
  // Rede oculta tem chave própria e nome vazio.
  assert.ok(model.networks.some((n) => n.ssid === '' && n.key.length > 0));

  const router = model.aps[0];
  assert.ok(router.own);
  assert.equal(router.id, 'aa:00', 'o id é o BSSID mais forte do aparelho');
  assert.deepEqual([...router.bssids].sort(), ['aa:00', 'aa:01']);
  assert.equal(router.ssid, 'Casa');
  assert.ok(Math.hypot(router.x - 1.5, router.y - 0.4) < 0.01);
  assert.equal(router.floor, 0);
  assert.ok(router.inside);
  assert.ok(router.bestRssi > -50);
  // Vizinho fraco e longe: fora da área e sem andar definido.
  const far = model.aps.find((a) => a.id === 'n2');
  assert.ok(!far.own && !far.inside && far.floor === null);
  assert.ok(far.distanceM > 8);
  // Rumo: o vizinho n2 está a leste-sul do centro (x maior, y menor).
  assert.ok(Math.cos(far.bearing) > 0 && Math.sin(far.bearing) < 0);

  // Sem `own`, nada é da casa; BSSID com maiúsculas também casa.
  assert.ok(buildMap(survey, solution, {}).networks.every((n) => !n.own));
  assert.ok(buildMap(survey, solution, { own: ['AA:00'] }).networks[0].own);
});

// ---------------------------------------------------------------------------
// Campo de sinal
// ---------------------------------------------------------------------------

test('o campo de sinal respeita as medições', () => {
  const { survey, solution } = longHouse(1);
  const model = buildMap(survey, solution, { own: ['cc:00'] });
  assertShape(model, survey.scans.length);
  const net = model.networks[0];
  const field = heatField(model, 0, net.key);
  const floor = model.floors[0];
  const size = model.nx * model.ny;
  let inside = 0;
  for (let c = 0; c < size; c++) {
    if (floor.inside[c]) {
      inside++;
      assert.ok(Number.isFinite(field.dbm[c]), 'célula de dentro sem valor');
      assert.ok(field.dbm[c] >= field.min - 1e-6 && field.dbm[c] <= field.max + 1e-6);
    } else assert.ok(Number.isNaN(field.dbm[c]), 'fora da área é NaN');
    assert.ok(field.conf[c] >= 0 && field.conf[c] <= 1);
    if (!floor.inside[c]) assert.equal(field.conf[c], 0);
  }
  assert.ok(inside > 500);

  // Em cada varredura, o campo fica perto do que foi medido ali (ruído de 1 dB nas leituras).
  let sq = 0;
  let n = 0;
  let worst = 0;
  model.path.forEach((p) => {
    const reading = survey.scans[p.i].readings.find((r) => r.id === 'cc:00');
    if (!reading) return;
    const c = Math.floor((p.y - model.bounds.minY) / model.cell) * model.nx + Math.floor((p.x - model.bounds.minX) / model.cell);
    assert.ok(field.conf[c] > 0.3, 'em cima de uma medição a confiança não é baixa');
    const d = field.dbm[c] - reading.rssi;
    sq += d * d;
    n++;
    worst = Math.max(worst, Math.abs(d));
  });
  assert.ok(n > 25);
  assert.ok(Math.sqrt(sq / n) < 2.5, `RMSE nas medições: ${Math.sqrt(sq / n).toFixed(2)} dB`);
  assert.ok(worst < 8, `pior desvio: ${worst.toFixed(1)} dB`);

  // Forte perto do roteador, fraco na outra ponta: nada de alisar a casa inteira.
  const at = (x, y) => field.dbm[Math.floor((y - model.bounds.minY) / model.cell) * model.nx + Math.floor((x - model.bounds.minX) / model.cell)];
  assert.ok(at(1.5, 2) > -50, `perto do roteador: ${at(1.5, 2)}`);
  assert.ok(at(14.5, 2) < -78, `na outra ponta: ${at(14.5, 2)}`);
  assert.ok(field.max - field.min > 30);

  // A mesma chamada devolve o mesmo campo (guardado), e rede/andar desconhecidos dão um campo vazio.
  assert.equal(heatField(model, 0, net.key), field);
  for (const empty of [heatField(model, 0, 'nao-existe'), heatField(model, 5, net.key)]) {
    assert.ok(empty.dbm.every((v) => Number.isNaN(v)) && empty.conf.every((v) => v === 0));
  }
});

test('sinal da rede conectada entre as varreduras (survey.track): entra no campo com posição, medidor e rede conferidos', () => {
  // Uma ida reta de 12 m, uma varredura a cada 3,5 s (1,5 m); o roteador da casa tem dois rádios com o mesmo nome.
  const points = Array.from({ length: 9 }, (_, i) => ({ x: 1 + 1.5 * i, y: 2 }));
  const aps = [
    { id: 'aa:24', ssid: 'Casa', device: 'r1', x: 1, y: 2.5, p0: -38 },
    { id: 'aa:50', ssid: 'Casa', device: 'r1', x: 1, y: 2.5, p0: -48, freq: 5180 },
    ...NEIGHBOURS,
  ];
  const { survey, solution } = synth({ points, aps, noise: 0.5, conf: 1 });
  const key = 's:Casa';
  const real = (x) => -38 - 26 * Math.log10(Math.max(0.5, Math.hypot(x - 1, 0.5, 1)));
  // Amostras do rádio de 2,4 GHz (o mais forte da rede) a cada segundo; o medidor do sinal conectado lê 4 dB a mais.
  const lag = _dev.TUNE.trackLagS;
  const track = [];
  for (let t = 2; t <= 3 + 8 * 3.5; t += 1) {
    const x = 1 + (1.5 * (t - (3 - lag))) / 3.5; // onde a pessoa estava (a posição da varredura é a de `lag` s antes da lista)
    track.push({ t, id: 'aa:24', rssi: Math.round(real(Math.min(13, Math.max(1, x))) + 4) });
  }
  const plain = buildMap(survey, solution, { own: ['aa:24'] });
  const withTrack = buildMap({ ...survey, track }, solution, { own: ['aa:24'] });
  assertShape(withTrack, points.length);
  assert.deepEqual(Object.keys(plain._heat.track), [], 'sem amostras, nada a mais');
  const pack = withTrack._heat.track[key];
  assert.ok(pack && pack.v.length >= 12, `amostras agrupadas: ${pack && pack.v.length}`);
  assert.ok(pack.x instanceof Float32Array && pack.f instanceof Int16Array, 'vetores tipados: atravessam o postMessage');
  // posições na reta andada, entre a primeira e a última varredura
  for (let i = 0; i < pack.v.length; i++) {
    assert.ok(Math.abs(pack.y[i] - 2) < 1e-6 && pack.x[i] >= 1 - 1e-6 && pack.x[i] <= 13 + 1e-6, `amostra em (${pack.x[i]}, ${pack.y[i]})`);
    assert.ok(pack.w[i] > 0 && pack.w[i] <= _dev.TUNE.trackBinW + 1e-6);
    // o desvio do medidor (4 dB) foi descontado: o valor bate com o campo de verdade ali
    assert.ok(Math.abs(pack.v[i] - real(pack.x[i])) < 2.5, `amostra em x=${pack.x[i].toFixed(1)}: ${pack.v[i].toFixed(1)} x real ${real(pack.x[i]).toFixed(1)}`);
  }
  // o campo com as amostras continua fiel ao que as varreduras mediram; a CONFIANÇA é a das
  // varreduras, nem mais nem menos: a amostra não traz lugar novo, e contá-la faria o campo parecer
  // mais certo do que é (medido na bancada: a área "de confiança" crescia sem o erro cair)
  const a = heatField(plain, 0, key);
  const b = heatField(withTrack, 0, key);
  const cellAt = (m, x, y) => Math.floor((y - m.bounds.minY) / m.cell) * m.nx + Math.floor((x - m.bounds.minX) / m.cell);
  for (const x of [2, 5, 8, 11]) {
    assert.ok(Math.abs(b.dbm[cellAt(withTrack, x, 2)] - a.dbm[cellAt(plain, x, 2)]) < 2.5, `campo em x=${x}`);
  }
  assert.deepEqual(b.conf, a.conf, 'as amostras do sinal conectado não mexem na confiança do campo');
  assert.notDeepEqual(b.dbm, a.dbm, 'mas entram no valor');
  assert.deepEqual(heatField(structuredClone(withTrack), 0, key), b, 'o modelo com as amostras sobrevive a um structuredClone');

  // Amostras do rádio que NÃO é o mais forte da rede (5 GHz, 10 dB abaixo) ficam de fora: não são a mesma grandeza.
  const weakRadio = track.map((q) => ({ ...q, id: 'aa:50', rssi: q.rssi - 10 }));
  assert.equal(buildMap({ ...survey, track: weakRadio }, solution, {})._heat.track[key], undefined);
  // Rádio que nenhuma varredura ouviu, amostras tortas e poucas demais para medir o desvio: nada entra.
  for (const bad of [[{ t: 5, id: 'zz:99', rssi: -50 }], [null, { t: 'x', id: 'aa:24', rssi: -50 }, { t: 4, id: 'aa:24' }], track.slice(0, 2)]) {
    assert.deepEqual(Object.keys(buildMap({ ...survey, track: bad }, solution, {})._heat.track), []);
  }
  // Varreduras a cada 30 s: a reta entre duas não serve de posição; só valem as amostras feitas junto de uma varredura.
  const slow = structuredClone(survey);
  slow.scans.forEach((sc, i) => (sc.t = 3 + 30 * i));
  const slowTrack = [];
  for (let t = 1; t <= 3 + 8 * 30; t += 2) slowTrack.push({ t, id: 'aa:24', rssi: -60 });
  const sparse = buildMap({ ...slow, track: slowTrack }, solution, {})._heat.track[key];
  assert.ok(sparse && sparse.v.length <= points.length, `no máximo um grupo por varredura: ${sparse && sparse.v.length}`);
  for (let i = 0; i < sparse.v.length; i++) assert.ok(points.some((p) => Math.abs(p.x - sparse.x[i]) < 1e-3), 'amostra em cima de uma varredura');
});

test('varredura que não ouviu a rede conta como sinal no piso; beacon perdido e leitura velha não', () => {
  const { survey, solution } = longHouse(1);
  // Na ponta de lá a rede some de vez (parede a mais): as varreduras de lá não a ouvem.
  const gone = structuredClone(survey);
  gone.scans.forEach((s, i) => {
    if (solution.points[i].x > 12.5) s.readings = s.readings.filter((r) => r.id !== 'cc:00');
  });
  let model = buildMap(gone, solution, { own: ['cc:00'] });
  let field = heatField(model, 0, model.networks[0].key);
  const at = (m, f, x, y) => f.dbm[Math.floor((y - m.bounds.minY) / m.cell) * m.nx + Math.floor((x - m.bounds.minX) / m.cell)];
  assert.ok(at(model, field, 14.5, 2) < -84, `onde a rede não chega: ${at(model, field, 14.5, 2)}`);
  assert.ok(coverage(model, model.networks[0].key).dead > 0.08);

  // Uma única varredura sem a rede no meio de vizinhas fortes = beacon perdido: não abre um buraco.
  const miss = structuredClone(survey);
  const victim = solution.points.findIndex((p) => p.x > 2 && p.x < 3 && p.y > 1.5 && p.y < 2.5);
  const before = at(buildMap(survey, solution, {}), heatField(buildMap(survey, solution, {}), 0, 's:Casa Longa'), solution.points[victim].x, solution.points[victim].y);
  miss.scans[victim].readings = miss.scans[victim].readings.filter((r) => r.id !== 'cc:00');
  model = buildMap(miss, solution, {});
  field = heatField(model, 0, 's:Casa Longa');
  assert.ok(Math.abs(at(model, field, solution.points[victim].x, solution.points[victim].y) - before) < 4);

  // Leitura velha (o Android repetiu a da varredura anterior) com valor absurdo: é ignorada.
  const stale = structuredClone(survey);
  stale.scans[victim].readings = stale.scans[victim].readings.map((r) => (r.id === 'cc:00' ? { ...r, rssi: -89, ageMs: 15000 } : r));
  model = buildMap(stale, solution, {});
  field = heatField(model, 0, 's:Casa Longa');
  assert.ok(Math.abs(at(model, field, solution.points[victim].x, solution.points[victim].y) - before) < 4);
});

// ---------------------------------------------------------------------------
// Cobertura e sugestão
// ---------------------------------------------------------------------------

test('cobertura: frações somam 1, zonas mortas e extremos coerentes', () => {
  const { survey, solution } = longHouse(1);
  const model = buildMap(survey, solution, { own: ['cc:00'] });
  for (const net of model.networks) {
    const cov = coverage(model, net.key);
    for (const v of [cov.good, cov.fair, cov.weak, cov.dead]) assert.ok(v >= 0 && v <= 1);
    assert.ok(Math.abs(cov.good + cov.fair + cov.weak + cov.dead - 1) < 1e-9, net.key);
    assert.ok(cov.best.dbm >= cov.worst.dbm);
    for (const z of cov.deadZones) {
      assert.ok(z.areaM2 >= 1 && z.dbm < -82 && z.floor === 0);
      assert.ok(z.room === null || typeof z.room === 'string');
    }
  }
  const cov = coverage(model, model.networks[0].key);
  // Roteador numa ponta de uma casa de 16 m com três paredes: bom perto, morto longe.
  assert.ok(cov.good > 0.2 && cov.good < 0.7, `bom: ${cov.good}`);
  assert.ok(cov.dead > 0.1, `morto: ${cov.dead}`);
  assert.ok(cov.best.x < 4 && cov.worst.x > 11, 'melhor ponto perto do roteador, pior na outra ponta');
  assert.ok(cov.deadZones.length >= 1 && cov.deadZones[0].x > 10);
  assert.equal(cov.best.room, null, 'levantamento sem lugares com nome: os extremos não têm ambiente');
  // Rede desconhecida: nada de cobertura.
  assert.deepEqual(coverage(model, 'nao-existe').dead, 1);
});

test('sugestão de lugar: roteador na ponta sugere o meio; no meio, fica onde está', () => {
  // Na ponta.
  let { survey, solution } = longHouse(1);
  let model = buildMap(survey, solution, { own: ['cc:00'] });
  const key = model.networks[0].key;
  const tip = suggestRouterSpot(model, key);
  assert.ok(tip, 'esperava uma sugestão');
  assert.equal(tip.currentIsCentral, false);
  assert.equal(tip.floor, 0);
  assert.ok(tip.x > 4.5 && tip.x < 12, `lugar sugerido em x = ${tip.x}`);
  assert.match(tip.gainText, /^Sugestão: /);
  assert.match(tip.gainText, /estimativa/);
  assert.equal(tip.room, null, 'levantamento sem lugares com nome: a sugestão não cita ambiente');
  assert.match(tip.gainText, /mais perto do meio da área/);
  // O lugar sugerido é um lugar por onde se andou.
  const c = Math.floor((tip.y - model.bounds.minY) / model.cell) * model.nx + Math.floor((tip.x - model.bounds.minX) / model.cell);
  assert.equal(model.floors[0].inside[c], 1);
  assert.ok(describeMap(model).includes(tip.gainText));

  // Rede de vizinho, ou sem dizer qual é a da casa e com o roteador fora da área: nada a sugerir.
  const other = model.networks.find((n) => !n.own);
  assert.equal(suggestRouterSpot(model, other.key), null);
  assert.equal(suggestRouterSpot(model, 'nao-existe'), null);
  assert.equal(suggestRouterSpot(buildMap(survey, solution, {}), other.key), null);

  // No meio.
  ({ survey, solution } = longHouse(8));
  model = buildMap(survey, solution, { own: ['cc:00'] });
  const stay = suggestRouterSpot(model, model.networks[0].key);
  assert.ok(stay && stay.currentIsCentral);
  assert.ok(Math.abs(stay.x - 8) < 0.01 && Math.abs(stay.y - 2) < 0.01);
  assert.doesNotMatch(stay.gainText, /^Sugestão/);

  // Roteador com posição pouco confiável: não arrisca.
  const { survey: s2, solution: sol2 } = longHouse(1);
  sol2.aps['cc:00'].conf = 0.05;
  assert.equal(suggestRouterSpot(buildMap(s2, sol2, { own: ['cc:00'] }), key), null);
});

test('rede que sai de vários aparelhos (malha) não recebe sugestão de mudança', () => {
  const points = serpentine(0.8, 0.6, 15.2, 3.4, 3, 1.3);
  const aps = [
    { id: 'm1', ssid: 'Malha', device: 'no1', x: 1, y: 2, n: 3 },
    { id: 'm2', ssid: 'Malha', device: 'no2', x: 15, y: 2, n: 3 },
    ...NEIGHBOURS,
  ];
  const { survey, solution } = synth({ points, aps });
  const model = buildMap(survey, solution, { own: ['m1'] });
  assert.equal(model.aps.filter((a) => a.own).length, 2, 'os dois nós da malha são da casa');
  assert.equal(suggestRouterSpot(model, model.networks[0].key), null);
});

// ---------------------------------------------------------------------------
// Qualidade e descrição
// ---------------------------------------------------------------------------

test('qualidade: notas concretas sobre o que limita o mapa', () => {
  const aps = [{ id: 'aa:00', ssid: 'Casa', x: 1, y: 1 }];
  // Poucos pontos, um roteador só, varreduras a cada 30 s, escala incerta, nenhum ponto marcado.
  const few = synth({ points: serpentine(0, 0, 4, 3, 2, 1), aps, interval: 30 });
  few.solution.scaleConf = 0.1;
  const weak = buildMap(few.survey, few.solution, {});
  const notes = weak.quality.notes.join(' | ');
  // Um roteador só: disso não sai mapa, e é a primeira coisa que o mapa diz.
  assert.match(weak.quality.notes[0], /^Só um roteador ao alcance\. .*pelo menos três roteadores/);
  assert.equal(weak.quality.usable, false);
  assert.match(notes, /Poucas leituras: ande por mais cômodos/);
  assert.match(notes, /Leituras lentas/);
  assert.match(notes, /nenhum lugar tem nome: pare em pelo menos dois cômodos/);
  assert.equal(weak.quality.level, 'fraca');

  // Os mesmos lugares com três vizinhos ao alcance: mapa fraco, mas mapa; e o tamanho incerto vem com o remédio.
  const some = synth({ points: serpentine(0, 0, 4, 3, 2, 1), aps: [...aps, ...NEIGHBOURS.slice(0, 3)], interval: 30 });
  some.solution.scaleConf = 0.1;
  const poor = buildMap(some.survey, some.solution, {});
  assert.equal(poor.quality.usable, true);
  assert.match(poor.quality.notes.join(' | '), /O tamanho é incerto: .*Ajustar a escala/);
  assert.doesNotMatch(poor.quality.notes.join(' | '), /Só um roteador ao alcance/);
  // Dois roteadores: desenha, avisa que pode não lembrar a casa e não passa de 'fraca'.
  const two = synth({ points: serpentine(0.5, 0.5, 6.5, 5.5, 5, 0.8), aps: [...aps, NEIGHBOURS[0]] });
  const twoQ = buildMap(two.survey, two.solution, {}).quality;
  assert.equal(twoQ.usable, true);
  assert.equal(twoQ.level, 'fraca');
  assert.match(twoQ.notes.join(' | '), /Só dois roteadores ao alcance/);
  // Parado no mesmo lugar (o sinal não muda): não é um mapa, e a nota diz o que fazer.
  const stuck = synth({ points: Array.from({ length: 30 }, (_, i) => ({ x: 2 + 0.05 * Math.sin(i), y: 2 })), aps: [...aps, ...NEIGHBOURS] });
  const stuckQ = buildMap(stuck.survey, stuck.solution, {}).quality;
  assert.equal(stuckQ.usable, false);
  assert.match(stuckQ.notes[0], /O sinal quase não mudou.*Ande por todos os cômodos/);
  assert.equal(stuckQ.level, 'fraca');

  // Levantamento farto numa casa de tamanho comum (8 x 6 m): nível bom, sem aviso de falta de dados.
  const homeAps = [{ id: 'own:24', ssid: 'Casa', device: 'r1', x: 2, y: 2, p0: -37 }, { id: 'own:5', ssid: 'Casa', device: 'r1', x: 2, y: 2, p0: -40, freq: 5220 }, { id: 'vz:1', ssid: 'Ao lado', x: 9, y: 3, p0: -40 }, ...NEIGHBOURS];
  const { survey, solution } = synth({ points: serpentine(0.6, 0.6, 7.4, 5.4, 6, 0.55), aps: homeAps, noise: 1.5, seed: 11 });
  const good = buildMap(survey, solution, { own: ['own:24'] });
  assert.equal(good.quality.level, 'boa');
  assert.equal(good.quality.usable, true);
  assert.ok(good.quality.expectedErrorM >= 0.5 && good.quality.expectedErrorM <= 3, `erro esperado ${good.quality.expectedErrorM}`);
  assert.doesNotMatch(good.quality.notes.join(' | '), /Poucas leituras|Só um roteador|Só dois roteadores|Leituras lentas|quase não mudou|Lugar grande/);
  // Casa grande com um roteador só (126 m²): o tamanho do desenho, sozinho, não rebaixa nada.
  const big = bigSurvey();
  const bigQ = buildMap(big.survey, big.solution, { own: ['own:24'] }).quality;
  assert.ok(bigQ.areaM2 > 100, `área ${bigQ.areaM2}`);
  assert.equal(bigQ.level, 'boa');
  assert.doesNotMatch(bigQ.notes.join(' | '), /Lugar grande/);
  // Rede que sai de três pontos de acesso ou mais = lugar amplo (escritório): o mapa costuma sair
  // encolhido, nunca é 'boa', e a nota diz o que fazer.
  const wideAps = [0, 1, 2].map((k) => ({ id: `corp:${k}`, ssid: 'Empresa', device: `ap${k}`, x: 2 + 4.5 * k, y: 2 + 2.5 * (k % 2), p0: -38 }));
  const wide = synth({ points: serpentine(0.6, 0.6, 13.4, 9.4, 10, 0.55).slice(0, 230), aps: [...wideAps, ...NEIGHBOURS], noise: 1.5, seed: 11 });
  const wideQ = buildMap(wide.survey, wide.solution, { own: ['corp:0'] }).quality;
  assert.equal(wideQ.usable, true);
  assert.equal(wideQ.level, 'razoavel');
  assert.match(wideQ.notes.join(' | '), /Lugar grande \(a sua rede sai de 3 pontos de acesso\).*Ajustar a escala/);
  // A confiança do solucionador pesa: a mesma caminhada com confiança baixa nos pontos.
  const shaky = structuredClone(solution);
  shaky.points.forEach((p, i) => (p.conf = i % 3 ? 0.15 : 0.3));
  assert.ok(buildMap(survey, shaky, {}).quality.expectedErrorM > good.quality.expectedErrorM);
  // A cadência também: os mesmos lugares, uma varredura a cada 30 s.
  const slow = structuredClone(survey);
  slow.scans.forEach((s, i) => (s.t = 3 + 30 * i));
  const slowQ = buildMap(slow, solution, {}).quality;
  assert.ok(slowQ.expectedErrorM > good.quality.expectedErrorM);
  assert.notEqual(slowQ.level, 'boa');
});

test('describeMap resume área, ambientes, roteador e cobertura em frases', () => {
  const { survey, solution } = twoRooms();
  const model = buildMap(survey, solution, { own: ['aa:00'] });
  const text = describeMap(model);
  const all = text.join('\n');
  assert.match(text[0], /^Mapa aproximado, feito só com o sinal do Wi-Fi: área de cerca de \d+ m² em 1 andar, com 2 ambientes/);
  assert.match(all, /Não é uma planta/);
  assert.match(all, /Ambientes: .*Sala \(cerca de \d+ m²\)/);
  assert.match(all, /Roteador "Casa": posição estimada em "Sala"/);
  assert.match(all, /Rede "Casa": sinal bom em \d+% da área/);
  assert.match(all, /aparelhos de vizinhos foram ouvidos/);
  // Números no formato brasileiro (vírgula decimal).
  assert.match(all, /erro típico de uns \d+,\d m/);
  for (const note of model.quality.notes) assert.ok(text.includes(note));
  // Sem levantamento: orientação, não uma descrição vazia.
  assert.match(describeMap(buildMap({}, {})).join(' '), /Ainda não há mapa/);
  assert.deepEqual(describeMap(null), ['Mapa indisponível.']);
});

// ---------------------------------------------------------------------------
// Opções
// ---------------------------------------------------------------------------

test('options.cell define a célula (entre 0,2 e 0,5 m)', () => {
  const { survey, solution } = twoRooms();
  assert.equal(buildMap(survey, solution, {}).cell, 0.25);
  for (const [asked, got] of [
    [0.4, 0.4],
    [0.05, 0.2],
    [3, 0.5],
    [NaN, 0.25],
  ]) {
    const model = buildMap(survey, solution, { cell: asked });
    assert.equal(model.cell, got);
    assertShape(model, survey.scans.length);
  }
  // A área estimada quase não depende da célula.
  const fine = buildMap(survey, solution, { cell: 0.2 }).quality.areaM2;
  const coarse = buildMap(survey, solution, { cell: 0.5 }).quality.areaM2;
  assert.ok(Math.abs(fine - coarse) / fine < 0.25, `${fine} m² x ${coarse} m²`);
});

// ---------------------------------------------------------------------------
// Desempenho
// ---------------------------------------------------------------------------

test('desempenho: 230 varreduras e 35 BSSIDs em bem menos de 1 s; campo de sinal em dezenas de ms', () => {
  const { survey, solution } = bigSurvey();
  assert.equal(survey.scans.length, 230);
  assert.equal(Object.keys(survey.aps).length, 35);
  // O melhor de 5: a máquina de testes é compartilhada.
  let build = Infinity;
  let heat = Infinity;
  let model;
  for (let k = 0; k < 5; k++) {
    let t0 = performance.now();
    model = buildMap(survey, solution, { own: ['own:24'] });
    build = Math.min(build, performance.now() - t0);
    t0 = performance.now();
    heatField(model, 0, model.networks[0].key);
    heat = Math.min(heat, performance.now() - t0);
  }
  assertShape(model, 230);
  assert.ok(model.quality.areaM2 > 100 && model.quality.areaM2 < 180, `área ${model.quality.areaM2} m² para 13 x 9 m andados`);
  assert.ok(build < 500, `buildMap levou ${build.toFixed(0)} ms`);
  assert.ok(heat < 100, `heatField levou ${heat.toFixed(1)} ms`);
});

// ---------------------------------------------------------------------------
// Peças internas
// ---------------------------------------------------------------------------

test('transformada de distância, contorno e corte de linhas', () => {
  // Distância ao quadrado até a célula marcada mais próxima.
  const nx = 6;
  const ny = 5;
  const src = new Uint8Array(nx * ny);
  src[1 * nx + 1] = 1;
  src[3 * nx + 4] = 1;
  const d = _dev.distanceTransform(src, nx, ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      assert.equal(d[j * nx + i], Math.min((i - 1) ** 2 + (j - 1) ** 2, (i - 4) ** 2 + (j - 3) ** 2));
    }
  }

  // Um quadrado com um buraco: um anel de fora (anti-horário) e um de dentro (horário).
  const m = 7;
  const mask = new Uint8Array(m * m);
  for (let j = 1; j <= 5; j++) for (let i = 1; i <= 5; i++) mask[j * m + i] = 1;
  mask[3 * m + 3] = 0;
  const rings = _dev.traceRings(mask, m, m);
  assert.equal(rings.length, 2);
  assert.deepEqual(rings.map((r) => r.length).sort((a, b) => a - b), [4, 20]);
  assert.deepEqual(rings.map((r) => ringSign(r, m)).sort(), [-1, 1]);
  // Duas células em diagonal: dois anéis separados que só se tocam na quina.
  const diag = new Uint8Array(16);
  diag[1 * 4 + 1] = 1;
  diag[2 * 4 + 2] = 1;
  const two = _dev.traceRings(diag, 4, 4);
  assert.deepEqual(two.map((r) => r.length), [4, 4]);

  // Simplificação: uma escada vira uma reta; um canto de verdade fica.
  const stairs = Array.from({ length: 21 }, (_, k) => [Math.ceil(k / 2) * 0.25, Math.floor(k / 2) * 0.25]);
  assert.equal(_dev.simplifyOpen(stairs, 0.2).length, 2);
  const corner = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]];
  assert.deepEqual(_dev.simplifyOpen(corner, 0.2), [[0, 0], [2, 0], [2, 2]]);

  // Corte: tira o trecho de 1,5 a 2,5 m de uma linha de 4 m em L.
  const cut = _dev.cutPolyline([[0, 0], [2, 0], [2, 2]], [[1.5, 2.5]]);
  assert.deepEqual(cut, [
    [0, 0, 1.5, 0],
    [2, 0.5, 2, 2],
  ]);
});

// ---------------------------------------------------------------------------
// Custo com muitos BSSIDs (arquivo hostil ou enxurrada de redes falsas no levantamento)
// ---------------------------------------------------------------------------

test('buildMap: o custo cresce em linha com o número de BSSIDs diferentes, não com o quadrado', async () => {
  const { buildMap: build } = await import('../app/js/mapping/mapmodel.js');
  const hx = (n) => (n & 255).toString(16).padStart(2, '0');
  // cada leitura é de um BSSID que nunca se repete: `scans` x `per` aparelhos diferentes
  const flood = (scans, per) => {
    const list = [];
    const points = [];
    for (let s = 0; s < scans; s++) {
      const readings = [];
      for (let i = 0; i < per; i++) readings.push({ id: `02:${hx(s >> 8)}:${hx(s)}:00:${hx(i >> 8)}:${hx(i)}`, rssi: -40 - ((i + s) % 50), freq: 2412 });
      list.push({ t: s * 3, floor: 0, still: false, spot: null, readings });
      points.push({ x: (s % 10) * 0.8, y: Math.floor(s / 10) * 0.8, z: 1, conf: 0.8 });
    }
    return [{ version: 1, scans: list, aps: {}, track: [], rtt: [], knownDistances: [] }, { points, aps: {}, scaleConf: 0.5 }];
  };
  const timeOf = (scans, per) => {
    const [survey, solution] = flood(scans, per);
    let best = Infinity;
    let model = null;
    for (let round = 0; round < 2; round++) {
      const t0 = performance.now();
      model = build(survey, solution, { own: [] });
      best = Math.min(best, performance.now() - t0);
    }
    return { ms: best, model };
  };
  timeOf(4, 50); // aquece
  const small = timeOf(40, 150); // 6.000 aparelhos
  const big = timeOf(40, 600); // 24.000 aparelhos: 4 vezes mais
  assert.equal(small.model.aps.length, 6000);
  assert.equal(big.model.aps.length, 24000);
  // em linha seriam ~4x; os dois laços que eram quadráticos davam mais de 12x (e 15 s com 31.000)
  assert.ok(big.ms < Math.max(small.ms, 20) * 9, `4x mais aparelhos custaram ${(big.ms / small.ms).toFixed(1)}x (${Math.round(small.ms)} ms -> ${Math.round(big.ms)} ms)`);
  // cada aparelho ficou onde foi ouvido (um ponto só): a conta invertida dá o mesmo resultado
  const first = big.model.aps.find((a) => a.id === '02:00:00:00:00:00');
  assert.ok(first && Math.abs(first.x) < 1e-9 && Math.abs(first.y) < 1e-9);
});
