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

test('com o simulador respondendo, o que o celular manda por conta própria é descartado', async () => {
  const bridge = await freshBridge({ call: () => '{}', callAsync() {} });
  const seen = [];
  bridge.on('scan', (ev) => seen.push(`scan:${ev.source}`));
  bridge.on('rssi', (s) => seen.push(`rssi:${s.rssi}`));
  bridge.on('connection', (c) => seen.push(`conn:${c.ssid}`));
  globalThis.__wrx.emit('rssi', { rssi: -60 });
  assert.deepEqual(seen, ['rssi:-60'], 'no modo normal os eventos do celular chegam');

  // modo demonstração ligado: o Android continua emitindo (busca do sistema, sinal a cada segundo)
  await bridge.connect('sim', { world: 'kitnet', seed: 1 });
  try {
    assert.equal(bridge.kind(), 'sim');
    globalThis.__wrx.emit('scan', JSON.stringify({ ts: 1, fresh: true, source: 'system', aps: [{ bssid: 'd8:c6:78:11:22:30', ssid: 'CasaDeVerdade', level: -50, frequency: 2437 }] }));
    globalThis.__wrx.emit('rssi', { rssi: -61 });
    globalThis.__wrx.emit('connection', { connected: true, ssid: 'CasaDeVerdade' });
    assert.deepEqual(seen, ['rssi:-60'], 'nada do celular entra na casa virtual');
  } finally {
    await bridge.connect('native'); // encerra o simulador (e os temporizadores dele)
  }
  globalThis.__wrx.emit('rssi', { rssi: -62 });
  assert.deepEqual(seen, ['rssi:-60', 'rssi:-62'], 'de volta ao celular, os eventos voltam a chegar');
});
