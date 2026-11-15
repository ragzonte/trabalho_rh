// Estado do app (app/js/store.js) e preferências (app/js/prefs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, shallowEqual, MAX_AP_AGE_MS, RSSI_HISTORY_MAX } from '../app/js/store.js';
import { createPrefs, memoryStorage, sanitizeSettings, DEFAULT_SETTINGS, PREFIX } from '../app/js/prefs.js';

const T0 = 1_700_000_000_000;
const WPA2 = '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]';

const ap = (bssid, ssid, level, frequency, extra = {}) => ({
  bssid,
  ssid,
  level,
  frequency,
  channelWidth: 0,
  centerFreq0: 0,
  centerFreq1: 0,
  capabilities: WPA2,
  ageMs: 0,
  ...extra,
});

const scanEvent = (aps, { ts = T0, fresh = true, source = 'request' } = {}) => ({ ts, fresh, source, aps });

// Uma casa: roteador com dois rádios (2,4 e 5 GHz), um vizinho, uma rede oculta e um nome hostil.
const HOME_24 = 'a4:2b:b0:11:22:30';
const HOME_5 = 'a4:2b:b0:11:22:31';
const NEIGHBOUR = '50:c7:bf:aa:bb:01';
const HOSTILE = '<img src=x onerror=alert(1)>';
const baseAps = () => [
  ap(NEIGHBOUR, 'Vizinho', -71, 2462),
  ap(HOME_24, 'Casa', -48, 2437),
  ap(HOME_5, 'Casa', -55, 5180, { channelWidth: 2, centerFreq0: 5210 }),
  ap('62:11:22:33:44:55', '', -80, 2412),
  ap('00:1d:aa:00:00:09', HOSTILE, -77, 2412, { capabilities: '[ESS]' }),
];

function setup(options = {}) {
  let clock = T0;
  const prefs = options.prefs === undefined ? createPrefs(memoryStorage()) : options.prefs;
  const errors = [];
  const store = createStore({ prefs, now: () => clock, onError: (err) => errors.push(err) });
  return { store, prefs, errors, tick: (ms) => (clock += ms), now: () => clock };
}

function quiet(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    return [fn(), logged];
  } finally {
    console.error = original;
  }
}

// ---------------------------------------------------------------------------
// Forma do estado e inscrições
// ---------------------------------------------------------------------------

test('estado inicial: vazio, com os ajustes padrão', () => {
  const { store } = setup();
  const s = store.get();
  assert.equal(s.backend, null);
  assert.equal(s.info, null);
  assert.equal(s.status, null);
  assert.equal(s.connection, null);
  assert.equal(s.rssi, null);
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.settings, sanitizeSettings(DEFAULT_SETTINGS));
  assert.ok(s.favorites instanceof Set && s.favorites.size === 0);
  assert.ok(s.own instanceof Set && s.own.size === 0);
  assert.deepEqual(s.aps, []);
  assert.deepEqual(s.devices, []);
  assert.deepEqual(s.networks, []);
  assert.equal(s.scan.seq, 0);
  assert.equal(s.scan.ts, null);
  assert.equal(s.scan.dataAt, null);
  assert.equal(s.scan.scanning, false);
  assert.equal(s.scan.lastAccepted, null);
  assert.equal(s.loop.mode, 'normal');
  assert.equal(s.loop.throttled, false);
  assert.equal(s.vendorsReady, false);
  assert.equal(store.apById(HOME_24), null);
  assert.deepEqual(store.history(HOME_24), []);
  assert.deepEqual(store.rssiHistory(), []);
});

test('subscribe: só avisa quando o valor escolhido muda, com o valor anterior', () => {
  const { store } = setup();
  const calls = [];
  const off = store.subscribe(
    (s) => s.backend,
    (value, prev, state) => calls.push([value, prev, state === store.get()]),
  );
  store.setStatus({ canScan: true });
  assert.equal(calls.length, 0, 'mudou outra parte do estado');
  store.setBackend('sim');
  store.setBackend('sim');
  assert.deepEqual(calls, [['sim', null, true]]);
  store.setBackend('native');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(0, 2), ['native', 'sim']);
  off();
  store.setBackend('sim');
  assert.equal(calls.length, 2, 'cancelada');
});

test('subscribe: immediate chama já com o valor atual; equal evita avisos por objeto refeito', () => {
  const { store } = setup();
  store.setBackend('sim');
  const now = [];
  store.subscribe((s) => s.backend, (v, prev) => now.push([v, prev]), { immediate: true });
  assert.deepEqual(now, [['sim', undefined]]);

  let plain = 0;
  let shallow = 0;
  const pick = (s) => ({ backend: s.backend, theme: s.theme });
  store.subscribe(pick, () => plain++);
  store.subscribe(pick, () => shallow++, { equal: shallowEqual });
  store.setStatus({ canScan: false });
  assert.equal(plain, 1, 'objeto novo a cada chamada: avisa sempre');
  assert.equal(shallow, 0, 'com shallowEqual só avisa quando um campo muda');
  store.setTheme('light');
  assert.equal(shallow, 1);
});

