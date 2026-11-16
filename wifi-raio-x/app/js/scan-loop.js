// Ritmo das buscas de redes.
//
// O Android deixa um app buscar só 4 vezes a cada 2 minutos (a menos que o usuário desligue a
// "Limitação da busca por Wi-Fi" nas opções do desenvolvedor). O laço se adapta:
//   - sem limite:  uma busca a cada ~10 s (ou o intervalo escolhido nos ajustes);
//   - com limite:  uma a cada 30 s — o ritmo que o Android aceita sempre, em vez de 4 buscas
//                  seguidas e depois um minuto e meio no escuro (a cada 4 buscas, 1 s a mais de
//                  espera: a janela de 2 minutos do Android não perdoa um pedido adiantado);
//   - mapeando:    tão rápido quanto o celular permitir (3 s sem limite; 30 s com limite);
//   - parado:      enquanto a página está escondida, enquanto há um bloqueio na tela
//                  (Status.canScan === false) ou no modo 'paused'.
//
// Como ele sabe do limite: Status.throttled === true, ou um pedido recusado com
// reason 'throttled' (ou uma busca aceita que volta só com a lista velha). Como ele sabe que o
// limite acabou: Status.throttled passa a false; ou, quando o celular não informa, depois de
// algumas buscas aceitas no ritmo lento ele arrisca um pedido no ritmo rápido — se for aceito,
// volta a acelerar; se for recusado, continua devagar e espera mais antes de arriscar de novo.
//
// É o único lugar que chama bridge.scan() e o único que entrega eventos 'scan' ao store
// (inclusive as buscas que o próprio Android faz por conta dele).
//
// API (as telas recebem isto como ctx.scanLoop):
//   scanNow()            -> Promise<{accepted, reason?}>   busca agora (toque do usuário); reason extra: 'busy', 'paused'
//   setMode(mode)        'normal' | 'mapping' | 'paused'
//   getState()           -> ScanLoopState                 (o mesmo objeto fica em store.get().loop)
//   subscribe(fn)        -> cancelar                      avisado a cada mudança de estado
//   start() / stop() / reset()                            (uso do main.js)
//
// Relógio e temporizadores são injetados para os testes (tests/scan-loop.test.mjs).

/**
 * @typedef {Object} ScanLoopState
 * @property {boolean} running
 * @property {'normal'|'mapping'|'paused'} mode
 * @property {boolean} scanning          há um pedido em andamento (ou aguardando o resultado)
 * @property {null|'stopped'|'mode'|'hidden'|'gate'} paused   por que não está buscando; null = ativo
 * @property {boolean} throttled         o Android está limitando (informado ou observado)
 * @property {number} intervalMs         intervalo atual entre pedidos
 * @property {number|null} nextAt        quando sai o próximo pedido (relógio do app); null = nenhum agendado
 * @property {number|null} lastRequestAt
 * @property {boolean|null} lastAccepted o último pedido foi aceito? null = ainda não houve pedido
 * @property {string|null} lastReason    motivo da última recusa ('throttled', ...)
 * @property {number|null} lastFreshAt   quando chegou a última lista nova de verdade
 * @property {number|null} lastEventAt   quando chegou o último evento 'scan' (novo ou em cache)
 */

export const SCAN_DEFAULTS = Object.freeze({
  fastMs: 10_000,
  throttledMs: 30_000,
  mappingMs: 3_000,
  /** sem evento 'scan' este tempo depois de um pedido aceito: para de esperar */
  resultTimeoutMs: 15_000,
  /** dois toques seguidos em "buscar agora" não gastam duas buscas */
  minGapMs: 1_500,
  /** folga mínima entre o fim de uma busca e o pedido seguinte */
  minIdleMs: 500,
  /** buscas aceitas seguidas, no ritmo lento, antes de arriscar o ritmo rápido */
  probeAfter: 4,
  probeAfterMax: 16,
  /** a regra do Android: no máximo `throttleMax` buscas a cada `throttleWindowMs` */
  throttleWindowMs: 120_000,
  throttleMax: 4,
  /**
   * Folga sobre a janela do Android. Ele só libera a 5ª busca quando a 1ª das últimas 4 tem MAIS de
   * 2 minutos, e conta o tempo do lado dele: no ritmo exato de 30 s, um pedido que chega alguns
   * milissegundos adiantado é recusado (medido num Android 11: uma recusa a cada 2 min e meio).
   */
  throttleSlackMs: 1_000,
});

