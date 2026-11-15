// Solucionador "hybrid" do mapa 3D só com Wi-Fi (candidato do torneio).
//
// Do grosso para o fino:
//   1. PREPARO  - junta as redes do mesmo rádio (aparelho + faixa), joga fora as leituras velhas que o
//                 Android repete, e transforma varreduras em "nós" (um ponto marcado = um nó).
//   2. GROSSO   - grafo com "barras" entre nós seguidos no tempo (passo de quem anda, em metros) e
//                 arestas entre nós de impressão digital parecida; a distância entre dois nós é o
//                 caminho mais curto no grafo, com um teto dado pela ordem das impressões digitais, e
//                 o mapa sai de um MDS clássico (Isomap). Os comprimentos que dependem da impressão
//                 digital são calibrados pela densidade do próprio levantamento.
//   3. ESCALA   - nos modos com tempo útil ela vem das barras; no modo de 30 s (sem tempo útil) vem de
//                 um fator a priori misturado com a física do sinal perto dos roteadores da casa.
//   4. FINO     - poucas voltas de refino: aprende o campo de cada rádio (lei de distância + resíduo
//                 suave) com as posições atuais e move cada nó para onde as suas leituras são mais bem
//                 previstas pelos OUTROS nós, com caminho suave. Parar cedo é de propósito: este
//                 critério, levado até o fim, se ajusta ao ruído e deforma o mapa.
//   5. SAÍDA    - roteadores pela lei de distância ajustada, confiança pela curvatura do ajuste.
//
// Tudo é determinístico (não há sorteio) e nenhuma constante de propagação é dada como certa: os
// valores a priori abaixo são largos e só entram onde os dados não decidem.

import { FLOOR_HEIGHT } from '../types.js';

const FRESH_MS = 3300; // leitura mais velha que isto é repetição do Android (descreve um lugar anterior)
const SWEEP_MID_S = 1.3; // a posição da varredura vale no meio da varredura, ~1,3 s antes da entrega
const TRACK_WINDOW_S = 1.8; // uma amostra da rede conectada vale para a varredura cujo meio está a menos disto
const MAX_NODES = 320; // acima disto as varreduras de quem anda são agrupadas (o custo cresce com o cubo)

const DEFAULTS = {
  // --- passo de quem anda (corda entre varreduras seguidas / tempo, m/s) ---
  // Dentro de casa anda-se a 0,4-0,9 m/s com paradas; a corda entre duas varreduras corta as curvas.
  walkSpeed: 0.45,
  walkRms: 0.47,
  leaveSpeed: 0.26, // primeira varredura depois de sair de um ponto marcado: parte do tempo foi parado
  leaveSigma: 0.12,
  arriveSigma: 0.2, // última varredura antes de marcar um ponto: quase sempre já no ponto
  hopRms: 0.35, // pulo entre pontos marcados: corda / (intervalo - tempo perdido parado)
  hopLost: 3.5,
  vMax: 1.2,
  // --- geometria grossa ---
  smoothW: 0.5, // peso dos vizinhos no tempo ao suavizar a impressão digital de quem está andando
  isoK: 5, // vizinhos por impressão digital no grafo
  isoExclude: 3, // não liga por impressão digital quem está a até 3 varreduras no tempo (já há a barra)
  isoKappa: 1.4, // a ordem por impressão digital é ruidosa: o "mais parecido" raramente é o mais próximo
  rankCap: 1.5, // teto de distância pela ordem das impressões digitais (em espaçamentos por raiz do posto)
  isoLen0: 0.8, // sem calibração possível (modo de 30 s): comprimento por posto, em unidades do grafo
  isoLenStep: 0.3,
  isoFree: 2.5, // ponte entre pontos marcados seguidos quando o tempo não informa nada
  // --- escala sem tempo útil (modo de 30 s) ---
  freeScale0: 1.25, // fator a priori entre a unidade do grafo e metros
  physP0: -40, // sinal a 1 m de um roteador doméstico em 2,4 GHz (dBm), a priori largo
  physBandDrop: 6, // 5 GHz chega ~6 dB mais fraco (perda de espaço livre)
  physN: 2.2, // expoente quase de espaço livre de quem está no mesmo cômodo do roteador
  physSpan: 12, // usa os nós até 12 dB abaixo do mais forte
  physMinRssi: -55, // rádio que nunca chega mais forte que isto não é da casa
  physBias: 1.2, // a física por cima do mapa grosso superestima (paredes, posição do roteador)
  physPerRadios: 5, // peso da física = rádios da casa / isto
  physMinRadios: 4, // com menos rádios da casa que isto a física é ruído: fica só o fator a priori
  // --- refino ---
  rounds: 2, // voltas de [lei de distância -> passos de gradiente]; mais que isto começa a deformar
  sweeps: 6,
  kernelH0: 2.0, // largura do núcleo espacial dos campos (m): primeira e última volta
  kernelH: 1.3,
  lambda: 0.5, // encolhimento do resíduo onde há poucos dados (em "leituras equivalentes")
  sigmaNoise: 4.5, // ruído de uma leitura (dB), valor de partida; depois vem do erro de previsão
  sigmaField: 5, // amplitude do resíduo do campo em torno da lei de distância (dB)
  zCap: 3, // resíduo (em desvios) a partir do qual a leitura é tratada como aberrante
  accSigma: 1.0, // desvio típico da "aceleração" entre três varreduras seguidas de quem anda (m)
  freeW: 0.3, // peso do a priori de pulo curto entre pontos marcados no modo de 30 s
  freeScale: 2.5,
  damping: 0.3,
  stepSize: 0.7,
  maxStep: 0.6, // quanto um nó anda por passo, no máximo (m)
  boxMargin: 2.0, // folga da caixa onde se procura a posição dos roteadores (m)
  refineFree: 0, // refinar também o modo de 30 s (na média piora: sem tempo, o refino persegue ruído)
};

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : 0);

