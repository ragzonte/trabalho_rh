// Mapa só com Wi-Fi — motor "chain": cadeia no tempo + campo de cada rádio aprendido por EM.
//
// O grafo de poses aqui é uma CADEIA: nós = lugares visitados em ordem de tempo (uma varredura
// andando, ou as varreduras seguidas de um ponto marcado), arestas = "quem anda a ~0,6 m/s não
// vai longe entre uma varredura e outra". Os fechamentos de circuito não entram como arestas
// (a semelhança par a par entre impressões digitais é ruidosa demais: testado e descartado); entram
// pelo CAMPO de cada rádio, aprendido junto com as posições: dois lugares com o mesmo sinal em
// todos os rádios acabam no mesmo ponto do mapa. Três modelos de campo, do mais rígido ao mais solto:
//
//   1. plano por rádio (EM de um sistema dinâmico linear; resolve a forma geral e os andares);
//   2. radial por aparelho (log-distância a partir de uma posição de roteador estimada);
//   3. plano + bases radiais numa grade (só fica se a validação cruzada mostrar ganho claro:
//      é o caso de ambientes com muitos roteadores próprios, como um escritório).
//
// Em todos, um "não ouvi" é dado censurado no limiar de detecção do celular (não um valor inventado).
// A escala (metros) vem do ritmo da caminhada; quando o Android só deixa varrer a cada 30 s, o tempo
// de caminhada entre dois pontos marcados sai do sinal da rede conectada (ele estabiliza quando o
// usuário chega): é o motor que melhor aproveita esse modo.

import { FLOOR_HEIGHT, SWEEP_MID_S, cholesky, choleskySolve, finite, median, now, shareSpots, topEigen2, visitsOf } from './solver-common.js';

// --- como o Android entrega as leituras ---
const SWEEP_S = 2.6; // duração típica de uma varredura completa
const MID_S = SWEEP_MID_S; // uma varredura "andando" vale para o meio dela
const LONG_GAP_S = 8; // intervalo entre varreduras acima do qual o relógio deixa de dizer a distância (limite do Android: 30 s)
const TRACK_RES_S = 2; // o sinal da rede conectada chega a cada ~2 s: resolução do instante de chegada
const UNKNOWN_WALK_S = 4; // sem pista nenhuma: pontos marcados seguidos costumam ficar a uns 2 m
const TAP_S = 0.8; // tempo entre chegar a um ponto e tocar em "marcar"
const LEAVE_S = 0.6; // tempo entre a última varredura de um ponto e sair andando

// --- como as pessoas andam dentro de casa ---
const PACE = 0.62; // m/s com o celular na mão (faixa típica 0,4 a 0,9)
const STRAIGHT_S = 9; // s: de quanto em quanto tempo há uma curva ou parada (encurta a corda entre varreduras)
const STRAIGHT_DIRECT_S = 14; // o mesmo para quem vai direto de um ponto marcado ao seguinte (anda mais reto)
const MIN_WALK_S = 0.5;
const MAX_WALK_S = 8;
const STEP_SPREAD = 1.3; // E|passo|² / L²: os passos variam em torno do comprimento típico L

// --- rádio ---
const MISS_PROB = 0.05; // chance de um rádio audível faltar numa varredura (beacon perdido)
const FLOOR_SPLIT_DB = 8; // diferença de nível entre andares que denuncia um roteador de dentro da casa
const AP_CLEARANCE = 1.0; // m: distância mínima efetiva até um roteador (ele não está na altura do celular)
const SLOPE_PRIOR = 3; // expoente de perda típico com paredes (2 = espaço livre, 4+ = muito obstruído)
const SLOPE_MIN = 1.2;
const SLOPE_MAX = 6;

// Ajustes finos.
const TUNE = {
  linIters: 60,
  psiPool: 0.5, // quanto o ruído de cada rádio é puxado para o ruído comum (0 = nada, 1 = igual para todos)
  gradRidge: 0.05,
  radIters: 5,
  slopeRidge: 20,
  radDamp: 0.05,
  fieldIters: 30,
  fieldSigma0: 4, // m: largura das bases no começo...
  fieldSigma1: 2, // ...e no fim
  fieldRidge: 1,
  fieldMaxBasis: 120,
  fieldDamp: 0.5,
  fieldGate: 0.62, // os campos curvos só ficam se o erro de validação cruzada cair abaixo desta fração
  apPeak: -50, // dBm: rádio que chega mais forte que isto esteve a poucos passos do celular
};

/**
 * Resolve o levantamento com o motor chain.
 * @param {import('./solver-common.js').SurveyView} view
 * @param {{budgetMs?: number}} [options]
 * @returns {{x: Float64Array, y: Float64Array, conf: Float64Array, aps: Object, scaleConf: number}}
 *          posições por varredura (metros, referencial próprio) e roteadores por BSSID
 */
export function solveChain(view, options = {}) {
  const t0 = now();
  const budget = options.budgetMs > 0 ? options.budgetMs : 4000;
  // As etapas iterativas param aos 60% do orçamento: o que falta depois (montar a saída) é rápido.
  // Sem tempo, fica o resultado da etapa anterior.
  const alive = () => now() - t0 < 0.6 * budget;
  const P = prepare(view);
  const { n, N, nodes, nodeOf } = P;

  // --- posições dos nós ---
  const lin = emLinear(P, alive);
  let X = lin.X;
  let cov = lin.cov;
  const informative = lin.use.length > 0 && N > 1;
  // Retrato da solução plana: o campo curvo parte dela.
  const flat = { X: lin.X.map((p) => [p[0], p[1]]), cov: lin.cov.map((c0) => [c0[0], c0[1], c0[2]]) };
  let rad = null;
  if (informative && N >= 6) {
    rad = emRadial(P, lin, alive);
    if (!rad.done) rad = null;
  }
  if (informative && N >= 12 && alive()) {
    const fs = fieldStage(P, { ...lin, X: flat.X, cov: flat.cov }, alive);
    // Só fica se os campos curvos explicam as leituras bem melhor (é o caso de muitos roteadores perto).
    if (fs.complete && fs.cvLast < TUNE.fieldGate * fs.cvFirst) {
      X = fs.X;
      cov = fs.cov;
    }
  }

  // --- posição de cada varredura ---
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const conf = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = nodeOf[i];
    x[i] = finite(X[a][0]);
    y[i] = finite(X[a][1]);
    conf[i] = informative ? Math.max(0, Math.min(1, finite(1 / (1 + cov[a][0] + cov[a][2])))) : 0;
  }
  // Visitas diferentes ao mesmo ponto marcado são nós diferentes da cadeia: a saída divide a posição.
  shareSpots(view, x, y);

  // --- escala: boa quando quase todos os passos têm tempo de caminhada conhecido ---
  let scaleConf = !informative ? 0 : P.timed >= 0.8 * (N - 1) ? (nodes.some((nd) => nd.spot === null) ? 0.6 : 0.35) : 0.15;
  let spread = 0;
  for (let i = 0; i < n; i++) spread += (x[i] * x[i] + y[i] * y[i]) / n;
  if (spread < 0.01) scaleConf = Math.min(scaleConf, 0.05); // mapa sem tamanho: nada foi medido

  return { x, y, conf, aps: placeRouters(P, lin, rad, X, x, y), scaleConf };
}

