// Lógica pura da tela Redes: que linhas aparecem, em que ordem e com que resumo.
// Nada aqui toca no DOM (roda em node:test): entra o estado do store, saem objetos simples.
//
//   sanitizeControls(bruto)            -> controles válidos ({mode, sort, filters, query})
//   toggleFilter(controles, id)        -> controles com o filtro ligado/desligado
//   selectRows(estado, controles)      -> { rows, total, filtered }   linhas já filtradas e ordenadas
//   windowRows(linhas, limite)         -> { rows, hidden }            só as que a lista desenha de uma vez
//   buildRows(estado, modo, faixas)    -> linhas de um modo (sem filtro de texto nem ordem)
//   matchesQuery(linha, texto)         -> a busca (nome, BSSID ou fabricante) casa com a linha?
//   sortRows(linhas, ordem)            -> cópia ordenada
//   summarize(estado)                  -> { networks, devices, signals, bands: {'2.4', '5', '6'} }
//   connectionView(estado, agora)      -> o que o cartão "sua conexão" mostra
//   liveConnection(estado, {now, history}) -> a conexão com a leitura ao vivo do sinal por cima (diagnóstico, exportar)
//   liveSignalKey(estado, {now, history})  -> o nível do sinal ao vivo ('fair', 'weak'...): muda só quando troca de faixa
//   channelsText(canais)               -> "canal 6" · "canais 6 e 44" · "canais 1, 6, 11 +2"
//   bandsText(faixas)                  -> "2,4 e 5 GHz"
//   countText(linha)                   -> "2 sinais" · "3 sinais em 2 roteadores"
//   seriesLabels(aps)                  -> Map BSSID -> rótulo curto sem ambiguidade (gráficos)
//   foldText(texto)                    -> minúsculas e sem acentos (para comparar)
//   cleanName(texto)                   -> nome de rede sem caracteres de controle
//   apFacts(ap, extra) · apFeatures(ap) · apDetailsText(ap, extra)   os detalhes de um BSSID (painel e "copiar tudo")
//
// Uma "linha" (Row) é o que a lista desenha: uma rede (nome), um roteador (aparelho físico)
// ou um sinal (BSSID), sempre com os Ap do store por baixo.

import { freqToChannel, bandOf } from '../core/channels.js';
import { indoorDistance, signalLevel } from '../core/signal.js';
import { standardInfo } from '../core/phy.js';
import { fmtDbm, fmtMbps, fmtMeters, fmtPct, fmtFreq, fmtWidth, fmtBand, fmtAgo, fmtClock, NO_VALUE, THIN } from './dom.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object';

/** Modos de ver a lista: por nome de rede, por aparelho físico ou cada BSSID. */
export const VIEW_MODES = Object.freeze(['networks', 'devices', 'signals']);
/** Ordens: sinal mais forte primeiro, nome (A-Z) ou canal. */
export const SORTS = Object.freeze(['signal', 'name', 'channel']);
/** Filtros: as três faixas, "minhas" e "abertas". */
export const FILTERS = Object.freeze(['2.4', '5', '6', 'mine', 'open']);
export const BAND_FILTERS = Object.freeze(['2.4', '5', '6']);

export const DEFAULT_CONTROLS = Object.freeze({ mode: 'networks', sort: 'signal', filters: Object.freeze([]), query: '' });

/** Tamanho máximo do texto de busca (um SSID tem no máximo 32 bytes; sobra folga). */
export const MAX_QUERY = 64;

/**
 * Controles válidos a partir de qualquer coisa (o que estava guardado, o que veio da URL...).
 * @param {*} raw
 * @returns {{mode:string, sort:string, filters:string[], query:string}}
 */
export function sanitizeControls(raw) {
  const o = isObj(raw) ? raw : {};
  const filters = [];
  for (const id of Array.isArray(o.filters) ? o.filters : []) {
    if (FILTERS.includes(id) && !filters.includes(id)) filters.push(id);
  }
  return {
    mode: VIEW_MODES.includes(o.mode) ? o.mode : DEFAULT_CONTROLS.mode,
    sort: SORTS.includes(o.sort) ? o.sort : DEFAULT_CONTROLS.sort,
    filters,
    query: typeof o.query === 'string' ? o.query.slice(0, MAX_QUERY) : '',
  };
}

/** Liga ou desliga um filtro, devolvendo controles novos (os antigos não são alterados). */
export function toggleFilter(controls, id) {
  const c = sanitizeControls(controls);
  if (!FILTERS.includes(id)) return c;
  c.filters = c.filters.includes(id) ? c.filters.filter((f) => f !== id) : [...c.filters, id];
  return c;
}

