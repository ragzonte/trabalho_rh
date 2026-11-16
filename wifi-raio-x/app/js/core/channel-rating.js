// Nota dos canais: "em que canal o meu roteador deveria estar?"
//
// O que oferece:
//   rateChannels      nota de 0 a 100 de cada canal de uma faixa, numa largura
//   recommendChannel  o melhor canal, a nota do atual, o veredito (ficar ou trocar) e a frase
//   recommendWidth    a largura de canal que vale a pena na faixa
//   rateOwnChannel    só a nota do canal em que um roteador está (barata; best-network usa)
//   channelGraph      os dados do gráfico de canais (uma "montanha" por rede)
// A faixa vai em `options.band` ou como segundo argumento, tanto faz. Todas aceitam
// `options.devices` = groupByDevice(aps) já calculado, para não agrupar de novo.
//
// MODELO (o mesmo para as três faixas e todas as larguras)
//
// Um canal candidato é um bloco [lo, hi] de `widthMHz` com um canal primário de 20 MHz. Para
// cada rádio vizinho calcula-se a potência que ele despeja dentro do bloco:
//     p = dbmToMw(rssi) · interferenceFactor(ocupação do vizinho, lo, hi)
// (BSSIDs do mesmo aparelho na mesma frequência são UM rádio com várias redes: contam uma vez,
// com um pequeno acréscimo pelos beacons de cada rede extra.)
//
// O estrago depende de o vizinho conseguir ou não "combinar a vez" com o nosso roteador:
//
// 1. Mesmo canal primário e sinal acima de −82 dBm (limiar de detecção de preâmbulo do 802.11):
//    os dois se ouvem e dividem o tempo educadamente (CSMA/CA). O custo é o tempo de ar que o
//    vizinho ocupa: um ciclo de trabalho estimado pelo número de aparelhos conectados (BSS Load),
//    ou 8% quando ele não informa. Quando o vizinho também mede a ocupação do canal (BSS Load),
//    o que passar do ciclo dele é carga extra X = (medido − ciclo)/(1 − ciclo), de quem quer que
//    seja; vale a maior entre os que medem. Tempo de ar tomado: T = 1 − (1 − X)·Π(1 − ciclo).
//    (Um vizinho sozinho que mede 60% dá T = 60%. Com vários, parte do tráfego pode ser contada
//    duas vezes: preferimos errar para o lado pessimista a deixar que uma rede a mais melhore a
//    nota de um canal.)
//
// 2. Qualquer outro caso (canal parcialmente sobreposto, primário diferente dentro do mesmo
//    bloco, vazamento do canal ao lado, ou mesmo canal com sinal fraco demais para decodificar):
//    o vizinho é ruído. Enquanto ele transmite, um enlace de referência (−65 dBm) perde a fração
//    x = 1 − C(com o ruído)/C(sem ele) da capacidade de Shannon. É aqui que entra a escala
//    logarítmica: o que conta são os dB acima do piso de ruído. Como não há coordenação, os
//    quadros colidem e são retransmitidos, e o controle de taxa despenca: a perda é ampliada por
//    (1 + 1,5·x), ou seja, até 2,5 vezes o tempo de ar do vizinho quando o ruído é forte. Por
//    unidade de potência isso é pior que dividir o canal; ruído fraco quase não custa.
//
// Nota = 100 · (1 − T) · Π(1 − perda de cada ruído): a fração da capacidade que sobra. Canal
// vazio = 100. Cada vizinho só entra multiplicando por algo ≤ 1, então acrescentar uma rede
// nunca aumenta a nota. Leituras velhas (ageMs > 30 s) pesam menos: metade a cada 30 s a mais.
//
// Dentro de um bloco largo, o primário escolhido é o que dá a maior nota: com vizinho forte, o
// mesmo primário dele (dividir é melhor que brigar); com vizinho fraco, tanto faz ou outro.
//
// Simplificações assumidas: a máscara espectral do padrão é pessimista para o vazamento entre
// canais; não modelamos a queda para uma largura menor quando só parte do bloco está ocupada
// (canais largos saem um pouco piores do que são); o ciclo de trabalho é uma estimativa.

import { blocksOf, blocksContaining, channelList, interferenceFactor, segmentsOf, maskDb } from './channels.js';
import { dbmToMw, mwToDbm, noiseFloorDbm, sanitizeRssi } from './signal.js';
import { asAp, asApList, groupByDevice, normalizeBssid } from './model.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object';
const round1 = (x) => Math.round(x * 10) / 10;

// --- parâmetros do modelo
const PREAMBLE_DETECT_DBM = -82;
const DEFAULT_DUTY = 0.08; // rádio que não informa nada: uns dois aparelhos em uso leve
const IDLE_DUTY = 0.02; // só beacons e manutenção
const DUTY_PER_STATION = 0.03;
const MAX_DUTY = 0.5;
const EXTRA_NETWORK_DUTY = 0.015; // beacons de cada rede a mais no mesmo rádio
const REFERENCE_SIGNAL_DBM = -65; // enlace "bom" típico dentro de casa
const COLLISION_GAIN = 1.5; // quanto as colisões ampliam a perda quando o ruído é forte
const MAX_LOSS = 0.95;
const NEGLIGIBLE_MW = 1e-11; // −110 dBm dentro do bloco: 16 dB abaixo do piso de ruído, não muda nada
const CAPACITY_TIE = 1e-12; // capacidades (0..1) mais próximas que isto são um empate
const STALE_AFTER_MS = 30_000;
const STALE_HALF_LIFE_MS = 30_000;