// ---------------------------------------------------------------------------
// Preparação: nós da cadeia e tempos de caminhada
// ---------------------------------------------------------------------------

function prepare(view) {
  const { n, K, radios } = view;
  const tOf = (i) => view.time[i];
  // Impressão digital de cada varredura: média das leituras FRESCAS de cada rádio (NaN = não ouviu).
  const fp = new Array(n);
  for (let i = 0; i < n; i++) fp[i] = view.rssi.subarray(i * K, (i + 1) * K);
  // Limiar de detecção deste celular: abaixo disto um rádio some da lista.
  const floorDbm = Number.isFinite(view.lowLevel) ? view.lowLevel + 2 : -88;

  const nodes = visitsOf(view);
  const nodeOf = new Int32Array(n);
  nodes.forEach((v, a) => {
    for (const i of v.members) nodeOf[i] = a;
  });
  const N = nodes.length;
  // Leituras de cada nó: média entre as varreduras do nó, e em quantas delas o rádio apareceu.
  const y = new Array(N);
  const c = new Array(N);
  for (let a = 0; a < N; a++) {
    const sum = new Float64Array(K);
    const cnt = new Float64Array(K);
    for (const i of nodes[a].members) {
      for (let k = 0; k < K; k++) {
        if (fp[i][k] === fp[i][k]) {
          sum[k] += fp[i][k];
          cnt[k]++;
        }
      }
    }
    y[a] = Float64Array.from(sum, (v, k) => (cnt[k] ? v / cnt[k] : NaN));
    c[a] = cnt;
  }

  // Tempo de caminhada entre nós seguidos. Uma varredura "parada" garante o usuário no lugar durante
  // a varredura inteira (ele chegou, tocou em "marcar" e esperou a varredura seguinte começar: em
  // média meio intervalo); uma varredura "andando" vale para o instante do meio dela.
  const gaps = [];
  for (let i = 0; i + 1 < n; i++) gaps.push(tOf(i + 1) - tOf(i));
  const interval = gaps.length ? Math.min(LONG_GAP_S, Math.max(1, median(gaps))) : 3.5;
  const { track } = view;
  const walk = new Float64Array(Math.max(0, N - 1));
  const direct = new Uint8Array(Math.max(0, N - 1)); // passo de um ponto marcado ao seguinte, com espera no fim
  let timed = 0; // passos cujo tempo de caminhada é conhecido (não chutado)
  for (let a = 0; a + 1 < N; a++) {
    const i = nodes[a].members[nodes[a].members.length - 1];
    const j = nodes[a + 1].members[0];
    const depart = nodes[a].spot !== null ? tOf(i) + LEAVE_S : tOf(i) - MID_S;
    const arrive = nodes[a + 1].spot !== null ? tOf(j) - SWEEP_S - TAP_S - 0.5 * interval : tOf(j) - MID_S;
    let tau = arrive - depart;
    if (tOf(j) - tOf(i) > LONG_GAP_S && nodes[a + 1].spot !== null) {
      // Intervalo longo: o usuário andou e depois ESPEROU. O sinal da rede conectada mostra quando
      // ele chegou: dali em diante o nível fica parado.
      const seen = arrivalFromTrack(track, tOf(i) + 0.3, tOf(j) - SWEEP_S);
      direct[a] = 1;
      if (seen === null) tau = UNKNOWN_WALK_S;
      else {
        tau = Math.hypot(Math.max(0, seen - depart), TRACK_RES_S);
        timed++;
      }
      walk[a] = Math.max(MIN_WALK_S, tau);
    } else {
      timed++;
      walk[a] = Math.max(MIN_WALK_S, Math.min(MAX_WALK_S, tau));
    }
  }
  return { view, n, radios, K, fp, floorDbm, nodes, nodeOf, N, y, c, walk, direct, timed };
}

// Instante em que o nível da rede conectada estabiliza dentro da janela (t0, t1] (null = sem dados).
function arrivalFromTrack(track, t0, t1) {
  const seg = [];
  for (const s of track) if (s.t > t0 && s.t <= t1) seg.push(s);
  if (seg.length < 4) return null;
  const last = seg[seg.length - 1];
  const tail = [];
  for (let j = seg.length >> 1; j < seg.length; j++) if (seg[j].id === last.id) tail.push(seg[j].rssi);
  tail.sort((p, q) => p - q);
  const level = tail[tail.length >> 1];
  let first = seg.length - 1;
  let misses = 0;
  for (let j = seg.length - 1; j >= 0; j--) {
    if (seg[j].id === last.id && Math.abs(seg[j].rssi - level) <= 2.5) {
      first = j;
      misses = 0;
    } else if (++misses >= 2) break; // uma leitura fora isolada é ruído; duas seguidas é outro lugar
  }
  return seg[first].t - TRACK_RES_S / 2;
}

// ---------------------------------------------------------------------------
// Álgebra pequena
// ---------------------------------------------------------------------------

// Dois primeiros componentes principais das linhas de M (N x K, já centradas): notas N x 2.
function pca2(M, N, K) {
  const C = new Float64Array(K * K);
  for (let a = 0; a < N; a++) {
    const row = M[a];
    for (let p = 0; p < K; p++) {
      const v = row[p];
      if (v === 0) continue;
      for (let q = p; q < K; q++) C[p * K + q] += v * row[q];
    }
  }
  for (let p = 0; p < K; p++) for (let q = 0; q < p; q++) C[p * K + q] = C[q * K + p];
  const { q1, q2 } = topEigen2(C, K, 200);
  const dot = (u, v) => {
    let s = 0;
    for (let p = 0; p < K; p++) s += u[p] * v[p];
    return s;
  };
  const X = new Array(N);
  for (let a = 0; a < N; a++) X[a] = [dot(M[a], q1), dot(M[a], q2)];
  return X;
}

function solveSpd(A, b, m) {
  const L = cholesky(A, m);
  return L ? choleskySolve(L, b, m) : null;
}

// ---------------------------------------------------------------------------
// Movimento: suavizador na cadeia de nós
// ---------------------------------------------------------------------------

