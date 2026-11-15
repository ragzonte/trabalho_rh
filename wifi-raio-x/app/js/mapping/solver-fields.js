// Mapa só com Wi-Fi — motor "fields": campos de sinal latentes (família WiFi-SLAM / GP-LVM).
//
// A ideia: a posição de cada varredura é uma variável latente e o nível de cada rádio é uma função
// lisa e desconhecida da posição (um "campo"). Procuramos as posições que tornam todos os campos
// coerentes ao mesmo tempo: quem passa duas vezes pelo mesmo lugar ouve quase a mesma coisa, então
// as visitas repetidas se atraem sozinhas (o fechamento de circuito sai de graça).
//
// Etapas:
//   1. prepare        um "nó" por ponto marcado ou varredura andando, com a impressão digital dele;
//   2. embedUnfolded  imersão inicial "desdobrada" (tipo Isomap): só os pares de impressões digitais
//                     parecidas são confiáveis; as distâncias longas saem do caminho mais curto num
//                     grafo (vizinhos parecidos + a sequência da caminhada);
//   3. refineFields   refino: para cada rádio, média física (queda com a distância até uma fonte
//                     estimada) + resíduo liso aprendido das OUTRAS varreduras (regressão por núcleo
//                     deixando o próprio ponto de fora, para um ponto não se explicar sozinho), mais
//                     as restrições de movimento (ninguém anda a mais de ~0,9 m/s; passos parecidos);
//   4. escala         o Wi-Fi sozinho quase não mede metros: a régua principal é o passo de quem anda
//                     (tempo x velocidade típica), com uma ajuda fraca da física (nível típico a 1 m,
//                     que pesa mais quando há vários roteadores); sem relógio (um ponto a cada 30 s)
//                     sobra a física, segurada pelo tamanho típico de uma casa;
//   5. finish         posições por varredura, roteadores e confiança.
//
// Custo: O(nós² x rádios) por iteração. É o motor que melhor aproveita vários roteadores próprios
// (escritório, casa com malha).

import { FLOOR_HEIGHT, SWEEP_MID_S, clamp, classicalMds, finite, flatCloudStats, indexFloors, lbfgs, now, placesOf, shortestPaths } from './solver-common.js';

// ---------------------------------------------------------------------------
// Constantes físicas e de comportamento (com a justificativa de cada uma)
// ---------------------------------------------------------------------------

/** Um rádio que não apareceu está abaixo do limiar de detecção observado, com esta folga (dB). */
const CENSOR_MARGIN_DB = 2;
/** Peso máximo de um nó por rádio (um ponto marcado tem várias varreduras; depois de 2 o ganho é pequeno). */
const WEIGHT_CAP = 2;
/** Peso do núcleo abaixo do qual um par de nós é ignorado (a mais de ~3,7 larguras de distância). */
const KERNEL_CUTOFF = 1e-3;
const LOG10 = Math.log(10);

// Ajustes do método. Os que têm unidade física são priors largos (valem para casas e celulares
// diferentes); os demais são pesos relativos, escolhidos no conjunto de desenvolvimento.
const TUNING = {
  budgetShare: 0.55, // fração do tempo permitido que a otimização pode gastar
  // --- movimento ---
  walkSpeed: 0.45, // m/s: corda média entre varreduras de quem anda devagar olhando o celular (com quinas e paradas)
  vmax: 0.9, // m/s: quase ninguém anda mais que isto fazendo o levantamento dentro de casa
  motionW: 4, // peso da barreira de velocidade máxima
  motionSlack: 0.5, // m: folga da barreira
  springW: 1, // peso do "passo típico" (mola com comprimento walkSpeed x tempo)
  springSigma: 0.25, // m/s: largura da mola
  springShort: 0.5, // passos curtos (quina, parada) custam menos que passos longos demais
  orderW: 0.3, // pontos marcados em sequência costumam ser vizinhos (só quando o relógio não mede nada)
  orderHop: 1.0, // salto típico em unidades do espaçamento médio entre pontos
  // --- imersão inicial ---
  isoK: 8, // vizinhos por nó no grafo
  isoCrossK: 4, // vizinhos em outros andares
  isoSmooth: 0.5, // peso dos vizinhos de caminhada na suavização das impressões digitais
  smacofIters: 120,
  defaultRadius: 3.2, // m: raio de uma casa típica, usado só enquanto não há outra régua
  // --- campos ---
  hRel: 1.6, // largura do núcleo em unidades do espaçamento médio entre nós
  hMin: 0.6, // m
  hMinWalking: 1.8, // m: andando, o campo não é aprendido mais fino que isto (correlação típica da sombra: 1 a 2 m)
  hMax: 4, // m
  lambda: 0.5, // encolhimento do resíduo previsto quando há poucos vizinhos (volta para a média física)
  sigma: 4, // dB: desvio de uma leitura em torno do campo (ruído + desvanecimento + corpo)
  missW: 0.5, // peso de um "não ouvido" como observação
  outer: 4, // rodadas (modelo físico -> posições -> escala)
  inner: 25, // iterações de L-BFGS por rodada
  registerRounds: 2, // rodadas em que os andares são reencaixados como corpos rígidos
  // --- modelo físico dos roteadores ---
  fitMissW: 0.3,
  nMin: 1.6, // expoente de perda: de corredor (guia de onda) ...
  nMax: 5, // ... a muitas paredes
  nDefault: 2.5,
  apDz: 0.6, // m: diferença típica de altura entre o celular na mão e um roteador no mesmo andar
  farPenalty: 0.02,
  // --- escala pela física ---
  physW: 0.15, // peso (em log) da física quando há passo cronometrado
  physWMulti: 0.6, // idem, com três ou mais roteadores fortes (escritório, casa com malha)
  physN: 2.2, // expoente em visada quase direta
  physQ: 0.85, // quantil: as leituras mais fortes para a distância são as com menos parede
  physP0: -43, // dBm a 1 m em 2,4 GHz: ~20 dBm de EIRP, 40 dB de espaço livre, ~18 dB do celular, alguma obstrução
  physMinPeak: -52, // só rádios que chegam fortes (roteador dentro da área levantada)
  physDamp: 0.7,
  sparsePhysW: 0.65, // sem relógio: peso (em log) da física contra o raio típico de uma casa
  sparsePhysWMulti: 0.9, // idem, com três ou mais roteadores fortes
  // --- saída ---
  shiftGain: 0.5, // fração do atraso das leituras compensada ao longo do caminho
  probeStep: 0.5, // m: passo da sonda de curvatura (incerteza de cada ponto)
  sigmaMax: 4, // m: incerteza máxima atribuída a um ponto
  confSigma: 0.8, // m: incerteza em que a confiança de um ponto cai para a metade
};

