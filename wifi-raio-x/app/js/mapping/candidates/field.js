// Mapa só com Wi-Fi — candidato "field" (campos de sinal latentes, família WiFi-SLAM / GP-LVM).
// v0: esqueleto ponta a ponta (dissimilaridade de impressões digitais -> MDS -> escala pelo passo).

import { FLOOR_HEIGHT } from '../types.js';

const FRESH_MS = 3400; // leitura mais velha que isto é repetição do Android (descreve um lugar anterior)

const DEFAULTS = {
  noiseQuantile: 0.1,
  distPower: 1, // 1: d ∝ (δ² − δ0²)^(1/2) ; 2: d ∝ δ² − δ0²
  smacofIters: 120,
  weightPower: 2,
  crossFloorWeight: 0.3,
  walkSpeed: 0.45, // m/s: corda mediana entre varreduras seguidas de quem anda fazendo o levantamento
  dbToM: 0.45,
  refine: 1,
  h: 1.0, // largura do núcleo dos campos (m)
  lambda: 0.5, // encolhimento da previsão quando há poucos vizinhos
  sigma: 4, // dB
  vmax: 0.9,
  motionW: 4,
  motionSlack: 0.5,
  outer: 4,
  inner: 40,
  missW: 0.5,
};

export function solve(survey, options = {}) {
  try {
    return solveInner(survey, options || {});
  } catch (err) {
    return fallbackSolution(survey, String((err && err.stack) || err));
  }
}

function fallbackSolution(survey, error) {
  const scans = (survey && Array.isArray(survey.scans) && survey.scans) || [];
  return {
    points: scans.map((s) => ({ x: 0, y: 0, z: (Number(s && s.floor) || 0) * FLOOR_HEIGHT, conf: 0 })),
    aps: {},
    scaleConf: 0,
    debug: { error },
  };
}

function solveInner(survey, options) {
  const P = { ...DEFAULTS, ...(options.params || {}) };
  const data = prepare(survey);
  if (data.M < 3) return fallbackSolution(survey, 'poucos pontos');
  data.edges = motionEdges(data);
  const diss = dissimilarity(data, P);
  let X = embed(data, diss, P);
  X = rescale(data, X, diss, P);
  const dbg = {};
  if (P.refine) X = refineFields(data, X, P, dbg, diss);
  const out = finish(survey, data, X);
  out.debug = dbg;
  return out;
}

// ---------------------------------------------------------------------------
// Preparação: rádios (aparelho + faixa), nós (um por ponto marcado ou varredura andando)
// ---------------------------------------------------------------------------

function prepare(survey) {
  const scans = survey.scans || [];
  const apMeta = survey.aps || {};
  const radioIndex = new Map();
  const radios = [];
  const radioOf = (id, freq) => {
    const meta = apMeta[id] || {};
    const f = meta.freq || freq || 2437;
    const band = f < 3000 ? 0 : f < 5925 ? 1 : 2;
    const key = `${meta.device || id}|${band}`;
    let r = radioIndex.get(key);
    if (r === undefined) {
      r = radios.length;
      radioIndex.set(key, r);
      radios.push({ key, device: meta.device || id, band, ids: [] });
    }
    return r;
  };
  const idRadio = new Map();
  for (const s of scans) {
    for (const r of s.readings || []) {
      if (!idRadio.has(r.id)) {
        const k = radioOf(r.id, r.freq);
        idRadio.set(r.id, k);
        radios[k].ids.push(r.id);
      }
    }
  }
  const R = radios.length;

  // Nós: varreduras com o mesmo `spot` dividem a posição.
  const nodeOfScan = new Int32Array(scans.length);
  const nodes = [];
  const spotNode = new Map();
  scans.forEach((s, i) => {
    let a;
    if (s.spot != null && spotNode.has(s.spot)) a = spotNode.get(s.spot);
    else {
      a = nodes.length;
      nodes.push({ scans: [], floor: Number(s.floor) || 0, spot: s.spot ?? null, label: null });
      if (s.spot != null) spotNode.set(s.spot, a);
    }
    nodes[a].scans.push(i);
    if (s.label) nodes[a].label = s.label;
    nodeOfScan[i] = a;
  });
  const M = nodes.length;

  // Impressão digital de cada nó: média das leituras frescas de cada rádio.
  const F = new Float64Array(M * R).fill(NaN);
  const cnt = new Float64Array(M * R);
  const sum = new Float64Array(M * R);
  const all = [];
  scans.forEach((s, i) => {
    const a = nodeOfScan[i];
    const acc = new Map();
    for (const r of s.readings || []) {
      if (!Number.isFinite(r.rssi) || (r.ageMs ?? 0) > FRESH_MS) continue;
      const k = idRadio.get(r.id);
      const e = acc.get(k) || [0, 0];
      e[0] += r.rssi;
      e[1]++;
      acc.set(k, e);
      all.push(r.rssi);
    }
    for (const [k, e] of acc) {
      sum[a * R + k] += e[0] / e[1];
      cnt[a * R + k]++;
    }
  });
  for (let q = 0; q < M * R; q++) if (cnt[q] > 0) F[q] = sum[q] / cnt[q];
  all.sort((p, q) => p - q);
  const floorLevel = all.length ? all[Math.floor(all.length * 0.03)] : -90; // limiar de detecção observado
  return { scans, nodes, nodeOfScan, radios, idRadio, R, M, F, cnt, floorLevel };
}

