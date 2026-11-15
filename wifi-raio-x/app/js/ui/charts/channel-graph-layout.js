// Contas do gráfico de canais, sem tocar em tela nenhuma (tudo aqui é função pura e testada em
// tests/channel-graph-layout.test.mjs). Quem desenha é ui/charts/channel-graph.js.
//
//   mergeSections(trechos)                 junta trechos de frequência que se encostam
//   createFreqAxis({sections, width, ...}) eixo X: MHz -> px, com os buracos da faixa comprimidos e zoom
//   zoomAt(eixo, zoomNovo, xÂncora)        novo {zoom, scroll} mantendo a frequência sob o dedo
//   createDbmAxis({minDbm, maxDbm, ...})   eixo Y: dBm -> px, com as linhas de grade
//   pickTickLabels(marcas, opções)         quais números de canal cabem no eixo sem encostar
//   placeLabels(itens, limites, opções)    onde vão os nomes das redes, sem um cobrir o outro
//   truncateText(texto, largura, medir)    corta com reticências (sem partir um emoji no meio)
//   hitTest(formas, ponto, folga)          que rede está debaixo do dedo
//   nextInCycle(lista, atual)              toque repetido no mesmo lugar passa para a rede de baixo
//
// Unidades: frequência em MHz, sinal em dBm, tela em px de CSS. O "x" do eixo é medido a partir
// da borda esquerda da área do gráfico (já descontada a rolagem do zoom).

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Largura (px) do buraco comprimido entre dois trechos de canais. */
export const GAP_PX = 18;

/**
 * Junta trechos que se encostam ou se sobrepõem (nos 5 GHz, 100–144 e 149–165 viram um só:
 * não há buraco entre eles). Entrada fora de ordem ou torta é tolerada.
 * @param {{minFreq:number, maxFreq:number}[]} sections
 * @returns {{minFreq:number, maxFreq:number}[]}
 */
export function mergeSections(sections) {
  const list = (Array.isArray(sections) ? sections : [])
    .filter((s) => s && isNum(s.minFreq) && isNum(s.maxFreq) && s.maxFreq > s.minFreq)
    .map((s) => ({ minFreq: s.minFreq, maxFreq: s.maxFreq }))
    .sort((a, b) => a.minFreq - b.minFreq);
  const out = [];
  for (const s of list) {
    const last = out[out.length - 1];
    if (last && s.minFreq <= last.maxFreq) last.maxFreq = Math.max(last.maxFreq, s.maxFreq);
    else out.push(s);
  }
  return out;
}

/**
 * Eixo das frequências. Cada trecho é uma reta (mesma escala em todos); entre dois trechos fica
 * um buraco de largura fixa (`gapPx`), que é onde o desenho põe a marca de "eixo interrompido".
 * Com zoom, o conteúdo fica `zoom` vezes mais largo que a área e `scroll` diz quanto dele já
 * passou pela esquerda.
 *
 * @param {object} o
 * @param {{minFreq:number, maxFreq:number}[]} o.sections  trechos com canais (channelGraph().sections)
 * @param {number} o.width     largura da área do gráfico (px)
 * @param {number} [o.gapPx]
 * @param {number} [o.zoom=1]
 * @param {number} [o.scroll=0]
 * @returns {{
 *   width:number, zoom:number, scroll:number, maxScroll:number, contentWidth:number, pxPerMHz:number,
 *   segments:{minFreq:number, maxFreq:number, x0:number, x1:number}[],
 *   breaks:{x0:number, x1:number, x:number}[],
 *   x:(freq:number) => number,                 px de uma frequência (nos buracos, interpola; fora, extrapola)
 *   xIn:(segment:object, freq:number) => number,  px pela reta de UM trecho (para desenhar o que vaza dele)
 *   freq:(x:number) => number|null,            frequência de um px (null nos buracos e fora dos trechos)
 *   segmentOf:(freq:number) => object|null,    trecho que contém a frequência
 *   segmentAt:(x:number) => object|null        trecho debaixo de um px
 * }}
 */
