// Solucionador "hybrid" do mapa 3D só com Wi-Fi (candidato do torneio).
//
// v0: preparação + geometria grossa (MDS sobre distância entre impressões digitais) + escala pelo passo.

import { FLOOR_HEIGHT } from '../types.js';

const FRESH_MS = 3300; // leitura mais velha que isto é repetição do Android (descreve um lugar anterior)
const SWEEP_MID_S = 1.3; // a posição da varredura vale no meio da varredura, ~1,3 s antes da entrega

const DEFAULTS = {
  smoothW: 0.5, // peso dos vizinhos no tempo ao suavizar a impressão digital de quem está andando
  distPow: 1, // 1 = distância ~ sqrt(D²); 2 = distância ~ D² (variograma linear)
  floorFrac: 0.8, // fração do piso de ruído descontada de D²
  chordSpeed: 0.45, // corda média entre varreduras consecutivas de quem anda (m/s)
  speedSigma: 0.2, // largura da distribuição da corda (m/s)
  vMax: 1.2, // ninguém anda mais que isto fazendo o levantamento (m/s)
  iters: 6, // voltas de "aprende os campos -> relocaliza"
  kernelH: 1.3, // largura do núcleo espacial dos campos (m)
  kernelH0: 2.2, // largura na primeira volta (vai fechando até kernelH)
  lambda: 0.5, // encolhimento do resíduo onde há poucos dados (em "leituras equivalentes")
  sigmaNoise: 3.5, // ruído de uma leitura (dB), valor de partida
  sigmaField: 5, // amplitude do resíduo do campo em torno da lei de distância (dB)
  looWindowS: 9, // ao relocalizar uma varredura, ignora as leituras a menos disto dela no tempo
  maxCells: 1400,
  gridMargin: 2.5,
  zCap: 3, // resíduo (em desvios) a partir do qual a leitura é tratada como aberrante
  pauseProb: 0.08,
};

/**
 * @param {import('../types.js').Survey} survey
 * @param {{seed?: number, budgetMs?: number, onProgress?: Function, tune?: Object}} [options]
 * @returns {import('../types.js').MapSolution}
 */
export function solve(survey, options = {}) {
  try {
    return solveSurvey(survey, options || {});
  } catch (err) {
    return fallbackSolution(survey, err);
  }
}

function fallbackSolution(survey, err) {
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : [];
  return {
    points: scans.map((s) => ({ x: 0, y: 0, z: (Number.isFinite(s && s.floor) ? s.floor : 0) * FLOOR_HEIGHT, conf: 0 })),
    aps: {},
    scaleConf: 0,
    debug: { error: String((err && err.stack) || err) },
  };
}

function solveSurvey(survey, options) {
  const T = { ...DEFAULTS, ...(options.tune || {}) };
  const prep = prepare(survey);
  const { nodes, N } = prep;
  const stages = {};
  if (N === 0) return fallbackSolution(survey, 'sem varreduras');

  const M = nodes.length;
  let X = coarseEmbedding(prep, T);
  const scale = stepScale(prep, X, T);
  for (let a = 0; a < M; a++) {
    X[a][0] *= scale.factor;
    X[a][1] *= scale.factor;
  }
  stages.coarse = nodePointsToScans(prep, X);
  if (T.initTruth) X = nodes.map((nd) => [T.initTruth[nd.scans[0]].x, T.initTruth[nd.scans[0]].y]); // só diagnóstico

  const model = buildModel(prep);
  let fit = null;
  for (let it = 0; it < T.iters; it++) {
    const frac = T.iters > 1 ? it / (T.iters - 1) : 1;
    const h = T.kernelH0 + (T.kernelH - T.kernelH0) * Math.min(1, frac * 1.5);
    fit = relocalise(model, X, h, T);
    X = fit.X;
    if (it === 0 || it === 2 || it === T.iters - 1) stages[`it${it + 1}`] = nodePointsToScans(prep, X);
  }

  const pts = nodePointsToScans(prep, X);
  const points = pts.map((p, i) => ({ x: p.x, y: p.y, z: prep.floor[i] * FLOOR_HEIGHT, conf: 0.3 }));
  return { points, aps: {}, scaleConf: 0.3, debug: { stages, info: { scale: scale.info, sigma: fit ? fit.sigmaMean : null } } };
}

// ---------------------------------------------------------------------------
// Preparação
// ---------------------------------------------------------------------------

