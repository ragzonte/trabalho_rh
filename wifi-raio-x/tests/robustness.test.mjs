// Robustez do core (app/js/core): o que acontece quando o celular (ou uma ponte com defeito)
// manda lixo, e as garantias que as telas podem assumir sem conferir.
//
//   1. entrada hostil    nenhuma função exportada lança exceção nem devolve NaN/Infinity
//   2. casos de campo    sinal 0 ou positivo, frequência 0, largura 99, BSSID repetido, 500 APs...
//   3. propriedades      notas em 0..100, rankings ordenados e determinísticos, entradas intactas
//   4. memória           ApTracker limitado; as memórias internas não mudam nenhuma resposta
//   5. desempenho        uma varredura de 200 APs analisada em bem menos de 50 ms
//   6. textos            pt-BR com vírgula decimal, "Mb/s" e estimativas ditas como estimativas
//
// Tudo com gerador de números fixo: o mesmo teste, a mesma entrada, sempre.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as core from '../app/js/core/index.js';
import * as signalMod from '../app/js/core/signal.js';
import * as phyMod from '../app/js/core/phy.js';
import * as channelsMod from '../app/js/core/channels.js';
import * as modelMod from '../app/js/core/model.js';
import * as iesMod from '../app/js/core/ies.js';
import * as securityMod from '../app/js/core/security.js';
import * as ouiMod from '../app/js/core/oui.js';
import * as ratingMod from '../app/js/core/channel-rating.js';
import * as bestMod from '../app/js/core/best-network.js';
import * as insightsMod from '../app/js/core/insights.js';
import { apartment, mesh, office, wifi7, TS } from './fixtures/scans.mjs';

const {
  normalizeAp,
  normalizeScan,
  groupByDevice,
  groupBySsid,
  ApTracker,
  rateChannels,
  recommendChannel,
  recommendWidth,
  rateOwnChannel,
  channelGraph,
  scoreAp,
  scoringContext,
  rankNetworks,
  advise,
  buildInsights,
  parseIes,
  summarizeIes,
  encodeIes,
  parseCapabilities,
  refineWithIes,
  occupancy,
  interferenceFactor,
  segmentsOf,
  sanitizeRssi,
  signalLevel,
  formatSpeed,
  formatDbm,
  formatDistance,
  formatGain,
  channelList,
  standardInfo,
  loadOui,
  createOuiLookup,
} = core;

// ---------------------------------------------------------------------------
// Ferramentas
// ---------------------------------------------------------------------------

/** Gerador de números pseudoaleatórios com semente (mulberry32). */
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

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value) || ArrayBuffer.isView(value)) return value;
  seen.add(value);
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key], seen);
  return value;
}

/** Cópia em JSON sem o ScanAp cru (`raw`), para comparar resultados. */
const snapshot = (value) => JSON.stringify(value, (key, v) => (key === 'raw' ? undefined : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));

