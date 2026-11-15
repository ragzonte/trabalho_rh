// Ferramenta: Sinal ao longo do tempo (#/ferramentas/historico).
//
// Um gráfico de linhas com o sinal de até 6 redes nos últimos 2, 5 ou 10 minutos, tirado do
// histórico que o store já guarda (cada BSSID a cada busca; a rede conectada, a cada segundo).
//
//   - de início entram a rede conectada e as mais fortes; cada rede no gráfico é uma linha da
//     legenda, com a cor do traço e o valor atual (tocar abre os detalhes; o "x" tira do gráfico);
//   - "Adicionar ou trocar redes" abre a lista de tudo o que está ao alcance para pôr e tirar;
//   - o gráfico anda sozinho; "Pausar" congela o instante para olhar com calma (as buscas
//     continuam por baixo e nada se perde ao continuar);
//   - onde uma rede não foi ouvida a linha é interrompida, em vez de ligar os pontos.
//
// A escolha de redes e a janela valem enquanto o app estiver aberto (sobrevivem à troca de tela).

import { h, mount as render, patch, sheet, toast, fmtDbm, fmtBand, fmtClock, plural } from '../dom.js';
import { icon } from '../icons.js';
import { segmented, button, iconButton, emptyState, skeletonList, signalBars, badge } from '../components.js';
import { signalLevel } from '../../core/signal.js';
import { createTimeChart } from '../charts/time-chart.js';
import { ensureNetworksCss, openApDetail } from '../ap-detail.js';
import { cleanName, seriesLabels } from '../networks-logic.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** No máximo isto de linhas: acima disso ninguém distingue as cores. */
export const MAX_SERIES = 6;
/** Quantas redes entram sozinhas na primeira vez. */
const AUTO_SERIES = 4;
const WINDOWS = [
  { value: 120_000, label: '2 min' },
  { value: 300_000, label: '5 min' },
  { value: 600_000, label: '10 min' },
];
// ordem das cores: a paleta categórica do tema, com o amarelo por último
const TOKENS = ['--cat-1', '--cat-2', '--cat-3', '--cat-5', '--cat-6', '--cat-7'];

// O que vale entre uma visita e outra (a tela é remontada a cada vez).
const memo = { windowMs: WINDOWS[0].value, picked: null, colors: new Map(), names: new Map() };

const nameOf = (ap) => (ap.hidden ? '(rede oculta)' : cleanName(ap.ssid));