// ---------------------------------------------------------------------------
// Dissimilaridade entre nós
// ---------------------------------------------------------------------------

function dissimilarity(data, P) {
  const { M, R, F, nodes, floorLevel } = data;
  // Média de cada rádio por andar (a laje entra como deslocamento): tirada só nos pares de andares diferentes.
  const floors = [...new Set(nodes.map((n) => n.floor))];
  const mean = new Map();
  for (const f of floors) {
    const m = new Float64Array(R);
    for (let k = 0; k < R; k++) {
      let s = 0;
      let c = 0;
      for (let a = 0; a < M; a++) {
        if (nodes[a].floor !== f) continue;
        const v = F[a * R + k];
        s += Number.isNaN(v) ? floorLevel : v;
        c++;
      }
      m[k] = c ? s / c : floorLevel;
    }
    mean.set(f, m);
  }
  const D2 = new Float64Array(M * M); // δ² médio em dB²
  const W = new Float64Array(M * M);
  for (let a = 0; a < M; a++) {
    for (let b = a + 1; b < M; b++) {
      const same = nodes[a].floor === nodes[b].floor;
      const ma = mean.get(nodes[a].floor);
      const mb = mean.get(nodes[b].floor);
      let s = 0;
      let c = 0;
      for (let k = 0; k < R; k++) {
        let va = F[a * R + k];
        let vb = F[b * R + k];
        const na = Number.isNaN(va);
        const nb = Number.isNaN(vb);
        if (na && nb) continue;
        if (na) va = Math.min(floorLevel, vb);
        if (nb) vb = Math.min(floorLevel, va);
        let d = va - vb;
        if (!same) d -= ma[k] - mb[k];
        s += d * d;
        c++;
      }
      const v = c >= 2 ? s / c : NaN;
      D2[a * M + b] = D2[b * M + a] = v;
      W[a * M + b] = W[b * M + a] = c >= 2 ? (same ? 1 : P.crossFloorWeight) : 0;
    }
  }
  return { D2, W };
}

// ---------------------------------------------------------------------------
// Imersão inicial: MDS métrico (SMACOF) com pesos
// ---------------------------------------------------------------------------

function embed(data, diss, P) {
  const { M } = data;
  const { D2, W } = diss;
  // Piso de ruído: quantil baixo das dissimilaridades (pares no mesmo lugar ainda diferem pelo ruído).
  const vals = [];
  for (let a = 0; a < M; a++) for (let b = a + 1; b < M; b++) if (W[a * M + b] > 0) vals.push(D2[a * M + b]);
  vals.sort((p, q) => p - q);
  const noise2 = vals.length ? vals[Math.floor(vals.length * 0.02)] : 0;
  const T = new Float64Array(M * M); // distância-alvo (unidade arbitrária)
  const Wt = new Float64Array(M * M);
  for (let a = 0; a < M; a++) {
    for (let b = 0; b < M; b++) {
      if (a === b || !(W[a * M + b] > 0)) continue;
      const e = Math.max(0.05 * noise2 + 1e-6, D2[a * M + b] - noise2);
      const d = P.distPower === 2 ? e : Math.sqrt(e);
      T[a * M + b] = d;
      Wt[a * M + b] = W[a * M + b] / Math.pow(d, P.weightPower);
    }
  }
  diss.T = T;
  // Partida: MDS clássico sobre T.
  let X = classicalMds(T, M);
  X = smacof(X, T, Wt, M, P.smacofIters);
  return X;
}

