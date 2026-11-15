// Mundo de rádio simulado: planta, paredes, roteadores e a propagação do sinal.
//
// Serve para duas coisas:
//   1. "modo demonstração" do app (o simulador responde como se fosse o Android);
//   2. bancada de avaliação do mapa 3D (tests/mapping), onde a verdade é conhecida.
//
// Modelo (dBm), determinístico para um par (roteador, posição):
//   rssi = p0 - 10 * n * log10(max(d, 0.5)) - paredes - lajes + sombra
// As paredes entram uma a uma (por isso `n` fica perto de 2, sem inflar), a sombra é
// um campo aleatório suave e REPETÍVEL no mesmo lugar: é ela que dá a cada canto da
// casa a sua "impressão digital" de Wi-Fi. A medição soma corpo do usuário,
// desvanecimento rápido e ruído, e só então arredonda — como um celular de verdade.

import { FLOOR_HEIGHT } from '../mapping/types.js';
import { createRng, hashSeed, hashGaussian, hashUniform } from './prng.js';

/** Altura em que o usuário segura o celular (m acima do piso). */
export const PHONE_HEIGHT = 1.2;
/** Metade da espessura de uma parede (m): mais perto que isso é "dentro da parede". */
export const WALL_HALF_THICKNESS = 0.08;

/** Perda por parede atravessada, em dB, nas faixas de [2,4 GHz, 5 GHz, 6 GHz]. */
export const MATERIALS = {
  concrete: { label: 'concreto', loss: [10, 15, 17] },
  brick: { label: 'tijolo', loss: [6, 9, 10] },
  drywall: { label: 'drywall', loss: [3, 4, 4.5] },
  glass: { label: 'vidro', loss: [2, 3, 3.5] },
  wood: { label: 'porta de madeira', loss: [3, 4, 4.5] },
};

/** Constantes de propagação e de medição. A bancada varia algumas em ±20%. */
export const DEFAULT_RF = {
  n: 2.1, // expoente de perda em visada direta
  phoneLossDb: 18, // antena pequena do celular + calibração do RSSI: -38 dBm a 1 m com 20 dBm EIRP em 2,4 GHz
  wallScale: 1, // multiplica a perda de todas as paredes
  wallKneeDb: [14, 18, 19], // até aqui as paredes somam direto...
  wallCapDb: [32, 42, 45], // ...depois saturam neste teto (difração e multipercurso)
  slabLossDb: [14, 18, 20], // primeira laje atravessada
  slabDecay: 0.65, // cada laje seguinte pesa menos
  clutterBand: [1, 1.5, 1.65], // quanto a perda "fora da planta" cresce em 5 e 6 GHz
  shadowSigmaDb: 3,
  shadowCorrM: 1.7,
  shadowBandCorr: 0.5, // quanto da sombra é comum às duas faixas do mesmo aparelho
  fadeSigmaDb: 1.4, // desvanecimento rápido: muda a cada palmo, mas é fixo no lugar
  fadeCorrM: 0.25,
  noiseSigmaDb: 1.4, // ruído de cada medição
  outlierProb: 0.015,
  bodyLossDb: [5, 6, 6], // corpo do usuário entre o celular e o roteador
  detectAlwaysDbm: -85,
  detectNeverDbm: -93,
  floorDbm: -96,
  missProb: 0.03, // beacon perdido mesmo com sinal bom
  sweepS: 2.5, // duração de uma varredura completa
  staleMinS: 12, // o Android repete leituras antigas por 12 a 20 s
  staleMaxS: 20,
};

// ---------------------------------------------------------------------------
// Geometria 2D
// ---------------------------------------------------------------------------

/** O ponto está dentro do polígono? (contagem de cruzamentos) */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distância de um ponto a um segmento. */
export function distToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** Os segmentos AB e CD se cruzam? */
export function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return false; // paralelos: não conta como cruzar
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Área de um polígono (positiva). */
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return Math.abs(a) / 2;
}

