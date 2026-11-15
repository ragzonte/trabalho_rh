// Dados "de enfeite" do simulador: tudo o que um celular de verdade informaria além do
// sinal (elementos de informação dos beacons, fabricante do roteador, rede local, o
// próprio celular). Nada aqui muda a propagação: isso é assunto de world.js.
//
// Tudo é determinístico: o mesmo mundo (mesma semente) gera sempre os mesmos dados.

import { encodeIes } from '../core/ies.js';
import { parseCapabilities } from '../core/security.js';
import { FLOOR_HEIGHT } from '../mapping/types.js';
import { hashSeed, hashUniform } from './prng.js';

/** O celular simulado: Wi-Fi 6E, duas antenas, sabe medir distância (802.11mc). */
export const PHONE = Object.freeze({
  manufacturer: 'Google',
  model: 'Pixel 7 (simulado)',
  host: 'Pixel-7',
  gen: 6,
  nss: 2,
  maxWidthMHz: 160,
});

// ---------------------------------------------------------------------------
// Redes hostis
// ---------------------------------------------------------------------------

/**
 * Nomes de rede que qualquer vizinho pode anunciar: um tenta injetar HTML, o outro usa
 * emoji e ocupa os 32 bytes que o padrão permite (o maior nome possível, em letras largas).
 */
export const HOSTILE_SSIDS = Object.freeze(['<img src=x onerror=alert(1)>', '🚀 WIFI_DA_FAMILIA_ALBUQUERQUE']);

/** Textos igualmente hostis para os outros campos que vêm "de fora" (WPS e rede local). */
export const HOSTILE_TEXT = Object.freeze({
  wpsDevice: '<script>alert("wps")</script>',
  wpsMaker: '"><svg onload=alert(2)>',
  lanHost: '<b onmouseover=alert(3)>tv</b>',
  lanLong: 'android-2f9c1e7a5b3d4c6e8f0a1b2c3d4e5f6a7b8c9d0e.casa.do.vizinho.home.arpa',
});

/**
 * Dois vizinhos a mais, logo depois da parede, para manter as telas honestas quanto a
 * escapar texto e cortar nomes compridos.
 * @param {import('./world.js').WorldSpec} spec
 * @returns {Object[]} roteadores no formato de spec.aps
 */
export function hostileNeighbours(spec) {
  const outline = Array.isArray(spec.outline[0][0]) ? spec.outline[0] : spec.outline;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of outline) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const list = [
    {
      bssid: 'b0:95:75:13:37:00',
      ssid: HOSTILE_SSIDS[0],
      x: maxX + 3,
      y: midY,
      z: 1.1,
      freq: 2452, // canal 9: de propósito fora do 1/6/11
      widthMHz: 20,
      standard: 4,
      capabilities: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS][WPS]',
      eirpDbm: 19,
      device: 'hostil-1',
      own: false,
    },
    {
      bssid: '28:6c:07:c0:ff:e0',
      ssid: HOSTILE_SSIDS[1],
      x: midX,
      y: minY - 3,
      z: 1.4,
      freq: 2422, // canal 3 com 40 MHz: o vizinho que ocupa meia faixa
      widthMHz: 40,
      standard: 6,
      capabilities: '[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][MFPC]',
      eirpDbm: 20,
      device: 'hostil-2',
      own: false,
    },
    {
      bssid: '28:6c:07:c0:ff:e1',
      ssid: HOSTILE_SSIDS[1],
      x: midX,
      y: minY - 3,
      z: 1.4,
      freq: 5745,
      widthMHz: 80,
      standard: 6,
      capabilities: '[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][MFPC]',
      eirpDbm: 22,
      device: 'hostil-2',
      own: false,
    },
  ];
  const used = new Set((spec.aps || []).map((a) => String(a.bssid).toLowerCase()));
  return list.filter((a) => !used.has(a.bssid));
}

// ---------------------------------------------------------------------------
// Fabricantes (pelo prefixo do BSSID) e a rede que cada um costuma montar
// ---------------------------------------------------------------------------

