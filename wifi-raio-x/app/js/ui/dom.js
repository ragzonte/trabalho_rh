// Base da interface: criação de elementos, atualização sem piscar, camadas (painel inferior,
// diálogo, aviso rápido) e os formatadores de números "para gente" em pt-BR.
//
// REGRA DE SEGURANÇA: nomes de rede, de aparelhos e rótulos digitados são texto hostil.
// Aqui tudo entra por textContent / setAttribute; h() recusa HTML cru e endereços "javascript:".
//
// Resumo do que este arquivo exporta
//   h(tag, props, ...filhos)   cria um elemento HTML      s(tag, attrs, ...filhos)  cria um elemento SVG
//   nb(texto)                  filhos para h() em que "Wi-Fi" não quebra no hífen (texto fixo da interface)
//   mount(raiz, ...filhos)     troca todo o conteúdo      patch(raiz, ...filhos)    atualiza no lugar (sem piscar)
//   patchList(pai, itens, {key, create, update})          lista viva com chave
//   batch(raiz, fn)            vários patch()/patchList() dentro de `raiz` como uma atualização só
//   sheet({title, content, ...})  painel inferior         confirmDialog({...}) -> Promise<boolean>
//   toast(texto, {action})        aviso rápido            closeTopOverlay()    (botão "voltar")
//   pushLayer(el, {close})        registra uma camada própria na pilha do "voltar"
//   fmtNum, fmtDbm, fmtMbps, fmtMeters, fmtPct, fmtMs, fmtAgo, fmtDuration, fmtFreq, fmtBand,
//   fmtWidth, fmtClock, fmtDateTime, plural       formatadores
//   cssVar('--accent')            lê um token do tema (para gráficos em canvas)
//   listen(alvo, tipo, fn)        addEventListener que devolve a função de cancelar
//
// h() em detalhe
//   h('div.card.card--flush#id', { ... }, filho1, [filho2, filho3], 'texto', null)
//   props:
//     class      texto, lista ou mapa {nome: boolean}            style    objeto {prop: valor} ('--token' também) ou texto
//     dataset    objeto {chave: valor}                           aria-*   true/false viram "true"/"false"
//     onClick, onInput, onKeyDown...  ouvintes (nome do evento em minúsculas)
//     key        identidade do nó para patch() (ex.: o BSSID)    ref      função chamada com o elemento
//     keep       true = patch() não toca neste nó, nem nos atributos nem nos filhos (canvas, visualizador 3D)
//     text       atalho para textContent
//     value, checked, disabled, selected, hidden, tabIndex... viram propriedades; o resto, atributos
//   filhos: nós, textos e números (viram texto), listas (achatadas); null/false/undefined são ignorados.
//
// patch() em detalhe
//   Escreva a tela como uma função estado -> árvore e chame patch(raiz, arvore) a cada mudança:
//   os nós existentes são reaproveitados (mesma `key`, ou mesma posição e mesma tag), então o
//   foco, o texto sendo digitado e as animações em curso continuam como estavam, e a rolagem
//   (da raiz e de quem rola em volta dela) fica exatamente onde o usuário deixou.
//   - Dê `key` a tudo o que pode mudar de ordem, entrar ou sair (linhas de lista, cartões opcionais).
//   - Os ouvintes passam a ser os da árvore nova (podem capturar os dados novos à vontade).
//   - `ref` é chamado de novo com o nó que ficou no documento.
//   - Classes e atributos postos "por fora" num nó gerenciado são sobrescritos; para um nó que
//     outro código controla (canvas de gráfico, visualizador 3D), use `keep: true`.
//
// Camadas
//   sheet(), confirmDialog() e os bloqueios (ui/gates.js) entram numa pilha única: a camada de
//   cima prende o foco (Tab), deixa o resto da página inerte e é a que o "voltar"/Esc fecha.
//   Quem criar uma camada própria (um filho direto de <body>) registra-a com pushLayer().

import { icon } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// ---------------------------------------------------------------------------
// Elementos
// ---------------------------------------------------------------------------

// Chaves que são propriedades do elemento (o atributo não reflete o estado atual).
const PROPS = new Set([
  'value', 'checked', 'disabled', 'selected', 'indeterminate', 'hidden', 'tabIndex', 'htmlFor',
  'readOnly', 'open', 'inert', 'multiple', 'required', 'scrollTop', 'scrollLeft',
]);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data']);
const RAW_HTML = new Set(['html', 'innerHTML', 'outerHTML', 'dangerouslySetInnerHTML', 'srcdoc']);