// Comprimento típico do passo entre nós seguidos (L) e o peso do passo gaussiano (e = 1/variância por eixo).
function motionModel(P) {
  const { N, walk } = P;
  const L = new Float64Array(Math.max(0, N - 1));
  const e = new Float64Array(Math.max(0, N - 1));
  for (let a = 0; a + 1 < N; a++) {
    L[a] = (PACE * walk[a]) / (1 + walk[a] / (P.direct[a] ? STRAIGHT_DIRECT_S : STRAIGHT_S));
    e[a] = 2 / (STEP_SPREAD * L[a] * L[a]);
  }
  return { L, e };
}

// Cada nó traz a informação das suas leituras (J 2x2, h); nós seguidos são ligados por um passo
// gaussiano. Sistema tridiagonal em blocos: devolve em X a média e em cov a covariância a posteriori,
// e a razão entre os passos esperados a posteriori (E|passo|² = média² + covariâncias) e os do modelo.
// Razão 1 = o tamanho do mapa bate com a caminhada (é o ponto fixo do EM na direção da escala).
function chainSolve(N, Jxx, Jxy, Jyy, hx, hy, e, X, cov) {
  const Dxx = new Float64Array(N);
  const Dxy = new Float64Array(N);
  const Dyy = new Float64Array(N);
  const gx = new Float64Array(N);
  const gy = new Float64Array(N);
  for (let a = 0; a < N; a++) {
    const left = a > 0 ? e[a - 1] : 0;
    const right = a + 1 < N ? e[a] : 0;
    let pxx = Jxx[a] + left + right + 1e-9;
    let pxy = Jxy[a];
    let pyy = Jyy[a] + left + right + 1e-9;
    let rx = hx[a];
    let ry = hy[a];
    if (a > 0) {
      pxx -= left * left * Dxx[a - 1];
      pxy -= left * left * Dxy[a - 1];
      pyy -= left * left * Dyy[a - 1];
      rx += left * (Dxx[a - 1] * gx[a - 1] + Dxy[a - 1] * gy[a - 1]);
      ry += left * (Dxy[a - 1] * gx[a - 1] + Dyy[a - 1] * gy[a - 1]);
    }
    const det = pxx * pyy - pxy * pxy;
    Dxx[a] = pyy / det;
    Dxy[a] = -pxy / det;
    Dyy[a] = pxx / det;
    gx[a] = rx;
    gy[a] = ry;
  }
  let ratio = 0;
  for (let a = N - 1; a >= 0; a--) {
    if (a + 1 === N) {
      cov[a] = [Dxx[a], Dxy[a], Dyy[a]];
      X[a] = [Dxx[a] * gx[a] + Dxy[a] * gy[a], Dxy[a] * gx[a] + Dyy[a] * gy[a]];
      continue;
    }
    const w = e[a];
    const rx = gx[a] + w * X[a + 1][0];
    const ry = gy[a] + w * X[a + 1][1];
    const S = cov[a + 1];
    // C = D S ;  cov_a = D + w² C D ;  cov_{a,a+1} = w C
    const c00 = Dxx[a] * S[0] + Dxy[a] * S[1];
    const c01 = Dxx[a] * S[1] + Dxy[a] * S[2];
    const c10 = Dxy[a] * S[0] + Dyy[a] * S[1];
    const c11 = Dxy[a] * S[1] + Dyy[a] * S[2];
    cov[a] = [Dxx[a] + w * w * (c00 * Dxx[a] + c01 * Dxy[a]), Dxy[a] + w * w * (c00 * Dxy[a] + c01 * Dyy[a]), Dyy[a] + w * w * (c10 * Dxy[a] + c11 * Dyy[a])];
    X[a] = [Dxx[a] * rx + Dxy[a] * ry, Dxy[a] * rx + Dyy[a] * ry];
    const dx = X[a + 1][0] - X[a][0];
    const dy = X[a + 1][1] - X[a][1];
    const step2 = dx * dx + dy * dy + cov[a][0] + cov[a][2] + S[0] + S[2] - 2 * w * (c00 + c11);
    ratio += (step2 * w) / 2;
  }
  return N > 1 ? ratio / (N - 1) : 1;
}

// Aplica ao mapa o fator que leva a razão de passos a 1 (limitado por iteração, para não oscilar).
function rescale(ratio, limit, X, cov, extra) {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return;
  const s = Math.min(limit, Math.max(1 / limit, 1 / Math.sqrt(ratio)));
  for (let a = 0; a < X.length; a++) {
    X[a][0] *= s;
    X[a][1] *= s;
    cov[a][0] *= s * s;
    cov[a][1] *= s * s;
    cov[a][2] *= s * s;
  }
  if (extra) {
    for (const p of extra) {
      p.x *= s;
      p.y *= s;
    }
  }
}

// "Não ouvi" como dado censurado. Se o campo previsto ali está abaixo do limiar de detecção, a falta
// é o esperado e quase não informa; se está acima, ou foi um beacon perdido (não informa) ou o nó
// está no lugar errado (informa muito). Devolve o valor esperado da leitura que faltou (média da
// normal truncada no limiar, misturada com a hipótese de beacon perdido), o peso dessa
// pseudo-leitura e a variância que ela carrega.
function censoredReading(pred, sd, floorDbm, out) {
  const z = (floorDbm - pred) / sd;
  const below = normCdf(z);
  const resp = below / (below + MISS_PROB * (1 - below));
  const lambda = (0.3989422804014327 * Math.exp(-0.5 * z * z)) / Math.max(below, 1e-9);
  out.v = pred - resp * sd * Math.min(lambda, 6);
  out.w = Math.max(0.02, resp);
  out.extra = sd * sd * Math.max(0, 1 - z * lambda - lambda * lambda);
}

// Ruído comum: puxa o ruído de cada rádio para a média geométrica de todos.
function poolNoise(psi, use, amount) {
  if (!(amount > 0) || !use.length) return;
  let lg = 0;
  for (const k of use) lg += Math.log(psi[k]) / use.length;
  for (const k of use) psi[k] = Math.exp(amount * lg + (1 - amount) * Math.log(psi[k]));
}

// ---------------------------------------------------------------------------
// 1. Campo plano por rádio (EM de um sistema dinâmico linear)
//    y_ak = nivel_k[andar] + g_k . x_a + ruído ;  x_{a+1} = x_a + passo
// ---------------------------------------------------------------------------

