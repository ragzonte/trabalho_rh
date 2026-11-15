// Painéis de detalhes: um ponto de acesso (BSSID) e uma rede (nome, com todos os seus BSSIDs).
//
//   openApDetail(ctx, bssid)             -> painel | null   detalhes de um rádio
//   openNetworkDetail(ctx, networkKey)   -> painel | null   detalhes de uma rede (state.networks[].key);
//                                                           rede de um sinal só abre direto o do rádio
//   closeDetails()                       fecha os painéis de detalhes abertos
//   ensureNetworksCss() -> Promise       garante que css/networks.css está carregado (uma vez)
//   copyText(texto) -> Promise<boolean>  área de transferência, com plano B para WebViews antigos
//
// `ctx` é o contexto de qualquer tela (store, bridge, navigate, onCleanup). As outras telas
// carregam este arquivo sob demanda:  (await import('../ap-detail.js')).openApDetail(ctx, bssid)
//
// Os painéis são vivos: acompanham as varreduras (e, na rede conectada, a leitura do sinal a
// cada segundo) atualizando no lugar, sem fechar nem perder a rolagem. Se o BSSID sai do
// alcance, o painel fica aberto com os últimos dados e avisa.
//
// Ações: "Localizar este roteador" -> #/ferramentas/medidor?bssid=…   "Ver no gráfico de canais"
// -> #/canais?band=…&bssid=…   A estrela "Esta rede é minha" chama store.toggleFavorite(ssid).
//
// Nomes de rede, de aparelho (WPS) e de fabricante são texto hostil: tudo entra por h().

import { h, patch, sheet, toast, fmtDbm, fmtAgo, fmtBand, fmtWidth, plural } from './dom.js';
import { icon } from './icons.js';
import { signalBars, ssidLabel, displaySsid, badge, bandBadge, securityBadge, standardBadge, listRow, banner, button, switchRow, iconButton } from './components.js';
import { createTimeChart } from './charts/time-chart.js';
import { signalLevel } from '../core/signal.js';
import { maxRate } from '../core/phy.js';
import { scoreAp } from '../core/best-network.js';
import { apFacts, apFeatures, apDetailsText, bandsText, securityWord, LIVE_RSSI_MS } from './networks-logic.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------------------
// Folha de estilo destas telas (uma vez por documento)
// ---------------------------------------------------------------------------

let cssReady = null;

/** Carrega css/networks.css se ainda não estiver no documento. Resolve quando estiver aplicado. */
export function ensureNetworksCss() {
  if (cssReady) return cssReady;
  if (typeof document === 'undefined') return Promise.resolve();
  cssReady = new Promise((resolve) => {
    const href = new URL('../../css/networks.css', import.meta.url).href;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.wrx = 'networks';
    link.addEventListener('load', () => resolve());
    link.addEventListener('error', () => resolve());
    // nunca prende a tela à espera de um arquivo de estilo
    setTimeout(resolve, 1500);
    document.head.appendChild(link);
  });
  return cssReady;
}
// quem importa este arquivo vai abrir um painel logo em seguida: adianta o carregamento
if (typeof document !== 'undefined') ensureNetworksCss();

// ---------------------------------------------------------------------------
// Área de transferência
// ---------------------------------------------------------------------------

/**
 * Copia um texto. Tenta a API nova e, se o WebView recusar, o método antigo (campo escondido).
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // segue para o plano B
  }
  try {
    const area = h('textarea', { value, readOnly: true, 'aria-hidden': 'true', style: { position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0' } });
    // dentro da camada de cima (o resto da página está inerte e não aceita foco)
    const host = document.querySelector('.layer:last-of-type') || document.body;
    host.appendChild(area);
    area.focus({ preventScroll: true });
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return !!ok;
  } catch {
    return false;
  }
}

async function copyAndTell(text, done) {
  const ok = await copyText(text);
  toast(ok ? done : 'Não deu para copiar neste aparelho.');
}

// ---------------------------------------------------------------------------
// Peças
// ---------------------------------------------------------------------------

const open = new Set(); // painéis de detalhes abertos (para fechar todos ao navegar)

/** Fecha todos os painéis de detalhes abertos. */
export function closeDetails() {
  for (const panel of [...open]) panel.close();
}

