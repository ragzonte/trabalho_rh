// Solucionadores de referência da bancada do mapa 3D.
//
//   solveMds          a base ingênua: escalonamento multidimensional clássico sobre a distância
//                     entre impressões digitais de Wi-Fi. É a barra a superar.
//   solveOracle       teto "de trapaça": conhece a posição REAL dos roteadores e ajusta a curva de
//                     cada um com a posição real das varreduras; depois localiza cada varredura por
//                     trilateração. Mostra o que o modelo "sinal cai com a distância" consegue no melhor caso.
//   solveOracleField  teto mais alto ainda: conhece o mapa de rádio REAL (paredes e sombra incluídas)
//                     e ainda usa o fato de que ninguém anda mais que ~1 m/s. É o limite físico.
//   solveCollapse     todos os pontos na origem: a resposta de quem não sabe nada (nota 100).
//
// Os dois oráculos recebem a verdade em `options.truth`, que a bancada só entrega a este arquivo.

import { FLOOR_HEIGHT } from '../../app/js/mapping/types.js';

const MISSING_DBM = -95; // nível assumido para um roteador que não apareceu na varredura
const DB_TO_M = 0.45; // fator fixo: 1 dB de diferença média entre impressões digitais = 0,45 m
const FRESH_MS = 3500; // leitura mais velha que isto é repetição do Android

// ---------------------------------------------------------------------------
// Base ingênua: MDS clássico
// ---------------------------------------------------------------------------

/** @type {(survey: import('../../app/js/mapping/types.js').Survey) => import('../../app/js/mapping/types.js').MapSolution} */
export function solveMds(survey) {
  const scans = survey.scans;
  const n = scans.length;
  const ids = Object.keys(survey.aps);
  const col = new Map(ids.map((id, k) => [id, k]));
  const K = ids.length;

  // Impressão digital de cada varredura: um nível por roteador (NaN = não apareceu).
  const fp = scans.map((s) => {
    const v = new Float64Array(K).fill(NaN);
    for (const r of s.readings) if (col.has(r.id)) v[col.get(r.id)] = r.rssi;
    return v;
  });

  // Distância entre duas varreduras: diferença quadrática média, em dB, convertida em metros.
  const D2 = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let sum = 0;
      let used = 0;
      for (let k = 0; k < K; k++) {
        const a = fp[i][k];
        const b = fp[j][k];
        if (Number.isNaN(a) && Number.isNaN(b)) continue;
        const d = (Number.isNaN(a) ? MISSING_DBM : a) - (Number.isNaN(b) ? MISSING_DBM : b);
        sum += d * d;
        used++;
      }
      const metres = used ? Math.sqrt(sum / used) * DB_TO_M : 0;
      D2[i * n + j] = D2[j * n + i] = metres * metres;
    }
  }
  const xy = classicalMds(D2, n);

  const points = scans.map((s, i) => ({ x: xy[i][0], y: xy[i][1], z: s.floor * FLOOR_HEIGHT, conf: 0.3 }));

  // Roteador: centro dos pontos onde ele chegou mais forte.
  const aps = {};
  for (const id of ids) {
    const seen = [];
    scans.forEach((s, i) => {
      const r = s.readings.find((q) => q.id === id);
      if (r) seen.push({ rssi: r.rssi, i });
    });
    if (!seen.length) continue;
    seen.sort((p, q) => q.rssi - p.rssi);
    const top = seen.slice(0, 5);
    let w = 0;
    let x = 0;
    let y = 0;
    for (const t of top) {
      const wt = 10 ** (t.rssi / 20);
      w += wt;
      x += wt * points[t.i].x;
      y += wt * points[t.i].y;
    }
    aps[id] = { x: x / w, y: y / w, z: points[top[0].i].z + 1, p0: top[0].rssi + 3, n: 2.5, conf: 0.2 };
  }
  return { points, aps, scaleConf: 0.1 };
}