/** Caminhos de todos os números não finitos dentro de `value` (o ScanAp cru fica de fora). */
function nonFinite(value, path = 'r', out = [], depth = 0, seen = new Set()) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path} = ${value}`);
    return out;
  }
  if (value === null || typeof value !== 'object' || depth > 10 || seen.has(value) || ArrayBuffer.isView(value)) return out;
  seen.add(value);
  if (value instanceof Map || value instanceof Set) {
    let i = 0;
    for (const item of value) nonFinite(item, `${path}{${i++}}`, out, depth + 1, seen);
    return out;
  }
  for (const key of Object.keys(value)) if (key !== 'raw') nonFinite(value[key], `${path}.${key}`, out, depth + 1, seen);
  return out;
}

// Campos que carregam texto vindo do celular (nome da rede, do aparelho...): o core os entrega
// como vieram, então não entram na conferência dos textos que o próprio core escreve.
const PASS_THROUGH = new Set(['raw', 'ssid', 'name', 'bssid', 'id', 'key', 'ssids', 'bssids', 'mld', 'mldMac', 'deviceName', 'manufacturer', 'model', 'apName', 'fingerprint', 'venueName', 'operatorName', 'code', 'country']);

/** Todo texto escrito pelo core dentro de `value`. */
function ownTexts(value, out = [], depth = 0, seen = new Set()) {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (value === null || typeof value !== 'object' || depth > 10 || seen.has(value) || ArrayBuffer.isView(value)) return out;
  seen.add(value);
  for (const key of Object.keys(value)) if (!PASS_THROUGH.has(key)) ownTexts(value[key], out, depth + 1, seen);
  return out;
}

/** Todos os objetos alcançáveis a partir de `value` (para saber o que já veio na entrada). */
function reachable(value, out = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 10 || out.has(value) || ArrayBuffer.isView(value)) return out;
  out.add(value);
  for (const key of Object.keys(value)) reachable(value[key], out, depth + 1);
  return out;
}

const show = (v) => {
  try {
    const s = JSON.stringify(v);
    return (s === undefined ? String(v) : s).slice(0, 60);
  } catch {
    return String(v);
  }
};

const PHONE = deepFreeze({ platform: 'android', sdk: 34, release: '14', bands: { b24: true, b5: true, b6: true, b60: false }, standards: [1, 4, 5, 6], rtt: false });
const OLD_PHONE = deepFreeze({ platform: 'android', sdk: 29, release: '10', bands: { b24: true, b5: false, b6: false, b60: false }, standards: [], rtt: false });

const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0');
const SEC = ['[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS][WPS]', '[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][MFPC]', '[RSN-SAE-CCMP][ESS][MFPR][MFPC]', '[ESS]', '[WEP][ESS]', '[WPA-PSK-TKIP][ESS]', '[WPA2-EAP/SHA1-CCMP][RSN-EAP/SHA1-CCMP][ESS]'];
const CENTER_80 = { 36: 5210, 40: 5210, 44: 5210, 48: 5210, 52: 5290, 100: 5530, 108: 5530, 149: 5775, 153: 5775, 157: 5775, 161: 5775 };

/**
 * Varredura de mentira com `n` APs: roteadores de duas ou três faixas com MACs vizinhos, redes
 * de convidados no mesmo rádio, canais fora do padrão, e (com `ies`) elementos de beacon.
 */
function randomScan(n, seed, { ies = true } = {}) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const aps = [];
  while (aps.length < n) {
    const oui = [pick([0x98, 0xe0, 0x10, 0x48, 0x74]), Math.floor(r() * 256), Math.floor(r() * 256)];
    const tail = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 240)];
    const mac = (first, last) => [first, oui[1], oui[2], tail[0], tail[1], last].map(hex2).join(':');
    const name = pick(['VIVOFIBRA-', 'CLARO_', 'NET_', 'Casa ', 'TP-Link_', 'Oi ']) + hex2(tail[1]).toUpperCase() + hex2(tail[2]).toUpperCase();
    const capabilities = pick(SEC);
    const level = -35 - Math.floor(r() * 58);
    const channel = pick([1, 1, 1, 6, 6, 6, 11, 11, 11, 3, 4, 8, 9, 13]);
    const withIes = ies && r() < 0.7;
    const rsn = capabilities.includes('RSN') ? { akms: capabilities.includes('SAE') ? ['PSK', 'SAE'] : ['PSK'], ciphers: ['CCMP'] } : undefined;
    const f24 = 2407 + 5 * channel;
    const first = {
      bssid: mac(oui[0], tail[2]),
      ssid: name,
      level,
      frequency: f24,
      channelWidth: r() < 0.15 ? 1 : 0,
      centerFreq0: 0,
      centerFreq1: 0,
      capabilities,
      ageMs: Math.floor(r() * 900),
      wifiStandard: pick([4, 4, 6]),
    };
    if (withIes) {
      first.ies = encodeIes({
        frequency: f24,
        widthMHz: 20,
        country: 'BR',
        bssLoad: r() < 0.5 ? { stations: Math.floor(r() * 30), utilization: r() * 0.8 } : undefined,
        ht: { nss: 2 },
        rsn,
        wps: capabilities.includes('WPS') ? { manufacturer: 'Askey', model: 'RTF' } : undefined,
        vendorOuis: ['00:10:18'],
      });
    }
    aps.push(first);
    if (aps.length < n && r() < 0.3) aps.push({ ...first, bssid: mac(oui[0] | 2, tail[2]), ssid: `${name}-Convidados`, level: level + (r() < 0.5 ? 1 : -1) });
    if (aps.length < n && r() < 0.6) {
      const c5 = pick([36, 40, 44, 48, 52, 100, 108, 149, 153, 157, 161]);
      const f5 = 5000 + 5 * c5;
      const ap = {
        bssid: mac(oui[0], tail[2] + 1 + Math.floor(r() * 3)),
        ssid: r() < 0.5 ? name : `${name}_5G`,
        level: level - 6 - Math.floor(r() * 8),
        frequency: f5,
        channelWidth: 2,
        centerFreq0: CENTER_80[c5],
        centerFreq1: 0,
        capabilities,
        ageMs: Math.floor(r() * 900),
        wifiStandard: pick([5, 6]),
      };
      if (withIes) ap.ies = encodeIes({ frequency: f5, widthMHz: 80, country: 'BR', ht: { nss: 2, width40: true }, vht: { nss: 2 }, rsn, vendorOuis: ['00:10:18'] });
      aps.push(ap);
    }
    if (aps.length < n && r() < 0.1) {
      const f6 = 5950 + 5 * pick([5, 21, 37, 53, 69, 85]);
      const ap = {
        bssid: mac(oui[0], tail[2] + 5),
        ssid: name,
        level: level - 12,
        frequency: f6,
        channelWidth: 3,
        centerFreq0: 0,
        centerFreq1: 0,
        capabilities: '[RSN-SAE-CCMP][ESS][MFPR][MFPC]',
        ageMs: Math.floor(r() * 900),
        wifiStandard: 6,
      };
      if (withIes) ap.ies = encodeIes({ frequency: f6, widthMHz: 160, he: { nss: 2, width160: true }, rsn: { akms: ['SAE'], ciphers: ['CCMP'], pmfRequired: true } });
      aps.push(ap);
    }
  }
  return { ts: TS, fresh: true, source: 'request', aps: aps.slice(0, n) };
}

const connectionTo = (ap, more = {}) => ({
  connected: true,
  bssid: ap.bssid,
  ssid: ap.ssid,
  rssi: -60,
  frequency: ap.frequency,
  linkSpeed: 10,
  txSpeed: 10,
  rxSpeed: 10,
  maxTxSpeed: 300,
  maxRxSpeed: 300,
  wifiStandard: 6,
  ...more,
});

/**
 * Roda o caminho inteiro de uma varredura (o que as telas pedem) e devolve tudo o que saiu.
 * `fail(etapa, erro)` é chamada quando alguma função lança exceção. Com `light`, pula as
 * repetições a partir da lista crua e as larguras extras (para as varreduras de lixo, que
 * rodam o caminho milhares de vezes).
 */
function pipeline(event, { device = PHONE, connection, fail, light = false }) {
  const out = {};
  const step = (name, fn) => {
    try {
      out[name] = fn();
    } catch (err) {
      fail(name, err);
    }
    return out[name];
  };
  const raw = event !== null && typeof event === 'object' && Array.isArray(event.aps) ? event.aps : [];
  const aps = step('normalizeScan', () => normalizeScan(event, { sdk: 34 })) || [];
  step('normalizeAp', () => raw.slice(0, 2).map((item) => normalizeAp(item, { ts: event.ts, sdk: 34 })));
  const devices = step('groupByDevice', () => groupByDevice(aps));
  if (!light) step('groupByDevice(cru)', () => groupByDevice(raw));
  step('groupBySsid', () => groupBySsid(aps, { devices }));
  if (!light) step('groupBySsid(cru)', () => groupBySsid(raw));
  const first = normalizeAp(raw[0]);
  for (const band of ['2.4', '5', '6']) {
    const widths = band === '2.4' ? [20, 40] : light ? [80] : [20, 80, 320];
    for (const widthMHz of widths) step(`rateChannels ${band}/${widthMHz}`, () => rateChannels(aps, { band, widthMHz, devices }));
    step(`rateChannels(cru) ${band}`, () => rateChannels(raw, { band, exclude: [raw[0] && raw[0].bssid] }));
    step(`recommendChannel ${band}`, () => recommendChannel(aps, { band, own: first }));
    if (!light) step(`recommendChannel(cru) ${band}`, () => recommendChannel(raw, { band }));
    step(`recommendWidth ${band}`, () => recommendWidth(aps, band, { own: first }));
    step(`channelGraph ${band}`, () => channelGraph(raw, band));
  }
  step('rateOwnChannel', () => rateOwnChannel(aps, { own: first, devices }));
  step('scoreAp(cru)', () => scoreAp(raw[0], { aps: raw, device, connectionBssid: raw[0] && raw[0].bssid }));
  if (!light) step('scoreAp', () => scoreAp(first, { aps, device }));
  for (const connectionBssid of light ? [first.id] : [first.id, undefined]) {
    const ranking = step(`rankNetworks ${connectionBssid ? 'conectado' : 'solto'}`, () => rankNetworks(raw, { device, connectionBssid, favorites: [first.ssid] }));
    step(`advise ${connectionBssid ? 'conectado' : 'solto'}`, () => advise(ranking, { connectionBssid, favorites: [first.ssid] }));
  }
  const conn = connection === undefined ? connectionTo(raw[0] !== null && typeof raw[0] === 'object' ? raw[0] : {}) : connection;
  step('buildInsights', () => buildInsights({ aps: raw, connection: conn, device, status: { throttled: true } }));
  step('ApTracker', () => {
    const tracker = new ApTracker({ clock: () => TS });
    const result = tracker.update(event);
    const id = raw[0] && raw[0].bssid;
    return { result, list: tracker.list(), one: tracker.get(id), history: tracker.history(id), size: tracker.size };
  });
  return out;
}

const BAD_TEXT = /\bNaN\b|Infinity|undefined|\bnull\b|\[object /;

/**
 * O mesmo que nonFinite + ownTexts numa passada só e sem montar caminhos: responde se há algum
 * número não finito ou texto do core com valor vazando. (As varreduras de lixo conferem milhares
 * de resultados; o relatório detalhado só é montado quando algo está errado.)
 */
function hasLeak(root) {
  const seen = new Set();
  const stack = [[root, false]];
  while (stack.length) {
    const [value, passThrough] = stack.pop();
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return true;
    } else if (typeof value === 'string') {
      if (!passThrough && BAD_TEXT.test(value)) return true;
    } else if (value !== null && typeof value === 'object' && !seen.has(value) && !ArrayBuffer.isView(value)) {
      seen.add(value);
      if (value instanceof Map || value instanceof Set) {
        for (const item of value) stack.push([item, passThrough]);
        continue;
      }
      for (const key of Object.keys(value)) {
        if (key === 'raw') continue;
        // texto vindo do celular (nome da rede...) é entregue como veio; os números dentro contam
        stack.push([value[key], passThrough || PASS_THROUGH.has(key)]);
      }
    }
  }
  return false;
}

/** Confere tudo o que um pipeline devolveu: números finitos, notas na escala, textos limpos. */
function checkOutput(out, label) {
  if (hasLeak(out)) {
    assert.deepEqual(nonFinite(out).slice(0, 3), [], `${label}: número não finito`);
    for (const text of ownTexts(out)) assert.ok(!BAD_TEXT.test(text), `${label}: texto com valor vazando: ${text.slice(0, 120)}`);
    assert.fail(`${label}: hasLeak acusou algo que o relatório detalhado não achou`);
  }
  for (const [name, value] of Object.entries(out)) {
    if (name.startsWith('rateChannels')) {
      for (const row of value) {
        assert.ok(row.score >= 0 && row.score <= 100, `${label}: ${name} nota ${row.score}`);
        assert.ok(row.airtime >= 0 && row.airtime <= 1, `${label}: ${name} airtime ${row.airtime}`);
        assert.ok(row.utilization === null || (row.utilization >= 0 && row.utilization <= 1), `${label}: ${name} utilization ${row.utilization}`);
      }
    }
    if (name.startsWith('rankNetworks')) {
      for (const row of value) {
        assert.ok(row.score >= 0 && row.score <= 100, `${label}: ${name} nota ${row.score}`);
        assert.ok(row.estMbps === null || row.estMbps >= 0, `${label}: ${name} estMbps ${row.estMbps}`);
        for (const part of Object.values(row.parts)) assert.ok(part >= 0 && part <= 100, `${label}: ${name} parte ${part}`);
      }
    }
  }
  for (const ap of out.normalizeScan || []) {
    assert.ok(ap.rssi === null || (ap.rssi < 0 && ap.rssi > -127), `${label}: rssi ${ap.rssi}`);
    assert.ok(ap.quality >= 0 && ap.quality <= 100, `${label}: quality ${ap.quality}`);
    assert.ok(ap.distanceM === null || (ap.distanceM >= 0.3 && ap.distanceM <= 200), `${label}: distanceM ${ap.distanceM}`);
    assert.ok(ap.ageMs === null || ap.ageMs >= 0, `${label}: ageMs ${ap.ageMs}`);
  }
}

// ---------------------------------------------------------------------------
// 0. A porta de entrada
// ---------------------------------------------------------------------------

describe('core/index.js', () => {
  const MODULES = { signal: signalMod, phy: phyMod, channels: channelsMod, model: modelMod, ies: iesMod, security: securityMod, oui: ouiMod, 'channel-rating': ratingMod, 'best-network': bestMod, insights: insightsMod };

  test('reexporta tudo o que os módulos exportam, com o mesmo valor e sem default', () => {
    const owner = new Map();
    for (const [file, mod] of Object.entries(MODULES)) {
      for (const [name, value] of Object.entries(mod)) {
        assert.ok(!owner.has(name), `"${name}" é exportado por ${owner.get(name)} e por ${file}`);
        owner.set(name, file);
        assert.ok(name in core, `index.js não reexporta ${name} (de ${file}.js)`);
        assert.equal(core[name], value, name);
      }
    }
    assert.deepEqual(Object.keys(core).filter((name) => !owner.has(name)), []);
    assert.equal('default' in core, false);
  });
});

// ---------------------------------------------------------------------------
// 1. Entrada hostil
// ---------------------------------------------------------------------------

// Um objeto com cara de Ap normalizado (passa em asAp) e o recheio todo errado.
const IMPOSTOR = {
  id: 'aa:bb:cc:dd:ee:ff',
  bssid: 5,
  ssid: null,
  name: undefined,
  hidden: 'talvez',
  rssi: 1e308,
  rssiSmooth: -1e308,
  band: '2.4',
  channel: 6,
  freq: 2437,
  widthMHz: -5,
  occ: { segments: [null, 5, { lo: 'a' }, { lo: 2427, hi: 2447 }, { lo: -1e308, hi: 1e308 }, { lo: 2400, hi: Infinity }], centerFreq: NaN },
  security: 'x',
  ie: 7,
  gen: 99,
  nss: -3,
  stations: 1e308,
  utilization: 40,
  ageMs: -1,
};

const HOSTILE = [
  undefined, null, NaN, Infinity, -Infinity, 0, -0, 1, -1, 0.5, 1e308, -1e308, 2437, 5180, 5955, 60480, -57, 99, -127,
  '', ' ', 'abc', '-57', '2437', '0x10', '2.4', 'aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', '<img src=x onerror=alert(1)>', '\u0000\u0001\u001f', '😀📶', '__proto__',
  true, false, [], {}, [NaN], [null], [undefined, 'x', {}, 7], { length: 3 }, { aps: 'x' }, { segments: [{ lo: 'a', hi: null }, { lo: -1e308, hi: 1e308 }] },
  [[]], { bssid: 5 }, IMPOSTOR, [IMPOSTOR, { ...IMPOSTOR, id: 'aa:bb:cc:dd:ee:fe', band: '5', freq: 5180, channel: 36 }], { band: '2.4', own: IMPOSTOR, widthMHz: 'x' },
];

describe('entrada hostil: toda função exportada', () => {
  // Aritmética pura: lixo nos argumentos sai como entrou (documentado em signal.js)
  const ARITHMETIC = new Set(['clamp', 'lerp']);
  // "Potência nenhuma" é −Infinity por definição
  const MINUS_INFINITY = new Set(['mwToDbm', 'sumDbm']);
  const SKIP = new Set(['ApTracker', 'loadOui']); // conferidos à parte

  const check = (name, fn, args) => {
    let result;
    try {
      result = fn(...args);
      // createEma / createKalman1D devolvem uma função: ela também não pode tropeçar
      if (typeof result === 'function') result = { first: result(args[0]), second: result(args[1]), value: result.value };
    } catch (err) {
      assert.fail(`${name}(${args.map(show).join(', ')}) lançou: ${err && err.message}`);
    }
    if (ARITHMETIC.has(name)) return;
    // Um objeto da entrada devolvido como veio (asAp, os agrupamentos...) pode trazer o lixo que
    // já tinha: o que se cobra é que o core não fabrique NaN/Infinity.
    const given = new Set();
    for (const arg of args) reachable(arg, given);
    let bad = nonFinite(result, 'r', [], 0, given);
    if (MINUS_INFINITY.has(name)) bad = bad.filter((line) => !line.endsWith('-Infinity'));
    if (bad.length) assert.fail(`${name}(${args.map(show).join(', ')}) devolveu ${bad.slice(0, 2).join('; ')}`);
  };

  for (const [name, fn] of Object.entries(core)) {
    if (typeof fn !== 'function' || SKIP.has(name)) continue;
    test(`${name}: não lança nem devolve NaN/Infinity`, () => {
      check(name, fn, []);
      for (const a of HOSTILE) {
        check(name, fn, [a]);
        for (const b of HOSTILE) check(name, fn, [a, b]);
      }
      const few = [undefined, NaN, -1e308, 0, -57, 2437, 'abc', {}, [IMPOSTOR]];
      for (const a of few) for (const b of few) for (const c of few) check(name, fn, [a, b, c]);
    });
  }

  test('clamp e lerp: com números finitos o resultado é finito', () => {
    for (const x of [-1e9, -57, 0, 0.5, 3, 1e9, NaN]) {
      const y = core.clamp(x, -100, 100);
      assert.ok(y >= -100 && y <= 100, `clamp(${x})`);
    }
    for (const t of [-2, 0, 0.25, 1, 7]) assert.ok(Number.isFinite(core.lerp(-90, -30, t)));
  });

  test('ApTracker: construtor, update, list, get e history com qualquer coisa', () => {
    for (const options of HOSTILE) {
      const tracker = new ApTracker(options);
      for (const event of HOSTILE) {
        const result = tracker.update(event);
        assert.deepEqual(nonFinite(result), []);
      }
      for (const arg of HOSTILE) {
        assert.deepEqual(nonFinite(tracker.list(arg)), [], `list(${show(arg)})`);
        assert.deepEqual(nonFinite(tracker.get(arg, arg)), [], `get(${show(arg)})`);
        assert.deepEqual(tracker.history(arg), []);
      }
      tracker.clear();
      assert.equal(tracker.size, 0);
    }
  });

  test('ApTracker: relógio que devolve lixo não contamina nada', () => {
    for (const reading of [NaN, Infinity, 'agora', undefined, null]) {
      const tracker = new ApTracker({ clock: () => reading });
      tracker.update({ aps: apartment.aps });
      tracker.update({ aps: apartment.aps, fresh: true });
      assert.ok(tracker.size > 0);
      assert.deepEqual(nonFinite({ list: tracker.list(), lastTs: tracker.lastTs }), []);
    }
    const broken = new ApTracker({ clock: 'não é função' });
    assert.ok(broken.update({ aps: apartment.aps }).total > 0);
    const throwing = new ApTracker({
      clock: () => {
        throw new Error('sem relógio');
      },
    });
    assert.ok(throwing.update({ aps: apartment.aps }).total > 0);
    assert.deepEqual(nonFinite(throwing.list()), []);
  });

  test('loadOui nunca rejeita: endereço, busca e resposta com defeito viram consulta vazia', async () => {
    const fetchers = [
      undefined,
      null,
      'x',
      () => {
        throw new Error('sem rede');
      },
      async () => {
        throw new Error('sem rede');
      },
      async () => null,
      async () => ({ ok: false, status: 404 }),
      async () => ({ ok: true, json: async () => ({ format: 99 }) }),
      async () => ({ ok: true, json: async () => 'lixo' }),
      async () => ({ ok: true }),
    ];
    let n = 0;
    for (const fetcher of fetchers) {
      const lookup = await loadOui(`teste-robustez-${n++}.json`, fetcher);
      assert.equal(lookup.loaded, false);
      assert.equal(lookup.size, 0);
      assert.equal(typeof lookup.error, 'string');
      for (const mac of HOSTILE) {
        const vendor = lookup.vendor(mac);
        // sem tabela não há fabricante; sobra só "endereço inventado por software" (o bit local)
        assert.ok(vendor === null || (vendor.name === null && vendor.randomized === true), show(mac));
        assert.equal(typeof lookup.label(mac), 'string');
        assert.equal(typeof lookup.isRandomized(mac), 'boolean');
      }
    }
    for (const data of HOSTILE) assert.equal(createOuiLookup(data).loaded, false, show(data));
  });
});

describe('entrada hostil: campos do ScanAp pelo caminho inteiro', () => {
  const VALUES = [
    undefined, null, NaN, Infinity, -Infinity, 0, -0, 1, -1, 0.5, 1e308, -1e308, 2437, 5180, 5955, 60480, -57, 12, 99, 200, -127,
    '', ' ', 'abc', '-57', '2437', 'aa:bb:cc:dd:ee:ff', 'AA-BB-CC-DD-EE-FF', '<img src=x onerror=alert(1)>', '\u0000\u0001\u001f', '😀📶',
    true, false, [], {}, [NaN], [null],
    [{ id: 'x', ext: null, hex: 'zz' }], [{ id: 255, ext: 35, hex: 'abc' }], [{ id: 48, hex: '0100' }, { id: 221, hex: '0050f204' }, { id: 201, hex: 'ff' }, { id: 45, hex: 7 }, { hex: 'dd' }, 'solto'],
    '[WPA2-', '[][][', ']]]', '[RSN-?-?][ESS', 'x'.repeat(3000),
  ];
  const FIELDS = ['bssid', 'ssid', 'level', 'frequency', 'channelWidth', 'centerFreq0', 'centerFreq1', 'capabilities', 'ageMs', 'wifiStandard', 'rttResponder', 'passpoint', 'venueName', 'operatorName', 'mld', 'ies'];
  // Uma varredura pequena mas com de tudo: a casa (2,4 e 5 GHz), vizinhos e redes no mesmo rádio
  const BASE = { ...apartment, aps: apartment.aps.slice(0, 6) };

  for (const field of FIELDS) {
    test(`ScanAp.${field} com lixo (em um AP e em todos)`, () => {
      VALUES.forEach((value, n) => {
        const fail = (stepName, err) => assert.fail(`${field} = ${show(value)}: ${stepName} lançou ${err && err.stack}`);
        // no AP da casa (o conectado, o "own" das análises): caminho completo a cada três valores
        const one = { ...BASE, aps: [{ ...BASE.aps[0], [field]: value }, ...BASE.aps.slice(1)] };
        checkOutput(pipeline(one, { fail, light: n % 3 !== 0 }), `${field} = ${show(value)} (um)`);
        // em todos os APs de uma vez (um valor sim, um não: o caso acima já cobre cada valor)
        if (n % 2 === 1) return;
        const all = { ...BASE, aps: BASE.aps.map((ap) => ({ ...ap, [field]: value })) };
        checkOutput(pipeline(all, { fail, light: true }), `${field} = ${show(value)} (todos)`);
      });
    });
  }

  test('ScanEvent com lixo: o evento, `aps`, `ts` e itens soltos na lista', () => {
    for (const value of VALUES) {
      const fail = (stepName, err) => assert.fail(`evento ${show(value)}: ${stepName} lançou ${err && err.stack}`);
      checkOutput(pipeline(value, { fail }), `evento = ${show(value)}`);
      checkOutput(pipeline({ ts: TS, aps: value }, { fail }), `aps = ${show(value)}`);
      checkOutput(pipeline({ ...BASE, ts: value }, { fail, light: true }), `ts = ${show(value)}`);
      checkOutput(pipeline({ ...BASE, aps: [value, value, ...BASE.aps] }, { fail }), `item = ${show(value)}`);
    }
  });

  test('DeviceInfo e Connection com lixo', () => {
    // Só as análises que olham para o celular e para a conexão (o resto do caminho não os vê)
    const aps = normalizeScan(BASE, { sdk: 34 });
    const base = connectionTo(BASE.aps[0]);
    const run = (label, device, connection) => {
      const out = {};
      try {
        const connectionBssid = connection !== null && typeof connection === 'object' ? connection.bssid : connection;
        out.profile = core.clientProfile(device);
        out.scoreAp = scoreAp(aps[1], { aps, device, connectionBssid });
        out['rankNetworks conectado'] = rankNetworks(aps, { device, connectionBssid, favorites: connection });
        out.advise = advise(out['rankNetworks conectado'], { connectionBssid, favorites: connection });
        out.insights = buildInsights({ aps, connection, device, status: connection });
        out.status = buildInsights({ aps, connection: base, device: PHONE, status: { throttled: connection, canScan: device } });
      } catch (err) {
        assert.fail(`${label} lançou ${err && err.stack}`);
      }
      delete out.profile.supports;
      checkOutput(out, label);
    };
    for (const value of VALUES) {
      const devices = [value, { ...PHONE, bands: value }, { ...PHONE, bands: { b24: value, b5: value, b6: value, b60: value } }, { ...PHONE, standards: value }, { ...PHONE, standards: [value, value] }, { ...PHONE, sdk: value }];
      for (const device of devices) run(`device ${show(device)}`, device, base);
      run(`connection = ${show(value)}`, PHONE, value);
      for (const key of Object.keys(base)) run(`connection.${key} = ${show(value)}`, PHONE, { ...base, [key]: value });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Casos de campo
// ---------------------------------------------------------------------------

describe('casos de campo', () => {
  const home = apartment.aps[0];
  const norm = (more) => normalizeAp({ ...home, ...more }, { ts: TS, sdk: 34 });

  test('sanitizeRssi: só dBm negativo acima de −127 vale como medida', () => {
    for (const ok of [-1, -0.5, -30, -57, -99.5, -126, '-57', ' -80 ']) assert.equal(sanitizeRssi(ok), Number(ok), show(ok));
    for (const bad of [0, -0, 1, 25, 200, -127, -128, -200, 1e308, -1e308, NaN, Infinity, -Infinity, null, undefined, '', ' ', 'forte', true, [], {}]) {
      assert.equal(sanitizeRssi(bad), null, show(bad));
    }
  });

  test('sinal 0, positivo ou −127 vira "sem leitura", não "excelente"', () => {
    for (const level of [0, 5, 25, 200, -127, -300, 1e308, null, undefined, 'x']) {
      const ap = norm({ level });
      assert.equal(ap.rssi, null, show(level));
      assert.equal(ap.quality, 0);
      assert.equal(ap.level.key, 'unknown');
      assert.equal(ap.distanceM, null);
    }
    assert.equal(norm({ level: '-57' }).rssi, -57, 'texto numérico é aceito');
    assert.equal(norm({ level: -57 }).level.key, 'great');
  });

  test('um AP com sinal impossível não sobe no ranking nem estraga a nota dos canais', () => {
    const junk = [
      { ...home, bssid: '00:11:22:33:44:55', ssid: 'Lixo zero', level: 0 },
      { ...home, bssid: '00:11:22:33:44:66', ssid: 'Lixo positivo', level: 40 },
      { ...home, bssid: '00:11:22:33:44:77', ssid: 'Lixo enorme', level: 1e308 },
    ];
    const clean = normalizeScan(apartment);
    const dirty = normalizeScan({ ...apartment, aps: [...junk, ...apartment.aps] });

    for (const band of ['2.4', '5']) assert.deepEqual(rateChannels(dirty, { band }), rateChannels(clean, { band }), `notas de ${band} GHz`);
    assert.deepEqual(channelGraph(dirty, '2.4'), channelGraph(clean, '2.4'));

    const ranking = rankNetworks(dirty, { device: PHONE });
    for (const name of ['Lixo zero', 'Lixo positivo', 'Lixo enorme']) {
      const row = ranking.find((r) => r.ssid === name);
      assert.equal(row.score, 0, name);
      assert.equal(row.detail.usable, false, name);
    }
    assert.ok(ranking[0].score > 0 && !ranking[0].ssid.startsWith('Lixo'));
    // quem não é lixo fica na mesma ordem e com as mesmas notas
    const strip = (rows) => rows.filter((r) => !r.ssid.startsWith('Lixo')).map((r) => [r.key, r.score, r.estMbps]);
    assert.deepEqual(strip(ranking), strip(rankNetworks(clean, { device: PHONE })));
  });

  test('frequência 0, negativa, fora de canal ou em texto', () => {
    for (const frequency of [0, -2437, 1, 99999, NaN, null, 'abc']) {
      const ap = norm({ frequency });
      assert.equal(ap.band, null, show(frequency));
      assert.equal(ap.channel, null);
      assert.equal(typeof ap.occ.label, 'string');
      assert.deepEqual(rateChannels([ap], { band: '2.4' }).map((r) => r.score), new Array(13).fill(100), 'não conta como vizinho');
    }
    const off = norm({ frequency: 2438 }); // dentro da faixa, mas não é centro de canal nenhum
    assert.equal(off.band, '2.4');
    assert.equal(off.channel, null);
    assert.equal(norm({ frequency: '2437' }).channel, 6, 'texto numérico é aceito');
  });

  test('channelWidth 99 (ou qualquer valor fora de 0..5) é tratado como 20 MHz presumidos', () => {
    for (const channelWidth of [99, -1, 6, 2.5, NaN, null, 'largo', {}]) {
      const ap = norm({ channelWidth });
      assert.equal(ap.widthMHz, 20, show(channelWidth));
      assert.equal(ap.occ.approx, true);
      assert.equal(ap.channel, 6);
    }
  });

  test('capabilities vazio ou ilegível é segurança "Desconhecida", nunca "Aberta"', () => {
    for (const capabilities of ['', ' ', undefined, null, 7, [], '???', '[', 'x'.repeat(2000)]) {
      const { security } = normalizeAp({ ...home, capabilities, ies: undefined });
      assert.equal(security.known, false, show(capabilities));
      assert.equal(security.label, 'Desconhecida');
      assert.equal(security.open, false);
      assert.deepEqual(security.issues, []);
    }
    assert.equal(normalizeAp({ ...home, capabilities: '[ESS]', ies: undefined }).security.label, 'Aberta');
  });

  test('ies: hexadecimal ímpar, caracteres estranhos e tipos errados são só ignorados', () => {
    const good = { id: 3, ext: 0, hex: '06' };
    const junk = [
      { id: 45, ext: 0, hex: 'abc' }, // ímpar
      { id: 45, ext: 0, hex: 'zz11' }, // não é hexadecimal
      { id: 48, ext: 0, hex: 7 },
      { id: 48, ext: 0, hex: null },
      { id: 221, ext: 0, hex: {} },
      { id: 'x', ext: 0, hex: '00' },
      { id: 999, ext: 0, hex: '00' },
      { id: -1, ext: 0, hex: '00' },
      { id: 255, ext: 'y', hex: '' },
      { id: 201, ext: 0, hex: 'ffffffff' },
      { id: 48, ext: 0, hex: '0100000fac040200' }, // RSN que promete mais do que traz
      null,
      undefined,
      7,
      'texto',
      [],
    ];
    const info = parseIes([...junk, good, ...junk]);
    assert.deepEqual(info.ds, { channel: 6 });
    assert.equal(info.rsn, undefined);
    assert.equal(info.ht, undefined);
    assert.deepEqual(nonFinite(info), []);
    assert.deepEqual(nonFinite(summarizeIes(info)), []);

    const ap = normalizeAp({ ...home, ies: junk });
    assert.equal(ap.channel, 6);
    assert.equal(ap.security.label, 'WPA2/WPA3', 'sem elementos úteis vale o texto de capabilities');
    for (const ies of ['0102', 7, {}, null, [[]], [null]]) assert.equal(normalizeAp({ ...home, ies }).ie, null, show(ies));
  });

  test('BSSID em maiúsculas ou com traços é o mesmo BSSID; o resto não é BSSID', () => {
    const a = norm({ bssid: 'AA:BB:CC:DD:EE:0F' });
    const b = norm({ bssid: 'aa-bb-cc-dd-ee-0f' });
    const c = norm({ bssid: ' Aa-bB-cC-Dd-eE-0F ' });
    for (const ap of [a, b, c]) assert.equal(ap.id, 'aa:bb:cc:dd:ee:0f');

    const scan = normalizeScan({ ts: TS, aps: [{ ...home, bssid: 'AA:BB:CC:DD:EE:0F', ageMs: 900 }, { ...home, bssid: 'aa-bb-cc-dd-ee-0f', ageMs: 100, level: -70 }] });
    assert.equal(scan.length, 1, 'as duas grafias são um AP só');
    assert.equal(scan[0].rssi, -70, 'fica a leitura mais nova');

    const tracker = new ApTracker();
    tracker.update({ ts: TS, fresh: true, aps: [{ ...home, bssid: 'AA-BB-CC-DD-EE-0F' }] });
    assert.equal(tracker.get('aa:bb:cc:dd:ee:0f').id, 'aa:bb:cc:dd:ee:0f');
    assert.equal(tracker.get('AA:BB:CC:DD:EE:0F').id, 'aa:bb:cc:dd:ee:0f');
    assert.equal(rankNetworks(scan, { connectionBssid: 'AA-BB-CC-DD-EE-0F' })[0].connected, true);

    for (const bssid of ['', 'aabbccddeeff', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:fg', 5, null, undefined, {}]) {
      assert.equal(norm({ bssid }).id, '', show(bssid));
      assert.deepEqual(normalizeScan({ ts: TS, aps: [{ ...home, bssid }] }), [], 'lixo não vira rede');
    }
  });

  test('BSSID repetido na mesma varredura: uma entrada só, em todas as análises', () => {
    const twice = { ...apartment, aps: [...apartment.aps, ...apartment.aps.map((ap) => ({ ...ap, ageMs: ap.ageMs + 5000, level: -95 }))] };
    const once = normalizeScan(apartment);
    const aps = normalizeScan(twice);
    assert.equal(aps.length, once.length);
    assert.equal(snapshot(aps), snapshot(once), 'vale a leitura mais nova de cada BSSID');
    assert.equal(new Set(groupByDevice(aps).flatMap((d) => d.bssids)).size, once.length);
    assert.equal(snapshot(rankNetworks(twice.aps, { device: PHONE })), snapshot(rankNetworks(apartment.aps, { device: PHONE })), 'também a partir da lista crua');
    assert.equal(snapshot(rateChannels(twice.aps, { band: '2.4' })), snapshot(rateChannels(apartment.aps, { band: '2.4' })));
    const tracker = new ApTracker();
    assert.equal(tracker.update(twice).total, once.length);
  });

  test('nome de rede com emoji, caracteres de controle ou HTML passa intacto (o core não monta HTML)', () => {
    const names = ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', '😀📶 Wi-Fi da Vó', 'a\u0001b\u001f\u007fc', 'linha\nquebrada\ttab', '‮odatrevni', '&amp; &lt;b&gt;', "'; DROP TABLE aps;--", '   ', 'x'.repeat(300)];
    names.forEach((ssid, i) => {
      const bssid = `00:11:22:33:44:${hex2(i)}`;
      const event = { ts: TS, fresh: true, aps: [{ ...home, bssid, ssid }, ...apartment.aps.slice(2, 6)] };
      const ap = normalizeScan(event).find((x) => x.id === bssid);
      assert.equal(ap.ssid, ssid);
      assert.equal(ap.name, ssid);
      assert.equal(ap.hidden, false);

      const ranking = rankNetworks(event.aps, { device: PHONE, connectionBssid: bssid, favorites: [ssid] });
      const row = ranking.find((r) => r.best.id === bssid);
      assert.equal(row.name, ssid);
      assert.equal(groupBySsid(event.aps).find((n) => n.best.id === bssid).name, ssid);
      assert.equal(groupByDevice(event.aps).find((d) => d.bssids.includes(bssid)).ssids[0], ssid);
      assert.equal(channelGraph(event.aps, '2.4').shapes.find((s) => s.bssid === bssid).ssid, ssid);

      // Onde o nome entra numa frase, entra como veio: sem escapar, sem cortar
      const said = [advise(ranking, { connectionBssid: bssid }), advise(rankNetworks(event.aps, { device: PHONE, favorites: [ssid] }), { favorites: [ssid] })];
      said.push(...buildInsights({ aps: event.aps, connection: connectionTo(event.aps[0]), device: PHONE }));
      const texts = said.flatMap((x) => [x.headline, x.title, x.text]).filter((t) => typeof t === 'string');
      assert.ok(texts.some((t) => t.includes(`“${ssid}”`)), `nenhuma frase cita ${show(ssid)}`);
      for (const text of texts) {
        const rest = text.split(ssid).join('');
        assert.ok(!/&lt;|&gt;|&amp;|&quot;|&#\d/.test(rest), `o core escapou HTML: ${text}`);
        assert.ok(!/<[a-z!/]/i.test(rest), `o core escreveu marcação: ${text}`);
      }
    });
  });

  test('nome de aparelho hostil dentro do WPS também passa intacto', () => {
    const deviceName = '<b onmouseover=alert(1)>TV</b> 😀';
    const ies = encodeIes({ frequency: 2437, ht: { nss: 2 }, wps: { deviceName, manufacturer: '<i>ACME</i>', model: 'X&Y' } });
    const ap = normalizeAp({ ...home, ies });
    assert.equal(ap.ie.wps.deviceName, deviceName);
    assert.equal(ap.ie.wps.manufacturer, '<i>ACME</i>');
    assert.equal(ap.ie.wps.model, 'X&Y');
  });

  test('ScanEvent sem aps (ou sem nada) é uma varredura vazia', () => {
    for (const event of [{}, { ts: TS }, { ts: TS, fresh: true, source: 'cache' }, { aps: null }, null, undefined, 'x', 7, []]) {
      assert.deepEqual(normalizeScan(event), [], show(event));
      const tracker = new ApTracker({ clock: () => TS });
      assert.deepEqual(tracker.update(event), { heard: 0, added: 0, total: 0 });
      assert.deepEqual(tracker.list(), []);
    }
    assert.deepEqual(rankNetworks([]), []);
    assert.deepEqual(groupByDevice([]), []);
    assert.deepEqual(groupBySsid([]), []);
    assert.equal(advise([]).kind, 'no-connection');
    assert.deepEqual(buildInsights({}), []);
    assert.deepEqual(rateChannels([], { band: '5', widthMHz: 80 }).map((r) => r.score), [100, 100, 100, 100, 100, 100, 100]);
    assert.equal(recommendChannel([], { band: '2.4' }).verdict, 'change');
    assert.equal(channelGraph([], '6').shapes.length, 0);
  });

  test('500 APs numa varredura: tudo responde, com uma entrada por BSSID', () => {
    const event = randomScan(500, 11);
    const fail = (stepName, err) => assert.fail(`${stepName} lançou ${err && err.stack}`);
    const out = pipeline(event, { fail });
    checkOutput(out, '500 APs');
    const unique = new Set(event.aps.map((ap) => ap.bssid)).size;
    assert.equal(out.normalizeScan.length, unique);
    assert.equal(out.groupByDevice.reduce((sum, d) => sum + d.aps.length, 0), unique);
    assert.equal(out.groupBySsid.reduce((sum, net) => sum + net.aps.length, 0), unique);
    assert.equal(out['rankNetworks solto'].reduce((sum, row) => sum + 1 + row.others.length, 0), unique);
    assert.equal(out.ApTracker.size, unique);
  });

  test('interferenceFactor: sempre entre 0 e 1, mesmo com trechos absurdos', () => {
    const r = rng(5);
    const values = [2400, 2412, 2422, 2484, 5170, 5250, 5955, 7125, 0, -5, 3, 2401.3, 1e9, 1e308, -1e308, Infinity, -Infinity, NaN, '2412', null, undefined, 'x'];
    const pick = () => values[Math.floor(r() * values.length)];
    for (let i = 0; i < 20000; i++) {
      const seg = () => ({ lo: pick(), hi: pick() });
      const tx = i % 3 === 0 ? seg() : { segments: i % 3 === 1 ? [seg()] : [seg(), seg()] };
      const f = i % 5 === 0 ? interferenceFactor(tx, { segments: [seg(), seg()] }) : interferenceFactor(tx, pick(), pick());
      assert.ok(f >= 0 && f <= 1, `${show(tx)} -> ${f}`);
    }
    assert.equal(interferenceFactor({ lo: -1e308, hi: 1e308 }, 2400, 2500), 0);
    assert.deepEqual(segmentsOf({ segments: [null, { lo: 'a', hi: 3 }, { lo: 5, hi: 5 }, { lo: '2400', hi: 2420 }, { lo: 1, hi: Infinity }] }), [{ lo: 2400, hi: 2420 }]);
  });
});

// ---------------------------------------------------------------------------
// 3. Propriedades em varreduras aleatórias
// ---------------------------------------------------------------------------

describe('propriedades em varreduras aleatórias', () => {
  const EVENTS = [apartment, mesh, office, wifi7];
  for (let seed = 1; seed <= 14; seed++) EVENTS.push(randomScan(15 + ((seed * 37) % 110), seed, { ies: seed % 3 !== 0 }));

  const shuffled = (list, seed) => {
    const r = rng(seed);
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  test('notas, porcentagens, distâncias e velocidades dentro da escala', () => {
    EVENTS.forEach((event, n) => {
      const fail = (stepName, err) => assert.fail(`varredura ${n}: ${stepName} lançou ${err && err.stack}`);
      for (const device of [PHONE, OLD_PHONE, undefined]) {
        const out = pipeline(event, { device, fail });
        checkOutput(out, `varredura ${n}`);
        for (const ap of out.normalizeScan) {
          assert.ok(ap.utilization === null || (ap.utilization >= 0 && ap.utilization <= 1));
          assert.ok(ap.stations === null || ap.stations >= 0);
        }
        for (const row of out['rankNetworks conectado']) {
          const d = row.detail;
          assert.ok(d.share === null || (d.share >= 0 && d.share <= 1), `share ${d.share}`);
          assert.ok(d.busy === null || (d.busy >= 0 && d.busy <= 1), `busy ${d.busy}`);
          assert.ok(d.cap >= 0 && d.cap <= 100);
          assert.ok(d.channelScore === null || (d.channelScore >= 0 && d.channelScore <= 100));
          assert.ok(d.linkMbps === null || d.linkMbps >= (row.estMbps ?? 0), 'a disputa pelo canal só tira velocidade');
          assert.equal(d.usable, row.score > 0 || (row.estMbps !== null && row.estMbps > 0));
        }
        for (const text of ['2.4', '5', '6'].map((band) => out[`recommendChannel ${band}`])) {
          assert.ok(text.gain === null || (text.gain >= -100 && text.gain <= 100));
        }
      }
    });
  });

  test('rankings ordenados, e com desempate fixo', () => {
    for (const event of EVENTS) {
      const aps = normalizeScan(event);
      const ranking = rankNetworks(aps, { device: PHONE });
      for (let i = 1; i < ranking.length; i++) {
        assert.ok(ranking[i - 1].score >= ranking[i].score, 'ranking do maior para o menor');
        if (ranking[i - 1].score === ranking[i].score && ranking[i - 1].estMbps === ranking[i].estMbps) {
          const strength = (row) => row.best.rssiSmooth ?? row.best.rssi ?? -Infinity;
          assert.ok(strength(ranking[i - 1]) > strength(ranking[i]) || ranking[i - 1].key < ranking[i].key, 'empate decidido pelo sinal e depois pela chave');
        }
        for (let k = 1; k < ranking[i].others.length; k++) assert.ok(ranking[i].others[k - 1].score >= ranking[i].others[k].score);
      }
      for (const band of ['2.4', '5', '6']) {
        const top = recommendChannel(aps, { band }).ranking;
        const policy = (r) => r.score - (r.dfs ? 5 : 0);
        for (let i = 1; i < top.length; i++) assert.ok(policy(top[i - 1]) >= policy(top[i]), 'canais do melhor para o pior');
      }
      const devices = groupByDevice(aps);
      for (let i = 1; i < devices.length; i++) assert.ok((devices[i - 1].bestRssi ?? -Infinity) >= (devices[i].bestRssi ?? -Infinity));
      const networks = groupBySsid(aps);
      for (let i = 1; i < networks.length; i++) assert.ok((networks[i - 1].best.rssi ?? -Infinity) >= (networks[i].best.rssi ?? -Infinity));
      const insights = buildInsights({ aps, connection: connectionTo(event.aps[0]), device: PHONE });
      const order = { critical: 0, warning: 1, info: 2, good: 3 };
      for (let i = 1; i < insights.length; i++) assert.ok(order[insights[i - 1].severity] <= order[insights[i].severity]);
      assert.equal(new Set(insights.map((x) => x.id)).size, insights.length, 'cada aviso uma vez só');
    }
  });

  test('mesma entrada, mesma saída; e a ordem da lista não muda o resultado', () => {
    EVENTS.forEach((event, n) => {
      const connectionBssid = event.aps[0].bssid;
      const run = (aps) => {
        const list = normalizeScan({ ...event, aps });
        const byId = (items) => items.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
        return {
          aps: snapshot(byId(list)),
          devices: snapshot(groupByDevice(list)),
          networks: snapshot(groupBySsid(list)),
          channels: snapshot(['2.4', '5', '6'].map((band) => [rateChannels(list, { band }), recommendChannel(list, { band, own: list.find((ap) => ap.id === connectionBssid) }), recommendWidth(list, band)])),
          ranking: snapshot(rankNetworks(list, { device: PHONE, connectionBssid })),
          advice: snapshot(advise(rankNetworks(list, { device: PHONE, connectionBssid }), { connectionBssid })),
          insights: snapshot(buildInsights({ aps: list, connection: connectionTo(event.aps[0]), device: PHONE })),
          graph: snapshot(channelGraph(list, '2.4')),
        };
      };
      const first = run(event.aps);
      assert.deepEqual(run(event.aps), first, `varredura ${n}: duas chamadas iguais`);
      assert.deepEqual(run(event.aps.slice().reverse()), first, `varredura ${n}: lista invertida`);
      assert.deepEqual(run(shuffled(event.aps, n + 1)), first, `varredura ${n}: lista embaralhada`);
    });
  });

  test('nada consulta o relógio nem sorteia números (fora o relógio injetado do ApTracker)', () => {
    const realNow = Date.now;
    const realRandom = Math.random;
    const RealDate = globalThis.Date;
    let calls = 0;
    Date.now = () => {
      calls += 1;
      return realNow.call(RealDate);
    };
    Math.random = () => {
      calls += 1;
      return realRandom();
    };
    try {
      for (const event of EVENTS.slice(0, 6)) {
        const fail = (stepName, err) => assert.fail(`${stepName} lançou ${err && err.stack}`);
        pipeline(event, { fail });
        pipeline({ ...event, ts: undefined }, { fail }); // sem `ts`: o ApTracker usa o relógio que recebeu
        parseCapabilities(event.aps[0].capabilities);
        occupancy(event.aps[0]);
        encodeIes({ frequency: 5180, ht: { nss: 2 }, vht: { nss: 2 } });
      }
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
    assert.equal(calls, 0);

    // O relógio só entra quando a varredura chega sem `ts`, e é o que foi injetado
    let ticks = 0;
    const tracker = new ApTracker({ clock: () => TS + 1000 * ticks++ });
    tracker.update({ fresh: true, aps: apartment.aps });
    assert.equal(tracker.lastTs, TS);
    tracker.update({ ts: TS + 500, fresh: true, aps: apartment.aps });
    assert.equal(ticks, 1, 'com `ts` no evento o relógio não é consultado');
  });

  test('as entradas saem como entraram (tudo congelado)', () => {
    for (const source of EVENTS.slice(0, 8)) {
      const event = deepFreeze(JSON.parse(JSON.stringify(source)));
      const before = JSON.stringify(event);
      const fail = (stepName, err) => assert.fail(`${stepName} alterou a entrada: ${err && err.stack}`);
      pipeline(event, { fail });
      assert.equal(JSON.stringify(event), before);

      // ...e os objetos já normalizados também
      const aps = deepFreeze(normalizeScan(event, { sdk: 34 }));
      const frozen = snapshot(aps);
      const own = aps[0];
      const devices = deepFreeze(groupByDevice(aps));
      const networks = deepFreeze(groupBySsid(aps, { devices }));
      for (const band of ['2.4', '5', '6']) {
        rateChannels(aps, deepFreeze({ band, exclude: [own.id], devices }));
        recommendChannel(aps, deepFreeze({ band, own, devices }));
        recommendWidth(aps, band, deepFreeze({ own, devices }));
        channelGraph(aps, band);
      }
      rateOwnChannel(aps, deepFreeze({ own, devices }));
      const context = scoringContext(aps, deepFreeze({ device: PHONE, connectionBssid: own.id }));
      scoreAp(own, { context });
      scoreAp(own, deepFreeze({ aps, device: PHONE }));
      const ranking = deepFreeze(rankNetworks(aps, deepFreeze({ device: PHONE, connectionBssid: own.id, favorites: [own.ssid] })));
      advise(ranking, deepFreeze({ connectionBssid: own.id, favorites: [own.ssid] }));
      buildInsights(deepFreeze({ aps, connection: connectionTo(event.aps[0]), device: PHONE, status: { throttled: true } }));
      const info = deepFreeze(parseIes(event.aps[0].ies));
      summarizeIes(info);
      refineWithIes(deepFreeze(parseCapabilities(event.aps[0].capabilities)), info);
      assert.equal(snapshot(aps), frozen);
      assert.ok(networks.length > 0);
    }
  });

  test('`devices` pronto dá exatamente o mesmo resultado que agrupar de novo', () => {
    for (const event of EVENTS) {
      const aps = normalizeScan(event);
      const devices = groupByDevice(aps);
      const own = aps[Math.floor(aps.length / 2)];
      assert.equal(snapshot(groupBySsid(aps, { devices })), snapshot(groupBySsid(aps)));
      for (const band of ['2.4', '5', '6']) {
        for (const widthMHz of [20, 40, 80]) {
          assert.equal(snapshot(rateChannels(aps, { band, widthMHz, exclude: [own.id], devices })), snapshot(rateChannels(aps, { band, widthMHz, exclude: [own.id] })));
        }
        assert.equal(snapshot(recommendChannel(aps, { band, own, devices })), snapshot(recommendChannel(aps, { band, own })));
        assert.equal(snapshot(recommendWidth(aps, band, { own, devices })), snapshot(recommendWidth(aps, band, { own })));
      }
      // `devices` com defeito é ignorado, não é motivo para quebrar
      for (const junk of [7, 'x', [null], [{}], [{ aps: 'x', bssids: [] }]]) {
        assert.equal(snapshot(rateChannels(aps, { band: '2.4', devices: junk })), snapshot(rateChannels(aps, { band: '2.4' })), show(junk));
      }
    }
  });

  test('rateOwnChannel é o `current` de recommendChannel, para qualquer AP da lista', () => {
    for (const event of EVENTS) {
      const aps = normalizeScan(event);
      const devices = groupByDevice(aps);
      for (const own of aps) {
        for (const widthMHz of [undefined, 20]) {
          const expected = own.band === '60' || own.band === null ? null : recommendChannel(aps, { band: own.band, own, widthMHz }).current;
          assert.equal(snapshot(rateOwnChannel(aps, { own, widthMHz, devices })), snapshot(expected), `${own.id} ${widthMHz}`);
          assert.equal(snapshot(rateOwnChannel(aps, { own, widthMHz })), snapshot(expected));
        }
      }
      // um AP que não está na lista entra na conta do mesmo jeito
      const outsider = aps[0];
      const rest = aps.slice(1);
      assert.equal(
        snapshot(rateOwnChannel(rest, { own: outsider, devices: groupByDevice(rest) })),
        snapshot(recommendChannel(rest, { band: outsider.band, own: outsider }).current),
      );
    }
    for (const junk of [undefined, null, {}, { own: null }, { own: {} }, { own: 'x' }, { own: { frequency: 60480 } }]) assert.equal(rateOwnChannel(apartment.aps, junk), null, show(junk));
  });

  test('as duas formas de passar a faixa dão o mesmo resultado', () => {
    const aps = normalizeScan(apartment);
    const own = aps[0];
    for (const band of ['2.4', '5', '6']) {
      assert.deepEqual(rateChannels(aps, band, { widthMHz: 40 }), rateChannels(aps, { band, widthMHz: 40 }));
      assert.deepEqual(rateChannels(aps, band), rateChannels(aps, { band }));
      assert.deepEqual(recommendChannel(aps, band, { own }), recommendChannel(aps, { band, own }));
      assert.deepEqual(recommendWidth(aps, { band, own }), recommendWidth(aps, band, { own }));
      assert.deepEqual(channelGraph(aps, { band }), channelGraph(aps, band));
    }
    assert.deepEqual(rateChannels(aps, 'x'), []);
    assert.equal(recommendWidth(aps).widthMHz, null);
    assert.equal(channelGraph(aps).band, null);
  });
});

// ---------------------------------------------------------------------------
// 4. Memória
// ---------------------------------------------------------------------------

describe('memória', () => {
  /** Uma varredura barata: `count` APs novos a cada chamada (MACs de celular: nunca se repetem). */
  const churn = (round, count, ts) => ({
    ts,
    fresh: true,
    aps: Array.from({ length: count }, (_, i) => {
      const n = round * count + i;
      return { bssid: `02:00:${hex2(n >> 24)}:${hex2(n >> 16)}:${hex2(n >> 8)}:${hex2(n)}`, ssid: `Celular ${n}`, level: -50 - (n % 40), frequency: 2437, channelWidth: 0, capabilities: '[WPA2-PSK-CCMP][ESS]', ageMs: 0 };
    }),
  });
  const stable = { bssid: '98:da:c4:3b:7e:10', ssid: 'Casa', frequency: 2437, channelWidth: 0, capabilities: '[WPA2-PSK-CCMP][ESS]', ageMs: 0 };

  test('ApTracker: 10 000 varreduras com BSSIDs sempre novos não crescem sem limite', () => {
    const tracker = new ApTracker({ historyMs: 600_000, maxAps: 300, maxSamples: 50 });
    let peak = 0;
    for (let round = 0; round < 10_000; round++) {
      const ts = TS + round * 3000;
      const event = churn(round, 6, ts);
      event.aps.push({ ...stable, level: -50 - (round % 7) });
      const result = tracker.update(event);
      peak = Math.max(peak, result.total);
      assert.equal(result.total, tracker.size);
    }
    assert.ok(peak <= 300, `pico de ${peak} BSSIDs`);
    assert.ok(tracker.size <= 300);
    const home = tracker.get(stable.bssid);
    assert.equal(home.seenCount, 10_000, 'quem continua sendo ouvido não é despejado');
    assert.equal(tracker.history(stable.bssid).length, 50, 'histórico limitado a maxSamples');
    assert.ok(tracker.list().length <= 300);
    assert.deepEqual(nonFinite(tracker.list()), []);
  });

  test('ApTracker: relógio parado (o mesmo ts sempre) também tem teto', () => {
    const tracker = new ApTracker({ maxAps: 200 });
    for (let round = 0; round < 10_000; round++) {
      const event = churn(round, 3, TS);
      if (round % 100 === 0) event.aps.push({ ...stable, level: -60 });
      tracker.update(event);
      if (round % 1000 === 999) assert.ok(tracker.size <= 200, `rodada ${round}: ${tracker.size}`);
    }
    assert.ok(tracker.size <= 200);
    for (const ap of tracker.list({ maxAgeMs: Infinity })) assert.ok(tracker.history(ap.id).length <= 600);
  });

  test('ApTracker: teto padrão de 1000 BSSIDs; os mais antigos saem primeiro', () => {
    const tracker = new ApTracker();
    for (let round = 0; round < 60; round++) tracker.update(churn(round, 40, TS + round * 1000));
    assert.equal(tracker.size, 1000);
    const kept = tracker.list({ maxAgeMs: Infinity }).map((ap) => ap.lastSeen);
    assert.ok(Math.min(...kept) >= TS + 35 * 1000, 'ficaram as 25 varreduras mais recentes');
    for (const options of [{ maxAps: 0 }, { maxAps: -5 }, { maxAps: NaN }, { maxAps: 'x' }]) {
      const t = new ApTracker(options);
      t.update(churn(0, 30, TS));
      assert.equal(t.size, 30, `${show(options)} cai no padrão`);
    }
    const tiny = new ApTracker({ maxAps: 1.9 });
    tiny.update(churn(0, 30, TS));
    assert.equal(tiny.size, 1);
  });

  test('groupByDevice: a resposta guardada é conferida e devolvida como cópia', () => {
    const aps = normalizeScan(apartment);
    const first = groupByDevice(aps);
    const again = groupByDevice(aps);
    assert.deepEqual(again, first);
    assert.notEqual(again, first);

    // estragar o que foi devolvido não estraga a próxima resposta
    const expected = snapshot(first);
    first.length = 0;
    again[0].aps.length = 0;
    again[0].bssids.push('lixo');
    again[0].ssids.length = 0;
    again.reverse();
    assert.equal(snapshot(groupByDevice(aps)), expected);

    // um campo que muda dentro de um Ap (mesmo objeto, mesma lista) é percebido
    const copy = aps.map((ap) => ({ ...ap }));
    const before = groupByDevice(copy);
    const twoBands = before.find((d) => d.aps.length > 1);
    const moved = twoBands.aps[0];
    moved.bssid = '0a:0b:0c:0d:0e:0f';
    moved.id = moved.bssid;
    const after = groupByDevice(copy);
    assert.ok(after.some((d) => d.bssids.length === 1 && d.bssids[0] === '0a:0b:0c:0d:0e:0f'), 'o AP alterado virou um aparelho à parte');
    assert.equal(snapshot(after), snapshot(groupByDevice(copy.map((ap) => ({ ...ap })))), 'igual a agrupar do zero');

    // trocar um item da lista, ou a ordem, também
    const swapped = aps.slice();
    swapped[3] = { ...swapped[3], rssi: -20 };
    assert.equal(snapshot(groupByDevice(swapped)), snapshot(groupByDevice(swapped.map((ap) => ({ ...ap })))));
    assert.equal(groupByDevice(aps.slice(0, 5)).reduce((sum, d) => sum + d.aps.length, 0), 5);
  });

  test('interferenceFactor: a memória não muda nenhum valor, nem depois de encher e esvaziar', () => {
    const sample = [];
    for (const [lo, hi] of [[2402, 2422], [2427, 2447], [2422, 2462], [5170, 5250], [5490, 5650], [5945, 6265]]) {
      for (const [rxLo, rxHi] of [[2402, 2422], [2412, 2432], [2452, 2472], [5170, 5190], [5250, 5330], [5945, 5965], [6105, 6425]]) sample.push([lo, hi, rxLo, rxHi]);
    }
    const before = sample.map(([lo, hi, a, b]) => interferenceFactor({ segments: [{ lo, hi }] }, a, b));
    assert.equal(before[0], interferenceFactor({ lo: 2402, hi: 2422 }, 2402, 2422));
    assert.ok(before[0] > 0.98 && before[0] < 1, 'mesmo canal');
    assert.ok(before[1] > 0.4 && before[1] < 0.6, 'meio canal de sobreposição');
    assert.equal(interferenceFactor({ lo: 2402, hi: 2422 }, 2422, 2402), before[0], 'limites invertidos');
    // dezenas de milhares de pares diferentes: passa do teto da memória várias vezes
    for (let i = 0; i < 60000; i++) {
      const lo = 2000 + (i % 3000);
      const f = interferenceFactor({ lo, hi: lo + 20 + 20 * (i % 4) }, 2400 + (i % 97), 2420 + (i % 97) + (i % 5));
      assert.ok(f >= 0 && f <= 1);
    }
    assert.deepEqual(sample.map(([lo, hi, a, b]) => interferenceFactor({ segments: [{ lo, hi }] }, a, b)), before);
    // o caminho geral (texto numérico não passa pela memória) dá o mesmo número
    const general = ([lo, hi, a, b]) => interferenceFactor({ segments: [{ lo: String(lo), hi: String(hi) }] }, String(a), String(b));
    assert.deepEqual(sample.map(general), before);
    // ...também para canais de larguras diferentes com o mesmo centro e para bandas vizinhas,
    // os pares mais fáceis de confundir numa chave de memória malfeita
    for (const center of [2412, 2437, 5210, 5250, 6025]) {
      for (const width of [20, 40, 80, 160]) {
        for (const rxCenter of [center - 40, center - 5, center, center + 20, center + 85]) {
          for (const rxWidth of [20, 40, 80]) {
            const pair = [center - width / 2, center + width / 2, rxCenter - rxWidth / 2, rxCenter + rxWidth / 2];
            const memo = interferenceFactor({ lo: pair[0], hi: pair[1] }, pair[2], pair[3]);
            assert.equal(memo, general(pair), pair.join(' '));
            assert.equal(interferenceFactor({ segments: [{ lo: pair[0], hi: pair[1] }] }, pair[3], pair[2]), memo, 'de novo, agora da memória');
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Desempenho
// ---------------------------------------------------------------------------

describe('desempenho', () => {
  /** Menor tempo (ms) de `fn` em `runs` execuções: o que a conta custa sem o barulho da máquina. */
  const best = (runs, fn) => {
    let min = Infinity;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      fn(i);
      min = Math.min(min, performance.now() - t0);
    }
    return min;
  };

  // Tudo o que roda a cada varredura: normalizar, agrupar, dar nota aos canais e ranquear as redes
  const analyse = (event) => {
    const aps = normalizeScan(event, { sdk: 34 });
    const devices = groupByDevice(aps);
    groupBySsid(aps, { devices });
    for (const band of ['2.4', '5', '6']) rateChannels(aps, { band });
    rateChannels(aps, { band: '5', widthMHz: 80 });
    return rankNetworks(aps, { device: PHONE, connectionBssid: aps[0].id });
  };

  test('varredura de 200 APs: normalizar + agrupar + notas + ranking em bem menos de 50 ms', (t) => {
    const events = [randomScan(200, 7), randomScan(200, 8), randomScan(200, 9)];
    for (const event of events) analyse(event); // aquecimento
    const ms = best(15, (i) => analyse(events[i % events.length]));
    t.diagnostic(`200 APs: ${ms.toFixed(1)} ms`);
    assert.ok(ms < 50, `levou ${ms.toFixed(1)} ms`);
  });

  test('o ranking não refaz o agrupamento para cada rede: 400 APs custam poucas vezes 200', (t) => {
    const small = normalizeScan(randomScan(200, 21));
    const large = normalizeScan(randomScan(400, 21));
    const run = (aps) => rankNetworks(aps.map((ap) => ({ ...ap })), { device: PHONE });
    run(small);
    run(large);
    const a = best(7, () => run(small));
    const b = best(7, () => run(large));
    t.diagnostic(`rankNetworks: 200 APs ${a.toFixed(1)} ms, 400 APs ${b.toFixed(1)} ms`);
    assert.ok(b < 150, `400 APs: ${b.toFixed(1)} ms`);
    assert.ok(b < a * 12 + 5, `200 APs: ${a.toFixed(1)} ms; 400 APs: ${b.toFixed(1)} ms`);
  });

  test('prédio corporativo: 500 BSSIDs com MACs em sequência agrupados em bem menos de 1 s', (t) => {
    const sequence = (make) => normalizeScan({ ts: TS, aps: Array.from({ length: 500 }, (_, i) => ({ bssid: `aa:bb:cc:00:${hex2(i >> 8)}:${hex2(i)}`, level: -40 - (i % 50), channelWidth: 0, capabilities: '[WPA2-PSK-CCMP][ESS]', ageMs: 100, ...make(i) })) });
    const cases = {
      'um nome só, seis canais': sequence((i) => ({ ssid: 'Corp', frequency: [2412, 2437, 2462, 5180, 5200, 5745][i % 6] })),
      'pares Casa / Casa_5G': sequence((i) => ({ ssid: `Casa${i % 3 ? '_5G' : ''}`, frequency: i % 2 ? 2437 : 5180 })),
      'redes ocultas em três faixas': sequence((i) => ({ ssid: '', frequency: [2437, 5180, 5955][i % 3], level: -50 })),
    };
    for (const [name, aps] of Object.entries(cases)) {
      const ms = best(3, () => groupByDevice(aps.map((ap) => ({ ...ap }))));
      t.diagnostic(`${name}: ${ms.toFixed(1)} ms`);
      assert.ok(ms < 400, `${name}: ${ms.toFixed(1)} ms`);
    }
  });

  test('a mesma lista analisada por várias telas agrupa uma vez só', (t) => {
    const aps = normalizeScan(randomScan(300, 31));
    const copies = Array.from({ length: 5 }, () => aps.map((ap) => ({ ...ap })));
    const fresh = best(5, (i) => groupByDevice(copies[i]));
    groupByDevice(aps);
    const repeat = best(5, () => groupByDevice(aps));
    t.diagnostic(`groupByDevice de 300 APs: ${fresh.toFixed(2)} ms do zero, ${repeat.toFixed(2)} ms repetida`);
    assert.ok(repeat * 3 < fresh, `do zero: ${fresh.toFixed(2)} ms; repetida: ${repeat.toFixed(2)} ms`);
  });
});

// ---------------------------------------------------------------------------
// 6. Textos
// ---------------------------------------------------------------------------

describe('textos em pt-BR', () => {
  /** Todas as frases que o core escreve para um punhado de situações bem diferentes. */
  function harvest() {
    const texts = new Set();
    const add = (value) => {
      for (const text of ownTexts(value)) if (/\s/.test(text.trim()) || /[áéíóúâêôãõç]/i.test(text)) texts.add(text);
    };
    const events = [apartment, mesh, office, wifi7, randomScan(60, 3), randomScan(40, 4, { ies: false })];
    for (const event of events) {
      const aps = normalizeScan(event, { sdk: 34 });
      add(aps.map((ap) => [ap.level, ap.standardLabel, ap.occ.label, ap.security.label, ap.security.issues]));
      for (const device of [PHONE, OLD_PHONE]) {
        for (const index of [0, 1, Math.floor(aps.length / 2), aps.length - 1]) {
          const own = aps[index];
          const raw = event.aps.find((ap) => ap.bssid === own.bssid);
          for (const band of ['2.4', '5', '6']) {
            add(rateChannels(aps, { band }).map((row) => row.notes));
            add(recommendChannel(aps, { band, own }));
            add(recommendChannel(aps, { band }).text);
            add(recommendWidth(aps, band, { own }).text);
            add(recommendWidth(aps, band).text);
          }
          const ranking = rankNetworks(aps, { device, connectionBssid: own.id, favorites: [own.ssid] });
          add(ranking.map((row) => [row.pros, row.cons, row.warnings]));
          add(advise(ranking, { connectionBssid: own.id }));
          add(advise(rankNetworks(aps, { device }), {}));
          add(advise(rankNetworks(aps, { device, favorites: [own.ssid] }), { favorites: [own.ssid] }));
          for (const rssi of [-45, -72, -78, -88]) {
            add(buildInsights({ aps, connection: connectionTo(raw, { rssi }), device, status: { throttled: true } }));
            add(buildInsights({ aps, connection: connectionTo(raw, { rssi, hidden: true, txSpeed: 6, rxSpeed: 6, linkSpeed: 6 }), device }));
          }
          add(buildInsights({ aps, connection: { connected: false }, device }));
        }
      }
    }
    for (const rssi of [-40, -55, -65, -72, -80, -90, null]) add(signalLevel(rssi));
    for (const band of ['2.4', '5', '6', '60']) add(channelList(band, { all: true }));
    for (const code of [0, 1, 4, 5, 6, 7, 8, 99]) for (const band of ['2.4', '5', '6']) add(standardInfo(code, band).label);
    for (const caps of SEC) add(parseCapabilities(caps));
    add(recommendChannel([], { band: '5', widthMHz: 40 }).text);
    add(recommendChannel([], { band: '2.4', widthMHz: 320 }).text);
    add(recommendWidth([], 'x').text);
    return [...texts];
  }

  const TEXTS = harvest();
  // Nomes de rede e de aparelho vêm do celular e podem ter qualquer coisa: saem da conferência
  const plain = (text) => text.replace(/“[^”]*”/g, '“…”').replace(/"[^"]*"/g, '"…"');

  test('a colheita cobre as situações principais', () => {
    assert.ok(TEXTS.length > 150, `só ${TEXTS.length} frases`);
    for (const piece of ['Seu roteador está no canal', 'Você já está na melhor opção', 'Você não está conectado ao Wi-Fi', 'cerca de', 'Canal livre', 'DFS', 'Rede aberta', 'Sinal']) {
      assert.ok(TEXTS.some((t) => t.includes(piece)), `nenhuma frase com "${piece}"`);
    }
  });

  test('números com vírgula decimal, nunca com ponto', () => {
    for (const text of TEXTS) {
      // "802.11ax" é nome de norma, não número decimal
      const rest = plain(text).replace(/802\.11[a-z/]*/g, '');
      assert.ok(!/\d\.\d/.test(rest), `ponto decimal em: ${text}`);
    }
    assert.equal(formatSpeed(7.46), '7,5 Mb/s');
    assert.equal(formatSpeed(1134), '1,1 Gb/s');
    assert.equal(formatGain(2.34), '2,3x');
  });

  test('uma unidade só para velocidade (Mb/s, Gb/s) e as faixas com o nome certo', () => {
    for (const text of TEXTS) {
      const rest = plain(text);
      assert.ok(!/Mbps|Gbps|Mbit|mbps|MB\/s|Mb\/seg/.test(rest), `unidade fora do padrão em: ${text}`);
      assert.ok(!/\b2\.4\s?GHz|\b2,4GHz|\b5GHz|\b6GHz|\d\s?Ghz|\d\s?ghz/.test(rest), `nome de faixa fora do padrão em: ${text}`);
      assert.ok(!/\d(MHz|dBm|Mb\/s|Gb\/s)/.test(rest), `número colado na unidade em: ${text}`);
    }
  });

  test('velocidade estimada sempre aparece como estimativa', () => {
    // O que é medido ou definido pela norma pode ser afirmado; o resto vem com "cerca de" / "perto de"
    const stated = /(cerca de|perto de|limita a velocidade a|taxa máxima é de|conversando a|os avisos da rede a) [\d,]+ [MG]b\/s/g;
    let seen = 0;
    for (const text of TEXTS) {
      const rest = plain(text);
      const all = rest.match(/[\d,]+ [MG]b\/s/g) || [];
      const hedged = rest.match(stated) || [];
      assert.equal(hedged.length, all.length, `velocidade afirmada sem ressalva em: ${text}`);
      seen += all.length;
    }
    assert.ok(seen > 50, 'a colheita tem frases com velocidade');
    for (const text of TEXTS) assert.ok(!/\bexatamente\b|\bprecisamente\b|\bcom certeza\b|\bgarantid/i.test(plain(text)), `certeza demais em: ${text}`);
  });

  test('distância estimada: formatDistance sempre diz que é aproximada', () => {
    assert.equal(formatDistance(0.3), 'menos de 1 m');
    assert.equal(formatDistance(3.2), 'cerca de 3 m');
    assert.equal(formatDistance(9.6), 'cerca de 10 m');
    assert.equal(formatDistance(27), 'cerca de 25 m');
    assert.equal(formatDistance(99), 'cerca de 100 m');
    assert.equal(formatDistance(150), 'mais de 100 m');
    for (let m = 0; m <= 220; m += 0.37) assert.match(formatDistance(m), /^(cerca de \d+ m|menos de 1 m|mais de 100 m)$/);
    for (const bad of [NaN, Infinity, -1, null, undefined, '5', {}]) assert.equal(formatDistance(bad), '—', show(bad));
    // os outros formatadores também recusam o que não é medida
    for (const bad of [NaN, Infinity, -1, 1e308, null, '7']) assert.equal(formatSpeed(bad), '—', show(bad));
    for (const bad of [NaN, Infinity, 1e308, -1e308, null, '-57']) assert.equal(formatDbm(bad), '—', show(bad));
    assert.equal(formatDbm(-57.2), '−57 dBm');
  });

  test('frases limpas: sem valor vazando, sem espaço dobrado, com ponto final onde é frase', () => {
    for (const text of TEXTS) {
      assert.ok(!BAD_TEXT.test(plain(text)), `valor vazando em: ${text}`);
      assert.ok(!/ {2}| [.,;:!?](\s|$)|\(\s|\s\)|,,|(?<!\.)\.\.(?!\.)/.test(plain(text)), `pontuação ou espaço estranho em: ${text}`);
      assert.equal(text, text.trim());
      assert.ok(!/^[a-zà-ú]/.test(text) || text.length < 60, `frase longa começando em minúscula: ${text}`);
    }
    const sentences = [];
    const aps = normalizeScan(apartment, { sdk: 34 });
    for (const band of ['2.4', '5', '6']) sentences.push(recommendChannel(aps, { band, own: aps[0] }).text, recommendWidth(aps, band).text);
    const ranking = rankNetworks(aps, { device: PHONE, connectionBssid: aps[0].id });
    sentences.push(advise(ranking, { connectionBssid: aps[0].id }).text, advise(rankNetworks(aps, { device: PHONE }), {}).text);
    for (const insight of buildInsights({ aps, connection: connectionTo(apartment.aps[0], { rssi: -80 }), device: PHONE, status: { throttled: true } })) sentences.push(insight.text);
    for (const row of ranking) sentences.push(...row.warnings);
    for (const text of sentences) assert.match(text, /[.!?]$/, `sem ponto final: ${text}`);
  });

  test('os mesmos termos em todo lugar: rede, canal, sinal, roteador, faixa', () => {
    for (const text of TEXTS) {
      const rest = plain(text);
      assert.ok(!/\bbanda de \d|\bbanda \d|frequência de (2,4|5|6) GHz|\bWifi\b|\bWi-fi\b|\bwifi\b|\bWI-FI\b/.test(rest), `termo fora do padrão em: ${text}`);
      assert.ok(!/\broteadora\b|\bmodem\b|\bSSID\b|\bBSSID\b|\bRSSI\b/.test(rest), `jargão em: ${text}`);
    }
  });
});
