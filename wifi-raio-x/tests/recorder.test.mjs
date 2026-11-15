// Gravador do levantamento (app/js/mapping/recorder.js) e piloto da demonstração
// (app/js/mapping/demo-pilot.js). Nada aqui depende do relógio de verdade: os testes de unidade
// usam um relógio de mentira e as sessões simuladas usam o relógio manual do simulador.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRecorder, recorderFromJSON, validateSurvey, sanitizeSurvey, cleanLabel, SURVEY_THRESHOLDS, RECORDER_LIMITS } from '../app/js/mapping/recorder.js';
import { createDemoPilot, PILOT_DEFAULTS } from '../app/js/mapping/demo-pilot.js';
import { createMapEngine } from '../app/js/mapping/engine.js';
import { createSimBackend, createManualClock } from '../app/js/sim/backend.js';
import { createStore } from '../app/js/store.js';
import { createScanLoop } from '../app/js/scan-loop.js';
import { procrustes } from './mapping/metrics.mjs';

// ---------------------------------------------------------------------------
// Ajudas
// ---------------------------------------------------------------------------

function fakeClock(start = Date.UTC(2026, 0, 15, 12, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms), start };
}

const hex = (n) => (n & 0xff).toString(16).padStart(2, '0');
/** BSSIDs de fabricantes diferentes: o agrupamento por aparelho nunca junta dois deles. */
const mac = (n) => `${hex(n * 4)}:${hex(17 + n * 7)}:${hex(33 + n * 13)}:00:00:${hex(n)}`;

/** ScanAp mínimo, no formato da ponte. */
const ap = (bssid, level, { frequency = 2437, ageMs = 1500, ssid = 'Rede' } = {}) => ({
  bssid,
  ssid,
  level,
  frequency,
  channelWidth: 0,
  centerFreq0: 0,
  centerFreq1: 0,
  capabilities: '[WPA2-PSK-CCMP][ESS]',
  ageMs,
});

const scanEvent = (clock, aps, extra = {}) => ({ ts: clock.now(), fresh: true, source: 'request', aps, ...extra });

/** Níveis que mudam bastante de uma varredura para outra, como quem anda pela casa. */
const walkingAps = (i) => [0, 1, 2, 3, 4].map((k) => ap(mac(k + 1), -45 - k * 6 - Math.abs(((i * (k + 2)) % 24) - 12) * 2, { frequency: 2412 + k * 5 }));

/** Avança `stepMs` e entrega uma varredura de quem está andando. Devolve se foi gravada. */
function feed(rec, clock, i, stepMs = 3000) {
  clock.advance(stepMs);
  return rec.onScan(scanEvent(clock, walkingAps(i)));
}

function started(options = {}) {
  const clock = fakeClock();
  const rec = createRecorder({ now: clock.now, ...options });
  rec.start();
  return { rec, clock };
}

