// O trabalho pesado do mapa: solucionador (onde cada varredura foi feita) + construtor do modelo.
//
// Este módulo tem dois usos:
//   1. como Web Worker de módulo — engine.js faz new Worker('worker.js', { type: 'module' }) e
//      conversa por mensagens, para a tela continuar viva enquanto o mapa é calculado;
//   2. importado direto (runJob), como caminho de reserva na thread principal quando o WebView
//      não tem Worker de módulo, e nos testes em Node.
//
// Mensagens (só engine.js fala com este arquivo):
//   worker -> página   { type: 'ready', solver }                       assim que carrega
//   página -> worker   { type: 'run', id, survey, own, quick, previous, budgetMs, seed }
//   worker -> página   { type: 'progress', id, fraction, label }
//                      { type: 'done', id, solution, model, ms, solveMs, buildMs }   (os vetores do modelo são transferidos)
//                      { type: 'error', id, name, message }
// Não há mensagem de cancelamento: o solucionador ocupa a thread sem ceder a vez, então quem
// cancela é a página, encerrando o worker (engine.js cria outro).

import { buildMap } from './mapmodel.js';

const clock = () => (typeof performance === 'object' && performance && typeof performance.now === 'function' ? performance.now() : Date.now());

/** Erro de "trabalho cancelado" (o mesmo nome que o navegador usa: AbortError). */
export function abortError(message = 'cálculo do mapa cancelado') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

// ---------------------------------------------------------------------------
// Solucionador
// ---------------------------------------------------------------------------
// Provisório: enquanto app/js/mapping/solver.js não existe, vale o melhor candidato da bancada
// (candidates/geo.js). Quando o solver.js chegar, loadSolver vira só o import dele.

let solverPromise = null;

function adaptCandidate(mod) {
  const solve = mod.solve;
  return {
    info: { name: 'geo (provisório)', version: 0 },
    solve: (survey, options = {}) => solve(survey, { seed: options.seed, budgetMs: options.budgetMs, onProgress: options.onProgress }),
    // prévia rápida: o mesmo método com pouco tempo, partindo da solução anterior quando ela serve
    solveQuick: (survey, options = {}) => solve(survey, { budgetMs: options.budgetMs ?? 700, warmStart: options.previous || undefined }),
  };
}

function adaptOfficial(mod) {
  const solve = mod.solve;
  if (typeof solve !== 'function') throw new Error('solver.js sem solve()');
  const quick = typeof mod.solveQuick === 'function' ? mod.solveQuick : (survey, options = {}) => solve(survey, { budgetMs: options.budgetMs ?? 700 });
  return { info: mod.SOLVER_INFO || { name: 'solver' }, solve, solveQuick: quick };
}

/** Carrega o solucionador uma vez só (import dinâmico: só pesa quando o primeiro mapa é pedido). */
export function loadSolver() {
  if (!solverPromise) {
    solverPromise = import('./solver.js').then(adaptOfficial, () => import('./candidates/geo.js').then(adaptCandidate));
    solverPromise.catch(() => {
      solverPromise = null; // falhou (rede?): a próxima tentativa começa do zero
    });
  }
  return solverPromise;
}

// ---------------------------------------------------------------------------
// O trabalho
// ---------------------------------------------------------------------------

function validSolution(solution, survey) {
  const n = Array.isArray(survey && survey.scans) ? survey.scans.length : 0;
  if (!solution || typeof solution !== 'object' || !Array.isArray(solution.points) || solution.points.length !== n) return false;
  for (const p of solution.points) if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  return solution.aps !== null && typeof solution.aps === 'object';
}

/**
 * @typedef {Object} MapJob
 * @property {import('./types.js').Survey} survey
 * @property {string[]} [own]         BSSIDs das redes do usuário
 * @property {boolean} [quick]        prévia rápida (solveQuick) em vez da solução completa
 * @property {import('./types.js').MapSolution|null} [previous]  solução anterior, ponto de partida da prévia
 * @property {number} [budgetMs]
 * @property {number} [seed]
 */

/**
 * Resolve o levantamento e monta o modelo do mapa.
 *
 * @param {MapJob} job
 * @param {object} [hooks]
 * @param {(fraction:number, label:string) => void} [hooks.onProgress]  0..1; no máximo ~100 avisos
 * @param {{cancelled:boolean}} [hooks.signal]   ligado por quem cancela; conferido entre as etapas (e pelo solucionador)
 * @param {() => Promise<void>} [hooks.breathe]  chamado entre as etapas: na thread principal, devolve a vez à tela
 * @returns {Promise<{solution: import('./types.js').MapSolution, model: import('./types.js').MapModel, ms:number, solveMs:number, buildMs:number}>}
 */
