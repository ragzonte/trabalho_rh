// Detalhes da conexão: tudo o que o Android informa sobre o Wi-Fi em que o celular está,
// agrupado (rede, sinal e velocidade, endereços), em palavras simples e com "tocar para copiar".
//
// Fontes: store.connection (reenviada pelo celular a cada mudança), uma leitura nova de
// bridge.connection() ao abrir, as leituras do sinal (store.rssi, uma por segundo: sinal e
// velocidade do enlace ao vivo) e o Ap do store para o que só a varredura sabe (canal, largura,
// fabricante, problemas de segurança).
//
// Este módulo também exporta as ajudas usadas pelas outras ferramentas deste grupo
// (medidor.js e exportar.js):
//   useToolsCss() -> Promise              carrega css/tools-a.css uma vez (resolve quando a folha chegou)
//   copyText(texto) -> Promise<boolean>   copia para a área de transferência (com plano B)
//   copyWithToast(texto, aviso)           copia e avisa o resultado

import { h, patch, toast, fmtDbm, fmtMbps, fmtMeters, fmtPct, fmtFreq, fmtWidth, fmtBand, fmtDuration, plural, THIN } from '../dom.js';
import { icon } from '../icons.js';
import { button, iconButton, emptyState, sectionHeader, signalBars, signalWord, ssidLabel, displaySsid, badge, meter, listRow } from '../components.js';
import { signalLevel, qualityPct, indoorDistance } from '../../core/signal.js';
import { standardInfo, usableMbps } from '../../core/phy.js';
import { securityTypeLabel } from '../../core/security.js';
import { bandOf, freqToChannel } from '../../core/channels.js';
import { liveConnection } from '../networks-logic.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isText = (x) => typeof x === 'string' && x.trim() !== '';
const lower = (x) => (typeof x === 'string' ? x.toLowerCase() : '');

// ---------------------------------------------------------------------------
// Ajudas compartilhadas com medidor.js e exportar.js
// ---------------------------------------------------------------------------

let cssReady = null;

/**
 * Carrega a folha de estilo deste grupo de ferramentas (css/tools-a.css), uma vez por página.
 * @returns {Promise<void>} resolve quando a folha foi aplicada (ou depois de 1,5 s, o que vier primeiro)
 */
export function useToolsCss() {
  if (cssReady) return cssReady;
  cssReady = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../../../css/tools-a.css', import.meta.url).href;
    link.dataset.wrxCss = 'tools-a';
    const done = () => resolve();
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, 1500);
    document.head.appendChild(link);
  });
  return cssReady;
}

/**
 * Copia um texto para a área de transferência. Tenta a API nova e, se o WebView não deixar,
 * o caminho antigo (seleção + "copy").
 * @param {string} text
 * @returns {Promise<boolean>} true se copiou
 */
export async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // sem permissão ou sem foco: tenta o caminho antigo
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    const active = document.activeElement;
    // com um painel aberto o resto da página fica inerte: o campo temporário vai na camada de cima
    const host = (active && active.closest && active.closest('.layer')) || document.body;
    host.appendChild(area);
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    area.remove();
    if (active && typeof active.focus === 'function') active.focus({ preventScroll: true });
    return !!ok;
  } catch {
    return false;
  }
}

/** Copia e avisa (ou explica que não deu). */
export async function copyWithToast(text, done = 'Copiado') {
  const ok = await copyText(text);
  toast(ok ? done : 'Não foi possível copiar aqui.');
  return ok;
}

// ---------------------------------------------------------------------------
// Dados -> linhas (sem elementos: serve para a tela e para o "copiar tudo")
// ---------------------------------------------------------------------------

/** 24 -> "255.255.255.0" */
export function maskOf(prefix) {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const bits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [bits >>> 24, (bits >>> 16) & 255, (bits >>> 8) & 255, bits & 255].join('.');
}

/** Duração do "aluguel" do endereço: 86400 -> "1 dia"; 7200 -> "2 horas". */
export function leaseText(sec) {
  if (!isNum(sec) || sec <= 0) return null;
  if (sec >= 86_400 && sec % 86_400 === 0) return plural(sec / 86_400, 'dia', 'dias');
  if (sec >= 3600 && sec % 3600 === 0) return plural(sec / 3600, 'hora', 'horas');
  return fmtDuration(sec * 1000);
}

