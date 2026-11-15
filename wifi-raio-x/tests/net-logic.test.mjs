// Lógica pura das ferramentas de rede (app/js/ui/tools/net-logic.js): destino do ping,
// veredito da latência, palpite do tipo de aparelho e as contas do teste de velocidade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HOST_LENGTH,
  isIpv4,
  isIpv6,
  isHostname,
  isValidHost,
  parseHostInput,
  pingStats,
  pingVerdict,
  whereIsTheDelay,
  niceAxis,
  DEVICE_TYPES,
  DEVICE_SHORT,
  guessDeviceType,
  deviceName,
  ipToNumber,
  sortDevices,
  mergeDevice,
  summarizeDevices,
  speedVerdict,
  wifiVsInternet,
  WIFI_EFFICIENCY,
  gaugeMax,
  estimateTestBytes,
  LIGHT_MAX_BYTES,
  formatBytes,
  serverCity,
  sanitizeSpeedHistory,
  addSpeedResult,
  SPEED_HISTORY_MAX,
} from '../app/js/ui/tools/net-logic.js';
import { createManualClock, createSimBackend } from '../app/js/sim/backend.js';
import { MAC_EFFICIENCY } from '../app/js/core/phy.js';

const THIN = '\u202f';

// ---------------------------------------------------------------------------
// Destino do ping: os mesmos casos de android/.../PingHostTest.java
// ---------------------------------------------------------------------------

const VALID_HOSTS = [
  '8.8.8.8', '192.168.0.1', '0.0.0.0', '255.255.255.255', '10.0.0.254',
  '::1', 'fe80::1', '2001:4860:4860::8888', '2804:14c:1:2:3:4:5:6', '::ffff:192.168.0.1',
  'fe80::1c2d:3eff:fe4f:5a6b%wlan0', 'fe80::1%3',
  'google.com', 'www.uol.com.br', 'localhost', 'roteador', 'meu-pc.local', 'my_nas.lan',
  'a.b.c.d.e.f.g', 'xn--caf-dma.example', 'host123', '1e100.net', 'example.com.', '3com.com',
];

const OPTION_INJECTION = ['-c', '-f', '-h', '--help', '-I wlan0', '-s 65000 8.8.8.8', '-c1000000', '-', '8.8.8.8 -f', '8.8.8.8 -c 9999', '8.8.8.8\n-f', '8.8.8.8\t-f', 'host -n'];

const SHELL_ATTACKS = [
  '8.8.8.8; rm -rf /', '8.8.8.8 && reboot', '$(id)', '`id`', 'a|b', 'a>b', 'a<b', 'a&b',
  'google.com;ls', "'quoted'", '"quoted"', 'a\\b', 'a/b', '../../etc/passwd', 'a*b', 'a?b',
  '{a,b}', '~root', 'a=b', 'a#b', 'a!b', 'a@b', 'http://google.com', 'google.com:80', 'google.com/path',
  '[::1]', 'a%b', '\u0000', 'a\u0000b', 'café.com', '例え.jp', ' google.com', 'google.com ',
];

const MALFORMED = [
  null, undefined, 7, {}, '', '.', '..', 'a..b', '.com', '-host.com', 'host-.com', 'a.-b.c',
  '1.2.3', '1.2.3.4.5', '256.1.1.1', '999.999.999.999', '1.2.3.', '1', '12345', '0x7f.0.0.1.2',
  '1.2.3.4/24', ':', '1:2', 'fe80::1%', 'fe80::1%wlan0;id', 'fe80::1%wlan-0', '::g', '1::2::3::4::5::6::7::8::9',
  '12:34:56:78:9a:bc:de:f0:11', '::1.2.3', '1.2.3.4::',
];

test('isValidHost aceita endereços e nomes como o lado nativo', () => {
  for (const host of VALID_HOSTS) assert.equal(isValidHost(host), true, host);
  let longest = '';
  while (longest.length < 250) longest += 'abcdefghi.';
  assert.equal(isValidHost(`${longest.slice(0, 249)}.br`), true, 'nome de 252 caracteres');
});

test('isValidHost recusa opções, metacaracteres e texto malformado', () => {
  for (const host of [...OPTION_INJECTION, ...SHELL_ATTACKS, ...MALFORMED]) assert.equal(isValidHost(host), false, String(host));
  let tooLong = '';
  while (tooLong.length <= MAX_HOST_LENGTH) tooLong += 'abcdefghi.';
  assert.equal(isValidHost(`${tooLong}com`), false, 'mais de 253 caracteres');
  assert.equal(isValidHost(`${'a'.repeat(64)}.com`), false, 'rótulo com mais de 63 letras');
  assert.equal(isValidHost(`${'a'.repeat(63)}.com`), true, 'rótulo com 63 letras');
});

