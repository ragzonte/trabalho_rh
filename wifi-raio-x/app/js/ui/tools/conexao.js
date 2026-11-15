// Detalhes da conexão: tudo o que o Android informa sobre o Wi-Fi em que o celular está,
// agrupado (rede, sinal e velocidade, endereços), em palavras simples e com "tocar para copiar".
//
// Fontes: store.connection (reenviada pelo celular a cada mudança), uma leitura nova de
// bridge.connection() ao abrir, as leituras do sinal (store.rssi, uma por segundo: sinal e
// velocidade do enlace ao vivo) e o Ap do store para o que só a varredura sabe (canal, largura,
// fabricante, problemas de segurança).
//
// Este módulo também exporta duas ajudas usadas pelas outras ferramentas deste grupo
// (medidor.js e exportar.js):
//   useToolsCss() -> Promise   carrega css/tools-a.css uma vez (resolve quando a folha chegou)
//   copyText(texto) -> Promise<boolean>   copia para a área de transferência (com plano B)

import { h, patch, toast, fmtDbm, fmtMbps, fmtMeters, fmtPct, fmtFreq, fmtWidth, fmtBand, fmtDuration, plural, THIN } from '../dom.js';
import { icon } from '../icons.js';
import { button, iconButton, emptyState, sectionHeader, signalBars, signalWord, ssidLabel, displaySsid, badge, meter, listRow } from '../components.js';
import { signalLevel, qualityPct, indoorDistance } from '../../core/signal.js';
import { standardInfo, usableMbps } from '../../core/phy.js';
import { securityTypeLabel } from '../../core/security.js';
import { bandOf, freqToChannel } from '../../core/channels.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isText = (x) => typeof x === 'string' && x.trim() !== '';

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
    // dentro de um painel o resto da página fica inerte: o campo temporário vai na camada de cima
    const host = (active && active.closest && active.closest('.layer')) || document.body;
    host.appendChild(area);
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
export async function copyWithToast(text, what = 'Copiado') {
  const ok = await copyText(text);
  toast(ok ? what : 'Não foi possível copiar aqui. Toque e segure o texto para copiar.');
  return ok;
}

// ---------------------------------------------------------------------------
// Textos
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

const lower = (x) => (typeof x === 'string' ? x.toLowerCase() : '');

/** Resumo em texto de tudo o que a tela mostra (botão "copiar tudo"). */
export function connectionText(view) {
  const lines = ['Detalhes da conexão Wi-Fi', ''];
  for (const group of view.groups) {
    lines.push(group.title);
    for (const row of group.rows) lines.push(`  ${row.label}: ${row.copy ?? row.text}`);
    lines.push('');
  }
  lines.push('Gerado pelo WiFi Raio-X.');
  return lines.join('\n');
}

/**
 * Monta os grupos de linhas a partir da conexão (dados, não elementos: serve para a tela e
 * para o "copiar tudo").
 * @param {import('../../bridge.js').Connection} conn
 * @param {object|null} ap    o Ap do store para o BSSID conectado (pode faltar)
 */