function emLinear(P, alive) {
  const { N, K, y, c, nodes, floorDbm } = P;
  const floors = [...new Set(nodes.map((nd) => nd.floor))].sort((p, q) => p - q);
  const fIdx = Int32Array.from(nodes, (nd) => floors.indexOf(nd.floor));
  const F = floors.length;

  // Rádios ouvidos em nós suficientes para dizer algo.
  const heard = new Float64Array(K);
  for (let a = 0; a < N; a++) for (let k = 0; k < K; k++) if (c[a][k] > 0) heard[k]++;
  const use = [];
  for (let k = 0; k < K; k++) if (heard[k] >= Math.max(3, 0.04 * N)) use.push(k);

  // Linhas de cada rádio: leitura do nó, ou "não ouvi" no limiar de detecção (com incerteza extra).
  const rows = new Array(K);
  const meanLevel = Array.from({ length: K }, () => new Float64Array(F));
  for (const k of use) {
    const list = [];
    const sum = new Float64Array(F);
    const cnt = new Float64Array(F);
    for (let a = 0; a < N; a++) {
      // w = peso relativo ao ruído do rádio; extra = variância própria de uma pseudo-leitura
      const row = c[a][k] > 0 ? { a, v: y[a][k], w: c[a][k], imp: false, extra: 0 } : { a, v: floorDbm - 2, w: 0.3, imp: true, extra: 0 };
      list.push(row);
      sum[fIdx[a]] += row.v;
      cnt[fIdx[a]]++;
    }
    rows[k] = list;
    for (let f = 0; f < F; f++) meanLevel[k][f] = cnt[f] ? sum[f] / cnt[f] : floorDbm;
  }
  // Um roteador de dentro da casa muda muito de nível de um andar para o outro (laje) e o seu campo
  // é diferente em cada andar: ganha um gradiente por andar. Os de fora dividem o gradiente, e é isso
  // que alinha um andar com o outro.
  const split = new Uint8Array(K);
  if (F > 1) {
    for (const k of use) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let f = 0; f < F; f++) {
        lo = Math.min(lo, meanLevel[k][f]);
        hi = Math.max(hi, meanLevel[k][f]);
      }
      if (hi - lo >= FLOOR_SPLIT_DB) split[k] = 1;
    }
    if (use.every((k) => split[k])) split.fill(0); // sem nenhum rádio comum os andares ficariam soltos
  }

  // Partida: componentes principais das impressões digitais (faltantes no limiar), centradas por andar.
  const U = use.length;
  const M = new Array(N);
  for (let a = 0; a < N; a++) M[a] = Float64Array.from(use, (k) => rows[k][a].v - meanLevel[k][fIdx[a]]);
  const X = N >= 2 && U >= 1 ? pca2(M, N, U) : nodes.map(() => [0, 0]);
  for (let a = 0; a < N; a++) {
    X[a][0] *= 0.3; // ~0,3 m por dB: só para começar; o EM acerta pela caminhada
    X[a][1] *= 0.3;
  }

  const motion = motionModel(P);
  const g = Array.from({ length: K }, () => Array.from({ length: F }, () => [0, 0]));
  const b = Array.from({ length: K }, () => new Float64Array(F));
  const psi = new Float64Array(K).fill(16);
  const cov = Array.from({ length: N }, () => [0, 0, 0]); // xx, xy, yy

  // Regressão ponderada das leituras de um rádio nas posições (com a incerteza delas), para os
  // andares de `fs` juntos: um gradiente comum e um nível por andar. Devolve a soma dos resíduos.
  const fitPlane = (k, fs) => {
    const m = 2 + fs.length;
    const A = new Float64Array(m * m);
    const rhs = new Float64Array(m);
    const col = new Int32Array(F).fill(-1);
    fs.forEach((f, j) => (col[f] = 2 + j));
    for (const r of rows[k]) {
      const f = col[fIdx[r.a]];
      if (f < 0) continue;
      const w = r.w;
      const x0 = X[r.a][0];
      const x1 = X[r.a][1];
      const S = cov[r.a];
      A[0] += w * (x0 * x0 + S[0]);
      A[1] += w * (x0 * x1 + S[1]);
      A[m + 1] += w * (x1 * x1 + S[2]);
      A[f] += w * x0;
      A[m + f] += w * x1;
      A[f * m + f] += w;
      rhs[0] += w * r.v * x0;
      rhs[1] += w * r.v * x1;
      rhs[f] += w * r.v;
    }
    for (let p = 0; p < m; p++) for (let q = 0; q < p; q++) A[p * m + q] = A[q * m + p];
    // Prior fraco no gradiente (dB/m) e no nível, para rádios pouco ouvidos não explodirem.
    A[0] += TUNE.gradRidge;
    A[m + 1] += TUNE.gradRidge;
    for (let f = 2; f < m; f++) {
      A[f * m + f] += 1e-3;
      rhs[f] += 1e-3 * (floorDbm + 10);
    }
    const th = solveSpd(A, rhs, m);
    if (!th) return [0, 0];
    let res = 0;
    let sw = 0;
    for (const r of rows[k]) {
      const f = col[fIdx[r.a]];
      if (f < 0) continue;
      const w = r.w;
      const S = cov[r.a];
      const err = r.v - th[f] - th[0] * X[r.a][0] - th[1] * X[r.a][1];
      res += w * (err * err + r.extra + th[0] * th[0] * S[0] + 2 * th[0] * th[1] * S[1] + th[1] * th[1] * S[2]);
      sw += w;
    }
    fs.forEach((f, j) => {
      g[k][f] = [th[0], th[1]];
      b[k][f] = th[2 + j];
    });
    return [res, sw];
  };
  const allFloors = floors.map((_, f) => f);
  const mStep = () => {
    for (const k of use) {
      let res = 0;
      let sw = 0;
      for (const fs of split[k] ? allFloors.map((f) => [f]) : [allFloors]) {
        const [r, w] = fitPlane(k, fs);
        res += r;
        sw += w;
      }
      psi[k] = Math.max(1, (res + 4 * 9) / (sw + 4));
    }
    poolNoise(psi, use, TUNE.psiPool);
  };
  const Jxx = new Float64Array(N);
  const Jxy = new Float64Array(N);
  const Jyy = new Float64Array(N);
  const hx = new Float64Array(N);
  const hy = new Float64Array(N);
  const eStep = () => {
    Jxx.fill(0);
    Jxy.fill(0);
    Jyy.fill(0);
    hx.fill(0);
    hy.fill(0);
    for (const k of use) {
      for (const r of rows[k]) {
        const f = fIdx[r.a];
        const gk = g[k][f];
        const w = r.w / psi[k];
        const res = r.v - b[k][f];
        Jxx[r.a] += w * gk[0] * gk[0];
        Jxy[r.a] += w * gk[0] * gk[1];
        Jyy[r.a] += w * gk[1] * gk[1];
        hx[r.a] += w * gk[0] * res;
        hy[r.a] += w * gk[1] * res;
      }
    }
    return chainSolve(N, Jxx, Jxy, Jyy, hx, hy, motion.e, X, cov);
  };
  // Depois que os planos tomam forma, cada "não ouvi" passa a valer o que o plano prevê ali.
  const tobit = { v: 0, w: 0, extra: 0 };
  const censor = () => {
    for (const k of use) {
      const sd = Math.sqrt(psi[k]);
      for (const r of rows[k]) {
        if (!r.imp) continue;
        const f = fIdx[r.a];
        censoredReading(b[k][f] + g[k][f][0] * X[r.a][0] + g[k][f][1] * X[r.a][1], sd, floorDbm, tobit);
        r.v = tobit.v;
        r.w = tobit.w;
        r.extra = tobit.extra;
      }
    }
  };
  for (let it = 0; it < TUNE.linIters && (it < 15 || alive()); it++) {
    mStep();
    rescale(eStep(), 1.25, X, cov);
    if (it >= 5) censor();
  }
  return { X, cov, g, b, psi, use, rows, floors, fIdx, meanLevel, motion };
}