export async function mount(root, ctx) {
  await ensureNetworksCss();
  const { store } = ctx;
  root.classList.add('hist-screen');

  let paused = false;
  let pausedAt = null;
  let picker = null; // painel "Adicionar" aberto

  const el = {
    bar: h('div.hist-bar'),
    card: h('section.card.hist-card'),
    head: h('div.hist-card__head'),
    host: h('div.hist-chart', { 'data-nodrag': '' }),
    legend: h('div.card.card--flush.list.hist-legend'),
    note: h('p.hist-note'),
    body: h('div.stack'),
    empty: h('div.stack'),
  };
  render(el.card, el.head, el.host);
  render(el.body, el.bar, el.card, el.legend, el.note);
  render(root, el.empty, el.body);

  const chart = createTimeChart(el.host, { windowMs: memo.windowMs, height: 264, labels: true, zoneWords: false, ariaLabel: 'Sinal das redes escolhidas ao longo do tempo' });
  ctx.onCleanup(() => chart.destroy());

  // --- escolha das redes ---

  /** Na primeira vez: a conectada e as mais fortes. Depois, o que o usuário deixou. */
  function ensurePicked(state) {
    if (memo.picked) return;
    if (!state.aps.length) return;
    const first = [];
    const connected = state.aps.find((ap) => ap.connected);
    if (connected) first.push(connected.bssid);
    for (const ap of state.aps) {
      if (first.length >= AUTO_SERIES) break;
      if (!first.includes(ap.bssid)) first.push(ap.bssid);
    }
    memo.picked = first;
  }

  function colorFor(bssid) {
    if (!memo.colors.has(bssid)) {
      const used = new Set((memo.picked || []).map((id) => memo.colors.get(id)).filter(Boolean));
      memo.colors.set(bssid, TOKENS.find((t) => !used.has(t)) || TOKENS[memo.colors.size % TOKENS.length]);
    }
    return memo.colors.get(bssid);
  }

  function toggle(bssid) {
    const picked = memo.picked || [];
    if (picked.includes(bssid)) {
      memo.picked = picked.filter((id) => id !== bssid);
      memo.colors.delete(bssid);
    } else {
      if (picked.length >= MAX_SERIES) {
        toast(`No máximo ${MAX_SERIES} redes de cada vez, para as linhas continuarem legíveis.`);
        return;
      }
      memo.picked = [...picked, bssid];
      colorFor(bssid);
    }
    draw();
  }

  // --- desenho ---

  function scanGap(state) {
    const interval = state.loop && isNum(state.loop.intervalMs) ? state.loop.intervalMs : 10_000;
    return Math.round(interval * 1.7 + 4000);
  }

  function drawBar() {
    patch(
      el.bar,
      segmented(WINDOWS, memo.windowMs, (ms) => {
        memo.windowMs = ms;
        chart.setWindow(ms);
        drawHead();
      }, { label: 'Janela de tempo' }),
      button(paused ? 'Continuar' : 'Pausar', {
        variant: paused ? 'primary' : 'secondary',
        icon: paused ? 'play' : 'pause',
        'aria-pressed': paused,
        onClick: () => {
          paused = !paused;
          pausedAt = paused ? Date.now() : null;
          chart.setPaused(paused);
          drawBar();
          drawHead();
          if (!paused) draw();
        },
      }),
    );
  }

  function drawHead() {
    const win = WINDOWS.find((w) => w.value === memo.windowMs) || WINDOWS[0];
    if (paused) el.head.dataset.paused = '';
    else delete el.head.dataset.paused;
    patch(el.head, h('strong', null, `Últimos ${win.label.replace('min', 'minutos')}`), h('span', null, paused ? `pausado às ${fmtClock(pausedAt)}` : 'ao vivo'));
  }

  function draw() {
    const state = store.get();
    const waiting = state.scan.seq === 0 && state.aps.length === 0;
    const nothing = !waiting && state.aps.length === 0 && !(memo.picked && memo.picked.length);
    el.body.hidden = waiting || nothing;
    if (waiting) {
      patch(el.empty, h('p.hist-note', { key: 'wait' }, 'Aguardando a primeira busca de redes…'), skeletonList(3));
      return;
    }
    if (nothing) {
      patch(el.empty, emptyState({ icon: 'wifi-off', title: 'Nenhuma rede por perto', text: 'Quando o celular ouvir alguma rede, o sinal dela aparece aqui.', action: { label: 'Buscar de novo', icon: 'refresh', onClick: () => ctx.scanLoop.scanNow() } }));
      return;
    }
    patch(el.empty);
    ensurePicked(state);
    const picked = memo.picked || [];
    // rótulos: os das redes ao alcance agora, mais os já conhecidos das escolhidas que sumiram
    const names = seriesLabels(state.aps);
    for (const bssid of picked) if (!names.has(bssid) && memo.names.has(bssid)) names.set(bssid, memo.names.get(bssid));
    memo.names = names;

    // séries
    const connected = state.aps.find((ap) => ap.connected) || null;
    const gap = scanGap(state);
    chart.setGap(gap);
    chart.setSeries(
      picked.map((bssid) => {
        const base = { id: bssid, label: memo.names.get(bssid) || bssid, color: colorFor(bssid) };
        if (connected && connected.bssid === bssid) {
          // a rede em uso tem leituras de 1 em 1 segundo
          const live = store.rssiHistory().filter((s) => !s.bssid || s.bssid === bssid).map((s) => ({ t: s.ts, rssi: s.rssi }));
          if (live.length > 1) return { ...base, points: live, emphasis: true, gapMs: 6000 };
        }
        return { ...base, points: store.history(bssid), emphasis: !!connected && connected.bssid === bssid };
      }),
    );

    // legenda: uma linha por rede no gráfico, com a cor do traço e o valor de agora
    patch(
      el.legend,
      picked.map((bssid) => {
        const ap = store.apById(bssid);
        const label = memo.names.get(bssid) || bssid;
        const level = ap ? signalLevel(ap.rssi) : null;
        const where = ap ? [ap.band ? fmtBand(ap.band) : null, ap.channel != null ? `canal ${ap.channel}` : null].filter(Boolean) : ['saiu do alcance'];
        return h(
          'div',
          { class: ['row', 'hist-item', (!ap || ap.stale) && 'hist-item--gone'], key: bssid, dataset: { bssid } },
          h(
            'button.hist-item__main',
            { type: 'button', 'aria-label': `Detalhes de ${label}`, disabled: !ap, onClick: () => ap && openApDetail(ctx, bssid) },
            h('span.hist-swatch', { style: { background: `var(${colorFor(bssid)})` } }),
            h(
              'span.row__body',
              null,
              h('span.row__title', null, h('span', { class: ['ssid', ap && ap.hidden && 'ssid--hidden'], dir: 'auto' }, ap ? nameOf(ap) : label)),
              h('span.row__sub.row__sub--clip', null, ap && ap.connected ? h('span.accent.strong', null, 'Conectado') : null, where.map((text) => h('span', null, text))),
            ),
            ap
              ? h('span', { class: ['signal', 'signal--stack', `sig-${level.key}`] }, h('span.signal__dbm', null, fmtDbm(ap.rssi)), h('span.signal__word', null, level.label))
              : h('span.signal.signal--stack', null, h('span.signal__dbm', null, '—')),
          ),
          iconButton('close', `Tirar ${label} do gráfico`, () => toggle(bssid), { muted: true }),
        );
      }),
      h(
        'button.row.row--tappable.hist-add',
        { type: 'button', key: 'add', onClick: openPicker },
        h('span.hist-add__icon', null, icon('plus', { size: 20 })),
        h('span.row__body', null, h('span.row__title', null, picked.length ? 'Adicionar ou trocar redes' : 'Escolher redes'), h('span.row__sub', null, `${picked.length} de ${MAX_SERIES} no gráfico`)),
        icon('chevron-right', { size: 20 }),
      ),
    );

    const seconds = Math.round((state.loop && isNum(state.loop.intervalMs) ? state.loop.intervalMs : 10_000) / 1000);
    patch(
      el.note,
      picked.length
        ? `A rede conectada é medida a cada segundo; as outras, a cada busca (cerca de ${seconds} s). Onde a linha some, a rede não foi ouvida. Toque no gráfico para ler os valores de um instante.`
        : 'Escolha até 6 redes para acompanhar.',
    );
    if (picker) picker.refresh();
  }

  // --- painel "Adicionar" ---

  function openPicker() {
    if (picker) return;
    const view = () => {
      const state = store.get();
      const picked = memo.picked || [];
      const labels = seriesLabels(state.aps);
      const full = picked.length >= MAX_SERIES;
      return [
        h('p.hist-note', { key: 'count' }, `${plural(picked.length, 'rede', 'redes')} no gráfico (no máximo ${MAX_SERIES}).`),
        h(
          'div.card.card--flush.list',
          { key: 'list' },
          state.aps.map((ap) => {
            const on = picked.includes(ap.bssid);
            const level = signalLevel(ap.rssi);
            const blocked = !on && full;
            return h(
              'button.row.row--tappable.hist-row',
              { type: 'button', key: ap.bssid, 'aria-pressed': on, 'aria-disabled': blocked ? 'true' : undefined, dataset: { bssid: ap.bssid }, class: [ap.stale && 'row--stale'], onClick: () => toggle(ap.bssid) },
              h('span.hist-check', null, icon('check', { size: 16 })),
              h('span.row__lead', null, on ? h('span.hist-swatch', { style: { background: `var(${colorFor(ap.bssid)})` } }) : signalBars(ap.rssi, { size: 'sm' })),
              h(
                'span.row__body',
                null,
                h('span.row__title', null, h('span', { class: ['ssid', ap.hidden && 'ssid--hidden'], dir: 'auto' }, nameOf(ap)), ap.connected ? badge('Conectado', { tone: 'accent' }) : null),
                h('span.row__sub.row__sub--clip', null, ap.band ? h('span', null, fmtBand(ap.band)) : null, ap.channel != null ? h('span', null, `canal ${ap.channel}`) : null, ap.vendor ? h('span', null, ap.vendor) : null),
              ),
              h('span.row__trail', null, h('span', { class: ['signal', 'signal--stack', `sig-${level.key}`] }, h('span.signal__dbm', null, fmtDbm(ap.rssi)), h('span.signal__word', null, level.label))),
            );
          }),
        ),
        labels.size === 0 ? h('p.hist-note', { key: 'none' }, 'Nenhuma rede ao alcance agora.') : null,
      ];
    };
    const panel = sheet({
      title: 'Redes no gráfico',
      subtitle: 'Toque para pôr ou tirar',
      content: [],
      tall: true,
      footer: [button('Pronto', { variant: 'primary', onClick: () => panel.close() })],
      onClose: () => {
        picker = null;
      },
    });
    panel.el.classList.add('ap-sheet');
    picker = { refresh: () => panel.isOpen() && patch(panel.body, view()), close: () => panel.close() };
    picker.refresh();
  }

  // --- o que muda o quê ---

  store.subscribe((s) => s.aps, draw);
  // a linha da rede conectada cresce a cada segundo (os chips e a lista só mudam com as buscas)
  store.subscribe(
    (s) => s.rssi,
    () => {
      if (paused || document.hidden) return;
      const state = store.get();
      const connected = state.aps.find((ap) => ap.connected);
      if (!connected || !(memo.picked || []).includes(connected.bssid)) return;
      draw();
    },
  );
  ctx.onCleanup(() => picker && picker.close());

  drawBar();
  drawHead();
  draw();

  return { unmount() {} };
}
