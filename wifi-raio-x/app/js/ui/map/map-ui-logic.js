// Lógica pura das telas do Mapa 3D (biblioteca, levantamento e resultado).
// Nada aqui toca no DOM: entra estado simples, saem textos e objetos simples (roda em node:test).
//
// Nomes e andares
//   ROOM_PRESETS · cleanLabel(texto) · sameLabel(a, b) · roomChips(usados) · wherePhrase(nome)
//   floorName(n) · floorShort(n) · clampFloor(n)
// Levantamento
//   levelInfo(nível) · fmtTimer(segundos) · pulseInfo({...}) · previewDue({...})
//   candidateNetworks({networks, favorites, connection}) · ownBssidsFor(survey, ssids, extras)
//   rttTargets(aps, limite)
// Resultado
//   qualityInfo(quality) · coverageParts(cov) · deadZoneLines(cov, opções) · placeText(lugar, váriosAndares)
//   heatChoices(model) · roomSignal(model, andar, ambiente, campo) · signalWordAt(dbm)
//   spotDistance(model, a, b) · parseMeters(texto) · withKnownDistance(survey, a, b, metros)
//   renameRoom(survey, model, andar, idDoAmbiente, nome) · spotOptions(model)
// Biblioteca e arquivos
//   mapMeta(model, survey) · metaLine(meta) · defaultMapName(quando, usados) · fileSlug(nome)
//   makeRecord({...}) · readRecord(bruto)
//
// Honestidade: o mapa é uma estimativa. Os textos daqui dizem "≈", "cerca de" e "estimado"
// sempre que o número vem do mapa, e nunca chamam o resultado de planta.

import { fmtNum, fmtDbm, fmtMeters, THIN } from '../dom.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Nomes de cômodos
// ---------------------------------------------------------------------------

/** Atalhos oferecidos em "Marcar este lugar". */
export const ROOM_PRESETS = Object.freeze(['Sala', 'Cozinha', 'Quarto', 'Banheiro', 'Corredor', 'Varanda', 'Escritório', 'Garagem']);

/** Tamanho máximo de um nome de lugar. */
export const LABEL_MAX = 40;

/**
 * Nome digitado -> nome guardado: sem caracteres de controle, espaços em excesso nem tamanho
 * exagerado. O texto continua sendo texto (um "<img ...>" fica como está): quem mostra é que
 * nunca o trata como HTML.
 */
export function cleanLabel(text, max = LABEL_MAX) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  // corta por caractere inteiro (um emoji não fica pela metade)
  return Array.from(flat).slice(0, max).join('').trim();
}

const fold = (text) =>
  cleanLabel(String(text ?? ''), 200)
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/** Dois nomes são o mesmo lugar? (sem diferenciar maiúsculas, acentos e espaços nas pontas) */
export function sameLabel(a, b) {
  const fa = fold(a);
  return fa !== '' && fa === fold(b);
}

/**
 * Chips do painel "Marcar este lugar": os atalhos, os nomes já usados neste mapa e, para um
 * atalho já usado, o próximo número ("Quarto" marcado -> oferece "Quarto 2").
 * @param {string[]} used  nomes já dados neste levantamento
 * @returns {{label:string, used:boolean}[]}
 */
export function roomChips(used = []) {
  const taken = [];
  for (const u of used) {
    const name = cleanLabel(u);
    if (name && !taken.some((t) => sameLabel(t, name))) taken.push(name);
  }
  const isTaken = (name) => taken.some((t) => sameLabel(t, name));
  const out = [];
  const push = (label, usedFlag) => {
    if (!out.some((o) => sameLabel(o.label, label))) out.push({ label, used: usedFlag });
  };
  for (const preset of ROOM_PRESETS) {
    push(preset, isTaken(preset));
    if (isTaken(preset)) {
      let n = 2;
      while (isTaken(`${preset} ${n}`) && n < 20) {
        push(`${preset} ${n}`, true);
        n += 1;
      }
      push(`${preset} ${n}`, false);
    }
  }
  for (const name of taken) push(name, true);
  return out;
}

const FEMININE = ['sala', 'cozinha', 'varanda', 'garagem', 'suite', 'lavanderia', 'area', 'copa', 'despensa', 'sacada', 'entrada', 'escada', 'recepcao', 'biblioteca', 'oficina', 'churrasqueira', 'edicula', 'loja', 'piscina'];
const MASCULINE = ['quarto', 'banheiro', 'corredor', 'escritorio', 'hall', 'closet', 'quintal', 'porao', 'sotao', 'lavabo', 'ambiente', 'deposito', 'terraco', 'jardim', 'atelie', 'estudio', 'salao', 'refeitorio', 'almoxarifado', 'estoque', 'auditorio', 'laboratorio', 'home'];