test('shallowEqual', () => {
  assert.ok(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' }));
  assert.ok(shallowEqual([1, 2], [1, 2]));
  assert.ok(!shallowEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!shallowEqual({ a: {} }, { a: {} }), 'só um nível');
  assert.ok(!shallowEqual([1], { 0: 1 }));
  assert.ok(shallowEqual(null, null));
  assert.ok(!shallowEqual(null, {}));
  assert.ok(shallowEqual(NaN, NaN));
});

test('ouvinte que lança não impede os outros nem quebra o store', () => {
  const { store, errors } = setup();
  const seen = [];
  const [, logged] = quiet(() => {
    store.subscribe(
      (s) => s.backend,
      () => {
        throw new Error('tela quebrada');
      },
    );
    store.subscribe((s) => s.backend, (v) => seen.push(v));
    store.setBackend('sim');
    store.setBackend('native');
  });
  assert.deepEqual(seen, ['sim', 'native']);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].message, 'tela quebrada');
  assert.equal(logged.length, 2);
});

test('seletor que lança é tratado como erro do ouvinte', () => {
  const { store, errors } = setup();
  let armed = false;
  const [, logged] = quiet(() => {
    store.subscribe(
      (s) => {
        if (armed) throw new Error('seletor quebrado');
        return s.backend;
      },
      () => {},
    );
    armed = true;
    store.setBackend('sim');
  });
  assert.equal(errors.length, 1);
  assert.equal(logged.length, 1);
  assert.equal(store.get().backend, 'sim');
});

test('batch: várias ações, um aviso só', () => {
  const { store } = setup();
  let calls = 0;
  store.subscribe((s) => s, () => calls++);
  store.batch(() => {
    store.setBackend('sim');
    store.setInfo({ platform: 'sim', sdk: 0 });
    store.setStatus({ canScan: true });
  });
  assert.equal(calls, 1);
  assert.equal(store.get().info.platform, 'sim');
});

test('ação disparada de dentro de um ouvinte é entregue aos demais', () => {
  const { store } = setup();
  const themes = [];
  store.subscribe((s) => s.backend, () => store.setTheme('light'));
  store.subscribe((s) => s.theme, (t) => themes.push(t));
  store.setBackend('sim');
  assert.deepEqual(themes, ['light']);
});

// ---------------------------------------------------------------------------
// Varreduras e listas derivadas
// ---------------------------------------------------------------------------

test('ingestScan: normaliza, ordena pelo sinal e avisa uma vez por varredura', () => {
  const { store } = setup();
  let apsCalls = 0;
  let devicesCalls = 0;
  let networksCalls = 0;
  store.subscribe((s) => s.aps, () => apsCalls++);
  store.subscribe((s) => s.devices, () => devicesCalls++);
  store.subscribe((s) => s.networks, () => networksCalls++);
  store.ingestScan(scanEvent(baseAps()));
  assert.equal(apsCalls, 1);
  assert.equal(devicesCalls, 1);
  assert.equal(networksCalls, 1);

  const { aps, scan, networks, devices } = store.get();
  assert.equal(aps.length, 5);
  assert.deepEqual(
    aps.map((a) => a.rssi),
    [-48, -55, -71, -77, -80],
  );
  const home = aps[0];
  assert.equal(home.bssid, HOME_24);
  assert.equal(home.ssid, 'Casa');
  assert.equal(home.band, '2.4');
  assert.equal(home.channel, 6);
  assert.equal(home.security.label, 'WPA2');
  assert.equal(home.level.key, 'excellent');
  assert.equal(home.stale, false);
  assert.equal(aps[1].band, '5');
  assert.equal(aps[1].widthMHz, 80);
  assert.equal(aps[4].hidden, true);
  assert.equal(store.apById(HOME_5.toUpperCase()).bssid, HOME_5, 'apById aceita maiúsculas');

  assert.equal(scan.seq, 1);
  assert.equal(scan.ts, T0);
  assert.equal(scan.receivedAt, T0);
  assert.equal(scan.freshAt, T0);
  assert.equal(scan.dataAt, T0);
  assert.equal(scan.fresh, true);
  assert.equal(scan.source, 'request');
  assert.equal(scan.count, 5);

  const casa = networks.find((n) => n.ssid === 'Casa');
  assert.equal(casa.aps.length, 2);
  assert.ok(casa.aps.every((a) => aps.includes(a)), 'as redes apontam para os mesmos objetos de aps');
  assert.ok(devices.length >= 3 && devices.length <= 5);
  assert.ok(devices.flatMap((d) => d.aps).every((a) => aps.includes(a)));
});

test('nome de rede hostil fica guardado como texto, sem alteração', () => {
  const { store } = setup();
  store.ingestScan(scanEvent(baseAps()));
  const evil = store.get().aps.find((a) => a.ssid === HOSTILE);
  assert.ok(evil);
  assert.equal(evil.name, HOSTILE);
  assert.equal(evil.security.open, true);
});

test('ingestScan ignora o que não é um evento de varredura', () => {
  const { store } = setup();
  let calls = 0;
  store.subscribe((s) => s.scan, () => calls++);
  for (const junk of [null, undefined, 'x', 42, {}, { aps: 'nada' }]) store.ingestScan(junk);
  assert.equal(calls, 0);
  assert.equal(store.get().scan.seq, 0);
  // itens tortos dentro da lista não derrubam a varredura
  store.ingestScan(scanEvent([null, 7, { bssid: 'zz' }, ap(HOME_24, 'Casa', -50, 2437)]));
  assert.equal(store.get().scan.seq, 1);
  assert.ok(store.get().aps.some((a) => a.bssid === HOME_24));
});