test('as três formas de endereço, uma a uma', () => {
  assert.equal(isIpv4('1.2.3.4'), true);
  assert.equal(isIpv4('01.002.3.4'), true, 'zeros à esquerda passam, como em LanRange.parse');
  assert.equal(isIpv4('1.2.3.256'), false);
  assert.equal(isIpv4('1.2.3.4 '), false);
  assert.equal(isIpv6('::'), true);
  assert.equal(isIpv6('1:2:3:4:5:6:7:8'), true);
  assert.equal(isIpv6('1:2:3:4:5:6:7:8:9'), false);
  assert.equal(isIpv6('::ffff:1.2.3'), false);
  assert.equal(isHostname('a_b.c-d.e'), true);
  assert.equal(isHostname('a..b'), false);
  assert.equal(isHostname('casa.123'), false, 'o último rótulo não pode ser só número');
});

test('o que a tela aceita o simulador também aceita (nunca "host inválido" depois de validar)', async (t) => {
  const clock = createManualClock();
  const backend = createSimBackend({ emit: () => {}, clock });
  t.after(() => backend.dispose());
  const all = [...VALID_HOSTS, ...OPTION_INJECTION, ...SHELL_ATTACKS, ...MALFORMED];
  for (const host of all) {
    if (!isValidHost(host)) continue;
    let error = null;
    try {
      const pending = backend.callAsync('ping', { host, count: 1, timeoutMs: 200 });
      backend.call('cancel', { op: 'ping' });
      await pending;
    } catch (err) {
      error = String(err.message);
    }
    assert.notEqual(error, 'host inválido', host);
  }
  // e o inverso para o que é claramente lixo: os dois recusam
  for (const host of ['', 'dois nomes', '-c 5', 'a..b', '1.2.3', 'x'.repeat(300)]) {
    assert.equal(isValidHost(host), false, host);
    await assert.rejects(backend.callAsync('ping', { host, count: 1, timeoutMs: 200 }), /host inválido/);
  }
});

test('parseHostInput limpa o que foi colado e explica o erro', () => {
  const ok = (input, host) => assert.deepEqual(parseHostInput(input), { host, error: null }, input);
  ok('google.com', 'google.com');
  ok('  Google.COM  ', 'google.com');
  ok('https://www.exemplo.com.br/pagina?x=1#topo', 'www.exemplo.com.br');
  ok('http://192.168.0.1:8080/admin', '192.168.0.1');
  ok('exemplo.com:443', 'exemplo.com');
  ok('usuario@exemplo.com', 'exemplo.com');
  ok('[2606:4700:4700::1111]:443', '2606:4700:4700::1111');
  ok('[::1]', '::1');
  ok('FE80::1%wlan0', 'fe80::1%wlan0');
  ok('1.1.1.1', '1.1.1.1');
  ok('roteador', 'roteador');

  const bad = (input, pattern) => {
    const out = parseHostInput(input);
    assert.equal(out.host, null, String(input));
    assert.match(out.error, pattern, String(input));
  };
  bad('', /Digite/);
  bad('   ', /Digite/);
  bad(null, /Digite/);
  bad('https://', /Digite/);
  bad('-c 5', /hífen/);
  bad('dois nomes', /espaços/);
  bad('1.2.3', /quatro números/);
  bad('256.1.1.1', /quatro números/);
  bad('café.com', /sem acento/);
  bad('a..b', /não parece um endereço/);
  bad('a;b', /não parece um endereço/);
  bad('fe80:', /IPv6/);
  bad('x'.repeat(300), /longo demais/);

  // tudo o que passa pela limpeza é aceito pelo celular
  for (const input of ['https://a.b/c', 'x_y.local', '10.0.0.1:53', '[fe80::1%wlan0]']) {
    const { host } = parseHostInput(input);
    assert.equal(isValidHost(host), true, input);
  }
});

// ---------------------------------------------------------------------------
// Latência
// ---------------------------------------------------------------------------

