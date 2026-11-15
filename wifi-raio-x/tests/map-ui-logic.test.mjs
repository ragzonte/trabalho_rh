// Lógica pura das telas do Mapa 3D (app/js/ui/map/map-ui-logic.js).
//   node --test tests/map-ui-logic.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import * as L from '../app/js/ui/map/map-ui-logic.js';
import { THIN, MINUS } from '../app/js/ui/dom.js';
import { presetWorld } from '../app/js/sim/presets.js';
import { planWalk, simulateSurvey } from '../app/js/sim/walk.js';
import { buildMap, coverage } from '../app/js/mapping/mapmodel.js';
import { sanitizeSurvey, validateSurvey, recorderFromJSON, SURVEY_THRESHOLDS } from '../app/js/mapping/recorder.js';
import { openMapStore } from '../app/js/mapping/storage.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

// ---------------------------------------------------------------------------
// Um mapa de verdade (levantamento simulado + posições verdadeiras como "solução")
// ---------------------------------------------------------------------------

// `autoRooms`: força o agrupamento automático em ambientes (o app só divide o andar quando há pelo
// menos dois lugares com nome; "Ambiente N" aparece nele como sobra entre os ambientes com nome).
function makeMap(worldId = 'apartamento', { labelRate = 1, kind = 'spots', autoRooms = false } = {}) {
  const world = presetWorld(worldId, 1);
  const { survey, truth } = simulateSurvey(world, planWalk(world, { kind }), { labelRate });
  // a verdade serve de solução: o que interessa aqui é a lógica da tela, não o solucionador
  const points = truth.points.map((p, i) => ({ x: p.x, y: p.y, z: survey.scans[i].floor * 2.8, conf: 0.8 }));
  const aps = {};
  for (const ap of world.aps) aps[ap.bssid] = { x: ap.x, y: ap.y, z: ap.z, p0: -40, n: 2.2, conf: 0.7 };
  const solution = { points, aps, scaleConf: 0.6 };
  const own = world.aps.filter((a) => a.own).map((a) => a.bssid);
  const model = buildMap(survey, solution, { own, autoRooms });
  return { world, survey, solution, own, model };
}

// ---------------------------------------------------------------------------
// Nomes e andares
// ---------------------------------------------------------------------------

test('cleanLabel: tira controle e espaços, corta sem partir caractere, mantém o texto hostil como texto', () => {
  assert.equal(L.cleanLabel('  Sala \n de\tTV  '), 'Sala de TV');
  assert.equal(L.cleanLabel(HOSTILE), HOSTILE);
  assert.equal(L.cleanLabel(null), '');
  assert.equal(L.cleanLabel(42), '');
  assert.equal(Array.from(L.cleanLabel('🛋️'.repeat(80))).length <= L.LABEL_MAX, true);
  assert.equal(L.cleanLabel('a'.repeat(200)).length, L.LABEL_MAX);
  assert.equal(L.cleanLabel(`linha${String.fromCharCode(0x2028)}nova`), 'linha nova');
});

test('sameLabel: ignora maiúsculas, acentos e espaços; vazio nunca é igual', () => {
  assert.equal(L.sameLabel('Escritório', ' escritorio'), true);
  assert.equal(L.sameLabel('Quarto', 'Quarto 2'), false);
  assert.equal(L.sameLabel('', ''), false);
  assert.equal(L.sameLabel(undefined, 'Sala'), false);
});

test('roomChips: atalhos, próximos números dos já usados e nomes próprios no fim', () => {
  const chips = L.roomChips(['Quarto', 'quarto 2', 'Cantinho do Rex', 'Quarto']);
  const labels = chips.map((c) => c.label);
  assert.deepEqual(labels.slice(0, 2), ['Sala', 'Cozinha']);
  assert.ok(labels.indexOf('Quarto 3') === labels.indexOf('Quarto') + 2, 'Quarto, Quarto 2, Quarto 3 em sequência');
  assert.equal(chips.find((c) => c.label === 'Quarto').used, true);
  assert.equal(chips.find((c) => c.label === 'Quarto 2').used, true);
  assert.equal(chips.find((c) => c.label === 'Quarto 3').used, false);
  assert.equal(chips[chips.length - 1].label, 'Cantinho do Rex');
  assert.equal(new Set(labels.map((l) => l.toLowerCase())).size, labels.length, 'sem repetição');
  assert.deepEqual(L.roomChips().map((c) => c.label), [...L.ROOM_PRESETS]);
  assert.equal(L.roomChips([HOSTILE]).at(-1).label, HOSTILE);
});