// ---------------------------------------------------------------------------
// 2. Campo radial por aparelho
//    y_ak = nivel_k[andar] - 10 n_k log10(distância até o roteador)
// ---------------------------------------------------------------------------

// O plano é o limite de um roteador muito distante. Para um roteador perto (o da casa) o campo é
// radial e bem mais informativo: cada APARELHO ganha uma posição, comum aos seus rádios; cada rádio,
// a sua inclinação n e o seu nível por andar (que engole a potência e a perda da laje).
function emRadial(P, lin, alive) {
  const { N, K, radios } = P;
  const { X, cov, use, rows, floors, fIdx, meanLevel, motion } = lin;
  const F = floors.length;
  const psi = Float64Array.from(lin.psi);
  const slope = new Float64Array(K).fill(SLOPE_PRIOR);
  const level = Array.from({ length: K }, () => new Float64Array(F));

  const devIndex = new Map();
  const devs = [];
  const devOf = new Int32Array(K).fill(-1);
  for (const k of use) {
    let d = devIndex.get(radios[k].device);
    if (d === undefined) {
      d = devs.length;
      devIndex.set(radios[k].device, d);
      devs.push({ radios: [], x: 0, y: 0, floor: 0, h2: new Float64Array(N) });
    }
    devs[d].radios.push(k);
    devOf[k] = d;
  }
  // Andar do aparelho: onde ele chega mais forte. Nos outros andares a distância inclui o pé-direito.
  for (const dv of devs) {
    let best = -Infinity;
    for (let f = 0; f < F; f++) {
      let s = 0;
      for (const k of dv.radios) s += meanLevel[k][f] / dv.radios.length;
      if (s > best) {
        best = s;
        dv.floor = f;
      }
    }
    for (let a = 0; a < N; a++) {
      const dz = (floors[fIdx[a]] - floors[dv.floor]) * FLOOR_HEIGHT;
      dv.h2[a] = AP_CLEARANCE * AP_CLEARANCE + dz * dz;
    }
  }
  const frame = () => {
    let cx = 0;
    let cy = 0;
    for (let a = 0; a < N; a++) {
      cx += X[a][0] / N;
      cy += X[a][1] / N;
    }
    let r2 = 0;
    for (let a = 0; a < N; a++) r2 += ((X[a][0] - cx) ** 2 + (X[a][1] - cy) ** 2) / N;
    return { cx, cy, R: Math.max(0.5, Math.sqrt(r2)) };
  };

  // Ajusta os rádios de um aparelho para uma posição candidata (ax, ay): para cada rádio, regressão
  // em t = 10 log10(distância) com um nível por andar. Devolve o custo (resíduos² / ruído).
  const Sw = new Float64Array(F);
  const Sy = new Float64Array(F);
  const St = new Float64Array(F);
  const tBuf = new Float64Array(N);
  const fitDevice = (dv, ax, ay, commit) => {
    for (let a = 0; a < N; a++) {
      const dx = X[a][0] - ax;
      const dy = X[a][1] - ay;
      tBuf[a] = 5 * Math.log10(dx * dx + dy * dy + dv.h2[a]);
    }
    let cost = 0;
    for (const k of dv.radios) {
      Sw.fill(0);
      Sy.fill(0);
      St.fill(0);
      let Stt = 0;
      let Sty = 0;
      for (const r of rows[k]) {
        const w = r.w;
        const f = fIdx[r.a];
        const t = tBuf[r.a];
        Sw[f] += w;
        Sy[f] += w * r.v;
        St[f] += w * t;
        Stt += w * t * t;
        Sty += w * t * r.v;
      }
      // y = L_f - n t ; eliminando L_f = (Sy_f + n St_f) / Sw_f sobra uma equação em n (com prior).
      let den = Stt + TUNE.slopeRidge;
      let num = -Sty + TUNE.slopeRidge * SLOPE_PRIOR;
      for (let f = 0; f < F; f++) {
        if (Sw[f] <= 0) continue;
        den -= (St[f] * St[f]) / Sw[f];
        num += (St[f] * Sy[f]) / Sw[f];
      }
      const n = Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, den > 1e-9 ? num / den : SLOPE_PRIOR));
      let sse = 0;
      let sw = 0;
      for (const r of rows[k]) {
        const f = fIdx[r.a];
        const err = r.v - (Sy[f] + n * St[f]) / Sw[f] + n * tBuf[r.a];
        sse += r.w * (err * err + r.extra);
        sw += r.w;
      }
      cost += sse / psi[k];
      if (!commit) continue;
      slope[k] = n;
      for (let f = 0; f < F; f++) level[k][f] = Sw[f] > 0 ? (Sy[f] + n * St[f]) / Sw[f] : P.floorDbm;
      // Ruído do rádio: resíduo + o que a incerteza de posição põe no campo.
      let extra = 0;
      const gk = (10 * n) / Math.LN10;
      for (const r of rows[k]) {
        const dx = X[r.a][0] - ax;
        const dy = X[r.a][1] - ay;
        const q = gk / (dx * dx + dy * dy + dv.h2[r.a]);
        const S = cov[r.a];
        extra += r.w * q * q * (dx * dx * S[0] + 2 * dx * dy * S[1] + dy * dy * S[2]);
      }
      psi[k] = Math.max(1, (sse + extra + 4 * 9) / (sw + 4));
    }
    return cost;
  };

  // Partida: o plano de cada aparelho vira um roteador distante na direção do gradiente.
  {
    const fr = frame();
    for (const dv of devs) {
      let gx = 0;
      let gy = 0;
      for (const k of dv.radios) {
        gx += lin.g[k][dv.floor][0] / dv.radios.length;
        gy += lin.g[k][dv.floor][1] / dv.radios.length;
      }
      const mag = Math.hypot(gx, gy);
      const dist = mag > 1e-6 ? Math.min(8 * fr.R, Math.max(2, (4.34 * SLOPE_PRIOR) / mag)) : 8 * fr.R;
      dv.x = fr.cx + (mag > 1e-6 ? (gx / mag) * dist : dist);
      dv.y = fr.cy + (mag > 1e-6 ? (gy / mag) * dist : 0);
    }
  }
  const tobit = { v: 0, w: 0, extra: 0 };
  const RING = [0, 0.4, 0.8, 1.2, 1.7, 2.5, 4, 7]; // raios da busca global, em raios do mapa
  const mStep = (global) => {
    const fr = frame();
    for (const dv of devs) {
      let best = fitDevice(dv, dv.x, dv.y, false);
      const tryAt = (ax, ay) => {
        const cst = fitDevice(dv, ax, ay, false);
        if (cst < best - 1e-9) {
          best = cst;
          dv.x = ax;
          dv.y = ay;
          return true;
        }
        return false;
      };
      if (global) {
        for (const rr of RING) {
          for (let j = 0; j < (rr === 0 ? 1 : 12); j++) {
            const ang = (j * Math.PI) / 6 + rr;
            tryAt(fr.cx + rr * fr.R * Math.cos(ang), fr.cy + rr * fr.R * Math.sin(ang));
          }
        }
      }
      // Busca local em padrão, com passo proporcional à distância até o mapa.
      const far = Math.max(fr.R, Math.hypot(dv.x - fr.cx, dv.y - fr.cy));
      for (const step of [0.3 * far, 0.08 * far, 0.02 * far]) {
        for (let round = 0, moved = true; moved && round < 4; round++) {
          moved = false;
          for (let j = 0; j < 8; j++) {
            const ang = (j * Math.PI) / 4;
            if (tryAt(dv.x + step * Math.cos(ang), dv.y + step * Math.sin(ang))) moved = true;
          }
        }
      }
      fitDevice(dv, dv.x, dv.y, true);
    }
    poolNoise(psi, use, TUNE.psiPool);
  };
  const Jxx = new Float64Array(N);
  const Jxy = new Float64Array(N);
  const Jyy = new Float64Array(N);
  const hx = new Float64Array(N);
  const hy = new Float64Array(N);
  // Passo de Gauss-Newton: lineariza cada campo em torno da posição atual do nó.
  const eStep = () => {
    for (let a = 0; a < N; a++) {
      Jxx[a] = TUNE.radDamp;
      Jxy[a] = 0;
      Jyy[a] = TUNE.radDamp;
      hx[a] = TUNE.radDamp * X[a][0];
      hy[a] = TUNE.radDamp * X[a][1];
    }
    for (const k of use) {
      const dv = devs[devOf[k]];
      const gk = (10 * slope[k]) / Math.LN10;
      const sd = Math.sqrt(psi[k]);
      for (const r of rows[k]) {
        const a = r.a;
        const dx = X[a][0] - dv.x;
        const dy = X[a][1] - dv.y;
        const r2 = dx * dx + dy * dy + dv.h2[a];
        const f = level[k][fIdx[a]] - 5 * slope[k] * Math.log10(r2);
        const fx = (-gk * dx) / r2;
        const fy = (-gk * dy) / r2;
        if (r.imp) {
          censoredReading(f, sd, P.floorDbm, tobit);
          r.v = tobit.v;
          r.w = tobit.w;
          r.extra = tobit.extra;
        }
        const w = r.w / psi[k];
        const res = r.v - f + fx * X[a][0] + fy * X[a][1];
        Jxx[a] += w * fx * fx;
        Jxy[a] += w * fx * fy;
        Jyy[a] += w * fy * fy;
        hx[a] += w * fx * res;
        hy[a] += w * fy * res;
      }
    }
    return chainSolve(N, Jxx, Jxy, Jyy, hx, hy, motion.e, X, cov);
  };
  let done = 0;
  for (let it = 0; it < TUNE.radIters && alive(); it++) {
    mStep(it === 0);
    rescale(eStep(), 1.15, X, cov, devs);
    done++;
  }
  if (done) mStep(false); // deixa os roteadores coerentes com as posições finais
  return { devs, devOf, slope, level, psi, done };
}

