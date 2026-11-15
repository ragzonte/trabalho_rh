// Camada física: gerações do Wi-Fi, taxas de dados (calculadas a partir dos parâmetros do
// OFDM, não de tabela copiada) e estimativa da velocidade de um enlace a partir do sinal.
//
// O que oferece:
//   gerações    WIFI_STANDARD, standardInfo ("Wi-Fi 6 (802.11ax)"), phyOfGen, inferGen
//   taxas       dataRate (uma combinação), maxRate (a "de caixa"), mcsName, MIN_SNR_DB
//   enlace      estimateLink (taxa física que o sinal sustenta), usableMbps (o que sobra dela
//               num download de verdade), MAC_EFFICIENCY
//
// Tudo função pura; entrada inválida vira null, nunca exceção. As taxas saem em Mbps (número);
// quem escreve para a pessoa é formatSpeed (best-network.js), que usa "Mb/s".

import { bandOf } from './channels.js';
import { noiseFloorDbm } from './signal.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const round1 = (x) => Math.round(x * 10) / 10;
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Aceita a faixa ('2.4', '5', '6', '60') ou uma frequência em MHz. */
function bandKey(band) {
  if (isNum(band) && band > 100) return bandOf(band);
  const s = band == null ? '' : String(band);
  return s === '2.4' || s === '5' || s === '6' || s === '60' ? s : null;
}

// ---------------------------------------------------------------------------
// Gerações
// ---------------------------------------------------------------------------

/** ScanResult.WIFI_STANDARD_* do Android. Repare: 7 é o 802.11ad (60 GHz) e 8 é o Wi-Fi 7. */
export const WIFI_STANDARD = Object.freeze({ UNKNOWN: 0, LEGACY: 1, N: 4, AC: 5, AX: 6, AD: 7, BE: 8 });

/**
 * Descreve um padrão a partir do inteiro WIFI_STANDARD_* do Android.
 * `gen` é o número da geração (4 = 11n, 5 = 11ac, 6 = 11ax, 7 = 11be); redes antigas ficam
 * com 2 (11a, em 5 GHz) ou 3 (11b/g); 802.11ad e padrão desconhecido ficam com null.
 * 802.11ax nos 6 GHz vira "Wi-Fi 6E" (a geração continua 6).
 * @param {number} wifiStandard
 * @param {'2.4'|'5'|'6'|'60'|number} [band] faixa ou frequência em MHz
 * @returns {{gen:number|null, short:string, ieee:string|null, label:string,
 *            phy:'legacy'|'ht'|'vht'|'he'|'eht'|'dmg'|null}}
 */
export function standardInfo(wifiStandard, band) {
  const b = bandKey(band);
  const make = (gen, short, ieee, phy) => ({ gen, short, ieee, label: `${short} (${ieee})`, phy });
  const code = typeof wifiStandard === 'string' && wifiStandard.trim() !== '' ? Number(wifiStandard) : wifiStandard;
  switch (code) {
    case WIFI_STANDARD.LEGACY:
      if (b === '5') return make(2, 'Wi-Fi antigo', '802.11a', 'legacy');
      if (b === '2.4') return make(3, 'Wi-Fi antigo', '802.11b/g', 'legacy');
      return make(3, 'Wi-Fi antigo', '802.11a/b/g', 'legacy');
    case WIFI_STANDARD.N:
      return make(4, 'Wi-Fi 4', '802.11n', 'ht');
    case WIFI_STANDARD.AC:
      return make(5, 'Wi-Fi 5', '802.11ac', 'vht');
    case WIFI_STANDARD.AX:
      return make(6, b === '6' ? 'Wi-Fi 6E' : 'Wi-Fi 6', '802.11ax', 'he');
    case WIFI_STANDARD.AD:
      return make(null, 'WiGig', '802.11ad', 'dmg');
    case WIFI_STANDARD.BE:
      return make(7, 'Wi-Fi 7', '802.11be', 'eht');
    default:
      return { gen: null, short: 'Wi-Fi', ieee: null, label: 'Wi-Fi (padrão não informado)', phy: null };
  }
}

