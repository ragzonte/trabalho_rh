// Mapa 3D só com Wi-Fi — solucionador "field" (campos de sinal latentes, família WiFi-SLAM / GP-LVM).
//
// Entrada: as varreduras de uma caminhada (níveis em dBm de cada rede, sem GPS, câmera ou bússola).
// Saída: onde cada varredura foi feita e onde estão os roteadores (types.js -> MapSolution).
//
// A ideia: a posição de cada varredura é uma variável latente e o nível de cada rádio é uma função
// lisa e desconhecida da posição (um "campo"). Procuramos as posições que tornam todos os campos
// coerentes ao mesmo tempo: quem passa duas vezes pelo mesmo lugar ouve quase a mesma coisa, então
// as visitas repetidas se atraem sozinhas (o fechamento de circuito sai de graça).
//
// Etapas:
//   1. prepare        junta os BSSIDs do mesmo rádio (aparelho + faixa), separa leituras frescas das
//                     repetidas pelo Android e cria um "nó" por ponto marcado ou varredura andando;
//   2. embedUnfolded  imersão inicial "desdobrada" (tipo Isomap): só os pares de impressões digitais
//                     parecidas são confiáveis; as distâncias longas saem do caminho mais curto num
//                     grafo (vizinhos parecidos + a sequência da caminhada);
//   3. refineFields   refino: para cada rádio, média física (queda com a distância até uma fonte
//                     estimada) + resíduo liso aprendido das OUTRAS varreduras (regressão por núcleo
//                     deixando o próprio ponto de fora, para um ponto não se explicar sozinho), mais
//                     as restrições de movimento (ninguém anda a mais de ~0,9 m/s; passos parecidos);
//   4. escala         o Wi-Fi sozinho quase não mede metros: a régua principal é o passo de quem anda
//                     (tempo x velocidade típica), com uma ajuda fraca da física (nível típico a 1 m);
//   5. finish         saída: pontos, roteadores, confiança, calibração do usuário (knownDistances).
//
// Tudo é determinístico (nenhum sorteio) e sem dependências: roda num Web Worker do celular.

import { FLOOR_HEIGHT } from '../types.js';

// ---------------------------------------------------------------------------
// Constantes físicas e de comportamento (com a justificativa de cada uma)
// ---------------------------------------------------------------------------

/** A posição de uma varredura é a do meio dela: a lista chega ~1,35 s depois (varredura de ~2,5 s). */
const SWEEP_MID_S = 1.35;
/** Leitura mais velha que isto é repetição do Android: descreve um lugar anterior e é ignorada. */
const FRESH_MS = 3400;
/** Um rádio que não apareceu está abaixo do limiar de detecção observado, com esta folga (dB). */
const CENSOR_MARGIN_DB = 2;
/** Peso máximo de um nó por rádio (um ponto marcado tem várias varreduras; depois de 2 o ganho é pequeno). */
const WEIGHT_CAP = 2;
const LOG10 = Math.log(10);

// Ajustes do método. Os que têm unidade física são priors largos (valem para casas e celulares
// diferentes); os demais são pesos relativos, escolhidos no conjunto de desenvolvimento.
const TUNING = {
  // --- tempo e tamanho do problema ---
  budgetShare: 0.55, // fração do tempo permitido que a otimização pode gastar
  maxNodes: 300, // acima disto as varreduras são raleadas (o custo cresce com o quadrado)
  // --- movimento ---
  walkSpeed: 0.45, // m/s: corda média entre varreduras de quem anda devagar olhando o celular (com quinas e paradas)
  sizeGamma: 0, // expoente: velocidade de corda ~ (raio do mapa / sizeRef)^gamma
  sizeRef: 2.8, // m
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
  inner: 40, // iterações de L-BFGS por rodada
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
  physN: 2.2, // expoente em visada quase direta
  physQ: 0.85, // quantil: as leituras mais fortes para a distância são as com menos parede
  physP0: -43, // dBm a 1 m em 2,4 GHz: ~20 dBm de EIRP, 40 dB de espaço livre, ~18 dB do celular, alguma obstrução
  physMinPeak: -52, // só rádios que chegam fortes (roteador dentro da área levantada)
  physDamp: 0.7,
  sparsePhysW: 0.65, // sem relógio: peso (em log) da física contra o raio típico de uma casa
  // --- saída ---
  shiftGain: 0.5, // fração do atraso das leituras compensada ao longo do caminho
  probeStep: 0.5, // m: passo da sonda de curvatura (incerteza de cada ponto)
  sigmaMax: 4, // m: incerteza máxima atribuída a um ponto
  confSigma: 0.8, // m: incerteza em que a confiança de um ponto cai para a metade
};

