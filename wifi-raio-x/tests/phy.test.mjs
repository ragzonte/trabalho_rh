import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  WIFI_STANDARD,
  standardInfo,
  phyOfGen,
  inferGen,
  mcsName,
  dataRate,
  maxRate,
  MIN_SNR_DB,
  estimateLink,
  MAC_EFFICIENCY,
  usableMbps,
} from '../app/js/core/phy.js';
import { noiseFloorDbm } from '../app/js/core/signal.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'valor'}: esperado ${expected} ± ${tol}, veio ${actual}`);

const LINK_KEYS = ['gen', 'maxPhyMbps', 'mcs', 'nss', 'phyMbps', 'snrDb', 'standard', 'unstable', 'widthMHz'];

describe('standardInfo', () => {
  test('os inteiros são os do Android (ScanResult.WIFI_STANDARD_*)', () => {
    assert.deepEqual({ ...WIFI_STANDARD }, { UNKNOWN: 0, LEGACY: 1, N: 4, AC: 5, AX: 6, AD: 7, BE: 8 });
    assert.ok(Object.isFrozen(WIFI_STANDARD));
  });

  test('gerações modernas', () => {
    assert.deepEqual(standardInfo(4), { gen: 4, short: 'Wi-Fi 4', ieee: '802.11n', label: 'Wi-Fi 4 (802.11n)', phy: 'ht' });
    assert.deepEqual(standardInfo(5), { gen: 5, short: 'Wi-Fi 5', ieee: '802.11ac', label: 'Wi-Fi 5 (802.11ac)', phy: 'vht' });
    assert.deepEqual(standardInfo(6), { gen: 6, short: 'Wi-Fi 6', ieee: '802.11ax', label: 'Wi-Fi 6 (802.11ax)', phy: 'he' });
    // 8 é o 802.11be (Wi-Fi 7); o inteiro 7 é o 802.11ad
    assert.deepEqual(standardInfo(8), { gen: 7, short: 'Wi-Fi 7', ieee: '802.11be', label: 'Wi-Fi 7 (802.11be)', phy: 'eht' });
  });

  test('802.11ax nos 6 GHz é Wi-Fi 6E', () => {
    const e = standardInfo(6, '6');
    assert.equal(e.short, 'Wi-Fi 6E');
    assert.equal(e.label, 'Wi-Fi 6E (802.11ax)');
    assert.equal(e.gen, 6);
    assert.equal(e.ieee, '802.11ax');
    assert.equal(standardInfo(6, 6135).short, 'Wi-Fi 6E'); // frequência em MHz
    assert.equal(standardInfo(6, 5935).short, 'Wi-Fi 6E');
    assert.equal(standardInfo(6, '5').short, 'Wi-Fi 6');
    assert.equal(standardInfo(6, 5180).short, 'Wi-Fi 6');
    assert.equal(standardInfo(6, '2.4').short, 'Wi-Fi 6');
    assert.equal(standardInfo(6, null).short, 'Wi-Fi 6');
    // só o 11ax muda de nome nos 6 GHz
    assert.equal(standardInfo(8, '6').short, 'Wi-Fi 7');
  });

  test('802.11ad (60 GHz) não é uma geração numerada', () => {
    assert.deepEqual(standardInfo(7), { gen: null, short: 'WiGig', ieee: '802.11ad', label: 'WiGig (802.11ad)', phy: 'dmg' });
  });

  test('redes antigas (a/b/g)', () => {
    assert.deepEqual(standardInfo(1), {
      gen: 3,
      short: 'Wi-Fi antigo',
      ieee: '802.11a/b/g',
      label: 'Wi-Fi antigo (802.11a/b/g)',
      phy: 'legacy',
    });
    assert.equal(standardInfo(1, '2.4').ieee, '802.11b/g');
    assert.equal(standardInfo(1, 2437).gen, 3);
    assert.equal(standardInfo(1, '5').ieee, '802.11a');
    assert.equal(standardInfo(1, 5180).gen, 2);
    assert.ok(standardInfo(1, '5').gen < 4);
  });

  test('desconhecido ou inválido', () => {
    for (const bad of [0, 2, 3, 9, -1, 99, NaN, null, undefined, 'x', '', {}, 6.5]) {
      const info = standardInfo(bad);
      assert.equal(info.gen, null, String(bad));
      assert.equal(info.ieee, null, String(bad));
      assert.equal(info.phy, null, String(bad));
      assert.equal(info.short, 'Wi-Fi', String(bad));
      assert.match(info.label, /não informado/, String(bad));
    }
  });

  test('aceita o inteiro em texto', () => {
    assert.equal(standardInfo('6').short, 'Wi-Fi 6');
    assert.equal(standardInfo('8').gen, 7);
  });
});

