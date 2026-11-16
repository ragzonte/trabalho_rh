// Melhor Wi-Fi — "em qual Wi-Fi eu devo ficar aqui?" e o diagnóstico automático.
//
// De cima para baixo:
//   1. a recomendação (core advise): uma frase de veredito, uma de motivo e, quando há o que
//      fazer, o botão que abre o Wi-Fi do celular. É o que um leigo lê em cinco segundos;
//   2. a dica (dispensável) para marcar as "minhas redes";
//   3. o ranking das redes ao alcance (core rankNetworks): nota de 0 a 100 em anel, velocidade
//      estimada aqui, a melhor faixa, prós e contras curtos e os avisos. Tocar numa rede abre o
//      painel com as quatro partes da nota, a conta e os outros pontos de acesso da rede;
//   4. o diagnóstico (core buildInsights): problemas em cartões, por gravidade, com o botão
//      que leva à tela que resolve; as observações ficam recolhidas em "Bom saber".
//
// A análise é refeita uma vez por varredura (e quando mudam a conexão ou as redes marcadas),
// nunca a cada leitura de sinal. Cada região é atualizada no lugar com patch(): a rolagem não
// pula e os painéis abertos acompanham os dados novos sem fechar.
//
// "Minhas redes" = store.favorites (toggleFavorite / setFavorite). A rede conectada e as outras
// redes do mesmo roteador contam como da pessoa mesmo sem estrela.
//
// Rota: #/melhor abre no topo; #/melhor?ver=diagnostico e #/melhor?ver=ranking abrem a tela já
// rolada até aquela parte (para os atalhos das outras telas).
//
// As contas que não dependem da tela (palavra da nota, linhas visíveis, partes e motivos da
// nota, resumo do diagnóstico) são funções puras exportadas, com testes em tests/best.test.mjs.
//
// Nomes de rede são texto hostil: tudo entra por h() (textContent), nunca por HTML.

import { h, nb, s, mount as render, patch, sheet, toast, fmtDbm, fmtMbps, fmtAgo, fmtPct, plural, NO_VALUE } from '../dom.js';
import { icon } from '../icons.js';
import { badge, bandBadge, securityBadge, standardBadge, signalBars, ssidLabel, displaySsid, button, switchRow, sectionHeader, banner, tipBanner, emptyState, skeletonList, meter, openThrottleHelp, throttleCopy } from '../components.js';
import { signalLevel } from '../../core/signal.js';
import { rankNetworks, advise, speedScore, isInsecure, formatGain, INSECURE_FACTOR, WEAK_SECURITY_FACTOR, WPA3_BONUS, SPEED_GOOD_MBPS, SPEED_GOOD_SCORE, SPEED_TOP_MBPS } from '../../core/best-network.js';
import { buildInsights } from '../../core/insights.js';
import { liveConnection, liveSignalKey, LIVE_RSSI_SAMPLES } from '../networks-logic.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object';

/** Quantas redes o ranking mostra antes do "mostrar as outras". */
export const TOP_ROWS = 5;
/** Dados mais velhos que isto ganham a idade escrita junto da recomendação (com o limite do Android as buscas vêm a cada ~30 s). */
const STALE_NOTE_MS = 40_000;
/** De quanto em quanto tempo a idade escrita é atualizada. */
const AGE_TICK_MS = 5000;
const PREFS_KEY = 'melhor';
const TIP_ID = 'best-mine';

// ---------------------------------------------------------------------------
// Contas puras (testadas em tests/best.test.mjs)
// ---------------------------------------------------------------------------

/**
 * A nota em palavras e em um dos cinco degraus de cor (1 = melhor). Os cortes seguem a escala
 * de core/best-network.js: 60 pontos = 20 Mb/s ("dá e sobra"), e cada vez que a velocidade
 * dobra são mais 9 pontos.
 * @param {number} score 0..100
 * @param {boolean} [usable=true]  false = o celular não consegue usar esta rede
 * @returns {{step: 1|2|3|4|5, word: string}}
 */
export function scoreLook(score, usable = true) {
  if (!usable) return { step: 5, word: 'Sem uso' };
  // a palavra acompanha o número que aparece na tela (arredondado): 69,6 mostra "70" e é "Ótima"
  const value = isNum(score) ? Math.round(score) : 0;
  if (value >= 85) return { step: 1, word: 'Excelente' };
  if (value >= 70) return { step: 1, word: 'Ótima' };
  if (value >= 55) return { step: 2, word: 'Boa' };
  if (value >= 40) return { step: 3, word: 'Regular' };
  if (value >= 20) return { step: 4, word: 'Fraca' };
  return { step: 5, word: 'Ruim' };
}

/**
 * Velocidade estimada com dois algarismos significativos, como nas frases de advise()
 * ("cerca de 620 Mb/s"): 619.7 -> 620; 462.8 -> 460; 7.46 -> 7.5. Inválido -> null.
 * @param {number} mbps
 * @returns {number|null}
 */
export function roundEstimate(mbps) {
  if (!isNum(mbps) || mbps < 0) return null;
  if (mbps < 9.95) return Math.round(mbps * 10) / 10;
  const magnitude = 10 ** (Math.floor(Math.log10(mbps)) - 1);
  return Math.round(mbps / magnitude) * magnitude;
}

/** Velocidade estimada como texto: "≈ 620 Mb/s". Sem valor: "—". */
export function estText(mbps) {
  const value = roundEstimate(mbps);
  return value === null ? NO_VALUE : fmtMbps(value, { approx: true });
}

/** Todos os BSSIDs de uma linha do ranking, do melhor para o pior: [{ap, score, estMbps, deviceId}]. */
export function rowEntries(row) {
  if (!isObj(row) || !isObj(row.best)) return [];
  const first = { ap: row.best, score: row.score, estMbps: row.estMbps, deviceId: row.deviceId ?? null };
  const rest = Array.isArray(row.others) ? row.others.filter((e) => isObj(e) && isObj(e.ap)) : [];
  return [first, ...rest];
}

/**
 * A rede é da pessoa? Vale a estrela ("minha rede"), a rede em uso e as outras redes do mesmo
 * roteador (a marca `own` que o store põe em cada Ap).
 */
export function isMine(row) {
  if (!isObj(row)) return false;
  if (row.favorite === true || row.connected === true) return true;
  return rowEntries(row).some((e) => e.ap.own === true);
}

/**
 * As linhas que o ranking mostra agora.
 * @param {object[]} ranking  resultado de rankNetworks
 * @param {{mineOnly?: boolean, expanded?: boolean, limit?: number}} [options]
 * @returns {{rows: object[], total: number, more: number}}  more = quantas ficaram recolhidas
 */
export function visibleRows(ranking, { mineOnly = false, expanded = false, limit = TOP_ROWS } = {}) {
  const all = (Array.isArray(ranking) ? ranking : []).filter((row) => isObj(row) && (!mineOnly || isMine(row)));
  // não vale esconder uma linha só atrás de um botão
  const rows = expanded || all.length <= limit + 1 ? all : all.slice(0, limit);
  return { rows, total: all.length, more: all.length - rows.length };
}

const SPEED_PHRASE = /\b[MG]b\/s\b/;

/** Um aviso em poucas palavras: o que vem antes dos dois-pontos ("Sinal no limite: a conexão…" -> "Sinal no limite"). */
export function shortWarning(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  const cut = value.indexOf(': ');
  return (cut > 0 ? value.slice(0, cut) : value).replace(/\.$/, '');
}

/**
 * O que cabe na linha do ranking: no máximo `max` frases, entre o aviso (só o começo; a frase
 * inteira fica no painel), os contras e os prós, nessa ordem de prioridade. As frases que só
 * repetem a velocidade ficam de fora: ela já aparece em destaque ao lado.
 * @returns {{pros: string[], cons: string[], warning: string|null, moreWarnings: number}}
 */
export function rowNotes(row, { max = 3 } = {}) {
  const clean = (list) => (Array.isArray(list) ? list : []).filter((t) => typeof t === 'string' && t.trim() !== '');
  const warnings = clean(row && row.warnings);
  const warning = warnings.length ? shortWarning(warnings[0]) : null;
  let left = Math.max(0, max - (warning ? 1 : 0));
  const cons = clean(row && row.cons)
    .filter((t) => !SPEED_PHRASE.test(t))
    .slice(0, Math.min(2, left));
  left -= cons.length;
  const pros = clean(row && row.pros)
    .filter((t) => !SPEED_PHRASE.test(t))
    .slice(0, Math.min(2, left));
  return { pros, cons, warning, moreWarnings: Math.max(0, warnings.length - 1) };
}

