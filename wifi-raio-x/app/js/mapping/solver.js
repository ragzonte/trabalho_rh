// Mapa só com Wi-Fi — o solucionador que vai no app.
//
//   solve(survey, options)       -> MapSolution   o melhor mapa possível (alguns segundos)
//   solveQuick(survey, options)  -> MapSolution   prévia rápida enquanto o usuário ainda anda
//   SOLVER_INFO                                   o que a interface pode dizer sobre a precisão
//
// COMO FUNCIONA. Só com o Wi-Fi, nenhum método sozinho acerta a planta: o sinal não obedece à
// distância (paredes, sombra do corpo) e a escala em metros quase não é observável. Quatro motores
// independentes resolvem o mesmo levantamento por caminhos diferentes:
//
//   isomap   grafo de vizinhança das impressões digitais + passo de quem anda      (solver-isomap.js)
//   chain    cadeia no tempo + campo de cada rádio aprendido por EM                 (solver-chain.js)
//   fields   campos de sinal latentes: quem volta ao mesmo lugar ouve o mesmo       (solver-fields.js)
//   range    distâncias até roteadores estimados + trajetória numa grade            (solver-range.js)
//
// Cada um erra de um jeito (num torneio com casas nunca vistas nenhum dominou, e escolher o melhor
// por cenário daria bem mais do que qualquer um). O que eles erram por motivos DIFERENTES se
// cancela na média; por isso o resultado final é o CONSENSO: as quatro soluções são levadas ao
// mesmo referencial (rotação + espelho, que o Wi-Fi não observa) e a posição de cada varredura é
// a média das quatro. O tamanho do mapa é a média geométrica dos tamanhos (erro de escala é
// multiplicativo). Na bancada (tests/mapping/harness.mjs; 160 levantamentos simulados, nota 0 =
// perfeito, 100 = tudo num ponto só) o consenso ficou em 44,6, contra 47,0 do melhor motor
// sozinho e 49 a 51 dos outros três; no modo de uma varredura a cada 30 s a diferença passa de 5
// pontos. Regras mais espertas (mediana, pesos pela confiança ou pela concordância, descartar quem
// discorda, encaixar cada andar em separado, refinar de novo a partir do consenso) não ganharam da
// média simples e ficaram de fora.
//
// De quebra, a DISCORDÂNCIA entre os motores num ponto é uma medida do erro que não precisa da
// verdade: é dela que sai a confiança de cada posição.
//
// CONTRA O MUNDO REAL. O simulador da bancada é bem-comportado; um celular na mão de alguém não é.
// Antes de chegar aos motores o levantamento passa por engineView(): andares demais são juntados,
// uma parada longa sem "marcar ponto" vira um ponto só, um levantamento enorme é resolvido em
// blocos (o resto entra pela impressão digital), redes que ligaram ou desligaram no meio do
// caminho são escondidas e, num prédio com centenas de redes, ficam as mais presentes. Na saída,
// um motor cuja conta degenerou não entra na média, e o mapa tem um tamanho máximo. Nos
// levantamentos da bancada nada disso é acionado (o resultado é o mesmo, bit a bit); o que cada
// cuidado evita está medido em tests/solver-robustness.test.mjs.
//
// Determinístico (nenhum sorteio; `options.seed` é aceito e não muda nada; entre máquinas de
// JavaScript diferentes as posições podem diferir em centímetros, pela aritmética das funções
// matemáticas), nunca lança erro e roda num Web Worker: só importa os módulos solver-* desta
// pasta e types.js.

import { FLOOR_HEIGHT } from './types.js';
import { clamp, cloudStats, finite, fitRigid, floorOf, median, now, pickScans, readSurvey, shareSpots, visitsOf } from './solver-common.js';
import { solveIsomap } from './solver-isomap.js';
import { solveChain } from './solver-chain.js';
import { solveFields } from './solver-fields.js';
import { solveRange } from './solver-range.js';

/**
 * O que a interface pode dizer sobre este solucionador. Os números vêm da bancada
 * (tests/mapping/harness.mjs, casas simuladas): erro mediano de posição depois do melhor
 * alinhamento rígido, sem ajustar a escala.
 */
export const SOLVER_INFO = {
  name: 'consenso de quatro motores (isomap + chain + fields + range)',
  version: '1.1.0',
  /** Erro mediano típico de posição (m): casa ou apartamento; escritório grande (~20 x 14 m). */
  expectedErrorM: { casa: 1.3, escritorio: 2.3 },
  notes: [
    'Erro típico de 1 a 2 m numa casa e de 2 a 3 m num escritório grande: dá para ver os ambientes, não as paredes.',
    'Andando com varredura livre (uma a cada ~3,5 s) o mapa sai melhor do que com o limite padrão do Android (uma a cada 30 s).',
    'A escala em metros vem do passo de quem anda e erra uns 20% (30% ou mais no modo de 30 s): medir uma distância real entre dois pontos marcados corrige.',
    'Casa de dois andares e levantamentos com um só roteador forte são os casos mais difíceis.',
    'A rotação e o espelhamento do mapa não são observáveis só com o Wi-Fi.',
  ],
};

/** Tempo padrão de solve() (ms nesta máquina de referência; o celular é 3 a 5 vezes mais lento). */
const DEFAULT_BUDGET_MS = 6000;
/** Visitas que os motores recebem, no máximo (o custo deles cresce com o quadrado ou o cubo); acima disto, só blocos (ver engineView). */
const MAX_VISITS = 300;
const QUICK_MAX_VISITS = 240;
/** Andares distintos que os motores recebem; além disto os menos visitados se juntam ao vizinho (ver limitFloors). */
const MAX_FLOORS = 8;
/** Distância medida pelo usuário acima disto (m) não é de um levantamento de Wi-Fi dentro de casa: erro de digitação. */
const KNOWN_MAX_M = 150;
/** Nenhuma coordenada passa disto (m): o que passar é lixo numérico, e o motor que a devolveu fica de fora. */
const MAX_COORD_M = 1e5;
/**
 * Motor cujo mapa sai mais do que isto maior ou menor que o dos outros fica fora do consenso. É
 * rede de segurança contra conta que degenerou (mapa quase colapsado, escala que explodiu): nos
 * levantamentos da bancada os motores nunca discordam no tamanho por mais de 1,7 vez.
 */
const SIZE_OUTLIER = 4;
/**
 * Rádios que os motores recebem, no máximo (os mais ouvidos e mais fortes). O custo deles cresce em
 * linha reta com o número de rádios, e num prédio com duzentas redes à vista a prévia levava vários
 * segundos; as redes além das primeiras dezenas repetem o que as outras já dizem. Os levantamentos
 * da bancada têm no máximo ~30 rádios e não chegam a este teto.
 */
const MAX_RADIOS = 64;
const QUICK_MAX_RADIOS = 48;
/** Levantamento enorme: em quantos blocos de visitas seguidas, no máximo, os motores o recebem (ver engineView). */
const MAX_BLOCKS = 4;
/** Teto do raio (rms, m) de um mapa: ver capSize(). */
const MAX_RADIUS_M = 300;

// Os motores, do mais barato ao mais caro. `cost` é o custo relativo medido na bancada: serve para
// o andamento e para decidir, com pouco tempo, quem fica de fora (o mais caro sai primeiro).
const MEMBERS = [
  { name: 'isomap', cost: 1, run: solveIsomap, label: 'Esboçando o mapa pela semelhança do sinal' },
  { name: 'chain', cost: 1, run: solveChain, label: 'Seguindo o caminho ao longo do tempo' },
  { name: 'fields', cost: 2.2, run: solveFields, label: 'Aprendendo o sinal de cada rede em cada lugar' },
  { name: 'range', cost: 2.4, run: solveRange, label: 'Estimando as distâncias até os roteadores' },
];