function safeUrl(value) {
  // remove espaços e caracteres de controle que os navegadores ignoram antes do esquema
  const probe = String(value).replace(/[\u0000-\u0020\u007f-\u009f]/g, '').toLowerCase();
  if (probe.startsWith('javascript:') || probe.startsWith('vbscript:') || probe.startsWith('data:text/html')) {
    console.warn('[dom] endereço recusado');
    return null;
  }
  return String(value);
}

function dispatch(ev) {
  const fn = this.__on && this.__on[ev.type];
  if (fn) return fn.call(this, ev);
  return undefined;
}

function setListener(el, type, fn) {
  if (!el.__on) el.__on = {};
  if (!(type in el.__on)) el.addEventListener(type, dispatch);
  el.__on[type] = typeof fn === 'function' ? fn : null;
}

function classText(value) {
  if (value == null || value === false) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(classText).filter(Boolean).join(' ');
  if (typeof value === 'object') return Object.keys(value).filter((k) => value[k]).join(' ');
  return String(value);
}

function setStyle(el, value) {
  if (value == null || value === false) return;
  if (typeof value === 'string') {
    el.setAttribute('style', value);
    return;
  }
  for (const prop in value) {
    const v = value[prop];
    if (v == null || v === false) continue;
    if (prop.startsWith('--') || prop.includes('-')) el.style.setProperty(prop, String(v));
    else el.style[prop] = v;
  }
}

function setProp(el, key, value) {
  if (key === 'class' || key === 'className') {
    const text = classText(value);
    const base = el.getAttribute('class');
    const all = base && text ? `${base} ${text}` : base || text;
    if (all) el.setAttribute('class', all);
  } else if (key === 'style') {
    setStyle(el, value);
  } else if (key === 'dataset') {
    for (const name in value || {}) if (value[name] != null && value[name] !== false) el.dataset[name] = value[name] === true ? '' : String(value[name]);
  } else if (key === 'key') {
    if (value != null) el.__key = String(value);
  } else if (key === 'ref') {
    if (typeof value === 'function') el.__ref = value;
  } else if (key === 'keep') {
    el.__keep = !!value;
  } else if (key === 'text') {
    el.textContent = value == null ? '' : String(value);
  } else if (RAW_HTML.has(key)) {
    throw new Error(`h(): "${key}" não é aceito; monte os filhos com h()`);
  } else if (key.length > 2 && key[0] === 'o' && key[1] === 'n') {
    // on* só aceita função: um texto aqui viraria código (atributo onclick="...")
    if (typeof value === 'function') setListener(el, key.slice(2).toLowerCase(), value);
  } else if (PROPS.has(key) && !(el instanceof SVGElement)) {
    if (!el.__props) el.__props = {};
    el.__props[key] = value;
    el[key] = value;
  } else if (key.startsWith('aria-')) {
    if (value != null) el.setAttribute(key, String(value));
  } else if (value != null && value !== false) {
    const out = URL_ATTRS.has(key) ? safeUrl(value) : value === true ? '' : String(value);
    if (out !== null) el.setAttribute(key, out);
  }
}

function appendChildren(el, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

function flatten(children, out = []) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) flatten(child, out);
    else if (child instanceof Node) out.push(child);
    else out.push(document.createTextNode(String(child)));
  }
  return out;
}