// chip = OUI que o fabricante do chip assina num elemento próprio do beacon.
const VENDORS = [
  { ouis: ['d8:c6:78', 'cc:d4:a1'], name: 'MitraStar', models: ['GPT-2741GNAC-N1', 'GPT-2541GNAC'], chip: '00:10:18', net: 'vivo' },
  { ouis: ['e0:ca:94'], name: 'Askey', models: ['RTF8115VW', 'RTF3505VW-N2'], chip: '00:10:18', net: 'vivo' },
  { ouis: ['00:1d:d0', 'f8:0b:be'], name: 'ARRIS', models: ['TG1692A', 'TG2492'], chip: '00:10:18', net: 'claro' },
  { ouis: ['fc:52:8d', 'a4:91:b1', '88:f7:c7'], name: 'Technicolor', models: ['TC7337', 'CGA4233'], chip: '00:10:18', net: 'claro' },
  { ouis: ['18:62:2c', '00:1e:74'], name: 'Sagemcom', models: ['F@st 3486', 'F@st 3896'], chip: '00:10:18', net: 'claro' },
  { ouis: ['00:e0:fc', '48:46:fb', 'e8:cd:2d', '28:6e:d4'], name: 'Huawei', models: ['HG8145V5', 'EG8145X6', 'WS5200'], chip: null, net: 'huawei' },
  { ouis: ['34:4b:50', 'd0:15:4a', '00:19:c6'], name: 'ZTE', models: ['F670L', 'F6600P'], chip: null, net: 'zte' },
  { ouis: ['50:c7:bf', 'c0:25:e9', '98:da:c4', 'b0:95:75', '14:eb:b6'], name: 'TP-Link', models: ['Archer C6', 'Archer AX10', 'Deco M5', 'TL-WR841N'], chip: '00:03:7f', net: 'tplink' },
  { ouis: ['00:1a:3f'], name: 'Intelbras', models: ['Action RF 1200', 'RG 1200', 'Twibi Giga'], chip: '00:e0:4c', net: 'intelbras' },
  { ouis: ['1c:7e:e5', '00:26:5a', 'c8:be:19', '84:c9:b2'], name: 'D-Link', models: ['DIR-615', 'DIR-842'], chip: '00:0c:43', net: 'dlink' },
  { ouis: ['00:e0:4c'], name: 'Multilaser', models: ['RE160V', 'RE708'], chip: '00:e0:4c', net: 'generic' },
  { ouis: ['24:a4:3c', '78:8a:20', 'fc:ec:da', '74:83:c2', 'b4:fb:e4'], name: 'Ubiquiti', models: ['UniFi U6 Lite', 'UniFi AC Lite'], chip: '00:0c:e7', net: 'office' },
  { ouis: ['24:de:c6', '94:b4:0f', '00:0b:86'], name: 'Aruba', models: ['AP-505'], chip: '00:10:18', net: 'office' },
  { ouis: ['64:09:80', '50:64:2b', '28:6c:07'], name: 'Xiaomi', models: ['Mi Router 4A', 'Redmi AX5'], chip: '00:0c:e7', net: 'generic' },
];

const VENDOR_BY_OUI = new Map();
for (const v of VENDORS) for (const oui of v.ouis) VENDOR_BY_OUI.set(oui, v);

function vendorOf(bssid) {
  return VENDOR_BY_OUI.get(String(bssid).slice(0, 8).toLowerCase()) || null;
}

// Endereços que cada operadora/fabricante entrega de fábrica. dns 'gw' = o próprio roteador.
const NETS = {
  vivo: { gw: '192.168.15.1', dns: 'gw', lease: 14400, v6: '2804:7f4', gwHost: 'menuvivofibra.br' },
  claro: { gw: '192.168.0.1', dns: ['181.213.132.2', '181.213.132.3'], lease: 3600, v6: '2804:14d', gwHost: null },
  tplink: { gw: '192.168.68.1', dns: ['192.168.68.1', '1.1.1.1'], lease: 7200, v6: '2804:431', gwHost: 'tplinkdeco.net' },
  huawei: { gw: '192.168.100.1', dns: 'gw', lease: 86400, v6: '2804:d45', gwHost: null },
  zte: { gw: '192.168.1.1', dns: 'gw', lease: 86400, v6: '2804:214', gwHost: null },
  intelbras: { gw: '10.0.0.1', dns: ['10.0.0.1', '8.8.8.8'], lease: 7200, v6: null, gwHost: 'meuintelbras.local' },
  dlink: { gw: '192.168.0.1', dns: 'gw', lease: 86400, v6: null, gwHost: 'dlinkrouter.local' },
  office: { gw: '192.168.10.1', dns: ['192.168.10.1', '8.8.8.8'], lease: 28800, v6: null, gwHost: 'gateway.corp.local' },
  generic: { gw: '192.168.1.1', dns: ['8.8.8.8', '8.8.4.4'], lease: 43200, v6: null, gwHost: null },
};