test('lista em cache: não vale como varredura nova e a idade dos dados é estimada', () => {
  const { store, tick } = setup();
  const cached = baseAps().map((a, i) => ({ ...a, ageMs: 42_000 + i * 1000 }));
  store.ingestScan(scanEvent(cached, { fresh: false, source: 'cache' }));
  let { scan } = store.get();
  assert.equal(scan.fresh, false);
  assert.equal(scan.source, 'cache');
  assert.equal(scan.freshAt, null);
  assert.equal(scan.dataAt, T0 - 42_000, 'tão velha quanto a leitura mais recente que traz');

  tick(5000);
  store.ingestScan(scanEvent(baseAps(), { ts: T0 + 5000 }));
  scan = store.get().scan;
  assert.equal(scan.freshAt, T0 + 5000);
  assert.equal(scan.dataAt, T0 + 5000);

  // nova lista em cache, mais velha que o que já se tem: a idade não anda para trás
  tick(20_000);
  store.ingestScan(scanEvent(baseAps().map((a) => ({ ...a, ageMs: 50_000 })), { ts: T0 + 25_000, fresh: false, source: 'cache' }));
  scan = store.get().scan;
  assert.equal(scan.fresh, false);
  assert.equal(scan.freshAt, T0 + 5000);
  assert.equal(scan.dataAt, T0 + 5000);
  assert.equal(scan.seq, 3);
});

test('BSSID que some: fica marcado como não ouvido e sai depois de 90 s', () => {
  const { store, tick } = setup();
  store.ingestScan(scanEvent(baseAps()));
  tick(15_000);
  store.ingestScan(scanEvent(baseAps().filter((a) => a.bssid !== NEIGHBOUR), { ts: T0 + 15_000 }));
  const gone = store.apById(NEIGHBOUR);
  assert.ok(gone, 'continua na lista');
  assert.equal(gone.stale, true);
  assert.equal(gone.ageMs, 15_000);
  assert.equal(store.apById(HOME_24).stale, false);

  tick(MAX_AP_AGE_MS);
  store.ingestScan(scanEvent(baseAps().filter((a) => a.bssid !== NEIGHBOUR), { ts: T0 + 15_000 + MAX_AP_AGE_MS }));
  assert.equal(store.apById(NEIGHBOUR), null);
  assert.equal(store.get().aps.length, 4);
});

test('history: o sinal de cada BSSID ao longo das varreduras', () => {
  const { store, tick } = setup();
  store.ingestScan(scanEvent(baseAps()));
  tick(10_000);
  store.ingestScan(scanEvent(baseAps().map((a) => ({ ...a, level: a.level - 4 })), { ts: T0 + 10_000 }));
  assert.deepEqual(store.history(HOME_24), [
    { t: T0, rssi: -48 },
    { t: T0 + 10_000, rssi: -52 },
  ]);
  assert.deepEqual(store.history('00:00:00:00:00:00'), []);
});

test('fabricante: entra quando a tabela carrega, sem esperar a próxima varredura', () => {
  const { store } = setup();
  store.ingestScan(scanEvent(baseAps()));
  assert.equal(store.apById(HOME_24).vendor, null);
  let calls = 0;
  store.subscribe((s) => s.aps, () => calls++);
  store.setVendorLookup({
    loaded: true,
    vendor: (mac) => {
      if (mac.startsWith('a4:2b:b0')) return { name: 'TP-Link', randomized: false, guess: false };
      if (mac.startsWith('62:')) return { name: null, randomized: true, guess: false };
      if (mac.startsWith('50:c7:bf')) return { name: 'Intelbras', randomized: false, guess: true };
      return null;
    },
  });
  assert.equal(calls, 1);
  assert.equal(store.get().vendorsReady, true);
  assert.equal(store.apById(HOME_24).vendor, 'TP-Link');
  assert.equal(store.apById(HOME_24).vendorGuess, false);
  assert.equal(store.apById(NEIGHBOUR).vendor, 'Intelbras');
  assert.equal(store.apById(NEIGHBOUR).vendorGuess, true);
  assert.equal(store.apById('62:11:22:33:44:55').vendor, null, 'MAC aleatório não tem fabricante');

  // tabela que lança, ou que não carregou, não derruba nada
  store.setVendorLookup({
    loaded: false,
    vendor: () => {
      throw new Error('tabela corrompida');
    },
  });
  assert.equal(store.get().vendorsReady, false);
  assert.equal(store.apById(HOME_24).vendor, null);
  store.setVendorLookup(null);
  assert.equal(store.apById(HOME_24).vendor, null);
});

// ---------------------------------------------------------------------------
// Conexão, "minhas redes" e BSSIDs da casa
// ---------------------------------------------------------------------------

test('conexão: marca o AP conectado e põe na "casa" os outros rádios do mesmo aparelho', () => {
  const { store } = setup();
  store.ingestScan(scanEvent(baseAps()));
  assert.equal(store.get().own.size, 0);
  assert.equal(store.connectedAp(), null);

  store.setConnection({ connected: true, ssid: 'Casa', bssid: HOME_5.toUpperCase(), rssi: -55, frequency: 5180 });
  const s = store.get();
  assert.equal(store.connectedAp().bssid, HOME_5);
  assert.equal(store.apById(HOME_5).connected, true);
  assert.equal(store.apById(HOME_24).connected, false);
  const device = s.devices.find((d) => d.bssids.includes(HOME_5));
  for (const bssid of device.bssids) assert.ok(s.own.has(bssid), `${bssid} é do mesmo aparelho`);
  assert.ok(store.isOwn(HOME_5));
  assert.equal(store.apById(HOME_5).own, true);
  assert.equal(store.apById(NEIGHBOUR).own, false);
  assert.ok(!s.own.has(NEIGHBOUR));

  store.setConnection({ connected: false });
  assert.equal(store.get().own.size, 0);
  assert.equal(store.connectedAp(), null);
});