// Calibração da confiança na bancada (112 cenários, 12.923 pontos): o erro mediano de um ponto
// cresce quase em linha reta com a discordância entre os motores ali — 0,75 m onde ela é de 0,15 m,
// 1,2 m em 0,6 m, 2,3 m em 2 m. Mesmo onde todos concordam sobra o que erram JUNTOS (a deformação
// que o Wi-Fi não deixa ver): é o piso.
const POINT_ERR_FLOOR_M = 0.7;
const POINT_ERR_PER_SPREAD = 0.8;
// O mesmo para o levantamento inteiro: erro mediano ≈ 0,5 + 1,3 x discordância mediana (± 0,4 m).
const SURVEY_ERR_FLOOR_M = 0.5;
const SURVEY_ERR_PER_SPREAD = 1.3;
const CONF_HALF_M = 1.5; // erro esperado em que a confiança de um ponto cai para 0,5
// Com duas ou três redes à vista (casa isolada) os motores erram JUNTOS: concordam entre si e a
// discordância não denuncia nada. Medido com os levantamentos da bancada reduzidos às 2 ou 3 redes
// mais ouvidas: erro mediano real de 2,0 a 2,3 m contra 1,3 m declarados, e mapa ~38% menor que o
// real. O erro esperado é multiplicado por até isto quando há menos de FEW_RADIOS rádios úteis.
const FEW_RADIOS = 6;
const FEW_RADIOS_PENALTY = 1.65;
// Distância medida pelo usuário: variância (m²) da distância entre dois pontos do mapa dividida pela
// variância relativa da escala sem medida nenhuma; ver applyKnownDistances().
const KNOWN_BASE_M2 = 80;

// ---------------------------------------------------------------------------
// solve
// ---------------------------------------------------------------------------

/**
 * Resolve o mapa: onde cada varredura foi feita e onde está cada roteador.
 *
 * @param {import('./types.js').Survey} survey
 * @param {Object} [options]
 * @param {number} [options.seed]        aceito por compatibilidade; o método não sorteia nada
 * @param {number} [options.budgetMs]    tempo disponível (padrão 6000). Com pouco tempo os motores mais
 *                                       caros ficam de fora; o primeiro sempre roda
 * @param {(fraction: number, stage: string) => void} [options.onProgress]  andamento 0..1 e etapa (pt-BR)
 * @param {{cancelled: boolean}} [options.signal]  conferido entre as etapas: cancelado, devolve logo o que tiver
 * @param {import('./types.js').MapSolution} [options.previous]  solução anterior do mesmo levantamento
 *        (por exemplo a última prévia): o resultado sai no referencial dela, sem girar nem espelhar na tela
 * @returns {Promise<import('./types.js').MapSolution>}  `debug` (pequeno, cabe numa mensagem) traz os
 *          motores usados e os tempos (members), os que não rodaram (skipped) ou ficaram fora da
 *          média (outliers), a discordância mediana entre eles (agreementM), o erro esperado
 *          (expectedErrorM) e o que foi feito com o levantamento: redes instáveis escondidas
 *          (unstable, BSSIDs), paradas longas reconhecidas (standstills) e blocos (blocks)
 */
export async function solve(survey, options) {
  const opts = options && typeof options === 'object' ? options : {};
  try {
    return await solveConsensus(survey, opts);
  } catch (err) {
    return collapsed(survey, String((err && err.message) || err));
  }
}

async function solveConsensus(survey, options) {
  const t0 = now();
  const budget = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : DEFAULT_BUDGET_MS;
  const progress = (fraction, stage) => {
    if (typeof options.onProgress !== 'function') return;
    try {
      options.onProgress(clamp(fraction, 0, 1), stage);
    } catch (_) {
      // quem escuta o andamento não derruba o cálculo
    }
  };
  const cancelled = () => !!(options.signal && options.signal.cancelled);

  const view = readSurvey(survey);
  if (view.n === 0) return { points: [], aps: {}, scaleConf: 0, debug: { members: [], skipped: [] } };
  progress(0.02, 'Lendo as varreduras');
  const prepared = engineView(view, MAX_VISITS, MAX_RADIOS);
  const { sub, keep, heard, hidden, spare } = prepared;

  // Cada motor resolve o levantamento inteiro por conta própria. Os mais caros só entram se o
  // tempo que sobra der para eles, pela velocidade medida nos anteriores.
  const results = [];
  const used = []; // {name, ms} dos motores que entraram no consenso
  const skipped = []; // nomes dos que ficaram de fora (sem tempo, ou falharam)
  const end = t0 + 0.85 * budget; // folga para juntar as soluções e montar a saída
  const totalCost = MEMBERS.reduce((s, m) => s + m.cost, 0);
  let doneCost = 0;
  let pace = 0; // ms por unidade de custo
  let stopped = false;
  for (const member of MEMBERS) {
    if (sub.n === 0) break;
    const remaining = end - now();
    if (results.length > 0 && pace * member.cost > remaining) {
      skipped.push(member.name);
      continue;
    }
    progress(0.04 + (0.86 * doneCost) / totalCost, member.label);
    await breathe(); // deixa o Worker entregar o andamento e receber um pedido de cancelamento
    if (cancelled()) {
      stopped = true;
      break;
    }
    const started = now();
    let result = null;
    try {
      result = member.run(sub, { budgetMs: Math.max(1, end - started) });
    } catch (_) {
      // um motor que falha não derruba os outros
    }
    const ms = now() - started;
    if (usable(result, sub.n)) {
      results.push(result);
      used.push({ name: member.name, ms: Math.round(ms) });
    } else skipped.push(member.name);
    pace = Math.max(pace, ms / member.cost);
    doneCost += member.cost;
  }
  if (!results.length) {
    const out = collapsed(survey, stopped ? 'cancelado' : sub.n === 0 ? 'sem leituras' : 'nenhum motor conseguiu resolver');
    out.debug.cancelled = stopped;
    return out;
  }

  progress(0.92, 'Juntando as soluções');
  const merged = combine(results, sub);
  placeHidden(heard, [...hidden, ...spare], merged);
  const full = expand(view, prepared, merged);
  const sane = capSize(view, full);
  const known = knownPairs(survey, view);
  const trust = applyKnownDistances(view, known, full);
  orient(view, full, options.previous);
  const ownScale = sane ? merged.scaleConf : 0;
  const solution = toSolution(view, full, trust > 0 ? Math.max(ownScale, 0.95 * trust) : ownScale);
  solution.debug = {
    members: used,
    skipped,
    // motores que rodaram mas ficaram fora da média (mapa sem tamanho, ou de tamanho destoante)
    outliers: used.filter((_, c) => !merged.pool.includes(c)).map((m) => m.name),
    // redes que ligaram ou desligaram no meio do levantamento e por isso não entraram na conta (BSSIDs)
    unstable: hiddenIds(heard, hidden),
    // trechos longos parado sem marcar ponto, tratados como um ponto só
    standstills: heard.standstills || 0,
    // levantamento enorme: em quantos blocos foi resolvido (1 = inteiro); o resto entra pela impressão digital
    blocks: prepared.blocks,
    cancelled: stopped,
    agreementM: round2(merged.agreementM),
    expectedErrorM: round2(merged.expectedErrorM),
    ms: Math.round(now() - t0),
  };
  progress(1, 'Pronto');
  return solution;
}

// ---------------------------------------------------------------------------
// solveQuick
// ---------------------------------------------------------------------------

/**
 * Prévia rápida para atualizar a tela enquanto o usuário ainda anda: só o motor isomap (o mais
 * barato: ~0,1 s para 150 varreduras na máquina de referência, com o código já aquecido). É mais
 * grosseira que solve() — cerca de 2,5 pontos de nota pior na bancada; use solve() ao terminar.
 *
 * Estabilidade: o mapa é refeito do zero a cada chamada e, sozinho, sairia girado ou espelhado de
 * um jeito diferente cada vez. Passe em `options.previous` a prévia anterior (com menos varreduras,
 * as primeiras são as mesmas): a nova é encaixada sobre ela por rotação + espelho + translação.
 *
 * @param {import('./types.js').Survey} survey
 * @param {{previous?: import('./types.js').MapSolution, seed?: number, budgetMs?: number}} [options]
 *        `budgetMs`: sem ele o trabalho feito não depende do relógio (a prévia se repete igual);
 *        com ele o refino para ao passar de ~metade desse tempo
 * @returns {import('./types.js').MapSolution}  síncrono
 */
export function solveQuick(survey, options) {
  const opts = options && typeof options === 'object' ? options : {};
  try {
    const t0 = now();
    const view = readSurvey(survey);
    if (view.n === 0) return { points: [], aps: {}, scaleConf: 0, debug: { members: [], skipped: [] } };
    const prepared = engineView(view, QUICK_MAX_VISITS, QUICK_MAX_RADIOS);
    const { sub, keep, heard, hidden, spare } = prepared;
    if (sub.n === 0) return collapsed(survey, 'sem leituras');
    const r = solveIsomap(sub, { budgetMs: Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : 60000 });
    if (!usable(r, sub.n)) return collapsed(survey, 'prévia sem solução');
    // Um motor só: não há discordância para medir; fica a confiança dele, rebaixada (é só a prévia).
    const poor = fewRadiosFactor(sub);
    const conf = Float64Array.from(r.conf, (c) => (0.8 * c) / (poor * poor));
    const part = { x: r.x, y: r.y, conf, aps: { ...r.aps } };
    placeHidden(heard, [...hidden, ...spare], part);
    const full = expand(view, prepared, part);
    const ownScale = capSize(view, full) ? (0.8 * r.scaleConf) / (poor * poor) : 0;
    const trust = applyKnownDistances(view, knownPairs(survey, view), full);
    orient(view, full, opts.previous);
    const solution = toSolution(view, full, trust > 0 ? Math.max(ownScale, 0.95 * trust) : ownScale);
    solution.debug = { members: [{ name: 'isomap', ms: Math.round(now() - t0) }], skipped: [], unstable: hiddenIds(heard, hidden), standstills: heard.standstills || 0, quick: true };
    return solution;
  } catch (err) {
    return collapsed(survey, String((err && err.message) || err));
  }
}

