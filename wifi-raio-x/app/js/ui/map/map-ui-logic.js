// Lógica pura das telas do Mapa 3D (biblioteca, levantamento e resultado).
// Nada aqui toca no DOM: entra estado simples, saem textos e objetos simples (roda em node:test).
//
// Nomes e andares
//   ROOM_PRESETS · cleanLabel(texto) · sameLabel(a, b) · roomChips(usados) · wherePhrase(nome)
//   floorName(n) · floorShort(n) · clampFloor(n)
// Levantamento
//   levelInfo(nível) · finishBlocker(stats, limites) · fmtTimer(segundos) · pulseInfo({...}) · previewDue({...})
//   surveyTimeText(limitado, limites) · surveyTips({throttled, during}, limites) · pointByPointNote({...})
//   radarInfo({...}) · spotCounter({...}, limites)      (o que a tela diz andando x "ponto a ponto")
//   candidateNetworks({networks, favorites, connection}) · ownBssidsFor(survey, ssids, extras)
//   rttTargets(aps, limite)
// Resultado
//   qualityInfo(quality) · coverageParts(cov) · deadZoneLines(cov, opções) · placeText(lugar, váriosAndares)
//   heatChoices(model) · hasRooms(model) · roomsInvite(model) · roomSignal(model, andar, ambiente, campo)
//   signalWordAt(dbm) · ACCURACY (os números de precisão que as telas citam)
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
 * Por que ainda não dá para concluir, em uma frase (vai embaixo do botão "Concluir").
 * @param {object} stats        stats() do gravador
 * @param {{minUseful?:number, minSpots?:number, scansPerSpot?:number}} [limits]  SURVEY_THRESHOLDS do gravador
 */
export function finishBlocker(stats, limits = {}) {
  const st = stats && typeof stats === 'object' ? stats : {};
  const minUseful = isNum(limits.minUseful) ? limits.minUseful : 25;
  const minSpots = isNum(limits.minSpots) ? limits.minSpots : 12;
  const scans = isNum(st.scans) ? st.scans : 0;
  if (scans === 0) {
    // ponto a ponto ninguém "anda sem parar": o que conta são os lugares marcados
    return st.throttled ? `Para concluir, marque pelo menos ${minSpots} lugares (${SPOTS_PER_ROOM}).` : 'Para concluir, o mapa precisa de leituras: ande pela casa com o app aberto.';
  }
  // um roteador só ao alcance: não é questão de quantidade de leituras, deste lugar não sai mapa
  const fewAfter = isNum(limits.fewDevicesAfter) ? limits.fewDevicesAfter : 8;
  const minDevices = isNum(limits.minDevices) ? limits.minDevices : 2;
  if (isNum(st.devicesOften) && scans >= fewAfter && st.devicesOften < minDevices) {
    return 'Só um roteador ao alcance. Para montar o mapa o app precisa ouvir pelo menos três (os dos vizinhos contam); com um só não dá para saber onde cada leitura foi feita.';
  }
  const useful = isNum(st.useful) ? st.useful : scans;
  const spots = isNum(st.spots) ? st.spots : 0;
  const needUseful = Math.max(0, minUseful - useful);
  const needSpots = Math.max(0, minSpots - spots);
  // leituras de sobra e mesmo assim insuficiente: o sinal não variou (a pessoa não saiu do lugar)
  if (needUseful === 0 || needSpots === 0) return 'Para concluir, ande por mais cômodos: até aqui o sinal quase não mudou.';
  const lugares = needSpots === 1 ? 'falta 1 lugar marcado' : `faltam ${needSpots} lugares marcados`;
  // (uma casa de 4 a 6 cômodos não chega ao mínimo com um lugar por cômodo: a frase diz que vale repetir)
  if (st.throttled) return `Para concluir, ${lugares} (uma leitura em cada). Vale mais de um lugar no mesmo cômodo, em cantos diferentes.`;
  const leituras = needUseful === 1 ? 'falta 1 leitura' : `faltam ${needUseful} leituras`;
  return `Para concluir, ${leituras} andando pela casa (ou ${needSpots === 1 ? '1 lugar marcado' : `${needSpots} lugares marcados`}).`;
}