function classicalMds(T, n) {
  const rowMean = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += T[i * n + j] * T[i * n + j];
    rowMean[i] = s / n;
    total += s;
  }
  total /= n * n;
  const B = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) B[i * n + j] = -0.5 * (T[i * n + j] * T[i * n + j] - rowMean[i] - rowMean[j] + total);
  }
  let q1 = Float64Array.from({ length: n }, (_, i) => Math.sin(1.7 * i + 0.3));
  let q2 = Float64Array.from({ length: n }, (_, i) => Math.cos(2.9 * i + 1.1));
  const mul = (v) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += B[i * n + j] * v[j];
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
  for (let it = 0; it < 100; it++) {
    q1 = mul(q1);
    normalize(q1);
    q2 = mul(q2);
    const p = dot(q1, q2);
    for (let i = 0; i < n; i++) q2[i] -= p * q1[i];
    normalize(q2);
  }
  const s1 = Math.sqrt(Math.max(0, dot(q1, mul(q1))));
  const s2 = Math.sqrt(Math.max(0, dot(q2, mul(q2))));
  const X = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    X[2 * i] = q1[i] * s1;
    X[2 * i + 1] = q2[i] * s2;
  }
  return X;
}

// SMACOF: minimiza Σ w (|xi − xj| − t)² por majoração.
function smacof(X0, T, W, n, iters) {
  let X = Float64Array.from(X0);
  const wsum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += W[i * n + j];
    wsum[i] = s;
  }
  for (let it = 0; it < iters; it++) {
    const Y = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      let sx = 0;
      let sy = 0;
      const xi = X[2 * i];
      const yi = X[2 * i + 1];
      for (let j = 0; j < n; j++) {
        const w = W[i * n + j];
        if (!(w > 0)) continue;
        const dx = xi - X[2 * j];
        const dy = yi - X[2 * j + 1];
        const d = Math.sqrt(dx * dx + dy * dy);
        const r = d > 1e-9 ? T[i * n + j] / d : 0;
        // Jacobi ponderado: xi <- média_j w (xj + t (xi − xj)/d)
        sx += w * (X[2 * j] + r * dx);
        sy += w * (X[2 * j + 1] + r * dy);
      }
      if (wsum[i] > 0) {
        Y[2 * i] = sx / wsum[i];
        Y[2 * i + 1] = sy / wsum[i];
      } else {
        Y[2 * i] = xi;
        Y[2 * i + 1] = yi;
      }
    }
    X = Y;
  }
  return X;
}

// ---------------------------------------------------------------------------
// Escala: passo de quem anda
// ---------------------------------------------------------------------------

// Tempo em que o usuário pôde andar entre duas varreduras seguidas (s): [esperado, máximo].
// A posição de uma varredura é a do meio da varredura (~1,35 s antes da entrega). Quem marca um
// ponto fica parado desde antes do começo da varredura (~3 s antes da entrega) até pouco depois dela.
function movingTime(prev, next) {
  const dt = next.t - prev.t;
  if (!(dt > 0)) return [0, 0];
  if (!prev.still && !next.still) return [dt, dt];
  if (prev.still && !next.still) return [Math.max(0.2, dt - 2.0), Math.max(0.2, dt - 1.6)];
  if (!prev.still && next.still) return [Math.max(0.2, (dt - 1.65) / 2), Math.max(0.2, dt - 1.65)];
  return [Math.max(0.2, (dt - 3.3) / 2), Math.max(0.2, dt - 3.3)];
}

