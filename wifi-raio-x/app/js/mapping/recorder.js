// Gravador do levantamento: transforma as varreduras recebidas durante a caminhada num
// Survey (types.js), que é o que fica salvo e o que entra no solucionador.
//
// ---------------------------------------------------------------------------------------------
// API
//
//   const rec = createRecorder({ now = Date.now, timeScale = 1 });
//
//   rec.state                         'idle' | 'recording' | 'paused' | 'stopped'
//   rec.start()                       idle -> recording
//   rec.pause() / rec.resume()        recording <-> paused (resume também reabre um levantamento 'stopped':
//                                     é o "continuar este mapa")
//   rec.stop()                        -> stopped
//   rec.reset()                       apaga tudo e volta a 'idle'
//
//   rec.onScan(scanEvent, { aps })    entregue TODOS os eventos 'scan'; `aps` = store.get().aps (lista normalizada,
//                                     para nome, frequência e agrupamento por aparelho). Devolve true se gravou.
//                                     Só grava lista nova (fresh === true), nunca a mesma lista duas vezes, e
//                                     descarta leitura absurda (nível >= 0 ou < -110 dBm) ou velha demais.
//   rec.onRssi(sample)                sinal da rede conectada entre varreduras -> survey.track
//   rec.onRtt(results)                RttResult[] (ou {results}) -> survey.rtt
//
//   rec.setFloor(n) / rec.floor       andar marcado pelo usuário (0 = onde começou)
//   rec.beginSpot(label) -> id        o usuário parou: as varreduras daqui em diante são still:true com este ponto
//                                     e este nome, até rec.endSpot(). (A lista que chega em menos de 1 s depois do
//                                     toque foi quase toda ouvida ainda andando: fica como varredura comum.)
//   rec.endSpot()
//   rec.resumeSpot(id)                "voltei ao ponto X": continua um ponto que já existe
//   rec.currentSpot                   { id, label, floor, scans, target } | null
//   rec.spots()                       [{ id, label, floor, scans }]
//   rec.renameSpot(id, label)         troca o nome em todas as varreduras do ponto
//   rec.removeSpot(id)                as varreduras dele viram varreduras comuns (andando)
//   rec.undoLastScan()                tira a última varredura gravada (devolve-a, ou null)
//
//   rec.addKnownDistance(a, b, m)     calibração: distância real (m) entre as varreduras de índice a e b
//   rec.clearKnownDistances()
//
//   rec.stats()                       veja RecorderStats abaixo
//   rec.toSurvey()                    Survey (cópia funda; `t` em segundos de caminhada)
//   rec.toJSON()                      retrato completo, para o salvamento automático
//   recorderFromJSON(json, opts)      refaz o gravador a partir do retrato (texto ou objeto) OU de um Survey
//                                     salvo; devolve null se o conteúdo não presta. Quem estava gravando
//                                     volta em pausa.
//   rec.subscribe(fn) -> cancelar     fn({ type }) a cada mudança ('state', 'scan', 'spot', 'floor', 'undo', 'calibration')
//   rec.timeScale / rec.setTimeScale(k)
//
// ---------------------------------------------------------------------------------------------
// TEMPO
//
// `t` é tempo de CAMINHADA, em segundos: relógio do celular x timeScale, sem as pausas. No celular
// de verdade timeScale = 1. Na demonstração o simulador comprime o tempo (a pessoa virtual anda
// `speed` vezes mais rápido que o relógio), então timeScale = sim.speed — e as idades das leituras
// (`ageMs`), que o simulador encolhe na mesma proporção, são esticadas de volta.
// A cada retomada depois de uma pausa o `t` das varreduras salta 30 s: durante a pausa o usuário
// pode ter ido para qualquer lugar, e o solucionador não deve achar que deu só um passo.
//
// ---------------------------------------------------------------------------------------------
// QUANTO É SUFICIENTE (SURVEY_THRESHOLDS)
//
// Vem da bancada de simulação (tests/mapping): os levantamentos que dão mapa com erro típico de
// 1,3 a 1,6 m numa casa têm de 70 a 150 varreduras andando, ou de 14 a 34 pontos marcados com 3
// varreduras cada; abaixo de ~25 varreduras (ou ~12 pontos, no modo "uma varredura a cada 30 s")
// o resultado deixa de ser confiável.
//
//   medições úteis = varreduras andando + até 3 por ponto marcado
//                    (ficar parado num ponto só soma até a terceira varredura: é o mesmo lugar)
//
//   'insuficiente'   menos de 25 medições úteis e menos de 12 pontos — ou o sinal não variou
//                    (a pessoa não saiu do lugar)
//   'minimo'         25+ medições úteis ou 12+ pontos
//   'bom'            60+ medições úteis ou 20+ pontos
//   'otimo'          120+ medições úteis ou 32+ pontos, com pelo menos 3 lugares com nome
//
// `throttled` = o intervalo típico entre as últimas varreduras passou de 20 s (limite do Android
// de 4 buscas a cada 2 minutos): aí a orientação muda para "pare e marque pontos".

import { groupByDevice, normalizeBssid } from '../core/model.js';

/**
 * @typedef {Object} RecorderStats
 * @property {'idle'|'recording'|'paused'|'stopped'} state
 * @property {number} scans           varreduras gravadas
 * @property {number} stillScans      as feitas parado (em pontos marcados)
 * @property {number} walkScans       as feitas andando
 * @property {number} useful          medições úteis (veja o cabeçalho)
 * @property {number} spots           pontos marcados que têm pelo menos uma varredura
 * @property {string[]} labels        nomes distintos dados aos pontos, na ordem em que apareceram
 * @property {number} aps             BSSIDs ouvidos
 * @property {number} devices         aparelhos físicos (roteadores) ouvidos
 * @property {number[]} floors        andares com varredura, em ordem crescente
 * @property {number} floor           andar marcado agora
 * @property {number} durationS       tempo de caminhada (escala aplicada, pausas fora)
 * @property {number|null} lastScanAgoS  segundos de relógio desde a última varredura gravada
 * @property {number|null} cadenceS   intervalo típico (mediana) entre as últimas varreduras, em tempo de caminhada
 * @property {boolean} throttled      cadenceS acima de ~20 s
 * @property {number|null} spreadDb   quanto o sinal dos roteadores mais fortes variou (dB); pouco = não saiu do lugar
 * @property {boolean} full           chegou ao limite de varreduras de um levantamento
 * @property {{id:number, label:string, floor:number, scans:number, target:number}|null} spot  ponto em andamento
 * @property {'insuficiente'|'minimo'|'bom'|'otimo'} level
 * @property {string} hint            o próximo passo mais útil, em uma frase
 */

