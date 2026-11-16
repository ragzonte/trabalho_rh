// Testes do solucionador do mapa (app/js/mapping/solver.js): contrato, guardas de precisão,
// repetibilidade, entradas degeneradas, calibração do usuário, tempo, cancelamento e a prévia ao vivo.
//
// As guardas de precisão usam limites folgados: pegam um solucionador quebrado (mapa colapsado,
// espelhado por andar, escala absurda), não o ruído entre uma versão e outra. A nota fina é da
// bancada (tests/mapping/harness.mjs).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SOLVER_INFO, solve, solveQuick } from '../app/js/mapping/solver.js';
import { fuseScale, mapSpan } from '../app/js/mapping/solver-scale.js';
import { FLOOR_HEIGHT } from '../app/js/mapping/types.js';
import { presetSpec } from '../app/js/sim/presets.js';
import { planWalk, simulateSurvey } from '../app/js/sim/walk.js';
import { createWorld } from '../app/js/sim/world.js';
import { buildScenario, listScenarios } from './mapping/harness.mjs';
import { evaluate, procrustes } from './mapping/metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAPPING = path.join(HERE, '..', 'app', 'js', 'mapping');
const ENGINES = ['isomap', 'chain', 'fields', 'range'];

// ---------------------------------------------------------------------------
// Ajudas
// ---------------------------------------------------------------------------