describe('phyOfGen / inferGen / mcsName', () => {
  test('phyOfGen', () => {
    assert.equal(phyOfGen(1), 'legacy');
    assert.equal(phyOfGen(2), 'legacy');
    assert.equal(phyOfGen(3), 'legacy');
    assert.equal(phyOfGen(4), 'ht');
    assert.equal(phyOfGen(5), 'vht');
    assert.equal(phyOfGen(6), 'he');
    assert.equal(phyOfGen(7), 'eht');
    assert.equal(phyOfGen(8), 'eht');
    for (const bad of [0, -1, NaN, null, undefined, 'x', '6']) assert.equal(phyOfGen(bad), null, String(bad));
  });

  test('inferGen: geração mínima compatível com a faixa e a largura', () => {
    assert.equal(inferGen({ band: '2.4', widthMHz: 20 }), 4);
    assert.equal(inferGen({ band: '2.4', widthMHz: 40 }), 4);
    assert.equal(inferGen({ band: '5', widthMHz: 20 }), 4);
    assert.equal(inferGen({ band: '5', widthMHz: 40 }), 4);
    assert.equal(inferGen({ band: '5', widthMHz: 80 }), 5);
    assert.equal(inferGen({ band: '5', widthMHz: 160 }), 5);
    assert.equal(inferGen({ band: '6', widthMHz: 20 }), 6);
    assert.equal(inferGen({ band: '6', widthMHz: 160 }), 6);
    assert.equal(inferGen({ band: '6', widthMHz: 320 }), 7);
    assert.equal(inferGen({ band: 6135, widthMHz: 80 }), 6);
    assert.equal(inferGen({}), 4);
    assert.equal(inferGen(), 4);
    assert.equal(inferGen(null), 4);
    assert.equal(inferGen({ band: 'x', widthMHz: NaN }), 4);
  });

  test('mcsName', () => {
    assert.equal(mcsName(0), 'BPSK 1/2');
    assert.equal(mcsName(1), 'QPSK 1/2');
    assert.equal(mcsName(2), 'QPSK 3/4');
    assert.equal(mcsName(3), '16-QAM 1/2');
    assert.equal(mcsName(4), '16-QAM 3/4');
    assert.equal(mcsName(5), '64-QAM 2/3');
    assert.equal(mcsName(6), '64-QAM 3/4');
    assert.equal(mcsName(7), '64-QAM 5/6');
    assert.equal(mcsName(8), '256-QAM 3/4');
    assert.equal(mcsName(9), '256-QAM 5/6');
    assert.equal(mcsName(10), '1024-QAM 3/4');
    assert.equal(mcsName(11), '1024-QAM 5/6');
    assert.equal(mcsName(12), '4096-QAM 3/4');
    assert.equal(mcsName(13), '4096-QAM 5/6');
    for (const bad of [14, -1, 1.5, NaN, null, undefined, '3']) assert.equal(mcsName(bad), null, String(bad));
  });
});

