// Varreduras de mentira, mas com cara de verdade, escritas à mão no formato exato do ScanEvent /
// ScanAp de app/js/bridge.js. Servem de base para todos os testes de análise.
//
// Cada cenário exporta o ScanEvent e um objeto `*Truth` com o que se sabe do mundo "real" por
// trás dele (qual é o roteador do usuário, que BSSIDs moram na mesma caixa), para os testes
// conferirem as heurísticas.
//
// Alguns APs trazem `ies` (celular com Android 11+), outros não (celular antigo): numa
// varredura real é tudo ou nada, mas aqui a mistura exercita os dois caminhos.

import { encodeIes } from '../../app/js/core/ies.js';

/** ScanResult.CHANNEL_WIDTH_* */
export const CW = Object.freeze({ W20: 0, W40: 1, W80: 2, W160: 3, W80P80: 4, W320: 5 });

/** 15/11/2025 17:00 UTC */
export const TS = 1763226000000;

const SEC = {
  wpa2: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS][WPS]',
  wpa2NoWps: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]',
  mixed: '[WPA-PSK-CCMP+TKIP][WPA2-PSK-CCMP+TKIP][RSN-PSK-CCMP+TKIP][ESS][WPS]',
  wpa23: '[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][MFPC]',
  wpa3: '[RSN-SAE-CCMP][ESS][MFPR][MFPC]',
  wpa3be: '[RSN-SAE+SAE_EXT_KEY-CCMP+GCMP-256][ESS][MFPR][MFPC]',
  open: '[ESS]',
  eap: '[WPA2-EAP/SHA1+FT/EAP-CCMP][RSN-EAP/SHA1+FT/EAP-CCMP][ESS][MFPC]',
  direct: '[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS][WPS][P2P]',
};

/** Uma linha da lista: os campos obrigatórios do ScanAp e, em `more`, os opcionais. */
function ap(bssid, ssid, level, frequency, channelWidth, centerFreq0, capabilities, more = {}) {
  return { bssid, ssid, level, frequency, channelWidth, centerFreq0, centerFreq1: 0, capabilities, ageMs: 240, ...more };
}

const PSK = { akms: ['PSK'], ciphers: ['CCMP'] };
const PSK_SAE = { akms: ['PSK', 'SAE'], ciphers: ['CCMP'], pmfCapable: true };
const SAE = { akms: ['SAE'], ciphers: ['CCMP'], pmfRequired: true };
const EAP = { akms: ['EAP', 'FT-EAP'], ciphers: ['CCMP'], pmfCapable: true };

// ---------------------------------------------------------------------------
// 1. Prédio de apartamentos lotado
// ---------------------------------------------------------------------------
// Quem mora aqui tem a rede "Familia Souza" (TP-Link, no canal 6 e no 36). Em volta: roteadores
// de operadora de todo tipo, alguns do mesmo lote (MACs colados), redes de convidados e da
// operadora no mesmo rádio, gente estacionada nos canais 3, 4, 8 e 9, e três redes em 40 MHz.

const ASKEY_VIVO = { manufacturer: 'Askey', model: 'RTF8115VW', deviceName: 'RTF8115VW' };