/** Levantamento simulado (semente fixa): mundo pronto + caminhada. */
function makeSurvey(world, walk, options = {}) {
  const w = createWorld(presetSpec(world, 1), 1);
  const plan = planWalk(w, { seed: 5, ...walk });
  return simulateSurvey(w, plan, { seed: 5, ...options });
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const median = (values) => {
  const v = values.slice().sort((a, b) => a - b);
  return v.length % 2 ? v[v.length >> 1] : 0.5 * (v[v.length / 2 - 1] + v[v.length / 2]);
};
const radius = (points) => {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return Math.sqrt(points.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / points.length);
};
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/** Confere o contrato da saída para um levantamento qualquer (válido ou não). */
function assertContract(solution, survey, label) {
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : [];
  assert.ok(solution && typeof solution === 'object', `${label}: devolve um objeto`);
  assert.ok(Array.isArray(solution.points), `${label}: points é uma lista`);
  assert.equal(solution.points.length, scans.length, `${label}: um ponto por varredura`);
  const spots = new Map();
  solution.points.forEach((p, i) => {
    assert.ok(p && [p.x, p.y, p.z, p.conf].every(Number.isFinite), `${label}: ponto ${i} finito`);
    assert.ok(p.conf >= 0 && p.conf <= 1, `${label}: conf do ponto ${i} em 0..1`);
    const s = scans[i];
    const floor = s && Number.isFinite(Number(s.floor)) ? Math.round(Number(s.floor)) : 0;
    if (Math.abs(floor) <= 20) assert.ok(Math.abs(p.z - floor * FLOOR_HEIGHT) < 1e-9, `${label}: z do ponto ${i} = andar x pé-direito`);
    if (s && s.spot != null) {
      const key = String(s.spot);
      if (spots.has(key)) assert.ok(dist(spots.get(key), p) < 1e-9, `${label}: varreduras do ponto ${key} na mesma posição`);
      else spots.set(key, p);
    }
  });
  assert.ok(solution.aps && typeof solution.aps === 'object', `${label}: aps é um objeto`);
  for (const [id, a] of Object.entries(solution.aps)) {
    assert.ok([a.x, a.y, a.z, a.p0, a.n, a.conf].every(Number.isFinite), `${label}: roteador ${id} finito`);
    assert.ok(a.conf >= 0 && a.conf <= 1, `${label}: conf do roteador ${id} em 0..1`);
  }
  assert.ok(Number.isFinite(solution.scaleConf) && solution.scaleConf >= 0 && solution.scaleConf <= 1, `${label}: scaleConf em 0..1`);
}

// Cenários fixos da bancada, resolvidos uma vez só e aproveitados por vários testes.
const GUARDS = [
  // nome, nota máxima, erro mediano máximo (m) — o colapso no centro dá nota 100
  ['apartamento-tour-3.5s-s2', 62, 2.2],
  ['escritorio-tour-3.5s-s1', 62, 4.5],
  ['sobrado-tour-3.5s-s2', 78, 2.6],
  ['kitnet-pontos-30s-s2', 72, 1.6],
];
const solved = new Map();
async function guard(name) {
  if (!solved.has(name)) {
    const scenario = buildScenario(listScenarios('dev').find((s) => s.name === name));
    const input = clone(scenario.survey);
    const stages = [];
    const solution = await solve(input, { onProgress: (fraction, stage) => stages.push([fraction, stage]) });
    solved.set(name, { scenario, solution, stages, untouched: JSON.stringify(input) === JSON.stringify(scenario.survey) });
  }
  return solved.get(name);
}

const SMALL = makeSurvey('kitnet', { kind: 'tour', minLengthM: 60 });
const SPOTS = makeSurvey('apartamento', { kind: 'spots', count: 12 }, { scanIntervalS: 3.5, stillScans: 3 });

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

test('SOLVER_INFO: nome, versão e erro esperado honestos', () => {
  assert.equal(typeof SOLVER_INFO.name, 'string');
  assert.match(SOLVER_INFO.version, /^\d+\.\d+\.\d+$/);
  const { casa, escritorio } = SOLVER_INFO.expectedErrorM;
  assert.ok(casa >= 1 && casa <= 2, 'casa: entre 1 e 2 m (bancada: ~1,3 m)');
  assert.ok(escritorio >= 1.8 && escritorio <= 3.5, 'escritório: entre 2 e 3 m (bancada: ~2,3 m)');
  assert.ok(escritorio > casa);
  assert.ok(Array.isArray(SOLVER_INFO.notes) && SOLVER_INFO.notes.length > 0 && SOLVER_INFO.notes.every((n) => typeof n === 'string' && n.length > 10));
});

test('solve: contrato da saída nos cenários fixos (um andar, dois andares, pontos a cada 30 s)', async () => {
  for (const [name] of GUARDS) {
    const { scenario, solution, untouched } = await guard(name);
    const { survey } = scenario;
    assertContract(solution, survey, name);
    assert.ok(untouched, `${name}: o levantamento de entrada não é alterado`);
    // Convenção de saída: origem no centro e eixo x na direção de maior espalhamento.
    const n = solution.points.length;
    const mx = solution.points.reduce((s, p) => s + p.x, 0) / n;
    const my = solution.points.reduce((s, p) => s + p.y, 0) / n;
    assert.ok(Math.hypot(mx, my) < 1e-6, `${name}: centro na origem`);
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const p of solution.points) {
      sxx += p.x * p.x;
      sxy += p.x * p.y;
      syy += p.y * p.y;
    }
    assert.ok(sxx >= syy && Math.abs(sxy) < 1e-6 * (sxx + syy), `${name}: eixo x no maior espalhamento`);
    // Roteadores: há entradas, e os BSSIDs de um mesmo aparelho ficam juntos.
    assert.ok(Object.keys(solution.aps).length >= 2, `${name}: roteadores posicionados`);
    const byDevice = new Map();
    for (const [id, meta] of Object.entries(survey.aps)) {
      if (!solution.aps[id] || meta.device == null) continue;
      if (!byDevice.has(meta.device)) byDevice.set(meta.device, solution.aps[id]);
      else assert.ok(dist(byDevice.get(meta.device), solution.aps[id]) < 1e-6, `${name}: aparelho ${meta.device} numa posição só`);
    }
    // Os quatro motores entraram (tempo padrão de sobra) e o resumo cabe numa mensagem.
    assert.deepEqual(solution.debug.members.map((m) => m.name), ENGINES, `${name}: motores usados`);
    assert.deepEqual(solution.debug.skipped, []);
    assert.ok(solution.debug.agreementM > 0 && solution.debug.expectedErrorM > 0.5);
    assert.ok(JSON.stringify(solution.debug).length < 1000);
  }
});

test('solve: avisa o andamento em ordem, com etapas em português', async () => {
  const { stages } = await guard(GUARDS[0][0]);
  assert.ok(stages.length >= 6, 'uma etapa por motor, mais leitura, junção e fim');
  let last = -1;
  for (const [fraction, stage] of stages) {
    assert.ok(fraction >= last && fraction >= 0 && fraction <= 1, 'frações crescentes em 0..1');
    assert.ok(typeof stage === 'string' && stage.length > 3, 'etapa com nome');
    last = fraction;
  }
  assert.equal(last, 1);
  assert.equal(stages[stages.length - 1][1], 'Pronto');
  // Quem escuta o andamento não derruba o cálculo.
  const solution = await solve(SMALL.survey, {
    onProgress: () => {
      throw new Error('ouvinte quebrado');
    },
  });
  assertContract(solution, SMALL.survey, 'ouvinte quebrado');
  assert.equal(solution.debug.members.length, 4);
});

