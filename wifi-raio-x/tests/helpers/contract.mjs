// Conferência do contrato da ponte, escrita a partir dos typedefs e da tabela de métodos
// de app/js/bridge.js. Serve para qualquer teste que queira garantir que um valor tem a
// forma que o Android manda: campos obrigatórios, tipos, faixas de valores e — o erro mais
// comum — campo opcional presente com null/undefined em vez de simplesmente ausente.
//
// Uso:
//   import { assertResult, assertEvent, checkType } from './helpers/contract.mjs';
//   assertResult('connection', await bridge.connection());
//   bridge.on('scan', (ev) => assertEvent('scan', ev));
//   checkType('ScanAp', ap)            // -> lista de problemas ([] = ok)
//
// Por padrão campos desconhecidos são erro (o simulador tem de mandar exatamente o que o
// Android manda). Passe { extra: true } para tolerá-los.

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Constantes do contrato
// ---------------------------------------------------------------------------

/** MAC como o contrato pede: minúsculo, separado por dois-pontos. */
export const BSSID_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
/** ScanResult.WIFI_STANDARD_* */
export const WIFI_STANDARDS = Object.freeze([0, 1, 4, 5, 6, 7, 8]);
/** ScanResult.CHANNEL_WIDTH_* (-1 = desconhecido) */
export const CHANNEL_WIDTHS = Object.freeze([-1, 0, 1, 2, 3, 4, 5]);
export const PERMISSIONS = Object.freeze(['granted', 'denied', 'blocked']);
export const SCAN_SOURCES = Object.freeze(['request', 'system', 'cache']);
export const SETTINGS_PANELS = Object.freeze(['wifi', 'location', 'app', 'developer', 'panel']);
export const CANCEL_OPS = Object.freeze(['ping', 'lan']);
/**
 * Motivos de recusa de scan(). O bridge.js só diz "reason?: string"; estes são os que o
 * simulador usa (SCAN_REFUSAL em app/js/sim/backend.js) e que a interface pode esperar.
 */
export const SCAN_REASONS = Object.freeze(['permission', 'location', 'wifi', 'throttled']);

// Maior distância (MHz) entre o canal primário e centerFreq0, por CHANNEL_WIDTH_*.
const MAX_CENTER_OFFSET = { '-1': 150, 0: 0, 1: 10, 2: 30, 3: 70, 4: 30, 5: 150 };

// ---------------------------------------------------------------------------
// Peças
// ---------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function show(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'uma lista';
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return `um valor do tipo ${typeof v}`;
}

const utf8Length = (s) => new TextEncoder().encode(s).length;

function isWifiFrequency(f) {
  return (f >= 2400 && f <= 2500) || (f >= 5150 && f <= 5900) || (f >= 5925 && f <= 7125) || (f >= 57000 && f <= 71000);
}

function isIpv4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return !!m && m.slice(1).every((p) => Number(p) <= 255 && String(Number(p)) === p);
}

function isIpv6(s) {
  if (!/^[0-9a-f:.]+(%[\w.-]+)?$/i.test(s)) return false;
  const addr = s.split('%')[0];
  const double = addr.split('::').length - 1;
  if (double > 1) return false;
  const groups = addr.split(':').filter((g) => g !== '');
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g) && !isIpv4(g))) return false;
  return double === 1 ? groups.length <= 7 : groups.length === 8;
}

// Cada conferidor é uma função (valor, caminho, problemas).
const bool = (v, path, out) => {
  if (typeof v !== 'boolean') out.push(`${path}: esperava boolean, veio ${show(v)}`);
};

const number = (min = -Infinity, max = Infinity) => (v, path, out) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) out.push(`${path}: esperava um número, veio ${show(v)}`);
  else if (v < min || v > max) out.push(`${path}: ${v} fora da faixa ${min}..${max}`);
};

