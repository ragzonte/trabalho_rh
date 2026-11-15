// Modelo de dados normalizado: transforma o que o Android entrega (ScanAp, veja bridge.js) no
// objeto `Ap` que o resto do app usa, agrupa BSSIDs por aparelho físico e por rede, e guarda
// o histórico de cada BSSID entre uma varredura e outra.
//
// O que oferece:
//   normalizar  normalizeAp, normalizeScan, asAp, asApList (o typedef `Ap` está logo abaixo)
//   agrupar     groupByDevice (BSSIDs da mesma caixa), groupBySsid (as redes como a pessoa vê)
//   memória     ApTracker (sinal suavizado, histórico e idade de cada BSSID entre varreduras)
//   utilidades  normalizeBssid, parseMac, ssidStem, HIDDEN_NAME, STALE_MS
//
// Nada aqui lança exceção: dado torto vindo do celular vira null / "desconhecido". Os objetos
// `Ap` são tratados como somente leitura por todo o core (groupByDevice guarda a resposta de
// cada lista e confere os campos que usa antes de reaproveitá-la).
//
// Atenção aos nomes: `ap.rssi` é o sinal em dBm (ScanAp.level) e `ap.level` é a classificação
// dele (signalLevel: rótulo, barras, tom). O SSID é entregue como veio (pode trazer emoji,
// caracteres de controle ou HTML): quem desenha a tela usa textContent, nunca innerHTML.

import { occupancy, channelToFreq, BANDS } from './channels.js';
import { qualityPct, signalLevel, indoorDistance, sanitizeRssi } from './signal.js';
import { WIFI_STANDARD, standardInfo, inferGen } from './phy.js';
import { parseCapabilities, refineWithIes } from './security.js';
import { parseIes, summarizeIes } from './ies.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object';

/** Número finito ou null; aceita texto numérico, porque JSON de celular nem sempre é limpo. */
function toNum(x) {
  if (typeof x === 'string' && x.trim() !== '') x = Number(x);
  return isNum(x) ? x : null;
}

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
 * @property {number|null} rssi     dBm; null = sem leitura (o celular não informou, ou mandou 0, positivo ou −127)
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
  let ieGen = ie && isNum(ie.gen) ? ie.gen : null;
  // O 802.11ac só existe em 5 GHz. Elementos VHT num beacon de 2,4 GHz são uma extensão de
  // fabricante (256-QAM, "TurboQAM"), muito comum em roteadores domésticos: a rede é 11n, e é
  // assim que o próprio Android a classifica.
  if (band === '2.4' && ieGen === 5) ieGen = 4;
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
 * Dois casos em que o Android informa uma largura menor que a do AP e os elementos do beacon
 * dizem a verdadeira:
 *
 * 1. O Android anterior ao 13 não tem CHANNEL_WIDTH_320MHZ: um AP Wi-Fi 7 em 320 MHz chega como
 *    160 MHz. O elemento EHT Operation traz a largura e o centro do canal.
 * 2. Um AP 11ac/11ax que usa menos fluxos em 160 MHz do que em 80 MHz anuncia os 160 MHz (ou
 *    80+80) pelo campo "Channel Center Frequency Segment 2" do HT Operation, deixando zerado o
 *    segundo centro do VHT Operation (IEEE 802.11-2020, elemento VHT Operation: é a mesma
 *    regra que o Linux aplica em ieee80211_chandef_vht_oper). O Android só lê o VHT Operation
 *    e entrega 80 MHz.
 */