export async function runJob(job, hooks = {}) {
  const t0 = clock();
  const signal = hooks.signal && typeof hooks.signal === 'object' ? hooks.signal : { cancelled: false };
  const breathe = typeof hooks.breathe === 'function' ? hooks.breathe : () => Promise.resolve();
  const check = () => {
    if (signal.cancelled) throw abortError();
  };

  let lastFraction = -1;
  let lastLabel = '';
  const report = (fraction, label) => {
    if (typeof hooks.onProgress !== 'function' || signal.cancelled) return;
    const f = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
    const text = typeof label === 'string' && label ? label : lastLabel;
    // o solucionador pode avisar milhares de vezes: só passa adiante o que muda alguma coisa
    if (text === lastLabel && f < 1 && f - lastFraction < 0.01) return;
    lastFraction = Math.max(lastFraction, f);
    lastLabel = text;
    try {
      hooks.onProgress(lastFraction, text);
    } catch {
      // quem escuta não pode derrubar o cálculo
    }
  };

  if (!job || typeof job !== 'object' || !job.survey || !Array.isArray(job.survey.scans)) throw new Error('levantamento inválido');
  const survey = job.survey;
  report(0, 'Preparando');
  const solver = await loadSolver();
  check();
  await breathe();
  check();

  // 0 a 85%: posições; o resto: desenho do mapa
  const solveProgress = (fraction, label) => report(0.02 + 0.83 * (Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0), label || 'Calculando as posições');
  report(0.02, 'Calculando as posições');
  let solution;
  if (job.quick) {
    solution = await solver.solveQuick(survey, { previous: job.previous || undefined, budgetMs: job.budgetMs });
  } else {
    const options = { seed: Number.isFinite(job.seed) ? job.seed : 1, onProgress: solveProgress, signal };
    if (Number.isFinite(job.budgetMs) && job.budgetMs > 0) options.budgetMs = job.budgetMs;
    solution = await solver.solve(survey, options);
  }
  check();
  if (!validSolution(solution, survey)) throw new Error('o solucionador devolveu uma solução inválida');
  if (solution.debug !== undefined) {
    // dados de bancada: não atravessam o worker nem vão para o armazenamento
    solution = { ...solution };
    delete solution.debug;
  }
  const solveMs = clock() - t0;

  report(0.86, 'Desenhando o mapa');
  await breathe();
  check();
  const model = buildMap(survey, solution, { own: Array.isArray(job.own) ? job.own.filter((x) => typeof x === 'string') : [] });
  check();
  const ms = clock() - t0;
  report(1, 'Pronto');
  return { solution, model, ms: Math.round(ms), solveMs: Math.round(solveMs), buildMs: Math.round(ms - solveMs) };
}

/** Os ArrayBuffer dos vetores tipados de um objeto (para transferir sem copiar). */
export function collectTransferables(value, limit = 200_000) {
  const buffers = new Set();
  const seen = new Set();
  const stack = [value];
  let visited = 0;
  while (stack.length && visited++ < limit) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) buffers.add(v.buffer);
    } else if (v instanceof ArrayBuffer) {
      buffers.add(v);
    } else if (Array.isArray(v)) {
      // listas de números (contornos, caminho) não têm o que transferir: olha só as de objetos
      if (v.length && typeof v[0] === 'object') for (const item of v) stack.push(item);
    } else {
      for (const key of Object.keys(v)) stack.push(v[key]);
    }
  }
  return [...buffers];
}

// ---------------------------------------------------------------------------
// Dentro do worker
// ---------------------------------------------------------------------------

const scope = typeof self === 'object' && self !== null ? self : null;
const inWorker = !!scope && typeof scope.WorkerGlobalScope === 'function' && scope instanceof scope.WorkerGlobalScope;

if (inWorker) {
  let active = null;
  scope.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'run') return;
    if (active) active.cancelled = true; // só adianta se o trabalho anterior cedeu a vez
    const signal = { cancelled: false };
    active = signal;
    try {
      const result = await runJob(msg, {
        signal,
        onProgress: (fraction, label) => scope.postMessage({ type: 'progress', id: msg.id, fraction, label }),
      });
      if (signal.cancelled) return;
      scope.postMessage({ type: 'done', id: msg.id, ...result }, collectTransferables(result.model));
    } catch (err) {
      scope.postMessage({ type: 'error', id: msg.id, name: (err && err.name) || 'Error', message: String((err && err.message) || err) });
    } finally {
      if (active === signal) active = null;
    }
  };
  scope.postMessage({ type: 'ready' });
  // deixa o solucionador carregando enquanto o primeiro pedido não chega
  loadSolver().catch(() => {});
}
