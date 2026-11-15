// Minigráfico do sinal nos últimos minutos, para as linhas das listas.
//
//   sparkline(pontos, opções)             -> <svg> pronto para entrar na árvore (serve com patch())
//   sparklineGeometry(pontos, opções)     -> { d, dot } (só a conta; testável sem DOM)
//
// É um SVG de um traço só, não um canvas: 60 linhas viram 60 atributos `d`, o desenho fica
// nítido em qualquer densidade de tela e a cor vem do CSS (a do texto em volta, currentColor),
// então muda sozinha com o tema e com a faixa de sinal da linha.
//
// A escala vertical é "sensibilidade fixa, base solta": cada minigráfico é centrado na própria
// média, mas com pelo menos SPAN_DB de altura, então o chuvisco de ±2 dB de uma rede parada
// não parece uma montanha-russa e uma queda de 15 dB aparece em todos do mesmo tamanho.
// Onde a rede deixou de ser ouvida o traço é interrompido.

const SVG_NS = 'http://www.w3.org/2000/svg';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export const SPARK_DEFAULTS = Object.freeze({
  width: 64,
  height: 18,
  /** janela de tempo mostrada */
  windowMs: 120_000,
  /** sem leitura por mais que isto: o traço é interrompido */
  gapMs: 25_000,
  /** altura mínima da escala, em dB */
  spanDb: 24,
  /** margem para o traço e o ponto final não serem cortados */
  pad: 2.5,
});

const r1 = (x) => Math.round(x * 10) / 10;

/**
 * A conta do minigráfico.
 * @param {{t:number, rssi:number}[]} points  leituras em ordem de tempo (ms desde 1970)
 * @param {{now:number, width?:number, height?:number, windowMs?:number, gapMs?:number, spanDb?:number, pad?:number}} options
 *        now = o instante da borda direita (em geral o da última varredura)
 * @returns {{d:string, dot:{x:number, y:number}|null, count:number}}
 *          d = atributo do <path> ('' sem leituras na janela); dot = ponto final, quando a
 *          última leitura é recente; count = leituras dentro da janela
 */
export function sparklineGeometry(points, options) {
  const o = { ...SPARK_DEFAULTS, ...(options || {}) };
  const now = isNum(o.now) ? o.now : Date.now();
  const from = now - o.windowMs;
  const list = [];
  let before = null; // a última leitura antes da janela: o traço entra pela borda esquerda
  for (const p of Array.isArray(points) ? points : []) {
    if (!p || !isNum(p.t) || !isNum(p.rssi) || p.t > now + 1000) continue;
    if (p.t < from) before = p;
    else list.push(p);
  }
  if (!list.length) return { d: '', dot: null, count: 0 };

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of list) {
    if (p.rssi < lo) lo = p.rssi;
    if (p.rssi > hi) hi = p.rssi;
  }
  const span = Math.max(o.spanDb, hi - lo);
  const mid = (hi + lo) / 2;
  const top = mid + span / 2;
  const innerW = o.width - 2 * o.pad;
  const innerH = o.height - 2 * o.pad;
  const xOf = (t) => o.pad + Math.min(1, Math.max(0, (t - from) / o.windowMs)) * innerW;
  const yOf = (v) => o.pad + Math.min(1, Math.max(0, (top - v) / span)) * innerH;

  let d = '';
  let prev = null;
  let run = 0; // pontos no trecho atual
  const first = list[0];
  if (before && first.t - before.t <= o.gapMs) {
    // interpola o valor na borda esquerda
    const k = (from - before.t) / (first.t - before.t);
    d += `M${r1(o.pad)} ${r1(yOf(before.rssi + (first.rssi - before.rssi) * k))}`;
    prev = { t: from };
    run = 1;
  }
  for (const p of list) {
    const x = r1(xOf(p.t));
    const y = r1(yOf(p.rssi));
    if (prev && p.t - prev.t <= o.gapMs) {
      d += `L${x} ${y}`;
      run += 1;
    } else {
      // um trecho de um ponto só vira um tracinho (com pontas redondas, um ponto visível)
      if (run === 1) d += 'h0.01';
      d += `M${x} ${y}`;
      run = 1;
    }
    prev = p;
  }
  if (run === 1) d += 'h0.01';

  const last = list[list.length - 1];
  const dot = now - last.t <= o.gapMs ? { x: r1(xOf(last.t)), y: r1(yOf(last.rssi)) } : null;
  return { d, dot, count: list.length };
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const key in attrs) el.setAttribute(key, String(attrs[key]));
  return el;
}

/**
 * Minigráfico como elemento. Decorativo (aria-hidden): o número ao lado é quem informa.
 * A cor é a do texto em volta; para a cor do sinal, ponha-o dentro de um elemento com
 * `color: var(--sig)`.
 * @param {{t:number, rssi:number}[]} points
 * @param {Parameters<typeof sparklineGeometry>[1] & {class?:string}} options
 * @returns {SVGSVGElement}
 */
export function sparkline(points, options = {}) {
  const o = { ...SPARK_DEFAULTS, ...options };
  const geo = sparklineGeometry(points, o);
  const svg = svgEl('svg', {
    class: options.class ? `spark ${options.class}` : 'spark',
    width: o.width,
    height: o.height,
    viewBox: `0 0 ${o.width} ${o.height}`,
    fill: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  // os dois elementos existem sempre: assim patch() só troca atributos, sem criar nem remover nós
  svg.appendChild(
    svgEl('path', {
      class: 'spark__line',
      d: geo.d || 'M0 0',
      stroke: 'currentColor',
      'stroke-width': 1.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      opacity: geo.d ? 1 : 0,
    }),
  );
  svg.appendChild(
    svgEl('circle', {
      class: 'spark__dot',
      cx: geo.dot ? geo.dot.x : 0,
      cy: geo.dot ? geo.dot.y : 0,
      r: 2,
      fill: 'currentColor',
      opacity: geo.dot ? 1 : 0,
    }),
  );
  return svg;
}