/** Para onde o "ver no gráfico de canais" leva. */
function channelsRoute(ap) {
  const band = ap.band === '2.4' || ap.band === '5' || ap.band === '6' ? ap.band : '2.4';
  return `/canais?band=${band}&bssid=${encodeURIComponent(ap.bssid)}`;
}

function meterRoute(ap) {
  return `/ferramentas/medidor?bssid=${encodeURIComponent(ap.bssid)}`;
}

/** Leitura atual do sinal de um Ap: ao vivo (evento 'rssi') se for o conectado, senão a da última busca. */
function currentRssi(state, ap) {
  const sample = state.rssi;
  if (ap.connected && sample && isNum(sample.rssi) && (!sample.bssid || sample.bssid === ap.bssid) && Math.abs(Date.now() - sample.ts) <= LIVE_RSSI_MS) {
    return { rssi: sample.rssi, live: true };
  }
  return { rssi: ap.rssi, live: false };
}

/** Bloco do sinal: barras grandes, número, palavra e a frase do nível. */
function signalBlock(rssi, { live = false, stale = false, ageMs = null } = {}) {
  const level = signalLevel(rssi);
  let note = level.hint;
  if (stale && isNum(ageMs)) note = `Não apareceu na última busca; leitura de ${fmtAgo(ageMs)}`;
  return h(
    'div',
    { class: ['ap-signal', `sig-${level.key}`, stale && 'ap-signal--stale'], key: 'signal' },
    signalBars(rssi, { size: 'lg' }),
    h(
      'div.ap-signal__main',
      null,
      h('div.ap-signal__line', null, h('span.ap-signal__dbm', null, fmtDbm(rssi)), h('span.ap-signal__word', null, level.label), live ? badge('ao vivo', { tone: 'accent', title: 'Uma leitura por segundo' }) : null),
      h('div.ap-signal__note', null, note),
    ),
  );
}

/** Quadradinho de um fato: rótulo pequeno, valor em destaque e uma linha de explicação. */
function factTile(fact, { tone, value } = {}) {
  return h(
    'div',
    { class: ['fact', tone && `fact--${tone}`], key: `fact-${fact.id}`, dataset: { fact: fact.id } },
    h('span.fact__label', null, fact.label),
    h('span.fact__value', null, value ?? fact.value),
    fact.hint ? h('span.fact__hint', null, fact.hint) : null,
  );
}

const SECURITY_TONE = ['warning', 'critical', 'warning', undefined, 'good'];
const ISSUE_ICON = { high: 'alert-circle', medium: 'warning', low: 'info' };
const ISSUE_TONE = { high: 'critical', medium: 'warning', low: 'muted' };

/** Cartão de segurança: rótulo, o que ele quer dizer e cada ponto de atenção em palavras simples. */
function securityCard(security) {
  const known = security && security.known !== false;
  const issues = known && Array.isArray(security.issues) ? security.issues : [];
  return h(
    'section.card.ap-sec',
    { key: 'security' },
    h('div.between', null, h('h3.card__title', null, 'Segurança'), securityBadge(security)),
    h(
      'p.card__text',
      null,
      known
        ? `${securityWord(security)}. A segurança é a forma como a rede embaralha o que você envia, para que só o roteador entenda.`
        : 'O celular não informou como esta rede é protegida.',
    ),
    issues.length
      ? h(
          'ul.ap-issues',
          null,
          issues.map((issue, i) =>
            h('li', { class: ['ap-issue', `ap-issue--${ISSUE_TONE[issue.severity] || 'muted'}`], key: `issue-${issue.code || i}` }, icon(ISSUE_ICON[issue.severity] || 'info', { size: 18 }), h('span', null, issue.text)),
          ),
        )
      : known && security.level >= 3
        ? h('p.ap-ok', null, icon('shield-check', { size: 18 }), h('span', null, 'Nenhum ponto de atenção nesta configuração.'))
        : null,
  );
}

