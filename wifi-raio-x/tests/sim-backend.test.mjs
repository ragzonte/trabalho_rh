// Testes do simulador da ponte (app/js/sim/backend.js) e do conferidor do contrato
// (tests/helpers/contract.mjs). Tudo roda com o relógio manual: o teste avança o tempo e
// nada depende do relógio de verdade (exceto os testes do fim, que são sobre isso).
//
// Onde o comportamento imita o Android (motivos de recusa, textos de erro, ordem dos
// eventos), o que se confere aqui foi tirado do lado nativo: android/.../Bridge.java,
// WifiScanner.java, Pinger.java, LanScanner.java, RttRanger.java, ConnectionMapper.java.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { parseIes, summarizeIes } from '../app/js/core/ies.js';
import { parseCapabilities, refineWithIes } from '../app/js/core/security.js';
import { APP_VERSION, SCAN_REFUSAL, createManualClock, createSimBackend, currentSim } from '../app/js/sim/backend.js';
import { HOSTILE_SSIDS, HOSTILE_TEXT } from '../app/js/sim/demo-data.js';
import { listPresets, presetSpec, presetWorld } from '../app/js/sim/presets.js';
import {
  BSSID_RE,
  CANCEL_OPS,
  EVENTS,
  METHODS,
  SCAN_REASONS,
  SETTINGS_PANELS,
  assertArgs,
  assertEvent,
  assertResult,
  assertType,
  checkArgs,
  checkEvent,
  checkResult,
  checkType,
  isAsyncMethod,
} from './helpers/contract.mjs';

const PRESETS = listPresets().map((p) => p.id);
const WORLDS = [...PRESETS, 'sorteada'];

/** Simulador com relógio manual e todos os eventos guardados. */
function boot(t, options = {}) {
  const clock = options.clock || createManualClock();
  const events = [];
  const backend = createSimBackend({ emit: (name, data) => events.push({ name, data, at: clock.now() }), clock, ...options });
  if (t) t.after(() => backend.dispose());
  return {
    clock,
    events,
    backend,
    sim: backend.sim,
    of: (name) => events.filter((e) => e.name === name).map((e) => e.data),
    clear: () => events.splice(0, events.length),
  };
}

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const onStairs = (p) => Math.abs(p.z - (p.floor * 2.8 + 1.2)) > 1e-6;
const utf8Hex = (text) => Buffer.from(text, 'utf8').toString('hex');

// Mundo com o roteador da casa mais fraco (para testar sinal ruim sem depender da planta).
function weakKitnet(dropDb) {
  const spec = presetSpec('kitnet', 1);
  for (const a of spec.aps) if (a.own) a.eirpDbm -= dropDb;
  return spec;
}

// ---------------------------------------------------------------------------
// O conferidor do contrato precisa reprovar o que está errado
// ---------------------------------------------------------------------------

const GOOD_AP = Object.freeze({
  bssid: 'aa:bb:cc:dd:ee:ff',
  ssid: 'Casa',
  level: -57,
  frequency: 5180,
  channelWidth: 2,
  centerFreq0: 5210,
  centerFreq1: 0,
  capabilities: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]',
  ageMs: 120,
  wifiStandard: 6,
  ies: [{ id: 48, ext: 0, hex: '0100000fac04' }],
});

test('contrato: aceita o que está certo e aponta cada tipo de erro', () => {
  assert.deepEqual(checkType('ScanAp', GOOD_AP), []);
  const bad = (patch, pattern) => {
    const problems = checkType('ScanAp', { ...GOOD_AP, ...patch });
    assert.ok(problems.length > 0, `devia reprovar ${JSON.stringify(patch)}`);
    assert.match(problems.join('\n'), pattern);
  };
  bad({ bssid: 'AA:BB:CC:DD:EE:FF' }, /bssid/);
  bad({ bssid: 'aabbccddeeff' }, /bssid/);
  bad({ level: '-57' }, /level/);
  bad({ level: -57.5 }, /level/);
  bad({ level: 20 }, /level/);
  bad({ frequency: 3000 }, /frequency/);
  bad({ channelWidth: 9 }, /channelWidth/);
  bad({ centerFreq0: 5600 }, /centerFreq0/);
  bad({ capabilities: 'WPA2' }, /capabilities/);
  bad({ ageMs: -1 }, /ageMs/);
  bad({ wifiStandard: 3 }, /wifiStandard/);
  bad({ wifiStandard: null }, /AUSENTE/);
  bad({ rttResponder: undefined }, /AUSENTE/);
  bad({ venueName: null }, /AUSENTE/);
  bad({ ies: null }, /AUSENTE/);
  bad({ ies: [{ id: 48, ext: 0, hex: '010' }] }, /hex/);
  bad({ ies: [{ id: 48, ext: 0, hex: 'zz' }] }, /hex/);
  bad({ ies: [{ id: 300, ext: 0, hex: '' }] }, /id/);
  bad({ ies: [{ id: 48, ext: 3, hex: '' }] }, /ext/);
  bad({ ies: [{ id: 48, hex: '' }] }, /ext/);
  bad({ ssid: 'x'.repeat(33) }, /ssid/);
  bad({ ssid: '🚀'.repeat(9) }, /ssid/);
  bad({ sinal: -57 }, /fora do contrato/);
  bad({ level: NaN }, /level/);
  assert.deepEqual(checkType('ScanAp', { ...GOOD_AP, sinal: -57 }, { extra: true }), []);
  const { ssid, ...semNome } = GOOD_AP;
  assert.match(checkType('ScanAp', semNome).join('\n'), /ssid: campo obrigatório ausente/);
  assert.ok(ssid);

  // Regras que cruzam campos.
  const status = { wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: null, canScan: true };
  assert.deepEqual(checkType('Status', status), []);
  assert.match(checkType('Status', { ...status, canScan: false }).join('\n'), /canScan/);
  assert.match(checkType('Status', { ...status, permission: 'ok' }).join('\n'), /permission/);
  assert.match(checkType('Status', { ...status, wifiEnabled: null }).join('\n'), /wifiEnabled/);
  assert.match(checkType('Connection', { connected: false, ssid: 'x' }).join('\n'), /connected = false/);
  assert.deepEqual(checkType('Connection', { connected: false }), []);
  assert.match(checkType('Connection', { connected: true, ip: '192.168.1.300' }).join('\n'), /ip/);
  assert.match(checkType('Connection', { connected: true, ipv6: ['192.168.1.3'] }).join('\n'), /ipv6/);
  assert.deepEqual(checkType('Connection', { connected: true, ipv6: ['fe80::1', '2804:14d:1:2:3:4:5:6'], dns: ['8.8.8.8', '2001:4860:4860::8888'] }), []);
  const sample = { ts: 1, rssi: -60, bssid: '', frequency: 2437 };
  assert.deepEqual(checkType('RssiSample', sample), [], 'bssid "" = escondido pelo Android');
  assert.match(checkType('RssiSample', { ...sample, bssid: 'x' }).join('\n'), /bssid/);
  assert.match(checkType('RssiSample', { ...sample, frequency: 3000 }).join('\n'), /frequency/);
  assert.match(checkType('PingReply', { host: 'a', seq: 1, ok: true }).join('\n'), /ms/);
  assert.match(checkType('PingReply', { host: 'a', seq: 1, ok: false, ms: 3 }).join('\n'), /ms/);
  assert.match(checkType('PingSummary', { host: 'a', method: 'icmp', sent: 4, received: 5, lossPct: 0 }).join('\n'), /received/);
  assert.match(checkType('PingSummary', { host: 'a', method: 'icmp', sent: 4, received: 2, lossPct: 10, min: 1, avg: 2, max: 3 }).join('\n'), /lossPct/);
  assert.match(checkType('RttResult', { bssid: GOOD_AP.bssid, ok: true }).join('\n'), /distM/);
  assert.match(checkType('LanProgress', { done: 5, total: 4 }).join('\n'), /done/);
  assert.match(checkType('ScanEvent', { ts: 1, fresh: true, source: 'cache', aps: [] }).join('\n'), /fresh/);
  assert.match(checkType('ScanEvent', { ts: 1, fresh: true, source: 'request', aps: [GOOD_AP, GOOD_AP] }).join('\n'), /repetido/);
  assert.deepEqual(checkType('SpeedProgress', { phase: 'download', progress: 0.5, mbps: 120.5, bytes: 1000 }), []);
  assert.match(checkType('SpeedProgress', { phase: 'latency', progress: 0.5, mbps: 1, bytes: 0 }).join('\n'), /mbps/);
  assert.match(checkType('SpeedProgress', { phase: 'upload', progress: 1.5, bytes: 0 }).join('\n'), /progress/);
  assert.deepEqual(checkType('SpeedSummary', { ok: false, error: 'offline', bytesDown: 0, bytesUp: 0 }), []);
  assert.match(checkType('SpeedSummary', { ok: false, bytesDown: 0, bytesUp: 0 }).join('\n'), /error/);
  assert.match(checkType('SpeedSummary', { ok: true, bytesDown: 0, bytesUp: 0 }).join('\n'), /downMbps/);
  assert.match(checkType('SpeedSummary', { ok: false, error: 'sem motivo', bytesDown: 0, bytesUp: 0 }).join('\n'), /error/);

  // Métodos e eventos.
  assert.deepEqual(checkResult('scan', { accepted: true }), []);
  assert.match(checkResult('scan', { accepted: false }).join('\n'), /motivo/);
  assert.match(checkResult('scan', { accepted: true, reason: 'x' }).join('\n'), /reason/);
  assert.match(checkResult('watchRssi', { ok: false }).join('\n'), /ok/);
  assert.match(checkResult('lastScan', { ts: 1, fresh: true, source: 'request', aps: [] }).join('\n'), /cache/);
  assert.match(checkResult('voar', {}).join('\n'), /fora do contrato/);
  assert.match(checkEvent('voo', {}).join('\n'), /fora do contrato/);
  assert.match(checkEvent('sim', {}, { simEvents: false }).join('\n'), /fora do contrato/);
  assert.deepEqual(checkArgs('ping', { host: '8.8.8.8', count: 10, timeoutMs: 1000 }), []);
  assert.deepEqual(checkArgs('ping', { host: '8.8.8.8' }), [], 'count e timeoutMs têm padrão no Android');
  assert.match(checkArgs('ping', { count: 3 }).join('\n'), /host/);
  assert.match(checkArgs('ping', { host: 'a.b', count: 500 }).join('\n'), /count/);
  assert.match(checkArgs('saveFile', { name: 'a.csv', mime: 'text/csv' }).join('\n'), /text OU base64/);
  assert.match(checkArgs('openSettings', { which: 'bluetooth' }).join('\n'), /which/);
  assert.match(checkArgs('speedTest', { mode: 'turbo' }).join('\n'), /mode/);
  assert.throws(() => assertType('Status', { ...status, canScan: false }), /fora do contrato da ponte/);
  assert.throws(() => assertArgs('cancel', { op: 'tudo' }), /fora do contrato da ponte/);

  // A tabela cobre exatamente os métodos e eventos de bridge.js.
  assert.deepEqual(
    Object.keys(METHODS).sort(),
    ['cancel', 'connection', 'info', 'keepAwake', 'lanScan', 'lastScan', 'openSettings', 'ping', 'requestPermission', 'rtt', 'saveFile', 'scan', 'setBars', 'share', 'speedTest', 'status', 'unwatchRssi', 'vibrate', 'watchRssi'],
  );
  assert.deepEqual(Object.keys(METHODS).filter(isAsyncMethod).sort(), ['lanScan', 'ping', 'requestPermission', 'rtt', 'scan', 'speedTest']);
  assert.deepEqual(Object.keys(EVENTS).sort(), ['connection', 'lan', 'lanProgress', 'ping', 'rssi', 'scan', 'speed', 'status']);
  assert.deepEqual([...CANCEL_OPS], ['ping', 'lan', 'speed']);
  assert.equal(isAsyncMethod('voar'), undefined);
});

test('contrato: a tabela do conferidor acompanha a do bridge.js', async () => {
  // Se alguém acrescentar um método ou evento ao bridge.js, este teste lembra de pôr no simulador e no conferidor.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../app/js/bridge.js', import.meta.url), 'utf8');
  const table = source.slice(source.indexOf('// Tabela dos métodos'), source.indexOf('const listeners'));
  const methods = [...table.matchAll(/^\/\/ (A)?\s+(\w+)\s+\{/gm)].map((m) => ({ name: m[2], async: m[1] === 'A' }));
  assert.ok(methods.length >= 19);
  assert.deepEqual(methods.map((m) => m.name).sort(), Object.keys(METHODS).sort());
  for (const m of methods) assert.equal(isAsyncMethod(m.name), m.async, m.name);
  const events = [...table.slice(table.indexOf('// Eventos:')).matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(events)].sort(), Object.keys(EVENTS).sort());
});

// ---------------------------------------------------------------------------
// Todos os métodos e eventos, em todos os mundos
// ---------------------------------------------------------------------------

