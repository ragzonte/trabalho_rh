// "Ajustar a escala": a conta que junta o tamanho estimado pelo solucionador com as distâncias
// medidas pelo usuário (app/js/mapping/solver-scale.js) e o que o solucionador faz com ela.
//
// A regra, medida na bancada (os números estão no topo de solver-scale.js): a distância medida é
// comparada com o mapa INTEIRO, de ponta a ponta, não com a distância entre os dois pontos no
// mapa. Se não cabe, o mapa cresce até caber; se cabe, o tamanho não muda; o ajuste nunca encolhe.

import assert from 'node:assert/strict';
import test from 'node:test';

import { SCALE_MAX_FACTOR, SCALE_MIN_CHANGE, SCALE_PRIOR_SD, SPAN_EDGE, SPAN_RADII, fuseScale, mapSpan } from '../app/js/mapping/solver-scale.js';
import { solve, solveQuick } from '../app/js/mapping/solver.js';
import { presetSpec } from '../app/js/sim/presets.js';
import { planWalk, simulateSurvey } from '../app/js/sim/walk.js';
import { createWorld } from '../app/js/sim/world.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || 'valor'}: ${a} (esperado ${b} ± ${tol})`);

// ---------------------------------------------------------------------------
// mapSpan: quanto cabe no mapa de ponta a ponta
// ---------------------------------------------------------------------------

test('mapSpan: centro, raio quadrático médio, diâmetro e o comprimento que vale', () => {
  // retângulo 4 x 3 com um ponto no meio: diâmetro = diagonal
  const r = mapSpan([0, 4, 4, 0, 2], [0, 0, 3, 3, 1.5]);
  close(r.cx, 2, 1e-12);
  close(r.cy, 1.5, 1e-12);
  close(r.diameter, 5, 1e-12, 'diâmetro');
  close(r.radius, Math.sqrt((4 * 6.25) / 5), 1e-12, 'raio');
  // 3,4 raios (7,6 m) passam do diâmetro (5 m): vale o maior — das duas estimativas, a que menos mexe no mapa
  close(r.span, SPAN_RADII * r.radius, 1e-12);
  assert.ok(r.span > r.diameter);

  // linha com as pontas longe e quase tudo no meio: aí quem manda é o diâmetro
  const xs = [-10, 10, ...Array.from({ length: 40 }, (_, i) => (i % 5) * 0.1)];
  const line = mapSpan(
    xs,
    xs.map(() => 0),
  );
  close(line.diameter, 20, 1e-12);
  assert.equal(line.span, line.diameter, 'diâmetro maior que 3,4 raios');
  assert.ok(SPAN_RADII * line.radius < 20);
});

test('mapSpan: o diâmetro é o do fecho convexo (confere com a força bruta) e não depende da ordem', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let round = 0; round < 30; round++) {
    const n = 3 + Math.floor(40 * Math.abs(rnd()));
    const xs = Array.from({ length: n }, () => 8 * rnd());
    const ys = Array.from({ length: n }, () => 3 * rnd() + (round % 3 === 0 ? 0 : 2 * rnd()));
    let brute = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) brute = Math.max(brute, Math.hypot(xs[i] - xs[j], ys[i] - ys[j]));
    const got = mapSpan(xs, ys);
    close(got.diameter, brute, 1e-9, `diâmetro com ${n} pontos`);
    const back = mapSpan(xs.slice().reverse(), ys.slice().reverse());
    close(back.diameter, got.diameter, 1e-12);
    close(back.radius, got.radius, 1e-9);
  }
});