function featuresCard(ap) {
  const features = apFeatures(ap);
  if (!features.length) {
    return h(
      'section.card',
      { key: 'features' },
      h('h3.card__title', null, 'Recursos do roteador'),
      h('p.card__text', null, 'Este celular não entrega os detalhes avançados que o roteador anuncia (isso depende da versão do Android).'),
    );
  }
  return h(
    'section.card.card--flush',
    { key: 'features' },
    h('h3.card__title.ap-card-title', null, 'Recursos do roteador'),
    h(
      'ul.ap-features',
      null,
      features.map((f) =>
        h(
          'li',
          { class: ['ap-feature', !f.on && 'ap-feature--off', f.tone && `ap-feature--${f.tone}`], key: f.id },
          h('span.ap-feature__mark', null, icon(!f.on ? 'minus' : f.tone === 'warning' ? 'warning' : f.tone === 'neutral' ? 'info' : 'check', { size: 16 })),
          h('span.ap-feature__body', null, h('span.ap-feature__label', null, f.label), h('span.ap-feature__hint', null, f.hint)),
          h('span.ap-feature__value', null, f.value || (f.on ? 'sim' : 'não')),
        ),
      ),
    ),
  );
}

/** Linha de um BSSID dentro de um painel (outros rádios do roteador, pontos de acesso da rede). */
function radioRow(ap, { onClick, dot, showName = false }) {
  const level = signalLevel(ap.rssi);
  const parts = [];
  if (ap.channel != null) parts.push(`canal ${ap.channel}`);
  if (isNum(ap.widthMHz)) parts.push(fmtWidth(ap.widthMHz));
  if (ap.vendor) parts.push(ap.vendor);
  return h(
    'button.row.row--tappable.ap-radio',
    { type: 'button', key: `radio-${ap.bssid}`, class: [ap.stale && 'row--stale'], dataset: { bssid: ap.bssid }, onClick: () => onClick(ap) },
    h('span.row__lead', null, signalBars(ap.rssi)),
    h(
      'span.row__body',
      null,
      h(
        'span.row__title',
        null,
        dot ? h('span.ap-radio__dot', { style: { background: `var(${dot})` } }) : null,
        showName ? ssidLabel(ap.ssid) : h('span.truncate', null, ap.band ? fmtBand(ap.band) : 'Faixa desconhecida'),
        ap.connected ? badge('Conectado', { tone: 'accent' }) : null,
      ),
      h('span.row__sub.row__sub--clip', null, showName && ap.band ? bandBadge(ap.band, { plain: true }) : null, parts.map((p) => h('span', null, p)), ap.stale && isNum(ap.ageMs) ? h('span', null, `visto ${fmtAgo(ap.ageMs)}`) : null),
    ),
    h('span.row__trail', null, h('span', { class: ['signal', 'signal--stack', `sig-${level.key}`] }, h('span.signal__dbm', null, fmtDbm(ap.rssi)), h('span.signal__word', null, level.label)), icon('chevron-right', { size: 20 })),
  );
}

function actionRows(ctx, ap) {
  const go = (path) => {
    closeDetails();
    ctx.navigate(path);
  };
  return h(
    'div.card.card--flush.list',
    { key: 'actions' },
    listRow({
      key: 'act-find',
      icon: 'target',
      title: 'Localizar este roteador',
      subtitle: 'Ande pela casa e siga o sinal até ele',
      chevron: true,
      onClick: () => go(meterRoute(ap)),
    }),
    listRow({
      key: 'act-channels',
      icon: 'channels',
      title: 'Ver no gráfico de canais',
      subtitle: ap.channel != null ? `Quem divide o canal ${ap.channel} com ele` : 'Quem divide o canal com ele',
      chevron: true,
      onClick: () => go(channelsRoute(ap)),
    }),
  );
}

/** A linha "Esta rede é minha" (a estrela que decide de quem o app fala quando diz "seu roteador"). */
function ownRow(ctx, { ssid, hidden }) {
  if (hidden || !ssid) {
    return h(
      'div.card.card--flush',
      { key: 'own' },
      listRow({ icon: 'star', neutral: true, title: 'Esta rede é minha', subtitle: 'Redes ocultas não têm nome, então não dá para marcar. Conecte-se a ela e o app já a trata como sua.' }),
    );
  }
  const on = ctx.store.isFavorite(ssid);
  return h(
    'div.card.card--flush.ap-own',
    { key: 'own', dataset: { on: on ? '1' : '0' } },
    switchRow({
      icon: on ? 'star-filled' : 'star',
      title: 'Esta rede é minha',
      subtitle: on ? 'O app fala desta rede quando diz “seu roteador”.' : 'Marque para as dicas de canal e de sinal serem sobre ela.',
      checked: on,
      onChange: (checked) => {
        ctx.store.setFavorite(ssid, checked);
      },
    }),
  );
}