for (const world of WORLDS) {
  test(`contrato: todos os métodos e eventos no mundo "${world}"`, async (t) => {
    const s = boot(t, { world });
    const { backend, clock, sim } = s;
    const sync = (method, args) => assertResult(method, backend.call(method, assertArgs(method, args ?? {})));
    const later = async (method, args, ms) => {
      const promise = backend.callAsync(method, assertArgs(method, args ?? {}));
      clock.advance(ms);
      return assertResult(method, await promise);
    };

    const info = sync('info');
    assert.deepEqual(
      { platform: info.platform, sdk: info.sdk, release: info.release, bands: info.bands, standards: info.standards, rtt: info.rtt, appVersion: info.appVersion },
      { platform: 'sim', sdk: 0, release: 'simulado', bands: { b24: true, b5: true, b6: true, b60: false }, standards: [4, 5, 6], rtt: true, appVersion: APP_VERSION },
    );
    assert.ok(info.manufacturer && info.model);
    assert.equal(sync('status').canScan, true);
    const cached = sync('lastScan');
    assert.ok(cached.aps.length >= 3, 'a lista em cache nunca começa vazia');
    const conn = sync('connection');
    assert.equal(conn.connected, true);
    sync('watchRssi', { intervalMs: 500 });

    assert.deepEqual(await later('scan', {}, 3000), { accepted: true });
    const own = sim.world.aps.filter((a) => a.own).map((a) => a.bssid);
    const other = sim.world.aps.find((a) => !a.own).bssid;
    const rtt = await later('rtt', { bssids: [...own.slice(0, 6), other, '02:11:22:33:44:55'] }, 2000);
    assert.equal(rtt.results.length, Math.min(6, own.length) + 2);
    const ping = await later('ping', { host: conn.gateway, count: 4, timeoutMs: 1000 }, 5000);
    assert.equal(ping.sent, 4);
    const lan = await later('lanScan', {}, 10000);
    assert.ok(lan.devices.length >= 5);
    const speed = await later('speedTest', { mode: 'light' }, 10000);
    assert.equal(speed.ok, true);
    assert.equal((await later('requestPermission', {}, 2000)).permission, 'granted');

    for (const which of SETTINGS_PANELS) assert.deepEqual(sync('openSettings', { which }), { ok: true });
    sync('keepAwake', { on: true });
    sync('vibrate', { ms: 20 });
    sync('setBars', { color: '#0a0f1c', dark: true });
    assertResult('share', await backend.call('share', assertArgs('share', { title: 'WiFi Raio-X', text: 'Minha rede' })));
    sync('saveFile', { name: 'redes.csv', mime: 'text/csv', text: 'ssid;sinal\nCasa;-57\n' });
    sync('saveFile', { name: 'mapa.bin', mime: 'application/octet-stream', base64: 'AAECAw==' });
    for (const op of CANCEL_OPS) sync('cancel', { op });
    assert.deepEqual(sim.device.bars, { color: '#0a0f1c', dark: true });
    assert.equal(sim.device.keepAwake, true);
    assert.equal(sim.device.vibrations, 1);
    assert.deepEqual(sim.device.lastShare, { title: 'WiFi Raio-X', text: 'Minha rede' });
    assert.deepEqual(sim.device.lastFile, { name: 'mapa.bin', mime: 'application/octet-stream', size: 4, base64: 'AAECAw==' });

    // Desliga e liga o Wi-Fi para os eventos 'status' e 'connection' também aparecerem.
    sim.setState({ wifi: false });
    assert.deepEqual(sync('connection'), { connected: false });
    assert.deepEqual(sync('lastScan').aps, []);
    sim.setState({ wifi: true });
    clock.advance(120000); // tempo para reconectar, varreduras do sistema, caminhada...
    sync('unwatchRssi');
    assert.equal(sync('connection').connected, true);

    for (const e of s.events) assertEvent(e.name, e.data);
    const seen = new Set(s.events.map((e) => e.name));
    for (const name of [...Object.keys(EVENTS), 'sim']) assert.ok(seen.has(name), `faltou o evento '${name}'`);
    assert.ok(s.of('scan').some((e) => e.source === 'system'), 'o Android também varre sozinho');
    for (const e of s.of('sim')) assert.equal(e.world, world);
    // Como no ScanMapper do Android: os dois campos booleanos vêm sempre.
    for (const ev of s.of('scan')) for (const ap of ev.aps) assert.ok(typeof ap.rttResponder === 'boolean' && ap.passpoint === false);
  });
}

test('erros iguais aos do lado nativo: método desconhecido, canal errado, argumentos inválidos', async (t) => {
  const { backend, clock } = boot(t);
  assert.throws(() => backend.call('explodir'), /^Error: método desconhecido: explodir$/);
  await assert.rejects(backend.callAsync('explodir'), /^Error: método desconhecido: explodir$/);
  // Método assíncrono pelo caminho de resposta imediata: erro. O contrário o Android atende.
  assert.throws(() => backend.call('scan'), /^Error: método assíncrono, use callAsync: scan$/);
  assertResult('info', await backend.callAsync('info'));
  assertResult('status', await backend.callAsync('status'));
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '', undefined, null, 7]) {
    assert.throws(() => backend.call(name), /método desconhecido/);
    await assert.rejects(backend.callAsync(name), /método desconhecido/);
  }

  // Sem argumentos vale {}; o que não é objeto é erro.
  assert.deepEqual(backend.call('watchRssi'), { ok: true });
  assert.deepEqual(backend.call('watchRssi', null), { ok: true });
  assert.throws(() => backend.call('watchRssi', 'x'), /^Error: argumentos inválidos$/);
  assert.throws(() => backend.call('watchRssi', [500]), /^Error: argumentos inválidos$/);
  await assert.rejects(backend.callAsync('scan', 7), /^Error: argumentos inválidos$/);

  // Cada método recusa o argumento errado dizendo qual.
  const refuse = (method, args, field) => assert.throws(() => backend.call(method, args), new RegExp(`^Error: argumentos inválidos: ${field}$`), `${method} ${JSON.stringify(args)}`);
  refuse('watchRssi', { intervalMs: '1000' }, 'intervalMs');
  refuse('openSettings', { which: 'bluetooth' }, 'which');
  refuse('openSettings', {}, 'which');
  refuse('keepAwake', { on: 1 }, 'on');
  refuse('keepAwake', {}, 'on');
  refuse('vibrate', { ms: 'muito' }, 'ms');
  refuse('setBars', { color: 'red', dark: true }, 'color');
  refuse('setBars', { dark: true }, 'color');
  refuse('share', { title: 'só título' }, 'text');
  refuse('saveFile', { name: '  ', mime: 'text/plain', text: 'x' }, 'name');
  refuse('saveFile', { name: 'a.txt', mime: 'text/plain' }, 'text ou base64');
  refuse('saveFile', { name: 'a.txt', mime: 'text/plain', text: 'x', base64: 'eA==' }, 'text ou base64');
  refuse('saveFile', { name: 'a.bin', mime: 'x/y', base64: '***' }, 'base64');
  refuse('cancel', { op: 'nada' }, 'op');
  refuse('cancel', {}, 'op');
  await assert.rejects(backend.callAsync('rtt', { bssids: 'aa:bb' }), /^Error: argumentos inválidos: bssids$/);
  await assert.rejects(backend.callAsync('rtt', {}), /^Error: argumentos inválidos: bssids$/);
  await assert.rejects(backend.callAsync('speedTest', { mode: 'turbo' }), /^Error: argumentos inválidos: mode$/);
  await assert.rejects(backend.callAsync('ping', { host: '', count: 3, timeoutMs: 1000 }), /^Error: host inválido$/);
  await assert.rejects(backend.callAsync('ping', {}), /^Error: host inválido$/);

  // O que tem valor padrão continua valendo.
  assert.deepEqual(backend.call('vibrate'), { ok: true });
  assert.deepEqual(backend.call('setBars', { color: '#abc' }), { ok: true });
  assert.deepEqual(backend.sim.device.bars, { color: '#abc', dark: false });
  assert.deepEqual(await backend.call('share', { text: 'só texto' }), { ok: false }, 'no Node não há como compartilhar nem copiar');
  assert.deepEqual(await backend.callAsync('rtt', { bssids: [] }), { results: [] });
  assert.deepEqual(await backend.callAsync('rtt', { bssids: [7, null, {}] }), { results: [] }, 'o que não é texto é ignorado');
  // Arquivo grande demais (mais de 20 MB) não é erro de argumento: só não vai.
  assert.deepEqual(backend.call('saveFile', { name: 'enorme.txt', mime: 'text/plain', text: 'x'.repeat(20 * 1024 * 1024 + 1) }), { ok: false });
  // O nome do arquivo é limpo como no Android (sem pastas nem símbolos estranhos).
  backend.call('saveFile', { name: '../../etc/re:des*de?casa.csv', mime: 'TEXT/CSV', text: 'a' });
  assert.deepEqual(backend.sim.device.lastFile, { name: 're_des_de_casa.csv', mime: 'text/csv', size: 1, text: 'a' });
  backend.call('saveFile', { name: '...', mime: 'tipo estranho', text: 'a' });
  assert.deepEqual([backend.sim.device.lastFile.name, backend.sim.device.lastFile.mime], ['arquivo', 'application/octet-stream']);

  assert.throws(() => createSimBackend({}), /emit/);
  clock.advance(1000);
});

// ---------------------------------------------------------------------------
// Varreduras
// ---------------------------------------------------------------------------

test('scan: aceita na hora, entrega em ~2,5 s e junta pedidos feitos durante a varredura', async (t) => {
  const s = boot(t, { walk: 'still' });
  const start = s.clock.now();
  assert.deepEqual(await s.backend.callAsync('scan'), { accepted: true });
  s.clock.advance(1000);
  assert.deepEqual(await s.backend.callAsync('scan'), { accepted: true }); // aproveita a que está no ar
  assert.equal(s.of('scan').length, 0);
  s.clock.advance(2000);
  const scans = s.events.filter((e) => e.name === 'scan');
  assert.equal(scans.length, 1);
  const took = scans[0].at - start;
  assert.ok(took >= 2400 && took <= 2800, `demorou ${took} ms`);
  const ev = scans[0].data;
  assert.equal(ev.ts, scans[0].at);
  assert.equal(ev.fresh, true);
  assert.equal(ev.source, 'request');
  // Lista nova: tudo foi ouvido durante esta varredura (ou é leitura antiga, com mais de 3 s).
  assert.ok(ev.aps.filter((a) => a.ageMs <= 3000).length >= 5);
  // A lista não vem em ordem de sinal nem com a rede da casa na frente.
  const levels = ev.aps.map((a) => a.level);
  assert.notDeepEqual(levels, [...levels].sort((a, b) => b - a));
  // Os campos saem na ordem em que o Android os escreve.
  assert.deepEqual(Object.keys(ev.aps[0]), ['bssid', 'ssid', 'level', 'frequency', 'channelWidth', 'centerFreq0', 'centerFreq1', 'capabilities', 'ageMs', 'rttResponder', 'passpoint', 'wifiStandard', 'ies']);
});

test('lastScan: devolve o cache, com as idades contando até agora', (t) => {
  const s = boot(t, { walk: 'still' });
  const a = assertResult('lastScan', s.backend.call('lastScan'));
  s.clock.advance(10000);
  const b = assertResult('lastScan', s.backend.call('lastScan'));
  assert.equal(b.ts - a.ts, 10000);
  assert.deepEqual(b.aps.map((x) => x.bssid), a.aps.map((x) => x.bssid));
  for (let i = 0; i < a.aps.length; i++) assert.equal(b.aps[i].ageMs - a.aps[i].ageMs, 10000);
  assert.equal(s.of('scan').length, 0, 'ler o cache não gera evento');
});

test('varreduras do sistema: chegam sozinhas a cada 30 a 60 s', (t) => {
  const s = boot(t, { world: 'kitnet' });
  s.clock.advance(10 * 60000);
  const scans = s.events.filter((e) => e.name === 'scan');
  assert.ok(scans.every((e) => e.data.source === 'system' && e.data.fresh));
  assert.ok(scans.length >= 10 && scans.length <= 20, `${scans.length} varreduras em 10 minutos`);
  for (let i = 1; i < scans.length; i++) {
    const gap = scans[i].at - scans[i - 1].at;
    assert.ok(gap >= 30000 && gap <= 60001, `intervalo de ${gap} ms`);
  }
  assert.ok(scans.every((e) => e.data.aps.every((a) => a.ageMs <= 3000)), 'com tanto tempo entre uma e outra, não sobra leitura antiga');
});

test('leituras antigas: rede que não foi ouvida desta vez continua na lista por alguns segundos', async (t) => {
  const s = boot(t, { world: 'kitnet' });
  for (let i = 0; i < 60; i++) {
    await s.backend.callAsync('scan');
    s.clock.advance(3000);
  }
  // Todas as listas novas, na ordem: as do sistema também renovam o que o Android guarda.
  const scans = s.events.filter((e) => e.name === 'scan');
  assert.equal(scans.filter((e) => e.data.source === 'request').length, 60);
  assert.ok(scans.every((e) => e.data.fresh));
  let repeated = 0;
  for (let i = 1; i < scans.length; i++) {
    const previous = new Map(scans[i - 1].data.aps.map((a) => [a.bssid, a]));
    const gap = scans[i].at - scans[i - 1].at;
    for (const ap of scans[i].data.aps) {
      if (ap.ageMs <= 3000) continue;
      // É a leitura da varredura anterior, igualzinha, só que mais velha.
      repeated++;
      const old = previous.get(ap.bssid);
      assert.ok(old, `${ap.bssid} apareceu velho sem ter sido ouvido antes`);
      assert.deepEqual({ ...ap, ageMs: 0 }, { ...old, ageMs: 0 });
      assert.ok(Math.abs(ap.ageMs - old.ageMs - gap) <= 1, `${ap.ageMs} x ${old.ageMs} + ${gap}`);
      assert.ok(ap.ageMs <= 21000, 'o Android esquece depois de uns 20 s');
    }
  }
  assert.ok(repeated >= 10, `só ${repeated} leituras repetidas em 60 varreduras de um prédio cheio`);
});

