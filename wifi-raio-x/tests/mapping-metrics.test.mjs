// Testes da bancada do mapa 3D: alinhamento, métricas, nota e execução isolada.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FLOOR_HEIGHT } from '../app/js/mapping/types.js';
import { createRng } from '../app/js/sim/prng.js';
import { execFileSync } from 'node:child_process';

import { solveCollapse, solveMds, solveOracle, solveOracleField, solveOracleTrack, solveTimeLoop } from './mapping/baseline.mjs';
import { DEFAULT_HOLDOUT_SALT, buildScenario, lintSolver, listScenarios, renderSvg, runBench, runScenario } from './mapping/harness.mjs';
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
  assert.equal(holdout.length, 56);
  assert.equal(all.length, 88);
  assert.equal(new Set(all.map((s) => s.name)).size, 88, 'nomes únicos');
  assert.deepEqual(listScenarios('dev'), dev);
  assert.equal(holdout.filter((s) => s.world.type === 'random').length, 24);
  // Cada modo e cada família aparecem em quantidade igual: nenhuma decide a nota sozinha.
  for (const mode of ['tour-3.5s', 'perimetro-3.5s', 'pontos-3.5s', 'pontos-30s']) assert.equal(holdout.filter((s) => s.mode === mode).length, 14);
  for (const group of ['apartamento', 'sobrado', 'escritorio', 'kitnet']) assert.equal(holdout.filter((s) => s.group === group).length, 8);
  // O holdout usa outras sementes e outra física.
  const devWorlds = new Set(dev.map((s) => `${s.world.id}#${s.world.seed}`));
  for (const s of holdout) {
    assert.ok(!devWorlds.has(`${s.world.id}#${s.world.seed}`));
    assert.ok(s.rf.n >= 1.8 && s.rf.n <= 2.55 && s.rf.wallScale >= 0.8 && s.rf.wallScale <= 1.2);
    assert.equal(typeof s.rf.staleCarry, 'boolean');
  }
  for (const s of dev) assert.deepEqual(s.rf, {});
  assert.ok(new Set(holdout.map((s) => s.rf.n)).size > 40, 'cada cenário do holdout tem a sua física');
  const carry = holdout.filter((s) => s.rf.staleCarry).length;
  assert.ok(carry >= 15 && carry <= 41, `celulares que repetem leituras antigas no holdout: ${carry} de 56`);
  assert.ok(holdout.some((s) => s.group === 'sobrado' && s.walk.floorOrder) && holdout.some((s) => s.group === 'sobrado' && !s.walk.floorOrder));
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

// ---------------------------------------------------------------------------
// Regressões da revisão: métricas conferidas por outro caminho, soluções que tentam
// enganar a nota, sementes do holdout e isolamento do solucionador.
// ---------------------------------------------------------------------------

// Alinhamento pela decomposição em valores singulares (Kabsch/Umeyama): outra derivação, mesmo mínimo.
function alignBySvd(est, truth, withScale, allowReflection) {
  const n = est.length;
  const centre = (pts) => pts.reduce((c, p) => [c[0] + p.x / n, c[1] + p.y / n], [0, 0]);
  const [me, mg] = [centre(est), centre(truth)];
  let h00 = 0;
  let h01 = 0;
  let h10 = 0;
  let h11 = 0;
  let ee = 0;
  for (let i = 0; i < n; i++) {
    const [ex, ey, gx, gy] = [est[i].x - me[0], est[i].y - me[1], truth[i].x - mg[0], truth[i].y - mg[1]];
    h00 += gx * ex;
    h01 += gx * ey;
    h10 += gy * ex;
    h11 += gy * ey;
    ee += ex * ex + ey * ey;
  }
  // H = Rot(phi) · diag(s1, s2) · Rot(theta), com s2 negativo quando det(H) < 0.
  const [e, f, g, h] = [(h00 + h11) / 2, (h00 - h11) / 2, (h10 + h01) / 2, (h10 - h01) / 2];
  const [q, r] = [Math.hypot(e, h), Math.hypot(f, g)];
  const [s1, s2] = [q + r, q - r];
  const [a1, a2] = [Math.atan2(g, f), Math.atan2(h, e)];
  const [phi, theta] = [(a2 + a1) / 2, (a2 - a1) / 2];
  const mirrored = allowReflection && s1 - s2 > s1 + s2 + 1e-12;
  const rot = (a) => [
    [Math.cos(a), -Math.sin(a)],
    [Math.sin(a), Math.cos(a)],
  ];
  const mul = (A, B) => [
    [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1]],
    [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1]],
  ];
  const R = mirrored
    ? mul(
        mul(rot(phi), [
          [1, 0],
          [0, -1],
        ]),
        rot(theta),
      )
    : rot(phi + theta);
  const scale = withScale ? (mirrored ? s1 - s2 : s1 + s2) / ee : 1;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const [ex, ey] = [est[i].x - me[0], est[i].y - me[1]];
    sq += (scale * (R[0][0] * ex + R[0][1] * ey) + mg[0] - truth[i].x) ** 2 + (scale * (R[1][0] * ex + R[1][1] * ey) + mg[1] - truth[i].y) ** 2;
  }
  return { rmse: Math.sqrt(sq / n), scale, mirrored };
}