export const SURVEY_THRESHOLDS = Object.freeze({
  minUseful: 25,
  minSpots: 12,
  goodUseful: 60,
  goodSpots: 20,
  greatUseful: 120,
  greatSpots: 32,
  /** lugares com nome para o nível 'otimo' (e para a dica "marque lugares com nome") */
  labelsWanted: 3,
  /** varreduras que valem por ponto marcado (e quantas a dica pede em cada ponto) */
  scansPerSpot: 3,
  /** intervalo entre varreduras (s de caminhada) acima do qual o celular está "limitado" */
  throttledCadenceS: 20,
  /** variação do sinal (dB) abaixo da qual a pessoa não saiu do lugar; só vale com `stillAfter` medições */
  stillSpreadDb: 7,
  stillAfter: 15,
});

export const RECORDER_LIMITS = Object.freeze({
  /** nível fora desta faixa é defeito do aparelho, não medição (dBm) */
  minLevel: -110,
  maxLevel: -1,
  /** leitura mais velha que isto (ms de caminhada) não diz nada sobre o lugar atual */
  maxReadingAgeMs: 20_000,
  /** lista lida menos de tanto tempo (s de caminhada) depois de "marcar ponto" ainda é da caminhada */
  spotSettleS: 1,
  /** salto no `t` das varreduras a cada retomada (s) */
  resumeGapS: 30,
  maxScans: 4000,
  maxReadingsPerScan: 400,
  maxTrack: 30_000,
  maxRtt: 20_000,
  maxKnownDistances: 50,
  maxLabel: 40,
  /** sinal da rede conectada: no máximo um por segundo; repetição do mesmo valor, um a cada 3 s */
  trackMinS: 0.9,
  trackRepeatS: 3,
  /** tolerância (ms) ao comparar "quando foi ouvido" entre duas listas */
  sameListMs: 25,
  /** relógio do evento longe demais do relógio do app: fica o do app */
  maxClockSkewMs: 5 * 60_000,
});

const SNAPSHOT_KIND = 'wrx-recorder';
const SNAPSHOT_VERSION = 1;
const STATES = ['idle', 'recording', 'paused', 'stopped'];
const LEVELS = ['insuficiente', 'minimo', 'bom', 'otimo'];
const BSSID_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
/** leituras com idade até isto (ms) são "desta varredura" (o mesmo corte do solucionador) */
const FRESH_READING_MS = 4500;

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round3 = (v) => Math.round(v * 1000) / 1000 + 0;
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Nome de um ponto como texto simples: sem caracteres de controle, sem espaços repetidos, curto. */
export function cleanLabel(value) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim(); // \s cobre também os separadores de linha Unicode
  const chars = Array.from(text); // por caractere, para não cortar um emoji no meio
  return chars.length > RECORDER_LIMITS.maxLabel ? chars.slice(0, RECORDER_LIMITS.maxLabel).join('').trim() : text;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------------------------------------------------------------------------
// Survey: limpeza e conferência (também usadas por storage.js ao ler e ao importar)
// ---------------------------------------------------------------------------

function cleanReading(r) {
  if (!isObj(r)) return null;
  const id = normalizeBssid(r.id);
  if (!id || !isNum(r.rssi) || !isNum(r.freq)) return null;
  if (r.rssi > RECORDER_LIMITS.maxLevel || r.rssi < RECORDER_LIMITS.minLevel || r.freq <= 0 || r.freq > 100_000) return null;
  const out = { id, rssi: Math.round(r.rssi), freq: Math.round(r.freq) };
  if (isNum(r.ageMs) && r.ageMs >= 0) out.ageMs = Math.round(Math.min(r.ageMs, 3_600_000));
  return out;
}

/**
 * Devolve uma cópia limpa de um Survey vindo de fora (arquivo importado, armazenamento), ou null
 * se não for um levantamento. Só passam os campos do tipo; textos são encurtados; números têm de
 * ser finitos; chaves que não são BSSID somem (inclusive "__proto__").
 * @param {unknown} input
 * @param {{maxScans?: number}} [options]
 * @returns {import('./types.js').Survey|null}
 */