function create(ns, spec, props, children) {
  // 'div.card.card--flush#id' -> tag, classes e id
  let tag = spec;
  let id = null;
  let classes = null;
  if (/[.#]/.test(spec)) {
    const parts = spec.split(/(?=[.#])/);
    tag = parts[0] || 'div';
    for (let i = 1; i < parts.length; i++) {
      if (parts[i][0] === '#') id = parts[i].slice(1);
      else classes = classes ? `${classes} ${parts[i].slice(1)}` : parts[i].slice(1);
    }
  }
  const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
  if (id) el.id = id;
  if (classes) el.setAttribute('class', classes);
  if (props) for (const key in props) setProp(el, key, props[key]);
  appendChildren(el, children);
  if (el.__ref) el.__ref(el);
  return el;
}

/**
 * Cria um elemento HTML. Veja o cabeçalho do arquivo.
 * @param {string} tag  'div', 'button.btn.btn--primary', 'h2#titulo'...
 * @param {object|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  return create(null, tag, props, children);
}

/** Como h(), para elementos SVG (svg, path, circle, g, text...). */
export function s(tag, attrs, ...children) {
  return create(SVG_NS, tag, attrs, children);
}

/**
 * Texto fixo da interface em que "Wi-Fi" não pode quebrar no hífen ("Wi-" numa linha, "Fi" na
 * outra). Devolve os filhos para h(): o mesmo texto, com cada "Wi-Fi" dentro de um
 * <span class="nb"> (white-space: nowrap). O textContent não muda e o hífen continua o comum:
 * busca, cópia, leitor de tela e testes veem o texto de sempre.
 * Só para textos escritos no código (títulos, parágrafos). Nome de rede e rótulo digitado pelo
 * usuário entram direto em h(), como vieram.
 *   h('h1.gate__title', null, nb('Vamos ver o Wi-Fi ao seu redor'))
 * @param {string} text
 * @returns {string|(string|HTMLElement)[]}
 */
export function nb(text) {
  if (typeof text !== 'string' || !text.includes('Wi-Fi')) return text;
  return text
    .split(/(Wi-Fi)/)
    .filter((part) => part !== '')
    .map((part) => (part === 'Wi-Fi' ? h('span.nb', null, part) : part));
}

/** Troca todo o conteúdo de `root` pelos filhos dados. Devolve `root`. */
export function mount(root, ...children) {
  root.replaceChildren(...flatten(children));
  return root;
}

/** addEventListener que devolve a função de cancelar. */
export function listen(target, type, fn, options) {
  target.addEventListener(type, fn, options);
  return () => target.removeEventListener(type, fn, options);
}

let uidSeq = 0;
/** Id único no documento (para aria-labelledby, for=...). */
export function uid(prefix = 'wrx') {
  uidSeq += 1;
  return `${prefix}-${uidSeq}`;
}

/** Valor atual de um token do tema, ex.: cssVar('--accent') -> '#38bdf8'. */
export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

// ---------------------------------------------------------------------------
// Atualização no lugar
// ---------------------------------------------------------------------------

function sameKind(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return a.tagName === b.tagName && a.namespaceURI === b.namespaceURI;
}

function morphAttrs(old, next) {
  for (const name of old.getAttributeNames()) {
    if (!next.hasAttribute(name)) old.removeAttribute(name);
  }
  for (const name of next.getAttributeNames()) {
    const value = next.getAttribute(name);
    if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  }
  // estilos postos por h() vão no atributo style, que já foi copiado acima

  const nextOn = next.__on || null;
  if (old.__on) for (const type in old.__on) if (!nextOn || !(type in nextOn)) old.__on[type] = null;
  if (nextOn) for (const type in nextOn) setListener(old, type, nextOn[type]);

  const nextProps = next.__props || null;
  if (nextProps) {
    const focused = old === document.activeElement;
    for (const key in nextProps) {
      // não atropela o que o usuário está digitando
      if (key === 'value' && focused) continue;
      if (key === 'scrollTop' || key === 'scrollLeft') continue;
      if (old[key] !== nextProps[key]) old[key] = nextProps[key];
    }
  }
  old.__props = nextProps || undefined;
  old.__keep = next.__keep;
  if (next.__ref) {
    old.__ref = next.__ref;
    next.__ref(old);
  }
}

function morphNode(old, next) {
  if (old.nodeType === 3 || old.nodeType === 8) {
    if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue;
    return;
  }
  if (old.__keep && next.__keep) {
    // nó "de outro dono" (canvas, visualizador): fica intocado; só o ref é avisado
    if (next.__ref) {
      old.__ref = next.__ref;
      next.__ref(old);
    }
    return;
  }
  morphAttrs(old, next);
  morphChildren(old, Array.from(next.childNodes));
}

// Mudar um nó de lugar com insertBefore tira o foco dele. Onde existe moveBefore (Chromium
// recente) o nó muda de lugar sem perder nada; nos demais, keepStable devolve o foco depois.
function moveNode(parent, node, before) {
  if (typeof parent.moveBefore === 'function' && node.parentNode === parent) {
    try {
      parent.moveBefore(node, before);
      return;
    } catch {
      // cai para o caminho de sempre
    }
  }
  parent.insertBefore(node, before);
}

// Raiz do lote em andamento (veja batch): o que for atualizado dentro dela não guarda nem devolve
// foco e rolagem por conta própria; o lote faz isso uma vez só.
let stableRoot = null;

// Roda `work` (que reorganiza os filhos de `root`) e põe de volta o que o navegador mexe por
// conta própria: o foco e a rolagem — de `root` e de quem rola em volta dele. Numa lista que se
// reordena sozinha, a tela fica parada onde o usuário a deixou em vez de seguir uma linha.
function keepStable(root, work) {
  if (stableRoot && (stableRoot === root || stableRoot.contains(root))) {
    work(); // o lote que cobre esta raiz já guardou tudo antes da primeira mudança
    return;
  }
  const active = document.activeElement;
  const inside = active && active !== document.body && root.contains(active) ? active : null;
  let range = null;
  if (inside && typeof inside.selectionStart === 'number') {
    try {
      range = [inside.selectionStart, inside.selectionEnd];
    } catch {
      range = null; // alguns tipos de <input> não têm seleção
    }
  }
  const scrolled = [];
  for (let el = root; el && el.nodeType === 1; el = el.parentNode) {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) scrolled.push([el, el.scrollTop, el.scrollLeft]);
  }

  work();

  if (inside && inside.isConnected && document.activeElement !== inside) {
    inside.focus({ preventScroll: true });
    if (range) {
      try {
        inside.setSelectionRange(range[0], range[1]);
      } catch {
        // idem
      }
    }
  }
  for (const [el, top, left] of scrolled) {
    if (el.scrollTop !== top) el.scrollTop = top;
    if (el.scrollLeft !== left) el.scrollLeft = left;
  }
}

function morphChildren(parent, nextKids) {
  let keyed = null;
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.__key != null) (keyed || (keyed = new Map())).set(node.__key, node);
  }
  let cursor = parent.firstChild;
  for (const next of nextKids) {
    let match = null;
    if (next.__key != null) {
      const found = keyed && keyed.get(next.__key);
      if (found && sameKind(found, next)) {
        match = found;
        keyed.delete(next.__key);
      }
    } else if (cursor && cursor.__key == null && sameKind(cursor, next)) {
      match = cursor;
    }
    if (match) {
      if (match === cursor) cursor = cursor.nextSibling;
      else moveNode(parent, match, cursor);
      morphNode(match, next);
    } else {
      parent.insertBefore(next, cursor);
    }
  }
  // o que sobrou do cursor em diante não existe mais na árvore nova
  while (cursor) {
    const gone = cursor;
    cursor = cursor.nextSibling;
    parent.removeChild(gone);
  }
}

/**
 * Várias atualizações de uma vez: tudo o que `work` fizer com patch()/patchList() DENTRO de
 * `root` conta como uma atualização só. O foco e a rolagem (de `root` e de quem rola em volta
 * dele) são guardados antes da primeira mudança e devolvidos uma vez, no fim, ainda antes de a
 * tela ser pintada.
 *
 * Por quê: cada patch() sozinho lê a rolagem antes e depois de mexer, e ler a rolagem com a
 * página "suja" obriga o navegador a recalcular o layout inteiro na hora. Uma tela que atualiza
 * cinco regiões a cada varredura pagava isso cinco vezes (num celular modesto, com muitas redes,
 * a maior parte do tempo que a lista ficava travada).
 *
 * Quem rola tem de ser `root` ou estar acima dele (o normal: a área de conteúdo do app). Uma
 * região de dentro de `root` que role por conta própria e seja refeita no lote não tem a rolagem
 * devolvida: atualize-a fora do lote.
 * @template T
 * @param {Element} root
 * @param {() => T} work
 * @returns {T}
 */
export function batch(root, work) {
  let out;
  keepStable(root, () => {
    const outer = stableRoot;
    stableRoot = root;
    try {
      out = work();
    } finally {
      stableRoot = outer;
    }
  });
  return out;
}

/**
 * Atualiza os filhos de `root` para ficarem iguais aos dados, reaproveitando os nós que já
 * existem (veja o cabeçalho). Devolve `root`.
 */
export function patch(root, ...children) {
  const next = flatten(children);
  keepStable(root, () => morphChildren(root, next));
  return root;
}

/**
 * Lista viva com chave, para quando criar a árvore inteira a cada atualização for caro.
 *   patchList(ul, aps, { key: (ap) => ap.bssid, create: (ap) => linha(ap), update: (el, ap) => {...} })
 * Cria só as linhas novas, chama `update` nas que já existiam (sem `update`, a linha é refeita
 * com `create` e atualizada no lugar), reordena e remove as que saíram.
 * Com `signature` (um texto com tudo o que a linha mostra), a linha que já existe e não mudou
 * nem é refeita: numa lista longa, é a diferença entre redesenhar tudo e só o que mudou.
 * @template T
 * @param {Element} parent
 * @param {T[]} items
 * @param {{key:(item:T, index:number) => string, create:(item:T, index:number) => Element,
 *          update?:(el:Element, item:T, index:number) => void,
 *          signature?:(item:T, index:number) => string}} spec
 */
export function patchList(parent, items, spec) {
  const old = parent.__rows || new Map();
  const rows = new Map();
  keepStable(parent, () => {
    let cursor = parent.firstChild;
    items.forEach((item, index) => {
      const key = String(spec.key(item, index));
      if (rows.has(key)) return; // chave repetida: fica só a primeira
      const signature = spec.signature ? String(spec.signature(item, index)) : null;
      let el = old.get(key);
      if (el && el.parentNode === parent) {
        if (signature !== null && el.__sig === signature) {
          // nada do que a linha mostra mudou: fica como está
        } else if (spec.update) spec.update(el, item, index);
        else morphNode(el, spec.create(item, index));
      } else {
        el = spec.create(item, index);
      }
      if (signature !== null) el.__sig = signature;
      rows.set(key, el);
      if (el === cursor) cursor = cursor.nextSibling;
      else moveNode(parent, el, cursor);
    });
    while (cursor) {
      const gone = cursor;
      cursor = cursor.nextSibling;
      parent.removeChild(gone);
    }
  });
  parent.__rows = rows;
  return parent;
}

// ---------------------------------------------------------------------------
// Camadas: pilha comum para o botão "voltar", Esc e o foco
// ---------------------------------------------------------------------------

const layers = []; // {el, close}; a última é a de cima
let keysBound = false;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function syncInert() {
  const top = layers[layers.length - 1];
  for (const el of document.body.children) {
    if (el.classList.contains('toasts') || el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT') continue;
    // tudo o que está por baixo da camada de cima fica fora do alcance do teclado e do leitor de tela
    el.inert = !!top && el !== top.el;
  }
}

function onLayerKey(ev) {
  const top = layers[layers.length - 1];
  if (!top) return;
  if (ev.key === 'Escape') {
    if (top.close) {
      ev.preventDefault();
      top.close();
    }
    return;
  }
  if (ev.key !== 'Tab') return;
  const items = focusables(top.el);
  if (!items.length) {
    ev.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!top.el.contains(active)) {
    ev.preventDefault();
    first.focus();
  } else if (ev.shiftKey && (active === first || active === top.el)) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  }
}

/**
 * Registra uma camada (um filho direto de <body>) no topo da pilha: enquanto ela estiver lá o
 * resto da página fica inerte, o Tab fica preso dentro dela e o "voltar"/Esc chama `close`.
 * Sem `close` a camada não pode ser dispensada (bloqueios de tela cheia).
 * @returns {() => void} tira a camada da pilha (não remove o elemento)
 */
export function pushLayer(el, { close } = {}) {
  const entry = { el, close: typeof close === 'function' ? close : null };
  layers.push(entry);
  if (!keysBound) {
    keysBound = true;
    document.addEventListener('keydown', onLayerKey);
  }
  syncInert();
  return () => {
    const i = layers.indexOf(entry);
    if (i >= 0) layers.splice(i, 1);
    syncInert();
  };
}

/**
 * Fecha a camada de cima (painel, diálogo). É o primeiro passo do botão "voltar".
 * @returns {boolean} true se fechou alguma coisa
 */
export function closeTopOverlay() {
  const top = layers[layers.length - 1];
  if (!top || !top.close) return false;
  top.close();
  return true;
}

/** Há algum painel ou diálogo aberto? */
export function hasOverlay() {
  return layers.some((l) => l.close);
}

function afterAnimation(el, ms, fn) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    fn();
  };
  // só vale o fim da animação do próprio elemento (as dos filhos também borbulham até aqui)
  const own = (ev) => ev.target === el && finish();
  el.addEventListener('animationend', own);
  el.addEventListener('transitionend', own);
  setTimeout(finish, ms + 80);
}