const now = () => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now());

/**
 * Resolve o mapa: posição de cada varredura e de cada roteador.
 * @param {import('../types.js').Survey} survey
 * @param {{seed?: number, budgetMs?: number, onProgress?: (fraction: number, stage: string) => void, params?: object}} [options]
 *        `params` sobrepõe os ajustes internos (só para desenvolvimento).
 * @returns {import('../types.js').MapSolution}
 */
export function solve(survey, options) {
  try {
    return solveInner(survey || {}, options || {});
  } catch (err) {
    // Nunca lança: na dúvida devolve "não sei" (tudo no centro, confiança zero).
    return collapsed(survey, String((err && err.stack) || err));
  }
}

function collapsed(survey, error) {
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : [];
  return {
    points: scans.map((s) => ({ x: 0, y: 0, z: floorOf(s) * FLOOR_HEIGHT, conf: 0 })),
    aps: {},
    scaleConf: 0,
    debug: error ? { error } : {},
  };
}

function floorOf(scan) {
  const f = Math.round(Number(scan && scan.floor));
  return Number.isFinite(f) ? f : 0;
}

function solveInner(survey, options) {
  const started = now();
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : 4000;
  const P = { ...TUNING, ...(options.params || {}) };
  P.deadline = started + P.budgetShare * budgetMs;
  const progress = (fraction, stage) => {
    if (typeof options.onProgress !== 'function') return;
    try {
      options.onProgress(Math.max(0, Math.min(1, fraction)), stage);
    } catch (_) {
      // um erro de quem escuta o progresso não derruba a solução
    }
  };

  const scans = cleanScans(survey);
  if (!scans.length) return { points: [], aps: {}, scaleConf: 0 };
  progress(0.02, 'preparando');

  // Levantamento enorme: resolve um subconjunto de nós e interpola o resto no tempo.
  const kept = chooseScans(scans, P.maxNodes);
  const data = prepare(kept.map((i) => scans[i]), survey.aps || {});
  const dbg = {};
  let X = new Float64Array(2 * data.M);
  let solved = false;
  if (data.M >= 3 && data.R >= 1) {
    data.edges = motionEdges(data);
    X = embedUnfolded(data, P);
    progress(0.25, 'esboço inicial');
    // Escala provisória: passo de quem anda, ou o raio de uma casa típica.
    const k0 = stepScale(data, X, P) ?? P.defaultRadius / Math.max(1e-9, radiusOf(X));
    for (let q = 0; q < X.length; q++) X[q] *= k0;
    X = refineFields(data, X, P, dbg, progress);
    solved = true;
  }
  progress(0.95, 'finalizando');
  const out = finish(survey, scans, kept, data, X, solved, P);
  out.debug = dbg;
  if (P.keepData) {
    dbg.data = data;
    dbg.X = X;
  }
  progress(1, 'pronto');
  return out;
}

// ---------------------------------------------------------------------------
// Preparação
// ---------------------------------------------------------------------------

// Cópia saneada das varreduras: tempo finito e crescente, andar inteiro, leituras válidas.
function cleanScans(survey) {
  const raw = Array.isArray(survey.scans) ? survey.scans : [];
  const out = [];
  let lastT = 0;
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] || {};
    let t = Number(s.t);
    if (!Number.isFinite(t)) t = i === 0 ? 0 : lastT + 3.5;
    lastT = t;
    const readings = [];
    let ageSum = 0;
    let ageN = 0;
    for (const r of Array.isArray(s.readings) ? s.readings : []) {
      if (!r || r.id == null || !Number.isFinite(r.rssi)) continue;
      const ageMs = Number.isFinite(r.ageMs) ? r.ageMs : null;
      const fresh = ageMs == null || ageMs <= FRESH_MS;
      readings.push({ id: String(r.id), rssi: r.rssi, freq: Number(r.freq) || 0, fresh });
      if (fresh && ageMs != null) {
        ageSum += ageMs / 1000;
        ageN++;
      }
    }
    out.push({
      t,
      floor: floorOf(s),
      still: !!s.still,
      spot: s.spot == null ? null : s.spot,
      label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : null,
      readings,
      meanAge: ageN ? ageSum / ageN : SWEEP_MID_S,
    });
  }
  return out;
}

