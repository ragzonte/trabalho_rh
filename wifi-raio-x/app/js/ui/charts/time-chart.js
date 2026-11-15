// Gráfico de linhas do sinal ao longo do tempo (canvas).
//
//   const chart = createTimeChart(container, { windowMs: 120_000, height: 180 });
//   chart.setSeries([{ id, label, color: '--cat-1', points: [{ t, rssi }], emphasis: true }]);
//   chart.setWindow(300_000);     // janela de tempo mostrada
//   chart.resize();               // o contêiner mudou de tamanho (já é chamado sozinho por ResizeObserver)
//   chart.destroy();              // para temporizadores, observadores e remove o canvas
//   extras: chart.setPaused(bool) · chart.setGap(ms) · chart.el (o <canvas>)
//
// O que ele desenha
//   - eixo vertical em dBm, com linhas a cada 10 dB e as faixas de qualidade do app (ótimo, bom,
//     regular, fraco) como uma régua colorida com as palavras ao lado e um fundo bem leve;
//   - eixo do tempo relativo: "agora", "−30 s", "−1 min"... O gráfico anda sozinho (1 vez por
//     segundo) mesmo sem leitura nova, para nunca fingir que um dado velho é de agora;
//   - uma linha por série, interrompida onde a rede ficou sem ser ouvida por mais de `gapMs`;
//     a série com `emphasis` vai por cima, mais grossa; `muted` vai em cinza;
//   - rótulos diretos na ponta de cada linha (sem legenda separada), afastados para não se
//     sobreporem e cortados com reticências se o nome for comprido;
//   - ao tocar/arrastar: uma régua vertical com o valor de cada série naquele instante.
//
// Cores: `color` de cada série é um token do tema ('--cat-1', '--accent') ou uma cor CSS. Os
// tokens são relidos quando o tema muda (atributo data-theme do <html>).
// Nitidez: o canvas tem devicePixelRatio pixels por pixel CSS e é refeito a cada mudança de tamanho.
// Texto no canvas não passa por HTML: nomes de rede hostis são só desenhados.
//
// As contas (escala, marcas do eixo, trechos, posição dos rótulos) são funções puras exportadas
// e testadas em tests/time-chart.test.mjs.

import { cssVar, fmtClock, MINUS, THIN } from '../dom.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
// caracteres de controle e separadores de linha (um nome de rede pode trazer qualquer coisa)
const CONTROL_CHARS = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

// ---------------------------------------------------------------------------
// Contas (sem DOM)
// ---------------------------------------------------------------------------

/** Limites das faixas de qualidade (os mesmos de core/signal.js signalLevel), do melhor para o pior. */
export const QUALITY_ZONES = Object.freeze([
  Object.freeze({ min: -50, token: '--sig-1', word: 'excelente' }),
  Object.freeze({ min: -60, token: '--sig-1', word: 'ótimo' }),
  Object.freeze({ min: -67, token: '--sig-2', word: 'bom' }),
  Object.freeze({ min: -75, token: '--sig-3', word: 'regular' }),
  Object.freeze({ min: -82, token: '--sig-4', word: 'fraco' }),
  Object.freeze({ min: -Infinity, token: '--sig-5', word: 'muito fraco' }),
]);

/**
 * Escala vertical: cobre os valores com folga, em múltiplos de `step`, com pelo menos `minSpan`
 * de altura (uma rede parada não vira um serrote de 2 dB esticado na tela inteira).
 * @param {number[]} values  dBm
 * @param {{minSpan?:number, step?:number, lo?:number, hi?:number, pad?:number}} [options]
 * @returns {{min:number, max:number}}
 */