function prepare(survey) {
  const scans = Array.isArray(survey.scans) ? survey.scans : [];
  const N = scans.length;
  const meta = survey.aps || {};
  // Rádio = aparelho + faixa: as redes de um mesmo rádio (principal e convidados) medem o mesmo campo.
  const radioIndex = new Map();
  const radios = [];
  const radioOfId = new Map();
  const bandOf = (freq) => (freq < 3000 ? 0 : freq < 5925 ? 1 : 2);
  const radioFor = (id, freq) => {
    let k = radioOfId.get(id);
    if (k !== undefined) return k;
    const m = meta[id];
    const f = (m && m.freq) || freq || 2437;
    const key = `${(m && m.device) || id}|${bandOf(f)}`;
    k = radioIndex.get(key);
    if (k === undefined) {
      k = radios.length;
      radioIndex.set(key, k);
      radios.push({ key, device: (m && m.device) || id, band: bandOf(f), freq: f, ids: [] });
    }
    radios[k].ids.push(id);
    radioOfId.set(id, k);
    return k;
  };
  const t = new Float64Array(N);
  const floor = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const s = scans[i] || {};
    t[i] = Number.isFinite(s.t) ? s.t : i > 0 ? t[i - 1] + 3.5 : 0;
    floor[i] = Number.isFinite(s.floor) ? Math.round(s.floor) : 0;
    for (const r of s.readings || []) if (r && Number.isFinite(r.rssi)) radioFor(r.id, r.freq);
  }
  const K = radios.length;
  const obs = new Float64Array(N * K).fill(NaN); // média das leituras frescas do rádio na varredura
  const stale = new Float64Array(N * K).fill(NaN); // nível antigo repetido (não ouvido agora)
  let lowest = -80;
  for (let i = 0; i < N; i++) {
    const s = scans[i] || {};
    const sum = new Float64Array(K);
    const cnt = new Int32Array(K);
    for (const r of s.readings || []) {
      if (!r || !Number.isFinite(r.rssi)) continue;
      const k = radioOfId.get(r.id);
      if ((r.ageMs ?? 0) <= FRESH_MS) {
        sum[k] += r.rssi;
        cnt[k]++;
        if (r.rssi < lowest) lowest = r.rssi;
      } else stale[i * K + k] = r.rssi;
    }
    for (let k = 0; k < K; k++) if (cnt[k]) obs[i * K + k] = sum[k] / cnt[k];
  }
  const missLevel = Math.max(-97, Math.min(-88, lowest + 1)); // abaixo disto o celular não ouve

  // Nó = uma posição a descobrir: varreduras seguidas no mesmo ponto marcado viram um nó só.
  const nodes = [];
  const nodeOf = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const s = scans[i] || {};
    const spot = s.spot == null ? null : s.spot;
    const last = nodes[nodes.length - 1];
    if (spot != null && last && last.spot === spot && last.floor === floor[i]) {
      last.scans.push(i);
    } else {
      nodes.push({ scans: [i], spot, floor: floor[i], still: !!s.still });
    }
    nodeOf[i] = nodes.length - 1;
  }
  for (const nd of nodes) {
    let st = 0;
    for (const i of nd.scans) st += t[i] - SWEEP_MID_S;
    nd.t = st / nd.scans.length;
    nd.t0 = t[nd.scans[0]] - SWEEP_MID_S;
    nd.t1 = t[nd.scans[nd.scans.length - 1]] - SWEEP_MID_S;
  }
  return { scans, N, K, radios, t, floor, obs, stale, missLevel, nodes, nodeOf };
}

// Impressão digital de cada nó: média das varreduras do nó; rádio ausente = nível de corte
// (ou "não sei" quando os vizinhos no tempo o ouvem forte: foi beacon perdido, não sinal fraco).
function nodeFingerprints(prep, T) {
  const { N, K, obs, nodes, t, missLevel, floor } = prep;
  const filled = new Float64Array(N * K);
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < K; k++) {
      let v = obs[i * K + k];
      if (Number.isNaN(v)) {
        let near = -Infinity;
        for (const j of [i - 1, i + 1]) {
          if (j < 0 || j >= N || Math.abs(t[j] - t[i]) > 6) continue;
          const u = obs[j * K + k];
          if (!Number.isNaN(u) && u > near) near = u;
        }
        v = near > missLevel + 9 ? NaN : missLevel;
      }
      filled[i * K + k] = v;
    }
  }
  const M = nodes.length;
  const fp = new Float64Array(M * K);
  for (let a = 0; a < M; a++) {
    for (let k = 0; k < K; k++) {
      let s = 0;
      let c = 0;
      for (const i of nodes[a].scans) {
        const v = filled[i * K + k];
        if (!Number.isNaN(v)) {
          s += v;
          c++;
        }
      }
      fp[a * K + k] = c ? s / c : NaN;
    }
  }
  // Suavização no tempo para quem está andando: tira ruído à custa de borrar ~1 passo.
  const w = T.smoothW;
  if (w > 0) {
    const out = new Float64Array(M * K);
    for (let a = 0; a < M; a++) {
      for (let k = 0; k < K; k++) {
        let s = 0;
        let c = 0;
        const v = fp[a * K + k];
        const selfW = nodes[a].scans.length;
        if (!Number.isNaN(v)) {
          s += selfW * v;
          c += selfW;
        }
        for (const b of [a - 1, a + 1]) {
          if (b < 0 || b >= M || nodes[b].floor !== nodes[a].floor) continue;
          const gap = b < a ? nodes[a].t0 - nodes[b].t1 : nodes[b].t0 - nodes[a].t1;
          if (gap > 5) continue;
          const u = fp[b * K + k];
          if (Number.isNaN(u)) continue;
          const wb = w * (nodes[a].spot != null ? 0.5 : 1);
          s += wb * u;
          c += wb;
        }
        out[a * K + k] = c ? s / c : NaN;
      }
    }
    return out;
  }
  return fp;
}