// ---------------------------------------------------------------------------
// Entrada e saída
// ---------------------------------------------------------------------------

/** Resposta de quem não conseguiu nada: tudo no centro, confiança zero (válida pelo contrato). */
function collapsed(survey, why) {
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : [];
  const points = scans.map((s) => {
    let z = 0;
    try {
      z = floorOf(s) * FLOOR_HEIGHT;
    } catch (_) {
      // este é o caminho de quem já falhou: nada aqui pode lançar
    }
    return { x: 0, y: 0, z, conf: 0 };
  });
  return { points, aps: {}, scaleConf: 0, debug: { members: [], skipped: [], error: why } };
}

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** Cede a vez ao laço de eventos (no Worker: mensagens de andamento saem, o cancelamento entra). */
function breathe() {
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}

/** A resposta de um motor serve? (tamanho certo, tudo finito e nenhuma coordenada absurda) */
function usable(r, n) {
  if (!r || !r.x || !r.y || !r.conf || r.x.length !== n || r.y.length !== n || r.conf.length !== n) return false;
  for (let i = 0; i < n; i++) if (!(Math.abs(r.x[i]) <= MAX_COORD_M) || !(Math.abs(r.y[i]) <= MAX_COORD_M) || !Number.isFinite(r.conf[i])) return false;
  return Number.isFinite(r.scaleConf);
}

/**
 * O que os motores recebem, depois de quatro cuidados:
 *   1. andares limitados (limitFloors);
 *   2. só as varreduras que dizem algo — com pelo menos uma leitura fresca; as outras confundem as
 *      comparações de impressão digital e entram depois, por interpolação no tempo;
 *   3. quem ficou muito tempo parado sem marcar ponto vira um ponto só (markStandstills);
 *   4. em levantamentos enormes (o custo dos motores cresce com o quadrado ou o cubo das visitas),
 *      só alguns BLOCOS de visitas seguidas, espalhados do começo ao fim. Blocos, e não "uma visita
 *      a cada tantas": dentro de um bloco o intervalo entre as varreduras continua o de verdade, e
 *      é dele que os motores tiram a escala (o passo de quem anda). Raleando por igual, o mapa de
 *      uma caminhada de meia hora saía 35 a 40% menor que o real. As varreduras de fora dos blocos
 *      são colocadas depois, pela impressão digital (expand);
 * sem os rádios que ligaram ou desligaram no meio do caminho (unstableRadios)
 * e sem os rádios que sobram quando há redes demais à vista (spareRadios).
 *
 * @returns {{sub, keep, heard, hidden, spare, cols, blocks}}  `sub`: a visão dos motores; `keep`:
 *          índices (no levantamento) das varreduras de `sub`; `heard`: `sub` ainda com todos os
 *          rádios; `hidden`: os rádios instáveis, `spare`: os que sobraram e `cols`: os que os
 *          motores veem (índices em `heard`); `blocks`: em quantos blocos foi resolvido (1 = inteiro)
 */
function engineView(view, maxVisits, maxRadios) {
  const limited = limitFloors(view);
  const denseIdx = [];
  for (let i = 0; i < view.n; i++) if (view.fresh[i] > 0) denseIdx.push(i);
  const dense = markStandstills(denseIdx.length === view.n ? limited : pickScans(limited, denseIdx));
  const visits = visitsOf(dense);
  let heard = dense;
  let keep = denseIdx;
  let blocks = 1;
  if (visits.length > maxVisits) {
    // Dois blocos, o começo e o fim (poucos e compridos: é a continuidade dentro do bloco que dá a
    // escala); mais um ou dois no meio só se algum andar com visitas ficar sem nenhuma nos blocos
    // (sem referência no andar, as varreduras dele não teriam onde cair).
    const floors = new Map();
    for (const v of visits) floors.set(v.floor, (floors.get(v.floor) || 0) + 1);
    let chosen = [];
    for (blocks = 2; blocks <= MAX_BLOCKS; blocks++) {
      const size = Math.floor(maxVisits / blocks);
      chosen = [];
      for (let b = 0; b < blocks; b++) {
        const start = Math.round((b * (visits.length - size)) / (blocks - 1));
        for (let v = start; v < start + size; v++) chosen.push(v);
      }
      const covered = new Set(chosen.map((v) => visits[v].floor));
      if (blocks === MAX_BLOCKS || [...floors].every(([f, count]) => count < 8 || covered.has(f))) break;
    }
    const thin = [];
    for (const v of chosen) for (const q of visits[v].members) thin.push(q);
    heard = pickScans(dense, thin);
    keep = thin.map((q) => denseIdx[q]);
  }
  // Primeiro o teto de rádios; os instáveis são procurados só entre os que ficaram (a comparação
  // de impressões digitais custa na proporção dos rádios).
  const spare = spareRadios(heard, maxRadios);
  const left = new Set(spare);
  let cols = [];
  for (let k = 0; k < heard.K; k++) if (!left.has(k)) cols.push(k);
  let sub = spare.length ? pickRadios(heard, cols) : heard;
  const unstable = unstableRadios(sub);
  const hidden = unstable.map((c) => cols[c]);
  if (unstable.length) {
    cols = cols.filter((k) => !hidden.includes(k));
    sub = pickRadios(heard, cols);
  }
  return { sub, keep, heard, hidden, spare, cols, blocks };
}

/**
 * Rádios que sobram quando há mais do que `limit`: ficam os de maior "presença" (soma, sobre as
 * varreduras, de quanto o nível passa do limiar — ouvido muitas vezes e forte vale mais do que
 * ouvido às vezes e no limite). Devolve os índices dos que saem (vazio quando todos cabem).
 */
function spareRadios(view, limit) {
  const { n, K, rssi } = view;
  const fill = Number.isFinite(view.lowLevel) ? view.lowLevel - 2 : -92;
  const ranked = [];
  for (let k = 0; k < K; k++) {
    let presence = 0;
    for (let i = 0; i < n; i++) {
      const v = rssi[i * K + k];
      if (v === v) presence += Math.max(1, v - fill);
    }
    if (presence > 0) ranked.push({ k, presence });
  }
  if (ranked.length <= limit) return [];
  ranked.sort((p, q) => q.presence - p.presence || p.k - q.k);
  return ranked.slice(limit).map((e) => e.k);
}

/** A mesma visão só com os rádios de `cols` (índices crescentes). */
function pickRadios(view, cols) {
  const { n, K } = view;
  const R = cols.length;
  const rssi = new Float64Array(n * R);
  const count = new Float64Array(n * R);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < R; c++) {
      rssi[i * R + c] = view.rssi[i * K + cols[c]];
      count[i * R + c] = view.count[i * K + cols[c]];
    }
  }
  const at = new Int32Array(K).fill(-1);
  cols.forEach((k, c) => (at[k] = c));
  const track = view.track.map((q) => ({ ...q, k: q.k >= 0 ? at[q.k] : -1 }));
  return { ...view, K: R, radios: cols.map((k) => view.radios[k]), rssi, count, track };
}

// Parado sem marcar ponto: quantas varreduras seguidas, e quão iguais.
const STILL = {
  minScans: 10, // ~35 s na cadência livre: menos que isto é pausa comum, que os motores já toleram
  maxGapS: 12, // varreduras mais espaçadas que isto não dizem que o usuário ficou no lugar
  sameDb: 4, // parado, uma varredura difere ~2,5 dB da média do trecho (ruído); a ~2 m dali, 6 a 8 dB
  strongDb: 3.5, // e os três rádios mais fortes do trecho, em média, menos que isto
  joinScans: 6, // dois trechos iguais separados por até 6 varreduras são a mesma parada
};

