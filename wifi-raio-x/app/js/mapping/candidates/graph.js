// Mapa só com Wi-Fi — candidato "graph".
//
// v1: cadeia de poses (nós = visitas) + campo PLANO por rádio, ajustados juntos por EM
// (sistema dinâmico linear: o E é um suavizador na cadeia, o M é uma regressão por rádio).

import { FLOOR_HEIGHT } from '../types.js';

const STALE_MS = 3200; // leitura mais velha que isto é repetição do Android (as frescas vão até ~2,9 s)
const WALK_RMS = 0.52; // m/s: deslocamento líquido (corda) de quem anda dentro de casa a 0,4-0,9 m/s com curvas e paradas
const SWEEP_S = 2.6; // duração típica de uma varredura
const MID_S = 1.35; // a posição de uma varredura é a do meio da varredura: ~1,35 s antes da entrega

export function solve(survey, options = {}) {
  try {
    return solveInner(survey || {}, options || {});
  } catch (err) {
    return fallback(survey, String((err && err.stack) || err));
  }
}

function fallback(survey, why) {
  const scans = (survey && Array.isArray(survey.scans) && survey.scans) || [];
  return {
    points: scans.map((s) => ({ x: 0, y: 0, z: ((s && s.floor) || 0) * FLOOR_HEIGHT, conf: 0 })),
    aps: {},
    scaleConf: 0,
    debug: { error: why },
  };
}

// ---------------------------------------------------------------------------
// Preparação
// ---------------------------------------------------------------------------

function prepare(survey) {
  const scans = Array.isArray(survey.scans) ? survey.scans : [];
  const n = scans.length;
  const meta = survey.aps || {};
  // Rádio = (aparelho, faixa): os BSSIDs de um mesmo rádio medem quase a mesma coisa.
  const radioOf = new Map();
  const radios = [];
  const radioIdx = (id, freq) => {
    let k = radioOf.get(id);
    if (k !== undefined) return k;
    const m = meta[id] || {};
    const f = m.freq || freq || 2437;
    const band = f < 3000 ? 0 : f < 5925 ? 1 : 2;
    const key = `${m.device || id}|${band}`;
    k = radios.findIndex((r) => r.key === key);
    if (k < 0) {
      k = radios.length;
      radios.push({ key, device: m.device || id, band, bssids: [] });
    }
    radios[k].bssids.push(id);
    radioOf.set(id, k);
    return k;
  };
  for (const s of scans) for (const r of (s && s.readings) || []) if (r && typeof r.id === 'string' && Number.isFinite(r.rssi)) radioIdx(r.id, r.freq);
  const K = radios.length;

  // Impressão digital de cada varredura: média das leituras frescas de cada rádio (NaN = não ouviu).
  const fp = new Array(n);
  const fpAge = new Array(n); // idade média (s) das leituras de cada rádio dentro da varredura
  const all = [];
  for (let i = 0; i < n; i++) {
    const sum = new Float64Array(K);
    const cnt = new Float64Array(K);
    const age = new Float64Array(K);
    for (const r of (scans[i] && scans[i].readings) || []) {
      if (!r || typeof r.id !== 'string' || !Number.isFinite(r.rssi)) continue;
      if ((r.ageMs || 0) > STALE_MS) continue;
      const k = radioOf.get(r.id);
      sum[k] += r.rssi;
      age[k] += Number.isFinite(r.ageMs) ? r.ageMs / 1000 : MID_S;
      cnt[k]++;
      all.push(r.rssi);
    }
    fp[i] = Float64Array.from(sum, (v, k) => (cnt[k] ? v / cnt[k] : NaN));
    fpAge[i] = Float64Array.from(age, (v, k) => (cnt[k] ? v / cnt[k] : MID_S));
  }
  all.sort((a, b) => a - b);
  // Limiar de detecção: abaixo disto um rádio some da lista.
  const floorDbm = all.length ? all[Math.floor(all.length * 0.03)] + 2 : -88;

  const tOf = (i) => (scans[i] && Number.isFinite(scans[i].t) ? scans[i].t : i * 3.5);
  const floorOf = (i) => (scans[i] && Number.isFinite(scans[i].floor) ? Math.round(scans[i].floor) : 0);
  const spotOf = (i) => (scans[i] && scans[i].spot !== null && scans[i].spot !== undefined ? `${scans[i].spot}` : null);

  const track = (Array.isArray(survey.track) ? survey.track : [])
    .filter((s) => s && Number.isFinite(s.t) && Number.isFinite(s.rssi))
    .sort((p, q) => p.t - q.t);

  // Nós = visitas: varreduras seguidas no mesmo ponto marcado dividem um nó.
  const nodeOf = new Int32Array(n);
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const spot = spotOf(i);
    const last = nodes[nodes.length - 1];
    if (spot !== null && last && last.spot === spot) last.members.push(i);
    else nodes.push({ members: [i], floor: floorOf(i), spot });
    nodeOf[i] = nodes.length - 1;
  }
  const N = nodes.length;
  // y[a][k] = média das leituras do nó; c[a][k] = em quantas varreduras do nó o rádio apareceu.
  const y = new Array(N);
  const c = new Array(N);
  for (let a = 0; a < N; a++) {
    const sum = new Float64Array(K);
    const cnt = new Float64Array(K);
    for (const i of nodes[a].members) {
      for (let k = 0; k < K; k++) {
        if (fp[i][k] === fp[i][k]) {
          sum[k] += fp[i][k];
          cnt[k]++;
        }
      }
    }
    y[a] = Float64Array.from(sum, (v, k) => (cnt[k] ? v / cnt[k] : NaN));
    c[a] = cnt;
  }

  // Tempo de caminhada entre nós seguidos. Uma varredura "parada" garante o usuário no lugar
  // durante a varredura inteira (e um instante antes e depois); uma "andando" vale no meio dela.
  const gaps = [];
  for (let i = 0; i + 1 < n; i++) gaps.push(tOf(i + 1) - tOf(i));
  const interval = gaps.length ? Math.min(LONG_GAP_S, Math.max(1, median(gaps))) : 3.5;
  const walk = new Float64Array(Math.max(0, N - 1));
  const tArr = new Float64Array(N);
  const tDep = new Float64Array(N);
  for (let a = 0; a < N; a++) {
    const first = nodes[a].members[0];
    const last = nodes[a].members[nodes[a].members.length - 1];
    // Parado: chegou, tocou em "marcar" (~0,8 s) e esperou a próxima varredura começar (em média meio intervalo).
    tArr[a] = nodes[a].spot !== null ? tOf(first) - SWEEP_S - 0.8 - 0.5 * interval : tOf(first) - MID_S;
    tDep[a] = nodes[a].spot !== null ? tOf(last) + 0.6 : tOf(last) - MID_S;
  }
  for (let a = 0; a + 1 < N; a++) {
    const i = nodes[a].members[nodes[a].members.length - 1];
    const j = nodes[a + 1].members[0];
    const endA = tDep[a];
    const startB = tArr[a + 1];
    walk[a] = Math.max(MIN_WALK_S, startB - endA);
    if (tOf(j) - tOf(i) > LONG_GAP_S) {
      // Intervalo longo (limite de varreduras do Android): o usuário andou e depois ESPEROU.
      // O sinal da rede conectada mostra quando ele chegou: dali em diante o nível fica parado.
      const arrive = arrivalFromTrack(track, tOf(i) + 0.3, tOf(j) - SWEEP_S);
      const tau = arrive === null ? UNKNOWN_WALK_S : Math.max(0, arrive - endA);
      walk[a] = Math.hypot(tau, TRACK_RES_S);
    }
  }
  // Fração do caminho até o nó vizinho em que cada leitura foi de fato ouvida (nós andando):
  // negativa = antes do meio da varredura (em direção ao nó anterior), positiva = depois.
  const skew = new Array(N);
  for (let a = 0; a < N; a++) {
    skew[a] = new Float64Array(K);
    if (nodes[a].spot !== null) continue;
    const i = nodes[a].members[0];
    for (let k = 0; k < K; k++) {
      if (!(cnt0(c[a][k]))) continue;
      const early = fpAge[i][k] - MID_S; // s antes do meio
      if (early > 0 && a > 0) skew[a][k] = -Math.min(1, early / Math.max(0.5, walk[a - 1]));
      else if (early < 0 && a + 1 < N) skew[a][k] = Math.min(1, -early / Math.max(0.5, walk[a]));
    }
  }
  return { scans, n, radios, K, fp, nodeOf, nodes, N, y, c, walk, skew, floorDbm, tOf, radioOf };
}