/**
 * Painel inferior. Fecha arrastando para baixo, tocando fora, com Esc ou com o "voltar".
 * @param {object} options
 * @param {string|Node} options.title
 * @param {string|Node} [options.subtitle]
 * @param {any} options.content           filhos do corpo (nós, textos, listas)
 * @param {any} [options.footer]          botões fixos no rodapé
 * @param {boolean} [options.tall]        ocupa quase toda a altura desde o início
 * @param {() => void} [options.onClose]  chamado uma vez, depois de fechar
 * @returns {{el:HTMLElement, body:HTMLElement, close:() => void, setTitle:(t:string) => void, isOpen:() => boolean}}
 *          `body` pode ser atualizado depois com patch(body, ...)
 */
export function sheet({ title, subtitle, content, footer, tall = false, onClose } = {}) {
  const returnFocus = document.activeElement;
  const titleId = uid('sheet');
  let open = true;

  const titleEl = h('h2.sheet__title', { id: titleId }, title);
  const body = h('div.sheet__body', null, content);
  const grab = h('div.sheet__grab', { 'aria-hidden': 'true' });
  const header = h(
    'div.sheet__header',
    null,
    h('div.sheet__titles', null, titleEl, subtitle ? h('p.sheet__subtitle', null, subtitle) : null),
    h('button.icon-btn.icon-btn--muted', { type: 'button', 'aria-label': 'Fechar', onClick: () => close() }, icon('close')),
  );
  const panel = h(
    'div',
    { class: ['sheet', tall && 'sheet--tall', footer && 'sheet--footer'], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabIndex: -1 },
    grab,
    header,
    body,
    footer ? h('div.sheet__footer', null, footer) : null,
  );
  const scrim = h('div.scrim', { onClick: () => close() });
  const layer = h('div.layer', null, scrim, panel);

  document.body.appendChild(layer);
  const pop = pushLayer(layer, { close: () => close() });
  panel.focus({ preventScroll: true });

  function close() {
    if (!open) return;
    open = false;
    pop();
    layer.dataset.closing = '';
    afterAnimation(panel, 200, () => {
      layer.remove();
      if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
      if (onClose) onClose();
    });
  }

  // Arrastar para baixo: pelo puxador/cabeçalho sempre; pelo corpo, só com a rolagem no topo.
  let drag = null;
  const start = (y, fromBody) => {
    drag = { y0: y, y: y, t0: performance.now(), active: !fromBody, fromBody };
  };
  const move = (y, ev) => {
    if (!drag) return;
    drag.y = y;
    const dy = y - drag.y0;
    if (!drag.active) {
      if (dy > 6 && body.scrollTop <= 0) drag.active = true;
      else if (dy < -6 || body.scrollTop > 0) drag = null;
      if (!drag || !drag.active) return;
      drag.y0 = y; // começa a contar daqui para não dar um salto
    }
    if (ev && ev.cancelable) ev.preventDefault();
    panel.style.animation = 'none';
    panel.style.transition = 'none';
    panel.style.transform = `translateY(${Math.max(0, y - drag.y0)}px)`;
  };
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.active) return;
    const dy = Math.max(0, d.y - d.y0);
    const speed = dy / Math.max(1, performance.now() - d.t0); // px/ms
    panel.style.transition = 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)';
    if (dy > Math.min(140, panel.offsetHeight * 0.3) || (dy > 24 && speed > 0.55)) {
      panel.style.transform = 'translateY(100%)';
      close();
    } else {
      panel.style.transform = '';
    }
  };
  for (const zone of [grab, header]) {
    zone.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('button')) return;
      start(ev.clientY, false);
      try {
        zone.setPointerCapture(ev.pointerId); // o arrasto continua valendo fora do cabeçalho
      } catch {
        // ponteiro que já não existe (evento sintético): segue sem a captura
      }
    });
    zone.addEventListener('pointermove', (ev) => move(ev.clientY, ev));
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }
  body.addEventListener(
    'touchstart',
    (ev) => {
      // controles que usam o próprio arrasto (deslizante, gráfico) não puxam o painel
      if (ev.touches.length !== 1 || ev.target.closest('input, select, textarea, canvas, [data-nodrag]')) return;
      start(ev.touches[0].clientY, true);
    },
    { passive: true },
  );
  body.addEventListener('touchmove', (ev) => move(ev.touches[0].clientY, ev), { passive: false });
  body.addEventListener('touchend', end);
  body.addEventListener('touchcancel', end);

  return {
    el: panel,
    body,
    close,
    setTitle(text) {
      titleEl.textContent = text == null ? '' : String(text);
    },
    isOpen: () => open,
  };
}

