// Métricas da bancada do mapa 3D: alinha a solução com a verdade e mede o erro.
//
// Só o Wi-Fi não permite saber a rotação nem o espelhamento do mapa, então toda
// comparação é feita depois do melhor alinhamento no plano horizontal (x, y):
//   - "rígido"   = rotação + translação (+ espelho), SEM mudar a escala: pune escala errada;
//   - "similar"  = o mesmo, mais um fator de escala: mede só a qualidade da forma.

import { FLOOR_HEIGHT } from '../../app/js/mapping/types.js';

/** Nota fixa de uma execução que falhou (erro, estouro de tempo ou saída inválida). */
export const FAIL_SCORE = 200;
/** Erro atribuído a um roteador que a solução não posicionou (m). */
export const AP_MISSING_M = 50;
/** Vizinhança usada em confiabilidade/continuidade. */
export const NEIGHBOURS = 6;

const getX = (p) => (Array.isArray(p) ? p[0] : p.x);
const getY = (p) => (Array.isArray(p) ? p[1] : p.y);

/**
 * Melhor alinhamento (mínimos quadrados) de `est` sobre `truth` no plano horizontal.
 * Forma fechada com números complexos: com os dois conjuntos centrados,
 * a rotação ótima é o argumento de Σ conj(e)·g e a escala ótima |Σ conj(e)·g| / Σ|e|².
 * O espelho é testado refletindo `est` (y -> -y) e ficando com o melhor dos dois.
 *
 * @param {{x:number,y:number}[]|number[][]} est
 * @param {{x:number,y:number}[]|number[][]} truth
 * @param {{scale?: boolean, reflection?: boolean}} [options]
 * @returns {{rotation:number[][], angle:number, reflected:boolean, scale:number, translation:number[],
 *            matrix:number[][], aligned:{x:number,y:number}[], rmse:number, apply:(p:{x:number,y:number})=>{x:number,y:number}}}
 *          p' = matrix · p + translation, com matrix = scale · rotation (rotation já inclui o espelho)
 */
export function procrustes(est, truth, options = {}) {
  const useScale = !!options.scale;
  const allowReflection = options.reflection !== false;
  const n = Math.min(est.length, truth.length);
  let ex = 0;
  let ey = 0;
  let gx = 0;
  let gy = 0;
  for (let i = 0; i < n; i++) {
    ex += getX(est[i]);
    ey += getY(est[i]);
    gx += getX(truth[i]);
    gy += getY(truth[i]);
  }
  if (n > 0) {
    ex /= n;
    ey /= n;
    gx /= n;
    gy /= n;
  }
  // Somas para o caso direto (a, b) e para o espelhado (am, bm).
  let a = 0;
  let b = 0;
  let am = 0;
  let bm = 0;
  let ee = 0;
  for (let i = 0; i < n; i++) {
    const px = getX(est[i]) - ex;
    const py = getY(est[i]) - ey;
    const qx = getX(truth[i]) - gx;
    const qy = getY(truth[i]) - gy;
    a += px * qx + py * qy;
    b += px * qy - py * qx;
    am += px * qx - py * qy;
    bm += px * qy + py * qx;
    ee += px * px + py * py;
  }
  const gain = Math.hypot(a, b);
  const gainM = Math.hypot(am, bm);
  const reflected = allowReflection && gainM > gain + 1e-12;
  const g = reflected ? gainM : gain;
  const angle = g > 1e-12 ? (reflected ? Math.atan2(bm, am) : Math.atan2(b, a)) : 0;
  // Estimativa degenerada (todos os pontos no mesmo lugar): escala 0 na versão com escala.
  const scale = useScale ? (ee > 1e-12 ? g / ee : 0) : 1;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const m = reflected ? -1 : 1; // espelho: y -> -y antes de girar
  const rotation = [
    [c, -s * m],
    [s, c * m],
  ];
  const matrix = [
    [rotation[0][0] * scale, rotation[0][1] * scale],
    [rotation[1][0] * scale, rotation[1][1] * scale],
  ];
  const translation = [gx - (matrix[0][0] * ex + matrix[0][1] * ey), gy - (matrix[1][0] * ex + matrix[1][1] * ey)];
  const apply = (p) => ({
    x: matrix[0][0] * getX(p) + matrix[0][1] * getY(p) + translation[0],
    y: matrix[1][0] * getX(p) + matrix[1][1] * getY(p) + translation[1],
  });
  const aligned = [];
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const p = apply(est[i]);
    aligned.push(p);
    sq += (p.x - getX(truth[i])) ** 2 + (p.y - getY(truth[i])) ** 2;
  }
  return { rotation, angle, reflected, scale, translation, matrix, aligned, rmse: n ? Math.sqrt(sq / n) : 0, apply };
}