// --- política de recomendação
const STANDARD_24 = new Set([1, 6, 11]);
const KEEP_MARGIN = 8; // menos que isto de ganho não compensa o trabalho de trocar
const DFS_HANDICAP = 5; // um canal DFS só ganha de um comum se for mais que isto melhor
const OFF_STANDARD_TOLERANCE = 3;
const NEARLY_EMPTY_SCORE = 97; // 2,4 GHz: 40 MHz só com a faixa praticamente vazia
const FREE_SCORE = 90; // daqui para cima as frases chamam o canal de "livre"
const GOOD_SCORE = { 40: 60, 80: 70, 160: 80, 320: 85 };

const PSC = new Set(channelList('6').filter((c) => c.psc).map((c) => c.channel));
const CHANNEL_NOTE = {};
for (const band of ['2.4', '5', '6']) {
  CHANNEL_NOTE[band] = new Map(channelList(band, { all: true }).map((c) => [c.channel, c.note]));
}

const NOTE_OFF_STANDARD =
  'Fora do trio 1, 6 e 11: um roteador aqui atrapalha (e é atrapalhado por) dois canais padrão ao mesmo tempo';
// 12, 13 (e 14) não ficam "entre" dois canais padrão: estão acima do último e só encostam no 11.
// (Que alguns aparelhos importados não os enxergam já está na nota do próprio canal, em channels.js.)
const NOTE_ABOVE_STANDARD = 'Fora do trio 1, 6 e 11, acima dele: um roteador aqui ainda invade o canal 11 (e é atrapalhado por quem está nele)';
/** Último canal padrão de 2,4 GHz: acima dele não há "dois lados". */
const LAST_STANDARD_24 = 11;
const NOTE_40_IN_24 = 'Em 2,4 GHz, 40 MHz ocupam cerca de metade da faixa: só vale a pena sem vizinhos por perto';
const NOTE_DFS_BLOCK =
  'Parte deste bloco usa canais DFS (divididos com radares): o roteador pode demorar a entrar no ar ou mudar de canal sozinho';
const NOTE_NOT_PSC = 'Fora dos canais preferenciais (PSC): alguns aparelhos demoram a encontrar a rede';
const NOTE_UNII4 = 'Usa a faixa U-NII-4 (5,9 GHz), que poucos roteadores e aparelhos aceitam';
const NOTE_SELF_LOAD = 'A ocupação medida neste canal inclui o tráfego da sua própria rede';

function normBand(band) {
  const s = band == null ? '' : String(band).trim().replace(',', '.');
  return s === '2.4' || s === '5' || s === '6' ? s : null;
}

/**
 * As funções públicas aceitam a faixa dos dois jeitos: f(aps, { band, ... }) ou
 * f(aps, band, { ... }). Devolve sempre o objeto de opções com `band` dentro.
 */
function withBand(second, third) {
  if (isObj(second)) return second;
  return { ...(isObj(third) ? third : {}), band: second };
}

function bssidSet(list) {
  const out = new Set();
  if (list == null) return out;
  const items = typeof list === 'string' ? [list] : typeof list[Symbol.iterator] === 'function' ? list : [];
  for (const item of items) {
    const id = normalizeBssid(isObj(item) ? item.bssid : item);
    if (id) out.add(id);
  }
  return out;
}

/** Lista normalizada, com cada BSSID uma vez só (repetido contaria como dois vizinhos). */
const toAps = asApList;

/** Peso de uma leitura conforme a idade: 1 até 30 s, depois cai pela metade a cada 30 s. */
function freshness(ageMs) {
  if (!isNum(ageMs) || ageMs <= STALE_AFTER_MS) return 1;
  return Math.pow(0.5, (ageMs - STALE_AFTER_MS) / STALE_HALF_LIFE_MS);
}

// Enlace de referência por largura (sinal, piso de ruído e capacidade sem interferência): são
// sempre os mesmos números, e esta conta roda para cada vizinho de cada canal.
const REFERENCE_LINK = new Map();

function referenceLink(widthMHz) {
  let ref = REFERENCE_LINK.get(widthMHz);
  if (!ref) {
    const signal = dbmToMw(REFERENCE_SIGNAL_DBM);
    const floor = dbmToMw(noiseFloorDbm(widthMHz));
    ref = { signal, floor, clean: Math.log2(1 + signal / floor) };
    REFERENCE_LINK.set(widthMHz, ref);
  }
  return ref;
}

/** Fração da capacidade que o enlace de referência mantém com `mw` de ruído extra na banda. */
function capacityKept(mw, widthMHz) {
  const ref = referenceLink(widthMHz);
  return Math.log2(1 + ref.signal / (ref.floor + mw)) / ref.clean;
}

/** `devices` tem o formato de groupByDevice()? (Só então pode entrar no lugar do agrupamento.) */
function usableDevices(devices) {
  if (!Array.isArray(devices)) return null;
  for (const d of devices) if (!isObj(d) || !Array.isArray(d.aps) || !Array.isArray(d.bssids)) return null;
  return devices;
}

/**
 * Qual rede representa o rádio (é a que aparece como "quem mais interfere"): a de sinal mais
 * forte; no empate, a que tem nome antes da oculta e, por fim, o menor BSSID. Sem o desempate a
 * resposta dependeria da ordem em que o celular entregou a lista.
 */
function leadsOver(a, b) {
  if (a.rssi !== b.rssi) return a.rssi > b.rssi;
  if (a.hidden !== b.hidden) return b.hidden === true;
  return a.id < b.id;
}