test('wherePhrase: gênero dos cômodos conhecidos e aspas para o resto', () => {
  assert.equal(L.wherePhrase('Quarto 2'), 'no Quarto 2');
  assert.equal(L.wherePhrase('Cozinha'), 'na Cozinha');
  assert.equal(L.wherePhrase('Suíte'), 'na Suíte');
  assert.equal(L.wherePhrase('Ambiente 3'), 'no Ambiente 3');
  assert.equal(L.wherePhrase(HOSTILE), `em “${HOSTILE}”`);
  assert.equal(L.wherePhrase(''), 'num lugar sem nome');
});

test('floorName / floorShort / clampFloor', () => {
  assert.equal(L.floorName(0), 'Térreo');
  assert.equal(L.floorName(1), '1º andar');
  assert.equal(L.floorName(3), '3º andar');
  assert.equal(L.floorName(-1), 'Subsolo');
  assert.equal(L.floorName(-2), '2º subsolo');
  assert.equal(L.floorName(NaN), 'Térreo');
  assert.equal(L.floorShort(2), '2º');
  assert.equal(L.clampFloor(99), L.FLOOR_MAX);
  assert.equal(L.clampFloor(-99), L.FLOOR_MIN);
  assert.equal(L.clampFloor('x'), 0);
  assert.equal(L.clampFloor(1.4), 1);
});

// ---------------------------------------------------------------------------
// Levantamento
// ---------------------------------------------------------------------------

test('levelInfo: só dá para concluir a partir de "minimo"', () => {
  assert.equal(L.levelInfo('insuficiente').canFinish, false);
  assert.equal(L.levelInfo('minimo').canFinish, true);
  assert.equal(L.levelInfo('bom').index, 2);
  assert.equal(L.levelInfo('otimo').pct, 100);
  assert.equal(L.levelInfo('qualquer coisa').index, 0);
  for (const level of ['insuficiente', 'minimo', 'bom', 'otimo']) assert.ok(L.levelInfo(level).label.length > 5);
});

test('finishBlocker: diz o que falta, com os limites do gravador', () => {
  assert.match(L.finishBlocker({ scans: 0 }, SURVEY_THRESHOLDS), /precisa de leituras/);
  const walking = L.finishBlocker({ scans: 6, useful: 6, spots: 1 }, SURVEY_THRESHOLDS);
  assert.match(walking, new RegExp(`faltam ${SURVEY_THRESHOLDS.minUseful - 6} leituras`));
  assert.match(walking, new RegExp(`${SURVEY_THRESHOLDS.minSpots - 1} lugares marcados`));
  const pointByPoint = L.finishBlocker({ scans: 3, useful: 3, spots: 3, throttled: true }, SURVEY_THRESHOLDS);
  assert.match(pointByPoint, new RegExp(`faltam ${SURVEY_THRESHOLDS.minSpots - 3} lugares marcados`));
  assert.doesNotMatch(pointByPoint, /andando/);
  assert.match(L.finishBlocker({ scans: 40, useful: 40, spots: 0 }, SURVEY_THRESHOLDS), /sinal quase não mudou/);
  assert.match(L.finishBlocker({ scans: 24, useful: 24, spots: 0 }, SURVEY_THRESHOLDS), /falta 1 leitura /);
});

test('fmtTimer', () => {
  assert.equal(L.fmtTimer(0), '0:00');
  assert.equal(L.fmtTimer(65.9), '1:05');
  assert.equal(L.fmtTimer(3725), '1:02:05');
  assert.equal(L.fmtTimer(-4), '0:00');
  assert.equal(L.fmtTimer(NaN), '0:00');
});

test('pulseInfo: primeira leitura, espera, atraso, pausa e bloqueio', () => {
  const first = L.pulseInfo({ now: 1000, lastScanAt: null, loop: {} });
  assert.equal(first.phase, 'first');
  assert.equal(first.secondsLeft, null);
  assert.match(L.pulseInfo({ now: 1000, lastScanAt: null, loop: { throttled: true } }).detail, /meio minuto/);

  const waiting = L.pulseInfo({ now: 10_000, lastScanAt: 8000, gaps: [3000, 3100, 2900], loop: {} });
  assert.equal(waiting.phase, 'waiting');
  assert.equal(waiting.secondsLeft, 1);
  assert.ok(waiting.fraction > 0.6 && waiting.fraction < 0.7);
  assert.equal(waiting.title, `Última leitura há 2${THIN}s`);

  const justNow = L.pulseInfo({ now: 8500, lastScanAt: 8000, gaps: [3000], loop: {} });
  assert.equal(justNow.title, 'Leitura recebida agora');

  // limitado: nunca espera menos de 20 s, mesmo que uma leitura tenha chegado cedo
  const throttled = L.pulseInfo({ now: 5000, lastScanAt: 0, gaps: [4000], loop: { throttled: true } });
  assert.equal(throttled.expectedMs, 20_000);
  assert.equal(throttled.secondsLeft, 15);

  const late = L.pulseInfo({ now: 20_000, lastScanAt: 0, gaps: [3000], loop: {} });
  assert.equal(late.phase, 'late');
  assert.equal(late.fraction, 1);

  assert.equal(L.pulseInfo({ now: 1, lastScanAt: 0, state: 'paused' }).phase, 'paused');
  assert.equal(L.pulseInfo({ now: 1, lastScanAt: 0, loop: { paused: 'gate' } }).phase, 'blocked');
  assert.equal(L.pulseInfo({ now: 1, lastScanAt: 0, loop: { paused: 'hidden' } }).phase, 'blocked');
  // sem intervalos observados usa o ritmo do laço
  assert.equal(L.pulseInfo({ now: 0, lastScanAt: 0, loop: { intervalMs: 3000 } }).expectedMs, 5500);
  assert.equal(L.pulseInfo({ now: 0, lastScanAt: 0, loop: { throttled: true } }).expectedMs, 30_000);
  assert.doesNotThrow(() => L.pulseInfo());
});

