// Melhor rede: "qual Wi-Fi rende mais aqui, agora, para este celular?"
//
// MODELO
//
// 1. Enlace. estimateLink (phy.js) diz que taxa física o sinal sustenta entre o AP e o celular,
//    negociando geração, largura e fluxos pelo lado mais fraco. usableMbps tira o que o
//    protocolo consome: é a velocidade com o canal livre (`detail.linkMbps`).
//
// 2. Tempo de ar. Um canal é dividido com quem mais estiver nele. A fração que sobra para o
//    celular sai do mesmo modelo da nota dos canais (channel-rating.js), aplicado ao canal do
//    AP e à largura que o enlace usa:
//        tempo ocupado = o maior entre o MODELO (vizinhos no mesmo canal + os aparelhos do
//                        próprio AP) e o MEDIDO (ocupação que o AP anuncia no BSS Load)
//        fração        = (1 − tempo ocupado) · (1 − perda por ruído de canais sobrepostos)
//    A medição do AP inclui o tráfego do próprio celular quando ele está naquele canal; nesse
//    caso ela é ignorada (senão baixar um arquivo faria a rede em uso parecer congestionada).
//
// 3. Velocidade esperada: estMbps = linkMbps · fração.
//
// 4. Nota. Escala logarítmica da velocidade (20 Mb/s = 60, 400 Mb/s = 100: dobrar a
//    velocidade vale sempre os mesmos pontos, porque é assim que uma pessoa percebe). Depois:
//      - sinal fraco põe um teto na nota (a conta de velocidade é otimista perto do limite, e
//        uma conexão que cai não serve, por mais rápida que seja no papel);
//      - rede aberta ou WEP perde metade da nota; só WPA/TKIP perde um quinto;
//      - WPA3 ganha um pequeno bônus (que não passa do teto do sinal).
//
// Simplificações assumidas: o tempo ocupado é pessimista como na nota dos canais (vale o maior
// entre modelo e medição); os outros nós do mesmo mesh no mesmo canal não entram como
// concorrentes (channel-rating os trata como parte da rede); a estimativa do enlace usa o piso
// de ruído térmico, por isso é otimista com sinal fraco (o teto do item 4 compensa).
//
// Nada aqui lança exceção: dado torto vindo do celular vira nota 0 / null.

import { clamp, lerp, qualityPct, signalLevel } from './signal.js';
import { estimateLink, usableMbps, standardInfo } from './phy.js';
import { asAp, groupByDevice, groupBySsid, normalizeBssid, ssidStem } from './model.js';
import { rateOwnChannel } from './channel-rating.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object';
const round1 = (x) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------------
// Pesos e limites (cada um é uma escolha de projeto; mude aqui, não no meio do código)
// ---------------------------------------------------------------------------

// --- velocidade -> nota
/** Velocidade que "dá e sobra" para uma casa: streaming em 4K (25 Mb/s) mais o resto. */
export const SPEED_GOOD_MBPS = 20;
/** Nota de uma rede com SPEED_GOOD_MBPS. */
export const SPEED_GOOD_SCORE = 60;
/** Daqui para cima ninguém percebe diferença no celular: nota 100. */
export const SPEED_TOP_MBPS = 400;

// --- teto por sinal fraco
/** Deste sinal para cima o sinal não limita a nota. */
export const SIGNAL_FREE_DBM = -70;
/** Abaixo disto a conexão cai e volta: inutilizável na prática. */
export const WEAK_SIGNAL_DBM = -80;
/** Nota máxima de uma rede que chega com WEAK_SIGNAL_DBM. */
export const WEAK_SIGNAL_CAP = 35;
/** No limite do que um celular consegue ouvir... */
const DEAD_SIGNAL_DBM = -90;
/** ...a nota não passa disto. */
const DEAD_SIGNAL_CAP = 5;

// --- segurança
/** Rede aberta (sem criptografia) ou WEP: metade da nota. Com isto, uma rede protegida de
 *  10 Mb/s com sinal decente já ganha da melhor rede aberta possível. */
export const INSECURE_FACTOR = 0.5;
/** Só WPA/TKIP: fraca, mas não escancarada. */
export const WEAK_SECURITY_FACTOR = 0.8;
/** Pontos a mais para quem oferece WPA3. */
export const WPA3_BONUS = 3;
/** Wi-Fi Direct ou rede ponto a ponto: é um aparelho (impressora, TV), não dá internet. */
const NOT_A_NETWORK_FACTOR = 0.2;
// Nota de segurança (parts.security) por nível de security.js; desconhecida fica no meio.
const SECURITY_PART = [0, 10, 40, 80, 100];
const SECURITY_PART_UNKNOWN = 50;

// --- tempo de ar
// Ciclo de trabalho de um rádio: os mesmos números de channel-rating.js (lá não são
// exportados). Um teste confere que os dois arquivos continuam combinando.
const DEFAULT_DUTY = 0.08;
const IDLE_DUTY = 0.02;
const DUTY_PER_STATION = 0.03;
const MAX_DUTY = 0.5;
const EXTRA_NETWORK_DUTY = 0.015;
/** O CSMA/CA sempre dá a vez a quem disputa: nem o canal mais lotado zera a fração. */
const MIN_AIRTIME_SHARE = 0.05;

// --- o celular, quando não se sabe mais nada sobre ele
/** Fluxos espaciais de um celular comum (2x2). */
const CLIENT_NSS = 2;
// Celulares praticamente nunca usam 40 MHz em 2,4 GHz (regra de coexistência 20/40); 80 MHz é
// o comum em 5 GHz; os Wi-Fi 6E/7 chegam a 160 MHz e os Wi-Fi 7 a 320 MHz nos 6 GHz.
const CLIENT_WIDTH_24 = 20;
const CLIENT_WIDTH_5 = 80;
const CLIENT_WIDTH_WIDE = 160;
const CLIENT_WIDTH_BE_6 = 320;

