// Sinal: conversões de potência, qualidade, ruído térmico, estimativa de distância e os
// pequenos utilitários numéricos usados pelo resto do app.
//
// Tudo função pura; entrada inválida vira null (ou o valor neutro documentado), nunca exceção.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** Só os números finitos de uma lista (qualquer outra coisa é descartada). */
function finite(list) {
  if (list == null || typeof list[Symbol.iterator] !== 'function' || typeof list === 'string') return [];
  const out = [];
  for (const x of list) if (isNum(x)) out.push(x);
  return out;
}

// ---------------------------------------------------------------------------
// Utilitários numéricos
// ---------------------------------------------------------------------------

/** Limita x ao intervalo [lo, hi]. NaN vira `lo`. */
export function clamp(x, lo, hi) {
  if (!(x >= lo)) return lo;
  return x > hi ? hi : x;
}

/** Interpolação linear: t = 0 -> a, t = 1 -> b (t fora de 0..1 extrapola). */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Média dos valores finitos; null se não houver nenhum. */
export function mean(arr) {
  const v = finite(arr);
  if (!v.length) return null;
  let sum = 0;
  for (const x of v) sum += x;
  return sum / v.length;
}

/**
 * Percentil p (0..100) com interpolação linear entre os vizinhos (o mesmo método padrão do
 * NumPy/Excel). null se não houver valores.
 */
export function percentile(arr, p) {
  const v = finite(arr).sort((a, b) => a - b);
  if (!v.length || !isNum(p)) return null;
  const pos = (clamp(p, 0, 100) / 100) * (v.length - 1);
  const i = Math.floor(pos);
  const next = v[Math.min(i + 1, v.length - 1)];
  return v[i] + (next - v[i]) * (pos - i);
}

/** Mediana dos valores finitos; null se não houver nenhum. */
export function median(arr) {
  return percentile(arr, 50);
}

/**
 * Desvio padrão dos valores finitos. Populacional (divide por n) por padrão; com
 * `sample = true`, amostral (divide por n − 1). null se faltarem valores.
 */
export function stddev(arr, sample = false) {
  const v = finite(arr);
  const n = v.length;
  if (n === 0 || (sample && n < 2)) return null;
  const m = mean(v);
  let sq = 0;
  for (const x of v) sq += (x - m) * (x - m);
  return Math.sqrt(sq / (sample ? n - 1 : n));
}

/**
 * Média móvel exponencial. Devolve uma função: a cada valor novo, o valor suavizado.
 * `alpha` (0..1] é o peso do valor novo: 1 = sem suavizar. Valores inválidos são ignorados
 * (a função devolve o último valor suavizado, ou null se ainda não houver).
 * A função também tem `.value` (último resultado) e `.reset()`.
 * @param {number} [alpha=0.3]
 * @returns {((x:number) => number|null) & {value:number|null, reset:() => void}}
 */
export function createEma(alpha = 0.3) {
  const a = isNum(alpha) ? clamp(alpha, 0.001, 1) : 0.3;
  let value = null;
  const step = (x) => {
    if (isNum(x)) value = value === null ? x : value + a * (x - value);
    return value;
  };
  step.reset = () => {
    value = null;
  };
  Object.defineProperty(step, 'value', { get: () => value, enumerable: true });
  return step;
}

/**
 * Filtro de Kalman de uma dimensão (modelo "o valor fica onde está"), bom para alisar RSSI.
 * `q` = quanto o valor real pode mudar entre uma leitura e outra (variância, dB²);
 * `r` = ruído de cada leitura (variância, dB²). q/r maior = segue mais rápido e alisa menos.
 * O padrão (q = 1, r = 9) supõe leituras com ±3 dB de ruído; em regime, cada leitura nova
 * pesa ~28%. Leitura inválida só "envelhece" a estimativa (a próxima leitura pesa mais).
 * Devolve uma função como a de createEma, com `.value`, `.variance` e `.reset()`.
 * @param {{q?:number, r?:number}} [options]
 * @returns {((z:number) => number|null) & {value:number|null, variance:number|null, reset:() => void}}
 */