// ---------------------------------------------------------------------------
// 3. Campo curvo: plano + bases radiais numa grade, com validação "deixa um de fora"
// ---------------------------------------------------------------------------

function normCdf(z) {
  // Abramowitz-Stegun 26.2.17 (erro < 1e-7).
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

// Todos os rádios dividem a mesma matriz de projeto (um nível por andar, um plano e gaussianas numa
// grade sobre o mapa atual), então uma só fatoração serve a todos. Cada nó é reposicionado contra o
// campo ajustado SEM ele (alavanca), para o campo não decorar o próprio nó. Devolve o erro de
// validação cruzada da primeira e da última iteração: quem chama decide se o resultado fica.
function fieldStage(P, lin, alive) {
  const { N, nodes, floorDbm } = P;
  const { use, rows, floors, fIdx, motion } = lin;
  const X = lin.X.map((p) => [p[0], p[1]]);
  const cov = lin.cov.map((s) => [s[0], s[1], s[2]]);
  const F = floors.length;
  const U = use.length;
  const W = Float64Array.from(nodes, (nd) => nd.members.length);
  const psi = Float64Array.from(use, (k) => lin.psi[k]);
  // Leituras com os "não ouvi" preenchidos (o valor é refeito a cada iteração pelo campo previsto).
  const Y = new Array(N);
  const miss = new Array(N);
  for (let a = 0; a < N; a++) {
    Y[a] = new Float64Array(U);
    miss[a] = new Uint8Array(U);
    for (let u = 0; u < U; u++) {
      const r = rows[use[u]][a];
      Y[a][u] = r.v;
      miss[a][u] = r.imp ? 1 : 0;
    }
  }
  const Jxx = new Float64Array(N);
  const Jxy = new Float64Array(N);
  const Jyy = new Float64Array(N);
  const hx = new Float64Array(N);
  const hy = new Float64Array(N);
  let cvFirst = 0;
  let cvLast = 0;
  let done = 0;
  for (let it = 0; it < TUNE.fieldIters && alive(); it++) {
    // Bases largas no começo (campo quase plano), estreitas no fim.
    const frac = TUNE.fieldIters > 1 ? it / (TUNE.fieldIters - 1) : 1;
    const sigma = TUNE.fieldSigma0 * (TUNE.fieldSigma1 / TUNE.fieldSigma0) ** Math.min(1, frac * 1.5);
    // --- grade de centros por andar, sobre o mapa atual ---
    const centres = [];
    for (let f = 0; f < F; f++) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let a = 0; a < N; a++) {
        if (fIdx[a] !== f) continue;
        minX = Math.min(minX, X[a][0]);
        maxX = Math.max(maxX, X[a][0]);
        minY = Math.min(minY, X[a][1]);
        maxY = Math.max(maxY, X[a][1]);
      }
      if (minX === Infinity) continue;
      let h = sigma;
      while (((maxX - minX) / h + 2) * ((maxY - minY) / h + 2) > TUNE.fieldMaxBasis / F) h *= 1.1;
      const nx = Math.max(1, Math.ceil((maxX - minX) / h) + 1);
      const ny = Math.max(1, Math.ceil((maxY - minY) / h) + 1);
      const ox = (minX + maxX) / 2 - ((nx - 1) * h) / 2;
      const oy = (minY + maxY) / 2 - ((ny - 1) * h) / 2;
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) centres.push({ x: ox + i * h, y: oy + j * h, f, s2: h * h });
    }
    const M = F + 2 + centres.length;
    // --- matriz de projeto e as suas derivadas em x e y ---
    const Phi = new Array(N);
    const Px = new Array(N);
    const Py = new Array(N);
    for (let a = 0; a < N; a++) {
      const row = new Float64Array(M);
      const rx = new Float64Array(M);
      const ry = new Float64Array(M);
      row[fIdx[a]] = 1;
      row[F] = X[a][0];
      rx[F] = 1;
      row[F + 1] = X[a][1];
      ry[F + 1] = 1;
      for (let m = 0; m < centres.length; m++) {
        const ce = centres[m];
        if (ce.f !== fIdx[a]) continue;
        const dx = X[a][0] - ce.x;
        const dy = X[a][1] - ce.y;
        const v = Math.exp(-(dx * dx + dy * dy) / (2 * ce.s2));
        if (v < 1e-4) continue;
        row[F + 2 + m] = v;
        rx[F + 2 + m] = (-dx / ce.s2) * v;
        ry[F + 2 + m] = (-dy / ce.s2) * v;
      }
      Phi[a] = row;
      Px[a] = rx;
      Py[a] = ry;
    }
    // --- regressão de crista: A = Phi' W Phi + Lambda ---
    const A = new Float64Array(M * M);
    for (let a = 0; a < N; a++) {
      const row = Phi[a];
      for (let p = 0; p < M; p++) {
        const v = row[p];
        if (v === 0) continue;
        const wv = W[a] * v;
        for (let q = p; q < M; q++) A[p * M + q] += wv * row[q];
      }
    }
    for (let p = 0; p < M; p++) {
      A[p * M + p] += p < F ? 1e-6 : p < F + 2 ? TUNE.gradRidge : TUNE.fieldRidge;
      for (let q = 0; q < p; q++) A[p * M + q] = A[q * M + p];
    }
    const L = cholesky(A, M);
    if (!L) break;
    const weights = new Array(U);
    for (let u = 0; u < U; u++) {
      const rhs = new Float64Array(M);
      for (let a = 0; a < N; a++) {
        const row = Phi[a];
        const wy = W[a] * Y[a][u];
        for (let p = 0; p < M; p++) if (row[p] !== 0) rhs[p] += wy * row[p];
      }
      weights[u] = choleskySolve(L, rhs, M);
    }
    // Alavanca de cada nó e o quanto o gradiente do campo muda ao tirar o nó do ajuste.
    const lev = new Float64Array(N);
    const vx = new Float64Array(N);
    const vy = new Float64Array(N);
    for (let a = 0; a < N; a++) {
      const ua = choleskySolve(L, Phi[a], M);
      let h = 0;
      let sx = 0;
      let sy = 0;
      for (let p = 0; p < M; p++) {
        h += Phi[a][p] * ua[p];
        sx += Px[a][p] * ua[p];
        sy += Py[a][p] * ua[p];
      }
      lev[a] = Math.min(0.9, W[a] * h);
      vx[a] = W[a] * sx;
      vy[a] = W[a] * sy;
    }
    // --- campo previsto e gradiente em cada nó ---
    const pred = new Array(N);
    const gxA = new Array(N);
    const gyA = new Array(N);
    for (let a = 0; a < N; a++) {
      pred[a] = new Float64Array(U);
      gxA[a] = new Float64Array(U);
      gyA[a] = new Float64Array(U);
      const row = Phi[a];
      const rx = Px[a];
      const ry = Py[a];
      for (let u = 0; u < U; u++) {
        const w = weights[u];
        let f = 0;
        let fx = 0;
        let fy = 0;
        for (let p = 0; p < M; p++) {
          if (row[p] === 0 && rx[p] === 0 && ry[p] === 0) continue;
          f += row[p] * w[p];
          fx += rx[p] * w[p];
          fy += ry[p] * w[p];
        }
        pred[a][u] = f;
        gxA[a][u] = fx;
        gyA[a][u] = fy;
      }
    }
    // Ruído de cada rádio = erro de validação cruzada (resíduo "sem mim").
    let cv = 0;
    for (let u = 0; u < U; u++) {
      let s = 0;
      let sw = 0;
      for (let a = 0; a < N; a++) {
        if (miss[a][u]) continue;
        const err = (Y[a][u] - pred[a][u]) / (1 - lev[a]);
        s += W[a] * Math.min(err * err, 400);
        sw += W[a];
      }
      psi[u] = Math.max(1, (s + 4 * 9) / (sw + 4));
      cv += psi[u] / U;
    }
    if (it === 0) cvFirst = cv;
    cvLast = cv;
    // --- passo de Gauss-Newton nas posições ---
    for (let a = 0; a < N; a++) {
      let jxx = TUNE.fieldDamp;
      let jxy = 0;
      let jyy = TUNE.fieldDamp;
      let h0 = TUNE.fieldDamp * X[a][0];
      let h1 = TUNE.fieldDamp * X[a][1];
      const inv = 1 / (1 - lev[a]);
      for (let u = 0; u < U; u++) {
        let wgt;
        let res;
        let fx = gxA[a][u];
        let fy = gyA[a][u];
        if (miss[a][u]) {
          // "Não ouvi": ou o sinal estava abaixo do limiar (informa), ou foi um beacon perdido (não informa).
          const sd = Math.sqrt(psi[u]);
          const z = (floorDbm - pred[a][u]) / sd;
          const below = normCdf(z);
          const resp = below / (below + MISS_PROB * (1 - below));
          const dens = 0.3989422804014327 * Math.exp(-0.5 * z * z);
          const censored = pred[a][u] - (sd * dens) / Math.max(below, 1e-6); // média da normal truncada no limiar
          Y[a][u] = resp * Math.max(censored, floorDbm - 12) + (1 - resp) * pred[a][u];
          res = Math.min(0, floorDbm - 1 - pred[a][u]); // só empurra quando o campo previsto passa do limiar
          wgt = res < 0 ? resp / psi[u] : 0;
        } else {
          res = (Y[a][u] - pred[a][u]) * inv;
          fx -= vx[a] * res;
          fy -= vy[a] * res;
          wgt = (W[a] * (1 - lev[a])) / psi[u] / (1 + (res * res) / psi[u] / 9); // leitura muito fora pesa menos
        }
        jxx += wgt * fx * fx;
        jxy += wgt * fx * fy;
        jyy += wgt * fy * fy;
        const lin0 = res + fx * X[a][0] + fy * X[a][1];
        h0 += wgt * fx * lin0;
        h1 += wgt * fy * lin0;
      }
      Jxx[a] = jxx;
      Jxy[a] = jxy;
      Jyy[a] = jyy;
      hx[a] = h0;
      hy[a] = h1;
    }
    rescale(chainSolve(N, Jxx, Jxy, Jyy, hx, hy, motion.e, X, cov), 1.1, X, cov);
    done++;
  }
  return { X, cov, cvFirst, cvLast, complete: done === TUNE.fieldIters };
}