test('mapSpan: entradas degeneradas não derrubam nada', () => {
  assert.deepEqual(mapSpan([], []), { cx: 0, cy: 0, radius: 0, diameter: 0, span: 0 });
  assert.deepEqual(mapSpan(null, undefined), { cx: 0, cy: 0, radius: 0, diameter: 0, span: 0 });
  assert.deepEqual(mapSpan([1], [2]), { cx: 1, cy: 2, radius: 0, diameter: 0, span: 0 });
  assert.equal(mapSpan([1, 1, 1], [2, 2, 2]).span, 0, 'todos no mesmo lugar');
  // colineares e repetidos
  close(mapSpan([0, 1, 2, 2, 3, 3], [0, 0, 0, 0, 0, 0]).diameter, 3, 1e-12);
  // o que não é número fica de fora (e vetores tipados também valem)
  const dirty = mapSpan(Float64Array.from([0, NaN, 4, Infinity]), Float64Array.from([0, 1, 3, 2]));
  close(dirty.diameter, 5, 1e-12);
  close(dirty.cx, 2, 1e-12);
});

// ---------------------------------------------------------------------------
// fuseScale: a fusão
// ---------------------------------------------------------------------------

test('fuseScale: medida que cabe no mapa não muda o tamanho; a que não cabe faz crescer até caber', () => {
  const span = 10;
  // cabe com folga: fator EXATAMENTE 1 (nada se move) e a medida quase não pesa
  for (const d of [0.5, 2, 5, 7]) {
    const f = fuseScale(span, [d]);
    assert.equal(f.factor, 1, `${d} m cabem em ${span} m`);
    assert.equal(f.used, 1);
    assert.ok(f.weight < 0.25, `peso pequeno (${f.weight})`);
  }
  // do tamanho do mapa inteiro: o teto tem folga (o comprimento do mapa é incerto), então já cresce um pouco
  const equal = fuseScale(span, [span]);
  assert.ok(equal.factor > 1.08 && equal.factor < 1.18, `medida = mapa inteiro: ${equal.factor}`);
  // não cabe: o mapa cresce até ela caber, com uma folga pequena (até 1,1 vez o necessário)...
  for (const d of [11, 12, 13, 14]) {
    const f = fuseScale(span, [d]);
    assert.ok(f.factor >= d / span && f.factor <= (1.1 * d) / span, `${d} m em ${span} m: fator ${f.factor}`);
  }
  // ...e, quando a medida pede um mapa muito maior, o que o solucionador achava ainda segura um
  // pouco (até 5% aquém do necessário): crescer 70% ou mais é raro mesmo para um mapa ruim
  for (const d of [15, 17, 19.5]) {
    const f = fuseScale(span, [d]);
    assert.ok(f.factor >= (0.95 * d) / span && f.factor <= (1.05 * d) / span, `${d} m em ${span} m: fator ${f.factor}`);
    assert.ok(f.factor <= SCALE_MAX_FACTOR + 1e-12);
  }
  // nunca encolhe, cresce com a medida, e a medida pesa cada vez mais (a incerteza que sobra diminui)
  let last = fuseScale(span, [0.5]);
  for (let d = 1; d <= 2 * span; d += 0.25) {
    const f = fuseScale(span, [d]);
    assert.ok(f.factor >= 1, 'nunca encolhe');
    assert.ok(f.factor >= last.factor - 1e-12, `fator monótono em ${d} m`);
    assert.ok(f.weight >= last.weight - 1e-9, `peso monótono em ${d} m`);
    assert.ok(f.sd <= last.sd + 1e-9 && f.sd > 0 && f.sd <= SCALE_PRIOR_SD + 1e-9, `incerteza monótona em ${d} m`);
    assert.ok(f.weight >= 0 && f.weight <= 1);
    last = f;
  }
  assert.ok(last.weight > 0.7, `medida bem maior que o mapa passa a mandar no tamanho (peso ${last.weight})`);
  // só depende da razão medida / mapa
  close(fuseScale(3, [3.6]).factor, fuseScale(30, [36]).factor, 1e-9);
});

