// Exportar: a lista de redes como planilha (CSV) e como JSON (bridge.saveFile), e um relatório
// em texto para ler ou mandar a alguém (bridge.share), com a prévia do que vai sair.
//
// Os textos são montados por export-format.js (funções puras, testadas). O relatório junta a
// conexão, as redes e três análises: o melhor canal por faixa (core/channel-rating.js), a
// melhor rede (core/best-network.js) e o diagnóstico (core/insights.js). As duas últimas são
// carregadas com import() protegido: se um dos módulos faltar ou falhar, o relatório sai sem
// aquela seção em vez de a tela quebrar.
//
// O arquivo é montado de novo na hora do toque (dados mais recentes); a prévia acompanha as buscas.
// Ganchos para os testes: data-format (formato em prévia), data-count (sinais na lista).

import { h, patch, sheet, toast, fmtAgo, plural } from '../dom.js';
import { icon } from '../icons.js';
import { button, iconButton, segmented, banner, emptyState, skeletonList } from '../components.js';
import { indoorDistance } from '../../core/signal.js';
import { standardInfo } from '../../core/phy.js';
import { securityTypeLabel } from '../../core/security.js';
import { bandOf, freqToChannel } from '../../core/channels.js';
import { recommendChannel } from '../../core/channel-rating.js';
import { buildCsv, buildJson, buildReport, networkRecord, fileName, utf8Length, formatBytes, previewOf } from './export-format.js';
import { useToolsCss, copyWithToast } from './conexao.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isText = (x) => typeof x === 'string' && x.trim() !== '';
const lower = (x) => (typeof x === 'string' ? x.toLowerCase() : '');

const FORMATS = [
  { value: 'report', label: 'Relatório', icon: 'file' },
  { value: 'csv', label: 'Planilha', icon: 'grid' },
  { value: 'json', label: 'JSON', icon: 'layers' },
];

const ABOUT = {
  report: {
    title: 'Relatório em texto',
    text: 'Um resumo para ler ou mandar a alguém: a sua conexão, a melhor rede aqui, o melhor canal para o roteador, o diagnóstico e as redes ao redor.',
  },
  csv: {
    title: 'Planilha (CSV)',
    text: 'Uma linha para cada sinal ouvido, com nome, canal, segurança e força. Abre no Excel, no LibreOffice e no Planilhas Google.',
  },
  json: {
    title: 'Dados em JSON',
    text: 'Os mesmos dados em um formato para programas e scripts. Para quem quer analisar por conta própria.',
  },
};

const BANDS = ['2.4', '5', '6'];

/** Módulo opcional: null se não existir ou não carregar. */
const optional = (load) => load().catch(() => null);

/** Os dados da conexão que o relatório cita. */
function connectionFacts(state, ap) {
  const conn = state.connection;
  if (!conn || conn.connected !== true) return null;
  const sample = state.rssi && (!state.rssi.bssid || lower(state.rssi.bssid) === lower(conn.bssid)) ? state.rssi : null;
  const rssi = sample && isNum(sample.rssi) ? sample.rssi : conn.rssi;
  const freq = isNum(conn.frequency) && conn.frequency > 0 ? conn.frequency : ap ? ap.freq : null;
  const band = ap && ap.band ? ap.band : bandOf(freq);
  let standard = ap && isText(ap.standardLabel) ? ap.standardLabel : null;
  if (isNum(conn.wifiStandard) && conn.wifiStandard > 0) standard = standardInfo(conn.wifiStandard, band ?? freq).label;
  let security = ap && ap.security && ap.security.known !== false ? ap.security.label : null;
  if (!security && isNum(conn.securityType) && conn.securityType >= 0) security = securityTypeLabel(conn.securityType);
  return {
    ssid: isText(conn.ssid) ? conn.ssid : ap ? ap.ssid : '',
    rssi,
    band,
    channel: ap && isNum(ap.channel) ? ap.channel : freqToChannel(freq),
    widthMHz: ap && isNum(ap.widthMHz) ? ap.widthMHz : null,
    linkSpeed: isNum(conn.rxSpeed) && conn.rxSpeed > 0 ? conn.rxSpeed : conn.linkSpeed,
    standard,
    security,
    distanceM: indoorDistance(rssi, freq),
  };
}