/**
 * @param {import('../types.js').Survey} survey
 * @param {{seed?: number, budgetMs?: number, onProgress?: (fraction: number, stage: string) => void, tune?: Object}} [options]
 *        `tune` troca constantes de DEFAULTS (só para experimentos).
 * @returns {import('../types.js').MapSolution}
 */
export function solve(survey, options = {}) {
  try {
    return solveSurvey(survey || {}, options || {});
  } catch (err) {
    return fallbackSolution(survey, err);
  }
}

// Resposta de quem não conseguiu nada: tudo na origem, confiança zero.
function fallbackSolution(survey, err) {
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : [];
  return {
    points: scans.map((s) => ({ x: 0, y: 0, z: (s && Number.isFinite(s.floor) ? Math.round(s.floor) : 0) * FLOOR_HEIGHT, conf: 0 })),
    aps: {},
    scaleConf: 0,
    debug: { error: String((err && err.stack) || err) },
  };
}

function solveSurvey(survey, options) {
  const T = { ...DEFAULTS, ...(options.tune || {}) };
  const started = now();
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : 4000;
  const deadline = started + 0.55 * budgetMs; // o refino para aqui; o resto é rápido
  const progress = (f, label) => {
    if (typeof options.onProgress === 'function') {
      try {
        options.onProgress(f, label);
      } catch {
        // quem escuta o progresso não derruba o cálculo
      }
    }
  };
  const prep = prepare(survey);
  if (prep.N === 0) return { points: [], aps: {}, scaleConf: 0 };
  const keepStages = !!options.tune; // mapas intermediários só para quem está experimentando
  const stages = {};
  const info = {};
  const model = buildModel(prep);
  const timed = model.trans.some((tr) => tr.type !== 'free');

  progress(0.05, 'geometria');
  let X = coarseEmbedding(model, T, info);
  X = coarseScale(model, X, T, info);
  let known = knownScale(prep, survey, X);
  if (known) X = X.map((p) => [p[0] * known, p[1] * known]);
  if (keepStages) stages.coarse = nodePointsToScans(prep, X);

  progress(0.4, 'refino');
  const doRefine = model.M >= 6 && model.active.length >= 2 && (timed || T.refineFree);
  const fit = refineContinuous(model, X, T, {
    rounds: doRefine ? T.rounds : 0,
    sweeps: T.sweeps,
    h0: T.kernelH0,
    h1: T.kernelH,
    deadline,
    info,
    onRound: (r, Xr) => {
      if (keepStages) stages[`r${r + 1}`] = nodePointsToScans(prep, Xr);
      progress(0.4 + (0.45 * (r + 1)) / Math.max(1, T.rounds), 'refino');
    },
  });
  X = fit.X;
  known = knownScale(prep, survey, X);
  if (known) X = X.map((p) => [p[0] * known, p[1] * known]);
  info.heldOut = Number(fit.heldOut.toFixed(3));
  info.sigma = Number(fit.sigmaMean.toFixed(2));

  progress(0.9, 'roteadores');
  const solution = buildOutput(prep, model, X, fit, { timed, known: !!known }, T);
  info.ms = Math.round(now() - started);
  solution.debug = keepStages ? { stages, info } : { info };
  progress(1, 'pronto');
  return solution;
}

// ---------------------------------------------------------------------------
// Preparo
// ---------------------------------------------------------------------------

