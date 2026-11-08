// Gráficos em SVG/HTML puro (sem bibliotecas): leves e no estilo do app.

import { brl, brlShort, esc, monthLabel } from './format.js';

const pct = (v) => `${Math.round(v * 100)}%`;
const tipAttr = (title, rows) => `data-tip="${esc(JSON.stringify({ t: title, r: rows }))}"`;

/** Barras horizontais ordenadas (maior primeiro), uma cor só. */
export function rankedBars(items, { color, limit } = {}) {
  const list = limit ? items.slice(0, limit) : items;
  if (!list.length) return '';
  const max = list[0].valor || 1;
  return `<ul class="rbars">${list.map((it) => `
    <li class="rbar" tabindex="0" aria-label="${esc(`${it.nome}: ${brl(it.valor)}, ${pct(it.pct)}`)}">
      <div class="rbar-top">
        <span class="rbar-ico" aria-hidden="true">${esc(it.icone)}</span>
        <span class="rbar-name">${esc(it.nome)}</span>
        <span class="rbar-val">${brl(it.valor)}</span>
        <span class="rbar-pct">${pct(it.pct)}</span>
      </div>
      <div class="rbar-fill" style="width:${Math.max(1, (it.valor / max) * 100).toFixed(2)}%;background:${color}"></div>
    </li>`).join('')}</ul>`;
}

/** Barra segmentada alta: um todo dividido em partes (ex.: despesas por pessoa). */
export function segmentedBar(parts, { label = '' } = {}) {
  const visible = parts.filter((p) => p.valor > 0);
  const total = visible.reduce((a, p) => a + p.valor, 0);
  if (!total) return '';
  const aria = visible.map((p) => `${p.label}: ${brl(p.valor)} (${pct(p.valor / total)})`).join('; ');
  return `
    <div class="segbar" role="img" aria-label="${esc(`${label} ${aria}`)}">
      ${visible.map((p) => {
        const share = p.valor / total;
        return `<div class="seg" style="flex-grow:${p.valor};background:${p.color}"
          ${tipAttr(p.label, [[label || 'Total', brl(p.valor), p.color], ['Parte', pct(share), '']])} tabindex="0">
          ${share >= 0.14 ? `<span>${pct(share)}</span>` : ''}</div>`;
      }).join('')}
    </div>
    <ul class="legend">${visible.map((p) => `<li><i class="key-rect" style="background:${p.color}"></i>${esc(p.label)}</li>`).join('')}</ul>`;
}

function niceStep(max, count = 4) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * mag;
}

function colPath(x, y, w, h, r = 4) {
  if (h <= 0.5) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * Colunas agrupadas por mês (receitas x despesas), um único eixo.
 * series: [{ key, label, color }]
 */
export function columnsChart(data, series, { highlight } = {}) {
  const W = 340;
  const H = 190;
  const pad = { t: 12, r: 6, b: 24, l: 40 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const maxVal = Math.max(0, ...data.flatMap((d) => series.map((s) => d[s.key])));
  const step = maxVal > 0 ? niceStep(maxVal) : 1000;
  const top = Math.max(step, Math.ceil(maxVal / step) * step);
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const y = (v) => pad.t + ph - (v / top) * ph;
  const band = pw / data.length;
  const bw = Math.min(16, (band - 10) / series.length - 2);
  const groupW = series.length * bw + (series.length - 1) * 2;

  const grid = ticks.map((v) => `
    <line class="${v === 0 ? 'axis' : 'grid'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="tick" x="${pad.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${brlShort(v)}</text>`).join('');

  const groups = data.map((d, i) => {
    const gx = pad.l + band * i + (band - groupW) / 2;
    const bars = series.map((s, j) => {
      const h = (d[s.key] / top) * ph;
      return `<path d="${colPath(gx + j * (bw + 2), pad.t + ph - h, bw, h)}" style="fill:${s.color}"/>`;
    }).join('');
    const isHi = d.month === highlight;
    const tip = tipAttr(monthLabel(d.month), series.map((s) => [s.label, brl(d[s.key]), s.color]));
    return `<g class="grp${isHi ? ' hi' : ''}">
      ${bars}
      <text class="xlab${isHi ? ' on' : ''}" x="${pad.l + band * i + band / 2}" y="${H - 7}" text-anchor="middle">${monthLabel(d.month, { short: true, year: false })}</text>
      <rect class="hit" x="${pad.l + band * i}" y="${pad.t}" width="${band}" height="${ph}" tabindex="0" ${tip}
        aria-label="${esc(`${monthLabel(d.month)}: ${series.map((s) => `${s.label} ${brl(d[s.key])}`).join(', ')}`)}"/>
    </g>`;
  }).join('');

  const table = `
    <details class="tview" data-key="trend-table"><summary>Ver tabela</summary>
      <table><thead><tr><th>Mês</th>${series.map((s) => `<th>${esc(s.label)}</th>`).join('')}</tr></thead>
      <tbody>${data.map((d) => `<tr><td>${monthLabel(d.month, { short: true })}</td>${series.map((s) => `<td>${brl(d[s.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </details>`;

  return `
    <ul class="legend">${series.map((s) => `<li><i class="key-rect" style="background:${s.color}"></i>${esc(s.label)}</li>`).join('')}</ul>
    <div class="chart cols">
      <svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Gráfico de colunas por mês">${grid}${groups}</svg>
    </div>
    ${table}`;
}

// ---------- Dica flutuante (tooltip) compartilhada por todos os gráficos ----------

let tipEl = null;
let current = null;

function showTip(target) {
  const host = target.closest('.chart, .segbar') || document.body;
  let data;
  try { data = JSON.parse(target.getAttribute('data-tip')); } catch { return; }
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.setAttribute('role', 'status');
  }
  tipEl.replaceChildren();
  const title = document.createElement('div');
  title.className = 'tt-title';
  title.textContent = data.t;
  tipEl.append(title);
  for (const [label, value, color] of data.r) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('i');
    key.className = 'key-line';
    if (color) key.style.background = color;
    else key.style.visibility = 'hidden';
    const v = document.createElement('strong');
    v.textContent = value;
    const l = document.createElement('span');
    l.textContent = label;
    row.append(key, v, l);
    tipEl.append(row);
  }
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.append(tipEl);
  const hr = host.getBoundingClientRect();
  const tr = target.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  let left = tr.left - hr.left + tr.width / 2 - tw / 2;
  left = Math.max(4, Math.min(left, hr.width - tw - 4));
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${Math.max(0, tr.top - hr.top - tipEl.offsetHeight - 6)}px`;
  host.classList.add('hovering');
  target.closest('.grp, .seg')?.classList.add('on');
  current = target;
}

function hideTip() {
  if (!current) return;
  current.closest('.chart, .segbar')?.classList.remove('hovering');
  current.closest('.grp, .seg')?.classList.remove('on');
  tipEl?.remove();
  current = null;
}

export function initTooltips() {
  const find = (e) => e.target.closest?.('[data-tip]');
  document.addEventListener('pointerover', (e) => { const t = find(e); if (t && t !== current) { hideTip(); showTip(t); } });
  document.addEventListener('pointerout', (e) => {
    if (e.pointerType === 'touch') return; // no toque, a dica fica até tocar em outro lugar
    const t = find(e);
    if (t && !t.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener('focusin', (e) => { const t = find(e); if (t) { hideTip(); showTip(t); } });
  document.addEventListener('focusout', (e) => { if (find(e)) hideTip(); });
  document.addEventListener('pointerdown', (e) => { if (!find(e)) hideTip(); });
  window.addEventListener('scroll', hideTip, { passive: true });
}
