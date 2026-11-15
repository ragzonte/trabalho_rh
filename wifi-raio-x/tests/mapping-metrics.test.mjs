// Testes da bancada do mapa 3D: alinhamento, métricas, nota e execução isolada.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FLOOR_HEIGHT } from '../app/js/mapping/types.js';
import { createRng } from '../app/js/sim/prng.js';
import { solveCollapse, solveMds, solveOracle, solveOracleField, solveOracleTrack } from './mapping/baseline.mjs';
import { buildScenario, listScenarios, renderSvg, runBench, runScenario } from './mapping/harness.mjs';
import { FAIL_SCORE, aggregate, evaluate, failure, procrustes, quantile, trustContinuity } from './mapping/metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, 'mapping', 'baseline.mjs');
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || 'valor'}: ${a} (esperado ${b} ± ${tol})`);

// Nuvem de pontos sem simetria, para a rotação e o espelho terem resposta única.
function cloud(n, seed) {
  const rng = createRng('nuvem', seed);
  return Array.from({ length: n }, () => ({ x: rng.float(-4, 6), y: rng.float(-1, 3) + rng.gaussian(0, 0.3) }));
}

// Aplica rotação, espelho (y -> -y), escala e translação.
function transform(points, { angle = 0, mirror = false, scale = 1, tx = 0, ty = 0 }) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return points.map((p) => {
    const y = mirror ? -p.y : p.y;
    return { ...p, x: scale * (c * p.x - s * y) + tx, y: scale * (s * p.x + c * y) + ty };
  });
}

// Cenário pequeno, montado uma vez: a verdade serve de "solução perfeita".
const scenario = buildScenario(listScenarios('dev').find((s) => s.name === 'apartamento-tour-3.5s-s1'));
const twoFloors = buildScenario(listScenarios('dev').find((s) => s.name === 'sobrado-pontos-30s-s1'));

function truthAsSolution(sc, change = {}) {
  const startZ = sc.truth.startFloor * FLOOR_HEIGHT;
  const pts = transform(sc.truth.points, change);
  const aps = Object.entries(sc.truth.aps).map(([id, a]) => [id, a]);
  const moved = transform(
    aps.map(([, a]) => a),
    change,
  );
  return {
    points: pts.map((p, i) => ({ x: p.x, y: p.y, z: sc.survey.scans[i].floor * FLOOR_HEIGHT, conf: 1 })),
    aps: Object.fromEntries(aps.map(([id, a], i) => [id, { x: moved[i].x, y: moved[i].y, z: a.z - startZ, p0: -40, n: 2, conf: 1 }])),
    scaleConf: 1,
  };
}

// ---------------------------------------------------------------------------

test('procrustes: recupera rotações, espelhos e translações conhecidas', () => {
  const truth = cloud(60, 1);
  for (const angle of [0, 0.4, 1.9, -2.7, Math.PI]) {
    for (const mirror of [false, true]) {
      const est = transform(truth, { angle, mirror, tx: 12, ty: -7 });
      const fit = procrustes(est, truth, { scale: false });
      close(fit.rmse, 0, 1e-9, `rmse (ângulo ${angle}, espelho ${mirror})`);
      assert.equal(fit.reflected, mirror);
      assert.equal(fit.scale, 1);
      fit.aligned.forEach((p, i) => {
        close(p.x, truth[i].x, 1e-9);
        close(p.y, truth[i].y, 1e-9);
      });
      // A matriz devolvida é ortogonal (rotação pura, com ou sem espelho).
      const [[a, b], [c, d]] = fit.rotation;
      close(a * a + c * c, 1, 1e-12);
      close(a * b + c * d, 0, 1e-12);
      close(a * d - b * c, mirror ? -1 : 1, 1e-12, 'determinante');
      // apply() leva qualquer outro ponto do referencial estimado para o real.
      const probe = transform([{ x: 3, y: -2 }], { angle, mirror, tx: 12, ty: -7 })[0];
      const back = fit.apply(probe);
      close(back.x, 3, 1e-9);
      close(back.y, -2, 1e-9);
    }
  }
});

test('procrustes: com escala recupera o fator; sem escala não mexe no tamanho', () => {
  const truth = cloud(80, 2);
  for (const scale of [0.25, 0.8, 2, 5]) {
    const est = transform(truth, { angle: 1.1, mirror: true, scale, tx: -3, ty: 4 });
    const sim = procrustes(est, truth, { scale: true });
    close(sim.scale, 1 / scale, 1e-9, 'escala');
    close(sim.rmse, 0, 1e-9, 'rmse com escala');
    const rigid = procrustes(est, truth, { scale: false });
    assert.equal(rigid.scale, 1);
    assert.ok(rigid.rmse > 0.3, `sem escala sobra erro: ${rigid.rmse}`);
  }
});

test('procrustes: com ruído o erro fica do tamanho do ruído', () => {
  const rng = createRng('ruído', 5);
  const truth = cloud(200, 3);
  const noisy = transform(truth, { angle: -0.8, mirror: true, scale: 1.7, tx: 1, ty: 1 }).map((p) => ({
    x: p.x + rng.gaussian(0, 0.1 * 1.7),
    y: p.y + rng.gaussian(0, 0.1 * 1.7),
  }));
  const fit = procrustes(noisy, truth, { scale: true });
  close(fit.scale, 1 / 1.7, 0.01, 'escala');
  assert.ok(fit.reflected);
  assert.ok(fit.rmse > 0.1 && fit.rmse < 0.18, `rmse = ${fit.rmse}`);
  // É mesmo o mínimo: mexer no ângulo só piora.
  const worse = (delta) => {
    const c = Math.cos(delta);
    const s = Math.sin(delta);
    return Math.sqrt(
      fit.aligned.reduce((sum, p, i) => {
        const dx = c * p.x - s * p.y - truth[i].x;
        const dy = s * p.x + c * p.y - truth[i].y;
        return sum + dx * dx + dy * dy;
      }, 0) / truth.length,
    );
  };
  assert.ok(worse(0.05) > fit.rmse && worse(-0.05) > fit.rmse);
});

test('procrustes: espelho desligado e entradas degeneradas', () => {
  const truth = cloud(40, 4);
  const mirrored = transform(truth, { angle: 0.3, mirror: true });
  assert.ok(procrustes(mirrored, truth, { reflection: false }).rmse > 0.5);
  close(procrustes(mirrored, truth).rmse, 0, 1e-9);
  // Tudo num ponto só: vai para o centro da verdade; com escala, a escala é zero.
  const collapsed = truth.map(() => ({ x: 9, y: 9 }));
  const cx = truth.reduce((s, p) => s + p.x, 0) / truth.length;
  const cy = truth.reduce((s, p) => s + p.y, 0) / truth.length;
  for (const scale of [false, true]) {
    const fit = procrustes(collapsed, truth, { scale });
    close(fit.aligned[7].x, cx, 1e-9);
    close(fit.aligned[7].y, cy, 1e-9);
    assert.ok(Number.isFinite(fit.rmse));
    if (scale) assert.equal(fit.scale, 0);
  }
  // Aceita pares [x, y] também.
  close(
    procrustes(
      truth.map((p) => [p.x + 1, p.y]),
      truth.map((p) => [p.x, p.y]),
    ).rmse,
    0,
    1e-9,
  );
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(quantile([], 0.5), null);
});

test('confiabilidade e continuidade: 1 quando a vizinhança se mantém, baixas quando embaralha', () => {
  const truth = cloud(120, 6);
  const same = trustContinuity(transform(truth, { angle: 2, mirror: true, scale: 3 }), truth);
  close(same.trust, 1, 1e-12);
  close(same.continuity, 1, 1e-12);
  const shuffled = createRng('embaralha', 1).shuffle(truth);
  const bad = trustContinuity(shuffled, truth);
  assert.ok(bad.trust < 0.7 && bad.continuity < 0.7, JSON.stringify(bad));
  // Juntar tudo num ponto não pode sair de graça.
  const collapsed = trustContinuity(
    truth.map(() => ({ x: 0, y: 0 })),
    truth,
  );
  assert.ok(collapsed.trust < 0.8 && collapsed.continuity < 0.8, JSON.stringify(collapsed));
  assert.deepEqual(trustContinuity(truth.slice(0, 5), truth.slice(0, 5)), { trust: null, continuity: null });
});

test('evaluate: a própria verdade tem erro zero e nota zero', () => {
  for (const sc of [scenario, twoFloors]) {
    const m = evaluate(truthAsSolution(sc), sc.truth, sc.survey, { runtimeMs: 12 });
    assert.ok(m.ok && m.finite && m.floorOk);
    for (const key of ['rmseRigid', 'medianRigid', 'p90Rigid', 'rmseSim', 'medianSim', 'apErrOwn', 'apErrNear', 'score']) {
      close(m[key], 0, 1e-6, key);
    }
    close(m.scaleRatio, 1, 1e-9, 'escala');
    close(m.trust, 1, 1e-9, 'confiabilidade');
    close(m.continuity, 1, 1e-9, 'continuidade');
    assert.equal(m.roomPurity, 1);
    assert.equal(m.apFloorOwn, 1);
    assert.equal(m.runtimeMs, 12);
  }
});

test('evaluate: verdade girada e espelhada continua perfeita', () => {
  for (const sc of [scenario, twoFloors]) {
    const m = evaluate(truthAsSolution(sc, { angle: 2.2, mirror: true, tx: 40, ty: -15 }), sc.truth, sc.survey);
    for (const key of ['rmseRigid', 'medianRigid', 'p90Rigid', 'rmseSim', 'apErrOwn', 'apErrNear', 'score']) close(m[key], 0, 1e-6, key);
    close(m.scaleRatio, 1, 1e-9);
    assert.equal(m.roomPurity, 1);
    assert.ok(m.floorOk);
  }
});

test('evaluate: escala dobrada pune o erro rígido, não o de forma', () => {
  const m = evaluate(truthAsSolution(scenario, { angle: 0.7, scale: 2 }), scenario.truth, scenario.survey);
  close(m.scaleRatio, 2, 1e-9, 'escala');
  close(m.rmseSim, 0, 1e-6, 'rmseSim');
  close(m.medianSim, 0, 1e-6, 'medianSim');
  assert.ok(m.rmseRigid > 1.5, `rmseRigid = ${m.rmseRigid}`);
  assert.ok(m.medianRigid > 1 && m.p90Rigid > m.medianRigid);
  close(m.trust, 1, 1e-9);
  assert.ok(m.score > 60, `nota com escala errada: ${m.score}`);
  assert.ok(m.roomPurity < 0.9);
  // Metade do tamanho também é punida.
  const half = evaluate(truthAsSolution(scenario, { scale: 0.5 }), scenario.truth, scenario.survey);
  close(half.scaleRatio, 0.5, 1e-9);
  assert.ok(half.score > 30 && half.rmseSim < 1e-6);
});

test('evaluate: solução degenerada ou aleatória fica perto de 100 ou pior', () => {
  const { survey, truth } = scenario;
  const perfect = evaluate(truthAsSolution(scenario), truth, survey);
  const collapsed = evaluate(solveCollapse(survey), truth, survey);
  assert.ok(collapsed.ok && collapsed.finite);
  close(collapsed.score, 100, 1, 'nota de tudo num ponto');
  close(collapsed.scaleRatio, 0, 1e-12);
  assert.ok(collapsed.medianRigid > 1.5 && collapsed.rmseRigid > 2, 'erro em metros grande');
  assert.ok(collapsed.trust < 0.8 && collapsed.continuity < 0.8);
  assert.ok(collapsed.roomPurity < 0.5);
  assert.ok(collapsed.apErrNear > 3, 'todos os roteadores no centro: longe dos vizinhos de verdade');
  assert.ok(collapsed.score > perfect.score + 90);

  const rng = createRng('chute', 9);
  for (let k = 0; k < 5; k++) {
    const random = {
      points: survey.scans.map((s) => ({ x: rng.float(0, 9), y: rng.float(0, 7), z: s.floor * FLOOR_HEIGHT, conf: 0 })),
      aps: {},
      scaleConf: 0,
    };
    const m = evaluate(random, truth, survey);
    assert.ok(m.score > 95, `nota de um chute: ${m.score}`);
    assert.equal(m.apErrOwn, 50, 'roteador sem posição leva o erro máximo');
  }
  // Uma linha reta no tempo (só sabe a ordem das varreduras) também não engana.
  const line = { points: survey.scans.map((s) => ({ x: s.t * 0.02, y: 0, z: s.floor * FLOOR_HEIGHT, conf: 0 })), aps: {}, scaleConf: 0 };
  assert.ok(evaluate(line, truth, survey).score > 80);
});

test('evaluate: saída inválida vira falha com nota fixa', () => {
  const { survey, truth } = scenario;
  const good = truthAsSolution(scenario);
  const broken = [
    null,
    {},
    { points: 'nada' },
    { ...good, points: good.points.slice(1) },
    { ...good, points: good.points.map((p, i) => (i === 3 ? { ...p, x: NaN } : p)) },
    { ...good, points: good.points.map((p, i) => (i === 5 ? { ...p, y: Infinity } : p)) },
    { ...good, points: good.points.map((p, i) => (i === 8 ? null : p)) },
    { ...good, points: good.points.map(({ x, y }) => ({ x, y })) },
    { ...good, aps: { ...good.aps, [Object.keys(good.aps)[0]]: { x: 1, y: NaN, z: 0 } } },
  ];
  for (const solution of broken) {
    const m = evaluate(solution, truth, survey, { runtimeMs: 5 });
    assert.equal(m.ok, false);
    assert.equal(m.finite, false);
    assert.equal(m.score, FAIL_SCORE);
    assert.equal(m.medianRigid, null);
    assert.equal(m.runtimeMs, 5);
  }
  assert.equal(failure('motivo').error, 'motivo');
  // Andar errado não derruba a nota, mas fica marcado.
  const wrongFloor = { ...good, points: good.points.map((p, i) => (i === 0 ? { ...p, z: 2 * FLOOR_HEIGHT } : p)) };
  const m = evaluate(wrongFloor, truth, survey);
  assert.ok(m.ok && !m.floorOk);
});

test('evaluate: erro de roteador usa o alinhamento dos pontos; andar do roteador conferido', () => {
  const sc = twoFloors;
  const good = truthAsSolution(sc, { angle: 1, mirror: true });
  const ownIds = sc.world.aps.filter((a) => a.own && sc.survey.aps[a.bssid]).map((a) => a.bssid);
  assert.ok(ownIds.length >= 4);
  // Desloca só os roteadores da casa em 3 m (no referencial estimado): o erro aparece inteiro.
  const shifted = { ...good, aps: { ...good.aps } };
  for (const id of ownIds) shifted.aps[id] = { ...good.aps[id], x: good.aps[id].x + 3 };
  const m = evaluate(shifted, sc.truth, sc.survey);
  close(m.apErrOwn, 3, 1e-6, 'erro dos roteadores da casa');
  close(m.rmseRigid, 0, 1e-6);
  assert.equal(m.apFloorOwn, 1);
  // Todos os roteadores no térreo: metade dos da casa fica no andar errado.
  const flat = { ...good, aps: Object.fromEntries(Object.entries(good.aps).map(([id, a]) => [id, { ...a, z: 1 }])) };
  close(evaluate(flat, sc.truth, sc.survey).apFloorOwn, 0.5, 1e-9);
});

test('aggregate: nota = média das notas, falhas contam com a nota fixa', () => {
  const { survey, truth } = scenario;
  const list = [
    evaluate(truthAsSolution(scenario), truth, survey, { runtimeMs: 10 }),
    evaluate(solveCollapse(survey), truth, survey, { runtimeMs: 30 }),
    failure('quebrou'),
  ];
  const a = aggregate(list);
  assert.equal(a.count, 3);
  assert.equal(a.failures, 1);
  close(a.score, (list[0].score + list[1].score + FAIL_SCORE) / 3, 1e-9);
  // As médias das medidas ignoram a execução que falhou.
  close(a.mean.medianRigid, (list[0].medianRigid + list[1].medianRigid) / 2, 1e-9);
  close(a.median.runtimeMs, 20, 1e-9);
  assert.equal(aggregate([]).score, null);
  assert.equal(aggregate([failure('a'), failure('b')]).score, FAIL_SCORE);
  assert.equal(aggregate([failure('a')]).mean.medianRigid, null);
});

test('referências: MDS melhor que o chute, oráculos melhores que o MDS', () => {
  const { survey, truth } = scenario;
  const copy = structuredClone(survey);
  const mds = evaluate(solveMds(copy), truth, survey);
  assert.deepEqual(copy, survey, 'o solucionador não altera o levantamento');
  assert.ok(mds.ok && mds.score < 95, `MDS: ${mds.score}`);
  assert.deepEqual(solveMds(survey), solveMds(survey), 'o MDS é determinístico');
  assert.throws(() => solveOracle(survey, {}), /verdade/);
  const oracle = evaluate(solveOracle(survey, { truth }), truth, survey);
  const track = evaluate(solveOracleTrack(survey, { truth }), truth, survey);
  const field = evaluate(solveOracleField(survey, { truth }), truth, survey);
  assert.ok(oracle.ok && track.ok && field.ok);
  assert.ok(track.score < mds.score, `oráculo com trajetória ${track.score} x MDS ${mds.score}`);
  assert.ok(field.score < track.score && field.score < 40, `oráculo do mapa de rádio: ${field.score}`);
  assert.ok(field.medianRigid < 1 && field.roomPurity > 0.8);
  // Os oráculos devolvem os roteadores no lugar real (a menos do alinhamento).
  assert.ok(field.apErrOwn < 0.5 && oracle.apErrOwn < 2);
  // Dois andares: tudo continua finito e no andar certo.
  for (const solve of [solveMds, solveOracle, solveOracleTrack, solveOracleField]) {
    const m = evaluate(solve(twoFloors.survey, { truth: twoFloors.truth }), twoFloors.truth, twoFloors.survey);
    assert.ok(m.ok && m.floorOk, solve.name);
  }
});

test('cenários: conjuntos determinísticos, dev e holdout sem repetição', () => {
  const dev = listScenarios('dev');
  const holdout = listScenarios('holdout');
  const all = listScenarios('all');
  assert.equal(dev.length, 32);
  assert.equal(holdout.length, 28);
  assert.equal(all.length, 60);
  assert.equal(new Set(all.map((s) => s.name)).size, 60, 'nomes únicos');
  assert.deepEqual(listScenarios('dev'), dev);
  assert.equal(holdout.filter((s) => s.world.type === 'random').length, 12);
  // O holdout usa outras sementes e outra física.
  const devWorlds = new Set(dev.map((s) => `${s.world.id}#${s.world.seed}`));
  for (const s of holdout) {
    assert.ok(!devWorlds.has(`${s.world.id}#${s.world.seed}`));
    assert.ok(s.rf.n >= 1.8 && s.rf.n <= 2.55 && s.rf.wallScale >= 0.8 && s.rf.wallScale <= 1.2);
  }
  for (const s of dev) assert.deepEqual(s.rf, {});
  assert.ok(new Set(holdout.map((s) => s.rf.n)).size > 20, 'cada cenário do holdout tem a sua física');
  // Duração dos levantamentos: 4 a 14 min andando; 25 a 45 pontos com o limite de 30 s.
  const a = buildScenario(dev[0]);
  const b = buildScenario(dev[0]);
  assert.deepEqual(a.survey, b.survey);
  assert.deepEqual(a.truth.points, b.truth.points);
  for (const desc of [...dev.filter((s) => s.world.seed === 1), ...holdout.filter((_, i) => i % 3 === 0)]) {
    const sc = buildScenario(desc);
    if (desc.mode === 'pontos-30s') {
      const spots = new Set(sc.survey.scans.map((s) => s.spot).filter((s) => s !== null)).size;
      assert.ok(spots >= 25 && spots <= 45, `${desc.name}: ${spots} pontos`);
    } else {
      const minutes = sc.truth.durationS / 60;
      assert.ok(minutes >= 3.5 && minutes <= 14, `${desc.name}: ${minutes} min`);
      assert.ok(sc.survey.scans.length >= 60 && sc.survey.scans.length <= 245, `${desc.name}: ${sc.survey.scans.length} varreduras`);
    }
  }
});

