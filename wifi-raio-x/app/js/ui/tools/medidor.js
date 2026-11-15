// Medidor de sinal e caça-roteador.
//
// Alvo: por padrão a rede em que o celular está conectado (leitura ao vivo pelo fluxo 'rssi';
// enquanto a tela está aberta o app pede 4 leituras por segundo e devolve 1 por segundo ao sair).
// Qualquer outra rede só muda a cada busca de redes: a tela diz isso e pede as buscas no ritmo
// mais rápido que o Android deixar (o modo volta ao normal ao sair).
// A rota aceita ?bssid=aa:bb:cc:dd:ee:ff para já abrir numa rede (é como a tela Redes chega aqui).
//
// A tela: mostrador semicircular (dBm, palavra, marca de pico), qualidade e distância estimada,
// mínimo / média / máximo desta medição, gráfico de fita dos últimos segundos (desenhado aqui
// mesmo: uma série só, colorida pela faixa de sinal), o modo caça-roteador
// (mais perto / mais longe, "temperatura", bipes por WebAudio e toques por bridge.vibrate) e,
// quando o celular e o roteador sabem, a distância medida por Wi-Fi RTT.
//
// As contas ficam em funções puras exportadas (trendOf, heatOf, feedbackFor, createStats,
// createSmoother), conferidas em tests/e2e/tools-a.e2e.mjs.
//
// Ganchos para os testes (data-*, na raiz da tela): data-target (BSSID medido), data-live,
// data-samples, data-rssi, data-trend, data-ticks (toques de vibração enviados) e data-beeps.

import { h, patch, mount as render, sheet, toast, cssVar, fmtDbm, fmtPct, fmtMeters, fmtAgo, fmtNum, fmtBand, THIN, MINUS } from '../dom.js';
import { icon } from '../icons.js';
import { apRow, signalBars, ssidLabel, button, switchRow, listRow, spinner, banner } from '../components.js';
import { signalLevel, qualityPct, indoorDistance } from '../../core/signal.js';
import { createGauge } from '../charts/gauge.js';
import { useToolsCss } from './conexao.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// ---------------------------------------------------------------------------
// Contas (sem DOM)
// ---------------------------------------------------------------------------

export const RSSI_MIN = -100;
export const RSSI_MAX = -30;

/** As faixas do mostrador: os mesmos limites de core/signal.js (signalLevel). */
export const SIGNAL_ZONES = Object.freeze([
  Object.freeze({ from: -100, to: -82, color: '--sig-5' }),
  Object.freeze({ from: -82, to: -75, color: '--sig-4' }),
  Object.freeze({ from: -75, to: -67, color: '--sig-3' }),
  Object.freeze({ from: -67, to: -60, color: '--sig-2' }),
  Object.freeze({ from: -60, to: -30, color: '--sig-1' }),
]);

/** "aa:bb:cc:dd:ee:ff" em minúsculas, ou '' se não for um BSSID. */
export function normBssid(text) {
  const value = typeof text === 'string' ? text.trim().toLowerCase().replace(/-/g, ':') : '';
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(value) ? value : '';
}

/**
 * Média móvel com constante de tempo (as leituras chegam em intervalos irregulares).
 * @param {number} tauMs  0 = sem suavizar
 * @returns {((t:number, x:number) => number) & {reset:() => void}}
 */
export function createSmoother(tauMs) {
  let value = null;
  let last = null;
  const fn = (t, x) => {
    if (value === null || !(tauMs > 0)) value = x;
    else value += (x - value) * (1 - Math.exp(-Math.max(0, t - last) / tauMs));
    last = t;
    return value;
  };
  fn.reset = () => {
    value = null;
    last = null;
  };
  return fn;
}

/** Mínimo, média e máximo de uma medição (com o instante do máximo, para a marca de pico). */
export function createStats() {
  let count = 0;
  let sum = 0;
  let min = null;
  let max = null;
  let maxAt = null;
  return {
    add(rssi, t) {
      if (!isNum(rssi)) return;
      count += 1;
      sum += rssi;
      if (min === null || rssi < min) min = rssi;
      if (max === null || rssi > max) {
        max = rssi;
        maxAt = t;
      }
    },
    reset() {
      count = 0;
      sum = 0;
      min = null;
      max = null;
      maxAt = null;
    },
    get: () => ({ count, min, max, maxAt, avg: count ? sum / count : null }),
  };
}

/**
 * Para onde o sinal está indo: reta ajustada (mínimos quadrados) às leituras da janela.
 * @param {{t:number, v:number}[]} points  leituras já suavizadas, em ordem de tempo
 * @param {{now:number, windowMs?:number, minDeltaDb?:number, minPoints?:number, minSpanMs?:number}} options
 *        minDeltaDb = quanto o sinal precisa mudar ao longo da janela para contar como tendência
 * @returns {{state:'closer'|'farther'|'steady'|'unknown', deltaDb:number|null, spanMs:number}}
 */
export function trendOf(points, { now, windowMs = 5000, minDeltaDb = 2, minPoints = 3, minSpanMs = windowMs * 0.4 } = {}) {
  const from = now - windowMs;
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && isNum(p.t) && isNum(p.v) && p.t >= from && p.t <= now);
  const unknown = { state: 'unknown', deltaDb: null, spanMs: 0 };
  if (pts.length < Math.max(2, minPoints)) return unknown;
  const spanMs = pts[pts.length - 1].t - pts[0].t;
  if (spanMs <= 0 || spanMs < minSpanMs) return unknown;
  let mt = 0;
  let mv = 0;
  for (const p of pts) {
    mt += p.t;
    mv += p.v;
  }
  mt /= pts.length;
  mv /= pts.length;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - mt) * (p.v - mv);
    den += (p.t - mt) * (p.t - mt);
  }
  if (den === 0) return unknown;
  const deltaDb = (num / den) * spanMs;
  const state = deltaDb >= minDeltaDb ? 'closer' : deltaDb <= -minDeltaDb ? 'farther' : 'steady';
  return { state, deltaDb, spanMs };
}