describe('dataRate', () => {
  const rate = (standard, widthMHz, nss, mcs, giNs) => dataRate({ standard, widthMHz, nss, mcs, giNs });

  test('valores de referência bem conhecidos', () => {
    assert.equal(rate('ht', 20, 1, 7, 400), 72.2);
    assert.equal(rate('vht', 80, 2, 9, 400), 866.7);
    assert.equal(rate('he', 80, 2, 11, 800), 1201.0);
    assert.equal(dataRate({ standard: 'he', widthMHz: 160, nss: 2, mcs: 11 }), 2402.0);
    assert.equal(rate('eht', 320, 2, 13, 800), 5764.7);
  });

  test('802.11n (HT)', () => {
    assert.equal(rate('ht', 20, 1, 0, 800), 6.5);
    assert.equal(rate('ht', 20, 1, 0, 400), 7.2);
    assert.equal(rate('ht', 20, 1, 7, 800), 65);
    assert.equal(rate('ht', 20, 2, 7, 400), 144.4);
    assert.equal(rate('ht', 40, 1, 7, 400), 150);
    assert.equal(rate('ht', 40, 1, 7, 800), 135);
    assert.equal(rate('ht', 40, 2, 7, 400), 300);
    assert.equal(rate('ht', 40, 3, 7, 400), 450);
    assert.equal(rate('ht', 40, 4, 7, 400), 600);
    // toda a escada de 20 MHz, 1 fluxo, guarda longa
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((mcs) => rate('ht', 20, 1, mcs, 800)),
      [6.5, 13, 19.5, 26, 39, 52, 58.5, 65],
    );
  });

  test('802.11n: índice MCS 0..31 embute o número de fluxos', () => {
    assert.equal(rate('ht', 20, undefined, 15, 400), 144.4); // MCS 15 = MCS 7 com 2 fluxos
    assert.equal(rate('ht', 40, undefined, 15, 400), 300);
    assert.equal(rate('ht', 40, undefined, 23, 400), 450);
    assert.equal(rate('ht', 40, undefined, 31, 400), 600);
    assert.equal(rate('ht', 20, undefined, 8, 800), 13); // MCS 8 = MCS 0 com 2 fluxos
    assert.equal(rate('ht', 20, 1, 8, 800), 13); // o índice manda
    assert.equal(rate('ht', 20, 1, 32, 800), null);
  });

  test('802.11ac (VHT)', () => {
    assert.equal(rate('vht', 20, 1, 8, 400), 86.7);
    assert.equal(rate('vht', 20, 1, 8, 800), 78);
    assert.equal(rate('vht', 40, 1, 9, 400), 200);
    assert.equal(rate('vht', 40, 2, 9, 400), 400);
    assert.equal(rate('vht', 80, 1, 9, 400), 433.3);
    assert.equal(rate('vht', 80, 1, 9, 800), 390);
    assert.equal(rate('vht', 80, 2, 9, 800), 780);
    assert.equal(rate('vht', 80, 3, 9, 400), 1300);
    assert.equal(rate('vht', 80, 4, 9, 400), 1733.3);
    assert.equal(rate('vht', 160, 1, 9, 400), 866.7);
    assert.equal(rate('vht', 160, 2, 9, 400), 1733.3);
    assert.equal(rate('vht', 160, 4, 9, 400), 3466.7);
    assert.equal(rate('vht', 160, 8, 9, 400), 6933.3);
    assert.equal(rate('vht', 80, 1, 0, 800), 29.3);
  });

  test('802.11ac: combinações que o padrão exclui devolvem null', () => {
    // 20 MHz, MCS 9: só vale com 3 ou 6 fluxos
    for (const nss of [1, 2, 4, 5, 7, 8]) assert.equal(rate('vht', 20, nss, 9, 400), null, `20 MHz ${nss} fluxos`);
    assert.equal(rate('vht', 20, 3, 9, 400), 288.9);
    assert.equal(rate('vht', 20, 3, 9, 800), 260);
    assert.equal(rate('vht', 20, 6, 9, 400), 577.8);
    // 80 MHz: MCS 6 com 3 ou 7 fluxos; MCS 9 com 6 fluxos
    assert.equal(rate('vht', 80, 3, 6, 400), null);
    assert.equal(rate('vht', 80, 7, 6, 400), null);
    assert.equal(rate('vht', 80, 6, 9, 400), null);
    assert.equal(rate('vht', 80, 3, 5, 400), 780);
    assert.equal(rate('vht', 80, 3, 7, 400), 975);
    // 160 MHz: MCS 9 com 3 fluxos
    assert.equal(rate('vht', 160, 3, 9, 400), null);
    assert.equal(rate('vht', 160, 3, 8, 400), 2340);
    // em 40 MHz vale tudo
    for (let nss = 1; nss <= 8; nss++) {
      for (let mcs = 0; mcs <= 9; mcs++) assert.notEqual(rate('vht', 40, nss, mcs, 400), null, `40 MHz ${nss}x MCS ${mcs}`);
    }
  });

  test('802.11ax (HE)', () => {
    assert.equal(rate('he', 20, 1, 0, 800), 8.6);
    assert.equal(rate('he', 20, 1, 0, 1600), 8.1);
    assert.equal(rate('he', 20, 1, 0, 3200), 7.3);
    assert.equal(rate('he', 20, 1, 11, 800), 143.4);
    assert.equal(rate('he', 20, 2, 11, 800), 286.8);
    assert.equal(rate('he', 40, 1, 11, 800), 286.8);
    assert.equal(rate('he', 40, 2, 11, 800), 573.5);
    assert.equal(rate('he', 80, 1, 11, 800), 600.5);
    assert.equal(rate('he', 80, 2, 11, 1600), 1134.3);
    assert.equal(rate('he', 80, 2, 11, 3200), 1020.8);
    assert.equal(rate('he', 160, 1, 11, 800), 1201);
    assert.equal(rate('he', 160, 4, 11, 800), 4803.9);
    assert.equal(rate('he', 160, 8, 11, 800), 9607.8);
    assert.equal(rate('he', 80, 2, 9, 800), 960.8);
    // diferente do 11ac, 20 MHz com 1 fluxo aceita 256-QAM 5/6
    assert.equal(rate('he', 20, 1, 9, 800), 114.7);
  });

  test('802.11be (EHT)', () => {
    assert.equal(rate('eht', 20, 1, 13, 800), 172.1);
    assert.equal(rate('eht', 80, 2, 13, 800), 1441.2);
    assert.equal(rate('eht', 160, 2, 13, 800), 2882.4);
    assert.equal(rate('eht', 320, 1, 13, 800), 2882.4);
    assert.equal(rate('eht', 320, 2, 11, 800), 4803.9);
    assert.equal(rate('eht', 320, 4, 13, 800), 11529.4);
    assert.equal(rate('eht', 320, 2, 13, 3200), 4900);
    // até o MCS 11, igual ao 11ax
    assert.equal(rate('eht', 80, 2, 11, 800), rate('he', 80, 2, 11, 800));
  });

  test('sem giNs usa a guarda mais curta; sem nss, 1 fluxo', () => {
    assert.equal(dataRate({ standard: 'ht', widthMHz: 20, nss: 1, mcs: 7 }), 72.2);
    assert.equal(dataRate({ standard: 'vht', widthMHz: 80, nss: 2, mcs: 9 }), 866.7);
    assert.equal(dataRate({ standard: 'he', widthMHz: 80, nss: 2, mcs: 11 }), 1201);
    assert.equal(dataRate({ standard: 'eht', widthMHz: 320, nss: 2, mcs: 13 }), 5764.7);
    assert.equal(dataRate({ standard: 'he', widthMHz: 80, mcs: 11 }), 600.5);
    assert.equal(dataRate({ standard: 'he', widthMHz: 80, nss: null, mcs: 11, giNs: null }), 600.5);
  });

  test('o nome do padrão não diferencia maiúsculas', () => {
    assert.equal(dataRate({ standard: 'HE', widthMHz: 80, nss: 2, mcs: 11 }), 1201);
    assert.equal(dataRate({ standard: 'Vht', widthMHz: 80, nss: 2, mcs: 9 }), 866.7);
  });

  test('cresce com MCS e largura e é proporcional aos fluxos', () => {
    for (const standard of ['ht', 'vht', 'he', 'eht']) {
      const widths = { ht: [20, 40], vht: [20, 40, 80, 160], he: [20, 40, 80, 160], eht: [20, 40, 80, 160, 320] }[standard];
      const maxMcs = { ht: 7, vht: 9, he: 11, eht: 13 }[standard];
      let prevWidthRate = 0;
      for (const w of widths) {
        let prev = 0;
        for (let mcs = 0; mcs <= maxMcs; mcs++) {
          const r = rate(standard, w, 2, mcs);
          if (r === null) continue; // só as exclusões do 11ac
          assert.ok(r > prev, `${standard} ${w} MHz MCS ${mcs}`);
          prev = r;
          const one = rate(standard, w, 1, mcs);
          if (one !== null) near(r, 2 * one, 0.11, `${standard} ${w} MHz MCS ${mcs}: 2 fluxos`);
        }
        // dobrar a largura no mínimo dobra a taxa (as subportadoras de guarda viram dados)
        const top = rate(standard, w, 2, 7);
        assert.ok(top >= prevWidthRate * 2 - 0.11, `${standard}: ${w} MHz pelo menos dobra a largura anterior`);
        prevWidthRate = top;
      }
    }
  });

  test('guarda mais longa = taxa menor', () => {
    assert.ok(rate('ht', 20, 1, 7, 800) < rate('ht', 20, 1, 7, 400));
    assert.ok(rate('he', 80, 2, 11, 3200) < rate('he', 80, 2, 11, 1600));
    assert.ok(rate('he', 80, 2, 11, 1600) < rate('he', 80, 2, 11, 800));
  });

  test('limites de MCS, fluxos, largura e guarda de cada padrão', () => {
    // MCS máximo
    assert.equal(rate('ht', 20, 1, 7, 400), 72.2);
    assert.notEqual(rate('vht', 40, 1, 9, 400), null);
    assert.equal(rate('vht', 40, 1, 10, 400), null);
    assert.notEqual(rate('he', 80, 1, 11, 800), null);
    assert.equal(rate('he', 80, 1, 12, 800), null);
    assert.notEqual(rate('eht', 80, 1, 13, 800), null);
    assert.equal(rate('eht', 80, 1, 14, 800), null);
    // largura
    assert.equal(rate('ht', 80, 1, 7, 400), null);
    assert.equal(rate('vht', 320, 1, 7, 400), null);
    assert.equal(rate('he', 320, 1, 7, 800), null);
    assert.notEqual(rate('eht', 320, 1, 7, 800), null);
    assert.equal(rate('he', 30, 1, 7, 800), null);
    assert.equal(rate('he', 2160, 1, 7, 800), null);
    // fluxos
    assert.equal(rate('ht', 20, 5, 7, 400), null);
    assert.notEqual(rate('vht', 40, 8, 7, 400), null);
    assert.equal(rate('vht', 40, 9, 7, 400), null);
    assert.equal(rate('he', 80, 0, 7, 800), null);
    assert.equal(rate('he', 80, -1, 7, 800), null);
    assert.equal(rate('he', 80, 1.5, 7, 800), null);
    // guarda
    assert.equal(rate('ht', 20, 1, 7, 1600), null);
    assert.equal(rate('vht', 80, 1, 7, 3200), null);
    assert.equal(rate('he', 80, 1, 7, 400), null);
    assert.equal(rate('eht', 80, 1, 7, 400), null);
    assert.equal(rate('he', 80, 1, 7, 0), null);
  });

  test('entrada inválida devolve null', () => {
    assert.equal(dataRate(), null);
    assert.equal(dataRate(null), null);
    assert.equal(dataRate('he'), null);
    assert.equal(dataRate({}), null);
    assert.equal(dataRate({ standard: 'he' }), null);
    assert.equal(dataRate({ standard: 'he', widthMHz: 80 }), null);
    assert.equal(dataRate({ standard: 'legacy', widthMHz: 20, nss: 1, mcs: 0 }), null);
    assert.equal(dataRate({ standard: 'toString', widthMHz: 20, nss: 1, mcs: 0 }), null);
    assert.equal(dataRate({ standard: 6, widthMHz: 20, nss: 1, mcs: 0 }), null);
    assert.equal(dataRate({ standard: 'he', widthMHz: '80', nss: 1, mcs: 0 }), null);
    assert.equal(dataRate({ standard: 'he', widthMHz: NaN, nss: 1, mcs: 0 }), null);
    assert.equal(dataRate({ standard: 'he', widthMHz: 80, nss: NaN, mcs: 0 }), null);
    assert.equal(dataRate({ standard: 'he', widthMHz: 80, nss: 1, mcs: NaN }), null);
    assert.equal(dataRate({ standard: 'he', widthMHz: 80, nss: 1, mcs: -1 }), null);
    assert.equal(dataRate({ standard: 'he', widthMHz: 80, nss: 1, mcs: 2.5 }), null);
    assert.equal(dataRate({ standard: 'he', widthMHz: 80, nss: 1, mcs: '3' }), null);
    assert.equal(dataRate({ standard: 'he', widthMHz: 80, nss: 1, mcs: 3, giNs: NaN }), null);
  });
});

