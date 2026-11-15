// Peças prontas da interface, montadas com h() sobre as classes de css/app.css.
// Todas são funções puras "dados -> elemento": servem tanto para montar uma vez quanto para
// refazer a tela inteira e aplicar com patch() (ui/dom.js).
//
// Sinal            signalBars(rssi) · signalBadge(rssi, {layout}) · signalWord(rssi) · signalClass(rssi) · signalColor(rssi)
// Selos            badge(texto, {tone, icon}) · bandBadge(faixa) · securityBadge(security) · standardBadge(ap)
//                  bandColor(faixa) (para gráficos)
// Redes            ssidLabel(ssid) · displaySsid(ssid) · apRow(ap, {onClick, ...})
// Botões           button(rótulo, {variant, icon, onClick}) · iconButton(ícone, rótulo, onClick) · chip(rótulo, {selected, onClick})
//                  segmented(opções, valor, onChange)
// Estrutura        card({title, text, tone}, ...filhos) · listRow({...}) · sectionHeader(título, {count, action})
//                  statTile({label, value, unit, hint}) · kvList(linhas) · meter(pct, {tone})
// Estados          emptyState({...}) · errorState({...}) · skeletonList(n) · spinner() · banner({...}) · tipBanner({...})
// Formulário       switchRow({...}) · select(opções, valor, onChange) · slider({...}) · textField({...})
// Limite do Android  throttleTip(ctx) · openThrottleHelp(ctx)

import { h, sheet, toast, cssVar, fmtDbm, fmtBand, fmtAgo, uid, NO_VALUE } from './dom.js';
import { icon } from './icons.js';
import { signalLevel } from '../core/signal.js';
import { standardInfo } from '../core/phy.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------------------
// Sinal
// ---------------------------------------------------------------------------

// A cor segue o número de barras: 4 barras = 1ª cor da escala ... nenhuma = 5ª.
const SIG_TOKEN = { excellent: '--sig-1', great: '--sig-1', good: '--sig-2', fair: '--sig-3', weak: '--sig-4', 'very-weak': '--sig-5', unknown: '--sig-5' };

/** Classe CSS que define a cor do sinal (--sig) para este RSSI: 'sig-good', 'sig-weak'... */
export function signalClass(rssi) {
  return `sig-${signalLevel(rssi).key}`;
}

/** Cor do sinal já resolvida no tema atual (para canvas). */
export function signalColor(rssi) {
  return cssVar(SIG_TOKEN[signalLevel(rssi).key]);
}

/**
 * Barras de sinal (4 degraus) com descrição para leitor de tela.
 * @param {number} rssi dBm
 * @param {{size?:'sm'|'md'|'lg'}} [options]
 */
export function signalBars(rssi, { size = 'md' } = {}) {
  const level = signalLevel(rssi);
  return h(
    'span',
    {
      class: ['bars', size !== 'md' && `bars--${size}`, `sig-${level.key}`],
      dataset: { bars: level.bars },
      role: 'img',
      'aria-label': `Sinal: ${level.label.toLowerCase()}`,
    },
    h('i'),
    h('i'),
    h('i'),
    h('i'),
  );
}

/** A palavra do sinal na cor da escala: "Bom", "Fraco"... */
export function signalWord(rssi) {
  const level = signalLevel(rssi);
  return h('span', { class: ['sig-text', `sig-${level.key}`] }, level.label);
}

/**
 * Sinal completo: barras + número em dBm + palavra (a cor nunca vai sozinha).
 * @param {number} rssi
 * @param {{layout?:'inline'|'stack', bars?:boolean, size?:'sm'|'md'|'lg'}} [options]
 *        'stack' = número em cima e palavra embaixo, alinhados à direita (coluna das listas)
 */
export function signalBadge(rssi, { layout = 'inline', bars = layout === 'inline', size = 'md' } = {}) {
  const level = signalLevel(rssi);
  return h(
    'span',
    { class: ['signal', layout === 'stack' && 'signal--stack', `sig-${level.key}`] },
    bars ? signalBars(rssi, { size }) : null,
    h('span.signal__dbm', null, fmtDbm(rssi)),
    h('span.signal__word', null, level.label),
  );
}

// ---------------------------------------------------------------------------
// Selos
// ---------------------------------------------------------------------------

