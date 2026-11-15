// Contas do gráfico de canais (ui/charts/channel-graph-layout.js) e a lógica pura da tela
// Canais (ui/screens/channels.js): nada aqui precisa de navegador.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  GAP_PX,
  mergeSections,
  createFreqAxis,
  zoomAt,
  createDbmAxis,
  pickTickLabels,
  placeLabels,
  truncateText,
  hitTest,
  nextInCycle,
  maxZoomFor,
} from '../app/js/ui/charts/channel-graph-layout.js';
import {
  BAND_KEYS,
  parseBandParam,
  readQuery,
  bandSummary,
  pickBand,
  ownCandidates,
  pickOwn,
  ownExclusion,
  widthsFor,
  defaultWidth,
  scoreLevel,
  buildRanking,
  orderRanking,
  interferers,
  crowdText,
  explainRating,
} from '../app/js/ui/screens/channels.js';
import { rateChannels, recommendChannel, channelGraph } from '../app/js/core/channel-rating.js';
import { normalizeScan, groupByDevice } from '../app/js/core/model.js';
import { apartment, apartmentTruth, office, mesh, meshTruth, makeAp, withAps, CW } from './fixtures/scans.mjs';

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'valor'}: esperado ${expected} ± ${tol}, veio ${actual}`);
/** Medidor de texto de mentira: 7 px por caractere (cada "letra" visível conta uma vez). */
const measure = (text) => Array.from(text).length * 7;

const SECTIONS_24 = [{ minFreq: 2400, maxFreq: 2484 }];
const SECTIONS_5 = [
  { minFreq: 5150, maxFreq: 5350 },
  { minFreq: 5470, maxFreq: 5730 },
  { minFreq: 5730, maxFreq: 5850 },
];

// ---------------------------------------------------------------------------
// Eixo das frequências
// ---------------------------------------------------------------------------

describe('mergeSections', () => {
  test('junta trechos que se encostam e mantém os separados', () => {
    assert.deepEqual(mergeSections(SECTIONS_5), [
      { minFreq: 5150, maxFreq: 5350 },
      { minFreq: 5470, maxFreq: 5850 },
    ]);
    assert.deepEqual(mergeSections(SECTIONS_24), SECTIONS_24);
  });

  test('ordena, funde sobreposições e ignora lixo', () => {
    const out = mergeSections([{ minFreq: 300, maxFreq: 400 }, null, { minFreq: 100, maxFreq: 200 }, { minFreq: 150, maxFreq: 320 }, { minFreq: 9, maxFreq: 9 }, { minFreq: 'x', maxFreq: 2 }]);
    assert.deepEqual(out, [{ minFreq: 100, maxFreq: 400 }]);
    assert.deepEqual(mergeSections(null), []);
  });

  test('não altera a lista recebida', () => {
    const input = SECTIONS_5.map((s) => ({ ...s }));
    mergeSections(input);
    assert.deepEqual(input, SECTIONS_5);
  });
});

describe('createFreqAxis', () => {
  test('2,4 GHz: uma reta só, de ponta a ponta', () => {
    const axis = createFreqAxis({ sections: SECTIONS_24, width: 336 });
    assert.equal(axis.segments.length, 1);
    assert.equal(axis.breaks.length, 0);
    near(axis.pxPerMHz, 4, 1e-9);
    near(axis.x(2400), 0, 1e-9);
    near(axis.x(2484), 336, 1e-9);
    near(axis.x(2437), 148, 1e-9, 'canal 6');
    near(axis.freq(148), 2437, 1e-9);
  });

  test('5 GHz: o buraco entre o canal 64 e o 100 vira uma faixa estreita de largura fixa', () => {
    const width = 300;
    const axis = createFreqAxis({ sections: SECTIONS_5, width });
    assert.equal(axis.segments.length, 2, '100–144 e 149–165 não têm buraco entre eles');
    assert.equal(axis.breaks.length, 1);
    const [a, b] = axis.segments;
    near(a.x0, 0, 1e-9);
    near(b.x1, width, 1e-9, 'o último trecho termina na borda direita');
    near(b.x0 - a.x1, GAP_PX, 1e-9, 'largura do buraco');
    near(axis.breaks[0].x, a.x1 + GAP_PX / 2, 1e-9);
    // a mesma escala nos dois trechos: 580 MHz úteis dividem a largura que sobra
    near(axis.pxPerMHz, (width - GAP_PX) / 580, 1e-9);
    near((a.x1 - a.x0) / 200, (b.x1 - b.x0) / 380, 1e-9);
    // sem o buraco comprimido, 120 MHz vazios ocupariam bem mais que isso
    assert.ok(GAP_PX < 120 * axis.pxPerMHz);
  });

  test('x() é crescente, inclusive por dentro do buraco e fora dos trechos', () => {
    const axis = createFreqAxis({ sections: SECTIONS_5, width: 320 });
    let last = -Infinity;
    for (let f = 5100; f <= 5900; f += 5) {
      const x = axis.x(f);
      assert.ok(Number.isFinite(x), `x(${f})`);
      assert.ok(x >= last - 1e-9, `x(${f}) = ${x} depois de ${last}`);
      last = x;
    }
    const [a, b] = axis.segments;
    assert.ok(axis.x(5400) > a.x1 && axis.x(5400) < b.x0, 'uma frequência do buraco cai dentro dele');
    assert.ok(axis.x(5100) < 0, 'antes do começo: à esquerda da área');
  });

  test('freq() devolve null no buraco e fora da área; ida e volta nos trechos', () => {
    const axis = createFreqAxis({ sections: SECTIONS_5, width: 320 });
    assert.equal(axis.freq(axis.breaks[0].x), null);
    assert.equal(axis.freq(-5), null);
    assert.equal(axis.freq(999), null);
    assert.equal(axis.freq(NaN), null);
    for (const f of [5180, 5260, 5320, 5500, 5745, 5825]) near(axis.freq(axis.x(f)), f, 1e-6, `ida e volta de ${f}`);
  });

  test('xIn() segue a reta de um trecho mesmo fora dele (para desenhar o que vaza)', () => {
    const axis = createFreqAxis({ sections: SECTIONS_5, width: 320 });
    const [a] = axis.segments;
    near(axis.xIn(a, 5350), a.x1, 1e-9);
    near(axis.xIn(a, 5370), a.x1 + 20 * axis.pxPerMHz, 1e-9);
    assert.equal(axis.segmentOf(5200), a);
    assert.equal(axis.segmentOf(5400), null);
    assert.equal(axis.segmentAt(a.x1 - 1), a);
  });

  test('zoom: o conteúdo alarga, a rolagem é limitada e desloca tudo', () => {
    const base = createFreqAxis({ sections: SECTIONS_24, width: 300 });
    const zoomed = createFreqAxis({ sections: SECTIONS_24, width: 300, zoom: 3, scroll: 250 });
    near(zoomed.contentWidth, 900, 1e-9);
    near(zoomed.maxScroll, 600, 1e-9);
    near(zoomed.pxPerMHz, base.pxPerMHz * 3, 1e-9);
    near(zoomed.x(2400), -250, 1e-9);
    assert.equal(createFreqAxis({ sections: SECTIONS_24, width: 300, zoom: 3, scroll: 5000 }).scroll, 600);
    assert.equal(createFreqAxis({ sections: SECTIONS_24, width: 300, zoom: 3, scroll: -40 }).scroll, 0);
    assert.equal(createFreqAxis({ sections: SECTIONS_24, width: 300, zoom: 0.2 }).zoom, 1, 'zoom nunca fica abaixo de 1');
  });

  test('com zoom o buraco continua com a mesma largura', () => {
    const axis = createFreqAxis({ sections: SECTIONS_5, width: 300, zoom: 4 });
    near(axis.segments[1].x0 - axis.segments[0].x1, GAP_PX, 1e-9);
    near(axis.segments[1].x1, 1200, 1e-9);
  });

  test('entrada vazia ou torta não quebra', () => {
    const axis = createFreqAxis({ sections: [], width: 300 });
    assert.equal(axis.segments.length, 0);
    assert.ok(Number.isNaN(axis.x(2437)));
    assert.equal(axis.freq(10), null);
    assert.equal(createFreqAxis({ sections: SECTIONS_24, width: 0 }).pxPerMHz, 0);
    assert.equal(createFreqAxis().segments.length, 0);
  });
});

describe('zoomAt', () => {
  const view = { sections: SECTIONS_24, width: 300, zoom: 1, scroll: 0 };

  test('a frequência debaixo do dedo fica parada', () => {
    const before = createFreqAxis(view);
    const f = before.freq(210);
    const next = zoomAt(view, 2.5, 210);
    const after = createFreqAxis({ ...view, ...next });
    assert.equal(next.zoom, 2.5);
    near(after.x(f), 210, 1e-6);
  });

  test('sem âncora usa o meio; nas bordas a rolagem é limitada', () => {
    const mid = zoomAt(view, 2);
    near(mid.scroll, 150, 1e-6);
    assert.equal(zoomAt(view, 2, 0).scroll, 0);
    near(zoomAt(view, 2, 300).scroll, 300, 1e-6);
  });

  test('voltar para 1 zera a rolagem', () => {
    assert.deepEqual(zoomAt({ ...view, zoom: 3, scroll: 400 }, 1, 100), { zoom: 1, scroll: 0 });
    assert.deepEqual(zoomAt({ ...view, zoom: 3, scroll: 400 }, 0.4, 100), { zoom: 1, scroll: 0 });
  });

  test('âncora em cima do buraco dos 5 GHz: ainda devolve uma rolagem válida', () => {
    const v = { sections: SECTIONS_5, width: 300, zoom: 1, scroll: 0 };
    const gapX = createFreqAxis(v).breaks[0].x;
    const next = zoomAt(v, 3, gapX);
    const axis = createFreqAxis({ ...v, ...next });
    assert.ok(next.scroll >= 0 && next.scroll <= axis.maxScroll);
    near(axis.breaks[0].x, gapX, GAP_PX, 'o buraco continua perto do dedo');
  });
});

// ---------------------------------------------------------------------------
// Eixo do sinal
// ---------------------------------------------------------------------------

describe('createDbmAxis', () => {
  test('teto e chão nos px certos, ida e volta', () => {
    const axis = createDbmAxis({ minDbm: -100, maxDbm: -30, top: 20, bottom: 230 });
    near(axis.y(-100), 230, 1e-9);
    near(axis.y(-30), 20, 1e-9);
    near(axis.pxPerDb, 3, 1e-9);
    near(axis.dbm(axis.y(-57)), -57, 1e-9);
  });

  test('linhas de 10 em 10 dB; números de 10 em 10 só quando há altura', () => {
    const tall = createDbmAxis({ minDbm: -100, maxDbm: -30, top: 0, bottom: 280, minLabelGap: 30 });
    assert.deepEqual(
      tall.ticks.filter((t) => t.label).map((t) => t.dbm),
      [-90, -80, -70, -60, -50, -40, -30],
    );
    const short = createDbmAxis({ minDbm: -100, maxDbm: -30, top: 0, bottom: 200, minLabelGap: 40 });
    assert.deepEqual(
      short.ticks.filter((t) => t.label).map((t) => t.dbm),
      [-80, -60, -40],
    );
    assert.equal(short.ticks.length, 8, 'as marcas continuam de 10 em 10');
    assert.equal(short.ticks[0].label, false, 'o chão não leva número');
  });

  test('limites ausentes ou invertidos caem num intervalo válido', () => {
    const axis = createDbmAxis({ minDbm: -100, maxDbm: -120, top: 0, bottom: 100 });
    assert.ok(axis.maxDbm > axis.minDbm);
    assert.ok(Number.isFinite(axis.y(-50)));
  });
});

// ---------------------------------------------------------------------------
// Números do eixo e nomes das redes
// ---------------------------------------------------------------------------

describe('pickTickLabels', () => {
  const ticks = Array.from({ length: 13 }, (_, i) => ({ channel: i + 1, freq: 2412 + 5 * i }));
  const noClash = (labels, gap) => {
    for (let i = 1; i < labels.length; i++) {
      const a = labels[i - 1];
      const b = labels[i];
      assert.ok(b.x - b.width / 2 - (a.x + a.width / 2) >= gap - 1e-9, `"${a.text}" encosta em "${b.text}"`);
    }
  };

  test('com espaço, todos os canais ganham número', () => {
    const axis = createFreqAxis({ sections: SECTIONS_24, width: 336 });
    const labels = pickTickLabels(ticks, { x: (t) => axis.x(t.freq), measure, minGap: 4 });
    assert.deepEqual(labels.map((l) => l.text), ticks.map((t) => String(t.channel)));
    noClash(labels, 4);
  });

  test('apertado: os de maior prioridade ficam e ninguém encosta em ninguém', () => {
    const axis = createFreqAxis({ sections: SECTIONS_24, width: 170 });
    const priority = (t) => ([1, 6, 11].includes(t.channel) ? 100 : t.channel === 9 ? 300 : 0);
    const labels = pickTickLabels(ticks, { x: (t) => axis.x(t.freq), measure, priority, minGap: 5 });
    const shown = labels.map((l) => l.tick.channel);
    for (const ch of [1, 6, 9, 11]) assert.ok(shown.includes(ch), `canal ${ch} aparece`);
    assert.ok(shown.length < 13);
    noClash(labels, 5);
    assert.deepEqual(shown, [...shown].sort((a, b) => a - b), 'saem em ordem de frequência');
  });

  test('números que não cabem inteiros entre os limites ficam de fora', () => {
    const axis = createFreqAxis({ sections: SECTIONS_24, width: 336, zoom: 3, scroll: 336 });
    const labels = pickTickLabels(ticks, { x: (t) => axis.x(t.freq), measure, left: 0, right: 336 });
    assert.ok(labels.length > 0 && labels.length < 13);
    for (const l of labels) assert.ok(l.x - l.width / 2 >= -0.5 && l.x + l.width / 2 <= 336.5);
  });

  test('lista vazia', () => {
    assert.deepEqual(pickTickLabels([], { x: () => 0, measure }), []);
    assert.deepEqual(pickTickLabels(null, { x: () => 0, measure }), []);
  });
});

describe('placeLabels', () => {
  const bounds = { left: 0, right: 300, top: 0, bottom: 200 };
  const hit = (a, b, gap = 0) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
  const assertNoOverlap = (placed) => {
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) assert.ok(!hit(placed[i], placed[j]), `${placed[i].id} cobre ${placed[j].id}`);
  };

  test('um nome sozinho fica centrado logo acima do pico', () => {
    const [box] = placeLabels([{ id: 'a', cx: 150, top: 100, w: 60, h: 16 }], bounds, { lift: 4 });
    assert.deepEqual({ x: box.x, y: box.y, level: box.level, inside: box.inside }, { x: 120, y: 80, level: 0, inside: false });
  });

  test('perto da borda o nome é empurrado para dentro', () => {
    const placed = placeLabels(
      [
        { id: 'esq', cx: 5, top: 100, w: 80, h: 16 },
        { id: 'dir', cx: 298, top: 100, w: 80, h: 16 },
      ],
      bounds,
    );
    assert.equal(placed.find((p) => p.id === 'esq').x, 0);
    assert.equal(placed.find((p) => p.id === 'dir').x, 220);
  });

  test('dois picos no mesmo lugar: o de maior prioridade fica embaixo e o outro sobe um andar', () => {
    const placed = placeLabels(
      [
        { id: 'fraco', cx: 150, top: 100, w: 60, h: 16, priority: 1 },
        { id: 'forte', cx: 152, top: 98, w: 60, h: 16, priority: 9 },
      ],
      bounds,
      { gap: 3, lift: 4, levels: 3 },
    );
    assert.equal(placed.length, 2);
    assert.equal(placed[0].id, 'forte');
    assert.equal(placed[0].level, 0);
    assert.equal(placed[1].level, 1);
    assert.ok(placed[1].y < placed[0].y);
    assertNoOverlap(placed);
  });

  test('sem espaço em cima nem por dentro, o nome fica de fora', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, cx: 150, top: 30, w: 80, h: 16, priority: 10 - i }));
    const placed = placeLabels(items, { left: 0, right: 300, top: 0, bottom: 60 }, { levels: 2, gap: 3 });
    assert.ok(placed.length < items.length);
    assertNoOverlap(placed);
    assert.equal(placed[0].id, 'n0', 'quem tem mais prioridade entra primeiro');
  });

  test('pico encostado no teto: o nome vai por dentro da forma', () => {
    const [box] = placeLabels([{ id: 'alto', cx: 150, top: 6, w: 60, h: 16 }], bounds, { lift: 4 });
    assert.equal(box.inside, true);
    assert.ok(box.y >= 6);
  });

  test('respeita o máximo e nunca sobrepõe, com muitas redes', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, cx: rnd() * 300, top: 20 + rnd() * 170, w: 40 + rnd() * 60, h: 16, priority: rnd() * 100 }));
    const placed = placeLabels(items, bounds, { max: 8 });
    assert.ok(placed.length <= 8 && placed.length >= 3);
    assertNoOverlap(placed);
    for (const p of placed) assert.ok(p.x >= 0 && p.x + p.w <= 300 && p.y >= 0, `${p.id} dentro da área`);
  });

  test('itens inválidos ou mais largos que a área são ignorados', () => {
    assert.deepEqual(placeLabels([{ id: 'x', cx: NaN, top: 1, w: 10, h: 10 }, { id: 'y', cx: 10, top: 50, w: 999, h: 10 }, null], bounds), []);
    assert.deepEqual(placeLabels(undefined, bounds), []);
  });
});

describe('truncateText', () => {
  test('texto que cabe fica como está', () => {
    assert.equal(truncateText('Casa', 100, measure), 'Casa');
    assert.equal(truncateText('', 100, measure), '');
    assert.equal(truncateText(null, 100, measure), '');
  });

  test('corta com reticências e nunca passa da largura', () => {
    const out = truncateText('WIFI_DA_FAMILIA_ALBUQUERQUE', 84, measure);
    assert.ok(out.endsWith('…'));
    assert.ok(measure(out) <= 84);
    assert.ok(out.length > 4);
    assert.ok('WIFI_DA_FAMILIA_ALBUQUERQUE'.startsWith(out.slice(0, -1)));
  });

  test('não parte um emoji pela metade nem deixa espaço antes das reticências', () => {
    const family = '👨‍👩‍👧‍👦';
    const out = truncateText(`${family}${family}${family} casa`, 22, (text) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].length * 7);
    assert.equal(out, `${family}${family}…`);
    assert.equal(truncateText('Wifi do Seu Jorge', 7 * 6, measure), 'Wifi…');
  });

  test('nomes hostis são só texto', () => {
    const out = truncateText('<img src=x onerror=alert(1)>', 70, measure);
    assert.equal(out, '<img src=…');
  });

  test('se nada cabe, devolve vazio', () => {
    assert.equal(truncateText('abcdef', 5, measure), '');
  });
});

// ---------------------------------------------------------------------------
// Toque
// ---------------------------------------------------------------------------

describe('hitTest', () => {
  // três formas retangulares simples: A alta e larga, B baixa dentro de A, C ao lado
  const box = (bssid, lo, hi, rssi, widthMHz) => ({ bssid, rssi, widthMHz, points: [[lo, -100], [lo, rssi], [hi, rssi], [hi, -100]] });
  const A = box('aa', 2420, 2460, -50, 40);
  const B = box('bb', 2430, 2450, -75, 20);
  const C = box('cc', 2470, 2490, -60, 20);
  const shapes = [B, C, A];

  test('ponto dentro de uma forma só', () => {
    assert.deepEqual(hitTest(shapes, { freq: 2440, dbm: -60 }).map((s) => s.bssid), ['aa']);
    assert.deepEqual(hitTest(shapes, { freq: 2480, dbm: -90 }).map((s) => s.bssid), ['cc']);
  });

  test('formas empilhadas: a mais baixa vem primeiro', () => {
    assert.deepEqual(hitTest(shapes, { freq: 2440, dbm: -90 }).map((s) => s.bssid), ['bb', 'aa']);
  });

  test('mesma altura: a mais estreita vem primeiro', () => {
    const wide = box('w', 2400, 2480, -70, 80);
    const thin = box('t', 2430, 2450, -70, 20);
    assert.deepEqual(hitTest([wide, thin], { freq: 2440, dbm: -80 }).map((s) => s.bssid), ['t', 'w']);
  });

  test('fora de todas: vale o contorno mais próximo, dentro da folga do dedo', () => {
    const tol = { freq: 3, dbm: 4 };
    assert.deepEqual(hitTest(shapes, { freq: 2440, dbm: -47 }, tol).map((s) => s.bssid), ['aa'], 'um pouco acima do topo de A');
    assert.deepEqual(hitTest(shapes, { freq: 2465, dbm: -80 }, tol), [], 'no vão entre A e C, longe dos dois');
    assert.deepEqual(hitTest(shapes, { freq: 2468, dbm: -80 }, tol).map((s) => s.bssid), ['cc']);
    assert.deepEqual(hitTest(shapes, { freq: 2440, dbm: -40 }, tol), []);
    assert.deepEqual(hitTest(shapes, { freq: 2440, dbm: -47 }), [], 'sem folga, fora é fora');
  });

  test('um AP 80+80 (duas formas com o mesmo BSSID) aparece uma vez só', () => {
    const twin = [box('dd', 5170, 5250, -60, 160), box('dd', 5170, 5250, -60, 160)];
    assert.equal(hitTest(twin, { freq: 5200, dbm: -80 }).length, 1);
  });

  test('entradas tortas', () => {
    assert.deepEqual(hitTest(null, { freq: 1, dbm: 1 }), []);
    assert.deepEqual(hitTest(shapes, null), []);
    assert.deepEqual(hitTest([{ bssid: 'x', points: [] }, null], { freq: 1, dbm: 1 }), []);
  });

  test('com as formas de verdade: tocar logo abaixo do pico de cada rede acha a rede', () => {
    for (const [event, band] of [[apartment, '2.4'], [apartment, '5'], [office, '2.4'], [office, '5']]) {
      const graph = channelGraph(normalizeScan(event), band);
      assert.ok(graph.shapes.length > 0, `${band} tem formas`);
      for (const shape of graph.shapes) {
        const found = hitTest(graph.shapes, { freq: shape.centerFreq, dbm: shape.rssi - 1 });
        assert.ok(found.some((s) => s.bssid === shape.bssid), `${shape.ssid} (${band} GHz, canal ${shape.channel})`);
        // e a escolhida nunca é mais alta que ela
        assert.ok(found[0].rssi <= shape.rssi);
      }
    }
  });
});

describe('nextInCycle', () => {
  const list = [{ bssid: 'a' }, { bssid: 'b' }, { bssid: 'c' }];
  test('sem destaque, a primeira; com destaque, a seguinte; no fim, volta', () => {
    assert.equal(nextInCycle(list, null).bssid, 'a');
    assert.equal(nextInCycle(list, 'a').bssid, 'b');
    assert.equal(nextInCycle(list, 'c').bssid, 'a');
    assert.equal(nextInCycle(list, 'zz').bssid, 'a');
    assert.equal(nextInCycle([{ bssid: 'a' }], 'a').bssid, 'a');
    assert.equal(nextInCycle([], 'a'), null);
  });
});

describe('maxZoomFor', () => {
  test('quanto mais apertada a faixa na tela, mais zoom ela aceita', () => {
    const z24 = maxZoomFor('2.4', 3.4);
    const z5 = maxZoomFor('5', 0.5);
    const z6 = maxZoomFor('6', 0.24);
    assert.ok(z24 >= 2 && z24 <= 4, `2,4 GHz: ${z24}`);
    assert.ok(z5 > z24, `5 GHz: ${z5}`);
    assert.ok(z6 > z5 && z6 <= 12, `6 GHz: ${z6}`);
    assert.equal(maxZoomFor('5', 0), 1);
    assert.equal(maxZoomFor('5', NaN), 1);
  });
});

// ---------------------------------------------------------------------------
// Lógica da tela Canais
// ---------------------------------------------------------------------------

/** Lista como a do store: Ap normalizados + as marcas que o store põe (connected, favorite, own). */
function storeLike(event, { connected = null, favorites = [] } = {}) {
  const aps = normalizeScan(event);
  const devices = groupByDevice(aps);
  const own = new Set();
  for (const ap of aps) if (ap.ssid && favorites.includes(ap.ssid)) own.add(ap.bssid);
  if (connected) {
    own.add(connected);
    for (const d of devices) if (d.bssids.includes(connected)) for (const id of d.bssids) own.add(id);
  }
  for (const ap of aps) {
    ap.connected = ap.bssid === connected;
    ap.favorite = !!ap.ssid && favorites.includes(ap.ssid);
    ap.own = own.has(ap.bssid);
  }
  return { aps, devices };
}

describe('rota e faixas', () => {
  test('parseBandParam aceita as grafias comuns', () => {
    for (const text of ['2.4', '2,4', '24', ' 2.4GHz ', '2.4 ghz']) assert.equal(parseBandParam(text), '2.4', text);
    assert.equal(parseBandParam('5'), '5');
    assert.equal(parseBandParam('5GHz'), '5');
    assert.equal(parseBandParam('6'), '6');
    for (const text of ['', '60', 'abc', null, undefined, '5.5', '<img>']) assert.equal(parseBandParam(text), null, String(text));
  });

  test('readQuery lê faixa e BSSID e recusa o que não é um endereço', () => {
    const q = (text) => readQuery({ query: new URLSearchParams(text) });
    assert.deepEqual(q('band=5&bssid=AA:BB:CC:DD:EE:FF'), { band: '5', bssid: 'aa:bb:cc:dd:ee:ff' });
    assert.deepEqual(q('bssid=aa:bb:cc:dd:ee:ff'), { band: null, bssid: 'aa:bb:cc:dd:ee:ff' });
    assert.deepEqual(q('band=2,4'), { band: '2.4', bssid: null });
    assert.deepEqual(q('band=6&bssid=<script>'), { band: '6', bssid: null });
    assert.equal(q(''), null);
    assert.equal(q('bssid=javascript:alert(1)'), null);
    assert.equal(readQuery(null), null);
    assert.equal(readQuery({}), null);
  });

  test('bandSummary conta as redes e explica por que uma faixa não pode ser escolhida', () => {
    const { aps } = storeLike(apartment);
    const summary = bandSummary(aps, { bands: { b24: true, b5: true, b6: false, b60: false } });
    assert.deepEqual(summary.map((b) => b.band), BAND_KEYS);
    const [b24, b5, b6] = summary;
    assert.ok(b24.count > 5 && b24.enabled && b24.reason === null);
    assert.ok(b5.count > 0 && b5.enabled);
    assert.equal(b24.count + b5.count + b6.count, aps.filter((ap) => BAND_KEYS.includes(ap.band)).length);
    assert.equal(b6.enabled, false);
    assert.match(b6.reason, /não capta redes de 6.GHz/);
    assert.equal(b6.short, 'sem suporte');

    const supported = bandSummary(aps, { bands: { b24: true, b5: true, b6: true } })[2];
    assert.equal(supported.enabled, false);
    assert.match(supported.reason, /Nenhuma rede de 6.GHz por perto/);
    assert.equal(supported.short, 'nenhuma rede');

    const blank = bandSummary([], null);
    assert.ok(blank.every((b) => b.count === 0 && !b.enabled && b.supported));
    assert.ok(bandSummary(null, undefined).length === 3);
  });

  test('uma faixa "sem suporte" que mesmo assim tem redes continua escolhível', () => {
    const { aps } = storeLike(apartment);
    const [b24] = bandSummary(aps, { bands: { b24: false, b5: true, b6: true } });
    assert.equal(b24.enabled, true);
    assert.equal(b24.reason, null);
  });

  test('pickBand: a preferida se tiver redes; senão a primeira com redes', () => {
    const { aps } = storeLike(apartment);
    const summary = bandSummary(aps, null);
    assert.equal(pickBand(summary, null), '2.4');
    assert.equal(pickBand(summary, '5'), '5');
    assert.equal(pickBand(summary, '6'), '2.4', '6 GHz está vazia');
    const only5 = bandSummary(aps.filter((ap) => ap.band === '5'), null);
    assert.equal(pickBand(only5, null), '5');
    assert.equal(pickBand(only5, '2.4'), '5');
    assert.equal(pickBand(bandSummary([], null), null), '2.4');
    assert.equal(pickBand(bandSummary([], null), '5'), '5', 'sem nada em lugar nenhum, fica onde estava');
  });
});

describe('o roteador do usuário', () => {
  test('sem conexão nem favoritos não há candidato', () => {
    const { aps, devices } = storeLike(apartment);
    assert.deepEqual(ownCandidates(aps, devices, '2.4'), []);
    assert.equal(pickOwn([], 'aa:bb:cc:dd:ee:ff'), null);
  });

  test('conectado em 5 GHz: o outro rádio do mesmo aparelho é o candidato em 2,4 GHz', () => {
    const base = normalizeScan(apartment);
    const truthOwn = [apartmentTruth.own].flat().filter(Boolean);
    const dev = groupByDevice(base).find((d) => d.bands.length > 1 && d.bssids.some((id) => truthOwn.includes(id))) || groupByDevice(base).find((d) => d.bands.length > 1);
    assert.ok(dev, 'a amostra tem um roteador de duas faixas');
    const on5 = dev.aps.find((ap) => ap.band === '5');
    const on24 = dev.aps.find((ap) => ap.band === '2.4');
    const { aps, devices } = storeLike(apartment, { connected: on5.bssid });
    const c5 = ownCandidates(aps, devices, '5');
    const c24 = ownCandidates(aps, devices, '2.4');
    assert.equal(c5.length, 1);
    assert.equal(c5[0].connected, true);
    assert.equal(c5[0].ap.bssid, on5.bssid);
    assert.equal(c24.length, 1);
    assert.equal(c24[0].connected, false);
    assert.ok(c24[0].bssids.includes(on24.bssid));
    assert.deepEqual(ownCandidates(aps, devices, '6'), []);
  });

  test('várias redes no mesmo rádio contam como um roteador, representado pela de mesmo nome da conexão', () => {
    const corp5 = makeAp('78:8a:20:05:02:68', 'CORP', -52, 5260, { channelWidth: CW.W80, centerFreq0: 5290 });
    const guest5 = makeAp('78:8a:20:05:02:69', 'CORP-Visitantes', -50, 5260, { channelWidth: CW.W80, centerFreq0: 5290 });
    const corp24 = makeAp('78:8a:20:05:02:60', 'CORP', -49, 2437);
    const guest24 = makeAp('78:8a:20:05:02:61', 'CORP-Visitantes', -48, 2437);
    const { aps, devices } = storeLike(withAps({ ...apartment, aps: [] }, [corp5, guest5, corp24, guest24]), { connected: corp5.bssid });
    const c24 = ownCandidates(aps, devices, '2.4');
    assert.equal(c24.length, 1, 'um rádio só');
    assert.equal(c24[0].ap.ssid, 'CORP', 'e não a de visitantes, embora ela esteja mais forte');
    assert.deepEqual([...c24[0].bssids].sort(), [corp24.bssid, guest24.bssid]);
    assert.deepEqual(c24[0].ssids.sort(), ['CORP', 'CORP-Visitantes']);
    const c5 = ownCandidates(aps, devices, '5');
    assert.equal(c5.length, 1);
    assert.equal(c5[0].ap.bssid, corp5.bssid, 'o conectado representa o rádio');
  });

  test('rede favorita com vários pontos de acesso: um candidato por rádio, o conectado primeiro; a escolha da pessoa vale', () => {
    const { aps: plain } = storeLike(mesh);
    const ssid = [meshTruth.own].flat().length ? plain.find((ap) => [meshTruth.own].flat().includes(ap.bssid))?.ssid : null;
    const name = ssid || plain.find((ap) => ap.ssid && plain.filter((o) => o.ssid === ap.ssid && o.band === ap.band).length > 1).ssid;
    const sameBand = plain.filter((ap) => ap.ssid === name);
    const band = sameBand.find((ap) => sameBand.filter((o) => o.band === ap.band).length > 1).band;
    const members = sameBand.filter((ap) => ap.band === band);
    const weakest = members.reduce((a, b) => (a.rssi < b.rssi ? a : b));
    const { aps, devices } = storeLike(mesh, { connected: weakest.bssid, favorites: [name] });
    const list = ownCandidates(aps, devices, band);
    assert.ok(list.length > 1, 'mais de um ponto de acesso da rede nesta faixa');
    assert.equal(list[0].ap.bssid, weakest.bssid, 'o conectado vem primeiro, mesmo sendo o mais fraco');
    for (let i = 2; i < list.length; i++) assert.ok(list[i - 1].ap.rssi >= list[i].ap.rssi, 'os demais, do mais forte ao mais fraco');
    assert.equal(pickOwn(list, null).bssid, weakest.bssid);
    assert.equal(pickOwn(list, list[1].ap.bssid).bssid, list[1].ap.bssid);
    assert.equal(pickOwn(list, 'ff:ff:ff:ff:ff:ff').bssid, weakest.bssid, 'escolha que sumiu: volta ao primeiro');
  });

  test('widthsFor e defaultWidth', () => {
    assert.deepEqual(widthsFor('2.4'), [20]);
    assert.deepEqual(widthsFor('5'), [20, 40, 80, 160]);
    assert.deepEqual(widthsFor('6'), [20, 40, 80, 160, 320]);
    assert.equal(defaultWidth('2.4', { band: '2.4', widthMHz: 40 }), 20, 'em 2,4 GHz a análise é sempre em 20 MHz');
    assert.equal(defaultWidth('5', null), 80);
    assert.equal(defaultWidth('5', { band: '5', widthMHz: 40 }), 40);
    assert.equal(defaultWidth('5', { band: '5', widthMHz: 320 }), 80, 'largura que não existe na faixa');
    assert.equal(defaultWidth('5', { band: '2.4', widthMHz: 20 }), 80, 'roteador de outra faixa não conta');
    assert.equal(defaultWidth('6', { band: '6', widthMHz: 320 }), 320);
  });
});

describe('notas e ranking', () => {
  test('scoreLevel: cinco degraus com palavra', () => {
    assert.deepEqual([100, 85, 84.9, 70, 69, 50, 49, 30, 29, 0].map((v) => scoreLevel(v).step), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    assert.equal(scoreLevel(92).label, 'Livre');
    assert.equal(scoreLevel(12).label, 'Congestionado');
    assert.equal(scoreLevel(NaN).step, 5);
  });

  /** Acha na amostra um roteador de 2,4 GHz que tenha vizinhos, para as contas baterem com o core. */
  function scenario(event, band) {
    const base = normalizeScan(event);
    const pick = base.filter((ap) => ap.band === band && ap.ssid).sort((a, b) => b.rssi - a.rssi)[0];
    const { aps, devices } = storeLike(event, { connected: pick.bssid });
    const own = pickOwn(ownCandidates(aps, devices, band), null);
    return { aps, devices, own };
  }

  test('ownExclusion repete a regra do core: o ranking sai com as mesmas notas do cartão', () => {
    for (const [event, band, width] of [[apartment, '2.4', 20], [office, '2.4', 20], [office, '5', 80], [apartment, '5', 80], [mesh, '5', 80], [mesh, '2.4', 20]]) {
      const base = normalizeScan(event);
      if (!base.some((ap) => ap.band === band)) continue;
      const { aps, devices, own } = scenario(event, band);
      const rec = recommendChannel(aps, { band, widthMHz: width, own });
      const exclude = ownExclusion(devices, own);
      assert.ok(exclude.has(own.bssid));
      const ratings = rateChannels(aps, { band, widthMHz: width, exclude });
      const same = ratings.find((r) => r.centerFreq === rec.best.centerFreq);
      assert.ok(same, 'o melhor canal está entre as notas');
      near(same.score, rec.best.score, 0.11, `nota do melhor canal (${band} GHz)`);
      if (rec.current) {
        const cur = ratings.find((r) => r.centerFreq === rec.current.centerFreq);
        assert.ok(cur.score >= rec.current.score - 0.11, 'com o primário livre, o bloco atual nunca sai pior');
      }
    }
    assert.equal(ownExclusion([], null).size, 0);
  });

  test('buildRanking marca o canal atual e o melhor, uma linha por canal', () => {
    const { aps, devices, own } = scenario(apartment, '2.4');
    const rec = recommendChannel(aps, { band: '2.4', widthMHz: 20, own });
    const ratings = rateChannels(aps, { band: '2.4', widthMHz: 20, exclude: ownExclusion(devices, own) });
    const rows = buildRanking(ratings, rec);
    assert.equal(rows.length, 13);
    assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'chaves únicas');
    const current = rows.filter((r) => r.isCurrent);
    const best = rows.filter((r) => r.isBest);
    assert.equal(current.length, 1);
    assert.equal(best.length, 1);
    assert.equal(current[0].rating.channel, own.channel);
    assert.equal(current[0].rating, rec.current, 'a linha do canal atual mostra a nota do cartão');
    assert.equal(best[0].rating, rec.best);
    assert.ok(current[0].main && best[0].main);
    const main = rows.filter((r) => r.main).map((r) => r.rating.channel);
    for (const ch of [1, 6, 11]) assert.ok(main.includes(ch), `canal ${ch} na lista principal`);
    assert.ok(main.length <= 4, 'só 1, 6, 11 e o canal atual');
  });

  test('buildRanking sem roteador: só o melhor é marcado', () => {
    const { aps } = storeLike(apartment);
    const rec = recommendChannel(aps, { band: '2.4', widthMHz: 20, own: null });
    const rows = buildRanking(rateChannels(aps, { band: '2.4', widthMHz: 20 }), rec);
    assert.equal(rows.filter((r) => r.isCurrent).length, 0);
    assert.equal(rows.filter((r) => r.isBest).length, 1);
    assert.deepEqual(rows.filter((r) => r.main).map((r) => r.rating.channel).sort((a, b) => a - b), [1, 6, 11]);
  });

  test('buildRanking: o melhor é outro primário dentro do bloco atual -> o canal atual ganha linha própria', () => {
    const block = { centerFreq: 5210, lo: 5170, hi: 5250, widthMHz: 80, channels: [36, 40, 44, 48], dfs: false, recommendable: true };
    const ratings = [{ ...block, channel: 36, score: 90 }, { centerFreq: 5290, channel: 52, score: 60, dfs: true, recommendable: true, widthMHz: 80, channels: [52, 56, 60, 64] }];
    const rec = { best: { ...block, channel: 36, score: 90 }, current: { ...block, channel: 44, score: 70 } };
    const rows = buildRanking(ratings, rec);
    assert.equal(rows.length, 3);
    const best = rows.find((r) => r.isBest);
    const cur = rows.find((r) => r.isCurrent);
    assert.notEqual(best, cur);
    assert.equal(best.rating.channel, 36);
    assert.equal(cur.rating.channel, 44);
    assert.notEqual(best.key, cur.key);
    // e quando é o mesmo lugar, uma linha só com as duas marcas
    const rows2 = buildRanking(ratings, { best: rec.best, current: { ...block, channel: 36, score: 90 } });
    assert.equal(rows2.length, 2);
    assert.ok(rows2[0].isBest && rows2[0].isCurrent);
  });

  test('buildRanking tolera entradas vazias', () => {
    assert.deepEqual(buildRanking(null, null), []);
    assert.deepEqual(buildRanking([], { best: null, current: null }), []);
  });

  const row = (key, score, extra = {}) => ({ key, rating: { score, centerFreq: Number(key), dfs: false, ...extra.rating }, isBest: !!extra.isBest, isCurrent: !!extra.isCurrent });

  test('orderRanking: do zero, pela nota; DFS perde 5 pontos; o melhor vai para o topo', () => {
    const rows = [row('5180', 70), row('5260', 74, { rating: { dfs: true } }), row('5745', 72), row('5500', 90, { rating: { dfs: true } })];
    assert.deepEqual(orderRanking([], rows).map((r) => r.key), ['5500', '5745', '5180', '5260']);
    const marked = [row('5180', 70), row('5745', 72), row('5260', 71, { isBest: true })];
    assert.equal(orderRanking([], marked)[0].key, '5260');
  });

  test('orderRanking: diferenças pequenas não mexem na ordem que a pessoa já está vendo', () => {
    const before = ['a1', 'b2', 'c3'];
    const mk = (a, b, c) => [{ ...row('1', a), key: 'a1' }, { ...row('2', b), key: 'b2' }, { ...row('3', c), key: 'c3' }];
    assert.deepEqual(orderRanking(before, mk(60, 61, 50)).map((r) => r.key), before, '1 ponto de diferença: fica');
    assert.deepEqual(orderRanking(before, mk(60, 63, 50)).map((r) => r.key), ['b2', 'a1', 'c3'], '3 pontos: troca');
    assert.deepEqual(orderRanking(before, mk(60, 40, 80)).map((r) => r.key), ['c3', 'a1', 'b2']);
    // linha nova entra pela nota; linha que saiu some
    const next = [...mk(60, 59, 20).slice(0, 2), { ...row('9', 95), key: 'novo' }];
    assert.deepEqual(orderRanking(before, next).map((r) => r.key), ['novo', 'a1', 'b2']);
  });

  test('orderRanking nunca perde nem duplica linhas', () => {
    let seed = 3;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    let previous = [];
    for (let round = 0; round < 60; round++) {
      const rows = Array.from({ length: 13 }, (_, i) => ({ ...row(String(2412 + 5 * i), Math.round(rnd() * 1000) / 10), isBest: i === round % 13 }));
      const out = orderRanking(previous, rows);
      assert.equal(out.length, rows.length);
      assert.equal(new Set(out.map((r) => r.key)).size, rows.length);
      assert.ok(out[0].isBest);
      previous = out.map((r) => r.key);
    }
  });

  test('interferers: quem divide, quem invade e quem só vaza, do que mais pesa ao que menos pesa', () => {
    const own = makeAp('02:00:00:00:00:01', 'Minha', -45, 2437);
    const share = makeAp('02:10:00:00:00:02', 'MesmoCanal', -60, 2437);
    const far = makeAp('02:20:00:00:00:03', 'MesmoCanalLonge', -88, 2437);
    const side = makeAp('02:30:00:00:00:04', 'AoLado', -55, 2447);
    const leak = makeAp('02:40:00:00:00:05', 'Vaza', -50, 2412);
    const other = makeAp('02:50:00:00:00:06', 'OutraFaixa', -40, 5180);
    const { aps, devices } = storeLike(withAps({ ...apartment, aps: [] }, [own, share, far, side, leak, other]), { connected: own.bssid });
    const mine = aps.find((ap) => ap.bssid === own.bssid);
    const exclude = ownExclusion(devices, mine);
    const rating = rateChannels(aps, { band: '2.4', widthMHz: 20, exclude }).find((r) => r.channel === 6);
    const list = interferers(aps, rating, exclude);
    const kinds = Object.fromEntries(list.map((i) => [i.ap.ssid, i.kind]));
    assert.deepEqual(kinds, { MesmoCanal: 'share', AoLado: 'overlap', MesmoCanalLonge: 'weak', Vaza: 'leak' });
    assert.ok(!list.some((i) => i.ap.bssid === own.bssid), 'o próprio roteador não entra');
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].inBlockDbm >= list[i].inBlockDbm);
    assert.ok(list.find((i) => i.kind === 'share').inBlockDbm > -61, 'quem está no canal chega quase inteiro');
    assert.ok(list.find((i) => i.kind === 'leak').inBlockDbm < -70, 'quem só vaza chega bem mais fraco que o sinal dele');
    assert.equal(rating.coChannel, 2);
    assert.equal(rating.overlapping, 1);
    assert.deepEqual(interferers(aps, null, exclude), []);
  });

  test('crowdText e explainRating falam do que a nota viu', () => {
    assert.equal(crowdText({ coChannel: 0, overlapping: 0, interferenceDbm: null }), 'nenhuma rede por perto');
    assert.equal(crowdText({ coChannel: 0, overlapping: 0, interferenceDbm: -90 }), 'só sobras de canais distantes');
    assert.equal(crowdText({ coChannel: 1, overlapping: 0 }), '1 rede no canal');
    assert.equal(crowdText({ coChannel: 2, overlapping: 5 }), '2 redes no canal · 5 ao lado');
    assert.equal(crowdText({ coChannel: 0, overlapping: 3 }), '3 redes ao lado');

    const free = explainRating({ coChannel: 0, overlapping: 0, interferenceDbm: null, airtime: 0, utilization: null });
    assert.equal(free.length, 1);
    assert.match(free[0], /livre/);
    const busy = explainRating({ coChannel: 3, overlapping: 1, interferenceDbm: -60, airtime: 0.24, utilization: 0.46 });
    assert.equal(busy.length, 4);
    assert.match(busy[0], /^3 redes vizinhas usam este mesmo canal/);
    assert.match(busy[1], /^Uma rede está em canais ao lado/);
    assert.match(busy[2], /24%/);
    assert.match(busy[3], /46%/);
  });
});
