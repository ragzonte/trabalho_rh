// Construtor do mapa: Survey + MapSolution -> MapModel, e as análises em cima dele
// (campo de sinal, cobertura, sugestão de lugar para o roteador, descrição em texto).
//
// O mapa é honesto: a ÁREA por onde se andou, os AMBIENTES como grupos de lugares com
// "impressão digital" de Wi-Fi parecida, o SINAL medido e os roteadores estimados.
// Nada aqui inventa paredes exatas. Sem DOM, sem Node, determinístico: o mesmo
// levantamento e a mesma solução dão sempre o mesmo modelo.

import { FLOOR_HEIGHT } from './types.js';

const VERSION = 1;
/** Leitura mais velha que isto (ms) não é desta varredura: o aparelho repetiu uma antiga. */
const STALE_MS = 4500;
/** Altura do celular na mão (m acima do piso). */
const PHONE_HEIGHT = 1.2;
/** Faixas de sinal (dBm) usadas na cobertura. */
const GOOD_DBM = -67;
const FAIR_DBM = -75;
const WEAK_DBM = -82;
/** Erro esperado (m) em que a confiança de um ponto vale 0,5: a mesma régua do solucionador (CONF_HALF_M em solver.js). */
const CONF_HALF_M = 1.5;

// Constantes do construtor. `options.tune` troca qualquer uma (só a bancada usa).
const TUNE = {
  cell: 0.25,
  marginM: 2,
  maxCells: 90000,
  maxSpanM: 150,
  // --- área ---
  areaH: 0.55, // núcleo da densidade do caminho (m)
  areaR: 1.0, // meia-largura do "corpo" de uma passada isolada (m), com a posição exata
  areaErr: 1.44, // quanto do erro esperado de cada ponto alarga o alcance dele (ver buildArea); 0 = nada
  areaErrConfMin: 0.3, // confiança abaixo disto conta como esta (erro esperado de 2,3 m): o alcance não cresce sem limite
  collapsedM: 0.3, // nuvem com raio (rms) menor que isto: o solucionador não achou forma nenhuma
  pointR: 0.6, // quem fez uma varredura num lugar ocupou pelo menos este raio (m)
  pointW: 0.6, // peso de uma varredura, em metros de caminho
  closeR: 1.2, // fecha vãos mais estreitos que o dobro disto (m)
  holeM2: 10, // buraco menor que isto é miolo de cômodo, não pátio
  speckM2: 1.5,
  bridgeR: 0.4, // meia-largura do corredor que mantém ligado o que foi andado
  lowConf: 0.35, // abaixo disto (relativo ao típico) o ponto não garante área
  confS: 1.0, // alcance da confiança em volta do caminho (m)
  // --- ambientes ---
  roomPosM: 2.0, // 1 unidade de distância = tantos metros...
  roomFpDb: 4.0, // ...ou tantos dB (RMS entre rádios) de diferença na impressão digital
  roomPosCap: 9, // a posição para de pesar depois de 3 unidades: sala grande continua sala
  roomUnitM2: 14, // tamanho típico de um cômodo: dá a "massa" de cada varredura
  roomInitM2: 4, // 1ª etapa: pedaços deste tamanho
  roomEdgeHi: 6, // acima do número típico de ambientes: só fronteira mais forte que isto (x a diferença de dentro) separa
  roomEdgeLo: 1.8, // abaixo dele: só fronteira mais fraca que isto junta
  roomSeedK: 0.5, // peso da distância às marcas quando ambientes com nome disputam um pedaço
  roomM2Lo: 8, // no máximo um ambiente a cada 8 m²...
  roomM2Hi: 24, // ...e no mínimo um a cada 24 m²
  roomKnn: 5,
  roomKnnM: 4,
  roomMinScans: 3,
  roomMinM2: 2,
  roomRefine: 2,
  voteS: 0.9, // alcance do voto de cada varredura na divisão das células (m)
  maxRadios: 40,
  fpClipDb: 15,
  fpSlope: 2.0,
  fpNearM: 1.5,
  fpSmoothIters: 3,
  fpSmoothPosM: 1.2,
  fpSmoothK: 0.5,
  // --- paredes ---
  simplifyM: 0.2,
  doorM: 0.9,
  doorJoinM: 1.2,
  doorMaxStepM: 4.5,
  wallNearM: 2.5,
  wallC0: 3.0, // contraste (dB) em que a divisão começa a merecer confiança
  wallC1: 7.5, // contraste em que a confiança chega a 1
  wallNamed: 0.7, // confiança mínima da divisão entre dois ambientes com nome
  // --- sinal ---
  heatH0: 0.3,
  heatHk: 0.4, // largura do núcleo = heatH0 + heatHk * erro esperado, entre heatHmin e heatHmax
  heatHmin: 0.7,
  heatHmax: 1.2,
  heatWide: 3, // núcleo largo (x a largura) que preenche longe das medições
  heatWideW: 0.01,
  heatRidge: 1.5,
  heatLinear: 1,
  heatConfK: 1.5,
  heatConfS: 0.8,
  // --- sinal da rede conectada entre as varreduras (survey.track; ver trackSamples) ---
  trackW: 0.5, // peso de uma amostra perante uma varredura (a posição dela é interpolada, não resolvida)
  trackLagS: 1.2, // a lista de uma varredura chega ~1,2 s depois do meio da escuta: é esse o instante da posição
  trackSnapS: 2.5, // sem trecho andado em volta, a amostra vale para a varredura a até isto dela
  trackBinM: 0.5, // amostras no mesmo quadrado deste lado viram uma só (a média)
  trackBinW: 1.5, // peso máximo de um quadrado, por mais amostras que tenha
  trackTopDb: 1.5, // a amostra só entra onde o rádio conectado é o mais forte da rede (com esta folga)
  trackCalMin: 6, // pares amostra x varredura para medir a diferença entre os dois medidores
  trackMaxGapS: 8, // só interpola a posição entre duas varreduras separadas por até isto (s)
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const brNum = (v, digits = 0) => (isNum(v) ? v.toFixed(digits).replace('.', ',') : '–');

function quantileSorted(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values) {
  return quantileSorted(Array.from(values).sort((a, b) => a - b), 0.5);
}

function bandOf(freq) {
  if (!isNum(freq) || freq < 3000) return 0;
  return freq < 5925 ? 1 : 2;
}

function distToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

// ---------------------------------------------------------------------------
// Preparo: caminho, leituras frescas, rádios, redes
// ---------------------------------------------------------------------------

function prepare(survey, solution, opts, tune) {
  const scans = Array.isArray(survey.scans) ? survey.scans : [];
  const pts = Array.isArray(solution.points) ? solution.points : [];
  const meta = survey.aps && typeof survey.aps === 'object' ? survey.aps : {};
  const solAps = solution.aps && typeof solution.aps === 'object' ? solution.aps : {};

  const path = [];
  for (let i = 0; i < scans.length; i++) {
    const s = scans[i];
    const p = pts[i];
    if (!s || !p || !isNum(p.x) || !isNum(p.y) || Math.abs(p.x) > 1e6 || Math.abs(p.y) > 1e6) continue;
    const floor = isNum(s.floor) ? Math.round(s.floor) : 0;
    const t = isNum(s.t) ? s.t : path.length ? path[path.length - 1].t + 3.5 : 0;
    path.push({ i, t, x: p.x, y: p.y, z: floor * FLOOR_HEIGHT, floor, conf: isNum(p.conf) ? clamp(p.conf, 0, 1) : 0.5, still: !!s.still });
  }
  const P = path.length;

  // Peso relativo de cada ponto: cada solucionador tem a sua escala de confiança, então o
  // que conta é estar bem abaixo do típico DESTE levantamento.
  const confSorted = path.map((p) => p.conf).sort((a, b) => a - b);
  const confRef = P ? quantileSorted(confSorted, 0.75) : 0;
  const weight = new Float32Array(P);
  for (let k = 0; k < P; k++) weight[k] = confRef > 1e-6 ? clamp(path[k].conf / confRef, 0, 1) : 1;

  // BSSIDs ouvidos (em qualquer varredura) e as leituras frescas de cada ponto do caminho.
  const bssids = [];
  const bssidIndex = new Map();
  const bssidOf = (id, freq) => {
    let b = bssidIndex.get(id);
    if (b === undefined) {
      const m = meta[id] && typeof meta[id] === 'object' ? meta[id] : {};
      b = bssids.length;
      bssidIndex.set(id, b);
      bssids.push({
        id,
        ssid: typeof m.ssid === 'string' ? m.ssid : '',
        freq: isNum(m.freq) ? m.freq : isNum(freq) ? freq : 2437,
        device: typeof m.device === 'string' && m.device ? m.device : id,
        best: -Infinity,
        heard: 0,
      });
    }
    return b;
  };
  const allRssi = [];
  const fresh = new Array(P); // por ponto: [índice do BSSID, rssi, ...]
  const pathOfScan = new Int32Array(scans.length).fill(-1);
  for (let k = 0; k < P; k++) pathOfScan[path[k].i] = k;
  for (let i = 0; i < scans.length; i++) {
    const list = scans[i] && Array.isArray(scans[i].readings) ? scans[i].readings : [];
    const k = pathOfScan[i];
    const mine = k >= 0 ? (fresh[k] = []) : null;
    for (const r of list) {
      if (!r || typeof r.id !== 'string' || !isNum(r.rssi)) continue;
      const b = bssidOf(r.id, r.freq);
      const rssi = clamp(r.rssi, -120, 0);
      if (rssi > bssids[b].best) bssids[b].best = rssi;
      if (isNum(r.ageMs) && r.ageMs > STALE_MS) continue;
      allRssi.push(rssi);
      if (mine) {
        mine.push(b, rssi);
        bssids[b].heard++;
      }
    }
  }
  allRssi.sort((a, b) => a - b);
  // Piso de detecção deste celular: "não ouviu" vale um pouco abaixo do mais fraco que ele ouve.
  const floorDbm = allRssi.length ? clamp(quantileSorted(allRssi, 0.02), -97, -80) : -90;
  const missDbm = floorDbm - 2;

  // Redes: BSSIDs com o mesmo nome; rede oculta fica por aparelho.
  const own = new Set(Array.isArray(opts.own) ? opts.own.filter((s) => typeof s === 'string') : []);
  const ownLower = new Set([...own].map((s) => s.toLowerCase()));
  const isOwnBssid = (id) => own.has(id) || ownLower.has(id.toLowerCase());
  const nets = [];
  const netIndex = new Map();
  for (const b of bssids) {
    const key = b.ssid ? `s:${b.ssid}` : `h:${b.device}`;
    let n = netIndex.get(key);
    if (n === undefined) {
      n = nets.length;
      netIndex.set(key, n);
      nets.push({ key, ssid: b.ssid, own: false, bssids: [], bestRssi: -Infinity, explicit: false });
    }
    b.net = n;
    nets[n].bssids.push(b.id);
    if (b.best > nets[n].bestRssi) nets[n].bestRssi = b.best;
    if (isOwnBssid(b.id)) nets[n].explicit = true;
  }
  // Da casa: a rede marcada, os aparelhos que a anunciam (malha) e as outras redes que só
  // existem nesses aparelhos (5 GHz com outro nome, rede de convidados).
  const ownDevices = new Set();
  for (const b of bssids) if (isOwnBssid(b.id) || (b.ssid && nets[b.net].explicit)) ownDevices.add(b.device);
  for (const n of nets) n.own = n.explicit;
  // os aparelhos de cada rede, juntados numa passada só (filtrar a lista inteira de BSSIDs para
  // cada rede custa o quadrado: com milhares de redes de um arquivo hostil, segundos de tela parada)
  const devsOfNet = nets.map(() => []);
  for (const b of bssids) devsOfNet[b.net].push(b.device);
  nets.forEach((n, ni) => {
    if (n.own) return;
    const devs = devsOfNet[ni];
    if (devs.length && devs.every((d) => ownDevices.has(d))) n.own = true;
  });

  // Sinal de cada rede em cada ponto: o mais forte entre os BSSIDs dela (NaN = não ouviu).
  const netDbm = nets.map(() => new Float32Array(P).fill(NaN));
  for (let k = 0; k < P; k++) {
    const list = fresh[k];
    for (let j = 0; j < list.length; j += 2) {
      const arr = netDbm[bssids[list[j]].net];
      if (!(arr[k] >= list[j + 1])) arr[k] = list[j + 1];
    }
  }

  // Rádios (aparelho + faixa): a unidade da impressão digital. Redes do mesmo rádio medem
  // a mesma coisa, então entram como uma só.
  const radioIndex = new Map();
  const radios = [];
  for (const b of bssids) {
    const key = `${b.device}|${bandOf(b.freq)}`;
    let r = radioIndex.get(key);
    if (r === undefined) {
      r = radios.length;
      radioIndex.set(key, r);
      radios.push({ key, device: b.device, bssids: [], heard: 0 });
    }
    b.radio = r;
    radios[r].bssids.push(b.id);
  }

  // Solução que colapsou (todos os pontos no mesmo lugar): não há nuvem cujo tamanho corrigir.
  let spread = 0;
  if (P) {
    const mx = path.reduce((s, p) => s + p.x, 0) / P;
    const my = path.reduce((s, p) => s + p.y, 0) / P;
    spread = Math.sqrt(path.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / P);
  }
  const collapsed = P >= 4 && spread < tune.collapsedM;

  const floorNumbers = [...new Set(path.map((p) => p.floor))].sort((a, b) => a - b);
  const dts = [];
  for (let k = 1; k < P; k++) if (path[k].t > path[k - 1].t) dts.push(path[k].t - path[k - 1].t);
  const cadence = dts.length ? median(dts) : 3.5;

  return { survey, scans, path, P, weight, bssids, bssidIndex, fresh, nets, netDbm, radios, solAps, floorDbm, missDbm, floorNumbers, cadence, ownDevices, tune, spread, collapsed };
}

// Impressão digital de cada ponto: o sinal de cada rádio, centrado na média dele (não ouvido =
// piso de detecção). Sem tirar a queda com a distância: na bancada, descontar uma curva
// ajustada apaga justamente o degrau que a parede deixa.
function fingerprints(ctx) {
  const { path, P, fresh, bssids, radios, solAps, missDbm, tune } = ctx;
  const R0 = radios.length;
  const sum = new Float32Array(P * R0);
  const cnt = new Uint8Array(P * R0);
  for (let k = 0; k < P; k++) {
    const list = fresh[k];
    for (let j = 0; j < list.length; j += 2) {
      const r = bssids[list[j]].radio;
      sum[k * R0 + r] += list[j + 1];
      if (cnt[k * R0 + r] < 255) cnt[k * R0 + r]++;
    }
  }
  for (let r = 0; r < R0; r++) {
    let h = 0;
    for (let k = 0; k < P; k++) if (cnt[k * R0 + r]) h++;
    radios[r].heard = h;
  }
  // Só os rádios ouvidos com alguma frequência, os mais presentes primeiro.
  const minHeard = Math.max(3, Math.ceil(0.06 * P));
  const use = radios
    .map((r, i) => i)
    .filter((i) => radios[i].heard >= minHeard)
    .sort((a, b) => radios[b].heard - radios[a].heard || a - b)
    .slice(0, tune.maxRadios);
  const R = use.length;
  const feat = new Float32Array(P * R);
  const radioW = new Float32Array(R);
  let wsum = 0;
  for (let q = 0; q < R; q++) {
    const r = use[q];
    radioW[q] = Math.min(1, radios[r].heard / (0.5 * P));
    wsum += radioW[q];
    // Rádio com posição resolvida: tira a queda de espaço livre com a distância (inclinação
    // FIXA, da física; ajustada aos dados ela engoliria o degrau das paredes). Sobra parede + sombra.
    let ap = null;
    if (tune.fpSlope > 0) {
      for (const id of radios[r].bssids) {
        const a = solAps[id];
        if (a && isNum(a.x) && isNum(a.y) && (!ap || (isNum(a.conf) ? a.conf : 0) > (isNum(ap.conf) ? ap.conf : 0))) ap = a;
      }
    }
    const value = (k) => {
      let v = cnt[k * R0 + r] ? sum[k * R0 + r] / cnt[k * R0 + r] : missDbm;
      if (ap) {
        const dz = isNum(ap.z) ? ap.z - (path[k].z + PHONE_HEIGHT) : 0;
        v += 10 * tune.fpSlope * Math.log10(Math.max(tune.fpNearM, Math.hypot(ap.x - path[k].x, ap.y - path[k].y, dz)));
      }
      return v;
    };
    let mean = 0;
    for (let k = 0; k < P; k++) mean += value(k);
    mean /= P;
    for (let k = 0; k < P; k++) feat[k * R + q] = clamp(value(k) - mean, -tune.fpClipDb, tune.fpClipDb);
  }
  ctx.feat = feat;
  ctx.R = R;
  ctx.radioW = radioW;
  ctx.radioWsum = wsum || 1;
}

// ---------------------------------------------------------------------------
// Grade
// ---------------------------------------------------------------------------

function makeGrid(ctx, opts, tune) {
  const { path } = ctx;
  let cell = isNum(opts.cell) ? clamp(opts.cell, 0.2, 0.5) : tune.cell;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of path) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!path.length) {
    minX = minY = -1;
    maxX = maxY = 1;
  }
  // Solução absurda (pontos a quilômetros): a grade fica em volta do miolo.
  if (maxX - minX > tune.maxSpanM || maxY - minY > tune.maxSpanM) {
    const mx = median(path.map((p) => p.x));
    const my = median(path.map((p) => p.y));
    minX = Math.max(minX, mx - tune.maxSpanM / 2);
    maxX = Math.min(maxX, mx + tune.maxSpanM / 2);
    minY = Math.max(minY, my - tune.maxSpanM / 2);
    maxY = Math.min(maxY, my + tune.maxSpanM / 2);
  }
  // Margem: cabe o alcance do ponto mais incerto e a dilatação do fechamento inteira, com folga.
  let reach = 1;
  for (const p of path) reach = Math.max(reach, reachGain(ctx, p.conf));
  const m = Math.max(tune.marginM, tune.areaR * reach + tune.closeR + 0.6);
  const w = maxX - minX + 2 * m;
  const h = maxY - minY + 2 * m;
  if ((w / cell) * (h / cell) > tune.maxCells) cell = clamp(Math.ceil(Math.sqrt((w * h) / tune.maxCells) / 0.05) * 0.05, cell, 0.5);
  cell = Math.round(cell * 1000) / 1000;
  const x0 = Math.floor((minX - m) / cell) * cell;
  const y0 = Math.floor((minY - m) / cell) * cell;
  const nx = Math.max(8, Math.ceil((maxX + m - x0) / cell));
  const ny = Math.max(8, Math.ceil((maxY + m - y0) / cell));
  return { cell, nx, ny, minX: x0, minY: y0, maxX: x0 + nx * cell, maxY: y0 + ny * cell, size: nx * ny };
}

