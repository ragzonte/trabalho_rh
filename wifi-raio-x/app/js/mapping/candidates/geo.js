// Mapa só com Wi-Fi — candidato "geo": SLAM geométrico de distâncias.
//
// Incógnitas: a posição de cada varredura, a posição de cada aparelho (roteador) e a curva de
// propagação de cada rádio. Minimiza-se um desajuste robusto entre o RSSI medido e o previsto,
// mais as restrições de caminhada (ninguém anda mais que ~1 m/s) e priores largos de física.
//
// Único import permitido: ../types.js. Sem Math.random, sem Date.now (determinístico).

import { FLOOR_HEIGHT } from '../types.js';

// ---------------------------------------------------------------------------
// Constantes (priores largos; nada aqui é ajustado a um cenário específico)
// ---------------------------------------------------------------------------

/** Altura típica do celular na mão (m acima do piso). */
const PHONE_HEIGHT = 1.2;
/** Leitura mais velha que isto (ms) nunca é desta varredura: uma varredura completa leva < 4,5 s. */
const MAX_SWEEP_MS = 4500;
/** Nível abaixo do qual um rádio quase nunca aparece (dBm). */
const DETECT_DBM = -87;
/** Distância mínima efetiva até um roteador (m): evita o infinito do logaritmo. */
const NEAR_M = 0.4;
/** Velocidade que quase ninguém passa andando dentro de casa com o celular na mão (m/s). */
const V_MAX = 1.0;
/** RSSI a 1 m em 2,4 GHz de um roteador doméstico típico (EIRP ~20 dBm, perda livre de 40 dB, antena do celular). */
const P0_REF_24 = -39;

const LN10 = Math.LN10;

// ---------------------------------------------------------------------------
// Utilidades numéricas
// ---------------------------------------------------------------------------

/** Gerador determinístico (mulberry32). */
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values) {
  if (!values.length) return NaN;
  const v = Array.from(values).sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
}

function quantile(values, q) {
  if (!values.length) return NaN;
  const v = Array.from(values).sort((a, b) => a - b);
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : 0);

/**
 * L-BFGS com busca linear por recuo (Armijo). `fg(x, grad)` devolve o custo e preenche o gradiente.
 * As variáveis já devem chegar em escala parecida (ver `scale` em quem chama).
 */
function lbfgs(fg, x, opts) {
  const n = x.length;
  const m = opts.memory || 8;
  const maxIter = opts.maxIter || 200;
  const g = new Float64Array(n);
  const gNew = new Float64Array(n);
  const xNew = new Float64Array(n);
  const dir = new Float64Array(n);
  const S = [];
  const Y = [];
  const rho = [];
  const alpha = new Float64Array(m);
  let f = fg(x, g);
  let iter = 0;
  for (; iter < maxIter; iter++) {
    if (opts.deadline && (iter & 7) === 7 && now() > opts.deadline) break;
    // Direção: -H·g pelo laço duplo.
    for (let i = 0; i < n; i++) dir[i] = -g[i];
    const k = S.length;
    for (let j = k - 1; j >= 0; j--) {
      let a = 0;
      const s = S[j];
      for (let i = 0; i < n; i++) a += s[i] * dir[i];
      a *= rho[j];
      alpha[j] = a;
      const y = Y[j];
      for (let i = 0; i < n; i++) dir[i] -= a * y[i];
    }
    if (k > 0) {
      const s = S[k - 1];
      const y = Y[k - 1];
      let sy = 0;
      let yy = 0;
      for (let i = 0; i < n; i++) {
        sy += s[i] * y[i];
        yy += y[i] * y[i];
      }
      const gamma = sy / yy;
      for (let i = 0; i < n; i++) dir[i] *= gamma;
    }
    for (let j = 0; j < k; j++) {
      let b = 0;
      const y = Y[j];
      for (let i = 0; i < n; i++) b += y[i] * dir[i];
      b *= rho[j];
      const s = S[j];
      const c = alpha[j] - b;
      for (let i = 0; i < n; i++) dir[i] += c * s[i];
    }
    let slope = 0;
    for (let i = 0; i < n; i++) slope += dir[i] * g[i];
    if (!(slope < 0)) {
      // Direção ruim (curvatura estragada): recomeça do gradiente.
      S.length = Y.length = rho.length = 0;
      slope = 0;
      for (let i = 0; i < n; i++) {
        dir[i] = -g[i];
        slope -= g[i] * g[i];
      }
      if (!(slope < -1e-20)) break;
    }
    let step = 1;
    if (S.length === 0) {
      let gn = 0;
      for (let i = 0; i < n; i++) gn += g[i] * g[i];
      step = Math.min(1, (opts.firstStep || 0.5) / Math.sqrt(gn));
    }
    let fNew = f;
    let ok = false;
    for (let ls = 0; ls < 25; ls++) {
      for (let i = 0; i < n; i++) xNew[i] = x[i] + step * dir[i];
      fNew = fg(xNew, gNew);
      if (Number.isFinite(fNew) && fNew <= f + 1e-4 * step * slope) {
        ok = true;
        break;
      }
      step *= 0.5;
    }
    if (!ok) break;
    const s = new Float64Array(n);
    const y = new Float64Array(n);
    let sy = 0;
    for (let i = 0; i < n; i++) {
      s[i] = xNew[i] - x[i];
      y[i] = gNew[i] - g[i];
      sy += s[i] * y[i];
    }
    const decrease = f - fNew;
    x.set(xNew);
    g.set(gNew);
    f = fNew;
    if (sy > 1e-12) {
      if (S.length === m) {
        S.shift();
        Y.shift();
        rho.shift();
      }
      S.push(s);
      Y.push(y);
      rho.push(1 / sy);
    }
    if (decrease < (opts.ftol || 1e-7) * (1 + Math.abs(f))) break;
  }
  return { f, iter };
}

/** MDS clássico em 2D por iteração de subespaço (determinístico). D2 = distâncias ao quadrado, n x n. */
function classicalMds(D2, n) {
  const out = new Float64Array(2 * n);
  if (n < 3) {
    if (n === 2) out[2] = Math.sqrt(Math.max(0, D2[1]));
    return out;
  }
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
  let q1 = Float64Array.from({ length: n }, (_, i) => Math.sin(1.7 * i + 0.3));
  let q2 = Float64Array.from({ length: n }, (_, i) => Math.cos(2.9 * i + 1.1));
  const mul = (v) => {
    const r = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const row = i * n;
      for (let j = 0; j < n; j++) s += B[row + j] * v[j];
      r[i] = s;
    }
    return r;
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
  for (let it = 0; it < 80; it++) {
    q1 = mul(q1);
    normalize(q1);
    q2 = mul(q2);
    const p = dot(q1, q2);
    for (let i = 0; i < n; i++) q2[i] -= p * q1[i];
    normalize(q2);
  }
  const s1 = Math.sqrt(Math.max(0, dot(q1, mul(q1))));
  const s2 = Math.sqrt(Math.max(0, dot(q2, mul(q2))));
  for (let i = 0; i < n; i++) {
    out[2 * i] = q1[i] * s1;
    out[2 * i + 1] = q2[i] * s2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preparação: nós (lugares), rádios e observações
// ---------------------------------------------------------------------------

function bandOf(freq) {
  if (!(freq > 0)) return 0;
  if (freq < 3000) return 0;
  if (freq < 5925) return 1;
  return 2;
}

/**
 * Converte o levantamento em:
 *  - nós: um por varredura andando, um por ponto marcado (`spot`);
 *  - rádios: BSSIDs do mesmo aparelho e da mesma faixa viram um só (mesmo sinal médio);
 *  - observações (nó, rádio, andar) = média das leituras FRESCAS; e os pares "não ouvi".
 */
function prepare(survey, scanIdx) {
  const allScans = survey.scans;
  const scans = scanIdx.map((i) => allScans[i]);
  const N = scans.length;
  const meta = survey.aps || {};

  // --- nós ---
  const nodeOf = new Int32Array(N);
  const spotNode = new Map();
  let P = 0;
  for (let i = 0; i < N; i++) {
    const spot = scans[i].spot;
    if (spot != null) {
      if (!spotNode.has(spot)) spotNode.set(spot, P++);
      nodeOf[i] = spotNode.get(spot);
    } else nodeOf[i] = P++;
  }

  // --- andares ---
  const floorList = [];
  const floorIndex = new Map();
  const scanFloor = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const f = Number.isFinite(scans[i].floor) ? Math.round(scans[i].floor) : 0;
    if (!floorIndex.has(f)) {
      floorIndex.set(f, floorList.length);
      floorList.push(f);
    }
    scanFloor[i] = floorIndex.get(f);
  }
  const NF = Math.max(1, floorList.length);
  const nodeFloor = new Int32Array(P).fill(-1);
  for (let i = 0; i < N; i++) if (nodeFloor[nodeOf[i]] < 0) nodeFloor[nodeOf[i]] = scanFloor[i];

  // --- rádios e aparelhos ---
  const radioIndex = new Map();
  const radios = []; // {device, band, freq, ids}
  const deviceIndex = new Map();
  const devices = []; // {key, radios:[]}
  const radioOfId = new Map();
  const registerId = (id, freqHint) => {
    if (radioOfId.has(id)) return radioOfId.get(id);
    const info = meta[id] || {};
    const freq = info.freq > 0 ? info.freq : freqHint > 0 ? freqHint : 2437;
    const devKey = info.device != null ? `d:${info.device}` : `b:${id}`;
    const band = bandOf(freq);
    const key = `${devKey}|${band}`;
    let r = radioIndex.get(key);
    if (r === undefined) {
      let d = deviceIndex.get(devKey);
      if (d === undefined) {
        d = devices.length;
        deviceIndex.set(devKey, d);
        devices.push({ key: devKey, radios: [] });
      }
      r = radios.length;
      radioIndex.set(key, r);
      radios.push({ device: d, band, freq, ids: [] });
      devices[d].radios.push(r);
    }
    radios[r].ids.push(id);
    radioOfId.set(id, r);
    return r;
  };

  // --- leituras frescas agregadas por (nó, rádio, andar) ---
  const cell = new Map(); // chave numérica -> {sum, count}
  const keyOf = (node, radio, floor) => (node * 4096 + radio) * 8 + floor;
  for (let i = 0; i < N; i++) {
    const s = scans[i];
    const gapMs = i > 0 ? (s.t - scans[i - 1].t) * 1000 : Infinity;
    // Fresca = ouvida depois da varredura anterior (o Android repete leituras antigas).
    const freshMs = Math.min(MAX_SWEEP_MS, gapMs > 200 ? gapMs - 1 : MAX_SWEEP_MS);
    const readings = Array.isArray(s.readings) ? s.readings : [];
    const perRadio = new Map();
    for (const r of readings) {
      if (!r || typeof r.id !== 'string' || !Number.isFinite(r.rssi)) continue;
      const radio = registerId(r.id, r.freq);
      if ((r.ageMs ?? 0) > freshMs) continue;
      let acc = perRadio.get(radio);
      if (!acc) perRadio.set(radio, (acc = { sum: 0, count: 0 }));
      acc.sum += r.rssi;
      acc.count++;
    }
    for (const [radio, acc] of perRadio) {
      if (radio >= 4096 || scanFloor[i] >= 8) continue;
      const key = keyOf(nodeOf[i], radio, scanFloor[i]);
      let c = cell.get(key);
      if (!c) cell.set(key, (c = { node: nodeOf[i], radio, floor: scanFloor[i], sum: 0, count: 0 }));
      c.sum += acc.sum / acc.count;
      c.count++;
    }
  }
  for (const id of Object.keys(meta)) registerId(id, meta[id] && meta[id].freq);
  const R = radios.length;

  const obs = Array.from(cell.values());
  const radioCount = new Int32Array(R);
  for (const o of obs) radioCount[o.radio]++;

  // --- arestas de caminhada: varreduras consecutivas em nós diferentes ---
  const edges = [];
  for (let i = 1; i < N; i++) {
    const a = nodeOf[i - 1];
    const b = nodeOf[i];
    if (a === b) continue;
    const dt = Math.max(0.5, scans[i].t - scans[i - 1].t);
    // Tipo do par: 0 = andando nas duas pontas, 1 = uma ponta parada, 2 = dois pontos marcados.
    const kind = (scans[i].spot != null ? 1 : 0) + (scans[i - 1].spot != null ? 1 : 0);
    edges.push({ a, b, dt, kind });
  }

  // Visitas: varreduras seguidas no mesmo nó viram um passo só da cadeia de trajetória.
  const visits = []; // {node, floor, kind}
  const links = []; // entre a visita v e a v+1: {dt, kind}
  const visitOf = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (i > 0 && nodeOf[i] === nodeOf[i - 1]) {
      visitOf[i] = visits.length - 1;
      continue;
    }
    if (i > 0) {
      const kind = (scans[i].spot != null ? 1 : 0) + (scans[i - 1].spot != null ? 1 : 0);
      links.push({ dt: Math.max(0.5, scans[i].t - scans[i - 1].t), kind, floorChange: scanFloor[i] !== scanFloor[i - 1] });
    }
    visitOf[i] = visits.length;
    visits.push({ node: nodeOf[i], floor: scanFloor[i] });
  }

  // Cômodos batizados pelo usuário: nós com o mesmo nome (no mesmo andar) estão no mesmo cômodo.
  const roomOf = new Map();
  for (let i = 0; i < N; i++) {
    const label = typeof scans[i].label === 'string' ? scans[i].label.trim().toLowerCase() : '';
    if (!label || scans[i].spot == null) continue;
    const key = `${scanFloor[i]}|${label}`;
    if (!roomOf.has(key)) roomOf.set(key, new Set());
    roomOf.get(key).add(nodeOf[i]);
  }
  const rooms = [];
  for (const set of roomOf.values()) if (set.size >= 2) rooms.push(Int32Array.from(set));
  // Sequência dos pontos marcados, na ordem em que foram visitados.
  const spotOrder = [];
  for (let i = 0; i < N; i++) {
    if (scans[i].spot == null) continue;
    if (!spotOrder.length || spotOrder[spotOrder.length - 1] !== nodeOf[i]) spotOrder.push(nodeOf[i]);
  }

  // Trincas de varreduras seguidas andando (ritmo regular): base do prior de "andar reto".
  const triples = [];
  for (let i = 2; i < N; i++) {
    if (scans[i].spot != null || scans[i - 1].spot != null || scans[i - 2].spot != null) continue;
    const d1 = scans[i - 1].t - scans[i - 2].t;
    const d2 = scans[i].t - scans[i - 1].t;
    if (d1 > 8 || d2 > 8 || d1 < 1 || d2 < 1 || Math.abs(d1 - d2) > 0.3 * (d1 + d2)) continue;
    triples.push({ a: nodeOf[i - 2], b: nodeOf[i - 1], c: nodeOf[i], dt: 0.5 * (d1 + d2) });
  }

  return { scans, N, P, NF, floorList, nodeOf, scanFloor, nodeFloor, radios, devices, R, obs, radioCount, edges, triples, visits, links, visitOf, radioOfId, rooms, spotOrder };
}