test('limite do Android: 4 varreduras a cada 2 minutos; a recusa não gasta a cota', async (t) => {
  const s = boot(t, { throttle: true, walk: 'still' });
  const { backend, clock } = s;
  const t0 = clock.now();
  assert.equal(backend.call('status').throttled, true);
  const fresh = () => s.of('scan').filter((e) => e.fresh && e.source === 'request');
  const stale = () => s.of('scan').filter((e) => !e.fresh);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(await backend.callAsync('scan'), { accepted: true }, `varredura ${i + 1}`);
    clock.advance(3000);
  }
  assert.equal(fresh().length, 4);
  assert.equal(stale().length, 0);

  // A quinta é recusada e chega o aviso do Android com a lista antiga, atribuído ao pedido.
  const before = backend.call('lastScan');
  assert.deepEqual(assertResult('scan', await backend.callAsync('scan')), { accepted: false, reason: 'throttled' });
  assert.equal(stale().length, 0, 'o aviso vem depois da resposta');
  clock.advance(200);
  assert.equal(stale().length, 1);
  const old = assertEvent('scan', stale()[0]);
  assert.deepEqual([old.fresh, old.source], [false, 'request']);
  assert.deepEqual(old.aps.map((a) => a.bssid), before.aps.map((a) => a.bssid));
  assert.ok(old.aps.every((a, i) => a.ageMs >= before.aps[i].ageMs));
  for (let i = 0; i < 5; i++) assert.equal((await backend.callAsync('scan')).accepted, false);
  clock.advance(200);
  assert.equal(stale().length, 6);
  assert.equal(fresh().length, 4);

  // Aceitas em t = 0, 3, 6 e 9 s. Em t = 121 s a primeira saiu da janela: cabe mais uma, e só uma.
  clock.advance(121000 - (clock.now() - t0));
  assert.equal(backend.sim.now(), 121);
  assert.deepEqual(await backend.callAsync('scan'), { accepted: true });
  assert.deepEqual(await backend.callAsync('scan'), { accepted: false, reason: 'throttled' });
  clock.advance(3000);
  assert.equal(fresh().length, 5);
  // Se as recusas gastassem a cota, esta (t ≈ 124 s, a de 3 s já saiu) também seria recusada.
  assert.deepEqual(await backend.callAsync('scan'), { accepted: true });

  // As varreduras do próprio Android continuam chegando e não contam.
  assert.ok(s.of('scan').some((e) => e.source === 'system'));
  for (const e of s.of('scan')) assertEvent('scan', e);

  // Limite desligado (opções de desenvolvedor): sem teto.
  backend.sim.setState({ throttle: false });
  assert.equal(backend.call('status').throttled, false);
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(await backend.callAsync('scan'), { accepted: true });
    clock.advance(3000);
  }
});

test('scan: recusa com o motivo do Android quando falta permissão, localização ou Wi-Fi', async (t) => {
  assert.deepEqual(Object.values(SCAN_REFUSAL).sort(), [...SCAN_REASONS].sort());
  const cases = [
    [{ wifi: false }, 'wifi-off'],
    [{ location: false }, 'location-off'],
    [{ permission: 'denied' }, 'no-permission'],
    [{ permission: 'blocked' }, 'no-permission'],
    [{ wifi: false, location: false }, 'location-off'],
    [{ wifi: false, location: false, permission: 'denied' }, 'no-permission'],
  ];
  for (const [options, reason] of cases) {
    const s = boot(t, options);
    assert.equal(s.backend.call('status').canScan, false);
    assert.deepEqual(assertResult('scan', await s.backend.callAsync('scan')), { accepted: false, reason });
    assert.deepEqual(assertResult('lastScan', s.backend.call('lastScan')).aps, [], 'sem poder varrer, o Android entrega a lista vazia');
    s.clock.advance(3 * 60000);
    const scans = s.of('scan');
    for (const ev of scans) assertEvent('scan', ev);
    if (options.wifi === false) {
      assert.equal(scans.length, 0, 'Wi-Fi desligado: ninguém varre');
    } else {
      // O Android continua varrendo sozinho e avisando; o app, sem permissão, lê uma lista vazia.
      assert.ok(scans.length >= 2);
      assert.ok(scans.every((ev) => ev.source === 'system' && ev.aps.length === 0));
    }
  }
});

// ---------------------------------------------------------------------------
// Estado: Wi-Fi, localização, permissão
// ---------------------------------------------------------------------------

test('status: cada mudança emite um evento; ligar e desligar o Wi-Fi mexe na conexão', (t) => {
  const s = boot(t, { walk: 'still' });
  const { backend, clock, sim } = s;
  s.clear();
  assert.deepEqual(sim.setState({ wifi: true, location: true }), backend.call('status'));
  assert.equal(s.events.filter((e) => e.name !== 'sim').length, 0, 'sem mudança, sem evento');

  sim.setState({ wifi: false });
  assert.deepEqual(s.events.map((e) => e.name), ['status', 'connection']);
  assert.deepEqual(s.events[0].data, { wifiEnabled: false, locationEnabled: true, permission: 'granted', throttled: false, canScan: false });
  assert.deepEqual(s.events[1].data, { connected: false });
  assert.deepEqual(backend.call('connection'), { connected: false });
  assert.deepEqual(sim.state(), { wifi: false, location: true, permission: 'granted', throttle: false, permissionReply: 'granted' });

  s.clear();
  sim.setState({ wifi: true });
  assert.deepEqual(s.events.map((e) => e.name), ['status']);
  assert.equal(s.events[0].data.canScan, true);
  assert.deepEqual(backend.call('connection'), { connected: false }, 'leva um instante para reconectar');
  clock.advance(3000);
  const names = s.events.filter((e) => e.name !== 'sim').map((e) => e.name);
  assert.deepEqual(names, ['status', 'connection', 'scan']);
  assert.equal(assertEvent('connection', s.of('connection')[0]).connected, true);
  assert.equal(s.of('scan')[0].source, 'system');

  s.clear();
  sim.setState({ location: false });
  sim.setState({ location: false });
  sim.setState({ throttle: true });
  sim.setState({ permission: 'blocked' });
  sim.setState({ permission: 'nada' }); // valor inválido: ignora
  sim.setState(null);
  const st = s.of('status');
  assert.equal(st.length, 3);
  assert.deepEqual(st[2], { wifiEnabled: true, locationEnabled: false, permission: 'blocked', throttled: true, canScan: false });
  for (const e of st) assertEvent('status', e);
});

test('requestPermission: concede, nega, bloqueia na segunda recusa; o estado é reenviado a cada pedido', async (t) => {
  const s = boot(t, { permission: 'denied' });
  const { backend, clock, sim } = s;
  const ask = async (ms = 2000) => {
    const p = backend.callAsync('requestPermission');
    clock.advance(ms);
    return assertResult('requestPermission', await p);
  };
  const lastStatus = () => s.of('status').at(-1);
  assert.equal(backend.call('status').permission, 'denied');

  // Usuário nega: continua 'denied'; nega de novo: o Android para de perguntar.
  // Depois de cada pedido o Android reenvia o estado, mesmo igual ao anterior.
  sim.setState({ permissionReply: 'denied' });
  assert.equal((await ask()).permission, 'denied');
  assert.equal(s.of('status').length, 1);
  assert.equal(lastStatus().permission, 'denied');
  assert.equal((await ask()).permission, 'blocked');
  assert.equal(s.of('status').length, 2);
  assert.equal(lastStatus().permission, 'blocked');

  // Bloqueada: responde na hora, sem janela, e continua bloqueada mesmo que o usuário quisesse aceitar.
  sim.setState({ permissionReply: 'granted' });
  assert.equal((await ask(100)).permission, 'blocked');
  assert.equal(s.of('status').length, 3);

  // Só as configurações do app resolvem.
  assert.deepEqual(backend.call('openSettings', { which: 'app' }), { ok: true });
  assert.equal(backend.call('status').permission, 'blocked', 'o efeito vem depois de um instante');
  clock.advance(2000);
  assert.equal(s.of('status').length, 4);
  assert.deepEqual(lastStatus(), { wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: false, canScan: true });

  // Já concedida: responde sem esperar (e também reenvia o estado).
  assert.equal((await backend.callAsync('requestPermission')).canScan, true);
  clock.advance(10);
  assert.equal(s.of('status').length, 5);
  for (const e of s.of('status')) assertEvent('status', e);

  // Por padrão o pedido é aceito (o botão "Permitir" da tela de bloqueio funciona de ponta a ponta).
  const other = boot(t, { permission: 'denied' });
  const p = other.backend.callAsync('requestPermission');
  other.clock.advance(500);
  assert.equal(other.backend.call('status').permission, 'denied', 'a janela do Android leva um tempo');
  other.clock.advance(1000);
  assert.equal((await p).permission, 'granted');
  assert.deepEqual(other.of('status').map((e) => e.canScan), [true]);
});

test('openSettings: no simulador, cada painel resolve o seu bloqueio depois de um instante', (t) => {
  const s = boot(t, { wifi: false, location: false, permission: 'blocked', throttle: true });
  const { backend, clock } = s;
  const status = () => backend.call('status');
  assert.equal(status().canScan, false);
  for (const [which, check] of [
    ['app', (st) => st.permission === 'granted'],
    ['location', (st) => st.locationEnabled],
    ['panel', (st) => st.wifiEnabled && st.canScan],
    ['developer', (st) => st.throttled === false],
  ]) {
    assert.equal(check(status()), false, which);
    assert.deepEqual(backend.call('openSettings', { which }), { ok: true });
    clock.advance(1500);
    assert.equal(check(status()), true, which);
  }
  assert.equal(s.of('status').length, 4);
  clock.advance(3000);
  assert.equal(backend.call('connection').connected, true);
  // Voltar das configurações sem ter mudado nada também reenvia o estado (como o onResume do Android).
  backend.call('openSettings', { which: 'developer' });
  clock.advance(1500);
  assert.equal(s.of('status').length, 5);
  assert.deepEqual(s.of('status')[4], s.of('status')[3]);

  const w = boot(t, { wifi: false });
  w.backend.call('openSettings', { which: 'wifi' });
  w.clock.advance(1500);
  assert.equal(w.backend.call('status').wifiEnabled, true);
});

// ---------------------------------------------------------------------------
// Conexão, roaming e sinal
// ---------------------------------------------------------------------------

test('connection: rede da casa, endereços coerentes e velocidade derivada do sinal', (t) => {
  for (const world of PRESETS) {
    const s = boot(t, { world, walk: 'still' });
    const c = assertResult('connection', s.backend.call('connection'));
    const link = s.sim.link();
    assert.equal(link.own, true);
    assert.equal(c.bssid, link.bssid);
    assert.equal(c.ssid, link.ssid);
    assert.equal(c.frequency, link.freq);
    assert.ok(!/visitante/i.test(c.ssid), 'o celular fica na rede principal, não na de visitantes');
    assert.ok(c.rssi <= -25 && c.rssi >= -92, `rssi ${c.rssi}`);
    assert.equal(c.linkSpeed, c.txSpeed);
    assert.ok(c.txSpeed > 0 && c.txSpeed <= c.rxSpeed && c.rxSpeed <= c.maxRxSpeed);
    assert.equal(c.maxTxSpeed, c.maxRxSpeed);
    assert.equal(c.wifiStandard, Math.min(6, link.standard));
    assert.equal(c.prefix, 24);
    assert.equal(c.ip.split('.').slice(0, 3).join('.'), c.gateway.split('.').slice(0, 3).join('.'));
    assert.notEqual(c.ip, c.gateway);
    assert.ok(c.dns.length >= 1 && c.ipv6.length >= 1 && c.ipv6[0].startsWith('fe80::'));
    assert.equal(c.iface, 'wlan0');
    assert.equal(c.validated, true);
    assert.equal(c.hidden, false);
    assert.ok(c.leaseSec >= 600);
    // Mesmos campos, na mesma ordem, do ConnectionMapper do Android.
    assert.deepEqual(Object.keys(c), ['connected', 'ssid', 'bssid', 'hidden', 'rssi', 'frequency', 'linkSpeed', 'txSpeed', 'rxSpeed', 'maxTxSpeed', 'maxRxSpeed', 'wifiStandard', 'securityType', 'ip', 'prefix', 'ipv6', 'dns', 'iface', 'mtu', 'gateway', 'leaseSec', 'validated', 'metered']);
  }
  // Tipo de segurança conforme a rede: WPA2 pessoal, WPA3 (transição) e empresarial.
  const type = (world) => boot(t, { world }).backend.call('connection').securityType;
  assert.equal(type('apartamento'), 2);
  assert.equal(type('sobrado'), 4);
  assert.equal(type('escritorio'), 3);
});

test('connection: sinal fraco negocia velocidade menor', (t) => {
  const speeds = (drop) => {
    const s = boot(t, { world: weakKitnet(drop), walk: 'still' });
    s.clock.advance(5000);
    return assertResult('connection', s.backend.call('connection'));
  };
  const strong = speeds(0);
  const weak = speeds(28);
  assert.ok(weak.rssi < strong.rssi - 10, `${weak.rssi} x ${strong.rssi}`);
  assert.ok(weak.rxSpeed < strong.rxSpeed, `${weak.rxSpeed} x ${strong.rxSpeed}`);
});

test('connection: sem permissão ou sem localização o Android esconde o nome e o BSSID', (t) => {
  for (const options of [{ permission: 'denied' }, { location: false }]) {
    const s = boot(t, options);
    const c = assertResult('connection', s.backend.call('connection'));
    assert.equal(c.connected, true);
    assert.equal('ssid' in c || 'bssid' in c, false);
    assert.ok(c.rssi < 0 && c.frequency > 2000 && c.ip && c.hidden === false);
    s.backend.call('watchRssi', { intervalMs: 1000 });
    s.clock.advance(3000);
    const samples = s.of('rssi');
    assert.ok(samples.length >= 3);
    for (const r of samples) assert.equal(assertEvent('rssi', r).bssid, '', 'o Android manda "" quando esconde o BSSID');
    // Com tudo liberado o nome volta (a interface relê a conexão ao receber o 'status').
    s.sim.setState({ permission: 'granted', location: true });
    assert.ok(s.backend.call('connection').ssid);
  }
});