/** Um rádio vizinho: as redes do mesmo aparelho na mesma frequência, resumidas no que a nota usa. */
function makeRadio(members) {
  let lead = members[0];
  let stations = null;
  let utilization = null;
  let weight = 0;
  for (const m of members) {
    const ap = m.ap;
    if (leadsOver(ap, lead.ap)) lead = m;
    if (isNum(ap.stations)) stations = (stations ?? 0) + ap.stations;
    if (isNum(ap.utilization)) utilization = Math.max(utilization ?? 0, ap.utilization);
    weight = Math.max(weight, freshness(ap.ageMs));
  }
  const base = stations === null ? DEFAULT_DUTY : IDLE_DUTY + DUTY_PER_STATION * stations;
  return {
    ap: lead.ap,
    channel: lead.ap.channel,
    rssi: lead.ap.rssi,
    occ: lead.occ,
    mw: dbmToMw(lead.ap.rssi),
    duty: Math.min(MAX_DUTY, base + EXTRA_NETWORK_DUTY * (members.length - 1)),
    utilization,
    weight,
    first: members[0].pos,
  };
}

/**
 * Ordem fixa dos rádios: pelo BSSID da rede que representa cada um (a posição na lista só
 * desempata endereços inválidos). Com ela, as somas e os empates da nota não mudam com a ordem
 * em que o celular entregou a lista.
 */
function radioOrder(a, b) {
  return a.ap.id < b.ap.id ? -1 : a.ap.id > b.ap.id ? 1 : a.first - b.first;
}

// Os APs de uma faixa já separados em rádios, ainda sem tirar ninguém da conta. Fica guardado
// por lista de aparelhos (groupByDevice): quem avalia vários roteadores da mesma lista
// (best-network avalia todos, a cada varredura) reaproveita em vez de refazer a cada chamada.
const BAND_BASE = new WeakMap(); // devices -> Map(faixa -> base)

