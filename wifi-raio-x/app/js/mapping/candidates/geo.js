// Mapa só com Wi-Fi — candidato "geo": SLAM geométrico de distâncias + trajetória em grade.
//
// Incógnitas: a posição de cada varredura, a posição de cada aparelho (roteador) e a curva de
// propagação de cada rádio. Etapas:
//
//   1. preparo      nós (um por varredura andando, um por ponto marcado), rádios (BSSIDs do mesmo
//                   aparelho e faixa viram um só) e leituras frescas (as repetidas pelo Android saem);
//   2. partida      MDS das impressões digitais, centradas POR ANDAR (senão os andares se espalham
//                   lado a lado), e roteadores por busca em grade;
//   3. geometria    L-BFGS sobre tudo: desajuste robusto entre RSSI medido e previsto
//                   (p0 - 10·n·log10(d) - alpha·d), "não ouvi", passo esperado entre varreduras;
//   4. escala       quem anda fixa a escala pelo passo; quem só marca pontos, por três indícios
//                   (tempo andando visto no sinal conectado, física perto do roteador, espaçamento);
//   5. trajetória   EM curto: campo residual de cada rádio (o que a curva não explica e se repete
//                   no lugar) + forward-backward numa grade (integra a incerteza em vez de
//                   maximizar ponto a ponto), e reajuste dos roteadores;
//   6. saída        tamanho decidido na etapa 4, eixo x no maior espalhamento, confianças.
//
// O que NÃO se sabe e não se assume: potência, expoente, paredes, ruído. Os priores abaixo são
// largos e têm a justificativa ao lado. Único import: ../types.js. Determinístico (sem
// Math.random / Date.now; performance.now() só para respeitar o tempo).

import { FLOOR_HEIGHT } from '../types.js';

// ---------------------------------------------------------------------------
// Constantes e priores
// ---------------------------------------------------------------------------

/** Altura típica do celular na mão (m acima do piso). */
const PHONE_HEIGHT = 1.2;
/** Leitura mais velha que isto (ms) nunca é desta varredura: uma varredura completa leva < 4,5 s. */
const MAX_SWEEP_MS = 4500;
/** Nível abaixo do qual um rádio quase nunca aparece (dBm). */
const DETECT_DBM = -87;
/** Distância mínima efetiva até um roteador (m): evita o infinito do logaritmo. */
const NEAR_M = 0.4;
/** RSSI a 1 m em 2,4 GHz de um roteador doméstico típico (EIRP ~20 dBm, 40 dB de espaço livre, antena do celular). */
const P0_REF_24 = -39;
/** Intervalo de referência entre varreduras (s) para as grandezas "por passo". */
const STEP_S = 3.5;
/** Acima deste tanto de nós o levantamento é "enorme": partida por amostragem e grade mais grossa. */
const MANY_NODES = 300;

const LN10 = Math.LN10;

const CFG = {
  // --- leituras ---
  minObs: 5, // leituras para um rádio ganhar curva própria
  sigma: 6, // dB: ruído + corpo + paredes que a curva não explica
  huber: 1.5, // em desvios: além disto o erro pesa linear (leituras estranhas)
  censor: 0.5, // peso do "não ouvi" (o previsto não pode ficar bem acima do limiar)
  censorMinObs: 8,
  // --- caminhada ---
  pace: 0.65, // m/s: passo de quem anda devagar dentro de casa (0,4-0,9 m/s)
  stepHi: 0.22, // desvio relativo acima do passo esperado (corte seco: ninguém corre)
  stepLo: 0.5, // e abaixo (curvas e pausas encurtam a corda)
  stepWeight: 6,
  stepMaxDt: 8, // s: acima disto o intervalo não diz nada sobre o passo
  vTop: 1.3, // teto de velocidade = vTop·pace
  partFactor: 0.55, // par com uma ponta parada: só parte do intervalo foi andando
  dwellS: 3, // dois pontos marcados seguidos: varredura + sair + chegar
  knownWeight: 4, // 1/m²: distância medida pelo usuário (a exatidão é imposta no fim)
  // --- curva de cada rádio ---
  nPrior: 2.6, // entre o espaço livre (2) e ambiente carregado; as paredes ficam com alpha
  nSigma: 0.8,
  alphaSigma: 3, // dB/m
  p0SigmaHi: 30, // dB: p0 acima da referência (quase livre: a potência real varia muito)
  p0SigmaLo: 40, // dB: abaixo (parede externa, laje, vizinho fraco)
  zSigma: 1.0, // m em torno de "um pouco acima do celular"
  farSigma: 60, // m: só impede roteador de fugir para o infinito
  maxIter: 200,
  rounds: 3,
  // --- trajetória em grade ---
  emissionWeight: 0.5, // leituras de uma varredura não são independentes (mesmo corpo, mesmas paredes)
  sigmaMax: 9,
  hmmQ: 1.25, // m: desvio por eixo do deslocamento em 3,5 s
  hmmCut: 2.2, // truncamento do núcleo, em desvios (teto de velocidade)
  hmmMaxDt: 7,
  spotHop: 2.0, // entre pontos marcados distantes no tempo: "alguns passos", em unidades de hmmQ
  hmmMinCell: 0.45,
  hmmMaxCells: 800,
  // --- campo residual ---
  fieldRounds: 2,
  fieldH: 1.1, // m: largura do núcleo (paredes e sombra mudam em ~1-2 m)
  fieldLambda: 0.7, // encolhimento para zero onde há poucos vizinhos
  fieldClip: 15, // dB: resíduo maior que isto é leitura estranha
  fieldExclude: 1, // varreduras vizinhas no tempo que ficam de fora ao localizar um nó
  fieldSigmaMin: 2.5,
  mIter: 60, // iterações do reajuste dos roteadores entre uma rodada e outra
  // --- escala sem caminhada contínua ---
  minStepEdges: 10, // abaixo disto a caminhada não ancora a escala
  plateauSigmas: 1.85, // tolerância em torno do platô do sinal conectado, em desvios do ruído
  leaveS: 0.65, // s entre a varredura chegar e o usuário sair andando
  walkCapS: 20,
  walkSpeed: 0.6, // m/s em linha reta entre pontos (anda-se a ~0,65 m/s, com desvios)
  bodyMeanDb: 1.5, // perda média do corpo
  nearDropDb: 12, // até ~3,7 m do roteador ainda é visada direta
  nLos: 2.1, // expoente em visada direta
  hopM: 1.85, // m: distância típica entre pontos marcados seguidos
  evWalkSd: 0.4, // incerteza (log) de cada indício
  evPhysicsSd: 0.36,
  evHopSd: 0.5,
  sizeWeight: 400,
  spreadShrink: 1.5, // quanto a incerteza das posições encolhe o mapa final (0 = nada)
  shrinkFloor: 0,
  // --- tortuosidade ---
  turnKappa: 0.5,
  turnTop: 1.5,
};

// ---------------------------------------------------------------------------
// Utilidades numéricas
// ---------------------------------------------------------------------------

function median(values) {
  if (!values.length) return NaN;
  const v = Array.from(values).sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : 0);
const floorOf = (scan) => (scan && Number.isFinite(scan.floor) ? Math.round(scan.floor) : 0);

/**
 * L-BFGS com busca linear por recuo (Armijo). `fg(x, grad)` devolve o custo e preenche o gradiente.
 * As variáveis já devem chegar em escala parecida.
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
      step = Math.min(1, 0.5 / Math.sqrt(gn));
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
    if (decrease < 1e-7 * (1 + Math.abs(f))) break;
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
// Preparo: nós (lugares), rádios e observações
// ---------------------------------------------------------------------------

function bandOf(freq) {
  if (!(freq > 0) || freq < 3000) return 0;
  return freq < 5925 ? 1 : 2;
}

/**
 * Converte o levantamento em:
 *  - nós: um por varredura andando, um por ponto marcado (`spot`);
 *  - rádios: BSSIDs do mesmo aparelho e da mesma faixa viram um só (mesmo sinal médio);
 *  - observações (nó, rádio, andar) = média das leituras FRESCAS;
 *  - arestas de caminhada, visitas (passos da cadeia de trajetória) e distâncias conhecidas.
 */