function prepare(survey) {
  const scans = Array.isArray(survey.scans) ? survey.scans : [];
  const N = scans.length;
  const meta = survey.aps && typeof survey.aps === 'object' ? survey.aps : {};
  // Rádio = aparelho + faixa: as redes de um mesmo rádio (principal e convidados) medem o mesmo campo.
  const radioIndex = new Map();
  const radios = [];
  const radioOfId = new Map();
  const bandOf = (freq) => (freq < 3000 ? 0 : freq < 5925 ? 1 : 2);
  const radioFor = (id, freq) => {
    let k = radioOfId.get(id);
    if (k !== undefined) return k;
    const m = meta[id];
    const f = (m && Number.isFinite(m.freq) && m.freq) || (Number.isFinite(freq) && freq) || 2437;
    const device = (m && m.device) || `bssid:${id}`;
    const key = `${device}|${bandOf(f)}`;
    k = radioIndex.get(key);
    if (k === undefined) {
      k = radios.length;
      radioIndex.set(key, k);
      radios.push({ device, band: bandOf(f), ids: [] });
    }
    radios[k].ids.push(id);
    radioOfId.set(id, k);
    return k;
  };
  const t = new Float64Array(N);
  const floor = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const s = scans[i] || {};
    // Tempo sempre crescente (se vier faltando ou fora de ordem, assume o intervalo livre de 3,5 s).
    const prev = i > 0 ? t[i - 1] : 0;
    t[i] = Number.isFinite(s.t) && (i === 0 || s.t >= prev) ? s.t : i > 0 ? prev + 3.5 : 0;
    floor[i] = Number.isFinite(s.floor) ? Math.round(s.floor) : 0;
    for (const r of Array.isArray(s.readings) ? s.readings : []) if (r && r.id != null && Number.isFinite(r.rssi)) radioFor(r.id, r.freq);
  }
  // Sinal da rede conectada entre as varreduras: cada amostra reforça a leitura daquele rádio na
  // varredura cujo meio fica a menos de TRACK_WINDOW_S dela (a pessoa quase não saiu do lugar).
  const track = [];
  for (const s of Array.isArray(survey.track) ? survey.track : []) {
    if (!s || s.id == null || !Number.isFinite(s.rssi) || !Number.isFinite(s.t)) continue;
    track.push({ t: s.t, k: radioFor(s.id, undefined), rssi: s.rssi });
  }
  const K = radios.length;
  const obs = new Float64Array(N * K).fill(NaN); // média das leituras frescas do rádio na varredura
  let lowest = -80;
  const sum = new Float64Array(N * K);
  const cnt = new Float64Array(N * K);
  for (let i = 0; i < N; i++) {
    const s = scans[i] || {};
    for (const r of Array.isArray(s.readings) ? s.readings : []) {
      if (!r || r.id == null || !Number.isFinite(r.rssi)) continue;
      // Leitura velha = repetição de uma varredura anterior: o lugar dela é outro e ela já foi contada lá.
      if (Number.isFinite(r.ageMs) && r.ageMs > FRESH_MS) continue;
      const k = radioOfId.get(r.id);
      sum[i * K + k] += r.rssi;
      cnt[i * K + k]++;
      if (r.rssi < lowest) lowest = r.rssi;
    }
  }
  if (N > 0) {
    track.sort((p, q) => p.t - q.t);
    let i = 0;
    for (const s of track) {
      while (i + 1 < N && Math.abs(t[i + 1] - SWEEP_MID_S - s.t) <= Math.abs(t[i] - SWEEP_MID_S - s.t)) i++;
      if (Math.abs(t[i] - SWEEP_MID_S - s.t) > TRACK_WINDOW_S) continue;
      sum[i * K + s.k] += s.rssi;
      cnt[i * K + s.k]++;
    }
  }
  for (let i = 0; i < N * K; i++) if (cnt[i] > 0) obs[i] = sum[i] / cnt[i];
  const missLevel = Math.max(-97, Math.min(-88, lowest + 1)); // abaixo disto o celular não ouve

  // Nó = uma posição a descobrir. Varreduras seguidas no mesmo ponto marcado viram um nó só; em
  // levantamentos enormes, varreduras seguidas de quem anda também são agrupadas (a posição de cada
  // uma sai depois por interpolação no tempo).
  let walking = 0;
  let spots = 0;
  for (let i = 0; i < N; i++) {
    const s = scans[i] || {};
    if (s.spot == null) walking++;
    else if (i === 0 || (scans[i - 1] || {}).spot !== s.spot) spots++;
  }
  const group = Math.max(1, Math.ceil(walking / Math.max(1, MAX_NODES - spots)));
  const nodes = [];
  const nodeOf = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const s = scans[i] || {};
    const spot = s.spot == null ? null : s.spot;
    const last = nodes[nodes.length - 1];
    const lastI = last ? last.scans[last.scans.length - 1] : -1;
    const sameSpot = spot != null && last && last.spot === spot && last.floor === floor[i];
    const sameRun = spot == null && last && last.spot == null && last.floor === floor[i] && last.scans.length < group && t[i] - t[lastI] < 6;
    if (sameSpot || sameRun) last.scans.push(i);
    else nodes.push({ scans: [i], spot, floor: floor[i] });
    nodeOf[i] = nodes.length - 1;
  }
  if (nodes.length > MAX_NODES) {
    // Pontos marcados demais para resolver um a um: junta nós seguidos (o mapa sai mais grosso e cada
    // varredura é colocada por interpolação no tempo; a saída ainda iguala as do mesmo ponto).
    const per = Math.ceil(nodes.length / MAX_NODES);
    const merged = [];
    for (const nd of nodes) {
      const last = merged[merged.length - 1];
      if (last && last.parts < per && last.floor === nd.floor) {
        last.scans.push(...nd.scans);
        last.parts++;
      } else merged.push({ scans: nd.scans.slice(), spot: null, floor: nd.floor, parts: 1 });
    }
    nodes.length = 0;
    merged.forEach((nd, a) => {
      nodes.push(nd);
      for (const i of nd.scans) nodeOf[i] = a;
    });
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

  // Transições entre nós seguidos: andando, saindo de um ponto marcado, chegando a um, ou "livre"
  // (intervalo longo demais para o passo informar alguma coisa: modo de 30 s).
  const trans = [];
  for (let a = 0; a + 1 < M; a++) {
    const dt = Math.max(0.5, nodes[a + 1].t0 - nodes[a].t1);
    const sa = nodes[a].spot != null;
    const sb = nodes[a + 1].spot != null;
    let type = 'walk';
    if (dt > 12 || (sa && sb)) type = 'free';
    else if (sa) type = 'leave';
    else if (sb) type = 'arrive';
    trans.push({ type, dt, sameFloor: nodes[a].floor === nodes[a + 1].floor });
  }
  return { prep, M, K, val, nObs, nCens, seen, active, floors, floorIdx, missLevel, radios, nodes, trans };
}