// ---------------------------------------------------------------------------
// Partida: embutimento das impressões digitais (MDS), ciente do andar
// ---------------------------------------------------------------------------

/**
 * Posição inicial dos nós: MDS clássico sobre a diferença entre impressões digitais.
 * Cada rádio é centrado POR ANDAR antes de comparar: a laje derruba o nível de tudo e, sem
 * isso, os dois andares se espalham lado a lado em vez de ficarem um sobre o outro.
 */
function initNodes(prep) {
  const { P, R, NF, obs, radioCount, nodeFloor } = prep;
  const FILL = DETECT_DBM - 4;
  const used = [];
  for (let r = 0; r < R; r++) if (radioCount[r] >= Math.max(3, 0.1 * P)) used.push(r);
  const K = used.length;
  const colOf = new Int32Array(R).fill(-1);
  used.forEach((r, k) => (colOf[r] = k));
  const Z = new Float64Array(P * K).fill(NaN);
  for (const o of obs) {
    const k = colOf[o.radio];
    if (k >= 0) Z[o.node * K + k] = o.sum / o.count;
  }
  const seen = new Uint8Array(P * K);
  for (let i = 0; i < P * K; i++) {
    if (Number.isNaN(Z[i])) Z[i] = FILL;
    else seen[i] = 1;
  }
  // Centra por (andar, rádio).
  for (let k = 0; k < K; k++) {
    const sum = new Float64Array(NF);
    const cnt = new Float64Array(NF);
    for (let i = 0; i < P; i++) {
      sum[nodeFloor[i]] += Z[i * K + k];
      cnt[nodeFloor[i]]++;
    }
    for (let i = 0; i < P; i++) Z[i * K + k] -= sum[nodeFloor[i]] / Math.max(1, cnt[nodeFloor[i]]);
  }
  const D2 = new Float64Array(P * P);
  for (let i = 0; i < P; i++) {
    for (let j = i + 1; j < P; j++) {
      let s = 0;
      let c = 0;
      for (let k = 0; k < K; k++) {
        if (!seen[i * K + k] && !seen[j * K + k]) continue;
        const d = Z[i * K + k] - Z[j * K + k];
        s += d * d;
        c++;
      }
      const v = c ? s / c : 0;
      D2[i * P + j] = D2[j * P + i] = v;
    }
  }
  return classicalMds(D2, P);
}

