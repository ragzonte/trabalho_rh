// Simulador da ponte: responde a todos os métodos de bridge.js no navegador, nos testes e
// no "modo demonstração" do app, usando o mundo de rádio simulado (world.js).
//
// O que sai daqui tem de ter a MESMA FORMA do que o Android manda (mesmos campos, tipos e
// unidades; campo opcional ausente em vez de null): todas as telas e todos os testes de
// ponta a ponta são desenvolvidos contra este arquivo. tests/helpers/contract.mjs confere.
//
// Tempo. Há dois relógios:
//   - o do "celular" (clock.now(), ms desde 1970): é o `ts` dos eventos, o mesmo relógio
//     que a página lê com Date.now();
//   - o tempo simulado (segundos desde que o simulador nasceu): é nele que a pessoa
//     virtual anda, as varreduras demoram ~2,5 s e o limite do Android conta 2 minutos.
// `speed` é quantos segundos simulados passam por segundo de relógio. Com speed = 10 tudo
// acontece dez vezes mais rápido — e, como os eventos são datados pelo relógio do
// celular, a interface vê uma pessoa que anda (e um celular que varre) dez vezes mais
// depressa; as idades (`ageMs`) encolhem na mesma proporção para continuar coerentes.
//
// Com um relógio injetado ({now, setTimeout, clearTimeout}; veja createManualClock) nada
// depende do relógio de verdade: o teste avança o tempo e a mesma semente gera sempre a
// mesma sequência de eventos.

import { estimateLink } from '../core/phy.js';
import { PHONE, describeAps, hostileNeighbours, householdOf, iesAt, networkOf, savedNetworks } from './demo-data.js';
import { presetSpec, randomSpec } from './presets.js';
import { createRng, hashGaussian, hashSeed, hashUniform } from './prng.js';
import { createWalker, WALK_MODES } from './walker.js';
import { createWorld } from './world.js';

/** Versão que o simulador informa em info().appVersion. */
export const APP_VERSION = '1.0.0';

/** Motivos com que scan() recusa uma varredura (campo `reason`). */
export const SCAN_REFUSAL = Object.freeze({
  PERMISSION: 'permission',
  LOCATION: 'location',
  WIFI: 'wifi',
  THROTTLED: 'throttled',
});

const SIM_TICK_MS = 250; // evento 'sim': 4 vezes por segundo de relógio
const MAX_JUMP_S = 120; // aba em segundo plano: ao voltar, o mundo não tenta recuperar o atraso
const EPS = 1e-7;
const MIN_SPEED = 0.1;
const MAX_SPEED = 60;
const THROTTLE_MAX = 4; // limite do Android: 4 varreduras...
const THROTTLE_WINDOW_S = 120; // ...a cada 2 minutos
const PING_INTERVAL_S = 1;
const LAN_HOSTS = 254;
const REDACTED_BSSID = '02:00:00:00:00:00'; // o que o Android informa sem a permissão de localização

let live = null;

/** Controles do simulador em uso (o mesmo objeto de createSimBackend().sim), ou null. */
export function currentSim() {
  return live;
}

// ---------------------------------------------------------------------------
// Relógio manual
// ---------------------------------------------------------------------------

/**
 * Relógio que só anda quando mandam: para testes determinísticos.
 * @param {number} [startMs]  "agora" inicial, em ms desde 1970
 * @returns {{now:()=>number, setTimeout:Function, clearTimeout:Function, advance:(ms:number)=>void,
 *            advanceAsync:(ms:number)=>Promise<void>, pending:()=>number}}
 */
export function createManualClock(startMs = Date.UTC(2026, 0, 15, 12, 0, 0)) {
  let now = startMs;
  let serial = 0;
  const timers = new Map();
  const nextDue = (limit) => {
    let best = null;
    for (const t of timers.values()) {
      if (t.at <= limit && (best === null || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t;
    }
    return best;
  };
  const fire = (t) => {
    timers.delete(t.id);
    if (t.at > now) now = t.at;
    t.fn();
  };
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++serial;
      timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** Avança o relógio disparando, em ordem, tudo o que vencer no caminho. */
    advance(ms) {
      const end = now + Math.max(0, ms);
      for (let t = nextDue(end); t; t = nextDue(end)) fire(t);
      now = end;
    },
    /** Igual a advance, mas deixa as Promises pendentes andarem entre um disparo e outro. */
    async advanceAsync(ms) {
      const end = now + Math.max(0, ms);
      for (let t = nextDue(end); t; t = nextDue(end)) {
        fire(t);
        for (let i = 0; i < 4; i++) await Promise.resolve();
      }
      now = end;
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
    /** Quantos temporizadores estão armados. */
    pending: () => timers.size,
  };
}

// ---------------------------------------------------------------------------
// Ajudas
// ---------------------------------------------------------------------------

// As opções podem vir da URL (?throttle=1&speed=10), então texto também vale.
function toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'string') return !/^(0|false|off|no|nao|não)$/i.test(v.trim());
  return !!v;
}

function toNum(v, fallback) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function toInt(v, min, max, fallback) {
  const n = Math.round(toNum(v, fallback));
  return Math.min(max, Math.max(min, n));
}

const toSpeed = (v, fallback) => Math.min(MAX_SPEED, Math.max(MIN_SPEED, toNum(v, fallback)));
const toSeed = (v, fallback) => Math.round(toNum(v, fallback)) || fallback;
const toPermission = (v, fallback) => (v === 'granted' || v === 'denied' || v === 'blocked' ? v : fallback);
const round1 = (v) => Math.round(v * 10) / 10;
const round3 = (v) => Math.round(v * 1000) / 1000 + 0; // "+ 0" evita o -0, que não existe em JSON