export function yRange(values, { minSpan = 30, step = 10, lo = -100, hi = -20, pad = 3 } = {}) {
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const v of Array.isArray(values) ? values : []) {
    if (!isNum(v)) continue;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  if (vMin === Infinity) return { min: -90, max: -40 };
  let min = Math.max(lo, Math.floor((vMin - pad) / step) * step);
  let max = Math.min(hi, Math.ceil((vMax + pad) / step) * step);
  // alarga alternando para baixo e para cima até ter a altura mínima
  let down = true;
  let guard = 0;
  while (max - min < minSpan && guard++ < 40) {
    if (down && min - step >= lo) min -= step;
    else if (max + step <= hi) max += step;
    else if (min - step >= lo) min -= step;
    else break;
    down = !down;
  }
  return { min, max };
}

/** Rótulo de uma idade no eixo do tempo: 0 -> "agora"; 30 -> "−30 s"; 120 -> "−2 min". */
export function ageLabel(ageS) {
  const s = Math.round(ageS);
  if (s <= 0) return 'agora';
  if (s % 60 === 0) return `${MINUS}${s / 60}${THIN}min`;
  return `${MINUS}${s}${THIN}s`;
}

const TICK_STEPS_S = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];

/**
 * Marcas do eixo do tempo: da direita ("agora") para a esquerda, no maior detalhe que cabe.
 * @param {number} windowMs
 * @param {number} plotWidth    largura da área do gráfico em px
 * @param {number} [minSpacing] distância mínima entre marcas (px)
 * @returns {{ageMs:number, label:string}[]}
 */
export function timeTicks(windowMs, plotWidth, minSpacing = 62) {
  const windowS = Math.max(1, Math.round(windowMs / 1000));
  const maxTicks = Math.max(2, Math.floor(plotWidth / minSpacing) + 1);
  let step = TICK_STEPS_S[TICK_STEPS_S.length - 1];
  for (const s of TICK_STEPS_S) {
    if (Math.floor(windowS / s) + 1 <= maxTicks) {
      step = s;
      break;
    }
  }
  const ticks = [];
  for (let age = 0; age <= windowS; age += step) ticks.push({ ageMs: age * 1000, label: ageLabel(age) });
  return ticks;
}

/**
 * Corta uma série em trechos contínuos: onde duas leituras seguidas estão a mais de `gapMs`
 * uma da outra a rede não foi ouvida, e a linha é interrompida.
 * Fica também a última leitura antes de `from` (se ligada à seguinte), para a linha entrar pela borda.
 * @param {{t:number, rssi:number}[]} points  em ordem de tempo
 * @param {{from:number, to:number, gapMs:number}} range
 * @returns {{t:number, rssi:number}[][]}
 */
export function splitSegments(points, { from, to, gapMs }) {
  const segments = [];
  let current = null;
  let prev = null;
  for (const p of Array.isArray(points) ? points : []) {
    if (!p || !isNum(p.t) || !isNum(p.rssi)) continue;
    if (p.t > to) break;
    if (p.t < from) {
      prev = p; // candidato a ponto de entrada
      continue;
    }
    if (current && p.t - current[current.length - 1].t <= gapMs) {
      current.push(p);
    } else {
      current = prev && prev.t < from && p.t - prev.t <= gapMs ? [prev, p] : [p];
      segments.push(current);
    }
    prev = p;
  }
  return segments;
}

/**
 * Valor de uma série no instante `t`, interpolado entre as duas leituras vizinhas. null quando
 * `t` cai num intervalo sem sinal (ou fora dos dados por mais de meia lacuna).
 */
export function valueAt(points, t, gapMs) {
  let before = null;
  let after = null;
  for (const p of Array.isArray(points) ? points : []) {
    if (!p || !isNum(p.t) || !isNum(p.rssi)) continue;
    if (p.t <= t) before = p;
    else {
      after = p;
      break;
    }
  }
  if (before && after) {
    if (after.t - before.t > gapMs) {
      if (t - before.t <= gapMs / 4) return before.rssi;
      if (after.t - t <= gapMs / 4) return after.rssi;
      return null;
    }
    const k = (t - before.t) / (after.t - before.t);
    return before.rssi + (after.rssi - before.rssi) * k;
  }
  const only = before || after;
  return only && Math.abs(only.t - t) <= gapMs / 2 ? only.rssi : null;
}