export const apartment = {
  ts: TS,
  fresh: true,
  source: 'request',
  aps: [
    // --- A casa: TP-Link em que o MAC do 5 GHz é o do 2,4 GHz menos 1 (…7e:10 / …7e:0f)
    ap('98:da:c4:3b:7e:10', 'Familia Souza', -48, 2437, CW.W20, 0, SEC.wpa23, {
      ageMs: 120,
      wifiStandard: 6,
      ies: encodeIes({
        frequency: 2437,
        widthMhz: 20,
        country: 'BR',
        bssLoad: { stations: 5, utilization: 0.21 },
        ht: { nss: 2, width40: false },
        he: { nss: 2, bssColor: 12 },
        rsn: PSK_SAE,
        vendorOuis: ['00:0c:e7'],
      }),
    }),
    ap('98:da:c4:3b:7e:0f', 'Familia Souza_5G', -55, 5180, CW.W80, 5210, SEC.wpa23, {
      ageMs: 95,
      wifiStandard: 6,
      ies: encodeIes({
        frequency: 5180,
        widthMhz: 80,
        country: 'BR',
        bssLoad: { stations: 3, utilization: 0.06 },
        ht: { nss: 2, width40: true },
        vht: { nss: 2 },
        he: { nss: 2, bssColor: 12 },
        rsn: PSK_SAE,
        vendorOuis: ['00:0c:e7'],
      }),
    }),

    // --- Dois roteadores da Vivo do MESMO lote (blocos de 8 MACs seguidos): o 5 GHz do
    // primeiro (…:24) fica tão perto do 2,4 GHz do vizinho (…:28) quanto do próprio (…:20).
    ap('e0:ca:94:5c:8a:20', 'VIVOFIBRA-8A20', -62, 2412, CW.W20, 0, SEC.wpa2, {
      wifiStandard: 4,
      ies: encodeIes({
        frequency: 2412,
        widthMhz: 20,
        country: 'BR',
        bssLoad: { stations: 3, utilization: 0.18 },
        ht: { nss: 2, width40: false },
        rsn: PSK,
        wps: ASKEY_VIVO,
        vendorOuis: ['00:10:18'],
      }),
    }),
    ap('e0:ca:94:5c:8a:24', 'VIVOFIBRA-8A20-5G', -71, 5220, CW.W80, 5210, SEC.wpa2, {
      wifiStandard: 5,
      ies: encodeIes({
        frequency: 5220,
        widthMhz: 80,
        country: 'BR',
        ht: { nss: 2, width40: true },
        vht: { nss: 2 },
        rsn: PSK,
        wps: ASKEY_VIVO,
        vendorOuis: ['00:10:18'],
      }),
    }),
    ap('e0:ca:94:5c:8a:28', 'VIVOFIBRA-8A28', -74, 2462, CW.W20, 0, SEC.wpa2, {
      wifiStandard: 4,
      ies: encodeIes({
        frequency: 2462,
        widthMhz: 20,
        country: 'BR',
        ht: { nss: 2, width40: false },
        rsn: PSK,
        wps: ASKEY_VIVO,
        vendorOuis: ['00:10:18'],
      }),
    }),
    ap('e0:ca:94:5c:8a:2c', 'VIVOFIBRA-8A28-5G', -83, 5745, CW.W80, 5775, SEC.wpa2, {
      wifiStandard: 5,
      ies: encodeIes({
        frequency: 5745,
        widthMhz: 80,
        country: 'BR',
        ht: { nss: 2, width40: true },
        vht: { nss: 2 },
        rsn: PSK,
        wps: ASKEY_VIVO,
        vendorOuis: ['00:10:18'],
      }),
    }),

    // --- Claro: a rede do cliente e a rede pública da operadora saem do mesmo rádio
    ap('f8:0b:be:4f:1d:28', 'CLARO_2G4F1D2A', -58, 2437, CW.W20, 0, SEC.wpa2, { wifiStandard: 5 }),
    ap('f8:0b:be:4f:1d:29', '#NET-CLARO-WIFI', -59, 2437, CW.W20, 0, SEC.open, { wifiStandard: 5 }),
    ap('f8:0b:be:4f:1d:30', 'CLARO_5G4F1D2A', -69, 5785, CW.W80, 5775, SEC.wpa2, { wifiStandard: 5 }),
    // Outro apartamento, outro roteador da Claro (só o 2,4 GHz chega até aqui)
    ap('18:62:2c:c0:9b:70', 'CLARO_2GC09B77', -79, 2462, CW.W20, 0, SEC.wpa2),
    ap('18:62:2c:c0:9b:71', '#NET-CLARO-WIFI', -80, 2462, CW.W20, 0, SEC.open),

    // --- NET antiga: 40 MHz em 2,4 GHz (canais 1+5) e WPA/TKIP ainda ligado
    ap('fc:52:8d:d4:e5:f0', 'NET_2GD4E5F6', -67, 2412, CW.W40, 2422, SEC.mixed),
    ap('fc:52:8d:d4:e5:f4', 'NET_5GD4E5F6', -80, 5765, CW.W40, 5755, SEC.mixed),

    ap('48:46:fb:a1:7b:3c', 'Oi_7B3C', -70, 2462, CW.W20, 0, SEC.wpa2, {
      wifiStandard: 4,
      ies: encodeIes({
        frequency: 2462,
        widthMhz: 20,
        country: 'BR',
        bssLoad: { stations: 2, utilization: 0.3 },
        ht: { nss: 2, width40: false },
        rsn: PSK,
        wps: { manufacturer: 'Huawei', model: 'HG8145V5' },
      }),
    }),
    ap('34:4b:50:9e:55:d0', 'TIM_ULTRAFIBRA_55D0', -76, 2437, CW.W20, 0, SEC.wpa2, { wifiStandard: 6 }),

    // --- Dois vizinhos que nunca trocaram o nome de fábrica: mesmo SSID, redes diferentes
    ap('00:1a:3f:77:02:e8', 'INTELBRAS', -72, 2422, CW.W20, 0, SEC.wpa2),
    ap('00:1a:3f:21:9c:04', 'INTELBRAS', -81, 2452, CW.W20, 0, SEC.open),

    ap('50:c7:bf:6d:a9:c4', 'TP-Link_A9C4', -77, 2427, CW.W20, 0, SEC.wpa2),
    ap('1c:7e:e5:90:3e:5a', 'D-Link_DIR-615_3E', -82, 2447, CW.W20, 0, SEC.mixed),

    // --- Mesmo nome nas duas faixas, MACs seguidos
    ap('64:09:80:1e:52:07', 'Casa do Zé', -69, 2412, CW.W20, 0, SEC.wpa23, {
      wifiStandard: 6,
      ies: encodeIes({ frequency: 2412, widthMhz: 20, ht: { nss: 2, width40: false }, he: { nss: 2, bssColor: 33 }, rsn: PSK_SAE }),
    }),
    ap('64:09:80:1e:52:08', 'Casa do Zé', -78, 5745, CW.W80, 5775, SEC.wpa23, {
      wifiStandard: 6,
      ies: encodeIes({
        frequency: 5745,
        widthMhz: 80,
        ht: { nss: 2, width40: true },
        vht: { nss: 2 },
        he: { nss: 2, bssColor: 33 },
        rsn: PSK_SAE,
      }),
    }),

    // --- Apartamentos 302 e 304 compraram o mesmo roteador na mesma loja: MACs a 2 de
    // distância, mesmo canal de fábrica e sinal parecido. São duas caixas!
    ap('c0:25:e9:44:10:3e', 'AP 302', -64, 2437, CW.W20, 0, SEC.wpa2),
    ap('c0:25:e9:44:10:40', 'AP 304', -66, 2437, CW.W20, 0, SEC.wpa2),

    // --- A vizinha que vê novela por streaming o dia todo (o canal 11 vive ocupado)
    ap('b0:95:75:c3:0a:66', 'Wi-Fi da Vovó', -60, 2462, CW.W20, 0, SEC.mixed, {
      wifiStandard: 4,
      ies: encodeIes({
        frequency: 2462,
        widthMhz: 20,
        country: 'BR',
        bssLoad: { stations: 6, utilization: 0.55 },
        rates: { legacy11b: true },
        ht: { nss: 2, width40: false },
        rsn: { akms: ['PSK'], ciphers: ['TKIP', 'CCMP'] },
        wpa: { akms: ['PSK'], ciphers: ['TKIP'] },
        wps: { manufacturer: 'TP-Link', model: 'TL-WR841N', modelNumber: '13.0' },
      }),
    }),
    // 40 MHz com o primário no 6 e o secundário no 10: atrapalha do 6 ao 11
    ap('14:eb:b6:2a:f1:9c', 'Republica dos Brothers', -73, 2437, CW.W40, 2447, SEC.wpa2, { wifiStandard: 4 }),
    ap('28:6e:d4:5b:c2:e1', '', -78, 2462, CW.W20, 0, SEC.wpa2NoWps),
    // Não foi ouvida nesta varredura: o Android repetiu a leitura de 41 s atrás
    ap('84:c9:b2:7f:30:15', 'Mengão 2019', -83, 2412, CW.W20, 0, SEC.wpa2, { ageMs: 41000 }),
    // Celular fazendo de roteador: MAC sorteado (bit "administrado localmente" ligado)
    ap('3e:5a:91:0c:44:d2', 'iPhone de Bruna', -57, 2437, CW.W20, 0, SEC.wpa2NoWps, { wifiStandard: 6 }),
  ],
};