export function describeConnection(conn, ap) {
  const freq = isNum(conn.frequency) ? conn.frequency : ap ? ap.freq : null;
  const band = ap && ap.band ? ap.band : bandOf(freq);
  const channel = ap && isNum(ap.channel) ? ap.channel : freqToChannel(freq);
  const std = isNum(conn.wifiStandard) && conn.wifiStandard > 0 ? standardInfo(conn.wifiStandard, band ?? freq) : null;
  const level = signalLevel(conn.rssi);

  // --- rede
  const net = [];
  const hiddenName = conn.hidden === true || (ap && ap.hidden);
  if (isText(conn.ssid)) net.push({ label: 'Nome da rede', text: displaySsid(conn.ssid), copy: conn.ssid, ssid: conn.ssid, copyable: true, what: 'Nome da rede' });
  else net.push({ label: 'Nome da rede', text: hiddenName ? 'Rede oculta' : 'O Android não informou', muted: true });
  if (conn.hidden === true) net.push({ label: 'Rede oculta', text: 'Sim', hint: 'Ela não divulga o nome: quem quer entrar precisa digitá-lo.' });
  if (isText(conn.bssid)) net.push({ label: 'Endereço do roteador (BSSID)', text: conn.bssid, mono: true, copyable: true, what: 'BSSID' });
  if (ap && ap.vendor) net.push({ label: 'Fabricante', text: ap.vendorGuess ? `${ap.vendor} (provável)` : ap.vendor });

  let securityText = null;
  if (isNum(conn.securityType) && conn.securityType >= 0) securityText = securityTypeLabel(conn.securityType);
  else if (ap && ap.security && ap.security.known !== false) securityText = ap.security.label;
  if (securityText) {
    const issue = ap && ap.security && Array.isArray(ap.security.issues) ? ap.security.issues.find((i) => i.severity === 'high' || i.severity === 'medium') : null;
    const open = conn.securityType === 0;
    net.push({
      label: 'Segurança',
      text: securityText,
      tone: open || conn.securityType === 1 ? 'warning' : null,
      hint: issue ? issue.text : open ? 'Sem senha: o que você envia pode ser visto por quem estiver por perto.' : null,
    });
  }
  if (std && std.label) net.push({ label: 'Padrão', text: std.label });
  else if (ap && ap.standardLabel) net.push({ label: 'Padrão', text: ap.standardLabel });

  if (conn.validated === true) net.push({ label: 'Internet', text: 'Funcionando', tone: 'good', hint: 'O Android confirmou que esta rede dá acesso à internet.' });
  else if (conn.validated === false) {
    net.push({
      label: 'Internet',
      text: 'Sem acesso confirmado',
      tone: 'warning',
      hint: 'O celular está no Wi-Fi, mas o Android não conseguiu chegar à internet. Pode ser uma falha do provedor ou uma rede que pede login.',
    });
  }
  if (conn.metered === true) net.push({ label: 'Franquia de dados', text: 'Rede limitada', hint: 'O Android trata esta rede como tendo limite de dados (como o roteador de um celular) e economiza nela.' });
  else if (conn.metered === false) net.push({ label: 'Franquia de dados', text: 'Sem limite', hint: 'O Android trata esta rede como ilimitada.' });

  // --- sinal e velocidade
  const sig = [];
  if (isNum(conn.rssi)) sig.push({ label: 'Sinal', text: `${fmtDbm(conn.rssi)} · ${level.label}`, hint: level.hint, key: 'rssi' });
  if (isNum(conn.rssi)) sig.push({ label: 'Qualidade', text: fmtPct(qualityPct(conn.rssi)), key: 'quality' });
  const dist = indoorDistance(conn.rssi, freq);
  if (isNum(dist)) sig.push({ label: 'Distância do roteador', text: fmtMeters(dist, { approx: true }), hint: 'Estimativa pelo sinal: paredes mudam bastante o resultado.', key: 'distance' });
  if (band) sig.push({ label: 'Faixa', text: fmtBand(band) });
  if (isNum(channel)) sig.push({ label: 'Canal', text: String(channel), hint: 'A “pista” da estrada que o seu Wi-Fi usa.' });
  if (isNum(freq)) sig.push({ label: 'Frequência', text: fmtFreq(freq) });
  if (ap && isNum(ap.widthMHz)) sig.push({ label: 'Largura do canal', text: fmtWidth(ap.widthMHz), hint: 'Canal mais largo carrega mais dados, mas sofre mais com vizinhos.' });

  // --- endereços
  const addr = [];
  if (isText(conn.ip)) addr.push({ label: 'IP do celular', text: conn.ip, mono: true, copyable: true, what: 'IP do celular' });
  const mask = maskOf(conn.prefix);
  if (mask) addr.push({ label: 'Máscara de sub-rede', text: `${mask} (/${conn.prefix})`, mono: true });
  if (isText(conn.gateway)) {
    addr.push({ label: 'Roteador (gateway)', text: conn.gateway, mono: true, copyable: true, what: 'Endereço do roteador', hint: 'Digite este endereço no navegador para abrir a página de configuração do roteador.' });
  }
  const dns = Array.isArray(conn.dns) ? conn.dns.filter(isText) : [];
  dns.forEach((d, i) => addr.push({ label: dns.length > 1 ? `DNS ${i + 1}` : 'DNS', text: d, mono: true, copyable: true, what: 'DNS', hint: i === 0 ? 'O “catálogo” que traduz nomes de sites em endereços.' : null }));
  const v6 = Array.isArray(conn.ipv6) ? conn.ipv6.filter(isText) : [];
  v6.forEach((a, i) => addr.push({ label: v6.length > 1 ? `IPv6 ${i + 1}` : 'IPv6', text: a, mono: true, copyable: true, what: 'Endereço IPv6' }));
  if (isText(conn.iface)) addr.push({ label: 'Interface', text: conn.iface, mono: true });
  if (isNum(conn.mtu) && conn.mtu > 0) addr.push({ label: 'MTU', text: `${conn.mtu}${THIN}bytes`, hint: 'Tamanho máximo de cada pacote de dados.' });
  const lease = leaseText(conn.leaseSec);
  if (lease) addr.push({ label: 'Endereço válido por', text: lease, hint: 'Depois disso o celular renova o endereço com o roteador (DHCP).' });

  // --- velocidade (parte visual: o texto vai junto para o "copiar tudo")
  const rx = isNum(conn.rxSpeed) && conn.rxSpeed > 0 ? conn.rxSpeed : null;
  const tx = isNum(conn.txSpeed) && conn.txSpeed > 0 ? conn.txSpeed : isNum(conn.linkSpeed) && conn.linkSpeed > 0 ? conn.linkSpeed : null;
  const maxRx = isNum(conn.maxRxSpeed) && conn.maxRxSpeed > 0 ? conn.maxRxSpeed : null;
  const maxTx = isNum(conn.maxTxSpeed) && conn.maxTxSpeed > 0 ? conn.maxTxSpeed : null;
  const speed = { rx, tx, maxRx, maxTx, usable: usableMbps(rx ?? tx) };
  const speedRows = [];
  if (rx !== null) speedRows.push({ label: 'Velocidade do enlace (receber)', text: maxRx ? `${fmtMbps(rx)} de ${fmtMbps(maxRx)}` : fmtMbps(rx) });
  if (tx !== null) speedRows.push({ label: 'Velocidade do enlace (enviar)', text: maxTx ? `${fmtMbps(tx)} de ${fmtMbps(maxTx)}` : fmtMbps(tx) });

  return {
    conn,
    ap,
    band,
    channel,
    std,
    level,
    speed,
    groups: [
      { id: 'rede', title: 'Rede', rows: net },
      { id: 'sinal', title: 'Sinal e velocidade', rows: [...sig, ...speedRows] },
      { id: 'enderecos', title: 'Endereços', rows: addr },
    ].filter((g) => g.rows.length),
    sig,
  };
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

function kvRow(row) {
  const value = h(
    'span.cnx-kv__value',
    { class: [row.mono && 'mono', row.muted && 'muted', row.tone], dir: row.ssid ? 'auto' : undefined },
    row.text,
  );
  const body = [
    h('span.cnx-kv__main', null, h('span.cnx-kv__label', null, row.label), value, row.copyable ? h('span.cnx-kv__copy', null, icon('copy', { size: 18 })) : null),
    row.hint ? h('span.cnx-kv__hint', null, row.hint) : null,
  ];
  const key = `kv-${row.label}`;
  if (!row.copyable) return h('div.cnx-kv__row', { key, dataset: { field: row.key } }, body);
  return h(
    'button.cnx-kv__row.cnx-kv__row--tap',
    { key, type: 'button', 'aria-label': `Copiar ${row.label}: ${row.text}`, onClick: () => copyWithToast(row.copy ?? row.text, `${row.what || row.label}: copiado`) },
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
    max ? h('span.cnx-speed__max', null, `${fmtPct(pct)} do máximo que esta conexão suporta (${fmtMbps(max)})`) : null,
  );
}

function speedCard(view) {
  const { rx, tx, maxRx, maxTx, usable } = view.speed;
  if (rx === null && tx === null) return null;
  const best = Math.max(maxRx || 0, maxTx || 0);
  const now = rx ?? tx;
  let advice = 'É a velocidade da “conversa” entre o celular e o roteador. A internet do seu plano pode ser mais lenta que isso.';
  if (best && now / best < 0.5) advice = 'A conversa com o roteador está em menos da metade do que esta conexão alcança. Chegar mais perto dele costuma resolver.';
  return h(
    'section.card.cnx-speed',
    { key: 'speed' },
    h('h3.card__title', null, 'Velocidade do enlace'),
    rx !== null ? speedBar('Receber', 'download', rx, maxRx) : null,
    tx !== null ? speedBar('Enviar', 'upload', tx, maxTx) : null,
    h('p.card__text', null, advice),
    isNum(usable) && usable > 0
      ? h('p.cnx-speed__usable', null, icon('speed', { size: 18 }), h('span', null, 'Na prática, este Wi-Fi entrega cerca de ', h('strong', null, fmtMbps(usable, { approx: true })), ' (estimativa: parte da velocidade é consumida pelo próprio protocolo).'))
      : null,
  );
}

function hero(view) {
  const { conn, ap, band, channel, std } = view;
  const sub = [ap && ap.vendor, band ? fmtBand(band) : null, isNum(channel) ? `Canal ${channel}` : null].filter(Boolean).join(' · ');
  return h(
    'section.card.cnx-hero',
    { key: 'hero' },
    h(
      'div.cnx-hero__top',
      null,
      h('span.cnx-hero__bars', null, signalBars(conn.rssi, { size: 'lg' })),
      h('div.cnx-hero__id', null, h('h2.cnx-hero__name', null, ssidLabel(isText(conn.ssid) ? conn.ssid : '')), sub ? h('p.cnx-hero__sub', null, sub) : null),
      badge('Conectado', { tone: 'good', icon: 'check' }),
    ),
    h(
      'div.cnx-hero__signal',
      { class: `sig-${view.level.key}` },
      h('span.cnx-hero__dbm', { dataset: { field: 'hero-rssi' } }, fmtDbm(conn.rssi, { unit: false }), h('span.cnx-hero__unit', null, 'dBm')),
      h('span.cnx-hero__word', null, signalWord(conn.rssi), h('span.cnx-hero__hint', null, view.level.hint)),
    ),
    h(
      'div.cluster',
      null,
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

  await useToolsCss();
  if (!alive) return { unmount() {} };
  root.classList.add('cnx');

  /** A conexão como o app a conhece agora: store + leitura ao abrir + sinal ao vivo. */
  function current() {
    const state = store.get();
    let conn = state.connection;
    if (!conn || conn.connected !== true) return null;
    if (polled && polled.connected === false) return null;
    if (polled && polled.connected && lower(polled.bssid) === lower(conn.bssid)) conn = { ...conn, ...polled };
    const s = state.rssi;
    if (s && isNum(s.rssi) && (!s.bssid || !conn.bssid || lower(s.bssid) === lower(conn.bssid))) {
      conn = { ...conn, rssi: s.rssi };
      if (isNum(s.linkSpeed)) conn.linkSpeed = s.linkSpeed;
      if (isNum(s.txSpeed)) conn.txSpeed = s.txSpeed;
      if (isNum(s.rxSpeed)) conn.rxSpeed = s.rxSpeed;
      if (isNum(s.frequency) && s.frequency > 0) conn.frequency = s.frequency;
    }
    return conn;
  }

  async function openWifi() {
    if (opening) return;
    opening = true;
    try {
      const res = await bridge.openSettings('wifi');
      if (!res || res.ok === false) toast('Não foi possível abrir. Procure “Wi-Fi” nas configurações do Android.');
      else if (store.get().backend === 'sim') toast('Na demonstração não há configurações do Android para abrir.');
    } catch {
      toast('Não foi possível abrir. Procure “Wi-Fi” nas configurações do Android.');
    } finally {
      opening = false;
    }
  }

  function view() {
    const conn = current();
    if (!conn) {
      ctx.setActions();
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
    ctx.setActions(iconButton('copy', 'Copiar todos os detalhes', () => copyWithToast(connectionText(data), 'Detalhes da conexão copiados')));

    const out = [hero(data)];
    for (const group of data.groups) {
      out.push(h('div', { key: `h-${group.id}` }, sectionHeader(group.title)));
      // a velocidade tem um cartão próprio (barras); as linhas de texto dela só entram no "copiar tudo"
      const rows = group.rows.filter((r) => !/^Velocidade do enlace/.test(r.label));
      out.push(h('section.card.card--flush.cnx-kv', { key: `g-${group.id}`, dataset: { group: group.id } }, rows.map(kvRow)));
      if (group.id === 'sinal') out.push(speedCard(data));
    }

    out.push(
      h('div', { key: 'h-atalhos' }, sectionHeader('Atalhos')),
      h(
        'section.card.card--flush.list',
        { key: 'atalhos' },
        listRow({ key: 'medidor', icon: 'target', title: 'Medir o sinal ao vivo', subtitle: 'Ache os pontos fracos e o roteador', chevron: true, href: '#/ferramentas/medidor' }),
        listRow({ key: 'wifi', icon: 'settings', neutral: true, title: 'Abrir o Wi-Fi do sistema', subtitle: 'Trocar de rede ou esquecer esta', trail: icon('external', { size: 20 }), onClick: openWifi }),
      ),
      h(
        'div.cnx-actions',
        { key: 'actions' },
        button('Copiar tudo', { variant: 'secondary', icon: 'copy', block: true, onClick: () => copyWithToast(connectionText(data), 'Detalhes da conexão copiados') }),
      ),
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

  store.subscribe((s) => s.connection, schedule);
  store.subscribe((s) => s.rssi, schedule);
  store.subscribe((s) => s.aps, schedule);
  store.subscribe((s) => s.backend, () => {
    polled = null;
    schedule();
  });
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
    if (!document.hidden) {
      polled = null;
      schedule();
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  return {
    unmount() {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      root.classList.remove('cnx');
    },
  };
}