const cellX = (grid, ix) => grid.minX + (ix + 0.5) * grid.cell;
const cellY = (grid, iy) => grid.minY + (iy + 0.5) * grid.cell;

function cellAt(grid, x, y) {
  const ix = Math.floor((x - grid.minX) / grid.cell);
  const iy = Math.floor((y - grid.minY) / grid.cell);
  if (ix < 0 || iy < 0 || ix >= grid.nx || iy >= grid.ny) return -1;
  return iy * grid.nx + ix;
}

// Visita as células a até `radius` de (x, y): fn(índice, distância²).
function forCellsNear(grid, x, y, radius, fn) {
  const { cell, nx, ny, minX, minY } = grid;
  const i0 = Math.max(0, Math.floor((x - radius - minX) / cell));
  const i1 = Math.min(nx - 1, Math.floor((x + radius - minX) / cell));
  const j0 = Math.max(0, Math.floor((y - radius - minY) / cell));
  const j1 = Math.min(ny - 1, Math.floor((y + radius - minY) / cell));
  const r2 = radius * radius;
  for (let j = j0; j <= j1; j++) {
    const dy = minY + (j + 0.5) * cell - y;
    for (let i = i0; i <= i1; i++) {
      const dx = minX + (i + 0.5) * cell - x;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) fn(j * nx + i, d2);
    }
  }
}

// Espalha um núcleo gaussiano em volta de (x, y): soma (max = false) ou máximo (max = true).
// É o laço mais quente do construtor, por isso não usa forCellsNear (sem função por chamada).
function splat(grid, out, x, y, radius, w, twoS2, max) {
  const { cell, nx, ny, minX, minY } = grid;
  const i0 = Math.max(0, Math.floor((x - radius - minX) / cell));
  const i1 = Math.min(nx - 1, Math.floor((x + radius - minX) / cell));
  const j0 = Math.max(0, Math.floor((y - radius - minY) / cell));
  const j1 = Math.min(ny - 1, Math.floor((y + radius - minY) / cell));
  const r2 = radius * radius;
  for (let j = j0; j <= j1; j++) {
    const dy = minY + (j + 0.5) * cell - y;
    for (let i = i0; i <= i1; i++) {
      const dx = minX + (i + 0.5) * cell - x;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const v = w * Math.exp(-d2 / twoS2);
      const c = j * nx + i;
      if (!max) out[c] += v;
      else if (v > out[c]) out[c] = v;
    }
  }
}

// Distância euclidiana ao quadrado (em células) até a célula marcada mais próxima
// (Felzenszwalb e Huttenlocher: envelope inferior de parábolas, linha a linha).
function distanceTransform(src, nx, ny) {
  const INF = 1e12;
  const out = new Float64Array(nx * ny);
  const n = Math.max(nx, ny);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const pass = (len) => {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) f[y] = src[y * nx + x] ? 0 : INF;
    pass(ny);
    for (let y = 0; y < ny; y++) out[y * nx + x] = d[y];
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) f[x] = out[y * nx + x];
    pass(nx);
    for (let x = 0; x < nx; x++) out[y * nx + x] = d[x];
  }
  return out;
}

// Rotula regiões ligadas pelos 4 vizinhos. `same(a, b)` diz se duas células vizinhas são da mesma região.
function components(grid, member, same) {
  const { nx, ny, size } = grid;
  const label = new Int32Array(size).fill(-1);
  const sizes = [];
  const stack = [];
  const nbs = [0, 0, 0, 0];
  for (let c = 0; c < size; c++) {
    if (!member(c) || label[c] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    label[c] = id;
    stack.push(c);
    while (stack.length) {
      const cur = stack.pop();
      n++;
      const ix = cur % nx;
      const iy = (cur - ix) / nx;
      nbs[0] = ix > 0 ? cur - 1 : -1;
      nbs[1] = ix < nx - 1 ? cur + 1 : -1;
      nbs[2] = iy > 0 ? cur - nx : -1;
      nbs[3] = iy < ny - 1 ? cur + nx : -1;
      for (let q = 0; q < 4; q++) {
        const nb = nbs[q];
        if (nb < 0 || label[nb] >= 0 || !member(nb) || (same && !same(cur, nb))) continue;
        label[nb] = id;
        stack.push(nb);
      }
    }
    sizes.push(n);
  }
  return { label, sizes };
}

// ---------------------------------------------------------------------------
// Área de um andar
// ---------------------------------------------------------------------------

// Quanto o alcance de um ponto cresce (x areaR) por causa do erro esperado dele; ver buildArea.
function reachGain(ctx, conf) {
  const { tune } = ctx;
  if (!(tune.areaErr > 0) || ctx.collapsed) return 1;
  const e2 = CONF_HALF_M * CONF_HALF_M * (1 / clamp(conf, tune.areaErrConfMin, 1) - 1);
  return Math.sqrt(1 + (tune.areaErr * e2) / (tune.areaR * tune.areaR));
}

// Dois pontos seguidos do caminho foram ligados andando? (mesmo andar, sem salto impossível)
function walked(ctx, a, b) {
  const p = ctx.path[a];
  const q = ctx.path[b];
  if (p.floor !== q.floor) return false;
  const dt = q.t - p.t;
  if (dt > Math.max(2.5 * ctx.cadence, 12)) return false;
  return Math.hypot(q.x - p.x, q.y - p.y) <= 1.3 * Math.max(0, dt) + 2.5;
}

function buildArea(ctx, grid, members) {
  const { path, weight, tune } = ctx;
  const { nx, ny, size, cell } = grid;
  const dens = new Float32Array(size);
  const conf = new Float32Array(size);
  const h2 = 2 * tune.areaH * tune.areaH;
  const c2 = 2 * tune.confS * tune.confS;
  // TAMANHO. A nuvem de pontos do solucionador é menor do que a casa, e isso não é defeito dele: cada
  // posição é a melhor aposta para aquela varredura, e a melhor aposta de um ponto incerto fica sempre
  // mais perto do meio do que o ponto de verdade. Vale a decomposição da variância de quem estima pela
  // média condicional,
  //
  //     espalhamento real² = espalhamento estimado² + erro²
  //
  // ou, dito para a área: os lugares onde a pessoa ESTEVE são os lugares estimados borrados pelo erro
  // de cada um. Por isso o alcance de um ponto não é só o corpo de quem anda (`areaR`): soma, em
  // quadratura, o erro esperado ali. O erro vem da própria solução — a confiança do ponto é
  // conf = 1 / (1 + (e / 1,5)²), com e = erro MEDIANO esperado — e um erro gaussiano no plano com essa
  // mediana tem média quadrática e² x 1,44 (`areaErr` = 1 / ln 2; nada aqui foi ajustado aos cenários):
  //
  //     alcance² = areaR² + 1,44 x e²
  //
  // O ponto mais incerto alcança mais longe, mas com a mesma "massa" (a densidade dele fica mais
  // rala): sozinho continua sem garantir área; onde há muitos, a borda avança. Posição exata
  // (confiança 1) não muda nada. Na bancada, com o solucionador de verdade, a área estimada passou de
  // 0,65 para 0,95 da real (0,68 -> 0,99 em casas que não serviram de ajuste) e a sobreposição com a
  // planta (IoU) de 0,55 para 0,64, sem mexer na posição de nenhum ponto nem dos roteadores. O que a
  // conta não conserta é a escala de um mapa só (±15%) nem lugar grande que todo motor encolhe
  // (escritório de 20 x 14 m: 0,55). A CONFIANÇA de cada célula continua medindo a distância ao
  // caminho estimado, então a faixa que entrou só por causa da incerteza aparece como incerta.
  const reachOf = (k) => reachGain(ctx, path[k].conf);
  const near = new Float32Array(size); // alcance: como `conf`, com o núcleo de cada ponto alargado pelo erro dele
  const mark = (x, y, wDens, wConf, g) => {
    if (wDens > 0) splat(grid, dens, x, y, 3 * tune.areaH * g, wDens / g, h2 * g * g, false);
    if (wConf > 0) {
      splat(grid, conf, x, y, 2.6 * tune.confS, wConf, c2, true);
      splat(grid, near, x, y, 2.6 * tune.confS * g, wConf, c2 * g * g, true);
    }
  };

  // Densidade do caminho: cada varredura e cada metro andado entre duas varreduras seguidas.
  // Ponto de pouca confiança pesa pouco: sozinho não passa do limiar e a área não incha.
  const links = [];
  for (let m = 0; m < members.length; m++) {
    const k = members[m];
    const g = reachOf(k);
    mark(path[k].x, path[k].y, tune.pointW * weight[k], weight[k], g);
    const next = members[m + 1];
    if (next === undefined || next !== k + 1 || !walked(ctx, k, next)) continue;
    links.push(k);
    const p = path[k];
    const q = path[next];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const steps = Math.ceil(len / cell);
    if (steps < 1) continue;
    // Trecho comprido (varredura lenta): a reta é só um palpite do caminho, vale metade.
    const w = Math.min(weight[k], weight[next]) * (len > 4 ? 0.5 : 1);
    const gLink = 0.5 * (g + reachOf(next));
    for (let s = 0; s < steps; s++) {
      const u = (s + 0.5) / steps;
      mark(p.x + (q.x - p.x) * u, p.y + (q.y - p.y) * u, (w * len) / steps, s % 2 ? w : 0, gLink);
    }
  }
  // Limiar: o que uma passada reta e isolada deixa a `areaR` do eixo (com o núcleo alargado de um
  // ponto incerto e o peso dividido pelo mesmo fator, o limiar é cruzado no alcance dele).
  const tau = Math.sqrt(2 * Math.PI) * tune.areaH * Math.exp(-(tune.areaR * tune.areaR) / h2);
  // Além da densidade, a célula precisa estar ao alcance de onde se passou: passar três vezes
  // pelo mesmo lugar (ou ficar parado nele) é mais certeza, não mais área.
  const reach = Math.exp(-(tune.areaR * tune.areaR) / c2) - 1e-6;
  let mask = new Uint8Array(size);
  for (let c = 0; c < size; c++) if (dens[c] >= tau && near[c] >= reach) mask[c] = 1;
  for (const k of members) {
    if (weight[k] >= tune.lowConf) forCellsNear(grid, path[k].x, path[k].y, tune.pointR, (c) => (mask[c] = 1));
  }

  // Fechamento: junta os dois lados de uma parede, o miolo dos cômodos contornados, as quinas.
  const R = tune.closeR / cell;
  if (R >= 0.5) {
    const d1 = distanceTransform(mask, nx, ny);
    const grown = new Uint8Array(size);
    for (let c = 0; c < size; c++) grown[c] = d1[c] <= R * R ? 0 : 1; // 1 = fora da dilatação
    // A moldura da grade conta como "fora": sem isso, uma dilatação que encostasse na borda
    // não seria desfeita desse lado e a área ganharia uma barriga.
    clearBorder(grown, nx, ny, 1);
    const d2 = distanceTransform(grown, nx, ny);
    for (let c = 0; c < size; c++) if (d2[c] > R * R) mask[c] = 1;
  }
  clearBorder(mask, nx, ny);

  // Buracos pequenos: lugar onde ninguém pisou (mesa, cama), não um pátio.
  const holes = components(grid, (c) => !mask[c]);
  const outsideId = holes.label[0];
  const holeCells = tune.holeM2 / (cell * cell);
  for (let c = 0; c < size; c++) {
    const id = holes.label[c];
    if (id >= 0 && id !== outsideId && holes.sizes[id] < holeCells) mask[c] = 1;
  }

  // Suaviza a borda (maioria numa janela 3x3).
  const smooth = new Uint8Array(size);
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const c = j * nx + i;
      let n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) n += mask[c + dj * nx + di];
      smooth[c] = n >= 5 ? 1 : 0;
    }
  }
  mask = smooth;

  // O que foi andado de A a B continua ligado: corredor fino onde a máscara se partiu.
  let comp = components(grid, (c) => mask[c] === 1);
  let bridged = false;
  // Vale também quando as varreduras do meio do trecho têm pouca confiança e ficaram de fora:
  // liga-se, em linha reta, a última varredura de dentro à próxima, se a caminhada entre as
  // duas não teve salto (cadeia de trechos andados).
  let last = -1;
  for (let m = 0; m < members.length; m++) {
    const k = members[m];
    if (m > 0 && !(members[m - 1] === k - 1 && walked(ctx, k - 1, k))) last = -1;
    const c = cellAt(grid, path[k].x, path[k].y);
    if (c < 0 || !mask[c]) continue;
    if (last >= 0 && comp.label[c] !== comp.label[cellAt(grid, path[last].x, path[last].y)] && k - last <= 8) {
      const p = path[last];
      const q = path[k];
      const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / (0.5 * cell)));
      for (let s = 0; s <= steps; s++) {
        forCellsNear(grid, p.x + ((q.x - p.x) * s) / steps, p.y + ((q.y - p.y) * s) / steps, tune.bridgeR, (cc) => (mask[cc] = 1));
      }
      bridged = true;
    }
    last = k;
  }
  clearBorder(mask, nx, ny);
  if (bridged) comp = components(grid, (c) => mask[c] === 1);

  // Ciscos: pedaço pequeno e sem (quase) nenhuma varredura dentro.
  const hits = new Int32Array(comp.sizes.length);
  for (const k of members) {
    const c = cellAt(grid, path[k].x, path[k].y);
    if (c >= 0 && comp.label[c] >= 0) hits[comp.label[c]]++;
  }
  const speck = tune.speckM2 / (cell * cell);
  // O maior pedaço fica sempre (num levantamento de uma varredura só, ele é o mapa inteiro).
  let biggest = -1;
  for (let id = 0; id < comp.sizes.length; id++) if (biggest < 0 || comp.sizes[id] > comp.sizes[biggest]) biggest = id;
  for (let c = 0; c < size; c++) {
    const id = comp.label[c];
    if (id < 0 || id === biggest) continue;
    if (hits[id] === 0 || (comp.sizes[id] < speck && hits[id] < 2)) mask[c] = 0;
  }

  for (let c = 0; c < size; c++) conf[c] = mask[c] ? clamp(conf[c], 0, 1) : 0;
  return { inside: mask, conf, links };
}

