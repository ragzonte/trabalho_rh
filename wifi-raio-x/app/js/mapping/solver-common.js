// Mapa só com Wi-Fi — peças comuns aos motores do solucionador (solver.js).
//
// Aqui fica tudo o que os quatro motores (solver-isomap.js, solver-fields.js, solver-chain.js e
// solver-range.js) precisam do mesmo jeito:
//   - a LEITURA do levantamento: saneia os dados uma vez só, junta os BSSIDs do mesmo rádio
//     (aparelho + faixa) e separa as leituras frescas das que o Android repete de varreduras
//     anteriores;
//   - álgebra pequena e determinística (L-BFGS, MDS clássico, caminhos mais curtos, Cholesky);
//   - alinhamento de dois mapas (rotação + espelho + translação), usado para juntar as soluções.
//
// Nada aqui sorteia nem olha o relógio de parede: performance.now() serve só para respeitar o
// tempo combinado.

import { FLOOR_HEIGHT } from './types.js';

export { FLOOR_HEIGHT };

/** Altura típica do celular na mão (m acima do piso). */
export const PHONE_HEIGHT = 1.2;
/** Intervalo assumido entre varreduras quando o relógio falta (s): o do modo sem limite do Android. */
const DEFAULT_GAP_S = 3.5;
/**
 * Uma varredura completa leva menos que isto (ms): leitura mais velha nunca é da varredura atual.
 * Vale 4,5 s para o celular típico (2,5 a 3 s para varrer 2,4 e 5 GHz); para os mais lentos (três
 * faixas, canais com radar) o teto sobe com a idade das leituras do próprio levantamento, até
 * MAX_SWEEP_LIMIT_MS — ver sweepLimit().
 */
const MAX_SWEEP_MS = 4500;
const MAX_SWEEP_LIMIT_MS = 10000;
/** A posição de uma varredura feita andando vale para o meio dela: ~1,35 s antes da entrega da lista. */
export const SWEEP_MID_S = 1.35;

export const now = () => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : 0);
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Número finito, ou zero (nada que não seja finito sai do solucionador). */
export const finite = (v) => (Number.isFinite(v) ? v : 0);

export function median(values) {
  if (!values.length) return NaN;
  const v = Array.from(values).sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
}

/** Andar marcado numa varredura, como número inteiro (0 quando falta ou não é número). */
export function floorOf(scan) {
  const f = Math.round(Number(scan && scan.floor));
  return Number.isFinite(f) ? clamp(f, -20, 200) : 0;
}

