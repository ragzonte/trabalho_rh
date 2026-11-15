// Mapa só com Wi-Fi — candidato "graph": grafo de poses por semelhança de impressões digitais.
//
// v0: nós = lugares (uma varredura andando, ou um ponto marcado), arestas de tempo, fechamentos
// de circuito por semelhança, repulsão, e majoração de estresse (SMACOF) nó a nó.

import { FLOOR_HEIGHT } from '../types.js';

const STALE_MS = 3200; // leitura mais velha que isto é repetição do Android (as frescas vão até ~2,9 s)
const WALK_SPEED = 0.5; // m/s: deslocamento médio de quem anda dentro de casa (0,4 a 0,9 m/s, com curvas e paradas)
const MAX_SPEED = 1.2; // m/s: ninguém passa disto fazendo o levantamento

export function solve(survey, options = {}) {
  try {
    return solveInner(survey || {}, options || {});
  } catch (err) {
    return fallback(survey, String((err && err.stack) || err));
  }
}

function fallback(survey, why) {
  const scans = (survey && Array.isArray(survey.scans) && survey.scans) || [];
  return {
    points: scans.map((s) => ({ x: 0, y: 0, z: ((s && s.floor) || 0) * FLOOR_HEIGHT, conf: 0 })),
    aps: {},
    scaleConf: 0,
    debug: { error: why },
  };
}

// ---------------------------------------------------------------------------
// Preparação
// ---------------------------------------------------------------------------

function prepare(survey) {
  const scans = Array.isArray(survey.scans) ? survey.scans : [];
  const n = scans.length;
  const meta = survey.aps || {};
  // Rádio = (aparelho, faixa): os BSSIDs de um mesmo rádio medem quase a mesma coisa.
  const radioOf = new Map();
  const radios = [];
  const radioIdx = (id, freq) => {
    let k = radioOf.get(id);
    if (k !== undefined) return k;
    const m = meta[id] || {};
    const f = m.freq || freq || 2437;
    const band = f < 3000 ? 0 : f < 5925 ? 1 : 2;
    const key = `${m.device || id}|${band}`;
    k = radios.findIndex((r) => r.key === key);
    if (k < 0) {
      k = radios.length;
      radios.push({ key, device: m.device || id, band, bssids: [] });
    }
    radios[k].bssids.push(id);
    radioOf.set(id, k);
    return k;
  };
  for (const s of scans) for (const r of (s && s.readings) || []) if (r && typeof r.id === 'string' && Number.isFinite(r.rssi)) radioIdx(r.id, r.freq);
  const K = radios.length;

  // Impressão digital de cada varredura: média das leituras frescas de cada rádio (NaN = não ouviu).
  const fp = new Array(n);
  const all = [];
  for (let i = 0; i < n; i++) {
    const sum = new Float64Array(K);
    const cnt = new Float64Array(K);
    for (const r of (scans[i] && scans[i].readings) || []) {
      if (!r || typeof r.id !== 'string' || !Number.isFinite(r.rssi)) continue;
      if ((r.ageMs || 0) > STALE_MS) continue;
      const k = radioOf.get(r.id);
      sum[k] += r.rssi;
      cnt[k]++;
      all.push(r.rssi);
    }
    fp[i] = Float64Array.from(sum, (v, k) => (cnt[k] ? v / cnt[k] : NaN));
  }
  all.sort((a, b) => a - b);
  // Limiar de detecção: abaixo disto um rádio some da lista.
  const floorDbm = all.length ? all[Math.floor(all.length * 0.03)] + 2 : -88;

  // Nós: varreduras do mesmo ponto marcado dividem um nó.
  const nodeOf = new Int32Array(n);
  const nodes = [];
  const spotNode = new Map();
  for (let i = 0; i < n; i++) {
    const s = scans[i] || {};
    const spot = s.spot;
    let a = -1;
    if (spot !== null && spot !== undefined) {
      const key = `${spot}`;
      if (spotNode.has(key)) a = spotNode.get(key);
      else {
        a = nodes.length;
        nodes.push({ members: [], floor: s.floor || 0, spot: true });
        spotNode.set(key, a);
      }
    } else {
      a = nodes.length;
      nodes.push({ members: [], floor: s.floor || 0, spot: false });
    }
    nodes[a].members.push(i);
    nodeOf[i] = a;
  }
  const N = nodes.length;
  const nfp = new Array(N);
  for (let a = 0; a < N; a++) {
    const sum = new Float64Array(K);
    const cnt = new Float64Array(K);
    for (const i of nodes[a].members) {
      for (let k = 0; k < K; k++) {
        if (!Number.isNaN(fp[i][k])) {
          sum[k] += fp[i][k];
          cnt[k]++;
        }
      }
    }
    nfp[a] = Float64Array.from(sum, (v, k) => (cnt[k] ? v / cnt[k] : NaN));
  }
  const tOf = (i) => (scans[i] && Number.isFinite(scans[i].t) ? scans[i].t : i * 3.5);
  return { scans, n, radios, K, fp, nodeOf, nodes, N, nfp, floorDbm, tOf, radioOf };
}