test('previewDue: primeira prévia cedo, depois a cada poucas leituras e nunca com outra rodando', () => {
  assert.equal(L.previewDue({ scans: 3, lastScans: 0, minScans: 5 }), false);
  assert.equal(L.previewDue({ scans: 5, lastScans: 0, minScans: 5 }), true);
  assert.equal(L.previewDue({ scans: 9, lastScans: 5, running: true, now: 99_999 }), false);
  assert.equal(L.previewDue({ scans: 6, lastScans: 5, now: 99_999, lastAt: 0 }), false, 'uma leitura nova só não basta');
  assert.equal(L.previewDue({ scans: 8, lastScans: 5, now: 99_999, lastAt: 0 }), true);
  assert.equal(L.previewDue({ scans: 8, lastScans: 5, now: 1000, lastAt: 0 }), false, 'respeita o intervalo mínimo');
  assert.equal(L.previewDue({ scans: 6, lastScans: 5, now: 99_999, lastAt: 0, throttled: true }), true, 'ponto a ponto: cada leitura conta');
  assert.equal(L.previewDue({ scans: 5, lastScans: 5, now: 99_999 }), false);
  assert.equal(L.previewDue({ scans: 4, lastScans: 9, now: 99_999 }), false, 'desfazer leituras não dispara prévia');
});

test('candidateNetworks: conectada, favoritas e rádios do mesmo roteador já vêm marcados', () => {
  const state = {
    networks: [
      { ssid: 'Vizinho', best: { rssi: -50 }, aps: [{ bssid: 'aa:aa:aa:aa:aa:01' }] },
      { ssid: 'Casa-5G', best: { rssi: -48 }, aps: [{ bssid: 'aa:aa:aa:aa:aa:02' }] },
      { ssid: 'Casa', best: { rssi: -60 }, aps: [{ bssid: 'aa:aa:aa:aa:aa:03', own: true }, { bssid: 'aa:aa:aa:aa:aa:04' }] },
      { ssid: '', best: { rssi: -30 }, aps: [{}] },
      { ssid: HOSTILE, best: { rssi: -70 }, aps: [{}] },
    ],
    favorites: new Set(['Sitio', HOSTILE]),
    connection: { connected: true, ssid: 'Casa-5G', bssid: 'aa:aa:aa:aa:aa:02', rssi: -48 },
    own: new Set(['aa:aa:aa:aa:aa:02']),
  };
  const list = L.candidateNetworks(state);
  assert.deepEqual(list.map((n) => n.ssid), ['Casa-5G', HOSTILE, 'Sitio', 'Casa', 'Vizinho']);
  assert.deepEqual(list.filter((n) => n.selected).map((n) => n.ssid), ['Casa-5G', HOSTILE, 'Sitio', 'Casa']);
  assert.equal(list.find((n) => n.ssid === 'Casa').sameDevice, true);
  assert.equal(list.find((n) => n.ssid === 'Casa').count, 2);
  assert.equal(list.some((n) => n.ssid === ''), false, 'rede oculta não tem nome para escolher');
  assert.deepEqual(L.candidateNetworks({}), []);
  // limite: as marcadas nunca são cortadas
  const many = { networks: Array.from({ length: 30 }, (_, i) => ({ ssid: `n${i}`, best: { rssi: -40 - i }, aps: [{}] })), favorites: ['n29'] };
  const cut = L.candidateNetworks(many, 4);
  assert.equal(cut.length, 4);
  assert.equal(cut[0].ssid, 'n29');
});

