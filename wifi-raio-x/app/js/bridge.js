// Porta única entre a interface (web) e o celular.
//
// CONTRATO — é a fonte da verdade para os três lados que precisam combinar:
//   1. Android (android/app/src/main/java/.../Bridge.java) injeta `window.WrxNative`:
//        String call(String method, String argsJson)               -> resposta imediata, em JSON
//        void   callAsync(int id, String method, String argsJson)  -> responde depois
//      e fala de volta com:
//        window.__wrx.resolve(id, resultado)   // resposta de um callAsync ({error:"..."} em caso de falha)
//        window.__wrx.emit(nome, dados)        // eventos (scan, rssi, status, ...)
//        window.__wrx.back()                   // botão "voltar": devolve true se a interface tratou
//                                              // (fechou um painel, voltou de tela); false = pode sair do app
//   2. O simulador (js/sim/backend.js) atende os mesmos métodos no navegador, nos
//      testes e no "modo demonstração" do app.
//   3. A interface usa só as funções exportadas aqui, sem saber quem responde.
//
// O lado nativo é propositalmente "burro": entrega os dados crus do Android e toda a
// interpretação (canais, segurança, elementos de informação...) acontece em js/core.

/**
 * Uma rede (um BSSID) como o Android entrega em WifiManager.getScanResults().
 * @typedef {Object} ScanAp
 * @property {string} bssid          MAC do rádio, minúsculo: "aa:bb:cc:dd:ee:ff"
 * @property {string} ssid           nome da rede; "" quando oculta
 * @property {number} level          sinal em dBm (ex.: -57)
 * @property {number} frequency      frequência central do canal primário de 20 MHz, em MHz (ex.: 2437)
 * @property {number} channelWidth   ScanResult.CHANNEL_WIDTH_*: 0=20 MHz, 1=40, 2=80, 3=160, 4=80+80, 5=320; -1 desconhecido
 * @property {number} centerFreq0    ScanResult.centerFreq0 (MHz) ou 0
 * @property {number} centerFreq1    ScanResult.centerFreq1 (MHz) ou 0
 * @property {string} capabilities   texto cru, ex.: "[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][WPS]"
 * @property {number} ageMs          há quanto tempo este BSSID foi ouvido pela última vez (agora - ScanResult.timestamp)
 * @property {number} [wifiStandard] ScanResult.WIFI_STANDARD_*: 0 desconhecido, 1 legado (a/b/g), 4 = 11n, 5 = 11ac, 6 = 11ax, 7 = 11ad, 8 = 11be (Android 11+)
 * @property {boolean} [rttResponder] o AP anuncia 802.11mc (FTM / Wi-Fi RTT)
 * @property {boolean} [passpoint]
 * @property {string} [venueName]
 * @property {string} [operatorName]
 * @property {string} [mld]          MAC do AP MLD (Wi-Fi 7), Android 13+
 * @property {{id:number, ext:number, hex:string}[]} [ies]  elementos de informação crus do beacon (Android 11+);
 *           `id` = Element ID, `ext` = Element ID Extension (0 quando não há), `hex` = corpo do elemento em hexadecimal
 */

/**
 * @typedef {Object} ScanEvent
 * @property {number} ts        relógio do celular (ms desde 1970) quando a lista foi lida
 * @property {boolean} fresh    true = veio de uma varredura nova; false = lista em cache (varredura recusada/limitada)
 * @property {'request'|'system'|'cache'} source  quem provocou: o app, o próprio Android, ou leitura do cache
 * @property {ScanAp[]} aps
 */

/**
 * @typedef {Object} DeviceInfo
 * @property {'android'|'sim'} platform
 * @property {number} sdk             Build.VERSION.SDK_INT (0 no simulador)
 * @property {string} release         versão do Android, ex.: "14"
 * @property {string} manufacturer
 * @property {string} model
 * @property {string} appVersion
 * @property {{b24:boolean, b5:boolean, b6:boolean, b60:boolean}} bands  faixas que o celular suporta
 * @property {number[]} standards     WIFI_STANDARD_* que o celular suporta (pode vir vazio antes do Android 11)
 * @property {boolean} rtt            o celular sabe medir distância por Wi-Fi RTT (802.11mc)
 */

/**
 * @typedef {Object} Status
 * @property {boolean} wifiEnabled
 * @property {boolean} locationEnabled   o Android só entrega a lista de redes com a Localização ligada
 * @property {'granted'|'denied'|'blocked'} permission  'blocked' = negada em definitivo (só pelas configurações do app)
 * @property {boolean|null} throttled    limite de varreduras do Android (4 a cada 2 min) ligado? null = não dá para saber
 * @property {boolean} canScan           wifiEnabled && locationEnabled && permission === 'granted'
 */

