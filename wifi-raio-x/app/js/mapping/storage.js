// Mapas salvos no aparelho.
//
// O que se guarda de cada mapa é o levantamento (Survey) e a solução (MapSolution); o modelo 3D
// é refeito a partir deles sempre que o mapa é aberto (buildMap é determinístico).
//
// ---------------------------------------------------------------------------------------------
// API
//
//   const maps = await openMapStore();          // nunca falha: cai para um armazenamento pior
//   maps.kind                                   'idb' | 'local' | 'memory'
//   maps.persistent                             false = só na memória (some ao fechar o app)
//   maps.lastError                              último problema (MapStoreError) ou null
//
//   await maps.list()   -> [{ id, name, createdAt, updatedAt, stats: { scans, spots, floors, areaM2, level },
//                             thumb, demo, meta }]   do mais recente para o mais antigo; registro corrompido é pulado
//                                               (thumb: data URL de imagem pequena ou null; meta: o mesmo de get())
//   await maps.get(id)  -> { id, name, createdAt, updatedAt, survey, solution, own, meta, stats, thumb, demo } | null
//   await maps.put(rec) -> id                   cria (sem id) ou atualiza (com id). `rec`:
//                                                 { id?, name, survey, solution, own, meta, thumb, demo,
//                                                   stats: { areaM2, level } }   <- do modelo (model.quality)
//                                               scans/spots/floors de `stats` são contados aqui, do levantamento.
//                                               REJEITA com MapStoreError: code 'quota' (sem espaço),
//                                               'invalid' (dados que não são um mapa) ou 'failed'.
//   await maps.rename(id, name) -> boolean
//   await maps.setThumb(id, dataUrl) -> boolean  troca só a miniatura (a data do mapa não muda)
//   await maps.remove(id)       -> boolean
//   await maps.clear()                          apaga todos os mapas e o rascunho
//
//   maps.draft.save(recorderJson) -> Promise<boolean>   levantamento em andamento (rec.toJSON()); nunca lança
//   maps.draft.load()             -> Promise<object|null>
//   maps.draft.clear()            -> Promise<void>
//
//   await maps.exportMap(id)    -> string       um mapa como texto JSON (para bridge.saveFile / share)
//   await maps.importMap(json)  -> id           confere tudo (o arquivo pode ter vindo de qualquer lugar);
//                                               rejeita com MapStoreError 'invalid' | 'quota' | 'failed'
//   maps.close()
//
// Onde fica: banco IndexedDB "wrx-maps" (o "apagar dados salvos" do app apaga todo banco cujo
// nome começa com "wrx"). Sem IndexedDB, ou se ele falhar ao abrir: localStorage (chaves
// "wrx.maps.*"); sem localStorage: memória. Tudo o que é lido é conferido de novo: um registro
// estragado não derruba a lista — é pulado.

import { sanitizeSurvey } from './recorder.js';

export const DB_NAME = 'wrx-maps';
const DB_VERSION = 1;
const STORE_MAPS = 'maps'; // registros completos, por id
const STORE_INDEX = 'index'; // linha da lista (sem o levantamento), por id
const STORE_KV = 'kv'; // rascunho
const DRAFT_KEY = 'draft';
const LS_PREFIX = 'wrx.maps.';
const LS_INDEX = `${LS_PREFIX}index`;
const LS_ITEM = `${LS_PREFIX}item.`;
const LS_DRAFT = `${LS_PREFIX}draft`;

export const MAP_FILE_FORMAT = 'wifi-raio-x.mapa';
export const MAP_FILE_VERSION = 1;
const RECORD_VERSION = 1;

const MAX_NAME = 60;
const MAX_THUMB_CHARS = 400_000; // ~300 kB de imagem
const MAX_META_CHARS = 20_000;
const MAX_OWN = 400;
const MAX_IMPORT_CHARS = 16_000_000;
// Um arquivo de fora pode caber no tamanho e ainda assim ser feito para travar o app ao abrir:
// dezenas de milhares de "redes" diferentes ou milhares de lugares marcados. Os tetos abaixo
// ficam muito acima de qualquer levantamento de verdade (o mais carregado medido tinha ~1.500
// BSSIDs; ninguém marca 500 lugares andando pela casa).
export const MAX_IMPORT_APS = 5000;
export const MAX_IMPORT_SPOTS = 500;
const MAX_DRAFT_CHARS = 12_000_000;
const OPEN_TIMEOUT_MS = 4000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const BSSID_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const THUMB_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const LEVEL_RE = /^[a-zà-ú]{1,20}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => (isNum(v) ? Math.max(0, Math.min(1, v)) : 0);