export const apartmentTruth = {
  own: { ssid: 'Familia Souza', b24: '98:da:c4:3b:7e:10', b5: '98:da:c4:3b:7e:0f' },
  devices: [
    ['98:da:c4:3b:7e:10', '98:da:c4:3b:7e:0f'],
    ['e0:ca:94:5c:8a:20', 'e0:ca:94:5c:8a:24'],
    ['e0:ca:94:5c:8a:28', 'e0:ca:94:5c:8a:2c'],
    ['f8:0b:be:4f:1d:28', 'f8:0b:be:4f:1d:29', 'f8:0b:be:4f:1d:30'],
    ['18:62:2c:c0:9b:70', '18:62:2c:c0:9b:71'],
    ['fc:52:8d:d4:e5:f0', 'fc:52:8d:d4:e5:f4'],
    ['48:46:fb:a1:7b:3c'],
    ['34:4b:50:9e:55:d0'],
    ['00:1a:3f:77:02:e8'],
    ['00:1a:3f:21:9c:04'],
    ['50:c7:bf:6d:a9:c4'],
    ['1c:7e:e5:90:3e:5a'],
    ['64:09:80:1e:52:07', '64:09:80:1e:52:08'],
    ['c0:25:e9:44:10:3e'],
    ['c0:25:e9:44:10:40'],
    ['b0:95:75:c3:0a:66'],
    ['14:eb:b6:2a:f1:9c'],
    ['28:6e:d4:5b:c2:e1'],
    ['84:c9:b2:7f:30:15'],
    ['3e:5a:91:0c:44:d2'],
  ],
};