function prepare(survey) {
  const scans = survey.scans.map((s) => (s && typeof s === 'object' ? s : {}));
  const N = scans.length;
  const meta = survey.aps && typeof survey.aps === 'object' ? survey.aps : {};
  const time = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = Number.isFinite(scans[i].t) ? scans[i].t : i > 0 ? time[i - 1] + STEP_S : 0;
    time[i] = i > 0 ? Math.max(t, time[i - 1]) : t; // a ordem é a do vetor; o relógio não volta
  }

  // --- andares ---
  const floorList = [];
  const floorIndex = new Map();
  const scanFloor = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const f = floorOf(scans[i]);
    if (!floorIndex.has(f)) {
      if (floorList.length >= 8) {
        scanFloor[i] = 0; // mais de 8 andares: fora do escopo, cai no primeiro
        continue;
      }
      floorIndex.set(f, floorList.length);
      floorList.push(f);
    }
    scanFloor[i] = floorIndex.get(f);
  }
  const NF = Math.max(1, floorList.length);

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
  const nodeFloor = new Int32Array(P).fill(-1);
  for (let i = 0; i < N; i++) if (nodeFloor[nodeOf[i]] < 0) nodeFloor[nodeOf[i]] = scanFloor[i];

  // --- rádios e aparelhos ---
  const radioIndex = new Map();
  const radios = []; // {device, band, freq, ids}
  const deviceIndex = new Map();
  let deviceCount = 0;
  const radioOfId = new Map();
  const registerId = (id, freqHint) => {
    if (radioOfId.has(id)) return radioOfId.get(id);
    const info = meta[id] && typeof meta[id] === 'object' ? meta[id] : {};
    const freq = info.freq > 0 ? info.freq : freqHint > 0 ? freqHint : 2437;
    const devKey = info.device != null ? `d:${info.device}` : `b:${id}`;
    const key = `${devKey}|${bandOf(freq)}`;
    let r = radioIndex.get(key);
    if (r === undefined) {
      if (!deviceIndex.has(devKey)) deviceIndex.set(devKey, deviceCount++);
      r = radios.length;
      radioIndex.set(key, r);
      radios.push({ device: deviceIndex.get(devKey), band: bandOf(freq), freq, ids: [] });
    }
    radios[r].ids.push(id);
    radioOfId.set(id, r);
    return r;
  };

  // --- leituras frescas agregadas por (nó, rádio, andar) ---
  const cell = new Map();
  for (let i = 0; i < N; i++) {
    const gapMs = i > 0 ? (time[i] - time[i - 1]) * 1000 : Infinity;
    // Fresca = ouvida depois da varredura anterior (o Android repete leituras antigas).
    const freshMs = Math.min(MAX_SWEEP_MS, gapMs > 200 ? gapMs - 1 : MAX_SWEEP_MS);
    const readings = Array.isArray(scans[i].readings) ? scans[i].readings : [];
    const perRadio = new Map();
    for (const r of readings) {
      if (!r || typeof r.id !== 'string' || !Number.isFinite(r.rssi)) continue;
      const radio = registerId(r.id, r.freq);
      if ((Number.isFinite(r.ageMs) ? r.ageMs : 0) > freshMs) continue;
      let acc = perRadio.get(radio);
      if (!acc) perRadio.set(radio, (acc = { sum: 0, count: 0 }));
      acc.sum += r.rssi;
      acc.count++;
    }
    for (const [radio, acc] of perRadio) {
      const key = `${nodeOf[i]}|${radio}|${scanFloor[i]}`;
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

  // --- arestas de caminhada e visitas ---
  // Tipo do par de varreduras consecutivas: 0 = andando nas duas pontas, 1 = uma ponta parada,
  // 2 = dois pontos marcados. Visita = varreduras seguidas no mesmo nó (um passo da cadeia).
  const edges = [];
  const visits = []; // {node}
  const links = []; // entre a visita v e a v+1: {dt, kind}
  for (let i = 0; i < N; i++) {
    if (i > 0 && nodeOf[i] === nodeOf[i - 1]) continue;
    if (i > 0) {
      const dt = Math.max(0.5, time[i] - time[i - 1]);
      const kind = (scans[i].spot != null ? 1 : 0) + (scans[i - 1].spot != null ? 1 : 0);
      edges.push({ a: nodeOf[i - 1], b: nodeOf[i], dt, kind });
      links.push({ dt, kind });
    }
    visits.push({ node: nodeOf[i] });
  }

  // --- distâncias medidas pelo usuário ---
  const known = [];
  if (Array.isArray(survey.knownDistances)) {
    for (const kd of survey.knownDistances) {
      if (!kd || !Number.isInteger(kd.a) || !Number.isInteger(kd.b) || !(kd.meters > 0) || !Number.isFinite(kd.meters)) continue;
      if (kd.a < 0 || kd.b < 0 || kd.a >= N || kd.b >= N || nodeOf[kd.a] === nodeOf[kd.b]) continue;
      known.push({ a: nodeOf[kd.a], b: nodeOf[kd.b], meters: kd.meters });
    }
  }

  return { scans, time, N, P, NF, floorList, nodeOf, scanFloor, nodeFloor, radios, deviceCount, R, obs, radioCount, edges, visits, links, known };
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
  for (let r = 0; r < R; r++) if (radioCount[r] >= Math.min(P, Math.max(3, 0.1 * P))) used.push(r);
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
  for (let k = 0; k < K; k++) {
    const sum = new Float64Array(NF);
    const cnt = new Float64Array(NF);
    for (let i = 0; i < P; i++) {
      sum[nodeFloor[i]] += Z[i * K + k];
      cnt[nodeFloor[i]]++;
    }
    for (let i = 0; i < P; i++) Z[i * K + k] -= sum[nodeFloor[i]] / Math.max(1, cnt[nodeFloor[i]]);
  }
  // Levantamento enorme: o MDS (quadrático) roda só numa amostra dos nós, na ordem do tempo, e
  // os demais entram por interpolação entre as amostras vizinhas (é só a partida).
  const order = [];
  const placed = new Uint8Array(P);
  for (const v of prep.visits) {
    if (!placed[v.node]) {
      placed[v.node] = 1;
      order.push(v.node);
    }
  }
  const stride = Math.max(1, Math.ceil(P / MANY_NODES));
  const picks = [];
  for (let k = 0; k < order.length; k += stride) picks.push(order[k]);
  const Q = picks.length;
  const D2 = new Float64Array(Q * Q);
  for (let p = 0; p < Q; p++) {
    const i = picks[p];
    for (let q = p + 1; q < Q; q++) {
      const j = picks[q];
      let s = 0;
      let c = 0;
      for (let k = 0; k < K; k++) {
        if (!seen[i * K + k] && !seen[j * K + k]) continue;
        const d = Z[i * K + k] - Z[j * K + k];
        s += d * d;
        c++;
      }
      D2[p * Q + q] = D2[q * Q + p] = c ? s / c : 0;
    }
  }
  const Y = classicalMds(D2, Q);
  const X = new Float64Array(2 * P);
  for (let k = 0; k < order.length; k++) {
    const lo = Math.min(Q - 1, Math.floor(k / stride));
    const hi = Math.min(Q - 1, lo + 1);
    const w = hi > lo ? (k - lo * stride) / stride : 0;
    X[2 * order[k]] = (1 - w) * Y[2 * lo] + w * Y[2 * hi];
    X[2 * order[k] + 1] = (1 - w) * Y[2 * lo + 1] + w * Y[2 * hi + 1];
  }
  return X;
}

/** Escala o embutimento para metros usando o passo típico entre varreduras consecutivas. */
function rescaleInit(prep, X, cfg) {
  const { edges, P } = prep;
  const ratios = [];
  for (const e of edges) {
    const d = Math.hypot(X[2 * e.a] - X[2 * e.b], X[2 * e.a + 1] - X[2 * e.b + 1]);
    if (e.kind === 0 && e.dt < cfg.stepMaxDt && d > 1e-9) ratios.push(d / e.dt);
  }
  let scale;
  if (ratios.length >= 8) scale = cfg.pace / median(ratios);
  else {
    // Sem caminhada contínua: assume uma casa de raio ~3 m (a escala é decidida depois).
    let r2 = 0;
    for (let i = 0; i < 2 * P; i++) r2 += X[i] * X[i];
    scale = 3 / Math.sqrt(r2 / Math.max(1, P) + 1e-12);
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;
  for (let i = 0; i < 2 * P; i++) X[i] *= scale;
}

// ---------------------------------------------------------------------------
// Modelo geométrico: custo e gradiente
// ---------------------------------------------------------------------------

// Curva de um rádio:  rssi = p0 - 10·n·log10(d) - alpha·d   (d em metros, com um mínimo suave).
// `alpha` (dB/m) faz o papel médio das paredes; cada (rádio, andar) tem o seu p0 (a laje entra aí).

function buildModel(prep, cfg) {
  const { P, R, NF, obs, radioCount, radios, edges } = prep;
  // Rádios com leituras suficientes para ajustar uma curva, e os aparelhos deles.
  const active = new Int32Array(R).fill(-1);
  const list = [];
  for (let r = 0; r < R; r++) {
    if (radioCount[r] >= cfg.minObs) {
      active[r] = list.length;
      list.push(r);
    }
  }
  const RA = list.length;
  const devActive = new Int32Array(prep.deviceCount).fill(-1);
  let DA = 0;
  for (const r of list) if (devActive[radios[r].device] < 0) devActive[radios[r].device] = DA++;

  // Andar principal de cada rádio: onde ele chega mais forte.
  const cnt = new Int32Array(RA * NF);
  const sum = new Float64Array(RA * NF);
  const top = new Float64Array(RA).fill(-Infinity);
  for (const o of obs) {
    const a = active[o.radio];
    if (a < 0) continue;
    cnt[a * NF + o.floor]++;
    sum[a * NF + o.floor] += o.sum / o.count;
    if (o.sum / o.count > top[a]) top[a] = o.sum / o.count;
  }
  const mainFloor = new Int32Array(RA);
  for (let a = 0; a < RA; a++) {
    let best = -1;
    let bestLevel = -Infinity;
    for (let f = 0; f < NF; f++) {
      if (cnt[a * NF + f] < 3) continue;
      const level = sum[a * NF + f] / cnt[a * NF + f];
      if (level > bestLevel) {
        bestLevel = level;
        best = f;
      }
    }
    if (best < 0) for (let f = 0; f < NF; f++) if (best < 0 || cnt[a * NF + f] > cnt[a * NF + best]) best = f;
    mainFloor[a] = best;
  }

  // Vetor de parâmetros: [nós xy | aparelhos xyz | rádios (n, alpha) | p0 por (rádio, andar)].
  const oA = 2 * P;
  const oR = oA + 3 * DA;
  let size = oR + 2 * RA;
  const p0Index = new Int32Array(RA * NF).fill(-1);
  for (let a = 0; a < RA; a++) {
    p0Index[a * NF + mainFloor[a]] = size++;
    for (let f = 0; f < NF; f++) if (f !== mainFloor[a] && cnt[a * NF + f] >= 3) p0Index[a * NF + f] = size++;
    // Andar com poucas leituras: usa o p0 do andar principal.
    for (let f = 0; f < NF; f++) if (p0Index[a * NF + f] < 0) p0Index[a * NF + f] = p0Index[a * NF + mainFloor[a]];
  }

  // Observações em vetores.
  let M = 0;
  for (const o of obs) if (active[o.radio] >= 0) M++;
  const oNode = new Int32Array(M);
  const oRad = new Int32Array(M);
  const oFloor = new Int32Array(M);
  const oY = new Float64Array(M);
  const oW = new Float64Array(M);
  const heard = new Uint8Array(P * RA);
  let m = 0;
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
  for (let a = 0; a < RA; a++) {
    if (radioCount[list[a]] < cfg.censorMinObs) continue;
    for (let i = 0; i < P; i++) {
      if (!heard[i * RA + a]) {
        cNode.push(i);
        cRad.push(a);
      }
    }
  }

  const zFloor = new Float64Array(NF);
  for (let f = 0; f < NF; f++) zFloor[f] = prep.floorList[f] * FLOOR_HEIGHT + PHONE_HEIGHT;
  const radDev = new Int32Array(RA);
  const p0Ref = new Float64Array(RA);
  // Altura inicial de cada aparelho: um pouco acima do celular, no andar onde chega mais forte.
  const devZ0 = new Float64Array(DA);
  const devTop = new Float64Array(DA).fill(-Infinity);
  for (let a = 0; a < RA; a++) {
    const r = radios[list[a]];
    const d = devActive[r.device];
    radDev[a] = d;
    // A perda no espaço livre a 1 m cresce com 20·log10(f): física, não ajuste.
    p0Ref[a] = P0_REF_24 - 20 * Math.log10(Math.max(2000, r.freq) / 2437);
    const level = cnt[a * NF + mainFloor[a]] ? sum[a * NF + mainFloor[a]] / cnt[a * NF + mainFloor[a]] : -Infinity;
    if (level > devTop[d] || devTop[d] === -Infinity) {
      devTop[d] = level;
      devZ0[d] = zFloor[mainFloor[a]] + 0.6;
    }
  }

  return {
    P, RA, DA, NF, size, oA, oR, p0Index, mainFloor, list, top,
    M, oNode, oRad, oFloor, oY, oW,
    C: cNode.length, cNode: Int32Array.from(cNode), cRad: Int32Array.from(cRad),
    zFloor, radDev, p0Ref, devZ0, edges, nodeFloor: prep.nodeFloor, known: prep.known,
    sizeTarget: 0,
  };
}

/** Custo total e gradiente (grad pode ser null). */
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

  // --- caminhada ---
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k];
    const dx = theta[2 * e.a] - theta[2 * e.b];
    const dy = theta[2 * e.a + 1] - theta[2 * e.b + 1];
    const dist = Math.sqrt(dx * dx + dy * dy + 1e-9);
    let gd = 0; // d custo / d dist
    if (e.kind === 0 && e.dt < cfg.stepMaxDt) {
      // Andando sem parar: a corda entre duas varreduras fica perto de pace·dt (corte seco
      // para cima, cauda longa para baixo: curvas e pausas encurtam, nada alonga).
      const mode = cfg.pace * e.dt;
      const ex = dist - mode;
      const sd = (ex > 0 ? cfg.stepHi : cfg.stepLo) * mode;
      cost += (0.5 * cfg.stepWeight * ex * ex) / (sd * sd);
      gd = (cfg.stepWeight * ex) / (sd * sd);
    } else {
      // Parado numa das pontas (ou nas duas): só há teto, e mais baixo.
      const still = e.kind === 2 ? cfg.dwellS : 0;
      const limit = (e.kind === 1 ? cfg.partFactor : 1) * cfg.pace * cfg.vTop * Math.max(1, e.dt - still);
      if (dist > limit) {
        const ex = dist - limit;
        const sd = cfg.stepHi * cfg.pace * Math.min(e.dt, 4);
        cost += (0.5 * ex * ex) / (sd * sd);
        gd = ex / (sd * sd);
      }
    }
    if (gd !== 0 && grad) {
      const g = gd / dist;
      grad[2 * e.a] += g * dx;
      grad[2 * e.a + 1] += g * dy;
      grad[2 * e.b] -= g * dx;
      grad[2 * e.b + 1] -= g * dy;
    }
  }

  // --- distâncias medidas pelo usuário ---
  for (const kd of model.known) {
    const dx = theta[2 * kd.a] - theta[2 * kd.b];
    const dy = theta[2 * kd.a + 1] - theta[2 * kd.b + 1];
    const dist = Math.sqrt(dx * dx + dy * dy + 1e-9);
    const ex = dist - kd.meters;
    cost += 0.5 * cfg.knownWeight * ex * ex;
    if (grad) {
      const g = (cfg.knownWeight * ex) / dist;
      grad[2 * kd.a] += g * dx;
      grad[2 * kd.a + 1] += g * dy;
      grad[2 * kd.b] -= g * dx;
      grad[2 * kd.b + 1] -= g * dy;
    }
  }

  // --- âncora de tamanho (levantamentos sem caminhada contínua): segura a escala já decidida ---
  if (model.sizeTarget > 0) {
    const c = cloudRadius(theta, P);
    const r2 = c.r * c.r + 1e-9;
    const el = 0.5 * Math.log(r2 / (model.sizeTarget * model.sizeTarget));
    cost += 0.5 * cfg.sizeWeight * el * el;
    if (grad) {
      const g = (cfg.sizeWeight * el) / (P * r2);
      for (let i = 0; i < P; i++) {
        grad[2 * i] += g * (theta[2 * i] - c.mx);
        grad[2 * i + 1] += g * (theta[2 * i + 1] - c.my);
      }
    }
  }

  // --- priores dos rádios ---
  for (let a = 0; a < RA; a++) {
    const n = theta[oR + 2 * a];
    const al = theta[oR + 2 * a + 1];
    const en = (n - cfg.nPrior) / cfg.nSigma;
    cost += 0.5 * en * en;
    if (grad) grad[oR + 2 * a] += en / cfg.nSigma;
    // alpha não pode ser negativo (parede não aumenta o sinal).
    if (al < 0) {
      cost += 0.5 * 400 * al * al;
      if (grad) grad[oR + 2 * a + 1] += 400 * al;
    } else {
      const ea = al / cfg.alphaSigma;
      cost += 0.5 * ea * ea;
      if (grad) grad[oR + 2 * a + 1] += ea / cfg.alphaSigma;
    }
    // p0: prior quase plano (só regulariza). A potência real varia demais para ancorar a escala aqui.
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
function applyScale(model, theta, s) {
  const { P, RA, DA, NF, oA, oR, p0Index } = model;
  if (!(s > 0) || !Number.isFinite(s)) return;
  for (let i = 0; i < 2 * P; i++) theta[i] *= s;
  for (let d = 0; d < DA; d++) {
    theta[oA + 3 * d] *= s;
    theta[oA + 3 * d + 1] *= s;
  }
  const done = new Uint8Array(model.size);
  for (let a = 0; a < RA; a++) {
    theta[oR + 2 * a + 1] /= s;
    for (let f = 0; f < NF; f++) {
      const ip = p0Index[a * NF + f];
      if (done[ip]) continue;
      done[ip] = 1;
      theta[ip] += 10 * theta[oR + 2 * a] * Math.log10(s);
    }
  }
}

/** Raio quadrático médio dos nós em torno do centro. */
function cloudRadius(theta, P) {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < P; i++) {
    mx += theta[2 * i];
    my += theta[2 * i + 1];
  }
  mx /= Math.max(1, P);
  my /= Math.max(1, P);
  let r2 = 0;
  for (let i = 0; i < P; i++) r2 += (theta[2 * i] - mx) * (theta[2 * i] - mx) + (theta[2 * i + 1] - my) * (theta[2 * i + 1] - my);
  return { r: Math.sqrt(r2 / Math.max(1, P)), mx, my };
}