const cnt0 = (v) => v > 0;

function median(values) {
  if (!values.length) return NaN;
  const v = Array.from(values).sort((a, b) => a - b);
  const m = (v.length - 1) / 2;
  return (v[Math.floor(m)] + v[Math.ceil(m)]) / 2;
}
const MIN_WALK_S = 0.5;
const LONG_GAP_S = 8; // intervalo entre varreduras acima do qual o tempo deixa de dizer a distância
const UNKNOWN_WALK_S = 4; // sem pista nenhuma: pontos marcados seguidos costumam ficar a uns 2 m
const TRACK_RES_S = 2; // o sinal conectado chega a cada ~2 s: é a resolução do instante de chegada

// Instante em que o nível da rede conectada estabiliza dentro da janela [t0, t1] (null = sem dados).
function arrivalFromTrack(track, t0, t1) {
  const seg = [];
  for (const s of track) if (s.t > t0 && s.t <= t1) seg.push(s);
  if (seg.length < 4) return null;
  const last = seg[seg.length - 1];
  const tail = seg.slice(seg.length >> 1).filter((s) => s.id === last.id).map((s) => s.rssi).sort((p, q) => p - q);
  const level = tail[tail.length >> 1];
  let first = seg.length - 1;
  let miss = 0;
  for (let j = seg.length - 1; j >= 0; j--) {
    if (seg[j].id === last.id && Math.abs(seg[j].rssi - level) <= 2.5) {
      first = j;
      miss = 0;
    } else if (++miss >= 2) break; // uma leitura fora isolada é ruído; duas seguidas é outro lugar
  }
  return seg[first].t - TRACK_RES_S / 2;
}

// ---------------------------------------------------------------------------
// Álgebra pequena
// ---------------------------------------------------------------------------