// ---------------------------------------------------------------------------
// 2. Casa sossegada (sítio): o roteador da casa e um vizinho distante
// ---------------------------------------------------------------------------

export const quietHouse = {
  ts: TS + 600_000,
  fresh: true,
  source: 'request',
  aps: [
    ap('b0:95:75:10:aa:c0', 'Sítio Boa Vista', -52, 2437, CW.W20, 0, SEC.wpa2, { ageMs: 80 }),
    ap('b0:95:75:10:aa:c1', 'Sítio Boa Vista', -61, 5745, CW.W80, 5775, SEC.wpa2, { ageMs: 60 }),
    ap('00:1a:3f:8c:41:d6', 'Chacara do Tonho', -84, 2462, CW.W20, 0, SEC.wpa2, { ageMs: 310 }),
  ],
};

export const quietHouseTruth = {
  own: { ssid: 'Sítio Boa Vista', b24: 'b0:95:75:10:aa:c0', b5: 'b0:95:75:10:aa:c1' },
  devices: [['b0:95:75:10:aa:c0', 'b0:95:75:10:aa:c1'], ['00:1a:3f:8c:41:d6']],
};

// ---------------------------------------------------------------------------
// 3. Mesh: um nome de rede em 3 aparelhos, cada um com 2,4 e 5 GHz
// ---------------------------------------------------------------------------
// Kit de três nós com MACs seguidos (blocos de 4), todos nos mesmos canais. Os dois nós mais
// próximos ainda anunciam, nos 5 GHz, a rede oculta que liga um nó ao outro (mesmo MAC do
// rádio com o primeiro octeto trocado).

const decoIes = (frequency, widthMhz, color) =>
  encodeIes({
    frequency,
    widthMhz,
    country: 'BR',
    ht: { nss: 2, width40: widthMhz >= 40 },
    ...(frequency > 5000 ? { vht: { nss: 2 } } : {}),
    he: { nss: 2, bssColor: color },
    rsn: PSK_SAE,
    roaming: { k: true, v: true, r: true },
    vendorOuis: ['00:03:7f'],
  });

