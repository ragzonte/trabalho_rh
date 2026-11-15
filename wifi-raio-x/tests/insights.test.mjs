// Testes de app/js/core/insights.js: cada aviso é testado disparando e NÃO disparando (o dado
// que o sustenta ausente, ou dentro do normal).
//
// A base é uma casa sem defeito nenhum: roteador Wi-Fi 6 de duas faixas com o mesmo nome, sem
// vizinhos, celular no 5 GHz com sinal ótimo. Ali o diagnóstico é só "tudo certo"; cada teste
// estraga uma coisa de cada vez.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildInsights } from '../app/js/core/insights.js';
import { normalizeScan } from '../app/js/core/model.js';
import { signalLevel } from '../app/js/core/signal.js';
import { encodeIes } from '../app/js/core/ies.js';
import { ALL, TRUTH, TS, CW, apartment, mesh, office, wifi7, quietHouse, makeAp } from './fixtures/scans.mjs';

const PHONE = { platform: 'android', sdk: 34, bands: { b24: true, b5: true, b6: false, b60: false }, standards: [1, 4, 5, 6], rtt: false };
const PHONE_24 = { platform: 'android', sdk: 29, bands: { b24: true, b5: false, b6: false, b60: false }, standards: [], rtt: false };
const FLAGSHIP = { platform: 'android', sdk: 35, bands: { b24: true, b5: true, b6: true, b60: false }, standards: [1, 4, 5, 6, 8], rtt: true };
const STATUS = { wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: false, canScan: true };

const CAPS = {
  good: '[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][MFPC]',
  wpa2: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]',
  wps: '[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][MFPC][WPS]',
  open: '[ESS]',
  wep: '[WEP][ESS]',
  tkip: '[WPA-PSK-TKIP][ESS]',
  mixed: '[WPA-PSK-CCMP+TKIP][WPA2-PSK-CCMP+TKIP][RSN-PSK-CCMP+TKIP][ESS]',
};

const HOME_24 = '00:11:22:33:44:10';
const HOME_5 = '00:11:22:33:44:11';
const hex = (n) => n.toString(16).padStart(2, '0').slice(-2);

/** O roteador da casa: `r24` e `r5` mudam campos de cada rádio; `extra` acrescenta vizinhos. */
function home({ r24 = {}, r5 = {}, extra = [] } = {}) {
  return [
    makeAp(HOME_24, 'Casa', -50, 2412, { wifiStandard: 6, capabilities: CAPS.good, ...r24 }),
    makeAp(HOME_5, 'Casa', -55, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6, capabilities: CAPS.good, ...r5 }),
    ...extra,
  ];
}

/** Vizinho sem parentesco de MAC com ninguém. */
function neighbour(i, level, frequency, more = {}) {
  return makeAp(`00:${hex(0x20 + i)}:${hex(0x40 + 3 * i)}:5e:10:01`, `Vizinho ${i}`, level, frequency, { wifiStandard: 4, capabilities: CAPS.wpa2, ...more });
}
const neighbours = (count, level, frequency, from = 0) => Array.from({ length: count }, (_, i) => neighbour(from + i, level, frequency));

const on5 = (more = {}) => ({ connected: true, ssid: 'Casa', bssid: HOME_5, rssi: -55, frequency: 5180, hidden: false, ...more });
const on24 = (more = {}) => ({ connected: true, ssid: 'Casa', bssid: HOME_24, rssi: -50, frequency: 2412, hidden: false, ...more });

function run({ aps = home(), connection = on5(), device = PHONE, status = STATUS, sdk } = {}) {
  const list = normalizeScan({ ts: TS, fresh: true, source: 'request', aps }, { sdk });
  return buildInsights({ aps: list, connection, device, status });
}
const ids = (out) => out.map((i) => i.id);
const get = (out, id) => out.find((i) => i.id === id);

const SEVERITIES = ['critical', 'warning', 'info', 'good'];
const KINDS = ['open-channels', 'open-best', 'open-settings-wifi', 'open-map', 'none'];