// Resolve A x = b (A simétrica positiva definida pequena) por Cholesky; devolve null se falhar.
function solveSpd(A, b, m) {
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

// Dois primeiros componentes principais das linhas de M (N x K, já centradas): devolve as notas N x 2.
function pca2(M, N, K) {
  const C = new Float64Array(K * K);
  for (let a = 0; a < N; a++) {
    const row = M[a];
    for (let p = 0; p < K; p++) {
      const v = row[p];
      if (v === 0) continue;
      for (let q = p; q < K; q++) C[p * K + q] += v * row[q];
    }
  }
  for (let p = 0; p < K; p++) for (let q = 0; q < p; q++) C[p * K + q] = C[q * K + p];
  const mul = (v) => {
    const out = new Float64Array(K);
    for (let p = 0; p < K; p++) {
      let s = 0;
      for (let q = 0; q < K; q++) s += C[p * K + q] * v[q];
      out[p] = s;
    }
    return out;
  };
  const dot = (u, v) => {
    let s = 0;
    for (let p = 0; p < K; p++) s += u[p] * v[p];
    return s;
  };
  const norm = (v) => {
    const len = Math.sqrt(dot(v, v)) || 1;
    for (let p = 0; p < K; p++) v[p] /= len;
  };
  let q1 = Float64Array.from({ length: K }, (_, p) => Math.sin(1.7 * p + 0.3));
  let q2 = Float64Array.from({ length: K }, (_, p) => Math.cos(2.9 * p + 1.1));
  for (let it = 0; it < 200; it++) {
    q1 = mul(q1);
    norm(q1);
    q2 = mul(q2);
    const d = dot(q1, q2);
    for (let p = 0; p < K; p++) q2[p] -= d * q1[p];
    norm(q2);
  }
  const X = new Array(N);
  for (let a = 0; a < N; a++) X[a] = [dot(M[a], q1), dot(M[a], q2)];
  return X;
}

// ---------------------------------------------------------------------------
// Suavizador na cadeia de nós (sistema tridiagonal em blocos 2x2)
// ---------------------------------------------------------------------------

// Cada nó traz a informação das suas leituras (J, h). Nós seguidos são ligados por dois termos:
//   isotrópico  e |x_{a+1} - x_a|²            (passo gaussiano, fraco: só dá liga)
//   de anel     w (u . (x_{a+1} - x_a) - L)²   (o passo tem o comprimento L de quem anda em ritmo constante;
//                                               u é a direção atual do passo: linearização de |passo| = L)
// Devolve em X a média e em cov a covariância a posteriori de cada nó.
function chainSolve(N, Jxx, Jxy, Jyy, hx, hy, M, X, cov) {
  const { e, w, L } = M;
  const step2 = new Float64Array(Math.max(0, N - 1));
  const Dxx = new Float64Array(N);
  const Dxy = new Float64Array(N);
  const Dyy = new Float64Array(N);
  const gx = new Float64Array(N);
  const gy = new Float64Array(N);
  // blocos fora da diagonal O_a = -(e I + w u u'), simétricos
  const Oxx = new Float64Array(N);
  const Oxy = new Float64Array(N);
  const Oyy = new Float64Array(N);
  const ax = new Float64Array(N); // contribuição do anel ao lado direito
  const ay = new Float64Array(N);
  const pxxA = Float64Array.from(Jxx);
  const pxyA = Float64Array.from(Jxy);
  const pyyA = Float64Array.from(Jyy);
  for (let a = 0; a + 1 < N; a++) {
    let dx = X[a + 1][0] - X[a][0];
    let dy = X[a + 1][1] - X[a][1];
    const d = Math.hypot(dx, dy);
    let wr = 0;
    if (w[a] > 0 && d > 1e-6) {
      dx /= d;
      dy /= d;
      // Passo curto demais é comum (curva, parada); longo demais não: o anel pesa mais para fora.
      wr = d > L[a] ? w[a] : w[a] * SHORT_STEP_WEIGHT;
    }
    const uxx = wr * dx * dx;
    const uxy = wr * dx * dy;
    const uyy = wr * dy * dy;
    pxxA[a] += e[a] + uxx;
    pxyA[a] += uxy;
    pyyA[a] += e[a] + uyy;
    pxxA[a + 1] += e[a] + uxx;
    pxyA[a + 1] += uxy;
    pyyA[a + 1] += e[a] + uyy;
    Oxx[a] = -(e[a] + uxx);
    Oxy[a] = -uxy;
    Oyy[a] = -(e[a] + uyy);
    ax[a] -= wr * L[a] * dx;
    ay[a] -= wr * L[a] * dy;
    ax[a + 1] += wr * L[a] * dx;
    ay[a + 1] += wr * L[a] * dy;
  }
  for (let a = 0; a < N; a++) {
    let pxx = pxxA[a] + 1e-9;
    let pxy = pxyA[a];
    let pyy = pyyA[a] + 1e-9;
    let rx = hx[a] + ax[a];
    let ry = hy[a] + ay[a];
    if (a > 0) {
      // Lm = O_{a-1} Dinv_{a-1}
      const o0 = Oxx[a - 1];
      const o1 = Oxy[a - 1];
      const o2 = Oyy[a - 1];
      const l00 = o0 * Dxx[a - 1] + o1 * Dxy[a - 1];
      const l01 = o0 * Dxy[a - 1] + o1 * Dyy[a - 1];
      const l10 = o1 * Dxx[a - 1] + o2 * Dxy[a - 1];
      const l11 = o1 * Dxy[a - 1] + o2 * Dyy[a - 1];
      pxx -= l00 * o0 + l01 * o1;
      pxy -= l00 * o1 + l01 * o2;
      pyy -= l10 * o1 + l11 * o2;
      rx -= l00 * gx[a - 1] + l01 * gy[a - 1];
      ry -= l10 * gx[a - 1] + l11 * gy[a - 1];
    }
    const det = pxx * pyy - pxy * pxy;
    Dxx[a] = pyy / det;
    Dxy[a] = -pxy / det;
    Dyy[a] = pxx / det;
    gx[a] = rx;
    gy[a] = ry;
  }
  for (let a = N - 1; a >= 0; a--) {
    let rx = gx[a];
    let ry = gy[a];
    if (a + 1 < N) {
      rx -= Oxx[a] * X[a + 1][0] + Oxy[a] * X[a + 1][1];
      ry -= Oxy[a] * X[a + 1][0] + Oyy[a] * X[a + 1][1];
      // G = Dinv_a O_a ; Sigma_a = Dinv_a + G Sigma_{a+1} G'
      const g00 = Dxx[a] * Oxx[a] + Dxy[a] * Oxy[a];
      const g01 = Dxx[a] * Oxy[a] + Dxy[a] * Oyy[a];
      const g10 = Dxy[a] * Oxx[a] + Dyy[a] * Oxy[a];
      const g11 = Dxy[a] * Oxy[a] + Dyy[a] * Oyy[a];
      const S = cov[a + 1];
      const t00 = g00 * S[0] + g01 * S[1];
      const t01 = g00 * S[1] + g01 * S[2];
      const t10 = g10 * S[0] + g11 * S[1];
      const t11 = g10 * S[1] + g11 * S[2];
      cov[a] = [Dxx[a] + t00 * g00 + t01 * g01, Dxy[a] + t00 * g10 + t01 * g11, Dyy[a] + t10 * g10 + t11 * g11];
      X[a] = [Dxx[a] * rx + Dxy[a] * ry, Dxy[a] * rx + Dyy[a] * ry];
      // E|passo|² a posteriori = |diferença das médias|² + tr(S_a + S_{a+1} - 2 S_{a,a+1}),  S_{a,a+1} = -G S_{a+1}
      const dx = X[a + 1][0] - X[a][0];
      const dy = X[a + 1][1] - X[a][1];
      step2[a] = dx * dx + dy * dy + cov[a][0] + cov[a][2] + S[0] + S[2] + 2 * (t00 + t11);
    } else {
      cov[a] = [Dxx[a], Dxy[a], Dyy[a]];
      X[a] = [Dxx[a] * rx + Dxy[a] * ry, Dxy[a] * rx + Dyy[a] * ry];
    }
  }
  return step2;
}

// Sistema simétrico positivo definido em banda (Cholesky): A z = b, com A[i][i+d] em Ab[i*(hb+1)+d].
function bandSolve(Ab, b, n, hb) {
  const w = hb + 1;
  for (let j = 0; j < n; j++) {
    const k0 = Math.max(0, j - hb);
    let d = Ab[j * w];
    for (let k = k0; k < j; k++) {
      const l = Ab[k * w + (j - k)];
      d -= l * l;
    }
    if (!(d > 1e-12)) d = 1e-12;
    d = Math.sqrt(d);
    Ab[j * w] = d;
    const iMax = Math.min(n - 1, j + hb);
    for (let i = j + 1; i <= iMax; i++) {
      let v = Ab[j * w + (i - j)];
      for (let k = Math.max(0, i - hb); k < j; k++) v -= Ab[k * w + (i - k)] * Ab[k * w + (j - k)];
      Ab[j * w + (i - j)] = v / d;
    }
  }
  // L y = b  (L[i][j] = Ab[j*w + (i-j)])
  for (let i = 0; i < n; i++) {
    let v = b[i];
    for (let k = Math.max(0, i - hb); k < i; k++) v -= Ab[k * w + (i - k)] * b[k];
    b[i] = v / Ab[i * w];
  }
  for (let i = n - 1; i >= 0; i--) {
    let v = b[i];
    const kMax = Math.min(n - 1, i + hb);
    for (let k = i + 1; k <= kMax; k++) v -= Ab[i * w + (k - i)] * b[k];
    b[i] = v / Ab[i * w];
  }
  return b;
}

const LAG_STRAIGHT = [1, 0.82, 0.72]; // corda / caminho andado em 1, 2 e 3 passos seguidos (curvas a cada 3-5 m)
const LAG_CV = [0.25, 0.35, 0.45]; // dispersão relativa de cada uma

// Passo de Gauss-Newton na trajetória inteira: dados de cada nó (J, h) + movimento
// (termo isotrópico entre nós seguidos e "anéis" de comprimento esperado em 1, 2 e 3 passos).
function pathSolve(N, Jxx, Jxy, Jyy, hx, hy, M, X, opt) {
  const hb = 7;
  const w = hb + 1;
  const n2 = 2 * N;
  const Ab = new Float64Array(n2 * w);
  const b = new Float64Array(n2);
  for (let a = 0; a < N; a++) {
    Ab[2 * a * w] += Jxx[a] + 1e-9;
    Ab[2 * a * w + 1] += Jxy[a];
    Ab[(2 * a + 1) * w] += Jyy[a] + 1e-9;
    b[2 * a] = hx[a];
    b[2 * a + 1] = hy[a];
  }
  // soma  s * (m00 m01; m01 m11) nos blocos (a,a), (c,c) e -s*(...) em (a,c)
  const couple = (a, c, m00, m01, m11) => {
    const i = 2 * a;
    const j = 2 * c;
    Ab[i * w] += m00;
    Ab[i * w + 1] += m01;
    Ab[(i + 1) * w] += m11;
    Ab[j * w] += m00;
    Ab[j * w + 1] += m01;
    Ab[(j + 1) * w] += m11;
    Ab[i * w + (j - i)] -= m00;
    Ab[i * w + (j + 1 - i)] -= m01;
    Ab[(i + 1) * w + (j - i - 1)] -= m01;
    Ab[(i + 1) * w + (j - i)] -= m11;
  };
  for (let a = 0; a + 1 < N; a++) couple(a, a + 1, M.e[a], 0, M.e[a]);
  const maxLag = opt.lags;
  for (let lag = 1; lag <= maxLag; lag++) {
    for (let a = 0; a + lag < N; a++) {
      const c = a + lag;
      let S = 0;
      let ok = true;
      for (let j = a; j < c; j++) {
        S += M.L[j];
        if (lag > 1 && !M.walking[j]) ok = false;
      }
      if (!ok || !(M.w[a] > 0)) continue;
      const T = LAG_STRAIGHT[lag - 1] * S;
      let dx = X[c][0] - X[a][0];
      let dy = X[c][1] - X[a][1];
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) continue;
      dx /= d;
      dy /= d;
      let wr = (opt.ring * (lag === 1 ? 1 : opt.lagWeight)) / (LAG_CV[lag - 1] * T) ** 2;
      if (d < T) wr *= lag === 1 ? SHORT_STEP_WEIGHT : opt.shortLag;
      couple(a, c, wr * dx * dx, wr * dx * dy, wr * dy * dy);
      b[2 * a] -= wr * T * dx;
      b[2 * a + 1] -= wr * T * dy;
      b[2 * c] += wr * T * dx;
      b[2 * c + 1] += wr * T * dy;
    }
  }
  bandSolve(Ab, b, n2, hb);
  for (let a = 0; a < N; a++) {
    X[a][0] = b[2 * a];
    X[a][1] = b[2 * a + 1];
  }
}

// ---------------------------------------------------------------------------
// Deformação suave que iguala o ritmo da caminhada
// ---------------------------------------------------------------------------

