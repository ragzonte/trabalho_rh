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

  test('trecho sem nome ("Ambiente N", auto) fica na cor neutra: só o ambiente com nome dado ganha cor', () => {
    for (const name of THEMES) {
      const model = tinyModel(1);
      model.floors[0].rooms[1] = { id: 1, label: 'Ambiente 1', auto: true };
      const data = paintFloorCells(model, 0, { theme: name, bleed: 0 });
      const palette = roomPalette(name).map(hexToRgb);
      assert.deepEqual(px(data, 0), [...palette[0], 255], 'o ambiente com nome continua com o tom dele');
      assert.deepEqual(px(data, 2), [...hexToRgb(mapTheme(name).neutral), 255], 'a sobra sem nome não parece um cômodo');
    }
  });
});

// ---------------------------------------------------------------------------
// As contas que os dois visualizadores dividem (app/js/ui/map/viewer2d.js: sem DOM) e o
// mapa de mentira dos testes (tests/helpers/fake-map.mjs). Ficam aqui, junto das cores,
// porque é este arquivo que guarda os testes de unidade do visualizador.
// ---------------------------------------------------------------------------

import {
  DEFAULT_LAYERS,
  simplifyOpen,
  simplifyClosed,
  roundCorners,
  prepareOutline,
  prepareInnerWalls,
  modelExtent,
  cellAt,
  floorIndexOf,
  nearestFloorIndex,
  floorTag,
  approxMeters,
  placeAps,
  pathRuns,
  declutter,
  niceScale,
  isSameMap,
  cleanText,
  namesRoom,
  routerLabel,
  floorPick,
} from '../app/js/ui/map/viewer2d.js';
import { fakeMap, fakeBigMap, relabel, traceOutline, HOSTILE_LABELS } from './helpers/fake-map.mjs';

const ringAreaOf = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a / 2);
};