export const mesh = {
  ts: TS + 3_600_000,
  fresh: true,
  source: 'request',
  aps: [
    // nó da sala
    ap('14:eb:b6:8d:21:50', 'Casa Oliveira', -45, 2412, CW.W20, 0, SEC.wpa23, { wifiStandard: 6, ies: decoIes(2412, 20, 7) }),
    ap('14:eb:b6:8d:21:51', 'Casa Oliveira', -52, 5220, CW.W80, 5210, SEC.wpa23, { wifiStandard: 6, ies: decoIes(5220, 80, 7) }),
    ap('1a:eb:b6:8d:21:51', '', -52, 5220, CW.W80, 5210, SEC.wpa2NoWps, { wifiStandard: 6 }),
    // nó do corredor
    ap('14:eb:b6:8d:21:54', 'Casa Oliveira', -63, 2412, CW.W20, 0, SEC.wpa23, { wifiStandard: 6, ies: decoIes(2412, 20, 7) }),
    ap('14:eb:b6:8d:21:55', 'Casa Oliveira', -71, 5220, CW.W80, 5210, SEC.wpa23, { wifiStandard: 6, ies: decoIes(5220, 80, 7) }),
    ap('1a:eb:b6:8d:21:55', '', -72, 5220, CW.W80, 5210, SEC.wpa2NoWps, { wifiStandard: 6 }),
    // nó do quarto dos fundos
    ap('14:eb:b6:8d:21:58', 'Casa Oliveira', -74, 2412, CW.W20, 0, SEC.wpa23, { wifiStandard: 6, ies: decoIes(2412, 20, 7) }),
    ap('14:eb:b6:8d:21:59', 'Casa Oliveira', -82, 5220, CW.W80, 5210, SEC.wpa23, { wifiStandard: 6, ies: decoIes(5220, 80, 7) }),
    // vizinhos
    ap('d8:c6:78:41:c5:d0', 'VIVOFIBRA-C5D0', -77, 2462, CW.W20, 0, SEC.wpa2, { wifiStandard: 4 }),
    ap('d8:c6:78:41:c5:d4', 'VIVOFIBRA-C5D0-5G', -86, 5745, CW.W80, 5775, SEC.wpa2, { wifiStandard: 5 }),
    ap('00:1a:3f:5e:10:9a', 'Intelbras_109A', -81, 2437, CW.W20, 0, SEC.wpa2, { wifiStandard: 4 }),
  ],
};

export const meshTruth = {
  own: { ssid: 'Casa Oliveira', b24: '14:eb:b6:8d:21:50', b5: '14:eb:b6:8d:21:51' },
  nodes: [
    ['14:eb:b6:8d:21:50', '14:eb:b6:8d:21:51', '1a:eb:b6:8d:21:51'],
    ['14:eb:b6:8d:21:54', '14:eb:b6:8d:21:55', '1a:eb:b6:8d:21:55'],
    ['14:eb:b6:8d:21:58', '14:eb:b6:8d:21:59'],
  ],
  devices: [
    ['14:eb:b6:8d:21:50', '14:eb:b6:8d:21:51', '1a:eb:b6:8d:21:51'],
    ['14:eb:b6:8d:21:54', '14:eb:b6:8d:21:55', '1a:eb:b6:8d:21:55'],
    ['14:eb:b6:8d:21:58', '14:eb:b6:8d:21:59'],
    ['d8:c6:78:41:c5:d0', 'd8:c6:78:41:c5:d4'],
    ['00:1a:3f:5e:10:9a'],
  ],
};

// ---------------------------------------------------------------------------
// 4. Escritório: rede corporativa em vários pontos de acesso
// ---------------------------------------------------------------------------
// Três APs de teto. Cada rádio anuncia três redes ("Corp" com login, "Corp-Visitantes" aberta
// e uma oculta para impressoras), em MACs seguidos; o rádio de 5 GHz fica 16 endereços acima
// do de 2,4 GHz. Os dois primeiros APs saíram da mesma caixa: os blocos de MAC são vizinhos.
// Os 5 GHz usam canais DFS (52 e 100) em 40 MHz. Todos informam o BSS Load.