/**
 * Parou para atender o telefone? Os motores supõem que, entre duas varreduras "andando", o usuário
 * deu alguns passos: dezenas de varreduras seguidas no mesmo lugar, sem "marcar ponto", contradizem
 * isso e deformam o mapa inteiro (medido: 5 minutos parado custam até 20 pontos de nota). Um trecho
 * longo de varreduras seguidas com a MESMA impressão digital (cada uma dentro do ruído em torno da
 * média do trecho) é tratado como um ponto marcado pelo próprio solucionador: uma posição só, sem
 * passo esperado lá dentro. Devolve a própria visão quando não há nenhum trecho assim.
 */
function markStandstills(view) {
  const { n, K, rssi, time, floor } = view;
  if (n < STILL.minScans || !Number.isFinite(view.lowLevel)) return view;
  const fill = view.lowLevel - 2;
  const bins = new Int32Array(81);
  // Percentil 70 de |a - b| entre dois perfis de nível (NaN = não ouvido, entra no limiar).
  const profileGap = (levelA, levelB) => {
    bins.fill(0);
    let count = 0;
    for (let k = 0; k < K; k++) {
      const u = levelA(k);
      const v = levelB(k);
      const hasU = u === u;
      const hasV = v === v;
      if (!hasU && !hasV) continue;
      const gap = Math.abs((hasU ? u : fill) - (hasV ? v : fill));
      bins[gap >= 40 ? 80 : Math.round(2 * gap)]++;
      count++;
    }
    if (count < 4) return Infinity;
    let acc = 0;
    for (let b = 0; b <= 80; b++) {
      acc += bins[b];
      if (acc >= 0.7 * count) return b / 2;
    }
    return 40;
  };
  // Média do trecho em andamento: um rádio conta se foi ouvido em pelo menos metade das varreduras dele.
  const sum = new Float64Array(K);
  const cnt = new Int32Array(K);
  let length = 0;
  const add = (i) => {
    for (let k = 0; k < K; k++) {
      const v = rssi[i * K + k];
      if (v === v) {
        sum[k] += v;
        cnt[k]++;
      }
    }
    length++;
  };
  const meanOf = (k) => (cnt[k] >= 0.5 * length ? sum[k] / cnt[k] : NaN);
  // A varredura c cabe no trecho? A maioria dos rádios dentro do ruído em torno da média E os três
  // mais fortes também. Numa casa pequena quase todos os rádios são vizinhos distantes, que mal
  // mudam em 2 ou 3 metros: quem denuncia o movimento é o roteador de dentro de casa.
  const fits = (c) => {
    if (profileGap((k) => rssi[c * K + k], meanOf) > STILL.sameDb) return false;
    const top = [-1, -1, -1];
    for (let k = 0; k < K; k++) {
      const v = meanOf(k);
      if (v !== v) continue;
      let at = 3;
      while (at > 0 && (top[at - 1] < 0 || meanOf(top[at - 1]) < v)) at--;
      if (at < 3) {
        top.splice(at, 0, k);
        top.length = 3;
      }
    }
    let total = 0;
    let used = 0;
    for (const k of top) {
      if (k < 0) continue;
      const v = rssi[c * K + k];
      total += Math.abs((v === v ? v : fill) - meanOf(k));
      used++;
    }
    return used > 0 && total / used <= STILL.strongDb;
  };
  const runs = [];
  for (let from = 0; from < n; ) {
    if (view.spot[from] !== null) {
      from++;
      continue;
    }
    sum.fill(0);
    cnt.fill(0);
    length = 0;
    add(from);
    let to = from;
    for (;;) {
      // A próxima varredura que cabe na média do trecho; uma ou duas destoantes no meio (leitura
      // ruim, alguém passou na frente) não encerram a parada: ficam no trecho, fora da média.
      let next = -1;
      for (let c = to + 1; c <= to + 3 && c < n; c++) {
        if (view.spot[c] !== null || floor[c] !== floor[from] || time[c] - time[c - 1] > STILL.maxGapS) break;
        if (fits(c)) {
          next = c;
          break;
        }
      }
      if (next < 0) break;
      add(next);
      to = next;
    }
    if (length < STILL.minScans) {
      from++;
      continue;
    }
    runs.push({ from, to, mean: Float64Array.from(sum, (_, k) => meanOf(k)), key: runs.length });
    from = to + 1;
  }
  if (!runs.length) return view;
  // O ruído às vezes parte uma parada em duas: trechos vizinhos com a mesma média são um só.
  const spot = view.spot.slice();
  let places = 0;
  runs.forEach((run, r) => {
    const prev = r > 0 ? runs[r - 1] : null;
    let joined = !!prev && run.from - prev.to - 1 <= STILL.joinScans && floor[run.from] === floor[prev.from];
    for (let i = prev ? prev.to + 1 : 0; joined && i < run.from; i++) if (view.spot[i] !== null || time[i + 1] - time[i] > STILL.maxGapS) joined = false;
    if (joined && profileGap((k) => run.mean[k], (k) => prev.mean[k]) > STILL.sameDb) joined = false;
    run.key = joined ? prev.key : places++;
    // Chave que nenhum ponto marcado pelo usuário tem (as dele vêm de String(spot)).
    for (let i = joined ? prev.to + 1 : run.from; i <= run.to; i++) spot[i] = `\u0000parado:${run.key}`;
  });
  return { ...view, spot, standstills: places };
}

/**
 * Diferença típica (dB) entre as impressões digitais de duas varreduras: o percentil 70 de
 * |nível_i - nível_j| sobre os rádios ouvidos em pelo menos uma das duas (quem falta entra em
 * `fill`, o limiar de detecção). Percentil e não média: uns poucos rádios que mudaram por outro
 * motivo (ligaram, desligaram, beacon perdido) não escondem que o lugar é o mesmo. Infinity quando
 * os andares são diferentes ou há rádios de menos para comparar. `bins` é um rascunho de 81 casas.
 */
function fingerGap(view, i, j, fill, bins) {
  if (view.floor[i] !== view.floor[j]) return Infinity;
  const { K, rssi } = view;
  bins.fill(0);
  let count = 0;
  for (let k = 0; k < K; k++) {
    const u = rssi[i * K + k];
    const v = rssi[j * K + k];
    const hasU = u === u;
    const hasV = v === v;
    if (!hasU && !hasV) continue;
    const gap = Math.abs((hasU ? u : fill) - (hasV ? v : fill));
    bins[gap >= 40 ? 80 : Math.round(2 * gap)]++;
    count++;
  }
  if (count < 4) return Infinity;
  let acc = 0;
  for (let b = 0; b <= 80; b++) {
    acc += bins[b];
    if (acc >= 0.7 * count) return b / 2;
  }
  return 40;
}

// Rádio instável: quanto tempo calado, o que conta como "o mesmo lugar" e como "dava para ouvir".
const UNSTABLE = {
  minScans: 24, // com menos varreduras que isto não há voltas ao mesmo lugar para comparar
  minRun: 6, // varreduras seguidas sem ouvir o rádio (ou 12% do levantamento, o que for maior)
  minHits: 6,
  maxCompared: 400, // a comparação é quadrática: levantamentos maiores são amostrados
  apart: 4, // o "mesmo lugar" tem de ser uma VOLTA: a mais de 4 varreduras do trecho calado
  matchDb: 5, // impressões digitais a menos disto são o mesmo lugar (ruído de leitura: ~3 dB)
  clearDb: 10, // nível acima do limiar em que um rádio não passa despercebido
  minClashes: 4, // contradições (as fracas valem meia)...
  minClear: 3, // ...das quais pelo menos estas com o rádio chegando forte
};

/**
 * Rádios que ligaram ou desligaram NO MEIO do levantamento (o vizinho ligou o roteador, alguém
 * abriu o ponto de acesso do celular, um repetidor reiniciou). Os motores entendem "não ouvi" como
 * "estou longe dele": um rádio que só existe na segunda metade do tempo faz o mesmo cômodo parecer
 * dois lugares diferentes e o mapa se parte em dois (medido: a nota passa de 100, pior do que
 * juntar tudo num ponto só).
 *
 * O sinal de que a ausência é no TEMPO e não no espaço: o usuário voltou ao mesmo lugar (as outras
 * redes dizem isso) e lá o rádio, antes calado por um longo trecho, chega forte. Com várias voltas
 * assim o rádio é escondido dos motores por inteiro — perde-se a informação dele, mas o mapa não
 * se parte. Sem voltas ao mesmo lugar (um ponto a cada 30 s, poucas varreduras) não há como saber.
 *
 * @returns {number[]} índices dos rádios a esconder (quase sempre vazio)
 */