function motionEdges(data) {
  const { scans, nodeOfScan } = data;
  const edges = [];
  for (let i = 1; i < scans.length; i++) {
    const a = nodeOfScan[i - 1];
    const b = nodeOfScan[i];
    if (a === b) continue;
    const [texp, tmax] = movingTime(scans[i - 1], scans[i]);
    if (!(tmax > 0)) continue;
    // Só as arestas curtas dizem algo sobre a distância percorrida.
    edges.push({ a, b, texp, tmax, informative: tmax <= 8 });
  }
  return edges;
}

// Escala pelo passo: soma das cordas / soma do tempo andando = velocidade média de corda.
function stepScale(data, X, P) {
  let sd = 0;
  let st = 0;
  for (const e of data.edges) {
    if (!e.informative) continue;
    sd += Math.hypot(X[2 * e.a] - X[2 * e.b], X[2 * e.a + 1] - X[2 * e.b + 1]);
    st += e.texp;
  }
  if (st < 40 || !(sd > 0)) return null;
  return (P.walkSpeed * st) / sd;
}

function radiusOf(X) {
  const n = X.length / 2;
  let cx = 0;
  let cy = 0;
  for (let a = 0; a < n; a++) {
    cx += X[2 * a];
    cy += X[2 * a + 1];
  }
  cx /= n;
  cy /= n;
  let s = 0;
  for (let a = 0; a < n; a++) s += (X[2 * a] - cx) ** 2 + (X[2 * a + 1] - cy) ** 2;
  return Math.sqrt(s / n);
}

function rescale(data, X, diss, P) {
  let k = stepScale(data, X, P);
  if (k == null) {
    if (P.keepRadius) k = P.keepRadius / Math.max(1e-9, radiusOf(X));
    else k = P.distPower === 2 ? P.dbToM * 0.1 : P.dbToM;
  }
  return X.map((v) => v * k);
}

// ---------------------------------------------------------------------------
// Refino: campos latentes (regressão por núcleo, deixando o próprio ponto de fora) + movimento
// ---------------------------------------------------------------------------