// ---------------------------------------------------------------------------
// Geometria grossa
// ---------------------------------------------------------------------------

function coarseEmbedding(prep, T) {
  const { K, nodes } = prep;
  const M = nodes.length;
  if (M === 1) return [[0, 0]];
  const fp = nodeFingerprints(prep, T);
  // Desconto por andar: a laje muda o nível de cada rádio; tira-se a média de cada (rádio, andar).
  const floors = [...new Set(nodes.map((nd) => nd.floor))];
  if (floors.length > 1) {
    for (let k = 0; k < K; k++) {
      let gs = 0;
      let gc = 0;
      const fs = new Map();
      for (let a = 0; a < M; a++) {
        const v = fp[a * K + k];
        if (Number.isNaN(v)) continue;
        gs += v;
        gc++;
        const e = fs.get(nodes[a].floor) || [0, 0];
        e[0] += v;
        e[1]++;
        fs.set(nodes[a].floor, e);
      }
      if (!gc) continue;
      for (let a = 0; a < M; a++) {
        const e = fs.get(nodes[a].floor);
        if (e && e[1]) fp[a * K + k] -= e[0] / e[1] - gs / gc;
      }
    }
  }
  const D2 = new Float64Array(M * M);
  for (let a = 0; a < M; a++) {
    for (let b = a + 1; b < M; b++) {
      let s = 0;
      let c = 0;
      for (let k = 0; k < K; k++) {
        const u = fp[a * K + k];
        const v = fp[b * K + k];
        if (Number.isNaN(u) || Number.isNaN(v)) continue;
        s += (u - v) * (u - v);
        c++;
      }
      D2[a * M + b] = D2[b * M + a] = c ? s / c : 0;
    }
  }
  // Piso de ruído: o menor nível típico de D² entre vizinhos no tempo.
  const lag1 = [];
  for (let a = 0; a + 1 < M; a++) lag1.push(D2[a * M + a + 1]);
  lag1.sort((p, q) => p - q);
  const floorD2 = lag1.length ? lag1[Math.floor(lag1.length * 0.2)] * T.floorFrac : 0;
  const E2 = new Float64Array(M * M);
  for (let i = 0; i < M * M; i++) {
    const d2 = Math.max(0, D2[i] - floorD2);
    const d = T.distPow === 2 ? d2 : Math.sqrt(d2);
    E2[i] = d * d;
  }
  for (let a = 0; a < M; a++) E2[a * M + a] = 0;
  const { vectors, values } = topEigen(doubleCentre(E2, M), M, 2);
  const X = [];
  for (let a = 0; a < M; a++) X.push([vectors[0][a] * Math.sqrt(Math.max(values[0], 0)), vectors[1][a] * Math.sqrt(Math.max(values[1], 0))]);
  return X;
}

function doubleCentre(E2, M) {
  const rowMean = new Float64Array(M);
  let total = 0;
  for (let i = 0; i < M; i++) {
    let s = 0;
    for (let j = 0; j < M; j++) s += E2[i * M + j];
    rowMean[i] = s / M;
    total += s;
  }
  total /= M * M;
  const B = new Float64Array(M * M);
  for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) B[i * M + j] = -0.5 * (E2[i * M + j] - rowMean[i] - rowMean[j] + total);
  return B;
}

