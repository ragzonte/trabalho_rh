// Testes de app/js/core/best-network.js: nota de um AP, ranking das redes e o conselho.
//
// Os números esperados saem de primeiros princípios (taxas do 802.11 e os pesos exportados pelo
// módulo), não de uma execução anterior.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreAp,
  rankNetworks,
  advise,
  clientProfile,
  scoringContext,
  speedScore,
  signalCap,
  isInsecure,
  formatSpeed,
  formatGain,
  formatDbm,
  timesMore,
  SPEED_GOOD_MBPS,
  SPEED_GOOD_SCORE,
  SPEED_TOP_MBPS,
  SIGNAL_FREE_DBM,
  WEAK_SIGNAL_DBM,
  WEAK_SIGNAL_CAP,
  INSECURE_FACTOR,
  WEAK_SECURITY_FACTOR,
  WPA3_BONUS,
  SWITCH_MIN_POINTS,
  ROAM_MIN_DB,
} from '../app/js/core/best-network.js';
import { estimateLink, usableMbps } from '../app/js/core/phy.js';
import { normalizeScan, normalizeAp, ssidStem } from '../app/js/core/model.js';
import { rateChannels } from '../app/js/core/channel-rating.js';
import { encodeIes } from '../app/js/core/ies.js';
import { ALL, TRUTH, TS, CW, apartment, quietHouse, mesh, office, wifi7, makeAp, withAps } from './fixtures/scans.mjs';

// --- celulares de teste (DeviceInfo de bridge.js)
const PHONE = { platform: 'android', sdk: 34, bands: { b24: true, b5: true, b6: false, b60: false }, standards: [1, 4, 5, 6], rtt: false };
const PHONE_24 = { platform: 'android', sdk: 29, bands: { b24: true, b5: false, b6: false, b60: false }, standards: [], rtt: false };
const FLAGSHIP = { platform: 'android', sdk: 35, bands: { b24: true, b5: true, b6: true, b60: false }, standards: [1, 4, 5, 6, 8], rtt: true };

const SEC = {
  wpa2: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]',
  wpa3: '[RSN-SAE-CCMP][ESS][MFPR][MFPC]',
  open: '[ESS]',
  wep: '[WEP][ESS]',
  tkip: '[WPA-PSK-TKIP][ESS]',
};

const scan = (aps, ts = TS) => ({ ts, fresh: true, source: 'request', aps });
const norm = (event) => normalizeScan(event, { sdk: 34 });
const byId = (aps, id) => aps.find((ap) => ap.id === id);
const rowOf = (ranking, ssid) => ranking.find((row) => row.ssid === ssid);

/** Um AP sozinho no mundo, em 2,4 GHz canal 6, Wi-Fi 4, sem WPS. */
const lone = (more = {}) => makeAp('00:11:22:33:44:55', 'Sozinha', -50, 2437, { wifiStandard: 4, capabilities: SEC.wpa2, ...more });

const KINDS = ['ok', 'switch-band', 'switch-ap', 'switch-network', 'no-connection'];

function assertScoreShape(result, label = '') {
  assert.ok(Number.isFinite(result.score) && result.score >= 0 && result.score <= 100, `${label} score ${result.score}`);
  assert.ok(result.estMbps === null || (Number.isFinite(result.estMbps) && result.estMbps >= 0), `${label} estMbps ${result.estMbps}`);
  for (const key of ['signal', 'speed', 'congestion', 'security']) {
    const v = result.parts[key];
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, `${label} parts.${key} = ${v}`);
  }
  for (const list of [result.pros, result.cons, result.warnings]) {
    assert.ok(Array.isArray(list));
    for (const text of list) {
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0);
      assert.doesNotMatch(text, /undefined|NaN|null|\[object/);
    }
  }
}

// ---------------------------------------------------------------------------
describe('formatadores', () => {
  test('formatSpeed usa vírgula e dois algarismos significativos', () => {
    assert.equal(formatSpeed(7.46), '7,5 Mb/s');
    assert.equal(formatSpeed(3), '3 Mb/s');
    assert.equal(formatSpeed(57.1), '57 Mb/s');
    assert.equal(formatSpeed(286), '290 Mb/s');
    assert.equal(formatSpeed(454.1), '450 Mb/s');
    assert.equal(formatSpeed(1134), '1,1 Gb/s');
    assert.equal(formatSpeed(996), '1 Gb/s');
    assert.equal(formatSpeed(NaN), '—');
    assert.equal(formatSpeed(-1), '—');
  });

  test('formatGain, timesMore e formatDbm', () => {
    assert.equal(formatGain(2.34), '2,3x');
    assert.equal(formatGain(2), '2x');
    assert.equal(formatGain(14.2), '14x');
    assert.equal(formatGain(0), '—');
    assert.equal(timesMore(2.34), 'cerca de 2,3x mais');
    assert.equal(timesMore(206), 'pelo menos 10x mais');
    assert.equal(formatDbm(-57.2), '−57 dBm');
    assert.equal(formatDbm(undefined), '—');
  });
});

// ---------------------------------------------------------------------------
describe('clientProfile', () => {
  test('sem informação: um celular comum de 2 fluxos, 20/80/160 MHz, que aceita qualquer faixa', () => {
    for (const device of [undefined, null, {}, 'x', 7, { bands: 'sim', standards: 'todos' }]) {
      const c = clientProfile(device);
      assert.equal(c.gen, null);
      assert.equal(c.nss, 2);
      assert.deepEqual(c.maxWidthMHz, { '2.4': 20, 5: 80, 6: 160 });
      for (const band of ['2.4', '5', '6', '60', null]) assert.equal(c.supports(band), true);
    }
  });

  test('a geração vem de WIFI_STANDARD_* (8 = Wi-Fi 7; 7 é o 802.11ad e não conta)', () => {
    assert.equal(clientProfile({ standards: [1, 4] }).gen, 4);
    assert.equal(clientProfile({ standards: [1, 4, 5] }).gen, 5);
    assert.equal(clientProfile(PHONE).gen, 6);
    assert.equal(clientProfile({ standards: [4, 5, 6, 7] }).gen, 6);
    assert.equal(clientProfile(FLAGSHIP).gen, 7);
    assert.equal(clientProfile({ standards: [] }).gen, null);
    assert.equal(clientProfile({ standards: [99, 'x', null] }).gen, null);
  });

  test('larguras: 6E/7 chegam a 160 MHz em 5 GHz; só o Wi-Fi 7 usa 320 MHz', () => {
    assert.deepEqual(clientProfile(PHONE).maxWidthMHz, { '2.4': 20, 5: 80, 6: 160 });
    assert.deepEqual(clientProfile({ bands: { b6: true }, standards: [4, 5, 6] }).maxWidthMHz, { '2.4': 20, 5: 160, 6: 160 });
    assert.deepEqual(clientProfile(FLAGSHIP).maxWidthMHz, { '2.4': 20, 5: 160, 6: 320 });
  });

  test('supports só nega o que se sabe que o celular não faz', () => {
    const only24 = clientProfile(PHONE_24);
    assert.equal(only24.supports('2.4'), true);
    assert.equal(only24.supports('5'), false);
    assert.equal(only24.supports('6'), false);
    assert.equal(clientProfile(PHONE).supports('5'), true);
    assert.equal(clientProfile(PHONE).supports('6'), false);
    // celular Wi-Fi 5 não entra em 6 GHz, mesmo sem a lista de faixas
    assert.equal(clientProfile({ standards: [4, 5] }).supports('6'), false);
    // quem usa 6 GHz fala pelo menos Wi-Fi 6, mesmo com a lista de padrões incompleta
    assert.equal(clientProfile({ bands: { b6: true }, standards: [4, 5] }).gen, 6);
    assert.equal(clientProfile({ bands: { b6: true }, standards: [4, 5] }).supports('6'), true);
  });
});

// ---------------------------------------------------------------------------
describe('speedScore e signalCap', () => {
  test('âncoras: 20 Mb/s = 60, 400 Mb/s ou mais = 100, nada = 0', () => {
    assert.equal(SPEED_GOOD_MBPS, 20);
    assert.equal(SPEED_GOOD_SCORE, 60);
    assert.equal(SPEED_TOP_MBPS, 400);
    assert.ok(Math.abs(speedScore(20) - 60) < 1e-9);
    assert.ok(Math.abs(speedScore(400) - 100) < 1e-9);
    assert.equal(speedScore(5000), 100);
    for (const bad of [0, -3, NaN, null, undefined, '20', Infinity]) assert.equal(speedScore(bad), 0);
  });

  test('é logarítmica: dobrar a velocidade vale sempre os mesmos pontos', () => {
    const step = speedScore(40) - speedScore(20);
    assert.ok(step > 8 && step < 11, `passo ${step}`);
    for (const mbps of [1, 3, 10, 25, 80, 150]) assert.ok(Math.abs(speedScore(2 * mbps) - speedScore(mbps) - step) < 1e-9);
    // 500 Mb/s não é 25 vezes melhor que 20 Mb/s para uma pessoa
    assert.ok(speedScore(500) / speedScore(20) < 1.7);
  });

  test('speedScore não diminui com a velocidade', () => {
    let prev = -1;
    for (let mbps = 0.05; mbps < 3000; mbps *= 1.3) {
      const s = speedScore(mbps);
      assert.ok(s >= prev && s >= 0 && s <= 100);
      prev = s;
    }
  });

  test('teto por sinal: livre até −70, 35 em −80, 5 de −90 para baixo, sem degraus', () => {
    assert.equal(SIGNAL_FREE_DBM, -70);
    assert.equal(WEAK_SIGNAL_DBM, -80);
    assert.equal(signalCap(-40), 100);
    assert.equal(signalCap(-70), 100);
    assert.equal(signalCap(-80), WEAK_SIGNAL_CAP);
    assert.equal(signalCap(-75), (100 + WEAK_SIGNAL_CAP) / 2);
    assert.equal(signalCap(-90), 5);
    assert.equal(signalCap(-120), 5);
    assert.equal(signalCap(null), 0);
    assert.equal(signalCap(NaN), 0);
    let prev = signalCap(-100.5);
    for (let rssi = -100; rssi <= -40; rssi += 0.5) {
      const cap = signalCap(rssi);
      assert.ok(cap >= prev, `teto caiu em ${rssi}`);
      assert.ok(cap - prev <= 4, `degrau em ${rssi}`);
      prev = cap;
    }
  });
});

