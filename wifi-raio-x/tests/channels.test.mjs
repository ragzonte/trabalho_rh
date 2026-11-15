import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BANDS,
  WIDTH_60GHZ,
  bandOf,
  freqToChannel,
  channelToFreq,
  channelList,
  isDfs,
  uniiOf,
  blocksOf,
  blocksContaining,
  blockContaining,
  androidWidthToMHz,
  occupancy,
  overlapMHz,
  maskDb,
  interferenceFactor,
} from '../app/js/core/channels.js';

// Constantes do Android (ScanResult.CHANNEL_WIDTH_*), conferidas em developer.android.com
const CW = { W20: 0, W40: 1, W80: 2, W160: 3, W80P80: 4, W320: 5 };

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'valor'}: esperado ${expected} ± ${tol}, veio ${actual}`);

const centers = (blocks) => blocks.map((b) => b.center);
const steps = (from, to, step) => {
  const out = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
};

const OCC_KEYS = [
  'approx',
  'band',
  'centerChannel',
  'centerFreq',
  'channel',
  'channels',
  'dfs',
  'freq',
  'label',
  'noncontiguous',
  'psc',
  'secondary',
  'segments',
  'unii',
  'widthMHz',
];

describe('bandOf', () => {
  test('reconhece cada faixa, com os limites', () => {
    const cases = [
      [2399, null],
      [2400, '2.4'],
      [2412, '2.4'],
      [2484, '2.4'],
      [2500, '2.4'],
      [2501, null],
      [5149, null],
      [5150, '5'],
      [5180, '5'],
      [5885, '5'],
      [5895, '5'],
      [5896, null],
      [5924, null],
      [5925, '6'],
      [5935, '6'],
      [5955, '6'],
      [7115, '6'],
      [7125, '6'],
      [7126, null],
      [56999, null],
      [57000, '60'],
      [58320, '60'],
      [71000, '60'],
      [71001, null],
    ];
    for (const [freq, band] of cases) assert.equal(bandOf(freq), band, `freq ${freq}`);
  });

  test('entrada inválida vira null', () => {
    for (const bad of [0, -2437, NaN, Infinity, null, undefined, '', 'abc', {}, [], true]) {
      assert.equal(bandOf(bad), null, String(bad));
    }
  });

  test('aceita número em texto', () => {
    assert.equal(bandOf('2437'), '2.4');
  });

  test('BANDS lista as quatro faixas', () => {
    assert.deepEqual([...BANDS], ['2.4', '5', '6', '60']);
  });
});

describe('freqToChannel / channelToFreq', () => {
  test('2,4 GHz: 1..13 a cada 5 MHz e o 14 em 2484', () => {
    assert.equal(freqToChannel(2412), 1);
    assert.equal(freqToChannel(2437), 6);
    assert.equal(freqToChannel(2462), 11);
    assert.equal(freqToChannel(2472), 13);
    assert.equal(freqToChannel(2484), 14);
    assert.equal(freqToChannel(2477), null); // seria o "14" pela fórmula, mas não existe
    assert.equal(freqToChannel(2407), null);
    assert.equal(freqToChannel(2413), null);
    for (let ch = 1; ch <= 13; ch++) assert.equal(channelToFreq(ch, '2.4'), 2407 + 5 * ch);
    assert.equal(channelToFreq(14, '2.4'), 2484);
    assert.equal(channelToFreq(0, '2.4'), null);
    assert.equal(channelToFreq(15, '2.4'), null);
  });

  test('5 GHz: (f − 5000) / 5, inclusive centros de canais largos', () => {
    assert.equal(freqToChannel(5180), 36);
    assert.equal(freqToChannel(5320), 64);
    assert.equal(freqToChannel(5500), 100);
    assert.equal(freqToChannel(5720), 144);
    assert.equal(freqToChannel(5745), 149);
    assert.equal(freqToChannel(5825), 165);
    assert.equal(freqToChannel(5885), 177);
    assert.equal(freqToChannel(5210), 42);
    assert.equal(freqToChannel(5250), 50);
    assert.equal(freqToChannel(5182), null);
    assert.equal(channelToFreq(36, '5'), 5180);
    assert.equal(channelToFreq(165, '5'), 5825);
    assert.equal(channelToFreq(42, '5'), 5210);
    assert.equal(channelToFreq(200, '5'), null); // 6000 MHz já não é 5 GHz
    assert.equal(channelToFreq(1, '5'), null);
  });

  test('6 GHz: (f − 5950) / 5 e o canal 2 em 5935 MHz', () => {
    assert.equal(freqToChannel(5935), 2);
    assert.equal(channelToFreq(2, '6'), 5935);
    assert.equal(freqToChannel(5955), 1);
    assert.equal(freqToChannel(5975), 5);
    assert.equal(freqToChannel(6135), 37);
    assert.equal(freqToChannel(7115), 233);
    assert.equal(freqToChannel(6105), 31); // centro de 320 MHz
    assert.equal(freqToChannel(5965), 3); // centro de 40 MHz
    assert.equal(freqToChannel(5960), null); // daria "2" pela fórmula
    assert.equal(freqToChannel(5950), null);
    assert.equal(freqToChannel(5945), null);
    assert.equal(freqToChannel(7120), null);
    assert.equal(channelToFreq(1, '6'), 5955);
    assert.equal(channelToFreq(37, '6'), 6135);
    assert.equal(channelToFreq(233, '6'), 7115);
    assert.equal(channelToFreq(234, '6'), null);
    assert.equal(channelToFreq(0, '6'), null);
  });

  test('60 GHz: 58320 + 2160 · (canal − 1)', () => {
    assert.equal(WIDTH_60GHZ, 2160);
    const freqs = [58320, 60480, 62640, 64800, 66960, 69120];
    freqs.forEach((f, i) => {
      assert.equal(freqToChannel(f), i + 1);
      assert.equal(channelToFreq(i + 1, '60'), f);
    });
    assert.equal(freqToChannel(60000), null);
    assert.equal(channelToFreq(7, '60'), null);
    assert.equal(channelToFreq(0, '60'), null);
  });

  test('sem faixa: até 14 é 2,4 GHz, o resto é 5 GHz', () => {
    assert.equal(channelToFreq(6), 2437);
    assert.equal(channelToFreq(14), 2484);
    assert.equal(channelToFreq(36), 5180);
    assert.equal(channelToFreq(149), 5745);
  });

  test('aceita a faixa como número ou com "GHz"', () => {
    assert.equal(channelToFreq(5, 6), 5975);
    assert.equal(channelToFreq(6, 2.4), 2437);
    assert.equal(channelToFreq(36, '5 GHz'), 5180);
    assert.equal(channelToFreq(6, '2,4'), 2437);
  });

  test('entrada inválida vira null', () => {
    for (const bad of [0, NaN, null, undefined, 'x', -5180, 3000, Infinity]) {
      assert.equal(freqToChannel(bad), null, String(bad));
    }
    assert.equal(channelToFreq(NaN, '5'), null);
    assert.equal(channelToFreq(36.5, '5'), null);
    assert.equal(channelToFreq(null, '5'), null);
    assert.equal(channelToFreq(undefined), null);
    assert.equal(channelToFreq(36, 'x'), null);
    assert.equal(channelToFreq(36, '7'), null);
    assert.equal(channelToFreq(-1), null);
  });

  test('ida e volta em todos os canais de todas as faixas', () => {
    for (const band of BANDS) {
      for (const entry of channelList(band, { all: true })) {
        assert.equal(bandOf(entry.freq), band);
        assert.equal(freqToChannel(entry.freq), entry.channel, `${band} canal ${entry.channel}`);
        assert.equal(channelToFreq(entry.channel, band), entry.freq);
      }
    }
  });
});

describe('channelList', () => {
  test('2,4 GHz: 1..13; o 14 só com { all: true }', () => {
    const list = channelList('2.4');
    assert.deepEqual(
      list.map((c) => c.channel),
      steps(1, 13, 1),
    );
    assert.deepEqual(
      list.map((c) => c.freq),
      steps(2412, 2472, 5),
    );
    for (const c of list) {
      assert.equal(c.dfs, false);
      assert.equal(c.psc, false);
      assert.equal(c.unii, null);
    }
    const all = channelList('2.4', { all: true });
    assert.equal(all.length, 14);
    assert.equal(all[13].channel, 14);
    assert.equal(all[13].freq, 2484);
    assert.match(all[13].note, /Japão/);
    for (const ch of [1, 6, 11]) assert.match(list[ch - 1].note, /não se sobrepõem/);
    assert.equal(list[2].note, null);
  });

  test('5 GHz: canais, sub-faixas U-NII e DFS', () => {
    const list = channelList('5');
    const expected = [...steps(36, 64, 4), ...steps(100, 144, 4), ...steps(149, 177, 4)];
    assert.deepEqual(
      list.map((c) => c.channel),
      expected,
    );
    assert.equal(list.length, 28);
    const dfs = list.filter((c) => c.dfs).map((c) => c.channel);
    assert.deepEqual(dfs, [...steps(52, 64, 4), ...steps(100, 144, 4)]);
    const unii = (name) => list.filter((c) => c.unii === name).map((c) => c.channel);
    assert.deepEqual(unii('U-NII-1'), [36, 40, 44, 48]);
    assert.deepEqual(unii('U-NII-2A'), [52, 56, 60, 64]);
    assert.deepEqual(unii('U-NII-2C'), steps(100, 144, 4));
    assert.deepEqual(unii('U-NII-3'), [149, 153, 157, 161, 165]);
    assert.deepEqual(unii('U-NII-4'), [169, 173, 177]);
    for (const c of list) {
      assert.equal(c.freq, 5000 + 5 * c.channel);
      assert.equal(c.psc, false);
      if (c.dfs) assert.match(c.note, /DFS/);
      if (c.unii === 'U-NII-4') assert.match(c.note, /U-NII-4/);
    }
    assert.equal(list[0].note, null);
  });

  test('6 GHz: 1, 5, ..., 233 com os PSC marcados', () => {
    const list = channelList('6');
    assert.equal(list.length, 59);
    assert.deepEqual(
      list.map((c) => c.channel),
      steps(1, 233, 4),
    );
    assert.equal(list[0].freq, 5955);
    assert.equal(list[58].freq, 7115);
    const psc = list.filter((c) => c.psc).map((c) => c.channel);
    assert.deepEqual(psc, [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213, 229]);
    for (const c of list) {
      assert.equal(c.dfs, false);
      assert.equal(c.freq, 5950 + 5 * c.channel);
      if (c.psc) assert.match(c.note, /PSC/);
      else assert.equal(c.note, null);
    }
    const unii = (name) => list.filter((c) => c.unii === name).map((c) => c.channel);
    assert.deepEqual(unii('U-NII-5'), steps(1, 93, 4));
    assert.deepEqual(unii('U-NII-6'), steps(97, 113, 4));
    assert.deepEqual(unii('U-NII-7'), steps(117, 181, 4));
    assert.deepEqual(unii('U-NII-7/8'), [185]); // 6865–6885 MHz fica metade em cada sub-faixa
    assert.deepEqual(unii('U-NII-8'), steps(189, 233, 4));
  });

  test('60 GHz e faixa desconhecida', () => {
    assert.deepEqual(
      channelList('60').map((c) => c.channel),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(channelList('7'), []);
    assert.deepEqual(channelList(null), []);
    assert.deepEqual(channelList(), []);
  });

  test('devolve uma lista nova a cada chamada', () => {
    const a = channelList('5');
    a.length = 0;
    assert.equal(channelList('5').length, 28);
    assert.ok(Object.isFrozen(channelList('5')[0]));
  });
});

describe('isDfs / uniiOf', () => {
  test('isDfs considera a largura do bloco', () => {
    assert.equal(isDfs(5240), false); // canal 48
    assert.equal(isDfs(5260), true); // canal 52
    assert.equal(isDfs(5320), true); // canal 64
    assert.equal(isDfs(5500), true); // canal 100
    assert.equal(isDfs(5720), true); // canal 144
    assert.equal(isDfs(5745), false); // canal 149
    assert.equal(isDfs(5210, 80), false); // 36–48
    assert.equal(isDfs(5250, 160), true); // 36–64
    assert.equal(isDfs(5815, 160), false); // 149–177
    assert.equal(isDfs(2437), false);
    assert.equal(isDfs(6135, 160), false);
    assert.equal(isDfs(NaN), false);
    assert.equal(isDfs(5260, 0), false);
  });

  test('uniiOf', () => {
    assert.equal(uniiOf(5180), 'U-NII-1');
    assert.equal(uniiOf(5720), 'U-NII-2C');
    assert.equal(uniiOf(5845), 'U-NII-4');
    assert.equal(uniiOf(5935), 'U-NII-5');
    assert.equal(uniiOf(6875), 'U-NII-7/8');
    assert.equal(uniiOf(2437), null);
    assert.equal(uniiOf(NaN), null);
  });
});

describe('blocksOf', () => {
  test('5 GHz, 40 MHz: os pares (36,40)->38 ...', () => {
    const blocks = blocksOf('5', 40);
    assert.deepEqual(centers(blocks), [38, 46, 54, 62, 102, 110, 118, 126, 134, 142, 151, 159, 167, 175]);
    assert.deepEqual([...blocks[0].channels], [36, 40]);
    assert.equal(blocks[0].centerFreq, 5190);
    assert.equal(blocks[0].lo, 5170);
    assert.equal(blocks[0].hi, 5210);
    assert.deepEqual([...blocks[13].channels], [173, 177]);
  });

  test('5 GHz, 80 MHz: centros 42, 58, 106, 122, 138, 155, 171', () => {
    const blocks = blocksOf('5', 80);
    assert.deepEqual(centers(blocks), [42, 58, 106, 122, 138, 155, 171]);
    assert.deepEqual(
      blocks.map((b) => [...b.channels]),
      [
        [36, 40, 44, 48],
        [52, 56, 60, 64],
        [100, 104, 108, 112],
        [116, 120, 124, 128],
        [132, 136, 140, 144],
        [149, 153, 157, 161],
        [165, 169, 173, 177],
      ],
    );
    assert.deepEqual(
      blocks.map((b) => b.dfs),
      [false, true, true, true, true, false, false],
    );
    assert.deepEqual([blocks[0].lo, blocks[0].centerFreq, blocks[0].hi], [5170, 5210, 5250]);
    assert.deepEqual([blocks[5].lo, blocks[5].centerFreq, blocks[5].hi], [5735, 5775, 5815]);
    assert.equal(blocks[0].unii, 'U-NII-1');
    assert.equal(blocks[6].unii, 'U-NII-3 + U-NII-4');
  });

  test('5 GHz, 160 MHz: centros 50, 114, 163', () => {
    const blocks = blocksOf('5', 160);
    assert.deepEqual(centers(blocks), [50, 114, 163]);
    assert.deepEqual([...blocks[0].channels], steps(36, 64, 4));
    assert.deepEqual([...blocks[1].channels], steps(100, 128, 4));
    assert.deepEqual([...blocks[2].channels], steps(149, 177, 4));
    // 36–64 inclui os canais 52–64, que exigem DFS
    assert.deepEqual(
      blocks.map((b) => b.dfs),
      [true, true, false],
    );
    assert.deepEqual([blocks[0].lo, blocks[0].centerFreq, blocks[0].hi], [5170, 5250, 5330]);
    assert.equal(blocks[0].unii, 'U-NII-1 + U-NII-2A');
  });

  test('5 GHz não tem 320 MHz; 20 MHz devolve os canais simples', () => {
    assert.deepEqual(blocksOf('5', 320), []);
    const b20 = blocksOf('5', 20);
    assert.equal(b20.length, 28);
    assert.deepEqual([...b20[0].channels], [36]);
    assert.deepEqual([b20[0].lo, b20[0].centerFreq, b20[0].hi], [5170, 5180, 5190]);
    assert.equal(b20[0].center, 36);
  });

  test('6 GHz: 40 = 3, 11, ...; 80 = 7, 23, ...; 160 = 15, 47, ...', () => {
    assert.deepEqual(centers(blocksOf('6', 40)), steps(3, 227, 8));
    assert.equal(blocksOf('6', 40).length, 29);
    assert.deepEqual(centers(blocksOf('6', 80)), steps(7, 215, 16));
    assert.equal(blocksOf('6', 80).length, 14);
    assert.deepEqual(centers(blocksOf('6', 160)), steps(15, 207, 32));
    assert.equal(blocksOf('6', 160).length, 7);
    assert.equal(blocksOf('6', 20).length, 59);
    assert.deepEqual([...blocksOf('6', 40)[0].channels], [1, 5]);
    assert.deepEqual([...blocksOf('6', 80)[0].channels], [1, 5, 9, 13]);
    assert.deepEqual([...blocksOf('6', 160)[1].channels], steps(33, 61, 4));
    for (const w of [20, 40, 80, 160, 320]) for (const b of blocksOf('6', w)) assert.equal(b.dfs, false);
  });

  // Regressão: blocos com o canal 185 (metade em cada sub-faixa) saíam "U-NII-7 + U-NII-7/8 + U-NII-8".
  test('6 GHz: sub-faixas dos blocos que cruzam a divisa U-NII-7 / U-NII-8', () => {
    const uniiOfBlock = (width, channel) => blocksOf('6', width).find((b) => b.channels.includes(channel)).unii;
    assert.equal(uniiOfBlock(20, 185), 'U-NII-7/8'); // o canal sozinho mantém o rótulo próprio
    assert.equal(uniiOfBlock(40, 185), 'U-NII-7 + U-NII-8'); // 185 + 189
    assert.equal(uniiOfBlock(80, 185), 'U-NII-7 + U-NII-8'); // 177-189
    assert.equal(uniiOfBlock(160, 185), 'U-NII-7 + U-NII-8'); // 161-189
    assert.deepEqual(
      blocksOf('6', 320).map((b) => b.unii),
      ['U-NII-5', 'U-NII-5', 'U-NII-5 + U-NII-6 + U-NII-7', 'U-NII-6 + U-NII-7', 'U-NII-7 + U-NII-8', 'U-NII-7 + U-NII-8'],
    );
    for (const width of [20, 40, 80, 160, 320]) {
      for (const b of blocksOf('6', width)) {
        if (width > 20) assert.doesNotMatch(b.unii, /\//, `${width} MHz, centro ${b.center}`);
        assert.equal(new Set(b.unii.split(' + ')).size, b.unii.split(' + ').length);
      }
    }
    assert.equal(uniiOfBlock(80, 181), 'U-NII-7 + U-NII-8');
    assert.equal(uniiOfBlock(40, 181), 'U-NII-7'); // 177 + 181
    assert.equal(uniiOfBlock(40, 189), 'U-NII-7 + U-NII-8');
    assert.equal(uniiOfBlock(40, 193), 'U-NII-8');
  });

  test('6 GHz, 320 MHz: 31, 63, 95, 127, 159, 191 (blocos que se sobrepõem)', () => {
    const blocks = blocksOf('6', 320);
    assert.deepEqual(centers(blocks), [31, 63, 95, 127, 159, 191]);
    assert.deepEqual([...blocks[0].channels], steps(1, 61, 4));
    assert.deepEqual([...blocks[1].channels], steps(33, 93, 4));
    assert.deepEqual([...blocks[5].channels], steps(161, 221, 4));
    assert.deepEqual([blocks[0].lo, blocks[0].centerFreq, blocks[0].hi], [5945, 6105, 6265]);
    assert.deepEqual([blocks[1].lo, blocks[1].centerFreq, blocks[1].hi], [6105, 6265, 6425]);
  });

  test('2,4 GHz: 13 canais de 20 MHz e 40 MHz com centros 3..11', () => {
    assert.equal(blocksOf('2.4', 20).length, 13);
    const b40 = blocksOf('2.4', 40);
    assert.deepEqual(centers(b40), steps(3, 11, 1));
    assert.deepEqual([...b40[0].channels], [1, 5]);
    assert.deepEqual([b40[0].lo, b40[0].centerFreq, b40[0].hi], [2402, 2422, 2442]);
    assert.deepEqual([...b40[8].channels], [9, 13]);
    assert.deepEqual(blocksOf('2.4', 80), []);
  });

  test('todo bloco é coerente: largura, centro e quantidade de canais', () => {
    for (const band of ['2.4', '5', '6']) {
      for (const width of [20, 40, 80, 160, 320]) {
        for (const b of blocksOf(band, width)) {
          const id = `${band} ${width} centro ${b.center}`;
          assert.equal(b.band, band, id);
          assert.equal(b.widthMHz, width, id);
          assert.equal(b.hi - b.lo, width, id);
          assert.equal(b.centerFreq, (b.lo + b.hi) / 2, id);
          assert.equal(channelToFreq(b.center, band), b.centerFreq, id);
          if (band !== '2.4') assert.equal(b.channels.length, width / 20, id);
          for (const ch of b.channels) {
            const f = channelToFreq(ch, band);
            assert.ok(f - 10 >= b.lo && f + 10 <= b.hi, `${id}: canal ${ch} fora do bloco`);
          }
          assert.ok(Object.isFrozen(b), id);
        }
      }
    }
  });

  test('combinação inexistente ou entrada inválida devolve []', () => {
    assert.deepEqual(blocksOf('5', 30), []);
    assert.deepEqual(blocksOf('60', 20), []);
    assert.deepEqual(blocksOf('x', 20), []);
    assert.deepEqual(blocksOf(null, null), []);
    assert.deepEqual(blocksOf('5', NaN), []);
    assert.deepEqual(blocksOf('5', 'constructor'), []);
    assert.deepEqual(blocksOf(), []);
  });

  test('devolve uma lista nova a cada chamada', () => {
    const a = blocksOf('5', 80);
    a.pop();
    assert.equal(blocksOf('5', 80).length, 7);
  });
});

describe('blockContaining / blocksContaining', () => {
  test('5 GHz', () => {
    assert.equal(blockContaining('5', 20, 36).center, 36);
    assert.equal(blockContaining('5', 40, 36).center, 38);
    assert.equal(blockContaining('5', 40, 40).center, 38);
    assert.equal(blockContaining('5', 40, 165).center, 167);
    assert.equal(blockContaining('5', 80, 44).center, 42);
    assert.equal(blockContaining('5', 80, 161).center, 155);
    assert.equal(blockContaining('5', 80, 165).center, 171);
    assert.equal(blockContaining('5', 160, 100).center, 114);
    assert.equal(blockContaining('5', 160, 64).center, 50);
    assert.equal(blockContaining('5', 160, 132), null); // 132–144 não têm bloco de 160 MHz
    assert.equal(blockContaining('5', 320, 36), null);
    assert.equal(blockContaining('5', 80, 38), null); // 38 não é um canal de 20 MHz
  });

  test('6 GHz', () => {
    assert.equal(blockContaining('6', 40, 37).center, 35);
    assert.equal(blockContaining('6', 80, 37).center, 39);
    assert.equal(blockContaining('6', 160, 37).center, 47);
    assert.equal(blockContaining('6', 40, 229).center, 227);
    assert.equal(blockContaining('6', 40, 233), null);
    assert.equal(blockContaining('6', 80, 229), null);
    assert.equal(blockContaining('6', 160, 221).center, 207);
    assert.equal(blockContaining('6', 20, 2), null); // o canal 2 (5935 MHz) não entra em junção
  });

  test('320 MHz: o primário pode caber em dois blocos', () => {
    assert.deepEqual(centers(blocksContaining('6', 320, 5)), [31]);
    assert.deepEqual(centers(blocksContaining('6', 320, 37)), [31, 63]);
    assert.deepEqual(centers(blocksContaining('6', 320, 69)), [63, 95]);
    assert.deepEqual(centers(blocksContaining('6', 320, 189)), [159, 191]);
    assert.deepEqual(centers(blocksContaining('6', 320, 197)), [191]);
    assert.deepEqual(centers(blocksContaining('6', 320, 225)), []);
    assert.equal(blockContaining('6', 320, 37).center, 31); // ambíguo: o de centro mais baixo
  });

  test('2,4 GHz, 40 MHz: secundário acima e/ou abaixo', () => {
    assert.deepEqual(centers(blocksContaining('2.4', 40, 1)), [3]);
    assert.deepEqual(centers(blocksContaining('2.4', 40, 4)), [6]);
    assert.deepEqual(centers(blocksContaining('2.4', 40, 6)), [4, 8]);
    assert.deepEqual(centers(blocksContaining('2.4', 40, 9)), [7, 11]);
    assert.deepEqual(centers(blocksContaining('2.4', 40, 10)), [8]);
    assert.deepEqual(centers(blocksContaining('2.4', 40, 13)), [11]);
    assert.deepEqual(centers(blocksContaining('2.4', 40, 14)), []);
  });

  test('entrada inválida', () => {
    assert.equal(blockContaining('5', 80, NaN), null);
    assert.equal(blockContaining('5', 80, null), null);
    assert.equal(blockContaining('x', 80, 36), null);
    assert.equal(blockContaining(), null);
    assert.deepEqual(blocksContaining('5', 80, undefined), []);
  });
});

describe('androidWidthToMHz', () => {
  test('constantes CHANNEL_WIDTH_* do Android', () => {
    assert.equal(androidWidthToMHz(CW.W20), 20);
    assert.equal(androidWidthToMHz(CW.W40), 40);
    assert.equal(androidWidthToMHz(CW.W80), 80);
    assert.equal(androidWidthToMHz(CW.W160), 160);
    assert.equal(androidWidthToMHz(CW.W80P80), 160);
    assert.equal(androidWidthToMHz(CW.W320), 320);
  });

  test('desconhecido vira 20', () => {
    for (const bad of [-1, 6, 99, NaN, null, undefined, 'x', 1.5]) assert.equal(androidWidthToMHz(bad), 20);
  });
});

describe('occupancy: 5 GHz', () => {
  test('20 MHz ignora os centerFreq (zerados, iguais à frequência ou lixo)', () => {
    for (const extra of [{}, { centerFreq0: 0, centerFreq1: 0 }, { centerFreq0: 5180 }, { centerFreq0: 5210, centerFreq1: 9999 }]) {
      const o = occupancy({ frequency: 5180, channelWidth: CW.W20, ...extra });
      assert.equal(o.band, '5');
      assert.equal(o.channel, 36);
      assert.equal(o.freq, 5180);
      assert.equal(o.widthMHz, 20);
      assert.equal(o.centerFreq, 5180);
      assert.equal(o.centerChannel, 36);
      assert.deepEqual(o.segments, [{ lo: 5170, hi: 5190 }]);
      assert.deepEqual(o.channels, [36]);
      assert.equal(o.secondary, null);
      assert.equal(o.noncontiguous, false);
      assert.equal(o.dfs, false);
      assert.equal(o.unii, 'U-NII-1');
      assert.equal(o.psc, false);
      assert.equal(o.approx, false);
      assert.equal(o.label, '36 · 20 MHz');
    }
  });

  test('40 MHz', () => {
    const o = occupancy({ frequency: 5200, channelWidth: CW.W40, centerFreq0: 5190 });
    assert.equal(o.channel, 40);
    assert.equal(o.widthMHz, 40);
    assert.equal(o.centerFreq, 5190);
    assert.equal(o.centerChannel, 38);
    assert.deepEqual(o.segments, [{ lo: 5170, hi: 5210 }]);
    assert.deepEqual(o.channels, [36, 40]);
    assert.equal(o.secondary, null); // só é informado em 2,4 GHz
    assert.equal(o.label, '40 · 40 MHz (36–40)');
  });

  test('80 MHz, o exemplo do rótulo', () => {
    const o = occupancy({ frequency: 5180, channelWidth: CW.W80, centerFreq0: 5210, centerFreq1: 0 });
    assert.equal(o.widthMHz, 80);
    assert.equal(o.centerFreq, 5210);
    assert.equal(o.centerChannel, 42);
    assert.deepEqual(o.segments, [{ lo: 5170, hi: 5250 }]);
    assert.deepEqual(o.channels, [36, 40, 44, 48]);
    assert.equal(o.dfs, false);
    assert.equal(o.approx, false);
    assert.equal(o.label, '36 · 80 MHz (36–48)');
  });

  test('80 MHz sem centro, com centro igual à frequência ou com centro absurdo: vale a tabela', () => {
    const ref = occupancy({ frequency: 5745, channelWidth: CW.W80, centerFreq0: 5775 });
    assert.deepEqual(ref.segments, [{ lo: 5735, hi: 5815 }]);
    assert.equal(ref.centerChannel, 155);
    for (const extra of [{}, { centerFreq0: 0 }, { centerFreq0: 5745 }, { centerFreq0: 5210 }, { centerFreq0: -1 }, { centerFreq0: NaN }]) {
      const o = occupancy({ frequency: 5745, channelWidth: CW.W80, ...extra });
      assert.deepEqual(o, ref);
    }
  });

  test('160 MHz: todas as convenções de centerFreq0/centerFreq1 dão o mesmo canal', () => {
    const conventions = [
      { centerFreq0: 5250, centerFreq1: 0 }, // documentação do Android: centro dos 160 MHz
      { centerFreq0: 5210, centerFreq1: 5250 }, // 80 MHz primário + centro dos 160 MHz
      { centerFreq0: 5210, centerFreq1: 5290 }, // as duas metades de 80 MHz
      { centerFreq0: 5210, centerFreq1: 0 }, // só o 80 MHz primário
      { centerFreq0: 0, centerFreq1: 0 },
      { centerFreq0: 5180, centerFreq1: 0 }, // igual à frequência
      {},
    ];
    for (const c of conventions) {
      const o = occupancy({ frequency: 5180, channelWidth: CW.W160, ...c });
      const id = JSON.stringify(c);
      assert.equal(o.widthMHz, 160, id);
      assert.equal(o.centerFreq, 5250, id);
      assert.equal(o.centerChannel, 50, id);
      assert.deepEqual(o.segments, [{ lo: 5170, hi: 5330 }], id);
      assert.deepEqual(o.channels, steps(36, 64, 4), id);
      assert.equal(o.noncontiguous, false, id);
      assert.equal(o.approx, false, id);
      assert.equal(o.label, '36 · 160 MHz (36–64)', id);
      // o primário é U-NII-1 (sem DFS), mas o canal de 160 MHz pega 52–64
      assert.equal(o.dfs, true, id);
      assert.equal(o.unii, 'U-NII-1', id);
    }
  });

  // Regressão: o VHT Operation obsoleto (largura 2, centro dos 160 MHz no 1º campo, 2º campo
  // zerado) chega do Android como CHANNEL_WIDTH_80MHZ com centerFreq0 no centro do bloco de 160
  // (InformationElementUtil.VhtOperation: 2º centro 0 => 80 MHz). O AP aparecia com 80 MHz.
  test('"80 MHz" com centerFreq0 no centro de um bloco de 160 MHz é um AP de 160 MHz', () => {
    for (const [frequency, center, first, last] of [
      [5180, 5250, 36, 64],
      [5300, 5250, 36, 64],
      [5500, 5570, 100, 128],
      [5745, 5815, 149, 177],
    ]) {
      const o = occupancy({ frequency, channelWidth: CW.W80, centerFreq0: center, centerFreq1: 0 });
      assert.equal(o.widthMHz, 160, String(frequency));
      assert.equal(o.centerFreq, center);
      assert.deepEqual(o.segments, [{ lo: center - 80, hi: center + 80 }]);
      assert.deepEqual(o.channels, steps(first, last, 4));
      assert.equal(o.noncontiguous, false);
      assert.equal(o.approx, false);
      // é o mesmo canal que o Android entrega na forma atual
      assert.deepEqual(o, occupancy({ frequency, channelWidth: CW.W160, centerFreq0: center, centerFreq1: 0 }));
    }
    // centro de 160 MHz de OUTRO bloco não muda nada: continua valendo a tabela de 80 MHz
    const other = occupancy({ frequency: 5180, channelWidth: CW.W80, centerFreq0: 5570 });
    assert.equal(other.widthMHz, 80);
    assert.deepEqual(other.segments, [{ lo: 5170, hi: 5250 }]);
    // onde não existe bloco de 160 (canais 132-144) também não
    assert.equal(occupancy({ frequency: 5660, channelWidth: CW.W80, centerFreq0: 5570 }).widthMHz, 80);
    // nos 6 GHz a forma obsoleta não existe (a largura vem do HE Operation)
    const six = occupancy({ frequency: 6135, channelWidth: CW.W80, centerFreq0: 6185 });
    assert.equal(six.widthMHz, 80);
    assert.deepEqual(six.segments, [{ lo: 6105, hi: 6185 }]);
  });

  test('160 MHz declarado como 80+80 mas contíguo continua sendo um canal só', () => {
    for (const c of [
      { centerFreq0: 5210, centerFreq1: 5250 },
      { centerFreq0: 5210, centerFreq1: 5290 },
      { centerFreq0: 5250, centerFreq1: 0 },
    ]) {
      const o = occupancy({ frequency: 5180, channelWidth: CW.W80P80, ...c });
      assert.deepEqual(o.segments, [{ lo: 5170, hi: 5330 }]);
      assert.equal(o.noncontiguous, false);
      assert.equal(o.widthMHz, 160);
    }
  });

  test('80+80: dois segmentos de 80 MHz, o primeiro contém o primário', () => {
    const o = occupancy({ frequency: 5180, channelWidth: CW.W80P80, centerFreq0: 5210, centerFreq1: 5775 });
    assert.equal(o.widthMHz, 160);
    assert.equal(o.noncontiguous, true);
    assert.deepEqual(o.segments, [
      { lo: 5170, hi: 5250 },
      { lo: 5735, hi: 5815 },
    ]);
    assert.equal(o.centerFreq, 5210);
    assert.equal(o.centerChannel, 42);
    assert.deepEqual(o.channels, [36, 40, 44, 48, 149, 153, 157, 161]);
    assert.equal(o.dfs, false);
    assert.equal(o.approx, false);
    assert.equal(o.label, '36 · 80+80 MHz (36–48 + 149–161)');
  });

  test('80+80 com os centros trocados ou rotulado como 160 MHz', () => {
    const ref = occupancy({ frequency: 5180, channelWidth: CW.W80P80, centerFreq0: 5210, centerFreq1: 5775 });
    const swapped = occupancy({ frequency: 5180, channelWidth: CW.W80P80, centerFreq0: 5775, centerFreq1: 5210 });
    assert.deepEqual(swapped, ref);
    const as160 = occupancy({ frequency: 5180, channelWidth: CW.W160, centerFreq0: 5210, centerFreq1: 5775 });
    assert.deepEqual(as160, ref);
  });

  test('80+80 com segundo segmento em DFS', () => {
    const o = occupancy({ frequency: 5745, channelWidth: CW.W80P80, centerFreq0: 5775, centerFreq1: 5530 });
    assert.deepEqual(o.segments, [
      { lo: 5735, hi: 5815 },
      { lo: 5490, hi: 5570 },
    ]);
    assert.equal(o.dfs, true);
    assert.equal(o.label, '149 · 80+80 MHz (149–161 + 100–112)');
  });

  test('80+80 sem o segundo centro: só o segmento primário, marcado como aproximado', () => {
    for (const c of [{ centerFreq0: 5210, centerFreq1: 0 }, { centerFreq0: 0, centerFreq1: 0 }, {}]) {
      const o = occupancy({ frequency: 5180, channelWidth: CW.W80P80, ...c });
      assert.equal(o.widthMHz, 80);
      assert.deepEqual(o.segments, [{ lo: 5170, hi: 5250 }]);
      assert.equal(o.noncontiguous, false);
      assert.equal(o.approx, true);
    }
  });

  test('160 MHz onde não existe bloco de 160 cai para 80 MHz', () => {
    const o = occupancy({ frequency: 5660, channelWidth: CW.W160, centerFreq0: 0 });
    assert.equal(o.channel, 132);
    assert.equal(o.widthMHz, 80);
    assert.deepEqual(o.segments, [{ lo: 5650, hi: 5730 }]);
    assert.equal(o.approx, true);
    assert.equal(o.dfs, true);
  });

  test('320 MHz não existe em 5 GHz: cai para a maior largura da tabela', () => {
    const o = occupancy({ frequency: 5180, channelWidth: CW.W320 });
    assert.equal(o.widthMHz, 160);
    assert.deepEqual(o.segments, [{ lo: 5170, hi: 5330 }]);
    assert.equal(o.approx, true);
  });

  test('canal fora da tabela: usa o centro informado se fizer sentido, senão 20 MHz', () => {
    // canal 34 (5170 MHz), numeração antiga do Japão
    const withCenter = occupancy({ frequency: 5170, channelWidth: CW.W40, centerFreq0: 5180 });
    assert.equal(withCenter.channel, 34);
    assert.equal(withCenter.widthMHz, 40);
    assert.deepEqual(withCenter.segments, [{ lo: 5160, hi: 5200 }]);
    assert.equal(withCenter.approx, true);
    assert.equal(withCenter.label, '34 · 40 MHz (34–38)');

    const noCenter = occupancy({ frequency: 5170, channelWidth: CW.W40, centerFreq0: 0 });
    assert.equal(noCenter.widthMHz, 20);
    assert.deepEqual(noCenter.segments, [{ lo: 5160, hi: 5180 }]);
    assert.equal(noCenter.approx, true);

    // centro que deixaria o primário desalinhado da grade de 20 MHz não serve
    const misaligned = occupancy({ frequency: 5170, channelWidth: CW.W40, centerFreq0: 5170 });
    assert.equal(misaligned.widthMHz, 20);
  });

  test('DFS e U-NII do canal primário', () => {
    assert.equal(occupancy({ frequency: 5260, channelWidth: CW.W20 }).dfs, true);
    assert.equal(occupancy({ frequency: 5260, channelWidth: CW.W20 }).unii, 'U-NII-2A');
    assert.equal(occupancy({ frequency: 5500, channelWidth: CW.W80 }).dfs, true);
    assert.equal(occupancy({ frequency: 5500, channelWidth: CW.W80 }).unii, 'U-NII-2C');
    assert.equal(occupancy({ frequency: 5720, channelWidth: CW.W20 }).dfs, true);
    assert.equal(occupancy({ frequency: 5745, channelWidth: CW.W160 }).dfs, false);
    assert.equal(occupancy({ frequency: 5745, channelWidth: CW.W160 }).unii, 'U-NII-3');
    assert.equal(occupancy({ frequency: 5845, channelWidth: CW.W20 }).unii, 'U-NII-4');
  });
});

describe('occupancy: 6 GHz', () => {
  test('canal 2 (5935 MHz)', () => {
    const o = occupancy({ frequency: 5935, channelWidth: CW.W20 });
    assert.equal(o.band, '6');
    assert.equal(o.channel, 2);
    assert.equal(o.widthMHz, 20);
    assert.deepEqual(o.segments, [{ lo: 5925, hi: 5945 }]);
    assert.deepEqual(o.channels, [2]);
    assert.equal(o.psc, false);
    assert.equal(o.dfs, false);
    assert.equal(o.unii, 'U-NII-5');
    assert.equal(o.label, '2 · 20 MHz');
  });

  test('todas as larguras com o primário 37 (PSC)', () => {
    const base = { frequency: 6135 };
    const w20 = occupancy({ ...base, channelWidth: CW.W20 });
    assert.equal(w20.channel, 37);
    assert.equal(w20.psc, true);
    assert.deepEqual(w20.segments, [{ lo: 6125, hi: 6145 }]);

    const w40 = occupancy({ ...base, channelWidth: CW.W40, centerFreq0: 6125 });
    assert.equal(w40.centerChannel, 35);
    assert.deepEqual(w40.segments, [{ lo: 6105, hi: 6145 }]);
    assert.equal(w40.label, '37 · 40 MHz (33–37)');

    const w80 = occupancy({ ...base, channelWidth: CW.W80, centerFreq0: 6145 });
    assert.equal(w80.centerChannel, 39);
    assert.deepEqual(w80.segments, [{ lo: 6105, hi: 6185 }]);
    assert.deepEqual(w80.channels, [33, 37, 41, 45]);

    const w160 = occupancy({ ...base, channelWidth: CW.W160, centerFreq0: 6185 });
    assert.equal(w160.centerChannel, 47);
    assert.deepEqual(w160.segments, [{ lo: 6105, hi: 6265 }]);
    assert.equal(w160.label, '37 · 160 MHz (33–61)');
    assert.equal(w160.dfs, false);
    assert.equal(w160.psc, true);
    assert.equal(w160.unii, 'U-NII-5');
  });

  test('160 MHz com centerFreq0 = 80 MHz primário e centerFreq1 = centro dos 160 MHz', () => {
    const a = occupancy({ frequency: 6135, channelWidth: CW.W160, centerFreq0: 6145, centerFreq1: 6185 });
    const b = occupancy({ frequency: 6135, channelWidth: CW.W160, centerFreq0: 6185, centerFreq1: 0 });
    const c = occupancy({ frequency: 6135, channelWidth: CW.W160 });
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
  });

  test('320 MHz: o centro informado escolhe entre os dois blocos possíveis', () => {
    const low = occupancy({ frequency: 6135, channelWidth: CW.W320, centerFreq0: 6105 });
    assert.equal(low.widthMHz, 320);
    assert.equal(low.centerChannel, 31);
    assert.deepEqual(low.segments, [{ lo: 5945, hi: 6265 }]);
    assert.equal(low.approx, false);
    assert.equal(low.label, '37 · 320 MHz (1–61)');

    const high = occupancy({ frequency: 6135, channelWidth: CW.W320, centerFreq0: 6265 });
    assert.equal(high.centerChannel, 63);
    assert.deepEqual(high.segments, [{ lo: 6105, hi: 6425 }]);
    assert.equal(high.channels.length, 16);
    assert.equal(high.approx, false);

    // 160 MHz primário em centerFreq0 e o centro dos 320 MHz em centerFreq1
    const split = occupancy({ frequency: 6135, channelWidth: CW.W320, centerFreq0: 6185, centerFreq1: 6265 });
    assert.deepEqual(split, high);
  });

  test('320 MHz sem centro: bloco de centro mais baixo, aproximado só se houver dúvida', () => {
    const ambiguous = occupancy({ frequency: 6135, channelWidth: CW.W320 });
    assert.equal(ambiguous.centerChannel, 31);
    assert.equal(ambiguous.approx, true);

    const single = occupancy({ frequency: 5975, channelWidth: CW.W320 }); // canal 5: só cabe no 31
    assert.equal(single.centerChannel, 31);
    assert.equal(single.approx, false);
  });

  test('larguras que não cabem no fim da faixa caem para a maior possível', () => {
    const ch225 = occupancy({ frequency: 7075, channelWidth: CW.W320 });
    assert.equal(ch225.channel, 225);
    assert.equal(ch225.widthMHz, 40);
    assert.equal(ch225.centerChannel, 227);
    assert.equal(ch225.approx, true);

    const ch233 = occupancy({ frequency: 7115, channelWidth: CW.W80 });
    assert.equal(ch233.widthMHz, 20);
    assert.deepEqual(ch233.segments, [{ lo: 7105, hi: 7125 }]);
    assert.equal(ch233.approx, true);
  });

  test('PSC só nos canais 5, 21, 37, ...', () => {
    assert.equal(occupancy({ frequency: 5975, channelWidth: CW.W20 }).psc, true); // 5
    assert.equal(occupancy({ frequency: 5955, channelWidth: CW.W20 }).psc, false); // 1
    assert.equal(occupancy({ frequency: 6115, channelWidth: CW.W20 }).psc, false); // 33
    assert.equal(occupancy({ frequency: 7095, channelWidth: CW.W20 }).psc, true); // 229
    assert.equal(occupancy({ frequency: 5180, channelWidth: CW.W20 }).psc, false); // 5 GHz
  });
});

describe('occupancy: 2,4 GHz', () => {
  test('20 MHz', () => {
    const o = occupancy({ frequency: 2437, channelWidth: CW.W20, centerFreq0: 0, centerFreq1: 0 });
    assert.equal(o.band, '2.4');
    assert.equal(o.channel, 6);
    assert.equal(o.widthMHz, 20);
    assert.deepEqual(o.segments, [{ lo: 2427, hi: 2447 }]);
    assert.deepEqual(o.channels, [6]);
    assert.equal(o.centerFreq, 2437);
    assert.equal(o.secondary, null);
    assert.equal(o.dfs, false);
    assert.equal(o.unii, null);
    assert.equal(o.approx, false);
    assert.equal(o.label, '6 · 20 MHz');
  });

  test('40 MHz com o secundário acima', () => {
    const o = occupancy({ frequency: 2437, channelWidth: CW.W40, centerFreq0: 2447 });
    assert.equal(o.widthMHz, 40);
    assert.equal(o.secondary, 'above');
    assert.equal(o.centerFreq, 2447);
    assert.equal(o.centerChannel, 8);
    assert.deepEqual(o.segments, [{ lo: 2427, hi: 2467 }]);
    assert.deepEqual(o.channels, [6, 10]);
    assert.equal(o.approx, false);
    assert.equal(o.label, '6 · 40 MHz (6+10)');
  });

  test('40 MHz com o secundário abaixo', () => {
    const o = occupancy({ frequency: 2437, channelWidth: CW.W40, centerFreq0: 2427 });
    assert.equal(o.secondary, 'below');
    assert.equal(o.centerChannel, 4);
    assert.deepEqual(o.segments, [{ lo: 2407, hi: 2447 }]);
    assert.deepEqual(o.channels, [6, 2]);
    assert.equal(o.label, '6 · 40 MHz (6+2)');
  });

  test('40 MHz sem centerFreq0: secundário null e a faixa conservadora (os dois lados)', () => {
    for (const extra of [{}, { centerFreq0: 0 }, { centerFreq0: 2437 }, { centerFreq0: 2452 }, { centerFreq0: 5190 }]) {
      const o = occupancy({ frequency: 2437, channelWidth: CW.W40, ...extra });
      const id = JSON.stringify(extra);
      assert.equal(o.widthMHz, 40, id);
      assert.equal(o.secondary, null, id);
      assert.deepEqual(o.segments, [{ lo: 2407, hi: 2467 }], id);
      assert.equal(o.centerFreq, 2437, id);
      assert.deepEqual(o.channels, [6], id);
      assert.equal(o.approx, true, id);
      assert.equal(o.label, '6 · 40 MHz', id);
    }
  });

  test('40 MHz sem centerFreq0 nas pontas: só um lado é possível', () => {
    const ch1 = occupancy({ frequency: 2412, channelWidth: CW.W40 });
    assert.deepEqual(ch1.segments, [{ lo: 2402, hi: 2442 }]);
    assert.equal(ch1.centerChannel, 3);
    assert.equal(ch1.secondary, null);
    assert.equal(ch1.approx, false);

    const ch13 = occupancy({ frequency: 2472, channelWidth: CW.W40, centerFreq0: 0 });
    assert.deepEqual(ch13.segments, [{ lo: 2442, hi: 2482 }]);
    assert.equal(ch13.centerChannel, 11);
    assert.equal(ch13.secondary, null);
  });

  test('centro impossível (secundário fora da faixa) é ignorado', () => {
    const o = occupancy({ frequency: 2412, channelWidth: CW.W40, centerFreq0: 2402 });
    assert.equal(o.secondary, null);
    assert.deepEqual(o.segments, [{ lo: 2402, hi: 2442 }]);
  });

  test('o centro pode vir em centerFreq1', () => {
    const o = occupancy({ frequency: 2412, channelWidth: CW.W40, centerFreq0: 0, centerFreq1: 2422 });
    assert.equal(o.secondary, 'above');
    assert.deepEqual(o.channels, [1, 5]);
  });

  test('largura que não existe em 2,4 GHz é tratada como 40 MHz', () => {
    const o = occupancy({ frequency: 2437, channelWidth: CW.W80, centerFreq0: 2447 });
    assert.equal(o.widthMHz, 40);
    assert.equal(o.secondary, 'above');
    assert.equal(o.approx, true);
  });

  test('canal 14 é sempre 20 MHz', () => {
    const o = occupancy({ frequency: 2484, channelWidth: CW.W40, centerFreq0: 2474 });
    assert.equal(o.channel, 14);
    assert.equal(o.widthMHz, 20);
    assert.deepEqual(o.segments, [{ lo: 2474, hi: 2494 }]);
  });

  test('frequência fora da grade de canais', () => {
    const o = occupancy({ frequency: 2440, channelWidth: CW.W40, centerFreq0: 2450 });
    assert.equal(o.band, '2.4');
    assert.equal(o.channel, null);
    assert.equal(o.widthMHz, 20);
    assert.deepEqual(o.segments, [{ lo: 2430, hi: 2450 }]);
    assert.equal(o.label, '2440 MHz · 20 MHz');
  });
});

describe('occupancy: 60 GHz, largura desconhecida e entradas ruins', () => {
  test('60 GHz: canal de 2,16 GHz', () => {
    const o = occupancy({ frequency: 60480, channelWidth: CW.W20 });
    assert.equal(o.band, '60');
    assert.equal(o.channel, 2);
    assert.equal(o.widthMHz, 2160);
    assert.deepEqual(o.segments, [{ lo: 59400, hi: 61560 }]);
    assert.equal(o.label, '2 · 2,16 GHz');
    assert.equal(o.dfs, false);
  });

  test('largura desconhecida vira 20 MHz e marca approx', () => {
    for (const cw of [-1, undefined, null, NaN, 6, 99, 'x', 1.5]) {
      const o = occupancy({ frequency: 5180, channelWidth: cw, centerFreq0: 5210 });
      assert.equal(o.widthMHz, 20, String(cw));
      assert.deepEqual(o.segments, [{ lo: 5170, hi: 5190 }], String(cw));
      assert.equal(o.approx, true, String(cw));
    }
    assert.equal(occupancy({ frequency: 2437, channelWidth: -1 }).widthMHz, 20);
    assert.equal(occupancy({ frequency: 6135, channelWidth: -1 }).widthMHz, 20);
  });

  test('frequência 0, NaN ou ausente: nada ocupado, sem exceção', () => {
    for (const ap of [{}, { frequency: 0 }, { frequency: NaN }, { frequency: 'abc' }, { frequency: null, channelWidth: 2 }, { frequency: -5180 }]) {
      const o = occupancy(ap);
      const id = JSON.stringify(ap);
      assert.equal(o.band, null, id);
      assert.equal(o.channel, null, id);
      assert.equal(o.widthMHz, 20, id);
      assert.equal(o.centerFreq, null, id);
      assert.equal(o.centerChannel, null, id);
      assert.deepEqual(o.segments, [], id);
      assert.deepEqual(o.channels, [], id);
      assert.equal(o.dfs, false, id);
      assert.equal(o.psc, false, id);
      assert.equal(o.unii, null, id);
      assert.equal(o.approx, true, id);
      assert.equal(o.label, '—', id);
    }
  });

  test('frequência fora de qualquer faixa Wi-Fi', () => {
    const o = occupancy({ frequency: 4940, channelWidth: CW.W20 });
    assert.equal(o.band, null);
    assert.equal(o.channel, null);
    assert.deepEqual(o.segments, [{ lo: 4930, hi: 4950 }]);
    assert.equal(o.label, '4940 MHz');
  });

  test('qualquer coisa que não seja objeto', () => {
    for (const bad of [null, undefined, 42, 'x', true, [], () => {}]) {
      const o = occupancy(bad);
      assert.equal(o.band, null);
      assert.deepEqual(o.segments, []);
      assert.deepEqual(Object.keys(o).sort(), OCC_KEYS);
    }
  });

  test('números em texto são aceitos', () => {
    const o = occupancy({ frequency: '5180', channelWidth: '2', centerFreq0: '5210' });
    assert.equal(o.label, '36 · 80 MHz (36–48)');
  });

  test('varredura: toda frequência × largura × centros, sem exceção e com o resultado coerente', () => {
    const freqs = [
      ...channelList('2.4', { all: true }),
      ...channelList('5'),
      ...channelList('6'),
      ...channelList('60'),
    ].map((c) => c.freq);
    freqs.push(5935, 5170, 2440, 5000, 0, 100000);
    const widths = [-1, 0, 1, 2, 3, 4, 5, 7];
    const offsets = [null, 0, -10, 10, 30, -30, 70, 150, 565];
    for (const frequency of freqs) {
      for (const channelWidth of widths) {
        for (const off of offsets) {
          const centerFreq0 = off === null ? 0 : frequency + off;
          for (const centerFreq1 of [0, frequency + 40, frequency - 595]) {
            const o = occupancy({ frequency, channelWidth, centerFreq0, centerFreq1 });
            const id = `f=${frequency} cw=${channelWidth} c0=${centerFreq0} c1=${centerFreq1}`;
            assert.deepEqual(Object.keys(o).sort(), OCC_KEYS, id);
            assert.equal(typeof o.label, 'string', id);
            assert.ok(o.label.length > 0, id);
            if (o.band === null) continue;
            assert.ok(o.segments.length === 1 || o.segments.length === 2, id);
            // o primeiro segmento sempre contém o canal primário inteiro
            assert.ok(o.segments[0].lo <= frequency - 10 && o.segments[0].hi >= frequency + 10, id);
            for (const s of o.segments) assert.ok(s.hi > s.lo, id);
            assert.ok([20, 40, 80, 160, 320, 2160].includes(o.widthMHz), `${id}: largura ${o.widthMHz}`);
            const spanned = o.segments.reduce((sum, s) => sum + (s.hi - s.lo), 0);
            // única exceção: a faixa conservadora de 60 MHz dos 40 MHz em 2,4 GHz sem centro
            if (o.band === '2.4' && o.widthMHz === 40 && o.secondary === null) assert.ok(spanned === 40 || spanned === 60, id);
            else assert.equal(spanned, o.widthMHz, id);
            assert.equal(o.noncontiguous, o.segments.length === 2, id);
            if (o.band !== '2.4') assert.equal(o.secondary, null, id);
            if (o.band !== '5') assert.equal(o.dfs, false, id);
            assert.ok(o.centerFreq >= o.segments[0].lo && o.centerFreq <= o.segments[0].hi, id);
          }
        }
      }
    }
  });
});

describe('overlapMHz', () => {
  const occ = (frequency, channelWidth = 0, centerFreq0 = 0, centerFreq1 = 0) =>
    occupancy({ frequency, channelWidth, centerFreq0, centerFreq1 });

  test('2,4 GHz: canais vizinhos se sobrepõem, 1 e 6 não', () => {
    assert.equal(overlapMHz(occ(2412), occ(2412)), 20);
    assert.equal(overlapMHz(occ(2412), occ(2417)), 15);
    assert.equal(overlapMHz(occ(2412), occ(2422)), 10);
    assert.equal(overlapMHz(occ(2412), occ(2432)), 0);
    assert.equal(overlapMHz(occ(2412), occ(2437)), 0);
    // 40 MHz em 6+10 pega o canal 11 inteiro
    assert.equal(overlapMHz(occ(2437, 1, 2447), occ(2462)), 15);
  });

  test('5 GHz: canal largo contra canal estreito', () => {
    const w80 = occ(5180, 2, 5210);
    assert.equal(overlapMHz(w80, occ(5200)), 20);
    assert.equal(overlapMHz(w80, occ(5260)), 0);
    assert.equal(overlapMHz(w80, occ(5180, 3, 5250)), 80);
    assert.equal(overlapMHz(w80, occ(5745)), 0);
  });

  test('80+80 soma os dois segmentos', () => {
    const plus = occ(5180, 4, 5210, 5775);
    assert.equal(overlapMHz(plus, plus), 160);
    assert.equal(overlapMHz(plus, occ(5745, 2, 5775)), 80);
    assert.equal(overlapMHz(plus, occ(5180, 3, 5250)), 80);
    assert.equal(overlapMHz(plus, occ(5500, 2, 5530)), 0);
  });

  test('simétrico, aceita blocos e segmentos soltos', () => {
    const a = occ(5180, 2, 5210);
    const b = occ(5220, 1, 5230);
    assert.equal(overlapMHz(a, b), overlapMHz(b, a));
    assert.equal(overlapMHz(a, b), 40);
    assert.equal(overlapMHz(blockContaining('5', 80, 36), blockContaining('5', 40, 44)), 40);
    assert.equal(overlapMHz({ lo: 0, hi: 10 }, { lo: 5, hi: 30 }), 5);
  });

  test('faixas diferentes e entradas ruins dão 0', () => {
    assert.equal(overlapMHz(occ(2437), occ(5180)), 0);
    assert.equal(overlapMHz(null, occ(5180)), 0);
    assert.equal(overlapMHz(occ(5180), undefined), 0);
    assert.equal(overlapMHz({}, {}), 0);
    assert.equal(overlapMHz({ segments: [null, { lo: 'a', hi: 3 }, { lo: 9, hi: 1 }] }, occ(5180)), 0);
    assert.equal(overlapMHz(occupancy({}), occupancy({})), 0);
    assert.equal(overlapMHz(1, 2), 0);
  });
});

describe('maskDb', () => {
  test('20 MHz: 0 dBr até ±9, −20 em ±11, −28 em ±20, −40 em ±30', () => {
    assert.equal(maskDb(0, 20), 0);
    assert.equal(maskDb(5, 20), 0);
    assert.equal(maskDb(9, 20), 0);
    near(maskDb(10, 20), -10, 1e-9);
    near(maskDb(11, 20), -20, 1e-9);
    near(maskDb(15.5, 20), -24, 1e-9); // meio do trecho de −20 a −28
    near(maskDb(20, 20), -28, 1e-9);
    near(maskDb(25, 20), -34, 1e-9);
    near(maskDb(30, 20), -40, 1e-9);
  });

  test('os mesmos pontos valem para 40, 80, 160 e 320 MHz', () => {
    for (const w of [40, 80, 160, 320]) {
      assert.equal(maskDb(w / 2 - 1, w), 0, `${w}`);
      near(maskDb(w / 2 + 1, w), -20, 1e-9, `${w}`);
      near(maskDb(w, w), -28, 1e-9, `${w}`);
      near(maskDb(1.5 * w, w), -40, 1e-9, `${w}`);
    }
    near(maskDb(21, 40), -20, 1e-9);
    near(maskDb(41, 80), -20, 1e-9);
    near(maskDb(81, 160), -20, 1e-9);
    near(maskDb(240, 160), -40, 1e-9);
  });

  test('simétrica e nunca sobe com a distância', () => {
    for (const w of [20, 40, 80, 160]) {
      let prev = 0;
      for (let off = 0; off <= 4 * w; off += 0.5) {
        const v = maskDb(off, w);
        assert.equal(maskDb(-off, w), v);
        assert.ok(v <= prev + 1e-12, `largura ${w}, deslocamento ${off}`);
        assert.ok(v <= 0);
        prev = v;
      }
    }
  });

  test('depois de 1,5 largura continua caindo no mesmo ritmo', () => {
    near(maskDb(40, 20), -52, 1e-9);
    assert.ok(maskDb(3000, 20) < -1000);
  });

  test('largura padrão de 20 MHz e entrada inválida', () => {
    assert.equal(maskDb(11), maskDb(11, 20));
    for (const bad of [NaN, null, undefined, 'x', Infinity]) assert.equal(maskDb(bad, 20), null);
    for (const bad of [NaN, null, 'x', 0, -20, 2]) assert.equal(maskDb(0, bad), null);
  });
});

describe('interferenceFactor', () => {
  const ch = (center, width = 20) => ({ lo: center - width / 2, hi: center + width / 2 });

  /** Integração numérica independente (regra do ponto médio) da máscara. */
  function bruteForce(center, width, rxLo, rxHi) {
    const power = (a, b) => {
      const step = 0.005;
      let sum = 0;
      for (let x = a + step / 2; x < b; x += step) sum += Math.pow(10, maskDb(x - center, width) / 10) * step;
      return sum;
    };
    return power(rxLo, rxHi) / power(center - 12 * width, center + 12 * width);
  }

  test('≈ 1 (dentro de 2%) quando o receptor cobre o canal inteiro do transmissor', () => {
    for (const w of [20, 40, 80, 160, 320]) {
      const tx = ch(6000, w);
      const f = interferenceFactor(tx, tx.lo, tx.hi);
      assert.ok(f > 0.98 && f <= 1, `largura ${w}: ${f}`);
    }
    // receptor bem mais largo que o transmissor: tudo cai dentro
    near(interferenceFactor(ch(5500, 20), 5300, 5700), 1, 1e-6);
    assert.ok(interferenceFactor(ch(5500, 20), 5300, 5700) <= 1);
  });

  test('cai sempre que a separação aumenta', () => {
    const tx = ch(2412);
    let prev = Infinity;
    for (let sep = 0; sep <= 100; sep += 1) {
      const f = interferenceFactor(tx, 2402 + sep, 2422 + sep);
      assert.ok(f < prev, `separação ${sep}: ${f} não é menor que ${prev}`);
      assert.ok(f >= 0);
      prev = f;
    }
  });

  test('dois canais de 20 MHz separados por 25 MHz (1 e 6): menos de 1%', () => {
    const f = interferenceFactor(ch(2412), 2427, 2447);
    assert.ok(f < 0.01, String(f));
    assert.ok(f > 0.0001, String(f));
    // vizinho colado (20 MHz ao lado) também fica abaixo de 1%
    const adjacent = interferenceFactor(ch(5180), 5190, 5210);
    assert.ok(adjacent < 0.01 && adjacent > 0.001, String(adjacent));
  });

  test('canais sobrepostos de 2,4 GHz: proporcional ao pedaço em comum', () => {
    near(interferenceFactor(ch(2412), 2407, 2427), 0.76, 0.02); // 1 contra 2
    near(interferenceFactor(ch(2412), 2412, 2432), 0.5, 0.02); // 1 contra 3
    near(interferenceFactor(ch(2412), 2417, 2437), 0.24, 0.02); // 1 contra 4
  });

  test('simétrico no deslocamento', () => {
    for (const w of [20, 40, 80]) {
      const tx = ch(5500, w);
      for (const sep of [0, 3, 10, 20, 25, 47, 80, 130]) {
        const up = interferenceFactor(tx, 5500 + sep - 10, 5500 + sep + 10);
        const down = interferenceFactor(tx, 5500 - sep - 10, 5500 - sep + 10);
        near(up, down, 1e-12 + up * 1e-9, `largura ${w}, separação ${sep}`);
      }
    }
  });

  test('confere com a integração numérica da máscara', () => {
    const cases = [
      [5500, 20, 5490, 5510],
      [5500, 20, 5495, 5515],
      [5500, 20, 5510, 5530],
      [5500, 20, 5515, 5535],
      [5500, 20, 5540, 5560],
      [5500, 40, 5480, 5500],
      [5500, 40, 5520, 5540],
      [5500, 80, 5540, 5620],
      [5500, 160, 5420, 5440],
      [5500, 160, 5580, 5600],
    ];
    for (const [center, width, lo, hi] of cases) {
      const exact = interferenceFactor(ch(center, width), lo, hi);
      const numeric = bruteForce(center, width, lo, hi);
      near(exact, numeric, 1e-6 + numeric * 1e-3, `centro ${center}, ${width} MHz, rx ${lo}–${hi}`);
    }
  });

  test('a potência se conserva: a soma sobre faixas vizinhas dá 1', () => {
    for (const w of [20, 80]) {
      const tx = ch(5500, w);
      let sum = 0;
      for (let lo = 5500 - 10 * w; lo < 5500 + 10 * w; lo += 20) sum += interferenceFactor(tx, lo, lo + 20);
      near(sum, 1, 1e-9, `largura ${w}`);
    }
  });

  test('canal largo espalha a potência: metade em cada metade', () => {
    near(interferenceFactor(ch(5190, 40), 5170, 5190), 0.5, 0.01);
    near(interferenceFactor(ch(5210, 80), 5170, 5190), 0.25, 0.01);
    near(interferenceFactor(ch(5250, 160), 5170, 5250), 0.5, 0.01);
  });

  test('80+80: metade da potência em cada segmento', () => {
    const tx = occupancy({ frequency: 5180, channelWidth: 4, centerFreq0: 5210, centerFreq1: 5775 });
    near(interferenceFactor(tx, 5170, 5250), 0.5, 0.01);
    near(interferenceFactor(tx, 5735, 5815), 0.5, 0.01);
    near(interferenceFactor(tx, 5735, 5755), 0.125, 0.005);
    assert.ok(interferenceFactor(tx, 5490, 5570) < 1e-6);
  });

  test('aceita ocupações dos dois lados', () => {
    const tx = occupancy({ frequency: 5180, channelWidth: 2, centerFreq0: 5210 });
    const rx = occupancy({ frequency: 5200, channelWidth: 0 });
    near(interferenceFactor(tx, rx), interferenceFactor(tx, 5190, 5210), 1e-15);
    near(interferenceFactor(tx, rx), 0.25, 0.01);
    const same = interferenceFactor(tx, tx);
    assert.ok(same > 0.98 && same <= 1);
    // receptor em 80+80 soma os dois segmentos
    const rxPlus = occupancy({ frequency: 5180, channelWidth: 4, centerFreq0: 5210, centerFreq1: 5775 });
    near(interferenceFactor(occupancy({ frequency: 5745, channelWidth: 0 }), rxPlus), interferenceFactor({ lo: 5735, hi: 5755 }, 5735, 5815), 1e-9);
  });

  test('rxLo e rxHi trocados dão o mesmo resultado', () => {
    assert.equal(interferenceFactor(ch(2437), 2447, 2427), interferenceFactor(ch(2437), 2427, 2447));
  });

  test('outra faixa: zero', () => {
    assert.equal(interferenceFactor(ch(2412), 5170, 5190), 0);
    assert.ok(interferenceFactor(ch(5180), 5490, 5510) < 1e-12);
  });

  test('entrada inválida dá 0, nunca exceção', () => {
    assert.equal(interferenceFactor(null, 2402, 2422), 0);
    assert.equal(interferenceFactor(undefined, 2402, 2422), 0);
    assert.equal(interferenceFactor({}, 2402, 2422), 0);
    assert.equal(interferenceFactor({ segments: [] }, 2402, 2422), 0);
    assert.equal(interferenceFactor(occupancy({}), 2402, 2422), 0);
    assert.equal(interferenceFactor(ch(2412), NaN, 2422), 0);
    assert.equal(interferenceFactor(ch(2412), 2402), 0);
    assert.equal(interferenceFactor(ch(2412), 2412, 2412), 0);
    assert.equal(interferenceFactor(ch(2412), null), 0);
    assert.equal(interferenceFactor(ch(2412), occupancy({})), 0);
    assert.equal(interferenceFactor({ lo: 10, hi: 5 }, 0, 20), 0);
    assert.equal(interferenceFactor({ lo: 10, hi: 11 }, 0, 20), 0); // largura sem sentido para a máscara
    assert.equal(interferenceFactor('x', 'y', 'z'), 0);
  });
});