const HEAT = [
  { min: -45, level: 5, label: 'Muito quente', text: 'O roteador está bem aqui, a um ou dois passos.' },
  { min: -55, level: 4, label: 'Quente', text: 'Bem perto: provavelmente neste cômodo.' },
  { min: -67, level: 3, label: 'Morno', text: 'No caminho certo: talvez a um cômodo de distância.' },
  { min: -78, level: 2, label: 'Frio', text: 'Ainda longe, ou com paredes no caminho.' },
  { min: -Infinity, level: 1, label: 'Muito frio', text: 'Bem longe do roteador.' },
];

/** "Temperatura" da caça: 1 (muito frio) a 5 (muito quente); 0 sem leitura. */
export function heatOf(rssi) {
  if (!isNum(rssi)) return { level: 0, label: 'Sem leitura', text: '' };
  const step = HEAT.find((s) => rssi >= s.min);
  return { level: step.level, label: step.label, text: step.text };
}

/**
 * Ritmo e tom dos avisos da caça: quanto mais forte o sinal, mais rápidos e agudos.
 * −90 dBm ou menos = um bipe grave a cada 1,4 s; −40 dBm ou mais = bipes agudos colados.
 * @returns {{intervalMs:number, freqHz:number, vibrateMs:number}}
 */
export function feedbackFor(rssi) {
  const q = isNum(rssi) ? clamp((rssi + 90) / 50, 0, 1) : 0;
  return {
    intervalMs: Math.round(1400 - 1250 * Math.pow(q, 0.85)),
    freqHz: Math.round(440 * Math.pow(2, q * 1.585)), // de lá (440 Hz) até uma oitava e meia acima
    vibrateMs: Math.round(12 + 18 * q),
  };
}

// ---------------------------------------------------------------------------
// Som
// ---------------------------------------------------------------------------

