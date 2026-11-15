// Compatibilidade com WebViews antigos (piso: Chrome/WebView 80).
//
// O WebView do Android se atualiza pela Play Store, mas há celulares em que isso não
// acontece. Sintaxe nova demais é barrada pelo teste tests/compat.test.mjs; as FUNÇÕES
// que faltam nesses WebViews são completadas aqui, e só quando faltam. Este arquivo é o
// primeiro import de main.js e do worker, para rodar antes de todo o resto.

/* eslint-disable no-extend-native */
const define = (target, name, value) => {
  if (target && !(name in target)) {
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  }
};

// --- Linguagem ---------------------------------------------------------------
function at(index) {
  const n = Math.trunc(index) || 0;
  const i = n < 0 ? this.length + n : n;
  return i < 0 || i >= this.length ? undefined : this[i];
}
define(Array.prototype, 'at', at);
define(String.prototype, 'at', at);
for (const Typed of [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]) {
  define(Typed.prototype, 'at', at);
}
define(String.prototype, 'replaceAll', function replaceAll(search, replacement) {
  if (search instanceof RegExp) {
    if (!search.global) throw new TypeError('replaceAll precisa de uma expressão global');
    return this.replace(search, replacement);
  }
  return this.split(String(search)).join(typeof replacement === 'function' ? replacement(String(search)) : String(replacement));
});
define(Object, 'hasOwn', (obj, key) => Object.prototype.hasOwnProperty.call(obj, key));
define(Array.prototype, 'findLast', function findLast(fn, thisArg) {
  for (let i = this.length - 1; i >= 0; i -= 1) if (fn.call(thisArg, this[i], i, this)) return this[i];
  return undefined;
});
define(Array.prototype, 'findLastIndex', function findLastIndex(fn, thisArg) {
  for (let i = this.length - 1; i >= 0; i -= 1) if (fn.call(thisArg, this[i], i, this)) return i;
  return -1;
});
if (typeof Promise.any !== 'function') {
  define(Promise, 'any', (list) => {
    const items = Array.from(list);
    return new Promise((resolve, reject) => {
      let left = items.length;
      const errors = [];
      if (!left) reject(new Error('Promise.any: lista vazia'));
      items.forEach((p, i) => {
        Promise.resolve(p).then(resolve, (err) => {
          errors[i] = err;
          left -= 1;
          if (!left) reject(Object.assign(new Error('Todas as promessas falharam'), { errors }));
        });
      });
    });
  });
}
if (typeof globalThis.structuredClone !== 'function') {
  // Cópia profunda do que o app usa: objetos simples, arrays, datas, Map/Set e arrays tipados.
  const clone = (value, seen) => {
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    if (value instanceof Date) return new Date(value.getTime());
    if (ArrayBuffer.isView(value)) return value.slice ? value.slice() : new value.constructor(value);
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (value instanceof Map) {
      const out = new Map();
      seen.set(value, out);
      value.forEach((v, k) => out.set(clone(k, seen), clone(v, seen)));
      return out;
    }
    if (value instanceof Set) {
      const out = new Set();
      seen.set(value, out);
      value.forEach((v) => out.add(clone(v, seen)));
      return out;
    }
    const out = Array.isArray(value) ? [] : {};
    seen.set(value, out);
    for (const key of Object.keys(value)) out[key] = clone(value[key], seen);
    return out;
  };
  globalThis.structuredClone = (value) => clone(value, new Map());
}

// --- Navegador (não existe dentro do Worker nem no Node) -------------------------
if (typeof Element !== 'undefined') {
  function replaceChildren(...nodes) {
    while (this.lastChild) this.removeChild(this.lastChild);
    this.append(...nodes);
  }
  define(Element.prototype, 'replaceChildren', replaceChildren);
  define(Document.prototype, 'replaceChildren', replaceChildren);
  define(DocumentFragment.prototype, 'replaceChildren', replaceChildren);
}
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
}
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function' && crypto.getRandomValues) {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}
if (typeof CanvasRenderingContext2D !== 'undefined') {
  // Retângulo de cantos arredondados (Chrome 99): os gráficos usam em barras e etiquetas.
  define(CanvasRenderingContext2D.prototype, 'roundRect', function roundRect(x, y, w, h, radii = 0) {
    const list = Array.isArray(radii) ? radii : [radii];
    const pick = (i) => {
      const v = list.length === 1 ? list[0] : list.length === 2 ? list[i % 2] : list.length === 3 ? list[[0, 1, 2, 1][i]] : list[i];
      const r = typeof v === 'object' && v !== null ? v.x : v;
      return Math.max(0, Math.min(Number(r) || 0, Math.abs(w) / 2, Math.abs(h) / 2));
    };
    const [tl, tr, br, bl] = [pick(0), pick(1), pick(2), pick(3)];
    this.moveTo(x + tl, y);
    this.lineTo(x + w - tr, y);
    this.arcTo(x + w, y, x + w, y + tr, tr);
    this.lineTo(x + w, y + h - br);
    this.arcTo(x + w, y + h, x + w - br, y + h, br);
    this.lineTo(x + bl, y + h);
    this.arcTo(x, y + h, x, y + h - bl, bl);
    this.lineTo(x, y + tl);
    this.arcTo(x, y, x + tl, y, tl);
    this.closePath();
  });
}

