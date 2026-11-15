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
// Determinístico (nenhum sorteio; `options.seed` é aceito e não muda nada), nunca lança erro e
// roda num Web Worker: só importa os módulos solver-* desta pasta e types.js.

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
  version: '1.0.0',
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
/** Acima disto as visitas são raleadas antes de resolver (o custo dos motores cresce com o quadrado ou o cubo). */
const MAX_VISITS = 300;
const QUICK_MAX_VISITS = 240;

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
 * @returns {Promise<import('./types.js').MapSolution>}  `debug` traz os motores usados, os tempos, a
 *          discordância mediana entre eles (agreementM) e o erro esperado (expectedErrorM)
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
  const { sub, keep } = reduceView(view, MAX_VISITS);

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
    const out = collapsed(survey, stopped ? 'cancelado' : 'nenhum motor conseguiu resolver');
    out.debug.cancelled = stopped;
    return out;
  }

  progress(0.92, 'Juntando as soluções');
  const merged = combine(results, sub);
  const full = expand(view, keep, merged);
  const known = knownPairs(survey, view);
  const trust = applyKnownDistances(view, known, full);
  orient(view, full, options.previous);
  const solution = toSolution(view, full, trust > 0 ? Math.max(merged.scaleConf, 0.95 * trust) : merged.scaleConf);
  solution.debug = {
    members: used,
    skipped,
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
    const { sub, keep } = reduceView(view, QUICK_MAX_VISITS);
    if (sub.n === 0) return collapsed(survey, 'sem leituras');
    const r = solveIsomap(sub, { budgetMs: Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : 60000 });
    if (!usable(r, sub.n)) return collapsed(survey, 'prévia sem solução');
    // Um motor só: não há discordância para medir; fica a confiança dele, rebaixada (é só a prévia).
    const conf = Float64Array.from(r.conf, (c) => 0.8 * c);
    const full = expand(view, keep, { x: r.x, y: r.y, conf, aps: r.aps });
    const trust = applyKnownDistances(view, knownPairs(survey, view), full);
    orient(view, full, opts.previous);
    const solution = toSolution(view, full, trust > 0 ? Math.max(0.8 * r.scaleConf, 0.95 * trust) : 0.8 * r.scaleConf);
    solution.debug = { members: [{ name: 'isomap', ms: Math.round(now() - t0) }], skipped: [], quick: true };
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
  const points = scans.map((s) => ({ x: 0, y: 0, z: floorOf(s) * FLOOR_HEIGHT, conf: 0 }));
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

/** A resposta de um motor serve? (tamanho certo e tudo finito) */
function usable(r, n) {
  if (!r || !r.x || !r.y || !r.conf || r.x.length !== n || r.y.length !== n || r.conf.length !== n) return false;
  for (let i = 0; i < n; i++) if (!Number.isFinite(r.x[i]) || !Number.isFinite(r.y[i]) || !Number.isFinite(r.conf[i])) return false;
  return Number.isFinite(r.scaleConf);
}

/**
 * O que os motores recebem: só as varreduras que dizem algo (com pelo menos uma leitura fresca;
 * as outras confundem as comparações de impressão digital) e, em levantamentos enormes, uma
 * visita a cada `stride`. As que ficam de fora são colocadas depois por interpolação no tempo.
 */
function reduceView(view, maxVisits) {
  let keep = [];
  for (let i = 0; i < view.n; i++) if (view.fresh[i] > 0) keep.push(i);
  let sub = keep.length === view.n ? view : pickScans(view, keep);
  const visits = visitsOf(sub);
  if (visits.length > maxVisits) {
    const stride = Math.ceil(visits.length / maxVisits);
    const thin = [];
    visits.forEach((v, j) => {
      if (j % stride === 0) for (const q of v.members) thin.push(keep[q]);
    });
    keep = thin;
    sub = pickScans(view, keep);
  }
  return { sub, keep };
}

/**
 * Leva a solução das varreduras resolvidas (`keep`) para todas: as que ficaram de fora entram por
 * interpolação no tempo entre as vizinhas resolvidas, com confiança menor. Devolve vetores do
 * tamanho do levantamento e garante que as varreduras de um mesmo ponto marcado dividam a posição.
 */
function expand(view, keep, part) {
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
  const solved = new Int32Array(n).fill(-1);
  keep.forEach((i, q) => {
    x[i] = part.x[q];
    y[i] = part.y[q];
    conf[i] = part.conf[q];
    solved[i] = q;
  });
  const next = new Int32Array(n).fill(-1);
  for (let i = n - 1, at = -1; i >= 0; i--) {
    if (solved[i] >= 0) at = i;
    next[i] = at;
  }
  // Ponto marcado com varreduras resolvidas: as outras varreduras dele ficam no mesmo lugar.
  const spotAt = new Map();
  for (const i of keep) if (view.spot[i] !== null && !spotAt.has(view.spot[i])) spotAt.set(view.spot[i], i);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (solved[i] >= 0) {
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

/** Monta a MapSolution: z pelo andar marcado, tudo finito, confianças em 0..1. */
function toSolution(view, full, scaleConf) {
  const points = new Array(view.n);
  for (let i = 0; i < view.n; i++) {
    points[i] = { x: finite(full.x[i]), y: finite(full.y[i]), z: view.floor[i] * FLOOR_HEIGHT, conf: clamp(finite(full.conf[i]), 0, 1) };
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
 * @returns {{x, y, conf, aps, scaleConf, agreementM, expectedErrorM}}
 */
function combine(results, view) {
  const n = view.n;
  // Solução sem tamanho (tudo num ponto só) não tem forma para alinhar: fica de fora se houver outra.
  const stats = results.map((r) => cloudStats(r.x, r.y));
  let pool = results.map((_, c) => c).filter((c) => stats[c].radius > 1e-6);
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
    conf[i] = C > 1 ? 1 / (1 + ((POINT_ERR_FLOOR_M + POINT_ERR_PER_SPREAD * spreads[i]) / CONF_HALF_M) ** 2) : own;
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
  const expectedErrorM = C > 1 ? SURVEY_ERR_FLOOR_M + SURVEY_ERR_PER_SPREAD * agreementM : NaN;
  return { x, y, conf, aps, scaleConf, agreementM, expectedErrorM };
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
 */
function applyKnownDistances(view, pairs, full) {
  if (!pairs.length) return 0;
  const { x, y } = full;
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
