// Exportar: funções puras que montam o CSV, o JSON e o relatório em texto.
// Sem DOM e sem dependências: roda igual no navegador e nos testes (tests/export-format.test.mjs).
//
//   apRecord(ap)                 -> registro simples de um BSSID (a base do CSV e do JSON)
//   networkRecord(rede)          -> registro de uma rede (nome + seus rádios) para o relatório
//   buildCsv(aps, opções)        -> texto CSV (padrão brasileiro: ";" e vírgula decimal)
//   buildJson(retrato, opções)   -> texto JSON (chaves em inglês, valores crus)
//   buildReport(dados)           -> relatório para ler e compartilhar (texto puro)
//   csvCell / csvQuote / neutralizeFormula / cleanText   peças do CSV, exportadas para os testes
//   fileName(tipo, extensão, quando) · utf8Length(texto) · formatBytes(n) · previewOf(texto, linhas)
//
// SEGURANÇA. Nome de rede, fabricante e nome de aparelho são texto hostil:
//   - CSV: um valor que começa com = + - @ (ou TAB/CR, ou as versões de largura cheia) seria
//     executado como fórmula pelo Excel/LibreOffice/Planilhas ("injeção de fórmula"). Esses
//     valores ganham um apóstrofo na frente. Aspas, o separador e quebras de linha são
//     protegidos com aspas duplas, como manda a RFC 4180. Números gerados aqui vão como número.
//   - Relatório: caracteres de controle e de direção de texto são trocados por "·", para um
//     nome de rede não conseguir quebrar a linha e "escrever" um trecho falso do relatório.
//   - JSON: JSON.stringify já protege tudo; os valores vão exatamente como o celular entregou.
//
// Os números do relatório usam hífen e espaço comuns ("-57 dBm"), e não os sinais tipográficos
// da interface: o texto vai para outros apps (mensagens, e-mail), onde eles nem sempre existem.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isText = (x) => typeof x === 'string' && x !== '';

// ---------------------------------------------------------------------------
// Texto seguro
// ---------------------------------------------------------------------------

// controles C0/C1, separadores de linha/parágrafo e marcas de direção (bidi)
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Troca caracteres de controle e de direção de texto por "·" (o texto fica numa linha só). */
export function cleanText(value) {
  return String(value ?? '').replace(UNSAFE_CHARS, '·');
}

const FORMULA_START = /^[=+\-@\t\r\uff1d\uff0b\uff0d\uff20]/;

/**
 * Impede que uma planilha trate o texto como fórmula: se ele começa com = + - @ (ou TAB, CR,
 * ou as formas de largura cheia desses sinais), ganha um apóstrofo na frente.
 * @param {string} text
 * @returns {string}
 */
export function neutralizeFormula(text) {
  const value = String(text ?? '');
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/**
 * Protege um campo de CSV (RFC 4180): com aspas, separador, quebra de linha ou espaço nas
 * pontas, o campo vai entre aspas duplas e as aspas de dentro são dobradas.
 * @param {string} text
 * @param {string} [delimiter=';']
 */
export function csvQuote(text, delimiter = ';') {
  const value = String(text ?? '');
  const needs = value.includes('"') || value.includes(delimiter) || value.includes(',') || value.includes(';') || /[\r\n]/.test(value) || /^\s|\s$/.test(value);
  return needs ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Uma célula de CSV a partir de um valor qualquer.
 * Número -> número (com o separador decimal pedido); booleano -> "sim"/"não"; vazio -> "";
 * texto -> limpo, neutralizado contra fórmulas e protegido com aspas quando preciso.
 * @param {*} value
 * @param {{delimiter?:string, decimal?:string}} [options]
 */
export function csvCell(value, { delimiter = ';', decimal = ',' } = {}) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const text = String(value).replace('.', decimal);
    // com "," de separador de campos e de decimais ao mesmo tempo, o número precisa de aspas
    return text.includes(delimiter) ? `"${text}"` : text;
  }
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  return csvQuote(neutralizeFormula(cleanText(value)), delimiter);
}