const MESSAGES = {
  quota: 'Sem espaço para salvar o mapa. Apague mapas antigos e tente de novo.',
  invalid: 'Os dados deste mapa estão incompletos ou não são um mapa do WiFi Raio-X.',
  failed: 'Não foi possível gravar o mapa neste aparelho.',
};

/** Erro de armazenamento, com texto pronto para mostrar e `code`: 'quota' | 'invalid' | 'failed'. */
export class MapStoreError extends Error {
  constructor(code, message, cause) {
    super(message || MESSAGES[code] || MESSAGES.failed);
    this.name = 'MapStoreError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function isQuota(err) {
  if (!err) return false;
  return err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014 || /quota/i.test(String(err.message || ''));
}

function toStoreError(err) {
  if (err instanceof MapStoreError) return err;
  return new MapStoreError(isQuota(err) ? 'quota' : 'failed', undefined, err);
}

// ---------------------------------------------------------------------------
// Conferência do que entra e do que sai
// ---------------------------------------------------------------------------

/** Nome de mapa: texto simples e curto. */
export function cleanName(value, fallback = 'Mapa sem nome') {
  if (typeof value !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  const out = chars.length > MAX_NAME ? chars.slice(0, MAX_NAME).join('').trim() : text;
  return out || fallback;
}

function newId() {
  let tail = '';
  try {
    const bytes = new Uint8Array(6);
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) tail += (b % 36).toString(36);
  } catch {
    tail = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  }
  return `m${Date.now().toString(36)}${tail}`;
}

/** JSON.parse que descarta chaves capazes de mexer em protótipos. */
function safeParse(text) {
  return JSON.parse(text, (key, value) => (BAD_KEYS.has(key) ? undefined : value));
}

/** Cópia de `meta` só com o que é JSON, sem chaves perigosas e com tamanho limitado. */
function cleanMeta(value) {
  if (!isObj(value)) return {};
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || text.length > MAX_META_CHARS) return {};
    const out = safeParse(text);
    return isObj(out) ? out : {};
  } catch {
    return {};
  }
}

function cleanSolution(input, scanCount) {
  if (!isObj(input) || !Array.isArray(input.points) || input.points.length !== scanCount) return null;
  const ok = (v) => isNum(v) && Math.abs(v) < 1e6;
  const points = [];
  for (const p of input.points) {
    if (!isObj(p) || !ok(p.x) || !ok(p.y) || !ok(p.z)) return null;
    points.push({ x: p.x, y: p.y, z: p.z, conf: clamp01(p.conf) });
  }
  const aps = {};
  if (isObj(input.aps)) {
    for (const key of Object.keys(input.aps)) {
      const a = input.aps[key];
      if (!BSSID_RE.test(key) || !isObj(a) || !ok(a.x) || !ok(a.y) || !ok(a.z)) continue;
      aps[key] = { x: a.x, y: a.y, z: a.z, p0: ok(a.p0) ? a.p0 : -40, n: ok(a.n) ? a.n : 2.5, conf: clamp01(a.conf) };
    }
  }
  return { points, aps, scaleConf: clamp01(input.scaleConf) };
}

function cleanOwn(value) {
  const out = [];
  const list = Array.isArray(value) ? value : value instanceof Set ? [...value] : [];
  for (const item of list) {
    const id = typeof item === 'string' ? item.trim().toLowerCase() : '';
    if (BSSID_RE.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_OWN) break;
  }
  return out;
}

const cleanThumb = (value) => (typeof value === 'string' && value.length <= MAX_THUMB_CHARS && THUMB_RE.test(value) ? value : null);
const cleanTime = (value, fallback) => (isNum(value) && value > 0 && value < 8.64e15 ? Math.round(value) : fallback);

function surveyStats(survey, given) {
  const spots = new Set();
  const floors = new Set();
  for (const s of survey.scans) {
    floors.add(s.floor);
    if (s.spot !== null) spots.add(s.spot);
  }
  const g = isObj(given) ? given : {};
  return {
    scans: survey.scans.length,
    spots: spots.size,
    floors: Math.max(1, floors.size),
    areaM2: isNum(g.areaM2) && g.areaM2 >= 0 && g.areaM2 < 1e7 ? Math.round(g.areaM2 * 10) / 10 : null,
    level: typeof g.level === 'string' && LEVEL_RE.test(g.level) ? g.level : null,
  };
}

