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
  defaultRadius: 3.5,
  initMode: 1, // 0: MDS direto; 1: desdobrado (Isomap)
  isoK: 6,
  isoSmooth: 0.5,
  isoLen: 1,
  isoFloorQ: 0.1,
  isoWeightPower: 2,
  refine: 1,
  h: 1.0, // largura do núcleo dos campos (m)
  hStart: 0,
  hHold: 1,
  lambda: 0.5, // encolhimento da previsão quando há poucos vizinhos
  sigma: 4, // dB
  vmax: 0.9,
  motionW: 4,
  motionSlack: 0.5,
  motionPad: 0,
  targetRadius: 0,
  springW: 0,
  orderW: 0,
  orderHop: 1.0,
  labelW: 0,
  labelRadius: 1.2,
  springSigma: 0.25,
  springShort: 0.5,
  outer: 4,
  inner: 40,
  missW: 0.5,
  wCap: 2,
  meanMode: 1,
  fitMissW: 0.3,
  nMin: 1.6,
  nMax: 5,
  nDefault: 2.5,
  apDz: 0.6,
  farPenalty: 0.02,
  physW: 0.3,
  physN: 2.2,
  physQ: 0.85,
  physP0: -41, // dBm a 1 m em 2,4 GHz (típico, já com um pouco de obstrução)
  physMinPeak: -52,
  physDamp: 0.7,
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
  const diss = P.initMode === 0 ? dissimilarity(data, P) : null;
  let X = P.initMode === 0 ? embed(data, diss, P) : embedIso(data, P);
  X = rescale(data, X, diss, P);
  const dbg = {};
  if (P.refine) X = refineFields(data, X, P, dbg, diss);
  const out = finish(survey, data, X);
  out.debug = dbg;
  if (P.keepData) {
    dbg.data = data;
    dbg.X = X;
  }
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
  // Grupos de cômodo: nós com o mesmo nome (dado pelo usuário) no mesmo andar.
  const groupIndex = new Map();
  const groups = [];
  const groupOf = new Int32Array(M).fill(-1);
  nodes.forEach((n, a) => {
    if (!n.label) return;
    const key = `${n.floor}|${String(n.label).trim().toLowerCase()}`;
    let g = groupIndex.get(key);
    if (g === undefined) {
      g = groups.length;
      groupIndex.set(key, g);
      groups.push([]);
    }
    groups[g].push(a);
    groupOf[a] = g;
  });
  // Andares e média de cada rádio por andar.
  const floorList = [...new Set(nodes.map((n) => n.floor))].sort((p, q) => p - q);
  const NF = floorList.length;
  const floorIdx = Int32Array.from(nodes, (n) => floorList.indexOf(n.floor));
  const floorNodes = new Float64Array(NF);
  for (let a = 0; a < M; a++) floorNodes[floorIdx[a]]++;
  const floorMean = new Float64Array(R * NF);
  for (let k = 0; k < R; k++) {
    for (let f = 0; f < NF; f++) {
      let s = 0;
      let c = 0;
      for (let a = 0; a < M; a++) {
        if (floorIdx[a] !== f) continue;
        const v = F[a * R + k];
        s += Number.isNaN(v) ? floorLevel - 2 : v;
        c++;
      }
      floorMean[k * NF + f] = c ? s / c : floorLevel;
    }
  }
  return { scans, nodes, nodeOfScan, radios, idRadio, R, M, F, cnt, floorLevel, floorList, floorIdx, floorNodes, floorMean, groups, groupOf };
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