test('pingStats faz as contas do resumo do celular', () => {
  const replies = [
    { seq: 1, ok: true, ms: 10 },
    { seq: 2, ok: true, ms: 14 },
    { seq: 3, ok: false },
    { seq: 4, ok: true, ms: 12 },
  ];
  assert.deepEqual(pingStats(replies), { sent: 4, received: 3, lossPct: 25, min: 10, avg: 12, max: 14, jitter: 3 });
  // fora de ordem dá no mesmo; resposta que chega depois de "perdida" vale como resposta
  const shuffled = [replies[3], { seq: 3, ok: false }, replies[0], { seq: 3, ok: true, ms: 20 }, replies[1]];
  assert.deepEqual(pingStats(shuffled), { sent: 4, received: 4, lossPct: 0, min: 10, avg: 14, max: 20, jitter: 6 });
  // uma "perda" atrasada não apaga a resposta que já chegou
  assert.equal(pingStats([{ seq: 1, ok: true, ms: 5 }, { seq: 1, ok: false }]).received, 1);
  // `sent` informado: pacotes ainda sem resposta contam como perdidos
  assert.deepEqual(pingStats([{ seq: 1, ok: true, ms: 5 }], 4), { sent: 4, received: 1, lossPct: 75, min: 5, avg: 5, max: 5 });
  assert.deepEqual(pingStats([]), { sent: 0, received: 0, lossPct: 0 });
  assert.deepEqual(pingStats(null), { sent: 0, received: 0, lossPct: 0 });
  assert.deepEqual(pingStats([{ seq: 0, ok: true, ms: 1 }, { seq: 'x' }, null]), { sent: 0, received: 0, lossPct: 0 });
  assert.equal(pingStats([{ seq: 1, ok: true, ms: 1.2345 }, { seq: 2, ok: true, ms: 2.3456 }, { seq: 3, ok: false }]).lossPct, 33.3);
});

test('pingStats bate com o resumo do simulador', async (t) => {
  const clock = createManualClock();
  const events = [];
  const backend = createSimBackend({ emit: (name, data) => name === 'ping' && events.push(data), clock, walk: 'still' });
  t.after(() => backend.dispose());
  const gateway = backend.call('connection').gateway;
  const pending = backend.callAsync('ping', { host: gateway, count: 20, timeoutMs: 1000 });
  clock.advance(10_000);
  const summary = await pending;
  const mine = pingStats(events, summary.sent);
  for (const key of ['sent', 'received', 'lossPct', 'min', 'avg', 'max', 'jitter']) assert.equal(mine[key], summary[key], key);
});

test('pingVerdict: internet', () => {
  const v = (stats) => pingVerdict(stats, { target: 'internet' });
  const great = v({ sent: 25, received: 25, lossPct: 0, avg: 18, min: 15, max: 24, jitter: 2 });
  assert.equal(great.level, 'great');
  assert.equal(great.tone, 'good');
  assert.equal(great.title, 'Ótimo para chamadas e jogos');
  assert.match(great.text, new RegExp(`Média de 18${THIN}ms`));
  assert.match(great.text, /nenhuma perda/);

  assert.equal(v({ sent: 25, received: 25, lossPct: 0, avg: 55, jitter: 8 }).level, 'good');
  assert.equal(v({ sent: 25, received: 25, lossPct: 0, avg: 20, jitter: 15 }).level, 'good', 'variação alta derruba um degrau');
  assert.equal(v({ sent: 25, received: 25, lossPct: 0, avg: 120, jitter: 10 }).level, 'fair');
  const poor = v({ sent: 25, received: 25, lossPct: 0, avg: 240, jitter: 10 });
  assert.equal(poor.level, 'poor');
  assert.equal(poor.tone, 'critical');
  assert.match(poor.title, /Pode travar em chamadas de vídeo/);

  // perda pesa mais que o tempo
  const lossy = v({ sent: 20, received: 16, lossPct: 20, avg: 18, jitter: 2 });
  assert.equal(lossy.level, 'poor');
  assert.match(lossy.title, /instável/);
  assert.match(lossy.text, /4 respostas perdidas em 20 \(20%\)/);
  const oneLost = v({ sent: 25, received: 24, lossPct: 4, avg: 18, jitter: 2 });
  assert.equal(oneLost.level, 'fair', 'uma perda em 25 já não é "ótimo"');
  assert.equal(oneLost.title, 'Resposta rápida, mas perdeu resposta');
  assert.match(oneLost.text, /Uma perda isolada pode ser acaso/);
  assert.doesNotMatch(oneLost.text, /Sites e vídeos funcionam/, 'o texto fala da perda, não do tempo');
  assert.equal(v({ sent: 50, received: 49, lossPct: 2, avg: 18, jitter: 2 }).level, 'good');
  assert.match(v({ sent: 50, received: 49, lossPct: 2, avg: 18, jitter: 2 }).text, /1 resposta perdida em 50 \(2%\)/);
  assert.equal(v({ sent: 10, received: 9, lossPct: 10, avg: 18, jitter: 2 }).level, 'fair', 'uma única perda em 10 não vira "instável"');

  const none = v({ sent: 10, received: 0, lossPct: 100 });
  assert.equal(none.level, 'none');
  assert.equal(none.tone, 'critical');
  assert.equal(none.title, 'Sem resposta');
  assert.equal(v({ sent: 0, received: 0, lossPct: 0 }).level, 'empty');
  assert.equal(v(null).level, 'empty');
  // uma resposta só: sem variação para contar
  const single = v({ sent: 1, received: 1, lossPct: 0, avg: 12, min: 12, max: 12 });
  assert.equal(single.level, 'great');
  assert.doesNotMatch(single.text, /variação/);
});