function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
}

// Fila de temporizadores em tempo simulado: o mais próximo primeiro; empate = ordem de criação.
const before = (a, b) => a.at < b.at || (a.at === b.at && a.seq < b.seq);

function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!before(heap[i], heap[p])) break;
    [heap[p], heap[i]] = [heap[i], heap[p]];
    i = p;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && before(heap[l], heap[m])) m = l;
      if (r < heap.length && before(heap[r], heap[m])) m = r;
      if (m === i) break;
      [heap[m], heap[i]] = [heap[i], heap[m]];
      i = m;
    }
  }
  return top;
}

/** WifiInfo.SECURITY_TYPE_* com que um celular atual entraria numa rede com estas capabilities. */
function securityTypeOf(capabilities) {
  if (/SAE/.test(capabilities)) return 4; // rede de transição: quem sabe WPA3 entra por SAE
  if (/SUITE[-_]B[-_]192/.test(capabilities)) return 5;
  if (/EAP/.test(capabilities)) return 3;
  if (/OWE/.test(capabilities)) return 6;
  if (/PSK/.test(capabilities)) return 2;
  if (/WEP/.test(capabilities)) return 1;
  return 0;
}

// WIFI_STANDARD_* -> geração (o 8 do Android é o Wi-Fi 7; 1 = a/b/g).
const genOfStandard = (standard) => ({ 1: 3, 4: 4, 5: 5, 6: 6, 8: 7 })[standard] ?? 4;

function parseIpv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

const isPrivateIp = (p) =>
  p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);