/** Há algum filtro ou busca ativos? */
export function hasFilters(controls) {
  const c = sanitizeControls(controls);
  return c.filters.length > 0 || c.query.trim() !== '';
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

const CONTROL_CHARS = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

/** Nome de rede para mostrar: caracteres de controle e quebras de linha viram "·". */
export function cleanName(text) {
  return typeof text === 'string' ? text.replace(CONTROL_CHARS, '·') : '';
}

/** Minúsculas, sem acentos e sem espaços nas pontas: "Ação " -> "acao". */
export function foldText(text) {
  if (typeof text !== 'string') return '';
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

const BAND_ORDER = { 2.4: 0, 5: 1, 6: 2, 60: 3 };
const bandRank = (band) => BAND_ORDER[band] ?? 9;
const BAND_SHORT = { 2.4: '2,4', 5: '5', 6: '6', 60: '60' };

/** Faixas por extenso: ['2.4'] -> "2,4 GHz"; ['2.4','5'] -> "2,4 e 5 GHz"; três -> "2,4, 5 e 6 GHz". */
export function bandsText(bands) {
  const list = (Array.isArray(bands) ? bands : []).filter((b) => BAND_SHORT[b]).map((b) => BAND_SHORT[b]);
  if (!list.length) return '';
  const head = list.length > 1 ? `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}` : list[0];
  return `${head}${THIN}GHz`;
}

/** Canais por extenso: [6] -> "canal 6"; [6, 44] -> "canais 6 e 44"; mais de três -> "canais 1, 6, 11 +2". */
export function channelsText(channels) {
  const list = (Array.isArray(channels) ? channels : []).filter(isNum);
  if (!list.length) return '';
  if (list.length === 1) return `canal ${list[0]}`;
  if (list.length <= 3) return `canais ${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
  return `canais ${list.slice(0, 3).join(', ')} +${list.length - 3}`;
}

/**
 * Rótulo curto de cada BSSID para gráficos e listas: o nome; quando o mesmo nome aparece mais
 * de uma vez (duas faixas, mesh), o nome com a faixa; se ainda empatar, com o canal; e, no
 * último caso (dois nós mesh no mesmo canal), com o fim do endereço.
 * @param {object[]} aps  Ap do store
 * @returns {Map<string, string>}  BSSID -> rótulo
 */
export function seriesLabels(aps) {
  const list = (Array.isArray(aps) ? aps : []).filter(isObj);
  const nameOf = (ap) => (ap.hidden ? '(rede oculta)' : cleanName(ap.ssid));
  const withBand = (ap) => `${nameOf(ap)} · ${BAND_SHORT[ap.band] ? `${BAND_SHORT[ap.band]}${THIN}GHz` : 'faixa ?'}`;
  const withChannel = (ap) => `${withBand(ap)} · canal ${ap.channel ?? '?'}`;
  const count = (fn) => {
    const seen = new Map();
    for (const ap of list) seen.set(fn(ap), (seen.get(fn(ap)) || 0) + 1);
    return seen;
  };
  const byName = count(nameOf);
  const byBand = count(withBand);
  const byChannel = count(withChannel);
  const out = new Map();
  for (const ap of list) {
    let label = nameOf(ap);
    if (byName.get(label) > 1) {
      label = withBand(ap);
      if (byBand.get(label) > 1) {
        label = withChannel(ap);
        if (byChannel.get(label) > 1) label = `${label} · ${String(ap.bssid).slice(-5)}`;
      }
    }
    out.set(ap.bssid, label);
  }
  return out;
}

/** Quantos sinais uma linha agrupa: "2 sinais", "3 sinais em 2 roteadores"; '' para um sinal só. */
export function countText(row) {
  if (!row || row.count <= 1) return '';
  const base = `${row.count} sinais`;
  return row.kind === 'network' && row.deviceCount > 1 ? `${base} em ${row.deviceCount} roteadores` : base;
}

// ---------------------------------------------------------------------------
// Linhas
// ---------------------------------------------------------------------------

// A ordem segue o número que a linha mostra (a última leitura); o sinal suavizado só desempata,
// para duas redes com o mesmo valor não ficarem trocando de lugar a cada busca.
const strength = (ap) => (isNum(ap.rssi) ? ap.rssi : -Infinity);
const smooth = (ap) => (isNum(ap.rssiSmooth) ? ap.rssiSmooth : strength(ap));
const byStrength = (a, b) => strength(b) - strength(a) || smooth(b) - smooth(a) || (a.bssid < b.bssid ? -1 : a.bssid > b.bssid ? 1 : 0);

function isOpen(security) {
  return isObj(security) && security.known !== false && security.open === true;
}

/**
 * Monta uma linha a partir dos Ap que ela representa.
 * @param {'network'|'device'|'ap'} kind
 * @param {string} key      identidade estável da linha (chave da lista)
 * @param {object[]} aps    Ap do store, pelo menos um
 * @param {object} [extra]  { deviceCount, names }
 */
function makeRow(kind, key, aps, extra = {}) {
  const sorted = [...aps].sort(byStrength);
  // quem representa a linha: o BSSID conectado, se houver; senão o mais forte
  const best = sorted[0];
  const lead = sorted.find((ap) => ap.connected) || best;

  const bands = [...new Set(sorted.map((ap) => ap.band).filter((b) => b != null))].sort((a, b) => bandRank(a) - bandRank(b));
  const channels = [];
  for (const ap of [...sorted].sort((a, b) => bandRank(a.band) - bandRank(b.band) || (a.channel ?? 0) - (b.channel ?? 0))) {
    if (isNum(ap.channel) && !channels.includes(ap.channel)) channels.push(ap.channel);
  }
  const names = extra.names || [...new Set(sorted.filter((ap) => !ap.hidden).map((ap) => ap.ssid))];
  const vendors = [...new Set(sorted.map((ap) => ap.vendor).filter((v) => typeof v === 'string' && v))];
  let newest = best;
  for (const ap of sorted) if (isNum(ap.gen) && (!isNum(newest.gen) || ap.gen > newest.gen)) newest = ap;
  let ageMs = null;
  for (const ap of sorted) if (isNum(ap.ageMs) && (ageMs === null || ap.ageMs < ageMs)) ageMs = ap.ageMs;

  return {
    kind,
    key,
    aps: sorted,
    best,
    lead,
    count: sorted.length,
    deviceCount: isNum(extra.deviceCount) ? extra.deviceCount : 1,
    name: best.hidden ? '' : best.ssid,
    hidden: !!best.hidden,
    names,
    rssi: isNum(best.rssi) ? best.rssi : null,
    strength: strength(best),
    smooth: smooth(best),
    bands,
    channels,
    channel: isNum(best.channel) ? best.channel : null,
    widthMHz: isNum(best.widthMHz) ? best.widthMHz : null,
    security: best.security || null,
    open: sorted.some((ap) => isOpen(ap.security)),
    standardAp: newest,
    vendor: best.vendor || vendors[0] || null,
    vendorGuess: !!best.vendorGuess && !!best.vendor,
    vendors,
    connected: sorted.some((ap) => ap.connected),
    favorite: sorted.some((ap) => ap.favorite),
    own: sorted.some((ap) => ap.own),
    stale: sorted.every((ap) => ap.stale),
    ageMs,
  };
}

/**
 * As linhas de um modo, já restritas às faixas pedidas (o filtro de faixa vale por BSSID: com
 * "5 GHz" ligado, uma rede de duas faixas aparece com o sinal do rádio de 5 GHz).
 * @param {{aps:object[], devices:object[], networks:object[]}} state
 * @param {'networks'|'devices'|'signals'} mode
 * @param {string[]} [bands]  faixas aceitas; vazio = todas
 * @returns {object[]} linhas, sem ordem definida
 */
export function buildRows(state, mode, bands = []) {
  const s = isObj(state) ? state : {};
  const wanted = (Array.isArray(bands) ? bands : []).filter((b) => BAND_FILTERS.includes(b));
  const keep = (ap) => isObj(ap) && (wanted.length === 0 || wanted.includes(ap.band));
  const rows = [];

  if (mode === 'devices') {
    for (const device of Array.isArray(s.devices) ? s.devices : []) {
      const aps = (Array.isArray(device.aps) ? device.aps : []).filter(keep);
      if (aps.length) rows.push(makeRow('device', `d:${device.id}`, aps));
    }
  } else if (mode === 'signals') {
    for (const ap of Array.isArray(s.aps) ? s.aps : []) {
      if (keep(ap)) rows.push(makeRow('ap', `a:${ap.bssid}`, [ap]));
    }
  } else {
    for (const net of Array.isArray(s.networks) ? s.networks : []) {
      const all = Array.isArray(net.aps) ? net.aps : [];
      const aps = all.filter(keep);
      if (!aps.length) continue;
      // com o filtro de faixa, a contagem de roteadores só vale se nada ficou de fora
      const deviceCount = aps.length === all.length && isNum(net.devices) ? net.devices : Math.min(isNum(net.devices) ? net.devices : 1, aps.length);
      const row = makeRow('network', `n:${net.key}`, aps, { deviceCount });
      row.networkKey = net.key;
      rows.push(row);
    }
  }
  return rows;
}

function matchesFlags(row, filters) {
  if (filters.includes('mine') && !row.own && !row.favorite) return false;
  if (filters.includes('open') && !row.open) return false;
  return true;
}

/** Só os dígitos hexadecimais de um texto que parece (um pedaço de) endereço MAC; senão ''. */
function macDigits(text) {
  const compact = text.replace(/[\s:.\-]/g, '');
  return compact.length >= 2 && /^[0-9a-f]+$/.test(compact) && /[:\-.]|^[0-9a-f]{4,}$/.test(text) ? compact : '';
}

/**
 * A busca casa com a linha? Compara, sem diferenciar maiúsculas nem acentos, com o nome da rede,
 * o fabricante e o BSSID (com ou sem os dois-pontos). Vários termos: todos têm de aparecer.
 * @param {object} row
 * @param {string} query
 */
export function matchesQuery(row, query) {
  const q = foldText(query);
  if (!q) return true;
  if (!row.search) {
    const parts = [];
    for (const name of row.names) parts.push(name);
    if (row.hidden || row.aps.some((ap) => ap.hidden)) parts.push('(rede oculta)');
    for (const vendor of row.vendors) parts.push(vendor);
    for (const ap of row.aps) parts.push(ap.bssid);
    row.search = {
      text: foldText(parts.join('\n')),
      macs: row.aps.map((ap) => String(ap.bssid || '').replace(/:/g, '')).join('\n'),
    };
  }
  if (row.search.text.includes(q)) return true;
  const mac = macDigits(q);
  if (mac && row.search.macs.includes(mac)) return true;
  const terms = q.split(/\s+/).filter(Boolean);
  return terms.length > 1 && terms.every((t) => row.search.text.includes(t));
}

let collator = null;
function compareNames(a, b) {
  if (!collator) collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
  return collator.compare(a, b);
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const bySignal = (a, b) => b.strength - a.strength || b.smooth - a.smooth || byKey(a, b);

/**
 * Cópia ordenada das linhas.
 *   'signal'   do sinal mais forte para o mais fraco (o número mostrado; empate: o sinal suavizado)
 *   'name'     ordem alfabética; redes ocultas por último
 *   'channel'  2,4 GHz antes de 5 e 6 GHz; dentro da faixa, pelo número do canal
 * @param {object[]} rows
 * @param {'signal'|'name'|'channel'} sort
 */
export function sortRows(rows, sort) {
  const list = [...(Array.isArray(rows) ? rows : [])];
  if (sort === 'name') {
    return list.sort((a, b) => Number(a.hidden) - Number(b.hidden) || compareNames(a.name, b.name) || bySignal(a, b));
  }
  if (sort === 'channel') {
    return list.sort(
      (a, b) => bandRank(a.best.band) - bandRank(b.best.band) || (a.channel ?? Infinity) - (b.channel ?? Infinity) || bySignal(a, b),
    );
  }
  return list.sort(bySignal);
}

/**
 * As linhas que a lista mostra agora.
 * @param {{aps:object[], devices:object[], networks:object[]}} state
 * @param {{mode:string, sort:string, filters:string[], query:string}} controls
 * @returns {{rows:object[], total:number, filtered:boolean}}
 *          total = quantas linhas o modo tem sem filtro nenhum; filtered = há filtro ou busca ativos
 */
export function selectRows(state, controls) {
  const c = sanitizeControls(controls);
  const bands = c.filters.filter((f) => BAND_FILTERS.includes(f));
  const flags = c.filters.filter((f) => !BAND_FILTERS.includes(f));
  const filtered = c.filters.length > 0 || c.query.trim() !== '';
  const all = buildRows(state, c.mode, bands);
  const total = bands.length ? buildRows(state, c.mode).length : all.length;
  const rows = filtered ? all.filter((row) => matchesFlags(row, flags) && matchesQuery(row, c.query)) : all;
  return { rows: sortRows(rows, c.sort), total, filtered };
}

/** Quantas linhas a lista desenha de cada vez (o resto entra com "Mostrar mais"). */
export const ROW_PAGE = 80;
/** Linhas além da janela que entram assim mesmo (a conectada e as "minhas"): no máximo isto. */
export const ROW_PINNED_MAX = 12;

/**
 * A janela da lista: as primeiras `limit` linhas da ordem atual. Desenhar (e refazer a cada
 * busca) uma linha por rede não tem teto num lugar com centenas de redes, ou quando alguém por
 * perto transmite redes falsas aos montes; a tela travaria por segundos a cada varredura.
 * A linha conectada e as redes do usuário nunca ficam de fora: entram depois da janela, na ordem
 * em que estavam (com um teto próprio, porque "minha" é decidido pelo nome, que qualquer um copia).
 * Aplique DEPOIS de filtrar e ordenar.
 * @param {object[]} rows
 * @param {number} [limit]
 * @returns {{rows:object[], hidden:number}}  hidden = quantas linhas ficaram de fora
 */
export function windowRows(rows, limit = ROW_PAGE) {
  const list = Array.isArray(rows) ? rows : [];
  const max = isNum(limit) && limit >= 1 ? Math.floor(limit) : ROW_PAGE;
  if (list.length <= max) return { rows: list, hidden: 0 };
  const shown = list.slice(0, max);
  let pinned = 0;
  // a conectada primeiro: é a que não pode faltar de jeito nenhum
  for (let i = max; i < list.length && pinned < ROW_PINNED_MAX; i++) {
    if (isObj(list[i]) && list[i].connected) {
      shown.push(list[i]);
      pinned += 1;
    }
  }
  for (let i = max; i < list.length && pinned < ROW_PINNED_MAX; i++) {
    const row = list[i];
    if (isObj(row) && !row.connected && (row.favorite || row.own)) {
      shown.push(row);
      pinned += 1;
    }
  }
  return { rows: shown, hidden: list.length - shown.length };
}

/**
 * Resumo do que está ao alcance.
 * @returns {{networks:number, devices:number, signals:number, bands:{'2.4':number, '5':number, '6':number}}}
 *          bands = quantas REDES têm sinal em cada faixa (uma rede de duas faixas conta nas duas)
 */
export function summarize(state) {
  const s = isObj(state) ? state : {};
  const networks = Array.isArray(s.networks) ? s.networks : [];
  const bands = { 2.4: 0, 5: 0, 6: 0 };
  for (const net of networks) {
    for (const band of Array.isArray(net.bands) ? net.bands : []) if (band in bands) bands[band] += 1;
  }
  return {
    networks: networks.length,
    devices: Array.isArray(s.devices) ? s.devices.length : 0,
    signals: Array.isArray(s.aps) ? s.aps.length : 0,
    bands,
  };
}

// ---------------------------------------------------------------------------
// A conexão atual
// ---------------------------------------------------------------------------

/** Uma leitura do sinal (evento 'rssi') mais velha que isto não é mais "ao vivo". */
export const LIVE_RSSI_MS = 5000;
/** Quantas leituras recentes pedir ao store (store.rssiHistory(n)) para a mediana: 5 s a até 4 por segundo, com folga. */
export const LIVE_RSSI_SAMPLES = 32;

/** A leitura é do rádio conectado (ou não diz de qual é) e ainda é "ao vivo"? Uma regra só, para o cartão e para o diagnóstico. */
function isLiveSample(sample, bssid, now) {
  if (!isObj(sample) || !isNum(sample.rssi) || !isNum(sample.ts) || Math.abs(now - sample.ts) > LIVE_RSSI_MS) return false;
  return !sample.bssid || !bssid || String(sample.bssid).toLowerCase() === bssid;
}

/**
 * A conexão como ela está AGORA: a de state.connection com a leitura ao vivo do sinal por cima.
 *
 * O Android só reenvia a conexão quando ela muda de rede ou de rádio: o sinal e as velocidades que
 * vêm nela ficam parados desde então (a pessoa anda pela casa e `connection.rssi` continua sendo o
 * do lugar onde o app abriu). Quem acompanha a pessoa é a leitura de cada segundo (state.rssi).
 * Tudo o que analisa ou exporta a conexão (diagnóstico, relatório) parte daqui, não de
 * state.connection direto.
 *
 * Com `history` (store.rssiHistory), o sinal é a mediana das leituras ao vivo: uma leitura torta
 * sozinha não muda a conclusão de quem compara com um limite ("sinal fraco"). Sem `history` vale a
 * última leitura. Sem leitura ao vivo do rádio conectado, a conexão volta como está.
 * @param {{connection:object|null, rssi:object|null}} state
 * @param {{now?:number, history?:object[]|null}} [options]  history: RssiSample[], a mais nova por último
 * @returns {object|null} uma cópia com rssi/linkSpeed/txSpeed/rxSpeed/frequency em dia (ou a própria conexão)
 */
export function liveConnection(state, { now = Date.now(), history = null } = {}) {
  const s = isObj(state) ? state : {};
  const conn = isObj(s.connection) ? s.connection : null;
  if (!conn || conn.connected !== true) return conn;
  const bssid = typeof conn.bssid === 'string' ? conn.bssid.toLowerCase() : '';
  const sample = isLiveSample(s.rssi, bssid, now) ? s.rssi : null;
  if (!sample) return conn;

  let rssi = sample.rssi;
  if (Array.isArray(history) && history.length) {
    // do fim para o começo, até a primeira leitura velha ou de outro rádio (o celular trocou de rádio ali)
    const recent = [];
    for (let i = history.length - 1; i >= 0 && isLiveSample(history[i], bssid, now); i--) recent.push(history[i].rssi);
    if (recent.length) {
      recent.sort((a, b) => a - b);
      const mid = recent.length >> 1;
      rssi = recent.length % 2 ? recent[mid] : Math.round((recent[mid - 1] + recent[mid]) / 2);
    }
  }
  const out = { ...conn, rssi };
  // velocidade desconhecida (0 ou -1) não apaga a que a conexão trouxe
  for (const key of ['linkSpeed', 'txSpeed', 'rxSpeed', 'frequency']) if (isNum(sample[key]) && sample[key] > 0) out[key] = sample[key];
  return out;
}

/**
 * Em que nível está o sinal ao vivo da conexão ('excellent' ... 'very-weak'; '' sem conexão ou sem
 * leitura). Serve de chave para refazer uma análise: muda só quando o sinal troca de faixa, não a
 * cada leitura.
 */
export function liveSignalKey(state, options) {
  const conn = liveConnection(state, options);
  return conn && conn.connected === true && isNum(conn.rssi) ? signalLevel(conn.rssi).key : '';
}

/**
 * O que o cartão da conexão mostra, juntando a conexão (WifiInfo), a leitura ao vivo do sinal
 * e o Ap da lista (largura do canal, fabricante...).
 * @param {{connection:object|null, rssi:object|null, aps:object[]}} state
 * @param {number} [now]  relógio do app (ms); padrão Date.now()
 * @returns {{connected:false} | {connected:true, name:string, hidden:boolean, bssid:string, ap:object|null,
 *            rssi:number|null, live:boolean, freq:number|null, band:string|null, channel:number|null,
 *            widthMHz:number|null, standard:string|null, standardLabel:string|null, downMbps:number|null,
 *            upMbps:number|null, linkMbps:number|null, distanceM:number|null, favorite:boolean, validated:boolean|null}}
 */
export function connectionView(state, now = Date.now()) {
  const s = isObj(state) ? state : {};
  const conn = isObj(s.connection) ? s.connection : null;
  if (!conn || conn.connected !== true) return { connected: false };

  const bssid = typeof conn.bssid === 'string' ? conn.bssid.toLowerCase() : '';
  const aps = Array.isArray(s.aps) ? s.aps : [];
  const ap = aps.find((a) => a.connected) || (bssid ? aps.find((a) => a.bssid === bssid) : null) || null;

  const sample = isObj(s.rssi) ? s.rssi : null;
  const live = isLiveSample(sample, bssid, now);

  const pick = (...values) => {
    for (const v of values) if (isNum(v) && v > 0) return v;
    return null;
  };
  const rssi = live ? sample.rssi : isNum(conn.rssi) ? conn.rssi : ap && isNum(ap.rssi) ? ap.rssi : null;
  const freq = pick(live ? sample.frequency : null, conn.frequency, ap ? ap.freq : null);
  const band = freq ? bandOf(freq) : ap ? ap.band : null;

  let standard = null;
  let standardLabel = null;
  if (isNum(conn.wifiStandard) && conn.wifiStandard > 0) {
    const info = standardInfo(conn.wifiStandard, band ?? undefined);
    if (info && info.gen != null) {
      standard = info.short;
      standardLabel = info.label;
    }
  }
  if (!standard && ap && isNum(ap.gen)) {
    standard = ap.genSource === 'inferred' && ap.gen < 7 ? `${ap.standard}+` : ap.standard;
    standardLabel = ap.standardLabel;
  }

  const rawName = typeof conn.ssid === 'string' && conn.ssid !== '<unknown ssid>' ? conn.ssid : '';
  const name = rawName || (ap && !ap.hidden ? ap.ssid : '');

  return {
    connected: true,
    name,
    hidden: name === '',
    bssid,
    ap,
    rssi,
    live,
    freq,
    band,
    channel: freq ? freqToChannel(freq) : ap ? ap.channel : null,
    widthMHz: ap && isNum(ap.widthMHz) ? ap.widthMHz : null,
    standard,
    standardLabel,
    downMbps: pick(live ? sample.rxSpeed : null, conn.rxSpeed),
    upMbps: pick(live ? sample.txSpeed : null, conn.txSpeed),
    linkMbps: pick(live ? sample.linkSpeed : null, conn.linkSpeed),
    distanceM: isNum(rssi) ? indoorDistance(rssi, freq ?? undefined) : null,
    favorite: !!name && s.favorites instanceof Set && s.favorites.has(name),
    validated: typeof conn.validated === 'boolean' ? conn.validated : null,
  };
}

// ---------------------------------------------------------------------------
// Detalhes de um ponto de acesso (painel de detalhes e "copiar tudo")
// ---------------------------------------------------------------------------


const SECURITY_WORD = ['Sem proteção', 'Proteção quebrada', 'Proteção fraca', 'Proteção boa', 'Proteção forte'];

/** Uma frase curta para o nível de segurança (0..4 de core/security.js). */
export function securityWord(security) {
  if (!isObj(security) || security.known === false) return 'O celular não informou';
  if (security.open && security.encrypted) return 'Sem senha, mas criptografada';
  return SECURITY_WORD[security.level] || SECURITY_WORD[3];
}

/** Trecho do espectro ocupado: "2427–2447 MHz"; 80+80 MHz vira dois trechos. */
export function rangeText(occ) {
  const segments = isObj(occ) && Array.isArray(occ.segments) ? occ.segments : [];
  const parts = segments.filter((s) => isObj(s) && isNum(s.lo) && isNum(s.hi)).map((s) => `${Math.round(s.lo)}–${Math.round(s.hi)}`);
  return parts.length ? `${parts.join(' + ')}${THIN}MHz` : '';
}

/** Canais de 20 MHz cobertos: [36,40,44,48] -> "canais 36 a 48"; um só -> ''. */
export function coveredChannelsText(occ) {
  const list = isObj(occ) && Array.isArray(occ.channels) ? occ.channels.filter(isNum) : [];
  if (list.length < 2) return '';
  return `canais ${Math.min(...list)} a ${Math.max(...list)}`;
}

/** "2×2" a partir do número de fluxos espaciais. */
export function antennasText(nss) {
  return isNum(nss) && nss >= 1 ? `${nss}×${nss}` : '';
}

/**
 * Recursos anunciados pelo roteador, em palavras de gente. Só existe quando o celular entrega
 * os elementos do beacon (Android 11+); sem eles devolve [].
 * @param {object} ap
 * @returns {{id:string, label:string, on:boolean, value?:string, hint:string, tone?:'warning'|'neutral'}[]}
 *          tone: sem ele, "ligado" é bom; 'warning'/'neutral' = ligado mas não é para comemorar
 */
export function apFeatures(ap) {
  const ie = isObj(ap) && isObj(ap.ie) ? ap.ie : null;
  if (!ie) return [];
  const roaming = isObj(ie.roaming) ? ie.roaming : {};
  const out = [
    { id: 'roam-kv', label: 'Roaming assistido (802.11k/v)', on: !!(roaming.k || roaming.v), hint: 'Ajuda o aparelho a escolher o melhor ponto de acesso da casa' },
    { id: 'roam-r', label: 'Roaming rápido (802.11r)', on: !!roaming.r, hint: 'Troca de ponto de acesso sem cortar chamadas' },
    { id: 'mu-mimo', label: 'MU-MIMO', on: !!ie.muMimo, hint: 'Atende vários aparelhos ao mesmo tempo' },
    { id: 'beamforming', label: 'Beamforming', on: !!ie.beamforming, hint: 'Aponta o sinal na direção de cada aparelho' },
    { id: 'twt', label: 'TWT', on: !!ie.twt, hint: 'Combina horários com os aparelhos para poupar bateria' },
    {
      id: 'bss-color',
      label: 'BSS Color',
      on: isNum(ie.bssColor),
      value: isNum(ie.bssColor) ? `cor ${ie.bssColor}` : undefined,
      hint: 'Marca os pacotes para conviver melhor com vizinhos no mesmo canal',
    },
  ];
  if (ie.mlo) out.push({ id: 'mlo', label: 'MLO (Wi-Fi 7)', on: true, hint: 'Usa mais de uma faixa ao mesmo tempo' });
  if (ie.mesh) out.push({ id: 'mesh', label: 'Wi-Fi EasyMesh', on: true, hint: 'Faz parte de uma rede mesh (vários pontos de acesso)' });
  if (ap.rttResponder) out.push({ id: 'rtt', label: 'Wi-Fi RTT (802.11mc)', on: true, hint: 'Permite medir a distância real até o roteador' });
  if (ie.passpoint) out.push({ id: 'passpoint', label: 'Passpoint', on: true, hint: 'Rede de operadora com login automático' });
  const wps = isObj(ie.wps) ? ie.wps : null;
  // o WPS é o único "recurso" que é melhor NÃO ter: ligado, vira um ponto de atenção
  out.push({
    id: 'wps',
    label: 'WPS',
    on: !!(wps && wps.enabled),
    tone: wps && wps.enabled ? (wps.locked ? 'neutral' : 'warning') : undefined,
    value: wps && wps.enabled ? (wps.locked ? 'ligado (PIN travado)' : 'ligado') : 'desligado',
    hint: 'Pareamento por botão, sem senha. Se ninguém usa, é mais seguro desligar',
  });
  return out;
}

/**
 * Os fatos de um BSSID como pares rótulo/valor, na ordem em que aparecem em "copiar tudo".
 * O painel de detalhes usa os mesmos (pelo `id`), para a tela e o texto copiado nunca divergirem.
 * @param {object} ap  Ap do store
 * @param {{estMbps?:number|null, maxMbps?:number|null, now?:number}} [extra]
 *        estMbps = velocidade estimada aqui (core/best-network.js); maxMbps = taxa máxima do enlace
 * @returns {{id:string, label:string, value:string, hint?:string}[]}  só os que têm valor
 */
export function apFacts(ap, extra = {}) {
  if (!isObj(ap)) return [];
  const now = isNum(extra.now) ? extra.now : Date.now();
  const ie = isObj(ap.ie) ? ap.ie : null;
  const level = isObj(ap.level) ? ap.level : null;
  const facts = [];
  const add = (id, label, value, hint) => {
    if (value == null || value === '' || value === NO_VALUE) return;
    facts.push(hint ? { id, label, value: String(value), hint } : { id, label, value: String(value) });
  };

  add('name', 'Rede', ap.hidden ? '(rede oculta)' : ap.ssid);
  add('bssid', 'BSSID', ap.bssid, 'o endereço deste rádio');
  add('vendor', 'Fabricante', ap.vendor ? (ap.vendorGuess ? `${ap.vendor} (provável)` : ap.vendor) : null);
  if (ie && ie.apName) add('ap-name', 'Nome do ponto de acesso', ie.apName);
  if (ie && isObj(ie.wps) && (ie.wps.deviceName || ie.wps.model)) add('model', 'Modelo', ie.wps.deviceName || ie.wps.model);
  add('signal', 'Sinal', isNum(ap.rssi) ? `${fmtDbm(ap.rssi)}${level ? ` (${level.label.toLowerCase()})` : ''}` : null);
  add('band', 'Faixa', ap.band ? fmtBand(ap.band) : null);
  add('channel', 'Canal', isNum(ap.channel) ? String(ap.channel) : null);
  add('freq', 'Frequência', isNum(ap.freq) ? fmtFreq(ap.freq) : null);
  add('width', 'Largura do canal', isNum(ap.widthMHz) ? fmtWidth(ap.widthMHz) : null);
  add('range', 'Trecho ocupado', rangeText(ap.occ), coveredChannelsText(ap.occ) || undefined);
  add('standard', 'Padrão', ap.standardLabel || ap.standard);
  add('security', 'Segurança', isObj(ap.security) ? ap.security.label : null, securityWord(ap.security));
  if (isNum(extra.estMbps) && extra.estMbps > 0) add('speed', 'Velocidade estimada aqui', fmtMbps(extra.estMbps, { approx: true }), 'Estimativa pelo sinal e pela disputa do canal');
  if (isNum(extra.maxMbps) && extra.maxMbps > 0) add('max', 'Máximo teórico', fmtMbps(extra.maxMbps));
  add('distance', 'Distância estimada', isNum(ap.distanceM) ? fmtMeters(ap.distanceM, { approx: true }) : null, 'estimativa pelo sinal; paredes fazem parecer mais longe');
  add('antennas', 'Antenas', antennasText(ap.nss), 'fluxos de dados simultâneos');
  add('stations', 'Dispositivos conectados', isNum(ap.stations) ? String(ap.stations) : null, 'informado pelo roteador');
  add('utilization', 'Ocupação do canal', isNum(ap.utilization) ? fmtPct(ap.utilization * 100) : null, 'do tempo com alguém transmitindo, medido pelo roteador');
  if (ie) {
    add('country', 'País', ie.country);
    add('power', 'Potência anunciada', isNum(ie.txPowerDbm) ? `${ie.txPowerDbm}${THIN}dBm` : null);
    add('chipset', 'Chip do rádio (provável)', ie.chipsetHint);
  }
  add('first-seen', 'Visto pela primeira vez', isNum(ap.firstSeen) ? `${fmtClock(ap.firstSeen)} (${fmtAgo(now - ap.firstSeen)})` : null);
  add('last-seen', 'Visto pela última vez', isNum(ap.lastSeen) ? `${fmtClock(ap.lastSeen)} (${fmtAgo(now - ap.lastSeen)})` : null);
  return facts;
}

/**
 * Todos os detalhes de um BSSID em texto puro, para a área de transferência.
 * @param {object} ap
 * @param {Parameters<typeof apFacts>[1]} [extra]
 * @returns {string}
 */
export function apDetailsText(ap, extra = {}) {
  const lines = apFacts(ap, extra).map((f) => `${f.label}: ${f.value}`);
  const features = apFeatures(ap);
  if (features.length) {
    lines.push('');
    lines.push('Recursos:');
    for (const f of features) lines.push(`- ${f.label}: ${f.value || (f.on ? 'sim' : 'não')}`);
  }
  const issues = isObj(ap) && isObj(ap.security) && Array.isArray(ap.security.issues) ? ap.security.issues : [];
  if (issues.length) {
    lines.push('');
    lines.push('Pontos de atenção na segurança:');
    for (const issue of issues) if (issue && issue.text) lines.push(`- ${issue.text}`);
  }
  lines.push('');
  lines.push('Gerado pelo WiFi Raio-X');
  return lines.join('\n');
}