function clearBorder(mask, nx, ny, value = 0) {
  for (let i = 0; i < nx; i++) mask[i] = mask[(ny - 1) * nx + i] = value;
  for (let j = 0; j < ny; j++) mask[j * nx] = mask[j * nx + nx - 1] = value;
}

// ---------------------------------------------------------------------------
// Ambientes: agrupa as varreduras de um andar
// ---------------------------------------------------------------------------

const normLabel = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');

// Suaviza a impressão digital de cada varredura com a das vizinhas PARECIDAS (filtro bilateral
// no grafo das varreduras): dentro de um cômodo o ruído some; através de uma parede a vizinha
// é diferente, pesa pouco, e o degrau fica. Devolve Float32Array(m * R).
function smoothFingerprints(ctx, members) {
  const { path, feat, R, radioW, radioWsum, tune } = ctx;
  const m = members.length;
  let cur = new Float32Array(m * R);
  for (let a = 0; a < m; a++) for (let q = 0; q < R; q++) cur[a * R + q] = feat[members[a] * R + q];
  if (!R || m < 4 || tune.fpSmoothIters <= 0) return cur;
  // Vizinhas: as próximas no plano e as seguintes no tempo (estas estão perto de verdade,
  // mesmo quando o solucionador errou a posição).
  const nb = Array.from({ length: m }, () => []);
  const p2 = 2 * tune.fpSmoothPosM * tune.fpSmoothPosM;
  const reach2 = (2.5 * tune.fpSmoothPosM) ** 2;
  for (let a = 0; a < m; a++) {
    const pa = path[members[a]];
    for (let b = a + 1; b < m; b++) {
      const pb = path[members[b]];
      let d2 = (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2;
      if (b === a + 1 && members[b] === members[a] + 1 && walked(ctx, members[a], members[b])) d2 = Math.min(d2, 1);
      if (d2 > reach2) continue;
      const w = Math.exp(-d2 / p2);
      nb[a].push(b, w);
      nb[b].push(a, w);
    }
  }
  const dist2 = (buf, a, b) => {
    let s = 0;
    for (let q = 0; q < R; q++) {
      const d = buf[a * R + q] - buf[b * R + q];
      s += radioW[q] * d * d;
    }
    return s / radioWsum;
  };
  for (let it = 0; it < tune.fpSmoothIters; it++) {
    // Escala do "parecido": a diferença típica entre vizinhas nesta rodada.
    const all = [];
    for (let a = 0; a < m; a++) for (let j = 0; j < nb[a].length; j += 2) if (nb[a][j] > a) all.push(dist2(cur, a, nb[a][j]));
    if (!all.length) break;
    all.sort((x, y) => x - y);
    const s2 = 2 * Math.max(0.25, quantileSorted(all, 0.5) * tune.fpSmoothK * tune.fpSmoothK);
    const next = new Float32Array(m * R);
    for (let a = 0; a < m; a++) {
      let wsum = 1;
      for (let q = 0; q < R; q++) next[a * R + q] = cur[a * R + q];
      for (let j = 0; j < nb[a].length; j += 2) {
        const b = nb[a][j];
        const w = nb[a][j + 1] * Math.exp(-dist2(cur, a, b) / s2);
        if (w < 1e-4) continue;
        wsum += w;
        for (let q = 0; q < R; q++) next[a * R + q] += w * cur[b * R + q];
      }
      for (let q = 0; q < R; q++) next[a * R + q] /= wsum;
    }
    cur = next;
  }
  return cur;
}

/**
 * Agrupamento hierárquico (Ward) das varreduras de um andar, só entre grupos vizinhos no
 * espaço ou no tempo. Indícios: nome dado pelo usuário (mesmo nome = mesmo ambiente; nomes
 * diferentes nunca se juntam), impressão digital parecida e proximidade.
 * @returns {{assign: Int32Array, groups: {label: string, auto: boolean, first: number}[]}}
 */
function clusterRooms(ctx, members, areaM2, useLabels) {
  const { path, scans, R, radioW, radioWsum, tune } = ctx;
  const m = members.length;
  if (!m) return { assign: new Int32Array(0), groups: [] };
  const sm = smoothFingerprints(ctx, members);

  // Unidades indivisíveis: varreduras do mesmo ponto marcado e pontos com o mesmo nome.
  const parent = new Int32Array(m).map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };
  const bySpot = new Map();
  const spotLabel = new Map();
  for (let a = 0; a < m; a++) {
    const s = scans[path[members[a]].i];
    if (s.spot === null || s.spot === undefined) continue;
    if (bySpot.has(s.spot)) union(a, bySpot.get(s.spot));
    else bySpot.set(s.spot, a);
    const name = normLabel(s.label);
    if (name && !spotLabel.has(s.spot)) spotLabel.set(s.spot, name);
  }
  const labelNames = [];
  const labelKey = new Map();
  const labelFirst = new Map();
  const scanLabel = new Int32Array(m).fill(-1);
  if (useLabels) {
    for (let a = 0; a < m; a++) {
      const s = scans[path[members[a]].i];
      const name = normLabel(s.label) || (s.spot !== null && s.spot !== undefined ? spotLabel.get(s.spot) : '') || '';
      if (!name) continue;
      const key = name.toLowerCase();
      if (!labelKey.has(key)) {
        labelKey.set(key, labelNames.length);
        labelNames.push(name);
        labelFirst.set(key, a);
      }
      scanLabel[a] = labelKey.get(key);
      union(a, labelFirst.get(key));
    }
  }

  // Grupos: tamanho, somas (posição + impressão digital), nome.
  const dim = 2 + R;
  const cn = new Float64Array(m);
  const cs = new Float64Array(m * dim);
  const lab = new Int32Array(m).fill(-1);
  const alive = new Uint8Array(m);
  for (let a = 0; a < m; a++) {
    const g = find(a);
    const k = members[a];
    alive[g] = 1;
    cn[g]++;
    cs[g * dim] += path[k].x;
    cs[g * dim + 1] += path[k].y;
    for (let q = 0; q < R; q++) cs[g * dim + 2 + q] += sm[a * R + q];
    if (scanLabel[a] >= 0) lab[g] = scanLabel[a];
  }
  // Massa de uma varredura em "cômodos típicos": o custo não depende de quantas varreduras
  // couberam em cada lugar (três voltas no mesmo cômodo não o tornam três vezes mais "caro").
  const mass = areaM2 / m / tune.roomUnitM2;
  const sp2 = tune.roomPosM * tune.roomPosM;
  const sf2 = tune.roomFpDb * tune.roomFpDb * radioWsum;
  const dist2 = (a, b) => {
    const na = cn[a];
    const nb = cn[b];
    const dx = cs[a * dim] / na - cs[b * dim] / nb;
    const dy = cs[a * dim + 1] / na - cs[b * dim + 1] / nb;
    let dp = (dx * dx + dy * dy) / sp2;
    if (dp > tune.roomPosCap) dp = tune.roomPosCap + Math.sqrt(dp - tune.roomPosCap + 1) - 1;
    let df = 0;
    for (let q = 0; q < R; q++) {
      const d = cs[a * dim + 2 + q] / na - cs[b * dim + 2 + q] / nb;
      df += radioW[q] * d * d;
    }
    return dp + df / sf2;
  };
  const cost = (a, b) => {
    if (lab[a] >= 0 && lab[b] >= 0 && lab[a] !== lab[b]) return Infinity;
    return ((cn[a] * cn[b]) / (cn[a] + cn[b])) * mass * dist2(a, b);
  };

  // Vizinhança: os mais próximos no plano e o seguinte no tempo.
  const adj = Array.from({ length: m }, () => new Map());
  const link = (a, b) => {
    a = find(a);
    b = find(b);
    if (a === b || adj[a].has(b)) return;
    const c = cost(a, b);
    adj[a].set(b, c);
    adj[b].set(a, c);
  };
  const scanEdges = [];
  const near = [];
  for (let a = 0; a < m; a++) {
    const pa = path[members[a]];
    near.length = 0;
    for (let b = 0; b < m; b++) {
      if (b === a) continue;
      const d = Math.hypot(path[members[b]].x - pa.x, path[members[b]].y - pa.y);
      if (d <= tune.roomKnnM) near.push([d, b]);
    }
    near.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (let j = 0; j < Math.min(tune.roomKnn, near.length); j++) scanEdges.push([a, near[j][1]]);
    if (a + 1 < m && members[a + 1] === members[a] + 1 && walked(ctx, members[a], members[a + 1])) scanEdges.push([a, a + 1]);
  }
  for (const [a, b] of scanEdges) link(a, b);

  let count = 0;
  for (let a = 0; a < m; a++) count += alive[a];
  const merge = (a, b) => {
    // b entra em a (a < b): somas, nome e vizinhos.
    cn[a] += cn[b];
    for (let q = 0; q < dim; q++) cs[a * dim + q] += cs[b * dim + q];
    if (lab[a] < 0) lab[a] = lab[b];
    alive[b] = 0;
    parent[b] = a;
    for (const c of adj[b].keys()) {
      adj[c].delete(b);
      if (c !== a) adj[a].set(c, 0);
    }
    adj[b].clear();
    adj[a].delete(b);
    for (const c of adj[a].keys()) {
      const v = cost(a, c);
      adj[a].set(c, v);
      adj[c].set(a, v);
    }
    count--;
  };
  const cheapest = (only) => {
    let best = Infinity;
    let ba = -1;
    let bb = -1;
    for (let a = 0; a < m; a++) {
      if (!alive[a] || (only && !only(a))) continue;
      for (const [c, v] of adj[a]) {
        const lo = Math.min(a, c);
        const hi = Math.max(a, c);
        if (v < best || (v === best && (lo < ba || (lo === ba && hi < bb)))) {
          best = v;
          ba = lo;
          bb = hi;
        }
      }
    }
    return ba < 0 || best === Infinity ? null : [ba, bb, best];
  };

  // Arestas entre varreduras vizinhas, com a diferença de impressão digital (dB RMS) de cada uma.
  const edgeSeen = new Set();
  const edges = []; // [a, b, dB]
  for (const [a, b] of scanEdges) {
    const key = a < b ? a * m + b : b * m + a;
    if (a === b || edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    let d2 = 0;
    for (let q = 0; q < R; q++) {
      const d = sm[a * R + q] - sm[b * R + q];
      d2 += radioW[q] * d * d;
    }
    edges.push([a, b, Math.sqrt(d2 / radioWsum)]);
  }
  const typical = edges.length ? Math.max(0.5, median(edges.map((e) => e[2]))) : 1;

  // 1ª etapa (Ward): pedaços compactos, bem menores que um cômodo.
  const kMin = Math.max(1, labelNames.length, Math.round(areaM2 / tune.roomM2Hi));
  const kMax = Math.max(kMin, Math.round(areaM2 / tune.roomM2Lo));
  // Com nomes dados pelo usuário, o número típico é o de nomes: o que sobrou sem nome (ponto
  // marcado sem batizar, trecho andando) entra num ambiente com nome, salvo fronteira forte.
  const kMid = labelNames.length >= 2 ? kMin : clamp(Math.round(areaM2 / tune.roomUnitM2), kMin, kMax);
  const kInit = Math.max(kMax, Math.round(areaM2 / tune.roomInitM2));
  while (count > kInit) {
    const pick = cheapest(null);
    if (!pick) break;
    merge(pick[0], pick[1]);
  }
  // Pedaço sem nome e pequeno demais para ser um ambiente: vai para o vizinho mais parecido.
  const tiny = (a) => lab[a] < 0 && (cn[a] < tune.roomMinScans || cn[a] * mass * tune.roomUnitM2 < tune.roomMinM2);
  for (let guard = 0; guard < m; guard++) {
    const pick = cheapest(tiny);
    if (!pick) break;
    merge(pick[0], pick[1]);
  }

  // 2ª etapa: junta pedaços vizinhos pela fronteira mais fraca. Força da fronteira = diferença
  // média de impressão digital nas arestas que a atravessam, relativa à diferença dentro dos
  // dois pedaços. Parede = degrau na fronteira; sala grande = muda aos poucos e acaba junta.
  const intSum = new Float64Array(m);
  const intCnt = new Float64Array(m);
  const cross = Array.from({ length: m }, () => new Map());
  for (const [a, b, w] of edges) {
    const ga = find(a);
    const gb = find(b);
    if (ga === gb) {
      intSum[ga] += w;
      intCnt[ga]++;
      continue;
    }
    for (const [x, y] of [[ga, gb], [gb, ga]]) {
      const e = cross[x].get(y);
      if (e) {
        e[0] += w;
        e[1]++;
      } else cross[x].set(y, [w, 1]);
    }
  }
  // Com nomes no andar, primeiro os ambientes com nome crescem sobre os pedaços sem nome que
  // encostam neles (como uma bacia a partir de cada marca): pedaço sem nome não se junta a
  // outro sem nome antes disso, senão um bloco inteiro iria parar num ambiente só.
  let seeded = labelNames.length >= 2;
  const seeds = labelNames.map(() => []);
  for (let a = 0; a < m; a++) if (scanLabel[a] >= 0) seeds[scanLabel[a]].push(members[a]);
  const strength = (a, b, e) => {
    if (lab[a] >= 0 && lab[b] >= 0 && lab[a] !== lab[b]) return Infinity;
    // Na fase das marcas a referência é o típico do andar, igual para todos: com a diferença
    // "de dentro" de cada um, o ambiente que cresce primeiro passaria a ganhar todas as disputas.
    // Entra também a distância do pedaço às marcas do ambiente: sem contraste de sinal que
    // decida, o pedaço fica com o ambiente cuja marca está mais perto.
    if (seeded) {
      const named = lab[a] >= 0 ? a : b;
      const blob = named === a ? b : a;
      const bx = cs[blob * dim] / cn[blob];
      const by = cs[blob * dim + 1] / cn[blob];
      let d2 = Infinity;
      for (const s of seeds[lab[named]]) d2 = Math.min(d2, (path[s].x - bx) ** 2 + (path[s].y - by) ** 2);
      return e[0] / e[1] / typical + (tune.roomSeedK * Math.sqrt(d2)) / tune.roomPosM;
    }
    // A referência "de dentro" puxa para o típico do andar quando os pedaços têm poucas arestas.
    const inner = (intSum[a] + intSum[b] + 4 * typical) / (intCnt[a] + intCnt[b] + 4);
    return e[0] / e[1] / inner;
  };
  while (count > kMin) {
    let best = Infinity;
    let ba = -1;
    let bb = -1;
    for (let a = 0; a < m; a++) {
      if (!alive[a]) continue;
      for (const [c, e] of cross[a]) {
        if (c < a || (seeded && lab[a] < 0 === lab[c] < 0)) continue;
        const v = strength(a, c, e);
        if (v < best || (v === best && (a < ba || (a === ba && c < bb)))) {
          best = v;
          ba = a;
          bb = c;
        }
      }
    }
    if (seeded && (ba < 0 || best > tune.roomEdgeHi)) {
      seeded = false; // o que sobrou tem fronteira forte com os ambientes com nome: segue a regra geral
      continue;
    }
    if (ba < 0 || best === Infinity) break;
    // Acima do número típico de ambientes só fica separado o que tem fronteira forte; abaixo
    // dele só se junta o que quase não tem fronteira (sala grande, escritório aberto).
    if (count <= kMax && best > (count > kMid ? tune.roomEdgeHi : tune.roomEdgeLo)) break;
    intSum[ba] += intSum[bb] + cross[ba].get(bb)[0];
    intCnt[ba] += intCnt[bb] + cross[ba].get(bb)[1];
    cross[ba].delete(bb);
    for (const [c, e] of cross[bb]) {
      if (c === ba) continue;
      cross[c].delete(bb);
      const mine = cross[ba].get(c);
      if (mine) {
        mine[0] += e[0];
        mine[1] += e[1];
      } else {
        const fresh = [e[0], e[1]];
        cross[ba].set(c, fresh);
        cross[c].set(ba, fresh);
      }
    }
    cross[bb].clear();
    merge(ba, bb);
  }

  const assign = new Int32Array(m);
  for (let a = 0; a < m; a++) assign[a] = find(a);

  // Acerto fino: cada varredura solta fica com o grupo da maioria das vizinhas PARECIDAS com
  // ela (as do outro lado de um degrau pesam pouco). Conserta o que a ordem das junções entortou.
  const nbrs = Array.from({ length: m }, () => []);
  for (const [a, b, w] of edges) {
    const pa = path[members[a]];
    const pb = path[members[b]];
    const d2 = (pa.x - pb.x) ** 2 + (pa.y - pb.y) ** 2;
    const aff = Math.exp(-d2 / 4.5) * Math.exp(-(w * w) / (2 * typical * typical));
    nbrs[a].push(b, aff);
    nbrs[b].push(a, aff);
  }
  const votes = new Map();
  for (let round = 0; round < tune.roomRefine; round++) {
    let moved = 0;
    for (let a = 0; a < m; a++) {
      if (scanLabel[a] >= 0) continue;
      const s = scans[path[members[a]].i];
      if (s.spot !== null && s.spot !== undefined) continue; // o ponto marcado anda junto
      const cur = assign[a];
      if (cn[cur] <= tune.roomMinScans) continue;
      votes.clear();
      for (let j = 0; j < nbrs[a].length; j += 2) {
        const g = assign[nbrs[a][j]];
        votes.set(g, (votes.get(g) || 0) + nbrs[a][j + 1]);
      }
      let best = cur;
      let bestV = (votes.get(cur) || 0) * 1.15; // mudar de grupo exige alguma folga
      for (const [g, v] of votes) {
        if (v > bestV || (v === bestV && g < best && g !== cur)) {
          bestV = v;
          best = g;
        }
      }
      if (best === cur) continue;
      cn[cur]--;
      cn[best]++;
      assign[a] = best;
      moved++;
    }
    if (!moved) break;
  }

  // Compacta os índices, na ordem em que cada ambiente foi visitado pela primeira vez.
  const remap = new Map();
  const groups = [];
  for (let a = 0; a < m; a++) {
    const g = assign[a];
    if (!remap.has(g)) {
      remap.set(g, groups.length);
      groups.push({ label: lab[g] >= 0 ? labelNames[lab[g]] : '', auto: lab[g] < 0, first: members[a] });
    }
    assign[a] = remap.get(g);
  }
  return { assign, groups };
}

// Quantos nomes distintos o usuário deu aos lugares de um andar (pela mesma regra de clusterRooms).
function namedPlaces(ctx, members) {
  const { path, scans } = ctx;
  const names = new Set();
  for (const k of members) {
    const name = normLabel(scans[path[k].i].label);
    if (name) names.add(name.toLowerCase());
  }
  return names.size;
}

// Dá um ambiente a cada célula de dentro: voto das varreduras próximas e, onde nenhuma
// alcança, o ambiente mais perto andando por dentro da área (não atravessa o lado de fora).
function assignCells(ctx, grid, inside, members, assign, groups) {
  const { path, weight, scans, tune } = ctx;
  const { nx, ny, size, cell } = grid;
  const room = new Int16Array(size).fill(-1);
  const K = groups.length;
  if (!K) return { room, kept: [] };
  const best = new Float32Array(size);
  const score = new Float32Array(size);
  const v2 = 2 * tune.voteS * tune.voteS;
  for (let g = 0; g < K; g++) {
    score.fill(0);
    for (let a = 0; a < members.length; a++) {
      if (assign[a] !== g) continue;
      const k = members[a];
      const w = 0.2 + 0.8 * weight[k];
      splat(grid, score, path[k].x, path[k].y, 3 * tune.voteS, w, v2, false);
    }
    for (let c = 0; c < size; c++) {
      if (inside[c] && score[c] > best[c] && score[c] > 1e-4) {
        best[c] = score[c];
        room[c] = g;
      }
    }
  }
  const pending = () => {
    for (let c = 0; c < size; c++) if (inside[c] && room[c] < 0) return true;
    return false;
  };
  // Enche o que faltou a partir do que já tem dono (em largura: o mais perto por dentro).
  const flood = () => {
    let queue = [];
    for (let c = 0; c < size; c++) if (room[c] >= 0) queue.push(c);
    while (queue.length) {
      const next = [];
      for (const cur of queue) {
        const ix = cur % nx;
        for (let q = 0; q < 4; q++) {
          const nb = q === 0 ? (ix > 0 ? cur - 1 : -1) : q === 1 ? (ix < nx - 1 ? cur + 1 : -1) : q === 2 ? cur - nx : cur + nx;
          if (nb < 0 || nb >= size || !inside[nb] || room[nb] >= 0) continue;
          room[nb] = room[cur];
          next.push(nb);
        }
      }
      queue = next;
    }
    // Pedaço da área sem nenhuma varredura ao alcance: vale a varredura mais próxima em linha reta.
    if (pending()) {
      for (let c = 0; c < size; c++) {
        if (!inside[c] || room[c] >= 0) continue;
        const x = cellX(grid, c % nx);
        const y = cellY(grid, Math.floor(c / nx));
        let bd = Infinity;
        for (let a = 0; a < members.length; a++) {
          const d = (path[members[a]].x - x) ** 2 + (path[members[a]].y - y) ** 2;
          if (d < bd) {
            bd = d;
            room[c] = assign[a];
          }
        }
      }
    }
  };
  flood();

  // Filtro de maioria: tira o serrilhado e as ilhas de uma célula.
  for (let passN = 0; passN < 2; passN++) {
    const copy = room.slice();
    const votes = new Int32Array(K);
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const c = j * nx + i;
        if (!inside[c]) continue;
        let top = -1;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const r = copy[c + dj * nx + di];
            if (r < 0) continue;
            votes[r]++;
            if (top < 0 || votes[r] > votes[top] || (votes[r] === votes[top] && r < top)) top = r;
          }
        }
        if (top >= 0 && votes[top] >= 5) room[c] = top;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (copy[c + dj * nx + di] >= 0) votes[copy[c + dj * nx + di]] = 0;
      }
    }
  }

  // Cada ambiente é um pedaço só: sobras soltas e ambientes minúsculos vão para o vizinho.
  // Exceção: pedaço onde o usuário marcou um ponto com o nome do ambiente.
  const minCells = tune.roomMinM2 / (cell * cell);
  for (let round = 0; round < 3; round++) {
    const comp = components(grid, (c) => room[c] >= 0, (a, b) => room[a] === room[b]);
    const main = new Int32Array(K).fill(-1);
    const compRoom = new Int32Array(comp.sizes.length).fill(-1);
    for (let c = 0; c < size; c++) if (comp.label[c] >= 0) compRoom[comp.label[c]] = room[c];
    for (let id = 0; id < comp.sizes.length; id++) {
      const g = compRoom[id];
      if (main[g] < 0 || comp.sizes[id] > comp.sizes[main[g]]) main[g] = id;
    }
    const keep = new Uint8Array(comp.sizes.length);
    for (let g = 0; g < K; g++) if (main[g] >= 0 && (comp.sizes[main[g]] >= minCells || !groups[g].auto || K === 1)) keep[main[g]] = 1;
    for (let a = 0; a < members.length; a++) {
      const g = assign[a];
      if (groups[g].auto || !normLabel(scans[path[members[a]].i].label)) continue;
      const c = cellAt(grid, path[members[a]].x, path[members[a]].y);
      if (c >= 0 && comp.label[c] >= 0 && compRoom[comp.label[c]] === g) keep[comp.label[c]] = 1;
    }
    if (!keep.some((v) => v)) keep[comp.sizes.indexOf(Math.max(...comp.sizes))] = 1;
    let dropped = 0;
    for (let c = 0; c < size; c++) {
      if (comp.label[c] >= 0 && !keep[comp.label[c]]) {
        room[c] = -1;
        dropped++;
      }
    }
    if (!dropped) break;
    flood();
  }

  // Ambientes que sobraram, com índices compactos.
  const seen = new Uint8Array(K);
  for (let c = 0; c < size; c++) if (room[c] >= 0) seen[room[c]] = 1;
  const index = new Int32Array(K).fill(-1);
  const kept = [];
  for (let g = 0; g < K; g++) {
    if (!seen[g]) continue;
    index[g] = kept.length;
    kept.push(g);
  }
  for (let c = 0; c < size; c++) if (room[c] >= 0) room[c] = index[room[c]];
  return { room, kept };
}