test('conexão reenviada com o mesmo BSSID não refaz as listas', () => {
  const { store } = setup();
  store.ingestScan(scanEvent(baseAps()));
  store.setConnection({ connected: true, ssid: 'Casa', bssid: HOME_5, rssi: -55 });
  let apsCalls = 0;
  let connCalls = 0;
  store.subscribe((s) => s.aps, () => apsCalls++);
  store.subscribe((s) => s.connection, () => connCalls++);
  store.setConnection({ connected: true, ssid: 'Casa', bssid: HOME_5, rssi: -57, linkSpeed: 433 });
  assert.equal(apsCalls, 0);
  assert.equal(connCalls, 1);
  assert.equal(store.get().connection.linkSpeed, 433);
});

test('conexão conhecida antes da primeira varredura vale quando a lista chega', () => {
  const { store } = setup();
  store.setConnection({ connected: true, ssid: 'Casa', bssid: HOME_24 });
  assert.ok(store.isOwn(HOME_24));
  store.ingestScan(scanEvent(baseAps()));
  assert.equal(store.connectedAp().bssid, HOME_24);
  assert.equal(store.apById(HOME_24).own, true);
});

test('favoritos: marcam todos os APs da rede como "da casa" e ficam guardados', () => {
  const { store, prefs } = setup();
  store.ingestScan(scanEvent(baseAps()));
  let apsCalls = 0;
  store.subscribe((s) => s.aps, () => apsCalls++);

  assert.equal(store.toggleFavorite('Casa'), true);
  assert.equal(apsCalls, 1);
  assert.ok(store.isFavorite('Casa'));
  assert.ok(store.get().own.has(HOME_24) && store.get().own.has(HOME_5));
  assert.equal(store.apById(HOME_24).favorite, true);
  assert.equal(store.apById(NEIGHBOUR).favorite, false);
  assert.deepEqual(prefs.loadFavorites(), ['Casa']);

  // nome hostil como favorito: guardado e lido de volta sem mudar
  store.setFavorite(HOSTILE, true);
  assert.deepEqual(prefs.loadFavorites(), ['Casa', HOSTILE]);

  // outro store com as mesmas preferências começa com os favoritos
  const again = createStore({ prefs });
  assert.ok(again.isFavorite('Casa') && again.isFavorite(HOSTILE));

  assert.equal(store.toggleFavorite('Casa'), false);
  assert.ok(!store.get().own.has(HOME_24));
  assert.deepEqual(prefs.loadFavorites(), [HOSTILE]);

  assert.equal(store.setFavorite('', true), false, 'rede sem nome não entra');
  assert.equal(store.setFavorite(null, true), false);
});

test('rede oculta nunca vira "minha rede" por ter o nome vazio', () => {
  const { store } = setup();
  store.ingestScan(scanEvent(baseAps()));
  store.setFavorite('Casa', true);
  const hidden = store.get().aps.find((a) => a.hidden);
  assert.equal(hidden.favorite, false);
  assert.equal(hidden.own, false);
});

// ---------------------------------------------------------------------------
// Demais ações
// ---------------------------------------------------------------------------

test('setLoop: guarda o estado do laço e espelha "buscando" e a última recusa em scan', () => {
  const { store } = setup();
  const loop = { ...store.get().loop, running: true, paused: null, scanning: true, lastAccepted: null, lastReason: null };
  let scanCalls = 0;
  store.subscribe((s) => s.scan, () => scanCalls++);
  store.setLoop(loop);
  assert.equal(store.get().loop, loop);
  assert.equal(store.get().scan.scanning, true);
  assert.equal(scanCalls, 1);
  store.setLoop({ ...loop, nextAt: 123 });
  assert.equal(scanCalls, 1, 'scan não muda quando só o agendamento mudou');
  store.setLoop({ ...loop, scanning: false, lastAccepted: false, lastReason: 'throttled', throttled: true });
  assert.equal(store.get().scan.scanning, false);
  assert.equal(store.get().scan.lastAccepted, false);
  assert.equal(store.get().scan.lastReason, 'throttled');
  assert.equal(store.get().loop.throttled, true);
});

test('setRssi: última leitura e histórico limitado', () => {
  const { store } = setup();
  let calls = 0;
  store.subscribe((s) => s.rssi, () => calls++);
  for (const junk of [null, {}, { rssi: 'forte' }]) store.setRssi(junk);
  assert.equal(calls, 0);
  for (let i = 0; i < RSSI_HISTORY_MAX + 25; i++) store.setRssi({ ts: T0 + i * 1000, rssi: -50 - (i % 10), bssid: HOME_5, frequency: 5180 });
  assert.equal(calls, RSSI_HISTORY_MAX + 25);
  const history = store.rssiHistory();
  assert.equal(history.length, RSSI_HISTORY_MAX);
  assert.equal(history.at(-1), store.get().rssi);
  assert.equal(history[0].ts, T0 + 25_000);
  history.length = 0;
  assert.equal(store.rssiHistory().length, RSSI_HISTORY_MAX, 'devolve uma cópia');
});