// ---------------------------------------------------------------------------
describe('scoreAp: a conta', () => {
  test('AP sozinho, Wi-Fi 4 em 20 MHz com sinal de sobra: 144,4 Mb/s de taxa, 79,7 Mb/s reais, nota 78,5', () => {
    // 802.11n, 20 MHz, 2 fluxos, MCS 7, guarda curta = 144,4 Mb/s; 60% disso é dado útil (86,6);
    // sem vizinhos sobra 92% do tempo de ar (o rádio "padrão" ocupa 8%): 86,6 × 0,92 = 79,7.
    const aps = norm(scan([lone()]));
    const r = scoreAp(aps[0], { aps, device: PHONE });
    assert.equal(r.detail.phyMbps, 144.4);
    assert.equal(r.detail.linkMbps, 86.6);
    assert.equal(r.detail.share, 0.92);
    assert.equal(r.estMbps, 79.7);
    assert.equal(r.score, Math.round(speedScore(79.7) * 10) / 10);
    assert.equal(r.score, 78.5);
    assert.deepEqual(r.parts, { signal: 100, speed: Math.round(speedScore(86.6)), congestion: 92, security: 80 });
    assert.equal(r.detail.usable, true);
    assertScoreShape(r);
  });

  test('estMbps = usableMbps(estimateLink().phyMbps) × fração do tempo de ar, em todas as redes dos cenários', () => {
    for (const [name, event] of Object.entries(ALL)) {
      const aps = norm(event);
      const client = clientProfile(PHONE);
      for (const ap of aps) {
        const r = scoreAp(ap, { aps, device: PHONE });
        assertScoreShape(r, `${name} ${ap.id}`);
        if (!client.supports(ap.band)) {
          assert.equal(r.estMbps, 0);
          assert.equal(r.score, 0);
          continue;
        }
        const link = estimateLink({
          rssi: ap.rssi,
          band: ap.band,
          widthMHz: ap.widthMHz,
          apGen: ap.gen,
          apNss: ap.nss ?? undefined,
          clientGen: 6,
          clientNss: 2,
          clientMaxWidthMHz: client.maxWidthMHz[ap.band],
        });
        assert.equal(r.detail.phyMbps, link.phyMbps, `${name} ${ap.id}`);
        assert.equal(r.detail.linkMbps, usableMbps(link.phyMbps));
        assert.ok(r.detail.share > 0 && r.detail.share <= 1);
        // share sai arredondado a 3 casas em detail: tolera esse arredondamento
        assert.ok(Math.abs(r.estMbps - r.detail.linkMbps * r.detail.share) <= 0.05 + r.detail.linkMbps * 0.0005, `${name} ${ap.id}`);
        assert.ok(r.estMbps <= r.detail.linkMbps);
      }
    }
  });

  test('a carga do próprio AP usa o mesmo ciclo de trabalho de channel-rating.js', () => {
    // Visto como vizinho, um rádio sozinho no canal 6 deixa a nota do canal em 100·(1 − ciclo).
    // Visto por dentro, a fração que sobra para o celular tem de ser a mesma.
    const cases = [
      undefined, // não informa nada: 8%
      { stations: 0, utilization: 0 }, // só beacons: 2%
      { stations: 4, utilization: 0 }, // 2% + 4 × 3%
      { stations: 9, utilization: 0.1 },
      { stations: 40, utilization: 0 }, // teto de 50%
    ];
    for (const bssLoad of cases) {
      const ies = bssLoad ? encodeIes({ frequency: 2437, widthMhz: 20, bssLoad, ht: { nss: 2, width40: false } }) : undefined;
      const aps = norm(scan([lone(ies ? { ies } : {})]));
      const seenFromOutside = rateChannels(aps, { band: '2.4', widthMHz: 20 }).find((r) => r.channel === 6).score / 100;
      const seenFromInside = scoreAp(aps[0], { aps, device: PHONE }).detail.share;
      assert.ok(Math.abs(seenFromInside - seenFromOutside) < 0.0011, `${JSON.stringify(bssLoad)}: ${seenFromInside} x ${seenFromOutside}`);
    }
  });

  test('as redes do mesmo rádio somam os aparelhos (principal + convidados)', () => {
    const ies = (stations) => encodeIes({ frequency: 2437, widthMhz: 20, bssLoad: { stations, utilization: 0 }, ht: { nss: 2, width40: false } });
    const main = makeAp('00:11:22:33:44:50', 'Casa', -50, 2437, { wifiStandard: 4, capabilities: SEC.wpa2, ies: ies(5) });
    const guest = makeAp('00:11:22:33:44:51', 'Casa-Convidados', -50, 2437, { wifiStandard: 4, capabilities: SEC.wpa2, ies: ies(3) });
    const aps = norm(scan([main, guest]));
    const r = scoreAp(byId(aps, main.bssid), { aps, device: PHONE });
    assert.equal(r.detail.stations, 8);
    // 2% + 8 × 3% + 1,5% pela rede extra
    assert.equal(r.detail.share, 0.725);
    // e a ocupação medida por qualquer rede do rádio vale para todas (o canal é o mesmo)
    const busyGuest = { ...guest, ies: encodeIes({ frequency: 2437, widthMhz: 20, bssLoad: { stations: 3, utilization: 0.8 }, ht: { nss: 2, width40: false } }) };
    const aps2 = norm(scan([main, busyGuest]));
    const r2 = scoreAp(byId(aps2, main.bssid), { aps: aps2, device: PHONE });
    assert.ok(Math.abs(r2.detail.share - 0.2) < 0.005, `share ${r2.detail.share}`);
  });

  test('canal 100% ocupado ainda deixa uma fresta (o CSMA/CA sempre dá a vez): a fração nunca zera', () => {
    const ies = encodeIes({ frequency: 2437, widthMhz: 20, bssLoad: { stations: 50, utilization: 1 }, ht: { nss: 2, width40: false } });
    const aps = norm(scan([lone({ ies })]));
    const r = scoreAp(aps[0], { aps, device: PHONE });
    assert.equal(r.detail.share, 0.05);
    assert.ok(r.estMbps > 0);
    assert.equal(r.detail.usable, true);
    assert.equal(r.parts.congestion, 5);
  });

  test('vizinhos no mesmo canal tiram tempo de ar; cada um a mais nunca melhora a estimativa', () => {
    let event = scan([lone()]);
    let prev = scoreAp(norm(event)[0], { aps: norm(event), device: PHONE });
    for (let i = 0; i < 6; i++) {
      event = withAps(event, [makeAp(`00:aa:bb:cc:0${i}:01`, `Vizinho ${i}`, -55 - i * 4, 2437, { wifiStandard: 4 })]);
      const aps = norm(event);
      const r = scoreAp(byId(aps, '00:11:22:33:44:55'), { aps, device: PHONE });
      assert.ok(r.estMbps < prev.estMbps, `vizinho ${i}: ${r.estMbps} >= ${prev.estMbps}`);
      assert.ok(r.parts.congestion < prev.parts.congestion);
      assert.ok(r.score <= prev.score);
      assert.equal(r.detail.coChannel, i + 1);
      assert.equal(r.detail.phyMbps, 144.4); // o enlace em si não muda
      prev = r;
    }
    assert.ok(prev.cons.some((c) => /Divide o canal com 6 redes/.test(c)), prev.cons.join(' | '));
  });

  test('vizinho em canal sobreposto também custa (ruído), mesmo sem dividir o canal', () => {
    const base = norm(scan([lone()]));
    const noisy = norm(scan([lone(), makeAp('00:aa:bb:cc:dd:01', 'No canal 4', -45, 2427, { wifiStandard: 4 })]));
    const a = scoreAp(base[0], { aps: base, device: PHONE });
    const b = scoreAp(byId(noisy, '00:11:22:33:44:55'), { aps: noisy, device: PHONE });
    assert.ok(b.estMbps < a.estMbps * 0.9);
    assert.equal(b.detail.coChannel, 0);
    assert.equal(b.detail.overlapping, 1);
  });

  test('ocupação medida pelo AP (BSS Load) vale quando passa do modelo', () => {
    const ies = (utilization) => encodeIes({ frequency: 2437, widthMhz: 20, bssLoad: { stations: 1, utilization }, ht: { nss: 2, width40: false } });
    const quiet = norm(scan([lone({ ies: ies(0.02) })]));
    const busy = norm(scan([lone({ ies: ies(0.7) })]));
    const q = scoreAp(quiet[0], { aps: quiet, device: PHONE });
    const b = scoreAp(busy[0], { aps: busy, device: PHONE });
    assert.equal(q.detail.share, 0.95); // 2% + 1 × 3% do modelo, maior que os 2% medidos
    assert.ok(Math.abs(b.detail.share - 0.3) < 0.005, `share ${b.detail.share}`); // 1 − 0,70 (o elemento guarda em passos de 1/255)
    assert.ok(b.estMbps < q.estMbps * 0.4);
    assert.ok(b.cons.some((c) => /Canal ocupado 70% do tempo/.test(c)), b.cons.join(' | '));
    assert.ok(q.pros.includes('Canal livre'));
  });

  test('conectado no AP: a ocupação medida (que inclui o próprio celular) é ignorada e o celular não conta como concorrente', () => {
    const ies = encodeIes({ frequency: 2437, widthMhz: 20, bssLoad: { stations: 3, utilization: 0.7 }, ht: { nss: 2, width40: false } });
    const aps = norm(scan([lone({ ies })]));
    const away = scoreAp(aps[0], { aps, device: PHONE });
    const here = scoreAp(aps[0], { aps, device: PHONE, connectionBssid: aps[0].id });
    assert.ok(Math.abs(away.detail.share - 0.3) < 0.005);
    assert.equal(here.detail.share, 0.92); // 2% + 2 × 3%: os outros dois aparelhos
    assert.ok(here.estMbps > away.estMbps * 2);
    // maiúsculas e hífen no BSSID da conexão também servem
    const upper = scoreAp(aps[0], { aps, device: PHONE, connectionBssid: aps[0].id.toUpperCase().replace(/:/g, '-') });
    assert.equal(upper.estMbps, here.estMbps);
  });

  test('conectado em OUTRO AP do mesmo canal: a medição também é descartada (é o tráfego do próprio celular)', () => {
    const ies = encodeIes({ frequency: 2437, widthMhz: 20, bssLoad: { stations: 0, utilization: 0.7 }, ht: { nss: 2, width40: false } });
    const mine = makeAp('00:aa:bb:cc:dd:01', 'Minha', -50, 2437, { wifiStandard: 4 });
    const aps = norm(scan([lone({ ies }), mine]));
    const target = byId(aps, '00:11:22:33:44:55');
    const elsewhere = scoreAp(target, { aps, device: PHONE });
    const sameChannel = scoreAp(target, { aps, device: PHONE, connectionBssid: mine.bssid });
    assert.ok(sameChannel.detail.share > elsewhere.detail.share + 0.3);
    assert.equal(sameChannel.detail.utilization, elsewhere.detail.utilization); // o dado continua em detail
  });
});