test('ownBssidsFor: todos os rádios das redes escolhidas e dos mesmos aparelhos', () => {
  const survey = {
    aps: {
      'aa:aa:aa:aa:aa:01': { ssid: 'Casa', freq: 2437, device: 'd1' },
      'aa:aa:aa:aa:aa:02': { ssid: 'Casa-5G', freq: 5180, device: 'd1' },
      'aa:aa:aa:aa:aa:03': { ssid: 'Casa', freq: 2412, device: 'd2' },
      'bb:bb:bb:bb:bb:01': { ssid: 'Vizinho', freq: 2462, device: 'd9' },
      'cc:cc:cc:cc:cc:01': { ssid: 'Outra', freq: 2462 },
    },
  };
  assert.deepEqual(L.ownBssidsFor(survey, ['Casa']), ['aa:aa:aa:aa:aa:01', 'aa:aa:aa:aa:aa:02', 'aa:aa:aa:aa:aa:03']);
  assert.deepEqual(L.ownBssidsFor(survey, [], ['CC:CC:CC:CC:CC:01', 'ff:ff:ff:ff:ff:ff']), ['cc:cc:cc:cc:cc:01']);
  assert.deepEqual(L.ownBssidsFor(survey, ['']), []);
  assert.deepEqual(L.ownBssidsFor(null, ['Casa']), []);
});

test('rttTargets: só quem anuncia 802.11mc, os da casa primeiro', () => {
  const aps = [
    { bssid: 'a', rttResponder: true, rssi: -70 },
    { bssid: 'b', rttResponder: false, rssi: -30 },
    { bssid: 'c', rttResponder: true, rssi: -80, own: true },
    { bssid: 'd', rttResponder: true, rssi: -40, stale: true },
    { bssid: 'e', rttResponder: true, rssi: -50 },
  ];
  assert.deepEqual(L.rttTargets(aps), ['c', 'e', 'a']);
  assert.deepEqual(L.rttTargets(aps, 1), ['c']);
  assert.deepEqual(L.rttTargets(), []);
});

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

test('qualityInfo: palavras honestas para cada nível', () => {
  const good = L.qualityInfo({ level: 'boa', expectedErrorM: 1.34, scaleConf: 0.8, notes: ['Tudo certo.', '', 3] });
  assert.equal(good.label, 'Boa');
  assert.equal(good.errorText, `Posições com erro típico de ≈${THIN}1,5${THIN}m`);
  assert.deepEqual(good.notes, ['Tudo certo.']);
  assert.equal(L.qualityInfo({ level: 'razoavel', expectedErrorM: 2 }).errorText, `Posições com erro típico de ≈${THIN}2${THIN}m`);
  const weak = L.qualityInfo(null);
  assert.equal(weak.level, 'fraca');
  assert.equal(weak.errorText, 'Posições aproximadas');
  assert.match(weak.scaleText, /escala/);
});

test('coverageParts: inteiros que somam 100', () => {
  const sum = (parts) => parts.reduce((a, p) => a + p.pct, 0);
  const a = L.coverageParts({ good: 0.613, fair: 0.2, weak: 0.1, dead: 0.087 });
  assert.deepEqual(a.map((p) => p.pct), [61, 20, 10, 9]);
  assert.equal(sum(a), 100);
  for (const cov of [
    { good: 1 / 3, fair: 1 / 3, weak: 1 / 3, dead: 0 },
    { good: 0.999, fair: 0.0005, weak: 0.0005, dead: 0 },
    { good: 0.125, fair: 0.125, weak: 0.125, dead: 0.625 },
    { good: 2, fair: 1, weak: 1, dead: 0 },
  ]) {
    assert.equal(sum(L.coverageParts(cov)), 100);
  }
  assert.deepEqual(L.coverageParts(null).map((p) => p.pct), [0, 0, 0, 100]);
  assert.deepEqual(L.coverageParts({ good: NaN, fair: -1 }).map((p) => p.pct), [0, 0, 0, 100]);
  assert.deepEqual(a.map((p) => p.key), ['good', 'fair', 'weak', 'dead']);
});

test('signalWordAt acompanha as divisas da legenda', () => {
  assert.equal(L.signalWordAt(-45), 'Ótimo');
  assert.equal(L.signalWordAt(-60), 'Ótimo');
  assert.equal(L.signalWordAt(-61), 'Bom');
  assert.equal(L.signalWordAt(-70), 'Regular');
  assert.equal(L.signalWordAt(-80), 'Fraco');
  assert.equal(L.signalWordAt(-90), 'Muito fraco');
  assert.equal(L.signalWordAt(NaN), 'Sem sinal');
});