const partTone = (value) => (value >= 70 ? 'good' : value >= 40 ? 'warning' : 'critical');
const pct = (x) => (isNum(x) ? Math.round(Math.min(100, Math.max(0, x))) : 0);

const SECURITY_WORD = ['aberta', 'quebrada', 'fraca', 'boa', 'forte'];
const SECURITY_TEXT = [
  'Sem senha e sem criptografia: quem estiver por perto pode ver o que trafega.',
  'WEP é quebrado em minutos: na prática, é como não ter senha.',
  'Protocolo antigo (WPA/TKIP), mais fácil de quebrar que os atuais.',
  'Protegida por senha e criptografia.',
  'Criptografia atual, a mais difícil de quebrar.',
];

function congestionText(detail) {
  const co = detail.coChannel;
  const over = detail.overlapping;
  const bits = [];
  if (isNum(co) && co > 0) {
    bits.push(`Divide o canal com ${plural(co, 'rede', 'redes')}${isNum(over) && over > 0 ? ` e recebe interferência de ${plural(over, 'rede', 'redes')} em canais vizinhos` : ''}.`);
  } else if (isNum(over) && over > 0) {
    bits.push(`Recebe interferência de ${plural(over, 'rede', 'redes')} em canais vizinhos.`);
  } else if (co === 0 && over === 0) {
    bits.push('Nenhuma outra rede disputa este canal.');
  }
  if (isNum(detail.stations)) bits.push(`O roteador informa ${plural(detail.stations, 'aparelho conectado', 'aparelhos conectados')}.`);
  if (isNum(detail.utilization)) bits.push(`${isNum(detail.stations) ? 'Segundo ele' : 'Segundo o roteador'}, o canal fica ocupado ${fmtPct(detail.utilization * 100)} do tempo.`);
  return bits.join(' ');
}

/**
 * O sinal de um ponto de acesso como a nota o usou: a média recente (rssiSmooth), e só sem ela a
 * última leitura. O painel "Entenda a nota" mostra este valor na parte "Sinal" e em cada linha da
 * lista de sinais da rede: os dois números saem da mesma conta.
 * @param {{rssi?:number, rssiSmooth?:number}} ap
 * @returns {number|null}
 */
export function apSignal(ap) {
  if (!isObj(ap)) return null;
  return isNum(ap.rssiSmooth) ? ap.rssiSmooth : isNum(ap.rssi) ? ap.rssi : null;
}

/**
 * As quatro partes da nota, prontas para virar barras.
 * @param {object} row  linha de rankNetworks
 * @returns {{id: 'signal'|'speed'|'congestion'|'security', icon: string, label: string, value: number,
 *            tone: 'good'|'warning'|'critical', headline: string, text: string}[]}
 *          value = 0..100 (barra cheia é sempre bom); headline = o número que importa; text = o que ele quer dizer
 */
export function scoreParts(row) {
  const parts = isObj(row) && isObj(row.parts) ? row.parts : {};
  const detail = isObj(row) && isObj(row.detail) ? row.detail : {};
  const security = isObj(row) && isObj(row.security) ? row.security : {};
  const level = signalLevel(detail.rssi);

  const share = pct(parts.congestion);
  const crowd = share >= 85 ? 'sem congestionamento' : share >= 60 ? 'pouco congestionamento' : share >= 35 ? 'congestionado' : 'muito congestionado';
  const secLevel = security.known === true && Number.isInteger(security.level) && security.level >= 0 && security.level <= 4 ? security.level : null;
  const secLabel = typeof security.label === 'string' && security.label ? security.label : 'Desconhecida';

  const make = (id, iconName, label, value, headline, text) => ({ id, icon: iconName, label, value: pct(value), tone: partTone(pct(value)), headline, text });
  return [
    make('signal', 'signal', 'Sinal', parts.signal, isNum(detail.rssi) ? `${fmtDbm(detail.rssi)} · ${level.label.toLowerCase()}` : 'sem leitura', 'A força com que a rede chega neste ponto, na média das últimas leituras.'),
    make(
      'speed',
      'speed',
      'Velocidade',
      parts.speed,
      isNum(detail.linkMbps) ? `até ${estText(detail.linkMbps)}` : 'sem estimativa',
      'O que este sinal sustenta entre o roteador e o seu celular, com o canal só para você.',
    ),
    make(
      'congestion',
      'users',
      'Canal livre',
      parts.congestion,
      detail.share == null ? 'sem estimativa' : crowd,
      [detail.share == null ? 'Quanto do tempo o canal fica livre para o seu celular.' : `Sobra cerca de ${fmtPct(share)} do tempo do canal para o seu celular.`, congestionText(detail)].filter(Boolean).join(' '),
    ),
    make(
      'security',
      'lock',
      'Segurança',
      parts.security,
      secLevel === null ? 'Desconhecida' : secLevel === 0 ? 'Aberta' : `${secLabel} · ${SECURITY_WORD[secLevel]}`,
      secLevel === null ? 'O celular não informou como esta rede é protegida.' : SECURITY_TEXT[secLevel],
    ),
  ];
}

/**
 * A conta da nota em frases, na ordem em que ela é feita (veja o modelo em core/best-network.js).
 * @param {object} row  linha de rankNetworks
 * @returns {string[]}
 */
export function scoreReasons(row) {
  const detail = isObj(row) && isObj(row.detail) ? row.detail : {};
  const security = isObj(row) && isObj(row.security) ? row.security : {};
  const out = [];
  if (detail.usable !== true) {
    if (row && row.estMbps === 0) out.push('Este celular não funciona na faixa desta rede: não dá para usá-la, e por isso a nota é zero.');
    else out.push('Com o que o celular informou não deu para estimar a velocidade desta rede, então ela fica sem nota.');
    return out;
  }
  const base = speedScore(row.estMbps);
  const share = isNum(detail.share) ? fmtPct(detail.share * 100) : NO_VALUE;
  out.push(`Velocidade esperada aqui: ${estText(row.estMbps)}. É o que o sinal sustenta (${estText(detail.linkMbps)}) vezes a parte do tempo em que o canal fica livre para você (${share}).`);
  out.push(`Essa velocidade vale ${Math.round(base)} pontos: ${SPEED_GOOD_MBPS} Mb/s já valem ${SPEED_GOOD_SCORE}, e de ${SPEED_TOP_MBPS} Mb/s para cima valem 100.`);

  let running = base;
  if (isNum(detail.cap) && detail.cap < base - 0.5) {
    out.push(`O sinal fraco (${fmtDbm(detail.rssi)}) segura a nota em no máximo ${Math.round(detail.cap)}: perto do limite a conexão cai, por mais rápida que seja no papel.`);
    running = detail.cap;
  }
  const insecure = isInsecure(security);
  const weak = security.known === true && security.level === 2;
  if (insecure) out.push('Sem senha ou com segurança quebrada, a nota cai pela metade.');
  else if (weak) out.push('A segurança antiga (WPA/TKIP) tira um quinto da nota.');
  if (row.p2p === true) out.push('É a conexão direta de um aparelho (impressora, TV…), não uma rede com internet: sobra um quinto da nota.');
  running *= isNum(detail.securityFactor) ? detail.securityFactor : insecure ? INSECURE_FACTOR : weak ? WEAK_SECURITY_FACTOR : 1;
  const wpa3 = security.known === true && Array.isArray(security.protocols) && security.protocols.includes('WPA3');
  if (wpa3 && !insecure && isNum(row.score) && row.score > running + 0.05) out.push(`Oferece WPA3, a proteção mais nova: ganha ${WPA3_BONUS} pontos.`);
  out.push(`Nota final: ${Math.round(row.score)} de 100.`);
  return out;
}

/**
 * Separa o diagnóstico: problemas (crítico e atenção), o "tudo certo" e as observações.
 * @param {import('../../core/insights.js').Insight[]} insights
 */