/** Quantil (0..1) de uma lista de números, com interpolação. */
export function quantile(values, q) {
  if (!values.length) return null;
  const v = values.slice().sort((p, r) => p - r);
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

const median = (values) => quantile(values, 0.5);
const mean = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Confiabilidade e continuidade (Venna & Kaski), entre 0 e 1.
 * - confiabilidade (trust): os vizinhos na ESTIMATIVA são vizinhos de verdade?
 * - continuidade: os vizinhos de VERDADE continuam vizinhos na estimativa?
 * Varreduras feitas no mesmo ponto empatam na distância: os empatados dividem o melhor posto
 * do grupo (todos contam como vizinhos). Na estimativa isso só vale para grupos pequenos (até k);
 * um empate em massa é desempatado pelo índice, para que juntar tudo num ponto não saia de graça.
 */
export function trustContinuity(est, truth, k = NEIGHBOURS) {
  const n = Math.min(est.length, truth.length);
  if (n < 2 * k + 2) return { trust: null, continuity: null };
  const dist = (pts, i, j) => Math.hypot(getX(pts[i]) - getX(pts[j]), getY(pts[i]) - getY(pts[j]));
  let trustSum = 0;
  let contSum = 0;
  const order = new Array(n - 1);
  const rankEst = new Float64Array(n);
  const rankTruth = new Float64Array(n);
  const de = new Float64Array(n);
  const dt = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0, m = 0; j < n; j++) {
      de[j] = dist(est, i, j);
      dt[j] = dist(truth, i, j);
      if (j !== i) order[m++] = j;
    }
    // Estimativa: posto pela ordem (distância, índice); empates pequenos dividem o posto.
    order.sort((p, q) => de[p] - de[q] || p - q);
    for (let r = 0; r < order.length; ) {
      let end = r + 1;
      while (end < order.length && de[order[end]] - de[order[r]] < 1e-9) end++;
      const share = end - r <= k;
      for (let q = r; q < end; q++) rankEst[order[q]] = share ? r + 1 : q + 1;
      r = end;
    }
    // Verdade: pontos empatados dividem o melhor posto do grupo.
    order.sort((p, q) => dt[p] - dt[q] || p - q);
    for (let r = 0; r < order.length; r++) {
      const j = order[r];
      rankTruth[j] = r > 0 && dt[j] - dt[order[r - 1]] < 1e-9 ? rankTruth[order[r - 1]] : r + 1;
    }
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (rankEst[j] <= k && rankTruth[j] > k) trustSum += rankTruth[j] - k;
      if (rankTruth[j] <= k && rankEst[j] > k) contSum += rankEst[j] - k;
    }
  }
  const norm = 2 / (n * k * (2 * n - 3 * k - 1));
  return { trust: Math.max(0, 1 - norm * trustSum), continuity: Math.max(0, 1 - norm * contSum) };
}

function validSolution(solution, count) {
  if (!solution || !Array.isArray(solution.points) || solution.points.length !== count) return false;
  for (const p of solution.points) if (!p || !isNum(p.x) || !isNum(p.y) || !isNum(p.z)) return false;
  if (solution.aps != null && typeof solution.aps !== 'object') return false;
  for (const ap of Object.values(solution.aps || {})) if (!ap || !isNum(ap.x) || !isNum(ap.y) || !isNum(ap.z)) return false;
  return true;
}