// ---------------------------------------------------------------------------
// Registros
// ---------------------------------------------------------------------------

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * @typedef {Object} ApRecord
 * @property {string} ssid               nome cru ("" = oculta)
 * @property {boolean} hidden
 * @property {string} bssid
 * @property {string|null} vendor
 * @property {boolean} vendorGuess       fabricante provável (BSSID virtual)
 * @property {number|null} rssi          dBm
 * @property {number|null} quality       0..100
 * @property {string|null} band          '2.4' | '5' | '6' | '60'
 * @property {number|null} channel
 * @property {number|null} frequencyMHz
 * @property {number|null} widthMHz
 * @property {string|null} standard      "Wi-Fi 6"
 * @property {string|null} security      rótulo: "WPA2", "Aberta"...
 * @property {number|null} securityLevel 0..4
 * @property {string[]} securityIssues   códigos de core/security.js
 * @property {boolean|null} wps
 * @property {number|null} distanceM     estimativa pelo sinal (1 casa)
 * @property {boolean} connected
 * @property {boolean} mine              rede marcada como minha ou rádio do roteador em uso
 * @property {number|null} ageS          há quantos segundos foi ouvida
 * @property {number|null} stations      aparelhos conectados, quando o roteador informa
 * @property {number|null} utilizationPct ocupação do canal, quando o roteador informa
 */

/**
 * Registro simples de um Ap do store (core/model.js + campos do store). Nunca lança.
 * @param {object} ap
 * @returns {ApRecord}
 */
export function apRecord(ap) {
  const a = ap && typeof ap === 'object' ? ap : {};
  const sec = a.security && typeof a.security === 'object' ? a.security : null;
  const known = !!sec && sec.known !== false;
  return {
    ssid: typeof a.ssid === 'string' ? a.ssid : '',
    hidden: a.hidden === true || !isText(a.ssid),
    bssid: typeof a.bssid === 'string' ? a.bssid : '',
    vendor: isText(a.vendor) ? a.vendor : null,
    vendorGuess: a.vendorGuess === true,
    rssi: isNum(a.rssi) ? Math.round(a.rssi) : null,
    quality: isNum(a.rssi) && isNum(a.quality) ? Math.round(a.quality) : null,
    band: isText(a.band) ? a.band : null,
    channel: isNum(a.channel) ? a.channel : null,
    frequencyMHz: isNum(a.freq) ? a.freq : null,
    widthMHz: isNum(a.widthMHz) ? a.widthMHz : null,
    standard: isText(a.standard) && isNum(a.gen) ? a.standard : null,
    security: known && isText(sec.label) ? sec.label : null,
    securityLevel: known && isNum(sec.level) ? sec.level : null,
    securityIssues: known && Array.isArray(sec.issues) ? sec.issues.map((i) => (i && typeof i.code === 'string' ? i.code : null)).filter(Boolean) : [],
    wps: known ? sec.wps === true : null,
    distanceM: isNum(a.distanceM) ? round1(a.distanceM) : null,
    connected: a.connected === true,
    mine: a.favorite === true || a.own === true,
    ageS: isNum(a.ageMs) ? Math.round(a.ageMs / 1000) : null,
    stations: isNum(a.stations) ? a.stations : null,
    utilizationPct: isNum(a.utilization) ? Math.round(a.utilization * 100) : null,
  };
}

/**
 * Registro de uma rede do store (state.networks: um nome com todos os seus rádios).
 * @param {object} net
 * @returns {{name:string, hidden:boolean, bands:string[], channels:number[], bestRssi:number|null,
 *            security:string|null, radios:number, connected:boolean, mine:boolean}}
 */