// ---------------------------------------------------------------------------
// Precisão (guardas) e significado da confiança
// ---------------------------------------------------------------------------

test('solve: precisão nos cenários fixos bem melhor do que juntar tudo no centro', async () => {
  for (const [name, maxScore, maxMedian] of GUARDS) {
    const { scenario, solution } = await guard(name);
    const m = evaluate(solution, scenario.truth, scenario.survey);
    assert.ok(m.ok && m.floorOk, `${name}: solução válida`);
    assert.ok(m.score < maxScore, `${name}: nota ${m.score.toFixed(1)} (limite ${maxScore}; colapso = 100)`);
    assert.ok(m.medianRigid < maxMedian, `${name}: erro mediano ${m.medianRigid.toFixed(2)} m (limite ${maxMedian})`);
    assert.ok(m.scaleRatio > 0.55 && m.scaleRatio < 1.6, `${name}: tamanho ${m.scaleRatio.toFixed(2)}x o real`);
    assert.ok(m.trust > 0.75, `${name}: vizinhança preservada (${m.trust.toFixed(2)})`);
  }
});

test('solve: a confiança quer dizer alguma coisa (pontos menos confiáveis erram mais)', async () => {
  let low = 0;
  let high = 0;
  for (const [name] of GUARDS) {
    const { scenario, solution } = await guard(name);
    const fit = procrustes(solution.points, scenario.truth.points, { scale: false });
    const rows = fit.aligned.map((p, i) => ({ err: dist(p, scenario.truth.points[i]), conf: solution.points[i].conf })).sort((a, b) => a.conf - b.conf);
    const third = Math.floor(rows.length / 3);
    low += rows.slice(0, third).reduce((s, r) => s + r.err, 0) / third;
    high += rows.slice(-third).reduce((s, r) => s + r.err, 0) / third;
    assert.ok(rows[rows.length - 1].conf - rows[0].conf > 0.05, `${name}: a confiança varia entre os pontos`);
  }
  assert.ok(low > 1.1 * high, `terço menos confiável erra ${(low / 4).toFixed(2)} m; o mais confiável, ${(high / 4).toFixed(2)} m`);
});

test('solve: repetível (duas execuções idênticas; a semente não muda nada)', async () => {
  const a = await solve(clone(SPOTS.survey), { seed: 1 });
  const b = await solve(clone(SPOTS.survey), { seed: 99 });
  assert.deepEqual(a.points, b.points);
  assert.deepEqual(a.aps, b.aps);
  assert.equal(a.scaleConf, b.scaleConf);
  assertContract(a, SPOTS.survey, 'pontos marcados');
  const qa = solveQuick(clone(SPOTS.survey));
  const qb = solveQuick(clone(SPOTS.survey), { seed: 7 });
  assert.deepEqual(qa.points, qb.points);
  assert.deepEqual(qa.aps, qb.aps);
});

// ---------------------------------------------------------------------------
// Entradas degeneradas
// ---------------------------------------------------------------------------