/**
 * Resolve o levantamento com o motor fields.
 * @param {import('./solver-common.js').SurveyView} view
 * @param {{budgetMs?: number}} [options]
 * @returns {{x: Float64Array, y: Float64Array, conf: Float64Array, aps: Object, scaleConf: number}}
 *          posições por varredura (metros, referencial próprio) e roteadores por BSSID
 */
export function solveFields(view, options = {}) {
  const budgetMs = options.budgetMs > 0 ? options.budgetMs : 4000;
  const P = { ...TUNING, deadline: now() + TUNING.budgetShare * budgetMs };
  const data = prepare(view);
  let X = new Float64Array(2 * data.M);
  let solved = false;
  if (data.M >= 3 && data.R >= 1) {
    data.edges = motionEdges(data);
    X = embedUnfolded(data, P);
    // Escala provisória: passo de quem anda, ou o raio de uma casa típica.
    const k0 = clamp(stepScale(data, X, P) ?? sizeRatio(P.defaultRadius, radiusOf(X)), 1e-9, 1e9);
    for (let q = 0; q < X.length; q++) X[q] *= k0;
    X = refineFields(data, X, P);
    solved = true;
  }
  return finish(data, X, solved, P);
}

// ---------------------------------------------------------------------------
// Preparação
// ---------------------------------------------------------------------------

// Nós e a impressão digital de cada nó. Varreduras com o mesmo ponto marcado dividem o nó (mesmo
// em visitas diferentes: quem volta a um ponto está no mesmo lugar).
function prepare(view) {
  const { n, K } = view;
  // Só os rádios ouvidos de verdade (um BSSID que só aparece repetido não entra).
  const cols = [];
  for (let k = 0; k < K; k++) {
    let heard = false;
    for (let i = 0; i < n && !heard; i++) heard = view.count[i * K + k] > 0;
    if (heard) cols.push(k);
  }
  const radios = cols.map((k) => view.radios[k]);
  const R = cols.length;

  const { nodeOf: nodeOfScan, nodes } = placesOf(view);
  const M = nodes.length;

  // Impressão digital de cada nó: média das leituras frescas de cada rádio (NaN = não ouvido).
  const F = new Float64Array(M * R).fill(NaN);
  const cnt = new Float64Array(M * R);
  const sum = new Float64Array(M * R);
  for (let i = 0; i < n; i++) {
    const a = nodeOfScan[i];
    cols.forEach((k, c) => {
      if (!(view.count[i * K + k] > 0)) return;
      sum[a * R + c] += view.rssi[i * K + k];
      cnt[a * R + c]++;
    });
  }
  for (let q = 0; q < M * R; q++) if (cnt[q] > 0) F[q] = sum[q] / cnt[q];
  // Limiar de detecção deste celular: as leituras mais fracas que ele chegou a entregar.
  const floorLevel = Number.isFinite(view.lowLevel) ? view.lowLevel : -90;
  const censored = floorLevel - CENSOR_MARGIN_DB;

  // Andares e nível médio de cada rádio por andar (a laje entra como um deslocamento por andar).
  const { list: floorList, index: floorIdx } = indexFloors(nodes.map((nd) => nd.floor));
  const NF = floorList.length;
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
        s += Number.isNaN(v) ? censored : v;
        c++;
      }
      floorMean[k * NF + f] = c ? s / c : floorLevel;
    }
  }
  return { view, n, nodes, nodeOfScan, radios, R, M, F, cnt, floorLevel, censored, floorList, NF, floorIdx, floorNodes, floorMean };
}

// ---------------------------------------------------------------------------
// Movimento
// ---------------------------------------------------------------------------

// Tempo em que o usuário pôde andar entre duas varreduras seguidas (s): [esperado, máximo].
// A posição de uma varredura é a do meio dela (~1,35 s antes da entrega). Quem marca um ponto fica
// parado desde antes do começo da varredura (~3 s antes da entrega) até pouco depois dela.
function movingTime(dt, prevStill, nextStill) {
  if (!(dt > 0)) return [0, 0];
  if (!prevStill && !nextStill) return [dt, dt];
  if (prevStill && !nextStill) return [Math.max(0.2, dt - 2.0), Math.max(0.2, dt - 1.6)];
  if (!prevStill && nextStill) return [Math.max(0.2, (dt - 1.65) / 2), Math.max(0.2, dt - 1.65)];
  return [Math.max(0.2, (dt - 3.3) / 2), Math.max(0.2, dt - 3.3)];
}

function motionEdges(data) {
  const { view, n, nodeOfScan } = data;
  const edges = [];
  for (let i = 1; i < n; i++) {
    const a = nodeOfScan[i - 1];
    const b = nodeOfScan[i];
    if (a === b) continue;
    const prevStill = view.spot[i - 1] !== null;
    const nextStill = view.spot[i] !== null;
    const [texp, tmax] = movingTime(view.time[i] - view.time[i - 1], prevStill, nextStill);
    if (!(tmax > 0)) continue;
    edges.push({
      a,
      b,
      texp,
      tmax,
      informative: tmax <= 8, // só os intervalos curtos dizem algo sobre a distância percorrida
      spots: prevStill && nextStill,
    });
  }
  return edges;
}

