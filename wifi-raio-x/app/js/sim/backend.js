// Simulador da ponte: responde a todos os métodos de bridge.js no navegador, nos testes e
// no "modo demonstração" do app, usando o mundo de rádio simulado (world.js).
//
// O que sai daqui tem de ter a MESMA FORMA do que o Android manda (mesmos campos, tipos e
// unidades; campo opcional ausente em vez de null) e reagir do mesmo jeito (mesmas recusas,
// mesmos erros, mesma ordem dos eventos): todas as telas e todos os testes de ponta a ponta
// são desenvolvidos contra este arquivo. O comportamento foi conferido com o lado nativo
// (android/.../Bridge.java e companhia); tests/helpers/contract.mjs confere a forma.
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

import { estimateLink, usableMbps } from '../core/phy.js';
import { PHONE, describeAps, hostileNeighbours, householdOf, iesAt, loadAt, networkOf, savedNetworks } from './demo-data.js';
import { presetSpec, randomSpec } from './presets.js';
import { createRng, hashGaussian, hashSeed, hashUniform } from './prng.js';
import { createWalker, WALK_MODES } from './walker.js';
import { createWorld } from './world.js';

/** Versão que o simulador informa em info().appVersion. */
export const APP_VERSION = '1.0.0';

/**
 * Motivos com que scan() recusa uma varredura (campo `reason`): os mesmos textos do Android
 * (WifiScanner.java). 'failed' nunca sai do simulador; está aqui porque o celular pode mandar.
 */
export const SCAN_REFUSAL = Object.freeze({
  PERMISSION: 'no-permission',
  LOCATION: 'location-off',
  WIFI: 'wifi-off',
  THROTTLED: 'throttled',
  FAILED: 'failed',
});

// Textos de erro iguais aos do lado nativo (Bridge.java, Pinger.java).
const ERR_ARGS = 'argumentos inválidos';
const ERR_UNKNOWN = 'método desconhecido: ';
const ERR_ASYNC_ONLY = 'método assíncrono, use callAsync: ';
const ERR_CLOSED = 'encerrado';
const ERR_INVALID_HOST = 'host inválido';
const ERR_UNKNOWN_HOST = 'host não encontrado';

const SIM_TICK_MS = 250; // evento 'sim': 4 vezes por segundo de relógio
const MAX_JUMP_S = 120; // aba em segundo plano: ao voltar, o mundo não tenta recuperar o atraso
const EPS = 1e-6; // folga (s simulados) ao decidir se um temporizador já venceu
const MIN_SPEED = 0.1;
const MAX_SPEED = 60;
const THROTTLE_MAX = 4; // limite do Android: 4 varreduras...
const THROTTLE_WINDOW_S = 120; // ...a cada 2 minutos
const RSSI_MIN_MS = 250; // limites do RssiWatcher nativo
const RSSI_MAX_MS = 60000;
const PING_INTERVAL_S = 0.2; // o menor intervalo que o ping do Android aceita
const PING_MAX_COUNT = 50;
const LAN_HOSTS = 254;
const LAN_THREADS = 48; // endereços sondados ao mesmo tempo
const LAN_BATCH_S = 1.15; // quanto um lote de endereços mudos demora para desistir
const RTT_MAX_PEERS = 10; // o Android mede no máximo 10 roteadores por pedido
const SPEED_TICK_S = 0.2;
const SPEED_SERVER = 'GRU';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

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

const toSpeed = (v, fallback) => Math.min(MAX_SPEED, Math.max(MIN_SPEED, toNum(v, fallback)));
const toSeed = (v, fallback) => Math.round(toNum(v, fallback)) || fallback;
const toPermission = (v, fallback) => (v === 'granted' || v === 'denied' || v === 'blocked' ? v : fallback);
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000 + 0; // "+ 0" evita o -0, que não existe em JSON
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Número de um argumento da ponte, com padrão e limites (igual a Json.clamp do lado nativo). */
function clampArg(v, min, max, fallback) {
  const n = isNumber(v) ? v : fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const badArgs = (field) => new Error(field ? `${ERR_ARGS}: ${field}` : ERR_ARGS);

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

// --- destino de um ping: as mesmas regras de PingHost.java ---

function parseIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    out.push(Number(part));
  }
  return out;
}

function isIpv6(host) {
  const m = /^([0-9a-f:.]{2,45})(%[0-9a-z]{1,16})?$/i.exec(host);
  if (!m) return false;
  const colons = m[1].split(':').length - 1;
  return colons >= 2 && colons <= 7;
}

// Rótulos de letras, dígitos, '-' e '_' separados por ponto; o último não pode ser só número.
function isHostname(host) {
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (!name) return false;
  const labels = name.split('.');
  if (!labels.every((l) => /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/i.test(l))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]);
}

function isValidHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253 || host[0] === '-') return false;
  return parseIpv4(host) !== null || isIpv6(host) || isHostname(host);
}