// Quais varreduras entram na otimização. Um nó = um ponto marcado (todas as varreduras dele) ou uma
// varredura andando. Ficam de fora (e depois são interpoladas no tempo):
//   - nós sem nenhuma leitura fresca: não dizem nada sobre o lugar (não é o mesmo que "nada ouvido");
//   - com nós demais, todos menos um a cada `stride` (uniforme ao longo da caminhada).
function chooseScans(scans, maxNodes) {
  const nodeOf = new Int32Array(scans.length);
  const spotNode = new Map();
  const hasData = [];
  for (let i = 0; i < scans.length; i++) {
    const s = scans[i];
    let a;
    if (s.spot != null && spotNode.has(s.spot)) a = spotNode.get(s.spot);
    else {
      a = hasData.length;
      hasData.push(false);
      if (s.spot != null) spotNode.set(s.spot, a);
    }
    nodeOf[i] = a;
    if (!hasData[a]) hasData[a] = s.readings.some((r) => r.fresh);
  }
  // Numeração só dos nós com dados, para o raleamento ficar uniforme.
  const rank = new Int32Array(hasData.length).fill(-1);
  let count = 0;
  for (let a = 0; a < hasData.length; a++) if (hasData[a]) rank[a] = count++;
  const stride = Math.max(1, Math.ceil(count / maxNodes));
  const kept = [];
  for (let i = 0; i < scans.length; i++) {
    const r = rank[nodeOf[i]];
    if (r >= 0 && r % stride === 0) kept.push(i);
  }
  return kept;
}

// Rádios (aparelho + faixa), nós e a impressão digital de cada nó.
function prepare(scans, apMeta) {
  const radioIndex = new Map();
  const radios = [];
  const idRadio = new Map();
  for (const s of scans) {
    for (const r of s.readings) {
      if (idRadio.has(r.id)) continue;
      const meta = apMeta[r.id] || {};
      const freq = Number(meta.freq) || r.freq || 2437;
      const band = freq < 3000 ? 0 : freq < 5925 ? 1 : 2;
      // BSSIDs do mesmo rádio (rede principal e de convidados) ouvem quase o mesmo: viram uma coluna só.
      const device = meta.device != null ? String(meta.device) : r.id;
      const key = `${device}|${band}`;
      let k = radioIndex.get(key);
      if (k === undefined) {
        k = radios.length;
        radioIndex.set(key, k);
        radios.push({ device, band, ids: [] });
      }
      idRadio.set(r.id, k);
      radios[k].ids.push(r.id);
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
      nodes.push({ scans: [], floor: s.floor, spot: s.spot });
      if (s.spot != null) spotNode.set(s.spot, a);
    }
    nodes[a].scans.push(i);
    nodeOfScan[i] = a;
  });
  const M = nodes.length;

  // Impressão digital de cada nó: média das leituras frescas de cada rádio (NaN = não ouvido).
  const F = new Float64Array(M * R).fill(NaN);
  const cnt = new Float64Array(M * R);
  const sum = new Float64Array(M * R);
  const levels = [];
  const acc = new Map();
  scans.forEach((s, i) => {
    const a = nodeOfScan[i];
    acc.clear();
    for (const r of s.readings) {
      if (!r.fresh) continue;
      const k = idRadio.get(r.id);
      const e = acc.get(k) || [0, 0];
      e[0] += r.rssi;
      e[1]++;
      acc.set(k, e);
      levels.push(r.rssi);
    }
    for (const [k, e] of acc) {
      sum[a * R + k] += e[0] / e[1];
      cnt[a * R + k]++;
    }
  });
  for (let q = 0; q < M * R; q++) if (cnt[q] > 0) F[q] = sum[q] / cnt[q];
  // Limiar de detecção deste celular: as leituras mais fracas que ele chegou a entregar.
  levels.sort((p, q) => p - q);
  const floorLevel = levels.length ? levels[Math.floor(levels.length * 0.03)] : -90;
  const censored = floorLevel - CENSOR_MARGIN_DB;

  // Andares e nível médio de cada rádio por andar (a laje entra como um deslocamento por andar).
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
        s += Number.isNaN(v) ? censored : v;
        c++;
      }
      floorMean[k * NF + f] = c ? s / c : floorLevel;
    }
  }
  return { scans, nodes, nodeOfScan, radios, idRadio, R, M, F, cnt, floorLevel, censored, floorList, NF, floorIdx, floorNodes, floorMean };
}