function refineFields(data, X0, P, dbg, diss) {
  const { M, R, F, cnt, nodes, scans, nodeOfScan, floorLevel } = data;
  // Observações por nó/rádio: valor, peso, e se é "não ouvido" (censurado).
  const val = new Float64Array(M * R);
  const wgt = new Float64Array(M * R);
  const miss = new Uint8Array(M * R);
  const floors = [...new Set(nodes.map((n) => n.floor))];
  for (let k = 0; k < R; k++) {
    for (const f of floors) {
      let s = 0;
      let c = 0;
      for (let a = 0; a < M; a++) {
        if (nodes[a].floor !== f) continue;
        const v = F[a * R + k];
        s += Number.isNaN(v) ? floorLevel - 2 : v;
        c++;
      }
      const mean = c ? s / c : floorLevel;
      for (let a = 0; a < M; a++) {
        if (nodes[a].floor !== f) continue;
        const v = F[a * R + k];
        if (Number.isNaN(v)) {
          val[a * R + k] = floorLevel - 2 - mean;
          wgt[a * R + k] = P.missW;
          miss[a * R + k] = 1;
        } else {
          val[a * R + k] = v - mean;
          wgt[a * R + k] = Math.min(2, cnt[a * R + k]);
        }
      }
    }
  }
  const edges = data.edges;
  const sameFloor = (a, b) => nodes[a].floor === nodes[b].floor;
  const inv2h2 = 1 / (2 * P.h * P.h);
  const s2 = P.sigma * P.sigma;
  const num = new Float64Array(M * R);
  const den = new Float64Array(M * R);
  const g1 = new Float64Array(M * R); // dcusto/dpred
  const pred = new Float64Array(M * R);
  const Wm = new Float64Array(M * M);

  const cost = (X, G) => {
    G.fill(0);
    num.fill(0);
    den.fill(0);
    for (let a = 0; a < M; a++) {
      for (let b = a + 1; b < M; b++) {
        if (!sameFloor(a, b)) {
          Wm[a * M + b] = 0;
          continue;
        }
        const dx = X[2 * a] - X[2 * b];
        const dy = X[2 * a + 1] - X[2 * b + 1];
        const w = Math.exp(-(dx * dx + dy * dy) * inv2h2);
        Wm[a * M + b] = Wm[b * M + a] = w;
        if (w < 1e-4) continue;
        const ra = a * R;
        const rb = b * R;
        for (let k = 0; k < R; k++) {
          num[ra + k] += w * wgt[rb + k] * val[rb + k];
          den[ra + k] += w * wgt[rb + k];
          num[rb + k] += w * wgt[ra + k] * val[ra + k];
          den[rb + k] += w * wgt[ra + k];
        }
      }
    }
    let c = 0;
    for (let q = 0; q < M * R; q++) {
      const D = den[q] + P.lambda;
      const p = num[q] / D;
      pred[q] = p;
      let e = val[q] - p;
      if (miss[q]) {
        // Não ouvido: só custa se o campo prevê sinal acima do limiar.
        e = e < 0 ? e : 0;
      }
      // Huber
      const ae = Math.abs(e);
      const cut = 2.5 * P.sigma;
      let dc;
      if (ae <= cut) {
        c += (wgt[q] * e * e) / (2 * s2);
        dc = (wgt[q] * e) / s2;
      } else {
        c += (wgt[q] * (cut * ae - 0.5 * cut * cut)) / s2;
        dc = (wgt[q] * cut * Math.sign(e)) / s2;
      }
      g1[q] = -dc / D; // d custo / d num (o termo em den entra com −pred)
    }
    for (let a = 0; a < M; a++) {
      for (let b = a + 1; b < M; b++) {
        const w = Wm[a * M + b];
        if (w < 1e-4) continue;
        const ra = a * R;
        const rb = b * R;
        let dw = 0;
        for (let k = 0; k < R; k++) {
          dw += g1[ra + k] * wgt[rb + k] * (val[rb + k] - pred[ra + k]);
          dw += g1[rb + k] * wgt[ra + k] * (val[ra + k] - pred[rb + k]);
        }
        const f = -dw * w * 2 * inv2h2;
        const dx = X[2 * a] - X[2 * b];
        const dy = X[2 * a + 1] - X[2 * b + 1];
        G[2 * a] += f * dx;
        G[2 * a + 1] += f * dy;
        G[2 * b] -= f * dx;
        G[2 * b + 1] -= f * dy;
      }
    }
    // Movimento: ninguém anda mais que vmax.
    for (const e of edges) {
      const dx = X[2 * e.a] - X[2 * e.b];
      const dy = X[2 * e.a + 1] - X[2 * e.b + 1];
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-9;
      const lim = P.vmax * e.tmax;
      if (d > lim) {
        const ex = (d - lim) / P.motionSlack;
        c += 0.5 * P.motionW * ex * ex;
        const f = (P.motionW * ex) / P.motionSlack / d;
        G[2 * e.a] += f * dx;
        G[2 * e.a + 1] += f * dy;
        G[2 * e.b] -= f * dx;
        G[2 * e.b + 1] -= f * dy;
      }
    }
    return c;
  };
  let X = Float64Array.from(X0);
  if (P.gradCheck) {
    const G = new Float64Array(2 * M);
    const c0 = cost(X, G);
    const Gs = Float64Array.from(G);
    const tmp = new Float64Array(2 * M);
    const out = [];
    for (const q of [0, 1, 7, 2 * M - 3]) {
      const Xp = Float64Array.from(X);
      Xp[q] += 1e-5;
      const c1 = cost(Xp, tmp);
      out.push([Gs[q], (c1 - c0) / 1e-5]);
    }
    dbg.gradCheck = out;
  }
  const hist = [];
  const radius0 = radiusOf(X);
  for (let o = 0; o < P.outer; o++) {
    const r = lbfgs(cost, X, P.inner);
    X = rescale(data, r.x, diss, { ...P, keepRadius: radius0 });
    hist.push(r.f);
  }
  dbg.costHist = hist;
  return X;
}