test('valores inválidos nas ações de fiação viram null/padrão', () => {
  const { store } = setup();
  store.setBackend('telepatia');
  assert.equal(store.get().backend, null);
  store.setInfo('x');
  assert.equal(store.get().info, null);
  store.setStatus(7);
  assert.equal(store.get().status, null);
  store.setConnection('wifi');
  assert.equal(store.get().connection, null);
  store.setTheme('neon');
  assert.equal(store.get().theme, 'dark');
  store.setTheme('light');
  assert.equal(store.get().theme, 'light');
});

test('resetScanData: limpa tudo o que veio do celular, mantém ajustes e favoritos', () => {
  const { store } = setup();
  store.setBackend('native');
  store.setInfo({ platform: 'android', sdk: 34 });
  store.setStatus({ canScan: true });
  store.ingestScan(scanEvent(baseAps()));
  store.setConnection({ connected: true, bssid: HOME_5, ssid: 'Casa' });
  store.setRssi({ ts: T0, rssi: -50, bssid: HOME_5, frequency: 5180 });
  store.setFavorite('Casa', true);
  store.updateSettings({ theme: 'light' });

  store.resetScanData();
  const s = store.get();
  assert.deepEqual(s.aps, []);
  assert.deepEqual(s.devices, []);
  assert.deepEqual(s.networks, []);
  assert.equal(s.scan.seq, 0);
  assert.equal(s.scan.dataAt, null);
  assert.equal(s.connection, null);
  assert.equal(s.status, null);
  assert.equal(s.info, null);
  assert.equal(s.rssi, null);
  assert.equal(s.own.size, 0);
  assert.deepEqual(store.rssiHistory(), []);
  assert.deepEqual(store.history(HOME_5), []);
  assert.ok(s.favorites.has('Casa'));
  assert.equal(s.settings.theme, 'light');
  // e volta a funcionar normalmente
  store.ingestScan(scanEvent(baseAps()));
  assert.equal(store.get().aps.length, 5);
  assert.equal(store.get().scan.seq, 1);
});

test('ajustes: validados, guardados e avisados', () => {
  const { store, prefs } = setup();
  const themes = [];
  store.subscribe((s) => s.settings.theme, (t) => themes.push(t));
  const out = store.updateSettings({ theme: 'light', scanIntervalS: 15 });
  assert.equal(out.theme, 'light');
  assert.equal(store.get().settings.scanIntervalS, 15);
  assert.deepEqual(themes, ['light']);
  assert.equal(prefs.loadSettings().theme, 'light');

  store.updateSettings({ theme: 'rosa-choque', scanIntervalS: 0.2, demo: 'sim', demoWorld: '../../etc' });
  const s = store.get().settings;
  assert.equal(s.theme, 'system', 'tema desconhecido volta ao padrão');
  assert.equal(s.scanIntervalS, 3, 'intervalo fica dentro dos limites');
  assert.equal(s.demo, false);
  assert.equal(s.demoWorld, 'apartamento');

  const again = createStore({ prefs });
  assert.deepEqual(again.get().settings, s);
});

test('dicas: dispensar guarda o id uma vez; resetTips traz todas de volta', () => {
  const { store, prefs } = setup();
  store.dismissTip('throttle');
  store.dismissTip('throttle');
  store.dismissTip('');
  store.dismissTip(null);
  store.dismissTip('mapa');
  assert.deepEqual(store.get().settings.tipsDismissed, ['throttle', 'mapa']);
  assert.deepEqual(prefs.loadSettings().tipsDismissed, ['throttle', 'mapa']);
  store.resetTips();
  assert.deepEqual(store.get().settings.tipsDismissed, []);
  assert.deepEqual(prefs.loadSettings().tipsDismissed, []);
});

test('clearSavedData: apaga favoritos e ajustes guardados e avisa quem escuta', () => {
  const { store, prefs } = setup();
  store.ingestScan(scanEvent(baseAps()));
  store.setFavorite('Casa', true);
  store.updateSettings({ theme: 'light', demo: true });
  prefs.set('maps.index', [1, 2, 3]);
  const themes = [];
  store.subscribe((s) => s.settings.theme, (t) => themes.push(t));

  store.clearSavedData();
  assert.deepEqual(prefs.keys(), []);
  assert.equal(store.get().favorites.size, 0);
  assert.deepEqual(store.get().settings, sanitizeSettings(DEFAULT_SETTINGS));
  assert.deepEqual(themes, ['system']);
  assert.equal(store.apById(HOME_24).favorite, false);
  assert.equal(store.get().aps.length, 5, 'a lista de redes continua');
});

test('sem prefs o store funciona só na memória', () => {
  const store = createStore();
  store.updateSettings({ theme: 'dark' });
  store.toggleFavorite('Casa');
  store.dismissTip('x');
  store.clearSavedData();
  assert.equal(store.get().settings.theme, 'system');
  assert.equal(store.get().favorites.size, 0);
});

// ---------------------------------------------------------------------------
// prefs.js
// ---------------------------------------------------------------------------

