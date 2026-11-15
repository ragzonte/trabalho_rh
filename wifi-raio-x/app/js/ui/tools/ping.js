// Latência (ping): quanto tempo um pacote leva para ir até um destino e voltar.
//
// Destinos prontos (o roteador da casa, dois endereços na internet, um site) ou um endereço
// digitado, conferido com a mesma regra do celular (net-logic.js). Durante a medição cada
// resposta vira uma barra no gráfico; no fim saem as estatísticas e um veredito em palavras
// simples. Tudo o que foi medido nesta sessão fica numa lista (só na memória).
//
// Detalhes que a tela respeita:
//   - o celular só avisa as respostas PERDIDAS no fim da série: até lá, um buraco no meio das
//     respostas aparece como "sem resposta até agora" e pode ser preenchido por uma atrasada;
//   - quando o destino ignora o ping comum, o celular repete a série medindo uma conexão TCP
//     (as respostas chegam de novo com os mesmos números de sequência);
//   - sair da tela cancela a medição (bridge.cancel('ping')); ao voltar, o resultado parcial
//     está lá, marcado como interrompido;
//   - #/ferramentas/ping?host=192.168.0.7 abre já medindo aquele endereço (usado pela tela
//     de dispositivos).

import { h, patch, sheet, cssVar, listen, fmtNum, fmtMs, fmtPct, fmtClock, THIN, NO_VALUE } from '../dom.js';
import { icon } from '../icons.js';
import { button, segmented, banner, statTile, sectionHeader, spinner, badge, textField } from '../components.js';
import { parseHostInput, isIpv4, pingStats, pingVerdict, whereIsTheDelay, niceAxis } from './net-logic.js';

const TIMEOUT_MS = 1000;
/** O celular envia um pacote a cada 0,2 s (o menor intervalo que o Android aceita). */
const INTERVAL_MS = 200;
const HISTORY_MAX = 12;
const SITE_HOST = 'google.com';

const DURATIONS = [
  { value: 10, label: 'Curto' },
  { value: 25, label: 'Normal' },
  { value: 50, label: 'Longo' },
];

const LEVEL_BADGE = {
  great: ['Ótimo', 'good'],
  good: ['Bom', 'good'],
  fair: ['Regular', 'warning'],
  poor: ['Ruim', 'critical'],
  none: ['Sem resposta', 'critical'],
};

// O que foi medido desde que o app abriu. Fica no módulo para sobreviver a sair e voltar da tela.
const session = {
  backend: null, // 'native' | 'sim': trocar de modo zera a sessão
  targetId: 'gateway',
  custom: '',
  count: 25,
  seq: 0,
  current: null, // a medição que está na tela
  runs: [], // concluídas, a mais recente primeiro
  pending: null, // Promise da medição em andamento
  pendingRun: null, // a medição que essa Promise vai fechar
  onChange: null, // a tela montada agora (se houver) pede para ser avisada
};

/** Fecha as contas de uma medição que terminou (ou foi interrompida). Vale mesmo sem tela montada. */
function finishRun(run, summary) {
  if (session.pendingRun === run) {
    session.pending = null;
    session.pendingRun = null;
  }
  const s = summary && typeof summary === 'object' ? summary : {};
  run.endedAt = Date.now();
  run.state = run.cancelRequested ? 'cancelled' : 'done';
  // o resumo do celular é o que vale; se vier incompleto, as contas saem das respostas recebidas
  const fallback = pingStats(repliesOf(run), run.maxSeq);
  run.summary = typeof s.sent === 'number' && typeof s.received === 'number' ? { ...fallback, ...s } : fallback;
  run.method = s.method === 'tcp' ? 'tcp' : 'icmp';
  if (run.summary.sent > 0) session.runs = [run, ...session.runs.filter((r) => r !== run)].slice(0, HISTORY_MAX);
  if (session.onChange) session.onChange();
}

function failRun(run, err) {
  if (session.pendingRun === run) {
    session.pending = null;
    session.pendingRun = null;
  }
  const message = String((err && err.message) || err || '');
  run.endedAt = Date.now();
  run.state = 'error';
  if (/host não encontrado/i.test(message)) run.error = 'not-found';
  else if (/host inválido/i.test(message)) run.error = 'invalid';
  else run.error = 'failed';
  if (session.onChange) session.onChange();
}

const repliesOf = (run) => [...run.replies].map(([seq, r]) => ({ seq, ...r }));

// ---------------------------------------------------------------------------
// Folha de estilos das ferramentas de rede (carregada uma vez)
// ---------------------------------------------------------------------------

const STYLE_ID = 'wrx-tools-b-css';

