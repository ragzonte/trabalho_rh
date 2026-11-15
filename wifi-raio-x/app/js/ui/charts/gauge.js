// Medidor semicircular ("velocímetro") em canvas, reutilizável: sinal, velocidade, o que for.
//
//   const gauge = createGauge(container, {
//     min: -100, max: -30,
//     zones: [{ from: -100, to: -82, color: '--sig-5' }, { from: -82, to: -30, color: '--sig-1' }],
//     format: (v) => fmtDbm(v, { unit: false }),     // texto do número grande no centro
//     unit: 'dBm',                                    // ao lado do número
//     label: 'Bom',                                   // linha de baixo (palavra, fase do teste...)
//   });
//   gauge.set(-57, { peak: -49 });   // valor atual; `peak` = marca de pico (null apaga, ausente mantém)
//   gauge.set(null);                  // sem leitura: arco vazio e "—" no centro
//   gauge.setRange(0, 200);           // muda a escala (as zonas continuam nos mesmos valores)
//   gauge.resize();                   // refaz as medidas (já é chamado sozinho quando o contêiner muda)
//   gauge.destroy();                  // para a animação, os observadores e tira os elementos
//
// Opções além das da assinatura básica (todas opcionais):
//   ariaLabel    nome para leitores de tela (padrão: "Medidor")
//   formatTick   texto dos dois extremos da escala (padrão: o mesmo `format`); ends: false esconde
//   maxWidth     largura máxima em px (padrão 340)
// Extras do objeto devolvido: el · setLabel(texto) · setUnit(texto) · setZones(lista) ·
//   set(valor, { label }) troca a linha de baixo junto com o valor.
//
// Cores: cada zona aceita um token do tema ('--sig-1'), 'var(--sig-1)' ou uma cor CSS qualquer.
// Tudo é lido de novo quando o tema muda (atributo data-theme de <html>). O canvas respeita a
// densidade da tela (devicePixelRatio) e se redesenha quando o contêiner muda de largura.
// O arco desliza até o valor novo (some com prefers-reduced-motion); o número troca na hora.
// Para leitores de tela o conjunto é um role="meter" com o texto do valor.
//
// O estilo dos textos vai junto com o módulo (um <style> estático, uma vez por página), para
// o medidor funcionar em qualquer tela sem depender da folha de estilo de quem o usa.

import { h, cssVar } from '../dom.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