/**
 * "no Quarto 2", "na Cozinha"; para um nome que o app não conhece, sem arriscar o gênero:
 * em “Cantinho do Rex”.
 */
export function wherePhrase(label) {
  const name = cleanLabel(String(label ?? ''));
  if (!name) return 'num lugar sem nome';
  const first = fold(name).split(/[^a-z0-9]+/)[0] || '';
  if (FEMININE.includes(first)) return `na ${name}`;
  if (MASCULINE.includes(first)) return `no ${name}`;
  return `em “${name}”`;
}

// ---------------------------------------------------------------------------
// Andares
// ---------------------------------------------------------------------------

export const FLOOR_MIN = -3;
export const FLOOR_MAX = 9;

export function clampFloor(n) {
  return isNum(n) ? clamp(Math.round(n), FLOOR_MIN, FLOOR_MAX) : 0;
}

/** 0 -> "Térreo", 1 -> "1º andar", -1 -> "Subsolo", -2 -> "2º subsolo". */
export function floorName(n) {
  const f = isNum(n) ? Math.round(n) : 0;
  if (f === 0) return 'Térreo';
  if (f > 0) return `${f}º andar`;
  return f === -1 ? 'Subsolo' : `${-f}º subsolo`;
}

/** Versão curta para chips: "Térreo", "1º", "Subsolo", "2º sub.". */
export function floorShort(n) {
  const f = isNum(n) ? Math.round(n) : 0;
  if (f === 0) return 'Térreo';
  if (f > 0) return `${f}º`;
  return f === -1 ? 'Subsolo' : `${-f}º sub.`;
}

// ---------------------------------------------------------------------------
// Levantamento
// ---------------------------------------------------------------------------

const LEVELS = ['insuficiente', 'minimo', 'bom', 'otimo'];

/**
 * Nível do levantamento (stats().level do gravador) -> o que a barra de progresso mostra.
 * @returns {{index:number, steps:number, pct:number, label:string, tone:'warning'|'info'|'good', canFinish:boolean}}
 */
export function levelInfo(level) {
  const index = Math.max(0, LEVELS.indexOf(level));
  const look = [
    { label: 'Ainda é pouco para um mapa', tone: 'warning' },
    { label: 'Já dá um mapa simples', tone: 'info' },
    { label: 'Dá um bom mapa', tone: 'good' },
    { label: 'Dá um ótimo mapa', tone: 'good' },
  ][index];
  return { index, steps: 3, pct: Math.round((index / 3) * 100), label: look.label, tone: look.tone, canFinish: index >= 1 };
}

