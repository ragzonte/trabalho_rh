// Mundos prontos para o modo demonstração e para a bancada do mapa 3D:
// apartamento, sobrado, escritório, kitnet — e casas sorteadas (randomSpec).
//
// A planta de cada mundo pronto é fixa; a semente muda a vizinhança (quem são os
// vizinhos, onde estão, em que canal) e o canto onde o roteador da casa foi instalado.

import { FLOOR_HEIGHT } from '../mapping/types.js';
import { createRng } from './prng.js';
import { createWorld, pointInPolygon } from './world.js';

// ---------------------------------------------------------------------------
// Paredes
// ---------------------------------------------------------------------------

// Parede reta de A até B com aberturas [de, até, material]. As posições das aberturas
// são medidas em metros a partir de A. material null = vão livre; 'wood' = porta;
// 'glass' = janela.
function wallLine(floor, ax, ay, bx, by, material, openings = []) {
  const len = Math.hypot(bx - ax, by - ay);
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  const out = [];
  const piece = (from, to, mat) => {
    if (!mat || to - from < 1e-6) return;
    out.push({
      floor,
      x1: round3(ax + ux * from),
      y1: round3(ay + uy * from),
      x2: round3(ax + ux * to),
      y2: round3(ay + uy * to),
      material: mat,
    });
  };
  let at = 0;
  for (const [from, to, mat] of [...openings].sort((p, q) => p[0] - q[0])) {
    piece(at, from, material);
    piece(from, to, mat);
    at = to;
  }
  piece(at, len, material);
  return out;
}

// Parede horizontal (y fixo) e vertical (x fixo): as aberturas vão em coordenadas do mundo.
const hw = (floor, y, xa, xb, material, openings = []) =>
  wallLine(floor, xa, y, xb, y, material, openings.map(([a, b, m]) => [a - xa, b - xa, m]));
const vw = (floor, x, ya, yb, material, openings = []) =>
  wallLine(floor, x, ya, x, yb, material, openings.map(([a, b, m]) => [a - ya, b - ya, m]));

const rect = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

function round3(v) {
  return Math.round(v * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Roteadores: nomes, MACs e segurança com cara de Brasil
// ---------------------------------------------------------------------------

const SEC = {
  wpa2: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS][WPS]',
  wpa2NoWps: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]',
  mixed: '[WPA-PSK-CCMP+TKIP][WPA2-PSK-CCMP+TKIP][RSN-PSK-CCMP+TKIP][ESS][WPS]',
  wpa23: '[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][MFPC]',
  wpa3: '[RSN-SAE-CCMP][ESS][MFPR][MFPC]',
  open: '[ESS]',
  wep: '[WEP][ESS]',
  eap: '[WPA2-EAP/SHA1-CCMP][RSN-EAP/SHA1-CCMP][ESS][MFPC]',
  owe: '[RSN-OWE-CCMP][ESS][MFPR][MFPC]',
};

// Prefixos de fabricante (OUI) comuns nos roteadores vendidos e instalados no Brasil.
const OUI = {
  tplink: ['50:c7:bf', 'c0:25:e9', '98:da:c4', 'b0:95:75', '14:eb:b6'],
  intelbras: ['00:1a:3f'],
  huawei: ['00:e0:fc', '48:46:fb', 'e8:cd:2d', '28:6e:d4'],
  zte: ['34:4b:50', 'd0:15:4a', '00:19:c6'],
  sagemcom: ['18:62:2c', '00:1e:74'],
  arris: ['00:1d:d0', 'f8:0b:be'],
  technicolor: ['fc:52:8d', 'a4:91:b1', '88:f7:c7'],
  mitrastar: ['d8:c6:78', 'cc:d4:a1'],
  askey: ['e0:ca:94'],
  dlink: ['1c:7e:e5', '00:26:5a', 'c8:be:19', '84:c9:b2'],
  realtek: ['00:e0:4c'],
  ubiquiti: ['24:a4:3c', '78:8a:20', 'fc:ec:da', '74:83:c2', 'b4:fb:e4'],
  aruba: ['24:de:c6', '94:b4:0f', '00:0b:86'],
  xiaomi: ['64:09:80', '50:64:2b', '28:6c:07'],
};

const CUSTOM_NAMES = [
  'Casa do Zé',
  'Familia Silva',
  'Família Oliveira',
  'AP 302',
  'Apto 54',
  'Wi-Fi da Vovó',
  'Rede do Vizinho',
  'NaoRoubeMeuWifi',
  'Bruna e Thiago',
  'Dona Maria',
  'Republica dos Brothers',
  'Casa Santos',
  'Net da Jú',
  'Lar Doce Lar',
  'ap501',
  'Quarto do Pedro',
  'Internet do Carlão',
  'Vai Corinthians',
  'Mengão 2019',
  'WIFI GRATIS SQN',
  'Pague sua internet',
  'Cantinho da Lu',
  'Ferreira_Wifi',
  'Souza2.4',
  'GALO DOIDO',
  'casa 12',
  'Bloco B 203',
  'Sítio do Pica-Pau',
  'Rede da Tia Cida',
  'Wifi do Seu Jorge',
];

const CH24 = [1, 6, 11, 1, 6, 11, 1, 6, 11, 1, 6, 11, 6, 3, 4, 8, 9, 13, 2];
const CH5 = [36, 36, 36, 40, 44, 44, 48, 149, 149, 153, 157, 157, 161, 52, 100, 108, 116];

const freq24 = (ch) => 2407 + 5 * ch;
const freq5 = (ch) => 5000 + 5 * ch;

