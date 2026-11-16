// O estado único do app. As telas leem daqui e nunca pedem dados de varredura à ponte.
//
// ---------------------------------------------------------------------------------------------
// COMO USAR (as telas recebem o store em ctx.store)
//
//   const state = store.get();                                // retrato atual (não altere os objetos)
//   const off = store.subscribe((s) => s.aps, (aps, antes, state) => { ... });
//       O ouvinte roda quando o valor escolhido muda (comparação por ===). Tudo o que muda no
//       estado é trocado por um objeto novo, então `(s) => s.aps` dispara uma vez por varredura.
//       Opções: { immediate: true } chama já com o valor atual; { equal: shallowEqual } para
//       seletores que montam um objeto/lista a cada chamada.
//       Dentro de uma tela, o que for inscrito por ctx.store é cancelado sozinho ao sair dela.
//
// ---------------------------------------------------------------------------------------------
// FORMA DO ESTADO
//
//   backend      'native' | 'sim' | null       quem responde: o celular ou o simulador (modo demonstração)
//   info         DeviceInfo | null             (bridge.js) modelo, versão do Android, faixas que o celular suporta
//   status       Status | null                 (bridge.js) Wi-Fi/localização/permissão/limite; canScan
//   connection   Connection | null             (bridge.js) a rede em que o celular está conectado
//                                              ATENÇÃO: rssi e velocidades daqui são do momento em que a conexão
//                                              foi informada (o Android só a reenvia quando muda de rede ou de rádio).
//                                              Para o sinal de agora use liveConnection() de ui/networks-logic.js
//   rssi         RssiSample | null             última leitura do sinal da rede conectada (~1 por segundo)
//   theme        'dark' | 'light'              tema em uso (já resolvido quando o ajuste é "sistema")
//   settings     Settings                      (prefs.js) theme, scanIntervalS, demo, demoWorld, units, tipsDismissed
//   favorites    Set<string>                   "minhas redes": SSIDs marcados pelo usuário (fica salvo)
//   own          Set<string>                   BSSIDs "da casa": o AP conectado, os outros rádios do mesmo
//                                              aparelho e todos os APs das redes favoritas
//   clone        {bssid, ssids:string[]}|null  outro aparelho anunciando o BSSID do roteador conectado com
//                                              OUTRO nome de rede (visto na última varredura). Essa entrada
//                                              não entra em `aps`: o endereço é do roteador do usuário, e
//                                              mostrá-la ali faria o app falar dela como se fosse a rede dele
//   vendorsReady boolean                       a tabela de fabricantes já carregou
//
//   scan         a última varredura:
//     seq          número de varreduras recebidas desde que o app abriu (0 = nenhuma ainda)
//     ts           relógio do celular quando a lista foi lida (ms desde 1970) | null
//     receivedAt   relógio do app quando o evento chegou | null
//     freshAt      relógio do app quando chegou a última lista NOVA (fresh) | null
//     dataAt       relógio do app de quando os dados da tela são: igual a freshAt ou, se só chegou
//                  lista em cache, estimado pela idade das leituras | null    <- use para "atualizado há X"
//     fresh        true = varredura nova; false = lista em cache (pedido recusado/limitado)
//     source       'request' | 'system' | 'cache' | null
//     count        quantos BSSIDs vieram
//     scanning     há uma busca em andamento
//     lastAccepted o último pedido de busca foi aceito? (null = nenhum pedido ainda)
//     lastReason   motivo da última recusa ('throttled', ...) | null
//
//   loop         ScanLoopState (scan-loop.js): mode, paused, throttled, intervalMs, nextAt...
//                loop.throttled === true -> o Android está limitando as buscas (mostre a idade dos dados)
//
//   aps          Ap[]       um por BSSID, do sinal mais forte para o mais fraco (por `rssi`, a última leitura;
//                           quem quiser uma ordem mais calma reordena por `rssiSmooth`). Campos do Ap de core/model.js
//                           (id, bssid, ssid, hidden, name, rssi, quality, level, freq, band, channel, occ,
//                           widthMHz, security, ie, gen, standard, standardLabel, nss, stations, utilization,
//                           distanceM, ageMs, stale, randomizedMac, rttResponder, raw...), os do ApTracker
//                           (rssiSmooth, firstSeen, lastSeen, seenCount) MAIS os que o store acrescenta:
//                             vendor       nome do fabricante pelo MAC | null
//                             vendorGuess  true = fabricante provável (BSSID virtual do roteador)
//                             connected    é o BSSID em que o celular está conectado (e o nome não contradiz
//                                          o da conexão: veja `clone`)
//                             favorite     o SSID está em "minhas redes" (uma rede ABERTA com o nome de uma
//                                          rede protegida do usuário não herda o "minha": veja mineBySecurity)
//                             own          o BSSID está em state.own
//                           `ageMs` e `stale` contam a partir da última varredura (stale = não foi ouvido nela).
//                           Um BSSID sai da lista depois de 90 s sem ser ouvido; com a lista cheia demais
//                           (mais de CROWD_APS), quem foi ouvido uma única vez sai assim que deixa de ser ouvido.
//   devices      aparelhos físicos (core/model.js groupByDevice): {id, bssids, aps, ssids, bands, bestRssi}
//   networks     redes por nome (core/model.js groupBySsid): {key, ssid, name, hidden, security, aps,
//                devices, bands, best, mesh}
//                Os Ap dentro de devices/networks são os mesmos objetos de `aps`.
//
// Derivados que não ficam no estado:
//   store.apById(bssid)     -> Ap | null (da lista atual)
//   store.history(bssid)    -> histórico de sinal daquele BSSID (ApTracker.history)
//   store.rssiHistory()     -> RssiSample[] dos últimos minutos da rede conectada (o mais novo por último)
//                              store.rssiHistory(n) devolve só as n leituras mais novas
//   store.connectedAp()     -> Ap | null
//
// ---------------------------------------------------------------------------------------------
// AÇÕES
//
// Para as telas:
//   toggleFavorite(ssid) -> boolean      marca/desmarca "minha rede"; devolve o estado novo
//   setFavorite(ssid, on)
//   isFavorite(ssid) / isOwn(bssid)
//   updateSettings(patch) -> Settings    grava nos ajustes (validado por prefs.js) e avisa quem escuta
//   dismissTip(id) / resetTips()         dicas dispensáveis (components.tipBanner)
//   clearSavedData()                     apaga favoritos e ajustes guardados (volta aos padrões)
//
// Só para o main.js e o scan-loop.js (a "fiação" do app):
//   setBackend(kind) · setInfo(info) · setStatus(status) · setConnection(conn) · setRssi(sample)
//   ingestScan(scanEvent) · setLoop(loopState) · setTheme('dark'|'light') · setVendorLookup(lookup)
//   resetScanData()                      ao trocar de celular de verdade para simulador (e vice-versa)
// ---------------------------------------------------------------------------------------------