/** Faixa de um canal: 0 = 2,4 GHz, 1 = 5 GHz, 2 = 6 GHz. */
function bandOf(freq) {
  if (!(freq > 0) || freq < 3000) return 0;
  return freq < 5925 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Leitura do levantamento
// ---------------------------------------------------------------------------

/**
 * Visão saneada de um levantamento, comum a todos os motores.
 *
 * @typedef {Object} SurveyView
 * @property {number} n                 varreduras
 * @property {Float64Array} time        segundos, nunca decrescente
 * @property {Int32Array} floor         andar marcado
 * @property {(string|null)[]} spot     chave do ponto marcado (o usuário estava parado ali), ou null (andando)
 * @property {{device:string, band:number, freq:number, ids:string[]}[]} radios
 *           rádio = aparelho + faixa: os BSSIDs de um mesmo rádio (rede principal, convidados) medem o mesmo sinal
 * @property {number} K                 rádios
 * @property {Float64Array} rssi        n x K: média das leituras FRESCAS do rádio na varredura (NaN = não ouvido)
 * @property {Float64Array} count       n x K: quantas leituras frescas entraram na média
 * @property {Int32Array} fresh         leituras frescas de cada varredura
 * @property {Float64Array} meanAgeS    idade média das leituras frescas de cada varredura (s)
 * @property {number} weakest           leitura fresca mais fraca do levantamento (dBm; NaN sem leituras)
 * @property {number} lowLevel          percentil 3 das leituras frescas: perto do limiar de detecção deste celular
 * @property {{t:number, k:number, rssi:number, id:string}[]} track   sinal da rede conectada, em ordem de tempo
 */

/**
 * Saneia o levantamento. Nunca lança erro: o que não der para aproveitar é ignorado.
 *
 * Leitura fresca x repetida: o Android devolve, junto com o que acabou de ouvir, redes guardadas de
 * varreduras anteriores. Uma leitura cuja idade passa do intervalo desde a varredura anterior foi
 * ouvida ANTES dela: descreve um lugar anterior e já foi contada lá. Só as frescas entram.
 *
 * @param {import('./types.js').Survey} survey
 * @returns {SurveyView}
 */
export function readSurvey(survey) {
  const raw = survey && Array.isArray(survey.scans) ? survey.scans : [];
  const n = raw.length;
  const meta = survey && survey.aps && typeof survey.aps === 'object' ? survey.aps : {};
  const time = new Float64Array(n);
  const floor = new Int32Array(n);
  const spot = new Array(n).fill(null);
  const radios = [];
  const radioIndex = new Map();
  const radioOf = new Map();
  const radioFor = (id, freqHint) => {
    let k = radioOf.get(id);
    if (k !== undefined) return k;
    const info = meta[id] && typeof meta[id] === 'object' ? meta[id] : {};
    const freq = Number(info.freq) > 0 ? Number(info.freq) : freqHint > 0 ? freqHint : 2437;
    const device = info.device != null ? `d:${info.device}` : `b:${id}`;
    const key = `${device}|${bandOf(freq)}`;
    k = radioIndex.get(key);
    if (k === undefined) {
      k = radios.length;
      radioIndex.set(key, k);
      radios.push({ device, band: bandOf(freq), freq, ids: [] });
    }
    radios[k].ids.push(id);
    radioOf.set(id, k);
    return k;
  };

  // Primeira passada: tempo, andar, ponto e o cadastro dos rádios (na ordem em que aparecem).
  const lists = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = raw[i] && typeof raw[i] === 'object' ? raw[i] : {};
    const t = Number.isFinite(s.t) ? s.t : i > 0 ? time[i - 1] + DEFAULT_GAP_S : 0;
    time[i] = i > 0 ? Math.max(t, time[i - 1]) : t; // a ordem é a do vetor; o relógio não volta
    floor[i] = floorOf(s);
    spot[i] = s.spot == null ? null : String(s.spot);
    const list = [];
    for (const r of Array.isArray(s.readings) ? s.readings : []) {
      if (!r || r.id == null || !Number.isFinite(r.rssi) || r.rssi > 20 || r.rssi < -150) continue;
      list.push({ k: radioFor(String(r.id), Number(r.freq)), rssi: r.rssi, ageMs: Number.isFinite(r.ageMs) ? r.ageMs : 0 });
    }
    lists[i] = list;
  }
  const K = radios.length;

  // Segunda passada: média das leituras frescas por (varredura, rádio).
  const sweepMs = sweepLimit(lists, time);
  let rssi;
  let count;
  let fresh;
  let meanAgeS;
  let levels;
  const sum = new Float64Array(K);
  for (const useAges of [true, false]) {
    rssi = new Float64Array(n * K).fill(NaN);
    count = new Float64Array(n * K);
    fresh = new Int32Array(n);
    meanAgeS = new Float64Array(n).fill(SWEEP_MID_S);
    levels = [];
    let heard = 0; // varreduras com alguma leitura
    let heardFresh = 0; // ...e com alguma leitura fresca
    for (let i = 0; i < n; i++) {
      const gapMs = i > 0 ? (time[i] - time[i - 1]) * 1000 : Infinity;
      const freshMs = gapMs > 200 ? Math.min(sweepMs, gapMs - 1) : sweepMs;
      sum.fill(0);
      let ageSum = 0;
      for (const r of lists[i]) {
        if (useAges && r.ageMs > freshMs) continue;
        sum[r.k] += r.rssi;
        count[i * K + r.k]++;
        fresh[i]++;
        ageSum += r.ageMs / 1000;
        levels.push(r.rssi);
      }
      for (let k = 0; k < K; k++) if (count[i * K + k] > 0) rssi[i * K + k] = sum[k] / count[i * K + k];
      if (fresh[i] > 0 && useAges) meanAgeS[i] = ageSum / fresh[i];
      if (lists[i].length) heard++;
      if (fresh[i] > 0) heardFresh++;
    }
    // Quase nenhuma varredura com leitura fresca: o campo de idade deste aparelho não presta (outra
    // unidade, relógio errado). Melhor um mapa com as leituras todas do que mapa nenhum: refaz sem
    // olhar a idade.
    if (heard < 5 || heardFresh >= 0.2 * heard) break;
  }
  levels.sort((a, b) => a - b);
  const weakest = levels.length ? levels[0] : NaN;
  const lowLevel = levels.length ? levels[Math.floor(levels.length * 0.03)] : NaN;

  const track = [];
  for (const q of survey && Array.isArray(survey.track) ? survey.track : []) {
    if (!q || q.id == null || !Number.isFinite(q.t) || !Number.isFinite(q.rssi)) continue;
    const id = String(q.id);
    track.push({ t: q.t, k: radioOf.has(id) ? radioOf.get(id) : -1, rssi: q.rssi, id });
  }
  track.sort((p, q) => p.t - q.t);

  return { n, time, floor, spot, radios, K, rssi, count, fresh, meanAgeS, weakest, lowLevel, track };
}