test('deadZoneLines: frase por ambiente, piores primeiro, com andar quando há mais de um', () => {
  const cov = {
    deadZones: [
      { floor: 0, x: 1, y: 2, areaM2: 1, room: 'Quarto 2', dbm: -84 },
      { floor: 0, x: 5, y: 6, areaM2: 4, room: 'quarto 2', dbm: -88 },
      { floor: 1, x: 0, y: 0, areaM2: 3, room: HOSTILE, dbm: -79 },
      { floor: 1, x: 9, y: 9, areaM2: 2, room: null, dbm: NaN },
      null,
    ],
  };
  const lines = L.deadZoneLines(cov, { multiFloor: true });
  assert.equal(lines.length, 3);
  assert.equal(lines[0].text, `Sinal muito fraco no Quarto 2, térreo (≈${THIN}${MINUS}88${THIN}dBm)`);
  assert.equal(lines[0].areaM2, 5);
  assert.deepEqual([lines[0].x, lines[0].y], [5, 6], 'o centro é o da maior mancha');
  assert.equal(lines[1].text, `Sinal fraco em “${HOSTILE}”, 1º andar (≈${THIN}${MINUS}79${THIN}dBm)`);
  assert.equal(lines[2].text, 'Sem sinal num trecho sem nome, 1º andar');
  assert.equal(L.deadZoneLines(cov, { limit: 1 }).length, 1);
  assert.doesNotMatch(L.deadZoneLines(cov)[0].text, /térreo/);
  assert.deepEqual(L.deadZoneLines(null), []);
});

test('placeText', () => {
  assert.equal(L.placeText({ room: 'Sala', floor: 0 }), 'na Sala');
  assert.equal(L.placeText({ room: 'Sala', floor: 1 }, true), 'na Sala (1º andar)');
  assert.equal(L.placeText({ room: null, floor: 0 }), 'num trecho sem nome');
  assert.equal(L.placeText(null), '');
});

test('heatChoices: ambientes, redes da casa e poucas vizinhas, com nomes sem ambiguidade', () => {
  const model = {
    networks: [
      { key: 's:Casa', ssid: 'Casa', own: true },
      { key: 's:Casa-5G', ssid: 'Casa-5G', own: true },
      { key: 'h:1', ssid: '', own: false },
      { key: 'h:2', ssid: '', own: false },
      { key: 's:x', ssid: HOSTILE, own: false },
      ...Array.from({ length: 6 }, (_, i) => ({ key: `s:v${i}`, ssid: `v${i}`, own: false })),
    ],
  };
  const list = L.heatChoices(model);
  assert.deepEqual(list.map((c) => c.kind), ['rooms', 'own', 'own', 'other', 'other', 'other', 'other']);
  assert.deepEqual(list.map((c) => c.label), ['Ambientes', 'Casa', 'Casa-5G', 'Rede oculta', 'Rede oculta (2)', HOSTILE, 'v0']);
  assert.deepEqual(L.heatChoices(null).map((c) => c.key), ['rooms']);
  assert.equal(L.heatChoices(model, { maxOthers: 0 }).length, 3);
});

test('roomSignal: média do campo só nas células do ambiente', () => {
  const model = { floors: [{ room: Int16Array.from([0, 0, 1, -1, 1, 0]) }] };
  const field = { dbm: Float32Array.from([-50, -60, -70, -20, -80, NaN]) };
  assert.equal(L.roomSignal(model, 0, 0, field), -55);
  assert.equal(L.roomSignal(model, 0, 1, field), -75);
  assert.equal(L.roomSignal(model, 0, 7, field), null);
  assert.equal(L.roomSignal(model, 3, 0, field), null);
  assert.equal(L.roomSignal(model, 0, 0, null), null);
});

test('spotOptions / spotDistance: nomes sem ambiguidade e distância estimada', () => {
  const model = {
    floors: [{}, {}],
    spots: [
      { id: 0, label: 'Sala', x: 0, y: 0, z: 0, floor: 0 },
      { id: 1, label: 'sala', x: 3, y: 4, z: 0, floor: 0 },
      { id: 2, label: '', x: 0, y: 0, z: 2.8, floor: 1 },
      { id: 5, label: HOSTILE, x: 1, y: 1, z: 2.8, floor: 1 },
    ],
  };
  const options = L.spotOptions(model);
  assert.deepEqual(options.map((o) => o.label), ['Sala (1ª marcação) · Térreo', 'sala (2ª marcação) · Térreo', 'Lugar 1 · 1º andar', `${HOSTILE} · 1º andar`]);
  assert.deepEqual(options.map((o) => o.id), [0, 1, 2, 5]);
  assert.equal(L.spotDistance(model, 0, 1), 5);
  assert.ok(Math.abs(L.spotDistance(model, 0, 2) - 2.8) < 1e-9, 'conta a diferença de andar');
  assert.equal(L.spotDistance(model, 0, 0), null);
  assert.equal(L.spotDistance(model, 0, 99), null);
  assert.deepEqual(L.spotOptions({ floors: [{}], spots: [{ id: 3, label: 'Hall', x: 0, y: 0, floor: 0 }] })[0].label, 'Hall');
});