describe('maxRate', () => {
  test('Wi-Fi 4', () => {
    assert.equal(maxRate({ gen: 4, widthMHz: 20, nss: 1 }), 72.2);
    assert.equal(maxRate({ gen: 4, widthMHz: 20, nss: 2 }), 144.4);
    assert.equal(maxRate({ gen: 4, widthMHz: 40, nss: 2 }), 300);
    assert.equal(maxRate({ gen: 4, widthMHz: 40, nss: 3 }), 450);
    assert.equal(maxRate({ gen: 4, widthMHz: 40, nss: 4 }), 600);
  });

  test('Wi-Fi 5, pulando as combinações inválidas', () => {
    assert.equal(maxRate({ gen: 5, widthMHz: 80, nss: 1 }), 433.3);
    assert.equal(maxRate({ gen: 5, widthMHz: 80, nss: 2 }), 866.7);
    assert.equal(maxRate({ gen: 5, widthMHz: 80, nss: 3 }), 1300);
    assert.equal(maxRate({ gen: 5, widthMHz: 160, nss: 2 }), 1733.3);
    assert.equal(maxRate({ gen: 5, widthMHz: 20, nss: 1 }), 86.7); // MCS 9 não vale: fica o MCS 8
    assert.equal(maxRate({ gen: 5, widthMHz: 20, nss: 3 }), 288.9);
    assert.equal(maxRate({ gen: 5, widthMHz: 160, nss: 3 }), 2340);
    assert.equal(maxRate({ gen: 5, widthMHz: 80, nss: 6 }), 2340);
  });

  test('Wi-Fi 6 e 7', () => {
    assert.equal(maxRate({ gen: 6, widthMHz: 20, nss: 1 }), 143.4);
    assert.equal(maxRate({ gen: 6, widthMHz: 80, nss: 2 }), 1201);
    assert.equal(maxRate({ gen: 6, widthMHz: 160, nss: 2 }), 2402);
    assert.equal(maxRate({ gen: 7, widthMHz: 160, nss: 2 }), 2882.4);
    assert.equal(maxRate({ gen: 7, widthMHz: 320, nss: 2 }), 5764.7);
    assert.equal(maxRate({ gen: 8, widthMHz: 320, nss: 2 }), 5764.7); // geração futura: no mínimo o que o Wi-Fi 7 faz
  });

  test('a largura é limitada ao que a geração permite', () => {
    assert.equal(maxRate({ gen: 4, widthMHz: 80, nss: 1 }), 150);
    assert.equal(maxRate({ gen: 4, widthMHz: 160, nss: 2 }), 300);
    assert.equal(maxRate({ gen: 5, widthMHz: 320, nss: 2 }), 1733.3);
    assert.equal(maxRate({ gen: 6, widthMHz: 320, nss: 2 }), 2402);
    assert.equal(maxRate({ gen: 6, widthMHz: 100, nss: 2 }), 1201); // largura esquisita: a maior que cabe
  });

  test('em 2,4 GHz a largura para em 40 MHz', () => {
    assert.equal(maxRate({ gen: 6, widthMHz: 160, nss: 2, band: '2.4' }), 573.5);
    assert.equal(maxRate({ gen: 6, widthMHz: 160, nss: 2, band: 2437 }), 573.5);
    assert.equal(maxRate({ gen: 6, widthMHz: 20, nss: 2, band: '2.4' }), 286.8);
    assert.equal(maxRate({ gen: 6, widthMHz: 160, nss: 2, band: '5' }), 2402);
  });

  test('gerações antigas: 54 Mbps', () => {
    for (const gen of [1, 2, 3]) assert.equal(maxRate({ gen, widthMHz: 20, nss: 1 }), 54);
    assert.equal(maxRate({ gen: 3, widthMHz: 80, nss: 4 }), 54);
  });

  test('padrões e limites: 20 MHz, 1 fluxo; fluxos além do máximo são limitados', () => {
    assert.equal(maxRate({ gen: 6 }), 143.4);
    assert.equal(maxRate({ gen: 4, widthMHz: 40, nss: 8 }), 600);
    assert.equal(maxRate({ gen: 6, widthMHz: 80, nss: 20 }), 4803.9);
    assert.equal(maxRate({ gen: 6, widthMHz: 80, nss: 0 }), 600.5);
    assert.equal(maxRate({ gen: 6, widthMHz: 80, nss: 2.9 }), 1201);
  });

  test('entrada inválida', () => {
    assert.equal(maxRate(), null);
    assert.equal(maxRate(null), null);
    assert.equal(maxRate({}), null);
    for (const gen of [0, -1, NaN, null, undefined, 'x']) assert.equal(maxRate({ gen, widthMHz: 80, nss: 2 }), null, String(gen));
    assert.equal(maxRate({ gen: 6, widthMHz: 10, nss: 2 }), null);
  });
});

