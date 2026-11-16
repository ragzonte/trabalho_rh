// Consertos de comportamento do WebView que moram em app/js/polyfills.js e dá para testar sem navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installVisibilityRepair, ensureFlexGap } from '../app/js/polyfills.js';
import { createScanLoop } from '../app/js/scan-loop.js';

/** Um `document` mínimo: alvo de eventos com `hidden`. */
function fakeDoc(hidden = false) {
  const doc = new EventTarget();
  doc.hidden = hidden;
  return doc;
}

/** Temporizador de mentira: as funções ficam guardadas até `run()`. */
function fakeTimer() {
  const queue = [];
  return {
    setTimer: (fn, ms) => queue.push({ fn, ms }),
    run() {
      for (const { fn } of queue.splice(0)) fn();
    },
    get pending() {
      return queue.length;
    },
  };
}

test('página que volta do congelamento sem `visibilitychange`: o aviso que faltou é mandado', () => {
  // O que o WebView 83 faz depois de 5 min em segundo plano: hidden -> freeze -> (volta) resume, já visível.
  const doc = fakeDoc(false);
  const timer = fakeTimer();
  const seen = [];
  installVisibilityRepair(doc, { delayMs: 250, setTimer: timer.setTimer });
  doc.addEventListener('visibilitychange', () => seen.push(doc.hidden));

  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange')); // o app foi para o segundo plano (este aviso chega)
  doc.dispatchEvent(new Event('freeze'));
  assert.deepEqual(seen, [true]);

  doc.hidden = false; // o usuário voltou: o WebView só manda `resume`
  doc.dispatchEvent(new Event('resume'));
  assert.deepEqual(seen, [true], 'espera um instante: o aviso de verdade pode estar a caminho');
  assert.equal(timer.pending, 1);
  timer.run();
  assert.deepEqual(seen, [true, false], 'os ouvintes ficam sabendo que a página está visível');
});

test('onde o WebView avisa direito, nada é mandado em dobro', () => {
  const doc = fakeDoc(false);
  const timer = fakeTimer();
  const seen = [];
  installVisibilityRepair(doc, { setTimer: timer.setTimer });
  doc.addEventListener('visibilitychange', () => seen.push(doc.hidden));

  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.hidden = false;
  doc.dispatchEvent(new Event('resume'));
  doc.dispatchEvent(new Event('visibilitychange')); // o aviso de verdade chega logo depois do resume
  timer.run();
  assert.deepEqual(seen, [true, false]);

  // um `resume` sem mudança nenhuma (página congelada e descongelada ainda escondida) também não inventa aviso
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.dispatchEvent(new Event('freeze'));
  doc.dispatchEvent(new Event('resume'));
  timer.run();
  assert.deepEqual(seen, [true, false, true]);
});

test('desfazer remove os ouvintes; sem documento não faz nada', () => {
  const doc = fakeDoc(true);
  const timer = fakeTimer();
  const undo = installVisibilityRepair(doc, { setTimer: timer.setTimer });
  undo();
  doc.hidden = false;
  doc.dispatchEvent(new Event('resume'));
  assert.equal(timer.pending, 0);
  assert.doesNotThrow(() => installVisibilityRepair(null)());
  assert.doesNotThrow(() => installVisibilityRepair({})());
  assert.equal(ensureFlexGap(null), false);
});

test('com o conserto, o laço de buscas retoma depois do congelamento (sem ele ficava parado para sempre)', async () => {
  const doc = fakeDoc(false);
  const timer = fakeTimer();
  const state = { status: { canScan: true, throttled: false }, settings: {} };
  const store = { get: () => state, subscribe: () => () => {}, ingestScan() {}, setLoop() {} };
  let scans = 0;
  const bridge = { scan: async () => ({ accepted: (scans += 1) > 0 }), on: () => () => {} };
  const loopTimers = [];
  const loop = createScanLoop({ bridge, store, doc, now: () => 1_000_000, setTimer: (fn, ms) => loopTimers.push({ fn, ms }) && loopTimers.length, clearTimer: () => {} });
  loop.start();
  assert.equal(loop.getState().paused, null);

  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(loop.getState().paused, 'hidden');

  // volta do congelamento: só `resume`
  doc.hidden = false;
  doc.dispatchEvent(new Event('resume'));
  assert.equal(loop.getState().paused, 'hidden', 'sem o conserto o laço não fica sabendo');

  installVisibilityRepair(doc, { setTimer: timer.setTimer });
  // o conserto foi instalado com a página visível, mas os ouvintes viram "escondida" por último:
  // para o teste, repete a sequência com ele no lugar
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.hidden = false;
  doc.dispatchEvent(new Event('resume'));
  timer.run();
  assert.equal(loop.getState().paused, null, 'o laço volta a buscar');
  loop.stop();
});

test('WeakRef e FinalizationRegistry existem para o three.js (no WebView 80 a 83 vêm daqui)', () => {
  // No Node de hoje são os de verdade; o que importa aqui é o contrato que o three.js usa.
  const target = { id: 1 };
  const ref = new globalThis.WeakRef(target);
  assert.equal(ref.deref(), target);
  const registry = new globalThis.FinalizationRegistry(() => {});
  assert.doesNotThrow(() => registry.register(target, 'x', target));
  assert.doesNotThrow(() => registry.unregister(target));
});

test('as versões de reserva de WeakRef/FinalizationRegistry: mesmo contrato, sem coletor', async () => {
  const saved = { WeakRef: globalThis.WeakRef, FinalizationRegistry: globalThis.FinalizationRegistry };
  try {
    // como num WebView 83: os dois não existem quando o arquivo é carregado
    delete globalThis.WeakRef;
    delete globalThis.FinalizationRegistry;
    await import(`../app/js/polyfills.js?sem-coleta=${Date.now()}`);
    assert.equal(typeof globalThis.WeakRef, 'function');
    assert.equal(typeof globalThis.FinalizationRegistry, 'function');
    assert.notEqual(globalThis.WeakRef, saved.WeakRef, 'entrou a versão de reserva');
    const target = { id: 2 };
    const ref = new globalThis.WeakRef(target);
    assert.equal(ref.deref(), target);
    assert.throws(() => new globalThis.WeakRef(1), TypeError);
    assert.throws(() => new globalThis.FinalizationRegistry(), TypeError);
    const registry = new globalThis.FinalizationRegistry(() => assert.fail('a limpeza nunca é chamada na versão de reserva'));
    registry.register(target, 'x', target);
    assert.equal(registry.unregister(target), false);
    // o que o three.js faz na partida do WebGLRenderer
    const map = {};
    const cleanup = new globalThis.FinalizationRegistry((id) => delete map[id]);
    map[7] = new globalThis.WeakRef(target);
    cleanup.register(target, 7, target);
    assert.equal(map[7].deref(), target);
  } finally {
    globalThis.WeakRef = saved.WeakRef;
    globalThis.FinalizationRegistry = saved.FinalizationRegistry;
  }
});