/**
 * Partida dos roteadores: para cada aparelho, com os nós onde estão, procura numa grade a
 * posição que melhor explica as leituras de todos os seus rádios (inclinação comum e um
 * intercepto por andar, por mínimos quadrados em cada candidato).
 */
function initDevices(model, cfg, theta) {
  const { P, RA, DA, NF, oA, oR, p0Index, M, oNode, oRad, oFloor, oY, zFloor, radDev, p0Ref } = model;
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
  const pad = Math.max(8, 1.2 * span); // vizinhos ficam fora da casa
  const G = 21;
  const obsByRadio = Array.from({ length: RA }, () => []);
  for (let m = 0; m < M; m++) obsByRadio[oRad[m]].push(m);
  const radiosOfDev = Array.from({ length: DA }, () => []);
  for (let a = 0; a < RA; a++) radiosOfDev[radDev[a]].push(a);
  const eps2 = NEAR_M * NEAR_M;
  const sL = new Float64Array(NF);
  const sY = new Float64Array(NF);
  const cF = new Float64Array(NF);
  const p0 = new Float64Array(NF);
  const Ls = new Float64Array(M);
  // Ajusta a curva do rádio `a` com o aparelho em (ax, ay, z0); devolve o erro e deixa em
  // `p0` (por andar) e no retorno a inclinação.
  let slope = 3;
  const fitRadio = (a, ax, ay, z0) => {
    const list = obsByRadio[a];
    sL.fill(0);
    sY.fill(0);
    cF.fill(0);
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
    slope = clamp(sxx > 1e-9 ? -sxy / sxx / 10 : 3, 1.6, 5);
    for (let f = 0; f < NF; f++) p0[f] = cF[f] ? sY[f] / cF[f] + (10 * slope * sL[f]) / cF[f] : NaN;
    let sse = 0;
    for (let k = 0; k < list.length; k++) {
      const m = list[k];
      const e = oY[m] - (p0[oFloor[m]] - 10 * slope * Ls[k]);
      const ae = Math.abs(e);
      sse += ae < 8 ? e * e : 8 * (2 * ae - 8);
    }
    // p0 muito acima da referência não existe: descarta candidatos "longe demais".
    const hi = p0[model.mainFloor[a]] - p0Ref[a] - 3;
    if (hi > 0) sse += list.length * 0.125 * hi * hi;
    return sse;
  };

  for (let d = 0; d < DA; d++) {
    const d3 = oA + 3 * d;
    const z0 = model.devZ0[d];
    let bestSse = Infinity;
    let bestX = 0;
    let bestY = 0;
    for (let gx = 0; gx < G; gx++) {
      for (let gy = 0; gy < G; gy++) {
        const ax = minX - pad + ((maxX - minX + 2 * pad) * gx) / (G - 1);
        const ay = minY - pad + ((maxY - minY + 2 * pad) * gy) / (G - 1);
        let sse = 0;
        for (const a of radiosOfDev[d]) sse += fitRadio(a, ax, ay, z0);
        if (sse < bestSse) {
          bestSse = sse;
          bestX = ax;
          bestY = ay;
        }
      }
    }
    theta[d3] = bestX;
    theta[d3 + 1] = bestY;
    theta[d3 + 2] = z0;
    for (const a of radiosOfDev[d]) {
      fitRadio(a, bestX, bestY, z0);
      theta[oR + 2 * a] = slope;
      theta[oR + 2 * a + 1] = 0;
      const main = p0Index[a * NF + model.mainFloor[a]];
      for (let f = 0; f < NF; f++) {
        const ip = p0Index[a * NF + f];
        if (Number.isFinite(p0[f]) && (f === model.mainFloor[a] || ip !== main)) theta[ip] = p0[f];
      }
      if (!Number.isFinite(theta[main])) theta[main] = p0Ref[a] - 20;
    }
  }
}