// Dissimilaridade (dB²) entre duas impressões digitais; quem falta de um lado só conta
// pelo quanto o outro lado passou do limiar de detecção.
function dissim2(a, b, K, floorDbm) {
  let s = 0;
  let u = 0;
  for (let k = 0; k < K; k++) {
    const x = a[k];
    const y = b[k];
    const mx = x !== x;
    const my = y !== y;
    if (mx && my) continue;
    let d;
    if (mx) d = Math.max(0, y - floorDbm);
    else if (my) d = Math.max(0, x - floorDbm);
    else d = x - y;
    s += d * d;
    u++;
  }
  return u ? s / u : NaN;
}

function median(values) {
  if (!values.length) return NaN;
  const v = Array.from(values).sort((a, b) => a - b);
  const m = (v.length - 1) / 2;
  return (v[Math.floor(m)] + v[Math.ceil(m)]) / 2;
}

// ---------------------------------------------------------------------------
// Solução
// ---------------------------------------------------------------------------

function solveInner(survey, options) {
  const P = prepare(survey);
  const { scans, n, N, nodes, nodeOf, K, nfp, floorDbm, tOf } = P;
  if (n === 0) return { points: [], aps: {}, scaleConf: 0 };
  const stages = {};

  // --- arestas de tempo entre nós ---
  const timeEdges = new Map(); // "a|b" -> dt
  const adj = Array.from({ length: N }, () => new Set());
  for (let i = 0; i + 1 < n; i++) {
    const a = nodeOf[i];
    const b = nodeOf[i + 1];
    if (a === b) continue;
    const dt = Math.max(0.5, tOf(i + 1) - tOf(i));
    const key = a < b ? a * N + b : b * N + a;
    if (!timeEdges.has(key) || timeEdges.get(key) > dt) timeEdges.set(key, dt);
    adj[a].add(b);
    adj[b].add(a);
  }

  // --- dissimilaridade entre nós (mesmo andar), bruta e borrada no tempo ---
  const D2 = new Float64Array(N * N).fill(NaN);
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      D2[a * N + b] = D2[b * N + a] = dissim2(nfp[a], nfp[b], K, floorDbm);
    }
    D2[a * N + a] = 0;
  }
  // Borrão da matriz: média com os vizinhos de tempo (só nós "andando", vizinhos a menos de 6 s).
  const nb = nodes.map((nd, a) => {
    const list = [[a, 1]];
    if (!nd.spot) {
      for (const b of adj[a]) {
        const key = a < b ? a * N + b : b * N + a;
        if (timeEdges.get(key) <= 6 && nodes[b].floor === nd.floor && !nodes[b].spot) list.push([b, 0.5]);
      }
    }
    return list;
  });
  const B2 = new Float64Array(N * N).fill(NaN);
  for (let a = 0; a < N; a++) {
    for (let b = a + 1; b < N; b++) {
      let s = 0;
      let w = 0;
      for (const [p, wp] of nb[a]) {
        for (const [q, wq] of nb[b]) {
          const v = D2[p * N + q];
          if (v !== v || p === q) continue;
          s += wp * wq * v;
          w += wp * wq;
        }
      }
      B2[a * N + b] = B2[b * N + a] = w > 0 ? s / w : D2[a * N + b];
    }
  }

  // --- calibração dB² -> metros nos pares consecutivos ---
  const lag1 = [];
  let stepSum = 0;
  let stepCnt = 0;
  for (const [key, dt] of timeEdges) {
    const a = Math.floor(key / N);
    const b = key % N;
    if (dt > 6 || nodes[a].floor !== nodes[b].floor) continue;
    const v = D2[a * N + b];
    if (v === v) lag1.push(v);
    stepSum += WALK_SPEED * dt;
    stepCnt++;
  }
  const haveTime = lag1.length >= 8;
  const stepM = haveTime ? stepSum / stepCnt : 2.0;
  const d1 = haveTime ? median(lag1) : NaN;
  // Piso de ruído: pares do mesmo ponto quando existem; senão uma fração do par consecutivo.
  let noise2 = haveTime ? 0.55 * d1 : NaN;
  let slope; // dB² por metro
  if (haveTime) slope = Math.max(1e-6, (d1 - noise2) / stepM);
  else {
    // Sem pares consecutivos (uma varredura a cada 30 s): chute largo, corrigido depois pela física.
    const allPairs = [];
    for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) if (D2[a * N + b] === D2[a * N + b]) allPairs.push(D2[a * N + b]);
    const lo = allPairs.length ? allPairs.sort((x, y) => x - y)[Math.floor(allPairs.length * 0.02)] : 20;
    noise2 = lo * 0.8;
    slope = 25;
  }
  const toMetres = (v) => Math.max(0, v - noise2) / slope;

  // --- arestas ---
  // tipo 0 = alvo (puxa e empurra), 1 = só teto (d <= alvo), 2 = só piso (d >= alvo)
  const edges = [];
  const addEdge = (a, b, target, w, kind) => edges.push({ a, b, target, w, kind });
  for (const [key, dt] of timeEdges) {
    const a = Math.floor(key / N);
    const b = key % N;
    const sameFloor = nodes[a].floor === nodes[b].floor;
    if (dt <= 6 && sameFloor) {
      const m = toMetres(D2[a * N + b]);
      const target = Math.min(MAX_SPEED * dt, Math.max(0.3 * WALK_SPEED * dt, Number.isFinite(m) ? m : WALK_SPEED * dt));
      addEdge(a, b, target, 1, 0);
    } else if (dt <= 12) {
      addEdge(a, b, MAX_SPEED * dt, 1, 1); // escada ou intervalo maior: só o limite de velocidade
    } else {
      // 30 s entre varreduras: o usuário foi até o próximo ponto, que costuma ser perto.
      const m = toMetres(D2[a * N + b]);
      if (sameFloor && Number.isFinite(m)) addEdge(a, b, m, 0.5, 0);
    }
  }
  // Fechamentos de circuito: os k vizinhos mais parecidos (fora da vizinhança de tempo).
  const KNN = 6;
  const closureMax = 2.5 * stepM;
  const seen = new Set(timeEdges.keys());
  for (let a = 0; a < N; a++) {
    const cand = [];
    for (let b = 0; b < N; b++) {
      if (b === a || nodes[b].floor !== nodes[a].floor) continue;
      const v = B2[a * N + b];
      if (v !== v) continue;
      cand.push(b);
    }
    cand.sort((p, q) => B2[a * N + p] - B2[a * N + q]);
    for (let r = 0; r < Math.min(KNN, cand.length); r++) {
      const b = cand[r];
      const m = toMetres(B2[a * N + b]);
      if (m > closureMax) break;
      const key = a < b ? a * N + b : b * N + a;
      if (seen.has(key)) continue;
      seen.add(key);
      addEdge(a, b, Math.max(0.3, m), 0.5, 0);
    }
  }

  // --- geodésicas no grafo (Floyd–Warshall em blocos pequenos; N é da ordem de 200) ---
  const G = new Float64Array(N * N).fill(Infinity);
  for (let a = 0; a < N; a++) G[a * N + a] = 0;
  for (const e of edges) {
    const len = e.kind === 1 ? 0.5 * e.target : Math.max(0.2, e.target);
    if (len < G[e.a * N + e.b]) G[e.a * N + e.b] = G[e.b * N + e.a] = len;
  }
  for (let k = 0; k < N; k++) {
    for (let i = 0; i < N; i++) {
      const ik = G[i * N + k];
      if (ik === Infinity) continue;
      for (let j = 0; j < N; j++) {
        const v = ik + G[k * N + j];
        if (v < G[i * N + j]) G[i * N + j] = v;
      }
    }
  }
  // Componentes desconexas: liga com uma distância grande para o MDS não quebrar.
  let gmax = 0;
  for (let i = 0; i < N * N; i++) if (G[i] !== Infinity && G[i] > gmax) gmax = G[i];
  for (let i = 0; i < N * N; i++) if (G[i] === Infinity) G[i] = gmax || 1;

  // --- partida: MDS clássico sobre as geodésicas ---
  const X = classicalMds(G, N);
  stages.isomap = expand(X, nodeOf, n);

  // --- SMACOF nó a nó: arestas locais fortes + geodésicas fracas para todos os pares ---
  const lists = Array.from({ length: N }, () => []);
  for (const e of edges) {
    lists[e.a].push({ j: e.b, target: e.target, w: e.w / Math.max(0.25, e.target * e.target), kind: e.kind });
    lists[e.b].push({ j: e.a, target: e.target, w: e.w / Math.max(0.25, e.target * e.target), kind: e.kind });
  }
  const GEO_W = 0.15;
  for (let it = 0; it < 150; it++) {
    for (let a = 0; a < N; a++) {
      let sx = 0;
      let sy = 0;
      let sw = 0;
      const xa = X[a][0];
      const ya = X[a][1];
      for (const e of lists[a]) {
        const dx = xa - X[e.j][0];
        const dy = ya - X[e.j][1];
        const d = Math.hypot(dx, dy);
        if (e.kind === 1 && d <= e.target) continue;
        if (e.kind === 2 && d >= e.target) continue;
        const r = d > 1e-9 ? e.target / d : 0;
        sx += e.w * (X[e.j][0] + dx * r);
        sy += e.w * (X[e.j][1] + dy * r);
        sw += e.w;
      }
      for (let b = 0; b < N; b++) {
        if (b === a) continue;
        const g = G[a * N + b];
        const w = GEO_W / (g * g + 1);
        const dx = xa - X[b][0];
        const dy = ya - X[b][1];
        const d = Math.hypot(dx, dy);
        const r = d > 1e-9 ? g / d : 0;
        sx += w * (X[b][0] + dx * r);
        sy += w * (X[b][1] + dy * r);
        sw += w;
      }
      if (sw > 0) {
        X[a][0] = sx / sw;
        X[a][1] = sy / sw;
      }
    }
  }
  stages.smacof = expand(X, nodeOf, n);

  const pts = expand(X, nodeOf, n);
  const points = pts.map((p, i) => ({ x: p.x, y: p.y, z: ((scans[i] && scans[i].floor) || 0) * FLOOR_HEIGHT, conf: 0.5 }));
  const aps = regressAps(P, points);
  return { points, aps, scaleConf: haveTime ? 0.5 : 0.2, debug: { stages, info: `d1=${d1.toFixed(0)} noise=${noise2.toFixed(0)} slope=${slope.toFixed(1)} step=${stepM.toFixed(2)} E=${edges.length}` } };
}