// --- CSS: `gap` em contêiner flex (Chrome 84) -----------------------------------
// `CSS.supports('gap', ...)` não serve: responde "sim" por causa do grid. O jeito é medir.
function flexGapWorks(doc) {
  const host = doc.body || doc.documentElement;
  if (!host) return true;
  const box = doc.createElement('div');
  box.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden;margin:0;padding:0;border:0';
  box.appendChild(doc.createElement('div'));
  box.appendChild(doc.createElement('div'));
  host.appendChild(box);
  const works = box.scrollHeight === 1;
  host.removeChild(box);
  return works;
}

/**
 * Onde falta o `gap` em flex, carrega css/flex-gap-fallback.css (gerada por tools/flex-gap-fallback.mjs)
 * ANTES das outras folhas, para as margens que o app dá aos filhos continuarem valendo, e marca
 * <html class="no-flex-gap">. `force` = carregar de qualquer jeito (testes).
 * @returns {boolean} a folha de reserva foi (ou já estava) carregada
 */
export function ensureFlexGap(doc = globalThis.document, force = false) {
  if (!doc || !doc.head || typeof doc.createElement !== 'function') return false;
  if (doc.getElementById('wrx-flex-gap-css')) return true;
  let works = true;
  try {
    works = flexGapWorks(doc);
  } catch {
    // sem como medir: fica como está
  }
  if (works && !force) return false;
  const link = doc.createElement('link');
  link.id = 'wrx-flex-gap-css';
  link.rel = 'stylesheet';
  link.href = new URL('../css/flex-gap-fallback.css', import.meta.url).href;
  doc.head.insertBefore(link, doc.head.querySelector('link[rel="stylesheet"], style'));
  doc.documentElement.classList.add('no-flex-gap');
  return true;
}
if (typeof document !== 'undefined') ensureFlexGap();

// --- Página congelada pelo WebView (Page Lifecycle) -----------------------------
// Depois de 5 minutos em segundo plano o WebView congela a página (`freeze`). Quando o usuário volta,
// ela recebe `resume` já com document.hidden === false, mas o WebView 83 NÃO manda o
// `visibilitychange` correspondente (medido num Android 11 de verdade). Tudo o que espera esse aviso
// para voltar a trabalhar (o laço de buscas, o medidor, o desenho do mapa) ficava parado até o app
// ser escondido e aberto de novo. Aqui o aviso que faltou é mandado: se, logo depois de um `resume`
// ou `pageshow`, o estado que os ouvintes viram por último não é o de verdade, sai um
// `visibilitychange`. Onde o WebView avisa direito, nada acontece.
/**
 * @param {Document} [doc]
 * @param {{delayMs?: number, setTimer?: (fn: () => void, ms: number) => any}} [options]
 * @returns {() => void} desfaz (para os testes)
 */
export function installVisibilityRepair(doc = globalThis.document, { delayMs = 250, setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
  if (!doc || typeof doc.addEventListener !== 'function' || typeof Event !== 'function') return () => {};
  let seen = !!doc.hidden; // o que o último `visibilitychange` mostrou aos ouvintes
  const onChange = () => {
    seen = !!doc.hidden;
  };
  const repair = () => {
    setTimer(() => {
      if (!!doc.hidden === seen) return; // o aviso de verdade chegou (ou nada mudou)
      seen = !!doc.hidden;
      doc.dispatchEvent(new Event('visibilitychange'));
    }, delayMs);
  };
  const win = doc.defaultView || null;
  doc.addEventListener('visibilitychange', onChange, true);
  doc.addEventListener('resume', repair);
  if (win && typeof win.addEventListener === 'function') win.addEventListener('pageshow', repair);
  return () => {
    doc.removeEventListener('visibilitychange', onChange, true);
    doc.removeEventListener('resume', repair);
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('pageshow', repair);
  };
}
if (typeof document !== 'undefined') installVisibilityRepair();