/** Escala o embutimento para metros usando o passo típico entre varreduras consecutivas. */
function rescaleInit(prep, X, pace) {
  const { edges, P } = prep;
  const ratios = [];
  for (const e of edges) {
    const d = Math.hypot(X[2 * e.a] - X[2 * e.b], X[2 * e.a + 1] - X[2 * e.b + 1]);
    if (e.kind === 0 && e.dt < 8 && d > 1e-9) ratios.push(d / e.dt);
  }
  let scale;
  if (ratios.length >= 8) {
    scale = pace / median(ratios);
  } else {
    // Sem caminhada contínua: assume uma casa de raio ~3 m.
    let r2 = 0;
    for (let i = 0; i < 2 * P; i++) r2 += X[i] * X[i];
    scale = 3 / Math.sqrt(r2 / Math.max(1, P) + 1e-12);
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  for (let i = 0; i < 2 * P; i++) X[i] *= scale;
}

// ---------------------------------------------------------------------------
// Modelo: custo e gradiente
// ---------------------------------------------------------------------------

// Curva de um rádio:  rssi = p0 - 10·n·log10(d) - alpha·d   (d em metros, com um mínimo suave).
// `alpha` (dB/m) faz o papel das paredes: sem ele, `n` incha e o `p0` deixa de dizer a escala.

function buildModel(prep, cfg) {
  const { P, R, NF, obs, radioCount, devices, radios, edges } = prep;
  // Rádios com leituras suficientes para ajustar uma curva.
  const active = new Int32Array(R).fill(-1);
  const list = [];
  for (let r = 0; r < R; r++) {
    if (radioCount[r] >= cfg.minObs) {
      active[r] = list.length;
      list.push(r);
    }
  }
  const RA = list.length;
  // Aparelhos com pelo menos um rádio ativo.
  const devActive = new Int32Array(devices.length).fill(-1);
  const devList = [];
  for (const r of list) {
    const d = radios[r].device;
    if (devActive[d] < 0) {
      devActive[d] = devList.length;
      devList.push(d);
    }
  }
  const DA = devList.length;

  // p0 por (rádio, andar) quando há dados; senão usa o do andar principal do rádio.
  const cnt = new Int32Array(RA * NF);
  const sum = new Float64Array(RA * NF);
  for (const o of obs) {
    const a = active[o.radio];
    if (a < 0) continue;
    cnt[a * NF + o.floor]++;
    sum[a * NF + o.floor] += o.sum / o.count;
  }
  const mainFloor = new Int32Array(RA);
  for (let a = 0; a < RA; a++) {
    let best = -1;
    let bestScore = -Infinity;
    for (let f = 0; f < NF; f++) {
      if (cnt[a * NF + f] < 3) continue;
      // Andar principal: onde o rádio chega mais forte (e não só por acaso de poucas leituras).
      const score = sum[a * NF + f] / cnt[a * NF + f];
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }
    if (best < 0) {
      for (let f = 0; f < NF; f++) if (best < 0 || cnt[a * NF + f] > cnt[a * NF + best]) best = f;
    }
    mainFloor[a] = best;
  }

  // Disposição do vetor de parâmetros.
  const oX = 0;
  const oA = 2 * P;
  const oR = oA + 3 * DA; // por rádio: n, alpha
  let size = oR + 2 * RA;
  const p0Index = new Int32Array(RA * NF).fill(-1);
  for (let a = 0; a < RA; a++) {
    p0Index[a * NF + mainFloor[a]] = size++;
    for (let f = 0; f < NF; f++) {
      if (f !== mainFloor[a] && cnt[a * NF + f] >= 3) p0Index[a * NF + f] = size++;
    }
    for (let f = 0; f < NF; f++) if (p0Index[a * NF + f] < 0) p0Index[a * NF + f] = p0Index[a * NF + mainFloor[a]];
  }

  // Observações em vetores.
  const M = obs.filter((o) => active[o.radio] >= 0).length;
  const oNode = new Int32Array(M);
  const oRad = new Int32Array(M);
  const oFloor = new Int32Array(M);
  const oY = new Float64Array(M);
  const oW = new Float64Array(M);
  let m = 0;
  const heard = new Uint8Array(P * RA);
  for (const o of obs) {
    const a = active[o.radio];
    if (a < 0) continue;
    oNode[m] = o.node;
    oRad[m] = a;
    oFloor[m] = o.floor;
    oY[m] = o.sum / o.count;
    // Várias varreduras no mesmo ponto: o ruído cai, mas corpo e desvanecimento são os mesmos.
    oW[m] = o.count >= 2 ? 1.5 : 1;
    heard[o.node * RA + a] = 1;
    m++;
  }
  // As faixas de um mesmo aparelho atravessam as mesmas paredes e o mesmo corpo: os erros
  // andam juntos, então duas leituras dele valem menos que duas de aparelhos diferentes.
  if (cfg.deviceCorr > 0) {
    const perDev = new Map();
    for (let k = 0; k < M; k++) {
      const key = oNode[k] * 4096 + devActive[radios[list[oRad[k]]].device];
      perDev.set(key, (perDev.get(key) || 0) + 1);
    }
    for (let k = 0; k < M; k++) {
      const c = perDev.get(oNode[k] * 4096 + devActive[radios[list[oRad[k]]].device]);
      oW[k] /= 1 + cfg.deviceCorr * (c - 1);
    }
  }
  // Pares "não ouvi": só valem para rádios que costumam aparecer.
  const cNode = [];
  const cRad = [];
  if (cfg.censor > 0) {
    for (let a = 0; a < RA; a++) {
      if (radioCount[list[a]] < cfg.censorMinObs) continue;
      for (let i = 0; i < P; i++) {
        if (!heard[i * RA + a]) {
          cNode.push(i);
          cRad.push(a);
        }
      }
    }
  }

  const zFloor = new Float64Array(NF);
  for (let f = 0; f < NF; f++) zFloor[f] = prep.floorList[f] * FLOOR_HEIGHT + PHONE_HEIGHT;

  const radDev = new Int32Array(RA);
  const p0Ref = new Float64Array(RA);
  for (let a = 0; a < RA; a++) {
    const r = radios[list[a]];
    radDev[a] = devActive[r.device];
    // A perda no espaço livre a 1 m cresce com 20·log10(f): física, não ajuste.
    p0Ref[a] = P0_REF_24 - 20 * Math.log10(Math.max(2000, r.freq) / 2437);
  }

  return {
    P, RA, DA, NF, size, oX, oA, oR, p0Index, mainFloor, list, devList, active, devActive,
    M, oNode, oRad, oFloor, oY, oW,
    C: cNode.length, cNode: Int32Array.from(cNode), cRad: Int32Array.from(cRad),
    zFloor, radDev, p0Ref, edges, triples: prep.triples, nodeFloor: prep.nodeFloor,
    sigA: new Float64Array(RA).fill(cfg.sigma),
    rooms: prep.rooms,
    spotOrder: prep.spotOrder,
    hop: 0,
    known: prep.known || [],
  };
}

/**
 * Custo total e gradiente. theta = [nós xy | aparelhos xyz | rádios (n, alpha) | p0 por (rádio, andar)].
 */
function costAndGrad(model, cfg, theta, grad) {
  const { P, RA, DA, NF, oA, oR, p0Index, M, oNode, oRad, oFloor, oY, oW, C, cNode, cRad, zFloor, radDev, p0Ref, edges, nodeFloor } = model;
  if (grad) grad.fill(0);
  let cost = 0;
  const sigA = model.sigA;
  const eps2 = NEAR_M * NEAR_M;

  // --- leituras ---
  for (let m = 0; m < M; m++) {
    const i = oNode[m];
    const a = oRad[m];
    const d3 = oA + 3 * radDev[a];
    const dx = theta[2 * i] - theta[d3];
    const dy = theta[2 * i + 1] - theta[d3 + 1];
    const dz = zFloor[oFloor[m]] - theta[d3 + 2];
    const q = dx * dx + dy * dy + dz * dz + eps2;
    const d = Math.sqrt(q);
    const L = (0.5 * Math.log(q)) / LN10;
    const n = theta[oR + 2 * a];
    const al = theta[oR + 2 * a + 1];
    const ip = p0Index[a * NF + oFloor[m]];
    const e = oY[m] - (theta[ip] - 10 * n * L - al * d);
    const ae = Math.abs(e);
    const sg = sigA[a];
    const w = oW[m] / (sg * sg);
    const kH = cfg.huber * sg;
    let ge; // d custo / d e
    if (ae <= kH) {
      cost += 0.5 * w * e * e;
      ge = w * e;
    } else {
      cost += w * kH * (ae - 0.5 * kH);
      ge = w * kH * (e > 0 ? 1 : -1);
    }
    if (grad) {
      // d pred / d q = -(5n/ln10)/q - alpha/(2d);  d custo / d pred = -ge
      const gq = ge * ((5 * n) / LN10 / q + al / (2 * d));
      grad[2 * i] += gq * 2 * dx;
      grad[2 * i + 1] += gq * 2 * dy;
      grad[d3] -= gq * 2 * dx;
      grad[d3 + 1] -= gq * 2 * dy;
      grad[d3 + 2] -= gq * 2 * dz;
      grad[ip] -= ge;
      grad[oR + 2 * a] += ge * 10 * L;
      grad[oR + 2 * a + 1] += ge * d;
    }
  }

  // --- "não ouvi": o previsto não pode ficar muito acima do limiar de detecção ---
  if (C > 0) {
    for (let c = 0; c < C; c++) {
      const i = cNode[c];
      const a = cRad[c];
      const f = nodeFloor[i];
      const d3 = oA + 3 * radDev[a];
      const dx = theta[2 * i] - theta[d3];
      const dy = theta[2 * i + 1] - theta[d3 + 1];
      const dz = zFloor[f] - theta[d3 + 2];
      const q = dx * dx + dy * dy + dz * dz + eps2;
      const d = Math.sqrt(q);
      const L = (0.5 * Math.log(q)) / LN10;
      const n = theta[oR + 2 * a];
      const al = theta[oR + 2 * a + 1];
      const ip = p0Index[a * NF + f];
      const e = theta[ip] - 10 * n * L - al * d - DETECT_DBM; // > 0 = devia ter aparecido
      if (e <= 0) continue;
      const sg = sigA[a];
      const wcA = cfg.censor / (sg * sg);
      const kH = cfg.huber * sg;
      let ge;
      if (e <= kH) {
        cost += 0.5 * wcA * e * e;
        ge = wcA * e;
      } else {
        cost += wcA * kH * (e - 0.5 * kH);
        ge = wcA * kH;
      }
      if (grad) {
        // aqui e = pred - limiar: d custo / d pred = +ge
        const gq = -ge * ((5 * n) / LN10 / q + al / (2 * d));
        grad[2 * i] += gq * 2 * dx;
        grad[2 * i + 1] += gq * 2 * dy;
        grad[d3] -= gq * 2 * dx;
        grad[d3 + 1] -= gq * 2 * dy;
        grad[d3 + 2] -= gq * 2 * dz;
        grad[ip] += ge;
        grad[oR + 2 * a] -= ge * 10 * L;
        grad[oR + 2 * a + 1] -= ge * d;
      }
    }
  }

  // --- caminhada: varreduras consecutivas não ficam mais longe que V_MAX·dt ---
  const wv = cfg.speedWeight;
  const ws = cfg.smoothWeight;
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k];
    const dx = theta[2 * e.a] - theta[2 * e.b];
    const dy = theta[2 * e.a + 1] - theta[2 * e.b + 1];
    const dist = Math.sqrt(dx * dx + dy * dy + 1e-9);
    // Passo esperado: andando sem parar, a corda entre duas varreduras fica perto de pace·dt
    // (corte seco para cima, cauda longa para baixo: curvas e pausas encurtam, nada alonga).
    let gd = 0; // d custo / d dist
    if (e.kind === 0 && e.dt < cfg.stepMaxDt) {
      const mode = cfg.pace * e.dt;
      const ex = dist - mode;
      const sd = (ex > 0 ? cfg.stepHi : cfg.stepLo) * mode;
      cost += (0.5 * cfg.stepWeight * ex * ex) / (sd * sd);
      gd = (cfg.stepWeight * ex) / (sd * sd);
    } else {
      // Parado numa das pontas (ou nas duas): só há teto, e mais baixo (parte do tempo foi parado).
      const still = e.kind === 2 ? cfg.dwellS : 0;
      const limit = (e.kind === 1 ? cfg.partFactor : 1) * cfg.pace * cfg.vTop * Math.max(1, e.dt - still);
      if (dist > limit) {
        const ex = dist - limit;
        const sd = cfg.stepHi * cfg.pace * Math.min(e.dt, 4);
        cost += (0.5 * wv * ex * ex) / (sd * sd);
        gd = (wv * ex) / (sd * sd);
      }
    }
    if (gd !== 0 && grad) {
      const g = gd / dist;
      grad[2 * e.a] += g * dx;
      grad[2 * e.a + 1] += g * dy;
      grad[2 * e.b] -= g * dx;
      grad[2 * e.b + 1] -= g * dy;
    }
    if (ws > 0) {
      // Atração fraca entre vizinhos no tempo (passeio aleatório): desempata e alisa.
      const w = ws / (e.dt * e.dt);
      cost += 0.5 * w * (dx * dx + dy * dy);
      if (grad) {
        grad[2 * e.a] += w * dx;
        grad[2 * e.a + 1] += w * dy;
        grad[2 * e.b] -= w * dx;
        grad[2 * e.b + 1] -= w * dy;
      }
    }
  }

  // --- andar reto: a segunda diferença pune o zigue-zague (que é ruído, não caminhada) ---
  if (cfg.accelWeight > 0) {
    const triples = model.triples;
    for (let k = 0; k < triples.length; k++) {
      const t = triples[k];
      const ax = theta[2 * t.a] - 2 * theta[2 * t.b] + theta[2 * t.c];
      const ay = theta[2 * t.a + 1] - 2 * theta[2 * t.b + 1] + theta[2 * t.c + 1];
      const sd = cfg.accelSigma * cfg.pace * t.dt;
      const w = cfg.accelWeight / (sd * sd);
      cost += 0.5 * w * (ax * ax + ay * ay);
      if (grad) {
        grad[2 * t.a] += w * ax;
        grad[2 * t.a + 1] += w * ay;
        grad[2 * t.b] -= 2 * w * ax;
        grad[2 * t.b + 1] -= 2 * w * ay;
        grad[2 * t.c] += w * ax;
        grad[2 * t.c + 1] += w * ay;
      }
    }
  }

  // --- distâncias medidas pelo usuário ---
  for (const kd of model.known) {
    const dx = theta[2 * kd.a] - theta[2 * kd.b];
    const dy = theta[2 * kd.a + 1] - theta[2 * kd.b + 1];
    const dist = Math.sqrt(dx * dx + dy * dy + 1e-9);
    const ex = dist - kd.meters;
    const w = cfg.knownWeight;
    cost += 0.5 * w * ex * ex;
    if (grad) {
      const g = (w * ex) / dist;
      grad[2 * kd.a] += g * dx;
      grad[2 * kd.a + 1] += g * dy;
      grad[2 * kd.b] -= g * dx;
      grad[2 * kd.b + 1] -= g * dy;
    }
  }

  // --- cômodos: pontos com o mesmo nome não ficam longe do centro do grupo ---
  if (cfg.roomWeight > 0 && model.hop > 0) {
    for (const nodes of model.rooms) {
      // Quem marca pontos espalha-os pelo cômodo: n pontos ocupam uma área ~ n·(espaçamento)².
      const radius = cfg.roomK * model.hop * Math.sqrt(nodes.length);
      let mx = 0;
      let my = 0;
      for (const i of nodes) {
        mx += theta[2 * i];
        my += theta[2 * i + 1];
      }
      mx /= nodes.length;
      my /= nodes.length;
      // Mantendo o centro fixo no gradiente (aproximação): o termo é pequeno e o centro quase não muda.
      for (const i of nodes) {
        const dx = theta[2 * i] - mx;
        const dy = theta[2 * i + 1] - my;
        const dist = Math.sqrt(dx * dx + dy * dy + 1e-9);
        const ex = (dist - radius) / model.hop;
        if (ex <= 0) continue;
        cost += 0.5 * cfg.roomWeight * ex * ex;
        if (grad) {
          const g = (cfg.roomWeight * ex) / (dist * model.hop);
          grad[2 * i] += g * dx;
          grad[2 * i + 1] += g * dy;
        }
      }
    }
  }

  // --- âncora de tamanho (levantamentos sem caminhada contínua): segura a escala já decidida ---
  if (model.sizeTarget > 0) {
    let mx = 0;
    let my = 0;
    for (let i = 0; i < P; i++) {
      mx += theta[2 * i];
      my += theta[2 * i + 1];
    }
    mx /= P;
    my /= P;
    let r2 = 0;
    for (let i = 0; i < P; i++) r2 += (theta[2 * i] - mx) * (theta[2 * i] - mx) + (theta[2 * i + 1] - my) * (theta[2 * i + 1] - my);
    r2 = r2 / P + 1e-9;
    const el = 0.5 * Math.log(r2 / (model.sizeTarget * model.sizeTarget));
    cost += 0.5 * cfg.sizeWeight * el * el;
    if (grad) {
      // d el / d x_i = (x_i - mx) / (P·r2)
      const g = (cfg.sizeWeight * el) / (P * r2);
      for (let i = 0; i < P; i++) {
        grad[2 * i] += g * (theta[2 * i] - mx);
        grad[2 * i + 1] += g * (theta[2 * i + 1] - my);
      }
    }
  }

  // --- priores dos rádios ---
  for (let a = 0; a < RA; a++) {
    const n = theta[oR + 2 * a];
    const al = theta[oR + 2 * a + 1];
    // n: perto do espaço livre (2) a ambientes carregados; as paredes ficam com alpha.
    const en = (n - cfg.nPrior) / cfg.nSigma;
    cost += 0.5 * en * en;
    if (grad) grad[oR + 2 * a] += en / cfg.nSigma;
    // alpha: não pode ser negativo (o sinal não cresce com paredes) e raramente passa de ~3 dB/m.
    if (al < 0) {
      cost += 0.5 * 400 * al * al;
      if (grad) grad[oR + 2 * a + 1] += 400 * al;
    } else {
      const ea = al / cfg.alphaSigma;
      cost += 0.5 * ea * ea;
      if (grad) grad[oR + 2 * a + 1] += ea / cfg.alphaSigma;
    }
    // p0 do andar principal: acima do valor de referência é raro (não existe roteador doméstico
    // muito mais forte); abaixo é comum (parede externa, laje, vizinho fraco).
    const ip = p0Index[a * NF + model.mainFloor[a]];
    const ep = theta[ip] - p0Ref[a];
    const sp = ep > 0 ? cfg.p0SigmaHi : cfg.p0SigmaLo;
    cost += (0.5 * ep * ep) / (sp * sp);
    if (grad) grad[ip] += ep / (sp * sp);
    for (let f = 0; f < NF; f++) {
      const jp = p0Index[a * NF + f];
      if (jp === ip) continue;
      // Outro andar: a laje só tira sinal.
      const eo = theta[jp] - theta[ip];
      if (eo > 0) {
        cost += (0.5 * eo * eo) / 9;
        if (grad) {
          grad[jp] += eo / 9;
          grad[ip] -= eo / 9;
        }
      }
    }
  }
  // --- priores dos aparelhos: altura plausível, e nada de fugir para o infinito ---
  for (let d = 0; d < DA; d++) {
    const d3 = oA + 3 * d;
    const ez = (theta[d3 + 2] - model.devZ0[d]) / cfg.zSigma;
    cost += 0.5 * ez * ez;
    if (grad) grad[d3 + 2] += ez / cfg.zSigma;
    const ex = theta[d3] / cfg.farSigma;
    const ey = theta[d3 + 1] / cfg.farSigma;
    cost += 0.5 * (ex * ex + ey * ey);
    if (grad) {
      grad[d3] += ex / cfg.farSigma;
      grad[d3 + 1] += ey / cfg.farSigma;
    }
  }
  return cost;
}

/**
 * Muda a escala do mapa inteiro por `s` sem mexer (quase) no ajuste das leituras:
 * posições e roteadores multiplicam por s, p0 sobe 10·n·log10(s) e alpha divide por s.
 */
function applyScale(model, theta, s, out) {
  const { P, RA, DA, NF, oA, oR, p0Index } = model;
  out.set(theta);
  for (let i = 0; i < 2 * P; i++) out[i] = theta[i] * s;
  for (let d = 0; d < DA; d++) {
    out[oA + 3 * d] = theta[oA + 3 * d] * s;
    out[oA + 3 * d + 1] = theta[oA + 3 * d + 1] * s;
  }
  const done = new Uint8Array(model.size);
  for (let a = 0; a < RA; a++) {
    const n = theta[oR + 2 * a];
    out[oR + 2 * a + 1] = theta[oR + 2 * a + 1] / s;
    for (let f = 0; f < NF; f++) {
      const ip = p0Index[a * NF + f];
      if (done[ip]) continue;
      done[ip] = 1;
      out[ip] = theta[ip] + 10 * n * Math.log10(s);
    }
  }
}