// Fábrica de roteadores de um mundo: garante BSSIDs únicos e nomes sem repetição.
function boxFactory(rng) {
  const usedMac = new Set();
  const usedName = new Set();
  let deviceCount = 0;

  // Base do MAC de um aparelho: os rádios dele só mudam os últimos dígitos.
  function macBase(vendor) {
    for (;;) {
      const oui = rng.pick(OUI[vendor]);
      const mid = `${rng.hex(2)}:${rng.hex(2)}`.toLowerCase();
      const last = rng.int(0, 15) * 16; // termina em x0: sobra espaço para os outros rádios
      const key = `${oui}:${mid}:${last}`;
      if (usedMac.has(key)) continue;
      usedMac.add(key);
      return { prefix: `${oui}:${mid}`, last };
    }
  }
  const mac = (base, offset) => `${base.prefix}:${(base.last + offset).toString(16).padStart(2, '0')}`;

  function uniqueName(make) {
    for (let i = 0; i < 50; i++) {
      const name = make();
      if (!usedName.has(name)) {
        usedName.add(name);
        return name;
      }
    }
    return make() + rng.hex(2);
  }

  const radio24 = (o = {}) => {
    const ch = o.channel ?? rng.pick(CH24);
    const modern = o.modern ?? rng.chance(0.3);
    return {
      freq: freq24(ch),
      widthMHz: o.width ?? (rng.chance(0.2) ? 40 : 20),
      standard: o.standard ?? (modern ? 6 : 4),
      eirpDbm: o.eirp ?? round3(rng.float(16, 20)),
    };
  };
  const radio5 = (o = {}) => {
    const ch = o.channel ?? rng.pick(CH5);
    const modern = o.modern ?? rng.chance(0.35);
    return {
      freq: freq5(ch),
      widthMHz: o.width ?? rng.weighted([80, 40, 20, 160], [70, 20, 5, ch === 36 || ch === 100 ? 5 : 0]),
      standard: o.standard ?? (modern ? 6 : 5),
      eirpDbm: o.eirp ?? round3(rng.float(18, 23)),
    };
  };

  /**
   * Um aparelho de vizinho: devolve os rádios (sem posição).
   * Cada operadora tem o seu jeito de batizar a rede.
   */
  function neighbour() {
    const kind = rng.weighted(
      ['vivo', 'claro', 'netOld', 'oi', 'tim', 'intelbras', 'tplink', 'custom', 'hidden', 'multilaser', 'dlink', 'mesh'],
      [3, 3, 2, 1.5, 1, 1.5, 2, 3.5, 0.9, 0.7, 0.7, 0.6],
    );
    const device = `viz-${++deviceCount}`;
    const list = [];
    const add = (base, offset, ssid, radio, capabilities) =>
      list.push({ bssid: mac(base, offset), ssid, ...radio, capabilities, device, own: false });

    if (kind === 'vivo') {
      const base = macBase(rng.pick(['mitrastar', 'askey']));
      const ssid = uniqueName(() => `VIVOFIBRA-${rng.hex(4)}`);
      add(base, 0, ssid, radio24(), SEC.wpa2);
      add(base, 4, `${ssid}-5G`, radio5(), SEC.wpa2);
    } else if (kind === 'claro') {
      const base = macBase(rng.pick(['arris', 'technicolor', 'sagemcom']));
      const id = rng.hex(6);
      const r24 = radio24();
      add(base, 0, `CLARO_2G${id}`, r24, SEC.wpa2);
      add(base, 8, `CLARO_5G${id}`, radio5(), SEC.wpa2);
      // Roteadores da Claro/NET costumam anunciar também a rede pública, no mesmo rádio.
      if (rng.chance(0.35)) add(base, 1, '#NET-CLARO-WIFI', r24, SEC.open);
    } else if (kind === 'netOld') {
      const base = macBase(rng.pick(['arris', 'technicolor']));
      const id = rng.hex(6);
      add(base, 0, `NET_2G${id}`, radio24({ modern: false }), SEC.mixed);
      if (rng.chance(0.4)) add(base, 4, `NET_5G${id}`, radio5({ modern: false }), SEC.mixed);
    } else if (kind === 'oi') {
      const base = macBase(rng.pick(['huawei', 'zte', 'sagemcom']));
      const id = rng.hex(4);
      const ssid = uniqueName(() => (rng.chance(0.5) ? `Oi_${id}` : `Oi ${id}`));
      add(base, 0, ssid, radio24(), SEC.wpa2);
      if (rng.chance(0.5)) add(base, 4, `${ssid}_5G`, radio5(), SEC.wpa2);
    } else if (kind === 'tim') {
      const base = macBase(rng.pick(['huawei', 'zte']));
      const ssid = uniqueName(() => `TIM_ULTRAFIBRA_${rng.hex(4)}`);
      add(base, 0, ssid, radio24(), SEC.wpa2);
      add(base, 4, `${ssid}_5G`, radio5(), SEC.wpa2);
    } else if (kind === 'intelbras') {
      const base = macBase('intelbras');
      const ssid = rng.chance(0.4) ? 'INTELBRAS' : uniqueName(() => `Intelbras_${rng.hex(4)}`);
      add(base, 0, ssid, radio24({ modern: false }), rng.chance(0.12) ? SEC.open : SEC.wpa2);
    } else if (kind === 'tplink') {
      const base = macBase('tplink');
      const ssid = uniqueName(() => `TP-Link_${rng.hex(4)}`);
      add(base, 0, ssid, radio24(), SEC.wpa2);
      if (rng.chance(0.6)) add(base, 1, `${ssid}_5G`, radio5(), SEC.wpa2);
    } else if (kind === 'custom') {
      const base = macBase(rng.pick(['tplink', 'intelbras', 'dlink', 'xiaomi', 'huawei']));
      const ssid = uniqueName(() => rng.pick(CUSTOM_NAMES));
      const sec = rng.weighted([SEC.wpa2, SEC.wpa23, SEC.mixed, SEC.wep], [6, 2, 1.5, 0.3]);
      add(base, 0, ssid, radio24(), sec);
      if (rng.chance(0.45)) add(base, 1, rng.chance(0.5) ? ssid : `${ssid} 5G`, radio5(), sec);
    } else if (kind === 'hidden') {
      const base = macBase(rng.pick(['tplink', 'huawei', 'ubiquiti']));
      add(base, 0, '', radio24(), SEC.wpa2NoWps);
      if (rng.chance(0.4)) add(base, 1, '', radio5(), SEC.wpa2NoWps);
    } else if (kind === 'multilaser') {
      const base = macBase('realtek');
      add(base, 0, uniqueName(() => `Multilaser_2.4G_${rng.hex(6)}`), radio24({ modern: false }), SEC.wpa2);
    } else if (kind === 'dlink') {
      const base = macBase('dlink');
      const ssid = uniqueName(() => `D-Link_DIR-${rng.pick(['615', '809', '842', '610'])}_${rng.hex(2)}`);
      add(base, 0, ssid, radio24({ modern: false }), SEC.mixed);
    } else {
      const base = macBase(rng.pick(['tplink', 'xiaomi']));
      const ssid = uniqueName(() => rng.pick(CUSTOM_NAMES));
      add(base, 0, ssid, radio24({ modern: true, width: 20 }), SEC.wpa23);
      add(base, 1, ssid, radio5({ modern: true, width: 80 }), SEC.wpa23);
    }
    // O rádio de 5 GHz de boa parte dos vizinhos nunca chega até aqui: nem entra no mundo.
    const keep5 = rng.chance(0.5);
    return list.filter((r) => r.freq < 3000 || keep5);
  }

  /** Roteador de duas faixas da própria casa. */
  function ownRouter(o) {
    const base = macBase(o.vendor);
    const device = o.device ?? `casa-${++deviceCount}`;
    const common = { device, own: true, x: o.x, y: o.y, z: o.z };
    const list = [
      {
        bssid: mac(base, 0),
        ssid: o.ssid,
        ...radio24({ channel: o.ch24, width: o.width24 ?? 20, standard: o.std24 ?? 6, eirp: o.eirp24 ?? 20 }),
        capabilities: o.sec ?? SEC.wpa2,
        ...common,
      },
    ];
    if (o.ch5) {
      list.push({
        bssid: mac(base, o.offset5 ?? 4),
        ssid: o.ssid5 ?? o.ssid,
        ...radio5({ channel: o.ch5, width: o.width5 ?? 80, standard: o.std5 ?? 6, eirp: o.eirp5 ?? 21 }),
        capabilities: o.sec ?? SEC.wpa2,
        ...common,
      });
    }
    return list;
  }

  return { neighbour, ownRouter, macBase, mac, radio24, radio5 };
}