import { ApTracker, groupByDevice, groupBySsid, securityFamily } from './core/model.js';
import { DEFAULT_SETTINGS, sanitizeSettings } from './prefs.js';

/** Um BSSID que não aparece há mais tempo que isto sai da lista. */
export const MAX_AP_AGE_MS = 90_000;
/** Quantas leituras do sinal da rede conectada ficam guardadas (~15 min a 1 por segundo). */
export const RSSI_HISTORY_MAX = 900;
/**
 * Lista "cheia demais": um lugar com centenas de redes ou alguém por perto transmitindo redes
 * falsas aos montes (um ESP8266 inventa centenas de BSSIDs por busca). Acima disto, quem foi
 * ouvido uma única vez e não veio na última busca sai logo, em vez de ficar 90 s: cada análise
 * do app custa mais que o dobro quando a lista dobra.
 */
export const CROWD_APS = 300;
/** "Não veio na última busca", para a regra acima (as leituras de uma busca chegam com até poucos segundos). */
export const CROWD_GONE_MS = 5000;

/** O Android entrega o nome da rede conectada entre aspas em algumas versões; "<unknown ssid>" = não informou. */
function connectionName(connection) {
  const raw = connection && typeof connection.ssid === 'string' ? connection.ssid : '';
  const name = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return name === '<unknown ssid>' ? '' : name;
}