test('fuseScale: o fator é o tamanho mais provável (a moda) de N(0, τ²) x Φ((ln(span/d) − s)/ε)', () => {
  // Φ por integração numérica (Simpson), sem usar a aproximação do módulo
  const pdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = (z) => {
    if (z < -8) return pdf(z) / -z; // cauda: basta a ordem de grandeza (ali a crença já é zero)
    const lo = -9;
    const n = 4000;
    const h = (z - lo) / n;
    let sum = pdf(lo) + pdf(z);
    for (let i = 1; i < n; i++) sum += (i % 2 ? 4 : 2) * pdf(lo + i * h);
    return (sum * h) / 3;
  };
  const check = (span, d, options = {}) => {
    const tau = options.priorSd || SCALE_PRIOR_SD;
    const eps = options.edge || SPAN_EDGE;
    const logPost = (s) => (-s * s) / (2 * tau * tau) + Math.log(cdf((Math.log(span / d) - s) / eps));
    let best = 0;
    let top = -Infinity;
    for (let s = -1; s <= 0.2; s += 0.0005) {
      const v = logPost(s);
      if (v > top) {
        top = v;
        best = s;
      }
    }
    const f = fuseScale(span, [d], options);
    const expected = Math.exp(-best);
    if (expected > 1 + SCALE_MIN_CHANGE) close(f.factor, expected, 0.002, `fator com ${d} m em ${span} m`);
    else assert.equal(f.factor, 1, `mudança de menos de 0,5% não é aplicada (${d} m em ${span} m)`);
    // e a incerteza que sobra é o desvio-padrão dessa mesma crença
    let z = 0;
    let m1 = 0;
    let m2 = 0;
    for (let s = -1.6; s <= 0.8; s += 0.002) {
      const q = Math.exp(logPost(s) - top);
      z += q;
      m1 += q * s;
      m2 += q * s * s;
    }
    const sd = Math.sqrt(m2 / z - (m1 / z) ** 2);
    close(f.sd, sd, 0.003, `incerteza com ${d} m em ${span} m`);
    close(f.weight, 1 - (sd * sd) / (tau * tau), 0.03, 'peso = parte da variância que a medida tirou');
  };
  for (const d of [4, 7.5, 8.5, 9.5, 10, 11, 13, 16, 19]) check(10, d);
  check(10, 12, { priorSd: 0.12 });
  check(10, 12, { priorSd: 0.4, edge: 0.05 });
  check(10, 9, { edge: 0.2 });
});

test('fuseScale: quanto mais incerto o tamanho de antes, mais a medida manda; teto mais folgado, menos', () => {
  const sure = fuseScale(10, [13], { priorSd: 0.08 });
  const normal = fuseScale(10, [13]);
  const unsure = fuseScale(10, [13], { priorSd: 0.5 });
  assert.ok(sure.factor < normal.factor && normal.factor < unsure.factor, `${sure.factor} < ${normal.factor} < ${unsure.factor}`);
  assert.ok(unsure.factor < 1.3 * 1.2, `mas nunca muito além do que a medida exige (${unsure.factor})`);
  assert.ok(fuseScale(10, [9.5], { edge: 0.3 }).factor > fuseScale(10, [9.5], { edge: 0.03 }).factor, 'com o comprimento do mapa incerto, a medida quase do tamanho dele já faz crescer');
  assert.equal(fuseScale(10, [9.5], { edge: 0.01 }).factor, 1, 'com o comprimento do mapa certo, medida que cabe não muda nada');
});

test('fuseScale: várias medidas — manda a mais comprida, em qualquer ordem', () => {
  const one = fuseScale(10, [12]);
  for (const list of [
    [12, 5],
    [5, 12],
    [3, 12, 7, 11.9],
    [12, 12, 12],
  ]) {
    const f = fuseScale(10, list);
    assert.equal(f.factor, one.factor, `medidas ${list}`);
    assert.equal(f.weight, one.weight);
    assert.equal(f.used, list.length);
    assert.equal(f.ignored, 0);
  }
  // duas medidas quase iguais não empurram o mapa duas vezes (a incerteza do teto é a mesma para as duas)
  assert.equal(fuseScale(10, [12, 11.99]).factor, one.factor);
  assert.ok(fuseScale(10, [12, 14]).factor > one.factor);
});