const integer = (min = -Infinity, max = Infinity) => (v, path, out) => {
  if (typeof v !== 'number' || !Number.isInteger(v)) out.push(`${path}: esperava um inteiro, veio ${show(v)}`);
  else if (v < min || v > max) out.push(`${path}: ${v} fora da faixa ${min}..${max}`);
};

const string = (options = {}) => (v, path, out) => {
  if (typeof v !== 'string') out.push(`${path}: esperava texto, veio ${show(v)}`);
  else if (options.nonEmpty && v === '') out.push(`${path}: texto vazio`);
  else if (options.re && !options.re.test(v)) out.push(`${path}: ${show(v)} não tem o formato esperado (${options.what || options.re})`);
  else if (options.test && !options.test(v)) out.push(`${path}: ${show(v)} não é ${options.what}`);
};

const oneOf = (...values) => (v, path, out) => {
  if (!values.includes(v)) out.push(`${path}: ${show(v)} não é um de ${values.map((x) => JSON.stringify(x)).join(', ')}`);
};

const list = (item) => (v, path, out, options) => {
  if (!Array.isArray(v)) out.push(`${path}: esperava uma lista, veio ${show(v)}`);
  else v.forEach((x, i) => item(x, `${path}[${i}]`, out, options));
};

/** Aceita null além do tipo dado (só para os campos que o contrato declara como "X | null"). */
const nullable = (check) => {
  const fn = (v, path, out) => {
    if (v !== null) check(v, path, out);
  };
  fn.nullable = true;
  return fn;
};

const REQ = true;
const OPT = false;

/**
 * Objeto com campos conhecidos. spec = { campo: [obrigatório, conferidor] }.
 * `rules` são as regras que cruzam campos: (valor, caminho, problemas).
 */
function shape(spec, ...rules) {
  return (v, path, out, options = {}) => {
    if (!isObj(v)) {
      out.push(`${path}: esperava um objeto, veio ${show(v)}`);
      return;
    }
    const before = out.length;
    for (const [key, [required, check]] of Object.entries(spec)) {
      if (!Object.prototype.hasOwnProperty.call(v, key)) {
        if (required) out.push(`${path}.${key}: campo obrigatório ausente`);
        continue;
      }
      const value = v[key];
      if (value === undefined || (value === null && !check.nullable)) {
        out.push(`${path}.${key}: veio ${show(value)}; campo ${required ? 'obrigatório precisa de valor' : 'opcional sem valor tem de ficar AUSENTE'}`);
        continue;
      }
      check(value, `${path}.${key}`, out, options);
    }
    if (!options.extra) {
      for (const key of Object.keys(v)) {
        if (!Object.prototype.hasOwnProperty.call(spec, key)) out.push(`${path}.${key}: campo fora do contrato`);
      }
    }
    // As regras cruzadas só fazem sentido quando os campos em si estão certos.
    if (out.length === before) for (const rule of rules) rule(v, path, out);
  };
}

const bssid = string({ re: BSSID_RE, what: 'MAC minúsculo aa:bb:cc:dd:ee:ff' });
const ipv4 = string({ test: isIpv4, what: 'um endereço IPv4' });
const ipv6 = string({ test: isIpv6, what: 'um endereço IPv6' });
const ipAny = string({ test: (s) => isIpv4(s) || isIpv6(s), what: 'um endereço IP' });
const timestamp = integer(0, 8.64e15);
const mbps = integer(-1, 100000); // -1 = LINK_SPEED_UNKNOWN

// ---------------------------------------------------------------------------
// Typedefs de bridge.js
// ---------------------------------------------------------------------------

const RawIe = shape(
  {
    id: [REQ, integer(0, 255)],
    ext: [REQ, integer(0, 255)],
    hex: [REQ, string({ re: /^([0-9a-fA-F]{2})*$/, what: 'hexadecimal com número par de dígitos' })],
  },
  (ie, path, out) => {
    if (ie.hex.length > 510) out.push(`${path}.hex: corpo com ${ie.hex.length / 2} bytes (um elemento tem no máximo 255)`);
    if (ie.ext !== 0 && ie.id !== 255) out.push(`${path}.ext: ${ie.ext} só faz sentido quando id = 255`);
  },
);

