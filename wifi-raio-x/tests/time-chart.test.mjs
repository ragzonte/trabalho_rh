// Contas dos gráficos de sinal no tempo: escala, marcas do eixo, trechos com lacunas, leitura
// num instante, posição e corte dos rótulos (ui/charts/time-chart.js) e a geometria do
// minigráfico das listas (ui/charts/sparkline.js). Nada aqui precisa de navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MINUS, THIN } from '../app/js/ui/dom.js';
import { QUALITY_ZONES, yRange, ageLabel, timeTicks, splitSegments, valueAt, spreadLabels, ellipsize, ellipsizeLabel } from '../app/js/ui/charts/time-chart.js';
import { sparklineGeometry, SPARK_DEFAULTS } from '../app/js/ui/charts/sparkline.js';
import { signalLevel } from '../app/js/core/signal.js';

const T0 = 1_700_000_000_000;
const pts = (...pairs) => pairs.map(([s, rssi]) => ({ t: T0 + s * 1000, rssi }));

// ---------------------------------------------------------------------------
// Escala vertical
// ---------------------------------------------------------------------------

test('yRange: cobre os valores com folga, em dezenas, com pelo menos 30 dB de altura', () => {
  assert.deepEqual(yRange([]), { min: -90, max: -40 });
  assert.deepEqual(yRange(null), { min: -90, max: -40 });
  assert.deepEqual(yRange([NaN, undefined, 'x']), { min: -90, max: -40 });
  // uma rede parada em −57 não vira um serrote esticado
  const flat = yRange([-57, -58, -56]);
  assert.equal(flat.max - flat.min, 30);
  assert.ok(flat.min <= -61 && flat.max >= -53);
  assert.equal(flat.min % 10 === 0 && flat.max % 10 === 0, true);
  // valores espalhados: a escala abraça todos
  const wide = yRange([-38, -91]);
  assert.ok(wide.max >= -35 && wide.min <= -94);
  assert.deepEqual(wide, { min: -100, max: -30 });
  // nunca passa dos limites físicos
  const extreme = yRange([-5, -120]);
  assert.deepEqual(extreme, { min: -100, max: -20 });
  // junto ao teto, cresce só para baixo
  const top = yRange([-22]);
  assert.equal(top.max, -20);
  assert.equal(top.max - top.min, 30);
  for (const sample of [[-47], [-60, -61], [-82, -45, -70], [-99]]) {
    const r = yRange(sample);
    assert.ok(r.max - r.min >= 30, JSON.stringify(sample));
    for (const v of sample) assert.ok(v >= r.min && v <= r.max, `${v} dentro de ${JSON.stringify(r)}`);
  }
});

test('as faixas de qualidade do gráfico são as mesmas de signalLevel()', () => {
  assert.equal(QUALITY_ZONES.length, 6);
  assert.equal(QUALITY_ZONES[QUALITY_ZONES.length - 1].min, -Infinity);
  // logo acima e logo abaixo de cada limite a palavra muda como no resto do app
  const wordAt = (rssi) => QUALITY_ZONES.find((z) => rssi >= z.min).word;
  for (const rssi of [-30, -50, -51, -55, -60, -61, -67, -68, -75, -76, -82, -83, -95]) {
    assert.equal(wordAt(rssi), signalLevel(rssi).label.toLowerCase(), `${rssi} dBm`);
  }
  assert.deepEqual(QUALITY_ZONES.map((z) => z.token), ['--sig-1', '--sig-1', '--sig-2', '--sig-3', '--sig-4', '--sig-5']);
});

// ---------------------------------------------------------------------------
// Eixo do tempo
// ---------------------------------------------------------------------------

test('ageLabel: agora, segundos e minutos inteiros, com o sinal de menos tipográfico', () => {
  assert.equal(ageLabel(0), 'agora');
  assert.equal(ageLabel(-3), 'agora');
  assert.equal(ageLabel(30), `${MINUS}30${THIN}s`);
  assert.equal(ageLabel(60), `${MINUS}1${THIN}min`);
  assert.equal(ageLabel(90), `${MINUS}90${THIN}s`);
  assert.equal(ageLabel(600), `${MINUS}10${THIN}min`);
});