test('parseMeters: vírgula ou ponto, unidade opcional, faixa de 0,5 a 200 m', () => {
  assert.equal(L.parseMeters('3,5'), 3.5);
  assert.equal(L.parseMeters(' 3.5 m '), 3.5);
  assert.equal(L.parseMeters('12 metros'), 12);
  assert.equal(L.parseMeters('4,25'), 4.25);
  assert.equal(L.parseMeters(7), 7);
  for (const bad of ['', 'abc', '0,2', '500', '-3', '1e3', '3,5,5', '3 cm', null, undefined, NaN, {}]) assert.equal(L.parseMeters(bad), null, String(bad));
});

test('withKnownDistance: usa a varredura do meio de cada ponto e substitui a medida do mesmo par', () => {
  const scan = (spot) => ({ t: 0, floor: 0, still: spot !== null, spot, readings: [] });
  const survey = { version: 1, scans: [scan(null), scan(0), scan(0), scan(0), scan(null), scan(1), scan(2), scan(2)], aps: {}, knownDistances: [] };
  assert.equal(L.spotScanIndex(survey, 0), 2);
  assert.equal(L.spotScanIndex(survey, 2), 6);
  assert.equal(L.spotScanIndex(survey, 9), -1);
  const one = L.withKnownDistance(survey, 1, 0, 4.5);
  assert.deepEqual(one.knownDistances, [{ a: 2, b: 5, meters: 4.5 }]);
  assert.deepEqual(survey.knownDistances, [], 'o original não muda');
  const two = L.withKnownDistance(one, 0, 2, 6);
  assert.equal(two.knownDistances.length, 2);
  const replaced = L.withKnownDistance(two, 0, 1, 5);
  assert.deepEqual(replaced.knownDistances, [
    { a: 2, b: 6, meters: 6 },
    { a: 2, b: 5, meters: 5 },
  ]);
  assert.equal(L.withKnownDistance(survey, 0, 0, 3), null);
  assert.equal(L.withKnownDistance(survey, 0, 9, 3), null);
  assert.equal(L.withKnownDistance(survey, 0, 1, 0), null);
  assert.equal(L.withKnownDistance(survey, 0, 1, NaN), null);
});

test('renameRoom: ambiente com nome -> os pontos marcados com aquele nome mudam; o resultado passa pelo conferidor do gravador', () => {
  const { survey, solution, own, model } = makeMap('apartamento');
  const floor = model.floors[0];
  const room = floor.rooms.find((r) => !r.auto);
  assert.ok(room, 'o levantamento simulado tem ambientes com nome');
  const next = L.renameRoom(survey, model, 0, room.id, `  ${HOSTILE}  `);
  assert.ok(next);
  assert.notEqual(next, survey);
  assert.equal(survey.scans.some((s) => s.label === HOSTILE), false, 'o original não muda');
  const changed = next.scans.filter((s) => s.label === HOSTILE);
  assert.ok(changed.length > 0);
  assert.equal(changed.every((s) => s.spot !== null), true);
  assert.equal(next.scans.some((s) => L.sameLabel(s.label, room.label)), false);
  assert.deepEqual(validateSurvey(next), []);
  // os nomes sobrevivem à limpeza feita ao gravar e ao continuar o mapa
  const clean = sanitizeSurvey(next);
  assert.equal(clean.scans.filter((s) => s.label === HOSTILE).length, changed.length);
  const again = buildMap(clean, solution, { own });
  assert.ok(again.floors[0].rooms.some((r) => r.label === HOSTILE && !r.auto));
  // nome vazio tira o nome
  const cleared = L.renameRoom(next, again, 0, again.floors[0].rooms.find((r) => r.label === HOSTILE).id, '   ');
  assert.equal(cleared.scans.some((s) => s.label === HOSTILE), false);
});