// Espalha os vizinhos em volta da casa: ao lado (fora do contorno) e, em prédio,
// também nos andares de cima e de baixo. Para quando chega perto de `bssids` redes.
function placeNeighbours(rng, factory, spec, o) {
  const cx = (o.bounds[0] + o.bounds[2]) / 2;
  const cy = (o.bounds[1] + o.bounds[3]) / 2;
  const outline = Array.isArray(spec.outline[0][0]) ? spec.outline[0] : spec.outline;
  const aps = [];
  let guard = 0;
  while (aps.length < o.bssids && guard++ < 500) {
    const level = o.levels ? rng.weighted(o.levels.map((l) => l[0]), o.levels.map((l) => l[1])) : 0;
    // Mais vizinhos perto do que longe: os de longe quase nunca chegam a aparecer.
    const r = o.minDist + (o.maxDist - o.minDist) * Math.pow(rng.next(), 1.7);
    const a = rng.float(0, 2 * Math.PI);
    const x = round3(cx + r * Math.cos(a));
    const y = round3(cy + r * Math.sin(a));
    let z;
    if (level === 0) {
      // Mesmo andar: tem de ficar fora da casa, com alguma folga.
      const m = o.margin ?? 0.8;
      if (x > o.bounds[0] - m && x < o.bounds[2] + m && y > o.bounds[1] - m && y < o.bounds[3] + m) continue;
      if (pointInPolygon(x, y, outline)) continue;
      const storey = o.sameLevelStoreys ? rng.int(0, o.sameLevelStoreys - 1) : 0;
      z = storey * FLOOR_HEIGHT + rng.float(0.4, 2.0);
    } else {
      const k = level > 0 ? spec.floors - 1 + level : level;
      z = k * FLOOR_HEIGHT + rng.float(0.4, 2.0);
    }
    const dist = Math.hypot(x - cx, y - cy, z - 1.2);
    if (dist < o.minDist || dist > o.maxDist) continue;
    const box = factory.neighbour();
    if (aps.length + box.length > o.bssids + 1) continue;
    for (const radio of box) aps.push({ ...radio, x, y, z: round3(z) });
  }
  return aps;
}

// ---------------------------------------------------------------------------
// Apartamento (9 x 7 m)
// ---------------------------------------------------------------------------