function expand(X, nodeOf, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { x: X[nodeOf[i]][0], y: X[nodeOf[i]][1] };
  return out;
}

// Roteadores: centro dos pontos onde chegaram mais forte + curva ajustada (provisório).
function regressAps(P, points) {
  const { scans, radios, fp, n } = P;
  const aps = {};
  radios.forEach((radio, k) => {
    const seen = [];
    for (let i = 0; i < n; i++) if (!Number.isNaN(fp[i][k])) seen.push({ i, r: fp[i][k] });
    if (seen.length < 3) return;
    seen.sort((p, q) => q.r - p.r);
    const top = seen.slice(0, 5);
    let w = 0;
    let x = 0;
    let y = 0;
    for (const t of top) {
      const wt = 10 ** (t.r / 20);
      w += wt;
      x += wt * points[t.i].x;
      y += wt * points[t.i].y;
    }
    const ap = { x: x / w, y: y / w, z: points[top[0].i].z + 1, p0: top[0].r + 3, n: 2.5, conf: 0.2 };
    for (const id of radio.bssids) aps[id] = { ...ap };
  });
  void scans;
  return aps;
}

// MDS clássico (dois maiores autovetores por iteração de subespaço) sobre distâncias D (não ao quadrado).
function classicalMds(D, n) {
  if (n === 1) return [[0, 0]];
  const B = new Float64Array(n * n);
  const rowMean = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += D[i * n + j] * D[i * n + j];
    rowMean[i] = s / n;
    total += s;
  }
  total /= n * n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) B[i * n + j] = -0.5 * (D[i * n + j] * D[i * n + j] - rowMean[i] - rowMean[j] + total);
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
  for (let it = 0; it < 120; it++) {
    q1 = mul(q1);
    normalize(q1);
    q2 = mul(q2);
    const p = dot(q1, q2);
    for (let i = 0; i < n; i++) q2[i] -= p * q1[i];
    normalize(q2);
  }
  const s1 = Math.sqrt(Math.max(0, dot(q1, mul(q1))));
  const s2 = Math.sqrt(Math.max(0, dot(q2, mul(q2))));
  return Array.from({ length: n }, (_, i) => [q1[i] * s1, q2[i] * s2]);
}