// ---------------------------------------------------------------------------
// Contorno e divisões
// ---------------------------------------------------------------------------

// Contorno da máscara pelas arestas das células (o "marching squares" de uma imagem binária).
// Devolve anéis de vértices da malha, a área sempre à esquerda: de fora no sentido
// anti-horário, buracos no horário. Vértice = vy * (nx + 1) + vx.
function traceRings(mask, nx, ny) {
  const W = nx + 1;
  const out = new Uint8Array(W * (ny + 1)); // bits: 1 leste, 2 norte, 4 oeste, 8 sul
  const at = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && mask[j * nx + i] === 1;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!mask[j * nx + i]) continue;
      if (!at(i, j - 1)) out[j * W + i] |= 1;
      if (!at(i + 1, j)) out[j * W + i + 1] |= 2;
      if (!at(i, j + 1)) out[(j + 1) * W + i + 1] |= 4;
      if (!at(i - 1, j)) out[(j + 1) * W + i] |= 8;
    }
  }
  const step = [1, W, -1, -W];
  const rings = [];
  for (let v0 = 0; v0 < out.length; v0++) {
    while (out[v0]) {
      let d0 = 0;
      while (!(out[v0] & (1 << d0))) d0++;
      const ring = [];
      let v = v0;
      let d = d0;
      for (let guard = 0; guard < 4 * out.length; guard++) {
        ring.push(v);
        out[v] &= ~(1 << d);
        v += step[d];
        // De volta ao começo, a aresta inicial conta como livre: o anel fecha quando ela é a escolhida.
        const avail = v === v0 ? out[v] | (1 << d0) : out[v];
        // Na quina ambígua (duas células em diagonal) vira à esquerda: os anéis se tocam, não se cruzam.
        const left = (d + 1) & 3;
        const right = (d + 3) & 3;
        let nd = -1;
        if (avail & (1 << left)) nd = left;
        else if (avail & (1 << d)) nd = d;
        else if (avail & (1 << right)) nd = right;
        if (nd < 0 || (v === v0 && nd === d0)) break;
        d = nd;
      }
      if (ring.length >= 4) rings.push(ring);
    }
  }
  return rings;
}

// Douglas-Peucker num trecho aberto de pontos [[x, y], ...]; marca em `keep` os que ficam.
function simplifyRange(pts, a, b, eps, keep) {
  const stack = [a, b];
  while (stack.length) {
    const j = stack.pop();
    const i = stack.pop();
    let worst = 0;
    let wi = -1;
    for (let k = i + 1; k < j; k++) {
      const d = distToSegment(pts[k][0], pts[k][1], pts[i][0], pts[i][1], pts[j][0], pts[j][1]);
      if (d > worst) {
        worst = d;
        wi = k;
      }
    }
    if (wi >= 0 && worst > eps) {
      keep[wi] = 1;
      stack.push(i, wi, wi, j);
    }
  }
}

function simplifyOpen(pts, eps) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  simplifyRange(pts, 0, pts.length - 1, eps, keep);
  return pts.filter((_, i) => keep[i]);
}

// Anel fechado: âncoras nos vértices fixos (junções com divisões internas) ou, sem eles,
// em dois vértices opostos; cada trecho entre âncoras é simplificado separado.
function simplifyRing(pts, eps, fixed) {
  const n = pts.length;
  if (n <= 4) return pts.slice();
  const anchors = [];
  for (let i = 0; i < n; i++) if (fixed && fixed[i]) anchors.push(i);
  if (anchors.length < 2) {
    let a = anchors.length ? anchors[0] : 0;
    if (!anchors.length) for (let i = 1; i < n; i++) if (pts[i][0] < pts[a][0] || (pts[i][0] === pts[a][0] && pts[i][1] < pts[a][1])) a = i;
    let b = a;
    let far = -1;
    for (let i = 0; i < n; i++) {
      const d = (pts[i][0] - pts[a][0]) ** 2 + (pts[i][1] - pts[a][1]) ** 2;
      if (d > far) {
        far = d;
        b = i;
      }
    }
    anchors.length = 0;
    anchors.push(Math.min(a, b), Math.max(a, b));
  }
  const out = [];
  for (let q = 0; q < anchors.length; q++) {
    const from = anchors[q];
    const to = anchors[(q + 1) % anchors.length];
    const span = [];
    for (let i = from; ; i = (i + 1) % n) {
      span.push(pts[i]);
      if (i === to && span.length > 1) break;
      if (span.length > n + 1) break;
    }
    const s = simplifyOpen(span, eps);
    for (let i = 0; i < s.length - 1; i++) out.push(s[i]);
  }
  return out;
}

// Fronteiras entre ambientes: para cada par de vizinhos, as arestas de célula que os separam,
// encadeadas em linhas. Devolve [{a, b, verts: [vértices da malha]}].
function roomBoundaries(room, nx, ny) {
  const W = nx + 1;
  const pairs = new Map(); // "a|b" -> Map(vértice -> [vizinhos])
  const add = (a, b, v1, v2) => {
    const key = a < b ? a * 32768 + b : b * 32768 + a;
    let g = pairs.get(key);
    if (!g) pairs.set(key, (g = new Map()));
    if (!g.has(v1)) g.set(v1, []);
    if (!g.has(v2)) g.set(v2, []);
    g.get(v1).push(v2);
    g.get(v2).push(v1);
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const r = room[j * nx + i];
      if (r < 0) continue;
      if (i + 1 < nx) {
        const e = room[j * nx + i + 1];
        if (e >= 0 && e !== r) add(r, e, j * W + i + 1, (j + 1) * W + i + 1);
      }
      if (j + 1 < ny) {
        const n = room[(j + 1) * nx + i];
        if (n >= 0 && n !== r) add(r, n, (j + 1) * W + i, (j + 1) * W + i + 1);
      }
    }
  }
  const chains = [];
  for (const key of [...pairs.keys()].sort((p, q) => p - q)) {
    const g = pairs.get(key);
    const a = Math.floor(key / 32768);
    const b = key % 32768;
    const used = new Set();
    const edgeKey = (u, v) => (u < v ? u * 4194304 + v : v * 4194304 + u);
    const walk = (start, second) => {
      const verts = [start, second];
      used.add(edgeKey(start, second));
      let prev = start;
      let cur = second;
      for (;;) {
        const nbs = g.get(cur);
        if (nbs.length !== 2) break; // ponta ou encontro de linhas
        const next = nbs[0] === prev ? nbs[1] : nbs[0];
        if (used.has(edgeKey(cur, next))) break;
        used.add(edgeKey(cur, next));
        verts.push(next);
        prev = cur;
        cur = next;
      }
      return verts;
    };
    const verts = [...g.keys()].sort((p, q) => p - q);
    for (const v of verts) {
      if (g.get(v).length === 2) continue;
      for (const nb of g.get(v)) if (!used.has(edgeKey(v, nb))) chains.push({ a, b, verts: walk(v, nb) });
    }
    // O que sobrou são laços (um ambiente ilhado dentro do outro).
    for (const v of verts) {
      for (const nb of g.get(v)) if (!used.has(edgeKey(v, nb))) chains.push({ a, b, verts: walk(v, nb) });
    }
  }
  return chains;
}

// Tira de uma linha os trechos [de, até] (em metros ao longo dela) e devolve os segmentos que sobram.
function cutPolyline(pts, gaps) {
  const segs = [];
  let s0 = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (len < 1e-9) continue;
    let pieces = [[s0, s0 + len]];
    for (const [g0, g1] of gaps) {
      const next = [];
      for (const [p0, p1] of pieces) {
        if (g1 <= p0 || g0 >= p1) next.push([p0, p1]);
        else {
          if (g0 > p0) next.push([p0, g0]);
          if (g1 < p1) next.push([g1, p1]);
        }
      }
      pieces = next;
    }
    for (const [p0, p1] of pieces) {
      if (p1 - p0 < 0.15) continue;
      const u0 = (p0 - s0) / len;
      const u1 = (p1 - s0) / len;
      segs.push([
        pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u0,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u0,
        pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u1,
        pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u1,
      ]);
    }
    s0 += len;
  }
  return segs;
}