// --- o que a tela diz conforme o ritmo das leituras ---------------------------------------------
// Com o Android limitando as buscas (o padrão em celular de verdade) chega uma leitura a cada ~30 s
// e o mapa é feito "ponto a ponto": quem conta são os lugares marcados, não a caminhada. Os textos
// de um modo não servem para o outro ("ande sem parar" x "espere parado"), e o limite pode ligar
// ou desligar com a tela aberta: por isso saem todos daqui, calculados na hora de desenhar.

/** Intervalo típico entre as leituras com o Android limitando as buscas (s). */
export const THROTTLED_GAP_S = 30;

/** Como chegar ao mínimo de lugares numa casa de poucos cômodos. */
const SPOTS_PER_ROOM = '2 ou 3 por cômodo, em cantos diferentes';

const spotLimits = (limits = {}) => {
  const minSpots = isNum(limits.minSpots) ? limits.minSpots : 12;
  const goodSpots = isNum(limits.goodSpots) && limits.goodSpots > minSpots ? limits.goodSpots : Math.round(minSpots * 1.7);
  return { minSpots, goodSpots, minMinutes: Math.ceil((minSpots * THROTTLED_GAP_S) / 60), goodMinutes: Math.ceil((goodSpots * THROTTLED_GAP_S) / 60) };
};

/**
 * Subtítulo de "Antes de começar": quanto tempo leva. Ponto a ponto a conta é a do gravador
 * (mínimo de lugares × uma leitura a cada ~30 s), não a da caminhada.
 * @param {boolean} throttled
 * @param {{minSpots?:number, goodSpots?:number}} [limits]  SURVEY_THRESHOLDS do gravador
 */
export function surveyTimeText(throttled, limits = {}) {
  if (!throttled) return 'Leva de 3 a 10 minutos, conforme o tamanho da casa.';
  const l = spotLimits(limits);
  return `Leva de ${l.minMinutes} a ${l.goodMinutes} minutos: uma leitura a cada ${THROTTLED_GAP_S} segundos, em pelo menos ${l.minSpots} lugares.`;
}

/**
 * As dicas de como mapear, em "Antes de começar" e em "Como fazer um bom mapa".
 * @param {{throttled?:boolean, during?:boolean}} [o]  during: já na tela do levantamento (cita os botões de lá)
 * @param {{minSpots?:number, goodSpots?:number}} [limits]  SURVEY_THRESHOLDS do gravador
 * @returns {{icon:string, title:string, text:string}[]}
 */
export function surveyTips({ throttled = false, during = false } = {}, limits = {}) {
  const l = spotLimits(limits);
  const floor = { icon: 'floor-up', title: 'Ao trocar de andar, avise', text: 'Mude o controle “Andar” assim que chegar ao outro piso.' };
  const undo = { icon: 'undo', title: 'Errou? Desfaça', text: '“Desfazer” tira a última leitura; a pausa serve para atender a porta sem bagunçar o mapa.' };
  let tips;
  if (throttled) {
    tips = [
      {
        icon: 'pin',
        title: `Marque pelo menos ${l.minSpots} lugares`,
        text: during
          ? `Marque ${SPOTS_PER_ROOM}: são os lugares marcados que desenham a área do mapa.`
          : `Marque ${SPOTS_PER_ROOM}, e dê o nome do cômodo. Leva uns ${l.minMinutes} minutos; quanto mais lugares, melhor o mapa.`,
      },
      {
        icon: 'clock',
        title: 'Em cada lugar, espere a leitura chegar',
        text: during
          ? 'Toque em “Marcar este lugar”, fique parado até o app avisar (até meio minuto) e toque em “Segui andando”.'
          : 'Toque em “Marcar este lugar” e fique parado até o app avisar (até meio minuto). Só então vá ao próximo lugar.',
      },
    ];
  } else {
    tips = [
      {
        icon: 'walk',
        title: 'Ande devagar e por todos os cômodos',
        text: during ? 'Passe também pelos cantos: é o caminho andado que desenha a área do mapa.' : 'O app lê o Wi-Fi a cada poucos segundos. Quanto mais cantos da casa você visitar, melhor o mapa.',
      },
      {
        icon: 'pin',
        title: 'Pare e marque cada cômodo com o nome',
        text: during ? 'Toque em “Marcar este lugar”, espere parado as leituras chegarem e toque em “Segui andando”.' : 'Toque em “Marcar este lugar”, fique parado alguns segundos e siga andando.',
      },
    ];
  }
  tips.push(floor);
  if (during) tips.push(undo);
  return tips;
}

