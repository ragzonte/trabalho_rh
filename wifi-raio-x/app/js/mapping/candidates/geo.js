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
    edges.push({ a, b, dt, walking: scans[i].spot == null && scans[i - 1].spot == null });
  }

  return { scans, N, P, NF, floorList, nodeOf, scanFloor, nodeFloor, radios, devices, R, obs, radioCount, edges, radioOfId };
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
function rescaleInit(prep, X) {
  const { edges, P } = prep;
  const ratios = [];
  for (const e of edges) {
    const d = Math.hypot(X[2 * e.a] - X[2 * e.b], X[2 * e.a + 1] - X[2 * e.b + 1]);
    if (e.dt < 8 && d > 1e-9) ratios.push(d / e.dt);
  }
  let scale;
  if (ratios.length >= 8) {
    // Passo mediano de ~0,4 m/s (quem anda a 0,4-0,9 m/s faz curvas e pausas).
    scale = 0.4 / median(ratios);
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
    zFloor, radDev, p0Ref, edges, nodeFloor: prep.nodeFloor,
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
  const sigma = cfg.sigma;
  const kHuber = cfg.huber * sigma;
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
    const w = oW[m] / (sigma * sigma);
    let ge; // d custo / d e
    if (ae <= kHuber) {
      cost += 0.5 * w * e * e;
      ge = w * e;
    } else {
      cost += w * kHuber * (ae - 0.5 * kHuber);
      ge = w * kHuber * (e > 0 ? 1 : -1);
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
    const wc = cfg.censor / (sigma * sigma);
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
      let ge;
      if (e <= kHuber) {
        cost += 0.5 * wc * e * e;
        ge = wc * e;
      } else {
        cost += wc * kHuber * (e - 0.5 * kHuber);
        ge = wc * kHuber;
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
    const limit = cfg.vMax * e.dt;
    if (dist > limit) {
      const ex = dist - limit;
      cost += 0.5 * wv * ex * ex;
      if (grad) {
        const g = (wv * ex) / dist;
        grad[2 * e.a] += g * dx;
        grad[2 * e.a + 1] += g * dy;
        grad[2 * e.b] -= g * dx;
        grad[2 * e.b + 1] -= g * dy;
      }
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
// Solução
// ---------------------------------------------------------------------------

const DEFAULT_CFG = {
  minObs: 5, // leituras para um rádio entrar no ajuste
  sigma: 4, // dB: ruído + corpo + sombra que a curva não explica
  huber: 1.5,
  censor: 0.5, // peso do "não ouvi"
  censorMinObs: 8,
  vMax: V_MAX,
  speedWeight: 4, // 1/m²
  smoothWeight: 0.0,
  knownWeight: 100,
  nPrior: 2.6,
  nSigma: 0.8,
  nInit: 3,
  alphaSigma: 3,
  p0SigmaHi: 3,
  p0SigmaLo: 15,
  zSigma: 2.5,
  farSigma: 60,
  maxIter: 400,
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
  rescaleInit(prep, X0);
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
  for (let i = 0; i < model.size; i++) u[i] = theta[i] / scale[i];
  const res = lbfgs(fg, u, { maxIter: cfg.maxIter, deadline, memory: 10 });
  for (let i = 0; i < model.size; i++) theta[i] = u[i] * scale[i];
  snapshot('slam');
  progress(0.9, 'ajuste');

  const solution = finalize(survey, prep, model, cfg, theta);
  if (options.debug) solution.debug = { stages, cost: res.f, iter: res.iter, ms: now() - t0 };
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
    const x = theta[2 * nodeOf[i]];
    const y = theta[2 * nodeOf[i] + 1];
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