test('entradas degeneradas: nunca lança erro e sempre devolve uma solução válida', async () => {
  const base = SMALL.survey;
  const reading = (id, rssi, ageMs = 500) => ({ id, rssi, freq: 2437, ageMs });
  const scan = (t, readings, extra = {}) => ({ t, floor: 0, still: false, spot: null, readings, ...extra });
  const cases = {
    'null': null,
    'undefined': undefined,
    'número': 42,
    'objeto vazio': {},
    'scans não é lista': { scans: 'nada', aps: {} },
    'zero varreduras': { version: 1, scans: [], aps: {} },
    'uma varredura': { ...base, scans: base.scans.slice(0, 1) },
    'duas varreduras': { ...base, scans: base.scans.slice(0, 2) },
    'cinco varreduras': { ...base, scans: base.scans.slice(0, 5) },
    'varreduras sem leituras': { version: 1, aps: {}, scans: Array.from({ length: 12 }, (_, i) => scan(3.5 * i, [])) },
    'todas as leituras repetidas': { ...base, scans: base.scans.slice(0, 20).map((s) => ({ ...s, readings: s.readings.map((r) => ({ ...r, ageMs: 60000 })) })) },
    'um roteador só': { version: 1, aps: { 'aa:01': { ssid: 'x', freq: 2437 } }, scans: Array.from({ length: 30 }, (_, i) => scan(3.5 * i, [reading('aa:01', -40 - (i % 9) * 3)])) },
    'leituras idênticas': { version: 1, aps: {}, scans: Array.from({ length: 25 }, (_, i) => scan(3.5 * i, [reading('aa:01', -50), reading('aa:02', -60), reading('aa:03', -70)])) },
    'tudo num ponto só': { ...base, scans: base.scans.slice(0, 15).map((s) => ({ ...s, still: true, spot: 1 })) },
    'dois pontos marcados': { ...base, scans: base.scans.slice(0, 16).map((s, i) => ({ ...s, still: true, spot: i < 8 ? 1 : 2 })) },
    'sem os dados dos roteadores': { version: 1, scans: base.scans.slice(0, 30) },
    'tempos inválidos e fora de ordem': { ...base, scans: base.scans.slice(0, 30).map((s, i) => ({ ...s, t: i % 3 === 0 ? NaN : i % 3 === 1 ? 100 - i : 'ontem' })) },
    'tempos todos iguais': { ...base, scans: base.scans.slice(0, 30).map((s) => ({ ...s, t: 7 })) },
    'andares estranhos': { ...base, scans: base.scans.slice(0, 30).map((s, i) => ({ ...s, floor: [0, -1, 2, NaN, 'x', 1.4, null][i % 7] })) },
    'andar absurdo': { ...base, scans: base.scans.slice(0, 20).map((s, i) => ({ ...s, floor: i === 3 ? 1e300 : 0 })) },
    'leituras com lixo': {
      ...base,
      scans: base.scans.slice(0, 30).map((s, i) => (i % 4 === 0 ? null : i % 4 === 1 ? { ...s, readings: [null, 7, { id: null, rssi: -50 }, { id: 'zz', rssi: NaN }, { id: 'yy', rssi: 1e9 }, { rssi: -40 }, ...s.readings] } : i % 4 === 2 ? { t: s.t } : s)),
    },
    'distâncias conhecidas com lixo': { ...base, scans: base.scans.slice(0, 30), knownDistances: [null, 3, { a: 0 }, { a: 0, b: 0, meters: 2 }, { a: -1, b: 4, meters: 2 }, { a: 1, b: 999, meters: 2 }, { a: 1, b: 9, meters: -3 }, { a: 1.5, b: 9, meters: 3 }, { a: 2, b: 9, meters: Infinity }] },
    'sinal conectado com lixo': { ...base, scans: base.scans.slice(0, 30), track: [null, { t: 'x' }, { t: 3, id: 'aa', rssi: NaN }, ...(base.track || []).slice(0, 20)] },
  };
  for (const [label, survey] of Object.entries(cases)) {
    const expected = survey && Array.isArray(survey.scans) ? survey : { scans: [] };
    assertContract(await solve(survey, { budgetMs: 4000 }), expected, `solve / ${label}`);
    assertContract(solveQuick(survey), expected, `solveQuick / ${label}`);
  }
  // Opções estranhas também não derrubam.
  for (const options of [null, 7, 'x', { budgetMs: -5 }, { budgetMs: NaN, signal: 3, previous: 'não', onProgress: 'não' }, { previous: { points: [null, { x: 1 }] } }]) {
    assertContract(await solve(base, options), base, `solve / opções ${JSON.stringify(options)}`);
    assertContract(solveQuick(base, options), base, `solveQuick / opções ${JSON.stringify(options)}`);
  }
});

test('varreduras só com leituras repetidas entram por interpolação no tempo', async () => {
  const survey = clone(SMALL.survey);
  const k = 10;
  survey.scans[k].readings = survey.scans[k].readings.map((r) => ({ ...r, ageMs: 45000 }));
  const solution = await solve(survey);
  assertContract(solution, survey, 'varredura vazia');
  const [p, mid, q] = [solution.points[k - 1], solution.points[k], solution.points[k + 1]];
  const u = (survey.scans[k].t - survey.scans[k - 1].t) / (survey.scans[k + 1].t - survey.scans[k - 1].t);
  assert.ok(Math.hypot(mid.x - (p.x + u * (q.x - p.x)), mid.y - (p.y + u * (q.y - p.y))) < 1e-6, 'fica entre as vizinhas, na proporção do tempo');
  assert.ok(mid.conf < Math.min(p.conf, q.conf), 'com confiança menor que a das vizinhas');
});