// MDS clássico: centra a matriz de distâncias ao quadrado e fica com os dois maiores
// autovetores (iteração de subespaço; não precisa de biblioteca).
function classicalMds(D2, n) {
  if (n === 0) return [];
  if (n === 1) return [[0, 0]];
  const rowMean = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += D2[i * n + j];
    rowMean[i] = s / n;
    total += s;
  }
  total /= n * n;
  const B = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) B[i * n + j] = -0.5 * (D2[i * n + j] - rowMean[i] - rowMean[j] + total);
  }
  // Partida determinística (nada de Math.random: a bancada tem de repetir o resultado).
  let q1 = Float64Array.from({ length: n }, (_, i) => Math.sin(1.7 * i + 0.3));
  let q2 = Float64Array.from({ length: n }, (_, i) => Math.cos(2.9 * i + 1.1));
  const mul = (v) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const row = i * n;
      for (let j = 0; j < n; j++) s += B[row + j] * v[j];
      out[i] = s;
    }
    return out;
  };
  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  };
  const normalize = (v) => {
    const len = Math.sqrt(dot(v, v)) || 1;
    for (let i = 0; i < n; i++) v[i] /= len;
  };
  for (let it = 0; it < 150; it++) {
    q1 = mul(q1);
    normalize(q1);
    q2 = mul(q2);
    const p = dot(q1, q2);
    for (let i = 0; i < n; i++) q2[i] -= p * q1[i];
    normalize(q2);
  }
  const l1 = Math.max(0, dot(q1, mul(q1)));
  const l2 = Math.max(0, dot(q2, mul(q2)));
  const s1 = Math.sqrt(l1);
  const s2 = Math.sqrt(l2);
  return Array.from({ length: n }, (_, i) => [q1[i] * s1, q2[i] * s2]);
}

/** Resposta de quem não sabe nada: tudo na origem. */
export function solveCollapse(survey) {
  return {
    points: survey.scans.map((s) => ({ x: 0, y: 0, z: s.floor * FLOOR_HEIGHT, conf: 0 })),
    aps: Object.fromEntries(Object.keys(survey.aps).map((id) => [id, { x: 0, y: 0, z: 1, p0: -40, n: 2.5, conf: 0 }])),
    scaleConf: 0,
  };
}

// ---------------------------------------------------------------------------
// Oráculo 1: posição real dos roteadores + curva ajustada por roteador
// ---------------------------------------------------------------------------

function needTruth(options) {
  const truth = options && options.truth;
  if (!truth || !truth.points || !truth.aps) {
    throw new Error('o oráculo precisa da verdade: rode pela bancada com --solver tests/mapping/baseline.mjs');
  }
  return truth;
}

