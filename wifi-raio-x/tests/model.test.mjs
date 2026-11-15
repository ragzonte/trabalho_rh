import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ApTracker,
  HIDDEN_NAME,
  STALE_MS,
  asAp,
  groupByDevice,
  groupBySsid,
  normalizeAp,
  normalizeBssid,
  normalizeScan,
  parseMac,
  ssidStem,
} from '../app/js/core/model.js';
import { encodeIes } from '../app/js/core/ies.js';
import { ALL, TRUTH, TS, CW, apartment, apartmentTruth, mesh, meshTruth, office, wifi7, wifi7Truth, quietHouse, nextScan, makeAp } from './fixtures/scans.mjs';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'valor'}: esperado ${expected} ± ${tol}, veio ${actual}`);

/** Gerador determinístico (mulberry32) para embaralhar e sortear sem depender de Math.random. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Partição em forma comparável: grupos ordenados por dentro e por fora. */
const partition = (groups) => groups.map((g) => g.slice().sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
const devicesOf = (rawAps) => partition(groupByDevice(rawAps.map((a) => normalizeAp(a))).map((d) => d.bssids));

const byId = (event) => new Map(normalizeScan(event).map((ap) => [ap.id, ap]));

const AP_KEYS = [
  'ageMs',
  'band',
  'bssid',
  'channel',
  'distanceM',
  'fingerprint',
  'freq',
  'gen',
  'genSource',
  'hidden',
  'id',
  'ie',
  'ieee',
  'level',
  'mld',
  'name',
  'nss',
  'occ',
  'phy',
  'quality',
  'randomizedMac',
  'raw',
  'rssi',
  'rttResponder',
  'security',
  'seenAt',
  'ssid',
  'stale',
  'standard',
  'standardLabel',
  'stations',
  'utilization',
  'widthMHz',
];

// ---------------------------------------------------------------------------

describe('fixtures', () => {
  test('todo AP tem o formato do ScanAp de bridge.js', () => {
    const optional = { wifiStandard: 'number', rttResponder: 'boolean', passpoint: 'boolean', venueName: 'string', operatorName: 'string', mld: 'string', ies: 'object' };
    for (const [name, event] of Object.entries(ALL)) {
      assert.equal(typeof event.ts, 'number', name);
      assert.equal(typeof event.fresh, 'boolean', name);
      assert.ok(['request', 'system', 'cache'].includes(event.source), name);
      const seen = new Set();
      for (const ap of event.aps) {
        const where = `${name} ${ap.bssid}`;
        assert.match(ap.bssid, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/, where);
        assert.ok(!seen.has(ap.bssid), `BSSID repetido: ${where}`);
        seen.add(ap.bssid);
        assert.equal(typeof ap.ssid, 'string', where);
        assert.ok(Number.isInteger(ap.level) && ap.level < -20 && ap.level > -100, where);
        for (const key of ['frequency', 'channelWidth', 'centerFreq0', 'centerFreq1', 'ageMs']) assert.ok(Number.isInteger(ap[key]), `${where} ${key}`);
        assert.equal(typeof ap.capabilities, 'string', where);
        for (const key of Object.keys(ap)) {
          if (key in optional) assert.equal(typeof ap[key], optional[key], `${where} ${key}`);
          else assert.ok(['bssid', 'ssid', 'level', 'frequency', 'channelWidth', 'centerFreq0', 'centerFreq1', 'capabilities', 'ageMs'].includes(key), `campo fora do contrato: ${where} ${key}`);
        }
        if (ap.ies) {
          assert.ok(Array.isArray(ap.ies) && ap.ies.length > 0, where);
          for (const ie of ap.ies) assert.deepEqual(Object.keys(ie).sort(), ['ext', 'hex', 'id'], where);
        }
      }
    }
  });

  test('os cinco cenários têm o tamanho e a cara combinados', () => {
    assert.equal(apartment.aps.length, 28);
    assert.equal(quietHouse.aps.length, 3);
    assert.equal(mesh.aps.filter((a) => a.ssid === 'Casa Oliveira').length, 6);
    const aps = normalizeScan(apartment);
    const on = (band) => aps.filter((a) => a.band === band);
    assert.equal(on('2.4').length, 22);
    assert.equal(on('5').length, 6);
    // a maioria nos canais 1, 6 e 11; alguns no 3, 4, 8 e 9; três em 40 MHz; os 5 GHz em 36–48 e 149–161
    const count = (ch) => on('2.4').filter((a) => a.channel === ch).length;
    assert.deepEqual([1, 6, 11].map(count), [4, 8, 6]);
    assert.deepEqual([3, 4, 8, 9].map(count), [1, 1, 1, 1]);
    assert.equal(aps.filter((a) => a.widthMHz === 40).length, 3);
    assert.ok(on('5').every((a) => (a.channel >= 36 && a.channel <= 48) || (a.channel >= 149 && a.channel <= 161)));
    assert.equal(on('5').filter((a) => a.widthMHz === 80).length, 5);
    // com e sem elementos de informação
    assert.ok(aps.some((a) => a.ie !== null) && aps.some((a) => a.ie === null));
    // escritório: DFS, ocultas e BSS Load
    const off = normalizeScan(office);
    assert.ok(off.some((a) => a.occ.dfs) && off.some((a) => a.hidden) && off.some((a) => a.utilization !== null));
    assert.ok(off.some((a) => a.security.enterprise));
    // Wi-Fi 6E/7: 160 e 320 MHz nos 6 GHz
    const six = normalizeScan(wifi7).filter((a) => a.band === '6');
    assert.deepEqual(six.map((a) => a.widthMHz).sort((a, b) => a - b), [80, 160, 320]);
  });
});

// ---------------------------------------------------------------------------

describe('normalizeBssid / parseMac / ssidStem', () => {
  test('normaliza o BSSID e recusa o que não é MAC', () => {
    assert.equal(normalizeBssid('AA:BB:CC:DD:EE:0F'), 'aa:bb:cc:dd:ee:0f');
    assert.equal(normalizeBssid(' aa-bb-cc-dd-ee-0f '), 'aa:bb:cc:dd:ee:0f');
    for (const bad of ['', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:fg', 'aabbccddeeff', null, undefined, 12, {}, []]) assert.equal(normalizeBssid(bad), '');
    assert.deepEqual(parseMac('98:DA:c4:3b:7e:10'), [0x98, 0xda, 0xc4, 0x3b, 0x7e, 0x10]);
    assert.equal(parseMac('nada'), null);
    assert.equal(parseMac(null), null);
  });

  test('a raiz do nome ignora a marca de faixa', () => {
    const same = [
      ['Casa', 'Casa_5G'],
      ['Casa', 'Casa-5G'],
      ['Casa', 'Casa 5GHz'],
      ['Casa', 'Casa5G'],
      ['Casa', 'Casa_2.4G'],
      ['Casa', 'CASA 2,4GHz'],
      ['Souza2.4', 'Souza5G'],
      ['VIVOFIBRA-8A20', 'VIVOFIBRA-8A20-5G'],
      ['CLARO_2G4F1D2A', 'CLARO_5G4F1D2A'],
      ['NET_2GD4E5F6', 'NET_5GD4E5F6'],
      ['TIM_ULTRAFIBRA_55D0', 'TIM_ULTRAFIBRA_55D0_5G'],
      ['Gamer_5G-1', 'Gamer_5G-2'],
      ['Gamer', 'Gamer_6G'],
      ['Casa do Zé', 'Casa do Zé 5G'],
    ];
    for (const [a, b] of same) assert.equal(ssidStem(a), ssidStem(b), `${a} / ${b}`);
    assert.equal(ssidStem('Casa do Zé 5G'), 'casadozé');

    const different = [
      ['Casa', 'Casa-Convidados'],
      ['VIVOFIBRA-8A20', 'VIVOFIBRA-8A28'],
      ['Apto 54', 'Apto 5'],
      ['AP 302', 'AP 304'],
      ['Rede125G', 'Rede1'],
    ];
    for (const [a, b] of different) assert.notEqual(ssidStem(a), ssidStem(b), `${a} / ${b}`);
    // não confunde números do nome com marca de faixa
    assert.equal(ssidStem('Apto 54'), 'apto54');
    assert.equal(ssidStem('Mengão 2019'), 'mengão2019');
    // sem raiz utilizável
    for (const none of ['', '5G', '2.4GHz', 'A', '\u0000\u0000', null, 7, undefined]) assert.equal(ssidStem(none), null, String(none));
  });
});

// ---------------------------------------------------------------------------

describe('normalizeAp', () => {
  const aps = byId(apartment);

  test('roteador com elementos de informação: tudo preenchido', () => {
    const ap = aps.get('98:da:c4:3b:7e:10');
    assert.deepEqual(Object.keys(ap).sort(), AP_KEYS);
    assert.equal(ap.id, '98:da:c4:3b:7e:10');
    assert.equal(ap.bssid, ap.id);
    assert.equal(ap.ssid, 'Familia Souza');
    assert.equal(ap.name, 'Familia Souza');
    assert.equal(ap.hidden, false);
    assert.equal(ap.rssi, -48);
    assert.equal(ap.quality, 100);
    assert.equal(ap.level.key, 'excellent');
    assert.equal(ap.freq, 2437);
    assert.equal(ap.band, '2.4');
    assert.equal(ap.channel, 6);
    assert.equal(ap.widthMHz, 20);
    assert.deepEqual(ap.occ.segments, [{ lo: 2427, hi: 2447 }]);
    assert.equal(ap.gen, 6);
    assert.equal(ap.standard, 'Wi-Fi 6');
    assert.equal(ap.standardLabel, 'Wi-Fi 6 (802.11ax)');
    assert.equal(ap.ieee, '802.11ax');
    assert.equal(ap.phy, 'he');
    assert.equal(ap.genSource, 'android');
    assert.equal(ap.nss, 2);
    assert.equal(ap.stations, 5);
    near(ap.utilization, 0.21, 0.005, 'utilization');
    assert.equal(ap.ie.country, 'BR');
    assert.equal(ap.ie.bssColor, 12);
    // distância pelo modelo de dentro de casa: -40 dBm a 1 m, expoente 3 -> 10^(8/30) m
    near(ap.distanceM, Math.pow(10, 8 / 30), 0.01, 'distância');
    assert.equal(ap.ageMs, 120);
    assert.equal(ap.stale, false);
    assert.equal(ap.seenAt, TS - 120);
    assert.equal(ap.randomizedMac, false);
    assert.equal(ap.rttResponder, false);
    assert.equal(ap.mld, null);
    assert.equal(ap.fingerprint, 'oui:00:0c:e7');
    assert.equal(ap.raw, apartment.aps[0]);
  });

  test('a segurança é refinada com os elementos do beacon', () => {
    const own = aps.get('98:da:c4:3b:7e:10');
    assert.equal(own.security.label, 'WPA2/WPA3');
    assert.equal(own.security.fromIes, true);
    assert.equal(own.security.pmf, 'capable');
    assert.deepEqual(own.security.akms, ['PSK', 'SAE']);
    // sem elementos, fica a leitura do texto (e o PMF do WPA2 sem as flags é desconhecido)
    const claro = aps.get('f8:0b:be:4f:1d:28');
    assert.equal(claro.ie, null);
    assert.equal(claro.security.label, 'WPA2');
    assert.equal(claro.security.fromIes, false);
    assert.equal(claro.security.pmf, 'unknown');
    assert.equal(claro.security.wps, true);
    // ...a não ser que se saiba que o celular é Android 14+, que sempre escreve as flags
    assert.equal(normalizeAp(claro.raw, { sdk: 34 }).security.pmf, 'none');
    // o TKIP ainda ligado aparece nos dois caminhos
    assert.ok(aps.get('b0:95:75:c3:0a:66').security.issues.some((i) => i.code === 'tkip-mixed'));
    assert.ok(aps.get('fc:52:8d:d4:e5:f0').security.issues.some((i) => i.code === 'tkip-mixed'));
    assert.equal(aps.get('f8:0b:be:4f:1d:29').security.open, true);
  });

  test('geração: Android, depois os elementos, depois o mínimo que explica a faixa e a largura', () => {
    // sem wifiStandard e sem elementos (celular antigo)
    const net24 = aps.get('fc:52:8d:d4:e5:f0');
    assert.equal(net24.genSource, 'inferred');
    assert.equal(net24.gen, 4);
    assert.equal(net24.standardLabel, 'Wi-Fi 4 ou mais novo (estimado)');
    assert.equal(net24.nss, null);
    assert.equal(net24.stations, null);
    assert.equal(net24.utilization, null);
    assert.equal(net24.fingerprint, null);
    assert.equal(net24.widthMHz, 40);
    assert.deepEqual(net24.occ.channels, [1, 5]);
    // 80 MHz só existe do Wi-Fi 5 em diante
    const wide = normalizeAp({ bssid: '02:00:00:00:00:01', ssid: 'x', level: -60, frequency: 5180, channelWidth: 2, centerFreq0: 5210 });
    assert.equal(wide.gen, 5);
    assert.equal(wide.standardLabel, 'Wi-Fi 5 ou mais novo (estimado)');
    // 6 GHz só existe do Wi-Fi 6E em diante; 320 MHz, só no Wi-Fi 7
    assert.equal(normalizeAp({ bssid: '02:00:00:00:00:02', level: -60, frequency: 5975, channelWidth: 2 }).standard, 'Wi-Fi 6E');
    const be = normalizeAp({ bssid: '02:00:00:00:00:03', level: -60, frequency: 6135, channelWidth: 5, centerFreq0: 6105 });
    assert.equal(be.gen, 7);
    assert.equal(be.standardLabel, 'Wi-Fi 7 (estimado)');
    // wifiStandard = 0 (desconhecido) cai para os elementos
    const ies = encodeIes({ frequency: 5180, widthMhz: 80, ht: { nss: 3 }, vht: { nss: 3 }, he: { nss: 4, bssColor: 1 } });
    const fromIes = normalizeAp({ bssid: '02:00:00:00:00:04', level: -60, frequency: 5180, channelWidth: 2, centerFreq0: 5210, wifiStandard: 0, ies });
    assert.equal(fromIes.genSource, 'ies');
    assert.equal(fromIes.gen, 6);
    assert.equal(fromIes.nss, 4);
    // Android antigo chama um roteador Wi-Fi 7 de 11ax: os elementos corrigem
    const eht = encodeIes({ frequency: 5180, widthMhz: 80, ht: { nss: 2 }, vht: { nss: 2 }, he: { nss: 2 }, eht: { nss: 2 } });
    const upgraded = normalizeAp({ bssid: '02:00:00:00:00:05', level: -60, frequency: 5180, channelWidth: 2, centerFreq0: 5210, wifiStandard: 6, ies: eht });
    assert.equal(upgraded.gen, 7);
    assert.equal(upgraded.genSource, 'ies');
    assert.equal(upgraded.standard, 'Wi-Fi 7');
    // ...mas os elementos nunca rebaixam o que o Android disse
    const kept = normalizeAp({ bssid: '02:00:00:00:00:06', level: -60, frequency: 2437, channelWidth: 0, wifiStandard: 6, ies: encodeIes({ frequency: 2437, ht: { nss: 2 } }) });
    assert.equal(kept.gen, 6);
    assert.equal(kept.genSource, 'android');
    // legado, 60 GHz e faixa desconhecida
    assert.equal(normalizeAp({ bssid: '02:00:00:00:00:07', level: -60, frequency: 2412, wifiStandard: 1 }).gen, 3);
    const wigig = normalizeAp({ bssid: '02:00:00:00:00:08', level: -60, frequency: 60480 });
    assert.equal(wigig.band, '60');
    assert.equal(wigig.gen, null);
    assert.equal(wigig.standard, 'WiGig');
    const lost = normalizeAp({ bssid: '02:00:00:00:00:09', level: -60, frequency: 0 });
    assert.equal(lost.gen, null);
    assert.equal(lost.genSource, null);
    assert.equal(lost.standardLabel, 'Wi-Fi (padrão não informado)');
  });

  test('Wi-Fi 7 completo: 320 MHz, MLD, RTT', () => {
    const ap = byId(wifi7).get(wifi7Truth.own.b6);
    assert.equal(ap.band, '6');
    assert.equal(ap.channel, 37);
    assert.equal(ap.widthMHz, 320);
    assert.deepEqual(ap.occ.segments, [{ lo: 5945, hi: 6265 }]);
    assert.equal(ap.occ.psc, true);
    assert.equal(ap.gen, 7);
    assert.equal(ap.standardLabel, 'Wi-Fi 7 (802.11be)');
    assert.equal(ap.mld, wifi7Truth.own.mld);
    assert.equal(ap.rttResponder, true);
    assert.equal(ap.security.label, 'WPA3');
    assert.equal(ap.security.pmf, 'required');
    assert.equal(ap.ie.mlo, true);
    // 160 MHz nos 5 GHz com os dois centros que o Android manda
    const five = byId(wifi7).get(wifi7Truth.own.b5);
    assert.equal(five.widthMHz, 160);
    assert.deepEqual(five.occ.segments, [{ lo: 5170, hi: 5330 }]);
    assert.equal(five.occ.dfs, true);
  });

  test('Android sem CHANNEL_WIDTH_320MHZ: o EHT Operation devolve a largura de verdade', () => {
    const raw = byId(wifi7).get(wifi7Truth.own.b6).raw;
    // como um Android 12 entregaria o mesmo AP: 160 MHz, 11ax e sem o campo mld
    const old = { ...raw, channelWidth: CW.W160, centerFreq0: 6185, centerFreq1: 0, wifiStandard: 6 };
    delete old.mld;
    const ap = normalizeAp(old);
    assert.equal(ap.widthMHz, 320);
    assert.deepEqual(ap.occ.segments, [{ lo: 5945, hi: 6265 }]);
    assert.equal(ap.occ.approx, false);
    assert.equal(ap.gen, 7);
    assert.equal(ap.mld, wifi7Truth.own.mld); // veio do elemento Multi-Link
    // sem os elementos não há como saber: fica o que o Android disse
    assert.equal(normalizeAp({ ...old, ies: undefined }).widthMHz, 160);
    // um AP de 160 MHz de verdade não é alargado
    assert.equal(byId(wifi7).get('c8:be:19:5a:9d:42').widthMHz, 160);
  });

  test('rede oculta, MAC sorteado e leitura velha', () => {
    const hidden = aps.get('28:6e:d4:5b:c2:e1');
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.ssid, '');
    assert.equal(hidden.name, HIDDEN_NAME);
    assert.equal(HIDDEN_NAME, '(rede oculta)');
    for (const ssid of ['\u0000\u0000\u0000\u0000', '<unknown ssid>', undefined, null, 42]) {
      const ap = normalizeAp({ bssid: '02:00:00:00:00:01', ssid, level: -60, frequency: 2412 });
      assert.equal(ap.hidden, true, String(ssid));
      assert.equal(ap.ssid, '');
      assert.equal(ap.name, HIDDEN_NAME);
    }
    // espaços fazem parte do nome
    assert.equal(normalizeAp({ bssid: '02:00:00:00:00:01', ssid: ' Casa ' }).ssid, ' Casa ');

    assert.equal(aps.get('3e:5a:91:0c:44:d2').randomizedMac, true);
    assert.equal(byId(mesh).get('1a:eb:b6:8d:21:51').randomizedMac, true);
    assert.equal(aps.get('98:da:c4:3b:7e:10').randomizedMac, false);

    const old = aps.get('84:c9:b2:7f:30:15');
    assert.equal(old.ageMs, 41000);
    assert.equal(old.stale, true);
    assert.equal(old.seenAt, TS - 41000);
    assert.equal(STALE_MS, 10000);
    assert.equal(normalizeAp({ bssid: '02:00:00:00:00:01', ageMs: 10000 }).stale, false);
    assert.equal(normalizeAp({ bssid: '02:00:00:00:00:01', ageMs: 10001 }).stale, true);
  });

  test('ts e now: a idade acompanha o relógio', () => {
    const raw = { bssid: '02:00:00:00:00:01', ssid: 'x', level: -60, frequency: 2412, ageMs: 4000 };
    // sem relógio nenhum: só a idade crua
    const bare = normalizeAp(raw);
    assert.equal(bare.ageMs, 4000);
    assert.equal(bare.seenAt, null);
    // só `now`: é o instante da leitura
    const atNow = normalizeAp(raw, { now: 1_000_000 });
    assert.equal(atNow.ageMs, 4000);
    assert.equal(atNow.seenAt, 996_000);
    // lista lida em `ts`, tela redesenhada 7 s depois
    const later = normalizeAp(raw, { ts: 1_000_000, now: 1_007_000 });
    assert.equal(later.seenAt, 996_000);
    assert.equal(later.ageMs, 11_000);
    assert.equal(later.stale, true);
    // relógio torto não produz idade negativa
    assert.equal(normalizeAp({ ...raw, ageMs: -50 }, { ts: 1_000_000 }).ageMs, 0);
    assert.equal(normalizeAp(raw, { ts: 1_000_000, now: 900_000 }).ageMs, 0);
    // sem ageMs
    const noAge = normalizeAp({ bssid: '02:00:00:00:00:01' }, { ts: 1_000_000 });
    assert.equal(noAge.ageMs, null);
    assert.equal(noAge.seenAt, null);
    assert.equal(noAge.stale, false);
  });

  test('BSSID em maiúsculas é normalizado; rttResponder vem do Android ou dos elementos', () => {
    const ap = normalizeAp({ bssid: 'AA:BB:CC:00:11:22', ssid: 'x', level: -70, frequency: 5180, rttResponder: true });
    assert.equal(ap.id, 'aa:bb:cc:00:11:22');
    assert.equal(ap.rttResponder, true);
    const viaIe = normalizeAp({ bssid: 'aa:bb:cc:00:11:22', level: -70, frequency: 5180, ies: encodeIes({ frequency: 5180, ht: { nss: 2 }, ftmResponder: true }) });
    assert.equal(viaIe.rttResponder, true);
    assert.equal(normalizeAp({ bssid: 'aa:bb:cc:00:11:22', level: -70, frequency: 5180, ies: [] }).ie, null);
    // "impressão digital": modelo do WPS quando existe
    assert.equal(byId(apartment).get('e0:ca:94:5c:8a:20').fingerprint, 'wps:Askey|RTF8115VW|');
  });

  test('entrada torta nunca lança exceção e devolve o formato completo', () => {
    const junk = [null, undefined, 0, 'texto', [], {}, { bssid: 5, ssid: {}, level: 'forte', frequency: 'x', channelWidth: null, capabilities: 9, ageMs: 'ontem', ies: 'zz', wifiStandard: {}, mld: 3 },
      { bssid: 'zz:zz', level: NaN, frequency: Infinity, ies: [null, 1, { id: 'a' }, { id: 45, hex: 'zz' }, { id: 255, ext: 35, hex: '00' }] },
      { bssid: '02:00:00:00:00:01', level: -200, frequency: -1, channelWidth: 99, centerFreq0: 1e9, capabilities: '[[[[', ageMs: -5 }];
    for (const raw of junk) {
      for (const options of [undefined, null, 7, { now: 'já', ts: {}, sdk: 'x' }, { now: 1e12 }]) {
        const ap = normalizeAp(raw, options);
        assert.deepEqual(Object.keys(ap).sort(), AP_KEYS);
        assert.equal(typeof ap.id, 'string');
        assert.equal(typeof ap.name, 'string');
        assert.ok(ap.rssi === null || Number.isFinite(ap.rssi));
        assert.ok(Array.isArray(ap.occ.segments));
        assert.equal(typeof ap.security.label, 'string');
        assert.equal(typeof ap.standardLabel, 'string');
        assert.equal(typeof ap.stale, 'boolean');
      }
    }
    const empty = normalizeAp(null);
    assert.equal(empty.id, '');
    assert.equal(empty.rssi, null);
    assert.equal(empty.band, null);
    assert.equal(empty.distanceM, null);
    assert.equal(empty.security.known, false);
  });

  test('asAp reaproveita o que já está normalizado', () => {
    const ap = aps.get('98:da:c4:3b:7e:10');
    assert.equal(asAp(ap), ap);
    assert.equal(asAp(ap.raw).id, ap.id);
    assert.equal(asAp(null).id, '');
  });

  test('normalizeScan: um Ap por BSSID válido, o mais novo quando repete', () => {
    const list = normalizeScan(apartment);
    assert.equal(list.length, apartment.aps.length);
    assert.ok(list.every((ap) => ap.seenAt === apartment.ts - ap.raw.ageMs));
    const event = {
      ts: 5000,
      aps: [
        { bssid: '02:00:00:00:00:01', level: -70, frequency: 2412, ageMs: 900 },
        { bssid: '02:00:00:00:00:01', level: -60, frequency: 2412, ageMs: 100 },
        { bssid: 'lixo', level: -60 },
        null,
        'x',
      ],
    };
    const out = normalizeScan(event, { now: 6000 });
    assert.equal(out.length, 1);
    assert.equal(out[0].rssi, -60);
    assert.equal(out[0].ageMs, 1100);
    for (const bad of [null, undefined, 3, 'x', {}, { aps: 'x' }, { aps: null, ts: 'y' }]) assert.deepEqual(normalizeScan(bad), []);
  });
});

// ---------------------------------------------------------------------------

describe('groupByDevice', () => {
  test('acerta os aparelhos de todos os cenários', () => {
    for (const [name, event] of Object.entries(ALL)) {
      assert.deepEqual(devicesOf(event.aps), partition(TRUTH[name].devices), name);
    }
  });

  test('o resultado não depende da ordem da lista', () => {
    const random = rng(20251115);
    for (const [name, event] of Object.entries(ALL)) {
      const reference = groupByDevice(normalizeScan(event));
      for (let round = 0; round < 12; round++) {
        const again = groupByDevice(shuffled(normalizeScan(event), random));
        assert.deepEqual(again.map((d) => d.id), reference.map((d) => d.id), name);
        assert.deepEqual(again.map((d) => d.bssids), reference.map((d) => d.bssids), name);
      }
    }
  });

  test('formato de cada aparelho', () => {
    const devices = groupByDevice(normalizeScan(apartment));
    // do sinal mais forte para o mais fraco
    for (let i = 1; i < devices.length; i++) assert.ok(devices[i - 1].bestRssi >= devices[i].bestRssi);
    const own = devices[0];
    assert.deepEqual(Object.keys(own).sort(), ['aps', 'bands', 'bestRssi', 'bssids', 'id', 'ssids']);
    assert.equal(own.id, '98:da:c4:3b:7e:0f'); // o menor BSSID
    assert.deepEqual(own.bssids, ['98:da:c4:3b:7e:10', '98:da:c4:3b:7e:0f']); // 2,4 GHz antes de 5 GHz
    assert.deepEqual(own.ssids, ['Familia Souza', 'Familia Souza_5G']);
    assert.deepEqual(own.bands, ['2.4', '5']);
    assert.equal(own.bestRssi, -48);
    assert.deepEqual(own.aps.map((ap) => ap.id), own.bssids);
    // cada BSSID aparece uma vez só
    const all = devices.flatMap((d) => d.bssids);
    assert.equal(all.length, apartment.aps.length);
    assert.equal(new Set(all).size, all.length);
    // a Claro com a rede pública no mesmo rádio: três BSSIDs, dois nomes visíveis... e a rede oculta não entra em `ssids`
    const claro = devices.find((d) => d.bssids.includes('f8:0b:be:4f:1d:29'));
    assert.deepEqual(claro.ssids, ['CLARO_2G4F1D2A', '#NET-CLARO-WIFI', 'CLARO_5G4F1D2A']);
    const node = groupByDevice(normalizeScan(mesh)).find((d) => d.bssids.includes('1a:eb:b6:8d:21:51'));
    assert.deepEqual(node.ssids, ['Casa Oliveira']);
    // com MLO, o id é o endereço do AP MLD; se só há BSSIDs "virtuais", vale o menor deles
    assert.equal(groupByDevice(normalizeScan(wifi7))[0].id, wifi7Truth.own.mld);
    assert.equal(groupByDevice(normalizeScan(apartment)).find((d) => d.bssids.includes('3e:5a:91:0c:44:d2')).id, '3e:5a:91:0c:44:d2');
  });

  // --- lotes de operadora -------------------------------------------------

  const E0 = 'e0:ca:94:5c:8a';
  const batch = (names, ies) => [
    makeAp(`${E0}:20`, names[0], -62, 2412, ies ? { ies: ies(2412) } : {}),
    makeAp(`${E0}:24`, names[1], -71, 5220, ies ? { ies: ies(5220) } : {}),
    makeAp(`${E0}:28`, names[2], -74, 2462, ies ? { ies: ies(2462) } : {}),
    makeAp(`${E0}:2c`, names[3], -83, 5745, ies ? { ies: ies(5745) } : {}),
  ];
  const sameModel = (frequency) => encodeIes({ frequency, ht: { nss: 2 }, wps: { manufacturer: 'Askey', model: 'RTF8115VW' } });

  test('lote da operadora com nomes de fábrica: cada vizinho fica com a sua caixa', () => {
    const aps = batch(['VIVOFIBRA-8A20', 'VIVOFIBRA-8A20-5G', 'VIVOFIBRA-8A28', 'VIVOFIBRA-8A28-5G'], sameModel);
    assert.deepEqual(devicesOf(aps), [[`${E0}:20`, `${E0}:24`], [`${E0}:28`, `${E0}:2c`]]);
    // só um rádio de cada vizinho no ar, a 4 endereços um do outro e com o mesmo modelo: não junta
    assert.deepEqual(devicesOf([aps[1], aps[2]]), [[`${E0}:24`], [`${E0}:28`]]);
  });

  test('lote com nomes trocados e sem elementos: endereços a 4 de distância não bastam', () => {
    const aps = batch(['Casa da Ana', 'Quarto', 'Bia', 'Escritorio']);
    assert.deepEqual(devicesOf(aps), [[`${E0}:20`], [`${E0}:24`], [`${E0}:28`], [`${E0}:2c`]]);
  });

  test('lote com nomes trocados e o mesmo modelo: vale a explicação mais econômica, se for única', () => {
    const aps = batch(['Casa da Ana', 'Quarto', 'Bia', 'Escritorio'], sameModel);
    // quatro rádios: só um jeito de formar duas caixas com os pares mais próximos
    assert.deepEqual(devicesOf(aps), [[`${E0}:20`, `${E0}:24`], [`${E0}:28`, `${E0}:2c`]]);
    // três rádios: o 5 GHz do meio fica a 4 dos dois 2,4 GHz. Empate: ninguém é juntado
    assert.deepEqual(devicesOf(aps.slice(0, 3)), [[`${E0}:20`], [`${E0}:24`], [`${E0}:28`]]);
    // sozinho, sem concorrência, o par da mesma caixa é aceito
    assert.deepEqual(devicesOf(aps.slice(0, 2)), [[`${E0}:20`, `${E0}:24`]]);
  });

  test('endereços colados (até 2) entre faixas dispensam segundo indício, se não houver disputa', () => {
    const a = makeAp('50:c7:bf:11:22:30', 'Casa', -55, 2437);
    const b = makeAp('50:c7:bf:11:22:31', 'Trabalho', -63, 5180);
    const c = makeAp('50:c7:bf:11:22:32', 'Vizinho', -80, 2412);
    assert.deepEqual(devicesOf([a, b]), [['50:c7:bf:11:22:30', '50:c7:bf:11:22:31']]);
    // com um terceiro rádio igualmente perto do 5 GHz, não dá para saber de quem ele é
    assert.deepEqual(devicesOf([a, b, c]), [['50:c7:bf:11:22:30'], ['50:c7:bf:11:22:31'], ['50:c7:bf:11:22:32']]);
    // a 3 de distância e sem mais nada: não
    assert.equal(devicesOf([a, makeAp('50:c7:bf:11:22:33', 'Trabalho', -63, 5180)]).length, 2);
  });

  test('mesmo canal, mesmo lote, sinal parecido e nomes "irmãos": são dois vizinhos', () => {
    const aps = [makeAp('c0:25:e9:44:10:3e', 'AP 302', -64, 2437), makeAp('c0:25:e9:44:10:40', 'AP 304', -66, 2437)];
    assert.equal(devicesOf(aps).length, 2);
    const multilaser = [makeAp('00:e0:4c:0b:77:a0', 'Multilaser_2.4G_0B77A0', -70, 2437), makeAp('00:e0:4c:0b:77:a2', 'Multilaser_2.4G_0B77A2', -70, 2437)];
    assert.equal(devicesOf(multilaser).length, 2);
    // irmãos entre faixas também não se juntam, por mais colados que estejam
    const cross = [makeAp('00:e0:4c:0b:77:a0', 'Rede1', -60, 2437), makeAp('00:e0:4c:0b:77:a1', 'Rede2', -66, 5180)];
    assert.equal(devicesOf(cross).length, 2);
  });

  // --- redes de convidados -------------------------------------------------

  test('redes virtuais com o primeiro octeto trocado são a mesma caixa', () => {
    const aps = [
      makeAp('50:c7:bf:11:22:33', 'Casa', -50, 2437),
      makeAp('52:c7:bf:11:22:33', 'Casa-Convidados', -51, 2437),
      makeAp('56:c7:bf:11:22:33', '', -50, 2437),
      makeAp('50:c7:bf:11:22:34', 'Casa_5G', -58, 5180),
      makeAp('52:c7:bf:11:22:34', 'Casa-Convidados_5G', -58, 5180),
    ];
    assert.equal(devicesOf(aps).length, 1);
    // mesmo com sinais diferentes e canais diferentes: cinco octetos iguais não são acaso
    const odd = [makeAp('50:c7:bf:11:22:33', 'A', -50, 2437), makeAp('5a:c7:bf:11:22:33', 'B', -80, 2462)];
    assert.equal(devicesOf(odd).length, 1);
  });

  test('redes do mesmo rádio em MACs seguidos: mesma frequência e mesmo sinal', () => {
    const main = makeAp('b0:95:75:40:aa:a0', 'Padaria', -55, 2462);
    const guest = makeAp('b0:95:75:40:aa:a1', 'Clientes', -56, 2462, { capabilities: '[ESS]' });
    const third = makeAp('b0:95:75:40:aa:a3', '', -54, 2462);
    assert.deepEqual(devicesOf([main, guest, third]), [['b0:95:75:40:aa:a0', 'b0:95:75:40:aa:a1', 'b0:95:75:40:aa:a3']]);
    // sinal bem diferente no mesmo canal: são dois rádios
    assert.equal(devicesOf([main, { ...guest, level: -68 }]).length, 2);
    // largura diferente: também
    assert.equal(devicesOf([main, { ...guest, channelWidth: CW.W40, centerFreq0: 2452 }]).length, 2);
    // mesmo sinal, mas a 4 endereços (um bloco de fábrica inteiro adiante): não
    assert.equal(devicesOf([main, makeAp('b0:95:75:40:aa:a4', 'Clientes', -56, 2462)]).length, 2);
    // mesmo sinal, mas em outro canal da mesma faixa: um rádio só fala num canal
    assert.equal(devicesOf([main, { ...guest, frequency: 2437 }]).length, 2);
    // leituras de momentos diferentes toleram mais variação de sinal (até 8 dB)
    assert.equal(devicesOf([main, { ...guest, level: -62, ageMs: 30000 }]).length, 1);
    assert.equal(devicesOf([main, { ...guest, level: -62 }]).length, 2);
    // sem sinal não há como comparar
    assert.equal(devicesOf([main, { ...guest, level: undefined }]).length, 2);
  });

  test('a rede pública da operadora em várias caixas não as junta', () => {
    const net = groupByDevice(normalizeScan(apartment)).filter((d) => d.ssids.includes('#NET-CLARO-WIFI'));
    assert.equal(net.length, 2);
  });

  // --- mesh -----------------------------------------------------------------

  const node = (last, level, extra = {}) => [
    makeAp(`14:eb:b6:8d:21:${last.toString(16).padStart(2, '0')}`, 'Casa Oliveira', level, 2412, extra),
    { ...makeAp(`14:eb:b6:8d:21:${(last + 1).toString(16).padStart(2, '0')}`, 'Casa Oliveira', level - 8, 5220, extra), channelWidth: CW.W80, centerFreq0: 5210 },
  ];

  test('nós de mesh com MACs seguidos: cada nó é um aparelho', () => {
    const aps = [0x50, 0x54, 0x58, 0x5c, 0x60].flatMap((last, i) => node(last, -45 - 9 * i));
    const devices = devicesOf(aps);
    assert.equal(devices.length, 5);
    assert.ok(devices.every((d) => d.length === 2 && parseInt(d[1].slice(-2), 16) - parseInt(d[0].slice(-2), 16) === 1));
  });

  test('dois nós à mesma distância (mesmo sinal, mesmo canal, mesmo nome) continuam sendo dois', () => {
    const aps = [...node(0x50, -60), ...node(0x54, -60)];
    assert.deepEqual(devicesOf(aps), [['14:eb:b6:8d:21:50', '14:eb:b6:8d:21:51'], ['14:eb:b6:8d:21:54', '14:eb:b6:8d:21:55']]);
  });

  test('nó com um rádio fora do ar: o 2,4 GHz que sobrou não é colado no nó vizinho', () => {
    const aps = [...node(0x50, -50), node(0x54, -65)[0]];
    assert.deepEqual(devicesOf(aps), [['14:eb:b6:8d:21:50', '14:eb:b6:8d:21:51'], ['14:eb:b6:8d:21:54']]);
  });

  test('a rede oculta entre os nós (primeiro octeto trocado) fica no nó certo', () => {
    const nodes = groupByDevice(normalizeScan(mesh)).filter((d) => d.ssids.includes('Casa Oliveira'));
    assert.deepEqual(partition(nodes.map((d) => d.bssids)), partition(meshTruth.nodes));
  });

  // --- tri-band ---------------------------------------------------------------

  const wide = (ap, centerFreq0) => ({ ...ap, channelWidth: CW.W80, centerFreq0 });

  test('roteador tri-band: os dois rádios de 5 GHz (parte baixa e parte alta) são a mesma caixa', () => {
    const aps = [
      makeAp('04:d9:f5:10:20:30', 'Gamer', -50, 2437),
      wide(makeAp('04:d9:f5:10:20:31', 'Gamer_5G-1', -57, 5180), 5210),
      wide(makeAp('04:d9:f5:10:20:32', 'Gamer_5G-2', -58, 5745), 5775),
    ];
    assert.equal(devicesOf(aps).length, 1);
    // sem nome parecido, dois rádios de 5 GHz não se juntam só pelo endereço
    const renamed = [wide(makeAp('04:d9:f5:10:20:31', 'Sala', -57, 5180), 5210), wide(makeAp('04:d9:f5:10:20:32', 'Jogos', -58, 5745), 5775)];
    assert.equal(devicesOf(renamed).length, 2);
    // e dois canais na mesma metade dos 5 GHz nunca
    const sameHalf = [wide(makeAp('04:d9:f5:10:20:31', 'Gamer', -57, 5180), 5210), wide(makeAp('04:d9:f5:10:20:32', 'Gamer', -58, 5260), 5290)];
    assert.equal(devicesOf(sameHalf).length, 2);
  });

  test('kit mesh tri-band: três rádios por nó', () => {
    const tri = (last, level) => [
      makeAp(`9c:c9:eb:00:11:${last.toString(16)}`, 'Mesh3', level, 2412),
      wide(makeAp(`9c:c9:eb:00:11:${(last + 1).toString(16)}`, 'Mesh3', level - 7, 5180), 5210),
      wide(makeAp(`9c:c9:eb:00:11:${(last + 2).toString(16)}`, 'Mesh3', level - 8, 5745), 5775),
    ];
    const devices = devicesOf([...tri(0x10, -48), ...tri(0x14, -66)]);
    assert.deepEqual(devices, [
      ['9c:c9:eb:00:11:10', '9c:c9:eb:00:11:11', '9c:c9:eb:00:11:12'],
      ['9c:c9:eb:00:11:14', '9c:c9:eb:00:11:15', '9c:c9:eb:00:11:16'],
    ]);
  });

  // --- empresas ----------------------------------------------------------------

  test('fila de APs corporativos com blocos de MAC vizinhos: um aparelho por AP', () => {
    const ch24 = [2412, 2437, 2462];
    const ch5 = [[5180, 5190], [5260, 5270], [5500, 5510], [5745, 5755]];
    const aps = [];
    const mac = (n) => `24:de:c6:8a:${(0x30 + (n >> 8)).toString(16)}:${(n & 0xff).toString(16).padStart(2, '0')}`;
    for (let k = 0; k < 12; k++) {
      const level = -45 - 3 * k;
      aps.push(makeAp(mac(0x20 * k), 'Corp', level, ch24[k % 3]));
      aps.push({ ...makeAp(mac(0x20 * k + 0x10), 'Corp', level - 6, ch5[k % 4][0]), channelWidth: CW.W40, centerFreq0: ch5[k % 4][1] });
    }
    const devices = devicesOf(aps);
    assert.equal(devices.length, 12);
    for (let k = 0; k < 12; k++) assert.deepEqual(devices[k], [mac(0x20 * k), mac(0x20 * k + 0x10)]);
  });

  test('UniFi: os rádios diferem no quarto octeto; com o mesmo nome, é a mesma caixa', () => {
    const a = makeAp('78:8a:20:ab:bb:cc', 'Empresa', -55, 2437);
    const b = makeAp('78:8a:20:ac:bb:cc', 'Empresa', -61, 5180);
    assert.equal(devicesOf([a, b]).length, 1);
    assert.equal(devicesOf([a, { ...b, ssid: 'Outra coisa' }]).length, 2);
    assert.equal(devicesOf([a, makeAp('78:8a:20:b5:bb:cc', 'Empresa', -61, 5180)]).length, 2);
  });

  // --- certeza: MLD e RNR ------------------------------------------------------

  test('Wi-Fi 7 e 6E: o endereço do MLD e o RNR juntam rádios com MACs sem parentesco', () => {
    const devices = groupByDevice(normalizeScan(wifi7));
    const own = devices.find((d) => d.bssids.includes(wifi7Truth.own.b6));
    assert.deepEqual(own.bands, ['2.4', '5', '6']);
    const neighbour = devices.find((d) => d.bssids.includes('c8:be:19:5a:9d:42'));
    assert.deepEqual(neighbour.bssids, ['c8:be:19:5a:07:10', 'c8:be:19:5a:07:11', 'c8:be:19:5a:9d:42']);
    // sem os elementos (celular antigo), o 6 GHz do vizinho não tem como ser ligado aos outros
    const bare = wifi7.aps.map(({ ies, mld, ...rest }) => rest);
    const blind = devicesOf(bare);
    assert.ok(blind.some((d) => d.length === 1 && d[0] === 'c8:be:19:5a:9d:42'));
    assert.ok(blind.some((d) => d.length === 3 && d.includes(wifi7Truth.own.b6))); // MACs seguidos e o mesmo nome
  });

  test('o MLD de um BSSID pode ser o próprio BSSID de outro rádio', () => {
    const aps = [
      makeAp('a0:00:00:00:00:01', 'X', -50, 2437),
      { ...makeAp('c4:11:22:33:44:55', 'Y', -70, 5180), mld: 'a0:00:00:00:00:01' },
    ];
    assert.equal(devicesOf(aps).length, 1);
    // a certeza passa por cima dos vetos (mesma faixa, canais diferentes)
    const sameBand = [{ ...makeAp('a0:00:00:00:00:01', 'X', -50, 5180), mld: 'a2:00:00:00:00:09' }, { ...makeAp('c4:11:22:33:44:55', 'X', -70, 5260), mld: 'a2:00:00:00:00:09' }];
    assert.equal(devicesOf(sameBand).length, 1);
  });

  // --- robustez ----------------------------------------------------------------

  test('fabricantes diferentes nunca se juntam; celular com roteador nas duas faixas é um aparelho', () => {
    const aps = [
      makeAp('50:c7:bf:11:22:30', 'Casa', -55, 2437),
      makeAp('50:c7:c0:11:22:31', 'Casa', -63, 5180), // terceiro octeto diferente
      makeAp('50:c8:bf:11:22:31', 'Casa', -63, 5180), // segundo octeto diferente
      makeAp('50:c7:bf:12:22:65', 'Casa', -63, 5180), // longe demais
    ];
    assert.equal(devicesOf(aps).length, 4);
    // MACs sorteados, mas seguidos: o mesmo celular anunciando em 2,4 e 5 GHz
    const phone = [makeAp('3e:5a:91:0c:44:d2', 'Galaxy de Ana', -57, 2437), makeAp('3e:5a:91:0c:44:d3', 'Galaxy de Ana', -62, 5745)];
    assert.equal(devicesOf(phone).length, 1);
    assert.equal(devicesOf([phone[0], makeAp('7a:10:c3:55:0e:91', 'iPhone de Bia', -60, 5745)]).length, 2);
  });

  test('BSSID repetido, endereço inválido e lixo', () => {
    const a = makeAp('50:c7:bf:11:22:30', 'Casa', -55, 2437);
    const twice = groupByDevice([normalizeAp(a), normalizeAp({ ...a, level: -60 })]);
    assert.equal(twice.length, 1);
    assert.equal(twice[0].aps.length, 2);

    const broken = groupByDevice([normalizeAp({ bssid: 'x', ssid: 'A', level: -50 }), normalizeAp({ ssid: 'B' }), normalizeAp(a)]);
    assert.equal(broken.length, 3);
    assert.deepEqual(broken.map((d) => d.bssids.length).sort(), [0, 0, 1]);
    assert.equal(new Set(broken.map((d) => d.id)).size, 3);

    for (const bad of [null, undefined, 5, 'x', {}, [null, 1, 'x', undefined]]) assert.deepEqual(groupByDevice(bad), []);
    // aceita ScanAp cru e objetos pela metade
    assert.equal(groupByDevice(apartment.aps).length, apartmentTruth.devices.length);
    assert.equal(groupByDevice([{}, { bssid: '02:00:00:00:00:01' }, { ie: { colocated: 'x' }, mld: 7 }]).length, 3);
  });

  test('MACs aleatórios próximos com dados aleatórios não derrubam nada', () => {
    const random = rng(77);
    const pick = (list) => list[Math.floor(random() * list.length)];
    for (let round = 0; round < 60; round++) {
      const aps = [];
      const n = 2 + Math.floor(random() * 22);
      for (let i = 0; i < n; i++) {
        const last = Math.floor(random() * 48).toString(16).padStart(2, '0');
        const first = pick(['50', '52', '56']);
        aps.push({
          bssid: `${first}:c7:bf:11:${pick(['22', '23'])}:${last}`,
          ssid: pick(['Casa', 'Casa_5G', 'Rede1', 'Rede2', '', 'Outro']),
          level: -40 - Math.floor(random() * 50),
          frequency: pick([2412, 2437, 2462, 5180, 5745, 5975]),
          channelWidth: pick([0, 1, 2]),
          centerFreq0: 0,
          centerFreq1: 0,
          capabilities: '[ESS]',
          ageMs: Math.floor(random() * 20000),
        });
      }
      const devices = groupByDevice(aps.map((a) => normalizeAp(a)));
      assert.equal(devices.reduce((sum, d) => sum + d.aps.length, 0), aps.length);
      const again = groupByDevice(shuffled(aps, random).map((a) => normalizeAp(a)));
      assert.deepEqual(partition(again.map((d) => d.bssids)), partition(devices.map((d) => d.bssids)));
    }
  });
});

// ---------------------------------------------------------------------------

describe('groupBySsid', () => {
  test('prédio: redes pelo nome e pela família de segurança', () => {
    const nets = groupBySsid(normalizeScan(apartment));
    const get = (key) => nets.find((n) => n.key === key);
    assert.deepEqual(Object.keys(nets[0]).sort(), ['aps', 'bands', 'best', 'devices', 'hidden', 'key', 'mesh', 'name', 'security', 'ssid']);
    // da mais forte para a mais fraca
    for (let i = 1; i < nets.length; i++) assert.ok(nets[i - 1].best.rssi >= nets[i].best.rssi);
    assert.equal(nets[0].ssid, 'Familia Souza');
    assert.equal(nets.reduce((sum, n) => sum + n.aps.length, 0), apartment.aps.length);

    // mesmo nome nas duas faixas, uma caixa só: não é mesh
    const ze = get('psk:Casa do Zé');
    assert.equal(ze.aps.length, 2);
    assert.equal(ze.devices, 1);
    assert.equal(ze.mesh, false);
    assert.deepEqual(ze.bands, ['2.4', '5']);
    assert.equal(ze.best.rssi, -69);
    assert.equal(ze.security.label, 'WPA2/WPA3');
    assert.deepEqual(ze.aps.map((a) => a.rssi), [-69, -78]);

    // a rede pública da operadora sai de duas caixas
    const claro = get('open:#NET-CLARO-WIFI');
    assert.equal(claro.aps.length, 2);
    assert.equal(claro.devices, 2);
    assert.equal(claro.mesh, true);
    assert.deepEqual(claro.bands, ['2.4']);

    // dois vizinhos com o nome de fábrica: uma com senha, outra aberta -> redes diferentes
    assert.equal(get('psk:INTELBRAS').aps.length, 1);
    assert.equal(get('open:INTELBRAS').aps.length, 1);
    assert.equal(get('open:INTELBRAS').security.open, true);

    // "Familia Souza" e "Familia Souza_5G" são redes diferentes (nomes diferentes), cada uma com um aparelho
    assert.equal(get('psk:Familia Souza').devices, 1);
    assert.equal(get('psk:Familia Souza_5G').devices, 1);
  });

  test('mesh: um nome, três aparelhos; ocultas não se misturam', () => {
    const nets = groupBySsid(normalizeScan(mesh));
    const casa = nets.find((n) => n.ssid === 'Casa Oliveira');
    assert.equal(casa.aps.length, 6);
    assert.equal(casa.devices, 3);
    assert.equal(casa.mesh, true);
    assert.deepEqual(casa.bands, ['2.4', '5']);
    assert.equal(casa.best.id, meshTruth.own.b24);
    const hidden = nets.filter((n) => n.hidden);
    assert.equal(hidden.length, 2);
    assert.deepEqual(hidden.map((n) => n.key).sort(), ['hidden:1a:eb:b6:8d:21:51', 'hidden:1a:eb:b6:8d:21:55']);
    assert.ok(hidden.every((n) => n.aps.length === 1 && n.name === HIDDEN_NAME && n.ssid === '' && n.devices === 1 && !n.mesh));
  });

  test('escritório: rede corporativa em três pontos de acesso', () => {
    const nets = groupBySsid(normalizeScan(office));
    const corp = nets.find((n) => n.key === 'eap:Corp');
    assert.equal(corp.aps.length, 6);
    assert.equal(corp.devices, 3);
    assert.equal(corp.mesh, true);
    assert.equal(corp.security.enterprise, true);
    const guests = nets.find((n) => n.key === 'open:Corp-Visitantes');
    assert.equal(guests.devices, 3);
    // seis BSSIDs ocultos = seis redes ocultas, mesmo saindo de três caixas
    assert.equal(nets.filter((n) => n.hidden).length, 6);
    // Wi-Fi 6E com WPA2/WPA3 em 2,4/5 GHz e só WPA3 em 6 GHz continua sendo UMA rede
    const lar = groupBySsid(normalizeScan(wifi7)).find((n) => n.ssid === 'Lar Conectado');
    assert.equal(lar.aps.length, 3);
    assert.deepEqual(lar.bands, ['2.4', '5', '6']);
    assert.equal(lar.devices, 1);
  });

  test('aceita os aparelhos já calculados e entradas tortas', () => {
    const aps = normalizeScan(mesh);
    const devices = groupByDevice(aps);
    assert.deepEqual(groupBySsid(aps, { devices }).map((n) => [n.key, n.devices]), groupBySsid(aps).map((n) => [n.key, n.devices]));
    // sem informação de aparelho, cada BSSID conta como um
    assert.equal(groupBySsid(aps, { devices: [] }).find((n) => n.ssid === 'Casa Oliveira').devices, 6);
    for (const bad of [null, undefined, 5, 'x', {}, []]) assert.deepEqual(groupBySsid(bad), []);
    const odd = groupBySsid([null, {}, { ssid: 'A' }, { bssid: 'x', ssid: 'A' }, apartment.aps[0]], { devices: 'x' });
    assert.equal(odd.reduce((sum, n) => sum + n.aps.length, 0), 4);
    // segurança desconhecida não vira "aberta"
    assert.ok(odd.some((n) => n.key === 'unknown:A' && n.aps.length === 2 && n.devices === 2));
  });
});

// ---------------------------------------------------------------------------

describe('ApTracker', () => {
  const OWN = apartmentTruth.own.b24;
  const VOVO = 'b0:95:75:c3:0a:66';
  const MENGAO = '84:c9:b2:7f:30:15';

  test('primeira varredura: todo mundo entra, com uma amostra no instante em que foi ouvido', () => {
    const tracker = new ApTracker();
    assert.equal(tracker.size, 0);
    assert.equal(tracker.lastTs, null);
    assert.deepEqual(tracker.list(), []);
    const result = tracker.update(apartment);
    assert.deepEqual(result, { heard: 28, added: 28, total: 28 });
    assert.equal(tracker.size, 28);
    assert.equal(tracker.lastTs, TS);
    assert.deepEqual(tracker.history(OWN), [{ t: TS - 120, rssi: -48 }]);
    assert.deepEqual(tracker.history(MENGAO), [{ t: TS - 41000, rssi: -83 }]);
    const own = tracker.get(OWN);
    assert.equal(own.rssi, -48);
    assert.equal(own.rssiSmooth, -48);
    assert.equal(own.firstSeen, TS - 120);
    assert.equal(own.lastSeen, TS - 120);
    assert.equal(own.seenCount, 1);
    assert.equal(own.ageMs, 120);
    assert.equal(own.channel, 6);
    assert.equal(tracker.get('AA:BB:CC:00:00:00'), null);
    assert.equal(tracker.get(OWN.toUpperCase()).id, OWN);
  });

  test('BSSID repetido pelo Android (não ouvido de novo) não vira amostra nova', () => {
    const tracker = new ApTracker();
    tracker.update(apartment);
    const second = nextScan(apartment, { dtMs: 30_000, heard: { [OWN]: -51, [VOVO]: -66 } });
    assert.deepEqual(tracker.update(second), { heard: 2, added: 0, total: 28 });
    assert.deepEqual(tracker.history(OWN), [{ t: TS - 120, rssi: -48 }, { t: TS + 30_000 - 200, rssi: -51 }]);
    assert.equal(tracker.get(OWN).seenCount, 2);
    assert.equal(tracker.get(OWN).rssi, -51);
    // os outros 26 continuam com a única leitura que tiveram
    const claro = tracker.get('f8:0b:be:4f:1d:28');
    assert.equal(claro.seenCount, 1);
    assert.equal(tracker.history(claro.id).length, 1);
    assert.equal(claro.lastSeen, TS - 240);
    assert.equal(claro.ageMs, 30_240);
    assert.equal(claro.stale, true);
    assert.equal(tracker.get(OWN).stale, false);

    // reler a lista em cache, um instante depois, não acrescenta nada
    const cache = nextScan(second, { dtMs: 1500, fresh: false });
    assert.deepEqual(tracker.update(cache), { heard: 0, added: 0, total: 28 });
    assert.equal(tracker.history(OWN).length, 2);
    // nem o mesmo evento entregue duas vezes
    assert.equal(tracker.update(second).heard, 0);
    // o arredondamento dos relógios (ts − ageMs variando alguns ms) não engana
    const jitter = { ...cache, ts: cache.ts + 400, aps: cache.aps.map((a) => ({ ...a, ageMs: a.ageMs + 397 })) };
    assert.equal(tracker.update(jitter).heard, 0);
  });

  test('média com constante de tempo: leituras próximas alisam, leitura isolada vale por si', () => {
    const tracker = new ApTracker({ smoothingMs: 8000 });
    const one = { ts: 100_000, fresh: true, aps: [{ bssid: OWN, ssid: 'x', level: -50, frequency: 2437, ageMs: 0 }] };
    tracker.update(one);
    tracker.update(nextScan(one, { dtMs: 2000, heard: { [OWN]: -60 } }));
    // amostras em t = 100000 e t = 101800: peso da nova = 1 − e^(−1800/8000)
    const alpha = 1 - Math.exp(-1800 / 8000);
    near(tracker.get(OWN).rssiSmooth, -50 + alpha * -10, 0.051, 'suavizado');
    assert.equal(tracker.get(OWN).rssi, -60);
    // dois minutos sem ouvir: a leitura velha quase não pesa mais
    const last = { ts: 222_000, fresh: true, aps: [{ bssid: OWN, ssid: 'x', level: -80, frequency: 2437, ageMs: 0 }] };
    tracker.update(last);
    near(tracker.get(OWN).rssiSmooth, -80, 0.051, 'depois da pausa');
    // smoothingMs = 0 desliga a suavização
    const raw = new ApTracker({ smoothingMs: 0 });
    raw.update(one);
    raw.update(nextScan(one, { dtMs: 2000, heard: { [OWN]: -60 } }));
    assert.equal(raw.get(OWN).rssiSmooth, -60);
  });

  test('list: some quem não é ouvido há mais de maxAgeMs (padrão 60 s)', () => {
    const tracker = new ApTracker();
    tracker.update(apartment);
    assert.equal(tracker.list().length, 28);
    // ordem: sinal suavizado, do mais forte para o mais fraco
    const first = tracker.list();
    assert.equal(first[0].id, OWN);
    for (let i = 1; i < first.length; i++) assert.ok(first[i - 1].rssiSmooth >= first[i].rssiSmooth);
    assert.equal(tracker.list({ maxAgeMs: 30_000 }).length, 27); // a leitura de 41 s atrás sai
    assert.equal(tracker.list({ maxAgeMs: 100 }).length, 1);
    assert.equal(tracker.list({ maxAgeMs: 0 }).length, 0);

    tracker.update(nextScan(apartment, { dtMs: 30_000, heard: { [OWN]: -50 } }));
    assert.equal(tracker.list().length, 27); // 41 s + 30 s > 60 s
    assert.ok(!tracker.list().some((ap) => ap.id === MENGAO));
    assert.equal(tracker.size, 28); // some da lista, mas o histórico continua guardado
    assert.equal(tracker.history(MENGAO).length, 1);
    // `now` adianta o relógio sem varredura nova
    assert.deepEqual(tracker.list({ now: TS + 85_000 }).map((ap) => ap.id), [OWN]);
    assert.equal(tracker.list({ now: TS + 85_000 })[0].ageMs, 55_200);
    assert.equal(tracker.list({ now: TS + 85_000 })[0].stale, true);
    assert.deepEqual(tracker.list({ now: TS + 95_000 }), []);
    assert.equal(tracker.get(OWN, { now: TS + 40_000 }).ageMs, 10_200);
    // os itens são cópias: mexer neles não estraga a memória
    tracker.list()[0].rssi = 0;
    assert.equal(tracker.get(OWN).rssi, -50);
    tracker.history(OWN)[0].rssi = 0;
    assert.equal(tracker.history(OWN)[0].rssi, -48);
  });

  test('janela do histórico, teto de amostras e esquecimento', () => {
    const tracker = new ApTracker({ historyMs: 60_000, maxSamples: 5 });
    let event = { ts: 1_000_000, fresh: true, aps: [
      { bssid: OWN, ssid: 'a', level: -50, frequency: 2437, ageMs: 0 },
      { bssid: VOVO, ssid: 'b', level: -70, frequency: 2462, ageMs: 0 },
    ] };
    tracker.update(event);
    for (let i = 1; i <= 8; i++) {
      event = nextScan(event, { dtMs: 5000, heard: { [OWN]: -50 - i } });
      tracker.update(event);
    }
    // 9 leituras em 40 s: ficam as 5 mais novas
    assert.deepEqual(tracker.history(OWN).map((s) => s.rssi), [-54, -55, -56, -57, -58]);
    assert.equal(tracker.get(OWN).seenCount, 9);
    assert.equal(tracker.size, 2);
    // mais 30 s: a outra rede não é ouvida há 70 s (> historyMs) e é esquecida de vez
    event = nextScan(event, { dtMs: 30_000, heard: { [OWN]: -40 } });
    tracker.update(event);
    assert.equal(tracker.size, 1);
    assert.deepEqual(tracker.history(VOVO), []);
    assert.equal(tracker.get(VOVO), null);
    // amostras mais velhas que a janela saem
    const wide = new ApTracker({ historyMs: 12_000 });
    let e = { ts: 1_000_000, fresh: true, aps: [{ bssid: OWN, ssid: 'a', level: -50, frequency: 2437, ageMs: 0 }] };
    wide.update(e);
    for (let i = 1; i <= 5; i++) {
      e = nextScan(e, { dtMs: 5000, heard: { [OWN]: -50 - i } });
      wide.update(e);
    }
    // última varredura em ts = 1.025.000; amostras em 1.000.000 e 1.004.800... só as dos últimos 12 s
    assert.deepEqual(wide.history(OWN).map((s) => s.rssi), [-53, -54, -55]);
    // padrão: 10 minutos
    const def = new ApTracker();
    def.update(apartment);
    def.update(nextScan(apartment, { dtMs: 550_000, heard: { [OWN]: -50 } }));
    assert.equal(def.size, 28); // a mais velha foi ouvida há 591 s
    def.update(nextScan(apartment, { dtMs: 650_000, heard: { [OWN]: -50 } }));
    assert.equal(def.size, 1);
  });

  test('leitura sem ageMs: só conta como nova em varredura nova', () => {
    const tracker = new ApTracker();
    const ap = { bssid: OWN, ssid: 'a', level: -50, frequency: 2437 };
    assert.equal(tracker.update({ ts: 1_000_000, fresh: false, aps: [ap] }).added, 1);
    assert.equal(tracker.update({ ts: 1_010_000, fresh: false, aps: [ap] }).heard, 0);
    assert.equal(tracker.update({ ts: 1_020_000, fresh: true, aps: [{ ...ap, level: -55 }] }).heard, 1);
    assert.deepEqual(tracker.history(OWN), [{ t: 1_000_000, rssi: -50 }, { t: 1_020_000, rssi: -55 }]);
    // sinal ausente: o BSSID conta como ouvido, mas não entra no histórico
    assert.equal(tracker.update({ ts: 1_030_000, fresh: true, aps: [{ ...ap, level: null }] }).heard, 1);
    assert.equal(tracker.history(OWN).length, 2);
    assert.equal(tracker.get(OWN).seenCount, 3);
    assert.equal(tracker.get(OWN).rssi, null);
    // 20 s entre as duas leituras: a nova pesa 1 − e^(−20/8) = 92%
    assert.equal(tracker.get(OWN).rssiSmooth, -54.6);
  });

  test('BSSID duplicado no mesmo evento, relógio que volta e clear()', () => {
    const tracker = new ApTracker();
    const dup = { ts: 2_000_000, fresh: true, aps: [
      { bssid: OWN, ssid: 'a', level: -70, frequency: 2437, ageMs: 5000 },
      { bssid: OWN.toUpperCase(), ssid: 'a', level: -52, frequency: 2437, ageMs: 100 },
    ] };
    assert.deepEqual(tracker.update(dup), { heard: 1, added: 1, total: 1 });
    assert.deepEqual(tracker.history(OWN), [{ t: 1_999_900, rssi: -52 }]);
    // evento um pouco atrasado (ms) não zera nada nem regride
    assert.equal(tracker.update({ ts: 1_999_990, fresh: true, aps: [] }).total, 1);
    assert.equal(tracker.lastTs, 2_000_000);
    // o usuário acertou a data para trás: o histórico antigo não faz mais sentido
    const back = { ts: 1_000_000, fresh: true, aps: [{ bssid: VOVO, ssid: 'b', level: -60, frequency: 2462, ageMs: 50 }] };
    assert.deepEqual(tracker.update(back), { heard: 1, added: 1, total: 1 });
    assert.equal(tracker.get(OWN), null);
    assert.equal(tracker.lastTs, 1_000_000);
    tracker.clear();
    assert.equal(tracker.size, 0);
    assert.equal(tracker.lastTs, null);
    assert.deepEqual(tracker.list(), []);
    assert.deepEqual(tracker.history(VOVO), []);
  });

  test('eventos tortos não lançam exceção', () => {
    const tracker = new ApTracker({ historyMs: -1, smoothingMs: 'x', maxSamples: 0, sdk: 'y' });
    for (const bad of [null, undefined, 5, 'x', [], {}, { aps: 'x' }, { ts: 'ontem', aps: [null, 3, {}, { bssid: 'zz' }] }]) {
      const result = tracker.update(bad);
      assert.equal(result.heard, 0);
      assert.equal(result.total, 0);
    }
    assert.deepEqual(tracker.list({ maxAgeMs: 'x', now: 'y' }), []);
    assert.deepEqual(tracker.history(null), []);
    assert.equal(tracker.get(undefined), null);
    // opções inválidas caem nos padrões
    tracker.update(apartment);
    assert.equal(tracker.list().length, 28);
    assert.equal(new ApTracker(null).update(apartment).added, 28);
    // sem ts, vale o relógio do aparelho
    const now = Date.now();
    const loose = new ApTracker();
    loose.update({ fresh: true, aps: [{ bssid: OWN, level: -50, frequency: 2437, ageMs: 0 }] });
    assert.ok(loose.lastTs >= now && loose.lastTs <= Date.now());
  });

  test('a lista do tracker serve direto para os agrupamentos', () => {
    const tracker = new ApTracker();
    tracker.update(apartment);
    tracker.update(nextScan(apartment, { dtMs: 20_000, heard: { [OWN]: -49, [apartmentTruth.own.b5]: -57 } }));
    const list = tracker.list({ maxAgeMs: 120_000 });
    assert.equal(list.length, 28);
    // leituras de momentos diferentes (20 s de diferença) não desmancham os aparelhos
    assert.deepEqual(partition(groupByDevice(list).map((d) => d.bssids)), partition(apartmentTruth.devices));
    assert.equal(groupBySsid(list).find((n) => n.ssid === '#NET-CLARO-WIFI').devices, 2);
  });
});