// ---------------------------------------------------------------------------
// Movimento
// ---------------------------------------------------------------------------

// Tempo em que o usuário pôde andar entre duas varreduras seguidas (s): [esperado, máximo].
// A posição de uma varredura é a do meio dela (~1,35 s antes da entrega). Quem marca um ponto fica
// parado desde antes do começo da varredura (~3 s antes da entrega) até pouco depois dela.
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
    edges.push({
      a,
      b,
      texp,
      tmax,
      informative: tmax <= 8, // só os intervalos curtos dizem algo sobre a distância percorrida
      spots: scans[i - 1].still && scans[i].still,
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
  const k = (P.walkSpeed * st) / sd;
  if (!(P.sizeGamma > 0)) return k;
  // Em casa pequena o caminho tem mais quinas e paradas por metro (corda mais curta); em área grande
  // anda-se mais reto. A velocidade de corda esperada cresce devagar com o raio do mapa (ponto fixo fechado).
  const r0 = radiusOf(X);
  if (!(r0 > 0)) return k;
  return Math.pow(k * Math.pow(r0 / P.sizeRef, P.sizeGamma), 1 / (1 - P.sizeGamma));
}

// Raio quadrático médio dos nós em torno do centro.
function radiusOf(X) {
  const n = X.length / 2;
  if (!n) return 0;
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

// ---------------------------------------------------------------------------
// Imersão inicial "desdobrada"
// ---------------------------------------------------------------------------

// A distância entre impressões digitais satura depois de poucos metros (paredes, rádios que somem),
// então um MDS direto dobra a casa sobre si mesma. Aqui só os pares vizinhos são usados como estão;
// as distâncias longas são o caminho mais curto num grafo de vizinhança (k nós mais parecidos + a
// própria sequência da caminhada). O refino tolera bastante ruído local, mas não uma planta dobrada.
function embedUnfolded(data, P) {
  const { M, R, F, NF, floorIdx, censored, scans, nodeOfScan, nodes } = data;
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
  for (let i = 0; i < scans.length; i++) if (seq[seq.length - 1] !== nodeOfScan[i]) seq.push(nodeOfScan[i]);
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
  const INF = 1e30;
  const Gd = new Float64Array(M * M).fill(INF);
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
  // MDS métrico sobre as distâncias geodésicas; pares próximos pesam mais (1/d²).
  let maxFinite = 0;
  for (let q = 0; q < M * M; q++) if (Gd[q] < INF && Gd[q] > maxFinite) maxFinite = Gd[q];
  if (!(maxFinite > 0)) return spiral(M); // todas as impressões digitais iguais: nada a desdobrar
  const Wt = new Float64Array(M * M);
  for (let q = 0; q < M * M; q++) {
    if (Gd[q] >= INF) Gd[q] = 1.5 * maxFinite; // componentes soltas: longe
    Wt[q] = Gd[q] > 0 ? 1 / (Gd[q] * Gd[q] + 1e-6 * maxFinite * maxFinite) : 0;
  }
  for (let a = 0; a < M; a++) Wt[a * M + a] = 0;
  return smacof(classicalMds(Gd, M), Gd, Wt, M, P.smacofIters);
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

// MDS clássico: dois maiores autovetores da matriz de distâncias duplamente centrada
// (iteração de subespaço com partida fixa, para o resultado se repetir).
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
  const { M, R, NF, floorIdx, scans, nodeOfScan } = data;
  if (NF < 2) return;
  const count = data.floorNodes;
  let ref = 0;
  for (let f = 1; f < NF; f++) if (count[f] > count[ref]) ref = f;
  const done = new Set([ref]);
  const todo = [];
  for (let f = 0; f < NF; f++) if (f !== ref) todo.push(f);
  todo.sort((p, q) => Math.abs(p - ref) - Math.abs(q - ref));
  const ties = []; // trocas de andar ao longo da caminhada
  for (let i = 1; i < scans.length; i++) {
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
function fitApModels(data, X, P, prev) {
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
    for (const dz of dzs) for (const c of cand) tryAt(c[0], c[1], dz);
    const before = prev && prev.devs.find((d) => d.device === dev);
    if (before) tryAt(before.ax, before.ay, before.dz);
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
  }
  if (!ks.length) return null;
  ks.sort((p, q) => p - q);
  return ks[ks.length >> 1];
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
function refineFields(data, X0, P, dbg, progress) {
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
  for (const s of data.scans) if (s.spot == null) movingScans++;
  const walking = movingScans > 0.7 * data.scans.length;
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
      gv[q] = dc;
    }
    // Gradiente pelas posições (pesos do núcleo) e pelos resíduos dos vizinhos.
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

  let X = Float64Array.from(X0);
  const hist = [];
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
    model = fitApModels(data, X, P, model);
    inv2h2 = 1 / (2 * h * h);
    (dbg.h ||= []).push(h);
    const r = lbfgs(cost, X, P.inner, P.deadline);
    X = r.x;
    hist.push(r.f);
    // Escala: passo de quem anda (quando há) combinado com a física; sem nenhum dos dois, mantém o tamanho.
    const kStep = stepScale(data, X, P);
    let kPhys = P.physW > 0 ? physScale(data, X, model, P) : null;
    if (kPhys != null) kPhys = Math.max(0.4, Math.min(2.5, kPhys));
    let kk;
    if (kStep != null && kPhys != null) kk = Math.pow(kStep, 1 - P.physW) * Math.pow(kPhys, P.physW);
    else if (kStep != null) kk = kStep;
    else if (kPhys != null) kk = Math.pow(kPhys, P.physDamp); // amortecido: a posição do roteador ainda está mudando
    else kk = radius0 / Math.max(1e-9, radiusOf(X));
    if (Number.isFinite(kk) && kk > 0) for (let q = 0; q < X.length; q++) X[q] *= kk;
    dbg.scale = { kStep, kPhys, kk };
    progress(0.25 + (0.65 * (o + 1)) / P.outer, 'ajustando os campos de sinal');
  }
  model = fitApModels(data, X, P, model);
  let physOnly = false;
  if (sparse && P.physW > 0) {
    // Sem relógio, a física é a única régua: aplica o que faltou do último ajuste (os passos acima são amortecidos).
    const kPhys = physScale(data, X, model, P);
    if (kPhys != null) {
      // A física erra por dezenas de por cento; o tamanho típico de uma casa (prior largo) segura os exageros.
      const kPrior = P.defaultRadius / Math.max(1e-9, radiusOf(X));
      const kk = Math.pow(Math.max(0.5, Math.min(2, kPhys)), P.sparsePhysW) * Math.pow(kPrior, 1 - P.sparsePhysW);
      for (let q = 0; q < X.length; q++) X[q] *= kk;
      model = fitApModels(data, X, P, model);
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
        if (w < 1e-4) continue;
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
  dbg.costHist = hist;
  return X;
}

// L-BFGS compacto com busca linear por recuo (Armijo). `fn(x, g)` devolve o custo e preenche o gradiente.
function lbfgs(fn, x0, maxIter, deadline, mem = 8) {
  const n = x0.length;
  let x = Float64Array.from(x0);
  let g = new Float64Array(n);
  let f = fn(x, g);
  const S = [];
  const Y = [];
  const rho = [];
  for (let it = 0; it < maxIter; it++) {
    if (now() > deadline) break;
    // Direção de descida (recursão de dois laços).
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
      // Direção ruim: esquece a memória e volta ao gradiente.
      S.length = Y.length = rho.length = 0;
      let gn = 0;
      for (let k = 0; k < n; k++) gn += g[k] * g[k];
      if (gn < 1e-20) break;
      const sc = 0.1 / (Math.sqrt(gn / n) + 1e-12);
      dg = 0;
      for (let k = 0; k < n; k++) {
        q[k] = g[k] * sc;
        dg -= q[k] * g[k];
      }
    }
    let t = 1;
    const xn = new Float64Array(n);
    const gn2 = new Float64Array(n);
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
    if (df < 1e-7 * (1 + Math.abs(f))) break;
  }
  return { x, f };
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

function finish(survey, scans, kept, data, X, solved, P) {
  const n = scans.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const sg = new Float64Array(n).fill(P.sigmaMax);
  const known = new Uint8Array(n);
  kept.forEach((i, q) => {
    const a = data.nodeOfScan[q];
    px[i] = X[2 * a];
    py[i] = X[2 * a + 1];
    if (solved && data.sigma) sg[i] = data.sigma[a];
    known[i] = 1;
  });
  // Varreduras que ficaram de fora (levantamento raleado): interpola no tempo entre as vizinhas resolvidas.
  if (kept.length < n) {
    let prev = -1;
    const nextKnown = new Int32Array(n).fill(-1);
    for (let i = n - 1, nx = -1; i >= 0; i--) {
      if (known[i]) nx = i;
      nextKnown[i] = nx;
    }
    for (let i = 0; i < n; i++) {
      if (known[i]) {
        prev = i;
        continue;
      }
      const nx = nextKnown[i];
      if (prev >= 0 && nx >= 0) {
        const span = scans[nx].t - scans[prev].t;
        const u = span > 0 ? Math.max(0, Math.min(1, (scans[i].t - scans[prev].t) / span)) : 0.5;
        px[i] = px[prev] + (px[nx] - px[prev]) * u;
        py[i] = py[prev] + (py[nx] - py[prev]) * u;
        sg[i] = Math.max(sg[prev], sg[nx]) + 0.5;
      } else {
        const src = prev >= 0 ? prev : nx;
        if (src >= 0) {
          px[i] = px[src];
          py[i] = py[src];
          sg[i] = sg[src] + 1;
        }
      }
    }
    // Varreduras do mesmo ponto marcado dividem a posição (contrato da saída).
    const bySpot = new Map();
    for (let i = 0; i < n; i++) {
      if (scans[i].spot == null) continue;
      if (!bySpot.has(scans[i].spot)) bySpot.set(scans[i].spot, []);
      bySpot.get(scans[i].spot).push(i);
    }
    for (const list of bySpot.values()) {
      let x = 0;
      let y = 0;
      for (const i of list) {
        x += px[i];
        y += py[i];
      }
      for (const i of list) {
        px[i] = x / list.length;
        py[i] = y / list.length;
      }
    }
  }

  // Andando, as leituras de uma varredura são mais velhas que o meio dela (2,4 GHz é ouvido primeiro):
  // a posição estimada é a de um instante anterior. Avança ao longo do caminho até o meio da varredura.
  const outX = Float64Array.from(px);
  const outY = Float64Array.from(py);
  if (solved && P.shiftGain > 0) {
    for (let i = 0; i < n; i++) {
      if (scans[i].spot != null) continue;
      const lag = (scans[i].meanAge - SWEEP_MID_S) * P.shiftGain;
      if (!(lag > 0)) continue;
      let vx = 0;
      let vy = 0;
      let wsum = 0;
      // Velocidade local: trechos vizinhos no mesmo andar; o seguinte pesa mais (é para lá que o usuário vai).
      for (const [p, q, w] of [[i, i + 1, 2], [i - 1, i, 1]]) {
        if (p < 0 || q >= n) continue;
        const dt = scans[q].t - scans[p].t;
        if (!(dt > 0.5 && dt < 8) || scans[p].floor !== scans[q].floor) continue;
        vx += (w * (px[q] - px[p])) / dt;
        vy += (w * (py[q] - py[p])) / dt;
        wsum += w;
      }
      if (wsum > 0) {
        outX[i] += (vx / wsum) * lag;
        outY[i] += (vy / wsum) * lag;
      }
    }
  }

  // Calibração do usuário: distância real entre duas varreduras fixa a escala.
  let scale = 1;
  let calibrated = false;
  const ratios = [];
  for (const kd of Array.isArray(survey.knownDistances) ? survey.knownDistances : []) {
    if (!kd) continue;
    const a = Math.round(Number(kd.a));
    const b = Math.round(Number(kd.b));
    const meters = Number(kd.meters);
    if (!(a >= 0 && a < n && b >= 0 && b < n) || a === b || !(meters > 0)) continue;
    // A medida é no espaço; no mapa conta a parte horizontal.
    const dz = (scans[a].floor - scans[b].floor) * FLOOR_HEIGHT;
    const horizontal = Math.sqrt(Math.max(0, meters * meters - dz * dz));
    const d = Math.hypot(outX[a] - outX[b], outY[a] - outY[b]);
    if (d > 1e-6 && horizontal > 0) ratios.push(horizontal / d);
  }
  if (ratios.length) {
    ratios.sort((p, q) => p - q);
    scale = ratios[ratios.length >> 1];
    calibrated = Number.isFinite(scale) && scale > 0;
    if (!calibrated) scale = 1;
  }

  // Convenção de saída: origem no centro dos pontos, eixo x na direção de maior espalhamento.
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += outX[i];
    cy += outY[i];
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const x = outX[i] - cx;
    const y = outY[i] - cy;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const place = (x, y) => {
    const dx = (x - cx) * scale;
    const dy = (y - cy) * scale;
    return [ca * dx + sa * dy, -sa * dx + ca * dy];
  };
  const finite = (v) => (Number.isFinite(v) ? v : 0);

  const points = scans.map((s, i) => {
    const [x, y] = place(outX[i], outY[i]);
    // Confiança: cai com a incerteza local; leituras escassas valem menos.
    let conf = 0;
    if (solved) {
      const sig = sg[i] * scale;
      conf = 1 / (1 + (sig / P.confSigma) ** 2);
      let fresh = 0;
      for (const r of s.readings) if (r.fresh) fresh++;
      if (fresh < 3) conf *= fresh / 3;
    }
    return { x: finite(x), y: finite(y), z: s.floor * FLOOR_HEIGHT, conf: Math.max(0, Math.min(1, finite(conf))) };
  });

  // Roteadores: posição e curva do modelo físico ajustado (BSSIDs do mesmo aparelho ficam juntos).
  const aps = {};
  const model = solved ? data.model : null;
  if (model) {
    const heardOf = new Map(); // quantas leituras frescas de cada BSSID
    for (const q of kept) for (const r of scans[q].readings) if (r.fresh) heardOf.set(r.id, (heardOf.get(r.id) || 0) + 1);
    const devOf = new Map();
    for (const d of model.devs) for (const k of d.radios) devOf.set(k, d);
    for (const [id, k] of data.idRadio) {
      const d = devOf.get(k);
      const heard = heardOf.get(id) || 0;
      if (!d || heard < 3) continue; // ouvido poucas vezes: não dá para situar
      const f = model.apFloor[k];
      const [x, y] = place(model.ax[k], model.ay[k]);
      const nExp = model.n[k];
      // p0 vale para a escala do mapa: se a escala muda por k, as distâncias mudam por k.
      const p0 = model.p0[k * data.NF + f] + 10 * nExp * Math.log10(scale);
      if (![x, y, p0, nExp].every(Number.isFinite)) continue;
      // Confiança: quanto a curva explica, quantas leituras, e se a fonte ficou dentro da área levantada
      // (um vizinho distante só tem direção; a distância dele é quase livre).
      let conf = Math.max(0, Math.min(1, d.explained)) * Math.min(1, heard / 30);
      if (d.far > 1.5) conf *= 1.5 / d.far;
      aps[id] = { x, y, z: data.floorList[f] * FLOOR_HEIGHT + 1, p0, n: nExp, conf: Math.max(0, Math.min(1, finite(conf))) };
    }
  }

  // Confiança na escala: medida pelo usuário > passo cronometrado > só física > nada.
  let scaleConf = 0;
  if (calibrated) scaleConf = 0.95;
  else if (solved) scaleConf = data.scaleSource === 'passo' ? 0.5 : data.scaleSource === 'fisica' ? 0.25 : 0.05;
  return { points, aps, scaleConf };
}

// (desenvolvimento) acesso às etapas internas para os diagnósticos; sai na versão final.
export const _dev = { TUNING, cleanScans, chooseScans, prepare, motionEdges, embedUnfolded, stepScale, fitApModels, refineFields, finish, lbfgs };