test('levantamento enorme (1500 varreduras) é resolvido em blocos, dentro do tempo', async () => {
  const base = SMALL.survey;
  const span = base.scans[base.scans.length - 1].t + 3.5;
  const scans = [];
  for (let rep = 0; scans.length < 1500; rep++) for (const s of base.scans) if (scans.length < 1500) scans.push({ ...s, t: s.t + rep * span });
  const survey = { ...base, scans, track: [] };
  const t0 = performance.now();
  const solution = await solve(survey, { budgetMs: 8000 });
  const ms = performance.now() - t0;
  assertContract(solution, survey, '1500 varreduras');
  assert.ok(solution.debug.members.length >= 1);
  assert.ok(radius(solution.points) > 0.5, 'o mapa tem tamanho');
  assert.ok(ms < 10000, `terminou em ${Math.round(ms)} ms (tempo pedido: 8000)`);
  const quick = solveQuick(survey);
  assertContract(quick, survey, '1500 varreduras (prévia)');
});

// ---------------------------------------------------------------------------
// Distância medida pelo usuário
// ---------------------------------------------------------------------------

// A regra mudou (a conta e as medidas da bancada estão em app/js/mapping/solver-scale.js). Antes o
// mapa esticava ou encolhia na direção de medida / distância do par no mapa. Medido em 140
// levantamentos, essa régua não reduzia o erro de tamanho (0,168 -> 0,165 com o par que a tela
// propunha): a distância entre dois pontos do mapa erra ±30% e é enviesada pela escolha do par.
// Agora a medida é um TETO para o mapa inteiro — ela tem de caber nele de ponta a ponta — e por
// isso só faz o mapa crescer; uma medida que cabe (ou menor que a do mapa) acerta só o par.
test('knownDistances: a medida que não cabe no mapa faz o mapa crescer; a que cabe só acerta o par', async () => {
  const survey = SPOTS.survey;
  const base = await solve(survey);
  assert.equal(base.debug.scaleAdjust, undefined, 'sem medida, nada sobre ajuste de escala');
  // Os dois pontos marcados mais afastados do mapa.
  let a = 0;
  let b = 1;
  for (let i = 0; i < survey.scans.length; i++) {
    for (let j = i + 1; j < survey.scans.length; j++) if (dist(base.points[i], base.points[j]) > dist(base.points[a], base.points[b])) [a, b] = [i, j];
  }
  const d0 = dist(base.points[a], base.points[b]);
  assert.ok(d0 > 3, 'há uma base de alguns metros no mapa');
  // Quanto cabe no mapa de ponta a ponta: é com isto que a medida é comparada.
  const { span } = mapSpan(
    base.points.map((p) => p.x),
    base.points.map((p) => p.y),
  );
  assert.ok(span >= d0 && span < 1.6 * d0, `o comprimento do mapa (${span.toFixed(1)} m) é da ordem da maior distância entre dois pontos (${d0.toFixed(1)} m)`);
  const withKnown = (meters) => solve({ ...survey, knownDistances: [{ a, b, meters }] });
  const others = survey.scans.map((s, i) => i).filter((i) => survey.scans[i].spot !== survey.scans[a].spot && survey.scans[i].spot !== survey.scans[b].spot);
  const pick = (solution) => others.map((i) => solution.points[i]);

  // Medida maior que o mapa inteiro: o mapa cresce até ela caber, pelo fator que fuseScale() dá.
  const meters = 1.25 * span;
  const expected = fuseScale(span, [meters]);
  assert.ok(expected.factor > 1.25 && expected.factor < 1.45, `fator esperado: ${expected.factor}`);
  const bigger = await withKnown(meters);
  assertContract(bigger, survey, 'medida maior');
  assert.ok(Math.abs(dist(bigger.points[a], bigger.points[b]) - meters) < 1e-6, 'o par medido sai com a distância pedida');
  const grow = radius(pick(bigger)) / radius(pick(base));
  assert.ok(Math.abs(grow / expected.factor - 1) < 1e-6, `o resto do mapa cresce pelo fator da fusão (${grow.toFixed(4)}x, esperado ${expected.factor.toFixed(4)}x)`);
  assert.deepEqual(
    { ...bigger.debug.scaleAdjust, spanM: null },
    { applied: true, factor: Math.round(expected.factor * 1000) / 1000, weight: Math.round(expected.weight * 100) / 100, used: 1, ignored: 0, spanM: null, longestM: Math.round(meters * 100) / 100 },
    'o resumo do ajuste diz quanto o mapa cresceu e o quanto a medida mandou',
  );
  assert.ok(Math.abs(bigger.debug.scaleAdjust.spanM - span) < 0.01);
  assert.ok(bigger.scaleConf >= 0.6 && bigger.scaleConf > base.scaleConf, `a confiança na escala sobe (${base.scaleConf} -> ${bigger.scaleConf})`);

  // Medida que cabe no mapa: o tamanho não muda (o resto do mapa fica onde estava), só o par é acertado.
  for (const fits of [0.7 * span, 0.5 * d0]) {
    const same = await withKnown(fits);
    assert.ok(Math.abs(dist(same.points[a], same.points[b]) - fits) < 1e-6, 'o par sai com a distância pedida');
    assert.ok(Math.abs(radius(pick(same)) / radius(pick(base)) - 1) < 1e-9, 'medida que cabe (ou menor que a do mapa) não muda o tamanho: o ajuste nunca encolhe o mapa');
    assert.equal(same.debug.scaleAdjust.applied, false);
    assert.equal(same.debug.scaleAdjust.factor, 1);
    assert.equal(same.debug.scaleAdjust.used, 1);
    assert.ok(same.scaleConf >= base.scaleConf, 'a confiança na escala não cai');
    assertContract(same, survey, 'medida que cabe');
  }

  // Medida que pede um mapa mais de 2 vezes maior contradiz o mapa (erro de digitação, lugares
  // trocados): é ignorada por inteiro. (Antes o par saía exato — dois pontos jogados para fora da
  // casa — e só o resto do mapa era poupado.)
  const absurd = await withKnown(2.2 * span);
  assert.deepEqual(absurd.points, base.points, 'medida que contradiz o mapa não mexe em nada');
  assert.equal(absurd.scaleConf, base.scaleConf);
  assert.deepEqual({ ...absurd.debug.scaleAdjust, spanM: null }, { applied: false, factor: 1, weight: 0, used: 0, ignored: 1, spanM: null, longestM: 0 });

  // Várias medidas: manda a mais comprida; a absurda fica de fora sem estragar as outras.
  const c = others[0];
  const e = others.find((i) => survey.scans[i].spot !== survey.scans[c].spot);
  const many = await solve({ ...survey, knownDistances: [{ a, b, meters }, { a: c, b: e, meters: 0.3 * span }, { a: c, b, meters: 2.5 * span }, { a: c, b, meters: 1e6 }] });
  assert.equal(many.debug.scaleAdjust.factor, bigger.debug.scaleAdjust.factor);
  assert.equal(many.debug.scaleAdjust.used, 2);
  assert.equal(many.debug.scaleAdjust.ignored, 2, 'a que contradiz o mapa e a absurda');
  assert.ok(Math.abs(dist(many.points[a], many.points[b]) - meters) < 0.05 && Math.abs(dist(many.points[c], many.points[e]) - 0.3 * span) < 0.05, 'os pares aceitos saem com as distâncias pedidas');
  assertContract(many, survey, 'várias medidas');

  // Entradas inválidas são ignoradas.
  const ignored = await solve({ ...survey, knownDistances: [{ a, b: a, meters: 5 }, { a: -1, b, meters: 5 }, { a, b: 1e6, meters: 5 }, { a, b, meters: 0 }] });
  assert.deepEqual(ignored.points, base.points);
  assert.deepEqual({ ...ignored.debug.scaleAdjust, spanM: null }, { applied: false, factor: 1, weight: 0, used: 0, ignored: 4, spanM: null, longestM: 0 }, 'e o resumo diz que nenhuma valeu');

  // A prévia honra a medida do mesmo jeito.
  const quickBase = solveQuick(survey);
  const quickSpan = mapSpan(
    quickBase.points.map((p) => p.x),
    quickBase.points.map((p) => p.y),
  ).span;
  const quick = solveQuick({ ...survey, knownDistances: [{ a, b, meters: 1.25 * quickSpan }] });
  assert.ok(Math.abs(dist(quick.points[a], quick.points[b]) - 1.25 * quickSpan) < 1e-6);
  assert.ok(Math.abs(radius(pick(quick)) / radius(pick(quickBase)) / fuseScale(quickSpan, [1.25 * quickSpan]).factor - 1) < 1e-6, 'a prévia cresce pelo mesmo fator');
  assert.equal(quick.debug.scaleAdjust.applied, true);
});