// Escala pelo passo: velocidade média de corda (soma das cordas / tempo andando) igual à típica.
function stepScale(data, X, P) {
  let sd = 0;
  let st = 0;
  for (const e of data.edges) {
    if (!e.informative) continue;
    sd += Math.hypot(X[2 * e.a] - X[2 * e.b], X[2 * e.a + 1] - X[2 * e.b + 1]);
    st += e.texp;
  }
  if (st < 40 || !(sd > 0)) return null; // menos de ~40 s cronometrados: sem régua
  return (P.walkSpeed * st) / sd;
}

// Raio quadrático médio dos nós em torno do centro.
const radiusOf = (X) => flatCloudStats(X, X.length / 2).radius;

// Fator que leva um mapa de raio `radius` ao raio `target`. Mapa sem tamanho (todos os nós no mesmo
// lugar: acontece com um nó por andar, quando o reencaixe dos andares põe um em cima do outro) não
// tem o que esticar: o fator é 1. Dividir por "quase zero" multiplicava as coordenadas por bilhões
// a cada rodada, e esse mapa absurdo entrava no consenso.
const sizeRatio = (target, radius) => (radius > 1e-3 ? target / radius : 1);

// ---------------------------------------------------------------------------
// Imersão inicial "desdobrada"
// ---------------------------------------------------------------------------

// A distância entre impressões digitais satura depois de poucos metros (paredes, rádios que somem),
// então um MDS direto dobra a casa sobre si mesma. Aqui só os pares vizinhos são usados como estão;
// as distâncias longas são o caminho mais curto num grafo de vizinhança (k nós mais parecidos + a
// própria sequência da caminhada). O refino tolera bastante ruído local, mas não uma planta dobrada.
function embedUnfolded(data, P) {
  const { M, R, F, NF, floorIdx, censored, n, nodeOfScan, nodes } = data;
  // Nível centrado por andar: a laje vira deslocamento constante e some.
  const Y = new Float64Array(M * R);
  for (let a = 0; a < M; a++) {
    for (let k = 0; k < R; k++) {
      const v = F[a * R + k];
      Y[a * R + k] = (Number.isNaN(v) ? censored : v) - data.floorMean[k * NF + floorIdx[a]];
    }
  }
  // Sequência de visitas aos nós.
  const seq = [];
  for (let i = 0; i < n; i++) if (seq[seq.length - 1] !== nodeOfScan[i]) seq.push(nodeOfScan[i]);
  // Suavização no tempo (vizinhos de caminhada no mesmo andar): menos ruído na escolha dos vizinhos.
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
  // Dissimilaridade: diferença quadrática média (dB²) entre impressões digitais suavizadas.
  const DS = new Float64Array(M * M);
  for (let a = 0; a < M; a++) {
    for (let b = a + 1; b < M; b++) {
      let s = 0;
      for (let k = 0; k < R; k++) {
        const e = S[a * R + k] - S[b * R + k];
        s += e * e;
      }
      DS[a * M + b] = DS[b * M + a] = s / R;
    }
  }
  // Grafo: k vizinhos mais parecidos no mesmo andar, alguns em outros andares (com o nível centrado
  // por andar, o lugar mais parecido costuma estar na mesma vertical) e as arestas da caminhada.
  const Gd = new Float64Array(M * M).fill(Infinity);
  const setEdge = (a, b) => {
    Gd[a * M + b] = Gd[b * M + a] = Math.sqrt(Math.max(DS[a * M + b], 1e-9));
  };
  const same = [];
  const cross = [];
  for (let a = 0; a < M; a++) {
    same.length = 0;
    cross.length = 0;
    for (let b = 0; b < M; b++) {
      if (b === a) continue;
      (floorIdx[b] === floorIdx[a] ? same : cross).push(b);
    }
    const byLikeness = (p, q) => DS[a * M + p] - DS[a * M + q] || p - q;
    same.sort(byLikeness);
    for (let q = 0; q < Math.min(P.isoK, same.length); q++) setEdge(a, same[q]);
    if (cross.length) {
      cross.sort(byLikeness);
      for (let q = 0; q < Math.min(P.isoCrossK, cross.length); q++) setEdge(a, cross[q]);
    }
  }
  for (let p = 1; p < seq.length; p++) if (seq[p] !== seq[p - 1]) setEdge(seq[p], seq[p - 1]);
  for (let a = 0; a < M; a++) Gd[a * M + a] = 0;
  shortestPaths(Gd, M);
  // MDS métrico sobre as distâncias geodésicas; pares próximos pesam mais (1/d²).
  let maxFinite = 0;
  for (let q = 0; q < M * M; q++) if (Gd[q] !== Infinity && Gd[q] > maxFinite) maxFinite = Gd[q];
  if (!(maxFinite > 0)) return spiral(M); // todas as impressões digitais iguais: nada a desdobrar
  const Wt = new Float64Array(M * M);
  const D2 = new Float64Array(M * M);
  for (let q = 0; q < M * M; q++) {
    if (Gd[q] === Infinity) Gd[q] = 1.5 * maxFinite; // componentes soltas: longe
    Wt[q] = Gd[q] > 0 ? 1 / (Gd[q] * Gd[q] + 1e-6 * maxFinite * maxFinite) : 0;
    D2[q] = Gd[q] * Gd[q];
  }
  for (let a = 0; a < M; a++) Wt[a * M + a] = 0;
  return smacof(classicalMds(D2, M), Gd, Wt, M, P.smacofIters);
}