function unstableRadios(view) {
  const { n, K, rssi } = view;
  if (n < UNSTABLE.minScans || K < 5 || !Number.isFinite(view.lowLevel)) return [];
  const fill = view.lowLevel - 2;
  const clear = fill + UNSTABLE.clearDb;
  const stride = Math.ceil(n / UNSTABLE.maxCompared);
  const pick = [];
  for (let i = 0; i < n; i += stride) pick.push(i);
  const m = pick.length;
  const minRun = Math.max(UNSTABLE.minRun, Math.ceil(0.12 * m));
  // Candidatos: ouvidos forte em algum lugar e calados por um trecho longo e contínuo.
  const cands = [];
  for (let k = 0; k < K; k++) {
    let hits = 0;
    let top = -Infinity;
    let run = 0;
    let best = 0;
    let bestEnd = -1;
    for (let q = 0; q < m; q++) {
      const v = rssi[pick[q] * K + k];
      if (v === v) {
        hits++;
        if (v > top) top = v;
        run = 0;
      } else if (++run > best) {
        best = run;
        bestEnd = q;
      }
    }
    if (hits >= UNSTABLE.minHits && top >= clear && best >= minRun) cands.push({ k, from: bestEnd - best + 1, to: bestEnd });
  }
  if (!cands.length) return [];
  const bins = new Int32Array(81);
  const gap = new Float32Array(m * m);
  const hidden = [];
  // Um rádio que mudou atrapalha a própria comparação ("mesmo lugar" deixa de parecer o mesmo):
  // escondidos os mais evidentes, a comparação é refeita sem eles e outros aparecem.
  for (let round = 0; round < 4; round++) {
    const seen = hidden.length ? withoutRadios(view, hidden) : view;
    for (let p = 0; p < m; p++) for (let q = p + 1; q < m; q++) gap[p * m + q] = gap[q * m + p] = fingerGap(seen, pick[p], pick[q], fill, bins);
    const found = [];
    for (const { k, from, to } of cands) {
      if (hidden.includes(k)) continue;
      let matched = 0;
      let clashes = 0;
      let loud = 0;
      for (let p = from; p <= to; p++) {
        // A varredura mais parecida fora do trecho calado (e longe dele no tempo): uma volta ao lugar.
        let twin = -1;
        let nearest = UNSTABLE.matchDb;
        for (let q = 0; q < m; q++) {
          if (q >= from - UNSTABLE.apart && q <= to + UNSTABLE.apart) continue;
          if (gap[p * m + q] <= nearest) {
            nearest = gap[p * m + q];
            twin = q;
          }
        }
        if (twin < 0) continue;
        matched++;
        // Lá o rádio chega forte: contradição inteira. Chega fraco: meia (pode ser a borda do alcance).
        const level = rssi[pick[twin] * K + k];
        if (level >= clear) {
          clashes++;
          loud++;
        } else if (level === level) clashes += 0.5;
      }
      if (loud >= UNSTABLE.minClear && clashes >= UNSTABLE.minClashes && clashes >= 0.5 * matched) found.push(k);
    }
    if (!found.length) break;
    hidden.push(...found);
  }
  return hidden;
}

/** A mesma visão sem as leituras dos rádios de `hidden` (eles continuam na lista, sem nunca aparecer). */
function withoutRadios(view, hidden) {
  const { n, K } = view;
  const rssi = Float64Array.from(view.rssi);
  const count = Float64Array.from(view.count);
  for (const k of hidden) {
    for (let i = 0; i < n; i++) {
      rssi[i * K + k] = NaN;
      count[i * K + k] = 0;
    }
  }
  return { ...view, rssi, count };
}

/**
 * Posição dos rádios escondidos dos motores: a do outro rádio do mesmo aparelho, se ele foi
 * posicionado; senão o centro das varreduras onde chegou mais forte. Confiança baixa.
 * `part` tem x, y (por varredura de `view`) e aps.
 */
function placeHidden(view, hidden, part) {
  const { n, K, rssi, radios } = view;
  for (const k of hidden) {
    const seen = [];
    for (let i = 0; i < n; i++) if (rssi[i * K + k] === rssi[i * K + k]) seen.push(i);
    if (!seen.length) continue;
    seen.sort((p, q) => rssi[q * K + k] - rssi[p * K + k] || p - q);
    const top = seen.slice(0, 3);
    const peak = rssi[top[0] * K + k];
    let w = 0;
    let x = 0;
    let y = 0;
    for (const i of top) {
      const wi = Math.pow(10, (rssi[i * K + k] - peak) / 10);
      w += wi;
      x += wi * part.x[i];
      y += wi * part.y[i];
    }
    let ap = { x: x / w, y: y / w, z: view.floor[top[0]] * FLOOR_HEIGHT + 1, p0: Math.min(-20, peak + 5), n: 3, conf: 0.1 };
    for (const other of radios) {
      if (other === radios[k] || other.device !== radios[k].device) continue;
      const twin = other.ids.map((id) => part.aps[id]).find((a) => a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z));
      if (twin) ap = { ...ap, x: twin.x, y: twin.y, z: twin.z };
    }
    for (const id of radios[k].ids) if (!part.aps[id]) part.aps[id] = { ...ap };
  }
}

/** BSSIDs dos rádios escondidos (para o resumo; no máximo 20). */
function hiddenIds(view, hidden) {
  const ids = [];
  for (const k of hidden) for (const id of view.radios[k].ids) if (ids.length < 20) ids.push(id);
  return ids;
}

/**
 * Um levantamento de uma casa tem dois, três andares. Com andares demais (marcação errada, dados
 * corrompidos) o custo dos motores cresce com o número de andares e um deles nem terminava: os
 * motores recebem no máximo MAX_FLOORS, os mais visitados; as varreduras dos outros entram no andar
 * mantido mais próximo. A saída continua com o andar marcado em cada varredura (z = andar x pé-direito).
 */
function limitFloors(view) {
  const count = new Map();
  for (let i = 0; i < view.n; i++) count.set(view.floor[i], (count.get(view.floor[i]) || 0) + 1);
  if (count.size <= MAX_FLOORS) return view;
  const kept = [...count.entries()]
    .sort((p, q) => q[1] - p[1] || p[0] - q[0])
    .slice(0, MAX_FLOORS)
    .map((e) => e[0])
    .sort((p, q) => p - q);
  const nearest = new Map();
  for (const f of count.keys()) {
    let best = kept[0];
    for (const k of kept) if (Math.abs(k - f) < Math.abs(best - f)) best = k;
    nearest.set(f, best);
  }
  return { ...view, floor: Int32Array.from(view.floor, (f) => nearest.get(f)) };
}

/**
 * Leva a solução das varreduras resolvidas (`prepared.keep`) para todas. As que ficaram de fora
 * entram, com confiança menor:
 *   - pela impressão digital, quando o levantamento foi resolvido em blocos (placeByFingerprint);
 *   - junto das outras varreduras do mesmo ponto marcado, quando alguma foi resolvida;
 *   - por interpolação no tempo entre as vizinhas já colocadas (é o caso das varreduras sem
 *     nenhuma leitura fresca).
 * Devolve vetores do tamanho do levantamento e garante que as varreduras de um mesmo ponto marcado
 * dividam a posição.
 */
function expand(view, prepared, part) {
  const { keep } = prepared;
  const n = view.n;
  // Cópia dos roteadores: um motor pode devolver o mesmo objeto para vários BSSIDs, e daqui em
  // diante cada entrada é movida uma vez só.
  const aps = {};
  for (const [id, a] of Object.entries(part.aps || {})) if (a) aps[id] = { ...a };
  if (keep.length === n) {
    const full = { x: Float64Array.from(part.x), y: Float64Array.from(part.y), conf: Float64Array.from(part.conf), aps };
    shareSpots(view, full.x, full.y);
    return full;
  }
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const conf = new Float64Array(n);
  const placed = new Uint8Array(n); // 1 = resolvida pelos motores, 2 = colocada pela impressão digital
  keep.forEach((i, q) => {
    x[i] = part.x[q];
    y[i] = part.y[q];
    conf[i] = part.conf[q];
    placed[i] = 1;
  });
  // Ponto marcado com varreduras resolvidas: as outras varreduras dele ficam no mesmo lugar.
  const spotAt = new Map();
  for (const i of keep) if (view.spot[i] !== null && !spotAt.has(view.spot[i])) spotAt.set(view.spot[i], i);
  if (prepared.blocks > 1) placeByFingerprint(view, prepared, spotAt, x, y, conf, placed);
  const next = new Int32Array(n).fill(-1);
  for (let i = n - 1, at = -1; i >= 0; i--) {
    if (placed[i]) at = i;
    next[i] = at;
  }
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (placed[i]) {
      prev = i;
      continue;
    }
    const twin = view.spot[i] !== null ? spotAt.get(view.spot[i]) : undefined;
    const after = next[i];
    if (twin !== undefined) {
      x[i] = x[twin];
      y[i] = y[twin];
      conf[i] = 0.8 * conf[twin];
    } else if (prev >= 0 && after >= 0) {
      const span = view.time[after] - view.time[prev];
      const u = span > 0 ? clamp((view.time[i] - view.time[prev]) / span, 0, 1) : 0.5;
      x[i] = x[prev] + u * (x[after] - x[prev]);
      y[i] = y[prev] + u * (y[after] - y[prev]);
      conf[i] = 0.7 * Math.min(conf[prev], conf[after]);
    } else if (prev >= 0 || after >= 0) {
      const src = prev >= 0 ? prev : after;
      x[i] = x[src];
      y[i] = y[src];
      conf[i] = 0.5 * conf[src];
    }
  }
  shareSpots(view, x, y);
  return { x, y, conf, aps };
}