describe('geometria dos visualizadores', () => {
  test('camadas padrão: tudo ligado menos vizinhos e relevo', () => {
    assert.deepEqual({ ...DEFAULT_LAYERS }, { rooms: true, walls: true, path: true, spots: true, routers: true, neighbours: false, labels: true, relief: false, grid: true });
    assert.ok(Object.isFrozen(DEFAULT_LAYERS));
  });

  test('simplifyOpen tira o que desvia pouco e guarda as pontas e as quinas', () => {
    const line = [[0, 0], [1, 0.01], [2, -0.01], [3, 0], [3, 1], [3, 2]];
    assert.deepEqual(simplifyOpen(line, 0.1), [[0, 0], [3, 0], [3, 2]]);
    assert.deepEqual(simplifyOpen(line, 0.001), line.filter((p) => !(p[0] === 3 && p[1] === 1)), 'com folga mínima só sai o ponto em linha reta');
    assert.deepEqual(simplifyOpen([[0, 0], [1, 1]], 5), [[0, 0], [1, 1]]);
    assert.deepEqual(simplifyOpen([[2, 2]], 5), [[2, 2]]);
  });

  test('simplifyClosed transforma uma escadinha de grade numa diagonal', () => {
    // quadrado girado 45°, desenhado em degraus de 0,25 m
    const ring = [];
    const n = 16;
    const s = 0.25;
    for (let i = 0; i < n; i++) ring.push([i * s, i * s], [(i + 1) * s, i * s]);
    for (let i = 0; i < n; i++) ring.push([n * s - i * s, n * s + i * s], [n * s - i * s - s, n * s + i * s]);
    for (let i = 0; i < n; i++) ring.push([-i * s, 2 * n * s - i * s], [-i * s - s, 2 * n * s - i * s]);
    for (let i = 0; i < n; i++) ring.push([-n * s + i * s, n * s - i * s], [-n * s + i * s + s, n * s - i * s]);
    const out = simplifyClosed(ring, s * 0.8);
    assert.ok(out.length >= 4 && out.length <= 10, `sobraram ${out.length} pontos de ${ring.length}`);
    near(ringAreaOf(out), ringAreaOf(ring), ringAreaOf(ring) * 0.08, 'a área quase não muda');
    assert.deepEqual(simplifyClosed([[0, 0], [1, 0], [1, 1]], 9), [[0, 0], [1, 0], [1, 1]], 'triângulo fica como está');
  });

  test('roundCorners arredonda sem sair mais que o raio da quina e sem mexer nas pontas de linha aberta', () => {
    const square = [[0, 0], [4, 0], [4, 4], [0, 4]];
    const round = roundCorners(square, 0.5, true, 4);
    assert.equal(round.length, 4 * 4, 'quina de 90°: arco de 3 trechos (um a cada ~25°)');
    assert.equal(roundCorners([[0, 0], [4, 0], [4.4, 0.2], [8, 2]], 0.5, false, 4).length, 1 + 2 + 1 + 1, 'quina suave (27°) ganha só um chanfro; ponto em linha reta fica como está');
    for (const p of round) {
      assert.ok(p[0] >= -1e-9 && p[0] <= 4 + 1e-9 && p[1] >= -1e-9 && p[1] <= 4 + 1e-9, 'fica dentro do quadrado');
      const corner = square.reduce((best, c) => Math.min(best, Math.hypot(p[0] - c[0], p[1] - c[1])), Infinity);
      assert.ok(corner <= 0.5 + 1e-9 || p[0] === 0 || p[0] === 4 || p[1] === 0 || p[1] === 4);
    }
    assert.ok(ringAreaOf(round) < 16 && ringAreaOf(round) > 15.5, 'a área cai só o canto');
    const open = roundCorners([[0, 0], [2, 0], [2, 2]], 0.4, false, 3);
    assert.deepEqual(open[0], [0, 0]);
    assert.deepEqual(open[open.length - 1], [2, 2]);
    assert.deepEqual(roundCorners([[0, 0], [1, 0], [2, 0]], 0.4, false), [[0, 0], [1, 0], [2, 0]], 'linha reta não tem quina');
    assert.deepEqual(roundCorners(square, 0, true), square);
  });

  test('prepareOutline: anel fechado do modelo (com o 1º ponto repetido) vira contorno suave de área parecida', () => {
    const fake = fakeMap('apartamento');
    const model = { ...fake.model, floors: fake.model.floors.map((f) => ({ ...f, outline: f.outline.map((r) => [...r, r[0]]) })) };
    const rings = prepareOutline(model, 0);
    assert.equal(rings.length, 1);
    const raw = fake.model.floors[0].outline[0];
    // os degraus da grade (94 pontos) viram poucas quinas, cada uma com um arco de 2 a 5 pontos
    assert.ok(rings[0].length < raw.length * 1.5, `pontos demais: ${rings[0].length} para ${raw.length} do contorno em degraus`);
    near(ringAreaOf(rings[0]), ringAreaOf(raw), ringAreaOf(raw) * 0.06, 'área');
    for (const p of rings[0]) assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
    const first = rings[0][0];
    const last = rings[0][rings[0].length - 1];
    assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-6, 'não repete o primeiro ponto');
  });

  test('prepareOutline: sem outline no modelo, tira o contorno da máscara; lixo é ignorado', () => {
    const fake = fakeMap('kitnet');
    const model = { ...fake.model, floors: fake.model.floors.map((f) => ({ ...f, outline: undefined })) };
    const rings = prepareOutline(model, 0);
    assert.ok(rings.length >= 1);
    near(ringAreaOf(rings[0]), fake.model.quality.areaM2, fake.model.quality.areaM2 * 0.08, 'área');
    const junk = { ...fake.model, floors: [{ ...fake.model.floors[0], inside: undefined, outline: [[[0, 0]], 'x', [[NaN, 1], [2, NaN], [3, 3]], [[0, 0], [0.01, 0], [0, 0.01]]] }] };
    assert.deepEqual(prepareOutline(junk, 0), []);
  });

  test('prepareInnerWalls emenda os degraus em poucas linhas, com a confiança média e sem toquinhos', () => {
    const fake = fakeMap('apartamento');
    const floor = fake.model.floors[0];
    const raw = floor.walls.filter((w) => w.kind === 'inner');
    const lines = prepareInnerWalls(fake.model, 0);
    assert.ok(lines.length >= 3 && lines.length < raw.length / 2, `${raw.length} trechos viraram ${lines.length} linhas`);
    for (const l of lines) {
      assert.ok(l.points.length >= 2);
      assert.ok(l.conf >= 0 && l.conf <= 1);
      assert.ok(l.length >= 0.6);
      for (const p of l.points) assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
    }
    assert.deepEqual(prepareInnerWalls({ ...fake.model, floors: [{ ...floor, walls: undefined }] }, 0), []);
    // um trecho só, comprido, com confiança inválida: entra com 0,5
    const one = prepareInnerWalls({ ...fake.model, floors: [{ ...floor, walls: [{ x1: 0, y1: 0, x2: 2, y2: 0, kind: 'inner', conf: NaN }, { x1: 5, y1: 5, x2: 5.1, y2: 5, kind: 'inner', conf: 1 }] }] }, 0);
    assert.equal(one.length, 1);
    assert.equal(one[0].conf, 0.5);
  });

  test('modelExtent envolve a área de todos os andares; sem área, a grade inteira', () => {
    const fake = fakeMap('sobrado');
    const e = modelExtent(fake.model);
    const b = fake.model.bounds;
    assert.ok(e.minX >= b.minX && e.maxX <= b.maxX && e.minY >= b.minY && e.maxY <= b.maxY);
    assert.ok(e.w > 5 && e.h > 5);
    near(e.cx, (e.minX + e.maxX) / 2, 1e-9);
    near(e.radius, Math.hypot(e.w, e.h) / 2, 1e-9);
    // (o contorno do mapa de mentira é arredondado ao milímetro)
    for (const f of fake.model.floors) for (const ring of f.outline) for (const p of ring) assert.ok(p[0] >= e.minX - 1e-3 && p[0] <= e.maxX + 1e-3 && p[1] >= e.minY - 1e-3 && p[1] <= e.maxY + 1e-3);
    const empty = modelExtent({ ...fake.model, floors: fake.model.floors.map((f) => ({ ...f, inside: new Uint8Array(f.inside.length) })) });
    assert.equal(empty.minX, b.minX);
    assert.equal(empty.maxY, b.maxY);
  });

  test('cellAt, floorIndexOf, nearestFloorIndex e floorTag', () => {
    const { model } = fakeMap('sobrado');
    const { bounds, cell, nx } = model;
    assert.equal(cellAt(model, bounds.minX + cell * 0.5, bounds.minY + cell * 0.5), 0);
    assert.equal(cellAt(model, bounds.minX + cell * 2.5, bounds.minY + cell * 1.5), nx + 2);
    assert.equal(cellAt(model, bounds.minX - 0.01, bounds.minY), -1);
    assert.equal(cellAt(model, bounds.maxX + 0.01, bounds.minY), -1);
    assert.equal(floorIndexOf(model, 0), 0);
    assert.equal(floorIndexOf(model, 1), 1);
    assert.equal(floorIndexOf(model, 2), -1);
    assert.equal(floorIndexOf(model, null), -1);
    assert.equal(nearestFloorIndex(model, 0), 0);
    assert.equal(nearestFloorIndex(model, 1.2), 0, 'celular na mão no térreo');
    assert.equal(nearestFloorIndex(model, 2.8), 1);
    assert.equal(nearestFloorIndex(model, 4), 1);
    assert.equal(nearestFloorIndex(model, 99), 1);
    assert.equal(floorTag(0), 'Andar de partida');
    assert.equal(floorTag(1), '1 andar acima');
    assert.equal(floorTag(2), '2 andares acima');
    assert.equal(floorTag(-1), '1 andar abaixo');
  });

  test('approxMeters e niceScale falam como gente: "≈", vírgula e metros redondos', () => {
    assert.equal(approxMeters(5.94), '≈ 5,9 m');
    assert.equal(approxMeters(7), '≈ 7 m');
    assert.equal(approxMeters(13.6), '≈ 14 m');
    assert.equal(approxMeters(NaN), '');
    const s = niceScale(40, 96);
    assert.deepEqual([s.meters, s.px, s.label], [2, 80, '≈ 2 m']);
    assert.equal(niceScale(300, 96).meters, 0.5);
    assert.equal(niceScale(300, 96).label, '≈ 0,5 m');
    assert.equal(niceScale(0.9, 96).meters, 100);
    assert.equal(niceScale(0, 96), null);
    assert.equal(niceScale(NaN, 96), null);
    for (const k of [3, 11, 27, 60, 140]) assert.ok(niceScale(k, 96).px <= 96, 'a barra cabe');
  });

  test('placeAps: os da casa no lugar; vizinho distante preso ao anel, na direção certa, com a distância', () => {
    const { model } = fakeMap('apartamento');
    const extent = modelExtent(model);
    const placed = placeAps(model, extent);
    assert.ok(placed.ring > extent.radius);
    assert.equal(placed.items.length, model.aps.length);
    for (const item of placed.items) {
      const d = Math.hypot(item.x - extent.cx, item.y - extent.cy);
      assert.ok(d <= placed.ring + 1e-6, 'ninguém fica além do anel');
      assert.ok(item.floorIndex >= 0 && item.floorIndex < model.floors.length);
      if (item.clamped) {
        near(d, placed.ring, 1e-6, 'preso exatamente no anel');
        near(Math.atan2(item.ap.y - extent.cy, item.ap.x - extent.cx), item.angle, 1e-9, 'na direção do roteador');
        assert.equal(item.distanceM, item.ap.distanceM);
        assert.equal(item.ap.inside, false);
      } else {
        assert.equal(item.x, item.ap.x);
        assert.equal(item.y, item.ap.y);
      }
    }
    assert.ok(placed.items.some((i) => i.clamped), 'o apartamento tem vizinhos distantes');
    assert.ok(placed.items.filter((i) => i.ap.own).every((i) => !i.clamped), 'o roteador da casa fica onde está');
    // vizinho de outro andar: marcado como acima ou abaixo
    const up = placeAps({ ...model, aps: [{ ...model.aps[0], own: false, floor: 3 }, { ...model.aps[0], own: false, floor: -2 }, { ...model.aps[0], x: NaN }] }, extent);
    assert.deepEqual(up.items.map((i) => i.storey), [1, -1]);
    assert.equal(placeAps({ ...model, aps: undefined }, extent).items.length, 0);
    assert.equal(placeAps({ ...model, aps: Array.from({ length: 40 }, () => ({ ...model.aps[1], own: false })) }, extent, 24).items.length, 24, 'há um teto de vizinhos desenhados');
  });

  test('pathRuns: um trecho por andar, suave, com tempo 0..1 crescente e a ligação entre andares', () => {
    const { model } = fakeMap('sobrado');
    const { runs, links } = pathRuns(model, 5);
    assert.ok(runs.length >= 2, 'há trechos nos dois andares');
    assert.ok(links.length >= 1, 'e pelo menos uma subida de escada');
    let lastT = -1;
    for (const run of runs) {
      assert.ok(run.points.length > 4);
      let lastD = -1;
      for (const p of run.points) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        assert.ok(p.t >= lastT - 1e-9 && p.t >= 0 && p.t <= 1, 'tempo cresce');
        assert.ok(p.d > lastD, 'distância cresce');
        assert.ok(p.conf >= 0 && p.conf <= 1);
        lastT = p.t;
        lastD = p.d;
      }
    }
    near(runs[0].points[0].t, 0, 1e-9);
    near(lastT, 1, 1e-9);
    assert.ok(runs.reduce((n, r) => n + r.points.length, 0) > model.path.length * 3, 'mais pontos que o caminho bruto (curva suave)');
    for (const l of links) assert.notEqual(l.from.floorIndex, l.to.floorIndex);
    // as pontas do trecho continuam onde o caminho começa e acaba
    near(runs[0].points[0].x, model.path[0].x, 1e-9);
    assert.deepEqual(pathRuns({ ...model, path: [] }), { runs: [], links: [] });
    assert.deepEqual(pathRuns({ ...model, path: [model.path[0]] }), { runs: [], links: [] });
    assert.equal(pathRuns({ ...model, path: model.path.map((p, i) => (i % 2 ? p : { ...p, x: NaN })) }).runs.length >= 1, true, 'pontos inválidos são pulados');
  });

  test('declutter: o mais importante fica, o que bate nele some, quem não bate fica', () => {
    const boxes = [
      { x: 0, y: 0, w: 50, h: 20, priority: 1 },
      { x: 30, y: 5, w: 50, h: 20, priority: 5 },
      { x: 200, y: 0, w: 50, h: 20, priority: 0 },
      { x: 82, y: 5, w: 10, h: 20, priority: 3 }, // encosta no segundo com a folga
      { x: 0, y: 0, w: 5, h: 5, priority: 99, skip: true },
    ];
    assert.deepEqual(declutter(boxes, 4), [false, true, true, false, false]);
    assert.deepEqual(declutter(boxes, 0), [false, true, true, true, false]);
    assert.deepEqual(declutter([]), []);
    // empate: vence quem veio antes
    assert.deepEqual(declutter([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }]), [true, false]);
  });

  test('isSameMap: o mesmo levantamento crescendo é o mesmo mapa; outro levantamento não', () => {
    const half = fakeMap('apartamento', { progress: 0.5 }).model;
    const more = fakeMap('apartamento', { progress: 0.8 }).model;
    const other = fakeMap('escritorio').model;
    assert.equal(isSameMap(half, more), true);
    assert.equal(isSameMap(half, half), true);
    assert.equal(isSameMap(more, half), false, 'o caminho não encolhe');
    assert.equal(isSameMap(half, other), false);
    assert.equal(isSameMap(null, half), false);
    assert.equal(isSameMap(half, null), false);
    assert.equal(isSameMap({ ...half, path: [] }, more), false);
    // mesmo começo, mas a casa "triplicou" de repente: outro mapa
    const big = fakeBigMap({ nx: 200, ny: 200, floors: 1, pathPoints: 80 }).model;
    assert.equal(isSameMap(half, { ...big, path: [{ ...big.path[0], t: half.path[0].t }, ...big.path.slice(1)] }), false);
  });

  test('cleanText: sem caracteres de controle nem de direção, espaços em ordem, tamanho com teto', () => {
    assert.equal(cleanText('  Sala   de\n\testar  '), 'Sala de estar');
    assert.equal(cleanText('a\u0000b‮c⁦d'), 'a b c d');
    assert.equal(cleanText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>', 'HTML é só texto');
    assert.equal(cleanText('   ', 'Sem nome'), 'Sem nome');
    assert.equal(cleanText(null, 'x'), 'x');
    assert.equal(cleanText(undefined), '');
    assert.equal(cleanText(42), '42');
    assert.equal(Array.from(cleanText('😀'.repeat(300))).length, 96, 'corta por caractere, sem partir um emoji');
  });

  test('namesRoom e routerLabel evitam repetir nomes no mapa', () => {
    const floor = { rooms: [{ label: 'Sala ' }, { label: 'Quarto 1' }] };
    assert.equal(namesRoom(floor, 'sala'), true);
    assert.equal(namesRoom(floor, 'Cozinha'), false);
    assert.equal(namesRoom(floor, ''), false);
    assert.equal(namesRoom({}, 'Sala'), false);
    const seen = new Set();
    const a = { ap: { ssid: 'Familia Souza' }, clamped: false, distanceM: 3 };
    const b = { ap: { ssid: 'familia souza' }, clamped: false, distanceM: 4 };
    const c = { ap: { ssid: 'Familia Souza' }, clamped: true, distanceM: 14.2 };
    const hidden = { ap: { ssid: '' }, clamped: false };
    assert.deepEqual(routerLabel(a, seen), { kind: 'router', text: 'Familia Souza', detail: '', iconOnly: false });
    assert.equal(routerLabel(b, seen).iconOnly, true, 'o segundo aparelho com o mesmo nome mostra só o ícone');
    assert.deepEqual([routerLabel(c, seen).iconOnly, routerLabel(c, seen).detail], [false, '≈ 14 m'], 'preso ao anel, mostra nome e distância');
    assert.equal(routerLabel(hidden, seen).iconOnly, false);
    assert.equal(routerLabel({ ap: { ssid: '' }, clamped: false }, seen).iconOnly, false, 'rede oculta nunca conta como repetida');
  });

  test('floorPick: ambiente sem mapa de calor, lugar com o sinal quando há, nada fora da área', () => {
    const fake = fakeMap('apartamento');
    const { model } = fake;
    const room = model.floors[0].rooms[0];
    const hit = floorPick(model, null, 0, room.cx, room.cy);
    assert.equal(hit.kind, 'room');
    assert.equal(hit.roomId, room.id);
    assert.equal(hit.label, room.label);
    assert.equal(hit.floor, 0);
    assert.equal(hit.dbm, null);
    assert.equal(hit.cell, hit.iy * model.nx + hit.ix);
    const heat = fake.heat(model.networks[0].key);
    const cellHit = floorPick(model, heat, 0, room.cx, room.cy);
    assert.equal(cellHit.kind, 'cell');
    assert.equal(cellHit.roomId, room.id);
    near(cellHit.dbm, heat[0].dbm[cellHit.cell], 1e-9);
    assert.equal(floorPick(model, null, 0, model.bounds.minX + 0.01, model.bounds.minY + 0.01), null, 'canto da grade: fora da área');
    assert.equal(floorPick(model, null, 0, 1e6, 0), null);
    assert.equal(floorPick(model, null, 7, room.cx, room.cy), null, 'andar que não existe');
  });
});

