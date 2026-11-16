// Canais — "em que canal o meu roteador deveria estar?", com honestidade.
//
// De cima para baixo: seletor de faixa (2,4 / 5 / 6 GHz) · gráfico de canais em canvas
// (ui/charts/channel-graph.js) com a rede escolhida embaixo · cartão "Melhor canal"
// (core recommendChannel) · largura do canal (5 e 6 GHz, core recommendWidth) · ranking dos
// canais (core rateChannels), cada linha abrindo um painel que explica a nota · ajuda
// ("Como mudar o canal do roteador", "Como ler este gráfico").
//
// Rota: #/canais?band=5&bssid=aa:bb:cc:dd:ee:ff escolhe a faixa e destaca aquela rede (a tela
// Redes aponta para cá). `band` aceita 2.4, 2,4, 24, 5 e 6; só com `bssid`, a faixa é a da rede.
//
// "O roteador do usuário nesta faixa" = os BSSIDs "da casa" do store (o conectado, os outros
// rádios do mesmo aparelho e os APs das redes favoritas) que estão na faixa; havendo vários,
// vale o conectado, e a pessoa pode trocar no painel "Qual é a sua rede?".
//
// A tela é montada uma vez e atualizada no lugar a cada varredura (patch): a rolagem, o zoom
// do gráfico, a rede em destaque e os painéis abertos ficam como estavam.
//
// As funções exportadas além de mount() são a lógica pura da tela (sem DOM), testadas em
// tests/channel-graph-layout.test.mjs.

import { h, nb, s, patch, sheet, toast, fmtDbm, fmtBand, fmtWidth, fmtFreq, fmtNum, fmtPct, fmtAgo, plural } from '../dom.js';
import { icon } from '../icons.js';
import { button, iconButton, badge, signalBars, signalBadge, signalWord, ssidLabel, displaySsid, listRow, emptyState, spinner, throttleTip, kvList, securityBadge } from '../components.js';
import { rateChannels, recommendChannel, recommendWidth, channelGraph } from '../../core/channel-rating.js';
import { blocksOf, interferenceFactor, overlapMHz } from '../../core/channels.js';
import { createChannelGraph } from '../charts/channel-graph.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
/** Separador de fatos numa linha: espaço que não quebra + ponto + espaço comum. */
const DOT = '\u00a0· ';

// ---------------------------------------------------------------------------
// Lógica pura
// ---------------------------------------------------------------------------

export const BAND_KEYS = Object.freeze(['2.4', '5', '6']);
const INFO_KEY = { 2.4: 'b24', 5: 'b5', 6: 'b6' };
/** Mesma desvantagem que core/channel-rating.js dá aos canais DFS ao escolher o melhor. */
const DFS_HANDICAP = 5;
/** Dois canais só trocam de posição no ranking se a diferença de nota passar disto. */
const RANK_HYSTERESIS = 1.5;
/** Abaixo desta nota, "pode ficar no canal" deixa de ser dito como boa notícia. */
const CROWDED_SCORE = 60;
/** Quantos canais a lista principal mostra antes do "mostrar os outros". */
const RANK_TOP = 6;
/** Dados mais velhos que isto ganham um aviso junto do gráfico. */
const STALE_NOTE_MS = 30_000;

/** Lê o parâmetro `band` da rota: '2.4', '2,4', '24', '5', '5ghz', '6'... */
export function parseBandParam(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(',', '.')
    .replace(/\s*ghz$/, '');
  if (text === '2.4' || text === '24' || text === '2') return '2.4';
  if (text === '5') return '5';
  if (text === '6') return '6';
  return null;
}

/** O que a rota pede: {band, bssid} (cada um pode ser null). */
export function readQuery(route) {
  const query = route && route.query && typeof route.query.get === 'function' ? route.query : null;
  if (!query) return null;
  const band = parseBandParam(query.get('band'));
  const raw = String(query.get('bssid') || '').trim().toLowerCase();
  const bssid = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(raw) ? raw : null;
  return band || bssid ? { band, bssid } : null;
}

/**
 * Situação de cada faixa: quantas redes há, se o celular a capta e, quando não dá para
 * escolhê-la, o motivo (frase completa e versão curta para o botão).
 */
export function bandSummary(aps, info) {
  const counts = { 2.4: 0, 5: 0, 6: 0 };
  for (const ap of Array.isArray(aps) ? aps : []) if (ap && ap.band in counts) counts[ap.band] += 1;
  return BAND_KEYS.map((band) => {
    const count = counts[band];
    const supported = !(info && info.bands && info.bands[INFO_KEY[band]] === false);
    const name = fmtBand(band);
    let reason = null;
    let short = null;
    if (count === 0 && !supported) {
      reason = `Este celular não capta redes de ${name}.`;
      short = 'sem suporte';
    } else if (count === 0) {
      reason = `Nenhuma rede de ${name} por perto agora.`;
      short = 'nenhuma rede';
    }
    return { band, count, supported, enabled: count > 0, reason, short };
  });
}

/** Faixa inicial: a preferida (última usada) se tiver redes; senão a primeira que tiver. */
export function pickBand(summary, preferred) {
  const wanted = summary.find((b) => b.band === preferred);
  if (wanted && wanted.enabled) return wanted.band;
  const first = summary.find((b) => b.enabled);
  return first ? first.band : preferred && wanted ? wanted.band : '2.4';
}

/**
 * Roteadores do usuário numa faixa, um por rádio (várias redes do mesmo rádio contam uma vez).
 * O conectado vem primeiro; depois as redes favoritas; depois, do sinal mais forte ao mais fraco.
 * @returns {{ap:object, bssids:string[], ssids:string[], connected:boolean}[]}
 */
export function ownCandidates(aps, devices, band) {
  const list = Array.isArray(aps) ? aps : [];
  const deviceOf = new Map();
  for (const device of Array.isArray(devices) ? devices : []) for (const bssid of device.bssids || []) deviceOf.set(bssid, device.id);
  const link = list.find((ap) => ap && ap.connected);
  const linkSsid = link && link.ssid ? link.ssid : null;
  // dentro de um rádio com várias redes, a que representa o roteador: a conectada, depois uma
  // favorita, depois a de mesmo nome da conexão (o "Casa" e não o "Casa-Visitantes"), depois a mais forte
  const weight = (ap) => (ap.connected ? 8 : 0) + (ap.favorite ? 4 : 0) + (linkSsid && ap.ssid === linkSsid ? 2 : 0);
  const radios = new Map();
  for (const ap of list) {
    if (!ap || !ap.own || ap.band !== band || !isNum(ap.channel)) continue;
    const key = `${deviceOf.get(ap.bssid) ?? ap.bssid}|${ap.freq}`;
    const radio = radios.get(key) || { ap: null, bssids: [], ssids: [], connected: false, favorite: false };
    radio.bssids.push(ap.bssid);
    if (ap.ssid && !radio.ssids.includes(ap.ssid)) radio.ssids.push(ap.ssid);
    if (!radio.ap || weight(ap) > weight(radio.ap) || (weight(ap) === weight(radio.ap) && (ap.rssi ?? -Infinity) > (radio.ap.rssi ?? -Infinity))) radio.ap = ap;
    radio.connected = radio.connected || !!ap.connected;
    radio.favorite = radio.favorite || !!ap.favorite;
    radios.set(key, radio);
  }
  return [...radios.values()].sort(
    (a, b) => Number(b.connected) - Number(a.connected) || Number(b.favorite) - Number(a.favorite) || (b.ap.rssi ?? -Infinity) - (a.ap.rssi ?? -Infinity) || (a.ap.bssid < b.ap.bssid ? -1 : 1),
  );
}

/** O roteador analisado: o que a pessoa escolheu (se ainda estiver à vista) ou o primeiro candidato. */
export function pickOwn(candidates, chosenBssid) {
  if (!candidates.length) return null;
  const chosen = chosenBssid ? candidates.find((c) => c.bssids.includes(chosenBssid)) : null;
  return (chosen || candidates[0]).ap;
}

/**
 * BSSIDs que não contam como interferência para o roteador analisado: ele, as outras redes da
 * mesma caixa e os nós do mesmo mesh no mesmo canal. É a mesma regra de recommendChannel()
 * (core/channel-rating.js), repetida aqui para o ranking sair com as mesmas notas do cartão.
 */
export function ownExclusion(devices, own) {
  const ids = new Set();
  if (!own || !own.bssid) return ids;
  ids.add(own.bssid);
  const family = (ap) => (ap.security && typeof ap.security === 'object' ? `${ap.security.enterprise}|${ap.security.personal}|${ap.security.open}` : '');
  const sameNetwork = (ap) => !own.hidden && !ap.hidden && ap.ssid === own.ssid && ap.freq === own.freq && family(ap) === family(own);
  for (const device of Array.isArray(devices) ? devices : []) {
    const bssids = device.bssids || [];
    if (bssids.includes(own.bssid) || (device.aps || []).some(sameNetwork)) for (const id of bssids) ids.add(id);
  }
  return ids;
}