test('procrustes: bate com a solução por SVD em casos aleatórios, com e sem espelho e escala', () => {
  const rng = createRng('svd', 4);
  let mirroredCases = 0;
  for (let trial = 0; trial < 400; trial++) {
    const n = rng.int(3, 40);
    const truth = Array.from({ length: n }, () => ({ x: rng.gaussian(0, 3), y: rng.gaussian(0, rng.float(0.2, 3)) }));
    const [angle, mirror, scale] = [rng.float(-Math.PI, Math.PI), rng.chance(0.5), rng.float(0.2, 4)];
    const noise = rng.chance(0.3) ? 0 : rng.float(0, 3);
    const est = transform(truth, { angle, mirror, scale, tx: 5, ty: -2 }).map((p) => ({ x: p.x + rng.gaussian(0, noise), y: p.y + rng.gaussian(0, noise) }));
    for (const withScale of [false, true]) {
      for (const reflection of [true, false]) {
        const ours = procrustes(est, truth, { scale: withScale, reflection });
        const ref = alignBySvd(est, truth, withScale, reflection);
        close(ours.rmse, ref.rmse, 1e-9, `rmse (escala ${withScale}, espelho ${reflection})`);
        close(ours.scale, ref.scale, 1e-9, 'escala');
        if (!withScale) assert.equal(ours.scale, 1, 'o alinhamento rígido nunca muda o tamanho');
        if (!reflection) assert.equal(ours.reflected, false);
        const [[a, b], [c, d]] = ours.rotation;
        close(Math.abs(a * d - b * c), 1, 1e-9, 'determinante');
        if (ours.reflected) mirroredCases++;
        // A matriz devolvida é mesmo escala x rotação: nada de escala escondida no "rígido".
        close(Math.hypot(ours.matrix[0][0], ours.matrix[1][0]), ours.scale, 1e-9, 'norma da coluna');
      }
    }
  }
  assert.ok(mirroredCases > 200, 'os casos espelhados foram exercitados');
});

test('confiabilidade e continuidade: iguais à fórmula de Venna e Kaski quando não há empates', () => {
  const standard = (X, Y, k) => {
    const n = X.length;
    const ranks = (P, i) => {
      const order = P.map((p, j) => [Math.hypot(p.x - P[i].x, p.y - P[i].y), j])
        .filter(([, j]) => j !== i)
        .sort((a, b) => a[0] - b[0]);
      const r = new Array(n).fill(0);
      order.forEach(([, j], idx) => (r[j] = idx + 1));
      return r;
    };
    let t = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
      const [rx, ry] = [ranks(X, i), ranks(Y, i)];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        if (ry[j] <= k && rx[j] > k) t += rx[j] - k; // intruso na vizinhança estimada
        if (rx[j] <= k && ry[j] > k) c += ry[j] - k; // vizinho de verdade que foi embora
      }
    }
    const norm = 2 / (n * k * (2 * n - 3 * k - 1));
    return { trust: 1 - norm * t, continuity: 1 - norm * c };
  };
  const rng = createRng('vk', 2);
  for (let trial = 0; trial < 25; trial++) {
    const n = rng.int(20, 80);
    const truth = Array.from({ length: n }, () => ({ x: rng.float(0, 10), y: rng.float(0, 7) }));
    const est = truth.map((p) => ({ x: p.x + rng.gaussian(0, 2), y: p.y + rng.gaussian(0, 2) }));
    const ours = trustContinuity(est, truth, 6);
    const ref = standard(truth, est, 6);
    close(ours.trust, ref.trust, 1e-12, 'confiabilidade');
    close(ours.continuity, ref.continuity, 1e-12, 'continuidade');
  }
});