test('prefs: chaves sempre com o prefixo wrx. e valores em JSON', () => {
  const storage = memoryStorage();
  storage.setItem('outro-app', 'não mexer');
  const prefs = createPrefs(storage);
  assert.equal(prefs.persistent, true);
  assert.equal(prefs.set('maps.index', { a: [1, 2] }), true);
  assert.equal(storage.getItem(`${PREFIX}maps.index`), '{"a":[1,2]}');
  assert.deepEqual(prefs.get('maps.index'), { a: [1, 2] });
  assert.equal(prefs.get('nada', 'padrão'), 'padrão');
  prefs.saveSettings({ theme: 'dark' });
  prefs.saveFavorites(new Set(['Casa']));
  assert.deepEqual(prefs.keys().sort(), ['favorites', 'maps.index', 'settings']);
  prefs.remove('maps.index');
  assert.equal(prefs.get('maps.index'), null);
  prefs.clear();
  assert.deepEqual(prefs.keys(), []);
  assert.equal(storage.getItem('outro-app'), 'não mexer', 'clear não toca nas chaves dos outros');
});

test('prefs: JSON corrompido ou de outro formato vira padrão', () => {
  const storage = memoryStorage();
  storage.setItem(`${PREFIX}settings`, '{"theme":"dark",');
  storage.setItem(`${PREFIX}favorites`, '"não é lista"');
  storage.setItem(`${PREFIX}x`, 'undefined');
  const prefs = createPrefs(storage);
  assert.deepEqual(prefs.loadSettings(), sanitizeSettings(DEFAULT_SETTINGS));
  assert.deepEqual(prefs.loadFavorites(), []);
  assert.equal(prefs.get('x', 5), 5);
  storage.setItem(`${PREFIX}settings`, 'null');
  assert.equal(prefs.loadSettings().theme, 'system');
  storage.setItem(`${PREFIX}settings`, '[1,2,3]');
  assert.equal(prefs.loadSettings().theme, 'system');
});

test('prefs: armazenamento que lança (modo privado, cota estourada) não derruba o app', () => {
  const broken = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    },
    key() {
      throw new Error('SecurityError');
    },
    get length() {
      throw new Error('SecurityError');
    },
  };
  const prefs = createPrefs(broken);
  assert.equal(prefs.persistent, false, 'cai para a memória');
  assert.equal(prefs.saveSettings({ theme: 'light' }).theme, 'light');
  assert.equal(prefs.loadSettings().theme, 'light', 'vale até o app fechar');
  assert.deepEqual(prefs.keys(), ['settings']);

  // funciona na partida e começa a falhar depois (cota)
  const storage = memoryStorage();
  let full = false;
  const flaky = {
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => {
      if (full) throw new Error('QuotaExceededError');
      storage.setItem(k, v);
    },
    removeItem: (k) => storage.removeItem(k),
    key: (i) => storage.key(i),
    get length() {
      return storage.length;
    },
  };
  const p2 = createPrefs(flaky);
  assert.equal(p2.persistent, true);
  full = true;
  assert.equal(p2.set('grande', 'x'.repeat(10)), false);
  assert.doesNotThrow(() => p2.saveSettings({ theme: 'dark' }));
  assert.doesNotThrow(() => p2.saveFavorites(['Casa']));
  const store = createStore({ prefs: p2 });
  assert.doesNotThrow(() => store.updateSettings({ theme: 'dark' }));
  assert.equal(store.get().settings.theme, 'dark', 'na memória o ajuste vale');
});

test('sanitizeSettings: cada campo com o tipo e os limites certos', () => {
  const d = sanitizeSettings(undefined);
  assert.deepEqual(d, { theme: 'system', scanIntervalS: 'auto', demo: false, demoWorld: 'apartamento', units: 'metric', tipsDismissed: [] });
  assert.equal(sanitizeSettings({ scanIntervalS: 12.4 }).scanIntervalS, 12);
  assert.equal(sanitizeSettings({ scanIntervalS: 99999 }).scanIntervalS, 600);
  assert.equal(sanitizeSettings({ scanIntervalS: '10' }).scanIntervalS, 'auto', 'texto não é número');
  assert.equal(sanitizeSettings({ scanIntervalS: NaN }).scanIntervalS, 'auto');
  assert.equal(sanitizeSettings({ demo: 1 }).demo, false);
  assert.equal(sanitizeSettings({ demo: true }).demo, true);
  assert.equal(sanitizeSettings({ demoWorld: 'sobrado' }).demoWorld, 'sobrado');
  assert.equal(sanitizeSettings({ demoWorld: '<script>' }).demoWorld, 'apartamento');
  assert.equal(sanitizeSettings({ units: 'imperial' }).units, 'imperial');
  assert.equal(sanitizeSettings({ units: 'léguas' }).units, 'metric');
  assert.deepEqual(sanitizeSettings({ tipsDismissed: ['a', 'a', 7, '', null, 'b'] }).tipsDismissed, ['a', 'b']);
  assert.deepEqual(sanitizeSettings({ tipsDismissed: 'a' }).tipsDismissed, []);
  // o padrão não pode ser alterado por quem recebe o resultado
  d.tipsDismissed.push('x');
  assert.deepEqual(sanitizeSettings(undefined).tipsDismissed, []);
});

test('favoritos guardados: sem repetidos, sem lixo, com limite de tamanho', () => {
  const prefs = createPrefs(memoryStorage());
  prefs.saveFavorites(['Casa', 'Casa', '', 5, null, 'x'.repeat(65), 'Trabalho']);
  assert.deepEqual(prefs.loadFavorites(), ['Casa', 'Trabalho']);
  prefs.saveFavorites(Array.from({ length: 500 }, (_, i) => `rede-${i}`));
  assert.equal(prefs.loadFavorites().length, 200);
  prefs.saveFavorites(null);
  assert.deepEqual(prefs.loadFavorites(), []);
});

