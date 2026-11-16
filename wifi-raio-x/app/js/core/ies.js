// Elementos de informação (IEs) dos beacons 802.11.
//
// O que oferece:
//   parseIes      ScanAp.ies -> IeInfo (tudo o que foi entendido, elemento por elemento)
//   summarizeIes  IeInfo -> IeSummary (o resumo plano que vira `ap.ie` em model.js)
//   shortSsid     CRC-32 do nome, para casar com o Reduced Neighbor Report
//   encodeIes     o caminho inverso, para o simulador e os testes
//
// O Android (11+) entrega cada elemento cru em ScanResult.getInformationElements(): o
// número do elemento (`id`), a extensão (`ext`, só quando id = 255) e o corpo em hexadecimal,
// sem os bytes de id e de tamanho. Aqui o corpo vira informação útil: quantos aparelhos
// estão no roteador, ocupação do canal, Wi-Fi 4/5/6/7, antenas, roaming, WPS, PMF etc.
//
// Convenções do padrão usadas no arquivo todo:
//   - campos de mais de um byte são little-endian (exceção: os TLVs do WPS, big-endian);
//   - "bit N" de um campo conta a partir do bit menos significativo do primeiro byte.
// Dados truncados ou inválidos nunca geram exceção: o elemento é simplesmente ignorado.
//
// Fontes conferidas: IEEE 802.11-2020/ax/be (leiaute dos elementos), cabeçalhos do Linux
// (include/linux/ieee80211*.h), hostapd (ieee802_11_defs.h, wps_defs.h), dissecador do
// Wireshark (nomes de AP de fabricantes) e InformationElementUtil.java do Android.

/**
 * @typedef {{id:number, ext:number, hex:string}} RawIe
 */

/**
 * Tudo o que foi entendido dos elementos de um beacon. Cada campo só existe quando o
 * elemento correspondente veio e era válido.
 * @typedef {Object} IeInfo
 * @property {number} count   elementos recebidos com corpo hexadecimal válido
 * @property {{rates:number[], basicRates:number[], legacy11b:boolean, supports11b:boolean, minBasicRate:?number,
 *             selectors:string[]}} [rates]  taxas em Mbps (elementos 1 e 50); selectors: 'HT','VHT','HE','EHT','SAE-H2E'...
 * @property {{channel:number}} [ds]
 * @property {{code:string, environment:string, triplets:{first:number,count:number,maxTxDbm:number}[],
 *             operating:{extId:number,opClass:number,coverageClass:number}[]}} [country]
 * @property {{stations:number, utilization:number, admissionCapacity:number}} [bssLoad]  utilization de 0 a 1
 * @property {{db:number}} [powerConstraint]
 * @property {{txPowerDbm:number, linkMargin:number}} [tpcReport]
 * @property {{nonErpPresent:boolean, useProtection:boolean, barkerPreamble:boolean}} [erp]
 * @property {{ldpc:boolean, width40:boolean, sgi20:boolean, sgi40:boolean, txStbc:boolean, rxStbc:number,
 *             maxAmsdu:number, nss:number, maxMcs:?number, greenfield:boolean, fortyIntolerant:boolean}} [ht]
 * @property {{primaryChannel:number, secondaryOffset:('above'|'below'|null), staWidth:(20|40),
 *             protection:('none'|'nonmember'|'20mhz'|'mixed'), nonGreenfieldPresent:boolean,
 *             obssNonHtPresent:boolean, centerSeg2:number}} [htOperation]
 * @property {RsnInfo} [rsn]
 * @property {RsnInfo} [rsnOverride]   elemento "RSNE Override" da Wi-Fi Alliance (modo de compatibilidade WPA3)
 * @property {RsnInfo} [rsnOverride2]
 * @property {RsnInfo} [wpa]           elemento WPA (WPA1) da Microsoft
 * @property {{mdid:number, ftOverDs:boolean, resourceRequest:boolean}} [mobilityDomain]  presente = 802.11r
 * @property {{neighborReport:boolean, linkMeasurement:boolean, beaconPassive:boolean, beaconActive:boolean,
 *             beaconTable:boolean}} [rm]  presente = 802.11k
 * @property {Object<string, boolean>} [extCaps]  bssTransition (802.11v), ftmResponder, twtResponder, ...
 * @property {{accessNetworkType:number, internet:boolean, asra:boolean, esr:boolean, uesa:boolean,
 *             hessid:?string}} [interworking]
 * @property {{maxIndicator:number}} [multipleBssid]
 * @property {{maxMpdu:number, width160:boolean, width80p80:boolean, sgi80:boolean, sgi160:boolean,
 *             suBeamformer:boolean, suBeamformee:boolean, muBeamformer:boolean, muBeamformee:boolean,
 *             rxLdpc:boolean, nss:number, maxMcs:?number, extNssBw:number}} [vht]
 * @property {{width:number, centerSeg0:number, centerSeg1:number, widthMhz:?number, plus80:boolean}} [vhtOperation]
 * @property {{interpretation:string, category:number, psd:boolean, maxTxDbm:(number|null)[]}[]} [txPowerEnvelopes]
 * @property {{neighbors:RnrNeighbor[]}} [rnr]
 * @property {{twtRequester:boolean, twtResponder:boolean, broadcastTwt:boolean, suBeamformer:boolean,
 *             suBeamformee:boolean, muBeamformer:boolean, ulMuMimo:boolean, ldpc:boolean, width40:boolean,
 *             width80:boolean, width160:boolean, width80p80:boolean, nss:number, maxMcs:?number,
 *             nss160:?number}} [he]
 * @property {{bssColor:number, bssColorDisabled:boolean, partialBssColor:boolean, defaultPeDuration:number,
 *             twtRequired:boolean, txopRtsThreshold:number, erSuDisable:boolean,
 *             vhtOperation?:{width:number, centerSeg0:number, centerSeg1:number},
 *             sixGhz?:{primaryChannel:number, width:number, centerSeg0:number, centerSeg1:number,
 *                      duplicateBeacon:boolean, regInfo:number, minRate:number}}} [heOperation]
 * @property {{present:true, width320:boolean, suBeamformer:boolean, suBeamformee:boolean, muBeamformer:boolean,
 *             nss:?number, maxMcs:?number}} [eht]
 * @property {{present:true, width:?number, centerSeg0:?number, centerSeg1:?number,
 *             disabledSubchannels:?number}} [ehtOperation]
 * @property {{present:true, type:string, mldMac:?string, linkId:?number, maxSimultaneousLinks:?number}} [multiLink]
 * @property {{uapsd:boolean, parameterSetCount:number}} [wmm]
 * @property {WpsInfo} [wps]
 * @property {true} [p2p]
 * @property {{release:?number, dgafDisabled:boolean}} [hs20]
 * @property {{assocDisallowed:boolean}} [mbo]
 * @property {true} [multiAp]         Wi-Fi EasyMesh
 * @property {{bssid:string, ssid:string}} [oweTransition]  a rede "par" (aberta <-> OWE)
 * @property {{name:string, clients:?number}} [cisco]       elemento CCX (133)
 * @property {string[]} vendorOuis    OUIs dos elementos de fabricante, na forma "00:50:f2"
 * @property {string} [chipsetHint]   fabricante provável do chip do rádio
 * @property {string} [apName]        nome do ponto de acesso, quando o fabricante anuncia
 */

/**
 * @typedef {Object} RsnInfo
 * @property {number} version
 * @property {?string} groupCipher
 * @property {string[]} pairwiseCiphers  'TKIP', 'CCMP', 'GCMP-256'...
 * @property {string[]} akms             'PSK', 'SAE', 'EAP', 'FT-PSK'...
 * @property {?number} capabilities      campo RSN Capabilities cru (null se ausente)
 * @property {boolean} pmfCapable        MFPC (bit 7)
 * @property {boolean} pmfRequired       MFPR (bit 6)
 * @property {?string} groupMgmtCipher
 */

/**
 * @typedef {Object} RnrNeighbor
 * @property {number} opClass
 * @property {number} channel
 * @property {('2.4'|'5'|'6'|'60'|null)} band   pela classe operacional global
 * @property {?string} bssid
 * @property {?number} shortSsid     CRC-32 do SSID (compare com shortSsid(ssid))
 * @property {?boolean} colocated    o vizinho está no mesmo aparelho (null = o elemento não diz)
 * @property {?boolean} sameSsid
 * @property {?number} tbttOffset    em TUs; null = desconhecido
 * @property {?number} psdDbmPerMhz
 * @property {?number} mldId         0 = mesmo AP MLD de quem anunciou
 * @property {?number} linkId
 */

/**
 * @typedef {Object} WpsInfo
 * @property {?string} version         "1.0" ou "2.0"
 * @property {?number} state           1 = não configurado, 2 = configurado
 * @property {boolean} configured
 * @property {boolean} locked          AP Setup Locked (PIN travado)
 * @property {boolean} selectedRegistrar  alguém acabou de apertar o botão / iniciar o pareamento
 * @property {?string} deviceName
 * @property {?string} manufacturer
 * @property {?string} modelName
 * @property {?string} modelNumber
 * @property {?number} configMethods
 * @property {boolean} pushButton
 * @property {boolean} pin
 */

// ---------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------

/** Valor de um dígito hexadecimal pelo código do caractere; -1 se não for um. */
function hexDigit(code) {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  if (code >= 65 && code <= 70) return code - 55; // A-F
  return -1;
}