const corpIes = (frequency, widthMhz, akm, stations, utilization) =>
  encodeIes({
    frequency,
    widthMhz,
    country: 'BR',
    bssLoad: { stations, utilization },
    txPowerDbm: frequency > 5000 ? 17 : 14,
    ht: { nss: 2, width40: widthMhz >= 40 },
    ...(frequency > 5000 ? { vht: { nss: 2 } } : {}),
    he: { nss: 2, bssColor: 21 },
    ...(akm ? { rsn: akm } : {}),
    roaming: { k: true, v: true, r: akm === EAP },
    vendorOuis: ['00:0b:86'],
  });

/** Os três BSSIDs de um rádio corporativo (MAC base + 0, 1, 2). */
function corpRadio(prefix, base, level, frequency, channelWidth, centerFreq0, stations, utilization) {
  const widthMhz = channelWidth === CW.W40 ? 40 : 20;
  const mac = (n) => `${prefix}:${(base + n).toString(16).padStart(2, '0')}`;
  return [
    ap(mac(0), 'Corp', level, frequency, channelWidth, centerFreq0, SEC.eap, {
      wifiStandard: 6,
      ies: corpIes(frequency, widthMhz, EAP, stations[0], utilization),
    }),
    ap(mac(1), 'Corp-Visitantes', level - 1, frequency, channelWidth, centerFreq0, SEC.open, {
      wifiStandard: 6,
      ies: corpIes(frequency, widthMhz, null, stations[1], utilization),
    }),
    ap(mac(2), '', level, frequency, channelWidth, centerFreq0, SEC.wpa2NoWps, {
      wifiStandard: 6,
      ies: corpIes(frequency, widthMhz, PSK, stations[2], utilization),
    }),
  ];
}

export const office = {
  ts: TS + 7_200_000,
  fresh: true,
  source: 'request',
  aps: [
    // AP da recepção (o mais próximo): canal 1 e canal 52 (DFS)
    ...corpRadio('24:de:c6:8a:31', 0x40, -50, 2412, CW.W20, 0, [7, 2, 4], 0.42),
    ...corpRadio('24:de:c6:8a:31', 0x50, -56, 5260, CW.W40, 5270, [11, 1, 0], 0.18),
    // AP da sala 2: canal 6 e canal 100 (DFS)
    ...corpRadio('24:de:c6:8a:31', 0x60, -66, 2437, CW.W20, 0, [3, 0, 2], 0.27),
    ...corpRadio('24:de:c6:8a:31', 0x70, -72, 5500, CW.W40, 5510, [6, 0, 0], 0.09),
    // AP da diretoria (outro lote): canal 11 e canal 36
    ...corpRadio('94:b4:0f:c2:7d', 0xa0, -75, 2462, CW.W20, 0, [1, 0, 1], 0.12),
    ...corpRadio('94:b4:0f:c2:7d', 0xb0, -81, 5180, CW.W40, 5190, [2, 0, 0], 0.04),
    // A empresa do andar de baixo
    ap('c8:be:19:33:0e:a4', 'Escritorio_Contabil', -75, 2437, CW.W20, 0, SEC.wpa2, { wifiStandard: 4 }),
    ap('c8:be:19:33:0e:a5', 'Escritorio_Contabil_5G', -80, 5180, CW.W80, 5210, SEC.wpa2, { wifiStandard: 5 }),
    // Impressora com Wi-Fi Direct ligado
    ap('fa:da:0c:7c:19:b3', 'DIRECT-7C-HP OfficeJet 8010', -60, 2437, CW.W20, 0, SEC.direct, { wifiStandard: 4 }),
  ],
};

export const officeTruth = {
  // o celular está conectado no AP da recepção
  own: { ssid: 'Corp', b24: '24:de:c6:8a:31:40', b5: '24:de:c6:8a:31:50' },
  devices: [
    ['24:de:c6:8a:31:40', '24:de:c6:8a:31:41', '24:de:c6:8a:31:42', '24:de:c6:8a:31:50', '24:de:c6:8a:31:51', '24:de:c6:8a:31:52'],
    ['24:de:c6:8a:31:60', '24:de:c6:8a:31:61', '24:de:c6:8a:31:62', '24:de:c6:8a:31:70', '24:de:c6:8a:31:71', '24:de:c6:8a:31:72'],
    ['94:b4:0f:c2:7d:a0', '94:b4:0f:c2:7d:a1', '94:b4:0f:c2:7d:a2', '94:b4:0f:c2:7d:b0', '94:b4:0f:c2:7d:b1', '94:b4:0f:c2:7d:b2'],
    ['c8:be:19:33:0e:a4', 'c8:be:19:33:0e:a5'],
    ['fa:da:0c:7c:19:b3'],
  ],
};