test('pingVerdict: dentro de casa a régua é outra', () => {
  const v = (stats, target = 'gateway') => pingVerdict(stats, { target });
  assert.equal(v({ sent: 25, received: 25, lossPct: 0, avg: 3.2, jitter: 1.1 }).level, 'great');
  assert.match(v({ sent: 25, received: 25, lossPct: 0, avg: 3.2, jitter: 1.1 }).text, /Média de 3,2/);
  assert.equal(v({ sent: 25, received: 25, lossPct: 0, avg: 18, jitter: 6 }).level, 'good', '18 ms é ótimo para a internet e só bom para o roteador');
  const fair = v({ sent: 25, received: 25, lossPct: 0, avg: 45, jitter: 12 });
  assert.equal(fair.level, 'fair');
  assert.match(fair.title, /oscilando/);
  // tempo ótimo com uma perda: o texto não diz que o tempo está ruim
  const quickButLost = v({ sent: 25, received: 24, lossPct: 4, avg: 4.4, jitter: 1.9 });
  assert.equal(quickButLost.level, 'fair');
  assert.equal(quickButLost.title, 'Wi-Fi rápido, mas perdeu resposta');
  assert.doesNotMatch(quickButLost.text, /o normal é ficar abaixo/);
  assert.match(v({ sent: 40, received: 38, lossPct: 5, avg: 4, jitter: 1 }).title, /perdeu respostas/);
  assert.match(v({ sent: 50, received: 49, lossPct: 2, avg: 4, jitter: 1 }).text, /perda isolada em tantas medidas não preocupa/);
  const poor = v({ sent: 25, received: 25, lossPct: 0, avg: 120, jitter: 60 });
  assert.equal(poor.level, 'poor');
  assert.match(poor.text, /Canais/);
  assert.match(v({ sent: 10, received: 0, lossPct: 100 }).text, /roteadores ignoram/);
  assert.match(v({ sent: 10, received: 0, lossPct: 100 }, 'lan').text, /dormindo/);
  assert.match(v({ sent: 25, received: 25, lossPct: 0, avg: 3, jitter: 1 }, 'lan').title, /Aparelho/);
});

test('whereIsTheDelay compara o roteador com a internet', () => {
  const s = (avg, extra = {}) => ({ sent: 20, received: avg == null ? 0 : 20, lossPct: avg == null ? 100 : 0, ...(avg == null ? {} : { avg }), ...extra });
  assert.equal(whereIsTheDelay(null, s(20)), null);
  assert.equal(whereIsTheDelay(s(3), null), null);
  assert.equal(whereIsTheDelay(s(3), { sent: 0, received: 0 }), null);
  assert.equal(whereIsTheDelay(s(3), s(22)).where, 'none');
  assert.equal(whereIsTheDelay(s(4), s(140)).where, 'internet');
  assert.match(whereIsTheDelay(s(4), s(140)).title, /internet, não no Wi-Fi/);
  assert.equal(whereIsTheDelay(s(70), s(95)).where, 'wifi');
  assert.equal(whereIsTheDelay(s(35), s(160)).where, 'wifi', 'roteador acima de 30 ms já é problema de Wi-Fi');
  assert.equal(whereIsTheDelay(s(5, { lossPct: 20, received: 16 }), s(40)).where, 'wifi', 'perda até o roteador');
  const down = whereIsTheDelay(s(3), s(null));
  assert.equal(down.where, 'internet');
  assert.equal(down.tone, 'critical');
  assert.equal(whereIsTheDelay(s(null), s(20)).where, 'unknown');
  assert.equal(whereIsTheDelay(s(null), s(null)).where, 'unknown');
});

test('niceAxis devolve escalas redondas', () => {
  assert.deepEqual(niceAxis(37), { max: 40, step: 10, ticks: [0, 10, 20, 30, 40] });
  assert.deepEqual(niceAxis(8), { max: 8, step: 2, ticks: [0, 2, 4, 6, 8] });
  assert.deepEqual(niceAxis(0.8), { max: 0.8, step: 0.2, ticks: [0, 0.2, 0.4, 0.6, 0.8] });
  assert.equal(niceAxis(181).max, 200);
  assert.equal(niceAxis(100).max, 100);
  assert.equal(niceAxis(101, 3).max, 150);
  for (const bad of [0, -3, NaN, undefined]) assert.equal(niceAxis(bad).max, 1, String(bad));
  for (const v of [0.3, 1, 7, 13, 99, 250, 1234, 4999]) {
    const axis = niceAxis(v);
    assert.ok(axis.max >= v, `cabe ${v}`);
    assert.ok(axis.ticks.length >= 3 && axis.ticks.length <= 7, `${v}: ${axis.ticks.length} marcas`);
    assert.equal(axis.ticks[0], 0);
    assert.equal(axis.ticks[axis.ticks.length - 1], axis.max);
  }
});