function apartamento(seed) {
  const rng = createRng('apartamento', seed);
  const factory = boxFactory(rng.fork('boxes'));
  const B = 'brick';
  const C = 'concrete';
  const walls = [
    // Fachadas e paredes de divisa (concreto), com janelas e a porta de entrada.
    ...hw(0, 0, 0, 9, C, [
      [1.2, 3.2, 'glass'],
      [6.4, 7.8, 'glass'],
    ]),
    ...vw(0, 9, 0, 7, C, [[5.0, 6.4, 'glass']]),
    ...hw(0, 7, 0, 9, C, [
      [0.8, 2.2, 'glass'],
      [3.8, 4.4, 'glass'],
    ]),
    ...vw(0, 0, 0, 7, C, [[2.6, 3.5, 'wood']]),
    // Paredes internas (tijolo).
    ...vw(0, 5.4, 0, 3.8, B, [[1.4, 2.4, null]]), // sala | cozinha (passagem aberta)
    ...hw(0, 3.8, 0, 3.0, B), // sala | quarto 1
    ...hw(0, 3.8, 3.0, 6.6, B, [[3.6, 4.6, null]]), // sala | corredor (passagem aberta)
    ...hw(0, 3.8, 6.6, 9, B), // cozinha | quarto 2
    ...vw(0, 3.0, 3.8, 4.9, B, [[3.95, 4.75, 'wood']]), // quarto 1 | corredor
    ...vw(0, 3.0, 4.9, 7, B), // quarto 1 | banheiro
    ...hw(0, 4.9, 3.0, 5.2, B, [[3.5, 4.3, 'wood']]), // corredor | banheiro
    ...hw(0, 4.9, 5.2, 6.6, B), // corredor | quarto 2
    ...vw(0, 5.2, 4.9, 7, B), // banheiro | quarto 2
    ...vw(0, 6.6, 3.8, 4.9, B, [[3.95, 4.75, 'wood']]), // corredor | quarto 2
  ];
  const rooms = [
    { floor: 0, name: 'Sala', polygon: rect(0, 0, 5.4, 3.8) },
    { floor: 0, name: 'Cozinha', polygon: rect(5.4, 0, 9, 3.8) },
    { floor: 0, name: 'Corredor', polygon: rect(3.0, 3.8, 6.6, 4.9) },
    { floor: 0, name: 'Quarto 1', polygon: rect(0, 3.8, 3.0, 7) },
    { floor: 0, name: 'Banheiro', polygon: rect(3.0, 4.9, 5.2, 7) },
    {
      floor: 0,
      name: 'Quarto 2',
      polygon: [
        [6.6, 3.8],
        [9, 3.8],
        [9, 7],
        [5.2, 7],
        [5.2, 4.9],
        [6.6, 4.9],
      ],
    },
  ];
  // Onde a operadora costuma deixar o roteador: sempre na sala.
  const spots = [
    [4.9, 3.3, 0.9],
    [0.5, 0.5, 0.7],
    [2.6, 0.35, 1.0],
    [0.4, 2.0, 1.4],
    [5.0, 0.5, 0.8],
  ];
  const [rx, ry, rz] = seed === 1 ? spots[0] : rng.pick(spots);
  const id = seed === 1 ? '8F3C' : rng.hex(4);
  const spec = {
    name: 'Apartamento',
    floors: 1,
    outline: rect(0, 0, 9, 7),
    walls,
    rooms,
    stairs: [],
    clutter: { dbPerM: 0.45 },
    aps: factory.ownRouter({
      vendor: 'mitrastar',
      device: 'roteador',
      ssid: `VIVOFIBRA-${id}`,
      ssid5: `VIVOFIBRA-${id}-5G`,
      ch24: seed === 1 ? 6 : rng.pick([1, 6, 11]),
      ch5: seed === 1 ? 44 : rng.pick([36, 44, 149, 157]),
      x: rx,
      y: ry,
      z: rz,
    }),
  };
  spec.aps.push(
    ...placeNeighbours(rng.fork('neighbours'), factory, spec, {
      bounds: [0, 0, 9, 7],
      bssids: rng.int(13, 17),
      minDist: 6,
      maxDist: 25,
      levels: [
        [0, 4],
        [1, 2.5],
        [-1, 2.5],
        [2, 1],
        [-2, 1],
      ],
    }),
  );
  return spec;
}

// ---------------------------------------------------------------------------
// Sobrado (8 x 10 m, dois andares)
// ---------------------------------------------------------------------------

