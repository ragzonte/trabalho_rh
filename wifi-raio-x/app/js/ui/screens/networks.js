// Redes — a tela inicial: "o que há em volta e como está", de relance.
//
// De cima para baixo:
//   1. cartão da conexão (nome, sinal ao vivo, faixa/canal/largura, geração, velocidade do link,
//      distância estimada) e o aviso mais importante do diagnóstico, que leva a Melhor Wi-Fi;
//   2. a dica dispensável sobre o limite de buscas do Android, quando ele está valendo;
//   3. resumo: quantas redes e roteadores ao alcance e quantas redes por faixa;
//   4. controles, que ficam presos sob a barra de cima ao rolar: modo de ver (Redes = por nome,
//      Roteadores = por aparelho físico, Sinais = cada BSSID), ordem, filtros e a busca
//      (o botão da lupa fica na barra de cima);
//   5. a lista. Tocar numa linha abre o painel de detalhes (ui/ap-detail.js).
//
// Dados ao vivo: cada região da tela é atualizada no lugar (patch / patchList) só quando o
// pedaço do estado de que ela depende muda; a rolagem, o foco, o texto da busca e um painel
// aberto nunca são tocados por uma varredura que chega.
//
// O modo e a ordem escolhidos ficam guardados (prefs 'redes'); filtros e busca valem até fechar o app.
// A lógica de filtrar, ordenar e agrupar está em ui/networks-logic.js (pura, com testes).

import { h, mount as render, patch, patchList, toast, fmtDbm, fmtAgo, fmtMbps, fmtMeters, fmtBand, fmtWidth, plural } from '../dom.js';
import { icon } from '../icons.js';
import { signalBars, badge, bandBadge, securityBadge, standardBadge, chip, segmented, button, iconButton, emptyState, skeletonList, sectionHeader, throttleTip } from '../components.js';
import { signalLevel } from '../../core/signal.js';
import { buildInsights } from '../../core/insights.js';
import { sparkline } from '../charts/sparkline.js';
import { ensureNetworksCss, openApDetail, openNetworkDetail } from '../ap-detail.js';
import { sanitizeControls, toggleFilter, selectRows, summarize, connectionView, channelsText, countText, cleanName } from '../networks-logic.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

const MODES = [
  { value: 'networks', label: 'Redes' },
  { value: 'devices', label: 'Roteadores' },
  { value: 'signals', label: 'Sinais' },
];
const MODE_UNITS = {
  networks: ['rede', 'redes', 'uma linha por nome de rede'],
  devices: ['roteador', 'roteadores', 'uma linha por aparelho'],
  signals: ['sinal', 'sinais', 'cada faixa de cada roteador'],
};
const SORT_LABELS = [
  { value: 'signal', label: 'Sinal' },
  { value: 'name', label: 'Nome' },
  { value: 'channel', label: 'Canal' },
];
const PREFS_KEY = 'redes';
/** Lista mais velha que isto ganha a idade escrita junto da contagem. */
const AGE_NOTE_MS = 20_000;

// Controles da última visita: sobrevivem à troca de aba (a tela é remontada a cada visita).
let memo = null;

// ---------------------------------------------------------------------------
// Linha da lista
// ---------------------------------------------------------------------------

function nameLabel(row) {
  if (row.hidden) return h('span.ssid.ssid--hidden', null, '(rede oculta)');
  return h('span.ssid', { dir: 'auto' }, cleanName(row.name));
}

/**
 * Uma linha: barras · nome · fatos · sinal com minigráfico. Serve para os três modos.
 * @param {object} row       linha de networks-logic.js
 * @param {{history:(bssid:string) => {t:number, rssi:number}[], now:number, onOpen:(row:object) => void}} env
 */