function assertShape(out, label = '') {
  assert.ok(Array.isArray(out), label);
  let prev = 0;
  for (const insight of out) {
    assert.deepEqual(Object.keys(insight).filter((k) => !['id', 'severity', 'title', 'text', 'action'].includes(k)), [], `${label} ${insight.id}`);
    assert.match(insight.id, /^[a-z0-9-]+$/, label);
    assert.ok(SEVERITIES.includes(insight.severity), `${label} ${insight.id}: ${insight.severity}`);
    const rank = SEVERITIES.indexOf(insight.severity);
    assert.ok(rank >= prev, `${label}: ${insight.id} fora da ordem de gravidade`);
    prev = rank;
    for (const key of ['title', 'text']) {
      assert.equal(typeof insight[key], 'string');
      assert.ok(insight[key].length > 0);
      assert.doesNotMatch(insight[key], /undefined|NaN|null|\[object|Infinity|—/, `${label} ${insight.id}: ${insight[key]}`);
    }
    assert.ok(insight.title.length <= 70, `${label} ${insight.id}: título longo`);
    assert.match(insight.text, /[.!?]$/, `${label} ${insight.id}`);
    if ('action' in insight) {
      assert.ok(KINDS.includes(insight.action.kind), `${label} ${insight.id}: ${insight.action.kind}`);
      assert.equal(typeof insight.action.label, 'string');
      assert.ok(insight.action.label.length > 0);
    }
  }
  assert.equal(new Set(ids(out)).size, out.length, `${label}: id repetido`);
  assert.ok(out.filter((i) => i.severity === 'good').length <= 1, label);
}

// ---------------------------------------------------------------------------
describe('tudo certo', () => {
  test('casa sem defeito: um único aviso, do tipo bom, com os números', () => {
    const out = run();
    assert.deepEqual(ids(out), ['all-good']);
    const good = out[0];
    assert.equal(good.severity, 'good');
    assert.match(good.text, /“Casa”/);
    assert.match(good.text, /sinal ótimo \(−55 dBm\)/);
    assert.match(good.text, /5 GHz/);
    assert.match(good.text, /WPA2\/WPA3/);
    assert.equal('action' in good, false);
    assertShape(out);
  });

  test('"tudo certo" convive com notas (info), mas some com qualquer alerta', () => {
    const noted = run({ status: { ...STATUS, throttled: true } });
    assert.deepEqual(ids(noted), ['scan-throttled', 'all-good']);
    const warned = run({ connection: on5({ rssi: -78 }) });
    assert.ok(ids(warned).includes('weak-signal'));
    assert.equal(ids(warned).includes('all-good'), false);
  });

  test('sem sinal medido em lugar nenhum não dá para dizer que está tudo certo', () => {
    const out = run({ aps: [], connection: { connected: true, ssid: 'Casa', bssid: HOME_5 } });
    assert.deepEqual(ids(out), []);
  });

  test('sem conexão: só o aviso de que não há conexão, apontando para a melhor rede', () => {
    const out = run({ connection: { connected: false } });
    assert.deepEqual(ids(out), ['not-connected']);
    assert.equal(out[0].severity, 'info');
    assert.deepEqual(out[0].action, { label: 'Ver a melhor rede', kind: 'open-best' });
    // conexão desconhecida (a ponte ainda não respondeu): nem isso
    assert.deepEqual(ids(run({ connection: null })), []);
    assert.deepEqual(buildInsights({ aps: home(), device: PHONE, status: STATUS }), []);
  });
});

// ---------------------------------------------------------------------------
describe('sinal fraco na conexão', () => {
  test('os cortes das frases são os de signalLevel()', () => {
    assert.equal(signalLevel(-75).key, 'fair');
    assert.equal(signalLevel(-75.5).key, 'weak');
    assert.equal(signalLevel(-82).key, 'weak');
    assert.equal(signalLevel(-82.5).key, 'very-weak');
  });

  test('fraco = alerta; muito fraco = crítico; com o número e o caminho para o mapa', () => {
    const weak = get(run({ connection: on5({ rssi: -78 }) }), 'weak-signal');
    assert.equal(weak.severity, 'warning');
    assert.match(weak.title, /Sinal fraco aqui \(−78 dBm\)/);
    assert.match(weak.text, /−78 dBm/);
    assert.match(weak.text, /Abaixo de −75 dBm/);
    assert.deepEqual(weak.action, { label: 'Ver o mapa do sinal', kind: 'open-map' });
    const dead = get(run({ connection: on5({ rssi: -86 }) }), 'weak-signal');
    assert.equal(dead.severity, 'critical');
    assert.match(dead.title, /muito fraco/);
    assert.match(dead.text, /Abaixo de −82 dBm/);
  });

  test('sinal regular ou melhor não dispara', () => {
    for (const rssi of [-75, -70, -60, -40]) assert.equal(get(run({ connection: on5({ rssi }) }), 'weak-signal'), undefined, `${rssi}`);
  });

  test('sem o sinal da conexão vale o da varredura; −127 (sem medida) é ignorado', () => {
    const fromScan = run({ aps: home({ r5: { level: -79 } }), connection: on5({ rssi: undefined }) });
    assert.match(get(fromScan, 'weak-signal').title, /−79 dBm/);
    const invalid = run({ aps: home({ r5: { level: -79 } }), connection: on5({ rssi: -127 }) });
    assert.match(get(invalid, 'weak-signal').title, /−79 dBm/);
    // o da conexão é mais novo: ganha do da varredura
    const live = run({ aps: home({ r5: { level: -79 } }), connection: on5({ rssi: -60 }) });
    assert.equal(get(live, 'weak-signal'), undefined);
  });

  test('sem conexão ou sem leitura: nada', () => {
    assert.equal(get(run({ aps: home({ r5: { level: -90 } }), connection: { connected: false } }), 'weak-signal'), undefined);
    assert.equal(get(run({ aps: [], connection: on5({ rssi: undefined }) }), 'weak-signal'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('conectado em 2,4 GHz com 5/6 GHz à disposição', () => {
  test('mesmo nome, 5 GHz com sinal bom: alerta com o sinal e o ganho', () => {
    const out = run({ connection: on24() });
    const up = get(out, 'band-upgrade');
    assert.equal(up.severity, 'warning');
    assert.match(up.title, /2,4 GHz com 5 GHz à disposição/);
    assert.match(up.text, /o mesmo roteador também tem 5 GHz chegando aqui com −55 dBm \(sinal ótimo\)/);
    assert.match(up.text, /Ela deve render cerca de \d+(,\d)?x mais \(perto de \d+ Mb\/s\)/);
    assert.match(up.text, /desligue e ligue o Wi-Fi/);
    assert.deepEqual(up.action, { label: 'Abrir o Wi-Fi do celular', kind: 'open-settings-wifi' });
    assertShape(out);
  });

  test('o 5 GHz bom é de outro ponto de acesso da mesma rede (mesh): a frase não diz "mesmo roteador"', () => {
    // nó do corredor: o 2,4 GHz dele a −63 dBm, o 5 GHz dele fraco (−71), o 5 GHz do nó da sala a −52
    const connection = { connected: true, ssid: 'Casa Oliveira', bssid: '14:eb:b6:8d:21:54', rssi: -63, frequency: 2412 };
    const up = get(buildInsights({ aps: normalizeScan(mesh), connection, device: PHONE, status: STATUS }), 'band-upgrade');
    assert.match(up.text, /mas a sua rede também tem 5 GHz chegando aqui com \u221252 dBm/);
    assert.doesNotMatch(up.text, /mesmo roteador/);
  });

  test('faixas com nomes diferentes ("Casa" / "Casa_5G"): manda conectar na outra rede', () => {
    const out = run({ aps: home({ r5: { ssid: 'Casa_5G' } }), connection: on24() });
    assert.match(get(out, 'band-upgrade').text, /Conecte-se à rede “Casa_5G”/);
  });

  test('não dispara: já em 5 GHz; 5 GHz fraco; celular sem 5 GHz; 5 GHz de outra rede', () => {
    assert.equal(get(run({ connection: on5() }), 'band-upgrade'), undefined);
    assert.equal(get(run({ aps: home({ r5: { level: -70 } }), connection: on24() }), 'band-upgrade'), undefined);
    assert.equal(get(run({ connection: on24(), device: PHONE_24 }), 'band-upgrade'), undefined);
    // mesmo roteador, mas rede de nome sem relação (a pública da operadora, por exemplo)
    assert.equal(get(run({ aps: home({ r5: { ssid: 'OPERADORA-WIFI' } }), connection: on24() }), 'band-upgrade'), undefined);
    // 5 GHz forte de um vizinho não é da pessoa
    const stranger = makeAp('00:77:88:99:aa:01', 'Vizinho 5G', -50, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6 });
    assert.equal(get(run({ aps: [home()[0], stranger], connection: on24() }), 'band-upgrade'), undefined);
  });

  test('não dispara quando o 5 GHz renderia menos (mais disputado que o 2,4 GHz)', () => {
    const busy = encodeIes({ frequency: 5180, widthMhz: 20, bssLoad: { stations: 30, utilization: 0.95 }, ht: { nss: 1, width40: false } });
    const out = run({ aps: home({ r5: { channelWidth: CW.W20, centerFreq0: 0, wifiStandard: 4, ies: busy } }), connection: on24() });
    assert.equal(get(out, 'band-upgrade'), undefined);
  });

  test('rede aberta de 5 GHz não é sugerida a quem está numa rede com senha', () => {
    // o 2,4 GHz protegido está fraco (−79 dBm) e o 5 GHz aberto, perfeito: pela nota o aberto ganharia
    const aps = home({ r24: { level: -79 }, r5: { level: -50, capabilities: CAPS.open } });
    assert.equal(get(run({ aps, connection: on24({ rssi: -79 }) }), 'band-upgrade'), undefined);
    // a mesma situação com o 5 GHz protegido dispara
    const safe = home({ r24: { level: -79 }, r5: { level: -50 } });
    assert.ok(get(run({ aps: safe, connection: on24({ rssi: -79 }) }), 'band-upgrade'));
    // e quem já está numa rede aberta pode receber a sugestão da outra faixa, também aberta
    const allOpen = home({ r24: { level: -79, capabilities: CAPS.open }, r5: { level: -50, capabilities: CAPS.open } });
    assert.ok(get(run({ aps: allOpen, connection: on24({ rssi: -79 }) }), 'band-upgrade'));
  });

  test('é um aviso de quem está em 2,4 GHz: do 5 GHz para o 6 GHz não dispara', () => {
    const { b5 } = TRUTH.wifi7.own;
    // 5 GHz da casa enfraquecido para o 6 GHz ficar claramente melhor
    const event = { ...wifi7, aps: wifi7.aps.map((ap) => (ap.bssid === b5 ? { ...ap, level: -74 } : ap)) };
    const connection = { connected: true, ssid: 'Lar Conectado', bssid: b5, rssi: -74, frequency: 5180 };
    const out = buildInsights({ aps: normalizeScan(event), connection, device: FLAGSHIP, status: STATUS });
    assert.equal(get(out, 'band-upgrade'), undefined);
  });

  test('6 GHz só para o celular que alcança a faixa', () => {
    const { b24 } = TRUTH.wifi7.own;
    const connection = { connected: true, ssid: 'Lar Conectado', bssid: b24, rssi: -47, frequency: 2437 };
    const top = buildInsights({ aps: normalizeScan(wifi7), connection, device: FLAGSHIP, status: STATUS });
    assert.ok(get(top, 'band-upgrade'));
    // tira o rádio de 5 GHz: para o celular comum não sobra faixa melhor
    const without5 = { ...wifi7, aps: wifi7.aps.filter((ap) => ap.bssid !== TRUTH.wifi7.own.b5) };
    assert.match(get(buildInsights({ aps: normalizeScan(without5), connection, device: FLAGSHIP, status: STATUS }), 'band-upgrade').title, /6 GHz/);
    assert.equal(get(buildInsights({ aps: normalizeScan(without5), connection, device: PHONE, status: STATUS }), 'band-upgrade'), undefined);
  });

  test('BSSID conectado fora da varredura: vale a frequência e o nome da conexão, sem inventar ganho', () => {
    const connection = { connected: true, ssid: '"Casa"', bssid: '00:11:22:33:44:99', rssi: -50, frequency: 2412 };
    const up = get(run({ aps: [home()[1]], connection }), 'band-upgrade');
    assert.ok(up);
    assert.doesNotMatch(up.text, /x mais/);
    // sem o nome da rede não há como saber qual 5 GHz é o dela
    assert.equal(get(run({ aps: [home()[1]], connection: { ...connection, ssid: undefined } }), 'band-upgrade'), undefined);
    assert.equal(get(run({ aps: [home()[1]], connection: { ...connection, ssid: '<unknown ssid>' } }), 'band-upgrade'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('canal do roteador', () => {
  test('canal fora do padrão em 2,4 GHz (2–5, 7–10, 12–13): alerta com o canal certo para ir', () => {
    for (const channel of [2, 3, 4, 5, 7, 8, 9, 10, 12, 13]) {
      const out = run({ aps: home({ r24: { frequency: 2407 + 5 * channel } }) });
      const off = get(out, 'nonstandard-channel');
      assert.ok(off, `canal ${channel}`);
      assert.equal(off.severity, 'warning');
      assert.ok(off.title.includes(`canal ${channel},`), off.title);
      assert.match(off.text, /só os canais 1, 6 e 11 não se sobrepõem/);
      assert.match(off.text, /Mude para o canal (1|6|11) /);
      assert.deepEqual(off.action, { label: 'Ver canais', kind: 'open-channels' });
      assert.equal(get(out, 'all-good'), undefined);
      assertShape(out, `canal ${channel}`);
    }
  });

  test('canais 1, 6 e 11 não disparam', () => {
    for (const channel of [1, 6, 11]) {
      const out = run({ aps: home({ r24: { frequency: 2407 + 5 * channel } }) });
      assert.deepEqual(ids(out), ['all-good'], `canal ${channel}`);
    }
  });

  test('fora do padrão, com vizinhos dos dois lados: diz quantos e para onde ir', () => {
    const out = run({ aps: home({ r24: { frequency: 2422 }, extra: [...neighbours(2, -60, 2412), ...neighbours(2, -62, 2437, 2)] }), connection: on24() });
    const off = get(out, 'nonstandard-channel');
    assert.equal(off.severity, 'warning');
    assert.match(off.text, /\(4 redes agora\)/);
    assert.match(off.text, /Mude para o canal 11 /);
    const [, now, then] = off.text.match(/nota do canal: (\d+) hoje, (\d+) no canal 11, de 100/);
    assert.ok(Number(now) < 60 && Number(then) > 90, `${now} -> ${then}`);
    // o canal fora do padrão já explica tudo: não repete como "canal disputado"
    assert.equal(get(out, 'crowded-channel-24'), undefined);
  });

  test('fora do padrão, mas com os canais padrão piores: vira só uma nota', () => {
    const crowd = [...neighbours(4, -80, 2412), ...neighbours(4, -80, 2437, 4), ...neighbours(4, -80, 2462, 8)];
    const out = run({ aps: home({ r24: { frequency: 2472 }, extra: crowd }) });
    const off = get(out, 'nonstandard-channel');
    assert.equal(off.severity, 'info');
    assert.match(off.text, /não há pressa em trocar/);
    assert.ok(get(out, 'all-good'));
  });

  test('canal disputado com um bem melhor disponível: alerta na faixa em uso, nota na outra', () => {
    const aps = home({ r24: { frequency: 2437 }, extra: neighbours(5, -55, 2437) });
    const using = run({ aps, connection: on24({ frequency: 2437 }) });
    const crowded = get(using, 'crowded-channel-24');
    assert.equal(crowded.severity, 'warning');
    assert.match(crowded.title, /Canal 6 disputado em 2,4 GHz/);
    assert.match(crowded.text, /Seu roteador está no canal 6, que você divide com 5 redes/);
    // cinco vizinhos "padrão" de 8% cada: 100 × 0,92^5 = 66
    const [, then] = crowded.text.match(/Nota do canal atual: 66 de 100; do canal (?:1|11): (\d+)\./);
    assert.ok(Number(then) >= 74, `canal sugerido com nota ${then}`);
    assert.deepEqual(crowded.action, { label: 'Ver canais', kind: 'open-channels' });
    const other = get(run({ aps, connection: on5() }), 'crowded-channel-24');
    assert.equal(other.severity, 'info');
    assertShape(using);
  });

  test('não dispara: vizinhos só em outros canais; um vizinho só (canal ainda bom); roteador fora da varredura', () => {
    const elsewhere = run({ aps: home({ r24: { frequency: 2437 }, extra: neighbours(5, -55, 2412) }), connection: on24({ frequency: 2437 }) });
    assert.equal(get(elsewhere, 'crowded-channel-24'), undefined);
    const single = run({ aps: home({ r24: { frequency: 2437 }, extra: neighbours(1, -55, 2437) }), connection: on24({ frequency: 2437 }) });
    assert.equal(get(single, 'crowded-channel-24'), undefined);
    const unknown = run({ aps: neighbours(6, -55, 2437), connection: on24({ frequency: 2437 }) });
    assert.equal(ids(unknown).some((id) => id.startsWith('crowded-channel') || id === 'nonstandard-channel'), false);
  });

  test('faixa toda lotada por igual: não há canal "bem melhor", então não há o que avisar', () => {
    const crowd = [...neighbours(4, -55, 2412), ...neighbours(4, -55, 2437, 4), ...neighbours(4, -55, 2462, 8)];
    const out = run({ aps: home({ extra: crowd }), connection: on24() });
    assert.equal(get(out, 'crowded-channel-24'), undefined);
    assert.equal(get(out, 'nonstandard-channel'), undefined);
  });

  test('5 GHz disputado', () => {
    const rivals = Array.from({ length: 4 }, (_, i) => neighbour(i, -55, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 5 }));
    const out = run({ aps: home({ extra: rivals }) });
    const crowded = get(out, 'crowded-channel-5');
    assert.equal(crowded.severity, 'warning');
    assert.match(crowded.title, /Canal 36 disputado em 5 GHz/);
    assert.equal(get(run(), 'crowded-channel-5'), undefined);
  });

  test('prédio lotado: o texto é o da tela de canais, com as notas', () => {
    const { b24 } = TRUTH.apartment.own;
    const out = buildInsights({ aps: normalizeScan(apartment), connection: { connected: true, ssid: 'Familia Souza', bssid: b24, rssi: -48, frequency: 2437 }, device: PHONE, status: STATUS });
    const crowded = get(out, 'crowded-channel-24');
    assert.match(crowded.text, /que você divide com 7 redes e que ainda recebe interferência de 5 outras\. O canal 1 está mais livre\./);
    assert.match(crowded.text, /Nota do canal atual: 39 de 100; do canal 1: 53\./);
  });
});

// ---------------------------------------------------------------------------
describe('40 MHz em 2,4 GHz', () => {
  const wide = { channelWidth: CW.W40, centerFreq0: 2422 };

  const around = [...neighbours(2, -65, 2437), ...neighbours(1, -65, 2462, 2)];

  test('com vizinhos por perto: alerta com os canais ocupados e a contagem', () => {
    const out = run({ aps: home({ r24: wide, extra: around }) });
    const w = get(out, 'wide-channel-24');
    assert.equal(w.severity, 'warning');
    assert.match(w.text, /40 MHz em 2,4 GHz \(canais 1 \+ 5\)/);
    assert.match(w.text, /Com 3 redes vizinhas por perto/);
    assert.match(w.text, /20 MHz/);
    assert.deepEqual(w.action, { label: 'Ver canais', kind: 'open-channels' });
  });

  test('não dispara: faixa vazia; vizinhos só longe do bloco; 20 MHz; largura não informada', () => {
    assert.equal(get(run({ aps: home({ r24: wide }) }), 'wide-channel-24'), undefined);
    // 40 MHz nos canais 1 + 5 não encosta em quem está no 11: a tela de canais também diz que dá
    assert.equal(get(run({ aps: home({ r24: wide, extra: neighbours(3, -65, 2462) }) }), 'wide-channel-24'), undefined);
    assert.equal(get(run({ aps: home({ extra: around }) }), 'wide-channel-24'), undefined);
    assert.equal(get(run({ aps: home({ r24: { channelWidth: -1 }, extra: around }) }), 'wide-channel-24'), undefined);
    // 40 MHz do vizinho não é problema do usuário
    assert.equal(get(run({ aps: home({ extra: [neighbour(0, -60, 2462, { channelWidth: CW.W40, centerFreq0: 2452 })] }) }), 'wide-channel-24'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('WPS', () => {
  test('ligado no roteador do usuário: alerta', () => {
    const out = run({ aps: home({ r5: { capabilities: CAPS.wps } }) });
    const wps = get(out, 'wps-on');
    assert.equal(wps.severity, 'warning');
    assert.match(wps.text, /WPS está ligado/);
    assert.match(wps.text, /"WPS" ou "QSS"/);
  });

  test('ligado só no outro rádio do mesmo roteador: também conta', () => {
    assert.equal(get(run({ aps: home({ r24: { capabilities: CAPS.wps } }) }), 'wps-on').severity, 'warning');
  });

  test('PIN travado (dado do elemento WPS): vira nota', () => {
    const ies = encodeIes({ frequency: 5180, widthMhz: 80, ht: { nss: 2, width40: true }, vht: { nss: 2 }, wps: { locked: true, manufacturer: 'ACME', model: 'X1' } });
    const wps = get(run({ aps: home({ r5: { ies } }) }), 'wps-on');
    assert.equal(wps.severity, 'info');
    assert.match(wps.title, /travado/);
  });

  test('não dispara: sem WPS; WPS só nos vizinhos; sem conexão', () => {
    assert.equal(get(run(), 'wps-on'), undefined);
    assert.equal(get(run({ aps: home({ extra: [neighbour(0, -80, 2462, { capabilities: CAPS.wps })] }) }), 'wps-on'), undefined);
    assert.equal(get(run({ aps: home({ r5: { capabilities: CAPS.wps } }), connection: { connected: false } }), 'wps-on'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('segurança fraca da rede em uso', () => {
  test('aberta, WEP e só WPA/TKIP são críticos; WPA/WPA2 misto é alerta', () => {
    const open = get(run({ aps: home({ r5: { capabilities: CAPS.open } }) }), 'weak-security');
    assert.equal(open.severity, 'critical');
    assert.match(open.title, /Rede aberta/);
    assert.match(open.text, /sem senha e sem criptografia/);
    assert.match(open.text, /WPA2 ou WPA3/);
    const wep = get(run({ aps: home({ r5: { capabilities: CAPS.wep } }) }), 'weak-security');
    assert.equal(wep.severity, 'critical');
    assert.match(wep.title, /WEP/);
    const tkip = get(run({ aps: home({ r5: { capabilities: CAPS.tkip } }) }), 'weak-security');
    assert.equal(tkip.severity, 'critical');
    assert.match(tkip.title, /WPA\/TKIP/);
    assert.match(tkip.text, /54 Mb\/s/);
    const mixed = get(run({ aps: home({ r5: { capabilities: CAPS.mixed } }) }), 'weak-security');
    assert.equal(mixed.severity, 'warning');
  });

  test('o crítico vem primeiro na lista', () => {
    const out = run({ aps: home({ r5: { capabilities: CAPS.open, level: -78 } }), connection: on5({ rssi: -78 }), status: { ...STATUS, throttled: true } });
    assert.deepEqual(out.map((i) => i.severity), ['critical', 'warning', 'info']);
    assert.equal(out[0].id, 'weak-security');
    assertShape(out);
  });

  test('não dispara: WPA2, WPA3, segurança desconhecida, rede aberta do vizinho', () => {
    assert.equal(get(run(), 'weak-security'), undefined);
    assert.equal(get(run({ aps: home({ r5: { capabilities: CAPS.wpa2 } }) }), 'weak-security'), undefined);
    assert.equal(get(run({ aps: home({ r5: { capabilities: '' } }) }), 'weak-security'), undefined);
    assert.equal(get(run({ aps: home({ extra: [neighbour(0, -60, 2462, { capabilities: CAPS.open })] }) }), 'weak-security'), undefined);
  });

  test('sem o AP na varredura vale o tipo de segurança da conexão (Android 12+): 0 = aberta, 1 = WEP', () => {
    const base = { connected: true, ssid: 'Casa', bssid: '02:00:00:00:00:00', rssi: -50, frequency: 5180 };
    const open = get(run({ aps: [], connection: { ...base, securityType: 0 } }), 'weak-security');
    assert.equal(open.severity, 'critical');
    assert.match(open.title, /Rede aberta/);
    assert.match(get(run({ aps: [], connection: { ...base, securityType: 1 } }), 'weak-security').title, /WEP/);
    for (const securityType of [2, 4, -1, undefined, '0']) {
      assert.equal(get(run({ aps: [], connection: { ...base, securityType } }), 'weak-security'), undefined, `${securityType}`);
    }
    // com o AP na varredura quem manda é o beacon
    assert.equal(get(run({ connection: on5({ securityType: 0 }) }), 'weak-security'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('PMF (só nota)', () => {
  const rsnNoPmf = encodeIes({ frequency: 5180, widthMhz: 80, ht: { nss: 2, width40: true }, vht: { nss: 2 }, rsn: { akms: ['PSK'], ciphers: ['CCMP'] } });

  test('WPA2 sem PMF, visto nos elementos do beacon: nota, e não tira o "tudo certo"', () => {
    const out = run({ aps: home({ r5: { capabilities: CAPS.wpa2, ies: rsnNoPmf } }) });
    assert.deepEqual(ids(out), ['no-pmf', 'all-good']);
    assert.equal(out[0].severity, 'info');
    assert.match(out[0].text, /PMF/);
    assert.match(out[0].text, /802\.11w/);
  });

  test('Android 14+ sem as flags de PMF no texto: também é certeza', () => {
    assert.ok(get(run({ aps: home({ r5: { capabilities: CAPS.wpa2 } }), sdk: 34 }), 'no-pmf'));
  });

  test('não dispara: Android antigo sem elementos (não dá para saber); PMF opcional; WPA3', () => {
    assert.equal(get(run({ aps: home({ r5: { capabilities: CAPS.wpa2 } }) }), 'no-pmf'), undefined);
    assert.equal(get(run({ aps: home({ r5: { capabilities: CAPS.wpa2 } }), sdk: 30 }), 'no-pmf'), undefined);
    assert.equal(get(run(), 'no-pmf'), undefined);
    assert.equal(get(run({ aps: home({ r5: { capabilities: '[RSN-SAE-CCMP][ESS][MFPR][MFPC]' } }) }), 'no-pmf'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('taxas do 802.11b', () => {
  const with11b = encodeIes({ frequency: 2412, widthMhz: 20, rates: { legacy11b: true }, ht: { nss: 2, width40: false } });
  const without = encodeIes({ frequency: 2412, widthMhz: 20, ht: { nss: 2, width40: false } });

  test('ligadas no rádio de 2,4 GHz do roteador: nota com a taxa dos avisos (1 Mb/s)', () => {
    const out = run({ aps: home({ r24: { ies: with11b } }) });
    const b = get(out, 'legacy-11b');
    assert.equal(b.severity, 'info');
    assert.match(b.text, /802\.11b \(padrão de 1999\)/);
    assert.match(b.text, /a 1 Mb\/s/);
    assert.ok(get(out, 'all-good'));
  });

  test('não dispara: só taxas OFDM; sem elementos; 802.11b só no vizinho', () => {
    assert.equal(get(run({ aps: home({ r24: { ies: without } }) }), 'legacy-11b'), undefined);
    assert.equal(get(run(), 'legacy-11b'), undefined);
    assert.equal(get(run({ aps: home({ extra: [neighbour(0, -80, 2462, { ies: encodeIes({ frequency: 2462, widthMhz: 20, rates: { legacy11b: true } }) })] }) }), 'legacy-11b'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('canal DFS', () => {
  test('canal primário DFS: nota', () => {
    const out = run({ aps: home({ r5: { frequency: 5260, centerFreq0: 5290 } }), connection: on5({ frequency: 5260 }) });
    const dfs = get(out, 'dfs-channel');
    assert.equal(dfs.severity, 'info');
    assert.match(dfs.title, /Canal 52 divide a faixa com radares \(DFS\)/);
    assert.match(dfs.text, /os canais 52 a 64 \(80 MHz, com o principal no 52\)/);
    assert.match(dfs.text, /cerca de um minuto/);
    assert.ok(get(out, 'all-good'));
  });

  test('160 MHz a partir do canal 36 pega os canais 52–64: nota com outro título', () => {
    const out = run({ aps: home({ r5: { channelWidth: CW.W160, centerFreq0: 5250 } }) });
    assert.match(get(out, 'dfs-channel').title, /Canal de 160 MHz pega um trecho de radares/);
  });

  test('roteador com dois rádios de 5 GHz: vale o rádio em que o celular está', () => {
    const high = makeAp('00:11:22:33:44:12', 'Casa', -62, 5500, { channelWidth: CW.W80, centerFreq0: 5530, wifiStandard: 6, capabilities: CAPS.good });
    const aps = home({ extra: [high] }); // o rádio do canal 36 chega mais forte (−55 dBm)
    const onHigh = run({ aps, connection: on5({ bssid: high.bssid, rssi: -62, frequency: 5500 }) });
    assert.match(get(onHigh, 'dfs-channel').title, /Canal 100/);
    assert.equal(get(run({ aps, connection: on5() }), 'dfs-channel'), undefined);
  });

  test('não dispara: canal 36 em 80 MHz; canal 149; DFS só no vizinho', () => {
    assert.equal(get(run(), 'dfs-channel'), undefined);
    assert.equal(get(run({ aps: home({ r5: { frequency: 5745, centerFreq0: 5775 } }), connection: on5({ frequency: 5745 }) }), 'dfs-channel'), undefined);
    assert.equal(get(run({ aps: home({ extra: [neighbour(0, -70, 5500, { channelWidth: CW.W80, centerFreq0: 5530, wifiStandard: 5 })] }) }), 'dfs-channel'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('roteador carregado (BSS Load)', () => {
  const load = (stations, utilization) => encodeIes({ frequency: 5180, widthMhz: 80, bssLoad: { stations, utilization }, ht: { nss: 2, width40: true }, vht: { nss: 2 } });

  test('canal ocupado mais da metade do tempo: alerta com a porcentagem e o número de aparelhos', () => {
    const busy = get(run({ aps: home({ r5: { ies: load(8, 0.62) } }) }), 'busy-ap');
    assert.equal(busy.severity, 'warning');
    assert.match(busy.title, /Canal ocupado 62% do tempo/);
    assert.match(busy.text, /8 aparelhos conectados neste rádio e o canal ocupado 62% do tempo/);
    assert.match(busy.text, /inclui o seu próprio uso/);
  });

  test('muitos aparelhos, mesmo com o canal calmo', () => {
    const many = get(run({ aps: home({ r5: { ies: load(31, 0.2) } }) }), 'busy-ap');
    assert.match(many.title, /31 aparelhos/);
  });

  test('soma as redes do mesmo rádio (principal + convidados)', () => {
    const guest = makeAp('00:11:22:33:44:12', 'Casa-Convidados', -55, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 6, capabilities: CAPS.good, ies: load(12, 0.1) });
    const out = run({ aps: home({ r5: { ies: load(15, 0.1) }, extra: [guest] }) });
    assert.match(get(out, 'busy-ap').text, /27 aparelhos conectados/);
  });

  test('não dispara: carga normal; roteador que não informa; vizinho carregado', () => {
    assert.equal(get(run({ aps: home({ r5: { ies: load(6, 0.2) } }) }), 'busy-ap'), undefined);
    assert.equal(get(run(), 'busy-ap'), undefined);
    const neighbourLoad = encodeIes({ frequency: 5745, widthMhz: 20, bssLoad: { stations: 60, utilization: 0.9 } });
    assert.equal(get(run({ aps: home({ extra: [neighbour(0, -70, 5745, { ies: neighbourLoad })] }) }), 'busy-ap'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('taxa do enlace abaixo do que o sinal permite', () => {
  const negotiated = { maxTxSpeed: 1201, maxRxSpeed: 1201, wifiStandard: 6 };

  test('com o teto negociado (Android 11+): 26 Mb/s onde caberiam centenas', () => {
    const out = run({ connection: on5({ linkSpeed: 26, txSpeed: 26, rxSpeed: 29, ...negotiated }) });
    const slow = get(out, 'slow-link');
    assert.equal(slow.severity, 'warning');
    assert.match(slow.text, /conversando a 29 Mb\/s/); // a direção mais rápida
    assert.match(slow.text, /\(−55 dBm\) o normal seria perto de \d{3} Mb\/s/);
    assert.deepEqual(slow.action, { label: 'Ver canais', kind: 'open-channels' });
  });

  test('o corte é 40% do esperado', () => {
    // a −55 dBm este enlace sustenta ~80% do teto de 1201 Mb/s: esperado perto de 960
    assert.ok(get(run({ connection: on5({ txSpeed: 150, rxSpeed: 170, ...negotiated }) }), 'slow-link'));
    assert.ok(get(run({ connection: on5({ txSpeed: 340, rxSpeed: 360, ...negotiated }) }), 'slow-link'));
    assert.equal(get(run({ connection: on5({ txSpeed: 400, rxSpeed: 430, ...negotiated }) }), 'slow-link'), undefined);
  });

  test('não dispara: taxa compatível; só uma direção baixa; sem as taxas; sinal fraco (aí o problema é o sinal)', () => {
    assert.equal(get(run({ connection: on5({ txSpeed: 780, rxSpeed: 866, ...negotiated }) }), 'slow-link'), undefined);
    assert.equal(get(run({ connection: on5({ txSpeed: 26, rxSpeed: 866, ...negotiated }) }), 'slow-link'), undefined);
    assert.equal(get(run({ connection: on5(negotiated) }), 'slow-link'), undefined);
    assert.equal(get(run({ connection: on5({ txSpeed: -1, rxSpeed: 0, linkSpeed: -1, ...negotiated }) }), 'slow-link'), undefined);
    const weak = run({ aps: home({ r5: { level: -76 } }), connection: on5({ rssi: -76, txSpeed: 26, rxSpeed: 29, ...negotiated }) });
    assert.equal(get(weak, 'slow-link'), undefined);
    assert.ok(get(weak, 'weak-signal'));
  });

  test('sem o teto (Android 10 ou anterior): compara com o celular mais modesto, para não acusar aparelho simples', () => {
    // celular de 1 fluxo e 40 MHz num roteador Wi-Fi 6: 150 Mb/s é o normal dele
    assert.equal(get(run({ connection: on5({ linkSpeed: 150 }) }), 'slow-link'), undefined);
    assert.equal(get(run({ connection: on24({ linkSpeed: 72 }) }), 'slow-link'), undefined);
    // idem para um Wi-Fi 6 de 1 fluxo e 40 MHz
    assert.equal(get(run({ connection: on5({ linkSpeed: 150, wifiStandard: 6 }) }), 'slow-link'), undefined);
    // 6 Mb/s com sinal ótimo não tem desculpa
    const slow = get(run({ connection: on5({ linkSpeed: 6 }) }), 'slow-link');
    assert.match(slow.text, /conversando a 6 Mb\/s/);
    assert.match(slow.text, /perto de 150 Mb\/s/);
  });

  test('rede WEP/TKIP fica em 54 Mb/s por definição: não é "lentidão"', () => {
    const out = run({ aps: home({ r5: { capabilities: CAPS.tkip } }), connection: on5({ txSpeed: 54, rxSpeed: 54, ...negotiated }) });
    assert.equal(get(out, 'slow-link'), undefined);
    assert.ok(get(out, 'weak-security'));
  });

  test('sem o AP na varredura não há com o que comparar', () => {
    assert.equal(get(run({ aps: [], connection: on5({ txSpeed: 6, rxSpeed: 6, ...negotiated }) }), 'slow-link'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('ponto de acesso mais forte da mesma rede', () => {
  const far = '14:eb:b6:8d:21:58'; // nó do quarto dos fundos, 2,4 GHz a −74 dBm
  const near = '14:eb:b6:8d:21:50'; // nó da sala, 2,4 GHz a −45 dBm
  const meshConn = (bssid, rssi, frequency) => ({ connected: true, ssid: 'Casa Oliveira', bssid, rssi, frequency });
  const runMesh = (connection, device = PHONE) => buildInsights({ aps: normalizeScan(mesh), connection, device, status: STATUS });

  test('preso ao nó distante: alerta com os dois sinais e a diferença', () => {
    const out = runMesh(meshConn(far, -74, 2412));
    const roam = get(out, 'stronger-ap');
    assert.equal(roam.severity, 'warning');
    assert.match(roam.text, /“Casa Oliveira” chega aqui com −45 dBm: 29 dB mais forte que o atual \(−74 dBm\)/);
    assert.match(roam.text, /desligue e ligue o Wi-Fi/);
    assert.deepEqual(roam.action, { label: 'Abrir o Wi-Fi do celular', kind: 'open-settings-wifi' });
    assertShape(out);
  });

  test('não dispara: já no nó mais forte; sinal atual bom; diferença pequena; rede sem outros pontos', () => {
    assert.equal(get(runMesh(meshConn(near, -45, 2412)), 'stronger-ap'), undefined);
    // nó do corredor a −63 dBm: o da sala é 18 dB mais forte, mas o sinal atual já é bom
    assert.equal(get(runMesh(meshConn('14:eb:b6:8d:21:54', -63, 2412)), 'stronger-ap'), undefined);
    const a = makeAp('00:11:22:33:44:10', 'Malha', -72, 2412, { wifiStandard: 6, capabilities: CAPS.good });
    const b = makeAp('00:77:88:99:aa:10', 'Malha', -66, 2462, { wifiStandard: 6, capabilities: CAPS.good });
    const conn = { connected: true, ssid: 'Malha', bssid: a.bssid, rssi: -72, frequency: 2412 };
    assert.equal(get(run({ aps: [a, b], connection: conn }), 'stronger-ap'), undefined);
    assert.ok(get(run({ aps: [a, { ...b, level: -58 }], connection: conn }), 'stronger-ap'));
    assert.equal(get(run({ aps: home({ r5: { level: -78 } }), connection: on5({ rssi: -78 }) }), 'stronger-ap'), undefined);
  });

  test('o outro rádio do MESMO roteador não é "outro ponto de acesso"', () => {
    // conectado no 5 GHz fraco com o 2,4 GHz do mesmo aparelho bem mais forte
    const out = run({ aps: home({ r5: { level: -78 } }), connection: on5({ rssi: -78 }) });
    assert.equal(get(out, 'stronger-ap'), undefined);
  });

  test('mesmo nome com outra segurança é outra rede', () => {
    const a = makeAp('00:11:22:33:44:10', 'INTELBRAS', -75, 2412, { capabilities: CAPS.wpa2 });
    const b = makeAp('00:77:88:99:aa:10', 'INTELBRAS', -50, 2462, { capabilities: CAPS.open });
    const out = run({ aps: [a, b], connection: { connected: true, ssid: 'INTELBRAS', bssid: a.bssid, rssi: -75, frequency: 2412 } });
    assert.equal(get(out, 'stronger-ap'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('nome de rede oculto', () => {
  test('a conexão diz que é oculta, ou o AP aparece sem nome: nota', () => {
    const byConn = run({ connection: on5({ hidden: true }) });
    assert.deepEqual(ids(byConn), ['hidden-ssid', 'all-good']);
    assert.equal(byConn[0].severity, 'info');
    assert.match(byConn[0].title, /não protege/);
    assert.match(byConn[0].text, /Qualquer analisador .* enxerga a rede do mesmo jeito/);
    assert.match(byConn[0].text, /WPA2 ou WPA3/);
    const byScan = run({ aps: home({ r5: { ssid: '' } }), connection: on5({ hidden: undefined }) });
    assert.ok(get(byScan, 'hidden-ssid'));
    assert.match(get(byScan, 'all-good').text, /“Casa”/); // o nome vem da conexão
  });

  test('não dispara: rede com nome; rede oculta do vizinho; sem conexão', () => {
    assert.equal(get(run(), 'hidden-ssid'), undefined);
    assert.equal(get(run({ aps: home({ extra: [neighbour(0, -60, 2462, { ssid: '' })] }) }), 'hidden-ssid'), undefined);
    assert.equal(get(run({ aps: home({ r5: { ssid: '' } }), connection: { connected: false, hidden: true } }), 'hidden-ssid'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('roteador de geração antiga', () => {
  const n24 = { wifiStandard: 4 };

  test('Wi-Fi 4 em 5 GHz: é certeza', () => {
    const out = run({ aps: home({ r24: n24, r5: { wifiStandard: 4, channelWidth: CW.W40, centerFreq0: 5190 } }) });
    const old = get(out, 'old-router');
    assert.equal(old.severity, 'info');
    assert.match(old.title, /Wi-Fi 4/);
    assert.match(old.text, /Wi-Fi 4 \(802\.11n, de 2009\)\./);
    assert.match(old.text, /taxa máxima é de 300 Mb\/s/); // 40 MHz, 2 fluxos
    assert.ok(get(out, 'all-good'));
  });

  test('Wi-Fi 4 só em 2,4 GHz, sinal forte e nenhum 5 GHz à vista: nota com a ressalva', () => {
    const out = run({ aps: [home({ r24: n24 })[0]], connection: on24() });
    const old = get(out, 'old-router');
    assert.match(old.text, /pelo que o celular enxerga daqui, só funciona em 2,4 GHz/);
    assert.match(old.text, /taxa máxima é de 144 Mb\/s/);
  });

  test('não dispara: o 2,4 GHz de um roteador Wi-Fi 5/6 também é "Wi-Fi 4"', () => {
    assert.equal(get(run({ aps: home({ r24: n24 }), connection: on24() }), 'old-router'), undefined);
    // 5 GHz com outro nome e MAC sem parentesco, mas a mesma raiz de nome
    const twin = makeAp('00:77:88:99:aa:01', 'Casa_5G', -60, 5180, { channelWidth: CW.W80, centerFreq0: 5210, wifiStandard: 5, capabilities: CAPS.good });
    assert.equal(get(run({ aps: [home({ r24: n24 })[0], twin], connection: on24() }), 'old-router'), undefined);
  });

  test('não dispara sem prova: celular sem 5 GHz; sinal fraco demais para o 5 GHz chegar; geração só presumida; roteador moderno', () => {
    const only24 = [home({ r24: n24 })[0]];
    assert.equal(get(run({ aps: only24, connection: on24(), device: PHONE_24 }), 'old-router'), undefined);
    for (const device of [null, {}, { bands: {} }]) assert.equal(get(run({ aps: only24, connection: on24(), device }), 'old-router'), undefined);
    assert.equal(get(run({ aps: [home({ r24: { ...n24, level: -68 } })[0]], connection: on24({ rssi: -68 }) }), 'old-router'), undefined);
    assert.equal(get(run({ aps: [home({ r24: { wifiStandard: undefined } })[0]], connection: on24() }), 'old-router'), undefined);
    assert.equal(get(run({ aps: [home()[0]], connection: on24() }), 'old-router'), undefined);
  });

  test('anterior ao Wi-Fi 4 (802.11b/g): outro título e 54 Mb/s de teto', () => {
    const out = run({ aps: [home({ r24: { wifiStandard: 1 } })[0]], connection: on24() });
    const old = get(out, 'old-router');
    assert.match(old.title, /muito antigo/);
    assert.match(old.text, /anterior ao Wi-Fi 4 \(802\.11b\/g\)/);
    assert.match(old.text, /taxa máxima é de 54 Mb\/s/);
  });

  test('roteador Wi-Fi 5 não é "geração antiga"', () => {
    const out = run({ aps: home({ r24: n24, r5: { wifiStandard: 5 } }) });
    assert.deepEqual(ids(out), ['all-good']);
  });

  test('a geração também vale quando vem dos elementos do beacon', () => {
    const ies = encodeIes({ frequency: 2412, widthMhz: 20, ht: { nss: 1, width40: false } });
    const out = run({ aps: [home({ r24: { wifiStandard: undefined, ies } })[0]], connection: on24() });
    assert.match(get(out, 'old-router').text, /taxa máxima é de 72 Mb\/s/); // 1 fluxo
  });
});

// ---------------------------------------------------------------------------
describe('o que o celular não alcança', () => {
  test('sem 5 GHz: nota', () => {
    const out = run({ aps: [home()[0]], connection: on24(), device: PHONE_24 });
    const no5 = get(out, 'phone-no-5ghz');
    assert.equal(no5.severity, 'info');
    assert.match(no5.text, /não alcança a faixa de 5 GHz/);
  });

  test('com 5 GHz, ou sem saber: nada', () => {
    assert.equal(get(run(), 'phone-no-5ghz'), undefined);
    for (const device of [undefined, null, {}, { bands: {} }, { bands: { b5: null } }]) assert.equal(get(run({ device }), 'phone-no-5ghz'), undefined);
  });

  test('sem 6 GHz e o próprio roteador anuncia um rádio de 6 GHz: nota com o canal', () => {
    const { b5 } = TRUTH.wifi7.own;
    // o celular sem 6 GHz não ouve os BSSIDs de 6 GHz: eles saem da lista, como no aparelho de verdade
    const heard = { ...wifi7, aps: wifi7.aps.filter((ap) => ap.frequency < 5925) };
    const connection = { connected: true, ssid: 'Lar Conectado', bssid: b5, rssi: -54, frequency: 5180 };
    const out = buildInsights({ aps: normalizeScan(heard), connection, device: PHONE, status: STATUS });
    const no6 = get(out, 'phone-no-6ghz');
    assert.equal(no6.severity, 'info');
    assert.match(no6.text, /Seu roteador também tem uma rede em 6 GHz \(canal 37\)/);
    // conectado na rede do vizinho: as redes de 6 GHz anunciadas são "por perto"
    const guest = { connected: true, ssid: 'VIVOFIBRA-BEE0', bssid: 'd8:c6:78:02:be:e0', rssi: -73, frequency: 2462 };
    const around = get(buildInsights({ aps: normalizeScan(heard), connection: guest, device: PHONE, status: STATUS }), 'phone-no-6ghz');
    assert.match(around.text, /Há 2 redes de 6 GHz por perto/);
  });

  test('sem 6 GHz e ninguém anunciando 6 GHz: nada (quase todo celular é assim)', () => {
    assert.equal(get(run(), 'phone-no-6ghz'), undefined);
    // o roteador anuncia o próprio rádio de 5 GHz no beacon de 2,4 GHz: não é 6 GHz
    const rnr5 = encodeIes({ frequency: 2412, widthMhz: 20, ht: { nss: 2, width40: false }, he: { nss: 2 }, rnr: [{ opClass: 128, channel: 36, bssid: HOME_5, ssid: 'Casa', sameSsid: true }] });
    assert.equal(get(run({ aps: home({ r24: { ies: rnr5 } }) }), 'phone-no-6ghz'), undefined);
    const rnr6 = encodeIes({ frequency: 2412, widthMhz: 20, ht: { nss: 2, width40: false }, he: { nss: 2 }, rnr: [{ opClass: 134, channel: 37, bssid: '00:11:22:33:44:12', ssid: 'Casa', sameSsid: true }] });
    assert.ok(get(run({ aps: home({ r24: { ies: rnr6 } }) }), 'phone-no-6ghz'));
    const connection = { connected: true, ssid: 'Familia Souza_5G', bssid: TRUTH.apartment.own.b5, rssi: -55, frequency: 5180 };
    assert.equal(get(buildInsights({ aps: normalizeScan(apartment), connection, device: PHONE, status: STATUS }), 'phone-no-6ghz'), undefined);
  });

  test('celular com 6 GHz: nada', () => {
    const connection = { connected: true, ssid: 'Lar Conectado', bssid: TRUTH.wifi7.own.b6, rssi: -60, frequency: 6135 };
    const out = buildInsights({ aps: normalizeScan(wifi7), connection, device: FLAGSHIP, status: STATUS });
    assert.equal(get(out, 'phone-no-6ghz'), undefined);
    assert.equal(get(out, 'phone-no-5ghz'), undefined);
  });
});

// ---------------------------------------------------------------------------
describe('limite de buscas do Android', () => {
  test('ligado: nota explicando como desligar nas opções do desenvolvedor', () => {
    const out = run({ status: { ...STATUS, throttled: true } });
    const t = get(out, 'scan-throttled');
    assert.equal(t.severity, 'info');
    assert.match(t.text, /4 vezes a cada 2 minutos/);
    assert.match(t.text, /Opções do desenvolvedor > Redes > desligue "Limitar busca por Wi-Fi"/);
    assert.match(t.text, /toque 7 vezes em "Número da versão"/);
    assert.equal('action' in t, false);
    // vale mesmo sem conexão
    assert.ok(get(run({ connection: { connected: false }, status: { ...STATUS, throttled: true } }), 'scan-throttled'));
  });

  test('Android 9 não tem a chave: o texto diz isso em vez de mandar procurar', () => {
    const old = get(run({ status: { ...STATUS, throttled: true }, device: { ...PHONE, sdk: 28 } }), 'scan-throttled');
    assert.match(old.text, /4 vezes a cada 2 minutos/);
    assert.match(old.text, /não há como desligar/);
    assert.doesNotMatch(old.text, /Limitar busca por Wi-Fi/);
    // Android 10 em diante, simulador (sdk 0) e celular desconhecido: o caminho normal
    for (const device of [{ ...PHONE, sdk: 29 }, { ...PHONE, sdk: 0 }, null]) {
      assert.match(get(run({ status: { ...STATUS, throttled: true }, device }), 'scan-throttled').text, /Limitar busca por Wi-Fi/);
    }
  });

  test('desligado, desconhecido (null) ou sem status: nada', () => {
    for (const status of [STATUS, { ...STATUS, throttled: null }, { ...STATUS, throttled: 'sim' }, {}, null, undefined]) {
      assert.equal(get(run({ status }), 'scan-throttled'), undefined);
    }
  });
});

// ---------------------------------------------------------------------------
describe('conjunto', () => {
  test('casa cheia de problemas: tudo aparece, do mais grave para o mais leve', () => {
    const r24 = {
      frequency: 2422, // canal 3
      channelWidth: CW.W40,
      centerFreq0: 2432,
      wifiStandard: 4,
      capabilities: '[WPA-PSK-TKIP][ESS][WPS]',
      level: -79,
      ies: encodeIes({ frequency: 2422, widthMhz: 40, rates: { legacy11b: true }, bssLoad: { stations: 28, utilization: 0.71 }, ht: { nss: 2, width40: true }, wpa: { akms: ['PSK'], ciphers: ['TKIP'] }, wps: { manufacturer: 'ACME', model: 'R1' } }),
    };
    const aps = [home({ r24 })[0], ...neighbours(3, -60, 2412), ...neighbours(3, -62, 2437, 3)];
    const connection = on24({ rssi: -79, frequency: 2422, hidden: true, linkSpeed: 54 });
    const out = run({ aps, connection, device: PHONE_24, status: { ...STATUS, throttled: true } });
    assertShape(out);
    assert.deepEqual(ids(out), [
      'weak-security',
      'weak-signal',
      'nonstandard-channel',
      'wide-channel-24',
      'busy-ap',
      'wps-on',
      'legacy-11b',
      'hidden-ssid',
      'phone-no-5ghz',
      'scan-throttled',
    ]);
    assert.deepEqual(out.map((i) => i.severity), ['critical', 'warning', 'warning', 'warning', 'warning', 'warning', 'info', 'info', 'info', 'info']);
  });

  test('todos os cenários, conectado em cada BSSID: formato válido e nenhuma exceção', () => {
    for (const [name, event] of Object.entries(ALL)) {
      const aps = normalizeScan(event, { sdk: 34 });
      for (const ap of aps) {
        for (const device of [PHONE, PHONE_24, FLAGSHIP, undefined]) {
          const connection = { connected: true, ssid: ap.ssid, bssid: ap.id, rssi: ap.rssi, frequency: ap.freq, linkSpeed: 65, txSpeed: 65, rxSpeed: 72, hidden: ap.hidden };
          const out = buildInsights({ aps, connection, device, status: { ...STATUS, throttled: true } });
          assertShape(out, `${name} ${ap.id}`);
          assert.ok(out.length >= 1);
          const serious = out.some((i) => i.severity === 'critical' || i.severity === 'warning');
          assert.equal(out.some((i) => i.id === 'all-good'), !serious, `${name} ${ap.id}`);
        }
      }
    }
  });

  test('aceita ScanAp crus', () => {
    const { b24 } = TRUTH.quietHouse.own;
    const connection = { connected: true, ssid: 'Sítio Boa Vista', bssid: b24, rssi: -52, frequency: 2437 };
    const raw = buildInsights({ aps: quietHouse.aps, connection, device: PHONE, status: STATUS });
    const normalized = buildInsights({ aps: normalizeScan(quietHouse), connection, device: PHONE, status: STATUS });
    assert.deepEqual(raw, normalized);
    assert.ok(get(raw, 'band-upgrade'));
    assert.ok(get(raw, 'wps-on'));
  });

  test('o BSSID da conexão pode vir em maiúsculas', () => {
    const out = run({ connection: on5({ bssid: HOME_5.toUpperCase() }) });
    assert.deepEqual(ids(out), ['all-good']);
  });

  test('escritório: conectado no AP da recepção em 5 GHz está tudo certo, com a nota do DFS', () => {
    const { b5 } = TRUTH.office.own;
    const connection = { connected: true, ssid: 'Corp', bssid: b5, rssi: -56, frequency: 5260 };
    const out = buildInsights({ aps: normalizeScan(office), connection, device: PHONE, status: STATUS });
    assert.deepEqual(ids(out), ['dfs-channel', 'all-good']);
    assert.match(get(out, 'all-good').text, /WPA2 Empresarial/);
  });

  test('não altera a entrada', () => {
    const aps = normalizeScan(apartment);
    const connection = { connected: true, ssid: 'Familia Souza', bssid: TRUTH.apartment.own.b24, rssi: -48, frequency: 2437 };
    const before = JSON.stringify([aps, connection, PHONE, STATUS]);
    buildInsights({ aps, connection, device: PHONE, status: STATUS });
    assert.equal(JSON.stringify([aps, connection, PHONE, STATUS]), before);
  });

  test('varreduras e conexões corrompidas ao acaso: formato válido e nenhuma exceção', () => {
    let seed = 0x1ce5eed;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const junk = [undefined, null, NaN, Infinity, -Infinity, -1, 0, 1e9, '', 'x', '5180', true, [], {}, [null], { id: 1 }, -200, 2484, 5935, 60480, 3.7];
    const apFields = ['bssid', 'ssid', 'level', 'frequency', 'channelWidth', 'centerFreq0', 'centerFreq1', 'capabilities', 'ageMs', 'wifiStandard', 'ies', 'mld'];
    const connFields = ['ssid', 'bssid', 'rssi', 'frequency', 'linkSpeed', 'txSpeed', 'rxSpeed', 'maxTxSpeed', 'maxRxSpeed', 'wifiStandard', 'securityType', 'hidden', 'connected'];
    const events = Object.values(ALL);
    for (let round = 0; round < 300; round++) {
      const event = pick(events);
      const aps = event.aps.map((ap) => {
        if (rnd() > 0.35) return ap;
        const copy = { ...ap };
        for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
          const field = pick(apFields);
          if (rnd() < 0.2) delete copy[field];
          else copy[field] = pick(junk);
        }
        return copy;
      });
      if (rnd() < 0.3) aps.push(pick(junk));
      const at = pick(event.aps);
      const connection = { connected: true, ssid: at.ssid, bssid: at.bssid, rssi: at.level, frequency: at.frequency, linkSpeed: 72, txSpeed: 72, rxSpeed: 86, maxTxSpeed: 866, maxRxSpeed: 866, wifiStandard: 5, securityType: 2, hidden: false };
      for (let k = 0; k < Math.floor(rnd() * 4); k++) connection[pick(connFields)] = pick(junk);
      const device = pick([PHONE, PHONE_24, FLAGSHIP, pick(junk), { bands: pick(junk), standards: pick(junk), sdk: pick(junk) }]);
      const status = pick([STATUS, { ...STATUS, throttled: pick(junk) }, pick(junk)]);
      for (const list of [aps, normalizeScan({ ts: TS, aps }, { sdk: 34 })]) {
        assertShape(buildInsights({ aps: list, connection: pick([connection, connection, pick(junk)]), device, status }), `rodada ${round}`);
      }
    }
  });

  test('entradas tortas: lista (talvez vazia), nunca exceção', () => {
    const junk = [undefined, null, 0, 'x', [], {}, { aps: 'x' }, { aps: [null, 4, {}, { bssid: 5 }], connection: 7, device: 'celular', status: [] }];
    for (const input of junk) {
      const out = buildInsights(input);
      assertShape(out);
      assert.deepEqual(out, []);
    }
    const odd = [
      { connection: { connected: true } },
      { connection: { connected: true, bssid: 12, rssi: 'forte', frequency: null, hidden: 'sim', linkSpeed: NaN, securityType: {} } },
      { aps: [{ bssid: 'aa:bb:cc:dd:ee:ff', level: NaN, frequency: 'x', ies: 'y', capabilities: 9 }], connection: { connected: true, bssid: 'aa:bb:cc:dd:ee:ff' } },
      { aps: quietHouse.aps, connection: { connected: true, bssid: TRUTH.quietHouse.own.b5, rssi: -200, frequency: -5, txSpeed: Infinity, maxTxSpeed: -1 }, device: { bands: 3, standards: 'x' }, status: { throttled: 1 } },
      { aps: apartment.aps.map((ap) => ({ ...ap, ies: [{ id: 'x', hex: 'zz' }, null, 5] })), connection: { connected: true, bssid: TRUTH.apartment.own.b24 } },
    ];
    for (const input of odd) assertShape(buildInsights(input));
  });
});