describe('mapa de mentira dos testes (fake-map.mjs)', () => {
  const isTyped = (v, Type, n) => v instanceof Type && v.length === n;

  for (const world of ['apartamento', 'sobrado', 'escritorio', 'kitnet']) {
    test(`${world}: o modelo segue o contrato de MapModel`, () => {
      const fake = fakeMap(world);
      const m = fake.model;
      assert.equal(m.version, 1);
      assert.ok(m.cell >= 0.2 && m.cell <= 0.5);
      near((m.bounds.maxX - m.bounds.minX) / m.cell, m.nx, 1e-6);
      near((m.bounds.maxY - m.bounds.minY) / m.cell, m.ny, 1e-6);
      assert.equal(m.floors.length, world === 'sobrado' ? 2 : 1);
      const n = m.nx * m.ny;
      const ids = new Set();
      for (const f of m.floors) {
        assert.ok(isTyped(f.inside, Uint8Array, n) && isTyped(f.conf, Float32Array, n) && isTyped(f.room, Int16Array, n));
        near(f.z, f.floor * 2.8, 1e-9);
        let area = 0;
        for (let c = 0; c < n; c++) {
          assert.ok(f.inside[c] === 0 || f.inside[c] === 1);
          if (f.inside[c]) {
            area++;
            assert.ok(f.conf[c] > 0 && f.conf[c] <= 1);
            assert.ok(f.room[c] >= 0 && f.room[c] < f.rooms.length, 'toda célula de dentro tem ambiente');
          } else {
            assert.equal(f.room[c], -1);
          }
        }
        assert.ok(area > 50);
        assert.ok(f.outline.length >= 1);
        assert.ok(f.rooms.length >= 2);
        for (const r of f.rooms) {
          assert.ok(!ids.has(r.id), 'ids de ambiente não se repetem entre andares');
          ids.add(r.id);
          assert.equal(typeof r.label, 'string');
          assert.equal(typeof r.auto, 'boolean');
          assert.ok(r.areaM2 > 0 && Number.isFinite(r.cx) && Number.isFinite(r.cy));
          const c = cellAt(m, r.cx, r.cy);
          assert.equal(f.rooms[f.room[c]], r, `o centro de ${r.label} cai dentro do próprio ambiente`);
        }
        assert.ok(f.walls.some((w) => w.kind === 'outer') && f.walls.some((w) => w.kind === 'inner'));
        for (const w of f.walls) assert.ok(w.conf >= 0 && w.conf <= 1 && Number.isFinite(w.x1 + w.y1 + w.x2 + w.y2));
      }
      assert.ok(m.floors.some((f) => f.rooms.some((r) => r.auto)), 'há pelo menos um ambiente sem nome dado');
      assert.ok(m.aps.length >= 2 && m.aps[0].own === true, 'os roteadores da casa vêm primeiro');
      for (const a of m.aps) {
        assert.ok(a.bssids.includes(a.id));
        assert.ok(a.conf >= 0 && a.conf <= 1 && a.bestRssi < 0 && a.distanceM >= 0);
        near(Math.hypot(a.x, a.y), a.distanceM, 0.06);
      }
      assert.ok(m.networks.length >= 2 && m.networks[0].own === true);
      assert.equal(new Set(m.networks.map((x) => x.key)).size, m.networks.length);
      assert.ok(m.path.length > 20);
      for (let i = 1; i < m.path.length; i++) assert.ok(m.path[i].t > m.path[i - 1].t && m.path[i].i === m.path[i - 1].i + 1);
      assert.ok(m.spots.length >= 1 && m.spots.every((s) => typeof s.label === 'string' && s.label));
      assert.equal(m.quality.scans, m.path.length);
      assert.ok(['boa', 'razoavel', 'fraca'].includes(m.quality.level));
      // campos de sinal: um por andar, NaN só fora da área, mínimo e máximo coerentes
      for (const net of m.networks) {
        const fields = fake.heat(net.key);
        assert.equal(fields.length, m.floors.length);
        fields.forEach((h, fi) => {
          assert.ok(isTyped(h.dbm, Float32Array, n) && isTyped(h.conf, Float32Array, n));
          for (let c = 0; c < n; c++) {
            if (m.floors[fi].inside[c]) assert.ok(h.dbm[c] >= h.min - 1e-3 && h.dbm[c] <= h.max + 1e-3);
            else assert.ok(Number.isNaN(h.dbm[c]));
          }
          assert.ok(h.max > h.min && h.max < -20 && h.min >= -100);
        });
      }
      assert.equal(fake.heat(m.networks[0].key), fake.heat(m.networks[0].key), 'o campo fica guardado');
      assert.throws(() => fake.heat('não existe'), /rede desconhecida/);
    });
  }

  test('é determinístico; a semente e o progresso mudam o resultado', () => {
    const a = fakeMap('kitnet').model;
    const b = fakeMap('kitnet').model;
    assert.deepEqual(a.path, b.path);
    assert.deepEqual([...a.floors[0].inside], [...b.floors[0].inside]);
    assert.notDeepEqual(fakeMap('kitnet', { seed: 2 }).model.path.slice(0, 3), a.path.slice(0, 3));
    const half = fakeMap('apartamento', { progress: 0.5 }).model;
    const full = fakeMap('apartamento').model;
    assert.ok(half.path.length < full.path.length);
    assert.equal(half.path[0].t, full.path[0].t);
    assert.ok(half.quality.areaM2 < full.quality.areaM2, 'andou menos, mapeou menos');
  });

  test('traceOutline: um quadrado, um quadrado com buraco e duas células que só se tocam pela ponta', () => {
    const square = traceOutline(Uint8Array.from([1, 1, 1, 1]), 2, 2);
    assert.equal(square.length, 1);
    assert.equal(square[0].length, 4);
    assert.equal(ringAreaOf(square[0]), 4);
    const donut = traceOutline(Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]), 3, 3);
    assert.deepEqual(donut.map(ringAreaOf).sort(), [1, 9]);
    const diagonal = traceOutline(Uint8Array.from([1, 0, 0, 1]), 2, 2);
    assert.equal(diagonal.length, 2, 'duas áreas separadas, não um "8"');
    assert.deepEqual(diagonal.map(ringAreaOf), [1, 1]);
    assert.deepEqual(traceOutline(new Uint8Array(4), 2, 2), []);
  });

  test('relabel troca os nomes sem mexer no modelo original', () => {
    const { model } = fakeMap('apartamento');
    const before = model.floors[0].rooms[0].label;
    const hostile = relabel(model);
    assert.equal(model.floors[0].rooms[0].label, before);
    assert.equal(hostile.floors[0].rooms[0].label, HOSTILE_LABELS[0]);
    assert.equal(hostile.floors[0].inside, model.floors[0].inside, 'as grades são as mesmas');
    assert.ok(hostile.aps.some((a) => HOSTILE_LABELS.includes(a.ssid)));
    assert.equal(relabel(model, ['A', 'B']).floors[0].rooms[2].label, 'A');
  });

  test('fakeBigMap: o tamanho pedido (200 x 200, 3 andares, 300 pontos) e um campo de sinal por andar', () => {
    const big = fakeBigMap();
    const m = big.model;
    assert.deepEqual([m.nx, m.ny, m.floors.length, m.path.length], [200, 200, 3, 300]);
    for (const f of m.floors) {
      assert.equal(f.inside.length, 40000);
      assert.ok(f.rooms.length >= 6 && f.outline.length >= 1 && f.walls.length > 50);
    }
    const heat = big.heat();
    assert.equal(heat.length, 3);
    assert.ok(heat[0].max > heat[2].max, 'o sinal cai nos andares de cima');
    const small = fakeBigMap({ nx: 40, ny: 30, floors: 1, pathPoints: 20 }).model;
    assert.deepEqual([small.nx, small.ny, small.floors.length, small.path.length], [40, 30, 1, 20]);
  });
});
