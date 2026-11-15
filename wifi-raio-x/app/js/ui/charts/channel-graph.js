// Gráfico de canais em canvas: cada rede é uma "montanha" com o formato da máscara espectral
// (core/channel-rating.js channelGraph()), da largura do canal dela e da altura do sinal.
//
//   const graph = createChannelGraph(caixa, { band: '2.4' });
//   graph.setData(channelGraph(aps, '2.4'), { ownBssids, highlight, staleBssids });
//   graph.on('select', (sel) => ...)     sel = { bssid, shape } ou null (toque fora de qualquer rede)
//   graph.on('activate', ({ bssid }) => ...)   Enter/espaço na rede em destaque (teclado)
//   graph.on('zoom', ({ zoom, max, canZoomIn, canZoomOut }) => ...)
//   graph.setBand('5')                   troca de faixa: zera o zoom e anima a próxima entrada de dados
//   graph.zoomIn() · zoomOut() · resetZoom() · getZoom() · setHighlight(bssid) · reveal(bssid)
//   graph.resize() · graph.destroy()
//   graph.inspect() · graph.locate(bssid)   para testes: o que está desenhado e onde tocar
//
// A caixa define o tamanho (largura e altura por CSS); o canvas a preenche. O gráfico cuida
// sozinho de: densidade de pixels da tela, redimensionamento (ResizeObserver), troca de tema
// (relê as cores dos tokens de css/app.css) e gestos (toque = escolher; pinça e Ctrl+rolagem =
// zoom; arrastar para os lados = andar pelo gráfico ampliado). A rolagem vertical da página
// continua funcionando por cima dele (touch-action: pan-y).
//
// Só a primeira entrada de dados de cada faixa é animada; as atualizações a cada varredura
// trocam o desenho sem animação. Toda a geometria vem de channel-graph-layout.js (testada).
//
// Nomes de rede são texto hostil: aqui só viram texto de canvas (fillText) e aria-label.

import { createFreqAxis, createDbmAxis, pickTickLabels, placeLabels, truncateText, hitTest, nextInCycle, zoomAt, maxZoomFor } from './channel-graph-layout.js';

const MINUS = String.fromCharCode(0x2212); // sinal de menos tipográfico
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
// caracteres de controle e separadores de linha (0x2028/0x2029) viram um ponto
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
const clean = (text) => String(text ?? '').replace(CONTROL, String.fromCharCode(0xb7));

const PAD = { left: 38, right: 10, top: 22, bottom: 26 };
const DFS_STRIP = 16; // altura extra embaixo quando a faixa tem canais DFS (5 GHz)
const LABEL_H = 18;
const LABEL_PAD = 5;
const FONT_PX = 12;
const TAP_SLOP = 10;
const FINGER = 14; // folga do dedo em volta de um contorno (px)
const ANIM_MS = 420;
const ZOOM_STEP = 1.6;

// canais que ganham número primeiro quando falta espaço no eixo
const ANCHORS_24 = new Set([1, 6, 11]);
const ANCHORS_5 = new Set([36, 52, 100, 116, 132, 149, 165]);