// ---------------------------------------------------------------------------
// Tempo e cancelamento
// ---------------------------------------------------------------------------

test('budgetMs: com pouquíssimo tempo roda só o motor mais barato e ainda devolve um mapa', async () => {
  const { scenario } = await guard(GUARDS[0][0]);
  const t0 = performance.now();
  const solution = await solve(scenario.survey, { budgetMs: 1 });
  const ms = performance.now() - t0;
  assertContract(solution, scenario.survey, 'tempo mínimo');
  assert.deepEqual(solution.debug.members.map((m) => m.name), ['isomap']);
  assert.deepEqual(solution.debug.skipped, ['chain', 'fields', 'range']);
  assert.ok(ms < 2500, `voltou em ${Math.round(ms)} ms`);
  const m = evaluate(solution, scenario.truth, scenario.survey);
  assert.ok(m.score < 80, `ainda é um mapa (nota ${m.score.toFixed(1)})`);
});

test('signal: cancelar entre as etapas devolve logo o que houver', async () => {
  const survey = SMALL.survey;
  // Cancelado antes de começar: nenhum motor roda.
  const before = await solve(survey, { signal: { cancelled: true } });
  assertContract(before, survey, 'cancelado antes');
  assert.equal(before.debug.cancelled, true);
  assert.equal(before.debug.members.length, 0);
  assert.ok(before.points.every((p) => p.conf === 0), 'sem solução: confiança zero');

  // Cancelado quando o segundo motor ia começar: fica a solução do primeiro.
  const signal = { cancelled: false };
  let stages = 0;
  const during = await solve(survey, {
    signal,
    onProgress: (fraction) => {
      if (fraction > 0.02 && ++stages === 2) signal.cancelled = true;
    },
  });
  assertContract(during, survey, 'cancelado no meio');
  assert.equal(during.debug.cancelled, true);
  assert.deepEqual(during.debug.members.map((m) => m.name), ['isomap']);
  assert.ok(radius(during.points) > 0.3, 'o que já estava pronto é devolvido');

  // Sem cancelar, o mesmo objeto de sinal não atrapalha.
  const normal = await solve(survey, { signal: { cancelled: false } });
  assert.equal(normal.debug.cancelled, false);
  assert.equal(normal.debug.members.length, 4);
});