/**
 * Registro completo e limpo a partir de qualquer coisa (o que veio do banco, de um arquivo ou
 * da tela). null = não é um mapa.
 */
function cleanRecord(input, now) {
  if (!isObj(input)) return null;
  if (input.v !== undefined && input.v !== RECORD_VERSION) return null; // formato de uma versão futura: não mexe
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) return null;
  const survey = sanitizeSurvey(input.survey);
  if (!survey) return null;
  const createdAt = cleanTime(input.createdAt, now);
  return {
    id: input.id,
    name: cleanName(input.name),
    createdAt,
    updatedAt: Math.max(createdAt, cleanTime(input.updatedAt, now)),
    survey,
    solution: cleanSolution(input.solution, survey.scans.length),
    own: cleanOwn(input.own),
    meta: cleanMeta(input.meta),
    stats: surveyStats(survey, input.stats),
    thumb: cleanThumb(input.thumb),
    demo: input.demo === true,
  };
}

const entryOf = (rec) => ({ id: rec.id, name: rec.name, createdAt: rec.createdAt, updatedAt: rec.updatedAt, stats: { ...rec.stats }, thumb: rec.thumb, demo: rec.demo, meta: rec.meta });

/** Linha da lista conferida, ou null. */
function cleanEntry(input) {
  if (!isObj(input) || typeof input.id !== 'string' || !ID_RE.test(input.id)) return null;
  if (!isNum(input.createdAt) || !isNum(input.updatedAt) || !isObj(input.stats)) return null;
  const s = input.stats;
  if (!isNum(s.scans) || !isNum(s.spots) || !isNum(s.floors)) return null;
  return {
    id: input.id,
    name: cleanName(input.name),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    stats: {
      scans: Math.max(0, Math.round(s.scans)),
      spots: Math.max(0, Math.round(s.spots)),
      floors: Math.max(1, Math.round(s.floors)),
      areaM2: isNum(s.areaM2) && s.areaM2 >= 0 ? s.areaM2 : null,
      level: typeof s.level === 'string' && LEVEL_RE.test(s.level) ? s.level : null,
    },
    thumb: cleanThumb(input.thumb),
    demo: input.demo === true,
    meta: cleanMeta(input.meta),
  };
}

// ---------------------------------------------------------------------------
// Arquivo de um mapa (exportar / importar)
// ---------------------------------------------------------------------------

/** Texto JSON de um mapa (registro já conferido). */
export function serializeMap(record, now = Date.now()) {
  return JSON.stringify({
    format: MAP_FILE_FORMAT,
    version: MAP_FILE_VERSION,
    exportedAt: now,
    map: {
      name: record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      demo: record.demo === true,
      stats: record.stats,
      own: record.own,
      meta: record.meta,
      // (a miniatura não vai no arquivo: quem importa refaz a dele; veja parseMapFile)
      survey: record.survey,
      solution: record.solution,
    },
  });
}

/**
 * Lê o texto de um arquivo de mapa vindo de qualquer lugar. Devolve o registro limpo (com o `id`
 * pedido) ou lança MapStoreError 'invalid' com o motivo.
 * @param {unknown} text
 * @param {{id?: string, now?: number}} [options]
 */