const ScanAp = shape(
  {
    bssid: [REQ, bssid],
    ssid: [REQ, string({ test: (s) => utf8Length(s) <= 32, what: 'um SSID de até 32 bytes' })],
    level: [REQ, integer(-127, 0)],
    frequency: [REQ, integer(2400, 71000)],
    channelWidth: [REQ, oneOf(...CHANNEL_WIDTHS)],
    centerFreq0: [REQ, integer(0, 71000)],
    centerFreq1: [REQ, integer(0, 71000)],
    capabilities: [REQ, string({ re: /^(\[[^[\]]+\])*$/, what: 'blocos entre colchetes, como "[WPA2-PSK-CCMP][ESS]"' })],
    ageMs: [REQ, integer(0, 86400000)],
    wifiStandard: [OPT, oneOf(...WIFI_STANDARDS)],
    rttResponder: [OPT, bool],
    passpoint: [OPT, bool],
    venueName: [OPT, string()],
    operatorName: [OPT, string()],
    mld: [OPT, bssid],
    ies: [OPT, list(RawIe)],
  },
  (ap, path, out) => {
    if (!isWifiFrequency(ap.frequency)) out.push(`${path}.frequency: ${ap.frequency} MHz não é uma frequência de Wi-Fi`);
    for (const key of ['centerFreq0', 'centerFreq1']) {
      if (ap[key] !== 0 && !isWifiFrequency(ap[key])) out.push(`${path}.${key}: ${ap[key]} MHz não é 0 nem uma frequência de Wi-Fi`);
    }
    const reach = MAX_CENTER_OFFSET[ap.channelWidth];
    if (ap.centerFreq0 !== 0 && Math.abs(ap.centerFreq0 - ap.frequency) > reach) {
      out.push(`${path}.centerFreq0: ${ap.centerFreq0} fica longe demais do canal primário ${ap.frequency} para channelWidth ${ap.channelWidth}`);
    }
  },
);

const ScanEvent = shape(
  {
    ts: [REQ, timestamp],
    fresh: [REQ, bool],
    source: [REQ, oneOf(...SCAN_SOURCES)],
    aps: [REQ, list(ScanAp)],
  },
  (ev, path, out) => {
    if (ev.fresh && ev.source === 'cache') out.push(`${path}: fresh = true não combina com source = 'cache'`);
    const seen = new Set();
    for (const ap of ev.aps) {
      if (seen.has(ap.bssid)) out.push(`${path}.aps: BSSID repetido ${ap.bssid}`);
      seen.add(ap.bssid);
    }
  },
);

const DeviceInfo = shape(
  {
    platform: [REQ, oneOf('android', 'sim')],
    sdk: [REQ, integer(0, 1000)],
    release: [REQ, string({ nonEmpty: true })],
    manufacturer: [REQ, string()],
    model: [REQ, string()],
    appVersion: [REQ, string({ nonEmpty: true })],
    bands: [REQ, shape({ b24: [REQ, bool], b5: [REQ, bool], b6: [REQ, bool], b60: [REQ, bool] })],
    standards: [REQ, list(oneOf(...WIFI_STANDARDS))],
    rtt: [REQ, bool],
  },
  (info, path, out) => {
    if (info.platform === 'sim' && info.sdk !== 0) out.push(`${path}.sdk: no simulador é 0`);
    if (info.platform === 'android' && info.sdk < 24) out.push(`${path}.sdk: ${info.sdk} é menor do que o mínimo do app (24)`);
  },
);