test('bancada: thread isolada, sem verdade para o solucionador, com corte de tempo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrx-bancada-'));
  try {
    const write = (name, code) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, code);
      return file;
    };
    const desc = listScenarios('dev').find((s) => s.name === 'kitnet-pontos-30s-s1');

    // Solucionador curioso: procura a verdade em tudo que recebe.
    const spy = write(
      'spy.mjs',
      `export function solve(survey, options) {
         const text = JSON.stringify([survey, options]);
         if (options.truth || /"(x|y|z|world|truth|points)"\\s*:/.test(text)) throw new Error('VAZOU');
         if (typeof options.budgetMs !== 'number') throw new Error('sem budgetMs');
         survey.scans.length = 0; // estragar a cópia não pode afetar a bancada
         return { points: Array.from({ length: ${buildScenario(desc).survey.scans.length} }, () => ({ x: 0, y: 0, z: 0, conf: 0 })), aps: {}, scaleConf: 0 };
       }`,
    );
    const spied = await runScenario(desc, { solverPath: spy, budgetMs: 5000 });
    assert.equal(spied.error, null);
    assert.ok(spied.ok && spied.score > 90 && spied.score < 110, `nota do espião: ${spied.score}`);
    assert.equal(spied.scans, buildScenario(desc).survey.scans.length);

    // A referência roda pela mesma porta; só os oráculos recebem a verdade.
    const mds = await runScenario(desc, { solverPath: BASELINE, budgetMs: 5000, svgDir: path.join(dir, 'svg') });
    assert.ok(mds.ok && mds.runtimeMs >= 0 && mds.score < 100);
    const svg = fs.readFileSync(path.join(dir, 'svg', `${desc.name}.svg`), 'utf8');
    assert.ok(svg.startsWith('<svg') && svg.includes('Quarto') && svg.includes('</svg>'));
    const oracle = await runScenario(desc, { solverPath: BASELINE, exportName: 'solveOracleField', budgetMs: 5000 });
    assert.ok(oracle.ok && oracle.score < mds.score);
    const inline = await runScenario(desc, { solverPath: BASELINE, inline: true });
    close(inline.score, mds.score, 1e-9, 'modo --inline dá a mesma nota');

    // Erros e saídas ruins viram falha, sem derrubar a bancada.
    const thrower = write('thrower.mjs', `export function solve() { throw new Error('quebrei de propósito'); }`);
    const failed = await runScenario(desc, { solverPath: thrower, budgetMs: 5000 });
    assert.equal(failed.ok, false);
    assert.equal(failed.score, FAIL_SCORE);
    assert.match(failed.error, /quebrei de propósito/);
    const wrongExport = await runScenario(desc, { solverPath: thrower, exportName: 'naoExiste', budgetMs: 5000 });
    assert.match(wrongExport.error, /não exporta/);
    const nan = write('nan.mjs', `export const solve = (s) => ({ points: s.scans.map(() => ({ x: NaN, y: 0, z: 0 })), aps: {} });`);
    assert.equal((await runScenario(desc, { solverPath: nan, budgetMs: 5000 })).score, FAIL_SCORE);

    // Laço infinito: a thread é derrubada e o cenário leva a nota de falha.
    const hang = write('hang.mjs', `export function solve() { for (;;) {} }`);
    const t0 = performance.now();
    const hung = await runScenario(desc, { solverPath: hang, budgetMs: 300, graceMs: 700 });
    assert.equal(hung.ok, false);
    assert.equal(hung.score, FAIL_SCORE);
    assert.match(hung.error, /tempo/);
    assert.ok(performance.now() - t0 < 5000);
    // Terminou, mas passou do tempo: também é falha.
    const slow = write(
      'slow.mjs',
      `export async function solve(s) { await new Promise((r) => setTimeout(r, 400)); return { points: s.scans.map(() => ({ x: 0, y: 0, z: 0 })), aps: {} }; }`,
    );
    const late = await runScenario(desc, { solverPath: slow, budgetMs: 100, graceMs: 3000 });
    assert.equal(late.score, FAIL_SCORE);
    assert.match(late.error, /tempo/);

    // Conjunto filtrado, em paralelo, com os resumos por grupo.
    const seen = [];
    const bench = await runBench({ solverPath: BASELINE, set: 'dev', only: 'kitnet-pontos', jobs: 2, onResult: (r) => seen.push(r.name) });
    assert.equal(bench.results.length, 4);
    assert.deepEqual(
      seen,
      bench.results.map((r) => r.name),
      'resultados saem na ordem dos cenários',
    );
    assert.equal(bench.aggregate.count, 4);
    assert.deepEqual(Object.keys(bench.groups), ['kitnet']);
    assert.deepEqual(Object.keys(bench.modes).sort(), ['pontos-3.5s', 'pontos-30s']);
    close(bench.aggregate.score, bench.results.reduce((s, r) => s + r.score, 0) / 4, 1e-9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desenho: SVG com planta, caminho e legenda, mesmo quando a solução falha', () => {
  const sc = twoFloors;
  const solution = solveMds(sc.survey);
  const result = { name: sc.desc.name, scans: sc.survey.scans.length, durationMin: 20, ...evaluate(solution, sc.truth, sc.survey) };
  const svg = renderSvg(sc, solution, result);
  assert.ok(svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'));
  for (const text of ['Térreo', '1º andar', 'Suíte', 'caminho real', 'roteador estimado', 'varredura 1 '])
    assert.ok(svg.includes(text), text);
  assert.equal((svg.match(/<circle [^>]*r="4"[^>]*><title>/g) || []).length, sc.survey.scans.length, 'um ponto por varredura');
  assert.doesNotMatch(svg, /NaN|undefined/);
  const failed = renderSvg(sc, null, { name: sc.desc.name, scans: 1, ...failure('quebrou <feio>') });
  assert.ok(failed.includes('FALHOU') && failed.includes('&lt;feio&gt;') && !failed.includes('<feio>'));
});