/**
 * Cartão do gráfico: título à esquerda, de onde vêm os dados à direita, e o lugar do canvas.
 * O lugar (`.ap-chart`) é `keep`: o patch nunca toca nele nem no canvas que mora lá dentro.
 */
function chartCard(title, note) {
  return h(
    'section.card.ap-chart-card',
    { key: 'chart' },
    h('div.ap-chart-card__head', null, h('h3.card__title', null, title), h('span.ap-chart-card__note', null, note)),
    h('div.ap-chart', { key: 'chart-host', keep: true, 'data-nodrag': '' }),
  );
}

/**
 * Dono de um gráfico dentro de um painel. Depois de cada patch, attach() recebe o `.ap-chart`
 * que está no documento: na primeira vez o gráfico é criado ali; nas seguintes é o mesmo nó e
 * nada acontece (recriar o canvas a cada busca faria a rolagem do painel pular).
 */
function chartSlot(options) {
  let host = null;
  let chart = null;
  return {
    attach(el) {
      if (!el || el === host) return;
      if (chart) chart.destroy();
      host = el;
      chart = createTimeChart(el, options);
    },
    get chart() {
      return chart;
    },
    destroy() {
      if (chart) chart.destroy();
      chart = null;
      host = null;
    },
  };
}

/** Intervalo acima do qual uma série de varreduras é considerada interrompida. */
function scanGapMs(state) {
  const interval = state.loop && isNum(state.loop.intervalMs) ? state.loop.intervalMs : 10_000;
  return Math.round(interval * 1.7 + 4000);
}

function sourceNote(state, live) {
  if (live) return 'ao vivo · 1 leitura por segundo';
  const interval = state.loop && isNum(state.loop.intervalMs) ? state.loop.intervalMs : 10_000;
  return `1 leitura a cada ~${Math.round(interval / 1000)} s`;
}

/** Velocidade estimada e máximo do enlace (core/best-network.js). Qualquer falha vira "sem estimativa". */
function estimate(state, ap) {
  try {
    const res = scoreAp(ap, { aps: state.aps, device: state.info || undefined, connectionBssid: state.connection && state.connection.connected ? state.connection.bssid : undefined });
    const d = res && res.detail ? res.detail : {};
    const max = isNum(d.gen) && isNum(d.widthMHz) ? maxRate({ gen: d.gen, widthMHz: d.widthMHz, nss: isNum(d.nss) ? d.nss : 1, band: ap.band || undefined }) : null;
    return { estMbps: res && isNum(res.estMbps) ? res.estMbps : null, maxMbps: isNum(max) ? max : null, usable: d.usable !== false };
  } catch {
    return { estMbps: null, maxMbps: null, usable: true };
  }
}

// ---------------------------------------------------------------------------
// Painel de um ponto de acesso
// ---------------------------------------------------------------------------

const TILE_IDS = ['channel', 'width', 'standard', 'security', 'speed', 'distance', 'antennas', 'stations', 'utilization'];
const KV_IDS = ['bssid', 'vendor', 'model', 'ap-name', 'freq', 'range', 'max', 'country', 'power', 'chipset', 'first-seen', 'last-seen'];

/**
 * Abre os detalhes de um BSSID.
 * @param {object} ctx     contexto da tela (store, bridge, navigate, onCleanup)
 * @param {string} bssid
 * @returns {ReturnType<typeof sheet>|null}  null se o BSSID não está na lista
 */