// ---------------------------------------------------------------------------
// Dispositivos
// ---------------------------------------------------------------------------

test('guessDeviceType: os aparelhos da casa virtual e nomes comuns', () => {
  const type = (host, extra = {}) => guessDeviceType({ host, ...extra }).type;
  const cases = {
    'Smart TV da Sala': 'tv',
    'notebook-da-ana': 'computer',
    'EPSON L3250 Series': 'printer',
    'Echo Dot da Cozinha': 'speaker',
    'Chromecast do Quarto': 'tv',
    'Galaxy-A54-de-Marcos': 'phone',
    'iPhone de Júlia': 'phone',
    'Deco do Corredor': 'network',
    'PlayStation-5': 'console',
    'Câmera da Garagem': 'camera',
    'Tablet das Crianças': 'tablet',
    'SRV-ARQUIVOS': 'server',
    'IMPRESSORA-RECEPCAO': 'printer',
    'PC-RECEPCAO': 'computer',
    'NB-FINANCEIRO-03': 'computer',
    'TV Sala de Reunião': 'tv',
    'Relógio de Ponto': 'iot',
    'AP-Teto-1': 'network',
    'Galaxy-Tab-S9': 'tablet',
    'iPad-de-Bia': 'tablet',
    'DESKTOP-4F2K9QH': 'computer',
    'MacBook-Pro-de-Leo': 'computer',
    'android-3f2a9c': 'phone',
    'ESP_4F2A1C': 'iot',
    'Lâmpada da varanda': 'iot',
    'XBOX-SERIES-X': 'console',
    'HP-LaserJet-M110': 'printer',
    'raspberrypi': 'server',
    'Apple-TV': 'tv',
    'coisa-qualquer-123': 'unknown',
  };
  for (const [host, expected] of Object.entries(cases)) assert.equal(type(host), expected, host);
  assert.deepEqual(Object.keys(DEVICE_SHORT), Object.keys(DEVICE_TYPES), 'todo tipo tem o nome curto');
  for (const t of Object.keys(DEVICE_TYPES)) assert.ok(DEVICE_SHORT[t].length <= 13 && DEVICE_SHORT[t].length <= DEVICE_TYPES[t].length, t);
});

test('guessDeviceType: marcações, fabricante e ausência de pistas', () => {
  assert.deepEqual(guessDeviceType({ host: 'Smart TV', gateway: true }), { type: 'router', label: 'Roteador', short: 'Roteador', source: 'flag' });
  assert.deepEqual(guessDeviceType({ host: 'Pixel-7', self: true }), { type: 'phone', label: 'Celular', short: 'Celular', source: 'flag' });
  assert.deepEqual(guessDeviceType({ host: 'notebook', vendor: 'Seiko Epson Corporation' }), { type: 'computer', label: 'Computador', short: 'Computador', source: 'name' }, 'o nome vale mais que o fabricante');
  assert.deepEqual(guessDeviceType({ vendor: 'Seiko Epson Corporation' }), { type: 'printer', label: 'Impressora', short: 'Impressora', source: 'vendor' });
  assert.deepEqual(guessDeviceType({ host: 'Smart TV da Sala' }), { type: 'tv', label: 'TV ou streaming', short: 'TV', source: 'name' });
  assert.equal(guessDeviceType({ vendor: 'Espressif Inc.' }).type, 'iot');
  assert.equal(guessDeviceType({ vendor: 'TP-Link Corporation Limited' }).type, 'network');
  assert.equal(guessDeviceType({ vendor: 'Sony Interactive Entertainment Inc.' }).type, 'console');
  assert.equal(guessDeviceType({ vendor: 'Intel Corporate' }).type, 'computer');
  assert.equal(guessDeviceType({ vendor: 'Apple, Inc.' }).type, 'unknown', 'Apple pode ser celular, tablet ou computador: sem palpite');
  assert.equal(guessDeviceType({ vendor: 'Samsung Electronics Co.,Ltd' }).type, 'unknown');
  assert.deepEqual(guessDeviceType({}), { type: 'unknown', label: 'Aparelho', short: 'Aparelho', source: null });
  assert.deepEqual(guessDeviceType(null), { type: 'unknown', label: 'Aparelho', short: 'Aparelho', source: null });
  assert.equal(guessDeviceType({ host: '   ', vendor: '' }).type, 'unknown');
  // texto hostil é só texto
  assert.equal(typeof guessDeviceType({ host: '<b onmouseover=alert(3)>tv</b>' }).type, 'string');
});