test('timeTicks: da direita para a esquerda, no maior detalhe que cabe', () => {
  const two = timeTicks(120_000, 220);
  assert.deepEqual(two.map((t) => t.ageMs), [0, 60_000, 120_000]);
  assert.deepEqual(two.map((t) => t.label), ['agora', `${MINUS}1${THIN}min`, `${MINUS}2${THIN}min`]);
  // mais largura, mais marcas
  assert.deepEqual(timeTicks(120_000, 320).map((t) => t.ageMs), [0, 30_000, 60_000, 90_000, 120_000]);
  // 10 minutos num gráfico estreito
  const ten = timeTicks(600_000, 200);
  assert.deepEqual(ten.map((t) => t.ageMs), [0, 300_000, 600_000]);
  for (const [windowMs, width] of [[120_000, 150], [300_000, 250], [600_000, 250], [600_000, 700], [45_000, 90], [3_600_000, 300]]) {
    const ticks = timeTicks(windowMs, width);
    assert.equal(ticks[0].ageMs, 0);
    assert.equal(ticks[0].label, 'agora');
    assert.ok(ticks.length >= 2 || windowMs < 5000, 'pelo menos duas marcas');
    assert.ok(ticks[ticks.length - 1].ageMs <= windowMs);
    // nunca tão juntas que os rótulos se atropelem
    const spacing = ((ticks[1].ageMs - ticks[0].ageMs) / windowMs) * width;
    assert.ok(spacing >= 62 || ticks.length === 2, `${windowMs}/${width}: ${spacing}px`);
    for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i].ageMs - ticks[i - 1].ageMs, ticks[1].ageMs);
  }
});

// ---------------------------------------------------------------------------
// Trechos e lacunas
// ---------------------------------------------------------------------------

test('splitSegments: a linha é interrompida onde a rede ficou sem ser ouvida', () => {
  const series = pts([0, -60], [10, -61], [20, -62], [70, -70], [80, -71], [200, -75]);
  const range = { from: T0 - 1000, to: T0 + 300_000, gapMs: 25_000 };
  const segs = splitSegments(series, range);
  assert.deepEqual(segs.map((s) => s.map((p) => p.rssi)), [[-60, -61, -62], [-70, -71], [-75]]);
  // lacuna maior: tudo ligado
  assert.equal(splitSegments(series, { ...range, gapMs: 500_000 }).length, 1);
  // lacuna mínima: cada leitura é um ponto isolado
  assert.equal(splitSegments(series, { ...range, gapMs: 1 }).length, 6);
  assert.deepEqual(splitSegments([], range), []);
  assert.deepEqual(splitSegments(null, range), []);
});

test('splitSegments: a janela corta o passado, mas a linha entra pela borda', () => {
  const series = pts([0, -60], [10, -61], [20, -62], [30, -63], [40, -64]);
  const segs = splitSegments(series, { from: T0 + 15_000, to: T0 + 35_000, gapMs: 25_000 });
  assert.equal(segs.length, 1);
  // fica a última leitura de antes (10 s), para o traço não começar no meio do gráfico
  assert.deepEqual(segs[0].map((p) => p.rssi), [-61, -62, -63]);
  // se a leitura de antes está longe demais, o trecho começa dentro da janela
  const far = splitSegments(pts([0, -50], [100, -60], [110, -61]), { from: T0 + 90_000, to: T0 + 120_000, gapMs: 25_000 });
  assert.deepEqual(far.map((s) => s.map((p) => p.rssi)), [[-60, -61]]);
  // leituras depois do fim (gráfico pausado) ficam de fora
  const paused = splitSegments(series, { from: T0, to: T0 + 20_000, gapMs: 25_000 });
  assert.deepEqual(paused[0].map((p) => p.rssi), [-60, -61, -62]);
  // lixo no meio é pulado
  const dirty = [{ t: T0, rssi: -60 }, null, { t: 'x', rssi: -1 }, { t: T0 + 5000, rssi: NaN }, { t: T0 + 10_000, rssi: -62 }];
  assert.deepEqual(splitSegments(dirty, { from: T0 - 1, to: T0 + 60_000, gapMs: 25_000 })[0].map((p) => p.rssi), [-60, -62]);
});