// ---------------------------------------------------------------------------
// Revisão de segurança: quem pode se passar pela rede do usuário
// ---------------------------------------------------------------------------

const OPEN = '[ESS]';
const CLONE_CONN = { connected: true, ssid: 'CasaSilva', bssid: HOME_5, rssi: -52, frequency: 5220 };
const mine5 = () => ap(HOME_5, 'CasaSilva', -52, 5220, { channelWidth: 2, centerFreq0: 5210 });
const clone5 = (extra = {}) => ap(HOME_5, 'Free_WiFi', -40, 2462, { capabilities: OPEN, ...extra });

test('BSSID do roteador clonado com outro nome: vindo junto com o de verdade, vale o de verdade (nas duas ordens)', () => {
  for (const list of [
    [clone5(), mine5(), ap(NEIGHBOUR, 'Vizinho', -71, 2462)],
    [mine5(), clone5(), ap(NEIGHBOUR, 'Vizinho', -71, 2462)],
    // o clone "mais novo" não ganha a vaga (a regra do núcleo para BSSID repetido é a leitura mais nova)
    [mine5(), clone5({ ageMs: 0 }), ap(NEIGHBOUR, 'Vizinho', -71, 2462)].map((x, i) => (i === 0 ? { ...x, ageMs: 900 } : x)),
  ]) {
    const { store } = setup();
    store.setConnection(CLONE_CONN);
    store.ingestScan(scanEvent(list));
    const cur = store.connectedAp();
    assert.ok(cur, 'a rede em uso está na lista');
    assert.equal(cur.ssid, 'CasaSilva');
    assert.equal(cur.channel, 44);
    assert.equal(cur.security.open, false);
    assert.equal(cur.own, true);
    assert.deepEqual(store.get().aps.map((a) => a.ssid).sort(), ['CasaSilva', 'Vizinho'], 'a entrada clonada não vira uma linha da lista');
    assert.deepEqual(store.get().clone, { bssid: HOME_5, ssids: ['Free_WiFi'] }, 'mas fica anotada para o diagnóstico');
  }
});

test('BSSID do roteador clonado: quando só o clone chega, ele não vira "a rede em uso"', () => {
  const { store } = setup();
  store.setConnection(CLONE_CONN);
  store.ingestScan(scanEvent([clone5(), ap(NEIGHBOUR, 'Vizinho', -71, 2462)]));
  const state = store.get();
  assert.equal(store.connectedAp(), null, 'as telas ficam com os dados da conexão');
  assert.equal(store.apById(HOME_5), null);
  assert.deepEqual(state.aps.map((a) => a.ssid), ['Vizinho']);
  assert.equal(state.own.has(HOME_5) && state.aps.some((a) => a.own), false, 'nada do clone é "da casa"');
  assert.equal(state.networks.some((n) => n.ssid === 'Free_WiFi'), false);
  assert.deepEqual(state.clone, { bssid: HOME_5, ssids: ['Free_WiFi'] });

  // a busca seguinte traz o roteador de verdade: tudo volta ao normal e o aviso some
  store.ingestScan(scanEvent([{ ...mine5(), ageMs: 0 }, ap(NEIGHBOUR, 'Vizinho', -71, 2462)], { ts: T0 + 10_000 }));
  assert.equal(store.connectedAp().ssid, 'CasaSilva');
  assert.equal(store.get().clone, null);
});

test('BSSID conectado: sem como comparar o nome, a entrada vale (rede oculta, conexão sem nome, nome que o Android não decodificou)', async () => {
  const { sameNetworkName } = await import('../app/js/store.js');
  // rede oculta: a varredura não traz o nome, a conexão traz
  let s = setup().store;
  s.setConnection(CLONE_CONN);
  s.ingestScan(scanEvent([ap(HOME_5, '', -52, 5220)]));
  assert.equal(s.connectedAp().hidden, true);
  assert.equal(s.get().clone, null);
  // conexão sem nome (o Android não informou) ou com o nome entre aspas
  for (const ssid of [undefined, '', '<unknown ssid>', '"CasaSilva"']) {
    s = setup().store;
    s.setConnection({ ...CLONE_CONN, ssid });
    s.ingestScan(scanEvent([mine5()]));
    assert.equal(s.connectedAp().ssid, 'CasaSilva', `conexão com ssid ${JSON.stringify(ssid)}`);
  }
  // "Família" anunciado em Latin-1 por um roteador antigo: na varredura o Android põe U+FFFD no lugar do acento
  assert.equal(sameNetworkName('Fam\uFFFDlia', 'Família'), true);
  assert.equal(sameNetworkName('Fam\uFFFDlia', 'Free_WiFi'), false);
  assert.equal(sameNetworkName('Fam\uFFFDlia', 'Famílias'), false);
  assert.equal(sameNetworkName('CasaSilva', 'casasilva'), false, 'maiúsculas contam: são redes diferentes');
  assert.equal(sameNetworkName('', 'CasaSilva'), true);
  assert.equal(sameNetworkName('CasaSilva', ''), true);
});