test("roaming: andar entre os pontos da rede mesh troca de rádio e emite 'connection'", (t) => {
  const s = boot(t, { world: 'sobrado' });
  const { backend, clock, sim } = s;
  const first = backend.call('connection');
  clock.advance(12 * 60000);
  const roams = s.of('connection');
  assert.ok(roams.length >= 2, `só ${roams.length} trocas em 12 minutos de caminhada pelos dois andares`);
  let previous = first.bssid;
  const devices = new Set([sim.world.ap(first.bssid).device]);
  for (const c of roams) {
    assertEvent('connection', c);
    assert.equal(c.connected, true);
    assert.equal(c.ssid, first.ssid, 'mesh: o nome da rede não muda');
    assert.notEqual(c.bssid, previous, 'cada evento é uma troca de verdade');
    assert.equal(sim.world.ap(c.bssid).own, true);
    devices.add(sim.world.ap(c.bssid).device);
    previous = c.bssid;
  }
  assert.deepEqual([...devices].sort(), ['mesh-cima', 'roteador']);
  assert.equal(backend.call('connection').bssid, previous);

  // Subir a escada leva ao ponto de cima; descer devolve ao roteador.
  const m = boot(t, { world: 'sobrado', walk: 'still' });
  assert.equal(m.sim.link().device, 'roteador');
  assert.equal(m.sim.walker.setFloor(1), true);
  m.clock.advance(60000);
  assert.equal(m.sim.truth().floor, 1);
  assert.equal(m.sim.link().device, 'mesh-cima');
  assert.equal(m.sim.walker.goTo(2, 8, 0), true); // desce e vai até o escritório, longe do ponto de cima
  m.clock.advance(90000);
  assert.equal(m.sim.truth().floor, 0);
  assert.equal(m.sim.link().device, 'roteador');
  // Pelo menos uma troca na subida e outra na descida (na escada pode haver mais uma, de faixa).
  const hops = m.of('connection').map((c) => assertEvent('connection', c).bssid);
  assert.ok(hops.length >= 2 && hops.length <= 4, hops.join(' '));
  assert.equal(m.sim.world.ap(hops.at(-1)).device, 'roteador');
});

test("watchRssi: emite 'rssi' no intervalo pedido (em tempo simulado) até unwatchRssi", (t) => {
  const s = boot(t, { walk: 'still' });
  const { backend, clock } = s;
  backend.call('watchRssi', { intervalMs: 500 });
  assert.equal(s.of('rssi').length, 0);
  clock.advance(1);
  assert.equal(s.of('rssi').length, 1, 'a primeira amostra sai logo');
  clock.advance(9998);
  const samples = s.events.filter((e) => e.name === 'rssi');
  assert.equal(samples.length, 20);
  const link = backend.call('connection');
  for (let i = 0; i < samples.length; i++) {
    const r = assertEvent('rssi', samples[i].data);
    assert.equal(r.ts, samples[i].at);
    assert.equal(r.bssid, link.bssid);
    assert.equal(r.frequency, link.frequency);
    assert.ok(r.linkSpeed > 0 && r.txSpeed === r.linkSpeed && r.rxSpeed >= r.txSpeed);
    if (i > 0) assert.equal(samples[i].at - samples[i - 1].at, 500);
  }
  // Parado, o sinal oscila pouco (é ruído de medição, não passeio).
  const values = samples.map((e) => e.data.rssi);
  assert.ok(Math.abs(median(values) - link.rssi) <= 8);

  // Trocar o intervalo substitui o anterior; o Android não aceita menos de 250 ms.
  s.clear();
  backend.call('watchRssi', { intervalMs: 2000 });
  clock.advance(9999);
  assert.equal(s.of('rssi').length, 5);
  s.clear();
  backend.call('watchRssi', { intervalMs: 10 });
  clock.advance(999);
  assert.equal(s.of('rssi').length, 4);

  // Wi-Fi desligado não gera amostra; volta sozinho quando reconecta.
  backend.sim.setState({ wifi: false });
  s.clear();
  clock.advance(10000);
  assert.equal(s.of('rssi').length, 0);
  backend.sim.setState({ wifi: true });
  clock.advance(10000);
  assert.ok(s.of('rssi').length >= 20);
  assert.deepEqual(backend.call('unwatchRssi'), { ok: true });
  s.clear();
  clock.advance(10000);
  assert.equal(s.of('rssi').length, 0);
});

// ---------------------------------------------------------------------------
// RTT, ping, rede local e teste de velocidade
// ---------------------------------------------------------------------------

test('rtt: quem responde dá a distância verdadeira com erro de ~0,5 a 1 m; os outros, ok = false', async (t) => {
  const s = boot(t, { world: 'sobrado', walk: 'still' });
  const { backend, clock, sim } = s;
  const own = sim.world.aps.filter((a) => a.own).map((a) => a.bssid);
  const neighbour = sim.world.aps.find((a) => !a.own).bssid;
  const errors = [];
  for (const room of sim.world.rooms) {
    for (let i = 0; i < 4; i++) {
      sim.walker.teleport(room.centroid.x + 0.3 * i, room.centroid.y - 0.2 * i, room.floor);
      await backend.callAsync('scan'); // só é medido quem está na última varredura
      clock.advance(3000);
      const truth = sim.truth();
      const p = backend.callAsync('rtt', { bssids: [...own.map((b) => b.toUpperCase()), ...own, neighbour, '02:11:22:33:44:55'] });
      clock.advance(2000);
      const { results } = assertResult('rtt', await p);
      assert.deepEqual(results.map((r) => r.bssid), [...own, neighbour, '02:11:22:33:44:55'], 'uma resposta por BSSID, na ordem do pedido, em minúsculas');
      assert.deepEqual(results.slice(-2), [{ bssid: neighbour, ok: false }, { bssid: '02:11:22:33:44:55', ok: false }]);
      for (const r of results.filter((x) => x.ok)) {
        const ap = sim.world.ap(r.bssid);
        errors.push(Math.abs(r.distM - Math.hypot(ap.x - truth.x, ap.y - truth.y, ap.z - truth.z)));
        assert.ok(r.stdM > 0 && r.stdM < 1.5);
        assert.ok(r.attempts === 8 && r.successes >= 6 && r.successes <= 8);
        assert.ok(Math.abs(r.distM * 1000 - Math.round(r.distM * 1000)) < 1e-6, 'a distância vem em milímetros inteiros');
      }
    }
  }
  assert.ok(errors.length >= 80, `${errors.length} medições boas`);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  assert.ok(mean > 0.3 && mean < 0.9, `erro médio de ${mean.toFixed(2)} m`);
  assert.ok(Math.max(...errors) < 4);

  // Roteador de operadora não sabe 802.11mc; e os anúncios batem com isso.
  const a = boot(t, { world: 'apartamento' });
  const ids = a.sim.world.aps.filter((x) => x.own).map((x) => x.bssid);
  assert.ok((await a.backend.callAsync('rtt', { bssids: ids })).results.every((r) => !r.ok));
  assert.ok(a.backend.call('lastScan').aps.every((x) => x.rttResponder === false));
  assert.ok(s.backend.call('lastScan').aps.filter((x) => own.includes(x.bssid)).every((x) => x.rttResponder === true));

  // Sem poder varrer não há quem medir: todos saem com ok = false (não é erro).
  s.sim.setState({ location: false });
  assert.deepEqual(await s.backend.callAsync('rtt', { bssids: own }), { results: own.map((bssid) => ({ bssid, ok: false })) });

  // O Android mede no máximo 10 roteadores por pedido; os demais voltam com ok = false.
  const office = boot(t, { world: 'escritorio', walk: 'still' });
  const all = office.sim.world.aps.filter((x) => x.own).map((x) => x.bssid);
  assert.equal(all.length, 20);
  const p = office.backend.callAsync('rtt', { bssids: all });
  office.clock.advance(2000);
  const many = assertResult('rtt', await p).results;
  assert.equal(many.length, 20);
  const okCount = many.filter((r) => r.ok).length;
  assert.ok(okCount >= 5 && okCount <= 10, `${okCount} medidos`);
});

test("ping: 'ping' a cada resposta, um pacote a cada 0,2 s; roteador em 2 a 8 ms, internet em 15 a 45 ms", async (t) => {
  const s = boot(t, { walk: 'still' });
  const { backend, clock } = s;
  const gateway = backend.call('connection').gateway;
  const run = async (host, count = 20, timeoutMs = 1000) => {
    s.clear();
    const p = backend.callAsync('ping', { host, count, timeoutMs });
    clock.advance(count * 200 + 6000);
    const summary = assertResult('ping', await p);
    const replies = s.of('ping');
    for (const r of replies) assertEvent('ping', r);
    assert.equal(replies.length, count, 'um evento por pacote');
    assert.deepEqual(replies.map((r) => r.seq).sort((a, b) => a - b), Array.from({ length: count }, (_, i) => i + 1));
    assert.ok(replies.every((r) => r.host === host));
    assert.equal(summary.host, host);
    assert.equal(summary.method, 'icmp');
    assert.equal(summary.sent, count);
    assert.equal(summary.received, replies.filter((r) => r.ok).length);
    return { summary, times: replies.filter((r) => r.ok).map((r) => r.ms), replies };
  };

  const gw = await run(gateway);
  assert.ok(gw.summary.received >= 19);
  assert.ok(median(gw.times) >= 2 && median(gw.times) <= 8, `mediana ${median(gw.times)} ms`);
  assert.ok(gw.summary.min >= 2 && gw.summary.jitter > 0);
  assert.equal(gw.summary.min, Math.min(...gw.times));
  assert.equal(gw.summary.max, Math.max(...gw.times));
  const mean = gw.times.reduce((a, b) => a + b, 0) / gw.times.length;
  assert.ok(Math.abs(gw.summary.avg - mean) < 0.001);

  for (const host of ['8.8.8.8', '1.1.1.1', 'www.google.com', 'registro.br', '2001:4860:4860::8888']) {
    const pub = await run(host, 10);
    assert.ok(median(pub.times) >= 15 && median(pub.times) <= 50, `${host}: mediana ${median(pub.times)} ms`);
  }
  assert.ok((await run('127.0.0.1', 3)).summary.max < 1);
  assert.ok((await run('localhost', 3)).summary.max < 1);

  // Endereço da rede local sem ninguém: todas se perdem. Os pacotes sem resposta só são
  // avisados no fim (como o ping do Android), e o resumo não inventa estatística.
  s.clear();
  const lost = backend.callAsync('ping', { host: '10.123.45.67', count: 4, timeoutMs: 300 });
  clock.advance(1500);
  assert.equal(s.of('ping').length, 0, 'enquanto espera, nenhum aviso');
  clock.advance(1000);
  assert.deepEqual(await lost, { host: '10.123.45.67', method: 'icmp', sent: 4, received: 0, lossPct: 100 });
  assert.deepEqual(s.of('ping'), [1, 2, 3, 4].map((seq) => ({ host: '10.123.45.67', seq, ok: false })));

  // Um pacote a cada 0,2 s, com a resposta avisada na hora em que chega.
  s.clear();
  const p = backend.callAsync('ping', { host: gateway, count: 5, timeoutMs: 1000 });
  clock.advance(500);
  assert.deepEqual(s.of('ping').map((r) => r.seq), [1, 2, 3]);
  clock.advance(2000);
  await p;

  // Limites do Android: no máximo 50 pacotes; espera de 0,2 a 5 s.
  const big = backend.callAsync('ping', { host: gateway, count: 500, timeoutMs: 1 });
  clock.advance(20000);
  assert.equal((await big).sent, 50);

  // Destino que não é IP nem nome: erro na hora. Nome que o DNS não acha: "host não encontrado".
  for (const host of ['', 'dois nomes', '-c 5', 'a..b', '1.2.3', 'x'.repeat(300), 7, null]) {
    await assert.rejects(backend.callAsync('ping', { host, count: 3, timeoutMs: 1000 }), /^Error: host inválido$/, String(host));
  }
  for (const host of ['nao-existe.invalid', 'semponto', 'impressora.local']) {
    await assert.rejects(backend.callAsync('ping', { host, count: 3, timeoutMs: 1000 }), /^Error: host não encontrado$/, host);
  }

  // Sem Wi-Fi: um IP simplesmente não responde; um nome nem resolve.
  backend.sim.setState({ wifi: false });
  const off = backend.callAsync('ping', { host: gateway, count: 3, timeoutMs: 1000 });
  clock.advance(5000);
  assert.deepEqual(await off, { host: gateway, method: 'icmp', sent: 3, received: 0, lossPct: 100 });
  await assert.rejects(backend.callAsync('ping', { host: 'www.google.com', count: 3, timeoutMs: 1000 }), /^Error: host não encontrado$/);
});

test('ping: cancel encerra na hora e devolve o resumo do que já foi medido', async (t) => {
  const s = boot(t, { walk: 'still' });
  const { backend, clock } = s;
  const p = backend.callAsync('ping', { host: '8.8.8.8', count: 50, timeoutMs: 1000 });
  clock.advance(1500);
  const seen = s.of('ping').length;
  assert.ok(seen >= 7 && seen <= 8, `${seen} respostas em 1,5 s`);
  assert.deepEqual(backend.call('cancel', { op: 'ping' }), { ok: true });
  const summary = assertResult('ping', await p);
  assert.equal(summary.sent, seen);
  assert.equal(summary.received, seen);
  clock.advance(20000);
  assert.equal(s.of('ping').length, seen, 'nada mais chega depois de cancelar');
  assert.deepEqual(backend.call('cancel', { op: 'ping' }), { ok: true }, 'cancelar sem nada rodando não é erro');

  // Um ping novo encerra o anterior.
  const a = backend.callAsync('ping', { host: '8.8.8.8', count: 50, timeoutMs: 1000 });
  clock.advance(1000);
  const b = backend.callAsync('ping', { host: '1.1.1.1', count: 2, timeoutMs: 1000 });
  assert.ok((await a).sent < 50);
  clock.advance(3000);
  assert.equal((await b).sent, 2);
  assert.equal(backend.sim.stats().ops, 0);
});