export function splitInsights(insights) {
  const list = (Array.isArray(insights) ? insights : []).filter((i) => isObj(i) && typeof i.id === 'string');
  return {
    problems: list.filter((i) => i.severity === 'critical' || i.severity === 'warning'),
    good: list.find((i) => i.severity === 'good') || null,
    notes: list.filter((i) => i.severity === 'info'),
  };
}

/**
 * O diagnóstico em uma linha, para o atalho dentro do cartão da recomendação.
 * @returns {{tone: 'critical'|'warning'|'good'|'info', icon: string, text: string}|null}  null = nada a dizer
 */
export function diagSummary(insights) {
  const { problems, good, notes } = splitInsights(insights);
  if (problems.length) {
    const critical = problems.some((i) => i.severity === 'critical');
    return {
      tone: critical ? 'critical' : 'warning',
      icon: critical ? 'alert-circle' : 'warning',
      text: `${plural(problems.length, 'ponto de atenção', 'pontos de atenção')} no diagnóstico`,
    };
  }
  if (good) return { tone: 'good', icon: 'check-circle', text: 'Diagnóstico: tudo certo' };
  // "você não está conectado" a própria recomendação já diz
  const extra = notes.filter((i) => i.id !== 'not-connected');
  if (extra.length) return { tone: 'info', icon: 'info', text: `Diagnóstico: ${plural(extra.length, 'observação', 'observações')}` };
  return null;
}

/** Para onde o botão "Ver canais" de um aviso leva: a faixa de que o aviso fala já escolhida. */
export function channelsRoute(insight, connectedBand) {
  const id = isObj(insight) && typeof insight.id === 'string' ? insight.id : '';
  let band = null;
  if (id === 'crowded-channel-24' || id === 'nonstandard-channel' || id === 'wide-channel-24' || id === 'legacy-11b') band = '2.4';
  else if (id === 'crowded-channel-5' || id === 'dfs-channel') band = '5';
  else if (id === 'crowded-channel-6') band = '6';
  else if (connectedBand === '2.4' || connectedBand === '5' || connectedBand === '6') band = connectedBand;
  return band ? `/canais?band=${band}` : '/canais';
}

/** Tipo visual da recomendação. */
export function heroKind(advice) {
  if (!isObj(advice)) return 'unknown';
  if (advice.kind === 'no-connection') return advice.target ? 'connect' : 'offline';
  if (advice.kind === 'switch-band' || advice.kind === 'switch-ap' || advice.kind === 'switch-network') return 'switch';
  return advice.current ? 'ok' : 'unknown';
}

/** Ganho de velocidade para o selo da recomendação: 2.34 -> "≈ 2,3x mais rápida"; 206 -> "pelo menos 10x mais rápida"; null quando não vale dizer. */
export function gainText(gain) {
  if (!isNum(gain) || gain < 1.2) return null;
  return gain >= 10 ? 'pelo menos 10x mais rápida' : `≈ ${formatGain(gain)} mais rápida`;
}

/**
 * Toda a análise da tela a partir do estado do store. Nunca lança: o que falhar vira lista vazia.
 * O diagnóstico olha a conexão com o sinal de agora (state.rssi, a leitura de cada segundo): o
 * sinal que vem em state.connection é o do lugar onde o app abriu.
 * @param {object} state  store.get()
 * @param {{now?:number, history?:object[]}} [live]  relógio e store.rssiHistory(), para o sinal ao vivo
 * @returns {{ranking: object[], advice: object, insights: object[], connected: boolean, band: string|null}}
 */
export function analyse(state, live = {}) {
  const conn = isObj(state.connection) && state.connection.connected === true ? state.connection : null;
  const bssid = conn && typeof conn.bssid === 'string' ? conn.bssid : '';
  const favorites = state.favorites instanceof Set ? state.favorites : new Set();
  const aps = Array.isArray(state.aps) ? state.aps : [];

  let ranking = [];
  try {
    ranking = rankNetworks(aps, { device: state.info || undefined, connectionBssid: bssid, favorites });
  } catch {
    ranking = [];
  }
  let advice = null;
  try {
    advice = advise(ranking, { connectionBssid: bssid, favorites });
  } catch {
    advice = null;
  }
  if (!isObj(advice) || typeof advice.headline !== 'string') {
    advice = { kind: 'ok', headline: 'Sem dados para comparar', text: 'Ainda não deu para comparar as redes. Faça uma nova busca.', target: null, current: null, gain: null, alternative: null };
  } else if (conn && !bssid && advice.kind === 'no-connection') {
    // conectado, mas o Android não disse em qual rede (acontece sem a permissão de localização)
    advice = {
      kind: 'ok',
      headline: 'Sem dados para comparar',
      text: 'O celular está conectado, mas o Android não informou em qual rede. Sem isso não dá para comparar a sua conexão com as outras.',
      target: null,
      current: null,
      gain: null,
      alternative: null,
    };
  }

  let insights = [];
  try {
    // o laço de buscas percebe o limite do Android mesmo quando o celular não o informa
    const throttled = (isObj(state.status) && state.status.throttled === true) || (isObj(state.loop) && state.loop.throttled === true);
    const status = isObj(state.status) ? { ...state.status, throttled: throttled ? true : state.status.throttled } : throttled ? { throttled: true } : undefined;
    insights = buildInsights({ aps, connection: liveConnection(state, live || {}) || undefined, device: state.info || undefined, status, clone: state.clone || undefined });
  } catch {
    insights = [];
  }
  const current = conn ? aps.find((ap) => ap.connected) : null;
  return { ranking, advice, insights, connected: !!conn, band: current ? current.band : null };
}

// ---------------------------------------------------------------------------
// Folha de estilo da tela (uma vez por documento)
// ---------------------------------------------------------------------------

let cssReady = null;

function ensureCss() {
  if (cssReady) return cssReady;
  if (typeof document === 'undefined') return Promise.resolve();
  cssReady = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../../../css/best.css', import.meta.url).href;
    link.dataset.wrx = 'best';
    const done = () => resolve();
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    // nunca prende a tela à espera de um arquivo de estilo
    setTimeout(done, 1500);
    document.head.appendChild(link);
  });
  return cssReady;
}

// ---------------------------------------------------------------------------
// Peças
// ---------------------------------------------------------------------------

// Escolhas da última visita: sobrevivem à troca de aba (a tela é remontada a cada visita).
const memo = { mineOnly: null, expanded: false, notesOpen: new Set() };

/**
 * Nota em anel: o arco cheio é 100. A cor vem do degrau; o número vai dentro (a cor nunca é a
 * única pista) e a palavra entra na descrição para leitores de tela.
 */
function scoreRing(score, { size = 44, usable = true } = {}) {
  const look = scoreLook(score, usable);
  const value = usable && isNum(score) ? Math.min(100, Math.max(0, score)) : 0;
  const stroke = size >= 72 ? 7 : size >= 56 ? 5.5 : size >= 44 ? 4.5 : 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  return h(
    'span',
    {
      class: ['best-ring', `best-tone-${look.step}`, size >= 72 ? 'best-ring--xl' : size >= 56 ? 'best-ring--lg' : size < 44 ? 'best-ring--sm' : null],
      role: 'img',
      'aria-label': usable ? `Nota ${Math.round(value)} de 100: ${look.word.toLowerCase()}` : 'Sem nota: este celular não usa esta rede',
      style: { width: `${size}px`, height: `${size}px` },
    },
    s(
      'svg',
      { viewBox: `0 0 ${size} ${size}`, width: size, height: size, 'aria-hidden': 'true' },
      s('circle', { class: 'best-ring__track', cx: mid, cy: mid, r, fill: 'none', 'stroke-width': stroke }),
      value > 0
        ? s('circle', {
            class: 'best-ring__value',
            cx: mid,
            cy: mid,
            r,
            fill: 'none',
            'stroke-width': stroke,
            'stroke-linecap': 'round',
            // nota 100 fecha o círculo sem a emenda das pontas arredondadas
            'stroke-dasharray': value >= 99.5 ? `${c} 0` : `${(c * value) / 100} ${c}`,
            transform: `rotate(-90 ${mid} ${mid})`,
          })
        : null,
    ),
    h('span.best-ring__num', null, usable ? String(Math.round(value)) : '–'),
  );
}

/**
 * Nome que pode quebrar de linha depois de "_", "." e "/" (nomes como "CLARO_5G4F1D2A" não têm
 * espaço). O texto continua idêntico: a quebra é um <wbr>, que não é texto.
 */