test('trocar o nome da rede conectada (mesmo BSSID) refaz as marcas', () => {
  const { store } = setup();
  store.setConnection({ ...CLONE_CONN, ssid: 'Free_WiFi' });
  store.ingestScan(scanEvent([clone5()]));
  assert.equal(store.connectedAp().ssid, 'Free_WiFi', 'quem está conectado na rede aberta vê a rede aberta');
  store.setConnection(CLONE_CONN); // o celular voltou para a rede de verdade, que tem o mesmo BSSID
  assert.equal(store.connectedAp(), null);
  assert.deepEqual(store.get().clone, { bssid: HOME_5, ssids: ['Free_WiFi'] });
});

test('"minha rede" pelo nome não vale para uma rede aberta com o nome de uma rede protegida', () => {
  const TWIN_OPEN = '02:13:37:00:00:01';
  const TWIN_WPA2 = '02:13:37:00:00:02';
  const { store } = setup();
  store.setFavorite('CasaSilva', true);
  store.setConnection(CLONE_CONN);
  store.ingestScan(
    scanEvent([mine5(), ap(TWIN_OPEN, 'CasaSilva', -40, 2412, { capabilities: OPEN }), ap(TWIN_WPA2, 'CasaSilva', -45, 2462), ap(NEIGHBOUR, 'Vizinho', -71, 2462)]),
  );
  const flags = (bssid) => {
    const a = store.apById(bssid);
    return { favorite: a.favorite, own: a.own };
  };
  assert.deepEqual(flags(HOME_5), { favorite: true, own: true });
  assert.deepEqual(flags(TWIN_OPEN), { favorite: false, own: false }, 'a gêmea aberta não é do usuário');
  assert.deepEqual(flags(TWIN_WPA2), { favorite: true, own: true }, 'a de mesma segurança continua contando (pode ser um repetidor)');
  assert.equal(store.get().own.has(TWIN_OPEN), false);

  // sem estar conectado: a aberta continua de fora enquanto houver uma protegida com o mesmo nome
  store.setConnection({ connected: false });
  assert.deepEqual(flags(TWIN_OPEN), { favorite: false, own: false });
  assert.equal(flags(TWIN_WPA2).favorite, true);
});

test('"minha rede" que só existe aberta continua sendo minha; conectado nela, a gêmea com senha é que fica de fora', () => {
  const GUEST = 'a4:2b:b0:11:22:40';
  const { store } = setup();
  store.setFavorite('Convidados', true);
  store.ingestScan(scanEvent([ap(GUEST, 'Convidados', -50, 2437, { capabilities: OPEN }), ap(NEIGHBOUR, 'Vizinho', -71, 2462)]));
  assert.equal(store.apById(GUEST).favorite, true);
  assert.equal(store.apById(GUEST).own, true);

  const OTHER = '02:13:37:00:00:07';
  store.setConnection({ connected: true, ssid: 'Convidados', bssid: GUEST });
  store.ingestScan(scanEvent([ap(GUEST, 'Convidados', -50, 2437, { capabilities: OPEN }), ap(OTHER, 'Convidados', -45, 2462)], { ts: T0 + 10_000 }));
  assert.equal(store.apById(GUEST).favorite, true);
  assert.equal(store.apById(OTHER).favorite, false, 'outra família de segurança = outra rede');
});

test('lista cheia demais: BSSID ouvido uma única vez sai assim que deixa de ser ouvido', async () => {
  const { CROWD_APS } = await import('../app/js/store.js');
  const hx = (n) => n.toString(16).padStart(2, '0');
  const fakes = (round, count) => Array.from({ length: count }, (_, i) => ap(`02:13:${hx(round)}:00:${hx(i >> 8)}:${hx(i & 255)}`, `FREE ${round}-${i}`, -60 - (i % 30), 2412));
  const steady = () => [ap(HOME_24, 'Casa', -48, 2437), ap(HOME_5, 'Casa', -55, 5180), ap(NEIGHBOUR, 'Vizinho', -71, 2462)];
  const { store } = setup();
  store.setFavorite('Lembrada', true);
  store.setConnection({ connected: true, ssid: 'Casa', bssid: HOME_5 });
  const N = CROWD_APS + 100;
  store.ingestScan(scanEvent([...steady(), ap('00:1d:aa:00:00:77', 'Lembrada', -80, 2412), ...fakes(1, N)], { ts: T0 }));
  assert.equal(store.get().aps.length, N + 4, 'tudo o que veio na busca aparece');
  store.ingestScan(scanEvent([...steady(), ...fakes(2, N)], { ts: T0 + 10_000 }));
  const second = store.get().aps;
  assert.equal(second.filter((a) => a.ssid.startsWith('FREE 1-')).length, 0, 'os de uma busca só não ficam 90 s na lista');
  assert.equal(second.filter((a) => a.ssid.startsWith('FREE 2-')).length, N);
  assert.ok(second.length <= N + 4);
  for (const bssid of [HOME_24, HOME_5, NEIGHBOUR]) assert.ok(store.apById(bssid), 'quem é ouvido sempre continua');
  assert.ok(store.apById('00:1d:aa:00:00:77'), 'uma rede marcada como minha não some por ter sido ouvida uma vez só');

  // abaixo do limite nada muda: quem foi ouvido uma vez fica os 90 s de sempre
  const calm = setup().store;
  calm.ingestScan(scanEvent([...steady(), ...fakes(1, 20)], { ts: T0 }));
  calm.ingestScan(scanEvent(steady(), { ts: T0 + 10_000 }));
  assert.equal(calm.get().aps.length, 23);
});