// Disposição de emergência (sem informação nenhuma): pontos muito próximos, sem coincidir.
function spiral(n) {
  const X = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const r = 0.01 * Math.sqrt(i);
    X[2 * i] = r * Math.cos(2.4 * i);
    X[2 * i + 1] = r * Math.sin(2.4 * i);
  }
  return X;
}

// SMACOF: minimiza Σ w (|xi − xj| − t)² por majoração (cada passo nunca piora).
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
      const row = i * n;
      for (let j = 0; j < n; j++) {
        const w = W[row + j];
        if (!(w > 0)) continue;
        const dx = xi - X[2 * j];
        const dy = yi - X[2 * j + 1];
        const d = Math.sqrt(dx * dx + dy * dy);
        const r = d > 1e-9 ? T[row + j] / d : 0;
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
// Andares
// ---------------------------------------------------------------------------

// Gradiente médio (dB/m) do nível de cada rádio num andar: regressão linear do nível sobre (x, y).
// Um vizinho distante, ou um roteador num canto, "aponta" para o mesmo lado em todos os andares.
function floorGradients(data, X, f) {
  const { M, R, F, floorIdx, censored } = data;
  const idx = [];
  for (let a = 0; a < M; a++) if (floorIdx[a] === f) idx.push(a);
  const n = idx.length;
  let cx = 0;
  let cy = 0;
  for (const a of idx) {
    cx += X[2 * a];
    cy += X[2 * a + 1];
  }
  cx /= n || 1;
  cy /= n || 1;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const a of idx) {
    const x = X[2 * a] - cx;
    const y = X[2 * a + 1] - cy;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  const det = sxx * syy - sxy * sxy;
  const g = new Array(R).fill(null);
  if (n < 6 || !(det > 1e-9)) return g;
  for (let k = 0; k < R; k++) {
    let heard = 0;
    let my = 0;
    for (const a of idx) {
      const v = F[a * R + k];
      if (!Number.isNaN(v)) heard++;
      my += Number.isNaN(v) ? censored : v;
    }
    if (heard < 0.3 * n) continue;
    my /= n;
    let bx = 0;
    let by = 0;
    for (const a of idx) {
      const v = F[a * R + k];
      const y = (Number.isNaN(v) ? censored : v) - my;
      bx += (X[2 * a] - cx) * y;
      by += (X[2 * a + 1] - cy) * y;
    }
    g[k] = [(syy * bx - sxy * by) / det, (sxx * by - sxy * bx) / det];
  }
  return g;
}

// Reencaixa os andares uns sobre os outros (cada andar se move como um corpo rígido): rotação e
// espelho pelos gradientes dos rádios ouvidos nos dois andares, translação pela escada (quem acabou
// de trocar de andar está perto de onde estava). Os campos são aprendidos por andar, então sem isto
// um andar poderia girar em relação ao outro sem custo.
function registerFloors(data, X) {
  const { M, R, NF, floorIdx, n, nodeOfScan } = data;
  if (NF < 2) return;
  const count = data.floorNodes;
  let ref = 0;
  for (let f = 1; f < NF; f++) if (count[f] > count[ref]) ref = f;
  const done = new Set([ref]);
  const todo = [];
  for (let f = 0; f < NF; f++) if (f !== ref) todo.push(f);
  todo.sort((p, q) => Math.abs(p - ref) - Math.abs(q - ref));
  const ties = []; // trocas de andar ao longo da caminhada
  for (let i = 1; i < n; i++) {
    const a = nodeOfScan[i - 1];
    const b = nodeOfScan[i];
    if (floorIdx[a] !== floorIdx[b]) ties.push([a, b]);
  }
  for (const f of todo) {
    if (count[f] < 1) continue;
    let near = ref; // andar já encaixado mais próximo
    for (const d of done) if (Math.abs(d - f) < Math.abs(near - f)) near = d;
    const g0 = floorGradients(data, X, near);
    const g1 = floorGradients(data, X, f);
    // Melhor rotação (com ou sem espelho) dos gradientes de um andar sobre os do outro.
    let a = 0;
    let b = 0;
    let am = 0;
    let bm = 0;
    for (let k = 0; k < R; k++) {
      if (!g0[k] || !g1[k]) continue;
      const [px, py] = g1[k];
      const [qx, qy] = g0[k];
      a += px * qx + py * qy;
      b += px * qy - py * qx;
      am += px * qx - py * qy;
      bm += px * qy + py * qx;
    }
    const plain = Math.hypot(a, b);
    const mirrored = Math.hypot(am, bm);
    let c = 1;
    let sn = 0;
    let m = 1;
    if (plain > 1e-9 || mirrored > 1e-9) {
      const mirror = mirrored > plain;
      const ang = mirror ? Math.atan2(bm, am) : Math.atan2(b, a);
      c = Math.cos(ang);
      sn = Math.sin(ang);
      m = mirror ? -1 : 1;
    }
    let cx = 0;
    let cy = 0;
    let rx = 0;
    let ry = 0;
    let rn = 0;
    for (let q = 0; q < M; q++) {
      if (floorIdx[q] === f) {
        cx += X[2 * q];
        cy += X[2 * q + 1];
      } else if (floorIdx[q] === near) {
        rx += X[2 * q];
        ry += X[2 * q + 1];
        rn++;
      }
    }
    cx /= count[f];
    cy /= count[f];
    for (let q = 0; q < M; q++) {
      if (floorIdx[q] !== f) continue;
      const x = X[2 * q] - cx;
      const y = (X[2 * q + 1] - cy) * m;
      X[2 * q] = c * x - sn * y;
      X[2 * q + 1] = sn * x + c * y;
    }
    let tx = 0;
    let ty = 0;
    let tn = 0;
    for (const [p, q] of ties) {
      const fp = floorIdx[p];
      const fq = floorIdx[q];
      if (fp === f && done.has(fq)) {
        tx += X[2 * q] - X[2 * p];
        ty += X[2 * q + 1] - X[2 * p + 1];
        tn++;
      } else if (fq === f && done.has(fp)) {
        tx += X[2 * p] - X[2 * q];
        ty += X[2 * p + 1] - X[2 * q + 1];
        tn++;
      }
    }
    if (tn > 0) {
      tx /= tn;
      ty /= tn;
    } else if (rn > 0) {
      tx = rx / rn; // sem escada registrada: centro sobre centro
      ty = ry / rn;
    }
    for (let q = 0; q < M; q++) {
      if (floorIdx[q] !== f) continue;
      X[2 * q] += tx;
      X[2 * q + 1] += ty;
    }
    done.add(f);
  }
}

// ---------------------------------------------------------------------------
// Modelo físico de cada aparelho: rssi = p0(rádio, andar) − 10 n log10(d)
// ---------------------------------------------------------------------------

// Com as posições atuais dos nós, ajusta a posição (busca em grade + refino) e a curva de cada
// aparelho. É a "média" dos campos: dá a forma global (as paredes e a sombra ficam para o resíduo).
function fitApModels(data, X, P, prev, searchGrid = true) {
  const { M, R, F, cnt, NF, radios, floorLevel, floorList } = data;
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
    h2: new Float64Array(R * NF), // (diferença de altura)² entre o celular em cada andar e o aparelho
    apFloor: new Int32Array(R),
    devs: [],
  };
  const byDev = new Map();
  radios.forEach((r, k) => {
    if (!byDev.has(r.device)) byDev.set(r.device, []);
    byDev.get(r.device).push(k);
  });
  const L = new Float64Array(M);
  for (const [dev, ks] of byDev) {
    // Observações do aparelho, por grupo (rádio, andar): cada grupo tem o seu p0; o n é do aparelho.
    const NG = ks.length * NF;
    const obsNode = [];
    const obsGroup = [];
    const obsY = [];
    const obsW = [];
    const gW = new Float64Array(NG);
    const gY = new Float64Array(NG);
    const floorSum = new Float64Array(NF);
    const floorCnt = new Float64Array(NF);
    let heard = 0;
    ks.forEach((k, q) => {
      for (let a = 0; a < M; a++) {
        const v = F[a * R + k];
        const g = q * NF + fi[a];
        let y;
        let w;
        if (Number.isNaN(v)) {
          y = floorLevel - 3; // não ouvido: abaixo do limiar
          w = P.fitMissW;
        } else {
          y = v;
          w = Math.min(WEIGHT_CAP, cnt[a * R + k]);
          floorSum[fi[a]] += v;
          floorCnt[fi[a]]++;
          heard++;
        }
        obsNode.push(a);
        obsGroup.push(g);
        obsY.push(y);
        obsW.push(w);
        gW[g] += w;
        gY[g] += w * y;
      }
    });
    // Andar do aparelho: onde ele chega mais forte e mais vezes.
    let apF = 0;
    let bestLevel = -Infinity;
    for (let f = 0; f < NF; f++) {
      if (floorCnt[f] < 3) continue;
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
    // Para uma posição candidata o modelo é linear em (p0 de cada grupo, n): mínimos quadrados fechados.
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
      return { ss: ySS + 2 * n * sLY + n * n * sLL, n };
    };
    let best = { score: Infinity, ss: ySS, n: P.nDefault, ax: cx, ay: cy, dz: P.apDz };
    const tryAt = (ax, ay, dz) => {
      const far = Math.hypot(ax - cx, ay - cy) / rad;
      if (far > 12) return;
      const r = evalAt(ax, ay, dz);
      // Entre ajustes equivalentes, leve preferência pela posição mais próxima.
      const score = r.ss * (1 + P.farPenalty * Math.max(0, far - 1));
      if (score < best.score) best = { score, ss: r.ss, n: r.n, ax, ay, dz };
    };
    // Num prédio o vizinho pode estar um andar acima ou abaixo: testa também essa altura.
    const dzs = NF > 1 ? [P.apDz] : [P.apDz, FLOOR_HEIGHT];
    const before = prev && prev.devs.find((d) => d.device === dev);
    if (before) tryAt(before.ax, before.ay, before.dz);
    // A grade inteira só nas primeiras rodadas; depois basta refinar a partir da posição anterior.
    if (searchGrid || !before) for (const dz of dzs) for (const c of cand) tryAt(c[0], c[1], dz);
    // Refino local (busca em padrão, com teto de passos).
    let step = 0.1 * rad;
    for (let moves = 0; moves < 30 && step > 0.08; moves++) {
      let improved = false;
      const bx = best.ax;
      const by = best.ay;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const was = best.score;
        tryAt(bx + ox * step, by + oy * step, best.dz);
        if (best.score < was) improved = true;
      }
      if (!improved) step *= 0.5;
    }
    evalAt(best.ax, best.ay, best.dz); // deixa gL com a posição final, para o p0 de cada grupo
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
    model.devs.push({
      device: dev,
      ax: best.ax,
      ay: best.ay,
      dz: best.dz,
      n: best.n,
      apFloor: apF,
      radios: ks,
      heard,
      explained: ySS > 1e-9 ? 1 - best.ss / ySS : 0,
      far: Math.hypot(best.ax - cx, best.ay - cy) / rad,
    });
  }
  return model;
}