// --- textos (a partir de quando cada frase aparece nos prós e contras)
/** "Muito rápida": acima do que qualquer uso doméstico pede. */
const FAST_MBPS = 100;
/** "Lenta": abaixo disto vídeo em alta definição já engasga. */
const SLOW_MBPS = 5;
/** "Canal livre": sobra pelo menos esta fração do tempo de ar. */
const FREE_SHARE = 0.85;
/** Abaixo desta fração o canal entra nos contras, com a causa principal. */
const BUSY_SHARE = 0.6;
/** Ocupação medida a partir da qual a frase cita a porcentagem. */
const BUSY_UTILIZATION = 0.4;
/** Aparelhos no mesmo rádio que já merecem menção. */
const MANY_STATIONS = 15;
/** Leitura mais velha que isto ganha o aviso de "pode estar desatualizada". */
const OLD_READING_MS = 30_000;

// --- conselho
/** Diferença de nota que justifica mandar a pessoa trocar (6 pontos ≈ 1,5 vez a velocidade). */
export const SWITCH_MIN_POINTS = 6;
/** Uma opção na mesma rede/roteador ganha de outra rede até esta diferença (trocar é mais simples). */
const SAME_NETWORK_MARGIN = 5;
/** "Bem mais forte": quanto o outro ponto de acesso precisa ganhar em dB para valer o aviso. */
export const ROAM_MIN_DB = 8;
/** Só vale citar uma rede que não é da pessoa se ela for muito melhor... */
const HINT_MIN_POINTS = 10;
/** ...e a atual não estiver boa. */
const HINT_BELOW_SCORE = 80;
/** Abaixo disto a razão entre as velocidades não vira frase ("1,1x mais" não convence ninguém). */
const GAIN_WORTH_SAYING = 1.2;
/** Acima disto a frase para de contar: "pelo menos 10x mais". */
const GAIN_SAY_AT_MOST = 10;

const MINUS = '−';
const BAND_NAME = { '2.4': '2,4 GHz', 5: '5 GHz', 6: '6 GHz', 60: '60 GHz' };

// ---------------------------------------------------------------------------
// Formatadores (pt-BR)
// ---------------------------------------------------------------------------

const comma = (x, digits) => x.toFixed(digits).replace('.', ',').replace(/,0+$/, '');

/**
 * Velocidade estimada, com dois algarismos significativos (é uma estimativa):
 * 7.46 -> "7,5 Mb/s"; 286 -> "290 Mb/s"; 1134 -> "1,1 Gb/s". Inválido -> "—".
 * @param {number} mbps
 * @returns {string}
 */
export function formatSpeed(mbps) {
  if (!isNum(mbps) || mbps < 0) return '—';
  if (mbps < 9.95) return `${comma(mbps, 1)} Mb/s`;
  const magnitude = Math.pow(10, Math.floor(Math.log10(mbps)) - 1);
  const rounded = Math.round(mbps / magnitude) * magnitude;
  return rounded >= 1000 ? `${comma(rounded / 1000, 1)} Gb/s` : `${Math.round(rounded)} Mb/s`;
}

/** Razão entre duas velocidades: 2.34 -> "2,3x"; 14.2 -> "14x". */
export function formatGain(ratio) {
  if (!isNum(ratio) || ratio <= 0) return '—';
  return ratio >= 9.95 ? `${Math.round(ratio)}x` : `${comma(ratio, 1)}x`;
}

/** Sinal com o menos tipográfico: -57.2 -> "−57 dBm". */
export function formatDbm(rssi) {
  if (!isNum(rssi)) return '—';
  const n = Math.round(rssi);
  return `${n < 0 ? MINUS : ''}${Math.abs(n)} dBm`;
}

/** Nome da rede para frases: “Casa” ou "uma rede oculta". */
function quoted(net) {
  const ssid = isObj(net) && typeof net.ssid === 'string' ? net.ssid : '';
  return ssid === '' || net.hidden === true ? 'uma rede oculta' : `“${ssid}”`;
}

// ---------------------------------------------------------------------------
// O celular
// ---------------------------------------------------------------------------

/**
 * O que o celular consegue usar, a partir do DeviceInfo (bridge.js). O que não vier é presumido:
 * 2 fluxos espaciais, 20 MHz em 2,4 GHz, 80 MHz em 5 GHz (160 MHz nos Wi-Fi 6E/7), 160 MHz em
 * 6 GHz (320 MHz nos Wi-Fi 7) e a mesma geração do AP.
 * @param {import('../bridge.js').DeviceInfo} [device]
 * @returns {{gen: number|null, nss: number, maxWidthMHz: {'2.4': number, '5': number, '6': number},
 *            bands: {b24: boolean|null, b5: boolean|null, b6: boolean|null, b60: boolean|null},
 *            supports: (band: string|null) => boolean}}
 *          gen = geração mais nova que o celular fala (null = não informou); bands: null = não se sabe;
 *          supports(band) = false só quando se SABE que o celular não usa a faixa
 */
export function clientProfile(device) {
  const d = isObj(device) ? device : {};
  const b = isObj(d.bands) ? d.bands : {};
  const flag = (v) => (typeof v === 'boolean' ? v : null);
  const bands = { b24: flag(b.b24), b5: flag(b.b5), b6: flag(b.b6), b60: flag(b.b60) };

  let gen = null;
  for (const code of Array.isArray(d.standards) ? d.standards : []) {
    const g = standardInfo(code).gen; // 802.11ad e códigos desconhecidos dão null
    if (isNum(g) && (gen === null || g > gen)) gen = g;
  }
  // Quem usa 6 GHz fala pelo menos Wi-Fi 6, mesmo que a lista de padrões venha incompleta
  if (bands.b6 === true && gen !== null && gen < 6) gen = 6;

  const wide = bands.b6 === true || (gen !== null && gen >= 7);
  const maxWidthMHz = {
    '2.4': CLIENT_WIDTH_24,
    5: wide ? CLIENT_WIDTH_WIDE : CLIENT_WIDTH_5,
    6: gen !== null && gen >= 7 ? CLIENT_WIDTH_BE_6 : CLIENT_WIDTH_WIDE,
  };
  const supports = (band) => {
    if (band === '2.4') return bands.b24 !== false;
    if (band === '5') return bands.b5 !== false;
    if (band === '6') return bands.b6 !== false && (gen === null || gen >= 6);
    if (band === '60') return bands.b60 !== false;
    return true;
  };
  return { gen, nss: CLIENT_NSS, maxWidthMHz, bands, supports };
}