// Imersão inicial "desdobrada" (família Isomap): as distâncias entre impressões digitais saturam depois
// de poucos metros, então só os pares vizinhos são confiáveis; as distâncias longas saem do caminho mais
// curto num grafo de vizinhança (k vizinhos mais parecidos + a própria sequência da caminhada).
function embedIso(data, P) {
  const { M, R, F, floorIdx, floorLevel, scans, nodeOfScan, nodes } = data;
  const NF = data.floorList.length;
  const cens = floorLevel - 2;
  const Y = new Float64Array(M * R);
  for (let a = 0; a < M; a++) {
    for (let k = 0; k < R; k++) {
      const v = F[a * R + k];
      // Centrado por andar: a laje vira deslocamento constante e some.
      Y[a * R + k] = (Number.isNaN(v) ? cens : v) - data.floorMean[k * NF + floorIdx[a]];
    }
  }
  // Sequência de visitas aos nós.
  const seq = [];
  for (let i = 0; i < scans.length; i++) if (seq[seq.length - 1] !== nodeOfScan[i]) seq.push(nodeOfScan[i]);
  // Suavização no tempo (vizinhos de caminhada no mesmo andar): tira ruído na escolha dos vizinhos.
  const S = new Float64Array(M * R);
  const SW = new Float64Array(M);
  const addTo = (a, b, w) => {
    SW[a] += w;
    for (let k = 0; k < R; k++) S[a * R + k] += w * Y[b * R + k];
  };
  for (let p = 0; p < seq.length; p++) {
    const a = seq[p];
    addTo(a, a, nodes[a].scans.length);
    for (const q of [p - 1, p + 1]) {
      if (q < 0 || q >= seq.length) continue;
      const b = seq[q];
      if (floorIdx[a] === floorIdx[b]) addTo(a, b, P.isoSmooth);
    }
  }
  for (let a = 0; a < M; a++) for (let k = 0; k < R; k++) S[a * R + k] /= SW[a] || 1;
  const dist2 = (Z, a, b) => {
    let s = 0;
    for (let k = 0; k < R; k++) {
      const e = Z[a * R + k] - Z[b * R + k];
      s += e * e;
    }
    return s / R;
  };
  const DS = new Float64Array(M * M);
  for (let a = 0; a < M; a++) for (let b = a + 1; b < M; b++) DS[a * M + b] = DS[b * M + a] = dist2(S, a, b);
  // Grafo: k vizinhos mais parecidos no mesmo andar + arestas da caminhada.
  const INF = 1e30;
  const Gd = new Float64Array(M * M).fill(INF);
  const edgeVals = [];
  const order = new Int32Array(M);
  const setEdge = (a, b) => {
    if (Gd[a * M + b] < INF) return;
    Gd[a * M + b] = Gd[b * M + a] = -1; // marca; o comprimento entra depois
    edgeVals.push(DS[a * M + b]);
  };
  for (let a = 0; a < M; a++) {
    let n = 0;
    for (let b = 0; b < M; b++) if (b !== a && floorIdx[b] === floorIdx[a]) order[n++] = b;
    const cand = Array.from(order.subarray(0, n)).sort((p, q) => DS[a * M + p] - DS[a * M + q]);
    for (let q = 0; q < Math.min(P.isoK, cand.length); q++) setEdge(a, cand[q]);
  }
  for (let p = 1; p < seq.length; p++) if (seq[p] !== seq[p - 1] && floorIdx[seq[p]] === floorIdx[seq[p - 1]]) setEdge(seq[p], seq[p - 1]);
  edgeVals.sort((p, q) => p - q);
  const floor2 = edgeVals.length ? edgeVals[Math.floor(edgeVals.length * P.isoFloorQ)] : 0;
  const med2 = edgeVals.length ? edgeVals[edgeVals.length >> 1] : 1;
  const lenOf = (v) => (P.isoLen === 1 ? Math.max(0.1 * med2, v - floor2) : Math.sqrt(Math.max(v, 1e-9)));
  for (let q = 0; q < M * M; q++) if (Gd[q] === -1) Gd[q] = lenOf(DS[q]);
  for (let a = 0; a < M; a++) Gd[a * M + a] = 0;
  // Caminhos mais curtos (Floyd–Warshall).
  for (let k = 0; k < M; k++) {
    const rk = k * M;
    for (let i = 0; i < M; i++) {
      const dik = Gd[i * M + k];
      if (dik >= INF) continue;
      const ri = i * M;
      for (let j = 0; j < M; j++) {
        const v = dik + Gd[rk + j];
        if (v < Gd[ri + j]) Gd[ri + j] = v;
      }
    }
  }
  // MDS por andar sobre as distâncias geodésicas.
  const X = new Float64Array(2 * M);
  const byFloor = Array.from({ length: NF }, () => []);
  for (let a = 0; a < M; a++) byFloor[floorIdx[a]].push(a);
  for (const list of byFloor) {
    const n = list.length;
    if (n === 0) continue;
    if (n < 3) {
      list.forEach((a, q) => {
        X[2 * a] = q;
        X[2 * a + 1] = 0;
      });
      continue;
    }
    const T = new Float64Array(n * n);
    const Wt = new Float64Array(n * n);
    let maxFinite = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (Gd[list[i] * M + list[j]] < INF) maxFinite = Math.max(maxFinite, Gd[list[i] * M + list[j]]);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        let d = Gd[list[i] * M + list[j]];
        if (d >= INF) d = 1.5 * maxFinite; // componentes soltas: longe
        T[i * n + j] = d;
        Wt[i * n + j] = 1 / Math.pow(Math.max(d, 1e-6), P.isoWeightPower);
      }
    }
    const Z = smacof(classicalMds(T, n), T, Wt, n, P.smacofIters);
    list.forEach((a, q) => {
      X[2 * a] = Z[2 * q];
      X[2 * a + 1] = Z[2 * q + 1];
    });
  }
  if (NF > 1) alignFloors(data, X, S, byFloor, seq);
  return X;
}