/**
 * Levantamento resolvido em blocos: as varreduras de fora deles já têm um mapa onde cair. Cada uma
 * vai para a média das posições das 4 varreduras resolvidas de impressão digital mais parecida, no
 * mesmo andar (é a localização por "fingerprinting" de sempre, com o mapa que os motores acabaram
 * de fazer). Duas passadas de média com as vizinhas no tempo tiram o serrilhado: quem anda não
 * pula de um canto para o outro entre duas varreduras. Varredura sem parecida nenhuma (outro
 * andar, leituras de menos) fica para a interpolação no tempo. Mexe em x, y, conf e placed.
 */
function placeByFingerprint(view, prepared, spotAt, x, y, conf, placed) {
  const { n } = view;
  if (!Number.isFinite(view.lowLevel)) return;
  // Compara pelos mesmos rádios que os motores usaram.
  const seen = prepared.cols.length < view.K ? pickRadios(view, prepared.cols) : view;
  const fill = view.lowLevel - 2;
  const bins = new Int32Array(81);
  // Referências: as varreduras resolvidas (amostradas quando são muitas: a busca é quadrática).
  const stride = Math.ceil(prepared.keep.length / 500);
  const refs = prepared.keep.filter((_, q) => q % stride === 0);
  const NEAR = 4;
  const gapOf = new Float64Array(NEAR);
  const refOf = new Int32Array(NEAR);
  const added = [];
  for (let i = 0; i < n; i++) {
    if (placed[i] || view.fresh[i] === 0) continue;
    if (view.spot[i] !== null && spotAt.has(view.spot[i])) continue; // vai junto do ponto marcado
    gapOf.fill(Infinity);
    refOf.fill(-1);
    for (const j of refs) {
      const gap = fingerGap(seen, i, j, fill, bins);
      if (!(gap < gapOf[NEAR - 1])) continue;
      let at = NEAR - 1;
      while (at > 0 && gapOf[at - 1] > gap) {
        gapOf[at] = gapOf[at - 1];
        refOf[at] = refOf[at - 1];
        at--;
      }
      gapOf[at] = gap;
      refOf[at] = j;
    }
    if (refOf[0] < 0) continue;
    let w = 0;
    let sx = 0;
    let sy = 0;
    let sc = 0;
    for (let q = 0; q < NEAR && refOf[q] >= 0; q++) {
      const wq = 1 / ((1 + gapOf[q]) * (1 + gapOf[q]));
      w += wq;
      sx += wq * x[refOf[q]];
      sy += wq * y[refOf[q]];
      sc += wq * conf[refOf[q]];
    }
    x[i] = sx / w;
    y[i] = sy / w;
    // Parecida de verdade (~3 dB) vale quase o que vale a referência; pouco parecida, bem menos.
    conf[i] = (0.75 * sc * clamp(1.3 - gapOf[0] / 10, 0.3, 1)) / w;
    added.push(i);
  }
  for (const i of added) placed[i] = 2;
  for (let pass = 0; pass < 2; pass++) {
    const px = Float64Array.from(x);
    const py = Float64Array.from(y);
    for (const i of added) {
      let sx = 0;
      let sy = 0;
      let c = 0;
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= n || !placed[j] || view.floor[j] !== view.floor[i] || Math.abs(view.time[j] - view.time[i]) > 8) continue;
        sx += px[j];
        sy += py[j];
        c++;
      }
      if (!c) continue;
      x[i] = 0.5 * px[i] + (0.5 * sx) / c;
      y[i] = 0.5 * py[i] + (0.5 * sy) / c;
    }
  }
}

/**
 * Tamanho máximo que um mapa pode ter. Quem anda a no máximo ~2 m/s durante T segundos não se
 * afasta do centro do próprio caminho mais do que 0,3 x 2 x T (raio rms de uma reta), e um
 * levantamento de Wi-Fi não passa de algumas centenas de metros. Um mapa maior do que isso é conta
 * que degenerou: é encolhido até o teto (em torno do centro, roteadores juntos) e a escala passa a
 * valer nada. Quem desenha o mapa aloca uma grade do tamanho dele: sem teto, um número absurdo
 * aqui derrubava a etapa seguinte. Devolve false quando precisou encolher.
 */
function capSize(view, full) {
  const { x, y } = full;
  const { cx, cy, radius } = cloudStats(x, y);
  const duration = view.n > 1 ? view.time[view.n - 1] - view.time[0] : 0;
  const limit = clamp(0.6 * duration, 15, MAX_RADIUS_M);
  if (!(radius > limit)) return true;
  const k = limit / radius;
  for (let i = 0; i < view.n; i++) {
    x[i] = (x[i] - cx) * k;
    y[i] = (y[i] - cy) * k;
  }
  for (const a of Object.values(full.aps)) {
    a.x = (a.x - cx) * k;
    a.y = (a.y - cy) * k;
    a.p0 += 10 * a.n * Math.log10(k);
  }
  return false;
}

/** Monta a MapSolution: z pelo andar marcado, tudo finito, confianças em 0..1. */
function toSolution(view, full, scaleConf) {
  const points = new Array(view.n);
  for (let i = 0; i < view.n; i++) {
    // Posição que não é número (não deveria acontecer) vai para a origem com confiança zero.
    const ok = Number.isFinite(full.x[i]) && Number.isFinite(full.y[i]);
    points[i] = { x: ok ? full.x[i] : 0, y: ok ? full.y[i] : 0, z: view.floor[i] * FLOOR_HEIGHT, conf: ok ? clamp(finite(full.conf[i]), 0, 1) : 0 };
  }
  const aps = {};
  for (const [id, a] of Object.entries(full.aps)) {
    if (![a.x, a.y, a.z, a.p0, a.n, a.conf].every(Number.isFinite)) continue;
    aps[id] = { x: a.x, y: a.y, z: a.z, p0: a.p0, n: a.n, conf: clamp(a.conf, 0, 1) };
  }
  return { points, aps, scaleConf: clamp(finite(scaleConf), 0, 1) };
}

// ---------------------------------------------------------------------------
// Consenso
// ---------------------------------------------------------------------------

/**
 * Junta as soluções dos motores numa só.
 *
 * 1. Forma e tamanho separados: cada solução é centrada e dividida pelo seu raio (rms).
 * 2. Referencial comum: parte da solução mais parecida com as outras e alinha todas a ela por
 *    rotação + espelho (sem escala); a média vira a nova referência e o alinhamento se repete
 *    (análise de Procrustes generalizada, 3 voltas bastam).
 * 3. Posição = média simples das formas alinhadas. A média de formas que discordam sai um pouco
 *    menor que cada uma, e isso fica: um mapa incerto erra menos encolhido do que inflado.
 * 4. Tamanho = média geométrica dos raios.
 * 5. Roteadores: média pesada pela confiança, no mesmo referencial (a altura é a do motor mais
 *    confiante: média de alturas cairia entre dois andares); os BSSIDs de um aparelho ficam juntos.
 *    Roteador que só parte dos motores posicionou sai com confiança menor.
 *
 * @returns {{x, y, conf, aps, scaleConf, agreementM, expectedErrorM, pool}}  `pool`: índices das soluções que entraram na média
 */
