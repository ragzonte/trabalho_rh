// Preferências guardadas no aparelho: localStorage, sempre com chaves "wrx.*".
//
// Nada aqui lança exceção: armazenamento indisponível (modo privado, WebView sem DOM storage),
// cota estourada ou JSON corrompido viram "usa o padrão" — e, sem armazenamento, os valores
// ficam só na memória até o app fechar.
//
//   const prefs = createPrefs();
//   prefs.loadSettings()            -> Settings validado (padrões no que faltar ou estiver errado)
//   prefs.saveSettings({theme})     -> grava só o que mudou e devolve o Settings completo
//   prefs.loadFavorites() / saveFavorites(lista de SSIDs)
//   prefs.get(chave, padrão) / set(chave, valor) / remove(chave)    para dados de outras telas
//   prefs.keys() / prefs.clear()    tudo o que é "wrx.*"
//   prefs.persistent                false = só na memória
//
// Chaves em uso: wrx.settings, wrx.favorites (as demais são de quem as criou).

export const PREFIX = 'wrx.';

/**
 * @typedef {Object} Settings
 * @property {'system'|'dark'|'light'} theme
 * @property {'auto'|number} scanIntervalS   intervalo entre buscas, em segundos; 'auto' = o app decide
 * @property {boolean} demo                  modo demonstração (simulador no lugar do celular)
 * @property {string} demoWorld              casa virtual do modo demonstração (id de sim/presets.js)
 * @property {'metric'|'imperial'} units
 * @property {string[]} tipsDismissed        ids das dicas que o usuário dispensou
 */

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  scanIntervalS: 'auto',
  demo: false,
  demoWorld: 'apartamento',
  units: 'metric',
  tipsDismissed: Object.freeze([]),
});

export const THEMES = Object.freeze(['system', 'dark', 'light']);
/** Limites aceitos para um intervalo escolhido à mão (s). */
export const SCAN_INTERVAL_MIN_S = 3;
export const SCAN_INTERVAL_MAX_S = 600;

const MAX_TIPS = 200;
const MAX_FAVORITES = 200;

function stringList(value, maxItems, maxLength) {
  const out = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > maxLength) continue;
    if (!out.includes(item)) out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Qualquer coisa -> Settings válido. Campo ausente ou com valor estranho recebe o padrão.
 * @param {unknown} raw
 * @returns {Settings}
 */
export function sanitizeSettings(raw) {
  const o = raw !== null && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  let scanIntervalS = d.scanIntervalS;
  if (typeof o.scanIntervalS === 'number' && Number.isFinite(o.scanIntervalS)) {
    scanIntervalS = Math.min(SCAN_INTERVAL_MAX_S, Math.max(SCAN_INTERVAL_MIN_S, Math.round(o.scanIntervalS)));
  }
  return {
    theme: THEMES.includes(o.theme) ? o.theme : d.theme,
    scanIntervalS,
    demo: o.demo === true,
    demoWorld: typeof o.demoWorld === 'string' && /^[a-z0-9-]{1,40}$/.test(o.demoWorld) ? o.demoWorld : d.demoWorld,
    units: o.units === 'imperial' ? 'imperial' : 'metric',
    tipsDismissed: stringList(o.tipsDismissed, MAX_TIPS, 60),
  };
}

/** Armazenamento só na memória, com a mesma cara do localStorage. */
export function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  };
}

function probe(storage) {
  try {
    const key = `${PREFIX}__teste`;
    storage.setItem(key, '1');
    const ok = storage.getItem(key) === '1';
    storage.removeItem(key);
    return ok;
  } catch {
    return false;
  }
}

function defaultStorage() {
  try {
    // só ler a propriedade já pode lançar SecurityError
    const ls = globalThis.localStorage;
    if (ls && probe(ls)) return ls;
  } catch {
    // segue para a memória
  }
  return null;
}

/**
 * @param {Storage} [storage]  padrão: localStorage; se não funcionar, memória
 */
export function createPrefs(storage) {
  const real = storage && probe(storage) ? storage : storage ? null : defaultStorage();
  const store = real || memoryStorage();

  function get(key, fallback = null) {
    try {
      const text = store.getItem(PREFIX + key);
      if (text == null) return fallback;
      const value = JSON.parse(text);
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  /** @returns {boolean} false se não coube ou não deu para gravar */
  function set(key, value) {
    try {
      store.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function remove(key) {
    try {
      store.removeItem(PREFIX + key);
    } catch {
      // nada a fazer
    }
  }

  /** Chaves do app que existem agora, sem o prefixo. */
  function keys() {
    const out = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (typeof key === 'string' && key.startsWith(PREFIX)) out.push(key.slice(PREFIX.length));
      }
    } catch {
      // devolve o que conseguiu ler
    }
    return out;
  }

  /** Apaga tudo o que o app guardou aqui (não toca em chaves de outros). */
  function clear() {
    for (const key of keys()) remove(key);
  }

  /** @returns {Settings} */
  function loadSettings() {
    return sanitizeSettings(get('settings', null));
  }

  /**
   * @param {Partial<Settings>} patch
   * @returns {Settings} o resultado, já validado
   */
  function saveSettings(patch) {
    const next = sanitizeSettings({ ...loadSettings(), ...(patch || {}) });
    set('settings', next);
    return next;
  }

  /** @returns {string[]} SSIDs marcados como "minhas redes" */
  function loadFavorites() {
    return stringList(get('favorites', []), MAX_FAVORITES, 64);
  }

  /** @param {Iterable<string>} list */
  function saveFavorites(list) {
    return set('favorites', stringList(Array.from(list || []), MAX_FAVORITES, 64));
  }

  return {
    persistent: real !== null,
    get,
    set,
    remove,
    keys,
    clear,
    loadSettings,
    saveSettings,
    loadFavorites,
    saveFavorites,
  };
}