/** Busca 1-D da melhor escala (seção áurea em log). Devolve o fator aplicado. */
function scaleSearch(model, cfg, theta) {
  const tmp = new Float64Array(theta.length);
  const f = (ls) => {
    applyScale(model, theta, Math.exp(ls), tmp);
    return costAndGrad(model, cfg, tmp, null);
  };
  let lo = Math.log(0.4);
  let hi = Math.log(2.5);
  const g = 0.381966;
  let x1 = lo + g * (hi - lo);
  let x2 = hi - g * (hi - lo);
  let f1 = f(x1);
  let f2 = f(x2);
  for (let it = 0; it < 18; it++) {
    if (f1 < f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = lo + g * (hi - lo);
      f1 = f(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = hi - g * (hi - lo);
      f2 = f(x2);
    }
  }
  const best = 0.5 * (lo + hi);
  if (f(best) < f(0)) {
    applyScale(model, theta, Math.exp(best), tmp);
    theta.set(tmp);
    return Math.exp(best);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Partida dos roteadores: busca em grade com a curva ajustada em forma fechada
// ---------------------------------------------------------------------------

/**
 * Para um aparelho e posições de nós dadas, procura numa grade a posição que melhor explica as
 * leituras de todos os seus rádios (n e p0 por mínimos quadrados em cada candidato).
 */
function initDevices(prep, model, cfg, theta) {
  const { P, RA, DA, NF, oA, oR, p0Index, M, oNode, oRad, oFloor, oY, zFloor, radDev, p0Ref } = model;
  // Caixa dos nós.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < P; i++) {
    minX = Math.min(minX, theta[2 * i]);
    maxX = Math.max(maxX, theta[2 * i]);
    minY = Math.min(minY, theta[2 * i + 1]);
    maxY = Math.max(maxY, theta[2 * i + 1]);
  }
  const span = Math.max(2, maxX - minX, maxY - minY);
  const pad = Math.max(8, 1.2 * span);
  const G = 21;
  const obsByRadio = Array.from({ length: RA }, () => []);
  for (let m = 0; m < M; m++) obsByRadio[oRad[m]].push(m);
  const radiosOfDev = Array.from({ length: DA }, () => []);
  for (let a = 0; a < RA; a++) radiosOfDev[radDev[a]].push(a);
  const eps2 = NEAR_M * NEAR_M;

  for (let d = 0; d < DA; d++) {
    const d3 = oA + 3 * d;
    const z0 = model.devZ0[d];
    let best = { sse: Infinity, x: 0, y: 0, fits: null };
    for (let gx = 0; gx < G; gx++) {
      for (let gy = 0; gy < G; gy++) {
        const ax = minX - pad + ((maxX - minX + 2 * pad) * gx) / (G - 1);
        const ay = minY - pad + ((maxY - minY + 2 * pad) * gy) / (G - 1);
        let sse = 0;
        const fits = [];
        for (const a of radiosOfDev[d]) {
          // Inclinação comum, intercepto por andar.
          const list = obsByRadio[a];
          const sL = new Float64Array(NF);
          const sY = new Float64Array(NF);
          const cF = new Float64Array(NF);
          const Ls = new Float64Array(list.length);
          for (let k = 0; k < list.length; k++) {
            const m = list[k];
            const i = oNode[m];
            const dx = theta[2 * i] - ax;
            const dy = theta[2 * i + 1] - ay;
            const dz = zFloor[oFloor[m]] - z0;
            const L = (0.5 * Math.log(dx * dx + dy * dy + dz * dz + eps2)) / LN10;
            Ls[k] = L;
            sL[oFloor[m]] += L;
            sY[oFloor[m]] += oY[m];
            cF[oFloor[m]]++;
          }
          let sxx = 0;
          let sxy = 0;
          for (let k = 0; k < list.length; k++) {
            const m = list[k];
            const f = oFloor[m];
            const l = Ls[k] - sL[f] / cF[f];
            sxx += l * l;
            sxy += l * (oY[m] - sY[f] / cF[f]);
          }
          let n = sxx > 1e-9 ? -sxy / sxx / 10 : cfg.nInit;
          n = clamp(n, 1.6, 5);
          const p0 = new Float64Array(NF);
          for (let f = 0; f < NF; f++) p0[f] = cF[f] ? sY[f] / cF[f] + (10 * n * sL[f]) / cF[f] : NaN;
          for (let k = 0; k < list.length; k++) {
            const m = list[k];
            const e = oY[m] - (p0[oFloor[m]] - 10 * n * Ls[k]);
            const ae = Math.abs(e);
            sse += ae < 8 ? e * e : 8 * (2 * ae - 8);
          }
          // p0 muito acima da referência não existe: penaliza candidatos "longe demais".
          const hi = p0[model.mainFloor[a]] - p0Ref[a] - 3;
          if (hi > 0) sse += list.length * 0.5 * hi * hi * 0.25;
          fits.push({ a, n, p0 });
        }
        if (sse < best.sse) best = { sse, x: ax, y: ay, fits };
      }
    }
    theta[d3] = best.x;
    theta[d3 + 1] = best.y;
    theta[d3 + 2] = z0;
    if (best.fits) {
      for (const fit of best.fits) {
        theta[oR + 2 * fit.a] = fit.n;
        theta[oR + 2 * fit.a + 1] = 0;
        for (let f = 0; f < NF; f++) {
          const ip = p0Index[fit.a * NF + f];
          if (Number.isFinite(fit.p0[f]) && (f === model.mainFloor[fit.a] || ip !== p0Index[fit.a * NF + model.mainFloor[fit.a]])) theta[ip] = fit.p0[f];
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Trajetória em grade (HMM): integra a incerteza em vez de maximizar ponto a ponto
// ---------------------------------------------------------------------------

/** Grade que cobre os nós com folga. O tamanho da célula se ajusta para não passar de `maxCells`. */
function makeGrid(theta, P, margin, minCell, maxCells) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < P; i++) {
    minX = Math.min(minX, theta[2 * i]);
    maxX = Math.max(maxX, theta[2 * i]);
    minY = Math.min(minY, theta[2 * i + 1]);
    maxY = Math.max(maxY, theta[2 * i + 1]);
  }
  minX -= margin;
  maxX += margin;
  minY -= margin;
  maxY += margin;
  const area = (maxX - minX) * (maxY - minY);
  const cell = Math.max(minCell, Math.sqrt(area / maxCells));
  const nx = Math.max(2, Math.ceil((maxX - minX) / cell));
  const ny = Math.max(2, Math.ceil((maxY - minY) / cell));
  const G = nx * ny;
  const cx = new Float64Array(G);
  const cy = new Float64Array(G);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      cx[j * nx + i] = minX + (i + 0.5) * cell;
      cy[j * nx + i] = minY + (j + 0.5) * cell;
    }
  }
  return { minX, minY, cell, nx, ny, G, cx, cy };
}

/** Sinal previsto pela curva de cada rádio em cada célula: pred[(rádio·NF + andar)·G + célula]. */
function predictGrid(model, theta, grid) {
  const { RA, NF, oA, oR, p0Index, zFloor, radDev } = model;
  const { G, cx, cy } = grid;
  const eps2 = NEAR_M * NEAR_M;
  const pred = new Float32Array(RA * NF * G);
  for (let a = 0; a < RA; a++) {
    const d3 = oA + 3 * radDev[a];
    const ax = theta[d3];
    const ay = theta[d3 + 1];
    const az = theta[d3 + 2];
    const n = theta[oR + 2 * a];
    const al = theta[oR + 2 * a + 1];
    for (let f = 0; f < NF; f++) {
      const p0 = theta[p0Index[a * NF + f]];
      const dz = zFloor[f] - az;
      const base = (a * NF + f) * G;
      for (let c = 0; c < G; c++) {
        const dx = cx[c] - ax;
        const dy = cy[c] - ay;
        const q = dx * dx + dy * dy + dz * dz + eps2;
        pred[base + c] = p0 - (5 * n * Math.log(q)) / LN10 - al * Math.sqrt(q);
      }
    }
  }
  return pred;
}

/** Sinal previsto pela curva na posição de cada observação (e de cada par "não ouvi"). */
function predictAtNodes(model, theta) {
  const { RA, NF, oA, oR, p0Index, M, oNode, oRad, oFloor, C, cNode, cRad, zFloor, radDev, nodeFloor } = model;
  const eps2 = NEAR_M * NEAR_M;
  const at = (i, a, f) => {
    const d3 = oA + 3 * radDev[a];
    const dx = theta[2 * i] - theta[d3];
    const dy = theta[2 * i + 1] - theta[d3 + 1];
    const dz = zFloor[f] - theta[d3 + 2];
    const q = dx * dx + dy * dy + dz * dz + eps2;
    return theta[p0Index[a * NF + f]] - (5 * theta[oR + 2 * a] * Math.log(q)) / LN10 - theta[oR + 2 * a + 1] * Math.sqrt(q);
  };
  const obs = new Float64Array(M);
  for (let m = 0; m < M; m++) obs[m] = at(oNode[m], oRad[m], oFloor[m]);
  const cen = new Float64Array(C);
  for (let j = 0; j < C; j++) cen[j] = at(cNode[j], cRad[j], nodeFloor[cNode[j]]);
  return { obs, cen };
}

/**
 * Campo residual de cada rádio: o que a curva "sinal x distância" não explica (paredes, sombra)
 * e que se REPETE no mesmo lugar. Regressão por núcleo dos resíduos sobre as posições atuais.
 * Guarda somas e pesos por célula, mais a "pegada" de cada nó, para poder tirar a contribuição
 * do próprio nó (e dos vizinhos no tempo) na hora de avaliar onde ele está.
 */
function buildResidualField(model, cfg, theta, grid, h) {
  const { P, RA, NF, M, oNode, oRad, oFloor, oY, oW, C, cNode, cRad, nodeFloor } = model;
  const { G, nx, ny, minX, minY, cell } = grid;
  const at = predictAtNodes(model, theta);
  // Pegada de cada nó: células dentro de ~2,5 larguras do núcleo.
  const r = Math.max(1, Math.ceil((2.5 * h) / cell));
  const footStart = new Int32Array(P + 1);
  const footCell = [];
  const footW = [];
  for (let i = 0; i < P; i++) {
    footStart[i] = footCell.length;
    const x = theta[2 * i];
    const y = theta[2 * i + 1];
    const ci = Math.floor((x - minX) / cell);
    const cj = Math.floor((y - minY) / cell);
    for (let j = cj - r; j <= cj + r; j++) {
      if (j < 0 || j >= ny) continue;
      for (let ii = ci - r; ii <= ci + r; ii++) {
        if (ii < 0 || ii >= nx) continue;
        const dx = minX + (ii + 0.5) * cell - x;
        const dy = minY + (j + 0.5) * cell - y;
        const w = Math.exp((-0.5 * (dx * dx + dy * dy)) / (h * h));
        if (w < 0.02) continue;
        footCell.push(j * nx + ii);
        footW.push(w);
      }
    }
  }
  footStart[P] = footCell.length;
  const fc = Int32Array.from(footCell);
  const fw = Float32Array.from(footW);
  const S = new Float32Array(RA * NF * G);
  const W = new Float32Array(RA * NF * G);
  const resObs = new Float64Array(M);
  for (let m = 0; m < M; m++) {
    const res = clamp(oY[m] - at.obs[m], -cfg.fieldClip, cfg.fieldClip);
    resObs[m] = res;
    const base = (oRad[m] * NF + oFloor[m]) * G;
    const i = oNode[m];
    const w0 = oW[m];
    for (let k = footStart[i]; k < footStart[i + 1]; k++) {
      S[base + fc[k]] += w0 * fw[k] * res;
      W[base + fc[k]] += w0 * fw[k];
    }
  }
  // "Não ouvi": puxa o campo para baixo onde a curva prevê sinal audível.
  const resCen = new Float64Array(C);
  const wCen = cfg.censor;
  for (let j = 0; j < C; j++) {
    const res = clamp(Math.min(0, DETECT_DBM - 4 - at.cen[j]), -cfg.fieldClip, 0);
    resCen[j] = res;
    const i = cNode[j];
    const base = (cRad[j] * NF + nodeFloor[i]) * G;
    for (let k = footStart[i]; k < footStart[i + 1]; k++) {
      S[base + fc[k]] += wCen * fw[k] * res;
      W[base + fc[k]] += wCen * fw[k];
    }
  }
  // Consulta: contribuição de um nó para o campo de um (rádio, andar).
  const lookup = new Map();
  const key = (i, a, f) => (i * RA + a) * NF + f;
  for (let m = 0; m < M; m++) lookup.set(key(oNode[m], oRad[m], oFloor[m]), { w: oW[m], res: resObs[m] });
  for (let j = 0; j < C; j++) lookup.set(key(cNode[j], cRad[j], nodeFloor[cNode[j]]), { w: wCen, res: resCen[j] });
  const contribOf = (i, a, f) => lookup.get(key(i, a, f));
  return { S, W, footStart, fc, fw, resObs, resCen, h, contribOf };
}

/** Log-verossimilhança de cada nó em cada célula, com o modelo atual dos rádios (e o campo residual, se houver). */
function nodeEmissions(model, cfg, theta, grid, sigmaR, field, exclude) {
  const { P, RA, NF, M, oNode, oRad, oFloor, oY, oW, C, cNode, cRad, nodeFloor } = model;
  const { G } = grid;
  const pred = predictGrid(model, theta, grid);
  const logE = new Float32Array(P * G);
  const k = cfg.huber;
  // Com campo residual: tira de (S, W) a contribuição dos nós excluídos (o próprio e vizinhos no tempo).
  const dS = field ? new Float32Array(G) : null;
  const dW = field ? new Float32Array(G) : null;
  const lambda = cfg.fieldLambda;
  const fieldAt = (base, i, a, f, isObsRadio) => {
    // Preenche dS/dW com o que sai, só nas pegadas dos nós excluídos.
    const list = exclude[i];
    for (const j of list) {
      for (let q = field.footStart[j]; q < field.footStart[j + 1]; q++) {
        dS[field.fc[q]] = 0;
        dW[field.fc[q]] = 0;
      }
    }
    for (const j of list) {
      const contrib = field.contribOf(j, a, f);
      if (!contrib) continue;
      for (let q = field.footStart[j]; q < field.footStart[j + 1]; q++) {
        dS[field.fc[q]] += contrib.w * field.fw[q] * contrib.res;
        dW[field.fc[q]] += contrib.w * field.fw[q];
      }
    }
  };
  const clearAt = (i) => {
    for (const j of exclude[i]) {
      for (let q = field.footStart[j]; q < field.footStart[j + 1]; q++) {
        dS[field.fc[q]] = 0;
        dW[field.fc[q]] = 0;
      }
    }
  };
  for (let m = 0; m < M; m++) {
    const a = oRad[m];
    const base = (a * NF + oFloor[m]) * G;
    const i = oNode[m];
    const out = i * G;
    const inv = 1 / sigmaR[a];
    const w = oW[m] * cfg.emissionWeight;
    const y = oY[m];
    if (field) {
      fieldAt(base, i, a, oFloor[m]);
      const S = field.S;
      const W = field.W;
      for (let c = 0; c < G; c++) {
        const res = (S[base + c] - dS[c]) / (W[base + c] - dW[c] + lambda);
        const e = Math.abs(y - pred[base + c] - res) * inv;
        logE[out + c] -= w * (e <= k ? 0.5 * e * e : k * (e - 0.5 * k));
      }
      clearAt(i);
    } else {
      for (let c = 0; c < G; c++) {
        const e = Math.abs(y - pred[base + c]) * inv;
        logE[out + c] -= w * (e <= k ? 0.5 * e * e : k * (e - 0.5 * k));
      }
    }
  }
  const wc = cfg.censor * cfg.emissionWeight;
  for (let j = 0; j < C; j++) {
    const a = cRad[j];
    const i = cNode[j];
    const base = (a * NF + nodeFloor[i]) * G;
    const out = i * G;
    const inv = 1 / sigmaR[a];
    if (field) {
      fieldAt(base, i, a, nodeFloor[i]);
      const S = field.S;
      const W = field.W;
      for (let c = 0; c < G; c++) {
        const res = (S[base + c] - dS[c]) / (W[base + c] - dW[c] + lambda);
        const e = (pred[base + c] + res - DETECT_DBM) * inv;
        if (e > 0) logE[out + c] -= wc * (e <= k ? 0.5 * e * e : k * (e - 0.5 * k));
      }
      clearAt(i);
    } else {
      for (let c = 0; c < G; c++) {
        const e = (pred[base + c] - DETECT_DBM) * inv;
        if (e > 0) logE[out + c] -= wc * (e <= k ? 0.5 * e * e : k * (e - 0.5 * k));
      }
    }
  }
  return logE;
}

/** Núcleo de transição: gaussiana truncada (passeio aleatório com teto de velocidade). */
function makeKernel(cell, sd, rMax) {
  const r = Math.max(1, Math.ceil(rMax / cell));
  const dx = [];
  const dy = [];
  const w = [];
  const d2 = [];
  let total = 0;
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const dist2 = (i * i + j * j) * cell * cell;
      if (dist2 > (rMax + 0.5 * cell) * (rMax + 0.5 * cell)) continue;
      const v = Math.exp((-0.5 * dist2) / (sd * sd));
      dx.push(i);
      dy.push(j);
      w.push(v);
      d2.push(dist2);
      total += v;
    }
  }
  return { n: w.length, dx: Int32Array.from(dx), dy: Int32Array.from(dy), w: Float64Array.from(w, (v) => v / total), d2: Float64Array.from(d2) };
}

/**
 * Forward-backward sobre as visitas. Devolve a média a posteriori de cada visita, a
 * log-verossimilhança marginal e a estatística de passo E|delta|² dos pares andando.
 */
function runHmm(prep, model, cfg, grid, logE, q) {
  const { visits, links } = prep;
  const { G, nx, ny, cx, cy, cell } = grid;
  const V = visits.length;
  const kernels = new Map();
  const kernelFor = (link) => {
    // Desvio por eixo do passo: q para dt de referência (3,5 s), crescendo linear com dt;
    // com uma ponta parada o passo é menor; entre dois pontos marcados vale só "não muito longe".
    const dtEff = Math.min(link.dt, cfg.hmmMaxDt);
    let sd = q * (dtEff / 3.5);
    if (link.kind === 1) sd *= cfg.partFactor;
    let rMax = cfg.hmmCut * sd;
    if (link.kind === 2 && link.dt > cfg.stepMaxDt) {
      sd = q * cfg.spotHop;
      rMax = 3 * sd;
    }
    sd = Math.max(sd, 0.6 * cell);
    rMax = Math.max(rMax, 1.01 * cell);
    const key = `${Math.round(sd / cell * 8)}|${Math.round(rMax / cell * 4)}`;
    let kr = kernels.get(key);
    if (!kr) kernels.set(key, (kr = makeKernel(cell, sd, rMax)));
    return kr;
  };
  const emis = (v) => {
    const base = visits[v].node * G;
    const e = new Float64Array(G);
    let top = -Infinity;
    for (let c = 0; c < G; c++) if (logE[base + c] > top) top = logE[base + c];
    for (let c = 0; c < G; c++) e[c] = Math.exp(logE[base + c] - top);
    return { e, top };
  };
  const spread = (src, kr, out) => {
    out.fill(0);
    let top = 0;
    for (let c = 0; c < G; c++) if (src[c] > top) top = src[c];
    const tiny = top * 1e-7;
    for (let c = 0; c < G; c++) {
      const v = src[c];
      if (v <= tiny) continue;
      const ci = c % nx;
      const cj = (c - ci) / nx;
      for (let k = 0; k < kr.n; k++) {
        const i = ci + kr.dx[k];
        const j = cj + kr.dy[k];
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        out[j * nx + i] += v * kr.w[k];
      }
    }
  };
  const alpha = new Array(V);
  const E = new Array(V);
  let loglik = 0;
  const tmp = new Float64Array(G);
  for (let v = 0; v < V; v++) {
    const { e, top } = emis(v);
    E[v] = e;
    const a = new Float64Array(G);
    if (v === 0) for (let c = 0; c < G; c++) a[c] = e[c] / G;
    else {
      spread(alpha[v - 1], kernelFor(links[v - 1]), tmp);
      for (let c = 0; c < G; c++) a[c] = tmp[c] * e[c];
    }
    let sum = 0;
    for (let c = 0; c < G; c++) sum += a[c];
    if (!(sum > 0)) {
      // Beco sem saída numérico: recomeça desta visita.
      for (let c = 0; c < G; c++) a[c] = e[c] / G;
      sum = 0;
      for (let c = 0; c < G; c++) sum += a[c];
      loglik -= 50;
    }
    for (let c = 0; c < G; c++) a[c] /= sum;
    loglik += Math.log(sum) + top;
    alpha[v] = a;
  }
  const mean = new Float64Array(2 * V);
  const spreadM = new Float64Array(V);
  let beta = new Float64Array(G).fill(1);
  let stepSum = 0;
  let stepCount = 0;
  const B = new Float64Array(G);
  for (let v = V - 1; v >= 0; v--) {
    if (v < V - 1) {
      const kr = kernelFor(links[v]);
      for (let c = 0; c < G; c++) B[c] = E[v + 1][c] * beta[c];
      // Estatística de passo do par (v, v+1): só pares andando, com intervalo normal.
      const link = links[v];
      if (link.kind === 0 && link.dt < cfg.stepMaxDt) {
        const a = alpha[v];
        let top = 0;
        for (let c = 0; c < G; c++) if (a[c] > top) top = a[c];
        const tiny = top * 1e-6;
        let z = 0;
        let s2 = 0;
        for (let c = 0; c < G; c++) {
          const av = a[c];
          if (av <= tiny) continue;
          const ci = c % nx;
          const cj = (c - ci) / nx;
          for (let k = 0; k < kr.n; k++) {
            const i = ci + kr.dx[k];
            const j = cj + kr.dy[k];
            if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
            const w = av * kr.w[k] * B[j * nx + i];
            z += w;
            s2 += w * kr.d2[k];
          }
        }
        if (z > 0) {
          const scale = 3.5 / link.dt;
          stepSum += (s2 / z) * scale * scale;
          stepCount++;
        }
      }
      const nb = new Float64Array(G);
      spread(B, kr, nb);
      let sum = 0;
      for (let c = 0; c < G; c++) sum += nb[c];
      if (sum > 0) for (let c = 0; c < G; c++) nb[c] /= sum;
      else nb.fill(1);
      beta = nb;
    }
    const a = alpha[v];
    let sum = 0;
    let mx = 0;
    let my = 0;
    for (let c = 0; c < G; c++) {
      const p = a[c] * beta[c];
      sum += p;
      mx += p * cx[c];
      my += p * cy[c];
    }
    if (sum > 0) {
      mx /= sum;
      my /= sum;
      let var2 = 0;
      for (let c = 0; c < G; c++) {
        const p = a[c] * beta[c];
        if (p > 0) var2 += p * ((cx[c] - mx) * (cx[c] - mx) + (cy[c] - my) * (cy[c] - my));
      }
      spreadM[v] = Math.sqrt(var2 / sum);
    } else {
      mx = cx[G >> 1];
      my = cy[G >> 1];
      spreadM[v] = 10;
    }
    mean[2 * v] = mx;
    mean[2 * v + 1] = my;
  }
  return { mean, spread: spreadM, loglik, stepMs: stepCount ? stepSum / stepCount : NaN, stepCount };
}

/** Vizinhança no tempo de cada nó (inclui o próprio): quem fica de fora do campo ao localizá-lo. */
function timeNeighbours(prep, window) {
  const { N, P, nodeOf } = prep;
  const sets = Array.from({ length: P }, (_, i) => new Set([i]));
  for (let i = 0; i < N; i++) {
    for (let d = -window; d <= window; d++) {
      const j = i + d;
      if (j >= 0 && j < N) sets[nodeOf[i]].add(nodeOf[j]);
    }
  }
  return sets.map((set) => Array.from(set));
}

/** Resíduo típico de cada rádio com o campo residual (deixando o próprio nó de fora). */
function fieldSigmas(model, cfg, theta, grid, field, exclude) {
  const { RA, NF, M, oNode, oRad, oFloor } = model;
  const { G, nx, ny, minX, minY, cell } = grid;
  const s2 = new Float64Array(RA);
  const cnt = new Float64Array(RA);
  for (let m = 0; m < M; m++) {
    const i = oNode[m];
    const a = oRad[m];
    const f = oFloor[m];
    const ci = clamp(Math.floor((theta[2 * i] - minX) / cell), 0, nx - 1);
    const cj = clamp(Math.floor((theta[2 * i + 1] - minY) / cell), 0, ny - 1);
    const c = cj * nx + ci;
    const base = (a * NF + f) * G;
    let sOut = 0;
    let wOut = 0;
    for (const j of exclude[i]) {
      const contrib = field.contribOf(j, a, f);
      if (!contrib) continue;
      for (let q = field.footStart[j]; q < field.footStart[j + 1]; q++) {
        if (field.fc[q] === c) {
          sOut += contrib.w * field.fw[q] * contrib.res;
          wOut += contrib.w * field.fw[q];
          break;
        }
      }
    }
    const res = (field.S[base + c] - sOut) / (field.W[base + c] - wOut + cfg.fieldLambda);
    const e = clamp(field.resObs[m] - res, -12, 12);
    s2[a] += e * e;
    cnt[a]++;
  }
  const out = new Float64Array(RA);
  for (let a = 0; a < RA; a++) out[a] = clamp(Math.sqrt((s2[a] + 2 * cfg.sigma * cfg.sigma) / (cnt[a] + 2)), cfg.fieldSigmaMin, cfg.sigmaMax);
  return out;
}

/**
 * Peso de cada rádio no ajuste geométrico: quem a curva explica bem (vizinho distante, sem
 * paredes no meio do caminho andado) vale mais que quem ela explica mal. O peso MÉDIO fica o
 * de cfg.sigma, para não mexer no equilíbrio com o prior de passo.
 */
function updateRadioWeights(model, cfg, theta) {
  const raw = radioSigmas(model, cfg, theta);
  let inv = 0;
  for (let a = 0; a < model.RA; a++) inv += Math.pow(raw[a], -2 * cfg.radioWeights);
  const norm = Math.sqrt(inv / Math.max(1, model.RA)); // sigma efetivo = cfg.sigma · raw^g · norm
  for (let a = 0; a < model.RA; a++) model.sigA[a] = cfg.sigma * Math.pow(raw[a], cfg.radioWeights) * norm;
}

/** Resíduo típico de cada rádio (dB) com as posições atuais: dá o peso de cada um. */
function radioSigmas(model, cfg, theta) {
  const { RA, NF, oA, oR, p0Index, M, oNode, oRad, oFloor, oY, zFloor, radDev } = model;
  const s2 = new Float64Array(RA);
  const cnt = new Float64Array(RA);
  const eps2 = NEAR_M * NEAR_M;
  for (let m = 0; m < M; m++) {
    const i = oNode[m];
    const a = oRad[m];
    const d3 = oA + 3 * radDev[a];
    const dx = theta[2 * i] - theta[d3];
    const dy = theta[2 * i + 1] - theta[d3 + 1];
    const dz = zFloor[oFloor[m]] - theta[d3 + 2];
    const q = dx * dx + dy * dy + dz * dz + eps2;
    const e = oY[m] - (theta[p0Index[a * NF + oFloor[m]]] - (5 * theta[oR + 2 * a] * Math.log(q)) / LN10 - theta[oR + 2 * a + 1] * Math.sqrt(q));
    const ce = clamp(e, -12, 12);
    s2[a] += ce * ce;
    cnt[a]++;
  }
  const out = new Float64Array(RA);
  for (let a = 0; a < RA; a++) out[a] = clamp(Math.sqrt((s2[a] + 2 * cfg.sigma * cfg.sigma) / (cnt[a] + 2)), cfg.sigmaMin, cfg.sigmaMax);
  return out;
}

// ---------------------------------------------------------------------------
// Escala absoluta quando não há caminhada contínua (só pontos marcados)
// ---------------------------------------------------------------------------

/**
 * Tempo andando entre duas varreduras consecutivas, pelo sinal da rede conectada: parado, o
 * nível fica num platô (só ruído); andando, ele muda. A chegada é o começo do platô final.
 * Devolve segundos, ou NaN quando não dá para dizer.
 */
function walkTimes(survey, prep, cfg) {
  const scans = prep.scans;
  const track = Array.isArray(survey.track) ? survey.track : [];
  const out = new Float64Array(scans.length).fill(NaN); // out[i]: tempo andando entre i-1 e i
  if (track.length < 8) return out;
  // Trechos de amostras entre uma varredura e a seguinte.
  const segs = new Array(scans.length).fill(null);
  let k = 0;
  for (let i = 1; i < scans.length; i++) {
    const t0 = scans[i - 1].t;
    const t1 = scans[i].t;
    while (k < track.length && track[k].t <= t0) k++;
    const seg = [];
    for (let j = k; j < track.length && track[j].t <= t1 + 0.2; j++) seg.push(track[j]);
    if (seg.length >= 5 && seg.every((q) => q.id === seg[0].id)) segs[i] = seg;
  }
  // Ruído do platô, medido nas últimas amostras antes de cada varredura parada (aí o usuário
  // com certeza está esperando): a tolerância acompanha o ruído real do aparelho.
  const dev = [];
  for (let i = 1; i < scans.length; i++) {
    if (!segs[i] || scans[i].spot == null) continue;
    const tail = segs[i].slice(-4).map((q) => q.rssi);
    const mid = median(tail);
    for (const v of tail) dev.push(Math.abs(v - mid));
  }
  const noise = dev.length >= 12 ? clamp(1.25 * (dev.reduce((t, v) => t + v, 0) / dev.length) * 1.3, 0.6, 3) : 1.1;
  const tol = cfg.plateauSigmas * noise;
  for (let i = 1; i < scans.length; i++) {
    const seg = segs[i];
    if (!seg) continue;
    const t0 = scans[i - 1].t;
    const level = median(seg.slice(seg.length >> 1).map((q) => q.rssi));
    const off = seg.map((q) => Math.abs(q.rssi - level) > tol);
    let last = -1;
    for (let j = seg.length - 1; j >= 0; j--) {
      if (!off[j]) continue;
      // Uma amostra solta fora do platô, com as vizinhas dentro, é leitura ruim e não movimento.
      if (j > 2 && j < seg.length - 1 && !off[j - 1] && !off[j + 1]) continue;
      last = j;
      break;
    }
    const step = seg.length > 1 ? (seg[seg.length - 1].t - seg[0].t) / (seg.length - 1) : 2;
    const arrive = last >= 0 ? seg[last].t + 0.5 * step : t0 + cfg.leaveS;
    out[i] = Math.max(0, arrive - (t0 + cfg.leaveS));
  }
  return out;
}

/**
 * Indícios de escala para levantamentos sem caminhada contínua. Cada um devolve o fator pelo
 * qual o mapa atual deveria ser multiplicado (ou NaN), e um desvio em log2.
 */
function scaleEvidence(survey, prep, model, cfg, theta) {
  const { scans, nodeOf } = prep;
  const out = {};
  // (1) Tempo andando x distância no mapa entre pontos consecutivos.
  {
    const wt = walkTimes(survey, prep, cfg);
    let sumT = 0;
    let sumL = 0;
    let count = 0;
    for (let i = 1; i < scans.length; i++) {
      if (!Number.isFinite(wt[i]) || nodeOf[i] === nodeOf[i - 1]) continue;
      if (scans[i].spot == null || scans[i - 1].spot == null) continue;
      const a = nodeOf[i - 1];
      const b = nodeOf[i];
      sumT += Math.min(wt[i], cfg.walkCapS);
      sumL += Math.hypot(theta[2 * a] - theta[2 * b], theta[2 * a + 1] - theta[2 * b + 1]);
      count++;
    }
    out.walk = count >= 6 && sumL > 1e-6 && sumT > 0 ? (cfg.walkSpeed * sumT) / sumL : NaN;
    out.walkCount = count;
  }
  // (2) Física perto do roteador: em visada direta o sinal cai ~20 dB por década a partir de p0.
  {
    const { RA, NF, oA, M, oNode, oRad, oFloor, oY, zFloor, radDev, p0Ref } = model;
    const ratios = [];
    for (let m = 0; m < M; m++) {
      const a = oRad[m];
      const drop = p0Ref[a] - cfg.bodyMeanDb - oY[m];
      if (drop > cfg.nearDropDb) continue; // longe demais: já há parede no meio
      const d3 = oA + 3 * radDev[a];
      const i = oNode[m];
      const rho = Math.hypot(theta[2 * i] - theta[d3], theta[2 * i + 1] - theta[d3 + 1]);
      const dz = zFloor[oFloor[m]] - theta[d3 + 2];
      const dPhys = Math.pow(10, drop / (10 * cfg.nLos));
      // Só vale quando a distância horizontal domina (roteador no teto, colado: não diz nada).
      if (dPhys < 2 * Math.abs(dz) || rho < 0.5) continue;
      ratios.push(Math.sqrt(dPhys * dPhys - dz * dz) / rho);
    }
    out.physics = ratios.length >= 3 ? median(ratios) : NaN;
    out.physicsCount = ratios.length;
  }
  // (3) Espaçamento: quem marca pontos costuma andar alguns passos entre um e outro.
  {
    const hops = [];
    for (let i = 1; i < scans.length; i++) {
      if (scans[i].spot == null || scans[i - 1].spot == null || nodeOf[i] === nodeOf[i - 1]) continue;
      const a = nodeOf[i - 1];
      const b = nodeOf[i];
      hops.push(Math.hypot(theta[2 * a] - theta[2 * b], theta[2 * a + 1] - theta[2 * b + 1]));
    }
    out.hop = hops.length >= 6 ? cfg.hopM / Math.max(1e-6, median(hops)) : NaN;
  }
  return out;
}

/** Junta os indícios de escala (média em log, pesada pela confiança de cada um). */
function combineEvidence(ev, cfg) {
  let sum = 0;
  let weight = 0;
  const add = (value, sd) => {
    if (!Number.isFinite(value) || value <= 0) return;
    const w = 1 / (sd * sd);
    sum += w * Math.log(clamp(value, 0.2, 5));
    weight += w;
  };
  add(ev.walk, cfg.evWalkSd);
  add(ev.physics, cfg.evPhysicsSd);
  add(ev.hop, cfg.evHopSd);
  return weight > 0 ? { factor: Math.exp(sum / weight), sd: 1 / Math.sqrt(weight) } : null;
}

/**
 * Alinha cada membro do conjunto ao primeiro (rotação, espelho e translação) e tira a média dos
 * nós; os roteadores vêm do primeiro membro. O tamanho final é a média dos tamanhos.
 */
function averageMembers(model, members, out) {
  const { P } = model;
  const ref = members[0];
  const a0 = cloudRadius(ref, P);
  out.set(ref);
  const acc = new Float64Array(2 * P);
  let size = 0;
  for (const th of members) {
    const c = cloudRadius(th, P);
    size += c.r;
    // Procrustes fechado (números complexos), com e sem espelho.
    let a = 0;
    let b = 0;
    let am = 0;
    let bm = 0;
    for (let i = 0; i < P; i++) {
      const px = th[2 * i] - c.mx;
      const py = th[2 * i + 1] - c.my;
      const qx = ref[2 * i] - a0.mx;
      const qy = ref[2 * i + 1] - a0.my;
      a += px * qx + py * qy;
      b += px * qy - py * qx;
      am += px * qx - py * qy;
      bm += px * qy + py * qx;
    }
    const mirror = Math.hypot(am, bm) > Math.hypot(a, b);
    const ang = mirror ? Math.atan2(bm, am) : Math.atan2(b, a);
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    const m = mirror ? -1 : 1;
    for (let i = 0; i < P; i++) {
      const px = th[2 * i] - c.mx;
      const py = (th[2 * i + 1] - c.my) * m;
      acc[2 * i] += cs * px - sn * py;
      acc[2 * i + 1] += sn * px + cs * py;
    }
  }
  const K = members.length;
  for (let i = 0; i < P; i++) {
    out[2 * i] = acc[2 * i] / K + a0.mx;
    out[2 * i + 1] = acc[2 * i + 1] / K + a0.my;
  }
  // A média encolhe (os erros se cancelam): devolve o tamanho médio dos membros.
  const now_ = cloudRadius(out, P);
  const k = now_.r > 1e-9 ? size / K / now_.r : 1;
  for (let i = 0; i < P; i++) {
    out[2 * i] = now_.mx + k * (out[2 * i] - now_.mx);
    out[2 * i + 1] = now_.my + k * (out[2 * i + 1] - now_.my);
  }
}

/** Espaçamento típico entre pontos marcados consecutivos, no mapa atual (0 se não houver). */
function spotHop(model, theta) {
  const order = model.spotOrder;
  const hops = [];
  for (let k = 1; k < order.length; k++) {
    const a = order[k - 1];
    const b = order[k];
    hops.push(Math.hypot(theta[2 * a] - theta[2 * b], theta[2 * a + 1] - theta[2 * b + 1]));
  }
  return hops.length >= 4 ? median(hops) : 0;
}

/** Diagnósticos de uma solução (só para estudo): critérios que poderiam distinguir soluções. */
function diagnostics(survey, prep, model, cfg, theta) {
  const { RA, NF, oA, oR, p0Index, M, oNode, oRad, oFloor, oY, zFloor, radDev } = model;
  const { scans, nodeOf, N } = prep;
  const eps2 = NEAR_M * NEAR_M;
  const out = {};
  // rumo de cada nó andando (direção entre vizinhos no tempo)
  const hx = new Float64Array(model.P);
  const hy = new Float64Array(model.P);
  const hasH = new Uint8Array(model.P);
  for (let i = 1; i < N - 1; i++) {
    if (scans[i].spot != null) continue;
    const a = nodeOf[i - 1];
    const b = nodeOf[i + 1];
    const dx = theta[2 * b] - theta[2 * a];
    const dy = theta[2 * b + 1] - theta[2 * a + 1];
    const l = Math.hypot(dx, dy);
    if (l < 0.3) continue;
    hx[nodeOf[i]] = dx / l;
    hy[nodeOf[i]] = dy / l;
    hasH[nodeOf[i]] = 1;
  }
  // correlação entre o resíduo e "roteador às costas"
  let sxy = 0, sxx = 0, syy = 0, sx = 0, sy = 0, cnt = 0, sse = 0, accel = 0, accN = 0;
  for (let m = 0; m < M; m++) {
    const i = oNode[m];
    const a = oRad[m];
    const d3 = oA + 3 * radDev[a];
    const dx = theta[d3] - theta[2 * i];
    const dy = theta[d3 + 1] - theta[2 * i + 1];
    const dz = zFloor[oFloor[m]] - theta[d3 + 2];
    const q = dx * dx + dy * dy + dz * dz + eps2;
    const e = oY[m] - (theta[p0Index[a * NF + oFloor[m]]] - (5 * theta[oR + 2 * a] * Math.log(q)) / LN10 - theta[oR + 2 * a + 1] * Math.sqrt(q));
    sse += Math.min(e * e, 144);
    if (!hasH[i]) continue;
    const rho = Math.hypot(dx, dy);
    if (rho < 0.5) continue;
    const ahead = (dx * hx[i] + dy * hy[i]) / rho;
    const behind = (1 - ahead) / 2;
    const x = behind * behind * (rho / Math.sqrt(q));
    const ce = clamp(e, -12, 12);
    sx += x; sy += ce; sxx += x * x; syy += ce * ce; sxy += x * ce; cnt++;
  }
  const cov = sxy / cnt - (sx / cnt) * (sy / cnt);
  const vx = sxx / cnt - (sx / cnt) ** 2;
  const vy = syy / cnt - (sy / cnt) ** 2;
  out.bodySlope = cov / vx; // dB por unidade de "às costas" (esperado: negativo, ~ -5)
  out.bodyCorr = cov / Math.sqrt(vx * vy);
  out.rms = Math.sqrt(sse / M);
  for (const t of model.triples) {
    const ax = theta[2 * t.a] - 2 * theta[2 * t.b] + theta[2 * t.c];
    const ay = theta[2 * t.a + 1] - 2 * theta[2 * t.b + 1] + theta[2 * t.c + 1];
    accel += ax * ax + ay * ay;
    accN++;
  }
  out.accelRms = Math.sqrt(accel / Math.max(1, accN));
  const steps = [];
  for (const e of prep.edges) if (e.kind === 0 && e.dt < 8) steps.push(Math.hypot(theta[2 * e.a] - theta[2 * e.b], theta[2 * e.a + 1] - theta[2 * e.b + 1]));
  out.stepCv = steps.length ? Math.sqrt(steps.reduce((t, v) => t + v * v, 0) / steps.length - (steps.reduce((t, v) => t + v, 0) / steps.length) ** 2) / (steps.reduce((t, v) => t + v, 0) / steps.length) : NaN;
  return out;
}

/** Raio quadrático médio dos nós em torno do centro. */
function cloudRadius(theta, P) {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < P; i++) {
    mx += theta[2 * i];
    my += theta[2 * i + 1];
  }
  mx /= P;
  my /= P;
  let r2 = 0;
  for (let i = 0; i < P; i++) r2 += (theta[2 * i] - mx) * (theta[2 * i] - mx) + (theta[2 * i + 1] - my) * (theta[2 * i + 1] - my);
  return { r: Math.sqrt(r2 / Math.max(1, P)), mx, my };
}