test('deviceName limpa o nome sem inventar', () => {
  assert.equal(deviceName('notebook-da-ana.local'), 'notebook-da-ana');
  assert.equal(deviceName('Pixel-7.lan'), 'Pixel-7');
  assert.equal(deviceName('nas.home.arpa.'), 'nas');
  assert.equal(deviceName('menuvivofibra.br'), 'menuvivofibra.br');
  assert.equal(deviceName('  TV \u0007 da\tSala  '), 'TV da Sala');
  assert.equal(deviceName('192.168.0.7'), null, 'um IP não é nome');
  assert.equal(deviceName('fe80::1'), null);
  assert.equal(deviceName(''), null);
  assert.equal(deviceName('   '), null);
  assert.equal(deviceName(null), null);
  assert.equal(deviceName(42), null);
  assert.equal(deviceName('.local'), '.local', 'só o sufixo: fica como veio');
  assert.equal(deviceName('<b onmouseover=alert(3)>tv</b>'), '<b onmouseover=alert(3)>tv</b>', 'não mexe em texto hostil: quem mostra é que usa textContent');
});

test('sortDevices, ipToNumber, mergeDevice e summarizeDevices', () => {
  assert.ok(ipToNumber('192.168.0.9') < ipToNumber('192.168.0.10'));
  assert.ok(ipToNumber('10.0.0.1') < ipToNumber('192.168.0.1'));
  assert.equal(ipToNumber('lixo'), Number.MAX_SAFE_INTEGER);
  assert.equal(ipToNumber('0.0.0.0'), 0);

  const list = [
    { ip: '192.168.0.20', host: 'TV' },
    { ip: '192.168.0.103', self: true },
    { ip: '192.168.0.3' },
    { ip: '192.168.0.1', gateway: true },
    { ip: '192.168.0.100', host: 'notebook' },
  ];
  const sorted = sortDevices(list);
  assert.deepEqual(sorted.map((d) => d.ip), ['192.168.0.1', '192.168.0.103', '192.168.0.3', '192.168.0.20', '192.168.0.100']);
  assert.notEqual(sorted, list, 'devolve uma lista nova');
  assert.deepEqual(sortDevices(null), []);

  let devices = [];
  devices = mergeDevice(devices, { ip: '192.168.0.5', ms: 12.3 });
  devices = mergeDevice(devices, { ip: '192.168.0.6', host: 'TV', mac: 'AA:BB:CC:00:11:22', ms: 4, extra: 'ignorado' });
  assert.deepEqual(devices, [
    { ip: '192.168.0.5', ms: 12.3 },
    { ip: '192.168.0.6', host: 'TV', mac: 'aa:bb:cc:00:11:22', ms: 4 },
  ]);
  // aviso repetido completa sem apagar
  const again = mergeDevice(devices, { ip: '192.168.0.5', host: 'impressora' });
  assert.deepEqual(again[0], { ip: '192.168.0.5', ms: 12.3, host: 'impressora' });
  assert.equal(again.length, 2);
  assert.notEqual(again, devices);
  // lixo não entra
  assert.equal(mergeDevice(devices, null), devices);
  assert.equal(mergeDevice(devices, { host: 'sem ip' }), devices);
  assert.equal(mergeDevice(devices, { ip: 7 }), devices);
  assert.deepEqual(mergeDevice([], { ip: '10.0.0.2', ms: -1, host: '  ', mac: '', self: 'sim', gateway: 1 }), [{ ip: '10.0.0.2' }]);

  assert.deepEqual(summarizeDevices(list), { total: 5, named: 2, unnamed: 3, withMac: 0, others: 3 });
  assert.deepEqual(summarizeDevices([{ ip: '1.1.1.1', host: '1.1.1.1', mac: 'aa:bb:cc:dd:ee:ff' }]), { total: 1, named: 0, unnamed: 1, withMac: 1, others: 1 });
  assert.deepEqual(summarizeDevices(null), { total: 0, named: 0, unnamed: 0, withMac: 0, others: 0 });
});

// ---------------------------------------------------------------------------
// Velocidade
// ---------------------------------------------------------------------------