// O modelo linear usa um só "dB por metro" para a casa toda: onde o sinal varia pouco (sala aberta)
// o mapa sai encolhido, e onde há paredes sai esticado. Mas quem anda mantém o passo: procura-se a
// deformação SUAVE x' = A x + soma c_m phi_m(x) que deixa as cordas de 1, 2 e 3 passos com o
// comprimento esperado. Poucos parâmetros (não dá para "amassar" o caminho) e mínimos quadrados não lineares.
function equalizePace(X, M, N, opt) {
  // cordas
  const chords = [];
  for (let lag = 1; lag <= 3; lag++) {
    for (let a = 0; a + lag < N; a++) {
      let S = 0;
      let ok = true;
      for (let j = a; j < a + lag; j++) {
        S += M.L[j];
        if (lag > 1 && !M.walking[j]) ok = false;
      }
      if (!ok) continue;
      const T = LAG_STRAIGHT[lag - 1] * S;
      chords.push({ a, c: a + lag, T, s: LAG_CV[lag - 1] * T, lag });
    }
  }
  if (chords.length < 8) return X;
  // grade de bases radiais sobre o mapa
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let cx = 0;
  let cy = 0;
  for (let a = 0; a < N; a++) {
    minX = Math.min(minX, X[a][0]);
    maxX = Math.max(maxX, X[a][0]);
    minY = Math.min(minY, X[a][1]);
    maxY = Math.max(maxY, X[a][1]);
    cx += X[a][0] / N;
    cy += X[a][1] / N;
  }
  const G = opt.grid;
  const centres = [];
  const ext = Math.max(maxX - minX, maxY - minY, 1e-6);
  const sig = (opt.width * ext) / Math.max(1, G - 1 || 1);
  if (G >= 2) {
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) centres.push([minX + ((maxX - minX) * i) / (G - 1), minY + ((maxY - minY) * j) / (G - 1)]);
  }
  const Mb = centres.length;
  const Pn = 4 + 2 * Mb;
  const basis = (x, y) => {
    const out = new Float64Array(Mb);
    for (let m = 0; m < Mb; m++) {
      const dx = x - centres[m][0];
      const dy = y - centres[m][1];
      out[m] = Math.exp(-(dx * dx + dy * dy) / (2 * sig * sig));
    }
    return out;
  };
  const ph = X.map((p) => basis(p[0], p[1]));
  const par = new Float64Array(Pn);
  par[0] = 1;
  par[3] = 1;
  const apply = (a) => {
    const x = X[a][0] - cx;
    const y = X[a][1] - cy;
    let px = par[0] * x + par[1] * y;
    let py = par[2] * x + par[3] * y;
    for (let m = 0; m < Mb; m++) {
      px += par[4 + 2 * m] * ph[a][m];
      py += par[5 + 2 * m] * ph[a][m];
    }
    return [px, py];
  };
  for (let it = 0; it < opt.iters; it++) {
    const Y = X.map((_, a) => apply(a));
    const A = new Float64Array(Pn * Pn);
    const rhs = new Float64Array(Pn);
    const row = new Float64Array(Pn);
    for (const ch of chords) {
      let dx = Y[ch.c][0] - Y[ch.a][0];
      let dy = Y[ch.c][1] - Y[ch.a][1];
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) continue;
      dx /= d;
      dy /= d;
      const bx = X[ch.c][0] - X[ch.a][0];
      const by = X[ch.c][1] - X[ch.a][1];
      row[0] = dx * bx;
      row[1] = dx * by;
      row[2] = dy * bx;
      row[3] = dy * by;
      for (let m = 0; m < Mb; m++) {
        const dp = ph[ch.c][m] - ph[ch.a][m];
        row[4 + 2 * m] = dx * dp;
        row[5 + 2 * m] = dy * dp;
      }
      // linearização: |corda| ~ row . par ; alvo T
      let wgt = 1 / (ch.s * ch.s);
      if (d < ch.T) wgt *= opt.short;
      if (ch.lag > 1) wgt *= opt.lagWeight;
      for (let p = 0; p < Pn; p++) {
        if (row[p] === 0) continue;
        rhs[p] += wgt * row[p] * ch.T;
        for (let q = p; q < Pn; q++) A[p * Pn + q] += wgt * row[p] * row[q];
      }
    }
    for (let p = 0; p < Pn; p++) {
      // crista: a parte não linear paga para existir; e um passo amortecido em torno do valor atual
      const ridge = p < 4 ? 0 : opt.ridge * chords.length;
      A[p * Pn + p] += ridge + opt.damp * chords.length * (p < 4 ? ext * ext : 1) * 1e-3;
      rhs[p] += opt.damp * chords.length * (p < 4 ? ext * ext : 1) * 1e-3 * par[p];
      for (let q = 0; q < p; q++) A[p * Pn + q] = A[q * Pn + p];
    }
    const sol = solveSpd(A, rhs, Pn);
    if (!sol) break;
    for (let p = 0; p < Pn; p++) par[p] = sol[p];
  }
  return X.map((_, a) => apply(a));
}

// Modelo de movimento entre nós seguidos, pelo tempo de caminhada tau:
// comprimento esperado do passo L = PACE * tau / (1 + tau / STRAIGHT_S)  (curvas e paradas encurtam a corda).
const PACE = 0.62; // m/s: passo de quem anda dentro de casa olhando o celular (faixa típica 0,4 a 0,9)
const STRAIGHT_S = 9; // s: de quanto em quanto tempo há uma curva ou parada
const RING_CV = 0.25; // dispersão relativa do comprimento do passo
const SHORT_STEP_WEIGHT = 0.3; // peso do anel quando o passo está curto (relativo ao longo)
const MAX_WALK_S = 8;

function motionModel(P, opt) {
  const { N, walk } = P;
  const e = new Float64Array(Math.max(0, N - 1));
  const w = new Float64Array(Math.max(0, N - 1));
  const L = new Float64Array(Math.max(0, N - 1));
  const walking = new Uint8Array(Math.max(0, N - 1)); // passo dado andando sem parar (entre duas varreduras "andando")
  for (let a = 0; a + 1 < N; a++) {
    const tau = Math.max(MIN_WALK_S, Math.min(MAX_WALK_S, walk[a]));
    L[a] = (PACE * tau) / (1 + tau / STRAIGHT_S);
    walking[a] = P.nodes[a].spot === null && P.nodes[a + 1].spot === null && walk[a] <= 6 ? 1 : 0;
    if (opt.ring) {
      w[a] = opt.ring / (RING_CV * L[a]) ** 2;
      e[a] = opt.iso / (L[a] * L[a]);
    } else {
      e[a] = 2 / (opt.rw2 * L[a] * L[a]); // passeio aleatório: E|passo|² = rw2 L²
    }
  }
  return { e, w, L, walking };
}

// ---------------------------------------------------------------------------
// EM do modelo linear: y_ak = b_k[andar] + g_k . x_a + ruído;  x_{a+1} = x_a + passo
// ---------------------------------------------------------------------------

const IMPUTE_VAR = 36; // dB²: incerteza extra de um "não ouvi" tratado como leitura no limiar