function wrappingName(item) {
  if (item.hidden || !item.ssid) return h('span.ssid.ssid--hidden', null, '(rede oculta)');
  const kids = [];
  displaySsid(item.ssid)
    .split(/(?<=[_./])/)
    .forEach((part, i) => {
      if (i) kids.push(h('wbr'));
      kids.push(part);
    });
  return h('span.ssid', { dir: 'auto' }, kids);
}

const plainName = (item) => (item.hidden || !item.ssid ? '(rede oculta)' : displaySsid(item.ssid));

/** "● 5 GHz · canal 44" como itens de uma linha que corta o que não couber. */
function whereItems(ap) {
  const out = [];
  if (ap.band) out.push(bandBadge(ap.band, { plain: true }));
  if (ap.channel != null) out.push(h('span', null, `canal ${ap.channel}`));
  return out;
}

// ---------------------------------------------------------------------------
// 1. Recomendação
// ---------------------------------------------------------------------------

const HERO_LOOK = {
  ok: { tone: 'good', icon: 'check-circle' },
  // a melhor opção, mas nem ela está boa: o cartão não comemora
  'ok-fair': { tone: 'neutral', icon: 'check-circle' },
  'ok-weak': { tone: 'warning', icon: 'warning' },
  switch: { tone: 'accent', icon: 'bolt' },
  connect: { tone: 'accent', icon: 'wifi-off' },
  offline: { tone: 'neutral', icon: 'wifi-off' },
  unknown: { tone: 'neutral', icon: 'clock' },
};

/** Um dos lados do "de onde -> para onde" (advice.current / advice.target). */
function sideTile(item, { label, target = false, gain = null, ring = false, signal = false, onClick }) {
  return h(
    'button.best-side',
    { type: 'button', class: [target && 'best-side--target', ring && 'best-side--wide'], dataset: { side: target ? 'target' : 'current' }, onClick },
    ring ? scoreRing(item.score, { size: 44 }) : null,
    h(
      'span.best-side__body',
      null,
      h('span.best-side__label', null, label),
      h('span.best-side__name', null, wrappingName(item)),
      h(
        'span.best-side__where',
        null,
        item.band ? bandBadge(item.band, { plain: true }) : null,
        item.channel != null ? h('span', null, `canal ${item.channel}`) : null,
        // dois pontos de acesso da mesma rede só se distinguem pelo sinal
        signal && isNum(item.rssi) ? h('span', null, fmtDbm(item.rssi)) : null,
      ),
      h('span.best-side__speed', null, estText(item.estMbps)),
      gain ? h('span.best-side__gain', null, icon('bolt', { size: 14 }), gain) : null,
    ),
    ring ? h('span.best-side__chev', null, icon('chevron-right', { size: 20 })) : null,
  );
}

function heroCard(view, on) {
  const { advice, summary, ageMs, throttled } = view;
  const kind = heroKind(advice);
  const { current, target, alternative } = advice;
  const okLook = kind === 'ok' && current ? scoreLook(current.score) : null;
  const look = HERO_LOOK[okLook && okLook.step >= 4 ? 'ok-weak' : okLook && okLook.step === 3 ? 'ok-fair' : kind];

  let extra = null;
  if (kind === 'switch' && current && target) {
    extra = h(
      'div.best-compare',
      { key: 'compare' },
      sideTile(current, { label: 'Agora', signal: advice.kind === 'switch-ap', onClick: () => on.openRow(current.key) }),
      h('span.best-compare__arrow', { 'aria-hidden': 'true' }, icon('arrow-right', { size: 20 })),
      sideTile(target, { label: 'Melhor aqui', target: true, signal: advice.kind === 'switch-ap', gain: gainText(advice.gain), onClick: () => on.openRow(target.key) }),
    );
  } else if (kind === 'connect' && target) {
    extra = h('div.best-compare.best-compare--single', { key: 'compare' }, sideTile(target, { label: 'Melhor opção aqui', target: true, ring: true, onClick: () => on.openRow(target.key) }));
  }

  const actions = [];
  if (kind === 'switch' || kind === 'connect') actions.push(button('Abrir o Wi-Fi do celular', { variant: 'primary', icon: 'external', block: true, onClick: on.openWifi }));
  if (kind === 'offline') actions.push(button('Abrir o Wi-Fi do celular', { variant: 'secondary', icon: 'external', block: true, onClick: on.openWifi }));
  // sem rede nenhuma na lista, quem oferece a busca é o aviso do ranking (um botão só)
  if (kind === 'unknown' && view.hasRanking) actions.push(button('Buscar redes agora', { variant: 'secondary', icon: 'refresh', block: true, onClick: on.scanNow }));
  if (kind === 'ok' && alternative && alternative.ssid) {
    actions.push(button('Essa rede é minha', { variant: 'secondary', icon: 'star', block: true, onClick: () => on.markMine(alternative.ssid) }));
  }

  const stale = isNum(ageMs) && ageMs > STALE_NOTE_MS;

  return h(
    'section.card.card--flush.best-hero',
    { key: 'hero', class: `best-hero--${look.tone}`, dataset: { kind: advice.kind, hero: kind }, 'aria-label': 'Recomendação' },
    h(
      'div.best-hero__main',
      null,
      h(
        'div.best-hero__top',
        null,
        h('span.best-hero__icon', null, icon(look.icon, { size: 26 })),
        h('div.best-hero__titles', null, h('span.best-hero__eyebrow', null, 'Recomendação neste ponto'), h('h2.best-hero__headline', null, nb(advice.headline))),
        okLook
          ? h(
              'button.best-hero__score',
              { type: 'button', class: `best-tone-${okLook.step}`, 'aria-label': `Nota da sua conexão: ${Math.round(current.score)} de 100, ${okLook.word.toLowerCase()}. Ver do que a nota é feita.`, onClick: () => on.openRow(current.key) },
              scoreRing(current.score, { size: 56 }),
              h('span.best-hero__score-word', { 'aria-hidden': 'true' }, okLook.word),
            )
          : null,
      ),
      h('p.best-hero__text', null, nb(advice.text)),
      extra,
      actions.length ? h('div.best-hero__actions', { key: 'actions' }, actions) : null,
      stale
        ? h(
            'p.best-hero__age',
            { key: 'age', class: [ageMs > 60_000 && 'warning'] },
            icon('clock', { size: 14 }),
            `Com base na busca de ${fmtAgo(ageMs)}.${throttled ? ' O Android está limitando as buscas.' : ''}`,
          )
        : null,
    ),
    summary
      ? h(
          'button',
          { type: 'button', key: 'diag-jump', class: ['best-hero__diag', `best-hero__diag--${summary.tone}`], onClick: on.jumpToDiag },
          h('span.best-hero__diag-icon', null, icon(summary.icon, { size: 20 })),
          h('span.best-hero__diag-text', null, summary.text),
          icon('chevron-down', { size: 18 }),
        )
      : null,
  );
}

function heroSkeleton() {
  return h('div.skel.best-skel-hero', { key: 'hero-skel', 'aria-hidden': 'true' });
}

// ---------------------------------------------------------------------------
// 3. Ranking
// ---------------------------------------------------------------------------

function noteItem(kind, text) {
  const ICON = { pro: 'check', con: 'minus', warn: 'warning' };
  const LABEL = { pro: 'A favor', con: 'Contra', warn: 'Aviso' };
  return h('span', { class: ['best-note', `best-note--${kind}`] }, icon(ICON[kind], { size: 14, label: LABEL[kind] }), h('span.best-note__text', null, text));
}