/** Resultado de uma execução que não serve: todas as medidas vazias e a nota fixa de falha. */
export function failure(reason, runtimeMs = null) {
  return {
    ok: false,
    error: reason,
    finite: false,
    score: FAIL_SCORE,
    rmseRigid: null,
    medianRigid: null,
    p90Rigid: null,
    rmseSim: null,
    medianSim: null,
    scaleRatio: null,
    apErrOwn: null,
    apErrNear: null,
    apFloorOwn: null,
    trust: null,
    continuity: null,
    roomPurity: null,
    floorOk: false,
    runtimeMs,
  };
}

/**
 * Mede uma solução contra a verdade.
 *
 * Nota (`score`, quanto MENOR melhor; 0 = perfeito; 100 = tão ruim quanto juntar todos os
 * pontos num lugar só; teto 200, que é também a nota fixa de falha):
 *
 *   score = 100 · [ 0,55 · medianRigid / R50  +  0,20 · p90Rigid / R90  +  0,15 · medianSim / R50
 *                   +  0,10 · min(1, |log2(scaleRatio)|) ]
 *
 * com cada razão de erro limitada a 2. R50 e R90 são a mediana e o percentil 90 da distância dos
 * pontos verdadeiros ao seu centro: exatamente o erro de quem "responde" com um ponto só. Assim a
 * nota vale igual numa kitnet e num escritório, e uma solução degenerada ou aleatória fica em ~100
 * ou pior. O último termo cobra o tamanho do mapa (metade ou o dobro do real = punição cheia): sem
 * ele, encolher uma solução ruidosa em direção ao centro renderia alguns pontos de graça.
 *
 * @param {import('../../app/js/mapping/types.js').MapSolution} solution
 * @param {Object} truth    o que simulateSurvey devolve em `truth`
 * @param {import('../../app/js/mapping/types.js').Survey} survey
 * @param {{runtimeMs?: number}} [extra]
 */