function decodeBase64(text) {
  try {
    const bin = atob(text.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Cópia para a área de transferência pelo caminho antigo (funciona sem pedir permissão
// quando há um toque do usuário por trás).
function legacyCopy(text) {
  if (typeof document !== 'object' || !document || !document.body || typeof document.execCommand !== 'function') return false;
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return !!ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Simulador
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SimOptions
 * @property {(name:string, data:any) => void} emit  por onde saem os eventos (obrigatório)
 * @property {string|object} [world]   id de um mundo pronto ('apartamento', 'sobrado', 'escritorio', 'kitnet'),
 *           'sorteada' (casa sorteada pela semente) ou um WorldSpec. Padrão: 'apartamento'
 * @property {number|string} [seed]    padrão 1
 * @property {number|string} [speed]   escala do tempo (0,1 a 60); padrão 1
 * @property {boolean|string} [throttle]  imita o limite de 4 varreduras a cada 2 minutos; padrão false
 * @property {'granted'|'denied'|'blocked'} [permission]  padrão 'granted'
 * @property {'granted'|'denied'|'blocked'} [permissionReply]  o que o "usuário" responde ao pedido; padrão 'granted'
 * @property {boolean|string} [wifi]      padrão true
 * @property {boolean|string} [location]  padrão true
 * @property {boolean|string} [hostile]   acrescenta os vizinhos de nome hostil; padrão true
 * @property {'auto'|'still'|'manual'} [walk]  o que a pessoa virtual faz; padrão 'auto'
 * @property {{now:()=>number, setTimeout:Function, clearTimeout:Function}} [clock]
 */

/**
 * Cria o simulador.
 * @param {SimOptions} options
 * @returns {{call:(method:string, args?:object)=>any, callAsync:(method:string, args?:object)=>Promise<any>,
 *            dispose:()=>void, sim:object}}
 */
export function createSimBackend(options = {}) {
  const emitOut = options.emit;
  if (typeof emitOut !== 'function') throw new TypeError('createSimBackend: falta emit(nome, dados)');
  const clock = options.clock && typeof options.clock.now === 'function' && typeof options.clock.setTimeout === 'function' ? options.clock : defaultClock();
  const hostile = toBool(options.hostile, true);
  let seed = toSeed(options.seed, 1);
  let speed = toSpeed(options.speed, 1);
  let disposed = false;

  const state = {
    wifi: toBool(options.wifi, true),
    location: toBool(options.location, true),
    permission: toPermission(options.permission, 'granted'),
    throttle: toBool(options.throttle, false),
    permissionReply: toPermission(options.permissionReply, 'granted'),
  };
  let denials = 0; // o Android 11+ para de perguntar depois da segunda recusa
  /** O que os métodos "de aparelho" fizeram por último (para a demonstração e para os testes). */
  const device = { keepAwake: false, bars: null, vibrations: 0, lastVibrateMs: 0, lastShare: null, lastFile: null };

  const report = (err) => {
    if (typeof console === 'object' && console && typeof console.error === 'function') console.error('[sim]', err);
  };

  function emit(name, data) {
    if (disposed) return;
    try {
      emitOut(name, data);
    } catch (err) {
      report(err);
    }
  }

  const nowMs = () => Math.round(clock.now());

  // --- tempo simulado e temporizadores -------------------------------------

  let simT = 0;
  let lastReal = clock.now();
  let syncing = false;
  const timers = [];
  let timerSeq = 0;
  let wake = null; // temporizador de verdade armado para o próximo vencimento
  let ticker = null;

  /** Agenda `fn` para daqui a `delayS` segundos simulados. */
  function after(delayS, fn) {
    const t = { at: simT + Math.max(0, delayS), seq: ++timerSeq, fn, dead: disposed };
    if (!disposed) heapPush(timers, t);
    return t;
  }

  function cancel(t) {
    if (t) t.dead = true;
  }

  // Traz o tempo simulado até o relógio, disparando no caminho o que venceu. Dentro de
  // cada disparo o "agora" é o instante exato em que ele estava marcado.
  function sync() {
    if (syncing || disposed) return;
    const real = clock.now();
    let dt = ((real - lastReal) * speed) / 1000;
    lastReal = real;
    if (!(dt > 0)) dt = 0;
    if (dt > MAX_JUMP_S) dt = MAX_JUMP_S;
    const target = simT + dt;
    syncing = true;
    try {
      while (timers.length && timers[0].at <= target + EPS) {
        const t = heapPop(timers);
        if (t.dead) continue;
        if (t.at > simT) simT = t.at;
        try {
          t.fn();
        } catch (err) {
          report(err);
        }
        if (disposed) return;
      }
    } finally {
      syncing = false;
    }
    if (target > simT) simT = target;
  }

  function arm() {
    if (syncing || disposed) return;
    while (timers.length && timers[0].dead) heapPop(timers);
    if (!timers.length) {
      if (wake) clock.clearTimeout(wake.id);
      wake = null;
      return;
    }
    const at = timers[0].at;
    if (wake && wake.at === at && wake.speed === speed) return;
    if (wake) clock.clearTimeout(wake.id);
    // Arredonda para cima: acordar um instante depois é melhor do que antes da hora.
    const ms = Math.max(0, Math.ceil(((at - simT) / speed) * 1000));
    wake = { at, speed, id: clock.setTimeout(onWake, ms) };
  }

  function onWake() {
    wake = null;
    sync();
    arm();
  }

  /** Toda entrada vinda de fora passa por aqui: acerta o tempo antes e rearma depois. */
  function enter(fn) {
    sync();
    try {
      return fn();
    } finally {
      arm();
    }
  }

  // --- mundo -----------------------------------------------------------------

  let world = null;
  let worldId = '';
  let walker = null;
  let profiles = new Map();
  let net = null;
  let household = [];
  let saved = [];
  let order = new Map();
  let noise = 0; // semente dos sorteios deste mundo

  function buildWorld(ref, worldSeed) {
    if (ref && typeof ref === 'object') {
      // Mundo já montado: usa como está (sem os vizinhos hostis).
      if (typeof ref.scan === 'function') return { world: ref, id: ref.name || 'personalizado' };
      const spec = { ...ref, aps: [...(ref.aps || [])] };
      if (hostile) spec.aps.push(...hostileNeighbours(spec));
      return { world: createWorld(spec, worldSeed), id: ref.name || 'personalizado' };
    }
    const id = String(ref ?? 'apartamento');
    const spec = id === 'sorteada' ? randomSpec(worldSeed) : presetSpec(id, worldSeed);
    if (hostile) spec.aps.push(...hostileNeighbours(spec));
    return { world: createWorld(spec, worldSeed), id };
  }

  function installWorld(ref, worldSeed, mode) {
    const built = buildWorld(ref, worldSeed);
    seed = worldSeed;
    world = built.world;
    worldId = built.id;
    noise = hashSeed('wrx-sim', seed, worldId);
    walker = createWalker(world, { seed, mode, t: simT });
    profiles = describeAps(world);
    net = networkOf(world);
    household = householdOf(world, net, hostile);
    saved = savedNetworks(world);
    // O Android não entrega a lista em ordem de sinal nem com a rede da casa primeiro.
    order = new Map(world.aps.map((a) => [a.bssid, hashSeed('wrx-order', seed, a.bssid)]));
    cache = null;
    link = null;
    if (state.wifi) {
      sweep(simT); // o celular já estava ligado: a lista em cache nunca começa vazia
      roam(simT);
    }
  }

  // --- estado (Wi-Fi, localização, permissão, limite) -------------------------

  const canScan = () => state.wifi && state.location && state.permission === 'granted';
  // Sem permissão ou com a localização desligada o Android esconde o nome e o BSSID da rede conectada.
  const seesIdentity = () => state.location && state.permission === 'granted';

  function statusNow() {
    return {
      wifiEnabled: state.wifi,
      locationEnabled: state.location,
      permission: state.permission,
      throttled: state.throttle,
      canScan: canScan(),
    };
  }

  let reconnectTimer = null;
  let bootScanTimer = null;

  function applyState(patch) {
    const old = statusNow();
    const wifiBefore = state.wifi;
    if (patch.wifi !== undefined) state.wifi = toBool(patch.wifi, state.wifi);
    if (patch.location !== undefined) state.location = toBool(patch.location, state.location);
    if (patch.throttle !== undefined) state.throttle = toBool(patch.throttle, state.throttle);
    if (patch.permissionReply !== undefined) state.permissionReply = toPermission(patch.permissionReply, state.permissionReply);
    if (patch.permission !== undefined) {
      const next = toPermission(patch.permission, state.permission);
      if (next === 'denied' && state.permission !== 'denied') denials = 0;
      state.permission = next;
    }
    const now = statusNow();
    if (Object.keys(now).some((k) => now[k] !== old[k])) emit('status', now);
    if (state.wifi !== wifiBefore) {
      if (state.wifi) wifiUp();
      else wifiDown();
    }
    return now;
  }

  function wifiDown() {
    cancel(reconnectTimer);
    cancel(bootScanTimer);
    cancel(pendingScan);
    pendingScan = null;
    cache = null; // o Android esvazia a lista ao desligar o Wi-Fi
    link = null;
    if (lanOp) lanOp.finish();
    emit('connection', { connected: false });
  }

  function wifiUp() {
    // Ligou: o celular leva um instante para achar a rede da casa e fazer a primeira varredura.
    reconnectTimer = after(1.5, () => {
      if (roam(simT) || link) emit('connection', connectionAt(simT));
    });
    bootScanTimer = after(2.6, () => {
      if (!state.wifi || pendingScan) return;
      sweep(simT);
      if (canScan()) emit('scan', publish(simT, true, 'system'));
    });
  }

  // --- varreduras ------------------------------------------------------------

  /** Última lista, em unidades simuladas: {t, aps}. É também o "anterior" da próxima varredura. */
  let cache = null;
  let pendingScan = null;
  let scanSerial = 0;
  const accepted = []; // instantes das varreduras aceitas (para o limite do Android)

  function enrich(ap, heardAt) {
    const profile = profiles.get(ap.bssid);
    if (!profile) return { ...ap, ies: [] };
    const out = { ...ap, capabilities: profile.capabilities };
    if (profile.ftm) out.rttResponder = true;
    out.ies = iesAt(profile, heardAt);
    return out;
  }

  // Uma varredura de verdade no lugar (e ao longo do caminho) em que a pessoa está.
  function sweep(t) {
    const mid = walker.posAt(world.sweepWindow(t).mid);
    const raw = world.scan({ x: mid.x, y: mid.y, z: mid.z, heading: mid.heading, t, prev: cache, path: walker.posAt });
    // Leitura repetida da varredura anterior já vem completa; só as novas ganham os elementos do beacon.
    const aps = raw.map((ap) => (ap.ies ? ap : enrich(ap, t - ap.ageMs / 1000)));
    aps.sort((a, b) => (order.get(a.bssid) ?? 0) - (order.get(b.bssid) ?? 0));
    cache = { t, aps };
  }

  // A lista como a interface a recebe: as idades contam até "agora", no relógio do celular.
  function publish(t, fresh, source) {
    const aps = cache && canScan() ? cache.aps.map((a) => ({ ...a, ageMs: Math.max(0, Math.round((a.ageMs + (t - cache.t) * 1000) / speed)) })) : [];
    return { ts: nowMs(), fresh, source, aps };
  }

  function scanRefusal() {
    if (state.permission !== 'granted') return SCAN_REFUSAL.PERMISSION;
    if (!state.location) return SCAN_REFUSAL.LOCATION;
    if (!state.wifi) return SCAN_REFUSAL.WIFI;
    return null;
  }

  function requestScan() {
    const reason = scanRefusal();
    if (reason) return { accepted: false, reason };
    while (accepted.length && accepted[0] <= simT - THROTTLE_WINDOW_S) accepted.shift();
    if (state.throttle && accepted.length >= THROTTLE_MAX) {
      // Como no Android: o pedido é recusado, não gasta a cota e a lista antiga chega marcada como velha.
      after(0.05, () => {
        if (canScan()) emit('scan', publish(simT, false, 'cache'));
      });
      return { accepted: false, reason: SCAN_REFUSAL.THROTTLED };
    }
    accepted.push(simT);
    // Pedido com uma varredura já em curso: aproveita a que está no ar.
    if (!pendingScan) {
      const took = 2.45 + 0.3 * hashUniform(noise, 'scan', ++scanSerial);
      pendingScan = after(took, () => {
        pendingScan = null;
        if (!state.wifi) return;
        sweep(simT);
        if (canScan()) emit('scan', publish(simT, true, 'request'));
      });
    }
    return { accepted: true };
  }

  // O próprio Android varre de tempos em tempos; o app fica sabendo se tiver permissão.
  let systemRng = createRng('wrx-system-scan', seed);
  function scheduleSystemScan() {
    after(systemRng.float(30, 60), () => {
      scheduleSystemScan();
      if (!state.wifi || pendingScan) return;
      sweep(simT);
      if (canScan()) emit('scan', publish(simT, true, 'system'));
    });
  }

  // --- conexão ---------------------------------------------------------------

  /** Rádio (do mundo) em que o celular está associado; null = desconectado. */
  let link = null;

  // Escolhe o rádio como um celular: prefere o 5 GHz enquanto ele chega bem e é "grudento" —
  // só troca quando o sinal atual está ruim e existe outro bem melhor. Devolve true se trocou.
  function roam(t) {
    if (!saved.length) return false;
    const pos = walker.posAt(t);
    if (link && world.meanRssi(link, pos) >= -72) return false;
    const score = (a) => {
      const rssi = world.meanRssi(a, pos);
      return rssi + (a.band > 0 && rssi >= -72 ? 12 : 0);
    };
    let best = saved[0];
    let bestScore = score(best);
    for (let i = 1; i < saved.length; i++) {
      const s = score(saved[i]);
      if (s > bestScore) {
        best = saved[i];
        bestScore = s;
      }
    }
    if (best === link || (link && bestScore <= score(link) + 8)) return false;
    link = best;
    return true;
  }

  function linkSpeeds(ap, rssi) {
    const profile = profiles.get(ap.bssid);
    const base = {
      band: ap.freq,
      widthMHz: ap.widthMHz,
      apGen: genOfStandard(ap.standard),
      apNss: profile ? profile.nss : 2,
      clientGen: PHONE.gen,
      clientNss: PHONE.nss,
      clientMaxWidthMHz: PHONE.maxWidthMHz,
    };
    const rx = estimateLink({ ...base, rssi });
    // O celular transmite mais fraco do que o roteador: a subida negocia um pouco abaixo.
    const tx = estimateLink({ ...base, rssi: rssi - 3 });
    const mbps = (v) => (typeof v === 'number' ? Math.max(1, Math.round(v)) : null);
    return { tx: mbps(tx.phyMbps), rx: mbps(rx.phyMbps), max: mbps(rx.maxPhyMbps) };
  }

  function linkSample(t) {
    const pos = walker.posAt(t);
    const rssi = world.track(link, pos, pos.heading, t);
    return { rssi, ...linkSpeeds(link, rssi) };
  }

  function connectionAt(t) {
    if (!state.wifi || !link) return { connected: false };
    const s = linkSample(t);
    const out = { connected: true };
    if (seesIdentity()) {
      out.ssid = link.ssid;
      out.bssid = link.bssid;
    }
    out.rssi = s.rssi;
    out.frequency = link.freq;
    if (s.tx !== null) {
      out.linkSpeed = s.tx;
      out.txSpeed = s.tx;
    }
    if (s.rx !== null) out.rxSpeed = s.rx;
    if (s.max !== null) {
      out.maxTxSpeed = s.max;
      out.maxRxSpeed = s.max;
    }
    out.wifiStandard = Math.min(link.standard, 6);
    out.securityType = securityTypeOf(link.capabilities);
    out.hidden = link.ssid === '';
    out.ip = net.ip;
    out.prefix = net.prefix;
    out.gateway = net.gateway;
    out.dns = net.dns.slice();
    out.ipv6 = net.ipv6.slice();
    out.iface = net.iface;
    out.mtu = net.mtu;
    out.leaseSec = net.leaseSec;
    out.validated = true;
    out.metered = false;
    return out;
  }

  function linkTick() {
    after(1, linkTick);
    if (state.wifi && link && roam(simT)) emit('connection', connectionAt(simT));
  }

  let rssiWatch = null;
  function rssiTick() {
    if (!rssiWatch) return;
    rssiWatch.timer = after(rssiWatch.intervalS, rssiTick);
    if (!state.wifi || !link) return;
    const s = linkSample(simT);
    const out = { ts: nowMs(), rssi: s.rssi, bssid: seesIdentity() ? link.bssid : REDACTED_BSSID, frequency: link.freq };
    if (s.tx !== null) {
      out.linkSpeed = s.tx;
      out.txSpeed = s.tx;
    }
    if (s.rx !== null) out.rxSpeed = s.rx;
    emit('rssi', out);
  }

  // --- operações demoradas (ping, rede local, RTT, pedido de permissão) -------

  const ops = new Set(); // tudo o que tem uma Promise pendente; dispose() encerra cada uma
  let pingOp = null;
  let pingSerial = 0;
  let lanOp = null;
  let lanSerial = 0;

  // Quem é o destino de um ping e quanto ele costuma demorar. null = nome que não resolve.
  function pingTarget(host) {
    const name = host.toLowerCase();
    const self = { lo: 0.05, hi: 0.3, wifi: false };
    const gateway = { lo: 2, hi: 8, wifi: true };
    const ip = parseIpv4(name);
    if (ip) {
      if (ip[0] === 127 || name === net.ip) return self;
      const dev = household.find((d) => d.ip === name);
      if (dev) return dev.gateway ? gateway : { lo: dev.ms[0], hi: dev.ms[1], wifi: true };
      if (isPrivateIp(ip)) return { dead: true }; // endereço da rede local sem ninguém: silêncio
      if (ip[0] === 0 || ip[0] >= 224) return null;
    } else {
      if (name === 'localhost') return self;
      if (net.gatewayHost && name === net.gatewayHost.toLowerCase()) return gateway;
      if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) return null;
      if (/\.(invalid|test|example|local|lan|arpa)$/.test(name)) return null;
    }
    // Internet: cada destino tem a sua distância (15 a 45 ms) e oscila pouco.
    const base = 15 + 30 * hashUniform('wrx-ping', name);
    return { lo: base, hi: base + 4, wifi: true };
  }

  // Tempo de uma resposta, em ms; null = perdida. Sinal fraco traz atraso, oscilação e perda.
  function probeMs(target, serial, seq) {
    if (target.dead || (target.wifi && (!state.wifi || !link))) return null;
    const u = (k) => hashUniform(noise, 'ping', serial, seq, k);
    let ms = target.lo + (target.hi - target.lo) * Math.pow(u(1), 1.5);
    if (target.wifi) {
      const pos = walker.posAt(simT);
      const rssi = world.track(link, pos, pos.heading, simT);
      const weak = Math.min(1, Math.max(0, (-65 - rssi) / 25)); // 0 até -65 dBm; 1 em -90 dBm
      if (u(2) < 0.003 + 0.35 * weak * weak * weak) return null;
      ms += 40 * weak * weak * u(3);
      if (u(4) < 0.04 + 0.3 * weak) ms += (4 + 90 * weak) * u(5); // retransmissão
    }
    return Math.max(0.1, round1(ms));
  }

  function pingSummary(host, op) {
    const times = op.times;
    const out = {
      host,
      method: 'icmp',
      sent: op.sent,
      received: times.length,
      lossPct: op.sent ? round1((100 * (op.sent - times.length)) / op.sent) : 0,
    };
    if (times.length) {
      out.min = Math.min(...times);
      out.avg = round1(times.reduce((s, v) => s + v, 0) / times.length);
      out.max = Math.max(...times);
    }
    if (times.length >= 2) {
      let sum = 0;
      for (let i = 1; i < times.length; i++) sum += Math.abs(times[i] - times[i - 1]);
      out.jitter = round1(sum / (times.length - 1));
    }
    return out;
  }

  function startPing(args) {
    const host = typeof args.host === 'string' ? args.host.trim() : '';
    if (!host || /\s/.test(host) || host.length > 253) throw new Error('host inválido');
    if (!state.wifi || !link) throw new Error('rede inacessível');
    const target = pingTarget(host);
    if (!target) throw new Error(`host desconhecido: ${host}`);
    if (pingOp) pingOp.finish(); // um ping novo encerra o anterior
    const count = toInt(args.count, 1, 100, 10);
    const timeoutS = toInt(args.timeoutMs, 50, 30000, 1000) / 1000;
    const serial = ++pingSerial;
    return new Promise((resolve) => {
      const op = { sent: 0, times: [], timer: null, done: false };
      op.finish = () => {
        if (op.done) return;
        op.done = true;
        cancel(op.timer);
        ops.delete(op);
        if (pingOp === op) pingOp = null;
        resolve(pingSummary(host, op));
      };
      const probe = (seq) => {
        const ms = probeMs(target, serial, seq);
        const ok = ms !== null && ms <= timeoutS * 1000;
        const wait = ok ? ms / 1000 : timeoutS;
        op.timer = after(wait, () => {
          op.sent += 1;
          if (ok) op.times.push(ms);
          emit('ping', ok ? { host, seq, ok: true, ms } : { host, seq, ok: false });
          if (op.done) return;
          if (seq >= count) op.finish();
          else op.timer = after(Math.max(0.02, PING_INTERVAL_S - wait), () => probe(seq + 1));
        });
      };
      pingOp = op;
      ops.add(op);
      probe(1);
    });
  }

  function startLanScan() {
    if (!state.wifi || !link) throw new Error('sem conexão Wi-Fi');
    if (lanOp) lanOp.finish(); // uma busca nova encerra a anterior
    const serial = ++lanSerial;
    // Cada busca mede tempos de resposta um pouco diferentes.
    const answers = household.map((d, i) => {
      const out = { ip: d.ip };
      if (d.host) out.host = d.host;
      out.ms = round1(d.ms[0] + (d.ms[1] - d.ms[0]) * hashUniform(noise, 'lan', serial, i));
      if (d.self) out.self = true;
      if (d.gateway) out.gateway = true;
      return { n: d.n, self: !!d.self, out };
    });
    return new Promise((resolve) => {
      const found = [];
      const op = { timer: null, done: false };
      op.finish = () => {
        if (op.done) return;
        op.done = true;
        cancel(op.timer);
        ops.delete(op);
        if (lanOp === op) lanOp = null;
        resolve({ devices: found.map((d) => ({ ...d })) });
      };
      const show = (a) => {
        found.push(a.out);
        found.sort((p, q) => Number(p.ip.slice(p.ip.lastIndexOf('.') + 1)) - Number(q.ip.slice(q.ip.lastIndexOf('.') + 1)));
        emit('lan', { ...a.out });
      };
      let done = 0;
      const step = () => {
        const next = Math.min(LAN_HOSTS, done + 16);
        for (const a of answers) {
          if (op.done) return;
          if (!a.self && a.n > done && a.n <= next) show(a);
        }
        done = next;
        emit('lanProgress', { done, total: LAN_HOSTS });
        if (op.done) return;
        if (done >= LAN_HOSTS) op.finish();
        else op.timer = after(0.4, step);
      };
      lanOp = op;
      ops.add(op);
      // Este celular aparece primeiro; os outros, conforme a busca chega ao endereço deles.
      op.timer = after(0.05, () => {
        const me = answers.find((a) => a.self);
        if (me) show(me);
        emit('lanProgress', { done: 0, total: LAN_HOSTS });
        if (!op.done) op.timer = after(0.4, step);
      });
    });
  }

  function rttMeasure(bssid, t) {
    const ap = world.ap(bssid);
    const profile = ap ? profiles.get(ap.bssid) : null;
    if (!ap || !profile || !profile.ftm) return { bssid, ok: false };
    const pos = walker.posAt(t);
    if (world.meanRssi(ap, pos) < -88) return { bssid, ok: false }; // longe demais para responder
    const tk = Math.round(t * 1000);
    const d = Math.hypot(ap.x - pos.x, ap.y - pos.y, ap.z - pos.z);
    const successes = 8 - Math.floor(3 * hashUniform(noise, 'rtt-ok', bssid, tk));
    return {
      bssid,
      ok: true,
      // Como no Android, a medida pode sair um pouco negativa colado no roteador.
      distM: Math.round((d + profile.rttSigma * hashGaussian(noise, 'rtt', bssid, tk)) * 100) / 100,
      stdM: Math.round(profile.rttSigma * (0.5 + 0.7 * hashUniform(noise, 'rtt-std', bssid, tk)) * 100) / 100,
      rssi: world.track(ap, pos, pos.heading, t),
      attempts: 8,
      successes,
    };
  }

  function startRtt(args) {
    if (!Array.isArray(args.bssids) || args.bssids.some((b) => typeof b !== 'string')) throw new Error('bssids inválido');
    if (!canScan()) throw new Error('medição de distância indisponível');
    const bssids = args.bssids.map((b) => b.toLowerCase());
    return new Promise((resolve) => {
      const op = { timer: null, done: false };
      const settle = (results) => {
        if (op.done) return;
        op.done = true;
        cancel(op.timer);
        ops.delete(op);
        resolve({ results });
      };
      op.finish = () => settle(bssids.map((bssid) => ({ bssid, ok: false })));
      op.timer = after(0.25 + 0.04 * bssids.length, () => settle(bssids.map((b) => rttMeasure(b, simT))));
      ops.add(op);
    });
  }

  function requestPermission() {
    if (state.permission === 'granted') return statusNow();
    return new Promise((resolve) => {
      const op = { timer: null, done: false };
      op.finish = () => {
        if (op.done) return;
        op.done = true;
        cancel(op.timer);
        ops.delete(op);
        resolve(statusNow());
      };
      // Negada em definitivo: o Android nem mostra a janela e responde na hora.
      op.timer = after(state.permission === 'blocked' ? 0.05 : 0.9, () => {
        if (state.permission === 'denied') {
          let next = state.permissionReply;
          if (next === 'denied') {
            denials += 1;
            if (denials >= 2) next = 'blocked';
          }
          if (next !== 'denied') applyState({ permission: next });
        }
        op.finish();
      });
      ops.add(op);
    });
  }

  // --- métodos "de aparelho" ---------------------------------------------------

  const browser = () => (typeof navigator === 'object' && navigator ? navigator : null);
  let wakeLock = null;
  const blobs = new Set();

  function keepAwake(args) {
    device.keepAwake = !!args.on;
    const nav = browser();
    try {
      if (device.keepAwake && !wakeLock && nav && nav.wakeLock && typeof nav.wakeLock.request === 'function') {
        nav.wakeLock.request('screen').then(
          (lock) => {
            if (device.keepAwake && !disposed) wakeLock = lock;
            else lock.release().catch(() => {});
          },
          () => {},
        );
      } else if (!device.keepAwake && wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
      }
    } catch {
      // sem Wake Lock neste navegador: só registra o pedido
    }
    return { ok: true };
  }

  function vibrate(args) {
    const ms = toInt(args.ms, 0, 10000, 20);
    device.vibrations += 1;
    device.lastVibrateMs = ms;
    const nav = browser();
    // Sem um toque anterior o navegador bloqueia a vibração (e reclama no console).
    if (nav && typeof nav.vibrate === 'function' && nav.userActivation && nav.userActivation.hasBeenActive) {
      try {
        nav.vibrate(ms);
      } catch {
        // tanto faz
      }
    }
    return { ok: true };
  }

  function setBars(args) {
    device.bars = { color: String(args.color ?? ''), dark: !!args.dark };
    if (typeof document === 'object' && document && typeof document.querySelector === 'function' && /^#[0-9a-f]{6}$/i.test(device.bars.color)) {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', device.bars.color);
    }
    return { ok: true };
  }

  function share(args) {
    const title = String(args.title ?? '');
    const text = String(args.text ?? '');
    device.lastShare = { title, text };
    const joined = title && text ? `${title}\n${text}` : title || text;
    const nav = browser();
    const copy = () => {
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        return nav.clipboard.writeText(joined).then(
          () => ({ ok: true }),
          () => ({ ok: legacyCopy(joined) }),
        );
      }
      return Promise.resolve({ ok: legacyCopy(joined) });
    };
    if (nav && typeof nav.share === 'function') {
      try {
        return nav.share({ title, text }).then(
          () => ({ ok: true }),
          // Fechar a folha de compartilhamento não é erro: no Android também volta ok.
          (err) => (err && err.name === 'AbortError' ? { ok: true } : copy()),
        );
      } catch {
        return copy();
      }
    }
    return copy();
  }

  function saveFile(args) {
    const raw = typeof args.name === 'string' ? args.name.trim() : '';
    const name = (raw || 'arquivo.txt').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_');
    const mime = typeof args.mime === 'string' && args.mime ? args.mime : 'application/octet-stream';
    let data;
    if (typeof args.text === 'string') data = args.text;
    else if (typeof args.base64 === 'string') data = decodeBase64(args.base64);
    if (data === undefined || data === null) return { ok: false };
    device.lastFile = { name, mime, size: data.length };
    if (typeof args.text === 'string') device.lastFile.text = args.text;
    else device.lastFile.base64 = args.base64;
    if (typeof document !== 'object' || !document || !document.body || typeof Blob !== 'function') return { ok: false };
    if (typeof URL !== 'function' || typeof URL.createObjectURL !== 'function') return { ok: false };
    try {
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // O navegador precisa de um tempo para começar a baixar antes de o endereço sumir.
      const blob = { url, timer: null };
      blob.timer = clock.setTimeout(() => {
        blobs.delete(blob);
        URL.revokeObjectURL(url);
      }, 30000);
      blobs.add(blob);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  // No simulador, "abrir as configurações" resolve o problema sozinho depois de um instante,
  // para dar para demonstrar as telas de bloqueio do começo ao fim.
  const SETTINGS = {
    wifi: { wifi: true },
    panel: { wifi: true },
    location: { location: true },
    app: { permission: 'granted' },
    developer: { throttle: false },
  };

  function openSettings(args) {
    const effect = Object.prototype.hasOwnProperty.call(SETTINGS, args.which) ? SETTINGS[args.which] : null;
    if (!effect) return { ok: false };
    after(1.2, () => applyState(effect));
    return { ok: true };
  }

  // --- tabela dos métodos (a mesma de bridge.js) --------------------------------

  const SYNC = {
    info: () => ({
      platform: 'sim',
      sdk: 0,
      release: 'simulado',
      manufacturer: PHONE.manufacturer,
      model: PHONE.model,
      appVersion: APP_VERSION,
      bands: { b24: true, b5: true, b6: true, b60: false },
      standards: [4, 5, 6],
      rtt: true,
    }),
    status: () => statusNow(),
    lastScan: () => publish(simT, false, 'cache'),
    connection: () => connectionAt(simT),
    watchRssi: (args) => {
      if (rssiWatch) cancel(rssiWatch.timer);
      rssiWatch = { intervalS: toInt(args.intervalMs, 100, 60000, 1000) / 1000, timer: null };
      rssiWatch.timer = after(0.02, rssiTick); // a primeira amostra sai logo; as outras, no intervalo
      return { ok: true };
    },
    unwatchRssi: () => {
      if (rssiWatch) cancel(rssiWatch.timer);
      rssiWatch = null;
      return { ok: true };
    },
    openSettings,
    keepAwake,
    vibrate,
    setBars,
    share,
    saveFile,
    cancel: (args) => {
      if (args.op === 'ping' && pingOp) pingOp.finish();
      if (args.op === 'lan' && lanOp) lanOp.finish();
      return { ok: true };
    },
  };

  const ASYNC = {
    requestPermission,
    scan: requestScan,
    rtt: startRtt,
    ping: startPing,
    lanScan: startLanScan,
  };

  const own = (table, method) => (typeof method === 'string' && Object.prototype.hasOwnProperty.call(table, method) ? table[method] : null);
  const argsOf = (args) => (args && typeof args === 'object' ? args : {});

  function call(method, args) {
    if (disposed) throw new Error('simulador encerrado');
    const fn = own(SYNC, method);
    if (!fn) throw new Error(`método desconhecido: ${method}`);
    return enter(() => fn(argsOf(args)));
  }

  function callAsync(method, args) {
    if (disposed) return Promise.reject(new Error('simulador encerrado'));
    const fn = own(ASYNC, method);
    if (!fn) return Promise.reject(new Error(`método desconhecido: ${method}`));
    try {
      return Promise.resolve(enter(() => fn(argsOf(args))));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // --- controles da demonstração -------------------------------------------------

  function truth() {
    const s = walker.stateAt(simT);
    return {
      t: round3(simT),
      x: round3(s.x),
      y: round3(s.y),
      z: round3(s.z),
      floor: s.floor,
      room: s.room,
      heading: Math.round(s.heading * 10000) / 10000 + 0,
      moving: s.moving,
      mode: s.mode,
      world: worldId,
    };
  }

  function tick() {
    ticker = clock.setTimeout(tick, SIM_TICK_MS);
    sync();
    emit('sim', truth());
    arm();
  }

  function dispose() {
    if (disposed) return;
    const pending = [...ops];
    disposed = true; // daqui em diante nada é emitido nem agendado
    for (const op of pending) op.finish(); // quem esperava recebe o que já havia
    if (wake) clock.clearTimeout(wake.id);
    wake = null;
    if (ticker !== null) clock.clearTimeout(ticker);
    ticker = null;
    for (const blob of blobs) {
      clock.clearTimeout(blob.timer);
      URL.revokeObjectURL(blob.url);
    }
    blobs.clear();
    timers.length = 0;
    rssiWatch = null;
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    if (live === sim) live = null;
  }

  const sim = {
    /** O mundo em uso (planta, paredes, roteadores): para desenhar por cima na demonstração. */
    get world() {
      return world;
    },
    get worldId() {
      return worldId;
    },
    get seed() {
      return seed;
    },
    get speed() {
      return speed;
    },
    get device() {
      return device;
    },
    /** Segundos simulados desde que o simulador nasceu. */
    now: () => enter(() => simT),
    /** Onde a pessoa virtual está de verdade agora (o mesmo conteúdo do evento 'sim'). */
    truth: () => enter(truth),
    /** {wifi, location, permission, throttle, permissionReply} */
    state: () => ({ ...state }),
    /**
     * Muda o estado do "celular". Cada mudança emite 'status' (e 'connection' ao ligar ou
     * desligar o Wi-Fi). `permissionReply` é o que o usuário responderá ao próximo pedido.
     * @returns {import('../bridge.js').Status}
     */
    setState: (patch) => enter(() => applyState(argsOf(patch))),
    /** Escala do tempo: 10 = dez vezes mais rápido. Devolve o valor aplicado. */
    setSpeed(k) {
      enter(() => {
        speed = toSpeed(k, speed);
      });
      return speed;
    },
    /** Troca de casa. Emite 'connection' e uma varredura nova ('scan') do lugar novo. */
    loadWorld(id, newSeed) {
      return enter(() => {
        if (pingOp) pingOp.finish();
        if (lanOp) lanOp.finish();
        cancel(pendingScan);
        pendingScan = null;
        installWorld(id, toSeed(newSeed, seed), walker.mode);
        if (state.wifi) {
          emit('connection', connectionAt(simT));
          if (canScan()) emit('scan', publish(simT, true, 'system'));
        }
        return worldId;
      });
    },
    /** Rádio do mundo em que o celular está conectado agora (ou null). */
    link: () => enter(() => link),
    walker: {
      /** 'auto' | 'still' | 'manual' */
      get mode() {
        return walker.mode;
      },
      setMode: (mode) => enter(() => walker.setMode(mode, simT)),
      /** Anda até (x, y) pelo caminho de uma pessoa (portas, escadas). false = não há caminho. */
      goTo: (x, y, floor) => enter(() => walker.goTo(toNum(x, NaN), toNum(y, NaN), floor, simT)),
      /** Sobe ou desce até o andar pedido. */
      setFloor: (floor) => enter(() => walker.setFloor(floor, simT)),
      /** Põe a pessoa num ponto sem andar; ela fica parada lá. */
      teleport: (x, y, floor) => enter(() => walker.teleport(toNum(x, NaN), toNum(y, NaN), floor, simT)),
      position: () => enter(truth),
    },
    /** Tamanho das estruturas internas (para conferir que nada cresce sem parar). */
    stats: () => ({
      timers: timers.length,
      walker: walker.size(),
      accepted: accepted.length,
      cached: cache ? cache.aps.length : 0,
      ops: ops.size,
      blobs: blobs.size,
    }),
    dispose,
  };

  // --- partida -----------------------------------------------------------------

  const mode = WALK_MODES.includes(options.walk) ? options.walk : 'auto';
  try {
    installWorld(options.world ?? 'apartamento', seed, mode);
  } catch (err) {
    // Mundo que não existe (erro de digitação na URL): melhor abrir o padrão do que nada.
    report(err);
    installWorld('apartamento', seed, mode);
  }
  systemRng = createRng('wrx-system-scan', seed, worldId);
  scheduleSystemScan();
  after(1, linkTick);
  ticker = clock.setTimeout(tick, SIM_TICK_MS);
  arm();
  live = sim;

  return { call, callAsync, dispose, sim };
}
