import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rateChannels, recommendChannel, recommendWidth, channelGraph } from '../app/js/core/channel-rating.js';
import { normalizeScan, normalizeAp, ApTracker } from '../app/js/core/model.js';
import { encodeIes } from '../app/js/core/ies.js';
import { blocksOf, channelList } from '../app/js/core/channels.js';
import { ALL, TRUTH, CW, apartment, apartmentTruth, quietHouse, quietHouseTruth, mesh, meshTruth, office, officeTruth, wifi7, wifi7Truth, makeAp, withAps } from './fixtures/scans.mjs';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'valor'}: esperado ${expected} ± ${tol}, veio ${actual}`);

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

const f24 = (ch) => 2407 + 5 * ch;
const f5 = (ch) => 5000 + 5 * ch;
const f6 = (ch) => 5950 + 5 * ch;

let serial = 0;
/** MAC sem parentesco com nenhum outro (cada chamada muda os seis octetos). */
function freshMac() {
  serial += 1;
  const h = (n) => (n & 0xff).toString(16).padStart(2, '0');
  return `${h(0x02 + 4 * (serial % 60))}:${h(serial * 7)}:${h(serial * 13)}:${h(serial * 29)}:${h(serial * 31)}:${h(serial * 37)}`;
}

/** Vizinho de 20 MHz num canal de 2,4 GHz. */
const n24 = (ch, level, more = {}) => makeAp(freshMac(), `viz-${ch}`, level, f24(ch), more);
/** Vizinho de 5 GHz: canal primário, largura (CW.*) e canal central do bloco. */
const n5 = (ch, level, width = CW.W20, center = ch, more = {}) => ({
  ...makeAp(freshMac(), `viz5-${ch}`, level, f5(ch), more),
  channelWidth: width,
  centerFreq0: width === CW.W20 ? 0 : f5(center),
});
const n6 = (ch, level, width = CW.W20, center = ch, more = {}) => ({
  ...makeAp(freshMac(), `viz6-${ch}`, level, f6(ch), more),
  channelWidth: width,
  centerFreq0: width === CW.W20 ? 0 : f6(center),
});
/** Elementos com BSS Load (aparelhos conectados e ocupação medida). */
const load = (frequency, stations, utilization) => encodeIes({ frequency, ht: { nss: 2 }, bssLoad: { stations, utilization } });

const scoreOf = (ratings) => new Map(ratings.map((r) => [r.channel, r.score]));
const byChannel = (ratings, ch) => ratings.find((r) => r.channel === ch);
const byCenter = (ratings, center) => ratings.find((r) => r.center === center);

const aptAps = normalizeScan(apartment);
const apt24 = aptAps.find((a) => a.id === apartmentTruth.own.b24);
const apt5 = aptAps.find((a) => a.id === apartmentTruth.own.b5);
const ownGroup = [apartmentTruth.own.b24, apartmentTruth.own.b5];

const RATING_KEYS = [
  'airtime',
  'band',
  'busiest',
  'center',
  'centerFreq',
  'channel',
  'channels',
  'coChannel',
  'dfs',
  'hi',
  'interferenceDbm',
  'lo',
  'notes',
  'overlapping',
  'psc',
  'recommendable',
  'score',
  'unii',
  'utilization',
  'widthMHz',
];

const COMBOS = [
  ['2.4', 20, 13],
  ['2.4', 40, 9],
  ['5', 20, 28],
  ['5', 40, 14],
  ['5', 80, 7],
  ['5', 160, 3],
  ['6', 20, 59],
  ['6', 40, 29],
  ['6', 80, 14],
  ['6', 160, 7],
  ['6', 320, 6],
];

// ---------------------------------------------------------------------------

describe('rateChannels: faixa vazia e formato', () => {
  test('faixa vazia: todo canal tem nota 100, em todas as larguras', () => {
    for (const [band, widthMHz, count] of COMBOS) {
      const ratings = rateChannels([], { band, widthMHz });
      assert.equal(ratings.length, count, `${band} ${widthMHz}`);
      for (const r of ratings) {
        assert.deepEqual(Object.keys(r).sort(), RATING_KEYS);
        assert.equal(r.score, 100);
        assert.equal(r.interferenceDbm, null);
        assert.equal(r.coChannel, 0);
        assert.equal(r.overlapping, 0);
        assert.equal(r.busiest, null);
        assert.equal(r.utilization, null);
        assert.equal(r.airtime, 0);
        assert.equal(r.band, band);
        assert.equal(r.widthMHz, widthMHz);
        assert.equal(r.hi - r.lo, widthMHz);
        assert.equal(r.centerFreq, (r.lo + r.hi) / 2);
        assert.ok(r.channels.includes(r.channel));
        assert.ok(Array.isArray(r.notes) && r.notes.every((n) => typeof n === 'string' && n.length > 10));
      }
    }
  });

  test('2,4 GHz: canais 1 a 13 em ordem; a largura padrão é 20 MHz', () => {
    const ratings = rateChannels([], { band: '2.4' });
    assert.deepEqual(ratings.map((r) => r.channel), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.deepEqual(ratings.map((r) => r.centerFreq), ratings.map((r) => f24(r.channel)));
    assert.deepEqual(ratings.filter((r) => r.recommendable).map((r) => r.channel), [1, 6, 11]);
    assert.ok(ratings.every((r) => !r.dfs && !r.psc && r.unii === null));
    // em 40 MHz, o primário de cada par é o canal padrão quando o par tem um
    const wide = rateChannels([], { band: '2.4', widthMHz: 40 });
    // (pares: 1+5, 2+6, 3+7, 4+8, 5+9, 6+10, 7+11, 8+12, 9+13)
    assert.deepEqual(wide.map((r) => [r.center, r.channel]), [[3, 1], [4, 6], [5, 3], [6, 4], [7, 5], [8, 6], [9, 11], [10, 8], [11, 9]]);
    assert.deepEqual(wide.filter((r) => r.recommendable).map((r) => r.center), [3, 4, 8, 9]);
  });

  test('redes de outra faixa não contam', () => {
    for (const r of rateChannels(aptAps.filter((a) => a.band === '2.4'), { band: '5', widthMHz: 80 })) assert.equal(r.score, 100);
    for (const r of rateChannels(aptAps, { band: '6', widthMHz: 160 })) assert.equal(r.score, 100);
  });

  test('faixa ou largura que não existe: lista vazia; lixo não lança exceção', () => {
    for (const band of [null, undefined, '60', '7', 5.5, {}, 'x']) assert.deepEqual(rateChannels(aptAps, { band }), []);
    assert.deepEqual(rateChannels(aptAps, { band: '2.4', widthMHz: 80 }), []);
    assert.deepEqual(rateChannels(aptAps, { band: '5', widthMHz: 320 }), []);
    assert.deepEqual(rateChannels(aptAps, { band: '5', widthMHz: 30 }), []);
    assert.deepEqual(rateChannels(aptAps, { band: '5', widthMHz: 'larga' }), []);
    assert.deepEqual(rateChannels(aptAps), []);
    assert.deepEqual(rateChannels(aptAps, null), []);
    // a faixa aceita número e vírgula
    assert.equal(rateChannels([], { band: 5, widthMHz: 80 }).length, 7);
    assert.equal(rateChannels([], { band: '2,4' }).length, 13);
    for (const junk of [null, undefined, 7, 'x', {}, [null, 3, 'x', {}, { bssid: 'zz', level: 'a', frequency: {} }, { level: -50 }, { frequency: 2437 }]]) {
      for (const exclude of [undefined, null, 5, 'x', {}, [null, 3, {}], new Set([undefined])]) {
        const ratings = rateChannels(junk, { band: '2.4', exclude });
        assert.equal(ratings.length, 13);
        assert.ok(ratings.every((r) => r.score === 100));
      }
    }
    // aceita ScanAp cru
    assert.deepEqual(rateChannels(apartment.aps, { band: '2.4' }), rateChannels(aptAps.map((a) => normalizeAp(a.raw)), { band: '2.4' }));
  });
});

// ---------------------------------------------------------------------------

describe('rateChannels: o modelo', () => {
  test('um vizinho forte no canal 6: dividir custa o tempo de ar dele; sobrepor custa mais', () => {
    const ap = n24(6, -60);
    const ratings = rateChannels([ap], { band: '2.4' });
    const s = scoreOf(ratings);
    // mesmo canal, acima de -82 dBm: 8% do tempo (ciclo de trabalho padrão)
    assert.equal(s.get(6), 92);
    const six = byChannel(ratings, 6);
    assert.equal(six.coChannel, 1);
    assert.equal(six.overlapping, 0);
    assert.equal(six.airtime, 0.08);
    assert.equal(six.utilization, null);
    near(six.interferenceDbm, -60, 0.11, 'potência no canal');
    assert.deepEqual(six.busiest, { ssid: 'viz-6', rssi: -60, bssid: ap.bssid, channel: 6 });
    // canais parcialmente sobrepostos: pior que dividir, apesar de entrar menos potência
    for (const ch of [4, 5, 7, 8]) {
      assert.ok(s.get(ch) < s.get(6) - 5, `canal ${ch}: ${s.get(ch)}`);
      const r = byChannel(ratings, ch);
      assert.equal(r.coChannel, 0);
      assert.equal(r.overlapping, 1);
      assert.equal(r.airtime, 0);
      assert.ok(r.interferenceDbm < six.interferenceDbm);
    }
    // simétrico em volta do canal 6
    for (const d of [1, 2, 3, 4, 5]) near(s.get(6 - d), s.get(6 + d), 0.11, `±${d}`);
    // quanto mais longe, melhor
    assert.ok(s.get(5) < s.get(4) && s.get(4) < s.get(3) && s.get(3) < s.get(2) && s.get(2) < s.get(1));
    // 1 e 11 não se sobrepõem ao 6, mas a 25 MHz ainda chega um resto pela borda da máscara
    // (-30 dB): um vizinho de -60 dBm tira uns 2 pontos
    assert.ok(s.get(1) > 97.5 && s.get(1) < 99, `canal 1: ${s.get(1)}`);
    assert.equal(byChannel(ratings, 1).overlapping, 0);
    assert.equal(byChannel(ratings, 2).overlapping, 0); // 20 MHz ao lado: encosta, mas não sobrepõe
    near(byChannel(ratings, 1).interferenceDbm, -90, 0.3, 'vazamento a 25 MHz');
    assert.ok(s.get(13) > 99.5);
    // a 60 MHz de distância não chega nada
    const far = byChannel(rateChannels([n24(1, -60)], { band: '2.4' }), 13);
    assert.equal(far.score, 100);
    assert.equal(far.busiest, null);
    assert.equal(far.interferenceDbm, null);
  });

  test('ruído é pior que dividir, por unidade de potência', () => {
    // O mesmo vizinho, uma vez no nosso canal e outra dois canais ao lado (metade da potência cai dentro)
    const same = byChannel(rateChannels([n24(6, -60)], { band: '2.4' }), 6);
    const off = byChannel(rateChannels([n24(8, -60)], { band: '2.4' }), 6);
    assert.ok(off.interferenceDbm < same.interferenceDbm - 2.5);
    assert.ok(off.score < same.score - 5);
    // ...mas ruído fraco quase não custa: o mesmo vizinho a -90 dBm
    const faint = byChannel(rateChannels([n24(8, -90)], { band: '2.4' }), 6);
    assert.ok(faint.score > 98.5 && faint.score < 100);
  });

  test('a nota nunca melhora quando o vizinho fica mais forte', () => {
    for (const [own, other] of [[6, 6], [6, 8], [6, 4], [1, 5], [11, 9]]) {
      let previous = 100;
      for (let level = -100; level <= -30; level++) {
        const score = byChannel(rateChannels([n24(other, level)], { band: '2.4' }), own).score;
        assert.ok(score <= previous, `canal ${own}, vizinho no ${other} a ${level} dBm: ${score} > ${previous}`);
        previous = score;
      }
      assert.ok(previous < 93);
    }
    // no mesmo canal, abaixo do limiar de detecção o vizinho vira ruído fraco: custa menos que dividir
    const weak = byChannel(rateChannels([n24(6, -88)], { band: '2.4' }), 6);
    assert.ok(weak.score > 92 && weak.score < 100);
    assert.equal(weak.coChannel, 1);
    assert.equal(weak.airtime, 0);
    assert.equal(byChannel(rateChannels([n24(6, -82)], { band: '2.4' }), 6).score, 92);
    assert.equal(byChannel(rateChannels([n24(6, -40)], { band: '2.4' }), 6).score, 92);
  });

  test('vários vizinhos no mesmo canal: T = 1 − Π(1 − ciclo)', () => {
    const three = [n24(1, -55), n24(1, -65), n24(1, -75)];
    const r = byChannel(rateChannels(three, { band: '2.4' }), 1);
    near(r.score, 100 * 0.92 ** 3, 0.051, 'três vizinhos');
    assert.equal(r.coChannel, 3);
    near(r.airtime, 1 - 0.92 ** 3, 0.001, 'tempo de ar');
    assert.equal(r.busiest.rssi, -55);
    // potências somam em mW: -55, -65 e -75 dBm dão -54,5 dBm
    near(r.interferenceDbm, -54.5, 0.11, 'soma');
  });

  test('BSS Load: aparelhos conectados viram ciclo de trabalho; ocupação medida é o piso', () => {
    const score = (stations, utilization) =>
      byChannel(rateChannels([n24(6, -60, { ies: load(2437, stations, utilization) })], { band: '2.4' }), 6);
    // ninguém conectado e canal quase parado: só os beacons (2%)
    assert.equal(score(0, 0.01).score, 98);
    // 2% + 3% por aparelho
    assert.equal(score(2, 0.01).score, 92);
    assert.equal(score(6, 0.01).score, 80);
    // teto de 50%
    assert.equal(score(40, 0.01).score, 50);
    // a ocupação que o AP mede no canal vale mais que a estimativa
    const busy = score(1, 0.6);
    assert.equal(busy.score, 40);
    near(busy.utilization, 0.6, 0.006, 'ocupação');
    near(busy.airtime, 0.6, 0.006, 'tempo de ar');
    // dois APs medindo o mesmo canal não somam as medições: vale a maior (50%), mais os
    // beacons de cada um (2%): T = 1 − 0,98 · 0,98 · (1 − (0,502 − 0,02)/0,98)
    const two = [n24(6, -60, { ies: load(2437, 0, 0.5) }), n24(6, -70, { ies: load(2437, 0, 0.45) })];
    near(byChannel(rateChannels(two, { band: '2.4' }), 6).score, 48.8, 0.11, 'duas medições');
    near(byChannel(rateChannels(two, { band: '2.4' }), 6).utilization, 0.5, 0.006, 'a maior');
    // medição abaixo do ciclo estimado não reduz o custo
    assert.equal(score(6, 0.05).score, 80);
    // medição de quem está em outro canal não entra
    assert.equal(byChannel(rateChannels([n24(1, -60, { ies: load(2412, 0, 0.9) })], { band: '2.4' }), 11).utilization, null);
  });

  test('leituras velhas (mais de 30 s) pesam menos', () => {
    const score = (ageMs) => byChannel(rateChannels([n24(6, -60, { ageMs })], { band: '2.4' }), 6).score;
    assert.equal(score(200), 92);
    assert.equal(score(30_000), 92);
    assert.equal(score(60_000), 96); // metade
    assert.equal(score(90_000), 98); // um quarto
    assert.ok(score(45_000) > 92 && score(45_000) < 96);
    // idem para o ruído
    const noise = (ageMs) => byChannel(rateChannels([n24(8, -60, { ageMs })], { band: '2.4' }), 6).score;
    assert.ok(noise(200) < noise(60_000) && noise(60_000) < noise(120_000));
    // a contagem de redes não muda com a idade
    assert.equal(byChannel(rateChannels([n24(6, -60, { ageMs: 90_000 })], { band: '2.4' }), 6).coChannel, 1);
  });

  test('várias redes do mesmo rádio contam como um vizinho só (mais os beacons)', () => {
    const radio = [
      makeAp('f8:0b:be:4f:1d:28', 'CLARO_2G4F1D2A', -58, 2437),
      makeAp('f8:0b:be:4f:1d:29', '#NET-CLARO-WIFI', -59, 2437, { capabilities: '[ESS]' }),
      makeAp('f8:0b:be:4f:1d:2a', '', -58, 2437),
    ];
    const one = byChannel(rateChannels(radio, { band: '2.4' }), 6);
    near(one.score, 100 * (1 - (0.08 + 2 * 0.015)), 0.051, 'um rádio, três redes');
    assert.equal(one.coChannel, 3); // a contagem é de redes (BSSIDs)
    near(one.interferenceDbm, -58, 0.11, 'a potência não é somada três vezes');
    // três roteadores diferentes custam bem mais
    const three = byChannel(rateChannels([n24(6, -58), n24(6, -59), n24(6, -58)], { band: '2.4' }), 6);
    assert.ok(three.score < one.score - 8);
  });

  test('vizinho em 40 MHz atrapalha as duas metades', () => {
    // 2,4 GHz: primário no 1, secundário no 5 (2402–2442 MHz)
    const wide = { ...makeAp(freshMac(), 'larga', -60, 2412), channelWidth: CW.W40, centerFreq0: 2422 };
    const narrow = makeAp(freshMac(), 'estreita', -60, 2412);
    const w = scoreOf(rateChannels([wide], { band: '2.4' }));
    const n = scoreOf(rateChannels([narrow], { band: '2.4' }));
    assert.equal(w.get(1), 92); // metade primária: divide o canal
    assert.equal(n.get(1), 92);
    // metade secundária (canais 5 e 6): só a rede larga chega lá com força
    for (const ch of [5, 6]) assert.ok(w.get(ch) < n.get(ch) - 10, `canal ${ch}: ${w.get(ch)} x ${n.get(ch)}`);
    assert.ok(w.get(5) < 85 && n.get(5) > 94);
    assert.ok(w.get(6) < 85 && n.get(6) > 97.5);
    // a saia de um canal de 40 MHz vai mais longe
    assert.ok(w.get(11) > 97.5 && w.get(11) < 99);
    assert.equal(n.get(11), 100);
    assert.equal(byChannel(rateChannels([wide], { band: '2.4' }), 6).overlapping, 1);
    assert.equal(byChannel(rateChannels([narrow], { band: '2.4' }), 6).overlapping, 0);

    // 5 GHz: 36+40
    const w5 = scoreOf(rateChannels([n5(36, -60, CW.W40, 38)], { band: '5' }));
    const n5s = scoreOf(rateChannels([n5(36, -60)], { band: '5' }));
    assert.equal(w5.get(36), 92);
    assert.equal(n5s.get(36), 92);
    assert.ok(w5.get(40) < 85, `canal 40: ${w5.get(40)}`);
    assert.ok(n5s.get(40) > 94);
    assert.ok(w5.get(44) > 95 && w5.get(149) === 100);
  });

  test('exclude: as redes do próprio usuário não contam como interferência', () => {
    const all = scoreOf(rateChannels(aptAps, { band: '2.4' }));
    const mine = rateChannels(aptAps, { band: '2.4', exclude: ownGroup });
    const without = scoreOf(mine);
    // o roteador da casa (-48 dBm no canal 6) pesa em todo canal vizinho
    for (const ch of [3, 4, 5, 6, 7, 8, 9]) assert.ok(without.get(ch) > all.get(ch) + 1, `canal ${ch}`);
    for (let ch = 1; ch <= 13; ch++) assert.ok(without.get(ch) >= all.get(ch));
    assert.equal(byChannel(rateChannels(aptAps, { band: '2.4' }), 6).coChannel, 8);
    assert.equal(byChannel(rateChannels(aptAps, { band: '2.4' }), 6).busiest.ssid, 'Familia Souza');
    assert.equal(byChannel(mine, 6).coChannel, 7);
    assert.equal(byChannel(mine, 6).busiest.ssid, 'iPhone de Bruna');
    // Set, lista, texto solto, maiúsculas e objetos com bssid: tanto faz
    for (const exclude of [new Set(ownGroup), ownGroup.map((b) => b.toUpperCase()), apartmentTruth.own.b24, [apt24, apt5], new Set([apt24])]) {
      assert.deepEqual(scoreOf(rateChannels(aptAps, { band: '2.4', exclude })), without);
    }
    // sozinho na faixa: com o próprio roteador fora da conta, tudo livre
    const alone = [makeAp('02:00:00:00:00:01', 'eu', -40, 2437)];
    assert.ok(rateChannels(alone, { band: '2.4', exclude: ['02:00:00:00:00:01'] }).every((r) => r.score === 100));
    assert.equal(byChannel(rateChannels(alone, { band: '2.4' }), 6).score, 92);
  });

  test('ocupação medida no canal do próprio usuário não é usada contra ele', () => {
    const me = makeAp('02:00:00:00:00:01', 'eu', -40, 2437);
    const neighbour = n24(6, -60, { ies: load(2437, 1, 0.8) });
    // sem saber quem é o usuário, o canal 6 está 80% ocupado
    assert.equal(byChannel(rateChannels([neighbour], { band: '2.4' }), 6).score, 20);
    // sabendo: esses 80% incluem o tráfego do próprio usuário; vale o ciclo estimado do vizinho (2% + 3%)
    const r = byChannel(rateChannels([me, neighbour], { band: '2.4', exclude: [me.bssid] }), 6);
    assert.equal(r.score, 95);
    assert.equal(r.airtime, 0.05);
    near(r.utilization, 0.8, 0.006, 'continua informada');
    assert.ok(r.notes.some((n) => n.includes('sua própria rede')));
    // nos outros canais a medição vale normalmente
    const other = n24(11, -60, { ies: load(2462, 1, 0.8) });
    assert.equal(byChannel(rateChannels([me, other], { band: '2.4', exclude: [me.bssid] }), 11).score, 20);
  });
});

// ---------------------------------------------------------------------------

describe('rateChannels: prédio lotado', () => {
  const ratings = rateChannels(aptAps, { band: '2.4', exclude: ownGroup });
  const s = scoreOf(ratings);

  test('1, 6 e 11 comparados com bom senso', () => {
    // canal 1: três vizinhos ativos; canal 6: seis rádios; canal 11: cinco, e um deles mede 55% de ocupação
    assert.ok(s.get(1) > s.get(6) + 10, `1: ${s.get(1)}, 6: ${s.get(6)}`);
    assert.ok(s.get(1) > s.get(11) + 10, `1: ${s.get(1)}, 11: ${s.get(11)}`);
    assert.equal(Math.max(...s.values()), s.get(1));
    assert.ok(s.get(6) > s.get(11) + 5, `6: ${s.get(6)}, 11: ${s.get(11)}`);
    for (const ch of [1, 6, 11]) assert.ok(s.get(ch) > 20 && s.get(ch) < 75, `canal ${ch}: ${s.get(ch)}`);
    // estacionar entre os canais padrão é sempre pior do que ficar num deles
    for (const off of [3, 4, 8, 9]) for (const std of [1, 6, 11]) assert.ok(s.get(off) < s.get(std), `${off} x ${std}`);
  });

  test('contagens, ocupação e quem mais interfere', () => {
    assert.deepEqual([1, 6, 11].map((ch) => byChannel(ratings, ch).coChannel), [4, 7, 6]);
    assert.equal(byChannel(ratings, 1).overlapping, 2); // INTELBRAS no 3 e TP-Link no 4
    assert.equal(byChannel(ratings, 11).overlapping, 3); // D-Link no 8, INTELBRAS no 9 e a metade de cima do 6+10
    near(byChannel(ratings, 11).utilization, 0.55, 0.006, 'canal 11');
    near(byChannel(ratings, 1).utilization, 0.18, 0.006, 'canal 1');
    // canal 11: ciclos 8% (Vivo), 9,5% (Claro, duas redes), 8% (Oi, 2 aparelhos), 20% (Vovó, 6) e 8%
    // (oculta); a Vovó mede 54,9%, ou seja, (0,549 − 0,2)/0,8 = 43,6% de carga além dela mesma
    near(byChannel(ratings, 11).airtime, 1 - 0.92 * 0.905 * 0.92 * 0.8 * 0.92 * (1 - 0.43627), 0.002, 'canal 11');
    // canal 1: 11% (Vivo, 3 aparelhos, mede 18%), 8% (NET) e 8% (Zé); a quarta rede é fraca e velha demais
    near(byChannel(ratings, 1).airtime, 1 - 0.89 * 0.92 * 0.92 * (1 - 0.0791), 0.002, 'canal 1');
    near(byChannel(ratings, 6).airtime, 1 - 0.905 * 0.92 ** 5, 0.002, 'canal 6');
    assert.equal(byChannel(ratings, 6).utilization, null);
    assert.equal(byChannel(ratings, 11).busiest.ssid, 'Wi-Fi da Vovó');
    assert.equal(byChannel(ratings, 1).busiest.ssid, 'VIVOFIBRA-8A20');
    for (const r of ratings) assert.ok(r.interferenceDbm > -70 && r.interferenceDbm < -50, `canal ${r.channel}: ${r.interferenceDbm}`);
  });

  test('acrescentar uma rede nunca melhora nota nenhuma; no canal dela, piora', () => {
    for (const widthMHz of [20, 40]) {
      const before = rateChannels(aptAps, { band: '2.4', widthMHz, exclude: ownGroup });
      for (let ch = 1; ch <= 13; ch++) {
        for (const level of [-45, -70, -90]) {
          const after = rateChannels(normalizeScan(withAps(apartment, [n24(ch, level)])), { band: '2.4', widthMHz, exclude: ownGroup });
          after.forEach((r, i) => assert.ok(r.score <= before[i].score, `+canal ${ch} a ${level}: bloco ${r.center} foi de ${before[i].score} para ${r.score}`));
          if (widthMHz === 20 && level === -45) {
            const now = byChannel(after, ch).score;
            assert.ok(now < byChannel(before, ch).score - 1, `canal ${ch}: ${byChannel(before, ch).score} -> ${now}`);
            assert.equal(byChannel(after, ch).coChannel, byChannel(before, ch).coChannel + 1);
          }
        }
      }
    }
  });

  test('5 GHz do prédio: 36–48 e 149–161 ocupados, DFS livre', () => {
    const r80 = rateChannels(aptAps, { band: '5', widthMHz: 80, exclude: ownGroup });
    assert.deepEqual(r80.map((r) => r.center), [42, 58, 106, 122, 138, 155, 171]);
    for (const center of [58, 106, 122, 138]) assert.ok(byCenter(r80, center).score > 99.5);
    assert.ok(byCenter(r80, 42).score < 95);
    assert.ok(byCenter(r80, 155).score < byCenter(r80, 42).score); // quatro redes contra uma
    // dentro do bloco 42 o melhor primário é o do vizinho (44): dividir é melhor que brigar
    assert.equal(byCenter(r80, 42).channel, 44);
    assert.equal(byCenter(r80, 42).coChannel, 1);
    assert.equal(byCenter(r80, 42).score, 92);
    assert.equal(byCenter(r80, 155).coChannel + byCenter(r80, 155).overlapping, 4);
  });
});

// ---------------------------------------------------------------------------

describe('rateChannels: 5 e 6 GHz', () => {
  test('todas as larguras dos 5 GHz: blocos, DFS e U-NII-4', () => {
    const expected = {
      20: { centers: channelList('5').map((c) => c.channel), dfs: [52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144], off: [169, 173, 177] },
      40: { centers: [38, 46, 54, 62, 102, 110, 118, 126, 134, 142, 151, 159, 167, 175], dfs: [54, 62, 102, 110, 118, 126, 134, 142], off: [167, 175] },
      80: { centers: [42, 58, 106, 122, 138, 155, 171], dfs: [58, 106, 122, 138], off: [171] },
      160: { centers: [50, 114, 163], dfs: [50, 114], off: [163] },
    };
    for (const [width, want] of Object.entries(expected)) {
      const ratings = rateChannels([], { band: '5', widthMHz: Number(width) });
      assert.deepEqual(ratings.map((r) => r.center), want.centers, `${width} MHz`);
      assert.deepEqual(ratings.filter((r) => r.dfs).map((r) => r.center), want.dfs, `${width} MHz DFS`);
      assert.deepEqual(ratings.filter((r) => !r.recommendable).map((r) => r.center), want.off, `${width} MHz U-NII-4`);
      // sem vizinhos, o primário é o canal mais baixo do bloco
      assert.ok(ratings.every((r) => r.channel === r.channels[0]));
      for (const r of ratings) {
        assert.deepEqual(r.channels, blocksOf('5', Number(width)).find((b) => b.center === r.center).channels);
        if (r.dfs) assert.ok(r.notes.some((n) => n.includes('DFS')), `${width} MHz, bloco ${r.center}`);
        if (!r.recommendable) assert.ok(r.notes.some((n) => n.includes('U-NII-4')));
      }
    }
    // bloco de 160 MHz com primário fora do trecho DFS: o aviso fala do bloco
    assert.ok(byCenter(rateChannels([], { band: '5', widthMHz: 160 }), 50).notes[0].startsWith('Parte deste bloco usa canais DFS'));
    assert.ok(byChannel(rateChannels([], { band: '5' }), 52).notes[0].startsWith('DFS:'));
    assert.deepEqual(byChannel(rateChannels([], { band: '5' }), 36).notes, []);
  });

  test('um vizinho em 80 MHz (36–48) visto em cada largura', () => {
    const ap = n5(36, -60, CW.W80, 42);
    // 20 MHz: o primário divide; os outros três canais do bloco pegam um quarto da potência como ruído
    const r20 = rateChannels([ap], { band: '5', widthMHz: 20 });
    assert.equal(byChannel(r20, 36).score, 92);
    for (const ch of [40, 44, 48]) {
      const r = byChannel(r20, ch);
      assert.ok(r.score < 92 && r.score > 70, `canal ${ch}: ${r.score}`);
      assert.equal(r.overlapping, 1);
      near(r.interferenceDbm, -66, 0.2, 'um quarto de -60 dBm');
    }
    // o canal colado no bloco (52) ainda sente a borda da máscara; depois some
    assert.ok(byChannel(r20, 52).score > 96 && byChannel(r20, 52).score < 98);
    assert.ok(r20.filter((r) => r.channel >= 56).every((r) => r.score > 98));
    assert.ok(r20.filter((r) => r.channel >= 100).every((r) => r.score === 100));
    // 40 MHz: o par que contém o primário divide; o outro par é ruído
    const r40 = rateChannels([ap], { band: '5', widthMHz: 40 });
    assert.deepEqual([byCenter(r40, 38).score, byCenter(r40, 38).channel], [92, 36]);
    assert.ok(byCenter(r40, 46).score < 90);
    assert.ok(r40.filter((r) => r.center >= 54).every((r) => r.score > 97));
    assert.ok(r40.filter((r) => r.center >= 102).every((r) => r.score === 100));
    // 80 e 160 MHz: o bloco que o contém escolhe o primário dele
    const r80 = rateChannels([ap], { band: '5', widthMHz: 80 });
    assert.deepEqual([byCenter(r80, 42).score, byCenter(r80, 42).channel, byCenter(r80, 42).coChannel], [92, 36, 1]);
    assert.ok(byCenter(r80, 58).score > 97.5 && byCenter(r80, 58).score < 99);
    assert.ok(r80.filter((r) => r.center > 58).every((r) => r.score === 100));
    const r160 = rateChannels([ap], { band: '5', widthMHz: 160 });
    assert.deepEqual([byCenter(r160, 50).score, byCenter(r160, 50).channel], [92, 36]);
    assert.equal(byCenter(r160, 114).score, 100);
    assert.equal(byCenter(r160, 163).score, 100);
    // em todas: quem mais interfere é ele
    for (const r of [byChannel(r20, 44), byCenter(r40, 46), byCenter(r80, 42), byCenter(r160, 50)]) assert.equal(r.busiest.bssid, ap.bssid);
  });

  test('dentro de um bloco largo, o primário acompanha o vizinho forte', () => {
    const r = byCenter(rateChannels([n5(44, -50, CW.W80, 42)], { band: '5', widthMHz: 80 }), 42);
    assert.equal(r.channel, 44);
    assert.equal(r.score, 92);
    // dois vizinhos com primários diferentes no mesmo bloco: fica com um deles e o outro vira ruído
    const two = byCenter(rateChannels([n5(36, -50, CW.W80, 42), n5(48, -55, CW.W80, 42)], { band: '5', widthMHz: 80 }), 42);
    assert.ok([36, 48].includes(two.channel));
    assert.equal(two.coChannel, 1);
    assert.equal(two.overlapping, 1);
    assert.ok(two.score < 80);
  });

  test('acrescentar uma rede nos 5 GHz nunca melhora nota nenhuma, em nenhuma largura', () => {
    const extras = [n5(36, -50), n5(44, -60, CW.W80, 42), n5(100, -55, CW.W80, 106), n5(52, -70, CW.W40, 54), n5(149, -45, CW.W80, 155), n5(165, -50), n5(64, -88, CW.W160, 50)];
    for (const widthMHz of [20, 40, 80, 160]) {
      const before = rateChannels(aptAps, { band: '5', widthMHz, exclude: ownGroup });
      for (const extra of extras) {
        const after = rateChannels(normalizeScan(withAps(apartment, [extra])), { band: '5', widthMHz, exclude: ownGroup });
        after.forEach((r, i) => assert.ok(r.score <= before[i].score, `${widthMHz} MHz, bloco ${r.center}: ${before[i].score} -> ${r.score}`));
        const hit = after.findIndex((r) => r.channels.includes((extra.frequency - 5000) / 5));
        if (extra.level > -80) assert.ok(after[hit].score < before[hit].score, `${widthMHz} MHz, +canal ${(extra.frequency - 5000) / 5}`);
      }
    }
  });

  test('6 GHz: todas as larguras; o primário é sempre um PSC quando o bloco tem um', () => {
    const psc = new Set(channelList('6').filter((c) => c.psc).map((c) => c.channel));
    assert.equal(psc.size, 15);
    for (const widthMHz of [20, 40, 80, 160, 320]) {
      const ratings = rateChannels(normalizeScan(wifi7), { band: '6', widthMHz });
      for (const r of ratings) {
        const has = r.channels.some((c) => psc.has(c));
        assert.equal(r.psc, has, `${widthMHz} MHz, bloco ${r.center}`);
        assert.equal(r.recommendable, has);
        if (has) assert.ok(psc.has(r.channel));
        else assert.ok(r.notes.some((n) => n.includes('PSC')));
        assert.equal(r.dfs, false);
      }
      // de 80 MHz para cima todo bloco tem um PSC
      if (widthMHz >= 80) assert.ok(ratings.every((r) => r.psc));
    }
    assert.equal(rateChannels([], { band: '6' }).filter((r) => r.psc).length, 15);
    assert.equal(rateChannels([], { band: '6', widthMHz: 40 }).filter((r) => r.psc).length, 15);
    // os dois conjuntos de 320 MHz se sobrepõem: uma rede no bloco 1–61 pesa também no 33–93
    const one = rateChannels([n6(37, -60, CW.W320, 31)], { band: '6', widthMHz: 320 });
    assert.deepEqual(one.map((r) => r.center), [31, 63, 95, 127, 159, 191]);
    assert.equal(byCenter(one, 31).score, 92);
    assert.equal(byCenter(one, 63).score, 92); // o canal 37 também é primário válido do bloco 33–93
    assert.equal(byCenter(one, 63).channel, 37);
    assert.ok(byCenter(one, 95).score > 99);
    assert.ok(byCenter(one, 127).score > 99.5);
    assert.equal(byCenter(one, 191).score, 100);
    // um vizinho em 160 MHz dentro do bloco de 320 MHz do usuário
    const mine = rateChannels(normalizeScan(wifi7), { band: '6', widthMHz: 320, exclude: [wifi7Truth.own.b6] });
    assert.ok(byCenter(mine, 31).score < 100 && byCenter(mine, 31).score > 85);
    assert.equal(byCenter(mine, 31).overlapping + byCenter(mine, 31).coChannel, 1);
    assert.equal(byCenter(mine, 127).score, 100);
  });

  test('avisos de 2,4 GHz', () => {
    const r = rateChannels([], { band: '2.4' });
    assert.ok(byChannel(r, 3).notes.some((n) => n.startsWith('Fora do trio 1, 6 e 11')));
    assert.ok(!byChannel(r, 6).notes.some((n) => n.startsWith('Fora do trio')));
    assert.ok(byChannel(r, 13).notes.some((n) => n.includes('importados')));
    assert.ok(rateChannels([], { band: '2.4', widthMHz: 40 }).every((x) => x.notes.some((n) => n.includes('40 MHz'))));
  });

  test('entradas aleatórias: nunca lança, nota sempre entre 0 e 100, e acrescentar nunca melhora', () => {
    const random = rng(4242);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const randomAp = () => {
      const band = pick(['2.4', '2.4', '5', '5', '6']);
      const ch = band === '2.4' ? 1 + Math.floor(random() * 13) : pick(channelList(band)).channel;
      const frequency = band === '2.4' ? f24(ch) : band === '5' ? f5(ch) : f6(ch);
      const more = { ageMs: Math.floor(random() * 120_000) };
      if (random() < 0.3) more.ies = load(frequency, Math.floor(random() * 12), random());
      return { ...makeAp(freshMac(), `r${ch}`, -30 - Math.floor(random() * 65), frequency, more), channelWidth: pick([0, 0, 1, 2, 3, 4, 5, -1]), centerFreq0: pick([0, 0, frequency + 10, frequency - 10, frequency + 30]) };
    };
    for (let round = 0; round < 40; round++) {
      const base = Array.from({ length: Math.floor(random() * 25) }, randomAp);
      const extra = randomAp();
      for (const [band, widthMHz] of COMBOS) {
        const before = rateChannels(base, { band, widthMHz });
        const after = rateChannels([...base, extra], { band, widthMHz });
        assert.equal(before.length, after.length);
        after.forEach((r, i) => {
          assert.ok(r.score >= 0 && r.score <= 100 && Number.isFinite(r.score));
          assert.ok(r.interferenceDbm === null || Number.isFinite(r.interferenceDbm));
          assert.ok(r.airtime >= 0 && r.airtime <= 1);
          assert.ok(r.score <= before[i].score, `${band} ${widthMHz} bloco ${r.center}: ${before[i].score} -> ${r.score}`);
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('recommendChannel', () => {
  test('prédio, 2,4 GHz: sair do canal 6 dividido com 7 redes', () => {
    const rec = recommendChannel(aptAps, { band: '2.4', own: apt24 });
    assert.deepEqual(Object.keys(rec).sort(), ['best', 'current', 'gain', 'ranking', 'text', 'verdict']);
    assert.equal(rec.current.channel, 6);
    assert.equal(rec.current.coChannel, 7);
    assert.equal(rec.best.channel, 1);
    assert.equal(rec.verdict, 'change');
    assert.equal(rec.gain, Math.round((rec.best.score - rec.current.score) * 10) / 10);
    assert.ok(rec.gain > 8);
    // só os canais padrão entram na lista, do melhor para o pior
    assert.deepEqual(rec.ranking.map((r) => r.channel), [1, 6, 11]);
    assert.equal(rec.ranking[0], rec.best);
    assert.equal(rec.text, 'Seu roteador está no canal 6, que você divide com 7 redes e que ainda recebe interferência de 5 outras. O canal 1 está mais livre.');
    // a nota do canal atual é a mesma de rateChannels sem as redes da casa
    assert.equal(rec.current.score, byChannel(rateChannels(aptAps, { band: '2.4', exclude: ownGroup }), 6).score);
    // largura padrão = a do roteador
    assert.equal(rec.best.widthMHz, 20);
    // funciona igual com a lista crua e com a do ApTracker
    const tracker = new ApTracker();
    tracker.update(apartment);
    const list = tracker.list({ maxAgeMs: 120_000 });
    const viaTracker = recommendChannel(list, { band: '2.4', own: list.find((a) => a.id === apt24.id) });
    assert.equal(viaTracker.text, rec.text);
    assert.equal(recommendChannel(apartment.aps, { band: '2.4', own: apartment.aps[0] }).text, rec.text);
  });

  test('só 1, 6 e 11 são recomendados, mesmo quando um canal do meio tem nota maior', () => {
    // os três canais padrão com 50% de ocupação medida; os canais do meio só "ouvem" ruído
    const busy = [1, 6, 11].map((ch) => n24(ch, -70, { ies: load(f24(ch), 2, 0.5) }));
    const ratings = rateChannels(busy, { band: '2.4' });
    const top = ratings.reduce((a, b) => (b.score > a.score ? b : a));
    assert.ok(![1, 6, 11].includes(top.channel), `melhor nota no canal ${top.channel}`);
    const rec = recommendChannel(busy, { band: '2.4', own: null });
    assert.ok([1, 6, 11].includes(rec.best.channel));
    assert.deepEqual(rec.ranking.map((r) => r.channel).sort((a, b) => a - b), [1, 6, 11]);
    assert.ok(rec.ranking.every((r) => r.recommendable));
  });

  test('ganho pequeno não compensa: fica como está', () => {
    const me = makeAp('02:00:00:00:00:01', 'Minha Casa', -45, 2437);
    // um vizinho com um aparelho só: 5% do tempo
    const light = [me, n24(6, -70, { ies: load(2437, 1, 0.03) })];
    const keep = recommendChannel(light, { band: '2.4', own: normalizeAp(me) });
    assert.equal(keep.current.score, 95);
    near(keep.gain, 5, 0.31, 'ganho'); // o canal 1 não chega a 100: sobra um resto do vizinho do canal 6
    assert.equal(keep.verdict, 'keep');
    assert.equal(keep.text, 'Seu roteador está no canal 6, que você divide com 1 rede. Pode deixar como está.');
    assert.notEqual(keep.best.channel, 6); // o melhor continua sendo informado
    assert.ok(keep.best.score > 99.5);
    // dois vizinhos comuns: 15 pontos de ganho, vale trocar
    const change = recommendChannel([me, n24(6, -70), n24(6, -60)], { band: '2.4', own: normalizeAp(me) });
    assert.equal(change.current.score, 84.6); // 100 · 0,92 · 0,92
    assert.ok(change.gain > 12 && change.gain <= 15.4, `ganho ${change.gain}`);
    assert.equal(change.verdict, 'change');
    assert.match(change.text, /^Seu roteador está no canal 6, que você divide com 2 redes\. O canal (1|11) está mais livre\.$/);
    // canal cheio de verdade: "bem mais livre"
    const crowd = recommendChannel([me, ...[-70, -72, -74, -76, -78].map((l) => n24(6, l))], { band: '2.4', own: normalizeAp(me) });
    assert.ok(crowd.gain >= 25);
    assert.match(crowd.text, /bem mais livre\.$/);
    // sozinho na faixa
    const alone = recommendChannel([me], { band: '2.4', own: normalizeAp(me) });
    assert.equal(alone.verdict, 'keep');
    assert.equal(alone.gain, 0);
    assert.equal(alone.best.channel, 6);
    assert.equal(alone.best, alone.current);
    assert.equal(alone.text, 'Seu roteador está no canal 6, que está livre. Pode deixar como está.');
    // só ruído de canal vizinho
    const noisy = recommendChannel([me, n24(8, -60)], { band: '2.4', own: normalizeAp(me) });
    assert.match(noisy.text, /^Seu roteador está no canal 6, que recebe interferência de 1 rede em canais sobrepostos\./);
    assert.equal(noisy.verdict, 'change');
    assert.equal(noisy.best.channel, 1);
  });

  test('roteador estacionado fora de 1/6/11', () => {
    const me = makeAp('02:00:00:00:00:01', 'Minha Casa', -45, f24(3));
    // faixa vazia: nada a ganhar em nota, mas o canal 3 ocupa dois canais padrão
    const empty = recommendChannel([me], { band: '2.4', own: normalizeAp(me) });
    assert.equal(empty.current.channel, 3);
    assert.equal(empty.current.recommendable, false);
    assert.equal(empty.gain, 0);
    assert.equal(empty.verdict, 'change');
    assert.equal(empty.best.channel, 1);
    assert.equal(empty.text, 'Seu roteador está no canal 3, que fica entre os canais padrão: ali ele atrapalha, e é atrapalhado por, quem usa os canais dos dois lados. Prefira o canal 1.');
    // com um canal padrão claramente melhor, vale a frase normal
    const noisy = recommendChannel([me, n24(1, -55), n24(6, -55)], { band: '2.4', own: normalizeAp(me) });
    assert.equal(noisy.verdict, 'change');
    assert.equal(noisy.best.channel, 11);
    assert.match(noisy.text, /O canal 11 está (bem )?mais livre\.$/);
    // se os canais padrão estão muito piores (todos lotados), não manda trocar
    const jammed = [1, 6, 11].map((ch) => n24(ch, -80, { ies: load(f24(ch), 8, 0.85) }));
    const stay = recommendChannel([me, ...jammed], { band: '2.4', own: normalizeAp(me) });
    assert.ok(stay.gain < -3, `ganho ${stay.gain}`);
    assert.equal(stay.verdict, 'keep');
  });

  test('as outras redes da mesma caixa e os nós do mesmo mesh não contam contra o canal atual', () => {
    const aps = normalizeScan(mesh);
    const own24 = aps.find((a) => a.id === meshTruth.own.b24);
    const own5 = aps.find((a) => a.id === meshTruth.own.b5);
    const rec24 = recommendChannel(aps, { band: '2.4', own: own24 });
    assert.equal(rec24.current.score, 100);
    assert.equal(rec24.current.coChannel, 0);
    assert.equal(rec24.verdict, 'keep');
    // nos 5 GHz o canal 44 tem cinco BSSIDs do próprio mesh (três nós e duas redes ocultas entre eles)
    const rec5 = recommendChannel(aps, { band: '5', own: own5 });
    assert.equal(rec5.current.channel, 44);
    assert.equal(rec5.current.score, 100);
    assert.equal(rec5.current.coChannel, 0);
    assert.equal(rec5.verdict, 'keep');
    // sem saber quem é o usuário, os mesmos nós pesam
    assert.ok(byCenter(rateChannels(aps, { band: '5', widthMHz: 80 }), 42).score < 80);

    // escritório: as três redes do rádio do AP conectado saem da conta; os outros APs, em outros canais, ficam
    const off = normalizeScan(office);
    const rec = recommendChannel(off, { band: '2.4', own: off.find((a) => a.id === officeTruth.own.b24) });
    assert.equal(rec.current.channel, 1);
    assert.equal(rec.current.coChannel, 0);
    assert.ok(rec.current.score > 95);
    assert.equal(rec.verdict, 'keep');
    assert.ok(byChannel(rec.ranking, 6).score < 80); // o AP da sala 2, a impressora e a empresa de baixo
  });

  test('5 GHz: canal comum é preferido ao DFS quando a diferença é de até 5 pontos', () => {
    const light = (ch, center) => n5(ch, -70, CW.W80, center, { ies: encodeIes({ frequency: f5(ch), widthMhz: 80, ht: { nss: 2, width40: true }, vht: { nss: 2 }, bssLoad: { stations: 1, utilization: 0.02 } }) });
    // os dois blocos comuns com um vizinho leve (nota 95); os DFS vazios (nota 100)
    const mild = [light(36, 42), light(149, 155)];
    const rec = recommendChannel(mild, { band: '5', widthMHz: 80 });
    assert.equal(rec.best.score, 95);
    assert.equal(rec.best.dfs, false);
    assert.equal(rec.best.center, 42);
    assert.deepEqual(rec.ranking.slice(0, 2).map((r) => r.center), [42, 155]);
    assert.ok(rec.ranking.slice(2).every((r) => r.dfs && r.score > 99));
    assert.ok(!rec.text.includes('DFS'));
    // com 8 pontos de diferença o DFS vence, e isso é avisado
    const heavier = [n5(36, -70, CW.W80, 42), n5(149, -70, CW.W80, 155)];
    const dfs = recommendChannel(heavier, { band: '5', widthMHz: 80 });
    assert.equal(dfs.best.score, 100);
    assert.equal(dfs.best.dfs, true);
    assert.equal(dfs.best.center, 106); // o 58 fica colado no bloco ocupado e perde alguns décimos
    assert.ok(dfs.best.notes.some((n) => n.startsWith('DFS')));
    assert.equal(dfs.text, 'O canal 100 (80 MHz, DFS) está livre: é a melhor escolha agora.');
    assert.equal(dfs.verdict, 'change');
    // blocos com U-NII-4 nunca entram
    for (const widthMHz of [20, 40, 80, 160]) {
      const all = recommendChannel([], { band: '5', widthMHz });
      assert.ok(all.ranking.length <= 5);
      assert.ok(all.ranking.every((r) => r.recommendable && !r.channels.some((c) => c >= 169)));
      assert.equal(all.best.dfs, widthMHz === 160); // em 160 MHz não há bloco sem DFS
    }
  });

  test('5 GHz: quem já está num canal DFS livre não é mandado embora, e trocar para DFS exige ganho maior', () => {
    const me = { ...makeAp('02:00:00:00:00:01', 'Casa', -50, f5(100)), channelWidth: CW.W80, centerFreq0: f5(106) };
    const stay = recommendChannel([me], { band: '5', own: normalizeAp(me) });
    assert.equal(stay.verdict, 'keep');
    assert.equal(stay.current.dfs, true);
    assert.equal(stay.best.dfs, false); // um canal comum igualmente livre fica como "melhor", mas sem mandar trocar
    assert.equal(stay.gain, 0);
    // roteador no 36 com um vizinho (nota 92): os DFS dão 100, mas 8 − 5 de vantagem não bastam
    const mine = { ...makeAp('02:00:00:00:00:01', 'Casa', -50, f5(36)), channelWidth: CW.W80, centerFreq0: f5(42) };
    const rec = recommendChannel([mine, n5(36, -70, CW.W80, 42), n5(149, -60, CW.W80, 155), n5(157, -60, CW.W80, 155)], { band: '5', own: normalizeAp(mine) });
    assert.equal(rec.current.score, 92);
    assert.equal(rec.best.dfs, true);
    assert.equal(rec.gain, 8);
    assert.equal(rec.verdict, 'keep');
    // prédio: o 36 da casa recebe a rede do vizinho (primário 44) como ruído; fica
    const apt = recommendChannel(aptAps, { band: '5', own: apt5 });
    assert.equal(apt.current.channel, 36);
    assert.equal(apt.current.center, 42);
    assert.equal(apt.current.widthMHz, 80);
    assert.equal(apt.current.overlapping, 1);
    assert.equal(apt.verdict, 'keep');
    assert.match(apt.text, /^Seu roteador está no canal 36 \(80 MHz\), que recebe interferência de 1 rede em canais sobrepostos\./);
  });

  test('6 GHz: só canais PSC são recomendados', () => {
    const psc = new Set(channelList('6').filter((c) => c.psc).map((c) => c.channel));
    for (const widthMHz of [20, 40, 80, 160, 320]) {
      const rec = recommendChannel([], { band: '6', widthMHz });
      assert.ok(rec.best.psc && psc.has(rec.best.channel), `${widthMHz} MHz`);
      assert.ok(rec.ranking.every((r) => r.psc && psc.has(r.channel)));
      assert.equal(rec.best.channel, widthMHz === 320 ? 5 : 5);
    }
    // vizinhos nos primeiros PSC: o recomendado é outro PSC, nunca um canal comum livre ao lado
    const rec = recommendChannel([n6(5, -50), n6(21, -50)], { band: '6', widthMHz: 20 });
    assert.equal(rec.best.channel, 37);
    assert.equal(rec.best.score, 100);
    // roteador num canal fora dos PSC: não é motivo para mandar trocar, mas o melhor é um PSC
    const me = makeAp('02:00:00:00:00:01', 'Casa', -50, f6(9));
    const own = recommendChannel([me], { band: '6', own: normalizeAp(me) });
    assert.equal(own.current.channel, 9);
    assert.equal(own.current.recommendable, false);
    assert.ok(own.best.psc);
    assert.equal(own.verdict, 'keep');
    // casa com Wi-Fi 7 em 320 MHz
    const aps = normalizeScan(wifi7);
    const mine = aps.find((a) => a.id === wifi7Truth.own.b6);
    const home = recommendChannel(aps, { band: '6', own: mine });
    assert.equal(home.current.widthMHz, 320);
    assert.equal(home.current.channel, 37);
    assert.equal(home.current.center, 31); // o bloco que o roteador usa (1–61), não o 33–93
    assert.equal(home.verdict, 'keep');
    assert.equal(home.best.score, 100);
  });

  test('sem o roteador do usuário: só aponta o melhor', () => {
    const empty = recommendChannel([], { band: '2.4' });
    assert.equal(empty.current, null);
    assert.equal(empty.gain, null);
    assert.equal(empty.verdict, 'change');
    assert.equal(empty.best.channel, 1);
    assert.equal(empty.text, 'O canal 1 está livre: é a melhor escolha agora.');
    const apt = recommendChannel(aptAps, { band: '2.4' });
    assert.equal(apt.current, null);
    assert.equal(apt.best.channel, 1);
    assert.match(apt.text, /^O canal 1 é o menos disputado agora \(nota \d+ de 100\)\.$/);
    // larguras padrão sem roteador: 20 MHz em 2,4 GHz e 80 MHz em 5 e 6 GHz
    assert.equal(recommendChannel([], { band: '5' }).best.widthMHz, 80);
    assert.equal(recommendChannel([], { band: '6' }).best.widthMHz, 80);
    // roteador de outra faixa não serve de referência
    const other = recommendChannel(aptAps, { band: '5', own: apt24 });
    assert.equal(other.current, null);
    assert.equal(other.verdict, 'change');
    // roteador num canal que não cabe na largura pedida (165 não tem bloco de 80 MHz comum)
    const edge = makeAp('02:00:00:00:00:01', 'Casa', -50, f5(165));
    const rec = recommendChannel([edge], { band: '5', widthMHz: 80, own: normalizeAp(edge) });
    assert.equal(rec.current.center, 171); // o único bloco de 80 MHz com o 165 é o do U-NII-4
    assert.equal(rec.current.recommendable, false);
  });

  test('2,4 GHz em 40 MHz: o canal atual é o par que o roteador usa', () => {
    const me = { ...makeAp('02:00:00:00:00:01', 'Casa', -50, f24(6)), channelWidth: CW.W40, centerFreq0: f24(8) };
    const rec = recommendChannel([me, n24(11, -60)], { band: '2.4', own: normalizeAp(me) });
    assert.equal(rec.current.widthMHz, 40);
    assert.equal(rec.current.channel, 6);
    assert.equal(rec.current.center, 8); // 6+10, e não 2+6
    assert.equal(rec.current.overlapping, 1);
    assert.match(rec.text, /canal 6 \(40 MHz\)/);
    assert.ok([3, 4].includes(rec.best.center)); // 1+5 ou 2+6: longe do vizinho do canal 11
    assert.ok(rec.ranking.every((r) => [1, 6, 11].includes(r.channel)));
  });

  test('faixa ou largura inválida e lixo', () => {
    for (const options of [undefined, null, {}, { band: 'x' }, { band: '2.4', widthMHz: 80 }, { band: '5', widthMHz: 320 }]) {
      const rec = recommendChannel(aptAps, options);
      assert.equal(rec.best, null);
      assert.equal(rec.current, null);
      assert.deepEqual(rec.ranking, []);
      assert.equal(rec.gain, null);
      assert.equal(rec.verdict, 'keep');
      assert.equal(typeof rec.text, 'string');
    }
    for (const aps of [null, 5, 'x', [null, {}, 3]]) {
      for (const own of [null, undefined, 5, 'x', {}, { bssid: 'zz' }, { bssid: '02:00:00:00:00:01', frequency: 'x' }]) {
        const rec = recommendChannel(aps, { band: '2.4', own });
        assert.ok(['keep', 'change'].includes(rec.verdict));
        assert.equal(rec.best.score, 100);
        assert.ok(rec.text.length > 10);
      }
    }
  });

  test('todos os cenários, todas as faixas: resultado coerente', () => {
    for (const [name, event] of Object.entries(ALL)) {
      const aps = normalizeScan(event);
      for (const [band, key] of [['2.4', 'b24'], ['5', 'b5'], ['6', 'b6']]) {
        const own = aps.find((a) => a.id === TRUTH[name].own[key]) || null;
        const rec = recommendChannel(aps, { band, own });
        const where = `${name} ${band}`;
        assert.ok(rec.best !== null && rec.best.recommendable, where);
        assert.ok(rec.ranking.length >= 1 && rec.ranking.length <= 5, where);
        for (let i = 1; i < rec.ranking.length; i++) {
          const a = rec.ranking[i - 1];
          const b = rec.ranking[i];
          assert.ok(a.score - (a.dfs ? 5 : 0) >= b.score - (b.dfs ? 5 : 0), where);
        }
        assert.ok(/[.!]$/.test(rec.text) && rec.text.split('. ').length <= 3, `${where}: ${rec.text}`);
        if (own) {
          assert.equal(rec.current.channel, own.channel, where);
          assert.equal(rec.gain, Math.round((rec.best.score - rec.current.score) * 10) / 10, where);
          assert.ok(rec.text.startsWith(`Seu roteador está no canal ${own.channel}`), where);
          if (rec.verdict === 'keep') assert.ok(rec.text.includes('deixar como está'), where);
          else assert.ok(rec.text.includes(`canal ${rec.best.channel}`), where);
        } else {
          assert.equal(rec.current, null, where);
          assert.equal(rec.verdict, 'change', where);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('recommendWidth', () => {
  test('2,4 GHz: 20 MHz, a não ser com a faixa praticamente vazia', () => {
    const apt = recommendWidth(aptAps, '2.4', { own: apt24 });
    assert.deepEqual(Object.keys(apt).sort(), ['options', 'text', 'widthMHz']);
    assert.equal(apt.widthMHz, 20);
    assert.equal(apt.text, 'Use 20 MHz: há 21 redes vizinhas em 2,4 GHz e um canal de 40 MHz ocuparia cerca de metade da faixa.');
    assert.deepEqual(apt.options.map((o) => o.widthMHz), [40, 20]);
    assert.ok(apt.options[0].score < apt.options[1].score);
    assert.ok(apt.options.every((o) => [1, 6, 11].includes(o.channel)));

    // sítio: só um vizinho distante
    const quiet = normalizeScan(quietHouse);
    const own = quiet.find((a) => a.id === quietHouseTruth.own.b24);
    const rec = recommendWidth(quiet, '2.4', { own });
    assert.equal(rec.widthMHz, 40);
    assert.equal(rec.text, 'A faixa de 2,4 GHz está praticamente vazia aqui: dá para usar 40 MHz.');
    // sem dizer qual é o roteador da casa, ele conta como vizinho forte
    assert.equal(recommendWidth(quiet, '2.4').widthMHz, 20);
    assert.equal(recommendWidth(quiet, '2.4').text, 'Use 20 MHz: há 2 redes vizinhas em 2,4 GHz e um canal de 40 MHz ocuparia cerca de metade da faixa.');
    // um único vizinho de sinal bom já basta para ficar em 20 MHz
    assert.equal(recommendWidth([n24(6, -65)], '2.4').widthMHz, 20);
    assert.match(recommendWidth([n24(6, -65)], '2.4').text, /há 1 rede vizinha em 2,4 GHz/);
    assert.equal(recommendWidth([], '2.4').widthMHz, 40);
    assert.equal(recommendWidth([n24(11, -88)], '2.4').widthMHz, 40);
  });

  test('5 GHz: a maior largura que ainda tem um bloco com nota boa', () => {
    // vazio: vai até 160 MHz, avisando do DFS
    const empty = recommendWidth([], '5');
    assert.equal(empty.widthMHz, 160);
    assert.deepEqual(empty.options.map((o) => o.widthMHz), [160, 80, 40, 20]);
    // (sem saber qual é o roteador, 160 MHz é uma possibilidade, não uma ordem; e o DFS vem com a consequência)
    assert.equal(
      empty.text,
      'Há espaço para 160 MHz: o bloco do canal 36 está livre o bastante (nota 100 de 100). Só vale se o roteador e os aparelhos aceitarem essa largura. ' +
        'Esse bloco usa canais DFS, divididos com radares: o roteador pode demorar a entrar no ar ou trocar de canal sozinho.',
    );
    // todos os blocos de 160 MHz com 30% de ocupação medida no primário: nota 70 < 80, cai para 80 MHz
    const busy160 = [n5(36, -60, CW.W160, 50, { ies: load(f5(36), 3, 0.3) }), n5(100, -60, CW.W160, 114, { ies: load(f5(100), 3, 0.3) })];
    const r80 = recommendWidth(busy160, '5');
    assert.equal(r80.widthMHz, 80);
    assert.ok(r80.options.find((o) => o.widthMHz === 160).score < 80);
    assert.ok(r80.options.find((o) => o.widthMHz === 80).score >= 70);
    assert.match(r80.text, /^Use 80 MHz: o bloco do canal \d+ está livre o bastante \(nota \d+ de 100\)\./);
    // regra geral: a escolhida é a maior que passa do limite da sua largura
    const need = { 40: 60, 80: 70, 160: 80, 320: 85 };
    for (const event of Object.values(ALL)) {
      for (const band of ['5', '6']) {
        const rec = recommendWidth(normalizeScan(event), band);
        const first = rec.options.find((o) => o.widthMHz > 20 && o.score >= need[o.widthMHz]);
        assert.equal(rec.widthMHz, first ? first.widthMHz : 20);
        for (let i = 1; i < rec.options.length; i++) assert.ok(rec.options[i - 1].widthMHz > rec.options[i].widthMHz);
      }
    }
    // tudo tomado: sobra 20 MHz
    const walls = [];
    for (const c of channelList('5')) walls.push(n5(c.channel, -45, CW.W20, c.channel, { ies: load(c.freq, 9, 0.7) }));
    const jam = recommendWidth(walls, '5');
    assert.equal(jam.widthMHz, 20);
    assert.equal(jam.text, 'Use 20 MHz: há 28 redes vizinhas em 5 GHz e os canais mais largos pegariam interferência demais.');
  });

  test('a geração do roteador limita a largura', () => {
    const router = (wifiStandard) => normalizeAp({ ...makeAp('02:00:00:00:00:01', 'Casa', -50, f5(36)), wifiStandard });
    assert.equal(recommendWidth([], '5', { own: router(4) }).widthMHz, 40); // 11n
    assert.equal(recommendWidth([], '5', { own: router(5) }).widthMHz, 160);
    assert.equal(recommendWidth([], '5', { own: router(6) }).widthMHz, 160);
    const six = (wifiStandard) => normalizeAp({ ...makeAp('02:00:00:00:00:01', 'Casa', -50, f6(37)), wifiStandard });
    assert.equal(recommendWidth([], '6', { own: six(6) }).widthMHz, 160);
    assert.equal(recommendWidth([], '6', { own: six(8) }).widthMHz, 320);
    assert.equal(recommendWidth([], '6').widthMHz, 320);
    assert.deepEqual(recommendWidth([], '6').options.map((o) => o.widthMHz), [320, 160, 80, 40, 20]);
    assert.ok(recommendWidth([], '6').options.every((o) => !o.dfs));
    assert.ok(!recommendWidth([], '6').text.includes('DFS'));
    // o roteador do usuário não conta como vizinho
    const mine = normalizeScan(wifi7).find((a) => a.id === wifi7Truth.own.b6);
    assert.equal(recommendWidth(normalizeScan(wifi7), '6', { own: mine }).widthMHz, 320);
  });

  test('faixa desconhecida e lixo', () => {
    for (const band of [null, undefined, '60', 'x', {}]) {
      assert.deepEqual(recommendWidth(aptAps, band), { widthMHz: null, text: 'Faixa desconhecida.', options: [] });
    }
    for (const aps of [null, 5, 'x', [null, {}, 3]]) {
      for (const options of [undefined, null, 5, { own: 'x' }, { own: {} }]) assert.equal(recommendWidth(aps, '2.4', options).widthMHz, 40);
    }
  });
});

// ---------------------------------------------------------------------------

describe('channelGraph', () => {
  test('2,4 GHz do prédio: eixos, marcas e uma forma por rede', () => {
    const g = channelGraph(aptAps, '2.4');
    assert.deepEqual(Object.keys(g).sort(), ['band', 'maxDbm', 'maxFreq', 'minDbm', 'minFreq', 'sections', 'shapes', 'ticks']);
    assert.equal(g.band, '2.4');
    assert.equal(g.minFreq, 2400);
    assert.equal(g.maxFreq, 2484);
    assert.equal(g.minDbm, -100);
    assert.equal(g.maxDbm, -30);
    assert.deepEqual(g.sections, [{ minFreq: 2400, maxFreq: 2484 }]);
    assert.deepEqual(g.ticks.map((t) => t.channel), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    assert.deepEqual(g.ticks.map((t) => t.freq), g.ticks.map((t) => f24(t.channel)));
    assert.equal(g.shapes.length, 22);
    // do mais fraco para o mais forte (ordem de desenho)
    for (let i = 1; i < g.shapes.length; i++) assert.ok(g.shapes[i - 1].rssi <= g.shapes[i].rssi);
    const own = g.shapes[g.shapes.length - 1];
    assert.deepEqual(Object.keys(own).sort(), ['approx', 'bssid', 'centerFreq', 'channel', 'hi', 'hidden', 'lo', 'points', 'rssi', 'ssid', 'widthMHz']);
    assert.equal(own.bssid, apartmentTruth.own.b24);
    assert.equal(own.ssid, 'Familia Souza');
    assert.equal(own.rssi, -48);
    assert.equal(own.channel, 6);
    assert.deepEqual([own.lo, own.hi, own.centerFreq, own.widthMHz], [2427, 2447, 2437, 20]);
    // máscara de 20 MHz: plano até ±9 MHz; -20 dB em ±11; -28 dB em ±20; -40 dB em ±30; depois segue caindo até o piso
    assert.deepEqual(own.points, [
      [2397, -100],
      [2407, -88],
      [2417, -76],
      [2426, -68],
      [2428, -48],
      [2446, -48],
      [2448, -68],
      [2457, -76],
      [2467, -88],
      [2477, -100],
    ]);
    assert.equal(g.shapes.find((s) => s.hidden).ssid, '(rede oculta)');
  });

  test('toda forma é simétrica, começa e termina no piso e nunca passa do sinal', () => {
    for (const event of Object.values(ALL)) {
      for (const band of ['2.4', '5', '6']) {
        const g = channelGraph(normalizeScan(event), band);
        for (const s of g.shapes) {
          const pts = s.points;
          assert.ok(pts.length >= 4, s.bssid);
          assert.equal(pts[0][1], g.minDbm);
          assert.equal(pts[pts.length - 1][1], g.minDbm);
          for (let i = 1; i < pts.length; i++) assert.ok(pts[i][0] > pts[i - 1][0], 'frequência crescente');
          for (let i = 0; i < pts.length; i++) {
            const mirror = pts[pts.length - 1 - i];
            near(pts[i][0] - s.centerFreq, s.centerFreq - mirror[0], 0.11, 'simetria');
            assert.equal(pts[i][1], mirror[1]);
            assert.ok(pts[i][1] <= s.rssi && pts[i][1] >= g.minDbm);
          }
          // o topo plano tem a largura do canal menos 1 MHz de cada lado
          const top = pts.filter((p) => p[1] === s.rssi);
          assert.equal(top.length, 2);
          assert.equal(top[1][0] - top[0][0], s.hi - s.lo - 2);
          assert.ok(s.rssi <= g.maxDbm);
          assert.ok(s.lo >= g.minFreq && s.hi <= g.maxFreq);
        }
      }
    }
  });

  test('larguras maiores: 40 MHz em 2,4 GHz, 80 MHz em 5 GHz, 320 MHz em 6 GHz', () => {
    const net = channelGraph(aptAps, '2.4').shapes.find((s) => s.ssid === 'NET_2GD4E5F6');
    assert.deepEqual([net.lo, net.hi, net.centerFreq, net.widthMHz, net.channel], [2402, 2442, 2422, 40, 1]);
    // 40 MHz: plano até ±19; -20 dB em ±21; -28 dB em ±40
    assert.deepEqual(net.points.slice(1, 7), [[2382, -95], [2401, -87], [2403, -67], [2441, -67], [2443, -87], [2462, -95]]);
    assert.equal(net.points.length, 8);

    const g5 = channelGraph(aptAps, '5');
    assert.equal(g5.minFreq, 5150);
    assert.equal(g5.maxFreq, 5850);
    assert.deepEqual(g5.sections, [{ minFreq: 5150, maxFreq: 5350 }, { minFreq: 5470, maxFreq: 5730 }, { minFreq: 5730, maxFreq: 5850 }]);
    assert.deepEqual(g5.ticks.map((t) => t.channel), [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165]);
    assert.deepEqual(g5.ticks.filter((t) => t.dfs).map((t) => t.channel), [52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144]);
    assert.equal(g5.shapes.length, 6);
    const mine = g5.shapes.find((s) => s.bssid === apartmentTruth.own.b5);
    assert.deepEqual([mine.lo, mine.hi, mine.centerFreq, mine.channel], [5170, 5250, 5210, 36]);
    assert.deepEqual(mine.points.slice(3, 7), [[5169, -75], [5171, -55], [5249, -55], [5251, -75]]);

    const g6 = channelGraph(normalizeScan(wifi7), '6');
    assert.equal(g6.minFreq, 5925);
    assert.equal(g6.maxFreq, 7125);
    assert.equal(g6.ticks.length, 59);
    assert.equal(g6.ticks.filter((t) => t.psc).length, 15);
    assert.deepEqual(g6.shapes.map((s) => s.hi - s.lo), [80, 160, 320]);
  });

  test('canal 14, U-NII-4, 80+80 e sinais fora da escala', () => {
    const japan = channelGraph([makeAp('02:00:00:00:00:01', 'JP', -60, 2484)], '2.4');
    assert.equal(japan.maxFreq, 2494);
    assert.equal(japan.ticks[japan.ticks.length - 1].channel, 14);
    const unii4 = channelGraph([n5(173, -60)], '5');
    assert.equal(unii4.maxFreq, 5875);
    assert.deepEqual(unii4.ticks.slice(-2).map((t) => t.channel), [169, 173]);
    assert.equal(unii4.sections[2].maxFreq, 5875);
    // 80+80 MHz: dois trechos, duas formas do mesmo BSSID
    const split = { ...makeAp('02:00:00:00:00:02', 'dois', -55, f5(36)), channelWidth: CW.W80P80, centerFreq0: f5(42), centerFreq1: f5(155) };
    const both = channelGraph([split], '5').shapes;
    assert.equal(both.length, 2);
    assert.deepEqual(both.map((s) => [s.lo, s.hi]).sort((a, b) => a[0] - b[0]), [[5170, 5250], [5735, 5815]]);
    assert.ok(both.every((s) => s.bssid === '02:00:00:00:00:02' && s.widthMHz === 160));
    // sinal abaixo do piso: uma linha no piso; sinal muito forte: o topo do gráfico sobe
    const faint = channelGraph([makeAp('02:00:00:00:00:03', 'longe', -104, 2437)], '2.4').shapes[0];
    assert.deepEqual(faint.points, [[2428, -100], [2446, -100]]);
    assert.equal(channelGraph([makeAp('02:00:00:00:00:04', 'colado', -22, 2437)], '2.4').maxDbm, -10);
    // 40 MHz sem saber o lado do canal secundário: a faixa presumida é marcada como aproximada
    const unsure = channelGraph([{ ...makeAp('02:00:00:00:00:05', 'x', -60, 2437), channelWidth: CW.W40 }], '2.4').shapes[0];
    assert.equal(unsure.approx, true);
    assert.deepEqual([unsure.lo, unsure.hi], [2407, 2467]);
  });

  test('faixa vazia, faixa inválida e lixo', () => {
    const empty = channelGraph([], '5');
    assert.deepEqual(empty.shapes, []);
    assert.equal(empty.ticks.length, 25);
    assert.equal(empty.maxDbm, -30);
    for (const band of [null, undefined, '60', 'x', 7]) {
      assert.deepEqual(channelGraph(aptAps, band), { band: null, minFreq: 0, maxFreq: 0, minDbm: -100, maxDbm: -20, sections: [], ticks: [], shapes: [] });
    }
    for (const aps of [null, 5, 'x', [null, {}, 3, { bssid: 'zz', level: 'x', frequency: 2437 }, { level: -50, frequency: 2437 }]]) {
      const g = channelGraph(aps, '2.4');
      assert.equal(g.ticks.length, 13);
      assert.ok(g.shapes.length <= 1);
    }
  });
});
