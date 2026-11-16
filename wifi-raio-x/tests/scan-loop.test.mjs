// Ritmo das buscas (app/js/scan-loop.js) com ponte, store e relógio de mentira: nada aqui
// depende do relógio de verdade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScanLoop, SCAN_DEFAULTS } from '../app/js/scan-loop.js';

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    start,
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { id, at: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
    /** Avança o tempo disparando o que vencer, em ordem, e deixando as Promises andarem. */
    async advance(ms) {
      const end = t + ms;
      await flush();
      for (;;) {
        let next = null;
        for (const x of timers.values()) if (x.at <= end && (!next || x.at < next.at || (x.at === next.at && x.id < next.id))) next = x;
        if (!next) break;
        timers.delete(next.id);
        t = Math.max(t, next.at);
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

/** Ponte de mentira com o limite do Android: 4 buscas aceitas a cada 2 minutos. */
function fakeBridge(clock, { throttle = false, scanMs = 2500 } = {}) {
  const listeners = new Map();
  const accepted = [];
  const bridge = {
    throttle,
    scanMs,
    refuse: null, // força uma recusa com este motivo
    silent: false, // aceita, mas nunca entrega a lista
    staleAnswer: false, // aceita, mas entrega só a lista velha
    requests: [], // segundos desde o início em que cada pedido chegou
    answers: [],
    cached: [],
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    emit(name, data) {
      for (const fn of [...(listeners.get(name) || [])]) fn(data);
    },
    listenerCount: (name) => (listeners.get(name) || new Set()).size,
    async scan() {
      const t = clock.now();
      bridge.requests.push(Math.round((t - clock.start) / 1000));
      let answer;
      if (bridge.refuse) answer = { accepted: false, reason: bridge.refuse };
      else {
        // como no Android: a busca mais antiga só sai da conta quando tem MAIS de 2 minutos
        while (accepted.length && accepted[0] < t - 120_000) accepted.shift();
        if (bridge.throttle && accepted.length >= 4) {
          clock.setTimer(() => bridge.emit('scan', { ts: clock.now(), fresh: false, source: 'cache', aps: [] }), 50);
          answer = { accepted: false, reason: 'throttled' };
        } else {
          if (bridge.throttle) accepted.push(t); // o Android só conta as buscas enquanto o limite está ligado
          if (!bridge.silent) {
            const fresh = !bridge.staleAnswer;
            clock.setTimer(() => bridge.emit('scan', { ts: clock.now(), fresh, source: 'request', aps: [] }), bridge.scanMs);
          }
          answer = { accepted: true };
        }
      }
      bridge.answers.push(answer.accepted ? 'ok' : answer.reason);
      return answer;
    },
    async lastScan() {
      return { ts: clock.now(), fresh: true, source: 'request', aps: bridge.cached };
    },
  };
  return bridge;
}

function fakeStore(status = {}) {
  const subs = [];
  const store = {
    state: {
      status: { wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: false, canScan: true, ...status },
      settings: { scanIntervalS: 'auto' },
    },
    scans: [],
    loop: null,
    get: () => store.state,
    subscribe(selector, listener) {
      const sub = { selector, listener, value: selector(store.state) };
      subs.push(sub);
      return () => subs.splice(subs.indexOf(sub), 1);
    },
    set(patch) {
      store.state = { ...store.state, ...patch };
      for (const sub of [...subs]) {
        const value = sub.selector(store.state);
        if (Object.is(value, sub.value)) continue;
        const prev = sub.value;
        sub.value = value;
        sub.listener(value, prev, store.state);
      }
    },
    setStatus: (patch) => store.set({ status: { ...store.state.status, ...patch } }),
    ingestScan: (ev) => void store.scans.push(ev),
    setLoop: (loop) => void (store.loop = loop),
    subCount: () => subs.length,
  };
  return store;
}

function fakeDoc(hidden = false) {
  const listeners = new Set();
  return {
    hidden,
    addEventListener: (name, fn) => name === 'visibilitychange' && listeners.add(fn),
    removeEventListener: (name, fn) => listeners.delete(fn),
    setHidden(value) {
      this.hidden = value;
      for (const fn of [...listeners]) fn();
    },
    listenerCount: () => listeners.size,
  };
}

function setup({ status, bridge: bridgeOptions, hidden = false, config } = {}) {
  const clock = fakeClock();
  const bridge = fakeBridge(clock, bridgeOptions);
  const store = fakeStore(status);
  const doc = fakeDoc(hidden);
  const loop = createScanLoop({ bridge, store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, doc, config });
  return { clock, bridge, store, doc, loop };
}

const gaps = (list) => list.slice(1).map((x, i) => x - list[i]);

test('sem limite: uma busca a cada 10 s, a primeira logo ao começar', async () => {
  const { clock, bridge, loop } = setup();
  loop.start();
  await clock.advance(60_500);
  assert.deepEqual(bridge.requests, [0, 10, 20, 30, 40, 50, 60]);
  assert.ok(bridge.answers.every((a) => a === 'ok'));
  assert.equal(loop.getState().throttled, false);
  assert.equal(loop.getState().intervalMs, SCAN_DEFAULTS.fastMs);
});

test('entrega ao store todo evento de varredura, inclusive os do sistema', async () => {
  const { clock, bridge, store, loop } = setup();
  loop.start();
  await clock.advance(3000);
  assert.equal(store.scans.length, 1);
  assert.equal(store.scans[0].source, 'request');
  bridge.emit('scan', { ts: clock.now(), fresh: true, source: 'system', aps: [] });
  assert.equal(store.scans.length, 2);
  assert.equal(store.scans[1].source, 'system');
});

test('ao começar mostra a lista guardada pelo celular, marcada como cache', async () => {
  const { clock, bridge, store, loop } = setup();
  bridge.cached = [{ bssid: 'aa:bb:cc:00:00:01', ssid: 'x', level: -50, frequency: 2412 }];
  loop.start();
  await clock.advance(100);
  assert.equal(store.scans.length, 1);
  assert.equal(store.scans[0].fresh, false, 'a lista guardada nunca conta como varredura nova');
  assert.equal(store.scans[0].source, 'cache');
  assert.equal(store.scans[0].aps.length, 1);
});

test('lista guardada vazia não é entregue', async () => {
  const { clock, store, loop } = setup();
  loop.start();
  await clock.advance(100);
  assert.equal(store.scans.length, 0);
});

test('o estado mostra "buscando" entre o pedido e a chegada da lista', async () => {
  const { clock, store, loop } = setup();
  const seen = [];
  loop.subscribe((s) => seen.push(s.scanning));
  loop.start();
  await clock.advance(100);
  assert.equal(loop.getState().scanning, true);
  assert.equal(store.loop.scanning, true, 'o mesmo estado vai para o store');
  await clock.advance(2500);
  assert.equal(loop.getState().scanning, false);
  assert.equal(loop.getState().lastAccepted, true);
  assert.equal(typeof loop.getState().lastFreshAt, 'number');
  assert.ok(seen.includes(true) && seen.at(-1) === false);
});

test('celular que avisa do limite (Status.throttled): 30 s desde a primeira busca, sem recusas', async () => {
  const { clock, bridge, loop } = setup({ status: { throttled: true }, bridge: { throttle: true } });
  loop.start();
  await clock.advance(243_000);
  // Visto num Android 11 de verdade: a 5ª busca aos 120 s cravados era recusada (a 1ª ainda não tinha
  // MAIS de 2 minutos, e uns milissegundos de adiantamento bastam). A cada 4 buscas, 1 s de folga.
  assert.deepEqual(bridge.requests, [0, 30, 60, 90, 121, 151, 181, 211, 242]);
  assert.ok(bridge.answers.every((a) => a === 'ok'), 'nesse ritmo o Android nunca recusa');
  assert.equal(loop.getState().throttled, true);
  assert.equal(loop.getState().intervalMs, SCAN_DEFAULTS.throttledMs);
});

test('com o limite ligado, pedido nenhum sai antes de a janela de 2 minutos do Android abrir (com folga)', async () => {
  const { clock, bridge, loop } = setup({ status: { throttled: true }, bridge: { throttle: true } });
  loop.start();
  await clock.advance(20 * 60_000);
  assert.ok(bridge.requests.length >= 38, `continua buscando (${bridge.requests.length} pedidos em 20 min)`);
  assert.deepEqual(bridge.answers.filter((a) => a !== 'ok'), [], 'nenhuma recusa em 20 minutos');
  for (let i = 4; i < bridge.requests.length; i++) {
    const span = bridge.requests[i] - bridge.requests[i - 4];
    assert.ok(span >= 121, `pedido ${i} saiu ${span} s depois do 4º anterior`);
  }
});

test('limite desligado e religado: a cota recomeça do zero, sem espera à toa', async () => {
  const { clock, bridge, store, loop } = setup({ status: { throttled: false } });
  loop.start();
  await clock.advance(45_000);
  assert.deepEqual(bridge.requests, [0, 10, 20, 30, 40]);
  // o Android só conta as buscas com o limite ligado: as cinco de antes não entram na cota
  bridge.throttle = true;
  store.setStatus({ throttled: true });
  await clock.advance(95_000);
  assert.deepEqual(bridge.requests.slice(5), [70, 100, 130]);
  assert.ok(bridge.answers.every((a) => a === 'ok'));
});

test('limite que o celular não informa: recua ao ser recusado e só arrisca de novo de vez em quando', async () => {
  const { clock, bridge, loop } = setup({ status: { throttled: null }, bridge: { throttle: true } });
  loop.start();
  await clock.advance(45_000);
  // começa rápido; a 5ª busca em 2 minutos é recusada
  assert.deepEqual(bridge.requests, [0, 10, 20, 30, 40]);
  assert.deepEqual(bridge.answers, ['ok', 'ok', 'ok', 'ok', 'throttled']);
  assert.equal(loop.getState().throttled, true);
  assert.equal(loop.getState().lastReason, 'throttled');
  assert.equal(loop.getState().intervalMs, SCAN_DEFAULTS.throttledMs);

  await clock.advance(10 * 60_000);
  const after = bridge.requests.filter((t) => t > 40);
  // depois da recusa espera as quatro buscas aceitas saírem da janela do Android (2 min + folga)
  // em vez de insistir e ser recusado de novo
  assert.equal(after[0], 121);
  const fast = gaps(after).filter((g) => g < 30);
  assert.ok(gaps(after).every((g) => g === 30 || g === 31 || g === 10), `intervalos inesperados: ${gaps(after)}`);
  // as sondas (10 s) existem, mas são raras: no máximo 2 em 10 minutos
  assert.ok(fast.length >= 1 && fast.length <= 2, `sondas: ${fast.length}`);
  // fora as sondas (que existem para ser recusadas enquanto o limite durar), nenhuma recusa
  const refusedAt = bridge.requests.filter((t, i) => bridge.answers[i] !== 'ok');
  assert.equal(refusedAt.length, 1 + fast.length, `recusas: ${refusedAt}`);
  assert.equal(loop.getState().throttled, true, 'com o limite ligado continua no ritmo lento');
});

test('quando o limite some, uma sonda aceita devolve o ritmo rápido', async () => {
  const { clock, bridge, loop } = setup({ status: { throttled: null }, bridge: { throttle: true } });
  loop.start();
  await clock.advance(45_000);
  assert.equal(loop.getState().throttled, true);
  bridge.throttle = false; // o usuário desligou o limite nas opções do desenvolvedor
  await clock.advance(6 * 60_000);
  assert.equal(loop.getState().throttled, false);
  assert.equal(loop.getState().intervalMs, SCAN_DEFAULTS.fastMs);
  const tail = gaps(bridge.requests).slice(-5);
  assert.deepEqual(tail, [10, 10, 10, 10, 10]);
});

test('Status passa de limitado para livre: acelera na hora', async () => {
  const { clock, bridge, store, loop } = setup({ status: { throttled: true }, bridge: { throttle: true } });
  loop.start();
  await clock.advance(65_000);
  assert.deepEqual(bridge.requests, [0, 30, 60]);
  bridge.throttle = false;
  store.setStatus({ throttled: false });
  assert.equal(loop.getState().throttled, false);
  await clock.advance(30_000);
  assert.deepEqual(bridge.requests, [0, 30, 60, 70, 80, 90]);
});

test('Status passa de livre para limitado: desacelera sem esperar uma recusa', async () => {
  const { clock, bridge, store, loop } = setup({ bridge: { throttle: true } });
  loop.start();
  await clock.advance(15_000);
  assert.deepEqual(bridge.requests, [0, 10]);
  store.setStatus({ throttled: true });
  await clock.advance(70_000);
  assert.deepEqual(bridge.requests, [0, 10, 40, 70]);
  assert.ok(bridge.answers.every((a) => a === 'ok'));
});

test('busca aceita que volta só com a lista velha conta como limite', async () => {
  const { clock, bridge, loop } = setup({ status: { throttled: null } });
  bridge.staleAnswer = true;
  loop.start();
  await clock.advance(3000);
  assert.equal(loop.getState().scanning, false);
  assert.equal(loop.getState().throttled, true);
  assert.equal(loop.getState().lastFreshAt, null);
  await clock.advance(60_000);
  assert.deepEqual(bridge.requests, [0, 30, 60]);
});

test('...mas não quando o celular garante que não há limite', async () => {
  const { clock, bridge, loop } = setup({ status: { throttled: false } });
  bridge.staleAnswer = true;
  loop.start();
  await clock.advance(25_000);
  assert.equal(loop.getState().throttled, false);
  assert.deepEqual(bridge.requests, [0, 10, 20]);
});

test('página escondida: para de buscar; ao voltar, busca na hora se já passou do intervalo', async () => {
  const { clock, bridge, doc, loop } = setup();
  loop.start();
  await clock.advance(12_000);
  assert.deepEqual(bridge.requests, [0, 10]);
  doc.setHidden(true);
  assert.equal(loop.getState().paused, 'hidden');
  assert.equal(loop.getState().nextAt, null);
  await clock.advance(120_000);
  assert.deepEqual(bridge.requests, [0, 10], 'nenhum pedido enquanto escondida');
  doc.setHidden(false);
  assert.equal(loop.getState().paused, null);
  await clock.advance(100);
  assert.deepEqual(bridge.requests, [0, 10, 132]);
});

test('página escondida por pouco tempo: mantém o horário que já estava marcado', async () => {
  const { clock, bridge, doc, loop } = setup();
  loop.start();
  await clock.advance(3000);
  doc.setHidden(true);
  await clock.advance(2000);
  doc.setHidden(false);
  await clock.advance(4000);
  assert.deepEqual(bridge.requests, [0], 'ainda não deu 10 s desde a última');
  await clock.advance(1500);
  assert.deepEqual(bridge.requests, [0, 10]);
});

test('começa escondida: só busca quando a página aparece', async () => {
  const { clock, bridge, doc, loop } = setup({ hidden: true });
  loop.start();
  await clock.advance(30_000);
  assert.deepEqual(bridge.requests, []);
  doc.setHidden(false);
  await clock.advance(100);
  assert.deepEqual(bridge.requests, [30]);
});

test('bloqueio na tela (canScan false): não busca; some o bloqueio, volta a buscar', async () => {
  const { clock, bridge, store, loop } = setup({ status: { permission: 'denied', canScan: false } });
  loop.start();
  await clock.advance(60_000);
  assert.deepEqual(bridge.requests, []);
  assert.equal(loop.getState().paused, 'gate');
  assert.deepEqual(await loop.scanNow(), { accepted: false, reason: 'paused' });
  store.setStatus({ permission: 'granted', canScan: true });
  await clock.advance(100);
  assert.deepEqual(bridge.requests, [60]);
  assert.equal(loop.getState().paused, null);
  // e o contrário: o bloqueio aparece no meio do caminho
  store.setStatus({ wifiEnabled: false, canScan: false });
  await clock.advance(60_000);
  assert.deepEqual(bridge.requests, [60]);
});

test('scanNow: busca na hora e reinicia a contagem do intervalo', async () => {
  const { clock, bridge, loop } = setup();
  loop.start();
  await clock.advance(4000);
  const res = await loop.scanNow();
  assert.deepEqual(res, { accepted: true });
  await clock.advance(13_000);
  assert.deepEqual(bridge.requests, [0, 4, 14]);
});

test('scanNow: não dispara em cima de uma busca em andamento nem duas vezes seguidas', async () => {
  const { clock, bridge, loop } = setup();
  loop.start();
  await clock.advance(1000);
  assert.deepEqual(await loop.scanNow(), { accepted: false, reason: 'busy' }, 'a primeira busca ainda não voltou');
  await clock.advance(3000);
  const first = loop.scanNow();
  const second = loop.scanNow();
  assert.deepEqual(await second, { accepted: false, reason: 'busy' });
  assert.deepEqual(await first, { accepted: true });
  assert.deepEqual(bridge.requests, [0, 4]);
});

test('scanNow recusado pelo limite devolve o motivo e põe o laço no ritmo lento', async () => {
  const { clock, bridge, loop } = setup({ status: { throttled: null }, bridge: { throttle: true } });
  loop.start();
  await clock.advance(35_000);
  assert.deepEqual(bridge.requests, [0, 10, 20, 30]);
  const res = await loop.scanNow();
  assert.deepEqual(res, { accepted: false, reason: 'throttled' });
  assert.equal(loop.getState().throttled, true);
  // as quatro buscas aceitas ainda estão na janela do Android: pedir aos 65 s seria outra recusa.
  // O próximo pedido espera a primeira delas sair da janela (2 min + folga).
  await clock.advance(31_000);
  assert.deepEqual(bridge.requests, [0, 10, 20, 30, 35]);
  await clock.advance(56_000);
  assert.deepEqual(bridge.requests, [0, 10, 20, 30, 35, 121]);
  assert.deepEqual(bridge.answers.slice(-2), ['throttled', 'ok']);
});

test("modo 'mapping': tão rápido quanto o celular deixa (3 s), ou 30 s com limite", async () => {
  const { clock, bridge, store, loop } = setup();
  loop.start();
  loop.setMode('mapping');
  assert.equal(loop.getState().mode, 'mapping');
  await clock.advance(12_500);
  assert.deepEqual(bridge.requests, [0, 3, 6, 9, 12]);
  store.setStatus({ throttled: true });
  await clock.advance(61_000);
  assert.deepEqual(bridge.requests.slice(5), [42, 72]);
  loop.setMode('normal');
  assert.equal(loop.getState().mode, 'normal');
});

test("modo 'mapping' com busca demorada: espera a lista chegar antes de pedir outra", async () => {
  const { clock, bridge, loop } = setup({ bridge: { scanMs: 4200 } });
  loop.setMode('mapping');
  loop.start();
  await clock.advance(15_000);
  // lista aos 4,2 s + folga de 0,5 s -> pedidos a cada 4,7 s
  assert.deepEqual(bridge.requests, [0, 5, 9, 14]);
});

test("modo 'paused': nada automático, mas scanNow funciona; modo inválido é ignorado", async () => {
  const { clock, bridge, loop } = setup();
  loop.start();
  await clock.advance(1000);
  loop.setMode('paused');
  assert.equal(loop.getState().paused, 'mode');
  await clock.advance(60_000);
  assert.deepEqual(bridge.requests, [0]);
  assert.deepEqual(await loop.scanNow(), { accepted: true });
  loop.setMode('turbo');
  assert.equal(loop.getState().mode, 'paused');
  loop.setMode('normal');
  await clock.advance(11_000);
  assert.deepEqual(bridge.requests, [0, 61, 71]);
});

test('varredura do próprio Android adia a nossa: a lista já está nova', async () => {
  const { clock, bridge, loop } = setup();
  loop.start();
  await clock.advance(7000);
  bridge.emit('scan', { ts: clock.now(), fresh: true, source: 'system', aps: [] });
  await clock.advance(9000);
  assert.deepEqual(bridge.requests, [0], 'a próxima conta a partir da lista do sistema');
  await clock.advance(1500);
  assert.deepEqual(bridge.requests, [0, 17]);
});

test('lista do sistema enquanto esperamos a nossa serve como resposta', async () => {
  const { clock, bridge, loop } = setup();
  bridge.silent = true;
  loop.start();
  await clock.advance(1000);
  assert.equal(loop.getState().scanning, true);
  bridge.emit('scan', { ts: clock.now(), fresh: true, source: 'system', aps: [] });
  assert.equal(loop.getState().scanning, false);
});

test('pedido aceito sem resposta: desiste de esperar e segue o ritmo', async () => {
  const { clock, bridge, loop } = setup();
  bridge.silent = true;
  loop.start();
  await clock.advance(14_000);
  assert.equal(loop.getState().scanning, true);
  await clock.advance(1200);
  assert.equal(loop.getState().scanning, false, 'o prazo de 15 s estourou');
  bridge.silent = false;
  await clock.advance(5000);
  assert.deepEqual(bridge.requests, [0, 16], 'pede de novo logo depois (a anterior já estava vencida)');
});

test('recusa por outro motivo não liga o ritmo lento', async () => {
  const { clock, bridge, loop } = setup();
  bridge.refuse = 'failed';
  loop.start();
  await clock.advance(25_000);
  assert.deepEqual(bridge.requests, [0, 10, 20]);
  assert.equal(loop.getState().throttled, false);
  assert.equal(loop.getState().lastAccepted, false);
  assert.equal(loop.getState().lastReason, 'failed');
});

test('ponte que lança no scan(): vira recusa e o laço continua', async () => {
  const { clock, bridge, loop } = setup();
  const original = bridge.scan;
  let calls = 0;
  bridge.scan = async () => {
    calls += 1;
    throw new Error('ponte caiu');
  };
  loop.start();
  await clock.advance(21_000);
  assert.equal(calls, 3);
  assert.equal(loop.getState().lastReason, 'error');
  bridge.scan = original;
  await clock.advance(10_000);
  assert.equal(loop.getState().lastAccepted, true);
});

test('intervalo escolhido nos ajustes: vale sem limite; com limite nunca fica abaixo de 30 s', async () => {
  const { clock, bridge, store, loop } = setup();
  store.set({ settings: { scanIntervalS: 20 } });
  loop.start();
  await clock.advance(45_000);
  assert.deepEqual(bridge.requests, [0, 20, 40]);
  store.set({ settings: { scanIntervalS: 5 } });
  await clock.advance(11_000);
  assert.deepEqual(bridge.requests, [0, 20, 40, 45, 50, 55]);
  store.setStatus({ throttled: true });
  assert.equal(loop.getState().intervalMs, 30_000);
  store.set({ settings: { scanIntervalS: 60 } });
  assert.equal(loop.getState().intervalMs, 60_000);
});

test('stop: nenhum pedido depois, ouvintes soltos, resposta atrasada ignorada', async () => {
  const { clock, bridge, store, doc, loop } = setup();
  loop.start();
  assert.equal(bridge.listenerCount('scan'), 1);
  assert.equal(doc.listenerCount(), 1);
  await clock.advance(1000);
  loop.stop();
  assert.equal(loop.getState().running, false);
  assert.equal(loop.getState().paused, 'stopped');
  assert.equal(loop.getState().scanning, false);
  assert.equal(bridge.listenerCount('scan'), 0);
  assert.equal(doc.listenerCount(), 0);
  assert.equal(store.subCount(), 0);
  await clock.advance(120_000);
  assert.deepEqual(bridge.requests, [0]);
  assert.deepEqual(await loop.scanNow(), { accepted: false, reason: 'paused' });
});

test('reset: esquece o limite observado e busca de novo na hora', async () => {
  const { clock, bridge, loop } = setup({ status: { throttled: null }, bridge: { throttle: true } });
  loop.start();
  await clock.advance(45_000);
  assert.equal(loop.getState().throttled, true);
  bridge.throttle = false;
  loop.reset();
  assert.equal(loop.getState().throttled, false);
  assert.equal(loop.getState().lastAccepted, null);
  await clock.advance(100);
  assert.equal(bridge.requests.at(-1), 45);
});

test('start duas vezes não duplica nada; ouvinte que lança não derruba o laço', async () => {
  const { clock, bridge, loop } = setup();
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    loop.subscribe(() => {
      throw new Error('ouvinte quebrado');
    });
    loop.start();
    loop.start();
    assert.equal(bridge.listenerCount('scan'), 1);
    await clock.advance(21_000);
    assert.deepEqual(bridge.requests, [0, 10, 20]);
    assert.ok(errors.length > 0);
  } finally {
    console.error = original;
  }
});