export function parseMapFile(text, options = {}) {
  const now = options.now ?? Date.now();
  if (typeof text !== 'string' || text.length === 0) throw new MapStoreError('invalid', 'Este arquivo não é um mapa do WiFi Raio-X.');
  if (text.length > MAX_IMPORT_CHARS) throw new MapStoreError('invalid', 'Arquivo grande demais para ser um mapa.');
  let data;
  try {
    data = safeParse(text);
  } catch (err) {
    throw new MapStoreError('invalid', 'Este arquivo não é um mapa do WiFi Raio-X.', err);
  }
  if (!isObj(data) || data.format !== MAP_FILE_FORMAT || !isObj(data.map)) throw new MapStoreError('invalid', 'Este arquivo não é um mapa do WiFi Raio-X.');
  if (!Number.isInteger(data.version) || data.version < 1) throw new MapStoreError('invalid', 'Este arquivo não é um mapa do WiFi Raio-X.');
  if (data.version > MAP_FILE_VERSION) throw new MapStoreError('invalid', 'Este mapa foi salvo por uma versão mais nova do app. Atualize o WiFi Raio-X para abrir.');
  const map = data.map;
  // datas do futuro (relógio errado ou arquivo adulterado) viram "agora"
  const past = (v) => (isNum(v) && v > 0 && v <= now + 86_400_000 ? v : now);
  const record = cleanRecord(
    {
      id: options.id || newId(),
      name: map.name,
      createdAt: past(map.createdAt),
      updatedAt: past(map.updatedAt),
      survey: map.survey,
      solution: map.solution,
      own: map.own,
      meta: map.meta,
      stats: map.stats,
      // A miniatura de um arquivo NUNCA é aproveitada: é uma imagem escolhida por quem mandou o
      // arquivo, e um PNG de poucos kB pode ter dezenas de megapixels (centenas de MB de memória
      // cada vez que a lista de mapas aparece). A tela refaz a miniatura quando o mapa é aberto.
      thumb: null,
      demo: map.demo,
    },
    now,
  );
  if (!record) throw new MapStoreError('invalid', 'O arquivo está incompleto: falta o levantamento do mapa.');
  if (record.survey.scans.length === 0) throw new MapStoreError('invalid', 'O arquivo não traz nenhuma medição.');
  if (Object.keys(record.survey.aps).length > MAX_IMPORT_APS) throw new MapStoreError('invalid', 'Este arquivo tem redes demais para ser um mapa feito pelo WiFi Raio-X.');
  if (record.stats.spots > MAX_IMPORT_SPOTS) throw new MapStoreError('invalid', 'Este arquivo tem lugares marcados demais para ser um mapa feito pelo WiFi Raio-X.');
  return record;
}

// ---------------------------------------------------------------------------
// Armazenamento em chave/valor (localStorage ou memória)
// ---------------------------------------------------------------------------

/** Um "localStorage" que vive só na memória. */
export function memoryStorage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
    setItem: (k, v) => void data.set(String(k), String(v)),
    removeItem: (k) => void data.delete(String(k)),
    clear: () => data.clear(),
  };
}

function kvBackend(storage) {
  const readJson = (key) => {
    try {
      const text = storage.getItem(key);
      return typeof text === 'string' ? safeParse(text) : null;
    } catch {
      return null; // texto corrompido = não existe
    }
  };
  const itemKeys = () => {
    const out = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (typeof key === 'string' && key.startsWith(LS_ITEM)) out.push(key);
    }
    return out;
  };
  const readIndex = () => {
    const list = readJson(LS_INDEX);
    return Array.isArray(list) ? list : [];
  };
  const writeIndex = (list) => {
    if (list.length) storage.setItem(LS_INDEX, JSON.stringify(list));
    else storage.removeItem(LS_INDEX); // lista vazia não ocupa chave
  };
  return {
    async rows() {
      return { entries: readIndex(), ids: itemKeys().map((k) => k.slice(LS_ITEM.length)) };
    },
    async read(id) {
      return readJson(LS_ITEM + id);
    },
    async write(record, entry) {
      const key = LS_ITEM + record.id;
      const before = storage.getItem(key);
      storage.setItem(key, JSON.stringify(record));
      try {
        writeIndex([...readIndex().filter((e) => !isObj(e) || e.id !== record.id), entry]);
      } catch (err) {
        // não coube a lista: desfaz o registro para os dois não ficarem em desacordo
        try {
          if (before === null) storage.removeItem(key);
          else storage.setItem(key, before);
        } catch {
          // fica como está; a lista é refeita a partir dos registros na próxima leitura
        }
        throw err;
      }
    },
    async writeEntry(entry) {
      writeIndex([...readIndex().filter((e) => !isObj(e) || e.id !== entry.id), entry]);
    },
    async removeEntry(id) {
      const rows = readIndex();
      const kept = rows.filter((e) => !isObj(e) || e.id !== id);
      if (kept.length !== rows.length) writeIndex(kept);
    },
    async remove(id) {
      storage.removeItem(LS_ITEM + id);
      const rows = readIndex();
      const kept = rows.filter((e) => !isObj(e) || e.id !== id);
      if (kept.length !== rows.length) writeIndex(kept);
    },
    async clear() {
      for (const key of itemKeys()) storage.removeItem(key);
      storage.removeItem(LS_INDEX);
      storage.removeItem(LS_DRAFT);
    },
    async draftLoad() {
      return readJson(LS_DRAFT);
    },
    async draftSave(value) {
      const text = JSON.stringify(value);
      if (typeof text !== 'string' || text.length > MAX_DRAFT_CHARS) throw new MapStoreError('quota');
      storage.setItem(LS_DRAFT, text);
    },
    async draftClear() {
      storage.removeItem(LS_DRAFT);
    },
    close() {},
  };
}