/**
 * Nome da camada física de uma geração: 4 -> 'ht', 5 -> 'vht', 6 -> 'he', 7 (ou mais) -> 'eht',
 * 1..3 -> 'legacy'. null se desconhecida.
 * @param {number} gen
 */
export function phyOfGen(gen) {
  if (!isNum(gen) || gen < 1) return null;
  if (gen < 4) return 'legacy';
  if (gen < 5) return 'ht';
  if (gen < 6) return 'vht';
  if (gen < 7) return 'he';
  return 'eht';
}

/**
 * Geração mínima que explica o que se vê de um AP, para quando o Android não informa o padrão
 * (antes do Android 11): 320 MHz só existe no Wi-Fi 7; 6 GHz, do Wi-Fi 6E em diante; 80/160 MHz,
 * do Wi-Fi 5 em diante. No resto supõe Wi-Fi 4: redes só a/b/g praticamente não existem mais.
 * @param {{band?:string|number, widthMHz?:number}} [ap]
 * @returns {4|5|6|7}
 */
export function inferGen(ap) {
  const o = ap !== null && typeof ap === 'object' ? ap : {};
  const width = isNum(o.widthMHz) ? o.widthMHz : 20;
  if (width >= 320) return 7;
  if (bandKey(o.band) === '6') return 6;
  if (width >= 80) return 5;
  return 4;
}

// ---------------------------------------------------------------------------
// Taxa de dados
// ---------------------------------------------------------------------------

// Modulação e taxa de código de cada MCS (por fluxo espacial).
const MCS = [
  { bits: 1, num: 1, den: 2, name: 'BPSK 1/2' },
  { bits: 2, num: 1, den: 2, name: 'QPSK 1/2' },
  { bits: 2, num: 3, den: 4, name: 'QPSK 3/4' },
  { bits: 4, num: 1, den: 2, name: '16-QAM 1/2' },
  { bits: 4, num: 3, den: 4, name: '16-QAM 3/4' },
  { bits: 6, num: 2, den: 3, name: '64-QAM 2/3' },
  { bits: 6, num: 3, den: 4, name: '64-QAM 3/4' },
  { bits: 6, num: 5, den: 6, name: '64-QAM 5/6' },
  { bits: 8, num: 3, den: 4, name: '256-QAM 3/4' },
  { bits: 8, num: 5, den: 6, name: '256-QAM 5/6' },
  { bits: 10, num: 3, den: 4, name: '1024-QAM 3/4' },
  { bits: 10, num: 5, den: 6, name: '1024-QAM 5/6' },
  { bits: 12, num: 3, den: 4, name: '4096-QAM 3/4' },
  { bits: 12, num: 5, den: 6, name: '4096-QAM 5/6' },
].map(Object.freeze);

// nsd = subportadoras de dados por largura; tDftNs = duração útil do símbolo OFDM;
// gi = intervalos de guarda aceitos (o primeiro é o mais curto, usado nas taxas "de caixa").
const PHY = {
  ht: { nsd: { 20: 52, 40: 108 }, tDftNs: 3200, gi: [400, 800], maxMcs: 7, maxNss: 4 },
  vht: { nsd: { 20: 52, 40: 108, 80: 234, 160: 468 }, tDftNs: 3200, gi: [400, 800], maxMcs: 9, maxNss: 8 },
  he: { nsd: { 20: 234, 40: 468, 80: 980, 160: 1960 }, tDftNs: 12800, gi: [800, 1600, 3200], maxMcs: 11, maxNss: 8 },
  eht: {
    nsd: { 20: 234, 40: 468, 80: 980, 160: 1960, 320: 3920 },
    tDftNs: 12800,
    gi: [800, 1600, 3200],
    maxMcs: 13,
    maxNss: 8,
  },
};