function rankRow(row, { onOpen }) {
  const usable = row.detail && row.detail.usable === true;
  const look = scoreLook(row.score, usable);
  const best = row.best;
  const notes = rowNotes(row);
  const mine = isMine(row);

  const where = [];
  if (row.connected) where.push(h('span.best-row__connected', null, icon('check', { size: 14 }), 'Conectado'));
  else if (mine && !row.favorite) where.push(h('span', null, 'Mesmo roteador'));
  where.push(...whereItems(best));
  if (Array.isArray(row.others) && row.others.length) where.push(h('span', null, plural(row.others.length + 1, 'sinal', 'sinais')));
  if (row.security) where.push(securityBadge(row.security, { plain: true }));
  if (best.stale && isNum(best.ageMs)) where.push(h('span', null, `visto ${fmtAgo(best.ageMs)}`));

  return h(
    'button.row.row--tappable.best-row',
    {
      type: 'button',
      key: row.key,
      class: [best.stale && 'best-row--stale', row.connected && 'best-row--connected', `best-tone-${look.step}`],
      dataset: { key: row.key, bssid: best.bssid, mine: mine ? '1' : '0' },
      onClick: () => onOpen(row.key),
    },
    h('span.best-row__ring', null, scoreRing(row.score, { size: 44, usable }), h('span.best-row__word', { 'aria-hidden': 'true' }, look.word)),
    h('span.row__title.best-row__name', null, wrappingName(row), row.favorite ? icon('star-filled', { size: 16, label: 'Minha rede', class: 'accent' }) : null),
    h('span.best-row__speed', null, usable ? estText(row.estMbps) : NO_VALUE),
    h('span.row__sub.row__sub--clip.best-row__where', null, where),
    notes.pros.length || notes.cons.length || notes.warning
      ? h(
          'span.best-row__notes',
          null,
          notes.pros.map((t) => noteItem('pro', t)),
          notes.cons.map((t) => noteItem('con', t)),
          notes.warning ? noteItem('warn', notes.moreWarnings ? `${notes.warning} (+${notes.moreWarnings})` : notes.warning) : null,
        )
      : null,
  );
}

function rankSection(view, on) {
  const { ranking, mineOnly, expanded, favorites, connectedRank } = view;
  const { rows, total, more } = visibleRows(ranking, { mineOnly, expanded });
  const nothing = ranking.length === 0;

  let body;
  if (nothing) {
    body = h(
      'div.card',
      { key: 'empty' },
      emptyState({
        icon: 'wifi-off',
        title: 'Nenhuma rede Wi-Fi ao alcance',
        text: 'O celular não ouviu nenhuma rede na última busca. Chegue mais perto de um roteador ou busque de novo.',
        action: { label: 'Buscar de novo', icon: 'refresh', onClick: on.scanNow },
      }),
    );
  } else if (rows.length === 0) {
    body = h(
      'div.card',
      { key: 'empty-mine' },
      emptyState({
        icon: 'star',
        tone: 'accent',
        title: 'Nenhuma rede sua ao alcance',
        text: 'Marque as redes de que você tem a senha. A rede em que o celular está conectado já conta.',
        action: { label: 'Escolher minhas redes', onClick: on.openPicker },
        secondary: { label: 'Ver todas as redes', onClick: () => on.setMineOnly(false) },
      }),
    );
  } else {
    body = h('div.card.card--flush.list.best-list', { key: 'list', role: 'list' }, rows.map((row) => rankRow(row, { onOpen: on.openRow })));
  }

  const hiddenConnected = !expanded && more > 0 && isNum(connectedRank) && connectedRank > rows.length;

  return [
    sectionHeader('Ranking das redes', { count: nothing ? undefined : total, action: { label: 'Entenda a nota', icon: 'help', onClick: on.openHow } }),
    nothing
      ? null
      : h('p.best-caption', { key: 'caption' }, 'Nota de 0 a 100: quanto cada rede deve render aqui, agora (estimativa). Toque numa rede para ver do que a nota é feita.'),
    nothing
      ? null
      : h(
          'div.chips.best-filters',
          { key: 'filters', role: 'group', 'aria-label': 'Filtro do ranking' },
          h('button.chip', { type: 'button', 'aria-pressed': !!mineOnly, dataset: { filter: 'mine' }, onClick: () => on.setMineOnly(!mineOnly) }, icon(mineOnly ? 'star-filled' : 'star', { size: 16 }), 'Só as minhas redes'),
          h('button.chip.best-filters__edit', { type: 'button', dataset: { action: 'pick-mine' }, onClick: on.openPicker }, icon('edit', { size: 16 }), 'Escolher', favorites > 0 ? h('span.chip__count', null, favorites) : null),
        ),
    body,
    hiddenConnected ? h('p.best-caption.best-caption--center', { key: 'rank-note' }, `A rede em uso está na ${connectedRank}ª posição.`) : null,
    more > 0 || (expanded && total > TOP_ROWS + 1)
      ? h(
          'button.btn.btn--quiet.btn--block.best-more',
          { type: 'button', key: 'more', 'aria-expanded': !!expanded, onClick: () => on.setExpanded(!expanded) },
          icon(expanded ? 'chevron-up' : 'chevron-down', { size: 20 }),
          expanded ? `Mostrar só as ${TOP_ROWS} melhores` : `Mostrar as outras ${plural(more, 'rede', 'redes')}`,
        )
      : null,
  ];
}

// ---------------------------------------------------------------------------
// 4. Diagnóstico
// ---------------------------------------------------------------------------

const SEVERITY_LOOK = {
  critical: { icon: 'alert-circle', kind: 'Crítico' },
  warning: { icon: 'warning', kind: 'Atenção' },
  good: { icon: 'check-circle', kind: null },
  info: { icon: 'info', kind: 'Bom saber' },
};
const ACTION_ICON = { 'open-channels': 'channels', 'open-map': 'cube', 'open-settings-wifi': 'external', 'open-best': 'trophy' };

function insightActions(insight, on) {
  const out = [];
  const action = insight.action;
  if (action && action.kind && action.kind !== 'none' && !(action.kind === 'open-best' && on.hasRanking && !on.hasRanking())) {
    out.push(button(action.label, { variant: 'secondary', small: true, icon: ACTION_ICON[action.kind], dataset: { action: action.kind }, onClick: () => on.runAction(insight) }));
  }
  // o aviso do limite de buscas não traz atalho; o passo a passo ilustrado mora aqui
  // (num Android sem a chave do limite o próprio texto diz que não há como desligar: sem botão)
  if (insight.id === 'scan-throttled' && on.throttleAction) out.push(button(on.throttleAction, { variant: 'secondary', small: true, icon: 'help', dataset: { action: 'throttle-help' }, onClick: on.openThrottle }));
  return out;
}

function diagCard(insight, on) {
  const look = SEVERITY_LOOK[insight.severity] || SEVERITY_LOOK.info;
  const actions = insightActions(insight, on);
  return h(
    'section.card.best-diag',
    { key: `diag-${insight.id}`, class: `best-diag--${insight.severity}`, dataset: { insight: insight.id, severity: insight.severity } },
    h(
      'div.best-diag__head',
      null,
      h('span.best-diag__icon', null, icon(look.icon, { size: 22 })),
      h('div.best-diag__titles', null, look.kind ? h('span.best-diag__kind', null, look.kind) : null, h('h3.best-diag__title', null, nb(insight.title))),
    ),
    h('p.best-diag__text', null, nb(insight.text)),
    actions.length ? h('div.best-diag__actions', null, actions) : null,
  );
}

function noteRow(insight, open, on) {
  const bodyId = `best-note-${insight.id}`;
  const actions = insightActions(insight, on);
  return h(
    'div.best-fold',
    { key: `note-${insight.id}`, dataset: { insight: insight.id, open: open ? '1' : '0' } },
    h(
      'button.row.row--tappable.best-fold__head',
      { type: 'button', 'aria-expanded': !!open, 'aria-controls': bodyId, onClick: () => on.toggleNote(insight.id) },
      h('span.row__lead.best-fold__icon', null, icon('info', { size: 20 })),
      h('span.row__body', null, h('span.best-fold__title', null, nb(insight.title))),
      h('span.row__trail', null, icon(open ? 'chevron-up' : 'chevron-down', { size: 20 })),
    ),
    h('div.best-fold__body', { id: bodyId, hidden: !open }, h('p.best-fold__text', null, nb(insight.text)), actions.length ? h('div.best-diag__actions', null, actions) : null),
  );
}