/** O localStorage funciona de verdade? (modo privado e WebView sem DOM storage lançam ao gravar) */
function usableStorage(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') return false;
    const probe = `${LS_PREFIX}teste`;
    storage.setItem(probe, '1');
    const ok = storage.getItem(probe) === '1';
    storage.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function openDatabase(factory, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    // em alguns navegadores (modo privado) o pedido de abrir fica sem resposta para sempre
    const timer = setTimeout(() => finish(reject, new Error('o IndexedDB não respondeu')), timeoutMs);
    let request;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (err) {
      finish(reject, err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_MAPS)) db.createObjectStore(STORE_MAPS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_INDEX)) db.createObjectStore(STORE_INDEX, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close(); // respondeu depois do prazo: já estamos em outro armazenamento
        return;
      }
      finish(resolve, db);
    };
    request.onerror = () => finish(reject, request.error || new Error('falha ao abrir o IndexedDB'));
    request.onblocked = () => {}; // outra aba com versão antiga: o prazo decide
  });
}

function idbBackend(factory, firstDb, timeoutMs) {
  let db = null;
  let closed = false;

  function adopt(next) {
    db = next;
    // "apagar dados salvos" apaga o banco: solta a conexão para não bloquear; a próxima operação reabre
    db.onversionchange = () => {
      try {
        db.close();
      } catch {
        // já fechado
      }
      db = null;
    };
    db.onclose = () => {
      db = null;
    };
  }
  adopt(firstDb);

  async function connection() {
    if (closed) throw new Error('armazenamento fechado');
    if (!db) adopt(await openDatabase(factory, timeoutMs));
    return db;
  }

  /** Roda `fn(lojas)` numa transação e resolve com o que ela devolver quando a transação termina. */
  async function transact(names, mode, fn, retry = true) {
    const conn = await connection();
    let tx;
    try {
      tx = conn.transaction(names, mode);
    } catch (err) {
      // a conexão caiu por baixo (banco apagado por outra tela): reabre uma vez
      if (retry && err && err.name === 'InvalidStateError') {
        db = null;
        return transact(names, mode, fn, false);
      }
      throw err;
    }
    return new Promise((resolve, reject) => {
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error('transação cancelada'));
      tx.onerror = () => {}; // o erro chega em onabort, com tx.error preenchido
      try {
        result = fn(Object.fromEntries(names.map((n) => [n, tx.objectStore(n)])));
      } catch (err) {
        try {
          tx.abort();
        } catch {
          // já terminou
        }
        reject(err);
      }
    });
  }

  /** Pedido -> um lugar onde o resultado aparece quando a transação termina. */
  const hold = (request) => {
    const box = { value: undefined };
    request.onsuccess = () => {
      box.value = request.result;
    };
    return box;
  };

  return {
    async rows() {
      const out = await transact([STORE_INDEX, STORE_MAPS], 'readonly', (s) => ({ entries: hold(s[STORE_INDEX].getAll()), ids: hold(s[STORE_MAPS].getAllKeys()) }));
      return { entries: out.entries.value || [], ids: (out.ids.value || []).filter((k) => typeof k === 'string') };
    },
    async read(id) {
      const box = await transact([STORE_MAPS], 'readonly', (s) => hold(s[STORE_MAPS].get(id)));
      return box.value ?? null;
    },
    async write(record, entry) {
      await transact([STORE_MAPS, STORE_INDEX], 'readwrite', (s) => {
        s[STORE_MAPS].put(record);
        s[STORE_INDEX].put(entry);
      });
    },
    async writeEntry(entry) {
      await transact([STORE_INDEX], 'readwrite', (s) => void s[STORE_INDEX].put(entry));
    },
    async removeEntry(id) {
      await transact([STORE_INDEX], 'readwrite', (s) => void s[STORE_INDEX].delete(id));
    },
    async remove(id) {
      await transact([STORE_MAPS, STORE_INDEX], 'readwrite', (s) => {
        s[STORE_MAPS].delete(id);
        s[STORE_INDEX].delete(id);
      });
    },
    async clear() {
      await transact([STORE_MAPS, STORE_INDEX, STORE_KV], 'readwrite', (s) => {
        s[STORE_MAPS].clear();
        s[STORE_INDEX].clear();
        s[STORE_KV].clear();
      });
    },
    async draftLoad() {
      const box = await transact([STORE_KV], 'readonly', (s) => hold(s[STORE_KV].get(DRAFT_KEY)));
      return box.value ?? null;
    },
    async draftSave(value) {
      await transact([STORE_KV], 'readwrite', (s) => void s[STORE_KV].put(value, DRAFT_KEY));
    },
    async draftClear() {
      await transact([STORE_KV], 'readwrite', (s) => void s[STORE_KV].delete(DRAFT_KEY));
    },
    close() {
      closed = true;
      try {
        if (db) db.close();
      } catch {
        // já fechado
      }
      db = null;
    },
  };
}