// Combinações que o 802.11ac exclui (os bits de um símbolo não se dividem por igual entre os
// codificadores): largura -> MCS -> quantidades de fluxos inválidas.
const VHT_INVALID = {
  20: { 9: [1, 2, 4, 5, 7, 8] },
  80: { 6: [3, 7], 9: [6] },
  160: { 9: [3] },
};

/** Nome da modulação de um MCS (0..13), ex.: "256-QAM 5/6". null se não existir. */
export function mcsName(mcs) {
  return Number.isInteger(mcs) && MCS[mcs] ? MCS[mcs].name : null;
}

/**
 * Taxa de dados da camada física, em Mbps (uma casa decimal), calculada como
 *   subportadoras de dados × bits por símbolo × taxa de código × fluxos / (símbolo + guarda).
 *
 * `standard`: 'ht' (11n) | 'vht' (11ac) | 'he' (11ax) | 'eht' (11be).
 * `mcs`: por fluxo, 0..7 (ht), 0..9 (vht), 0..11 (he), 0..13 (eht). Em 'ht' também vale o índice
 *        0..31 do 802.11n, que já embute os fluxos (ex.: 15 = MCS 7 com 2 fluxos).
 * `giNs`: intervalo de guarda em ns. ht/vht: 800 ou 400; he/eht: 800, 1600 ou 3200.
 *        Sem ele, usa o mais curto (400 em ht/vht, 800 em he/eht).
 * Combinação que não existe no padrão devolve null (ex.: vht, 20 MHz, 1 fluxo, MCS 9).
 * @param {{standard:string, widthMHz:number, nss?:number, mcs:number, giNs?:number}} params
 * @returns {number|null}
 */
export function dataRate(params) {
  const o = params !== null && typeof params === 'object' ? params : {};
  const standard = typeof o.standard === 'string' ? o.standard.toLowerCase() : '';
  const phy = has(PHY, standard) ? PHY[standard] : null;
  if (!phy) return null;
  const nsd = isNum(o.widthMHz) && has(phy.nsd, o.widthMHz) ? phy.nsd[o.widthMHz] : null;
  if (!nsd) return null;

  let mcs = o.mcs;
  let nss = o.nss === undefined || o.nss === null ? 1 : o.nss;
  if (standard === 'ht' && Number.isInteger(mcs) && mcs > 7 && mcs <= 31) {
    nss = Math.floor(mcs / 8) + 1;
    mcs %= 8;
  }
  if (!Number.isInteger(mcs) || mcs < 0 || mcs > phy.maxMcs) return null;
  if (!Number.isInteger(nss) || nss < 1 || nss > phy.maxNss) return null;
  if (standard === 'vht' && VHT_INVALID[o.widthMHz]?.[mcs]?.includes(nss)) return null;

  const gi = o.giNs === undefined || o.giNs === null ? phy.gi[0] : o.giNs;
  if (!phy.gi.includes(gi)) return null;

  const m = MCS[mcs];
  const bitsPerSymbol = (nsd * m.bits * m.num * nss) / m.den;
  const symbolUs = (phy.tDftNs + gi) / 1000;
  return round1(bitsPerSymbol / symbolUs); // bits por microssegundo = Mbps
}

/** Maior taxa do 802.11a/g (OFDM, 20 MHz, 1 fluxo). */
const LEGACY_MAX_MBPS = 54;

// Larguras de cada camada física, em ordem crescente (lidas uma vez de PHY).
for (const phy of Object.values(PHY)) phy.widths = Object.keys(phy.nsd).map(Number).sort((a, b) => a - b);

function snapWidth(phy, widthMHz) {
  let best = null;
  for (const w of phy.widths) if (w <= widthMHz) best = w;
  return best;
}