/**
 * Selo pequeno.
 * @param {string|Node} text
 * @param {{tone?:'good'|'warning'|'critical'|'info'|'accent'|'b24'|'b5'|'b6', icon?:string, outline?:boolean, plain?:boolean, title?:string}} [options]
 */
export function badge(text, { tone, icon: iconName, outline = false, plain = false, title } = {}) {
  return h(
    'span',
    { class: ['badge', tone && `badge--${tone}`, outline && 'badge--outline', plain && 'badge--plain'], title },
    iconName ? icon(iconName, { size: 14 }) : null,
    text,
  );
}

function bandKey(band) {
  if (isNum(band) && band > 100) {
    if (band >= 2400 && band <= 2500) return '2.4';
    if (band >= 5150 && band <= 5895) return '5';
    if (band >= 5925 && band <= 7125) return '6';
    if (band >= 57000 && band <= 71000) return '60';
    return null;
  }
  const key = band == null ? '' : String(band).replace(',', '.');
  return key === '2.4' || key === '5' || key === '6' || key === '60' ? key : null;
}

const BAND_TONE = { 2.4: 'b24', 5: 'b5', 6: 'b6' };
const BAND_TOKEN = { 2.4: '--band-24', 5: '--band-5', 6: '--band-6' };

/** Selo da faixa na cor de identidade: "2,4 GHz" âmbar, "5 GHz" ciano, "6 GHz" violeta. Aceita a chave ou MHz. */
export function bandBadge(band, { plain = false } = {}) {
  const key = bandKey(band);
  if (!key) return badge(NO_VALUE, { plain });
  return h('span', { class: ['badge', BAND_TONE[key] && `badge--${BAND_TONE[key]}`, plain && 'badge--plain'] }, plain ? h('span.dot') : null, fmtBand(key));
}

/** Cor de identidade da faixa no tema atual (para gráficos). Faixa desconhecida usa a cor de texto apagado. */
export function bandColor(band) {
  const key = bandKey(band);
  return cssVar(BAND_TOKEN[key] || '--muted');
}

// nível de segurança (core/security.js) -> tom e ícone
const SECURITY_LOOK = [
  { tone: 'warning', icon: 'lock-open' }, // 0: aberta
  { tone: 'critical', icon: 'lock-open' }, // 1: WEP (quebrada)
  { tone: 'warning', icon: 'lock' }, // 2: fraca
  { tone: undefined, icon: 'lock' }, // 3: boa
  { tone: 'good', icon: 'lock' }, // 4: forte
];

/**
 * Selo de segurança: cadeado + rótulo ("WPA2", "Aberta", "WPA2/WPA3"...), no tom do nível.
 * @param {import('../core/security.js').Security} security
 * @param {{plain?:boolean}} [options]  plain = sem fundo, para linhas compactas
 */
export function securityBadge(security, { plain = false } = {}) {
  if (!security || security.known === false) return badge('Segurança desconhecida', { icon: 'help', plain });
  const look = SECURITY_LOOK[security.level] || SECURITY_LOOK[3];
  // numa linha compacta só os problemas ganham cor; "segura" fica discreta
  const tone = plain && look.tone === 'good' ? undefined : look.tone;
  return badge(security.label || 'Desconhecida', { tone, icon: look.icon, plain });
}

function standardShort(source) {
  if (typeof source === 'string') return source;
  if (!source || typeof source !== 'object') return null;
  // Ap de core/model.js: `standard` é o rótulo curto; sem geração conhecida não há o que mostrar
  if (typeof source.standard === 'string') {
    if (!isNum(source.gen)) return null;
    // geração presumida pela faixa e pela largura: é o mínimo, pode ser mais nova
    return source.genSource === 'inferred' && source.gen < 7 ? `${source.standard}+` : source.standard;
  }
  const raw = source.raw && typeof source.raw === 'object' ? source.raw : source;
  if (isNum(raw.wifiStandard) && raw.wifiStandard > 0) return standardInfo(raw.wifiStandard, source.band ?? raw.frequency).short;
  return null;
}

/**
 * Selo da geração: "Wi-Fi 6", "Wi-Fi 6E"; "Wi-Fi 5+" quando a geração é só presumida.
 * Aceita um Ap (do store), um ScanAp cru ou o texto pronto. Sem dado, devolve null.
 */
export function standardBadge(source, { plain = false } = {}) {
  const text = standardShort(source);
  if (!text) return null;
  const title = source && typeof source === 'object' && typeof source.standardLabel === 'string' ? source.standardLabel : undefined;
  return badge(text, { plain, outline: !plain, title });
}