/**
 * Idade (ms) acima da qual uma leitura não pode ser da varredura que a trouxe, para ESTE celular.
 * Uma constante só (4,5 s) serve ao celular que varre tudo em 3 s, mas num aparelho que leva 6 s
 * ela jogava fora, como "repetidas", as leituras do começo de cada varredura — quase todo o
 * 2,4 GHz no modo de uma varredura a cada 30 s — e o mapa desabava (medido: nota de 49 para 80).
 * As idades do próprio levantamento dizem quanto dura a varredura: entre as leituras que não são
 * comprovadamente antigas (mais novas que o intervalo desde a varredura anterior), 70% ficam
 * abaixo de ~85% da duração. O teto é 1,5 vez esse percentil, nunca menos que MAX_SWEEP_MS.
 */
function sweepLimit(lists, time) {
  const ages = [];
  for (let i = 0; i < lists.length; i++) {
    const gapMs = i > 0 ? (time[i] - time[i - 1]) * 1000 : Infinity;
    const newest = gapMs > 200 ? Math.min(2 * MAX_SWEEP_LIMIT_MS, gapMs - 1) : 2 * MAX_SWEEP_LIMIT_MS;
    for (const r of lists[i]) if (r.ageMs >= 0 && r.ageMs <= newest) ages.push(r.ageMs);
  }
  if (ages.length < 20) return MAX_SWEEP_MS;
  ages.sort((a, b) => a - b);
  return clamp(1.5 * ages[Math.floor(0.7 * (ages.length - 1))], MAX_SWEEP_MS, MAX_SWEEP_LIMIT_MS);
}

/** Visão com só as varreduras de `keep` (índices crescentes). Os rádios e o sinal conectado são os mesmos. */
export function pickScans(view, keep) {
  const { K } = view;
  const n = keep.length;
  const out = {
    ...view,
    n,
    time: new Float64Array(n),
    floor: new Int32Array(n),
    spot: new Array(n),
    rssi: new Float64Array(n * K),
    count: new Float64Array(n * K),
    fresh: new Int32Array(n),
    meanAgeS: new Float64Array(n),
  };
  keep.forEach((i, q) => {
    out.time[q] = view.time[i];
    out.floor[q] = view.floor[i];
    out.spot[q] = view.spot[i];
    out.fresh[q] = view.fresh[i];
    out.meanAgeS[q] = view.meanAgeS[i];
    out.rssi.set(view.rssi.subarray(i * K, (i + 1) * K), q * K);
    out.count.set(view.count.subarray(i * K, (i + 1) * K), q * K);
  });
  return out;
}

/**
 * Visitas: varreduras seguidas no mesmo ponto marcado formam uma só; cada varredura andando é uma.
 * @returns {{members:number[], spot:(string|null), floor:number}[]}
 */
export function visitsOf(view) {
  const visits = [];
  for (let i = 0; i < view.n; i++) {
    const last = visits[visits.length - 1];
    if (view.spot[i] !== null && last && last.spot === view.spot[i] && last.floor === view.floor[i]) last.members.push(i);
    else visits.push({ members: [i], spot: view.spot[i], floor: view.floor[i] });
  }
  return visits;
}

/**
 * Lugares: um por ponto marcado (todas as visitas a ele juntas: quem volta a um ponto está no
 * mesmo lugar) e um por varredura andando.
 * @returns {{nodeOf: Int32Array, nodes: {scans:number[], spot:(string|null), floor:number}[]}}
 */