// Maiores autovetores de uma matriz simétrica (iteração de subespaço, partida determinística).
function topEigen(B, M, dims) {
  const Q = [];
  for (let d = 0; d < dims; d++) Q.push(Float64Array.from({ length: M }, (_, i) => Math.sin((1.7 + d) * i + 0.3 + d)));
  const mul = (v) => {
    const out = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      let s = 0;
      const row = i * M;
      for (let j = 0; j < M; j++) s += B[row + j] * v[j];
      out[i] = s;
    }
    return out;
  };
  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < M; i++) s += a[i] * b[i];
    return s;
  };
  for (let it = 0; it < 120; it++) {
    for (let d = 0; d < dims; d++) {
      let v = mul(Q[d]);
      for (let e = 0; e < d; e++) {
        const p = dot(Q[e], v);
        for (let i = 0; i < M; i++) v[i] -= p * Q[e][i];
      }
      const len = Math.sqrt(dot(v, v)) || 1;
      for (let i = 0; i < M; i++) v[i] /= len;
      Q[d] = v;
    }
  }
  const values = Q.map((q) => dot(q, mul(q)));
  return { vectors: Q, values };
}

// Escala pelo passo: quem anda faz, em média, uma corda de ~0,45 m/s entre varreduras seguidas.
function stepScale(prep, X, T) {
  const { nodes } = prep;
  const M = nodes.length;
  let sum = 0;
  let want = 0;
  let count = 0;
  for (let a = 0; a + 1 < M; a++) {
    const dt = nodes[a + 1].t0 - nodes[a].t1;
    if (dt > 6 || dt <= 0) continue;
    if (nodes[a].spot != null || nodes[a + 1].spot != null) continue;
    sum += Math.hypot(X[a + 1][0] - X[a][0], X[a + 1][1] - X[a][1]);
    want += T.chordSpeed * dt;
    count++;
  }
  if (count < 5 || !(sum > 0)) return { factor: 1, info: { count } };
  return { factor: want / sum, info: { count, factor: want / sum } };
}

function nodePointsToScans(prep, X) {
  const out = new Array(prep.N);
  for (let i = 0; i < prep.N; i++) {
    const a = prep.nodeOf[i];
    out[i] = { x: X[a][0], y: X[a][1] };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Modelo de observação por nó
// ---------------------------------------------------------------------------

function buildModel(prep) {
  const { N, K, obs, nodes, t, missLevel, radios } = prep;
  const M = nodes.length;
  const val = new Float64Array(M * K).fill(NaN); // média das leituras do rádio no nó
  const nObs = new Float64Array(M * K); // quantas varreduras do nó ouviram o rádio
  const nCens = new Float64Array(M * K); // quantas NÃO ouviram por sinal fraco (censura)
  const seen = new Float64Array(K);
  for (let a = 0; a < M; a++) {
    for (let k = 0; k < K; k++) {
      let s = 0;
      let c = 0;
      let cens = 0;
      for (const i of nodes[a].scans) {
        const v = obs[i * K + k];
        if (!Number.isNaN(v)) {
          s += v;
          c++;
          continue;
        }
        // Não ouviu: se os vizinhos no tempo ouvem forte foi beacon perdido (não informa nada).
        let near = -Infinity;
        for (const j of [i - 1, i + 1]) {
          if (j < 0 || j >= N || Math.abs(t[j] - t[i]) > 6) continue;
          const u = obs[j * K + k];
          if (!Number.isNaN(u) && u > near) near = u;
        }
        if (!(near > missLevel + 9)) cens++;
      }
      if (c) {
        val[a * K + k] = s / c;
        nObs[a * K + k] = c;
        seen[k] += c;
      } else nCens[a * K + k] = cens;
    }
  }
  // Rádio ouvido pouquíssimas vezes não sustenta um campo.
  const minSeen = Math.max(3, 0.04 * N);
  const active = [];
  for (let k = 0; k < K; k++) if (seen[k] >= minSeen) active.push(k);
  const floors = [...new Set(nodes.map((nd) => nd.floor))].sort((p, q) => p - q);
  const floorIdx = new Int32Array(M);
  for (let a = 0; a < M; a++) floorIdx[a] = floors.indexOf(nodes[a].floor);
  const time = Float64Array.from(nodes, (nd) => nd.t);
  return { prep, M, K, val, nObs, nCens, active, floors, floorIdx, time, missLevel, radios, nodes };
}

// ---------------------------------------------------------------------------
// Uma volta: ajusta os campos com as posições atuais e relocaliza a caminhada inteira
// ---------------------------------------------------------------------------

function makeGrid(X, T) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of X) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const m = T.gridMargin;
  minX -= m;
  minY -= m;
  maxX += m;
  maxY += m;
  const area = Math.max(1, (maxX - minX) * (maxY - minY));
  const cell = Math.max(0.35, Math.min(1.2, Math.sqrt(area / T.maxCells)));
  const nx = Math.max(2, Math.ceil((maxX - minX) / cell));
  const ny = Math.max(2, Math.ceil((maxY - minY) / cell));
  return { x0: minX, y0: minY, cell, nx, ny, G: nx * ny };
}