// ---------------------------------------------------------------------------
// Geometria grossa (Isomap com barras de tempo)
// ---------------------------------------------------------------------------

// Impressão digital de cada nó; rádio ausente = nível de corte (ou "não sei" quando foi beacon perdido).
// smoothW > 0 mistura os vizinhos no tempo de quem está andando: tira ruído à custa de borrar ~1 passo.
function nodeFingerprints(model, smoothW) {
  const { M, K, val, nObs, nCens, nodes, missLevel } = model;
  const fp = new Float64Array(M * K);
  for (let i = 0; i < M * K; i++) fp[i] = nObs[i] > 0 ? val[i] : nCens[i] > 0 ? missLevel : NaN;
  if (!(smoothW > 0)) return fp;
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
        const wb = smoothW * (nodes[a].spot != null ? 0.5 : 1);
        s += wb * u;
        c += wb;
      }
      out[a * K + k] = c ? s / c : NaN;
    }
  }
  return out;
}

// D² entre impressões digitais: média, sobre os rádios, do quadrado da diferença (dB²).
function fingerprintDistances(model, smoothW) {
  const { M, K, nodes, floors } = model;
  const fp = nodeFingerprints(model, smoothW);
  // Desconto por andar: a laje muda o nível de cada rádio; tira-se a média de cada (rádio, andar),
  // senão dois andares parecem dois lugares distantes e o mapa os espalha lado a lado.
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
  return D2;
}

// Grafo com dois tipos de aresta:
//   - "barras" entre nós seguidos no tempo, do tamanho do passo esperado (metros de verdade);
//   - cada nó ligado aos k nós de impressão digital mais parecida (fora da vizinhança no tempo),
//     com comprimento que só depende do posto (o mais parecido está mais perto, o seguinte um pouco mais).
// A distância entre dois nós quaisquer é o caminho mais curto no grafo e o mapa sai do MDS clássico
// dessas distâncias. A distância direta entre impressões digitais não serve para pares distantes
// (satura e exagera as paredes); o caminho pelo grafo soma trechos curtos, que são confiáveis.
function coarseEmbedding(model, T, info) {
  const { M, trans } = model;
  if (M === 1) return [[0, 0]];
  if (M === 2) return [[-0.5, 0], [0.5, 0]];
  const D2 = fingerprintDistances(model, T.smoothW);
  const timed = trans.some((tr) => tr.type !== 'free'); // há passos com tempo útil (modos de 3,5 s)
  // Vizinhos por impressão digital de cada nó, do mais parecido para o menos.
  const excl = timed ? T.isoExclude : 0;
  const kMax = Math.max(1, Math.min(T.isoK, M - 2 * excl - 1));
  const neigh = new Int32Array(M * kMax).fill(-1);
  const cand = [];
  for (let a = 0; a < M; a++) {
    cand.length = 0;
    for (let b = 0; b < M; b++) if (Math.abs(a - b) > excl) cand.push(b);
    cand.sort((p, q) => D2[a * M + p] - D2[a * M + q] || p - q);
    for (let r = 0; r < kMax && r < cand.length; r++) neigh[a * kMax + r] = cand[r];
  }
  // Quanto mede a aresta do vizinho de posto r? Depende de quão denso foi o levantamento. Calibra com
  // pares de distância conhecida pelo tempo: se um nó a ~d metros costuma ter R nós mais parecidos do
  // que ele então, como em 2D a contagem cresce com o quadrado da distância, o vizinho de posto r
  // está a ~d·sqrt((r+1)/(R+1)). isoKappa cobre o fato de a ordem por impressão digital ser ruidosa.
  let unit = NaN; // "espaçamento" efetivo do levantamento, em metros
  if (timed) {
    const est = [];
    // Para pares vizinhos no tempo a suavização mistura as duas impressões digitais: usa as cruas.
    const Dc = fingerprintDistances(model, 0);
    const sameFloor = (a, c) => model.floorIdx[a] === model.floorIdx[c];
    for (const pr of calibrationPairs(model, T)) {
      const ref = Dc[pr.a * M + pr.b];
      for (const [u, v] of [
        [pr.a, pr.b],
        [pr.b, pr.a],
      ]) {
        let rank = 0;
        for (let c = 0; c < M; c++) if (Math.abs(c - u) > excl && c !== v && sameFloor(c, u) && Dc[u * M + c] < ref) rank++;
        est.push(pr.len / Math.sqrt(rank + 1));
      }
    }
    if (est.length >= 6) {
      est.sort((p, q) => p - q);
      unit = est[est.length >> 1];
    }
  }
  if (info) info.unit = Number.isNaN(unit) ? null : Number(unit.toFixed(2));
  const lenOf = new Float64Array(kMax);
  for (let r = 0; r < kMax; r++) lenOf[r] = Number.isNaN(unit) ? T.isoLen0 + T.isoLenStep * r : T.isoKappa * unit * Math.sqrt(r + 1);
  // Teto pela ordem das impressões digitais: quem aparece cedo na lista de parecidos de um nó não pode
  // estar longe dele, por mais comprido que seja o caminho pelo grafo (que só passa por onde se anda:
  // numa casa de cômodos em fila o caminho dá a volta pelas portas e o mapa sairia desenrolado).
  let cap = null;
  if (T.rankCap > 0 && !Number.isNaN(unit)) {
    const rank = new Float64Array(M * M);
    const order = [];
    for (let a = 0; a < M; a++) {
      order.length = 0;
      for (let b = 0; b < M; b++) if (b !== a) order.push(b);
      order.sort((p, q) => D2[a * M + p] - D2[a * M + q] || p - q);
      for (let r = 0; r < order.length; r++) rank[a * M + order[r]] = r;
    }
    cap = new Float64Array(M * M);
    for (let a = 0; a < M; a++) {
      for (let b = a + 1; b < M; b++) {
        const r = 0.5 * (rank[a * M + b] + rank[b * M + a]);
        cap[a * M + b] = cap[b * M + a] = T.rankCap * unit * Math.sqrt(r + 1);
      }
    }
  }
  return isomapEmbed(model, neigh, kMax, lenOf, T, cap);
}

