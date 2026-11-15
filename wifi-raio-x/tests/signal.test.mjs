import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  lerp,
  mean,
  median,
  stddev,
  percentile,
  createEma,
  createKalman1D,
  dbmToMw,
  mwToDbm,
  sumDbm,
  NOISE_FIGURE_DB,
  noiseFloorDbm,
  qualityPct,
  signalLevel,
  DEFAULT_PATH_LOSS_EXPONENT,
  MIN_DISTANCE_M,
  MAX_DISTANCE_M,
  referenceRssiAt1m,
  expectedRssi,
  indoorDistance,
  freeSpaceDistance,
} from '../app/js/core/signal.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'valor'}: esperado ${expected} ± ${tol}, veio ${actual}`);

const BAD_NUMBERS = [NaN, null, undefined, 'x', '', {}, [], Infinity, -Infinity, true];

/** Gerador pseudoaleatório determinístico (mulberry32), para ruído reproduzível. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('clamp / lerp', () => {
  test('clamp', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
    assert.equal(clamp(0, 0, 10), 0);
    assert.equal(clamp(10, 0, 10), 10);
    assert.equal(clamp(NaN, 0, 10), 0);
    assert.equal(clamp(Infinity, 0, 10), 10);
    assert.equal(clamp(-Infinity, 0, 10), 0);
  });

  test('lerp', () => {
    assert.equal(lerp(10, 20, 0), 10);
    assert.equal(lerp(10, 20, 1), 20);
    assert.equal(lerp(10, 20, 0.25), 12.5);
    assert.equal(lerp(10, 20, 2), 30);
    assert.equal(lerp(-60, -80, 0.5), -70);
  });
});

describe('mean / median / stddev / percentile', () => {
  test('mean', () => {
    assert.equal(mean([1, 2, 3, 4]), 2.5);
    assert.equal(mean([-60]), -60);
    assert.equal(mean([]), null);
    assert.equal(mean([NaN, 'x', null]), null);
    assert.equal(mean([1, NaN, 3, undefined, '7']), 2);
    assert.equal(mean(null), null);
    assert.equal(mean(undefined), null);
    assert.equal(mean(42), null);
    assert.equal(mean('123'), null);
    assert.equal(mean(new Float64Array([1, 3])), 2);
  });

  test('median', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([-70]), -70);
    assert.equal(median([-70, -50, -90, -60, -55]), -60);
    assert.equal(median([]), null);
    assert.equal(median([NaN]), null);
    assert.equal(median([5, NaN, 1, null, 3]), 3);
    assert.equal(median(null), null);
  });

  test('median e percentile não alteram a lista recebida', () => {
    const data = [3, 1, 2];
    median(data);
    percentile(data, 90);
    assert.deepEqual(data, [3, 1, 2]);
  });

  test('stddev populacional e amostral', () => {
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    assert.equal(stddev(data), 2);
    near(stddev(data, true), 2.13809, 1e-5);
    assert.equal(stddev([5]), 0);
    assert.equal(stddev([5], true), null);
    assert.equal(stddev([]), null);
    assert.equal(stddev(null), null);
    assert.equal(stddev([7, 7, 7]), 0);
    assert.equal(stddev([2, NaN, 4, 4, 4, 5, 5, 7, 9, 'x']), 2);
  });

  test('percentile com interpolação linear', () => {
    const data = [5, 1, 4, 2, 3];
    assert.equal(percentile(data, 0), 1);
    assert.equal(percentile(data, 25), 2);
    assert.equal(percentile(data, 50), 3);
    assert.equal(percentile(data, 100), 5);
    near(percentile(data, 90), 4.6, 1e-12);
    near(percentile([10, 20], 30), 13, 1e-12);
    assert.equal(percentile([7], 83), 7);
    // p fora de 0..100 é limitado
    assert.equal(percentile(data, -10), 1);
    assert.equal(percentile(data, 250), 5);
  });

  test('percentile com entrada inválida', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile(null, 50), null);
    assert.equal(percentile([1, 2, 3], NaN), null);
    assert.equal(percentile([1, 2, 3]), null);
    assert.equal(percentile([NaN, null], 50), null);
  });
});

describe('createEma', () => {
  test('o primeiro valor passa direto e os seguintes são suavizados', () => {
    const ema = createEma(0.5);
    assert.equal(ema.value, null);
    assert.equal(ema(0), 0);
    assert.equal(ema(10), 5);
    assert.equal(ema(10), 7.5);
    assert.equal(ema.value, 7.5);
  });

  test('alpha = 1 não suaviza; alpha pequeno suaviza muito', () => {
    const raw = createEma(1);
    raw(-50);
    assert.equal(raw(-80), -80);
    const slow = createEma(0.1);
    slow(-50);
    near(slow(-80), -53, 1e-12);
  });

  test('converge para um valor constante', () => {
    const ema = createEma(0.3);
    ema(-40);
    let v;
    for (let i = 0; i < 60; i++) v = ema(-70);
    near(v, -70, 1e-6);
  });

  test('valores inválidos são ignorados', () => {
    const ema = createEma(0.5);
    assert.equal(ema(NaN), null);
    assert.equal(ema(undefined), null);
    ema(-60);
    for (const bad of BAD_NUMBERS) assert.equal(ema(bad), -60, String(bad));
    assert.equal(ema(-70), -65);
  });

  test('reset e instâncias independentes', () => {
    const a = createEma(0.5);
    const b = createEma(0.5);
    a(10);
    b(100);
    assert.equal(a(20), 15);
    assert.equal(b(200), 150);
    a.reset();
    assert.equal(a.value, null);
    assert.equal(a(7), 7);
  });

  test('alpha inválido cai no padrão (0,3) e alpha fora de 0..1 é limitado', () => {
    for (const bad of [NaN, null, 'x']) {
      const ema = createEma(bad);
      ema(0);
      near(ema(10), 3, 1e-12, String(bad));
    }
    const dflt = createEma();
    dflt(0);
    near(dflt(10), 3, 1e-12);
    const big = createEma(5);
    big(0);
    assert.equal(big(10), 10);
    const neg = createEma(-1);
    neg(0);
    assert.ok(neg(10) > 0 && neg(10) < 1);
  });
});

describe('createKalman1D', () => {
  test('o primeiro valor passa direto', () => {
    const k = createKalman1D();
    assert.equal(k.value, null);
    assert.equal(k.variance, null);
    assert.equal(k(-63), -63);
    assert.equal(k.value, -63);
    assert.equal(k.variance, 9);
  });

  test('com q = 0 vira a média acumulada', () => {
    const k = createKalman1D({ q: 0, r: 4 });
    const data = [-60, -70, -65, -55, -62];
    let sum = 0;
    data.forEach((z, i) => {
      sum += z;
      near(k(z), sum / (i + 1), 1e-9, `amostra ${i}`);
    });
    near(k.variance, 4 / data.length, 1e-12);
  });

  test('converge para um valor constante e acompanha um degrau', () => {
    const k = createKalman1D();
    for (let i = 0; i < 40; i++) k(-50);
    near(k.value, -50, 1e-9);
    let prev = k.value;
    for (let i = 0; i < 25; i++) {
      const v = k(-70);
      assert.ok(v < prev && v > -70, `passo ${i}`);
      prev = v;
    }
    near(prev, -70, 0.1);
  });

  test('ganho de regime do padrão (q = 1, r = 9) ≈ 0,28', () => {
    const k = createKalman1D();
    for (let i = 0; i < 60; i++) k(-50);
    const gain = (k(-60) - -50) / -10;
    // K = P/(P + r), com P = (q + sqrt(q² + 4qr)) / 2
    const p = (1 + Math.sqrt(37)) / 2;
    near(gain, p / (p + 9), 1e-6);
    near(gain, 0.28, 0.01);
  });

  test('reduz o ruído sem criar viés', () => {
    const rand = rng(12345);
    const k = createKalman1D();
    const raw = [];
    const smooth = [];
    for (let i = 0; i < 2000; i++) {
      // soma de 4 uniformes: ruído com cara de gaussiano, desvio ≈ 3,5 dB
      const noise = (rand() + rand() + rand() + rand() - 2) * 6;
      const z = -65 + noise;
      raw.push(z);
      smooth.push(k(z));
    }
    const tail = (list) => list.slice(100);
    assert.ok(stddev(tail(smooth)) < 0.6 * stddev(tail(raw)), `${stddev(tail(smooth))} vs ${stddev(tail(raw))}`);
    near(mean(tail(smooth)), -65, 0.3);
  });

  test('q maior segue mais rápido', () => {
    const slow = createKalman1D({ q: 0.01, r: 9 });
    const fast = createKalman1D({ q: 10, r: 9 });
    for (let i = 0; i < 50; i++) {
      slow(-50);
      fast(-50);
    }
    const s = slow(-80);
    const f = fast(-80);
    assert.ok(f < s, `${f} deveria estar mais perto de -80 que ${s}`);
  });

  test('leitura inválida mantém a estimativa e aumenta a incerteza', () => {
    const k = createKalman1D({ q: 2, r: 9 });
    assert.equal(k(NaN), null);
    k(-60);
    k(-60);
    const before = k.variance;
    for (const bad of BAD_NUMBERS) assert.equal(k(bad), -60, String(bad));
    near(k.variance, before + 2 * BAD_NUMBERS.length, 1e-9);
  });

  test('reset, instâncias independentes e opções inválidas', () => {
    const a = createKalman1D({ q: 1, r: 9 });
    const b = createKalman1D({ q: 1, r: 9 });
    a(-40);
    b(-90);
    assert.equal(a.value, -40);
    assert.equal(b.value, -90);
    a.reset();
    assert.equal(a.value, null);
    assert.equal(a(-55), -55);

    for (const bad of [null, undefined, 42, 'x', { q: -1, r: 0 }, { q: NaN, r: 'x' }]) {
      const k = createKalman1D(bad);
      k(-50);
      assert.equal(k.variance, 9, String(bad)); // r padrão
      const v = k(-60);
      near(v, -50 + (10 / 19) * -10, 1e-9, String(bad)); // q padrão = 1: K = (9 + 1) / (9 + 1 + 9)
    }
  });
});

describe('dbmToMw / mwToDbm / sumDbm', () => {
  test('conversões conhecidas', () => {
    assert.equal(dbmToMw(0), 1);
    near(dbmToMw(10), 10, 1e-12);
    near(dbmToMw(20), 100, 1e-10);
    near(dbmToMw(-30), 0.001, 1e-15);
    near(dbmToMw(3), 1.9953, 1e-4);
    assert.equal(dbmToMw(-Infinity), 0);
    assert.equal(mwToDbm(1), 0);
    near(mwToDbm(100), 20, 1e-12);
    near(mwToDbm(0.001), -30, 1e-12);
    near(mwToDbm(2), 3.0103, 1e-4);
    assert.equal(mwToDbm(0), -Infinity);
  });

  test('ida e volta', () => {
    for (const dbm of [-95, -67.5, -40, 0, 17, 30]) near(mwToDbm(dbmToMw(dbm)), dbm, 1e-9);
  });

  test('entrada inválida vira null', () => {
    for (const bad of [NaN, null, undefined, 'x', {}, Infinity]) assert.equal(dbmToMw(bad), null, String(bad));
    for (const bad of [NaN, null, undefined, 'x', {}, -1, Infinity]) assert.equal(mwToDbm(bad), null, String(bad));
  });

  test('sumDbm soma potências, não decibéis', () => {
    near(sumDbm([-60, -60]), -56.9897, 1e-4); // dobrar a potência = +3,01 dB
    near(sumDbm([-60, -60, -60, -60]), -53.9794, 1e-4);
    near(sumDbm([-50, -60]), -49.5861, 1e-4);
    near(sumDbm([-50, -90]), -49.99957, 1e-4); // sinal 40 dB mais fraco quase não conta
    assert.equal(sumDbm([-72]), -72);
  });

  test('sumDbm ignora lixo e trata lista vazia como potência nenhuma', () => {
    assert.equal(sumDbm([]), -Infinity);
    assert.equal(sumDbm(null), -Infinity);
    assert.equal(sumDbm(undefined), -Infinity);
    assert.equal(sumDbm([NaN, null, 'x']), -Infinity);
    near(sumDbm([-60, NaN, -60, undefined, '−60']), -56.9897, 1e-4);
    assert.equal(sumDbm(-60), -Infinity);
  });
});

describe('noiseFloorDbm', () => {
  test('−174 dBm/Hz + largura + 7 dB de figura de ruído', () => {
    assert.equal(NOISE_FIGURE_DB, 7);
    near(noiseFloorDbm(20), -174 + 73.0103 + 7, 1e-4);
    near(noiseFloorDbm(20), -94, 0.02);
    near(noiseFloorDbm(40), -91, 0.03);
    near(noiseFloorDbm(80), -88, 0.04);
    near(noiseFloorDbm(160), -85, 0.05);
    near(noiseFloorDbm(320), -82, 0.06);
    near(noiseFloorDbm(1), -107, 1e-9); // 1 MHz: −114 dBm térmico + 7
  });

  test('+3 dB a cada vez que a largura dobra', () => {
    for (const w of [20, 40, 80, 160]) near(noiseFloorDbm(2 * w) - noiseFloorDbm(w), 3.0103, 1e-4);
  });

  test('largura padrão, figura de ruído própria e entrada inválida', () => {
    assert.equal(noiseFloorDbm(), noiseFloorDbm(20));
    near(noiseFloorDbm(20, 0), -100.99, 0.01);
    near(noiseFloorDbm(20, 10) - noiseFloorDbm(20, 7), 3, 1e-9);
    assert.equal(noiseFloorDbm(20, NaN), noiseFloorDbm(20));
    for (const bad of [0, -20, NaN, null, 'x', Infinity]) assert.equal(noiseFloorDbm(bad), null, String(bad));
  });
});

describe('qualityPct', () => {
  test('−50 dBm ou melhor = 100; −100 ou pior = 0; reta no meio', () => {
    assert.equal(qualityPct(-50), 100);
    assert.equal(qualityPct(-30), 100);
    assert.equal(qualityPct(0), 100);
    assert.equal(qualityPct(-100), 0);
    assert.equal(qualityPct(-120), 0);
    assert.equal(qualityPct(-75), 50);
    assert.equal(qualityPct(-60), 80);
    assert.equal(qualityPct(-67), 66);
    assert.equal(qualityPct(-90), 20);
    assert.equal(qualityPct(-99), 2);
    assert.equal(qualityPct(-51), 98);
  });

  test('sempre inteiro', () => {
    assert.equal(qualityPct(-62.3), 75);
    assert.equal(qualityPct(-62.8), 74);
    for (let rssi = -110; rssi <= -40; rssi += 0.37) {
      const q = qualityPct(rssi);
      assert.ok(Number.isInteger(q) && q >= 0 && q <= 100, `${rssi} -> ${q}`);
    }
  });

  test('nunca diminui quando o sinal melhora', () => {
    let prev = 0;
    for (let rssi = -110; rssi <= -40; rssi += 0.25) {
      const q = qualityPct(rssi);
      assert.ok(q >= prev);
      prev = q;
    }
  });

  test('sinal desconhecido conta como 0', () => {
    for (const bad of BAD_NUMBERS) assert.equal(qualityPct(bad), 0, String(bad));
  });
});

describe('signalLevel', () => {
  test('limites de cada nível', () => {
    const cases = [
      [-30, 'excellent', 'Excelente', 4, 'good'],
      [-50, 'excellent', 'Excelente', 4, 'good'],
      [-50.5, 'great', 'Ótimo', 4, 'good'],
      [-51, 'great', 'Ótimo', 4, 'good'],
      [-60, 'great', 'Ótimo', 4, 'good'],
      [-61, 'good', 'Bom', 3, 'good'],
      [-67, 'good', 'Bom', 3, 'good'],
      [-68, 'fair', 'Regular', 2, 'ok'],
      [-75, 'fair', 'Regular', 2, 'ok'],
      [-76, 'weak', 'Fraco', 1, 'warn'],
      [-82, 'weak', 'Fraco', 1, 'warn'],
      [-83, 'very-weak', 'Muito fraco', 0, 'bad'],
      [-100, 'very-weak', 'Muito fraco', 0, 'bad'],
      [-200, 'very-weak', 'Muito fraco', 0, 'bad'],
    ];
    for (const [rssi, key, label, bars, tone] of cases) {
      const level = signalLevel(rssi);
      assert.equal(level.key, key, `${rssi}`);
      assert.equal(level.label, label, `${rssi}`);
      assert.equal(level.bars, bars, `${rssi}`);
      assert.equal(level.tone, tone, `${rssi}`);
      assert.equal(typeof level.hint, 'string');
      assert.ok(level.hint.length > 0);
    }
  });

  test('barras e tom nunca melhoram quando o sinal piora', () => {
    const toneRank = { good: 3, ok: 2, warn: 1, bad: 0 };
    let prev = signalLevel(-20);
    for (let rssi = -20; rssi >= -110; rssi -= 0.5) {
      const level = signalLevel(rssi);
      assert.ok(level.bars <= prev.bars);
      assert.ok(toneRank[level.tone] <= toneRank[prev.tone]);
      assert.ok(level.bars >= 0 && level.bars <= 4);
      prev = level;
    }
  });

  test('sinal desconhecido', () => {
    for (const bad of BAD_NUMBERS) {
      const level = signalLevel(bad);
      assert.equal(level.key, 'unknown', String(bad));
      assert.equal(level.bars, 0);
      assert.equal(level.tone, 'bad');
      assert.equal(level.label, 'Sem leitura');
    }
  });

  test('devolve um objeto novo a cada chamada', () => {
    const a = signalLevel(-55);
    a.label = 'mexido';
    assert.equal(signalLevel(-55).label, 'Ótimo');
    const u = signalLevel(NaN);
    u.label = 'mexido';
    assert.equal(signalLevel(NaN).label, 'Sem leitura');
  });
});

describe('distância', () => {
  test('referência a 1 m: −40 dBm em 2437 MHz, menos 20·log10 da frequência', () => {
    assert.equal(referenceRssiAt1m(2437), -40);
    near(referenceRssiAt1m(5180), -46.549, 1e-3);
    near(referenceRssiAt1m(4874), -46.0206, 1e-4); // o dobro da frequência: −6,02 dB
    near(referenceRssiAt1m(6135), -48.019, 1e-3);
    for (const bad of [0, NaN, null, undefined, -5180]) assert.equal(referenceRssiAt1m(bad), -40, String(bad));
  });

  test('expectedRssi: rssi = p0 − 10·n·log10(d), com n = 3 por padrão', () => {
    assert.equal(DEFAULT_PATH_LOSS_EXPONENT, 3);
    assert.equal(expectedRssi(1, 2437), -40);
    near(expectedRssi(10, 2437), -70, 1e-9);
    near(expectedRssi(100, 2437), -100, 1e-9);
    near(expectedRssi(2, 2437), -49.031, 1e-3);
    near(expectedRssi(1, 5180), -46.549, 1e-3);
    near(expectedRssi(10, 5180), -76.549, 1e-3);
  });

  test('expectedRssi com p0 e n próprios', () => {
    near(expectedRssi(10, 2437, { p0: -35, n: 2 }), -55, 1e-9);
    near(expectedRssi(10, 5180, { p0: -35 }), -65, 1e-9);
    near(expectedRssi(10, 2437, { n: 4 }), -80, 1e-9);
    // opções inválidas caem no padrão
    near(expectedRssi(10, 2437, { p0: NaN, n: 0 }), -70, 1e-9);
    near(expectedRssi(10, 2437, null), -70, 1e-9);
    near(expectedRssi(10, 2437, 'x'), -70, 1e-9);
  });

  test('expectedRssi: perto demais conta como 0,3 m; frequência desconhecida usa 2,4 GHz', () => {
    assert.equal(MIN_DISTANCE_M, 0.3);
    assert.equal(expectedRssi(0, 2437), expectedRssi(0.3, 2437));
    assert.equal(expectedRssi(-5, 2437), expectedRssi(0.3, 2437));
    near(expectedRssi(0.3, 2437), -24.314, 1e-3);
    assert.equal(expectedRssi(10, NaN), expectedRssi(10, 2437));
    assert.equal(expectedRssi(10, 0), expectedRssi(10, 2437));
    for (const bad of [NaN, null, undefined, 'x', Infinity]) assert.equal(expectedRssi(bad, 2437), null, String(bad));
  });

  test('indoorDistance é o inverso de expectedRssi', () => {
    assert.equal(indoorDistance(-40, 2437), 1);
    near(indoorDistance(-70, 2437), 10, 1e-9);
    near(indoorDistance(-55, 2437), 3.1623, 1e-4);
    for (const freq of [2412, 2462, 5180, 5745, 6135]) {
      for (const d of [0.3, 0.5, 1, 2.5, 7, 20, 60, 150, 200]) {
        near(indoorDistance(expectedRssi(d, freq), freq), d, 1e-9 * d + 1e-12, `${freq} MHz, ${d} m`);
      }
    }
    near(indoorDistance(expectedRssi(8, 5180, { p0: -38, n: 2.4 }), 5180, { p0: -38, n: 2.4 }), 8, 1e-9);
  });

  test('indoorDistance: mesmo sinal em frequência mais alta = mais perto', () => {
    const d24 = indoorDistance(-65, 2437);
    const d5 = indoorDistance(-65, 5180);
    const d6 = indoorDistance(-65, 6135);
    assert.ok(d5 < d24 && d6 < d5, `${d24} ${d5} ${d6}`);
    near(d24, 6.813, 1e-3);
  });

  test('indoorDistance: n menor (ambiente aberto) dá distância maior', () => {
    assert.ok(indoorDistance(-70, 2437, { n: 2 }) > indoorDistance(-70, 2437, { n: 3 }));
    near(indoorDistance(-70, 2437, { n: 2 }), 31.623, 1e-3);
  });

  test('indoorDistance fica entre 0,3 e 200 m', () => {
    assert.equal(MAX_DISTANCE_M, 200);
    assert.equal(indoorDistance(-10, 2437), 0.3);
    assert.equal(indoorDistance(0, 5180), 0.3);
    assert.equal(indoorDistance(-120, 2437), 200);
    assert.equal(indoorDistance(-300, 2437), 200);
    for (let rssi = -130; rssi <= 10; rssi += 3) {
      const d = indoorDistance(rssi, 5500);
      assert.ok(d >= 0.3 && d <= 200, `${rssi} -> ${d}`);
    }
  });

  test('indoorDistance: nunca aumenta quando o sinal melhora', () => {
    let prev = Infinity;
    for (let rssi = -110; rssi <= -20; rssi += 1) {
      const d = indoorDistance(rssi, 2437);
      assert.ok(d <= prev);
      prev = d;
    }
  });

  test('indoorDistance com entrada inválida', () => {
    for (const bad of BAD_NUMBERS) assert.equal(indoorDistance(bad, 2437), null, String(bad));
    // frequência desconhecida: usa a referência de 2,4 GHz em vez de desistir
    for (const bad of [0, NaN, null, undefined]) assert.equal(indoorDistance(-70, bad), indoorDistance(-70, 2437));
    near(indoorDistance(-70, 2437, { p0: 'x', n: -3 }), 10, 1e-9);
  });

  test('freeSpaceDistance: 10^((27,55 − 20·log10(f) + |rssi|) / 20)', () => {
    near(freeSpaceDistance(-60, 2437), 9.787, 1e-3);
    near(freeSpaceDistance(-60, 5180), 4.604, 1e-3);
    near(freeSpaceDistance(-80, 2437), 97.87, 1e-2);
    // usa o módulo do sinal
    assert.equal(freeSpaceDistance(60, 2437), freeSpaceDistance(-60, 2437));
    // a perda de espaço livre na distância calculada volta a ser |rssi|
    for (const [rssi, freq] of [
      [-45, 2412],
      [-72, 5500],
      [-88, 6135],
    ]) {
      const d = freeSpaceDistance(rssi, freq);
      const fspl = 20 * Math.log10(d) + 20 * Math.log10(freq) - 27.55;
      near(fspl, Math.abs(rssi), 1e-9);
    }
    // 20 dB a menos = 10 vezes mais longe
    near(freeSpaceDistance(-80, 5180) / freeSpaceDistance(-60, 5180), 10, 1e-9);
  });

  test('freeSpaceDistance com entrada inválida', () => {
    for (const bad of BAD_NUMBERS) {
      assert.equal(freeSpaceDistance(bad, 2437), null, `rssi ${String(bad)}`);
      assert.equal(freeSpaceDistance(-60, bad), null, `freq ${String(bad)}`);
    }
    assert.equal(freeSpaceDistance(-60, 0), null);
    assert.equal(freeSpaceDistance(-60, -2437), null);
  });
});