function sameItems(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bandBase(all, band, devices) {
  let perBand = BAND_BASE.get(devices);
  if (!perBand) {
    perBand = new Map();
    BAND_BASE.set(devices, perBand);
  }
  const known = perBand.get(band);
  if (known && sameItems(known.all, all)) return known;

  const deviceOf = new Map();
  for (const device of devices) for (const ap of device.aps) deviceOf.set(ap, device.id);

  const inBand = []; // todos os APs da faixa, na ordem da lista
  const groups = new Map(); // "aparelho|frequência" -> membros
  for (const ap of all) {
    if (ap.band !== band) continue;
    // `audible` = entra como vizinho: tem sinal medido e ocupa algum trecho do espectro
    const audible = isNum(ap.rssi) && ap.occ.segments.length > 0;
    const segments = audible ? segmentsOf(ap.occ) : [];
    const entry = { ap, pos: inBand.length, audible, segments, occ: { segments }, group: null };
    inBand.push(entry);
    if (!audible) continue;
    const device = deviceOf.get(ap);
    // AP que o agrupamento não conhece é um rádio sozinho
    const key = device === undefined ? entry : `${device}|${ap.freq}`;
    let group = groups.get(key);
    if (!group) {
      group = { members: [], radio: null };
      groups.set(key, group);
    }
    group.members.push(entry);
    entry.group = group;
  }
  for (const group of groups.values()) group.radio = makeRadio(group.members);

  // A lista é copiada: se quem chamou alterar a dele depois, a comparação acima percebe
  const base = { all: all.slice(), inBand, groups: [...groups.values()].sort((a, b) => radioOrder(a.radio, b.radio)) };
  perBand.set(band, base);
  return base;
}

/**
 * Prepara a análise de uma faixa: separa as redes do usuário e junta os BSSIDs dos vizinhos em
 * rádios (mesmo aparelho, mesma frequência). `all` já normalizado; `excluded` = Set de BSSIDs
 * (já normalizados) que não contam como vizinhos; `devices` = groupByDevice(all).
 */
function buildContext(all, band, excluded, devices) {
  const base = bandBase(all, band, devices || groupByDevice(all));
  const own = [];
  const others = [];
  const touched = new Set(); // rádios que perderam alguma rede para a lista de exclusão
  for (const entry of base.inBand) {
    if (entry.ap.id && excluded.has(entry.ap.id)) {
      own.push(entry.ap);
      if (entry.group) touched.add(entry.group);
    } else if (entry.audible) others.push(entry);
  }

  // Os rádios já estão em ordem fixa (radioOrder) na base; só um rádio que perdeu parte das
  // redes pode ter mudado de representante, e aí a ordem é refeita.
  const radios = [];
  let reorder = false;
  for (const group of base.groups) {
    if (!touched.has(group)) {
      radios.push(group.radio);
      continue;
    }
    const left = group.members.filter((m) => !(m.ap.id && excluded.has(m.ap.id)));
    if (left.length) {
      radios.push(makeRadio(left));
      reorder = true;
    }
  }
  if (reorder) radios.sort(radioOrder);
  return { band, own, others, radios };
}

/** Avalia um bloco com um canal primário fixo. Devolve os números sem arredondar. */
function evaluate(ctx, block, primary, shares) {
  const width = block.widthMHz;
  const selfOnPrimary = ctx.own.some((ap) => ap.channel === primary);
  let airtimeLeft = 1;
  let noiseLeft = 1;
  let measured = null;
  let extra = 0;
  for (const { radio, mw } of shares) {
    if (radio.channel === primary && radio.rssi >= PREAMBLE_DETECT_DBM) {
      airtimeLeft *= 1 - radio.weight * radio.duty;
      if (radio.utilization !== null) {
        measured = Math.max(measured ?? 0, radio.utilization);
        extra = Math.max(extra, (radio.weight * (radio.utilization - radio.duty)) / (1 - radio.duty));
      }
      continue;
    }
    const x = 1 - capacityKept(mw, width);
    let loss = radio.duty * x * (1 + COLLISION_GAIN * x);
    // Mesmo canal, mas fraco demais para combinar a vez: nunca custa mais do que dividir
    if (radio.channel === primary) loss = Math.min(loss, radio.duty);
    noiseLeft *= 1 - Math.min(MAX_LOSS, radio.weight * loss);
  }
  // A ocupação que os vizinhos medem no canal em que o usuário já está inclui o tráfego dele
  // mesmo; usá-la seria punir o canal atual pelo próprio uso.
  if (!selfOnPrimary) airtimeLeft *= 1 - extra;
  const airtime = 1 - airtimeLeft;
  return { primary, capacity: airtimeLeft * noiseLeft, airtime, utilization: measured, selfOnPrimary };
}

/** Canais que podem ser o primário de um bloco, já na ordem de preferência. */
function primariesOf(band, block) {
  if (band === '6') {
    const psc = block.channels.filter((c) => PSC.has(c));
    if (psc.length) return psc;
  }
  if (band === '2.4' && block.widthMHz === 40) {
    const standard = block.channels.filter((c) => STANDARD_24.has(c));
    if (standard.length) return standard;
  }
  return block.channels;
}

function recommendable(band, block, primary) {
  if (band === '2.4') return STANDARD_24.has(primary);
  if (band === '5') return !block.channels.some((c) => c >= 169);
  return PSC.has(primary);
}

function notesFor(band, block, primary, result) {
  const notes = [];
  const add = (text) => {
    if (text && !notes.includes(text)) notes.push(text);
  };
  if (band === '2.4') {
    if (!STANDARD_24.has(primary)) add(primary > LAST_STANDARD_24 ? NOTE_ABOVE_STANDARD : NOTE_OFF_STANDARD);
    if (block.widthMHz >= 40) add(NOTE_40_IN_24);
  }
  add(CHANNEL_NOTE[band].get(primary));
  if (band === '5') {
    if (block.dfs && !notes.some((n) => n.startsWith('DFS'))) add(NOTE_DFS_BLOCK);
    if (block.channels.some((c) => c >= 169)) add(NOTE_UNII4);
  }
  if (band === '6' && !PSC.has(primary)) add(NOTE_NOT_PSC);
  if (result.selfOnPrimary && result.utilization !== null) add(NOTE_SELF_LOAD);
  return notes;
}

/**
 * Nota completa de um bloco. `only` fixa o canal primário; `prefer` é o primário que vence os
 * empates (o canal em que o usuário já está).
 */
function rateBlock(ctx, block, only, prefer) {
  const band = ctx.band;
  const shares = [];
  let total = 0;
  let busiest = null;
  for (const radio of ctx.radios) {
    const mw = radio.mw * interferenceFactor(radio.occ, block.lo, block.hi);
    if (!(mw >= NEGLIGIBLE_MW)) continue;
    shares.push({ radio, mw });
    total += radio.weight * mw;
    if (busiest === null || radio.weight * mw > busiest.mw) busiest = { radio, mw: radio.weight * mw };
  }

  let primaries = isNum(only) ? [only] : primariesOf(band, block);
  if (primaries.includes(prefer)) primaries = [prefer, ...primaries.filter((c) => c !== prefer)];
  let best = null;
  for (const primary of primaries) {
    const result = evaluate(ctx, block, primary, shares);
    // Só troca por um primário de fato melhor: diferença de arredondamento não decide nada
    if (best === null || result.capacity > best.capacity + CAPACITY_TIE) best = result;
  }

  let coChannel = 0;
  let overlapping = 0;
  for (const other of ctx.others) {
    if (other.ap.channel === best.primary) coChannel += 1;
    else if (other.segments.some((seg) => seg.lo < block.hi && seg.hi > block.lo)) overlapping += 1;
  }

  return {
    band,
    channel: best.primary,
    center: block.center,
    centerFreq: block.centerFreq,
    lo: block.lo,
    hi: block.hi,
    widthMHz: block.widthMHz,
    channels: block.channels.slice(),
    score: round1(100 * best.capacity),
    interferenceDbm: total > 0 ? round1(mwToDbm(total)) : null,
    coChannel,
    overlapping,
    busiest: busiest
      ? { ssid: busiest.radio.ap.name, rssi: busiest.radio.rssi, bssid: busiest.radio.ap.id, channel: busiest.radio.channel }
      : null,
    utilization: best.utilization === null ? null : Math.round(best.utilization * 100) / 100,
    airtime: Math.round(best.airtime * 1000) / 1000,
    dfs: block.dfs,
    psc: band === '6' && PSC.has(best.primary),
    unii: block.unii,
    recommendable: recommendable(band, block, best.primary),
    notes: notesFor(band, block, best.primary, best),
  };
}

/**
 * Nota de cada canal possível de uma faixa, numa largura.
 *
 * 2,4 GHz: canais 1 a 13 (em 40 MHz, os nove pares primário + secundário). 5 e 6 GHz: cada
 * bloco da largura pedida (5 GHz em 80 MHz: 42, 58, 106, 122, 138, 155, 171).
 *
 * @param {import('./model.js').Ap[]} aps  lista do ApTracker (ou ScanAp crus)
 * @param {{band: '2.4'|'5'|'6', widthMHz?: number, exclude?: Iterable<string>, devices?: object[]}} options
 *        exclude = BSSIDs do próprio usuário, que não contam como interferência;
 *        devices = groupByDevice(aps) já calculado para esta mesma lista (só poupa trabalho)
 *        (também vale rateChannels(aps, band, { widthMHz, exclude, devices }))
 * @returns {{
 *   band: string,
 *   channel: number,            canal primário (o melhor dentro do bloco; nos 6 GHz, um PSC)
 *   center: number,             número do canal central do bloco (ex.: 42)
 *   centerFreq: number, lo: number, hi: number, widthMHz: number,
 *   channels: number[],         canais de 20 MHz do bloco
 *   score: number,              0..100 (100 = livre), uma casa decimal
 *   interferenceDbm: number|null,  potência somada dos vizinhos dentro do bloco (null = nenhuma)
 *   coChannel: number,          redes com o mesmo canal primário
 *   overlapping: number,        redes com outro primário que invadem o bloco
 *   busiest: {ssid:string, rssi:number, bssid:string, channel:number}|null,  quem mais interfere
 *   utilization: number|null,   maior ocupação medida por quem está no canal (BSS Load), 0..1
 *   airtime: number,            fração do tempo tomada por quem divide o canal (T do modelo), 0..1
 *   dfs: boolean, psc: boolean, unii: string|null,
 *   recommendable: boolean,     passa na política (2,4 GHz: 1/6/11; 5 GHz: sem U-NII-4; 6 GHz: PSC)
 *   notes: string[]
 * }[]}  na ordem dos canais; [] se a faixa ou a largura não existirem
 */
export function rateChannels(aps, options, more) {
  const o = withBand(options, more);
  const band = normBand(o.band);
  const width = o.widthMHz === undefined || o.widthMHz === null ? 20 : Number(o.widthMHz);
  if (band === null) return [];
  const blocks = blocksOf(band, width);
  if (!blocks.length) return [];
  const ctx = buildContext(toAps(aps), band, bssidSet(o.exclude), usableDevices(o.devices));
  return blocks.map((block) => rateBlock(ctx, block));
}

// ---------------------------------------------------------------------------
// Recomendação
// ---------------------------------------------------------------------------

const policyScore = (r) => r.score - (r.dfs ? DFS_HANDICAP : 0);

function sameSpot(a, b) {
  return a !== null && b !== null && a.centerFreq === b.centerFreq && a.channel === b.channel;
}

/** Ordena pela política: nota (com a desvantagem do DFS), canal atual na frente em empates. */
function rank(ratings, current) {
  return ratings
    .filter((r) => r.recommendable)
    .sort(
      (a, b) =>
        policyScore(b) - policyScore(a) ||
        Number(sameSpot(b, current)) - Number(sameSpot(a, current)) ||
        Number(a.dfs) - Number(b.dfs) ||
        a.centerFreq - b.centerFreq,
    );
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** "canal 6", "canal 36 (80 MHz)"; com `flagDfs`, "canal 100 (80 MHz, DFS)". */
function channelName(r, flagDfs) {
  const tags = [];
  if (r.widthMHz > 20) tags.push(`${r.widthMHz} MHz`);
  if (flagDfs && r.dfs) tags.push('DFS');
  return `canal ${r.channel}${tags.length ? ` (${tags.join(', ')})` : ''}`;
}

function sharingText(r) {
  if (r.coChannel > 0) {
    const more = r.overlapping > 0 ? ` e que ainda recebe interferência de ${plural(r.overlapping, 'outra', 'outras')}` : '';
    return `que você divide com ${plural(r.coChannel, 'rede', 'redes')}${more}`;
  }
  if (r.overlapping > 0) return `que recebe interferência de ${plural(r.overlapping, 'rede', 'redes')} em canais sobrepostos`;
  // Ninguém dentro do canal, mas a nota pode ter caído pelo que vaza dos canais ao lado
  return r.score >= FREE_SCORE ? 'que está livre' : 'que recebe interferência dos canais ao lado';
}

/**
 * BSSIDs que não contam contra o roteador do usuário: ele mesmo, as outras redes da mesma caixa
 * e os outros nós do mesmo mesh que estão no mesmo canal (eles mudam de canal junto com ele;
 * contá-los faria qualquer outro canal parecer melhor sem ser).
 */
function ownBssids(devices, own) {
  const ids = new Set();
  if (!own || !own.id) return ids;
  ids.add(own.id);
  const family = (ap) => (isObj(ap.security) ? `${ap.security.enterprise}|${ap.security.personal}|${ap.security.open}` : '');
  const sameNetwork = (ap) =>
    !own.hidden && !ap.hidden && ap.ssid === own.ssid && ap.freq === own.freq && family(ap) === family(own);
  for (const device of devices) {
    if (device.bssids.includes(own.id) || device.aps.some(sameNetwork)) for (const id of device.bssids) ids.add(id);
  }
  return ids;
}

const DEFAULT_WIDTH = { '2.4': 20, 5: 80, 6: 80 };

/**
 * Lista normalizada (com o roteador do usuário, se ele não estiver nela) e os aparelhos dela.
 * `devices` (groupByDevice da mesma lista, já calculado) só vale se a lista não mudou aqui.
 */
function prepare(aps, own, devices) {
  let list = toAps(aps);
  let ready = usableDevices(devices);
  if (own && own.id && !list.some((ap) => ap.id === own.id)) {
    list = [...list, own]; // cópia: a lista pode ser a de quem chamou
    ready = null;
  }
  return { list, devices: ready || groupByDevice(list) };
}

/**
 * Nota do canal em que `own` está (bloco e primário dele), sem contar o próprio roteador.
 * Em 2,4 GHz/40 MHz e 6 GHz/320 MHz o mesmo primário cabe em dois blocos: vale o que o roteador usa.
 */
function currentRating(ctx, band, width, own) {
  let spots = blocksContaining(band, width, own.channel);
  const exact = spots.filter((b) => b.centerFreq === own.occ.centerFreq);
  if (exact.length) spots = exact;
  let current = null;
  for (const block of spots) {
    const rating = rateBlock(ctx, block, own.channel);
    if (current === null || rating.score > current.score) current = rating;
  }
  return current;
}

/** Largura a analisar: a pedida; senão a do roteador do usuário; senão o padrão da faixa. */
function widthFor(band, requested, own) {
  if (requested !== undefined && requested !== null) return Number(requested);
  return own && blocksOf(band, own.widthMHz).length ? own.widthMHz : DEFAULT_WIDTH[band];
}

/**
 * Nota do canal em que um roteador está hoje: o mesmo `current` de recommendChannel, sem avaliar
 * os outros canais (bem mais barato; é o que best-network usa para cada AP da lista).
 *
 * @param {import('./model.js').Ap[]} aps
 * @param {{own: import('./model.js').Ap, widthMHz?: number, devices?: object[]}} options
 *        own = o roteador avaliado (a faixa é a dele); widthMHz padrão: a largura dele;
 *        devices = groupByDevice(aps) já calculado para esta mesma lista (só poupa trabalho)
 * @returns {object|null}  uma linha no formato de rateChannels, ou null (roteador sem canal
 *          conhecido, faixa sem análise ou largura que não existe nela)
 */
export function rateOwnChannel(aps, options) {
  const o = isObj(options) ? options : {};
  const own = isObj(o.own) ? asAp(o.own) : null;
  const band = own === null ? null : normBand(own.band);
  if (band === null || !isNum(own.channel)) return null;
  const width = widthFor(band, o.widthMHz, own);
  if (!blocksOf(band, width).length) return null;
  const { list, devices } = prepare(aps, own, o.devices);
  const ctx = buildContext(list, band, ownBssids(devices, own), devices);
  return currentRating(ctx, band, width, own);
}

/**
 * Recomenda o canal para o roteador do usuário.
 *
 * Política: em 2,4 GHz todos os canais recebem nota, mas só 1, 6 e 11 são recomendados; em
 * 5 GHz ficam de fora os blocos com U-NII-4 e um canal DFS só vence um comum se for mais de
 * 5 pontos melhor; em 6 GHz só canais PSC. Com menos de 8 pontos de ganho, fica como está.
 *
 * @param {import('./model.js').Ap[]} aps
 * @param {{band: '2.4'|'5'|'6', widthMHz?: number, own?: import('./model.js').Ap|null, devices?: object[]}} options
 *        own = o Ap do roteador do usuário nesta faixa (ou null). widthMHz padrão: a largura
 *        dele; sem ele, 20 MHz em 2,4 GHz e 80 MHz em 5/6 GHz. devices = groupByDevice(aps) já
 *        calculado para esta mesma lista (só poupa trabalho).
 *        (Também vale recommendChannel(aps, band, { widthMHz, own, devices }).)
 * @returns {{
 *   best: object|null,        nota do melhor canal pela política (formato de rateChannels); com
 *                             'keep' pode ser outro canal que não o atual: é melhor, mas não o
 *                             bastante para compensar a troca
 *   current: object|null,     nota do canal atual, sem contar o próprio roteador (nem as outras
 *                             redes da mesma caixa, nem os nós do mesmo mesh no mesmo canal)
 *   ranking: object[],        os 5 melhores candidatos
 *   gain: number|null,        best.score − current.score (o veredito desconta 5 pontos de quem é DFS)
 *   verdict: 'keep'|'change', sem `own` é sempre 'change' (= "use o melhor")
 *   text: string              uma ou duas frases em português
 * }}
 */
export function recommendChannel(aps, options, more) {
  const o = withBand(options, more);
  const band = normBand(o.band);
  const own = isObj(o.own) ? asAp(o.own) : null;
  const ownHere = own !== null && own.band === band && isNum(own.channel) ? own : null;

  const width = band === null ? null : widthFor(band, o.widthMHz, ownHere);
  const blocks = band === null ? [] : blocksOf(band, width);
  if (!blocks.length) {
    return { best: null, current: null, ranking: [], gain: null, verdict: 'keep', text: 'Não há canais com essa largura nesta faixa.' };
  }

  const { list, devices } = prepare(aps, ownHere, o.devices);
  const ctx = buildContext(list, band, ownBssids(devices, ownHere), devices);
  const ratings = blocks.map((block) => rateBlock(ctx, block, null, ownHere ? ownHere.channel : null));
  const current = ownHere ? currentRating(ctx, band, width, ownHere) : null;

  const ranking = rank(ratings, current);
  let best = ranking[0] || null;
  if (best === null) {
    return { best: null, current, ranking: [], gain: null, verdict: 'keep', text: 'Nenhum canal desta faixa pode ser recomendado.' };
  }
  // O canal atual empata com o melhor: é ele o melhor
  if (current !== null && current.recommendable && policyScore(current) >= policyScore(best)) best = current;

  const top = ranking.slice(0, 5);
  if (current === null) {
    const text =
      best.score >= FREE_SCORE
        ? `O ${channelName(best, true)} está livre: é a melhor escolha agora.`
        : `O ${channelName(best, true)} é o menos disputado agora (nota ${Math.round(best.score)} de 100).`;
    return { best, current: null, ranking: top, gain: null, verdict: 'change', text };
  }

  const gain = round1(best.score - current.score);
  const advantage = policyScore(best) - policyScore(current);
  const where = `Seu roteador está no ${channelName(current)}, ${sharingText(current)}.`;
  const offStandard = band === '2.4' && !current.recommendable && advantage >= -OFF_STANDARD_TOLERANCE;

  if (sameSpot(best, current) || (advantage < KEEP_MARGIN && !offStandard)) {
    const tail =
      current.score >= FREE_SCORE
        ? 'Pode deixar como está.'
        : 'Nenhum outro canal está claramente melhor: pode deixar como está.';
    return { best, current, ranking: top, gain, verdict: 'keep', text: `${where} ${tail}` };
  }
  if (advantage < KEEP_MARGIN) {
    // Só chega aqui quem está fora do trio 1/6/11 sem ganhar nada com isso
    const text =
      current.channel > LAST_STANDARD_24
        ? `Seu roteador está no canal ${current.channel}, acima dos canais padrão: ali ele ainda invade o canal ${LAST_STANDARD_24} ` +
          `e alguns aparelhos importados não o enxergam. Prefira o canal ${best.channel}.`
        : `Seu roteador está no canal ${current.channel}, que fica entre os canais padrão: ali ele atrapalha, ` +
          `e é atrapalhado por, quem usa os canais dos dois lados. Prefira o canal ${best.channel}.`;
    return { best, current, ranking: top, gain, verdict: 'change', text };
  }
  const better = gain >= 25 ? 'bem mais livre' : 'mais livre';
  return { best, current, ranking: top, gain, verdict: 'change', text: `${where} O ${channelName(best, true)} está ${better}.` };
}

/** A maior largura que o roteador anuncia saber usar (IeSummary.maxWidthMHz); null quando o celular não entrega os elementos. */
function announcedWidth(own) {
  return own && isObj(own.ie) && isNum(own.ie.maxWidthMHz) ? own.ie.maxWidthMHz : null;
}

/**
 * Maior largura que o roteador consegue usar na faixa.
 * Em 5 e 6 GHz vale o que ele anuncia no beacon (nunca menos do que já usa): a geração sozinha
 * promete demais — a maioria dos roteadores Wi-Fi 5/6 de operadora só vai até 80 MHz. Sem os
 * elementos do beacon (Android antigo), e em 2,4 GHz (onde 40 MHz quase nunca é recomendado e o
 * bit de 40 MHz costuma só refletir a configuração), fica o teto da geração.
 */
function widthCap(band, own) {
  const top = band === '2.4' ? 40 : band === '5' ? 160 : 320;
  if (!own) return top;
  const announced = band === '2.4' ? null : announcedWidth(own);
  if (announced !== null) return Math.min(top, Math.max(announced, isNum(own.widthMHz) ? own.widthMHz : 0, 20));
  if (!isNum(own.gen)) return top;
  if (own.gen <= 4) return Math.min(top, 40);
  if (own.gen <= 6) return Math.min(top, 160);
  return top;
}

const BAND_NAME = { '2.4': '2,4 GHz', 5: '5 GHz', 6: '6 GHz' };

/**
 * Recomenda a largura de canal.
 *
 * 2,4 GHz: 20 MHz, a não ser que a faixa esteja praticamente vazia. 5 e 6 GHz: a maior largura
 * que ainda tem um bloco com nota boa (≥ 60 em 40 MHz, 70 em 80, 80 em 160, 85 em 320).
 *
 * @param {import('./model.js').Ap[]} aps
 * @param {'2.4'|'5'|'6'} band
 * @param {{own?: import('./model.js').Ap|null, devices?: object[]}} [options]  own = o roteador do
 *        usuário nesta faixa: sai da conta da interferência e limita a largura ao que ele anuncia
 *        saber usar (sem os elementos do beacon, ao que a geração dele alcança); devices =
 *        groupByDevice(aps) já calculado para esta mesma lista
 *        (também vale recommendWidth(aps, { band, own, devices }), como nas outras funções)
 * @returns {{widthMHz: number|null, text: string,
 *            options: {widthMHz:number, score:number, channel:number, dfs:boolean}[]}}
 *          `options` = o melhor bloco de cada largura, da maior para a menor. O texto só manda
 *          ("Use N MHz") manter ou estreitar a largura de hoje; mais largo vem como possibilidade.
 */
export function recommendWidth(aps, band, options) {
  const o = withBand(band, options);
  const b = normBand(o.band);
  if (b === null) return { widthMHz: null, text: 'Faixa desconhecida.', options: [] };
  const own = isObj(o.own) ? asAp(o.own) : null;
  const ownHere = own !== null && own.band === b ? own : null;
  const { list, devices } = prepare(aps, ownHere, o.devices);
  const ctx = buildContext(list, b, ownBssids(devices, ownHere), devices);
  const cap = widthCap(b, ownHere);

  const table = [];
  for (const width of [320, 160, 80, 40, 20]) {
    if (width > cap) continue;
    const best = rank(blocksOf(b, width).map((block) => rateBlock(ctx, block)), null)[0];
    if (best) table.push({ widthMHz: width, score: best.score, channel: best.channel, dfs: best.dfs });
  }
  const neighbours = ctx.others.length;
  const crowd = neighbours === 0 ? 'não há redes vizinhas' : `há ${plural(neighbours, 'rede vizinha', 'redes vizinhas')}`;
  const pick = table.find((t) => t.widthMHz > 20 && t.score >= (b === '2.4' ? NEARLY_EMPTY_SCORE : GOOD_SCORE[t.widthMHz]));

  if (!pick) {
    const text =
      b === '2.4'
        ? `Use 20 MHz: ${crowd} em 2,4 GHz e um canal de 40 MHz ocuparia cerca de metade da faixa.`
        : `Use 20 MHz: ${crowd} em ${BAND_NAME[b]} e os canais mais largos pegariam interferência demais.`;
    return { widthMHz: 20, text, options: table };
  }
  if (b === '2.4') {
    return { widthMHz: 40, text: 'A faixa de 2,4 GHz está praticamente vazia aqui: dá para usar 40 MHz.', options: table };
  }
  // DFS com a consequência dita: não é só uma sigla
  const dfs = pick.dfs ? ' Esse bloco usa canais DFS, divididos com radares: o roteador pode demorar a entrar no ar ou trocar de canal sozinho.' : '';
  const block = `o bloco do canal ${pick.channel} está livre o bastante (nota ${Math.round(pick.score)} de 100)`;
  // "Use N MHz" é uma ordem: só vale para manter ou estreitar a largura de hoje. Mais largo do que
  // o roteador usa (ou, sem saber qual é o roteador, mais do que os 80 MHz que todo roteador de
  // 5/6 GHz tem) é uma possibilidade, e depende de o roteador e os aparelhos aceitarem.
  const usedNow = ownHere && isNum(ownHere.widthMHz) ? ownHere.widthMHz : DEFAULT_WIDTH[b];
  if (pick.widthMHz > usedNow) {
    const announced = announcedWidth(ownHere);
    const condition =
      announced !== null && announced >= pick.widthMHz
        ? 'O seu roteador anuncia essa largura; para aproveitar, os aparelhos também precisam aceitar.'
        : 'Só vale se o roteador e os aparelhos aceitarem essa largura.';
    return { widthMHz: pick.widthMHz, text: `Há espaço para ${pick.widthMHz} MHz: ${block}. ${condition}${dfs}`, options: table };
  }
  return { widthMHz: pick.widthMHz, text: `Use ${pick.widthMHz} MHz: ${block}.${dfs}`, options: table };
}

// ---------------------------------------------------------------------------
// Gráfico de canais
// ---------------------------------------------------------------------------

const GRAPH_FLOOR_DBM = -100;
const GRAPH_RANGE = {
  '2.4': { min: 2400, max: 2484, sections: [[2400, 2484]] },
  5: { min: 5150, max: 5850, sections: [[5150, 5350], [5470, 5730], [5730, 5850]] },
  6: { min: 5925, max: 7125, sections: [[5925, 7125]] },
};

/** Contorno de um canal: o formato da máscara espectral, do pé esquerdo ao pé direito. */
function maskOutline(center, width, rssi) {
  const top = width / 2 - 1;
  if (rssi <= GRAPH_FLOOR_DBM) return [[center - top, GRAPH_FLOOR_DBM], [center + top, GRAPH_FLOOR_DBM]];
  // Joelhos da máscara do 802.11 (veja maskDb): W/2 − 1, W/2 + 1, W e 1,5·W; depois segue caindo
  const side = [[top, rssi]];
  for (const x of [width / 2 + 1, width, 1.5 * width, 3 * width, 6 * width]) {
    const [px, py] = side[side.length - 1];
    const y = rssi + maskDb(x, width);
    if (y <= GRAPH_FLOOR_DBM) {
      side.push([px + ((x - px) * (py - GRAPH_FLOOR_DBM)) / (py - y), GRAPH_FLOOR_DBM]);
      break;
    }
    side.push([x, y]);
  }
  const points = [];
  for (let i = side.length - 1; i >= 0; i--) points.push([round1(center - side[i][0]), round1(side[i][1])]);
  for (const [x, y] of side) points.push([round1(center + x), round1(y)]);
  return points;
}

/**
 * Dados para desenhar o gráfico clássico de canais: cada rede vira uma "montanha" com o
 * formato da máscara espectral, da largura do canal dela e da altura do sinal.
 *
 * @param {import('./model.js').Ap[]} aps
 * @param {'2.4'|'5'|'6'} band  (também vale channelGraph(aps, { band }))
 * @returns {{
 *   band: string|null,
 *   minFreq: number, maxFreq: number,    limites do eixo X (MHz)
 *   minDbm: number, maxDbm: number,      limites do eixo Y (dBm); o pé das montanhas fica em minDbm
 *   sections: {minFreq:number, maxFreq:number}[],  trechos com canais (os 5 GHz têm um buraco no meio)
 *   ticks: {freq:number, channel:number, dfs:boolean, psc:boolean}[],
 *   shapes: {bssid:string, ssid:string, hidden:boolean, rssi:number, channel:number|null, widthMHz:number,
 *            lo:number, hi:number, centerFreq:number, approx:boolean, points:number[][]}[]
 * }}  `shapes` vem do sinal mais fraco para o mais forte (ordem de desenho); um AP 80+80 gera
 *     duas formas; `points` = [[MHz, dBm], ...]
 */
export function channelGraph(aps, band) {
  const b = normBand(withBand(band).band);
  if (b === null) {
    return { band: null, minFreq: 0, maxFreq: 0, minDbm: GRAPH_FLOOR_DBM, maxDbm: -20, sections: [], ticks: [], shapes: [] };
  }
  const range = GRAPH_RANGE[b];
  let minFreq = range.min;
  let maxFreq = range.max;
  let strongest = -Infinity;
  const shapes = [];
  for (const ap of toAps(aps)) {
    // Sinal fora do plausível (lixo num Ap montado à mão) não vira montanha nem estica o eixo
    if (ap.band !== b || sanitizeRssi(ap.rssi) === null) continue;
    for (const seg of segmentsOf(ap.occ)) {
      const width = seg.hi - seg.lo;
      const centerFreq = (seg.lo + seg.hi) / 2;
      minFreq = Math.min(minFreq, seg.lo);
      maxFreq = Math.max(maxFreq, seg.hi);
      strongest = Math.max(strongest, ap.rssi);
      shapes.push({
        bssid: ap.id,
        ssid: ap.name,
        hidden: ap.hidden,
        rssi: ap.rssi,
        channel: ap.channel,
        widthMHz: ap.widthMHz,
        lo: seg.lo,
        hi: seg.hi,
        centerFreq,
        approx: ap.occ.approx,
        points: maskOutline(centerFreq, width, ap.rssi),
      });
    }
  }
  shapes.sort((x, y) => x.rssi - y.rssi || (x.bssid < y.bssid ? -1 : 1));

  const ticks = channelList(b, { all: true })
    .filter((c) => c.freq - 10 >= minFreq && c.freq + 10 <= maxFreq)
    .map((c) => ({ freq: c.freq, channel: c.channel, dfs: c.dfs, psc: c.psc }));
  const sections = range.sections.map(([lo, hi], i, all) => ({
    minFreq: i === 0 ? minFreq : lo,
    maxFreq: i === all.length - 1 ? maxFreq : hi,
  }));
  return {
    band: b,
    minFreq,
    maxFreq,
    minDbm: GRAPH_FLOOR_DBM,
    maxDbm: Math.max(-30, Math.ceil((strongest + 5) / 10) * 10),
    sections,
    ticks,
    shapes,
  };
}