// Pares de nós com distância esperada conhecida pelo tempo: um passo de quem anda e pulos entre
// pontos marcados seguidos.
function calibrationPairs(model, T) {
  const { M, nodes, trans } = model;
  const pairs = [];
  for (let a = 0; a + 1 < M; a++) {
    if (trans[a].type === 'walk' && trans[a].sameFloor) pairs.push({ a, b: a + 1, len: T.walkRms * (nodes[a + 1].t - nodes[a].t) });
  }
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

function isomapEmbed(model, neigh, kMax, lenOf, T, cap) {
  const { M, nodes, trans } = model;
  const G = new Float64Array(M * M).fill(Infinity);
  const link = (a, b, len) => {
    if (len < G[a * M + b]) G[a * M + b] = G[b * M + a] = len;
  };
  for (let a = 0; a < M; a++) G[a * M + a] = 0;
  for (let a = 0; a + 1 < M; a++) {
    const tr = trans[a];
    let len;
    if (tr.type === 'walk') len = T.walkSpeed * tr.dt;
    else if (tr.type === 'leave') len = T.leaveSpeed * tr.dt;
    else if (tr.type === 'arrive') len = 0.1 * tr.dt;
    else len = T.isoFree * lenOf[0]; // sem informação de tempo: só uma ponte frouxa entre pontos seguidos
    link(a, a + 1, Math.max(0.05, len));
  }
  // Nós do mesmo ponto marcado (revisita): mesmo lugar.
  const bySpot = new Map();
  for (let a = 0; a < M; a++) {
    if (nodes[a].spot == null) continue;
    const key = `${nodes[a].spot}|${nodes[a].floor}`;
    if (bySpot.has(key)) link(bySpot.get(key), a, 0.05);
    else bySpot.set(key, a);
  }
  for (let a = 0; a < M; a++) {
    for (let r = 0; r < kMax; r++) {
      const b = neigh[a * kMax + r];
      if (b >= 0) link(a, b, lenOf[r]);
    }
  }
  // Caminhos mais curtos (Floyd-Warshall).
  for (let k = 0; k < M; k++) {
    const rowK = k * M;
    for (let i = 0; i < M; i++) {
      const gik = G[i * M + k];
      if (gik === Infinity) continue;
      const rowI = i * M;
      for (let j = 0; j < M; j++) {
        const v = gik + G[rowK + j];
        if (v < G[rowI + j]) G[rowI + j] = v;
      }
    }
  }
  let far = 0;
  for (let i = 0; i < M * M; i++) if (G[i] !== Infinity && G[i] > far) far = G[i];
  const E2 = new Float64Array(M * M);
  for (let i = 0; i < M * M; i++) {
    let g = G[i] === Infinity ? far : G[i];
    if (cap && cap[i] > 0 && cap[i] < g) g = cap[i];
    E2[i] = g * g;
  }
  const { vectors, values } = topEigen(doubleCentre(E2, M), M, 2);
  const s0 = Math.sqrt(Math.max(values[0], 0));
  const s1 = Math.sqrt(Math.max(values[1], 0));
  const X = [];
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

// ---------------------------------------------------------------------------
// Lei de distância por rádio (base dos campos e posição dos roteadores)
// ---------------------------------------------------------------------------

// Lei de distância de cada rádio com as posições atuais: nível + inclinação com o log da distância
// a um centro procurado em volta da área. Os rádios do mesmo aparelho dividem o centro.
function fitBases(model, X, box) {
  const { M, K, active, floors, floorIdx, radios } = model;
  const F = floors.length;
  const w = box.w;
  const hgt = box.h;
  const cxm = box.x0 + w / 2;
  const cym = box.y0 + hgt / 2;
  const step = Math.max(0.7, Math.sqrt((w * hgt) / 220));
  const cands = [];
  for (let x = box.x0 + step / 2; x < box.x0 + w; x += step) for (let y = box.y0 + step / 2; y < box.y0 + hgt; y += step) cands.push([x, y]);
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
  return { x0: minX - margin, y0: minY - margin, w: Math.max(1, maxX - minX + 2 * margin), h: Math.max(1, maxY - minY + 2 * margin) };
}

/**
 * Voltas de [ajusta a lei de distância -> passos de gradiente nas posições].
 *
 * O que se minimiza é o erro com que o campo de cada rádio, aprendido dos OUTROS nós (núcleo
 * gaussiano sobre o resíduo da lei de distância), prevê as leituras de cada nó, mais um custo de
 * movimento (caminho suave, passo possível). O gradiente é o completo: cada nó é empurrado para onde
 * as suas leituras combinam com o campo e para onde elas ajudam (ou param de atrapalhar) a previsão
 * dos vizinhos.
 *
 * Com rounds = 0 só avalia (lei de distância, erro de previsão e curvatura), sem mover nada.
 * @returns {{X: number[][], params: Object[], heldOut: number, sigmaMean: number, curv: Float64Array}}
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
      const r = accN[i] / dn;
      const vf = (sf2 * lam) / dn;
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
  let cur = null;
  for (let round = 0; round < opts.rounds; round++) {
    if (opts.deadline && now() > opts.deadline) break;
    const h = opts.h1 + (opts.h0 - opts.h1) * (opts.rounds > 1 ? 1 - round / (opts.rounds - 1) : 0);
    params = fitBases(model, X, boundsOf(X, T.boxMargin));
    let alpha = T.stepSize;
    cur = evaluate(h, true);
    for (let it = 0; it < opts.sweeps; it++) {
      if (opts.deadline && now() > opts.deadline) break;
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
    for (let q = 0; q < A; q++) {
      const v = cur.stats.errN[q] > 3 ? cur.stats.errS[q] / cur.stats.errN[q] : T.sigmaNoise * T.sigmaNoise;
      sig2[q] = Math.max(4, Math.min(81, v));
    }
    trace.push(Number(cur.stats.ll.toFixed(3)));
    if (opts.onRound) opts.onRound(round, X);
  }
  // Avaliação final (também quando não houve refino): lei de distância para a saída, erro de previsão
  // e curvatura do custo em cada nó (quanto mais curvo, mais firme a posição).
  params = fitBases(model, X, boundsOf(X, T.boxMargin));
  cur = evaluate(opts.h1, true);
  let sm = 0;
  for (let q = 0; q < A; q++) sm += Math.sqrt(sig2[q]);
  const curv = new Float64Array(M);
  for (let a = 0; a < M; a++) {
    let hxx = 0;
    let hyy = 0;
    for (const b of members[varOf[a]]) {
      hxx += hXX[b];
      hyy += hYY[b];
    }
    curv[a] = 0.5 * (hxx + hyy);
  }
  if (opts.info) opts.info.ll = trace;
  return { X: X.map((p) => [p[0], p[1]]), params, heldOut: cur.stats.ll, sigmaMean: A ? sm / A : 0, curv };
}

// ---------------------------------------------------------------------------
// Escala quando o tempo não informa nada (modo de 30 s)
// ---------------------------------------------------------------------------

// Perto de um roteador da casa (mesmo cômodo, sem parede no meio) o sinal segue bem a lei de
// distância:  d = 10^((p0 - rssi) / (10 n)).  Compara essa distância com a do mapa, só nos nós em que
// o rádio chega forte, e devolve o fator que leva o mapa para metros (NaN se não há roteador por perto).
// p0 (sinal a 1 m) é o que se espera de um roteador doméstico visto por um celular: cerca de -40 dBm em
// 2,4 GHz e 6 dB a menos em 5 GHz; n = 2,2 é o expoente quase de espaço livre de quem está no mesmo cômodo.
function physicsScale(model, X, T, info) {
  const { M, K, val, nObs, active, radios, floorIdx } = model;
  const est = [];
  for (const k of active) {
    const pts = [];
    for (let a = 0; a < M; a++) if (nObs[a * K + k] > 0) pts.push({ a, r: val[a * K + k] });
    if (pts.length < 8) continue;
    pts.sort((p, q) => q.r - p.r);
    const rmax = (pts[0].r + pts[1].r) / 2;
    if (rmax < T.physMinRssi) continue; // não é da casa (ou nunca se chegou perto)
    const f0 = floorIdx[pts[0].a];
    const top = pts.filter((p) => floorIdx[p.a] === f0).slice(0, 3);
    let ax = 0;
    let ay = 0;
    for (const p of top) {
      ax += X[p.a][0] / top.length;
      ay += X[p.a][1] / top.length;
    }
    const p0 = T.physP0 - (radios[k].band > 0 ? T.physBandDrop : 0);
    const dm = [];
    const dp = [];
    for (const p of pts) {
      if (p.r < rmax - T.physSpan || floorIdx[p.a] !== f0 || top.includes(p)) continue;
      dm.push(Math.hypot(X[p.a][0] - ax, X[p.a][1] - ay));
      dp.push(Math.pow(10, (p0 - p.r) / (10 * T.physN)));
    }
    if (dm.length < 4) continue;
    dm.sort((p, q) => p - q);
    dp.sort((p, q) => p - q);
    const m = dm[dm.length >> 1];
    if (m > 1e-6) est.push(dp[dp.length >> 1] / m);
  }
  if (!est.length) return NaN;
  est.sort((p, q) => p - q);
  const c = est[est.length >> 1];
  if (info) info.phys = { c: Number(c.toFixed(2)), all: est.map((v) => Number(v.toFixed(2))) };
  return c;
}

// Escala do mapa grosso. Com tempo útil (modos de 3,5 s) ela já vem das barras e da calibração de
// densidade. Sem tempo útil (modo de 30 s) o grafo não tem unidade: usa um fator a priori, misturado
// com a física quando há vários rádios da casa (com um ou dois, a física é ruído).
function coarseScale(model, X, T, info) {
  if (model.trans.some((tr) => tr.type !== 'free')) return X;
  let c = T.freeScale0;
  const scratch = {};
  const cPhys = physicsScale(model, X, T, scratch);
  if (cPhys > 0 && Number.isFinite(cPhys) && scratch.phys.all.length >= T.physMinRadios) {
    const w = scratch.phys.all.length / T.physPerRadios;
    c = Math.exp((Math.log(T.freeScale0) + w * Math.log(cPhys / T.physBias)) / (1 + w));
  }
  if (info) info.freeScale = Number(c.toFixed(2));
  if (!(c > 0) || !Number.isFinite(c)) return X;
  return X.map((p) => [p[0] * c, p[1] * c]);
}

// ---------------------------------------------------------------------------
// Saída
// ---------------------------------------------------------------------------

// Calibração do usuário: distância real (m) entre duas varreduras. Devolve o fator que acerta a
// escala do mapa (mediana das razões), ou 0 se não há calibração aproveitável.
function knownScale(prep, survey, X) {
  const list = Array.isArray(survey.knownDistances) ? survey.knownDistances : [];
  const ratios = [];
  for (const kd of list) {
    if (!kd || !Number.isInteger(kd.a) || !Number.isInteger(kd.b) || !(kd.meters > 0)) continue;
    if (kd.a < 0 || kd.b < 0 || kd.a >= prep.N || kd.b >= prep.N) continue;
    const p = X[prep.nodeOf[kd.a]];
    const q = X[prep.nodeOf[kd.b]];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d > 1e-3) ratios.push(kd.meters / d);
  }
  if (!ratios.length) return 0;
  ratios.sort((p, q) => p - q);
  const r = ratios[ratios.length >> 1];
  return r > 0 && Number.isFinite(r) ? r : 0;
}

// Posição de cada varredura a partir dos nós: ponto marcado = posição do nó; varreduras agrupadas
// de quem anda = interpolação no tempo entre os nós vizinhos do mesmo andar.
function nodePointsToScans(prep, X) {
  const { N, nodes, nodeOf, t } = prep;
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = nodeOf[i];
    const nd = nodes[a];
    let x = X[a][0];
    let y = X[a][1];
    if (nd.spot == null && nd.scans.length > 1) {
      const ti = t[i] - SWEEP_MID_S;
      const b = ti < nd.t ? a - 1 : a + 1;
      if (b >= 0 && b < nodes.length && nodes[b].floor === nd.floor && Math.abs(nodes[b].t - nd.t) < 30 && nodes[b].t !== nd.t) {
        const u = Math.max(0, Math.min(1, (ti - nd.t) / (nodes[b].t - nd.t)));
        x += u * (X[b][0] - x);
        y += u * (X[b][1] - y);
      }
    }
    out[i] = { x, y };
  }
  return out;
}

function buildOutput(prep, model, X, fit, flags, T) {
  const { N, floor } = prep;
  const { M, K, active, radios, floors, val, nObs, seen } = model;
  // Convenção de saída: origem no centro dos pontos, eixo x na direção de maior espalhamento.
  const pts = nodePointsToScans(prep, X);
  // Mesmo ponto marcado = uma posição só (garante o contrato também quando nós foram agrupados).
  const bySpot = new Map();
  for (let i = 0; i < N; i++) {
    const s = prep.scans[i];
    if (!s || s.spot == null) continue;
    const key = `${s.spot}|${floor[i]}`;
    let e = bySpot.get(key);
    if (!e) bySpot.set(key, (e = { x: 0, y: 0, n: 0, list: [] }));
    e.x += pts[i].x;
    e.y += pts[i].y;
    e.n++;
    e.list.push(i);
  }
  for (const e of bySpot.values()) for (const i of e.list) pts[i] = { x: e.x / e.n, y: e.y / e.n };
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x / N;
    cy += p.y / N;
  }
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - cx) * (p.x - cx);
    sxy += (p.x - cx) * (p.y - cy);
    syy += (p.y - cy) * (p.y - cy);
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const co = Math.cos(ang);
  const si = Math.sin(ang);
  const place = (x, y) => [co * (x - cx) + si * (y - cy), -si * (x - cx) + co * (y - cy)];
  const finite = (v) => (Number.isFinite(v) ? v : 0);

  // Confiança de cada ponto: desvio esperado da posição pela curvatura do custo (em nats/m²),
  // rebaixada quando o levantamento inteiro é pouco informativo (modo de 30 s, sem refino).
  const quality = flags.timed ? 1 : 0.6;
  const points = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = prep.nodeOf[i];
    const [x, y] = place(pts[i].x, pts[i].y);
    const sd = fit && fit.curv[a] > 1e-9 ? 1 / Math.sqrt(fit.curv[a]) : 5;
    const conf = quality / (1 + sd * sd);
    points[i] = { x: finite(x), y: finite(y), z: floor[i] * FLOOR_HEIGHT, conf: Math.max(0.02, Math.min(1, finite(conf))) };
  }

  // Roteadores: o centro da lei de distância ajustada (aparelho = mesma posição para todas as suas
  // redes). Quem foi ouvido pouco demais para um ajuste fica onde chegou mais forte, com confiança mínima.
  const aps = {};
  const perRadio = [];
  const box = boundsOf(X, 0);
  for (let k = 0; k < K; k++) {
    let best = -1;
    let rmax = -Infinity;
    for (let a = 0; a < M; a++) {
      if (nObs[a * K + k] > 0 && val[a * K + k] > rmax) {
        rmax = val[a * K + k];
        best = a;
      }
    }
    if (best < 0) continue; // só leituras velhas: não há o que posicionar
    const p = fit && fit.params ? fit.params[k] : null;
    let ax = X[best][0];
    let ay = X[best][1];
    let af = model.floorIdx[best];
    let p0 = rmax + 3;
    let n = 2.5;
    let conf = 0.05;
    if (p && active.includes(k)) {
      ax = p.ax;
      ay = p.ay;
      af = p.af;
      if (rmax > T.physMinRssi - 5) {
        // Roteador por perto: o centro dos nós onde ele chega mais forte localiza melhor do que o
        // centro da lei de distância (que as paredes entortam).
        const top = [];
        for (let a = 0; a < M; a++) if (nObs[a * K + k] > 0 && model.floorIdx[a] === model.floorIdx[best]) top.push(a);
        top.sort((u, v) => val[v * K + k] - val[u * K + k]);
        let sw = 0;
        let sx = 0;
        let sy = 0;
        for (const a of top.slice(0, 3)) {
          const w = Math.pow(10, (val[a * K + k] - rmax) / 10);
          sw += w;
          sx += w * X[a][0];
          sy += w * X[a][1];
        }
        ax = sx / sw;
        ay = sy / sw;
        af = model.floorIdx[best];
      }
      p0 = p.level[af];
      n = p.n;
      // Dentro (ou colado) da área andada e com sinal forte: posição firme. Longe: só a direção vale.
      const out = Math.max(box.x0 - ax, ax - (box.x0 + box.w), box.y0 - ay, ay - (box.y0 + box.h), 0);
      const strength = Math.max(0, Math.min(1, (rmax + 75) / 30));
      conf = Math.max(0.05, Math.min(0.9, (0.2 + 0.7 * strength) / (1 + out / 3))) * Math.min(1, seen[k] / 20);
    }
    const [x, y] = place(ax, ay);
    perRadio.push({ k, rmax, x: finite(x), y: finite(y), z: floors[af] * FLOOR_HEIGHT + 1, p0: finite(p0), n: finite(n) || 2.5, conf: Math.max(0.02, Math.min(1, finite(conf))) });
  }
  // Rádios do mesmo aparelho ficam no mesmo lugar: vale a posição do rádio que chega mais forte.
  const lead = new Map();
  for (const e of perRadio) {
    const d = radios[e.k].device;
    if (!lead.has(d) || e.rmax > lead.get(d).rmax) lead.set(d, e);
  }
  for (const e of perRadio) {
    const l = lead.get(radios[e.k].device);
    for (const id of radios[e.k].ids) aps[id] = { x: l.x, y: l.y, z: l.z, p0: e.p0, n: e.n, conf: Math.max(e.conf, l.conf * 0.8) };
  }

  // Confiança na escala: certa se o usuário mediu uma distância; razoável quando vem do passo de quem
  // anda (o passo de cada pessoa varia uns 15%); fraca quando só há a física e um fator a priori.
  const scaleConf = flags.known ? 0.95 : flags.timed ? 0.55 : 0.2;
  return { points, aps, scaleConf };
}