/**
 * O nome que a varredura dá a um BSSID combina com o nome da rede em que o celular está?
 * Qualquer aparelho pode transmitir com o endereço (BSSID) do roteador de outra pessoa; o nome é
 * o que o celular confirmou ao conectar. Sem como comparar (rede oculta, conexão sem nome) vale
 * "combina". O "\uFFFD" é o que o Android põe onde não conseguiu decodificar um nome antigo com
 * acentos: ali qualquer letra serve.
 * @param {string} scanSsid  nome na varredura ('' = oculta)
 * @param {string} connSsid  nome da conexão, já limpo ('' = desconhecido)
 */
export function sameNetworkName(scanSsid, connSsid) {
  if (typeof scanSsid !== 'string' || scanSsid === '' || typeof connSsid !== 'string' || connSsid === '') return true;
  if (scanSsid === connSsid) return true;
  if (!scanSsid.includes('\uFFFD')) return false;
  const a = Array.from(scanSsid);
  const b = Array.from(connSsid);
  return a.length === b.length && a.every((ch, i) => ch === '\uFFFD' || ch === b[i]);
}

/** Comparação rasa (um nível) para seletores que devolvem objeto ou lista. */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

const EMPTY_SCAN = Object.freeze({
  seq: 0,
  ts: null,
  receivedAt: null,
  freshAt: null,
  dataAt: null,
  fresh: false,
  source: null,
  count: 0,
  scanning: false,
  lastAccepted: null,
  lastReason: null,
});

const EMPTY_LOOP = Object.freeze({
  running: false,
  mode: 'normal',
  scanning: false,
  paused: 'stopped',
  throttled: false,
  intervalMs: 10_000,
  nextAt: null,
  lastRequestAt: null,
  lastAccepted: null,
  lastReason: null,
  lastFreshAt: null,
  lastEventAt: null,
});

const macOf = (x) => (typeof x === 'string' ? x.toLowerCase() : '');

/**
 * @param {object} [deps]
 * @param {ReturnType<import('./prefs.js').createPrefs>} [deps.prefs]  sem isto nada é gravado (testes)
 * @param {() => number} [deps.now]
 * @param {(err:unknown) => void} [deps.onError]  chamado quando um ouvinte lança (o store segue funcionando)
 */