// ---------------------------------------------------------------------------
// Trajetória em grade (HMM) e campo residual
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
  const cell = Math.max(minCell, Math.sqrt(((maxX - minX) * (maxY - minY)) / maxCells));
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

/** Sinal previsto pela curva de um rádio num ponto (x, y) de um andar. */
function predictAt(model, theta, a, f, x, y) {
  const d3 = model.oA + 3 * model.radDev[a];
  const dx = x - theta[d3];
  const dy = y - theta[d3 + 1];
  const dz = model.zFloor[f] - theta[d3 + 2];
  const q = dx * dx + dy * dy + dz * dz + NEAR_M * NEAR_M;
  return theta[model.p0Index[a * model.NF + f]] - (5 * theta[model.oR + 2 * a] * Math.log(q)) / LN10 - theta[model.oR + 2 * a + 1] * Math.sqrt(q);
}

/** Sinal previsto pela curva de cada rádio em cada célula: pred[(rádio·NF + andar)·G + célula]. */
function predictGrid(model, theta, grid) {
  const { RA, NF } = model;
  const { G, cx, cy } = grid;
  const pred = new Float32Array(RA * NF * G);
  for (let a = 0; a < RA; a++) {
    for (let f = 0; f < NF; f++) {
      const base = (a * NF + f) * G;
      for (let c = 0; c < G; c++) pred[base + c] = predictAt(model, theta, a, f, cx[c], cy[c]);
    }
  }
  return pred;
}