// Saídas que não usam o Wi-Fi: só a ordem das varreduras no tempo, ou nem isso.
const TRICKS = {
  collapse: () => ({ x: 0, y: 0 }),
  'linha na velocidade de caminhada': (s) => ({ x: 0.6 * s.t, y: 0 }),
  'linha do tamanho de uma casa': (s, T) => ({ x: (8 * s.t) / T, y: 0 }),
  'vai e volta numa linha': (s, T) => ({ x: 8 * (1 - Math.abs((2 * s.t) / T - 1)), y: 0 }),
  'duas voltas de círculo': (s, T) => ({ x: 3 * Math.cos((4 * Math.PI * s.t) / T), y: 3 * Math.sin((4 * Math.PI * s.t) / T) }),
  'círculo na velocidade de caminhada': (s) => ({ x: 3 * Math.cos(0.2 * s.t), y: 3 * Math.sin(0.2 * s.t) }),
  espiral: (s, T) => ({ x: ((4 * s.t) / T) * Math.cos((6 * Math.PI * s.t) / T), y: ((4 * s.t) / T) * Math.sin((6 * Math.PI * s.t) / T) }),
};
function trick(survey, fn) {
  const T = survey.scans[survey.scans.length - 1].t;
  return { points: survey.scans.map((s) => ({ ...fn(s, T), z: s.floor * FLOOR_HEIGHT, conf: 0 })), aps: {}, scaleConf: 0 };
}

test('nota: soluções que ignoram o Wi-Fi ficam em ~100 e bem atrás do MDS', () => {
  // Um cenário de cada modo em cada mundo do dev (16 ao todo).
  const sample = listScenarios('dev')
    .filter((s) => s.name.endsWith('-s1'))
    .map(buildScenario);
  const avg = (solve) => sample.reduce((sum, sc) => sum + evaluate(solve(sc.survey), sc.truth, sc.survey).score, 0) / sample.length;
  const mds = avg(solveMds);
  assert.ok(mds < 85, `MDS: ${mds}`);
  for (const [name, fn] of Object.entries(TRICKS)) {
    const score = avg((survey) => trick(survey, fn));
    assert.ok(score >= 97, `${name}: ${score}`);
    assert.ok(score > mds + 20, `${name} (${score}) x MDS (${mds})`);
  }
  // Uma volta de círculo é o truque que mais rende (a visita aos pontos é uma volta pela casa):
  // ainda assim fica longe do MDS, e é a referência "só o relógio" da bancada.
  const loop = avg(solveTimeLoop);
  assert.ok(loop > 90 && loop > mds + 15, `uma volta de círculo: ${loop} x MDS ${mds}`);
  // Passeio aleatório suave e nuvem aleatória: piores que juntar tudo num ponto.
  const rng = createRng('truques', 3);
  const cloud8 = avg((survey) => trick(survey, () => ({ x: rng.float(0, 8), y: rng.float(0, 6) })));
  assert.ok(cloud8 > 100, `nuvem aleatória: ${cloud8}`);
  // Encolher o MDS para a metade não rende nada.
  const shrunk = avg((survey) => {
    const out = solveMds(survey);
    return { ...out, points: out.points.map((p) => ({ ...p, x: p.x / 2, y: p.y / 2 })), aps: {} };
  });
  assert.ok(shrunk > mds, `MDS encolhido ${shrunk} x MDS ${mds}`);
  // Coordenadas absurdas (mas finitas) batem no teto de cada parcela, perto da nota de falha.
  const huge = avg((survey) => trick(survey, (s) => ({ x: 1e200 * Math.sin(s.t), y: 1e200 * Math.cos(1.7 * s.t) })));
  assert.ok(huge > 150 && huge <= FAIL_SCORE, `coordenadas enormes: ${huge}`);
});