/** Larguras que a faixa permite escolher. */
export function widthsFor(band) {
  if (band === '5') return [20, 40, 80, 160];
  if (band === '6') return [20, 40, 80, 160, 320];
  return [20];
}

/**
 * Largura usada quando a pessoa não escolheu nenhuma: a do roteador dela; sem roteador, 80 MHz.
 * Em 2,4 GHz a análise é sempre em 20 MHz (é o que se recomenda ali; veja recommendWidth).
 */
export function defaultWidth(band, own) {
  if (band === '2.4') return 20;
  if (own && own.band === band && blocksOf(band, own.widthMHz).length) return own.widthMHz;
  return 80;
}

/**
 * Largura em que o cartão "Melhor canal" é calculado. Com o roteador do usuário conhecido é
 * SEMPRE a que ele usa de verdade: o seletor de largura é um "e se" que só muda o ranking, e o
 * cartão não pode afirmar "seu roteador está no canal 44 (40 MHz)" de um roteador em 80 MHz.
 * Sem roteador conhecido não há fato a contrariar: vale a largura escolhida.
 * @param {string} band
 * @param {object|null} own       o roteador analisado nesta faixa
 * @param {number} selected       a largura escolhida no seletor
 */
export function verdictWidth(band, own, selected) {
  return own ? defaultWidth(band, own) : selected;
}

/**
 * Larguras que o seletor deixa escolher: as que a recomendação de largura avaliou (recommendWidth
 * já corta o que o roteador não alcança). Uma largura lembrada que ficou de fora volta para `fallback`.
 */
export function usableWidth(remembered, widths, options, fallback) {
  const allowed = new Set((Array.isArray(options) ? options : []).map((o) => o.widthMHz));
  return widths.includes(remembered) && allowed.has(remembered) ? remembered : fallback;
}

/** O selo do melhor canal de uma linha do ranking. Num "e se" de largura ele não é a recomendação do cartão: é só o mais livre. */
export function bestTag(row, whatIf) {
  return whatIf ? 'Mais livre' : row.isCurrent ? 'Melhor' : 'Recomendado';
}

/** A nota em palavras e em um dos cinco degraus de cor (1 = melhor). */
export function scoreLevel(score) {
  const value = isNum(score) ? score : 0;
  if (value >= 85) return { key: 'free', label: 'Livre', step: 1 };
  if (value >= 70) return { key: 'calm', label: 'Tranquilo', step: 2 };
  if (value >= 50) return { key: 'shared', label: 'Disputado', step: 3 };
  if (value >= 30) return { key: 'busy', label: 'Cheio', step: 4 };
  return { key: 'crowded', label: 'Congestionado', step: 5 };
}

const sameBlock = (a, b) => !!a && !!b && a.centerFreq === b.centerFreq;
const sameSpot = (a, b) => sameBlock(a, b) && a.channel === b.channel;

/**
 * Linhas do ranking a partir das notas de todos os canais (rateChannels) e da recomendação
 * (recommendChannel): a linha do canal atual usa a nota calculada com o canal primário do
 * roteador, e a do melhor canal é a mesma do cartão. Uma linha por bloco; quando o melhor é
 * outro primário dentro do bloco atual, o canal atual ganha uma linha própria.
 * @returns {{key:string, rating:object, isCurrent:boolean, isBest:boolean, main:boolean}[]}
 *          main = entra na lista principal (recomendável ou é o canal atual)
 */
export function buildRanking(ratings, rec) {
  const current = rec && rec.current ? rec.current : null;
  const best = rec && rec.best ? rec.best : null;
  const rows = (Array.isArray(ratings) ? ratings : []).map((rating) => ({ key: String(rating.centerFreq), rating, isCurrent: false, isBest: false }));
  if (best) {
    const row = rows.find((r) => sameBlock(r.rating, best));
    if (row) {
      row.rating = best;
      row.isBest = true;
    }
  }
  if (current) {
    const row = rows.find((r) => sameBlock(r.rating, current));
    if (row && (!row.isBest || sameSpot(best, current))) {
      row.rating = current;
      row.isCurrent = true;
    } else {
      rows.push({ key: `${current.centerFreq}:atual`, rating: current, isCurrent: true, isBest: false });
    }
  }
  for (const row of rows) row.main = row.isCurrent || row.isBest || !!row.rating.recommendable;
  return rows;
}

const policyScore = (rating) => rating.score - (rating.dfs ? DFS_HANDICAP : 0);

/**
 * Ordem do ranking: do melhor para o pior pela nota (canais DFS perdem 5 pontos, como na
 * recomendação), com o melhor sempre no topo. Para a lista não ficar pulando a cada varredura,
 * parte da ordem anterior e só troca dois vizinhos quando a diferença passa de `tolerance`.
 * @param {string[]} previous  chaves na ordem mostrada da última vez ([] = ordenar do zero)
 * @param {object[]} rows      linhas de buildRanking()
 * @returns {object[]}         as mesmas linhas, ordenadas
 */
export function orderRanking(previous, rows, tolerance = RANK_HYSTERESIS) {
  const prevIndex = new Map((previous || []).map((key, i) => [key, i]));
  const value = (row) => policyScore(row.rating);
  const fresh = (a, b) => value(b) - value(a) || a.rating.centerFreq - b.rating.centerFreq;
  const known = rows.filter((r) => prevIndex.has(r.key)).sort((a, b) => prevIndex.get(a.key) - prevIndex.get(b.key));
  const unknown = rows.filter((r) => !prevIndex.has(r.key)).sort(fresh);
  const list = known.length ? [...known, ...unknown] : unknown;
  const tol = known.length ? tolerance : 0;
  for (let i = 1; i < list.length; i++) {
    const row = list[i];
    let j = i;
    while (j > 0 && value(row) > value(list[j - 1]) + tol) {
      list[j] = list[j - 1];
      j -= 1;
    }
    list[j] = row;
  }
  const top = list.findIndex((r) => r.isBest);
  if (top > 0) list.unshift(list.splice(top, 1)[0]);
  return list;
}

/**
 * Quem pesa num canal: cada rede vizinha que despeja potência dentro do bloco, com o tipo de
 * incômodo e a força com que chega ali. Da que mais pesa para a que menos pesa.
 * @param {object[]} aps      lista do store
 * @param {object} rating     linha de rateChannels()
 * @param {Set<string>} exclude  BSSIDs do próprio usuário
 * @returns {{ap:object, kind:'share'|'weak'|'overlap'|'leak', inBlockDbm:number, overlapMHz:number}[]}
 */
export function interferers(aps, rating, exclude) {
  const out = [];
  if (!rating) return out;
  for (const ap of Array.isArray(aps) ? aps : []) {
    if (!ap || ap.band !== rating.band || !isNum(ap.rssi) || !ap.occ || !ap.occ.segments || !ap.occ.segments.length) continue;
    if (exclude && exclude.has(ap.bssid)) continue;
    const factor = interferenceFactor(ap.occ, rating.lo, rating.hi);
    if (!(factor > 0)) continue;
    const inBlockDbm = ap.rssi + 10 * Math.log10(factor);
    if (inBlockDbm < -105) continue;
    const overlap = overlapMHz(ap.occ, { lo: rating.lo, hi: rating.hi });
    let kind = 'leak';
    if (ap.channel === rating.channel) kind = ap.rssi >= -82 ? 'share' : 'weak';
    else if (overlap > 0) kind = 'overlap';
    out.push({ ap, kind, inBlockDbm, overlapMHz: overlap });
  }
  return out.sort((a, b) => b.inBlockDbm - a.inBlockDbm || (a.ap.bssid < b.ap.bssid ? -1 : 1));
}

/** Quem está num canal, em pedaços curtos: ["2 redes no canal", "5 ao lado"] (ou ["nenhuma rede por perto"]). */
export function crowdParts(rating) {
  const co = rating.coChannel || 0;
  const ov = rating.overlapping || 0;
  if (!co && !ov) return [rating.interferenceDbm === null ? 'nenhuma rede por perto' : 'só sobras de canais distantes'];
  const parts = [];
  if (co) parts.push(`${plural(co, 'rede', 'redes')} no canal`);
  if (ov) parts.push(co ? `${fmtNum(ov)} ao lado` : `${plural(ov, 'rede', 'redes')} ao lado`);
  return parts;
}