// ---------------------------------------------------------------------------
describe('scoreAp: sinal', () => {
  test('sinal mais forte nunca dá nota menor', () => {
    let prev = null;
    for (let level = -98; level <= -35; level++) {
      const aps = norm(scan([lone({ level })]));
      const r = scoreAp(aps[0], { aps, device: PHONE });
      assertScoreShape(r, `${level} dBm`);
      if (prev !== null) {
        assert.ok(r.score >= prev.score, `${level} dBm: ${r.score} < ${prev.score}`);
        assert.ok(r.estMbps >= prev.estMbps);
        assert.ok(r.parts.signal >= prev.parts.signal);
      }
      prev = r;
    }
  });

  test('sinal inutilizável (abaixo de −80 dBm) limita a nota, por mais rápida que a conta dê', () => {
    // 5 GHz em 80 MHz a −82 dBm: a taxa mínima do Wi-Fi 6 ainda dá dezenas de Mb/s no papel
    const far = makeAp('00:11:22:33:44:55', 'Longe', -82, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6, capabilities: SEC.wpa2 });
    const aps = norm(scan([far]));
    const r = scoreAp(aps[0], { aps, device: PHONE });
    assert.ok(r.estMbps > SPEED_GOOD_MBPS, `estMbps ${r.estMbps}`);
    assert.ok(speedScore(r.estMbps) > 60);
    assert.ok(r.score <= WEAK_SIGNAL_CAP, `nota ${r.score}`);
    assert.equal(r.score, Math.round(signalCap(-82) * 10) / 10);
    assert.ok(r.cons.includes('Sinal fraco aqui'));
    assert.ok(r.warnings.some((w) => /Sinal no limite/.test(w)));
  });

  test('uma rede a −85 dBm perde para a mesma rede a −65 dBm, e não ganha de uma rede modesta com sinal bom', () => {
    const weak5 = makeAp('00:11:22:33:44:01', 'Rapida longe', -85, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6 });
    const good24 = makeAp('00:11:22:33:44:02', 'Modesta perto', -60, 2462, { wifiStandard: 4 });
    const aps = norm(scan([weak5, good24]));
    const a = scoreAp(byId(aps, weak5.bssid), { aps, device: PHONE });
    const b = scoreAp(byId(aps, good24.bssid), { aps, device: PHONE });
    assert.ok(b.score > a.score + 30, `${b.score} x ${a.score}`);
  });

  test('usa o sinal suavizado do ApTracker quando existe', () => {
    const aps = norm(scan([lone({ level: -85 })]));
    const smooth = { ...aps[0], rssiSmooth: -55 };
    const r = scoreAp(smooth, { aps: [smooth], device: PHONE });
    assert.equal(r.detail.rssi, -55);
    assert.equal(r.detail.phyMbps, 144.4);
  });

  test('leitura velha ganha um aviso', () => {
    const aps = norm(scan([lone({ ageMs: 45_000 })]));
    const r = scoreAp(aps[0], { aps, device: PHONE });
    assert.ok(r.warnings.some((w) => /última|últimas buscas/.test(w)), r.warnings.join(' | '));
    const fresh = norm(scan([lone()]));
    assert.equal(scoreAp(fresh[0], { aps: fresh, device: PHONE }).warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('scoreAp: segurança', () => {
  const scoreWith = (capabilities, more = {}) => {
    const aps = norm(scan([lone({ capabilities, ...more })]));
    return scoreAp(aps[0], { aps, device: PHONE });
  };

  test('rede aberta: metade da nota, aviso e contra', () => {
    const safe = scoreWith(SEC.wpa2);
    const open = scoreWith(SEC.open);
    assert.equal(open.estMbps, safe.estMbps); // a velocidade é a mesma; o que muda é o risco
    assert.equal(open.score, Math.round(speedScore(open.estMbps) * INSECURE_FACTOR * 10) / 10);
    assert.ok(open.score <= safe.score * INSECURE_FACTOR + 0.1);
    assert.equal(open.parts.security, 0);
    assert.equal(open.detail.securityFactor, INSECURE_FACTOR);
    assert.ok(open.warnings.some((w) => /aberta/i.test(w) && /criptografia/.test(w)), open.warnings.join(' | '));
    assert.ok(open.cons.some((c) => /Aberta/.test(c)));
    assert.equal(safe.warnings.length, 0);
  });

  test('WEP: metade da nota, aviso, e o enlace cai para as taxas do 802.11g (54 Mb/s)', () => {
    const wep = scoreWith(SEC.wep);
    assert.equal(wep.detail.phyMbps, 54);
    assert.equal(wep.detail.linkMbps, 32.4);
    assert.equal(wep.detail.securityFactor, INSECURE_FACTOR);
    assert.equal(wep.parts.security, 10);
    assert.ok(wep.warnings.some((w) => /WEP/.test(w)));
    assert.ok(wep.cons.some((c) => /WEP/.test(c)));
    assert.ok(wep.cons.some((c) => /54 Mb\/s/.test(c)));
  });

  test('só WPA/TKIP: um quinto a menos e também limitada a 54 Mb/s', () => {
    const tkip = scoreWith(SEC.tkip);
    assert.equal(tkip.detail.phyMbps, 54);
    assert.equal(tkip.detail.securityFactor, WEAK_SECURITY_FACTOR);
    assert.equal(tkip.score, Math.round(speedScore(tkip.estMbps) * WEAK_SECURITY_FACTOR * 10) / 10);
    assert.equal(tkip.parts.security, 40);
    assert.ok(tkip.cons.some((c) => /WPA\/TKIP/.test(c)));
    // WPA/WPA2 misto com AES continua em 802.11n
    const mixed = scoreWith('[WPA-PSK-CCMP+TKIP][WPA2-PSK-CCMP+TKIP][ESS]');
    assert.equal(mixed.detail.phyMbps, 144.4);
    assert.equal(mixed.detail.securityFactor, 1);
  });

  test('WPA3 ganha um bônus pequeno; WPA2/WPA3 também', () => {
    const wpa2 = scoreWith(SEC.wpa2);
    const wpa3 = scoreWith(SEC.wpa3);
    const both = scoreWith('[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][MFPC]');
    assert.ok(WPA3_BONUS > 0 && WPA3_BONUS <= 5);
    assert.equal(wpa3.score, Math.round((wpa2.score + WPA3_BONUS) * 10) / 10);
    assert.equal(both.score, wpa3.score);
    assert.equal(wpa3.parts.security, 100);
    assert.ok(wpa3.pros.some((p) => /Segurança forte \(WPA3\)/.test(p)));
  });

  test('o bônus não passa de 100 nem fura o teto do sinal fraco', () => {
    const fast = makeAp('00:11:22:33:44:55', 'Top', -45, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6, capabilities: SEC.wpa3 });
    const aps = norm(scan([fast]));
    assert.equal(scoreAp(aps[0], { aps, device: PHONE }).score, 100);
    for (const level of [-76, -81, -88]) {
      const far = norm(scan([{ ...fast, level }]));
      const r = scoreAp(far[0], { aps: far, device: PHONE });
      assert.ok(speedScore(r.estMbps) > signalCap(level), `${level}: o teste precisa do teto atuando`);
      assert.equal(r.score, Math.round(signalCap(level) * 10) / 10, `${level} dBm`);
    }
  });

  test('qualquer rede protegida de 20 Mb/s ganha da melhor rede aberta possível', () => {
    assert.ok(speedScore(SPEED_GOOD_MBPS) > 100 * INSECURE_FACTOR);
    assert.ok(speedScore(10) > 100 * INSECURE_FACTOR);
  });

  test('segurança desconhecida não é tratada como aberta', () => {
    const unknown = scoreWith('');
    assert.equal(unknown.parts.security, 50);
    assert.equal(unknown.detail.securityFactor, 1);
    assert.equal(unknown.warnings.length, 0);
    assert.equal(isInsecure(norm(scan([lone({ capabilities: '' })]))[0].security), false);
  });

  test('isInsecure: aberta e WEP sim; OWE, WPA2, WPA3 e empresarial não', () => {
    const sec = (capabilities) => normalizeAp(lone({ capabilities })).security;
    assert.equal(isInsecure(sec(SEC.open)), true);
    assert.equal(isInsecure(sec(SEC.wep)), true);
    assert.equal(isInsecure(sec(SEC.wpa2)), false);
    assert.equal(isInsecure(sec(SEC.wpa3)), false);
    assert.equal(isInsecure(sec(SEC.tkip)), false);
    assert.equal(isInsecure(sec('[RSN-OWE-CCMP][ESS]')), false);
    assert.equal(isInsecure(sec('[WPA2-EAP/SHA1-CCMP][RSN-EAP/SHA1-CCMP][ESS]')), false);
    for (const bad of [null, undefined, 3, 'x', {}]) assert.equal(isInsecure(bad), false);
  });

  test('Wi-Fi Direct de impressora não é rede: nota no chão e aviso', () => {
    const aps = norm(office);
    const printer = aps.find((ap) => ap.ssid.startsWith('DIRECT-'));
    const r = scoreAp(printer, { aps, device: PHONE });
    assert.ok(r.score < 20, `nota ${r.score}`);
    assert.ok(r.warnings.some((w) => /impressora/.test(w)));
  });

  test('rede oculta ganha o contra, sem mexer na nota', () => {
    const visible = norm(scan([lone()]));
    const hidden = norm(scan([lone({ ssid: '' })]));
    const a = scoreAp(visible[0], { aps: visible, device: PHONE });
    const b = scoreAp(hidden[0], { aps: hidden, device: PHONE });
    assert.equal(b.score, a.score);
    assert.ok(b.cons.some((c) => /oculta/.test(c)));
    assert.ok(!a.cons.some((c) => /oculta/.test(c)));
  });
});

// ---------------------------------------------------------------------------
describe('scoreAp: o celular', () => {
  const ap5 = () => makeAp('00:11:22:33:44:55', 'Cinco', -55, 5180, { channelWidth: CW.W160, centerFreq0: 5250, wifiStandard: 6, capabilities: SEC.wpa2 });

  test('celular sem 5 GHz: a rede de 5 GHz não serve para ele', () => {
    const aps = norm(scan([ap5()]));
    const r = scoreAp(aps[0], { aps, device: PHONE_24 });
    assert.equal(r.score, 0);
    assert.equal(r.estMbps, 0);
    assert.equal(r.detail.usable, false);
    assert.ok(r.cons.some((c) => /não funciona em 5 GHz/.test(c)));
    assert.ok(r.warnings.some((w) => /5 GHz/.test(w)));
    assertScoreShape(r);
  });

  test('rede de 6 GHz: zero para quem não tem a faixa, boa para quem tem', () => {
    const aps = norm(wifi7);
    const six = byId(aps, TRUTH.wifi7.own.b6);
    assert.equal(scoreAp(six, { aps, device: PHONE }).score, 0);
    assert.equal(scoreAp(six, { aps, device: { standards: [4, 5] } }).estMbps, 0);
    const top = scoreAp(six, { aps, device: FLAGSHIP });
    assert.equal(top.detail.widthMHz, 320);
    assert.equal(top.detail.gen, 7);
    assert.ok(top.score > 90);
  });

  test('sem saber nada do celular: 2 fluxos, 80 MHz em 5 GHz, mesma geração do AP', () => {
    const aps = norm(scan([ap5()]));
    for (const device of [undefined, null, {}]) {
      const r = scoreAp(aps[0], { aps, device });
      assert.equal(r.detail.nss, 2);
      assert.equal(r.detail.widthMHz, 80);
      assert.equal(r.detail.gen, 6);
      assert.ok(r.score > 80);
    }
    assert.equal(scoreAp(aps[0], { aps, device: FLAGSHIP }).detail.widthMHz, 160);
  });

  test('celular mais antigo que o roteador: vale a geração do celular', () => {
    const aps = norm(scan([ap5()]));
    const ac = scoreAp(aps[0], { aps, device: { bands: { b24: true, b5: true, b6: false, b60: false }, standards: [1, 4, 5] } });
    const ax = scoreAp(aps[0], { aps, device: PHONE });
    assert.equal(ac.detail.gen, 5);
    assert.equal(ax.detail.gen, 6);
    assert.ok(ac.estMbps < ax.estMbps);
  });

  test('em 2,4 GHz o celular fica em 20 MHz mesmo que o roteador ofereça 40', () => {
    const wide = makeAp('00:11:22:33:44:55', 'Larga', -50, 2412, { channelWidth: CW.W40, centerFreq0: 2422, wifiStandard: 4, capabilities: SEC.wpa2 });
    const aps = norm(scan([wide]));
    const r = scoreAp(aps[0], { aps, device: PHONE });
    assert.equal(aps[0].widthMHz, 40);
    assert.equal(r.detail.widthMHz, 20);
    assert.equal(r.detail.phyMbps, 144.4);
  });

  test('a disputa é medida na largura que o celular usa, não na do roteador', () => {
    // Roteador em 160 MHz (36–64) com um vizinho forte na metade de cima (canal 52, 80 MHz).
    // O celular comum fica nos 80 MHz de baixo (36–48) e nem encosta nele; o topo de linha usa os
    // 160 MHz inteiros e leva o ruído.
    const wide = makeAp('00:11:22:33:44:55', 'Larga', -55, 5180, { channelWidth: CW.W160, centerFreq0: 5250, wifiStandard: 6, capabilities: SEC.wpa2 });
    const upper = makeAp('00:77:88:99:aa:01', 'Em cima', -50, 5260, { channelWidth: CW.W80, centerFreq0: 5290, wifiStandard: 5 });
    const aps = norm(scan([wide, upper]));
    const common = scoreAp(byId(aps, wide.bssid), { aps, device: PHONE });
    const flagship = scoreAp(byId(aps, wide.bssid), { aps, device: FLAGSHIP });
    assert.equal(common.detail.widthMHz, 80);
    assert.equal(common.detail.overlapping, 0); // só o vazamento do bloco ao lado
    assert.equal(flagship.detail.widthMHz, 160);
    assert.equal(flagship.detail.overlapping, 1);
    assert.ok(common.detail.share > 0.8, `share ${common.detail.share}`);
    assert.ok(flagship.detail.share < common.detail.share - 0.05, `${flagship.detail.share} x ${common.detail.share}`);
  });

  test('os fluxos do AP vêm dos elementos do beacon quando existem', () => {
    const one = lone({ ies: encodeIes({ frequency: 2437, widthMhz: 20, ht: { nss: 1, width40: false } }) });
    const aps = norm(scan([one]));
    const r = scoreAp(aps[0], { aps, device: PHONE });
    assert.equal(r.detail.nss, 1);
    assert.equal(r.detail.phyMbps, 72.2);
  });
});

// ---------------------------------------------------------------------------
describe('scoreAp: entradas tortas', () => {
  test('nunca lança e devolve o formato completo', () => {
    const junk = [undefined, null, 0, 'ap', [], {}, { bssid: 5, level: 'forte' }, { bssid: 'zz', ssid: null, level: NaN, frequency: -1 }];
    for (const ap of junk) {
      for (const options of [undefined, null, 'x', {}, { aps: 'lista' }, { aps: [null, 3, {}], device: 9 }, { aps: junk, connectionBssid: {} }, { context: {} }, { context: 5 }]) {
        const r = scoreAp(ap, options);
        assertScoreShape(r);
        assert.equal(r.score, 0);
        assert.equal(r.estMbps, null);
        assert.equal(r.detail.usable, false);
      }
    }
  });

  test('AP sem sinal, em faixa desconhecida ou em 60 GHz: sem estimativa, nota 0', () => {
    const noSignal = lone({ level: undefined });
    const weird = lone({ frequency: 3500 });
    const wigig = makeAp('00:11:22:33:44:55', 'WiGig', -50, 60480, { wifiStandard: 7 });
    const wigigPhone = { ...FLAGSHIP, bands: { ...FLAGSHIP.bands, b60: true } };
    for (const raw of [noSignal, weird, wigig]) {
      const aps = norm(scan([raw]));
      const r = scoreAp(aps[0], { aps, device: wigigPhone });
      assert.equal(r.score, 0);
      assert.equal(r.estMbps, null);
      assert.ok(r.warnings.some((w) => /estimar/.test(w)));
      assertScoreShape(r);
    }
    // e num celular sem 60 GHz a rede simplesmente não serve (0, não "sem estimativa")
    const aps = norm(scan([wigig]));
    assert.equal(scoreAp(aps[0], { aps, device: FLAGSHIP }).estMbps, 0);
  });

  test('aceita ScanAp cru e dá o mesmo resultado que o Ap normalizado', () => {
    const raw = quietHouse.aps[1];
    const normalized = normalizeScan(quietHouse);
    const a = scoreAp(raw, { aps: quietHouse.aps, device: PHONE });
    const b = scoreAp(byId(normalized, raw.bssid), { aps: normalized, device: PHONE });
    assert.equal(a.score, b.score);
    assert.equal(a.estMbps, b.estMbps);
    assert.deepEqual(a.parts, b.parts);
  });

  test('o AP avaliado não precisa estar na lista; lista ausente = AP sozinho', () => {
    const aps = norm(scan([lone()]));
    const alone = scoreAp(aps[0], { aps, device: PHONE });
    assert.deepEqual(scoreAp(aps[0], { device: PHONE }), alone);
    assert.deepEqual(scoreAp(aps[0], { aps: [], device: PHONE }), alone);
  });

  test('context pronto dá o mesmo resultado que passar a lista', () => {
    const aps = norm(apartment);
    const context = scoringContext(aps, { device: PHONE, connectionBssid: TRUTH.apartment.own.b24 });
    for (const ap of aps) {
      assert.deepEqual(scoreAp(ap, { context }), scoreAp(ap, { aps, device: PHONE, connectionBssid: TRUTH.apartment.own.b24 }));
    }
    assert.doesNotThrow(() => scoringContext(null));
    assert.doesNotThrow(() => scoringContext([null, 1, 'x'], 7));
  });

  test('não altera os objetos recebidos', () => {
    const aps = norm(apartment);
    const before = JSON.stringify(aps);
    rankNetworks(aps, { device: PHONE, connectionBssid: TRUTH.apartment.own.b24, favorites: ['Familia Souza'] });
    assert.equal(JSON.stringify(aps), before);
  });
});

// ---------------------------------------------------------------------------
describe('rankNetworks', () => {
  test('uma linha por rede (nome + família de segurança), com todos os BSSIDs contados uma vez', () => {
    for (const [name, event] of Object.entries(ALL)) {
      const aps = norm(event);
      const ranking = rankNetworks(aps, { device: PHONE });
      const keys = ranking.map((row) => row.key);
      assert.equal(new Set(keys).size, keys.length, `${name}: chave repetida`);
      const ids = ranking.flatMap((row) => [row.best.id, ...row.others.map((o) => o.ap.id)]);
      assert.deepEqual([...ids].sort(), aps.map((ap) => ap.id).sort(), name);
    }
  });

  test('"INTELBRAS" aberta e "INTELBRAS" com senha são duas redes; a pública da Claro em dois roteadores é uma', () => {
    const ranking = rankNetworks(norm(apartment), { device: PHONE });
    const intelbras = ranking.filter((row) => row.ssid === 'INTELBRAS');
    assert.equal(intelbras.length, 2);
    assert.deepEqual(intelbras.map((row) => row.key).sort(), ['open:INTELBRAS', 'psk:INTELBRAS']);
    const claro = rowOf(ranking, '#NET-CLARO-WIFI');
    assert.equal(claro.others.length, 1);
    assert.equal(claro.best.id, 'f8:0b:be:4f:1d:29'); // o mais forte dos dois
    assert.equal(claro.mesh, true);
    // cada BSSID oculto é uma rede
    assert.equal(rankNetworks(norm(office), { device: PHONE }).filter((row) => row.hidden).length, 6);
  });

  test('da melhor para a pior, e a linha repete o scoreAp do melhor BSSID', () => {
    for (const [name, event] of Object.entries(ALL)) {
      const aps = norm(event);
      const ranking = rankNetworks(aps, { device: PHONE });
      const context = scoringContext(aps, { device: PHONE });
      for (let i = 0; i < ranking.length; i++) {
        const row = ranking[i];
        if (i > 0) assert.ok(ranking[i - 1].score >= row.score, `${name}: fora de ordem em ${row.key}`);
        const expected = scoreAp(row.best, { context });
        assert.equal(row.score, expected.score);
        assert.equal(row.estMbps, expected.estMbps);
        assert.deepEqual(row.parts, expected.parts);
        assert.deepEqual(row.pros, expected.pros);
        assert.deepEqual(row.cons, expected.cons);
        assert.deepEqual(row.warnings, expected.warnings);
        assert.equal(row.security, row.best.security);
        assertScoreShape(row, `${name} ${row.key}`);
        let prev = row.score;
        for (const other of row.others) {
          assert.ok(other.score <= prev, `${name}: others fora de ordem em ${row.key}`);
          assert.equal(other.score, scoreAp(other.ap, { context }).score);
          prev = other.score;
        }
      }
    }
  });

  test('escolhe o melhor BSSID de cada rede: o de 5 GHz no sítio, o de 2,4 GHz para quem não tem 5 GHz', () => {
    const aps = norm(quietHouse);
    const { b24, b5 } = TRUTH.quietHouse.own;
    const row = rowOf(rankNetworks(aps, { device: PHONE }), 'Sítio Boa Vista');
    assert.equal(row.best.id, b5);
    assert.deepEqual(row.others.map((o) => o.ap.id), [b24]);
    assert.deepEqual(row.bands, ['2.4', '5']);
    assert.equal(row.deviceId, row.others[0].deviceId); // os dois rádios são da mesma caixa
    const old = rowOf(rankNetworks(aps, { device: PHONE_24 }), 'Sítio Boa Vista');
    assert.equal(old.best.id, b24);
    assert.equal(old.others[0].score, 0);
  });

  test('no prédio: a rede de 5 GHz da casa vence; redes abertas ficam para trás das protegidas equivalentes', () => {
    const ranking = rankNetworks(norm(apartment), { device: PHONE });
    assert.equal(ranking[0].ssid, 'Familia Souza_5G');
    // a rede do cliente e a rede pública saem do mesmo rádio da Claro: mesma velocidade, metade da nota
    const client = rowOf(ranking, 'CLARO_2G4F1D2A');
    const pub = rowOf(ranking, '#NET-CLARO-WIFI');
    assert.ok(Math.abs(client.estMbps - pub.estMbps) < 1);
    assert.ok(Math.abs(pub.score - client.score * INSECURE_FACTOR) < 1);
    assert.ok(ranking.indexOf(pub) > ranking.indexOf(client));
    assert.ok(pub.warnings.length > 0);
    // toda rede com sinal inutilizável fica abaixo do teto
    for (const row of ranking) if (row.best.rssi < WEAK_SIGNAL_DBM) assert.ok(row.score <= WEAK_SIGNAL_CAP, row.key);
  });

  test('connected, current e favorite', () => {
    const aps = norm(apartment);
    const { b24 } = TRUTH.apartment.own;
    const ranking = rankNetworks(aps, { device: PHONE, connectionBssid: b24, favorites: new Set(['Familia Souza', 'Casa do Zé']) });
    assert.deepEqual(ranking.filter((row) => row.connected).map((row) => row.ssid), ['Familia Souza']);
    assert.deepEqual(ranking.filter((row) => row.favorite).map((row) => row.ssid).sort(), ['Casa do Zé', 'Familia Souza']);
    const mine = rowOf(ranking, 'Familia Souza');
    assert.equal(mine.current.ap.id, b24);
    assert.equal(mine.current.score, mine.score);
    for (const row of ranking) if (!row.connected) assert.equal(row.current, null);
    // favoritos também como lista; sem conexão ninguém fica marcado
    const plain = rankNetworks(aps, { device: PHONE, favorites: ['Familia Souza'] });
    assert.equal(plain.filter((row) => row.favorite).length, 1);
    assert.equal(plain.filter((row) => row.connected).length, 0);
    // conectado num BSSID que não é o melhor da rede: current aponta para ele, best para o melhor
    const farNode = rowOf(rankNetworks(norm(mesh), { device: PHONE, connectionBssid: '14:eb:b6:8d:21:58' }), 'Casa Oliveira');
    assert.equal(farNode.connected, true);
    assert.equal(farNode.current.ap.id, '14:eb:b6:8d:21:58');
    assert.equal(farNode.best.id, '14:eb:b6:8d:21:51');
    assert.ok(farNode.current.score < farNode.score);
  });

  test('rede oculta nunca é favorita, mesmo com "" na lista', () => {
    const ranking = rankNetworks(norm(mesh), { device: PHONE, favorites: ['', 'Casa Oliveira'] });
    for (const row of ranking) assert.equal(row.favorite, row.ssid === 'Casa Oliveira');
  });

  test('empate na nota (as duas no teto): vem antes a de maior velocidade estimada', () => {
    const slower = makeAp('00:11:22:33:44:10', 'Alfa', -55, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6 });
    const faster = makeAp('00:77:88:99:aa:10', 'Zeta', -45, 5745, { channelWidth: CW.W80, centerFreq0: 5775, wifiStandard: 6 });
    for (const list of [[slower, faster], [faster, slower]]) {
      const ranking = rankNetworks(norm(scan(list)), { device: PHONE });
      assert.deepEqual(ranking.map((row) => row.score), [100, 100]);
      assert.deepEqual(ranking.map((row) => row.ssid), ['Zeta', 'Alfa']);
      assert.ok(ranking[0].estMbps > ranking[1].estMbps);
    }
  });

  test('o resultado não depende da ordem da lista', () => {
    const aps = norm(apartment);
    const expected = rankNetworks(aps, { device: PHONE }).map((row) => `${row.key}|${row.best.id}|${row.score}`);
    const reversed = rankNetworks([...aps].reverse(), { device: PHONE }).map((row) => `${row.key}|${row.best.id}|${row.score}`);
    assert.deepEqual(reversed, expected);
  });

  test('entradas tortas: lista vazia, nunca exceção', () => {
    for (const aps of [undefined, null, 'x', 5, {}, []]) assert.deepEqual(rankNetworks(aps, { device: PHONE }), []);
    for (const options of [undefined, null, 'x', { favorites: 5 }, { favorites: 'Casa', connectionBssid: 12, device: 'celular' }]) {
      assert.doesNotThrow(() => rankNetworks(quietHouse.aps, options));
    }
    // o que não tem BSSID válido não vira rede
    const mixed = rankNetworks([null, 3, {}, { bssid: 'xx', ssid: 'Lixo', level: -40, frequency: 2437 }, ...quietHouse.aps], { device: PHONE });
    assert.deepEqual(mixed.map((row) => row.ssid), ['Sítio Boa Vista', 'Chacara do Tonho']);
    for (const row of mixed) assertScoreShape(row);
  });
});

// ---------------------------------------------------------------------------
describe('advise', () => {
  const run = (event, { device = PHONE, connectionBssid, favorites } = {}) => {
    const ranking = rankNetworks(norm(event), { device, connectionBssid, favorites });
    return advise(ranking, { connectionBssid, favorites });
  };

  function assertAdviceShape(a, label = '') {
    assert.ok(KINDS.includes(a.kind), `${label} kind ${a.kind}`);
    for (const key of ['headline', 'text']) {
      assert.equal(typeof a[key], 'string', `${label} ${key}`);
      assert.ok(a[key].length > 0);
      assert.doesNotMatch(a[key], /undefined|NaN|null|\[object|—/, `${label}: ${a[key]}`);
    }
    assert.ok(a.target === null || typeof a.target === 'object');
    if (a.kind.startsWith('switch')) assert.ok(a.target !== null, `${label}: troca sem destino`);
    if (a.kind === 'ok') assert.equal(a.target, null);
  }

  test('já na melhor opção: fica', () => {
    const { b5 } = TRUTH.quietHouse.own;
    const a = run(quietHouse, { connectionBssid: b5 });
    assert.equal(a.kind, 'ok');
    assert.equal(a.target, null);
    assert.equal(a.current.bssid, b5);
    assert.equal(a.gain, null);
    assert.match(a.headline, /melhor opção/);
    assert.match(a.text, /“Sítio Boa Vista” em 5 GHz/);
    assert.match(a.text, /cerca de \d+ Mb\/s/);
    assertAdviceShape(a);
  });

  test('mesmo nome, outra faixa do mesmo roteador: "a rede de 5 GHz do mesmo roteador deve render cerca de N,Nx mais aqui"', () => {
    const { b24, b5 } = TRUTH.quietHouse.own;
    const ranking = rankNetworks(norm(quietHouse), { device: PHONE, connectionBssid: b24 });
    const a = advise(ranking, { connectionBssid: b24 });
    assert.equal(a.kind, 'switch-band');
    assert.equal(a.target.bssid, b5);
    assert.equal(a.target.band, '5');
    assert.equal(a.target.ssid, 'Sítio Boa Vista');
    assert.equal(a.current.bssid, b24);
    const row = ranking[0];
    assert.equal(a.gain, Math.round((row.estMbps / row.current.estMbps) * 10) / 10);
    assert.ok(a.gain > 3 && a.gain < 6, `ganho ${a.gain}`);
    assert.ok(a.text.includes(`A rede de 5 GHz do mesmo roteador deve render cerca de ${formatGain(a.gain)} mais aqui`), a.text);
    assert.match(a.text, /desligue e ligue o Wi-Fi/);
    assertAdviceShape(a);
  });

  test('nomes diferentes para as duas faixas ("Familia Souza" / "Familia Souza_5G"): manda trocar de rede pelo nome', () => {
    const { b24, b5 } = TRUTH.apartment.own;
    const a = run(apartment, { connectionBssid: b24 });
    assert.equal(a.kind, 'switch-band');
    assert.equal(a.target.bssid, b5);
    assert.equal(a.target.ssid, 'Familia Souza_5G');
    assert.match(a.headline, /“Familia Souza_5G”/);
    assert.match(a.text, /5 GHz do mesmo roteador/);
    assert.match(a.text, /configurações de Wi-Fi/);
    assert.ok(a.gain >= 5);
    // e o contrário não acontece: do 5 GHz não manda voltar
    assert.equal(run(apartment, { connectionBssid: b5 }).kind, 'ok');
    assertAdviceShape(a);
  });

  test('cliente grudado: outro ponto de acesso da mesma rede bem mais forte', () => {
    // conectado no nó do quarto dos fundos (−74 dBm) com o nó da sala a −52 dBm
    const a = run(mesh, { connectionBssid: '14:eb:b6:8d:21:58' });
    assert.equal(a.kind, 'switch-ap');
    assert.equal(a.target.bssid, '14:eb:b6:8d:21:51');
    assert.match(a.text, /preso a um ponto de acesso distante \(−74 dBm\)/);
    assert.match(a.text, /−52 dBm/);
    assert.match(a.text, /Desligue e ligue o Wi-Fi/);
    assert.ok(a.gain > 2);
    assertAdviceShape(a);
    // mesma faixa, outro nó
    const same = run(mesh, { connectionBssid: '14:eb:b6:8d:21:55' });
    assert.equal(same.kind, 'switch-ap');
    assert.equal(same.target.bssid, '14:eb:b6:8d:21:51');
    // escritório: do AP da diretoria para o da recepção
    const corp = run(office, { connectionBssid: '94:b4:0f:c2:7d:a0' });
    assert.equal(corp.kind, 'switch-ap');
    assert.equal(corp.target.ssid, 'Corp');
    assert.equal(corp.target.bssid, '24:de:c6:8a:31:50');
  });

  test('outro ponto de acesso só um pouco mais forte não vale o trabalho', () => {
    assert.ok(ROAM_MIN_DB >= 6);
    const nodeA = makeAp('00:11:22:33:44:10', 'Malha', -62, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6 });
    const near = (level) => makeAp('00:77:88:99:aa:10', 'Malha', level, 5745, { channelWidth: CW.W80, centerFreq0: 5775, wifiStandard: 6 });
    const little = run(scan([nodeA, near(-62 + ROAM_MIN_DB - 2)]), { connectionBssid: nodeA.bssid });
    assert.equal(little.kind, 'ok');
    const lot = run(scan([{ ...nodeA, level: -78 }, near(-55)]), { connectionBssid: nodeA.bssid });
    assert.equal(lot.kind, 'switch-ap');
    // O outro ponto renderia bem mais (canal limpo contra canal com 8 vizinhos), mas chega quase
    // com o mesmo sinal: o celular não trocaria sozinho, então não adianta mandar religar o Wi-Fi.
    const here = makeAp('00:11:22:33:44:10', 'Malha', -62, 2412, { wifiStandard: 4 });
    const there = makeAp('00:77:88:99:aa:10', 'Malha', -60, 2462, { wifiStandard: 4 });
    const crowd = Array.from({ length: 8 }, (_, i) => makeAp(`00:${(0x30 + i).toString(16)}:${(0x50 + 3 * i).toString(16)}:5e:10:01`, `Vizinho ${i}`, -60, 2412, { wifiStandard: 4 }));
    const ranking = rankNetworks(norm(scan([here, there, ...crowd])), { device: PHONE, connectionBssid: here.bssid });
    const row = rowOf(ranking, 'Malha');
    assert.equal(row.best.id, there.bssid);
    assert.ok(row.score - row.current.score >= SWITCH_MIN_POINTS, `${row.score} x ${row.current.score}`);
    assert.equal(advise(ranking, { connectionBssid: here.bssid }).kind, 'ok');
  });

  test('outra rede marcada como minha está melhor: troca de rede', () => {
    // conectado no 5 GHz fraco da Casa do Zé, com a Familia Souza_5G marcada como minha
    const connectionBssid = '64:09:80:1e:52:08';
    const a = run(apartment, { connectionBssid, favorites: ['Familia Souza_5G'] });
    assert.equal(a.kind, 'switch-network');
    assert.equal(a.target.ssid, 'Familia Souza_5G');
    assert.equal(a.target.favorite, true);
    assert.match(a.text, /Das suas redes, “Familia Souza_5G”/);
    assert.match(a.text, /“Casa do Zé”/);
    assert.ok(a.gain > 5);
    assert.match(a.text, /pelo menos 10x mais|cerca de \d+(,\d)?x mais/);
    assertAdviceShape(a);
  });

  test('rede de terceiros melhor: não manda trocar; só cita com "se você tiver a senha"', () => {
    const connectionBssid = 'e0:ca:94:5c:8a:28'; // VIVOFIBRA-8A28, 2,4 GHz a −74 dBm
    const a = run(apartment, { connectionBssid });
    assert.equal(a.kind, 'ok');
    assert.equal(a.target, null);
    assert.equal(a.alternative.ssid, 'Familia Souza_5G');
    assert.match(a.text, /“Familia Souza_5G” parece render mais aqui/);
    assert.match(a.text, /se ela for sua e você tiver a senha/);
    assertAdviceShape(a);
    // com a rede atual boa, nem isso
    const fine = run(apartment, { connectionBssid: TRUTH.apartment.own.b5 });
    assert.equal(fine.alternative, null);
    assert.doesNotMatch(fine.text, /senha/);
  });

  test('rede atual boa (nota 80+): não cita a de terceiros, mesmo que ela seja mais rápida', () => {
    const mine = makeAp('00:11:22:33:44:10', 'Casa', -50, 2412, { wifiStandard: 6 });
    const theirs = makeAp('00:77:88:99:aa:10', 'Vizinho Turbo', -50, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6 });
    const ranking = rankNetworks(norm(scan([mine, theirs])), { device: PHONE, connectionBssid: mine.bssid });
    const current = rowOf(ranking, 'Casa');
    assert.ok(current.score >= 80 && rowOf(ranking, 'Vizinho Turbo').score - current.score >= 10, `${current.score}`);
    const a = advise(ranking, { connectionBssid: mine.bssid });
    assert.equal(a.kind, 'ok');
    assert.equal(a.alternative, null);
    assert.doesNotMatch(a.text, /Vizinho Turbo/);
  });

  test('sinal no limite na melhor opção: fica, mas avisa', () => {
    const a = run(apartment, { connectionBssid: '00:1a:3f:21:9c:04' }); // INTELBRAS aberta a −81 dBm
    assert.equal(a.kind, 'ok');
    assert.match(a.text, /sinal está no limite/);
    assert.doesNotMatch(run(apartment, { connectionBssid: TRUTH.apartment.own.b5 }).text, /sinal está no limite/);
  });

  test('os favoritos valem tanto pelo ranking (row.favorite) quanto pela opção de advise', () => {
    const connectionBssid = '64:09:80:1e:52:08';
    const favorites = ['Familia Souza_5G'];
    const aps = norm(apartment);
    const plain = rankNetworks(aps, { device: PHONE, connectionBssid });
    const marked = rankNetworks(aps, { device: PHONE, connectionBssid, favorites });
    assert.equal(advise(plain, { connectionBssid, favorites }).kind, 'switch-network');
    assert.equal(advise(marked, { connectionBssid }).kind, 'switch-network');
    assert.equal(advise(plain, { connectionBssid }).kind, 'switch-band'); // sem favoritos: só o próprio roteador
  });

  test('nunca indica rede aberta ou WEP no lugar de uma protegida, nem quando é favorita', () => {
    // a rede protegida está quase morta (−84 dBm) e as inseguras, perfeitas: mesmo com a nota
    // cortada pela metade elas ficam bem na frente
    const mine = makeAp('00:11:22:33:44:10', 'Casa', -84, 2437, { wifiStandard: 4, capabilities: SEC.wpa2 });
    const open = makeAp('00:77:88:99:aa:10', 'Aberta Rapida', -45, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6, capabilities: SEC.open });
    const wep = makeAp('00:55:66:77:88:10', 'Velha WEP', -45, 2412, { wifiStandard: 4, capabilities: SEC.wep });
    const event = scan([mine, open, wep]);
    for (const favorites of [[], ['Aberta Rapida', 'Velha WEP']]) {
      const ranking = rankNetworks(norm(event), { device: PHONE, connectionBssid: mine.bssid, favorites });
      assert.ok(rowOf(ranking, 'Aberta Rapida').score > rowOf(ranking, 'Casa').score + 2 * SWITCH_MIN_POINTS);
      assert.ok(rowOf(ranking, 'Velha WEP').score > rowOf(ranking, 'Casa').score + SWITCH_MIN_POINTS);
      const a = advise(ranking, { connectionBssid: mine.bssid, favorites });
      assert.equal(a.kind, 'ok', JSON.stringify(favorites));
      assert.equal(a.target, null);
      assert.equal(a.alternative, null);
      assert.doesNotMatch(a.text, /Aberta Rapida|Velha WEP/);
    }
  });

  test('quem já está numa rede aberta pode ir para outra aberta que seja sua, mas a dica de terceiros nunca é insegura', () => {
    const mine = makeAp('00:11:22:33:44:10', 'Praça', -84, 2437, { wifiStandard: 4, capabilities: SEC.open });
    const open = makeAp('00:77:88:99:aa:10', 'Shopping', -45, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6, capabilities: SEC.open });
    const event = scan([mine, open]);
    const stranger = run(event, { connectionBssid: mine.bssid });
    assert.equal(stranger.kind, 'ok');
    assert.equal(stranger.alternative, null);
    assert.doesNotMatch(stranger.text, /Shopping/);
    const fav = run(event, { connectionBssid: mine.bssid, favorites: ['Shopping'] });
    assert.equal(fav.kind, 'switch-network');
    assert.equal(fav.target.ssid, 'Shopping');
  });

  test('conectado: rede oculta e Wi-Fi Direct não viram destino nem dica', () => {
    const mine = makeAp('00:11:22:33:44:10', 'Casa', -84, 2437, { wifiStandard: 4, capabilities: SEC.wpa2 });
    const hidden = makeAp('00:77:88:99:aa:10', '', -45, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6, capabilities: SEC.wpa2 });
    const printer = makeAp('fa:da:0c:7c:19:b3', 'DIRECT-7C-HP OfficeJet', -40, 2462, { wifiStandard: 4, capabilities: SEC.wpa2 });
    for (const favorites of [[], ['DIRECT-7C-HP OfficeJet']]) {
      const a = run(scan([mine, hidden, printer]), { connectionBssid: mine.bssid, favorites });
      assert.equal(a.kind, 'ok');
      assert.equal(a.target, null);
      assert.equal(a.alternative, null);
      assert.doesNotMatch(a.text, /oculta|DIRECT/);
    }
  });

  test('da rede aberta para a protegida que é minha: indica e explica', () => {
    const a = run(office, { connectionBssid: '24:de:c6:8a:31:41', favorites: ['Corp'] }); // em Corp-Visitantes
    assert.equal(a.kind, 'switch-network');
    assert.equal(a.target.ssid, 'Corp');
    assert.match(a.text, /protegida por senha e criptografia/);
    // sem marcar "Corp" como minha: fica, com a dica condicional
    const b = run(office, { connectionBssid: '24:de:c6:8a:31:41' });
    assert.equal(b.kind, 'ok');
    assert.equal(b.alternative.ssid, 'Corp');
    assert.match(b.text, /se ela for sua e você tiver a senha/);
  });

  test('quase empate entre a outra faixa do meu roteador e outra rede minha: fica no meu roteador', () => {
    const r24 = makeAp('00:11:22:33:44:10', 'Casa', -62, 2412, { wifiStandard: 6 });
    const r5 = makeAp('00:11:22:33:44:11', 'Casa', -66, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6 });
    const other = makeAp('00:77:88:99:aa:10', 'Escritorio', -64, 5745, { channelWidth: CW.W80, centerFreq0: 5775, wifiStandard: 6 });
    const event = scan([r24, r5, other]);
    const ranking = rankNetworks(norm(event), { device: PHONE, connectionBssid: r24.bssid, favorites: ['Casa', 'Escritorio'] });
    const own5 = rowOf(ranking, 'Casa');
    const office5 = rowOf(ranking, 'Escritorio');
    assert.ok(office5.score > own5.score && office5.score - own5.score < 5, `${office5.score} x ${own5.score}`);
    const a = advise(ranking, { connectionBssid: r24.bssid, favorites: ['Casa', 'Escritorio'] });
    assert.equal(a.kind, 'switch-band');
    assert.equal(a.target.bssid, r5.bssid);
    // com a outra rede MUITO melhor, aí sim troca de rede
    const farBetter = scan([r24, { ...r5, level: -79 }, { ...other, level: -50 }]);
    const b = run(farBetter, { connectionBssid: r24.bssid, favorites: ['Casa', 'Escritorio'] });
    assert.equal(b.kind, 'switch-network');
    assert.equal(b.target.ssid, 'Escritorio');
  });

  test('do 5 GHz fraco para o 2,4 GHz forte do mesmo roteador também é troca de faixa', () => {
    const a = run(apartment, { connectionBssid: '64:09:80:1e:52:08' }); // Casa do Zé, 5 GHz a −78 dBm
    assert.equal(a.kind, 'switch-band');
    assert.equal(a.target.bssid, '64:09:80:1e:52:07');
    assert.match(a.headline, /2,4 GHz/);
    assert.match(a.text, /Você está em 5 GHz\. A rede de 2,4 GHz do mesmo roteador/);
  });

  test('a rede de convidados do mesmo roteador (nome sem relação) não é "minha" só por morar na mesma caixa', () => {
    const main = makeAp('00:11:22:33:44:10', 'Casa', -60, 2412, { wifiStandard: 6 });
    const guest5 = makeAp('00:11:22:33:44:11', 'Visitas', -62, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6 });
    const event = scan([main, guest5]);
    const a = run(event, { connectionBssid: main.bssid });
    assert.equal(a.kind, 'ok');
    assert.equal(a.target, null);
    // marcada como minha, vira troca de rede (não "outra faixa com a mesma senha")
    const b = run(event, { connectionBssid: main.bssid, favorites: ['Visitas'] });
    assert.equal(b.kind, 'switch-network');
    assert.doesNotMatch(b.text, /a senha costuma ser a mesma/);
  });

  test('diferença pequena não vira conselho', () => {
    assert.ok(SWITCH_MIN_POINTS >= 5);
    const a1 = makeAp('00:11:22:33:44:10', 'Um', -58, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6 });
    const a2 = makeAp('00:77:88:99:aa:10', 'Dois', -55, 5745, { channelWidth: CW.W80, centerFreq0: 5775, wifiStandard: 6 });
    const a = run(scan([a1, a2]), { connectionBssid: a1.bssid, favorites: ['Um', 'Dois'] });
    assert.equal(a.kind, 'ok');
    assert.equal(a.alternative, null);
  });

  test('sem conexão, com rede minha ao alcance: indica a minha', () => {
    const a = run(apartment, { favorites: ['Familia Souza'] });
    assert.equal(a.kind, 'no-connection');
    assert.equal(a.target.ssid, 'Familia Souza');
    assert.equal(a.current, null);
    assert.match(a.headline, /Conecte-se à rede “Familia Souza”/);
    assert.match(a.text, /Das suas redes/);
    assert.doesNotMatch(a.text, /se você tiver a senha/i);
    assertAdviceShape(a);
  });

  test('sem conexão e sem rede minha: a melhor protegida, "se você tiver a senha"', () => {
    const a = run(apartment);
    assert.equal(a.kind, 'no-connection');
    assert.equal(a.target.ssid, 'Familia Souza_5G');
    assert.match(a.text, /Se você tiver a senha/);
    assertAdviceShape(a);
  });

  test('sem conexão: a aberta mais forte não passa na frente de uma protegida', () => {
    const open = makeAp('00:77:88:99:aa:10', 'Shopping Free', -45, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6, capabilities: SEC.open });
    const safe = makeAp('00:11:22:33:44:10', 'Loja', -79, 2437, { wifiStandard: 4, capabilities: SEC.wpa2 });
    const ranking = rankNetworks(norm(scan([open, safe])), { device: PHONE });
    assert.equal(ranking[0].ssid, 'Shopping Free'); // pela nota a aberta ganharia
    const a = advise(ranking);
    assert.equal(a.target.ssid, 'Loja');
    assert.match(a.text, /Se você tiver a senha/);
    // minha rede aberta x minha rede protegida: a protegida
    const b = run(scan([open, safe]), { favorites: ['Shopping Free', 'Loja'] });
    assert.equal(b.target.ssid, 'Loja');
    // só redes abertas: indica, avisando
    const c = run(scan([open]));
    assert.equal(c.kind, 'no-connection');
    assert.equal(c.target.ssid, 'Shopping Free');
    assert.match(c.text, /Só há redes abertas/);
    assert.match(c.text, /evite bancos e compras/);
    assert.doesNotMatch(c.text, /se você tiver a senha/i);
    // minha rede é aberta: indica a minha, com o alerta
    const d = run(scan([open]), { favorites: ['Shopping Free'] });
    assert.equal(d.target.ssid, 'Shopping Free');
    assert.match(d.text, /evite bancos e compras/);
  });

  test('sem conexão: rede oculta e Wi-Fi Direct nunca são indicados', () => {
    const hidden = makeAp('00:77:88:99:aa:10', '', -40, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6 });
    const printer = makeAp('fa:da:0c:7c:19:b3', 'DIRECT-7C-HP OfficeJet', -42, 2437, { wifiStandard: 4 });
    const only = run(scan([hidden, printer]));
    assert.equal(only.kind, 'no-connection');
    assert.equal(only.target, null);
    const plus = run(scan([hidden, printer, makeAp('00:11:22:33:44:10', 'Loja', -70, 2462, { wifiStandard: 4 })]));
    assert.equal(plus.target.ssid, 'Loja');
  });

  test('sem nenhuma rede: diz isso', () => {
    for (const ranking of [[], undefined, null, 'x', [null, 5, {}, { key: 'x' }]]) {
      const a = advise(ranking);
      assert.equal(a.kind, 'no-connection');
      assert.equal(a.target, null);
      assert.match(a.text, /Nenhuma rede/);
    }
  });

  test('conectado num BSSID que não está na lista (o Android esconde o BSSID sem permissão)', () => {
    for (const connectionBssid of ['02:00:00:00:00:00', 'aa:aa:aa:aa:aa:aa']) {
      const a = run(apartment, { connectionBssid });
      assert.equal(a.kind, 'ok');
      assert.equal(a.target, null);
      assert.equal(a.current, null);
      assert.match(a.headline, /Sem dados para comparar/);
    }
    // BSSID inválido = sem conexão
    assert.equal(run(apartment, { connectionBssid: 'não é um mac' }).kind, 'no-connection');
  });

  test('conectado numa rede oculta: a frase não inventa nome, e as outras redes continuam sendo de terceiros', () => {
    const a = run(mesh, { connectionBssid: '1a:eb:b6:8d:21:55' }); // a rede oculta do nó do corredor
    assert.equal(a.kind, 'ok');
    assert.equal(a.current.hidden, true);
    assert.match(a.text, /^Uma rede oculta em 5 GHz é a melhor das suas opções/);
    assert.doesNotMatch(a.text, /“”/);
    assert.ok(a.current.score >= 80);
    assert.equal(a.alternative, null); // a rede em uso está boa: nem a dica condicional aparece
    // marcada como minha, vira destino
    const b = run(mesh, { connectionBssid: '1a:eb:b6:8d:21:55', favorites: ['Casa Oliveira'] });
    assert.equal(b.kind, 'switch-network');
    assert.equal(b.target.bssid, '14:eb:b6:8d:21:51');
    assert.match(b.text, /em comparação com uma rede oculta/);
  });

  test('celular sem 5 GHz nunca é mandado para o 5 GHz', () => {
    const a = run(quietHouse, { device: PHONE_24, connectionBssid: TRUTH.quietHouse.own.b24 });
    assert.equal(a.kind, 'ok');
  });

  test('em todos os cenários e em qualquer BSSID: formato certo, destino usável, nunca de terceiros e nunca menos seguro', () => {
    for (const [name, event] of Object.entries(ALL)) {
      const aps = norm(event);
      const own = TRUTH[name].own;
      for (const favorites of [[], [own.ssid]]) {
        for (const ap of aps) {
          const ranking = rankNetworks(aps, { device: PHONE, connectionBssid: ap.id, favorites });
          const a = advise(ranking, { connectionBssid: ap.id, favorites });
          const label = `${name} ${ap.id} fav=${favorites}`;
          assertAdviceShape(a, label);
          assert.notEqual(a.kind, 'no-connection', label);
          assert.equal(a.current.bssid, ap.id, label);
          if (a.target === null) continue;
          assert.notEqual(a.target.bssid, ap.id, label);
          assert.ok(a.target.score - a.current.score >= SWITCH_MIN_POINTS, label);
          assert.ok(a.target.estMbps > 0, label);
          const targetRow = ranking.find((row) => row.key === a.target.key);
          const currentRow = ranking.find((row) => row.connected);
          if (!isInsecure(currentRow.security)) assert.equal(isInsecure(targetRow.security), false, `${label}: indicou rede insegura`);
          // "minha" = a rede em uso, uma favorita, ou a outra faixa da mesma caixa com o mesmo nome fora o "_5G"
          const sameBox = [targetRow.deviceId, ...targetRow.others.map((o) => o.deviceId)].includes(currentRow.current.deviceId);
          const twin = sameBox && ssidStem(targetRow.ssid) !== null && ssidStem(targetRow.ssid) === ssidStem(currentRow.ssid);
          const mine = targetRow === currentRow || favorites.includes(targetRow.ssid) || twin;
          assert.ok(mine, `${label}: mandou para a rede de terceiros ${targetRow.key}`);
          assert.equal(targetRow.hidden && targetRow !== currentRow, false, label);
        }
      }
    }
  });

  test('entradas tortas nunca lançam', () => {
    const ranking = rankNetworks(norm(apartment), { device: PHONE });
    for (const options of [undefined, null, 5, 'x', { connectionBssid: 7 }, { favorites: 3 }, { connectionBssid: null, favorites: [null, 4] }]) {
      assertAdviceShape(advise(ranking, options));
    }
    const broken = ranking.map((row) => ({ ...row, others: 'x', security: null, score: 'alta', estMbps: undefined }));
    assert.doesNotThrow(() => advise(broken, { connectionBssid: TRUTH.apartment.own.b24 }));
    assert.doesNotThrow(() => advise([{ key: 'a', best: {} }, { key: 'b', best: { id: 5 } }], { connectionBssid: '00:11:22:33:44:55' }));
  });
});