function combine(results, view) {
  const n = view.n;
  // Solução sem tamanho (tudo num ponto só) não tem forma para alinhar: fica de fora se houver outra.
  const stats = results.map((r) => cloudStats(r.x, r.y));
  let pool = results.map((_, c) => c).filter((c) => stats[c].radius > 1e-6);
  pool = agreeingOnSize(pool, stats, results);
  if (!pool.length) pool = [0];
  const C = pool.length;
  const shapes = pool.map((c) => {
    const { cx, cy, radius } = stats[c];
    const s = radius > 1e-6 ? radius : 1;
    return { x: Float64Array.from(results[c].x, (v) => (v - cx) / s), y: Float64Array.from(results[c].y, (v) => (v - cy) / s), scale: s, cx, cy };
  });
  // Referência inicial: a solução mais próxima das outras (medoide).
  let ref = 0;
  if (C > 2) {
    let best = Infinity;
    for (let c = 0; c < C; c++) {
      let total = 0;
      for (let d = 0; d < C; d++) if (d !== c) total += fitRigid(shapes[d].x, shapes[d].y, shapes[c].x, shapes[c].y).rms;
      if (total < best) {
        best = total;
        ref = c;
      }
    }
  }
  let mx = Float64Array.from(shapes[ref].x);
  let my = Float64Array.from(shapes[ref].y);
  const ax = shapes.map(() => new Float64Array(n));
  const ay = shapes.map(() => new Float64Array(n));
  const fits = new Array(C);
  for (let round = 0; round < 3; round++) {
    for (let c = 0; c < C; c++) {
      fits[c] = fitRigid(shapes[c].x, shapes[c].y, mx, my);
      for (let i = 0; i < n; i++) {
        const p = fits[c].apply(shapes[c].x[i], shapes[c].y[i]);
        ax[c][i] = p[0];
        ay[c][i] = p[1];
      }
    }
    mx = new Float64Array(n);
    my = new Float64Array(n);
    for (let c = 0; c < C; c++) {
      for (let i = 0; i < n; i++) {
        mx[i] += ax[c][i] / C;
        my[i] += ay[c][i] / C;
      }
    }
    if (C === 1) break;
  }
  // Tamanho: média geométrica (erros de escala multiplicam).
  let logSize = 0;
  for (const s of shapes) logSize += Math.log(s.scale) / C;
  const size = Math.exp(logSize);
  let logSpread = 0; // quanto os motores discordam no tamanho
  for (const s of shapes) logSpread += (Math.log(s.scale) - logSize) ** 2 / C;
  logSpread = Math.sqrt(logSpread);

  const poor = fewRadiosFactor(view);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const conf = new Float64Array(n);
  const spreads = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = mx[i] * size;
    y[i] = my[i] * size;
    // Discordância no ponto: distância rms dos motores à média, em metros.
    let s2 = 0;
    let own = 0;
    for (let c = 0; c < C; c++) {
      s2 += ((ax[c][i] - mx[i]) ** 2 + (ay[c][i] - my[i]) ** 2) / C;
      own += results[pool[c]].conf[i] / C;
    }
    // Com menos motores a distância à média subestima a discordância: acerta para o equivalente a quatro.
    spreads[i] = C > 1 ? Math.sqrt(s2) * size * Math.sqrt((0.75 * C) / (C - 1)) : NaN;
    conf[i] = C > 1 ? 1 / (1 + ((poor * (POINT_ERR_FLOOR_M + POINT_ERR_PER_SPREAD * spreads[i])) / CONF_HALF_M) ** 2) : own / (poor * poor);
  }
  const agreementM = C > 1 ? median(spreads) : NaN;

  // Roteadores no referencial comum.
  const toCommon = (c, px, py) => {
    const s = shapes[c];
    const p = fits[c].apply((px - s.cx) / s.scale, (py - s.cy) / s.scale);
    return [p[0] * size, p[1] * size];
  };
  const acc = new Map(); // BSSID -> somas
  for (let c = 0; c < C; c++) {
    const zoom = size / shapes[c].scale; // o mapa deste motor foi esticado por este fator
    for (const [id, a] of Object.entries(results[pool[c]].aps || {})) {
      if (!a || ![a.x, a.y, a.z, a.p0, a.n, a.conf].every(Number.isFinite)) continue;
      const w = Math.max(0.02, a.conf);
      const [px, py] = C > 1 ? toCommon(c, a.x, a.y) : [a.x, a.y];
      let e = acc.get(id);
      if (!e) acc.set(id, (e = { w: 0, x: 0, y: 0, z: a.z, top: a.conf, p0: 0, n: 0, conf: 0 }));
      e.w += w;
      e.x += w * px;
      e.y += w * py;
      if (a.conf > e.top) {
        e.top = a.conf;
        e.z = a.z;
      }
      // p0 é o nível a 1 m NA ESCALA do mapa: se o mapa estica, as distâncias esticam junto.
      e.p0 += w * (a.p0 + (C > 1 ? 10 * a.n * Math.log10(zoom) : 0));
      e.n += w * a.n;
      e.conf += a.conf;
    }
  }
  const aps = {};
  for (const [id, e] of acc) aps[id] = { x: e.x / e.w, y: e.y / e.w, z: e.z, p0: e.p0 / e.w, n: e.n / e.w, conf: e.conf / C };
  gatherDevices(view, aps);

  // Escala: a confiança que os motores declaram (cada um sabe de onde tirou a sua régua: passo
  // cronometrado, física, ou quase nada), rebaixada quando eles discordam no tamanho e em espaços
  // grandes — ali todos encolhem o mapa (a corda entre duas varreduras corta caminho): na bancada
  // o escritório de 20 x 14 m saiu em média 25% menor, contra 10% nas casas.
  let scaleConf = 0;
  for (const c of pool) scaleConf += results[c].scaleConf / C;
  if (C > 1) scaleConf *= clamp(1.15 - 1.5 * logSpread, 0.5, 1);
  scaleConf *= clamp(1 - 0.16 * (cloudStats(x, y).radius - 3.5), 0.6, 1);
  scaleConf /= poor * poor;
  const expectedErrorM = C > 1 ? poor * (SURVEY_ERR_FLOOR_M + SURVEY_ERR_PER_SPREAD * agreementM) : NaN;
  return { x, y, conf, aps, scaleConf, agreementM, expectedErrorM, pool };
}

/**
 * Quanto o erro esperado cresce por haver poucas redes à vista: 1 com FEW_RADIOS rádios úteis ou
 * mais (ouvidos em pelo menos 10% das varreduras), FEW_RADIOS_PENALTY com três ou menos.
 */
function fewRadiosFactor(view) {
  const { n, K, rssi } = view;
  const enough = Math.max(3, 0.1 * n);
  let radios = 0;
  for (let k = 0; k < K && radios < FEW_RADIOS; k++) {
    let hits = 0;
    for (let i = 0; i < n && hits < enough; i++) if (rssi[i * K + k] === rssi[i * K + k]) hits++;
    if (hits >= enough) radios++;
  }
  return 1 + (FEW_RADIOS_PENALTY - 1) * clamp((FEW_RADIOS - radios) / 3, 0, 1);
}

/**
 * Tira do consenso o motor cujo mapa tem tamanho muito diferente do dos outros (mais de
 * SIZE_OUTLIER vezes): depois de normalizada, a forma de um mapa quase colapsado é só ruído, e uma
 * escala que explodiu levaria a média geométrica junto. A referência é a mediana dos tamanhos,
 * pesada pela confiança que cada motor declara na própria escala (o motor que colapsou avisa).
 * Com dois motores que não se entendem, fica o que mais confia na sua.
 */
function agreeingOnSize(pool, stats, results) {
  if (pool.length < 2) return pool;
  const limit = Math.log(SIZE_OUTLIER);
  const size = (c) => Math.log(stats[c].radius);
  const trust = (c) => Math.max(0, finite(results[c].scaleConf)) + 0.01;
  if (pool.length === 2) {
    if (Math.abs(size(pool[0]) - size(pool[1])) <= limit) return pool;
    return [trust(pool[1]) > trust(pool[0]) ? pool[1] : pool[0]];
  }
  const order = pool.slice().sort((p, q) => size(p) - size(q));
  const half = 0.5 * order.reduce((t, c) => t + trust(c), 0);
  let acc = 0;
  let mid = size(order[order.length - 1]);
  for (const c of order) {
    acc += trust(c);
    if (acc >= half) {
      mid = size(c);
      break;
    }
  }
  return pool.filter((c) => Math.abs(size(c) - mid) <= limit);
}