test('holdout: sementes saem do sal, não são números pequenos e não aparecem nos nomes', () => {
  const pub = listScenarios('holdout', { salt: DEFAULT_HOLDOUT_SALT });
  assert.deepEqual(listScenarios('holdout'), pub, 'sem sal informado vale o público');
  const secret = listScenarios('holdout', { salt: 'outro-sal' });
  assert.deepEqual(
    secret.map((s) => s.name),
    pub.map((s) => s.name),
    'os nomes não dependem do sal',
  );
  const seeds = new Set();
  pub.forEach((s, i) => {
    for (const seed of [s.world.seed, s.walk.seed, s.survey.seed]) {
      assert.ok(Number.isInteger(seed) && seed > 100000, `${s.name}: semente ${seed}`);
      assert.ok(!s.name.includes(String(seed)));
      seeds.add(seed);
    }
    assert.notEqual(s.world.seed, secret[i].world.seed, 'outro sal, outro mundo');
    assert.notDeepEqual(s.rf, secret[i].rf);
  });
  assert.equal(seeds.size, 3 * pub.length, 'nenhuma semente repetida');
  // Outro sal dá outro levantamento (outras redes, outros roteadores): decorar o público não ajuda.
  const a = buildScenario(pub[0]).survey;
  const b = buildScenario(secret[0]).survey;
  assert.equal(Object.keys(a.aps).filter((id) => b.aps[id]).length, 0, 'nenhum BSSID em comum');
  // A variável de ambiente também vale.
  const before = process.env.WRX_HOLDOUT_SALT;
  process.env.WRX_HOLDOUT_SALT = 'outro-sal';
  try {
    assert.deepEqual(listScenarios('holdout'), secret);
  } finally {
    if (before === undefined) delete process.env.WRX_HOLDOUT_SALT;
    else process.env.WRX_HOLDOUT_SALT = before;
  }
});