// ---------------------------------------------------------------------------
// Solução
// ---------------------------------------------------------------------------

const DEFAULT_CFG = {
  minObs: 5, // leituras para um rádio entrar no ajuste
  sigma: 6, // dB: ruído + corpo + sombra que a curva não explica
  huber: 1.5,
  radioWeights: 0, // 0 = todos iguais; 1 = peso pelo resíduo de cada rádio
  deviceCorr: 0, // correlação entre os erros das faixas de um mesmo aparelho
  censor: 0.5, // peso do "não ouvi"
  censorMinObs: 8,
  pace: 0.65, // m/s: corda típica entre varreduras de quem anda a 0,4-0,9 m/s com curvas
  stepHi: 0.22, // desvio relativo acima do passo esperado
  stepLo: 0.5, // e abaixo
  stepWeight: 6,
  stepMaxDt: 8, // s: acima disto o intervalo não diz nada sobre o passo
  vTop: 1.3, // teto = vTop·pace (trecho reto no passo mais rápido)
  partFactor: 0.75, // par com uma ponta parada: parte do intervalo foi parado
  dwellS: 3, // dois pontos marcados seguidos: varredura + sair + chegar
  speedWeight: 1,
  accelWeight: 0,
  accelSigma: 0.8, // desvio da segunda diferença, em passos
  smoothWeight: 0.0,
  knownWeight: 100,
  nPrior: 2.6,
  nSigma: 0.8,
  nInit: 3,
  alphaSigma: 3,
  p0SigmaHi: 30,
  p0SigmaLo: 40,
  zSigma: 1.0,
  farSigma: 60,
  roomWeight: 0, // pontos do mesmo cômodo (nome dado pelo usuário) ficam juntos
  roomK: 0.6, // raio livre do cômodo = roomK · espaçamento · raiz(nº de pontos)
  maxIter: 300,
  rounds: 3,
  ensemble: 1,
  ensembleNoise: 1.0, // m de ruído na partida de cada membro
  // HMM
  emissionWeight: 1,
  sigmaMin: 3.5,
  sigmaMax: 9,
  hmmQ: 1.25, // m: desvio por eixo do passo em 3,5 s (corda rms ~0,5 m/s)
  hmmCut: 2.2, // truncamento do núcleo, em desvios
  hmmMaxDt: 7,
  spotHop: 2.0, // entre pontos marcados distantes no tempo: "alguns passos", em unidades de q
  hmmMinCell: 0.4,
  hmmMaxCells: 1200,
  // campo residual
  fieldRounds: 2,
  fieldH: 1.1, // m: largura do núcleo (paredes e sombra mudam em ~1-2 m)
  fieldLambda: 0.7, // encolhimento para zero onde há poucos vizinhos
  fieldClip: 15, // dB: resíduo maior que isto é leitura estranha
  fieldExclude: 1, // varreduras vizinhas no tempo que ficam de fora ao localizar um nó
  fieldSigmaMin: 2.5,
  fieldRefit: 0,
  // escala sem caminhada contínua
  plateauSigmas: 1.85, // tolerância em torno do platô do sinal conectado, em desvios do ruído
  leaveS: 0.65, // s entre a varredura chegar e o usuário sair andando
  walkCapS: 20,
  walkSpeed: 0.6, // m/s em linha reta entre pontos (anda-se a ~0,65 m/s, com desvios)
  bodyMeanDb: 1.5, // perda média do corpo
  nearDropDb: 12, // até ~3,7 m do roteador
  nLos: 2.1,
  hopM: 1.85, // m: distância típica entre pontos marcados seguidos
  evWalkSd: 0.4, // desvios (em log2... aqui em log natural equivalente) de cada indício
  evPhysicsSd: 0.36,
  evHopSd: 0.5,
  sizeWeight: 400,
  minStepEdges: 10, // abaixo disto a caminhada não ancora a escala
  turnCorrection: 1, // 0 desliga a correção de tortuosidade
  turnKappa: 0.5,
  turnTop: 1.5,
  lagShift: 0,
  emRounds: 0,
  emUpdateQ: 0,
  emFinalM: 0,
  mIter: 60,
};