const GUEST_SSID = /visitante|convidad|guest/i;

/** Redes da casa em que o celular "tem a senha salva" (as de visitantes ficam de fora). */
export function savedNetworks(world) {
  const own = world.aps.filter((a) => a.own);
  const main = own.filter((a) => !GUEST_SSID.test(a.ssid));
  return main.length ? main : own;
}

/**
 * Endereçamento da rede local do mundo (o que o DHCP do roteador entregaria ao celular).
 * @returns {{gateway:string, prefix:number, ip:string, dns:string[], ipv6:string[], iface:string, mtu:number,
 *            leaseSec:number, gatewayHost:?string, base:string}}
 */
export function networkOf(world) {
  const router = savedNetworks(world)[0] || world.aps[0] || null;
  const vendor = router ? vendorOf(router.bssid) : null;
  const conf = NETS[vendor ? vendor.net : 'generic'];
  const h = hashSeed('wrx-net', world.seed, router ? router.bssid : world.name);
  const base = conf.gw.slice(0, conf.gw.lastIndexOf('.'));
  const group = (k) => hashSeed(h, 'v6', k).toString(16).slice(-4).replace(/^0+(?=.)/, '');
  const ipv6 = [`fe80::${group(1)}:${group(2)}:${group(3)}:${group(4)}`];
  if (conf.v6) ipv6.push(`${conf.v6}:${group(5)}:${group(6)}:${group(1)}:${group(2)}:${group(3)}:${group(4)}`);
  return {
    gateway: conf.gw,
    prefix: 24,
    ip: `${base}.${100 + (h % 100)}`,
    dns: conf.dns === 'gw' ? [conf.gw] : conf.dns.slice(),
    ipv6,
    iface: 'wlan0',
    mtu: 1500,
    leaseSec: conf.lease,
    gatewayHost: conf.gwHost,
    base,
  };
}

// ---------------------------------------------------------------------------
// Aparelhos da rede local
// ---------------------------------------------------------------------------

// ms = faixa do tempo de resposta. Celular com a tela apagada demora a responder;
// lâmpadas e tomadas inteligentes costumam não dizer o nome.
const LAN_HOME = [
  { host: 'Smart TV da Sala', ms: [3, 9] },
  { host: 'notebook-da-ana', ms: [2, 6] },
  { host: 'EPSON L3250 Series', ms: [8, 30] },
  { host: 'Echo Dot da Cozinha', ms: [4, 15] },
  { host: 'Chromecast do Quarto', ms: [4, 12] },
  { host: 'Galaxy-A54-de-Marcos', ms: [30, 180] },
  { host: 'iPhone de Júlia', ms: [20, 150] },
  { host: null, ms: [5, 40] },
  { host: null, ms: [10, 90] },
];
const LAN_SMALL = [
  { host: 'notebook-do-rafa', ms: [2, 6] },
  { host: 'Smart TV', ms: [3, 9] },
  { host: 'Echo Dot', ms: [4, 15] },
  { host: null, ms: [5, 40] },
];
const LAN_BIG = [
  ...LAN_HOME,
  { host: 'Deco do Corredor', ms: [1, 4] },
  { host: 'PlayStation-5', ms: [3, 8] },
  { host: 'Câmera da Garagem', ms: [6, 25] },
  { host: 'Tablet das Crianças', ms: [25, 160] },
];
const LAN_OFFICE = [
  { host: 'SRV-ARQUIVOS', ms: [1, 3] },
  { host: 'IMPRESSORA-RECEPCAO', ms: [6, 25] },
  { host: 'PC-RECEPCAO', ms: [2, 6] },
  { host: 'NB-FINANCEIRO-03', ms: [2, 8] },
  { host: 'NB-DIRETORIA', ms: [2, 8] },
  { host: 'NB-COMERCIAL-07', ms: [2, 8] },
  { host: 'TV Sala de Reunião', ms: [3, 9] },
  { host: 'Relógio de Ponto', ms: [10, 40] },
  { host: 'Câmera da Entrada', ms: [6, 25] },
  { host: 'AP-Teto-1', ms: [1, 4] },
  { host: 'AP-Teto-2', ms: [1, 4] },
  { host: 'AP-Teto-3', ms: [1, 4] },
  { host: null, ms: [5, 40] },
  { host: null, ms: [10, 90] },
  { host: null, ms: [20, 150] },
];

