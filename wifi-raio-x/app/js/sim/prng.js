// Números pseudoaleatórios com semente.
//
// O simulador não pode usar Math.random nem Date.now: a mesma semente precisa
// gerar sempre o mesmo mundo, a mesma caminhada e as mesmas leituras (testes e
// bancada de avaliação reproduzíveis, modo demonstração estável).

const UINT = 4294967296; // 2^32

/**
 * Mistura qualquer quantidade de números/textos numa semente de 32 bits.
 * Sementes vizinhas (1, 2, 3...) saem bem diferentes uma da outra.
 * @param {...(number|string)} parts
 * @returns {number} inteiro sem sinal de 32 bits
 */
export function hashSeed(...parts) {
  let h = 0x811c9dc5;
  for (const part of parts) {
    if (typeof part === 'number') {
      // Parte inteira e fração entram separadas: 0.5 e 1.5 não podem colidir.
      const int = Math.floor(part);
      h = mix(h ^ (int | 0));
      h = mix(h ^ (Math.floor(int / UINT) | 0));
      const frac = part - int;
      if (frac !== 0) h = mix(h ^ Math.floor(frac * UINT));
    } else {
      const s = String(part);
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      h = mix(h ^ s.length);
    }
  }
  return mix(h) >>> 0;
}

// Finalizador do MurmurHash3: espalha bem os bits.
function mix(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}

/**
 * Gerador mulberry32: pequeno, rápido e bom o bastante para simulação.
 * @param {number} seed
 * @returns {() => number} função que devolve um número em [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / UINT;
  };
}

/**
 * Gerador com as ajudas usadas pelo simulador.
 * @param {...(number|string)} seedParts  qualquer combinação de números e textos
 */
export function createRng(...seedParts) {
  const seed = hashSeed(...seedParts);
  const next = mulberry32(seed);
  let spare = null; // segunda amostra do Box-Muller

  const rng = {
    seed,
    /** número em [0, 1) */
    next,
    /** número em [min, max) */
    float(min = 0, max = 1) {
      return min + (max - min) * next();
    },
    /** inteiro em [min, max] (os dois inclusive) */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** true com probabilidade p */
    chance(p) {
      return next() < p;
    },
    /** amostra de uma distribuição normal */
    gaussian(mean = 0, sd = 1) {
      if (spare !== null) {
        const z = spare;
        spare = null;
        return mean + sd * z;
      }
      let u = next();
      if (u < 1e-12) u = 1e-12; // log(0) não existe
      const r = Math.sqrt(-2 * Math.log(u));
      const a = 2 * Math.PI * next();
      spare = r * Math.sin(a);
      return mean + sd * r * Math.cos(a);
    },
    /** um elemento da lista */
    pick(list) {
      return list[Math.floor(next() * list.length)];
    },
    /** um elemento sorteado conforme os pesos (mesmo tamanho da lista) */
    weighted(list, weights) {
      let total = 0;
      for (const w of weights) total += w;
      let r = next() * total;
      for (let i = 0; i < list.length; i++) {
        r -= weights[i];
        if (r < 0) return list[i];
      }
      return list[list.length - 1];
    },
    /** cópia embaralhada (Fisher-Yates); não altera a lista original */
    shuffle(list) {
      const out = list.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
    /** texto hexadecimal maiúsculo com `n` dígitos */
    hex(n) {
      let s = '';
      for (let i = 0; i < n; i++) s += '0123456789ABCDEF'[Math.floor(next() * 16)];
      return s;
    },
    /** gerador independente derivado deste (não consome a sequência atual) */
    fork(...labels) {
      return createRng(seed, ...labels);
    },
  };
  return rng;
}

/**
 * Ruído sem estado: o mesmo conjunto de chaves devolve sempre o mesmo valor,
 * não importa a ordem das chamadas. É o que deixa uma leitura (rádio, instante)
 * repetível mesmo quando outras leituras são pedidas no meio do caminho.
 * @returns {number} número em [0, 1)
 */
export function hashUniform(...keys) {
  return hashSeed(...keys) / UINT;
}

/** Normal padrão sem estado (Box-Muller sobre dois hashes). */
export function hashGaussian(...keys) {
  const h = hashSeed(...keys);
  const u = Math.max(h / UINT, 1e-12);
  const v = mix(h ^ 0x9e3779b9) >>> 0;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos((2 * Math.PI * v) / UINT);
}