test('valueAt: interpola entre leituras vizinhas e não inventa valor dentro de uma lacuna', () => {
  const series = pts([0, -60], [10, -70], [100, -50]);
  assert.equal(valueAt(series, T0, 25_000), -60);
  assert.equal(valueAt(series, T0 + 5000, 25_000), -65);
  assert.equal(valueAt(series, T0 + 2500, 25_000), -62.5);
  // no meio da lacuna entre 10 s e 100 s: sem valor
  assert.equal(valueAt(series, T0 + 55_000, 25_000), null);
  // colado numa das pontas da lacuna vale a leitura da ponta
  assert.equal(valueAt(series, T0 + 12_000, 25_000), -70);
  assert.equal(valueAt(series, T0 + 97_000, 25_000), -50);
  // fora dos dados: só bem perto da primeira ou da última
  assert.equal(valueAt(series, T0 + 105_000, 25_000), -50);
  assert.equal(valueAt(series, T0 + 140_000, 25_000), null);
  assert.equal(valueAt(series, T0 - 5000, 25_000), -60);
  assert.equal(valueAt(series, T0 - 60_000, 25_000), null);
  assert.equal(valueAt([], T0, 25_000), null);
  assert.equal(valueAt(null, T0, 25_000), null);
});

// ---------------------------------------------------------------------------
// Rótulos
// ---------------------------------------------------------------------------

test('spreadLabels: afasta os que se sobrepõem, mantém a ordem e fica dentro da área', () => {
  const box = { top: 10, bottom: 150, gap: 15 };
  // já afastados: ficam onde estão
  assert.deepEqual(spreadLabels([{ y: 20 }, { y: 80 }, { y: 140 }], box), [20, 80, 140]);
  // três no mesmo ponto
  const same = spreadLabels([{ y: 70 }, { y: 70 }, { y: 70 }], box);
  assert.deepEqual(same, [70, 85, 100]);
  // devolvidos na ordem recebida, não na ordem vertical
  const mixed = spreadLabels([{ y: 100 }, { y: 30 }, { y: 104 }], box);
  assert.equal(mixed[1], 30);
  assert.ok(mixed[2] - mixed[0] >= 15);
  // amontoados no fundo: sobem em bloco
  const low = spreadLabels([{ y: 148 }, { y: 149 }, { y: 150 }], box);
  assert.deepEqual(low, [120, 135, 150]);
  // fora da área: são trazidos para dentro
  assert.deepEqual(spreadLabels([{ y: -40 }, { y: 400 }], box), [10, 150]);
  // não cabem todos com a folga pedida: espalha por igual, sem sumir com nenhum
  const many = spreadLabels(Array.from({ length: 20 }, () => ({ y: 80 })), box);
  assert.equal(many.length, 20);
  assert.equal(Math.min(...many), 10);
  assert.equal(Math.max(...many), 150);
  for (let i = 1; i < many.length; i++) assert.ok(many[i] > many[i - 1]);
  assert.deepEqual(spreadLabels([], box), []);
  // propriedade: com espaço de sobra, nenhum par fica mais perto que a folga
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 200; round++) {
    const n = 1 + Math.floor(rand() * 6);
    const items = Array.from({ length: n }, () => ({ y: rand() * 200 - 20 }));
    const ys = spreadLabels(items, box);
    const sorted = [...ys].sort((a, b) => a - b);
    for (const y of ys) assert.ok(y >= box.top - 1e-9 && y <= box.bottom + 1e-9);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= box.gap - 1e-9, `rodada ${round}`);
  }
});