// ---------------------------------------------------------------------------
// Redes
// ---------------------------------------------------------------------------

/** Nome para mostrar: troca caracteres de controle por "·" e redes sem nome por "Rede oculta". */
export function displaySsid(ssid) {
  const text = typeof ssid === 'string' ? ssid.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '·').trim() : '';
  return text || 'Rede oculta';
}

/**
 * Nome de rede como elemento: uma linha, com reticências, isolado do texto em volta
 * (um nome com caracteres da direita para a esquerda não embaralha a linha).
 */
export function ssidLabel(ssid, { tag = 'span' } = {}) {
  const hidden = typeof ssid !== 'string' || ssid.trim() === '';
  return h(tag, { class: ['ssid', hidden && 'ssid--hidden'], dir: 'auto' }, displaySsid(ssid));
}

/**
 * Linha de uma rede (um BSSID) para listas: barras, nome, canal · faixa · segurança, e o
 * sinal em dBm com a palavra. Usa os campos do Ap do store (ui/../store.js).
 * @param {object} ap
 * @param {{onClick?:(ap:object) => void, showVendor?:boolean}} [options]
 */
export function apRow(ap, { onClick, showVendor = true } = {}) {
  // do mais importante para o menos: em telas estreitas os últimos itens ficam de fora
  const sub = [];
  if (ap.connected) sub.push(h('span.accent.strong', null, 'Conectada'));
  if (ap.band) sub.push(bandBadge(ap.band, { plain: true }));
  if (ap.security) sub.push(securityBadge(ap.security, { plain: true }));
  if (ap.channel != null) sub.push(h('span', null, `Canal ${ap.channel}`));
  if (showVendor && ap.vendor) sub.push(h('span', null, ap.vendor));
  if (ap.stale && isNum(ap.ageMs)) sub.push(h('span', null, `visto ${fmtAgo(ap.ageMs)}`));

  const body = [
    h('span.row__lead', null, signalBars(ap.rssi)),
    h(
      'span.row__body',
      null,
      h(
        'span.row__title',
        null,
        ssidLabel(ap.ssid),
        ap.favorite ? icon('star-filled', { size: 16, label: 'Minha rede', class: 'accent' }) : null,
      ),
      // os itens entram por ordem de importância: o que não couber na linha fica de fora (CSS)
      h('span.row__sub.row__sub--clip', null, sub),
    ),
    h('span.row__trail', null, signalBadge(ap.rssi, { layout: 'stack' })),
  ];
  const props = { key: ap.id || ap.bssid, class: ['row', onClick && 'row--tappable', ap.stale && 'row--stale'] };
  if (!onClick) return h('div', props, body);
  return h('button', { ...props, type: 'button', onClick: () => onClick(ap) }, body);
}

// ---------------------------------------------------------------------------
// Botões
// ---------------------------------------------------------------------------

/**
 * Botão com texto.
 * @param {string} label
 * @param {{variant?:'primary'|'secondary'|'quiet'|'danger'|'danger-quiet', icon?:string, onClick?:(ev:Event) => void,
 *          block?:boolean, small?:boolean, disabled?:boolean, type?:string, wrap?:boolean}} [options]
 */
export function button(label, { variant = 'secondary', icon: iconName, onClick, block = false, small = false, disabled = false, type = 'button', wrap = false, ...rest } = {}) {
  return h(
    'button',
    { type, class: ['btn', `btn--${variant}`, block && 'btn--block', small && 'btn--sm', wrap && 'btn--wrap'], disabled, onClick, ...rest },
    iconName ? icon(iconName, { size: small ? 18 : 20 }) : null,
    label,
  );
}

/**
 * Botão só com ícone (44 × 44). O rótulo é obrigatório: é o que o leitor de tela anuncia.
 * @param {string} iconName
 * @param {string} label
 * @param {(ev:Event) => void} [onClick]
 * @param {{muted?:boolean, pressed?:boolean, disabled?:boolean}} [options]
 */
export function iconButton(iconName, label, onClick, { muted = false, pressed, disabled = false, ...rest } = {}) {
  return h(
    'button',
    { type: 'button', class: ['icon-btn', muted && 'icon-btn--muted'], 'aria-label': label, 'aria-pressed': pressed, disabled, onClick, ...rest },
    icon(iconName),
  );
}