/**
 * Campo residual de cada rádio: o que a curva "sinal x distância" não explica (paredes, sombra)
 * e que se REPETE no mesmo lugar. Regressão por núcleo dos resíduos sobre as posições atuais.
 * Guarda somas e pesos por célula, mais a "pegada" de cada nó, para poder tirar a contribuição
 * do próprio nó (e dos vizinhos no tempo) na hora de avaliar onde ele está.
 */
function buildResidualField(model, cfg, theta, grid) {
  const { P, RA, NF, M, oNode, oRad, oFloor, oY, oW, C, cNode, cRad, nodeFloor } = model;
  const { G, nx, ny, minX, minY, cell } = grid;
  const h = Math.max(cfg.fieldH, 0.75 * cell);
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
  // Contribuição de cada (nó, rádio, andar): peso e resíduo.
  const contrib = new Map();
  const key = (i, a, f) => (i * RA + a) * NF + f;
  const add = (i, a, f, weight, res) => {
    contrib.set(key(i, a, f), { w: weight, res });
    const base = (a * NF + f) * G;
    for (let k = footStart[i]; k < footStart[i + 1]; k++) {
      S[base + fc[k]] += weight * fw[k] * res;
      W[base + fc[k]] += weight * fw[k];
    }
  };
  const resObs = new Float64Array(M);
  for (let m = 0; m < M; m++) {
    const i = oNode[m];
    resObs[m] = clamp(oY[m] - predictAt(model, theta, oRad[m], oFloor[m], theta[2 * i], theta[2 * i + 1]), -cfg.fieldClip, cfg.fieldClip);
    add(i, oRad[m], oFloor[m], oW[m], resObs[m]);
  }
  // "Não ouvi": puxa o campo para baixo onde a curva prevê sinal audível.
  for (let j = 0; j < C; j++) {
    const i = cNode[j];
    const pred = predictAt(model, theta, cRad[j], nodeFloor[i], theta[2 * i], theta[2 * i + 1]);
    add(i, cRad[j], nodeFloor[i], cfg.censor, clamp(Math.min(0, DETECT_DBM - 4 - pred), -cfg.fieldClip, 0));
  }
  return { S, W, footStart, fc, fw, resObs, contribOf: (i, a, f) => contrib.get(key(i, a, f)) };
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

/** Resíduo típico de cada rádio (dB) com o campo residual, deixando o próprio nó de fora. */
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
 * Log-verossimilhança de cada nó em cada célula: curva de cada rádio + campo residual
 * (sem a contribuição dos nós em `exclude[nó]`, para um nó não se localizar por ele mesmo).
 */
function nodeEmissions(model, cfg, theta, grid, sigmaR, field, exclude) {
  const { P, RA, NF, M, oNode, oRad, oFloor, oY, oW, C, cNode, cRad, nodeFloor } = model;
  const { G } = grid;
  const pred = predictGrid(model, theta, grid);
  const logE = new Float32Array(P * G);
  const k = cfg.huber;
  const lambda = cfg.fieldLambda;
  const dS = new Float32Array(G);
  const dW = new Float32Array(G);
  const { S, W, footStart, fc, fw } = field;
  // Preenche dS/dW com o que sai do campo de (rádio, andar) para o nó i; `clear` desfaz.
  const remove = (i, a, f) => {
    for (const j of exclude[i]) {
      const contrib = field.contribOf(j, a, f);
      if (!contrib) continue;
      for (let q = footStart[j]; q < footStart[j + 1]; q++) {
        dS[fc[q]] += contrib.w * fw[q] * contrib.res;
        dW[fc[q]] += contrib.w * fw[q];
      }
    }
  };
  const clear = (i) => {
    for (const j of exclude[i]) {
      for (let q = footStart[j]; q < footStart[j + 1]; q++) {
        dS[fc[q]] = 0;
        dW[fc[q]] = 0;
      }
    }
  };
  for (let m = 0; m < M; m++) {
    const a = oRad[m];
    const i = oNode[m];
    const base = (a * NF + oFloor[m]) * G;
    const out = i * G;
    const inv = 1 / sigmaR[a];
    const w = oW[m] * cfg.emissionWeight;
    const y = oY[m];
    remove(i, a, oFloor[m]);
    for (let c = 0; c < G; c++) {
      const res = (S[base + c] - dS[c]) / (W[base + c] - dW[c] + lambda);
      const e = Math.abs(y - pred[base + c] - res) * inv;
      logE[out + c] -= w * (e <= k ? 0.5 * e * e : k * (e - 0.5 * k));
    }
    clear(i);
  }
  const wc = cfg.censor * cfg.emissionWeight;
  for (let j = 0; j < C; j++) {
    const a = cRad[j];
    const i = cNode[j];
    const base = (a * NF + nodeFloor[i]) * G;
    const out = i * G;
    const inv = 1 / sigmaR[a];
    remove(i, a, nodeFloor[i]);
    for (let c = 0; c < G; c++) {
      const res = (S[base + c] - dS[c]) / (W[base + c] - dW[c] + lambda);
      const e = (pred[base + c] + res - DETECT_DBM) * inv;
      if (e > 0) logE[out + c] -= wc * (e <= k ? 0.5 * e * e : k * (e - 0.5 * k));
    }
    clear(i);
  }
  return logE;
}

/**
 * Núcleo de transição: gaussiana truncada (passeio aleatório com teto de velocidade).
 * Núcleo pequeno = lista de deslocamentos dentro de um disco (aplicada só às células com massa);
 * núcleo grande = duas passadas 1-D (a gaussiana é separável), muito mais barato.
 */
function makeKernel(cell, sd, rMax) {
  const r = Math.max(1, Math.ceil(rMax / cell));
  if ((2 * r + 1) * (2 * r + 1) > 200) {
    const line = new Float64Array(2 * r + 1);
    let total = 0;
    for (let i = -r; i <= r; i++) total += line[i + r] = Math.exp((-0.5 * i * i * cell * cell) / (sd * sd));
    for (let i = 0; i < line.length; i++) line[i] /= total;
    return { separable: true, r, line };
  }
  const dx = [];
  const dy = [];
  const w = [];
  let total = 0;
  const lim2 = (rMax + 0.5 * cell) * (rMax + 0.5 * cell);
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const dist2 = (i * i + j * j) * cell * cell;
      if (dist2 > lim2) continue;
      const v = Math.exp((-0.5 * dist2) / (sd * sd));
      dx.push(i);
      dy.push(j);
      w.push(v);
      total += v;
    }
  }
  return { separable: false, n: w.length, dx: Int32Array.from(dx), dy: Int32Array.from(dy), w: Float64Array.from(w, (v) => v / total) };
}

/**
 * Forward-backward sobre as visitas. Devolve, por visita, a média a posteriori e o espalhamento
 * (desvio em metros) — a posição estimada e o quanto se pode confiar nela.
 */
