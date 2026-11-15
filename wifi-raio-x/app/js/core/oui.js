// Fabricante de um rádio pelo começo do MAC (o "OUI"), sem internet: a tabela da IEEE vai
// dentro do APK, em assets/oui.json (gerada por tools/build-oui.mjs).
//
// Tudo função pura; MAC torto, tabela corrompida ou arquivo que não carregou viram null /
// tabela vazia, nunca exceção.
//
// Formato do oui.json:
//   format    versão deste formato (OUI_FORMAT); outro número = arquivo de outra versão do app
//   source    de onde vieram os dados
//   prefixes  quantos prefixos existem somando as três tabelas
//   shared    quantos nomes, no começo de `names`, são usados por mais de um prefixo
//   names     nomes de fabricante separados por "|": primeiro os `shared` (do mais usado para o
//             menos usado), depois os de uso único, na ordem em que as tabelas os consomem
//   maL, maM, maS   prefixos de 24, 28 e 36 bits (os três tamanhos de bloco que a IEEE vende), em
//             ordem crescente. Cada prefixo são dois números: a distância até o prefixo anterior
//             e a referência do nome (0 = o próximo nome de uso único; n > 0 = names[n - 1])
//   Cada número é escrito em "dígitos" de 5 bits, do menos para o mais significativo; o dígito
//   ganha +32 quando ainda há outro depois dele, e vira um caractere do alfabeto do base64url.

export const OUI_FORMAT = 1;
export const NAME_SEPARATOR = '|';

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DIGIT_OF = new Int8Array(128).fill(-1);
for (let i = 0; i < DIGITS.length; i++) DIGIT_OF[DIGITS.charCodeAt(i)] = i;

// O Android entrega estes endereços quando não tem (ou não pode mostrar) o MAC de verdade:
// WifiInfo.getBSSID() devolve "02:00:00:00:00:00" para quem não tem a permissão de localização.
const PLACEHOLDERS = new Set(['000000000000', '020000000000', 'ffffffffffff']);

const HEX_LENGTHS = { maL: 6, maM: 7, maS: 9 };

/**
 * Escreve um inteiro não negativo no formato do oui.json. Quem usa é o gerador (e os testes).
 * @param {number} value
 * @returns {string}
 */
export function encodeVlq(value) {
  let rest = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  let out = '';
  do {
    const digit = rest % 32;
    rest = (rest - digit) / 32; // divisão em vez de >>: os prefixos de 36 bits não cabem em 32
    out += DIGITS[rest > 0 ? digit + 32 : digit];
  } while (rest > 0);
  return out;
}

/** Texto -> lista de números, ou null se houver caractere estranho ou número cortado no fim. */
function decodeVlq(text) {
  const out = [];
  let value = 0;
  let scale = 1;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const digit = code < 128 ? DIGIT_OF[code] : -1;
    if (digit < 0) return null;
    value += (digit & 31) * scale;
    if (digit & 32) {
      scale *= 32;
    } else {
      out.push(value);
      value = 0;
      scale = 1;
    }
  }
  return scale === 1 ? out : null;
}

/**
 * Qualquer jeito de escrever um MAC ("AA-BB-CC-DD-EE-FF", "aabb.ccdd.eeff", "a:b:c:d:e:f",
 * "AABBCCDDEEFF") -> dígitos hexadecimais minúsculos, sem separador. Também aceita só o começo
 * do endereço ("AA:BB:CC", "aabbcc1"), que basta para achar o fabricante: por isso a resposta
 * tem de 6 a 12 dígitos. Qualquer outra coisa -> null.
 * @param {unknown} mac
 * @returns {string|null}
 */
export function normalizeMac(mac) {
  if (typeof mac !== 'string') return null;
  const text = mac.trim().toLowerCase();
  if (text.length < 5 || text.length > 17) return null;
  if (/^[0-9a-f]{6,12}$/.test(text)) return text;
  if (/^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/.test(text)) return text.replace(/\./g, ''); // jeito da Cisco
  // Octetos separados; alguns sistemas cortam o zero à esquerda ("0:1e:8f:...").
  const parts = text.split(/[:\- ]/);
  if (parts.length < 3 || parts.length > 6 || !parts.every((p) => /^[0-9a-f]{1,2}$/.test(p))) return null;
  return parts.map((p) => p.padStart(2, '0')).join('');
}