test('ellipsize: corta com reticências sem partir emoji e limpa caracteres de controle', () => {
  const measure = (text) => Array.from(text).length * 10; // 10 px por caractere
  assert.equal(ellipsize('Casa', 100, measure), 'Casa');
  assert.equal(ellipsize('VIVOFIBRA-8F3C-5G', 100, measure), 'VIVOFIBRA…');
  assert.equal(measure(ellipsize('VIVOFIBRA-8F3C-5G', 100, measure)) <= 100, true);
  // o emoji conta como um caractere e nunca sai pela metade
  const rocket = ellipsize('🚀🚀🚀🚀🚀🚀', 40, measure);
  assert.equal(rocket, '🚀🚀🚀…');
  assert.equal(/[\uD800-\uDBFF]$/.test(rocket.slice(0, -1)), false, 'sem meio par substituto solto');
  // espaço antes das reticências não fica pendurado
  assert.equal(ellipsize('Wi-Fi da Vovó', 70, measure), 'Wi-Fi…');
  assert.equal(ellipsize('abcdef', 5, measure), '…');
  assert.equal(ellipsize(null, 100, measure), '');
  assert.equal(ellipsize(`a\nb${String.fromCharCode(0x2028)}c`, 100, measure), 'a·b·c');
  // texto hostil é só texto
  assert.equal(ellipsize('<img src=x onerror=alert(1)>', 1000, measure), '<img src=x onerror=alert(1)>');
});

test('ellipsizeLabel: em "nome · detalhe" quem encolhe é o nome; o detalhe que desempata fica inteiro', () => {
  const measure = (text) => Array.from(text).length * 10;
  assert.equal(ellipsizeLabel('Casa · 5 GHz', 200, measure), 'Casa · 5 GHz');
  assert.equal(ellipsizeLabel('WIFI_DA_FAMILIA_ALBUQUERQUE · 5 GHz', 200, measure), 'WIFI_DA_FAM… · 5 GHz');
  assert.equal(ellipsizeLabel('WIFI_DA_FAMILIA_ALBUQUERQUE · 2,4 GHz', 200, measure), 'WIFI_DA_F… · 2,4 GHz');
  // dois rótulos que só diferem no fim continuam diferentes depois do corte
  const a = ellipsizeLabel('🚀 WIFI_DA_FAMILIA_ALBUQUERQUE · 2,4 GHz', 180, measure);
  const b = ellipsizeLabel('🚀 WIFI_DA_FAMILIA_ALBUQUERQUE · 5 GHz', 180, measure);
  assert.notEqual(a, b);
  assert.ok(measure(a) <= 180 && measure(b) <= 180);
  // sem lugar para o nome: corta o texto todo, como ellipsize
  assert.equal(ellipsizeLabel('Casa · 2,4 GHz · canal 11 · aa:bb', 120, measure), ellipsize('Casa · 2,4 GHz · canal 11 · aa:bb', 120, measure));
  // sem detalhe: igual a ellipsize
  assert.equal(ellipsizeLabel('VIVOFIBRA-8F3C-5G', 100, measure), 'VIVOFIBRA…');
  assert.equal(ellipsizeLabel(null, 100, measure), '');
});

// ---------------------------------------------------------------------------
// Minigráfico
// ---------------------------------------------------------------------------

const numbers = (d) => (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);

test('sparklineGeometry: sem leituras não há traço nem ponto', () => {
  assert.deepEqual(sparklineGeometry([], { now: T0 }), { d: '', dot: null, count: 0 });
  assert.deepEqual(sparklineGeometry(null, { now: T0 }), { d: '', dot: null, count: 0 });
  // leituras só de antes da janela
  assert.equal(sparklineGeometry(pts([-500, -60]), { now: T0 }).count, 0);
});

test('sparklineGeometry: o traço cabe na caixa e termina no ponto de agora', () => {
  const series = pts([-110, -70], [-90, -66], [-70, -64], [-50, -68], [-30, -61], [-10, -58], [0, -57]);
  const geo = sparklineGeometry(series, { now: T0, width: 64, height: 18 });
  assert.equal(geo.count, 7);
  assert.ok(geo.d.startsWith('M'));
  assert.equal((geo.d.match(/M/g) || []).length, 1, 'um trecho só');
  assert.equal((geo.d.match(/L/g) || []).length, 6);
  const coords = numbers(geo.d);
  for (let i = 0; i < coords.length; i += 2) {
    assert.ok(coords[i] >= 0 && coords[i] <= 64, `x ${coords[i]}`);
    assert.ok(coords[i + 1] >= 0 && coords[i + 1] <= 18, `y ${coords[i + 1]}`);
  }
  // o tempo corre da esquerda para a direita
  for (let i = 2; i < coords.length; i += 2) assert.ok(coords[i] >= coords[i - 2]);
  assert.ok(geo.dot, 'a última leitura é recente: tem ponto');
  assert.equal(geo.dot.x, 64 - SPARK_DEFAULTS.pad);
  // sinal subindo = traço subindo (y diminui)
  assert.ok(coords[coords.length - 1] < coords[1]);
});