const STYLE_ID = 'wrx-gauge-style';
const STYLE = `
.gauge{position:relative;width:100%;margin-inline:auto;--gauge-color:var(--accent-text)}
.gauge__canvas{display:block;width:100%}
.gauge__readout{position:absolute;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;max-width:100%;text-align:center;pointer-events:none}
.gauge__value{display:flex;align-items:baseline;justify-content:center;gap:5px;color:var(--text);font-weight:600;line-height:1;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;white-space:nowrap}
.gauge__unit{font-size:16px;font-weight:500;letter-spacing:0;color:var(--muted)}
.gauge__label{min-height:22px;margin-top:6px;font-size:16px;font-weight:600;line-height:22px;color:var(--gauge-color);white-space:nowrap}
.gauge__label:empty{display:none}
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE; // texto fixo, sem dado nenhum
  document.head.appendChild(style);
}

/** '--sig-1' ou 'var(--sig-1)' -> nome do token; qualquer outra coisa -> null (é uma cor pronta). */
function tokenOf(color) {
  if (typeof color !== 'string') return null;
  const text = color.trim();
  if (text.startsWith('--')) return text;
  const m = /^var\(\s*(--[\w-]+)/.exec(text);
  return m ? m[1] : null;
}

function normalizeZones(zones) {
  if (!Array.isArray(zones)) return [];
  const out = [];
  for (const z of zones) {
    if (!z || typeof z !== 'object') continue;
    const from = Number(z.from);
    const to = Number(z.to);
    if (Number.isNaN(from) || Number.isNaN(to) || from === to) continue;
    out.push({ from: Math.min(from, to), to: Math.max(from, to), color: typeof z.color === 'string' ? z.color : '' });
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * @param {HTMLElement} container  onde o medidor é montado (ocupa a largura dele, até maxWidth)
 * @param {object} [options]
 * @param {number} [options.min=0]
 * @param {number} [options.max=100]
 * @param {{from:number, to:number, color:string}[]} [options.zones]  faixas coloridas da escala
 * @param {(value:number) => string} [options.format]  número do centro (padrão: inteiro)
 * @param {string} [options.unit]
 * @param {string} [options.label]
 * @param {string} [options.ariaLabel]
 * @param {(value:number) => string} [options.formatTick]
 * @param {boolean} [options.ends=true]   mostra o mínimo e o máximo nas pontas do arco
 * @param {number} [options.maxWidth=340]
 * @returns {{el:HTMLElement, set:(value:number|null, options?:{peak?:number|null, animate?:boolean, label?:string}) => void,
 *            setRange:(min:number, max:number) => void, setZones:(zones:object[]) => void,
 *            setLabel:(text:string) => void, setUnit:(text:string) => void,
 *            resize:() => void, destroy:() => void}}
 */
export function createGauge(container, options = {}) {
  ensureStyle();

  let min = isNum(options.min) ? options.min : 0;
  let max = isNum(options.max) ? options.max : 100;
  let zones = normalizeZones(options.zones);
  const format = typeof options.format === 'function' ? options.format : (v) => String(Math.round(v));
  const formatTick = typeof options.formatTick === 'function' ? options.formatTick : format;
  const showEnds = options.ends !== false;
  const maxWidth = isNum(options.maxWidth) && options.maxWidth > 0 ? options.maxWidth : 340;

  let target = null; // valor pedido
  let shown = null; // valor desenhado (corre atrás de `target`)
  let peak = null;
  let label = options.label == null ? '' : String(options.label);
  let unit = options.unit == null ? '' : String(options.unit);
  let raf = 0;
  let lastFrame = 0;
  let geo = null; // medidas do desenho atual
  let theme = null;
  let dead = false;
  let fitKey = '';

  const canvas = h('canvas.gauge__canvas', { 'aria-hidden': 'true' });
  const valueText = h('span.gauge__number');
  const unitEl = h('span.gauge__unit', null, unit);
  const valueEl = h('span.gauge__value', null, valueText, unitEl);
  const labelEl = h('span.gauge__label', null, label);
  const readout = h('div.gauge__readout', null, valueEl, labelEl);
  const root = h('div.gauge', { role: 'meter', 'aria-label': options.ariaLabel || 'Medidor' }, canvas, readout);
  root.style.maxWidth = `${maxWidth}px`;
  container.appendChild(root);
  const ctx = canvas.getContext('2d');

  const reduceMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  // --- cores ---------------------------------------------------------------------------------

  function readTheme() {
    const pick = (name, fallback) => cssVar(name) || fallback;
    theme = {
      track: pick('--surface-2', '#1a2438'),
      line: pick('--line', '#26324a'),
      surface: pick('--surface', '#121a2b'),
      text: pick('--text', '#e8eef9'),
      label: pick('--chart-label', '#93a0b8'),
      accent: pick('--accent', '#38bdf8'),
      zones: zones.map((z) => {
        const token = tokenOf(z.color);
        return (token ? cssVar(token) : z.color) || pick('--accent', '#38bdf8');
      }),
      font: getComputedStyle(root).fontFamily || 'system-ui, sans-serif',
    };
  }

  const zoneIndexOf = (value) => {
    if (!isNum(value) || !zones.length) return -1;
    const v = clamp(value, Math.min(min, max), Math.max(min, max));
    for (let i = zones.length - 1; i >= 0; i--) if (v >= zones[i].from && v <= zones[i].to) return i;
    return v < zones[0].from ? 0 : zones.length - 1;
  };

  // --- medidas -------------------------------------------------------------------------------

  const fraction = (value) => {
    const span = max - min;
    return span === 0 ? 0 : clamp((value - min) / span, 0, 1);
  };
  // meia-volta: o mínimo fica à esquerda (180°) e o máximo à direita (360°)
  const angleOf = (value) => Math.PI + Math.PI * fraction(value);

  function measure() {
    const width = Math.floor(Math.min(root.clientWidth || 0, maxWidth));
    if (width < 40) {
      geo = null;
      return;
    }
    const thick = clamp(Math.round(width * 0.062), 12, 20);
    const ringGap = 5;
    const ringW = 3;
    const pad = ringGap + ringW + 2;
    const r = width / 2 - pad - thick / 2;
    const cx = width / 2;
    const cy = pad + thick / 2 + r;
    const height = Math.ceil(cy + thick / 2 + (showEnds ? 22 : 4));
    geo = { width, height, thick, ringGap, ringW, r, cx, cy };

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pw = Math.round(width * dpr);
    const ph = Math.round(height * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    canvas.style.height = `${height}px`;
    geo.dpr = dpr;
    // o texto mora na "tigela" do arco, encostado na linha de base
    readout.style.bottom = `${height - cy - 2}px`;
    fitKey = '';
    fitText();
  }

  /** Tamanho do número: grande, mas sempre dentro do arco (números compridos encolhem). */
  function fitText() {
    if (!geo) return;
    const key = `${geo.width}|${valueText.textContent}|${unitEl.textContent}`;
    if (key === fitKey) return;
    fitKey = key;
    const base = clamp(Math.round(geo.width * 0.165), 30, 54);
    valueEl.style.fontSize = `${base}px`;
    const room = (geo.r - geo.thick / 2) * 1.5; // corda do arco na altura do número
    const need = valueEl.scrollWidth;
    if (need > room && need > 0) valueEl.style.fontSize = `${Math.max(22, Math.floor((base * room) / need))}px`;
  }

  // --- desenho -------------------------------------------------------------------------------

  function arc(radius, a0, a1, width, color, cap = 'butt', alpha = 1) {
    if (a1 <= a0) return;
    ctx.beginPath();
    ctx.arc(geo.cx, geo.cy, radius, a0, a1);
    ctx.lineWidth = width;
    ctx.lineCap = cap;
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function draw() {
    if (dead || !geo) return;
    if (!theme) readTheme();
    const { width, height, thick, ringGap, ringW, r, cx, cy, dpr } = geo;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const active = zoneIndexOf(target);
    const color = active >= 0 ? theme.zones[active] : theme.accent;

    // trilho
    arc(r, Math.PI, 2 * Math.PI, thick, theme.track, 'round');

    // anel das zonas, por fora do trilho: a zona do valor atual fica acesa
    if (zones.length) {
      const ringR = r + thick / 2 + ringGap + ringW / 2;
      const gap = 0.018; // respiro entre zonas (rad)
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      zones.forEach((z, i) => {
        const from = clamp(z.from, lo, hi);
        const to = clamp(z.to, lo, hi);
        if (to <= from) return;
        let a0 = angleOf(min <= max ? from : to);
        let a1 = angleOf(min <= max ? to : from);
        if (a0 > Math.PI + 0.001) a0 += gap / 2;
        if (a1 < 2 * Math.PI - 0.001) a1 -= gap / 2;
        arc(ringR, a0, a1, ringW, theme.zones[i], 'butt', i === active ? 1 : 0.42);
      });
    }

    // valor
    if (isNum(shown)) {
      const a = angleOf(shown);
      if (a > Math.PI + 0.004) arc(r, Math.PI, a, thick, color, 'round');
      // "botão" na ponta: marca onde o valor está mesmo quando ele é o mínimo
      const kx = cx + r * Math.cos(a);
      const ky = cy + r * Math.sin(a);
      ctx.beginPath();
      ctx.arc(kx, ky, thick / 2, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(kx, ky, thick * 0.2, 0, 2 * Math.PI);
      ctx.fillStyle = theme.surface;
      ctx.fill();
    }

    // marca de pico: um traço atravessando o trilho
    if (isNum(peak)) {
      const a = angleOf(peak);
      const r0 = r - thick / 2 - 3;
      const r1 = r + thick / 2 + 3;
      ctx.beginPath();
      ctx.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
      ctx.lineTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.strokeStyle = theme.text;
      ctx.stroke();
    }

    // extremos da escala
    if (showEnds) {
      ctx.font = `500 12px ${theme.font}`;
      ctx.fillStyle = theme.label;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'center';
      const y = cy + thick / 2 + 16;
      const edge = (text, x) => {
        const half = ctx.measureText(text).width / 2;
        ctx.fillText(text, clamp(x, half + 1, width - half - 1), y);
      };
      edge(String(formatTick(min)), cx - r);
      edge(String(formatTick(max)), cx + r);
    }
  }

  function frame(now) {
    raf = 0;
    if (dead) return;
    if (!isNum(target) || !isNum(shown)) {
      shown = isNum(target) ? target : null;
      draw();
      return;
    }
    const dt = clamp(now - lastFrame, 0, 64);
    lastFrame = now;
    shown += (target - shown) * (1 - Math.exp(-dt / 110));
    if (Math.abs(target - shown) < Math.abs(max - min) * 0.002) shown = target;
    draw();
    if (shown !== target) raf = requestAnimationFrame(frame);
  }

  function schedule(animate) {
    const still = !animate || (reduceMotion && reduceMotion.matches) || typeof requestAnimationFrame !== 'function';
    if (!isNum(target)) shown = null;
    else if (still) shown = target;
    else if (!isNum(shown)) shown = min; // primeira leitura: o arco sobe desde o início da escala
    if (shown === target || shown === null) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      draw();
      return;
    }
    if (!raf) {
      lastFrame = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  // --- texto e acessibilidade ----------------------------------------------------------------

  function syncText() {
    const has = isNum(target);
    const text = has ? String(format(target)) : '—';
    if (valueText.textContent !== text) valueText.textContent = text;
    if (unitEl.textContent !== unit) unitEl.textContent = unit;
    unitEl.hidden = !unit || !has;
    if (labelEl.textContent !== label) labelEl.textContent = label;

    const active = zoneIndexOf(target);
    const spec = active >= 0 ? zones[active].color : '';
    const token = tokenOf(spec);
    // com token o texto acompanha o tema sozinho; sem zona, fica na cor de texto apagado
    root.style.setProperty('--gauge-color', token ? `var(${token})` : spec || 'var(--muted)');

    root.setAttribute('aria-valuemin', String(Math.min(min, max)));
    root.setAttribute('aria-valuemax', String(Math.max(min, max)));
    if (has) root.setAttribute('aria-valuenow', String(clamp(target, Math.min(min, max), Math.max(min, max))));
    else root.removeAttribute('aria-valuenow');
    root.setAttribute('aria-valuetext', has ? [`${text}${unit ? ` ${unit}` : ''}`, label].filter(Boolean).join(', ') : label || 'sem leitura');
    root.dataset.value = has ? String(target) : '';
    root.dataset.peak = isNum(peak) ? String(peak) : '';
    fitText();
  }

  // --- observadores --------------------------------------------------------------------------

  function resize() {
    if (dead) return;
    measure();
    draw();
  }

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => resize());
    ro.observe(root);
  }
  window.addEventListener('resize', resize);

  let mo = null;
  if (typeof MutationObserver === 'function') {
    mo = new MutationObserver(() => {
      theme = null;
      draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  }

  syncText();
  measure();
  draw();

  return {
    el: root,

    set(value, { peak: nextPeak, animate = true, label: nextLabel } = {}) {
      if (dead) return;
      target = isNum(value) ? value : null;
      if (nextPeak !== undefined) peak = isNum(nextPeak) ? nextPeak : null;
      if (nextLabel !== undefined) label = nextLabel == null ? '' : String(nextLabel);
      syncText();
      if (!geo) measure();
      schedule(animate);
    },

    setRange(nextMin, nextMax) {
      if (dead || !isNum(nextMin) || !isNum(nextMax)) return;
      if (nextMin === min && nextMax === max) return;
      min = nextMin;
      max = nextMax;
      syncText();
      draw();
    },

    setZones(nextZones) {
      if (dead) return;
      zones = normalizeZones(nextZones);
      theme = null;
      syncText();
      draw();
    },

    setLabel(text) {
      if (dead) return;
      label = text == null ? '' : String(text);
      syncText();
    },

    setUnit(text) {
      if (dead) return;
      unit = text == null ? '' : String(text);
      syncText();
    },

    resize,

    destroy() {
      if (dead) return;
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
      window.removeEventListener('resize', resize);
      root.remove();
    },
  };
}