export function placesOf(view) {
  const nodeOf = new Int32Array(view.n);
  const nodes = [];
  const spotNode = new Map();
  for (let i = 0; i < view.n; i++) {
    const spot = view.spot[i];
    let a;
    if (spot !== null && spotNode.has(spot)) a = spotNode.get(spot);
    else {
      a = nodes.length;
      nodes.push({ scans: [], spot, floor: view.floor[i] });
      if (spot !== null) spotNode.set(spot, a);
    }
    nodes[a].scans.push(i);
    nodeOf[i] = a;
  }
  return { nodeOf, nodes };
}

/** Lista ordenada dos andares e o índice do andar de cada item de `floors`. */
export function indexFloors(floors) {
  const list = [...new Set(floors)].sort((a, b) => a - b);
  const at = new Map(list.map((f, i) => [f, i]));
  return { list, index: Int32Array.from(floors, (f) => at.get(f)) };
}

// ---------------------------------------------------------------------------
// Otimização e álgebra
// ---------------------------------------------------------------------------

/**
 * L-BFGS com busca linear por recuo (Armijo). `fg(x, grad)` devolve o custo e preenche o gradiente.
 * Trabalha em cima de `x` e devolve o custo final. As variáveis já devem chegar em escala parecida.
 * `firstStep(normaDoGradiente, n)` dá o tamanho do primeiro passo ao longo de -gradiente (enquanto
 * não há curvatura acumulada).
 */
export function lbfgs(fg, x, opts = {}) {
  const n = x.length;
  const memory = opts.memory || 8;
  const maxIter = opts.maxIter || 200;
  const firstStep = opts.firstStep || ((norm) => Math.min(1, 0.5 / norm));
  const g = new Float64Array(n);
  const gNew = new Float64Array(n);
  const xNew = new Float64Array(n);
  const dir = new Float64Array(n);
  const S = [];
  const Y = [];
  const rho = [];
  const alpha = new Float64Array(memory);
  let f = fg(x, g);
  for (let iter = 0; iter < maxIter; iter++) {
    if (opts.deadline && now() > opts.deadline) break;
    // Direção: -H·g pela recursão de dois laços.
    for (let i = 0; i < n; i++) dir[i] = -g[i];
    const k = S.length;
    for (let j = k - 1; j >= 0; j--) {
      let a = 0;
      const s = S[j];
      for (let i = 0; i < n; i++) a += s[i] * dir[i];
      a *= rho[j];
      alpha[j] = a;
      const y = Y[j];
      for (let i = 0; i < n; i++) dir[i] -= a * y[i];
    }
    if (k > 0) {
      const s = S[k - 1];
      const y = Y[k - 1];
      let sy = 0;
      let yy = 0;
      for (let i = 0; i < n; i++) {
        sy += s[i] * y[i];
        yy += y[i] * y[i];
      }
      const gamma = sy / (yy || 1);
      for (let i = 0; i < n; i++) dir[i] *= gamma;
    }
    for (let j = 0; j < k; j++) {
      let b = 0;
      const y = Y[j];
      for (let i = 0; i < n; i++) b += y[i] * dir[i];
      b *= rho[j];
      const s = S[j];
      const c = alpha[j] - b;
      for (let i = 0; i < n; i++) dir[i] += c * s[i];
    }
    let slope = 0;
    for (let i = 0; i < n; i++) slope += dir[i] * g[i];
    if (!(slope < 0)) {
      // Direção ruim (curvatura estragada): esquece a memória e recomeça do gradiente.
      S.length = Y.length = rho.length = 0;
      slope = 0;
      for (let i = 0; i < n; i++) {
        dir[i] = -g[i];
        slope -= g[i] * g[i];
      }
      if (!(slope < -1e-20)) break;
    }
    let step = 1;
    if (S.length === 0) {
      let gn = 0;
      for (let i = 0; i < n; i++) gn += g[i] * g[i];
      step = firstStep(Math.sqrt(gn), n);
    }
    let fNew = f;
    let ok = false;
    for (let ls = 0; ls < 20; ls++) {
      for (let i = 0; i < n; i++) xNew[i] = x[i] + step * dir[i];
      fNew = fg(xNew, gNew);
      if (Number.isFinite(fNew) && fNew <= f + 1e-4 * step * slope) {
        ok = true;
        break;
      }
      step *= 0.5;
    }
    if (!ok) break;
    const s = new Float64Array(n);
    const y = new Float64Array(n);
    let sy = 0;
    for (let i = 0; i < n; i++) {
      s[i] = xNew[i] - x[i];
      y[i] = gNew[i] - g[i];
      sy += s[i] * y[i];
    }
    const decrease = f - fNew;
    x.set(xNew);
    g.set(gNew);
    f = fNew;
    if (sy > 1e-12) {
      if (S.length === memory) {
        S.shift();
        Y.shift();
        rho.shift();
      }
      S.push(s);
      Y.push(y);
      rho.push(1 / sy);
    }
    if (decrease < 1e-7 * (1 + Math.abs(f))) break;
  }
  return f;
}