test('fuseScale: medida que contradiz o mapa, lixo e mapa sem tamanho ficam de fora', () => {
  // mais que o dobro do que cabe no mapa: erro de digitação, não erro do mapa
  const absurd = fuseScale(10, [20.01]);
  assert.deepEqual(absurd, { factor: 1, weight: 0, sd: SCALE_PRIOR_SD, used: 0, ignored: 1 });
  assert.equal(fuseScale(10, [42]).factor, 1);
  assert.equal(fuseScale(10, [20]).used, 1, 'no limite ainda vale');
  // a absurda não estraga a boa
  const mixed = fuseScale(10, [12, 300, NaN, -3, 0, '12', null, Infinity]);
  assert.equal(mixed.factor, fuseScale(10, [12]).factor);
  assert.equal(mixed.used, 1);
  assert.equal(mixed.ignored, 7);
  for (const bad of [0, -1, NaN, Infinity, null, undefined, '10']) {
    const f = fuseScale(bad, [5]);
    assert.equal(f.factor, 1, `span ${bad}`);
    assert.equal(f.used, 0);
    assert.equal(f.ignored, 1);
  }
  assert.deepEqual(fuseScale(10, []), { factor: 1, weight: 0, sd: SCALE_PRIOR_SD, used: 0, ignored: 0 });
  assert.deepEqual(fuseScale(10, null), { factor: 1, weight: 0, sd: SCALE_PRIOR_SD, used: 0, ignored: 0 });
  // medidas minúsculas ou gigantes não geram NaN
  for (const d of [1e-9, 1e-3, 19.999999]) {
    const f = fuseScale(10, [d]);
    assert.ok(Number.isFinite(f.factor) && Number.isFinite(f.weight) && Number.isFinite(f.sd), `${d}`);
  }
});

// ---------------------------------------------------------------------------
// No solucionador
// ---------------------------------------------------------------------------

function survey() {
  const w = createWorld(presetSpec('kitnet', 1), 1);
  return simulateSurvey(w, planWalk(w, { seed: 7, kind: 'spots', count: 10 }), { seed: 7, scanIntervalS: 3.5, stillScans: 2 }).survey;
}
const radius = (points) => {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return Math.sqrt(points.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / points.length);
};
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const spanOf = (solution) =>
  mapSpan(
    solution.points.map((p) => p.x),
    solution.points.map((p) => p.y),
  ).span;