// Posição (metros ao longo da linha) do ponto da linha mais perto de (x, y), e a distância até ele.
function projectOnPolyline(pts, x, y) {
  let best = Infinity;
  let at = 0;
  let s0 = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    const t = len2 > 0 ? clamp(((x - pts[i][0]) * dx + (y - pts[i][1]) * dy) / len2, 0, 1) : 0;
    const d = Math.hypot(x - (pts[i][0] + t * dx), y - (pts[i][1] + t * dy));
    if (d < best) {
      best = d;
      at = s0 + t * len;
    }
    s0 += len;
  }
  return { dist: best, at, length: s0 };
}

// Contraste de impressão digital entre dois grupos de varreduras (dB RMS entre rádios),
// descontado o que o ruído sozinho produziria.
function contrastDb(ctx, groupA, groupB) {
  const { feat, R, radioW, radioWsum } = ctx;
  if (!groupA.length || !groupB.length || !R) return 0;
  let total = 0;
  for (let q = 0; q < R; q++) {
    const stat = (g) => {
      let s = 0;
      let s2 = 0;
      for (const k of g) {
        s += feat[k * R + q];
        s2 += feat[k * R + q] ** 2;
      }
      const mean = s / g.length;
      const v = g.length > 1 ? Math.max(0, (s2 - g.length * mean * mean) / (g.length - 1)) : 16;
      return [mean, v / g.length];
    };
    const [ma, va] = stat(groupA);
    const [mb, vb] = stat(groupB);
    total += radioW[q] * Math.max(0, (ma - mb) ** 2 - va - vb);
  }
  return Math.sqrt(total / radioWsum);
}

function buildWalls(ctx, grid, floor, members, scanRoom, links) {
  const { path, tune } = ctx;
  const { nx, ny, cell, minX, minY } = grid;
  const W = nx + 1;
  const vx = (v) => minX + (v % W) * cell;
  const vy = (v) => minY + Math.floor(v / W) * cell;
  const walls = [];
  const rooms = floor.rooms;

  // Divisões internas primeiro: as pontas delas viram vértices fixos do contorno.
  const chains = roomBoundaries(floor.room, nx, ny);
  const fixedVerts = new Set();
  for (const ch of chains) {
    fixedVerts.add(ch.verts[0]);
    fixedVerts.add(ch.verts[ch.verts.length - 1]);
    ch.pts = simplifyOpen(ch.verts.map((v) => [vx(v), vy(v)]), tune.simplifyM);
  }

  // Portas: onde o caminho passou de um ambiente para o outro há uma abertura.
  const doors = new Map(); // par -> [{x, y, n}]
  const roomAtXY = (x, y) => {
    const c = cellAt(grid, x, y);
    return c < 0 ? -1 : floor.room[c];
  };
  for (const k of links) {
    const p = path[k];
    const q = path[k + 1];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const steps = Math.max(1, Math.ceil(len / (0.5 * cell)));
    const crossings = [];
    let prev = roomAtXY(p.x, p.y);
    let px = p.x;
    let py = p.y;
    for (let s = 1; s <= steps; s++) {
      const x = p.x + ((q.x - p.x) * s) / steps;
      const y = p.y + ((q.y - p.y) * s) / steps;
      const r = roomAtXY(x, y);
      if (r >= 0 && prev >= 0 && r !== prev) crossings.push({ a: Math.min(r, prev), b: Math.max(r, prev), x: (x + px) / 2, y: (y + py) / 2 });
      if (r >= 0) {
        prev = r;
        px = x;
        py = y;
      }
    }
    // Passo longo cruzando várias divisões: a reta não é o caminho de verdade, não marca porta.
    if (!crossings.length || (len > tune.doorMaxStepM && crossings.length > 1)) continue;
    for (const c of crossings) {
      const key = c.a * 32768 + c.b;
      if (!doors.has(key)) doors.set(key, []);
      const list = doors.get(key);
      const hit = list.find((d) => Math.hypot(d.x - c.x, d.y - c.y) <= tune.doorJoinM);
      if (hit) {
        hit.x = (hit.x * hit.n + c.x) / (hit.n + 1);
        hit.y = (hit.y * hit.n + c.y) / (hit.n + 1);
        hit.n++;
      } else list.push({ x: c.x, y: c.y, n: 1 });
    }
  }
  const gapsOf = new Map(); // corrente -> [[de, até]]
  for (const [key, list] of doors) {
    // No máximo duas portas por par de ambientes, as mais atravessadas.
    list.sort((p, q) => q.n - p.n || p.x - q.x || p.y - q.y);
    for (const d of list.slice(0, 2)) {
      let best = null;
      for (const ch of chains) {
        if (ch.a * 32768 + ch.b !== key) continue;
        const pr = projectOnPolyline(ch.pts, d.x, d.y);
        if (!best || pr.dist < best.pr.dist) best = { ch, pr };
      }
      if (!best || best.pr.dist > 1.5) continue;
      const half = tune.doorM / 2;
      const at = clamp(best.pr.at, Math.min(half, best.pr.length / 2), Math.max(best.pr.length - half, best.pr.length / 2));
      if (!gapsOf.has(best.ch)) gapsOf.set(best.ch, []);
      gapsOf.get(best.ch).push([at - half, at + half]);
    }
  }

  // Confiança de cada divisão: o quanto a impressão digital muda de um lado para o outro.
  const byRoom = rooms.map(() => []);
  for (let a = 0; a < members.length; a++) if (scanRoom[a] >= 0) byRoom[scanRoom[a]].push(members[a]);
  for (const ch of chains) {
    const nearOf = (r) => {
      const close = byRoom[r].filter((k) => {
        for (let i = 0; i + 1 < ch.pts.length; i++) {
          if (distToSegment(path[k].x, path[k].y, ch.pts[i][0], ch.pts[i][1], ch.pts[i + 1][0], ch.pts[i + 1][1]) <= tune.wallNearM) return true;
        }
        return false;
      });
      return close.length >= 2 ? close : byRoom[r];
    };
    const ga = nearOf(ch.a);
    const gb = nearOf(ch.b);
    const contrast = contrastDb(ctx, ga, gb);
    // Na bancada, divisão com contraste abaixo de ~4 dB quase nunca é parede; acima de ~7, quase sempre.
    let conf = clamp((contrast - tune.wallC0) / (tune.wallC1 - tune.wallC0), 0, 1);
    if (Math.min(ga.length, gb.length) < 2) conf *= 0.7;
    // Dois nomes dados pelo usuário: ele disse que são ambientes diferentes (acerta 4 em 5 vezes).
    if (!rooms[ch.a].auto && !rooms[ch.b].auto) conf = Math.max(conf, tune.wallNamed);
    conf = Math.round(clamp(conf, 0.1, 1) * 100) / 100;
    for (const s of cutPolyline(ch.pts, gapsOf.get(ch) || [])) {
      const wall = { x1: s[0], y1: s[1], x2: s[2], y2: s[3], kind: 'inner', conf };
      if (tune.debugWalls) wall._dbg = { contrast, na: ga.length, nb: gb.length, named: !rooms[ch.a].auto && !rooms[ch.b].auto, oneNamed: !rooms[ch.a].auto || !rooms[ch.b].auto };
      walls.push(wall);
    }
  }

  // Contorno: anéis simplificados; a confiança de cada trecho é a das células que ele encosta.
  const outline = [];
  for (const ring of traceRings(floor.inside, nx, ny)) {
    const pts = ring.map((v) => [vx(v), vy(v)]);
    const fixed = ring.map((v) => (fixedVerts.has(v) ? 1 : 0));
    const simple = simplifyRing(pts, tune.simplifyM, fixed);
    if (simple.length < 3) continue;
    simple.push([simple[0][0], simple[0][1]]);
    outline.push(simple);
    for (let i = 0; i + 1 < simple.length; i++) {
      const [x1, y1] = simple[i];
      const [x2, y2] = simple[i + 1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1e-9) continue;
      // A área fica à esquerda do sentido do anel: amostra meia célula para dentro.
      const ox = (-(y2 - y1) / len) * 0.5 * cell;
      const oy = ((x2 - x1) / len) * 0.5 * cell;
      const steps = Math.max(1, Math.round(len / cell));
      let sum = 0;
      let n = 0;
      for (let s = 0; s < steps; s++) {
        const u = (s + 0.5) / steps;
        const c = cellAt(grid, x1 + (x2 - x1) * u + ox, y1 + (y2 - y1) * u + oy);
        if (c >= 0 && floor.inside[c]) {
          sum += floor.conf[c];
          n++;
        }
      }
      walls.push({ x1, y1, x2, y2, kind: 'outer', conf: Math.round(clamp(n ? sum / n : 0.2, 0.05, 1) * 100) / 100 });
    }
  }
  // Os maiores anéis primeiro (o contorno principal é o outline[0]).
  outline.sort((p, q) => Math.abs(ringArea(q)) - Math.abs(ringArea(p)));
  return { outline, walls };
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i + 1 < ring.length; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}

// ---------------------------------------------------------------------------
// Um andar inteiro
// ---------------------------------------------------------------------------

function buildFloor(ctx, grid, floorNumber, opts) {
  const { path, tune } = ctx;
  const { nx, size, cell } = grid;
  const members = [];
  for (let k = 0; k < path.length; k++) if (path[k].floor === floorNumber) members.push(k);

  const area = buildArea(ctx, grid, members);
  let cells = 0;
  for (let c = 0; c < size; c++) cells += area.inside[c];
  const areaM2 = cells * cell * cell;

  // AMBIENTES só quando o usuário deu nome a pelo menos dois lugares deste andar. Sem nomes, o
  // agrupamento pelo sinal existe (clusterRooms), mas com as posições do solucionador ele vale
  // pouco mais do que cortar a área ao acaso em pedaços contíguos: na bancada (88 levantamentos),
  // concordância com os cômodos reais (ARI, onde o mapa tem área) de 0,38 contra 0,27 do corte ao
  // acaso, e 0,61 com nomes; de cada "ambiente" automático, 71% era de um cômodo só (67% ao
  // acaso, 82% com nomes). Desenhar divisões assim com cara de planta seria fingir uma certeza que
  // não existe: sem nomes o andar sai como uma área só (sem ambientes e sem divisões internas), e
  // o sinal, o caminho e os roteadores continuam lá. `autoRooms: true` (só a bancada usa) força o
  // agrupamento automático, para a medida poder ser refeita.
  const useLabels = opts.labels !== false;
  const partition = opts.autoRooms === true || (useLabels && namedPlaces(ctx, members) >= 2);
  const clusters = partition ? clusterRooms(ctx, members, areaM2, useLabels) : { assign: new Int32Array(members.length), groups: [] };
  const { room, kept } = assignCells(ctx, grid, area.inside, members, clusters.assign, clusters.groups);

  // Ambientes: centro, área, nome.
  const rooms = kept.map((g) => ({ id: 0, label: clusters.groups[g].label, auto: clusters.groups[g].auto, cx: 0, cy: 0, areaM2: 0, scans: 0, first: clusters.groups[g].first }));
  const sx = new Float64Array(rooms.length);
  const sy = new Float64Array(rooms.length);
  const sn = new Float64Array(rooms.length);
  for (let c = 0; c < size; c++) {
    const r = room[c];
    if (r < 0) continue;
    sx[r] += cellX(grid, c % nx);
    sy[r] += cellY(grid, Math.floor(c / nx));
    sn[r]++;
  }
  // O centro precisa cair dentro do ambiente (em L, o centro de massa pode ficar fora).
  const bestD = new Float64Array(rooms.length).fill(Infinity);
  for (let c = 0; c < size; c++) {
    const r = room[c];
    if (r < 0) continue;
    const x = cellX(grid, c % nx);
    const y = cellY(grid, Math.floor(c / nx));
    const d = (x - sx[r] / sn[r]) ** 2 + (y - sy[r] / sn[r]) ** 2;
    if (d < bestD[r]) {
      bestD[r] = d;
      rooms[r].cx = x;
      rooms[r].cy = y;
    }
  }
  rooms.forEach((r, i) => (r.areaM2 = Math.round(sn[i] * cell * cell * 100) / 100));

  // Ambiente de cada varredura: o da célula onde ela caiu (ou o mais perto, se caiu fora).
  const scanRoom = new Int32Array(members.length).fill(-1);
  for (let a = 0; a < members.length; a++) {
    const p = path[members[a]];
    const c = cellAt(grid, p.x, p.y);
    let r = c >= 0 ? room[c] : -1;
    if (r < 0) {
      let bd = Infinity;
      rooms.forEach((rm, i) => {
        const d = (rm.cx - p.x) ** 2 + (rm.cy - p.y) ** 2;
        if (d < bd) {
          bd = d;
          r = i;
        }
      });
    } else rooms[r].scans++;
    scanRoom[a] = r;
  }

  const floor = { floor: floorNumber, z: floorNumber * FLOOR_HEIGHT, inside: area.inside, conf: area.conf, room, outline: [], rooms, walls: [] };
  const drawn = buildWalls(ctx, grid, floor, members, scanRoom, area.links);
  floor.outline = drawn.outline;
  floor.walls = drawn.walls;
  return { floor, areaM2, members, scanRoom };
}

// ---------------------------------------------------------------------------
// Roteadores e redes
// ---------------------------------------------------------------------------

function buildAps(ctx, grid, floors, centre) {
  const { bssids, path, fresh, solAps, ownDevices, floorNumbers } = ctx;
  const devices = new Map();
  for (const b of bssids) {
    if (!devices.has(b.device)) devices.set(b.device, []);
    devices.get(b.device).push(b);
  }
  const bIndex = ctx.bssidIndex;
  // Onde cada aparelho foi ouvido: [ponto, sinal mais forte entre os rádios dele, ponto, sinal...],
  // em ordem de ponto, montado numa passada só pelas leituras. (Varrer todas as leituras de novo
  // para cada aparelho custa aparelhos x leituras: com dezenas de milhares de BSSIDs de um arquivo
  // hostil, ou de uma enxurrada de redes falsas durante o levantamento, a tela parava por segundos.)
  const slotOf = new Int32Array(bssids.length);
  let slots = 0;
  for (const list of devices.values()) {
    for (const b of list) slotOf[bIndex.get(b.id)] = slots;
    slots++;
  }
  const heardAt = Array.from({ length: slots }, () => []);
  const lastPoint = new Int32Array(slots).fill(-1);
  for (let k = 0; k < path.length; k++) {
    const r = fresh[k];
    for (let j = 0; j < r.length; j += 2) {
      const d = slotOf[r[j]];
      const at = heardAt[d];
      if (lastPoint[d] === k) {
        if (r[j + 1] > at[at.length - 1]) at[at.length - 1] = r[j + 1];
      } else {
        lastPoint[d] = k;
        at.push(k, r[j + 1]);
      }
    }
  }
  const aps = [];
  let slot = -1;
  for (const [device, list] of devices) {
    slot++;
    const sorted = list.slice().sort((p, q) => q.best - p.best || (p.id < q.id ? -1 : 1));
    const own = ownDevices.has(device);
    const named = sorted.find((b) => b.ssid && ctx.nets[b.net].explicit) || sorted.find((b) => b.ssid);

    // Posição: média das estimativas dos rádios do aparelho, pesada pela confiança.
    let wx = 0;
    let wy = 0;
    let wz = 0;
    let ws = 0;
    let conf = 0;
    let zs = 0;
    for (const b of list) {
      const a = solAps[b.id];
      if (!a || !isNum(a.x) || !isNum(a.y)) continue;
      const c = isNum(a.conf) ? clamp(a.conf, 0, 1) : 0.3;
      const w = c + 0.05;
      wx += w * a.x;
      wy += w * a.y;
      if (isNum(a.z)) {
        wz += w * a.z;
        zs += w;
      }
      ws += w;
      conf = Math.max(conf, c);
    }
    // Sinal por andar: em qual deles o aparelho chega mais forte (média das 3 melhores leituras).
    const top = new Map();
    const strongest = [];
    const at = heardAt[slot];
    for (let t = 0; t < at.length; t += 2) {
      const k = at[t];
      const v = at[t + 1];
      if (!top.has(path[k].floor)) top.set(path[k].floor, []);
      top.get(path[k].floor).push(v);
      strongest.push([v, k]);
    }
    let heardFloor = null;
    let heardLevel = -Infinity;
    let second = -Infinity;
    for (const f of floorNumbers) {
      const v = (top.get(f) || []).sort((p, q) => q - p).slice(0, 3);
      if (!v.length) continue;
      const level = v.reduce((s, x) => s + x, 0) / v.length;
      if (level > heardLevel) {
        second = heardLevel;
        heardLevel = level;
        heardFloor = f;
      } else if (level > second) second = level;
    }
    let x;
    let y;
    if (ws > 0) {
      x = wx / ws;
      y = wy / ws;
    } else if (strongest.length) {
      // O solucionador não posicionou: fica perto de onde ele foi ouvido mais forte (palpite fraco).
      strongest.sort((p, q) => q[0] - p[0] || p[1] - q[1]);
      const best = strongest.slice(0, 3);
      x = best.reduce((s, v) => s + path[v[1]].x, 0) / best.length;
      y = best.reduce((s, v) => s + path[v[1]].y, 0) / best.length;
      conf = Math.min(0.1, Math.max(0, (sorted[0].best + 75) / 200));
    } else continue; // nunca ouvido num ponto com posição: não há onde desenhar
    const zSol = zs > 0 ? wz / zs : null;

    // Andar: o da casa fica onde chega mais forte; vizinho fraco, ou que o solucionador pôs
    // acima/abaixo dos andares andados, fica sem andar (pode ser de cima, de baixo ou do lado).
    const best = sorted[0].best;
    let floor = heardFloor;
    if (!own) {
      const lo = floorNumbers[0];
      const hi = floorNumbers[floorNumbers.length - 1];
      const beyond = zSol !== null && (zSol > (hi + 0.85) * FLOOR_HEIGHT || zSol < (lo - 0.3) * FLOOR_HEIGHT);
      const unclear = floorNumbers.length > 1 && heardLevel - second < 3;
      if (best < -62 || beyond || unclear) floor = null;
    }
    const fi = floor === null ? -1 : floors.findIndex((f) => f.floor === floor);
    // "Dentro" com 1 m de folga: roteador fica encostado na parede, onde ninguém pisa.
    let inside = false;
    if (fi >= 0) forCellsNear(grid, x, y, 1, (c) => (inside = inside || floors[fi].inside[c] === 1));
    const z = zSol !== null ? zSol : (floor === null ? (heardFloor ?? 0) : floor) * FLOOR_HEIGHT + 1;
    aps.push({
      id: sorted[0].id,
      bssids: sorted.map((b) => b.id),
      ssid: named ? named.ssid : '',
      own,
      x,
      y,
      z,
      floor,
      conf: Math.round(conf * 100) / 100,
      inside,
      distanceM: Math.hypot(x - centre.x, y - centre.y),
      bearing: Math.atan2(y - centre.y, x - centre.x),
      bestRssi: best,
    });
  }
  aps.sort((p, q) => Number(q.own) - Number(p.own) || q.bestRssi - p.bestRssi || (p.id < q.id ? -1 : 1));
  return aps;
}