// ---------------------------------------------------------------------------
// O armazenamento que as telas usam
// ---------------------------------------------------------------------------

/** Quantos registros ainda não conferidos uma chamada de list() abre para conferir. */
const VERIFY_PER_LIST = 60;

function makeStore(backend, kind, now) {
  let lastError = null;
  const note = (err) => {
    lastError = toStoreError(err);
    return lastError;
  };
  // registros já lidos e conferidos por este armazenamento: id -> updatedAt
  const verified = new Map();

  async function get(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    let raw;
    try {
      raw = await backend.read(id);
    } catch (err) {
      note(err);
      return null;
    }
    const record = cleanRecord(raw, now());
    if (record) {
      verified.set(id, record.updatedAt);
      return record;
    }
    verified.delete(id);
    if (raw !== null && raw !== undefined) {
      // Registro que existe mas não presta (ou é de uma versão mais nova do app): sai da lista,
      // para ninguém tentar abrir de novo. Os dados ficam onde estão.
      try {
        await backend.removeEntry(id);
      } catch {
        // some da lista na próxima leitura, de qualquer jeito
      }
    }
    return null;
  }

  async function list() {
    let rows;
    try {
      rows = await backend.rows();
    } catch (err) {
      note(err);
      return [];
    }
    const ids = new Set(rows.ids);
    const byId = new Map();
    for (const raw of Array.isArray(rows.entries) ? rows.entries : []) {
      const entry = cleanEntry(raw);
      if (entry && ids.has(entry.id)) byId.set(entry.id, entry); // linha sem registro = mapa que não existe mais
    }
    // A linha da lista é só um resumo: o registro em si é aberto e conferido uma vez (por
    // armazenamento aberto), dos mais recentes para os mais antigos. Registro estragado some daqui.
    let budget = VERIFY_PER_LIST;
    for (const entry of [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (verified.get(entry.id) === entry.updatedAt) continue;
      if (budget-- <= 0) break;
      const rec = await get(entry.id);
      if (!rec) byId.delete(entry.id);
      else if (rec.updatedAt !== entry.updatedAt || rec.name !== entry.name) byId.set(entry.id, entryOf(rec)); // linha desatualizada: vale o registro
    }
    // registro sem linha (lista estragada): refaz a linha a partir do registro, se ele estiver inteiro
    for (const id of ids) {
      if (byId.has(id) || !ID_RE.test(id)) continue;
      const rec = await get(id);
      if (!rec) continue;
      const entry = entryOf(rec);
      byId.set(id, entry);
      try {
        await backend.writeEntry(entry);
      } catch (err) {
        note(err);
      }
    }
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  }

  async function save(record) {
    try {
      await backend.write({ v: RECORD_VERSION, ...record }, entryOf(record));
    } catch (err) {
      throw note(err);
    }
    verified.set(record.id, record.updatedAt);
    return record.id;
  }

  async function put(input) {
    if (!isObj(input)) throw note(new MapStoreError('invalid'));
    const t = now();
    let id = null;
    let createdAt = cleanTime(input.createdAt, t);
    if (input.id !== undefined && input.id !== null) {
      if (typeof input.id !== 'string' || !ID_RE.test(input.id)) throw note(new MapStoreError('invalid'));
      id = input.id;
      const before = await get(id);
      if (before) createdAt = before.createdAt; // a data de criação não muda numa atualização
    }
    const record = cleanRecord({ ...input, v: RECORD_VERSION, id: id || newId(), createdAt, updatedAt: t }, t);
    if (!record) throw note(new MapStoreError('invalid'));
    return save(record);
  }

  return {
    kind,
    persistent: kind !== 'memory',
    get lastError() {
      return lastError;
    },
    list,
    get,
    put,

    async rename(id, name) {
      const record = await get(id);
      if (!record) return false;
      record.name = cleanName(name, record.name);
      await save(record);
      return true;
    },

    /** Troca só a miniatura de um mapa (feita pela própria tela ao abri-lo); a data do mapa não muda. */
    async setThumb(id, thumb) {
      const clean = cleanThumb(thumb);
      if (!clean) return false;
      const record = await get(id);
      if (!record) return false;
      record.thumb = clean;
      await save(record);
      return true;
    },

    async remove(id) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return false;
      try {
        await backend.remove(id);
        return true;
      } catch (err) {
        note(err);
        return false;
      }
    },

    async clear() {
      try {
        await backend.clear();
      } catch (err) {
        note(err);
      }
    },

    draft: {
      async load() {
        try {
          const value = await backend.draftLoad();
          return isObj(value) ? value : null;
        } catch (err) {
          note(err);
          return null;
        }
      },
      /** Nunca lança: false = não deu para gravar (veja lastError). */
      async save(value) {
        try {
          let data = value;
          if (typeof data === 'string') data = safeParse(data);
          if (!isObj(data)) return false;
          await backend.draftSave(data);
          return true;
        } catch (err) {
          note(err);
          return false;
        }
      },
      async clear() {
        try {
          await backend.draftClear();
        } catch (err) {
          note(err);
        }
      },
    },

    async exportMap(id) {
      const record = await get(id);
      if (!record) throw note(new MapStoreError('invalid', 'Este mapa não existe mais.'));
      return serializeMap(record, now());
    },

    async importMap(json) {
      let record;
      try {
        record = parseMapFile(json, { now: now() });
      } catch (err) {
        throw note(err);
      }
      return save(record);
    },

    close: () => backend.close(),
  };
}