function sobrado(seed) {
  const rng = createRng('sobrado', seed);
  const factory = boxFactory(rng.fork('boxes'));
  const B = 'brick';
  const walls = [];
  for (const f of [0, 1]) {
    // Paredes externas de tijolo, com janelas; a porta da rua fica no térreo.
    walls.push(
      ...hw(f, 0, 0, 8, B, f === 0 ? [[1.8, 2.7, 'wood'], [5.6, 7.0, 'glass']] : [[1.2, 3.0, 'glass'], [5.6, 6.6, 'glass']]),
      ...vw(f, 8, 0, 10, B, [[7.2, 8.6, 'glass']]),
      ...hw(f, 10, 0, 8, B, [[1.4, 3.0, 'glass']]),
      ...vw(f, 0, 0, 10, B, [[2.0, 3.6, 'glass']]),
    );
  }
  // Térreo.
  walls.push(
    ...vw(0, 4.6, 0, 4.4, B, [[1.6, 2.8, null]]), // sala | cozinha
    ...vw(0, 4.6, 4.4, 6, B, [[4.7, 5.7, null]]), // sala | hall
    ...hw(0, 4.4, 4.6, 8, B), // cozinha | hall
    ...hw(0, 6, 0, 4.6, B, [[1.4, 2.2, 'wood']]), // sala | escritório
    ...hw(0, 6, 4.6, 6.2, B, [[5.0, 5.8, 'wood']]), // hall | lavabo
    ...hw(0, 6, 6.2, 8, B, [[6.8, 7.6, 'wood']]), // hall | lavanderia
    ...vw(0, 4.6, 6, 10, B), // escritório | lavabo e lavanderia
    ...vw(0, 6.2, 6, 8.2, B), // lavabo | lavanderia
    ...hw(0, 8.2, 4.6, 6.2, B), // lavabo | lavanderia
  );
  // Andar de cima.
  walls.push(
    ...hw(1, 4.4, 0, 4.6, B, [[3.0, 3.8, 'wood']]), // suíte | corredor
    ...hw(1, 4.4, 4.6, 8, B, [[5.4, 6.2, 'wood']]), // quarto 1 | corredor
    ...vw(1, 4.6, 0, 1.8, B, [[0.5, 1.3, 'wood']]), // suíte | banheiro da suíte
    ...vw(1, 4.6, 1.8, 4.4, B), // suíte | quarto 1
    ...hw(1, 1.8, 4.6, 8, B), // banheiro da suíte | quarto 1
    ...hw(1, 6, 0, 4.0, B, [[2.6, 3.4, 'wood']]), // corredor | quarto 2
    ...hw(1, 6, 4.0, 5.8, B, [[4.5, 5.3, 'wood']]), // corredor | banheiro
    ...hw(1, 6, 5.8, 8, B, [[6.4, 7.2, 'wood']]), // corredor | quarto 3
    ...vw(1, 4.0, 6, 10, B), // quarto 2 | banheiro
    ...vw(1, 5.8, 6, 10, B), // banheiro | quarto 3
  );
  const rooms = [
    { floor: 0, name: 'Sala', polygon: rect(0, 0, 4.6, 6) },
    { floor: 0, name: 'Cozinha', polygon: rect(4.6, 0, 8, 4.4) },
    { floor: 0, name: 'Hall', polygon: rect(4.6, 4.4, 8, 6) },
    { floor: 0, name: 'Escritório', polygon: rect(0, 6, 4.6, 10) },
    { floor: 0, name: 'Lavabo', polygon: rect(4.6, 6, 6.2, 8.2) },
    {
      floor: 0,
      name: 'Lavanderia',
      polygon: [
        [6.2, 6],
        [8, 6],
        [8, 10],
        [4.6, 10],
        [4.6, 8.2],
        [6.2, 8.2],
      ],
    },
    { floor: 1, name: 'Suíte', polygon: rect(0, 0, 4.6, 4.4) },
    { floor: 1, name: 'Banheiro da Suíte', polygon: rect(4.6, 0, 8, 1.8) },
    { floor: 1, name: 'Quarto 1', polygon: rect(4.6, 1.8, 8, 4.4) },
    { floor: 1, name: 'Corredor', polygon: rect(0, 4.4, 8, 6) },
    { floor: 1, name: 'Quarto 2', polygon: rect(0, 6, 4.0, 10) },
    { floor: 1, name: 'Banheiro', polygon: rect(4.0, 6, 5.8, 10) },
    { floor: 1, name: 'Quarto 3', polygon: rect(5.8, 6, 8, 10) },
  ];
  const routerSpots = [
    [0.5, 3.0, 0.8],
    [4.2, 0.5, 1.0],
    [0.5, 5.5, 0.9],
    [2.4, 0.4, 1.2],
  ];
  const meshSpots = [
    [4.0, 5.6, 1.0],
    [0.6, 5.0, 1.1],
    [7.4, 5.7, 0.9],
  ];
  const [rx, ry, rz] = seed === 1 ? routerSpots[0] : rng.pick(routerSpots);
  const [mx, my, mz] = seed === 1 ? meshSpots[0] : rng.pick(meshSpots);
  const ssid = seed === 1 ? 'Familia Souza' : rng.pick(['Familia Souza', 'Casa Almeida', 'Sobrado 27', 'Lar dos Pereira']);
  const ch24 = seed === 1 ? [1, 11] : rng.shuffle([1, 6, 11]);
  const ch5 = seed === 1 ? [36, 149] : rng.shuffle([36, 44, 149, 157]);
  const spec = {
    name: 'Sobrado',
    floors: 2,
    outline: rect(0, 0, 8, 10),
    walls,
    rooms,
    // Escada reta no hall: sobe de oeste para leste e chega no corredor de cima.
    stairs: [{ fromFloor: 0, toFloor: 1, x: 5.2, y: 5.0, x2: 7.4, y2: 5.0 }],
    clutter: { dbPerM: 0.3 },
    aps: [
      ...factory.ownRouter({ vendor: 'tplink', device: 'roteador', ssid, ch24: ch24[0], ch5: ch5[0], offset5: 1, sec: SEC.wpa23, x: rx, y: ry, z: rz }),
      ...factory.ownRouter({
        vendor: 'tplink',
        device: 'mesh-cima',
        ssid,
        ch24: ch24[1],
        ch5: ch5[1],
        offset5: 1,
        sec: SEC.wpa23,
        eirp24: 18,
        eirp5: 20,
        x: mx,
        y: my,
        z: round3(FLOOR_HEIGHT + mz),
      }),
    ],
  };
  spec.aps.push(
    ...placeNeighbours(rng.fork('neighbours'), factory, spec, {
      bounds: [0, 0, 8, 10],
      bssids: rng.int(7, 10),
      minDist: 10,
      maxDist: 30,
      sameLevelStoreys: 2,
    }),
  );
  return spec;
}

// ---------------------------------------------------------------------------
// Escritório (20 x 14 m)
// ---------------------------------------------------------------------------