/** Corpo em hexadecimal -> bytes. null quando não é hexadecimal válido. */
function toBytes(hex) {
  if (hex instanceof Uint8Array) return hex;
  if (Array.isArray(hex)) {
    const arr = new Uint8Array(hex.length);
    for (let i = 0; i < hex.length; i++) {
      if (!Number.isInteger(hex[i])) return null;
      arr[i] = hex[i] & 0xff;
    }
    return arr;
  }
  if (typeof hex !== 'string') return null;
  // Caminho de sempre (só dígitos hexadecimais, aos pares): uma passada, sem expressões regulares.
  // Isto roda para cada elemento de cada beacon, a cada varredura.
  if (hex.length % 2 === 0) {
    const fast = new Uint8Array(hex.length / 2);
    let i = 0;
    for (; i < fast.length; i++) {
      const hi = hexDigit(hex.charCodeAt(2 * i));
      const lo = hexDigit(hex.charCodeAt(2 * i + 1));
      if (hi < 0 || lo < 0) break;
      fast[i] = (hi << 4) | lo;
    }
    if (i === fast.length) return fast;
  }
  let s = hex.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
  if (/[^0-9a-fA-F]/.test(s)) s = s.replace(/[\s:-]/g, '');
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const hex2 = (v) => (v < 16 ? '0' : '') + (v & 0xff).toString(16);

function toHex(bytes) {
  let s = '';
  for (const v of bytes) s += hex2(v & 0xff);
  return s;
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const s8 = (v) => (v << 24) >> 24;
/** Bit N de um campo (fora do campo = false, porque campos podem vir mais curtos). */
const bit = (b, n) => (n >> 3) < b.length && ((b[n >> 3] >> (n & 7)) & 1) === 1;

function macAt(b, o) {
  let s = '';
  for (let i = 0; i < 6; i++) s += (i ? ':' : '') + b[o + i].toString(16).padStart(2, '0');
  return s;
}

const utf8Decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
// O que o decodificador põe no lugar de bytes que não formam UTF-8.
const REPLACEMENT = String.fromCharCode(0xfffd);

/** Texto de um campo: corta no primeiro NUL, tira caracteres de controle. */
function textAt(b, start, end) {
  const stop = Math.min(end, b.length);
  if (start >= stop) return '';
  let cut = start;
  while (cut < stop && b[cut] !== 0) cut += 1;
  const part = b.slice(start, cut);
  let s = '';
  if (utf8Decoder) s = utf8Decoder.decode(part);
  else for (const v of part) s += String.fromCharCode(v);
  return s.split(REPLACEMENT).join('').replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

/** Só aceita como nome o que for ASCII imprimível (protege contra leiaute errado). */
function asciiName(b, start, end) {
  const stop = Math.min(end, b.length);
  let last = stop;
  while (last > start && (b[last - 1] === 0 || b[last - 1] === 0x20)) last -= 1;
  if (last <= start) return null;
  let s = '';
  for (let i = start; i < last; i++) {
    if (b[i] < 0x20 || b[i] > 0x7e) return null;
    s += String.fromCharCode(b[i]);
  }
  return s.trim() || null;
}

function textBytes(text) {
  const s = String(text ?? '');
  if (utf8Encoder) return [...utf8Encoder.encode(s)];
  return [...s].map((c) => c.charCodeAt(0) & 0xff);
}

/**
 * Short SSID: CRC-32 (o mesmo do FCS) dos bytes do SSID. É o que o Reduced Neighbor
 * Report traz no lugar do nome da rede vizinha.
 * @param {string} ssid
 * @returns {number} inteiro sem sinal de 32 bits
 */
export function shortSsid(ssid) {
  let crc = 0xffffffff;
  for (const byte of textBytes(ssid)) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// tabelas
// ---------------------------------------------------------------------------

const OUI_IEEE = 0x000fac;
const OUI_MS = 0x0050f2;
const OUI_WFA = 0x506f9a;

// Seletores de suíte: OUI (3 bytes) + tipo (1 byte).
const CIPHER_NAMES = {
  [OUI_IEEE]: {
    0: 'USE-GROUP', 1: 'WEP-40', 2: 'TKIP', 4: 'CCMP', 5: 'WEP-104', 6: 'BIP-CMAC-128', 7: 'NO-GROUP',
    8: 'GCMP-128', 9: 'GCMP-256', 10: 'CCMP-256', 11: 'BIP-GMAC-128', 12: 'BIP-GMAC-256', 13: 'BIP-CMAC-256',
  },
  [OUI_MS]: { 0: 'NONE', 1: 'WEP-40', 2: 'TKIP', 4: 'CCMP', 5: 'WEP-104' },
  0x001472: { 1: 'SMS4' },
};

const AKM_NAMES = {
  [OUI_IEEE]: {
    1: 'EAP', 2: 'PSK', 3: 'FT-EAP', 4: 'FT-PSK', 5: 'EAP-SHA256', 6: 'PSK-SHA256', 7: 'TDLS', 8: 'SAE',
    9: 'FT-SAE', 11: 'SUITE-B', 12: 'SUITE-B-192', 13: 'FT-EAP-SHA384', 14: 'FILS-SHA256', 15: 'FILS-SHA384',
    16: 'FT-FILS-SHA256', 17: 'FT-FILS-SHA384', 18: 'OWE', 19: 'FT-PSK-SHA384', 20: 'PSK-SHA384', 21: 'PASN',
    23: 'EAP-SHA384', 24: 'SAE-EXT-KEY', 25: 'FT-SAE-EXT-KEY',
  },
  [OUI_MS]: { 1: 'EAP', 2: 'PSK' },
  [OUI_WFA]: { 1: 'OSEN', 2: 'DPP' },
  0x004096: { 0: 'CCKM' },
};

function suiteName(table, b, o) {
  const oui = (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const type = b[o + 3];
  const name = table[oui] && table[oui][type];
  return name || `UNKNOWN-${oui.toString(16).padStart(6, '0').toUpperCase()}-${type}`;
}

/** Nome -> [oui, tipo], para o encodeIes. */
function suiteSelector(table, name, oui) {
  const types = table[oui];
  for (const type of Object.keys(types)) if (types[type] === name) return [oui, Number(type)];
  return null;
}

// Valores acima de 54 Mbps (108) nos elementos de taxas são "seletores de associação".
const RATE_SELECTORS = { 127: 'HT', 126: 'VHT', 125: 'GLK', 124: 'EPD', 123: 'SAE-H2E', 122: 'HE', 121: 'EHT' };
const RATES_11B = [1, 2, 5.5, 11];

const HT_PROTECTION = ['none', 'nonmember', '20mhz', 'mixed'];
const TPE_INTERPRETATION = ['local-eirp', 'local-psd', 'reg-client-eirp', 'reg-client-psd'];
const ML_TYPES = ['basic', 'probe-request', 'reconfiguration', 'tdls', 'priority-access'];

// Bits do elemento Extended Capabilities (127).
const EXT_CAP_BITS = {
  coex2040: 0,
  extChannelSwitching: 2,
  proxyArp: 12,
  wnmSleepMode: 17,
  bssTransition: 19,
  multipleBssid: 22,
  interworking: 31,
  tdlsProhibited: 38,
  utf8Ssid: 48,
  opModeNotification: 62,
  ftmResponder: 70,
  ftmInitiator: 71,
  twtRequester: 77,
  twtResponder: 78,
  emaAp: 83,
  beaconProtection: 84,
};

// OUIs de fabricantes de chips que costumam assinar elementos próprios no beacon.
const CHIPSET_OUIS = [
  ['00:10:18', 'Broadcom'],
  ['00:90:4c', 'Broadcom'], // Epigram, comprada pela Broadcom
  ['8c:fd:f0', 'Qualcomm'],
  ['00:a0:c6', 'Qualcomm'],
  ['00:03:7f', 'Qualcomm Atheros'],
  ['00:13:74', 'Qualcomm Atheros'],
  ['00:0c:e7', 'MediaTek'],
  ['00:0c:43', 'MediaTek (Ralink)'],
  ['00:e0:4c', 'Realtek'],
  ['00:50:43', 'Marvell'],
  ['00:26:86', 'Quantenna'],
  ['00:17:35', 'Intel'],
  ['00:17:f2', 'Apple'],
];

// Fabricantes que anunciam o nome do AP num elemento próprio, no formato
// OUI + tipo + nome em ASCII até o fim (conforme o dissecador do Wireshark): [OUI, tipo].
const AP_NAME_ELEMENTS = [
  [0x004096, 47], // Cisco/Meraki "AP name v2"
  [0x00156d, 1], // Ubiquiti
  [0x5c5b35, 1], // Mist
  [0x001392, 3], // Ruckus
  [0xdc0856, 1], // Alcatel-Lucent
  [0x848094, 0], // Meter
  [0x48d017, 2], // Telecom Infra Project (OpenWiFi)
];

// ---------------------------------------------------------------------------
// decodificadores (cada um devolve o objeto, ou null se o corpo não serve)
// ---------------------------------------------------------------------------

function readRates(acc, b) {
  for (const v of b) {
    const value = v & 0x7f;
    if (value === 0) continue;
    if (value > 108) {
      const name = RATE_SELECTORS[value];
      if (name && !acc.selectors.includes(name)) acc.selectors.push(name);
      continue;
    }
    const mbps = value / 2;
    if (!acc.rates.includes(mbps)) acc.rates.push(mbps);
    if (v & 0x80 && !acc.basic.includes(mbps)) acc.basic.push(mbps);
  }
}

function finishRates(acc) {
  if (acc.rates.length === 0 && acc.selectors.length === 0) return null;
  const asc = (x, y) => x - y;
  const rates = acc.rates.slice().sort(asc);
  const basicRates = acc.basic.slice().sort(asc);
  const is11b = (r) => RATES_11B.includes(r);
  return {
    rates,
    basicRates,
    // rede que ainda "fala 11b": os beacons e o controle saem nas taxas lentas de 1999
    legacy11b: basicRates.some(is11b) || (rates.length > 0 && rates.every(is11b)),
    supports11b: rates.some(is11b),
    minBasicRate: basicRates.length ? basicRates[0] : null,
    selectors: acc.selectors.slice(),
  };
}

function readCountry(b) {
  if (b.length < 3) return null;
  const code = String.fromCharCode(b[0], b[1]).toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(code)) return null;
  const env = b[2];
  const environment =
    env === 0x20 ? 'any' : env === 0x49 ? 'indoor' : env === 0x4f ? 'outdoor' : env === 0x58 ? 'noncountry' : env === 0x04 ? 'global' : 'unknown';
  const triplets = [];
  const operating = [];
  for (let i = 3; i + 3 <= b.length; i += 3) {
    const first = b[i];
    // 201 ou mais = trinca de classe operacional, não de canais
    if (first >= 201) operating.push({ extId: first, opClass: b[i + 1], coverageClass: b[i + 2] });
    else if (first !== 0 && b[i + 1] !== 0) triplets.push({ first, count: b[i + 1], maxTxDbm: s8(b[i + 2]) });
  }
  return { code, environment, triplets, operating };
}

function readHtCapabilities(b) {
  if (b.length < 26) return null;
  const cap = u16(b, 0);
  // Máscara de MCS de recepção: bytes 3..12 do corpo; cada um dos 4 primeiros é um fluxo espacial.
  // O maior MCS é o do fluxo que vai mais longe (um AP pode limitar a modulação do último fluxo).
  let nss = 0;
  let top = -1;
  for (let i = 0; i < 4; i++) {
    if (b[3 + i] !== 0) nss += 1;
    for (let k = 0; k < 8; k++) if (b[3 + i] & (1 << k) && k > top) top = k;
  }
  return {
    ldpc: (cap & 0x0001) !== 0,
    width40: (cap & 0x0002) !== 0,
    greenfield: (cap & 0x0010) !== 0,
    sgi20: (cap & 0x0020) !== 0,
    sgi40: (cap & 0x0040) !== 0,
    txStbc: (cap & 0x0080) !== 0,
    rxStbc: (cap >> 8) & 3,
    maxAmsdu: cap & 0x0800 ? 7935 : 3839,
    fortyIntolerant: (cap & 0x4000) !== 0,
    nss,
    maxMcs: top < 0 ? null : top,
  };
}

function readHtOperation(b) {
  if (b.length < 22) return null;
  const offset = b[1] & 3;
  const mode = u16(b, 2);
  return {
    primaryChannel: b[0],
    secondaryOffset: offset === 1 ? 'above' : offset === 3 ? 'below' : null,
    staWidth: b[1] & 0x04 ? 40 : 20,
    protection: HT_PROTECTION[mode & 3],
    nonGreenfieldPresent: (mode & 0x0004) !== 0,
    obssNonHtPresent: (mode & 0x0010) !== 0,
    centerSeg2: (mode >> 5) & 0xff,
  };
}

/** Corpo de um RSNE a partir do campo Version (o mesmo leiaute serve para o WPA1 e o RSNE Override). */
function readRsn(b, start) {
  let pos = start;
  if (b.length < pos + 2 || u16(b, pos) !== 1) return null;
  const out = {
    version: 1,
    groupCipher: null,
    pairwiseCiphers: [],
    akms: [],
    capabilities: null,
    pmfCapable: false,
    pmfRequired: false,
    groupMgmtCipher: null,
  };
  pos += 2;
  // Daqui em diante tudo é opcional: o elemento pode acabar no fim de qualquer campo.
  if (b.length < pos + 4) return out;
  out.groupCipher = suiteName(CIPHER_NAMES, b, pos);
  pos += 4;
  for (const [list, table] of [[out.pairwiseCiphers, CIPHER_NAMES], [out.akms, AKM_NAMES]]) {
    if (b.length < pos + 2) return out;
    const n = u16(b, pos);
    pos += 2;
    if (b.length < pos + 4 * n) return null; // promete mais suítes do que tem: corpo corrompido
    for (let i = 0; i < n; i++, pos += 4) {
      const name = suiteName(table, b, pos);
      if (!list.includes(name)) list.push(name);
    }
  }
  if (b.length < pos + 2) return out;
  out.capabilities = u16(b, pos);
  out.pmfRequired = (out.capabilities & 0x0040) !== 0;
  out.pmfCapable = (out.capabilities & 0x0080) !== 0;
  pos += 2;
  if (b.length < pos + 2) return out;
  pos += 2 + 16 * u16(b, pos); // lista de PMKIDs
  if (b.length >= pos + 4) out.groupMgmtCipher = suiteName(CIPHER_NAMES, b, pos);
  return out;
}

/** Mapa de MCS do VHT/HE: 2 bits por fluxo espacial; 3 = fluxo não suportado. */
function readMcsMap(map, mcsByCode) {
  let nss = 0;
  let maxMcs = null;
  for (let i = 0; i < 8; i++) {
    const code = (map >> (2 * i)) & 3;
    if (code === 3) continue;
    nss = i + 1;
    if (maxMcs === null || mcsByCode[code] > maxMcs) maxMcs = mcsByCode[code];
  }
  return { nss, maxMcs };
}

function readVhtCapabilities(b) {
  if (b.length < 12) return null;
  const cap = u32(b, 0);
  const widthSet = (cap >>> 2) & 3;
  const { nss, maxMcs } = readMcsMap(u16(b, 4), [7, 8, 9]);
  return {
    maxMpdu: [3895, 7991, 11454][cap & 3] ?? 3895,
    width160: widthSet === 1 || widthSet === 2,
    width80p80: widthSet === 2,
    rxLdpc: (cap & 0x10) !== 0,
    sgi80: (cap & 0x20) !== 0,
    sgi160: (cap & 0x40) !== 0,
    suBeamformer: (cap & 0x800) !== 0,
    suBeamformee: (cap & 0x1000) !== 0,
    muBeamformer: (cap & 0x80000) !== 0,
    muBeamformee: (cap & 0x100000) !== 0,
    extNssBw: cap >>> 30,
    nss,
    maxMcs,
  };
}

function readVhtOperation(b) {
  if (b.length < 5) return null;
  const width = b[0];
  const centerSeg0 = b[1];
  const centerSeg1 = b[2];
  // 1 = 80 MHz ou mais: 160 e 80+80 são sinalizados pelo segundo centro (forma atual);
  // 2 e 3 são a forma antiga, já obsoleta, de dizer 160 e 80+80.
  let widthMhz = null;
  let plus80 = false;
  if (width === 1) {
    const gap = Math.abs(centerSeg1 - centerSeg0);
    if (centerSeg1 === 0) widthMhz = 80;
    else if (gap === 8) widthMhz = 160;
    else if (gap > 16) {
      widthMhz = 80;
      plus80 = true;
    } else widthMhz = 80;
  } else if (width === 2) widthMhz = 160;
  else if (width === 3) {
    widthMhz = 80;
    plus80 = true;
  }
  return { width, centerSeg0, centerSeg1, widthMhz, plus80 };
}

function readTxPowerEnvelope(b) {
  if (b.length < 2) return null;
  const count = b[0] & 7;
  const type = (b[0] >> 3) & 7;
  if (type > 3) return null;
  const psd = type === 1 || type === 3;
  // EIRP: count+1 valores (20, 40, 80, 160 MHz). PSD: 1, 1, 2, 4 ou 8 valores (um por canal de 20 MHz).
  if (psd ? count > 4 : count > 3) return null;
  const wanted = psd ? (count ? 1 << (count - 1) : 1) : count + 1;
  const maxTxDbm = [];
  for (let i = 1; i <= wanted && i < b.length; i++) maxTxDbm.push(b[i] === 127 ? null : s8(b[i]) / 2); // 127 = sem limite
  return { interpretation: TPE_INTERPRETATION[type], category: b[0] >> 6, psd, maxTxDbm };
}

function bandOfOpClass(opClass) {
  if (opClass >= 81 && opClass <= 84) return '2.4';
  if (opClass >= 115 && opClass <= 130) return '5';
  if (opClass >= 131 && opClass <= 137) return '6';
  if (opClass >= 180 && opClass <= 183) return '60'; // 181 a 183: canais juntados do 802.11ay
  return null;
}

/** Um campo "TBTT Information": o que ele contém depende só do tamanho. */
function readTbttInfo(b, pos, len, base) {
  const n = {
    ...base,
    bssid: null,
    shortSsid: null,
    colocated: null,
    sameSsid: null,
    tbttOffset: b[pos] === 255 ? null : b[pos],
    psdDbmPerMhz: null,
    mldId: null,
    linkId: null,
  };
  let params = -1; // posição do BSS Parameters
  let psd = -1;
  let mld = -1;
  let ssid = -1;
  if (len === 2) params = 1;
  else if (len === 4) mld = 1;
  else if (len === 5 || len === 6) {
    ssid = 1;
    if (len === 6) params = 5;
  } else if (len >= 7 && len <= 10) {
    n.bssid = macAt(b, pos + 1);
    if (len === 8 || len === 9) params = 7;
    if (len === 9) psd = 8;
    if (len === 10) mld = 7;
  } else if (len >= 11 && len !== 14 && len !== 15) {
    n.bssid = macAt(b, pos + 1);
    ssid = 7;
    if (len >= 12) params = 11;
    if (len >= 13) psd = 12;
    if (len >= 16) mld = 13;
  }
  if (ssid >= 0) n.shortSsid = u32(b, pos + ssid);
  if (params >= 0) {
    n.sameSsid = (b[pos + params] & 0x02) !== 0;
    n.colocated = (b[pos + params] & 0x40) !== 0;
  }
  // 127 = sem limite; -128 = reservado
  if (psd >= 0 && b[pos + psd] !== 127 && b[pos + psd] !== 128) n.psdDbmPerMhz = s8(b[pos + psd]) / 2;
  if (mld >= 0) {
    n.mldId = b[pos + mld];
    n.linkId = b[pos + mld + 1] & 0x0f;
  }
  return n;
}

function readRnr(b, neighbors) {
  let pos = 0;
  while (pos + 4 <= b.length) {
    const type = b[pos] & 3;
    const count = (b[pos] >> 4) + 1;
    const len = b[pos + 1];
    const opClass = b[pos + 2];
    const channel = b[pos + 3];
    pos += 4;
    if (len === 0) return;
    for (let i = 0; i < count; i++, pos += len) {
      if (pos + len > b.length) return;
      if (type !== 0) continue;
      neighbors.push(readTbttInfo(b, pos, len, { opClass, channel, band: bandOfOpClass(opClass) }));
    }
  }
}

/** Tamanho que o corpo do HE Capabilities deveria ter, pelos próprios bits (null = curto demais). */
function heCapabilitiesLength(b) {
  if (b.length < 21) return null;
  const phy = b.subarray(6, 17);
  let len = 17 + 4 + (bit(phy, 3) ? 4 : 0) + (bit(phy, 4) ? 4 : 0);
  if (bit(phy, 55)) {
    if (b.length <= len) return null;
    // PPE Thresholds: 3 bits de NSS, 4 de máscara de RU e 6 bits por (fluxo x RU)
    const nss = (b[len] & 7) + 1;
    let rus = 0;
    for (let k = 3; k < 7; k++) if (b[len] & (1 << k)) rus += 1;
    len += Math.ceil((7 + 6 * nss * rus) / 8);
  }
  return len;
}

function readHeCapabilities(b) {
  if (b.length < 21) return null;
  const mac = b.subarray(0, 6);
  const phy = b.subarray(6, 17);
  const { nss, maxMcs } = readMcsMap(u16(b, 17), [7, 9, 11]);
  const width160 = bit(phy, 3);
  return {
    twtRequester: bit(mac, 1),
    twtResponder: bit(mac, 2),
    broadcastTwt: bit(mac, 20),
    // Conjunto de larguras: bit 1 = 40 MHz em 2,4 GHz; bit 2 = 40 e 80 MHz em 5/6 GHz;
    // bit 3 = 160 MHz; bit 4 = 80+80 MHz.
    width40: bit(phy, 1) || bit(phy, 2),
    width80: bit(phy, 2),
    width160,
    width80p80: bit(phy, 4),
    ldpc: bit(phy, 13),
    ulMuMimo: bit(phy, 22),
    suBeamformer: bit(phy, 31),
    suBeamformee: bit(phy, 32),
    muBeamformer: bit(phy, 33),
    nss,
    maxMcs,
    nss160: width160 && b.length >= 25 ? readMcsMap(u16(b, 21), [7, 9, 11]).nss : null,
  };
}

function heOperationLength(b) {
  if (b.length < 6) return null;
  return 6 + (bit(b, 14) ? 3 : 0) + (bit(b, 15) ? 1 : 0) + (bit(b, 17) ? 5 : 0);
}

function readHeOperation(b) {
  if (b.length < 6) return null;
  const params = b[0] | (b[1] << 8) | (b[2] << 16);
  const out = {
    bssColor: b[3] & 0x3f,
    partialBssColor: (b[3] & 0x40) !== 0,
    bssColorDisabled: (b[3] & 0x80) !== 0,
    defaultPeDuration: params & 7,
    twtRequired: (params & 0x08) !== 0,
    txopRtsThreshold: (params >> 4) & 0x3ff,
    erSuDisable: (params & 0x10000) !== 0,
  };
  let pos = 6; // depois do Basic HE-MCS And NSS Set
  if (params & 0x4000) {
    if (b.length < pos + 3) return out;
    out.vhtOperation = { width: b[pos], centerSeg0: b[pos + 1], centerSeg1: b[pos + 2] };
    pos += 3;
  }
  if (params & 0x8000) pos += 1; // Max Co-Hosted BSSID Indicator
  if (params & 0x20000 && b.length >= pos + 5) {
    const control = b[pos + 1];
    out.sixGhz = {
      primaryChannel: b[pos],
      width: [20, 40, 80, 160][control & 3],
      centerSeg0: b[pos + 2],
      centerSeg1: b[pos + 3],
      duplicateBeacon: (control & 0x04) !== 0,
      // Regulatory Info tem 4 bits (B3-B6): 0 = interno de baixa potência, 1 = potência padrão,
      // 2 = potência muito baixa, 8 = interno de potência padrão (não cabe em 3 bits)
      regInfo: (control >> 3) & 0x0f,
      minRate: b[pos + 4],
    };
  }
  return out;
}

function readEhtCapabilities(b) {
  if (b.length < 11) return null;
  const phy = b.subarray(2, 11);
  const out = {
    present: true,
    width320: bit(phy, 1),
    suBeamformer: bit(phy, 5),
    suBeamformee: bit(phy, 6),
    muBeamformer: bit(phy, 60) || bit(phy, 61) || bit(phy, 62),
    nss: null,
    maxMcs: null,
  };
  // Um AP sempre começa o mapa pelo bloco "até 80 MHz": 3 bytes (MCS 0-9, 10-11, 12-13),
  // cada um com o nº de fluxos de recepção nos 4 bits baixos.
  if (b.length >= 12) {
    const rx = b[11] & 0x0f;
    if (rx >= 1 && rx <= 8) {
      out.nss = rx;
      out.maxMcs = 9;
      if (b.length >= 14) out.maxMcs = b[13] & 0x0f ? 13 : b[12] & 0x0f ? 11 : 9;
    }
  }
  return out;
}

function ehtOperationLength(b) {
  if (b.length < 5) return null;
  return 5 + (b[0] & 0x01 ? 3 + (b[0] & 0x02 ? 2 : 0) : 0);
}

function readEhtOperation(b) {
  if (b.length < 5) return null;
  const out = { present: true, width: null, centerSeg0: null, centerSeg1: null, disabledSubchannels: null };
  if (b[0] & 0x01 && b.length >= 8) {
    out.width = [20, 40, 80, 160, 320][b[5] & 7] ?? null;
    out.centerSeg0 = b[6];
    out.centerSeg1 = b[7];
    // um bit por canal de 20 MHz "furado" (puncturing)
    if (b[0] & 0x02 && b.length >= 10) out.disabledSubchannels = u16(b, 8);
  }
  return out;
}

function readMultiLink(b) {
  if (b.length < 2) return null;
  const control = u16(b, 0);
  const type = control & 7;
  const out = { present: true, type: ML_TYPES[type] || 'unknown', mldMac: null, linkId: null, maxSimultaneousLinks: null };
  // Basic: Common Info = tamanho (1) + MAC do MLD (6) + campos opcionais na ordem dos bits de presença
  if (type !== 0 || b.length < 9) return out;
  out.mldMac = macAt(b, 3);
  const end = Math.min(b.length, 2 + b[2]);
  let pos = 9;
  if (control & 0x0010) {
    if (pos < end) out.linkId = b[pos] & 0x0f;
    pos += 1;
  }
  if (control & 0x0020) pos += 1; // BSS Parameters Change Count
  if (control & 0x0040) pos += 2; // Medium Synchronization Delay
  if (control & 0x0080) pos += 2; // EML Capabilities
  if (control & 0x0100 && pos + 2 <= end) out.maxSimultaneousLinks = (u16(b, pos) & 0x0f) + 1;
  return out;
}

function readWps(b) {
  const out = {
    version: null,
    state: null,
    configured: false,
    locked: false,
    selectedRegistrar: false,
    deviceName: null,
    manufacturer: null,
    modelName: null,
    modelNumber: null,
    configMethods: null,
    pushButton: false,
    pin: false,
  };
  let found = 0;
  let pos = 4; // depois de OUI + tipo
  while (pos + 4 <= b.length) {
    const type = u16be(b, pos);
    const len = u16be(b, pos + 2);
    const at = pos + 4;
    if (at + len > b.length) break;
    pos = at + len;
    found += 1;
    const str = () => textAt(b, at, at + len) || null;
    if (type === 0x104a && len >= 1) out.version = `${b[at] >> 4}.${b[at] & 0x0f}`;
    else if (type === 0x1044 && len >= 1) out.state = b[at];
    else if (type === 0x1057 && len >= 1) out.locked = b[at] !== 0;
    else if (type === 0x1041 && len >= 1) out.selectedRegistrar = b[at] !== 0;
    else if (type === 0x1011) out.deviceName = str();
    else if (type === 0x1021) out.manufacturer = str();
    else if (type === 0x1023) out.modelName = str();
    else if (type === 0x1024) out.modelNumber = str();
    else if (type === 0x1008 && len >= 2) out.configMethods = u16be(b, at);
    else if (type === 0x1049 && len >= 6 && b[at] === 0x00 && b[at + 1] === 0x37 && b[at + 2] === 0x2a) {
      // extensão da Wi-Fi Alliance (00-37-2A): subelemento 0 = Version2
      if (b[at + 3] === 0 && b[at + 4] >= 1) out.version = `${b[at + 5] >> 4}.${b[at + 5] & 0x0f}`;
    }
  }
  if (found === 0) return null;
  out.configured = out.state === 2;
  if (out.configMethods !== null) {
    out.pushButton = (out.configMethods & 0x0080) !== 0;
    out.pin = (out.configMethods & 0x010c) !== 0; // etiqueta, visor ou teclado
  }
  return out;
}

function readMbo(b) {
  const out = { assocDisallowed: false };
  // atributos: id (1) + tamanho (1) + valor; 4 = "Association Disallowed"
  for (let pos = 4; pos + 2 <= b.length; pos += 2 + b[pos + 1]) if (b[pos] === 4) out.assocDisallowed = true;
  return out;
}

function readOweTransition(b) {
  if (b.length < 11) return null;
  const ssidLen = b[10];
  if (ssidLen > 32 || b.length < 11 + ssidLen) return null;
  return { bssid: macAt(b, 4), ssid: textAt(b, 11, 11 + ssidLen) };
}

/** MikroTik: OUI + 3 bytes + TLVs (tipo, tamanho); tipo 1 com 30 bytes = 10 de prefixo + nome do rádio. */
function mikrotikName(b) {
  for (let pos = 6; pos + 2 <= b.length; pos += 2 + b[pos + 1]) {
    if (b[pos] === 1 && b[pos + 1] === 30 && pos + 32 <= b.length) return asciiName(b, pos + 12, pos + 32);
    if (b[pos + 1] === 0) break;
  }
  return null;
}

function vendorApName(oui, b) {
  const type = b.length > 3 ? b[3] : -1;
  for (const [o, t] of AP_NAME_ELEMENTS) if (o === oui && t === type) return asciiName(b, 4, b.length);
  // Aruba e Huawei: tipo, subtipo (3 e 1), um byte e o nome
  if (oui === 0x000b86 && type === 1 && b.length > 6 && b[4] === 3) return asciiName(b, 6, b.length);
  if (oui === 0x00e0fc && b.length > 6 && b[4] === 1) return asciiName(b, 6, b.length);
  // Aerohive/Extreme: tipo 33, versão, subtipo, tamanho do nome, nome
  if (oui === 0x001977 && type === 33 && b.length > 7) return asciiName(b, 7, 7 + b[6]);
  if (oui === 0x000c42) return mikrotikName(b);
  return null;
}

function readVendor(info, acc, b) {
  if (b.length < 3) return;
  const oui = (b[0] << 16) | (b[1] << 8) | b[2];
  const ouiText = `${hex2(b[0])}:${hex2(b[1])}:${hex2(b[2])}`;
  if (!info.vendorOuis.includes(ouiText)) info.vendorOuis.push(ouiText);
  if (b.length < 4) return;
  const type = b[3];
  const set = (key, value) => {
    if (value != null && info[key] === undefined) info[key] = value;
  };

  if (oui === OUI_MS) {
    if (type === 1) set('wpa', readRsn(b, 4));
    else if (type === 2 && b.length >= 7 && (b[4] === 0 || b[4] === 1)) {
      // WMM: subtipo 0 (informação) ou 1 (parâmetros), versão, QoS Info (bit 7 = U-APSD)
      set('wmm', { uapsd: (b[6] & 0x80) !== 0, parameterSetCount: b[6] & 0x0f });
    } else if (type === 4) set('wps', readWps(b));
  } else if (oui === OUI_WFA) {
    if (type === 0x09) set('p2p', true);
    else if (type === 0x10) set('hs20', { release: b.length > 4 ? (b[4] >> 4) + 1 : null, dgafDisabled: b.length > 4 && (b[4] & 1) !== 0 });
    else if (type === 0x16) set('mbo', readMbo(b));
    else if (type === 0x1b) set('multiAp', true);
    else if (type === 0x1c) set('oweTransition', readOweTransition(b));
    else if (type === 0x29) set('rsnOverride', readRsn(b, 4));
    else if (type === 0x2a) set('rsnOverride2', readRsn(b, 4));
  } else if (!acc.vendorName) {
    acc.vendorName = vendorApName(oui, b);
  }
}

/** Extensão (id 255): devolve {ext, body} já sem o byte de extensão, mesmo que o celular o tenha deixado no corpo. */
function splitExtension(extIn, b) {
  const ext = Number.isInteger(extIn) ? extIn & 0xff : 0;
  // 0 não é uma extensão válida: o número só pode estar no primeiro byte do corpo
  if (ext === 0) return b.length ? { ext: b[0], body: b.subarray(1) } : null;
  if (b.length > 1 && b[0] === ext) {
    // Pode ser coincidência. Só corta quando o tamanho que os próprios bits do elemento
    // pedem bate sem o primeiro byte e não bate com ele.
    const expected = ext === 35 ? heCapabilitiesLength : ext === 36 ? heOperationLength : ext === 106 ? ehtOperationLength : null;
    if (expected) {
      const rest = b.subarray(1);
      if (expected(b) !== b.length && expected(rest) === rest.length) return { ext, body: rest };
    }
  }
  return { ext, body: b };
}

function readElement(info, acc, id, extIn, b) {
  const set = (key, value) => {
    if (value != null && info[key] === undefined) info[key] = value;
  };
  switch (id) {
    case 1:
    case 50:
      readRates(acc.rates, b);
      break;
    case 3:
      if (b.length >= 1) set('ds', { channel: b[0] });
      break;
    case 7:
      set('country', readCountry(b));
      break;
    case 11:
      if (b.length >= 5) set('bssLoad', { stations: u16(b, 0), utilization: b[2] / 255, admissionCapacity: u16(b, 3) });
      break;
    case 32:
      if (b.length >= 1) set('powerConstraint', { db: b[0] });
      break;
    case 35:
      if (b.length >= 2) set('tpcReport', { txPowerDbm: s8(b[0]), linkMargin: s8(b[1]) });
      break;
    case 42:
      if (b.length >= 1) {
        set('erp', { nonErpPresent: (b[0] & 1) !== 0, useProtection: (b[0] & 2) !== 0, barkerPreamble: (b[0] & 4) !== 0 });
      }
      break;
    case 45:
      set('ht', readHtCapabilities(b));
      break;
    case 48:
      set('rsn', readRsn(b, 0));
      break;
    case 54:
      if (b.length >= 3) set('mobilityDomain', { mdid: u16(b, 0), ftOverDs: (b[2] & 1) !== 0, resourceRequest: (b[2] & 2) !== 0 });
      break;
    case 61:
      set('htOperation', readHtOperation(b));
      break;
    case 70:
      if (b.length >= 5) {
        set('rm', {
          linkMeasurement: bit(b, 0),
          neighborReport: bit(b, 1),
          beaconPassive: bit(b, 4),
          beaconActive: bit(b, 5),
          beaconTable: bit(b, 6),
        });
      }
      break;
    case 71:
      if (b.length >= 1) set('multipleBssid', { maxIndicator: b[0] });
      break;
    case 107:
      if (b.length >= 1) {
        set('interworking', {
          accessNetworkType: b[0] & 0x0f,
          internet: (b[0] & 0x10) !== 0,
          asra: (b[0] & 0x20) !== 0,
          esr: (b[0] & 0x40) !== 0,
          uesa: (b[0] & 0x80) !== 0,
          // corpo de 7 bytes = opções + HESSID; de 9 = opções + local (2) + HESSID
          hessid: b.length === 7 ? macAt(b, 1) : b.length === 9 ? macAt(b, 3) : null,
        });
      }
      break;
    case 127:
      if (b.length >= 1 && info.extCaps === undefined) {
        const caps = {};
        for (const name of Object.keys(EXT_CAP_BITS)) caps[name] = bit(b, EXT_CAP_BITS[name]);
        info.extCaps = caps;
      }
      break;
    case 133:
      // Cisco CCX: 10 bytes, nome do AP (16, completado com zeros), nº de clientes, 3 bytes
      if (b.length >= 26) {
        const name = asciiName(b, 10, 26);
        if (name) set('cisco', { name, clients: b.length > 26 ? b[26] : null });
      }
      break;
    case 191:
      set('vht', readVhtCapabilities(b));
      break;
    case 192:
      set('vhtOperation', readVhtOperation(b));
      break;
    case 195: {
      const tpe = readTxPowerEnvelope(b);
      if (tpe) (info.txPowerEnvelopes || (info.txPowerEnvelopes = [])).push(tpe);
      break;
    }
    case 201:
      readRnr(b, acc.neighbors);
      break;
    case 221:
      readVendor(info, acc, b);
      break;
    case 255: {
      const x = splitExtension(extIn, b);
      if (!x) break;
      if (x.ext === 35) set('he', readHeCapabilities(x.body));
      else if (x.ext === 36) set('heOperation', readHeOperation(x.body));
      else if (x.ext === 106) set('ehtOperation', readEhtOperation(x.body));
      else if (x.ext === 107) set('multiLink', readMultiLink(x.body));
      else if (x.ext === 108) set('eht', readEhtCapabilities(x.body));
      break;
    }
    default:
      break;
  }
}

/**
 * Interpreta os elementos de informação de um beacon.
 * @param {RawIe[]} ies  ScanAp.ies (veja app/js/bridge.js)
 * @returns {IeInfo}
 */
export function parseIes(ies) {
  const info = { count: 0, vendorOuis: [] };
  if (!Array.isArray(ies)) return info;
  const acc = { rates: { rates: [], basic: [], selectors: [] }, neighbors: [], vendorName: null };
  for (const ie of ies) {
    try {
      if (!ie || typeof ie !== 'object') continue;
      const id = Number(ie.id);
      const body = toBytes(ie.hex);
      if (!Number.isInteger(id) || id < 0 || id > 255 || !body) continue;
      info.count += 1;
      readElement(info, acc, id, Number(ie.ext), body);
    } catch {
      // elemento fora do padrão: segue para o próximo
    }
  }
  const rates = finishRates(acc.rates);
  if (rates) info.rates = rates;
  if (acc.neighbors.length) info.rnr = { neighbors: acc.neighbors };
  for (const [oui, name] of CHIPSET_OUIS) {
    if (info.vendorOuis.includes(oui)) {
      info.chipsetHint = name;
      break;
    }
  }
  const apName = (info.cisco && info.cisco.name) || acc.vendorName;
  if (apName) info.apName = apName;
  return info;
}

// ---------------------------------------------------------------------------
// resumo para a interface
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} IeSummary
 * @property {(4|5|6|7|null)} gen       geração do Wi-Fi anunciada (HT/VHT/HE/EHT)
 * @property {?number} nss              fluxos espaciais (antenas úteis) do AP
 * @property {?number} maxMcs           maior MCS da geração mais nova anunciada
 * @property {?(20|40|80|160|320)} maxWidthMHz  maior largura de canal que o AP anuncia saber usar (HT: 40 MHz ou
 *                                      não; VHT e HE: 80, ou 160 com o bit; EHT: 320); null sem HT/VHT/HE/EHT.
 *                                      É o que o beacon diz hoje: um roteador com 160 MHz desligado pode não anunciar
 * @property {?number} stations         aparelhos associados (BSS Load; senão o contador do Cisco CCX)
 * @property {?number} utilization      ocupação do canal medida pelo AP, 0..1
 * @property {{k:boolean, v:boolean, r:boolean}} roaming
 * @property {?{enabled:boolean, configured:boolean, locked:boolean, deviceName:?string, manufacturer:?string, model:?string}} wps
 * @property {?string} country
 * @property {?number} txPowerDbm       potência com que o beacon foi transmitido (TPC Report)
 * @property {?number} bssColor         null quando ausente ou desligado
 * @property {boolean} twt
 * @property {boolean} muMimo
 * @property {boolean} beamforming
 * @property {boolean} mlo
 * @property {?string} mldMac
 * @property {?string} apName
 * @property {?string} chipsetHint
 * @property {boolean} legacy11b
 * @property {boolean} wmm
 * @property {boolean} ftmResponder
 * @property {{band:?string, channel:number, bssid:string}[]} colocated  outros rádios do mesmo aparelho
 * @property {boolean} passpoint
 * @property {boolean} mesh             anuncia Wi-Fi EasyMesh (Multi-AP)
 * @property {boolean} p2p
 */

/**
 * Resumo plano do que interessa mostrar na tela.
 * @param {IeInfo} info  resultado de parseIes
 * @returns {IeSummary}
 */
export function summarizeIes(info) {
  const i = info && typeof info === 'object' ? info : {};
  const obj = (v) => (v && typeof v === 'object' ? v : null);
  const ht = obj(i.ht);
  const vht = obj(i.vht);
  const he = obj(i.he);
  const eht = obj(i.eht);
  const heOp = obj(i.heOperation);
  const wps = obj(i.wps);
  const ext = obj(i.extCaps) || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  let gen = null;
  if (eht || obj(i.ehtOperation)) gen = 7;
  else if (he || heOp) gen = 6;
  else if (vht || obj(i.vhtOperation)) gen = 5;
  else if (ht || obj(i.htOperation)) gen = 4;

  // fluxos e MCS: vale a geração mais nova que trouxe o dado
  let nss = null;
  let maxMcs = null;
  for (const caps of [eht, he, vht, ht]) {
    if (caps && num(caps.nss) && caps.nss > 0) {
      nss = caps.nss;
      maxMcs = num(caps.maxMcs);
      break;
    }
  }

  // Maior largura anunciada. VHT obriga 80 MHz; 160 (ou 80+80) é opcional e tem bit próprio, em
  // VHT e em HE; 320 só em EHT. (Em 2,4 GHz quem usa o número limita a 40.)
  let maxWidthMHz = null;
  const widest = (w) => {
    if (maxWidthMHz === null || w > maxWidthMHz) maxWidthMHz = w;
  };
  if (ht) widest(ht.width40 ? 40 : 20);
  if (vht) widest(vht.width160 || vht.width80p80 ? 160 : 80);
  if (he) widest(he.width160 || he.width80p80 ? 160 : he.width80 ? 80 : he.width40 ? 40 : 20);
  if (eht && eht.width320) widest(320);

  let model = null;
  if (wps) {
    const name = typeof wps.modelName === 'string' ? wps.modelName : '';
    const number = typeof wps.modelNumber === 'string' ? wps.modelNumber : '';
    model = (name && number && !name.includes(number) ? `${name} ${number}` : name || number) || null;
  }

  const colocated = [];
  const neighbors = obj(i.rnr) && Array.isArray(i.rnr.neighbors) ? i.rnr.neighbors : [];
  for (const n of neighbors) {
    if (!n || typeof n.bssid !== 'string') continue;
    // "mesmo aparelho": o bit Co-Located AP, ou outro enlace do mesmo AP MLD (Wi-Fi 7)
    if (n.colocated === true || n.mldId === 0) colocated.push({ band: n.band ?? null, channel: n.channel, bssid: n.bssid });
  }

  const bssLoad = obj(i.bssLoad);
  const cisco = obj(i.cisco);
  return {
    gen,
    nss,
    maxMcs,
    maxWidthMHz,
    stations: bssLoad ? num(bssLoad.stations) : cisco ? num(cisco.clients) : null,
    utilization: bssLoad ? num(bssLoad.utilization) : null,
    roaming: { k: !!obj(i.rm), v: ext.bssTransition === true, r: !!obj(i.mobilityDomain) },
    wps: wps
      ? {
          enabled: true,
          configured: wps.configured === true,
          locked: wps.locked === true,
          deviceName: wps.deviceName || null,
          manufacturer: wps.manufacturer || null,
          model,
        }
      : null,
    country: obj(i.country) && typeof i.country.code === 'string' ? i.country.code : null,
    txPowerDbm: obj(i.tpcReport) ? num(i.tpcReport.txPowerDbm) : null,
    bssColor: heOp && heOp.bssColorDisabled !== true ? num(heOp.bssColor) : null,
    twt: !!(he && he.twtResponder) || ext.twtResponder === true,
    muMimo: !!((vht && vht.muBeamformer) || (he && he.muBeamformer) || (eht && eht.muBeamformer)),
    beamforming: !!((vht && vht.suBeamformer) || (he && he.suBeamformer) || (eht && eht.suBeamformer)),
    mlo: !!obj(i.multiLink),
    mldMac: obj(i.multiLink) && typeof i.multiLink.mldMac === 'string' ? i.multiLink.mldMac : null,
    apName: typeof i.apName === 'string' ? i.apName : null,
    chipsetHint: typeof i.chipsetHint === 'string' ? i.chipsetHint : null,
    legacy11b: !!(obj(i.rates) && i.rates.legacy11b),
    wmm: !!obj(i.wmm),
    ftmResponder: ext.ftmResponder === true,
    colocated,
    passpoint: !!obj(i.hs20),
    mesh: i.multiAp === true,
    p2p: i.p2p === true,
  };
}

// ---------------------------------------------------------------------------
// caminho inverso (simulador e testes)
// ---------------------------------------------------------------------------

function bandOfFrequency(f) {
  if (!Number.isFinite(f)) return null;
  if (f >= 2400 && f <= 2500) return '2.4';
  if (f >= 5150 && f <= 5900) return '5';
  if (f >= 5925 && f <= 7125) return '6';
  return null;
}

function channelOfFrequency(f, band) {
  let ch = null;
  if (band === '2.4') ch = f === 2484 ? 14 : f >= 2412 && f <= 2472 ? (f - 2407) / 5 : null;
  else if (band === '5') ch = f >= 5160 && f <= 5885 ? (f - 5000) / 5 : null;
  else if (band === '6') ch = f === 5935 ? 2 : f >= 5955 && f <= 7115 ? (f - 5950) / 5 : null;
  return Number.isInteger(ch) ? ch : null;
}

// Canais centrais dos blocos clássicos de 5 GHz, canais 36 a 165 (os de 6 GHz saem por fórmula).
const CENTERS_5 = {
  40: [38, 46, 54, 62, 102, 110, 118, 126, 134, 142, 151, 159],
  80: [42, 58, 106, 122, 138, 155],
  160: [50, 114],
};

/** Canal central do bloco de `width` MHz que contém o canal primário (null = não existe). */
function blockCenter(band, channel, width) {
  if (channel === null || width <= 20) return channel;
  const half = width / 10 - 2; // distância, em nº de canal, do centro ao canal de 20 MHz da ponta
  if (band === '5') {
    const list = CENTERS_5[width] || [];
    return list.find((c) => Math.abs(channel - c) <= half && (channel - (c - half)) % 4 === 0) ?? null;
  }
  if (band === '6') {
    if (channel % 4 !== 1) return null;
    const span = width / 5; // nº de canais que o bloco cobre na numeração
    const center = 1 + Math.floor((channel - 1) / span) * span + half;
    return center + half <= 233 ? center : null;
  }
  return null;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const ouiBytes = (oui) => [(oui >> 16) & 0xff, (oui >> 8) & 0xff, oui & 0xff];

function macBytes(mac) {
  const b = toBytes(String(mac ?? '').replace(/[^0-9a-fA-F]/g, ''));
  return b && b.length === 6 ? [...b] : [2, 0, 0, 0, 0, 0];
}

/** Mapa de MCS (VHT/HE) com `nss` fluxos no código dado e o resto "não suportado". */
function mcsMapBytes(nss, code) {
  let map = 0;
  for (let i = 0; i < 8; i++) map |= (i < nss ? code : 3) << (2 * i);
  return le16(map);
}

function suiteList(names, table, oui, fallback) {
  const out = [];
  for (const name of Array.isArray(names) ? names : []) {
    const sel = suiteSelector(table, name, oui) || (oui === OUI_IEEE && table === AKM_NAMES ? suiteSelector(table, name, OUI_WFA) : null);
    if (sel) out.push(sel);
  }
  if (out.length === 0) out.push(suiteSelector(table, fallback, oui));
  return out;
}

const selectorBytes = ([oui, type]) => [...ouiBytes(oui), type];

/** Version + cifra de grupo + cifras + AKMs, comum ao RSN e ao WPA1. */
function rsnBody(spec, oui) {
  const ciphers = suiteList(spec.ciphers, CIPHER_NAMES, oui, 'CCMP');
  const akms = suiteList(spec.akms, AKM_NAMES, oui, 'PSK');
  const names = ciphers.map(([o, t]) => CIPHER_NAMES[o][t]);
  // a cifra de grupo é a mais fraca aceita, para os aparelhos antigos ouvirem o broadcast
  const groupName = typeof spec.groupCipher === 'string' ? spec.groupCipher : names.includes('TKIP') ? 'TKIP' : names[0];
  const group = suiteSelector(CIPHER_NAMES, groupName, oui) || ciphers[0];
  const out = [...le16(1), ...selectorBytes(group), ...le16(ciphers.length)];
  for (const c of ciphers) out.push(...selectorBytes(c));
  out.push(...le16(akms.length));
  for (const a of akms) out.push(...selectorBytes(a));
  return out;
}

function wpsAttr(type, bytes) {
  return [...be16(type), ...be16(bytes.length), ...bytes];
}

/**
 * Monta elementos de beacon realistas a partir de uma descrição simples: o inverso de
 * parseIes para um subconjunto prático. Usado pelo simulador e pelos testes.
 *
 * Com `frequency` os elementos de operação (DS, HT/VHT Operation, 6 GHz, EHT Operation)
 * também saem, com canal primário e centros corretos; sem ela só saem as capacidades.
 * Em 6 GHz os elementos HT e VHT não são emitidos (o padrão não os permite nessa faixa).
 *
 * @param {Object} spec
 * @param {number} [spec.frequency]   MHz do canal primário de 20 MHz
 * @param {number} [spec.widthMHz]    largura de operação (padrão: a maior que as capacidades permitem);
 *                                    a grafia antiga `widthMhz` continua aceita
 * @param {{legacy11b?:boolean}} [spec.rates]
 * @param {string|{code:string, environment?:('any'|'indoor'|'outdoor'), triplets?:{first:number,count:number,maxTxDbm:number}[]}} [spec.country]
 * @param {{stations:number, utilization:number, admissionCapacity?:number}} [spec.bssLoad]  utilization de 0 a 1
 * @param {number} [spec.txPowerDbm]  TPC Report
 * @param {{nss:number, width40?:boolean, secondary?:('above'|'below')}} [spec.ht]
 * @param {{nss:number, width160?:boolean, maxMcs?:(7|8|9), muBeamformer?:boolean}} [spec.vht]
 * @param {{nss:number, bssColor?:number, bssColorDisabled?:boolean, width160?:boolean, maxMcs?:(7|9|11),
 *          twt?:boolean, muBeamformer?:boolean}} [spec.he]
 * @param {{nss:number, width320?:boolean, muBeamformer?:boolean, mldMac?:string, linkId?:number,
 *          maxSimultaneousLinks?:number}} [spec.eht]  mldMac acrescenta o elemento Multi-Link
 * @param {{akms?:string[], ciphers?:string[], pmfCapable?:boolean, pmfRequired?:boolean, groupCipher?:string}} [spec.rsn]
 * @param {{akms?:string[], ciphers?:string[]}} [spec.wpa]   elemento WPA1 (para redes WPA/WPA2 mistas)
 * @param {{configured?:boolean, locked?:boolean, deviceName?:string, manufacturer?:string, model?:string,
 *          modelNumber?:string}} [spec.wps]
 * @param {{k?:boolean, v?:boolean, r?:boolean, mdid?:number}} [spec.roaming]
 * @param {boolean} [spec.ftmResponder]
 * @param {boolean|{uapsd?:boolean}} [spec.wmm]  padrão: presente sempre que houver HT/HE
 * @param {{opClass:number, channel:number, bssid:string, ssid?:string, shortSsid?:number, sameSsid?:boolean,
 *          colocated?:boolean}[]} [spec.rnr]    vizinhos do Reduced Neighbor Report
 * @param {string[]} [spec.vendorOuis]  OUIs extras ("00:10:18") para simular o elemento do fabricante do chip
 * @returns {RawIe[]}
 */
export function encodeIes(spec) {
  const out = [];
  try {
    encodeInto(spec && typeof spec === 'object' ? spec : {}, out);
  } catch {
    // descrição fora do formato: devolve o que já estava pronto
  }
  return out;
}

function encodeInto(s, out) {
  const add = (id, bytes, ext = 0) => out.push({ id, ext, hex: toHex(bytes) });
  const obj = (v) => (v && typeof v === 'object' ? v : null);

  const freq = Number.isFinite(s.frequency) ? s.frequency : null;
  const band = bandOfFrequency(freq) || (obj(s.vht) ? '5' : '2.4');
  const channel = freq === null ? null : channelOfFrequency(freq, band);
  const ht = band === '6' ? null : obj(s.ht);
  const vht = band === '5' ? obj(s.vht) : null;
  const he = obj(s.he);
  const eht = obj(s.eht);
  const roaming = obj(s.roaming) || {};
  const nssOf = (caps) => clampInt(caps.nss, 1, 8, 1);

  // Largura de operação: a pedida ou a maior anunciada, reduzida até caber num bloco de verdade.
  const wide160 = band !== '2.4' && !!((vht && vht.width160) || (he && he.width160));
  let width = 20;
  if (eht && eht.width320 && band === '6') width = 320;
  else if (wide160) width = 160;
  else if ((band === '5' && (vht || he)) || (band === '6' && he)) width = 80;
  else if (ht && ht.width40) width = 40;
  const asked = s.widthMHz !== undefined ? s.widthMHz : s.widthMhz;
  if ([20, 40, 80, 160, 320].includes(asked)) width = Math.min(width, asked);
  if (band === '2.4') width = channel === 14 ? 20 : Math.min(width, 40);
  else while (width > 20 && blockCenter(band, channel, width) === null) width /= 2;
  // 2,4 GHz: o canal secundário fica acima enquanto couber (até o 7), a não ser que peçam o contrário
  let above24 = channel !== null && channel <= 7;
  if (ht && ht.secondary === 'above' && channel !== null && channel <= 9) above24 = true;
  if (ht && ht.secondary === 'below' && channel !== null && channel >= 5) above24 = false;
  /** Canal central do bloco de `w` MHz em uso (0 = não se aplica). */
  const center = (w) => {
    if (channel === null || w > width) return 0;
    if (band === '2.4') return w === 40 ? channel + (above24 ? 2 : -2) : channel;
    return blockCenter(band, channel, w) ?? 0;
  };

  // --- taxas (1, 50), DS (3)
  const dsss = band === '2.4' && !!(obj(s.rates) && s.rates.legacy11b);
  if (dsss) {
    add(1, [0x82, 0x84, 0x8b, 0x96, 0x0c, 0x12, 0x18, 0x24]); // 1, 2, 5.5 e 11 básicas; 6, 9, 12, 18
  } else {
    add(1, [0x8c, 0x12, 0x98, 0x24, 0xb0, 0x48, 0x60, 0x6c]); // 6, 12 e 24 básicas; 9, 18, 36, 48, 54
  }
  if (band === '2.4' && channel !== null) add(3, [channel]);

  // --- país (7)
  const country = typeof s.country === 'string' ? { code: s.country } : obj(s.country);
  if (country && typeof country.code === 'string' && /^[A-Za-z0-9]{2}$/.test(country.code)) {
    const env = country.environment === 'indoor' ? 0x49 : country.environment === 'outdoor' ? 0x4f : 0x20;
    // Limites ilustrativos (o simulador não precisa do regulamento exato de cada país).
    const defaults = { '2.4': [[1, 13, 20]], 5: [[36, 4, 23], [52, 4, 23], [100, 12, 24], [149, 5, 30]], 6: [] }[band];
    const triplets = Array.isArray(country.triplets) ? country.triplets.map((t) => [t.first, t.count, t.maxTxDbm]) : defaults;
    const body = [...textBytes(country.code.toUpperCase()), env];
    for (const [first, count, dbm] of triplets) body.push(clampInt(first, 1, 200, 1), clampInt(count, 1, 255, 1), clampInt(dbm, -128, 127, 20) & 0xff);
    if (body.length % 2) body.push(0); // o elemento tem tamanho par
    add(7, body);
  }

  // --- BSS Load (11), TPC Report (35), ERP (42)
  const load = obj(s.bssLoad);
  if (load) {
    const utilization = clampInt((Number(load.utilization) || 0) * 255, 0, 255, 0);
    add(11, [...le16(clampInt(load.stations, 0, 0xffff, 0)), utilization, ...le16(clampInt(load.admissionCapacity, 0, 0xffff, 0))]);
  }
  if (Number.isFinite(s.txPowerDbm)) add(35, [clampInt(s.txPowerDbm, -128, 127, 0) & 0xff, 0]);
  if (band === '2.4') add(42, [0x00]);

  // --- HT Capabilities (45)
  if (ht) {
    const nss = Math.min(4, nssOf(ht));
    const w40 = !!ht.width40;
    // LDPC, SM power save desligado, SGI 20, Rx STBC 1 fluxo, A-MSDU 7935 (+ 40 MHz, SGI 40, Tx STBC)
    const cap = 0x092d | (w40 ? 0x0042 : 0) | (nss > 1 ? 0x0080 : 0);
    const mcs = new Array(16).fill(0);
    for (let i = 0; i < nss; i++) mcs[i] = 0xff;
    mcs[12] = 0x01; // Tx MCS Set Defined
    add(45, [...le16(cap), 0x17, ...mcs, 0, 0, 0, 0, 0, 0, 0]);
  }

  // --- RSN (48)
  const rsn = obj(s.rsn);
  if (rsn) {
    const required = !!rsn.pmfRequired;
    const capable = required || !!rsn.pmfCapable;
    const body = [...rsnBody(rsn, OUI_IEEE), ...le16((required ? 0x0040 : 0) | (capable ? 0x0080 : 0))];
    // com PMF: nenhum PMKID e a cifra de gerenciamento de grupo (BIP-CMAC-128)
    if (capable) body.push(0, 0, ...ouiBytes(OUI_IEEE), 6);
    add(48, body);
  }

  // --- taxas estendidas (50), domínio de mobilidade (54)
  if (dsss) add(50, [0x30, 0x48, 0x60, 0x6c]); // 24, 36, 48, 54
  if (roaming.r) add(54, [...le16(clampInt(roaming.mdid, 0, 0xffff, 0xa1b2)), 0x01]);

  // --- HT Operation (61)
  if (ht && channel !== null) {
    let offset = 0;
    if (width >= 40) {
      if (band === '2.4') offset = above24 ? 1 : 3;
      else offset = channel < center(40) ? 1 : 3;
    }
    add(61, [channel, offset | (offset ? 0x04 : 0), 0, 0, 0, 0, ...new Array(16).fill(0)]);
  }

  // --- RM Enabled Capabilities (70): link measurement, neighbor report, beacon passivo/ativo/tabela
  if (roaming.k) add(70, [0x73, 0, 0, 0, 0]);

  // --- Extended Capabilities (127)
  if (ht || vht || he || roaming.v || s.ftmResponder) {
    const caps = new Array(10).fill(0);
    const on = (n) => {
      caps[n >> 3] |= 1 << (n & 7);
    };
    on(EXT_CAP_BITS.extChannelSwitching);
    if (roaming.v) on(EXT_CAP_BITS.bssTransition);
    if (vht) on(EXT_CAP_BITS.opModeNotification);
    if (s.ftmResponder) on(EXT_CAP_BITS.ftmResponder);
    if (he && he.twt !== false) on(EXT_CAP_BITS.twtResponder);
    add(127, caps);
  }

  // --- VHT Capabilities (191) e VHT Operation (192)
  if (vht) {
    const nss = nssOf(vht);
    const mu = vht.muBeamformer ?? nss >= 2;
    // MPDU de 11454, LDPC, SGI 80, Tx STBC, Rx STBC 1, beamformer/beamformee SU, 4 antenas de
    // beamformee (campo = 3), A-MPDU máximo (expoente 7)
    let cap = 0x02 | 0x10 | 0x20 | 0x80 | 0x100 | 0x800 | 0x1000 | 0x6000 | 0x3800000;
    if (vht.width160) cap |= 0x04 | 0x40;
    cap |= (nss - 1) << 16; // dimensões de sondagem
    if (mu) cap |= 0x80000;
    const map = mcsMapBytes(nss, vht.maxMcs === 7 ? 0 : vht.maxMcs === 8 ? 1 : 2);
    add(191, [...le32(cap >>> 0), ...map, 0, 0, ...map, 0, 0]);
    if (channel !== null) {
      // forma atual: 1 = 80 MHz ou mais; o segundo centro só aparece nos 160 MHz
      const wide = width >= 80;
      add(192, [wide ? 1 : 0, wide ? center(80) : 0, width >= 160 ? center(160) : 0, 0xfc, 0xff]);
    }
  }

  // --- Reduced Neighbor Report (201)
  for (const n of Array.isArray(s.rnr) ? s.rnr : []) {
    if (!obj(n)) continue;
    const short = Number.isFinite(n.shortSsid) ? n.shortSsid >>> 0 : typeof n.ssid === 'string' ? shortSsid(n.ssid) : null;
    const params = (n.sameSsid ? 0x02 : 0) | (n.colocated === false ? 0 : 0x40);
    // um vizinho por bloco: deslocamento do TBTT desconhecido (255), BSSID, [short SSID], parâmetros, [PSD sem limite]
    const tbtt = short === null ? [255, ...macBytes(n.bssid), params] : [255, ...macBytes(n.bssid), ...le32(short), params, 127];
    add(201, [0x00, tbtt.length, clampInt(n.opClass, 0, 255, 0), clampInt(n.channel, 0, 255, 0), ...tbtt]);
  }

  // --- HE Capabilities (255/35) e HE Operation (255/36)
  if (he) {
    const nss = nssOf(he);
    const mac = [0x01 | (he.twt === false ? 0 : 0x04), 0, 0, 0, 0, 0]; // +HTC-HE, TWT responder
    const phy = new Array(11).fill(0);
    if (band === '2.4') phy[0] = ht && ht.width40 ? 0x02 : 0;
    else phy[0] = 0x04 | (wide160 ? 0x08 : 0);
    phy[1] = 0x20; // LDPC
    phy[3] = 0x80; // SU beamformer
    phy[4] = 0x01 | ((he.muBeamformer ?? nss >= 2) ? 0x02 : 0); // SU beamformee, MU beamformer
    const map = mcsMapBytes(nss, he.maxMcs === 7 ? 0 : he.maxMcs === 9 ? 1 : 2);
    const mcs = [...map, ...map];
    if (phy[0] & 0x08) mcs.push(...map, ...map);
    add(255, [...mac, ...phy, ...mcs], 35);

    // PE padrão 4, limiar de RTS por TXOP desligado (1023); cor do BSS; MCS básico: 1 fluxo, MCS 0-7
    const sixGhz = band === '6' && channel !== null;
    const params = 0x3ff4 | (sixGhz ? 0x20000 : 0);
    const color = clampInt(he.bssColor, 0, 63, 0) | (he.bssColorDisabled ? 0x80 : 0);
    const body = [params & 0xff, (params >> 8) & 0xff, (params >> 16) & 0xff, color, 0xfc, 0xff];
    if (sixGhz) {
      // HE só vai até 160 MHz: num canal de 320 anuncia o bloco de 160 que contém o primário
      const w = Math.min(width, 160);
      const code = { 20: 0, 40: 1, 80: 2, 160: 3 }[w];
      body.push(channel, code, w === 160 ? center(80) : center(w), w === 160 ? center(160) : 0, 6);
    }
    add(255, body, 36);
  }

  // --- EHT Operation (255/106), Multi-Link (255/107), EHT Capabilities (255/108)
  if (eht) {
    const nss = nssOf(eht);
    if (channel !== null) {
      // centro 0 = bloco inteiro até 80 MHz; nos 160/320 é a metade que contém o primário
      const code = { 20: 0, 40: 1, 80: 2, 160: 3, 320: 4 }[width];
      const seg0 = width >= 160 ? center(width / 2) : center(width);
      add(255, [0x01, 0x11, 0, 0, 0, code, seg0, width >= 160 ? center(width) : 0], 106);
    } else {
      add(255, [0x00, 0x11, 0, 0, 0], 106);
    }
    if (typeof eht.mldMac === 'string') {
      // Basic, com Link ID, contador de mudanças e capacidades do MLD
      const links = clampInt(eht.maxSimultaneousLinks, 1, 16, 2);
      add(255, [...le16(0x0130), 11, ...macBytes(eht.mldMac), clampInt(eht.linkId, 0, 15, 0), 0, ...le16(links - 1)], 107);
    }
    const phy = new Array(9).fill(0);
    const w320 = !!eht.width320 && band === '6';
    phy[0] = (w320 ? 0x02 : 0) | 0x20 | 0x40; // 320 MHz, beamformer e beamformee SU
    if (eht.muBeamformer ?? nss >= 2) phy[7] = 0x10 | (wide160 ? 0x20 : 0) | (w320 ? 0x40 : 0); // MU beamformer por largura
    const block = [(nss << 4) | nss, (nss << 4) | nss, (nss << 4) | nss]; // MCS 0-9, 10-11, 12-13
    const mcs = [...block];
    if (wide160) mcs.push(...block);
    if (w320) mcs.push(...block);
    add(255, [0, 0, ...phy, ...mcs], 108);
  }

  // --- elementos de fabricante (221): WPA1, WMM, WPS e os do chip
  const wpa = obj(s.wpa);
  if (wpa) add(221, [...ouiBytes(OUI_MS), 1, ...rsnBody(wpa, OUI_MS)]);
  const wmm = s.wmm === undefined ? !!(ht || he) : s.wmm;
  if (wmm) {
    const qos = 0x01 | (obj(wmm) && wmm.uapsd ? 0x80 : 0);
    // parâmetros EDCA padrão do WMM: BE, BK, VI, VO
    add(221, [...ouiBytes(OUI_MS), 2, 1, 1, qos, 0, 0x03, 0xa4, 0, 0, 0x27, 0xa4, 0, 0, 0x42, 0x43, 0x5e, 0, 0x62, 0x32, 0x2f, 0]);
  }
  const wps = obj(s.wps);
  if (wps) {
    const body = [...ouiBytes(OUI_MS), 4, ...wpsAttr(0x104a, [0x10]), ...wpsAttr(0x1044, [wps.configured === false ? 1 : 2])];
    if (wps.locked) body.push(...wpsAttr(0x1057, [1]));
    const text = (type, value) => {
      if (typeof value === 'string' && value) body.push(...wpsAttr(type, textBytes(value).slice(0, 64)));
    };
    text(0x1021, wps.manufacturer);
    text(0x1023, wps.model);
    text(0x1024, wps.modelNumber);
    text(0x1011, wps.deviceName);
    body.push(...wpsAttr(0x1008, be16(0x0680))); // botão físico e virtual
    body.push(...wpsAttr(0x1049, [0x00, 0x37, 0x2a, 0x00, 0x01, 0x20])); // Version2 = 2.0
    add(221, body);
  }
  for (const oui of Array.isArray(s.vendorOuis) ? s.vendorOuis : []) {
    const b = toBytes(String(oui).replace(/[^0-9a-fA-F]/g, ''));
    if (b && b.length === 3) add(221, [...b, 0x02, 0x00, 0x00]);
  }
}