export const SCAN_MODES = Object.freeze(['normal', 'mapping', 'paused']);

/**
 * @param {object} deps
 * @param {{scan:() => Promise<{accepted:boolean, reason?:string}>, on:(name:string, fn:Function) => (() => void),
 *          lastScan?:() => Promise<object>}} deps.bridge
 * @param {{get:() => object, subscribe:Function, ingestScan:(ev:object) => void, setLoop?:(s:ScanLoopState) => void}} deps.store
 * @param {() => number} [deps.now]
 * @param {(fn:Function, ms:number) => any} [deps.setTimer]
 * @param {(id:any) => void} [deps.clearTimer]
 * @param {{hidden:boolean, addEventListener:Function, removeEventListener:Function}|null} [deps.doc]
 * @param {Partial<typeof SCAN_DEFAULTS>} [deps.config]
 */
export function createScanLoop({ bridge, store, now = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), doc = globalThis.document ?? null, config } = {}) {
  const cfg = { ...SCAN_DEFAULTS, ...(config || {}) };

  let running = false;
  let mode = 'normal';
  let hidden = false;
  // 'idle' | 'asking' (esperando a resposta do pedido) | 'waiting' (aceito; esperando a lista)
  let phase = 'idle';
  let generation = 0; // muda em stop()/reset(): respostas de pedidos antigos são ignoradas

  // limite observado (independe do que o Status diz)
  let backoff = false;
  let okStreak = 0;
  let probeAfter = cfg.probeAfter;
  let probing = false;
  let acceptedAt = []; // horários dos últimos pedidos aceitos (para saber se o limite teria barrado)
  // horários dos pedidos aceitos que o Android contou na cota dele: ele só conta com o limite ligado,
  // então ficam de fora os aceitos enquanto o celular garantia que não havia limite
  let countedAt = [];

  let anchorAt = null; // de onde se conta o intervalo: o último pedido ou a última lista nova do sistema
  let lastRequestAt = null;
  let lastAccepted = null;
  let lastReason = null;
  let lastFreshAt = null;
  let lastEventAt = null;
  let nextAt = null;

  let timer = null;
  let resultTimer = null;
  let unbind = [];
  const listeners = new Set();
  let lastPublished = '';

  const status = () => store.get().status || null;
  const statusSaysThrottled = () => status()?.throttled === true;
  const isThrottled = () => statusSaysThrottled() || backoff;

  function unthrottledMs() {
    if (mode === 'mapping') return cfg.mappingMs;
    const chosen = store.get().settings?.scanIntervalS;
    return typeof chosen === 'number' && Number.isFinite(chosen) && chosen > 0 ? chosen * 1000 : cfg.fastMs;
  }

  function intervalMs() {
    const base = unthrottledMs();
    return isThrottled() ? Math.max(base, cfg.throttledMs) : base;
  }

  function pauseReason() {
    if (!running) return 'stopped';
    if (mode === 'paused') return 'mode';
    if (hidden) return 'hidden';
    if (status()?.canScan === false) return 'gate';
    return null;
  }

  /** @returns {ScanLoopState} */
  function getState() {
    return {
      running,
      mode,
      scanning: phase !== 'idle',
      paused: pauseReason(),
      throttled: isThrottled(),
      intervalMs: intervalMs(),
      nextAt,
      lastRequestAt,
      lastAccepted,
      lastReason,
      lastFreshAt,
      lastEventAt,
    };
  }

  function publish() {
    const state = getState();
    const text = JSON.stringify(state);
    if (text === lastPublished) return;
    lastPublished = text;
    if (typeof store.setLoop === 'function') store.setLoop(state);
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch (err) {
        console.error('[scan-loop] erro num ouvinte', err);
      }
    }
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    nextAt = null;
  }

  function cancelResultTimer() {
    if (resultTimer !== null) clearTimer(resultTimer);
    resultTimer = null;
  }

  function schedule(delayMs) {
    cancelTimer();
    const delay = Math.max(0, Math.round(delayMs));
    nextAt = now() + delay;
    timer = setTimer(() => {
      timer = null;
      nextAt = null;
      if (pauseReason() === null && phase === 'idle') void request();
      else publish();
    }, delay);
  }

  /** Agenda o próximo pedido a partir do último (ou para de agendar, se estiver em pausa). */
  function scheduleNext({ immediateIfDue = false } = {}) {
    if (pauseReason() !== null) {
      cancelTimer();
      return;
    }
    if (phase !== 'idle') return; // o fim da busca em andamento agenda a seguinte
    let wait = intervalMs();
    // hora de testar se o limite ainda existe? (não quando o celular afirma que sim)
    probing = backoff && !statusSaysThrottled() && okStreak >= probeAfter;
    if (probing) wait = unthrottledMs();
    const t = now();
    const due = anchorAt === null ? t : anchorAt + wait;
    const floor = immediateIfDue || anchorAt === null ? t : t + cfg.minIdleMs;
    // com o limite valendo, espera a mais antiga das últimas buscas aceitas sair da janela do Android
    // (a sonda é a exceção: ela existe justamente para testar se o limite ainda está lá)
    const quota = !probing && isThrottled() && countedAt.length >= cfg.throttleMax ? countedAt[countedAt.length - cfg.throttleMax] + cfg.throttleWindowMs + cfg.throttleSlackMs : 0;
    schedule(Math.max(due, floor, quota) - t);
  }

  function clearBackoff() {
    countedAt = []; // sem limite o Android não conta nada: a cota recomeça do zero se ele voltar
    backoff = false;
    probing = false;
    okStreak = 0;
    probeAfter = cfg.probeAfter;
  }

  function noteThrottled() {
    if (probing) {
      // a sonda foi recusada: o limite continua; espera mais antes da próxima
      probeAfter = Math.min(probeAfter * 2, cfg.probeAfterMax);
    }
    backoff = true;
    probing = false;
    okStreak = 0;
  }

  function noteAccepted(t) {
    // Se o limite estivesse valendo, este pedido teria sido barrado? (já havia `throttleMax`
    // aceitos dentro da janela.) Então ele não está mais lá.
    const recent = acceptedAt.filter((x) => t - x < cfg.throttleWindowMs);
    if (backoff) {
      if (recent.length >= cfg.throttleMax) clearBackoff();
      else okStreak += 1;
    }
    recent.push(t);
    acceptedAt = recent.slice(-cfg.throttleMax);
    if (status()?.throttled !== false) countedAt = [...countedAt, t].slice(-cfg.throttleMax);
    probing = false;
  }

  async function request() {
    phase = 'asking';
    const askedAt = now();
    lastRequestAt = askedAt;
    anchorAt = askedAt;
    cancelTimer();
    publish();
    const gen = generation;
    let res;
    try {
      res = await bridge.scan();
    } catch (err) {
      res = { accepted: false, reason: 'error' };
    }
    if (gen !== generation) return res; // o laço foi parado ou reiniciado no meio do caminho
    const accepted = !!(res && res.accepted);
    lastAccepted = accepted;
    lastReason = accepted ? null : (res && typeof res.reason === 'string' && res.reason) || 'unknown';
    if (accepted) {
      noteAccepted(askedAt);
      if (phase === 'asking') {
        // fica "buscando" até o evento 'scan' chegar (ou o prazo estourar)
        phase = 'waiting';
        cancelResultTimer();
        resultTimer = setTimer(() => {
          resultTimer = null;
          phase = 'idle';
          scheduleNext();
          publish();
        }, cfg.resultTimeoutMs);
      } else {
        scheduleNext(); // a lista chegou antes da resposta do pedido
      }
    } else {
      phase = 'idle';
      if (lastReason === 'throttled') noteThrottled();
      else probing = false;
      scheduleNext();
    }
    publish();
    return res;
  }

  function onScan(ev) {
    if (!ev || typeof ev !== 'object') return;
    try {
      store.ingestScan(ev);
    } catch (err) {
      console.error('[scan-loop] o store recusou uma varredura', err);
    }
    if (!running) return;
    const t = now();
    lastEventAt = t;
    if (ev.fresh) lastFreshAt = t;
    if (phase === 'waiting' && ev.source !== 'system') {
      phase = 'idle';
      cancelResultTimer();
      // pedido aceito que volta só com a lista velha: foi o limite do Android agindo por baixo
      if (!ev.fresh && status()?.throttled !== false) noteThrottled();
    } else if (phase === 'waiting' && ev.fresh) {
      // o sistema acabou de entregar uma lista nova: serve como resposta
      phase = 'idle';
      cancelResultTimer();
    } else if (phase === 'asking' && ev.source === 'request') {
      phase = 'idle'; // a lista chegou antes da resposta do pedido
    } else if (phase === 'idle' && ev.fresh) {
      // busca feita pelo próprio Android: a nossa próxima conta a partir de agora
      anchorAt = t;
    }
    if (phase === 'idle') scheduleNext();
    publish();
  }

  function onStatus(next, prev) {
    // o usuário acabou de desligar o limite nas opções do desenvolvedor: acredita e confere
    if (prev && prev.throttled === true && next && next.throttled === false) clearBackoff();
    scheduleNext({ immediateIfDue: true });
    publish();
  }

  function onVisibility() {
    hidden = !!(doc && doc.hidden);
    scheduleNext({ immediateIfDue: true });
    publish();
  }

  function start() {
    if (running) return;
    running = true;
    generation += 1;
    hidden = !!(doc && doc.hidden);
    unbind = [
      bridge.on('scan', onScan),
      store.subscribe((s) => s.status, onStatus),
      store.subscribe((s) => s.settings && s.settings.scanIntervalS, () => {
        scheduleNext({ immediateIfDue: true });
        publish();
      }),
    ];
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibility);
      unbind.push(() => doc.removeEventListener('visibilitychange', onVisibility));
    }
    // mostra logo a lista que o celular já tem guardada, enquanto a primeira busca roda
    if (typeof bridge.lastScan === 'function') {
      const gen = generation;
      Promise.resolve()
        .then(() => bridge.lastScan())
        .then((ev) => {
          if (gen !== generation || lastEventAt !== null) return;
          if (ev && Array.isArray(ev.aps) && ev.aps.length) store.ingestScan({ ...ev, fresh: false, source: 'cache' });
        })
        .catch(() => {});
    }
    scheduleNext({ immediateIfDue: true });
    publish();
  }

  function stop() {
    if (!running) return;
    running = false;
    generation += 1;
    phase = 'idle';
    cancelTimer();
    cancelResultTimer();
    for (const off of unbind) {
      try {
        off();
      } catch {
        // segue desligando o resto
      }
    }
    unbind = [];
    publish();
  }

  /** Esquece o que aprendeu (limite, horários): usado ao trocar de celular de verdade para simulador e vice-versa. */
  function reset() {
    generation += 1;
    phase = 'idle';
    clearBackoff();
    acceptedAt = [];
    anchorAt = null;
    lastRequestAt = null;
    lastAccepted = null;
    lastReason = null;
    lastFreshAt = null;
    lastEventAt = null;
    cancelTimer();
    cancelResultTimer();
    if (running) scheduleNext({ immediateIfDue: true });
    publish();
  }

  /**
   * Busca agora, a pedido do usuário. Não fura um bloqueio (devolve reason 'paused') nem
   * dispara em cima de uma busca em andamento ou recém-pedida (reason 'busy').
   * @returns {Promise<{accepted:boolean, reason?:string}>}
   */
  async function scanNow() {
    const why = pauseReason();
    if (why === 'stopped' || why === 'gate') return { accepted: false, reason: 'paused' };
    if (phase !== 'idle') return { accepted: false, reason: 'busy' };
    if (lastRequestAt !== null && now() - lastRequestAt < cfg.minGapMs) return { accepted: false, reason: 'busy' };
    return request();
  }

  /** @param {'normal'|'mapping'|'paused'} next */
  function setMode(next) {
    if (!SCAN_MODES.includes(next) || next === mode) return;
    mode = next;
    scheduleNext({ immediateIfDue: true });
    publish();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { start, stop, reset, scanNow, setMode, getState, subscribe };
}