/**
 * Os dois maiores autovetores de uma matriz simétrica n x n (iteração de subespaço com partida
 * fixa, para o resultado se repetir). Devolve os vetores unitários e os autovalores.
 */
export function topEigen2(B, n, iters = 120) {
  let q1 = Float64Array.from({ length: n }, (_, i) => Math.sin(1.7 * i + 0.3));
  let q2 = Float64Array.from({ length: n }, (_, i) => Math.cos(2.9 * i + 1.1));
  const mul = (v) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      const row = i * n;
      for (let j = 0; j < n; j++) s += B[row + j] * v[j];
      out[i] = s;
    }
    return out;
  };
  const dot = (a, b) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  };
  const unit = (v) => {
    const len = Math.sqrt(dot(v, v)) || 1;
    for (let i = 0; i < n; i++) v[i] /= len;
  };
  for (let it = 0; it < iters; it++) {
    q1 = mul(q1);
    unit(q1);
    q2 = mul(q2);
    const p = dot(q1, q2);
    for (let i = 0; i < n; i++) q2[i] -= p * q1[i];
    unit(q2);
  }
  return { q1, q2, l1: dot(q1, mul(q1)), l2: dot(q2, mul(q2)) };
}

/**
 * MDS clássico em 2D: D2 = distâncias ao quadrado (n x n). Devolve [x0, y0, x1, y1, ...].
 */
export function classicalMds(D2, n) {
  const out = new Float64Array(2 * n);
  if (n < 3) {
    if (n === 2) {
      const d = Math.sqrt(Math.max(0, D2[1]));
      out[0] = -d / 2;
      out[2] = d / 2;
    }
    return out;
  }
  const rowMean = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += D2[i * n + j];
    rowMean[i] = s / n;
    total += s;
  }
  total /= n * n;
  const B = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) B[i * n + j] = -0.5 * (D2[i * n + j] - rowMean[i] - rowMean[j] + total);
  }
  const { q1, q2, l1, l2 } = topEigen2(B, n);
  const s1 = Math.sqrt(Math.max(0, l1));
  const s2 = Math.sqrt(Math.max(0, l2));
  for (let i = 0; i < n; i++) {
    out[2 * i] = q1[i] * s1;
    out[2 * i + 1] = q2[i] * s2;
  }
  return out;
}

/** Caminhos mais curtos entre todos os pares (Floyd–Warshall), em cima de G (n x n, Infinity = sem aresta). */
export function shortestPaths(G, n) {
  for (let k = 0; k < n; k++) {
    const rowK = k * n;
    for (let i = 0; i < n; i++) {
      const gik = G[i * n + k];
      if (gik === Infinity) continue;
      const rowI = i * n;
      for (let j = 0; j < n; j++) {
        const v = gik + G[rowK + j];
        if (v < G[rowI + j]) G[rowI + j] = v;
      }
    }
  }
}

/** Fator de Cholesky (triangular inferior) de uma matriz simétrica positiva m x m; null se não for. */
export function cholesky(A, m) {
  const L = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * m + j];
      for (let k = 0; k < j; k++) s -= L[i * m + k] * L[j * m + k];
      if (i === j) {
        if (!(s > 1e-12)) return null;
        L[i * m + i] = Math.sqrt(s);
      } else L[i * m + j] = s / L[j * m + j];
    }
  }
  return L;
}

export function choleskySolve(L, b, m) {
  const x = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * m + k] * x[k];
    x[i] = s / L[i * m + i];
  }
  for (let i = m - 1; i >= 0; i--) {
    let s = x[i];
    for (let k = i + 1; k < m; k++) s -= L[k * m + i] * x[k];
    x[i] = s / L[i * m + i];
  }
  return x;
}

// ---------------------------------------------------------------------------
// Geometria de nuvens de pontos (vetores x[], y[])
// ---------------------------------------------------------------------------