// ---------------------------------------------------------------------------
// Qualidade
// ---------------------------------------------------------------------------

// Aparelhos (roteadores) ouvidos com frequência: em pelo menos um quinto das varreduras.
function devicesHeardOften(ctx) {
  const { P, fresh, bssids } = ctx;
  if (!P) return 0;
  const count = new Map();
  const seen = new Set();
  for (let k = 0; k < P; k++) {
    seen.clear();
    const list = fresh[k];
    for (let j = 0; j < list.length; j += 2) seen.add(bssids[list[j]].device);
    for (const d of seen) count.set(d, (count.get(d) || 0) + 1);
  }
  let often = 0;
  for (const n of count.values()) if (n >= Math.max(1, Math.ceil(0.2 * P))) often++;
  return often;
}

// Quanto o sinal dos rádios mais fortes variou ao longo do levantamento (dB; null = sem dados). É a
// mesma conta do gravador (recorder.js, spread): pouco = as leituras foram feitas todas no mesmo lugar.
function signalSwing(ctx) {
  const { P, fresh, bssids } = ctx;
  const per = bssids.map(() => []);
  for (let k = 0; k < P; k++) {
    const list = fresh[k];
    for (let j = 0; j < list.length; j += 2) per[list[j]].push(list[j + 1]);
  }
  const need = Math.max(5, Math.ceil(0.3 * P));
  const rows = [];
  for (const list of per) {
    if (list.length < need) continue;
    list.sort((p, q) => p - q);
    rows.push({ mid: quantileSorted(list, 0.5), range: quantileSorted(list, 0.9) - quantileSorted(list, 0.1) });
  }
  if (!rows.length) return null;
  rows.sort((p, q) => q.mid - p.mid);
  // a maior variação entre os dois rádios mais fortes: quem anda faz o roteador mais próximo variar
  // 10 dB ou mais; parado, os rádios fortes são justamente os mais estáveis
  return Math.max(...rows.slice(0, 2).map((r) => r.range));
}

// Calibração do solucionador (solver.js): o erro mediano esperado de um ponto é 0,7 + 0,8 x discordância
// entre os motores ali, e o do levantamento inteiro é 0,5 + 1,3 x discordância mediana.
const POINT_ERR = [0.7, 0.8];
const SURVEY_ERR = [0.5, 1.3];
/** Variação do sinal (dB) abaixo da qual o levantamento foi feito parado (o mesmo corte do gravador). */
const STILL_SWING_DB = 7;

function buildQuality(ctx, floors, aps, areaM2, solution, spots) {
  const { path, P, cadence, scans } = ctx;
  const notes = [];
  const scaleConf = isNum(solution.scaleConf) ? clamp(solution.scaleConf, 0, 1) : 0;
  const strong = aps.filter((a) => a.bestRssi >= -70).length;
  const veryStrong = aps.filter((a) => a.bestRssi >= -55).length;
  const often = devicesHeardOften(ctx);
  const swing = signalSwing(ctx);
  const ownCount = aps.filter((a) => a.own).length;
  const wide = ownCount >= WIDE_PLACE_APS;
  const confs = path.map((p) => p.conf);
  const flat = P > 0 && Math.max(...confs) - Math.min(...confs) < 1e-6;
  const collapsed = ctx.collapsed;

  // ERRO TÍPICO ESPERADO (mediano, em metros). Duas fontes, que erram de jeitos diferentes:
  //  - o tamanho do lugar: na bancada (88 levantamentos simulados, solucionador final) o erro mediano
  //    cresce perto da raiz da área de um andar — 0,8 m numa kitnet de 30 m², 1,2 m num apartamento
  //    de 63 m², 2,2 m num escritório de 280 m² —, é ~45% maior com uma varredura a cada 30 s e
  //    ~35% maior numa casa de dois andares;
  //  - o que a própria solução declara: a confiança de cada ponto vem da discordância entre os
  //    motores ali (conf = 1 / (1 + (e / 1,5)²)), e dela sai o erro do levantamento pela calibração
  //    do solucionador. Sozinha ela subestima os lugares grandes, que todos os motores encolhem
  //    juntos sem discordar.
  // A média das duas errou 0,27 m em média na bancada (viés +0,07 m); cada uma sozinha, ~0,30 m.
  // Solução sem confiança própria (todas iguais: posições dadas de fora) fica só com o tamanho.
  const perFloor = Math.max(8, areaM2 / Math.max(1, floors.length));
  const typical = 1.2 * Math.pow(perFloor / 60, 0.54);
  let err = typical;
  if (cadence > 10) err *= 1.45;
  if (floors.length > 1) err *= 1.35;
  if (P && !flat) {
    const point = CONF_HALF_M * Math.sqrt(1 / clamp(median(confs), 0.02, 1) - 1);
    const declared = SURVEY_ERR[0] + SURVEY_ERR[1] * Math.max(0, (point - POINT_ERR[0]) / POINT_ERR[1]);
    err = 0.5 * (err + declared);
  }
  if (strong < 3) err *= 1.4;
  if (P < 25) err *= 1.3;
  if (scaleConf < 0.3) err *= 1.1;
  if (collapsed || !P) err = Math.max(err, 5);
  if (P && flat && confs[0] < 0.02) err = Math.max(err, 4);
  err = Math.round(clamp(err, 0.5, 9) * 10) / 10;

  // ISTO É UM MAPA? Há levantamentos de que não sai mapa nenhum, por mais conta que se faça; a
  // primeira nota diz por quê e o que fazer, e `usable: false` avisa a tela para não apresentar o
  // desenho como se fosse a casa.
  let usable = true;
  const stop = (text) => {
    if (usable) notes.push(text);
    usable = false;
  };
  if (!scans.length) stop('Nenhuma leitura: ande pela casa com o mapeamento ligado.');
  else if (!P) stop('Não foi possível estimar as posições deste levantamento.');
  else {
    if (often <= 1) {
      stop(
        'Só um roteador ao alcance. Para descobrir onde cada leitura foi feita o app precisa ouvir pelo menos três roteadores (o seu e os dos vizinhos contam); com um só, o desenho não representa a casa.',
      );
    } else if (P >= 12 && swing !== null && swing < STILL_SWING_DB) {
      stop('O sinal quase não mudou do começo ao fim: as leituras parecem ter sido feitas todas no mesmo lugar. Ande por todos os cômodos com o mapeamento ligado.');
    } else if (collapsed) stop('As posições ficaram todas no mesmo lugar: as leituras não têm informação suficiente para um mapa.');
    else if (P < 8) stop(`Só ${P} ${P === 1 ? 'leitura' : 'leituras'}: é pouco para desenhar um mapa. Continue o mapeamento e ande por todos os cômodos.`);

    if (usable && often === 2) notes.push('Só dois roteadores ao alcance: as posições ficam pouco confiáveis e o desenho pode não lembrar a casa.');
    if (P >= 8 && P < 25) notes.push('Poucas leituras: ande por mais cômodos.');
    else if (P >= 25 && P < 50) notes.push('O mapa melhora com mais leituras: ande mais devagar e passe por todos os cômodos.');
    if (usable && often > 2 && strong < 3) notes.push('Só um roteador chega forte aqui: as posições ficam menos precisas.');
    if (cadence > 10) notes.push('Leituras lentas (o Android limita a uma a cada 30 s): marque mais lugares ou desligue o limite nas opções do desenvolvedor.');
    // Tamanho. Na bancada a nuvem de pontos sai em média 13% menor que a casa; com esta confiança
    // de escala, metade dos mapas erra o tamanho em mais de 11% (abaixo de 0,5: em mais de 25%).
    if (usable && scaleConf < 0.5) notes.push('O tamanho é incerto: as distâncias em metros podem errar 40%. Para acertar, informe uma distância real em “Ajustar a escala”.');
    else if (usable && scaleConf < 0.7) notes.push('O tamanho é aproximado: as distâncias costumam sair um pouco menores que as reais e podem errar uns 25%.');
    // Sem pelo menos dois lugares com nome num andar, ele sai como uma área só (ver buildFloor).
    const plain = floors.filter((f) => !f.rooms.length).length;
    const named = new Set(spots.map((s) => s.label.toLowerCase()).filter(Boolean)).size;
    if (plain === floors.length) {
      if (!named) notes.push('O mapa não separa os ambientes porque nenhum lugar tem nome: pare em pelo menos dois cômodos, marque o lugar e diga onde está.');
      else notes.push('Só um lugar tem nome: marque pelo menos mais um para o mapa separar os ambientes.');
    } else if (plain > 0) notes.push('Num dos andares há menos de dois lugares com nome: ali o mapa não separa os ambientes.');
    if (usable && !veryStrong && strong >= 3) notes.push('Nenhum roteador chega forte aqui: o sinal fraco deixa o mapa menos nítido.');
    if (usable && floors.length > 1) notes.push('Mais de um andar é o caso mais difícil só com o Wi-Fi: espere mais lugares fora do cômodo certo do que numa casa térrea.');
    if (usable && wide) {
      notes.push(
        `Lugar grande (a sua rede sai de ${ownCount} pontos de acesso): em ambientes amplos o mapa costuma sair bem menor que o real — em simulação, um escritório de 280 m² sai com 60 a 70% do tamanho. Vale medir uma distância em “Ajustar a escala”.`,
      );
    }
  }
  // Nível: o erro esperado comparado com o que se consegue num lugar deste tamanho (num
  // escritório grande, 2,5 m de erro é um bom levantamento; numa kitnet, não).
  const excess = err / typical;
  let level = 'fraca';
  if (usable && often > 2) {
    // Mais de um andar nunca passa de 'razoavel': é o caso mais difícil (na bancada, 3 em cada 5
    // leituras caem no cômodo certo num sobrado, contra 4 em 5 ou mais nas casas de um andar). E
    // tamanho incerto também não: com confiança de escala abaixo de 0,5 metade dos mapas da bancada
    // erra o tamanho em mais de 25% (é o caso dos lugares grandes, que saem encolhidos).
    // Lugar amplo idem (veja `wide`): todos os motores do solucionador o encolhem e a área desenhada
    // fica pela metade.
    if (P >= 40 && excess <= LEVEL_GOOD && err <= 3.5 && floors.length === 1 && scaleConf >= 0.5 && !wide) level = 'boa';
    else if (P >= 15 && excess <= LEVEL_FAIR && err <= 5) level = 'razoavel';
  }
  return {
    scans: P,
    spots: spots.length,
    aps: aps.length,
    areaM2: Math.round(areaM2 * 10) / 10,
    scaleConf,
    expectedErrorM: err,
    level,
    usable,
    notes,
  };
}

/** Erro esperado / erro típico do tamanho do lugar: até aqui o levantamento é 'boa'; até o segundo, 'razoavel'. */
const LEVEL_GOOD = 1.25;
const LEVEL_FAIR = 1.9;
/**
 * Rede "da casa" saindo de tantos aparelhos ou mais = lugar amplo (escritório, galpão, casa muito
 * grande): ninguém instala três pontos de acesso num apartamento. É o único indício do tamanho real
 * que não depende da escala do próprio mapa — e é justamente nesses lugares que o mapa sai
 * encolhido (o escritório de 280 m² da bancada, com 5 pontos de acesso, sai com 0,72 do tamanho;
 * conduzido pelo app, com 0,6). A área desenhada não serve de indício: casas grandes sorteadas, de
 * 100 a 140 m², saem do tamanho certo.
 */
const WIDE_PLACE_APS = 3;

// ---------------------------------------------------------------------------
// buildMap
// ---------------------------------------------------------------------------

/**
 * Monta o modelo do mapa. Nunca lança erro: entrada ruim dá um modelo vazio, mas válido.
 *
 * Além dos campos do contrato (types.js), o modelo leva `_heat`: as medições de cada rede
 * em cada ponto do caminho, que heatField() / coverage() usam. É só dado (objetos simples e
 * vetores tipados), então o modelo pode atravessar um postMessage.
 *
 * @param {import('./types.js').Survey} survey
 * @param {import('./types.js').MapSolution} solution
 * @param {{own?: string[], cell?: number, labels?: boolean}} [options]
 *        own: BSSIDs das redes do usuário (conectada / favoritas); cell: lado da célula (0,2 a 0,5 m);
 *        labels: false ignora os nomes dados aos pontos (ambientes só automáticos)
 * @returns {import('./types.js').MapModel}
 */
export function buildMap(survey, solution, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const safe = (v) => (v && typeof v === 'object' ? v : {});
  try {
    return build(safe(survey), safe(solution), opts);
  } catch (err) {
    if (opts.debug) throw err;
    return build({ scans: [], aps: {} }, { points: [], aps: {} }, {});
  }
}