const Status = shape(
  {
    wifiEnabled: [REQ, bool],
    locationEnabled: [REQ, bool],
    permission: [REQ, oneOf(...PERMISSIONS)],
    throttled: [REQ, nullable(bool)],
    canScan: [REQ, bool],
  },
  (s, path, out) => {
    const expected = s.wifiEnabled && s.locationEnabled && s.permission === 'granted';
    if (s.canScan !== expected) out.push(`${path}.canScan: ${s.canScan}, mas wifiEnabled && locationEnabled && permission === 'granted' dá ${expected}`);
  },
);

const Connection = shape(
  {
    connected: [REQ, bool],
    ssid: [OPT, string({ test: (s) => utf8Length(s) <= 32, what: 'um SSID de até 32 bytes' })],
    bssid: [OPT, bssid],
    rssi: [OPT, integer(-127, 0)],
    frequency: [OPT, integer(2400, 71000)],
    linkSpeed: [OPT, mbps],
    txSpeed: [OPT, mbps],
    rxSpeed: [OPT, mbps],
    maxTxSpeed: [OPT, mbps],
    maxRxSpeed: [OPT, mbps],
    wifiStandard: [OPT, oneOf(...WIFI_STANDARDS)],
    securityType: [OPT, integer(-1, 13)],
    hidden: [OPT, bool],
    ip: [OPT, ipv4],
    prefix: [OPT, integer(0, 32)],
    gateway: [OPT, ipv4],
    dns: [OPT, list(ipAny)],
    ipv6: [OPT, list(ipv6)],
    iface: [OPT, string({ nonEmpty: true })],
    mtu: [OPT, integer(0, 65535)],
    leaseSec: [OPT, integer(0, 31536000)],
    validated: [OPT, bool],
    metered: [OPT, bool],
  },
  (c, path, out) => {
    if (c.frequency !== undefined && !isWifiFrequency(c.frequency)) out.push(`${path}.frequency: ${c.frequency} MHz não é uma frequência de Wi-Fi`);
    if (!c.connected) {
      for (const key of ['ssid', 'bssid', 'rssi', 'frequency', 'linkSpeed', 'ip', 'gateway']) {
        if (c[key] !== undefined) out.push(`${path}.${key}: presente com connected = false`);
      }
    }
    if (c.maxTxSpeed > 0 && c.txSpeed > c.maxTxSpeed) out.push(`${path}.txSpeed: ${c.txSpeed} maior do que maxTxSpeed ${c.maxTxSpeed}`);
    if (c.maxRxSpeed > 0 && c.rxSpeed > c.maxRxSpeed) out.push(`${path}.rxSpeed: ${c.rxSpeed} maior do que maxRxSpeed ${c.maxRxSpeed}`);
  },
);

const RssiSample = shape(
  {
    ts: [REQ, timestamp],
    rssi: [REQ, integer(-127, 0)],
    bssid: [REQ, bssid],
    frequency: [REQ, integer(2400, 71000)],
    linkSpeed: [OPT, mbps],
    txSpeed: [OPT, mbps],
    rxSpeed: [OPT, mbps],
  },
  (s, path, out) => {
    if (!isWifiFrequency(s.frequency)) out.push(`${path}.frequency: ${s.frequency} MHz não é uma frequência de Wi-Fi`);
  },
);

const RttResult = shape(
  {
    bssid: [REQ, bssid],
    ok: [REQ, bool],
    distM: [OPT, number(-10, 1000)], // o Android pode medir um pouco abaixo de zero colado no AP
    stdM: [OPT, number(0, 1000)],
    rssi: [OPT, integer(-127, 0)],
    attempts: [OPT, integer(0, 1000)],
    successes: [OPT, integer(0, 1000)],
  },
  (r, path, out) => {
    if (r.ok && r.distM === undefined) out.push(`${path}.distM: ausente numa medição com ok = true`);
    if (!r.ok && r.distM !== undefined) out.push(`${path}.distM: presente numa medição com ok = false`);
    if (r.successes > r.attempts) out.push(`${path}.successes: ${r.successes} maior do que attempts ${r.attempts}`);
  },
);