// ---------------------------------------------------------------------------
// Contexto: o que se calcula uma vez por lista de APs
// ---------------------------------------------------------------------------

const CONTEXT = Symbol('scoringContext');

/**
 * Prepara a lista para scoreAp: normaliza, agrupa por aparelho físico e por rádio. Vale a pena
 * chamar uma vez e passar em `context` quando vários APs da mesma lista serão avaliados.
 * @param {import('./model.js').Ap[]} aps  lista do ApTracker (ou ScanAp crus)
 * @param {{device?: object, connectionBssid?: string}} [options]
 * @returns {object}  opaco: só serve para passar a scoreAp
 */
export function scoringContext(aps, options) {
  return makeContext(toList(aps), isObj(options) ? options : {});
}

/** Lista normalizada, sem o que não tem BSSID válido (lixo não vira rede nem vizinho). */
function toList(aps) {
  const list = [];
  for (const item of Array.isArray(aps) ? aps : []) {
    if (!isObj(item)) continue;
    const ap = asAp(item);
    if (ap.id !== '') list.push(ap);
  }
  return list;
}

function makeContext(list, o) {
  const devices = groupByDevice(list);
  const deviceOf = new Map(); // BSSID -> id do aparelho
  const radios = new Map(); // "aparelho|frequência" -> APs daquele rádio
  for (const device of devices) {
    for (const ap of device.aps) {
      if (!ap.id) continue;
      deviceOf.set(ap.id, device.id);
      const key = `${device.id}|${ap.freq}`;
      const radio = radios.get(key);
      if (radio) radio.push(ap);
      else radios.set(key, [ap]);
    }
  }
  const connectedId = normalizeBssid(o.connectionBssid);
  return {
    [CONTEXT]: true,
    list,
    devices,
    deviceOf,
    radios,
    client: clientProfile(o.device),
    connected: connectedId ? list.find((ap) => ap.id === connectedId) || null : null,
  };
}

function contextFor(ap, o) {
  if (isObj(o.context) && o.context[CONTEXT] === true) return o.context;
  const list = toList(o.aps);
  // O AP avaliado entra na conta mesmo que a lista não o traga
  if (!list.some((x) => x.id === ap.id)) list.push(ap);
  return makeContext(list, o);
}

// ---------------------------------------------------------------------------
// Peças da nota
// ---------------------------------------------------------------------------

/**
 * Nota (0..100) de uma velocidade, em escala logarítmica: 20 Mb/s = 60; 400 Mb/s ou mais = 100;
 * cada vez que a velocidade dobra, +9,3 pontos. Abaixo de ~0,22 Mb/s, 0.
 * @param {number} mbps
 * @returns {number}
 */
export function speedScore(mbps) {
  if (!isNum(mbps) || mbps <= 0) return 0;
  const perLog = (100 - SPEED_GOOD_SCORE) / Math.log(SPEED_TOP_MBPS / SPEED_GOOD_MBPS);
  return clamp(SPEED_GOOD_SCORE + perLog * Math.log(mbps / SPEED_GOOD_MBPS), 0, 100);
}

/**
 * Teto que o sinal impõe à nota: 100 até −70 dBm, cai em linha reta até 35 em −80 dBm e até 5
 * em −90 dBm (rampa em vez de degrau, para a ordem das redes não ficar pulando a cada leitura).
 * @param {number} rssi dBm
 * @returns {number}
 */
export function signalCap(rssi) {
  if (!isNum(rssi)) return 0;
  if (rssi >= SIGNAL_FREE_DBM) return 100;
  if (rssi >= WEAK_SIGNAL_DBM) {
    return lerp(WEAK_SIGNAL_CAP, 100, (rssi - WEAK_SIGNAL_DBM) / (SIGNAL_FREE_DBM - WEAK_SIGNAL_DBM));
  }
  if (rssi >= DEAD_SIGNAL_DBM) {
    return lerp(DEAD_SIGNAL_CAP, WEAK_SIGNAL_CAP, (rssi - DEAD_SIGNAL_DBM) / (WEAK_SIGNAL_DBM - DEAD_SIGNAL_DBM));
  }
  return DEAD_SIGNAL_CAP;
}

const AES = new Set(['CCMP', 'CCMP-256', 'GCMP-128', 'GCMP-256']);

/** Como a segurança entra na conta. `sec` = Ap.security (security.js). */
function securityView(sec) {
  const s = isObj(sec) ? sec : {};
  const known = s.known === true;
  const level = known && Number.isInteger(s.level) && s.level >= 0 && s.level <= 4 ? s.level : null;
  const protocols = Array.isArray(s.protocols) ? s.protocols : [];
  const ciphers = Array.isArray(s.ciphers) ? s.ciphers : [];
  const wep = known && protocols.includes('WEP');
  // Nível 0 conhecido = aberta de verdade (OWE e a transição OWE ficam nos níveis 4 e 3)
  const open = known && level === 0;
  return {
    known,
    level,
    open,
    wep,
    insecure: open || wep,
    weak: known && level === 2,
    wpa3: known && protocols.includes('WPA3'),
    // O 802.11n em diante proíbe WEP e TKIP: quem só oferece essas cifras fica nas taxas do
    // 802.11a/g (54 Mb/s no máximo), seja qual for o roteador.
    legacyCipher: wep || (known && ciphers.length > 0 && !ciphers.some((c) => AES.has(c))),
    part: level === null ? SECURITY_PART_UNKNOWN : SECURITY_PART[level],
    label: typeof s.label === 'string' ? s.label : 'Desconhecida',
    issues: Array.isArray(s.issues) ? s.issues.filter(isObj) : [],
  };
}

/**
 * Rede aberta (sem criptografia) ou WEP? Só afirma quando a segurança é conhecida; OWE e a
 * transição OWE não contam (o tráfego do celular vai cifrado).
 * @param {object} security  Ap.security
 */
export function isInsecure(security) {
  return securityView(security).insecure;
}