const isPrivateIp = (p) =>
  p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);

// O ping mostra três algarismos: 0.123, 4.21, 27.4, 131.
function pingPrecision(ms) {
  if (ms < 1) return Math.max(0.001, round3(ms));
  if (ms < 10) return round2(ms);
  if (ms < 100) return round1(ms);
  return Math.round(ms);
}

/** Nome de arquivo seguro, como Sharer.sanitizeName: sem pastas, sem símbolos estranhos, sem ponto inicial. */
function sanitizeFileName(raw) {
  let s = String(raw);
  s = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
  s = [...s]
    .map((c) => (/[\p{L}\p{N}.\-_ ()+]/u.test(c) ? c : /\p{Cc}/u.test(c) ? '' : '_'))
    .join('')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (s.length > 80) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = s.slice(0, 80 - ext.length).trim() + ext;
  }
  return s || 'arquivo';
}

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
 *           'sorteada' (casa sorteada pela semente), um WorldSpec ou um mundo já montado. Padrão: 'apartamento'
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
 * Evento extra 'sim' (só o simulador emite), 4 vezes por segundo de relógio: onde a pessoa
 * virtual está de verdade. É o que a demonstração desenha por cima do mapa.
 * @typedef {Object} SimEvent
 * @property {number} t        segundos simulados desde que o simulador nasceu
 * @property {number} x        metros, nas coordenadas do mundo (sim.world)
 * @property {number} y
 * @property {number} z        altura do celular (andar * 2,8 + 1,2; varia na escada)
 * @property {number} floor
 * @property {string|null} room   nome do cômodo, ou null (escada, soleira)
 * @property {number} heading  para onde a pessoa está virada (rad, 0 = +x)
 * @property {boolean} moving
 * @property {'auto'|'still'|'manual'} mode
 * @property {string} world    id do mundo ('apartamento', 'sobrado'...)
 */