function build(survey, solution, opts) {
  const tune = { ...TUNE, ...(opts.tune && typeof opts.tune === 'object' ? opts.tune : {}) };
  const ctx = prepare(survey, solution, opts, tune);
  fingerprints(ctx);
  const grid = makeGrid(ctx, opts, tune);
  const { path, scans } = ctx;

  const built = (ctx.floorNumbers.length ? ctx.floorNumbers : [0]).map((f) => buildFloor(ctx, grid, f, opts));
  const floors = built.map((b) => b.floor);

  // Numeração dos ambientes: id corrido entre os andares; os sem nome viram "Ambiente N"
  // na ordem em que foram visitados.
  let nextId = 0;
  const autos = [];
  for (const f of floors) {
    for (const r of f.rooms) {
      r.id = nextId++;
      if (r.auto) autos.push(r);
    }
  }
  autos.sort((p, q) => p.first - q.first).forEach((r, i) => (r.label = `Ambiente ${i + 1}`));
  for (const f of floors) for (const r of f.rooms) delete r.first;

  let areaM2 = 0;
  let cx = 0;
  let cy = 0;
  let cn = 0;
  for (const b of built) {
    areaM2 += b.areaM2;
    for (let c = 0; c < grid.size; c++) {
      if (!b.floor.inside[c]) continue;
      cx += cellX(grid, c % grid.nx);
      cy += cellY(grid, Math.floor(c / grid.nx));
      cn++;
    }
  }
  const centre = cn ? { x: cx / cn, y: cy / cn } : { x: (grid.minX + grid.maxX) / 2, y: (grid.minY + grid.maxY) / 2 };

  const aps = buildAps(ctx, grid, floors, centre);
  const networks = ctx.nets
    .map((n) => ({ key: n.key, ssid: n.ssid, own: n.own, bssids: n.bssids.slice(), bestRssi: n.bestRssi }))
    .sort((p, q) => Number(q.own) - Number(p.own) || q.bestRssi - p.bestRssi || (p.key < q.key ? -1 : 1));

  // Pontos marcados: posição média das varreduras de cada um.
  const spotMap = new Map();
  for (const p of path) {
    const s = scans[p.i];
    if (s.spot === null || s.spot === undefined) continue;
    let sp = spotMap.get(s.spot);
    if (!sp) spotMap.set(s.spot, (sp = { id: s.spot, label: '', x: 0, y: 0, z: p.z, floor: p.floor, scans: 0 }));
    sp.x += p.x;
    sp.y += p.y;
    sp.scans++;
    if (!sp.label) sp.label = normLabel(s.label);
  }
  const spots = [...spotMap.values()].map((s) => ({ ...s, x: s.x / s.scans, y: s.y / s.scans }));

  const quality = buildQuality(ctx, floors, aps, areaM2, solution, spots);

  // Medições para o campo de sinal. Varredura que não ouviu a rede: se os vizinhos dela ouvem
  // forte foi beacon perdido (não conta); senão o sinal ali está no piso de detecção.
  const P = path.length;
  const neighbours = Array.from({ length: P }, () => []);
  for (let a = 0; a < P; a++) {
    for (let b = a + 1; b < P; b++) {
      if (path[a].floor !== path[b].floor) continue;
      if (b - a > 1 && (path[a].x - path[b].x) ** 2 + (path[a].y - path[b].y) ** 2 > 6.25) continue;
      neighbours[a].push(b);
      neighbours[b].push(a);
    }
  }
  const nets = {};
  const heard = [];
  ctx.nets.forEach((n, ni) => {
    const raw = ctx.netDbm[ni];
    const out = new Float32Array(P);
    for (let k = 0; k < P; k++) {
      if (raw[k] === raw[k]) {
        out[k] = raw[k];
        continue;
      }
      heard.length = 0;
      for (const j of neighbours[k]) if (raw[j] === raw[j]) heard.push(raw[j]);
      out[k] = heard.length >= 2 && median(heard) >= ctx.missDbm + 12 ? NaN : ctx.missDbm;
    }
    nets[n.key] = out;
  });
  const track = trackSamples(ctx);
  const h = clamp(tune.heatH0 + tune.heatHk * quality.expectedErrorM, tune.heatHmin, tune.heatHmax);

  return {
    version: VERSION,
    bounds: { minX: grid.minX, minY: grid.minY, maxX: grid.maxX, maxY: grid.maxY },
    cell: grid.cell,
    nx: grid.nx,
    ny: grid.ny,
    floors,
    aps,
    networks,
    path: path.map((p) => ({ i: p.i, t: p.t, x: p.x, y: p.y, z: p.z, floor: p.floor, conf: p.conf, still: p.still })),
    spots,
    quality,
    _heat: { missDbm: ctx.missDbm, h, wide: tune.heatWide, wideW: tune.heatWideW, ridge: tune.heatRidge, linear: tune.heatLinear, confK: tune.heatConfK, confS: tune.heatConfS, weight: ctx.weight, nets, track },
  };
}

// ---------------------------------------------------------------------------
// Sinal da rede conectada entre as varreduras
// ---------------------------------------------------------------------------

/**
 * Entre uma varredura e outra o celular continua medindo a rede em que está CONECTADO (uma amostra
 * a cada 1 ou 2 s, `survey.track`). São medições de verdade, e entram no campo de sinal da rede
 * conectada como medições a mais, com três cuidados para o mapa continuar fiel ao que foi medido
 * (o ganho medido na bancada é pequeno, ~0,05 dB de erro a menos, e nunca piora):
 *
 *  - POSIÇÃO: a amostra não tem posição resolvida; fica na reta entre as duas varreduras que a
 *    cercam no tempo, e só quando elas estão a poucos segundos uma da outra (`trackMaxGapS`) e o
 *    trecho foi andado sem salto (`walked`): em 3,5 s ninguém se afasta muito da reta. Por ser um
 *    palpite, pesa metade de uma varredura. Com as varreduras a cada 30 s a reta entre dois
 *    lugares NÃO serve — quem anda contorna paredes, e na bancada pôr as amostras nela PIOROU o
 *    campo (3,6 -> 3,9 dB com as posições reais): ali só entram as amostras feitas junto de uma
 *    varredura (a pessoa parada no lugar marcado), cuja média tira o ruído daquela leitura única.
 *  - MESMA GRANDEZA: o campo de uma rede é o rádio MAIS FORTE dela em cada lugar; a amostra é do
 *    rádio conectado. Ela só entra onde, nas varreduras vizinhas, o conectado é o mais forte da rede.
 *  - MESMO MEDIDOR: o sinal conectado e o da varredura saem de caminhos diferentes do aparelho e
 *    podem diferir por alguns dB. A diferença mediana entre os dois (amostras feitas junto de uma
 *    varredura) é medida no próprio levantamento e descontada; sem pares suficientes, as amostras
 *    ficam de fora.
 *
 * As amostras de um mesmo quadrado de 0,5 m viram uma só (a média), com peso limitado: ficar um
 * minuto parado não vale mais do que três ou quatro varreduras ali, e o custo do campo não cresce
 * com a duração do levantamento.
 *
 * @returns {Object<string, {x:Float32Array, y:Float32Array, v:Float32Array, w:Float32Array, f:Int16Array}>} por chave de rede
 */