function emLinear(P, X, iters, stages) {
  const { N, K, y, c, nodes, floorDbm } = P;
  const zoneKey = (nd, a) => (P.zones ? `${nd.floor}|${P.zones[a]}` : `${nd.floor}`);
  const floors = [...new Set(nodes.map(zoneKey))];
  const fIdx = nodes.map((nd, a) => floors.indexOf(zoneKey(nd, a)));
  const F = floors.length;
  const zoneRidge = P.zones ? P.opt.zoneRidge ?? 0.3 : 1e-3;
  // Observações (com imputação) e pesos relativos (1/variância em unidades de psi_k).
  const obs = new Array(N);
  const heard = new Float64Array(K);
  for (let a = 0; a < N; a++) for (let k = 0; k < K; k++) if (c[a][k] > 0) heard[k]++;
  const use = [];
  for (let k = 0; k < K; k++) if (heard[k] >= Math.max(3, 0.04 * N)) use.push(k);
  for (let a = 0; a < N; a++) {
    const o = [];
    for (const k of use) {
      if (c[a][k] > 0) o.push({ k, v: y[a][k], cnt: c[a][k], imp: false });
      else o.push({ k, v: floorDbm - 2, cnt: 1, imp: true });
    }
    obs[a] = o;
  }
  const motion = motionModel(P, { ring: P.opt.ringLin ?? 0, iso: P.opt.isoLin ?? 0.25, rw2: P.opt.rw2 ?? 1.3 });
  const g = Array.from({ length: K }, () => [0, 0]);
  const b = Array.from({ length: K }, () => new Float64Array(F));
  const psi = new Float64Array(K).fill(16);
  const cov = Array.from({ length: N }, () => [0, 0, 0]); // xx, xy, yy
  const mStep = () => {
    const m = 2 + F;
    for (const k of use) {
      const A = new Float64Array(m * m);
      const rhs = new Float64Array(m);
      let sw = 0;
      const rows = [];
      for (let a = 0; a < N; a++) {
        const o = obs[a].find((e) => e.k === k);
        if (!o) continue;
        const w = o.imp ? psi[k] / (psi[k] + IMPUTE_VAR) : o.cnt;
        const x0 = X[a][0];
        const x1 = X[a][1];
        const f = 2 + fIdx[a];
        A[0] += w * (x0 * x0 + cov[a][0]);
        A[1] += w * (x0 * x1 + cov[a][1]);
        A[m + 1] += w * (x1 * x1 + cov[a][2]);
        A[f] += w * x0;
        A[m + f] += w * x1;
        A[f * m + f] += w;
        rhs[0] += w * o.v * x0;
        rhs[1] += w * o.v * x1;
        rhs[f] += w * o.v;
        sw += w;
        rows.push([a, o.v, w, f]);
      }
      for (let p = 0; p < m; p++) for (let r = 0; r < p; r++) A[p * m + r] = A[r * m + p];
      // Prior fraco no gradiente (dB/m) e no nível, para rádios pouco ouvidos não explodirem.
      A[0] += 0.05;
      A[m + 1] += 0.05;
      // Nível de cada zona: encolhe para o nível médio do rádio (a diferença entre zonas é a perda nas paredes).
      const level = P.zones ? rhsMean(rhs, A, m) : floorDbm + 10;
      for (let f = 2; f < m; f++) {
        A[f * m + f] += zoneRidge;
        rhs[f] += zoneRidge * level;
      }
      const th = solveSpd(A, rhs, m);
      if (!th) continue;
      g[k][0] = th[0];
      g[k][1] = th[1];
      for (let f = 0; f < F; f++) b[k][f] = th[2 + f];
      let res = 0;
      for (const [a, v, w, f] of rows) {
        const e = v - th[f] - th[0] * X[a][0] - th[1] * X[a][1];
        res += w * (e * e + th[0] * th[0] * cov[a][0] + 2 * th[0] * th[1] * cov[a][1] + th[1] * th[1] * cov[a][2]);
      }
      psi[k] = Math.max(1, (res + 4 * 9) / (sw + 4));
    }
  };
  const Jxx = new Float64Array(N);
  const Jxy = new Float64Array(N);
  const Jyy = new Float64Array(N);
  const hx = new Float64Array(N);
  const hy = new Float64Array(N);
  const temperLin = P.opt.temperLin ?? 1;
  const eStep = () => {
    // Informação de cada nó: J = sum g g'/var, h = sum g (v - b)/var.
    for (let a = 0; a < N; a++) {
      let jxx = 0;
      let jxy = 0;
      let jyy = 0;
      let h0 = 0;
      let h1 = 0;
      for (const o of obs[a]) {
        const k = o.k;
        const w = (o.imp ? 1 / (psi[k] + IMPUTE_VAR) : o.cnt / psi[k]) * temperLin;
        const r = o.v - b[k][fIdx[a]];
        jxx += w * g[k][0] * g[k][0];
        jxy += w * g[k][0] * g[k][1];
        jyy += w * g[k][1] * g[k][1];
        h0 += w * g[k][0] * r;
        h1 += w * g[k][1] * r;
      }
      Jxx[a] = jxx;
      Jxy[a] = jxy;
      Jyy[a] = jyy;
      hx[a] = h0;
      hy[a] = h1;
    }
    const step2 = chainSolve(N, Jxx, Jxy, Jyy, hx, hy, motion, X, cov);
    // Razão entre o passo esperado a posteriori e o do modelo (1 = a escala do mapa bate com a caminhada).
    let ratio = 0;
    for (let a = 0; a + 1 < N; a++) ratio += (step2[a] * motion.e[a]) / 2;
    return ratio;
  };
  // Correções das leituras (somadas a o.v): atraso dentro da varredura e sombra do corpo.
  const band = P.radios.map((r) => r.band);
  const beta = [0, 0, 0];
  const heading = new Float64Array(N).fill(NaN);
  const BMEAN = 3 / 8; // média de ((1 - cos)/2)² sobre todas as direções
  const bodyShape = (th, phi) => {
    const v = (1 - Math.cos(th - phi)) / 2;
    return v * v - BMEAN;
  };
  const raw = obs.map((o) => o.map((e) => e.v));
  const corrections = (it) => {
    const wantBody = P.opt.body !== 0 && it >= 8;
    // Direção de cada rádio: para onde o sinal cresce.
    const phi = new Float64Array(K);
    const gmag = new Float64Array(K);
    for (const k of use) {
      phi[k] = Math.atan2(g[k][1], g[k][0]);
      gmag[k] = Math.hypot(g[k][0], g[k][1]);
    }
    // Rumo: direção da caminhada (nós andando) ou o melhor ajuste aos resíduos (nós parados).
    for (let a = 0; a < N; a++) {
      heading[a] = NaN;
      if (!wantBody) continue;
      if (nodes[a].spot === null) {
        const p = a > 0 && P.walk[a - 1] < 6 ? a - 1 : a;
        const nx = a + 1 < N && P.walk[a] < 6 ? a + 1 : a;
        const dx = X[nx][0] - X[p][0];
        const dy = X[nx][1] - X[p][1];
        if (Math.hypot(dx, dy) > 0.3) heading[a] = Math.atan2(dy, dx);
      } else if (P.opt.stillHeading !== 0 && it >= 12) {
        let best = Infinity;
        for (let d = 0; d < 12; d++) {
          const th = (d * Math.PI) / 6;
          let sse = 0;
          obs[a].forEach((o, j) => {
            if (o.imp) return;
            const k = o.k;
            const e = raw[a][j] - b[k][fIdx[a]] - g[k][0] * X[a][0] - g[k][1] * X[a][1] + beta[band[k]] * bodyShape(th, phi[k]);
            sse += (o.cnt * e * e) / psi[k];
          });
          if (sse < best) {
            best = sse;
            heading[a] = th;
          }
        }
      }
    }
    // Ganho da sombra do corpo por faixa: regressão dos resíduos no formato esperado.
    if (wantBody) {
      const sxy = [0, 0, 0];
      const sxx = [0, 0, 0];
      for (let a = 0; a < N; a++) {
        if (heading[a] !== heading[a] || nodes[a].spot !== null) continue;
        obs[a].forEach((o, j) => {
          if (o.imp) return;
          const k = o.k;
          const sh = bodyShape(heading[a], phi[k]);
          const sk = P.opt.skew !== 0 ? P.skew[a][k] : 0;
          const nb = sk < 0 ? a - 1 : a + 1;
          const off = sk === 0 ? 0 : Math.abs(sk) * (g[k][0] * (X[nb][0] - X[a][0]) + g[k][1] * (X[nb][1] - X[a][1]));
          const e = raw[a][j] - off - b[k][fIdx[a]] - g[k][0] * X[a][0] - g[k][1] * X[a][1];
          sxy[band[k]] += (-e * sh) / psi[k];
          sxx[band[k]] += (sh * sh) / psi[k];
        });
      }
      const sx = sxx[0] + sxx[1] + sxx[2];
      const sy = sxy[0] + sxy[1] + sxy[2];
      const common = Math.max(0, Math.min(12, (sy + 0.5 * 4) / (sx + 0.5))); // prior fraco: ~4 dB
      for (let bd = 0; bd < 3; bd++) beta[bd] = P.opt.betaFix !== undefined ? P.opt.betaFix : common;
    }
    for (let a = 0; a < N; a++) {
      obs[a].forEach((o, j) => {
        let v = raw[a][j];
        if (!o.imp) {
          const k = o.k;
          const sk = P.opt.skew !== 0 ? P.skew[a][k] : 0;
          if (sk !== 0) {
            const nb = sk < 0 ? a - 1 : a + 1;
            v -= Math.abs(sk) * (g[k][0] * (X[nb][0] - X[a][0]) + g[k][1] * (X[nb][1] - X[a][1]));
          }
          if (heading[a] === heading[a]) v += beta[band[k]] * bodyShape(heading[a], phi[k]);
        }
        o.v = v;
      });
    }
  };
  for (let it = 0; it < iters; it++) {
    mStep();
    if (it >= 3) corrections(it);
    const ratio = eStep() / Math.max(1, N - 1);
    // Atalho do ponto fixo do EM na direção da escala: os passos esperados têm de bater com q.
    if (!(P.opt.ringLin > 0) && ratio > 0 && Number.isFinite(ratio)) {
      const s = Math.min(1.25, Math.max(0.8, 1 / Math.sqrt(ratio)));
      for (let a = 0; a < N; a++) {
        X[a][0] *= s;
        X[a][1] *= s;
        cov[a][0] *= s * s;
        cov[a][1] *= s * s;
        cov[a][2] *= s * s;
      }
    }
    if (stages && (it === 0 || it === 9 || it === 49 || it === iters - 1)) stages[`em${it + 1}`] = X.map((p) => [p[0], p[1]]);
  }
  return { X, cov, g, b, psi, use, floors, fIdx, beta, heading };
}