// Encaixa os andares uns sobre os outros: cada nó de um andar "aponta" para os nós do andar de
// referência com impressão digital (centrada por andar) mais parecida; a escada amarra a translação.
function alignFloors(data, X, S, byFloor, seq) {
  const { M, R, floorIdx } = data;
  let ref = 0;
  byFloor.forEach((l, f) => {
    if (l.length > byFloor[ref].length) ref = f;
  });
  const done = new Set([ref]);
  const dist2 = (a, b) => {
    let s = 0;
    for (let k = 0; k < R; k++) {
      const e = S[a * R + k] - S[b * R + k];
      s += e * e;
    }
    return s;
  };
  // Do andar mais próximo do de referência para fora.
  const todo = byFloor.map((_, f) => f).filter((f) => f !== ref).sort((p, q) => Math.abs(p - ref) - Math.abs(q - ref));
  for (const f of todo) {
    const list = byFloor[f];
    if (!list.length) continue;
    const anchors = [];
    for (let a = 0; a < M; a++) if (done.has(floorIdx[a])) anchors.push(a);
    const src = [];
    const dst = [];
    const wts = [];
    for (const a of list) {
      const cand = anchors.map((b) => [dist2(a, b), b]).sort((p, q) => p[0] - q[0]).slice(0, 5);
      let tx = 0;
      let ty = 0;
      for (const [, b] of cand) {
        tx += X[2 * b];
        ty += X[2 * b + 1];
      }
      src.push([X[2 * a], X[2 * a + 1]]);
      dst.push([tx / cand.length, ty / cand.length]);
      wts.push(1);
    }
    // Escada: quem acabou de trocar de andar está perto de onde estava.
    for (let p = 1; p < seq.length; p++) {
      const a = seq[p - 1];
      const b = seq[p];
      const fa = floorIdx[a];
      const fb = floorIdx[b];
      if (fa === fb) continue;
      const w = 0.15 * list.length;
      if (fb === f && done.has(fa)) {
        src.push([X[2 * b], X[2 * b + 1]]);
        dst.push([X[2 * a], X[2 * a + 1]]);
        wts.push(w);
      } else if (fa === f && done.has(fb)) {
        src.push([X[2 * a], X[2 * a + 1]]);
        dst.push([X[2 * b], X[2 * b + 1]]);
        wts.push(w);
      }
    }
    const fit = rigidFit(src, dst, wts);
    for (const a of list) {
      const x = X[2 * a];
      const y = X[2 * a + 1];
      X[2 * a] = fit.a * x + fit.b * y + fit.tx;
      X[2 * a + 1] = fit.c * x + fit.d * y + fit.ty;
    }
    done.add(f);
  }
}

// Melhor rotação (com ou sem espelho) + translação, com pesos, sem escala.
function rigidFit(src, dst, wts) {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < src.length; i++) {
    const w = wts[i];
    sw += w;
    sx += w * src[i][0];
    sy += w * src[i][1];
    dx += w * dst[i][0];
    dy += w * dst[i][1];
  }
  sx /= sw;
  sy /= sw;
  dx /= sw;
  dy /= sw;
  let a = 0;
  let b = 0;
  let am = 0;
  let bm = 0;
  for (let i = 0; i < src.length; i++) {
    const w = wts[i];
    const px = src[i][0] - sx;
    const py = src[i][1] - sy;
    const qx = dst[i][0] - dx;
    const qy = dst[i][1] - dy;
    a += w * (px * qx + py * qy);
    b += w * (px * qy - py * qx);
    am += w * (px * qx - py * qy);
    bm += w * (px * qy + py * qx);
  }
  const mirror = Math.hypot(am, bm) > Math.hypot(a, b);
  const ang = mirror ? Math.atan2(bm, am) : Math.atan2(b, a);
  const c = Math.cos(ang);
  const sn = Math.sin(ang);
  const m = mirror ? -1 : 1;
  const out = { a: c, b: -sn * m, c: sn, d: c * m, tx: 0, ty: 0 };
  out.tx = dx - (out.a * sx + out.b * sy);
  out.ty = dy - (out.c * sx + out.d * sy);
  return out;
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
    edges.push({ a, b, texp, tmax, informative: tmax <= 8, spots: !!(scans[i - 1].still && scans[i].still) });
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