/** "2 redes no canal · 5 ao lado" (ou "nenhuma rede por perto"). */
export function crowdText(rating) {
  return crowdParts(rating).join(' · ');
}

/** A nota de um canal em frases simples (uma por motivo). */
export function explainRating(rating) {
  const lines = [];
  const co = rating.coChannel || 0;
  const ov = rating.overlapping || 0;
  if (!co && !ov) {
    lines.push(
      rating.interferenceDbm === null
        ? 'Nenhuma rede vizinha alcança este canal: ele está livre.'
        : 'Nenhuma rede usa este canal. Só chega aqui um resto fraco de redes em canais distantes.',
    );
  }
  if (co) {
    lines.push(
      `${co === 1 ? 'Uma rede vizinha usa' : `${fmtNum(co)} redes vizinhas usam`} este mesmo canal. Redes no mesmo canal se revezam: cada uma espera a outra terminar de transmitir. A conexão continua estável, mas a velocidade é dividida.`,
    );
  }
  if (ov) {
    lines.push(
      `${ov === 1 ? 'Uma rede está' : `${fmtNum(ov)} redes estão`} em canais ao lado que invadem este. Isso costuma atrapalhar mais do que dividir o canal: elas não combinam a vez e as transmissões se atropelam.`,
    );
  }
  if (isNum(rating.airtime) && rating.airtime >= 0.01) {
    lines.push(`Quem divide o canal ocupa cerca de ${fmtPct(rating.airtime * 100)} do tempo de transmissão (estimativa).`);
  }
  if (isNum(rating.utilization)) {
    lines.push(`Os roteadores deste canal informam que ele fica ocupado ${fmtPct(rating.utilization * 100)} do tempo.`);
  }
  return lines;
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is(a[k], b[k]));
}

// ---------------------------------------------------------------------------
// Peças da tela
// ---------------------------------------------------------------------------

// lembrado enquanto o app está aberto (voltar à aba encontra tudo como estava)
const memo = { band: null, width: {}, own: {}, showOthers: false };

let stylesReady = null;
/** Folha de estilos da tela, carregada uma vez. Resolve quando ela chega (ou depois de 1,5 s). */
function ensureStyles() {
  if (stylesReady) return stylesReady;
  stylesReady = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../../../css/channels.css', import.meta.url).href;
    const done = () => resolve();
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, 1500);
    document.head.appendChild(link);
  });
  return stylesReady;
}

/** Barra da nota (0 a 100) na cor do degrau. */
function scoreBar(score, { thick = false } = {}) {
  const value = isNum(score) ? Math.min(100, Math.max(0, score)) : 0;
  const level = scoreLevel(value);
  return h(
    'span',
    {
      class: ['ch-bar', `ch-lvl-${level.step}`, thick && 'ch-bar--thick'],
      role: 'meter',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(value),
      'aria-label': `Nota ${Math.round(value)} de 100: ${level.label.toLowerCase()}`,
    },
    h('i', { style: { width: `${value}%` } }),
  );
}

/** "36–48" para blocos largos; null para um canal de 20 MHz. */
function blockRange(rating) {
  const list = rating.channels || [];
  return list.length > 1 ? `${list[0]}–${list[list.length - 1]}` : null;
}

function channelTitle(rating) {
  return rating.widthMHz > 20 ? `Canal ${rating.channel} · ${fmtWidth(rating.widthMHz)}` : `Canal ${rating.channel}`;
}

const BAND_ROAD = {
  2.4: 'Em 2,4 GHz só os canais 1, 6 e 11 não se sobrepõem; por isso a recomendação fica entre eles.',
  5: 'Em 5 GHz os canais não se sobrepõem, mas um canal largo junta vários deles.',
  6: 'Em 6 GHz há muito espaço; os canais preferenciais (PSC) são os que os aparelhos procuram primeiro.',
};

const OTHERS_REASON = {
  2.4: 'Ficam fora dos canais padrão (1, 6 e 11). Entre eles (2 a 5 e 7 a 10), um roteador atrapalha, e é atrapalhado por, dois canais padrão ao mesmo tempo; o 12 e o 13 ainda invadem o 11 e não são vistos por alguns aparelhos importados.',
  5: 'Usam a faixa de 5,9 GHz (U-NII-4), que poucos roteadores e aparelhos aceitam.',
  6: 'Estão fora dos canais preferenciais (PSC): alguns aparelhos demoram a encontrar uma rede ali.',
};