describe('MIN_SNR_DB', () => {
  test('tabela documentada: sensibilidade mínima do 802.11 em 20 MHz + 89 dB', () => {
    // −82, −79, −77, −74, −70, −66, −65, −64, −59, −57, −54, −52, −49, −46 dBm
    // menos o ruído assumido pela norma (−101 + 10 + 5 = −86 dBm), mais 3 dB de margem
    assert.deepEqual([...MIN_SNR_DB], [7, 10, 12, 15, 19, 23, 24, 25, 30, 32, 35, 37, 40, 43]);
    assert.ok(Object.isFrozen(MIN_SNR_DB));
  });

  test('cresce com o MCS', () => {
    for (let i = 1; i < MIN_SNR_DB.length; i++) assert.ok(MIN_SNR_DB[i] > MIN_SNR_DB[i - 1]);
  });
});

describe('estimateLink', () => {
  /** Menor sinal (passo de 0,1 dB) em que o enlace chega ao MCS pedido. */
  function thresholdRssi(params, mcs) {
    for (let rssi = -100; rssi <= -20; rssi += 0.1) {
      const link = estimateLink({ ...params, rssi });
      if (link.mcs !== null && link.mcs >= mcs && !link.unstable) return rssi;
    }
    return null;
  }

  test('sinal forte chega à taxa máxima negociada', () => {
    const link = estimateLink({ rssi: -40, band: '5', widthMHz: 80, apGen: 6, apNss: 2, clientGen: 6, clientNss: 2 });
    assert.deepEqual(Object.keys(link).sort(), LINK_KEYS);
    assert.equal(link.gen, 6);
    assert.equal(link.standard, 'he');
    assert.equal(link.widthMHz, 80);
    assert.equal(link.nss, 2);
    assert.equal(link.mcs, 11);
    assert.equal(link.phyMbps, 1201);
    assert.equal(link.maxPhyMbps, 1201);
    assert.equal(link.unstable, false);
    near(link.snrDb, -40 - noiseFloorDbm(80), 0.06);
  });

  test('negocia o mínimo entre AP e cliente: geração', () => {
    const base = { rssi: -40, band: '5', widthMHz: 80, apNss: 2, clientNss: 2 };
    const a = estimateLink({ ...base, apGen: 6, clientGen: 5 });
    assert.equal(a.gen, 5);
    assert.equal(a.standard, 'vht');
    assert.equal(a.phyMbps, 866.7);
    const b = estimateLink({ ...base, apGen: 5, clientGen: 7 });
    assert.equal(b.gen, 5);
    assert.equal(b.phyMbps, 866.7);
    const c = estimateLink({ ...base, apGen: 4, clientGen: 6 });
    assert.equal(c.gen, 4);
    assert.equal(c.widthMHz, 40); // 11n não passa de 40 MHz
    assert.equal(c.phyMbps, 300);
    const d = estimateLink({ ...base, apGen: 7, clientGen: 7 });
    assert.equal(d.gen, 7);
    assert.equal(d.mcs, 13);
    assert.equal(d.phyMbps, 1441.2);
  });

  test('negocia o mínimo entre AP e cliente: largura', () => {
    const base = { rssi: -35, band: '5', apGen: 6, clientGen: 6, apNss: 2, clientNss: 2 };
    assert.equal(estimateLink({ ...base, widthMHz: 160, clientMaxWidthMHz: 80 }).widthMHz, 80);
    assert.equal(estimateLink({ ...base, widthMHz: 160, clientMaxWidthMHz: 80 }).phyMbps, 1201);
    assert.equal(estimateLink({ ...base, widthMHz: 80, clientMaxWidthMHz: 160 }).widthMHz, 80);
    assert.equal(estimateLink({ ...base, widthMHz: 160, clientMaxWidthMHz: 160 }).phyMbps, 2402);
    assert.equal(estimateLink({ ...base, widthMHz: 160 }).widthMHz, 160); // sem limite informado do cliente
    assert.equal(estimateLink({ ...base, widthMHz: 80, clientMaxWidthMHz: 20 }).widthMHz, 20);
    assert.equal(estimateLink({ ...base, widthMHz: 80, clientMaxWidthMHz: NaN }).widthMHz, 80);
  });

  test('negocia o mínimo entre AP e cliente: fluxos (padrão 2 de cada lado)', () => {
    const base = { rssi: -35, band: '5', widthMHz: 80, apGen: 6, clientGen: 6 };
    assert.equal(estimateLink({ ...base, apNss: 4, clientNss: 2 }).nss, 2);
    assert.equal(estimateLink({ ...base, apNss: 2, clientNss: 4 }).nss, 2);
    assert.equal(estimateLink({ ...base, apNss: 4, clientNss: 4 }).nss, 4);
    assert.equal(estimateLink({ ...base, apNss: 4, clientNss: 4 }).phyMbps, 2402);
    assert.equal(estimateLink({ ...base, apNss: 1, clientNss: 2 }).phyMbps, 600.5);
    assert.equal(estimateLink(base).nss, 2);
    assert.equal(estimateLink({ ...base, apNss: 4 }).nss, 2);
    assert.equal(estimateLink({ ...base, apNss: 0, clientNss: NaN }).nss, 2);
    // 11n vai só até 4 fluxos
    assert.equal(estimateLink({ ...base, apGen: 4, clientGen: 4, apNss: 8, clientNss: 8 }).nss, 4);
  });

  test('2,4 GHz: no máximo 40 MHz, e 11ac vira 11n', () => {
    const wide = estimateLink({ rssi: -40, band: '2.4', widthMHz: 80, apGen: 6, clientGen: 6 });
    assert.equal(wide.widthMHz, 40);
    assert.equal(wide.phyMbps, 573.5);
    const ac = estimateLink({ rssi: -40, band: '2.4', widthMHz: 20, apGen: 5, clientGen: 5 });
    assert.equal(ac.gen, 4);
    assert.equal(ac.standard, 'ht');
    assert.equal(ac.phyMbps, 144.4);
    const n = estimateLink({ rssi: -40, band: 2437, widthMHz: 20, apGen: 4, clientGen: 6 });
    assert.equal(n.phyMbps, 144.4);
    assert.equal(n.maxPhyMbps, 144.4);
  });

  test('SNR = sinal − ruído na largura usada', () => {
    // piso de ruído: −94 dBm em 20 MHz, +3 dB a cada dobra
    near(estimateLink({ rssi: -60, band: '5', widthMHz: 20, apGen: 6 }).snrDb, 34, 0.051);
    near(estimateLink({ rssi: -60, band: '5', widthMHz: 40, apGen: 6 }).snrDb, 31, 0.051);
    near(estimateLink({ rssi: -60, band: '5', widthMHz: 80, apGen: 6 }).snrDb, 28, 0.051);
    near(estimateLink({ rssi: -60, band: '5', widthMHz: 160, apGen: 6 }).snrDb, 25, 0.051);
    near(estimateLink({ rssi: -60, band: '6', widthMHz: 320, apGen: 7 }).snrDb, 22, 0.11);
    for (const w of [20, 40, 80, 160]) {
      near(estimateLink({ rssi: -60, band: '5', widthMHz: w, apGen: 6 }).snrDb, -60 - noiseFloorDbm(w), 0.051, `${w} MHz`);
    }
    near(estimateLink({ rssi: -60, band: '6', widthMHz: 320, apGen: 7 }).snrDb, -60 - noiseFloorDbm(320), 0.051);
  });

  test('noiseDbm é o ruído em 20 MHz e é corrigido para a largura', () => {
    const quiet = estimateLink({ rssi: -60, band: '5', widthMHz: 20, apGen: 6, noiseDbm: -95 });
    assert.equal(quiet.snrDb, 35);
    const noisy = estimateLink({ rssi: -60, band: '5', widthMHz: 20, apGen: 6, noiseDbm: -80 });
    assert.equal(noisy.snrDb, 20);
    assert.equal(noisy.mcs, 4); // 19 dB <= 20 < 23 dB
    assert.ok(noisy.phyMbps < quiet.phyMbps);
    near(estimateLink({ rssi: -60, band: '5', widthMHz: 80, apGen: 6, noiseDbm: -95 }).snrDb, 35 - 6.02, 0.06);
    // ruído inválido: usa o piso térmico
    assert.equal(estimateLink({ rssi: -60, band: '5', widthMHz: 20, apGen: 6, noiseDbm: NaN }).snrDb, 34);
  });

  test('escolhe o maior MCS cujo SNR mínimo cabe', () => {
    // 20 MHz, ruído fixo de −90 dBm: SNR = rssi + 90
    const at = (snr) => estimateLink({ rssi: snr - 90, band: '5', widthMHz: 20, apGen: 7, clientGen: 7, noiseDbm: -90 });
    MIN_SNR_DB.forEach((need, mcs) => {
      assert.equal(at(need).mcs, mcs, `SNR ${need} dB`);
      assert.equal(at(need).unstable, false);
      if (mcs > 0) assert.equal(at(need - 0.5).mcs, mcs - 1, `SNR ${need - 0.5} dB`);
    });
    assert.equal(at(60).mcs, 13);
    // 11ax para no MCS 11 e 11ac no 9, por mais forte que seja o sinal
    assert.equal(estimateLink({ rssi: -20, band: '5', widthMHz: 40, apGen: 6 }).mcs, 11);
    assert.equal(estimateLink({ rssi: -20, band: '5', widthMHz: 40, apGen: 5 }).mcs, 9);
    assert.equal(estimateLink({ rssi: -20, band: '5', widthMHz: 40, apGen: 4 }).mcs, 7);
  });

  test('dobrar a largura pede 3 dB a mais de sinal para o mesmo MCS', () => {
    const base = { band: '5', apGen: 6, clientGen: 6 };
    for (const mcs of [0, 4, 7, 9, 11]) {
      const t20 = thresholdRssi({ ...base, widthMHz: 20 }, mcs);
      const t40 = thresholdRssi({ ...base, widthMHz: 40 }, mcs);
      const t80 = thresholdRssi({ ...base, widthMHz: 80 }, mcs);
      const t160 = thresholdRssi({ ...base, widthMHz: 160 }, mcs);
      near(t40 - t20, 3, 0.15, `MCS ${mcs}: 20 -> 40`);
      near(t80 - t40, 3, 0.15, `MCS ${mcs}: 40 -> 80`);
      near(t160 - t80, 3, 0.15, `MCS ${mcs}: 80 -> 160`);
    }
  });

  test('sinal necessário em 20 MHz fica 5 dB abaixo da sensibilidade mínima da norma', () => {
    // norma: MCS 0 = −82, MCS 7 = −64, MCS 9 = −57, MCS 11 = −52 dBm; o nosso ruído (NF 7 dB) é
    // 8 dB menor que o da norma (NF 10 + 5 de implementação) e somamos 3 dB de margem
    const base = { band: '5', widthMHz: 20, apGen: 6, clientGen: 6 };
    near(thresholdRssi(base, 0), -87, 0.15);
    near(thresholdRssi(base, 7), -69, 0.15);
    near(thresholdRssi(base, 9), -62, 0.15);
    near(thresholdRssi(base, 11), -57, 0.15);
  });

  test('taxa e MCS nunca caem quando o sinal melhora', () => {
    for (const cfg of [
      { band: '2.4', widthMHz: 20, apGen: 4 },
      { band: '5', widthMHz: 80, apGen: 5 },
      { band: '5', widthMHz: 160, apGen: 6 },
      { band: '6', widthMHz: 320, apGen: 7 },
      { band: '5', widthMHz: 20, apGen: 3 },
    ]) {
      let prev = 0;
      for (let rssi = -100; rssi <= -25; rssi += 0.5) {
        const link = estimateLink({ ...cfg, rssi });
        assert.ok(link.phyMbps >= prev, `${JSON.stringify(cfg)} em ${rssi} dBm`);
        assert.ok(link.phyMbps <= link.maxPhyMbps);
        prev = link.phyMbps;
      }
      assert.equal(prev, estimateLink({ ...cfg, rssi: -25 }).maxPhyMbps);
    }
  });

  test('exemplos em 80 MHz, 2 fluxos, Wi-Fi 6', () => {
    const at = (rssi) => estimateLink({ rssi, band: '5', widthMHz: 80, apGen: 6, clientGen: 6 });
    assert.equal(at(-50).phyMbps, 1201); // SNR 38 dB: MCS 11
    assert.equal(at(-60).mcs, 7); // SNR 28 dB
    assert.equal(at(-60).phyMbps, 720.6);
    assert.equal(at(-70).mcs, 3); // SNR 18 dB
    assert.equal(at(-80).mcs, 0); // SNR 8 dB
    assert.equal(at(-80).unstable, false);
  });

  test('sinal abaixo do MCS 0: menor taxa, marcada como instável', () => {
    const link = estimateLink({ rssi: -92, band: '5', widthMHz: 80, apGen: 6, clientGen: 6 });
    assert.equal(link.mcs, 0);
    assert.equal(link.phyMbps, 72.1);
    assert.equal(link.unstable, true);
    assert.ok(link.snrDb < MIN_SNR_DB[0]);
  });

  test('11ac em 20 MHz com 1 fluxo para no MCS 8 (o 9 não existe)', () => {
    const link = estimateLink({ rssi: -30, band: '5', widthMHz: 20, apGen: 5, clientGen: 5, apNss: 1, clientNss: 1 });
    assert.equal(link.mcs, 8);
    assert.equal(link.phyMbps, 86.7);
    assert.equal(link.maxPhyMbps, 86.7);
  });

  test('redes antigas (a/g): até 54 Mbps, sem MCS', () => {
    const strong = estimateLink({ rssi: -50, band: '5', widthMHz: 20, apGen: 2, clientGen: 6 });
    assert.equal(strong.gen, 2);
    assert.equal(strong.standard, 'legacy');
    assert.equal(strong.widthMHz, 20);
    assert.equal(strong.nss, 1);
    assert.equal(strong.mcs, null);
    assert.equal(strong.phyMbps, 54);
    assert.equal(strong.maxPhyMbps, 54);
    const g = estimateLink({ rssi: -50, band: '2.4', widthMHz: 40, apGen: 3, apNss: 4, clientNss: 4 });
    assert.equal(g.phyMbps, 54);
    assert.equal(g.widthMHz, 20);
    assert.equal(g.nss, 1);
    // SNR ≈ 9 dB: cabe 9 Mbps (8 dB), não 12 Mbps (10 dB)
    const weak = estimateLink({ rssi: -85, band: '2.4', apGen: 3 });
    assert.equal(weak.phyMbps, 9);
    assert.equal(weak.unstable, false);
    const dead = estimateLink({ rssi: -92, band: '2.4', apGen: 3 });
    assert.equal(dead.phyMbps, 6);
    assert.equal(dead.unstable, true);
    // escada completa com ruído fixo de −90 dBm
    const rates = [7, 8, 10, 12, 15, 19, 23, 24].map((snr) => estimateLink({ rssi: snr - 90, band: '5', apGen: 2, noiseDbm: -90 }).phyMbps);
    assert.deepEqual(rates, [6, 9, 12, 18, 24, 36, 48, 54]);
  });

  test('sem apGen: supõe a geração mínima compatível; sem clientGen: igual ao AP', () => {
    assert.equal(estimateLink({ rssi: -50, band: '5', widthMHz: 80 }).gen, 5);
    assert.equal(estimateLink({ rssi: -50, band: '5', widthMHz: 20 }).gen, 4);
    assert.equal(estimateLink({ rssi: -50, band: '2.4', widthMHz: 20 }).gen, 4);
    assert.equal(estimateLink({ rssi: -50, band: '6', widthMHz: 160 }).gen, 6);
    assert.equal(estimateLink({ rssi: -50, band: '6', widthMHz: 320 }).gen, 7);
    assert.equal(estimateLink({ rssi: -50, band: '5', widthMHz: 80, apGen: 0 }).gen, 5);
    assert.equal(estimateLink({ rssi: -50, band: '5', widthMHz: 80, apGen: null, clientGen: 6 }).gen, 5);
    assert.equal(estimateLink({ rssi: -50, band: '5', widthMHz: 80, apGen: 6 }).gen, 6);
    assert.equal(estimateLink({ rssi: -50, band: '5', widthMHz: 80, apGen: 9, clientGen: 12 }).gen, 7);
  });

  test('combinações impossíveis: tudo null', () => {
    // cliente sem Wi-Fi 6 não entra em rede de 6 GHz
    const six = estimateLink({ rssi: -50, band: '6', widthMHz: 80, apGen: 6, clientGen: 5 });
    assert.deepEqual(Object.keys(six).sort(), LINK_KEYS);
    assert.equal(six.gen, 5);
    assert.equal(six.phyMbps, null);
    assert.equal(six.maxPhyMbps, null);
    assert.equal(six.mcs, null);
    assert.equal(six.widthMHz, null);
    assert.equal(six.snrDb, null);
    // 60 GHz é outra camada física
    const ad = estimateLink({ rssi: -50, band: '60', widthMHz: 2160 });
    assert.equal(ad.phyMbps, null);
    assert.equal(ad.maxPhyMbps, null);
    // com Wi-Fi 6 dos dois lados funciona
    assert.equal(estimateLink({ rssi: -40, band: '6', widthMHz: 80, apGen: 6, clientGen: 6 }).phyMbps, 1201);
  });

  test('sinal desconhecido: sem taxa, mas com o máximo negociado', () => {
    for (const rssi of [NaN, null, undefined, 'x', Infinity]) {
      const link = estimateLink({ rssi, band: '5', widthMHz: 80, apGen: 6, clientGen: 6 });
      assert.equal(link.phyMbps, null, String(rssi));
      assert.equal(link.mcs, null);
      assert.equal(link.snrDb, null);
      assert.equal(link.unstable, false);
      assert.equal(link.gen, 6);
      assert.equal(link.widthMHz, 80);
      assert.equal(link.nss, 2);
      assert.equal(link.maxPhyMbps, 1201);
    }
  });

  test('largura esquisita ou ausente', () => {
    assert.equal(estimateLink({ rssi: -40, band: '5', apGen: 6 }).widthMHz, 20);
    assert.equal(estimateLink({ rssi: -40, band: '5', widthMHz: NaN, apGen: 6 }).widthMHz, 20);
    assert.equal(estimateLink({ rssi: -40, band: '5', widthMHz: 0, apGen: 6 }).widthMHz, 20);
    assert.equal(estimateLink({ rssi: -40, band: '5', widthMHz: 100, apGen: 6 }).widthMHz, 80);
    assert.equal(estimateLink({ rssi: -40, band: '5', widthMHz: 320, apGen: 6 }).widthMHz, 160);
  });

  test('nunca lança exceção', () => {
    for (const bad of [undefined, null, 42, 'x', [], {}, { rssi: 'forte' }, { band: 7, widthMHz: 'x', apGen: {}, clientNss: [] }]) {
      const link = estimateLink(bad);
      assert.deepEqual(Object.keys(link).sort(), LINK_KEYS);
      assert.equal(link.phyMbps, null);
    }
  });
});