/** Wi-Fi Direct: a flag do beacon, o elemento P2P ou o nome que a norma do Wi-Fi Direct impõe. */
function isP2p(ap) {
  return (
    (isObj(ap.security) && ap.security.p2p === true) ||
    (isObj(ap.ie) && ap.ie.p2p === true) ||
    (typeof ap.ssid === 'string' && ap.ssid.startsWith('DIRECT-'))
  );
}

/** Estimativa do enlace entre o AP e o celular (veja estimateLink em phy.js). */
function linkFor(ap, rssi, client, sec) {
  if (!isNum(rssi) || ap.band === null || !client.supports(ap.band)) return null;
  let apGen = isNum(ap.gen) ? ap.gen : undefined;
  if (sec.legacyCipher) apGen = ap.band === '5' ? 2 : 3;
  return estimateLink({
    rssi,
    band: ap.band,
    widthMHz: ap.widthMHz,
    apGen,
    apNss: isNum(ap.nss) ? ap.nss : undefined,
    clientGen: client.gen ?? undefined,
    clientNss: client.nss,
    clientMaxWidthMHz: client.maxWidthMHz[ap.band],
  });
}

/** Fração do tempo de ar que sobraria para o celular neste AP (item 2 do modelo). */
function airtimeFor(ap, widthMHz, ctx) {
  const deviceId = ap.id ? ctx.deviceOf.get(ap.id) : undefined;
  const mates = (deviceId !== undefined && ctx.radios.get(`${deviceId}|${ap.freq}`)) || [ap];

  // Carga do próprio rádio: todas as redes dele (principal, convidados...) dividem o mesmo transmissor
  let stations = null;
  let utilization = null;
  for (const mate of mates) {
    if (isNum(mate.stations)) stations = (stations ?? 0) + Math.max(0, mate.stations);
    if (isNum(mate.utilization)) utilization = Math.max(utilization ?? 0, clamp(mate.utilization, 0, 1));
  }
  const here = ctx.connected;
  const onThisRadio = here !== null && mates.some((m) => m.id === here.id);
  const onThisChannel = here !== null && ap.channel !== null && here.band === ap.band && here.channel === ap.channel;
  // O celular já conectado é um dos aparelhos contados: ele não disputa consigo mesmo
  const rivals = stations === null ? null : Math.max(0, stations - (onThisRadio ? 1 : 0));
  const base = rivals === null ? DEFAULT_DUTY : IDLE_DUTY + DUTY_PER_STATION * rivals;
  const ownDuty = Math.min(MAX_DUTY, base + EXTRA_NETWORK_DUTY * (mates.length - 1));

  // Vizinhos: a nota do canal do AP sem contar ele mesmo. nota = (1 − tempo dos vizinhos) · (1 − ruído)
  // (rateOwnChannel avalia só o canal do AP e reaproveita o agrupamento por aparelho do contexto:
  // esta conta roda para cada AP da lista)
  const current = rateOwnChannel(ctx.list, { own: ap, widthMHz: widthMHz ?? undefined, devices: ctx.devices });
  let neighboursLeft = 1;
  let noiseLeft = 1;
  if (current !== null && isNum(current.score) && isNum(current.airtime)) {
    neighboursLeft = clamp(1 - current.airtime, 0, 1);
    noiseLeft = neighboursLeft > 0 ? clamp(current.score / 100 / neighboursLeft, 0, 1) : 0;
  }

  const modelled = 1 - neighboursLeft * (1 - ownDuty);
  const measured = utilization !== null && !onThisChannel ? utilization : null;
  const busy = Math.max(modelled, measured ?? 0);
  return {
    share: clamp((1 - busy) * noiseLeft, MIN_AIRTIME_SHARE, 1),
    busy,
    measuredUsed: measured !== null && measured > modelled,
    // quanto cada causa tira, para a frase apontar a principal
    ownLoss: ownDuty,
    neighbourLoss: 1 - neighboursLeft,
    noiseLoss: 1 - noiseLeft,
    stations,
    rivals,
    utilization,
    channelScore: current === null ? null : current.score,
    coChannel: current === null ? null : current.coChannel,
    overlapping: current === null ? null : current.overlapping,
  };
}

// ---------------------------------------------------------------------------
// scoreAp
// ---------------------------------------------------------------------------

function emptyAirtime() {
  return {
    share: null,
    busy: null,
    measuredUsed: false,
    ownLoss: 0,
    neighbourLoss: 0,
    noiseLoss: 0,
    stations: null,
    rivals: null,
    utilization: null,
    channelScore: null,
    coChannel: null,
    overlapping: null,
  };
}

/** A frase sobre o canal: livre, ou a causa que mais tira tempo de ar. */
function channelRemark(air) {
  if (air.share === null) return null;
  if (air.share >= FREE_SHARE) return { pro: 'Canal livre' };
  if (air.share >= BUSY_SHARE) return null;
  if (air.measuredUsed && air.utilization >= BUSY_UTILIZATION) return { con: `Canal ocupado ${Math.round(air.utilization * 100)}% do tempo` };
  const worst = Math.max(air.ownLoss, air.neighbourLoss, air.noiseLoss);
  if (worst === air.ownLoss && air.rivals !== null && air.rivals > 0) {
    return { con: `${air.rivals} ${air.rivals === 1 ? 'aparelho disputa' : 'aparelhos disputam'} este ponto de acesso` };
  }
  if (worst === air.neighbourLoss && air.coChannel > 0) {
    return { con: `Divide o canal com ${air.coChannel} ${air.coChannel === 1 ? 'rede' : 'redes'}` };
  }
  if (air.overlapping > 0) return { con: 'Interferência de redes em canais vizinhos' };
  return { con: 'Canal disputado' };
}