export function networkRecord(net) {
  const n = net && typeof net === 'object' ? net : {};
  const aps = Array.isArray(n.aps) ? n.aps.filter((a) => a && typeof a === 'object') : [];
  let best = null;
  for (const ap of aps) if (isNum(ap.rssi) && (best === null || ap.rssi > best)) best = ap.rssi;
  const sec = n.security && typeof n.security === 'object' && n.security.known !== false ? n.security : null;
  const bands = Array.isArray(n.bands) ? n.bands.filter(isText) : [];
  return {
    name: isText(n.ssid) ? n.ssid : '',
    hidden: n.hidden === true || !isText(n.ssid),
    bands: bands.length ? bands : [...new Set(aps.map((a) => a.band).filter(isText))],
    channels: [...new Set(aps.map((a) => a.channel).filter(isNum))].sort((x, y) => x - y),
    bestRssi: best === null ? null : Math.round(best),
    security: sec && isText(sec.label) ? sec.label : null,
    radios: aps.length,
    connected: aps.some((a) => a.connected === true),
    mine: aps.some((a) => a.favorite === true || a.own === true),
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Colunas do CSV, na ordem: título e de onde sai o valor. */
export const CSV_COLUMNS = Object.freeze([
  { title: 'Nome da rede (SSID)', value: (r) => (r.hidden ? '(rede oculta)' : r.ssid) },
  { title: 'BSSID', value: (r) => r.bssid },
  { title: 'Fabricante', value: (r) => (r.vendor ? (r.vendorGuess ? `${r.vendor} (provável)` : r.vendor) : '') },
  { title: 'Sinal (dBm)', value: (r) => r.rssi },
  { title: 'Qualidade (%)', value: (r) => r.quality },
  { title: 'Faixa (GHz)', value: (r) => (r.band === null ? null : Number(r.band)) },
  { title: 'Canal', value: (r) => r.channel },
  { title: 'Frequência (MHz)', value: (r) => r.frequencyMHz },
  { title: 'Largura (MHz)', value: (r) => r.widthMHz },
  { title: 'Padrão', value: (r) => r.standard ?? '' },
  { title: 'Segurança', value: (r) => r.security ?? '' },
  { title: 'Distância estimada (m)', value: (r) => r.distanceM },
  { title: 'Conectada', value: (r) => r.connected },
  { title: 'Minha rede', value: (r) => r.mine },
  { title: 'Oculta', value: (r) => r.hidden },
  { title: 'Ouvida há (s)', value: (r) => r.ageS },
  { title: 'Aparelhos conectados', value: (r) => r.stations },
  { title: 'Ocupação do canal (%)', value: (r) => r.utilizationPct },
]);

/**
 * A lista de redes em CSV: uma linha por BSSID, com cabeçalho.
 * O padrão é o que o Excel brasileiro abre direto: ";" entre os campos e vírgula decimal.
 * @param {object[]} aps  Ap do store (ou já ApRecord)
 * @param {{delimiter?:string, decimal?:string, eol?:string, bom?:boolean}} [options]
 *        bom = começa com a marca UTF-8 (o Excel precisa dela para acertar os acentos)
 * @returns {string}
 */
export function buildCsv(aps, { delimiter = ';', decimal = ',', eol = '\r\n', bom = false } = {}) {
  const opts = { delimiter, decimal };
  const lines = [CSV_COLUMNS.map((c) => csvCell(c.title, opts)).join(delimiter)];
  for (const ap of Array.isArray(aps) ? aps : []) {
    const rec = ap && typeof ap === 'object' && 'securityIssues' in ap ? ap : apRecord(ap);
    lines.push(CSV_COLUMNS.map((c) => csvCell(c.value(rec), opts)).join(delimiter));
  }
  return (bom ? '\ufeff' : '') + lines.join(eol) + eol;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const isoOf = (ms) => (isNum(ms) ? new Date(ms).toISOString() : null);

/**
 * O retrato atual em JSON, para quem quer processar os dados.
 * @param {{generatedAt?:number, appVersion?:string, device?:object|null, connection?:object|null,
 *          scannedAt?:number|null, aps?:object[]}} snapshot
 * @param {{indent?:number}} [options]
 * @returns {string}
 */
export function buildJson(snapshot, { indent = 2 } = {}) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const dev = s.device && typeof s.device === 'object' ? s.device : null;
  const conn = s.connection && typeof s.connection === 'object' && s.connection.connected === true ? s.connection : null;
  const networks = (Array.isArray(s.aps) ? s.aps : []).map(apRecord);
  const out = {
    app: 'WiFi Raio-X',
    appVersion: isText(s.appVersion) ? s.appVersion : null,
    format: 1,
    generatedAt: isoOf(isNum(s.generatedAt) ? s.generatedAt : Date.now()),
    scannedAt: isoOf(s.scannedAt),
    device: dev
      ? {
          platform: isText(dev.platform) ? dev.platform : null,
          manufacturer: isText(dev.manufacturer) ? dev.manufacturer : null,
          model: isText(dev.model) ? dev.model : null,
          android: isText(dev.release) ? dev.release : null,
        }
      : null,
    connection: conn
      ? {
          ssid: typeof conn.ssid === 'string' ? conn.ssid : null,
          bssid: typeof conn.bssid === 'string' ? conn.bssid : null,
          rssi: isNum(conn.rssi) ? conn.rssi : null,
          frequencyMHz: isNum(conn.frequency) ? conn.frequency : null,
          linkSpeedMbps: isNum(conn.linkSpeed) ? conn.linkSpeed : null,
          rxSpeedMbps: isNum(conn.rxSpeed) ? conn.rxSpeed : null,
          txSpeedMbps: isNum(conn.txSpeed) ? conn.txSpeed : null,
        }
      : null,
    count: networks.length,
    networks,
  };
  return `${JSON.stringify(out, null, indent)}\n`;
}

// ---------------------------------------------------------------------------
// Relatório em texto
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/** "15/11/2026 14:32" na hora local. */
export function dateTimeText(ms) {
  if (!isNum(ms)) return '';
  const d = new Date(ms);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const numText = (n, digits = 0) => (isNum(n) ? n.toFixed(digits).replace('.', ',') : '?');
const dbmText = (rssi) => (isNum(rssi) ? `${Math.round(rssi)} dBm` : 'sinal desconhecido');
const bandText = (band) => (isText(band) ? `${String(band).replace('.', ',')} GHz` : '');

function mbpsText(mbps) {
  if (!isNum(mbps) || mbps < 0) return '?';
  if (mbps >= 995) return `${numText(mbps / 1000, 1).replace(/,0$/, '')} Gb/s`;
  return `${numText(mbps, mbps < 9.95 ? 1 : 0).replace(/,0$/, '')} Mb/s`;
}

function agoText(ms) {
  if (!isNum(ms)) return '';
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 5) return 'agora';
  if (sec < 60) return `há ${sec} s`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `há ${min} min` : `há ${Math.floor(min / 60)} h`;
}

const LEVEL_WORDS = [
  [-50, 'excelente'],
  [-60, 'ótimo'],
  [-67, 'bom'],
  [-75, 'regular'],
  [-82, 'fraco'],
  [-Infinity, 'muito fraco'],
];
const levelWord = (rssi) => (isNum(rssi) ? LEVEL_WORDS.find(([min]) => rssi >= min)[1] : 'sem leitura');

const SEVERITY_WORD = { critical: 'Crítico', warning: 'Atenção', info: 'Informação', good: 'Tudo certo' };

/**
 * Nome de rede para o relatório: limpo e entre aspas (ou "rede oculta"). As aspas que o próprio
 * nome tiver viram apóstrofo: um vizinho pode chamar a rede dele de `Casa" · -41 dBm · WPA3 · "`,
 * e com as aspas intactas a linha pareceria trazer uma rede "Casa" forte e segura (ou, no ranking,
 * uma nota inventada). Com um único par de aspas, tudo o que é nome fica visivelmente dentro dele.
 */
const quoted = (name) => (isText(name) && cleanText(name).trim() !== '' ? `"${cleanText(name).replace(/["\u201c\u201d\u201e\u201f\u00ab\u00bb\uff02]/g, "'")}"` : '(rede oculta)');
/** Distância estimada: uma casa decimal só abaixo de 3 m, e sem ",0". */
const metersText = (m) => `${numText(m, m < 2.95 ? 1 : 0).replace(/,0$/, '')} m`;
// as frases que vêm das análises usam os sinais tipográficos da interface: aqui viram os comuns
const TYPOGRAPHIC_SPACES = /[\u00a0\u2009\u202f]/g;
const plain = (text) => String(text ?? '').replace(/\u2212/g, '-').replace(TYPOGRAPHIC_SPACES, ' ');
// frase das análises: quebras de linha e tabulações viram espaço; o resto dos controles, "·"
const para = (text) => cleanText(plain(text).replace(/[\t\n\v\f\r]+/g, ' ')).replace(/\s+/g, ' ').trim();

function section(title) {
  return ['', title, '-'.repeat(Array.from(title).length)];
}

/**
 * Relatório para ler e compartilhar.
 *
 * @param {object} data
 * @param {number} [data.generatedAt]
 * @param {string} [data.appVersion]
 * @param {object|null} [data.device]        DeviceInfo
 * @param {number|null} [data.dataAgeMs]     idade da lista de redes
 * @param {object|null} [data.connection]    { ssid, rssi, band, channel, widthMHz, linkSpeed, standard, security, distanceM }
 * @param {{headline:string, text:string}|null} [data.advice]   de core/best-network.js advise()
 * @param {{name:string, hidden:boolean, score:number, estMbps:number|null, connected:boolean, mine:boolean}[]|null} [data.ranking]
 * @param {{band:string, text:string}[]} [data.channels]         uma frase por faixa (recommendChannel)
 * @param {{severity:string, title:string, text:string}[]|null} [data.insights]  null = diagnóstico indisponível
 * @param {ReturnType<typeof networkRecord>[]} [data.networks]   da mais forte para a mais fraca
 * @param {number} [data.signals]            total de BSSIDs ouvidos
 * @param {number} [data.limit=25]           máximo de redes listadas
 * @returns {string}
 */
export function buildReport(data) {
  const d = data && typeof data === 'object' ? data : {};
  const out = ['WiFi Raio-X - relatório do Wi-Fi'];

  const dev = d.device && typeof d.device === 'object' ? d.device : null;
  const phone = dev && dev.platform !== 'sim' ? [dev.manufacturer, dev.model].filter(isText).map(para).join(' ') : '';
  const android = dev && dev.platform !== 'sim' && isText(dev.release) ? ` (Android ${para(dev.release)})` : '';
  const when = dateTimeText(isNum(d.generatedAt) ? d.generatedAt : Date.now());
  out.push([when, phone ? `${phone}${android}` : dev && dev.platform === 'sim' ? 'modo demonstração (dados simulados)' : ''].filter(Boolean).join(' · '));
  if (isNum(d.dataAgeMs) && d.dataAgeMs >= 30_000) out.push(`Atenção: a lista de redes é de ${agoText(d.dataAgeMs)}.`);

  // --- conexão
  out.push(...section('Conexão'));
  const c = d.connection && typeof d.connection === 'object' ? d.connection : null;
  if (!c) out.push('O celular não estava conectado a um Wi-Fi.');
  else {
    const where = [bandText(c.band), isNum(c.channel) ? `canal ${c.channel}` : '', isNum(c.widthMHz) ? `${c.widthMHz} MHz` : ''].filter(Boolean).join(', ');
    out.push(`Rede: ${quoted(c.ssid)}${where ? ` (${where})` : ''}`);
    if (isNum(c.rssi)) out.push(`Sinal: ${dbmText(c.rssi)} (${levelWord(c.rssi)})`);
    if (isNum(c.linkSpeed) && c.linkSpeed > 0) out.push(`Velocidade entre o celular e o roteador: ${mbpsText(c.linkSpeed)}`);
    if (isNum(c.distanceM)) out.push(`Distância do roteador: cerca de ${metersText(c.distanceM)} (estimativa pelo sinal)`);
    if (isText(c.standard)) out.push(`Padrão: ${para(c.standard)}`);
    if (isText(c.security)) out.push(`Segurança: ${para(c.security)}`);
  }

  // --- melhor rede
  const ranking = Array.isArray(d.ranking) ? d.ranking.filter((r) => r && typeof r === 'object') : [];
  const advice = d.advice && typeof d.advice === 'object' && isText(d.advice.headline) ? d.advice : null;
  if (advice || ranking.length) {
    out.push(...section('Melhor rede aqui'));
    if (advice) {
      out.push(para(advice.headline));
      if (isText(advice.text)) out.push(para(advice.text));
    }
    ranking.slice(0, 5).forEach((r, i) => {
      const tags = [r.connected ? 'conectada' : '', r.mine ? 'minha' : ''].filter(Boolean).join(', ');
      const speed = isNum(r.estMbps) && r.estMbps > 0 ? `, cerca de ${mbpsText(r.estMbps)}` : '';
      out.push(`${i + 1}. ${quoted(r.hidden ? '' : r.name)}: nota ${isNum(r.score) ? Math.round(r.score) : '?'} de 100${speed}${tags ? ` (${tags})` : ''}`);
    });
    if (ranking.some((r) => isNum(r.estMbps))) out.push('(As velocidades são estimativas para este ponto da casa.)');
  }

  // --- melhor canal
  const channels = (Array.isArray(d.channels) ? d.channels : []).filter((ch) => ch && isText(ch.text));
  if (channels.length) {
    out.push(...section('Melhor canal para o roteador'));
    for (const ch of channels) out.push(`${bandText(ch.band)}: ${para(ch.text)}`);
  }

  // --- diagnóstico
  if (Array.isArray(d.insights)) {
    out.push(...section('Diagnóstico'));
    const list = d.insights.filter((i) => i && isText(i.title));
    if (!list.length) out.push('Nenhum problema encontrado nesta análise.');
    for (const item of list) {
      out.push(`[${SEVERITY_WORD[item.severity] || 'Informação'}] ${para(item.title)}`);
      if (isText(item.text)) out.push(`  ${para(item.text)}`);
    }
  }

  // --- redes
  const networks = (Array.isArray(d.networks) ? d.networks : []).filter((n) => n && typeof n === 'object');
  const limit = isNum(d.limit) && d.limit > 0 ? Math.floor(d.limit) : 25;
  const signals = isNum(d.signals) ? d.signals : networks.reduce((sum, n) => sum + (isNum(n.radios) ? n.radios : 0), 0);
  const count = `${networks.length} ${networks.length === 1 ? 'rede' : 'redes'}, ${signals} ${signals === 1 ? 'sinal' : 'sinais'}`;
  out.push(...section(`Redes ao redor (${count})`));
  if (!networks.length) out.push('Nenhuma rede ao alcance.');
  networks.slice(0, limit).forEach((n, i) => {
    const bands = (Array.isArray(n.bands) ? n.bands : []).map(bandText).filter(Boolean).join(' e ');
    const chans = Array.isArray(n.channels) && n.channels.length ? `${n.channels.length === 1 ? 'canal' : 'canais'} ${n.channels.join(', ')}` : '';
    const tags = [n.connected ? 'conectada' : '', n.mine ? 'minha' : '', isNum(n.radios) && n.radios > 1 ? `${n.radios} rádios` : ''].filter(Boolean).join(', ');
    const parts = [`${dbmText(n.bestRssi)} (${levelWord(n.bestRssi)})`, [bands, chans].filter(Boolean).join(' '), isText(n.security) ? para(n.security) : '', tags];
    out.push(`${String(i + 1).padStart(2, ' ')}. ${quoted(n.hidden ? '' : n.name)} · ${parts.filter(Boolean).join(' · ')}`);
  });
  if (networks.length > limit) out.push(`... e mais ${networks.length - limit} ${networks.length - limit === 1 ? 'rede mais fraca' : 'redes mais fracas'}.`);

  out.push('', 'Distâncias e velocidades são estimativas calculadas a partir do sinal.');
  out.push(`Gerado no celular pelo WiFi Raio-X${isText(d.appVersion) ? ` ${para(d.appVersion)}` : ''}. Nada foi enviado para a internet.`);
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Arquivo e prévia
// ---------------------------------------------------------------------------

/** "wifi-raio-x-redes-20261115-1432.csv" (hora local). */
export function fileName(kind, ext, when = Date.now()) {
  const d = new Date(when);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  const safe = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `wifi-raio-x-${safe(kind)}-${stamp}.${safe(ext)}`;
}

/**
 * Nome do arquivo exportado. O que sai do modo demonstração leva "demonstracao" no nome: os dados
 * são de uma casa virtual, e um arquivo sem marca nenhuma poderia ser passado adiante como se
 * fosse a medição de um lugar de verdade (a planilha não tem onde dizer isso por dentro).
 *   exportFileName('redes', 'csv', { demo: true }) -> "wifi-raio-x-redes-demonstracao-20261115-1432.csv"
 */
export function exportFileName(kind, ext, { demo = false, when = Date.now() } = {}) {
  return fileName(demo ? `${kind}-demonstracao` : kind, ext, when);
}

/** Tamanho do texto em bytes (UTF-8), como ele vai para o arquivo. */
export function utf8Length(text) {
  const value = String(text ?? '');
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** 532 -> "532 bytes"; 3276 -> "3,2 kB"; 2500000 -> "2,4 MB". */
export function formatBytes(n) {
  if (!isNum(n) || n < 0) return '';
  if (n < 1000) return `${n} ${n === 1 ? 'byte' : 'bytes'}`;
  if (n < 1024 * 1024) return `${numText(n / 1024, n < 10_240 ? 1 : 0)} kB`;
  return `${numText(n / (1024 * 1024), 1)} MB`;
}

/**
 * As primeiras linhas de um texto, para a prévia na tela.
 * @param {string} text
 * @param {number} [maxLines=16]
 * @returns {{text:string, shown:number, total:number, more:number}}
 */
export function previewOf(text, maxLines = 16) {
  const lines = String(text ?? '').replace(/^\ufeff/, '').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, Math.max(1, maxLines));
  return { text: shown.join('\n'), shown: shown.length, total: lines.length, more: Math.max(0, lines.length - shown.length) };
}