/** Primeiro octeto do endereço, ou -1 se o MAC não for válido. */
function firstOctet(mac) {
  const hex = normalizeMac(mac);
  return hex ? parseInt(hex.slice(0, 2), 16) : -1;
}

/**
 * O bit "administrado localmente" (0x02 do primeiro octeto) está ligado? É o bit que separa os
 * endereços inventados por software (MAC aleatório do celular, redes virtuais do roteador) dos
 * gravados de fábrica. MAC inválido -> false.
 * @param {unknown} mac
 * @returns {boolean}
 */
export function isLocallyAdministered(mac) {
  const octet = firstOctet(mac);
  return octet >= 0 && (octet & 0x02) !== 0;
}

/** Posição de `key` na lista crescente `keys`, ou -1. */
function indexOf(keys, key) {
  let lo = 0;
  let hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = keys[mid];
    if (value === key) return mid;
    if (value < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Abre as três tabelas do arquivo; null se algo não bater (aí o app segue sem fabricantes). */
function decodeTables(data) {
  if (!data || typeof data !== 'object' || data.format !== OUI_FORMAT) return null;
  if (typeof data.names !== 'string' || !Number.isInteger(data.shared) || data.shared < 0) return null;
  const names = data.names === '' ? [] : data.names.split(NAME_SEPARATOR);
  if (data.shared > names.length) return null;

  const tables = {};
  let nextSingle = data.shared;
  let size = 0;
  for (const key of Object.keys(HEX_LENGTHS)) {
    const numbers = typeof data[key] === 'string' ? decodeVlq(data[key]) : null;
    if (!numbers || numbers.length % 2) return null;
    const count = numbers.length / 2;
    const keys = new Float64Array(count); // 36 bits não cabem num inteiro de 32
    const ids = new Uint32Array(count);
    let prefix = 0;
    for (let i = 0; i < count; i++) {
      prefix += numbers[2 * i];
      const ref = numbers[2 * i + 1];
      const id = ref === 0 ? nextSingle++ : ref - 1;
      if (id >= names.length || (i > 0 && numbers[2 * i] === 0)) return null;
      keys[i] = prefix;
      ids[i] = id;
    }
    tables[key] = { keys, ids };
    size += count;
  }
  return { names, tables, size };
}

/**
 * @typedef {Object} Vendor
 * @property {string|null} name    fabricante ("TP-Link"); null quando `randomized`
 * @property {boolean} randomized  endereço administrado localmente e sem fabricante conhecido:
 *                                 MAC aleatório (celular, roteador do celular) ou rede virtual
 * @property {boolean} guess       o fabricante saiu do endereço com o bit "local" desligado
 *                                 (BSSID virtual, de convidados ou de mesh): provável, não certo
 */

/**
 * @typedef {Object} OuiLookup
 * @property {(mac: unknown) => Vendor|null} vendor   null = MAC inválido ou fabricante desconhecido
 * @property {(mac: unknown) => boolean} isRandomized
 * @property {(mac: unknown) => string} label         texto pronto para a tela
 * @property {number} size       quantos prefixos a tabela tem (0 = não carregou)
 * @property {boolean} loaded    a tabela foi lida sem problemas
 * @property {string} source     origem dos dados ('' se não carregou)
 * @property {string|null} error por que não carregou (só em loadOui)
 */

/**
 * Monta a consulta a partir do conteúdo de assets/oui.json (o objeto já convertido, ou o texto).
 * @param {unknown} data
 * @returns {OuiLookup}
 */
export function createOuiLookup(data) {
  if (typeof data === 'string') {
    // Quem leu o arquivo como texto não precisa converter antes.
    try {
      data = JSON.parse(data);
    } catch {
      data = null;
    }
  }
  const decoded = decodeTables(data);
  const names = decoded ? decoded.names : [];
  const tables = decoded ? decoded.tables : null;

  /** Nome do bloco mais específico que contém o endereço (36 bits, depois 28, depois 24). */
  function find(hex) {
    if (!tables) return null;
    for (const key of ['maS', 'maM', 'maL']) {
      const length = HEX_LENGTHS[key];
      if (hex.length < length) continue;
      const { keys, ids } = tables[key];
      const at = indexOf(keys, parseInt(hex.slice(0, length), 16));
      if (at >= 0) return names[ids[at]];
    }
    return null;
  }

  function vendor(mac) {
    const hex = normalizeMac(mac);
    if (!hex || PLACEHOLDERS.has(hex)) return null;
    const exact = find(hex);
    if (exact) return { name: exact, randomized: false, guess: false };

    const octet = parseInt(hex.slice(0, 2), 16);
    // Endereço de grupo (multicast/broadcast) não é de nenhum rádio; e sem o bit "local" o
    // prefixo simplesmente não está no cadastro.
    if (octet & 0x01 || !(octet & 0x02)) return null;

    // Roteadores criam os BSSIDs das redes extras (convidados, mesh, segunda faixa) ligando o
    // bit "local" do MAC de fábrica: desligando-o, o fabricante costuma reaparecer.
    const factory = find((octet & ~0x02).toString(16).padStart(2, '0') + hex.slice(2));
    if (factory) return { name: factory, randomized: false, guess: true };
    return { name: null, randomized: true, guess: false };
  }

  function label(mac) {
    const info = vendor(mac);
    if (!info) return 'Desconhecido';
    if (info.randomized) return 'MAC aleatório ou virtual';
    return info.guess ? `${info.name} (provável)` : info.name;
  }

  return {
    vendor,
    isRandomized: (mac) => vendor(mac)?.randomized === true,
    label,
    size: decoded ? decoded.size : 0,
    loaded: decoded !== null,
    source: decoded && typeof data.source === 'string' ? data.source : '',
    error: null,
  };
}

/**
 * O endereço parece inventado por software? Com a tabela (`lookup`), vale a regra completa:
 * bit "local" ligado e nenhum fabricante encontrado, nem desligando o bit. Sem a tabela, sobra
 * só o bit — e aí os BSSIDs virtuais de roteador também contam como aleatórios.
 * @param {unknown} mac
 * @param {OuiLookup} [lookup]
 * @returns {boolean}
 */
export function isRandomized(mac, lookup) {
  if (lookup && typeof lookup.isRandomized === 'function') return lookup.isRandomized(mac);
  const hex = normalizeMac(mac);
  if (!hex || PLACEHOLDERS.has(hex)) return false;
  return (parseInt(hex.slice(0, 2), 16) & 0x03) === 0x02;
}

const loading = new Map(); // url -> Promise<OuiLookup>

/**
 * Carrega a tabela (uma vez por URL; as chamadas seguintes recebem a mesma Promise). Nunca
 * rejeita: se o arquivo não vier, devolve uma consulta vazia (`loaded: false`, com o motivo em
 * `error`) e a próxima chamada tenta de novo.
 * @param {string} url  ex.: 'assets/oui.json' (relativo à página)
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<OuiLookup>}
 */
export function loadOui(url, fetchImpl = globalThis.fetch) {
  const cached = loading.get(url);
  if (cached) return cached;
  const promise = (async () => {
    let error;
    try {
      const response = await fetchImpl(url);
      if (response && response.ok === false) throw new Error(`HTTP ${response.status}`);
      const lookup = createOuiLookup(await response.json());
      if (lookup.loaded) return lookup;
      error = 'formato não reconhecido';
    } catch (err) {
      error = String((err && err.message) || err);
    }
    return { ...createOuiLookup(null), error: `não foi possível carregar ${url}: ${error}` };
  })();
  loading.set(url, promise);
  // Não guarda a falha: quem chamar de novo tenta outra vez.
  promise.then((lookup) => {
    if (!lookup.loaded && loading.get(url) === promise) loading.delete(url);
  });
  return promise;
}