export function createFreqAxis({ sections, width, gapPx = GAP_PX, zoom = 1, scroll = 0 } = {}) {
  const merged = mergeSections(sections);
  const w = isNum(width) && width > 0 ? width : 0;
  const z = isNum(zoom) && zoom > 1 ? zoom : 1;
  const totalMHz = merged.reduce((sum, s) => sum + (s.maxFreq - s.minFreq), 0);
  const gaps = Math.max(0, merged.length - 1) * gapPx;
  const contentWidth = w * z;
  const pxPerMHz = totalMHz > 0 ? Math.max(0, contentWidth - gaps) / totalMHz : 0;
  const maxScroll = Math.max(0, contentWidth - w);
  const sc = clamp(isNum(scroll) ? scroll : 0, 0, maxScroll);

  const segments = [];
  const breaks = [];
  let cursor = -sc;
  merged.forEach((s, i) => {
    if (i > 0) {
      breaks.push({ x0: cursor, x1: cursor + gapPx, x: cursor + gapPx / 2 });
      cursor += gapPx;
    }
    const x0 = cursor;
    cursor += (s.maxFreq - s.minFreq) * pxPerMHz;
    segments.push({ minFreq: s.minFreq, maxFreq: s.maxFreq, x0, x1: cursor });
  });

  const xIn = (segment, freq) => segment.x0 + (freq - segment.minFreq) * pxPerMHz;

  function x(freq) {
    if (!segments.length || !isNum(freq)) return NaN;
    const first = segments[0];
    if (freq <= first.minFreq) return xIn(first, freq);
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (freq <= seg.maxFreq) return xIn(seg, freq);
      const next = segments[i + 1];
      if (next && freq < next.minFreq) {
        // dentro do buraco: anda proporcionalmente pelos poucos px dele
        const t = (freq - seg.maxFreq) / (next.minFreq - seg.maxFreq);
        return seg.x1 + t * (next.x0 - seg.x1);
      }
    }
    return xIn(segments[segments.length - 1], freq);
  }

  const segmentAt = (px) => segments.find((seg) => px >= seg.x0 && px <= seg.x1) || null;
  const segmentOf = (freq) => segments.find((seg) => freq >= seg.minFreq && freq <= seg.maxFreq) || null;

  function freq(px) {
    const seg = isNum(px) ? segmentAt(px) : null;
    if (!seg || pxPerMHz <= 0) return null;
    return seg.minFreq + (px - seg.x0) / pxPerMHz;
  }

  return { width: w, zoom: z, scroll: sc, maxScroll, contentWidth, pxPerMHz, gapPx, segments, breaks, x, xIn, freq, segmentOf, segmentAt };
}

/**
 * Muda o zoom mantendo parada a frequência que está debaixo de `anchorX` (o meio da pinça ou
 * o centro da área, para os botões).
 * @param {{sections:object[], width:number, gapPx?:number, zoom:number, scroll:number}} view
 * @param {number} nextZoom  já limitado por quem chama
 * @param {number} [anchorX] px a partir da borda esquerda da área (padrão: o meio)
 * @returns {{zoom:number, scroll:number}}
 */
export function zoomAt(view, nextZoom, anchorX) {
  const width = view.width;
  const anchor = isNum(anchorX) ? clamp(anchorX, 0, width) : width / 2;
  const before = createFreqAxis(view);
  const zoom = Math.max(1, nextZoom);
  if (zoom === 1) return { zoom: 1, scroll: 0 };
  const f = before.freq(anchor);
  const probe = createFreqAxis({ ...view, zoom, scroll: 0 });
  let scroll;
  if (f === null) {
    // âncora em cima de um buraco: mantém a proporção do conteúdo
    scroll = ((before.scroll + anchor) * zoom) / before.zoom - anchor;
  } else {
    scroll = probe.x(f) - anchor;
  }
  return { zoom, scroll: clamp(scroll, 0, probe.maxScroll) };
}

/**
 * Eixo do sinal. `top` e `bottom` são os px do teto (maxDbm) e do chão (minDbm) da área.
 * As linhas de grade saem de 10 em 10 dB; os números, de 10 em 10 quando há altura e de 20 em
 * 20 quando não (para as linhas de texto não encostarem).
 * @returns {{minDbm:number, maxDbm:number, top:number, bottom:number, y:(dbm:number) => number,
 *            dbm:(y:number) => number, pxPerDb:number, ticks:{dbm:number, y:number, label:boolean}[]}}
 */
export function createDbmAxis({ minDbm, maxDbm, top, bottom, minLabelGap = 20 } = {}) {
  const lo = isNum(minDbm) ? minDbm : -100;
  const hi = isNum(maxDbm) && maxDbm > lo ? maxDbm : lo + 10;
  const pxPerDb = (bottom - top) / (hi - lo);
  const y = (dbm) => bottom - (dbm - lo) * pxPerDb;
  const dbm = (py) => lo + (bottom - py) / pxPerDb;
  const every = pxPerDb * 10 >= minLabelGap ? 10 : pxPerDb * 20 >= minLabelGap ? 20 : 40;
  const ticks = [];
  for (let v = Math.ceil(lo / 10) * 10; v <= hi + 1e-9; v += 10) {
    // o chão não leva número: ali fica o eixo dos canais
    ticks.push({ dbm: v, y: y(v), label: v > lo && Math.abs(v % every) < 1e-9 });
  }
  return { minDbm: lo, maxDbm: hi, top, bottom, y, dbm, pxPerDb, ticks };
}

