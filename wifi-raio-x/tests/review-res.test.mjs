// Revisão "resiliência em celular real": regras que atravessam mais de uma tela ou módulo.
//   node --test tests/review-res.test.mjs
//
// O que acontece num celular de verdade e não no simulador de mesa: a pessoa anda com o app
// aberto, o Android guarda listas velhas, o limite de buscas existe sem o celular dizer...
// (O comportamento de ponta a ponta fica em tests/e2e/review-res.e2e.mjs.)

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../app/js/store.js';
import { liveConnection, liveSignalKey, connectionView, LIVE_RSSI_MS } from '../app/js/ui/networks-logic.js';
import { analyse } from '../app/js/ui/screens/best.js';
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
