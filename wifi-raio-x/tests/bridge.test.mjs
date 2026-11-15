// A porta entre a interface e o Android: como as respostas nativas viram valores ou erros.
import test from 'node:test';
import assert from 'node:assert/strict';

async function freshBridge(native) {
  globalThis.WrxNative = native;
  delete globalThis.__wrx;
  const mod = await import(`../app/js/bridge.js?caso=${Math.random()}`);
  await mod.connect('native');
  return mod;
}

test('resposta imediata: {error} sozinho vira exceção; o resto passa inteiro', async () => {
  const bridge = await freshBridge({
    call: (method) => (method === 'status' ? JSON.stringify({ error: 'argumentos inválidos' }) : JSON.stringify({ ok: true })),
    callAsync() {},
  });
  await assert.rejects(() => bridge.status(), /argumentos inválidos/);
  assert.deepEqual(await bridge.keepAwake(true), { ok: true });
});

test('resposta assíncrona: resumo com ok:false e error não é falha da ponte', async () => {
  const bridge = await freshBridge({
    call: () => '{}',
    callAsync(id, method) {
      const answer =
        method === 'speedTest'
          ? { ok: false, error: 'offline', bytesDown: 0, bytesUp: 0 }
          : method === 'ping'
            ? { error: 'host inválido' }
            : { accepted: true };
      queueMicrotask(() => globalThis.__wrx.resolve(id, JSON.stringify(answer)));
    },
  });
  assert.deepEqual(await bridge.speedTest('light'), { ok: false, error: 'offline', bytesDown: 0, bytesUp: 0 });
  await assert.rejects(() => bridge.ping('-c 1'), /host inválido/);
  assert.deepEqual(await bridge.scan(), { accepted: true });
});

test('eventos chegam aos ouvintes e um ouvinte com erro não derruba os outros', async () => {
  const bridge = await freshBridge({ call: () => '{}', callAsync() {} });
  const seen = [];
  bridge.on('rssi', () => {
    throw new Error('ouvinte ruim');
  });
  const off = bridge.on('rssi', (d) => seen.push(d.rssi));
  const quiet = console.error;
  console.error = () => {};
  try {
    globalThis.__wrx.emit('rssi', JSON.stringify({ rssi: -60 }));
    globalThis.__wrx.emit('rssi', { rssi: -61 });
    off();
    globalThis.__wrx.emit('rssi', { rssi: -62 });
  } finally {
    console.error = quiet;
  }
  assert.deepEqual(seen, [-60, -61]);
});

test('botão voltar: sem tratador devolve false; com tratador devolve o que ele disser', async () => {
  const bridge = await freshBridge({ call: () => '{}', callAsync() {} });
  assert.equal(globalThis.__wrx.back(), false);
  bridge.onBack(() => true);
  assert.equal(globalThis.__wrx.back(), true);
  bridge.onBack(() => {
    throw new Error('x');
  });
  assert.equal(globalThis.__wrx.back(), false);
});