export function openApDetail(ctx, bssid) {
  const first = ctx.store.apById(bssid);
  if (!first) {
    toast('Esta rede saiu do alcance.');
    return null;
  }
  const id = first.bssid;
  let lastAp = first;
  let est = null;
  let estFor = null;
  const slot = chartSlot({ windowMs: 120_000, height: 168, labels: false, ariaLabel: 'Sinal desta rede nos últimos 2 minutos' });

  function view(state) {
    const found = ctx.store.apById(id);
    const gone = !found;
    const ap = found || lastAp;
    lastAp = ap;
    if (estFor !== state.aps) {
      est = estimate(state, ap);
      estFor = state.aps;
    }
    const now = currentRssi(state, ap);
    const facts = apFacts(ap, { estMbps: est.estMbps, maxMbps: est.maxMbps });
    const byId = new Map(facts.map((f) => [f.id, f]));

    const tiles = [];
    for (const tileId of TILE_IDS) {
      const fact = byId.get(tileId);
      if (!fact) continue;
      if (tileId === 'channel') tiles.push(factTile({ ...fact, hint: [ap.band ? fmtBand(ap.band) : null, byId.get('freq') ? byId.get('freq').value : null].filter(Boolean).join(' · ') }));
      else if (tileId === 'width') tiles.push(factTile({ ...fact, label: 'Largura', hint: byId.get('range') ? `ocupa ${byId.get('range').value}` : undefined }));
      else if (tileId === 'standard') tiles.push(factTile({ ...fact, value: isNum(ap.gen) ? ap.standard : fact.value, hint: ap.genSource === 'inferred' ? 'ou mais novo (estimado)' : ap.ieee || undefined }));
      else if (tileId === 'security') tiles.push(factTile({ ...fact, hint: fact.hint ? fact.hint.charAt(0).toLowerCase() + fact.hint.slice(1) : undefined }, { tone: SECURITY_TONE[ap.security && ap.security.known !== false ? ap.security.level : 3] }));
      else if (tileId === 'speed') tiles.push(factTile({ ...fact, hint: est.maxMbps ? `estimativa · máximo teórico: ${byId.get('max').value}` : 'estimativa' }));
      else if (tileId === 'distance') tiles.push(factTile({ ...fact, hint: 'estimativa pelo sinal; paredes enganam' }));
      else tiles.push(factTile(fact));
    }
    if (!byId.has('speed') && est.usable === false) {
      tiles.push(factTile({ id: 'speed', label: 'Velocidade estimada aqui', value: 'Sem uso', hint: 'este celular não usa esta faixa' }));
    }

    const device = state.devices.find((d) => Array.isArray(d.bssids) && d.bssids.includes(id));
    const siblings = device ? device.aps.filter((a) => a.bssid !== id) : [];

    const kv = KV_IDS.map((k) => byId.get(k)).filter(Boolean);

    return [
      h(
        'div.ap-head',
        { key: 'head' },
        signalBlock(now.rssi, { live: now.live, stale: ap.stale || gone, ageMs: ap.ageMs }),
        h(
          'div.ap-badges',
          null,
          ap.connected ? badge('Conectado', { tone: 'accent', icon: 'check' }) : null,
          ap.favorite ? badge('Minha', { tone: 'accent', icon: 'star-filled' }) : null,
          ap.band ? bandBadge(ap.band) : null,
          standardBadge(ap),
          securityBadge(ap.security),
        ),
      ),
      gone ? banner({ key: 'gone', tone: 'warning', icon: 'clock', title: 'Esta rede saiu do alcance', text: 'Ela não aparece mais nas buscas. Os dados abaixo são os da última vez em que foi ouvida.' }) : null,
      chartCard('Sinal nos últimos 2 minutos', sourceNote(state, ap.connected)),
      ownRow(ctx, ap),
      gone ? null : actionRows(ctx, ap),
      h('div.facts', { key: 'tiles' }, tiles),
      securityCard(ap.security),
      featuresCard(ap),
      siblings.length
        ? h(
            'section',
            { key: 'siblings', class: 'stack stack--sm' },
            h('h3.ap-section-title', null, 'Outros sinais deste roteador'),
            h(
              'div.card.card--flush.list',
              null,
              siblings.map((other) => radioRow(other, { showName: true, onClick: (a) => openApDetail(ctx, a.bssid) })),
            ),
          )
        : null,
      h(
        'section.card.ap-kv',
        { key: 'kv' },
        h('h3.card__title', null, 'Mais detalhes'),
        h(
          'dl.kv',
          null,
          kv.map((f) =>
            h(
              'div.kv__row',
              { key: `kv-${f.id}` },
              h('dt.kv__label', null, f.label),
              h(
                'dd.kv__value',
                { class: [f.id === 'bssid' && 'ap-kv__bssid'] },
                h('span', { class: [f.id === 'bssid' && 'mono'], dir: 'auto' }, f.value),
                f.id === 'bssid' ? iconButton('copy', 'Copiar o BSSID', () => copyAndTell(ap.bssid, 'BSSID copiado.'), { muted: true }) : null,
                f.id === 'bssid' || f.id === 'range' ? h('span.kv__hint', null, f.hint) : null,
              ),
            ),
          ),
        ),
      ),
      button('Copiar todos os detalhes', {
        key: 'copy-all',
        variant: 'secondary',
        icon: 'copy',
        block: true,
        onClick: () => copyAndTell(apDetailsText(ap, { estMbps: est.estMbps, maxMbps: est.maxMbps }), 'Detalhes copiados.'),
      }),
    ];
  }

  function feedChart(state) {
    const chart = slot.chart;
    if (!chart) return;
    const ap = lastAp;
    if (ap.connected) {
      // a rede conectada tem leituras de 1 em 1 segundo: linha bem mais fina que a das buscas
      const points = ctx.store.rssiHistory().filter((s) => !s.bssid || s.bssid === id).map((s) => ({ t: s.ts, rssi: s.rssi }));
      chart.setSeries([{ id, label: displaySsid(ap.ssid), color: '--accent', points, emphasis: true, gapMs: 6000 }]);
    } else {
      chart.setGap(scanGapMs(state));
      chart.setSeries([{ id, label: displaySsid(ap.ssid), color: '--accent', points: ctx.store.history(id), emphasis: true }]);
    }
  }

  const subtitleOf = (ap) => [ap.vendor ? (ap.vendorGuess ? `${ap.vendor} (provável)` : ap.vendor) : null, ap.band ? fmtBand(ap.band) : null, ap.channel != null ? `canal ${ap.channel}` : null].filter(Boolean).join(' · ');

  const subtitle = h('span', null, subtitleOf(first));
  const panel = sheet({
    title: h('span', { class: ['ap-title', first.hidden && 'ap-title--hidden'], dir: 'auto' }, first.hidden ? '(rede oculta)' : displaySsid(first.ssid)),
    subtitle,
    content: [],
    tall: true,
    onClose: () => {
      open.delete(panel);
      for (const off of offs) off();
      slot.destroy();
    },
  });
  panel.el.classList.add('ap-sheet');
  panel.el.dataset.bssid = id;
  open.add(panel);

  const render = () => {
    if (!panel.isOpen()) return;
    const state = ctx.store.get();
    patch(panel.body, view(state));
    slot.attach(panel.body.querySelector('.ap-chart'));
    subtitle.textContent = subtitleOf(lastAp);
    feedChart(state);
  };
  const offs = [
    ctx.store.subscribe((s) => s.aps, render),
    ctx.store.subscribe((s) => s.favorites, render),
    ctx.store.subscribe(
      (s) => s.rssi,
      () => lastAp.connected && render(),
    ),
  ];
  if (typeof ctx.onCleanup === 'function') ctx.onCleanup(() => panel.close());
  render();
  return panel;
}

