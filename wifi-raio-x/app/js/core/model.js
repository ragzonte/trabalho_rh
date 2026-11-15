// Modelo de dados normalizado: transforma o que o Android entrega (ScanAp, veja bridge.js) no
// objeto `Ap` que o resto do app usa, agrupa BSSIDs por aparelho físico e por rede, e guarda
// o histórico de cada BSSID entre uma varredura e outra.
//
// Nada aqui lança exceção: dado torto vindo do celular vira null / "desconhecido".

import { occupancy, channelToFreq, BANDS } from './channels.js';
import { qualityPct, signalLevel, indoorDistance } from './signal.js';
import { WIFI_STANDARD, standardInfo, inferGen } from './phy.js';
import { parseCapabilities, refineWithIes } from './security.js';
import { parseIes, summarizeIes } from './ies.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object';

/** Nome mostrado no lugar do SSID de uma rede oculta. */
export const HIDDEN_NAME = '(rede oculta)';

/** Leitura mais velha que isto (ms) não é desta varredura: o Android repetiu um resultado antigo. */
export const STALE_MS = 10_000;

// ---------------------------------------------------------------------------
// Endereços MAC e nomes de rede
// ---------------------------------------------------------------------------

/**
 * BSSID no formato "aa:bb:cc:dd:ee:ff" (aceita maiúsculas e "-" como separador).
 * Qualquer outra coisa vira ''.
 * @param {*} bssid
 * @returns {string}
 */
export function normalizeBssid(bssid) {
  if (typeof bssid !== 'string') return '';
  const s = bssid.trim().toLowerCase().replace(/-/g, ':');
  return /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s) ? s : '';
}

/**
 * Os seis octetos de um MAC, ou null se o texto não for um MAC.
 * @param {string} bssid
 * @returns {number[]|null}
 */
export function parseMac(bssid) {
  const s = normalizeBssid(bssid);
  return s ? s.split(':').map((h) => parseInt(h, 16)) : null;
}

/** Rede oculta: nome vazio, só bytes nulos (roteadores que "apagam" o nome assim) ou o marcador do Android. */
function isHiddenSsid(ssid) {
  return ssid === '' || ssid === '<unknown ssid>' || /^\u0000+$/.test(ssid);
}

// Marcas de faixa que os roteadores põem no nome: "_5G", "-5GHz", " 2.4G", "CLARO_2G…", "NET_5G…".
const BAND_MARK_END = /(?<![0-9])[\s_.\-]*(?:2[.,]4|24|2|5[.,]8|5|6)\s?g(?:hz)?(?:[\s_.\-]?[1-3])?\s*$/i;
const BAND_MARK_ANY = /(?<![0-9a-z])(?:2[.,]4|24|2|5[.,]8|5|6)\s?g(?:hz)?/gi;
const BAND_MARK_BARE = /(?<![0-9])[\s_.\-]*2[.,]4\s*$/;

/**
 * "Raiz" do nome de uma rede, sem a marca de faixa e sem pontuação, para reconhecer o par
 * "Casa" / "Casa_5G" ou "CLARO_2G1A2B3C" / "CLARO_5G1A2B3C". null quando não sobra nada útil.
 * @param {string} ssid
 * @returns {string|null}
 */
