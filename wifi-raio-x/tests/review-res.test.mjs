// Revisão "resiliência em celular real": regras que atravessam mais de uma tela ou módulo.
//   node --test tests/review-res.test.mjs
//
// O que acontece num celular de verdade e não no simulador de mesa: a pessoa anda com o app
// aberto, o Android guarda listas velhas, o limite de buscas existe sem o celular dizer...
// (O comportamento de ponta a ponta fica em tests/e2e/review-res.e2e.mjs.)

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore, MAX_AP_AGE_MS } from '../app/js/store.js';
import { createScanLoop } from '../app/js/scan-loop.js';
import { liveConnection, liveSignalKey, connectionView, LIVE_RSSI_MS } from '../app/js/ui/networks-logic.js';
import { analyse } from '../app/js/ui/screens/best.js';
import { createManualClock, createSimBackend } from '../app/js/sim/backend.js';
import * as fx from './fixtures/scans.mjs';

const INFO = { platform: 'android', sdk: 34, release: '14', manufacturer: 'Google', model: 'Pixel 7', appVersion: '1.0.0', bands: { b24: true, b5: true, b6: true, b60: false }, standards: [4, 5, 6], rtt: true };
const HOME = fx.apartment.aps.find((a) => a.bssid === fx.apartmentTruth.own.b24); // "Familia Souza", 2,4 GHz
const NOW = fx.TS + 60_000;

const connectionTo = (ap, more = {}) => ({ connected: true, ssid: ap.ssid, bssid: ap.bssid, rssi: ap.level, frequency: ap.frequency, linkSpeed: 144, txSpeed: 144, rxSpeed: 144, wifiStandard: 6, securityType: 2, ...more });
const sample = (rssi, more = {}) => ({ ts: NOW, rssi, bssid: HOME.bssid, frequency: HOME.frequency, ...more });

/** O store depois de uma varredura do apartamento, com o roteador da casa ouvido em `level` dBm. */
function homeStore({ level = HOME.level, connection } = {}) {
  const store = createStore({ now: () => NOW });
  store.setInfo(INFO);
  store.setConnection(connection || connectionTo(HOME));
  store.ingestScan({ ...fx.apartment, ts: NOW, aps: fx.apartment.aps.map((ap) => (ap.bssid === HOME.bssid ? { ...ap, level } : ap)) });
  return store;
}

// ---------------------------------------------------------------------------
// realphone-02: o sinal da conexão é o de agora (a leitura de cada segundo), não o de quando o
// Android informou a conexão
// ---------------------------------------------------------------------------

test('liveConnection: a leitura ao vivo do mesmo rádio vai por cima do sinal e das velocidades', () => {
  const conn = connectionTo(HOME, { rssi: -47, linkSpeed: 144, txSpeed: 144, rxSpeed: 144 });
  const live = liveConnection({ connection: conn, rssi: sample(-80, { linkSpeed: 26, txSpeed: 26, rxSpeed: 39, frequency: 2462 }) }, { now: NOW + 900 });
  assert.equal(live.rssi, -80);
  assert.deepEqual([live.linkSpeed, live.txSpeed, live.rxSpeed, live.frequency], [26, 26, 39, 2462]);
  assert.equal(live.ssid, conn.ssid, 'o resto da conexão continua lá');
  assert.equal(conn.rssi, -47, 'a conexão do store não é alterada');
});

test('liveConnection: leitura velha, de outro rádio ou sem conexão não mexe em nada', () => {
  const conn = connectionTo(HOME, { rssi: -47 });
  assert.equal(liveConnection({ connection: conn, rssi: sample(-80) }, { now: NOW + LIVE_RSSI_MS + 1 }), conn, 'leitura com mais de 5 s');
  assert.equal(liveConnection({ connection: conn, rssi: sample(-80, { bssid: '02:00:00:00:00:99' }) }, { now: NOW }), conn, 'leitura de outro rádio');
  assert.equal(liveConnection({ connection: conn, rssi: null }, { now: NOW }), conn);
  assert.equal(liveConnection({ connection: conn, rssi: { ts: NOW, rssi: 'forte' } }, { now: NOW }), conn);
  assert.equal(liveConnection({ connection: null, rssi: sample(-80) }, { now: NOW }), null);
  const off = { connected: false };
  assert.equal(liveConnection({ connection: off, rssi: sample(-80) }, { now: NOW }), off);
  assert.equal(liveConnection(null), null);
});