/**
 * Taxa máxima ("de caixa") de uma geração numa largura e número de fluxos: maior MCS válido
 * com o intervalo de guarda mais curto. A largura é limitada ao que a geração (e a faixa, se
 * informada: 40 MHz em 2,4 GHz) permite. Gerações antigas (< 4): 54 Mbps.
 * @param {{gen:number, widthMHz?:number, nss?:number, band?:string|number}} params
 * @returns {number|null} Mbps
 */
export function maxRate(params) {
  const o = params !== null && typeof params === 'object' ? params : {};
  const standard = phyOfGen(o.gen);
  if (!standard) return null;
  if (standard === 'legacy') return LEGACY_MAX_MBPS;
  const phy = PHY[standard];
  let width = isNum(o.widthMHz) ? o.widthMHz : 20;
  if (bandKey(o.band) === '2.4') width = Math.min(width, 40);
  const widthMHz = snapWidth(phy, width);
  if (widthMHz === null) return null;
  const nss = isNum(o.nss) ? Math.min(Math.max(Math.floor(o.nss), 1), phy.maxNss) : 1;
  for (let mcs = phy.maxMcs; mcs >= 0; mcs--) {
    const rate = dataRate({ standard, widthMHz, nss, mcs });
    if (rate !== null) return rate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Estimativa do enlace
// ---------------------------------------------------------------------------

// Sensibilidade mínima que o 802.11 exige do receptor em 20 MHz, por MCS (dBm):
// MCS 0..9 do 11n/11ac, 10..11 do 11ax, 12..13 do 11be.
const MIN_SENSITIVITY_20 = [-82, -79, -77, -74, -70, -66, -65, -64, -59, -57, -54, -52, -49, -46];

// Idem para as taxas do 802.11a/g (6..54 Mbps).
const LEGACY_RATES = [6, 9, 12, 18, 24, 36, 48, 54];
const LEGACY_SENSITIVITY = [-82, -81, -79, -77, -74, -70, -66, -65];

// Como a sensibilidade vira SNR mínimo:
//   1. Os números da norma supõem figura de ruído de 10 dB e 5 dB de perda de implementação
//      sobre o ruído térmico de −101 dBm em 20 MHz. O demodulador precisa, portanto, de
//      SNR = sensibilidade − (−101 + 10 + 5) = sensibilidade + 86 dB (MCS 0: 4 dB; MCS 9: 29 dB).
//   2. Somamos 3 dB de margem para a vida real (desvanecimento, interferência, transmissor que
//      reduz a potência nos MCS altos e controle de taxa conservador).
//      Resultado em dB, MCS 0..13: 7, 10, 12, 15, 19, 23, 24, 25, 30, 32, 35, 37, 40, 43.
//   3. O SNR é medido na largura usada: o ruído sobe 3 dB a cada vez que a largura dobra, então
//      o sinal necessário também sobe 3 dB por dobra. Com o nosso piso de ruído (−94 dBm em
//      20 MHz), MCS 7 pede −69 dBm em 20 MHz e −63 dBm em 80 MHz.
//   4. Largura negociada é teto, não obrigação: num BSS de 80 MHz os quadros também podem sair
//      em 40 ou 20 MHz (sempre incluindo o canal primário), e é o que o controle de taxa faz
//      quando o sinal não sustenta a largura cheia. Vale, portanto, a combinação largura × MCS
//      de maior taxa. Sem isso um AP de 160 MHz pareceria pior (e "instável" antes) que o mesmo
//      AP em 20 MHz com o mesmo sinal.
// Simplificações: o número de fluxos não cai com sinal fraco e o intervalo de guarda é sempre o
// mais curto. As duas puxam para cima; a margem compensa em parte.
const SNR_MARGIN_DB = 3;
const SENSITIVITY_TO_SNR_DB = 101 - 10 - 5 + SNR_MARGIN_DB;

/** SNR mínimo (dB) para sustentar cada MCS (índice 0..13), já com a margem. */
export const MIN_SNR_DB = Object.freeze(MIN_SENSITIVITY_20.map((s) => s + SENSITIVITY_TO_SNR_DB));

const LEGACY_MIN_SNR_DB = LEGACY_SENSITIVITY.map((s) => s + SENSITIVITY_TO_SNR_DB);

function normGen(gen) {
  return isNum(gen) && gen >= 1 ? Math.min(Math.floor(gen), 7) : null;
}

/**
 * Estima o enlace entre um AP e um cliente (o celular) a partir do sinal.
 *
 * Negociação = o mínimo dos dois lados em geração, largura e fluxos. O que não for informado:
 *   apGen -> inferGen({band, widthMHz}) · clientGen -> igual ao AP · apNss e clientNss -> 2
 *   (o comum em roteadores e celulares) · clientMaxWidthMHz -> sem limite.
 * Em 2,4 GHz a largura para em 40 MHz e o 11ac vira 11n (11ac só existe em 5 GHz).
 * `rssi` é o sinal do beacon (dBm); `noiseDbm` é o ruído em 20 MHz (padrão: piso térmico com
 * 7 dB de figura de ruído, −94 dBm) e é corrigido para a largura usada.
 * Em cada largura até a negociada, escolhe o maior MCS cujo SNR mínimo (MIN_SNR_DB) cabe no
 * SNR disponível, e fica com a largura que rende mais (empate: a mais larga). Assim a taxa
 * nunca cai quando o sinal melhora nem quando o canal é mais largo. Se nem o MCS 0 em 20 MHz
 * couber, devolve essa taxa (a mais robusta que existe) com `unstable: true`.
 *
 * @param {{rssi:number, band?:string|number, widthMHz?:number, apGen?:number, apNss?:number,
 *          clientGen?:number, clientNss?:number, clientMaxWidthMHz?:number, noiseDbm?:number}} params
 * @returns {{gen:number|null, standard:string|null, widthMHz:number|null, txWidthMHz:number|null,
 *            nss:number|null, mcs:number|null, phyMbps:number|null, maxPhyMbps:number|null,
 *            snrDb:number|null, unstable:boolean}}
 *          `widthMHz` é a largura negociada (o teto, usado em `maxPhyMbps`); `txWidthMHz` é a
 *          largura em que a taxa estimada sai (menor que a negociada quando o sinal é fraco) e
 *          `mcs` e `snrDb` valem para ela. `mcs` é null em redes antigas (a/g); tudo é null se a
 *          combinação for impossível (ex.: cliente sem Wi-Fi 6 numa rede de 6 GHz) ou o padrão
 *          for desconhecido.
 */
export function estimateLink(params) {
  const o = params !== null && typeof params === 'object' ? params : {};
  const band = bandKey(o.band);
  const apWidth = isNum(o.widthMHz) && o.widthMHz >= 20 ? o.widthMHz : 20;
  const apGen = normGen(o.apGen) ?? inferGen({ band, widthMHz: apWidth });
  const clientGen = normGen(o.clientGen) ?? apGen;

  let gen = Math.min(apGen, clientGen);
  if (band === '2.4' && gen === 5) gen = 4;
  const empty = {
    gen,
    standard: null,
    widthMHz: null,
    txWidthMHz: null,
    nss: null,
    mcs: null,
    phyMbps: null,
    maxPhyMbps: null,
    snrDb: null,
    unstable: false,
  };
  // Nos 6 GHz só existe 11ax em diante; em 60 GHz a camada física é outra (802.11ad/ay)
  if ((band === '6' && gen < 6) || band === '60') return empty;

  const standard = phyOfGen(gen);
  const legacy = standard === 'legacy';
  // (±1000 dBm não é medida de nada: além disso as contas só produziriam números sem sentido)
  const rssi = isNum(o.rssi) && Math.abs(o.rssi) < 1000 ? o.rssi : null;
  const noise20 = isNum(o.noiseDbm) && Math.abs(o.noiseDbm) < 1000 ? o.noiseDbm : noiseFloorDbm(20);

  let widthMHz = 20;
  let nss = 1;
  if (!legacy) {
    const phy = PHY[standard];
    let width = apWidth;
    if (isNum(o.clientMaxWidthMHz) && o.clientMaxWidthMHz >= 20) width = Math.min(width, o.clientMaxWidthMHz);
    if (band === '2.4') width = Math.min(width, 40);
    widthMHz = snapWidth(phy, width);
    const apNss = isNum(o.apNss) && o.apNss >= 1 ? Math.floor(o.apNss) : 2;
    const clientNss = isNum(o.clientNss) && o.clientNss >= 1 ? Math.floor(o.clientNss) : 2;
    nss = Math.min(apNss, clientNss, phy.maxNss);
  }

  const out = {
    ...empty,
    standard,
    widthMHz,
    nss,
    maxPhyMbps: legacy ? LEGACY_MAX_MBPS : maxRate({ gen, widthMHz, nss }),
  };
  if (rssi === null) return out;
  const snrAt = (w) => rssi - (noise20 + 10 * Math.log10(w / 20));

  if (legacy) {
    const snr = snrAt(20);
    let i = LEGACY_RATES.length - 1;
    while (i > 0 && snr < LEGACY_MIN_SNR_DB[i]) i--;
    out.phyMbps = LEGACY_RATES[i];
    out.txWidthMHz = 20;
    out.snrDb = round1(snr);
    out.unstable = snr < LEGACY_MIN_SNR_DB[0];
    return out;
  }

  // Da largura negociada para baixo: em cada uma, o maior MCS que cabe; fica a de maior taxa
  // (a comparação estrita mantém a mais larga nos empates).
  const phy = PHY[standard];
  let best = null;
  let floor = null; // menor MCS válido da menor largura, para quando nada cabe
  for (let k = phy.widths.length - 1; k >= 0; k--) {
    const w = phy.widths[k];
    if (w > widthMHz) continue;
    const snr = snrAt(w);
    for (let mcs = phy.maxMcs; mcs >= 0; mcs--) {
      const rate = dataRate({ standard, widthMHz: w, nss, mcs });
      if (rate === null) continue;
      floor = { mcs, rate, width: w, snr };
      if (snr >= MIN_SNR_DB[mcs]) {
        if (best === null || rate > best.rate) best = floor;
        break;
      }
    }
  }
  const pick = best ?? floor;
  if (pick) {
    out.mcs = pick.mcs;
    out.phyMbps = pick.rate;
    out.txWidthMHz = pick.width;
    out.snrDb = round1(pick.snr);
    out.unstable = best === null;
  }
  return out;
}

// Quanto da taxa física vira dado útil num download TCP. Preâmbulos, intervalos entre quadros,
// confirmações (block ack), disputa pelo canal, retransmissões e os cabeçalhos TCP/IP consomem
// o resto. Com agregação de quadros (11n em diante), medições típicas dão 55% a 65%.
export const MAC_EFFICIENCY = 0.6;

/**
 * Velocidade realista (Mbps, uma casa decimal) que se mede num teste de velocidade com a taxa
 * física dada, com o canal livre. Canal disputado com vizinhos rende menos.
 * @param {number} phyMbps
 * @param {number} [efficiency=0.6]
 * @returns {number|null}
 */
export function usableMbps(phyMbps, efficiency = MAC_EFFICIENCY) {
  if (!isNum(phyMbps) || phyMbps < 0) return null;
  const e = isNum(efficiency) && efficiency > 0 && efficiency <= 1 ? efficiency : MAC_EFFICIENCY;
  const mbps = round1(phyMbps * e);
  return Number.isFinite(mbps) ? mbps : null; // taxa absurda de tão grande: sem resposta
}