/**
 * O aviso "ponto a ponto" (Android limitando as buscas), antes de começar e durante o levantamento.
 * @param {{during?:boolean, canLift?:boolean}} [o]  canLift: esta versão do Android deixa desligar o limite
 * @returns {{title:string, text:string}}
 */
export function pointByPointNote({ during = false, canLift = true } = {}) {
  const why = `O Android está limitando as buscas: chega uma leitura a cada ${THROTTLED_GAP_S} segundos, mais ou menos.`;
  const how = during
    ? `Marque um lugar de cada vez (${SPOTS_PER_ROOM}) e fique parado até a leitura chegar.`
    : `Em vez de andar sem parar, você marca um lugar de cada vez (${SPOTS_PER_ROOM}) e espera parado a leitura chegar.`;
  const lift = canLift ? (during ? '' : ' Dá para liberar buscas rápidas nas opções do desenvolvedor.') : ' Nesta versão do Android não dá para desligar esse limite.';
  return { title: during ? 'Mapeamento ponto a ponto' : 'O mapa será feito ponto a ponto', text: `${why} ${how}${lift}` };
}

/**
 * O que o "radar" diz enquanto a prévia do mapa ainda não apareceu.
 * @param {{scans?:number, minScans?:number, throttled?:boolean, spot?:boolean, resumed?:boolean}} [o]
 *        spot: há um lugar marcado em aberto (a pessoa está parada: não é hora de mandar andar)
 *        resumed: as leituras vieram de um rascunho retomado
 * @returns {{text:string, sub:string}}
 */
export function radarInfo({ scans = 0, minScans = 5, throttled = false, spot = false, resumed = false } = {}) {
  const next = spot ? '' : throttled ? 'Vá ao próximo lugar e marque.' : 'Continue andando.';
  if (scans >= minScans) {
    if (resumed) return { text: 'Refazendo a prévia…', sub: `${scans} leituras guardadas do rascunho.` };
    return { text: 'Montando a primeira prévia…', sub: next || 'Só um instante.' };
  }
  if (scans <= 0) {
    return {
      text: 'A prévia do mapa aparece aqui',
      sub: throttled ? 'Depois das primeiras leituras, o desenho vai se formando a cada lugar marcado.' : 'Depois das primeiras leituras, o desenho vai se formando enquanto você anda.',
    };
  }
  return { text: scans === 1 ? '1 leitura recebida' : `${scans} leituras recebidas`, sub: `A prévia do mapa aparece com ${minScans} leituras.${next ? ` ${next}` : ''}` };
}

/**
 * O contador de lugares marcados. Ponto a ponto, enquanto não dá para concluir, mostra o
 * progresso ("5 de 12"): é o número que libera o botão "Concluir".
 * @param {{spots?:number, throttled?:boolean, canFinish?:boolean}} o
 * @param {{minSpots?:number}} [limits]
 * @returns {{value:string, of:string|null, label:string}}
 */