// ---------------------------------------------------------------------------
describe('cenários completos', () => {
  test('Wi-Fi 7: com um celular topo de linha as três faixas da casa ficam no topo; o vizinho fraco não', () => {
    const ranking = rankNetworks(norm(wifi7), { device: FLAGSHIP, connectionBssid: TRUTH.wifi7.own.b5 });
    assert.equal(ranking[0].ssid, 'Lar Conectado');
    assert.equal(ranking[0].score, 100);
    assert.equal(ranking[0].others.length, 2);
    assert.ok(ranking[0].others.every((o) => o.score > 85));
    assert.equal(advise(ranking, { connectionBssid: TRUTH.wifi7.own.b5 }).kind, 'ok');
  });

  test('escritório: a rede com login vence a de visitantes do mesmo rádio', () => {
    const ranking = rankNetworks(norm(office), { device: PHONE });
    const corp = rowOf(ranking, 'Corp');
    const guests = rowOf(ranking, 'Corp-Visitantes');
    assert.ok(corp.score > guests.score * 1.8);
    assert.equal(corp.parts.security, 100);
    assert.equal(guests.parts.security, 0);
    // muitos aparelhos no AP aparecem como o motivo do canal disputado
    assert.ok(corp.cons.some((c) => /aparelhos disputam este ponto de acesso/.test(c)), corp.cons.join(' | '));
  });

  test('varreduras corrompidas ao acaso: nada lança e os invariantes continuam valendo', () => {
    // gerador determinístico (mulberry32): o teste falha sempre do mesmo jeito
    let seed = 0x5eed1234;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const junk = [undefined, null, NaN, Infinity, -Infinity, -1, 0, 1e9, '', 'x', '5180', true, [], {}, [null], { id: 1 }, -200, 2484, 5935, 60480, 3.7];
    const fields = ['bssid', 'ssid', 'level', 'frequency', 'channelWidth', 'centerFreq0', 'centerFreq1', 'capabilities', 'ageMs', 'wifiStandard', 'ies', 'mld'];
    const events = Object.values(ALL);
    for (let round = 0; round < 120; round++) {
      const event = pick(events);
      const aps = event.aps.map((ap) => {
        if (rnd() > 0.35) return ap;
        const copy = { ...ap };
        for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
          const field = pick(fields);
          if (rnd() < 0.2) delete copy[field];
          else copy[field] = pick(junk);
        }
        return copy;
      });
      if (rnd() < 0.3) aps.push(pick(junk));
      const device = pick([PHONE, PHONE_24, FLAGSHIP, undefined, pick(junk), { bands: pick(junk), standards: pick(junk) }]);
      const connectionBssid = pick([pick(event.aps).bssid, '', pick(junk), '02:00:00:00:00:00']);
      const favorites = pick([undefined, [], [pick(event.aps).ssid], new Set([pick(event.aps).ssid]), pick(junk)]);
      // cru (como vem da ponte) e normalizado (como vem do store)
      for (const list of [aps, normalizeScan({ ts: TS, aps }, { sdk: 34 })]) {
        const ranking = rankNetworks(list, { device, connectionBssid, favorites });
        let prev = Infinity;
        for (const row of ranking) {
          assertScoreShape(row, `rodada ${round} ${row.key}`);
          assert.ok(row.score <= prev);
          prev = row.score;
          assert.ok(row.estMbps === null || row.estMbps <= 6000);
          for (const other of row.others) assert.ok(other.score <= row.score);
        }
        const a = advise(ranking, { connectionBssid, favorites });
        assert.ok(KINDS.includes(a.kind), `rodada ${round}`);
        assert.equal(typeof a.headline, 'string');
        assert.equal(typeof a.text, 'string');
        assert.doesNotMatch(a.headline + a.text, /undefined|NaN|\[object/, `rodada ${round}`);
        if (a.target) assert.notEqual(a.target.bssid, '');
        for (const item of list.slice(0, 4)) assertScoreShape(scoreAp(item, { aps: list, device, connectionBssid }), `rodada ${round}`);
      }
    }
  });

  test('ranking de uma lista grande termina rápido', () => {
    const aps = [];
    const channels = [2412, 2437, 2462, 5180, 5220, 5745];
    for (let i = 0; i < 90; i++) {
      const freq = channels[i % channels.length];
      const mac = `00:${(i * 7 + 16).toString(16).padStart(2, '0').slice(-2)}:${(i * 13 + 32).toString(16).padStart(2, '0').slice(-2)}:4d:5e:${(i + 16).toString(16).padStart(2, '0')}`;
      aps.push(makeAp(mac, `Rede ${i}`, -45 - (i % 45), freq, freq > 5000 ? { channelWidth: CW.W80, centerFreq0: freq === 5745 ? 5775 : 5210 } : {}));
    }
    const started = performance.now();
    const ranking = rankNetworks(norm(scan(aps)), { device: PHONE });
    const elapsed = performance.now() - started;
    assert.equal(ranking.length, 90);
    assert.ok(elapsed < 3000, `levou ${elapsed.toFixed(0)} ms`);
  });
});