test('ping: sinal fraco traz atraso, oscilação e perda', async (t) => {
  const run = async (drop) => {
    const s = boot(t, { world: weakKitnet(drop), walk: 'still' });
    const gateway = s.backend.call('connection').gateway;
    const all = { sent: 0, received: 0, sum: 0, jitter: 0, max: 0 };
    for (let i = 0; i < 4; i++) {
      const p = s.backend.callAsync('ping', { host: gateway, count: 50, timeoutMs: 1000 });
      s.clock.advance(20000);
      const r = assertResult('ping', await p);
      all.sent += r.sent;
      all.received += r.received;
      all.sum += r.avg * r.received;
      all.jitter += r.jitter / 4;
      all.max = Math.max(all.max, r.max);
    }
    for (const r of s.of('ping')) assertEvent('ping', r);
    return { lossPct: (100 * (all.sent - all.received)) / all.sent, avg: all.sum / all.received, jitter: all.jitter, max: all.max };
  };
  const good = await run(0);
  const poor = await run(32);
  assert.ok(good.lossPct <= 2 && good.avg < 8, JSON.stringify(good));
  assert.ok(poor.lossPct >= 8, JSON.stringify(poor));
  assert.ok(poor.avg > 2 * good.avg && poor.jitter > 2 * good.jitter && poor.max > 30, JSON.stringify(poor));
});

test("lanScan: 'lan' a cada aparelho, 'lanProgress' até o fim, uma casa plausível", async (t) => {
  for (const world of PRESETS) {
    const s = boot(t, { world, walk: 'still' });
    const { backend, clock } = s;
    const conn = backend.call('connection');
    const p = backend.callAsync('lanScan');
    clock.advance(10000);
    const { devices } = assertResult('lanScan', await p);
    const found = s.of('lan');
    const progress = s.of('lanProgress');
    for (const d of found) assertEvent('lan', d);
    for (const g of progress) assertEvent('lanProgress', g);
    const byIp = (a, b) => a.ip.localeCompare(b.ip);
    assert.deepEqual([...found].sort(byIp), [...devices].sort(byIp), 'cada aparelho do resultado foi anunciado uma vez');
    assert.deepEqual(progress[0], { done: 0, total: 254 });
    assert.deepEqual(progress.at(-1), { done: 254, total: 254 });
    assert.ok(progress.length >= 5);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i].done > progress[i - 1].done);
    assert.equal(s.events.filter((e) => e.name === 'lan' || e.name === 'lanProgress')[0].name, 'lanProgress', 'o total chega antes do primeiro aparelho');

    const self = devices.filter((d) => d.self);
    const gw = devices.filter((d) => d.gateway);
    assert.equal(self.length, 1);
    assert.equal(self[0].ip, conn.ip);
    assert.equal(self[0].ms, undefined, 'este celular não tem tempo de resposta');
    assert.equal(gw.length, 1);
    assert.equal(gw[0].ip, conn.gateway);
    const base = conn.gateway.split('.').slice(0, 3).join('.');
    assert.ok(devices.every((d) => d.ip.startsWith(`${base}.`) && d.mac === undefined && (d.self || d.ms >= 0)));
    const lastOctets = devices.map((d) => Number(d.ip.split('.')[3]));
    assert.deepEqual(lastOctets, [...lastOctets].sort((a, b) => a - b), 'resultado em ordem de endereço');
    assert.ok(devices.some((d) => d.host === undefined), 'alguns aparelhos não dizem o nome');
    assert.ok(devices.filter((d) => d.host).length >= 4);
    assert.ok(devices.length >= 7 && devices.length <= 25, `${devices.length} aparelhos`);
    assert.ok(devices.some((d) => d.host === HOSTILE_TEXT.lanHost) && devices.some((d) => d.host === HOSTILE_TEXT.lanLong));
    // Dá para pingar o que a busca achou.
    const q = backend.callAsync('ping', { host: devices.find((d) => !d.self && !d.gateway).ip, count: 2, timeoutMs: 1000 });
    clock.advance(5000);
    assert.equal((await q).received, 2);
  }
  const home = boot(t, { world: 'apartamento', hostile: false, walk: 'still' });
  const p = home.backend.callAsync('lanScan');
  home.clock.advance(10000);
  const hosts = (await p).devices.map((d) => d.host).filter(Boolean);
  assert.ok(hosts.some((h) => /TV/.test(h)) && hosts.some((h) => /notebook/i.test(h)) && hosts.some((h) => /EPSON|Impressora/i.test(h)));
  assert.ok(hosts.some((h) => /Echo|Chromecast/.test(h)) && hosts.filter((h) => /Galaxy|iPhone/.test(h)).length >= 2);
  assert.ok(!hosts.some((h) => /[<>]/.test(h)), 'sem os nomes hostis quando hostile = false');
});

test('lanScan: cancel devolve o que já foi achado; fora do Wi-Fi a lista vem vazia', async (t) => {
  const s = boot(t, { walk: 'still' });
  const { backend, clock } = s;
  const p = backend.callAsync('lanScan');
  clock.advance(2500);
  const seen = s.of('lan').length;
  const progress = s.of('lanProgress').length;
  assert.ok(seen >= 1 && s.of('lanProgress').at(-1).done < 254);
  assert.deepEqual(backend.call('cancel', { op: 'lan' }), { ok: true });
  const partial = assertResult('lanScan', await p);
  assert.equal(partial.devices.length, seen);
  clock.advance(20000);
  assert.equal(s.of('lan').length, seen);
  assert.equal(s.of('lanProgress').length, progress, 'cancelada, a busca não chega aos 100%');

  // Uma busca nova encerra a anterior.
  const a = backend.callAsync('lanScan');
  clock.advance(1500);
  const b = backend.callAsync('lanScan');
  const first = await a;
  clock.advance(10000);
  assert.ok(first.devices.length < (await b).devices.length);

  // Cancelar de dentro de um ouvinte (o usuário aperta "parar" ao ver um aparelho) também vale.
  const clock2 = createManualClock();
  let count = 0;
  let be = null;
  be = createSimBackend({
    clock: clock2,
    emit: (name) => {
      if (name === 'lan' && ++count === 3) be.call('cancel', { op: 'lan' });
    },
  });
  t.after(() => be.dispose());
  const q = be.callAsync('lanScan');
  clock2.advance(20000);
  assert.equal((await q).devices.length, 3);
  assert.equal(count, 3);

  // Fora do Wi-Fi não há o que varrer: total 0 e lista vazia (não é erro).
  backend.sim.setState({ wifi: false });
  s.clear();
  const off = backend.callAsync('lanScan');
  clock.advance(1000);
  assert.deepEqual(await off, { devices: [] });
  assert.deepEqual(s.of('lanProgress'), [{ done: 0, total: 0 }]);
  assert.equal(s.of('lan').length, 0);
});

test("speedTest: latência, download e upload com 'speed' várias vezes por segundo; o plano é o teto", async (t) => {
  const s = boot(t, { world: 'apartamento', walk: 'still' });
  const { backend, clock, sim } = s;
  assert.equal(backend.call('connection').frequency > 5000, true, 'perto do roteador, em 5 GHz');
  const started = clock.now();
  const p = backend.callAsync('speedTest', { mode: 'full' });
  clock.advance(30000);
  const result = assertResult('speedTest', await p);
  const events = s.events.filter((e) => e.name === 'speed');
  for (const e of events) assertEvent('speed', e.data);

  // Fases em ordem, progresso sempre crescendo até 1, bytes sempre crescendo.
  assert.deepEqual([...new Set(events.map((e) => e.data.phase))], ['latency', 'download', 'upload']);
  for (const phase of ['latency', 'download', 'upload']) {
    const list = events.filter((e) => e.data.phase === phase);
    assert.equal(list.at(-1).data.progress, 1, phase);
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i].data.progress > list[i - 1].data.progress, phase);
      assert.ok(list[i].data.bytes >= list[i - 1].data.bytes, phase);
      assert.equal(list[i].at - list[i - 1].at, 200, 'cinco avisos por segundo');
    }
    if (phase !== 'latency') {
      assert.equal(list.length, 40, '8 s por direção');
      assert.ok(list[0].data.mbps < 0.8 * list.at(-1).data.mbps, 'começa devagar e acelera');
    }
  }
  const took = events.at(-1).at - started;
  assert.ok(took >= 17000 && took <= 18500, `o teste completo levou ${took} ms`);

  // Com sinal bom quem limita é o plano da casa (300/150 Mb/s neste mundo).
  assert.deepEqual([sim.network.downMbps, sim.network.upMbps], [300, 150]);
  assert.ok(result.downMbps > 240 && result.downMbps <= 300, `download ${result.downMbps}`);
  assert.ok(result.upMbps > 120 && result.upMbps <= 150, `upload ${result.upMbps}`);
  assert.ok(result.latencyMs >= 5 && result.latencyMs <= 30 && result.jitterMs >= 0 && result.jitterMs < 10);
  assert.equal(result.server, 'GRU');
  assert.equal(result.bytesDown, events.filter((e) => e.data.phase === 'download').at(-1).data.bytes);
  assert.equal(result.bytesUp, events.filter((e) => e.data.phase === 'upload').at(-1).data.bytes);
  // Os bytes contados batem com a velocidade medida (8 s a ~280 Mb/s ≈ 280 MB).
  assert.ok(Math.abs(result.bytesDown / (result.downMbps * 125000 * 8) - 1) < 0.12);

  // Modo leve: bem mais curto e gasta poucos dados.
  s.clear();
  const startedLight = clock.now();
  const q = backend.callAsync('speedTest', { mode: 'light' });
  clock.advance(10000);
  const light = assertResult('speedTest', await q);
  assert.ok(light.ok && light.bytesDown < 40e6 && light.bytesUp < 20e6, JSON.stringify(light));
  assert.ok(light.bytesDown < result.bytesDown / 5);
  assert.ok(s.events.filter((e) => e.name === 'speed').at(-1).at - startedLight < 8000);
  assert.ok(light.downMbps > 0.7 * result.downMbps, 'mesmo curto, chega perto da velocidade real');
  for (const e of s.of('speed')) assertEvent('speed', e);
});

test('speedTest: quando o Wi-Fi é o gargalo o resultado cai; fora do ar e cancelado respondem ok = false', async (t) => {
  // Roteador fraco: o celular fica em 2,4 GHz com sinal ruim e o Wi-Fi passa menos do que o plano.
  const weak = boot(t, { world: weakKitnet(28), walk: 'still' });
  const p = weak.backend.callAsync('speedTest', { mode: 'full' });
  weak.clock.advance(30000);
  const slow = assertResult('speedTest', await p);
  assert.ok(slow.ok && slow.downMbps < 0.5 * weak.sim.network.downMbps, `${slow.downMbps} de ${weak.sim.network.downMbps}`);
  assert.ok(slow.downMbps > 1);

  const s = boot(t, { walk: 'still' });
  const { backend, clock } = s;
  // Cancelado no meio do download.
  const a = backend.callAsync('speedTest', { mode: 'full' });
  clock.advance(4000);
  assert.equal(s.of('speed').at(-1).phase, 'download');
  const seen = s.of('speed').length;
  assert.deepEqual(backend.call('cancel', { op: 'speed' }), { ok: true });
  const cancelled = assertResult('speedTest', await a);
  assert.deepEqual([cancelled.ok, cancelled.error, cancelled.bytesUp], [false, 'cancelled', 0]);
  assert.ok(cancelled.bytesDown > 1e6);
  assert.equal(cancelled.downMbps, undefined);
  clock.advance(30000);
  assert.equal(s.of('speed').length, seen, 'nada mais chega depois de cancelar');

  // Um teste novo encerra o anterior.
  const b = backend.callAsync('speedTest', { mode: 'full' });
  clock.advance(1000);
  const c = backend.callAsync('speedTest', { mode: 'light' });
  assert.equal((await b).error, 'cancelled');
  clock.advance(10000);
  assert.equal((await c).ok, true);

  // O Wi-Fi cai no meio: 'offline'. Sem Wi-Fi desde o começo: 'offline' sem gastar nada.
  const d = backend.callAsync('speedTest', { mode: 'full' });
  clock.advance(5000);
  backend.sim.setState({ wifi: false });
  const dropped = assertResult('speedTest', await d);
  assert.deepEqual([dropped.ok, dropped.error], [false, 'offline']);
  assert.ok(dropped.bytesDown > 0);
  s.clear();
  const e = backend.callAsync('speedTest', {});
  clock.advance(1000);
  assert.deepEqual(assertResult('speedTest', await e), { ok: false, error: 'offline', bytesDown: 0, bytesUp: 0 });
  assert.equal(s.of('speed').length, 0);
  assert.equal(backend.sim.stats().ops, 0);
});

// ---------------------------------------------------------------------------
// O que cada rede anuncia
// ---------------------------------------------------------------------------

test('redes hostis: presentes em todos os mundos (e ausentes com hostile = false)', (t) => {
  assert.deepEqual(HOSTILE_SSIDS, ['<img src=x onerror=alert(1)>', '🚀 WIFI_DA_FAMILIA_ALBUQUERQUE']);
  assert.equal(new TextEncoder().encode(HOSTILE_SSIDS[1]).length, 32, 'o nome mais comprido que o padrão permite');
  for (const world of WORLDS) {
    const s = boot(t, { world });
    const seen = new Map();
    for (const ap of s.backend.call('lastScan').aps) seen.set(ap.ssid, ap);
    for (let i = 0; i < 3; i++) {
      s.backend.callAsync('scan');
      s.clock.advance(3000);
    }
    for (const ev of s.of('scan')) for (const ap of ev.aps) seen.set(ap.ssid, ap);
    for (const ssid of HOSTILE_SSIDS) assert.ok(seen.has(ssid), `${world}: faltou ${ssid}`);
    // O texto hostil também vem nos campos do WPS.
    const wps = parseIes(seen.get(HOSTILE_SSIDS[0]).ies).wps;
    assert.equal(wps.deviceName, HOSTILE_TEXT.wpsDevice);
    assert.equal(wps.manufacturer, HOSTILE_TEXT.wpsMaker);
    assert.equal(s.sim.world.aps.filter((a) => HOSTILE_SSIDS.includes(a.ssid)).length, 3);

    const clean = boot(t, { world, hostile: false });
    assert.ok(!clean.sim.world.aps.some((a) => HOSTILE_SSIDS.includes(a.ssid)));
    if (world !== 'sorteada') assert.equal(clean.sim.world.aps.length, presetWorld(world, 1).aps.length, 'sem os hostis é o mundo pronto, igualzinho');
    assert.equal(s.sim.world.aps.length, clean.sim.world.aps.length + 3);
  }
});