/**
 * Pergunta de confirmação. Resolve true só se o usuário confirmar; "voltar", Esc e tocar fora
 * contam como cancelar.
 * @param {{title:string, text?:string|Node, confirmLabel?:string, cancelLabel?:string, danger?:boolean}} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, text, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    const returnFocus = document.activeElement;
    const titleId = uid('dialog');
    const textId = uid('dialog');
    let open = true;
    const finish = (answer) => {
      if (!open) return;
      open = false;
      pop();
      layer.dataset.closing = '';
      afterAnimation(box, 120, () => {
        layer.remove();
        if (returnFocus && returnFocus.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
      });
      resolve(answer);
    };
    const cancel = h('button.btn.btn--quiet', { type: 'button', onClick: () => finish(false) }, cancelLabel);
    const ok = h('button', { type: 'button', class: ['btn', danger ? 'btn--danger' : 'btn--primary'], onClick: () => finish(true) }, confirmLabel);
    const box = h(
      'div.dialog',
      { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, 'aria-describedby': text ? textId : null },
      h('h2.dialog__title', { id: titleId }, title),
      text ? h('p.dialog__text', { id: textId }, text) : null,
      h('div.dialog__actions', null, cancel, ok),
    );
    const layer = h('div.layer.layer--center', null, h('div.scrim', { onClick: () => finish(false) }), box);
    document.body.appendChild(layer);
    const pop = pushLayer(layer, { close: () => finish(false) });
    // numa ação destrutiva o foco começa no "cancelar"
    (danger ? cancel : ok).focus({ preventScroll: true });
  });
}

let toastHost = null;
let currentToast = null;

/**
 * Aviso rápido acima da navegação; some sozinho. Só um por vez (o novo substitui o anterior).
 * @param {string} text
 * @param {{action?:{label:string, onClick:() => void}, duration?:number}} [options]
 * @returns {{close:() => void}}
 */
