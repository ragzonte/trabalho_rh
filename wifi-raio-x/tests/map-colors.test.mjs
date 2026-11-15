// Cores do mapa: escala de sinal, tons dos ambientes, esmaecimento por confiança, pintura das células.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapTheme,
  hexToRgb,
  rgbToHex,
  mixRgb,
  relLuminance,
  contrastRatio,
  SIGNAL_STOPS_DBM,
  SIGNAL_BREAKS_DBM,
  SIGNAL_LABELS,
  RELIEF_RANGE_DBM,
  signalScale,
  signalRgb,
  signalHex,
  signalGradientCss,
  signalHeight01,
  roomPalette,
  roomRgb,
  assignRoomColors,
  CONF_NONE,
  CONF_FULL,
  CONF_TINT,
  confWeight,
  fadeRgb,
  smoothInside,
  timeRgb,
  paintFloorCells,
} from '../app/js/ui/map/map-colors.js';
import { signalLevel } from '../app/js/core/signal.js';

const THEMES = ['dark', 'light'];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || 'valor'}: esperado ${b} ± ${tol}, veio ${a}`);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('utilidades de cor', () => {
  test('hexToRgb e rgbToHex são inversas, com e sem "#", curtas e longas', () => {
    assert.deepEqual(hexToRgb('#34d399'), [52, 211, 153]);
    assert.deepEqual(hexToRgb('34D399'), [52, 211, 153]);
    assert.deepEqual(hexToRgb('#fa0'), [255, 170, 0]);
    assert.equal(rgbToHex([52, 211, 153]), '#34d399');
    assert.equal(rgbToHex([300, -4, 15.6]), '#ff0010', 'satura e arredonda');
    for (const hex of ['#000000', '#ffffff', '#0a0f1c', '#f87171']) assert.equal(rgbToHex(hexToRgb(hex)), hex);
  });

  test('hexToRgb recusa o que não é cor', () => {
    for (const bad of ['', '#12', 'azul', '#gggggg', null, undefined, '#1234567']) assert.throws(() => hexToRgb(bad), /cor inválida/);
  });

  test('mixRgb: pontas, meio e t fora de 0..1', () => {
    const a = [0, 100, 200];
    const b = [100, 0, 0];
    assert.deepEqual(mixRgb(a, b, 0), a);
    assert.deepEqual(mixRgb(a, b, 1), b);
    assert.deepEqual(mixRgb(a, b, 0.5), [50, 50, 100]);
    assert.deepEqual(mixRgb(a, b, -3), a);
    assert.deepEqual(mixRgb(a, b, 9), b);
    const out = [0, 0, 0];
    assert.equal(mixRgb(a, b, 0.5, out), out, 'escreve no vetor recebido');
  });

  test('luminância e contraste seguem a WCAG', () => {
    near(relLuminance([255, 255, 255]), 1, 1e-9);
    near(relLuminance([0, 0, 0]), 0, 1e-9);
    near(contrastRatio([0, 0, 0], [255, 255, 255]), 21, 1e-9);
    near(contrastRatio([255, 255, 255], [0, 0, 0]), 21, 1e-9, 'a ordem não importa');
    near(contrastRatio([119, 119, 119], [255, 255, 255]), 4.48, 0.01);
  });
});

describe('temas', () => {
  test('mapTheme devolve a paleta pedida, cai no escuro e aceita a própria paleta', () => {
    assert.equal(mapTheme('dark').name, 'dark');
    assert.equal(mapTheme('light').name, 'light');
    assert.equal(mapTheme(undefined).name, 'dark');
    assert.equal(mapTheme('qualquer').name, 'dark');
    assert.equal(mapTheme(mapTheme('light')).name, 'light');
  });

  test('as cores de base são as do sistema visual do app', () => {
    const d = mapTheme('dark');
    assert.equal(d.bg, '#0a0f1c');
    assert.equal(d.text, '#e8eef9');
    assert.equal(d.accent, '#38bdf8');
    assert.deepEqual(d.signal, ['#34d399', '#a3e635', '#fbbf24', '#fb923c', '#f87171'], 'a escala de sinal do brief');
    const l = mapTheme('light');
    assert.equal(l.bg, '#f3f5f9');
    assert.equal(l.text, '#0f172a');
    assert.equal(l.accent, '#0284c7');
  });

  test('toda cor da paleta é um hexadecimal válido, nos dois temas', () => {
    for (const name of THEMES) {
      const t = mapTheme(name);
      for (const [key, value] of Object.entries(t)) {
        if (typeof value === 'string' && value.startsWith('#')) assert.doesNotThrow(() => hexToRgb(value), `${name}.${key}`);
        if (Array.isArray(value)) for (const v of value) assert.doesNotThrow(() => hexToRgb(v), `${name}.${key}`);
      }
      assert.equal(t.signal.length, 5);
      assert.equal(t.path.length, 3);
      assert.ok(t.rooms.length >= 8);
    }
  });

  test('os rótulos se leem: texto contra o contorno do texto e contra a pílula (AA)', () => {
    for (const name of THEMES) {
      const t = mapTheme(name);
      assert.ok(contrastRatio(hexToRgb(t.labelText), hexToRgb(t.labelHalo)) >= 7, `${name}: texto x contorno`);
      assert.ok(contrastRatio(hexToRgb(t.labelMuted), hexToRgb(t.labelHalo)) >= 4.5, `${name}: texto apagado x contorno`);
      assert.ok(contrastRatio(hexToRgb(t.labelText), hexToRgb(t.pillBg)) >= 7, `${name}: texto x pílula`);
      assert.ok(contrastRatio(hexToRgb(t.labelMuted), hexToRgb(t.pillBg)) >= 4.5, `${name}: texto apagado x pílula`);
    }
  });

  test('o piso se destaca do fundo: tons dos ambientes, neutro e aresta', () => {
    for (const name of THEMES) {
      const t = mapTheme(name);
      const bg = hexToRgb(t.bg);
      for (const hex of t.rooms) assert.ok(contrastRatio(hexToRgb(hex), bg) >= 1.2, `${name}: ambiente ${hex} some no fundo`);
      assert.ok(contrastRatio(hexToRgb(t.neutral), bg) >= 1.1, `${name}: o piso neutro some no fundo`);
      assert.ok(contrastRatio(hexToRgb(t.edge), bg) >= 4.5, `${name}: a aresta do contorno precisa aparecer`);
      assert.ok(contrastRatio(hexToRgb(t.hatch), hexToRgb(t.neutral)) >= 1.3, `${name}: a hachura precisa aparecer no piso neutro`);
    }
  });
});

describe('escala de sinal', () => {
  test('os limites são os de core/signal.js', () => {
    assert.deepEqual([...SIGNAL_BREAKS_DBM], [-60, -67, -75, -82]);
    const keys = SIGNAL_BREAKS_DBM.map((dbm) => [signalLevel(dbm).key, signalLevel(dbm - 0.1).key]);
    assert.deepEqual(keys, [
      ['great', 'good'],
      ['good', 'fair'],
      ['fair', 'weak'],
      ['weak', 'very-weak'],
    ]);
  });

  test('cada parada fica no meio da sua faixa e a ordem é do forte para o fraco', () => {
    assert.equal(SIGNAL_STOPS_DBM.length, 5);
    for (let i = 1; i < 5; i++) assert.ok(SIGNAL_STOPS_DBM[i] < SIGNAL_STOPS_DBM[i - 1]);
    for (let i = 1; i < 4; i++) near(SIGNAL_STOPS_DBM[i], (SIGNAL_BREAKS_DBM[i - 1] + SIGNAL_BREAKS_DBM[i]) / 2, 1e-9, `parada ${i}`);
    for (let i = 0; i < 4; i++) assert.ok(SIGNAL_STOPS_DBM[i] > SIGNAL_BREAKS_DBM[i] && SIGNAL_BREAKS_DBM[i] > SIGNAL_STOPS_DBM[i + 1], `o limite ${i} fica entre duas paradas`);
  });

  test('signalScale: cinco faixas com nome, cor e intervalo, sem buracos', () => {
    for (const name of THEMES) {
      const scale = signalScale(name);
      assert.equal(scale.length, 5);
      assert.deepEqual(
        scale.map((s) => s.label),
        [...SIGNAL_LABELS],
      );
      assert.deepEqual(
        scale.map((s) => s.color),
        mapTheme(name).signal,
      );
      assert.equal(scale[0].from, Infinity);
      assert.equal(scale[4].to, -Infinity);
      for (let i = 1; i < 5; i++) assert.equal(scale[i].from, scale[i - 1].to, 'uma faixa começa onde a outra acaba');
      for (const s of scale) assert.ok(s.dbm <= s.from && s.dbm >= s.to, 'a parada está dentro da faixa');
    }
  });

  test('signalRgb: pura nas paradas, saturada nas pontas', () => {
    for (const name of THEMES) {
      const colors = mapTheme(name).signal.map(hexToRgb);
      SIGNAL_STOPS_DBM.forEach((dbm, i) => assert.deepEqual(signalRgb(dbm, name), colors[i], `${name}: parada ${dbm}`));
      assert.deepEqual(signalRgb(-20, name), colors[0]);
      assert.deepEqual(signalRgb(-55, name), colors[0]);
      assert.deepEqual(signalRgb(-99, name), colors[4]);
      assert.deepEqual(signalRgb(-Infinity, name), colors[4]);
      assert.deepEqual(signalRgb(Infinity, name), colors[0]);
    }
  });

  test('signalRgb: entre duas paradas é a mistura linear das duas', () => {
    const colors = mapTheme('dark').signal.map(hexToRgb);
    const mid = signalRgb((SIGNAL_STOPS_DBM[1] + SIGNAL_STOPS_DBM[2]) / 2, 'dark');
    for (let k = 0; k < 3; k++) near(mid[k], (colors[1][k] + colors[2][k]) / 2, 1e-6);
    const quarter = signalRgb(SIGNAL_STOPS_DBM[0] + (SIGNAL_STOPS_DBM[1] - SIGNAL_STOPS_DBM[0]) * 0.25, 'dark');
    for (let k = 0; k < 3; k++) near(quarter[k], colors[0][k] * 0.75 + colors[1][k] * 0.25, 1e-6);
  });

  test('signalRgb é contínua: 0,1 dB nunca dá um salto de cor', () => {
    for (const name of THEMES) {
      let prev = signalRgb(-100, name).slice();
      for (let dbm = -99.9; dbm <= -30; dbm += 0.1) {
        const cur = signalRgb(dbm, name).slice();
        assert.ok(dist(prev, cur) < 4, `${name}: salto em ${dbm.toFixed(1)} dBm`);
        prev = cur;
      }
    }
  });

  test('signalRgb: sem medição (NaN, null, texto) devolve o neutro do tema', () => {
    for (const name of THEMES) {
      const neutral = hexToRgb(mapTheme(name).neutral);
      for (const bad of [NaN, null, undefined, '−60']) assert.deepEqual(signalRgb(bad, name), neutral);
    }
  });

  test('signalRgb escreve no vetor recebido e não devolve as cores da paleta por referência', () => {
    const out = [1, 2, 3];
    assert.equal(signalRgb(-70, 'dark', out), out);
    const a = signalRgb(-55, 'dark');
    a[0] = 999;
    assert.notEqual(signalRgb(-55, 'dark')[0], 999, 'mexer no resultado não estraga a paleta');
  });

  test('signalHex é a mesma cor em texto', () => {
    assert.equal(signalHex(-55, 'dark'), '#34d399');
    assert.equal(signalHex(-86, 'dark'), '#f87171');
    assert.equal(signalHex(-71, 'light'), mapTheme('light').signal[2]);
  });

  test('signalGradientCss: do fraco para o forte, com as cinco cores e posições crescentes', () => {
    for (const name of THEMES) {
      const css = signalGradientCss(name);
      assert.match(css, /^linear-gradient\(to right, /);
      const stops = [...css.matchAll(/(#[0-9a-f]{6}) ([\d.]+)%/g)].map((m) => [m[1], Number(m[2])]);
      assert.deepEqual(
        stops.map((s) => s[0]),
        [...mapTheme(name).signal].reverse(),
      );
      for (let i = 1; i < stops.length; i++) assert.ok(stops[i][1] > stops[i - 1][1]);
      assert.ok(stops[0][1] >= 0 && stops[4][1] <= 100);
    }
    assert.match(signalGradientCss('dark', { direction: 'to top' }), /^linear-gradient\(to top, /);
    // a posição de cada parada bate com o dBm: -71 no meio de uma barra de -91 a -51
    const centred = signalGradientCss('dark', { min: -91, max: -51 });
    assert.match(centred, /#fbbf24 50%/);
  });

  test('signalHeight01: 0 no fundo, 1 no topo, crescente, sem medição = 0', () => {
    assert.equal(signalHeight01(RELIEF_RANGE_DBM.min), 0);
    assert.equal(signalHeight01(RELIEF_RANGE_DBM.min - 20), 0);
    assert.equal(signalHeight01(RELIEF_RANGE_DBM.max), 1);
    assert.equal(signalHeight01(-10), 1);
    assert.equal(signalHeight01(NaN), 0);
    assert.equal(signalHeight01(undefined), 0);
    let prev = -1;
    for (let dbm = -95; dbm <= -35; dbm += 0.5) {
      const h = signalHeight01(dbm);
      assert.ok(h >= prev, `não pode cair em ${dbm}`);
      assert.ok(h >= 0 && h <= 1);
      prev = h;
    }
    near(signalHeight01((RELIEF_RANGE_DBM.min + RELIEF_RANGE_DBM.max) / 2), 0.5, 1e-9, 'o meio da faixa fica a meia altura');
    assert.ok(signalHeight01(-50) - signalHeight01(-80) > 0.5, 'sinal forte e canto fraco ficam bem separados');
  });
});

describe('ambientes', () => {
  test('roomPalette devolve uma cópia; roomRgb dá a volta e trata índice inválido como neutro', () => {
    for (const name of THEMES) {
      const palette = roomPalette(name);
      palette[0] = '#000000';
      assert.notEqual(roomPalette(name)[0], '#000000');
      const n = roomPalette(name).length;
      assert.deepEqual(roomRgb(0, name), hexToRgb(roomPalette(name)[0]));
      assert.deepEqual(roomRgb(n + 2, name), hexToRgb(roomPalette(name)[2]));
      const neutral = hexToRgb(mapTheme(name).neutral);
      assert.deepEqual(roomRgb(-1, name), neutral);
      assert.deepEqual(roomRgb(NaN, name), neutral);
    }
  });

  test('os tons dos ambientes são distinguíveis entre si', () => {
    for (const name of THEMES) {
      const colors = roomPalette(name).map(hexToRgb);
      for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) assert.ok(dist(colors[i], colors[j]) > 18, `${name}: tons ${i} e ${j} são quase iguais`);
    }
  });

  // grade 4 x 1 com quatro ambientes em fila: 0 | 1 | 2 | 3
  const row = (ids) => Int16Array.from(ids);

  test('assignRoomColors: cada ambiente começa no próprio tom', () => {
    assert.deepEqual([...assignRoomColors(row([0, 1, 2, 3]), 4, 1, 4, 10)], [0, 1, 2, 3]);
    assert.deepEqual([...assignRoomColors(row([0, 1, 2, 3]), 4, 1, 4, 10, 3)], [3, 4, 5, 6], 'com deslocamento');
  });

  test('assignRoomColors: vizinhos nunca repetem o tom, mesmo com mais ambientes que tons', () => {
    // 12 ambientes numa grade 4 x 3, paleta de 5 tons
    const nx = 4;
    const ny = 3;
    const grid = Int16Array.from({ length: nx * ny }, (_, i) => i);
    const slots = assignRoomColors(grid, nx, ny, 12, 5);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = slots[iy * nx + ix];
        assert.ok(a >= 0 && a < 5);
        if (ix + 1 < nx) assert.notEqual(a, slots[iy * nx + ix + 1], `(${ix},${iy}) e o da direita`);
        if (iy + 1 < ny) assert.notEqual(a, slots[(iy + 1) * nx + ix], `(${ix},${iy}) e o de cima`);
      }
    }
  });

  test('assignRoomColors: paleta de 2 tons e três ambientes em fila alterna', () => {
    assert.deepEqual([...assignRoomColors(row([0, 1, 2]), 3, 1, 3, 2)], [0, 1, 0]);
  });

  test('assignRoomColors: ignora células de fora (-1) e índices além da contagem', () => {
    assert.deepEqual([...assignRoomColors(row([0, -1, 1, 9]), 4, 1, 2, 4)], [0, 1]);
    assert.equal(assignRoomColors(row([]), 0, 0, 0, 4).length, 0);
    assert.deepEqual([...assignRoomColors(row([0, 1]), 2, 1, 2, 0)], [0, 0], 'sem paleta não quebra');
  });

  test('assignRoomColors é determinística', () => {
    const grid = Int16Array.from([0, 0, 1, 1, 2, 2, 0, 3, 3]);
    assert.deepEqual([...assignRoomColors(grid, 3, 3, 4, 6)], [...assignRoomColors(grid, 3, 3, 4, 6)]);
  });
});

describe('confiança', () => {
  test('confWeight: 0 até o piso, 1 a partir do teto, crescente e suave no meio', () => {
    assert.equal(confWeight(0), 0);
    assert.equal(confWeight(CONF_NONE), 0);
    assert.equal(confWeight(CONF_FULL), 1);
    assert.equal(confWeight(1), 1);
    assert.equal(confWeight(7), 1);
    assert.equal(confWeight(-1), 0);
    assert.equal(confWeight(NaN), 0);
    assert.equal(confWeight(undefined), 0);
    near(confWeight((CONF_NONE + CONF_FULL) / 2), 0.5, 1e-9);
    let prev = 0;
    for (let c = 0; c <= 1.0001; c += 0.01) {
      const w = confWeight(c);
      assert.ok(w >= prev - 1e-12);
      assert.ok(w - prev < 0.05, 'sem degraus');
      prev = w;
    }
  });

  test('fadeRgb: cor cheia com confiança alta; sem confiança sobra só uma pista da cor', () => {
    for (const name of THEMES) {
      const neutral = hexToRgb(mapTheme(name).neutral);
      const color = [248, 113, 113];
      assert.deepEqual(fadeRgb(color, 1, name), color);
      const washed = fadeRgb(color, 0, name);
      for (let k = 0; k < 3; k++) near(washed[k], neutral[k] + (color[k] - neutral[k]) * CONF_TINT, 1e-9);
      assert.ok(dist(washed, neutral) < dist(washed, color), 'sem confiança fica mais perto do neutro que da cor');
      const half = fadeRgb(color, (CONF_NONE + CONF_FULL) / 2, name);
      assert.ok(dist(half, neutral) > dist(washed, neutral) && dist(half, color) > 1);
    }
  });

  test('smoothInside: média só entre células de dentro; fora continua 0; campo constante não muda', () => {
    const nx = 4;
    const ny = 3;
    const inside = Uint8Array.from([1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0]);
    const flat = smoothInside(new Float32Array(12).fill(0.7).map((v, i) => (inside[i] ? v : 0)), inside, nx, ny, 3);
    for (let i = 0; i < 12; i++) near(flat[i], inside[i] ? 0.7 : 0, 1e-6, `célula ${i}`);
    // um pico no meio se espalha, sem vazar para fora e sem criar valor acima do pico
    const peak = new Float32Array(12);
    peak[5] = 1;
    const out = smoothInside(peak, inside, nx, ny, 1);
    near(out[5], 1 / 9, 1e-6);
    near(out[0], 1 / 4, 1e-6, 'o canto tem só quatro vizinhas de dentro');
    assert.equal(out[3], 0);
    assert.equal(out[7], 0);
    assert.ok(Math.max(...out) <= 1);
    assert.deepEqual([...smoothInside(peak, inside, nx, ny, 0)], [...peak], 'zero passos devolve uma cópia');
    assert.notEqual(smoothInside(peak, inside, nx, ny, 0), peak);
  });
});

describe('caminho', () => {
  test('timeRgb vai da primeira à última cor, passando pela do meio', () => {
    for (const name of THEMES) {
      const stops = mapTheme(name).path.map(hexToRgb);
      assert.deepEqual(timeRgb(0, name), stops[0]);
      assert.deepEqual(timeRgb(0.5, name), stops[1]);
      assert.deepEqual(timeRgb(1, name), stops[2]);
      assert.deepEqual(timeRgb(-2, name), stops[0]);
      assert.deepEqual(timeRgb(5, name), stops[2]);
      const q = timeRgb(0.25, name);
      for (let k = 0; k < 3; k++) near(q[k], (stops[0][k] + stops[1][k]) / 2, 1e-6);
    }
  });
});

describe('pintura das células de um andar', () => {
  // grade 4 x 2: dois ambientes lado a lado e uma coluna de fora
  //   iy=1:  0 0 1 .
  //   iy=0:  0 0 1 .
  function tinyModel(conf = 1) {
    const nx = 4;
    const ny = 2;
    const inside = Uint8Array.from([1, 1, 1, 0, 1, 1, 1, 0]);
    return {
      nx,
      ny,
      cell: 0.5,
      bounds: { minX: 0, minY: 0, maxX: 2, maxY: 1 },
      floors: [
        {
          floor: 0,
          z: 0,
          inside,
          conf: Float32Array.from(inside, (v) => (v ? conf : 0)),
          room: Int16Array.from([0, 0, 1, -1, 0, 0, 1, -1]),
          rooms: [
            { id: 0, label: 'Sala' },
            { id: 1, label: 'Quarto' },
          ],
        },
      ],
    };
  }
  const px = (data, i) => [data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]];

  test('por ambiente: cada célula recebe o tom do seu ambiente e o alfa leva a confiança', () => {
    for (const name of THEMES) {
      const model = tinyModel(1);
      const data = paintFloorCells(model, 0, { theme: name, bleed: 0 });
      assert.ok(data instanceof Uint8ClampedArray);
      assert.equal(data.length, 4 * 2 * 4);
      const palette = roomPalette(name).map(hexToRgb);
      assert.deepEqual(px(data, 0), [...palette[0], 255]);
      assert.deepEqual(px(data, 2), [...palette[1], 255]);
      assert.equal(px(data, 3)[3], 0, 'fora da área: alfa 0');
      assert.deepEqual(px(data, 3).slice(0, 3), hexToRgb(mapTheme(name).neutral));
    }
  });

  test('a confiança baixa vai para o alfa (ou já misturada na cor, com bake)', () => {
    const model = tinyModel(0.2);
    const raw = paintFloorCells(model, 0, { theme: 'dark', bleed: 0 });
    near(px(raw, 0)[3], 0.2 * 255, 1.01);
    const baked = paintFloorCells(model, 0, { theme: 'dark', bleed: 0, bake: true });
    assert.equal(px(baked, 0)[3], 255);
    const expected = fadeRgb(hexToRgb(roomPalette('dark')[0]), 0.2, 'dark');
    for (let k = 0; k < 3; k++) near(px(baked, 0)[k], expected[k], 1.01);
  });

  test('a borda herda a cor da vizinha de dentro (bleed); sem bleed fica neutra', () => {
    const model = tinyModel(1);
    const palette = roomPalette('dark').map(hexToRgb);
    const bled = paintFloorCells(model, 0, { theme: 'dark', bleed: 2 });
    assert.deepEqual(px(bled, 3).slice(0, 3), palette[1], 'a coluna de fora copia o ambiente ao lado');
    assert.equal(px(bled, 3)[3], 255, 'e a confiança dele');
    const baked = paintFloorCells(model, 0, { theme: 'dark', bleed: 2, bake: true });
    assert.equal(px(baked, 3)[3], 255, 'com bake a borda é opaca (quem recorta é o contorno)');
  });

  test('com mapa de calor a cor é a do sinal e a confiança é a menor das duas', () => {
    const model = tinyModel(0.9);
    const n = 8;
    const heat = { dbm: new Float32Array(n).fill(NaN), conf: new Float32Array(n), min: -86, max: -55 };
    heat.dbm[0] = -55;
    heat.conf[0] = 1;
    heat.dbm[1] = -86;
    heat.conf[1] = 0.3;
    heat.dbm[4] = -71;
    heat.conf[4] = 1;
    const data = paintFloorCells(model, 0, { theme: 'dark', heat, bleed: 0 });
    // a confiança é suavizada entre vizinhas: confere a cor exata e a ordem das confianças
    assert.deepEqual(px(data, 0).slice(0, 3), hexToRgb('#34d399'));
    assert.deepEqual(px(data, 1).slice(0, 3), hexToRgb('#f87171'));
    assert.deepEqual(px(data, 4).slice(0, 3), hexToRgb('#fbbf24'));
    assert.deepEqual(px(data, 2).slice(0, 3), hexToRgb(mapTheme('dark').neutral), 'sem medição: neutro');
    assert.ok(px(data, 2)[3] < px(data, 0)[3], 'sem medição a confiança cai');
    assert.ok(px(data, 0)[3] <= Math.round(0.9 * 255), 'nunca acima da confiança do mapa');
  });

  test('rooms: false pinta tudo de neutro; slots escolhe os tons; out reaproveita o vetor', () => {
    const model = tinyModel(1);
    const neutral = hexToRgb(mapTheme('dark').neutral);
    const plain = paintFloorCells(model, 0, { theme: 'dark', rooms: false, bleed: 0 });
    assert.deepEqual(px(plain, 0).slice(0, 3), neutral);
    assert.deepEqual(px(plain, 2).slice(0, 3), neutral);
    const palette = roomPalette('dark').map(hexToRgb);
    const custom = paintFloorCells(model, 0, { theme: 'dark', slots: Uint8Array.from([5, 7]), bleed: 0 });
    assert.deepEqual(px(custom, 0).slice(0, 3), palette[5]);
    assert.deepEqual(px(custom, 2).slice(0, 3), palette[7]);
    const out = new Uint8ClampedArray(32);
    assert.equal(paintFloorCells(model, 0, { theme: 'dark', out }), out);
    assert.notEqual(paintFloorCells(model, 0, { theme: 'dark', out: new Uint8ClampedArray(3) }).length, 3, 'vetor do tamanho errado é ignorado');
  });

  test('aguenta andar sem conf e célula de ambiente -1 dentro da área', () => {
    const model = tinyModel(1);
    delete model.floors[0].conf;
    model.floors[0].room[0] = -1;
    const data = paintFloorCells(model, 0, { theme: 'light', bleed: 0 });
    assert.deepEqual(px(data, 0), [...hexToRgb(mapTheme('light').neutral), 255]);
  });
});