// Escala pela física: o nível a 1 m de um roteador típico é conhecido a poucos dB (potência de
// transmissão regulamentada, perda no espaço livre a 1 m, antena do celular). Para os rádios fortes
// (roteadores dentro da área levantada), compara o p0 implícito no mapa com o típico.
function physScale(data, X, model, P) {
  const { M, R, F, floorIdx } = data;
  const n = P.physN;
  const ks = [];
  const vals = [];
  for (let k = 0; k < R; k++) {
    vals.length = 0;
    let mx = -Infinity;
    for (let a = 0; a < M; a++) {
      const v = F[a * R + k];
      if (Number.isNaN(v) || floorIdx[a] !== model.apFloor[k]) continue;
      if (v > mx) mx = v;
      const d2 = (X[2 * a] - model.ax[k]) ** 2 + (X[2 * a + 1] - model.ay[k]) ** 2 + P.apDz * P.apDz;
      vals.push(v + 5 * n * Math.log10(Math.max(0.25, d2)));
    }
    if (vals.length < 8 || mx < P.physMinPeak) continue;
    vals.sort((p, q) => p - q);
    const p0 = vals[Math.floor(P.physQ * (vals.length - 1))];
    const nominal = P.physP0 - 20 * Math.log10(data.radios[k].band === 0 ? 1 : 2.11); // 5 GHz: ~6,5 dB a mais de perda a 1 m
    ks.push(Math.pow(10, (nominal - p0) / (10 * n)));
  }
  if (!ks.length) return null;
  ks.sort((p, q) => p - q);
  return ks[ks.length >> 1];
}

function rescale(data, X, diss, P) {
  let k = P.targetRadius > 0 ? P.targetRadius / Math.max(1e-9, radiusOf(X)) : stepScale(data, X, P);
  if (k == null) {
    if (P.keepRadius) k = P.keepRadius / Math.max(1e-9, radiusOf(X));
    else if (!diss) k = P.defaultRadius / Math.max(1e-9, radiusOf(X));
    else k = P.distPower === 2 ? P.dbToM * 0.1 : P.dbToM;
  }
  return X.map((v) => v * k);
}

// ---------------------------------------------------------------------------
// Modelo físico de cada aparelho: rssi = p0(rádio, andar) − 10 n log10(d)
// ---------------------------------------------------------------------------

const LOG10 = Math.log(10);