test('solve: sem distância medida o ajuste é inerte; com uma, o resumo vai em debug.scaleAdjust', async () => {
  const sv = survey();
  const base = await solve(sv);
  for (const none of [undefined, null, [], 'x', {}]) {
    const again = await solve({ ...sv, knownDistances: none });
    assert.deepEqual(again.points, base.points, `knownDistances = ${JSON.stringify(none)}`);
    assert.deepEqual(again.aps, base.aps);
    assert.equal(again.scaleConf, base.scaleConf);
    assert.equal(again.debug.scaleAdjust, undefined);
  }
  const span = spanOf(base);
  // duas varreduras de lugares diferentes
  const a = sv.scans.findIndex((s) => s.spot !== null);
  const b = sv.scans.findIndex((s) => s.spot !== null && s.spot !== sv.scans[a].spot);
  const rest = sv.scans.map((s, i) => i).filter((i) => sv.scans[i].spot !== sv.scans[a].spot && sv.scans[i].spot !== sv.scans[b].spot);
  const pick = (solution) => rest.map((i) => solution.points[i]);

  // cabe no mapa: só o par se acerta
  const fits = await solve({ ...sv, knownDistances: [{ a, b, meters: 0.6 * span }] });
  close(dist(fits.points[a], fits.points[b]), 0.6 * span, 1e-6, 'par exato');
  close(radius(pick(fits)) / radius(pick(base)), 1, 1e-9, 'o tamanho não muda');
  assert.deepEqual(fits.debug.scaleAdjust, { applied: false, factor: 1, weight: Math.round(fuseScale(span, [0.6 * span]).weight * 100) / 100, used: 1, ignored: 0, spanM: Math.round(span * 100) / 100, longestM: Math.round(0.6 * span * 100) / 100 });
  // (acertar o par muda um pouco o centro e o eixo do mapa, e o referencial de saída gira junto: o que
  // se confere são distâncias, que não dependem do referencial)
  const apIds = Object.keys(base.aps);
  for (let i = 1; i < apIds.length; i++) close(dist(fits.aps[apIds[0]], fits.aps[apIds[i]]), dist(base.aps[apIds[0]], base.aps[apIds[i]]), 1e-9, 'roteadores à mesma distância uns dos outros');

  // não cabe: tudo cresce pelo fator da fusão em torno do centro, os roteadores junto, e o nível a 1 m acompanha
  const meters = 1.4 * span;
  const k = fuseScale(span, [meters]).factor;
  const grown = await solve({ ...sv, knownDistances: [{ a, b, meters }] });
  close(dist(grown.points[a], grown.points[b]), meters, 1e-6, 'par exato');
  close(radius(pick(grown)) / radius(pick(base)), k, 1e-6, 'fator');
  assert.equal(grown.debug.scaleAdjust.applied, true);
  close(grown.debug.scaleAdjust.factor, k, 0.0006);
  // dois roteadores em lugares diferentes (os BSSIDs de um mesmo aparelho dividem a posição)
  const far = apIds.slice().sort((p, q) => dist(base.aps[q], base.aps[apIds[0]]) - dist(base.aps[p], base.aps[apIds[0]]))[0];
  assert.ok(dist(base.aps[apIds[0]], base.aps[far]) > 0.5, 'há dois roteadores separados no mapa');
  close(dist(grown.aps[apIds[0]], grown.aps[far]) / dist(base.aps[apIds[0]], base.aps[far]), k, 1e-6, 'roteadores esticam junto');
  close(grown.aps[far].p0 - base.aps[far].p0, 10 * base.aps[far].n * Math.log10(k), 1e-9, 'p0 na escala nova');
  assert.ok(grown.scaleConf > base.scaleConf && grown.scaleConf <= 1);
  close(grown.scaleConf, Math.max(base.scaleConf, 0.95 * Math.round(fuseScale(span, [meters]).weight * 100) / 100), 1e-9, 'confiança de escala = 0,95 x peso');

  // repetível, e a prévia rápida faz a mesma conta sobre o mapa dela
  assert.deepEqual((await solve({ ...sv, knownDistances: [{ a, b, meters }] })).points, grown.points);
  const quickBase = solveQuick(sv);
  const quick = solveQuick({ ...sv, knownDistances: [{ a, b, meters: 1.3 * spanOf(quickBase) }] });
  close(quick.debug.scaleAdjust.factor, fuseScale(spanOf(quickBase), [1.3 * spanOf(quickBase)]).factor, 0.0006);
});

test('solve: medida entre andares conta só a parte horizontal; a que não vence o pé-direito é ignorada', async () => {
  const w = createWorld(presetSpec('sobrado', 1), 1);
  const sv = simulateSurvey(w, planWalk(w, { seed: 3, kind: 'spots', count: 14 }), { seed: 3, scanIntervalS: 3.5, stillScans: 1 }).survey;
  const base = await solve(sv);
  const a = sv.scans.findIndex((s) => s.floor === 0);
  const b = sv.scans.findIndex((s) => s.floor !== 0);
  assert.ok(a >= 0 && b >= 0, 'há dois andares');
  const dz = Math.abs(base.points[a].z - base.points[b].z);
  const span = spanOf(base);
  const flat = 1.3 * span;
  const out = await solve({ ...sv, knownDistances: [{ a, b, meters: Math.hypot(flat, dz) }] });
  close(out.debug.scaleAdjust.longestM, flat, 0.011, 'a medida usada é a horizontal');
  close(out.debug.scaleAdjust.factor, fuseScale(span, [flat]).factor, 0.0006);
  close(dist(out.points[a], out.points[b]), flat, 1e-6);
  // menor que a altura entre os andares: não sobra distância horizontal
  const short = await solve({ ...sv, knownDistances: [{ a, b, meters: 0.9 * dz }] });
  assert.deepEqual(short.points, base.points);
  assert.equal(short.debug.scaleAdjust.used, 0);
  assert.equal(short.debug.scaleAdjust.ignored, 1);
});