// Lei de distância de cada rádio com as posições atuais: nível médio + inclinação com log da distância
// a um centro procurado em volta da área. Os rádios do mesmo aparelho dividem o centro.
function fitBases(model, X, grid, T) {
  const { M, K, val, nObs, nCens, active, floors, floorIdx, missLevel, radios } = model;
  const F = floors.length;
  // Candidatos a posição do aparelho: malha dentro da área e anéis por fora.
  const cxm = grid.x0 + (grid.nx * grid.cell) / 2;
  const cym = grid.y0 + (grid.ny * grid.cell) / 2;
  const w = grid.nx * grid.cell;
  const hgt = grid.ny * grid.cell;
  const step = Math.max(0.7, Math.sqrt((w * hgt) / 260));
  const cands = [];
  for (let x = grid.x0 + step / 2; x < grid.x0 + w; x += step) for (let y = grid.y0 + step / 2; y < grid.y0 + hgt; y += step) cands.push([x, y]);
  const rad = 0.5 * Math.hypot(w, hgt);
  for (const mult of [1.25, 1.6, 2.1, 2.9, 4.2, 6.5]) {
    const count = 20;
    for (let q = 0; q < count; q++) {
      const ang = (2 * Math.PI * (q + (mult * 7) % 1)) / count;
      cands.push([cxm + rad * mult * Math.cos(ang), cym + rad * mult * Math.sin(ang)]);
    }
  }
  const devices = new Map();
  for (const k of active) {
    const d = radios[k].device;
    if (!devices.has(d)) devices.set(d, []);
    devices.get(d).push(k);
  }
  const params = new Array(K).fill(null);
  const u = new Float64Array(M);
  const PRIOR_N = 2.8; // expoente efetivo com paredes dentro: entre 2 (visada) e 4
  const PRIOR_N_W = 4; // peso do a priori do expoente, em "leituras"
  for (const ks of devices.values()) {
    let best = null;
    for (const [ax, ay] of cands) {
      for (let af = 0; af < F; af++) {
        // af = andar do aparelho (entre os visitados); a distância vertical entra na conta.
        for (let a = 0; a < M; a++) {
          const dz = 0.5 + FLOOR_HEIGHT * Math.abs(floors[floorIdx[a]] - floors[af]);
          u[a] = Math.log10(Math.max(0.5, Math.hypot(X[a][0] - ax, X[a][1] - ay, dz)));
        }
        let cost = 0;
        const sols = [];
        for (const k of ks) {
          const sol = fitLogDistance(model, k, u, af, PRIOR_N, PRIOR_N_W);
          cost += sol.cost;
          sols.push(sol);
        }
        if (!best || cost < best.cost) best = { cost, ax, ay, af, sols };
      }
    }
    ks.forEach((k, q) => {
      params[k] = { ax: best.ax, ay: best.ay, af: best.af, ...best.sols[q] };
    });
  }
  return params;
}

// Mínimos quadrados de  r = p0 - 10 n u - desconto[andar]  para um rádio (u = log10 da distância).
function fitLogDistance(model, k, u, af, priorN, priorNW) {
  const { M, K, val, nObs, nCens, floors, floorIdx, missLevel } = model;
  const F = floors.length;
  // Sem laje entre o aparelho e o andar "af": desconto zero nele; nos outros andares é livre.
  // Resolve por andar: dado n, o melhor nível de cada andar é a média ponderada do resíduo.
  const sw = new Float64Array(F);
  const su = new Float64Array(F);
  const sr = new Float64Array(F);
  let suu = 0;
  let sur = 0;
  let srr = 0;
  for (let a = 0; a < M; a++) {
    let wgt = nObs[a * K + k];
    let r = val[a * K + k];
    if (!(wgt > 0)) {
      if (!(nCens[a * K + k] > 0)) continue;
      wgt = 0.3 * nCens[a * K + k];
      r = missLevel - 2;
    }
    const f = floorIdx[a];
    sw[f] += wgt;
    su[f] += wgt * u[a];
    sr[f] += wgt * r;
    suu += wgt * u[a] * u[a];
    sur += wgt * u[a] * r;
    srr += wgt * r * r;
  }
  // Com nível livre por andar: n vem da covariância dentro de cada andar.
  let cuu = suu;
  let cur = sur;
  let crr = srr;
  let wsum = 0;
  for (let f = 0; f < F; f++) {
    if (!(sw[f] > 0)) continue;
    cuu -= (su[f] * su[f]) / sw[f];
    cur -= (su[f] * sr[f]) / sw[f];
    crr -= (sr[f] * sr[f]) / sw[f];
    wsum += sw[f];
  }
  // r = c - 10 n u  =>  n = -cov(u, r) / (10 var(u)), puxado para o a priori.
  const s100 = 100 * cuu + priorNW * 0.0; // escala: (10u)
  let n = (-10 * cur + priorNW * priorN * 1.0) / (100 * cuu + priorNW);
  void s100;
  n = Math.max(1.6, Math.min(4.5, n));
  const cost = crr + 20 * n * cur + 100 * n * n * cuu + priorNW * (n - priorN) * (n - priorN);
  const level = new Float64Array(F);
  for (let f = 0; f < F; f++) level[f] = sw[f] > 0 ? (sr[f] + 10 * n * su[f]) / sw[f] : NaN;
  // Andar sem dados herda o nível do andar do aparelho (ou o de qualquer outro).
  let fallbackLevel = level[af];
  if (Number.isNaN(fallbackLevel)) for (let f = 0; f < F; f++) if (!Number.isNaN(level[f])) fallbackLevel = level[f];
  for (let f = 0; f < F; f++) if (Number.isNaN(level[f])) level[f] = fallbackLevel;
  return { cost: Math.max(0, cost), n, level, wsum };
}