/**
 * Quem responde na rede local da casa: roteador, este celular e os aparelhos de sempre.
 * @returns {{n:number, ip:string, host:?string, ms:number[], self?:boolean, gateway?:boolean}[]}
 *          em ordem de endereço; `n` é o último número do IP
 */
export function householdOf(world, net, hostile) {
  const ownDevices = new Set(world.aps.filter((a) => a.own).map((a) => a.device)).size;
  let list;
  if (ownDevices >= 3) list = LAN_OFFICE;
  else if (world.rooms.length <= 2) list = LAN_SMALL;
  else if (world.floors >= 2 || ownDevices === 2) list = LAN_BIG;
  else list = LAN_HOME;
  const selfN = Number(net.ip.slice(net.ip.lastIndexOf('.') + 1));
  const gwN = Number(net.gateway.slice(net.gateway.lastIndexOf('.') + 1));
  const used = new Set([selfN, gwN]);
  const out = [
    { n: gwN, host: net.gatewayHost, ms: [1, 5], gateway: true },
    { n: selfN, host: PHONE.host, ms: [0.1, 0.6], self: true },
  ];
  const extra = hostile
    ? [
        { host: HOSTILE_TEXT.lanHost, ms: [4, 20] },
        { host: HOSTILE_TEXT.lanLong, ms: [30, 160] },
      ]
    : [];
  const h = hashSeed('wrx-lan', world.seed, world.name);
  [...list, ...extra].forEach((d, i) => {
    let n = 2 + (hashSeed(h, 'ip', i) % 252);
    while (used.has(n)) n = n >= 253 ? 2 : n + 1;
    used.add(n);
    out.push({ n, host: d.host, ms: d.ms });
  });
  out.sort((a, b) => a.n - b.n);
  for (const d of out) d.ip = `${net.base}.${d.n}`;
  return out;
}

// ---------------------------------------------------------------------------
// Perfil de cada rede e os elementos de informação do beacon
// ---------------------------------------------------------------------------

// Bloco de 80 MHz de um canal de 5/6 GHz (para saber quem divide o ar com quem).
function block80(ap) {
  if (ap.band === 2) return `6:${Math.floor((ap.channel - 1) / 16)}`;
  const base = ap.channel >= 149 ? 149 : ap.channel >= 100 ? 100 : 36;
  return `5:${base}:${Math.floor((ap.channel - base) / 16)}`;
}

// Acrescenta 802.11r ao texto de capabilities, do jeito que o Android escreveria.
function withFastTransition(capabilities) {
  return capabilities.replace(/\[(WPA2|RSN)-([^\]]+)\]/g, (whole, proto, rest) => {
    const cut = rest.search(/-(CCMP|GCMP|TKIP)/);
    if (cut < 0) return whole;
    const akms = rest
      .slice(0, cut)
      .split('+')
      .map((a) => (a === 'PSK' ? 'PSK+FT/PSK' : a === 'SAE' ? 'SAE+FT/SAE' : a === 'EAP/SHA1' ? 'EAP/SHA1+FT/EAP' : a));
    return `[${proto}-${akms.join('+')}${rest.slice(cut)}]`;
  });
}