/** Centro de massa de um polígono. */
export function polygonCentroid(poly) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const cross = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += cross;
    cx += (poly[j][0] + poly[i][0]) * cross;
    cy += (poly[j][1] + poly[i][1]) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    // Polígono degenerado: média dos vértices.
    let sx = 0;
    let sy = 0;
    for (const p of poly) {
      sx += p[0];
      sy += p[1];
    }
    return [sx / poly.length, sy / poly.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// ---------------------------------------------------------------------------
// Canais
// ---------------------------------------------------------------------------

/** 0 = 2,4 GHz, 1 = 5 GHz, 2 = 6 GHz. */
export function bandIndex(freq) {
  if (freq < 3000) return 0;
  if (freq < 5925) return 1;
  return 2;
}

/** Número do canal de uma frequência central de 20 MHz. */
export function channelOf(freq) {
  if (freq === 2484) return 14;
  if (freq < 3000) return Math.round((freq - 2407) / 5);
  if (freq < 5925) return Math.round((freq - 5000) / 5);
  return Math.round((freq - 5950) / 5);
}

const WIDTH_CODE = { 20: 0, 40: 1, 80: 2, 160: 3, 320: 5 };

/**
 * Frequências centrais como o Android informa em ScanResult.
 * 20 MHz: tudo zero. 160 MHz: centerFreq0 = centro dos 80 MHz primários e
 * centerFreq1 = centro do bloco de 160 (é assim que os roteadores atuais anunciam).
 */
function centerFreqs(ap) {
  const width = ap.widthMHz || 20;
  const band = bandIndex(ap.freq);
  if (width <= 20) return [0, 0];
  if (band === 0) {
    const ch = channelOf(ap.freq);
    const above = ap.secondary ? ap.secondary === 'above' : ch <= 6;
    return [ap.freq + (above ? 10 : -10), 0];
  }
  const ch = channelOf(ap.freq);
  const base = band === 2 ? 1 : ch >= 149 ? 149 : ch >= 100 ? 100 : 36;
  const toFreq = (c) => (band === 2 ? 5950 : 5000) + 5 * c;
  const idx = Math.floor((ch - base) / 4);
  const center = (span) => toFreq(base + Math.floor(idx / span) * span * 4 + span * 2 - 2);
  if (width === 40) return [center(2), 0];
  if (width === 80) return [center(4), 0];
  if (width === 160) return [center(4), center(8)];
  return [center(16), 0]; // 320 MHz
}

// Ordem em que o celular percorre os canais numa varredura: 2,4 GHz, 5 GHz, 6 GHz (só canais PSC).
const SWEEP_SLOTS = 14 + 25 + 15;
const CH5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165];

function sweepFraction(freq) {
  const band = bandIndex(freq);
  const ch = channelOf(freq);
  let slot;
  if (band === 0) slot = Math.min(13, Math.max(0, ch - 1));
  else if (band === 1) {
    let i = CH5.indexOf(ch);
    if (i < 0) i = 12;
    slot = 14 + i;
  } else slot = 39 + Math.min(14, Math.max(0, Math.floor((ch - 5) / 16)));
  return slot / SWEEP_SLOTS;
}

// ---------------------------------------------------------------------------
// Campo aleatório suave
// ---------------------------------------------------------------------------

// Soma de ondas planas com direções e fases sorteadas: aproxima um campo gaussiano
// de variância 1 e correlação exp(-r² / 2L²), barato de avaliar em qualquer ponto.
function makeField(rng, corrM, corrZ, waves) {
  const kx = new Float64Array(waves);
  const ky = new Float64Array(waves);
  const kz = new Float64Array(waves);
  const ph = new Float64Array(waves);
  for (let i = 0; i < waves; i++) {
    kx[i] = rng.gaussian(0, 1 / corrM);
    ky[i] = rng.gaussian(0, 1 / corrM);
    kz[i] = rng.gaussian(0, 1 / corrZ);
    ph[i] = rng.float(0, 2 * Math.PI);
  }
  const amp = Math.sqrt(2 / waves);
  return (x, y, z) => {
    let s = 0;
    for (let i = 0; i < waves; i++) s += Math.cos(kx[i] * x + ky[i] * y + kz[i] * z + ph[i]);
    return s * amp;
  };
}