export function toast(text, { action, duration } = {}) {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  if (currentToast) currentToast.close(true);

  let timer = null;
  let closed = false;
  const el = h(
    'div.toast',
    null,
    h('span.toast__text', null, text),
    action
      ? h(
          'button.toast__action',
          {
            type: 'button',
            onClick: () => {
              close(true);
              action.onClick();
            },
          },
          action.label,
        )
      : null,
  );
  function close(now = false) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (currentToast === handle) currentToast = null;
    if (now) {
      el.remove();
      return;
    }
    el.dataset.closing = '';
    afterAnimation(el, 150, () => el.remove());
  }
  const handle = { close };
  currentToast = handle;
  toastHost.appendChild(el);
  timer = setTimeout(() => close(), duration ?? (action ? 7000 : 4000));
  return handle;
}

// ---------------------------------------------------------------------------
// Formatadores (pt-BR)
// ---------------------------------------------------------------------------

/** Espaço fino que não quebra a linha, entre o número e a unidade. */
export const THIN = '\u202f';
/** Sinal de menos tipográfico (−), da largura dos algarismos. */
export const MINUS = '\u2212';
/** O que aparece no lugar de um número que não existe. */
export const NO_VALUE = '—';

const numberFormats = new Map();
function numberFormat(digits) {
  let nf = numberFormats.get(digits);
  if (!nf) {
    nf = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    numberFormats.set(digits, nf);
  }
  return nf;
}