/**
 * @typedef {Object} Connection
 * @property {boolean} connected
 * @property {string} [ssid]
 * @property {string} [bssid]
 * @property {number} [rssi]          dBm
 * @property {number} [frequency]     MHz
 * @property {number} [linkSpeed]     Mbps (WifiInfo.getLinkSpeed)
 * @property {number} [txSpeed]       Mbps (Android 10+)
 * @property {number} [rxSpeed]       Mbps (Android 10+)
 * @property {number} [maxTxSpeed]    Mbps (Android 11+)
 * @property {number} [maxRxSpeed]    Mbps (Android 11+)
 * @property {number} [wifiStandard]  WIFI_STANDARD_* (Android 11+)
 * @property {number} [securityType]  WifiInfo.SECURITY_TYPE_* (Android 12+), -1 desconhecido
 * @property {boolean} [hidden]
 * @property {string} [ip]            IPv4 do celular
 * @property {number} [prefix]        tamanho do prefixo (ex.: 24)
 * @property {string} [gateway]
 * @property {string[]} [dns]
 * @property {string[]} [ipv6]
 * @property {string} [iface]         ex.: "wlan0"
 * @property {number} [mtu]
 * @property {number} [leaseSec]      duração do DHCP
 * @property {boolean} [validated]    o Android confirmou acesso à internet
 * @property {boolean} [metered]
 */

/**
 * @typedef {Object} RssiSample
 * @property {number} ts
 * @property {number} rssi
 * @property {string} bssid
 * @property {number} frequency
 * @property {number} [linkSpeed]
 * @property {number} [txSpeed]
 * @property {number} [rxSpeed]
 */

/**
 * @typedef {Object} RttResult
 * @property {string} bssid
 * @property {boolean} ok
 * @property {number} [distM]     distância medida, em metros
 * @property {number} [stdM]      desvio padrão, em metros
 * @property {number} [rssi]
 * @property {number} [attempts]
 * @property {number} [successes]
 */

/**
 * @typedef {Object} PingReply     evento 'ping'
 * @property {string} host
 * @property {number} seq
 * @property {boolean} ok
 * @property {number} [ms]
 *
 * @typedef {Object} PingSummary
 * @property {string} host
 * @property {'icmp'|'tcp'} method
 * @property {number} sent
 * @property {number} received
 * @property {number} lossPct
 * @property {number} [min]
 * @property {number} [avg]
 * @property {number} [max]
 * @property {number} [jitter]    média das diferenças entre respostas seguidas (ms)
 */

/**
 * @typedef {Object} LanDevice     evento 'lan'
 * @property {string} ip
 * @property {string} [host]       nome, quando o roteador/mDNS informa
 * @property {string} [mac]        só em Android antigo (o Android 11+ esconde)
 * @property {number} [ms]         tempo de resposta
 * @property {boolean} [self]      é este celular
 * @property {boolean} [gateway]   é o roteador
 */

// ---------------------------------------------------------------------------
// Tabela dos métodos (nome, argumentos -> resposta). `A` = assíncrono (callAsync).
//
//   info            {}                          -> DeviceInfo
//   status          {}                          -> Status
//   lastScan        {}                          -> ScanEvent          (lista em cache, sem varrer)
//   connection      {}                          -> Connection
//   watchRssi       {intervalMs}                -> {ok:true}          (passa a emitir 'rssi')
//   unwatchRssi     {}                          -> {ok:true}
//   openSettings    {which}                     -> {ok:boolean}       which: 'wifi' | 'location' | 'app' | 'developer' | 'panel'
//   keepAwake       {on}                        -> {ok:true}          mantém a tela ligada durante o mapeamento
//   vibrate         {ms}                        -> {ok:true}
//   setBars         {color, dark}               -> {ok:true}          cor (#rrggbb) das barras do sistema; dark = fundo escuro (ícones claros)
//   share           {title, text}               -> {ok:true}
//   saveFile        {name, mime, text|base64}   -> {ok:boolean}       abre o "compartilhar/salvar" do Android com o arquivo
//   cancel          {op}                        -> {ok:true}          op: 'ping' | 'lan'
// A requestPermission {}                        -> Status
// A scan            {}                          -> {accepted:boolean, reason?:string}  (o resultado chega no evento 'scan')
// A rtt             {bssids:string[]}           -> {results: RttResult[]}
// A ping            {host, count, timeoutMs}    -> PingSummary        (emite 'ping' a cada resposta)
// A lanScan         {}                          -> {devices: LanDevice[]}  (emite 'lan' a cada aparelho e 'lanProgress' {done,total})
//
// Eventos: 'scan' ScanEvent · 'rssi' RssiSample · 'status' Status · 'connection' Connection
//          'ping' PingReply · 'lan' LanDevice · 'lanProgress' {done:number,total:number}
// ---------------------------------------------------------------------------

const listeners = new Map(); // nome do evento -> Set<função>
const pending = new Map(); // id -> {resolve, reject}
let nextId = 1;
let backend = null; // {call(method,args), callAsync(method,args)} em uso
let backendKind = null; // 'native' | 'sim'
let backHandler = null; // função da interface para o botão "voltar" do Android