function diagSection(view, on) {
  const { insights, notesOpen, connected } = view;
  const { problems, good, notes } = splitInsights(insights);
  const alone = problems.length === 0 && !good; // só observações: não faz sentido escondê-las

  const out = [sectionHeader('Diagnóstico', { count: problems.length || undefined })];
  if (good) out.push(diagCard(good, on));
  for (const insight of problems) out.push(diagCard(insight, on));
  if (alone) {
    for (const insight of notes) out.push(diagCard(insight, on));
    if (!notes.length) {
      out.push(
        h(
          'section.card.best-diag.best-diag--info',
          { key: 'diag-none' },
          h(
            'div.best-diag__head',
            null,
            h('span.best-diag__icon', null, icon('info', { size: 22 })),
            h('div.best-diag__titles', null, h('h3.best-diag__title', null, 'Sem diagnóstico por enquanto')),
          ),
          h('p.best-diag__text', null, nb(connected ? 'A rede em uso ainda não apareceu nas buscas. O diagnóstico chega com a próxima busca.' : 'O diagnóstico aparece quando o celular está conectado a uma rede Wi-Fi.')),
        ),
      );
    }
  } else if (notes.length) {
    out.push(
      h('h3.best-subtitle', { key: 'notes-title' }, 'Bom saber', h('span.best-subtitle__count', null, notes.length)),
      h('div.card.card--flush.list.best-folds', { key: 'notes' }, notes.map((insight) => noteRow(insight, notesOpen.has(insight.id), on))),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Painel: do que a nota é feita
// ---------------------------------------------------------------------------

function partRow(part) {
  return h(
    'div.best-part',
    { key: `part-${part.id}`, dataset: { part: part.id } },
    h('div.best-part__head', null, h('span.best-part__label', null, icon(part.icon, { size: 18 }), part.label), h('span.best-part__headline', null, part.headline), h('span.best-part__value', null, part.value)),
    meter(part.value, { tone: part.tone, label: `${part.label}: ${part.value} de 100` }),
    h('p.best-part__text', null, part.text),
  );
}

function apRow(entry, { best, onOpen }) {
  const ap = entry.ap;
  const usable = isNum(entry.estMbps) && entry.estMbps > 0 && isNum(entry.score) && entry.score > 0;
  const sub = [];
  if (ap.connected) sub.push(h('span.best-row__connected', null, icon('check', { size: 14 }), 'Conectado'));
  if (best) sub.push(h('span.best-ap__best', null, 'Melhor'));
  sub.push(h('span', null, usable ? estText(entry.estMbps) : 'Sem uso'));
  // o mesmo sinal que a nota usou (média recente), não a última leitura crua: senão o painel
  // mostra "−71 dBm · regular" em cima e "−78 dBm" logo abaixo para o mesmo ponto de acesso
  const rssi = apSignal(ap);
  sub.push(h('span', null, fmtDbm(rssi)));
  if (ap.stale && isNum(ap.ageMs)) sub.push(h('span', null, `visto ${fmtAgo(ap.ageMs)}`));
  return h(
    'button.row.row--tappable.best-ap',
    { type: 'button', key: `ap-${ap.bssid}`, class: [ap.stale && 'row--stale'], dataset: { bssid: ap.bssid }, onClick: () => onOpen(ap.bssid) },
    h('span.row__lead', null, signalBars(rssi)),
    h(
      'span.row__body',
      null,
      h('span.row__title', null, ap.band ? bandBadge(ap.band) : null, h('span.truncate', null, ap.channel != null ? `Canal ${ap.channel}` : 'Canal desconhecido')),
      h('span.row__sub.row__sub--clip', null, sub),
    ),
    h('span.row__trail', null, scoreRing(entry.score, { size: 36, usable }), icon('chevron-right', { size: 20 })),
  );
}

function scoreSheetBody(row, { gone, favorite, on }) {
  const usable = row.detail && row.detail.usable === true;
  const look = scoreLook(row.score, usable);
  const best = row.best;
  const entries = rowEntries(row);
  const warnings = Array.isArray(row.warnings) ? row.warnings.filter((w) => typeof w === 'string' && w) : [];
  const pros = Array.isArray(row.pros) ? row.pros : [];
  const cons = Array.isArray(row.cons) ? row.cons : [];
  const canMark = !row.hidden && !!row.ssid;

  return [
    h(
      'div.best-sheet-head',
      { key: 'head', class: `best-tone-${look.step}` },
      scoreRing(row.score, { size: 84, usable }),
      h(
        'div.best-sheet-head__body',
        null,
        h('span.best-sheet-head__word', null, usable ? `${look.word} aqui` : 'Sem uso neste celular'),
        h('span.best-sheet-head__speed', null, usable ? estText(row.estMbps) : NO_VALUE),
        h('span.best-sheet-head__hint', null, 'velocidade esperada neste ponto (estimativa)'),
      ),
    ),
    h(
      'div.cluster.best-badges',
      { key: 'badges' },
      row.connected ? badge('Conectado', { tone: 'accent', icon: 'check' }) : null,
      row.favorite ? badge('Minha', { tone: 'accent', icon: 'star-filled' }) : null,
      best.band ? bandBadge(best.band) : null,
      best.channel != null ? badge(`Canal ${best.channel}`) : null,
      standardBadge(best),
      securityBadge(row.security),
      row.mesh ? badge('Vários roteadores', { outline: true, title: 'Mesh, repetidor ou mais de um ponto de acesso com o mesmo nome' }) : null,
    ),
    gone ? banner({ key: 'gone', tone: 'warning', icon: 'clock', title: 'Esta rede saiu do alcance', text: 'Ela não aparece mais nas buscas. Os números abaixo são os da última vez em que foi ouvida.' }) : null,
    warnings.length ? banner({ key: 'warnings', tone: 'warning', text: h('span.best-warnings', null, warnings.map((text) => h('span', null, text))) }) : null,
    h('section.card.best-parts', { key: 'parts' }, h('h3.card__title', null, 'Do que a nota é feita'), scoreParts(row).map(partRow)),
    h(
      'section.card.best-why',
      { key: 'why' },
      h('h3.card__title', null, 'Como a nota foi calculada'),
      h('ol.best-why__steps', null, scoreReasons(row).map((text) => h('li', null, text))),
      pros.length || cons.length ? h('div.best-why__notes', null, pros.map((t) => noteItem('pro', t)), cons.map((t) => noteItem('con', t))) : null,
      h('p.best-why__foot', null, 'Tudo aqui é estimativa, feita com o que o celular ouve deste ponto agora. Mude de cômodo e a nota muda.'),
    ),
    canMark
      ? h(
          'div.card.card--flush.best-own',
          { key: 'own', dataset: { on: favorite ? '1' : '0' } },
          switchRow({
            icon: favorite ? 'star-filled' : 'star',
            title: 'Esta rede é minha',
            subtitle: favorite ? 'As recomendações contam com ela.' : 'Marque se você tem a senha dela.',
            checked: favorite,
            onChange: (checked) => on.setFavorite(row.ssid, checked),
          }),
        )
      : null,
    h(
      'section.stack.stack--sm',
      { key: 'aps' },
      h('h3.best-subtitle', null, entries.length > 1 ? 'Sinais desta rede' : 'Sinal desta rede', entries.length > 1 ? h('span.best-subtitle__count', null, entries.length) : null),
      entries.length > 1 ? h('p.best-caption', null, 'Cada roteador ou repetidor emite um sinal em cada faixa (2,4 e 5 GHz). A nota da rede é a do melhor deles; quem escolhe em qual ficar é o celular.') : null,
      h('div.card.card--flush.list', null, entries.map((entry, i) => apRow(entry, { best: i === 0 && entries.length > 1, onOpen: on.openAp }))),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export async function mount(root, ctx) {
  await ensureCss();
  // a pessoa trocou de aba enquanto o estilo carregava: não há tela para montar
  if (!root.isConnected) return { unmount() {} };
  const { store } = ctx;
  root.classList.add('best-screen');

  if (memo.mineOnly === null) {
    const saved = ctx.prefs.get(PREFS_KEY, null);
    memo.mineOnly = !!(saved && saved.mineOnly === true);
  }

  let dead = false;
  let data = null; // {ranking, advice, insights, connected, band}
  const panels = new Set(); // painéis abertos por esta tela: {panel, render}

  const el = {
    hero: h('div.best-region', { dataset: { region: 'hero' } }),
    tip: h('div.best-region', { dataset: { region: 'tip' } }),
    rank: h('div.best-region.best-section', { dataset: { region: 'rank' } }),
    diag: h('div.best-region.best-section', { dataset: { region: 'diag' } }),
    loading: h('div.best-region.stack', { dataset: { region: 'loading' }, 'aria-hidden': 'true' }),
  };
  render(root, el.hero, el.tip, el.loading, el.rank, el.diag);

  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scrollTo = (node) => node.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });

  // --- ações ---

  let opening = false;
  /** Abre o painel de Wi-Fi do Android (e, se o celular não tiver o painel, a tela de Wi-Fi das configurações). */
  async function openWifi() {
    if (opening) return;
    if (store.get().backend === 'sim') {
      toast('Na demonstração não há configurações do Android para abrir.');
      return;
    }
    opening = true;
    try {
      const res = await ctx.bridge.openSettings('panel').catch(() => null);
      if (res && res.ok !== false) return;
      const again = await ctx.bridge.openSettings('wifi').catch(() => null);
      if (!again || again.ok === false) toast('Não foi possível abrir. Procure “Wi-Fi” nas configurações do Android.');
    } finally {
      opening = false;
    }
  }

  async function scanNow() {
    let res = null;
    try {
      res = await ctx.scanLoop.scanNow();
    } catch {
      res = null;
    }
    if (dead || (res && (res.accepted || res.reason === 'busy'))) return;
    if (res && res.reason === 'throttled') {
      toast('O Android limitou as buscas por enquanto. A lista se atualiza sozinha em instantes.', { action: { label: 'Por quê?', onClick: () => openThrottleHelp(ctx) } });
    } else if (res && res.reason === 'paused') {
      toast('As buscas estão em pausa agora.');
    } else {
      toast('Não deu para buscar agora. Tente de novo em instantes.');
    }
  }

  function setFavorite(ssid, on) {
    if (typeof ssid !== 'string' || !ssid) return;
    store.setFavorite(ssid, on);
  }

  function markMine(ssid) {
    setFavorite(ssid, true);
    toast(`“${displaySsid(ssid)}” agora conta como sua.`, { action: { label: 'Desfazer', onClick: () => setFavorite(ssid, false) } });
  }

  function setMineOnly(on) {
    memo.mineOnly = !!on;
    ctx.prefs.set(PREFS_KEY, { mineOnly: memo.mineOnly });
    drawRank();
  }

  function setExpanded(on) {
    memo.expanded = !!on;
    drawRank();
  }

  function toggleNote(id) {
    if (memo.notesOpen.has(id)) memo.notesOpen.delete(id);
    else memo.notesOpen.add(id);
    drawDiag();
  }

  function runAction(insight) {
    const kind = insight.action && insight.action.kind;
    if (kind === 'open-channels') ctx.navigate(channelsRoute(insight, data ? data.band : null));
    else if (kind === 'open-map') ctx.navigate('/mapa');
    else if (kind === 'open-settings-wifi') openWifi();
    else if (kind === 'open-best') scrollTo(el.rank);
  }

  /** Detalhes técnicos de um BSSID (painel da tela Redes), carregado sob demanda. */
  async function openAp(bssid) {
    try {
      const mod = await import('../ap-detail.js');
      if (dead) return;
      if (typeof mod.openApDetail !== 'function') throw new Error('openApDetail indisponível');
      mod.openApDetail(ctx, bssid);
    } catch {
      if (!dead) toast('Os detalhes técnicos desta rede não estão disponíveis agora.');
    }
  }

  // --- painéis ---

  function track(id, panel, renderPanel) {
    const entry = { id, panel, render: renderPanel };
    panels.add(entry);
    return () => panels.delete(entry);
  }
  /** O painel com este id já está aberto? (dois toques seguidos não abrem dois painéis) */
  const isOpen = (id) => [...panels].some((entry) => entry.id === id && entry.panel.isOpen());

  function openRow(key) {
    if (!data || isOpen(`row:${key}`)) return;
    let last = data.ranking.find((r) => r.key === key);
    if (!last) {
      toast('Esta rede saiu do alcance.');
      return;
    }
    const subtitle = h('span', null, '');
    let untrack = () => {};
    const panel = sheet({
      title: h('span', { class: ['best-sheet-title', (last.hidden || !last.ssid) && 'ssid--hidden'], dir: 'auto' }, plainName(last)),
      subtitle,
      content: [],
      tall: true,
      // conectar só faz sentido numa rede com nome, que o celular consiga usar e em que ele ainda não esteja
      footer:
        !last.connected && !last.hidden && !last.p2p && last.detail && last.detail.usable === true
          ? [button('Abrir o Wi-Fi do celular', { variant: 'primary', icon: 'external', onClick: openWifi })]
          : undefined,
      onClose: () => untrack(),
    });
    panel.el.classList.add('best-sheet');
    panel.el.dataset.key = key;
    const renderPanel = () => {
      if (!panel.isOpen() || !data) return;
      const found = data.ranking.find((r) => r.key === key);
      const row = found || last;
      last = row;
      const usable = row.detail && row.detail.usable === true;
      subtitle.textContent = usable ? `Nota ${Math.round(row.score)} de 100 neste ponto` : 'Sem nota neste celular';
      patch(panel.body, scoreSheetBody(row, { gone: !found, favorite: !row.hidden && store.isFavorite(row.ssid), on: { setFavorite, openAp } }));
    };
    untrack = track(`row:${key}`, panel, renderPanel);
    renderPanel();
  }

  function openPicker() {
    if (isOpen('picker')) return;
    let untrack = () => {};
    const panel = sheet({
      title: 'Minhas redes',
      subtitle: 'Marque as redes de que você tem a senha',
      content: [],
      tall: true,
      footer: [button('Pronto', { variant: 'primary', onClick: () => panel.close() })],
      onClose: () => untrack(),
    });
    panel.el.classList.add('best-sheet', 'best-picker');
    // marcadas que não estão ao alcance: continuam na lista enquanto o painel estiver aberto,
    // mesmo depois de desmarcadas (um toque errado tem de poder ser desfeito)
    const sticky = new Set();
    const renderPanel = () => {
      if (!panel.isOpen() || !data) return;
      const favorites = store.get().favorites;
      // uma linha por nome (a estrela vale para o nome): a rede em uso primeiro, depois as marcadas, depois por nota
      const seen = new Set();
      const named = [];
      for (const row of data.ranking) {
        if (row.hidden || !row.ssid || row.p2p || seen.has(row.ssid)) continue;
        seen.add(row.ssid);
        named.push(row);
      }
      const weight = (row) => (row.connected ? 3 : favorites.has(row.ssid) ? 2 : isMine(row) ? 1 : 0);
      named.sort((a, b) => weight(b) - weight(a));
      for (const ssid of favorites) if (!seen.has(ssid)) sticky.add(ssid);
      const away = [...sticky].filter((ssid) => !seen.has(ssid)).sort((a, b) => a.localeCompare(b, 'pt-BR'));

      const rowFor = (row) => {
        const usable = row.detail && row.detail.usable === true;
        const on = favorites.has(row.ssid);
        const sub = [];
        if (row.connected) sub.push('Conectado');
        else if (!on && isMine(row)) sub.push('Mesmo roteador');
        sub.push(usable ? `nota ${Math.round(row.score)}` : 'sem uso neste celular');
        if (usable) sub.push(estText(row.estMbps));
        if (row.security && row.security.known !== false && row.security.label) sub.push(row.security.label);
        return h(
          'div.best-pick',
          { key: `pick-${row.ssid}`, dataset: { ssid: row.ssid, on: on ? '1' : '0' } },
          switchRow({ title: ssidLabel(row.ssid), subtitle: sub.join(' · '), checked: on, onChange: (checked) => setFavorite(row.ssid, checked) }),
        );
      };
      patch(
        panel.body,
        h(
          'p.best-caption',
          { key: 'intro' },
          'A de casa, a do trabalho… As recomendações e o diagnóstico passam a falar só das redes que você pode usar. A rede em que o celular está conectado já conta, mesmo sem marcar.',
        ),
        named.length
          ? h('div.card.card--flush.list', { key: 'near' }, named.map(rowFor))
          : h('div.card', { key: 'near-empty' }, h('p.best-caption', null, 'Nenhuma rede com nome ao alcance agora.')),
        away.length ? h('h3.best-subtitle', { key: 'away-title' }, 'Marcadas, fora do alcance agora', h('span.best-subtitle__count', null, away.length)) : null,
        away.length
          ? h(
              'div.card.card--flush.list',
              { key: 'away' },
              away.map((ssid) =>
                h(
                  'div.best-pick',
                  { key: `pick-${ssid}`, dataset: { ssid, on: favorites.has(ssid) ? '1' : '0' } },
                  switchRow({ title: ssidLabel(ssid), subtitle: 'Não apareceu na última busca', checked: favorites.has(ssid), onChange: (checked) => setFavorite(ssid, checked) }),
                ),
              ),
            )
          : null,
      );
    };
    untrack = track('picker', panel, renderPanel);
    renderPanel();
  }

  function openHow() {
    if (isOpen('how')) return;
    const panel = sheet({
      title: 'Como a nota funciona',
      content: [
        h(
          'div.prose',
          null,
          h('p', null, 'A nota vai de 0 a 100 e responde a uma pergunta só: ', h('strong', null, 'quanto esta rede deve render no seu celular, neste ponto, agora?')),
          h(
            'ol.steps',
            null,
            h('li', null, h('strong', null, 'Sinal. '), 'Pela força com que a rede chega aqui, o app calcula a velocidade que o roteador e o celular conseguem manter entre si.'),
            h('li', null, h('strong', null, 'Canal. '), 'Desconta o tempo em que o canal fica ocupado: vizinhos no mesmo canal, interferência dos canais ao lado e os outros aparelhos da própria rede.'),
            h(
              'li',
              null,
              h('strong', null, 'Nota. '),
              `A velocidade que sobra vira nota: ${SPEED_GOOD_MBPS} Mb/s já valem ${SPEED_GOOD_SCORE} (dá para vídeo em 4K com folga) e de ${SPEED_TOP_MBPS} Mb/s para cima valem 100. Dobrar a velocidade vale sempre os mesmos pontos.`,
            ),
            h('li', null, h('strong', null, 'Ajustes. '), 'Sinal fraco põe um teto na nota, porque conexão que cai não serve. Rede aberta ou com segurança quebrada perde metade; WPA3 ganha um pequeno bônus.'),
          ),
          h('p', null, 'É uma ', h('strong', null, 'estimativa'), ': o app não mede a internet, só o que dá para saber ouvindo o Wi-Fi. Por isso as velocidades aparecem com “≈”. Para medir de verdade, use o teste de velocidade.'),
          h('p', null, 'A recomendação só manda trocar para redes suas (a que está em uso, as marcadas com a estrela e a outra faixa do mesmo roteador) e nunca troca uma rede protegida por uma aberta.'),
        ),
      ],
      footer: [
        button('Fechar', { variant: 'secondary', onClick: () => panel.close() }),
        button('Testar a velocidade', {
          variant: 'primary',
          icon: 'speed',
          onClick: () => {
            panel.close();
            ctx.navigate('/ferramentas/velocidade');
          },
        }),
      ],
      onClose: () => untrack(),
    });
    panel.el.classList.add('best-sheet');
    const untrack = track('how', panel, () => {});
  }

  // --- desenho de cada região ---

  const isLoading = (state) => state.scan.seq === 0 && state.aps.length === 0;

  const heroHandlers = { openRow, openWifi, scanNow, markMine, jumpToDiag: () => scrollTo(el.diag) };
  const rankHandlers = { openRow, openPicker, openHow, scanNow, setMineOnly, setExpanded };
  const diagHandlers = {
    runAction,
    toggleNote,
    openThrottle: () => openThrottleHelp(ctx),
    // "Como liberar", ou null quando esta versão do Android não deixa desligar o limite
    get throttleAction() {
      return throttleCopy(ctx.store).action;
    },
    hasRanking: () => !!data && data.ranking.length > 0,
  };

  function drawHero() {
    const state = store.get();
    if (isLoading(state) || !data) {
      patch(el.hero, heroSkeleton());
      return;
    }
    patch(
      el.hero,
      heroCard(
        {
          advice: data.advice,
          hasRanking: data.ranking.length > 0,
          summary: diagSummary(data.insights),
          ageMs: state.scan.dataAt ? Date.now() - state.scan.dataAt : null,
          throttled: state.loop.throttled === true,
        },
        heroHandlers,
      ),
    );
  }

  function drawTip() {
    const state = store.get();
    const named = data ? data.ranking.filter((r) => !r.hidden && r.ssid && !r.p2p).length : 0;
    if (isLoading(state) || !data || state.favorites.size > 0 || named < 2) {
      patch(el.tip);
      return;
    }
    patch(
      el.tip,
      tipBanner({
        id: TIP_ID,
        store,
        icon: 'star',
        title: 'Quais redes são suas?',
        text: 'Marque as redes de que você tem a senha: as recomendações passam a falar só delas.',
        actions: [{ label: 'Escolher minhas redes', onClick: openPicker }],
      }),
    );
  }

  function drawRank() {
    const state = store.get();
    if (isLoading(state) || !data) {
      patch(el.rank);
      return;
    }
    const at = data.ranking.findIndex((r) => r.connected);
    patch(
      el.rank,
      rankSection({ ranking: data.ranking, mineOnly: memo.mineOnly, expanded: memo.expanded, favorites: state.favorites.size, connectedRank: at >= 0 && !memo.mineOnly ? at + 1 : null }, rankHandlers),
    );
  }

  function drawDiag() {
    const state = store.get();
    if (isLoading(state) || !data) {
      patch(el.diag);
      return;
    }
    patch(el.diag, diagSection({ insights: data.insights, notesOpen: memo.notesOpen, connected: data.connected }, diagHandlers));
  }

  function drawLoading() {
    const loading = isLoading(store.get());
    el.loading.hidden = !loading;
    if (loading && !el.loading.firstChild) render(el.loading, h('span.skel.skel--title'), skeletonList(4));
    else if (!loading && el.loading.firstChild) render(el.loading);
  }

  // #/melhor?ver=diagnostico (ou ?ver=ranking) abre a tela já naquela parte; se os dados ainda
  // não chegaram, o salto espera por eles
  let pendingJump = null;
  function applyRoute(route) {
    const want = route && route.query && typeof route.query.get === 'function' ? route.query.get('ver') : null;
    pendingJump = want === 'diagnostico' ? el.diag : want === 'ranking' ? el.rank : null;
    jumpIfReady();
  }
  function jumpIfReady() {
    if (!pendingJump || !data || isLoading(store.get())) return;
    const target = pendingJump;
    pendingJump = null;
    // depois de o roteador devolver a rolagem da última visita
    requestAnimationFrame(() => requestAnimationFrame(() => !dead && target.scrollIntoView({ block: 'start' })));
  }

  function refresh() {
    if (dead) return;
    data = analyse(store.get(), { history: store.rssiHistory(LIVE_RSSI_SAMPLES) });
    drawLoading();
    drawHero();
    drawTip();
    drawRank();
    drawDiag();
    for (const entry of [...panels]) entry.render();
    jumpIfReady();
  }

  // Uma análise por varredura: `aps` é trocado a cada varredura (e quando a conexão muda de
  // BSSID ou uma rede é marcada). As leituras de sinal a cada segundo só refazem a análise quando
  // o sinal ao vivo troca de nível (a pessoa andou até um ponto fraco, ou saiu dele).
  // Tudo num seletor só: quando várias partes mudam na mesma ação, a análise roda uma vez.
  const inputs = (state) => [
    state.aps,
    state.scan.seq,
    state.connection && state.connection.connected ? `on|${state.connection.bssid || ''}` : 'off',
    state.favorites,
    state.info,
    state.loop.throttled === true || (!!state.status && state.status.throttled === true),
    liveSignalKey(state, { history: store.rssiHistory(LIVE_RSSI_SAMPLES) }),
  ];
  const sameInputs = (a, b) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  store.subscribe(inputs, refresh, { equal: sameInputs });
  store.subscribe((state) => state.settings.tipsDismissed, drawTip);

  // a idade dos dados continua andando entre uma varredura e outra
  const ageTimer = setInterval(() => {
    if (!dead && data) drawHero();
  }, AGE_TICK_MS);

  function dispose() {
    if (dead) return;
    dead = true;
    clearInterval(ageTimer);
    for (const entry of [...panels]) entry.panel.close();
    panels.clear();
  }
  ctx.onCleanup(dispose);

  refresh();
  applyRoute(ctx.route);

  return { unmount: dispose, onRoute: applyRoute };
}
