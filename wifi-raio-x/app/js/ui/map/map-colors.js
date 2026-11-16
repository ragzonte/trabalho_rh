// Cores do mapa 3D (módulo puro: roda no navegador e no Node, sem DOM).
//
//   mapTheme('dark' | 'light')            paleta do visualizador (fundo, vidro, rótulos...)
//   SIGNAL_STOPS_DBM / SIGNAL_BREAKS_DBM  onde cada uma das cinco cores do sinal fica "pura" e onde troca de nome
//   signalScale(tema)                     as cinco faixas com cor e nome, para a legenda da tela
//   signalRgb(dbm, tema) / signalHex      dBm -> cor, interpolada de forma contínua entre as cinco
//   signalGradientCss(tema)               a mesma escala como linear-gradient (legenda)
//   signalHeight01(dbm)                   dBm -> 0..1: altura do "relevo de sinal"
//   roomPalette(tema) / roomRgb(i, tema)  tons suaves para os ambientes
//   assignRoomColors(...)                 escolhe o tom de cada ambiente sem repetir entre vizinhos
//   confWeight(conf) / fadeRgb(...)       quanto da cor sobrevive onde o mapa é um palpite (smoothInside alisa a confiança)
//   timeRgb(t, tema)                      cor do caminho, do começo ao fim
//   paintFloorCells(...)                  RGBA por célula de um andar (o que vira textura ou imagem)
//   hexToRgb · rgbToHex · mixRgb · relLuminance · contrastRatio
//
// As cores são sRGB em bytes ([r, g, b] de 0 a 255). A interpolação é feita direto em
// sRGB, igual a um linear-gradient do CSS: assim a legenda da tela bate com o mapa.

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** '#34d399' ou '#3d9' -> [52, 211, 153]. */
export function hexToRgb(hex) {
  let s = String(hex).trim().replace(/^#/, '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`cor inválida: ${hex}`);
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [52, 211, 153] -> '#34d399'. */
export function rgbToHex(rgb) {
  const part = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

/** Mistura a -> b (t = 0 devolve a, t = 1 devolve b). */
export function mixRgb(a, b, t, out = [0, 0, 0]) {
  const k = clamp01(t);
  out[0] = a[0] + (b[0] - a[0]) * k;
  out[1] = a[1] + (b[1] - a[1]) * k;
  out[2] = a[2] + (b[2] - a[2]) * k;
  return out;
}

/** Luminância relativa (WCAG) de uma cor sRGB em bytes. */
export function relLuminance(rgb) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** Contraste WCAG entre duas cores (1 a 21). */
export function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------------------------------------------------------------------------
// Temas
// ---------------------------------------------------------------------------

// Os mesmos valores dos tokens de css/app.css, mais o que só existe no mapa.
// Ficam aqui (e não lidos do CSS) para o visualizador funcionar fora do app e nos testes.
const THEMES = {
  dark: {
    name: 'dark',
    bg: '#0a0f1c',
    ground: '#0d1424', // clarão discreto sob o mapa
    surface: '#121a2b',
    surface2: '#1a2438',
    line: '#26324a',
    lineStrong: '#3a4966',
    text: '#e8eef9',
    muted: '#93a0b8',
    accent: '#38bdf8',
    accentInk: '#04202e',
    grid: '#93a0b8',
    gridAlpha: 0.11,
    neutral: '#1e283d', // piso onde não se sabe (pouca confiança)
    hatch: '#4d5e80',
    slab: '#0c1322', // lateral e fundo da laje
    glass: '#a9c1e6',
    edge: '#dbe7fb', // aresta de cima do contorno
    inner: '#aab7cf',
    labelText: '#f2f6fc',
    labelMuted: '#aab6cb',
    labelHalo: '#070b15',
    pillBg: '#121a2b',
    pillLine: '#3a4966',
    router: '#38bdf8',
    routerCore: '#e0f5ff',
    neighbour: '#7c89a1',
    pin: '#e8eef9',
    walker: '#ffffff',
    path: ['#7dd3fc', '#a78bfa', '#f472b6'],
    pathCasing: '#070b15',
    signal: ['#34d399', '#a3e635', '#fbbf24', '#fb923c', '#f87171'],
    rooms: ['#345d91', '#28706e', '#5e559f', '#834977', '#886e46', '#337595', '#6c4f90', '#8b5750', '#4c668a', '#407a60'],
  },
  light: {
    name: 'light',
    bg: '#f3f5f9',
    ground: '#ffffff',
    surface: '#ffffff',
    surface2: '#eef2f7',
    line: '#d9e0ea',
    lineStrong: '#b4c0d1',
    text: '#0f172a',
    muted: '#5b6779',
    accent: '#0284c7',
    accentInk: '#ffffff',
    grid: '#5b6779',
    gridAlpha: 0.13,
    neutral: '#e4e9f0',
    hatch: '#a7b3c6',
    slab: '#b9c4d3',
    glass: '#64748b',
    edge: '#334155',
    inner: '#475569',
    labelText: '#0f172a',
    labelMuted: '#4b5669',
    labelHalo: '#ffffff',
    pillBg: '#ffffff',
    pillLine: '#b4c0d1',
    router: '#0284c7',
    routerCore: '#ffffff',
    neighbour: '#7a8698',
    pin: '#1e293b',
    walker: '#0284c7',
    path: ['#0284c7', '#7c3aed', '#db2777'],
    pathCasing: '#ffffff',
    // Preenchimentos um pouco mais fechados que os do tema escuro: o fundo é claro.
    signal: ['#10b981', '#84cc16', '#f5b014', '#f97316', '#ef4444'],
    rooms: ['#b5cff0', '#a9dccf', '#cfc5f0', '#efc2da', '#eedbae', '#9ddfe6', '#d7e2a6', '#f2cbbd', '#cbd3df', '#c4e3c8'],
  },
};

const RGB_CACHE = new Map();
function themeRgb(theme) {
  const t = mapTheme(theme);
  let c = RGB_CACHE.get(t.name);
  if (!c) {
    c = {
      signal: t.signal.map(hexToRgb),
      rooms: t.rooms.map(hexToRgb),
      path: t.path.map(hexToRgb),
      neutral: hexToRgb(t.neutral),
    };
    RGB_CACHE.set(t.name, c);
  }
  return c;
}

/** Paleta do visualizador. Aceita o nome ou a própria paleta. */
export function mapTheme(theme) {
  if (theme && typeof theme === 'object' && theme.name) return theme;
  return theme === 'light' ? THEMES.light : THEMES.dark;
}

// ---------------------------------------------------------------------------
// Sinal
// ---------------------------------------------------------------------------

/** dBm em que cada uma das cinco cores aparece pura (o meio de cada faixa). */
export const SIGNAL_STOPS_DBM = Object.freeze([-55, -63.5, -71, -78.5, -86]);
/** Limites entre as faixas, os mesmos de core/signal.js (ótimo | bom | regular | fraco | muito fraco). */
export const SIGNAL_BREAKS_DBM = Object.freeze([-60, -67, -75, -82]);
/** Nome de cada faixa, da mais forte para a mais fraca. */
export const SIGNAL_LABELS = Object.freeze(['Ótimo', 'Bom', 'Regular', 'Fraco', 'Muito fraco']);
/** Faixa de dBm que o relevo usa: abaixo do mínimo é chão, acima do máximo é o topo. */
export const RELIEF_RANGE_DBM = Object.freeze({ min: -90, max: -42 });

/**
 * As cinco faixas do sinal com a cor do tema: para a legenda da tela.
 * @returns {{label:string, color:string, dbm:number, from:number, to:number}[]}
 *          `from`/`to` em dBm (from > to); a primeira vai até +Infinity e a última até -Infinity.
 */
export function signalScale(theme) {
  const t = mapTheme(theme);
  return SIGNAL_LABELS.map((label, i) => ({
    label,
    color: t.signal[i],
    dbm: SIGNAL_STOPS_DBM[i],
    from: i === 0 ? Infinity : SIGNAL_BREAKS_DBM[i - 1],
    to: i === SIGNAL_LABELS.length - 1 ? -Infinity : SIGNAL_BREAKS_DBM[i],
  }));
}

/**
 * Cor do sinal, contínua: pura no meio de cada faixa e misturada entre uma e outra.
 * Valor não numérico devolve o tom neutro (sem medição).
 * @param {number} dbm
 * @param {'dark'|'light'|object} [theme]
 * @param {number[]} [out]
 * @returns {number[]} [r, g, b] 0..255
 */
export function signalRgb(dbm, theme, out = [0, 0, 0]) {
  const c = themeRgb(theme);
  if (typeof dbm !== 'number' || Number.isNaN(dbm)) {
    out[0] = c.neutral[0];
    out[1] = c.neutral[1];
    out[2] = c.neutral[2];
    return out;
  }
  const stops = SIGNAL_STOPS_DBM;
  const last = stops.length - 1;
  if (dbm >= stops[0]) return copy(c.signal[0], out);
  if (dbm <= stops[last]) return copy(c.signal[last], out);
  let i = 0;
  while (dbm < stops[i + 1]) i++;
  return mixRgb(c.signal[i], c.signal[i + 1], (stops[i] - dbm) / (stops[i] - stops[i + 1]), out);
}

function copy(src, out) {
  out[0] = src[0];
  out[1] = src[1];
  out[2] = src[2];
  return out;
}

/** Cor do sinal como '#rrggbb'. */
export function signalHex(dbm, theme) {
  return rgbToHex(signalRgb(dbm, theme));
}

/**
 * A escala como gradiente CSS, do sinal fraco para o forte.
 * @param {'dark'|'light'|object} [theme]
 * @param {{direction?:string, min?:number, max?:number}} [options]  faixa de dBm que a barra cobre
 */
export function signalGradientCss(theme, { direction = 'to right', min = -90, max = -50 } = {}) {
  const t = mapTheme(theme);
  const parts = [];
  for (let i = SIGNAL_STOPS_DBM.length - 1; i >= 0; i--) {
    const pct = clamp01((SIGNAL_STOPS_DBM[i] - min) / (max - min)) * 100;
    parts.push(`${t.signal[i]} ${Math.round(pct * 10) / 10}%`);
  }
  return `linear-gradient(${direction}, ${parts.join(', ')})`;
}

/** Altura do relevo, 0..1: sinal forte fica alto, canto fraco afunda. Sem medição = 0. */
export function signalHeight01(dbm) {
  if (typeof dbm !== 'number' || Number.isNaN(dbm)) return 0;
  const v = clamp01((dbm - RELIEF_RANGE_DBM.min) / (RELIEF_RANGE_DBM.max - RELIEF_RANGE_DBM.min));
  return v * v * (3 - 2 * v); // suaviza as pontas: o topo e o fundo não fazem quina
}

// ---------------------------------------------------------------------------
// Ambientes
// ---------------------------------------------------------------------------

/** Tons dos ambientes no tema ('#rrggbb'). */
export function roomPalette(theme) {
  return mapTheme(theme).rooms.slice();
}

/** Tom do ambiente de índice `slot` (dá a volta na paleta). Índice negativo = neutro. */
export function roomRgb(slot, theme, out = [0, 0, 0]) {
  const c = themeRgb(theme);
  if (!(slot >= 0)) return copy(c.neutral, out);
  return copy(c.rooms[slot % c.rooms.length], out);
}

/**
 * Escolhe o tom de cada ambiente: começa pelo próprio índice e, se um vizinho de parede
 * já usa esse tom, pega o próximo livre. Com mais ambientes que tons a repetição é
 * inevitável, mas nunca entre vizinhos (enquanto houver tom sobrando).
 *
 * @param {ArrayLike<number>} room   por célula: índice do ambiente ou -1
 * @param {number} nx
 * @param {number} ny
 * @param {number} count             quantos ambientes
 * @param {number} paletteSize
 * @param {number} [offset]          desloca o primeiro tom (andares diferentes começam em tons diferentes)
 * @returns {Uint8Array} tom de cada ambiente
 */
export function assignRoomColors(room, nx, ny, count, paletteSize, offset = 0) {
  const slots = new Uint8Array(count);
  if (count === 0 || paletteSize <= 0) return slots;
  const adj = Array.from({ length: count }, () => new Set());
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = room[iy * nx + ix];
      if (!(a >= 0) || a >= count) continue;
      if (ix + 1 < nx) link(adj, a, room[iy * nx + ix + 1], count);
      if (iy + 1 < ny) link(adj, a, room[(iy + 1) * nx + ix], count);
    }
  }
  const taken = new Int16Array(count).fill(-1);
  for (let r = 0; r < count; r++) {
    const used = new Set();
    for (const other of adj[r]) if (taken[other] >= 0) used.add(taken[other]);
    let slot = (r + offset) % paletteSize;
    for (let k = 0; k < paletteSize && used.has(slot); k++) slot = (slot + 1) % paletteSize;
    taken[r] = slot;
    slots[r] = slot;
  }
  return slots;
}

function link(adj, a, b, count) {
  if (!(b >= 0) || b >= count || a === b) return;
  adj[a].add(b);
  adj[b].add(a);
}

// ---------------------------------------------------------------------------
// Confiança
// ---------------------------------------------------------------------------

/** Abaixo disto a célula é só o tom neutro; acima de CONF_FULL a cor aparece inteira. */
export const CONF_NONE = 0.15;
export const CONF_FULL = 0.75;

/** Quanto da cor aparece (0..1) para uma confiança 0..1. A mesma curva está no shader do piso. */
export function confWeight(conf) {
  if (!(conf > 0)) return 0;
  const v = clamp01((conf - CONF_NONE) / (CONF_FULL - CONF_NONE));
  return v * v * (3 - 2 * v);
}

/** Quanto da cor ainda sobra no tom "sem confiança": o lugar fica lavado, mas não perde a pista da cor. */
export const CONF_TINT = 0.25;

/** Cor esmaecida conforme a confiança: de um tom lavado (quase neutro) até a cor cheia. */
export function fadeRgb(rgb, conf, theme, out = [0, 0, 0]) {
  const neutral = themeRgb(theme).neutral;
  const k = CONF_TINT + (1 - CONF_TINT) * confWeight(conf);
  return mixRgb(neutral, rgb, k, out);
}

/**
 * Suaviza um campo por célula dentro da área (média 3 x 3, `passes` vezes).
 * A confiança muda devagar no espaço: sem isto a borda do "não sei" sairia em degraus de célula.
 */
export function smoothInside(values, inside, nx, ny, passes = 2) {
  let cur = Float32Array.from(values);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(cur.length);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const c = iy * nx + ix;
        if (!inside[c]) continue;
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const jy = iy + dy;
          if (jy < 0 || jy >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const jx = ix + dx;
            if (jx < 0 || jx >= nx) continue;
            const j = jy * nx + jx;
            if (!inside[j]) continue;
            sum += cur[j];
            count++;
          }
        }
        next[c] = sum / count;
      }
    }
    cur = next;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Caminho