function escritorio(seed) {
  const rng = createRng('escritorio', seed);
  const factory = boxFactory(rng.fork('boxes'));
  const C = 'concrete';
  const D = 'drywall';
  const G = 'glass';
  const walls = [
    // Fachada de concreto com panos de vidro.
    ...hw(0, 0, 0, 20, C, [
      [1.0, 3.5, G],
      [5.5, 9.5, G],
      [10.5, 15.5, G],
    ]),
    ...vw(0, 20, 0, 14, C, [
      [4.0, 8.0, G],
      [10.0, 13.0, G],
    ]),
    ...hw(0, 14, 0, 20, C, [
      [1.0, 4.0, G],
      [6.0, 8.0, G],
      [10.0, 12.0, G],
    ]),
    ...vw(0, 0, 0, 14, C, [[1.2, 2.2, 'wood']]), // entrada pela recepção
    // Recepção (divisórias de vidro).
    ...vw(0, 4.5, 0, 3.5, G, [[1.2, 2.2, null]]),
    ...hw(0, 3.5, 0, 4.5, G),
    // Sala do servidor.
    ...vw(0, 17, 0, 3, D, [[1.1, 1.9, 'wood']]),
    ...hw(0, 3, 17, 20, D),
    // Salas ao fundo: frente de vidro, divisórias de drywall.
    ...hw(0, 9, 0, 5, G, [[3.6, 4.5, 'wood']]), // reunião 1
    ...hw(0, 9, 5, 9, G, [[5.5, 6.4, 'wood']]), // reunião 2
    ...hw(0, 9, 9, 13, D, [[11.6, 12.5, 'wood']]), // diretoria
    ...hw(0, 9, 13, 16.5, D, [[14.0, 15.2, null]]), // copa (sem porta)
    ...hw(0, 9, 16.5, 20, 'brick', [[17.6, 18.5, 'wood']]), // banheiros
    ...vw(0, 5, 9, 14, D),
    ...vw(0, 9, 9, 14, D),
    ...vw(0, 13, 9, 14, D),
    ...vw(0, 16.5, 9, 14, 'brick'),
  ];
  const rooms = [
    {
      floor: 0,
      name: 'Salão',
      polygon: [
        [4.5, 0],
        [17, 0],
        [17, 3],
        [20, 3],
        [20, 9],
        [0, 9],
        [0, 3.5],
        [4.5, 3.5],
      ],
    },
    { floor: 0, name: 'Recepção', polygon: rect(0, 0, 4.5, 3.5) },
    { floor: 0, name: 'Servidor', polygon: rect(17, 0, 20, 3) },
    { floor: 0, name: 'Reunião 1', polygon: rect(0, 9, 5, 14) },
    { floor: 0, name: 'Reunião 2', polygon: rect(5, 9, 9, 14) },
    { floor: 0, name: 'Diretoria', polygon: rect(9, 9, 13, 14) },
    { floor: 0, name: 'Copa', polygon: rect(13, 9, 16.5, 14) },
    { floor: 0, name: 'Banheiros', polygon: rect(16.5, 9, 20, 14) },
  ];
  const company = seed === 1 ? 'ANDRADE' : rng.pick(['ANDRADE', 'CONTABIL-LIMA', 'GRUPO-MR', 'ESCRITORIO-SP']);
  // Cinco pontos de acesso no teto; cada um anuncia a rede da empresa e a de visitantes nas duas faixas.
  const mounts = [
    [4.0, 6.0],
    [11.0, 4.5],
    [17.0, 6.5],
    [7.0, 11.5],
    [15.0, 11.5],
  ];
  const plan24 = seed === 1 ? [1, 6, 11, 11, 1] : rng.shuffle([1, 6, 11, 1, 6]);
  const plan5 = seed === 1 ? [36, 52, 100, 149, 116] : rng.shuffle([36, 52, 100, 149, 116]);
  const aps = [];
  mounts.forEach(([x, y], i) => {
    const base = factory.macBase('ubiquiti');
    const jx = seed === 1 ? 0 : rng.float(-1, 1);
    const jy = seed === 1 ? 0 : rng.float(-1, 1);
    const common = { device: `ap-teto-${i + 1}`, own: true, x: round3(x + jx), y: round3(y + jy), z: 2.6 };
    const r24 = factory.radio24({ channel: plan24[i], width: 20, standard: 6, eirp: 17 });
    const r5 = factory.radio5({ channel: plan5[i], width: 80, standard: 6, eirp: 20 });
    aps.push(
      { bssid: factory.mac(base, 0), ssid: `${company}-CORP`, ...r24, capabilities: SEC.eap, ...common },
      { bssid: factory.mac(base, 1), ssid: `${company}-Visitantes`, ...r24, capabilities: SEC.wpa2NoWps, ...common },
      { bssid: factory.mac(base, 8), ssid: `${company}-CORP`, ...r5, capabilities: SEC.eap, ...common },
      { bssid: factory.mac(base, 9), ssid: `${company}-Visitantes`, ...r5, capabilities: SEC.wpa2NoWps, ...common },
    );
  });
  const spec = {
    name: 'Escritório',
    floors: 1,
    outline: rect(0, 0, 20, 14),
    walls,
    rooms,
    stairs: [],
    clutter: { dbPerM: 0.4 },
    aps,
  };
  spec.aps.push(
    ...placeNeighbours(rng.fork('neighbours'), factory, spec, {
      bounds: [0, 0, 20, 14],
      bssids: rng.int(9, 11),
      minDist: 9,
      maxDist: 30,
      levels: [
        [0, 2],
        [1, 3],
        [-1, 3],
      ],
    }),
  );
  return spec;
}

// ---------------------------------------------------------------------------
// Kitnet (5 x 6 m): o caso pequeno e difícil
// ---------------------------------------------------------------------------

function kitnet(seed) {
  const rng = createRng('kitnet', seed);
  const factory = boxFactory(rng.fork('boxes'));
  const B = 'brick';
  const walls = [
    ...hw(0, 0, 0, 5, B, [[0.4, 1.3, 'wood']]),
    ...vw(0, 5, 0, 6, B),
    ...hw(0, 6, 0, 5, B, [
      [0.8, 2.4, 'glass'],
      [3.8, 4.4, 'glass'],
    ]),
    ...vw(0, 0, 0, 6, B),
    ...vw(0, 3.2, 4.0, 6, B, [[4.4, 5.2, 'wood']]), // quarto | banheiro
    ...hw(0, 4.0, 3.2, 5, B),
  ];
  const rooms = [
    {
      floor: 0,
      name: 'Quarto',
      polygon: [
        [0, 0],
        [5, 0],
        [5, 4.0],
        [3.2, 4.0],
        [3.2, 6],
        [0, 6],
      ],
    },
    { floor: 0, name: 'Banheiro', polygon: rect(3.2, 4.0, 5, 6) },
  ];
  const spots = [
    [4.6, 0.4, 1.0],
    [0.4, 5.6, 0.8],
    [2.5, 0.3, 1.5],
    [0.3, 2.5, 0.6],
  ];
  const [rx, ry, rz] = seed === 1 ? spots[0] : rng.pick(spots);
  const id = seed === 1 ? '4C1F7A' : rng.hex(6);
  const spec = {
    name: 'Kitnet',
    floors: 1,
    outline: rect(0, 0, 5, 6),
    walls,
    rooms,
    stairs: [],
    clutter: { dbPerM: 0.5 },
    aps: factory.ownRouter({
      vendor: 'arris',
      device: 'roteador',
      ssid: `CLARO_2G${id}`,
      ssid5: `CLARO_5G${id}`,
      ch24: seed === 1 ? 11 : rng.pick([1, 6, 11]),
      ch5: seed === 1 ? 36 : rng.pick([36, 44, 149]),
      offset5: 8,
      std24: 4,
      std5: 5,
      x: rx,
      y: ry,
      z: rz,
    }),
  };
  spec.aps.push(
    ...placeNeighbours(rng.fork('neighbours'), factory, spec, {
      bounds: [0, 0, 5, 6],
      bssids: rng.int(20, 23),
      minDist: 4,
      maxDist: 20,
      margin: 0.6,
      levels: [
        [0, 5],
        [1, 2.5],
        [-1, 2.5],
        [2, 1],
        [-2, 1],
      ],
    }),
  );
  return spec;
}