test('liveConnection: identidade escondida (BSSID vazio de um lado ou do outro) ainda casa', () => {
  // sem a permissão o Android esconde o BSSID da leitura e/ou o da conexão
  const hidden = liveConnection({ connection: connectionTo(HOME, { rssi: -47 }), rssi: sample(-79, { bssid: '' }) }, { now: NOW });
  assert.equal(hidden.rssi, -79);
  const anonymous = liveConnection({ connection: { connected: true, rssi: -47 }, rssi: sample(-79) }, { now: NOW });
  assert.equal(anonymous.rssi, -79);
  const upper = liveConnection({ connection: connectionTo(HOME, { rssi: -47, bssid: HOME.bssid.toUpperCase() }), rssi: sample(-79) }, { now: NOW });
  assert.equal(upper.rssi, -79, 'maiúsculas e minúsculas não separam o mesmo rádio');
});

test('liveConnection: velocidade desconhecida na leitura (0 ou -1) não apaga a da conexão', () => {
  const live = liveConnection({ connection: connectionTo(HOME, { linkSpeed: 144, txSpeed: 130, rxSpeed: 120 }), rssi: sample(-60, { linkSpeed: -1, txSpeed: 0, frequency: 0 }) }, { now: NOW });
  assert.deepEqual([live.rssi, live.linkSpeed, live.txSpeed, live.rxSpeed, live.frequency], [-60, 144, 130, 120, HOME.frequency]);
});

test('liveConnection: com o histórico vale a mediana das leituras ao vivo (uma leitura torta não decide)', () => {
  const conn = connectionTo(HOME, { rssi: -47 });
  const at = (ms, rssi, more) => sample(rssi, { ts: NOW - ms, ...more });
  const history = [at(9000, -40), at(4000, -74), at(3000, -73), at(2000, -74), at(1000, -73), at(0, -88)];
  const state = { connection: conn, rssi: history[history.length - 1] };
  assert.equal(liveConnection(state, { now: NOW }).rssi, -88, 'sem histórico: a última leitura');
  assert.equal(liveConnection(state, { now: NOW, history }).rssi, -74, 'mediana de −88, −73, −74, −73, −74 (a de 9 s atrás não conta)');
  // número par de leituras: a média das duas do meio, arredondada
  const even = [at(3000, -76), at(2000, -72), at(1000, -74), at(0, -88)];
  assert.equal(liveConnection({ connection: conn, rssi: even[3] }, { now: NOW, history: even }).rssi, -75, 'entre −76 e −74');
  // o celular trocou de rádio no meio: só contam as leituras depois da troca
  const roamed = [at(3000, -50, { bssid: '02:00:00:00:00:99' }), at(2000, -51, { bssid: '02:00:00:00:00:99' }), at(1000, -80), at(0, -82)];
  assert.equal(liveConnection({ connection: conn, rssi: roamed[3] }, { now: NOW, history: roamed }).rssi, -81);
  // histórico vazio ou torto: fica a última leitura
  assert.equal(liveConnection(state, { now: NOW, history: [] }).rssi, -88);
  assert.equal(liveConnection(state, { now: NOW, history: [null, { rssi: 'x' }] }).rssi, -88);
});

test('liveSignalKey: muda só quando o sinal ao vivo troca de nível', () => {
  const conn = connectionTo(HOME, { rssi: -47 });
  const key = (rssi) => liveSignalKey({ connection: conn, rssi: sample(rssi) }, { now: NOW });
  assert.equal(key(-70), 'fair');
  assert.equal(key(-74), 'fair');
  assert.equal(key(-76), 'weak');
  assert.equal(key(-83), 'very-weak');
  assert.equal(liveSignalKey({ connection: conn, rssi: null }, { now: NOW }), 'excellent', 'sem leitura ao vivo: o que a conexão trouxe');
  assert.equal(liveSignalKey({ connection: { connected: false }, rssi: sample(-70) }, { now: NOW }), '');
  assert.equal(liveSignalKey({ connection: { connected: true }, rssi: null }, { now: NOW }), '');
});