// Escala pela física: o nível a 1 m de um roteador típico é conhecido a poucos dB (potência de
// transmissão regulamentada, perda no espaço livre a 1 m, antena do celular). Para os rádios fortes
// (roteadores dentro da área levantada), compara o p0 implícito no mapa com o típico. É uma régua
// fraca (dezenas de por cento): as paredes puxam o p0 implícito para baixo.
function physScale(data, X, model, P) {
  const { M, R, F, floorIdx } = data;
  const n = P.physN;
  const ks = [];
  const vals = [];
  const strong = new Set(); // aparelhos fortes: cada um é uma régua independente
  for (let k = 0; k < R; k++) {
    vals.length = 0;
    let peak = -Infinity;
    for (let a = 0; a < M; a++) {
      const v = F[a * R + k];
      if (Number.isNaN(v) || floorIdx[a] !== model.apFloor[k]) continue;
      if (v > peak) peak = v;
      const d2 = (X[2 * a] - model.ax[k]) ** 2 + (X[2 * a + 1] - model.ay[k]) ** 2 + P.apDz * P.apDz;
      vals.push(v + 5 * n * Math.log10(Math.max(0.25, d2)));
    }
    if (vals.length < 8 || peak < P.physMinPeak) continue;
    vals.sort((p, q) => p - q);
    const p0 = vals[Math.floor(P.physQ * (vals.length - 1))];
    // Em 5 GHz a perda no espaço livre a 1 m é ~6,5 dB maior que em 2,4 GHz.
    const nominal = P.physP0 - (data.radios[k].band === 0 ? 0 : 6.5);
    ks.push(Math.pow(10, (nominal - p0) / (10 * n)));
    strong.add(data.radios[k].device);
  }
  if (!ks.length) return null;
  ks.sort((p, q) => p - q);
  return { k: ks[ks.length >> 1], devices: strong.size };
}