export function spotCounter({ spots = 0, throttled = false, canFinish = false } = {}, limits = {}) {
  const n = isNum(spots) ? spots : 0;
  const progress = throttled && !canFinish;
  return { value: String(n), of: progress ? `de ${spotLimits(limits).minSpots}` : null, label: n === 1 && !progress ? 'lugar marcado' : 'lugares marcados' };
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
 * @param {{networks?:object[], favorites?:Iterable<string>, connection?:object|null, own?:Set<string>|string[]}} state  pedaços do store
 * @returns {{ssid:string, selected:boolean, connected:boolean, favorite:boolean, sameDevice:boolean, rssi:number|null, count:number}[]}
 */
export function candidateNetworks({ networks = [], favorites = [], connection = null, own = null } = {}, limit = 8) {
  const fav = new Set(favorites || []);
  const ownIds = own && typeof own.has === 'function' ? own : new Set(Array.isArray(own) ? own : []);
  const connectedSsid = connection && connection.connected && typeof connection.ssid === 'string' ? connection.ssid : null;
  const bySsid = new Map();
  for (const net of networks || []) {
    const ssid = typeof net.ssid === 'string' ? net.ssid : '';
    if (!ssid) continue; // rede oculta não tem nome para escolher
    const best = net.best && isNum(net.best.rssi) ? net.best.rssi : isNum(net.bestRssi) ? net.bestRssi : null;
    const count = Array.isArray(net.aps) ? net.aps.length : 1;
    // outro nome saindo do mesmo roteador da rede conectada (a de 2,4 GHz e a de 5 GHz, por exemplo)
    const sameDevice = Array.isArray(net.aps) && net.aps.some((ap) => ap && (ap.own === true || ownIds.has(ap.bssid)));
    const prev = bySsid.get(ssid);
    if (prev) {
      prev.count += count;
      prev.sameDevice = prev.sameDevice || sameDevice;
      if (isNum(best) && (!isNum(prev.rssi) || best > prev.rssi)) prev.rssi = best;
    } else {
      bySsid.set(ssid, { ssid, selected: false, connected: ssid === connectedSsid, favorite: fav.has(ssid), sameDevice, rssi: best, count });
    }
  }
  // conectada ou favorita que não apareceu na última busca continua na lista
  if (connectedSsid && !bySsid.has(connectedSsid)) bySsid.set(connectedSsid, { ssid: connectedSsid, selected: false, connected: true, favorite: fav.has(connectedSsid), sameDevice: false, rssi: isNum(connection.rssi) ? connection.rssi : null, count: 1 });
  for (const ssid of fav) if (ssid && !bySsid.has(ssid)) bySsid.set(ssid, { ssid, selected: false, connected: false, favorite: true, sameDevice: false, rssi: null, count: 0 });
  const list = [...bySsid.values()];
  for (const item of list) item.selected = item.connected || item.favorite || item.sameDevice;
  const rank = (n) => (n.connected ? 0 : n.favorite ? 1 : n.sameDevice ? 2 : 3);
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
 * Os números de precisão que as telas citam. Vêm da bancada (tests/mapping/map-eval.mjs e
 * harness.mjs, solucionador e construtor finais: os 88 levantamentos simulados de map-eval mais 96
 * de conferência com outras sementes, 184 ao todo) e do ensaio do app inteiro no simulador
 * (tests/e2e/map-quality.e2e.mjs). Mudou o solucionador? Meça de novo e acerte aqui: os textos da
 * tela de resultado saem destes valores.
 *
 *   erro mediano de posição (m), depois do melhor encaixe: kitnet de 30 m² 0,9 · casas térreas
 *   sorteadas 1,0 (pequenas) a 1,4 (grandes) · apartamento de 63 m² 1,2 · sobrado de 2 x 80 m² 1,6 ·
 *   escritório de 280 m² 2,4 (andando com leituras livres 1,2 a 1,5; uma leitura a cada 30 s 1,6);
 *   9 em cada 10 posições erram menos que o dobro disso;
 *   tamanho (linear) do desenho / real: média 0,89; um em cada dez mapas sai mais de 29% menor e um
 *   em cada dez mais de 7% maior; com confiança de escala a partir de 0,5 metade erra mais de 10% e
 *   um em cada cinco mais de 21%; abaixo de 0,5, metade erra mais de 19% e um em cada cinco mais de
 *   29%; o pior caso, nos dois grupos, 40%;
 *   área desenhada / real: 1,01 na média, mas de 0,6 a 1,5 mapa a mapa (um em cada dez abaixo e um
 *   acima); casas de até ~45 m² 1,34; apartamento e casas médias e grandes 0,99; sobrado 0,88;
 *   escritório 0,56;
 *   leitura no cômodo certo: 81% (96% na kitnet, 78% no apartamento, 77% no escritório, 64% no sobrado);
 *   ambiente com nome: com todos os cômodos batizados, 78% da área dele é mesmo do cômodo com aquele
 *   nome (70% com um lugar marcado só por cômodo); com metade dos cômodos batizados, cerca de 65%
 *   (antes de o nome valer só perto de onde foi dado: 52 a 61%, com os nomes cobrindo quase a casa toda).
 */
export const ACCURACY = Object.freeze({
  /** erro mediano de posição: [casa pequena, casa grande / dois andares], em metros */
  homeErrorM: [1, 2],
  /** num lugar grande (escritório de ~300 m²) */
  largeErrorM: 2.4,
  /**
   * quanto o desenho costuma sair menor que a casa (linear): 11% na bancada; com o app inteiro
   * conduzido no simulador (map-quality.e2e.mjs), de 12 a 38% conforme o lugar (a pessoa virtual de
   * lá anda mais depressa, e a escala vem do passo de quem anda)
   */
  shrinkPct: 15,
  /** folga do tamanho: confiança de escala normal (>= 0,5) e baixa */
  scalePct: 25,
  scaleLowPct: 40,
  /** leituras que caem no cômodo certo: casa térrea; casa de dois andares */
  rightRoom: [4, 5],
  rightRoomTwoFloors: [3, 5],
  /** quanto a área desenhada costuma passar da real numa casa pequena (até ~45 m²) */
  smallAreaOverPct: 30,
  /** da área de um ambiente com nome, quanto é mesmo do cômodo daquele nome: [todos os cômodos batizados], só alguns */
  namedAreaPct: [70, 80],
  namedAreaPartialPct: 65,
});

/**
 * Qualidade do mapa em palavras.
 * @param {import('../../mapping/types.js').MapQuality|null} quality
 */
export function qualityInfo(quality) {
  const q = quality && typeof quality === 'object' ? quality : {};
  const level = q.level === 'boa' || q.level === 'razoavel' || q.level === 'fraca' ? q.level : 'fraca';
  const notes = Array.isArray(q.notes) ? q.notes.filter((n) => typeof n === 'string' && n.trim()) : [];
  // Levantamento de que não sai mapa (um roteador só, tudo no mesmo lugar...): não há erro típico
  // nem tamanho a declarar; a tela mostra o motivo (a primeira nota) e o que fazer.
  if (q.usable === false) {
    return {
      level: 'fraca',
      usable: false,
      label: 'Sem mapa',
      tone: 'warning',
      text: notes[0] || 'Deste levantamento não foi possível tirar um mapa.',
      errorText: 'Posições sem valor: o desenho não representa a casa',
      scaleText: 'Tamanho desconhecido',
      notes: notes.slice(1),
    };
  }
  const look = {
    boa: { label: 'Boa', tone: 'good', text: 'Os lugares e o sinal medido devem bater bem com a casa.' },
    razoavel: { label: 'Razoável', tone: 'info', text: 'Dá uma boa ideia da casa; alguns lugares podem estar deslocados.' },
    fraca: { label: 'Fraca', tone: 'warning', text: 'Serve como rascunho: veja abaixo o que limitou este mapa.' },
  }[level];
  const err = isNum(q.expectedErrorM) && q.expectedErrorM > 0 ? q.expectedErrorM : null;
  const errorText = err === null ? 'Posições aproximadas' : `Posições com erro típico de ≈${THIN}${fmtNum(Math.round(err * 2) / 2, 1).replace(/,0$/, '')}${THIN}m`;
  const scale = isNum(q.scaleConf) ? q.scaleConf : 0;
  // 0,7 ou mais só acontece com uma distância medida pelo usuário ("Ajustar a escala")
  const scaleText =
    scale >= 0.7 ? 'Tamanho ajustado pela distância que você mediu' : scale >= 0.5 ? `Tamanho com folga de uns ${ACCURACY.scalePct}% (costuma sair um pouco menor)` : `Tamanho incerto (pode errar ${ACCURACY.scaleLowPct}%): vale ajustar a escala`;
  return { level, usable: true, label: look.label, tone: look.tone, text: look.text, errorText, scaleText, notes };
}

/** O mapa tem ambientes em algum andar? (só tem quando o usuário deu nome a pelo menos dois lugares do andar) */
export function hasRooms(model) {
  const floors = model && Array.isArray(model.floors) ? model.floors : [];
  return floors.some((f) => f && Array.isArray(f.rooms) && f.rooms.length > 0);
}

/**
 * Convite para marcar lugares com nome, quando o mapa (ou um andar dele) saiu sem divisão em
 * ambientes. null quando todos os andares têm ambientes.
 * @returns {{title:string, text:string, all:boolean}|null}
 */
export function roomsInvite(model) {
  const floors = model && Array.isArray(model.floors) ? model.floors : [];
  if (!floors.length) return null;
  const plain = floors.filter((f) => !f || !Array.isArray(f.rooms) || !f.rooms.length);
  if (!plain.length) return null;
  const spots = model && Array.isArray(model.spots) ? model.spots : [];
  // lugares marcados que têm nome (dois lugares com o MESMO nome, ou em andares diferentes, não dividem nada)
  const named = spots.filter((sp) => fold(sp.label)).length;
  if (plain.length < floors.length) {
    const names = plain.map((f) => floorName(f.floor)).join(' e ');
    return {
      all: false,
      title: `${names}: sem divisão em ambientes`,
      text: `${plain.length > 1 ? 'Nestes andares' : 'Neste andar'} menos de dois lugares têm nomes diferentes. Volte lá com “Continuar mapeando”, pare em cada cômodo e marque o lugar com o nome.`,
    };
  }
  const why = 'o app não inventa divisões, porque só com o sinal elas sairiam quase ao acaso';
  let text;
  if (named === 0) text = `Este mapa mostra a área por onde você andou, sem dividir em ambientes: ${why}. Toque em “Continuar mapeando”, pare em pelo menos dois cômodos e marque cada lugar com o nome.`;
  else if (named === 1) text = `Só um lugar tem nome, e ${why}. Toque em “Continuar mapeando”, pare em mais um cômodo (ou em todos) e marque o lugar com o nome.`;
  else if (floors.length > 1) text = `Nenhum andar tem dois lugares com nomes diferentes, e ${why}. Toque em “Continuar mapeando” e marque pelo menos dois cômodos em cada andar, cada um com o seu nome.`;
  else text = `Os lugares marcados têm todos o mesmo nome, e ${why}. Toque em “Continuar mapeando”, pare em outro cômodo e marque o lugar com o nome dele.`;
  return { all: true, title: 'Quer ver os cômodos no mapa?', text };
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
  // sem lugares com nome o mapa não tem ambientes: a primeira opção mostra só a área
  const out = [{ key: 'rooms', kind: 'rooms', label: hasRooms(model) ? 'Ambientes' : 'Área', ssid: '' }];
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
 * Troca o nome de um ambiente do mapa. Os nomes moram no levantamento, nas varreduras dos pontos
 * marcados (uma varredura "andando" não guarda nome):
 *   - ambiente que já tinha nome: os pontos marcados com aquele nome, neste andar, ganham o novo
 *     (nome vazio = tira o nome; o ambiente volta a ser "Ambiente N");
 *   - ambiente automático ("Ambiente 2"): se há nele um ponto marcado sem nome, é ele que ganha o
 *     nome; senão a varredura mais próxima do centro do ambiente vira um ponto marcado com o nome.
 * Devolve um levantamento NOVO (o original não muda), ou null quando não há o que renomear.
 */
export function renameRoom(survey, model, floorIndex, roomId, name) {
  const floor = model && Array.isArray(model.floors) ? model.floors[floorIndex] : null;
  const scans = survey && Array.isArray(survey.scans) ? survey.scans : null;
  if (!floor || !scans || !Array.isArray(floor.rooms)) return null;
  const roomIndex = floor.rooms.findIndex((r) => r.id === roomId);
  const room = floor.rooms[roomIndex];
  if (!room) return null;
  const label = cleanLabel(String(name ?? ''));
  const floorOf = (scan) => (isNum(scan.floor) ? Math.round(scan.floor) : 0);
  const patchScans = (targets, change) => ({ ...survey, scans: scans.map((scan, i) => (targets.has(i) ? change({ ...scan }) : scan)) });
  const setLabel = (scan) => {
    if (label) scan.label = label;
    else delete scan.label;
    return scan;
  };

  if (!room.auto) {
    const targets = new Set();
    for (let i = 0; i < scans.length; i++) {
      const scan = scans[i];
      if (scan && scan.spot !== null && scan.spot !== undefined && floorOf(scan) === floor.floor && sameLabel(scan.label, room.label)) targets.add(i);
    }
    return targets.size ? patchScans(targets, setLabel) : null;
  }

  if (!label) return null;
  // varreduras deste andar que caíram dentro do ambiente
  const { nx, ny, cell, bounds } = model;
  const inside = [];
  for (const p of model.path || []) {
    if (p.floor !== floor.floor || !scans[p.i]) continue;
    const ix = Math.floor((p.x - bounds.minX) / cell);
    const iy = Math.floor((p.y - bounds.minY) / cell);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
    if (floor.room[iy * nx + ix] === roomIndex) inside.push(p);
  }
  if (!inside.length) return null;
  const near = (p) => Math.hypot(p.x - room.cx, p.y - room.cy);
  inside.sort((a, b) => near(a) - near(b));

  // um ponto marcado sem nome dentro do ambiente: o nome vai para ele (todas as varreduras do ponto)
  const unnamed = inside.find((p) => {
    const scan = scans[p.i];
    return scan.spot !== null && scan.spot !== undefined && !cleanLabel(String(scan.label ?? ''));
  });
  if (unnamed) {
    const id = scans[unnamed.i].spot;
    const targets = new Set();
    scans.forEach((scan, i) => scan && scan.spot === id && targets.add(i));
    return patchScans(targets, setLabel);
  }
  // senão, a varredura mais central (que ainda não é de nenhum ponto) vira um ponto com o nome
  const free = inside.find((p) => scans[p.i].spot === null || scans[p.i].spot === undefined);
  if (!free) return null;
  let nextId = 0;
  for (const scan of scans) if (scan && Number.isInteger(scan.spot) && scan.spot >= nextId) nextId = scan.spot + 1;
  return patchScans(new Set([free.i]), (scan) => ({ ...scan, still: true, spot: nextId, label }));
}

// ---------------------------------------------------------------------------
// Biblioteca e arquivos
// ---------------------------------------------------------------------------

const LEVELS_Q = ['boa', 'razoavel', 'fraca'];

/**
 * Resumo de um mapa a partir do modelo (o que a tela de resultado mostra e o que vai em
 * `stats` / `meta` do registro guardado).
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
    level: LEVELS_Q.includes(q.level) ? q.level : 'fraca',
    errorM: isNum(q.expectedErrorM) ? Math.round(q.expectedErrorM * 10) / 10 : null,
    durationS: last && isNum(last.t) ? Math.round(last.t) : 0,
  };
}

/** "≈ 62 m² · 2 andares · 5 lugares marcados" (cartão da biblioteca). */
export function metaLine(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  if (isNum(meta.areaM2) && meta.areaM2 > 0) parts.push(`≈${THIN}${fmtNum(Math.round(meta.areaM2))}${THIN}m²`);
  if (isNum(meta.floors) && meta.floors > 1) parts.push(`${meta.floors} andares`);
  if (isNum(meta.spots) && meta.spots > 0) parts.push(`${meta.spots} ${meta.spots === 1 ? 'lugar marcado' : 'lugares marcados'}`);
  else if (isNum(meta.scans) && meta.scans > 0) parts.push(`${meta.scans} ${meta.scans === 1 ? 'leitura' : 'leituras'}`);
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
 * Monta o registro de um mapa no formato de mapping/storage.js (put). O modelo nunca é
 * guardado: ele é refeito a partir do levantamento e da solução.
 *   { id?, name, survey, solution, own, meta: {ownSsids, rooms, errorM, durationS}, stats: {areaM2, level}, thumb, demo }
 */
export function makeRecord({ id, name, survey, solution, own = [], ownSsids = [], model = null, thumb = null, demo = false, now = Date.now() } = {}) {
  const meta = mapMeta(model, survey);
  const record = {
    name: cleanMapName(String(name ?? '')) || defaultMapName(now),
    survey,
    solution,
    own: Array.isArray(own) ? own.slice() : [],
    meta: { ownSsids: Array.isArray(ownSsids) ? ownSsids.filter((x) => typeof x === 'string').slice(0, 32) : [], rooms: meta.rooms, errorM: meta.errorM, durationS: meta.durationS },
    stats: { areaM2: meta.areaM2, level: meta.level },
    demo: !!demo,
  };
  if (typeof id === 'string' && id) record.id = id;
  if (typeof thumb === 'string' && thumb.startsWith('data:image/')) record.thumb = thumb;
  return record;
}

/**
 * Lê uma linha da lista (storage.list()) ou um registro completo (storage.get()) sem confiar
 * nele, e devolve um formato só para as telas.
 * @returns {{id:string|null, name:string, createdAt:number|null, updatedAt:number|null, survey:object|null, solution:object|null,
 *            own:string[], ownSsids:string[], demo:boolean, thumb:string|null,
 *            meta:{areaM2:number, floors:number, scans:number, spots:number, level:string|null, rooms:number, errorM:number|null, demo:boolean}}|null}
 */
export function readRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const survey = raw.survey && typeof raw.survey === 'object' && Array.isArray(raw.survey.scans) ? raw.survey : null;
  const solution = raw.solution && typeof raw.solution === 'object' && Array.isArray(raw.solution.points) ? raw.solution : null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : null,
    name: cleanMapName(String(raw.name ?? '')) || 'Mapa sem nome',
    createdAt: isNum(raw.createdAt) ? raw.createdAt : null,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : isNum(raw.createdAt) ? raw.createdAt : null,
    survey,
    solution,
    own: strings(raw.own),
    ownSsids: strings(meta.ownSsids),
    demo: raw.demo === true,
    // só imagens embutidas: um endereço de fora nunca vira <img src>
    thumb: typeof raw.thumb === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(raw.thumb) ? raw.thumb : null,
    meta: {
      areaM2: isNum(stats.areaM2) && stats.areaM2 > 0 ? stats.areaM2 : 0,
      floors: isNum(stats.floors) ? stats.floors : 0,
      scans: isNum(stats.scans) ? stats.scans : survey ? survey.scans.length : 0,
      spots: isNum(stats.spots) ? stats.spots : 0,
      level: LEVELS_Q.includes(stats.level) ? stats.level : null,
      rooms: isNum(meta.rooms) ? meta.rooms : 0,
      errorM: isNum(meta.errorM) ? meta.errorM : null,
      demo: raw.demo === true,
    },
  };
}

/** Distância em texto de estimativa: "≈ 4 m". */
export function approxMetersText(m) {
  return fmtMeters(m, { approx: true });
}

// ---------------------------------------------------------------------------
// De onde é um levantamento: da casa virtual (demonstração) ou do Wi-Fi de verdade
// ---------------------------------------------------------------------------
//
// Um levantamento pertence ao modo em que começou. Leituras da casa virtual nunca continuam com
// o Wi-Fi de verdade (nem o contrário): o mapa sairia sem sentido e guardado com o rótulo errado.

/** O rascunho (ou o mapa) é da demonstração? Só quando diz isso com todas as letras: sem o campo, conta como do Wi-Fi de verdade. */
export function isDemoOrigin(item) {
  return !!item && typeof item === 'object' && item.demo === true;
}

/** Dá para continuar este rascunho (ou mapa) no modo em que o app está agora? */
export function matchesMode(item, demoNow) {
  return isDemoOrigin(item) === !!demoNow;
}

/**
 * Os textos do cartão de um rascunho que é do outro modo.
 * @param {object} draft
 * @param {{locked?:boolean}} [o]  locked = aqui só existe a demonstração (navegador): não há como trocar de modo
 * @returns {{title:string, how:string}}
 */
export function foreignDraftText(draft, { locked = false } = {}) {
  if (isDemoOrigin(draft)) return { title: 'Rascunho da demonstração', how: 'Feito na casa virtual. Para continuar, ligue o modo demonstração nos Ajustes.' };
  return {
    title: 'Rascunho do Wi-Fi de verdade',
    how: locked ? 'Feito com o Wi-Fi de verdade. Só dá para continuar no celular, fora da demonstração.' : 'Feito com o Wi-Fi de verdade. Para continuar, saia da demonstração.',
  };
}
