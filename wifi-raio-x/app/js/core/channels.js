// Canais e ocupação do espectro Wi-Fi: faixas, numeração, junção de canais
// (40/80/160/320 MHz), DFS / U-NII / PSC e quanto um transmissor "vaza" para os vizinhos.
//
// Tudo aqui é função pura e nunca lança exceção: dado torto vindo do celular vira
// null / valor conservador.
//
// Referências: numeração de canais do IEEE 802.11 (2,4 GHz: 2407 + 5·canal; 5 GHz:
// 5000 + 5·canal; 6 GHz: 5950 + 5·canal, com o canal 2 em 5935 MHz; 60 GHz:
// 58320 + 2160·(canal − 1)) e a referência do Android para ScanResult
// (channelWidth, centerFreq0, centerFreq1).

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

/** Número finito ou null (aceita texto numérico, porque JSON de celular nem sempre é limpo). */
function toNum(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normBand(band) {
  if (band == null) return null;
  const s = String(band).trim().toLowerCase().replace(',', '.').replace(/\s*ghz$/, '');
  return s === '2.4' || s === '5' || s === '6' || s === '60' ? s : null;
}

function range(from, to, step) {
  const out = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
}

// ---------------------------------------------------------------------------
// Faixas e numeração
// ---------------------------------------------------------------------------

export const BANDS = Object.freeze(['2.4', '5', '6', '60']);

/** Largura de um canal do 802.11ad/ay (60 GHz), em MHz. */
export const WIDTH_60GHZ = 2160;

/**
 * Faixa de uma frequência.
 * @param {number} freqMHz
 * @returns {'2.4'|'5'|'6'|'60'|null}
 */
export function bandOf(freqMHz) {
  const f = toNum(freqMHz);
  if (f === null) return null;
  if (f >= 2400 && f <= 2500) return '2.4';
  if (f >= 5150 && f <= 5895) return '5';
  if (f >= 5925 && f <= 7125) return '6'; // 5935 MHz é o canal 2 dos 6 GHz
  if (f >= 57000 && f <= 71000) return '60';
  return null;
}

/**
 * Número do canal de uma frequência central (vale também para centros de 40/80/160/320 MHz,
 * ex.: 5210 -> 42). null quando a frequência não cai em nenhum canal.
 * @param {number} freqMHz
 * @returns {number|null}
 */
export function freqToChannel(freqMHz) {
  const f = toNum(freqMHz);
  let ch;
  switch (bandOf(f)) {
    case '2.4':
      if (f === 2484) return 14;
      ch = (f - 2407) / 5;
      return Number.isInteger(ch) && ch >= 1 && ch <= 13 ? ch : null;
    case '5':
      ch = (f - 5000) / 5;
      return Number.isInteger(ch) ? ch : null;
    case '6':
      if (f === 5935) return 2;
      ch = (f - 5950) / 5;
      // 5960 daria "2" pela fórmula, mas o canal 2 de verdade fica em 5935
      return Number.isInteger(ch) && ch >= 1 && ch <= 233 && ch !== 2 ? ch : null;
    case '60':
      ch = (f - 58320) / WIDTH_60GHZ + 1;
      return Number.isInteger(ch) && ch >= 1 && ch <= 6 ? ch : null;
    default:
      return null;
  }
}

/**
 * Frequência central (MHz) de um canal. Sem `band`, canais até 14 são tratados como
 * 2,4 GHz e os demais como 5 GHz (os números se repetem nos 6 GHz, então informe a faixa).
 * @param {number} channel
 * @param {'2.4'|'5'|'6'|'60'} [band]
 * @returns {number|null}
 */
export function channelToFreq(channel, band) {
  const ch = toNum(channel);
  if (ch === null || !Number.isInteger(ch)) return null;
  const b = band == null ? (ch <= 14 ? '2.4' : '5') : normBand(band);
  let f;
  switch (b) {
    case '2.4':
      if (ch === 14) return 2484;
      return ch >= 1 && ch <= 13 ? 2407 + 5 * ch : null;
    case '5':
      f = 5000 + 5 * ch;
      return bandOf(f) === '5' ? f : null;
    case '6':
      if (ch === 2) return 5935;
      return ch >= 1 && ch <= 233 ? 5950 + 5 * ch : null;
    case '60':
      return ch >= 1 && ch <= 6 ? 58320 + WIDTH_60GHZ * (ch - 1) : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// DFS, U-NII e PSC
// ---------------------------------------------------------------------------

// Trechos dos 5 GHz divididos com radares: U-NII-2A (canais 52–64) e U-NII-2C (100–144; o 144
// passa 5 MHz do fim do trecho, mas a maior parte dele está dentro).
const DFS_RANGES = [
  [5250, 5350],
  [5470, 5725],
];

function rangeIsDfs(lo, hi) {
  return DFS_RANGES.some(([a, b]) => lo < b && hi > a);
}

/**
 * O canal (ou bloco) centrado em `freqMHz` com `widthMHz` de largura pega algum trecho com DFS?
 * @param {number} freqMHz
 * @param {number} [widthMHz=20]
 */
export function isDfs(freqMHz, widthMHz = 20) {
  const f = toNum(freqMHz);
  const w = toNum(widthMHz);
  if (f === null || w === null || w <= 0 || bandOf(f) !== '5') return false;
  return rangeIsDfs(f - w / 2, f + w / 2);
}

/**
 * Nome da sub-faixa U-NII de um canal de 20 MHz (pela frequência central).
 * Canais "em cima do muro" seguem o costume: 144 = U-NII-2C, 169 = U-NII-4, 185 (6 GHz) = U-NII-7/8.
 * @param {number} freqMHz
 * @returns {string|null}
 */
export function uniiOf(freqMHz) {
  const f = toNum(freqMHz);
  switch (bandOf(f)) {
    case '5':
      if (f < 5250) return 'U-NII-1';
      if (f < 5350) return 'U-NII-2A';
      if (f < 5470) return 'U-NII-2B';
      if (f < 5730) return 'U-NII-2C';
      if (f < 5835) return 'U-NII-3';
      return 'U-NII-4';
    case '6':
      if (f < 6425) return 'U-NII-5';
      if (f < 6525) return 'U-NII-6';
      if (f < 6875) return 'U-NII-7';
      if (f === 6875) return 'U-NII-7/8';
      return 'U-NII-8';
    default:
      return null;
  }
}

/** Canal preferencial de varredura dos 6 GHz (PSC): 5, 21, 37, ..., 229. */
function isPscChannel(ch) {
  return Number.isInteger(ch) && ch >= 5 && ch <= 229 && (ch - 5) % 16 === 0;
}

// ---------------------------------------------------------------------------
// Lista de canais de 20 MHz
// ---------------------------------------------------------------------------

const NOTE_DFS = 'DFS: divide a faixa com radares; o roteador pode demorar a entrar no ar ou mudar de canal sozinho';

function note24(ch) {
  if (ch === 1 || ch === 6 || ch === 11) return 'Um dos três canais que não se sobrepõem (1, 6 e 11)';
  if (ch === 12 || ch === 13) return 'Liberado no Brasil, mas alguns aparelhos importados não enxergam';
  if (ch === 14) return 'Só no Japão e só em 802.11b';
  return null;
}

function note5(ch, dfs) {
  if (ch === 144) return `${NOTE_DFS}. Aparelhos antigos não enxergam o canal 144`;
  if (dfs) return NOTE_DFS;
  if (ch === 165) return 'Na maioria dos roteadores só funciona em 20 MHz';
  if (ch >= 169) return 'U-NII-4 (5,9 GHz): liberado em poucos países e aceito por poucos aparelhos';
  return null;
}

function listEntry(band, channel) {
  const freq = channelToFreq(channel, band);
  const dfs = band === '5' && rangeIsDfs(freq - 10, freq + 10);
  const psc = band === '6' && isPscChannel(channel);
  let note = null;
  if (band === '2.4') note = note24(channel);
  else if (band === '5') note = note5(channel, dfs);
  else if (band === '6' && psc) note = 'PSC: canal que os aparelhos procuram primeiro nos 6 GHz';
  return Object.freeze({ channel, freq, dfs, unii: uniiOf(freq), psc, note });
}

// Sequências contínuas de canais de 20 MHz; a junção (40/80/160) só acontece dentro de cada uma.
const RUNS = {
  '5': [range(36, 64, 4), range(100, 144, 4), range(149, 177, 4)],
  '6': [range(1, 233, 4)],
};

const CHANNELS_20 = {
  '2.4': range(1, 13, 1),
  '5': RUNS['5'].flat(),
  '6': RUNS['6'].flat(),
  '60': range(1, 6, 1),
};

const LISTS = {};
for (const band of BANDS) LISTS[band] = CHANNELS_20[band].map((ch) => listEntry(band, ch));
const CHANNEL_14 = listEntry('2.4', 14);

/**
 * Canais de 20 MHz de uma faixa (60 GHz: os canais de 2,16 GHz).
 *   2,4 GHz: 1..13 (o 14, só do Japão, entra apenas com `{ all: true }`)
 *   5 GHz:   36..64, 100..144, 149..165 e os U-NII-4 169/173/177 (marcados em `unii` e `note`)
 *   6 GHz:   1, 5, ..., 233 (`psc` marca os canais preferenciais de varredura)
 * @param {'2.4'|'5'|'6'|'60'} band
 * @param {{all?: boolean}} [options]
 * @returns {{channel:number, freq:number, dfs:boolean, unii:string|null, psc:boolean, note:string|null}[]}
 */
export function channelList(band, options) {
  const b = normBand(band);
  if (!b) return [];
  const list = LISTS[b].slice();
  if (b === '2.4' && options && options.all) list.push(CHANNEL_14);
  return list;
}

// ---------------------------------------------------------------------------
// Junção de canais (blocos de 20/40/80/160/320 MHz)
// ---------------------------------------------------------------------------

function makeBlock(band, widthMHz, channels) {
  const lo = channelToFreq(channels[0], band) - 10;
  const hi = channelToFreq(channels[channels.length - 1], band) + 10;
  const centerFreq = (lo + hi) / 2;
  const names = [];
  for (const ch of channels) {
    const u = uniiOf(channelToFreq(ch, band));
    if (u && !names.includes(u)) names.push(u);
  }
  return Object.freeze({
    band,
    widthMHz,
    center: freqToChannel(centerFreq),
    centerFreq,
    lo,
    hi,
    channels: Object.freeze(channels.slice()),
    dfs: band === '5' && rangeIsDfs(lo, hi),
    unii: names.length ? names.join(' + ') : null,
  });
}

function bondedBlocks(band, widthMHz) {
  const n = widthMHz / 20;
  const out = [];
  for (const run of RUNS[band]) {
    // 320 MHz (só 6 GHz) tem dois conjuntos que se sobrepõem: 320-1 (31, 95, 159) e 320-2 (63, 127, 191)
    const starts = widthMHz === 320 ? [0, n / 2] : [0];
    for (const start of starts) {
      for (let i = start; i + n <= run.length; i += n) out.push(makeBlock(band, widthMHz, run.slice(i, i + n)));
    }
  }
  return out.sort((a, b) => a.centerFreq - b.centerFreq);
}

const BLOCKS = {
  '2.4': {
    20: CHANNELS_20['2.4'].map((ch) => makeBlock('2.4', 20, [ch])),
    // Em 2,4 GHz o secundário fica 4 canais acima ou abaixo do primário: centros 3..11, que se sobrepõem
    40: range(3, 11, 1).map((c) => makeBlock('2.4', 40, [c - 2, c + 2])),
  },
  '5': {
    20: CHANNELS_20['5'].map((ch) => makeBlock('5', 20, [ch])),
    40: bondedBlocks('5', 40),
    80: bondedBlocks('5', 80),
    160: bondedBlocks('5', 160),
  },
  '6': {
    20: CHANNELS_20['6'].map((ch) => makeBlock('6', 20, [ch])),
    40: bondedBlocks('6', 40),
    80: bondedBlocks('6', 80),
    160: bondedBlocks('6', 160),
    320: bondedBlocks('6', 320),
  },
};

function blocksRef(band, widthMHz) {
  const b = normBand(band);
  const w = toNum(widthMHz);
  return (b && w !== null && BLOCKS[b] && BLOCKS[b][w]) || [];
}

/**
 * Todos os canais possíveis de uma largura numa faixa.
 *   5 GHz: 40 MHz = 38, 46, ...; 80 MHz = 42, 58, 106, 122, 138, 155, 171; 160 MHz = 50, 114, 163
 *   6 GHz: 40 = 3, 11, ...; 80 = 7, 23, ...; 160 = 15, 47, ...; 320 = 31, 63, 95, 127, 159, 191
 *   2,4 GHz: 40 MHz = centros 3..11 (primário + secundário 4 canais ao lado; os blocos se sobrepõem)
 * Combinação que não existe (ex.: 80 MHz em 2,4 GHz) devolve [].
 * @param {'2.4'|'5'|'6'} band
 * @param {20|40|80|160|320} widthMHz
 * @returns {{band:string, widthMHz:number, center:number, centerFreq:number, lo:number, hi:number,
 *            channels:number[], dfs:boolean, unii:string|null}[]}
 *          `channels` = canais de 20 MHz que podem ser o primário; `dfs` = algum trecho exige DFS
 */
export function blocksOf(band, widthMHz) {
  return blocksRef(band, widthMHz).slice();
}

/**
 * Todos os blocos de uma largura que contêm o canal primário. Quase sempre é um só; são dois
 * em 2,4 GHz/40 MHz (primários 5..9: secundário acima ou abaixo) e em 6 GHz/320 MHz (33..189).
 */
export function blocksContaining(band, widthMHz, primaryChannel) {
  const ch = toNum(primaryChannel);
  if (ch === null) return [];
  return blocksRef(band, widthMHz).filter((b) => b.channels.includes(ch));
}

/**
 * O bloco de `widthMHz` que contém o canal primário, ou null. Nos casos ambíguos (veja
 * blocksContaining) devolve o de centro mais baixo.
 */
export function blockContaining(band, widthMHz, primaryChannel) {
  return blocksContaining(band, widthMHz, primaryChannel)[0] || null;
}

// ---------------------------------------------------------------------------
// Ocupação: que pedaço do espectro um AP usa
// ---------------------------------------------------------------------------

/**
 * ScanResult.CHANNEL_WIDTH_* -> MHz totais. 80+80 (4) soma 160. Desconhecido -> 20.
 * @param {number} channelWidth
 * @returns {20|40|80|160|320}
 */
export function androidWidthToMHz(channelWidth) {
  switch (toNum(channelWidth)) {
    case 1:
      return 40;
    case 2:
      return 80;
    case 3:
    case 4:
      return 160;
    case 5:
      return 320;
    default:
      return 20;
  }
}

/** `c` serve de centro de um canal de `width` MHz cujo primário de 20 MHz é `f`? */
function isPlausibleCenter(c, f, width) {
  const first = c - width / 2 + 10; // centro do 20 MHz mais baixo do bloco
  return Math.abs(c - f) <= width / 2 - 10 && (f - first) % 20 === 0;
}

/** Trecho fora das tabelas (mesmo formato de um bloco, sem a lista de canais). */
function freeBlock(centerFreq, widthMHz) {
  return { centerFreq, lo: centerFreq - widthMHz / 2, hi: centerFreq + widthMHz / 2, channels: null };
}

/** 2,4 GHz: 20 MHz, ou 40 MHz com o secundário 20 MHz acima/abaixo do primário. */
function resolve24(f, channel, declared, centers) {
  const options = declared >= 40 && channel !== null ? blocksContaining('2.4', 40, channel) : [];
  if (!options.length) return { parts: [freeBlock(f, 20)], widthMHz: 20, secondary: null, approx: false };
  const approx = declared > 40; // largura que não existe em 2,4 GHz: tratamos como 40
  const hit = options.find((b) => centers.includes(b.centerFreq));
  if (hit) return { parts: [hit], widthMHz: 40, secondary: hit.centerFreq > f ? 'above' : 'below', approx };
  // Sem um centerFreq coerente não dá para saber o lado do secundário. Faixa conservadora: a
  // união dos lados possíveis (primários 1..4 só cabem com o secundário acima, 10..13 só
  // abaixo; 5..9 cabem dos dois jeitos -> 60 MHz centrados no primário). `secondary` fica null.
  const lo = options[0].lo;
  const hi = options[options.length - 1].hi;
  return {
    parts: [{ centerFreq: (lo + hi) / 2, lo, hi, channels: null }],
    widthMHz: 40,
    secondary: null,
    approx: approx || options.length > 1,
  };
}

/** 5 e 6 GHz: a junção é fixa, então a tabela manda e os centerFreq só desempatam. */
function resolveBonded(band, f, channel, declared, plus, centers) {
  const at = (w) => (channel === null ? null : blockContaining(band, w, channel));
  const done = (parts, approx) => ({
    parts,
    widthMHz: parts.reduce((sum, p) => sum + (p.hi - p.lo), 0),
    secondary: null,
    approx,
  });

  if (declared === 20) return done([at(20) || freeBlock(f, 20)], false);

  if (declared === 320) {
    const options = channel === null ? [] : blocksContaining(band, 320, channel);
    const hit = options.find((b) => centers.includes(b.centerFreq));
    if (hit) return done([hit], false);
    // Sem o centro não há como escolher entre 320-1 e 320-2: fica o de centro mais baixo
    if (options.length) return done([options[0]], options.length > 1);
  }

  if (declared === 160) {
    const b80 = at(80);
    const b160 = at(160);
    // Convenções vistas na prática: centerFreq0 = centro dos 160 MHz; ou centerFreq0 = centro do
    // 80 MHz primário e centerFreq1 = centro dos 160 MHz; ou (80+80) os centros dos dois segmentos.
    if (b160 && centers.includes(b160.centerFreq)) return done([b160], false);
    const other = b80 && BLOCKS[band][80].find((b) => b !== b80 && centers.includes(b.centerFreq));
    if (other) {
      // Dois segmentos de 80 MHz que são as metades de um bloco de 160: é um canal contíguo
      if (b160 && other.lo >= b160.lo && other.hi <= b160.hi) return done([b160], false);
      return done([b80, other], false);
    }
    if (!plus && b160) return done([b160], false);
    // 80+80 sem o centro do segundo segmento: só o segmento primário é conhecido
    if (plus && b80) return done([b80], true);
  }

  if (declared === 40 || declared === 80) {
    const b = at(declared);
    if (b) return done([b], false);
  }

  // Fora da tabela (canal não padronizado): aceita o centro informado se ele fizer sentido...
  const c = centers.find((x) => isPlausibleCenter(x, f, declared));
  if (c !== undefined) return done([freeBlock(c, declared)], true);
  // ...senão cai para a maior largura padronizada que contém o primário
  for (let w = declared / 2; w >= 40; w /= 2) {
    const b = at(w);
    if (b) return done([b], true);
  }
  return done([at(20) || freeBlock(f, 20)], true);
}

/** Canais de 20 MHz cobertos por um trecho de 5/6 GHz. */
function channelsOfPart(part) {
  if (part.channels) return part.channels.slice();
  const out = [];
  for (let f = part.lo + 10; f < part.hi; f += 20) {
    const ch = freqToChannel(f);
    if (ch !== null) out.push(ch);
  }
  return out;
}

/**
 * Que pedaço do espectro um AP ocupa, a partir dos campos crus do Android.
 *
 * Semântica do Android (ScanResult): `frequency` = centro do canal primário de 20 MHz;
 * `channelWidth` = 0: 20 MHz, 1: 40, 2: 80, 3: 160, 4: 80+80, 5: 320; `centerFreq0` = centro do
 * canal em 40/80/160/320 MHz (não usado em 20 MHz) ou do 1º segmento em 80+80; `centerFreq1` =
 * centro do 2º segmento, só em 80+80. Na prática os celulares variam (centerFreq0 zerado ou
 * igual a `frequency`; em 160 MHz, centerFreq0 = centro do 80 MHz primário e centerFreq1 =
 * centro dos 160 MHz), então: em 5/6 GHz vale a tabela de junção (que é fixa) e os centros só
 * desempatam (320 MHz, 80+80); em 2,4 GHz o centro diz de que lado está o canal secundário.
 *
 * @param {{frequency?:number, channelWidth?:number, centerFreq0?:number, centerFreq1?:number}} rawAp
 * @returns {{
 *   band: '2.4'|'5'|'6'|'60'|null,
 *   channel: number|null,          canal primário
 *   freq: number|null,             centro do canal primário (MHz)
 *   widthMHz: number,              20|40|80|160|320 (80+80 = 160, em dois segmentos; 60 GHz = 2160)
 *   centerFreq: number|null,       centro do canal (em 80+80, do segmento que contém o primário)
 *   centerChannel: number|null,
 *   segments: {lo:number, hi:number}[],  trechos ocupados em MHz; o primeiro contém o primário
 *   channels: number[],            canais de 20 MHz cobertos (2,4 GHz: primário e secundário)
 *   secondary: 'above'|'below'|null,     lado do canal secundário (só 40 MHz em 2,4 GHz)
 *   noncontiguous: boolean,        true em 80+80
 *   dfs: boolean,                  algum trecho ocupado exige DFS
 *   unii: string|null,             sub-faixa do canal primário
 *   psc: boolean,                  o primário é um PSC dos 6 GHz
 *   approx: boolean,               a faixa foi presumida (dados ausentes ou incoerentes)
 *   label: string                  ex.: "36 · 80 MHz (36–48)"
 * }}
 */
export function occupancy(rawAp) {
  const ap = rawAp !== null && typeof rawAp === 'object' ? rawAp : {};
  const freq = toNum(ap.frequency);
  const band = bandOf(freq);
  const channel = freqToChannel(freq);
  const cw = toNum(ap.channelWidth);
  const widthKnown = cw !== null && Number.isInteger(cw) && cw >= 0 && cw <= 5;
  const declared = androidWidthToMHz(cw);
  const centers = [toNum(ap.centerFreq0), toNum(ap.centerFreq1)].filter((c) => c !== null && c > 0);

  let r;
  if (band === '2.4') {
    r = resolve24(freq, channel, declared, centers);
    r.approx = r.approx || !widthKnown;
  } else if (band === '5' || band === '6') {
    r = resolveBonded(band, freq, channel, declared, cw === 4, centers);
    r.approx = r.approx || !widthKnown;
  } else if (band === '60') {
    // channelWidth não se aplica ao 802.11ad: o canal tem sempre 2,16 GHz
    r = { parts: [freeBlock(freq, WIDTH_60GHZ)], widthMHz: WIDTH_60GHZ, secondary: null, approx: false };
  } else {
    const parts = freq !== null && freq > 0 ? [freeBlock(freq, 20)] : [];
    r = { parts, widthMHz: 20, secondary: null, approx: true };
  }

  const { parts, secondary } = r;
  const segments = parts.map((p) => ({ lo: p.lo, hi: p.hi }));
  const centerFreq = parts.length ? parts[0].centerFreq : null;

  let channels = [];
  if (band === '5' || band === '6') channels = parts.flatMap(channelsOfPart);
  else if (channel !== null) channels = secondary ? [channel, channel + (secondary === 'above' ? 4 : -4)] : [channel];

  const out = {
    band,
    channel,
    freq,
    widthMHz: r.widthMHz,
    centerFreq,
    centerChannel: freqToChannel(centerFreq),
    segments,
    channels,
    secondary,
    noncontiguous: parts.length > 1,
    dfs: band === '5' && segments.some((s) => rangeIsDfs(s.lo, s.hi)),
    unii: uniiOf(freq),
    psc: band === '6' && isPscChannel(channel),
    approx: r.approx,
    label: '',
  };
  out.label = occupancyLabel(out, parts);
  return out;
}

function occupancyLabel(o, parts) {
  if (o.band === null) return o.freq !== null && o.freq > 0 ? `${o.freq} MHz` : '—';
  const head = o.channel !== null ? String(o.channel) : `${o.freq} MHz`;
  if (o.band === '60') return `${head} · 2,16 GHz`;
  const width = o.noncontiguous ? '80+80 MHz' : `${o.widthMHz} MHz`;
  let detail = '';
  if (o.band === '2.4') {
    if (o.secondary) detail = `${o.channels[0]}+${o.channels[1]}`;
  } else if (o.widthMHz > 20) {
    detail = parts
      .map((p) => {
        const chs = channelsOfPart(p);
        return chs.length > 1 ? `${chs[0]}–${chs[chs.length - 1]}` : `${p.lo}–${p.hi} MHz`;
      })
      .join(' + ');
  }
  return detail ? `${head} · ${width} (${detail})` : `${head} · ${width}`;
}

/**
 * MHz de espectro que duas ocupações têm em comum (soma sobre os segmentos).
 * @param {{segments:{lo:number,hi:number}[]}} occA
 * @param {{segments:{lo:number,hi:number}[]}} occB
 * @returns {number}
 */
export function overlapMHz(occA, occB) {
  let total = 0;
  for (const a of segmentsOf(occA)) {
    for (const b of segmentsOf(occB)) {
      total += Math.max(0, Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo));
    }
  }
  return total;
}

/** Aceita uma ocupação ({segments}), um bloco/segmento ({lo, hi}) ou nada. */
function segmentsOf(occ) {
  if (occ === null || typeof occ !== 'object') return [];
  const list = Array.isArray(occ.segments) ? occ.segments : [occ];
  const out = [];
  for (const s of list) {
    if (s === null || typeof s !== 'object') continue;
    const lo = toNum(s.lo);
    const hi = toNum(s.hi);
    if (lo !== null && hi !== null && hi > lo) out.push({ lo, hi });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Máscara espectral e interferência entre canais
// ---------------------------------------------------------------------------

const LN10_OVER_10 = Math.LN10 / 10;

// Pontos da máscara de transmissão OFDM do 802.11, em função da largura W do canal:
//   0 dBr até W/2 − 1 MHz; −20 dBr em W/2 + 1; −28 dBr em W; −40 dBr em 1,5·W.
// (20 MHz: ±9, ±11, ±20, ±30 MHz; 40 MHz: ±19, ±21, ±40, ±60; 80 e 160 seguem a mesma regra.)
// Depois de 1,5·W a norma só exige um piso de −40 dBr. Rádios de verdade continuam caindo, então
// mantemos a inclinação do último trecho: assim um canal distante (ou outra faixa) dá zero.
function maskShape(width) {
  const x0 = width / 2 - 1;
  const x1 = width / 2 + 1;
  const x2 = width;
  return {
    x0,
    x1,
    x2,
    slopeB: -10, // dB por MHz: 20 dB em 2 MHz
    slopeC: -8 / (x2 - x1),
    slopeD: -24 / width, // 12 dB a cada meia largura
  };
}

/**
 * Máscara espectral de transmissão: nível relativo (dBr, <= 0) a `offsetMHz` do centro de um
 * canal de `widthMHz`. Simétrica. null se a entrada for inválida.
 * @param {number} offsetMHz
 * @param {number} [widthMHz=20]
 * @returns {number|null}
 */
export function maskDb(offsetMHz, widthMHz = 20) {
  const off = toNum(offsetMHz);
  const w = toNum(widthMHz);
  if (off === null || w === null || w < 4) return null;
  const x = Math.abs(off);
  const m = maskShape(w);
  if (x <= m.x0) return 0;
  if (x <= m.x1) return m.slopeB * (x - m.x0);
  if (x <= m.x2) return -20 + m.slopeC * (x - m.x1);
  return -28 + m.slopeD * (x - m.x2);
}

/** ∫ de 10^(nível/10) num trecho reto (em dB) que começa em `startDb` e desce `slope` dB/MHz. */
function pieceArea(startDb, slope, length) {
  if (length <= 0) return 0;
  const k = -slope * LN10_OVER_10;
  const a = Math.pow(10, startDb / 10);
  return length === Infinity ? a / k : (a * (1 - Math.exp(-k * length))) / k;
}

/** Potência (em "MHz equivalentes" a 0 dBr) entre o centro e o deslocamento x >= 0. */
function maskArea(x, m) {
  let area = Math.min(x, m.x0);
  if (x > m.x0) area += pieceArea(0, m.slopeB, Math.min(x, m.x1) - m.x0);
  if (x > m.x1) area += pieceArea(-20, m.slopeC, Math.min(x, m.x2) - m.x1);
  if (x > m.x2) area += pieceArea(-28, m.slopeD, x - m.x2);
  return area;
}

/**
 * Fração (0..1, linear) da potência de um transmissor que cai dentro da banda [rxLo, rxHi] MHz
 * de um receptor. A máscara é integrada de forma exata (ela é reta em dB, trecho a trecho) e a
 * potência se divide entre os segmentos conforme a largura de cada um.
 *   mesmo canal ≈ 0,99 · canal de 20 MHz vizinho (20 MHz ao lado) ≈ 0,005 · 25 MHz ao lado ≈ 0,001
 * Também aceita uma ocupação no lugar de rxLo/rxHi: interferenceFactor(txOcc, rxOcc).
 * @param {{segments:{lo:number,hi:number}[]}|{lo:number,hi:number}} txOcc
 * @param {number|object} rxLo
 * @param {number} [rxHi]
 * @returns {number}
 */
export function interferenceFactor(txOcc, rxLo, rxHi) {
  const tx = segmentsOf(txOcc);
  let rx;
  if (rxLo !== null && typeof rxLo === 'object') {
    rx = segmentsOf(rxLo);
  } else {
    const a = toNum(rxLo);
    const b = toNum(rxHi);
    rx = a === null || b === null || a === b ? [] : [{ lo: Math.min(a, b), hi: Math.max(a, b) }];
  }
  if (!tx.length || !rx.length) return 0;

  const totalWidth = tx.reduce((sum, s) => sum + (s.hi - s.lo), 0);
  let factor = 0;
  for (const s of tx) {
    const width = s.hi - s.lo;
    if (width < 4) continue;
    const center = (s.lo + s.hi) / 2;
    const m = maskShape(width);
    const signedArea = (x) => Math.sign(x) * maskArea(Math.abs(x), m);
    const whole = 2 * maskArea(Infinity, m);
    let inside = 0;
    for (const r of rx) inside += signedArea(r.hi - center) - signedArea(r.lo - center);
    factor += (width / totalWidth) * (inside / whole);
  }
  return Math.min(1, Math.max(0, factor));
}