// ---------------------------------------------------------------------------
// Painel de uma rede (vários BSSIDs com o mesmo nome)
// ---------------------------------------------------------------------------

const SERIES_TOKENS = ['--cat-1', '--cat-2', '--cat-3', '--cat-5', '--cat-6', '--cat-7', '--cat-4', '--cat-8'];
const MAX_NET_SERIES = 6;

/**
 * Abre os detalhes de uma rede (um nome). Com um BSSID só, abre direto o painel dele.
 * @param {object} ctx
 * @param {string} networkKey  state.networks[].key
 * @returns {ReturnType<typeof sheet>|null}
 */
export function openNetworkDetail(ctx, networkKey) {
  const find = () => ctx.store.get().networks.find((n) => n.key === networkKey) || null;
  const first = find();
  if (!first) {
    toast('Esta rede saiu do alcance.');
    return null;
  }
  if (first.aps.length === 1) return openApDetail(ctx, first.best.bssid);

  let last = first;
  // cada BSSID fica com a mesma cor enquanto o painel estiver aberto, mesmo que a ordem mude
  const colorOf = new Map();
  const tokenFor = (bssid) => {
    if (!colorOf.has(bssid)) colorOf.set(bssid, SERIES_TOKENS[colorOf.size % SERIES_TOKENS.length]);
    return colorOf.get(bssid);
  };
  const slot = chartSlot({ windowMs: 120_000, height: 190, labels: true, zoneWords: false, ariaLabel: 'Sinal de cada ponto de acesso desta rede nos últimos 2 minutos' });
  const radioLabel = (ap) => `${ap.band ? fmtBand(ap.band) : '?'} · canal ${ap.channel ?? '?'}`;

  const countLine = (net) => `${plural(net.aps.length, 'sinal', 'sinais')} em ${plural(net.devices, 'roteador', 'roteadores')}${net.bands.length ? ` · ${bandsText(net.bands)}` : ''}`;

  function view(state) {
    const found = find();
    const gone = !found;
    const net = found || last;
    last = net;
    const lead = net.aps.find((a) => a.connected) || net.best;
    const now = currentRssi(state, lead);
    const shown = net.aps.slice(0, MAX_NET_SERIES);
    for (const ap of shown) tokenFor(ap.bssid);

    return [
      h(
        'div.ap-head',
        { key: 'head' },
        signalBlock(now.rssi, { live: now.live, stale: net.aps.every((a) => a.stale) || gone, ageMs: lead.ageMs }),
        h(
          'div.ap-badges',
          null,
          net.aps.some((a) => a.connected) ? badge('Conectado', { tone: 'accent', icon: 'check' }) : null,
          net.aps.some((a) => a.favorite) ? badge('Minha', { tone: 'accent', icon: 'star-filled' }) : null,
          net.bands.map((b) => bandBadge(b)),
          net.mesh ? badge('Vários roteadores', { outline: true, title: 'Mesh, repetidor ou mais de um ponto de acesso com o mesmo nome' }) : null,
          securityBadge(net.security),
        ),
      ),
      gone ? banner({ key: 'gone', tone: 'warning', icon: 'clock', title: 'Esta rede saiu do alcance', text: 'Ela não aparece mais nas buscas. Os dados abaixo são os da última vez em que foi ouvida.' }) : null,
      chartCard('Cada sinal desta rede', sourceNote(state, false)),
      ownRow(ctx, net),
      h(
        'section',
        { key: 'radios', class: 'stack stack--sm' },
        h('h3.ap-section-title', null, 'Pontos de acesso desta rede'),
        h('p.ap-section-text', null, 'O mesmo nome pode vir de mais de um rádio: um por faixa do roteador e um por repetidor. O celular escolhe sozinho em qual ficar.'),
        h(
          'div.card.card--flush.list',
          null,
          net.aps.map((ap) => radioRow(ap, { dot: colorOf.get(ap.bssid), onClick: (a) => openApDetail(ctx, a.bssid) })),
        ),
      ),
      securityCard(net.security),
      gone ? null : actionRows(ctx, lead),
    ];
  }

  function feedChart(state) {
    const chart = slot.chart;
    if (!chart) return;
    chart.setGap(scanGapMs(state));
    const lead = last.aps.find((a) => a.connected) || last.best;
    chart.setSeries(
      last.aps.slice(0, MAX_NET_SERIES).map((ap) => ({
        id: ap.bssid,
        label: radioLabel(ap),
        color: tokenFor(ap.bssid),
        points: ctx.store.history(ap.bssid),
        emphasis: ap.bssid === lead.bssid,
      })),
    );
  }

  const subtitle = h('span', null, countLine(first));
  const panel = sheet({
    title: h('span.ap-title', { dir: 'auto' }, displaySsid(first.ssid)),
    subtitle,
    content: [],
    tall: true,
    onClose: () => {
      open.delete(panel);
      for (const off of offs) off();
      slot.destroy();
    },
  });
  panel.el.classList.add('ap-sheet');
  panel.el.dataset.network = networkKey;
  open.add(panel);

  const render = () => {
    if (!panel.isOpen()) return;
    const state = ctx.store.get();
    patch(panel.body, view(state));
    slot.attach(panel.body.querySelector('.ap-chart'));
    subtitle.textContent = countLine(last);
    feedChart(state);
  };
  const offs = [
    ctx.store.subscribe((s) => s.aps, render),
    ctx.store.subscribe((s) => s.favorites, render),
    ctx.store.subscribe(
      (s) => s.rssi,
      () => last.aps.some((a) => a.connected) && render(),
    ),
  ];
  if (typeof ctx.onCleanup === 'function') ctx.onCleanup(() => panel.close());
  render();
  return panel;
}