/**
 * Número com vírgula decimal e ponto de milhar: fmtNum(1234.5, 1) -> "1.234,5"; negativos usam "−".
 * Valor ausente ou inválido vira "—".
 * @param {number} n
 * @param {number} [digits=0] casas decimais
 */
export function fmtNum(n, digits = 0) {
  if (!isNum(n)) return NO_VALUE;
  const scale = 10 ** digits;
  let r = Math.round(Math.abs(n) * scale) / scale;
  const negative = n < 0 && r !== 0;
  if (r === 0) r = 0;
  return (negative ? MINUS : '') + numberFormat(digits).format(r);
}

const withUnit = (text, unit) => `${text}${THIN}${unit}`;
const approxPrefix = (approx) => (approx ? `≈${THIN}` : '');

/** Sinal: fmtDbm(-57.2) -> "−57 dBm". Com {unit:false}, só "−57". */
export function fmtDbm(rssi, { unit = true } = {}) {
  if (!isNum(rssi)) return NO_VALUE;
  const text = fmtNum(Math.round(rssi));
  return unit ? withUnit(text, 'dBm') : text;
}

/** Velocidade: fmtMbps(8.46) -> "8,5 Mb/s"; 120 -> "120 Mb/s"; 1200 -> "1,2 Gb/s". {approx:true} põe "≈". */
export function fmtMbps(mbps, { approx = false } = {}) {
  if (!isNum(mbps) || mbps < 0) return NO_VALUE;
  let text;
  if (mbps >= 995) text = withUnit(fmtNum(mbps / 1000, mbps >= 9950 ? 0 : 1), 'Gb/s');
  else if (mbps >= 9.95) text = withUnit(fmtNum(mbps), 'Mb/s');
  else text = withUnit(fmtNum(mbps, 1), 'Mb/s');
  return approxPrefix(approx) + text;
}