test('renameRoom: ambiente automático -> uma varredura central vira ponto marcado com o nome (ou o ponto sem nome que já estava lá)', () => {
  // sem nenhum lugar com nome o mapa não tem ambientes: não há o que renomear
  const plain = makeMap('apartamento', { labelRate: 0, kind: 'tour' });
  assert.equal(plain.model.floors[0].rooms.length, 0);
  assert.equal(L.renameRoom(plain.survey, plain.model, 0, 0, 'Sala'), null);

  const { survey, solution, own, model } = makeMap('apartamento', { labelRate: 0, kind: 'tour', autoRooms: true });
  const room = model.floors[0].rooms.find((r) => r.auto);
  assert.ok(room, 'com o agrupamento forçado e sem nomes, os ambientes são automáticos');
  const next = L.renameRoom(survey, model, 0, room.id, 'Sala de TV');
  assert.ok(next);
  const named = next.scans.filter((s) => s.label === 'Sala de TV');
  assert.ok(named.length >= 1);
  assert.equal(named.every((s) => s.still === true && Number.isInteger(s.spot)), true);
  assert.deepEqual(validateSurvey(next), []);
  assert.equal(sanitizeSurvey(next).scans.filter((s) => s.label === 'Sala de TV').length, named.length);
  const again = buildMap(next, solution, { own, autoRooms: true });
  assert.ok(again.floors[0].rooms.some((r) => r.label === 'Sala de TV'), 'o ambiente aparece com o nome novo');
  assert.equal(L.renameRoom(survey, model, 0, room.id, ''), null, 'automático sem nome: nada a fazer');
  assert.equal(L.renameRoom(survey, model, 0, 9999, 'x'), null);
  assert.equal(L.renameRoom(survey, model, 7, room.id, 'x'), null);
  assert.equal(L.renameRoom(null, model, 0, room.id, 'x'), null);

  // com um ponto marcado sem nome dentro do ambiente, é ele que ganha o nome
  const spots = makeMap('apartamento', { labelRate: 0, kind: 'spots', autoRooms: true });
  const auto = spots.model.floors[0].rooms.find((r) => r.auto && r.scans > 0);
  const labelled = L.renameRoom(spots.survey, spots.model, 0, auto.id, 'Copa');
  assert.ok(labelled);
  const ids = new Set(labelled.scans.filter((s) => s.label === 'Copa').map((s) => s.spot));
  assert.equal(ids.size, 1);
  const [id] = ids;
  assert.equal(labelled.scans.filter((s) => s.spot === id).every((s) => s.label === 'Copa'), true, 'todas as varreduras do ponto ganham o nome');
  assert.equal(spots.survey.scans.filter((s) => s.spot === id).length, labelled.scans.filter((s) => s.spot === id).length, 'nenhum ponto novo foi criado');
});

// ---------------------------------------------------------------------------
// Biblioteca e arquivos
// ---------------------------------------------------------------------------

test('mapMeta / metaLine', () => {
  const { survey, model } = makeMap('sobrado');
  const meta = L.mapMeta(model, survey);
  assert.equal(meta.floors, 2);
  assert.equal(meta.scans, survey.scans.length);
  assert.ok(meta.rooms >= 2 && meta.areaM2 > 20 && meta.spots > 3);
  assert.ok(['boa', 'razoavel', 'fraca'].includes(meta.level));
  assert.match(L.metaLine(meta), new RegExp(`^≈${THIN}\\d+${THIN}m² · 2 andares · \\d+ lugares marcados$`));
  assert.equal(L.metaLine({ areaM2: 30, floors: 1, spots: 0, scans: 12 }), `≈${THIN}30${THIN}m² · 12 leituras`);
  assert.equal(L.metaLine({ areaM2: 0, floors: 1, spots: 1 }), '1 lugar marcado');
  assert.equal(L.metaLine(null), '');
  assert.deepEqual(L.mapMeta(null, null), { areaM2: 0, rooms: 0, floors: 0, scans: 0, spots: 0, level: 'fraca', errorM: null, durationS: 0 });
});

test('defaultMapName / fileSlug / cleanMapName', () => {
  const ts = new Date(2026, 10, 15, 14, 30).getTime();
  assert.equal(L.defaultMapName(ts), 'Mapa de 15/11');
  assert.equal(L.defaultMapName(ts, ['mapa de 15/11']), 'Mapa de 15/11 (2)');
  assert.equal(L.defaultMapName(ts, ['Mapa de 15/11', 'Mapa de 15/11 (2)']), 'Mapa de 15/11 (3)');
  assert.equal(L.defaultMapName(ts, ['Casa virtual'], 'Casa virtual'), 'Casa virtual (2)');
  assert.equal(L.fileSlug('Casa da Vó!'), 'casa-da-vo');
  assert.equal(L.fileSlug(HOSTILE), 'img-src-x-onerror-alert-1');
  assert.equal(L.fileSlug('🛋️'), 'mapa');
  assert.equal(L.fileSlug('../../etc/passwd'), 'etc-passwd');
  assert.ok(L.fileSlug('a'.repeat(300)).length <= 40);
  assert.equal(L.cleanMapName('  Casa \n nova  '), 'Casa nova');
  assert.equal(Array.from(L.cleanMapName('x'.repeat(500))).length, 60);
});