export function createKalman1D(options) {
  const o = options !== null && typeof options === 'object' ? options : {};
  const q = isNum(o.q) && o.q >= 0 ? o.q : 1;
  const r = isNum(o.r) && o.r > 0 ? o.r : 9;
  let x = null;
  let p = null;
  const step = (z) => {
    if (x === null) {
      if (isNum(z)) {
        x = z;
        p = r;
      }
      return x;
    }
    p += q;
    if (isNum(z)) {
      const k = p / (p + r);
      x += k * (z - x);
      p *= 1 - k;
    }
    return x;
  };
  step.reset = () => {
    x = null;
    p = null;
  };
  Object.defineProperty(step, 'value', { get: () => x, enumerable: true });
  Object.defineProperty(step, 'variance', { get: () => p, enumerable: true });
  return step;
}

// ---------------------------------------------------------------------------
// Potência
// ---------------------------------------------------------------------------

/** dBm -> miliwatts. null para entrada inválida. */
export function dbmToMw(dbm) {
  if (dbm === -Infinity) return 0;
  return isNum(dbm) ? Math.pow(10, dbm / 10) : null;
}

/** miliwatts -> dBm. 0 mW = -Infinity; negativo ou inválido = null. */
export function mwToDbm(mw) {
  if (!isNum(mw) || mw < 0) return null;
  return mw === 0 ? -Infinity : 10 * Math.log10(mw);
}

/**
 * Soma de potências em dBm (soma em miliwatts, não em dB): dois sinais de −60 dBm dão −57 dBm.
 * Valores inválidos são ignorados; lista vazia = -Infinity (potência nenhuma).
 * @param {number[]} list
 * @returns {number}
 */
export function sumDbm(list) {
  let mw = 0;
  for (const dbm of finite(list)) mw += Math.pow(10, dbm / 10);
  return mw === 0 ? -Infinity : 10 * Math.log10(mw);
}

/** Figura de ruído típica de um receptor Wi-Fi de celular/roteador doméstico (dB). */
export const NOISE_FIGURE_DB = 7;

/**
 * Piso de ruído de um receptor: ruído térmico (−174 dBm/Hz a ~17 °C) na largura do canal,
 * mais a figura de ruído. 20 MHz -> −94 dBm; cada vez que a largura dobra, +3 dB.
 * @param {number} [widthMHz=20]
 * @param {number} [noiseFigureDb=7]
 * @returns {number|null}
 */
export function noiseFloorDbm(widthMHz = 20, noiseFigureDb = NOISE_FIGURE_DB) {
  if (!isNum(widthMHz) || widthMHz <= 0) return null;
  const nf = isNum(noiseFigureDb) ? noiseFigureDb : NOISE_FIGURE_DB;
  return -174 + 10 * Math.log10(widthMHz * 1e6) + nf;
}

// ---------------------------------------------------------------------------
// Qualidade
// ---------------------------------------------------------------------------

/**
 * Qualidade do sinal em % (inteiro): −50 dBm ou melhor = 100, −100 dBm ou pior = 0, reta no meio.
 * Sinal desconhecido conta como 0.
 * @param {number} rssi dBm
 * @returns {number}
 */
export function qualityPct(rssi) {
  if (!isNum(rssi)) return 0;
  return Math.round(clamp(2 * (rssi + 100), 0, 100));
}

// Limites usuais de projeto de rede: −67 dBm é o mínimo recomendado para voz/vídeo ao vivo,
// −75 ainda navega bem, abaixo de −82 já é a sensibilidade mínima das taxas mais baixas.
const LEVELS = [
  { min: -50, key: 'excellent', label: 'Excelente', bars: 4, tone: 'good', hint: 'Sinal de sobra para qualquer uso' },
  { min: -60, key: 'great', label: 'Ótimo', bars: 4, tone: 'good', hint: 'Dá conta de vídeo em 4K, jogos e chamadas' },
  { min: -67, key: 'good', label: 'Bom', bars: 3, tone: 'good', hint: 'Bom para chamadas de vídeo e streaming' },
  { min: -75, key: 'fair', label: 'Regular', bars: 2, tone: 'ok', hint: 'Navega bem; vídeo pode perder qualidade' },
  { min: -82, key: 'weak', label: 'Fraco', bars: 1, tone: 'warn', hint: 'Lento e sujeito a travadas' },
  { min: -Infinity, key: 'very-weak', label: 'Muito fraco', bars: 0, tone: 'bad', hint: 'Conexão instável; pode cair' },
].map(Object.freeze);

const LEVEL_UNKNOWN = Object.freeze({
  key: 'unknown',
  label: 'Sem leitura',
  bars: 0,
  tone: 'bad',
  hint: 'O celular não informou o sinal',
});