test('o cartão da conexão e o diagnóstico usam a mesma regra de "leitura ao vivo"', () => {
  const store = homeStore({ connection: connectionTo(HOME, { rssi: -47 }) });
  store.setRssi(sample(-79));
  for (const now of [NOW, NOW + LIVE_RSSI_MS, NOW + LIVE_RSSI_MS + 1]) {
    const view = connectionView(store.get(), now);
    assert.equal(liveConnection(store.get(), { now }).rssi, view.rssi, `em +${now - NOW} ms`);
    assert.equal(view.live, now - NOW <= LIVE_RSSI_MS);
  }
});

test('store.rssiHistory(n): só as n leituras mais novas, a mais nova por último', () => {
  const store = createStore();
  for (let i = 0; i < 10; i++) store.setRssi({ ts: NOW + i * 1000, rssi: -50 - i, bssid: HOME.bssid, frequency: 2437 });
  assert.deepEqual(store.rssiHistory(3).map((s) => s.rssi), [-57, -58, -59]);
  assert.equal(store.rssiHistory().length, 10);
  assert.equal(store.rssiHistory(50).length, 10);
  assert.equal(store.rssiHistory(0).length, 10, 'sem número válido devolve tudo, como antes');
});

test('diagnóstico: abriu perto do roteador e andou até um ponto fraco -> avisa do sinal fraco', () => {
  // a conexão foi informada com −47 dBm (perto do roteador) e não foi reenviada; a varredura e a
  // leitura de cada segundo já mostram −80
  const store = homeStore({ level: -80, connection: connectionTo(HOME, { rssi: -47, linkSpeed: 144, txSpeed: 144, rxSpeed: 144 }) });
  store.setRssi(sample(-80, { linkSpeed: 26, txSpeed: 26, rxSpeed: 26 }));
  const out = analyse(store.get(), { now: NOW + 500, history: store.rssiHistory() });
  const weak = out.insights.find((i) => i.id === 'weak-signal');
  assert.ok(weak, `esperava o aviso de sinal fraco; veio: ${out.insights.map((i) => i.id).join(', ')}`);
  assert.match(weak.title, /Sinal fraco aqui \(.80\sdBm\)/);
  assert.ok(!out.insights.some((i) => i.id === 'all-good'));
  // sem as leituras (analyse(state) como os testes antigos chamam) a função continua funcionando
  assert.ok(Array.isArray(analyse(store.get()).insights));
});

test('diagnóstico: abriu num ponto fraco e andou para perto do roteador -> o aviso de sinal fraco some', () => {
  const store = homeStore({ level: -48, connection: connectionTo(HOME, { rssi: -80, linkSpeed: 26, txSpeed: 26, rxSpeed: 26 }) });
  store.setRssi(sample(-48, { linkSpeed: 144, txSpeed: 144, rxSpeed: 144 }));
  const out = analyse(store.get(), { now: NOW + 500, history: store.rssiHistory() });
  assert.ok(!out.insights.some((i) => i.id === 'weak-signal'), `não devia avisar de sinal fraco; veio: ${out.insights.map((i) => i.id).join(', ')}`);
  // e com a leitura velha demais (o celular parou de mandar) vale de novo o que a conexão trouxe
  const stale = analyse(store.get(), { now: NOW + LIVE_RSSI_MS + 2000, history: store.rssiHistory() });
  assert.ok(stale.insights.some((i) => i.id === 'weak-signal'));
});

// ---------------------------------------------------------------------------
// realphone-06: nada de `* + *` no CSS
// ---------------------------------------------------------------------------