/**
 * Nota de um ponto de acesso para este celular, aqui e agora.
 *
 * @param {import('./model.js').Ap} ap  o BSSID avaliado (Ap normalizado ou ScanAp cru)
 * @param {{aps?: import('./model.js').Ap[], device?: import('../bridge.js').DeviceInfo,
 *          connectionBssid?: string, context?: object}} [options]
 *        aps = todos os APs ouvidos (para a disputa pelo canal); device = o celular (sem ele:
 *        um celular comum de 2 fluxos); connectionBssid = onde o celular está conectado, para a
 *        carga que ele mesmo gera não contar contra a rede; context = scoringContext(aps, ...)
 *        já pronto (aí `aps`, `device` e `connectionBssid` são ignorados)
 * @returns {{
 *   score: number,            0..100, uma casa decimal
 *   estMbps: number|null,     velocidade real esperada aqui, agora (0 = o celular não usa esta
 *                             faixa; null = não deu para estimar)
 *   parts: {signal: number, speed: number, congestion: number, security: number},  cada uma 0..100:
 *                             sinal (qualidade), speed (nota da velocidade com o canal livre),
 *                             congestion (% do tempo de ar que sobra), security (nível)
 *   pros: string[], cons: string[], warnings: string[],
 *   detail: {usable: boolean, rssi: number|null, linkMbps: number|null, phyMbps: number|null,
 *            widthMHz: number|null, txWidthMHz: number|null, gen: number|null, nss: number|null, mcs: number|null,
 *            unstable: boolean, share: number|null, busy: number|null, channelScore: number|null,
 *            coChannel: number|null, overlapping: number|null, stations: number|null,
 *            utilization: number|null, cap: number, securityFactor: number}
 * }}  `detail` são os números por trás da nota (usable = o celular consegue usar esta rede;
 *     widthMHz = largura negociada; txWidthMHz = a largura em que a taxa estimada sai, à qual
 *     `mcs` se refere: veja estimateLink)
 */
export function scoreAp(ap, options) {
  const o = isObj(options) ? options : {};
  const subject = asAp(isObj(ap) ? ap : {});
  let ctx;
  try {
    ctx = contextFor(subject, o);
  } catch {
    ctx = makeContext([subject], {});
  }

  const rssi = isNum(subject.rssiSmooth) ? subject.rssiSmooth : subject.rssi;
  const level = signalLevel(rssi);
  const sec = securityView(subject.security);
  const supported = subject.band === null || ctx.client.supports(subject.band);
  const p2p = isP2p(subject) || (isObj(subject.security) && subject.security.adhoc === true);

  let link = null;
  let air = emptyAirtime();
  try {
    link = linkFor(subject, rssi, ctx.client, sec);
    if (link !== null && isNum(link.phyMbps)) air = airtimeFor(subject, link.widthMHz, ctx);
  } catch {
    // dado fora do formato: fica sem estimativa
  }

  const phyMbps = link !== null && isNum(link.phyMbps) ? link.phyMbps : null;
  const linkMbps = phyMbps === null ? null : usableMbps(phyMbps);
  let estMbps = null;
  if (!supported) estMbps = 0;
  else if (linkMbps !== null && air.share !== null) estMbps = round1(linkMbps * air.share);

  const cap = signalCap(rssi);
  let securityFactor = 1;
  if (sec.insecure) securityFactor = INSECURE_FACTOR;
  else if (sec.weak) securityFactor = WEAK_SECURITY_FACTOR;
  if (p2p) securityFactor *= NOT_A_NETWORK_FACTOR;

  let score = 0;
  if (supported && estMbps !== null && estMbps > 0) {
    score = Math.min(speedScore(estMbps), cap) * securityFactor;
    // o bônus não fura o teto do sinal: WPA3 não salva uma rede que não chega
    if (sec.wpa3 && !sec.insecure) score = Math.min(score + WPA3_BONUS, cap);
    score = round1(clamp(score, 0, 100));
  }

  const parts = {
    signal: qualityPct(rssi),
    speed: Math.round(speedScore(linkMbps)),
    congestion: air.share === null ? 0 : Math.round(air.share * 100),
    security: sec.part,
  };

  // --- em palavras
  const pros = [];
  const cons = [];
  const warnings = [];
  const bandName = BAND_NAME[subject.band] || 'esta faixa';

  if (!supported) {
    cons.push(`Seu celular não funciona em ${bandName}`);
    warnings.push(`Este celular não alcança a faixa de ${bandName}: não dá para usar esta rede nele.`);
  } else {
    if (level.key === 'excellent' || level.key === 'great' || level.key === 'good') pros.push(`Sinal ${level.label.toLowerCase()} aqui`);
    else if (level.key === 'weak' || level.key === 'very-weak') cons.push(`Sinal ${level.label.toLowerCase()} aqui`);

    if (estMbps !== null && estMbps > 0) {
      if (estMbps >= FAST_MBPS) pros.push(`Muito rápida: cerca de ${formatSpeed(estMbps)}`);
      else if (estMbps >= SPEED_GOOD_MBPS) pros.push(`Velocidade boa: cerca de ${formatSpeed(estMbps)}`);
      else if (estMbps < SLOW_MBPS) cons.push(`Lenta aqui: cerca de ${formatSpeed(estMbps)}`);
    }

    const remark = channelRemark(air);
    if (remark && remark.pro) pros.push(remark.pro);
    if (remark && remark.con) cons.push(remark.con);
    if (air.rivals !== null && air.rivals >= MANY_STATIONS && !(remark && remark.con && remark.con.includes('aparelhos'))) {
      cons.push(`${air.rivals} aparelhos conectados neste ponto de acesso`);
    }
    if (sec.legacyCipher) cons.push('Criptografia antiga limita a velocidade a 54 Mb/s');
    if (isNum(subject.gen) && subject.gen >= 6 && subject.genSource !== 'inferred' && typeof subject.standard === 'string') {
      pros.push(`Roteador moderno (${subject.standard})`);
    }
  }

  if (sec.open) cons.push('Aberta: sem senha nem criptografia');
  else if (sec.wep) cons.push('Segurança quebrada (WEP)');
  else if (sec.weak) cons.push('Segurança antiga (WPA/TKIP)');
  else if (sec.level === 4) pros.push(`Segurança forte (${sec.label})`);
  if (subject.hidden) cons.push('Rede oculta: só entra quem sabe o nome');

  for (const issue of sec.issues) {
    if (issue.severity === 'high' && typeof issue.text === 'string') warnings.push(issue.text);
  }
  if (p2p) warnings.push('É a conexão direta de um aparelho (impressora, TV...), não uma rede com internet.');
  if (supported && isNum(rssi) && (rssi < WEAK_SIGNAL_DBM || (link !== null && link.unstable))) {
    warnings.push('Sinal no limite: a conexão pode cair a qualquer momento.');
  }
  if (supported && estMbps === null) warnings.push('Não deu para estimar a velocidade desta rede.');
  if (isNum(subject.ageMs) && subject.ageMs > OLD_READING_MS) {
    warnings.push('Não foi ouvida nas últimas buscas: a leitura pode estar desatualizada.');
  }

  return {
    score,
    estMbps,
    parts,
    pros,
    cons,
    warnings,
    detail: {
      usable: supported && estMbps !== null && estMbps > 0,
      rssi: isNum(rssi) ? rssi : null,
      linkMbps,
      phyMbps,
      widthMHz: link ? link.widthMHz : null,
      txWidthMHz: link ? link.txWidthMHz : null,
      gen: link ? link.gen : null,
      nss: link ? link.nss : null,
      mcs: link ? link.mcs : null,
      unstable: !!(link && link.unstable),
      share: air.share === null ? null : Math.round(air.share * 1000) / 1000,
      busy: air.busy === null ? null : Math.round(air.busy * 1000) / 1000,
      channelScore: air.channelScore,
      coChannel: air.coChannel,
      overlapping: air.overlapping,
      stations: air.stations,
      utilization: air.utilization,
      cap: round1(cap),
      securityFactor,
    },
  };
}