// ---------------------------------------------------------------------------
// Campos não lineares: plano + bases radiais numa grade, com validação "deixa um de fora"
// ---------------------------------------------------------------------------

// Nível médio ponderado das leituras de um rádio, a partir das somas já acumuladas da regressão.
function rhsMean(rhs, A, m) {
  let sy = 0;
  let sw = 0;
  for (let f = 2; f < m; f++) {
    sy += rhs[f];
    sw += A[f * m + f];
  }
  return sw > 0 ? sy / sw : -80;
}

function normCdf(z) {
  // Aproximação de Abramowitz-Stegun (erro < 1e-7), suficiente para pesos.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

const MISS_PROB = 0.05; // chance de um rádio audível faltar numa varredura (beacon perdido)

function fieldStage(P, lin, opt, stages) {
  const { N, K, y, c, nodes, floorDbm } = P;
  const { X, cov, floors, fIdx, use } = lin;
  const motion = motionModel(P, { ring: opt.ring, iso: opt.iso, rw2: P.opt.rw2 ?? 1.3 });
  const F = floors.length;
  const U = use.length;
  const W = Float64Array.from(nodes, (nd) => nd.members.length);
  const psi = Float64Array.from(use, (k) => lin.psi[k]);
  // Y com imputação inicial pelo modelo plano.
  const Y = new Array(N);
  const miss = new Array(N);
  for (let a = 0; a < N; a++) {
    Y[a] = new Float64Array(U);
    miss[a] = new Uint8Array(U);
    for (let u = 0; u < U; u++) {
      const k = use[u];
      if (c[a][k] > 0) Y[a][u] = y[a][k];
      else {
        miss[a][u] = 1;
        Y[a][u] = Math.min(floorDbm - 2, lin.b[k][fIdx[a]] + lin.g[k][0] * X[a][0] + lin.g[k][1] * X[a][1]);
      }
    }
  }
  const Jxx = new Float64Array(N);
  const Jxy = new Float64Array(N);
  const Jyy = new Float64Array(N);
  const hx = new Float64Array(N);
  const hy = new Float64Array(N);
  let info = '';
  const fz = {};
  for (let it = 0; it < opt.iters; it++) {
    const frac = opt.iters > 1 ? it / (opt.iters - 1) : 1;
    const sigma = P.opt.freeze ? opt.sigma1 : opt.sigma0 * (opt.sigma1 / opt.sigma0) ** Math.min(1, frac * 1.5); // base larga -> estreita
    // --- grade de centros por andar ---
    const frozen = P.opt.freeze && it > 0;
    const centres = frozen ? fz.centres : []; // {x, y, f}
    for (let f = 0; f < F && !frozen; f++) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let a = 0; a < N; a++) {
        if (fIdx[a] !== f) continue;
        minX = Math.min(minX, X[a][0]);
        maxX = Math.max(maxX, X[a][0]);
        minY = Math.min(minY, X[a][1]);
        maxY = Math.max(maxY, X[a][1]);
      }
      if (minX === Infinity) continue;
      let h = sigma * opt.spacing;
      // Limite de bases por andar: grade mais aberta em mapas grandes.
      while (((maxX - minX) / h + 2) * ((maxY - minY) / h + 2) > opt.maxBasis / F) h *= 1.1;
      const nx = Math.max(1, Math.ceil((maxX - minX) / h) + 1);
      const ny = Math.max(1, Math.ceil((maxY - minY) / h) + 1);
      const ox = (minX + maxX) / 2 - ((nx - 1) * h) / 2;
      const oy = (minY + maxY) / 2 - ((ny - 1) * h) / 2;
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) centres.push({ x: ox + i * h, y: oy + j * h, f, s: Math.max(sigma, h / opt.spacing) });
    }
    const M = F + 2 + centres.length;
    // --- matriz de projeto e derivadas ---
    const Phi = new Array(N);
    const Px = new Array(N);
    const Py = new Array(N);
    for (let a = 0; a < N; a++) {
      const row = new Float64Array(M);
      const rx = new Float64Array(M);
      const ry = new Float64Array(M);
      row[fIdx[a]] = 1;
      row[F] = X[a][0];
      rx[F] = 1;
      row[F + 1] = X[a][1];
      ry[F + 1] = 1;
      for (let m = 0; m < centres.length; m++) {
        const ce = centres[m];
        if (ce.f !== fIdx[a]) continue;
        const dx = X[a][0] - ce.x;
        const dy = X[a][1] - ce.y;
        const s2 = ce.s * ce.s;
        const v = Math.exp(-(dx * dx + dy * dy) / (2 * s2));
        if (v < 1e-4) continue;
        row[F + 2 + m] = v;
        rx[F + 2 + m] = (-dx / s2) * v;
        ry[F + 2 + m] = (-dy / s2) * v;
      }
      Phi[a] = row;
      Px[a] = rx;
      Py[a] = ry;
    }
    // --- regressão de crista comum a todos os rádios: A = Phi' W Phi + Lambda ---
    const A = new Float64Array(M * M);
    for (let a = 0; a < N; a++) {
      const row = Phi[a];
      const w = W[a];
      for (let p = 0; p < M; p++) {
        const v = row[p];
        if (v === 0) continue;
        const wv = w * v;
        for (let r = p; r < M; r++) A[p * M + r] += wv * row[r];
      }
    }
    for (let p = 0; p < M; p++) {
      A[p * M + p] += p < F ? 1e-6 : p < F + 2 ? opt.ridgeLin : opt.ridge;
      for (let r = 0; r < p; r++) A[p * M + r] = A[r * M + p];
    }
    const L = cholesky(A, M);
    if (!L) break;
    // Pesos de cada rádio.
    const Wt = frozen ? fz.Wt : new Array(U);
    for (let u = 0; u < U && !frozen; u++) {
      const rhs = new Float64Array(M);
      for (let a = 0; a < N; a++) {
        const row = Phi[a];
        const wy = W[a] * Y[a][u];
        for (let p = 0; p < M; p++) if (row[p] !== 0) rhs[p] += wy * row[p];
      }
      Wt[u] = cholSolve(L, rhs, M);
    }
    if (P.opt.freeze && it === 0) {
      fz.centres = centres;
      fz.Wt = Wt;
    }
    // Alavanca de cada nó e a correção "sem mim" do gradiente.
    const lev = new Float64Array(N);
    const vx = new Float64Array(N);
    const vy = new Float64Array(N);
    for (let a = 0; a < N; a++) {
      const ua = cholSolve(L, Phi[a], M);
      let h = 0;
      let sx = 0;
      let sy = 0;
      for (let p = 0; p < M; p++) {
        h += Phi[a][p] * ua[p];
        sx += Px[a][p] * ua[p];
        sy += Py[a][p] * ua[p];
      }
      lev[a] = frozen ? 0 : Math.min(0.9, W[a] * h);
      vx[a] = frozen ? 0 : W[a] * sx;
      vy[a] = frozen ? 0 : W[a] * sy;
    }
    // --- resíduos, ruído por rádio (validação cruzada), imputação ---
    const pred = new Array(N);
    const gxA = new Array(N);
    const gyA = new Array(N);
    for (let a = 0; a < N; a++) {
      pred[a] = new Float64Array(U);
      gxA[a] = new Float64Array(U);
      gyA[a] = new Float64Array(U);
      const row = Phi[a];
      const rx = Px[a];
      const ry = Py[a];
      for (let u = 0; u < U; u++) {
        const w = Wt[u];
        let f = 0;
        let fx = 0;
        let fy = 0;
        for (let p = 0; p < M; p++) {
          const v = row[p];
          if (v === 0 && rx[p] === 0 && ry[p] === 0) continue;
          f += v * w[p];
          fx += rx[p] * w[p];
          fy += ry[p] * w[p];
        }
        pred[a][u] = f;
        gxA[a][u] = fx;
        gyA[a][u] = fy;
      }
    }
    for (let u = 0; u < U; u++) {
      let s = 0;
      let sw = 0;
      for (let a = 0; a < N; a++) {
        if (miss[a][u]) continue;
        const e = (Y[a][u] - pred[a][u]) / (1 - lev[a]);
        s += W[a] * Math.min(e * e, 400);
        sw += W[a];
      }
      psi[u] = Math.max(1, (s + 4 * 9) / (sw + 4));
    }
    // --- passo de Gauss-Newton nas posições, com o campo "sem mim" de cada nó ---
    for (let a = 0; a < N; a++) {
      let jxx = opt.damp;
      let jxy = 0;
      let jyy = opt.damp;
      let h0 = opt.damp * X[a][0];
      let h1 = opt.damp * X[a][1];
      const inv = 1 / (1 - lev[a]);
      for (let u = 0; u < U; u++) {
        let wgt;
        let r;
        let fx = gxA[a][u];
        let fy = gyA[a][u];
        if (miss[a][u]) {
          // "Não ouvi": ou estava abaixo do limiar (informa), ou foi um beacon perdido (não informa).
          const sd = Math.sqrt(psi[u]);
          const z = (floorDbm - pred[a][u]) / sd;
          const pc = normCdf(z);
          const resp = pc / (pc + MISS_PROB * (1 - pc));
          const dens = 0.3989422804014327 * Math.exp(-0.5 * z * z);
          const cens = pred[a][u] - (sd * dens) / Math.max(pc, 1e-6); // média da normal truncada abaixo do limiar
          const target = resp * Math.max(cens, floorDbm - 12) + (1 - resp) * pred[a][u];
          Y[a][u] = target;
          wgt = resp / psi[u];
          r = Math.min(0, floorDbm - 1 - pred[a][u]); // só empurra se o campo previsto passa do limiar
          wgt *= r < 0 ? 1 : 0;
        } else {
          const e = Y[a][u] - pred[a][u];
          r = e * inv;
          fx -= vx[a] * r;
          fy -= vy[a] * r;
          // Leitura muito fora (rara) pesa menos.
          const zz = (r * r) / psi[u];
          wgt = (W[a] * (1 - lev[a])) / psi[u] / (1 + zz / 9);
        }
        wgt *= opt.temper;
        jxx += wgt * fx * fx;
        jxy += wgt * fx * fy;
        jyy += wgt * fy * fy;
        // linearização em torno de x0: y - f(x0) = grad . (x - x0)
        const rr = r + fx * X[a][0] + fy * X[a][1];
        h0 += wgt * fx * rr;
        h1 += wgt * fy * rr;
      }
      Jxx[a] = jxx;
      Jxy[a] = jxy;
      Jyy[a] = jyy;
      hx[a] = h0;
      hy[a] = h1;
    }
    let ratio = 0;
    if (opt.ring > 0) {
      pathSolve(N, Jxx, Jxy, Jyy, hx, hy, motion, X, opt);
      for (let a = 0; a + 1 < N; a++) ratio += Math.hypot(X[a + 1][0] - X[a][0], X[a + 1][1] - X[a][1]) / motion.L[a] / Math.max(1, N - 1);
    } else {
      // Passeio aleatório gaussiano + ponto fixo de escala do EM (passo esperado = passo do modelo).
      const step2 = chainSolve(N, Jxx, Jxy, Jyy, hx, hy, motion, X, cov);
      for (let a = 0; a + 1 < N; a++) ratio += (step2[a] * motion.e[a]) / 2 / Math.max(1, N - 1);
      if (ratio > 0 && Number.isFinite(ratio)) {
        const sc = Math.min(1.1, Math.max(0.9, 1 / Math.sqrt(ratio)));
        for (let a = 0; a < N; a++) {
          X[a][0] *= sc;
          X[a][1] *= sc;
        }
      }
    }
    {
      let cv = 0;
      for (let u = 0; u < U; u++) cv += psi[u] / U;
      if (P.opt.trace) info += ` ${cv.toFixed(1)}`;
    }
    if (stages && (it === 4 || it === 14 || it === opt.iters - 1)) stages[`f${it + 1}`] = X.map((p) => [p[0], p[1]]);
    if (it === opt.iters - 1) info += ` M=${M} sig=${sigma.toFixed(2)} psi=${(psi.reduce((s, v) => s + v, 0) / U).toFixed(1)} ratio=${ratio.toFixed(2)}`;
  }
  return { X, cov, info };
}