// ---------------------------------------------------------------------------
// 5. Wi-Fi 6E / Wi-Fi 7: 6 GHz em 160 e 320 MHz, com Reduced Neighbor Report
// ---------------------------------------------------------------------------
// O roteador da casa é Wi-Fi 7 tri-band com MLO (o mesmo AP MLD nos três rádios). O vizinho tem
// um Wi-Fi 6E cujo rádio de 6 GHz usa um MAC sem parentesco com os outros dois: só o RNR dos
// beacons de 2,4 e 5 GHz diz que é a mesma caixa.

const MLD = 'b2:95:75:e1:40:a0';
const be6 = { opClass: 137, channel: 37, bssid: 'b0:95:75:e1:40:a2', ssid: 'Lar Conectado', sameSsid: true };
const ax6 = { opClass: 134, channel: 5, bssid: 'c8:be:19:5a:9d:42', ssid: 'Apto 1201', sameSsid: true };

export const wifi7 = {
  ts: TS + 10_800_000,
  fresh: true,
  source: 'request',
  aps: [
    // --- Roteador da casa (Wi-Fi 7)
    ap('b0:95:75:e1:40:a0', 'Lar Conectado', -47, 2437, CW.W20, 0, SEC.wpa23, {
      ageMs: 150,
      wifiStandard: 8,
      mld: MLD,
      ies: encodeIes({
        frequency: 2437,
        widthMhz: 20,
        country: 'BR',
        ht: { nss: 2, width40: false },
        he: { nss: 2, bssColor: 5 },
        eht: { nss: 2, mldMac: MLD, linkId: 0, maxSimultaneousLinks: 3 },
        rsn: PSK_SAE,
        rnr: [be6],
      }),
    }),
    // 160 MHz nos 5 GHz: o Android manda o centro do 80 MHz primário e o dos 160 MHz
    {
      ...ap('b0:95:75:e1:40:a1', 'Lar Conectado', -54, 5180, CW.W160, 5210, SEC.wpa23, {
        ageMs: 130,
        wifiStandard: 8,
        mld: MLD,
        ies: encodeIes({
          frequency: 5180,
          widthMhz: 160,
          country: 'BR',
          ht: { nss: 2, width40: true },
          vht: { nss: 2, width160: true },
          he: { nss: 2, bssColor: 5, width160: true },
          eht: { nss: 2, mldMac: MLD, linkId: 1, maxSimultaneousLinks: 3 },
          rsn: PSK_SAE,
          rnr: [be6],
        }),
      }),
      centerFreq1: 5250,
    },
    // 320 MHz nos 6 GHz: canal 37 (PSC) no bloco 1–61
    {
      ...ap('b0:95:75:e1:40:a2', 'Lar Conectado', -60, 6135, CW.W320, 6185, SEC.wpa3be, {
        ageMs: 110,
        wifiStandard: 8,
        mld: MLD,
        rttResponder: true,
        ies: encodeIes({
          frequency: 6135,
          widthMhz: 320,
          country: 'BR',
          he: { nss: 2, bssColor: 5, width160: true },
          eht: { nss: 2, width320: true, mldMac: MLD, linkId: 2, maxSimultaneousLinks: 3 },
          rsn: { akms: ['SAE', 'SAE-EXT-KEY'], ciphers: ['CCMP', 'GCMP-256'], pmfRequired: true },
          ftmResponder: true,
        }),
      }),
      centerFreq1: 6105,
    },

    // --- Vizinho com Wi-Fi 6E (sem MLO)
    ap('c8:be:19:5a:07:10', 'Apto 1201', -70, 2412, CW.W20, 0, SEC.wpa23, {
      wifiStandard: 6,
      ies: encodeIes({ frequency: 2412, widthMhz: 20, ht: { nss: 2, width40: false }, he: { nss: 2, bssColor: 40 }, rsn: PSK_SAE, rnr: [ax6] }),
    }),
    ap('c8:be:19:5a:07:11', 'Apto 1201', -77, 5745, CW.W80, 5775, SEC.wpa23, {
      wifiStandard: 6,
      ies: encodeIes({
        frequency: 5745,
        widthMhz: 80,
        ht: { nss: 2, width40: true },
        vht: { nss: 2 },
        he: { nss: 2, bssColor: 40 },
        rsn: PSK_SAE,
        rnr: [ax6],
      }),
    }),
    // 160 MHz nos 6 GHz: canal 5 (PSC) no bloco 1–29, que cai dentro dos 320 MHz da casa
    {
      ...ap('c8:be:19:5a:9d:42', 'Apto 1201', -79, 5975, CW.W160, 5985, SEC.wpa3, {
        wifiStandard: 6,
        ies: encodeIes({ frequency: 5975, widthMhz: 160, he: { nss: 2, bssColor: 40, width160: true }, rsn: SAE }),
      }),
      centerFreq1: 6025,
    },

    // --- Mais longe: um 6E em 80 MHz no canal 69 (PSC) e um Wi-Fi 5 comum
    ap('74:83:c2:9f:66:1b', 'Cobertura_6G', -84, 6295, CW.W80, 6305, SEC.wpa3, { wifiStandard: 6 }),
    ap('d8:c6:78:02:be:e0', 'VIVOFIBRA-BEE0', -73, 2462, CW.W20, 0, SEC.wpa2, { wifiStandard: 4 }),
    ap('d8:c6:78:02:be:e4', 'VIVOFIBRA-BEE0-5G', -82, 5500, CW.W80, 5530, SEC.wpa2, { wifiStandard: 5 }),
  ],
};