// ---------------------------------------------------------------------------
// rankNetworks
// ---------------------------------------------------------------------------

function toSet(list) {
  const out = new Set();
  if (list == null || typeof list === 'string' || typeof list[Symbol.iterator] !== 'function') {
    if (typeof list === 'string' && list !== '') out.add(list);
    return out;
  }
  for (const item of list) if (typeof item === 'string' && item !== '') out.add(item);
  return out;
}

const rssiOf = (ap) => (isNum(ap.rssiSmooth) ? ap.rssiSmooth : isNum(ap.rssi) ? ap.rssi : -Infinity);
const byBest = (a, b) =>
  b.score - a.score ||
  (b.estMbps ?? -1) - (a.estMbps ?? -1) ||
  rssiOf(b.ap) - rssiOf(a.ap) ||
  (a.ap.id < b.ap.id ? -1 : a.ap.id > b.ap.id ? 1 : 0);

/**
 * As redes ao alcance, da melhor para a pior. Uma linha por rede (nome + família de segurança,
 * como em groupBySsid; cada BSSID oculto é uma rede), representada pelo seu melhor BSSID.
 *
 * @param {import('./model.js').Ap[]} aps
 * @param {{device?: import('../bridge.js').DeviceInfo, connectionBssid?: string,
 *          favorites?: Iterable<string>}} [options]  favorites = SSIDs que a pessoa marcou como seus
 * @returns {{
 *   key: string, ssid: string, name: string, hidden: boolean,
 *   security: object,          Security do melhor BSSID
 *   best: import('./model.js').Ap,   o BSSID de maior nota
 *   score: number, estMbps: number|null, parts: object, pros: string[], cons: string[],
 *   warnings: string[], detail: object,   os de scoreAp(best)
 *   connected: boolean,        o celular está em algum BSSID desta rede
 *   favorite: boolean,
 *   others: {ap: object, score: number, estMbps: number|null, deviceId: string|null}[],  os outros
 *                              BSSIDs da rede, do melhor para o pior
 *   deviceId: string|null,     aparelho físico (groupByDevice) do melhor BSSID
 *   current: {ap, score, estMbps, deviceId}|null,   o BSSID em que o celular está, se for desta rede
 *   bands: string[], mesh: boolean, p2p: boolean
 * }[]}
 */