/**
 * @typedef {Object} DetailRow
 * @property {string} label
 * @property {string} text          valor mostrado
 * @property {string} [copy]        valor copiado quando difere do mostrado
 * @property {string} [hint]        explicação em uma linha
 * @property {boolean} [copyable]   a linha inteira vira um botão "copiar"
 * @property {boolean} [mono]       endereço: letra de largura fixa
 * @property {boolean} [ssid]       nome de rede (texto hostil: isolado e numa linha)
 * @property {'good'|'warning'} [tone]
 * @property {string} [field]       nome estável para os testes
 */

/**
 * Monta os grupos de linhas a partir da conexão.
 * @param {import('../../bridge.js').Connection} conn
 * @param {object|null} ap    o Ap do store para o BSSID conectado (pode faltar)
 * @returns {{conn:object, ap:object|null, band:string|null, channel:number|null, std:object|null, level:object,
 *            speed:{rx:number|null, tx:number|null, maxRx:number|null, maxTx:number|null, usable:number|null},
 *            groups:{id:string, title:string, rows:DetailRow[], textRows:DetailRow[]}[]}}
 */
export function describeConnection(conn, ap) {
  const freq = isNum(conn.frequency) && conn.frequency > 0 ? conn.frequency : ap ? ap.freq : null;
  const band = ap && ap.band ? ap.band : bandOf(freq);
  const channel = ap && isNum(ap.channel) ? ap.channel : freqToChannel(freq);
  const std = isNum(conn.wifiStandard) && conn.wifiStandard > 0 ? standardInfo(conn.wifiStandard, band ?? freq) : null;
  const level = signalLevel(conn.rssi);

  // --- rede
  const net = [];
  if (isText(conn.ssid)) net.push({ label: 'Nome da rede', text: displaySsid(conn.ssid), copy: conn.ssid, ssid: true, copyable: true, field: 'ssid' });
  else net.push({ label: 'Nome da rede', text: conn.hidden === true || (ap && ap.hidden) ? 'Rede oculta' : 'O Android não informou', muted: true, field: 'ssid' });
  if (conn.hidden === true) net.push({ label: 'Rede oculta', text: 'Sim', hint: 'Ela não divulga o nome: para entrar é preciso digitá-lo.' });
  if (isText(conn.bssid)) net.push({ label: 'BSSID', text: conn.bssid, mono: true, copyable: true, hint: 'O endereço físico do rádio do roteador em que o celular está.', field: 'bssid' });
  if (ap && ap.vendor) net.push({ label: 'Fabricante', text: ap.vendorGuess ? `${ap.vendor} (provável)` : ap.vendor });

  let securityText = null;
  if (isNum(conn.securityType) && conn.securityType >= 0) securityText = securityTypeLabel(conn.securityType);
  else if (ap && ap.security && ap.security.known !== false) securityText = ap.security.label;
  if (securityText) {
    const issues = ap && ap.security && Array.isArray(ap.security.issues) ? ap.security.issues : [];
    const issue = issues.find((i) => i && (i.severity === 'high' || i.severity === 'medium'));
    const weak = conn.securityType === 0 || conn.securityType === 1;
    net.push({
      label: 'Segurança',
      text: securityText,
      tone: weak || (issue && issue.severity === 'high') ? 'warning' : undefined,
      hint: issue ? issue.text : conn.securityType === 0 ? 'Sem senha: o que você envia pode ser visto por quem estiver por perto.' : undefined,
      field: 'security',
    });
  }
  if (std) net.push({ label: 'Padrão', text: std.label, field: 'standard' });
  else if (ap && ap.standardLabel) net.push({ label: 'Padrão', text: ap.standardLabel, field: 'standard' });

  if (conn.validated === true) net.push({ label: 'Internet', text: 'Funcionando', tone: 'good', hint: 'O Android confirmou que esta rede dá acesso à internet.', field: 'validated' });
  else if (conn.validated === false) {
    net.push({
      label: 'Internet',
      text: 'Sem acesso confirmado',
      tone: 'warning',
      hint: 'O celular está no Wi-Fi, mas o Android não conseguiu chegar à internet. Pode ser falha do provedor ou uma rede que pede login.',
      field: 'validated',
    });
  }
  if (conn.metered === true) {
    net.push({ label: 'Franquia de dados', text: 'Rede com limite', tone: 'warning', hint: 'O Android trata esta rede como tendo limite de dados (como o roteador de um celular) e economiza nela.', field: 'metered' });
  } else if (conn.metered === false) {
    net.push({ label: 'Franquia de dados', text: 'Sem limite', hint: 'O Android trata esta rede como ilimitada.', field: 'metered' });
  }

  // --- sinal
  const sig = [];
  if (isNum(conn.rssi)) {
    sig.push({ label: 'Sinal', text: `${fmtDbm(conn.rssi)} · ${level.label}`, field: 'rssi' });
    sig.push({ label: 'Qualidade', text: fmtPct(qualityPct(conn.rssi)), field: 'quality' });
  }
  const dist = indoorDistance(conn.rssi, freq);
  if (isNum(dist)) sig.push({ label: 'Distância do roteador', text: fmtMeters(dist, { approx: true }), hint: 'Estimativa pelo sinal: paredes mudam bastante o resultado.', field: 'distance' });
  if (band) sig.push({ label: 'Faixa', text: fmtBand(band), field: 'band' });
  if (isNum(channel)) sig.push({ label: 'Canal', text: String(channel), hint: 'A “pista” da estrada que o seu Wi-Fi usa.', field: 'channel' });
  if (isNum(freq)) sig.push({ label: 'Frequência', text: fmtFreq(freq) });
  if (ap && isNum(ap.widthMHz)) sig.push({ label: 'Largura do canal', text: fmtWidth(ap.widthMHz), hint: 'Canal mais largo carrega mais dados, mas sofre mais com os vizinhos.' });

  // --- velocidade: na tela vira um cartão com barras; em texto, duas linhas
  const positive = (x) => (isNum(x) && x > 0 ? x : null);
  const rx = positive(conn.rxSpeed);
  const tx = positive(conn.txSpeed) ?? positive(conn.linkSpeed);
  const maxRx = positive(conn.maxRxSpeed);
  const maxTx = positive(conn.maxTxSpeed);
  const speed = { rx, tx, maxRx, maxTx, usable: usableMbps(rx ?? tx) };
  const speedRows = [];
  if (rx !== null) speedRows.push({ label: 'Velocidade do enlace (receber)', text: maxRx ? `${fmtMbps(rx)} de ${fmtMbps(maxRx)} possíveis` : fmtMbps(rx) });
  if (tx !== null) speedRows.push({ label: 'Velocidade do enlace (enviar)', text: maxTx ? `${fmtMbps(tx)} de ${fmtMbps(maxTx)} possíveis` : fmtMbps(tx) });

  // --- endereços
  const addr = [];
  if (isText(conn.ip)) addr.push({ label: 'IP do celular', text: conn.ip, mono: true, copyable: true, field: 'ip' });
  const mask = maskOf(conn.prefix);
  if (mask) {
    const hosts = conn.prefix <= 30 ? 2 ** (32 - conn.prefix) - 2 : null;
    const room = hosts ? `: cabem até ${plural(hosts, 'aparelho', 'aparelhos')} nesta rede` : '';
    addr.push({ label: 'Máscara de sub-rede', text: mask, copy: `${mask} (/${conn.prefix})`, mono: true, hint: `Prefixo /${conn.prefix}${room}.`, field: 'mask' });
  }
  if (isText(conn.gateway)) {
    addr.push({ label: 'Roteador (gateway)', text: conn.gateway, mono: true, copyable: true, hint: 'Digite este endereço no navegador para abrir a página de configuração do roteador.', field: 'gateway' });
  }
  const dns = Array.isArray(conn.dns) ? conn.dns.filter(isText) : [];
  dns.forEach((d, i) => {
    addr.push({ label: dns.length > 1 ? `DNS ${i + 1}` : 'DNS', text: d, mono: true, copyable: true, hint: i === 0 ? 'O “catálogo” que traduz nomes de sites em endereços.' : undefined, field: `dns${i}` });
  });
  const v6 = Array.isArray(conn.ipv6) ? conn.ipv6.filter(isText) : [];
  v6.forEach((a, i) => addr.push({ label: v6.length > 1 ? `IPv6 ${i + 1}` : 'IPv6', text: a, mono: true, copyable: true, field: `ipv6${i}` }));
  if (isText(conn.iface)) addr.push({ label: 'Interface', text: conn.iface, mono: true });
  if (isNum(conn.mtu) && conn.mtu > 0) addr.push({ label: 'MTU', text: `${conn.mtu}${THIN}bytes`, hint: 'Tamanho máximo de cada pacote de dados.' });
  const lease = leaseText(conn.leaseSec);
  if (lease) addr.push({ label: 'Endereço válido por', text: lease, hint: 'Depois disso o celular renova o endereço com o roteador (DHCP).', field: 'lease' });

  return {
    conn,
    ap,
    band,
    channel,
    std,
    level,
    speed,
    groups: [
      { id: 'rede', title: 'Rede', rows: net, textRows: [] },
      { id: 'sinal', title: 'Sinal e velocidade', rows: sig, textRows: speedRows },
      { id: 'enderecos', title: 'Endereços', rows: addr, textRows: [] },
    ].filter((g) => g.rows.length + g.textRows.length > 0),
  };
}