// ---------------------------------------------------------------------------
// Roteadores
// ---------------------------------------------------------------------------

// Melhor semelhança (rotação + escala + translação, sem espelho) que leva os pontos A nos pontos B.
function similarity(A, B) {
  const n = Math.min(A.length, B.length);
  let ax = 0;
  let ay = 0;
  let bx = 0;
  let by = 0;
  for (let i = 0; i < n; i++) {
    ax += A[i][0] / n;
    ay += A[i][1] / n;
    bx += B[i][0] / n;
    by += B[i][1] / n;
  }
  let dot = 0;
  let cross = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const px = A[i][0] - ax;
    const py = A[i][1] - ay;
    const qx = B[i][0] - bx;
    const qy = B[i][1] - by;
    dot += px * qx + py * qy;
    cross += px * qy - py * qx;
    norm += px * px + py * py;
  }
  const co = norm > 1e-12 ? dot / norm : 1;
  const si = norm > 1e-12 ? cross / norm : 0;
  return (x, y) => [bx + co * (x - ax) - si * (y - ay), by + si * (x - ax) + co * (y - ay)];
}

// Sem modelo radial (faltou tempo, ou rádio ouvido poucas vezes): centro dos pontos onde chegou mais forte.
function apFromStrongest(P, k, px, py) {
  const seen = [];
  for (let i = 0; i < P.n; i++) if (P.fp[i][k] === P.fp[i][k]) seen.push({ i, r: P.fp[i][k] });
  if (!seen.length) return null;
  seen.sort((p, q) => q.r - p.r);
  const top = seen.slice(0, 5);
  let w = 0;
  let x = 0;
  let yy = 0;
  for (const t of top) {
    const wt = 10 ** (t.r / 20);
    w += wt;
    x += wt * px[t.i];
    yy += wt * py[t.i];
  }
  // Confiança: alta só para quem foi ouvido muitas vezes e bem de perto.
  const near = Math.max(0, Math.min(1, (top[0].r + 70) / 25));
  const conf = seen.length >= 3 ? 0.1 + 0.6 * near * Math.min(1, seen.length / 20) : 0.03;
  return { x: x / w, y: yy / w, z: P.view.floor[top[0].i] * FLOOR_HEIGHT + 1, p0: Math.min(-20, top[0].r + 5), n: SLOPE_PRIOR, conf };
}