export function rankNetworks(aps, options) {
  const o = isObj(options) ? options : {};
  const favorites = toSet(o.favorites);
  const connectedId = normalizeBssid(o.connectionBssid);
  let ctx;
  let networks;
  try {
    ctx = scoringContext(aps, { device: o.device, connectionBssid: connectedId });
    networks = groupBySsid(ctx.list, { devices: ctx.devices });
  } catch {
    return [];
  }

  const rows = [];
  for (const net of networks) {
    const entries = net.aps.map((ap) => {
      const result = scoreAp(ap, { context: ctx });
      return { ap, score: result.score, estMbps: result.estMbps, deviceId: (ap.id && ctx.deviceOf.get(ap.id)) || null, result };
    });
    if (!entries.length) continue;
    entries.sort(byBest);
    const strip = (e) => ({ ap: e.ap, score: e.score, estMbps: e.estMbps, deviceId: e.deviceId });
    const top = entries[0];
    const current = connectedId ? entries.find((e) => e.ap.id === connectedId) : undefined;
    rows.push({
      key: net.key,
      ssid: net.ssid,
      name: net.name,
      hidden: net.hidden,
      security: top.ap.security,
      best: top.ap,
      score: top.score,
      estMbps: top.estMbps,
      parts: top.result.parts,
      pros: top.result.pros,
      cons: top.result.cons,
      warnings: top.result.warnings,
      detail: top.result.detail,
      connected: current !== undefined,
      favorite: !net.hidden && favorites.has(net.ssid),
      others: entries.slice(1).map(strip),
      deviceId: top.deviceId,
      current: current ? strip(current) : null,
      bands: net.bands,
      mesh: net.mesh,
      p2p: isP2p(top.ap),
    });
  }
  return rows.sort(
    (a, b) =>
      b.score - a.score ||
      (b.estMbps ?? -1) - (a.estMbps ?? -1) ||
      rssiOf(b.best) - rssiOf(a.best) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------
// advise
// ---------------------------------------------------------------------------

const isRow = (row) => isObj(row) && isObj(row.best) && typeof row.key === 'string';

function entriesOf(row) {
  const first = { ap: row.best, score: row.score, estMbps: row.estMbps, deviceId: row.deviceId ?? null };
  const rest = Array.isArray(row.others) ? row.others.filter((e) => isObj(e) && isObj(e.ap)) : [];
  return [first, ...rest];
}

function targetOf(row, entry) {
  return {
    key: row.key,
    ssid: typeof row.ssid === 'string' ? row.ssid : '',
    name: typeof row.name === 'string' ? row.name : '',
    hidden: row.hidden === true,
    bssid: typeof entry.ap.id === 'string' ? entry.ap.id : '',
    band: entry.ap.band ?? null,
    channel: entry.ap.channel ?? null,
    rssi: isNum(entry.ap.rssi) ? entry.ap.rssi : null,
    score: isNum(entry.score) ? entry.score : 0,
    estMbps: isNum(entry.estMbps) ? entry.estMbps : null,
    favorite: row.favorite === true,
    security: isObj(row.security) && typeof row.security.label === 'string' ? row.security.label : null,
  };
}

const usable = (entry) => isNum(entry.score) && entry.score > 0 && isNum(entry.estMbps) && entry.estMbps > 0;
const inBand = (ap) => (BAND_NAME[ap.band] ? ` em ${BAND_NAME[ap.band]}` : '');
const about = (entry) => (isNum(entry.estMbps) && entry.estMbps > 0 ? `cerca de ${formatSpeed(entry.estMbps)}` : null);

function gainOf(target, current) {
  if (!isNum(target.estMbps) || !isNum(current.estMbps) || current.estMbps <= 0) return null;
  return Math.round((target.estMbps / current.estMbps) * 10) / 10;
}

/**
 * Ganho em palavras: 2.34 -> "cerca de 2,3x mais"; razões enormes viram "pelo menos 10x mais"
 * (ninguém precisa ler "206x").
 * @param {number} gain
 */
export function timesMore(gain) {
  return gain >= GAIN_SAY_AT_MOST ? `pelo menos ${GAIN_SAY_AT_MOST}x mais` : `cerca de ${formatGain(gain)} mais`;
}

/** "deve render cerca de 2,3x mais aqui", ou o motivo que sobrar quando a velocidade não explica. */
function whyBetter(gain, targetRow, currentRow) {
  if (gain !== null && gain >= GAIN_WORTH_SAYING) return `deve render ${timesMore(gain)} aqui`;
  if (isInsecure(currentRow.security) && !isInsecure(targetRow.security)) return 'é protegida por senha e criptografia, ao contrário da rede em uso';
  return 'deve funcionar melhor aqui';
}

function adviseDisconnected(rows, isFav) {
  const base = { kind: 'no-connection', target: null, current: null, gain: null, alternative: null };
  const options = rows
    .filter((row) => !row.hidden && row.p2p !== true && !isP2p(row.best) && usable(entriesOf(row)[0]))
    .map((row) => ({ row, entry: entriesOf(row)[0], mine: isFav(row), safe: !isInsecure(row.security) }));
  // Rede protegida sempre na frente de aberta/WEP; depois a nota
  const order = (a, b) => Number(b.safe) - Number(a.safe) || b.entry.score - a.entry.score;
  const mine = options.filter((x) => x.mine).sort(order);
  const pool = mine.length ? mine : options.slice().sort(order);
  const pick = pool[0];

  if (!pick) {
    return {
      ...base,
      headline: 'Você não está conectado ao Wi-Fi',
      text: rows.length ? 'Nenhuma das redes ao alcance parece utilizável daqui.' : 'Nenhuma rede Wi-Fi ao alcance agora.',
    };
  }
  const target = targetOf(pick.row, pick.entry);
  const name = quoted(pick.row);
  const speed = `${about(pick.entry)}${inBand(pick.entry.ap)}`;
  const unsafe = pick.safe ? '' : ' Ela não tem criptografia de verdade: evite bancos e compras enquanto estiver nela.';
  if (pick.mine) {
    return {
      ...base,
      target,
      headline: `Conecte-se à rede ${name}`,
      text: `Você não está conectado ao Wi-Fi. Das suas redes, ${name} é a melhor aqui: ${speed}.${unsafe}`,
    };
  }
  if (!pick.safe) {
    return {
      ...base,
      target,
      headline: 'Você não está conectado ao Wi-Fi',
      text: `Só há redes abertas ou com segurança quebrada ao alcance. ${name} é a que mais deve render (${speed}), mas sem proteção: evite bancos e compras nela.`,
    };
  }
  return {
    ...base,
    target,
    headline: 'Você não está conectado ao Wi-Fi',
    text: `A rede que mais deve render aqui é ${name} (${speed}). Se você tiver a senha, é a melhor escolha.`,
  };
}

/**
 * O conselho em uma frase: ficar, trocar de faixa, de ponto de acesso ou de rede.
 *
 * Regras: só manda trocar para o que é da pessoa (a rede em uso, as redes de `favorites` e a
 * outra faixa do mesmo roteador quando o nome é o mesmo fora a marca "_5G"); rede de terceiros
 * só aparece como "se você tiver a senha"; rede aberta ou WEP nunca é indicada no lugar de uma
 * protegida; rede oculta e Wi-Fi Direct nunca são indicados.
 *
 * @param {ReturnType<typeof rankNetworks>} ranking
 * @param {{connectionBssid?: string, favorites?: Iterable<string>}} [options]
 * @returns {{
 *   headline: string, text: string,
 *   kind: 'ok'|'switch-band'|'switch-ap'|'switch-network'|'no-connection',
 *   target: {key, ssid, name, hidden, bssid, band, channel, rssi, score, estMbps, favorite, security}|null,
 *                            para onde ir (null em 'ok' e quando não há o que indicar)
 *   current: object|null,    onde o celular está (mesmo formato de target)
 *   gain: number|null,       velocidade do destino ÷ velocidade atual (ex.: 2.3)
 *   alternative: object|null rede de terceiros bem melhor, citada com "se você tiver a senha" (só em 'ok')
 * }}
 */
export function advise(ranking, options) {
  const rows = (Array.isArray(ranking) ? ranking : []).filter(isRow);
  const o = isObj(options) ? options : {};
  const favorites = toSet(o.favorites);
  const connectedId = normalizeBssid(o.connectionBssid);
  const isFav = (row) => row.hidden !== true && (row.favorite === true || favorites.has(row.ssid));

  if (!connectedId) return adviseDisconnected(rows, isFav);

  let currentRow = null;
  let current = null;
  for (const row of rows) {
    const hit = entriesOf(row).find((e) => e.ap.id === connectedId);
    if (hit) {
      currentRow = row;
      current = hit;
      break;
    }
  }
  if (current === null) {
    return {
      kind: 'ok',
      headline: 'Sem dados para comparar',
      text: 'Você está conectado, mas a rede em uso não apareceu na última busca. Faça uma nova busca para eu comparar com as outras.',
      target: null,
      current: null,
      gain: null,
      alternative: null,
    };
  }

  const here = targetOf(currentRow, current);
  const currentUnsafe = isInsecure(currentRow.security);
  const stem = ssidStem(currentRow.ssid);
  const sameBox = (e) => current.deviceId != null && e.deviceId === current.deviceId;
  const currentScore = isNum(current.score) ? current.score : 0;

  const candidates = [];
  for (const row of rows) {
    const sameNetwork = row === currentRow;
    if (!sameNetwork && (row.hidden === true || row.p2p === true || isP2p(row.best))) continue;
    if (isInsecure(row.security) && !currentUnsafe) continue;
    for (const entry of entriesOf(row)) {
      if (entry.ap.id === connectedId || !usable(entry)) continue;
      const twin = sameBox(entry) && stem !== null && ssidStem(row.ssid) === stem;
      candidates.push({
        row,
        entry,
        sameNetwork,
        sameBox: sameBox(entry),
        twin,
        mine: sameNetwork || isFav(row) || twin,
        // quase empate: ficar na mesma rede ou no mesmo roteador dá menos trabalho
        rank: entry.score + (sameNetwork || twin ? SAME_NETWORK_MARGIN : 0),
      });
    }
  }
  candidates.sort((a, b) => b.rank - a.rank || b.entry.score - a.entry.score);

  for (const option of candidates) {
    if (!option.mine) continue;
    const { row, entry } = option;
    if (entry.score - currentScore < SWITCH_MIN_POINTS) continue;
    const otherBand = entry.ap.band !== current.ap.band;
    const otherBox = entry.deviceId != null && current.deviceId != null && entry.deviceId !== current.deviceId;
    const gain = gainOf(entry, current);
    const target = targetOf(row, entry);
    const result = { target, current: here, gain, alternative: null };
    const speed = about(entry);
    const tail = speed ? ` (${speed})` : '';

    if (option.sameNetwork && (otherBox || !otherBand)) {
      // Outro ponto de acesso da mesma rede: só vale se for bem mais forte, porque quem escolhe
      // é o celular, e ele escolhe pelo sinal
      const gap = rssiOf(entry.ap) - rssiOf(current.ap);
      if (!(gap >= ROAM_MIN_DB)) continue;
      const where = otherBand ? `${inBand(entry.ap)}` : '';
      return {
        ...result,
        kind: 'switch-ap',
        headline: 'Há um ponto de acesso mais forte da sua rede',
        text:
          `O celular continua preso a um ponto de acesso distante (${formatDbm(rssiOf(current.ap))}), mas outro da mesma rede chega com ` +
          `${formatDbm(rssiOf(entry.ap))}${where} e ${whyBetter(gain, row, currentRow)}${tail}. Desligue e ligue o Wi-Fi do celular para ele trocar.`,
      };
    }
    if (option.sameNetwork) {
      const whose = option.sameBox ? 'do mesmo roteador' : 'da mesma rede';
      return {
        ...result,
        kind: 'switch-band',
        headline: `Prefira a faixa de ${BAND_NAME[entry.ap.band] || 'outra faixa'}`,
        text:
          `Você está em ${BAND_NAME[current.ap.band] || 'outra faixa'}. A rede de ${BAND_NAME[entry.ap.band] || 'outra faixa'} ${whose} ` +
          `${whyBetter(gain, row, currentRow)}${tail}. O nome é o mesmo, então quem escolhe a faixa é o celular: desligue e ligue o Wi-Fi para ele escolher de novo.`,
      };
    }
    if (option.twin && otherBand) {
      // "Casa" e "Casa_5G": nomes diferentes para as duas faixas da mesma caixa
      return {
        ...result,
        kind: 'switch-band',
        headline: `Troque para a rede ${quoted(row)}`,
        text:
          `A rede de ${BAND_NAME[entry.ap.band] || 'outra faixa'} do mesmo roteador, ${quoted(row)}, ${whyBetter(gain, row, currentRow)}${tail}. ` +
          'Escolha essa rede nas configurações de Wi-Fi; a senha costuma ser a mesma.',
      };
    }
    const speedWins = gain !== null && gain >= GAIN_WORTH_SAYING;
    const safer = speedWins && currentUnsafe && !isInsecure(row.security) ? ' Além disso, ela é protegida por senha e criptografia, ao contrário da rede em uso.' : '';
    return {
      ...result,
      kind: 'switch-network',
      headline: `A rede ${quoted(row)} está melhor aqui`,
      text:
        `Das suas redes, ${quoted(row)}${inBand(entry.ap)} ${whyBetter(gain, row, currentRow)}${tail}, ` +
        `em comparação com ${quoted(currentRow)}.${safer} Vale trocar nas configurações de Wi-Fi.`,
    };
  }

  // Fica onde está
  const speed = about(current);
  let text = `${quoted(currentRow)}${inBand(current.ap)} é a melhor das suas opções neste ponto${speed ? `: ${speed}` : ''}.`;
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (rssiOf(current.ap) < WEAK_SIGNAL_DBM) text += ' Mesmo assim o sinal está no limite: chegue mais perto do roteador.';

  let alternative = null;
  const stranger = candidates
    .filter((x) => !x.mine && !isInsecure(x.row.security))
    .sort((a, b) => b.entry.score - a.entry.score)[0];
  if (stranger && currentScore < HINT_BELOW_SCORE && stranger.entry.score - currentScore >= HINT_MIN_POINTS) {
    alternative = targetOf(stranger.row, stranger.entry);
    const gain = gainOf(stranger.entry, current);
    const more = gain !== null && gain >= GAIN_WORTH_SAYING ? ` (${timesMore(gain)})` : '';
    text += ` A rede ${quoted(stranger.row)} parece render mais aqui${more}; se ela for sua e você tiver a senha, vale testar.`;
  }
  return {
    kind: 'ok',
    headline: 'Você já está na melhor opção',
    text,
    target: null,
    current: here,
    gain: null,
    alternative,
  };
}