const PingReply = shape(
  {
    host: [REQ, string({ nonEmpty: true })],
    seq: [REQ, integer(0, 1000000)],
    ok: [REQ, bool],
    ms: [OPT, number(0, 600000)],
  },
  (r, path, out) => {
    if (r.ok && r.ms === undefined) out.push(`${path}.ms: ausente numa resposta com ok = true`);
    if (!r.ok && r.ms !== undefined) out.push(`${path}.ms: presente numa resposta com ok = false`);
  },
);

const PingSummary = shape(
  {
    host: [REQ, string({ nonEmpty: true })],
    method: [REQ, oneOf('icmp', 'tcp')],
    sent: [REQ, integer(0, 1000000)],
    received: [REQ, integer(0, 1000000)],
    lossPct: [REQ, number(0, 100)],
    min: [OPT, number(0, 600000)],
    avg: [OPT, number(0, 600000)],
    max: [OPT, number(0, 600000)],
    jitter: [OPT, number(0, 600000)],
  },
  (s, path, out) => {
    if (s.received > s.sent) out.push(`${path}.received: ${s.received} maior do que sent ${s.sent}`);
    const loss = s.sent ? (100 * (s.sent - s.received)) / s.sent : 0;
    if (Math.abs(s.lossPct - loss) > 0.51) out.push(`${path}.lossPct: ${s.lossPct}, mas sent/received dão ${loss.toFixed(1)}`);
    const stats = ['min', 'avg', 'max'].filter((k) => s[k] !== undefined);
    if (s.received === 0 && (stats.length || s.jitter !== undefined)) out.push(`${path}: estatísticas presentes sem nenhuma resposta`);
    if (s.received > 0 && stats.length !== 3) out.push(`${path}: com respostas, min, avg e max têm de vir juntos`);
    if (stats.length === 3 && !(s.min <= s.avg + 0.051 && s.avg <= s.max + 0.051)) out.push(`${path}: esperava min <= avg <= max (${s.min}, ${s.avg}, ${s.max})`);
  },
);

const LanDevice = shape({
  ip: [REQ, ipv4],
  host: [OPT, string({ nonEmpty: true })],
  mac: [OPT, string({ re: /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/, what: 'um MAC' })],
  ms: [OPT, number(0, 600000)],
  self: [OPT, bool],
  gateway: [OPT, bool],
});

const LanProgress = shape(
  {
    done: [REQ, integer(0, 16777216)],
    total: [REQ, integer(0, 16777216)],
  },
  (p, path, out) => {
    if (p.done > p.total) out.push(`${path}.done: ${p.done} maior do que total ${p.total}`);
  },
);

// Evento extra do simulador (não existe no Android): onde a pessoa virtual está.
const SimEvent = shape({
  t: [REQ, number(0)],
  x: [REQ, number()],
  y: [REQ, number()],
  z: [REQ, number()],
  floor: [REQ, integer(0, 100)],
  room: [REQ, nullable(string({ nonEmpty: true }))],
  heading: [REQ, number(-7, 7)],
  world: [REQ, string({ nonEmpty: true })],
  moving: [OPT, bool],
  mode: [OPT, oneOf('auto', 'still', 'manual')],
});

const okTrue = shape({ ok: [REQ, oneOf(true)] });
const okAny = shape({ ok: [REQ, bool] });
const empty = shape({});

const ScanAnswer = shape(
  {
    accepted: [REQ, bool],
    reason: [OPT, string({ nonEmpty: true })],
  },
  (r, path, out) => {
    if (r.accepted && r.reason !== undefined) out.push(`${path}.reason: presente numa varredura aceita`);
    if (!r.accepted && r.reason === undefined) out.push(`${path}.reason: uma recusa tem de dizer o motivo`);
  },
);