// Roteadores no referencial das posições finais. O modelo radial vive no referencial de lin.X; se
// as posições finais vieram dos campos curvos, leva os roteadores para lá pela melhor semelhança
// (rotação + escala + translação) entre os dois.
function placeRouters(P, lin, rad, X, px, py) {
  const { N } = P;
  const aps = {};
  const placed = new Set();
  const put = (k, ap) => {
    const entry = {
      x: Number.isFinite(ap.x) ? ap.x : 0,
      y: Number.isFinite(ap.y) ? ap.y : 0,
      z: Number.isFinite(ap.z) ? ap.z : 1,
      p0: Number.isFinite(ap.p0) ? ap.p0 : -40,
      n: Number.isFinite(ap.n) ? ap.n : SLOPE_PRIOR,
      conf: Number.isFinite(ap.conf) ? ap.conf : 0,
    };
    for (const id of P.radios[k].ids) aps[id] = entry;
  };
  const toFinal = X === lin.X ? (x, y) => [x, y] : similarity(lin.X, X);
  if (rad) {
    // Raio do mapa, para a confiança: roteador longe do que foi percorrido é só uma direção.
    let cx = 0;
    let cy = 0;
    for (let a = 0; a < N; a++) {
      cx += lin.X[a][0] / N;
      cy += lin.X[a][1] / N;
    }
    let r2 = 0;
    for (let a = 0; a < N; a++) r2 += ((lin.X[a][0] - cx) ** 2 + (lin.X[a][1] - cy) ** 2) / N;
    const R = Math.max(0.5, Math.sqrt(r2));
    for (const dv of rad.devs) {
      const away = Math.hypot(dv.x - cx, dv.y - cy) / R;
      for (const k of dv.radios) {
        let heard = 0;
        let peak = -Infinity;
        for (const r of lin.rows[k]) {
          if (r.imp) continue;
          heard++;
          if (r.v > peak) peak = r.v;
        }
        // Roteador por onde o usuário passou perto: o lugar onde ele chegou mais forte é melhor
        // pista do que o ajuste radial (paredes enganam a curva); fica para o laço seguinte.
        if (peak >= TUNE.apPeak) continue;
        const c0 = Math.min(1, heard / Math.max(8, 0.5 * N)) / (1 + Math.max(0, away - 1.5));
        const [ax, ay] = toFinal(dv.x, dv.y);
        put(k, { x: ax, y: ay, z: lin.floors[dv.floor] * FLOOR_HEIGHT + 1, p0: rad.level[k][dv.floor], n: rad.slope[k], conf: Math.max(0.02, Math.min(0.95, 0.9 * c0)) });
        placed.add(k);
      }
    }
  }
  for (let k = 0; k < P.K; k++) {
    if (placed.has(k)) continue;
    const ap = apFromStrongest(P, k, px, py);
    if (ap) put(k, ap);
  }
  return aps;
}