/**
 * Afasta rótulos que cairiam um em cima do outro, sem sair de [top, bottom].
 * @param {{y:number}[]} items  posição desejada (centro) de cada rótulo
 * @param {{top:number, bottom:number, gap:number}} box  gap = distância mínima entre centros
 * @returns {number[]} a posição final de cada item, na ordem recebida
 */
export function spreadLabels(items, { top, bottom, gap }) {
  const order = items.map((item, index) => ({ index, y: Math.min(bottom, Math.max(top, item.y)) })).sort((a, b) => a.y - b.y || a.index - b.index);
  for (let i = 1; i < order.length; i++) order[i].y = Math.max(order[i].y, order[i - 1].y + gap);
  if (order.length && order[order.length - 1].y > bottom) {
    order[order.length - 1].y = bottom;
    for (let i = order.length - 2; i >= 0; i--) order[i].y = Math.min(order[i].y, order[i + 1].y - gap);
    // não cabe tudo: distribui por igual (os rótulos se encostam, mas nenhum some)
    if (order[0].y < top) {
      const stepY = order.length > 1 ? (bottom - top) / (order.length - 1) : 0;
      order.forEach((o, i) => {
        o.y = top + stepY * i;
      });
    }
  }
  const out = new Array(items.length);
  for (const o of order) out[o.index] = o.y;
  return out;
}

/**
 * Corta um texto com reticências para caber em `maxWidth`. Corta por caracteres inteiros
 * (um emoji não é partido ao meio).
 * @param {string} text
 * @param {number} maxWidth
 * @param {(text:string) => number} measure
 */