// ---------------------------------------------------------------------------
// Refino: campos latentes + movimento
// ---------------------------------------------------------------------------

// Custo minimizado sobre as posições dos nós (L-BFGS), com o modelo físico reajustado a cada rodada:
//   dados      Σ peso · Huber( nível − [média física(x) + resíduo previsto pelos OUTROS nós perto de x] )
//              (um rádio não ouvido só custa se o campo prevê sinal acima do limiar de detecção);
//   movimento  barreira acima de vmax · tempo, mola no passo típico, vizinhança entre pontos marcados.
// Depois de cada rodada a escala é reposta (passo de quem anda + física): o termo dos dados sozinho
// prefere mapas inflados, porque pontos afastados não precisam se explicar.
function refineFields(data, X0, P) {
  const { M, R, F, cnt, NF, censored } = data;
  const fi = data.floorIdx;
  const edges = data.edges;
  const obs = new Float64Array(M * R); // nível observado (ou o limiar, se não ouvido)
  const wgt = new Float64Array(M * R);
  const miss = new Uint8Array(M * R);
  for (let q = 0; q < M * R; q++) {
    if (Number.isNaN(F[q])) {
      obs[q] = censored;
      wgt[q] = P.missW;
      miss[q] = 1;
    } else {
      obs[q] = F[q];
      wgt[q] = Math.min(WEIGHT_CAP, cnt[q]);
    }
  }
  const s2 = P.sigma * P.sigma;
  const cut = 2.5 * P.sigma; // além disto o erro cresce linearmente (leituras aberrantes pesam menos)
  const val = new Float64Array(M * R); // resíduo usado como vizinho
  const own = new Float64Array(M * R); // resíduo usado no próprio custo
  const flow = new Uint8Array(M * R); // o resíduo de vizinho depende da posição (pela média física)?
  const mgx = new Float64Array(M * R); // gradiente da média física
  const mgy = new Float64Array(M * R);
  const num = new Float64Array(M * R);
  const den = new Float64Array(M * R);
  const g1 = new Float64Array(M * R); // d custo / d num
  const gv = new Float64Array(M * R); // d custo / d resíduo
  const pred = new Float64Array(M * R);
  const Wm = new Float64Array(M * M);
  // Sem nenhum trecho cronometrado (um ponto marcado a cada 30 s): o relógio não serve de régua.
  const sparse = !edges.some((e) => e.informative);
  // Levantamento andando (a maioria das varreduras em movimento): cada nó é uma varredura só, borrada
  // pelo deslocamento durante a varredura e pelo corpo do usuário; pede campos mais lisos.
  let movingScans = 0;
  for (let i = 0; i < data.n; i++) if (data.view.spot[i] === null) movingScans++;
  const walking = movingScans > 0.7 * data.n;
  let model = null;
  let inv2h2 = 1;
  let hopScale = 1;

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
        const dx = xa - model.ax[k];
        const dy = ya - model.ay[k];
        const d2 = dx * dx + dy * dy + model.h2[k * NF + f];
        const m = model.p0[k * NF + f] - 5 * model.n[k] * Math.log10(d2);
        const gfac = (-10 * model.n[k]) / (LOG10 * d2);
        mgx[q] = gfac * dx;
        mgy[q] = gfac * dy;
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
    // Somas do núcleo (só entre nós do mesmo andar: paredes e sombra mudam de um andar para o outro).
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
        if (w < KERNEL_CUTOFF) continue;
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
      gv[q] = dc;
    }
    // Gradiente pelas posições (pesos do núcleo) e pelos resíduos dos vizinhos.
    for (let a = 0; a < M; a++) {
      for (let b = a + 1; b < M; b++) {
        const w = Wm[a * M + b];
        if (w < KERNEL_CUTOFF) continue;
        const ra = a * R;
        const rb = b * R;
        let dw = 0;
        for (let k = 0; k < R; k++) {
          const ga = g1[ra + k];
          const gb = g1[rb + k];
          const wa = wgt[ra + k];
          const wb = wgt[rb + k];
          dw += ga * wb * (val[rb + k] - pred[ra + k]) + gb * wa * (val[ra + k] - pred[rb + k]);
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
    // Cadeia pela média física: d resíduo / dx = −∇m.
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
    // Movimento.
    for (const e of edges) {
      const dx = X[2 * e.a] - X[2 * e.b];
      const dy = X[2 * e.a + 1] - X[2 * e.b + 1];
      const d = Math.sqrt(dx * dx + dy * dy) + 1e-9;
      let f = 0;
      const lim = P.vmax * e.tmax;
      if (d > lim) {
        const ex = (d - lim) / P.motionSlack;
        c += 0.5 * P.motionW * ex * ex;
        f += (P.motionW * ex) / P.motionSlack / d;
      }
      if (e.informative) {
        const d0 = P.walkSpeed * e.texp;
        const sd = P.springSigma * e.texp + 0.2;
        const ex = (d - d0) / sd;
        const w = ex < 0 ? P.springW * P.springShort : P.springW;
        c += 0.5 * w * ex * ex;
        f += (w * ex) / sd / d;
      } else if (e.spots) {
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
    return c;
  };

  const X = Float64Array.from(X0);
  // Primeiro passo do L-BFGS: ~0,3 m por coordenada.
  const firstStep = (norm, size) => 0.3 / (norm / Math.sqrt(size) + 1e-12);
  const radius0 = radiusOf(X);
  for (let o = 0; o < P.outer; o++) {
    if (now() > P.deadline) break; // sem tempo: fica com o que já tem
    if (NF > 1 && o > 0 && o <= P.registerRounds) registerFloors(data, X);
    // Largura do núcleo: proporcional ao espaçamento típico entre nós do mesmo andar (com poucos
    // pontos por metro quadrado o campo só pode ser aprendido em escala mais grossa).
    const rms = radiusOf(X);
    const spacing = rms * Math.sqrt((2 * Math.PI * NF) / M);
    const h = Math.max(walking ? P.hMinWalking : P.hMin, Math.min(P.hMax, P.hRel * spacing));
    hopScale = Math.max(0.3, P.orderHop * rms * Math.SQRT2 * Math.sqrt(Math.PI / M));
    model = fitApModels(data, X, P, model, o < 2);
    inv2h2 = 1 / (2 * h * h);
    lbfgs(cost, X, { maxIter: P.inner, deadline: P.deadline, firstStep });
    // Escala: passo de quem anda (quando há) combinado com a física; sem nenhum dos dois, mantém o tamanho.
    const kStep = stepScale(data, X, P);
    const phys = P.physW > 0 ? physScale(data, X, model, P) : null;
    const kPhys = phys ? Math.max(0.4, Math.min(2.5, phys.k)) : null;
    // Com vários roteadores dentro da área a física é bem mais confiável (várias réguas independentes).
    const wPhys = phys && phys.devices >= 3 ? P.physWMulti : P.physW;
    let kk;
    if (kStep != null && kPhys != null) kk = Math.pow(kStep, 1 - wPhys) * Math.pow(kPhys, wPhys);
    else if (kStep != null) kk = kStep;
    else if (kPhys != null) kk = Math.pow(kPhys, P.physDamp); // amortecido: a posição do roteador ainda está mudando
    else kk = sizeRatio(radius0, radiusOf(X));
    if (Number.isFinite(kk) && kk > 0) rescale(X, model, clamp(kk, 1e-3, 1e3));
  }
  model = fitApModels(data, X, P, model, false);
  let physOnly = false;
  if (sparse && P.physW > 0) {
    // Sem relógio, a física é a única régua: aplica o que faltou do último ajuste (os passos acima são amortecidos).
    const phys = physScale(data, X, model, P);
    if (phys) {
      // A física erra por dezenas de por cento; o tamanho típico de uma casa (prior largo) segura os exageros.
      const kPrior = sizeRatio(P.defaultRadius, radiusOf(X));
      const w = phys.devices >= 3 ? Math.max(P.sparsePhysW, P.sparsePhysWMulti) : P.sparsePhysW;
      const kk = Math.pow(Math.max(0.5, Math.min(2, phys.k)), w) * Math.pow(kPrior, 1 - w);
      rescale(X, model, kk);
      model = fitApModels(data, X, P, model, false);
      physOnly = true;
    }
  }

  // Incerteza de cada nó: curvatura do custo dos dados em torno da posição final (os outros nós
  // parados). Campo plano em volta = posição mal determinada.
  const sigma = new Float64Array(M).fill(P.sigmaMax);
  {
    const G = new Float64Array(2 * M);
    cost(X, G); // deixa val[] coerente com as posições finais
    const tmpNum = new Float64Array(R);
    const tmpDen = new Float64Array(R);
    const localCost = (a, xa, ya) => {
      tmpNum.fill(0);
      tmpDen.fill(0);
      const f = fi[a];
      for (let b = 0; b < M; b++) {
        if (b === a || fi[b] !== f) continue;
        const dx = xa - X[2 * b];
        const dy = ya - X[2 * b + 1];
        const w = Math.exp(-(dx * dx + dy * dy) * inv2h2);
        if (w < KERNEL_CUTOFF) continue;
        const rb = b * R;
        for (let k = 0; k < R; k++) {
          const wb = w * wgt[rb + k];
          tmpNum[k] += wb * val[rb + k];
          tmpDen[k] += wb;
        }
      }
      let c = 0;
      for (let k = 0; k < R; k++) {
        const q = a * R + k;
        const dx = xa - model.ax[k];
        const dy = ya - model.ay[k];
        const m = model.p0[k * NF + f] - 5 * model.n[k] * Math.log10(dx * dx + dy * dy + model.h2[k * NF + f]);
        let e = obs[q] - m - tmpNum[k] / (tmpDen[k] + P.lambda);
        if (miss[q] && e > 0) e = 0;
        const ae = Math.abs(e);
        c += ae <= cut ? (wgt[q] * e * e) / (2 * s2) : (wgt[q] * (cut * ae - 0.5 * cut * cut)) / s2;
      }
      return c;
    };
    const step = P.probeStep;
    const minCurv = 1 / (P.sigmaMax * P.sigmaMax);
    for (let a = 0; a < M; a++) {
      const xa = X[2 * a];
      const ya = X[2 * a + 1];
      const c0 = localCost(a, xa, ya);
      const hxx = (localCost(a, xa + step, ya) + localCost(a, xa - step, ya) - 2 * c0) / (step * step);
      const hyy = (localCost(a, xa, ya + step) + localCost(a, xa, ya - step) - 2 * c0) / (step * step);
      // Variância por eixo ~ 1/curvatura (com piso: curvatura nula ou negativa = "não sei").
      sigma[a] = Math.min(P.sigmaMax, Math.sqrt(1 / Math.max(hxx, minCurv) + 1 / Math.max(hyy, minCurv)));
    }
  }
  data.sigma = sigma;
  data.model = model;
  data.scaleSource = sparse ? (physOnly ? 'fisica' : 'nenhuma') : 'passo';
  return X;
}

// Muda a escala do mapa inteiro (em torno da origem): nós e roteadores juntos.
function rescale(X, model, k) {
  // Fator fora do comum (só acontece com mapa degenerado): em torno do CENTRO dos nós, para um mapa
  // quase colapsado longe da origem não ser arremessado para mais longe ainda.
  if (k > 10 || k < 0.1) {
    const { cx, cy } = flatCloudStats(X, X.length / 2);
    for (let q = 0; q < X.length; q += 2) {
      X[q] -= cx;
      X[q + 1] -= cy;
    }
    if (model) {
      for (let q = 0; q < model.ax.length; q++) {
        model.ax[q] -= cx;
        model.ay[q] -= cy;
      }
      for (const d of model.devs) {
        d.ax -= cx;
        d.ay -= cy;
      }
    }
  }
  for (let q = 0; q < X.length; q++) X[q] *= k;
  if (!model) return;
  for (let q = 0; q < model.ax.length; q++) {
    model.ax[q] *= k;
    model.ay[q] *= k;
  }
  for (const d of model.devs) {
    d.ax *= k;
    d.ay *= k;
  }
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

function finish(data, X, solved, P) {
  const { view, n, nodeOfScan } = data;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = X[2 * nodeOfScan[i]];
    py[i] = X[2 * nodeOfScan[i] + 1];
  }
  // Andando, as leituras de uma varredura são mais velhas que o meio dela (2,4 GHz é ouvido primeiro):
  // a posição estimada é a de um instante anterior. Avança ao longo do caminho até o meio da varredura.
  const x = Float64Array.from(px);
  const y = Float64Array.from(py);
  if (solved && P.shiftGain > 0) {
    for (let i = 0; i < n; i++) {
      if (view.spot[i] !== null) continue;
      const lag = (view.meanAgeS[i] - SWEEP_MID_S) * P.shiftGain;
      if (!(lag > 0)) continue;
      let vx = 0;
      let vy = 0;
      let wsum = 0;
      // Velocidade local: trechos vizinhos no mesmo andar; o seguinte pesa mais (é para lá que o usuário vai).
      for (const [p, q, w] of [[i, i + 1, 2], [i - 1, i, 1]]) {
        if (p < 0 || q >= n) continue;
        const dt = view.time[q] - view.time[p];
        if (!(dt > 0.5 && dt < 8) || view.floor[p] !== view.floor[q]) continue;
        vx += (w * (px[q] - px[p])) / dt;
        vy += (w * (py[q] - py[p])) / dt;
        wsum += w;
      }
      if (wsum > 0) {
        x[i] += (vx / wsum) * lag;
        y[i] += (vy / wsum) * lag;
      }
    }
  }
  const conf = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = finite(x[i]);
    y[i] = finite(y[i]);
    if (!solved) continue;
    // Confiança: cai com a incerteza local; leituras escassas valem menos.
    const sig = data.sigma ? data.sigma[nodeOfScan[i]] : P.sigmaMax;
    let c = 1 / (1 + (sig / P.confSigma) ** 2);
    if (view.fresh[i] < 3) c *= view.fresh[i] / 3;
    conf[i] = Math.max(0, Math.min(1, finite(c)));
  }

  // Roteadores: posição e curva do modelo físico ajustado (BSSIDs do mesmo aparelho ficam juntos).
  const aps = {};
  const model = solved ? data.model : null;
  if (model) {
    const devOf = new Map();
    for (const d of model.devs) for (const k of d.radios) devOf.set(k, d);
    for (let k = 0; k < data.R; k++) {
      const d = devOf.get(k);
      let heard = 0; // nós em que o rádio foi ouvido
      for (let a = 0; a < data.M; a++) heard += data.cnt[a * data.R + k];
      if (!d || heard < 3) continue; // ouvido poucas vezes: não dá para situar
      const f = model.apFloor[k];
      const nExp = model.n[k];
      const p0 = model.p0[k * data.NF + f];
      if (![model.ax[k], model.ay[k], p0, nExp].every(Number.isFinite)) continue;
      // Confiança: quanto a curva explica, quantas leituras, e se a fonte ficou dentro da área levantada
      // (um vizinho distante só tem direção; a distância dele é quase livre).
      let c = Math.max(0, Math.min(1, d.explained)) * Math.min(1, heard / 30);
      if (d.far > 1.5) c *= 1.5 / d.far;
      const ap = { x: model.ax[k], y: model.ay[k], z: data.floorList[f] * FLOOR_HEIGHT + 1, p0, n: nExp, conf: Math.max(0, Math.min(1, finite(c))) };
      for (const id of data.radios[k].ids) aps[id] = ap;
    }
  }

  // Confiança na escala: passo cronometrado > só física > nada.
  const scaleConf = !solved ? 0 : data.scaleSource === 'passo' ? 0.5 : data.scaleSource === 'fisica' ? 0.25 : 0.05;
  return { x, y, conf, aps, scaleConf };
}