// Ajusta posição (busca em grade + refino) e curva de cada aparelho com as posições atuais dos nós.
function fitApModels(data, X, P, prev) {
  const { M, R, F, cnt, nodes, radios, floorLevel } = data;
  const floorList = data.floorList;
  const NF = floorList.length;
  const fi = data.floorIdx;
  let cx = 0;
  let cy = 0;
  for (let a = 0; a < M; a++) {
    cx += X[2 * a];
    cy += X[2 * a + 1];
  }
  cx /= M;
  cy /= M;
  let rad = 0;
  for (let a = 0; a < M; a++) rad = Math.max(rad, Math.hypot(X[2 * a] - cx, X[2 * a + 1] - cy));
  rad = Math.max(rad, 1);
  // Candidatos: grade sobre a área levantada (com folga) e anéis para os vizinhos distantes.
  const cand = [];
  const G = 8;
  for (let i = -G; i <= G; i++) for (let j = -G; j <= G; j++) cand.push([cx + (i / G) * 1.6 * rad, cy + (j / G) * 1.6 * rad]);
  for (const rr of [2.4, 3.6, 5.5, 9]) {
    for (let q = 0; q < 16; q++) {
      const ang = (q + (rr > 3 ? 0.5 : 0)) * (Math.PI / 8);
      cand.push([cx + rr * rad * Math.cos(ang), cy + rr * rad * Math.sin(ang)]);
    }
  }
  const model = {
    ax: new Float64Array(R),
    ay: new Float64Array(R),
    n: new Float64Array(R),
    p0: new Float64Array(R * NF),
    h2: new Float64Array(R * NF),
    apFloor: new Int32Array(R),
    rms: new Float64Array(R),
    devs: [],
  };
  const byDev = new Map();
  radios.forEach((r, k) => {
    if (!byDev.has(r.device)) byDev.set(r.device, []);
    byDev.get(r.device).push(k);
  });
  const L = new Float64Array(M);
  for (const [dev, ks] of byDev) {
    // Observações do aparelho: por grupo (rádio, andar).
    const NG = ks.length * NF;
    const obsNode = [];
    const obsGroup = [];
    const obsY = [];
    const obsW = [];
    const gW = new Float64Array(NG);
    const gY = new Float64Array(NG);
    const floorSum = new Float64Array(NF);
    const floorCnt = new Float64Array(NF);
    ks.forEach((k, q) => {
      for (let a = 0; a < M; a++) {
        const v = F[a * R + k];
        const g = q * NF + fi[a];
        let y;
        let w;
        if (Number.isNaN(v)) {
          y = floorLevel - 3;
          w = P.fitMissW;
        } else {
          y = v;
          w = Math.min(P.wCap, cnt[a * R + k]);
          floorSum[fi[a]] += v;
          floorCnt[fi[a]]++;
        }
        obsNode.push(a);
        obsGroup.push(g);
        obsY.push(y);
        obsW.push(w);
        gW[g] += w;
        gY[g] += w * y;
      }
    });
    // Andar do aparelho: onde ele chega mais forte (entre os andares em que foi ouvido de verdade).
    let apF = 0;
    let bestLevel = -Infinity;
    for (let f = 0; f < NF; f++) {
      if (floorCnt[f] < 3) continue;
      // Média das leituras conta pouco se quase nunca aparece: usa também a taxa de detecção.
      const level = floorSum[f] / floorCnt[f] + 10 * Math.log10(floorCnt[f] / Math.max(1, data.floorNodes[f] * ks.length) + 0.05);
      if (level > bestLevel) {
        bestLevel = level;
        apF = f;
      }
    }
    const nObs = obsY.length;
    let ySS = 0;
    for (let o = 0; o < nObs; o++) {
      const g = obsGroup[o];
      const yc = obsY[o] - gY[g] / gW[g];
      ySS += obsW[o] * yc * yc;
    }
    const gL = new Float64Array(NG);
    const evalAt = (ax, ay, dz) => {
      for (let a = 0; a < M; a++) {
        const dx = X[2 * a] - ax;
        const dy = X[2 * a + 1] - ay;
        const df = (floorList[fi[a]] - floorList[apF]) * FLOOR_HEIGHT;
        L[a] = 5 * Math.log10(dx * dx + dy * dy + dz * dz + df * df);
      }
      gL.fill(0);
      for (let o = 0; o < nObs; o++) gL[obsGroup[o]] += obsW[o] * L[obsNode[o]];
      let sLL = 0;
      let sLY = 0;
      for (let o = 0; o < nObs; o++) {
        const g = obsGroup[o];
        const lc = L[obsNode[o]] - gL[g] / gW[g];
        const yc = obsY[o] - gY[g] / gW[g];
        sLL += obsW[o] * lc * lc;
        sLY += obsW[o] * lc * yc;
      }
      let n = sLL > 1e-9 ? -sLY / sLL : P.nDefault;
      n = Math.max(P.nMin, Math.min(P.nMax, n));
      // SS residual com n fixo: ySS + 2 n sLY + n² sLL
      const ss = ySS + 2 * n * sLY + n * n * sLL;
      return { ss, n };
    };
    let best = { ss: Infinity };
    const tryAt = (ax, ay, dz) => {
      if (Math.hypot(ax - cx, ay - cy) > 12 * rad) return;
      const r = evalAt(ax, ay, dz);
      // Leve preferência por posições próximas (entre ajustes equivalentes).
      const far = Math.hypot(ax - cx, ay - cy) / rad;
      const score = r.ss * (1 + P.farPenalty * Math.max(0, far - 1));
      if (score < (best.score ?? Infinity)) best = { ...r, score, ax, ay, dz };
    };
    const dzs = NF > 1 ? [P.apDz] : [P.apDz, FLOOR_HEIGHT];
    for (const dz of dzs) for (const c of cand) tryAt(c[0], c[1], dz);
    const pk = prev && prev.devs.find((d) => d.device === dev);
    if (pk) tryAt(pk.ax, pk.ay, pk.dz);
    // Refino local (busca em padrão).
    let step = 0.1 * rad;
    for (let moves = 0; moves < 30 && step > 0.08; moves++) {
      let improved = false;
      const bx = best.ax;
      const by = best.ay;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const before = best.score;
        tryAt(bx + ox * step, by + oy * step, best.dz);
        if (best.score < before) improved = true;
      }
      if (!improved) step *= 0.5;
    }
    // p0 de cada grupo com a posição e o n finais.
    evalAt(best.ax, best.ay, best.dz);
    const dfOf = (f) => (floorList[f] - floorList[apF]) * FLOOR_HEIGHT;
    ks.forEach((k, q) => {
      model.ax[k] = best.ax;
      model.ay[k] = best.ay;
      model.n[k] = best.n;
      model.apFloor[k] = apF;
      for (let f = 0; f < NF; f++) {
        const g = q * NF + f;
        model.h2[k * NF + f] = best.dz * best.dz + dfOf(f) * dfOf(f);
        model.p0[k * NF + f] = gW[g] > 0 ? gY[g] / gW[g] + best.n * (gL[g] / gW[g]) : floorLevel;
      }
    });
    model.devs.push({ device: dev, ax: best.ax, ay: best.ay, dz: best.dz, n: best.n, apFloor: apF, radios: ks, explained: 1 - best.ss / Math.max(1e-9, ySS), nObs });
  }
  return model;
}