function ensureStyles() {
  let link = document.getElementById(STYLE_ID);
  if (!link) {
    link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = new URL('../../../css/tools-b.css', import.meta.url).href;
    link.__ready = new Promise((resolve) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 1500); // nunca segura a tela por causa do estilo
    });
    document.head.appendChild(link);
  }
  return link.__ready || Promise.resolve();
}

// ---------------------------------------------------------------------------
// Gráfico das respostas (canvas)
// ---------------------------------------------------------------------------

const CHART_H = 172;

/**
 * Barras das respostas de uma série: x = número do pacote, y = tempo em ms; perdas marcadas com ×.
 * @param {HTMLElement} host  elemento com largura definida (o canvas ocupa tudo)
 * @param {(seq:number|null) => void} onSelect  o usuário tocou numa barra
 */
function createPingChart(host, onSelect) {
  const canvas = h('canvas.tb-chart__canvas', { role: 'img', tabIndex: 0, 'aria-label': 'Gráfico das respostas' });
  host.appendChild(canvas);
  const g = canvas.getContext('2d');
  let colors = null;
  let model = null; // {count, replies: Map, maxSeq, running, avg}
  let selected = null;
  let width = 0;
  let frame = 0;
  let geometry = null;

  function readColors() {
    colors = {
      bar: cssVar('--accent'),
      lost: cssVar('--critical'),
      lostSoft: cssVar('--critical-soft'),
      grid: cssVar('--chart-grid'),
      axis: cssVar('--chart-axis'),
      label: cssVar('--chart-label'),
      text: cssVar('--text'),
      muted: cssVar('--muted'),
      surface: cssVar('--surface'),
      font: cssVar('--font') || 'system-ui, sans-serif',
    };
  }

  function resize() {
    const w = Math.floor(host.clientWidth);
    if (w <= 0) return false;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (w !== width || canvas.width !== Math.round(w * dpr)) {
      width = w;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(CHART_H * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${CHART_H}px`;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function draw() {
    frame = 0;
    if (!model || !resize()) return;
    if (!colors) readColors();
    const c = colors;
    g.clearRect(0, 0, width, CHART_H);

    let maxMs = 0;
    for (const r of model.replies.values()) if (r.ok && r.ms > maxMs) maxMs = r.ms;
    const axis = niceAxis(Math.max(maxMs * 1.08, 4), 3);
    const topLabel = `${fmtNum(axis.max, axis.max < 10 && axis.max % 1 ? 1 : 0)}${THIN}ms`;

    g.font = `12px ${c.font}`;
    const left = Math.ceil(Math.max(30, g.measureText(topLabel).width + 8));
    const right = 6;
    const top = 12;
    const bottom = 24;
    const plotW = width - left - right;
    const plotH = CHART_H - top - bottom;
    const baseY = top + plotH;
    const slot = plotW / model.count;
    const barW = Math.max(2, Math.min(14, Math.floor(slot - 2)));
    const xOf = (seq) => left + (seq - 0.5) * slot;
    const yOf = (v) => baseY - (Math.min(v, axis.max) / axis.max) * plotH;
    geometry = { left, slot, count: model.count };

    // grade e eixo y (rótulo com a unidade só no topo)
    g.lineWidth = 1;
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (const tick of axis.ticks) {
      const y = Math.round(yOf(tick)) + 0.5;
      g.strokeStyle = tick === 0 ? c.axis : c.grid;
      g.beginPath();
      g.moveTo(left, y);
      g.lineTo(width - right, y);
      g.stroke();
      g.fillStyle = c.label;
      const text = tick === axis.max ? topLabel : fmtNum(tick, axis.step < 1 ? 1 : axis.step % 1 ? 1 : 0);
      g.fillText(text, left - 6, tick === axis.max ? y + 1 : y);
    }

    // eixo x: 1, depois de 5 em 5 (ou de 10 em 10), e o último
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = c.label;
    const step = model.count <= 10 ? 1 : model.count <= 25 ? 5 : 10;
    for (let seq = 1; seq <= model.count; seq++) {
      if (seq !== 1 && seq % step !== 0) continue;
      g.fillText(String(seq), xOf(seq), baseY + 6);
    }

    // barras e perdas
    const dim = selected !== null;
    for (let seq = 1; seq <= model.count; seq++) {
      const r = model.replies.get(seq);
      const x = xOf(seq);
      const isSel = selected === seq;
      if (r && r.ok) {
        const y = Math.min(yOf(r.ms), baseY - 2);
        const radius = Math.min(3, barW / 2);
        g.globalAlpha = dim && !isSel ? 0.45 : 1;
        g.fillStyle = c.bar;
        g.beginPath();
        g.moveTo(x - barW / 2, baseY);
        g.lineTo(x - barW / 2, y + radius);
        g.quadraticCurveTo(x - barW / 2, y, x - barW / 2 + radius, y);
        g.lineTo(x + barW / 2 - radius, y);
        g.quadraticCurveTo(x + barW / 2, y, x + barW / 2, y + radius);
        g.lineTo(x + barW / 2, baseY);
        g.closePath();
        g.fill();
        g.globalAlpha = 1;
      } else if ((r && !r.ok) || seq < model.maxSeq) {
        // perdida (confirmada) ou ainda sem resposta com outras mais novas já de volta
        const confirmed = !!r;
        g.globalAlpha = (confirmed ? 1 : 0.55) * (dim && !isSel ? 0.5 : 1);
        g.fillStyle = c.lostSoft;
        g.fillRect(x - barW / 2, top, barW, plotH);
        const k = Math.max(2.5, Math.min(4.5, slot * 0.32));
        const cy = baseY - k - 4;
        g.strokeStyle = c.lost;
        g.lineWidth = 1.75;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x - k, cy - k);
        g.lineTo(x + k, cy + k);
        g.moveTo(x + k, cy - k);
        g.lineTo(x - k, cy + k);
        g.stroke();
        g.globalAlpha = 1;
        g.lineWidth = 1;
      }
    }

    // linha da média (o valor vai escrito na legenda, fora do gráfico, para não cobrir as barras)
    if (isFinite(model.avg) && model.received >= 2) {
      const y = Math.round(yOf(model.avg)) + 0.5;
      g.strokeStyle = c.text;
      g.globalAlpha = 0.75;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(left, y);
      g.lineTo(width - right, y);
      g.stroke();
      g.globalAlpha = 1;
      g.lineWidth = 1;
    }

    // marca do item escolhido no eixo x
    if (selected !== null && selected <= model.count) {
      g.fillStyle = c.text;
      const x = xOf(selected);
      g.beginPath();
      g.moveTo(x - 4, baseY + 5);
      g.lineTo(x + 4, baseY + 5);
      g.lineTo(x, baseY + 1);
      g.closePath();
      g.fill();
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function seqAt(clientX) {
    if (!geometry || !model) return null;
    const rect = canvas.getBoundingClientRect();
    const seq = Math.floor((clientX - rect.left - geometry.left) / geometry.slot) + 1;
    return Math.max(1, Math.min(geometry.count, seq));
  }

  const pick = (seq) => {
    if (seq === selected) return;
    selected = seq;
    schedule();
    onSelect(seq);
  };

  const offs = [
    listen(canvas, 'pointerdown', (ev) => pick(seqAt(ev.clientX))),
    // dedo arrastando ou mouse passando por cima: a medida debaixo do ponteiro é a escolhida
    listen(canvas, 'pointermove', (ev) => pick(seqAt(ev.clientX))),
    listen(canvas, 'pointerleave', (ev) => {
      if (ev.pointerType === 'mouse') pick(null);
    }),
    listen(canvas, 'keydown', (ev) => {
      if (!model) return;
      const dir = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (ev.key === 'Escape' && selected !== null) {
        ev.stopPropagation();
        pick(null);
        return;
      }
      if (!dir) return;
      ev.preventDefault();
      const last = Math.max(1, Math.min(model.count, model.maxSeq || 1));
      pick(Math.max(1, Math.min(last, (selected ?? (dir > 0 ? 0 : last + 1)) + dir)));
    }),
  ];
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  if (observer) observer.observe(host);
  else offs.push(listen(window, 'resize', schedule));

  return {
    /** @param {object|null} next  {count, replies, maxSeq, received, avg} @param {string} label  descrição para leitor de tela */
    update(next, label) {
      model = next;
      if (label) canvas.setAttribute('aria-label', label);
      schedule();
    },
    select(seq) {
      selected = seq;
      schedule();
    },
    themeChanged() {
      colors = null;
      schedule();
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (observer) observer.disconnect();
      for (const off of offs) off();
      canvas.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

/** Valor e unidade de um tempo para um número em destaque; sem dado, só o travessão. */
const msTile = (v) => (typeof v === 'number' && Number.isFinite(v) ? { value: fmtNum(v, v < 9.95 ? 1 : 0), unit: 'ms' } : { value: NO_VALUE });

function isPrivateIpv4(host) {
  if (!isIpv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function openHelp() {
  sheet({
    title: 'Entenda os números',
    content: h(
      'div.prose',
      null,
      h('p', null, h('strong', null, 'Latência (ping)'), ' é o tempo que um pacotinho de dados leva para ir até o destino e voltar, em milissegundos (ms). Quanto menor, mais “na hora” tudo responde.'),
      h('p', null, h('strong', null, 'Variação (jitter)'), ' é quanto esse tempo muda de uma resposta para a seguinte. Variação alta deixa a voz picotada e a imagem travando em chamadas.'),
      h('p', null, h('strong', null, 'Perda'), ' são os pacotes que não voltaram. Acima de 1 ou 2% já dá para notar em chamadas e jogos.'),
      h(
        'ul',
        null,
        h('li', null, 'Até a internet: menos de 35', THIN, 'ms é ótimo, até 70', THIN, 'ms é bom, acima de 150', THIN, 'ms atrapalha chamadas.'),
        h('li', null, 'Até o roteador: o normal é ficar abaixo de 10', THIN, 'ms. Se já demora ali, o problema é o Wi-Fi, não a internet.'),
      ),
      h('p', null, 'O teste envia pacotes bem pequenos, um a cada 0,2 segundo: não gasta quase nada de dados. Alguns destinos ignoram o ping comum; nesses casos o app mede o tempo de abrir uma conexão, que é um pouco maior.'),
    ),
  });
}

export async function mount(root, ctx) {
  const { store, bridge } = ctx;
  await ensureStyles();
  root.classList.add('tb');

  let alive = true;
  let chart = null;
  let chartHost = null;
  let selectedSeq = null;
  let fieldTouched = false;
  let starting = false;
  let frame = 0;
  let ticker = 0;
  const cleanups = [];

  // trocar de celular de verdade para a demonstração (ou o contrário) começa uma sessão nova
  function syncBackend() {
    const backend = store.get().backend;
    if (session.backend === backend) return;
    session.backend = backend;
    session.current = null;
    session.runs = [];
  }
  syncBackend();

  // --- destinos ---------------------------------------------------------------------------

  const gatewayHost = () => {
    const conn = store.get().connection;
    return conn && conn.connected && typeof conn.gateway === 'string' && parseHostInput(conn.gateway).host ? conn.gateway : null;
  };

  function presets() {
    const gw = gatewayHost();
    return [
      {
        id: 'gateway',
        kind: 'gateway',
        label: 'Roteador',
        host: gw,
        disabled: !gw,
        note: gw ? 'Mede só o trecho entre o celular e o roteador, ou seja, o seu Wi-Fi.' : 'Conecte-se a um Wi-Fi para medir o roteador.',
      },
      { id: 'internet', kind: 'internet', label: 'Internet', host: '1.1.1.1', who: 'Cloudflare', note: 'Mede o Wi-Fi mais o caminho pela internet do provedor.' },
      { id: 'internet2', kind: 'internet', label: 'Internet 2', host: '8.8.8.8', who: 'Google', note: 'Um segundo destino na internet, para confirmar o resultado.' },
      { id: 'site', kind: 'internet', label: 'Site', host: SITE_HOST, note: 'Como abrir um site: inclui descobrir o endereço pelo nome (DNS).' },
      { id: 'custom', kind: 'other', label: 'Outro', host: null, note: null },
    ];
  }

  function selectedPreset() {
    const list = presets();
    let found = list.find((p) => p.id === session.targetId) || list[0];
    if (found.disabled) found = list[1];
    return found;
  }

  /** O destino a medir agora, ou null (com o erro à vista no campo) se o endereço digitado não serve. */
  function resolveTarget() {
    const preset = selectedPreset();
    if (preset.id !== 'custom') return { id: preset.id, kind: preset.kind, label: preset.label, host: preset.host };
    const parsed = parseHostInput(session.custom);
    if (!parsed.host) return null;
    const gw = gatewayHost();
    const kind = gw && parsed.host === gw ? 'gateway' : isPrivateIpv4(parsed.host) ? 'lan' : 'other';
    return { id: 'custom', kind, label: parsed.host, host: parsed.host };
  }

  // --- medição ----------------------------------------------------------------------------

  /** Cancela a medição em andamento (se houver) e espera o celular devolver o resumo parcial. */
  async function stopRunning() {
    const run = session.pendingRun;
    if (!session.pending || !run) return;
    run.cancelRequested = true;
    try {
      await bridge.cancel('ping');
    } catch {
      // sem cancelamento a série termina sozinha em poucos segundos
    }
    await session.pending;
  }

  async function start() {
    fieldTouched = true;
    const target = resolveTarget();
    if (!target) {
      schedule();
      const input = root.querySelector('.tb-host input');
      if (input) input.focus();
      return;
    }
    // dois toques seguidos (ou um toque durante a espera do cancelamento) contam como um só
    if (starting) return;
    starting = true;
    try {
      await stopRunning();
    } finally {
      starting = false;
    }
    if (!alive) return;
    const run = {
      id: ++session.seq,
      target,
      count: session.count,
      startedAt: Date.now(),
      endedAt: null,
      state: 'running',
      replies: new Map(), // seq -> {ok, ms}
      maxSeq: 0,
      summary: null,
      method: 'icmp',
      error: null,
      cancelRequested: false,
    };
    session.current = run;
    selectedSeq = null;
    if (chart) chart.select(null);
    session.pendingRun = run;
    session.pending = bridge.ping(target.host, run.count, TIMEOUT_MS).then(
      (summary) => finishRun(run, summary),
      (err) => failRun(run, err),
    );
    startTicker();
    drawNow();
    const card = root.querySelector('.tb-result');
    if (card && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest' });
  }

  function stop() {
    const run = session.pendingRun;
    if (!run) return;
    run.cancelRequested = true;
    bridge.cancel('ping').catch(() => {});
    schedule();
  }

  function onReply(reply) {
    const run = session.current;
    if (!run || run.state !== 'running' || !reply || reply.host !== run.target.host) return;
    const seq = reply.seq;
    if (!Number.isInteger(seq) || seq < 1 || seq > run.count) return;
    const before = run.replies.get(seq);
    if (reply.ok && typeof reply.ms === 'number' && reply.ms >= 0) run.replies.set(seq, { ok: true, ms: reply.ms });
    else if (!before) run.replies.set(seq, { ok: false });
    if (reply.ok && seq > run.maxSeq) run.maxSeq = seq;
    schedule();
  }

  // Enquanto mede, o texto "12 de 25" anda mesmo que nenhuma resposta chegue.
  function startTicker() {
    stopTicker();
    ticker = setInterval(schedule, 250);
  }
  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = 0;
  }

  // --- o que mostrar ----------------------------------------------------------------------

  function statsOf(run) {
    if (run.summary) return run.summary;
    return pingStats(repliesOf(run), run.maxSeq);
  }

  /** Quantos pacotes já devem ter saído (pelas respostas e, na falta delas, pelo relógio). */
  function progressOf(run) {
    if (run.state !== 'running') return Math.min(run.count, Math.max(run.maxSeq, run.summary ? run.summary.sent : 0));
    const byClock = Math.floor((Date.now() - run.startedAt) / INTERVAL_MS) + 1;
    return Math.max(run.maxSeq, Math.min(run.count, byClock));
  }

  const targetTitle = (target) => (target.id === 'custom' ? target.host : `${target.label} · ${target.host}`);

  function latestRun(kind) {
    return session.runs.find((r) => r.target.kind === kind && r.summary && r.summary.sent >= 3) || null;
  }

  function setupCard(state) {
    const list = presets();
    const current = selectedPreset();
    const running = !!session.current && session.current.state === 'running';
    const parsed = current.id === 'custom' ? parseHostInput(session.custom) : null;
    const duration = DURATIONS.find((d) => d.value === session.count) || DURATIONS[1];
    const connected = !!(state.connection && state.connection.connected);

    return h(
      'section.card.tb-setup',
      { key: 'setup' },
      h('h2.card__title', { id: 'tb-ping-target' }, 'Medir até onde?'),
      h(
        'div.chips',
        { role: 'radiogroup', 'aria-labelledby': 'tb-ping-target' },
        list.map((p) =>
          h(
            'button.chip',
            {
              key: p.id,
              type: 'button',
              role: 'radio',
              'aria-checked': p.id === current.id,
              disabled: !!p.disabled || running,
              onClick: () => {
                if (session.targetId === p.id) return;
                session.targetId = p.id;
                fieldTouched = false;
                drawNow();
                if (p.id === 'custom') {
                  const input = root.querySelector('.tb-host input');
                  if (input) input.focus();
                }
              },
            },
            p.id === 'gateway' ? icon('router', { size: 16 }) : p.id === 'custom' ? icon('edit', { size: 16 }) : p.id === 'site' ? icon('globe', { size: 16 }) : null,
            p.label,
          ),
        ),
      ),
      current.id === 'custom'
        ? h(
            'div.tb-host',
            {
              key: 'host',
              onKeyDown: (ev) => {
                if (ev.key === 'Enter' && !running) {
                  ev.preventDefault();
                  start();
                }
              },
              onFocusOut: () => {
                if (session.custom.trim() && !fieldTouched) {
                  fieldTouched = true;
                  schedule();
                }
              },
            },
            textField({
              label: 'Site ou endereço IP',
              value: session.custom,
              placeholder: 'exemplo.com.br ou 192.168.0.1',
              inputMode: 'url',
              maxLength: 300,
              error: fieldTouched && parsed && !parsed.host ? parsed.error : undefined,
              hint: parsed && parsed.host && parsed.host !== session.custom.trim() ? `Vamos medir: ${parsed.host}` : 'Pode colar o endereço de um site inteiro: o app usa só o nome.',
              onInput: (text) => {
                session.custom = text;
                schedule();
              },
            }),
          )
        : h(
            'p.tb-note',
            { key: 'note' },
            current.host ? h('span.tb-note__addr.num', null, current.host, current.who ? ` · ${current.who}` : '') : null,
            h('span', null, current.note),
          ),
      !connected && !list[0].host
        ? h('p.tb-note.tb-note--warn', { key: 'offline' }, icon('wifi-off', { size: 16 }), 'Sem Wi-Fi conectado. A medição da internet usa a conexão que o celular tiver.')
        : null,
      h(
        'div.tb-duration',
        { key: 'duration' },
        h(
          'div',
          { class: { 'tb-locked': running } },
          segmented(
            DURATIONS,
            session.count,
            (count) => {
              if (!running) session.count = count;
              schedule();
            },
            { label: 'Duração do teste' },
          ),
        ),
        h('p.tb-caption', null, `${duration.value} medidas, cerca de ${fmtNum(Math.round((duration.value * INTERVAL_MS) / 1000))}${THIN}segundos.`),
      ),
      running
        ? button('Parar', { key: 'stop', variant: 'secondary', icon: 'stop', block: true, onClick: stop, disabled: session.current.cancelRequested })
        : button(session.current && session.current.state !== 'error' && session.runs.length ? 'Medir de novo' : 'Medir latência', { key: 'go', variant: 'primary', icon: 'play', block: true, onClick: start }),
    );
  }

  function readout(run) {
    if (selectedSeq === null) {
      if (run.replies.size) return h('span.muted', null, 'Toque no gráfico para ver cada medida.');
      // vários pacotes já saíram e nada voltou: melhor dizer do que deixar o gráfico vazio sem explicação
      if (run.state === 'running' && progressOf(run) >= 5) return h('span.muted', null, 'Nenhuma resposta até agora. O destino pode estar demorando ou não responder a este teste.');
      return h('span.muted', null, 'Cada barra é uma resposta: quanto mais baixa, mais rápida.');
    }
    const r = run.replies.get(selectedSeq);
    const head = `Medida ${selectedSeq} de ${run.count}: `;
    if (r && r.ok) return h('span', null, head, h('strong.num', null, fmtMs(r.ms)));
    if (r) return h('span', null, head, h('strong.critical', null, 'sem resposta'));
    if (run.state === 'running' && selectedSeq < run.maxSeq) return h('span', null, head, 'sem resposta até agora');
    return h('span.muted', null, head, run.state === 'running' ? 'ainda não enviada' : 'não chegou a ser enviada');
  }

  function resultCard() {
    const run = session.current;
    const chartNode = h('div.tb-chart', {
      key: 'chart',
      keep: true,
      ref: (el) => {
        chartHost = el;
      },
    });
    if (!run) {
      return h(
        'section.card.tb-result',
        { key: 'result' },
        h(
          'div.tb-idle',
          { key: 'idle' },
          h('span.tb-idle__icon', null, icon('ping', { size: 28 })),
          h('p.tb-idle__text', null, 'Escolha um destino e toque em ', h('strong', null, 'Medir latência'), '. Você vê cada resposta chegar: quanto mais baixa a barra, mais rápida a resposta.'),
        ),
        h('div.tb-chartwrap', { key: 'wrap', hidden: true }, chartNode),
      );
    }

    const sent = progressOf(run);
    const avg = statsOf(run).avg;
    let status;
    if (run.state === 'running') status = h('span.tb-run__state', { key: 'st' }, spinner(), h('span.num', null, run.cancelRequested ? 'Parando…' : `${sent} de ${run.count}`));
    else if (run.state === 'done') status = h('span.tb-run__state.muted', { key: 'st' }, icon('check', { size: 16 }), h('span.num', null, `Concluído às ${fmtClock(run.endedAt, { seconds: false })}`));
    else if (run.state === 'cancelled') status = h('span.tb-run__state.muted', { key: 'st' }, icon('stop', { size: 16 }), 'Interrompido');
    else status = h('span.tb-run__state.critical', { key: 'st' }, icon('alert-circle', { size: 16 }), 'Não mediu');

    const errorText =
      run.error === 'not-found'
        ? `Não encontramos “${run.target.host}”. Confira se o nome está certo e se a internet está funcionando.`
        : run.error === 'invalid'
          ? 'O celular não aceitou este endereço. Confira o que foi digitado.'
          : 'Não foi possível medir agora. Tente de novo em instantes.';

    return h(
      'section.card.tb-result',
      { key: 'result' },
      h('div.tb-run', { key: 'head' }, h('h2.tb-run__title.truncate', null, targetTitle(run.target)), status),
      run.state === 'error'
        ? banner({ key: 'err', tone: 'critical', title: 'A medição não começou', text: errorText, actions: [{ label: 'Tentar de novo', onClick: start }] })
        : null,
      h(
        'div.tb-chartwrap',
        { key: 'wrap', hidden: run.state === 'error' },
        chartNode,
        h('p.tb-readout', { 'aria-live': 'polite' }, readout(run)),
        h(
          'div.tb-legend',
          { 'aria-hidden': 'true' },
          h('span.tb-legend__item', null, h('i.tb-legend__bar'), 'resposta (ms)'),
          h('span.tb-legend__item', null, h('i.tb-legend__x', null, '×'), 'sem resposta'),
          typeof avg === 'number' ? h('span.tb-legend__item', null, h('i.tb-legend__line'), `média ${fmtMs(avg)}`) : null,
        ),
      ),
      run.method === 'tcp' && run.state !== 'error'
        ? h('p.tb-note', { key: 'tcp' }, 'Este destino ignora o ping comum: o tempo foi medido abrindo uma conexão, o que demora um pouco mais.')
        : null,
    );
  }

  function resultDetails() {
    const run = session.current;
    if (!run || run.state === 'error') return null;
    const stats = statsOf(run);
    const finished = run.state !== 'running';
    const verdict = finished ? pingVerdict(stats, { target: run.target.kind }) : null;
    const lost = Math.max(0, stats.sent - stats.received);
    const partial = run.state === 'cancelled';

    return [
      verdict && stats.sent > 0
        ? banner({
            key: 'verdict',
            tone: verdict.tone,
            icon: verdict.tone === 'good' ? 'check-circle' : verdict.tone === 'warning' ? 'warning' : verdict.tone === 'critical' ? 'alert-circle' : 'info',
            title: partial ? `${verdict.title} (medição parcial)` : verdict.title,
            text: verdict.text,
          })
        : null,
      partial && stats.sent === 0 ? banner({ key: 'verdict', tone: 'neutral', title: 'Medição interrompida', text: 'Nenhuma resposta tinha chegado ainda.' }) : null,
      sectionHeader('Números', { action: { label: 'Entenda', icon: 'help', onClick: openHelp } }),
      h(
        'div.stats',
        { key: 'stats-main' },
        statTile({ key: 'avg', label: 'Média', ...msTile(stats.avg), hint: stats.sent ? (stats.received === 1 ? 'de 1 resposta' : `de ${stats.received} respostas`) : undefined }),
        statTile({
          key: 'loss',
          label: 'Perda',
          value: stats.sent ? fmtPct(stats.lossPct, stats.lossPct > 0 && stats.lossPct < 10 && stats.lossPct % 1 ? 1 : 0) : NO_VALUE,
          hint: stats.sent ? (lost === 0 ? `nenhuma em ${stats.sent}` : `${lost} de ${stats.sent}${finished ? '' : ' até agora'}`) : undefined,
          tone: lost === 0 ? undefined : stats.lossPct >= 10 ? 'critical' : 'warning',
        }),
      ),
      h(
        'div.stats.stats--3',
        { key: 'stats-more' },
        statTile({ key: 'min', compact: true, label: 'Mínimo', ...msTile(stats.min) }),
        statTile({ key: 'max', compact: true, label: 'Máximo', ...msTile(stats.max) }),
        statTile({ key: 'jit', compact: true, label: 'Variação', ...msTile(stats.jitter) }),
      ),
    ];
  }

  function compareCard() {
    if (session.current && session.current.state === 'running') return null;
    const gw = latestRun('gateway');
    const net = latestRun('internet');
    if (!gw && !net) return null;
    const result = whereIsTheDelay(gw && gw.summary, net && net.summary);
    if (result) {
      return banner({
        key: 'compare',
        tone: result.tone,
        icon: result.where === 'none' ? 'check-circle' : result.where === 'wifi' ? 'wifi' : result.where === 'internet' ? 'globe' : 'info',
        title: result.title,
        text: result.text,
      });
    }
    // só um dos dois lados foi medido: a outra metade responde "é o Wi-Fi ou é a internet?"
    if (net && gatewayHost()) {
      return banner({
        key: 'compare',
        tone: 'neutral',
        icon: 'router',
        title: 'É o Wi-Fi ou é a internet?',
        text: 'Meça também o roteador: comparando os dois tempos dá para saber onde está o atraso.',
        actions: [
          {
            label: 'Medir o roteador',
            onClick: () => {
              session.targetId = 'gateway';
              start();
            },
          },
        ],
      });
    }
    if (gw) {
      return banner({
        key: 'compare',
        tone: 'neutral',
        icon: 'globe',
        title: 'E depois do roteador?',
        text: 'Meça também a internet: comparando os dois tempos dá para saber onde está o atraso.',
        actions: [
          {
            label: 'Medir a internet',
            onClick: () => {
              session.targetId = 'internet';
              start();
            },
          },
        ],
      });
    }
    return null;
  }

  function historyList() {
    const runs = session.runs;
    if (runs.length < 1 || (runs.length === 1 && runs[0] === session.current)) return null;
    const running = !!session.current && session.current.state === 'running';
    return [
      sectionHeader('Nesta sessão', { count: runs.length }),
      h(
        'div.card.card--flush.list',
        { key: 'history' },
        runs.map((run) => {
          const s = run.summary;
          const verdict = pingVerdict(s, { target: run.target.kind });
          const look = LEVEL_BADGE[verdict.level];
          const parts = [];
          if (typeof s.avg === 'number') parts.push(`média ${fmtMs(s.avg)}`);
          parts.push(`perda ${fmtPct(s.lossPct)}`);
          parts.push(fmtClock(run.endedAt, { seconds: false }));
          if (run.state === 'cancelled') parts.push('parcial');
          return h(
            'button.row.row--tappable.row--dense',
            {
              key: `run-${run.id}`,
              type: 'button',
              'aria-current': run === session.current ? 'true' : undefined,
              disabled: running,
              onClick: () => {
                session.current = run;
                if (run.target.id !== 'custom') session.targetId = run.target.id;
                else {
                  session.targetId = 'custom';
                  session.custom = run.target.host;
                }
                selectedSeq = null;
                if (chart) chart.select(null);
                drawNow();
                scrollToTop();
              },
            },
            h('span.row__body', null, h('span.row__title', null, h('span.truncate', null, targetTitle(run.target))), h('span.row__sub.num', null, parts.join(' · '))),
            h('span.row__trail', null, look ? badge(look[0], { tone: look[1] }) : null),
          );
        }),
      ),
    ];
  }

  function scrollToTop() {
    const view = root.closest('.view');
    if (view) view.scrollTop = 0;
  }

  function view(state) {
    return [setupCard(state), resultCard(), resultDetails(), compareCard(), historyList()];
  }

  function chartLabel(run, stats) {
    if (!run) return 'Gráfico das respostas';
    const lost = Math.max(0, stats.sent - stats.received);
    const avg = typeof stats.avg === 'number' ? `, média de ${fmtMs(stats.avg)}` : '';
    return `Gráfico das respostas de ${run.target.host}: ${stats.received} de ${run.count} recebidas${avg}, ${lost} sem resposta.`;
  }

  function drawNow() {
    frame = 0;
    if (!alive) return;
    patch(root, view(store.get()));
    const run = session.current;
    if (chartHost && !chart) {
      chart = createPingChart(chartHost, (seq) => {
        selectedSeq = seq;
        schedule();
      });
    }
    if (chart) {
      if (run && run.state !== 'error') {
        const stats = statsOf(run);
        chart.update({ count: run.count, replies: run.replies, maxSeq: run.state === 'running' ? run.maxSeq : Math.max(run.maxSeq, stats.sent), received: stats.received, avg: stats.avg }, chartLabel(run, stats));
      } else {
        chart.update(null);
      }
    }
  }

  function schedule() {
    if (alive && !frame) frame = requestAnimationFrame(drawNow);
  }

  // --- ligações ---------------------------------------------------------------------------

  const onSessionChange = () => {
    if (!session.pendingRun) stopTicker();
    schedule();
  };
  session.onChange = onSessionChange;
  cleanups.push(() => {
    if (session.onChange === onSessionChange) session.onChange = null;
  });
  cleanups.push(bridge.on('ping', onReply));
  cleanups.push(store.subscribe((s) => s.connection, schedule));
  cleanups.push(
    store.subscribe((s) => s.backend, () => {
      syncBackend();
      schedule();
    }),
  );
  cleanups.push(store.subscribe((s) => s.theme, () => chart && chart.themeChanged()));

  /** #/ferramentas/ping?host=...: escolhe o destino e já começa a medir. */
  function applyRoute(route) {
    const wanted = route && route.query ? route.query.get('host') : null;
    if (!wanted) return false;
    const parsed = parseHostInput(wanted);
    if (!parsed.host) return false;
    if (parsed.host === gatewayHost()) session.targetId = 'gateway';
    else {
      session.targetId = 'custom';
      session.custom = parsed.host;
    }
    return true;
  }

  // voltando para a tela: uma medição que ficou marcada como "em andamento" já foi cancelada na saída
  if (session.current && session.current.state === 'running' && !session.pending) session.current.state = 'cancelled';
  const autoStart = applyRoute(ctx.route);
  drawNow();
  if (autoStart) start();
  else if (session.pendingRun && session.pendingRun.state === 'running') startTicker();

  return {
    onRoute(route) {
      if (applyRoute(route)) start();
    },
    unmount() {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      stopTicker();
      // a medição não continua às escondidas: o celular devolve o resumo parcial e a sessão guarda
      if (session.pendingRun) {
        session.pendingRun.cancelRequested = true;
        bridge.cancel('ping').catch(() => {});
      }
      for (const off of cleanups.splice(0)) off();
      if (chart) chart.destroy();
      chart = null;
    },
  };
}