/**
 * Chip de filtro (liga/desliga).
 * @param {string} label
 * @param {{selected?:boolean, onClick?:(ev:Event) => void, icon?:string, count?:number}} [options]
 */
export function chip(label, { selected = false, onClick, icon: iconName, count } = {}) {
  return h(
    'button.chip',
    { type: 'button', 'aria-pressed': !!selected, onClick },
    iconName ? icon(iconName, { size: 16 }) : null,
    label,
    isNum(count) ? h('span.chip__count', null, count) : null,
  );
}

/**
 * Controle segmentado (uma escolha entre poucas).
 * @param {(string|{value:any, label:string, icon?:string})[]} options
 * @param {any} value
 * @param {(value:any) => void} onChange
 * @param {{label?:string, inline?:boolean}} [extra]  label = nome do grupo para leitor de tela
 */
export function segmented(options, value, onChange, { label, inline = false } = {}) {
  const opts = options.map((o) => (o !== null && typeof o === 'object' ? o : { value: o, label: String(o) }));
  const pick = (group, index, focus) => {
    const buttons = Array.from(group.children);
    buttons.forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === index));
      b.tabIndex = i === index ? 0 : -1;
    });
    if (focus) buttons[index].focus();
    onChange(opts[index].value);
  };
  return h(
    'div',
    {
      class: ['seg', inline && 'seg--inline'],
      role: 'radiogroup',
      'aria-label': label,
      onKeyDown: (ev) => {
        const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        ev.preventDefault();
        const buttons = Array.from(ev.currentTarget.children);
        const at = Math.max(0, buttons.indexOf(document.activeElement));
        pick(ev.currentTarget, (at + step + buttons.length) % buttons.length, true);
      },
    },
    opts.map((o, i) =>
      h(
        'button.seg__opt',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': o.value === value,
          tabIndex: o.value === value ? 0 : -1,
          onClick: (ev) => o.value !== value && pick(ev.currentTarget.parentNode, i, false),
        },
        o.icon ? icon(o.icon, { size: 18 }) : null,
        o.label,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Estrutura
// ---------------------------------------------------------------------------

/**
 * Cartão. Com `onClick` vira um botão.
 * @param {{title?:string, text?:string, tone?:'accent'|'good'|'warning'|'critical', flush?:boolean, onClick?:() => void, key?:string}} [options]
 */
export function card({ title, text, tone, flush = false, onClick, key, ...rest } = {}, ...children) {
  const cls = ['card', tone && `card--${tone}`, flush && 'card--flush', onClick && 'card--tappable'];
  return h(
    onClick ? 'button' : 'section',
    { class: cls, key, type: onClick ? 'button' : undefined, onClick, ...rest },
    title ? h('h3.card__title', null, title) : null,
    text ? h('p.card__text', null, text) : null,
    children,
  );
}

/**
 * Linha de lista genérica (menus, ajustes, detalhes).
 * @param {object} o
 * @param {string} [o.icon]        ícone dentro do quadrado arredondado
 * @param {boolean} [o.neutral]    quadrado do ícone em cinza (em vez da cor de destaque)
 * @param {Node} [o.lead]          no lugar do ícone (barras de sinal, avatar...)
 * @param {string|Node} o.title
 * @param {string|Node} [o.subtitle]
 * @param {string|Node} [o.trail]  valor ou controle à direita
 * @param {boolean} [o.chevron]    seta "abre outra tela"
 * @param {() => void} [o.onClick]
 * @param {string} [o.href]        vira um link (rotas do app: '#/ferramentas/ping')
 * @param {string} [o.key]
 */
export function listRow({ icon: iconName, neutral = false, lead, title, subtitle, trail, chevron = false, onClick, href, key, dense = false }) {
  const kids = [
    lead ? h('span.row__lead', null, lead) : iconName ? h('span', { class: ['row__icon', neutral && 'row__icon--neutral'] }, icon(iconName)) : null,
    h('span.row__body', null, h('span.row__title', null, title), subtitle ? h('span.row__sub', null, subtitle) : null),
    trail != null || chevron ? h('span.row__trail', null, trail, chevron ? icon('chevron-right', { size: 20 }) : null) : null,
  ];
  const cls = ['row', (onClick || href) && 'row--tappable', dense && 'row--dense'];
  if (href) return h('a', { class: cls, href, key }, kids);
  if (onClick) return h('button', { class: cls, type: 'button', onClick, key }, kids);
  return h('div', { class: cls, key }, kids);
}

/**
 * Título de seção, com contagem e uma ação opcionais.
 * @param {string} title
 * @param {{count?:number, action?:{label:string, onClick:() => void, icon?:string}}} [options]
 */
export function sectionHeader(title, { count, action } = {}) {
  return h(
    'div.section-h',
    null,
    h('h2.section-h__title', null, title, isNum(count) ? h('span.section-h__count', null, count) : null),
    action ? button(action.label, { variant: 'quiet', small: true, icon: action.icon, onClick: action.onClick }) : null,
  );
}

/**
 * Número em destaque com rótulo.
 * @param {{label:string, value:string|number|Node, unit?:string, hint?:string|Node, tone?:'good'|'warning'|'critical',
 *          icon?:string, compact?:boolean, key?:string}} o
 */
export function statTile({ label, value, unit, hint, tone, icon: iconName, compact = false, key }) {
  return h(
    'div',
    { class: ['stat', tone && `stat--${tone}`, compact && 'stat--compact'], key },
    h('span.stat__label', null, iconName ? icon(iconName, { size: 14 }) : null, label),
    h('span.stat__value', null, value, unit ? h('span.stat__unit', null, unit) : null),
    hint ? h('span.stat__hint', null, hint) : null,
  );
}

/**
 * Pares "rótulo: valor" (painéis de detalhes).
 * @param {([string, any, (string|undefined)?]|null|false)[]} rows  [rótulo, valor, explicação curta]; linhas nulas e valores vazios são pulados
 */
export function kvList(rows) {
  return h(
    'dl.kv',
    null,
    rows
      .filter((r) => r && r[1] != null && r[1] !== '')
      .map(([label, value, hint]) =>
        h('div.kv__row', null, h('dt.kv__label', null, label), h('dd.kv__value', null, value, hint ? h('span.kv__hint', null, hint) : null)),
      ),
  );
}

/**
 * Barra de 0 a 100%.
 * @param {number} pct
 * @param {{tone?:'good'|'warning'|'critical', label?:string, thick?:boolean, sig?:number}} [options]
 *        sig = RSSI: pinta a barra com a cor da escala de sinal
 */
export function meter(pct, { tone, label, thick = false, sig } = {}) {
  const value = isNum(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  return h(
    'span',
    {
      class: ['meter', tone && `meter--${tone}`, thick && 'meter--thick', isNum(sig) && signalClass(sig)],
      role: 'meter',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': Math.round(value),
      'aria-label': label,
    },
    h('span.meter__fill', { style: { width: `${value}%` } }),
  );
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

/**
 * Estado vazio: ícone, título, uma frase e (opcional) uma ação.
 * @param {{icon?:string, title:string, text?:string|Node, tone?:'accent'|'critical',
 *          action?:{label:string, onClick:() => void, icon?:string}, secondary?:{label:string, onClick:() => void}}} o
 */
export function emptyState({ icon: iconName = 'info', title, text, tone, action, secondary }) {
  return h(
    'div.empty',
    null,
    h('div', { class: ['empty__icon', tone && `empty__icon--${tone}`] }, icon(iconName, { size: 28 })),
    h('h2.empty__title', null, title),
    text ? h('p.empty__text', null, text) : null,
    action || secondary
      ? h(
          'div.empty__actions',
          null,
          action ? button(action.label, { variant: 'primary', icon: action.icon, onClick: action.onClick }) : null,
          secondary ? button(secondary.label, { variant: 'quiet', onClick: secondary.onClick }) : null,
        )
      : null,
  );
}

/** Erro inesperado dentro de uma tela, com "tentar de novo". */
export function errorState({ title = 'Algo deu errado nesta tela', text = 'Seus dados continuam salvos. Tente abrir de novo.', onRetry } = {}) {
  return emptyState({
    icon: 'alert-circle',
    tone: 'critical',
    title,
    text,
    action: onRetry ? { label: 'Tentar de novo', icon: 'refresh', onClick: onRetry } : undefined,
  });
}

/** Indicador de "trabalhando". Com `label`, é anunciado por leitores de tela. */
export function spinner({ large = false, label } = {}) {
  return h('span', { class: ['spinner', large && 'spinner--lg'], role: label ? 'status' : undefined, 'aria-label': label });
}

/** Esqueleto de uma lista enquanto os dados não chegam. */
export function skeletonList(rows = 5) {
  return h(
    'div.card.card--flush',
    { 'aria-hidden': 'true' },
    Array.from({ length: rows }, (_, i) =>
      h(
        'div.row',
        null,
        h('span.skel.skel--circle'),
        h('span.row__body', null, h('span.skel.skel--line', { style: { width: `${52 - (i % 3) * 9}%` } }), h('span.skel.skel--line', { style: { width: `${74 - (i % 2) * 14}%` } })),
      ),
    ),
  );
}

const TONE_ICON = { info: 'info', warning: 'warning', critical: 'alert-circle', good: 'check-circle', neutral: 'info' };

/**
 * Aviso em destaque dentro da tela.
 * @param {{tone?:'info'|'warning'|'critical'|'good'|'neutral', icon?:string, title?:string, text?:string|Node,
 *          actions?:{label:string, onClick:() => void}[], onClose?:() => void, key?:string}} o
 *        onClose = mostra o "x" (quem chama decide o que fechar significa)
 */
export function banner({ tone = 'info', icon: iconName, title, text, actions, onClose, key }) {
  return h(
    'div',
    { class: ['banner', tone !== 'info' && `banner--${tone}`], role: tone === 'critical' ? 'alert' : 'note', key },
    h('span.banner__icon', null, icon(iconName || TONE_ICON[tone] || 'info', { size: 20 })),
    h(
      'div.banner__body',
      null,
      title ? h('strong.banner__title', null, title) : null,
      text ? h('span.banner__text', null, text) : null,
      actions && actions.length
        ? h(
            'div.banner__actions',
            null,
            actions.map((a) => button(a.label, { variant: 'quiet', small: true, onClick: a.onClick })),
          )
        : null,
    ),
    onClose ? iconButton('close', 'Dispensar', onClose, { class: 'icon-btn icon-btn--muted banner__close' }) : null,
  );
}

/**
 * Dica que o usuário pode dispensar para sempre (fica guardada nos ajustes; "mostrar dicas de
 * novo" traz todas de volta). Devolve null se já foi dispensada, então pode ir direto na árvore.
 * @param {{id:string, store:object, tone?:string, icon?:string, title?:string, text?:string|Node,
 *          actions?:{label:string, onClick:() => void}[]}} o   id = identificador estável da dica
 */
export function tipBanner({ id, store, ...rest }) {
  if (store.get().settings.tipsDismissed.includes(id)) return null;
  return banner({
    tone: 'info',
    icon: 'sparkle',
    ...rest,
    key: `tip-${id}`,
    onClose: (ev) => {
      const el = ev.currentTarget.closest('.banner');
      store.dismissTip(id);
      if (el) el.remove();
    },
  });
}

// ---------------------------------------------------------------------------
// Formulário
// ---------------------------------------------------------------------------

/**
 * Linha com chave liga/desliga.
 * @param {{title:string, subtitle?:string|Node, checked:boolean, onChange:(on:boolean) => void, disabled?:boolean, icon?:string, key?:string}} o
 */
export function switchRow({ title, subtitle, checked, onChange, disabled = false, icon: iconName, key }) {
  const id = uid('sw');
  return h(
    'label.row',
    { for: id, key },
    iconName ? h('span.row__icon.row__icon--neutral', null, icon(iconName)) : null,
    h('span.row__body', null, h('span.row__title', null, title), subtitle ? h('span.row__sub', null, subtitle) : null),
    h('input.switch', { id, type: 'checkbox', role: 'switch', checked: !!checked, disabled, onChange: (ev) => onChange(ev.currentTarget.checked) }),
  );
}

/**
 * Caixa de seleção nativa, estilizada.
 * @param {{value:any, label:string}[]} options
 * @param {any} value
 * @param {(value:any) => void} onChange   recebe o `value` original da opção (não o texto)
 * @param {{label?:string, block?:boolean, disabled?:boolean}} [extra]
 */
export function select(options, value, onChange, { label, block = false, disabled = false } = {}) {
  return h(
    'label',
    { class: ['select', block && 'select--block'] },
    h(
      'select',
      { 'aria-label': label, disabled, onChange: (ev) => onChange(options[ev.currentTarget.selectedIndex].value) },
      options.map((o) => h('option', { selected: o.value === value }, o.label)),
    ),
  );
}

/**
 * Controle deslizante.
 * @param {{min:number, max:number, step?:number, value:number, label:string, onInput?:(v:number) => void, onChange?:(v:number) => void}} o
 */
export function slider({ min, max, step = 1, value, label, onInput, onChange }) {
  return h('input.slider', {
    type: 'range',
    min,
    max,
    step,
    value,
    'aria-label': label,
    onInput: onInput ? (ev) => onInput(Number(ev.currentTarget.value)) : undefined,
    onChange: onChange ? (ev) => onChange(Number(ev.currentTarget.value)) : undefined,
  });
}

/**
 * Campo de texto com rótulo.
 * @param {{label:string, value?:string, placeholder?:string, hint?:string, error?:string, type?:string, inputMode?:string,
 *          maxLength?:number, onInput?:(text:string) => void, onChange?:(text:string) => void}} o
 */
export function textField({ label, value = '', placeholder, hint, error, type = 'text', inputMode, maxLength, onInput, onChange }) {
  return h(
    'label.field',
    null,
    h('span.field__label', null, label),
    h('input.input', {
      type,
      value,
      placeholder,
      inputmode: inputMode,
      maxlength: maxLength,
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      'aria-invalid': error ? true : undefined,
      onInput: onInput ? (ev) => onInput(ev.currentTarget.value) : undefined,
      onChange: onChange ? (ev) => onChange(ev.currentTarget.value) : undefined,
    }),
    error ? h('span.field__error', null, error) : hint ? h('span.field__hint', null, hint) : null,
  );
}

// ---------------------------------------------------------------------------
// Limite de buscas do Android
// ---------------------------------------------------------------------------

/**
 * Painel que explica o limite de buscas do Android e como desligá-lo.
 * @param {{bridge:object, store:object}} ctx
 */
export function openThrottleHelp(ctx) {
  const demo = ctx.store.get().backend === 'sim';
  const panel = sheet({
    title: 'Por que a lista demora a atualizar?',
    content: [
      h(
        'div.prose',
        null,
        h('p', null, 'Para poupar bateria, o Android só deixa cada app procurar redes ', h('strong', null, '4 vezes a cada 2 minutos'), '. Quando o limite acaba, o app mostra a última lista que o celular guardou e avisa a idade dela.'),
        h('p', null, 'Você pode desligar esse limite. O app continua funcionando sem isso, só que com a lista mais lenta:'),
        h(
          'ol.steps',
          null,
          h('li', null, 'Ative as ', h('strong', null, 'Opções do desenvolvedor'), ': em Configurações › Sobre o telefone, toque 7 vezes em “Número da versão”.'),
          h('li', null, 'Abra as Opções do desenvolvedor e procure por ', h('strong', null, '“Limitação da busca por Wi-Fi”'), '.'),
          h('li', null, 'Desligue essa chave e volte para o app.'),
        ),
        h('p', null, 'Durante o mapeamento da casa isso faz bastante diferença: as leituras chegam a cada poucos segundos em vez de a cada 30.'),
      ),
    ],
    footer: [
      button('Agora não', { variant: 'secondary', onClick: () => panel.close() }),
      button('Abrir opções', {
        variant: 'primary',
        icon: 'external',
        onClick: async () => {
          panel.close();
          if (demo) {
            toast('Na demonstração não há configurações do Android para abrir.');
            return;
          }
          const res = await ctx.bridge.openSettings('developer').catch(() => null);
          if (!res || res.ok === false) toast('Não foi possível abrir. Procure “Opções do desenvolvedor” nas configurações do Android.');
        },
      }),
    ],
  });
  return panel;
}

/**
 * Dica (dispensável) sobre o limite de buscas. Só aparece quando o Android está mesmo limitando;
 * fora disso devolve null. Pode ser colocada em qualquer tela.
 * @param {{bridge:object, store:object}} ctx
 */
export function throttleTip(ctx) {
  const state = ctx.store.get();
  if (!state.loop.throttled) return null;
  return tipBanner({
    id: 'throttle',
    store: ctx.store,
    tone: 'warning',
    icon: 'clock',
    title: 'O Android está limitando as buscas',
    text: 'A lista se atualiza a cada 30 segundos, mais ou menos. Dá para liberar buscas mais rápidas nas opções do desenvolvedor.',
    actions: [{ label: 'Como liberar', onClick: () => openThrottleHelp(ctx) }],
  });
}