test('makeRecord + readRecord: o registro passa pelo armazenamento de verdade e volta inteiro', async () => {
  const { survey, solution, own, model } = makeMap('apartamento');
  const record = L.makeRecord({ name: `  ${HOSTILE}  `, survey, solution, own, ownSsids: ['VIVOFIBRA-8F3C', 7], model, thumb: 'data:image/png;base64,AAAA', demo: true });
  assert.equal(record.name, HOSTILE);
  assert.equal('id' in record, false);
  assert.equal('model' in record, false, 'o modelo nunca é guardado');
  assert.deepEqual(record.meta.ownSsids, ['VIVOFIBRA-8F3C']);
  assert.equal(record.stats.level, model.quality.level);

  const store = await openMapStore({ backend: 'memory' });
  const id = await store.put(record);
  const [entry] = (await store.list()).map(L.readRecord);
  assert.equal(entry.id, id);
  assert.equal(entry.name, HOSTILE);
  assert.equal(entry.survey, null, 'a lista não traz o levantamento');
  assert.equal(entry.meta.scans, survey.scans.length);
  assert.equal(entry.meta.level, model.quality.level);
  assert.equal(entry.meta.demo, true);
  assert.equal(entry.thumb, 'data:image/png;base64,AAAA');

  const full = L.readRecord(await store.get(id));
  assert.equal(full.survey.scans.length, survey.scans.length);
  assert.equal(full.solution.points.length, survey.scans.length);
  assert.deepEqual(full.own, own);
  assert.deepEqual(full.ownSsids, ['VIVOFIBRA-8F3C']);
  // o modelo refeito do que foi guardado é o mesmo mapa
  const rebuilt = buildMap(full.survey, full.solution, { own: full.own });
  assert.equal(rebuilt.floors.length, model.floors.length);
  assert.equal(rebuilt.quality.scans, model.quality.scans);
  assert.equal(Math.round(coverage(rebuilt, rebuilt.networks[0].key).good * 100), Math.round(coverage(model, model.networks[0].key).good * 100));

  // atualizar com o mesmo id, e continuar o mapa a partir do levantamento guardado
  const updated = await store.put(L.makeRecord({ id, name: 'Outro nome', survey, solution, own, model }));
  assert.equal(updated, id);
  assert.equal((await store.list()).length, 1);
  const rec = recorderFromJSON(full.survey);
  assert.ok(rec, 'o gravador aceita o levantamento guardado ("continuar mapeando")');
  assert.equal(rec.stats().scans, survey.scans.length);
});

test('readRecord: desconfia do que lê', () => {
  assert.equal(L.readRecord(null), null);
  assert.equal(L.readRecord('x'), null);
  const odd = L.readRecord({ id: 7, name: '', thumb: 'https://exemplo.invalid/x.png', survey: { scans: 'nada' }, solution: {}, own: ['a', 3], meta: { ownSsids: 'x', rooms: 'muitos' }, stats: { level: 'ótima', areaM2: -5 } });
  assert.equal(odd.id, null);
  assert.equal(odd.name, 'Mapa sem nome');
  assert.equal(odd.thumb, null, 'endereço de fora nunca vira imagem');
  assert.equal(odd.survey, null);
  assert.equal(odd.solution, null);
  assert.deepEqual(odd.own, ['a']);
  assert.deepEqual(odd.ownSsids, []);
  assert.equal(odd.meta.level, null);
  assert.equal(odd.meta.areaM2, 0);
  assert.equal(odd.meta.rooms, 0);
  assert.equal(L.readRecord({ id: 'm1', name: HOSTILE }).name, HOSTILE);
  assert.equal(L.readRecord({ id: 'm1', thumb: 'data:image/svg+xml;base64,AAAA' }).thumb, null);
});

test('makeRecord: nome vazio ganha um padrão e miniatura que não é imagem embutida fica de fora', () => {
  const rec = L.makeRecord({ name: '   ', survey: { scans: [] }, solution: { points: [] }, thumb: 'javascript:alert(1)', now: new Date(2026, 0, 2).getTime() });
  assert.equal(rec.name, 'Mapa de 02/01');
  assert.equal('thumb' in rec, false);
  assert.equal(rec.demo, false);
  assert.equal(L.makeRecord({ id: 'm9', name: 'x' }).id, 'm9');
  assert.equal('id' in L.makeRecord({ id: 12, name: 'x' }), false);
});

test('approxMetersText', () => {
  assert.equal(L.approxMetersText(4.4), `≈${THIN}4${THIN}m`);
  assert.equal(L.approxMetersText(1.2), `≈${THIN}1${THIN}m`);
});
