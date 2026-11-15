// Solucionador "hybrid" do mapa 3D só com Wi-Fi (candidato do torneio).
//
// v1: geometria grossa (MDS) -> voltas de [campos por rádio -> relocalização numa grade com
// limite de passo (forward-backward) -> correção da métrica pelo passo de quem anda].

import { FLOOR_HEIGHT } from '../types.js';

const FRESH_MS = 3300; // leitura mais velha que isto é repetição do Android (descreve um lugar anterior)
const SWEEP_MID_S = 1.3; // a posição da varredura vale no meio da varredura, ~1,3 s antes da entrega

const DEFAULTS = {
  smoothW: 0.5, // peso dos vizinhos no tempo ao suavizar a impressão digital de quem está andando
  floorFrac: 0.8, // fração do piso de ruído descontada de D²
  // Passo de quem anda (corda entre varreduras seguidas, m/s): média, largura e teto.
  walkSpeed: 0.45,
  walkSigma: 0.2,
  walkRms: 0.47, // rms do deslocamento / tempo em 1, 2 e 3 varreduras (cai porque o caminho faz curvas)
  walkRms2: 0.39,
  walkRms3: 0.32,
  hopRms: 0.35, // pulo entre pontos marcados: rms da corda / (intervalo - tempo perdido parado)
  hopLost: 3.5,
  leaveSpeed: 0.26, // primeira varredura depois de sair de um ponto marcado: só parte do tempo foi andando
  leaveSigma: 0.12,
  leaveRms: 0.28,
  arriveSigma: 0.2, // última varredura antes de marcar um ponto: quase sempre já no ponto
  vMax: 1.2,
  pauseProb: 0.08,
  iters: 0, // voltas de relocalização numa grade (forward-backward)
  roundsB: 6,
  sweepsB: 6,
  roundsC: 6,
  sweepsC: 8,
  accSigma: 1.0, // desvio típico da "aceleração" entre três varreduras seguidas de quem anda (m)
  damping: 0.3,
  stepSize: 0.7,
  walkW: 0, // peso da mola "passo de tamanho típico" entre varreduras de quem anda
  maxStep: 0.6, // quanto um nó anda por varrida, no máximo (m)
  freeW: 0.3, // peso do a priori de pulo curto entre pontos marcados no modo de 30 s
  freeScale: 2.5,
  kernelH: 1.3, // largura do núcleo espacial dos campos (m)
  kernelH0: 2.0, // largura na primeira volta (vai fechando até kernelH)
  lambda: 0.5, // encolhimento do resíduo onde há poucos dados (em "leituras equivalentes")
  sigmaNoise: 4.5, // ruído de uma leitura (dB), valor de partida; depois vem do erro de previsão
  sigmaField: 5, // amplitude do resíduo do campo em torno da lei de distância (dB)
  looWindowS: 1, // ao relocalizar uma varredura, ignora as leituras a menos disto dela no tempo
  maxCells: 1200,
  gridMargin: 2.0,
  zCap: 3, // resíduo (em desvios) a partir do qual a leitura é tratada como aberrante
  densityPow: 1, // força do a priori "fique perto de onde há outras varreduras"
  densityEps: 0.05,
  metric: 1, // 1 = corrige escala e anisotropia pelo passo a cada volta; 2 = só a escala; 0 = não corrige
  metricCoarse: 1,
  anisoMax: 2.2,
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
  const info = {};
  if (N === 0) return fallbackSolution(survey, 'sem varreduras');

  const model = buildModel(prep);
  let X = coarseEmbedding(model, T);
  if (T.metricCoarse) X = metricCorrection(model, X, T, info, 'coarse');
  stages.coarse = nodePointsToScans(prep, X);
  if (T.initTruth) X = nodes.map((nd) => [T.initTruth[nd.scans[0]].x, T.initTruth[nd.scans[0]].y]); // só diagnóstico

  let fit = null;
  // Estágio B: só a física (lei de distância por rádio) + suavidade do caminho.
  if (T.roundsB > 0) {
    fit = refineContinuous(model, X, T, { rounds: T.roundsB, sweeps: T.sweepsB, h0: 2, h1: 2, useResidual: false, info, label: 'B' });
    X = fit.X;
    stages.phys = nodePointsToScans(prep, X);
  }
  // Estágio C: mais o resíduo suave de cada rádio (impressão digital do lugar).
  if (T.roundsC > 0) {
    fit = refineContinuous(model, X, T, {
      rounds: T.roundsC,
      sweeps: T.sweepsC,
      h0: T.kernelH0,
      h1: T.kernelH,
      useResidual: true,
      info,
      label: 'C',
      onRound: (r, Xr) => {
        if (r === 0 || r === Math.floor(T.roundsC / 2)) stages[`C${r + 1}`] = nodePointsToScans(prep, Xr);
      },
    });
    X = fit.X;
    stages.field = nodePointsToScans(prep, X);
  }
  // Relocalização global numa grade (opcional).
  const state = { sigma: null };
  for (let it = 0; it < T.iters; it++) {
    const frac = T.iters > 1 ? it / (T.iters - 1) : 1;
    const h = T.kernelH0 + (T.kernelH - T.kernelH0) * Math.min(1, frac * 1.5);
    const g = relocalise(model, X, h, T, state);
    X = g.X;
    if (T.metric) X = metricCorrection(model, X, T, info, `it${it + 1}`);
    if (it === T.iters - 1) stages[`grid`] = nodePointsToScans(prep, X);
  }
  if (fit) {
    info.heldOut = Number(fit.heldOut.toFixed(3));
    info.sigma = Number(fit.sigmaMean.toFixed(2));
  }

  const pts = nodePointsToScans(prep, X);
  const points = pts.map((p, i) => ({ x: p.x, y: p.y, z: prep.floor[i] * FLOOR_HEIGHT, conf: 0.3 }));
  return { points, aps: {}, scaleConf: 0.3, debug: { stages, info } };
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
      }
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
  return { scans, N, K, radios, t, floor, obs, missLevel, nodes, nodeOf };
}