export function ellipsize(text, maxWidth, measure) {
  const clean = String(text ?? '').replace(CONTROL_CHARS, '·');
  if (measure(clean) <= maxWidth) return clean;
  const chars = Array.from(clean);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${chars.slice(0, mid).join('').trimEnd()}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${chars.slice(0, lo).join('').trimEnd()}…` : '…';
}

/**
 * Como ellipsize(), mas para rótulos "nome · detalhe" (ex.: "Casa · 5 GHz"): quem encolhe é o
 * nome; o detalhe depois do primeiro " · " fica inteiro, porque é ele que distingue duas linhas
 * com o mesmo nome. Se nem assim couber, corta o texto todo.
 */
export function ellipsizeLabel(text, maxWidth, measure) {
  const clean = String(text ?? '').replace(CONTROL_CHARS, '·');
  if (measure(clean) <= maxWidth) return clean;
  const cut = clean.indexOf(' · ');
  if (cut > 0) {
    const tail = clean.slice(cut);
    const room = maxWidth - measure(tail);
    // sobra lugar para pelo menos uns 3 caracteres do nome mais as reticências
    if (room >= measure('MMM…')) return `${ellipsize(clean.slice(0, cut), room, measure)}${tail}`;
  }
  return ellipsize(clean, maxWidth, measure);
}

// ---------------------------------------------------------------------------
// O gráfico
// ---------------------------------------------------------------------------

const PAD = { top: 24, bottom: 24, left: 34, right: 14 };
const LABEL_GAP = 15; // distância mínima entre os centros de dois rótulos
const LABEL_MAX_FRACTION = 0.34; // quanto da largura os rótulos podem tomar

/**
 * @typedef {Object} TimeSeries
 * @property {string} id
 * @property {string} [label]      nome na ponta da linha (texto hostil: só é desenhado)
 * @property {string} [color]      token do tema ('--cat-1') ou cor CSS; padrão: a paleta, pela ordem
 * @property {{t:number, rssi:number}[]} points  em ordem de tempo; t em ms desde 1970
 * @property {boolean} [emphasis]  a série principal: mais grossa e por cima
 * @property {boolean} [muted]     em cinza (contexto)
 * @property {number} [gapMs]      lacuna própria desta série (ex.: 4 s para leituras de 1 em 1 s)
 */

/**
 * @param {HTMLElement} container  o canvas ocupa a largura dele
 * @param {object} [options]
 * @param {number} [options.windowMs=120000]  janela de tempo mostrada
 * @param {number} [options.height=180]       altura em px CSS
 * @param {number} [options.gapMs=25000]      sem leitura por mais que isto: a linha é interrompida
 * @param {boolean} [options.labels=true]     rótulos na ponta das linhas (desligue com uma série só)
 * @param {boolean} [options.zoneWords=true]  sem rótulos de série, a margem direita mostra as palavras das faixas
 *                                            de qualidade (ótimo, bom, regular...) ao lado da régua colorida
 * @param {boolean} [options.live=true]       o eixo do tempo anda sozinho
 * @param {boolean} [options.interactive=true] régua de leitura ao tocar
 * @param {() => number} [options.now]        relógio (padrão Date.now)
 * @param {string} [options.ariaLabel]
 * @param {string} [options.emptyText]
 * @returns {{el:HTMLCanvasElement, setSeries:(list:TimeSeries[]) => void, setWindow:(ms:number) => void,
 *            setGap:(ms:number) => void, setPaused:(on:boolean) => void, resize:() => void, destroy:() => void}}
 */
export function createTimeChart(container, options = {}) {
  const opt = {
    windowMs: 120_000,
    height: 180,
    gapMs: 25_000,
    labels: true,
    zoneWords: true,
    live: true,
    interactive: true,
    now: () => Date.now(),
    ariaLabel: 'Sinal ao longo do tempo',
    emptyText: 'Ainda sem leituras neste período',
    ...options,
  };

  const canvas = document.createElement('canvas');
  canvas.className = 'time-chart';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', opt.ariaLabel);
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = `${opt.height}px`;
  canvas.style.touchAction = 'pan-y';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let series = [];
  let width = 0;
  let dpr = 1;
  let range = { min: -90, max: -40 };
  let pausedAt = null;
  let cursorX = null; // px, dentro do gráfico
  let destroyed = false;
  let colors = null;
  let fontFamily = 'system-ui, sans-serif';
  let reveal = 1; // 0..1: animação da primeira vez que há dados
  let revealed = false;
  let raf = 0;
  let timer = 0;

  const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clock = () => (pausedAt !== null ? pausedAt : opt.now());

  function readTheme() {
    const token = (name, fallback) => cssVar(name) || fallback;
    colors = {
      text: token('--text', '#e8eef9'),
      label: token('--chart-label', '#93a0b8'),
      grid: token('--chart-grid', 'rgba(147,160,184,0.16)'),
      axis: token('--chart-axis', '#4a5a78'),
      surface: token('--surface', '#121a2b'),
      line: token('--line', '#26324a'),
      accent: token('--accent', '#38bdf8'),
      zones: QUALITY_ZONES.map((z) => token(z.token, '#93a0b8')),
      cat: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => token(`--cat-${i}`, '#93a0b8')),
      cache: new Map(),
    };
    const family = getComputedStyle(document.body).fontFamily;
    if (family) fontFamily = family;
  }

  function colorOf(s, index) {
    if (s.muted) return colors.label;
    const spec = s.color;
    if (!spec) return colors.cat[index % colors.cat.length];
    if (!spec.startsWith('--')) return spec;
    let value = colors.cache.get(spec);
    if (value === undefined) {
      value = cssVar(spec) || colors.accent;
      colors.cache.set(spec, value);
    }
    return value;
  }

  const font = (size, weight = 400) => `${weight} ${size}px ${fontFamily}`;

  function computeRange() {
    const to = clock();
    const from = to - opt.windowMs;
    const values = [];
    for (const s of series) {
      for (const p of s.points) if (p.t >= from - opt.gapMs && p.t <= to + 1000) values.push(p.rssi);
    }
    range = yRange(values);
  }

  function layout() {
    let right = PAD.right;
    let labelWidth = 0;
    let wordWidth = 0;
    if (opt.labels && series.some((s) => s.label)) {
      ctx.font = font(12, 600);
      const cap = Math.min(132, Math.max(56, width * LABEL_MAX_FRACTION));
      for (const s of series) if (s.label) labelWidth = Math.max(labelWidth, Math.min(cap, ctx.measureText(String(s.label)).width + 1));
      right = Math.ceil(labelWidth) + 18;
    } else if (opt.zoneWords) {
      // sem rótulos de série, a margem direita vira a régua de qualidade, com as palavras
      ctx.font = font(12, 500);
      for (const zone of QUALITY_ZONES) wordWidth = Math.max(wordWidth, ctx.measureText(zone.word).width);
      right = Math.ceil(wordWidth) + 18;
    }
    const plot = { x: PAD.left, y: PAD.top, w: Math.max(10, width - PAD.left - right), h: Math.max(10, opt.height - PAD.top - PAD.bottom) };
    return { plot, labelWidth, wordWidth };
  }

  function draw() {
    if (destroyed || !width) return;
    if (!colors) readTheme();
    const to = clock();
    const from = to - opt.windowMs;
    const { plot, labelWidth, wordWidth } = layout();
    const xOf = (t) => plot.x + ((t - from) / opt.windowMs) * plot.w;
    const yOf = (v) => plot.y + ((range.max - v) / (range.max - range.min)) * plot.h;
    const bottom = plot.y + plot.h;
    const rightEdge = plot.x + plot.w;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, opt.height);
    ctx.direction = 'ltr';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // faixas de qualidade: fundo bem leve + régua colorida (à direita com as palavras, quando a
    // margem é dela; senão à esquerda, só a cor)
    const zones = [];
    let zoneTop = range.max;
    QUALITY_ZONES.forEach((zone, i) => {
      const lo = Math.max(range.min, zone.min);
      if (lo < zoneTop) {
        zones.push({ zone, color: colors.zones[i], y0: yOf(zoneTop), y1: yOf(lo) });
        zoneTop = lo;
      }
    });
    const stripX = wordWidth ? rightEdge + 3 : plot.x;
    for (const z of zones) {
      ctx.fillStyle = z.color;
      ctx.globalAlpha = 0.055;
      ctx.fillRect(plot.x, z.y0, plot.w, z.y1 - z.y0);
      ctx.globalAlpha = 0.9;
      ctx.fillRect(stripX, z.y0 + 0.5, 3, Math.max(0, z.y1 - z.y0 - 1));
    }
    if (wordWidth) {
      // uma palavra por faixa visível, na altura dela; faixas estreitas empurram as vizinhas
      const named = zones.filter((z) => z.y1 - z.y0 >= 5);
      const ys = spreadLabels(
        named.map((z) => ({ y: (z.y0 + z.y1) / 2 })),
        { top: plot.y + 6, bottom: bottom - 6, gap: 13 },
      );
      ctx.font = font(12, 500);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 1;
      named.forEach((z, i) => {
        ctx.fillStyle = z.color;
        ctx.fillText(z.zone.word, rightEdge + 11, ys[i] + 0.5);
      });
    }
    ctx.globalAlpha = 1;

    // linhas horizontais a cada 10 dB, com o valor
    ctx.font = font(12);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let v = range.max; v >= range.min; v -= 10) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(rightEdge, y);
      ctx.stroke();
      ctx.fillStyle = colors.label;
      ctx.fillText(`${MINUS}${Math.abs(v)}`, plot.x - 6, y);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = colors.label;
    ctx.fillText('dBm', 2, 11);

    // eixo do tempo
    ctx.strokeStyle = colors.axis;
    ctx.beginPath();
    ctx.moveTo(plot.x, bottom + 0.5);
    ctx.lineTo(rightEdge, bottom + 0.5);
    ctx.stroke();
    ctx.textBaseline = 'top';
    const ticks = timeTicks(opt.windowMs, plot.w);
    ticks.forEach((tick, i) => {
      const x = rightEdge - (tick.ageMs / opt.windowMs) * plot.w;
      ctx.strokeStyle = colors.axis;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, bottom);
      ctx.lineTo(Math.round(x) + 0.5, bottom + 4);
      ctx.stroke();
      let text = tick.label;
      if (i === 0 && pausedAt !== null) text = fmtClock(pausedAt);
      ctx.fillStyle = i === 0 ? colors.text : colors.label;
      ctx.font = font(12, i === 0 ? 600 : 400);
      // a primeira e a última marca não podem sair do gráfico
      const w = ctx.measureText(text).width;
      const left = Math.min(Math.max(plot.x - 4, x - w / 2), i === 0 ? rightEdge - w + (labelWidth ? 8 : 0) : rightEdge - w);
      ctx.textAlign = 'left';
      ctx.fillText(text, left, bottom + 7);
    });

    // séries: as apagadas primeiro, a principal por último
    const order = series.map((s, index) => ({ s, index })).sort((a, b) => rank(a.s) - rank(b.s));
    const ends = [];
    let any = false;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y - 4, plot.w * reveal + 5, plot.h + 8);
    ctx.clip();
    for (const { s, index } of order) {
      const gap = isNum(s.gapMs) ? s.gapMs : opt.gapMs;
      const segments = splitSegments(s.points, { from, to: to + 1000, gapMs: gap });
      if (!segments.length) continue;
      any = true;
      const color = colorOf(s, index);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = s.emphasis ? 2.5 : 1.6;
      ctx.globalAlpha = s.muted ? 0.55 : s.emphasis ? 1 : 0.92;
      for (const seg of segments) {
        if (seg.length === 1) {
          ctx.beginPath();
          ctx.arc(xOf(seg[0].t), yOf(seg[0].rssi), s.emphasis ? 2.4 : 2, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        ctx.beginPath();
        seg.forEach((p, i) => {
          const x = xOf(p.t);
          const y = yOf(p.rssi);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
      const lastSeg = segments[segments.length - 1];
      const last = lastSeg[lastSeg.length - 1];
      const current = to - last.t <= gap;
      ends.push({ s, color, x: Math.min(rightEdge, xOf(last.t)), y: yOf(last.rssi), current });
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // ponta de cada linha: bolinha (cheia se a rede segue sendo ouvida, vazada se sumiu)
    if (reveal >= 1) {
      for (const end of ends) {
        ctx.beginPath();
        ctx.arc(end.x, end.y, end.s.emphasis ? 3.6 : 3, 0, Math.PI * 2);
        ctx.fillStyle = end.current ? end.color : colors.surface;
        ctx.strokeStyle = end.color;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = end.s.muted ? 0.7 : 1;
        ctx.fill();
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // rótulos diretos, à direita
    if (labelWidth && reveal >= 1) {
      const labelled = ends.filter((e) => e.s.label);
      const ys = spreadLabels(labelled, { top: plot.y + 6, bottom: bottom - 6, gap: LABEL_GAP });
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      labelled.forEach((end, i) => {
        const y = ys[i];
        const x = rightEdge + 12;
        ctx.strokeStyle = end.color;
        ctx.globalAlpha = end.s.muted ? 0.4 : 0.55;
        ctx.lineWidth = 1;
        if (!end.current) ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(end.x + 4, end.y);
        ctx.lineTo(x - 4, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = end.s.muted ? 0.85 : 1;
        ctx.font = font(12, end.s.emphasis ? 700 : 500);
        ctx.fillStyle = end.s.muted ? colors.label : end.color;
        ctx.fillText(ellipsizeLabel(end.s.label, labelWidth, (t) => ctx.measureText(t).width), x, y + 0.5);
      });
      ctx.globalAlpha = 1;
    }

    if (!any) {
      ctx.font = font(13);
      ctx.fillStyle = colors.label;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ellipsize(opt.emptyText, plot.w - 24, (t) => ctx.measureText(t).width), plot.x + plot.w / 2, plot.y + plot.h / 2);
    }

    if (cursorX !== null && any) drawCursor(plot, from, order, xOf, yOf);
  }

  const rank = (s) => (s.muted ? 0 : s.emphasis ? 2 : 1);

  // Régua de leitura: o instante sob o dedo e o valor de cada série nele.
  function drawCursor(plot, from, order, xOf, yOf) {
    const x = Math.min(plot.x + plot.w, Math.max(plot.x, cursorX));
    const t = from + ((x - plot.x) / plot.w) * opt.windowMs;
    const rows = [];
    for (const { s, index } of order) {
      const gap = isNum(s.gapMs) ? s.gapMs : opt.gapMs;
      const v = valueAt(s.points, t, gap);
      if (v === null) continue;
      rows.push({ s, color: colorOf(s, index), v });
    }
    ctx.strokeStyle = colors.label;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, plot.y);
    ctx.lineTo(Math.round(x) + 0.5, plot.y + plot.h);
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (const row of rows) {
      ctx.beginPath();
      ctx.arc(x, yOf(row.v), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = row.color;
      ctx.strokeStyle = colors.surface;
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    }

    // caixinha com os valores (os mais fortes primeiro, no máximo 6)
    rows.sort((a, b) => b.v - a.v);
    const shown = rows.slice(0, 6);
    const age = Math.max(0, clock() - t);
    const title = age < 1500 && pausedAt === null ? 'agora' : `há ${age >= 60_000 ? `${Math.floor(age / 60_000)}${THIN}min ${Math.round((age % 60_000) / 1000)}${THIN}s` : `${Math.round(age / 1000)}${THIN}s`}`;
    const multi = series.length > 1;
    ctx.font = font(12, 600);
    const nameMax = Math.min(120, plot.w * 0.42);
    const lines = shown.map((row) => ({
      row,
      name: multi && row.s.label ? ellipsizeLabel(row.s.label, nameMax, (text) => ctx.measureText(text).width) : '',
      value: `${MINUS}${Math.abs(Math.round(row.v))}${THIN}dBm`,
    }));
    let boxW = ctx.measureText(title).width;
    for (const line of lines) boxW = Math.max(boxW, (line.name ? ctx.measureText(line.name).width + 22 : 0) + ctx.measureText(line.value).width);
    boxW = Math.ceil(boxW) + 20;
    const lineH = 17;
    const boxH = 12 + lineH * (lines.length + 1);
    let bx = x + 10;
    if (bx + boxW > plot.x + plot.w) bx = x - 10 - boxW;
    if (bx < plot.x) bx = plot.x;
    const by = plot.y + 2;
    ctx.fillStyle = colors.surface;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.96;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(bx + 0.5, by + 0.5, boxW, boxH, 8);
    else ctx.rect(bx + 0.5, by + 0.5, boxW, boxH);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = font(12);
    ctx.fillStyle = colors.label;
    ctx.fillText(title, bx + 10, by + 6 + lineH / 2);
    lines.forEach((line, i) => {
      const y = by + 6 + lineH * (i + 1) + lineH / 2;
      ctx.font = font(12, 600);
      if (line.name) {
        ctx.fillStyle = line.row.color;
        ctx.beginPath();
        ctx.arc(bx + 14, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(line.name, bx + 22, y + 0.5);
      }
      ctx.fillStyle = colors.text;
      ctx.textAlign = 'right';
      ctx.fillText(line.value, bx + boxW - 10, y + 0.5);
      ctx.textAlign = 'left';
    });
    if (!lines.length) {
      // nada foi ouvido naquele instante
      ctx.fillStyle = colors.label;
    }
  }

  function schedule() {
    if (destroyed || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      draw();
    });
  }

  function startReveal() {
    if (revealed) return;
    revealed = true;
    if (reduceMotion()) {
      reveal = 1;
      return;
    }
    reveal = 0;
    const t0 = performance.now();
    const step = (t) => {
      if (destroyed) return;
      const k = Math.min(1, (t - t0) / 420);
      reveal = 1 - Math.pow(1 - k, 3);
      draw();
      if (k < 1) requestAnimationFrame(step);
      else reveal = 1;
    };
    requestAnimationFrame(step);
  }

  function describe() {
    const to = clock();
    const parts = [];
    for (const s of series) {
      const last = s.points[s.points.length - 1];
      if (!last || to - last.t > opt.windowMs) continue;
      parts.push(`${s.label || 'sinal'}: ${MINUS}${Math.abs(Math.round(last.rssi))} dBm`);
      if (parts.length >= 5) break;
    }
    canvas.setAttribute('aria-label', parts.length ? `${opt.ariaLabel}. ${parts.join('; ')}.` : `${opt.ariaLabel}. ${opt.emptyText}.`);
  }

  function resize() {
    if (destroyed) return;
    const w = Math.floor(container.clientWidth);
    const ratio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
    if (!w) return;
    if (w !== width || ratio !== dpr) {
      width = w;
      dpr = ratio;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(opt.height * dpr);
    }
    draw();
  }

  // --- toque ---
  const moveCursor = (ev) => {
    const rect = canvas.getBoundingClientRect();
    cursorX = ev.clientX - rect.left;
    schedule();
  };
  const hideCursor = () => {
    if (cursorX === null) return;
    cursorX = null;
    schedule();
  };
  if (opt.interactive) {
    canvas.addEventListener('pointerdown', moveCursor);
    canvas.addEventListener('pointermove', (ev) => {
      if (ev.pointerType === 'mouse' || ev.buttons > 0 || ev.pressure > 0) moveCursor(ev);
    });
    canvas.addEventListener('pointerup', (ev) => ev.pointerType !== 'mouse' && hideCursor());
    canvas.addEventListener('pointercancel', hideCursor);
    canvas.addEventListener('pointerleave', hideCursor);
  }

  // --- observadores ---
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(container);
  const mo =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          colors = null;
          schedule();
        })
      : null;
  if (mo) mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (opt.live) {
    timer = setInterval(() => {
      if (document.hidden || pausedAt !== null) return;
      // a janela andou: valores podem ter saído dela
      computeRange();
      draw();
    }, 1000);
  }
  resize();

  return {
    el: canvas,
    /** @param {TimeSeries[]} list */
    setSeries(list) {
      series = (Array.isArray(list) ? list : [])
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({ ...s, points: (Array.isArray(s.points) ? s.points : []).filter((p) => p && isNum(p.t) && isNum(p.rssi)) }));
      computeRange();
      describe();
      if (!revealed && series.some((s) => s.points.length > 1)) startReveal();
      if (!width) resize();
      else draw();
    },
    setWindow(ms) {
      if (!isNum(ms) || ms <= 0) return;
      opt.windowMs = ms;
      computeRange();
      draw();
    },
    setGap(ms) {
      if (!isNum(ms) || ms <= 0) return;
      opt.gapMs = ms;
      draw();
    },
    /** Congela o gráfico no instante atual (true) ou volta a acompanhar o tempo (false). */
    setPaused(on) {
      pausedAt = on ? (pausedAt ?? opt.now()) : null;
      computeRange();
      draw();
    },
    resize,
    destroy() {
      destroyed = true;
      clearInterval(timer);
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
      canvas.remove();
    },
  };
}