const LastScan = (v, path, out, options) => {
  ScanEvent(v, path, out, options);
  if (isObj(v) && (v.source !== 'cache' || v.fresh !== false)) out.push(`${path}: lastScan devolve source = 'cache' e fresh = false`);
};

const LanAnswer = shape({ devices: [REQ, list(LanDevice)] }, (r, path, out) => {
  const ips = new Set();
  for (const d of r.devices) {
    if (ips.has(d.ip)) out.push(`${path}.devices: IP repetido ${d.ip}`);
    ips.add(d.ip);
  }
  if (r.devices.filter((d) => d.self).length > 1) out.push(`${path}.devices: mais de um aparelho marcado como self`);
  if (r.devices.filter((d) => d.gateway).length > 1) out.push(`${path}.devices: mais de um aparelho marcado como gateway`);
});

/** Conferidores por nome de typedef. */
export const TYPES = Object.freeze({
  RawIe,
  ScanAp,
  ScanEvent,
  DeviceInfo,
  Status,
  Connection,
  RssiSample,
  RttResult,
  PingReply,
  PingSummary,
  LanDevice,
  LanProgress,
  SimEvent,
});

// ---------------------------------------------------------------------------
// Tabela dos métodos e dos eventos
// ---------------------------------------------------------------------------

/**
 * A tabela de bridge.js: se o método é assíncrono (callAsync), a forma dos argumentos e a
 * forma da resposta.
 *
 * Observação: a tabela do bridge.js diz share -> {ok:true}; o simulador responde
 * {ok:false} quando o navegador não deixa compartilhar nem copiar, então aqui vale boolean.
 */
export const METHODS = Object.freeze({
  info: { async: false, args: empty, result: DeviceInfo },
  status: { async: false, args: empty, result: Status },
  lastScan: { async: false, args: empty, result: LastScan },
  connection: { async: false, args: empty, result: Connection },
  watchRssi: { async: false, args: shape({ intervalMs: [REQ, number(1, 3600000)] }), result: okTrue },
  unwatchRssi: { async: false, args: empty, result: okTrue },
  openSettings: { async: false, args: shape({ which: [REQ, oneOf(...SETTINGS_PANELS)] }), result: okAny },
  keepAwake: { async: false, args: shape({ on: [REQ, bool] }), result: okTrue },
  vibrate: { async: false, args: shape({ ms: [REQ, number(0, 60000)] }), result: okTrue },
  setBars: {
    async: false,
    args: shape({ color: [REQ, string({ re: /^#[0-9a-fA-F]{6}$/, what: 'uma cor #rrggbb' })], dark: [REQ, bool] }),
    result: okTrue,
  },
  share: { async: false, args: shape({ title: [REQ, string()], text: [REQ, string()] }), result: okAny },
  saveFile: {
    async: false,
    args: shape(
      {
        name: [REQ, string({ nonEmpty: true })],
        mime: [REQ, string({ re: /^[\w.+-]+\/[\w.+-]+(;.*)?$/, what: 'um tipo MIME' })],
        text: [OPT, string()],
        base64: [OPT, string({ re: /^[A-Za-z0-9+/]*={0,2}$/, what: 'base64' })],
      },
      (a, path, out) => {
        if ((a.text === undefined) === (a.base64 === undefined)) out.push(`${path}: precisa de text OU base64 (um só)`);
      },
    ),
    result: okAny,
  },
  cancel: { async: false, args: shape({ op: [REQ, oneOf(...CANCEL_OPS)] }), result: okTrue },
  requestPermission: { async: true, args: empty, result: Status },
  scan: { async: true, args: empty, result: ScanAnswer },
  rtt: { async: true, args: shape({ bssids: [REQ, list(bssid)] }), result: shape({ results: [REQ, list(RttResult)] }) },
  ping: {
    async: true,
    args: shape({ host: [REQ, string({ nonEmpty: true })], count: [REQ, integer(1, 1000)], timeoutMs: [REQ, integer(1, 600000)] }),
    result: PingSummary,
  },
  lanScan: { async: true, args: empty, result: LanAnswer },
});

/** Eventos do contrato (os que o Android também emite). */
export const EVENTS = Object.freeze({
  scan: ScanEvent,
  rssi: RssiSample,
  status: Status,
  connection: Connection,
  ping: PingReply,
  lan: LanDevice,
  lanProgress: LanProgress,
});

/** Eventos que só o simulador emite. */
export const SIM_EVENTS = Object.freeze({ sim: SimEvent });

// ---------------------------------------------------------------------------
// Funções de conferência
// ---------------------------------------------------------------------------

// Igualdade de valores JSON (0 e -0 contam como iguais; NaN nunca é igual a nada).
function sameJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]));
}

// O Android manda JSON: o valor tem de sobreviver a uma ida e volta sem perder nada.
function jsonProblems(value, label) {
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(value));
  } catch (err) {
    return [`${label}: não é serializável em JSON (${err.message})`];
  }
  return sameJson(copy, value) ? [] : [`${label}: muda ao passar por JSON (tem undefined, NaN, Infinity, classe própria...)`];
}