/** Resumo em texto de tudo o que a tela mostra (botão "copiar tudo"). */
export function connectionText(data) {
  const lines = ['Detalhes da conexão Wi-Fi', ''];
  for (const group of data.groups) {
    lines.push(group.title);
    for (const row of [...group.rows, ...group.textRows]) lines.push(`  ${row.label}: ${row.copy ?? row.text}`);
    lines.push('');
  }
  lines.push('Gerado no celular pelo WiFi Raio-X.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

/** @param {DetailRow} row  @param {boolean} gutter  o grupo tem linhas copiáveis: todas guardam a coluna do ícone */
function kvRow(row, gutter) {
  const main = h(
    'span.cnx-kv__main',
    null,
    h('span.cnx-kv__label', null, row.label),
    h('span', { class: ['cnx-kv__value', row.mono && 'mono', row.muted && 'muted', row.tone, row.ssid && 'cnx-kv__value--ssid'], dir: row.ssid ? 'auto' : undefined }, row.text),
    row.copyable ? h('span.cnx-kv__copy', null, icon('copy', { size: 18 })) : gutter ? h('span.cnx-kv__copy', { 'aria-hidden': 'true' }) : null,
  );
  const body = [main, row.hint ? h('span.cnx-kv__hint', null, row.hint) : null];
  const key = `kv-${row.label}`;
  if (!row.copyable) return h('div.cnx-kv__row', { key, dataset: { field: row.field } }, body);
  return h(
    'button.cnx-kv__row.cnx-kv__row--tap',
    { key, type: 'button', dataset: { field: row.field }, 'aria-label': `Copiar ${row.label}: ${row.text}`, onClick: () => copyWithToast(row.copy ?? row.text, `${row.label}: copiado`) },
    body,
  );
}

function speedBar(label, hint, now, max) {
  const pct = max ? Math.min(100, (now / max) * 100) : null;
  return h(
    'div.cnx-speed__item',
    { key: label },
    h('div.cnx-speed__head', null, h('span.cnx-speed__label', null, label, h('span.cnx-speed__hint', null, hint)), h('span.cnx-speed__value', null, fmtMbps(now))),
    pct !== null ? meter(pct, { label: `${label}: ${fmtPct(pct)} do máximo`, thick: true }) : null,
    max ? h('span.cnx-speed__max', null, `${fmtPct(pct)} do máximo desta conexão (${fmtMbps(max)})`) : null,
  );
}

function speedCard(data) {
  const { rx, tx, maxRx, maxTx, usable } = data.speed;
  if (rx === null && tx === null) return null;
  const best = Math.max(maxRx || 0, maxTx || 0);
  const now = rx ?? tx;
  let advice = 'É a velocidade da “conversa” entre o celular e o roteador. A internet do seu plano pode ser mais lenta que isso.';
  if (best && now / best < 0.5) advice = 'A conversa com o roteador está em menos da metade do que esta conexão alcança. Chegar mais perto dele costuma resolver.';
  return h(
    'section.card.cnx-speed',
    { key: 'speed', dataset: { group: 'velocidade' } },
    h('h3.card__title', null, 'Velocidade do enlace'),
    rx !== null ? speedBar('Receber', 'download', rx, maxRx) : null,
    tx !== null ? speedBar('Enviar', 'upload', tx, maxTx) : null,
    h('p.card__text', null, advice),
    isNum(usable) && usable > 0
      ? h(
          'p.cnx-speed__usable',
          null,
          icon('speed', { size: 18 }),
          h('span', null, 'Na prática, este Wi-Fi entrega cerca de ', h('strong', null, fmtMbps(usable, { approx: true })), ' (estimativa: parte da velocidade fica com o próprio protocolo).'),
        )
      : null,
  );
}

function hero(data) {
  const { conn, ap, band, channel, std } = data;
  const sub = [ap && ap.vendor, band ? fmtBand(band) : null, isNum(channel) ? `Canal ${channel}` : null].filter(Boolean).join(' · ');
  return h(
    'section.card.cnx-hero',
    { key: 'hero' },
    h(
      'div.cnx-hero__top',
      null,
      h('span.cnx-hero__bars', null, signalBars(conn.rssi, { size: 'lg' })),
      h('div.cnx-hero__id', null, h('h2.cnx-hero__name', null, ssidLabel(isText(conn.ssid) ? conn.ssid : '')), sub ? h('p.cnx-hero__sub', null, sub) : null),
    ),
    isNum(conn.rssi)
      ? h(
          'div',
          { class: ['cnx-hero__signal', `sig-${data.level.key}`] },
          h('span.cnx-hero__dbm', { dataset: { field: 'hero-rssi' } }, fmtDbm(conn.rssi, { unit: false }), h('span.cnx-hero__unit', null, 'dBm')),
          h('span.cnx-hero__word', null, signalWord(conn.rssi), h('span.cnx-hero__hint', null, data.level.hint)),
        )
      : null,
    h(
      'div.cluster',
      null,
      badge('Conectado', { tone: 'good', icon: 'check' }),
      std ? badge(std.short, { outline: true, title: std.label }) : null,
      conn.validated === true ? badge('Internet funcionando', { tone: 'good', icon: 'globe' }) : null,
      conn.validated === false ? badge('Sem internet confirmada', { tone: 'warning', icon: 'warning' }) : null,
      conn.metered === true ? badge('Rede com limite de dados', { tone: 'warning', icon: 'info' }) : null,
    ),
  );
}

export async function mount(root, ctx) {
  const { store, bridge } = ctx;
  let alive = true;
  let polled = null; // leitura direta de bridge.connection() ao abrir
  let opening = false;
  let actionsFor = null; // 'on' | 'off': os botões da barra de cima só são trocados quando o estado muda
  let latest = null; // os dados da última renderização (para o "copiar tudo" da barra de cima)

  await useToolsCss();
  // o usuário pode ter saído enquanto a folha de estilo chegava
  if (!root.isConnected) return { unmount() {} };
  root.classList.add('cnx');

  /** A conexão como o app a conhece agora: store + leitura ao abrir + sinal ao vivo. */
  function current() {
    const state = store.get();
    let conn = state.connection;
    if (!conn || conn.connected !== true) return null;
    if (polled && polled.connected === false) return null;
    if (polled && polled.connected && lower(polled.bssid) === lower(conn.bssid)) conn = { ...conn, ...polled };
    // o sinal e as velocidades da leitura de cada segundo por cima (a mesma regra do diagnóstico e do exportar)
    return liveConnection({ connection: conn, rssi: state.rssi });
  }

  async function openWifi() {
    if (opening) return;
    if (store.get().backend === 'sim') {
      toast('Na demonstração não há configurações do Android para abrir.');
      return;
    }
    opening = true;
    try {
      const res = await bridge.openSettings('panel');
      if (!res || res.ok === false) toast('Não foi possível abrir. Procure “Wi-Fi” nas configurações do Android.');
    } catch {
      toast('Não foi possível abrir. Procure “Wi-Fi” nas configurações do Android.');
    } finally {
      opening = false;
    }
  }

  const copyAll = () => latest && copyWithToast(connectionText(latest), 'Detalhes da conexão copiados');

  function setActions(kind) {
    if (actionsFor === kind) return;
    actionsFor = kind;
    if (kind === 'on') ctx.setActions(iconButton('copy', 'Copiar todos os detalhes', copyAll));
    else ctx.setActions();
  }

  function view() {
    const conn = current();
    if (!conn) {
      latest = null;
      setActions('off');
      return [
        emptyState({
          icon: 'wifi-off',
          title: 'Você não está conectado a um Wi-Fi',
          text: 'Conecte o celular a uma rede para ver aqui os detalhes dela: endereço IP, roteador, velocidade e segurança.',
          action: { label: 'Abrir o Wi-Fi', icon: 'external', onClick: openWifi },
          secondary: { label: 'Ver as redes ao redor', onClick: () => ctx.navigate('/redes') },
        }),
      ];
    }
    const ap = isText(conn.bssid) ? store.apById(conn.bssid) : store.connectedAp();
    const data = describeConnection(conn, ap);
    latest = data;
    setActions('on');

    const out = [hero(data)];
    for (const group of data.groups) {
      out.push(h('div', { key: `h-${group.id}` }, sectionHeader(group.title)));
      if (group.rows.length) {
        const gutter = group.rows.some((r) => r.copyable);
        out.push(h('section.card.card--flush.cnx-kv', { key: `g-${group.id}`, dataset: { group: group.id } }, group.rows.map((row) => kvRow(row, gutter))));
      }
      if (group.id === 'sinal') out.push(speedCard(data));
    }
    out.push(
      h('div', { key: 'h-atalhos' }, sectionHeader('Atalhos')),
      h(
        'section.card.card--flush.list',
        { key: 'atalhos' },
        listRow({ key: 'medidor', icon: 'target', title: 'Medir o sinal ao vivo', subtitle: 'Ache os pontos fracos e o roteador', chevron: true, href: '#/ferramentas/medidor' }),
        listRow({ key: 'wifi', icon: 'wifi', title: 'Abrir o Wi-Fi do sistema', subtitle: 'Trocar de rede ou esquecer esta', trail: icon('external', { size: 20 }), onClick: openWifi }),
      ),
      h('div.cnx-actions', { key: 'actions' }, button('Copiar tudo', { variant: 'secondary', icon: 'copy', block: true, onClick: copyAll })),
      h('p.t-xs.muted.center', { key: 'foot' }, 'Toque num endereço para copiar. Nada disto sai do seu celular.'),
    );
    return out;
  }

  let queued = false;
  function draw() {
    queued = false;
    if (alive) patch(root, view());
  }
  // as leituras do sinal chegam uma por segundo (ou mais): junta o que mudar no mesmo quadro
  function schedule() {
    if (queued || !alive) return;
    queued = true;
    requestAnimationFrame(draw);
  }

  // o que o celular reenviar depois vale mais que a leitura feita ao abrir
  const fresh = () => {
    polled = null;
    schedule();
  };
  const offs = [
    store.subscribe((s) => s.connection, fresh),
    store.subscribe((s) => s.backend, fresh),
    store.subscribe((s) => s.rssi, schedule),
    store.subscribe((s) => s.aps, schedule),
  ];
  draw();

  bridge
    .connection()
    .then((conn) => {
      if (!alive || !conn || typeof conn !== 'object') return;
      polled = conn;
      schedule();
    })
    .catch(() => {});

  // ao voltar das configurações do Android a conexão pode ser outra: a leitura de abertura caduca
  const onVisible = () => {
    if (document.hidden) return;
    polled = null;
    schedule();
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    unmount() {
      alive = false;
      for (const off of offs) off();
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