export function createStore({ prefs = null, now = Date.now, onError } = {}) {
  let tracker = null; // criado na primeira varredura, já sabendo a versão do Android
  let droppedClone = null; // {bssid, ssids}: entradas com o BSSID conectado e outro nome, tiradas da última varredura
  let vendors = null; // OuiLookup de core/oui.js
  let rssiLog = [];

  let state = {
    backend: null,
    info: null,
    status: null,
    connection: null,
    rssi: null,
    theme: 'dark',
    settings: prefs ? prefs.loadSettings() : sanitizeSettings(DEFAULT_SETTINGS),
    favorites: new Set(prefs ? prefs.loadFavorites() : []),
    own: new Set(),
    clone: null,
    vendorsReady: false,
    scan: EMPTY_SCAN,
    loop: EMPTY_LOOP,
    aps: [],
    devices: [],
    networks: [],
  };
  let byId = new Map();

  const subs = new Set(); // {selector, listener, equal, value}
  let depth = 0; // ações aninhadas: avisa só quando a de fora termina
  let dirty = false;

  function report(err) {
    console.error('[store] erro num ouvinte', err);
    if (onError) {
      try {
        onError(err);
      } catch {
        // quem trata erro não pode derrubar o store
      }
    }
  }

  function notify() {
    for (const sub of [...subs]) {
      if (!subs.has(sub)) continue;
      let value;
      try {
        value = sub.selector(state);
      } catch (err) {
        report(err);
        continue;
      }
      if (sub.equal(value, sub.value)) continue;
      const prev = sub.value;
      sub.value = value;
      try {
        sub.listener(value, prev, state);
      } catch (err) {
        report(err);
      }
    }
  }

  /** Troca campos do estado; os ouvintes são avisados uma vez, no fim da ação mais externa. */
  function commit(patch) {
    state = { ...state, ...patch };
    dirty = true;
    if (depth === 0) flush();
  }

  function flush() {
    // um ouvinte pode disparar outra ação; repete até assentar
    let guard = 0;
    while (dirty && guard++ < 50) {
      dirty = false;
      notify();
    }
  }

  function action(fn) {
    depth += 1;
    try {
      return fn();
    } finally {
      depth -= 1;
      if (depth === 0) flush();
    }
  }

  // --- listas derivadas ------------------------------------------------------------------------

  function vendorOf(bssid) {
    if (!vendors) return null;
    try {
      return vendors.vendor(bssid) || null;
    } catch {
      return null;
    }
  }

  /**
   * Quais redes com nome favorito são mesmo "minhas", olhando a segurança. "Minha rede" é marcada
   * pelo nome, e nome qualquer um copia: uma rede ABERTA com o nome de uma rede protegida do
   * usuário não é o roteador dele (é o truque clássico para atrair o celular). Regras:
   *   - conectado a uma rede com esse nome: só valem os APs da mesma família de segurança dela;
   *   - senão: uma rede aberta não vale enquanto houver por perto uma protegida com o mesmo nome.
   * Uma rede que só existe aberta (a de convidados do próprio usuário) continua valendo.
   * @returns {(ap:object) => boolean}
   */
  function mineBySecurity(aps, favorites) {
    const families = new Map(); // nome favorito -> famílias de segurança vistas com esse nome
    const connected = new Map(); // nome favorito -> família do AP conectado
    for (const ap of aps) {
      if (!ap.ssid || !favorites.has(ap.ssid)) continue;
      const family = securityFamily(ap.security);
      let seen = families.get(ap.ssid);
      if (!seen) families.set(ap.ssid, (seen = new Set()));
      seen.add(family);
      if (ap.connected) connected.set(ap.ssid, family);
    }
    return (ap) => {
      if (!ap.ssid || !favorites.has(ap.ssid)) return false;
      const family = securityFamily(ap.security);
      if (family === 'unknown') return true; // sem dado de segurança não há o que contradizer
      const inUse = connected.get(ap.ssid);
      if (inUse !== undefined && inUse !== 'unknown') return family === inUse;
      if (family !== 'open') return true;
      for (const other of families.get(ap.ssid)) if (other !== 'open' && other !== 'unknown') return false;
      return true;
    };
  }

  /** BSSIDs "da casa": o conectado, os outros rádios do mesmo aparelho e os APs das redes favoritas. */
  function ownSet(aps, devices, connectedBssid) {
    const own = new Set();
    for (const ap of aps) if (ap.favorite) own.add(ap.bssid);
    if (connectedBssid) {
      own.add(connectedBssid);
      for (const device of devices) {
        const members = Array.isArray(device.bssids) ? device.bssids : [];
        if (members.includes(connectedBssid)) for (const bssid of members) own.add(bssid);
      }
    }
    return own;
  }

  /** Refaz aps/devices/networks/own a partir do que o rastreador tem. Uma vez por varredura. */
  function derive(extra = {}) {
    const connection = 'connection' in extra ? extra.connection : state.connection;
    const favorites = 'favorites' in extra ? extra.favorites : state.favorites;
    const connectedBssid = connection && connection.connected ? macOf(connection.bssid) : '';

    // idades contadas a partir da última varredura (o padrão do rastreador), não de "agora":
    // `stale` quer dizer "não foi ouvido na última", mesmo que ela tenha sido há meio minuto
    let aps = tracker ? tracker.list({ maxAgeMs: MAX_AP_AGE_MS }) : [];

    // O BSSID conectado com OUTRO nome de rede: alguém por perto está transmitindo com o endereço
    // do roteador do usuário. Essa entrada não é a rede dele: fica fora da lista (senão todas as
    // telas falariam dela como "a sua rede": aberta, noutro canal...) e é anotada em `clone`.
    let clone = null;
    if (connectedBssid) {
      const name = connectionName(connection);
      const at = aps.findIndex((ap) => ap.bssid === connectedBssid);
      if (at >= 0 && !sameNetworkName(aps[at].hidden ? '' : aps[at].ssid, name)) {
        clone = { bssid: connectedBssid, ssids: [aps[at].ssid] };
        aps.splice(at, 1);
      } else if (droppedClone && droppedClone.bssid === connectedBssid) {
        clone = droppedClone; // veio junto com o roteador de verdade na última varredura
      }
    }
    // lista cheia demais: os ouvidos uma única vez saem assim que deixam de ser ouvidos
    if (aps.length > CROWD_APS) {
      aps = aps.filter((ap) => !(ap.seenCount <= 1 && ap.ageMs > CROWD_GONE_MS) || ap.bssid === connectedBssid || (!!ap.ssid && favorites.has(ap.ssid)));
    }

    for (const ap of aps) {
      const v = vendorOf(ap.bssid);
      ap.vendor = v && v.name ? v.name : null;
      ap.vendorGuess = !!(v && v.guess);
      ap.connected = !!connectedBssid && ap.bssid === connectedBssid;
    }
    const mine = mineBySecurity(aps, favorites);
    for (const ap of aps) ap.favorite = mine(ap);
    // o rastreador ordena pelo sinal suavizado; as telas mostram `rssi`, então a ordem segue ele
    aps.sort((a, b) => (b.rssi ?? -Infinity) - (a.rssi ?? -Infinity) || (a.bssid < b.bssid ? -1 : a.bssid > b.bssid ? 1 : 0));
    const devices = groupByDevice(aps);
    const networks = groupBySsid(aps, { devices });
    const own = ownSet(aps, devices, connectedBssid);
    for (const ap of aps) ap.own = own.has(ap.bssid);
    byId = new Map(aps.map((ap) => [ap.bssid, ap]));
    return { ...extra, aps, devices, networks, own, clone };
  }

  /**
   * Duas entradas com o BSSID conectado na mesma varredura (o roteador e alguém usando o endereço
   * dele): o rastreador guarda uma por BSSID, então a do roteador de verdade (a que tem o nome da
   * conexão) tem de ser a que fica. Sem entrada repetida, a varredura passa como veio.
   */
  function preferConnectedName(ev) {
    const conn = state.connection;
    const bssid = conn && conn.connected ? macOf(conn.bssid) : '';
    const name = bssid ? connectionName(conn) : '';
    if (!name) return ev;
    let same = 0;
    let genuine = 0;
    for (const ap of ev.aps) {
      if (!ap || macOf(ap.bssid) !== bssid) continue;
      same += 1;
      if (typeof ap.ssid === 'string' && ap.ssid !== '' && sameNetworkName(ap.ssid, name)) genuine += 1;
    }
    if (same < 2 || genuine === 0) return ev;
    const isClone = (ap) => !!ap && macOf(ap.bssid) === bssid && !(typeof ap.ssid === 'string' && ap.ssid !== '' && sameNetworkName(ap.ssid, name));
    const ssids = [];
    for (const ap of ev.aps) {
      if (isClone(ap) && typeof ap.ssid === 'string' && ap.ssid !== '' && !ssids.includes(ap.ssid) && ssids.length < 4) ssids.push(ap.ssid.slice(0, 64));
    }
    if (ssids.length) droppedClone = { bssid, ssids };
    return { ...ev, aps: ev.aps.filter((ap) => !isClone(ap)) };
  }

  // --- API -------------------------------------------------------------------------------------

  const store = {
    /** O estado atual. Trate como somente leitura. */
    get: () => state,

    /**
     * @template T
     * @param {(state:object) => T} selector
     * @param {(value:T, prev:T, state:object) => void} listener
     * @param {{immediate?:boolean, equal?:(a:T, b:T) => boolean}} [options]
     * @returns {() => void} cancela a inscrição
     */
    subscribe(selector, listener, { immediate = false, equal = Object.is } = {}) {
      const sub = { selector, listener, equal, value: selector(state) };
      subs.add(sub);
      if (immediate) {
        try {
          listener(sub.value, undefined, state);
        } catch (err) {
          report(err);
        }
      }
      return () => subs.delete(sub);
    },

    /** Agrupa várias ações: os ouvintes são avisados uma vez só, no fim. */
    batch: (fn) => action(fn),

    apById: (bssid) => byId.get(macOf(bssid)) || null,
    connectedAp: () => state.aps.find((ap) => ap.connected) || null,
    history: (bssid) => (tracker ? tracker.history(macOf(bssid)) : []),
    rssiHistory: (last) => (typeof last === 'number' && last > 0 ? rssiLog.slice(-Math.ceil(last)) : rssiLog.slice()),
    isFavorite: (ssid) => state.favorites.has(ssid),
    isOwn: (bssid) => state.own.has(macOf(bssid)),

    // --- fiação ---

    setBackend(kind) {
      commit({ backend: kind === 'native' || kind === 'sim' ? kind : null });
    },

    setInfo(info) {
      commit({ info: info && typeof info === 'object' ? info : null });
    },

    setStatus(status) {
      commit({ status: status && typeof status === 'object' ? status : null });
    },

    setConnection(connection) {
      const next = connection && typeof connection === 'object' ? connection : null;
      const idOf = (c) => (c && c.connected ? `${macOf(c.bssid)}|${connectionName(c)}` : '');
      const before = idOf(state.connection);
      const after = idOf(next);
      // só refaz as listas quando o BSSID (ou o nome) da rede conectada muda (a conexão é reenviada com frequência)
      if (before !== after) commit(derive({ connection: next }));
      else commit({ connection: next });
    },

    setRssi(sample) {
      if (!sample || typeof sample !== 'object' || typeof sample.rssi !== 'number') return;
      rssiLog.push(sample);
      if (rssiLog.length > RSSI_HISTORY_MAX) rssiLog = rssiLog.slice(-RSSI_HISTORY_MAX);
      commit({ rssi: sample });
    },

    /** @param {import('./bridge.js').ScanEvent} ev */
    ingestScan(ev) {
      if (!ev || typeof ev !== 'object' || !Array.isArray(ev.aps)) return;
      // Lista guardada pelo Android (não veio de uma busca nova) em que TODAS as leituras já passaram
      // da idade em que um BSSID sai da lista: se nada chegou antes dela, não conta como "uma busca".
      // Senão, ao abrir o app com o celular parado há alguns minutos, as telas afirmavam "Nenhuma rede
      // por perto" (a lista ficava vazia, com seq = 1) enquanto a primeira busca de verdade ainda rodava.
      // Com seq = 0 elas seguem em "Procurando redes por perto…" até chegar uma lista que valha.
      // Leitura sem idade não é tratada como velha; lista nova, mesmo vazia, sempre conta.
      if (ev.fresh === false && state.scan.seq === 0 && ev.aps.length > 0) {
        const usable = (ap) => !!ap && typeof ap === 'object' && !(typeof ap.ageMs === 'number' && ap.ageMs > MAX_AP_AGE_MS);
        if (!ev.aps.some(usable)) return;
      }
      const t = now();
      if (!tracker) tracker = new ApTracker({ sdk: state.info && typeof state.info.sdk === 'number' ? state.info.sdk : undefined });
      droppedClone = null;
      tracker.update(preferConnectedName(ev));
      const fresh = ev.fresh !== false;
      let dataAt = state.scan.dataAt;
      if (fresh) dataAt = t;
      else {
        // lista em cache: ela é tão velha quanto a leitura mais recente que traz
        let minAge = Infinity;
        for (const ap of ev.aps) if (ap && typeof ap.ageMs === 'number' && ap.ageMs >= 0 && ap.ageMs < minAge) minAge = ap.ageMs;
        if (Number.isFinite(minAge) && (dataAt === null || t - minAge > dataAt)) dataAt = t - minAge;
      }
      commit(
        derive({
          scan: {
            ...state.scan,
            seq: state.scan.seq + 1,
            ts: typeof ev.ts === 'number' ? ev.ts : t,
            receivedAt: t,
            freshAt: fresh ? t : state.scan.freshAt,
            dataAt,
            fresh,
            source: typeof ev.source === 'string' ? ev.source : null,
            count: ev.aps.length,
          },
        }),
      );
    },

    /** @param {import('./scan-loop.js').ScanLoopState} loop */
    setLoop(loop) {
      const scan = state.scan;
      const same = scan.scanning === loop.scanning && scan.lastAccepted === loop.lastAccepted && scan.lastReason === loop.lastReason;
      commit({
        loop,
        scan: same ? scan : { ...scan, scanning: loop.scanning, lastAccepted: loop.lastAccepted, lastReason: loop.lastReason },
      });
    },

    setTheme(theme) {
      const next = theme === 'light' ? 'light' : 'dark';
      if (next !== state.theme) commit({ theme: next });
    },

    /** @param {import('./core/oui.js').OuiLookup|null} lookup */
    setVendorLookup(lookup) {
      vendors = lookup && typeof lookup.vendor === 'function' ? lookup : null;
      commit(derive({ vendorsReady: !!(vendors && vendors.loaded !== false) }));
    },

    resetScanData() {
      tracker = null;
      droppedClone = null;
      rssiLog = [];
      commit(derive({ scan: EMPTY_SCAN, rssi: null, connection: null, status: null, info: null }));
    },

    // --- para as telas ---

    setFavorite(ssid, on) {
      if (typeof ssid !== 'string' || ssid === '') return false;
      const favorites = new Set(state.favorites);
      if (on) favorites.add(ssid);
      else favorites.delete(ssid);
      if (prefs) prefs.saveFavorites(favorites);
      commit(derive({ favorites }));
      return favorites.has(ssid);
    },

    toggleFavorite(ssid) {
      return store.setFavorite(ssid, !state.favorites.has(ssid));
    },

    /** @param {Partial<import('./prefs.js').Settings>} patch */
    updateSettings(patch) {
      const settings = prefs ? prefs.saveSettings({ ...state.settings, ...(patch || {}) }) : sanitizeSettings({ ...state.settings, ...(patch || {}) });
      commit({ settings });
      return settings;
    },

    dismissTip(id) {
      if (typeof id !== 'string' || !id || state.settings.tipsDismissed.includes(id)) return;
      store.updateSettings({ tipsDismissed: [...state.settings.tipsDismissed, id] });
    },

    resetTips() {
      store.updateSettings({ tipsDismissed: [] });
    },

    /** Apaga o que o app guardou aqui (favoritos e ajustes). Os mapas salvos são de mapping/storage. */
    clearSavedData() {
      if (prefs) prefs.clear();
      commit(derive({ favorites: new Set(), settings: sanitizeSettings(DEFAULT_SETTINGS) }));
    },
  };

  return store;
}