export function sanitizeSurvey(input, options = {}) {
  if (!isObj(input) || !Array.isArray(input.scans)) return null;
  if (input.version !== undefined && input.version !== 1) return null;
  const maxScans = options.maxScans ?? RECORDER_LIMITS.maxScans;
  if (input.scans.length > maxScans) return null;

  const scans = [];
  let lastT = 0;
  for (const s of input.scans) {
    if (!isObj(s) || !isNum(s.t) || !Array.isArray(s.readings)) return null;
    const t = round3(Math.max(lastT, Math.min(Math.max(0, s.t), 1e7)));
    lastT = t;
    const seen = new Set();
    const readings = [];
    for (const r of s.readings.slice(0, RECORDER_LIMITS.maxReadingsPerScan)) {
      const c = cleanReading(r);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      readings.push(c);
    }
    // parado e ponto andam juntos: sem um não há o outro
    const spot = s.still === true && Number.isInteger(s.spot) && s.spot >= 0 && s.spot < 1e6 ? s.spot : null;
    const scan = { t, floor: isNum(s.floor) ? clampInt(s.floor, -20, 20) : 0, still: spot !== null, spot, readings };
    const label = spot !== null ? cleanLabel(s.label) : '';
    if (label) scan.label = label;
    scans.push(scan);
  }

  const aps = {};
  if (isObj(input.aps)) {
    for (const key of Object.keys(input.aps)) {
      const id = normalizeBssid(key);
      const a = input.aps[key];
      if (!id || !isObj(a)) continue;
      const entry = {
        ssid: typeof a.ssid === 'string' ? Array.from(a.ssid).slice(0, 64).join('') : '',
        freq: isNum(a.freq) && a.freq > 0 && a.freq < 100_000 ? Math.round(a.freq) : 0,
      };
      if (typeof a.device === 'string' && a.device && a.device.length <= 40) entry.device = a.device;
      aps[id] = entry;
    }
  }
  // todo BSSID com leitura tem de ter os seus dados
  for (const scan of scans) {
    for (const r of scan.readings) if (!aps[r.id]) aps[r.id] = { ssid: '', freq: r.freq };
  }

  const track = [];
  if (Array.isArray(input.track)) {
    for (const q of input.track.slice(0, RECORDER_LIMITS.maxTrack)) {
      const id = isObj(q) ? normalizeBssid(q.id) : '';
      if (!id || !isNum(q.t) || !isNum(q.rssi) || q.t < 0 || q.rssi > RECORDER_LIMITS.maxLevel || q.rssi < RECORDER_LIMITS.minLevel) continue;
      track.push({ t: round3(q.t), id, rssi: Math.round(q.rssi) });
    }
  }
  const rtt = [];
  if (Array.isArray(input.rtt)) {
    for (const q of input.rtt.slice(0, RECORDER_LIMITS.maxRtt)) {
      const id = isObj(q) ? normalizeBssid(q.id) : '';
      if (!id || !isNum(q.t) || !isNum(q.distM) || q.t < 0 || Math.abs(q.distM) > 1000) continue;
      rtt.push({ t: round3(q.t), id, distM: round3(q.distM), stdM: isNum(q.stdM) && q.stdM >= 0 ? round3(Math.min(q.stdM, 1000)) : 1 });
    }
  }
  const knownDistances = [];
  if (Array.isArray(input.knownDistances)) {
    for (const k of input.knownDistances.slice(0, RECORDER_LIMITS.maxKnownDistances)) {
      if (!isObj(k) || !Number.isInteger(k.a) || !Number.isInteger(k.b) || !isNum(k.meters)) continue;
      if (k.a < 0 || k.b < 0 || k.a >= scans.length || k.b >= scans.length || k.a === k.b || k.meters <= 0 || k.meters > 500) continue;
      knownDistances.push({ a: k.a, b: k.b, meters: round3(k.meters) });
    }
  }
  return { version: 1, scans, track, rtt, aps, knownDistances };
}

/**
 * Confere um Survey contra o tipo (types.js). Devolve a lista de problemas; vazia = válido.
 * @param {unknown} survey
 * @returns {string[]}
 */