function emptySolution(survey) {
  const scans = (survey && Array.isArray(survey.scans) ? survey.scans : []) || [];
  return {
    points: scans.map((s) => ({ x: 0, y: 0, z: (Number.isFinite(s && s.floor) ? Math.round(s.floor) : 0) * FLOOR_HEIGHT, conf: 0 })),
    aps: {},
    scaleConf: 0,
  };
}

/**
 * @param {import('../types.js').Survey} survey
 * @param {{seed?: number, budgetMs?: number, onProgress?: (fraction: number, stage: string) => void}} [options]
 * @returns {import('../types.js').MapSolution}
 */
export function solve(survey, options = {}) {
  try {
    const solution = solveInner(survey, options || {});
    if (solution && validate(solution, survey)) return solution;
  } catch (err) {
    if (options && options.debug) throw err;
  }
  return emptySolution(survey);
}

function validate(solution, survey) {
  const n = survey && Array.isArray(survey.scans) ? survey.scans.length : 0;
  if (!Array.isArray(solution.points) || solution.points.length !== n) return false;
  for (const p of solution.points) if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  for (const a of Object.values(solution.aps)) {
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(a.z) || !Number.isFinite(a.p0) || !Number.isFinite(a.n)) return false;
  }
  return true;
}

function solveInner(survey, options) {
  const t0 = now();
  const budget = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : 4000;
  const deadline = t0 + Math.min(0.55 * budget, 2600);
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const cfg = { ...DEFAULT_CFG, ...(options.cfg || {}) };
  if (!survey || !Array.isArray(survey.scans) || survey.scans.length === 0) return emptySolution(survey);

  const scanIdx = survey.scans.map((_, i) => i);
  const prep = prepare(survey, scanIdx);
  const { P, N } = prep;
  progress(0.05, 'preparo');

  const model = buildModel(prep, cfg);
  if (P < 2 || model.RA === 0) return emptySolution(survey);

  // Altura inicial de cada aparelho: um pouco acima do celular, no andar onde chega mais forte.
  model.devZ0 = new Float64Array(model.DA);
  {
    const bestLevel = new Float64Array(model.DA).fill(-Infinity);
    for (let a = 0; a < model.RA; a++) {
      const d = model.radDev[a];
      let s = 0;
      let c = 0;
      for (let m = 0; m < model.M; m++) {
        if (model.oRad[m] === a && model.oFloor[m] === model.mainFloor[a]) {
          s += model.oY[m];
          c++;
        }
      }
      const level = c ? s / c : -Infinity;
      if (level > bestLevel[d]) {
        bestLevel[d] = level;
        model.devZ0[d] = model.zFloor[model.mainFloor[a]] + 0.6;
      }
    }
  }

  const theta = new Float64Array(model.size);
  const X0 = initNodes(prep);
  rescaleInit(prep, X0, cfg.pace);
  theta.set(X0, 0);
  const warm = options.warmStart;
  if (warm && Array.isArray(warm.points) && warm.points.length === N) {
    // Partida dada por quem chama (ex.: a solução anterior do mesmo levantamento).
    for (let i = 0; i < N; i++) {
      theta[2 * prep.nodeOf[i]] = warm.points[i].x;
      theta[2 * prep.nodeOf[i] + 1] = warm.points[i].y;
    }
  }
  initDevices(prep, model, cfg, theta);
  if (warm && warm.aps) {
    for (let a = 0; a < model.RA; a++) {
      const id = prep.radios[model.list[a]].ids.find((q) => warm.aps[q]);
      if (!id) continue;
      const d3 = model.oA + 3 * model.radDev[a];
      theta[d3] = warm.aps[id].x;
      theta[d3 + 1] = warm.aps[id].y;
      if (Number.isFinite(warm.aps[id].z)) theta[d3 + 2] = warm.aps[id].z;
    }
  }
  progress(0.2, 'partida');

  const stages = [];
  const snapshot = (label) => {
    if (options.debug) stages.push({ label, solution: finalize(survey, prep, model, cfg, theta) });
  };
  snapshot('init');

  // Escala das variáveis para o L-BFGS: posições em metros, p0 em dB, n e alpha pequenos.
  const scale = new Float64Array(model.size).fill(1);
  for (let d = 0; d < model.DA; d++) for (let k = 0; k < 3; k++) scale[model.oA + 3 * d + k] = 2;
  for (let a = 0; a < model.RA; a++) {
    scale[model.oR + 2 * a] = 0.1;
    scale[model.oR + 2 * a + 1] = 0.05;
  }
  for (let i = model.oR + 2 * model.RA; i < model.size; i++) scale[i] = 0.5;
  const u = new Float64Array(model.size);
  const th = new Float64Array(model.size);
  const gth = new Float64Array(model.size);
  const fg = (uu, gu) => {
    for (let i = 0; i < uu.length; i++) th[i] = uu[i] * scale[i];
    const f = costAndGrad(model, cfg, th, gth);
    for (let i = 0; i < uu.length; i++) gu[i] = gth[i] * scale[i];
    if (cfg.freezeDev) for (let i = model.oA; i < model.oR; i++) gu[i] = 0;
    if (cfg.freezeNodes) for (let i = 0; i < model.oA; i++) gu[i] = 0;
    return f;
  };
  let res = { f: Infinity, iter: 0 };
  const notes = [];
  const study = {};
  const runSlam = (th, rounds) => {
    for (let round = 0; round < rounds; round++) {
      model.hop = spotHop(model, th);
      for (let i = 0; i < model.size; i++) u[i] = th[i] / scale[i];
      res = lbfgs(fg, u, { maxIter: cfg.maxIter, deadline, memory: 10 });
      for (let i = 0; i < model.size; i++) th[i] = u[i] * scale[i];
      const sc = scaleSearch(model, cfg, th);
      notes.push(`r${round}:${res.f.toFixed(0)}/${res.iter}/s${sc.toFixed(2)}`);
      if (cfg.radioWeights > 0) updateRadioWeights(model, cfg, th);
      if (now() > deadline) break;
    }
    return res.f;
  };
  runSlam(theta, cfg.rounds);
  if (cfg.ensemble > 1 && !warm) {
    // Conjunto: o ajuste tem um platô largo de soluções equivalentes; partidas diferentes caem
    // em pontos diferentes dele, e a média (depois de alinhar) fica mais perto do meio.
    const rng = makeRng((options.seed ?? 1) * 7919 + 13);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    const members = [Float64Array.from(theta)];
    for (let k = 1; k < cfg.ensemble && now() < deadline; k++) {
      const th = new Float64Array(model.size);
      for (let i = 0; i < 2 * P; i++) th[i] = X0[i] + cfg.ensembleNoise * gauss();
      initDevices(prep, model, cfg, th);
      runSlam(th, cfg.rounds);
      members.push(th);
    }
    averageMembers(model, members, theta);
    // Curvas e roteadores reajustados às posições médias.
    cfg.freezeNodes = 1;
    for (let i = 0; i < model.size; i++) u[i] = theta[i] / scale[i];
    lbfgs(fg, u, { maxIter: cfg.maxIter, deadline, memory: 10 });
    for (let i = 0; i < model.size; i++) theta[i] = u[i] * scale[i];
    cfg.freezeNodes = 0;
  }
  // --- escala: sem caminhada contínua, vem dos indícios (tempo andando, física, espaçamento) ---
  let stepEdges = 0;
  for (const e of prep.edges) if (e.kind <= 1 && e.dt < cfg.stepMaxDt) stepEdges++;
  const anchored = stepEdges >= cfg.minStepEdges || model.known.length > 0;
  let scaleSd = 0.25;
  if (!anchored) {
    const tmp = new Float64Array(model.size);
    for (let pass = 0; pass < 2; pass++) {
      const comb = combineEvidence(scaleEvidence(survey, prep, model, cfg, theta), cfg);
      if (!comb) break;
      scaleSd = comb.sd;
      applyScale(model, theta, comb.factor, tmp);
      theta.set(tmp);
      notes.push(`ev${pass}:x${comb.factor.toFixed(2)}`);
      model.sizeTarget = cloudRadius(theta, P).r;
      for (let i = 0; i < model.size; i++) u[i] = theta[i] / scale[i];
      res = lbfgs(fg, u, { maxIter: cfg.maxIter, deadline, memory: 10 });
      for (let i = 0; i < model.size; i++) theta[i] = u[i] * scale[i];
      if (now() > deadline) break;
    }
  }
  if (options.debug) study.diag = diagnostics(survey, prep, model, cfg, theta);
  let sizeAfterSlam = cloudRadius(theta, P).r;
  if (anchored && model.known.length === 0 && cfg.turnCorrection > 0) {
    // Casa pequena obriga a virar antes de completar um passo: a corda entre duas varreduras
    // encolhe em relação ao caminho andado (passeio aleatório: corda ~ raiz do caminho). O prior
    // de passo não sabe disso; corrige-se o tamanho final pela razão casa/passo.
    const rho = sizeAfterSlam / (cfg.pace * 3.5);
    const x = cfg.turnKappa * rho;
    const k = clamp(cfg.turnTop * Math.sqrt(x / (1 + x)), 0.7, 1.4);
    sizeAfterSlam *= 1 + cfg.turnCorrection * (k - 1);
    notes.push(`turn:x${k.toFixed(2)}`);
  }
  snapshot('slam');
  progress(0.6, 'ajuste');

  if (options.debug) study.evidence = scaleEvidence(survey, prep, model, cfg, theta);
  if (cfg.scaleStudy) {
    // Estudo de escala: itera só o q do HMM com as emissões paradas e vê onde ele assenta.
    const sigmaR = radioSigmas(model, cfg, theta);
    for (let a = 0; a < model.RA; a++) sigmaR[a] *= cfg.studySigmaScale || 1;
    const grid = makeGrid(theta, P, 3, cfg.hmmMinCell, cfg.hmmMaxCells);
    const logE = nodeEmissions(model, cfg, theta, grid, sigmaR, null, null);
    let qq = cfg.hmmQ;
    const seq = [];
    for (let k = 0; k < 25; k++) {
      const hm = runHmm(prep, model, cfg, grid, logE, qq);
      const qe = Math.sqrt(hm.stepMs / 2);
      seq.push(qe);
      if (!Number.isFinite(qe) || Math.abs(qe - qq) < 0.004) break;
      qq = qe;
    }
    study.qSeq = seq;
    // passo mediano do MAP
    const st = [];
    for (const e of prep.edges) if (e.kind === 0 && e.dt < 8) st.push(Math.hypot(theta[2 * e.a] - theta[2 * e.b], theta[2 * e.a + 1] - theta[2 * e.b + 1]) * 3.5 / e.dt);
    study.mapStepMed = median(st);
    study.mapStepRms = Math.sqrt(st.reduce((t, v) => t + v * v, 0) / Math.max(1, st.length));
  }

  // --- EM com a trajetória em grade ---
  let q = cfg.hmmQ;
  for (let em = 0; em < cfg.emRounds; em++) {
    const sigmaR = radioSigmas(model, cfg, theta);
    const grid = makeGrid(theta, P, Math.max(2, 2 * q), cfg.hmmMinCell, cfg.hmmMaxCells);
    const logE = nodeEmissions(model, cfg, theta, grid, sigmaR);
    const hm = runHmm(prep, model, cfg, grid, logE, q);
    // Posição de cada nó: média das visitas que passaram por ele.
    const acc = new Float64Array(2 * P);
    const cnt = new Float64Array(P);
    for (let v = 0; v < prep.visits.length; v++) {
      const node = prep.visits[v].node;
      acc[2 * node] += hm.mean[2 * v];
      acc[2 * node + 1] += hm.mean[2 * v + 1];
      cnt[node]++;
    }
    for (let i = 0; i < P; i++) {
      if (cnt[i] > 0) {
        theta[2 * i] = acc[2 * i] / cnt[i];
        theta[2 * i + 1] = acc[2 * i + 1] / cnt[i];
      }
    }
    const qEst = Math.sqrt(hm.stepMs / 2);
    notes.push(`em${em}: ll ${hm.loglik.toFixed(0)} q ${Number.isFinite(qEst) ? qEst.toFixed(2) : '-'} G ${grid.G}`);
    snapshot(`hmm${em}`);
    if (cfg.emUpdateQ && Number.isFinite(qEst)) q = clamp(qEst, 0.3 * cfg.hmmQ, 3 * cfg.hmmQ);
    if (em + 1 < cfg.emRounds || cfg.emFinalM) {
      // Passo M: reajusta roteadores e curvas com as posições alisadas (nós parados).
      cfg.freezeNodes = 1;
      for (let i = 0; i < model.size; i++) u[i] = theta[i] / scale[i];
      lbfgs(fg, u, { maxIter: cfg.mIter, deadline, memory: 10 });
      for (let i = 0; i < model.size; i++) theta[i] = u[i] * scale[i];
      cfg.freezeNodes = 0;
    }
    if (now() > deadline) break;
  }
  progress(0.7, 'trajetória');

  // --- EM com o campo residual (o que se repete no mesmo lugar) ---
  const exclude = timeNeighbours(prep, cfg.fieldExclude);
  for (let it = 0; it < cfg.fieldRounds; it++) {
    const grid = makeGrid(theta, P, Math.max(2, 2 * q), cfg.hmmMinCell, cfg.hmmMaxCells);
    const h = Math.max(cfg.fieldH * (q / cfg.hmmQ), 0.75 * grid.cell);
    const field = buildResidualField(model, cfg, theta, grid, h);
    const sigmaR = fieldSigmas(model, cfg, theta, grid, field, exclude);
    const logE = nodeEmissions(model, cfg, theta, grid, sigmaR, field, exclude);
    const hm = runHmm(prep, model, cfg, grid, logE, q);
    const acc = new Float64Array(2 * P);
    const cnt = new Float64Array(P);
    for (let v = 0; v < prep.visits.length; v++) {
      const node = prep.visits[v].node;
      acc[2 * node] += hm.mean[2 * v];
      acc[2 * node + 1] += hm.mean[2 * v + 1];
      cnt[node]++;
    }
    for (let i = 0; i < P; i++) {
      if (cnt[i] > 0) {
        theta[2 * i] = acc[2 * i] / cnt[i];
        theta[2 * i + 1] = acc[2 * i + 1] / cnt[i];
      }
    }
    const qEst = Math.sqrt(hm.stepMs / 2);
    let sg = 0;
    for (let a = 0; a < model.RA; a++) sg += sigmaR[a];
    notes.push(`f${it}: ll ${hm.loglik.toFixed(0)} q ${Number.isFinite(qEst) ? qEst.toFixed(2) : '-'} sig ${(sg / model.RA).toFixed(1)}`);
    snapshot(`fld${it}`);
    if (cfg.emUpdateQ && Number.isFinite(qEst)) q = clamp(qEst, 0.3 * cfg.hmmQ, 3 * cfg.hmmQ);
    if (cfg.fieldRefit && it + 1 < cfg.fieldRounds) {
      cfg.freezeNodes = 1;
      for (let i = 0; i < model.size; i++) u[i] = theta[i] / scale[i];
      lbfgs(fg, u, { maxIter: cfg.mIter, deadline, memory: 10 });
      for (let i = 0; i < model.size; i++) theta[i] = u[i] * scale[i];
      cfg.freezeNodes = 0;
    }
    if (now() > deadline) break;
  }
  // O alisamento encolhe um pouco o mapa: devolve o tamanho decidido na etapa geométrica.
  {
    const now_ = cloudRadius(theta, P);
    if (now_.r > 1e-6 && sizeAfterSlam > 1e-6) {
      const k = sizeAfterSlam / now_.r;
      const tmp = new Float64Array(model.size);
      applyScale(model, theta, k, tmp);
      theta.set(tmp);
    }
  }
  progress(0.9, 'campo');

  const solution = finalize(survey, prep, model, cfg, theta);
  if (options.debug) {
    const params = [];
    for (let a = 0; a < model.RA; a++) {
      const d3 = model.oA + 3 * model.radDev[a];
      params.push({
        ids: prep.radios[model.list[a]].ids, freq: prep.radios[model.list[a]].freq, count: prep.radioCount[model.list[a]],
        x: theta[d3], y: theta[d3 + 1], z: theta[d3 + 2], n: theta[model.oR + 2 * a], alpha: theta[model.oR + 2 * a + 1],
        p0: Array.from({ length: model.NF }, (_, f) => theta[model.p0Index[a * model.NF + f]]),
      });
    }
    solution.debug = { stages, cost: res.f, iter: res.iter, ms: now() - t0, params, note: notes.join(' '), study };
  }
  progress(1, 'pronto');
  return solution;
}