export function ssidStem(ssid) {
  if (typeof ssid !== 'string' || isHiddenSsid(ssid)) return null;
  const stem = ssid
    .toLowerCase()
    .replace(BAND_MARK_END, '')
    .replace(BAND_MARK_BARE, '')
    .replace(BAND_MARK_ANY, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  return stem.length >= 2 ? stem : null;
}

// ---------------------------------------------------------------------------
// normalizeAp
// ---------------------------------------------------------------------------

/**
 * Tudo o que a interface precisa saber de um BSSID, calculado uma vez só.
 * @typedef {Object} Ap
 * @property {string} id            o BSSID ('' quando o celular mandou um endereço inválido)
 * @property {string} bssid
 * @property {string} ssid          '' quando oculta
 * @property {boolean} hidden
 * @property {string} name          o SSID, ou "(rede oculta)"
 * @property {number|null} rssi     dBm
 * @property {number} quality       0..100
 * @property {{key:string, label:string, bars:number, tone:string, hint:string}} level  signalLevel(rssi)
 * @property {number|null} freq     centro do canal primário (MHz)
 * @property {'2.4'|'5'|'6'|'60'|null} band
 * @property {number|null} channel  canal primário
 * @property {object} occ           occupancy(): trecho do espectro ocupado
 * @property {number} widthMHz
 * @property {object} security      parseCapabilities(), refinado com os elementos do beacon quando existem
 * @property {object|null} ie       summarizeIes(), ou null quando o celular não entrega os elementos
 * @property {number|null} gen      geração do Wi-Fi (4, 5, 6, 7; 2/3 = antigo)
 * @property {string} standard      "Wi-Fi 6", "Wi-Fi 6E", "Wi-Fi 7"...
 * @property {string} standardLabel "Wi-Fi 6 (802.11ax)"; quando presumido: "Wi-Fi 5 ou mais novo (estimado)"
 * @property {string|null} ieee     "802.11ax"
 * @property {string|null} phy      'legacy' | 'ht' | 'vht' | 'he' | 'eht' | 'dmg'
 * @property {'android'|'ies'|'inferred'|null} genSource  de onde veio a geração
 * @property {number|null} nss      fluxos espaciais do AP
 * @property {number|null} stations aparelhos conectados (BSS Load)
 * @property {number|null} utilization  ocupação do canal medida pelo AP, 0..1
 * @property {number|null} distanceM    distância estimada (indoorDistance)
 * @property {number|null} ageMs    há quanto tempo o BSSID foi ouvido
 * @property {boolean} stale        ageMs > 10 s: não foi ouvido na última varredura
 * @property {number|null} seenAt   quando foi ouvido (ms desde 1970); null sem `ts`/`now`
 * @property {boolean} randomizedMac  MAC "administrado localmente": rede virtual (convidados, mesh)
 *                                    ou roteador de celular com endereço sorteado
 * @property {boolean} rttResponder
 * @property {string|null} mld      MAC do AP MLD (Wi-Fi 7)
 * @property {string|null} fingerprint  "impressão digital" do modelo (WPS / elementos de fabricante)
 * @property {object} raw           o ScanAp original
 */

// Geração -> WIFI_STANDARD_* (a geração 7 é o inteiro 8 no Android).
const STANDARD_OF_GEN = { 4: WIFI_STANDARD.N, 5: WIFI_STANDARD.AC, 6: WIFI_STANDARD.AX, 7: WIFI_STANDARD.BE };
const KNOWN_STANDARDS = new Set(Object.values(WIFI_STANDARD));

function describeStandard(wifiStandard, occ, ie) {
  const band = occ.band;
  const code = typeof wifiStandard === 'string' && wifiStandard.trim() !== '' ? Number(wifiStandard) : wifiStandard;
  let std = KNOWN_STANDARDS.has(code) && code !== WIFI_STANDARD.UNKNOWN ? code : null;
  let source = std === null ? null : 'android';

  // O Android anterior ao 13 não conhece o 11be e chama um roteador Wi-Fi 7 de "11ax": se os
  // elementos do beacon anunciam uma geração mais nova, valem eles.
  const ieGen = ie && isNum(ie.gen) ? ie.gen : null;
  if (ieGen !== null && STANDARD_OF_GEN[ieGen] !== undefined && std !== WIFI_STANDARD.AD) {
    const current = std === null ? 0 : (standardInfo(std, band).gen ?? 0);
    if (ieGen > current) {
      std = STANDARD_OF_GEN[ieGen];
      source = 'ies';
    }
  }
  if (std === null && band !== null) {
    // Sem informação: o mínimo que explica a faixa e a largura vistas
    std = band === '60' ? WIFI_STANDARD.AD : STANDARD_OF_GEN[inferGen({ band, widthMHz: occ.widthMHz })];
    source = 'inferred';
  }

  const info = standardInfo(std ?? WIFI_STANDARD.UNKNOWN, band);
  let label = info.label;
  if (source === 'inferred' && info.gen !== null) {
    label = info.gen < 7 ? `${info.short} ou mais novo (estimado)` : `${info.short} (estimado)`;
  }
  return { gen: info.gen, standard: info.short, standardLabel: label, ieee: info.ieee, phy: info.phy, genSource: source };
}

/**
 * O Android anterior ao 13 não tem CHANNEL_WIDTH_320MHZ: um AP Wi-Fi 7 em 320 MHz chega como
 * 160 MHz. O elemento EHT Operation diz a largura de verdade e o centro do canal.
 */
function widenWithIes(raw, occ, ieInfo) {
  const eht = ieInfo.ehtOperation;
  if (occ.band !== '6' || occ.widthMHz >= 320 || !isObj(eht) || eht.width !== 320) return occ;
  const center = channelToFreq(eht.centerSeg1, '6');
  if (center === null) return occ;
  const wide = occupancy({ frequency: raw.frequency, channelWidth: 5, centerFreq0: center, centerFreq1: 0 });
  return wide.widthMHz === 320 && !wide.approx ? wide : occ;
}

// Elementos de fabricante que todo roteador traz (Microsoft: WPA/WMM/WPS; Wi-Fi Alliance).
const GENERIC_OUIS = new Set(['00:50:f2', '50:6f:9a']);

/** Dois rádios da mesma caixa costumam anunciar o mesmo modelo (WPS) ou os mesmos fabricantes de chip. */
function fingerprintOf(ieInfo) {
  const wps = isObj(ieInfo.wps) ? ieInfo.wps : null;
  if (wps && (wps.manufacturer || wps.modelName || wps.modelNumber)) {
    return `wps:${wps.manufacturer || ''}|${wps.modelName || ''}|${wps.modelNumber || ''}`;
  }
  const ouis = (Array.isArray(ieInfo.vendorOuis) ? ieInfo.vendorOuis : []).filter((o) => !GENERIC_OUIS.has(o)).sort();
  return ouis.length ? `oui:${ouis.join(',')}` : null;
}

/**
 * Normaliza um ScanAp.
 *
 * Tempo: `ageMs` do ScanAp vale para o instante em que a lista foi lida (`options.ts`, o
 * ScanEvent.ts). Informando também `options.now`, a idade é corrigida para esse instante
 * (útil ao redesenhar a tela segundos depois da varredura). Só com `now`, ele faz o papel de `ts`.
 *
 * @param {import('../bridge.js').ScanAp} raw
 * @param {{now?: number, ts?: number, sdk?: number}} [options]  `sdk` = DeviceInfo.sdk (afina o PMF)
 * @returns {Ap}
 */
export function normalizeAp(raw, options) {
  const r = isObj(raw) ? raw : {};
  const o = isObj(options) ? options : {};

  const bssid = normalizeBssid(r.bssid);
  const mac = parseMac(bssid);
  const ssid = typeof r.ssid === 'string' ? r.ssid : '';
  const hidden = isHiddenSsid(ssid);
  const rssi = isNum(r.level) ? r.level : null;

  const ieInfo = Array.isArray(r.ies) ? parseIes(r.ies) : null;
  const hasIes = ieInfo !== null && ieInfo.count > 0;
  const ie = hasIes ? summarizeIes(ieInfo) : null;

  let occ = occupancy(r);
  if (hasIes) occ = widenWithIes(r, occ, ieInfo);

  let security = parseCapabilities(r.capabilities, { sdk: o.sdk });
  if (hasIes) security = refineWithIes(security, ieInfo);

  const rawAge = isNum(r.ageMs) ? Math.max(0, r.ageMs) : null;
  const ts = isNum(o.ts) ? o.ts : isNum(o.now) ? o.now : null;
  const now = isNum(o.now) ? o.now : ts;
  const seenAt = ts !== null && rawAge !== null ? ts - rawAge : null;
  const ageMs = seenAt !== null ? Math.max(0, now - seenAt) : rawAge;

  return {
    id: bssid,
    bssid,
    ssid: hidden ? '' : ssid,
    hidden,
    name: hidden ? HIDDEN_NAME : ssid,
    rssi,
    quality: qualityPct(rssi),
    level: signalLevel(rssi),
    freq: occ.freq,
    band: occ.band,
    channel: occ.channel,
    occ,
    widthMHz: occ.widthMHz,
    security,
    ie,
    ...describeStandard(r.wifiStandard, occ, ie),
    nss: ie && isNum(ie.nss) ? ie.nss : null,
    stations: ie && isNum(ie.stations) ? ie.stations : null,
    utilization: ie && isNum(ie.utilization) ? ie.utilization : null,
    distanceM: indoorDistance(rssi, occ.freq),
    ageMs,
    stale: ageMs !== null && ageMs > STALE_MS,
    seenAt,
    randomizedMac: mac !== null && (mac[0] & 0x02) !== 0,
    rttResponder: r.rttResponder === true || (ie !== null && ie.ftmResponder === true),
    mld: normalizeBssid(r.mld) || (ie && normalizeBssid(ie.mldMac)) || null,
    fingerprint: hasIes ? fingerprintOf(ieInfo) : null,
    raw: r,
  };
}

/** Já é um Ap normalizado? */
function isAp(x) {
  return isObj(x) && typeof x.id === 'string' && isObj(x.occ) && Array.isArray(x.occ.segments) && 'rssi' in x;
}

/**
 * Devolve um Ap: o próprio objeto, se já estiver normalizado, ou normalizeAp(x). Para as funções
 * de análise aceitarem tanto a lista do ApTracker quanto um ScanEvent.aps cru.
 * @param {*} x
 * @returns {Ap}
 */
export function asAp(x) {
  return isAp(x) ? x : normalizeAp(x);
}

/**
 * Normaliza um ScanEvent inteiro: um Ap por BSSID válido (repetidos: fica a leitura mais nova).
 * @param {import('../bridge.js').ScanEvent} event
 * @param {{now?: number, sdk?: number}} [options]
 * @returns {Ap[]}
 */
export function normalizeScan(event, options) {
  const ev = isObj(event) ? event : {};
  const o = isObj(options) ? options : {};
  const byId = new Map();
  for (const raw of Array.isArray(ev.aps) ? ev.aps : []) {
    if (!isObj(raw)) continue;
    const ap = normalizeAp(raw, { ts: ev.ts, now: o.now, sdk: o.sdk });
    if (!ap.id) continue;
    const prev = byId.get(ap.id);
    if (!prev || (ap.ageMs ?? Infinity) < (prev.ageMs ?? Infinity)) byId.set(ap.id, ap);
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// groupByDevice: que BSSIDs são rádios / redes virtuais da MESMA caixa
// ---------------------------------------------------------------------------
//
// Um roteador anuncia vários BSSIDs: um por faixa (2,4 / 5 / 6 GHz) e, em cada rádio, um por
// rede (principal, convidados, a rede pública da operadora...). Os endereços saem de um bloco
// reservado na fábrica, então são quase iguais. Só que o vizinho com o roteador do mesmo lote
// da operadora TAMBÉM tem endereços quase iguais. Por isso a regra é conservadora, em três níveis:
//
// 1. Certeza (junta sempre):
//    - o mesmo endereço de AP MLD (Wi-Fi 7), ou o MLD de um é o BSSID do outro;
//    - o Reduced Neighbor Report de um aponta o outro como "no mesmo aparelho";
//    - endereços idênticos fora o primeiro octeto (redes virtuais ligam o bit "administrado
//      localmente" e mexem em mais alguns bits dele; os outros cinco octetos não coincidem por acaso).
//
// 2. Endereços próximos (últimos três octetos a até 32 de distância, ou um octeto do meio
//    diferente por pouco, como nos UniFi) MAIS um segundo indício:
//    - forte: na mesma frequência, sinais praticamente iguais e endereços a até 3 de distância
//      (duas redes do mesmo rádio); ou, entre faixas, a mesma raiz de nome ("Casa" / "Casa_5G");
//    - fraco: entre faixas, distância de até 2 sem mais nada, ou até 16 com a mesma "impressão
//      digital" de fábrica (modelo no WPS / elementos de fabricante).
//
// 3. Vetos (valem para o grupo inteiro; só a certeza passa por cima):
//    - mesma faixa em frequências diferentes: um rádio só fala num canal (exceção: roteador
//      tri-band com um rádio na parte baixa e outro na parte alta dos 5 GHz);
//    - mesma frequência com sinais diferentes, ou com o MESMO nome de rede: são dois rádios, logo
//      duas caixas (nós de um mesh, por exemplo);
//    - nomes "irmãos" de fábrica, iguais fora o final ("VIVOFIBRA-8A20" / "VIVOFIBRA-8A28",
//      "AP 302" / "AP 304"): cada caixa tem o seu.
//
// Quando há mais de um jeito de formar os pares (lote da operadora: 2,4 GHz do vizinho tão perto
// do meu 5 GHz quanto o meu 2,4), vale a explicação mais econômica (menos caixas; no empate, a
// menor soma de distâncias) e só se ela for única. Empatou, ninguém é juntado.

const MAX_STEP = 32; // maior distância entre endereços da mesma caixa (APs corporativos: 16 redes por rádio)
const VAP_STEP = 3; // redes do mesmo rádio são numeradas em sequência
const TINY_STEP = 2; // "colado": aceita sem segundo indício, se não houver disputa
const FINGERPRINT_STEP = 16;
const OCTET_STEP = 4;
const SAME_RADIO_DB = 4; // beacons do mesmo rádio chegam com o mesmo sinal, fora o ruído da medida
const SAME_RADIO_STALE_DB = 8; // ...mas leituras de momentos diferentes variam mais
const SAME_SCAN_MS = 2500;
const MAX_SEARCH_LINKS = 14; // disputas maiores que isto ficam sem resolver (2^14 combinações)

const STRONG = 2;
const WEAK = 1;

/** Distância entre dois MACs para fins de "mesma caixa"; null = sem parentesco. */
function macDistance(a, b) {
  if (a[1] !== b[1] || a[2] !== b[2]) return null;
  const variant = a[0] !== b[0];
  const low = (m) => (m[3] << 16) | (m[4] << 8) | m[5];
  const d = Math.abs(low(a) - low(b));
  if (d === 0) return { kind: variant ? 'base' : 'same', d: 0, variant };
  if (d <= MAX_STEP) return { kind: 'step', d, variant };
  if (a[5] === b[5] && (a[3] === b[3]) !== (a[4] === b[4])) {
    const i = a[3] === b[3] ? 4 : 3;
    const od = Math.abs(a[i] - b[i]);
    if (od <= OCTET_STEP) return { kind: 'octet', d: od, variant };
  }
  return null;
}

/** Nomes de fábrica "irmãos": mesma forma, só o final (em hexadecimal) muda. */
function siblingNames(a, b) {
  const s = a.stem;
  const t = b.stem;
  if (s === null || t === null || s === t || s.length !== t.length) return false;
  let i = 0;
  while (s[i] === t[i]) i += 1;
  return i >= 3 && /^[0-9a-f]+$/.test(s.slice(i)) && /^[0-9a-f]+$/.test(t.slice(i));
}

/** Mesma frequência, mesma largura e praticamente o mesmo sinal: cara de duas redes do mesmo rádio. */
function sameRadioLook(a, b) {
  if (a.rssi === null || b.rssi === null || a.width !== b.width) return false;
  const together = a.age === null || b.age === null || Math.abs(a.age - b.age) <= SAME_SCAN_MS;
  return Math.abs(a.rssi - b.rssi) <= (together ? SAME_RADIO_DB : SAME_RADIO_STALE_DB);
}

function vetoes(a, b) {
  if (a.band !== null && a.band === b.band && a.freq !== null && b.freq !== null) {
    if (a.freq === b.freq) {
      if (a.ssid !== null && a.ssid === b.ssid) return true;
      if (!sameRadioLook(a, b)) return true;
    } else {
      const split = a.band === '5' && Math.min(a.freq, b.freq) < 5470 && Math.max(a.freq, b.freq) >= 5470;
      if (!split) return true;
    }
  }
  return siblingNames(a, b);
}

/** Força do segundo indício para um par de endereços próximos (0 = nenhum). */
function hintTier(a, b, dist) {
  const sameBand = a.band !== null && a.band === b.band;
  if (sameBand && a.freq === b.freq) return dist.kind === 'step' && dist.d <= VAP_STEP ? STRONG : 0;
  if (a.ssid !== null && b.ssid !== null && (a.ssid === b.ssid || (a.stem !== null && a.stem === b.stem))) return STRONG;
  if (sameBand || dist.kind !== 'step') return 0;
  if (!dist.variant && dist.d <= TINY_STEP) return WEAK;
  if (dist.d <= FINGERPRINT_STEP && a.fingerprint !== null && a.fingerprint === b.fingerprint) return WEAK;
  return 0;
}

function deviceNode(ap, index) {
  const mac = parseMac(ap.bssid);
  const colocated = [];
  if (isObj(ap.ie) && Array.isArray(ap.ie.colocated)) {
    for (const c of ap.ie.colocated) if (isObj(c) && normalizeBssid(c.bssid)) colocated.push(normalizeBssid(c.bssid));
  }
  const ssid = typeof ap.ssid === 'string' && ap.ssid !== '' && ap.hidden !== true ? ap.ssid : null;
  return {
    ap,
    key: mac ? normalizeBssid(ap.bssid) : `?${String(index).padStart(6, '0')}`,
    mac,
    band: typeof ap.band === 'string' ? ap.band : null,
    freq: isNum(ap.freq) ? ap.freq : null,
    width: isNum(ap.widthMHz) ? ap.widthMHz : null,
    rssi: isNum(ap.rssi) ? ap.rssi : null,
    age: isNum(ap.ageMs) ? ap.ageMs : null,
    ssid,
    stem: ssid === null ? null : ssidStem(ssid),
    fingerprint: typeof ap.fingerprint === 'string' ? ap.fingerprint : null,
    mld: normalizeBssid(ap.mld) || null,
    colocated,
  };
}

const bandRank = (band) => {
  const i = BANDS.indexOf(band);
  return i < 0 ? BANDS.length : i;
};

/**
 * Agrupa os BSSIDs que são rádios ou redes virtuais do mesmo aparelho físico (a heurística está
 * descrita no comentário acima). O resultado não depende da ordem da lista.
 * @param {Ap[]} aps
 * @returns {{id:string, bssids:string[], aps:Ap[], ssids:string[], bands:string[], bestRssi:number|null}[]}
 *          do sinal mais forte para o mais fraco; `id` = endereço do AP MLD, ou o menor BSSID "de fábrica"
 */
export function groupByDevice(aps) {
  const nodes = [];
  for (const item of Array.isArray(aps) ? aps : []) {
    if (isObj(item)) nodes.push(deviceNode(asAp(item), nodes.length));
  }
  nodes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const n = nodes.length;

  // União de conjuntos; a raiz é sempre o menor índice, para o resultado ser determinístico
  const parent = nodes.map((_, i) => i);
  const members = nodes.map((_, i) => [i]);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i];
    return i;
  };
  const union = (i, j) => {
    const a = find(i);
    const b = find(j);
    if (a === b) return;
    const [root, child] = a < b ? [a, b] : [b, a];
    parent[child] = root;
    members[root] = members[root].concat(members[child]);
    members[child] = [];
  };
  const clusterVeto = (x, y) => members[x].some((i) => members[y].some((j) => vetoes(nodes[i], nodes[j])));

  // --- 1. certeza
  const byBssid = new Map();
  const byMld = new Map();
  nodes.forEach((node, i) => {
    if (!node.mac) return;
    if (byBssid.has(node.key)) union(byBssid.get(node.key), i);
    else byBssid.set(node.key, i);
  });
  nodes.forEach((node, i) => {
    if (node.mld) {
      if (byMld.has(node.mld)) union(byMld.get(node.mld), i);
      else byMld.set(node.mld, i);
      if (byBssid.has(node.mld)) union(byBssid.get(node.mld), i);
    }
    for (const other of node.colocated) if (byBssid.has(other)) union(byBssid.get(other), i);
  });

  const strong = [];
  const weak = [];
  for (let i = 0; i < n; i++) {
    if (!nodes[i].mac) continue;
    for (let j = i + 1; j < n; j++) {
      if (!nodes[j].mac) continue;
      const dist = macDistance(nodes[i].mac, nodes[j].mac);
      if (dist === null) continue;
      if (dist.kind === 'base' || dist.kind === 'same') {
        union(i, j);
        continue;
      }
      if (vetoes(nodes[i], nodes[j])) continue;
      const tier = hintTier(nodes[i], nodes[j], dist);
      if (tier === STRONG) strong.push({ i, j, d: dist.d });
      else if (tier === WEAK) weak.push({ i, j, d: dist.d });
    }
  }

  // --- 2 e 3. endereços próximos, respeitando os vetos
  /** Elos entre grupos ainda separados e compatíveis (o mais curto de cada par de grupos). */
  const linksOf = (pairs) => {
    const links = new Map();
    for (const p of pairs) {
      const x = find(p.i);
      const y = find(p.j);
      if (x === y) continue;
      const key = x < y ? `${x}|${y}` : `${y}|${x}`;
      const known = links.get(key);
      if (known) known.d = Math.min(known.d, p.d);
      else if (!clusterVeto(x, y)) links.set(key, { x: Math.min(x, y), y: Math.max(x, y), d: p.d });
    }
    return [...links.values()].sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
  };

  /** Disputa: os grupos de uma mesma ilha de elos, resolvidos pela explicação mais econômica. */
  const solve = (links) => {
    if (links.length > MAX_SEARCH_LINKS) return;
    const ids = [...new Set(links.flatMap((l) => [l.x, l.y]))].sort((a, b) => a - b);
    const k = ids.length;
    const at = new Map(ids.map((id, i) => [id, i]));
    const edges = links.map((l) => [at.get(l.x), at.get(l.y), l.d]);
    const veto = ids.map((x) => ids.map((y) => x !== y && clusterVeto(x, y)));
    let best = null;
    let tie = false;
    const local = new Array(k);
    const root = (i) => {
      while (local[i] !== i) i = local[i];
      return i;
    };
    for (let mask = 1; mask < 1 << edges.length; mask++) {
      for (let i = 0; i < k; i++) local[i] = i;
      let ok = true;
      let cost = 0;
      let merges = 0;
      for (let e = 0; e < edges.length && ok; e++) {
        if (!(mask & (1 << e))) continue;
        const a = root(edges[e][0]);
        const b = root(edges[e][1]);
        if (a === b) ok = false; // ciclo: a mesma partição aparece em outra combinação
        else {
          local[Math.max(a, b)] = Math.min(a, b);
          cost += edges[e][2];
          merges += 1;
        }
      }
      for (let i = 0; i < k && ok; i++) {
        for (let j = i + 1; j < k && ok; j++) if (veto[i][j] && root(i) === root(j)) ok = false;
      }
      if (!ok) continue;
      const key = local.map((_, i) => root(i)).join(',');
      if (best === null || merges > best.merges || (merges === best.merges && cost < best.cost)) {
        best = { merges, cost, key, mask };
        tie = false;
      } else if (merges === best.merges && cost === best.cost && key !== best.key) {
        tie = true;
      }
    }
    if (best === null || tie) return;
    links.forEach((l, e) => {
      if (best.mask & (1 << e)) union(l.x, l.y);
    });
  };

  const settle = (pairs) => {
    for (;;) {
      const links = linksOf(pairs);
      if (!links.length) return;
      const touching = new Map(); // grupo -> elos que chegam nele
      for (const l of links) {
        for (const id of [l.x, l.y]) (touching.get(id) || touching.set(id, []).get(id)).push(l);
      }
      const other = (l, id) => (l.x === id ? l.y : l.x);
      /** Elos que disputam um grupo com `l`: aceitar um impede o outro. */
      const rivals = (l) => {
        const out = [];
        for (const id of [l.x, l.y]) {
          for (const m of touching.get(id)) if (m !== l && clusterVeto(other(m, id), other(l, id))) out.push(m);
        }
        return out;
      };
      // O elo mais curto que nenhum concorrente iguala (sem concorrente nenhum também serve)
      const clear = links.find((l) => rivals(l).every((m) => m.d > l.d));
      if (clear) {
        union(clear.x, clear.y);
        continue;
      }
      // Só sobraram empates: cada ilha de elos é resolvida de uma vez
      let merged = false;
      const seen = new Set();
      for (const start of links) {
        if (seen.has(start.x)) continue;
        const ids = new Set([start.x]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const l of links) {
            if (ids.has(l.x) !== ids.has(l.y)) {
              ids.add(l.x).add(l.y);
              grew = true;
            }
          }
        }
        for (const id of ids) seen.add(id);
        const island = links.filter((l) => ids.has(l.x));
        if (island.length <= MAX_SEARCH_LINKS) {
          solve(island);
          continue;
        }
        // Ilha grande demais para testar tudo (dezenas de APs em fila): come pelas pontas. Um
        // grupo com uma única opção fica com ela, desde que o concorrente tenha para onde ir.
        const single = (id) => touching.get(id).length === 1;
        const leaf = island.find((l) => (single(l.x) || single(l.y)) && rivals(l).every((m) => !single(m.x) && !single(m.y)));
        if (leaf) {
          union(leaf.x, leaf.y);
          merged = true;
        }
      }
      if (!merged) return;
    }
  };

  settle(strong);
  settle(weak);

  // --- saída
  const devices = [];
  for (let i = 0; i < n; i++) {
    if (find(i) !== i) continue;
    const group = members[i].map((m) => nodes[m]);
    group.sort((a, b) => bandRank(a.band) - bandRank(b.band) || (a.freq ?? 0) - (b.freq ?? 0) || (a.key < b.key ? -1 : 1));
    const factory = group.filter((g) => g.mac && (g.mac[0] & 0x02) === 0);
    const mld = group.find((g) => g.mld);
    const pool = factory.length ? factory : group;
    const lowest = pool.reduce((min, g) => (g.key < min.key ? g : min));
    const ssids = [];
    const bands = [];
    let bestRssi = null;
    for (const g of group) {
      if (g.ssid !== null && !ssids.includes(g.ssid)) ssids.push(g.ssid);
      if (g.band !== null && !bands.includes(g.band)) bands.push(g.band);
      if (g.rssi !== null && (bestRssi === null || g.rssi > bestRssi)) bestRssi = g.rssi;
    }
    devices.push({
      id: mld ? mld.mld : lowest.key,
      bssids: group.filter((g) => g.mac).map((g) => g.key),
      aps: group.map((g) => g.ap),
      ssids,
      bands,
      bestRssi,
    });
  }
  return devices.sort((a, b) => (b.bestRssi ?? -Infinity) - (a.bestRssi ?? -Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// groupBySsid: as "redes" como o usuário as enxerga
// ---------------------------------------------------------------------------

/** Família de segurança: o mesmo nome com outra família é outra rede (é assim que o Android separa). */
function securityFamily(security) {
  const s = isObj(security) ? security : {};
  if (s.known === false || !Array.isArray(s.protocols)) return 'unknown';
  if (s.enterprise) return 'eap';
  if (s.protocols.includes('WEP')) return 'wep';
  if (s.personal) return 'psk';
  if (s.open) return s.encrypted ? 'owe' : 'open';
  return 'other';
}

const byStrongest = (a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Agrupa os BSSIDs em redes: mesmo nome e mesma família de segurança (aberta, senha, login
 * corporativo...). Redes ocultas nunca são juntadas: cada BSSID oculto é uma rede.
 * @param {Ap[]} aps
 * @param {{devices?: ReturnType<typeof groupByDevice>}} [options]  resultado de groupByDevice(aps), se já calculado
 * @returns {{key:string, ssid:string, name:string, hidden:boolean, security:object, aps:Ap[], devices:number,
 *            bands:string[], best:Ap, mesh:boolean}[]}
 *          da rede mais forte para a mais fraca; `aps` idem; `devices` = quantos aparelhos físicos
 *          anunciam a rede; `mesh` = mais de um (mesh, repetidor ou vários pontos de acesso)
 */
export function groupBySsid(aps, options) {
  const list = [];
  for (const item of Array.isArray(aps) ? aps : []) if (isObj(item)) list.push(asAp(item));

  const given = isObj(options) && Array.isArray(options.devices) ? options.devices : null;
  const deviceOf = new Map();
  for (const device of given || groupByDevice(list)) {
    if (!isObj(device)) continue;
    for (const ap of Array.isArray(device.aps) ? device.aps : []) deviceOf.set(ap, device.id);
    for (const bssid of Array.isArray(device.bssids) ? device.bssids : []) deviceOf.set(bssid, device.id);
  }

  const networks = new Map();
  list.forEach((ap, index) => {
    const key = ap.hidden ? `hidden:${ap.id || `?${index}`}` : `${securityFamily(ap.security)}:${ap.ssid}`;
    let net = networks.get(key);
    if (!net) {
      net = { key, ssid: ap.ssid, name: ap.name, hidden: ap.hidden, aps: [], deviceIds: new Set() };
      networks.set(key, net);
    }
    net.aps.push(ap);
    net.deviceIds.add(deviceOf.get(ap) ?? deviceOf.get(ap.id) ?? `?${index}`);
  });

  const out = [];
  for (const net of networks.values()) {
    net.aps.sort(byStrongest);
    const best = net.aps[0];
    const bands = [...new Set(net.aps.map((ap) => ap.band).filter((b) => b !== null))];
    bands.sort((a, b) => bandRank(a) - bandRank(b));
    out.push({
      key: net.key,
      ssid: net.ssid,
      name: net.name,
      hidden: net.hidden,
      security: best.security,
      aps: net.aps,
      devices: net.deviceIds.size,
      bands,
      best,
      mesh: net.deviceIds.size > 1,
    });
  }
  return out.sort((a, b) => byStrongest(a.best, b.best) || (a.key < b.key ? -1 : 1));
}

// ---------------------------------------------------------------------------
// ApTracker: memória entre varreduras
// ---------------------------------------------------------------------------

const DEDUPE_MS = 500; // o mesmo beacon relido: (ts − ageMs) só varia pelo arredondamento dos relógios
const CLOCK_JUMP_MS = 60_000;

/**
 * Guarda o estado de cada BSSID de uma varredura para a outra: última leitura, sinal suavizado,
 * histórico e quando foi visto.
 *
 * O Android repete na lista os BSSIDs que NÃO ouviu na varredura atual (com `ageMs` grande). O
 * instante real de cada leitura é `ts − ageMs`: se ele não avançou, é a mesma leitura de antes
 * e não vira amostra nova.
 *
 * O sinal suavizado é uma média exponencial com constante de tempo (`smoothingMs`), não com
 * peso fixo por amostra: as varreduras chegam em intervalos irregulares (o Android limita a 4 a
 * cada 2 minutos) e uma leitura de 30 s atrás não deve segurar a atual.
 */
export class ApTracker {
  #aps = new Map();
  #lastTs = null;
  #historyMs;
  #smoothingMs;
  #maxSamples;
  #sdk;

  /**
   * @param {{historyMs?: number, smoothingMs?: number, maxSamples?: number, sdk?: number}} [options]
   *        historyMs: janela do histórico (padrão 10 min); smoothingMs: constante de tempo da
   *        média (padrão 8 s); maxSamples: teto de amostras por BSSID (padrão 600)
   */
  constructor(options) {
    const o = isObj(options) ? options : {};
    this.#historyMs = isNum(o.historyMs) && o.historyMs > 0 ? o.historyMs : 600_000;
    this.#smoothingMs = isNum(o.smoothingMs) && o.smoothingMs >= 0 ? o.smoothingMs : 8000;
    this.#maxSamples = isNum(o.maxSamples) && o.maxSamples >= 1 ? Math.floor(o.maxSamples) : 600;
    this.#sdk = isNum(o.sdk) ? o.sdk : undefined;
  }

  /** Quantos BSSIDs estão na memória. */
  get size() {
    return this.#aps.size;
  }

  /** `ts` da última varredura recebida (null antes da primeira). */
  get lastTs() {
    return this.#lastTs;
  }

  /**
   * Incorpora um ScanEvent.
   * @param {import('../bridge.js').ScanEvent} event
   * @returns {{heard: number, added: number, total: number}}
   *          heard = BSSIDs com leitura nova; added = BSSIDs vistos pela primeira vez
   */
  update(event) {
    const result = { heard: 0, added: 0, total: this.#aps.size };
    if (!isObj(event)) return result;
    const ts = isNum(event.ts) ? event.ts : Date.now();
    // Relógio do celular voltou no tempo (acerto manual de data): o histórico não vale mais
    if (this.#lastTs !== null && ts < this.#lastTs - CLOCK_JUMP_MS) this.clear();
    this.#lastTs = this.#lastTs === null ? ts : Math.max(this.#lastTs, ts);

    for (const ap of normalizeScan({ ts, aps: event.aps }, { sdk: this.#sdk })) {
      let state = this.#aps.get(ap.id);
      // Sem ageMs não dá para saber quando foi ouvido: vale como "agora" se a varredura é nova
      const t = ap.seenAt !== null ? ap.seenAt : !state || event.fresh === true ? ts : null;
      if (state && (t === null || t <= state.lastSeen + DEDUPE_MS)) continue;

      if (!state) {
        state = { ap, smooth: null, history: [], firstSeen: t, lastSeen: t, seenCount: 0 };
        this.#aps.set(ap.id, state);
        result.added += 1;
      }
      if (ap.rssi !== null) {
        if (state.smooth === null) state.smooth = ap.rssi;
        else {
          const alpha = this.#smoothingMs > 0 ? 1 - Math.exp(-(t - state.lastSeen) / this.#smoothingMs) : 1;
          state.smooth += alpha * (ap.rssi - state.smooth);
        }
        state.history.push({ t, rssi: ap.rssi });
      }
      state.ap = ap;
      state.lastSeen = t;
      state.seenCount += 1;
      result.heard += 1;
    }

    const limit = this.#lastTs - this.#historyMs;
    for (const [id, state] of this.#aps) {
      if (state.lastSeen < limit) {
        this.#aps.delete(id);
        continue;
      }
      let drop = Math.max(0, state.history.length - this.#maxSamples);
      while (drop < state.history.length && state.history[drop].t < limit) drop += 1;
      if (drop > 0) state.history.splice(0, drop);
    }
    result.total = this.#aps.size;
    return result;
  }

  #view(state, now) {
    const ageMs = Math.max(0, now - state.lastSeen);
    return {
      ...state.ap,
      ageMs,
      stale: ageMs > STALE_MS,
      seenAt: state.lastSeen,
      rssiSmooth: state.smooth === null ? null : Math.round(state.smooth * 10) / 10,
      firstSeen: state.firstSeen,
      lastSeen: state.lastSeen,
      seenCount: state.seenCount,
    };
  }

  /**
   * BSSIDs conhecidos, do sinal mais forte para o mais fraco. Cada item é o Ap da última leitura
   * com a idade recalculada e mais: `rssiSmooth`, `firstSeen`, `lastSeen`, `seenCount`.
   * @param {{maxAgeMs?: number, now?: number}} [options]  maxAgeMs: some quem não é ouvido há mais
   *        que isto (padrão 60 s); now: instante de referência (padrão: `ts` da última varredura)
   * @returns {Ap[]}
   */
  list(options) {
    const o = isObj(options) ? options : {};
    const maxAgeMs = isNum(o.maxAgeMs) && o.maxAgeMs >= 0 ? o.maxAgeMs : 60_000;
    const now = isNum(o.now) ? o.now : this.#lastTs;
    if (now === null) return [];
    const out = [];
    for (const state of this.#aps.values()) {
      if (now - state.lastSeen <= maxAgeMs) out.push(this.#view(state, now));
    }
    return out.sort(
      (a, b) => (b.rssiSmooth ?? -Infinity) - (a.rssiSmooth ?? -Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /** Estado de um BSSID (mesmo formato dos itens de list()), ou null. */
  get(bssid, options) {
    const state = this.#aps.get(normalizeBssid(bssid));
    if (!state) return null;
    const now = isObj(options) && isNum(options.now) ? options.now : this.#lastTs;
    return this.#view(state, now);
  }

  /**
   * Histórico de sinal de um BSSID, do mais antigo para o mais novo.
   * @param {string} bssid
   * @returns {{t:number, rssi:number}[]}  t = instante em que o beacon foi ouvido (ms desde 1970)
   */
  history(bssid) {
    const state = this.#aps.get(normalizeBssid(bssid));
    return state ? state.history.map((s) => ({ t: s.t, rssi: s.rssi })) : [];
  }

  /** Esquece tudo. */
  clear() {
    this.#aps.clear();
    this.#lastTs = null;
  }
}