/**
 * Distância: fmtMeters(2.46) -> "2,5 m"; 12.3 -> "12 m". Com {approx:true} vira "≈ 2,5 m" e, a
 * partir de 3 m, arredonda para o metro inteiro (uma estimativa não merece casa decimal).
 */
export function fmtMeters(m, { approx = false } = {}) {
  if (!isNum(m) || m < 0) return NO_VALUE;
  let text;
  if (m >= 9.95 || (approx && m >= 2.75)) text = fmtNum(m);
  else if (approx) text = fmtNum(Math.round(m * 2) / 2, 1).replace(/,0$/, '');
  else text = fmtNum(m, 1).replace(/,0$/, '');
  return approxPrefix(approx) + withUnit(text, 'm');
}

/** Porcentagem a partir de 0..100: fmtPct(84.6) -> "85%". */
export function fmtPct(value, digits = 0) {
  if (!isNum(value)) return NO_VALUE;
  return `${fmtNum(value, digits)}%`;
}

/** Tempo de resposta: fmtMs(8.42) -> "8,4 ms"; 23.7 -> "24 ms". */
export function fmtMs(ms) {
  if (!isNum(ms) || ms < 0) return NO_VALUE;
  return withUnit(ms < 9.95 ? fmtNum(ms, 1) : fmtNum(ms), 'ms');
}

/** Há quanto tempo, a partir da idade em ms: "agora", "há 8 s", "há 3 min", "há 2 h", "há 4 d". */
export function fmtAgo(ageMs) {
  if (!isNum(ageMs)) return NO_VALUE;
  const sec = Math.max(0, Math.floor(ageMs / 1000));
  if (sec < 2) return 'agora';
  if (sec < 60) return `há ${sec}${THIN}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `há ${min}${THIN}min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours}${THIN}h`;
  return `há ${Math.floor(hours / 24)}${THIN}d`;
}

/** Duração: fmtDuration(80000) -> "1 min 20 s"; 45000 -> "45 s"; 7500000 -> "2 h 05 min". */
export function fmtDuration(ms) {
  if (!isNum(ms) || ms < 0) return NO_VALUE;
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (hours > 0) return `${hours}${THIN}h ${String(min).padStart(2, '0')}${THIN}min`;
  if (min > 0) return sec ? `${min}${THIN}min ${sec}${THIN}s` : `${min}${THIN}min`;
  return `${sec}${THIN}s`;
}

/** Frequência: fmtFreq(2437) -> "2437 MHz" (sem ponto de milhar, para não parecer decimal). */
export function fmtFreq(mhz) {
  if (!isNum(mhz)) return NO_VALUE;
  return withUnit(String(Math.round(mhz)), 'MHz');
}

/** Largura de canal: fmtWidth(80) -> "80 MHz". */
export function fmtWidth(mhz) {
  if (!isNum(mhz) || mhz <= 0) return NO_VALUE;
  return withUnit(String(Math.round(mhz)), 'MHz');
}

/** Faixa: aceita a chave ('2.4', '5', '6', '60') ou uma frequência em MHz. fmtBand('2.4') -> "2,4 GHz". */
export function fmtBand(band) {
  let key = band;
  if (isNum(band) && band > 100) {
    if (band >= 2400 && band <= 2500) key = '2.4';
    else if (band >= 5150 && band <= 5895) key = '5';
    else if (band >= 5925 && band <= 7125) key = '6';
    else if (band >= 57000 && band <= 71000) key = '60';
    else return NO_VALUE;
  }
  const text = key == null ? '' : String(key).replace(',', '.');
  if (text !== '2.4' && text !== '5' && text !== '6' && text !== '60') return NO_VALUE;
  return withUnit(text.replace('.', ','), 'GHz');
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Hora local de um instante (ms desde 1970): "14:32:05"; com {seconds:false}, "14:32". */
export function fmtClock(ts, { seconds = true } = {}) {
  if (!isNum(ts)) return NO_VALUE;
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${seconds ? `:${pad2(d.getSeconds())}` : ''}`;
}

/** Data e hora locais: "15/11/2026 14:32". */
export function fmtDateTime(ts) {
  if (!isNum(ts)) return NO_VALUE;
  const d = new Date(ts);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Contagem com a palavra certa: plural(1, 'rede', 'redes') -> "1 rede"; plural(7, ...) -> "7 redes". */
export function plural(n, singular, pluralForm) {
  const count = isNum(n) ? n : 0;
  return `${fmtNum(count)} ${Math.abs(count) === 1 ? singular : pluralForm}`;
}