export function evaluate(solution, truth, survey, extra = {}) {
  const runtimeMs = extra.runtimeMs ?? null;
  const n = survey.scans.length;
  if (!validSolution(solution, n)) return failure('saída inválida (pontos faltando, tamanho errado ou valor não finito)', runtimeMs);
  const world = truth.world;
  const est = solution.points;
  const real = truth.points;

  // --- erro de posição ---
  const rigid = procrustes(est, real, { scale: false });
  const sim = procrustes(est, real, { scale: true });
  const errOf = (fit) => fit.aligned.map((p, i) => Math.hypot(p.x - real[i].x, p.y - real[i].y));
  const errRigid = errOf(rigid);
  const errSim = errOf(sim);

  // Tamanho estimado / tamanho real (raio quadrático médio em torno do centro).
  const radius = (pts) => {
    const cx = mean(pts.map(getX));
    const cy = mean(pts.map(getY));
    return Math.sqrt(mean(pts.map((p) => (getX(p) - cx) ** 2 + (getY(p) - cy) ** 2)));
  };
  const realRadius = radius(real);
  const scaleRatio = realRadius > 1e-9 ? radius(est) / realRadius : null;

  // Referência: erro de quem coloca tudo no centro.
  const cx = mean(real.map(getX));
  const cy = mean(real.map(getY));
  const fromCentre = real.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const ref50 = Math.max(0.25, median(fromCentre));
  const ref90 = Math.max(0.25, quantile(fromCentre, 0.9));

  // --- roteadores (mesmo alinhamento dos pontos, sem ajuste separado) ---
  const ownErr = [];
  const nearErr = [];
  let ownFloorOk = 0;
  let ownCount = 0;
  const startFloor = truth.startFloor ?? 0;
  for (const [bssid, pos] of Object.entries(truth.aps)) {
    if (!survey.aps[bssid]) continue; // nunca apareceu: o solucionador não tem como saber dele
    const ap = world.ap(bssid);
    let nearest = Infinity;
    for (const p of real) nearest = Math.min(nearest, Math.hypot(p.x - pos.x, p.y - pos.y));
    const isOwn = !!(ap && ap.own);
    if (!isOwn && nearest > 8) continue;
    const guess = solution.aps ? solution.aps[bssid] : null;
    let err = AP_MISSING_M;
    if (guess) {
      const g = rigid.apply(guess);
      err = Math.hypot(g.x - pos.x, g.y - pos.y);
    }
    if (isOwn) {
      ownErr.push(err);
      ownCount++;
      const realFloor = Math.floor(pos.z / FLOOR_HEIGHT) - startFloor;
      if (guess && Math.floor((guess.z + 1e-6) / FLOOR_HEIGHT) === realFloor) ownFloorOk++;
    }
    if (nearest <= 8) nearErr.push(err);
  }

  // --- vizinhança ---
  const { trust, continuity } = trustContinuity(est, real, NEIGHBOURS);

  // --- cômodo certo? ---
  let roomHits = 0;
  let roomTotal = 0;
  for (let i = 0; i < n; i++) {
    const floor = truth.floors ? truth.floors[i] : Math.max(0, Math.floor(real[i].z / FLOOR_HEIGHT));
    const realRoom = world.roomAt(real[i].x, real[i].y, floor);
    if (!realRoom) continue; // em cima de uma porta ou na escada: não conta
    roomTotal++;
    const p = rigid.aligned[i];
    let guess = world.roomAt(p.x, p.y, floor);
    if (!guess) {
      // Caiu fora da planta: vale o cômodo de centro mais próximo.
      let best = Infinity;
      for (const r of world.roomsOn(floor)) {
        const d = Math.hypot(r.centroid.x - p.x, r.centroid.y - p.y);
        if (d < best) {
          best = d;
          guess = r;
        }
      }
    }
    if (guess && guess.index === realRoom.index) roomHits++;
  }

  // --- andar (z = andar marcado · FLOOR_HEIGHT, pelo contrato) ---
  let floorOk = true;
  for (let i = 0; i < n; i++) {
    if (Math.abs(est[i].z - survey.scans[i].floor * FLOOR_HEIGHT) > FLOOR_HEIGHT / 2) floorOk = false;
  }

  const medianRigid = median(errRigid);
  const p90Rigid = quantile(errRigid, 0.9);
  const medianSim = median(errSim);
  const sizeError = scaleRatio > 0 ? Math.min(1, Math.abs(Math.log2(scaleRatio))) : 1;
  const score =
    100 *
    (0.55 * Math.min(2, medianRigid / ref50) +
      0.2 * Math.min(2, p90Rigid / ref90) +
      0.15 * Math.min(2, medianSim / ref50) +
      0.1 * sizeError);

  return {
    ok: true,
    error: null,
    finite: true,
    score,
    rmseRigid: rigid.rmse,
    medianRigid,
    p90Rigid,
    rmseSim: sim.rmse,
    medianSim,
    scaleRatio,
    apErrOwn: ownErr.length ? median(ownErr) : null,
    apErrNear: nearErr.length ? median(nearErr) : null,
    apFloorOwn: ownCount ? ownFloorOk / ownCount : null,
    trust,
    continuity,
    roomPurity: roomTotal ? roomHits / roomTotal : null,
    floorOk,
    runtimeMs,
    ref50,
    ref90,
  };
}

/** Medidas numéricas resumidas por aggregate(). */
export const METRICS = [
  'score',
  'rmseRigid',
  'medianRigid',
  'p90Rigid',
  'rmseSim',
  'medianSim',
  'scaleRatio',
  'apErrOwn',
  'apErrNear',
  'apFloorOwn',
  'trust',
  'continuity',
  'roomPurity',
  'runtimeMs',
];

/**
 * Junta os resultados de vários cenários.
 * `score` = média das notas (falhas entram com FAIL_SCORE); as demais medidas ignoram as falhas.
 * @param {ReturnType<typeof evaluate>[]} list
 */
export function aggregate(list) {
  const out = {
    count: list.length,
    failures: list.filter((r) => !r.ok).length,
    floorErrors: list.filter((r) => r.ok && !r.floorOk).length,
    score: list.length ? mean(list.map((r) => (isNum(r.score) ? r.score : FAIL_SCORE))) : null,
    mean: {},
    median: {},
  };
  for (const key of METRICS) {
    const values = list.map((r) => r[key]).filter(isNum);
    out.mean[key] = mean(values);
    out.median[key] = median(values);
  }
  return out;
}