function baseAt(p, x, y, floorDelta) {
  const dz = 0.5 + FLOOR_HEIGHT * Math.abs(floorDelta);
  return -10 * p.n * Math.log10(Math.max(0.5, Math.hypot(x - p.ax, y - p.ay, dz)));
}

function relocalise(model, X, h, T) {
  const { M, K, val, nObs, nCens, active, floors, floorIdx, time, missLevel, nodes } = model;
  const F = floors.length;
  const grid = makeGrid(X, T);
  const { G, nx, ny, cell, x0, y0 } = grid;
  const A = active.length;
  const params = fitBases(model, X, grid, T);

  // Lei de distância nos nós e nas células.
  const baseCell = new Float64Array(F * G * A);
  const resid = new Float64Array(M * A).fill(NaN);
  const wgt = new Float64Array(M * A);
  let s2 = 0;
  let s2n = 0;
  for (let q = 0; q < A; q++) {
    const k = active[q];
    const p = params[k];
    for (let f = 0; f < F; f++) {
      const fd = floors[f] - floors[p.af];
      const off = (f * G) * A + q;
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          baseCell[off + (iy * nx + ix) * A] = p.level[f] + baseAt(p, x0 + (ix + 0.5) * cell, y0 + (iy + 0.5) * cell, fd);
        }
      }
    }
    for (let a = 0; a < M; a++) {
      const f = floorIdx[a];
      const b = p.level[f] + baseAt(p, X[a][0], X[a][1], floors[f] - floors[p.af]);
      if (nObs[a * K + k] > 0) {
        resid[a * A + q] = val[a * K + k] - b;
        wgt[a * A + q] = nObs[a * K + k];
        s2 += nObs[a * K + k] * resid[a * A + q] * resid[a * A + q];
        s2n += nObs[a * K + k];
      } else if (nCens[a * K + k] > 0) {
        // Censura: só puxa o campo para baixo onde a lei de distância prevê sinal audível.
        const e = missLevel - 2 - b;
        if (e < 0) {
          resid[a * A + q] = e;
          wgt[a * A + q] = 0.3 * nCens[a * K + k];
        }
      }
    }
  }

  // Resíduo suave (núcleo gaussiano) por andar: num/den por célula e rádio.
  const num = new Float64Array(F * G * A);
  const den = new Float64Array(F * G * A);
  const reach = Math.ceil((2.6 * h) / cell);
  const supStart = new Int32Array(M + 1);
  const supCell = [];
  const supW = [];
  for (let a = 0; a < M; a++) {
    supStart[a] = supCell.length;
    const gx = Math.floor((X[a][0] - x0) / cell);
    const gy = Math.floor((X[a][1] - y0) / cell);
    for (let iy = Math.max(0, gy - reach); iy <= Math.min(ny - 1, gy + reach); iy++) {
      for (let ix = Math.max(0, gx - reach); ix <= Math.min(nx - 1, gx + reach); ix++) {
        const dx = x0 + (ix + 0.5) * cell - X[a][0];
        const dy = y0 + (iy + 0.5) * cell - X[a][1];
        const d2 = dx * dx + dy * dy;
        if (d2 > 6.8 * h * h) continue;
        supCell.push(iy * nx + ix);
        supW.push(Math.exp(-d2 / (2 * h * h)));
      }
    }
  }
  supStart[M] = supCell.length;
  const splat = (a, sign) => {
    const off = floorIdx[a] * G * A;
    for (let s = supStart[a]; s < supStart[a + 1]; s++) {
      const base = off + supCell[s] * A;
      const w = sign * supW[s];
      for (let q = 0; q < A; q++) {
        const wq = wgt[a * A + q];
        if (wq > 0) {
          num[base + q] += w * wq * resid[a * A + q];
          den[base + q] += w * wq;
        }
      }
    }
  };
  for (let a = 0; a < M; a++) splat(a, 1);

  // Verossimilhança de cada nó em cada célula, com os campos aprendidos SEM as leituras vizinhas no tempo.
  const sn2 = T.sigmaNoise * T.sigmaNoise;
  const sf2 = T.sigmaField * T.sigmaField;
  const lam = T.lambda;
  const logE = new Array(M);
  const zc = T.zCap;
  let lo = 0;
  let hi = 0;
  for (let a = 0; a < M; a++) {
    while (lo < M && time[lo] < time[a] - T.looWindowS) lo++;
    while (hi < M && time[hi] <= time[a] + T.looWindowS) hi++;
    for (let b = lo; b < hi; b++) if (floorIdx[b] === floorIdx[a]) splat(b, -1);
    const out = new Float64Array(G);
    const off = floorIdx[a] * G * A;
    for (let g = 0; g < G; g++) {
      const base = off + g * A;
      let ll = 0;
      for (let q = 0; q < A; q++) {
        const k = active[q];
        const m = nObs[a * K + k];
        const c = nCens[a * K + k];
        if (!(m > 0) && !(c > 0)) continue;
        const dn = Math.max(0, den[base + q]);
        const fld = baseCell[base + q] + num[base + q] / (dn + lam);
        const vf = (sf2 * lam) / (dn + lam);
        if (m > 0) {
          const v = sn2 / m + vf;
          let z2 = ((val[a * K + k] - fld) * (val[a * K + k] - fld)) / v;
          if (z2 > zc * zc) z2 = 2 * zc * Math.sqrt(z2) - zc * zc; // cauda linear (leituras aberrantes)
          ll -= 0.5 * z2 + 0.5 * Math.log(v);
        } else {
          // Não ouviu: improvável onde o campo é forte.
          const z = (missLevel + 1 - fld) / Math.sqrt(sn2 + vf);
          const pm = 1 / (1 + Math.exp(-1.7 * z));
          ll += Math.min(c, 2) * Math.log(0.03 + 0.97 * pm);
        }
      }
      out[g] = ll;
    }
    logE[a] = out;
    for (let b = lo; b < hi; b++) if (floorIdx[b] === floorIdx[a]) splat(b, 1);
  }

  const post = forwardBackward(model, grid, logE, T);
  const Xn = post.X;
  // Mesmo ponto marcado = mesma posição.
  const bySpot = new Map();
  for (let a = 0; a < M; a++) {
    if (nodes[a].spot == null) continue;
    const key = nodes[a].spot;
    if (!bySpot.has(key)) bySpot.set(key, []);
    bySpot.get(key).push(a);
  }
  for (const list of bySpot.values()) {
    if (list.length < 2) continue;
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (const a of list) {
      const w = nodes[a].scans.length;
      sx += w * Xn[a][0];
      sy += w * Xn[a][1];
      sw += w;
    }
    for (const a of list) Xn[a] = [sx / sw, sy / sw];
  }
  return { X: Xn, spread: post.spread, params, grid, sigmaMean: Math.sqrt(s2 / Math.max(1, s2n)) };
}