export function validateSurvey(survey) {
  const problems = [];
  const bad = (text) => {
    if (problems.length < 20) problems.push(text);
  };
  if (!isObj(survey)) return ['não é um objeto'];
  if (survey.version !== 1) bad('version diferente de 1');
  if (!Array.isArray(survey.scans)) return [...problems, 'scans não é uma lista'];
  if (!isObj(survey.aps)) bad('aps não é um objeto');
  let lastT = -Infinity;
  survey.scans.forEach((s, i) => {
    if (!isObj(s)) return bad(`scans[${i}] não é um objeto`);
    if (!isNum(s.t) || s.t < 0) bad(`scans[${i}].t inválido`);
    else if (s.t < lastT) bad(`scans[${i}].t fora de ordem`);
    else lastT = s.t;
    if (!Number.isInteger(s.floor)) bad(`scans[${i}].floor não é inteiro`);
    if (typeof s.still !== 'boolean') bad(`scans[${i}].still não é booleano`);
    if (s.spot !== null && !(Number.isInteger(s.spot) && s.spot >= 0)) bad(`scans[${i}].spot inválido`);
    if (s.still && s.spot === null) bad(`scans[${i}] parado sem ponto`);
    if ('label' in s && (typeof s.label !== 'string' || !s.label)) bad(`scans[${i}].label inválido`);
    if (!Array.isArray(s.readings)) return bad(`scans[${i}].readings não é uma lista`);
    s.readings.forEach((r, k) => {
      if (!isObj(r) || !BSSID_RE.test(String(r.id))) return bad(`scans[${i}].readings[${k}].id inválido`);
      if (!isNum(r.rssi) || r.rssi >= 0 || r.rssi < RECORDER_LIMITS.minLevel) bad(`scans[${i}].readings[${k}].rssi inválido`);
      if (!isNum(r.freq) || r.freq <= 0) bad(`scans[${i}].readings[${k}].freq inválido`);
      if ('ageMs' in r && (!isNum(r.ageMs) || r.ageMs < 0)) bad(`scans[${i}].readings[${k}].ageMs inválido`);
      if (isObj(survey.aps) && !isObj(survey.aps[r.id])) bad(`falta aps["${r.id}"]`);
    });
  });
  if (isObj(survey.aps)) {
    for (const [id, a] of Object.entries(survey.aps)) {
      if (!BSSID_RE.test(id)) bad(`aps: chave "${String(id).slice(0, 20)}" não é BSSID`);
      else if (!isObj(a) || typeof a.ssid !== 'string' || !isNum(a.freq)) bad(`aps["${id}"] incompleto`);
      else if ('device' in a && (typeof a.device !== 'string' || !a.device)) bad(`aps["${id}"].device inválido`);
    }
  }
  for (const [name, check] of [
    ['track', (q) => isObj(q) && isNum(q.t) && BSSID_RE.test(String(q.id)) && isNum(q.rssi)],
    ['rtt', (q) => isObj(q) && isNum(q.t) && BSSID_RE.test(String(q.id)) && isNum(q.distM) && isNum(q.stdM)],
    ['knownDistances', (k) => isObj(k) && Number.isInteger(k.a) && Number.isInteger(k.b) && k.a !== k.b && k.a >= 0 && k.b >= 0 && k.a < survey.scans.length && k.b < survey.scans.length && isNum(k.meters) && k.meters > 0],
  ]) {
    if (!(name in survey)) continue;
    if (!Array.isArray(survey[name])) bad(`${name} não é uma lista`);
    else survey[name].forEach((q, i) => !check(q) && bad(`${name}[${i}] inválido`));
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Gravador
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {() => number} [options.now]       relógio do app, em ms (o mesmo do ScanEvent.ts)
 * @param {number} [options.timeScale]       segundos de caminhada por segundo de relógio (sim.speed na demonstração)
 */
export function createRecorder({ now = Date.now, timeScale = 1 } = {}) {
  const L = RECORDER_LIMITS;
  const T = SURVEY_THRESHOLDS;

  let state = 'idle';
  let scale = isNum(timeScale) && timeScale > 0 ? timeScale : 1;

  // relógio de caminhada
  let walkMs = 0; // tempo de caminhada acumulado (pausas fora, escala aplicada)
  let gapMs = 0; // saltos somados ao `t` a cada retomada
  let lastReal = null; // relógio do app na última atualização (só enquanto grava)
  let segment = 0; // trecho de gravação (muda a cada retomada)

  /** @type {import('./types.js').SurveyScan[]} */
  let scans = [];
  let scanInfo = []; // em paralelo: { at: relógio do app na chegada, seg: trecho }
  let track = [];
  let rtt = [];
  let known = [];
  let meta = new Map(); // bssid -> { ssid, freq }
  // agrupamento por aparelho, por votação entre as varreduras
  let seenIn = new Map(); // bssid -> em quantos agrupamentos apareceu
  let together = new Map(); // "a|b" (a < b) -> em quantos estavam no mesmo aparelho

  let floor = 0;
  let spots = new Map(); // id -> { id, label, floor, beganT }
  let currentSpot = null; // id
  let nextSpot = 0;

  // para não gravar a mesma lista duas vezes
  let lastNewest = null; // "ouvido em" (relógio do celular) da leitura mais nova da última lista gravada
  let lastSignature = '';
  let lastTrack = null; // { t, id, rssi }

  let version = 0; // muda a cada alteração: invalida os cálculos guardados
  let cache = { version: -1 };
  const listeners = new Set();

  function emit(type) {
    version += 1;
    for (const fn of [...listeners]) {
      try {
        fn({ type });
      } catch (err) {
        console.error('[recorder] erro num ouvinte', err);
      }
    }
  }

  /** Traz o relógio de caminhada até agora. */
  function tick() {
    const real = now();
    if (state === 'recording' && lastReal !== null && real > lastReal) walkMs += (real - lastReal) * scale;
    lastReal = real;
    return real;
  }

  /** Segundos de caminhada (com os saltos das retomadas) no instante `at` do relógio do celular. */
  function surveyTime(at) {
    const real = tick();
    const ts = isNum(at) && Math.abs(at - real) <= L.maxClockSkewMs ? at : real;
    const back = Math.max(0, real - ts) * scale;
    return { t: Math.max(0, (walkMs - back + gapMs) / 1000), ts, real };
  }

  // --- estado -------------------------------------------------------------------------------

  function start() {
    if (state !== 'idle') return false;
    state = 'recording';
    lastReal = now();
    emit('state');
    return true;
  }

  function pause() {
    if (state !== 'recording') return false;
    tick();
    currentSpot = null; // ao voltar o usuário pode estar em outro lugar
    state = 'paused';
    emit('state');
    return true;
  }

  function resume() {
    if (state !== 'paused' && state !== 'stopped') return false;
    state = 'recording';
    lastReal = now();
    segment += 1;
    if (scans.length || track.length) gapMs += L.resumeGapS * 1000;
    emit('state');
    return true;
  }

  function stop() {
    if (state === 'stopped' || state === 'idle') return false;
    tick();
    currentSpot = null;
    state = 'stopped';
    emit('state');
    return true;
  }

  function reset() {
    state = 'idle';
    walkMs = 0;
    gapMs = 0;
    lastReal = null;
    segment = 0;
    scans = [];
    scanInfo = [];
    track = [];
    rtt = [];
    known = [];
    meta = new Map();
    seenIn = new Map();
    together = new Map();
    floor = 0;
    spots = new Map();
    currentSpot = null;
    nextSpot = 0;
    lastNewest = null;
    lastSignature = '';
    lastTrack = null;
    emit('state');
  }

  function setTimeScale(k) {
    if (!isNum(k) || k <= 0) return scale;
    tick(); // o que já passou fica na escala antiga
    scale = k;
    return scale;
  }

  // --- varreduras ---------------------------------------------------------------------------

  function noteDevices(list) {
    let groups;
    try {
      groups = groupByDevice(list);
    } catch {
      return; // o agrupamento é um extra: sem ele cada BSSID é um aparelho
    }
    for (const g of groups) {
      const ids = (Array.isArray(g.bssids) ? g.bssids : []).filter((id) => BSSID_RE.test(id)).sort();
      for (const id of ids) seenIn.set(id, (seenIn.get(id) || 0) + 1);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = `${ids[i]}|${ids[j]}`;
          together.set(key, (together.get(key) || 0) + 1);
        }
      }
    }
  }

  /**
   * @param {import('../bridge.js').ScanEvent} ev
   * @param {{aps?: object[]}} [context]  lista normalizada do store (para nome, frequência e aparelho)
   * @returns {boolean} true quando a varredura foi gravada
   */
  function onScan(ev, context) {
    if (state !== 'recording') return false;
    if (!isObj(ev) || ev.fresh !== true || !Array.isArray(ev.aps)) return false;
    if (scans.length >= L.maxScans) return false;
    const when = surveyTime(ev.ts);

    const byId = new Map();
    let newest = null;
    for (const raw of ev.aps) {
      if (!isObj(raw)) continue;
      const id = normalizeBssid(raw.bssid);
      if (!id || !isNum(raw.level) || !isNum(raw.frequency)) continue;
      if (raw.level > L.maxLevel || raw.level < L.minLevel || raw.frequency <= 0) continue;
      const hasAge = isNum(raw.ageMs) && raw.ageMs >= 0;
      if (hasAge) {
        const heardAt = when.ts - raw.ageMs;
        if (newest === null || heardAt > newest) newest = heardAt;
      }
      const ageMs = hasAge ? Math.round(raw.ageMs * scale) : null;
      if (ageMs !== null && ageMs > L.maxReadingAgeMs) continue;
      const prev = byId.get(id);
      if (prev && (prev.ageMs ?? Infinity) <= (ageMs ?? Infinity)) continue;
      const reading = { id, rssi: Math.round(raw.level), freq: Math.round(raw.frequency) };
      if (ageMs !== null) reading.ageMs = ageMs;
      reading.ssid = typeof raw.ssid === 'string' ? raw.ssid : '';
      byId.set(id, reading);
    }
    if (byId.size === 0) return false;

    // do mais forte para o mais fraco (a ordem não diz nada sobre o lugar)
    const list = [...byId.values()].sort((a, b) => b.rssi - a.rssi || (a.id < b.id ? -1 : 1)).slice(0, L.maxReadingsPerScan);
    const signature = list.map((r) => `${r.id}${r.rssi}`).join(',');
    // A mesma lista de novo? Uma varredura nova sempre traz alguma leitura ouvida depois da
    // lista anterior. (Sem idades, só dá para comparar o conteúdo.)
    if (newest !== null && lastNewest !== null) {
      if (newest <= lastNewest + L.sameListMs) return false;
    } else if (signature === lastSignature) {
      return false;
    }
    lastNewest = newest;
    lastSignature = signature;

    const last = scans[scans.length - 1];
    const t = round3(Math.max(when.t, last ? last.t : 0));
    const spot = currentSpot !== null ? spots.get(currentSpot) : null;
    const settled = spot && t - spot.beganT >= L.spotSettleS;
    const scan = { t, floor, still: !!settled, spot: settled ? spot.id : null, readings: [] };
    if (settled && spot.label) scan.label = spot.label;

    // dados de cada rede: os do store quando vieram, senão os do próprio evento
    const fromStore = new Map();
    const normalised = context && Array.isArray(context.aps) ? context.aps : null;
    if (normalised) for (const ap of normalised) if (isObj(ap) && typeof ap.bssid === 'string') fromStore.set(ap.bssid, ap);
    for (const r of list) {
      const ap = fromStore.get(r.id);
      const ssid = ap && typeof ap.ssid === 'string' ? ap.ssid : r.ssid;
      const prev = meta.get(r.id);
      // rede oculta que depois mostra o nome: fica o nome
      meta.set(r.id, { ssid: ssid || (prev ? prev.ssid : ''), freq: r.freq });
      delete r.ssid;
      scan.readings.push(r);
    }
    noteDevices(normalised && normalised.length ? normalised : ev.aps);

    scans.push(scan);
    scanInfo.push({ at: when.real, seg: segment });
    emit('scan');
    return true;
  }

  /** @param {import('../bridge.js').RssiSample} sample */
  function onRssi(sample) {
    if (state !== 'recording' || !isObj(sample)) return false;
    const id = normalizeBssid(sample.bssid);
    if (!id || !isNum(sample.rssi) || sample.rssi > L.maxLevel || sample.rssi < L.minLevel) return false;
    if (track.length >= L.maxTrack) return false;
    const { t } = surveyTime(sample.ts);
    const rssi = Math.round(sample.rssi);
    if (lastTrack) {
      const dt = t - lastTrack.t;
      if (dt < L.trackMinS) return false;
      // o Android repete o mesmo valor por alguns segundos: uma repetição a cada 3 s basta
      if (lastTrack.id === id && lastTrack.rssi === rssi && dt < L.trackRepeatS) return false;
    }
    lastTrack = { t: round3(t), id, rssi };
    track.push(lastTrack);
    if (!meta.has(id) && isNum(sample.frequency) && sample.frequency > 0) meta.set(id, { ssid: '', freq: Math.round(sample.frequency) });
    return true;
  }

  /** @param {import('../bridge.js').RttResult[]|{results: import('../bridge.js').RttResult[]}} results */
  function onRtt(results) {
    if (state !== 'recording') return 0;
    const list = Array.isArray(results) ? results : isObj(results) && Array.isArray(results.results) ? results.results : [];
    const { t } = surveyTime(null);
    let added = 0;
    for (const r of list) {
      if (!isObj(r) || r.ok !== true || !isNum(r.distM) || rtt.length >= L.maxRtt) continue;
      const id = normalizeBssid(r.bssid);
      if (!id || Math.abs(r.distM) > 1000) continue;
      rtt.push({ t: round3(t), id, distM: round3(r.distM), stdM: isNum(r.stdM) && r.stdM >= 0 ? round3(r.stdM) : 1 });
      added += 1;
    }
    return added;
  }

  function undoLastScan() {
    if (!scans.length) return null;
    const removed = scans.pop();
    scanInfo.pop();
    known = known.filter((k) => k.a < scans.length && k.b < scans.length);
    emit('undo');
    return removed;
  }

  // --- andar e pontos -----------------------------------------------------------------------

  function setFloor(n) {
    if (!isNum(n)) return floor;
    const next = clampInt(n, -20, 20);
    if (next === floor) return floor;
    floor = next;
    currentSpot = null; // um ponto fica num andar só
    emit('floor');
    return floor;
  }

  const spotScans = (id) => scans.reduce((n, s) => n + (s.spot === id ? 1 : 0), 0);

  function spotView(spot) {
    return { id: spot.id, label: spot.label, floor: spot.floor, scans: spotScans(spot.id) };
  }

  function beginSpot(label) {
    if (state !== 'recording') return null;
    const { t } = surveyTime(null);
    const spot = { id: nextSpot++, label: cleanLabel(label), floor, beganT: t };
    spots.set(spot.id, spot);
    currentSpot = spot.id;
    emit('spot');
    return spot.id;
  }

  function resumeSpot(id) {
    const spot = spots.get(id);
    if (state !== 'recording' || !spot) return false;
    spot.beganT = surveyTime(null).t;
    if (spot.floor !== floor) floor = spot.floor;
    currentSpot = spot.id;
    emit('spot');
    return true;
  }

  function endSpot() {
    if (currentSpot === null) return false;
    const spot = spots.get(currentSpot);
    currentSpot = null;
    if (spot && spotScans(spot.id) === 0) spots.delete(spot.id); // ponto sem varredura não existe
    emit('spot');
    return true;
  }

  function renameSpot(id, label) {
    const spot = spots.get(id);
    if (!spot) return false;
    spot.label = cleanLabel(label);
    for (const s of scans) {
      if (s.spot !== id) continue;
      if (spot.label) s.label = spot.label;
      else delete s.label;
    }
    emit('spot');
    return true;
  }

  function removeSpot(id) {
    const spot = spots.get(id);
    if (!spot) return false;
    for (const s of scans) {
      if (s.spot !== id) continue;
      s.still = false;
      s.spot = null;
      delete s.label;
    }
    spots.delete(id);
    if (currentSpot === id) currentSpot = null;
    emit('spot');
    return true;
  }

  // --- calibração ---------------------------------------------------------------------------

  function addKnownDistance(a, b, meters) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || a < 0 || b < 0 || a >= scans.length || b >= scans.length) return false;
    if (!isNum(meters) || meters <= 0 || meters > 500 || known.length >= L.maxKnownDistances) return false;
    known.push({ a, b, meters: round3(meters) });
    emit('calibration');
    return true;
  }

  function clearKnownDistances() {
    if (!known.length) return;
    known = [];
    emit('calibration');
  }

  // --- derivados ----------------------------------------------------------------------------

  /** BSSID -> id do aparelho ("d1", "d2"... na ordem em que apareceram). Guardado até a próxima mudança. */
  function deviceMap() {
    if (cache.version === version && cache.devices) return cache.devices;
    const ids = [...meta.keys()];
    const parent = new Map(ids.map((id) => [id, id]));
    const find = (x) => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r);
      parent.set(x, r);
      return r;
    };
    for (const [key, n] of together) {
      const [a, b] = key.split('|');
      if (!parent.has(a) || !parent.has(b)) continue;
      // juntos na maioria das vezes em que o menos visto dos dois apareceu
      const base = Math.min(seenIn.get(a) || 0, seenIn.get(b) || 0);
      if (n * 2 < base) continue;
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    }
    const names = new Map();
    const out = new Map();
    for (const id of ids) {
      const root = find(id);
      if (!names.has(root)) names.set(root, `d${names.size + 1}`);
      out.set(id, names.get(root));
    }
    if (cache.version !== version) cache = { version };
    cache.devices = out;
    cache.deviceCount = names.size;
    return out;
  }

  /** Quanto o sinal dos rádios mais fortes variou ao longo do levantamento (dB), ou null. */
  function spread() {
    if (cache.version === version && 'spread' in cache) return cache.spread;
    const perAp = new Map();
    for (const s of scans) {
      for (const r of s.readings) {
        if (r.ageMs !== undefined && r.ageMs > FRESH_READING_MS) continue;
        let list = perAp.get(r.id);
        if (!list) perAp.set(r.id, (list = []));
        list.push(r.rssi);
      }
    }
    const need = Math.max(5, Math.ceil(scans.length * 0.3));
    const rows = [];
    for (const list of perAp.values()) {
      if (list.length < need) continue;
      list.sort((a, b) => a - b);
      rows.push({ mid: quantile(list, 0.5), range: quantile(list, 0.9) - quantile(list, 0.1) });
    }
    rows.sort((a, b) => b.mid - a.mid);
    const value = rows.length ? median(rows.slice(0, 6).map((r) => r.range)) : null;
    if (cache.version !== version) cache = { version };
    cache.spread = value;
    return value;
  }

  function cadence() {
    const gaps = [];
    for (let i = scans.length - 1; i > 0 && gaps.length < 8; i--) {
      if (scanInfo[i].seg !== scanInfo[i - 1].seg) continue; // uma pausa no meio não é ritmo
      gaps.push(scans[i].t - scans[i - 1].t);
    }
    return gaps.length ? Math.round(median(gaps) * 10) / 10 : null;
  }

  function hintFor(s) {
    if (s.state === 'idle') return 'Toque em começar e ande devagar pela casa, com o celular na mão.';
    if (s.state === 'stopped') return s.level === 'insuficiente' ? 'Poucas medições: o mapa vai sair bem aproximado.' : 'Levantamento encerrado.';
    if (s.state === 'paused') return 'Em pausa. Toque em continuar quando voltar a andar.';
    if (s.full) return 'Este levantamento chegou ao tamanho máximo. Finalize para ver o mapa.';
    if (s.scans === 0) return 'Aguardando a primeira varredura do Wi-Fi…';
    if (s.spot) {
      if (s.spot.scans < s.spot.target) return `Fique parado: ${s.spot.scans} de ${s.spot.target} varreduras neste ponto.`;
      return 'Ponto marcado. Pode seguir para o próximo lugar.';
    }
    if (s.useful >= T.stillAfter && s.spreadDb !== null && s.spreadDb < T.stillSpreadDb) {
      return 'O sinal quase não mudou: ande pelos cômodos para o mapa ganhar forma.';
    }
    if (s.throttled && s.level !== 'bom' && s.level !== 'otimo') {
      const missing = Math.max(1, (s.level === 'insuficiente' ? T.minSpots : T.goodSpots) - s.spots);
      return `O celular está limitando as buscas: pare em cada lugar e marque um ponto (faltam ${missing}).`;
    }
    if (s.level === 'insuficiente') {
      const missing = Math.max(1, T.minUseful - s.useful);
      return `Continue andando: ${missing === 1 ? 'falta 1 varredura' : `faltam ${missing} varreduras`} para um mapa mínimo.`;
    }
    if (s.labels.length < T.labelsWanted) return `Marque pelo menos ${T.labelsWanted} lugares com nome: pare, toque em marcar ponto e diga onde está.`;
    if (s.level === 'minimo') return 'Continue andando: faltam cômodos e cantos para um mapa bom.';
    if (s.level === 'bom') {
      return s.floors.length < 2 ? 'Já dá um bom mapa. Passe pelos cantos que faltam; se houver outro andar, suba ou desça e marque o andar.' : 'Já dá um bom mapa. Mais uma volta pelos cantos deixa melhor.';
    }
    return 'Levantamento ótimo. Pode finalizar quando quiser.';
  }

  /** @returns {RecorderStats} */
  function stats() {
    const real = tick();
    const perSpot = new Map();
    const labels = [];
    const floors = new Set();
    let stillScans = 0;
    for (const s of scans) {
      floors.add(s.floor);
      if (s.spot !== null) {
        perSpot.set(s.spot, (perSpot.get(s.spot) || 0) + 1);
        if (s.still) stillScans += 1;
        if (s.label && !labels.includes(s.label)) labels.push(s.label);
      }
    }
    const walkScans = scans.length - stillScans;
    let useful = walkScans;
    for (const n of perSpot.values()) useful += Math.min(n, T.scansPerSpot);
    const spotCount = perSpot.size;
    const devices = deviceMap();
    const heard = new Set();
    const heardDevices = new Set();
    for (const s of scans) {
      for (const r of s.readings) {
        heard.add(r.id);
        heardDevices.add(devices.get(r.id) || r.id);
      }
    }
    const cadenceS = cadence();
    const throttled = cadenceS !== null && cadenceS > T.throttledCadenceS;
    const spreadDb = spread();

    let level = 0;
    if (useful >= T.minUseful || spotCount >= T.minSpots) level = 1;
    if (useful >= T.goodUseful || spotCount >= T.goodSpots) level = 2;
    if ((useful >= T.greatUseful || spotCount >= T.greatSpots) && labels.length >= T.labelsWanted) level = 3;
    if (useful >= T.stillAfter && spreadDb !== null && spreadDb < T.stillSpreadDb) level = 0;

    const active = currentSpot !== null ? spots.get(currentSpot) : null;
    const out = {
      state,
      scans: scans.length,
      stillScans,
      walkScans,
      useful,
      spots: spotCount,
      labels,
      aps: heard.size,
      devices: heardDevices.size,
      floors: [...floors].sort((a, b) => a - b),
      floor,
      durationS: Math.round(walkMs / 100) / 10,
      lastScanAgoS: scans.length ? Math.max(0, Math.round((real - scanInfo[scans.length - 1].at) / 100) / 10) : null,
      cadenceS,
      throttled,
      spreadDb: spreadDb === null ? null : Math.round(spreadDb * 10) / 10,
      full: scans.length >= L.maxScans,
      // com o celular limitado (uma varredura a cada 30 s) uma por ponto já está bom
      spot: active ? { ...spotView(active), target: throttled ? 1 : T.scansPerSpot } : null,
      level: LEVELS[level],
      hint: '',
    };
    out.hint = hintFor(out);
    return out;
  }

  /** @returns {import('./types.js').Survey} */
  function toSurvey() {
    const devices = deviceMap();
    const aps = {};
    const add = (id) => {
      if (aps[id]) return;
      const m = meta.get(id);
      aps[id] = { ssid: m ? m.ssid : '', freq: m ? m.freq : 0, device: devices.get(id) || id };
    };
    const outScans = scans.map((s) => {
      const copy = { t: s.t, floor: s.floor, still: s.still, spot: s.spot, readings: s.readings.map((r) => ({ ...r })) };
      if (s.label) copy.label = s.label;
      for (const r of s.readings) add(r.id);
      return copy;
    });
    for (const q of track) if (meta.has(q.id)) add(q.id);
    return {
      version: 1,
      scans: outScans,
      // o sinal conectado só serve com os dados da rede (frequência): sem eles a amostra sai
      track: track.filter((q) => aps[q.id]).map((q) => ({ ...q })),
      rtt: rtt.map((q) => ({ ...q })),
      aps,
      knownDistances: known.map((k) => ({ ...k })),
    };
  }

  function toJSON() {
    tick();
    return {
      kind: SNAPSHOT_KIND,
      v: SNAPSHOT_VERSION,
      savedAt: now(),
      state,
      timeScale: scale,
      walkMs: Math.round(walkMs),
      gapMs: Math.round(gapMs),
      segment,
      floor,
      nextSpot,
      currentSpot,
      spots: [...spots.values()].map((s) => ({ ...s })),
      segs: scanInfo.map((i) => i.seg),
      survey: toSurvey(),
      // dados de rádios que só apareceram no sinal conectado e os votos do agrupamento por aparelho
      meta: Object.fromEntries(meta),
      votes: { seen: Object.fromEntries(seenIn), together: Object.fromEntries(together) },
    };
  }

  /** Carrega um retrato já conferido (uso de recorderFromJSON). */
  function restore(snap) {
    reset();
    const survey = snap.survey;
    scans = survey.scans;
    scanInfo = scans.map((_, i) => ({ at: now(), seg: Array.isArray(snap.segs) && Number.isInteger(snap.segs[i]) ? snap.segs[i] : 0 }));
    track = survey.track || [];
    rtt = survey.rtt || [];
    known = survey.knownDistances || [];
    lastTrack = track.length ? track[track.length - 1] : null;
    for (const [id, a] of Object.entries(survey.aps)) meta.set(id, { ssid: a.ssid, freq: a.freq });
    if (isObj(snap.meta)) {
      for (const [key, a] of Object.entries(snap.meta)) {
        const id = normalizeBssid(key);
        if (id && !meta.has(id) && isObj(a) && isNum(a.freq)) meta.set(id, { ssid: typeof a.ssid === 'string' ? a.ssid.slice(0, 64) : '', freq: Math.round(a.freq) });
      }
    }
    const votes = isObj(snap.votes) ? snap.votes : null;
    let voted = false;
    if (votes && isObj(votes.seen) && isObj(votes.together)) {
      for (const [key, n] of Object.entries(votes.seen)) if (BSSID_RE.test(key) && Number.isInteger(n) && n > 0) seenIn.set(key, n);
      for (const [key, n] of Object.entries(votes.together)) {
        const [a, b] = key.split('|');
        if (BSSID_RE.test(a || '') && BSSID_RE.test(b || '') && a < b && Number.isInteger(n) && n > 0) {
          together.set(key, n);
          voted = true;
        }
      }
    }
    if (!voted) {
      // veio só o Survey: os aparelhos são os que ele traz
      const groups = new Map();
      for (const [id, a] of Object.entries(survey.aps)) {
        seenIn.set(id, 1);
        if (!a.device) continue;
        if (!groups.has(a.device)) groups.set(a.device, []);
        groups.get(a.device).push(id);
      }
      for (const ids of groups.values()) {
        ids.sort();
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) together.set(`${ids[i]}|${ids[j]}`, 1);
      }
    }

    // pontos: os do retrato, completados pelo que as varreduras dizem
    if (Array.isArray(snap.spots)) {
      for (const s of snap.spots) {
        if (!isObj(s) || !Number.isInteger(s.id) || s.id < 0 || s.id >= 1e6) continue;
        spots.set(s.id, { id: s.id, label: cleanLabel(s.label), floor: isNum(s.floor) ? clampInt(s.floor, -20, 20) : 0, beganT: isNum(s.beganT) ? s.beganT : 0 });
      }
    }
    let maxSpot = -1;
    for (const s of scans) {
      if (s.spot === null) continue;
      maxSpot = Math.max(maxSpot, s.spot);
      const spot = spots.get(s.spot);
      if (!spot) spots.set(s.spot, { id: s.spot, label: s.label || '', floor: s.floor, beganT: s.t });
      else if (s.label) spot.label = s.label;
    }
    for (const id of [...spots.keys()]) if (!scans.some((s) => s.spot === id)) spots.delete(id);
    nextSpot = Math.max(maxSpot + 1, Number.isInteger(snap.nextSpot) && snap.nextSpot >= 0 && snap.nextSpot < 1e6 ? snap.nextSpot : 0);

    const lastScan = scans[scans.length - 1];
    const lastT = Math.max(lastScan ? lastScan.t : 0, lastTrack ? lastTrack.t : 0) * 1000;
    gapMs = isNum(snap.gapMs) && snap.gapMs >= 0 ? Math.min(snap.gapMs, 1e9) : 0;
    walkMs = isNum(snap.walkMs) && snap.walkMs >= 0 ? Math.min(snap.walkMs, 1e10) : Math.max(0, lastT - gapMs);
    // o `t` da próxima varredura nunca pode ficar antes da última gravada
    if (walkMs + gapMs < lastT) walkMs = lastT - gapMs;
    segment = Number.isInteger(snap.segment) && snap.segment >= 0 ? snap.segment : 0;
    floor = isNum(snap.floor) ? clampInt(snap.floor, -20, 20) : lastScan ? lastScan.floor : 0;
    const wanted = STATES.includes(snap.state) ? snap.state : 'paused';
    // quem estava gravando quando o app fechou volta em pausa: o tempo parado não é caminhada
    state = wanted === 'recording' ? 'paused' : wanted === 'idle' && scans.length ? 'paused' : wanted;
    currentSpot = null;
    emit('state');
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    get state() {
      return state;
    },
    get floor() {
      return floor;
    },
    get timeScale() {
      return scale;
    },
    get currentSpot() {
      const spot = currentSpot !== null ? spots.get(currentSpot) : null;
      if (!spot) return null;
      const cadenceS = cadence();
      return { ...spotView(spot), target: cadenceS !== null && cadenceS > T.throttledCadenceS ? 1 : T.scansPerSpot };
    },
    start,
    pause,
    resume,
    stop,
    reset,
    setTimeScale,
    onScan,
    onRssi,
    onRtt,
    setFloor,
    beginSpot,
    resumeSpot,
    endSpot,
    renameSpot,
    removeSpot,
    spots: () => [...spots.values()].map(spotView).filter((s) => s.scans > 0 || s.id === currentSpot),
    undoLastScan,
    addKnownDistance,
    clearKnownDistances,
    stats,
    toSurvey,
    toJSON,
    subscribe,
    _restore: restore,
  };
}

/**
 * Refaz um gravador a partir do que toJSON() devolveu (objeto ou texto) ou de um Survey salvo
 * ("continuar este mapa"). Nunca lança: conteúdo que não presta devolve null.
 * @param {unknown} json
 * @param {{now?: () => number, timeScale?: number}} [options]
 * @returns {ReturnType<typeof createRecorder>|null}
 */
export function recorderFromJSON(json, options = {}) {
  let data = json;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!isObj(data)) return null;
  let snap;
  if (data.kind === SNAPSHOT_KIND) {
    if (data.v !== SNAPSHOT_VERSION) return null;
    snap = data;
  } else if (Array.isArray(data.scans)) {
    snap = { survey: data, state: 'paused' };
  } else {
    return null;
  }
  const survey = sanitizeSurvey(snap.survey);
  if (!survey) return null;
  try {
    const rec = createRecorder({ now: options.now, timeScale: options.timeScale ?? (isNum(snap.timeScale) ? snap.timeScale : 1) });
    rec._restore({ ...snap, survey });
    return rec;
  } catch {
    return null;
  }
}