/**
 * Escolhe os números de canal que cabem no eixo. Os de maior prioridade entram primeiro; um
 * número só entra se não encostar em outro já escolhido e couber inteiro entre `left` e `right`.
 *
 * @param {{freq:number, channel:number}[]} ticks
 * @param {object} o
 * @param {(tick:object) => number} o.x          px do centro da marca
 * @param {(text:string) => number} o.measure    largura do texto em px
 * @param {(tick:object) => number} [o.priority] maior = mais importante (padrão: todos iguais)
 * @param {number} [o.minGap=5]                  folga mínima entre dois números
 * @param {number} [o.left=-Infinity]
 * @param {number} [o.right=Infinity]
 * @returns {{tick:object, x:number, width:number, text:string}[]}  em ordem de frequência
 */
export function pickTickLabels(ticks, { x, measure, priority, minGap = 5, left = -Infinity, right = Infinity } = {}) {
  const items = (Array.isArray(ticks) ? ticks : [])
    .map((tick, index) => {
      const text = String(tick.channel);
      return { tick, index, text, x: x(tick), width: measure(text), rank: priority ? priority(tick) : 0 };
    })
    .filter((it) => isNum(it.x) && it.x - it.width / 2 >= left - 0.5 && it.x + it.width / 2 <= right + 0.5);
  items.sort((a, b) => b.rank - a.rank || a.index - b.index);
  const placed = [];
  for (const it of items) {
    const a0 = it.x - it.width / 2 - minGap / 2;
    const a1 = it.x + it.width / 2 + minGap / 2;
    const clash = placed.some((p) => a0 < p.x + p.width / 2 + minGap / 2 && a1 > p.x - p.width / 2 - minGap / 2);
    if (!clash) placed.push(it);
  }
  return placed.sort((a, b) => a.x - b.x).map(({ tick, x: px, width, text }) => ({ tick, x: px, width, text }));
}

function segmenter() {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    try {
      return new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    } catch {
      return null;
    }
  }
  return null;
}

let graphemes = null;
/** Divide em "letras" como a pessoa as vê (um emoji composto conta como uma). */
function splitGraphemes(text) {
  if (graphemes === null) graphemes = segmenter() || false;
  if (graphemes) return Array.from(graphemes.segment(text), (s) => s.segment);
  return Array.from(text);
}

/**
 * Corta o texto para caber em `maxWidth`, com reticências no fim. Nunca parte um emoji ou uma
 * letra acentuada pela metade. Se nem a primeira letra cabe, devolve ''.
 * @param {string} text
 * @param {number} maxWidth
 * @param {(text:string) => number} measure
 */
export function truncateText(text, maxWidth, measure, ellipsis = '…') {
  const full = String(text ?? '');
  if (full === '' || measure(full) <= maxWidth) return full;
  const parts = splitGraphemes(full);
  let lo = 0;
  let hi = parts.length - 1;
  // maior prefixo que cabe junto com as reticências
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(parts.slice(0, mid).join('').trimEnd() + ellipsis) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return '';
  return parts.slice(0, lo).join('').trimEnd() + ellipsis;
}

const overlaps = (a, b, gap) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

/**
 * Posiciona os nomes das redes em cima dos picos, sem sobreposição. Guloso por prioridade: cada
 * nome tenta ficar logo acima do pico; se ali já há outro, sobe um andar (até `levels`); se a
 * forma é alta demais para caber algo em cima, tenta logo abaixo do pico, por dentro. O que não
 * couber em lugar nenhum fica sem nome (o toque no gráfico continua mostrando quem é).
 *
 * @param {{id:string, cx:number, top:number, w:number, h:number, priority?:number}[]} items
 *        cx = px do centro do pico, top = px do topo do pico, w/h = tamanho da caixa do nome
 * @param {{left:number, right:number, top:number, bottom:number}} bounds  área onde nomes podem ficar
 * @param {{gap?:number, lift?:number, levels?:number, max?:number}} [options]
 *        gap = folga entre caixas; lift = distância do pico até a caixa; max = quantos nomes no máximo
 * @returns {{id:string, x:number, y:number, w:number, h:number, level:number, cx:number, top:number, inside:boolean}[]}
 */