/** @type {(survey: import('../../app/js/mapping/types.js').Survey, options: {truth: Object}) => import('../../app/js/mapping/types.js').MapSolution} */
export function solveOracle(survey, options) {
  const truth = needTruth(options);
  const scans = survey.scans;
  const startFloor = truth.startFloor ?? 0;
  // Altura real do celular em cada varredura (o andar marcado é relativo ao andar de partida).
  const phoneZ = (s) => (s.floor + startFloor) * FLOOR_HEIGHT + 1.2;

  // Curva de cada roteador: rssi = p0 - 10 n log10(d), ajustada com as distâncias REAIS.
  const model = {};
  for (const id of Object.keys(survey.aps)) {
    const ap = truth.aps[id];
    if (!ap) continue;
    const xs = [];
    const ys = [];
    scans.forEach((s, i) => {
      const r = s.readings.find((q) => q.id === id);
      if (!r || (r.ageMs ?? 0) > FRESH_MS) return;
      const p = truth.points[i];
      xs.push(Math.log10(Math.max(0.5, Math.hypot(p.x - ap.x, p.y - ap.y, p.z - ap.z))));
      ys.push(r.rssi);
    });
    if (xs.length < 3) continue;
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < xs.length; i++) {
      sxx += (xs[i] - mx) ** 2;
      sxy += (xs[i] - mx) * (ys[i] - my);
    }
    // Roteador distante: a distância quase não muda ao longo da casa e a inclinação não se sustenta.
    let n = sxx / xs.length > 0.004 && xs.length >= 8 ? -sxy / sxx / 10 : 3;
    n = Math.max(1, Math.min(6, n));
    const p0 = my + 10 * n * mx;
    let res = 0;
    for (let i = 0; i < xs.length; i++) res += (ys[i] - (p0 - 10 * n * xs[i])) ** 2;
    const sigma = Math.max(2, Math.min(8, Math.sqrt(res / Math.max(1, xs.length - 2))));
    model[id] = { ...ap, p0, n, sigma };
  }

  // Área de busca: onde o usuário andou, com folga.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of truth.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = 1.5;

  const points = scans.map((s) => {
    const z = phoneZ(s);
    const obs = s.readings.filter((r) => model[r.id] && (r.ageMs ?? 0) <= FRESH_MS).map((r) => ({ r: r.rssi, m: model[r.id] }));
    const cost = (x, y) => {
      let c = 0;
      for (const o of obs) {
        const d = Math.max(0.5, Math.hypot(x - o.m.x, y - o.m.y, z - o.m.z));
        const e = (o.r - (o.m.p0 - 10 * o.m.n * Math.log10(d))) / o.m.sigma;
        c += e * e;
      }
      return c;
    };
    // Busca em grade, do grosso para o fino.
    let best = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, c: Infinity };
    let span = [minX - pad, maxX + pad, minY - pad, maxY + pad];
    for (const step of [0.5, 0.1, 0.02]) {
      for (let x = span[0]; x <= span[1] + 1e-9; x += step) {
        for (let y = span[2]; y <= span[3] + 1e-9; y += step) {
          const c = cost(x, y);
          if (c < best.c) best = { x, y, c };
        }
      }
      span = [best.x - step, best.x + step, best.y - step, best.y + step];
    }
    return { x: best.x, y: best.y, z: s.floor * FLOOR_HEIGHT, conf: obs.length >= 3 ? 1 : 0.3 };
  });

  const aps = {};
  for (const [id, m] of Object.entries(model)) {
    aps[id] = { x: m.x, y: m.y, z: m.z - startFloor * FLOOR_HEIGHT, p0: m.p0, n: m.n, conf: 1 };
  }
  return { points, aps, scaleConf: 1 };
}

// ---------------------------------------------------------------------------
// Oráculo 2: mapa de rádio real + limite de velocidade (o teto físico)
// ---------------------------------------------------------------------------

/**
 * Conhece o sinal médio REAL de cada roteador em cada canto da casa e sabe que o usuário
 * não anda mais que ~1 m/s. Estima cada posição pela média da distribuição a posteriori
 * (algoritmo forward-backward numa grade de 0,5 m). Nenhum solucionador honesto chega aqui:
 * serve para saber quanto do erro é ruído de medição e quanto é falta de método.
 */