export async function mount(root, ctx) {
  const { store, bridge, scanLoop } = ctx;
  let alive = true;
  let format = 'report';
  let busy = false;

  const [, bestMod, insightsMod] = await Promise.all([
    useToolsCss(),
    optional(() => import('../../core/best-network.js')),
    optional(() => import('../../core/insights.js')),
  ]);
  // o usuário pode ter saído enquanto os módulos chegavam
  if (!root.isConnected) return { unmount() {} };
  root.classList.add('exp');

  // --- montagem dos textos ------------------------------------------------------------------

  /** As análises do relatório. Cada uma é protegida: a que falhar só fica de fora. */
  function analyse(state) {
    const { aps, connection, info, favorites, status } = state;
    const connBssid = connection && connection.connected && isText(connection.bssid) ? lower(connection.bssid) : undefined;

    const channels = [];
    for (const band of BANDS) {
      const inBand = aps.filter((ap) => ap.band === band);
      if (!inBand.length) continue;
      // o roteador do usuário nesta faixa: o conectado, senão o mais forte entre os "da casa"
      const own = inBand.find((ap) => ap.connected) || inBand.find((ap) => ap.own) || null;
      try {
        const rec = recommendChannel(aps, { band, own });
        if (rec && isText(rec.text)) channels.push({ band, text: rec.text });
      } catch {
        // sem recomendação para esta faixa
      }
    }

    let advice = null;
    let ranking = null;
    if (bestMod && typeof bestMod.rankNetworks === 'function') {
      try {
        const rank = bestMod.rankNetworks(aps, { device: info || undefined, connectionBssid: connBssid, favorites });
        ranking = rank.map((r) => ({ name: r.ssid, hidden: r.hidden === true, score: r.score, estMbps: r.estMbps, connected: r.connected === true, mine: r.favorite === true }));
        if (typeof bestMod.advise === 'function') {
          const adv = bestMod.advise(rank, { connectionBssid: connBssid, favorites });
          if (adv && isText(adv.headline)) advice = { headline: adv.headline, text: adv.text };
        }
      } catch {
        advice = null;
        ranking = null;
      }
    }

    let insights = null;
    if (insightsMod && typeof insightsMod.buildInsights === 'function') {
      try {
        const list = insightsMod.buildInsights({ aps, connection: connection || undefined, device: info || undefined, status: status || undefined });
        insights = (Array.isArray(list) ? list : []).map((i) => ({ severity: i.severity, title: i.title, text: i.text }));
      } catch {
        insights = null;
      }
    }
    return { channels, advice, ranking, insights };
  }

  /** O conteúdo de um formato, a partir do estado de agora. */
  function build(kind, { forFile = false } = {}) {
    const state = store.get();
    const now = Date.now();
    const appVersion = state.info && isText(state.info.appVersion) ? state.info.appVersion : '';
    if (kind === 'csv') {
      return { kind, name: fileName('redes', 'csv', now), mime: 'text/csv', text: buildCsv(state.aps, { bom: forFile }) };
    }
    if (kind === 'json') {
      const text = buildJson({ generatedAt: now, appVersion, device: state.info, connection: state.connection, scannedAt: state.scan.dataAt, aps: state.aps });
      return { kind, name: fileName('redes', 'json', now), mime: 'application/json', text };
    }
    const connAp = store.connectedAp();
    const text = buildReport({
      generatedAt: now,
      appVersion,
      device: state.info,
      dataAgeMs: isNum(state.scan.dataAt) ? now - state.scan.dataAt : null,
      connection: connectionFacts(state, connAp),
      ...analyse(state),
      networks: state.networks.map(networkRecord),
      signals: state.aps.length,
    });
    return { kind, name: fileName('relatorio', 'txt', now), mime: 'text/plain', text };
  }

  // a prévia só é refeita quando os dados mudam (não a cada segundo do relógio)
  let cache = null;
  function preview() {
    const state = store.get();
    const key = [format, state.scan.seq, state.aps.length, state.vendorsReady, state.favorites.size, state.connection && state.connection.connected ? state.connection.bssid : ''].join('|');
    if (!cache || cache.key !== key) {
      let file;
      try {
        file = build(format);
      } catch (err) {
        console.warn('[exportar] não foi possível montar a prévia', err);
        file = { kind: format, name: '', mime: '', text: '', failed: true };
      }
      cache = { key, file, size: utf8Length(file.text), part: previewOf(file.text, format === 'report' ? 400 : format === 'csv' ? 13 : 40) };
    }
    return cache;
  }

  // --- ações --------------------------------------------------------------------------------

  const problem = (text) => toast(text, { action: { label: 'Copiar', onClick: copy } });

  async function run(task) {
    if (busy) return;
    busy = true;
    draw();
    try {
      await task();
    } finally {
      busy = false;
      draw();
    }
  }

  function copy() {
    let file;
    try {
      file = build(format);
    } catch {
      toast('Não foi possível montar o conteúdo agora.');
      return Promise.resolve();
    }
    return copyWithToast(file.text, format === 'report' ? 'Relatório copiado' : 'Conteúdo copiado');
  }

  const save = () =>
    run(async () => {
      try {
        const file = build(format, { forFile: true });
        const res = await bridge.saveFile({ name: file.name, mime: file.mime, text: file.text });
        if (!alive) return;
        if (res && res.ok === true) toast(store.get().backend === 'sim' ? 'Na demonstração o arquivo é baixado pelo navegador.' : 'Arquivo pronto: escolha onde salvar ou para quem enviar.');
        else problem('Não foi possível criar o arquivo. Você ainda pode copiar o conteúdo.');
      } catch {
        if (alive) problem('Não foi possível criar o arquivo. Você ainda pode copiar o conteúdo.');
      }
    });

  const share = () =>
    run(async () => {
      try {
        const file = build('report');
        const res = await bridge.share('Relatório do Wi-Fi (WiFi Raio-X)', file.text);
        if (!alive) return;
        if (!res || res.ok === false) problem('Não foi possível abrir o compartilhamento. Você ainda pode copiar o relatório.');
        else if (store.get().backend === 'sim') toast('Na demonstração o relatório vai para o navegador (compartilhar ou copiar).');
      } catch {
        if (alive) problem('Não foi possível abrir o compartilhamento. Você ainda pode copiar o relatório.');
      }
    });

  async function rescan() {
    const res = await scanLoop.scanNow().catch(() => null);
    if (!alive || !res || res.accepted || res.reason === 'busy') return;
    toast(res.reason === 'throttled' ? 'O Android limitou as buscas por enquanto. A lista continua a mesma.' : 'Não deu para buscar agora. Tente de novo em instantes.');
  }

  /** A prévia inteira num painel, para ler com calma antes de mandar. */
  function openFull() {
    let file;
    try {
      file = build(format);
    } catch {
      toast('Não foi possível montar o conteúdo agora.');
      return;
    }
    const report = format === 'report';
    const text = file.text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
    const panel = sheet({
      title: ABOUT[format].title,
      subtitle: report ? 'É assim que o texto vai ser compartilhado' : `${file.name} · ${formatBytes(utf8Length(file.text))}`,
      tall: true,
      content: h('pre', { class: ['exp-preview__text', 'exp-preview__text--full', report && 'exp-preview__text--wrap'], tabIndex: 0, dataset: { hscroll: true, nodrag: true }, dir: 'ltr' }, text),
      footer: [
        button('Copiar', { variant: 'secondary', icon: 'copy', onClick: () => copyWithToast(file.text.replace(/^\ufeff/, ''), report ? 'Relatório copiado' : 'Conteúdo copiado') }),
        button(report ? 'Compartilhar' : 'Salvar arquivo', {
          variant: 'primary',
          icon: report ? 'share' : 'download',
          onClick: () => {
            panel.close();
            if (report) share();
            else save();
          },
        }),
      ],
    });
  }

  // --- visão --------------------------------------------------------------------------------

  function summary(state) {
    const age = isNum(state.scan.dataAt) ? Date.now() - state.scan.dataAt : null;
    const old = isNum(age) && age > 60_000;
    return h(
      'section.card.exp-summary',
      { key: 'summary' },
      h('span.exp-summary__icon', null, icon('export')),
      h(
        'div.exp-summary__body',
        null,
        h('h2.exp-summary__title', null, `${plural(state.networks.length, 'rede', 'redes')} · ${plural(state.aps.length, 'sinal', 'sinais')}`),
        h(
          'p.exp-summary__sub',
          { class: old ? 'warning' : null },
          isNum(age) ? (age < 2000 ? 'Lista atualizada agora' : `Lista atualizada ${fmtAgo(age)}`) : 'Lista guardada pelo celular',
          old ? '. Toque em buscar, lá em cima, antes de exportar.' : '',
        ),
      ),
      state.backend === 'sim' ? h('span.exp-summary__tag', null, 'Simulado') : null,
    );
  }

  function view() {
    const state = store.get();
    root.dataset.format = format;
    root.dataset.count = String(state.aps.length);

    if (!state.aps.length) {
      if (state.scan.seq === 0) return [h('div', { key: 'wait' }, skeletonList(4))];
      return [
        emptyState({
          icon: 'export',
          title: 'Ainda não há redes para exportar',
          text: 'Nenhuma rede Wi-Fi foi ouvida por aqui. Faça uma busca e volte para salvar ou compartilhar a lista.',
          action: { label: 'Buscar agora', icon: 'refresh', onClick: rescan },
        }),
      ];
    }

    const { file, size, part } = preview();
    const about = ABOUT[format];
    const wrap = format === 'report';
    const actions =
      format === 'report'
        ? [
            button('Compartilhar', { key: 'share', variant: 'primary', icon: 'share', disabled: busy || !file.text, onClick: share }),
            button('Copiar', { key: 'copy', variant: 'secondary', icon: 'copy', disabled: !file.text, onClick: copy }),
          ]
        : [
            button('Salvar arquivo', { key: 'save', variant: 'primary', icon: 'download', disabled: busy || !file.text, onClick: save }),
            button('Copiar', { key: 'copy', variant: 'secondary', icon: 'copy', disabled: !file.text, onClick: copy }),
          ];

    return [
      summary(state),
      h(
        'div',
        { key: 'formats' },
        segmented(
          FORMATS,
          format,
          (value) => {
            format = value;
            draw();
          },
          { label: 'Formato' },
        ),
      ),
      h(
        'section.card.exp-format',
        { key: 'format' },
        h('h3.card__title', null, about.title),
        h('p.exp-format__text', null, about.text),
        file.failed
          ? banner({ key: 'failed', tone: 'critical', text: 'Não foi possível montar este conteúdo agora. Tente outro formato ou faça uma nova busca.' })
          : h(
              'figure.exp-preview',
              { key: `preview-${format}`, 'aria-label': 'Prévia do que será exportado' },
              h(
                'figcaption.exp-preview__head',
                null,
                h('span.exp-preview__name', null, wrap ? 'Prévia do relatório' : file.name),
                h('span.exp-preview__size', null, formatBytes(size)),
                iconButton('maximize', 'Ver a prévia inteira', openFull, { class: 'icon-btn icon-btn--muted exp-preview__open' }),
              ),
              // a prévia é texto: nomes de rede entram por textContent, nunca como HTML
              h('pre', { class: ['exp-preview__text', wrap && 'exp-preview__text--wrap'], tabIndex: 0, dataset: { hscroll: true, nodrag: true }, dir: 'ltr' }, part.text),
              part.more ? h('div.exp-preview__more', null, `… e mais ${plural(part.more, 'linha', 'linhas')} no arquivo`) : null,
            ),
        h('div.exp-actions', { key: 'actions' }, actions),
      ),
      banner({
        key: 'privacy',
        tone: 'neutral',
        icon: 'shield',
        title: 'O que vai junto',
        text: 'Os nomes e os endereços (BSSID) das redes ao redor, inclusive as dos vizinhos, e o nome da sua. Nenhuma senha. O app não envia nada sozinho: é você quem escolhe para onde isto vai.',
      }),
    ];
  }

  function draw() {
    if (alive) patch(root, view());
  }

  const offs = [
    store.subscribe((s) => s.aps, draw),
    store.subscribe((s) => s.scan, draw),
    store.subscribe((s) => s.connection, draw),
    store.subscribe((s) => s.backend, draw),
  ];
  // "atualizada há X s" anda mesmo sem busca nova
  const clock = setInterval(() => {
    if (!document.hidden) draw();
  }, 5000);
  draw();

  return {
    unmount() {
      alive = false;
      for (const off of offs) off();
      clearInterval(clock);
    },
  };
}