function readColors(el) {
  const cs = getComputedStyle(el);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    text: v('--text', '#e8eef9'),
    muted: v('--muted', '#93a0b8'),
    label: v('--chart-label', '#93a0b8'),
    grid: v('--chart-grid', 'rgba(147,160,184,0.16)'),
    axis: v('--chart-axis', '#4a5a78'),
    accent: v('--accent', '#38bdf8'),
    surface: v('--surface', '#121a2b'),
    warning: v('--warning', '#fbbf24'),
    font: v('--font', 'system-ui, sans-serif'),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Índices [de, até] dos pontos que formam o "corpo" de uma forma: o topo plano e os dois
 * ombros logo abaixo dele. O que fica fora disso são as saias da máscara.
 */
function bodyRange(points) {
  let peak = -Infinity;
  for (const pt of points) if (pt[1] > peak) peak = pt[1];
  let first = -1;
  let last = -1;
  for (let i = 0; i < points.length; i++) {
    if (points[i][1] >= peak - 0.05) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return [0, points.length - 1];
  return [Math.max(0, first - 1), Math.min(points.length - 1, last + 1)];
}

const EMPTY_DATA = Object.freeze({ band: null, minFreq: 0, maxFreq: 0, minDbm: -100, maxDbm: -30, sections: [], ticks: [], shapes: [] });

/**
 * @param {HTMLElement} container  caixa com tamanho definido por CSS
 * @param {{band?: '2.4'|'5'|'6', animate?: boolean}} [options]
 */
export function createChannelGraph(container, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'chgraph__canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.style.touchAction = 'pan-y';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const listeners = new Map();
  let colors = readColors(container);
  let data = EMPTY_DATA;
  let band = options.band ?? null;
  let own = new Set();
  let stale = new Set();
  let highlight = null;
  let zoom = 1;
  let scroll = 0;
  let size = { w: 0, h: 0, dpr: 1 };
  let frame = 0;
  let destroyed = false;
  let animateNext = options.animate !== false;
  let anim = null; // {t0}
  let drawn = { labels: [], ticks: [], plot: null, axis: null, yAxis: null };

  // --- eventos para fora -------------------------------------------------------------------

  function emit(name, payload) {
    for (const fn of [...(listeners.get(name) || [])]) fn(payload);
  }

  function on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name)?.delete(fn);
  }

  // --- geometria ---------------------------------------------------------------------------

  const hasDfs = () => data.ticks.some((t) => t.dfs);

  function plotRect() {
    const bottomPad = PAD.bottom + (hasDfs() ? DFS_STRIP : 0);
    const left = PAD.left;
    const right = Math.max(left + 10, size.w - PAD.right);
    const top = PAD.top;
    const bottom = Math.max(top + 10, size.h - bottomPad);
    return { left, right, top, bottom, width: right - left, height: bottom - top };
  }

  const view = (plot = plotRect()) => ({ sections: data.sections, width: plot.width, zoom, scroll });

  function maxZoom() {
    const base = createFreqAxis({ sections: data.sections, width: plotRect().width });
    return maxZoomFor(data.band ?? band, base.pxPerMHz);
  }

  function zoomInfo() {
    const max = maxZoom();
    return { zoom, max, canZoomIn: data.sections.length > 0 && zoom < max - 1e-6, canZoomOut: zoom > 1 + 1e-6 };
  }

  let zoomSig = '';
  /** Avisa quem escuta 'zoom', mas só quando algo mudou (o zoom ou o que os botões podem fazer). */
  function announceZoom() {
    const info = zoomInfo();
    const sig = `${info.zoom.toFixed(3)}|${info.max}|${info.canZoomIn}|${info.canZoomOut}`;
    if (sig === zoomSig) return;
    zoomSig = sig;
    emit('zoom', info);
  }

  function setZoom(next, anchorX) {
    const plot = plotRect();
    const target = clamp(next, 1, maxZoom());
    const result = zoomAt(view(plot), Math.abs(target - 1) < 0.02 ? 1 : target, anchorX);
    if (result.zoom === zoom && result.scroll === scroll) return;
    zoom = result.zoom;
    scroll = result.scroll;
    schedule();
    announceZoom();
  }

  // --- desenho -----------------------------------------------------------------------------

  function schedule() {
    if (destroyed || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function font(weight = 400, italic = false) {
    return `${italic ? 'italic ' : ''}${weight} ${FONT_PX}px ${colors.font}`;
  }

  function measureWith(fontText) {
    ctx.font = fontText;
    return (text) => ctx.measureText(text).width;
  }

  function tickPriority(used) {
    const b = data.band;
    return (tick) => {
      const u = used.get(tick.channel);
      if (u) return u.own ? 400 : u.highlight ? 350 : 200 + clamp(u.rssi + 100, 0, 99);
      if (b === '2.4') return ANCHORS_24.has(tick.channel) ? 120 : 20;
      if (b === '5') return ANCHORS_5.has(tick.channel) ? 120 : (tick.channel - 36) % 8 === 0 || (tick.channel - 100) % 8 === 0 || (tick.channel - 149) % 8 === 0 ? 60 : 20;
      if (b === '6') return tick.psc ? ((tick.channel - 5) % 32 === 0 ? 120 : 80) : 20;
      return 20;
    };
  }

  function draw() {
    if (destroyed || size.w <= 0 || size.h <= 0) return;
    let progress = 1;
    if (anim) {
      const t = (performance.now() - anim.t0) / ANIM_MS;
      if (t >= 1) anim = null;
      else progress = 1 - Math.pow(1 - clamp(t, 0, 1), 3);
    }

    const plot = plotRect();
    const axis = createFreqAxis(view(plot));
    scroll = axis.scroll;
    const yAxis = createDbmAxis({ minDbm: data.minDbm, maxDbm: data.maxDbm, top: plot.top, bottom: plot.bottom, minLabelGap: 40 });
    const yOf = (dbm) => plot.bottom - (plot.bottom - yAxis.y(dbm)) * progress;

    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // segmentos visíveis, já recortados pela área do gráfico
    const panels = axis.segments
      .map((seg) => ({ seg, x0: Math.max(plot.left, plot.left + seg.x0), x1: Math.min(plot.right, plot.left + seg.x1) }))
      .filter((p) => p.x1 > p.x0);

    // grade e números do eixo do sinal
    ctx.font = font(400);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    for (const tick of yAxis.ticks) {
      if (!tick.label) continue;
      const y = Math.round(tick.y) + 0.5;
      ctx.strokeStyle = colors.grid;
      for (const p of panels) {
        ctx.beginPath();
        ctx.moveTo(p.x0, y);
        ctx.lineTo(p.x1, y);
        ctx.stroke();
      }
      ctx.fillStyle = colors.label;
      ctx.fillText(`${MINUS}${Math.abs(tick.dbm)}`, plot.left - 7, tick.y);
    }
    ctx.fillStyle = colors.label;
    ctx.fillText('dBm', plot.left - 7, 9);

    // quem usa cada canal (para os números do eixo e para os nomes)
    const used = new Map();
    for (const shape of data.shapes) {
      if (!isNum(shape.channel)) continue;
      const u = used.get(shape.channel) || { rssi: -Infinity, own: false, highlight: false };
      u.rssi = Math.max(u.rssi, shape.rssi);
      u.own = u.own || own.has(shape.bssid);
      u.highlight = u.highlight || shape.bssid === highlight;
      used.set(shape.channel, u);
    }

    // montanhas: vizinhos (do mais fraco ao mais forte), depois as redes do usuário, depois o destaque
    const rankOf = (s) => (s.bssid === highlight ? 2 : own.has(s.bssid) ? 1 : 0);
    // com dezenas de redes os preenchimentos se somam: cada um fica mais leve para o fundo não virar um bloco
    const density = clamp(Math.sqrt(16 / Math.max(16, data.shapes.length)), 0.5, 1);
    const order = data.shapes.map((shape, i) => ({ shape, i })).sort((a, b) => rankOf(a.shape) - rankOf(b.shape) || a.i - b.i);
    for (const p of panels) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x0, 0, p.x1 - p.x0, plot.bottom);
      ctx.clip();
      for (const { shape } of order) {
        const pts = shape.points;
        if (!pts || pts.length < 2) continue;
        if (pts[pts.length - 1][0] < p.seg.minFreq - 1 || pts[0][0] > p.seg.maxFreq + 1) continue;
        const px = pts.map((pt) => [plot.left + axis.xIn(p.seg, pt[0]), yOf(pt[1])]);
        const trace = (from, to) => {
          ctx.beginPath();
          for (let i = from; i <= to; i++) {
            if (i === from) ctx.moveTo(px[i][0], px[i][1]);
            else ctx.lineTo(px[i][0], px[i][1]);
          }
        };
        const isOwn = own.has(shape.bssid);
        const isHl = shape.bssid === highlight;
        const strength = clamp((shape.rssi + 95) / 50, 0, 1);
        const dim = highlight && !isHl ? 0.7 : 1;
        let stroke = colors.muted;
        let strokeAlpha = (0.42 + 0.4 * strength) * dim;
        let fillAlpha = (0.05 + 0.08 * strength) * dim * density;
        let width = 1.25;
        if (isOwn) {
          stroke = colors.accent;
          strokeAlpha = 1;
          fillAlpha = isHl ? 0.3 : 0.18;
          width = isHl ? 2.5 : 2;
        } else if (isHl) {
          stroke = colors.text;
          strokeAlpha = 1;
          fillAlpha = 0.14;
          width = 2;
        }
        trace(0, px.length - 1);
        ctx.globalAlpha = fillAlpha;
        ctx.fillStyle = stroke;
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.setLineDash(stale.has(shape.bssid) ? [4, 4] : []);
        // o "corpo" do canal (o topo e os ombros da máscara) leva o traço forte; as saias, que
        // são o que vaza para os canais vizinhos, ficam finas para não riscar o gráfico inteiro
        const [a, b] = bodyRange(pts);
        if (b > a) {
          ctx.globalAlpha = strokeAlpha * 0.45;
          ctx.lineWidth = 1;
          if (a > 0) {
            trace(0, a);
            ctx.stroke();
          }
          if (b < px.length - 1) {
            trace(b, px.length - 1);
            ctx.stroke();
          }
          trace(a, b);
        }
        ctx.globalAlpha = strokeAlpha;
        ctx.lineWidth = width;
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // eixo dos canais: linha de base por trecho, marcas e a interrupção entre os trechos
    ctx.strokeStyle = colors.axis;
    ctx.lineWidth = 1;
    const baseY = Math.round(plot.bottom) + 0.5;
    for (const p of panels) {
      ctx.beginPath();
      ctx.moveTo(p.x0, baseY);
      ctx.lineTo(p.x1, baseY);
      ctx.stroke();
    }
    for (const br of axis.breaks) {
      const x = plot.left + br.x;
      if (x < plot.left + 4 || x > plot.right - 4) continue;
      ctx.beginPath();
      for (const dx of [-3, 2]) {
        ctx.moveTo(x + dx - 2, baseY + 5);
        ctx.lineTo(x + dx + 3, baseY - 5);
      }
      ctx.stroke();
    }
    const tickX = (tick) => {
      const seg = axis.segmentOf(tick.freq);
      return seg ? plot.left + axis.xIn(seg, tick.freq) : NaN;
    };
    ctx.beginPath();
    for (const tick of data.ticks) {
      const x = tickX(tick);
      if (!isNum(x) || x < plot.left - 0.5 || x > plot.right + 0.5) continue;
      ctx.moveTo(Math.round(x) + 0.5, baseY);
      ctx.lineTo(Math.round(x) + 0.5, baseY + 4);
    }
    ctx.stroke();

    const labelsX = pickTickLabels(data.ticks, {
      x: tickX,
      measure: measureWith(font(600)),
      priority: tickPriority(used),
      // em 2,4 GHz os números são seguidos (1 a 13) e podem ficar juntinhos; nas outras faixas
      // pulam, e "1 9" colado viraria "19"
      minGap: data.band === '2.4' ? 3 : 7,
      left: plot.left - 4,
      right: size.w - 1,
    });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const item of labelsX) {
      const u = used.get(item.tick.channel);
      const strong = !!u && (u.own || u.highlight);
      ctx.font = font(strong ? 600 : 400);
      ctx.fillStyle = strong ? colors.text : u ? colors.muted : colors.label;
      ctx.globalAlpha = u ? 1 : 0.8;
      ctx.fillText(item.text, item.x, plot.bottom + 14);
    }
    ctx.globalAlpha = 1;
    ctx.font = font(400);
    ctx.textAlign = 'right';
    ctx.fillStyle = colors.label;
    ctx.fillText('canal', plot.left - 7, plot.bottom + 14);

    // faixa DFS (5 GHz): um traço sob os canais divididos com radares
    if (hasDfs()) {
      const runs = [];
      for (const tick of data.ticks) {
        if (!tick.dfs) continue;
        const last = runs[runs.length - 1];
        if (last && tick.freq - last.hi <= 20 && axis.segmentOf(tick.freq) === last.seg) last.hi = tick.freq;
        else runs.push({ lo: tick.freq, hi: tick.freq, seg: axis.segmentOf(tick.freq) });
      }
      const y = plot.bottom + 27;
      ctx.textAlign = 'center';
      for (const run of runs) {
        if (!run.seg) continue;
        const x0 = Math.max(plot.left, plot.left + axis.xIn(run.seg, run.lo - 10));
        const x1 = Math.min(plot.right, plot.left + axis.xIn(run.seg, run.hi + 10));
        if (x1 - x0 < 6) continue;
        const text = 'DFS';
        const tw = x1 - x0 >= 44 ? ctx.measureText(text).width + 10 : 0;
        const mid = (x0 + x1) / 2;
        ctx.strokeStyle = colors.warning;
        ctx.globalAlpha = 0.75;
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (tw) {
          ctx.moveTo(x0 + 1, y);
          ctx.lineTo(mid - tw / 2, y);
          ctx.moveTo(mid + tw / 2, y);
          ctx.lineTo(x1 - 1, y);
        } else {
          ctx.moveTo(x0 + 1, y);
          ctx.lineTo(x1 - 1, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (tw) {
          ctx.fillStyle = colors.label;
          ctx.fillText(text, mid, y + 0.5);
        }
      }
    }

    // nomes das redes mais fortes, sem sobreposição
    const seen = new Set();
    const candidates = [];
    const maxLabelW = Math.min(150, plot.width * 0.5);
    for (const shape of [...data.shapes].sort((a, b) => b.rssi - a.rssi)) {
      if (seen.has(shape.bssid)) continue;
      seen.add(shape.bssid);
      const seg = axis.segmentOf(shape.centerFreq);
      if (!seg) continue;
      const cx = plot.left + axis.xIn(seg, shape.centerFreq);
      if (cx < plot.left + 4 || cx > plot.right - 4) continue;
      const isOwn = own.has(shape.bssid);
      const isHl = shape.bssid === highlight;
      const fontText = font(isOwn || isHl ? 600 : 400, shape.hidden);
      const text = truncateText(clean(shape.ssid), maxLabelW - 2 * LABEL_PAD, measureWith(fontText));
      if (!text) continue;
      candidates.push({
        id: shape.bssid,
        cx,
        top: yOf(shape.rssi),
        w: Math.ceil(ctx.measureText(text).width) + 2 * LABEL_PAD,
        h: LABEL_H,
        priority: (isHl ? 2000 : 0) + (isOwn ? 1000 : 0) + (shape.hidden ? -40 : 0) + shape.rssi,
        text,
        fontText,
        isOwn,
        isHl,
        hidden: shape.hidden,
      });
    }
    // o mesmo nome no mesmo lugar (dois rádios da mesma rede) aparece uma vez só
    const unique = [];
    for (const c of candidates.sort((a, b) => b.priority - a.priority)) {
      if (!unique.some((u) => u.text === c.text && Math.abs(u.cx - c.cx) < 48 && !c.isHl)) unique.push(c);
    }
    const byId = new Map(unique.map((c) => [c.id, c]));
    const maxLabels = Math.max(4, Math.round(plot.width / 42));
    const placed = placeLabels(unique, { left: plot.left + 2, right: size.w - 2, top: 2, bottom: plot.bottom - 2 }, { gap: 3, lift: 5, levels: 2, max: maxLabels });
    const labelRects = [];
    // primeiro os fios que ligam um nome "de cima" ao seu pico, depois as caixas por cima deles
    ctx.strokeStyle = colors.label;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    for (const box of placed) {
      if (box.level === 0) continue;
      const c = byId.get(box.id);
      // o fio desce da caixa até o pico, pulando as outras caixas que estiverem no caminho
      const covers = placed.filter((o) => o !== box && c.cx >= o.x && c.cx <= o.x + o.w).sort((a, b) => a.y - b.y);
      let y = box.y + box.h;
      const end = c.top - 2;
      ctx.beginPath();
      for (const o of covers) {
        if (o.y + o.h <= y || o.y >= end) continue;
        if (o.y - 1 > y) {
          ctx.moveTo(c.cx, y);
          ctx.lineTo(c.cx, o.y - 1);
        }
        y = Math.max(y, o.y + o.h + 1);
      }
      if (end > y) {
        ctx.moveTo(c.cx, y);
        ctx.lineTo(c.cx, end);
      }
      ctx.stroke();
    }
    for (const box of placed) {
      const c = byId.get(box.id);
      ctx.globalAlpha = c.isHl ? 0.96 : 0.82;
      ctx.fillStyle = colors.surface;
      roundRect(ctx, box.x, box.y, box.w, box.h, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (c.isHl) {
        ctx.strokeStyle = c.isOwn ? colors.accent : colors.text;
        ctx.lineWidth = 1;
        roundRect(ctx, box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1, 6);
        ctx.stroke();
      }
      ctx.font = c.fontText;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = c.isOwn || c.isHl ? colors.text : colors.label;
      ctx.fillText(c.text, box.x + LABEL_PAD, box.y + box.h / 2 + 0.5);
      labelRects.push({ bssid: c.id, text: c.text, x: box.x, y: box.y, w: box.w, h: box.h });
    }

    // ponto no pico da rede em destaque
    if (highlight) {
      const shape = data.shapes.find((s) => s.bssid === highlight);
      const seg = shape ? axis.segmentOf(shape.centerFreq) : null;
      if (seg) {
        const cx = plot.left + axis.xIn(seg, shape.centerFreq);
        if (cx >= plot.left && cx <= plot.right) {
          ctx.fillStyle = colors.surface;
          ctx.beginPath();
          ctx.arc(cx, yOf(shape.rssi), 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = own.has(highlight) ? colors.accent : colors.text;
          ctx.beginPath();
          ctx.arc(cx, yOf(shape.rssi), 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // sem redes: o eixo fica, com uma frase no meio
    if (!data.shapes.length && data.sections.length) {
      ctx.font = font(400);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.label;
      ctx.fillText('Nenhuma rede nesta faixa agora', (plot.left + plot.right) / 2, (plot.top + plot.bottom) / 2);
    }

    // com zoom: uma barrinha mostra que parte da faixa está à vista
    if (zoom > 1 && axis.contentWidth > 0) {
      const y = size.h - 3;
      ctx.lineWidth = 3;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.right, y);
      ctx.stroke();
      ctx.strokeStyle = colors.muted;
      ctx.beginPath();
      ctx.moveTo(plot.left + (axis.scroll / axis.contentWidth) * plot.width, y);
      ctx.lineTo(plot.left + ((axis.scroll + plot.width) / axis.contentWidth) * plot.width, y);
      ctx.stroke();
    }

    drawn = { labels: labelRects, ticks: labelsX.map((l) => l.tick.channel), plot, axis, yAxis };
    if (anim) schedule();
  }

  // --- tamanho e tema ----------------------------------------------------------------------

  function resize() {
    if (destroyed) return;
    const w = Math.floor(container.clientWidth);
    const h = Math.floor(container.clientHeight);
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    if (zoom > maxZoom()) zoom = maxZoom();
    // desenha já: um canvas redimensionado fica em branco até o próximo quadro
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    draw();
    announceZoom();
  }

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  if (resizeObserver) resizeObserver.observe(container);
  const onWindowResize = () => resize();
  window.addEventListener('resize', onWindowResize);

  const themeObserver =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          colors = readColors(container);
          schedule();
        })
      : null;
  if (themeObserver) themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });

  // --- gestos ------------------------------------------------------------------------------

  const pointers = new Map();
  let gesture = null; // {kind: 'tap'|'pan'|'pinch', ...}

  const localPoint = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  function pick(point) {
    const { plot, axis, yAxis, labels } = drawn;
    if (!plot || !axis) return [];
    const onLabel = labels.find((l) => point.x >= l.x - 4 && point.x <= l.x + l.w + 4 && point.y >= l.y - 4 && point.y <= l.y + l.h + 4);
    if (onLabel) {
      const shape = data.shapes.find((s) => s.bssid === onLabel.bssid);
      if (shape) return [shape];
    }
    if (point.y > plot.bottom + 6 || point.x < plot.left - 2 || point.x > plot.right + 2) return [];
    const px = point.x - plot.left;
    const seg = axis.segmentAt(clamp(px, 0, plot.width));
    if (!seg || axis.pxPerMHz <= 0) return [];
    const freq = seg.minFreq + (px - seg.x0) / axis.pxPerMHz;
    const dbm = yAxis.dbm(Math.min(point.y, plot.bottom - 1));
    return hitTest(data.shapes, { freq, dbm }, { freq: FINGER / axis.pxPerMHz, dbm: FINGER / yAxis.pxPerDb });
  }

  function select(bssid, { silent = false } = {}) {
    const next = bssid || null;
    const changed = next !== highlight;
    highlight = next;
    if (changed) schedule();
    if (!silent) {
      const shape = next ? data.shapes.find((s) => s.bssid === next) || null : null;
      emit('select', next ? { bssid: next, shape } : null);
    }
  }

  function onPointerDown(ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const p = localPoint(ev);
    pointers.set(ev.pointerId, { ...p, x0: p.x, y0: p.y, t0: performance.now() });
    if (pointers.size === 1) gesture = { kind: 'tap', id: ev.pointerId };
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom };
    }
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      // ponteiro sintético (testes): segue sem captura
    }
  }

  function onPointerMove(ev) {
    const p = pointers.get(ev.pointerId);
    if (!p || !gesture) return;
    const now = localPoint(ev);
    const dx = now.x - p.x;
    p.x = now.x;
    p.y = now.y;
    if (gesture.kind === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      setZoom(gesture.zoom * (dist / gesture.dist), (a.x + b.x) / 2 - plotRect().left);
      return;
    }
    if (gesture.kind === 'tap' && Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_SLOP) {
      gesture = zoom > 1 && Math.abs(p.x - p.x0) > Math.abs(p.y - p.y0) ? { kind: 'pan' } : { kind: 'none' };
    }
    if (gesture.kind === 'pan') {
      const axis = createFreqAxis({ ...view(), scroll: scroll - dx });
      if (axis.scroll !== scroll) {
        scroll = axis.scroll;
        schedule();
      }
    }
  }

  function onPointerUp(ev) {
    const p = pointers.get(ev.pointerId);
    pointers.delete(ev.pointerId);
    if (!p || !gesture) return;
    const wasTap = gesture.kind === 'tap' && gesture.id === ev.pointerId && performance.now() - p.t0 < 800;
    if (pointers.size === 0) gesture = null;
    else if (gesture.kind === 'pinch') gesture = { kind: 'none' };
    if (!wasTap) return;
    const next = nextInCycle(pick(p), highlight);
    select(next ? next.bssid : null);
  }

  function onPointerCancel(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size === 0) gesture = null;
  }

  function onWheel(ev) {
    // só o gesto de pinça do trackpad (Ctrl + rolagem): a rolagem comum é da página
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    setZoom(zoom * Math.exp(-ev.deltaY / 200), localPoint(ev).x - plotRect().left);
  }

  function onKeyDown(ev) {
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      const ids = [];
      for (const s of [...data.shapes].sort((a, b) => a.centerFreq - b.centerFreq || b.rssi - a.rssi)) if (!ids.includes(s.bssid)) ids.push(s.bssid);
      if (!ids.length) return;
      ev.preventDefault();
      const at = ids.indexOf(highlight);
      const step = ev.key === 'ArrowRight' ? 1 : -1;
      const next = at < 0 ? (step > 0 ? 0 : ids.length - 1) : (at + step + ids.length) % ids.length;
      select(ids[next]);
      reveal(ids[next]);
    } else if ((ev.key === 'Enter' || ev.key === ' ') && highlight) {
      ev.preventDefault();
      emit('activate', { bssid: highlight });
    } else if (ev.key === 'Escape' && highlight) {
      ev.stopPropagation();
      select(null);
    } else if (ev.key === '+' || ev.key === '=') {
      setZoom(zoom * ZOOM_STEP);
    } else if (ev.key === '-') {
      setZoom(zoom / ZOOM_STEP);
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKeyDown);

  // --- API ---------------------------------------------------------------------------------

  /** Rola o gráfico ampliado até a rede ficar à vista. */
  function reveal(bssid) {
    if (zoom <= 1) return;
    const shape = data.shapes.find((s) => s.bssid === bssid);
    if (!shape) return;
    const plot = plotRect();
    const axis = createFreqAxis(view(plot));
    const x = axis.x(shape.centerFreq);
    if (x >= 24 && x <= plot.width - 24) return;
    const next = createFreqAxis({ ...view(plot), scroll: axis.scroll + x - plot.width / 2 });
    scroll = next.scroll;
    schedule();
  }

  function describe() {
    const names = new Set(data.shapes.map((s) => s.bssid));
    const count = names.size;
    const bandText = data.band ? `${String(data.band).replace('.', ',')} GHz` : '';
    if (!count) return `Gráfico de canais${bandText ? ` de ${bandText}` : ''}: nenhuma rede nesta faixa agora.`;
    const top = data.shapes[data.shapes.length - 1];
    const strongest = top ? ` A mais forte é ${clean(top.ssid)}, no canal ${top.channel}, com ${MINUS}${Math.abs(Math.round(top.rssi))} dBm.` : '';
    return `Gráfico de canais de ${bandText}: ${count} ${count === 1 ? 'rede' : 'redes'}.${strongest} Use as setas para percorrer as redes.`;
  }

  function setData(graphData, extra = {}) {
    if (destroyed) return;
    const next = graphData && Array.isArray(graphData.shapes) ? graphData : EMPTY_DATA;
    const hadShapes = data.shapes.length > 0;
    data = next;
    if (next.band) band = next.band;
    if (extra.ownBssids !== undefined) own = new Set(extra.ownBssids || []);
    if (extra.staleBssids !== undefined) stale = new Set(extra.staleBssids || []);
    if (extra.highlight !== undefined) {
      const wanted = extra.highlight || null;
      const changed = wanted !== highlight;
      highlight = wanted;
      if (changed && wanted) reveal(wanted);
    }
    if (zoom > 1) {
      const max = maxZoom();
      if (zoom > max) zoom = max;
    }
    // só a primeira leva de dados de cada faixa cresce do chão; as seguintes trocam direto
    if (animateNext && next.shapes.length && !hadShapes) {
      animateNext = false;
      anim = reduced ? null : { t0: performance.now() };
    } else if (next.shapes.length) {
      animateNext = false;
    }
    canvas.setAttribute('aria-label', describe());
    schedule();
    announceZoom();
  }

  function setBand(nextBand) {
    if (destroyed || nextBand === band) return;
    band = nextBand;
    data = EMPTY_DATA;
    zoom = 1;
    scroll = 0;
    highlight = null;
    animateNext = true;
    anim = null;
    schedule();
    announceZoom();
  }

  function locate(bssid) {
    const shape = data.shapes.find((s) => s.bssid === bssid);
    const { plot, axis, yAxis } = drawn;
    if (!shape || !plot || !axis) return null;
    const seg = axis.segmentOf(shape.centerFreq);
    if (!seg) return null;
    const x = plot.left + axis.xIn(seg, shape.centerFreq);
    if (x < plot.left || x > plot.right) return null;
    // um pouco abaixo do pico: dentro da forma, longe do nome que fica em cima
    return { x, y: Math.min(plot.bottom - 2, yAxis.y(shape.rssi) + 6) };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (resizeObserver) resizeObserver.disconnect();
    if (themeObserver) themeObserver.disconnect();
    window.removeEventListener('resize', onWindowResize);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('keydown', onKeyDown);
    listeners.clear();
    pointers.clear();
    canvas.remove();
  }

  resize();

  return {
    el: canvas,
    setData,
    setBand,
    setHighlight: (bssid) => select(bssid, { silent: true }),
    reveal,
    resize,
    destroy,
    on,
    zoomIn: () => setZoom(zoom * ZOOM_STEP),
    zoomOut: () => setZoom(zoom / ZOOM_STEP),
    resetZoom: () => setZoom(1),
    getZoom: zoomInfo,
    locate,
    /** Retrato do que está desenhado (para testes e depuração). */
    inspect: () => ({
      band: data.band ?? band,
      zoom,
      scroll,
      highlight,
      shapes: data.shapes.length,
      own: [...own],
      labels: drawn.labels.map((l) => ({ ...l })),
      ticks: drawn.ticks.slice(),
      breaks: drawn.axis ? drawn.axis.breaks.length : 0,
      segments: drawn.axis ? drawn.axis.segments.length : 0,
      animating: !!anim,
      size: { ...size },
      plot: drawn.plot ? { ...drawn.plot } : null,
    }),
  };
}