test('elementos do beacon: coerentes com cada rede (padrão, largura, segurança, WPS, roaming, RTT)', (t) => {
  for (const world of PRESETS) {
    const s = boot(t, { world });
    const { backend, clock, sim } = s;
    const byBssid = new Map();
    for (let i = 0; i < 4; i++) {
      backend.callAsync('scan');
      clock.advance(20000);
    }
    for (const ev of s.of('scan')) for (const ap of ev.aps) byBssid.set(ap.bssid, ap);
    assert.ok(byBssid.size >= 8);
    for (const ap of byBssid.values()) {
      const truth = sim.world.ap(ap.bssid);
      const info = parseIes(ap.ies);
      const sum = summarizeIes(info);
      const label = `${world} ${ap.bssid} "${ap.ssid}"`;
      assert.equal(ap.wifiStandard, truth.standard, label);
      assert.equal(sum.gen, truth.standard, label);
      assert.equal(info.count, ap.ies.length, `${label}: todo elemento é hexadecimal válido`);
      // Como num beacon de verdade, o primeiro elemento é o nome da rede.
      assert.deepEqual(ap.ies[0], { id: 0, ext: 0, hex: utf8Hex(ap.ssid) }, label);
      assert.equal(ap.ies.filter((e) => e.id === 5).length, 1, `${label}: um TIM`);

      // Canal e largura anunciados batem com frequency / channelWidth / centerFreq0.
      const channel = ap.frequency < 3000 ? (ap.frequency - 2407) / 5 : (ap.frequency - 5000) / 5;
      if (ap.frequency < 3000) assert.equal(info.ds.channel, channel, label);
      assert.equal(info.htOperation.primaryChannel, channel, label);
      assert.equal(info.htOperation.staWidth, ap.channelWidth >= 1 ? 40 : 20, label);
      if (ap.frequency < 3000 && ap.channelWidth === 1) {
        assert.equal(info.htOperation.secondaryOffset, ap.centerFreq0 > ap.frequency ? 'above' : 'below', label);
      }
      if (info.vhtOperation) {
        assert.equal(info.vhtOperation.widthMhz >= 80, ap.channelWidth >= 2, label);
        if (ap.channelWidth >= 2) assert.equal(5000 + 5 * info.vhtOperation.centerSeg0, ap.centerFreq0, label);
        if (ap.channelWidth === 3) assert.equal(5000 + 5 * info.vhtOperation.centerSeg1, ap.centerFreq1, label);
      }
      assert.equal(!!info.vht, ap.frequency > 3000 && truth.standard >= 5, label);
      assert.equal(!!info.he, truth.standard >= 6, label);

      // Segurança: os elementos dizem o mesmo que o texto de capabilities.
      const text = parseCapabilities(ap.capabilities);
      const refined = refineWithIes(text, info);
      assert.equal(refined.label, text.label, label);
      assert.deepEqual(refined.akms, text.akms, label);
      assert.deepEqual([...refined.ciphers].sort(), [...text.ciphers].sort(), label);
      assert.equal(!!info.wps, /\[WPS\]/.test(ap.capabilities), label);
      assert.equal(!!info.rsn, /RSN/.test(ap.capabilities), label);
      if (/\[MFPC\]/.test(ap.capabilities)) assert.equal(info.rsn.pmfCapable, true, label);

      // RTT: o campo do Android e o bit do beacon andam juntos.
      assert.equal(sum.ftmResponder, ap.rttResponder, label);

      if (truth.own) {
        assert.equal(sum.country, 'BR', label);
        assert.ok(Number.isInteger(sum.stations) && sum.utilization > 0 && sum.utilization < 1, label);
      }
      if (sum.utilization !== null) assert.ok(sum.utilization > 0 && sum.utilization < 1 && sum.stations >= 0 && sum.stations < 40, label);
    }

    const ownSeen = [...byBssid.values()].filter((ap) => sim.world.ap(ap.bssid).own);
    const meshed = new Set(sim.world.aps.filter((a) => a.own).map((a) => a.device)).size >= 2;
    for (const ap of ownSeen) {
      const info = parseIes(ap.ies);
      const sum = summarizeIes(info);
      // Mesh e rede de empresa: 802.11k/v/r e resposta a RTT; roteador de operadora: nada disso.
      assert.deepEqual(sum.roaming, { k: meshed, v: meshed, r: meshed }, `${world} ${ap.ssid}`);
      assert.equal(parseCapabilities(ap.capabilities).fastRoaming, meshed, `${world} ${ap.capabilities}`);
      assert.equal(ap.rttResponder, meshed, `${world} ${ap.ssid}`);
    }
    if (meshed) {
      const ids = new Set(ownSeen.map((ap) => `${ap.ssid}|${parseIes(ap.ies).mobilityDomain.mdid}`));
      assert.equal(ids.size, new Set(ownSeen.map((ap) => ap.ssid)).size, 'um domínio de mobilidade por rede');
    }
    if (world === 'escritorio') assert.ok(ownSeen.every((ap) => /^AP\d-/.test(summarizeIes(parseIes(ap.ies)).apName)));
    // Rádios do mesmo aparelho anunciam o mesmo modelo.
    const models = new Map();
    for (const ap of byBssid.values()) {
      const wps = parseIes(ap.ies).wps;
      if (!wps) continue;
      const device = sim.world.ap(ap.bssid).device;
      if (models.has(device)) assert.equal(wps.modelName, models.get(device));
      models.set(device, wps.modelName);
    }
    assert.ok(world === 'escritorio' || models.size >= 2, 'alguns roteadores domésticos com WPS');
  }
});

test('BSS Load: aparelhos conectados e ocupação do canal mudam devagar', (t) => {
  const s = boot(t, { world: 'kitnet', walk: 'still' });
  const { backend, clock, sim } = s;
  const own = sim.world.aps.find((a) => a.own && a.band === 0).bssid;
  const series = [];
  for (let i = 0; i < 60; i++) {
    backend.callAsync('scan');
    clock.advance(30000);
  }
  for (const ev of s.of('scan')) {
    const ap = ev.aps.find((a) => a.bssid === own && a.ageMs < 3000);
    if (ap) series.push(parseIes(ap.ies).bssLoad);
  }
  assert.ok(series.length >= 50);
  const util = series.map((l) => l.utilization);
  const sta = series.map((l) => l.stations);
  assert.ok(Math.max(...util) - Math.min(...util) > 0.05, 'a ocupação varia');
  assert.ok(new Set(sta).size >= 2, 'o número de aparelhos varia');
  // Devagar: de uma varredura para a próxima a ocupação não dá saltos.
  for (let i = 1; i < util.length; i++) assert.ok(Math.abs(util[i] - util[i - 1]) < 0.25, `${util[i - 1]} -> ${util[i]}`);
  for (let i = 1; i < sta.length; i++) assert.ok(Math.abs(sta[i] - sta[i - 1]) <= 1);
});

// ---------------------------------------------------------------------------
// A pessoa virtual
// ---------------------------------------------------------------------------

for (const world of WORLDS) {
  test(`caminhada automática em "${world}": passeia pelos cômodos sem atravessar parede`, (t) => {
    const s = boot(t, { world });
    s.clock.advance(10 * 60000);
    const steps = s.of('sim');
    assert.equal(steps.length, 2400, 'evento "sim" 4 vezes por segundo');
    const w = s.sim.world;
    let moving = 0;
    for (let i = 0; i < steps.length; i++) {
      const p = assertEvent('sim', steps[i]);
      assert.equal(p.mode, 'auto');
      if (p.moving) moving++;
      if (!onStairs(p)) {
        assert.ok(w.isFree(p.x, p.y, p.floor, 0.05), `dentro de parede ou fora da casa em t=${p.t}: ${p.x}, ${p.y}`);
        // Em cima da soleira o arredondamento da posição pode cair no cômodo vizinho.
        const around = [[0, 0], [0.002, 0], [-0.002, 0], [0, 0.002], [0, -0.002]].map(([dx, dy]) => w.roomAt(p.x + dx, p.y + dy, p.floor)?.name ?? null);
        assert.ok(around.includes(p.room), `cômodo ${p.room} em t=${p.t}, esperava um de ${around}`);
      }
      if (i === 0) continue;
      const a = steps[i - 1];
      assert.ok(Math.abs(p.t - a.t - 0.25) < 1e-6);
      assert.ok(Math.hypot(p.x - a.x, p.y - a.y) <= 0.26, `passo grande demais em t=${p.t}`);
      assert.ok(Math.abs(p.z - a.z) <= 0.15, `salto de altura em t=${p.t}`);
      if (!onStairs(p) && !onStairs(a) && a.floor === p.floor) {
        assert.equal(w.crossesWall(a.x, a.y, p.x, p.y, p.floor), false, `atravessou parede em t=${p.t}`);
      }
    }
    assert.ok(moving > steps.length * 0.5 && moving < steps.length * 0.95, 'anda a maior parte do tempo, com pausas');
    const visited = new Set(steps.map((p) => p.room).filter(Boolean));
    assert.equal(visited.size, new Set(w.rooms.map((r) => r.name)).size, 'visita todos os cômodos em 10 minutos');
    assert.equal(new Set(steps.map((p) => p.floor)).size, w.floors, 'e todos os andares');
  });
}

test('caminhada: parada, manual (goTo, setFloor), teleporte e volta ao automático', (t) => {
  const s = boot(t, { world: 'apartamento', walk: 'still' });
  const { clock, sim } = s;
  const w = sim.world;
  const start = sim.truth();
  assert.equal(start.mode, 'still');
  assert.equal(start.room, 'Sala');
  clock.advance(30000);
  assert.deepEqual({ ...sim.truth(), t: 0 }, { ...start, t: 0 }, 'parada não sai do lugar');
  assert.ok(s.of('sim').every((p) => !p.moving));

  // Vai até o Quarto 2 passando pelas portas.
  const room = w.rooms.find((r) => r.name === 'Quarto 2');
  s.clear();
  assert.equal(sim.walker.goTo(room.centroid.x, room.centroid.y), true);
  assert.equal(sim.walker.mode, 'manual');
  clock.advance(40000);
  const end = sim.truth();
  assert.equal(end.room, 'Quarto 2');
  assert.equal(end.moving, false);
  assert.ok(Math.hypot(end.x - room.centroid.x, end.y - room.centroid.y) < 0.3, 'chega (à célula mais próxima do) destino');
  const path = s.of('sim');
  assert.ok(path.some((p) => p.moving));
  assert.ok(path.some((p) => p.room === 'Corredor'), 'o caminho passa pelo corredor, não pela parede');
  for (let i = 1; i < path.length; i++) {
    assert.equal(w.crossesWall(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y, 0), false);
    assert.ok(w.isFree(path[i].x, path[i].y, 0, 0.05));
  }
  const walked = path.filter((p) => p.moving).length * 0.25;
  assert.ok(walked > 6 && walked < 25, `andou por ${walked} s`);

  // Destino fora da casa: vai até o ponto livre mais próximo. Andar que não existe: não vai.
  assert.equal(sim.walker.goTo(-40, 3), true);
  clock.advance(60000);
  assert.ok(sim.truth().x < 1 && w.isFree(sim.truth().x, sim.truth().y, 0, 0.05));
  const here = sim.truth();
  assert.equal(sim.walker.goTo(2, 2, 3), false);
  assert.equal(sim.walker.goTo('x', 2), false);
  assert.equal(sim.walker.setFloor(1), false, 'o apartamento só tem um andar');
  assert.equal(sim.walker.setFloor(0), true);
  clock.advance(5000);
  assert.deepEqual({ ...sim.truth(), t: 0 }, { ...here, t: 0 });

  // Teleporte: muda de lugar na hora e fica parada; ponto dentro da parede vai para o livre mais próximo.
  assert.equal(sim.walker.teleport(7, 2), true);
  assert.deepEqual([sim.truth().x, sim.truth().y, sim.truth().room, sim.truth().mode], [7, 2, 'Cozinha', 'still']);
  assert.equal(sim.walker.teleport(5.4, 0.5), true);
  assert.ok(w.isFree(sim.truth().x, sim.truth().y, 0, 0.1));
  assert.deepEqual(sim.walker.position(), sim.truth());

  // De volta ao automático: retoma o passeio a partir de onde está (sem pular).
  s.clear();
  sim.walker.setMode('auto');
  sim.walker.setMode('voando'); // modo que não existe: ignora
  assert.equal(sim.walker.mode, 'auto');
  clock.advance(5 * 60000);
  const tour = s.of('sim');
  for (let i = 1; i < tour.length; i++) assert.ok(Math.hypot(tour[i].x - tour[i - 1].x, tour[i].y - tour[i - 1].y) <= 0.26);
  assert.ok(new Set(tour.map((p) => p.room)).size >= 4);
});