/** Mapas que ficaram no localStorage (de uma vez em que o IndexedDB falhou) passam para o banco. */
async function adoptLocalMaps(idb, storage) {
  try {
    if (!usableStorage(storage)) return;
    const local = kvBackend(storage);
    const { ids } = await local.rows();
    for (const id of ids) {
      const record = cleanRecord(await local.read(id), Date.now());
      if (!record) continue;
      if (!(await idb.read(id))) await idb.write({ v: RECORD_VERSION, ...record }, entryOf(record));
      await local.remove(id);
    }
    if (!(await idb.draftLoad())) {
      const draft = await local.draftLoad();
      if (isObj(draft)) await idb.draftSave(draft);
    }
    await local.draftClear();
  } catch {
    // o que não deu para trazer continua onde estava
  }
}

/**
 * Abre o armazenamento dos mapas. Nunca rejeita: sem IndexedDB usa o localStorage; sem ele, a memória.
 * @param {object} [options]                    (só para testes)
 * @param {IDBFactory|null} [options.indexedDB]
 * @param {Storage|null} [options.localStorage]
 * @param {'auto'|'idb'|'local'|'memory'} [options.backend]  força um tipo (se ele não funcionar, desce a escada)
 * @param {() => number} [options.now]
 * @param {number} [options.openTimeoutMs]
 */
export async function openMapStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const want = options.backend || 'auto';
  const pick = (name) => {
    if (name in options) return options[name];
    try {
      return globalThis[name] ?? null; // só ler `localStorage` já pode lançar (iframe sem permissão)
    } catch {
      return null;
    }
  };
  const storage = pick('localStorage');

  if (want === 'auto' || want === 'idb') {
    const factory = pick('indexedDB');
    if (factory && typeof factory.open === 'function') {
      try {
        const timeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
        const backend = idbBackend(factory, await openDatabase(factory, timeoutMs), timeoutMs);
        await adoptLocalMaps(backend, storage);
        return makeStore(backend, 'idb', now);
      } catch {
        // IndexedDB indisponível ou quebrado: tenta o próximo
      }
    }
  }
  if (want !== 'memory' && usableStorage(storage)) return makeStore(kvBackend(storage), 'local', now);
  return makeStore(kvBackend(memoryStorage()), 'memory', now);
}