// ---------------------------------------------------------------------------

/** Cor do caminho andado: t = 0 no começo, 1 no fim. */
export function timeRgb(t, theme, out = [0, 0, 0]) {
  const stops = themeRgb(theme).path;
  const v = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(v));
  return mixRgb(stops[i], stops[i + 1], v - i, out);
}

// ---------------------------------------------------------------------------
// Pintura das células de um andar
// ---------------------------------------------------------------------------

/**
 * RGBA por célula de um andar: é a textura do piso no 3D e a imagem do piso no 2D.
 *
 * - com `heat`: cor do sinal; sem: tom do ambiente (ou neutro se `rooms` for false);
 * - alfa = confiança (0..255). Com `bake: true` a confiança já vem misturada na cor e o
 *   alfa vira 255 (para desenhar direto num canvas 2D, recortando pelo contorno);
 * - as células de fora herdam a cor da vizinha de dentro mais próxima (`bleed` passos):
 *   sem isso a interpolação da textura escureceria a borda da área.
 *
 * @param {import('../../mapping/types.js').MapModel} model
 * @param {number} floorIndex
 * @param {object} [options]
 * @param {import('../../mapping/types.js').HeatField|null} [options.heat]
 * @param {'dark'|'light'|object} [options.theme]
 * @param {boolean} [options.rooms]   pintar por ambiente (padrão true)
 * @param {Uint8Array} [options.slots] tom de cada ambiente (padrão: assignRoomColors)
 * @param {boolean} [options.bake]
 * @param {number} [options.bleed]    padrão 3
 * @param {Uint8ClampedArray} [options.out]
 * @returns {Uint8ClampedArray} nx * ny * 4
 */