test('speedVerdict descreve o que dá para fazer', () => {
  assert.equal(speedVerdict({ downMbps: 480, upMbps: 240, latencyMs: 12 }).level, 'excellent');
  assert.equal(speedVerdict({ downMbps: 95, upMbps: 45, latencyMs: 12 }).level, 'fast');
  assert.equal(speedVerdict({ downMbps: 22, upMbps: 9, latencyMs: 18 }).level, 'ok');
  const tight = speedVerdict({ downMbps: 7, upMbps: 4, latencyMs: 30 });
  assert.equal(tight.level, 'tight');
  assert.equal(tight.tone, 'warning');
  const slow = speedVerdict({ downMbps: 1.2, upMbps: 0.4, latencyMs: 60 });
  assert.equal(slow.level, 'slow');
  assert.equal(slow.tone, 'critical');
  // upload baixo e resposta demorada entram como ressalva e tiram o "tudo certo"
  const lowUp = speedVerdict({ downMbps: 120, upMbps: 1.5, latencyMs: 12 });
  assert.equal(lowUp.level, 'fast');
  assert.equal(lowUp.tone, 'warning');
  assert.match(lowUp.text, /upload/);
  const laggy = speedVerdict({ downMbps: 120, upMbps: 50, latencyMs: 180 });
  assert.equal(laggy.tone, 'warning');
  assert.match(laggy.text, /demorada/);
  assert.equal(speedVerdict({}).level, 'empty');
  assert.equal(speedVerdict(null).level, 'empty');
  assert.equal(speedVerdict({ downMbps: NaN }).level, 'empty');
  assert.equal(speedVerdict({ downMbps: 0 }).level, 'slow');
});

test('wifiVsInternet: o gargalo é o Wi-Fi ou o plano?', () => {
  assert.equal(WIFI_EFFICIENCY, MAC_EFFICIENCY, 'a mesma eficiência de core/phy.js');
  // link de 866 Mb/s aguenta ≈ 520; a internet entregou 280: o limite é o plano
  const plan = wifiVsInternet({ downMbps: 280, linkMbps: 866 });
  assert.equal(plan.bottleneck, 'plan');
  assert.equal(plan.wifiMbps, 519.6);
  assert.match(plan.text, new RegExp(`aguenta ≈${THIN}520${THIN}Mb/s; a internet entregou 280${THIN}Mb/s`));
  assert.match(plan.title, /limite é a internet/);
  // link de 86 Mb/s aguenta ≈ 52; o teste deu 48: o limite é o Wi-Fi
  const wifi = wifiVsInternet({ downMbps: 48, linkMbps: 86.7 });
  assert.equal(wifi.bottleneck, 'wifi');
  assert.equal(wifi.tone, 'warning');
  assert.match(wifi.title, /limite aqui é o Wi-Fi/);
  // teste acima da estimativa (o Wi-Fi rendeu mais que os 60%): continua sendo o Wi-Fi
  assert.equal(wifiVsInternet({ downMbps: 70, linkMbps: 100 }).bottleneck, 'wifi');
  assert.equal(wifiVsInternet({ downMbps: 40, linkMbps: 100 }).bottleneck, 'close');
  assert.equal(wifiVsInternet({ downMbps: 20, linkMbps: 100 }).bottleneck, 'plan');
  // velocidades em Gb/s também são escritas direito
  assert.match(wifiVsInternet({ downMbps: 600, linkMbps: 2402 }).text, new RegExp(`≈${THIN}1,4${THIN}Gb/s`));
  for (const input of [{}, { downMbps: 100 }, { downMbps: 100, linkMbps: 0 }, { downMbps: 0, linkMbps: 100 }, { downMbps: 100, linkMbps: null }, undefined]) {
    const out = wifiVsInternet(input);
    assert.equal(out.bottleneck, 'unknown');
    assert.equal(out.wifiMbps, null);
  }
});

test('gaugeMax, estimateTestBytes e formatBytes', () => {
  assert.equal(gaugeMax(0), 10);
  assert.equal(gaugeMax(8), 10);
  assert.equal(gaugeMax(9.5), 25);
  assert.equal(gaugeMax(86), 100);
  assert.equal(gaugeMax(95), 250);
  assert.equal(gaugeMax(480), 1000);
  assert.equal(gaugeMax(99999), 10000);
  assert.equal(gaugeMax(NaN), 10);

  // completo: 8 s em cada direção, sem teto -> 1 MB por Mb/s
  assert.equal(estimateTestBytes('full', 100, 50), 150e6);
  assert.equal(estimateTestBytes('full', 300), 450e6, 'sem upload conhecido, supõe metade');
  // leve: 3 s ou o teto de 25 MB + 10 MB
  assert.equal(estimateTestBytes('light', 300, 150), LIGHT_MAX_BYTES);
  assert.equal(estimateTestBytes('light', 10, 2), 10 * 125000 * 3 + 2 * 125000 * 3);
  assert.equal(LIGHT_MAX_BYTES, 35e6);
  assert.equal(estimateTestBytes('full'), null);
  assert.equal(estimateTestBytes('light', 0, 10), null);
  assert.equal(estimateTestBytes('outro', 100, 50), 150e6, 'modo desconhecido vale como completo');

  assert.equal(formatBytes(0), `0${THIN}B`);
  assert.equal(formatBytes(640), `640${THIN}B`);
  assert.equal(formatBytes(5120), `5,1${THIN}kB`);
  assert.equal(formatBytes(312_400_000), `312${THIN}MB`);
  assert.equal(formatBytes(3_540_000), `3,5${THIN}MB`);
  assert.equal(formatBytes(1_520_000_000), `1,52${THIN}GB`);
  assert.equal(formatBytes(999_600_000), `1,00${THIN}GB`);
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(NaN), '—');
});