// L-BFGS compacto com busca linear por recuo (Armijo).
function lbfgs(fn, x0, maxIter, mem = 8) {
  const n = x0.length;
  let x = Float64Array.from(x0);
  let g = new Float64Array(n);
  let f = fn(x, g);
  const S = [];
  const Y = [];
  const rho = [];
  let step0 = 1;
  for (let it = 0; it < maxIter; it++) {
    // direção
    const q = Float64Array.from(g);
    const alpha = new Array(S.length);
    for (let i = S.length - 1; i >= 0; i--) {
      let a = 0;
      for (let k = 0; k < n; k++) a += S[i][k] * q[k];
      a *= rho[i];
      alpha[i] = a;
      for (let k = 0; k < n; k++) q[k] -= a * Y[i][k];
    }
    if (S.length) {
      const i = S.length - 1;
      let yy = 0;
      let sy = 0;
      for (let k = 0; k < n; k++) {
        yy += Y[i][k] * Y[i][k];
        sy += S[i][k] * Y[i][k];
      }
      const gam = sy / (yy || 1);
      for (let k = 0; k < n; k++) q[k] *= gam;
    } else {
      let gn = 0;
      for (let k = 0; k < n; k++) gn += g[k] * g[k];
      const sc = 0.3 / (Math.sqrt(gn / n) + 1e-12); // primeiro passo: ~0,3 m por coordenada
      for (let k = 0; k < n; k++) q[k] *= sc;
    }
    for (let i = 0; i < S.length; i++) {
      let b = 0;
      for (let k = 0; k < n; k++) b += Y[i][k] * q[k];
      b *= rho[i];
      for (let k = 0; k < n; k++) q[k] += S[i][k] * (alpha[i] - b);
    }
    let dg = 0;
    for (let k = 0; k < n; k++) dg -= q[k] * g[k];
    if (!(dg < 0)) {
      // direção ruim: volta ao gradiente
      S.length = Y.length = rho.length = 0;
      let gn = 0;
      for (let k = 0; k < n; k++) gn += g[k] * g[k];
      if (gn < 1e-20) break;
      const sc = 0.1 / (Math.sqrt(gn / n) + 1e-12);
      for (let k = 0; k < n; k++) q[k] = g[k] * sc;
      dg = 0;
      for (let k = 0; k < n; k++) dg -= q[k] * g[k];
    }
    let t = step0;
    let xn = new Float64Array(n);
    let gn2 = new Float64Array(n);
    let fn2 = Infinity;
    let ok = false;
    for (let ls = 0; ls < 12; ls++) {
      for (let k = 0; k < n; k++) xn[k] = x[k] - t * q[k];
      fn2 = fn(xn, gn2);
      if (Number.isFinite(fn2) && fn2 <= f + 1e-4 * t * dg) {
        ok = true;
        break;
      }
      t *= 0.5;
    }
    if (!ok) break;
    const s = new Float64Array(n);
    const y = new Float64Array(n);
    let sy = 0;
    for (let k = 0; k < n; k++) {
      s[k] = xn[k] - x[k];
      y[k] = gn2[k] - g[k];
      sy += s[k] * y[k];
    }
    const df = f - fn2;
    x = xn;
    g = gn2;
    f = fn2;
    if (sy > 1e-12) {
      S.push(s);
      Y.push(y);
      rho.push(1 / sy);
      if (S.length > mem) {
        S.shift();
        Y.shift();
        rho.shift();
      }
    }
    step0 = 1;
    if (df < 1e-7 * (1 + Math.abs(f))) break;
  }
  return { x, f };
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

function finish(survey, data, X) {
  const { scans, nodeOfScan, M } = data;
  let cx = 0;
  let cy = 0;
  for (let a = 0; a < M; a++) {
    cx += X[2 * a];
    cy += X[2 * a + 1];
  }
  cx /= M;
  cy /= M;
  const points = scans.map((s, i) => {
    const a = nodeOfScan[i];
    const x = X[2 * a] - cx;
    const y = X[2 * a + 1] - cy;
    return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, z: (Number(s.floor) || 0) * FLOOR_HEIGHT, conf: 0.3 };
  });
  const aps = {};
  for (const id of Object.keys(survey.aps || {})) {
    const seen = [];
    scans.forEach((s, i) => {
      const r = (s.readings || []).find((q) => q.id === id);
      if (r && (r.ageMs ?? 0) <= FRESH_MS) seen.push({ rssi: r.rssi, i });
    });
    if (seen.length < 3) continue;
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
  return { points, aps, scaleConf: 0.2 };
}