/** Cronômetro: 65 -> "1:05"; 3725 -> "1:02:05". */
export function fmtTimer(seconds) {
  const total = isNum(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * O "pulso" das leituras: quando chegou a última e quando a próxima é esperada.
 * Tudo em relógio de parede (ms), porque é o que o usuário sente.
 *
 * @param {object} o
 * @param {number} o.now
 * @param {number|null} o.lastScanAt     quando o gravador aceitou a última leitura
 * @param {number[]} [o.gaps]            últimos intervalos observados entre leituras (ms)
 * @param {{throttled?:boolean, intervalMs?:number, paused?:string|null, scanning?:boolean}} [o.loop]
 * @param {'idle'|'recording'|'paused'|'stopped'|string} [o.state]  estado do gravador
 * @returns {{phase:'paused'|'blocked'|'first'|'waiting'|'late', fraction:number, secondsLeft:number|null,
 *            expectedMs:number, title:string, detail:string}}
 */
export function pulseInfo({ now, lastScanAt, gaps = [], loop = {}, state = 'recording' } = {}) {
  const throttled = !!loop.throttled;
  const fallback = throttled ? 30_000 : (isNum(loop.intervalMs) ? loop.intervalMs : 3000) + 2500;
  const seen = gaps.filter((g) => isNum(g) && g > 0).slice(-4);
  let expectedMs = fallback;
  if (seen.length) {
    const sorted = seen.slice().sort((a, b) => a - b);
    expectedMs = sorted[Math.floor(sorted.length / 2)];
    // no ritmo limitado o Android nunca aceita antes de ~30 s: um intervalo curto observado foi sorte
    if (throttled) expectedMs = Math.max(expectedMs, 20_000);
  }
  expectedMs = clamp(expectedMs, 800, 120_000);

  if (state === 'paused') return { phase: 'paused', fraction: 0, secondsLeft: null, expectedMs, title: 'Em pausa', detail: 'Nenhuma leitura é guardada enquanto estiver em pausa.' };
  if (loop.paused === 'gate') return { phase: 'blocked', fraction: 0, secondsLeft: null, expectedMs, title: 'Sem acesso ao Wi-Fi', detail: 'Ligue o Wi-Fi e a Localização para continuar.' };
  if (loop.paused === 'hidden') return { phase: 'blocked', fraction: 0, secondsLeft: null, expectedMs, title: 'Em espera', detail: 'O app precisa ficar aberto na tela para ler o Wi-Fi.' };

  if (!isNum(lastScanAt)) {
    return {
      phase: 'first',
      fraction: 0,
      secondsLeft: null,
      expectedMs,
      title: 'Ouvindo o Wi-Fi…',
      detail: throttled ? 'A primeira leitura pode levar até meio minuto.' : 'A primeira leitura chega em instantes.',
    };
  }
  const elapsed = Math.max(0, now - lastScanAt);
  const fraction = clamp(elapsed / expectedMs, 0, 1);
  const left = Math.max(0, Math.ceil((expectedMs - elapsed) / 1000));
  const ago = Math.floor(elapsed / 1000);
  const agoText = ago < 2 ? 'Leitura recebida agora' : `Última leitura há ${ago}${THIN}s`;
  if (elapsed > expectedMs * 1.6 + 2000) {
    return {
      phase: 'late',
      fraction: 1,
      secondsLeft: 0,
      expectedMs,
      title: agoText,
      detail: throttled ? 'O Android está segurando as buscas. Continue parado: a próxima leitura já vem.' : 'A próxima leitura está demorando um pouco mais.',
    };
  }
  return {
    phase: 'waiting',
    fraction,
    secondsLeft: left,
    expectedMs,
    title: agoText,
    detail: left <= 0 ? 'Próxima leitura chegando…' : `Próxima em ≈${THIN}${left}${THIN}s`,
  };
}

/**
 * Hora de refazer a prévia do mapa? A prévia roda a cada poucas leituras novas, nunca com outra
 * em andamento, e espaçada no tempo para não gastar bateria à toa.
 */
export function previewDue({ scans = 0, lastScans = 0, running = false, now = 0, lastAt = 0, throttled = false, minScans = 4 } = {}) {
  if (running || scans < minScans) return false;
  const fresh = scans - lastScans;
  if (fresh <= 0) return false;
  if (lastScans === 0) return true; // a primeira prévia sai assim que há o mínimo
  const every = throttled ? 1 : scans < 30 ? 3 : scans < 90 ? 5 : 8;
  const gapMs = scans < 90 ? 2500 : 5000;
  return fresh >= every && now - lastAt >= gapMs;
}

/**
 * Redes candidatas a "minhas redes" antes de começar: a conectada primeiro, depois as
 * favoritas, depois as mais fortes. Já vêm marcadas a conectada e as favoritas.
 * @param {{networks?:object[], favorites?:Iterable<string>, connection?:object|null}} state  pedaços do store
 * @returns {{ssid:string, selected:boolean, connected:boolean, favorite:boolean, rssi:number|null, count:number}[]}
 */
export function candidateNetworks({ networks = [], favorites = [], connection = null } = {}, limit = 8) {
  const fav = new Set(favorites || []);
  const connectedSsid = connection && connection.connected && typeof connection.ssid === 'string' ? connection.ssid : null;
  const bySsid = new Map();
  for (const net of networks || []) {
    const ssid = typeof net.ssid === 'string' ? net.ssid : '';
    if (!ssid) continue; // rede oculta não tem nome para escolher
    const best = net.best && isNum(net.best.rssi) ? net.best.rssi : isNum(net.bestRssi) ? net.bestRssi : null;
    const count = Array.isArray(net.aps) ? net.aps.length : 1;
    const prev = bySsid.get(ssid);
    if (prev) {
      prev.count += count;
      if (isNum(best) && (!isNum(prev.rssi) || best > prev.rssi)) prev.rssi = best;
    } else {
      bySsid.set(ssid, { ssid, selected: false, connected: ssid === connectedSsid, favorite: fav.has(ssid), rssi: best, count });
    }
  }
  // conectada ou favorita que não apareceu na última busca continua na lista
  if (connectedSsid && !bySsid.has(connectedSsid)) bySsid.set(connectedSsid, { ssid: connectedSsid, selected: false, connected: true, favorite: fav.has(connectedSsid), rssi: isNum(connection.rssi) ? connection.rssi : null, count: 1 });
  for (const ssid of fav) if (ssid && !bySsid.has(ssid)) bySsid.set(ssid, { ssid, selected: false, connected: false, favorite: true, rssi: null, count: 0 });
  const list = [...bySsid.values()];
  for (const item of list) item.selected = item.connected || item.favorite;
  const rank = (n) => (n.connected ? 0 : n.favorite ? 1 : 2);
  list.sort((a, b) => rank(a) - rank(b) || (b.rssi ?? -200) - (a.rssi ?? -200) || (a.ssid < b.ssid ? -1 : 1));
  const keep = list.filter((n) => n.selected);
  for (const n of list) if (!n.selected && keep.length < limit) keep.push(n);
  return keep;
}

/**
 * BSSIDs "da casa" de um levantamento: todos os rádios das redes escolhidas, os outros
 * rádios dos mesmos aparelhos e os BSSIDs extras (o conectado).
 * @param {{aps?:Object<string,{ssid:string, device?:string}>}} survey
 * @param {string[]} ownSsids
 * @param {string[]} [extra]
 */
export function ownBssidsFor(survey, ownSsids = [], extra = []) {
  const aps = survey && survey.aps && typeof survey.aps === 'object' ? survey.aps : {};
  const names = new Set((ownSsids || []).filter((s) => typeof s === 'string' && s !== ''));
  const out = new Set();
  for (const id of extra || []) if (typeof id === 'string' && id && aps[id.toLowerCase()]) out.add(id.toLowerCase());
  for (const id in aps) if (names.has(aps[id].ssid)) out.add(id);
  const devices = new Set();
  for (const id of out) if (aps[id] && aps[id].device) devices.add(aps[id].device);
  for (const id in aps) if (aps[id].device && devices.has(aps[id].device)) out.add(id);
  return [...out].sort();
}

/**
 * Roteadores a medir por Wi-Fi RTT agora: os que anunciam 802.11mc, os da casa primeiro e
 * depois os mais fortes (o Android mede no máximo 10 por pedido).
 * @param {object[]} aps  lista do store
 */
export function rttTargets(aps = [], limit = 8) {
  return (aps || [])
    .filter((a) => a && a.rttResponder && !a.stale && typeof a.bssid === 'string')
    .sort((a, b) => Number(!!b.own) - Number(!!a.own) || (b.rssi ?? -200) - (a.rssi ?? -200))
    .slice(0, limit)
    .map((a) => a.bssid);
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

/**
 * Qualidade do mapa em palavras.
 * @param {import('../../mapping/types.js').MapQuality|null} quality
 */
export function qualityInfo(quality) {
  const q = quality && typeof quality === 'object' ? quality : {};
  const level = q.level === 'boa' || q.level === 'razoavel' || q.level === 'fraca' ? q.level : 'fraca';
  const look = {
    boa: { label: 'Boa', tone: 'good', text: 'Os lugares e o sinal medido devem bater bem com a casa.' },
    razoavel: { label: 'Razoável', tone: 'info', text: 'Dá uma boa ideia da casa; alguns lugares podem estar deslocados.' },
    fraca: { label: 'Fraca', tone: 'warning', text: 'Serve como rascunho: faltaram leituras para um mapa confiável.' },
  }[level];
  const err = isNum(q.expectedErrorM) && q.expectedErrorM > 0 ? q.expectedErrorM : null;
  const errorText = err === null ? 'Posições aproximadas' : `Posições com erro típico de ≈${THIN}${fmtNum(Math.round(err * 2) / 2, 1).replace(/,0$/, '')}${THIN}m`;
  const scale = isNum(q.scaleConf) ? q.scaleConf : 0;
  const scaleText = scale >= 0.7 ? 'Tamanho bem estimado' : scale >= 0.4 ? 'Tamanho com folga de uns 25%' : 'Tamanho incerto: vale ajustar a escala';
  return { level, label: look.label, tone: look.tone, text: look.text, errorText, scaleText, notes: Array.isArray(q.notes) ? q.notes.filter((n) => typeof n === 'string' && n.trim()) : [] };
}

/** Faixas da cobertura, na ordem do melhor para o pior. As palavras são as mesmas da legenda do mapa. */
export const COVERAGE_BANDS = Object.freeze([
  { key: 'good', label: 'Bom ou ótimo', range: `−67${THIN}dBm ou mais`, sig: 1 },
  { key: 'fair', label: 'Regular', range: `−67 a −75${THIN}dBm`, sig: 3 },
  { key: 'weak', label: 'Fraco', range: `−75 a −82${THIN}dBm`, sig: 4 },
  { key: 'dead', label: 'Muito fraco ou sem sinal', range: `abaixo de −82${THIN}dBm`, sig: 5 },
]);

/**
 * Cobertura em porcentagens inteiras que somam 100 (maiores restos).
 * @param {import('../../mapping/types.js').Coverage|null} cov
 * @returns {{key:string, label:string, range:string, sig:number, pct:number}[]}
 */
export function coverageParts(cov) {
  const raw = COVERAGE_BANDS.map((b) => (cov && isNum(cov[b.key]) && cov[b.key] > 0 ? cov[b.key] : 0));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return COVERAGE_BANDS.map((b) => ({ ...b, pct: b.key === 'dead' ? 100 : 0 }));
  const exact = raw.map((v) => (v / sum) * 100);
  const pct = exact.map(Math.floor);
  let left = 100 - pct.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) pct[order[k][1]] += 1;
  return COVERAGE_BANDS.map((b, i) => ({ ...b, pct: pct[i] }));
}

/** "Fraco", "Regular"... a palavra da legenda do mapa para um nível em dBm. */
export function signalWordAt(dbm) {
  if (!isNum(dbm)) return 'Sem sinal';
  if (dbm >= -60) return 'Ótimo';
  if (dbm >= -67) return 'Bom';
  if (dbm >= -75) return 'Regular';
  if (dbm >= -82) return 'Fraco';
  return 'Muito fraco';
}

const approxDbm = (dbm) => `≈${THIN}${fmtDbm(dbm)}`;

/** "no Quarto 2", com o andar quando o mapa tem mais de um: "no Quarto 2 (1º andar)". */
export function placeText(place, multiFloor = false) {
  if (!place || typeof place !== 'object') return '';
  const where = place.room ? wherePhrase(place.room) : 'num trecho sem nome';
  return multiFloor && isNum(place.floor) ? `${where} (${floorName(place.floor).toLowerCase()})` : where;
}

/**
 * As zonas ruins em frases: "Sinal muito fraco no Quarto 2 (≈ −86 dBm)".
 * Junta as zonas do mesmo ambiente e mostra as piores primeiro.
 * @param {import('../../mapping/types.js').Coverage|null} cov
 * @param {{multiFloor?:boolean, limit?:number}} [options]
 * @returns {{text:string, floor:number, x:number, y:number, dbm:number, areaM2:number}[]}
 */
export function deadZoneLines(cov, { multiFloor = false, limit = 4 } = {}) {
  const zones = cov && Array.isArray(cov.deadZones) ? cov.deadZones : [];
  const merged = new Map();
  for (const z of zones) {
    if (!z || typeof z !== 'object') continue;
    const key = `${isNum(z.floor) ? z.floor : 0}|${z.room ? fold(z.room) : `@${Math.round(z.x)}:${Math.round(z.y)}`}`;
    const prev = merged.get(key);
    const area = isNum(z.areaM2) ? z.areaM2 : 0;
    if (!prev) merged.set(key, { floor: isNum(z.floor) ? z.floor : 0, room: z.room || null, x: z.x, y: z.y, dbm: z.dbm, areaM2: area, maxPart: area });
    else {
      // o centro passa a ser o da maior mancha; o nível, o pior entre elas
      if (area > prev.maxPart) {
        prev.x = z.x;
        prev.y = z.y;
        prev.maxPart = area;
      }
      if (isNum(z.dbm) && (!isNum(prev.dbm) || z.dbm < prev.dbm)) prev.dbm = z.dbm;
      prev.areaM2 += area;
    }
  }
  const list = [...merged.values()].sort((a, b) => b.areaM2 - a.areaM2);
  return list.slice(0, limit).map((z) => {
    const word = isNum(z.dbm) ? (z.dbm < -82 ? 'Sinal muito fraco' : 'Sinal fraco') : 'Sem sinal';
    const where = `${placeText(z, false)}${multiFloor ? `, ${floorName(z.floor).toLowerCase()}` : ''}`;
    return { text: isNum(z.dbm) ? `${word} ${where} (${approxDbm(z.dbm)})` : `${word} ${where}`, floor: z.floor, x: z.x, y: z.y, dbm: z.dbm, areaM2: z.areaM2 };
  });
}

/**
 * Opções do seletor "Mostrar": ambientes, as redes do usuário e algumas vizinhas.
 * @param {import('../../mapping/types.js').MapModel|null} model
 * @returns {{key:string, kind:'rooms'|'own'|'other', label:string, ssid:string}[]}
 */
export function heatChoices(model, { maxOthers = 4 } = {}) {
  const out = [{ key: 'rooms', kind: 'rooms', label: 'Ambientes', ssid: '' }];
  const nets = model && Array.isArray(model.networks) ? model.networks : [];
  const own = nets.filter((n) => n.own);
  const others = nets.filter((n) => !n.own).slice(0, maxOthers);
  const seen = new Map();
  const name = (n) => {
    const base = cleanLabel(String(n.ssid ?? ''), 32) || 'Rede oculta';
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count > 1 ? `${base} (${count})` : base;
  };
  for (const n of own) out.push({ key: n.key, kind: 'own', label: name(n), ssid: n.ssid || '' });
  for (const n of others) out.push({ key: n.key, kind: 'other', label: name(n), ssid: n.ssid || '' });
  return out;
}

/**
 * Sinal médio de uma rede dentro de um ambiente (média das células do ambiente no campo de sinal).
 * @returns {number|null} dBm
 */
export function roomSignal(model, floorIndex, roomIndex, field) {
  const floor = model && model.floors ? model.floors[floorIndex] : null;
  if (!floor || !field || !field.dbm || !floor.room) return null;
  let sum = 0;
  let n = 0;
  const cells = floor.room;
  for (let c = 0; c < cells.length; c++) {
    if (cells[c] !== roomIndex) continue;
    const v = field.dbm[c];
    if (Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n ? sum / n : null;
}

/** Pontos marcados para o painel "Ajustar a escala": nome sem ambiguidade + andar. */
export function spotOptions(model) {
  const spots = model && Array.isArray(model.spots) ? model.spots : [];
  const multi = model && Array.isArray(model.floors) && model.floors.length > 1;
  const count = new Map();
  for (const s of spots) {
    const k = fold(s.label);
    count.set(k, (count.get(k) || 0) + 1);
  }
  const seq = new Map();
  let unnamed = 0;
  return spots.map((s) => {
    let label = cleanLabel(String(s.label ?? ''));
    if (!label) {
      unnamed += 1;
      label = `Lugar ${unnamed}`;
    } else if (count.get(fold(label)) > 1) {
      const k = fold(label);
      const i = (seq.get(k) || 0) + 1;
      seq.set(k, i);
      label = `${label} (${i}ª marcação)`;
    }
    return { id: s.id, label: multi ? `${label} · ${floorName(s.floor)}` : label, floor: s.floor, x: s.x, y: s.y };
  });
}

/** Distância (m) que o mapa estima hoje entre dois pontos marcados; null se algum não existe. */
export function spotDistance(model, a, b) {
  const spots = model && Array.isArray(model.spots) ? model.spots : [];
  const pa = spots.find((s) => s.id === a);
  const pb = spots.find((s) => s.id === b);
  if (!pa || !pb || pa === pb) return null;
  return Math.hypot(pa.x - pb.x, pa.y - pb.y, (isNum(pa.z) ? pa.z : 0) - (isNum(pb.z) ? pb.z : 0));
}

/** "3,5", "3.5 m", " 12 metros " -> metros; fora de 0,5 a 200 m (ou texto que não é número) -> null. */
export function parseMeters(text) {
  if (isNum(text)) return text >= 0.5 && text <= 200 ? text : null;
  if (typeof text !== 'string') return null;
  const m = text.trim().toLowerCase().match(/^(\d{1,3}(?:[.,]\d{1,2})?)\s*(m|metro|metros)?$/);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  return Number.isFinite(value) && value >= 0.5 && value <= 200 ? value : null;
}

/** Índice da varredura que representa um ponto marcado (a do meio entre as feitas ali); -1 se não há. */
export function spotScanIndex(survey, spotId) {
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : [];
  const idx = [];
  for (let i = 0; i < scans.length; i++) if (scans[i] && scans[i].spot === spotId) idx.push(i);
  return idx.length ? idx[Math.floor((idx.length - 1) / 2)] : -1;
}

/**
 * Levantamento com a distância real entre dois pontos marcados (calibração do usuário).
 * Devolve um levantamento NOVO (o original não muda); null se os pontos não servem.
 * Uma medida para o mesmo par substitui a anterior.
 */
export function withKnownDistance(survey, spotA, spotB, meters) {
  const a = spotScanIndex(survey, spotA);
  const b = spotScanIndex(survey, spotB);
  if (a < 0 || b < 0 || a === b || !isNum(meters) || meters <= 0) return null;
  const spotOf = (i) => (survey.scans[i] ? survey.scans[i].spot : null);
  const kept = (Array.isArray(survey.knownDistances) ? survey.knownDistances : []).filter((k) => {
    const pair = [spotOf(k.a), spotOf(k.b)];
    return !(pair.includes(spotA) && pair.includes(spotB));
  });
  return { ...survey, knownDistances: [...kept, { a: Math.min(a, b), b: Math.max(a, b), meters }] };
}

/**
 * Troca o nome de um ambiente do mapa. Os nomes moram no levantamento (rótulo das varreduras):
 *   - ambiente que já tinha nome: todas as varreduras com aquele nome ganham o novo;
 *   - ambiente automático ("Ambiente 2"): as varreduras que caíram nele ganham o nome.
 * Devolve um levantamento NOVO, ou null quando não há o que renomear.
 */
export function renameRoom(survey, model, floorIndex, roomId, name) {
  const floor = model && Array.isArray(model.floors) ? model.floors[floorIndex] : null;
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : null;
  if (!floor || !scans) return null;
  const roomIndex = floor.rooms.findIndex((r) => r.id === roomId);
  const room = floor.rooms[roomIndex];
  if (!room) return null;
  const label = cleanLabel(String(name ?? ''));
  const targets = new Set();
  if (!room.auto) {
    for (let i = 0; i < scans.length; i++) {
      const s = scans[i];
      if (s && (isNum(s.floor) ? Math.round(s.floor) : 0) === floor.floor && sameLabel(s.label, room.label)) targets.add(i);
    }
  } else {
    if (!label) return null;
    const { nx, ny, cell, bounds } = model;
    for (const p of model.path || []) {
      if (p.floor !== floor.floor) continue;
      const ix = Math.floor((p.x - bounds.minX) / cell);
      const iy = Math.floor((p.y - bounds.minY) / cell);
      if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
      if (floor.room[iy * nx + ix] === roomIndex && scans[p.i]) targets.add(p.i);
    }
  }
  if (!targets.size) return null;
  const next = scans.map((s, i) => {
    if (!targets.has(i)) return s;
    const copy = { ...s };
    if (label) copy.label = label;
    else delete copy.label;
    return copy;
  });
  return { ...survey, scans: next };
}

// ---------------------------------------------------------------------------
// Biblioteca e arquivos
// ---------------------------------------------------------------------------

/**
 * Resumo de um mapa para o cartão da biblioteca (guardado junto, para a lista não precisar
 * refazer o mapa de cada um).
 */
export function mapMeta(model, survey) {
  const q = (model && model.quality) || {};
  const floors = model && Array.isArray(model.floors) ? model.floors : [];
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : [];
  const last = scans.length ? scans[scans.length - 1] : null;
  return {
    areaM2: isNum(q.areaM2) ? Math.round(q.areaM2) : 0,
    rooms: floors.reduce((sum, f) => sum + (Array.isArray(f.rooms) ? f.rooms.length : 0), 0),
    floors: floors.length,
    scans: isNum(q.scans) ? q.scans : scans.length,
    spots: isNum(q.spots) ? q.spots : 0,
    level: q.level === 'boa' || q.level === 'razoavel' ? q.level : 'fraca',
    errorM: isNum(q.expectedErrorM) ? Math.round(q.expectedErrorM * 10) / 10 : null,
    durationS: last && isNum(last.t) ? Math.round(last.t) : 0,
  };
}

/** "≈ 62 m² · 5 ambientes · 2 andares" */
export function metaLine(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  if (isNum(meta.areaM2) && meta.areaM2 > 0) parts.push(`≈${THIN}${fmtNum(meta.areaM2)}${THIN}m²`);
  if (isNum(meta.rooms) && meta.rooms > 0) parts.push(`${meta.rooms} ${meta.rooms === 1 ? 'ambiente' : 'ambientes'}`);
  if (isNum(meta.floors) && meta.floors > 1) parts.push(`${meta.floors} andares`);
  return parts.join(' · ');
}

/** Nome sugerido para um mapa novo: "Mapa de 15/11"; se já existe, "Mapa de 15/11 (2)". */
export function defaultMapName(ts, taken = [], base) {
  const d = new Date(isNum(ts) ? ts : Date.now());
  const pad = (v) => String(v).padStart(2, '0');
  const root = cleanLabel(String(base ?? '')) || `Mapa de ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  const used = (taken || []).map((t) => fold(t));
  if (!used.includes(fold(root))) return root;
  for (let n = 2; n < 200; n++) {
    const name = `${root} (${n})`;
    if (!used.includes(fold(name))) return name;
  }
  return `${root} (${Date.now() % 1000})`;
}

/** Nome de arquivo seguro a partir do nome do mapa: "Casa da Vó!" -> "casa-da-vo". */
export function fileSlug(name, fallback = 'mapa') {
  const slug = fold(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || fallback;
}

/** Nome do mapa digitado -> guardado (mesma limpeza dos nomes de lugar, um pouco mais comprido). */
export function cleanMapName(text) {
  return cleanLabel(text, 60);
}

/**
 * Monta o registro de um mapa para guardar. O modelo nunca é guardado: ele é refeito a partir
 * do levantamento e da solução.
 */
export function makeRecord({ id, name, createdAt, survey, solution, own = [], ownSsids = [], recorder = null, model = null, thumb = null, demo = false, now = Date.now() } = {}) {
  const record = {
    name: cleanMapName(String(name ?? '')) || defaultMapName(now),
    createdAt: isNum(createdAt) ? createdAt : now,
    updatedAt: now,
    survey,
    solution,
    own: Array.isArray(own) ? own.slice() : [],
    ownSsids: Array.isArray(ownSsids) ? ownSsids.slice() : [],
    meta: { ...mapMeta(model, survey), demo: !!demo },
  };
  if (id !== undefined && id !== null) record.id = id;
  if (recorder) record.recorder = recorder;
  if (typeof thumb === 'string' && thumb.startsWith('data:image/')) record.thumb = thumb;
  return record;
}

/**
 * Lê um registro vindo do armazenamento (ou de um arquivo importado) sem confiar nele.
 * @returns {{id:any, name:string, createdAt:number|null, updatedAt:number|null, survey:object|null, solution:object|null,
 *            own:string[], ownSsids:string[], recorder:any, meta:object, thumb:string|null}|null}
 */
export function readRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string') : []);
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const survey = raw.survey && typeof raw.survey === 'object' && Array.isArray(raw.survey.scans) ? raw.survey : null;
  const solution = raw.solution && typeof raw.solution === 'object' && Array.isArray(raw.solution.points) ? raw.solution : null;
  return {
    id: raw.id ?? null,
    name: cleanMapName(String(raw.name ?? '')) || 'Mapa sem nome',
    createdAt: isNum(raw.createdAt) ? raw.createdAt : null,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : isNum(raw.createdAt) ? raw.createdAt : null,
    survey,
    solution,
    own: strings(raw.own),
    ownSsids: strings(raw.ownSsids),
    recorder: raw.recorder ?? null,
    meta: {
      areaM2: isNum(meta.areaM2) ? meta.areaM2 : 0,
      rooms: isNum(meta.rooms) ? meta.rooms : 0,
      floors: isNum(meta.floors) ? meta.floors : 0,
      scans: isNum(meta.scans) ? meta.scans : survey ? survey.scans.length : 0,
      spots: isNum(meta.spots) ? meta.spots : 0,
      level: meta.level === 'boa' || meta.level === 'razoavel' || meta.level === 'fraca' ? meta.level : null,
      errorM: isNum(meta.errorM) ? meta.errorM : null,
      durationS: isNum(meta.durationS) ? meta.durationS : 0,
      demo: !!meta.demo,
    },
    // só imagens embutidas: um endereço de fora nunca vira <img src>
    thumb: typeof raw.thumb === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.thumb) ? raw.thumb : null,
  };
}

/** Distância em texto de estimativa: "≈ 4 m". */
export function approxMetersText(m) {
  return fmtMeters(m, { approx: true });
}