function widenWithIes(raw, occ, ieInfo) {
  const eht = ieInfo.ehtOperation;
  if (occ.band === '6' && occ.widthMHz < 320 && isObj(eht) && eht.width === 320) {
    const center = channelToFreq(eht.centerSeg1, '6');
    if (center === null) return occ;
    const wide = occupancy({ frequency: raw.frequency, channelWidth: 5, centerFreq0: center, centerFreq1: 0 });
    return wide.widthMHz === 320 && !wide.approx ? wide : occ;
  }

  const ht = ieInfo.htOperation;
  const vht = ieInfo.vhtOperation;
  const caps = ieInfo.vht;
  if (occ.band !== '5' || occ.widthMHz !== 80 || occ.noncontiguous || !isObj(ht) || !isObj(vht) || !isObj(caps)) return occ;
  if (vht.width !== 1 || vht.centerSeg1 !== 0 || !(ht.centerSeg2 > 0)) return occ;
  // O campo só tem significado quando o AP declara "Extended NSS BW Support" (160 MHz com menos
  // fluxos); com o valor 3 junto de 160 MHz pleno, quem vale é o segundo centro do VHT Operation.
  if (!(caps.extNssBw > 0) || (caps.extNssBw === 3 && caps.width160 === true)) return occ;
  const gap = Math.abs(ht.centerSeg2 - vht.centerSeg0);
  const center0 = channelToFreq(vht.centerSeg0, '5');
  const center2 = channelToFreq(ht.centerSeg2, '5');
  // 8 canais de distância = 160 MHz contíguos; mais de 16 = 80+80; o resto é reservado
  if (center0 !== occ.centerFreq || center2 === null || !(gap === 8 || gap > 16)) return occ;
  const wide = occupancy({ frequency: raw.frequency, channelWidth: gap === 8 ? 3 : 4, centerFreq0: center0, centerFreq1: center2 });
  return wide.widthMHz === 160 && !wide.approx && wide.noncontiguous === (gap !== 8) ? wide : occ;
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
  // 0, valores positivos e −127 não são medidas (veja sanitizeRssi): a rede fica "sem leitura"
  const rssi = sanitizeRssi(r.level);

  const ieInfo = Array.isArray(r.ies) ? parseIes(r.ies) : null;
  const hasIes = ieInfo !== null && ieInfo.count > 0;
  const ie = hasIes ? summarizeIes(ieInfo) : null;

  let occ = occupancy(r);
  if (hasIes) occ = widenWithIes(r, occ, ieInfo);

  let security = parseCapabilities(r.capabilities, { sdk: o.sdk });
  if (hasIes) security = refineWithIes(security, ieInfo);

  const age = toNum(r.ageMs);
  const rawAge = age === null ? null : Math.max(0, age);
  const ts = toNum(o.ts) ?? toNum(o.now);
  const now = toNum(o.now) ?? ts;
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

// Listas montadas por asApList, com o tamanho que tinham: reconhecê-las poupa refazer a conta
// quando a mesma lista passa por várias análises (o ranking chama a nota do canal para cada AP).
const CLEAN_LISTS = new WeakMap();

/**
 * Lista pronta para as análises: cada item normalizado (asAp), sem o que não é objeto e com um
 * item só por BSSID. Repetidos (o celular às vezes entrega o mesmo BSSID duas vezes) contariam
 * como dois vizinhos: fica a leitura mais nova, como em normalizeScan. Itens sem BSSID válido
 * ficam todos, porque não há como saber se são repetidos.
 * Uma lista que já saiu daqui volta ela mesma, sem cópia: trate o resultado como somente leitura.
 * @param {*} aps  lista do ApTracker, de normalizeScan, ou ScanAp crus
 * @returns {Ap[]}
 */
export function asApList(aps) {
  if (!Array.isArray(aps)) return [];
  if (CLEAN_LISTS.get(aps) === aps.length && aps.every(isAp)) return aps;
  const out = [];
  const at = new Map(); // BSSID -> posição em `out`
  for (const item of aps) {
    if (!isObj(item)) continue;
    const ap = asAp(item);
    const known = ap.id ? at.get(ap.id) : undefined;
    if (known === undefined) {
      if (ap.id) at.set(ap.id, out.length);
      out.push(ap);
    } else if ((ap.ageMs ?? Infinity) < (out[known].ageMs ?? Infinity)) {
      out[known] = ap;
    }
  }
  CLEAN_LISTS.set(out, out.length);
  return out;
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
//    - mesma faixa em frequências diferentes: um rádio só fala num canal (exceção tolerada: os
//      dois rádios de 5 GHz de um roteador tri-band, um na parte baixa e outro na parte alta
//      da faixa, e só com a mesma raiz de nome e sem explicação melhor);
//    - mesma frequência com sinais diferentes, ou com o MESMO nome de rede: são dois rádios, logo
//      duas caixas (nós de um mesh, por exemplo);
//    - nomes "irmãos" de fábrica, iguais fora o final ("VIVOFIBRA-8A20" / "VIVOFIBRA-8A28",
//      "AP 302" / "AP 304"): cada caixa tem o seu.
//
// Ordem das junções: primeiro o par de endereços mais próximo que nenhum concorrente iguala
// (concorrente = outro par que usa um dos dois BSSIDs e não cabe na mesma caixa). Quando sobra
// empate (lote da operadora: o 2,4 GHz do vizinho tão perto do meu 5 GHz quanto o meu 2,4), vale
// a explicação mais econômica: menos caixas, depois menos "tri-bands" presumidos, depois a menor
// soma de distâncias. E só se ela for única: empatou de novo, ninguém é juntado.

const MAX_STEP = 32; // maior distância entre endereços da mesma caixa (APs corporativos: 16 redes por rádio)
const VAP_STEP = 3; // redes do mesmo rádio são numeradas em sequência
const TINY_STEP = 2; // "colado": aceita sem segundo indício, se não houver disputa
const FINGERPRINT_STEP = 16;
const OCTET_STEP = 4;
const SAME_RADIO_DB = 4; // beacons do mesmo rádio chegam com o mesmo sinal, fora o ruído da medida
const SAME_RADIO_STALE_DB = 8; // ...mas leituras de momentos diferentes variam mais
const SAME_SCAN_MS = 2500;
const MAX_SEARCH_LINKS = 12; // acima disto (2^12 combinações) a disputa é reduzida pelas pontas antes

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

const VETO = 2;
const STRAIN = 1;

/**
 * Dois BSSIDs podem morar na mesma caixa? VETO = não; STRAIN = só se não houver explicação
 * melhor (os dois rádios de 5 GHz de um roteador tri-band); 0 = nada contra.
 */
function clash(a, b) {
  if (siblingNames(a, b)) return VETO;
  if (a.band === null || a.band !== b.band || a.freq === null || b.freq === null) return 0;
  if (a.freq === b.freq) return (a.ssid !== null && a.ssid === b.ssid) || !sameRadioLook(a, b) ? VETO : 0;
  const split = a.band === '5' && Math.min(a.freq, b.freq) < 5470 && Math.max(a.freq, b.freq) >= 5470;
  return split ? STRAIN : VETO;
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
  const items = [];
  let ready = true; // a lista já veio toda normalizada?
  for (const item of Array.isArray(aps) ? aps : []) {
    if (!isObj(item)) continue;
    const ap = asAp(item);
    if (ap !== item) ready = false;
    items.push(ap);
  }
  if (!ready || items.length < 2) return groupItems(items);
  const known = DEVICE_MEMO.get(items[0]);
  if (known && sameReading(known, items)) return copyDevices(known.devices);
  const devices = groupItems(items);
  DEVICE_MEMO.set(items[0], { items: items.slice(), marks: marksOf(items), devices: copyDevices(devices) });
  return devices;
}

// A mesma lista passa por aqui várias vezes a cada varredura (store, canais, melhor rede,
// diagnóstico) e esta é a conta mais cara do módulo, então a resposta de cada lista fica
// guardada. Chave: o primeiro Ap da lista (a memória some junto com ele). Só vale se a lista
// for a mesma, item a item, e nenhum campo que o agrupamento lê tiver mudado nesse meio-tempo.
const DEVICE_MEMO = new WeakMap();
const MEMO_FIELDS = ['bssid', 'band', 'freq', 'widthMHz', 'rssi', 'ageMs', 'ssid', 'hidden', 'fingerprint', 'mld', 'ie'];

function marksOf(items) {
  const marks = [];
  for (const ap of items) for (const field of MEMO_FIELDS) marks.push(ap[field]);
  return marks;
}

function sameReading(known, items) {
  if (known.items.length !== items.length) return false;
  let k = 0;
  for (let i = 0; i < items.length; i++) {
    const ap = items[i];
    if (known.items[i] !== ap) return false;
    for (const field of MEMO_FIELDS) if (known.marks[k++] !== ap[field]) return false;
  }
  return true;
}

/** Cópia que quem recebe pode alterar à vontade sem estragar a resposta guardada. */
function copyDevices(devices) {
  return devices.map((d) => ({
    id: d.id,
    bssids: d.bssids.slice(),
    aps: d.aps.slice(),
    ssids: d.ssids.slice(),
    bands: d.bands.slice(),
    bestRssi: d.bestRssi,
  }));
}

function groupItems(items) {
  const nodes = items.map((ap, index) => deviceNode(ap, index));
  nodes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const n = nodes.length;

  // União de conjuntos; a raiz é sempre o menor índice, para o resultado ser determinístico
  const parent = nodes.map((_, i) => i);
  const members = nodes.map((_, i) => [i]);
  const grown = new Array(n).fill(0); // quantas vezes o grupo de cada raiz cresceu
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]; // encurta o caminho para as próximas buscas
      i = parent[i];
    }
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
    grown[root] += 1;
  };
  // O conflito entre dois grupos é perguntado muitas vezes enquanto as junções são decididas, e
  // só muda quando um deles cresce: a resposta fica guardada junto com o "tamanho" de cada um.
  const clashMemo = new Map();
  const clusterClash = (x, y) => {
    const lo = x < y ? x : y;
    const hi = x < y ? y : x;
    const key = lo * n + hi;
    const mark = (grown[lo] * (n + 1) + grown[hi]) * 4;
    const known = clashMemo.get(key);
    if (known !== undefined && known - (known % 4) === mark) return known % 4;
    let worst = 0;
    for (const i of members[lo]) {
      for (const j of members[hi]) {
        const level = clash(nodes[i], nodes[j]);
        if (level > worst) worst = level;
      }
      if (worst === VETO) break;
    }
    clashMemo.set(key, mark + worst);
    return worst;
  };

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
      if (clash(nodes[i], nodes[j]) === VETO) continue;
      const tier = hintTier(nodes[i], nodes[j], dist);
      if (tier === STRONG) strong.push({ i, j, d: dist.d });
      else if (tier === WEAK) weak.push({ i, j, d: dist.d });
    }
  }

  // --- 2 e 3. endereços próximos, respeitando os vetos
  /** Disputa: os grupos de uma mesma ilha de elos, resolvidos pela explicação mais econômica. */
  const solve = (links, join) => {
    if (links.length > MAX_SEARCH_LINKS) return;
    const ids = [...new Set(links.flatMap((l) => [l.x, l.y]))].sort((a, b) => a - b);
    const k = ids.length;
    const at = new Map(ids.map((id, i) => [id, i]));
    const edges = links.map((l) => [at.get(l.x), at.get(l.y), l.d]);
    const clashes = ids.map((x) => ids.map((y) => (x === y ? 0 : clusterClash(x, y))));
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
      let strain = 0;
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
        for (let j = i + 1; j < k && ok; j++) {
          if (clashes[i][j] === 0 || root(i) !== root(j)) continue;
          if (clashes[i][j] === VETO) ok = false;
          else strain += 1;
        }
      }
      if (!ok) continue;
      // Melhor = mais junções; depois menos "tri-bands" presumidos; depois endereços mais próximos
      const key = local.map((_, i) => root(i)).join(',');
      const order = best === null ? -1 : best.merges - merges || strain - best.strain || cost - best.cost;
      if (order < 0) {
        best = { merges, strain, cost, key, mask };
        tie = false;
      } else if (order === 0 && key !== best.key) {
        tie = true;
      }
    }
    if (best === null || tie) return;
    links.forEach((l, e) => {
      if (best.mask & (1 << e)) join(l.x, l.y);
    });
  };

  const linkOrder = (a, b) => a.d - b.d || a.x - b.x || a.y - b.y;
  const other = (l, id) => (l.x === id ? l.y : l.x);

  const settle = (pairs) => {
    // Elos = pares de grupos ainda separados e compatíveis, com a menor distância entre eles.
    // São mantidos a cada junção, não refeitos: uma junção só muda os elos que chegavam a um dos
    // dois grupos (numa fila de dezenas de APs, refazer tudo a cada passo custava segundos).
    const links = new Map(); // par de grupos -> elo
    const touching = new Map(); // grupo -> Set dos elos que chegam nele
    let order = []; // os elos em ordem (distância, depois grupos); os mortos saem na faxina
    let dead = 0;

    const attach = (l) => {
      links.set(l.x * n + l.y, l);
      for (const id of [l.x, l.y]) {
        const set = touching.get(id);
        if (set) set.add(l);
        else touching.set(id, new Set([l]));
      }
    };
    const detach = (l) => {
      l.dead = true;
      dead += 1;
      links.delete(l.x * n + l.y);
      for (const id of [l.x, l.y]) {
        const set = touching.get(id);
        set.delete(l);
        if (set.size === 0) touching.delete(id);
      }
    };
    /** Põe o elo no lugar certo de `order` (busca binária). */
    const insert = (l) => {
      let lo = 0;
      let hi = order.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (linkOrder(order[mid], l) < 0) lo = mid + 1;
        else hi = mid;
      }
      order.splice(lo, 0, l);
    };
    const sweep = () => {
      order = order.filter((l) => !l.dead);
      dead = 0;
    };

    for (const p of pairs) {
      const a = find(p.i);
      const b = find(p.j);
      if (a === b) continue;
      const x = a < b ? a : b;
      const y = a < b ? b : a;
      const known = links.get(x * n + y);
      if (known) {
        if (p.d < known.d) known.d = p.d;
        continue;
      }
      const level = clusterClash(x, y);
      if (level !== VETO) attach({ x, y, d: p.d, strained: level === STRAIN, dead: false });
    }
    order = [...links.values()].sort(linkOrder);

    /** Junta os grupos de `a` e `b` e refaz os elos que chegavam a um dos dois. */
    const join = (a, b) => {
      const x = find(a);
      const y = find(b);
      if (x === y) return;
      const reach = new Map(); // grupo vizinho -> menor distância até o grupo novo
      for (const id of [x, y]) {
        for (const l of [...(touching.get(id) || [])]) {
          const z = other(l, id);
          detach(l);
          if (z === x || z === y) continue; // o próprio elo entre os dois
          const d = reach.get(z);
          if (d === undefined || l.d < d) reach.set(z, l.d);
        }
      }
      union(x, y);
      const root = find(x);
      for (const [z, d] of reach) {
        // Um veto que só um dos dois tinha passa a valer para o grupo inteiro
        const level = clusterClash(root, z);
        if (level === VETO) continue;
        const l = { x: Math.min(root, z), y: Math.max(root, z), d, strained: level === STRAIN, dead: false };
        attach(l);
        insert(l);
      }
      if (dead > 64 && dead > order.length / 2) sweep();
    };

    /** Elos que disputam um grupo com `l`: aceitar um impede o outro. */
    const rivals = (l) => {
      const out = [];
      for (const id of [l.x, l.y]) {
        for (const m of touching.get(id)) if (m !== l && clusterClash(other(m, id), other(l, id)) > 0) out.push(m);
      }
      return out;
    };
    /** Nenhum concorrente de `l` é tão curto quanto ele (sem concorrente nenhum também serve). */
    const unbeaten = (l) => {
      for (const id of [l.x, l.y]) {
        for (const m of touching.get(id)) {
          if (m !== l && m.d <= l.d && clusterClash(other(m, id), other(l, id)) > 0) return false;
        }
      }
      return true;
    };
    // Um elo "tri-band" só passa direto quando é a única opção dos dois lados.
    const sole = (l) => touching.get(l.x).size === 1 && touching.get(l.y).size === 1;

    const tried = new Set(); // ilhas que já foram resolvidas (ou deram empate)
    for (;;) {
      if (links.size === 0) return;
      // O elo mais curto que nenhum concorrente iguala
      let clear = null;
      for (const l of order) {
        if (!l.dead && (l.strained ? sole(l) : unbeaten(l))) {
          clear = l;
          break;
        }
      }
      if (clear) {
        join(clear.x, clear.y);
        continue;
      }

      // Só sobraram empates: cada ilha de elos é resolvida de uma vez
      sweep();
      const islandOf = new Map(); // grupo -> elos da ilha dele
      const islands = [];
      for (const start of order) {
        if (islandOf.has(start.x)) continue;
        const island = [];
        islands.push(island);
        islandOf.set(start.x, island);
        const stack = [start.x];
        while (stack.length) {
          const id = stack.pop();
          for (const l of touching.get(id)) {
            const z = other(l, id);
            if (!islandOf.has(z)) {
              islandOf.set(z, island);
              stack.push(z);
            }
          }
        }
      }
      for (const l of order) islandOf.get(l.x).push(l);

      let merged = false;
      for (const island of islands) {
        if (island.length <= MAX_SEARCH_LINKS) {
          const signature = island.map((l) => `${l.x}|${l.y}`).join(' ');
          if (!tried.has(signature)) solve(island, join);
          tried.add(signature);
          continue;
        }
        // Ilha grande demais para testar tudo (dezenas de APs em fila): come pelas pontas. Um
        // grupo com uma única opção fica com ela, desde que o concorrente tenha para onde ir.
        // (Os elos "tri-band" não entram nesta conta: são sempre a última hipótese.)
        const firm = island.filter((l) => !l.strained);
        const options = new Map();
        for (const l of firm) for (const id of [l.x, l.y]) options.set(id, (options.get(id) || 0) + 1);
        const single = (id) => options.get(id) === 1;
        const leaf = firm.find(
          (l) => (single(l.x) || single(l.y)) && rivals(l).every((m) => m.strained || (!single(m.x) && !single(m.y))),
        );
        if (leaf) {
          join(leaf.x, leaf.y);
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

// Fora da classe de propósito: método privado (#nome()) só existe a partir do Chrome 84,
// e o WebView de celulares sem atualização pode ser mais antigo.
function trackerView(state, now) {
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
  #maxAps;
  #sdk;
  #clock;

  /**
   * @param {{historyMs?: number, smoothingMs?: number, maxSamples?: number, maxAps?: number,
   *          sdk?: number, clock?: () => number}} [options]
   *        historyMs: janela do histórico (padrão 10 min); smoothingMs: constante de tempo da
   *        média (padrão 8 s); maxSamples: teto de amostras por BSSID (padrão 600); maxAps: teto
   *        de BSSIDs na memória (padrão 1000; passando disso saem os ouvidos há mais tempo);
   *        clock: relógio (ms desde 1970) para as varreduras que chegam sem `ts` (padrão Date.now)
   */
  constructor(options) {
    const o = isObj(options) ? options : {};
    this.#historyMs = isNum(o.historyMs) && o.historyMs > 0 ? o.historyMs : 600_000;
    this.#smoothingMs = isNum(o.smoothingMs) && o.smoothingMs >= 0 ? o.smoothingMs : 8000;
    this.#maxSamples = isNum(o.maxSamples) && o.maxSamples >= 1 ? Math.floor(o.maxSamples) : 600;
    this.#maxAps = isNum(o.maxAps) && o.maxAps >= 1 ? Math.floor(o.maxAps) : 1000;
    this.#sdk = isNum(o.sdk) ? o.sdk : undefined;
    this.#clock = typeof o.clock === 'function' ? o.clock : Date.now;
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
    let ts = toNum(event.ts);
    if (ts === null) {
      // Varredura sem relógio: vale o do aparelho (e, se nem ele servir, o da última varredura)
      let now = null;
      try {
        now = this.#clock();
      } catch {
        // relógio injetado com defeito
      }
      ts = isNum(now) ? now : (this.#lastTs ?? 0);
    }
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
    // Teto de memória: num lugar com milhares de BSSIDs de passagem (ou com um relógio que não
    // anda, e aí nada envelhece), saem os ouvidos há mais tempo.
    if (this.#aps.size > this.#maxAps) {
      const oldest = [...this.#aps].sort((a, b) => a[1].lastSeen - b[1].lastSeen || (a[0] < b[0] ? -1 : 1));
      for (let i = 0; i < oldest.length - this.#maxAps; i++) this.#aps.delete(oldest[i][0]);
    }
    result.total = this.#aps.size;
    return result;
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
      if (now - state.lastSeen <= maxAgeMs) out.push(trackerView(state, now));
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
    return trackerView(state, now);
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