test('CSS: nenhuma regra com irmão universal dos dois lados (`* + *`, `* ~ *`)', () => {
  // Com uma regra dessas na página, cada elemento inserido, removido ou mudado de lugar faz o
  // navegador recalcular o estilo de TODOS os descendentes do pai dele (não só dos irmãos). Na
  // lista de redes, que se reordena a cada busca, eram milhares de elementos por busca.
  // "Todos os filhos menos o primeiro" se escreve `X > * { ... }` + `X > :first-child { ... }`.
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../app/css');
  const problems = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    const source = readFileSync(join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    source.split('\n').forEach((line, i) => {
      if (/(^|[\s>+~,(])\*\s*[+~]\s*\*/.test(line)) problems.push(`${name}:${i + 1} ${line.trim()}`);
    });
  }
  // CSS embutido em JavaScript (componentes que injetam a própria folha, como o medidor): a regra
  // vale para a página inteira assim que o componente é usado. `* + *` não é JavaScript válido,
  // então fora dos comentários só pode estar num texto de CSS.
  const jsDir = join(dir, '../js');
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js')) {
        const source = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
        source.split('\n').forEach((line, i) => {
          if (/^\s*\/\//.test(line)) return;
          if (/[>\s]\*\s*[+~]\s*\*\s*[{,:]/.test(line)) problems.push(`${path.slice(jsDir.length + 1)}:${i + 1} ${line.trim().slice(0, 120)}`);
        });
      }
    }
  };
  walk(jsDir);
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// realphone-03: foco visível também nos WebViews sem :focus-visible (anteriores ao 86)
// ---------------------------------------------------------------------------

test('CSS: o contorno de foco nunca é apagado com `:focus { outline: none }` solto', () => {
  // Um WebView que não conhece :focus-visible descarta as regras que o usam. Se `:focus` apaga o
  // contorno e só `:focus-visible` o devolve, nesses aparelhos o foco fica invisível. A forma certa
  // é `:focus:not(:focus-visible) { outline: none }` (descartada inteira onde não é entendida).
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../app/css');
  const problems = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.css'))) {
    const source = readFileSync(join(dir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|[;\s])outline\s*:\s*(none|0)\b/.test(body)) continue;
      for (const selector of selectors.split(',').map((x) => x.trim().replace(/\s+/g, ' '))) {
        // só o seletor universal (`:focus`, `*:focus`): tirar o contorno de um componente específico é outra conversa
        if (/^\*?:focus$/.test(selector)) problems.push(`${name}: ${selector} { outline: none }`);
      }
    }
  }
  assert.deepEqual(problems, []);
  const app = readFileSync(join(dir, 'app.css'), 'utf8');
  assert.match(app, /:focus:not\(:focus-visible\)\s*\{\s*outline:\s*none/);
  // os campos mostram o foco também com :focus puro
  assert.match(app, /\.input:focus\s*\{\s*border-color/);
  assert.match(app, /\.select > select:focus\s*\{\s*border-color/);
});

// ---------------------------------------------------------------------------
// Laço de buscas de verdade + store de verdade, com ponte e relógio de mentira
// ---------------------------------------------------------------------------

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

const scanAp = (n, more = {}) => ({ bssid: `aa:bb:cc:00:00:${String(n).padStart(2, '0')}`, ssid: `Rede ${n}`, level: -50 - n, frequency: 2412 + 5 * n, channelWidth: 0, centerFreq0: 0, centerFreq1: 0, capabilities: '[WPA2-PSK-CCMP][ESS]', ...more });

/**
 * Um "celular" com a regra do Android: no máximo `max` buscas a cada `windowMs` (quando `limit`).
 * `cached` é o que lastScan() devolve; uma busca recusada reentrega essa lista como evento 'scan'.
 */
function fakePhone(clock, { limit = false, max = 4, windowMs = 120_000, scanMs = 2500, cached = [], fresh = () => [scanAp(1, { ageMs: 40 }), scanAp(2, { ageMs: 60 })] } = {}) {
  const listeners = new Map();
  const accepted = [];
  const phone = {
    limit,
    cached,
    requests: [], // [segundo desde o início, 'ok' | motivo]
    freshAt: [], // segundos em que chegou uma lista nova
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
    emit(name, data) {
      for (const fn of [...(listeners.get(name) || [])]) fn(data);
    },
    async scan() {
      const t = clock.now();
      const second = Math.round((t - clock.start) / 1000);
      while (accepted.length && accepted[0] < t - windowMs) accepted.shift();
      if (phone.limit && accepted.length >= max) {
        phone.requests.push([second, 'throttled']);
        clock.setTimer(() => phone.emit('scan', { ts: clock.now(), fresh: false, source: 'cache', aps: phone.cached }), 50);
        return { accepted: false, reason: 'throttled' };
      }
      if (phone.limit) accepted.push(t);
      phone.requests.push([second, 'ok']);
      clock.setTimer(() => {
        phone.freshAt.push(Math.round((clock.now() - clock.start) / 1000));
        phone.emit('scan', { ts: clock.now(), fresh: true, source: 'request', aps: fresh() });
      }, scanMs);
      return { accepted: true };
    },
    async lastScan() {
      return { ts: clock.now(), fresh: false, source: 'cache', aps: phone.cached };
    },
  };
  return phone;
}

function realLoop({ phone: phoneOptions, info = null, status = {}, config } = {}) {
  const clock = fakeClock();
  const phone = fakePhone(clock, phoneOptions);
  const store = createStore({ now: clock.now });
  store.setInfo(info);
  store.setStatus({ wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: false, canScan: true, ...status });
  const loop = createScanLoop({ bridge: phone, store, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, doc: null, config });
  return { clock, phone, store, loop };
}

// ---------------------------------------------------------------------------
// realphone-04: a lista guardada pelo Android, velha demais, não conta como "a primeira busca"
// ---------------------------------------------------------------------------

test('lista guardada só com leituras de mais de 90 s: as telas seguem em "procurando" até a primeira busca de verdade', async () => {
  const old = [scanAp(1, { ageMs: 180_000 }), scanAp(2, { ageMs: 181_500 }), scanAp(3, { ageMs: MAX_AP_AGE_MS + 1 })];
  const { clock, store, loop } = realLoop({ phone: { cached: old, scanMs: 4000 } });
  loop.start();
  await clock.advance(1000); // a lista guardada já chegou; a primeira busca ainda está rodando
  let state = store.get();
  assert.equal(state.scan.seq, 0, 'a lista velha não conta como varredura (as telas decidem "carregando" por seq === 0)');
  assert.equal(state.aps.length, 0);
  assert.equal(state.scan.dataAt, null, 'nem vira "atualizado há 3 min"');
  assert.equal(state.scan.scanning, true);
  await clock.advance(4000);
  state = store.get();
  assert.equal(state.scan.seq, 1);
  assert.equal(state.scan.fresh, true);
  assert.equal(state.aps.length, 2);
});

test('lista guardada com idades misturadas: conta, e só as leituras recentes entram na lista', async () => {
  const mixed = [scanAp(1, { ageMs: 180_000 }), scanAp(2, { ageMs: 30_000 }), scanAp(3, { ageMs: 200_000 }), scanAp(4, { ageMs: 5000 })];
  const { clock, store, loop } = realLoop({ phone: { cached: mixed, scanMs: 4000 } });
  loop.start();
  await clock.advance(1000);
  const state = store.get();
  assert.equal(state.scan.seq, 1);
  assert.equal(state.scan.fresh, false);
  assert.deepEqual(state.aps.map((ap) => ap.ssid).sort(), ['Rede 2', 'Rede 4']);
  assert.equal(state.scan.dataAt, clock.start - 5000, 'a idade dos dados é a da leitura mais nova (5 s quando a lista chegou)');
});

test('primeiro pedido recusado que só devolve a lista velha: continua sem contar', async () => {
  const old = [scanAp(1, { ageMs: 240_000 }), scanAp(2, { ageMs: 300_000 })];
  const { clock, store, loop, phone } = realLoop({ phone: { cached: old, limit: true, max: 0 } });
  loop.start();
  await clock.advance(40_000);
  assert.ok(phone.requests.length >= 2 && phone.requests.every(([, answer]) => answer === 'throttled'), 'todos os pedidos foram recusados');
  assert.equal(store.get().scan.seq, 0);
  assert.equal(store.get().aps.length, 0);
  assert.equal(store.get().scan.lastReason, 'throttled', 'o motivo da recusa continua à vista para as telas');
});

test('store.ingestScan: o que continua contando como varredura', () => {
  const T = 1_700_000_000_000;
  const event = (aps, more = {}) => ({ ts: T, fresh: true, source: 'request', aps, ...more });
  // lista NOVA vazia: é um resultado de verdade ("nenhuma rede por perto")
  let store = createStore({ now: () => T });
  store.ingestScan(event([]));
  assert.equal(store.get().scan.seq, 1);
  // lista guardada vazia: como antes, conta
  store = createStore({ now: () => T });
  store.ingestScan(event([], { fresh: false, source: 'cache' }));
  assert.equal(store.get().scan.seq, 1);
  // leitura sem idade não é tratada como velha
  store = createStore({ now: () => T });
  store.ingestScan(event([scanAp(1), scanAp(2, { ageMs: 500_000 })], { fresh: false, source: 'cache' }));
  assert.equal(store.get().scan.seq, 1);
  assert.deepEqual(store.get().aps.map((ap) => ap.ssid), ['Rede 1']);
  // exatamente no limite ainda vale; um milissegundo depois, não
  store = createStore({ now: () => T });
  store.ingestScan(event([scanAp(1, { ageMs: MAX_AP_AGE_MS + 1 })], { fresh: false, source: 'cache' }));
  assert.equal(store.get().scan.seq, 0);
  store.ingestScan(event([scanAp(1, { ageMs: MAX_AP_AGE_MS })], { fresh: false, source: 'cache' }));
  assert.equal(store.get().scan.seq, 1);
  assert.equal(store.get().aps.length, 1);
  // depois da primeira varredura a regra dos 90 s segue como era: a lista velha conta e não lista ninguém novo
  store.ingestScan(event([scanAp(7, { ageMs: 400_000 })], { ts: T + 10_000, fresh: false, source: 'cache' }));
  assert.equal(store.get().scan.seq, 2);
  assert.ok(!store.get().aps.some((ap) => ap.ssid === 'Rede 7'));
});

// ---------------------------------------------------------------------------
// realphone-05: quando a identidade da conexão volta a aparecer, a conexão é reenviada
// ---------------------------------------------------------------------------

/** Simulador com relógio manual e todos os eventos guardados. */
function bootSim(t, options = {}) {
  const clock = createManualClock();
  const events = [];
  const backend = createSimBackend({ emit: (name, data) => events.push({ name, data }), clock, walk: 'still', ...options });
  t.after(() => backend.dispose());
  return { clock, events, backend, sim: backend.sim, of: (name) => events.filter((e) => e.name === name).map((e) => e.data), clear: () => events.splice(0, events.length) };
}

test('simulador: ligar a Localização reenvia a conexão, agora com o nome e o BSSID da rede', (t) => {
  const s = bootSim(t, { location: false });
  s.clock.advance(3000);
  const blind = s.backend.call('connection');
  assert.equal(blind.connected, true);
  assert.equal(blind.ssid, undefined, 'com a Localização desligada o Android esconde em que rede o celular está');
  assert.equal(blind.bssid, undefined);
  s.clear();

  s.sim.setState({ location: true });
  const [conn] = s.of('connection');
  assert.ok(conn, 'a conexão foi reenviada');
  assert.equal(conn.connected, true);
  assert.equal(typeof conn.ssid, 'string');
  assert.match(conn.bssid, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
  assert.equal(s.of('status').length, 1, 'o Status continua sendo enviado uma vez');

  // desligar de novo: a conexão é reenviada sem a identidade (como o celular a mostra)
  s.clear();
  s.sim.setState({ location: false });
  assert.equal(s.of('connection').length, 1);
  assert.equal(s.of('connection')[0].bssid, undefined);

  // o que não muda a identidade não reenvia nada
  s.sim.setState({ location: true });
  s.clear();
  s.sim.setState({ throttle: true });
  assert.equal(s.of('connection').length, 0);
  // Wi-Fi desligado e ligado continuam com os avisos de sempre (um "desconectado" e, depois, a volta)
  s.sim.setState({ wifi: false });
  assert.deepEqual(s.of('connection'), [{ connected: false }]);
});

test('simulador: conceder a permissão reenvia a conexão com a identidade; negar não reenvia', async (t) => {
  const s = bootSim(t, { permission: 'denied' });
  s.clock.advance(3000);
  assert.equal(s.backend.call('connection').bssid, undefined);
  s.clear();

  // negada de novo: nada muda
  s.sim.setState({ permissionReply: 'denied' });
  let asked = s.backend.callAsync('requestPermission');
  await s.clock.advanceAsync(2000);
  assert.equal((await asked).permission, 'denied');
  assert.equal(s.of('connection').length, 0);

  // concedida: logo depois do Status vem a conexão, com nome e BSSID
  s.sim.setState({ permissionReply: 'granted' });
  s.clear();
  asked = s.backend.callAsync('requestPermission');
  await s.clock.advanceAsync(2000);
  assert.equal((await asked).permission, 'granted');
  const conns = s.of('connection');
  assert.equal(conns.length, 1);
  assert.equal(typeof conns[0].ssid, 'string');
  assert.match(conns[0].bssid, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
});

// ---------------------------------------------------------------------------
// realphone-08: Android 9 e 10 têm o limite de buscas e não o informam (Status.throttled = null)
// ---------------------------------------------------------------------------

const ANDROID = (sdk) => ({ platform: 'android', sdk, release: String(sdk - 19), manufacturer: 'Marca', model: 'Modelo', appVersion: '1.0.0', bands: { b24: true, b5: true, b6: false, b60: false }, standards: [], rtt: false });
const gapsOf = (list) => list.slice(1).map((x, i) => x - list[i]);
const refusedAt = (phone) => phone.requests.filter(([, answer]) => answer !== 'ok').map(([second]) => second);
const acceptedAt = (phone) => phone.requests.filter(([, answer]) => answer === 'ok').map(([second]) => second);

for (const mode of ['normal', 'mapping']) {
  test(`Android 9 (limite fixo, não informado), modo ${mode}: começa no ritmo de 30 s, sem nenhuma recusa e sem "apagão"`, async () => {
    const { clock, phone, store, loop } = realLoop({ info: ANDROID(28), status: { throttled: null }, phone: { limit: true } });
    loop.setMode(mode);
    loop.start();
    assert.equal(loop.getState().throttled, true, 'o laço já parte sabendo do limite');
    assert.equal(loop.getState().intervalMs, 30_000);
    await clock.advance(10 * 60_000);
    assert.deepEqual(refusedAt(phone), [], 'nenhum pedido recusado em 10 minutos (nem sondas: no Android 9 o limite não pode ser desligado)');
    assert.deepEqual(acceptedAt(phone).slice(0, 5), [0, 30, 60, 90, 121], 'a 5ª busca espera a 1ª sair da janela de 2 minutos do Android');
    assert.ok(Math.max(...gapsOf(phone.freshAt)) <= 32, `nunca mais de ~30 s sem lista nova (maior intervalo: ${Math.max(...gapsOf(phone.freshAt))} s)`);
    assert.equal(store.get().loop.throttled, true);
    assert.equal(store.get().scan.lastReason, null);
  });
}

test('Android 10 com o limite ligado: ritmo de 30 s desde o começo; a sonda recusada não abre um buraco', async () => {
  const { clock, phone, loop } = realLoop({ info: ANDROID(29), status: { throttled: null }, phone: { limit: true } });
  loop.setMode('mapping');
  loop.start();
  await clock.advance(10 * 60_000);
  assert.deepEqual(acceptedAt(phone).slice(0, 4), [0, 30, 60, 90]);
  assert.ok(refusedAt(phone).every((second) => second > 90), `nenhuma recusa antes da primeira sonda, que só sai depois de 4 buscas aceitas (${refusedAt(phone).join(', ')})`);
  assert.ok(refusedAt(phone).length >= 1 && refusedAt(phone).length <= 2, 'uma sonda de vez em quando, cada vez mais rara');
  assert.ok(Math.max(...gapsOf(phone.freshAt)) <= 33, `maior intervalo sem lista nova: ${Math.max(...gapsOf(phone.freshAt))} s (antes: mais de 100 s logo depois de abrir)`);
  assert.equal(loop.getState().throttled, true);
});

test('Android 10 com o limite desligado nas opções do desenvolvedor: a sonda descobre e o ritmo rápido volta', async () => {
  const { clock, phone, loop } = realLoop({ info: ANDROID(29), status: { throttled: null }, phone: { limit: false } });
  loop.start();
  assert.equal(loop.getState().throttled, true);
  await clock.advance(5 * 60_000);
  assert.deepEqual(refusedAt(phone), []);
  assert.deepEqual(acceptedAt(phone).slice(0, 7), [0, 30, 60, 90, 100, 110, 120], 'depois de 4 buscas aceitas, arrisca o ritmo rápido; aceito, segue nele');
  assert.equal(loop.getState().throttled, false);
  assert.equal(loop.getState().intervalMs, 10_000);
});

test('demais aparelhos: o começo continua como era', async () => {
  // Android 13 dizendo que não há limite, e o simulador (sdk 0): rápido desde o começo
  for (const [info, status] of [
    [ANDROID(33), { throttled: false }],
    [{ platform: 'sim', sdk: 0 }, { throttled: false }],
    [{ platform: 'sim', sdk: 0 }, { throttled: null }],
    [null, { throttled: null }],
  ]) {
    const { clock, phone, loop } = realLoop({ info, status, phone: { limit: false } });
    loop.start();
    assert.equal(loop.getState().throttled, false);
    await clock.advance(45_000);
    assert.deepEqual(acceptedAt(phone), [0, 10, 20, 30, 40], JSON.stringify(info));
  }
  // Android 13 que diz que o limite está ligado: 30 s, como sempre
  const limited = realLoop({ info: ANDROID(33), status: { throttled: true }, phone: { limit: true } });
  limited.loop.start();
  await limited.clock.advance(125_000);
  assert.deepEqual(acceptedAt(limited.phone), [0, 30, 60, 90, 121]);
  assert.deepEqual(refusedAt(limited.phone), []);
  // Android 8 (sem limite nenhum, e sem informar): rápido
  const old = realLoop({ info: ANDROID(26), status: { throttled: null }, phone: { limit: false } });
  old.loop.start();
  assert.equal(old.loop.getState().throttled, false);
  await old.clock.advance(25_000);
  assert.deepEqual(acceptedAt(old.phone), [0, 10, 20]);
});

test('trocar de lado (celular Android 9 <-> demonstração) refaz a suposição do limite', async () => {
  const { clock, store, loop } = realLoop({ info: ANDROID(28), status: { throttled: null }, phone: { limit: true } });
  loop.start();
  await clock.advance(1000);
  assert.equal(loop.getState().throttled, true);
  // demonstração ligada: o simulador informa que não há limite
  loop.stop();
  store.setInfo({ platform: 'sim', sdk: 0 });
  store.setStatus({ wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: false, canScan: true });
  loop.reset();
  loop.start();
  assert.equal(loop.getState().throttled, false);
  // de volta ao celular
  loop.stop();
  store.setInfo(ANDROID(28));
  store.setStatus({ wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: null, canScan: true });
  loop.reset();
  loop.start();
  assert.equal(loop.getState().throttled, true);
});

// ---------------------------------------------------------------------------
// realphone-01: com a demonstração ligada, o Status do celular também não entra
// ---------------------------------------------------------------------------

test('ponte: com o simulador respondendo, o Status que o Android reenvia é descartado (e o "voltar" e as respostas pendentes continuam valendo)', async () => {
  const calls = [];
  let pendingId = null;
  globalThis.WrxNative = {
    call(method) {
      calls.push(method);
      return method === 'status' ? JSON.stringify({ wifiEnabled: true, locationEnabled: true, permission: 'denied', throttled: true, canScan: false }) : '{"ok":true}';
    },
    callAsync(id, method) {
      calls.push(method);
      pendingId = id;
    },
  };
  delete globalThis.__wrx;
  const bridge = await import(`../app/js/bridge.js?caso=${Math.random()}`);
  try {
    await bridge.connect('native');
    const seen = [];
    bridge.on('status', (st) => seen.push(st.permission));
    globalThis.__wrx.emit('status', JSON.stringify({ permission: 'denied', canScan: false }));
    assert.deepEqual(seen, ['denied'], 'no modo normal o Status do celular chega');
    const slow = bridge.requestPermission(); // um pedido ao celular ainda sem resposta
    await Promise.resolve();

    await bridge.connect('sim', { world: 'kitnet', seed: 1, walk: 'still' });
    seen.length = 0;
    // o Android reenvia o Status ao voltar para o app (Bridge.onResume): não pode virar bloqueio na demonstração
    globalThis.__wrx.emit('status', JSON.stringify({ permission: 'denied', canScan: false }));
    assert.ok(!seen.includes('denied'), 'o Status do celular não entra na demonstração');
    assert.equal((await bridge.status()).permission, 'granted', 'quem responde é o simulador');
    // o "voltar" do Android e a resposta de um pedido antigo continuam funcionando
    bridge.onBack(() => true);
    assert.equal(globalThis.__wrx.back(), true);
    globalThis.__wrx.resolve(pendingId, JSON.stringify({ permission: 'denied' }));
    assert.deepEqual(await slow, { permission: 'denied' });
  } finally {
    await bridge.connect('native'); // encerra o simulador (e os temporizadores dele)
    delete globalThis.WrxNative;
  }
});