describe('usableMbps', () => {
  test('aplica a eficiência do MAC (0,6 por padrão)', () => {
    assert.equal(MAC_EFFICIENCY, 0.6);
    assert.ok(MAC_EFFICIENCY >= 0.55 && MAC_EFFICIENCY <= 0.65);
    assert.equal(usableMbps(1000), 600);
    assert.equal(usableMbps(866.7), 520);
    assert.equal(usableMbps(1201), 720.6);
    assert.equal(usableMbps(72.2), 43.3);
    assert.equal(usableMbps(54), 32.4);
    assert.equal(usableMbps(0), 0);
  });

  test('eficiência própria; valor fora de (0, 1] cai no padrão', () => {
    assert.equal(usableMbps(1000, 0.5), 500);
    assert.equal(usableMbps(1000, 1), 1000);
    for (const bad of [0, -0.5, 1.5, NaN, null, 'x']) assert.equal(usableMbps(1000, bad), 600, String(bad));
  });

  test('entrada inválida devolve null', () => {
    for (const bad of [NaN, null, undefined, 'x', -1, Infinity, {}]) assert.equal(usableMbps(bad), null, String(bad));
  });

  test('sempre abaixo da taxa física', () => {
    for (const phy of [6.5, 54, 144.4, 866.7, 2402, 5764.7]) {
      const u = usableMbps(phy);
      assert.ok(u < phy && u > phy / 2);
    }
  });
});