test('sparklineGeometry: escala de sensibilidade fixa (o chuvisco de uma rede parada fica pequeno)', () => {
  const noisy = pts([-100, -60], [-80, -62], [-60, -60], [-40, -61], [-20, -60], [0, -62]);
  const geo = sparklineGeometry(noisy, { now: T0, width: 64, height: 18 });
  const ys = numbers(geo.d).filter((_, i) => i % 2 === 1);
  const swing = Math.max(...ys) - Math.min(...ys);
  // 2 dB numa escala de 24 dB ocupam 1/12 da altura útil
  assert.ok(swing > 0.5 && swing < 2, `variação de ${swing}px`);
  // uma queda de 30 dB usa a altura toda
  const drop = sparklineGeometry(pts([-100, -50], [-50, -65], [0, -80]), { now: T0, width: 64, height: 18, gapMs: 60_000 });
  const dys = numbers(drop.d).filter((_, i) => i % 2 === 1);
  assert.equal(Math.min(...dys), SPARK_DEFAULTS.pad);
  assert.equal(Math.max(...dys), 18 - SPARK_DEFAULTS.pad);
});

test('sparklineGeometry: lacunas interrompem o traço; rede que sumiu fica sem o ponto final', () => {
  const series = pts([-115, -70], [-105, -70], [-40, -75], [-30, -74]);
  const geo = sparklineGeometry(series, { now: T0, gapMs: 25_000, fit: false });
  assert.equal((geo.d.match(/M/g) || []).length, 2, 'dois trechos');
  assert.equal(geo.dot, null, 'a última leitura tem 30 s: sem ponto de "agora"');
  // leitura isolada vira um ponto visível (tracinho de comprimento quase zero)
  const lone = sparklineGeometry(pts([-100, -70], [0, -72]), { now: T0, gapMs: 25_000, fit: false });
  assert.equal((lone.d.match(/h0\.01/g) || []).length, 2);
  assert.ok(lone.dot);
});

test('sparklineGeometry: com pouco histórico o traço ocupa a largura (a janela encolhe até 1/6)', () => {
  const recent = pts([-30, -60], [-20, -62], [-10, -61], [0, -60]);
  const fitted = numbers(sparklineGeometry(recent, { now: T0, width: 64, height: 18 }).d);
  assert.equal(fitted[0], SPARK_DEFAULTS.pad, 'começa na borda esquerda');
  const fixed = numbers(sparklineGeometry(recent, { now: T0, width: 64, height: 18, fit: false }).d);
  assert.ok(fixed[0] > 40, 'sem o ajuste, o traço fica espremido à direita');
  // menos de windowMs / 6 de histórico: a janela para de encolher
  const tiny = numbers(sparklineGeometry(pts([-4, -60], [0, -61]), { now: T0, width: 64, height: 18 }).d);
  assert.ok(tiny[0] > 40);
  // com leitura mais antiga que a janela, vale a janela inteira e o traço entra pela borda
  const long = pts([-300, -70], [-125, -70], [-115, -72], [-60, -71], [0, -70]);
  const geo = sparklineGeometry(long, { now: T0, width: 64, height: 18, gapMs: 70_000 });
  assert.equal(numbers(geo.d)[0], SPARK_DEFAULTS.pad);
  assert.equal(geo.count, 3);
});

test('sparklineGeometry: leituras tortas e do futuro são ignoradas', () => {
  const dirty = [null, { t: T0 - 20_000, rssi: NaN }, { t: 'x', rssi: -60 }, { t: T0 - 10_000, rssi: -60 }, { t: T0, rssi: -61 }, { t: T0 + 60_000, rssi: -10 }];
  const geo = sparklineGeometry(dirty, { now: T0 });
  assert.equal(geo.count, 2);
  assert.doesNotMatch(geo.d, /NaN|undefined|Infinity/);
});