// Probabilidade de andar uma corda d (m) em dt (s).
function stepKernel(d, dt, walking, T) {
  const vmax = T.vMax * dt + 0.6;
  if (d > vmax) return 0;
  if (!walking) {
    // Saindo de (ou chegando a) um ponto marcado: parte do tempo foi parado. Qualquer corda até a de quem anda.
    const over = Math.max(0, d - T.chordSpeed * dt) / (T.speedSigma * dt);
    return Math.exp(-0.5 * over * over);
  }
  const z = (d - T.chordSpeed * dt) / (T.speedSigma * dt);
  const pause = Math.exp(-0.5 * (d / 0.5) * (d / 0.5));
  return (1 - T.pauseProb) * Math.exp(-0.5 * z * z) + T.pauseProb * 4 * pause;
}

function forwardBackward(model, grid, logE, T) {
  const { M, nodes } = model;
  const { G, nx, ny, cell, x0, y0 } = grid;
  const kernelCache = new Map();
  const kernelFor = (a) => {
    // Transição do nó a para o nó a+1.
    const dt = Math.max(0.5, nodes[a + 1].t0 - nodes[a].t1);
    const walking = nodes[a].spot == null && nodes[a + 1].spot == null;
    const free = dt > 12; // modo de 30 s: o intervalo não limita nada de útil
    const key = `${Math.round(dt * 4)}|${walking ? 1 : 0}|${free ? 1 : 0}`;
    let ker = kernelCache.get(key);
    if (ker) return ker;
    const offs = [];
    const ws = [];
    if (free) {
      // Entre pontos marcados com 30 s de intervalo: pulos curtos são mais prováveis, cauda longa.
      const R = Math.ceil(Math.max(nx, ny));
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const d = Math.hypot(dx, dy) * cell;
          offs.push(dx, dy);
          ws.push(1 / (1 + (d / 2.5) * (d / 2.5)));
        }
      }
    } else {
      const R = Math.ceil((T.vMax * dt + 0.6) / cell);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const w = stepKernel(Math.hypot(dx, dy) * cell, dt, walking, T);
          if (w > 1e-4) {
            offs.push(dx, dy);
            ws.push(w);
          }
        }
      }
    }
    ker = { offs: Int32Array.from(offs), ws: Float64Array.from(ws) };
    kernelCache.set(key, ker);
    return ker;
  };
  const emis = new Array(M);
  for (let a = 0; a < M; a++) {
    let top = -Infinity;
    const le = logE[a];
    for (let g = 0; g < G; g++) if (le[g] > top) top = le[g];
    const e = new Float64Array(G);
    for (let g = 0; g < G; g++) e[g] = Math.exp(le[g] - top);
    emis[a] = e;
  }
  const PRUNE = 1e-5;
  const propagate = (src, ker, out) => {
    out.fill(0);
    let top = 0;
    for (let g = 0; g < G; g++) if (src[g] > top) top = src[g];
    const thr = top * PRUNE;
    const { offs, ws } = ker;
    const L = ws.length;
    for (let g = 0; g < G; g++) {
      const v = src[g];
      if (!(v > thr)) continue;
      const gx = g % nx;
      const gy = (g - gx) / nx;
      for (let l = 0; l < L; l++) {
        const ix = gx + offs[2 * l];
        const iy = gy + offs[2 * l + 1];
        if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
        out[iy * nx + ix] += v * ws[l];
      }
    }
  };
  const normalise = (v) => {
    let s = 0;
    for (let g = 0; g < G; g++) s += v[g];
    if (!(s > 0) || !Number.isFinite(s)) return false;
    for (let g = 0; g < G; g++) v[g] /= s;
    return true;
  };
  const alpha = new Array(M);
  const tmp = new Float64Array(G);
  alpha[0] = Float64Array.from(emis[0]);
  normalise(alpha[0]);
  for (let a = 1; a < M; a++) {
    propagate(alpha[a - 1], kernelFor(a - 1), tmp);
    const al = new Float64Array(G);
    for (let g = 0; g < G; g++) al[g] = tmp[g] * emis[a][g];
    if (!normalise(al)) {
      // Sem interseção (campo e passo se contradizem): recomeça da verossimilhança.
      al.set(emis[a]);
      normalise(al);
    }
    alpha[a] = al;
  }
  const X = new Array(M);
  const spread = new Float64Array(M);
  let beta = new Float64Array(G).fill(1);
  const msg = new Float64Array(G);
  for (let a = M - 1; a >= 0; a--) {
    if (a < M - 1) {
      for (let g = 0; g < G; g++) msg[g] = beta[g] * emis[a + 1][g];
      const nb = new Float64Array(G);
      propagate(msg, kernelFor(a), nb); // núcleo simétrico: vale nos dois sentidos
      if (!normalise(nb)) nb.fill(1 / G);
      beta = nb;
    }
    const al = alpha[a];
    let s = 0;
    let sx = 0;
    let sy = 0;
    for (let g = 0; g < G; g++) {
      const p = al[g] * beta[g];
      if (p > 0) {
        const gx = g % nx;
        s += p;
        sx += p * gx;
        sy += p * ((g - gx) / nx);
      }
    }
    if (!(s > 0)) {
      // Não deveria acontecer; fica com o pico da verossimilhança.
      let best = 0;
      for (let g = 1; g < G; g++) if (emis[a][g] > emis[a][best]) best = g;
      X[a] = [x0 + ((best % nx) + 0.5) * cell, y0 + (Math.floor(best / nx) + 0.5) * cell];
      spread[a] = 3;
      continue;
    }
    const mx = sx / s;
    const my = sy / s;
    let var2 = 0;
    for (let g = 0; g < G; g++) {
      const p = al[g] * beta[g];
      if (p > 0) {
        const gx = g % nx;
        const gy = (g - gx) / nx;
        var2 += p * ((gx - mx) * (gx - mx) + (gy - my) * (gy - my));
      }
    }
    X[a] = [x0 + (mx + 0.5) * cell, y0 + (my + 0.5) * cell];
    spread[a] = Math.sqrt(var2 / s) * cell;
  }
  return { X, spread };
}