export function placeLabels(items, bounds, { gap = 3, lift = 4, levels = 3, max = Infinity } = {}) {
  const queue = (Array.isArray(items) ? items : [])
    .filter((it) => it && isNum(it.cx) && isNum(it.top) && it.w > 0 && it.h > 0 && it.w <= bounds.right - bounds.left)
    .map((it, index) => ({ it, index }))
    .sort((a, b) => (b.it.priority ?? 0) - (a.it.priority ?? 0) || a.index - b.index);
  const placed = [];
  for (const { it } of queue) {
    if (placed.length >= max) break;
    const x = clamp(it.cx - it.w / 2, bounds.left, bounds.right - it.w);
    let spot = null;
    let y = it.top - lift - it.h;
    for (let level = 0; level < levels && !spot && y >= bounds.top; level++) {
      const box = { x, y, w: it.w, h: it.h };
      const blockers = placed.filter((p) => overlaps(box, p, gap));
      if (!blockers.length) spot = { ...box, level, inside: false };
      // ocupado: sobe até encostar (com a folga) em cima de quem está no caminho
      else y = Math.min(...blockers.map((p) => p.y)) - gap - it.h;
    }
    if (!spot) {
      // por dentro da forma, logo abaixo do pico (só faz sentido se ainda sobra altura até o chão)
      const y = Math.max(bounds.top, it.top + lift);
      const box = { x, y, w: it.w, h: it.h };
      if (y + it.h <= bounds.bottom - it.h && !placed.some((p) => overlaps(box, p, gap))) spot = { ...box, level: 0, inside: true };
    }
    if (spot) placed.push({ id: it.id, ...spot, cx: it.cx, top: it.top });
  }
  return placed;
}

function inPolygon(points, f, d) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > d !== yj > d && f < ((xj - xi) * (d - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distância do ponto ao contorno, com cada eixo medido na sua folga (1 = no limite da folga). */
function outlineDistance(points, f, d, tol) {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const ax = points[i][0] / tol.freq;
    const ay = points[i][1] / tol.dbm;
    const bx = points[i + 1][0] / tol.freq;
    const by = points[i + 1][1] / tol.dbm;
    const px = f / tol.freq;
    const py = d / tol.dbm;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/**
 * Que redes estão debaixo de um ponto do gráfico. Devolve as candidatas na ordem em que o
 * toque deve escolhê-las: primeiro as formas que contêm o ponto, da mais baixa para a mais alta
 * (quem mira numa rede fraca escondida debaixo de uma forte acerta a fraca; para a forte basta
 * tocar mais acima); se nenhuma contém, as de contorno mais próximo, dentro da folga.
 *
 * @param {{bssid:string, rssi:number, widthMHz?:number, points:number[][]}[]} shapes  (channelGraph().shapes)
 * @param {{freq:number, dbm:number}} point
 * @param {{freq:number, dbm:number}} [tol]  folga do dedo, já convertida para MHz e dB
 * @returns {object[]}  formas (os mesmos objetos), sem BSSID repetido
 */
export function hitTest(shapes, point, tol = { freq: 0, dbm: 0 }) {
  if (!point || !isNum(point.freq) || !isNum(point.dbm)) return [];
  const inside = [];
  const near = [];
  for (const shape of Array.isArray(shapes) ? shapes : []) {
    if (!shape || !Array.isArray(shape.points) || shape.points.length < 2) continue;
    if (inPolygon(shape.points, point.freq, point.dbm)) inside.push(shape);
    else if (tol.freq > 0 && tol.dbm > 0) {
      const dist = outlineDistance(shape.points, point.freq, point.dbm, tol);
      if (dist <= 1) near.push({ shape, dist });
    }
  }
  const width = (s) => (isNum(s.widthMHz) ? s.widthMHz : 0);
  inside.sort((a, b) => a.rssi - b.rssi || width(a) - width(b));
  near.sort((a, b) => a.dist - b.dist);
  const ordered = inside.length ? inside : near.map((n) => n.shape);
  const seen = new Set();
  return ordered.filter((s) => (seen.has(s.bssid) ? false : (seen.add(s.bssid), true)));
}

/**
 * Toque repetido no mesmo lugar: se a rede em destaque já é uma das candidatas, passa para a
 * seguinte (e volta para a primeira depois da última).
 * @param {{bssid:string}[]} candidates
 * @param {string|null} current
 * @returns {object|null}
 */
export function nextInCycle(candidates, current) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const at = candidates.findIndex((c) => c.bssid === current);
  return candidates[(at + 1) % candidates.length];
}

/** Limites do zoom de uma faixa: o máximo deixa os canais vizinhos a um dedo de distância. */
export function maxZoomFor(band, basePxPerMHz) {
  if (!isNum(basePxPerMHz) || basePxPerMHz <= 0) return 1;
  // 2,4 GHz: canais a cada 5 MHz (queremos ~56 px entre eles); 5 e 6 GHz: a cada 20 MHz (~48 px)
  const target = String(band) === '2.4' ? 11 : 2.4;
  return clamp(Math.ceil((target / basePxPerMHz) * 2) / 2, 2, 12);
}