test('caminhada no sobrado: a escada leva de um andar ao outro, devagar', (t) => {
  const s = boot(t, { world: 'sobrado', walk: 'still' });
  const { clock, sim } = s;
  const room = sim.world.rooms.find((r) => r.name === 'Quarto 3');
  assert.equal(sim.walker.goTo(room.centroid.x, room.centroid.y, 1), true);
  clock.advance(90000);
  assert.deepEqual([sim.truth().room, sim.truth().floor, sim.truth().moving], ['Quarto 3', 1, false]);
  const path = s.of('sim');
  const climbing = path.filter(onStairs);
  assert.ok(climbing.length >= 20, 'pelo menos uns 6 s na escada');
  for (let i = 1; i < path.length; i++) assert.ok(Math.abs(path[i].z - path[i - 1].z) < 0.15);
  assert.equal(path[0].z, 1.2);
  assert.equal(path.at(-1).z, 4);

  // Pedido no meio da escada: termina de subir (ou descer) antes de obedecer.
  s.clear();
  sim.walker.setFloor(0);
  for (let i = 0; i < 400 && !onStairs(sim.truth()); i++) clock.advance(250);
  assert.ok(onStairs(sim.truth()));
  assert.equal(sim.walker.goTo(room.centroid.x, room.centroid.y, 1), true);
  clock.advance(120000);
  assert.deepEqual([sim.truth().room, sim.truth().floor], ['Quarto 3', 1]);
  const z = s.of('sim').map((p) => p.z);
  assert.ok(Math.min(...z) < 1.35, `desceu até o fim antes de voltar (mínimo ${Math.min(...z)})`);
  for (let i = 1; i < z.length; i++) assert.ok(Math.abs(z[i] - z[i - 1]) < 0.15);
});

// ---------------------------------------------------------------------------
// Tempo, determinismo, encerramento
// ---------------------------------------------------------------------------

test('speed: 10 = tudo dez vezes mais rápido, com idades na escala do relógio do celular', async (t) => {
  const s = boot(t, { speed: '10' });
  const { backend, clock, sim } = s;
  assert.equal(sim.speed, 10);
  clock.advance(1000);
  assert.ok(Math.abs(sim.now() - 10) < 1e-6);
  const start = clock.now();
  await backend.callAsync('scan');
  clock.advance(400);
  const scan = s.events.find((e) => e.name === 'scan');
  assert.ok(scan && scan.at - start >= 240 && scan.at - start <= 285, `varredura em ${scan && scan.at - start} ms de relógio`);
  assertEvent('scan', scan.data);
  assert.ok(scan.data.aps.filter((a) => a.ageMs <= 300).length >= 5, 'idades encolhem junto com o tempo');
  backend.call('watchRssi', { intervalMs: 1000 });
  s.clear();
  clock.advance(999);
  assert.equal(s.of('rssi').length, 10);
  clock.advance(1);
  assert.equal(s.of('sim').length, 4, "o evento 'sim' continua a 4 por segundo de relógio");
  const [a, b] = s.of('sim');
  assert.ok(Math.abs(b.t - a.t - 2.5) < 1e-6);

  // Mudar a velocidade no meio não perde nem repete tempo.
  const before = sim.now();
  assert.equal(sim.setSpeed(2), 2);
  clock.advance(3000);
  assert.ok(Math.abs(sim.now() - before - 6) < 1e-6);
  assert.equal(sim.setSpeed(1e6), 60);
  assert.equal(sim.setSpeed(0), 0.1);
  assert.equal(sim.setSpeed('abc'), 0.1);
  assert.equal(sim.setSpeed('3'), 3);
  for (const e of s.events) assertEvent(e.name, e.data);
});

test('relógio que salta (aba em segundo plano, celular que dormiu): o mundo não tenta recuperar o atraso', (t) => {
  const base = createManualClock();
  let skew = 0;
  const clock = { now: () => base.now() + skew, setTimeout: base.setTimeout, clearTimeout: base.clearTimeout };
  const s = boot(t, { clock, world: 'sobrado' });
  s.backend.call('watchRssi', { intervalMs: 1000 });
  base.advance(10000);
  assert.equal(s.sim.now(), 10);
  s.clear();
  skew += 3 * 3600000; // três horas sem nenhum temporizador disparar
  const started = performance.now();
  assert.equal(s.sim.now(), 130, 'avança no máximo 2 minutos de uma vez');
  assert.ok(performance.now() - started < 2000);
  // O que venceu nesses 2 minutos saiu em ordem; o relógio dos eventos é o de agora.
  assert.equal(s.of('rssi').length, 120);
  assert.ok(s.events.every((e) => e.name === 'sim' || e.data.ts === undefined || e.data.ts === clock.now()));
  for (const e of s.events) assertEvent(e.name, e.data);
  // Daí em diante, vida normal — inclusive se o relógio andar para trás.
  s.clear();
  base.advance(5000);
  assert.equal(s.sim.now(), 135);
  assert.equal(s.of('rssi').length, 5);
  assert.equal(s.of('sim').length, 20);
  skew -= 60000;
  assert.equal(s.sim.now(), 135);
  base.advance(2000);
  assert.equal(s.sim.now(), 137);
  assert.equal(s.backend.call('connection').connected, true);
});

test('mundo sob medida: aceita um WorldSpec (com os hostis) ou um mundo já montado (como está)', async (t) => {
  // Casa sem roteador próprio: dá para varrer, mas o celular não tem onde se conectar.
  const spec = presetSpec('kitnet', 1);
  spec.aps = spec.aps.filter((a) => !a.own);
  const s = boot(t, { world: spec });
  assert.equal(s.sim.worldId, 'Kitnet');
  assert.ok(s.sim.world.aps.some((a) => HOSTILE_SSIDS.includes(a.ssid)));
  assert.equal(s.sim.link(), null);
  assert.deepEqual(assertResult('connection', s.backend.call('connection')), { connected: false });
  assert.ok(assertResult('lastScan', s.backend.call('lastScan')).aps.length > 5);
  s.backend.call('watchRssi', { intervalMs: 500 });
  assert.deepEqual(await s.backend.callAsync('scan'), { accepted: true });
  const lan = s.backend.callAsync('lanScan');
  const speed = s.backend.callAsync('speedTest', { mode: 'light' });
  s.clock.advance(60000);
  assert.equal(s.of('rssi').length, 0);
  assert.equal(s.of('connection').length, 0);
  assert.ok(s.of('scan').length >= 1);
  assert.deepEqual(await lan, { devices: [] });
  assert.deepEqual(await speed, { ok: false, error: 'offline', bytesDown: 0, bytesUp: 0 });
  await assert.rejects(s.backend.callAsync('ping', { host: 'www.google.com', count: 2, timeoutMs: 500 }), /host não encontrado/);
  for (const e of s.events) assertEvent(e.name, e.data);

  const world = presetWorld('kitnet', 3);
  const w = boot(t, { world, seed: 3 });
  assert.equal(w.sim.world, world);
  assert.ok(!w.sim.world.aps.some((a) => HOSTILE_SSIDS.includes(a.ssid)));
  assert.equal(assertResult('connection', w.backend.call('connection')).connected, true);
  await w.backend.callAsync('scan');
  w.clock.advance(5000);
  for (const e of w.events) assertEvent(e.name, e.data);
});

test('opções em texto (vindas da URL) valem; mundo desconhecido cai no apartamento', (t) => {
  const s = boot(t, { throttle: '1', wifi: '0', location: 'false', seed: '3', speed: '2', hostile: '0', permission: 'denied', walk: 'still' });
  assert.deepEqual(s.backend.call('status'), { wifiEnabled: false, locationEnabled: false, permission: 'denied', throttled: true, canScan: false });
  assert.equal(s.sim.seed, 3);
  assert.equal(s.sim.speed, 2);
  assert.equal(s.sim.walker.mode, 'still');
  assert.ok(!s.sim.world.aps.some((a) => HOSTILE_SSIDS.includes(a.ssid)));
  const on = boot(t, { throttle: 'true', wifi: '1', location: 'on', hostile: 'true', seed: 'x', speed: 'y' });
  assert.deepEqual(on.backend.call('status'), { wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: true, canScan: true });
  assert.equal(on.sim.seed, 1);
  assert.equal(on.sim.speed, 1);

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const odd = boot(t, { world: 'castelo' });
    assert.equal(odd.sim.worldId, 'apartamento');
    assert.equal(errors.length, 1);
    const before = odd.sim.world;
    assert.throws(() => odd.sim.loadWorld('castelo'), /mundo desconhecido/);
    assert.equal(odd.sim.world, before, 'falha ao trocar não estraga o mundo atual');
    assert.equal(odd.backend.call('connection').connected, true);
  } finally {
    console.error = original;
  }
});

test("loadWorld: troca de casa e avisa a interface ('connection' e uma varredura nova)", (t) => {
  const s = boot(t, { world: 'kitnet', seed: 2 });
  const { backend, clock, sim } = s;
  backend.call('watchRssi', { intervalMs: 1000 });
  clock.advance(5000);
  const before = backend.call('connection');
  s.clear();
  assert.equal(sim.loadWorld('sobrado', 5), 'sobrado');
  assert.deepEqual(s.events.map((e) => e.name), ['connection', 'scan']);
  const conn = assertEvent('connection', s.events[0].data);
  assert.notEqual(conn.bssid, before.bssid);
  assert.equal(sim.world.ap(conn.bssid).own, true);
  const scan = assertEvent('scan', s.events[1].data);
  assert.ok(scan.fresh && scan.aps.some((a) => a.bssid === conn.bssid));
  assert.deepEqual([sim.worldId, sim.seed, sim.world.name, sim.world.floors], ['sobrado', 5, 'Sobrado', 2]);
  assert.equal(sim.truth().world, 'sobrado');
  clock.advance(60000);
  for (const e of s.events) assertEvent(e.name, e.data);
  assert.ok(s.of('rssi').every((r) => sim.world.ap(r.bssid)));
  assert.equal(sim.loadWorld('kitnet'), 'kitnet');
  assert.equal(sim.seed, 5, 'sem semente nova, mantém a atual');
});

function scriptedSession(seed) {
  const s = boot(null, { world: 'sobrado', seed });
  const { backend, clock, sim } = s;
  const results = [];
  const keep = (label) => (value) => results.push([label, value]);
  backend.call('watchRssi', { intervalMs: 700 });
  backend.callAsync('scan').then(keep('scan'));
  clock.advance(20000);
  backend.callAsync('ping', { host: '8.8.8.8', count: 5, timeoutMs: 500 }).then(keep('ping'));
  backend.callAsync('lanScan').then(keep('lan'));
  backend.callAsync('rtt', { bssids: sim.world.aps.filter((a) => a.own).map((a) => a.bssid) }).then(keep('rtt'));
  backend.callAsync('speedTest', { mode: 'light' }).then(keep('speed'));
  clock.advance(15000);
  sim.setState({ throttle: true });
  for (let i = 0; i < 6; i++) {
    backend.callAsync('scan').then(keep('scan'));
    clock.advance(4000);
  }
  sim.walker.goTo(6.5, 8, 1);
  clock.advance(60000);
  sim.setState({ wifi: false });
  clock.advance(5000);
  backend.call('openSettings', { which: 'wifi' });
  sim.walker.setMode('auto');
  clock.advance(3 * 60000);
  results.push(['connection', backend.call('connection')], ['lastScan', backend.call('lastScan')], ['truth', sim.truth()]);
  backend.dispose();
  return { events: s.events, results };
}

test('determinismo: a mesma semente gera exatamente a mesma sequência de eventos', async () => {
  const a = scriptedSession(7);
  const b = scriptedSession(7);
  const c = scriptedSession(8);
  await new Promise((resolve) => setImmediate(resolve)); // deixa as Promises das três sessões resolverem
  assert.ok(a.events.length > 1500);
  const kinds = new Set(a.events.map((e) => e.name));
  for (const name of [...Object.keys(EVENTS), 'sim']) assert.ok(kinds.has(name), name);
  assert.equal(JSON.stringify(a.events), JSON.stringify(b.events));
  assert.equal(JSON.stringify(a.results), JSON.stringify(b.results));
  assert.ok(a.results.length >= 14);
  assert.notEqual(JSON.stringify(a.events), JSON.stringify(c.events));
  for (const e of a.events) assertEvent(e.name, e.data);
});

test('determinismo: fazer perguntas no meio (ping, conexão, cache) não muda a caminhada nem as varreduras', (t) => {
  const run = (curious) => {
    const s = boot(t, { world: 'apartamento', seed: 4 });
    s.events.length = 0;
    s.backend.callAsync('scan');
    for (let i = 0; i < 240; i++) {
      s.clock.advance(500);
      if (curious && i % 7 === 0) {
        s.backend.call('connection');
        s.backend.call('lastScan');
        s.sim.truth();
      }
      if (curious && i === 20) s.backend.callAsync('ping', { host: '1.1.1.1', count: 30, timeoutMs: 800 });
      if (curious && i === 30) s.backend.callAsync('lanScan');
      if (curious && i === 60) s.backend.callAsync('speedTest', { mode: 'full' });
      if (i % 20 === 19) s.backend.callAsync('scan');
    }
    return JSON.stringify(s.events.filter((e) => ['sim', 'scan', 'connection'].includes(e.name)));
  };
  assert.equal(run(true), run(false));
});