// ---------------------------------------------------------------------------
// Refino: campos latentes (média física + resíduo por núcleo, deixando o próprio ponto de fora) + movimento
// ---------------------------------------------------------------------------

function refineFields(data, X0, P, dbg, diss) {
  const { M, R, F, cnt, nodes, floorLevel } = data;
  const NF = data.floorList.length;
  const fi = data.floorIdx;
  const obs = new Float64Array(M * R); // nível observado (ou limiar, se não ouvido)
  const wgt = new Float64Array(M * R);
  const miss = new Uint8Array(M * R);
  const cens = floorLevel - 2;
  for (let q = 0; q < M * R; q++) {
    if (Number.isNaN(F[q])) {
      obs[q] = cens;
      wgt[q] = P.missW;
      miss[q] = 1;
    } else {
      obs[q] = F[q];
      wgt[q] = Math.min(P.wCap, cnt[q]);
    }
  }
  const edges = data.edges;
  let inv2h2 = 1 / (2 * P.h * P.h);
  const s2 = P.sigma * P.sigma;
  const cut = 2.5 * P.sigma;
  const val = new Float64Array(M * R); // resíduo usado como vizinho
  const own = new Float64Array(M * R); // resíduo usado no próprio custo
  const flow = new Uint8Array(M * R); // o resíduo depende da posição (média física)?
  const mgx = new Float64Array(M * R); // gradiente da média física
  const mgy = new Float64Array(M * R);
  const num = new Float64Array(M * R);
  const den = new Float64Array(M * R);
  const g1 = new Float64Array(M * R); // d custo / d num
  const gv = new Float64Array(M * R); // d custo / d val (como vizinho) + próprio
  const pred = new Float64Array(M * R);
  const Wm = new Float64Array(M * M);
  let model = null;

  const cost = (X, G) => {
    G.fill(0);
    num.fill(0);
    den.fill(0);
    // Média física e resíduos.
    for (let a = 0; a < M; a++) {
      const xa = X[2 * a];
      const ya = X[2 * a + 1];
      const f = fi[a];
      for (let k = 0; k < R; k++) {
        const q = a * R + k;
        let m;
        if (model) {
          const dx = xa - model.ax[k];
          const dy = ya - model.ay[k];
          const d2 = dx * dx + dy * dy + model.h2[k * NF + f];
          m = model.p0[k * NF + f] - 5 * model.n[k] * Math.log10(d2);
          const gfac = (-10 * model.n[k]) / (LOG10 * d2);
          mgx[q] = gfac * dx;
          mgy[q] = gfac * dy;
        } else {
          m = data.floorMean[k * NF + f];
          mgx[q] = 0;
          mgy[q] = 0;
        }
        const r = obs[q] - m;
        own[q] = r;
        if (miss[q] && r > 0) {
          val[q] = 0; // a média já está abaixo do limiar: nada a corrigir
          flow[q] = 0;
        } else {
          val[q] = r;
          flow[q] = 1;
        }
      }
    }
    for (let a = 0; a < M; a++) {
      for (let b = a + 1; b < M; b++) {
        if (fi[a] !== fi[b]) {
          Wm[a * M + b] = 0;
          continue;
        }
        const dx = X[2 * a] - X[2 * b];
        const dy = X[2 * a + 1] - X[2 * b + 1];
        const w = Math.exp(-(dx * dx + dy * dy) * inv2h2);
        Wm[a * M + b] = w;
        if (w < 1e-4) continue;
        const ra = a * R;
        const rb = b * R;
        for (let k = 0; k < R; k++) {
          const wa = w * wgt[ra + k];
          const wb = w * wgt[rb + k];
          num[ra + k] += wb * val[rb + k];
          den[ra + k] += wb;
          num[rb + k] += wa * val[ra + k];
          den[rb + k] += wa;
        }
      }
    }
    let c = 0;
    for (let q = 0; q < M * R; q++) {
      const D = den[q] + P.lambda;
      const p = num[q] / D;
      pred[q] = p;
      let e = own[q] - p;
      if (miss[q] && e > 0) e = 0; // não ouvido: só custa se o campo prevê sinal acima do limiar
      const ae = Math.abs(e);
      let dc;
      if (ae <= cut) {
        c += (wgt[q] * e * e) / (2 * s2);
        dc = (wgt[q] * e) / s2;
      } else {
        c += (wgt[q] * (cut * ae - 0.5 * cut * cut)) / s2;
        dc = (wgt[q] * cut * Math.sign(e)) / s2;
      }
      g1[q] = -dc / D;
      gv[q] = dc; // parte própria: d custo / d own
    }
    for (let a = 0; a < M; a++) {
      for (let b = a + 1; b < M; b++) {
        const w = Wm[a * M + b];
        if (w < 1e-4) continue;
        const ra = a * R;
        const rb = b * R;
        let dw = 0;
        for (let k = 0; k < R; k++) {
          const ga = g1[ra + k];
          const gb = g1[rb + k];
          const wa = wgt[ra + k];
          const wb = wgt[rb + k];
          dw += ga * wb * (val[rb + k] - pred[ra + k]) + gb * wa * (val[ra + k] - pred[rb + k]);
          // val[a] entra no num de b (e vice-versa)
          if (flow[ra + k]) gv[ra + k] += gb * w * wa;
          if (flow[rb + k]) gv[rb + k] += ga * w * wb;
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
    if (model) {
      // Cadeia pela média física: d own/dx = d val/dx = −∇m
      for (let a = 0; a < M; a++) {
        let gx = 0;
        let gy = 0;
        for (let k = 0; k < R; k++) {
          const q = a * R + k;
          gx -= gv[q] * mgx[q];
          gy -= gv[q] * mgy[q];
        }
        G[2 * a] += gx;
        G[2 * a + 1] += gy;
      }
    }
    // Movimento: ninguém anda mais que vmax; quem está andando faz passos de tamanho parecido.
    for (const e of edges) {
      const dx = X[2 * e.a] - X[2 * e.b];
      const dy = X[2 * e.a + 1] - X[2 * e.b + 1];
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-9;
      let f = 0;
      const lim = P.vmax * e.tmax + P.motionPad;
      if (d > lim) {
        const ex = (d - lim) / P.motionSlack;
        c += 0.5 * P.motionW * ex * ex;
        f += (P.motionW * ex) / P.motionSlack / d;
      }
      if (P.springW > 0 && e.informative) {
        const d0 = P.walkSpeed * e.texp;
        const sd = P.springSigma * e.texp + 0.2;
        const ex = (d - d0) / sd;
        const w = ex < 0 ? P.springW * P.springShort : P.springW;
        c += 0.5 * w * ex * ex;
        f += (w * ex) / sd / d;
      }
      if (P.orderW > 0 && !e.informative && e.spots) {
        // Entre pontos marcados com muito tempo no meio o relógio não mede nada, mas quem marca
        // pontos vai de um para o vizinho: o salto costuma ser curto perto do tamanho do mapa.
        const ex = d / hopScale;
        c += 0.5 * P.orderW * ex * ex;
        f += P.orderW / (hopScale * hopScale);
      }
      G[2 * e.a] += f * dx;
      G[2 * e.a + 1] += f * dy;
      G[2 * e.b] -= f * dx;
      G[2 * e.b + 1] -= f * dy;
    }
    // Cômodos: pontos com o mesmo nome ficam juntos (raio proporcional à fração de pontos do cômodo)
    // e mais perto do centro do próprio cômodo que do centro dos outros.
    if (P.labelW > 0 && data.groups.length) {
      const ng = data.groups.length;
      for (let g = 0; g < ng; g++) {
        const list = data.groups[g];
        let gx = 0;
        let gy = 0;
        for (const a of list) {
          gx += X[2 * a];
          gy += X[2 * a + 1];
        }
        gcx[g] = gx / list.length;
        gcy[g] = gy / list.length;
      }
      for (let g = 0; g < ng; g++) {
        const list = data.groups[g];
        if (list.length < 2) continue;
        const rg = roomScale * Math.sqrt(list.length / M);
        // Gradiente exato: o centro depende de todos os membros.
        let sgx = 0;
        let sgy = 0;
        for (const a of list) {
          const dx = X[2 * a] - gcx[g];
          const dy = X[2 * a + 1] - gcy[g];
          const d = Math.sqrt(dx * dx + dy * dy) + 1e-9;
          if (d > rg) {
            const ex = (d - rg) / rg;
            c += 0.5 * P.labelW * ex * ex;
            const f = (P.labelW * ex) / rg / d;
            G[2 * a] += f * dx;
            G[2 * a + 1] += f * dy;
            sgx += f * dx;
            sgy += f * dy;
          }
        }
        for (const a of list) {
          G[2 * a] -= sgx / list.length;
          G[2 * a + 1] -= sgy / list.length;
        }
      }
    }
    return c;
  };
  let hopScale = 1;
  let roomScale = 1;
  const gcx = new Float64Array(data.groups.length);
  const gcy = new Float64Array(data.groups.length);
  let X = Float64Array.from(X0);
  const hist = [];
  const radius0 = radiusOf(X);
  for (let o = 0; o < P.outer; o++) {
    // Do grosso para o fino: campos muito lisos primeiro (estrutura global), detalhe depois.
    const frac = P.outer > 1 ? Math.min(1, o / Math.max(1, P.outer - 1 - P.hHold)) : 1;
    const h = P.hStart > 0 ? P.hStart * Math.pow(P.h / P.hStart, frac) : P.h;
    inv2h2 = 1 / (2 * h * h);
    const rmsRadius = radiusOf(X);
    // Salto típico entre vizinhos: raio do disco equivalente / raiz do número de pontos.
    hopScale = Math.max(0.3, P.orderHop * rmsRadius * Math.SQRT2 * Math.sqrt(Math.PI / M));
    roomScale = P.labelRadius * rmsRadius * Math.SQRT2;
    if (P.meanMode) model = fitApModels(data, X, P, model);
    if (P.gradCheck && o === 0) {
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
    const r = lbfgs(cost, X, P.inner);
    X = r.x;
    // Escala: passo de quem anda (quando há) combinado com a física; sem nenhum dos dois, mantém o tamanho.
    let kStep = P.targetRadius > 0 ? null : stepScale(data, X, P);
    let kPhys = model && P.physW > 0 && !(P.targetRadius > 0) ? physScale(data, X, model, P) : null;
    if (kPhys != null) kPhys = Math.max(0.4, Math.min(2.5, kPhys));
    let kk;
    if (P.targetRadius > 0) kk = P.targetRadius / Math.max(1e-9, radiusOf(X));
    else if (kStep != null && kPhys != null) kk = Math.pow(kStep, 1 - P.physW) * Math.pow(kPhys, P.physW);
    else if (kStep != null) kk = kStep;
    else if (kPhys != null) kk = Math.pow(kPhys, P.physDamp); // amortecido: a posição do roteador ainda está mudando
    else kk = radius0 / Math.max(1e-9, radiusOf(X));
    for (let q = 0; q < X.length; q++) X[q] *= kk;
    dbg.scale = { kStep, kPhys, kk };
    hist.push(r.f);
  }
  if (P.meanMode) model = fitApModels(data, X, P, model);
  dbg.costHist = hist;
  dbg.note = `cost ${hist[hist.length - 1].toFixed(0)}`;
  data.model = model;
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

// (desenvolvimento) acesso às etapas internas para os diagnósticos; sai na versão final.
export const _dev = { DEFAULTS, prepare, motionEdges, dissimilarity, embed, embedIso, rescale, fitApModels, refineFields, finish, lbfgs };