function networkRow(row, env) {
  const level = signalLevel(row.rssi);
  const single = row.count === 1;

  // linha 2: onde ela está (do mais importante para o menos: o que não couber fica de fora)
  const where = [];
  if (row.connected) where.push(h('span.net-row__connected', null, icon('check', { size: 14 }), 'Conectado'));
  if (!single) where.push(h('span', null, countText(row)));
  for (const band of row.bands) where.push(bandBadge(band, { plain: true }));
  if (row.channels.length) where.push(h('span', null, single ? `canal ${row.channel}` : channelsText(row.channels)));
  if (single && isNum(row.widthMHz)) where.push(h('span', null, fmtWidth(row.widthMHz)));

  // linha 3: o que ela é
  const what = [];
  if (row.stale && isNum(row.ageMs)) what.push(h('span.net-row__age', null, icon('clock', { size: 14 }), `visto ${fmtAgo(row.ageMs)}`));
  if (row.security) what.push(securityBadge(row.security, { plain: true }));
  const std = standardBadge(row.standardAp, { plain: true });
  if (std) what.push(std);
  if (row.vendor) what.push(h('span', null, row.vendor));

  const extraNames = row.kind === 'device' && row.names.length > 1 ? row.names.length - 1 : 0;

  return h(
    'button.row.row--tappable.net-row',
    {
      type: 'button',
      key: row.key,
      class: [row.stale && 'row--stale', row.connected && 'net-row--connected'],
      dataset: { kind: row.kind, bssid: row.lead.bssid },
      onClick: () => env.onOpen(row),
    },
    h('span.row__lead', null, signalBars(row.rssi)),
    h(
      'span.row__body',
      null,
      h(
        'span.row__title',
        null,
        nameLabel(row),
        extraNames ? badge(`+${extraNames}`, { outline: true, title: `Este aparelho também anuncia ${extraNames === 1 ? 'outro nome' : `outros ${extraNames} nomes`}` }) : null,
        row.favorite ? icon('star-filled', { size: 16, label: 'Minha rede', class: 'accent' }) : null,
      ),
      h('span.row__sub.row__sub--clip', null, where),
      h('span.row__sub.row__sub--clip.net-row__what', null, what),
    ),
    h(
      'span',
      { class: ['net-row__trail', `sig-${level.key}`] },
      h('span.net-row__dbm', null, fmtDbm(row.rssi)),
      h('span.net-row__word', null, level.label),
      sparkline(env.history(row.best.bssid), { now: env.now, width: 64, height: 16 }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Cartão da conexão
// ---------------------------------------------------------------------------

const INSIGHT_LOOK = {
  critical: { icon: 'alert-circle', tone: 'critical' },
  warning: { icon: 'warning', tone: 'warning' },
  info: { icon: 'info', tone: 'info' },
  good: { icon: 'check-circle', tone: 'good' },
};

/** O aviso que vai no cartão: o primeiro problema; sem problema, o "tudo certo"; senão a primeira nota. */
function pickInsight(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.find((i) => i.severity === 'critical' || i.severity === 'warning') || list.find((i) => i.severity === 'good') || list[0];
}

function speedText(view) {
  if (isNum(view.downMbps) && isNum(view.upMbps)) {
    return [h('span.net-conn__arrow', { 'aria-label': 'recebendo' }, '↓'), `${fmtMbps(view.downMbps).replace(/\s?Mb\/s$/, '')}`, h('span.net-conn__arrow', { 'aria-label': 'enviando' }, '↑'), fmtMbps(view.upMbps)];
  }
  if (isNum(view.linkMbps)) return fmtMbps(view.linkMbps);
  return null;
}

function connectionCard(view, { insight, extraInsights, history, now, onOpen, onInsight, onWifi }) {
  if (!view.connected) {
    return h(
      'section.card.net-conn.net-conn--off',
      { key: 'conn-off' },
      h('span.net-conn__off-icon', null, icon('wifi-off', { size: 24 })),
      h(
        'div.net-conn__off-body',
        null,
        h('h2.net-conn__off-title', null, 'Você não está conectado a um Wi-Fi'),
        h('p.net-conn__off-text', null, 'As redes por perto continuam aparecendo aqui embaixo.'),
        button('Abrir o Wi-Fi do celular', { variant: 'secondary', small: true, icon: 'external', onClick: onWifi }),
      ),
    );
  }

  const level = signalLevel(view.rssi);
  const facts = [];
  if (view.band) facts.push(bandBadge(view.band));
  if (view.channel != null) facts.push(badge(`Canal ${view.channel}`));
  if (isNum(view.widthMHz)) facts.push(badge(fmtWidth(view.widthMHz)));
  if (view.standard) facts.push(badge(view.standard, { outline: true, title: view.standardLabel || undefined }));
  if (view.validated === false) facts.push(badge('Sem internet', { tone: 'warning', icon: 'warning' }));

  const speed = speedText(view);
  const look = insight ? INSIGHT_LOOK[insight.severity] || INSIGHT_LOOK.info : null;

  return h(
    'section.card.card--flush.net-conn',
    { key: 'conn-on' },
    h(
      'button.net-conn__main',
      { type: 'button', 'aria-label': `Detalhes da rede conectada`, disabled: !view.ap, onClick: onOpen },
      h(
        'span.net-conn__head',
        null,
        h('span.net-conn__eyebrow', null, 'Conectado a'),
        view.ap ? h('span.net-conn__more', null, 'Detalhes', icon('chevron-right', { size: 16 })) : null,
      ),
      h(
        'span.net-conn__name',
        null,
        view.hidden ? h('span.ssid.ssid--hidden', null, '(rede oculta)') : h('span.ssid', { dir: 'auto' }, cleanName(view.name)),
        view.favorite ? icon('star-filled', { size: 18, label: 'Minha rede', class: 'accent' }) : null,
      ),
      h(
        'span',
        { class: ['net-conn__signal', `sig-${level.key}`] },
        signalBars(view.rssi, { size: 'lg' }),
        h('span.net-conn__reading', null, h('span.net-conn__dbm', null, fmtDbm(view.rssi, { unit: false })), h('span.net-conn__unit', null, 'dBm')),
        h('span.net-conn__word', null, level.label),
        h('span.net-conn__spark', null, sparkline(history, { now, width: 96, height: 32, windowMs: 60_000, gapMs: 6000, spanDb: 20 })),
      ),
      h('span.net-conn__facts', null, facts),
    ),
    h(
      'div.net-conn__stats',
      null,
      h('div.net-conn__stat', null, h('span.net-conn__stat-label', null, 'Velocidade até o roteador'), h('span.net-conn__stat-value', null, speed || '—')),
      h(
        'div.net-conn__stat',
        null,
        h('span.net-conn__stat-label', null, 'Distância estimada'),
        h('span.net-conn__stat-value', null, isNum(view.distanceM) ? fmtMeters(view.distanceM, { approx: true }) : '—'),
      ),
    ),
    insight
      ? h(
          'button',
          { type: 'button', class: ['net-insight', `net-insight--${look.tone}`], dataset: { insight: insight.id }, onClick: onInsight },
          h('span.net-insight__icon', null, icon(look.icon, { size: 20 })),
          h('span.net-insight__text', null, insight.title),
          extraInsights > 0 ? h('span.net-insight__more', { title: 'Outros pontos no diagnóstico' }, `+${extraInsights}`) : null,
          icon('chevron-right', { size: 18 }),
        )
      : null,
  );
}

function connectionSkeleton() {
  return h('div.skel.skel--card', { key: 'conn-skel', 'aria-hidden': 'true' });
}

// ---------------------------------------------------------------------------
// Resumo
// ---------------------------------------------------------------------------

function summaryStrip(sum) {
  const cell = (value, label, extra) => h('div.net-sum__cell', extra, h('span.net-sum__value', null, value), h('span.net-sum__label', null, label));
  const band = (key, count) => cell(count, [h('span', { class: ['dot', `net-sum__dot--${key.replace('.', '')}`] }), fmtBand(key)], { class: 'net-sum__cell--band' });
  return h(
    'div.net-sum',
    { role: 'group', 'aria-label': 'Resumo do que está ao alcance' },
    cell(sum.networks, sum.networks === 1 ? 'rede' : 'redes'),
    cell(sum.devices, sum.devices === 1 ? 'roteador' : 'roteadores'),
    h('span.net-sum__sep', { 'aria-hidden': 'true' }),
    band('2.4', sum.bands['2.4']),
    band('5', sum.bands['5']),
    sum.bands['6'] > 0 ? band('6', sum.bands['6']) : null,
  );
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export async function mount(root, ctx) {
  await ensureNetworksCss();
  const { store } = ctx;
  root.classList.add('net-screen');

  if (!memo) {
    const saved = ctx.prefs.get(PREFS_KEY, null);
    memo = sanitizeControls({ mode: saved && saved.mode, sort: saved && saved.sort });
  }
  let controls = memo;
  let searchOpen = controls.query !== '';
  let insights = { key: null, list: [] };
  let lastRows = { rows: [], total: 0, filtered: false };

  // regiões fixas: cada uma é atualizada por conta própria
  const el = {
    conn: h('div.net-region'),
    tip: h('div.net-region'),
    summary: h('div.net-region'),
    controls: h('div.net-controls'),
    caption: h('div.net-caption'),
    list: h('div.card.card--flush.list.net-list'),
    empty: h('div.net-region'),
    loading: h('div.net-region.stack'),
  };
  // marca invisível logo acima dos controles: quando ela sai da tela, eles estão presos no topo
  const sentinel = h('div.net-sentinel', { 'aria-hidden': 'true' });
  render(root, el.conn, el.tip, el.loading, el.summary, sentinel, el.controls, el.caption, el.list, el.empty);
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting || entry.boundingClientRect.top > (entry.rootBounds ? entry.rootBounds.top : 0)) delete el.controls.dataset.stuck;
        else el.controls.dataset.stuck = '';
      },
      { root: root.closest('.view'), threshold: 0 },
    );
    io.observe(sentinel);
    ctx.onCleanup(() => io.disconnect());
  }

  const searchBtn = iconButton('search', 'Buscar na lista de redes', () => toggleSearch(), { pressed: searchOpen });
  ctx.setActions(searchBtn);

  // --- ações ---

  function setControls(next, { persist = true } = {}) {
    controls = sanitizeControls(next);
    memo = controls;
    if (persist) ctx.prefs.set(PREFS_KEY, { mode: controls.mode, sort: controls.sort });
    drawControls();
    drawList();
  }

  function toggleSearch(force) {
    const next = typeof force === 'boolean' ? force : !searchOpen;
    if (next === searchOpen) return;
    searchOpen = next;
    searchBtn.setAttribute('aria-pressed', String(searchOpen));
    if (!searchOpen && controls.query) setControls({ ...controls, query: '' }, { persist: false });
    else drawControls();
    if (searchOpen) {
      const input = el.controls.querySelector('.net-search__input');
      if (input) input.focus();
    }
  }

  function clearFilters() {
    searchOpen = false;
    searchBtn.setAttribute('aria-pressed', 'false');
    setControls({ ...controls, filters: [], query: '' }, { persist: false });
  }

  function openRow(row) {
    if (row.kind === 'network' && row.networkKey && row.count > 1) openNetworkDetail(ctx, row.networkKey);
    else openApDetail(ctx, row.lead.bssid);
  }

  async function openWifiPanel() {
    if (store.get().backend === 'sim') {
      toast('Na demonstração não há configurações do Android para abrir.');
      return;
    }
    const res = await ctx.bridge.openSettings('panel').catch(() => null);
    if (res && res.ok !== false) return;
    const again = await ctx.bridge.openSettings('wifi').catch(() => null);
    if (!again || again.ok === false) toast('Não foi possível abrir. Procure “Wi-Fi” nas configurações do Android.');
  }

  // --- desenho de cada região ---

  function currentInsights(state) {
    const conn = state.connection;
    const key = `${state.scan.seq}|${conn && conn.connected ? conn.bssid : ''}|${state.loop.throttled}|${state.favorites.size}`;
    if (insights.key !== key || insights.aps !== state.aps) {
      let list = [];
      try {
        list = buildInsights({ aps: state.aps, connection: conn || undefined, device: state.info || undefined, status: state.status || undefined });
      } catch {
        list = [];
      }
      insights = { key, aps: state.aps, list };
    }
    return insights.list;
  }

  function drawConnection() {
    const state = store.get();
    if (!state.connection && state.scan.seq === 0) {
      patch(el.conn, connectionSkeleton());
      return;
    }
    const view = connectionView(state);
    let insight = null;
    let extra = 0;
    if (view.connected && state.scan.seq > 0) {
      const list = currentInsights(state);
      insight = pickInsight(list);
      extra = insight ? list.filter((i) => i !== insight && (i.severity === 'critical' || i.severity === 'warning')).length : 0;
    }
    const history = view.connected ? store.rssiHistory().filter((s) => !s.bssid || !view.bssid || s.bssid === view.bssid).map((s) => ({ t: s.ts, rssi: s.rssi })) : [];
    patch(
      el.conn,
      connectionCard(view, {
        insight,
        extraInsights: extra,
        history,
        now: Date.now(),
        onOpen: () => view.ap && openApDetail(ctx, view.ap.bssid),
        onInsight: () => ctx.navigate('/melhor'),
        onWifi: openWifiPanel,
      }),
    );
  }

  function drawTip() {
    patch(el.tip, throttleTip(ctx));
  }

  function drawControls() {
    const state = store.get();
    const sum = summarize(state);
    const on = (id) => controls.filters.includes(id);
    const flip = (id) => () => setControls(toggleFilter(controls, id), { persist: false });
    const bandChip = (id) =>
      h('button.chip.net-chip', { type: 'button', 'aria-pressed': on(id), dataset: { filter: id }, onClick: flip(id) }, h('span', { class: ['dot', `net-sum__dot--${id.replace('.', '')}`] }), fmtBand(id));
    const sortLabel = (SORT_LABELS.find((s) => s.value === controls.sort) || SORT_LABELS[0]).label;

    patch(
      el.controls,
      searchOpen
        ? h(
            'div.net-search',
            { key: 'search', role: 'search' },
            h('span.net-search__icon', null, icon('search', { size: 20 })),
            h('input.net-search__input', {
              type: 'text',
              value: controls.query,
              placeholder: 'Nome, fabricante ou BSSID',
              'aria-label': 'Buscar redes por nome, fabricante ou BSSID',
              inputmode: 'search',
              enterkeyhint: 'search',
              autocomplete: 'off',
              autocapitalize: 'off',
              spellcheck: 'false',
              maxlength: 64,
              onInput: (ev) => {
                controls = sanitizeControls({ ...controls, query: ev.currentTarget.value });
                memo = controls;
                drawList();
              },
              onKeyDown: (ev) => {
                if (ev.key === 'Enter') ev.currentTarget.blur();
                else if (ev.key === 'Escape') toggleSearch(false);
              },
            }),
            iconButton('close', 'Fechar a busca', () => toggleSearch(false), { muted: true }),
          )
        : null,
      h('div', { key: 'modes' }, segmented(MODES, controls.mode, (mode) => setControls({ ...controls, mode }), { label: 'Como ver a lista' })),
      h(
        'div.chips.chips--scroll.net-filters',
        { key: 'filters', role: 'group', 'aria-label': 'Ordem e filtros' },
        h(
          'label.chip.net-sort',
          null,
          icon('sort', { size: 16 }),
          h('span.net-sort__label', null, sortLabel),
          icon('chevron-down', { size: 14 }),
          h(
            'select.net-sort__native',
            { 'aria-label': 'Ordenar por', onChange: (ev) => setControls({ ...controls, sort: SORT_LABELS[ev.currentTarget.selectedIndex].value }) },
            SORT_LABELS.map((s) => h('option', { value: s.value, selected: s.value === controls.sort }, `Ordenar por ${s.label.toLowerCase()}`)),
          ),
        ),
        h('span.net-filters__sep', { 'aria-hidden': 'true' }),
        bandChip('2.4'),
        bandChip('5'),
        sum.bands['6'] > 0 || on('6') || (state.info && state.info.bands && state.info.bands.b6) ? bandChip('6') : null,
        h('button.chip.net-chip', { type: 'button', 'aria-pressed': on('mine'), dataset: { filter: 'mine' }, onClick: flip('mine') }, icon('star', { size: 16 }), 'Minhas'),
        h('button.chip.net-chip', { type: 'button', 'aria-pressed': on('open'), dataset: { filter: 'open' }, onClick: flip('open') }, icon('lock-open', { size: 16 }), 'Abertas'),
      ),
    );
  }

  function drawCaption() {
    const state = store.get();
    const [one, many, note] = MODE_UNITS[controls.mode] || MODE_UNITS.networks;
    const { rows, total, filtered } = lastRows;
    const age = state.scan.dataAt ? Date.now() - state.scan.dataAt : null;
    const old = isNum(age) && age > AGE_NOTE_MS;
    // sem filtro e com a lista em dia o resumo já diz tudo: a legenda só aparece quando acrescenta algo
    if (!filtered && !old && controls.mode === 'networks') {
      patch(el.caption);
      return;
    }
    patch(
      el.caption,
      h(
        'span.net-caption__text',
        null,
        filtered ? `${rows.length} de ${plural(total, one, many)}` : controls.mode === 'networks' ? plural(total, one, many) : `${plural(total, one, many)} · ${note}`,
        old ? h('span', { class: ['net-caption__age', age > 60_000 && 'warning'] }, ` · lista de ${fmtAgo(age)}`) : null,
      ),
      filtered && rows.length > 0 ? button('Limpar filtros', { variant: 'quiet', small: true, onClick: clearFilters }) : null,
    );
  }

  function emptyFor() {
    const q = controls.query.trim();
    if (q) {
      return emptyState({ icon: 'search', title: `Nada encontrado para “${q}”`, text: 'A busca olha o nome da rede, o fabricante e o BSSID.', action: { label: 'Limpar a busca e os filtros', onClick: clearFilters } });
    }
    if (controls.filters.includes('mine') && controls.filters.length === 1) {
      return emptyState({
        icon: 'star',
        tone: 'accent',
        title: 'Nenhuma rede marcada como sua',
        text: 'Toque numa rede e ligue “Esta rede é minha”. A rede em que o celular está conectado já conta.',
        action: { label: 'Ver todas as redes', onClick: clearFilters },
      });
    }
    if (controls.filters.includes('open') && controls.filters.length === 1) {
      return emptyState({ icon: 'lock', title: 'Nenhuma rede aberta por perto', text: 'Todas as redes ao alcance pedem senha.', action: { label: 'Ver todas as redes', onClick: clearFilters } });
    }
    return emptyState({ icon: 'filter', title: 'Nenhuma rede com esses filtros', text: 'Tire um filtro ou veja a lista inteira.', action: { label: 'Limpar filtros', onClick: clearFilters } });
  }

  function drawList() {
    const state = store.get();
    const loading = state.scan.seq === 0 && state.aps.length === 0;
    const nothing = !loading && state.aps.length === 0;

    el.loading.hidden = !loading;
    el.summary.hidden = loading || nothing;
    el.controls.hidden = loading || nothing;
    el.caption.hidden = loading || nothing;
    if (loading) {
      if (!el.loading.firstChild) render(el.loading, sectionHeader('Procurando redes por perto…'), skeletonList(6));
      el.list.hidden = true;
      patch(el.empty);
      return;
    }
    if (el.loading.firstChild) render(el.loading);
    if (nothing) {
      el.list.hidden = true;
      patch(
        el.empty,
        emptyState({
          icon: 'wifi-off',
          title: 'Nenhuma rede por perto',
          text: 'O celular não ouviu nenhuma rede Wi-Fi na última busca. Chegue mais perto de um roteador ou tente de novo.',
          action: { label: 'Buscar de novo', icon: 'refresh', onClick: () => ctx.scanLoop.scanNow() },
        }),
      );
      return;
    }

    lastRows = selectRows(state, controls);
    const env = { history: (bssid) => store.history(bssid), now: state.scan.ts || Date.now(), onOpen: openRow };
    patchList(el.list, lastRows.rows, { key: (row) => row.key, create: (row) => networkRow(row, env) });
    el.list.hidden = lastRows.rows.length === 0;
    el.list.setAttribute('aria-label', `Lista: ${lastRows.rows.length} de ${lastRows.total}`);
    patch(el.empty, lastRows.rows.length === 0 ? emptyFor() : null);
    patch(el.summary, summaryStrip(summarize(state)));
    drawCaption();
  }

  // --- o que muda o quê ---

  store.subscribe(
    (s) => s.aps,
    () => {
      drawConnection();
      drawList();
    },
  );
  store.subscribe((s) => s.connection, drawConnection);
  store.subscribe((s) => s.rssi, drawConnection);
  store.subscribe((s) => s.loop.throttled, () => {
    drawTip();
    drawConnection();
  });
  store.subscribe((s) => s.settings.tipsDismissed, drawTip);
  store.subscribe((s) => (s.info && s.info.bands ? s.info.bands.b6 : null), drawControls);

  // a idade da lista e o "ao vivo" do cartão envelhecem mesmo sem evento novo
  const ticker = setInterval(() => {
    if (document.hidden) return;
    drawCaption();
    const { rssi } = store.get();
    if (!rssi || Date.now() - rssi.ts > 3000) drawConnection();
  }, 5000);
  ctx.onCleanup(() => clearInterval(ticker));

  ctx.onBack(() => {
    if (!searchOpen) return false;
    toggleSearch(false);
    return true;
  });

  drawConnection();
  drawTip();
  drawControls();
  drawList();

  return {
    unmount() {
      clearInterval(ticker);
    },
  };
}