test('dispose: nenhum temporizador fica armado, nada mais é emitido, quem esperava recebe resposta', async (t) => {
  const s = boot(null, { permission: 'denied', world: 'sobrado' });
  const { backend, clock } = s;
  assert.equal(currentSim(), backend.sim);
  assert.ok(clock.pending() >= 2);
  backend.sim.setState({ permission: 'granted' });
  backend.call('watchRssi', { intervalMs: 300 });
  backend.call('openSettings', { which: 'developer' });
  backend.call('saveFile', { name: 'x.txt', mime: 'text/plain', text: 'x' });
  await backend.callAsync('scan');
  const ping = backend.callAsync('ping', { host: '8.8.8.8', count: 30, timeoutMs: 1000 });
  const lan = backend.callAsync('lanScan');
  const speed = backend.callAsync('speedTest', { mode: 'full' });
  clock.advance(3000);
  const own = backend.sim.world.aps.filter((a) => a.own).map((a) => a.bssid);
  const rtt = backend.callAsync('rtt', { bssids: own });
  backend.sim.setState({ permission: 'denied' });
  const perm = backend.callAsync('requestPermission');
  assert.ok(s.events.length > 0);
  assert.equal(backend.sim.stats().ops, 5);

  backend.dispose();
  assert.equal(clock.pending(), 0, 'nenhum temporizador depois do dispose');
  assert.equal(currentSim(), null);
  const count = s.events.length;
  clock.advance(10 * 60000);
  assert.equal(s.events.length, count, 'nenhum evento depois do dispose');
  assert.equal(clock.pending(), 0);

  // Como no onDestroy do Android: ninguém fica esperando; cada operação responde com o que já tinha.
  assertResult('ping', await ping);
  assert.ok((await ping).sent < 30);
  assertResult('lanScan', await lan);
  const cancelled = assertResult('speedTest', await speed);
  assert.deepEqual([cancelled.ok, cancelled.error], [false, 'cancelled']);
  assert.deepEqual(await rtt, { results: own.map((bssid) => ({ bssid, ok: false })) });
  assertResult('requestPermission', await perm);

  assert.throws(() => backend.call('status'), /^Error: encerrado$/);
  await assert.rejects(backend.callAsync('scan'), /^Error: encerrado$/);
  backend.dispose(); // duas vezes não é erro
  backend.sim.dispose();
  assert.equal(clock.pending(), 0);

  // currentSim acompanha o simulador mais novo.
  const a = boot(t);
  const b = boot(t);
  assert.equal(currentSim(), b.sim);
  a.backend.dispose();
  assert.equal(currentSim(), b.sim, 'encerrar o antigo não apaga o atual');
  b.backend.dispose();
  assert.equal(currentSim(), null);
  assert.equal(a.clock.pending() + b.clock.pending(), 0);
});

test('ouvinte que lança erro ou chama a ponte de dentro do evento não quebra o simulador', async (t) => {
  const clock = createManualClock();
  const seen = [];
  const errors = [];
  let backend = null;
  const original = console.error;
  console.error = (...args) => errors.push(args);
  t.after(() => {
    console.error = original;
    backend.dispose();
  });
  backend = createSimBackend({
    clock,
    walk: 'still',
    emit: (name, data) => {
      if (name === 'sim') return;
      seen.push(name);
      if (name === 'scan') {
        // Chamar a ponte de dentro do ouvinte (o laço de varredura faz isso).
        assertResult('connection', backend.call('connection'));
        assertResult('lastScan', backend.call('lastScan'));
        if (data.fresh && seen.filter((n) => n === 'scan').length < 5) backend.callAsync('scan');
        throw new Error('ouvinte com defeito');
      }
    },
  });
  await backend.callAsync('scan');
  clock.advance(14000);
  assert.equal(seen.filter((n) => n === 'scan').length, 5, 'um pedido por lista recebida, em cadeia');
  assert.equal(errors.length, 5);
  assert.equal(backend.call('status').canScan, true);
});

test('sessão longa: 30 minutos andando e varrendo sem parar continuam rápidos e sem acumular memória', async (t) => {
  const clock = createManualClock();
  const counts = {};
  let invalid = 0;
  let backend = null;
  backend = createSimBackend({
    clock,
    world: 'escritorio',
    emit: (name, data) => {
      counts[name] = (counts[name] || 0) + 1;
      if (checkEvent(name, data).length) invalid++;
      if (name === 'scan') backend.callAsync('scan'); // varre de novo assim que a lista chega
    },
  });
  t.after(() => backend.dispose());
  backend.call('watchRssi', { intervalMs: 1000 });
  await backend.callAsync('scan');

  const started = performance.now();
  clock.advance(10 * 60000);
  const early = backend.sim.stats();
  const heapEarly = process.memoryUsage().heapUsed;
  clock.advance(20 * 60000 - 1);
  const elapsed = performance.now() - started;
  const late = backend.sim.stats();

  assert.equal(invalid, 0);
  assert.ok(Math.abs(backend.sim.now() - 1799.999) < 1e-6);
  assert.ok(counts.scan >= 600 && counts.scan <= 760, `${counts.scan} varreduras em 30 minutos`);
  assert.equal(counts.rssi, 1800);
  assert.equal(counts.sim, 7199);
  assert.ok(elapsed < 20000, `30 minutos simulados levaram ${Math.round(elapsed)} ms`);
  // Estruturas internas com tamanho limitado, e iguais (na ordem de grandeza) aos 10 e aos 30 minutos.
  for (const stats of [early, late]) {
    assert.ok(stats.timers <= 12, JSON.stringify(stats));
    assert.ok(stats.walker <= 400, JSON.stringify(stats));
    assert.ok(stats.accepted <= 60, JSON.stringify(stats));
    assert.ok(stats.cached <= backend.sim.world.aps.length, JSON.stringify(stats));
    assert.equal(stats.ops, 0);
  }
  assert.ok(late.walker <= early.walker + 200);
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const grown = process.memoryUsage().heapUsed - heapEarly;
  assert.ok(grown < 64 * 1024 * 1024, `a memória cresceu ${Math.round(grown / 1048576)} MB entre os 10 e os 30 minutos`);
});

// ---------------------------------------------------------------------------
// Integração: bridge.js, relógio de verdade e navegador
// ---------------------------------------------------------------------------

test('bridge.js: connect("sim") usa este simulador e os eventos chegam aos ouvintes', async () => {
  const bridge = await import('../app/js/bridge.js');
  const clock = createManualClock();
  assert.equal(await bridge.connect('sim', { clock, world: 'kitnet', walk: 'still' }), 'sim');
  try {
    assert.equal(bridge.kind(), 'sim');
    const sim = currentSim();
    assert.equal(sim.worldId, 'kitnet');
    const scans = [];
    const off = bridge.on('scan', (ev) => scans.push(ev));
    assertResult('info', await bridge.info());
    assertResult('status', await bridge.status());
    assertResult('lastScan', await bridge.lastScan());
    assertResult('connection', await bridge.connection());
    assertResult('scan', await bridge.scan());
    clock.advance(3000);
    assert.equal(scans.length, 1);
    assertEvent('scan', scans[0]);
    assertResult('watchRssi', await bridge.watchRssi(500));
    assertResult('watchRssi', await bridge.watchRssi());
    assertResult('keepAwake', await bridge.keepAwake(true));
    assertResult('keepAwake', await bridge.keepAwake());
    assertResult('vibrate', await bridge.vibrate());
    assertResult('setBars', await bridge.setBars('#0a0f1c', true));
    assertResult('openSettings', await bridge.openSettings('developer'));
    assertResult('share', await bridge.share('a', 'b'));
    assertResult('saveFile', await bridge.saveFile({ name: 'a.txt', mime: 'text/plain', text: 'a' }));
    const ping = bridge.ping('8.8.8.8', 2, 500);
    const lan = bridge.lanScan();
    const rtt = bridge.rtt([sim.world.aps[0].bssid]);
    const speed = bridge.speedTest('light');
    await clock.advanceAsync(15000);
    assertResult('ping', await ping);
    assertResult('lanScan', await lan);
    assertResult('rtt', await rtt);
    assertResult('speedTest', await speed);
    for (const op of CANCEL_OPS) assertResult('cancel', await bridge.cancel(op));
    assertResult('unwatchRssi', await bridge.unwatchRssi());
    // Os erros chegam à interface como exceções, com o texto do lado nativo.
    await assert.rejects(bridge.openSettings('bluetooth'), /^Error: argumentos inválidos: which$/);
    await assert.rejects(bridge.ping('nao existe'), /^Error: host inválido$/);
    off();

    // Trocar de simulador pelo bridge encerra o anterior.
    const timers = clock.pending();
    assert.equal(await bridge.connect('sim', { clock, world: 'sobrado' }), 'sim');
    assert.notEqual(currentSim(), sim);
    assert.equal(currentSim().worldId, 'sobrado');
    assert.ok(clock.pending() <= timers, 'os temporizadores do anterior foram desarmados');
  } finally {
    currentSim()?.dispose();
  }
  assert.equal(clock.pending(), 0);
});

test('relógio de verdade: sem relógio injetado tudo funciona, e dispose deixa o processo terminar', async () => {
  const events = [];
  let wake = null;
  const backend = createSimBackend({
    speed: 60,
    world: 'kitnet',
    emit: (name, data) => {
      events.push({ name, data, at: Date.now() });
      if (name === 'scan' && wake) wake();
    },
  });
  try {
    const before = Date.now();
    const arrived = new Promise((resolve, reject) => {
      wake = resolve;
      setTimeout(() => reject(new Error('a varredura não chegou em 3 s')), 3000).unref();
    });
    assert.deepEqual(await backend.callAsync('scan'), { accepted: true });
    await arrived;
    const scan = events.find((e) => e.name === 'scan');
    assertEvent('scan', scan.data);
    assert.ok(Math.abs(scan.data.ts - scan.at) <= 5);
    assert.ok(scan.at - before < 1000, `com speed 60 a varredura leva ~45 ms; levou ${scan.at - before}`);
    const p = backend.callAsync('ping', { host: '8.8.8.8', count: 3, timeoutMs: 1000 });
    assert.equal(assertResult('ping', await p).sent, 3);
    assert.equal(assertResult('speedTest', await backend.callAsync('speedTest', { mode: 'light' })).ok, true);
  } finally {
    backend.dispose();
  }
  const count = events.length;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(events.length, count, 'nada depois do dispose');
});

test('navegador: carrega pelo bridge.js, emite eventos e saveFile baixa o arquivo', async (t) => {
  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch {
    t.skip('playwright não está instalado');
    return;
  }
  const { startServer } = await import('../tools/serve.mjs');
  const server = await startServer(0);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`${msg.type()}: ${msg.text()}`);
  });
  // Página em branco na mesma origem do app (o index.html de verdade é assunto de outros testes).
  await page.route('**/__sim__.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="theme-color" content="#000000"><title>sim</title><body></body>' }),
  );
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  await page.goto(`${base}/__sim__.html`);

  const out = await page.evaluate(async () => {
    const bridge = await import('/js/bridge.js');
    const { currentSim } = await import('/js/sim/backend.js');
    const events = [];
    for (const name of ['scan', 'rssi', 'status', 'connection', 'ping', 'lan', 'lanProgress', 'speed', 'sim']) {
      bridge.on(name, (data) => events.push({ name, data, at: Date.now() }));
    }
    const kind = await bridge.connect('sim', { world: 'sobrado', speed: '20', throttle: '0' });
    const results = {};
    results.info = await bridge.info();
    results.status = await bridge.status();
    results.lastScan = await bridge.lastScan();
    results.connection = await bridge.connection();
    results.watchRssi = await bridge.watchRssi(1000);
    results.scan = await bridge.scan();
    results.ping = await bridge.ping('8.8.8.8', 4, 1000);
    results.lanScan = await bridge.lanScan();
    results.rtt = await bridge.rtt(currentSim().world.aps.filter((a) => a.own).map((a) => a.bssid));
    results.speedTest = await bridge.speedTest('light');
    results.setBars = await bridge.setBars('#0a0f1c', true);
    results.keepAwake = await bridge.keepAwake(true);
    results.vibrate = await bridge.vibrate(30);
    results.share = await bridge.share('WiFi Raio-X', 'texto');
    results.unwatchRssi = await bridge.unwatchRssi();
    globalThis.__sim = currentSim();
    return {
      kind,
      results,
      events,
      theme: document.querySelector('meta[name="theme-color"]').getAttribute('content'),
      truth: currentSim().truth(),
      htmlInjected: document.querySelectorAll('img, script[src], svg').length,
    };
  });
  assert.equal(out.kind, 'sim');
  for (const [method, value] of Object.entries(out.results)) assertResult(method, value);
  for (const e of out.events) assertEvent(e.name, e.data);
  const names = new Set(out.events.map((e) => e.name));
  for (const name of ['scan', 'rssi', 'ping', 'lan', 'lanProgress', 'speed', 'sim']) assert.ok(names.has(name), `faltou '${name}' no navegador`);
  assert.equal(out.theme, '#0a0f1c', 'setBars pinta a barra do navegador');
  assert.equal(out.truth.world, 'sobrado');
  assert.equal(out.htmlInjected, 0);
  assert.equal(out.results.speedTest.ok, true);
  // O relógio dos eventos é o mesmo Date.now() da página.
  for (const e of out.events.filter((x) => x.name === 'scan')) assert.ok(Math.abs(e.data.ts - e.at) <= 5);

  // saveFile: texto e base64 viram downloads de verdade, com o nome limpo (sem pastas).
  const save = async (file) => {
    const [download, result] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async (f) => (await import('/js/bridge.js')).saveFile(f), file),
    ]);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return { result, name: download.suggestedFilename(), body: Buffer.concat(chunks) };
  };
  const csv = await save({ name: 'redes/de casa.csv', mime: 'text/csv', text: 'ssid;sinal\nCafé ☕;-57\n' });
  assert.deepEqual(csv.result, { ok: true });
  assert.equal(csv.name, 'de casa.csv');
  assert.equal(csv.body.toString('utf8'), 'ssid;sinal\nCafé ☕;-57\n');
  const bin = await save({ name: 'mapa.bin', mime: 'application/octet-stream', base64: 'AAECA/8=' });
  assert.deepEqual(bin.result, { ok: true });
  assert.deepEqual([...bin.body], [0, 1, 2, 3, 255]);

  // dispose no navegador: os eventos param.
  const after = await page.evaluate(async () => {
    const bridge = await import('/js/bridge.js');
    let n = 0;
    bridge.on('sim', () => n++);
    globalThis.__sim.dispose();
    await new Promise((resolve) => setTimeout(resolve, 700));
    return n;
  });
  assert.equal(after, 0);
  assert.deepEqual(errors, [], 'sem erros nem avisos no console');
});

// Garante que o padrão de BSSID do contrato é o mesmo que os mundos usam.
test('mundos prontos: BSSIDs no formato do contrato e nomes de até 32 bytes', () => {
  for (const id of PRESETS) {
    for (const ap of presetWorld(id, 1).aps) {
      assert.match(ap.bssid, BSSID_RE);
      assert.ok(new TextEncoder().encode(ap.ssid).length <= 32, ap.ssid);
    }
  }
});