// ---------------------------------------------------------------------------
// Casa sorteada
// ---------------------------------------------------------------------------

const SIZES = {
  pequena: { area: [30, 45], rooms: [3, 4] },
  media: { area: [55, 80], rooms: [4, 6] },
  grande: { area: [90, 140], rooms: [5, 7] },
};

/**
 * Sorteia uma casa plausível: retângulo dividido em 3 a 7 cômodos, com portas,
 * janelas, roteador próprio e vizinhança. Serve para avaliar o mapa em plantas que
 * ninguém viu antes.
 * @param {number} seed
 * @param {{size?: 'pequena'|'media'|'grande'}} [options]
 * @returns {import('./world.js').WorldSpec}
 */
export function randomSpec(seed, options = {}) {
  const rng = createRng('casa-sorteada', seed);
  const sizeName = options.size && SIZES[options.size] ? options.size : rng.weighted(['pequena', 'media', 'grande'], [3, 4, 2]);
  const size = SIZES[sizeName];
  const area = rng.float(size.area[0], size.area[1]);
  const aspect = rng.float(1.0, 1.6);
  let W = round1(Math.sqrt(area * aspect));
  let H = round1(area / W);
  if (rng.chance(0.5)) [W, H] = [H, W];
  const roomCount = rng.int(size.rooms[0], size.rooms[1]);
  const building = rng.chance(0.6); // prédio (vizinhos em cima e embaixo) ou casa térrea
  const exterior = building ? 'concrete' : 'brick';
  const interior = rng.chance(0.85) ? 'brick' : 'drywall';

  // Divide o maior cômodo ao meio (mais ou menos) até chegar na quantidade pedida.
  const MIN = 1.9;
  let leaves = [{ x0: 0, y0: 0, x1: W, y1: H }];
  const splits = []; // paredes internas: {vertical, at, from, to}
  for (let guard = 0; leaves.length < roomCount && guard < 60; guard++) {
    const order = leaves
      .map((r, i) => ({ i, area: (r.x1 - r.x0) * (r.y1 - r.y0) * rng.float(0.8, 1.2) }))
      .sort((p, q) => q.area - p.area);
    let done = false;
    for (const { i } of order) {
      const r = leaves[i];
      const w = r.x1 - r.x0;
      const h = r.y1 - r.y0;
      const vertical = w > h * rng.float(0.85, 1.15);
      const span = vertical ? w : h;
      if (span < 2 * MIN) continue;
      const at = round1((vertical ? r.x0 : r.y0) + Math.max(MIN, Math.min(span - MIN, span * rng.float(0.35, 0.65))));
      const a = vertical ? { ...r, x1: at } : { ...r, y1: at };
      const b = vertical ? { ...r, x0: at } : { ...r, y0: at };
      leaves.splice(i, 1, a, b);
      splits.push(vertical ? { vertical, at, from: r.y0, to: r.y1 } : { vertical, at, from: r.x0, to: r.x1 });
      done = true;
      break;
    }
    if (!done) break;
  }

  // Porta de cada parede interna: num trecho livre de encontros com outras paredes,
  // para que os dois lados da porta sejam um cômodo só.
  const walls = [];
  for (const s of splits) {
    const cuts = [s.from, s.to];
    for (const o of splits) {
      if (o === s || o.vertical === s.vertical) continue;
      const touches = Math.abs(o.from - s.at) < 1e-6 || Math.abs(o.to - s.at) < 1e-6;
      if (touches && o.at > s.from + 1e-6 && o.at < s.to - 1e-6) cuts.push(o.at);
    }
    cuts.sort((p, q) => p - q);
    const stretches = [];
    for (let i = 1; i < cuts.length; i++) stretches.push([cuts[i - 1], cuts[i]]);
    const usable = stretches.filter(([p, q]) => q - p >= 1.3);
    const [p, q] = usable.length ? rng.pick(usable) : stretches.sort((u, v) => v[1] - v[0] - (u[1] - u[0]))[0];
    const width = Math.min(rng.float(0.8, 0.95), q - p - 0.3);
    const start = round3(rng.float(p + 0.15, q - 0.15 - width));
    const door = rng.chance(0.3) ? null : 'wood';
    const opening = [[start, round3(start + width), door]];
    walls.push(...(s.vertical ? vw(0, s.at, s.from, s.to, interior, opening) : hw(0, s.at, s.from, s.to, interior, opening)));
  }

  // Paredes externas: uma janela por lado e a porta de entrada num deles.
  const entrance = rng.int(0, 3);
  const sides = [
    [0, 0, W, 0],
    [W, 0, W, H],
    [W, H, 0, H],
    [0, H, 0, 0],
  ];
  sides.forEach(([ax, ay, bx, by], i) => {
    const len = Math.hypot(bx - ax, by - ay);
    const openings = [];
    const winW = Math.min(rng.float(1.2, 2.0), len * 0.3);
    const winAt = rng.float(0.4, len / 2 - winW - 0.2);
    openings.push([winAt, winAt + winW, 'glass']);
    if (i === entrance) {
      const doorAt = rng.float(len / 2 + 0.2, len - 1.3);
      openings.push([doorAt, doorAt + 0.9, 'wood']);
    } else if (len > 6 && rng.chance(0.6)) {
      const at = rng.float(len / 2 + 0.3, len - winW - 0.4);
      openings.push([at, at + winW, 'glass']);
    }
    walls.push(...wallLine(0, ax, ay, bx, by, exterior, openings));
  });

  // Nomes: o maior cômodo é a sala, o menor o banheiro, o resto na ordem de sempre.
  const bySize = leaves.map((r, i) => ({ i, area: (r.x1 - r.x0) * (r.y1 - r.y0) })).sort((p, q) => q.area - p.area);
  const names = new Array(leaves.length);
  const middle = ['Cozinha', 'Quarto 1', 'Quarto 2', 'Escritório', 'Quarto 3'];
  bySize.forEach(({ i }, rank) => {
    if (rank === 0) names[i] = 'Sala';
    else if (rank === bySize.length - 1) names[i] = 'Banheiro';
    else names[i] = middle[rank - 1];
  });
  const rooms = leaves.map((r, i) => ({ floor: 0, name: names[i], polygon: rect(r.x0, r.y0, r.x1, r.y1) }));

  // Roteador da casa: quase sempre na sala, perto de uma parede.
  const factory = boxFactory(rng.fork('boxes'));
  const home = leaves[rng.chance(0.65) ? bySize[0].i : rng.int(0, leaves.length - 1)];
  const nearWall = (r) => {
    const m = rng.float(0.3, 0.6);
    const side = rng.int(0, 3);
    const x = side === 0 ? r.x0 + m : side === 1 ? r.x1 - m : rng.float(r.x0 + 0.4, r.x1 - 0.4);
    const y = side === 2 ? r.y0 + m : side === 3 ? r.y1 - m : rng.float(r.y0 + 0.4, r.y1 - 0.4);
    return [round3(x), round3(y), round3(rng.float(0.6, 1.6))];
  };
  const [rx, ry, rz] = nearWall(home);
  const isp = rng.pick([
    { vendor: 'mitrastar', name: () => `VIVOFIBRA-${rng.hex(4)}`, five: (s) => `${s}-5G` },
    { vendor: 'arris', name: () => `CLARO_2G${rng.hex(6)}`, five: (s) => s.replace('_2G', '_5G') },
    { vendor: 'tplink', name: () => rng.pick(CUSTOM_NAMES), five: (s) => s },
    { vendor: 'huawei', name: () => `TIM_ULTRAFIBRA_${rng.hex(4)}`, five: (s) => `${s}_5G` },
    { vendor: 'intelbras', name: () => `Intelbras_${rng.hex(4)}`, five: (s) => `${s}_5G` },
  ]);
  const ssid = isp.name();
  const aps = factory.ownRouter({
    vendor: isp.vendor,
    device: 'roteador',
    ssid,
    ssid5: isp.five(ssid),
    ch24: rng.pick([1, 6, 11]),
    ch5: rng.pick([36, 44, 149, 157]),
    eirp24: round3(rng.float(17, 20)),
    eirp5: round3(rng.float(19, 22)),
    x: rx,
    y: ry,
    z: rz,
  });
  // Casa grande costuma ter um repetidor do outro lado.
  if (sizeName === 'grande' && rng.chance(0.6)) {
    const far = leaves
      .map((r) => ({ r, d: Math.hypot((r.x0 + r.x1) / 2 - rx, (r.y0 + r.y1) / 2 - ry) }))
      .sort((p, q) => q.d - p.d)[0].r;
    const [ex, ey, ez] = nearWall(far);
    aps.push(
      ...factory.ownRouter({ vendor: 'tplink', device: 'repetidor', ssid: `${ssid}_EXT`, ch24: rng.pick([1, 6, 11]), ch5: null, eirp24: 17, x: ex, y: ey, z: ez }),
    );
  }

  const spec = {
    name: `Casa sorteada ${seed}`,
    floors: 1,
    outline: rect(0, 0, W, H),
    walls,
    rooms,
    stairs: [],
    clutter: { dbPerM: round3(building ? rng.float(0.4, 0.6) : rng.float(0.25, 0.4)) },
    aps,
  };
  spec.aps.push(
    ...placeNeighbours(rng.fork('neighbours'), factory, spec, {
      bounds: [0, 0, W, H],
      bssids: building ? rng.int(10, 20) : rng.int(5, 10),
      minDist: building ? 5 : 9,
      maxDist: building ? 24 : 30,
      levels: building
        ? [
            [0, 4],
            [1, 2.5],
            [-1, 2.5],
            [2, 1],
            [-2, 1],
          ]
        : null,
    }),
  );
  return spec;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const PRESETS = {
  apartamento: {
    name: 'Apartamento',
    description: 'Apartamento de 2 quartos (9 x 7 m) num prédio cheio de redes vizinhas.',
    build: apartamento,
  },
  sobrado: {
    name: 'Sobrado',
    description: 'Casa de dois andares (8 x 10 m) com escada, roteador embaixo e repetidor mesh em cima.',
    build: sobrado,
  },
  escritorio: {
    name: 'Escritório',
    description: 'Escritório de 20 x 14 m: salão, salas de reunião e cinco pontos de acesso no teto.',
    build: escritorio,
  },
  kitnet: {
    name: 'Kitnet',
    description: 'Kitnet de 5 x 6 m (quarto e banheiro) em prédio muito denso: o caso difícil.',
    build: kitnet,
  },
};

/** Lista dos mundos prontos. */
export function listPresets() {
  return Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, description: p.description }));
}

/**
 * Descrição (spec) de um mundo pronto. A semente 1 é a versão "de vitrine".
 * @param {string} id
 * @param {number} [seed]
 * @returns {import('./world.js').WorldSpec}
 */
export function presetSpec(id, seed = 1) {
  const preset = PRESETS[id];
  if (!preset) throw new Error(`mundo desconhecido: ${id}`);
  return preset.build(seed);
}

/** Mundo pronto, já com a propagação montada. */
export function presetWorld(id, seed = 1, rf = {}) {
  return createWorld(presetSpec(id, seed), seed, rf);
}

/** Casa sorteada, já com a propagação montada. */
export function randomWorld(seed, options = {}) {
  return createWorld(randomSpec(seed, options), seed, options.rf || {});
}