function trackSamples(ctx) {
  const { survey, path, P, weight, bssids, bssidIndex, fresh, nets, netDbm, tune } = ctx;
  const out = {};
  const raw = Array.isArray(survey.track) ? survey.track : [];
  if (!raw.length || P < 2 || !(tune.trackW > 0)) return out;
  // Instante da POSIÇÃO de cada varredura (a lista chega um pouco depois do meio da escuta).
  const at = new Float64Array(P);
  for (let k = 0; k < P; k++) at[k] = path[k].t - tune.trackLagS;
  const readingOf = (k, b) => {
    const list = fresh[k];
    for (let j = 0; j < list.length; j += 2) if (list[j] === b) return list[j + 1];
    return NaN;
  };
  // Por rádio conectado: amostras em ordem de tempo.
  const byRadio = new Map();
  for (const q of raw) {
    if (!q || typeof q.id !== 'string' || !isNum(q.t) || !isNum(q.rssi)) continue;
    const b = bssidIndex.get(q.id);
    if (b === undefined) continue; // rádio que nenhuma varredura ouviu: não há rede nem como conferir
    if (!byRadio.has(b)) byRadio.set(b, []);
    byRadio.get(b).push(q);
  }
  const bins = new Map(); // rede -> Map(quadrado -> somas)
  for (const [b, list] of byRadio) {
    list.sort((p, q) => p.t - q.t);
    const net = bssids[b].net;
    const single = nets[net].bssids.length === 1;
    // Diferença entre os dois medidores: amostras a até 2 s do instante de uma varredura que ouviu o rádio.
    const diffs = [];
    let j = 0;
    for (let k = 0; k < P; k++) {
      const r = readingOf(k, b);
      if (r !== r) continue;
      while (j < list.length && list[j].t < at[k] - 2) j++;
      for (let i = j; i < list.length && list[i].t <= at[k] + 2; i++) diffs.push(clamp(list[i].rssi, -120, 0) - r);
    }
    if (diffs.length < tune.trackCalMin) continue;
    const offset = clamp(median(diffs), -8, 8);
    // O conectado é o rádio mais forte da rede nesta varredura? (rede não ouvida: nada a objetar)
    const top = (k) => {
      if (single) return true;
      const best = netDbm[net][k];
      if (best !== best) return true;
      const r = readingOf(k, b);
      return r === r && r >= best - tune.trackTopDb;
    };
    let k = 0;
    for (const q of list) {
      while (k + 1 < P && at[k + 1] <= q.t) k++;
      let x;
      let y;
      let floor;
      let w;
      const next = k + 1 < P && q.t >= at[k] ? k + 1 : -1;
      if (next > 0 && at[next] - at[k] <= tune.trackMaxGapS && walked(ctx, k, next)) {
        if (!top(k) || !top(next)) continue;
        const span = at[next] - at[k];
        const u = span > 1e-6 ? clamp((q.t - at[k]) / span, 0, 1) : 0;
        x = path[k].x + (path[next].x - path[k].x) * u;
        y = path[k].y + (path[next].y - path[k].y) * u;
        floor = path[k].floor;
        w = 0.25 + 0.75 * Math.min(weight[k], weight[next]);
      } else {
        // Sem trecho andado em volta (começo, fim, pausa, troca de andar): vale a varredura ao lado, se for agora.
        const near = next > 0 && Math.abs(at[next] - q.t) < Math.abs(q.t - at[k]) ? next : k;
        if (Math.abs(q.t - at[near]) > tune.trackSnapS || !top(near)) continue;
        x = path[near].x;
        y = path[near].y;
        floor = path[near].floor;
        w = 0.25 + 0.75 * weight[near];
      }
      w *= tune.trackW;
      const key = `${floor}|${Math.floor(x / tune.trackBinM)}|${Math.floor(y / tune.trackBinM)}`;
      if (!bins.has(net)) bins.set(net, new Map());
      const cells = bins.get(net);
      let cell = cells.get(key);
      if (!cell) cells.set(key, (cell = { x: 0, y: 0, v: 0, w: 0, floor }));
      cell.x += w * x;
      cell.y += w * y;
      cell.v += w * (clamp(q.rssi, -120, 0) - offset);
      cell.w += w;
    }
  }
  for (const [net, cells] of bins) {
    const n = cells.size;
    const pack = { x: new Float32Array(n), y: new Float32Array(n), v: new Float32Array(n), w: new Float32Array(n), f: new Int16Array(n) };
    let i = 0;
    for (const cell of cells.values()) {
      pack.x[i] = cell.x / cell.w;
      pack.y[i] = cell.y / cell.w;
      pack.v[i] = cell.v / cell.w;
      pack.w[i] = Math.min(cell.w, tune.trackBinW);
      pack.f[i] = cell.floor;
      i++;
    }
    out[nets[net].key] = pack;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Campo de sinal
// ---------------------------------------------------------------------------

const heatCache = new WeakMap();

/**
 * Sinal de uma rede sobre a grade de um andar: regressão local das leituras MEDIDAS nas
 * posições resolvidas (o mais forte entre os BSSIDs da rede em cada varredura) e, para a rede
 * conectada, também das amostras feitas entre uma varredura e outra (trackSamples).
 * O resultado fica guardado por modelo: chamar de novo não refaz a conta (não altere os vetores).
 *
 * @param {import('./types.js').MapModel} model
 * @param {number} floorIndex   índice em model.floors (não o número do andar)
 * @param {string} networkKey   MapNetwork.key
 * @returns {import('./types.js').HeatField}
 */
export function heatField(model, floorIndex, networkKey) {
  const size = model && isNum(model.nx) && isNum(model.ny) ? model.nx * model.ny : 0;
  const heat = model && model._heat;
  const empty = () => ({ dbm: new Float32Array(size).fill(NaN), conf: new Float32Array(size), min: heat ? heat.missDbm : -95, max: heat ? heat.missDbm : -95 });
  if (!model || !heat || !Array.isArray(model.floors)) return empty();
  const floor = model.floors[floorIndex];
  const values = heat.nets[networkKey];
  if (!floor || !values) return empty();
  let cache = heatCache.get(model);
  if (!cache) heatCache.set(model, (cache = new Map()));
  const cacheKey = `${floorIndex}|${networkKey}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const { nx, ny, cell } = model;
  const { minX, minY } = model.bounds;
  const xs = [];
  const ys = [];
  const vs = [];
  const ws = [];
  let vMin = Infinity;
  let vMax = -Infinity;
  model.path.forEach((p, k) => {
    const v = values[k];
    if (p.floor !== floor.floor || v !== v) return;
    xs.push(p.x);
    ys.push(p.y);
    vs.push(v);
    ws.push(0.25 + 0.75 * heat.weight[k]);
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  });
  // Amostras do sinal conectado entre as varreduras (só a rede conectada as tem).
  const extra = heat.track && heat.track[networkKey];
  if (extra && extra.v && extra.f) {
    for (let s = 0; s < extra.v.length; s++) {
      if (extra.f[s] !== floor.floor || !(extra.w[s] > 0) || extra.v[s] !== extra.v[s]) continue;
      xs.push(extra.x[s]);
      ys.push(extra.y[s]);
      vs.push(extra.v[s]);
      ws.push(extra.w[s]);
      if (extra.v[s] < vMin) vMin = extra.v[s];
      if (extra.v[s] > vMax) vMax = extra.v[s];
    }
  }
  const out = empty();
  const S = xs.length;
  if (!S) {
    // Nenhuma medição neste andar: tudo o que se sabe é que a rede não apareceu.
    for (let c = 0; c < size; c++) if (floor.inside[c]) out.dbm[c] = heat.missDbm;
    cache.set(cacheKey, out);
    return out;
  }
  const h = heat.h;
  const n2 = 2 * h * h;
  const w2 = 2 * (h * heat.wide) ** 2;
  const cut = 12 * h * h;
  const c2 = 2 * heat.confS * heat.confS;
  const cutConf = 6 * c2;
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < ny; j++) {
    const y = minY + (j + 0.5) * cell;
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!floor.inside[c]) continue;
      const x = minX + (i + 0.5) * cell;
      let s0 = 0;
      let sx = 0;
      let sy = 0;
      let sxx = 0;
      let sxy = 0;
      let syy = 0;
      let sv = 0;
      let sxv = 0;
      let syv = 0;
      let dense = 0;
      for (let s = 0; s < S; s++) {
        const dx = xs[s] - x;
        const dy = ys[s] - y;
        const d2 = dx * dx + dy * dy;
        let k = heat.wideW * Math.exp(-d2 / w2);
        if (d2 < cut) k += Math.exp(-d2 / n2);
        // Confiança: medições a menos de ~1 m, numa escala fixa (não a do núcleo da regressão).
        if (d2 < cutConf) dense += ws[s] * Math.exp(-d2 / c2);
        k *= ws[s];
        s0 += k;
        sx += k * dx;
        sy += k * dy;
        sxx += k * dx * dx;
        sxy += k * dx * dy;
        syy += k * dy * dy;
        sv += k * vs[s];
        sxv += k * dx * vs[s];
        syv += k * dy * vs[s];
      }
      let v = sv / s0;
      if (heat.linear && S >= 3) {
        // Regressão linear local com freio nas inclinações: com poucas medições por perto
        // (ou todas em linha) ela vira a média ponderada.
        const lam = heat.ridge * s0 * h * h;
        const a11 = sxx + lam;
        const a22 = syy + lam;
        // Resolve [s0 sx sy; sx a11 sxy; sy sxy a22] [a b c]' = [sv sxv syv]' para a (valor na célula).
        const det = s0 * (a11 * a22 - sxy * sxy) - sx * (sx * a22 - sxy * sy) + sy * (sx * sxy - a11 * sy);
        if (det > 1e-12 * s0 * a11 * a22) {
          const num = sv * (a11 * a22 - sxy * sxy) - sx * (sxv * a22 - sxy * syv) + sy * (sxv * sxy - a11 * syv);
          const lin = num / det;
          if (lin === lin) v = lin;
        }
      }
      out.dbm[c] = clamp(v, vMin - 3, vMax + 3);
      out.conf[c] = 1 - Math.exp(-dense / heat.confK);
      // Mínimo e máximo saem do valor guardado (Float32), para baterem com o vetor.
      v = out.dbm[c];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (lo <= hi) {
    out.min = lo;
    out.max = hi;
  }
  cache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// Cobertura
// ---------------------------------------------------------------------------

function roomLabelAt(model, fi, c) {
  const f = model.floors[fi];
  const r = f && c >= 0 ? f.room[c] : -1;
  return r >= 0 && f.rooms[r] ? f.rooms[r].label : null;
}

/**
 * Resumo da cobertura de uma rede na área toda (todos os andares).
 * `floor` nos resultados é o NÚMERO do andar (MapFloor.floor).
 * @param {import('./types.js').MapModel} model
 * @param {string} networkKey
 * @returns {import('./types.js').Coverage}
 */
export function coverage(model, networkKey) {
  const none = { floor: 0, x: 0, y: 0, room: null, dbm: NaN };
  const out = { good: 0, fair: 0, weak: 0, dead: 1, deadZones: [], best: { ...none }, worst: { ...none } };
  if (!model || !Array.isArray(model.floors) || !model._heat || !model._heat.nets[networkKey]) return out;
  const { nx, ny, cell } = model;
  const size = nx * ny;
  const grid = { nx, ny, size, cell, minX: model.bounds.minX, minY: model.bounds.minY };
  const count = [0, 0, 0, 0];
  let total = 0;
  let best = null;
  let worst = null;
  model.floors.forEach((f, fi) => {
    const field = heatField(model, fi, networkKey);
    // Extremos só onde há medição por perto, quando houver: o resto é extrapolação.
    let trusted = false;
    for (let c = 0; c < size && !trusted; c++) if (f.inside[c] && field.conf[c] >= 0.3) trusted = true;
    for (let c = 0; c < size; c++) {
      if (!f.inside[c]) continue;
      const v = field.dbm[c];
      total++;
      if (v >= GOOD_DBM) count[0]++;
      else if (v >= FAIR_DBM) count[1]++;
      else if (v >= WEAK_DBM) count[2]++;
      else count[3]++;
      if (v !== v || (trusted && field.conf[c] < 0.3)) continue;
      const here = { floor: f.floor, x: cellX(grid, c % nx), y: cellY(grid, Math.floor(c / nx)), room: roomLabelAt(model, fi, c), dbm: Math.round(v * 10) / 10 };
      if (!best || v > best.dbm) best = here;
      if (!worst || v < worst.dbm) worst = here;
    }
    // Zonas mortas: manchas contíguas abaixo de -82 dBm com pelo menos 1 m².
    const comp = components(grid, (c) => f.inside[c] === 1 && !(field.dbm[c] >= WEAK_DBM));
    const acc = comp.sizes.map(() => ({ x: 0, y: 0, s: 0 }));
    for (let c = 0; c < size; c++) {
      const id = comp.label[c];
      if (id < 0) continue;
      acc[id].x += cellX(grid, c % nx);
      acc[id].y += cellY(grid, Math.floor(c / nx));
      acc[id].s += field.dbm[c] === field.dbm[c] ? field.dbm[c] : model._heat.missDbm;
    }
    comp.sizes.forEach((n, id) => {
      if (n * cell * cell < 1) return;
      // O centro da mancha pode cair fora dela: fica a célula da mancha mais perto do centro.
      const mx = acc[id].x / n;
      const my = acc[id].y / n;
      let bc = -1;
      let bd = Infinity;
      for (let c = 0; c < size; c++) {
        if (comp.label[c] !== id) continue;
        const d = (cellX(grid, c % nx) - mx) ** 2 + (cellY(grid, Math.floor(c / nx)) - my) ** 2;
        if (d < bd) {
          bd = d;
          bc = c;
        }
      }
      out.deadZones.push({
        floor: f.floor,
        x: cellX(grid, bc % nx),
        y: cellY(grid, Math.floor(bc / nx)),
        areaM2: Math.round(n * cell * cell * 10) / 10,
        room: roomLabelAt(model, fi, bc),
        dbm: Math.round((acc[id].s / n) * 10) / 10,
      });
    });
  });
  if (!total) return out;
  out.good = count[0] / total;
  out.fair = count[1] / total;
  out.weak = count[2] / total;
  out.dead = 1 - out.good - out.fair - out.weak;
  if (out.dead < 1e-12) out.dead = 0;
  out.deadZones.sort((p, q) => q.areaM2 - p.areaM2 || p.floor - q.floor || p.x - q.x || p.y - q.y);
  out.deadZones.length = Math.min(out.deadZones.length, 8);
  if (best) out.best = best;
  if (worst) out.worst = worst;
  return out;
}

// ---------------------------------------------------------------------------
// Sugestão de lugar para o roteador
// ---------------------------------------------------------------------------

/**
 * Sugestão modesta de onde o roteador renderia mais: compara onde ele está com o centro da
 * área, puxado para onde o sinal é fraco, e só sugere mudar quando o ganho previsto é claro.
 *
 * Devolve null quando não há o que dizer com segurança (rede que não é da casa, roteador sem
 * posição confiável, rede com vários aparelhos, ganho duvidoso). Quando o roteador já está
 * no meio da área devolve `currentIsCentral: true` com a posição atual.
 * `floor` é o NÚMERO do andar.
 *
 * @param {import('./types.js').MapModel} model
 * @param {string} networkKey
 * @returns {{floor:number, x:number, y:number, room:string|null, gainText:string, currentIsCentral:boolean}|null}
 */
export function suggestRouterSpot(model, networkKey) {
  if (!model || !Array.isArray(model.networks) || !model._heat) return null;
  const net = model.networks.find((n) => n.key === networkKey);
  if (!net) return null;
  const anyOwn = model.networks.some((n) => n.own);
  const ids = new Set(net.bssids);
  // Só quando a rede sai de um aparelho só: com malha ou vários pontos de acesso, "mudar o
  // roteador de lugar" não é uma pergunta bem definida.
  const devices = model.aps.filter((a) => a.bssids.some((b) => ids.has(b)));
  if (devices.length !== 1) return null;
  const ap = devices[0];
  if (anyOwn ? !net.own : !ap.inside) return null;
  if (ap.floor === null || ap.conf < 0.15 || model.quality.scans < 20) return null;
  const fi = model.floors.findIndex((f) => f.floor === ap.floor);
  if (fi < 0) return null;

  const { nx, ny, cell } = model;
  const size = nx * ny;
  const grid = { nx, ny, size, cell, minX: model.bounds.minX, minY: model.bounds.minY };
  const cells = [];
  let cx = 0;
  let cy = 0;
  let wx = 0;
  let wy = 0;
  let wsum = 0;
  model.floors.forEach((f, k) => {
    const field = heatField(model, k, networkKey);
    for (let c = 0; c < size; c++) {
      if (!f.inside[c]) continue;
      const x = cellX(grid, c % nx);
      const y = cellY(grid, Math.floor(c / nx));
      const v = field.dbm[c] === field.dbm[c] ? field.dbm[c] : model._heat.missDbm;
      // Onde o sinal é fraco pesa mais (até 3x): é para lá que o roteador deveria ir.
      const w = 1 + 2 * clamp((GOOD_DBM - v) / (GOOD_DBM - WEAK_DBM), 0, 1);
      cells.push({ x, y, v, dz: (f.floor - ap.floor) * FLOOR_HEIGHT });
      cx += x;
      cy += y;
      wx += w * x;
      wy += w * y;
      wsum += w;
    }
  });
  if (cells.length < 40) return null;
  cx /= cells.length;
  cy /= cells.length;
  const areaM2 = cells.length * cell * cell;
  const radius = Math.sqrt(areaM2 / model.floors.length / Math.PI);
  const usable = (list) => list.reduce((s, v) => s + (v >= FAIR_DBM ? 1 : 0), 0) / list.length;
  const now = usable(cells.map((c) => c.v));
  const room = (x, y) => roomLabelAt(model, fi, cellAt(grid, x, y));
  const pct = (v) => Math.round(v * 100);

  const central = Math.hypot(ap.x - cx, ap.y - cy) <= Math.max(1.5, 0.35 * radius);
  if (central) {
    const text =
      now >= 0.9
        ? 'O roteador já está num bom lugar: perto do meio da área medida e com sinal bom ou razoável em quase toda ela.'
        : `O roteador já está perto do meio da área medida; mudá-lo de lugar não deve ajudar. Para os ${pct(1 - now)}% da área com sinal fraco, um repetidor ou um segundo ponto de acesso tende a resolver melhor.`;
    return { floor: ap.floor, x: ap.x, y: ap.y, room: room(ap.x, ap.y), gainText: text, currentIsCentral: true };
  }

  // Alvo: centro pesado pelo sinal fraco, levado para um lugar onde se andou no andar do roteador.
  const tx = wx / wsum;
  const ty = wy / wsum;
  const f = model.floors[fi];
  let target = -1;
  let bd = Infinity;
  for (let c = 0; c < size; c++) {
    if (!f.inside[c] || f.conf[c] < 0.5) continue;
    const d = (cellX(grid, c % nx) - tx) ** 2 + (cellY(grid, Math.floor(c / nx)) - ty) ** 2;
    if (d < bd) {
      bd = d;
      target = c;
    }
  }
  if (target < 0) return null;
  const sx = cellX(grid, target % nx);
  const sy = cellY(grid, Math.floor(target / nx));
  const move = Math.hypot(sx - ap.x, sy - ap.y);
  if (move < Math.max(2, 0.3 * radius)) return null;

  // Quanto o sinal cai com a distância NESTA casa (paredes incluídas): ajuste do próprio mapa.
  const dist = (c, x, y) => Math.max(1, Math.hypot(c.x - x, c.y - y, c.dz));
  let sl = 0;
  let sv = 0;
  for (const c of cells) {
    sl += Math.log10(dist(c, ap.x, ap.y));
    sv += c.v;
  }
  sl /= cells.length;
  sv /= cells.length;
  let sll = 0;
  let slv = 0;
  let svv = 0;
  for (const c of cells) {
    const l = Math.log10(dist(c, ap.x, ap.y)) - sl;
    sll += l * l;
    slv += l * (c.v - sv);
    svv += (c.v - sv) ** 2;
  }
  if (sll < 1e-6 || svv < 1e-6) return null;
  const slope = slv / sll;
  const r2 = (slv * slv) / (sll * svv);
  // O sinal precisa cair com a distância do roteador estimado; se não cai, a posição dele
  // (ou o mapa) não merece confiança para prever nada.
  if (slope > -12 || r2 < 0.25) return null;
  const n10 = clamp(-slope, 20, 40);
  const after = usable(cells.map((c) => c.v - n10 * (Math.log10(dist(c, sx, sy)) - Math.log10(dist(c, ap.x, ap.y)))));
  const gain = after - now;
  if (gain < 0.08 || now > 0.92) return null;
  const where = room(sx, sy);
  const text =
    `Sugestão: levar o roteador para ${where ? `perto de "${where}"` : 'mais perto do meio da área'}, a uns ${brNum(move, 0)} m de onde ele está, ` +
    `deve deixar o sinal bom ou razoável em cerca de ${pct(after)}% da área (hoje ${pct(now)}%). É uma estimativa: paredes e móveis mudam o resultado.`;
  return { floor: ap.floor, x: sx, y: sy, room: where, gainText: text, currentIsCentral: false };
}

// ---------------------------------------------------------------------------
// Descrição em texto
// ---------------------------------------------------------------------------

function floorName(floor, single) {
  if (single) return '';
  if (floor === 0) return 'no andar onde o levantamento começou';
  const n = Math.abs(floor);
  return `${n} ${n === 1 ? 'andar' : 'andares'} ${floor > 0 ? 'acima' : 'abaixo'}`;
}

/**
 * Frases em pt-BR que resumem o mapa (alternativa em texto para o desenho e para exportar).
 * @param {import('./types.js').MapModel} model
 * @returns {string[]}
 */
export function describeMap(model) {
  if (!model || !Array.isArray(model.floors) || !model.quality) return ['Mapa indisponível.'];
  const q = model.quality;
  const out = [];
  const floors = model.floors;
  const roomCount = floors.reduce((s, f) => s + f.rooms.length, 0);
  if (!q.scans || q.areaM2 <= 0) {
    out.push('Ainda não há mapa: faça um levantamento andando pela casa com o Wi-Fi ligado.');
    for (const n of q.notes) out.push(n);
    return out;
  }
  if (q.usable === false) {
    // Levantamento de que não sai mapa: diz isso, o motivo e o que fazer; nada de área nem ambientes.
    out.push(`Deste levantamento (${q.scans} ${q.scans === 1 ? 'varredura' : 'varreduras'}) não saiu um mapa.`);
    for (const n of q.notes) out.push(n);
    return out;
  }
  const single = floors.length === 1;
  out.push(
    `Mapa aproximado, feito só com o sinal do Wi-Fi: área de cerca de ${brNum(q.areaM2)} m² em ${single ? '1 andar' : `${floors.length} andares`}, ` +
      `${roomCount ? `com ${roomCount} ${roomCount === 1 ? 'ambiente' : 'ambientes'}` : 'sem divisão em ambientes'}, a partir de ${q.scans} varreduras.`,
  );
  out.push(
    `Precisão ${q.level === 'boa' ? 'boa' : q.level === 'razoavel' ? 'razoável' : 'fraca'}: cada posição tem erro típico de uns ${brNum(q.expectedErrorM, 1)} m. Não é uma planta${roomCount ? ': as divisões entre ambientes são estimativas' : ''}.`,
  );
  for (const f of floors) {
    if (!f.rooms.length) continue;
    const list = f.rooms
      .slice()
      .sort((a, b) => b.areaM2 - a.areaM2)
      .map((r) => `${r.label} (cerca de ${brNum(r.areaM2)} m²)`);
    out.push(`Ambientes${single ? '' : ` ${floorName(f.floor, false)}`}: ${list.join(', ')}.`);
  }
  const own = model.aps.filter((a) => a.own);
  const grid = { nx: model.nx, ny: model.ny, cell: model.cell, minX: model.bounds.minX, minY: model.bounds.minY };
  const placeOf = (a) => {
    const fi = a.floor === null ? -1 : floors.findIndex((f) => f.floor === a.floor);
    const where = fi >= 0 && a.inside ? roomLabelAt(model, fi, cellAt(grid, a.x, a.y)) : null;
    const level = a.floor === null || single ? '' : `, ${floorName(a.floor, false)}`;
    return `${where ? `em "${where}"` : a.inside ? 'dentro da área medida' : 'fora da área por onde você andou'}${level}`;
  };
  if (own.length === 1) {
    const a = own[0];
    out.push(`Roteador ${a.ssid ? `"${a.ssid}"` : 'da casa'}: posição estimada ${placeOf(a)}, a uns ${brNum(a.distanceM, 0)} m do centro do mapa.`);
  } else if (own.length > 1) {
    const shown = own.slice(0, 6).map(placeOf);
    out.push(`A rede da casa sai de ${own.length} aparelhos, com posição estimada ${shown.join('; ')}${own.length > shown.length ? '; e outros' : ''}.`);
  }
  const others = model.aps.length - own.length;
  if (others > 0) out.push(`Outros ${others} ${others === 1 ? 'aparelho de vizinho foi ouvido' : 'aparelhos de vizinhos foram ouvidos'} durante a caminhada.`);
  const net = model.networks.find((n) => n.own) || model.networks[0];
  if (net) {
    const cov = coverage(model, net.key);
    const pct = (v) => Math.round(v * 100);
    out.push(
      `Rede ${net.ssid ? `"${net.ssid}"` : 'oculta'}: sinal bom em ${pct(cov.good)}% da área, razoável em ${pct(cov.fair)}%, fraco em ${pct(cov.weak)}% e sem sinal útil em ${pct(cov.dead)}%.`,
    );
    if (isNum(cov.best.dbm) && isNum(cov.worst.dbm)) {
      out.push(
        `Melhor sinal: ${brNum(cov.best.dbm)} dBm${cov.best.room ? ` em "${cov.best.room}"` : ''}; pior: ${brNum(cov.worst.dbm)} dBm${cov.worst.room ? ` em "${cov.worst.room}"` : ''}.`,
      );
    }
    if (cov.deadZones.length) {
      const names = [...new Set(cov.deadZones.map((z) => z.room).filter(Boolean))];
      out.push(
        `${cov.deadZones.length === 1 ? 'Há 1 zona' : `Há ${cov.deadZones.length} zonas`} sem sinal útil${names.length ? ` (${names.slice(0, 4).join(', ')})` : ''}.`,
      );
    }
    const tip = suggestRouterSpot(model, net.key);
    if (tip) out.push(tip.gainText);
  }
  for (const n of q.notes) out.push(n);
  return out;
}

/** Peças internas, só para os testes e a bancada. */
export const _dev = { TUNE, prepare, fingerprints, smoothFingerprints, distanceTransform, traceRings, simplifyOpen, simplifyRing, cutPolyline };