/**
 * Classifica o sinal: >= −50 excelente; >= −60 ótimo; >= −67 bom; >= −75 regular;
 * >= −82 fraco; abaixo disso, muito fraco.
 * @param {number} rssi dBm
 * @returns {{key:'excellent'|'great'|'good'|'fair'|'weak'|'very-weak'|'unknown', label:string,
 *            bars:0|1|2|3|4, tone:'good'|'ok'|'warn'|'bad', hint:string}}
 */
export function signalLevel(rssi) {
  if (!isNum(rssi)) return { ...LEVEL_UNKNOWN };
  const level = LEVELS.find((l) => rssi >= l.min);
  return { key: level.key, label: level.label, bars: level.bars, tone: level.tone, hint: level.hint };
}

// ---------------------------------------------------------------------------
// Distância a partir do sinal
// ---------------------------------------------------------------------------

/** Expoente de perda padrão dentro de casa (2 = espaço livre; paredes puxam para 3 a 4). */
export const DEFAULT_PATH_LOSS_EXPONENT = 3.0;

export const MIN_DISTANCE_M = 0.3;
export const MAX_DISTANCE_M = 200;

/**
 * Sinal típico a 1 m de um roteador doméstico, como os celulares de fato medem:
 * −40 dBm em 2437 MHz, caindo 20·log10(f) com a frequência (≈ −47 dBm em 5,5 GHz).
 * Frequência desconhecida usa a referência de 2,4 GHz.
 * @param {number} freqMHz
 * @returns {number} dBm
 */
export function referenceRssiAt1m(freqMHz) {
  const f = isNum(freqMHz) && freqMHz > 0 ? freqMHz : 2437;
  return -40 - 20 * Math.log10(f / 2437);
}

function pathModel(freqMHz, options) {
  const o = options !== null && typeof options === 'object' ? options : {};
  return {
    p0: isNum(o.p0) ? o.p0 : referenceRssiAt1m(freqMHz),
    n: isNum(o.n) && o.n > 0 ? o.n : DEFAULT_PATH_LOSS_EXPONENT,
  };
}

/**
 * Sinal esperado a `distM` metros pelo modelo log-distância: rssi = p0 − 10·n·log10(d).
 * `p0` = dBm a 1 m (padrão: referenceRssiAt1m), `n` = expoente de perda (padrão 3,0).
 * Distâncias abaixo de 0,3 m são tratadas como 0,3 m (o modelo não vale colado na antena).
 * @param {number} distM
 * @param {number} freqMHz
 * @param {{p0?:number, n?:number}} [options]
 * @returns {number|null} dBm
 */
export function expectedRssi(distM, freqMHz, options) {
  if (!isNum(distM)) return null;
  const { p0, n } = pathModel(freqMHz, options);
  return p0 - 10 * n * Math.log10(Math.max(distM, MIN_DISTANCE_M));
}

/**
 * Distância estimada (m) dentro de casa: o inverso de expectedRssi, limitado a 0,3..200 m.
 * É uma ordem de grandeza: uma parede a mais muda bastante o resultado.
 * @param {number} rssi dBm
 * @param {number} freqMHz
 * @param {{p0?:number, n?:number}} [options]
 * @returns {number|null}
 */
export function indoorDistance(rssi, freqMHz, options) {
  if (!isNum(rssi)) return null;
  const { p0, n } = pathModel(freqMHz, options);
  return clamp(Math.pow(10, (p0 - rssi) / (10 * n)), MIN_DISTANCE_M, MAX_DISTANCE_M);
}

/**
 * Distância em espaço livre (m), a fórmula que os apps de análise de Wi-Fi costumam mostrar:
 * d = 10^((27,55 − 20·log10(f) + |rssi|) / 20). Trata |rssi| como a perda de um caminho livre,
 * sem paredes; dentro de casa costuma exagerar a distância. Prefira indoorDistance.
 * @param {number} rssi dBm
 * @param {number} freqMHz
 * @returns {number|null}
 */
export function freeSpaceDistance(rssi, freqMHz) {
  if (!isNum(rssi) || !isNum(freqMHz) || freqMHz <= 0) return null;
  return Math.pow(10, (27.55 - 20 * Math.log10(freqMHz) + Math.abs(rssi)) / 20);
}