export function solveOracleField(survey, options) {
  const truth = needTruth(options);
  const world = truth.world;
  if (!world) throw new Error('solveOracleField precisa do mundo simulado (truth.world)');
  const scans = survey.scans;
  const startFloor = truth.startFloor ?? 0;
  const CELL = 0.5;
  const SIGMA = 3.2; // desvanecimento + ruído + corpo, em dB
  const BODY_BIAS = 1.2; // em média o corpo tira um pouco de sinal
  const V_MAX = 1.0;

  // Células pisáveis de cada andar e o sinal médio de cada roteador em cada uma.
  const ids = Object.keys(survey.aps).filter((id) => world.ap(id));
  const cellsByFloor = [];
  for (let f = 0; f < world.floors; f++) {
    const cells = [];
    for (let x = world.bounds.minX + CELL / 2; x < world.bounds.maxX; x += CELL) {
      for (let y = world.bounds.minY + CELL / 2; y < world.bounds.maxY; y += CELL) {
        if (!world.isFree(x, y, f, 0.1)) continue;
        const pos = { x, y, z: world.phoneZ(f) };
        cells.push({ x, y, mean: Float64Array.from(ids, (id) => world.meanRssi(world.ap(id), pos) - BODY_BIAS) });
      }
    }
    cellsByFloor.push(cells);
  }
  const col = new Map(ids.map((id, k) => [id, k]));

  // Verossimilhança de cada varredura em cada célula do seu andar.
  const steps = scans.map((s) => {
    const floor = Math.max(0, Math.min(world.floors - 1, s.floor + startFloor));
    const cells = cellsByFloor[floor];
    const seen = new Float64Array(ids.length).fill(NaN);
    for (const r of s.readings) if (col.has(r.id) && (r.ageMs ?? 0) <= FRESH_MS) seen[col.get(r.id)] = r.rssi;
    const logp = new Float64Array(cells.length);
    for (let c = 0; c < cells.length; c++) {
      let lp = 0;
      for (let k = 0; k < ids.length; k++) {
        const m = cells[c].mean[k];
        if (Number.isNaN(seen[k])) {
          // Não apareceu: improvável onde o sinal dele é forte.
          const z = (m + 89) / 4;
          lp += Math.log(Math.max(0.03, 1 - 1 / (1 + Math.exp(-1.7 * z))));
        } else {
          const e = (seen[k] - m) / SIGMA;
          lp -= 0.5 * e * e;
        }
      }
      logp[c] = lp;
    }
    let top = -Infinity;
    for (const v of logp) if (v > top) top = v;
    const like = Float64Array.from(logp, (v) => Math.exp(v - top));
    return { floor, cells, like };
  });

  // Transição: de uma varredura à seguinte só se chega até onde as pernas alcançam.
  const propagate = (from, to, weights, dt) => {
    const out = new Float64Array(to.cells.length);
    const reach = V_MAX * Math.abs(dt) + CELL;
    if (from.floor !== to.floor) return out.fill(1); // mudou de andar: sem restrição
    for (let i = 0; i < from.cells.length; i++) {
      const w = weights[i];
      if (w < 1e-12) continue;
      const a = from.cells[i];
      for (let j = 0; j < to.cells.length; j++) {
        const b = to.cells[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy <= reach * reach) out[j] += w;
      }
    }
    return out;
  };
  const normalise = (v) => {
    let s = 0;
    for (const x of v) s += x;
    if (s <= 0) return v.fill(1 / v.length);
    for (let i = 0; i < v.length; i++) v[i] /= s;
    return v;
  };

  const n = scans.length;
  const alpha = new Array(n);
  const beta = new Array(n);
  alpha[0] = normalise(Float64Array.from(steps[0].like));
  for (let i = 1; i < n; i++) {
    const pred = propagate(steps[i - 1], steps[i], alpha[i - 1], scans[i].t - scans[i - 1].t);
    alpha[i] = normalise(pred.map((v, j) => v * steps[i].like[j]));
  }
  beta[n - 1] = new Float64Array(steps[n - 1].cells.length).fill(1);
  for (let i = n - 2; i >= 0; i--) {
    const msg = Float64Array.from(beta[i + 1], (v, j) => v * steps[i + 1].like[j]);
    beta[i] = normalise(propagate(steps[i + 1], steps[i], msg, scans[i + 1].t - scans[i].t));
  }

  const points = scans.map((s, i) => {
    const post = normalise(alpha[i].map((v, j) => v * beta[i][j]));
    let x = 0;
    let y = 0;
    let peak = 0;
    for (let j = 0; j < post.length; j++) {
      x += post[j] * steps[i].cells[j].x;
      y += post[j] * steps[i].cells[j].y;
      if (post[j] > peak) peak = post[j];
    }
    return { x, y, z: s.floor * FLOOR_HEIGHT, conf: Math.min(1, peak * 4) };
  });
  const aps = {};
  for (const id of ids) {
    const a = world.ap(id);
    aps[id] = { x: a.x, y: a.y, z: a.z - startFloor * FLOOR_HEIGHT, p0: a.p0, n: a.n, conf: 1 };
  }
  return { points, aps, scaleConf: 1 };
}

/** Padrão quando a bancada recebe este arquivo sem --export: a base ingênua. */
export const solve = solveMds;