// ---------------------------------------------------------------------------
// Prévia ao vivo
// ---------------------------------------------------------------------------

test('solveQuick: rápida para 150 varreduras e com precisão de mapa', async () => {
  const { survey, truth } = makeSurvey('apartamento', { kind: 'tour', minLengthM: 330 });
  assert.ok(survey.scans.length >= 150, `caminhada longa o bastante (${survey.scans.length} varreduras)`);
  const part = { ...survey, scans: survey.scans.slice(0, 150) };
  solveQuick(part); // aquece o código, como no app (a prévia é chamada a cada varredura nova)
  const times = [];
  let solution = null;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    solution = solveQuick(part);
    times.push(performance.now() - t0);
  }
  assertContract(solution, part, 'prévia');
  assert.ok(Math.min(...times) < 400, `prévia de 150 varreduras em ${times.map((t) => Math.round(t)).join(', ')} ms (alvo: bem abaixo de 400)`);
  assert.ok(!(solution instanceof Promise), 'síncrona');
  assert.deepEqual(solution.debug.members.map((m) => m.name), ['isomap']);
  // Precisão: o erro mediano depois do alinhamento rígido fica longe do de um mapa colapsado.
  const real = truth.points.slice(0, 150);
  const fit = procrustes(solution.points, real, { scale: false });
  const err = median(fit.aligned.map((p, i) => dist(p, real[i])));
  assert.ok(err < 2.4, `erro mediano da prévia: ${err.toFixed(2)} m`);
});