// ---------------------------------------------------------------------------
// Mundo
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WorldSpec
 * @property {string} name
 * @property {number} floors                 quantidade de andares (piso do andar k em z = k * FLOOR_HEIGHT)
 * @property {number[][]|number[][][]} outline  contorno da casa [[x,y],...]; pode ser um por andar
 * @property {{floor:number,x1:number,y1:number,x2:number,y2:number,material:string}[]} walls
 *           paredes internas e externas; porta = vão sem parede ou trecho 'wood' (dá para passar)
 * @property {{floor:number,name:string,polygon:number[][]}[]} rooms
 * @property {{fromFloor:number,toFloor:number,x:number,y:number,x2?:number,y2?:number}[]} [stairs]
 *           (x, y) é o pé da escada no andar `fromFloor`; (x2, y2) o topo no andar `toFloor` (padrão: mesmo ponto)
 * @property {Object[]} aps  uma entrada por rede (BSSID): bssid, ssid ('' = oculta), x, y, z (m), freq (MHz),
 *           widthMHz, standard (WIFI_STANDARD_* do Android), capabilities (texto do Android), eirpDbm,
 *           device (id do aparelho físico: as redes de um mesmo roteador têm o mesmo device e a mesma posição),
 *           own (true = é da casa; false = vizinho) e, opcional, secondary ('above' | 'below': canal
 *           secundário de 40 MHz em 2,4 GHz)
 * @property {{dbPerM:number}} [clutter]  o que não está na planta (paredes e móveis dos vizinhos): perda média,
 *           em dB por metro a 2,4 GHz, do trecho do raio que passa fora da casa. Fica bem abaixo de "uma parede
 *           a cada 4 m" porque o sinal acha caminho por corredores, janelas e difração.
 * @property {boolean} [building]  true (padrão) = prédio: a laje continua além do contorno, então todo raio que
 *           muda de andar atravessa laje. false = casa isolada: só conta a laje atravessada dentro do contorno
 *           (o sinal do vizinho desce pelo ar livre e entra pela parede).
 * @property {Partial<typeof DEFAULT_RF>} [rf]
 */

/**
 * Cria o mundo de rádio.
 * @param {WorldSpec} spec
 * @param {number} [seed]
 * @param {Partial<typeof DEFAULT_RF>} [rfOverrides]
 */