function cholesky(A, m) {
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

function cholSolve(L, b, m) {
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
// Solução
// ---------------------------------------------------------------------------

function solveInner(survey, options) {
  const P = prepare(survey);
  P.opt = options;
  if (options.__rooms) {
    // DEV: zonas = cômodos reais (remover antes de entregar)
    let prev = 'x';
    P.zones = P.nodes.map((nd) => {
      const r = options.__rooms[nd.members[0]];
      if (r) prev = r;
      return prev;
    });
  }
  const { scans, n, N, nodes, nodeOf, K, y, c, floorDbm } = P;
  if (n === 0) return { points: [], aps: {}, scaleConf: 0 };
  const nodeStages = {};

  // Partida: PCA das impressões digitais (faltantes no limiar), centradas por andar.
  const M = new Array(N);
  const floors = [...new Set(nodes.map((nd) => nd.floor))];
  for (let a = 0; a < N; a++) M[a] = Float64Array.from({ length: K }, (_, k) => (c[a][k] > 0 ? y[a][k] : floorDbm - 2));
  for (const f of floors) {
    const idx = [];
    for (let a = 0; a < N; a++) if (nodes[a].floor === f) idx.push(a);
    for (let k = 0; k < K; k++) {
      let s = 0;
      for (const a of idx) s += M[a][k];
      s /= idx.length;
      for (const a of idx) M[a][k] -= s;
    }
  }
  let X = N >= 2 && K >= 1 ? pca2(M, N, K) : nodes.map(() => [0, 0]);
  // Escala inicial: 1 dB de componente principal ~ 0,3 m (o EM acerta depois pela caminhada).
  X = X.map((p) => [p[0] * 0.3, p[1] * 0.3]);
  nodeStages.pca = X.map((p) => [p[0], p[1]]);

  let lin = emLinear(P, X, options.emIters ?? 100, nodeStages);
  X = lin.X;
  if (options.__truth) {
    // DEV: parte da verdade para medir o viés do modelo (remover antes de entregar)
    const T = nodes.map((nd) => {
      let sx = 0, sy = 0;
      for (const i of nd.members) { sx += options.__truth[i].x; sy += options.__truth[i].y; }
      return [sx / nd.members.length, sy / nd.members.length];
    });
    if (options.__truth === 'lin' || options.truthLin) lin = emLinear(P, T, options.emIters ?? 100, null);
    else {
      // mistura: mix=1 -> verdade; mix=0 -> solução linear (alinhada rigidamente à verdade, com escala corrigida)
      const mix = options.mix ?? 1;
      let ex = 0, ey = 0, tx = 0, ty = 0;
      for (let a = 0; a < N; a++) { ex += lin.X[a][0] / N; ey += lin.X[a][1] / N; tx += T[a][0] / N; ty += T[a][1] / N; }
      let sa = 0, sb = 0, sam = 0, sbm = 0, ee = 0;
      for (let a = 0; a < N; a++) { const px = lin.X[a][0] - ex, py = lin.X[a][1] - ey, qx = T[a][0] - tx, qy = T[a][1] - ty; sa += px * qx + py * qy; sb += px * qy - py * qx; sam += px * qx - py * qy; sbm += px * qy + py * qx; ee += px * px + py * py; }
      const refl = Math.hypot(sam, sbm) > Math.hypot(sa, sb);
      const ang = refl ? Math.atan2(sbm, sam) : Math.atan2(sb, sa);
      const sc = options.mixScale ? (refl ? Math.hypot(sam, sbm) : Math.hypot(sa, sb)) / ee : 1;
      const co = Math.cos(ang) * sc, si = Math.sin(ang) * sc, m = refl ? -1 : 1;
      for (let a = 0; a < N; a++) {
        const px = lin.X[a][0] - ex, py = (lin.X[a][1] - ey) * m;
        const lx = co * px - si * py + tx, ly = si * px + co * py + ty;
        lin.X[a][0] = mix * T[a][0] + (1 - mix) * lx; lin.X[a][1] = mix * T[a][1] + (1 - mix) * ly; lin.cov[a] = [0.01, 0, 0.01];
      }
    }
    X = lin.X;
    nodeStages.tinit = X.map((p) => [p[0], p[1]]);
  }
  let info = '';
  if (options.scaleStats) {
    // DEV: estatísticas de passo do caminho estimado, para estudar estimadores de escala
    const mm = motionModel(P, { ring: 1, iso: 0.25 });
    const st = { d1: 0, n1: 0, l1: 0, d2: 0, n2: 0, d3: 0, n3: 0, acc: 0, nacc: 0, hop: 0, hopL: 0, nhop: 0, cov: 0 };
    const accs = [];
    for (let a = 0; a + 1 < N; a++) {
      st.cov += (lin.cov[a][0] + lin.cov[a][2]) / N;
      if (!mm.walking[a]) continue;
      const d = Math.hypot(X[a + 1][0] - X[a][0], X[a + 1][1] - X[a][1]);
      st.d1 += d * d; st.l1 += mm.L[a] * mm.L[a]; st.n1++;
      if (a + 2 < N && mm.walking[a + 1]) {
        st.d2 += (X[a + 2][0] - X[a][0]) ** 2 + (X[a + 2][1] - X[a][1]) ** 2; st.n2++;
        const ax = X[a + 2][0] - 2 * X[a + 1][0] + X[a][0], ay = X[a + 2][1] - 2 * X[a + 1][1] + X[a][1];
        st.acc += ax * ax + ay * ay; st.nacc++; accs.push(ax * ax + ay * ay);
        if (a + 3 < N && mm.walking[a + 2]) { st.d3 += (X[a + 3][0] - X[a][0]) ** 2 + (X[a + 3][1] - X[a][1]) ** 2; st.n3++; }
      }
    }
    // saltos entre pontos marcados seguidos
    let prevSpot = -1;
    for (let a = 0; a < N; a++) {
      if (nodes[a].spot === null) continue;
      if (prevSpot >= 0) {
        let S = 0;
        for (let j = prevSpot; j < a; j++) S += P.walk[j] <= 6 || true ? mm.L[j] : 0;
        st.hop += Math.hypot(X[a][0] - X[prevSpot][0], X[a][1] - X[prevSpot][1]) ** 2; st.hopL += S * S; st.nhop++;
      }
      prevSpot = a;
    }
    accs.sort((p, q) => p - q);
    st.accMed = accs.length ? accs[accs.length >> 1] : 0;
    info += ' @@' + JSON.stringify(st);
  }
  if (options.warp > 0) {
    const mm = motionModel(P, { ring: 1, iso: 0.25 });
    const wo = { iters: 20, short: options.wShort ?? 0.5, lagWeight: options.wLag ?? 1, ridge: options.wRidge ?? 0.02, damp: 1, width: options.wWidth ?? 0.7 };
    const Xa = equalizePace(X, mm, N, { ...wo, grid: 0 });
    nodeStages.warpA = Xa.map((p) => [p[0], p[1]]);
    const Xw = equalizePace(X, mm, N, { ...wo, grid: options.wGrid ?? 3 });
    nodeStages.warp = Xw.map((p) => [p[0], p[1]]);
    for (let a = 0; a < N; a++) {
      lin.X[a][0] = Xw[a][0];
      lin.X[a][1] = Xw[a][1];
    }
    X = lin.X;
  }
  if (options.field !== 0) {
    const fs = fieldStage(
      P,
      lin,
      {
        iters: options.fIters ?? 30,
        sigma0: options.sigma0 ?? 4,
        sigma1: options.sigma1 ?? 2,
        spacing: options.spacing ?? 1,
        maxBasis: options.maxBasis ?? 120,
        ridge: options.ridge ?? 1,
        ridgeLin: 0.05,
        damp: options.damp ?? 0.5,
        ring: options.ring ?? 1,
        temper: options.temper ?? 1,
        lags: options.lags ?? 3,
        lagWeight: options.lagWeight ?? 1,
        shortLag: options.shortLag ?? 0.5,
        iso: options.iso ?? 0.25,
      },
      nodeStages,
    );
    X = fs.X;
    info = fs.info;
  }
  info += ` beta=${lin.beta.map((v) => v.toFixed(1)).join('/')}`;

  const stages = {};
  for (const [name, Z] of Object.entries(nodeStages)) stages[name] = expand(Z, nodeOf, n);
  const pts = expand(X, nodeOf, n);
  const points = pts.map((p, i) => ({ x: p.x, y: p.y, z: ((scans[i] && scans[i].floor) || 0) * FLOOR_HEIGHT, conf: 0.5 }));
  const aps = regressAps(P, points);
  return { points, aps, scaleConf: 0.5, debug: { stages, info } };
}

function expand(X, nodeOf, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { x: X[nodeOf[i]][0], y: X[nodeOf[i]][1] };
  return out;
}

// Roteadores: centro dos pontos onde chegaram mais forte + curva ajustada (provisório).
function regressAps(P, points) {
  const { radios, fp, n } = P;
  const aps = {};
  radios.forEach((radio, k) => {
    const seen = [];
    for (let i = 0; i < n; i++) if (!Number.isNaN(fp[i][k])) seen.push({ i, r: fp[i][k] });
    if (seen.length < 3) return;
    seen.sort((p, q) => q.r - p.r);
    const top = seen.slice(0, 5);
    let w = 0;
    let x = 0;
    let yy = 0;
    for (const t of top) {
      const wt = 10 ** (t.r / 20);
      w += wt;
      x += wt * points[t.i].x;
      yy += wt * points[t.i].y;
    }
    const ap = { x: x / w, y: yy / w, z: points[top[0].i].z + 1, p0: top[0].r + 3, n: 2.5, conf: 0.2 };
    for (const id of radio.bssids) aps[id] = { ...ap };
  });
  return aps;
}

// DEV: acesso aos internos para experimentos (remover antes de entregar)
export const __dev = { prepare, pca2, solveSpd };