function runHmm(prep, cfg, grid, logE) {
  const { visits, links } = prep;
  const { G, nx, ny, cx, cy, cell } = grid;
  const V = visits.length;
  const q = cfg.hmmQ;
  const kernels = new Map();
  const kernelFor = (link) => {
    // Desvio por eixo do deslocamento: q em 3,5 s, crescendo com o intervalo; com uma ponta
    // parada o passo é menor; entre dois pontos marcados distantes no tempo vale só "alguns passos".
    let sd = q * (Math.min(link.dt, cfg.hmmMaxDt) / STEP_S);
    if (link.kind === 1) sd *= cfg.partFactor;
    let rMax = cfg.hmmCut * sd;
    if (link.kind === 2 && link.dt > cfg.stepMaxDt) {
      sd = q * cfg.spotHop;
      rMax = 3 * sd;
    }
    sd = Math.max(sd, 0.6 * cell);
    rMax = Math.max(rMax, 1.01 * cell);
    const key = `${Math.round((sd / cell) * 8)}|${Math.round((rMax / cell) * 4)}`;
    let kr = kernels.get(key);
    if (!kr) kernels.set(key, (kr = makeKernel(cell, sd, rMax)));
    return kr;
  };
  const pass = new Float64Array(G);
  const spread = (src, kr, out) => {
    out.fill(0);
    if (kr.separable) {
      const { r, line } = kr;
      pass.fill(0);
      for (let j = 0; j < ny; j++) {
        const row = j * nx;
        for (let i = 0; i < nx; i++) {
          const v = src[row + i];
          if (v === 0) continue;
          const lo = Math.max(0, i - r);
          const hi = Math.min(nx - 1, i + r);
          for (let k = lo; k <= hi; k++) pass[row + k] += v * line[k - i + r];
        }
      }
      for (let j = 0; j < ny; j++) {
        const lo = Math.max(0, j - r);
        const hi = Math.min(ny - 1, j + r);
        for (let i = 0; i < nx; i++) {
          const v = pass[j * nx + i];
          if (v === 0) continue;
          for (let k = lo; k <= hi; k++) out[k * nx + i] += v * line[k - j + r];
        }
      }
      return;
    }
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
  const tmp = new Float64Array(G);
  for (let v = 0; v < V; v++) {
    const base = visits[v].node * G;
    const e = new Float64Array(G);
    let top = -Infinity;
    for (let c = 0; c < G; c++) if (logE[base + c] > top) top = logE[base + c];
    for (let c = 0; c < G; c++) e[c] = Math.exp(logE[base + c] - top);
    E[v] = e;
    const a = new Float64Array(G);
    if (v === 0) a.set(e);
    else {
      spread(alpha[v - 1], kernelFor(links[v - 1]), tmp);
      for (let c = 0; c < G; c++) a[c] = tmp[c] * e[c];
    }
    let sum = 0;
    for (let c = 0; c < G; c++) sum += a[c];
    if (!(sum > 0)) {
      // Beco sem saída numérico: recomeça desta visita.
      a.set(e);
      sum = 0;
      for (let c = 0; c < G; c++) sum += a[c];
    }
    for (let c = 0; c < G; c++) a[c] /= sum;
    alpha[v] = a;
  }
  const mean = new Float64Array(2 * V);
  const spreadM = new Float64Array(V);
  let beta = new Float64Array(G).fill(1);
  const B = new Float64Array(G);
  for (let v = V - 1; v >= 0; v--) {
    if (v < V - 1) {
      for (let c = 0; c < G; c++) B[c] = E[v + 1][c] * beta[c];
      const nb = new Float64Array(G);
      spread(B, kernelFor(links[v]), nb);
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
  return { mean, spread: spreadM };
}

// ---------------------------------------------------------------------------
// Escala absoluta
// ---------------------------------------------------------------------------

/**
 * Tempo andando entre duas varreduras consecutivas, pelo sinal da rede conectada: parado, o
 * nível fica num platô (só ruído); andando, ele muda. A chegada é o começo do platô final.
 * Devolve segundos por varredura (tempo andando desde a anterior), ou NaN quando não dá para dizer.
 */
function walkTimes(survey, prep, cfg) {
  const { scans, time, N } = prep;
  const out = new Float64Array(N).fill(NaN);
  const track = [];
  if (Array.isArray(survey.track)) {
    for (const q of survey.track) if (q && Number.isFinite(q.t) && Number.isFinite(q.rssi)) track.push(q);
    track.sort((p, q) => p.t - q.t);
  }
  if (track.length < 8) return out;
  // Trechos de amostras entre uma varredura e a seguinte (mesma rede do começo ao fim).
  const segs = new Array(N).fill(null);
  let k = 0;
  for (let i = 1; i < N; i++) {
    while (k < track.length && track[k].t <= time[i - 1]) k++;
    const seg = [];
    for (let j = k; j < track.length && track[j].t <= time[i] + 0.2; j++) seg.push(track[j]);
    if (seg.length >= 5 && seg.every((q) => q.id === seg[0].id)) segs[i] = seg;
  }
  // Ruído do platô, medido nas últimas amostras antes de cada varredura parada (aí o usuário
  // com certeza está esperando): a tolerância acompanha o ruído real do aparelho.
  const dev = [];
  for (let i = 1; i < N; i++) {
    if (!segs[i] || scans[i].spot == null) continue;
    const tail = segs[i].slice(-4).map((q) => q.rssi);
    const mid = median(tail);
    for (const v of tail) dev.push(Math.abs(v - mid));
  }
  const noise = dev.length >= 12 ? clamp(1.625 * (dev.reduce((t, v) => t + v, 0) / dev.length), 0.6, 3) : 1.1;
  const tol = cfg.plateauSigmas * noise;
  for (let i = 1; i < N; i++) {
    const seg = segs[i];
    if (!seg) continue;
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
    const step = (seg[seg.length - 1].t - seg[0].t) / (seg.length - 1);
    const leave = time[i - 1] + cfg.leaveS;
    out[i] = Math.max(0, (last >= 0 ? seg[last].t + 0.5 * step : leave) - leave);
  }
  return out;
}

/**
 * Indícios de escala para levantamentos sem caminhada contínua. Cada um diz por quanto o mapa
 * atual deveria ser multiplicado; a resposta é a média em log pesada pela confiança de cada um.
 * Nenhum é bom sozinho (erro de ~30-40%), mas erram por motivos diferentes.
 */
function scaleEvidence(survey, prep, model, cfg, theta) {
  const { scans, nodeOf, N } = prep;
  const hop = (i) => Math.hypot(theta[2 * nodeOf[i - 1]] - theta[2 * nodeOf[i]], theta[2 * nodeOf[i - 1] + 1] - theta[2 * nodeOf[i] + 1]);
  let sum = 0;
  let weight = 0;
  const add = (value, sd) => {
    if (!Number.isFinite(value) || value <= 0) return;
    sum += Math.log(clamp(value, 0.2, 5)) / (sd * sd);
    weight += 1 / (sd * sd);
  };
  // (1) Tempo andando x distância no mapa entre pontos consecutivos.
  {
    const wt = walkTimes(survey, prep, cfg);
    let sumT = 0;
    let sumL = 0;
    let count = 0;
    for (let i = 1; i < N; i++) {
      if (!Number.isFinite(wt[i]) || nodeOf[i] === nodeOf[i - 1] || scans[i].spot == null || scans[i - 1].spot == null) continue;
      sumT += Math.min(wt[i], cfg.walkCapS);
      sumL += hop(i);
      count++;
    }
    if (count >= 6 && sumL > 1e-6 && sumT > 0) add((cfg.walkSpeed * sumT) / sumL, cfg.evWalkSd);
  }
  // (2) Física perto do roteador: em visada direta o sinal cai ~20 dB por década a partir de p0.
  {
    const { oA, M, oNode, oRad, oFloor, oY, zFloor, radDev, p0Ref } = model;
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
    if (ratios.length >= 3) add(median(ratios), cfg.evPhysicsSd);
  }
  // (3) Espaçamento: quem marca pontos costuma andar alguns passos entre um e o seguinte
  // (pontos consecutivos na ordem da visita, haja ou não varreduras andando no meio).
  {
    const hops = [];
    let last = -1;
    for (let i = 0; i < N; i++) {
      if (scans[i].spot == null || nodeOf[i] === last) continue;
      if (last >= 0) hops.push(Math.hypot(theta[2 * last] - theta[2 * nodeOf[i]], theta[2 * last + 1] - theta[2 * nodeOf[i] + 1]));
      last = nodeOf[i];
    }
    if (hops.length >= 6) add(cfg.hopM / Math.max(1e-6, median(hops)), cfg.evHopSd);
  }
  return weight > 0 ? { factor: Math.exp(sum / weight), sd: 1 / Math.sqrt(weight) } : null;
}

/**
 * Quanto as distâncias medidas pelo usuário mandam na escala (0..1). Cada ponto do mapa tem
 * ~1 m de erro: uma base de 10 m fixa a escala, uma de 1,5 m quase não diz nada sobre ela.
 * (Para a razão mapa/medida ser melhor que os ~20% da caminhada, a base precisa passar de ~5 m.)
 */
function knownTrust(model) {
  let m2 = 0;
  for (const kd of model.known) m2 += kd.meters * kd.meters;
  return m2 / (m2 + 25 * Math.max(1, model.known.length));
}

/**
 * Aplica as distâncias medidas: corrige a escala na proporção da confiança da base e deixa cada
 * par medido exatamente com a distância pedida (os dois extremos se ajustam por igual).
 * Se a medida discorda do mapa por mais do que um erro de escala plausível (~1,6x), o problema é
 * de FORMA (os dois pontos estão mal colocados um em relação ao outro): aí só o par se ajusta,
 * porque esticar o mapa inteiro estragaria todo o resto. Devolve true se a escala foi corrigida.
 */
function applyKnownDistances(model, theta, trust) {
  let num = 0;
  let den = 0;
  for (const kd of model.known) {
    const d = Math.hypot(theta[2 * kd.a] - theta[2 * kd.b], theta[2 * kd.a + 1] - theta[2 * kd.b + 1]);
    num += kd.meters * d;
    den += d * d;
  }
  const factor = den > 1e-9 ? num / den : NaN;
  const plausible = factor > 0.6 && factor < 1.65;
  if (plausible) applyScale(model, theta, Math.pow(factor, trust));
  for (const kd of model.known) {
    const dx = theta[2 * kd.b] - theta[2 * kd.a];
    const dy = theta[2 * kd.b + 1] - theta[2 * kd.a + 1];
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) {
      theta[2 * kd.b] += kd.meters;
      continue;
    }
    const shift = (0.5 * (kd.meters - d)) / d;
    theta[2 * kd.a] -= shift * dx;
    theta[2 * kd.a + 1] -= shift * dy;
    theta[2 * kd.b] += shift * dx;
    theta[2 * kd.b + 1] += shift * dy;
  }
  return plausible;
}

/**
 * Correção de tortuosidade para quem anda: casa pequena obriga a virar antes de completar um
 * passo, e a corda entre duas varreduras encolhe em relação ao caminho andado (no limite do
 * passeio aleatório, corda ~ raiz do caminho). O prior de passo não sabe disso: sem a correção
 * a kitnet sai grande demais e o escritório pequeno demais. Entra o raio do mapa (m).
 */
function turnFactor(cfg, radius) {
  const x = (cfg.turnKappa * radius) / (cfg.pace * STEP_S);
  return clamp(cfg.turnTop * Math.sqrt(x / (1 + x)), 0.7, 1.4);
}

// ---------------------------------------------------------------------------
// Solução
// ---------------------------------------------------------------------------

function emptySolution(survey) {
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : [];
  return { points: scans.map((s) => ({ x: 0, y: 0, z: floorOf(s) * FLOOR_HEIGHT, conf: 0 })), aps: {}, scaleConf: 0 };
}

function isValid(solution, survey) {
  const n = survey && Array.isArray(survey.scans) ? survey.scans.length : 0;
  if (!solution || !Array.isArray(solution.points) || solution.points.length !== n) return false;
  for (const p of solution.points) if (!p || ![p.x, p.y, p.z, p.conf].every(Number.isFinite)) return false;
  for (const a of Object.values(solution.aps || {})) if (![a.x, a.y, a.z, a.p0, a.n, a.conf].every(Number.isFinite)) return false;
  return Number.isFinite(solution.scaleConf);
}

/**
 * Resolve o mapa: onde cada varredura foi feita e onde está cada roteador.
 *
 * @param {import('../types.js').Survey} survey
 * @param {{seed?: number, budgetMs?: number, onProgress?: (fraction: number, stage: string) => void,
 *          warmStart?: {points: {x:number, y:number}[], aps?: Object<string,{x:number, y:number, z?:number}>}}} [options]
 *        `warmStart` = solução anterior do mesmo levantamento (mesmo referencial), para refinar.
 *        `seed` não é usado: o método não sorteia nada.
 * @returns {import('../types.js').MapSolution}
 */
export function solve(survey, options) {
  const opts = options && typeof options === 'object' ? options : {};
  try {
    const solution = solveInner(survey, opts);
    if (isValid(solution, survey)) return solution;
  } catch (err) {
    if (opts.debug) throw err;
  }
  return emptySolution(survey);
}

function solveInner(survey, options) {
  const t0 = now();
  const budget = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : 4000;
  // Planeja terminar bem antes do corte: as etapas longas conferem este prazo (num levantamento
  // comum nem chegam perto dele; ele só morde em aparelho lento ou levantamento enorme).
  const deadline = t0 + 0.5 * budget;
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const cfg = options.cfg ? { ...CFG, ...options.cfg } : CFG;
  if (!survey || !Array.isArray(survey.scans) || survey.scans.length === 0) return emptySolution(survey);

  const prep = prepare(survey);
  const { P, N } = prep;
  if (P < 2) return emptySolution(survey);
  const model = buildModel(prep, cfg);
  progress(0.05, 'preparo');

  // --- partida ---
  const X0 = initNodes(prep);
  rescaleInit(prep, X0, cfg);
  if (model.RA === 0) {
    // Leituras de menos para ajustar qualquer curva (levantamento minúsculo): fica o embutimento
    // das impressões digitais, com confiança baixa.
    return finalize(survey, prep, model, X0, new Float64Array(P).fill(4), 0.05);
  }
  const theta = new Float64Array(model.size);
  theta.set(X0, 0);
  const warm = options.warmStart;
  if (warm && Array.isArray(warm.points) && warm.points.length === N) {
    for (let i = 0; i < N; i++) {
      const p = warm.points[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      theta[2 * prep.nodeOf[i]] = p.x;
      theta[2 * prep.nodeOf[i] + 1] = p.y;
    }
  }
  initDevices(model, cfg, theta);
  if (warm && warm.aps && typeof warm.aps === 'object') {
    for (let a = 0; a < model.RA; a++) {
      const id = prep.radios[model.list[a]].ids.find((q) => warm.aps[q]);
      const w = id ? warm.aps[id] : null;
      if (!w || !Number.isFinite(w.x) || !Number.isFinite(w.y)) continue;
      const d3 = model.oA + 3 * model.radDev[a];
      theta[d3] = w.x;
      theta[d3 + 1] = w.y;
      if (Number.isFinite(w.z)) theta[d3 + 2] = w.z;
    }
  }
  progress(0.15, 'partida');

  // --- geometria: L-BFGS sobre tudo ---
  // Variáveis reescaladas: posições em metros, p0 em dB, n e alpha pequenos.
  const scale = new Float64Array(model.size).fill(1);
  for (let i = model.oA; i < model.oR; i++) scale[i] = 2;
  for (let a = 0; a < model.RA; a++) {
    scale[model.oR + 2 * a] = 0.1;
    scale[model.oR + 2 * a + 1] = 0.05;
  }
  for (let i = model.oR + 2 * model.RA; i < model.size; i++) scale[i] = 0.5;
  const u = new Float64Array(model.size);
  const th = new Float64Array(model.size);
  const gth = new Float64Array(model.size);
  let nodesFrozen = false;
  const fg = (uu, gu) => {
    for (let i = 0; i < uu.length; i++) th[i] = uu[i] * scale[i];
    const f = costAndGrad(model, cfg, th, gth);
    for (let i = 0; i < uu.length; i++) gu[i] = gth[i] * scale[i];
    if (nodesFrozen) for (let i = 0; i < model.oA; i++) gu[i] = 0;
    return f;
  };
  let stageDeadline = deadline;
  const optimise = (maxIter, freezeNodes) => {
    nodesFrozen = freezeNodes;
    for (let i = 0; i < model.size; i++) u[i] = theta[i] / scale[i];
    lbfgs(fg, u, { maxIter, deadline: stageDeadline, memory: 10 });
    for (let i = 0; i < model.size; i++) theta[i] = u[i] * scale[i];
    nodesFrozen = false;
  };
  const notes = [];
  const maxIter = cfg.maxIter;
  // A geometria fica com no máximo ~1/3 do tempo (só pesa em levantamento enorme): o resto é
  // da trajetória.
  stageDeadline = t0 + 0.3 * budget;
  for (let round = 0; round < cfg.rounds && now() < stageDeadline; round++) {
    optimise(maxIter, false);
    progress(0.15 + (0.4 * (round + 1)) / cfg.rounds, 'geometria');
  }
  stageDeadline = deadline;

  // --- escala ---
  // Só passos inteiros (andando nas duas pontas) ancoram a escala: um par com ponta parada dá
  // apenas um teto, e teto não impede o mapa de sair grande demais.
  let stepEdges = 0;
  for (const e of prep.edges) if (e.kind === 0 && e.dt < cfg.stepMaxDt) stepEdges++;
  const hasKnown = model.known.length > 0;
  const walked = stepEdges >= cfg.minStepEdges;
  const trust = hasKnown ? knownTrust(model) : 0;
  let scaleConf = 0.6;
  if (!walked) {
    // Sem caminhada contínua nada no ajuste segura a escala: ela vem dos indícios, e uma âncora
    // de tamanho a mantém enquanto a geometria se reacomoda.
    scaleConf = 0.1;
    for (let pass = 0; pass < 2 && now() < deadline; pass++) {
      const ev = scaleEvidence(survey, prep, model, cfg, theta);
      if (!ev) break;
      scaleConf = clamp(0.75 - ev.sd, 0.2, 0.55);
      applyScale(model, theta, ev.factor);
      notes.push(`escala x${ev.factor.toFixed(2)}`);
      model.sizeTarget = cloudRadius(theta, P).r;
      optimise(maxIter, false);
    }
  }
  let targetSize = cloudRadius(theta, P).r;
  if (walked) {
    // Com uma base medida longa a correção perde o sentido: a medida já fixou o tamanho.
    const k = Math.pow(turnFactor(cfg, targetSize), 1 - trust);
    targetSize *= k;
    notes.push(`curvas x${k.toFixed(2)}`);
  }
  progress(0.6, 'escala');

  // --- trajetória: EM curto com campo residual e grade ---
  const exclude = timeNeighbours(prep, cfg.fieldExclude);
  const nodeSpread = new Float64Array(P).fill(NaN);
  // Levantamento enorme: grade mais grossa, para caber no tempo.
  const cells = P > MANY_NODES ? Math.round(cfg.hmmMaxCells * 0.6) : cfg.hmmMaxCells;
  for (let it = 0; it < cfg.fieldRounds && now() < deadline; it++) {
    const grid = makeGrid(theta, P, Math.max(2, 2 * cfg.hmmQ), cfg.hmmMinCell, cells);
    const field = buildResidualField(model, cfg, theta, grid);
    const sigmaR = fieldSigmas(model, cfg, theta, grid, field, exclude);
    const logE = nodeEmissions(model, cfg, theta, grid, sigmaR, field, exclude);
    const hm = runHmm(prep, cfg, grid, logE);
    // Posição de cada nó: média das visitas que passaram por ele.
    const acc = new Float64Array(3 * P);
    const cnt = new Float64Array(P);
    for (let v = 0; v < prep.visits.length; v++) {
      const node = prep.visits[v].node;
      acc[3 * node] += hm.mean[2 * v];
      acc[3 * node + 1] += hm.mean[2 * v + 1];
      acc[3 * node + 2] += hm.spread[v];
      cnt[node]++;
    }
    for (let i = 0; i < P; i++) {
      if (!(cnt[i] > 0)) continue;
      theta[2 * i] = acc[3 * i] / cnt[i];
      theta[2 * i + 1] = acc[3 * i + 1] / cnt[i];
      nodeSpread[i] = acc[3 * i + 2] / cnt[i];
    }
    // Passo M: roteadores e curvas reajustados às posições alisadas (nós parados).
    if (it + 1 < cfg.fieldRounds) optimise(cfg.mIter, true);
    progress(0.6 + (0.3 * (it + 1)) / cfg.fieldRounds, 'trajetória');
  }

  // --- tamanho final ---
  // O alisamento encolhe um pouco o mapa: devolve o tamanho decidido na etapa de escala; uma
  // distância medida pelo usuário manda em tudo.
  {
    const size = cloudRadius(theta, P).r;
    if (cfg.spreadShrink > 0 && size > 1e-6) {
      // Mapa de erro mínimo: pontos incertos espalham mais do que a casa real (o ruído soma ao
      // tamanho), e um mapa grande demais erra mais que um pequeno demais. Encolhe na medida da
      // incerteza das posições em relação ao tamanho do mapa.
      let s2 = 0;
      let c = 0;
      for (let i = 0; i < P; i++) {
        if (!Number.isFinite(nodeSpread[i])) continue;
        s2 += nodeSpread[i] * nodeSpread[i];
        c++;
      }
      if (c > 0) targetSize *= Math.max(cfg.shrinkFloor, 1 / Math.sqrt(1 + (cfg.spreadShrink * s2) / (c * size * size)));
    }
    if (size > 1e-6 && targetSize > 1e-6) applyScale(model, theta, targetSize / size);
    if (hasKnown && applyKnownDistances(model, theta, trust)) scaleConf = Math.max(scaleConf, 0.95 * trust);
    model.sizeTarget = 0;
    // Roteadores coerentes com as posições finais.
    if (now() < deadline) optimise(cfg.mIter, true);
  }

  const solution = finalize(survey, prep, model, theta, nodeSpread, scaleConf);
  if (options.debug) solution.debug = { ms: now() - t0, note: notes.join(' '), nodes: P, radios: model.RA };
  progress(1, 'pronto');
  return solution;
}

/** Monta a saída: centra, gira para o eixo de maior espalhamento e preenche roteadores e confianças. */
function finalize(survey, prep, model, theta, nodeSpread, scaleConf) {
  const { N, P, nodeOf, scans, radios } = prep;
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    px[i] = theta[2 * nodeOf[i]];
    py[i] = theta[2 * nodeOf[i] + 1];
  }
  // Centro e eixo principal (cada varredura conta uma vez).
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < N; i++) {
    cx += px[i];
    cy += py[i];
  }
  cx /= N;
  cy /= N;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < N; i++) {
    sxx += (px[i] - cx) * (px[i] - cx);
    sxy += (px[i] - cx) * (py[i] - cy);
    syy += (py[i] - cy) * (py[i] - cy);
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const tx = (x, y) => c * (x - cx) + s * (y - cy);
  const ty = (x, y) => -s * (x - cx) + c * (y - cy);

  // Confiança de um ponto: quão concentrada ficou a distribuição da posição (1,5 m de
  // espalhamento = 0,5). Nó sem leitura nenhuma só tem a caminhada a seu favor.
  const hasObs = new Uint8Array(P);
  for (let m = 0; m < model.M; m++) hasObs[model.oNode[m]] = 1;
  const points = new Array(N);
  for (let i = 0; i < N; i++) {
    const node = nodeOf[i];
    const spread = Number.isFinite(nodeSpread[node]) ? nodeSpread[node] : 3;
    const conf = (hasObs[node] ? 1 : 0.4) / (1 + (spread / 1.5) * (spread / 1.5));
    points[i] = { x: tx(px[i], py[i]), y: ty(px[i], py[i]), z: floorOf(scans[i]) * FLOOR_HEIGHT, conf: clamp(conf, 0, 1) };
  }

  // Roteadores: confiança alta só para quem foi visto de perto e muitas vezes (um vizinho
  // distante tem direção, mas a distância é quase um palpite).
  const aps = {};
  for (let a = 0; a < model.RA; a++) {
    const r = radios[model.list[a]];
    const d3 = model.oA + 3 * model.radDev[a];
    const x = tx(theta[d3], theta[d3 + 1]);
    const y = ty(theta[d3], theta[d3 + 1]);
    const main = model.mainFloor[a];
    const p0 = theta[model.p0Index[a * model.NF + main]];
    const n = theta[model.oR + 2 * a];
    // Altura relativa ao piso do andar de partida, presa ao andar onde o rádio chega mais forte.
    const zLow = prep.floorList[main] * FLOOR_HEIGHT;
    const z = clamp(theta[d3 + 2], zLow + 0.1, zLow + FLOOR_HEIGHT - 0.1);
    const near = clamp((model.top[a] - (model.p0Ref[a] - 30)) / 20, 0, 1);
    const seen = Math.min(1, prep.radioCount[model.list[a]] / 15);
    const conf = clamp(0.9 * near * seen, 0.05, 0.95);
    for (const id of r.ids) aps[id] = { x, y, z, p0, n, conf };
  }
  return { points, aps, scaleConf };
}