// Nome sem acentos nem espaços: os elementos de nome de AP só levam ASCII.
function asciiSlug(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function asciiHex(text) {
  let s = '';
  for (let i = 0; i < text.length; i++) s += (text.charCodeAt(i) & 0x7f).toString(16).padStart(2, '0');
  return s;
}

/**
 * Perfil fixo de cada BSSID do mundo: o que o beacon dele anuncia além do nome.
 * @param {ReturnType<import('./world.js').createWorld>} world
 * @returns {Map<string, object>} BSSID -> perfil (use com iesAt)
 */
export function describeAps(world) {
  const own = world.aps.filter((a) => a.own);
  const ownDevices = new Set(own.map((a) => a.device));
  const office = ownDevices.size >= 3;
  // Mesmo nome em mais de um aparelho da casa = mesh (ou rede de empresa): tem roaming assistido.
  const devicesBySsid = new Map();
  for (const a of own) {
    if (!devicesBySsid.has(a.ssid)) devicesBySsid.set(a.ssid, new Set());
    devicesBySsid.get(a.ssid).add(a.device);
  }
  // Rádios (aparelho + faixa) para estimar o quanto cada canal está disputado.
  const radios = new Map();
  for (const a of world.aps) radios.set(`${a.device}|${a.band}`, a);
  const rivals = (ap) => {
    let n = 0;
    for (const [key, other] of radios) {
      if (key === `${ap.device}|${ap.band}` || other.band !== ap.band) continue;
      if (ap.band === 0 ? Math.abs(other.channel - ap.channel) <= 4 : block80(other) === block80(ap)) n++;
    }
    return n;
  };

  const profiles = new Map();
  for (const ap of world.aps) {
    const h = hashSeed('wrx-ap', world.seed, ap.bssid);
    const u = (label) => hashUniform(h, label);
    // O que é do aparelho (modelo, chip, país) vale para todos os rádios dele.
    const hd = hashSeed('wrx-device', world.seed, ap.device);
    const ud = (label) => hashUniform(hd, label);
    const vendor = vendorOf(ap.bssid);
    const mesh = ap.own && (devicesBySsid.get(ap.ssid)?.size ?? 0) >= 2;
    const hostileIndex = HOSTILE_SSIDS.indexOf(ap.ssid);

    let nss = 2;
    if (!ap.own) {
      if (ap.standard <= 4) nss = u('nss') < 0.3 ? 1 : 2;
      else if (ap.standard === 5) nss = u('nss') < 0.7 ? 2 : 3;
      else nss = u('nss') < 0.8 ? 2 : 4;
    }

    const roaming = mesh ? { k: true, v: true, r: true, mdid: hashSeed('wrx-md', world.seed, ap.ssid) & 0xffff } : null;
    const capabilities = roaming ? withFastTransition(ap.capabilities) : ap.capabilities;
    const sec = parseCapabilities(capabilities);
    const rsnSection = sec.sections.rsn;
    const wpaSection = sec.sections.wpa;

    // --- descrição para o encodeIes (a parte que não muda com o tempo)
    const spec = { frequency: ap.freq, widthMhz: ap.widthMHz };
    if (ap.band === 0 && u('11b') < (ap.standard >= 6 ? 0.15 : 0.55)) spec.rates = { legacy11b: true };
    if (ap.own || ud('country') < 0.9) spec.country = 'BR';
    if (ap.standard >= 4 && ap.band !== 2) {
      spec.ht = { nss: Math.min(nss, 4), width40: ap.widthMHz >= 40 };
      if (ap.band === 0 && ap.widthMHz >= 40) spec.ht.secondary = ap.centerFreq0 > ap.freq ? 'above' : 'below';
    }
    if (ap.standard >= 5 && ap.band === 1) spec.vht = { nss, width160: ap.widthMHz >= 160 };
    if (ap.standard >= 6 && ap.standard !== 7) spec.he = { nss, bssColor: 1 + (h % 63), width160: ap.widthMHz >= 160 };
    if (ap.standard >= 8) spec.eht = { nss, width320: ap.widthMHz >= 320 };
    if (rsnSection) {
      spec.rsn = {
        akms: rsnSection.akms,
        ciphers: rsnSection.ciphers,
        pmfCapable: sec.pmf === 'capable' || sec.pmf === 'required',
        pmfRequired: sec.pmf === 'required',
      };
    }
    if (wpaSection) spec.wpa = { akms: wpaSection.akms, ciphers: wpaSection.ciphers };
    if (/\[WPS\]/.test(capabilities)) {
      const model = vendor ? vendor.models[hd % vendor.models.length] : 'Wireless Router';
      spec.wps = {
        configured: true,
        locked: ud('wps-lock') < 0.12,
        manufacturer: hostileIndex >= 0 ? HOSTILE_TEXT.wpsMaker : vendor ? vendor.name : 'Realtek Semiconductor Corp.',
        model,
        modelNumber: (100 + (hd % 900)).toString(),
        deviceName: hostileIndex >= 0 ? HOSTILE_TEXT.wpsDevice : vendor ? `${vendor.name} ${model}` : 'Wireless AP',
      };
    }
    if (roaming) spec.roaming = roaming;
    // Mesh e pontos de acesso de empresa respondem a medições de distância (802.11mc).
    const ftm = mesh;
    if (ftm) spec.ftmResponder = true;
    if (office && ap.own) spec.txPowerDbm = Math.round(ap.eirpDbm - 3);
    if (vendor && vendor.chip && ud('chip') < 0.85) spec.vendorOuis = [vendor.chip];

    // --- elementos que o encodeIes não monta
    const extra = [];
    if (office && ap.own && vendor && vendor.name === 'Ubiquiti') {
      // Ubiquiti anuncia o nome do ponto de acesso: OUI 00-15-6D, tipo 1, nome em ASCII.
      const floor = Math.max(0, Math.min(world.floors - 1, Math.floor(ap.z / FLOOR_HEIGHT)));
      const room = world.roomAt(ap.x, ap.y, floor);
      const number = String(ap.device).replace(/\D+/g, '') || '1';
      extra.push({ id: 221, ext: 0, hex: `00156d01${asciiHex(`AP${number}-${asciiSlug(room ? room.name : 'Teto')}`)}` });
    }

    // --- ocupação do canal e aparelhos associados (variam devagar: veja loadAt)
    let load = null;
    if (ap.own || ud('load') < 0.65) {
      const n = rivals(ap);
      const radio = hashSeed('wrx-radio', world.seed, ap.device, ap.band);
      let stations;
      if (!ap.own) stations = Math.floor(Math.pow(u('sta'), 1.6) * 9);
      else if (office) stations = GUEST_SSID.test(ap.ssid) ? (ap.band ? 1 : 0) : ap.band ? 7 : 3;
      else stations = Math.max(1, Math.round((ap.band ? 4 : 3) / ownDevices.size) + (mesh ? 1 : 0));
      load = {
        stations,
        spread: ap.own && !office ? 1 : 1.6,
        // 2,4 GHz já começa mais cheio (vizinhos, Bluetooth, micro-ondas) e piora com cada rival.
        utilization: ap.band === 0 ? 0.1 + 0.05 * Math.min(n, 10) : 0.03 + 0.035 * Math.min(n, 6),
        stationsKey: h,
        radioKey: radio, // redes do mesmo rádio medem a mesma ocupação
      };
    }

    profiles.set(ap.bssid, {
      bssid: ap.bssid,
      vendor: vendor ? vendor.name : null,
      nss,
      mesh,
      ftm,
      // Erro típico da medição de distância deste AP (m).
      rttSigma: 0.5 + 0.5 * u('rtt'),
      capabilities,
      spec,
      extra,
      load,
    });
  }
  return profiles;
}

// Ruído suave e sem estado: interpola valores sorteados a cada `period` segundos.
function smooth(key, t, period) {
  const x = t / period;
  const i = Math.floor(x);
  const f = x - i;
  const a = hashUniform(key, i);
  const b = hashUniform(key, i + 1);
  return a + (b - a) * f * f * (3 - 2 * f);
}

/**
 * Aparelhos associados e ocupação do canal de uma rede no instante `t` (s).
 * @returns {{stations:number, utilization:number}|null} null = a rede não anuncia isso
 */
export function loadAt(profile, t) {
  const l = profile.load;
  if (!l) return null;
  const stations = Math.max(0, Math.round(l.stations + l.spread * (2 * smooth(l.stationsKey, t, 240) - 1)));
  const busy = l.utilization + 0.22 * (smooth(l.radioKey, t, 75) - 0.5) + 0.08 * (smooth(l.radioKey ^ 0x5bd1e995, t, 11) - 0.5);
  return { stations, utilization: Math.min(0.97, Math.max(0.01, busy)) };
}

/**
 * Elementos de informação do beacon de uma rede no instante `t` (formato de ScanAp.ies).
 * @returns {{id:number, ext:number, hex:string}[]}
 */
export function iesAt(profile, t) {
  const load = loadAt(profile, t);
  const ies = encodeIes(load ? { ...profile.spec, bssLoad: load } : profile.spec);
  for (const e of profile.extra) ies.push({ ...e });
  return ies;
}