function run(check, value, label, options) {
  const out = [];
  check(value, label, out, options || {});
  if (!out.length) out.push(...jsonProblems(value, label));
  return out;
}

/**
 * Problemas de um valor em relação a um typedef ('ScanAp', 'Connection'...). [] = válido.
 * @param {keyof typeof TYPES} type
 * @param {{extra?: boolean}} [options]  extra: tolera campos fora do contrato
 */
export function checkType(type, value, options) {
  const check = TYPES[type];
  if (!check) return [`typedef desconhecido: ${type}`];
  return run(check, value, type, options);
}

/** Problemas da resposta de um método. */
export function checkResult(method, value, options) {
  const m = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
  if (!m) return [`método fora do contrato: ${method}`];
  return run(m.result, value, `${method}()`, options);
}

/** Problemas dos argumentos passados a um método (útil com um backend espião). */
export function checkArgs(method, args, options) {
  const m = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
  if (!m) return [`método fora do contrato: ${method}`];
  return run(m.args, args ?? {}, `${method}(args)`, options);
}

/**
 * Problemas de um evento. Os eventos só do simulador ('sim') valem por padrão; passe
 * { simEvents: false } para exigir apenas os do Android.
 */
export function checkEvent(name, data, options = {}) {
  const check = Object.prototype.hasOwnProperty.call(EVENTS, name)
    ? EVENTS[name]
    : options.simEvents !== false && Object.prototype.hasOwnProperty.call(SIM_EVENTS, name)
      ? SIM_EVENTS[name]
      : null;
  if (!check) return [`evento fora do contrato: ${name}`];
  return run(check, data, `evento '${name}'`, options);
}

function raise(problems, value) {
  if (!problems.length) return;
  let dump = '';
  try {
    dump = JSON.stringify(value);
  } catch {
    dump = String(value);
  }
  if (dump && dump.length > 600) dump = `${dump.slice(0, 600)}…`;
  assert.fail(`fora do contrato da ponte:\n  - ${problems.join('\n  - ')}\n  valor: ${dump}`);
}

export function assertType(type, value, options) {
  raise(checkType(type, value, options), value);
  return value;
}

export function assertResult(method, value, options) {
  raise(checkResult(method, value, options), value);
  return value;
}

export function assertArgs(method, args, options) {
  raise(checkArgs(method, args, options), args);
  return args;
}

export function assertEvent(name, data, options) {
  raise(checkEvent(name, data, options), data);
  return data;
}

/** Um método do contrato é assíncrono (callAsync)? undefined se não existir. */
export function isAsyncMethod(method) {
  return Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method].async : undefined;
}