/** Bipes por WebAudio. Nada aqui lança: sem áudio, `available` é false e o resto vira nada. */
function createBeeper() {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  let ctx = null;
  return {
    available: typeof AudioCtx === 'function',
    /** Precisa ser chamado a partir de um toque do usuário. Devolve true se o som está pronto. */
    async enable() {
      if (typeof AudioCtx !== 'function') return false;
      try {
        if (!ctx || ctx.state === 'closed') ctx = new AudioCtx();
        if (ctx.state !== 'running') {
          // alguns WebViews nunca resolvem o resume(): não fica esperando para sempre
          await Promise.race([ctx.resume(), new Promise((resolve) => setTimeout(resolve, 1200))]);
        }
        return ctx.state === 'running';
      } catch {
        return false;
      }
    },
    beep(freqHz, ms = 70) {
      if (!ctx || ctx.state !== 'running') return false;
      try {
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freqHz;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.22, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + ms / 1000 + 0.02);
        return true;
      } catch {
        return false;
      }
    },
    suspend() {
      if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
    },
    close() {
      if (!ctx) return;
      const old = ctx;
      ctx = null;
      try {
        if (old.state !== 'closed') old.close().catch(() => {});
      } catch {
        // já estava fechado
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Gráfico de fita: o sinal nos últimos segundos (canvas)
// ---------------------------------------------------------------------------

/** Escala vertical em múltiplos de 10 dB, com folga e pelo menos 30 dB de altura. */
export function stripRange(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!isNum(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return { min: -90, max: -40 };
  let min = Math.max(-100, Math.floor((lo - 3) / 10) * 10);
  let max = Math.min(-20, Math.ceil((hi + 3) / 10) * 10);
  let down = true;
  for (let guard = 0; max - min < 30 && guard < 20; guard++) {
    if (down && min - 10 >= -100) min -= 10;
    else if (max + 10 <= -20) max += 10;
    else if (min - 10 >= -100) min -= 10;
    else break;
    down = !down;
  }
  return { min, max };
}

/** Rótulo de uma idade no eixo do tempo: 0 -> "agora"; 30 -> "−30 s"; 120 -> "−2 min". */
export function ageLabel(sec) {
  const s = Math.round(sec);
  if (s <= 0) return 'agora';
  return s % 60 === 0 ? `${MINUS}${s / 60}${THIN}min` : `${MINUS}${s}${THIN}s`;
}

// limites das faixas de sinal (os de signalLevel) e o token de cada uma, da mais forte à mais fraca
const LEVEL_STEPS = [
  { min: -60, token: '--sig-1' },
  { min: -67, token: '--sig-2' },
  { min: -75, token: '--sig-3' },
  { min: -82, token: '--sig-4' },
  { min: -Infinity, token: '--sig-5' },
];

/**
 * Linha do sinal numa janela de tempo que termina "agora". A linha leva a cor da faixa de sinal
 * em cada altura (verde em cima, vermelho embaixo) e é interrompida onde faltou leitura.
 * Respeita a densidade da tela, relê as cores quando o tema muda e se refaz ao mudar de largura.
 * @param {HTMLElement} host
 * @param {{height?:number}} [options]
 * @returns {{el:HTMLCanvasElement, set:(data:{points:{t:number, rssi:number}[], windowMs:number, gapMs:number, now:number}) => void,
 *            resize:() => void, destroy:() => void}}
 */
function createStripChart(host, { height = 150 } = {}) {
  const canvas = h('canvas.mtr-chart__canvas', { role: 'img', 'aria-label': 'Sinal ao longo do tempo' });
  canvas.style.height = `${height}px`;
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const PAD = { top: 10, right: 12, bottom: 24, left: 36 };
  let width = 0;
  let dpr = 1;
  let theme = null;
  let dead = false;
  let data = { points: [], windowMs: 60_000, gapMs: 4000, now: Date.now() };

  function readTheme() {
    const pick = (name, fallback) => cssVar(name) || fallback;
    theme = {
      grid: pick('--chart-grid', 'rgba(147,160,184,0.16)'),
      axis: pick('--chart-axis', '#4a5a78'),
      label: pick('--chart-label', '#93a0b8'),
      text: pick('--text', '#e8eef9'),
      surface: pick('--surface', '#121a2b'),
      levels: LEVEL_STEPS.map((s) => pick(s.token, '#93a0b8')),
      font: getComputedStyle(host).fontFamily || 'system-ui, sans-serif',
    };
  }

  const levelColor = (rssi) => theme.levels[LEVEL_STEPS.findIndex((s) => rssi >= s.min)];

  function draw() {
    if (dead || !width) return;
    if (!theme) readTheme();
    const { points, windowMs, gapMs, now } = data;
    const from = now - windowMs;
    const plot = { x: PAD.left, y: PAD.top, w: Math.max(10, width - PAD.left - PAD.right), h: Math.max(10, height - PAD.top - PAD.bottom) };
    const bottom = plot.y + plot.h;
    const right = plot.x + plot.w;

    // trechos contínuos dentro da janela (com o ponto de entrada pela borda esquerda)
    const segments = [];
    let seg = null;
    let prev = null;
    const inWindow = [];
    for (const p of points) {
      if (p.t > now + 500) break;
      if (p.t < from) {
        prev = p;
        continue;
      }
      inWindow.push(p.rssi);
      if (seg && p.t - seg[seg.length - 1].t <= gapMs) seg.push(p);
      else {
        seg = prev && prev.t < from && p.t - prev.t <= gapMs ? [prev, p] : [p];
        segments.push(seg);
      }
      prev = p;
    }
    const range = stripRange(inWindow);
    const xOf = (t) => plot.x + ((t - from) / windowMs) * plot.w;
    const yOf = (v) => plot.y + ((range.max - v) / (range.max - range.min)) * plot.h;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // linhas a cada 10 dB, com o valor à esquerda
    ctx.font = `400 12px ${theme.font}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let v = range.max; v >= range.min; v -= 10) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillStyle = theme.label;
      ctx.fillText(`${MINUS}${Math.abs(v)}`, plot.x - 8, y);
    }

    // eixo do tempo: três marcas bastam numa fita
    ctx.strokeStyle = theme.axis;
    ctx.beginPath();
    ctx.moveTo(plot.x, bottom + 0.5);
    ctx.lineTo(right, bottom + 0.5);
    ctx.stroke();
    ctx.textBaseline = 'top';
    const windowS = Math.round(windowMs / 1000);
    [0, windowS / 2, windowS].forEach((age, i) => {
      const x = right - (age / windowS) * plot.w;
      const text = ageLabel(age);
      ctx.fillStyle = i === 0 ? theme.text : theme.label;
      ctx.font = `${i === 0 ? 600 : 400} 12px ${theme.font}`;
      ctx.textAlign = i === 0 ? 'right' : i === 2 ? 'left' : 'center';
      ctx.fillText(text, x, bottom + 7);
    });

    if (!segments.length) {
      ctx.fillStyle = theme.label;
      ctx.font = `400 14px ${theme.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Aguardando as primeiras leituras', plot.x + plot.w / 2, plot.y + plot.h / 2);
      canvas.setAttribute('aria-label', 'Sinal ao longo do tempo: ainda sem leituras.');
      return;
    }

    // a cor muda com a altura: cada faixa de sinal tem a sua
    const paint = ctx.createLinearGradient(0, plot.y, 0, bottom);
    const frac = (v) => clamp((range.max - v) / (range.max - range.min), 0, 1);
    let top = range.max;
    LEVEL_STEPS.forEach((step, i) => {
      const lo = Math.max(range.min, step.min);
      if (lo >= top) return;
      paint.addColorStop(frac(top), theme.levels[i]);
      paint.addColorStop(frac(lo), theme.levels[i]);
      top = lo;
    });

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y - 6, plot.w + 8, plot.h + 6);
    ctx.clip();
    const sparse = inWindow.length <= 14;
    for (const s of segments) {
      if (s.length > 1) {
        // área sob a linha, bem leve
        ctx.beginPath();
        s.forEach((p, i) => (i === 0 ? ctx.moveTo(xOf(p.t), yOf(p.rssi)) : ctx.lineTo(xOf(p.t), yOf(p.rssi))));
        ctx.lineTo(xOf(s[s.length - 1].t), bottom);
        ctx.lineTo(xOf(s[0].t), bottom);
        ctx.closePath();
        ctx.fillStyle = paint;
        ctx.globalAlpha = 0.1;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        s.forEach((p, i) => (i === 0 ? ctx.moveTo(xOf(p.t), yOf(p.rssi)) : ctx.lineTo(xOf(p.t), yOf(p.rssi))));
        ctx.strokeStyle = paint;
        ctx.lineWidth = 2.25;
        ctx.stroke();
      }
      // poucas leituras (rede lida a cada busca): cada uma ganha um ponto
      if (sparse || s.length === 1) {
        for (const p of s) {
          if (p.t < from) continue;
          ctx.beginPath();
          ctx.arc(xOf(p.t), yOf(p.rssi), 3, 0, 2 * Math.PI);
          ctx.fillStyle = levelColor(p.rssi);
          ctx.fill();
        }
      }
    }
    ctx.restore();

    // a leitura atual: um ponto maior na borda direita
    const lastSeg = segments[segments.length - 1];
    const last = lastSeg[lastSeg.length - 1];
    if (now - last.t <= gapMs) {
      const x = Math.min(right, xOf(last.t));
      const y = yOf(last.rssi);
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, 2 * Math.PI);
      ctx.fillStyle = theme.surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 3.75, 0, 2 * Math.PI);
      ctx.fillStyle = levelColor(last.rssi);
      ctx.fill();
    }

    let lo = Infinity;
    let hi = -Infinity;
    for (const v of inWindow) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    canvas.setAttribute('aria-label', `Sinal ao longo do tempo: entre ${fmtDbm(lo)} e ${fmtDbm(hi)} nesta janela; a última leitura foi ${fmtDbm(last.rssi)}.`);
  }

  function resize() {
    if (dead) return;
    const w = Math.floor(host.clientWidth);
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    if (!w) return;
    if (w !== width || ratio !== dpr) {
      width = w;
      dpr = ratio;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(height * dpr);
    }
    draw();
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(host);
  window.addEventListener('resize', resize);
  const mo =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          theme = null;
          draw();
        })
      : null;
  if (mo) mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  resize();

  return {
    el: canvas,
    set(next) {
      data = next;
      if (!width) resize();
      else draw();
    },
    resize,
    destroy() {
      dead = true;
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
      window.removeEventListener('resize', resize);
      canvas.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

const LIVE_WINDOW_MS = 60_000;
const SCAN_WINDOW_MS = 120_000;
const LIVE_TAU_MS = 1200; // suavização para a tendência e os avisos
const LIVE_STALE_MS = 4000; // sem leitura ao vivo por este tempo: o valor na tela é velho
const RENDER_MIN_MS = 160;
const RTT_TIMEOUT_MS = 12_000;
const MAX_SAMPLES = 4000;
const PREFS_KEY = 'meter';

const TREND = {
  closer: { icon: 'arrow-up', title: 'Mais perto' },
  farther: { icon: 'arrow-down', title: 'Mais longe' },
  steady: { icon: 'minus', title: 'Estável' },
  unknown: { icon: 'compass', title: 'Sentindo a direção…' },
};

export async function mount(root, ctx) {
  const { store, bridge, scanLoop, prefs } = ctx;

  await useToolsCss();
  // o usuário pode ter saído enquanto a folha de estilo chegava
  if (!root.isConnected) return { unmount() {} };
  root.classList.add('mtr');

  let alive = true;
  let pinned = normBssid(ctx.route.query.get('bssid')); // '' = acompanha a rede conectada
  let targetKey = null;
  let samples = []; // {t, rssi, v} — v = valor suavizado
  let current = null; // {rssi, at}: a última leitura
  let lastHeard = null; // marca da última leitura de varredura já contada (Ap.lastSeen)
  const stats = createStats();
  let smoother = createSmoother(LIVE_TAU_MS);

  const saved = prefs.get(PREFS_KEY, null);
  let hunt = false;
  let sound = false; // o som nunca liga sozinho: depende de um toque
  let soundPending = false; // ligando o áudio (a chave fica marcada enquanto isso)
  let haptics = !saved || saved.haptics !== false;
  let ticks = 0;
  let beeps = 0;
  let tickTimer = null;
  let lastVibe = 0;
  const beeper = createBeeper();

  let rtt = { status: 'idle' };
  let rttToken = 0;
  let picker = null;

  // --- esqueleto: os hospedeiros dos gráficos ficam fixos; o resto é atualizado com patch() ---
  const targetHost = h('div.mtr-target');
  const gaugeHost = h('div.mtr-gauge');
  const metaHost = h('div.mtr-meta');
  const statsHost = h('div.mtr-stats-host');
  const chartHead = h('div.mtr-chart__head');
  const chartHost = h('div.mtr-chart');
  const huntHost = h('div.mtr-hunt-host');
  const rttHost = h('div.mtr-rtt-host');
  render(
    root,
    targetHost,
    h('section.card.mtr-instrument', null, gaugeHost, metaHost, statsHost),
    h('section.card.mtr-chartcard', null, chartHead, chartHost),
    huntHost,
    rttHost,
  );

  const gauge = createGauge(gaugeHost, {
    min: RSSI_MIN,
    max: RSSI_MAX,
    zones: SIGNAL_ZONES,
    format: (v) => fmtDbm(v, { unit: false }),
    unit: 'dBm',
    label: 'Sem leitura',
    ariaLabel: 'Sinal da rede',
  });
  const chart = createStripChart(chartHost, { height: 150 });

  // --- alvo --------------------------------------------------------------------------------

  /** Quem está sendo medido agora, a partir do estado do app. */
  function resolve(state = store.get()) {
    const conn = state.connection && state.connection.connected ? state.connection : null;
    const connBssid = conn ? normBssid(conn.bssid) : '';
    const follow = pinned === '';
    const bssid = follow ? connBssid : pinned;
    const live = !!conn && (follow || (connBssid !== '' && bssid === connBssid));
    const ap = bssid ? store.apById(bssid) : follow && conn ? store.connectedAp() : null;
    return {
      follow,
      bssid,
      live,
      ap,
      conn,
      has: live || bssid !== '',
      key: follow ? `follow:${conn ? connBssid || 'conn' : ''}` : `pin:${pinned}`,
      ssid: ap ? ap.ssid : live && conn && typeof conn.ssid === 'string' ? conn.ssid : '',
      freq: ap && isNum(ap.freq) ? ap.freq : live && conn && isNum(conn.frequency) ? conn.frequency : null,
    };
  }

  const scanIntervalMs = () => {
    const ms = store.get().loop.intervalMs;
    return isNum(ms) && ms > 0 ? ms : 10_000;
  };
  const gapFor = (t) => (t.live ? LIVE_STALE_MS : scanIntervalMs() * 2.5 + 3000);

  function addSample(t, rssi, { count = true } = {}) {
    if (!isNum(rssi)) return;
    samples.push({ t, rssi, v: smoother(t, rssi) });
    if (samples.length > MAX_SAMPLES) samples = samples.slice(-MAX_SAMPLES);
    current = { rssi, at: t };
    if (count) stats.add(rssi, t);
  }

  /** Começa a medição do alvo atual: zera tudo e aproveita o que o app já ouviu dele há pouco. */
  function restart() {
    const t = resolve();
    targetKey = t.key;
    samples = [];
    current = null;
    lastHeard = null;
    stats.reset();
    smoother = createSmoother(t.live ? LIVE_TAU_MS : 0);
    rttToken += 1;
    rtt = { status: 'idle' };
    const now = Date.now();

    if (t.live) {
      // histórico do sinal conectado: alinhado pelo relógio do celular, terminando "agora"
      const log = store.rssiHistory().filter((s) => isNum(s.rssi) && isNum(s.ts) && (!t.bssid || !s.bssid || normBssid(s.bssid) === t.bssid));
      const lastTs = log.length ? log[log.length - 1].ts : 0;
      for (const s of log) {
        const at = now - (lastTs - s.ts);
        if (at >= now - LIVE_WINDOW_MS) addSample(at, s.rssi, { count: false });
      }
    } else if (t.bssid) {
      const { scan } = store.get();
      const shift = isNum(scan.receivedAt) && isNum(scan.ts) ? scan.receivedAt - scan.ts : 0;
      for (const p of store.history(t.bssid)) {
        const at = p.t + shift;
        if (at >= now - SCAN_WINDOW_MS && at <= now) addSample(at, p.rssi, { count: false });
      }
      if (t.ap) {
        lastHeard = t.ap.lastSeen ?? null;
        // a leitura mais recente abre a medição, desde que seja mesmo desta busca
        if (!t.ap.stale && isNum(t.ap.rssi)) stats.add(t.ap.rssi, now);
        if (!current && isNum(t.ap.rssi)) current = { rssi: t.ap.rssi, at: now - (isNum(t.ap.ageMs) ? t.ap.ageMs : 0) };
      }
    }
    syncLoop(t);
    scheduleTick();
  }

  /** Rede que não é a conectada só muda a cada busca: pede o ritmo mais rápido que o Android deixar. */
  function syncLoop(t) {
    const mode = scanLoop.getState().mode;
    if (mode === 'paused') return;
    const want = t.has && !t.live ? 'mapping' : 'normal';
    if (mode !== want) scanLoop.setMode(want);
  }

  function setTarget(bssid) {
    pinned = normBssid(bssid);
    if (picker) picker.close();
    refresh();
  }

  // --- leituras -----------------------------------------------------------------------------

  function onRssi(sample) {
    if (!alive || !sample || !isNum(sample.rssi)) return;
    const t = resolve();
    if (t.key !== targetKey) restart();
    if (!t.live) return;
    if (t.bssid && sample.bssid && normBssid(sample.bssid) !== t.bssid) return;
    addSample(Date.now(), sample.rssi);
    requestRender();
  }

  function onScan() {
    if (!alive) return;
    const t = resolve();
    if (t.key !== targetKey) restart();
    if (!t.live && t.ap && isNum(t.ap.rssi)) {
      const heard = t.ap.lastSeen ?? null;
      // só conta quando o roteador foi mesmo ouvido de novo (o Android repete leituras antigas)
      if (heard !== lastHeard && !t.ap.stale) {
        lastHeard = heard;
        addSample(Date.now(), t.ap.rssi);
      }
    }
    requestRender();
    if (picker && picker.isOpen()) patch(picker.body, pickerView());
  }

  /** Reavalia o alvo (mudou a conexão, a escolha ou a rota) e redesenha. */
  function refresh() {
    if (!alive) return;
    const t = resolve();
    if (t.key !== targetKey) restart();
    else syncLoop(t);
    requestRender();
  }

  const hasFreshReading = (t, now) => {
    if (!current) return false;
    return now - current.at <= (t.live ? LIVE_STALE_MS : gapFor(t) + scanIntervalMs());
  };

  // --- caça-roteador: avisos ------------------------------------------------------------------

  const smoothNow = () => (samples.length ? samples[samples.length - 1].v : current ? current.rssi : null);

  function feedbackOn() {
    return alive && hunt && (sound || haptics) && !document.hidden && hasFreshReading(resolve(), Date.now());
  }

  function scheduleTick() {
    clearTimeout(tickTimer);
    tickTimer = null;
    if (!feedbackOn()) return;
    const fb = feedbackFor(smoothNow());
    tickTimer = setTimeout(() => {
      tickTimer = null;
      if (!feedbackOn()) return;
      const now = feedbackFor(smoothNow());
      if (sound && beeper.beep(now.freqHz)) beeps += 1;
      // o motor de vibração não acompanha toques colados: no máximo 4 por segundo
      if (haptics && performance.now() - lastVibe >= 240) {
        lastVibe = performance.now();
        ticks += 1;
        Promise.resolve()
          .then(() => bridge.vibrate(now.vibrateMs))
          .catch(() => {});
      }
      root.dataset.ticks = String(ticks);
      root.dataset.beeps = String(beeps);
      scheduleTick();
    }, fb.intervalMs);
  }

  function savePrefs() {
    prefs.set(PREFS_KEY, { haptics });
  }

  function setHunt(on) {
    hunt = !!on;
    if (!hunt) {
      sound = false;
      beeper.suspend();
    }
    // caçando, a pessoa anda olhando a tela sem tocar nela: o celular não pode apagar
    bridge.keepAwake(hunt).catch(() => {});
    scheduleTick();
    renderNow();
  }

  async function setSound(on) {
    if (!on) {
      sound = false;
      beeper.suspend();
      scheduleTick();
      renderNow();
      return;
    }
    soundPending = true;
    const ok = await beeper.enable();
    soundPending = false;
    if (!alive) return;
    sound = ok && hunt;
    if (!ok) toast('Não foi possível ligar o som neste aparelho. A vibração continua funcionando.');
    scheduleTick();
    renderNow();
  }

  function setHaptics(on) {
    haptics = !!on;
    savePrefs();
    if (haptics) bridge.vibrate(20).catch(() => {});
    scheduleTick();
    renderNow();
  }

  // --- distância por Wi-Fi RTT ----------------------------------------------------------------

  async function measureRtt() {
    const t = resolve();
    if (!t.bssid || rtt.status === 'running') return;
    const token = ++rttToken;
    const previous = rtt.status === 'done' ? rtt : null;
    rtt = { status: 'running', previous };
    renderNow();
    // a medição leva 1 a 2 s; se o celular nunca responder, a tela não fica presa em "medindo"
    setTimeout(() => {
      if (!alive || token !== rttToken || rtt.status !== 'running') return;
      rttToken += 1;
      rtt = { status: 'error', previous };
      renderNow();
    }, RTT_TIMEOUT_MS);
    try {
      const res = await bridge.rtt([t.bssid]);
      if (!alive || token !== rttToken) return;
      const list = res && Array.isArray(res.results) ? res.results : [];
      const hit = list.find((r) => r && normBssid(r.bssid) === t.bssid);
      if (hit && hit.ok === true && isNum(hit.distM)) {
        rtt = { status: 'done', distM: Math.max(0, hit.distM), stdM: isNum(hit.stdM) ? Math.abs(hit.stdM) : null, at: Date.now(), bySignal: indoorDistance(smoothNow(), t.freq) };
      } else {
        rtt = { status: 'failed', previous };
      }
    } catch {
      if (!alive || token !== rttToken) return;
      rtt = { status: 'error', previous };
    }
    renderNow();
  }

  function cancelRtt() {
    if (rtt.status !== 'running') return;
    // a ponte não tem como interromper a medição (ela dura 1 a 2 s): a resposta é só ignorada
    rttToken += 1;
    rtt = rtt.previous || { status: 'idle' };
    renderNow();
  }

  // --- visão ----------------------------------------------------------------------------------

  function cadenceText(state) {
    const sec = Math.round(scanIntervalMs() / 1000);
    return state.loop.throttled ? `≈${THIN}${sec}${THIN}s, porque o Android está limitando as buscas` : `≈${THIN}${sec}${THIN}s`;
  }

  function targetView(t, state, now) {
    if (!t.has) {
      const waiting = state.scan.seq === 0;
      return h(
        'section.card.mtr-pickme',
        { key: 'none' },
        h('span.mtr-pickme__icon', null, waiting ? spinner({ label: 'Buscando redes' }) : icon('target', { size: 28 })),
        h('h2.card__title', null, waiting ? 'Procurando redes…' : 'Qual rede você quer medir?'),
        h('p.card__text', null, waiting ? 'A primeira busca leva alguns segundos.' : 'O celular não está conectado a um Wi-Fi. Escolha uma das redes ao redor para acompanhar o sinal dela.'),
        waiting ? null : button('Escolher rede', { variant: 'primary', icon: 'wifi', onClick: openPicker }),
      );
    }

    const sub = [];
    if (t.live) sub.push(h('span.accent.strong', null, 'Conectada'));
    if (t.ap && t.ap.band) sub.push(h('span', null, fmtBand(t.ap.band)));
    if (t.ap && isNum(t.ap.channel)) sub.push(h('span', null, `Canal ${t.ap.channel}`));
    if (t.ap && t.ap.vendor) sub.push(h('span', null, t.ap.vendor));
    if (!t.ap && !t.live) sub.push(h('span.mono', null, t.bssid));

    let note;
    if (t.live) {
      note = h('p.mtr-note', { key: 'note' }, icon('bolt', { size: 16 }), h('span', null, 'Leitura ao vivo: é a rede em que o celular está conectado.'));
    } else if (!t.ap) {
      note = h(
        'p.mtr-note.mtr-note--warn',
        { key: 'note' },
        icon('warning', { size: 16 }),
        h('span', null, 'Esta rede não apareceu nas últimas buscas. Chegue mais perto dela ou escolha outra.'),
      );
    } else {
      const old = t.ap.stale && current ? ` A última leitura é de ${fmtAgo(now - current.at)}.` : '';
      note = h(
        'p.mtr-note',
        { key: 'note' },
        icon('clock', { size: 16 }),
        h('span', null, `Esta rede só é lida a cada busca (${cadenceText(state)}).${old} Para leitura ao vivo, conecte o celular a ela.`),
      );
    }

    return h(
      'section.card.card--flush',
      { key: 'target' },
      h(
        'button.row.row--tappable.mtr-target__row',
        { type: 'button', 'aria-label': `Medindo ${t.ssid || (t.ap || t.live ? 'rede oculta' : 'uma rede fora de alcance')}. Trocar de rede`, onClick: openPicker },
        h('span.row__lead', null, signalBars(current ? current.rssi : null)),
        h(
          'span.row__body',
          null,
          h(
            'span.row__title',
            null,
            // um BSSID que o app nunca ouviu não tem nome para mostrar (e não é "rede oculta")
            t.ap || t.live ? ssidLabel(t.ssid) : h('span.ssid.ssid--hidden', null, 'Rede fora de alcance'),
            t.ap && t.ap.favorite ? icon('star-filled', { size: 16, label: 'Minha rede', class: 'accent' }) : null,
          ),
          h('span.row__sub.row__sub--clip', null, sub),
        ),
        h('span.row__trail', null, h('span.accent.strong', null, 'Trocar'), icon('chevron-right', { size: 20 })),
      ),
      note,
    );
  }

  function metaView(t, value) {
    if (!isNum(value)) {
      const text = !t.has ? 'Escolha uma rede para começar.' : t.live ? 'Aguardando a primeira leitura…' : 'Aguardando esta rede aparecer numa busca…';
      return [h('span.mtr-meta__empty', { key: 'empty' }, text)];
    }
    const dist = indoorDistance(smoothNow() ?? value, t.freq);
    return [
      h('span.mtr-meta__item', { key: 'q' }, h('span.mtr-meta__label', null, 'Qualidade'), h('strong', { dataset: { field: 'quality' } }, fmtPct(qualityPct(value)))),
      isNum(dist)
        ? h(
            'span.mtr-meta__item',
            { key: 'd', title: 'Estimativa pelo sinal: paredes mudam bastante o resultado' },
            h('span.mtr-meta__label', null, 'Distância (estimativa)'),
            h('strong', { dataset: { field: 'distance' } }, fmtMeters(dist, { approx: true })),
          )
        : null,
    ];
  }

  function statCell(label, value, extra, mark) {
    return h(
      'div.mtr-stat',
      { key: label },
      h('span.mtr-stat__label', null, mark ? h('i.mtr-peakmark', { 'aria-hidden': 'true' }) : null, label),
      h('span', { class: ['mtr-stat__value', !isNum(value) && 'mtr-stat__value--empty'] }, isNum(value) ? fmtDbm(value, { unit: false }) : '—', isNum(value) ? h('span.mtr-stat__unit', null, 'dBm') : null),
      h('span.mtr-stat__extra', null, extra || '\u00a0'),
    );
  }

  function statsView(now) {
    const s = stats.get();
    const peakAge = isNum(s.maxAt) ? now - s.maxAt : null;
    return [
      h(
        'div.mtr-stats__head',
        { key: 'head' },
        h('h3.mtr-stats__title', null, 'Nesta medição'),
        button('Zerar', { variant: 'quiet', small: true, icon: 'undo', disabled: s.count === 0, onClick: resetStats }),
      ),
      h(
        'div.mtr-stats',
        { key: 'grid' },
        statCell('Mínimo', s.min),
        statCell('Média', s.avg),
        statCell('Máximo', s.max, isNum(peakAge) && peakAge >= 3000 ? fmtAgo(peakAge) : isNum(s.max) ? 'agora' : null, true),
      ),
    ];
  }

  function resetStats() {
    stats.reset();
    if (current && hasFreshReading(resolve(), Date.now())) stats.add(current.rssi, Date.now());
    renderNow();
  }

  function trendNow(t, now) {
    // 2,5 dB em 5 s: abaixo disso é o vaivém normal do sinal com o celular parado
    if (t.live) return trendOf(samples, { now, windowMs: 5000, minDeltaDb: 2.5, minPoints: 4 });
    const windowMs = Math.max(20_000, scanIntervalMs() * 3.5);
    return trendOf(samples, { now, windowMs, minDeltaDb: 3, minPoints: 2, minSpanMs: 1000 });
  }

  function trendText(trend, t) {
    const sec = Math.max(1, Math.round(trend.spanMs / 1000));
    const delta = isNum(trend.deltaDb) ? fmtNum(Math.abs(trend.deltaDb)) : '';
    if (trend.state === 'closer') return `Esquentando: o sinal subiu ${delta}${THIN}dB em ${sec}${THIN}s. Continue nessa direção.`;
    if (trend.state === 'farther') return `Esfriando: o sinal caiu ${delta}${THIN}dB em ${sec}${THIN}s. Tente outro caminho.`;
    if (trend.state === 'steady') return 'O sinal quase não mudou. Ande alguns passos para sentir a direção.';
    return t.live ? 'Juntando as primeiras leituras.' : 'Preciso de duas buscas seguidas para comparar. Ande devagar.';
  }

  function huntView(t, now) {
    const fresh = hasFreshReading(t, now);
    const trend = hunt && fresh ? trendNow(t, now) : { state: 'unknown', deltaDb: null, spanMs: 0 };
    root.dataset.trend = hunt ? trend.state : '';
    const heat = heatOf(fresh ? smoothNow() : null);
    const look = TREND[trend.state];

    const panel = hunt
      ? h(
          'div.mtr-hunt',
          { key: 'panel' },
          !t.has
            ? banner({ key: 'b', tone: 'neutral', text: 'Escolha uma rede para começar a caça.' })
            : !fresh
              ? banner({ key: 'b', tone: 'warning', text: t.live ? 'Sem leituras novas do sinal. Confira se o Wi-Fi continua conectado.' : 'Esta rede não foi ouvida nas últimas buscas. Chegue mais perto ou escolha outra.' })
              : null,
          // para leitores de tela só a mudança de direção é anunciada (os números mudam o tempo todo)
          h('span.sr-only', { key: 'say', role: 'status', 'aria-live': 'polite' }, trend.state === 'unknown' ? '' : look.title),
          h(
            'div.mtr-trend',
            { key: 'trend', dataset: { trend: trend.state } },
            h('span.mtr-trend__icon', null, icon(look.icon, { size: 28 })),
            h('div.mtr-trend__body', null, h('strong.mtr-trend__title', null, look.title), h('span.mtr-trend__text', null, fresh || !t.has ? trendText(trend, t) : 'Aguardando o sinal voltar.')),
          ),
          h(
            'div.mtr-heat',
            { key: 'heat', dataset: { level: heat.level }, role: 'img', 'aria-label': `Temperatura da caça: ${heat.label}` },
            h('div.mtr-heat__scale', null, h('span', null, 'frio'), h('div.mtr-heat__bar', null, [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= heat.level ? 'on' : null }))), h('span', null, 'quente')),
            h('p.mtr-heat__text', null, h('strong', null, heat.label), heat.level ? ` · ${heat.text}` : ''),
          ),
          !t.live && t.has
            ? h('p.mtr-note', { key: 'slow' }, icon('clock', { size: 16 }), h('span', null, 'Sem leitura ao vivo, a caça é lenta: pare alguns segundos em cada ponto, até chegar uma busca nova.'))
            : null,
        )
      : null;

    return h(
      'section.card.card--flush.list',
      { key: 'hunt' },
      switchRow({
        key: 'hunt-switch',
        icon: 'radar',
        title: 'Caça-roteador',
        subtitle: 'Quente ou frio: ande e veja se está chegando perto',
        checked: hunt,
        onChange: setHunt,
      }),
      panel,
      hunt
        ? switchRow({
            key: 'sound',
            icon: sound ? 'volume' : 'volume-off',
            title: 'Bipes',
            subtitle: beeper.available ? 'Mais rápidos e agudos perto do roteador' : 'Som indisponível neste aparelho',
            checked: sound || soundPending,
            disabled: !beeper.available,
            onChange: setSound,
          })
        : null,
      hunt
        ? switchRow({
            key: 'haptics',
            icon: 'phone',
            title: 'Vibração',
            subtitle: 'Toques que aceleram perto do roteador',
            checked: haptics,
            onChange: setHaptics,
          })
        : null,
    );
  }

  function rttView(t, state) {
    const can = !!(state.info && state.info.rtt === true && t.ap && t.ap.rttResponder === true);
    if (!can) return null;
    const running = rtt.status === 'running';
    const shown = rtt.status === 'done' ? rtt : rtt.previous || null;

    let result = null;
    if (shown && shown.status === 'done') {
      const near = shown.distM < 0.5;
      result = h(
        'div.mtr-rtt__result',
        { key: 'result', dataset: { dist: shown.distM } },
        h('span.mtr-rtt__value', null, near ? `menos de 0,5${THIN}m` : fmtMeters(shown.distM)),
        !near && isNum(shown.stdM) && shown.stdM > 0 ? h('span.mtr-rtt__err', null, `±${THIN}${fmtMeters(Math.max(0.1, shown.stdM))}`) : null,
        h(
          'span.mtr-rtt__when',
          null,
          `Medido ${fmtAgo(Date.now() - shown.at)}`,
          isNum(shown.bySignal) ? ` · pelo sinal a estimativa era ${fmtMeters(shown.bySignal, { approx: true })}` : '',
        ),
      );
    }
    let problem = null;
    if (rtt.status === 'failed') problem = 'O roteador não respondeu à medição. Chegue mais perto dele e tente de novo.';
    if (rtt.status === 'error') problem = 'Não foi possível medir agora. Tente de novo em instantes.';

    return h(
      'section.card.mtr-rtt',
      { key: 'rtt' },
      h('h3.card__title', null, 'Distância medida (Wi-Fi RTT)'),
      h('p.card__text', null, 'Este roteador e o seu celular sabem medir a distância pelo tempo que o sinal leva para ir e voltar. É bem mais confiável que a estimativa pelo sinal, com erro típico de 1 a 2 metros.'),
      result,
      problem ? banner({ key: 'problem', tone: 'warning', text: problem }) : null,
      running
        ? h('div.mtr-rtt__busy', { key: 'busy', role: 'status' }, spinner(), h('span', null, 'Medindo…'), button('Cancelar', { variant: 'quiet', small: true, onClick: cancelRtt }))
        : button(shown ? 'Medir de novo' : 'Medir distância real', { key: 'go', variant: 'primary', icon: 'ruler', block: true, onClick: measureRtt }),
    );
  }

  function pickerView() {
    const state = store.get();
    const t = resolve(state);
    const conn = t.conn;
    return [
      h(
        'div.card.card--flush.list',
        { key: 'follow' },
        listRow({
          key: 'follow',
          icon: 'link',
          title: 'Rede conectada',
          subtitle: conn ? 'Leitura ao vivo; acompanha o celular' : 'O celular não está conectado agora',
          trail: t.follow ? h('span.accent', null, icon('check', { label: 'Selecionada' })) : null,
          onClick: () => setTarget(''),
        }),
      ),
      h('p.mtr-pick__hint', { key: 'hint' }, `As outras redes só mudam a cada busca (${cadenceText(state)}).`),
      state.aps.length
        ? h(
            'div.card.card--flush.list',
            { key: 'list' },
            state.aps.map((ap) =>
              h(
                'div.mtr-pick',
                { key: ap.bssid, class: !t.follow && ap.bssid === t.bssid ? 'mtr-pick--on' : null, dataset: { bssid: ap.bssid } },
                apRow(ap, { onClick: () => setTarget(ap.bssid) }),
              ),
            ),
          )
        : h('p.t-sm.muted.center', { key: 'empty' }, state.scan.seq === 0 ? 'Procurando redes…' : 'Nenhuma rede ao alcance agora.'),
    ];
  }

  function openPicker() {
    if (picker && picker.isOpen()) return;
    picker = sheet({
      title: 'Qual rede medir?',
      subtitle: 'Cada linha é um roteador (ou um rádio dele)',
      tall: true,
      content: pickerView(),
      onClose: () => {
        picker = null;
      },
    });
  }

  // --- desenho --------------------------------------------------------------------------------

  let renderTimer = null;
  let lastRender = 0;

  function requestRender() {
    if (!alive || renderTimer !== null) return;
    const wait = Math.max(0, RENDER_MIN_MS - (performance.now() - lastRender));
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderNow();
    }, wait);
  }

  function renderNow() {
    if (!alive) return;
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    lastRender = performance.now();
    const state = store.get();
    const now = Date.now();
    const t = resolve(state);

    // janela: o que ficou para trás dela não interessa mais
    const windowMs = t.live ? LIVE_WINDOW_MS : SCAN_WINDOW_MS;
    const from = now - SCAN_WINDOW_MS - 5000;
    if (samples.length && samples[0].t < from) samples = samples.filter((s) => s.t >= from);

    const fresh = hasFreshReading(t, now);
    const value = current && (fresh || (!t.live && t.ap)) ? current.rssi : null;
    const level = signalLevel(value);
    const s = stats.get();

    root.dataset.target = t.bssid;
    root.dataset.live = t.live ? '1' : '';
    root.dataset.samples = String(s.count);
    root.dataset.rssi = isNum(value) ? String(value) : '';

    patch(targetHost, targetView(t, state, now));
    gauge.set(value, { peak: isNum(value) ? s.max : null, label: isNum(value) ? level.label : 'Sem leitura' });
    patch(metaHost, metaView(t, value));
    patch(statsHost, statsView(now));

    chart.set({ points: samples, windowMs, gapMs: gapFor(t), now });
    patch(
      chartHead,
      h('h3.mtr-chart__title', null, 'Sinal ao longo do tempo'),
      h('span.mtr-chart__window', null, t.live ? `últimos 60${THIN}s` : `últimos 2${THIN}min`),
    );

    patch(huntHost, huntView(t, now));
    patch(rttHost, rttView(t, state));
  }

  // --- ligações -------------------------------------------------------------------------------

  const offs = [
    store.subscribe((s) => s.rssi, onRssi),
    store.subscribe((s) => s.scan.seq, onScan),
    store.subscribe((s) => s.connection, refresh),
    store.subscribe((s) => s.aps, requestRender),
    store.subscribe((s) => s.loop.intervalMs, requestRender),
    store.subscribe((s) => s.loop.throttled, requestRender),
    store.subscribe((s) => s.info, requestRender),
    store.subscribe(
      (s) => s.backend,
      () => {
        refresh();
        // quem passou a responder (celular ou demonstração) começa em 1 leitura por segundo:
        // pede de novo o ritmo rápido, depois de o app terminar a troca
        setTimeout(() => alive && bridge.watchRssi(250).catch(() => {}), 400);
      },
    ),
  ];

  // idade das leituras, "há X s" e a tendência andam mesmo sem leitura nova
  const clock = setInterval(() => {
    if (document.hidden) return;
    requestRender();
    if (tickTimer === null) scheduleTick();
  }, 1000);

  const onVisible = () => {
    if (document.hidden) {
      clearTimeout(tickTimer);
      tickTimer = null;
      beeper.suspend();
      return;
    }
    requestRender();
    if (!sound) {
      scheduleTick();
      return;
    }
    // de volta ao app: o áudio precisa ser religado (alguns aparelhos pedem outro toque)
    beeper.enable().then((ok) => {
      if (!alive) return;
      if (!ok) sound = false;
      scheduleTick();
      renderNow();
    });
  };
  document.addEventListener('visibilitychange', onVisible);

  bridge.watchRssi(250).catch(() => {});
  restart();
  renderNow();

  return {
    onRoute(route) {
      const next = normBssid(route.query.get('bssid'));
      if (next && next !== pinned) setTarget(next);
    },
    unmount() {
      alive = false;
      for (const off of offs) off();
      clearInterval(clock);
      clearTimeout(tickTimer);
      clearTimeout(renderTimer);
      document.removeEventListener('visibilitychange', onVisible);
      rttToken += 1;
      if (picker) picker.close();
      if (hunt) bridge.keepAwake(false).catch(() => {});
      beeper.close();
      gauge.destroy();
      chart.destroy();
      // devolve o ritmo normal das leituras do sinal (o modo das buscas quem devolve é o roteador)
      bridge.watchRssi(1000).catch(() => {});
    },
  };
}