// Esquema do Survey escrito a partir do typedef de app/js/mapping/types.js (independente do
// validador do próprio gravador): devolve a lista de problemas.
const BSSID = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
function surveyProblems(survey) {
  const out = [];
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const keys = (obj, allowed, where) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) out.push(`${where}: campo inesperado "${k}"`);
  };
  if (survey === null || typeof survey !== 'object') return ['não é objeto'];
  keys(survey, ['version', 'scans', 'track', 'rtt', 'aps', 'knownDistances'], 'survey');
  if (survey.version !== 1) out.push('version');
  if (!Array.isArray(survey.scans)) return [...out, 'scans'];
  let last = -1;
  survey.scans.forEach((s, i) => {
    const w = `scans[${i}]`;
    keys(s, ['t', 'floor', 'still', 'spot', 'label', 'readings'], w);
    if (!isNum(s.t) || s.t < 0) out.push(`${w}.t`);
    if (s.t < last) out.push(`${w}.t fora de ordem`);
    last = s.t;
    if (!Number.isInteger(s.floor)) out.push(`${w}.floor`);
    if (typeof s.still !== 'boolean') out.push(`${w}.still`);
    if (!(s.spot === null || (Number.isInteger(s.spot) && s.spot >= 0))) out.push(`${w}.spot`);
    if (s.still !== (s.spot !== null)) out.push(`${w}: still e spot em desacordo`);
    if ('label' in s && (typeof s.label !== 'string' || s.label === '')) out.push(`${w}.label`);
    if ('label' in s && s.spot === null) out.push(`${w}: nome sem ponto`);
    if (!Array.isArray(s.readings) || s.readings.length === 0) return out.push(`${w}.readings`);
    const seen = new Set();
    s.readings.forEach((r, k) => {
      const v = `${w}.readings[${k}]`;
      keys(r, ['id', 'rssi', 'freq', 'ageMs'], v);
      if (typeof r.id !== 'string' || !BSSID.test(r.id)) out.push(`${v}.id`);
      if (seen.has(r.id)) out.push(`${v}: BSSID repetido`);
      seen.add(r.id);
      if (!Number.isInteger(r.rssi) || r.rssi >= 0 || r.rssi < -110) out.push(`${v}.rssi`);
      if (!isNum(r.freq) || r.freq < 2000 || r.freq > 7200) out.push(`${v}.freq`);
      if ('ageMs' in r && (!isNum(r.ageMs) || r.ageMs < 0)) out.push(`${v}.ageMs`);
      if (!survey.aps || !survey.aps[r.id]) out.push(`${v}: sem dados em aps`);
    });
  });
  if (survey.aps === null || typeof survey.aps !== 'object' || Array.isArray(survey.aps)) out.push('aps');
  else {
    for (const [id, a] of Object.entries(survey.aps)) {
      keys(a, ['ssid', 'freq', 'device'], `aps[${id}]`);
      if (!BSSID.test(id)) out.push(`aps: chave ${id}`);
      if (typeof a.ssid !== 'string') out.push(`aps[${id}].ssid`);
      if (!isNum(a.freq)) out.push(`aps[${id}].freq`);
      if ('device' in a && (typeof a.device !== 'string' || a.device === '')) out.push(`aps[${id}].device`);
    }
  }
  for (const q of survey.track || []) {
    keys(q, ['t', 'id', 'rssi'], 'track');
    if (!isNum(q.t) || !BSSID.test(q.id) || !isNum(q.rssi)) out.push('track: amostra inválida');
  }
  for (const q of survey.rtt || []) {
    keys(q, ['t', 'id', 'distM', 'stdM'], 'rtt');
    if (!isNum(q.t) || !BSSID.test(q.id) || !isNum(q.distM) || !isNum(q.stdM)) out.push('rtt: amostra inválida');
  }
  for (const k of survey.knownDistances || []) {
    keys(k, ['a', 'b', 'meters'], 'knownDistances');
    if (!Number.isInteger(k.a) || !Number.isInteger(k.b) || k.a === k.b || k.a >= survey.scans.length || k.b >= survey.scans.length || !(k.meters > 0)) out.push('knownDistances');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

test('estado: idle -> recording -> paused -> recording -> stopped, e só grava enquanto grava', () => {
  const clock = fakeClock();
  const rec = createRecorder({ now: clock.now });
  assert.equal(rec.state, 'idle');
  assert.equal(rec.onScan(scanEvent(clock, walkingAps(0))), false, 'parado não grava');
  assert.equal(rec.pause(), false);
  assert.equal(rec.resume(), false);
  assert.equal(rec.stop(), false);

  assert.equal(rec.start(), true);
  assert.equal(rec.start(), false, 'começar duas vezes não reinicia');
  assert.equal(rec.state, 'recording');
  assert.equal(feed(rec, clock, 1), true);

  assert.equal(rec.pause(), true);
  assert.equal(rec.state, 'paused');
  assert.equal(feed(rec, clock, 2), false, 'em pausa não grava');
  assert.equal(rec.resume(), true);
  assert.equal(feed(rec, clock, 3), true);

  assert.equal(rec.stop(), true);
  assert.equal(rec.state, 'stopped');
  assert.equal(feed(rec, clock, 4), false);
  assert.equal(rec.stats().scans, 2);

  // "continuar este mapa": um levantamento encerrado pode ser reaberto
  assert.equal(rec.resume(), true);
  assert.equal(feed(rec, clock, 5), true);
  assert.equal(rec.stats().scans, 3);

  rec.reset();
  assert.equal(rec.state, 'idle');
  assert.deepEqual(rec.toSurvey(), { version: 1, scans: [], track: [], rtt: [], aps: {}, knownDistances: [] });
});

// ---------------------------------------------------------------------------
// Varreduras
// ---------------------------------------------------------------------------

test('varreduras: só lista nova (fresh === true) e nunca a mesma lista duas vezes', () => {
  const { rec, clock } = started();
  clock.advance(3000);
  assert.equal(rec.onScan(scanEvent(clock, walkingAps(0), { fresh: false, source: 'cache' })), false, 'lista em cache');
  assert.equal(rec.onScan({ ts: clock.now(), source: 'request', aps: walkingAps(0) }), false, 'sem fresh não é nova');
  const first = scanEvent(clock, walkingAps(0));
  assert.equal(rec.onScan(first), true);
  assert.equal(rec.onScan(first), false, 'o mesmo evento de novo');
  assert.equal(rec.onScan(JSON.parse(JSON.stringify(first))), false, 'uma cópia do mesmo evento');

  // a mesma lista lida 5 s depois (o Android às vezes reenvia): as idades só cresceram
  clock.advance(5000);
  const again = scanEvent(
    clock,
    walkingAps(0).map((a) => ({ ...a, ageMs: a.ageMs + 5000 })),
    { source: 'system' },
  );
  assert.equal(rec.onScan(again), false, 'reenvio da lista antiga');
  // uma varredura nova de verdade
  assert.equal(rec.onScan(scanEvent(clock, walkingAps(0))), true, 'mesmos níveis, mas ouvidos agora: é outra lista');
  assert.equal(rec.stats().scans, 2);

  // entradas que não são eventos
  for (const junk of [null, undefined, 42, 'scan', [], {}, { fresh: true }, { fresh: true, aps: 'x' }]) assert.equal(rec.onScan(junk), false);
  assert.equal(rec.onScan(scanEvent(clock, [])), false, 'lista vazia não é medição');
});

test('varreduras: sem idades nas leituras, compara o conteúdo da lista', () => {
  const { rec, clock } = started();
  const bare = (levels) => levels.map((level, k) => ({ bssid: mac(k + 1), ssid: 'x', level, frequency: 2437 }));
  clock.advance(3000);
  assert.equal(rec.onScan(scanEvent(clock, bare([-50, -60]))), true);
  clock.advance(3000);
  assert.equal(rec.onScan(scanEvent(clock, bare([-50, -60]))), false, 'igual à anterior');
  assert.equal(rec.onScan(scanEvent(clock, bare([-51, -60]))), true);
  assert.equal('ageMs' in rec.toSurvey().scans[0].readings[0], false, 'sem idade na entrada, sem idade na saída');
});

test('varreduras: descarta leitura absurda, BSSID inválido e repetição; guarda idade e ordena por sinal', () => {
  const { rec, clock } = started();
  clock.advance(3000);
  const ok = rec.onScan(
    scanEvent(clock, [
      ap(mac(1), -70, { ageMs: 900 }),
      ap(mac(2), 0), // nível >= 0
      ap(mac(3), 12),
      ap(mac(4), -111), // abaixo de -110
      ap(mac(5), -127),
      ap(mac(6), Number.NaN),
      ap('não é um mac', -50),
      ap('', -50),
      ap(mac(7), -50, { frequency: Number.NaN }),
      ap(mac(8).toUpperCase(), -40.4, { ageMs: 2100.7, frequency: 5180 }),
      ap(mac(9), -110, { ageMs: 0 }), // no limite: vale
      ap(mac(10), -1),
      ap(mac(1), -64, { ageMs: 300 }), // o mesmo BSSID duas vezes: fica a leitura mais nova
      null,
      'lixo',
    ]),
  );
  assert.equal(ok, true);
  const scan = rec.toSurvey().scans[0];
  assert.deepEqual(scan.readings, [
    { id: mac(10), rssi: -1, freq: 2437, ageMs: 1500 },
    { id: mac(8), rssi: -40, freq: 5180, ageMs: 2101 },
    { id: mac(1), rssi: -64, freq: 2437, ageMs: 300 },
    { id: mac(9), rssi: -110, freq: 2437, ageMs: 0 },
  ]);
  assert.deepEqual(Object.keys(rec.toSurvey().aps).sort(), [mac(1), mac(8), mac(9), mac(10)].sort());

  clock.advance(3000);
  assert.equal(rec.onScan(scanEvent(clock, [ap(mac(2), 0), ap(mac(4), -200)])), false, 'só leituras absurdas: nada a gravar');
  assert.equal(rec.stats().scans, 1);
});

test('varreduras: leitura velha demais sai, mas a idade das outras fica', () => {
  const { rec, clock } = started();
  clock.advance(3000);
  rec.onScan(scanEvent(clock, [ap(mac(1), -50, { ageMs: 1200 }), ap(mac(2), -60, { ageMs: 9000 }), ap(mac(3), -70, { ageMs: RECORDER_LIMITS.maxReadingAgeMs + 1 })]));
  assert.deepEqual(
    rec.toSurvey().scans[0].readings.map((r) => [r.id, r.ageMs]),
    [
      [mac(1), 1200],
      [mac(2), 9000],
    ],
  );
});

test('varreduras: nome, frequência e rede oculta que depois mostra o nome', () => {
  const { rec, clock } = started();
  clock.advance(3000);
  rec.onScan(scanEvent(clock, [ap(mac(1), -50, { ssid: '' }), ap(mac(2), -60, { ssid: '<img src=x onerror=alert(1)>', frequency: 5500 })]));
  let survey = rec.toSurvey();
  assert.equal(survey.aps[mac(1)].ssid, '');
  assert.equal(survey.aps[mac(2)].ssid, '<img src=x onerror=alert(1)>', 'o nome é guardado como texto, sem mexer');
  assert.equal(survey.aps[mac(2)].freq, 5500);
  clock.advance(3000);
  rec.onScan(scanEvent(clock, [ap(mac(1), -52, { ssid: 'Casa' })]));
  clock.advance(3000);
  rec.onScan(scanEvent(clock, [ap(mac(1), -53, { ssid: '' })]));
  survey = rec.toSurvey();
  assert.equal(survey.aps[mac(1)].ssid, 'Casa');
  // os dados do store, quando vêm, valem mais que os do evento
  clock.advance(3000);
  rec.onScan(scanEvent(clock, [ap(mac(3), -53, { ssid: 'cru' })]), { aps: [{ bssid: mac(3), ssid: 'Do store', freq: 2437, band: '2.4' }] });
  assert.equal(rec.toSurvey().aps[mac(3)].ssid, 'Do store');
});

test('aparelhos: BSSIDs do mesmo roteador ficam juntos por maioria das varreduras, não por um acaso', () => {
  const { rec, clock } = started();
  // Duas redes do mesmo rádio (endereços vizinhos, mesma frequência): o agrupamento do app só as
  // junta quando chegam com o mesmo sinal. Uma terceira, de outro fabricante, nunca entra.
  const main = 'a0:b1:c2:00:00:10';
  const guest = 'a0:b1:c2:00:00:11';
  const other = mac(9);
  const list = (i, guestOffset) => [
    ap(main, -50 - (i % 20), { ssid: 'Casa', frequency: 2437 }),
    ap(guest, -50 - (i % 20) + guestOffset, { ssid: 'Casa-Convidados', frequency: 2437 }),
    ap(other, -70 + (i % 9), { ssid: 'Vizinho', frequency: 2462 }),
  ];
  // 9 varreduras com o mesmo sinal nas duas e 3 em que uma leitura saiu torta (parecem dois rádios)
  for (let i = 0; i < 12; i++) {
    clock.advance(3000);
    rec.onScan(scanEvent(clock, list(i, i % 4 === 3 ? 12 : 1)));
  }
  let aps = rec.toSurvey().aps;
  assert.equal(aps[main].device, aps[guest].device, 'juntas em 9 de 12');
  assert.notEqual(aps[main].device, aps[other].device);
  assert.equal(rec.stats().devices, 2);
  assert.equal(rec.stats().aps, 3);

  // o contrário: quase sempre parecem dois rádios, e uma coincidência não as junta
  const second = started();
  for (let i = 0; i < 12; i++) {
    second.clock.advance(3000);
    second.rec.onScan(scanEvent(second.clock, list(i, i === 5 ? 1 : 12)));
  }
  aps = second.rec.toSurvey().aps;
  assert.notEqual(aps[main].device, aps[guest].device, 'juntas em 1 de 12');
  assert.equal(second.rec.stats().devices, 3);
  // os ids são neutros e estáveis: d1, d2... na ordem em que os rádios apareceram
  assert.deepEqual(Object.values(aps).map((a) => a.device).sort(), ['d1', 'd2', 'd3']);
});

test('limite: o levantamento para de crescer em maxScans', () => {
  const { rec, clock } = started();
  // para não gravar milhares de varreduras, confere a regra pelo retrato restaurado no limite
  const scans = Array.from({ length: RECORDER_LIMITS.maxScans }, (_, i) => ({ t: i * 3, floor: 0, still: false, spot: null, readings: [{ id: mac(1), rssi: -50 - (i % 30), freq: 2437 }] }));
  const big = recorderFromJSON({ version: 1, scans, aps: { [mac(1)]: { ssid: 'x', freq: 2437 } } }, { now: clock.now });
  assert.ok(big, 'um levantamento no limite ainda é aceito');
  big.resume();
  assert.equal(feed(big, clock, 1), false);
  const stats = big.stats();
  assert.equal(stats.full, true);
  assert.match(stats.hint, /tamanho máximo/);
  assert.equal(recorderFromJSON({ version: 1, scans: [...scans, scans[0]], aps: {} }), null, 'acima do limite não entra');
  void rec;
});

// ---------------------------------------------------------------------------
// Tempo
// ---------------------------------------------------------------------------

test('tempo: t em segundos de caminhada, usando o relógio do evento', () => {
  const { rec, clock } = started();
  clock.advance(2600);
  rec.onScan(scanEvent(clock, walkingAps(0)));
  clock.advance(3000);
  // a lista foi lida 400 ms antes de o evento chegar à página
  rec.onScan({ ...scanEvent(clock, walkingAps(1)), ts: clock.now() - 400 });
  clock.advance(3000);
  // relógio do evento absurdo (celular com a data errada): vale o do app
  rec.onScan({ ...scanEvent(clock, walkingAps(2)), ts: 12345 });
  clock.advance(3000);
  rec.onScan({ ...scanEvent(clock, walkingAps(3)), ts: 'ontem' });
  assert.deepEqual(
    rec.toSurvey().scans.map((s) => s.t),
    [2.6, 5.2, 8.6, 11.6],
  );
  assert.equal(rec.stats().durationS, 11.6);
});

test('tempo: timeScale estica o tempo e as idades (simulador acelerado)', () => {
  const { rec, clock } = started({ timeScale: 8 });
  assert.equal(rec.timeScale, 8);
  clock.advance(1000);
  rec.onScan(scanEvent(clock, [ap(mac(1), -50, { ageMs: 300 }), ap(mac(2), -60, { ageMs: 2000 }), ap(mac(3), -70, { ageMs: 2600 })]));
  const scan = rec.toSurvey().scans[0];
  assert.equal(scan.t, 8, '1 s de relógio = 8 s de caminhada');
  assert.deepEqual(
    scan.readings.map((r) => r.ageMs),
    [2400, 16000],
    'idades x8; a de 20,8 s de caminhada já é velha demais',
  );
  assert.equal(rec.stats().durationS, 8);

  // mudar a escala no meio não reescreve o que já passou
  clock.advance(500);
  assert.equal(rec.setTimeScale(2), 2);
  clock.advance(1000);
  rec.onScan(scanEvent(clock, walkingAps(1)));
  assert.equal(rec.toSurvey().scans[1].t, 8 + 4 + 2);
  assert.equal(rec.setTimeScale(0), 2, 'escala inválida é ignorada');
  assert.equal(rec.setTimeScale(Number.NaN), 2);
});

test('tempo: a pausa não conta, e a retomada dá um salto de 30 s no t das varreduras', () => {
  const { rec, clock } = started();
  clock.advance(3000);
  rec.onScan(scanEvent(clock, walkingAps(0)));
  clock.advance(7000);
  rec.pause();
  clock.advance(60_000);
  assert.equal(rec.stats().durationS, 10, 'parado na pausa');
  rec.resume();
  clock.advance(5000);
  rec.onScan(scanEvent(clock, walkingAps(1)));
  const survey = rec.toSurvey();
  assert.equal(rec.stats().durationS, 15);
  assert.equal(survey.scans[1].t, 15 + RECORDER_LIMITS.resumeGapS);
  // o intervalo que atravessa a pausa não entra no ritmo das varreduras
  assert.equal(rec.stats().cadenceS, null);
  clock.advance(3000);
  rec.onScan(scanEvent(clock, walkingAps(2)));
  assert.equal(rec.stats().cadenceS, 3);
});

// ---------------------------------------------------------------------------
// Pontos e andares
// ---------------------------------------------------------------------------

test('pontos: varreduras paradas levam o ponto e o nome; a lista que chega logo depois do toque ainda é caminhada', () => {
  const { rec, clock } = started();
  feed(rec, clock, 0);
  const id = rec.beginSpot('Sala');
  assert.equal(id, 0);
  assert.deepEqual(rec.currentSpot, { id: 0, label: 'Sala', floor: 0, scans: 0, target: 3 });
  // chegou 0,5 s depois de marcar: foi ouvida quase toda antes de parar
  assert.equal(feed(rec, clock, 1, 500), true);
  assert.equal(rec.currentSpot.scans, 0);
  feed(rec, clock, 2);
  feed(rec, clock, 3);
  assert.equal(rec.currentSpot.scans, 2);
  assert.match(rec.stats().hint, /Fique parado: 2 de 3/);
  feed(rec, clock, 4);
  assert.match(rec.stats().hint, /Ponto marcado/);
  assert.equal(rec.endSpot(), true);
  assert.equal(rec.endSpot(), false);
  assert.equal(rec.currentSpot, null);
  feed(rec, clock, 5);

  const scans = rec.toSurvey().scans;
  assert.deepEqual(
    scans.map((s) => [s.still, s.spot, s.label ?? null]),
    [
      [false, null, null],
      [false, null, null],
      [true, 0, 'Sala'],
      [true, 0, 'Sala'],
      [true, 0, 'Sala'],
      [false, null, null],
    ],
  );
  const stats = rec.stats();
  assert.equal(stats.stillScans, 3);
  assert.equal(stats.walkScans, 3);
  assert.equal(stats.spots, 1);
  assert.deepEqual(stats.labels, ['Sala']);
  assert.deepEqual(rec.spots(), [{ id: 0, label: 'Sala', floor: 0, scans: 3 }]);
  assert.equal(rec.beginSpot('fora de hora') !== null, true);
  rec.stop();
  assert.equal(rec.beginSpot('depois do fim'), null, 'sem gravar não há ponto');
});

test('pontos: renomear, remover, voltar a um ponto e ponto sem varredura', () => {
  const { rec, clock } = started();
  const a = rec.beginSpot('');
  feed(rec, clock, 0);
  feed(rec, clock, 1);
  rec.endSpot();
  assert.equal('label' in rec.toSurvey().scans[0], false, 'ponto sem nome não tem label');
  assert.deepEqual(rec.stats().labels, []);

  assert.equal(rec.renameSpot(a, '  Cozinha  '), true);
  assert.deepEqual(
    rec.toSurvey().scans.map((s) => s.label),
    ['Cozinha', 'Cozinha'],
  );
  assert.equal(rec.renameSpot(99, 'x'), false);
  assert.equal(rec.renameSpot(a, ''), true);
  assert.equal('label' in rec.toSurvey().scans[0], false);
  rec.renameSpot(a, 'Cozinha');

  // ponto marcado e abandonado antes de qualquer varredura: não existe
  const empty = rec.beginSpot('Varanda');
  rec.endSpot();
  assert.equal(rec.spots().some((s) => s.id === empty), false);
  assert.equal(rec.stats().spots, 1);

  const b = rec.beginSpot('Quarto');
  feed(rec, clock, 2);
  rec.endSpot();
  feed(rec, clock, 3);
  // "voltei ao ponto da cozinha"
  assert.equal(rec.resumeSpot(a), true);
  feed(rec, clock, 4);
  rec.endSpot();
  assert.equal(rec.resumeSpot(1234), false);
  assert.deepEqual(
    rec.toSurvey().scans.map((s) => s.spot),
    [a, a, b, null, a],
  );

  assert.equal(rec.removeSpot(a), true);
  assert.equal(rec.removeSpot(a), false);
  const scans = rec.toSurvey().scans;
  assert.deepEqual(
    scans.map((s) => [s.still, s.spot, s.label ?? null]),
    [
      [false, null, null],
      [false, null, null],
      [true, b, 'Quarto'],
      [false, null, null],
      [false, null, null],
    ],
  );
  assert.equal(rec.stats().spots, 1);
  assert.deepEqual(surveyProblems(rec.toSurvey()), []);
});

test('pontos: o nome é texto simples e curto, mesmo quando o usuário digita o que não deve', () => {
  assert.equal(cleanLabel('  Sala   de\testar\n'), 'Sala de estar');
  assert.equal(cleanLabel('Sa\u0000la\u0007\u001b[31m'), 'Sa la [31m');
  assert.equal(cleanLabel('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>', 'HTML fica como texto: quem desenha usa textContent');
  assert.equal(Array.from(cleanLabel('x'.repeat(500))).length, RECORDER_LIMITS.maxLabel);
  const emoji = cleanLabel('🛋️'.repeat(60));
  assert.ok(Array.from(emoji).length <= RECORDER_LIMITS.maxLabel);
  assert.equal(/[\ud800-\udbff]$/.test(emoji), false, 'não corta um emoji no meio');
  for (const junk of [null, undefined, 42, {}, [], () => {}]) assert.equal(cleanLabel(junk), '');

  const { rec, clock } = started();
  rec.beginSpot('  <b>Quarto</b>\n do   João ');
  feed(rec, clock, 0);
  assert.equal(rec.toSurvey().scans[0].label, '<b>Quarto</b> do João');
});

test('andares: setFloor marca as varreduras seguintes e encerra o ponto em andamento', () => {
  const { rec, clock } = started();
  feed(rec, clock, 0);
  rec.beginSpot('Sala');
  assert.equal(rec.setFloor(1), 1);
  assert.equal(rec.currentSpot, null, 'um ponto fica num andar só');
  feed(rec, clock, 1);
  assert.equal(rec.setFloor(1.4), 1);
  assert.equal(rec.setFloor('2'), 1, 'texto não é andar');
  assert.equal(rec.setFloor(Number.NaN), 1);
  rec.setFloor(-1);
  feed(rec, clock, 2);
  assert.equal(rec.floor, -1);
  assert.deepEqual(
    rec.toSurvey().scans.map((s) => s.floor),
    [0, 1, -1],
  );
  const stats = rec.stats();
  assert.deepEqual(stats.floors, [-1, 0, 1]);
  assert.equal(stats.floor, -1);
  assert.equal(rec.setFloor(999), 20, 'andar absurdo é limitado');
});

test('desfazer: tira a última varredura, não a regrava e ajusta a calibração', () => {
  const { rec, clock } = started();
  assert.equal(rec.undoLastScan(), null);
  for (let i = 0; i < 4; i++) feed(rec, clock, i);
  assert.equal(rec.addKnownDistance(0, 3, 4.5), true);
  assert.equal(rec.addKnownDistance(0, 1, 2), true);
  const last = scanEvent(clock, walkingAps(3));
  const removed = rec.undoLastScan();
  assert.equal(removed.t, 12);
  assert.equal(rec.stats().scans, 3);
  assert.deepEqual(rec.toSurvey().knownDistances, [{ a: 0, b: 1, meters: 2 }], 'a distância que usava a varredura desfeita sai');
  assert.equal(rec.onScan(last), false, 'a lista desfeita não volta sozinha');
  assert.equal(feed(rec, clock, 9), true);
});

test('calibração: distâncias conhecidas são conferidas', () => {
  const { rec, clock } = started();
  for (let i = 0; i < 3; i++) feed(rec, clock, i);
  for (const [a, b, m] of [
    [0, 0, 3],
    [0, 3, 3],
    [-1, 1, 3],
    [0.5, 1, 3],
    [0, 1, 0],
    [0, 1, -2],
    [0, 1, Number.NaN],
    [0, 1, 5000],
    ['0', 1, 3],
  ]) {
    assert.equal(rec.addKnownDistance(a, b, m), false, `${a}, ${b}, ${m}`);
  }
  assert.equal(rec.addKnownDistance(2, 0, 3.14159), true);
  assert.deepEqual(rec.toSurvey().knownDistances, [{ a: 2, b: 0, meters: 3.142 }]);
  rec.clearKnownDistances();
  assert.deepEqual(rec.toSurvey().knownDistances, []);
});

// ---------------------------------------------------------------------------
// Sinal conectado e RTT
// ---------------------------------------------------------------------------

test('sinal conectado: no máximo um por segundo, e o valor repetido só a cada 3 s', () => {
  const { rec, clock } = started();
  feed(rec, clock, 0); // mac(1) passa a ter dados
  const sample = (rssi, extra = {}) => ({ ts: clock.now(), rssi, bssid: mac(1), frequency: 2412, ...extra });
  // 10 s de amostras a cada 250 ms, com o valor mudando sempre
  let kept = 0;
  for (let i = 0; i < 40; i++) {
    clock.advance(250);
    if (rec.onRssi(sample(-50 - (i % 7)))) kept += 1;
  }
  assert.ok(kept >= 9 && kept <= 11, `mudando: ${kept} em 10 s`);
  // 12 s com o mesmo valor (o Android repete a leitura por alguns segundos)
  let same = 0;
  for (let i = 0; i < 48; i++) {
    clock.advance(250);
    if (rec.onRssi(sample(-61))) same += 1;
  }
  assert.ok(same >= 4 && same <= 5, `repetido: ${same} em 12 s`);

  assert.equal(rec.onRssi(sample(-60, { bssid: '' })), false, 'sem permissão o BSSID vem vazio');
  assert.equal(rec.onRssi(sample(-127)), false);
  assert.equal(rec.onRssi(sample(0)), false);
  assert.equal(rec.onRssi(null), false);
  assert.equal(rec.onRssi({ rssi: 'forte' }), false);

  const track = rec.toSurvey().track;
  assert.equal(track.length, kept + same);
  assert.ok(track.every((q, i) => i === 0 || q.t - track[i - 1].t >= RECORDER_LIMITS.trackMinS - 1e-9));
  assert.ok(track.every((q) => q.id === mac(1) && Number.isInteger(q.rssi)));

  rec.pause();
  clock.advance(5000);
  assert.equal(rec.onRssi(sample(-70)), false, 'em pausa não grava');
});

test('sinal conectado: rádio que nunca apareceu numa varredura entra com a frequência da amostra', () => {
  const { rec, clock } = started();
  clock.advance(1000);
  assert.equal(rec.onRssi({ ts: clock.now(), rssi: -55, bssid: mac(7), frequency: 5180 }), true);
  clock.advance(2000);
  assert.equal(rec.onRssi({ ts: clock.now(), rssi: -57, bssid: mac(8) }), true, 'grava, mas sem frequência não tem como usar');
  const survey = rec.toSurvey();
  assert.deepEqual(survey.track, [{ t: 1, id: mac(7), rssi: -55 }]);
  assert.equal(survey.aps[mac(7)].freq, 5180);
  assert.deepEqual(surveyProblems(survey).filter((p) => !/readings/.test(p)), []);
});

test('RTT: guarda só as medições que deram certo', () => {
  const { rec, clock } = started();
  clock.advance(4000);
  const added = rec.onRtt({
    results: [
      { bssid: mac(1), ok: true, distM: 3.4567, stdM: 0.42 },
      { bssid: mac(2), ok: false },
      { bssid: mac(3), ok: true, distM: -0.2 }, // perto do roteador o Android pode dar negativo
      { bssid: 'lixo', ok: true, distM: 2 },
      { bssid: mac(4), ok: true, distM: Number.NaN },
      null,
    ],
  });
  assert.equal(added, 2);
  assert.equal(rec.onRtt([{ bssid: mac(5), ok: true, distM: 7, stdM: -1 }]), 1);
  assert.equal(rec.onRtt('nada'), 0);
  assert.deepEqual(rec.toSurvey().rtt, [
    { t: 4, id: mac(1), distM: 3.457, stdM: 0.42 },
    { t: 4, id: mac(3), distM: -0.2, stdM: 1 },
    { t: 4, id: mac(5), distM: 7, stdM: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// Estatísticas, níveis e dicas
// ---------------------------------------------------------------------------

test('níveis: 25 medições para o mínimo, 60 para bom, 120 e 3 nomes para ótimo', () => {
  const T = SURVEY_THRESHOLDS;
  assert.deepEqual([T.minUseful, T.minSpots, T.goodUseful, T.goodSpots, T.greatUseful, T.greatSpots, T.labelsWanted, T.scansPerSpot], [25, 12, 60, 20, 120, 32, 3, 3]);
  const { rec, clock } = started();
  const levels = {};
  for (let i = 1; i <= 121; i++) {
    feed(rec, clock, i);
    const s = rec.stats();
    assert.equal(s.useful, i);
    levels[i] = s.level;
    if (i === 24) assert.match(s.hint, /falta 1 varredura para um mapa mínimo/);
    if (i === 10) assert.match(s.hint, /faltam 15 varreduras/);
    if (i === 25) assert.match(s.hint, /Marque pelo menos 3 lugares com nome/);
  }
  assert.equal(levels[1], 'insuficiente');
  assert.equal(levels[24], 'insuficiente');
  assert.equal(levels[25], 'minimo');
  assert.equal(levels[59], 'minimo');
  assert.equal(levels[60], 'bom');
  assert.equal(levels[121], 'bom', 'sem lugares com nome não chega a ótimo');

  for (const name of ['Sala', 'Cozinha', 'Quarto']) {
    rec.beginSpot(name);
    feed(rec, clock, 200);
    rec.endSpot();
    feed(rec, clock, 201);
  }
  const s = rec.stats();
  assert.deepEqual(s.labels, ['Sala', 'Cozinha', 'Quarto']);
  assert.equal(s.level, 'otimo');
  assert.match(s.hint, /ótimo/);
  assert.equal(s.throttled, false);
  assert.equal(s.cadenceS, 3);
  assert.equal(s.aps, 5);
  assert.equal(s.devices, 5);
});

test('níveis: com o celular limitado valem os pontos — 12 para o mínimo, 20 para bom, 32 para ótimo', () => {
  const { rec, clock } = started();
  const levels = {};
  for (let i = 1; i <= 32; i++) {
    rec.beginSpot(i <= 3 ? `Lugar ${i}` : '');
    feed(rec, clock, i * 3, 30_000); // uma varredura a cada 30 s
    rec.endSpot();
    const s = rec.stats();
    assert.equal(s.spots, i);
    levels[i] = s.level;
    if (i === 5) {
      assert.equal(s.throttled, true);
      assert.equal(s.cadenceS, 30);
      assert.match(s.hint, /limitando as buscas.*marque um ponto \(faltam 7\)/);
    }
    if (i === 13) assert.match(s.hint, /faltam 7\)/, 'agora a meta é o nível bom');
  }
  assert.equal(levels[11], 'insuficiente');
  assert.equal(levels[12], 'minimo');
  assert.equal(levels[19], 'minimo');
  assert.equal(levels[20], 'bom');
  assert.equal(levels[31], 'bom');
  assert.equal(levels[32], 'otimo');
  // limitado: uma varredura por ponto já basta
  rec.beginSpot('Outro');
  assert.equal(rec.currentSpot.target, 1);
  assert.equal(rec.stats().spot.target, 1);
});

test('níveis: ficar parado num ponto só conta até a terceira varredura', () => {
  const { rec, clock } = started();
  rec.beginSpot('Sofá');
  for (let i = 0; i < 40; i++) feed(rec, clock, i);
  rec.endSpot();
  const s = rec.stats();
  assert.equal(s.scans, 40);
  assert.equal(s.stillScans, 40);
  assert.equal(s.useful, 3);
  assert.equal(s.level, 'insuficiente');
});

test('níveis: sinal que não varia = a pessoa não saiu do lugar, por mais varreduras que faça', () => {
  const { rec, clock } = started();
  for (let i = 0; i < 70; i++) {
    clock.advance(3000);
    // ruído de ±1 dB em volta de níveis fixos
    rec.onScan(scanEvent(clock, [0, 1, 2, 3, 4].map((k) => ap(mac(k + 1), -45 - k * 7 + ((i + k) % 3) - 1))));
  }
  const s = rec.stats();
  assert.equal(s.useful, 70);
  assert.ok(s.spreadDb !== null && s.spreadDb < SURVEY_THRESHOLDS.stillSpreadDb, `variação ${s.spreadDb} dB`);
  assert.equal(s.level, 'insuficiente');
  assert.match(s.hint, /quase não mudou: ande pelos cômodos/);

  const moving = started();
  for (let i = 0; i < 70; i++) feed(moving.rec, moving.clock, i);
  assert.ok(moving.rec.stats().spreadDb > 15);
});

test('dicas: uma frase para cada momento', () => {
  const clock = fakeClock();
  const rec = createRecorder({ now: clock.now });
  assert.match(rec.stats().hint, /Toque em começar/);
  assert.equal(rec.stats().lastScanAgoS, null);
  rec.start();
  assert.match(rec.stats().hint, /Aguardando a primeira varredura/);
  feed(rec, clock, 0);
  clock.advance(4200);
  assert.equal(rec.stats().lastScanAgoS, 4.2);
  rec.pause();
  assert.match(rec.stats().hint, /Em pausa/);
  rec.stop();
  assert.match(rec.stats().hint, /Poucas medições/);

  const full = started();
  for (let i = 0; i < 30; i++) feed(full.rec, full.clock, i);
  for (const name of ['A', 'B', 'C']) {
    full.rec.beginSpot(name);
    feed(full.rec, full.clock, 50);
    full.rec.endSpot();
  }
  assert.match(full.rec.stats().hint, /Continue andando: faltam cômodos/);
  for (let i = 0; i < 30; i++) feed(full.rec, full.clock, 100 + i);
  assert.match(full.rec.stats().hint, /bom mapa.*outro andar, suba ou desça e marque o andar/);
  full.rec.setFloor(1);
  feed(full.rec, full.clock, 300);
  assert.match(full.rec.stats().hint, /bom mapa\. Mais uma volta/);
  full.rec.stop();
  assert.match(full.rec.stats().hint, /Levantamento encerrado/);
});

// ---------------------------------------------------------------------------
// Survey, retrato e avisos
// ---------------------------------------------------------------------------

test('toSurvey: bate com o tipo e é uma cópia funda', () => {
  const { rec, clock } = started();
  for (let i = 0; i < 6; i++) feed(rec, clock, i);
  rec.beginSpot('Sala');
  for (let i = 6; i < 9; i++) feed(rec, clock, i);
  rec.endSpot();
  rec.setFloor(1);
  feed(rec, clock, 9);
  rec.onRssi({ ts: clock.now(), rssi: -48, bssid: mac(1), frequency: 2412 });
  rec.onRtt([{ bssid: mac(2), ok: true, distM: 4.2, stdM: 0.5 }]);
  rec.addKnownDistance(0, 5, 3);

  const survey = rec.toSurvey();
  assert.deepEqual(surveyProblems(survey), []);
  assert.deepEqual(validateSurvey(survey), []);
  assert.deepEqual(JSON.parse(JSON.stringify(survey)), survey, 'só dados: atravessa JSON e postMessage sem perder nada');
  assert.ok(Object.values(survey.aps).every((a) => typeof a.device === 'string' && a.device));

  // mexer na cópia não mexe no gravador
  survey.scans[0].readings[0].rssi = -1;
  survey.scans.pop();
  survey.aps[mac(1)].ssid = 'trocado';
  survey.track.length = 0;
  survey.knownDistances[0].meters = 99;
  const again = rec.toSurvey();
  assert.notEqual(again.scans[0].readings[0].rssi, -1);
  assert.equal(again.scans.length, 10);
  assert.equal(again.aps[mac(1)].ssid, 'Rede');
  assert.equal(again.track.length, 1);
  assert.equal(again.knownDistances[0].meters, 3);
});

test('validateSurvey e sanitizeSurvey: aponta o que está errado e limpa o que vem de fora', () => {
  assert.deepEqual(validateSurvey(null), ['não é um objeto']);
  assert.ok(validateSurvey({ version: 2, scans: [], aps: {} }).length > 0);
  const bad = {
    version: 1,
    scans: [
      { t: 5, floor: 0, still: true, spot: null, readings: [{ id: 'xx', rssi: 5, freq: 0 }] },
      { t: 1, floor: 0.5, still: 'sim', spot: -1, label: '', readings: 'nada' },
    ],
    aps: { 'não-bssid': {} },
    track: [{ t: 'a' }],
    knownDistances: [{ a: 0, b: 9, meters: 1 }],
  };
  const problems = validateSurvey(bad);
  for (const piece of ['parado sem ponto', 'readings[0].id', 't fora de ordem', 'floor', 'still', 'spot', 'label', 'não é BSSID', 'track[0]', 'knownDistances[0]']) {
    assert.ok(problems.some((p) => p.includes(piece)), `faltou apontar: ${piece}\n${problems.join('\n')}`);
  }

  for (const junk of [null, 42, 'x', [], {}, { scans: 'x' }, { version: 3, scans: [] }, { scans: [null] }, { scans: [{ t: 'a', readings: [] }] }, { scans: [{ t: 1 }] }]) {
    assert.equal(sanitizeSurvey(junk), null);
  }
  const hostile = JSON.parse(
    `{"version":1,"__proto__":{"polluted":true},"extra":"x",
      "scans":[{"t":3,"floor":2.6,"still":true,"spot":4,"label":"  <script>alert(1)</script>\\u0000  ","evil":1,
                "readings":[{"id":"AA:BB:CC:DD:EE:01","rssi":-50.4,"freq":2437,"ageMs":-5,"x":1},{"id":"aa:bb:cc:dd:ee:01","rssi":-40,"freq":2437},
                            {"id":"zz","rssi":-50,"freq":2437},{"id":"aa:bb:cc:dd:ee:02","rssi":10,"freq":2437}]},
               {"t":1,"floor":0,"still":false,"spot":7,"label":"sem ponto","readings":[]}],
      "aps":{"__proto__":{"ssid":"x","freq":1},"aa:bb:cc:dd:ee:01":{"ssid":"${'s'.repeat(200)}","freq":"2437","device":"d1","evil":true},"constructor":{"ssid":"c","freq":1}},
      "track":[{"t":1,"id":"aa:bb:cc:dd:ee:01","rssi":-60},{"t":-1,"id":"aa:bb:cc:dd:ee:01","rssi":-60},{"t":2,"id":"x","rssi":-60}],
      "rtt":[{"t":1,"id":"aa:bb:cc:dd:ee:01","distM":3}],
      "knownDistances":[{"a":0,"b":1,"meters":2},{"a":0,"b":5,"meters":2}]}`,
  );
  const clean = sanitizeSurvey(hostile);
  assert.deepEqual(validateSurvey(clean), []);
  assert.deepEqual(Object.keys(clean).sort(), ['aps', 'knownDistances', 'rtt', 'scans', 'track', 'version']);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(clean.scans[0], { t: 3, floor: 3, still: true, spot: 4, readings: [{ id: 'aa:bb:cc:dd:ee:01', rssi: -50, freq: 2437 }], label: '<script>alert(1)</script>' });
  assert.deepEqual(clean.scans[1], { t: 3, floor: 0, still: false, spot: null, readings: [] }, 'tempo nunca volta; ponto sem "parado" não existe');
  assert.deepEqual(Object.keys(clean.aps), ['aa:bb:cc:dd:ee:01']);
  assert.equal(clean.aps['aa:bb:cc:dd:ee:01'].ssid.length, 64);
  assert.equal(clean.aps['aa:bb:cc:dd:ee:01'].freq, 0, 'texto não é frequência');
  assert.deepEqual(clean.track, [{ t: 1, id: 'aa:bb:cc:dd:ee:01', rssi: -60 }]);
  assert.deepEqual(clean.rtt, [{ t: 1, id: 'aa:bb:cc:dd:ee:01', distM: 3, stdM: 1 }]);
  assert.deepEqual(clean.knownDistances, [{ a: 0, b: 1, meters: 2 }]);
});

test('retrato: toJSON -> texto -> recorderFromJSON devolve o mesmo levantamento, em pausa', () => {
  const { rec, clock } = started({ timeScale: 2 });
  for (let i = 0; i < 5; i++) feed(rec, clock, i);
  rec.beginSpot('Sala');
  feed(rec, clock, 5);
  feed(rec, clock, 6);
  rec.setFloor(1);
  feed(rec, clock, 7);
  rec.onRssi({ ts: clock.now(), rssi: -48, bssid: mac(1), frequency: 2412 });
  rec.onRtt([{ bssid: mac(2), ok: true, distM: 4.2, stdM: 0.5 }]);
  rec.addKnownDistance(1, 4, 2.5);
  const spot = rec.beginSpot('Quarto');
  feed(rec, clock, 8);

  const text = JSON.stringify(rec.toJSON());
  const before = rec.toSurvey();
  const statsBefore = rec.stats();

  const later = fakeClock(clock.now() + 3_600_000); // o app fechou e voltou uma hora depois
  const back = recorderFromJSON(text, { now: later.now });
  assert.ok(back);
  assert.equal(back.state, 'paused', 'quem estava gravando volta em pausa');
  assert.equal(back.timeScale, 2);
  assert.deepEqual(back.toSurvey(), before);
  const statsAfter = back.stats();
  for (const key of ['scans', 'stillScans', 'spots', 'labels', 'aps', 'devices', 'floors', 'floor', 'durationS', 'level', 'useful']) {
    assert.deepEqual(statsAfter[key], statsBefore[key], key);
  }
  assert.equal(back.currentSpot, null, 'o ponto em andamento não sobrevive: o usuário pode ter saído do lugar');

  // continua de onde parou: o tempo segue (com o salto da retomada) e os pontos não colidem
  assert.equal(back.resume(), true);
  later.advance(1500);
  assert.equal(back.onScan(scanEvent(later, walkingAps(20))), true);
  const next = back.beginSpot('Banheiro');
  assert.equal(next, spot + 1);
  const survey = back.toSurvey();
  const lastTwo = survey.scans.slice(-2);
  assert.ok(lastTwo[1].t >= lastTwo[0].t + RECORDER_LIMITS.resumeGapS, `${lastTwo[0].t} -> ${lastTwo[1].t}`);
  assert.deepEqual(surveyProblems(survey), []);
  // o objeto (sem passar por texto) e o retrato de um gravador parado também servem
  assert.deepEqual(recorderFromJSON(rec.toJSON()).toSurvey(), before);
  rec.stop();
  assert.equal(recorderFromJSON(rec.toJSON()).state, 'stopped');
  const idle = createRecorder();
  assert.equal(recorderFromJSON(idle.toJSON()).state, 'idle');
});

test('retrato: "continuar este mapa" a partir de um Survey salvo', () => {
  const { rec, clock } = started();
  for (let i = 0; i < 8; i++) feed(rec, clock, i);
  rec.beginSpot('Sala');
  feed(rec, clock, 8);
  rec.endSpot();
  rec.setFloor(1);
  feed(rec, clock, 9);
  const saved = rec.toSurvey();

  const again = recorderFromJSON(JSON.parse(JSON.stringify(saved)), { now: clock.now });
  assert.ok(again);
  assert.equal(again.state, 'paused');
  assert.equal(again.floor, 1, 'continua no andar em que parou');
  assert.deepEqual(again.toSurvey(), saved);
  again.resume();
  feed(again, clock, 10);
  assert.equal(again.beginSpot('Quarto'), 1);
  feed(again, clock, 11);
  const survey = again.toSurvey();
  assert.equal(survey.scans.length, 12);
  assert.ok(survey.scans[10].t >= saved.scans[9].t + RECORDER_LIMITS.resumeGapS);
  assert.deepEqual(surveyProblems(survey), []);
  // os aparelhos que o levantamento já trazia continuam os mesmos
  for (const id of Object.keys(saved.aps)) assert.equal(survey.aps[id].device, saved.aps[id].device);
});

test('retrato: conteúdo que não presta devolve null, nunca erro', () => {
  const { rec, clock } = started();
  feed(rec, clock, 0);
  const good = rec.toJSON();
  for (const junk of [
    null,
    undefined,
    42,
    '',
    'não é json',
    '{"kind":"wrx-recorder"',
    '[]',
    '{}',
    { kind: 'wrx-recorder', v: 999, survey: good.survey },
    { kind: 'wrx-recorder', v: 1 },
    { kind: 'wrx-recorder', v: 1, survey: { scans: 'x' } },
    { kind: 'outro', v: 1, survey: good.survey },
    { ...good, survey: { ...good.survey, scans: [{ t: 'a' }] } },
  ]) {
    assert.equal(recorderFromJSON(junk), null, JSON.stringify(junk)?.slice(0, 60));
  }
  // campos estranhos em volta de um levantamento bom são ignorados
  const odd = recorderFromJSON({ ...good, state: 'voando', floor: 'térreo', spots: [null, { id: -3 }, 'x'], segs: 'x', votes: { seen: { lixo: 'x' }, together: { 'a|b': 1, [`${mac(1)}|${mac(2)}`]: -1 } }, nextSpot: -5, walkMs: -1, gapMs: 'x', meta: { lixo: 1 } });
  assert.ok(odd);
  assert.equal(odd.state, 'paused');
  assert.equal(odd.floor, 0);
  assert.deepEqual(validateSurvey(odd.toSurvey()), []);
});

test('avisos: subscribe conta cada mudança e um ouvinte com erro não derruba o gravador', (t) => {
  const { rec, clock } = started();
  const events = [];
  const off = rec.subscribe((e) => events.push(e.type));
  t.mock.method(console, 'error', () => {});
  rec.subscribe(() => {
    throw new Error('ouvinte quebrado');
  });
  feed(rec, clock, 0);
  rec.onScan(scanEvent(clock, walkingAps(0))); // repetida: sem aviso
  rec.beginSpot('Sala');
  feed(rec, clock, 1);
  rec.endSpot();
  rec.setFloor(1);
  rec.setFloor(1); // sem mudança: sem aviso
  rec.addKnownDistance(0, 1, 2);
  rec.undoLastScan();
  rec.pause();
  rec.resume();
  rec.stop();
  assert.deepEqual(events, ['scan', 'spot', 'scan', 'spot', 'floor', 'calibration', 'undo', 'state', 'state', 'state']);
  assert.ok(console.error.mock.callCount() >= events.length);
  off();
  rec.resume();
  assert.equal(events.length, 10);
  assert.equal(typeof rec.subscribe('não é função'), 'function');
});

// ---------------------------------------------------------------------------
// Sessões simuladas (simulador de verdade, relógio manual)
// ---------------------------------------------------------------------------

/** Simulador + store + gravador ligados como na tela do mapa. `truth` = onde cada varredura gravada foi feita. */
function session({ world = 'apartamento', seed = 1, speed = 1, walk = 'auto', timeScale = speed } = {}) {
  const clock = createManualClock();
  const store = createStore({ now: clock.now });
  const rec = createRecorder({ now: clock.now, timeScale });
  const truth = [];
  const counts = { scan: 0, fresh: 0 };
  let backend = null;
  backend = createSimBackend({
    clock,
    world,
    seed,
    speed,
    walk,
    emit(name, data) {
      if (name === 'scan') {
        counts.scan += 1;
        if (data.fresh) counts.fresh += 1;
        store.ingestScan(data);
        if (rec.onScan(data, { aps: store.get().aps })) {
          const p = backend.sim.truth();
          truth.push({ x: p.x, y: p.y, floor: p.floor, room: p.room });
        }
      } else if (name === 'rssi') {
        rec.onRssi(data);
      } else if (name === 'connection') {
        store.setConnection(data);
      }
    },
  });
  store.setConnection(backend.call('connection')); // é a rede conectada que diz quais roteadores são "da casa"
  backend.call('watchRssi', { intervalMs: 1000 });
  return { clock, store, rec, truth, counts, backend, sim: backend.sim, requestScan: () => backend.callAsync('scan') };
}

/** Erro de posição (m) da solução contra a verdade, depois do melhor alinhamento rígido. */
function positionErrors(solution, truth) {
  const fit = procrustes(solution.points, truth, { scale: false });
  const errs = fit.aligned.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y)).sort((a, b) => a - b);
  const radius = (pts) => {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return Math.sqrt(pts.reduce((s, p) => s + (p.x - cx) ** 2 + (p.y - cy) ** 2, 0) / pts.length);
  };
  return { median: errs[errs.length >> 1], p90: errs[Math.floor(errs.length * 0.9)], scale: radius(solution.points) / radius(truth) };
}

/** Os grupos de aparelho do levantamento nunca misturam dois roteadores de verdade. */
function mixedDevices(survey, world) {
  const real = new Map(world.aps.map((a) => [a.bssid, a.device]));
  const groups = new Map();
  for (const [id, a] of Object.entries(survey.aps)) {
    if (!groups.has(a.device)) groups.set(a.device, new Set());
    groups.get(a.device).add(real.get(id));
  }
  return [...groups.values()].filter((g) => g.size > 1).length;
}

test('sessão simulada: 5 minutos andando pelo apartamento viram um levantamento válido que resolve num mapa são', async () => {
  const s = session({ world: 'apartamento' });
  s.rec.start();
  for (let i = 0; i < 100; i++) {
    s.requestScan().catch(() => {});
    await s.clock.advanceAsync(3000);
    // um toque repetido em "buscar": a mesma lista chega de novo e não pode ser gravada duas vezes
    if (i % 10 === 5) s.rec.onScan(s.backend.call('lastScan'), { aps: s.store.get().aps });
  }
  s.rec.stop();
  const stats = s.rec.stats();
  const survey = s.rec.toSurvey();
  assert.deepEqual(surveyProblems(survey), []);
  assert.deepEqual(validateSurvey(survey), []);
  assert.equal(survey.scans.length, s.counts.fresh, 'cada lista nova gravada uma vez só');
  assert.ok(stats.scans >= 95 && stats.scans <= 112, `${stats.scans} varreduras`);
  assert.equal(stats.level, 'bom');
  assert.ok(stats.cadenceS >= 2.5 && stats.cadenceS <= 3.5, `ritmo ${stats.cadenceS}`);
  assert.equal(stats.throttled, false);
  assert.ok(Math.abs(stats.durationS - 300) < 1);
  assert.ok(stats.spreadDb > 10, 'andando, o sinal varia');
  assert.ok(survey.track.length > 150, `${survey.track.length} amostras do sinal conectado`);

  // agrupamento por aparelho: os rádios do mesmo roteador juntos, roteadores diferentes separados
  assert.equal(mixedDevices(survey, s.sim.world), 0);
  const realDevices = new Set(Object.keys(survey.aps).map((id) => s.sim.world.ap(id).device)).size;
  assert.equal(stats.devices, realDevices);
  assert.ok(stats.aps > stats.devices, 'há roteador com mais de um rádio');
  // leituras: idades plausíveis e quase todas desta varredura
  const ages = survey.scans.flatMap((x) => x.readings.map((r) => r.ageMs));
  assert.ok(ages.every((a) => Number.isFinite(a) && a >= 0 && a <= RECORDER_LIMITS.maxReadingAgeMs));
  // a maioria é desta varredura; o resto são as leituras antigas que o Android repete
  const fresh = ages.filter((a) => a <= 4500).length / ages.length;
  assert.ok(fresh > 0.6 && fresh < 1, `${Math.round(fresh * 100)}% das leituras são da própria varredura`);

  const engine = createMapEngine();
  try {
    const out = await engine.run(survey, { own: [...s.store.get().own] });
    const err = positionErrors(out.solution, s.truth);
    assert.ok(err.median < 2.5, `erro mediano ${err.median.toFixed(2)} m`);
    assert.ok(err.p90 < 5, `p90 ${err.p90.toFixed(2)} m`);
    assert.ok(err.scale > 0.6 && err.scale < 1.6, `escala ${err.scale.toFixed(2)}`);
    assert.equal(out.model.path.length, survey.scans.length);
    assert.ok(out.model.quality.areaM2 > 10 && out.model.quality.areaM2 < 120, `área ${out.model.quality.areaM2}`);
    assert.ok(out.model.aps.some((a) => a.own), 'o roteador da casa aparece como da casa');
  } finally {
    engine.dispose();
    s.backend.dispose();
  }
});

test('sessão simulada: parado no mesmo lugar o gravador percebe e não promete mapa', async () => {
  const s = session({ world: 'kitnet', walk: 'still' });
  s.rec.start();
  for (let i = 0; i < 40; i++) {
    s.requestScan().catch(() => {});
    await s.clock.advanceAsync(3000);
  }
  const stats = s.rec.stats();
  s.backend.dispose();
  assert.ok(stats.scans >= 38);
  assert.ok(stats.spreadDb < SURVEY_THRESHOLDS.stillSpreadDb, `variação ${stats.spreadDb} dB`);
  assert.equal(stats.level, 'insuficiente');
  assert.match(stats.hint, /ande pelos cômodos/);
});

test('sessão simulada: com o tempo acelerado 8x o levantamento sai igual ao de velocidade normal', async () => {
  const run = async (speed) => {
    const s = session({ world: 'apartamento', speed });
    s.rec.start();
    for (let i = 0; i < 40; i++) {
      s.requestScan().catch(() => {});
      await s.clock.advanceAsync(3000 / speed);
    }
    const survey = s.rec.toSurvey();
    const stats = s.rec.stats();
    s.backend.dispose();
    return { survey, stats };
  };
  const slow = await run(1);
  const fast = await run(8);
  assert.deepEqual(surveyProblems(fast.survey), []);
  assert.equal(fast.survey.scans.length, slow.survey.scans.length);
  assert.ok(Math.abs(fast.stats.durationS - slow.stats.durationS) < 0.5, `${fast.stats.durationS} x ${slow.stats.durationS}`);
  assert.equal(fast.stats.cadenceS, slow.stats.cadenceS);
  fast.survey.scans.forEach((scan, i) => {
    const other = slow.survey.scans[i];
    assert.ok(Math.abs(scan.t - other.t) < 0.05, `t da varredura ${i}: ${scan.t} x ${other.t}`);
    assert.deepEqual(
      scan.readings.map((r) => [r.id, r.rssi]),
      other.readings.map((r) => [r.id, r.rssi]),
    );
    // idades em tempo de caminhada, a menos do arredondamento do simulador (1 ms de relógio = 8 ms)
    scan.readings.forEach((r, k) => assert.ok(Math.abs(r.ageMs - other.readings[k].ageMs) <= 8, `idade ${r.ageMs} x ${other.readings[k].ageMs}`));
  });
  assert.ok(Math.abs(fast.survey.track.length - slow.survey.track.length) <= 2);
});

test('sessão simulada: com o limite do Android (e o laço de buscas de verdade) o ritmo cai e o gravador avisa', async () => {
  // aqui quem pede as varreduras é o scan-loop do app, em modo de mapeamento, como na tela
  const clock = createManualClock();
  const store = createStore({ now: clock.now });
  const rec = createRecorder({ now: clock.now });
  const listeners = new Map();
  const counts = { scan: 0, fresh: 0 };
  const backend = createSimBackend({
    clock,
    world: 'apartamento',
    throttle: true,
    emit(name, data) {
      for (const fn of listeners.get(name) || []) fn(data);
    },
  });
  const bridge = {
    scan: () => backend.callAsync('scan'),
    lastScan: async () => backend.call('lastScan'),
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name).delete(fn);
    },
  };
  store.setStatus(backend.call('status'));
  const loop = createScanLoop({ bridge, store, now: clock.now, setTimer: clock.setTimeout, clearTimer: clock.clearTimeout, doc: null });
  bridge.on('scan', (ev) => {
    counts.scan += 1;
    if (ev.fresh) counts.fresh += 1;
    rec.onScan(ev, { aps: store.get().aps });
  });
  loop.start();
  loop.setMode('mapping');
  rec.start();
  const seen = [];
  for (let i = 0; i < 60; i++) {
    await clock.advanceAsync(10_000);
    if (i >= 12) seen.push(rec.stats().throttled);
  }
  const stats = rec.stats();
  const survey = rec.toSurvey();
  loop.stop();
  backend.dispose();
  assert.equal(survey.scans.length, counts.fresh, 'só as listas novas foram gravadas');
  assert.ok(stats.scans >= 18 && stats.scans <= 45, `${stats.scans} varreduras em 10 minutos`);
  assert.ok(stats.cadenceS > 12, `ritmo ${stats.cadenceS} s`);
  assert.equal(stats.throttled, true);
  assert.ok(seen.every(Boolean), 'depois dos primeiros minutos o aviso de limite não pisca');
  assert.match(stats.hint, /limitando as buscas/);
  assert.equal(stats.level, 'minimo');
  assert.deepEqual(surveyProblems(survey), []);
});

// ---------------------------------------------------------------------------
// Piloto da demonstração
// ---------------------------------------------------------------------------

async function runPilot(s, options = {}, { maxRealS = 150 } = {}) {
  const steps = [];
  const pilot = createDemoPilot({ sim: s.sim, recorder: s.rec, clock: s.clock, requestScan: s.requestScan, onStep: (step) => steps.push(step), ...(options.deps || {}) });
  const t0 = s.clock.now();
  const startedOk = pilot.start(options.start || {});
  while (pilot.running && s.clock.now() - t0 < maxRealS * 1000) await s.clock.advanceAsync(100);
  return { pilot, steps, startedOk, realS: (s.clock.now() - t0) / 1000 };
}

test('piloto: percorre o apartamento sozinho, marca todos os cômodos, termina em menos de um minuto e devolve o simulador como estava', async () => {
  const s = session({ world: 'apartamento', timeScale: 1 });
  const before = { speed: s.sim.speed, mode: s.sim.walker.mode, timeScale: s.rec.timeScale };
  assert.equal(s.rec.state, 'idle');
  const { pilot, steps, startedOk, realS } = await runPilot(s);
  assert.equal(startedOk, true);
  assert.equal(pilot.running, false);
  const last = steps[steps.length - 1];
  assert.equal(last.phase, 'done');
  assert.equal(last.complete, true);
  assert.equal(last.progress, 1);
  assert.ok(realS < 45, `levou ${realS.toFixed(1)} s de relógio`);

  // durante o piloto: velocidade 8x e gravador na mesma escala; depois: tudo de volta
  assert.deepEqual({ speed: s.sim.speed, mode: s.sim.walker.mode, timeScale: s.rec.timeScale }, before);
  assert.equal(s.rec.state, 'recording', 'quem encerra a gravação é a tela');
  assert.equal(s.rec.currentSpot, null);

  // todos os cômodos marcados, com o nome certo, no lugar certo
  const rooms = s.sim.world.rooms.map((r) => r.name);
  const stats = s.rec.stats();
  assert.deepEqual([...stats.labels].sort(), [...rooms].sort());
  assert.deepEqual(last.rooms, { marked: rooms.length, total: rooms.length });
  assert.ok(stats.scans >= PILOT_DEFAULTS.minScans, `${stats.scans} varreduras`);
  assert.ok(['bom', 'otimo'].includes(stats.level), stats.level);
  assert.ok(stats.cadenceS >= 2.5 && stats.cadenceS <= 3.6, `ritmo de caminhada ${stats.cadenceS} s`);
  const survey = s.rec.toSurvey();
  assert.deepEqual(surveyProblems(survey), []);
  survey.scans.forEach((scan, i) => {
    if (scan.still) assert.equal(scan.label, s.truth[i].room, `varredura ${i} marcada como ${scan.label}, feita em ${s.truth[i].room}`);
  });
  for (const spot of s.rec.spots()) assert.ok(spot.scans >= PILOT_DEFAULTS.scansPerSpot, `ponto ${spot.label} com ${spot.scans}`);

  // o que a tela recebeu pelo caminho
  assert.ok(steps.length > 20);
  assert.ok(steps.every((x) => ['walking', 'marking', 'done'].includes(x.phase)));
  assert.ok(steps.some((x) => x.phase === 'marking' && rooms.includes(x.room)));
  assert.ok(steps.every((x, i) => i === 0 || x.progress >= steps[i - 1].progress), 'o progresso nunca volta');
  assert.ok(steps.every((x) => x.progress >= 0 && x.progress <= 1));

  // e o levantamento do piloto dá um mapa são, com os cômodos pelo nome
  const engine = createMapEngine();
  try {
    const out = await engine.run(survey, { own: [...s.store.get().own] });
    const err = positionErrors(out.solution, s.truth);
    assert.ok(err.median < 2.5, `erro mediano ${err.median.toFixed(2)} m`);
    assert.ok(err.scale > 0.6 && err.scale < 1.6, `escala ${err.scale.toFixed(2)}`);
    const named = out.model.floors.flatMap((f) => f.rooms.filter((r) => !r.auto).map((r) => r.label));
    assert.ok(named.length >= rooms.length - 1, `ambientes com nome: ${named.join(', ')}`);
    assert.deepEqual([...new Set(out.model.spots.map((x) => x.label))].sort(), [...rooms].sort());
  } finally {
    engine.dispose();
    s.backend.dispose();
  }
});

test('piloto: no sobrado sobe a escada, marca os dois andares e todos os cômodos', async () => {
  const s = session({ world: 'sobrado', timeScale: 1 });
  const { steps, realS } = await runPilot(s);
  const last = steps[steps.length - 1];
  const stats = s.rec.stats();
  const survey = s.rec.toSurvey();
  const world = s.sim.world;
  s.backend.dispose();
  assert.equal(last.phase, 'done');
  assert.equal(last.complete, true, JSON.stringify(last));
  assert.ok(realS < 60, `levou ${realS.toFixed(1)} s de relógio`);
  assert.deepEqual(stats.floors, [0, 1]);
  assert.deepEqual([...stats.labels].sort(), [...new Set(world.rooms.map((r) => r.name))].sort());
  assert.equal(stats.spots >= world.rooms.length, true);
  // o andar marcado é o andar de verdade (fora a escada, onde a troca acontece no meio do caminho)
  let wrongFloor = 0;
  survey.scans.forEach((scan, i) => {
    if (scan.floor !== s.truth[i].floor) wrongFloor += 1;
    if (scan.still) assert.equal(scan.floor, s.truth[i].floor);
  });
  assert.ok(wrongFloor <= 4, `${wrongFloor} varreduras com o andar trocado`);
  assert.deepEqual(surveyProblems(survey), []);
});

test('piloto: stop() no meio devolve a velocidade e o modo de andar, e fecha o ponto aberto', async () => {
  const s = session({ world: 'apartamento', walk: 'still', timeScale: 1 });
  s.sim.setSpeed(2);
  s.rec.setTimeScale(2);
  const steps = [];
  const loopCalls = [];
  const scanLoop = { getState: () => ({ mode: 'normal' }), setMode: (m) => loopCalls.push(m) };
  let asked = 0;
  const requestScan = () => {
    asked += 1;
    return s.requestScan();
  };
  const pilot = createDemoPilot({ sim: s.sim, recorder: s.rec, scanLoop, clock: s.clock, requestScan, onStep: (x) => steps.push(x) });
  assert.equal(pilot.running, false);
  pilot.stop(); // parar sem ter começado não faz nada
  assert.equal(steps.length, 0);

  assert.equal(pilot.start({ speed: 12 }), true);
  assert.equal(pilot.start({ speed: 3 }), false, 'já está rodando');
  assert.equal(pilot.running, true);
  assert.equal(s.sim.speed, 12);
  assert.equal(s.rec.timeScale, 12);
  assert.equal(s.sim.walker.mode, 'auto');
  assert.deepEqual(loopCalls, ['mapping']);
  // anda até estar no meio de um ponto
  for (let i = 0; i < 400 && !(steps.length && steps[steps.length - 1].phase === 'marking'); i++) await s.clock.advanceAsync(20);
  assert.equal(steps[steps.length - 1].phase, 'marking');
  assert.ok(s.rec.currentSpot);
  assert.equal(s.sim.walker.mode, 'still');

  pilot.stop();
  assert.equal(pilot.running, false);
  assert.equal(steps[steps.length - 1].phase, 'stopped');
  assert.equal(s.sim.speed, 2);
  assert.equal(s.sim.walker.mode, 'still');
  assert.equal(s.rec.timeScale, 2);
  assert.equal(s.rec.currentSpot, null);
  assert.deepEqual(loopCalls, ['mapping', 'normal']);
  const count = steps.length;
  const requests = asked;
  assert.ok(requests >= 1);
  await s.clock.advanceAsync(5000);
  assert.equal(steps.length, count, 'parado não avisa mais nada');
  assert.equal(asked, requests, 'nem pede mais varreduras');
  s.backend.dispose();
});

test('piloto: respeita a pausa e o fim da gravação, e funciona sem marcar pontos', async () => {
  const s = session({ world: 'kitnet', timeScale: 1 });
  const steps = [];
  const pilot = createDemoPilot({ sim: s.sim, recorder: s.rec, clock: s.clock, requestScan: s.requestScan, onStep: (x) => steps.push(x) });
  pilot.start({ spots: false, minScans: 30 });
  await s.clock.advanceAsync(3000);
  s.rec.pause();
  await s.clock.advanceAsync(1000);
  assert.equal(steps[steps.length - 1].phase, 'paused');
  assert.equal(s.sim.walker.mode, 'still', 'a pessoa virtual espera');
  const frozen = s.rec.stats().scans;
  await s.clock.advanceAsync(3000);
  assert.equal(s.rec.stats().scans, frozen);
  s.rec.resume();
  while (pilot.running && s.rec.stats().scans < 200) await s.clock.advanceAsync(100);
  const last = steps[steps.length - 1];
  assert.equal(last.phase, 'done');
  assert.equal(last.complete, true);
  assert.equal(s.rec.stats().spots, 0, 'spots: false não marca nada');
  assert.ok(s.rec.stats().scans >= 30);

  // gravação encerrada pela tela: o piloto para sozinho
  const again = createDemoPilot({ sim: s.sim, recorder: s.rec, clock: s.clock, requestScan: s.requestScan, onStep: (x) => steps.push(x) });
  again.start({});
  await s.clock.advanceAsync(500);
  s.rec.stop();
  await s.clock.advanceAsync(500);
  assert.equal(again.running, false);
  assert.equal(steps[steps.length - 1].phase, 'stopped');
  assert.equal(s.sim.speed, 1);
  s.backend.dispose();
});

test('piloto: sem simulador não começa; pedido de varredura que falha não o derruba', async () => {
  const clock = fakeClock();
  const rec = createRecorder({ now: clock.now });
  assert.equal(createDemoPilot({ sim: null, recorder: rec }).start(), false);
  assert.equal(createDemoPilot({ sim: {}, recorder: rec }).start(), false);
  assert.equal(createDemoPilot({}).start(), false);
  assert.equal(rec.state, 'idle', 'nada foi mexido');

  const s = session({ world: 'kitnet', timeScale: 1 });
  let asked = 0;
  const pilot = createDemoPilot({
    sim: s.sim,
    recorder: s.rec,
    clock: s.clock,
    config: { maxWalkS: 60 },
    requestScan: () => {
      asked += 1;
      return asked % 2 ? Promise.reject(new Error('encerrado')) : Promise.resolve({ accepted: false, reason: 'throttled' });
    },
  });
  pilot.start({});
  for (let i = 0; i < 200 && pilot.running; i++) await s.clock.advanceAsync(100);
  assert.equal(pilot.running, false, 'sem varreduras, desiste no prazo');
  assert.ok(asked > 5);
  assert.equal(s.sim.speed, 1);
  s.backend.dispose();
});