/** Monta a saída: centra, gira para o eixo de maior espalhamento e preenche os roteadores. */
function finalize(survey, prep, model, cfg, theta) {
  const { N, P, nodeOf, scans, radios } = prep;
  // Centro e eixo principal dos pontos (cada varredura conta uma vez).
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < N; i++) {
    cx += theta[2 * nodeOf[i]];
    cy += theta[2 * nodeOf[i] + 1];
  }
  cx /= N;
  cy /= N;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < N; i++) {
    const x = theta[2 * nodeOf[i]] - cx;
    const y = theta[2 * nodeOf[i] + 1] - cy;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const tx = (x, y) => c * (x - cx) + s * (y - cy);
  const ty = (x, y) => -s * (x - cx) + c * (y - cy);

  const points = new Array(survey.scans.length);
  for (let i = 0; i < N; i++) {
    let x = theta[2 * nodeOf[i]];
    let y = theta[2 * nodeOf[i] + 1];
    if (cfg.lagShift > 0 && scans[i].spot == null && i > 0 && i < N - 1) {
      // As leituras (quase todas em 2,4 GHz) são ouvidas no começo da varredura; a posição que
      // vale é a do meio dela: adianta o ponto ao longo do caminho.
      const dt = scans[i + 1].t - scans[i - 1].t;
      if (dt > 1 && dt < 16) {
        x += (cfg.lagShift / dt) * (theta[2 * nodeOf[i + 1]] - theta[2 * nodeOf[i - 1]]);
        y += (cfg.lagShift / dt) * (theta[2 * nodeOf[i + 1] + 1] - theta[2 * nodeOf[i - 1] + 1]);
      }
    }
    const floor = Number.isFinite(scans[i].floor) ? Math.round(scans[i].floor) : 0;
    points[i] = { x: tx(x, y), y: ty(x, y), z: floor * FLOOR_HEIGHT, conf: 0.5 };
  }

  const aps = {};
  for (let a = 0; a < model.RA; a++) {
    const r = radios[model.list[a]];
    const d3 = model.oA + 3 * model.radDev[a];
    const x = theta[d3];
    const y = theta[d3 + 1];
    const n = theta[model.oR + 2 * a];
    const p0 = theta[model.p0Index[a * model.NF + model.mainFloor[a]]];
    for (const id of r.ids) {
      aps[id] = { x: tx(x, y), y: ty(x, y), z: theta[d3 + 2], p0, n, conf: 0.5 };
    }
  }
  return { points, aps, scaleConf: 0.3 };
}