export const wifi7Truth = {
  own: { ssid: 'Lar Conectado', b24: 'b0:95:75:e1:40:a0', b5: 'b0:95:75:e1:40:a1', b6: 'b0:95:75:e1:40:a2', mld: MLD },
  devices: [
    ['b0:95:75:e1:40:a0', 'b0:95:75:e1:40:a1', 'b0:95:75:e1:40:a2'],
    ['c8:be:19:5a:07:10', 'c8:be:19:5a:07:11', 'c8:be:19:5a:9d:42'],
    ['74:83:c2:9f:66:1b'],
    ['d8:c6:78:02:be:e0', 'd8:c6:78:02:be:e4'],
  ],
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

export const ALL = Object.freeze({ apartment, quietHouse, mesh, office, wifi7 });
export const TRUTH = Object.freeze({
  apartment: apartmentTruth,
  quietHouse: quietHouseTruth,
  mesh: meshTruth,
  office: officeTruth,
  wifi7: wifi7Truth,
});

/**
 * A próxima varredura depois de `prev`, `dtMs` mais tarde. Os BSSIDs em `heard` ({bssid: dBm})
 * foram ouvidos de novo (sinal novo, `ageMs` pequeno); os outros são repetidos pelo Android como
 * estavam, só mais velhos. `gone` lista os que saem da lista.
 * @param {object} prev  ScanEvent
 * @param {{dtMs?: number, heard?: Object<string, number>, gone?: string[], fresh?: boolean}} [change]
 */
export function nextScan(prev, change = {}) {
  const { dtMs = 30_000, heard = {}, gone = [], fresh = true } = change;
  return {
    ts: prev.ts + dtMs,
    fresh,
    source: fresh ? 'request' : 'cache',
    aps: prev.aps
      .filter((a) => !gone.includes(a.bssid))
      .map((a) => (a.bssid in heard ? { ...a, level: heard[a.bssid], ageMs: 200 } : { ...a, ageMs: a.ageMs + dtMs })),
  };
}

/** Cópia de um ScanEvent com APs a mais (para testar "e se aparecer um vizinho no canal X?"). */
export function withAps(event, extra) {
  return { ...event, aps: [...event.aps, ...extra] };
}

/** Um ScanAp simples para montar casos nos testes. */
export function makeAp(bssid, ssid, level, frequency, more = {}) {
  return ap(bssid, ssid, level, frequency, CW.W20, 0, SEC.wpa2, more);
}