export function paintFloorCells(model, floorIndex, options = {}) {
  const { heat = null, theme = 'dark', rooms = true, bake = false, bleed = 3 } = options;
  const floor = model.floors[floorIndex];
  const { nx, ny } = model;
  const n = nx * ny;
  const out = options.out && options.out.length === n * 4 ? options.out : new Uint8ClampedArray(n * 4);
  const c = themeRgb(theme);
  const palette = c.rooms;
  const slots = options.slots || assignRoomColors(floor.room, nx, ny, floor.rooms.length, palette.length, floorIndex * 3);
  const tmp = [0, 0, 0];
  const filled = new Uint8Array(n);

  // confiança de cada célula: a do mapa e, com mapa de calor, também a do campo de sinal
  const confRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!floor.inside[i]) continue;
    let conf = floor.conf ? floor.conf[i] : 1;
    if (heat) {
      if (Number.isNaN(heat.dbm[i])) conf = 0;
      else if (heat.conf && heat.conf[i] < conf) conf = heat.conf[i];
    }
    confRaw[i] = conf >= 0 ? Math.min(1, conf) : 0;
  }
  const confSmooth = smoothInside(confRaw, floor.inside, nx, ny, 2);

  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (!floor.inside[i]) {
      out[o] = c.neutral[0];
      out[o + 1] = c.neutral[1];
      out[o + 2] = c.neutral[2];
      out[o + 3] = 0;
      continue;
    }
    const conf = confSmooth[i];
    if (heat) {
      if (Number.isNaN(heat.dbm[i])) copy(c.neutral, tmp);
      else signalRgb(heat.dbm[i], theme, tmp);
    } else if (rooms && floor.room[i] >= 0 && !(floor.rooms[floor.room[i]] && floor.rooms[floor.room[i]].auto)) {
      copy(palette[slots[floor.room[i]] % palette.length], tmp);
    } else {
      // sem ambiente, ou trecho sem nome ("Ambiente N": o que sobrou longe de todo lugar com nome):
      // cor neutra, a mesma do andar sem divisão. Só o ambiente com nome dado pelo usuário ganha cor.
      copy(c.neutral, tmp);
    }
    if (bake) {
      fadeRgb(tmp, conf, theme, tmp);
      out[o + 3] = 255;
    } else {
      out[o + 3] = Math.round(conf * 255);
    }
    out[o] = tmp[0];
    out[o + 1] = tmp[1];
    out[o + 2] = tmp[2];
    filled[i] = 1;
  }

  // Borda: espalha a cor (e a confiança) para as células de fora, um anel por passo.
  let frontier = filled;
  for (let pass = 0; pass < bleed; pass++) {
    const next = frontier.slice();
    let changed = false;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iy * nx + ix;
        if (frontier[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let k = 0;
        for (let d = 0; d < 4; d++) {
          const jx = ix + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const jy = iy + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
          const j = jy * nx + jx;
          if (!frontier[j]) continue;
          r += out[j * 4];
          g += out[j * 4 + 1];
          b += out[j * 4 + 2];
          a += out[j * 4 + 3];
          k++;
        }
        if (!k) continue;
        const o = i * 4;
        out[o] = r / k;
        out[o + 1] = g / k;
        out[o + 2] = b / k;
        // No modo "bake" a borda fica opaca: quem recorta a área é o contorno.
        out[o + 3] = bake ? 255 : a / k;
        next[i] = 1;
        changed = true;
      }
    }
    frontier = next;
    if (!changed) break;
  }
  return out;
}