test('serverCity traduz a sigla da Cloudflare', () => {
  assert.equal(serverCity('GRU'), 'São Paulo');
  assert.equal(serverCity(' gig '), 'Rio de Janeiro');
  assert.equal(serverCity('XYZ'), null);
  assert.equal(serverCity(null), null);
});

test('histórico do teste de velocidade: valida, ordena e limita', () => {
  const rec = (ts, extra = {}) => ({ ts, mode: 'full', downMbps: 280.123, upMbps: 140.456, latencyMs: 12.34, jitterMs: 1.26, bytesDown: 280e6, bytesUp: 140e6, server: 'gru', ssid: 'CasaDaAna', linkMbps: 866.7, ...extra });
  const clean = sanitizeSpeedHistory([rec(2000), rec(3000, { mode: 'light' }), rec(1000)]);
  assert.deepEqual(clean.map((r) => r.ts), [3000, 2000, 1000], 'do mais recente para o mais antigo');
  assert.deepEqual(clean[1], { ts: 2000, mode: 'full', downMbps: 280.12, upMbps: 140.46, bytesDown: 280e6, bytesUp: 140e6, latencyMs: 12.3, jitterMs: 1.3, server: 'GRU', ssid: 'CasaDaAna', linkMbps: 866.7 });
  assert.equal(clean[0].mode, 'light');

  // lixo no armazenamento não derruba a tela
  assert.deepEqual(sanitizeSpeedHistory(null), []);
  assert.deepEqual(sanitizeSpeedHistory('texto'), []);
  assert.deepEqual(sanitizeSpeedHistory([null, 7, {}, { ts: 1 }, { ts: 'ontem', downMbps: 1, upMbps: 1 }, { ts: 5, downMbps: -1, upMbps: 1 }, { ts: 5, downMbps: Infinity, upMbps: 1 }]), []);
  const odd = sanitizeSpeedHistory([{ ts: 9, mode: 'turbo', downMbps: 10, upMbps: 5, server: '<b>', ssid: 'x'.repeat(65), latencyMs: -3, linkMbps: 0, bytesDown: 'muito' }]);
  assert.deepEqual(odd, [{ ts: 9, mode: 'full', downMbps: 10, upMbps: 5, bytesDown: 0, bytesUp: 0 }]);
  // nome de rede hostil fica como texto (quem mostra usa textContent)
  assert.equal(sanitizeSpeedHistory([rec(1, { ssid: '<img src=x onerror=alert(1)>' })])[0].ssid, '<img src=x onerror=alert(1)>');

  let history = [];
  for (let i = 1; i <= SPEED_HISTORY_MAX + 4; i++) history = addSpeedResult(history, rec(i * 1000));
  assert.equal(history.length, SPEED_HISTORY_MAX);
  assert.equal(history[0].ts, (SPEED_HISTORY_MAX + 4) * 1000);
  assert.equal(history[history.length - 1].ts, 5000);
  assert.equal(addSpeedResult(history, { ok: false }).length, SPEED_HISTORY_MAX, 'resultado inválido não entra');
  assert.deepEqual(addSpeedResult(null, rec(7)).map((r) => r.ts), [7]);
});

test('histórico do teste de velocidade: os testes da demonstração têm lista própria', async () => {
  const { speedHistoryKey, SPEED_HISTORY_KEY, SPEED_HISTORY_DEMO_KEY } = await import('../app/js/ui/tools/net-logic.js');
  assert.equal(SPEED_HISTORY_KEY, 'speed.history');
  assert.equal(SPEED_HISTORY_DEMO_KEY, 'speed.history.demo');
  assert.notEqual(SPEED_HISTORY_KEY, SPEED_HISTORY_DEMO_KEY);
  // só o simulador escreve na lista da demonstração
  assert.equal(speedHistoryKey('sim'), SPEED_HISTORY_DEMO_KEY);
  assert.equal(speedHistoryKey('native'), SPEED_HISTORY_KEY);
  // sem saber quem mediu, nunca cai na lista da demonstração por acaso (nem o contrário por um valor estranho)
  for (const odd of [null, undefined, '', 'SIM', 'demo', 0, {}]) assert.equal(speedHistoryKey(odd), SPEED_HISTORY_KEY);
});