export function createWorld(spec, seed = 1, rfOverrides = {}) {
  const rf = { ...DEFAULT_RF, ...(spec.rf || {}), ...rfOverrides };
  const floors = Math.max(1, spec.floors | 0);
  const worldSeed = hashSeed('wrx-world', seed);

  // --- contorno por andar ---
  const perFloorOutline = Array.isArray(spec.outline[0][0]);
  const outlines = [];
  for (let k = 0; k < floors; k++) {
    const poly = perFloorOutline ? spec.outline[Math.min(k, spec.outline.length - 1)] : spec.outline;
    if (!poly || poly.length < 3) throw new Error(`contorno inválido no andar ${k}`);
    outlines.push(poly.map((p) => [p[0], p[1]]));
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of outlines) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const bounds = {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    floors,
    floorHeight: FLOOR_HEIGHT,
  };

  // --- paredes ---
  const walls = [];
  const wallsByFloor = Array.from({ length: floors }, () => []);
  for (const w of spec.walls || []) {
    const mat = MATERIALS[w.material];
    if (!mat) throw new Error(`material de parede desconhecido: ${w.material}`);
    if (w.floor < 0 || w.floor >= floors) throw new Error(`parede em andar inexistente: ${w.floor}`);
    const dx = w.x2 - w.x1;
    const dy = w.y2 - w.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const wall = {
      floor: w.floor,
      x1: w.x1,
      y1: w.y1,
      x2: w.x2,
      y2: w.y2,
      material: w.material,
      passable: w.material === 'wood', // porta: atenua o sinal, mas dá para atravessar andando
      length: len,
      nx: -dy / len,
      ny: dx / len,
      loss: mat.loss,
    };
    walls.push(wall);
    wallsByFloor[w.floor].push(wall);
  }

  // --- cômodos ---
  const rooms = (spec.rooms || []).map((r, index) => {
    if (r.floor < 0 || r.floor >= floors) throw new Error(`cômodo em andar inexistente: ${r.name}`);
    const polygon = r.polygon.map((p) => [p[0], p[1]]);
    const [cx, cy] = polygonCentroid(polygon);
    return { index, floor: r.floor, name: r.name, polygon, centroid: { x: cx, y: cy }, area: polygonArea(polygon) };
  });
  const roomsByFloor = Array.from({ length: floors }, (_, k) => rooms.filter((r) => r.floor === k));

  const stairs = (spec.stairs || []).map((s) => ({
    fromFloor: s.fromFloor,
    toFloor: s.toFloor,
    x: s.x,
    y: s.y,
    x2: s.x2 ?? s.x,
    y2: s.y2 ?? s.y,
  }));

  const clutterDbPerM = spec.clutter?.dbPerM ?? 0;
  const slabsEverywhere = spec.building !== false;

  // --- roteadores ---
  const deviceCache = new Map();
  const fieldCache = new Map();
  function deviceInfo(device) {
    let info = deviceCache.get(device);
    if (!info) {
      const rng = createRng(worldSeed, 'device', device);
      info = {
        p0Offset: Math.max(-3, Math.min(3, rng.gaussian(0, 1.5))), // cada aparelho rende um pouco diferente
        nOffset: rng.float(-0.08, 0.08),
        shadow: makeField(rng.fork('shadow'), rf.shadowCorrM, 1.5, 20),
        staleS: rng.float(rf.staleMinS, rf.staleMaxS),
      };
      deviceCache.set(device, info);
    }
    return info;
  }
  function radioFields(device, band) {
    const key = `${device}|${band}`;
    let f = fieldCache.get(key);
    if (!f) {
      const rng = createRng(worldSeed, 'radio', key);
      f = {
        hash: hashSeed(worldSeed, 'radio-noise', key),
        shadow: makeField(rng.fork('shadow'), rf.shadowCorrM, 1.5, 20),
        fade: makeField(rng.fork('fade'), rf.fadeCorrM, 0.25, 10),
      };
      fieldCache.set(key, f);
    }
    return f;
  }

  const seen = new Set();
  const aps = (spec.aps || []).map((a, index) => {
    const bssid = String(a.bssid).toLowerCase();
    if (seen.has(bssid)) throw new Error(`BSSID repetido: ${bssid}`);
    seen.add(bssid);
    const device = a.device ?? bssid;
    const band = bandIndex(a.freq);
    const info = deviceInfo(device);
    const radio = radioFields(device, band);
    const hash = hashSeed(worldSeed, 'bssid', bssid);
    const eirp = a.eirpDbm ?? 20;
    const fspl1m = 20 * Math.log10(a.freq) - 27.55; // perda no espaço livre a 1 m
    const widthMHz = a.widthMHz || 20;
    const [cf0, cf1] = centerFreqs({ ...a, widthMHz });
    const ap = {
      index,
      bssid,
      ssid: a.ssid ?? '',
      x: a.x,
      y: a.y,
      z: a.z,
      freq: a.freq,
      channel: channelOf(a.freq),
      band,
      widthMHz,
      channelWidth: WIDTH_CODE[widthMHz] ?? -1,
      centerFreq0: cf0,
      centerFreq1: cf1,
      standard: a.standard ?? 4,
      capabilities: a.capabilities ?? '[ESS]',
      eirpDbm: eirp,
      device,
      own: !!a.own,
      p0: eirp - fspl1m - rf.phoneLossDb + info.p0Offset + (hashUniform(hash, 'p0') - 0.5),
      n: rf.n + info.nOffset,
      sweep: sweepFraction(a.freq),
      staleS: info.staleS,
    };
    // Estado interno do simulador: fica fora de JSON.stringify e de Object.keys.
    Object.defineProperties(ap, {
      _hash: { value: hash },
      _radio: { value: radio },
      _device: { value: info },
    });
    return ap;
  });
  const apByBssid = new Map(aps.map((a) => [a.bssid, a]));

  function resolveAp(ap) {
    if (typeof ap === 'string') {
      const found = apByBssid.get(ap.toLowerCase());
      if (!found) throw new Error(`BSSID desconhecido: ${ap}`);
      return found;
    }
    return ap._radio ? ap : resolveAp(ap.bssid);
  }

  // --- perdas no caminho ---

  // Comprimento do trecho [t0, t1] do raio que fica dentro do contorno do andar.
  function insideLength(poly, ax, ay, dx, dy, t0, t1, horiz) {
    const cuts = [t0, t1];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ex = poly[i][0] - poly[j][0];
      const ey = poly[i][1] - poly[j][1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((poly[j][0] - ax) * ey - (poly[j][1] - ay) * ex) / den;
      const u = ((poly[j][0] - ax) * dy - (poly[j][1] - ay) * dx) / den;
      if (u >= 0 && u < 1 && t > t0 && t < t1) cuts.push(t);
    }
    cuts.sort((a, b) => a - b);
    let inside = 0;
    for (let i = 1; i < cuts.length; i++) {
      const tm = (cuts[i - 1] + cuts[i]) / 2;
      if (pointInPolygon(ax + dx * tm, ay + dy * tm, poly)) inside += cuts[i] - cuts[i - 1];
    }
    return inside * horiz;
  }

  // Depois de muitas paredes o sinal não some em linha reta: satura de forma suave.
  function saturate(loss, knee, cap) {
    if (loss <= knee) return loss;
    const room = cap - knee;
    return knee + room * (1 - Math.exp(-(loss - knee) / room));
  }

  /**
   * Decompõe a perda entre um roteador e uma posição.
   * @returns {{d:number, p0:number, n:number, distance:number, walls:number, wallCount:number, slabs:number, slabCount:number, shadow:number, rssi:number}}
   */
  function explain(apRef, pos) {
    const ap = resolveAp(apRef);
    const ax = ap.x;
    const ay = ap.y;
    const az = ap.z;
    const dx = pos.x - ax;
    const dy = pos.y - ay;
    const dz = pos.z - az;
    const horiz = Math.hypot(dx, dy);
    const d = Math.hypot(horiz, dz);
    const band = ap.band;

    const kA = Math.floor(az / FLOOR_HEIGHT);
    const kP = Math.floor(pos.z / FLOOR_HEIGHT);
    const kMin = Math.min(kA, kP);
    const kMax = Math.max(kA, kP);

    let wallSum = 0;
    let wallCount = 0;
    let outside = 0;
    for (let k = kMin; k <= kMax; k++) {
      // Trecho do raio que passa por dentro do andar k.
      let t0 = 0;
      let t1 = 1;
      if (kMin !== kMax) {
        const ta = (k * FLOOR_HEIGHT - az) / dz;
        const tb = ((k + 1) * FLOOR_HEIGHT - az) / dz;
        t0 = Math.max(0, Math.min(ta, tb));
        t1 = Math.min(1, Math.max(ta, tb));
        if (t1 <= t0) continue;
      }
      if (k < 0 || k >= floors) {
        outside += (t1 - t0) * horiz; // andar de outro morador: não está na planta
        continue;
      }
      if (horiz < 1e-9) continue; // raio vertical: não cruza parede nenhuma
      const list = wallsByFloor[k];
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        const ex = w.x2 - w.x1;
        const ey = w.y2 - w.y1;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((w.x1 - ax) * ey - (w.y1 - ay) * ex) / den;
        if (t < t0 || t >= t1) continue;
        const u = ((w.x1 - ax) * dy - (w.y1 - ay) * dx) / den;
        if (u < 0 || u >= 1) continue;
        // Raio rasante atravessa mais material: aumenta um pouco, com teto.
        const cos = Math.abs(dx * w.nx + dy * w.ny) / d;
        const grazing = Math.min(1.4, 1 / Math.sqrt(Math.max(cos, 1e-3)));
        wallSum += w.loss[band] * grazing;
        wallCount++;
      }
      outside += (t1 - t0) * horiz - insideLength(outlines[k], ax, ay, dx, dy, t0, t1, horiz);
    }
    if (outside > 0) wallSum += outside * clutterDbPerM * rf.clutterBand[band];
    const wallsDb = saturate(wallSum * rf.wallScale, rf.wallKneeDb[band], rf.wallCapDb[band]);

    let slabCount = kMax - kMin;
    if (slabCount > 0 && !slabsEverywhere) {
      // Casa isolada: fora do contorno não há laje para atravessar.
      slabCount = 0;
      for (let k = kMin + 1; k <= kMax; k++) {
        if (k < 1 || k > floors - 1) continue;
        const t = (k * FLOOR_HEIGHT - az) / dz;
        if (pointInPolygon(ax + dx * t, ay + dy * t, outlines[k - 1])) slabCount++;
      }
    }
    let slabsDb = 0;
    if (slabCount > 0) {
      const oblique = Math.min(1.15, 1 / Math.sqrt(Math.max(Math.abs(dz) / d, 1e-3)));
      let step = rf.slabLossDb[band] * rf.wallScale;
      for (let i = 0; i < slabCount; i++) {
        slabsDb += step;
        step *= rf.slabDecay;
      }
      slabsDb *= oblique;
    }

    // Colado no roteador quase não há sombra: ela cresce com a distância.
    const near = Math.sqrt(Math.min(1, d / 3));
    const c = rf.shadowBandCorr;
    const shadow =
      rf.shadowSigmaDb *
      near *
      (Math.sqrt(c) * ap._device.shadow(pos.x, pos.y, pos.z) + Math.sqrt(1 - c) * ap._radio.shadow(pos.x, pos.y, pos.z));

    const distance = 10 * ap.n * Math.log10(Math.max(d, 0.5));
    return {
      d,
      p0: ap.p0,
      n: ap.n,
      distance,
      walls: wallsDb,
      wallCount,
      slabs: slabsDb,
      slabCount,
      shadow,
      rssi: ap.p0 - distance - wallsDb - slabsDb + shadow,
    };
  }

  /** Sinal médio (dBm, sem arredondar) de um roteador numa posição {x, y, z}. Repetível. */
  function meanRssi(ap, pos) {
    return explain(ap, pos).rssi;
  }

  // O corpo fica atrás do celular: atrapalha os roteadores que estão "às costas".
  function bodyLoss(ap, pos, heading) {
    if (heading == null) return 0;
    const dx = ap.x - pos.x;
    const dy = ap.y - pos.y;
    const horiz = Math.hypot(dx, dy);
    if (horiz < 1e-6) return 0;
    const d = Math.hypot(horiz, ap.z - pos.z);
    const ahead = (dx * Math.cos(heading) + dy * Math.sin(heading)) / horiz; // 1 = à frente, -1 = atrás
    const behind = (1 - ahead) / 2;
    return rf.bodyLossDb[ap.band] * behind * behind * (horiz / d);
  }

  // Uma medição: média + corpo + desvanecimento do lugar + ruído do instante.
  // `tk` identifica a varredura (ou a amostra): é a chave do ruído, igual para todas as redes dela.
  function measure(ap, pos, heading, tk, noiseScale) {
    const radio = ap._radio;
    let v = meanRssi(ap, pos) - bodyLoss(ap, pos, heading);
    v += rf.fadeSigmaDb * radio.fade(pos.x, pos.y, pos.z);
    // Redes do mesmo rádio (ex.: principal e convidados) ouvem quase o mesmo ruído.
    v += rf.noiseSigmaDb * noiseScale * (0.8 * hashGaussian(radio.hash, tk, 1) + 0.6 * hashGaussian(ap._hash, tk, 2));
    if (hashUniform(ap._hash, tk, 3) < rf.outlierProb * noiseScale) {
      // De vez em quando uma leitura sai bem fora (quase sempre para baixo).
      const size = 6 + 6 * hashUniform(ap._hash, tk, 4);
      v += hashUniform(ap._hash, tk, 5) < 0.8 ? -size : size;
    }
    return v;
  }

  function detectProbability(level) {
    if (level < rf.floorDbm) return 0;
    let p;
    if (level >= rf.detectAlwaysDbm) p = 1;
    else if (level <= rf.detectNeverDbm) {
      p = (0.04 * (level - rf.floorDbm)) / Math.max(1e-6, rf.detectNeverDbm - rf.floorDbm);
    } else {
      const s = (level - rf.detectNeverDbm) / (rf.detectAlwaysDbm - rf.detectNeverDbm);
      p = 0.04 + 0.96 * s * s * (3 - 2 * s);
    }
    return p * (1 - rf.missProb);
  }

  function toPosition(q, fallback) {
    const floor = q.floor ?? fallback?.floor ?? 0;
    return {
      x: q.x,
      y: q.y,
      z: q.z ?? fallback?.z ?? floor * FLOOR_HEIGHT + PHONE_HEIGHT,
      heading: q.heading ?? fallback?.heading ?? null,
    };
  }

  // Cada varredura dura um pouco diferente e a lista demora um instante para chegar ao app.
  function sweepTiming(t) {
    const tk = Math.round(t * 1000);
    return {
      sweep: rf.sweepS * (0.9 + 0.2 * hashUniform(worldSeed, 'sweep', tk)),
      latency: 0.05 + 0.1 * hashUniform(worldSeed, 'latency', tk),
    };
  }

  /**
   * Janela de tempo em que o celular esteve ouvindo os canais para entregar a lista no instante `t`.
   * @returns {{start:number, end:number, mid:number}}
   */
  function sweepWindow(t) {
    const { sweep, latency } = sweepTiming(t);
    const end = t - latency;
    return { start: end - sweep, end, mid: end - sweep / 2 };
  }

  /**
   * Uma varredura, no formato exato de ScanAp (bridge.js).
   *
   * @param {Object} q
   * @param {number} q.x
   * @param {number} q.y
   * @param {number} [q.z]        altura do celular; sem ela usa `floor` (padrão 0) + PHONE_HEIGHT
   * @param {number} [q.floor]
   * @param {number} [q.heading]  para onde o usuário está virado (rad, 0 = +x); null = sem efeito do corpo
   * @param {number} q.t          instante (s) em que a lista fica pronta; a varredura ocupa os ~2,5 s anteriores
   * @param {{t:number, aps:Object[]}|null} [q.prev]  varredura anterior, para as leituras antigas que o Android repete
   * @param {(t:number) => {x:number,y:number,z?:number,floor?:number,heading?:number}} [q.path]
   *        posição do usuário ao longo do tempo: cada canal é ouvido num instante (e num lugar) um pouco diferente
   * @returns {import('../bridge.js').ScanAp[]}
   */
  function scan(q) {
    const t = q.t ?? 0;
    const tk = Math.round(t * 1000);
    const base = toPosition(q);
    const { sweep, latency } = sweepTiming(t);
    const prevMap = new Map();
    if (q.prev && q.prev.aps) for (const p of q.prev.aps) prevMap.set(p.bssid, p);

    const out = [];
    for (const ap of aps) {
      const jitter = 0.01 * hashUniform(ap._hash, tk, 6);
      const heardAt = t - latency - sweep * (1 - Math.min(1, ap.sweep + jitter));
      const pos = q.path ? toPosition(q.path(heardAt), base) : base;
      const level = Math.round(measure(ap, pos, pos.heading, tk, 1));
      const heard = hashUniform(ap._hash, tk, 7) < detectProbability(level);
      if (heard) {
        out.push({
          bssid: ap.bssid,
          ssid: ap.ssid,
          level: Math.min(level, -18),
          frequency: ap.freq,
          channelWidth: ap.channelWidth,
          centerFreq0: ap.centerFreq0,
          centerFreq1: ap.centerFreq1,
          capabilities: ap.capabilities,
          ageMs: Math.max(0, Math.round((t - heardAt) * 1000)),
          wifiStandard: ap.standard,
        });
        continue;
      }
      // Não ouviu agora, mas o Android ainda guarda a leitura velha por alguns segundos.
      const old = prevMap.get(ap.bssid);
      if (old) {
        const age = old.ageMs + (t - q.prev.t) * 1000;
        if (age <= ap.staleS * 1000) out.push({ ...old, ageMs: Math.round(age) });
      }
    }
    return out;
  }

  /**
   * Amostra do sinal da rede conectada entre uma varredura e outra (WifiInfo.getRssi):
   * mesmo modelo da varredura, com um pouco menos de ruído.
   * @returns {number} dBm inteiro
   */
  function track(ap, pos, heading, t = pos.t ?? 0) {
    const a = resolveAp(ap);
    const p = toPosition(pos);
    const level = Math.round(measure(a, p, heading ?? p.heading, Math.round(t * 1000), 0.75));
    return Math.max(-100, Math.min(level, -18));
  }

  // --- consultas de planta (interface e caminhada) ---

  /** Cômodo que contém o ponto, ou null. */
  function roomAt(x, y, floor = 0) {
    const list = roomsByFloor[floor];
    if (!list) return null;
    for (const r of list) if (pointInPolygon(x, y, r.polygon)) return r;
    return null;
  }

  /** Dá para ficar neste ponto? (dentro da casa e fora da espessura das paredes) */
  function isFree(x, y, floor = 0, clearance = WALL_HALF_THICKNESS) {
    if (floor < 0 || floor >= floors) return false;
    if (!pointInPolygon(x, y, outlines[floor])) return false;
    const list = wallsByFloor[floor];
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (w.passable) continue;
      if (distToSegment(x, y, w.x1, w.y1, w.x2, w.y2) <= clearance) return false;
    }
    return true;
  }

  /** Distância até a parede mais próxima (portas não contam). */
  function wallDistance(x, y, floor = 0) {
    let best = Infinity;
    const list = wallsByFloor[floor] || [];
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (w.passable) continue;
      const d = distToSegment(x, y, w.x1, w.y1, w.x2, w.y2);
      if (d < best) best = d;
    }
    return best;
  }

  /** O trecho reto entre dois pontos do mesmo andar atravessa parede ou sai da casa? */
  function crossesWall(x1, y1, x2, y2, floor = 0) {
    if (floor < 0 || floor >= floors) return true;
    const list = wallsByFloor[floor];
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      if (w.passable) continue;
      if (segmentsIntersect(x1, y1, x2, y2, w.x1, w.y1, w.x2, w.y2)) return true;
    }
    const poly = outlines[floor];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (segmentsIntersect(x1, y1, x2, y2, poly[j][0], poly[j][1], poly[i][0], poly[i][1])) return true;
    }
    return false;
  }

  return {
    name: spec.name,
    spec,
    seed,
    rf,
    bounds,
    floors,
    outlines,
    rooms,
    walls,
    stairs,
    aps,
    /** Contorno de um andar. */
    outline: (floor = 0) => outlines[floor],
    wallsOn: (floor = 0) => wallsByFloor[floor] || [],
    roomsOn: (floor = 0) => roomsByFloor[floor] || [],
    ap: (bssid) => apByBssid.get(String(bssid).toLowerCase()) || null,
    /** Altura do celular num andar. */
    phoneZ: (floor = 0) => floor * FLOOR_HEIGHT + PHONE_HEIGHT,
    meanRssi,
    explain,
    scan,
    sweepWindow,
    track,
    roomAt,
    isFree,
    wallDistance,
    crossesWall,
  };
}