/** Centro e raio quadrático médio dos `n` primeiros pontos de um vetor intercalado [x0, y0, x1, y1, ...]. */
export function flatCloudStats(X, n) {
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += X[2 * i];
    cy += X[2 * i + 1];
  }
  cx /= n || 1;
  cy /= n || 1;
  let r2 = 0;
  for (let i = 0; i < n; i++) r2 += (X[2 * i] - cx) * (X[2 * i] - cx) + (X[2 * i + 1] - cy) * (X[2 * i + 1] - cy);
  return { cx, cy, radius: Math.sqrt(r2 / (n || 1)) };
}

/** Centro e raio quadrático médio de uma nuvem dada por dois vetores. */
export function cloudStats(x, y) {
  const n = x.length;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += x[i];
    cy += y[i];
  }
  cx /= n || 1;
  cy /= n || 1;
  let r2 = 0;
  for (let i = 0; i < n; i++) r2 += (x[i] - cx) * (x[i] - cx) + (y[i] - cy) * (y[i] - cy);
  return { cx, cy, radius: Math.sqrt(r2 / (n || 1)) };
}

/**
 * Melhor movimento rígido no plano (rotação + translação, com espelho se `mirror` não for false)
 * que leva os pontos (ax, ay) sobre (bx, by), por mínimos quadrados. Forma fechada: com as duas
 * nuvens centradas, o ângulo é o argumento de Σ conj(a)·b; o espelho é testado refletindo `a`.
 * `only` restringe o ajuste a um subconjunto de índices.
 * @returns {{apply:(x:number, y:number)=>number[], mirrored:boolean, rms:number}}
 */
export function fitRigid(ax, ay, bx, by, opts = {}) {
  const idx = opts.only;
  const n = idx ? idx.length : Math.min(ax.length, bx.length);
  const at = idx ? (q) => idx[q] : (q) => q;
  let pax = 0;
  let pay = 0;
  let pbx = 0;
  let pby = 0;
  for (let q = 0; q < n; q++) {
    const i = at(q);
    pax += ax[i];
    pay += ay[i];
    pbx += bx[i];
    pby += by[i];
  }
  if (n > 0) {
    pax /= n;
    pay /= n;
    pbx /= n;
    pby /= n;
  }
  let a = 0;
  let b = 0;
  let am = 0;
  let bm = 0;
  let aa = 0;
  let bb = 0;
  for (let q = 0; q < n; q++) {
    const i = at(q);
    const px = ax[i] - pax;
    const py = ay[i] - pay;
    const qx = bx[i] - pbx;
    const qy = by[i] - pby;
    a += px * qx + py * qy;
    b += px * qy - py * qx;
    am += px * qx - py * qy;
    bm += px * qy + py * qx;
    aa += px * px + py * py;
    bb += qx * qx + qy * qy;
  }
  const plain = Math.hypot(a, b);
  const flipped = Math.hypot(am, bm);
  const mirrored = opts.mirror !== false && flipped > plain + 1e-12;
  const gain = mirrored ? flipped : plain;
  const ang = gain > 1e-12 ? (mirrored ? Math.atan2(bm, am) : Math.atan2(b, a)) : 0;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const m = mirrored ? -1 : 1;
  const apply = (x, y) => {
    const dx = x - pax;
    const dy = (y - pay) * m;
    return [pbx + c * dx - s * dy, pby + s * dx + c * dy];
  };
  return { apply, mirrored, rms: Math.sqrt(Math.max(0, aa + bb - 2 * gain) / Math.max(1, n)) };
}

/**
 * Varreduras do mesmo ponto marcado dividem UMA posição (a média das que cada uma recebeu), mesmo
 * em visitas diferentes: é o contrato da saída. Mexe em x e y.
 */
export function shareSpots(view, x, y) {
  const bySpot = new Map();
  for (let i = 0; i < view.n; i++) {
    if (view.spot[i] === null) continue;
    let e = bySpot.get(view.spot[i]);
    if (!e) bySpot.set(view.spot[i], (e = { x: 0, y: 0, list: [] }));
    e.x += x[i];
    e.y += y[i];
    e.list.push(i);
  }
  for (const e of bySpot.values()) {
    if (e.list.length < 2) continue;
    for (const i of e.list) {
      x[i] = e.x / e.list.length;
      y[i] = e.y / e.list.length;
    }
  }
}
