// Motor do mapa: roda o solucionador e o construtor do modelo FORA da thread da tela.
//
// ---------------------------------------------------------------------------------------------
// API
//
//   const engine = createMapEngine({ workerUrl });          // workerUrl: só para testes
//
//   const { solution, model, ms } = await engine.run(survey, {
//     own,          // string[]: BSSIDs das redes do usuário (store.get().own)
//     quick,        // true = prévia rápida (solveQuick), para o mapa ao vivo durante a caminhada
//     previous,     // MapSolution anterior (a última prévia): o resultado sai no mesmo referencial,
//                   // sem girar nem espelhar o mapa na tela de uma atualização para a outra
//     budgetMs,     // tempo que o solucionador pode gastar
//     onProgress,   // (fração 0..1, rótulo em pt-BR) => void
//   });
//   (o resultado traz ainda solveMs, buildMs e worker: true/false = onde rodou)
//
//   engine.cancel()        cancela o cálculo em andamento
//   engine.dispose()       encerra o worker; o motor não aceita mais pedidos
//   engine.usesWorker      true enquanto o caminho com Web Worker estiver valendo
//   engine.warmUp()        opcional: já cria o worker e diz (Promise<boolean>) se ele funciona
//
// Um cálculo por vez: um run() novo cancela o anterior. A Promise de um cálculo cancelado (por
// cancel(), por outro run() ou por dispose()) é rejeitada com um Error de name === 'AbortError'.
//
// Como funciona: um Web Worker de módulo (worker.js) recebe o levantamento por mensagem e
// devolve a solução e o modelo (os vetores tipados do modelo são transferidos, sem cópia).
// Cancelar um cálculo completo = encerrar o worker (o próximo run() cria outro); uma prévia
// rápida abandonada só tem o resultado ignorado, porque termina em décimos de segundo. Se o
// worker não puder ser criado ou falhar ao carregar (WebView antigo, sem Worker de módulo), o
// mesmo trabalho roda na thread principal, devolvendo a vez à tela entre as etapas — mais
// travado, mas funciona.

// Sem imports estáticos de propósito: o solucionador e o construtor do modelo só são carregados
// na thread principal se o caminho de reserva for mesmo necessário.

/** O worker tem este tempo para carregar e avisar que está pronto. */
const READY_TIMEOUT_MS = 10_000;
/** Um cálculo que passa disto travou: o worker é encerrado. */
const MIN_RUN_TIMEOUT_MS = 90_000;

const hasWorker = () => typeof Worker === 'function';

/** Erro de "cálculo cancelado" (o mesmo nome que o navegador usa: AbortError). */
function abortError(message = 'cálculo do mapa cancelado') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function timeoutError() {
  const err = new Error('o cálculo do mapa demorou demais');
  err.name = 'TimeoutError';
  return err;
}

/** Devolve a vez à tela: um quadro de animação (quando há tela) e a fila de eventos. */
function breathe() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const visible = typeof document === 'object' && document && !document.hidden && typeof requestAnimationFrame === 'function';
    if (visible) requestAnimationFrame(() => setTimeout(finish, 0));
    // página escondida não desenha quadros: o temporizador garante que o trabalho segue
    setTimeout(finish, visible ? 60 : 0);
  });
}

/**
 * @param {object} [options]
 * @param {string|URL} [options.workerUrl]  endereço do worker (padrão: worker.js ao lado deste arquivo)
 * @param {number} [options.readyTimeoutMs]
 */