test('solveQuick: estável enquanto o levantamento cresce (com options.previous)', () => {
  const { survey } = makeSurvey('apartamento', { kind: 'tour', minLengthM: 250 });
  const total = Math.min(survey.scans.length, 120);
  const upTo = (n) => ({ ...survey, scans: survey.scans.slice(0, n), track: (survey.track || []).filter((s) => s.t <= survey.scans[n - 1].t) });
  let previous = solveQuick(upTo(30));
  const moves = [];
  for (let n = 35; n <= total; n += 5) {
    const next = solveQuick(upTo(n), { previous });
    assertContract(next, upTo(n), `prévia com ${n}`);
    // Quanto os pontos que já existiam se mexeram de uma prévia para a outra.
    moves.push(median(previous.points.map((p, i) => dist(p, next.points[i]))));
    previous = next;
  }
  assert.ok(Math.max(...moves) < 2.5, `nenhum salto: o pior deslocamento mediano foi ${Math.max(...moves).toFixed(2)} m`);
  assert.ok(median(moves) < 1.0, `deslocamento mediano típico: ${median(moves).toFixed(2)} m`);

  // Sem `previous` a prévia sai no referencial próprio; com uma prévia girada e espelhada em
  // options.previous, a nova volta exatamente para o referencial dela.
  const fresh = solveQuick(upTo(total));
  const turned = { ...fresh, points: fresh.points.map((p) => ({ ...p, x: 3 + 0.6 * p.x + 0.8 * p.y, y: -2 + 0.8 * p.x - 0.6 * p.y })) };
  const again = solveQuick(upTo(total), { previous: turned });
  const worst = Math.max(...again.points.map((p, i) => dist(p, turned.points[i])));
  assert.ok(worst < 1e-6, `mesma prévia, mesmo referencial (diferença ${worst.toExponential(1)} m)`);
  // Os roteadores acompanham o mesmo movimento dos pontos.
  const id = Object.keys(fresh.aps)[0];
  const moved = { x: 3 + 0.6 * fresh.aps[id].x + 0.8 * fresh.aps[id].y, y: -2 + 0.8 * fresh.aps[id].x - 0.6 * fresh.aps[id].y };
  assert.ok(dist(moved, again.aps[id]) < 1e-6);
});

test('solve: com options.previous a solução final sai no referencial da última prévia', async () => {
  const survey = SMALL.survey;
  const preview = solveQuick(survey);
  const turned = { ...preview, points: preview.points.map((p) => ({ ...p, x: 10 - p.y, y: 5 - p.x })) }; // girada, espelhada e deslocada
  const plain = await solve(survey);
  const aligned = await solve(survey, { previous: turned });
  assertContract(aligned, survey, 'com prévia');
  const gap = (solution) => Math.sqrt(solution.points.reduce((s, p, i) => s + dist(p, turned.points[i]) ** 2, 0) / solution.points.length);
  assert.ok(gap(aligned) < 0.5 * gap(plain), `encaixada na prévia: ${gap(aligned).toFixed(2)} m de diferença (sem encaixe: ${gap(plain).toFixed(2)} m)`);
  // É o mesmo mapa, só movido: as distâncias entre os pontos não mudam.
  assert.ok(Math.abs(radius(aligned.points) - radius(plain.points)) < 1e-6);
  assert.ok(Math.abs(dist(aligned.points[0], aligned.points[20]) - dist(plain.points[0], plain.points[20])) < 1e-6);
});

// ---------------------------------------------------------------------------
// O que vai no app
// ---------------------------------------------------------------------------

test('arquivos do solucionador: sem sorteio, sem relógio de parede, sem nada de fora de mapping/', () => {
  const files = fs.readdirSync(MAPPING).filter((f) => /^solver(-[a-z]+)?\.js$/.test(f));
  // solver-scale.js: a conta do "Ajustar a escala", num módulo à parte porque a tela de resultado também a usa
  assert.deepEqual(files.sort(), ['solver-chain.js', 'solver-common.js', 'solver-fields.js', 'solver-isomap.js', 'solver-range.js', 'solver-scale.js', 'solver.js']);
  for (const file of files) {
    const source = fs.readFileSync(path.join(MAPPING, file), 'utf8');
    // Sem os comentários, que podem citar os nomes proibidos.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    assert.ok(!/\bMath\.random\b/.test(code), `${file}: usa Math.random`);
    assert.ok(!/\bDate\.now\b|\bnew Date\b/.test(code), `${file}: usa o relógio de parede`);
    assert.ok(!/\brequire\s*\(|\bimport\s*\(|\bprocess\s*\.|['"]node:|\bworkerData\b/.test(code), `${file}: usa APIs do Node ou import dinâmico`);
    assert.ok(!/\b(document|window|localStorage)\s*\./.test(code), `${file}: usa a página (roda num Worker)`);
    const imports = [...code.matchAll(/\b(?:import|export)\s+(?:[\w*{}\s,$]+\s+from\s*)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) assert.match(spec, /^\.\/(types|solver-[a-z]+)\.js$/, `${file}: importa ${spec}`);
    // (solver-scale.js não importa nada de propósito: a página o carrega sem trazer os motores junto)
    if (file === 'solver-scale.js') assert.equal(imports.length, 0, `${file}: não depende de mais nada`);
    else if (file !== 'solver-common.js') assert.ok(imports.length >= 1, `${file}: importa as peças comuns`);
  }
  // O torneio acabou: os candidatos não vão dentro do app.
  assert.ok(!fs.existsSync(path.join(MAPPING, 'candidates')), 'app/js/mapping/candidates foi removida');
});