// Modelo de observação por nó: média por rádio, quantas varreduras ouviram e quantas não ouviram.
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

  // Transições entre nós seguidos: tipo (andando, saindo de ponto, chegando a ponto, livre) e intervalo.
  const trans = [];
  for (let a = 0; a + 1 < M; a++) {
    const dt = Math.max(0.5, nodes[a + 1].t0 - nodes[a].t1);
    const sa = nodes[a].spot != null;
    const sb = nodes[a + 1].spot != null;
    let type = 'walk';
    if (dt > 12) type = 'free';
    else if (sa && sb) type = 'free';
    else if (sa) type = 'leave';
    else if (sb) type = 'arrive';
    trans.push({ type, dt, sameFloor: nodes[a].floor === nodes[a + 1].floor });
  }
  return { prep, M, K, val, nObs, nCens, active, floors, floorIdx, time, missLevel, radios, nodes, trans };
}

// Pares de nós cujo deslocamento esperado se conhece (pelo tempo e pelo passo de quem anda):
// é o que dá a escala e desfaz o achatamento do mapa. Deslocamentos de 2 e 3 varreduras sofrem
// bem menos com o tremido da estimativa do que o passo de 1 varredura.
function displacementPairs(model, T) {
  const { M, nodes, trans } = model;
  const pairs = [];
  const walkRun = (a, b) => {
    for (let q = a; q < b; q++) if (trans[q].type !== 'walk' || !trans[q].sameFloor) return false;
    return true;
  };
  for (const [L, rms] of [
    [2, T.walkRms2],
    [3, T.walkRms3],
  ]) {
    for (let a = 0; a + L < M; a++) {
      if (!walkRun(a, a + L)) continue;
      pairs.push({ a, b: a + L, len: rms * (nodes[a + L].t - nodes[a].t) });
    }
  }
  if (pairs.length < 12) {
    for (let a = 0; a + 1 < M; a++) if (walkRun(a, a + 1)) pairs.push({ a, b: a + 1, len: T.walkRms * trans[a].dt });
  }
  // Pulos entre pontos marcados seguidos (com ou sem varreduras andando no meio).
  let last = -1;
  for (let a = 0; a < M; a++) {
    if (nodes[a].spot == null) continue;
    if (last >= 0 && nodes[last].spot !== nodes[a].spot && nodes[last].floor === nodes[a].floor) {
      const gap = nodes[a].t0 - nodes[last].t1;
      let ok = gap < 60;
      for (let q = last; q < a; q++) if (trans[q].type === 'free') ok = false;
      if (ok) pairs.push({ a: last, b: a, len: T.hopRms * Math.max(1.5, gap - T.hopLost) });
    }
    last = a;
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Geometria grossa: MDS clássico sobre a distância entre impressões digitais
// ---------------------------------------------------------------------------

// Impressão digital de cada nó; rádio ausente = nível de corte (ou "não sei" quando foi beacon perdido).
function nodeFingerprints(model, T) {
  const { M, K, val, nObs, nCens, nodes, missLevel } = model;
  const fp = new Float64Array(M * K);
  for (let i = 0; i < M * K; i++) fp[i] = nObs[i] > 0 ? val[i] : nCens[i] > 0 ? missLevel : NaN;
  // Suavização no tempo para quem está andando: tira ruído à custa de borrar ~1 passo.
  const w = T.smoothW;
  if (!(w > 0)) return fp;
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

function coarseEmbedding(model, T) {
  const { M, K, nodes, floors } = model;
  if (M === 1) return [[0, 0]];
  const fp = nodeFingerprints(model, T);
  // Desconto por andar: a laje muda o nível de cada rádio; tira-se a média de cada (rádio, andar).
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
  for (let i = 0; i < M * M; i++) E2[i] = Math.max(0, D2[i] - floorD2);
  for (let a = 0; a < M; a++) E2[a * M + a] = 0;
  const { vectors, values } = topEigen(doubleCentre(E2, M), M, 2);
  const X = [];
  // 0,45 m por dB: só um chute de escala; a correção da métrica acerta depois.
  const s0 = 0.45 * Math.sqrt(Math.max(values[0], 0));
  const s1 = 0.45 * Math.sqrt(Math.max(values[1], 0));
  for (let a = 0; a < M; a++) X.push([vectors[0][a] * s0, vectors[1][a] * s1]);
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
      const v = mul(Q[d]);
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

function nodePointsToScans(prep, X) {
  const out = new Array(prep.N);
  for (let i = 0; i < prep.N; i++) {
    const a = prep.nodeOf[i];
    out[i] = { x: X[a][0], y: X[a][1] };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Correção da métrica pelo passo
// ---------------------------------------------------------------------------

// Quem anda dá passos do mesmo tamanho em qualquer direção. Procura a matriz simétrica M tal que
// (passo)ᵀ M (passo) = (tamanho esperado)² na média, para toda direção, e aplica B = M^(1/2) ao mapa.
// Conserta de uma vez a escala e o achatamento do mapa, que as voltas de relocalização quase não mexem.
function metricCorrection(model, X, T, info, label) {
  const { M } = model;
  const pairs = model.pairs || (model.pairs = displacementPairs(model, T));
  let a11 = 0;
  let a12 = 0;
  let a13 = 0;
  let a22 = 0;
  let a23 = 0;
  let a33 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let su2 = 0;
  let count = 0;
  for (const pr of pairs) {
    let ux = (X[pr.b][0] - X[pr.a][0]) / pr.len;
    let uy = (X[pr.b][1] - X[pr.a][1]) / pr.len;
    let r2 = ux * ux + uy * uy;
    if (r2 < 1e-12) {
      count++;
      continue;
    }
    if (r2 > 6) {
      // Deslocamento absurdo (ruído): entra limitado.
      const k = Math.sqrt(6 / r2);
      ux *= k;
      uy *= k;
      r2 = 6;
    }
    // Direção (independe do tamanho) x forma quadrática do deslocamento normalizado.
    const ex2 = (ux * ux) / r2;
    const exy = (2 * ux * uy) / r2;
    const ey2 = (uy * uy) / r2;
    const p1 = ux * ux;
    const p2 = 2 * ux * uy;
    const p3 = uy * uy;
    a11 += ex2 * p1;
    a12 += ex2 * p2;
    a13 += ex2 * p3;
    a22 += exy * p2;
    a23 += exy * p3;
    a33 += ey2 * p3;
    b1 += ex2;
    b2 += exy;
    b3 += ey2;
    su2 += r2;
    count++;
  }
  if (count < 8 || !(su2 > 0)) return X;
  const iso = count / su2; // M = iso·I: só a escala
  // Pequena regularização para direções quase ausentes (puxa para a escala isotrópica).
  const reg = 0.02 * (a11 + a22 / 4 + a33);
  const A = [
    [a11 + reg, a12, a13],
    [a12, a22 + 4 * reg, a23],
    [a13, a23, a33 + reg],
  ];
  const rhs = [b1 + reg * iso, b2, b3 + reg * iso];
  const m = T.metric === 2 ? null : solve3(A, rhs);
  let m11 = iso;
  let m12 = 0;
  let m22 = iso;
  if (m) [m11, m12, m22] = m;
  // Autovalores de M, com a anisotropia limitada.
  const half = (m11 + m22) / 2;
  const df = Math.hypot((m11 - m22) / 2, m12);
  let l1 = half + df;
  let l2 = half - df;
  const ang = 0.5 * Math.atan2(2 * m12, m11 - m22);
  if (!(l2 > 0) || !(l1 > 0) || !Number.isFinite(l1 + l2)) {
    l1 = l2 = iso;
  }
  const maxRatio = T.anisoMax * T.anisoMax;
  if (l1 / l2 > maxRatio) {
    const g = Math.sqrt(l1 * l2);
    l1 = g * T.anisoMax;
    l2 = g / T.anisoMax;
  }
  const s1 = Math.sqrt(l1);
  const s2 = Math.sqrt(l2);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  // B = R diag(s1, s2) Rᵀ
  const b11 = s1 * c * c + s2 * s * s;
  const b12 = (s1 - s2) * c * s;
  const b22 = s1 * s * s + s2 * c * c;
  let cx = 0;
  let cy = 0;
  for (const p of X) {
    cx += p[0];
    cy += p[1];
  }
  cx /= M;
  cy /= M;
  if (info) (info.metric ||= {})[label] = [Number(s1.toFixed(2)), Number(s2.toFixed(2))];
  return X.map((p) => [cx + b11 * (p[0] - cx) + b12 * (p[1] - cy), cy + b12 * (p[0] - cx) + b22 * (p[1] - cy)]);
}

function solve3(A, b) {
  const m = [A[0].concat(b[0]), A[1].concat(b[1]), A[2].concat(b[2])];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let q = c; q < 4; q++) m[r][q] -= f * m[c][q];
    }
  }
  const out = [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  return out.every(Number.isFinite) ? out : null;
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
  const cell = Math.max(0.35, Math.min(1.5, Math.sqrt(area / T.maxCells)));
  const nx = Math.max(2, Math.ceil((maxX - minX) / cell));
  const ny = Math.max(2, Math.ceil((maxY - minY) / cell));
  return { x0: minX, y0: minY, cell, nx, ny, G: nx * ny };
}

// Lei de distância de cada rádio com as posições atuais: nível + inclinação com o log da distância
// a um centro procurado em volta da área. Os rádios do mesmo aparelho dividem o centro.
function fitBases(model, X, grid) {
  const { M, K, active, floors, floorIdx, radios } = model;
  const F = floors.length;
  const cxm = grid.x0 + (grid.nx * grid.cell) / 2;
  const cym = grid.y0 + (grid.ny * grid.cell) / 2;
  const w = grid.nx * grid.cell;
  const hgt = grid.ny * grid.cell;
  const step = Math.max(0.7, Math.sqrt((w * hgt) / 220));
  const cands = [];
  for (let x = grid.x0 + step / 2; x < grid.x0 + w; x += step) for (let y = grid.y0 + step / 2; y < grid.y0 + hgt; y += step) cands.push([x, y]);
  const rad = 0.5 * Math.hypot(w, hgt);
  for (const mult of [1.25, 1.6, 2.1, 2.9, 4.2, 6.5]) {
    const count = 16;
    for (let q = 0; q < count; q++) {
      const ang = (2 * Math.PI * (q + ((mult * 7) % 1))) / count;
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
  for (const ks of devices.values()) {
    let best = null;
    for (const [ax, ay] of cands) {
      for (let af = 0; af < F; af++) {
        // af = andar do aparelho (entre os visitados); a distância vertical entra na conta.
        for (let a = 0; a < M; a++) {
          const dz = 0.5 + FLOOR_HEIGHT * Math.abs(floors[floorIdx[a]] - floors[af]);
          const dx = X[a][0] - ax;
          const dy = X[a][1] - ay;
          u[a] = 0.5 * Math.log10(Math.max(0.25, dx * dx + dy * dy + dz * dz));
        }
        let cost = 0;
        const sols = [];
        for (const k of ks) {
          const sol = fitLogDistance(model, k, u, af);
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

// Mínimos quadrados de  r = nível[andar] - 10 n u  para um rádio (u = log10 da distância).
function fitLogDistance(model, k, u, af) {
  const { M, K, val, nObs, nCens, floors, floorIdx, missLevel } = model;
  const F = floors.length;
  const PRIOR_N = 2.8; // expoente efetivo com paredes dentro: entre 2 (visada) e 4
  const PRIOR_W = 4; // peso do a priori, em "leituras"
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
  // Nível livre por andar (a laje entra nele): n vem da covariância dentro de cada andar.
  let cuu = suu;
  let cur = sur;
  let crr = srr;
  for (let f = 0; f < F; f++) {
    if (!(sw[f] > 0)) continue;
    cuu -= (su[f] * su[f]) / sw[f];
    cur -= (su[f] * sr[f]) / sw[f];
    crr -= (sr[f] * sr[f]) / sw[f];
  }
  let n = (-10 * cur + PRIOR_W * PRIOR_N) / (100 * cuu + PRIOR_W);
  n = Math.max(1.6, Math.min(4.5, n));
  const cost = crr + 20 * n * cur + 100 * n * n * cuu + PRIOR_W * (n - PRIOR_N) * (n - PRIOR_N);
  const level = new Float64Array(F);
  for (let f = 0; f < F; f++) level[f] = sw[f] > 0 ? (sr[f] + 10 * n * su[f]) / sw[f] : NaN;
  let fallbackLevel = level[af];
  if (Number.isNaN(fallbackLevel)) for (let f = 0; f < F; f++) if (!Number.isNaN(level[f])) fallbackLevel = level[f];
  for (let f = 0; f < F; f++) if (Number.isNaN(level[f])) level[f] = fallbackLevel;
  return { cost: Math.max(0, cost), n, level };
}

function relocalise(model, X, h, T, state) {
  const { M, K, val, nObs, nCens, active, floors, floorIdx, time, missLevel, nodes } = model;
  const F = floors.length;
  const grid = makeGrid(X, T);
  const { G, nx, ny, cell, x0, y0 } = grid;
  const A = active.length;
  const params = fitBases(model, X, grid);

  // Lei de distância nas células e resíduo de cada nó.
  const baseCell = new Float64Array(F * G * A);
  const resid = new Float64Array(M * A);
  const wgt = new Float64Array(M * A);
  for (let q = 0; q < A; q++) {
    const k = active[q];
    const p = params[k];
    for (let f = 0; f < F; f++) {
      const dz = 0.5 + FLOOR_HEIGHT * Math.abs(floors[f] - floors[p.af]);
      const off = f * G * A + q;
      for (let iy = 0; iy < ny; iy++) {
        const dy = y0 + (iy + 0.5) * cell - p.ay;
        for (let ix = 0; ix < nx; ix++) {
          const dx = x0 + (ix + 0.5) * cell - p.ax;
          baseCell[off + (iy * nx + ix) * A] = p.level[f] - 5 * p.n * Math.log10(Math.max(0.25, dx * dx + dy * dy + dz * dz));
        }
      }
    }
    for (let a = 0; a < M; a++) {
      const f = floorIdx[a];
      const dz = 0.5 + FLOOR_HEIGHT * Math.abs(floors[f] - floors[p.af]);
      const dx = X[a][0] - p.ax;
      const dy = X[a][1] - p.ay;
      const b = p.level[f] - 5 * p.n * Math.log10(Math.max(0.25, dx * dx + dy * dy + dz * dz));
      if (nObs[a * K + k] > 0) {
        resid[a * A + q] = val[a * K + k] - b;
        wgt[a * A + q] = nObs[a * K + k];
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
  const cnt = new Float64Array(F * G); // quantas varreduras (de outros momentos) passaram perto da célula
  const reach = Math.ceil((2.6 * h) / cell);
  const supStart = new Int32Array(M + 1);
  const supCell = [];
  const supW = [];
  const ownCell = new Int32Array(M);
  for (let a = 0; a < M; a++) {
    supStart[a] = supCell.length;
    const gx = Math.max(0, Math.min(nx - 1, Math.floor((X[a][0] - x0) / cell)));
    const gy = Math.max(0, Math.min(ny - 1, Math.floor((X[a][1] - y0) / cell)));
    ownCell[a] = gy * nx + gx;
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
    const offC = floorIdx[a] * G;
    const wn = sign * nodes[a].scans.length;
    const ra = a * A;
    for (let s = supStart[a]; s < supStart[a + 1]; s++) {
      const base = off + supCell[s] * A;
      const w = sign * supW[s];
      cnt[offC + supCell[s]] += wn * supW[s];
      for (let q = 0; q < A; q++) {
        const wq = wgt[ra + q];
        if (wq > 0) {
          num[base + q] += w * wq * resid[ra + q];
          den[base + q] += w * wq;
        }
      }
    }
  };
  for (let a = 0; a < M; a++) splat(a, 1);

  // Verossimilhança de cada nó em cada célula, com os campos aprendidos SEM as leituras do próprio nó
  // (nem as vizinhas no tempo). O erro de previsão no lugar atual calibra o ruído de cada rádio.
  const sig2 = new Float64Array(A);
  for (let q = 0; q < A; q++) sig2[q] = state.sigma ? state.sigma[q] * state.sigma[q] : T.sigmaNoise * T.sigmaNoise;
  const sf2 = T.sigmaField * T.sigmaField;
  const lam = T.lambda;
  const logE = new Array(M);
  const zc = T.zCap;
  const errS = new Float64Array(A);
  const errN = new Float64Array(A);
  let heldOut = 0;
  let heldN = 0;
  let lo = 0;
  let hi = 0;
  // Por nó: lista dos rádios com dado (evita testar tudo em cada célula).
  const qList = new Int32Array(A);
  const qVal = new Float64Array(A);
  const qInv = new Float64Array(A);
  const qCens = new Float64Array(A);
  for (let a = 0; a < M; a++) {
    while (lo < M && time[lo] < time[a] - T.looWindowS) lo++;
    while (hi < M && time[hi] <= time[a] + T.looWindowS) hi++;
    for (let b = lo; b < hi; b++) if (floorIdx[b] === floorIdx[a]) splat(b, -1);
    let nq = 0;
    for (let q = 0; q < A; q++) {
      const k = active[q];
      const m = nObs[a * K + k];
      const c = nCens[a * K + k];
      if (m > 0) {
        qList[nq] = q;
        qVal[nq] = val[a * K + k];
        qInv[nq] = sig2[q] / m;
        qCens[nq] = 0;
        nq++;
      } else if (c > 0) {
        qList[nq] = q;
        qVal[nq] = missLevel + 1;
        qInv[nq] = sig2[q];
        qCens[nq] = Math.min(c, 2);
        nq++;
      }
    }
    const out = new Float64Array(G);
    const off = floorIdx[a] * G * A;
    const offC = floorIdx[a] * G;
    const own = ownCell[a];
    for (let g = 0; g < G; g++) {
      const base = off + g * A;
      // A priori de lugar: a pessoa anda por onde já passou (ou vai passar) em outro momento.
      const ll = T.densityPow > 0 ? T.densityPow * Math.log(Math.max(0, cnt[offC + g]) + T.densityEps) : 0;
      let llData = 0;
      for (let j = 0; j < nq; j++) {
        const q = qList[j];
        const dn = den[base + q] > 0 ? den[base + q] : 0;
        const fld = baseCell[base + q] + num[base + q] / (dn + lam);
        const vf = (sf2 * lam) / (dn + lam);
        if (qCens[j] === 0) {
          const v = qInv[j] + vf;
          const e = qVal[j] - fld;
          let z2 = (e * e) / v;
          if (g === own) {
            errS[q] += e * e - vf;
            errN[q] += 1;
          }
          if (z2 > zc * zc) z2 = 2 * zc * Math.sqrt(z2) - zc * zc; // cauda linear (leituras aberrantes)
          llData -= 0.5 * z2 + 0.5 * Math.log(v);
        } else {
          // Não ouviu: improvável onde o campo é forte.
          const z = (qVal[j] - fld) / Math.sqrt(qInv[j] + vf);
          llData += qCens[j] * Math.log(0.03 + 0.97 / (1 + Math.exp(-1.7 * z)));
        }
      }
      if (g === own) {
        heldOut += llData;
        heldN += nq;
      }
      out[g] = ll + llData;
    }
    logE[a] = out;
    for (let b = lo; b < hi; b++) if (floorIdx[b] === floorIdx[a]) splat(b, 1);
  }
  // Ruído de cada rádio para a próxima volta: erro quadrático de previsão menos a incerteza do campo.
  const sigma = new Float64Array(A);
  for (let q = 0; q < A; q++) {
    const v = errN[q] > 3 ? errS[q] / errN[q] : T.sigmaNoise * T.sigmaNoise;
    sigma[q] = Math.max(2, Math.min(9, Math.sqrt(Math.max(0, v))));
  }
  if (T.sigmaAdapt !== 0) state.sigma = sigma;

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
  return { X: Xn, spread: post.spread, params, grid, heldOut: heldN ? heldOut / heldN : 0 };
}

// Probabilidade (não normalizada) de uma corda d (m) numa transição.
function stepWeight(d, tr, T) {
  const dt = tr.dt;
  if (tr.type === 'free') return 1 / (1 + (d / 2.5) * (d / 2.5)); // pulos curtos mais prováveis, cauda longa
  if (d > T.vMax * dt + 0.6) return 0;
  if (tr.type === 'walk') {
    const z = (d - T.walkSpeed * dt) / (T.walkSigma * dt);
    return (1 - T.pauseProb) * Math.exp(-0.5 * z * z) + T.pauseProb * 4 * Math.exp(-0.5 * (d / 0.5) * (d / 0.5));
  }
  if (tr.type === 'leave') {
    const z = (d - T.leaveSpeed * dt) / (T.leaveSigma * dt);
    return Math.exp(-0.5 * z * z) + 0.02;
  }
  // 'arrive': a varredura anterior à marcação quase sempre já foi feita no ponto.
  const z = d / (T.arriveSigma * dt);
  const zw = d / (T.walkSpeed * dt);
  return Math.exp(-0.5 * z * z) + 0.05 * Math.exp(-0.5 * zw * zw);
}

function forwardBackward(model, grid, logE, T) {
  const { M, trans } = model;
  const { G, nx, ny, cell, x0, y0 } = grid;
  const kernelCache = new Map();
  const kernelFor = (a) => {
    const tr = trans[a];
    const key = `${tr.type}|${Math.round(tr.dt * 4)}`;
    let ker = kernelCache.get(key);
    if (ker) return ker;
    const offs = [];
    const ws = [];
    const R = tr.type === 'free' ? Math.ceil(Math.min(Math.max(nx, ny), 14 / cell)) : Math.ceil((T.vMax * tr.dt + 0.6) / cell);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const w = stepWeight(Math.hypot(dx, dy) * cell, tr, T);
        if (w > 1e-4) {
          offs.push(dx, dy);
          ws.push(w);
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
    for (let g = 0; g < G; g++) {
      const d = le[g] - top;
      e[g] = d > -30 ? Math.exp(d) : 0;
    }
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
    const inv = 1 / s;
    for (let g = 0; g < G; g++) v[g] *= inv;
    return true;
  };
  const alpha = new Array(M);
  const tmp = new Float64Array(G);
  alpha[0] = Float64Array.from(emis[0]);
  normalise(alpha[0]);
  for (let a = 1; a < M; a++) {
    propagate(alpha[a - 1], kernelFor(a - 1), tmp);
    const al = new Float64Array(G);
    const e = emis[a];
    for (let g = 0; g < G; g++) al[g] = tmp[g] * e[g];
    if (!normalise(al)) {
      // Sem interseção (campo e passo se contradizem): recomeça da verossimilhança.
      al.set(e);
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
      const e = emis[a + 1];
      for (let g = 0; g < G; g++) msg[g] = beta[g] * e[g];
      const nb = new Float64Array(G);
      propagate(msg, kernelFor(a), nb); // núcleo simétrico: vale nos dois sentidos
      if (!normalise(nb)) nb.fill(1 / G);
      beta = nb;
    }
    const al = alpha[a];
    let s = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    for (let g = 0; g < G; g++) {
      const p = al[g] * beta[g];
      if (p > 0) {
        const gx = g % nx;
        const gy = (g - gx) / nx;
        s += p;
        sx += p * gx;
        sy += p * gy;
        sxx += p * (gx * gx + gy * gy);
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
    X[a] = [x0 + (mx + 0.5) * cell, y0 + (my + 0.5) * cell];
    spread[a] = Math.sqrt(Math.max(0, sxx / s - mx * mx - my * my)) * cell;
  }
  return { X, spread };
}

// ---------------------------------------------------------------------------
// Refino contínuo: sobe o gradiente COMPLETO da previsão cruzada dos campos
// ---------------------------------------------------------------------------

// Variável = posição a descobrir. Nós do mesmo ponto marcado dividem a variável.
function buildVariables(model) {
  const { M, nodes } = model;
  const varOf = new Int32Array(M);
  const bySpot = new Map();
  const members = [];
  for (let a = 0; a < M; a++) {
    const spot = nodes[a].spot;
    const key = spot == null ? null : `${spot}|${nodes[a].floor}`;
    if (key != null && bySpot.has(key)) {
      varOf[a] = bySpot.get(key);
      members[varOf[a]].push(a);
    } else {
      varOf[a] = members.length;
      members.push([a]);
      if (key != null) bySpot.set(key, varOf[a]);
    }
  }
  return { varOf, members, P: members.length };
}

function boundsOf(X, margin) {
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
  const w = Math.max(1, maxX - minX + 2 * margin);
  const h = Math.max(1, maxY - minY + 2 * margin);
  // Mesmo formato da grade (fitBases só usa a caixa).
  return { x0: minX - margin, y0: minY - margin, cell: 1, nx: w, ny: h, G: 0 };
}

/**
 * Voltas de [ajusta a lei de distância -> passos de gradiente nas posições -> corrige a métrica].
 *
 * O que se minimiza é o erro com que o campo de cada rádio, aprendido dos OUTROS nós (núcleo
 * gaussiano sobre o resíduo da lei de distância), prevê as leituras de cada nó. O gradiente é o
 * completo: cada nó é empurrado para onde as suas leituras combinam com o campo E para onde as
 * suas leituras ajudam (ou param de atrapalhar) a previsão dos vizinhos. É esta segunda parte que
 * separa lugares diferentes que o mapa grosso tinha amontoado.
 * useResidual = false: só a lei de distância (física).
 */
function refineContinuous(model, X0, T, opts) {
  const { M, K, val, nObs, nCens, active, floors, floorIdx, missLevel, trans } = model;
  const vars = model.vars || (model.vars = buildVariables(model));
  const { varOf, members, P } = vars;
  const A = active.length;
  let X = X0.map((p) => [p[0], p[1]]);
  const syncVars = () => {
    for (let p = 0; p < P; p++) {
      if (members[p].length < 2) continue;
      let sx = 0;
      let sy = 0;
      for (const a of members[p]) {
        sx += X[a][0];
        sy += X[a][1];
      }
      for (const a of members[p]) X[a] = [sx / members[p].length, sy / members[p].length];
    }
  };
  syncVars();
  const sig2 = new Float64Array(A).fill(T.sigmaNoise * T.sigmaNoise);
  const sf2 = T.sigmaField * T.sigmaField;
  const lam = T.lambda;
  const MA = M * A;
  const resid = new Float64Array(MA); // leitura - lei de distância, na posição atual do nó
  const wgt = new Float64Array(MA); // peso do nó como dado do campo
  const tgt = new Float64Array(MA); // valor-alvo quando o nó é quem está sendo previsto (NaN = sem dado)
  const tgtS = new Float64Array(MA); // variância própria do alvo
  const tgtC = new Uint8Array(MA); // 1 = censura (não ouviu)
  const bGx = new Float64Array(MA); // gradiente da lei de distância na posição do nó
  const bGy = new Float64Array(MA);
  const baseV = new Float64Array(MA);
  const accD = new Float64Array(MA);
  const accN = new Float64Array(MA);
  const cE = new Float64Array(MA);
  const cV = new Float64Array(MA);
  const aR = new Float64Array(MA);
  const aInv = new Float64Array(MA);
  const aVf = new Float64Array(MA);
  const pX = new Float64Array(MA);
  const pY = new Float64Array(MA);
  const tB = new Float64Array(MA);
  const gX = new Float64Array(M);
  const gY = new Float64Array(M);
  const hXX = new Float64Array(M);
  const hXY = new Float64Array(M);
  const hYY = new Float64Array(M);
  let params = null;
  let heldOut = 0;
  let sigmaMean = 0;
  const wAcc = 1 / (T.accSigma * T.accSigma);

  // Alvos (não mudam com a posição).
  for (let a = 0; a < M; a++) {
    for (let q = 0; q < A; q++) {
      const k = active[q];
      const i = a * A + q;
      tgt[i] = NaN;
      if (nObs[a * K + k] > 0) {
        tgt[i] = val[a * K + k];
        tgtC[i] = 0;
      } else if (nCens[a * K + k] > 0) {
        tgt[i] = missLevel;
        tgtC[i] = 1;
      }
    }
  }

  // Custo e gradiente para as posições X (com a lei de distância `params` fixa).
  const evaluate = (h, wantGrad) => {
    const inv2h2 = 1 / (2 * h * h);
    const cut2 = 6.8 * h * h;
    // Lei de distância, resíduo e peso de cada nó.
    for (let a = 0; a < M; a++) {
      const f = floorIdx[a];
      for (let q = 0; q < A; q++) {
        const k = active[q];
        const p = params[k];
        const i = a * A + q;
        const dz = 0.5 + FLOOR_HEIGHT * Math.abs(floors[f] - floors[p.af]);
        const dx = X[a][0] - p.ax;
        const dy = X[a][1] - p.ay;
        const d2 = Math.max(0.25, dx * dx + dy * dy + dz * dz);
        const b = p.level[f] - 5 * p.n * Math.log10(d2);
        baseV[i] = b;
        bGx[i] = (-4.3429 * p.n * dx) / d2;
        bGy[i] = (-4.3429 * p.n * dy) / d2;
        resid[i] = 0;
        wgt[i] = 0;
        if (nObs[a * K + k] > 0) {
          resid[i] = val[a * K + k] - b;
          wgt[i] = nObs[a * K + k];
          tgtS[i] = sig2[q] / nObs[a * K + k];
        } else if (nCens[a * K + k] > 0) {
          tgtS[i] = sig2[q] * 2;
          // Censura: como dado, só puxa o campo para baixo onde a lei de distância prevê sinal audível.
          const e = missLevel - 2 - b;
          if (e < 0) {
            resid[i] = e;
            wgt[i] = 0.3 * nCens[a * K + k];
          }
        }
      }
    }
    // Passo 1: num/den do núcleo em cada nó (sem os nós que dividem a mesma variável).
    accD.fill(0);
    accN.fill(0);
    if (opts.useResidual) {
      for (let a = 0; a < M; a++) {
        const ra = a * A;
        for (let b = a + 1; b < M; b++) {
          if (floorIdx[b] !== floorIdx[a] || varOf[b] === varOf[a]) continue;
          const dx = X[a][0] - X[b][0];
          const dy = X[a][1] - X[b][1];
          const d2 = dx * dx + dy * dy;
          if (d2 > cut2) continue;
          const w = Math.exp(-d2 * inv2h2);
          const rb = b * A;
          for (let q = 0; q < A; q++) {
            const wb = wgt[rb + q];
            if (wb > 0) {
              accD[ra + q] += w * wb;
              accN[ra + q] += w * wb * resid[rb + q];
            }
            const wa = wgt[ra + q];
            if (wa > 0) {
              accD[rb + q] += w * wa;
              accN[rb + q] += w * wa * resid[ra + q];
            }
          }
        }
      }
    }
    // Erro de previsão de cada alvo e coeficientes do gradiente.
    let cost = 0;
    let ll = 0;
    let llN = 0;
    const errS = new Float64Array(A);
    const errN = new Float64Array(A);
    for (let i = 0; i < MA; i++) {
      cE[i] = 0;
      cV[i] = 0;
      if (Number.isNaN(tgt[i])) continue;
      const q = i % A;
      const dn = accD[i] + lam;
      const r = opts.useResidual ? accN[i] / dn : 0;
      const vf = opts.useResidual ? (sf2 * lam) / dn : sf2;
      const v = tgtS[i] + vf;
      const e = tgt[i] - (baseV[i] + r);
      aR[i] = r;
      aInv[i] = 1 / dn;
      aVf[i] = vf;
      if (tgtC[i]) {
        // Não ouviu: só custa se o campo previsto ali é audível.
        if (e >= 0) continue;
        cost += (0.5 * e * e) / v;
        cE[i] = e / v;
        continue;
      }
      const z = Math.abs(e) / Math.sqrt(v);
      let wr = 1;
      let quad = z * z;
      if (z > T.zCap) {
        // Leitura aberrante: cauda linear.
        wr = T.zCap / z;
        quad = 2 * T.zCap * z - T.zCap * T.zCap;
      }
      const c = 0.5 * quad + 0.5 * Math.log(v);
      cost += c;
      ll -= c;
      llN++;
      errS[q] += e * e - vf;
      errN[q] += 1;
      cE[i] = (wr * e) / v;
      cV[i] = 0.5 * (1 / v - (wr * e * e) / (v * v));
    }
    const stats = { ll: llN ? ll / llN : 0, errS, errN };
    if (!wantGrad) return { cost: cost + motionCost(), stats };

    gX.fill(0);
    gY.fill(0);
    hXX.fill(0);
    hXY.fill(0);
    hYY.fill(0);
    pX.fill(0);
    pY.fill(0);
    tB.fill(0);
    // Passo 2: contribuições de cada par (alvo a, dado b) nos dois sentidos.
    if (opts.useResidual) {
      const invh2 = 2 * inv2h2;
      for (let a = 0; a < M; a++) {
        const ra = a * A;
        for (let b = a + 1; b < M; b++) {
          if (floorIdx[b] !== floorIdx[a] || varOf[b] === varOf[a]) continue;
          const dx = X[a][0] - X[b][0];
          const dy = X[a][1] - X[b][1];
          const d2 = dx * dx + dy * dy;
          if (d2 > cut2) continue;
          const w = Math.exp(-d2 * inv2h2);
          const rb = b * A;
          // S = soma dos coeficientes que multiplicam a derivada do núcleo.
          let sAB = 0; // alvo a, dado b
          let sBA = 0; // alvo b, dado a
          for (let q = 0; q < A; q++) {
            const wb = wgt[rb + q];
            const ia = ra + q;
            if (wb > 0 && (cE[ia] !== 0 || cV[ia] !== 0)) {
              const a1 = cE[ia] * aInv[ia];
              const dev = wb * (resid[rb + q] - aR[ia]);
              sAB += -a1 * dev - cV[ia] * aVf[ia] * aInv[ia] * wb;
              // d(pred_a)/d(x_a) pelo núcleo (para a curvatura) e efeito de mexer b na lei de distância de b.
              pX[ia] += -w * dx * invh2 * dev * aInv[ia];
              pY[ia] += -w * dy * invh2 * dev * aInv[ia];
              tB[rb + q] += a1 * w * wb;
            }
            const wa = wgt[ra + q];
            const ib = rb + q;
            if (wa > 0 && (cE[ib] !== 0 || cV[ib] !== 0)) {
              const a1 = cE[ib] * aInv[ib];
              const dev = wa * (resid[ra + q] - aR[ib]);
              sBA += -a1 * dev - cV[ib] * aVf[ib] * aInv[ib] * wa;
              pX[ib] += w * dx * invh2 * dev * aInv[ib];
              pY[ib] += w * dy * invh2 * dev * aInv[ib];
              tB[ra + q] += a1 * w * wa;
            }
          }
          // dk/dx_a = -k (x_a - x_b)/h²; dk/dx_b = +k (x_a - x_b)/h². O núcleo é simétrico.
          const s = (sAB + sBA) * w * invh2;
          gX[a] -= s * dx;
          gY[a] -= s * dy;
          gX[b] += s * dx;
          gY[b] += s * dy;
        }
      }
    }
    // Termos diretos (lei de distância no próprio nó), efeito indireto pela lei de distância e curvatura.
    for (let a = 0; a < M; a++) {
      for (let q = 0; q < A; q++) {
        const i = a * A + q;
        if (cE[i] !== 0) {
          gX[a] -= cE[i] * bGx[i];
          gY[a] -= cE[i] * bGy[i];
          const px = bGx[i] + pX[i];
          const py = bGy[i] + pY[i];
          const wv = Math.abs(cE[i]) > 0 ? Math.min(1, Math.abs(cE[i] / (tgt[i] - baseV[i] - aR[i] || 1e-9))) : 0; // = wr/v
          hXX[a] += wv * px * px;
          hXY[a] += wv * px * py;
          hYY[a] += wv * py * py;
        }
        // Mexer o nó muda o resíduo dele (= leitura - lei de distância ali), que entra na previsão dos outros.
        // Para dado de censura o resíduo também acompanha a lei de distância.
        if (tB[i] !== 0) {
          gX[a] += tB[i] * bGx[i];
          gY[a] += tB[i] * bGy[i];
        }
      }
    }
    return { cost: cost + motionCost(true), stats };
  };

  // Custo (e gradiente/curvatura, se pedido) dos termos de movimento.
  const motionCost = (withGrad) => {
    let cost = 0;
    const lim = 1.5 * T.accSigma;
    for (let c0 = 1; c0 + 1 < M; c0++) {
      // Aceleração (caminho suave) nas trincas de quem anda.
      if (trans[c0 - 1].type !== 'walk' || trans[c0].type !== 'walk') continue;
      const cx = X[c0 - 1][0] - 2 * X[c0][0] + X[c0 + 1][0];
      const cy = X[c0 - 1][1] - 2 * X[c0][1] + X[c0 + 1][1];
      const cn = Math.hypot(cx, cy);
      // Curva fechada é permitida: cauda linear.
      cost += wAcc * (cn > lim ? lim * cn - 0.5 * lim * lim : 0.5 * cn * cn);
      if (withGrad) {
        const wr = wAcc * (cn > lim ? lim / cn : 1);
        gX[c0 - 1] += wr * cx;
        gY[c0 - 1] += wr * cy;
        gX[c0] -= 2 * wr * cx;
        gY[c0] -= 2 * wr * cy;
        gX[c0 + 1] += wr * cx;
        gY[c0 + 1] += wr * cy;
        hXX[c0 - 1] += wr;
        hYY[c0 - 1] += wr;
        hXX[c0] += 4 * wr;
        hYY[c0] += 4 * wr;
        hXX[c0 + 1] += wr;
        hYY[c0 + 1] += wr;
      }
    }
    for (let a = 0; a + 1 < M; a++) {
      // Molas de primeira ordem entre nós seguidos.
      const b = a + 1;
      if (varOf[a] === varOf[b]) continue;
      const tr = trans[a];
      const dx = X[b][0] - X[a][0];
      const dy = X[b][1] - X[a][1];
      const d = Math.hypot(dx, dy);
      let k1 = 0;
      let target = 0;
      if (tr.type === 'arrive') {
        k1 = 1 / (T.arriveSigma * tr.dt * T.arriveSigma * tr.dt);
      } else if (tr.type === 'leave') {
        k1 = 1 / (T.leaveSigma * tr.dt * T.leaveSigma * tr.dt);
        target = T.leaveSpeed * tr.dt;
      } else if (tr.type === 'free') {
        // Pulo entre pontos marcados no modo de 30 s: curto é mais provável, cauda longa.
        cost += T.freeW * Math.log(1 + (d * d) / (T.freeScale * T.freeScale));
        k1 = (2 * T.freeW) / (T.freeScale * T.freeScale + d * d);
        if (withGrad) {
          gX[a] -= k1 * dx;
          gY[a] -= k1 * dy;
          gX[b] += k1 * dx;
          gY[b] += k1 * dy;
          hXX[a] += k1;
          hYY[a] += k1;
          hXX[b] += k1;
          hYY[b] += k1;
        }
        continue;
      } else if (T.walkW > 0) {
        // Andando: passo perto do tamanho típico (mola fraca; a escala fina vem da correção da métrica).
        k1 = T.walkW / (T.walkSigma * tr.dt * T.walkSigma * tr.dt);
        target = T.walkSpeed * tr.dt;
      }
      const vmax = T.vMax * tr.dt + 0.3;
      if (d > vmax) {
        // Ninguém anda tão rápido.
        k1 = Math.max(k1, 4);
        target = Math.max(target, vmax);
      }
      if (!(k1 > 0)) continue;
      const e = d - target;
      cost += 0.5 * k1 * e * e;
      if (withGrad) {
        const f = d > 1e-6 ? (k1 * e) / d : 0;
        gX[a] -= f * dx;
        gY[a] -= f * dy;
        gX[b] += f * dx;
        gY[b] += f * dy;
        const kk = target > 0 ? k1 * 0.6 : k1;
        hXX[a] += kk;
        hYY[a] += kk;
        hXX[b] += kk;
        hYY[b] += kk;
      }
    }
    return cost;
  };

  const trace = [];
  for (let round = 0; round < opts.rounds; round++) {
    const h = opts.h1 + (opts.h0 - opts.h1) * (opts.rounds > 1 ? 1 - round / (opts.rounds - 1) : 0);
    params = fitBases(model, X, boundsOf(X, T.gridMargin));
    let alpha = T.stepSize;
    let cur = evaluate(h, true);
    for (let it = 0; it < opts.sweeps; it++) {
      // Passo de Newton por variável (curvatura em bloco 2x2), amortecido; recua se o custo subir.
      const prev = X.map((p) => [p[0], p[1]]);
      const stepX = new Float64Array(P);
      const stepY = new Float64Array(P);
      for (let p = 0; p < P; p++) {
        let gx = 0;
        let gy = 0;
        let hxx = 0;
        let hxy = 0;
        let hyy = 0;
        for (const a of members[p]) {
          gx += gX[a];
          gy += gY[a];
          hxx += hXX[a];
          hxy += hXY[a];
          hyy += hYY[a];
        }
        const mu = T.damping * members[p].length + 0.1 * (hxx + hyy);
        const a11 = hxx + mu;
        const a22 = hyy + mu;
        const det = a11 * a22 - hxy * hxy;
        if (!(det > 1e-12)) continue;
        let sx = -(a22 * gx - hxy * gy) / det;
        let sy = -(a11 * gy - hxy * gx) / det;
        const sn = Math.hypot(sx, sy);
        if (sn > T.maxStep) {
          sx *= T.maxStep / sn;
          sy *= T.maxStep / sn;
        }
        if (Number.isFinite(sx) && Number.isFinite(sy)) {
          stepX[p] = sx;
          stepY[p] = sy;
        }
      }
      let next = null;
      for (let tries = 0; tries < 4; tries++) {
        for (let a = 0; a < M; a++) X[a] = [prev[a][0] + alpha * stepX[varOf[a]], prev[a][1] + alpha * stepY[varOf[a]]];
        next = evaluate(h, true);
        if (next.cost <= cur.cost + 1e-9) break;
        alpha *= 0.5;
        next = null;
      }
      if (!next) {
        X = prev;
        cur = evaluate(h, true);
        break;
      }
      cur = next;
      alpha = Math.min(T.stepSize, alpha * 1.3);
    }
    // Ruído de cada rádio: erro quadrático de previsão menos a incerteza do campo.
    let sm = 0;
    for (let q = 0; q < A; q++) {
      const v = cur.stats.errN[q] > 3 ? cur.stats.errS[q] / cur.stats.errN[q] : T.sigmaNoise * T.sigmaNoise;
      sig2[q] = Math.max(4, Math.min(81, v));
      sm += Math.sqrt(sig2[q]);
    }
    sigmaMean = A ? sm / A : 0;
    heldOut = cur.stats.ll;
    trace.push(Number(heldOut.toFixed(3)));
    if (T.metric && opts.metric !== false) {
      X = metricCorrection(model, X, T, opts.info, `${opts.label}${round + 1}`);
      syncVars();
    }
    if (opts.onRound) opts.onRound(round, X);
  }
  if (opts.info) opts.info[`ll${opts.label}`] = trace;
  return { X: X.map((p) => [p[0], p[1]]), params, heldOut, sigmaMean };
}