export function createMapEngine({ workerUrl, readyTimeoutMs = READY_TIMEOUT_MS } = {}) {
  let canWorker = hasWorker();
  let disposed = false;
  let handle = null; // worker em uso: { worker, ready: Promise<boolean>, alive, onMessage, onCrash }
  let current = null; // cálculo em andamento
  let serial = 0;
  let mainChain = Promise.resolve(); // na thread principal, um trabalho só começa quando o anterior parou
  let crashes = 0; // workers que carregaram e depois morreram

  function kill(h) {
    if (!h || !h.alive) return;
    h.alive = false;
    h.onMessage = null;
    h.onCrash = null;
    try {
      h.worker.terminate();
    } catch {
      // já estava encerrado
    }
    if (handle === h) handle = null;
  }

  function spawn() {
    let worker;
    try {
      worker = new Worker(workerUrl || new URL('./worker.js', import.meta.url), { type: 'module', name: 'wrx-mapa' });
    } catch {
      canWorker = false;
      return null;
    }
    const h = { worker, ready: null, alive: true, isReady: false, onMessage: null, onCrash: null };
    h.ready = new Promise((resolve) => {
      const giveUp = (reason) => {
        if (h.isReady) {
          // já estava funcionando e quebrou no meio de um trabalho; na segunda vez, desiste dele
          crashes += 1;
          if (crashes >= 2) canWorker = false;
          const crash = h.onCrash;
          kill(h);
          if (crash) crash(reason);
          return;
        }
        // nunca chegou a carregar: este aparelho não roda o worker
        canWorker = false;
        kill(h);
        resolve(false);
      };
      const timer = setTimeout(() => giveUp(new Error('o worker não respondeu')), readyTimeoutMs);
      worker.onmessage = (event) => {
        const msg = event.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          h.isReady = true;
          resolve(true);
        } else if (h.onMessage) {
          h.onMessage(msg);
        }
      };
      worker.onerror = (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault(); // tratado aqui: não vira erro da página
        clearTimeout(timer);
        giveUp(new Error((event && event.message) || 'o worker falhou'));
      };
      worker.onmessageerror = () => giveUp(new Error('mensagem do worker ilegível'));
    });
    handle = h;
    return h;
  }

  function progressOf(entry) {
    return (fraction, label) => {
      if (entry.settled || typeof entry.onProgress !== 'function') return;
      try {
        entry.onProgress(fraction, label);
      } catch (err) {
        console.error('[engine] erro em onProgress', err);
      }
    };
  }

  /** Roda na thread principal (reserva). */
  function runOnMain(entry, job) {
    const work = mainChain.then(async () => {
      if (entry.signal.cancelled) throw abortError();
      const { runJob } = await import('./worker.js');
      const result = await runJob(job, { signal: entry.signal, onProgress: progressOf(entry), breathe });
      return { ...result, worker: false };
    });
    mainChain = work.then(
      () => {},
      () => {},
    );
    return work;
  }

  function runInWorker(h, entry, job) {
    return new Promise((resolve, reject) => {
      const limit = Math.max(MIN_RUN_TIMEOUT_MS, 10 * (Number.isFinite(job.budgetMs) ? job.budgetMs : 0));
      const timer = setTimeout(() => {
        kill(h);
        reject(timeoutError());
      }, limit);
      const report = progressOf(entry);
      entry.abort = () => {
        clearTimeout(timer);
        if (job.quick) {
          // prévia rápida: acaba sozinha em décimos de segundo; a resposta dela é ignorada (id antigo)
          if (h.onCrash === onCrash) h.onCrash = null;
          return;
        }
        kill(h); // cada motor do solucionador segura a thread por segundos: só encerrando o worker ele para já
      };
      h.onMessage = (msg) => {
        if (msg.id !== job.id) return;
        if (msg.type === 'progress') {
          report(msg.fraction, msg.label);
        } else if (msg.type === 'done') {
          clearTimeout(timer);
          h.onMessage = null;
          h.onCrash = null;
          resolve({ solution: msg.solution, model: msg.model, ms: msg.ms, solveMs: msg.solveMs, buildMs: msg.buildMs, worker: true });
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          h.onMessage = null;
          h.onCrash = null;
          const err = new Error(msg.message || 'falha ao calcular o mapa');
          if (typeof msg.name === 'string') err.name = msg.name;
          reject(err);
        }
      };
      const onCrash = () => {
        // o worker morreu no meio do cálculo (falta de memória?): tenta de novo, aqui mesmo
        clearTimeout(timer);
        if (entry.signal.cancelled) reject(abortError());
        else runOnMain(entry, job).then(resolve, reject);
      };
      h.onCrash = onCrash;
      try {
        h.worker.postMessage({ type: 'run', ...job });
      } catch (err) {
        clearTimeout(timer);
        kill(h);
        // levantamento que não atravessa a mensagem (objeto estranho dentro dele): roda aqui
        runOnMain(entry, job).then(resolve, reject);
      }
    });
  }

  async function execute(entry, job) {
    if (canWorker) {
      const h = handle && handle.alive ? handle : spawn();
      if (h) {
        const ok = await h.ready;
        if (entry.signal.cancelled) throw abortError();
        if (ok && h.alive) return runInWorker(h, entry, job);
        if (ok && canWorker) return execute(entry, job); // este worker foi encerrado enquanto carregava: outro
      }
    }
    if (entry.signal.cancelled) throw abortError();
    return runOnMain(entry, job);
  }

  function abortCurrent() {
    const entry = current;
    if (!entry) return false;
    current = null;
    entry.signal.cancelled = true;
    if (entry.abort) entry.abort();
    if (!entry.settled) {
      entry.settled = true;
      entry.reject(abortError());
    }
    return true;
  }

  /**
   * @param {import('./types.js').Survey} survey
   * @param {object} [options]
   * @param {string[]|Set<string>} [options.own]
   * @param {boolean} [options.quick]
   * @param {import('./types.js').MapSolution|null} [options.previous]
   * @param {number} [options.budgetMs]
   * @param {number} [options.seed]
   * @param {(fraction:number, label:string) => void} [options.onProgress]
   * @returns {Promise<{solution: import('./types.js').MapSolution, model: import('./types.js').MapModel, ms:number,
   *                    solveMs:number, buildMs:number, worker:boolean}>}
   */
  function run(survey, options = {}) {
    if (disposed) return Promise.reject(abortError('motor do mapa encerrado'));
    abortCurrent();
    const opts = options && typeof options === 'object' ? options : {};
    const job = {
      id: ++serial,
      survey,
      own: opts.own ? [...opts.own].filter((x) => typeof x === 'string') : [],
      quick: !!opts.quick,
      previous: opts.previous && typeof opts.previous === 'object' ? opts.previous : null,
      budgetMs: Number.isFinite(opts.budgetMs) && opts.budgetMs > 0 ? opts.budgetMs : undefined,
      seed: Number.isFinite(opts.seed) ? opts.seed : undefined,
    };
    return new Promise((resolve, reject) => {
      const entry = { id: job.id, signal: { cancelled: false }, onProgress: opts.onProgress, settled: false, abort: null, reject };
      current = entry;
      execute(entry, job).then(
        (result) => {
          if (current === entry) current = null;
          if (entry.settled) return;
          entry.settled = true;
          resolve(result);
        },
        (err) => {
          if (current === entry) current = null;
          if (entry.settled) return;
          entry.settled = true;
          reject(err);
        },
      );
    });
  }

  return {
    get usesWorker() {
      return canWorker && !disposed;
    },
    run,
    /** Cancela o cálculo em andamento (a Promise dele é rejeitada com AbortError). Devolve true se havia um. */
    cancel: () => abortCurrent(),
    /** Cria o worker de antemão e diz se ele funciona neste aparelho. */
    async warmUp() {
      if (disposed || !canWorker) return false;
      const h = handle && handle.alive ? handle : spawn();
      return h ? h.ready : false;
    },
    dispose() {
      if (disposed) return;
      abortCurrent();
      disposed = true;
      kill(handle);
    },
  };
}