function emit(name, data) {
  const set = listeners.get(name);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(data);
    } catch (err) {
      console.error('[bridge] erro num ouvinte de', name, err);
    }
  }
}

function parse(json) {
  if (json == null || json === '') return null;
  if (typeof json !== 'string') return json;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Fala com o Android pelo objeto injetado no WebView. */
function nativeBackend(native) {
  return {
    call(method, args) {
      const out = parse(native.call(method, JSON.stringify(args ?? {})));
      if (out && out.error) throw new Error(out.error);
      return out;
    },
    callAsync(method, args) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        native.callAsync(id, method, JSON.stringify(args ?? {}));
      });
    },
  };
}

// O Android chama estas duas funções (veja o cabeçalho).
const hook = (globalThis.__wrx = globalThis.__wrx || {});
hook.emit = (name, data) => emit(name, parse(data));
hook.back = () => {
  try {
    return backHandler ? !!backHandler() : false;
  } catch {
    return false;
  }
};
hook.resolve = (id, result) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  const out = parse(result);
  if (out && out.error) p.reject(new Error(out.error));
  else p.resolve(out);
};

/** O app está rodando dentro do APK (com a ponte nativa disponível)? */
export function hasNative() {
  return typeof globalThis.WrxNative === 'object' && globalThis.WrxNative !== null;
}

/** Qual lado está respondendo agora: 'native' ou 'sim'. */
export function kind() {
  return backendKind;
}

/**
 * Escolhe quem responde. Sem argumento: Android quando existe, senão o simulador.
 * `options` vai para o simulador (mundo, semente...). Pode ser chamado de novo para
 * alternar entre o celular de verdade e o modo demonstração.
 * @param {'native'|'sim'} [which]
 * @param {object} [options]
 */
export async function connect(which, options) {
  const want = which || (hasNative() ? 'native' : 'sim');
  if (backend && backend.dispose) backend.dispose();
  if (want === 'native') {
    if (!hasNative()) throw new Error('ponte nativa indisponível');
    backend = nativeBackend(globalThis.WrxNative);
  } else {
    const mod = await import('./sim/backend.js');
    backend = mod.createSimBackend({ emit, ...(options || {}) });
  }
  backendKind = want;
  return want;
}

function need() {
  if (!backend) throw new Error('bridge.connect() ainda não foi chamado');
  return backend;
}

// Tudo devolve Promise, mesmo o que o Android responde na hora: a interface não
// precisa saber a diferença e o simulador pode ser assíncrono à vontade.
const sync = (method) => async (args) => need().call(method, args);
const asyncCall = (method) => async (args) => need().callAsync(method, args);

/** @returns {() => void} função que cancela a inscrição */
export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

/** @type {() => Promise<DeviceInfo>} */
export const info = sync('info');
/** @type {() => Promise<Status>} */
export const status = sync('status');
/** @type {() => Promise<ScanEvent>} */
export const lastScan = sync('lastScan');
/** @type {() => Promise<Connection>} */
export const connection = sync('connection');
/** @type {() => Promise<Status>} */
export const requestPermission = asyncCall('requestPermission');
/** Pede uma varredura nova. O resultado chega pelo evento 'scan'. @type {() => Promise<{accepted:boolean, reason?:string}>} */
export const scan = asyncCall('scan');

export const watchRssi = (intervalMs = 1000) => sync('watchRssi')({ intervalMs });
export const unwatchRssi = sync('unwatchRssi');
/** @type {(bssids: string[]) => Promise<{results: RttResult[]}>} */
export const rtt = (bssids) => asyncCall('rtt')({ bssids });
/** @type {(host: string, count?: number, timeoutMs?: number) => Promise<PingSummary>} */
export const ping = (host, count = 10, timeoutMs = 1000) => asyncCall('ping')({ host, count, timeoutMs });
/** @type {() => Promise<{devices: LanDevice[]}>} */
export const lanScan = asyncCall('lanScan');
export const cancel = (op) => sync('cancel')({ op });

export const openSettings = (which) => sync('openSettings')({ which });
export const keepAwake = (on) => sync('keepAwake')({ on: !!on });
export const vibrate = (ms = 20) => sync('vibrate')({ ms });
/** Cor das barras do sistema (status e navegação) para combinar com o tema da interface. */
export const setBars = (color, dark) => sync('setBars')({ color, dark: !!dark });
/** Registra quem trata o botão "voltar". A função devolve true quando consumiu o gesto. */
export function onBack(fn) {
  backHandler = fn;
}
export const share = (title, text) => sync('share')({ title, text });
/** @param {{name:string, mime:string, text?:string, base64?:string}} file */
export const saveFile = (file) => sync('saveFile')(file);

// Só para os testes: dispara um evento como se viesse do celular.
export const _emit = emit;