/**
 * Cria o simulador.
 *
 * Controles (`sim`, também em currentSim()):
 *   world, worldId, seed, speed, network, device   leitura
 *   now() -> segundos simulados · truth() -> SimEvent · state() · link() -> rádio conectado
 *   setState({wifi, location, permission, throttle, permissionReply}) -> Status
 *   setSpeed(k) · loadWorld(id, seed?) · dispose()
 *   walker.mode · walker.setMode(m) · walker.goTo(x, y, floor?) · walker.setFloor(f)
 *   walker.teleport(x, y, floor?) · walker.position()
 *
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

  /** Desarma um temporizador de `after`. */
  function drop(t) {
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
    // Arredonda para cima: acordar um instante depois é melhor do que antes da hora. O
    // desconto de 1e-6 ms só absorve o erro de ponto flutuante (500,0000001 -> 500) e fica
    // bem abaixo de EPS, então quem acorda sempre encontra o temporizador vencido.
    const ms = Math.max(0, Math.ceil(((at - simT) / speed) * 1000 - 1e-6));
    const due = lastReal + ms;
    // Já armado para a mesma hora (a menos do arredondamento)? Deixa como está. Se a
    // velocidade mudou ou o relógio saltou, a hora muda e o temporizador é refeito.
    if (wake && wake.at === at && Math.abs(wake.due - due) <= 2) return;
    if (wake) clock.clearTimeout(wake.id);
    wake = { at, due, id: clock.setTimeout(onWake, ms) };
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

  function installWorld(built, worldSeed, mode) {
    seed = worldSeed;
    world = built.world;
    worldId = built.id;
    noise = hashSeed('wrx-sim', world.key ?? seed, worldId);
    walker = createWalker(world, { seed, mode, t: simT });
    profiles = describeAps(world);
    net = networkOf(world);
    household = householdOf(world, net, hostile);
    saved = savedNetworks(world);
    // O Android não entrega a lista em ordem de sinal nem com a rede da casa primeiro.
    order = new Map(world.aps.map((a) => [a.bssid, hashSeed('wrx-order', noise, a.bssid)]));
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

  /**
   * Aplica uma mudança de estado. Emite 'status' quando algo mudou — ou sempre, com `force`
   * (o Android reenvia o estado ao voltar das configurações e depois de um pedido de permissão).
   */
  function applyState(patch, force = false) {
    const old = statusNow();
    const wifiBefore = state.wifi;
    const sawIdentity = seesIdentity();
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
    if (force || Object.keys(now).some((k) => now[k] !== old[k])) emit('status', now);
    if (state.wifi !== wifiBefore) {
      if (state.wifi) wifiUp();
      else wifiDown();
    } else {
      announceIdentity(sawIdentity);
    }
    return now;
  }

  /**
   * O nome e o BSSID da rede conectada passaram a aparecer (a Localização foi ligada, a permissão
   * foi concedida) ou deixaram de aparecer: como no Android, a conexão é reenviada. Sem isto o app
   * ficava com a conexão "sem identidade" lida durante o bloqueio até a próxima troca de rádio.
   */
  function announceIdentity(sawBefore) {
    if (seesIdentity() !== sawBefore && state.wifi && link) emit('connection', connectionAt(simT));
  }

  function wifiDown() {
    drop(reconnectTimer);
    drop(bootScanTimer);
    drop(pendingScan);
    pendingScan = null;
    cache = null; // o Android esvazia a lista ao desligar o Wi-Fi
    link = null;
    if (lanOp) lanOp.finish();
    if (speedOp) speedOp.finish('offline');
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
      emit('scan', publish(simT, true, 'system'));
    });
  }

  // --- varreduras ------------------------------------------------------------

  /** Última lista, em unidades simuladas: {t, aps}. É também o "anterior" da próxima varredura. */
  let cache = null;
  let pendingScan = null;
  let scanSerial = 0;
  const accepted = []; // instantes das varreduras aceitas (para o limite do Android)

  // Completa uma leitura do mundo com o resto do que o Android informa, na ordem do ScanMapper.
  function enrich(ap, heardAt) {
    const profile = profiles.get(ap.bssid);
    const out = {
      bssid: ap.bssid,
      ssid: ap.ssid,
      level: ap.level,
      frequency: ap.frequency,
      channelWidth: ap.channelWidth,
      centerFreq0: ap.centerFreq0,
      centerFreq1: ap.centerFreq1,
      capabilities: profile ? profile.capabilities : ap.capabilities,
      ageMs: ap.ageMs,
      rttResponder: !!(profile && profile.ftm),
      passpoint: false,
      wifiStandard: ap.wifiStandard,
    };
    const ies = profile ? iesAt(profile, heardAt) : [];
    if (ies.length) out.ies = ies;
    return out;
  }

  // Uma varredura de verdade no lugar (e ao longo do caminho) em que a pessoa está.
  function sweep(t) {
    const mid = walker.posAt(world.sweepWindow(t).mid);
    const raw = world.scan({ x: mid.x, y: mid.y, z: mid.z, heading: mid.heading, t, prev: cache, path: walker.posAt });
    // Leitura repetida da varredura anterior já vem completa; só as novas são completadas.
    const aps = raw.map((ap) => ('passpoint' in ap ? ap : enrich(ap, t - ap.ageMs / 1000)));
    aps.sort((a, b) => (order.get(a.bssid) ?? 0) - (order.get(b.bssid) ?? 0));
    cache = { t, aps };
  }

  // A lista como a interface a recebe: as idades contam até "agora", no relógio do celular.
  // Sem permissão ou sem Localização o Android entrega a lista vazia.
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
      // Como no Android: o pedido é recusado, não gasta a cota e chega um aviso com a lista
      // antiga (fresh = false), atribuído ao pedido.
      after(0.05, () => {
        if (state.wifi) emit('scan', publish(simT, false, 'request'));
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
        emit('scan', publish(simT, true, 'request'));
      });
    }
    return { accepted: true };
  }

  // O próprio Android varre de tempos em tempos e avisa o app — que, sem permissão, recebe
  // o aviso com a lista vazia.
  let systemRng = createRng('wrx-system-scan', seed);
  function scheduleSystemScan() {
    after(systemRng.float(30, 60), () => {
      scheduleSystemScan();
      if (!state.wifi || pendingScan) return;
      sweep(simT);
      emit('scan', publish(simT, true, 'system'));
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

  // Taxas físicas (Mb/s, sem arredondar) de descida e de subida do enlace com um dado sinal.
  function linkRates(ap, rssi) {
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
    return { tx: tx.phyMbps, rx: rx.phyMbps, max: rx.maxPhyMbps };
  }

  function linkSample(t) {
    const pos = walker.posAt(t);
    const rssi = world.track(link, pos, pos.heading, t);
    const rates = linkRates(link, rssi);
    const mbps = (v) => (isNumber(v) ? Math.max(1, Math.round(v)) : null);
    return { rssi, tx: mbps(rates.tx), rx: mbps(rates.rx), max: mbps(rates.max) };
  }

  // Mesmos campos, na mesma ordem, do ConnectionMapper do Android.
  function connectionAt(t) {
    if (!state.wifi || !link) return { connected: false };
    const s = linkSample(t);
    const out = { connected: true };
    if (seesIdentity()) {
      out.ssid = link.ssid;
      out.bssid = link.bssid;
    }
    out.hidden = link.ssid === '';
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
    out.ip = net.ip;
    out.prefix = net.prefix;
    out.ipv6 = net.ipv6.slice();
    out.dns = net.dns.slice();
    out.iface = net.iface;
    out.mtu = net.mtu;
    out.gateway = net.gateway;
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
    // bssid "" = o Android escondeu (falta permissão), como no RssiSample nativo.
    const out = { ts: nowMs(), rssi: s.rssi, bssid: seesIdentity() ? link.bssid : '', frequency: link.freq };
    if (s.tx !== null) {
      out.linkSpeed = s.tx;
      out.txSpeed = s.tx;
    }
    if (s.rx !== null) out.rxSpeed = s.rx;
    emit('rssi', out);
  }

  // --- operações demoradas (ping, rede local, RTT, velocidade, permissão) ------

  const ops = new Set(); // tudo o que tem uma Promise pendente; dispose() encerra cada uma
  let pingOp = null;
  let pingSerial = 0;
  let lanOp = null;
  let lanSerial = 0;
  let speedOp = null;
  let speedSerial = 0;
  let rttSerial = 0;

  // Quem é o destino de um ping e quanto ele costuma demorar. null = nome que não resolve.
  function pingTarget(host) {
    const name = host.toLowerCase().replace(/\.$/, '');
    const self = { lo: 0.04, hi: 0.3, wifi: false };
    const gateway = { lo: 2, hi: 8, wifi: true };
    const online = state.wifi && !!link;
    const ip = parseIpv4(name);
    if (ip) {
      if (ip[0] === 127 || ip[0] === 0 || name === net.ip) return self;
      const dev = household.find((d) => d.ip === name);
      if (dev) return dev.gateway ? gateway : { lo: dev.ms[0], hi: dev.ms[1], wifi: true };
      if (isPrivateIp(ip) || ip[0] >= 224) return { dead: true }; // endereço sem ninguém: silêncio
    } else if (isIpv6(name)) {
      if (name === '::1') return self;
      if (/^f[c-f]/.test(name)) return { dead: true }; // endereços locais (fe80::, fc00::): ninguém responde
    } else {
      if (name === 'localhost') return self;
      if (net.gatewayHost && name === net.gatewayHost.toLowerCase()) return online ? gateway : null;
      // Sem ponto, ou num domínio que não existe na internet: o DNS não acha. Sem rede, nenhum nome resolve.
      if (!online || !name.includes('.') || /\.(invalid|test|example|local|lan|arpa|internal)$/.test(name)) return null;
    }
    // Internet: cada destino tem a sua distância (15 a 45 ms) e oscila pouco.
    const base = 15 + 30 * hashUniform('wrx-ping', name);
    return { lo: base, hi: base + 4, wifi: true };
  }

  // Tempo de uma resposta, em ms; null = perdida. Sinal fraco traz atraso, oscilação e perda.
  function probeMs(target, ...key) {
    if (target.dead || (target.wifi && (!state.wifi || !link))) return null;
    const u = (k) => hashUniform(noise, 'probe', ...key, k);
    let ms = target.lo + (target.hi - target.lo) * Math.pow(u(1), 1.5);
    if (target.wifi) {
      const pos = walker.posAt(simT);
      const rssi = world.track(link, pos, pos.heading, simT);
      const weak = Math.min(1, Math.max(0, (-65 - rssi) / 25)); // 0 até -65 dBm; 1 em -90 dBm
      if (u(2) < 0.003 + 0.35 * weak * weak * weak) return null;
      ms += 40 * weak * weak * u(3);
      if (u(4) < 0.04 + 0.3 * weak) ms += (4 + 90 * weak) * u(5); // retransmissão
    }
    return pingPrecision(ms);
  }

  // As mesmas contas (e arredondamentos) de PingStats.java.
  function pingSummary(host, sent, times) {
    const out = {
      host,
      method: 'icmp',
      sent,
      received: times.length,
      lossPct: sent ? round1((100 * (sent - times.length)) / sent) : 0,
    };
    if (times.length) {
      out.min = round3(Math.min(...times));
      out.avg = round3(times.reduce((s, v) => s + v, 0) / times.length);
      out.max = round3(Math.max(...times));
    }
    if (times.length >= 2) {
      let sum = 0;
      for (let i = 1; i < times.length; i++) sum += Math.abs(times[i] - times[i - 1]);
      out.jitter = round3(sum / (times.length - 1));
    }
    return out;
  }

  // Como o ping do Android: um pacote a cada 0,2 s; cada resposta vira um evento na hora em
  // que chega; os pacotes sem resposta só são avisados no fim, junto com o resumo.
  function startPing(args) {
    const host = args.host;
    if (!isValidHost(host)) throw new Error(ERR_INVALID_HOST);
    const count = clampArg(args.count, 1, PING_MAX_COUNT, 10);
    const timeoutMs = clampArg(args.timeoutMs, 200, 5000, 1000);
    const target = pingTarget(host);
    if (!target) throw new Error(ERR_UNKNOWN_HOST);
    if (pingOp) pingOp.finish(true); // um ping por vez: o novo encerra o anterior
    const serial = ++pingSerial;
    // O ping só aceita esperar em segundos inteiros pela resposta dos últimos pacotes.
    const waitS = Math.max(1, Math.ceil(timeoutMs / 1000));
    return new Promise((resolve) => {
      const op = { timers: [], got: new Map(), done: false };
      op.finish = (cancelled) => {
        if (op.done) return;
        op.done = true;
        for (const t of op.timers) drop(t);
        ops.delete(op);
        if (pingOp === op) pingOp = null;
        // Interrompido: só dá para saber dos pacotes até a última resposta que chegou.
        const sent = cancelled ? Math.max(0, ...op.got.keys()) : count;
        const times = [];
        for (let seq = 1; seq <= sent; seq++) {
          if (op.got.has(seq)) times.push(op.got.get(seq));
          else emit('ping', { host, seq, ok: false });
        }
        resolve(pingSummary(host, sent, times));
      };
      let lastReplyAt = simT;
      let lost = false;
      const send = (seq) => {
        const ms = probeMs(target, 'ping', serial, seq);
        if (ms !== null && ms <= timeoutMs) {
          lastReplyAt = Math.max(lastReplyAt, simT + ms / 1000);
          op.timers.push(
            after(ms / 1000, () => {
              op.got.set(seq, ms);
              emit('ping', { host, seq, ok: true, ms });
            }),
          );
        } else {
          lost = true;
        }
        if (seq < count) op.timers.push(after(PING_INTERVAL_S, () => send(seq + 1)));
        else op.timers.push(after(Math.max(lastReplyAt - simT, lost ? waitS : 0) + 0.005, () => op.finish(false)));
      };
      pingOp = op;
      ops.add(op);
      send(1);
    });
  }

  // Como o LanScanner do Android: 48 endereços por vez; quem responde aparece logo, os mudos
  // seguram o lote por pouco mais de 1 s; este celular entra sem tempo de resposta.
  function startLanScan() {
    if (lanOp) lanOp.finish(); // uma busca por vez: a nova encerra a anterior
    const online = state.wifi && !!link;
    const serial = ++lanSerial;
    const total = online ? LAN_HOSTS : 0;
    const answers = !online
      ? []
      : household.map((d, i) => {
          const out = { ip: d.ip };
          if (d.host) out.host = d.host;
          let delay = 0;
          if (!d.self) {
            out.ms = round1(d.ms[0] + (d.ms[1] - d.ms[0]) * hashUniform(noise, 'lan', serial, i));
            // Depois de responder, ainda leva um instante para descobrir (ou desistir de) o nome.
            delay = out.ms / 1000 + (d.host ? 0.03 + 0.25 * hashUniform(noise, 'lan-name', serial, i) : 0.35);
          }
          if (d.self) out.self = true;
          if (d.gateway) out.gateway = true;
          return { out, at: Math.floor((d.n - 1) / LAN_THREADS) * LAN_BATCH_S + delay };
        });
    return new Promise((resolve) => {
      const found = [];
      const op = { timers: [], done: false };
      op.finish = () => {
        if (op.done) return;
        op.done = true;
        for (const t of op.timers) drop(t);
        ops.delete(op);
        if (lanOp === op) lanOp = null;
        const last = (d) => Number(d.ip.slice(d.ip.lastIndexOf('.') + 1));
        resolve({ devices: found.sort((p, q) => last(p) - last(q)).map((d) => ({ ...d })) });
      };
      const at = (delayS, fn) => op.timers.push(after(delayS, () => !op.done && fn()));
      lanOp = op;
      ops.add(op);
      at(0.02, () => {
        emit('lanProgress', { done: 0, total });
        if (!total && !op.done) op.finish(); // fora do Wi-Fi: nada a varrer
      });
      for (const a of answers) {
        at(0.02 + a.at, () => {
          found.push(a.out);
          emit('lan', { ...a.out });
        });
      }
      for (let done = LAN_THREADS; total && done < total + LAN_THREADS; done += LAN_THREADS) {
        at(0.02 + (done / LAN_THREADS) * LAN_BATCH_S, () => {
          emit('lanProgress', { done: Math.min(done, total), total });
          if (done >= total && !op.done) op.finish();
        });
      }
    });
  }

  function rttMeasure(bssid, t, serial) {
    const ap = world.ap(bssid);
    const profile = ap ? profiles.get(ap.bssid) : null;
    if (!ap || !profile) return { bssid, ok: false };
    const pos = walker.posAt(t);
    if (world.meanRssi(ap, pos) < -88) return { bssid, ok: false }; // longe demais para responder
    const d = Math.hypot(ap.x - pos.x, ap.y - pos.y, ap.z - pos.z);
    return {
      bssid,
      ok: true,
      // Em milímetros, como o Android; colado no roteador a medida pode sair um pouco negativa.
      distM: round3(d + profile.rttSigma * hashGaussian(noise, 'rtt', bssid, serial)),
      stdM: round3(profile.rttSigma * (0.5 + 0.7 * hashUniform(noise, 'rtt-std', bssid, serial))),
      rssi: world.track(ap, pos, pos.heading, t),
      attempts: 8,
      successes: 8 - Math.floor(3 * hashUniform(noise, 'rtt-ok', bssid, serial)),
    };
  }

  // Como o RttRanger do Android: uma resposta por BSSID pedido, na ordem do pedido; só é medido
  // quem está na última varredura anunciando 802.11mc (no máximo 10); o resto sai com ok:false.
  function startRtt(args) {
    if (!Array.isArray(args.bssids)) throw badArgs('bssids');
    const wanted = [];
    for (const b of args.bssids) {
      if (typeof b !== 'string' || wanted.length >= 64) continue;
      const bssid = b.trim().toLowerCase();
      if (!wanted.includes(bssid)) wanted.push(bssid);
    }
    if (!wanted.length) return { results: [] };
    const failed = () => wanted.map((bssid) => ({ bssid, ok: false }));
    const targets = canScan() && cache ? cache.aps.filter((a) => a.rttResponder && wanted.includes(a.bssid)).slice(0, RTT_MAX_PEERS) : [];
    if (!targets.length) return { results: failed() };
    const serial = ++rttSerial;
    const measured = new Set(targets.map((a) => a.bssid));
    return new Promise((resolve) => {
      const op = { timer: null, done: false };
      const settle = (results) => {
        if (op.done) return;
        op.done = true;
        drop(op.timer);
        ops.delete(op);
        resolve({ results });
      };
      op.finish = () => settle(failed());
      // O Android costuma responder em 1 a 2 s.
      op.timer = after(1 + 0.6 * hashUniform(noise, 'rtt-wait', serial), () =>
        settle(wanted.map((bssid) => (measured.has(bssid) && canScan() ? rttMeasure(bssid, simT, serial) : { bssid, ok: false }))),
      );
      ops.add(op);
    });
  }

  // Quanto o Wi-Fi deixa passar agora (Mb/s úteis), na descida e na subida: taxa física
  // descontada do protocolo e do tempo em que o canal está ocupado por outros.
  function wifiCapacity(t) {
    const pos = walker.posAt(t);
    const rates = linkRates(link, world.track(link, pos, pos.heading, t));
    const profile = profiles.get(link.bssid);
    const load = profile ? loadAt(profile, t) : null;
    const free = 1 - 0.5 * (load ? load.utilization : 0.2);
    return { down: (usableMbps(rates.rx ?? 0) ?? 0) * free, up: (usableMbps(rates.tx ?? 0) ?? 0) * free };
  }

  // Teste de velocidade: latência, download e upload contra um servidor "em São Paulo".
  // O resultado é o menor entre o plano da casa e o que o Wi-Fi deixa passar onde a pessoa está.
  function startSpeedTest(args) {
    const mode = args.mode === undefined ? 'full' : args.mode;
    if (mode !== 'full' && mode !== 'light') throw badArgs('mode');
    if (speedOp) speedOp.finish('cancelled'); // um teste por vez
    const serial = ++speedSerial;
    const light = mode === 'light';
    const phaseS = light ? 3 : 8;
    // O modo leve para cedo para gastar poucos dados da franquia.
    const cap = light ? { download: 25e6, upload: 10e6 } : { download: Infinity, upload: Infinity };
    const probes = light ? 5 : 8;
    const u = (...k) => hashUniform(noise, 'speed', serial, ...k);
    const lo = 7 + 12 * hashUniform(noise, 'speed-server');
    const server = { lo, hi: lo + 3, wifi: true };
    return new Promise((resolve) => {
      const op = { timer: null, done: false, bytesDown: 0, bytesUp: 0 };
      const result = {};
      op.finish = (error) => {
        if (op.done) return;
        op.done = true;
        drop(op.timer);
        ops.delete(op);
        if (speedOp === op) speedOp = null;
        const bytes = { bytesDown: Math.round(op.bytesDown), bytesUp: Math.round(op.bytesUp) };
        resolve(error ? { ok: false, error, ...bytes } : { ok: true, ...result, ...bytes, server: SPEED_SERVER });
      };
      const offline = () => !state.wifi || !link;

      const transfer = (phase, done) => {
        const plan = (phase === 'download' ? net.downMbps : net.upMbps) * (0.9 + 0.08 * u(phase, 'plan'));
        const startedAt = simT;
        let bytes = 0;
        let average = 0;
        let steadySum = 0;
        let steadyN = 0;
        const tick = (k) => {
          if (offline()) {
            op.finish('offline');
            return;
          }
          const elapsed = simT - startedAt;
          const room = phase === 'download' ? wifiCapacity(simT).down : wifiCapacity(simT).up;
          // Começa devagar (o TCP vai abrindo a janela) e depois oscila em torno do teto.
          const now = Math.min(plan, room) * (1 - Math.exp(-elapsed / 0.25)) * (0.94 + 0.12 * u(phase, k));
          bytes += now * 125000 * SPEED_TICK_S;
          average = k === 1 ? now : 0.6 * average + 0.4 * now;
          // A arrancada não entra na média do resultado.
          if (elapsed >= (light ? 0.4 : 1) - 1e-9) {
            steadySum += now;
            steadyN += 1;
          }
          if (phase === 'download') op.bytesDown = bytes;
          else op.bytesUp = bytes;
          const finished = elapsed >= phaseS - 1e-9 || bytes >= cap[phase];
          const progress = finished ? 1 : round3(Math.max(elapsed / phaseS, bytes / cap[phase]));
          emit('speed', { phase, progress, mbps: round2(average), bytes: Math.round(bytes) });
          if (op.done) return;
          if (!finished) op.timer = after(SPEED_TICK_S, () => tick(k + 1));
          else done(round2(steadyN ? steadySum / steadyN : average));
        };
        op.timer = after(SPEED_TICK_S, () => tick(1));
      };

      const latency = (k, times) => {
        if (offline()) {
          op.finish('offline');
          return;
        }
        const ms = probeMs(server, 'speed', serial, k);
        if (ms !== null) times.push(ms);
        const event = { phase: 'latency', progress: round3(k / probes) };
        if (ms !== null) event.ms = ms;
        event.bytes = k * 640; // cada medida é uma requisição minúscula
        emit('speed', event);
        if (op.done) return;
        if (k < probes) {
          op.timer = after(SPEED_TICK_S, () => latency(k + 1, times));
          return;
        }
        if (times.length) {
          const sorted = [...times].sort((a, b) => a - b);
          result.latencyMs = round1(sorted[Math.floor(sorted.length / 2)]);
          let sum = 0;
          for (let i = 1; i < times.length; i++) sum += Math.abs(times[i] - times[i - 1]);
          result.jitterMs = round1(times.length > 1 ? sum / (times.length - 1) : 0);
        }
        transfer('download', (down) => {
          result.downMbps = down;
          transfer('upload', (up) => {
            result.upMbps = up;
            op.finish(null);
          });
        });
      };

      speedOp = op;
      ops.add(op);
      op.timer = after(SPEED_TICK_S, () => latency(1, []));
    });
  }

  // O Android responde o pedido e, logo depois, reenvia o estado (mesmo que nada tenha mudado).
  function requestPermission() {
    const announce = () => after(0, () => emit('status', statusNow()));
    if (state.permission === 'granted') {
      announce();
      return statusNow();
    }
    return new Promise((resolve) => {
      const op = { timer: null, done: false };
      op.finish = () => {
        if (op.done) return;
        op.done = true;
        drop(op.timer);
        ops.delete(op);
        resolve(statusNow());
      };
      // Negada em definitivo: o Android nem mostra a janela e responde na hora.
      op.timer = after(state.permission === 'blocked' ? 0.05 : 0.9, () => {
        const sawIdentity = seesIdentity();
        if (state.permission === 'denied') {
          let next = state.permissionReply;
          if (next === 'denied') {
            denials += 1;
            if (denials >= 2) next = 'blocked';
          }
          state.permission = next;
        }
        op.finish();
        announce();
        // com a permissão o Android passa a dizer em que rede o celular está: reenvia a conexão
        after(0, () => announceIdentity(sawIdentity));
      });
      ops.add(op);
    });
  }

  // --- métodos "de aparelho" ---------------------------------------------------

  const browser = () => (typeof navigator === 'object' && navigator ? navigator : null);
  let wakeLock = null;
  const blobs = new Set();

  function keepAwake(args) {
    if (typeof args.on !== 'boolean') throw badArgs('on');
    device.keepAwake = args.on;
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
    if (args.ms !== undefined && !isNumber(args.ms)) throw badArgs('ms');
    const ms = clampArg(args.ms, 0, 10000, 20);
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
    const color = typeof args.color === 'string' ? args.color.trim() : '';
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) throw badArgs('color');
    device.bars = { color, dark: args.dark === true };
    if (typeof document === 'object' && document && typeof document.querySelector === 'function') {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', color);
    }
    return { ok: true };
  }

  function share(args) {
    if (typeof args.text !== 'string') throw badArgs('text');
    const title = typeof args.title === 'string' ? args.title : '';
    const text = args.text;
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
        return nav.share(title ? { title, text } : { text }).then(
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
    if (typeof args.name !== 'string' || !args.name.trim()) throw badArgs('name');
    const hasText = typeof args.text === 'string';
    const hasBase64 = typeof args.base64 === 'string';
    if (hasText === hasBase64) throw badArgs('text ou base64');
    const data = hasText ? args.text : decodeBase64(args.base64);
    if (data === null) throw badArgs('base64');
    if (data.length > MAX_FILE_BYTES) return { ok: false }; // grande demais
    const name = sanitizeFileName(args.name);
    const rawMime = typeof args.mime === 'string' ? args.mime.trim().toLowerCase() : '';
    const mime = /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9*][a-z0-9.+*-]{0,80}$/.test(rawMime) ? rawMime : 'application/octet-stream';
    device.lastFile = { name, mime, size: data.length };
    if (hasText) device.lastFile.text = args.text;
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
    const effect = typeof args.which === 'string' && Object.prototype.hasOwnProperty.call(SETTINGS, args.which) ? SETTINGS[args.which] : null;
    if (!effect) throw badArgs('which');
    // Na volta das configurações o Android reenvia o estado, tenha mudado ou não.
    after(1.2, () => applyState(effect, true));
    return { ok: true };
  }

  function watchRssi(args) {
    if (args.intervalMs !== undefined && !isNumber(args.intervalMs)) throw badArgs('intervalMs');
    if (rssiWatch) drop(rssiWatch.timer);
    rssiWatch = { intervalS: clampArg(args.intervalMs, RSSI_MIN_MS, RSSI_MAX_MS, 1000) / 1000, timer: null };
    rssiWatch.timer = after(0, rssiTick); // a primeira amostra sai logo; as outras, no intervalo
    return { ok: true };
  }

  function cancelOp(args) {
    if (args.op === 'ping') {
      if (pingOp) pingOp.finish(true);
    } else if (args.op === 'lan') {
      if (lanOp) lanOp.finish();
    } else if (args.op === 'speed') {
      if (speedOp) speedOp.finish('cancelled');
    } else {
      throw badArgs('op');
    }
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
    watchRssi,
    unwatchRssi: () => {
      if (rssiWatch) drop(rssiWatch.timer);
      rssiWatch = null;
      return { ok: true };
    },
    openSettings,
    keepAwake,
    vibrate,
    setBars,
    share,
    saveFile,
    cancel: cancelOp,
  };

  const ASYNC = {
    requestPermission,
    scan: requestScan,
    rtt: startRtt,
    ping: startPing,
    lanScan: startLanScan,
    speedTest: startSpeedTest,
  };

  const own = (table, method) => (typeof method === 'string' && Object.prototype.hasOwnProperty.call(table, method) ? table[method] : null);

  // Como no Android: sem argumentos vale {}; qualquer coisa que não seja um objeto é erro.
  function argsOf(args) {
    if (args === undefined || args === null) return {};
    if (typeof args !== 'object' || Array.isArray(args)) throw badArgs();
    return args;
  }

  function call(method, args) {
    if (disposed) throw new Error(ERR_CLOSED);
    const fn = own(SYNC, method);
    if (!fn) throw new Error((own(ASYNC, method) ? ERR_ASYNC_ONLY : ERR_UNKNOWN) + method);
    return enter(() => fn(argsOf(args)));
  }

  function callAsync(method, args) {
    if (disposed) return Promise.reject(new Error(ERR_CLOSED));
    // Método de resposta imediata chamado pelo caminho assíncrono: o Android atende do mesmo jeito.
    const fn = own(ASYNC, method) || own(SYNC, method);
    if (!fn) return Promise.reject(new Error(ERR_UNKNOWN + method));
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

  // Como o onDestroy do Android: ninguém fica esperando; cada operação responde com o que já tinha.
  function dispose() {
    if (disposed) return;
    const pending = [...ops];
    disposed = true; // daqui em diante nada é emitido nem agendado
    for (const op of pending) op.finish(op === speedOp ? 'cancelled' : true);
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

  const patchOf = (patch) => (patch && typeof patch === 'object' ? patch : {});

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
    /** Rede local simulada: {gateway, ip, prefix, dns, downMbps, upMbps...}. */
    get network() {
      return net;
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
    setState: (patch) => enter(() => applyState(patchOf(patch))),
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
        const nextSeed = toSeed(newSeed, seed);
        const built = buildWorld(id, nextSeed); // mundo que não existe falha aqui, antes de mexer em qualquer coisa
        if (pingOp) pingOp.finish(true);
        if (lanOp) lanOp.finish();
        if (speedOp) speedOp.finish('cancelled');
        drop(pendingScan);
        pendingScan = null;
        installWorld(built, nextSeed, walker.mode);
        if (state.wifi) {
          emit('connection', connectionAt(simT));
          emit('scan', publish(simT, true, 'system'));
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
  let first;
  try {
    first = buildWorld(options.world ?? 'apartamento', seed);
  } catch (err) {
    // Mundo que não existe (erro de digitação na URL): melhor abrir o padrão do que nada.
    report(err);
    first = buildWorld('apartamento', seed);
  }
  installWorld(first, seed, mode);
  systemRng = createRng('wrx-system-scan', seed, worldId);
  scheduleSystemScan();
  after(1, linkTick);
  ticker = clock.setTimeout(tick, SIM_TICK_MS);
  arm();
  live = sim;

  return { call, callAsync, dispose, sim };
}