/** Os BSSIDs de um mesmo aparelho são uma caixa só: ficam na mesma posição (média pesada pela confiança; altura do mais confiante). */
function gatherDevices(view, aps) {
  const byDevice = new Map();
  for (const radio of view.radios) {
    for (const id of radio.ids) {
      if (!aps[id]) continue;
      if (!byDevice.has(radio.device)) byDevice.set(radio.device, []);
      byDevice.get(radio.device).push(aps[id]);
    }
  }
  for (const list of byDevice.values()) {
    if (list.length < 2) continue;
    let w = 0;
    let x = 0;
    let y = 0;
    let top = list[0];
    for (const a of list) {
      const wa = Math.max(0.02, a.conf);
      w += wa;
      x += wa * a.x;
      y += wa * a.y;
      if (a.conf > top.conf) top = a;
    }
    const z = top.z;
    for (const a of list) {
      a.x = x / w;
      a.y = y / w;
      a.z = z;
    }
  }
}

// ---------------------------------------------------------------------------
// Distâncias medidas pelo usuário
// ---------------------------------------------------------------------------

/** Pares de `survey.knownDistances` que dá para usar: [{a, b, meters}] com a distância no plano. */
function knownPairs(survey, view) {
  const out = [];
  for (const kd of survey && Array.isArray(survey.knownDistances) ? survey.knownDistances : []) {
    if (!kd || !Number.isInteger(kd.a) || !Number.isInteger(kd.b) || !Number.isFinite(kd.meters) || !(kd.meters > 0)) continue;
    if (kd.meters > KNOWN_MAX_M) continue; // erro de digitação (ou outra unidade): esticaria o mapa até o absurdo
    if (kd.a < 0 || kd.b < 0 || kd.a >= view.n || kd.b >= view.n || kd.a === kd.b) continue;
    if (view.spot[kd.a] !== null && view.spot[kd.a] === view.spot[kd.b]) continue; // mesmo ponto: distância zero
    // A medida é no espaço; no mapa conta a parte horizontal.
    const dz = (view.floor[kd.a] - view.floor[kd.b]) * FLOOR_HEIGHT;
    const flat = Math.sqrt(Math.max(0, kd.meters * kd.meters - dz * dz));
    if (flat > 0.05) out.push({ a: kd.a, b: kd.b, meters: flat });
  }
  return out;
}

/**
 * Aplica as distâncias medidas. Devolve o quanto elas mandaram na escala (0..1; 0 = nada).
 *
 * - Escala: o fator que melhor leva as distâncias do mapa às medidas, aplicado na proporção da
 *   confiança da base, trust = Σm² / (Σm² + KNOWN_BASE_M2). A distância entre dois pontos DO MAPA
 *   erra uns 2 m (cada ponto tem ~1,5 m de erro, e o mapa é deformado), então uma base de 4 m mede
 *   a escala pior do que o passo de quem anda (que erra ~15-20%), e só uma de 10 m ou mais manda
 *   de verdade. Medido na bancada: acreditar por inteiro numa única medida PIORA o mapa em ~5
 *   pontos de nota; com este peso, bases curtas não estragam e as longas ajudam.
 * - Se a medida discorda do mapa por mais do que um erro de escala plausível (2x), o problema é de
 *   FORMA (os dois pontos estão mal colocados entre si): esticar o mapa inteiro estragaria o resto,
 *   e a escala fica como está.
 * - Em qualquer caso cada par medido sai EXATAMENTE com a distância pedida: os dois extremos (e as
 *   varreduras do mesmo ponto marcado) se afastam ou se aproximam por igual.
 * - Menos as medidas absurdas (mais de KNOWN_MAX_M, ou mais de 4 vezes o diâmetro do mapa): essas
 *   são ignoradas por inteiro.
 */
function applyKnownDistances(view, known, full) {
  if (!known.length) return 0;
  const { x, y } = full;
  // Medida muito maior do que o mapa inteiro não é um erro do mapa, é da medida (4,2 m digitado
  // como 42): honrá-la jogaria dois pontos para fora da casa. Fica de fora.
  const { cx: mx, cy: my } = cloudStats(x, y);
  let reach = 0;
  for (let i = 0; i < view.n; i++) reach = Math.max(reach, Math.hypot(x[i] - mx, y[i] - my));
  const longest = Math.max(10, 8 * reach); // 8 x o raio = 4 x o diâmetro do mapa
  const pairs = known.filter((kd) => kd.meters <= longest);
  if (!pairs.length || !Number.isFinite(reach)) return 0;
  let num = 0;
  let den = 0;
  let base2 = 0;
  for (const kd of pairs) {
    const d = Math.hypot(x[kd.a] - x[kd.b], y[kd.a] - y[kd.b]);
    num += kd.meters * d;
    den += d * d;
    base2 += kd.meters * kd.meters;
  }
  const factor = den > 1e-9 ? num / den : NaN;
  const plausible = factor > 0.5 && factor < 2;
  const trust = plausible ? base2 / (base2 + KNOWN_BASE_M2) : 0;
  if (plausible) {
    const k = Math.pow(factor, trust);
    const { cx, cy } = cloudStats(x, y);
    for (let i = 0; i < view.n; i++) {
      x[i] = cx + (x[i] - cx) * k;
      y[i] = cy + (y[i] - cy) * k;
    }
    for (const a of Object.values(full.aps)) {
      a.x = cx + (a.x - cx) * k;
      a.y = cy + (a.y - cy) * k;
      a.p0 += 10 * a.n * Math.log10(k);
    }
  }
  // Par exato: move cada extremo, com todas as varreduras do mesmo ponto marcado.
  const move = (i, dx, dy) => {
    for (let j = 0; j < view.n; j++) {
      if (j === i || (view.spot[i] !== null && view.spot[j] === view.spot[i])) {
        x[j] += dx;
        y[j] += dy;
      }
    }
  };
  // (Com várias medidas que dividem um ponto, acertar um par desfaz um pouco o outro: algumas voltas.)
  for (let pass = 0; pass < (pairs.length > 1 ? 8 : 1); pass++) {
    for (const kd of pairs) {
      const dx = x[kd.b] - x[kd.a];
      const dy = y[kd.b] - y[kd.a];
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        move(kd.b, kd.meters, 0);
        continue;
      }
      const shift = (0.5 * (kd.meters - d)) / d;
      move(kd.a, -shift * dx, -shift * dy);
      move(kd.b, shift * dx, shift * dy);
    }
  }
  return trust;
}

// ---------------------------------------------------------------------------
// Referencial de saída
// ---------------------------------------------------------------------------

/**
 * Põe o mapa no referencial de saída. Sem solução anterior: origem no centro dos pontos e eixo x
 * na direção de maior espalhamento (convenção de types.js). Com solução anterior do mesmo
 * levantamento: encaixa a nova sobre ela (rotação + espelho + translação, sem mexer na escala)
 * pelas varreduras que as duas têm, para o mapa não girar nem espelhar na tela.
 */
function orient(view, full, previous) {
  const n = view.n;
  const { x, y } = full;
  let place = null;
  const prev = previous && Array.isArray(previous.points) ? previous.points : null;
  if (prev) {
    const only = [];
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    for (let i = 0; i < Math.min(n, prev.length); i++) {
      const p = prev[i];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      px[i] = p.x;
      py[i] = p.y;
      only.push(i);
    }
    if (only.length >= 3) {
      // Só vale se as duas nuvens têm forma (uma prévia colapsada não orienta nada).
      const ox = only.map((i) => x[i]);
      const oy = only.map((i) => y[i]);
      const qx = only.map((i) => px[i]);
      const qy = only.map((i) => py[i]);
      if (cloudStats(ox, oy).radius > 0.05 && cloudStats(qx, qy).radius > 0.05) place = fitRigid(x, y, px, py, { only }).apply;
    }
    // Solução anterior com lixo (coordenadas absurdas): o encaixe levaria o mapa junto. Vale o referencial próprio.
    if (place) {
      for (let i = 0; i < n && place; i++) {
        const p = place(x[i], y[i]);
        if (!(Math.abs(p[0]) <= MAX_COORD_M) || !(Math.abs(p[1]) <= MAX_COORD_M)) place = null;
      }
    }
  }
  if (!place) {
    const { cx, cy } = cloudStats(x, y);
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (x[i] - cx) * (x[i] - cx);
      sxy += (x[i] - cx) * (y[i] - cy);
      syy += (y[i] - cy) * (y[i] - cy);
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    place = (px, py) => [c * (px - cx) + s * (py - cy), -s * (px - cx) + c * (py - cy)];
  }
  for (let i = 0; i < n; i++) {
    const p = place(x[i], y[i]);
    x[i] = p[0];
    y[i] = p[1];
  }
  for (const a of Object.values(full.aps)) {
    const p = place(a.x, a.y);
    a.x = p[0];
    a.y = p[1];
  }
}