test('bancada: a thread do solucionador não enxerga sal, sementes nem o nome do cenário', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrx-isolada-'));
  const before = process.env.WRX_HOLDOUT_SALT;
  process.env.WRX_HOLDOUT_SALT = 'segredo-do-juiz';
  try {
    const desc = listScenarios('holdout').find((s) => s.name === 'kitnet-pontos-30s-h1');
    const spy = path.join(dir, 'spy.mjs');
    fs.writeFileSync(
      spy,
      `import { workerData } from 'node:worker_threads';
       export function solve(survey, options) {
         const seen = JSON.stringify([workerData, options, process.argv.slice(2)]);
         if (process.env.WRX_HOLDOUT_SALT !== undefined) throw new Error('VAZOU o sal');
         if (seen.includes('segredo-do-juiz') || seen.includes(${JSON.stringify(desc.name)})) throw new Error('VAZOU o cenário');
         if (seen.includes(${JSON.stringify(String(desc.world.seed))})) throw new Error('VAZOU a semente');
         if (workerData.oracle) throw new Error('VAZOU o canal dos oráculos');
         if (/"(x|y|z|seed|world|truth|points|rooms|heading)"\\s*:/.test(seen)) throw new Error('VAZOU verdade');
         if (Object.keys(options).join() !== 'budgetMs') throw new Error('opções a mais: ' + Object.keys(options));
         return { points: survey.scans.map(() => ({ x: 0, y: 0, z: 0, conf: 0 })), aps: {}, scaleConf: 0 };
       }`,
    );
    const spied = await runScenario(desc, { solverPath: spy, budgetMs: 5000 });
    assert.equal(spied.error, null);
    assert.ok(spied.ok);
    assert.equal(process.env.WRX_HOLDOUT_SALT, 'segredo-do-juiz', 'a bancada não mexe no ambiente de quem a chamou');
  } finally {
    if (before === undefined) delete process.env.WRX_HOLDOUT_SALT;
    else process.env.WRX_HOLDOUT_SALT = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregate: erro-padrão da nota e máximos; linha de comando com tabela alinhada e JSON estável', () => {
  const a = aggregate([{ ok: true, score: 40, runtimeMs: 10 }, { ok: true, score: 60, runtimeMs: 30 }, failure('x')]);
  close(a.score, 100, 1e-9);
  close(a.scoreSe, Math.sqrt(((60 ** 2 + 40 ** 2 + 100 ** 2) / 2) / 3), 1e-9, 'erro-padrão');
  assert.equal(a.max.runtimeMs, 30);
  assert.equal(aggregate([{ ok: true, score: 40 }]).scoreSe, null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrx-cli-'));
  try {
    // Solucionador de coordenadas absurdas: a tabela não pode desalinhar.
    const huge = path.join(dir, 'huge.mjs');
    fs.writeFileSync(huge, `export const solve = (s) => ({ points: s.scans.map((q, i) => ({ x: 1e250 * Math.sin(i), y: -1e250 * i, z: 0 })), aps: {} });`);
    const harness = path.join(HERE, 'mapping', 'harness.mjs');
    const run = (...args) => execFileSync(process.execPath, [harness, ...args], { encoding: 'utf8' });
    const lines = run('--solver', huge, '--only', 'kitnet-pontos-30s').split('\n');
    const header = lines.findIndex((l) => l.startsWith('cenário'));
    const rows = lines.slice(header + 1, header + 3);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.length, lines[header].length, `linha desalinhada: ${row}`);
      assert.doesNotMatch(row, /e\+|Infinity|NaN/);
    }
    assert.ok(lines.some((l) => /^NOTA FINAL: \d+\.\d ± \d+\.\d/.test(l)));
    // JSON: só JSON na saída, mesmas notas em duas execuções.
    const strip = (text) => JSON.stringify(JSON.parse(text), (k, v) => (k === 'runtimeMs' || k === 'wallMs' ? undefined : v));
    const one = run('--solver', BASELINE, '--only', 'kitnet-pontos-30s', '--json');
    const two = run('--solver', BASELINE, '--only', 'kitnet-pontos-30s', '--json', '--jobs', '1');
    assert.equal(strip(one), strip(two));
    const parsed = JSON.parse(one);
    assert.deepEqual(Object.keys(parsed), ['solver', 'export', 'set', 'budgetMs', 'wallMs', 'results', 'aggregate', 'groups', 'modes', 'warnings']);
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.results.length, 2);
    // Filtro que não casa com nada: erro claro, sem estourar.
    assert.throws(() => execFileSync(process.execPath, [harness, '--solver', BASELINE, '--only', 'zzz'], { encoding: 'utf8', stdio: 'pipe' }), /nenhum cenário/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conferência de regras: aponta solucionador que importa o simulador ou usa o Node', () => {
  const clean = `// import { x } from '../sim/world.js' (só um comentário)
    import { FLOOR_HEIGHT } from '../types.js';
    export function solve(survey) { return { points: [], aps: {}, scaleConf: FLOOR_HEIGHT }; } // nada de Math.random aqui`;
  assert.deepEqual(lintSolver(clean), []);
  const cheats = {
    'importa "../../sim/presets.js"': `import { presetWorld } from '../../sim/presets.js';`,
    'importa "node:fs"': `import fs from 'node:fs';`,
    'importa "../../../tests/mapping/harness.mjs"': `export { solve } from "../../../tests/mapping/harness.mjs";`,
    'usa import() dinâmico': `const m = await import('./' + name);`,
    'usa require()': `const fs = require('fs');`,
    'usa APIs do Node (process, node:..., workerData)': `const salt = process.env.WRX_HOLDOUT_SALT;`,
    'usa Math.random ou Date.now (resultado não se repete)': `const jitter = Math.random();`,
    'cita nomes de redes dos mundos de teste': `if (ssid.endsWith('-CORP')) plan = OFFICE;`,
  };
  for (const [warning, code] of Object.entries(cheats)) {
    assert.ok(lintSolver(`${clean}\n${code}`).includes(warning), `${warning} <- ${code}: ${lintSolver(code)}`);
  }
  // As referências da bancada só importam os tipos.
  assert.deepEqual(lintSolver(fs.readFileSync(BASELINE, 'utf8')), []);
});