const KIND_TEXT = {
  share: 'mesmo canal',
  weak: 'mesmo canal, sinal fraco',
  overlap: 'canal ao lado, invade este',
  leak: 'canal próximo, vaza um pouco',
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // sem permissão ou fora de contexto seguro: tenta o jeito antigo
  }
  try {
    const area = h('textarea', { value: text, readOnly: true, 'aria-hidden': 'true', style: { position: 'fixed', top: '0', left: '0', opacity: '0' } });
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export async function mount(root, ctx) {
  await ensureStyles();
  const { store } = ctx;
  root.classList.add('channels');

  const ui = {
    band: null,
    highlight: null,
    pending: readQuery(ctx.route),
    order: [],
    orderFor: '',
    zoom: { zoom: 1, canZoomIn: false, canZoomOut: false },
  };
  let last = null; // última análise (os painéis abertos leem daqui)
  let dead = false;
  const live = new Set(); // painéis abertos que acompanham as varreduras

  // --- estrutura fixa: cada pedaço é atualizado no lugar -----------------------------------
  const stateSlot = h('div.ch-slot');
  const tipSlot = h('div.ch-slot');
  const bandSlot = h('div.ch-slot');
  const chartHead = h('div.ch-chart__head');
  const graphHost = h('div.chgraph', { dataset: { nodrag: '' } });
  const chartFoot = h('div.ch-chart__foot');
  const srList = h('ul.sr-only', { 'aria-label': 'Redes desta faixa' });
  const chartCard = h('section.card.ch-chart', { 'aria-label': 'Gráfico de canais' }, chartHead, graphHost, chartFoot, srList);
  const recSlot = h('div.ch-slot');
  const widthSlot = h('div.ch-slot');
  const rankHead = h('div.ch-slot');
  const rankList = h('div.card.card--flush.list.ch-rank', { hidden: true });
  const rankFoot = h('div.ch-slot');
  const helpCard = h(
    'div.card.card--flush.list',
    null,
    listRow({ icon: 'router', title: 'Como mudar o canal do roteador', subtitle: 'Passo a passo, em qualquer marca', chevron: true, onClick: () => openChangeHelp() }),
    listRow({ icon: 'help', neutral: true, title: 'Como ler este gráfico', subtitle: 'O que são as montanhas, a altura e a largura', chevron: true, onClick: () => openGraphHelp() }),
  );
  const main = h('div.ch-main', { hidden: true }, tipSlot, bandSlot, chartCard, recSlot, widthSlot, rankHead, rankList, rankFoot, helpCard);
  root.append(stateSlot, main);

  const graph = createChannelGraph(graphHost, {});
  graphHost.__graph = graph; // para os testes de ponta a ponta
  graph.on('select', (sel) => {
    ui.highlight = sel ? sel.bssid : null;
    renderChartFoot();
  });
  graph.on('activate', ({ bssid }) => openDetail(bssid));
  graph.on('zoom', (z) => {
    ui.zoom = z;
    renderChartHead();
  });

  // --- análise -----------------------------------------------------------------------------

  function analyse(state) {
    const summary = bandSummary(state.aps, state.info);

    if (ui.pending) {
      const { band: wantedBand, bssid } = ui.pending;
      const target = bssid ? state.aps.find((ap) => ap.bssid === bssid) : null;
      const band = target && BAND_KEYS.includes(target.band) ? target.band : wantedBand;
      if (band && band !== ui.band) switchBand(band, { silent: true });
      if (target) {
        ui.highlight = target.bssid;
        showChart();
      } else if (bssid) toast('Essa rede não está mais ao alcance.');
      ui.pending = null;
    }
    if (!ui.band) {
      // sem pedido na rota: a última faixa usada; na primeira vez, 2,4 GHz (a mais disputada)
      ui.band = pickBand(summary, memo.band);
      graph.setBand(ui.band);
    }
    const band = ui.band;
    const hl = ui.highlight ? state.aps.find((ap) => ap.bssid === ui.highlight) : null;
    if (!hl || hl.band !== band) ui.highlight = null;

    const bandAps = state.aps.filter((ap) => ap.band === band);
    const candidates = ownCandidates(state.aps, state.devices, band);
    const own = pickOwn(candidates, memo.own[band]);
    const widths = widthsFor(band);
    const autoWidth = defaultWidth(band, own);
    const widthAdvice = recommendWidth(state.aps, band, { own });
    // (uma largura lembrada que este roteador não alcança não vale: volta para a dele)
    const width = usableWidth(memo.width[band], widths, widthAdvice.options, autoWidth);
    // `rec` segue o seletor de largura e marca as linhas do ranking; `verdict` é o que o cartão
    // "Melhor canal" afirma sobre o roteador, sempre na largura que ele usa (veja verdictWidth)
    const rec = recommendChannel(state.aps, { band, widthMHz: width, own });
    const cardWidth = verdictWidth(band, own, width);
    const verdict = cardWidth === width ? rec : recommendChannel(state.aps, { band, widthMHz: cardWidth, own });
    const whatIf = cardWidth !== width; // o ranking mostra uma largura que não é a do roteador
    const exclude = ownExclusion(state.devices, own);
    const ratings = rateChannels(state.aps, { band, widthMHz: width, exclude });

    const orderFor = `${band}|${width}|${own ? own.bssid : ''}`;
    if (orderFor !== ui.orderFor) {
      ui.orderFor = orderFor;
      ui.order = [];
    }
    const all = buildRanking(ratings, rec);
    const mainRows = orderRanking(ui.order, all.filter((r) => r.main));
    ui.order = mainRows.map((r) => r.key);
    const otherRows = all.filter((r) => !r.main).sort((a, b) => a.rating.centerFreq - b.rating.centerFreq);

    return { state, summary, band, bandAps, candidates, own, widths, autoWidth, width, rec, verdict, cardWidth, whatIf, exclude, widthAdvice, mainRows, otherRows, graph: channelGraph(state.aps, band) };
  }

  /** Quem chega por um atalho para uma rede precisa ver o gráfico: rola a tela para o começo. */
  function showChart() {
    // depois do que estiver em curso: ao abrir a tela, o app ainda vai devolver a rolagem antiga
    setTimeout(() => {
      const view = root.closest('.view');
      if (!dead && view) view.scrollTop = 0;
    }, 0);
  }

  function switchBand(band, { silent = false } = {}) {
    if (band === ui.band) return;
    ui.band = band;
    memo.band = band;
    ui.highlight = null;
    graph.setBand(band);
    if (!silent) render();
  }

  // --- desenho de cada pedaço --------------------------------------------------------------

  function render() {
    if (dead) return;
    const state = store.get();
    if (state.scan.seq === 0) {
      main.hidden = true;
      patch(stateSlot, loadingView());
      return;
    }
    if (!state.aps.length) {
      main.hidden = true;
      last = null;
      patch(
        stateSlot,
        emptyState({
          icon: 'wifi-off',
          title: 'Nenhuma rede por perto',
          text: 'O celular não ouviu nenhuma rede Wi-Fi na última busca, então não há canais para comparar.',
          action: { label: 'Buscar de novo', icon: 'refresh', onClick: () => ctx.scanLoop.scanNow() },
        }),
      );
      return;
    }
    last = analyse(state);
    patch(stateSlot);
    main.hidden = false;

    patch(tipSlot, throttleTip(ctx));
    patch(bandSlot, bandSelector(last));
    renderChartHead();
    graph.setData(last.graph, {
      ownBssids: state.own,
      highlight: ui.highlight,
      staleBssids: last.bandAps.filter((ap) => ap.stale).map((ap) => ap.bssid),
    });
    renderChartFoot();
    patch(
      srList,
      last.bandAps.map((ap) => h('li', { key: ap.bssid }, `${displaySsid(ap.ssid)}, canal ${ap.channel}, ${fmtWidth(ap.widthMHz)}, ${fmtDbm(ap.rssi)}${ap.own ? ', sua rede' : ''}`)),
    );
    patch(recSlot, recCard(last));
    patch(widthSlot, widthCard(last));
    renderRanking();
    for (const entry of live) if (entry.panel.isOpen()) entry.update();
  }

  function loadingView() {
    return [
      h('div.skel.ch-skel-bands', { key: 'skel-bands', 'aria-hidden': 'true' }),
      h('p.ch-loading', { key: 'skel-text', role: 'status' }, spinner(), 'Procurando redes por perto…'),
      h('div.skel.ch-skel-chart', { key: 'skel-chart', 'aria-hidden': 'true' }),
      h('div.skel.skel--card', { key: 'skel-card', 'aria-hidden': 'true' }),
    ];
  }

  function bandSelector(a) {
    const pick = (b) => {
      if (b.enabled) switchBand(b.band);
      else if (b.band !== ui.band) toast(b.reason);
    };
    return h(
      'div.seg.ch-bands',
      {
        key: 'bands',
        role: 'radiogroup',
        'aria-label': 'Faixa de frequência',
        onKeyDown: (ev) => {
          const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
          if (!step) return;
          ev.preventDefault();
          const usable = a.summary.filter((b) => b.enabled || b.band === ui.band);
          const at = Math.max(0, usable.findIndex((b) => b.band === ui.band));
          const next = usable[(at + step + usable.length) % usable.length];
          if (next && next.band !== ui.band) {
            switchBand(next.band);
            const el = bandSlot.querySelector(`[data-band="${next.band}"]`);
            if (el) el.focus();
          }
        },
      },
      a.summary.map((b) => {
        const on = b.band === a.band;
        const off = !b.enabled && !on;
        return h(
          'button.seg__opt.ch-band',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': on,
            'aria-disabled': off ? true : undefined,
            'aria-label': `${fmtBand(b.band)}: ${b.enabled ? plural(b.count, 'rede', 'redes') : b.reason}`,
            tabIndex: on ? 0 : -1,
            dataset: { band: b.band },
            onClick: () => pick(b),
          },
          h('span.ch-band__name', null, h('span.dot'), fmtBand(b.band)),
          h('span.ch-band__sub', null, b.enabled ? plural(b.count, 'rede', 'redes') : b.short),
        );
      }),
    );
  }

  function renderChartHead() {
    if (!last) return;
    const { scan } = store.get();
    const age = isNum(scan.dataAt) ? Date.now() - scan.dataAt : null;
    const count = last.bandAps.length;
    patch(
      chartHead,
      h(
        'div.ch-chart__titles',
        null,
        h('h2.ch-chart__title', null, 'Redes por canal'),
        h(
          'p.ch-chart__sub',
          null,
          count ? `${plural(count, 'rede', 'redes')} em ${fmtBand(last.band)}` : `Nenhuma rede em ${fmtBand(last.band)}`,
          age !== null && age > STALE_NOTE_MS ? h('span.ch-chart__age', null, icon('clock', { size: 14 }), `dados de ${fmtAgo(age)}`) : null,
        ),
      ),
      h(
        'div.ch-chart__tools',
        null,
        iconButton('zoom-out', 'Diminuir o zoom do gráfico', () => graph.zoomOut(), { muted: true, disabled: !ui.zoom.canZoomOut }),
        iconButton('zoom-in', 'Aumentar o zoom do gráfico', () => graph.zoomIn(), { muted: true, disabled: !ui.zoom.canZoomIn }),
      ),
    );
  }

  function renderChartFoot() {
    if (!last) return;
    const ap = ui.highlight ? store.apById(ui.highlight) : null;
    if (!ap) {
      patch(
        chartFoot,
        h(
          'div.ch-legend',
          { key: 'legend' },
          h('span.ch-legend__item', null, h('i.ch-swatch.ch-swatch--own'), 'Sua rede'),
          h('span.ch-legend__item', null, h('i.ch-swatch'), 'Vizinhos'),
          last.bandAps.some((item) => item.stale) ? h('span.ch-legend__item', null, h('i.ch-swatch.ch-swatch--stale'), 'Não ouvida na última busca') : null,
          h('span.ch-legend__hint', null, 'Toque numa rede do gráfico para ver quem é.'),
        ),
      );
      return;
    }
    // do mais importante para o menos: em tela estreita o último item fica de fora (row__sub--clip)
    const sub = [h('span', null, `Canal ${ap.channel}`), h('span', null, fmtWidth(ap.widthMHz)), h('span', null, fmtDbm(ap.rssi)), signalWord(ap.rssi)];
    if (ap.stale && isNum(ap.ageMs)) sub.push(h('span', null, `visto ${fmtAgo(ap.ageMs)}`));
    patch(
      chartFoot,
      h(
        'div.ch-sel',
        { key: 'sel', dataset: { bssid: ap.bssid } },
        h(
          'button.row.row--tappable',
          { type: 'button', 'aria-label': `Ver detalhes de ${displaySsid(ap.ssid)}`, onClick: () => openDetail(ap.bssid) },
          h('span.row__lead', null, signalBars(ap.rssi)),
          h(
            'span.row__body',
            null,
            h('span.row__title', null, ssidLabel(ap.ssid), ap.own ? icon('star-filled', { size: 16, label: 'Sua rede', class: 'accent' }) : null),
            h('span.row__sub.row__sub--clip', null, sub),
          ),
          h('span.ch-sel__more', null, icon('chevron-right', { size: 18 })),
        ),
        iconButton(
          'close',
          'Tirar o destaque',
          () => {
            ui.highlight = null;
            graph.setHighlight(null);
            renderChartFoot();
          },
          { muted: true },
        ),
      ),
    );
  }

  /** Cartão com a nota de um canal: "Canal atual 6 · nota 39 · Disputado". */
  function scoreTile(label, rating, { accent = false } = {}) {
    const level = scoreLevel(rating.score);
    const range = blockRange(rating);
    return h(
      'div',
      { class: ['ch-tile', accent && 'ch-tile--accent'] },
      h('span.ch-tile__label', null, label),
      h(
        'span.ch-tile__ch',
        null,
        h('span.ch-tile__num', null, rating.channel),
        range ? h('span.ch-tile__range', null, `${range} · ${fmtWidth(rating.widthMHz)}`) : null,
        rating.dfs ? badge('DFS', { tone: 'warning' }) : null,
      ),
      scoreBar(rating.score),
      h('span.ch-tile__note', null, h('strong', null, `Nota ${fmtNum(Math.round(rating.score))}`), h('span', { class: ['ch-level', `ch-lvl-${level.step}`] }, level.label)),
    );
  }

  function ownLine(a) {
    const { own, candidates } = a;
    const several = candidates.length > 1;
    return h(
      'div.ch-own',
      null,
      h('span.ch-own__icon', null, icon('router', { size: 20 })),
      h(
        'span.ch-own__body',
        null,
        h('span.ch-own__label', null, `${several ? 'Roteador analisado' : 'Seu roteador'} · canal ${own.channel} · ${fmtWidth(own.widthMHz)}`),
        h('span.ch-own__name', null, ssidLabel(own.ssid)),
      ),
      button('Trocar', { variant: 'quiet', small: true, 'aria-label': several ? 'Trocar o roteador analisado' : 'Trocar a rede marcada como sua', onClick: () => openPicker() }),
    );
  }

  function recCard(a) {
    // (o veredito, não a recomendação do ranking: com roteador conhecido, sempre na largura dele)
    const { verdict: rec, own, band } = a;
    const best = rec.best;
    const current = rec.current;
    const head = (iconName, tone, title) =>
      h('div.ch-rec__head', null, h('span', { class: ['ch-rec__icon', `ch-rec__icon--${tone}`] }, icon(iconName)), h('div', null, h('p.ch-rec__eyebrow', null, `Melhor canal · ${fmtBand(band)}`), h('h2.ch-rec__title', null, title)));
    const caveat = h('p.ch-rec__caveat', null, 'Estimativa feita de onde o celular está agora. Para decidir com mais segurança, faça a leitura perto do roteador.');
    const dfsTag = (r) => (r && r.dfs ? ' (DFS)' : '');

    if (!best) {
      return h('section.card.ch-rec', { key: 'rec' }, head('info', 'neutral', 'Sem recomendação nesta largura'), h('p.ch-rec__text', null, rec.text), own ? ownLine(a) : null);
    }

    // não sabemos qual é o roteador da pessoa nesta faixa: o canal mais livre em geral + chamada para marcar
    if (!own) {
      const somewhere = a.state.aps.some((ap) => ap.own);
      return h(
        'section.card.ch-rec',
        { key: 'rec', dataset: { verdict: 'general' } },
        head('target', 'neutral', `Canal mais livre agora: ${best.channel}${dfsTag(best)}`),
        h('p.ch-rec__text', null, rec.text),
        h('div.ch-tiles.ch-tiles--one', null, scoreTile('Mais livre em geral', best)),
        h(
          'div.ch-ask',
          null,
          h(
            'div.ch-ask__text',
            null,
            h('strong', null, somewhere ? `Sua rede não aparece em ${fmtBand(band)}` : 'Qual é a sua rede?'),
            h(
              'span',
              null,
              somewhere
                ? 'O roteador em que você está conectado não tem sinal nesta faixa. Se outra rede daqui for sua, marque-a.'
                : 'Marque a rede da sua casa para a recomendação valer para o seu roteador, sem contar ele mesmo como vizinho.',
            ),
          ),
          button(somewhere ? 'Escolher rede' : 'Marcar minha rede', { variant: 'primary', icon: 'star', onClick: () => openPicker() }),
        ),
        caveat,
      );
    }

    // o canal do roteador não existe na largura escolhida (ex.: 165 em 80 MHz)
    if (!current) {
      return h(
        'section.card.ch-rec',
        { key: 'rec', dataset: { verdict: 'general' } },
        head('target', 'neutral', `Canal mais livre em ${fmtWidth(a.cardWidth)}: ${best.channel}${dfsTag(best)}`),
        h('p.ch-rec__text', null, `Seu roteador está no canal ${own.channel}, que não comporta ${fmtWidth(a.cardWidth)}. ${rec.text}`),
        h('div.ch-tiles.ch-tiles--one', null, scoreTile('Mais livre nesta largura', best)),
        ownLine(a),
        caveat,
      );
    }

    const change = rec.verdict === 'change';
    const same = sameSpot(best, current);
    const widthNote =
      band === '2.4' && own.widthMHz >= 40 && a.widthAdvice.widthMHz === 20
        ? h('p.ch-rec__note', null, icon('info', { size: 16 }), h('span', null, `Seu roteador usa ${fmtWidth(own.widthMHz)} nesta faixa. ${a.widthAdvice.text}`))
        : null;
    const gain = isNum(rec.gain) ? Math.round(rec.gain) : 0;
    // "pode ficar" só soa como boa notícia se o canal estiver razoável; num canal cheio o
    // veredito é o mesmo (trocar não ajuda), mas o tom é neutro e vem uma saída de verdade
    const crowded = !change && current.score < CROWDED_SCORE;
    let crowdNote = null;
    if (crowded) {
      const has5 = a.state.aps.some((ap) => ap.own && ap.band === '5');
      const text =
        band === '2.4'
          ? has5
            ? 'A faixa de 2,4 GHz está cheia por aqui. Nos aparelhos que alcançam, prefira a rede de 5 GHz do seu roteador: lá há mais espaço.'
            : 'A faixa de 2,4 GHz está cheia por aqui. Se o seu roteador tiver 5 GHz, prefira essa faixa nos aparelhos que alcançam: lá costuma haver mais espaço.'
          : `A faixa de ${fmtBand(band)} está disputada por aqui. Um canal mais estreito costuma sofrer menos: veja a largura sugerida logo abaixo.`;
      crowdNote = h('p.ch-rec__note', null, icon('info', { size: 16 }), h('span', null, text));
    }

    return h(
      'section',
      { class: ['card', 'ch-rec', change ? 'card--accent' : !crowded && 'card--good'], key: 'rec', dataset: { verdict: rec.verdict } },
      change
        ? head('arrow-right', 'accent', `Mude para o canal ${best.channel}${dfsTag(best)}`)
        : crowded
          ? head('info', 'neutral', `Fique no canal ${current.channel}: trocar não ajuda`)
          : head('check-circle', 'good', `Pode ficar no canal ${current.channel}`),
      h('p.ch-rec__text', null, rec.text),
      same
        ? h('div.ch-tiles.ch-tiles--one', null, scoreTile('Canal atual', current))
        : h(
            'div',
            { class: ['ch-tiles', !change && 'ch-tiles--pair'] },
            scoreTile('Canal atual', current),
            change ? h('span.ch-tiles__arrow', { 'aria-hidden': 'true' }, icon('arrow-right', { size: 20 })) : null,
            scoreTile(change ? 'Recomendado' : 'Melhor alternativa', best, { accent: change }),
          ),
      !same && !change
        ? h('p.ch-rec__note', null, icon('info', { size: 16 }), h('span', null, gain > 0 ? `A alternativa ganha só ${plural(gain, 'ponto', 'pontos')}: pouco para compensar a troca.` : 'A alternativa não é melhor o bastante para compensar a troca.'))
        : null,
      crowdNote,
      widthNote,
      ownLine(a),
      change ? button('Como mudar o canal', { variant: 'secondary', icon: 'router', block: true, onClick: () => openChangeHelp() }) : null,
      caveat,
    );
  }

  function widthCard(a) {
    if (a.widths.length < 2) return null;
    const { own, widthAdvice, width, band } = a;
    const byWidth = new Map(widthAdvice.options.map((o) => [o.widthMHz, o]));
    const pick = (w) => {
      if (!byWidth.has(w)) {
        // o corte vem do que o roteador anuncia no beacon; sem os elementos (Android antigo), da geração
        const announced = own && own.ie && isNum(own.ie.maxWidthMHz);
        toast(!own ? `Não há canais de ${fmtWidth(w)} nesta faixa.` : announced ? `O seu roteador não anuncia suporte a ${fmtWidth(w)} nesta faixa.` : `Pela geração do Wi-Fi, o seu roteador não chega a ${fmtWidth(w)}.`);
        return;
      }
      if (w === a.width) return;
      memo.width[band] = w;
      render();
    };
    return h(
      'section.card.ch-width',
      { key: 'width' },
      h('h2.card__title', null, 'Largura do canal'),
      h('p.card__text', null, 'Canal mais largo é mais rápido, mas ocupa mais espaço e encontra mais vizinhos. A lista abaixo usa a largura escolhida.'),
      h(
        'div.seg.ch-widths',
        {
          role: 'radiogroup',
          'aria-label': 'Largura do canal em MHz',
          onKeyDown: (ev) => {
            const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
            if (!step) return;
            ev.preventDefault();
            const usable = a.widths.filter((w) => byWidth.has(w));
            const next = usable[(Math.max(0, usable.indexOf(width)) + step + usable.length) % usable.length];
            if (next !== undefined && next !== width) {
              pick(next);
              const el = widthSlot.querySelector(`[data-width="${next}"]`);
              if (el) el.focus();
            }
          },
        },
        a.widths.map((w) => {
          const option = byWidth.get(w);
          const on = w === width;
          return h(
            'button.seg__opt.ch-widthopt',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': on,
              'aria-disabled': option ? undefined : true,
              'aria-label': option ? `${fmtWidth(w)}: melhor nota ${Math.round(option.score)} de 100` : `${fmtWidth(w)}: indisponível`,
              tabIndex: on ? 0 : -1,
              dataset: { width: w },
              onClick: () => pick(w),
            },
            h('span.ch-widthopt__w', null, w, h('span.ch-widthopt__unit', null, 'MHz')),
            h('span.ch-widthopt__score', null, option ? `nota ${fmtNum(Math.round(option.score))}` : '—'),
          );
        }),
      ),
      h('p.ch-advice', null, icon('sparkle', { size: 18 }), h('span', null, widthAdvice.text)),
      own ? h('p.ch-width__now', null, `Seu roteador usa ${fmtWidth(own.widthMHz)} hoje${own.widthMHz === widthAdvice.widthMHz ? ': já é a largura sugerida.' : '.'}`) : null,
      // "e se": o ranking está numa largura que não é a do roteador; o cartão de cima continua valendo para a dele
      a.whatIf ? h('p.ch-width__whatif', null, `O ranking abaixo mostra como ficaria em ${fmtWidth(width)}. O cartão “Melhor canal” continua valendo para os ${fmtWidth(a.cardWidth)} que o seu roteador usa hoje.`) : null,
    );
  }

  function rankRow(row) {
    const r = row.rating;
    const level = scoreLevel(r.score);
    const range = blockRange(r);
    const tags = [];
    if (row.isCurrent) tags.push(badge('Seu canal', { tone: 'accent', icon: 'router' }));
    if (row.isBest) tags.push(badge(bestTag(row, last && last.whatIf), { tone: 'good', icon: 'check' }));
    if (r.dfs) tags.push(badge('DFS', { tone: 'warning' }));
    if (r.psc) tags.push(badge('PSC', { outline: true }));
    const facts = crowdParts(r);
    if (r.busiest) facts.push(`mais forte ${fmtDbm(r.busiest.rssi)}`);
    if (isNum(r.utilization)) facts.push(`ocupação ${fmtPct(r.utilization * 100)}`);
    return h(
      'button.row.row--tappable.ch-rank__row',
      {
        key: row.key,
        type: 'button',
        dataset: { channel: r.channel, key: row.key },
        'aria-label': `${channelTitle(r)}: nota ${Math.round(r.score)} de 100, ${level.label.toLowerCase()}. ${crowdText(r)}.`,
        onClick: () => openChannelSheet(row.key),
      },
      h('span.ch-rank__ch', null, h('span.ch-rank__num', null, r.channel), h('span.ch-rank__cap', null, range || 'canal')),
      h(
        'span.row__body',
        null,
        tags.length ? h('span.ch-rank__tags', null, tags) : null,
        h('span.ch-rank__top', null, scoreBar(r.score), h('span.ch-rank__score', null, fmtNum(Math.round(r.score)))),
        // o separador vai colado (espaço que não quebra) no fato anterior: uma linha nunca começa com "·"
        h('span.ch-rank__facts', null, h('strong', null, level.label), `${DOT}${facts.join(DOT)}`),
      ),
      h('span.ch-rank__chev', null, icon('chevron-right', { size: 20 })),
    );
  }

  function renderRanking() {
    const a = last;
    const total = a.mainRows.length + a.otherRows.length;
    patch(
      rankHead,
      h(
        'div.ch-rank__head',
        { key: 'h' },
        h('h2.section-h__title', null, a.width > 20 ? `Ranking dos canais de ${fmtWidth(a.width)}` : 'Ranking dos canais', h('span.section-h__count', null, total)),
        h('p.ch-rank__intro', null, 'Nota de 0 a 100: quanto do canal sobra para um roteador ali, pelo que o celular ouve daqui (estimativa). Toque num canal para ver quem atrapalha.'),
      ),
    );
    // a lista principal mostra os melhores; o resto (e os canais fora da recomendação) fica a um toque
    let shownMain = a.mainRows;
    if (!memo.showOthers && a.mainRows.length > RANK_TOP) {
      shownMain = a.mainRows.slice(0, RANK_TOP);
      const current = a.mainRows.find((r) => r.isCurrent);
      if (current && !shownMain.includes(current)) shownMain.push(current);
    }
    const hidden = a.mainRows.length - shownMain.length + a.otherRows.length;
    const visible = memo.showOthers ? [...a.mainRows, ...a.otherRows] : shownMain;
    rankList.hidden = shownMain.length === 0;
    rankList.classList.toggle('ch-rank--wide', a.width > 20);
    patch(rankList, shownMain.map(rankRow));

    const anyDfs = visible.some((r) => r.rating.dfs);
    const anyPsc = visible.some((r) => r.rating.psc);
    patch(
      rankFoot,
      memo.showOthers && a.otherRows.length
        ? h(
            'div.ch-others',
            { key: 'others' },
            h('p.ch-rank__intro', null, h('strong', null, 'Fora da recomendação. '), OTHERS_REASON[a.band]),
            h('div', { class: ['card', 'card--flush', 'list', 'ch-rank', 'ch-rank--others', a.width > 20 && 'ch-rank--wide'] }, a.otherRows.map(rankRow)),
          )
        : null,
      anyDfs || anyPsc
        ? h(
            'div.ch-glossary',
            { key: 'glossary' },
            anyDfs ? h('p', null, badge('DFS', { tone: 'warning' }), h('span', null, 'Canal dividido com radares: o roteador espera cerca de 1 minuto antes de usá-lo e pode mudar de canal sozinho.')) : null,
            anyPsc ? h('p', null, badge('PSC', { outline: true }), h('span', null, 'Canal preferencial dos 6 GHz: é onde os aparelhos procuram redes primeiro.')) : null,
          )
        : null,
      hidden > 0 || memo.showOthers
        ? h(
            'div.ch-more',
            { key: 'more' },
            button(memo.showOthers ? 'Mostrar só os melhores' : `Mostrar os outros ${plural(hidden, 'canal', 'canais')}`, {
              variant: 'quiet',
              small: true,
              icon: memo.showOthers ? 'chevron-up' : 'chevron-down',
              'aria-expanded': memo.showOthers,
              onClick: () => {
                memo.showOthers = !memo.showOthers;
                renderRanking();
              },
            }),
          )
        : null,
    );
  }

  // --- painéis -----------------------------------------------------------------------------

  /** Painel cujo conteúdo é refeito a cada varredura enquanto estiver aberto. */
  function liveSheet(options, build) {
    const entry = { panel: null, update: null };
    entry.panel = sheet({
      ...options,
      content: build(),
      onClose: () => {
        live.delete(entry);
        if (options.onClose) options.onClose();
      },
    });
    entry.update = () => {
      const content = build();
      if (content) patch(entry.panel.body, content);
    };
    live.add(entry);
    return entry.panel;
  }

  let detailModule; // undefined = ainda não tentou; null = não existe
  async function openDetail(bssid) {
    if (detailModule === undefined) {
      try {
        detailModule = await import('../ap-detail.js');
      } catch {
        detailModule = null;
      }
    }
    if (dead) return;
    if (detailModule && typeof detailModule.openApDetail === 'function') {
      detailModule.openApDetail(ctx, bssid);
      return;
    }
    openBasicDetail(bssid);
  }

  /** Reserva para quando o painel completo de detalhes (ui/ap-detail.js) não está disponível. */
  function openBasicDetail(bssid) {
    const first = store.apById(bssid);
    if (!first) {
      toast('Essa rede não está mais ao alcance.');
      return;
    }
    liveSheet({ title: ssidLabel(first.ssid), subtitle: first.vendor || undefined }, () => {
      const ap = store.apById(bssid);
      if (!ap) return null;
      return [
        h('div.ch-sheet__signal', { key: 'sig' }, signalBadge(ap.rssi)),
        kvList([
          ['Canal', `${ap.channel}`],
          ['Largura', ap.occ && ap.occ.label ? ap.occ.label : fmtWidth(ap.widthMHz)],
          ['Frequência', fmtFreq(ap.freq)],
          ['Faixa', fmtBand(ap.band)],
          ['Padrão', ap.standardLabel || ap.standard || null],
          ['Segurança', ap.security ? securityBadge(ap.security, { plain: true }) : null],
          ['Fabricante', ap.vendor],
          ['BSSID', h('span.mono', null, ap.bssid), 'O endereço deste rádio'],
        ]),
      ];
    });
  }

  function openChannelSheet(key) {
    const find = () => (last ? [...last.mainRows, ...last.otherRows].find((r) => r.key === key) : null);
    const first = find();
    if (!first) return;
    const r0 = first.rating;
    const range0 = blockRange(r0);
    liveSheet(
      {
        title: channelTitle(r0),
        subtitle: range0 ? `${fmtBand(r0.band)} · canais ${range0} · ${fmtFreq(r0.lo)} a ${fmtFreq(r0.hi)}` : `${fmtBand(r0.band)} · ${fmtFreq(r0.centerFreq)}`,
      },
      () => {
        const row = find();
        if (!row) return null;
        const r = row.rating;
        const level = scoreLevel(r.score);
        const list = interferers(last.state.aps, r, last.exclude);
        const shown = list.slice(0, 8);
        const tags = [];
        if (row.isCurrent) tags.push(badge('Seu canal', { tone: 'accent', icon: 'router' }));
        if (row.isBest) tags.push(badge(bestTag(row, last && last.whatIf), { tone: 'good', icon: 'check' }));
        if (r.dfs) tags.push(badge('DFS', { tone: 'warning' }));
        if (r.psc) tags.push(badge('PSC', { outline: true }));
        return [
          h(
            'div.ch-sheet__score',
            { key: 'score' },
            h('div.ch-sheet__big', null, h('span.ch-sheet__num', null, fmtNum(Math.round(r.score))), h('span.ch-sheet__of', null, 'de 100'), h('span', { class: ['ch-sheet__level', `ch-lvl-${level.step}`] }, level.label)),
            scoreBar(r.score, { thick: true }),
            tags.length ? h('div.ch-rank__tags', null, tags) : null,
            h('p.ch-sheet__meaning', null, `Sobra cerca de ${fmtPct(Math.round(r.score))} da capacidade deste canal para um roteador aqui. É uma estimativa pelo que o celular ouve neste ponto.`),
          ),
          h('div.prose', { key: 'why' }, h('p', null, h('strong', null, 'Por que essa nota')), h('ul', null, explainRating(r).map((line) => h('li', null, line)), r.notes.map((note) => h('li', null, `${note}.`)))),
          shown.length
            ? h(
                'div',
                { key: 'who' },
                h('div.section-h.ch-sheet__h', null, h('h3.section-h__title', null, 'Quem pesa neste canal', h('span.section-h__count', null, list.length))),
                h(
                  'div.ch-who',
                  null,
                  shown.map(({ ap, kind }) =>
                    h(
                      'button.row.row--tappable.row--dense',
                      { key: ap.bssid, type: 'button', onClick: () => openDetail(ap.bssid) },
                      h('span.row__lead', null, signalBars(ap.rssi, { size: 'sm' })),
                      h(
                        'span.row__body',
                        null,
                        h('span.row__title', null, ssidLabel(ap.ssid)),
                        h('span.row__sub', null, `Canal ${ap.channel}${ap.widthMHz > 20 ? ` · ${fmtWidth(ap.widthMHz)}` : ''} · ${KIND_TEXT[kind]}`),
                      ),
                      h('span.row__trail', null, h('span.strong.num', null, fmtDbm(ap.rssi))),
                    ),
                  ),
                ),
                list.length > shown.length ? h('p.ch-note', null, `E mais ${plural(list.length - shown.length, 'rede mais fraca', 'redes mais fracas')}.`) : null,
              )
            : null,
          h('p.ch-rec__caveat', { key: 'how' }, 'A nota considera a força de cada vizinho, o quanto o canal dele invade este e o quanto ele costuma transmitir. ', BAND_ROAD[r.band]),
        ];
      },
    );
  }

  function openPicker() {
    liveSheet(
      {
        title: 'Qual é a sua rede?',
        subtitle: 'Marque a rede da sua casa: o app passa a falar do seu roteador nas recomendações.',
        tall: true,
        footer: [button('Pronto', { variant: 'primary', onClick: () => closeTop() })],
      },
      () => {
        if (!last) return null;
        const a = last;
        const { state } = a;
        const chosen = a.own ? a.own.bssid : null;
        const nets = state.networks
          .filter((n) => !n.hidden && n.ssid)
          .map((n) => ({
            n,
            here: n.aps.find((ap) => ap.band === a.band) || null,
            connected: n.aps.some((ap) => ap.connected),
            mine: n.aps.some((ap) => ap.own),
          }))
          .sort((x, y) => Number(y.connected) - Number(x.connected) || Number(y.mine) - Number(x.mine) || Number(!!y.here) - Number(!!x.here));
        const bandsText = (n) => (n.bands || []).map((b) => fmtBand(b)).join(' e ');
        return [
          a.candidates.length > 1
            ? h(
                'div',
                { key: 'radios' },
                h('div.section-h.ch-sheet__h', null, h('h3.section-h__title', null, `Seus roteadores em ${fmtBand(a.band)}`)),
                h('p.ch-note', null, 'Há mais de um ponto de acesso seu nesta faixa. Escolha qual deles analisar.'),
                h(
                  'div.ch-who',
                  { role: 'radiogroup', 'aria-label': 'Roteador analisado' },
                  a.candidates.map((c) =>
                    h(
                      'button.row.row--tappable.row--dense',
                      {
                        key: c.ap.bssid,
                        type: 'button',
                        role: 'radio',
                        'aria-checked': c.bssids.includes(chosen),
                        dataset: { bssid: c.ap.bssid },
                        onClick: () => {
                          memo.own[a.band] = c.ap.bssid;
                          render();
                        },
                      },
                      h('span.row__lead', null, signalBars(c.ap.rssi, { size: 'sm' })),
                      h(
                        'span.row__body',
                        null,
                        h('span.row__title', null, ssidLabel(c.ap.ssid)),
                        h('span.row__sub', null, `Canal ${c.ap.channel} · ${fmtWidth(c.ap.widthMHz)} · ${fmtDbm(c.ap.rssi)}${c.connected ? ' · conectado' : ''}`),
                      ),
                      h('span.ch-radio', { 'aria-hidden': 'true' }),
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { key: 'nets' },
            h('div.section-h.ch-sheet__h', null, h('h3.section-h__title', null, 'Redes por perto', h('span.section-h__count', null, nets.length))),
            nets.length
              ? h(
                  'div.ch-who',
                  null,
                  nets.map(({ n, here, connected, mine }) => {
                    const fav = state.favorites.has(n.ssid);
                    const facts = [bandsText(n)];
                    if (here) facts.push(`canal ${here.channel}`);
                    if (connected) facts.push('em uso agora');
                    else if (mine && !fav) facts.push('do roteador em uso');
                    return h(
                      'button.row.row--tappable.row--dense',
                      {
                        key: n.key,
                        type: 'button',
                        'aria-pressed': fav,
                        'aria-label': `${displaySsid(n.ssid)}: ${fav ? 'marcada como sua rede' : 'marcar como minha rede'}`,
                        dataset: { ssid: n.ssid },
                        onClick: () => {
                          const now = store.toggleFavorite(n.ssid);
                          toast(now ? 'Marcada como sua rede.' : 'Não é mais uma das suas redes.');
                        },
                      },
                      h('span.row__lead', null, signalBars(n.best ? n.best.rssi : null, { size: 'sm' })),
                      h('span.row__body', null, h('span.row__title', null, ssidLabel(n.ssid)), h('span.row__sub', null, facts.filter(Boolean).join(' · '))),
                      h('span', { class: ['ch-star', fav && 'ch-star--on'] }, icon(fav ? 'star-filled' : 'star', { size: 22 })),
                    );
                  }),
                )
              : h('p.ch-note', null, 'Nenhuma rede com nome por perto agora.'),
          ),
        ];
      },
    );
  }

  /** Fecha o painel de cima (o botão "Pronto" do seletor). */
  function closeTop() {
    const entries = [...live];
    const top = entries[entries.length - 1];
    if (top) top.panel.close();
  }

  function openChangeHelp() {
    const state = store.get();
    const a = last;
    const conn = state.connection && state.connection.connected ? state.connection : null;
    const gateway = conn && typeof conn.gateway === 'string' && /^[0-9a-f.:]+$/i.test(conn.gateway) ? conn.gateway : null;
    const own = a ? a.own : null;
    const target = a && a.verdict.best && own && a.verdict.verdict === 'change' ? a.verdict.best : null;
    const bandName = a ? fmtBand(a.band) : '';
    const keepChannel = a && own && a.verdict.current && a.verdict.verdict === 'keep' ? a.verdict.current.channel : null;
    const freest = a && !own && a.verdict.best ? a.verdict.best.channel : null;
    const panel = sheet({
      title: 'Como mudar o canal do roteador',
      subtitle: 'Vale para quase todas as marcas.',
      tall: true,
      content: [
        h(
          'div.prose',
          null,
          h(
            'ol.steps',
            null,
            h('li', null, h('strong', null, 'Fique no Wi-Fi do roteador.'), conn && conn.ssid ? h('span', null, ' Você está em ', h('strong', { dir: 'auto' }, displaySsid(conn.ssid)), '.') : ' Conecte o celular à rede que você quer ajustar.'),
            h(
              'li',
              null,
              h('strong', null, 'Abra a página do roteador.'),
              ' No navegador, digite o endereço dele na barra de endereços',
              gateway ? [': ', h('strong.mono', null, gateway), '. Esse é o endereço que a sua conexão informa; costuma estar também numa etiqueta embaixo do aparelho.'] : ' (os mais comuns são 192.168.0.1, 192.168.1.1 e 192.168.15.1; ele costuma estar numa etiqueta embaixo do aparelho).',
            ),
            h('li', null, h('strong', null, 'Entre com o usuário e a senha do roteador.'), nb(' Também ficam na etiqueta. Não é a senha do Wi-Fi.')),
            h(
              'li',
              null,
              h('strong', null, 'Procure a parte do Wi-Fi.'),
              ' O nome varia: “Wireless”, “Wi-Fi”, “WLAN” ou “Rede sem fio”. Escolha a faixa',
              bandName ? ` de ${bandName}` : '',
              ' e ache o campo “Canal”.',
            ),
            h(
              'li',
              null,
              h('strong', null, target ? `Troque para o canal ${target.channel}.` : 'Escolha o canal.'),
              target
                ? ''
                : keepChannel !== null
                  ? ` Pelo que o app ouve agora, o canal atual (${keepChannel}) já é uma boa escolha: só troque se a recomendação desta tela mudar.`
                  : freest !== null
                    ? ` O mais livre agora é o ${freest}.`
                    : '',
              target && target.widthMHz > 20 ? ` Largura: ${fmtWidth(target.widthMHz)}.` : a && a.band === '2.4' ? ' Largura: 20 MHz.' : '',
              ' Depois de salvar, o Wi-Fi cai por alguns segundos e volta no canal novo.',
            ),
            h('li', null, h('strong', null, 'Volte aqui e confira.'), ' Depois de uma ou duas buscas a nota do canal novo aparece nesta tela.'),
          ),
          h('p', null, h('strong', null, 'E o modo “Automático”? '), 'No automático o roteador escolhe o canal sozinho quando liga, e escolhe de novo a cada reinício: o canal de hoje pode não ser o de amanhã. Se a nota do seu canal já está boa, pode deixar no automático.'),
          h('p', null, h('strong', null, 'Roteador da operadora ou mesh? '), 'Alguns só deixam mudar pelo aplicativo da marca ou pelo atendimento da operadora, e sistemas mesh costumam escolher o canal sozinhos.'),
        ),
      ],
      footer: gateway
        ? [
            button('Copiar o endereço', {
              variant: 'secondary',
              icon: 'copy',
              onClick: async () => {
                const ok = await copyText(gateway);
                toast(ok ? `Endereço ${gateway} copiado.` : `Não deu para copiar. Anote: ${gateway}`);
              },
            }),
            button('Entendi', { variant: 'primary', onClick: () => panel.close() }),
          ]
        : [button('Entendi', { variant: 'primary', onClick: () => panel.close() })],
    });
    return panel;
  }

  function graphHelpArt() {
    // ilustração fixa, sem dados: duas "montanhas" que se sobrepõem
    return s(
      'svg.ch-art',
      { viewBox: '0 0 320 112', role: 'img', 'aria-label': 'Duas redes em canais vizinhos, uma alta e uma baixa, que se sobrepõem' },
      s('path.ch-art__grid', { d: 'M12 28H308M12 58H308' }),
      s('path.ch-art__other', { d: 'M150 96L176 86L184 60H252L260 86L286 96' }),
      s('path.ch-art__own', { d: 'M40 96L66 78L74 24H142L150 78L176 96' }),
      s('path.ch-art__axis', { d: 'M12 96.5H308' }),
      s('path.ch-art__mark', { d: 'M74 104H142M74 101v6M142 101v6' }),
      s('path.ch-art__mark', { d: 'M28 24V96M25 24h6M25 96h6' }),
    );
  }

  function openGraphHelp() {
    return sheet({
      title: 'Como ler este gráfico',
      tall: true,
      content: [
        graphHelpArt(),
        h(
          'div.prose',
          null,
          h(
            'ul',
            null,
            h('li', null, h('strong', null, 'Cada montanha é uma rede Wi-Fi'), ' que o celular ouve daqui.'),
            h('li', null, h('strong', null, 'A posição é o canal.'), ' Canal é a “pista” da estrada que a rede usa para transmitir. Os números ficam embaixo.'),
            h('li', null, h('strong', null, 'A largura é o espaço que ela ocupa'), ': 20, 40, 80 ou 160 MHz. Mais larga = mais rápida, mas esbarra em mais vizinhos.'),
            h('li', null, h('strong', null, 'A altura é a força do sinal'), ' neste ponto, em dBm. São números negativos: perto de −40 é muito forte; abaixo de −80, fraco.'),
            h('li', null, h('strong', null, 'Montanhas uma em cima da outra disputam o mesmo espaço.'), ' No mesmo canal, elas se revezam. Meio desencontradas, uma atropela a outra, o que é pior.'),
            h('li', null, h('span.ch-legend__item', null, h('i.ch-swatch.ch-swatch--own'), h('strong', null, 'Em azul, a sua rede;')), ' ', h('span.ch-legend__item', null, h('i.ch-swatch'), 'em cinza, os vizinhos.'), ' Contorno tracejado = rede que não foi ouvida na última busca.'),
          ),
          h('p', null, h('strong', null, '2,4 GHz: '), 'os canais ficam tão juntos que só o 1, o 6 e o 11 não se sobrepõem. Por isso quase todo roteador deveria usar um desses três.'),
          h('p', null, h('strong', null, '5 GHz: '), 'o sinal “//” no eixo marca um trecho sem canais de Wi-Fi, que o gráfico pula para caber na tela. O traço “DFS” fica sob os canais divididos com radares.'),
          h('p', null, h('strong', null, 'Para ver de perto: '), 'use os botões de zoom ou o gesto de pinça e arraste o gráfico para os lados. Toque numa montanha para saber de quem é.'),
        ),
      ],
    });
  }

  // --- ligações ----------------------------------------------------------------------------

  ctx.store.subscribe(
    (st) => ({
      aps: st.aps,
      own: st.own,
      favorites: st.favorites,
      info: st.info,
      seq: st.scan.seq,
      throttled: st.loop.throttled,
      tips: st.settings.tipsDismissed,
    }),
    render,
    { equal: shallowEqual },
  );
  // a idade dos dados ao lado do título (só aparece quando a lista está velha)
  const ageTimer = setInterval(() => {
    if (!document.hidden && last && !main.hidden) renderChartHead();
  }, 5000);
  ctx.onCleanup(() => clearInterval(ageTimer));

  render();

  return {
    onRoute(route) {
      ui.pending = readQuery(route);
      if (ui.pending) render();
    },
    unmount() {
      dead = true;
      clearInterval(ageTimer);
      for (const entry of [...live]) entry.panel.close();
      live.clear();
      graph.destroy();
    },
  };
}
