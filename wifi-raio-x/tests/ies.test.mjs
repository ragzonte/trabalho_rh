// Testes de app/js/core/ies.js.
//
// Os vetores "escritos à mão" abaixo NÃO saem do encodeIes: cada byte foi derivado do
// leiaute do padrão 802.11 (comentado ao lado), para que um erro simétrico no
// codificador e no decodificador não passe despercebido.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseIes, summarizeIes, encodeIes, shortSsid } from '../app/js/core/ies.js';
import { parseCapabilities, refineWithIes } from '../app/js/core/security.js';

/** Junta pedaços de hex ignorando espaços (para poder comentar byte a byte). */
const hx = (...parts) => parts.join('').replace(/\s+/g, '');
const ie = (id, hex, ext = 0) => ({ id, ext, hex: hx(hex) });
const one = (id, hex, ext = 0) => parseIes([ie(id, hex, ext)]);

// ---------------------------------------------------------------------------
// Vetores escritos à mão
// ---------------------------------------------------------------------------

// RSN de uma rede WPA2-PSK com AES (o elemento mais comum que existe).
const RSN_WPA2_PSK = hx(
  '01 00', //        Version = 1 (little-endian)
  '00 0f ac 04', //  Group Data Cipher: OUI 00-0F-AC, tipo 4 = CCMP
  '01 00', //        Pairwise Cipher Suite Count = 1
  '00 0f ac 04', //  CCMP
  '01 00', //        AKM Suite Count = 1
  '00 0f ac 02', //  tipo 2 = PSK
  '00 00', //        RSN Capabilities = 0 (sem PMF)
);

// RSN de uma rede só WPA3 (SAE) com PMF obrigatório.
const RSN_WPA3_SAE = hx(
  '01 00', //        Version = 1
  '00 0f ac 04', //  grupo: CCMP
  '01 00', '00 0f ac 04', //  1 cifra par a par: CCMP
  '01 00', '00 0f ac 08', //  1 AKM: tipo 8 = SAE
  'c0 00', //        RSN Capabilities = 0x00C0: bit 6 (MFPR) + bit 7 (MFPC)
  '00 00', //        PMKID Count = 0
  '00 0f ac 06', //  Group Management Cipher: tipo 6 = BIP-CMAC-128
);

// Transição WPA2/WPA3: dois AKMs, PMF opcional.
const RSN_TRANSITION = hx(
  '01 00',
  '00 0f ac 04',
  '01 00', '00 0f ac 04',
  '02 00', '00 0f ac 02', '00 0f ac 08', //  2 AKMs: PSK e SAE
  '80 00', //        0x0080: só o bit 7 (MFPC)
);

// WPA2 "misto": TKIP e CCMP par a par, grupo em TKIP.
const RSN_TKIP_CCMP = hx(
  '01 00',
  '00 0f ac 02', //  grupo: tipo 2 = TKIP
  '02 00', '00 0f ac 04', '00 0f ac 02', //  CCMP e TKIP
  '01 00', '00 0f ac 02', //  PSK
  '0c 00', //        0x000C: 16 contadores de repetição PTKSA (bits 2-3); sem PMF
);

// Elemento WPA (WPA1) da Microsoft: mesmo leiaute do RSN, com OUI 00-50-F2.
const VENDOR_WPA1_TKIP = hx(
  '00 50 f2 01', //  OUI Microsoft + tipo 1 = WPA
  '01 00', //        Version = 1
  '00 50 f2 02', //  grupo: TKIP
  '01 00', '00 50 f2 02', //  1 cifra par a par: TKIP
  '01 00', '00 50 f2 02', //  1 AKM: tipo 2 = PSK
);

// BSS Load.
const BSS_LOAD = hx(
  '07 00', //  Station Count = 7 (u16 little-endian)
  '80', //     Channel Utilization = 128 de 255
  '34 12', //  Available Admission Capacity = 0x1234
);

// HT Capabilities de um roteador 2x2 com 40 MHz. Corpo de 26 bytes.
const HT_CAP_2SS = hx(
  // HT Capability Info = 0x09EF:
  //   bit 0 LDPC (0x0001) + bit 1 40 MHz (0x0002) + bits 2-3 = 3, SM power save desligado (0x000C)
  //   + bit 5 SGI 20 (0x0020) + bit 6 SGI 40 (0x0040) + bit 7 Tx STBC (0x0080)
  //   + bits 8-9 = 1, Rx STBC de 1 fluxo (0x0100) + bit 11 A-MSDU de 7935 (0x0800)
  'ef 09',
  '1b', //  A-MPDU Parameters: expoente 3 (bits 0-1) + espaçamento 6 (bits 2-4): 0x03 | 6 << 2
  'ff ff 00 00 00 00 00 00 00 00', //  Rx MCS Bitmask (10 bytes): MCS 0-15 = 2 fluxos espaciais
  '00 00', //  Rx Highest Supported Data Rate
  '01', //     Tx MCS Set Defined
  '00 00 00', //  reservado (fecha os 16 bytes do Supported MCS Set)
  '00 00', //  HT Extended Capabilities
  '00 00 00 00', //  Transmit Beamforming Capabilities
  '00', //     ASEL Capabilities
);

// HT Capabilities de um AP 3x3 só de 20 MHz.
const HT_CAP_3SS_20 = hx(
  '2c 01', //  0x012C: SM power save desligado (0x000C) + SGI 20 (0x0020) + Rx STBC 1 (0x0100)
  '17',
  'ff ff ff 00 00 00 00 00 00 00', //  MCS 0-23 = 3 fluxos
  '00 00', '01', '00 00 00', '00 00', '00 00 00 00', '00',
);

// HT Operation: canal primário 36, secundário acima. Corpo de 22 bytes.
const HT_OP_36_ABOVE = hx(
  '24', //  Primary Channel = 36
  '05', //  bits 0-1 = 1 (secundário acima) + bit 2 (STA pode usar qualquer largura)
  '17 00', //  0x0017: proteção 3 (misto com não-HT) + bit 2 (há STAs sem greenfield) + bit 4 (OBSS não-HT)
  '00 00', //  parâmetros de STBC
  '00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00', //  Basic HT-MCS Set (16 bytes)
);

// VHT Capabilities de um AP 3x3 de 80 MHz. Corpo de 12 bytes.
const VHT_CAP_3SS = hx(
  // VHT Capabilities Info = 0x038A79B2:
  //   bits 0-1 = 2, MPDU de 11454 (0x2) + bits 2-3 = 0, sem 160 MHz
  //   + bit 4 Rx LDPC (0x10) + bit 5 SGI 80 (0x20) + bit 7 Tx STBC (0x80) + bits 8-10 = 1, Rx STBC (0x100)
  //   + bit 11 SU beamformer (0x800) + bit 12 SU beamformee (0x1000)
  //   + bits 13-15 = 3, beamformee STS (0x6000) + bits 16-18 = 2, dimensões de sondagem (0x20000)
  //   + bit 19 MU beamformer (0x80000) + bits 23-25 = 7, A-MPDU máximo (0x3800000)
  'b2 79 8a 03',
  // Rx VHT-MCS Map = 0xFFEA: 2 bits por fluxo; fluxos 1, 2 e 3 = 2 (MCS 0-9), fluxos 4 a 8 = 3 (não suportado)
  //   byte baixo: 11 10 10 10 = 0xEA; byte alto: 0xFF
  'ea ff',
  '00 00', //  Rx Highest Supported Long GI Data Rate
  'ea ff', //  Tx VHT-MCS Map
  '00 00', //  Tx Highest Supported Long GI Data Rate
);

// VHT Capabilities 4x4 com 160 MHz, onde os fluxos 3 e 4 só chegam ao MCS 7.
const VHT_CAP_4SS_160 = hx(
  // 0x7E: MPDU 11454 (0x2) + bits 2-3 = 1, 160 MHz (0x4) + Rx LDPC (0x10) + SGI 80 (0x20) + SGI 160 (0x40);
  // 0x10 no segundo byte = bit 12, SU beamformee; 0x10 no terceiro = bit 20, MU beamformee
  '76 10 10 00',
  '0a ff', //  0xFF0A: fluxos 1 e 2 = 2 (MCS 0-9), fluxos 3 e 4 = 0 (MCS 0-7): 00 00 10 10 = 0x0A
  '00 00', '0a ff', '00 00',
);

// Country: "BR", qualquer ambiente, canais 1 a 13 com 20 dBm.
const COUNTRY_BR = hx(
  '42 52', //  'B' 'R'
  '20', //     ' ' = vale para qualquer ambiente
  '01 0d 14', //  primeiro canal 1, 13 canais, potência máxima 20 dBm
);

// Country de um AP de 5 GHz, uso interno, com byte de preenchimento no fim.
const COUNTRY_BR_5G = hx(
  '42 52 49', //  "BR" + 'I' (indoor)
  '24 04 17', //  canais 36-48 (4 canais), 23 dBm
  '34 04 17', //  canais 52-64, 23 dBm
  '64 0c 18', //  12 canais a partir do 100, 24 dBm
  '95 05 1e', //  149-165, 30 dBm
  '00', //        preenchimento para o tamanho ficar par
);

// WPS com nome do aparelho (TLVs big-endian: tipo, tamanho, valor).
const VENDOR_WPS = hx(
  '00 50 f2 04', //  OUI Microsoft + tipo 4 = WPS
  '10 4a 00 01 10', //  Version = 0x10 (1.0)
  '10 44 00 01 02', //  Wi-Fi Protected Setup State = 2 (configurado)
  '10 57 00 01 01', //  AP Setup Locked = verdadeiro
  '10 3b 00 01 03', //  Response Type = 3 (AP)
  '10 21 00 07 54 50 2d 4c 49 4e 4b', //  Manufacturer = "TP-LINK"
  '10 23 00 09 41 72 63 68 65 72 20 43 36', //  Model Name = "Archer C6"
  '10 24 00 03 31 2e 30', //  Model Number = "1.0"
  '10 11 00 0b 45 73 63 72 69 74 c3 b3 72 69 6f', //  Device Name = "Escritório" (ó = C3 B3 em UTF-8)
  // Config Methods = 0x2688: visor (0x0008) + botão (0x0080) + botão virtual (0x0200) + físico (0x0400) + PIN no visor virtual (0x2000)
  '10 08 00 02 26 88',
  '10 49 00 06 00 37 2a 00 01 20', //  Vendor Extension da WFA (00-37-2A): subelemento 0 (Version2), 1 byte, 0x20 = 2.0
);

// HE Operation com a cor 37 do BSS. Corpo mínimo de 6 bytes.
const HE_OP_COLOR_37 = hx(
  // HE Operation Parameters (24 bits) = 0x003FF4:
  //   bits 0-2 = 4 (duração de PE padrão) + bits 4-13 = 1023 (limiar de RTS por TXOP desligado): 4 | 1023 << 4
  'f4 3f 00',
  '25', //     BSS Color Information: bits 0-5 = 37; bit 6 (cor parcial) e bit 7 (cor desligada) zerados
  'fc ff', //  Basic HE-MCS And NSS Set: 1 fluxo com MCS 0-7 e os demais não suportados
);

// HE Operation em 6 GHz: canal 37, 80 MHz, AP de potência padrão.
const HE_OP_6GHZ = hx(
  'f4 3f 02', //  o mesmo de cima + bit 17 (6 GHz Operation Information Present) = 0x02 no terceiro byte
  '05', //        cor 5
  'fc ff',
  '25', //        Primary Channel = 37
  '0a', //        Control: bits 0-1 = 2 (80 MHz) + bits 3-5 = 1 (standard power): 2 | 1 << 3
  '27', //        Channel Center Frequency Segment 0 = 39
  '00', //        Segment 1 = 0
  '06', //        Minimum Rate = 6 Mb/s
);

// HE Operation com VHT Operation Information e Co-Hosted BSS, e a cor desligada.
const HE_OP_VHT_COHOSTED = hx(
  'f4 ff 00', //  + bit 14 (VHT Operation Information Present) + bit 15 (Co-Hosted BSS): 0x3FF4 | 0xC000 = 0xFFF4
  '8c', //        cor 12 com o bit 7 (BSS Color Disabled)
  'fc ff',
  '01 2a 00', //  VHT Operation Information: largura 1, centro 42, segundo centro 0
  '03', //        Max Co-Hosted BSSID Indicator
);

// HE Capabilities de um AP 2x2 em 2,4 GHz com 40 MHz. 6 + 11 + 4 = 21 bytes.
const HE_CAP_24 = hx(
  // HE MAC Capabilities (6 bytes): bit 0 (+HTC-HE) + bit 2 (TWT responder) = 0x05; bit 20 (broadcast TWT) = 0x10 no 3º byte
  '05 00 10 00 00 00',
  // HE PHY Capabilities (11 bytes):
  //   byte 0 = 0x02: bit 1, 40 MHz em 2,4 GHz
  //   byte 1 = 0x20: bit 13, LDPC
  //   byte 2 = 0x40: bit 22, UL MU-MIMO em banda cheia
  //   byte 3 = 0x80: bit 31, SU beamformer
  //   byte 4 = 0x03: bit 32, SU beamformee + bit 33, MU beamformer
  '02 20 40 80 03 00 00 00 00 00 00',
  'fa ff', //  Rx HE-MCS Map (<= 80 MHz) = 0xFFFA: fluxos 1 e 2 = 2 (MCS 0-11), o resto 3: 11 11 10 10
  'fa ff', //  Tx HE-MCS Map (<= 80 MHz)
);

// HE Capabilities 4x4 em 5 GHz com 160 MHz e PPE Thresholds. 6 + 11 + 8 + 4 = 29 bytes.
const HE_CAP_5_160_PPE = hx(
  '01 00 00 00 00 00', //  só +HTC-HE: sem TWT
  // byte 0 = 0x0C: bit 2 (40 e 80 MHz em 5 GHz) + bit 3 (160 MHz); byte 6 = 0x80: bit 55, PPE Thresholds Present
  '0c 00 00 00 00 00 80 00 00 00 00',
  'aa ff', 'aa ff', //  <= 80 MHz: 4 fluxos com MCS 0-11 (10 10 10 10 = 0xAA)
  'fa ff', 'fa ff', //  160 MHz: 2 fluxos
  // PPE Thresholds: bits 0-2 = 1 (NSS - 1) + bits 3-6 = 0011 (2 tamanhos de RU) = 0x19;
  // 7 + 6 * 2 * 2 = 31 bits -> 4 bytes
  '19 1c c7 71',
);

// EHT Capabilities de um AP 4x4 com 320 MHz. 2 + 9 + 9 = 20 bytes.
const EHT_CAP_320 = hx(
  '00 00', //  EHT MAC Capabilities
  // EHT PHY Capabilities (9 bytes): byte 0 = 0x62: bit 1 (320 MHz em 6 GHz) + bit 5 (SU beamformer) + bit 6 (SU beamformee);
  //   byte 7 = 0x10: bit 60, MU beamformer (<= 80 MHz)
  '62 00 00 00 00 00 00 10 00',
  '44 44 44', //  <= 80 MHz: MCS 0-9, 10-11 e 12-13; em cada byte Rx nos 4 bits baixos e Tx nos altos = 4 fluxos
  '44 44 44', //  160 MHz
  '22 22 22', //  320 MHz: 2 fluxos
);

// EHT Operation de um canal de 320 MHz (primário 37): centro da metade de 160 = 47, centro dos 320 = 31.
const EHT_OP_320 = hx(
  '01', //           EHT Operation Parameters: bit 0, EHT Operation Information Present
  '11 00 00 00', //  Basic EHT-MCS And NSS Set
  '04', //           Control: bits 0-2 = 4 (320 MHz)
  '2f', //           CCFS0 = 47
  '1f', //           CCFS1 = 31
);

// EHT Operation de 160 MHz com dois canais de 20 MHz "furados".
const EHT_OP_PUNCTURED = hx(
  '03', //  bit 0 + bit 1 (Disabled Subchannel Bitmap Present)
  '11 00 00 00',
  '03 27 2f', //  160 MHz, CCFS0 = 39, CCFS1 = 47
  '0c 00', //     bitmap 0x000C: 3º e 4º canais de 20 MHz desligados
);

// Multi-Link básico.
const MULTI_LINK_BASIC = hx(
  '30 01', //  Multi-Link Control = 0x0130: tipo 0 (Basic) + bit 4 (Link ID) + bit 5 (Change Count) + bit 8 (MLD Capabilities)
  '0b', //     Common Info Length = 11 (ele mesmo + 6 + 1 + 1 + 2)
  '02 aa bb cc dd ee', //  MLD MAC Address
  '02', //     Link ID Info: enlace 2
  '07', //     BSS Parameters Change Count
  '42 00', //  MLD Capabilities: bits 0-3 = 2 -> 3 enlaces simultâneos (o campo guarda o total menos 1)
);

// Reduced Neighbor Report com três blocos (o tamanho do TBTT Information muda o conteúdo).
const RNR = hx(
  // bloco 1: um vizinho em 6 GHz, TBTT Information de 13 bytes
  '00', //  TBTT Information Header: tipo 0, não filtrado, contagem 0 (= 1 campo)
  '0d', //  TBTT Information Length = 13
  '83', //  Operating Class 131 (6 GHz, 20 MHz)
  '25', //  canal 37
  'ff', //  Neighbor AP TBTT Offset = 255 (desconhecido)
  'aa bb cc dd ee 02', //  BSSID
  '26 39 f4 cb', //  Short SSID = 0xCBF43926 = CRC-32 de "123456789"
  '4a', //  BSS Parameters: mesmo SSID (0x02) + BSSID transmitido (0x08) + AP co-localizado (0x40)
  'fe', //  PSD de 20 MHz = -2 -> -1 dBm/MHz
  // bloco 2: dois vizinhos em 5 GHz com 16 bytes cada (inclui MLD Parameters)
  '10', //  contagem 1 nos bits 4-7 (= 2 campos)
  '10', //  tamanho 16
  '73', //  Operating Class 115
  '24', //  canal 36
  '00', '02 00 00 00 00 05', '78 56 34 12', '42', '7f', //  offset 0, BSSID, short SSID, mesmo SSID + co-localizado, PSD sem limite
  '00 21 00', //  MLD Parameters: MLD ID 0; Link ID = 1 (4 bits baixos do 2º byte)
  'ff', '02 00 00 00 00 06', '78 56 34 12', '00', '80', //  não co-localizado; PSD reservado
  'ff 0f 00', //  MLD ID 255 (não faz parte do MLD de quem anuncia), Link ID 15
  // bloco 3: só o deslocamento do TBTT (1 byte), em 2,4 GHz
  '00', '01', '51', '06', '0a', //  Operating Class 81, canal 6, offset 10
);

// Extended Capabilities de 10 bytes.
const EXT_CAPS = hx(
  '00 00',
  '08', //  byte 2, bit 3 = bit 19: BSS Transition (802.11v)
  '00 00 00 00',
  '40', //  byte 7, bit 6 = bit 62: Operating Mode Notification
  '40', //  byte 8, bit 6 = bit 70: FTM responder
  '40', //  byte 9, bit 6 = bit 78: TWT responder
);

const VENDOR_WMM = hx(
  '00 50 f2 02', //  OUI Microsoft + tipo 2 = WMM
  '01 01', //        subtipo 1 (Parameter Element), versão 1
  '83', //           QoS Info: bit 7 (U-APSD) + contador de parâmetros 3
  '00', //           reservado
  '03 a4 00 00', '27 a4 00 00', '42 43 5e 00', '62 32 2f 00', //  AC_BE, AC_BK, AC_VI, AC_VO
);

const VENDOR_OWE_TRANSITION = hx(
  '50 6f 9a 1c', //  OUI da Wi-Fi Alliance + tipo 0x1C = OWE Transition Mode
  '02 11 22 33 44 55', //  BSSID da rede par
  '08', //  tamanho do SSID
  '43 61 66 65 5f 4f 57 45', //  "Cafe_OWE"
);

// "RSNE Override": elemento de fabricante da WFA cujo corpo é um RSNE a partir do Version.
const VENDOR_RSN_OVERRIDE = hx(
  '50 6f 9a 29',
  '01 00', '00 0f ac 04', '01 00', '00 0f ac 09', //  cifra par a par: tipo 9 = GCMP-256
  '01 00', '00 0f ac 18', //  AKM: tipo 24 (0x18) = SAE-EXT-KEY
  'c0 00',
);

// Cisco CCX (elemento 133): 10 bytes, nome (16 bytes com zeros no fim), nº de clientes, 3 bytes.
const CISCO_CCX = hx(
  '00 00 8f 00 0f 00 ff 03 59 00',
  '41 50 2d 53 61 6c 61 2d 30 31 00 00 00 00 00 00', //  "AP-Sala-01"
  '0c', //  12 clientes
  '00 00 27',
);

// ---------------------------------------------------------------------------
// RSN / WPA
// ---------------------------------------------------------------------------

test('RSN de WPA2-PSK-CCMP escrito à mão', () => {
  const { rsn } = one(48, RSN_WPA2_PSK);
  assert.deepEqual(rsn, {
    version: 1,
    groupCipher: 'CCMP',
    pairwiseCiphers: ['CCMP'],
    akms: ['PSK'],
    capabilities: 0,
    pmfCapable: false,
    pmfRequired: false,
    groupMgmtCipher: null,
  });
});

test('RSN de WPA3-SAE com PMF obrigatório escrito à mão', () => {
  const { rsn } = one(48, RSN_WPA3_SAE);
  assert.deepEqual(rsn.akms, ['SAE']);
  assert.deepEqual(rsn.pairwiseCiphers, ['CCMP']);
  assert.equal(rsn.capabilities, 0x00c0);
  assert.equal(rsn.pmfRequired, true);
  assert.equal(rsn.pmfCapable, true);
  assert.equal(rsn.groupMgmtCipher, 'BIP-CMAC-128');
});

test('RSN de transição WPA2/WPA3 e RSN misto TKIP+CCMP', () => {
  const t = one(48, RSN_TRANSITION).rsn;
  assert.deepEqual(t.akms, ['PSK', 'SAE']);
  assert.equal(t.pmfCapable, true);
  assert.equal(t.pmfRequired, false);

  const m = one(48, RSN_TKIP_CCMP).rsn;
  assert.equal(m.groupCipher, 'TKIP');
  assert.deepEqual(m.pairwiseCiphers, ['CCMP', 'TKIP']);
  assert.equal(m.pmfCapable, false);
});

test('todos os seletores de AKM e de cifra pedidos', () => {
  const akms = {
    1: 'EAP', 2: 'PSK', 3: 'FT-EAP', 4: 'FT-PSK', 5: 'EAP-SHA256', 6: 'PSK-SHA256', 8: 'SAE', 9: 'FT-SAE',
    11: 'SUITE-B', 12: 'SUITE-B-192', 18: 'OWE', 24: 'SAE-EXT-KEY', 25: 'FT-SAE-EXT-KEY',
  };
  for (const [type, name] of Object.entries(akms)) {
    const t = Number(type).toString(16).padStart(2, '0');
    const { rsn } = one(48, `0100 000fac04 0100 000fac04 0100 000fac${t} 0000`);
    assert.deepEqual(rsn.akms, [name], `AKM ${type}`);
  }
  const ciphers = { 1: 'WEP-40', 2: 'TKIP', 4: 'CCMP', 5: 'WEP-104', 6: 'BIP-CMAC-128', 8: 'GCMP-128', 9: 'GCMP-256', 10: 'CCMP-256' };
  for (const [type, name] of Object.entries(ciphers)) {
    const t = Number(type).toString(16).padStart(2, '0');
    const { rsn } = one(48, `0100 000fac${t} 0100 000fac${t} 0100 000fac02 0000`);
    assert.equal(rsn.groupCipher, name, `cifra ${type}`);
    assert.deepEqual(rsn.pairwiseCiphers, [name]);
  }
  // DPP usa o OUI da Wi-Fi Alliance; suíte desconhecida não some, vira UNKNOWN-...
  assert.deepEqual(one(48, '0100 000fac04 0100 000fac04 0100 506f9a02 0000').rsn.akms, ['DPP']);
  assert.deepEqual(one(48, '0100 000fac04 0100 000fac04 0100 000fac63 0000').rsn.akms, ['UNKNOWN-000FAC-99']);
});

test('RSN: campos opcionais ausentes são aceitos; contagem maior que o corpo descarta o elemento', () => {
  // acaba depois da cifra de grupo
  const short = one(48, '0100 000fac04').rsn;
  assert.equal(short.groupCipher, 'CCMP');
  assert.deepEqual(short.akms, []);
  assert.equal(short.capabilities, null);
  // só a versão
  assert.equal(one(48, '0100').rsn.groupCipher, null);
  // diz que há 2 cifras par a par, mas só vem uma
  assert.equal(one(48, '0100 000fac04 0200 000fac04').rsn, undefined);
  // versão diferente de 1 não é interpretada
  assert.equal(one(48, RSN_WPA2_PSK.replace(/^0100/, '0200')).rsn, undefined);
  assert.equal(one(48, '').rsn, undefined);
});

test('elemento WPA1 da Microsoft e RSNE Override', () => {
  const info = parseIes([ie(221, VENDOR_WPA1_TKIP), ie(221, VENDOR_RSN_OVERRIDE)]);
  assert.equal(info.wpa.groupCipher, 'TKIP');
  assert.deepEqual(info.wpa.pairwiseCiphers, ['TKIP']);
  assert.deepEqual(info.wpa.akms, ['PSK']);
  assert.equal(info.wpa.capabilities, null);
  assert.deepEqual(info.rsnOverride.akms, ['SAE-EXT-KEY']);
  assert.deepEqual(info.rsnOverride.pairwiseCiphers, ['GCMP-256']);
  assert.equal(info.rsnOverride.pmfRequired, true);
});

// ---------------------------------------------------------------------------
// carga, país, taxas e afins
// ---------------------------------------------------------------------------

test('BSS Load escrito à mão', () => {
  const { bssLoad } = one(11, BSS_LOAD);
  assert.equal(bssLoad.stations, 7);
  assert.equal(bssLoad.utilization, 128 / 255);
  assert.equal(bssLoad.admissionCapacity, 0x1234);
  assert.equal(one(11, '07008034').bssLoad, undefined); // faltou um byte
});

test('Country "BR" escrito à mão', () => {
  const { country } = one(7, COUNTRY_BR);
  assert.deepEqual(country, {
    code: 'BR',
    environment: 'any',
    triplets: [{ first: 1, count: 13, maxTxDbm: 20 }],
    operating: [],
  });
});

test('Country de 5 GHz com preenchimento, ambiente interno e trinca de classe operacional', () => {
  const { country } = one(7, COUNTRY_BR_5G);
  assert.equal(country.code, 'BR');
  assert.equal(country.environment, 'indoor');
  assert.deepEqual(country.triplets, [
    { first: 36, count: 4, maxTxDbm: 23 },
    { first: 52, count: 4, maxTxDbm: 23 },
    { first: 100, count: 12, maxTxDbm: 24 },
    { first: 149, count: 5, maxTxDbm: 30 },
  ]);
  // 0x04 = classes operacionais globais; primeira trinca com 201 = extensão; potência é com sinal (0xFE = -2)
  const global = one(7, '555304 c98300 0104fe').country;
  assert.equal(global.code, 'US');
  assert.equal(global.environment, 'global');
  assert.deepEqual(global.operating, [{ extId: 201, opClass: 131, coverageClass: 0 }]);
  assert.deepEqual(global.triplets, [{ first: 1, count: 4, maxTxDbm: -2 }]);
  assert.equal(one(7, '00ff20010d14').country, undefined); // código que não é texto
  assert.equal(one(7, '4252').country, undefined);
});

test('Supported Rates + Extended Supported Rates', () => {
  // 0x82 = básica (bit 7) de 2 x 0,5 = 1 Mbps; 0x84 = 2; 0x8B = 5,5; 0x96 = 11; 0x0C = 6; 0x12 = 9; 0x18 = 12; 0x24 = 18
  // estendidas: 0x30 = 24; 0x48 = 36; 0x60 = 48; 0x6C = 54
  const { rates } = parseIes([ie(1, '82 84 8b 96 0c 12 18 24'), ie(50, '30 48 60 6c')]);
  assert.deepEqual(rates.rates, [1, 2, 5.5, 6, 9, 11, 12, 18, 24, 36, 48, 54]);
  assert.deepEqual(rates.basicRates, [1, 2, 5.5, 11]);
  assert.equal(rates.legacy11b, true);
  assert.equal(rates.supports11b, true);
  assert.equal(rates.minBasicRate, 1);
});

test('taxas: 11b desligado, só 11b e seletores de associação', () => {
  // OFDM com 6, 12 e 24 básicas; as taxas 11b nem aparecem
  const ofdm = one(1, '8c 12 98 24 b0 48 60 6c').rates;
  assert.deepEqual(ofdm.basicRates, [6, 12, 24]);
  assert.equal(ofdm.legacy11b, false);
  assert.equal(ofdm.supports11b, false);

  // 11b ainda suportado (sem bit de básica), mas as básicas são OFDM: não conta como legado
  const mixed = one(1, '02 04 0b 16 8c 12 98 24').rates;
  assert.equal(mixed.supports11b, true);
  assert.equal(mixed.legacy11b, false);

  // só as quatro taxas 11b, nenhuma marcada como básica
  assert.equal(one(1, '02 04 0b 16').rates.legacy11b, true);

  // 0xFF = seletor 127 (HT), 0xFE = 126 (VHT), 0xFB = 123 (só SAE H2E), 0xFA = 122 (HE): não são taxas
  const sel = parseIes([ie(1, '8c 98 b0'), ie(50, 'ff fe fb fa')]).rates;
  assert.deepEqual(sel.rates, [6, 12, 24]);
  assert.deepEqual(sel.selectors, ['HT', 'VHT', 'SAE-H2E', 'HE']);
});

test('DS, Power Constraint, TPC Report e ERP', () => {
  const info = parseIes([ie(3, '0b'), ie(32, '03'), ie(35, '14 00'), ie(42, '07')]);
  assert.deepEqual(info.ds, { channel: 11 });
  assert.deepEqual(info.powerConstraint, { db: 3 });
  assert.deepEqual(info.tpcReport, { txPowerDbm: 20, linkMargin: 0 });
  assert.deepEqual(info.erp, { nonErpPresent: true, useProtection: true, barkerPreamble: true });
  // potência com sinal: 0xFE = -2 dBm
  assert.equal(one(35, 'fe 05').tpcReport.txPowerDbm, -2);
  assert.deepEqual(one(42, '02').erp, { nonErpPresent: false, useProtection: true, barkerPreamble: false });
});

// ---------------------------------------------------------------------------
// HT / VHT
// ---------------------------------------------------------------------------

test('HT Capabilities com 2 fluxos escrito à mão', () => {
  assert.equal(HT_CAP_2SS.length, 52); // 26 bytes
  const { ht } = one(45, HT_CAP_2SS);
  assert.deepEqual(ht, {
    ldpc: true,
    width40: true,
    greenfield: false,
    sgi20: true,
    sgi40: true,
    txStbc: true,
    rxStbc: 1,
    maxAmsdu: 7935,
    fortyIntolerant: false,
    nss: 2,
    maxMcs: 7,
  });
});

test('HT Capabilities 3x3 de 20 MHz; corpo truncado é ignorado', () => {
  const { ht } = one(45, HT_CAP_3SS_20);
  assert.equal(ht.nss, 3);
  assert.equal(ht.width40, false);
  assert.equal(ht.ldpc, false);
  assert.equal(ht.sgi20, true);
  assert.equal(ht.sgi40, false);
  assert.equal(ht.txStbc, false);
  assert.equal(ht.maxAmsdu, 3839);
  assert.equal(ht.maxMcs, 7);
  assert.equal(one(45, HT_CAP_2SS.slice(0, 50)).ht, undefined);
});

// Regressão: o maior MCS saía do último fluxo anunciado. Com modulação desigual (o 2º fluxo
// só até o MCS 12, por exemplo) o resultado ficava menor que o que o 1º fluxo alcança.
test('HT Capabilities: o maior MCS é o do fluxo que vai mais longe', () => {
  const withMask = (mask) => hx('2c 01', '17', mask, '00 00', '01', '00 00 00', '00 00', '00 00 00 00', '00');
  // fluxo 1: MCS 0-7 (0xff); fluxo 2: MCS 8-12 (0x1f)
  const uneven = one(45, withMask('ff 1f 00 00 00 00 00 00 00 00')).ht;
  assert.equal(uneven.nss, 2);
  assert.equal(uneven.maxMcs, 7);
  // um fluxo só até 16-QAM 3/4 (MCS 0-4)
  const modest = one(45, withMask('1f 00 00 00 00 00 00 00 00 00')).ht;
  assert.equal(modest.nss, 1);
  assert.equal(modest.maxMcs, 4);
  // máscara vazia: nenhum fluxo, MCS desconhecido
  const none = one(45, withMask('00 00 00 00 00 00 00 00 00 00')).ht;
  assert.equal(none.nss, 0);
  assert.equal(none.maxMcs, null);
});

test('HT Operation', () => {
  assert.equal(HT_OP_36_ABOVE.length, 44); // 22 bytes
  assert.deepEqual(one(61, HT_OP_36_ABOVE).htOperation, {
    primaryChannel: 36,
    secondaryOffset: 'above',
    staWidth: 40,
    protection: 'mixed',
    nonGreenfieldPresent: true,
    obssNonHtPresent: true,
    centerSeg2: 0,
  });
  // canal 11, secundário abaixo (bits 0-1 = 3) + qualquer largura (bit 2) = 0x07
  const below = one(61, `0b 07 0000 0000 ${'00'.repeat(16)}`).htOperation;
  assert.equal(below.primaryChannel, 11);
  assert.equal(below.secondaryOffset, 'below');
  assert.equal(below.protection, 'none');
  // só 20 MHz
  const narrow = one(61, `01 00 0000 0000 ${'00'.repeat(16)}`).htOperation;
  assert.equal(narrow.secondaryOffset, null);
  assert.equal(narrow.staWidth, 20);
});

test('VHT Capabilities com 3 fluxos escrito à mão', () => {
  const { vht } = one(191, VHT_CAP_3SS);
  assert.deepEqual(vht, {
    maxMpdu: 11454,
    width160: false,
    width80p80: false,
    rxLdpc: true,
    sgi80: true,
    sgi160: false,
    suBeamformer: true,
    suBeamformee: true,
    muBeamformer: true,
    muBeamformee: false,
    extNssBw: 0,
    nss: 3,
    maxMcs: 9,
  });
});

test('VHT Capabilities 4x4 com 160 MHz', () => {
  const { vht } = one(191, VHT_CAP_4SS_160);
  assert.equal(vht.nss, 4);
  assert.equal(vht.maxMcs, 9);
  assert.equal(vht.width160, true);
  assert.equal(vht.width80p80, false);
  assert.equal(vht.sgi160, true);
  assert.equal(vht.suBeamformer, false);
  assert.equal(vht.suBeamformee, true);
  assert.equal(vht.muBeamformer, false);
  assert.equal(vht.muBeamformee, true);
  // bits 2-3 = 2: 160 e 80+80
  assert.equal(one(191, '08000000 feff 0000 feff 0000').vht.width80p80, true);
  assert.equal(one(191, VHT_CAP_3SS.slice(0, 22)).vht, undefined);
});

test('VHT Operation: 80, 160, 80+80 e a forma antiga', () => {
  // largura 1, centro 42, sem segundo centro -> 80 MHz
  assert.deepEqual(one(192, '01 2a 00 fc ff').vhtOperation, { width: 1, centerSeg0: 42, centerSeg1: 0, widthMhz: 80, plus80: false });
  // segundo centro a 8 canais do primeiro -> 160 MHz contínuos (centro 50)
  const w160 = one(192, '01 2a 32 fc ff').vhtOperation;
  assert.equal(w160.widthMhz, 160);
  assert.equal(w160.plus80, false);
  // segundo centro longe -> 80+80
  const plus = one(192, '01 2a 9b fc ff').vhtOperation;
  assert.equal(plus.widthMhz, 80);
  assert.equal(plus.plus80, true);
  // 0 = segue o HT Operation (20/40); 2 = 160 na forma antiga
  assert.equal(one(192, '00 00 00 fc ff').vhtOperation.widthMhz, null);
  assert.equal(one(192, '02 32 00 fc ff').vhtOperation.widthMhz, 160);
});

// ---------------------------------------------------------------------------
// roaming e capacidades estendidas
// ---------------------------------------------------------------------------

test('Mobility Domain, RM e Extended Capabilities', () => {
  // MDID 0x1234 (little-endian) + bit 0 (FT over DS)
  const info = parseIes([ie(54, '34 12 01'), ie(70, '73 00 00 00 00'), ie(127, EXT_CAPS)]);
  assert.deepEqual(info.mobilityDomain, { mdid: 0x1234, ftOverDs: true, resourceRequest: false });
  // 0x73 = link measurement (bit 0) + neighbor report (bit 1) + beacon passivo/ativo/tabela (bits 4, 5, 6)
  assert.deepEqual(info.rm, { linkMeasurement: true, neighborReport: true, beaconPassive: true, beaconActive: true, beaconTable: true });
  assert.equal(info.extCaps.bssTransition, true);
  assert.equal(info.extCaps.opModeNotification, true);
  assert.equal(info.extCaps.ftmResponder, true);
  assert.equal(info.extCaps.twtResponder, true);
  assert.equal(info.extCaps.ftmInitiator, false);
  assert.equal(info.extCaps.twtRequester, false);
  assert.equal(info.extCaps.interworking, false);

  const s = summarizeIes(info);
  assert.deepEqual(s.roaming, { k: true, v: true, r: true });
  assert.equal(s.ftmResponder, true);
  assert.equal(s.twt, true);

  // elemento curto: os bits que não vieram valem zero
  const short = one(127, '00 00 08').extCaps;
  assert.equal(short.bssTransition, true);
  assert.equal(short.ftmResponder, false);
  assert.equal(short.twtResponder, false);
});

test('Interworking e Multiple BSSID', () => {
  // 0x13: tipo de rede 3 (pública gratuita) + bit 4 (internet)
  assert.deepEqual(one(107, '13').interworking, { accessNetworkType: 3, internet: true, asra: false, esr: false, uesa: false, hessid: null });
  // com HESSID (corpo de 7 bytes)
  assert.equal(one(107, '02 00 11 22 33 44 55').interworking.hessid, '00:11:22:33:44:55');
  assert.deepEqual(one(71, '03').multipleBssid, { maxIndicator: 3 });
});

test('Transmit Power Envelope', () => {
  // info 0x02: contagem 2 (3 valores: 20, 40 e 80 MHz), EIRP local; 0x28 = 40 -> 20 dBm
  // info 0x19: contagem 1, interpretação 3 (PSD do cliente regulatório); 0xFE = -2 -> -1 dBm/MHz
  // info 0x0B: contagem 3 (4 valores), interpretação 1 (PSD local); 0x0A = 5 dBm/MHz
  const { txPowerEnvelopes } = parseIes([ie(195, '02 28 28 28'), ie(195, '19 fe'), ie(195, '0b 0a 0a 0a 0a'), ie(195, '00 7f')]);
  assert.deepEqual(txPowerEnvelopes, [
    { interpretation: 'local-eirp', category: 0, psd: false, maxTxDbm: [20, 20, 20] },
    { interpretation: 'reg-client-psd', category: 0, psd: true, maxTxDbm: [-1] },
    { interpretation: 'local-psd', category: 0, psd: true, maxTxDbm: [5, 5, 5, 5] },
    { interpretation: 'local-eirp', category: 0, psd: false, maxTxDbm: [null] }, // 127 = sem limite
  ]);
  assert.equal(one(195, '02').txPowerEnvelopes, undefined);
});

// ---------------------------------------------------------------------------
// Reduced Neighbor Report
// ---------------------------------------------------------------------------

test('Reduced Neighbor Report escrito à mão (TBTT de 13, 16 e 1 bytes)', () => {
  const { rnr } = one(201, RNR);
  assert.equal(rnr.neighbors.length, 4);
  const [six, mld, other, bare] = rnr.neighbors;

  assert.deepEqual(six, {
    opClass: 131,
    channel: 37,
    band: '6',
    bssid: 'aa:bb:cc:dd:ee:02',
    shortSsid: 0xcbf43926,
    colocated: true,
    sameSsid: true,
    tbttOffset: null,
    psdDbmPerMhz: -1,
    mldId: null,
    linkId: null,
  });
  assert.equal(six.shortSsid, shortSsid('123456789'));

  assert.equal(mld.band, '5');
  assert.equal(mld.channel, 36);
  assert.equal(mld.bssid, '02:00:00:00:00:05');
  assert.equal(mld.shortSsid, 0x12345678);
  assert.equal(mld.colocated, true);
  assert.equal(mld.tbttOffset, 0);
  assert.equal(mld.psdDbmPerMhz, null);
  assert.equal(mld.mldId, 0);
  assert.equal(mld.linkId, 1);

  assert.equal(other.bssid, '02:00:00:00:00:06');
  assert.equal(other.colocated, false);
  assert.equal(other.sameSsid, false);
  assert.equal(other.mldId, 255);
  assert.equal(other.linkId, 15);

  assert.deepEqual(bare, {
    opClass: 81,
    channel: 6,
    band: '2.4',
    bssid: null,
    shortSsid: null,
    colocated: null,
    sameSsid: null,
    tbttOffset: 10,
    psdDbmPerMhz: null,
    mldId: null,
    linkId: null,
  });

  // no resumo entram o co-localizado e o outro enlace do mesmo MLD
  assert.deepEqual(summarizeIes(one(201, RNR)).colocated, [
    { band: '6', channel: 37, bssid: 'aa:bb:cc:dd:ee:02' },
    { band: '5', channel: 36, bssid: '02:00:00:00:00:05' },
  ]);
});

test('RNR: demais tamanhos de TBTT Information e blocos truncados', () => {
  const bssid = 'aa bb cc dd ee 0f';
  // 2: offset + parâmetros            5: offset + short SSID          6: + parâmetros
  // 7: offset + BSSID                 8: + parâmetros                 9: + PSD
  // 11: offset + BSSID + short SSID   12: + parâmetros
  const cases = [
    { len: 2, body: '05 40', want: { bssid: null, shortSsid: null, colocated: true } },
    { len: 5, body: '05 78 56 34 12', want: { bssid: null, shortSsid: 0x12345678, colocated: null } },
    { len: 6, body: '05 78 56 34 12 02', want: { bssid: null, shortSsid: 0x12345678, colocated: false, sameSsid: true } },
    { len: 7, body: `05 ${bssid}`, want: { bssid: 'aa:bb:cc:dd:ee:0f', shortSsid: null, colocated: null } },
    { len: 8, body: `05 ${bssid} 40`, want: { bssid: 'aa:bb:cc:dd:ee:0f', colocated: true, psdDbmPerMhz: null } },
    { len: 9, body: `05 ${bssid} 40 0a`, want: { bssid: 'aa:bb:cc:dd:ee:0f', colocated: true, psdDbmPerMhz: 5 } },
    { len: 11, body: `05 ${bssid} 78 56 34 12`, want: { bssid: 'aa:bb:cc:dd:ee:0f', shortSsid: 0x12345678, colocated: null } },
    { len: 12, body: `05 ${bssid} 78 56 34 12 42`, want: { shortSsid: 0x12345678, colocated: true, sameSsid: true, psdDbmPerMhz: null } },
  ];
  for (const c of cases) {
    const head = `00 ${c.len.toString(16).padStart(2, '0')} 73 24`;
    const { rnr } = one(201, `${head} ${c.body}`);
    assert.equal(rnr.neighbors.length, 1, `tamanho ${c.len}`);
    for (const [k, v] of Object.entries(c.want)) assert.equal(rnr.neighbors[0][k], v, `tamanho ${c.len}: ${k}`);
    assert.equal(rnr.neighbors[0].tbttOffset, 5);
    // sem o último byte o campo não cabe: nenhum vizinho
    assert.equal(one(201, hx(`${head} ${c.body}`).slice(0, -2)).rnr, undefined, `tamanho ${c.len} truncado`);
  }
  // cabeçalho promete 3 campos de 8 bytes e só vem 1: fica o que veio inteiro
  const partial = one(201, `20 08 73 24 05 ${bssid} 40 05 aa bb`);
  assert.equal(partial.rnr.neighbors.length, 1);
  // tamanho 0 é inválido
  assert.equal(one(201, '00 00 73 24').rnr, undefined);
});

// Classes operacionais globais (IEEE 802.11, Tabela E-4; conferidas com o global_op_class[] do
// hostapd): 81-84 = 2,4 GHz; 115-130 = 5 GHz; 131-137 = 6 GHz; 180-183 = 60 GHz.
test('RNR: faixa pela classe operacional global', () => {
  const bandOf = (opClass) => one(201, `00 01 ${opClass.toString(16).padStart(2, '0')} 01 05`).rnr.neighbors[0].band;
  for (const c of [81, 82, 83, 84]) assert.equal(bandOf(c), '2.4', String(c));
  for (let c = 115; c <= 130; c++) assert.equal(bandOf(c), '5', String(c));
  for (let c = 131; c <= 137; c++) assert.equal(bandOf(c), '6', String(c));
  // 180 = canais de 2,16 GHz; 181 a 183 = canais juntados do 802.11ay (regressão: davam null)
  for (const c of [180, 181, 182, 183]) assert.equal(bandOf(c), '60', String(c));
  for (const c of [0, 80, 85, 114, 138, 179, 184, 255]) assert.equal(bandOf(c), null, String(c));
});

test('shortSsid é o CRC-32 padrão', () => {
  assert.equal(shortSsid('123456789'), 0xcbf43926); // valor de conferência clássico do CRC-32
  assert.equal(shortSsid(''), 0);
  assert.equal(shortSsid('a'), 0xe8b7be43);
});

// ---------------------------------------------------------------------------
// HE / EHT / Multi-Link
// ---------------------------------------------------------------------------

test('HE Operation com cor do BSS escrito à mão', () => {
  assert.deepEqual(one(255, HE_OP_COLOR_37, 36).heOperation, {
    bssColor: 37,
    partialBssColor: false,
    bssColorDisabled: false,
    defaultPeDuration: 4,
    twtRequired: false,
    txopRtsThreshold: 1023,
    erSuDisable: false,
  });
  assert.equal(summarizeIes(one(255, HE_OP_COLOR_37, 36)).bssColor, 37);
  assert.equal(summarizeIes(one(255, HE_OP_COLOR_37, 36)).gen, 6);
});

test('HE Operation com informação de 6 GHz, VHT e Co-Hosted', () => {
  const six = one(255, HE_OP_6GHZ, 36).heOperation;
  assert.equal(six.bssColor, 5);
  assert.deepEqual(six.sixGhz, {
    primaryChannel: 37,
    width: 80,
    centerSeg0: 39,
    centerSeg1: 0,
    duplicateBeacon: false,
    regInfo: 1,
    minRate: 6,
  });

  const vht = one(255, HE_OP_VHT_COHOSTED, 36).heOperation;
  assert.equal(vht.bssColor, 12);
  assert.equal(vht.bssColorDisabled, true);
  assert.deepEqual(vht.vhtOperation, { width: 1, centerSeg0: 42, centerSeg1: 0 });
  assert.equal(vht.sixGhz, undefined);
  assert.equal(summarizeIes(one(255, HE_OP_VHT_COHOSTED, 36)).bssColor, null); // cor desligada

  // promete 6 GHz mas o corpo acaba antes: a cor continua valendo
  const cut = one(255, HE_OP_6GHZ.slice(0, 16), 36).heOperation;
  assert.equal(cut.bssColor, 5);
  assert.equal(cut.sixGhz, undefined);
  assert.equal(one(255, 'f43f0025fc', 36).heOperation, undefined);
});

// Regressão: o Regulatory Info era lido com 3 bits (B3-B5). O campo tem 4 (B3-B6, máscara 0x78
// em include/linux/ieee80211-he.h e no Wireshark): o valor 8, "AP interno de potência padrão",
// virava 0 ("interno de baixa potência").
test('HE Operation em 6 GHz: Regulatory Info tem 4 bits', () => {
  const body = (control) =>
    hx(
      'f4 3f 02', '05', 'fc ff', //  parâmetros com o bit 17 (6 GHz), cor 5, MCS básico
      '25', //                        Primary Channel = 37
      control, //                     Control
      '27 00 06', //                  centro 39, segundo centro 0, taxa mínima 6
    );
  // 0x42 = 80 MHz (2) + Regulatory Info 8 (8 << 3 = 0x40)
  assert.equal(one(255, body('42'), 36).heOperation.sixGhz.regInfo, 8);
  assert.equal(one(255, body('42'), 36).heOperation.sixGhz.width, 80);
  // 0x3a = 80 MHz + Regulatory Info 7 ("papel do AP não se aplica")
  assert.equal(one(255, body('3a'), 36).heOperation.sixGhz.regInfo, 7);
  // 0x16 = 80 MHz + Duplicate Beacon (0x04) + Regulatory Info 2 (potência muito baixa)
  assert.deepEqual(one(255, body('16'), 36).heOperation.sixGhz, {
    primaryChannel: 37,
    width: 80,
    centerSeg0: 39,
    centerSeg1: 0,
    duplicateBeacon: true,
    regInfo: 2,
    minRate: 6,
  });
  // o bit 7 é reservado e não entra
  assert.equal(one(255, body('c2'), 36).heOperation.sixGhz.regInfo, 8);
});

test('HE Capabilities escrito à mão (2,4 GHz, 2 fluxos)', () => {
  assert.equal(HE_CAP_24.length, 42); // 21 bytes
  assert.deepEqual(one(255, HE_CAP_24, 35).he, {
    twtRequester: false,
    twtResponder: true,
    broadcastTwt: true,
    width40: true,
    width80: false,
    width160: false,
    width80p80: false,
    ldpc: true,
    ulMuMimo: true,
    suBeamformer: true,
    suBeamformee: true,
    muBeamformer: true,
    nss: 2,
    maxMcs: 11,
    nss160: null,
  });
});

test('HE Capabilities 4x4 com 160 MHz e PPE Thresholds', () => {
  assert.equal(HE_CAP_5_160_PPE.length, 58); // 29 bytes
  const { he } = one(255, HE_CAP_5_160_PPE, 35);
  assert.equal(he.nss, 4);
  assert.equal(he.maxMcs, 11);
  assert.equal(he.nss160, 2);
  assert.equal(he.width40, true);
  assert.equal(he.width80, true);
  assert.equal(he.width160, true);
  assert.equal(he.twtResponder, false);
  assert.equal(he.suBeamformer, false);
  // mapa com MCS 0-9 (código 1) e MCS 0-7 (código 0): 0xFFF4 = fluxo 1 código 0, fluxo 2 código 1
  const mixed = one(255, `${'00'.repeat(17)} f4ff f4ff`, 35).he;
  assert.equal(mixed.nss, 2);
  assert.equal(mixed.maxMcs, 9);
  assert.equal(one(255, HE_CAP_24.slice(0, 40), 35).he, undefined);
});

test('extensão: o byte de extensão esquecido dentro do corpo é detectado', () => {
  const want = one(255, HE_OP_COLOR_37, 36).heOperation;
  // sem `ext` (0 ou ausente): o primeiro byte do corpo é o número da extensão
  assert.deepEqual(parseIes([{ id: 255, ext: 0, hex: `24${HE_OP_COLOR_37}` }]).heOperation, want);
  assert.deepEqual(parseIes([{ id: 255, hex: `24${HE_OP_COLOR_37}` }]).heOperation, want);
  // com `ext` certo E o byte repetido no corpo: o tamanho esperado denuncia a sobra
  assert.deepEqual(parseIes([{ id: 255, ext: 36, hex: `24${HE_OP_COLOR_37}` }]).heOperation, want);
  assert.deepEqual(parseIes([{ id: 255, ext: 36, hex: `24${HE_OP_6GHZ}` }]).heOperation.sixGhz.primaryChannel, 37);
  assert.deepEqual(parseIes([{ id: 255, ext: 35, hex: `23${HE_CAP_24}` }]).he, one(255, HE_CAP_24, 35).he);
  assert.deepEqual(parseIes([{ id: 255, ext: 35, hex: `23${HE_CAP_5_160_PPE}` }]).he, one(255, HE_CAP_5_160_PPE, 35).he);
  assert.deepEqual(parseIes([{ id: 255, ext: 106, hex: `6a${EHT_OP_320}` }]).ehtOperation, one(255, EHT_OP_320, 106).ehtOperation);
  assert.equal(parseIes([{ id: 255, ext: 0, hex: '' }]).count, 1);

  // um corpo legítimo que por acaso começa com o mesmo valor da extensão NÃO pode ser cortado:
  // HE Operation com PE padrão 4 e limiar de RTS 2 (0x24 0x00 0x00) e cor 9
  const tricky = one(255, '24 00 00 09 fc ff', 36).heOperation;
  assert.equal(tricky.bssColor, 9);
  assert.equal(tricky.defaultPeDuration, 4);
  assert.equal(tricky.txopRtsThreshold, 2);
});

test('EHT Capabilities e EHT Operation', () => {
  assert.equal(EHT_CAP_320.length, 40); // 20 bytes
  assert.deepEqual(one(255, EHT_CAP_320, 108).eht, {
    present: true,
    width320: true,
    suBeamformer: true,
    suBeamformee: true,
    muBeamformer: true,
    nss: 4,
    maxMcs: 13,
  });
  // 2 fluxos até o MCS 11 (o byte do MCS 12-13 vem zerado), sem 320 MHz
  const lower = one(255, `0000 ${'00'.repeat(9)} 22 22 00`, 108).eht;
  assert.equal(lower.width320, false);
  assert.equal(lower.nss, 2);
  assert.equal(lower.maxMcs, 11);
  // sem o mapa de MCS: presente, mas sem número de fluxos
  const bare = one(255, `0000 ${'00'.repeat(9)}`, 108).eht;
  assert.equal(bare.present, true);
  assert.equal(bare.nss, null);
  assert.equal(one(255, '0000 00000000', 108).eht, undefined);

  assert.deepEqual(one(255, EHT_OP_320, 106).ehtOperation, {
    present: true,
    width: 320,
    centerSeg0: 47,
    centerSeg1: 31,
    disabledSubchannels: null,
  });
  assert.deepEqual(one(255, EHT_OP_PUNCTURED, 106).ehtOperation, {
    present: true,
    width: 160,
    centerSeg0: 39,
    centerSeg1: 47,
    disabledSubchannels: 0x000c,
  });
  // sem EHT Operation Information
  assert.deepEqual(one(255, '00 11000000', 106).ehtOperation, {
    present: true,
    width: null,
    centerSeg0: null,
    centerSeg1: null,
    disabledSubchannels: null,
  });
  assert.equal(summarizeIes(one(255, '00 11000000', 106)).gen, 7);
});

test('Multi-Link básico escrito à mão', () => {
  assert.deepEqual(one(255, MULTI_LINK_BASIC, 107).multiLink, {
    present: true,
    type: 'basic',
    mldMac: '02:aa:bb:cc:dd:ee',
    linkId: 2,
    maxSimultaneousLinks: 3,
  });
  // só o controle + MAC, sem campos opcionais
  const min = one(255, '00 00 07 02 aa bb cc dd ee', 107).multiLink;
  assert.equal(min.mldMac, '02:aa:bb:cc:dd:ee');
  assert.equal(min.linkId, null);
  assert.equal(min.maxSimultaneousLinks, null);
  // tipo 1 (Probe Request): presente, sem MAC
  const probe = one(255, '01 00 01', 107).multiLink;
  assert.equal(probe.type, 'probe-request');
  assert.equal(probe.mldMac, null);

  const s = summarizeIes(one(255, MULTI_LINK_BASIC, 107));
  assert.equal(s.mlo, true);
  assert.equal(s.mldMac, '02:aa:bb:cc:dd:ee');
});

// ---------------------------------------------------------------------------
// elementos de fabricante
// ---------------------------------------------------------------------------

test('WPS com nome do aparelho escrito à mão', () => {
  const info = one(221, VENDOR_WPS);
  assert.deepEqual(info.wps, {
    version: '2.0',
    state: 2,
    configured: true,
    locked: true,
    selectedRegistrar: false,
    deviceName: 'Escritório',
    manufacturer: 'TP-LINK',
    modelName: 'Archer C6',
    modelNumber: '1.0',
    configMethods: 0x2688,
    pushButton: true,
    pin: true,
  });
  assert.deepEqual(summarizeIes(info).wps, {
    enabled: true,
    configured: true,
    locked: true,
    deviceName: 'Escritório',
    manufacturer: 'TP-LINK',
    model: 'Archer C6 1.0',
  });
});

test('WPS mínimo de beacon, não configurado; TLV truncado não derruba', () => {
  // só versão e estado 1 (não configurado), mais o registrador selecionado
  const { wps } = one(221, '0050f204 104a000110 1044000101 1041000101');
  assert.equal(wps.version, '1.0');
  assert.equal(wps.state, 1);
  assert.equal(wps.configured, false);
  assert.equal(wps.locked, false);
  assert.equal(wps.selectedRegistrar, true);
  assert.equal(wps.deviceName, null);
  // o último TLV diz ter 32 bytes e só vêm 3: os anteriores continuam valendo
  const cut = one(221, '0050f204 1044000102 10110020 414243').wps;
  assert.equal(cut.configured, true);
  assert.equal(cut.deviceName, null);
  // sem nenhum TLV inteiro não há WPS
  assert.equal(one(221, '0050f204').wps, undefined);
  assert.equal(one(221, '0050f204 1044').wps, undefined);
  assert.equal(summarizeIes(one(1, '8c')).wps, null);
});

test('WMM, P2P, Hotspot 2.0, MBO, Multi-AP e OWE Transition', () => {
  const info = parseIes([
    ie(221, VENDOR_WMM),
    ie(221, '50 6f 9a 09 02 02 00 25 00'), //  tipo 0x09 = P2P
    ie(221, '50 6f 9a 10 21'), //  tipo 0x10 = HS 2.0; 0x21: release 3 (bits 4-7 = 2) + DGAF desligado (bit 0)
    ie(221, '50 6f 9a 16 01 01 40 04 01 01'), //  tipo 0x16 = MBO; atributo 1 (capacidade) e atributo 4 (associação recusada)
    ie(221, '50 6f 9a 1b 06 01 20'), //  tipo 0x1B = Multi-AP
    ie(221, VENDOR_OWE_TRANSITION),
  ]);
  assert.deepEqual(info.wmm, { uapsd: true, parameterSetCount: 3 });
  assert.equal(info.p2p, true);
  assert.deepEqual(info.hs20, { release: 3, dgafDisabled: true });
  assert.deepEqual(info.mbo, { assocDisallowed: true });
  assert.equal(info.multiAp, true);
  assert.deepEqual(info.oweTransition, { bssid: '02:11:22:33:44:55', ssid: 'Cafe_OWE' });
  assert.deepEqual(info.vendorOuis, ['00:50:f2', '50:6f:9a']);
  assert.equal(info.chipsetHint, undefined);

  const s = summarizeIes(info);
  assert.equal(s.wmm, true);
  assert.equal(s.p2p, true);
  assert.equal(s.passpoint, true);
  assert.equal(s.mesh, true);

  assert.deepEqual(one(221, '50 6f 9a 16 01 01 40').mbo, { assocDisallowed: false });
  // WMM Information Element (subtipo 0) sem U-APSD
  assert.deepEqual(one(221, '00 50 f2 02 00 01 02').wmm, { uapsd: false, parameterSetCount: 2 });
  // SSID maior do que o que veio: descarta
  assert.equal(one(221, '50 6f 9a 1c 02 11 22 33 44 55 20 41').oweTransition, undefined);
});

test('OUIs vistos e palpite de chipset', () => {
  const info = parseIes([
    ie(221, '00 50 f2 02 00 01 00'),
    ie(221, '00 10 18 02 00 00 1c 00 00'), //  Broadcom
    ie(221, '00 10 18 02 00 00'), //  repetido: aparece uma vez só
    ie(221, '00 90 4c 04 08 bf 0c'), //  Epigram (Broadcom)
    ie(221, 'f8 32 e4 01 01'), //  fabricante do aparelho, não do chip
  ]);
  assert.deepEqual(info.vendorOuis, ['00:50:f2', '00:10:18', '00:90:4c', 'f8:32:e4']);
  assert.equal(info.chipsetHint, 'Broadcom');
  assert.equal(summarizeIes(info).chipsetHint, 'Broadcom');

  const hints = {
    '8c fd f0': 'Qualcomm',
    '00 03 7f': 'Qualcomm Atheros',
    '00 13 74': 'Qualcomm Atheros',
    '00 0c e7': 'MediaTek',
    '00 0c 43': 'MediaTek (Ralink)',
    '00 e0 4c': 'Realtek',
    '00 17 f2': 'Apple',
    '00 50 43': 'Marvell',
  };
  for (const [oui, name] of Object.entries(hints)) assert.equal(one(221, `${oui} 01 00`).chipsetHint, name, oui);
  // só o OUI, sem tipo: entra na lista e não quebra
  assert.deepEqual(one(221, '00 e0 4c').vendorOuis, ['00:e0:4c']);
  assert.deepEqual(one(221, '00 e0').vendorOuis, []);
});

test('nome do AP: Cisco CCX, Aruba, MikroTik e companhia', () => {
  assert.equal(CISCO_CCX.length, 60); // 30 bytes
  const cisco = one(133, CISCO_CCX);
  assert.deepEqual(cisco.cisco, { name: 'AP-Sala-01', clients: 12 });
  assert.equal(cisco.apName, 'AP-Sala-01');
  assert.equal(summarizeIes(cisco).apName, 'AP-Sala-01');
  assert.equal(summarizeIes(cisco).stations, 12); // sem BSS Load, vale o contador da Cisco
  assert.equal(one(133, CISCO_CCX.slice(0, 40)).apName, undefined);

  // Aruba: OUI 00-0B-86, tipo 1, subtipo 3, um byte, nome "AP-RH-2"
  assert.equal(one(221, '00 0b 86 01 03 00 41 50 2d 52 48 2d 32').apName, 'AP-RH-2');
  // subtipo diferente de 3 não é nome
  assert.equal(one(221, '00 0b 86 01 04 00 41 50 2d 52 48 2d 32').apName, undefined);

  // MikroTik: OUI 00-0C-42, 3 bytes, TLV tipo 1 de 30 bytes = 10 de prefixo + nome do rádio (20, com zeros)
  const mikrotik = hx(
    '00 0c 42', '00 00 00',
    '01 1e', '00 00 00 00 1f 66 09 02 ff 0f',
    '54 6f 72 72 65 2d 4e 6f 72 74 65 00 00 00 00 00 00 00 00 00', //  "Torre-Norte"
  );
  assert.equal(one(221, mikrotik).apName, 'Torre-Norte');
  // o mesmo TLV depois de outro TLV (tipo 5, 2 bytes)
  assert.equal(one(221, mikrotik.replace('000c42000000', '000c42000000' + '0502aabb')).apName, 'Torre-Norte');
  assert.equal(one(221, mikrotik.slice(0, 40)).apName, undefined);

  // formato "OUI + tipo + nome": Ubiquiti (tipo 1), Ruckus (tipo 3), Cisco/Meraki AP name v2 (tipo 47)
  assert.equal(one(221, '00 15 6d 01 55 41 50 2d 50 72 6f').apName, 'UAP-Pro');
  assert.equal(one(221, '00 13 92 03 52 37 31 30').apName, 'R710');
  assert.equal(one(221, '00 40 96 2f 4d 52 34 36').apName, 'MR46');
  // Aerohive: tipo 33, versão, subtipo, tamanho 5, "AH-01"
  assert.equal(one(221, '00 19 77 21 01 00 05 41 48 2d 30 31 ff').apName, 'AH-01');

  // bytes que não são texto imprimível nunca viram nome
  assert.equal(one(221, '00 15 6d 01 01 02 03 04').apName, undefined);
  assert.equal(one(221, '00 15 6d 00 55 41 50').apName, undefined); // tipo errado
});

// ---------------------------------------------------------------------------
// tolerância na entrada
// ---------------------------------------------------------------------------

test('entrada estranha nunca lança e é ignorada', () => {
  for (const bad of [undefined, null, 42, 'abc', {}, () => {}, [null, undefined, 1, 'x', [], {}]]) {
    const info = parseIes(bad);
    assert.equal(info.count, 0);
    assert.deepEqual(info.vendorOuis, []);
  }
  const info = parseIes([
    { id: 11, ext: 0, hex: 'zz' }, //                hex inválido
    { id: 11, ext: 0, hex: '070' }, //               quantidade ímpar de dígitos
    { id: 11, ext: 0 }, //                           sem corpo
    { id: 'onze', ext: 0, hex: BSS_LOAD },
    { id: 300, ext: 0, hex: BSS_LOAD },
    { id: -1, ext: 0, hex: BSS_LOAD },
    { id: 11.5, ext: 0, hex: BSS_LOAD },
    { id: 11, ext: 0, hex: 12345 },
  ]);
  assert.equal(info.count, 0);
  assert.equal(info.bssLoad, undefined);
  assert.doesNotThrow(() => summarizeIes(undefined));
  assert.doesNotThrow(() => summarizeIes(null));
  assert.doesNotThrow(() => summarizeIes('x'));
  assert.doesNotThrow(() => summarizeIes({ rnr: { neighbors: 'x' }, ht: 3, wps: 'sim', bssLoad: { stations: 'muitas' } }));
  assert.equal(summarizeIes({ bssLoad: { stations: 'muitas' } }).stations, null);
});

test('hex em maiúsculas, com espaços, dois-pontos ou prefixo 0x; id como texto', () => {
  const want = one(11, BSS_LOAD).bssLoad;
  assert.deepEqual(parseIes([{ id: 11, ext: 0, hex: BSS_LOAD.toUpperCase() }]).bssLoad, want);
  assert.deepEqual(parseIes([{ id: 11, ext: 0, hex: '07 00 80 34 12' }]).bssLoad, want);
  assert.deepEqual(parseIes([{ id: 11, ext: 0, hex: '07:00:80:34:12' }]).bssLoad, want);
  assert.deepEqual(parseIes([{ id: 11, ext: 0, hex: `0x${BSS_LOAD}` }]).bssLoad, want);
  assert.deepEqual(parseIes([{ id: '11', ext: '0', hex: BSS_LOAD }]).bssLoad, want);
  assert.deepEqual(parseIes([{ id: 11, ext: 0, hex: [7, 0, 0x80, 0x34, 0x12] }]).bssLoad, want);
});

test('elemento repetido: vale o primeiro', () => {
  const info = parseIes([ie(11, BSS_LOAD), ie(11, '0100000000'), ie(48, RSN_WPA3_SAE), ie(48, RSN_WPA2_PSK)]);
  assert.equal(info.bssLoad.stations, 7);
  assert.deepEqual(info.rsn.akms, ['SAE']);
  assert.equal(info.count, 4);
});

// ---------------------------------------------------------------------------
// beacon completo e resumo
// ---------------------------------------------------------------------------

test('resumo de um beacon Wi-Fi 6 de 5 GHz montado só com vetores escritos à mão', () => {
  const info = parseIes([
    ie(1, '8c 12 98 24 b0 48 60 6c'),
    ie(7, COUNTRY_BR_5G),
    ie(11, BSS_LOAD),
    ie(35, '11 00'), //  17 dBm
    ie(45, HT_CAP_2SS),
    ie(48, RSN_TRANSITION),
    ie(54, '34 12 01'),
    ie(61, HT_OP_36_ABOVE),
    ie(70, '73 00 00 00 00'),
    ie(127, EXT_CAPS),
    ie(191, VHT_CAP_3SS),
    ie(192, '01 2a 00 fc ff'),
    ie(255, HE_CAP_5_160_PPE, 35),
    ie(255, HE_OP_COLOR_37, 36),
    ie(221, VENDOR_WMM),
    ie(221, VENDOR_WPS),
    ie(221, '8c fd f0 01 01 02 01 00'),
  ]);
  assert.equal(info.count, 17);
  assert.deepEqual(summarizeIes(info), {
    gen: 6,
    nss: 4, //  do HE (a geração mais nova que informou)
    maxMcs: 11,
    stations: 7,
    utilization: 128 / 255,
    roaming: { k: true, v: true, r: true },
    wps: { enabled: true, configured: true, locked: true, deviceName: 'Escritório', manufacturer: 'TP-LINK', model: 'Archer C6 1.0' },
    country: 'BR',
    txPowerDbm: 17,
    bssColor: 37,
    twt: true, //  pelo Extended Capabilities (o HE deste vetor não anuncia)
    muMimo: true, //  pelo VHT
    beamforming: true,
    mlo: false,
    mldMac: null,
    apName: null,
    chipsetHint: 'Qualcomm',
    legacy11b: false,
    wmm: true,
    ftmResponder: true,
    colocated: [],
    passpoint: false,
    mesh: false,
    p2p: false,
  });

  // e a segurança refinada por esses mesmos elementos
  const sec = refineWithIes(parseCapabilities('[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][WPS]'), info);
  assert.equal(sec.label, 'WPA2/WPA3');
  assert.equal(sec.pmf, 'capable');
  assert.equal(sec.wpsLocked, true);
});

test('resumo: geração pela presença de HT/VHT/HE/EHT e campos vazios', () => {
  assert.equal(summarizeIes(parseIes([])).gen, null);
  assert.equal(summarizeIes(one(45, HT_CAP_2SS)).gen, 4);
  assert.equal(summarizeIes(one(61, HT_OP_36_ABOVE)).gen, 4);
  assert.equal(summarizeIes(parseIes([ie(45, HT_CAP_2SS), ie(191, VHT_CAP_3SS)])).gen, 5);
  assert.equal(summarizeIes(parseIes([ie(45, HT_CAP_2SS), ie(255, HE_CAP_24, 35)])).gen, 6);
  assert.equal(summarizeIes(parseIes([ie(255, HE_CAP_24, 35), ie(255, EHT_CAP_320, 108)])).gen, 7);

  const vht = summarizeIes(parseIes([ie(45, HT_CAP_2SS), ie(191, VHT_CAP_3SS)]));
  assert.equal(vht.nss, 3);
  assert.equal(vht.maxMcs, 9);
  const ht = summarizeIes(one(45, HT_CAP_2SS));
  assert.equal(ht.nss, 2);
  assert.equal(ht.maxMcs, 7);

  assert.deepEqual(summarizeIes(parseIes([])), {
    gen: null,
    nss: null,
    maxMcs: null,
    stations: null,
    utilization: null,
    roaming: { k: false, v: false, r: false },
    wps: null,
    country: null,
    txPowerDbm: null,
    bssColor: null,
    twt: false,
    muMimo: false,
    beamforming: false,
    mlo: false,
    mldMac: null,
    apName: null,
    chipsetHint: null,
    legacy11b: false,
    wmm: false,
    ftmResponder: false,
    colocated: [],
    passpoint: false,
    mesh: false,
    p2p: false,
  });
});

// ---------------------------------------------------------------------------
// encodeIes
// ---------------------------------------------------------------------------

test('encodeIes: formato da saída e descrição vazia', () => {
  for (const bad of [undefined, null, 'x', 7, []]) {
    const ies = encodeIes(bad);
    assert.ok(Array.isArray(ies));
    for (const e of ies) {
      assert.ok(Number.isInteger(e.id) && e.id >= 0 && e.id <= 255);
      assert.ok(Number.isInteger(e.ext));
      assert.match(e.hex, /^([0-9a-f]{2})*$/);
    }
  }
  const ies = encodeIes({ he: { nss: 2, bssColor: 9 }, eht: { nss: 2 } });
  // só os elementos de extensão têm `ext`, e o corpo não repete o número da extensão
  for (const e of ies) assert.equal(e.ext !== 0, e.id === 255);
  assert.deepEqual(ies.filter((e) => e.id === 255).map((e) => e.ext).sort((a, b) => a - b), [35, 36, 106, 108]);
});

test('encodeIes -> parseIes: descrição do contrato do simulador', () => {
  const spec = {
    bssLoad: { stations: 23, utilization: 0.6 },
    country: 'BR',
    ht: { nss: 3, width40: true },
    vht: { nss: 3, width160: false },
    he: { nss: 2, bssColor: 41 },
    eht: { nss: 2 },
    rsn: { akms: ['PSK', 'SAE'], ciphers: ['CCMP'], pmfCapable: true, pmfRequired: false },
    wps: { configured: true, deviceName: 'Roteador da Sala', manufacturer: 'Intelbras', model: 'W5-1200G' },
    roaming: { k: true, v: true, r: true },
    rates: { legacy11b: false },
  };
  const info = parseIes(encodeIes(spec));
  assert.equal(info.bssLoad.stations, 23);
  assert.ok(Math.abs(info.bssLoad.utilization - 0.6) <= 1 / 255);
  assert.equal(info.country.code, 'BR');
  assert.ok(info.country.triplets.length > 0);
  assert.equal(info.ht.nss, 3);
  assert.equal(info.ht.width40, true);
  assert.equal(info.vht.nss, 3);
  assert.equal(info.vht.width160, false);
  assert.equal(info.he.nss, 2);
  assert.equal(info.he.width160, false);
  assert.equal(info.heOperation.bssColor, 41);
  assert.equal(info.eht.nss, 2);
  assert.equal(info.eht.width320, false);
  assert.equal(info.ehtOperation.present, true);
  assert.deepEqual(info.rsn.akms, ['PSK', 'SAE']);
  assert.deepEqual(info.rsn.pairwiseCiphers, ['CCMP']);
  assert.equal(info.rsn.pmfCapable, true);
  assert.equal(info.rsn.pmfRequired, false);
  assert.equal(info.wps.configured, true);
  assert.equal(info.wps.deviceName, 'Roteador da Sala');
  assert.equal(info.wps.manufacturer, 'Intelbras');
  assert.equal(info.wps.modelName, 'W5-1200G');
  assert.ok(info.rm && info.rm.neighborReport);
  assert.equal(info.extCaps.bssTransition, true);
  assert.ok(info.mobilityDomain);
  assert.equal(info.rates.legacy11b, false);

  const s = summarizeIes(info);
  assert.equal(s.gen, 7);
  assert.equal(s.nss, 2);
  assert.equal(s.stations, 23);
  assert.deepEqual(s.roaming, { k: true, v: true, r: true });
  assert.equal(s.country, 'BR');
  assert.equal(s.bssColor, 41);
  assert.equal(s.wps.deviceName, 'Roteador da Sala');
  assert.equal(s.wps.model, 'W5-1200G');
  assert.equal(s.wmm, true);
});

test('encodeIes -> parseIes: cada parte isolada e seus opostos', () => {
  // roaming desligado não emite nada de k/v/r
  const off = parseIes(encodeIes({ ht: { nss: 1, width40: false }, roaming: { k: false, v: false, r: false } }));
  assert.equal(off.rm, undefined);
  assert.equal(off.mobilityDomain, undefined);
  assert.equal(off.extCaps.bssTransition, false);
  assert.equal(off.ht.nss, 1);
  assert.equal(off.ht.width40, false);
  assert.equal(off.ht.sgi40, false);

  for (const k of ['k', 'v', 'r']) {
    const s = summarizeIes(parseIes(encodeIes({ roaming: { [k]: true } })));
    assert.deepEqual(s.roaming, { k: k === 'k', v: k === 'v', r: k === 'r' });
  }

  // 11b ligado (2,4 GHz)
  const b = parseIes(encodeIes({ rates: { legacy11b: true }, ht: { nss: 2, width40: false } }));
  assert.equal(b.rates.legacy11b, true);
  assert.deepEqual(b.rates.basicRates, [1, 2, 5.5, 11]);
  assert.equal(b.rates.rates.length, 12);

  // fluxos de 1 a 8 no VHT/HE/EHT e de 1 a 4 no HT
  for (let nss = 1; nss <= 8; nss++) {
    const info = parseIes(encodeIes({ ht: { nss }, vht: { nss, width160: true }, he: { nss, bssColor: nss }, eht: { nss } }));
    assert.equal(info.ht.nss, Math.min(4, nss));
    assert.equal(info.vht.nss, nss);
    assert.equal(info.vht.width160, true);
    assert.equal(info.vht.sgi160, true);
    assert.equal(info.he.nss, nss);
    assert.equal(info.he.width160, true);
    assert.equal(info.he.nss160, nss);
    assert.equal(info.eht.nss, nss);
    assert.equal(info.heOperation.bssColor, nss);
  }

  // PMF obrigatório e cifras de 256 bits
  const strong = parseIes(encodeIes({ rsn: { akms: ['SAE', 'FT-SAE', 'SAE-EXT-KEY'], ciphers: ['CCMP', 'GCMP-256'], pmfRequired: true } }));
  assert.deepEqual(strong.rsn.akms, ['SAE', 'FT-SAE', 'SAE-EXT-KEY']);
  assert.deepEqual(strong.rsn.pairwiseCiphers, ['CCMP', 'GCMP-256']);
  assert.equal(strong.rsn.pmfRequired, true);
  assert.equal(strong.rsn.pmfCapable, true);
  assert.equal(strong.rsn.groupMgmtCipher, 'BIP-CMAC-128');

  // sem PMF não há campo de PMKID nem cifra de gerenciamento
  const weak = parseIes(encodeIes({ rsn: { akms: ['PSK'], ciphers: ['TKIP', 'CCMP'] }, wpa: { akms: ['PSK'], ciphers: ['TKIP'] } }));
  assert.equal(weak.rsn.pmfCapable, false);
  assert.equal(weak.rsn.groupCipher, 'TKIP');
  assert.equal(weak.rsn.groupMgmtCipher, null);
  assert.deepEqual(weak.wpa.akms, ['PSK']);
  assert.deepEqual(weak.wpa.pairwiseCiphers, ['TKIP']);

  // empresarial, OWE e DPP
  assert.deepEqual(parseIes(encodeIes({ rsn: { akms: ['EAP', 'FT-EAP'] } })).rsn.akms, ['EAP', 'FT-EAP']);
  assert.deepEqual(parseIes(encodeIes({ rsn: { akms: ['OWE'], pmfRequired: true } })).rsn.akms, ['OWE']);
  assert.deepEqual(parseIes(encodeIes({ rsn: { akms: ['DPP'] } })).rsn.akms, ['DPP']);
  // nomes desconhecidos caem no padrão em vez de gerar elemento inválido
  assert.deepEqual(parseIes(encodeIes({ rsn: { akms: ['XYZ'], ciphers: ['??'] } })).rsn.akms, ['PSK']);

  // WPS não configurado e travado; cor desligada; TWT desligado
  const w = parseIes(encodeIes({ wps: { configured: false, locked: true } })).wps;
  assert.equal(w.configured, false);
  assert.equal(w.locked, true);
  assert.equal(w.deviceName, null);
  const he = parseIes(encodeIes({ he: { nss: 2, bssColor: 63, bssColorDisabled: true, twt: false } }));
  assert.equal(he.heOperation.bssColor, 63);
  assert.equal(he.heOperation.bssColorDisabled, true);
  assert.equal(he.he.twtResponder, false);
  assert.equal(summarizeIes(he).twt, false);
  assert.equal(summarizeIes(he).bssColor, null);

  // extras: potência, FTM, OUI do chip, vizinhos e Multi-Link
  const extra = parseIes(
    encodeIes({
      txPowerDbm: 19,
      ftmResponder: true,
      vendorOuis: ['00:10:18'],
      eht: { nss: 2, mldMac: '02:00:5e:10:20:30', linkId: 1, maxSimultaneousLinks: 3 },
      rnr: [
        { opClass: 131, channel: 5, bssid: 'aa:bb:cc:00:00:06', ssid: 'Casa', sameSsid: true },
        { opClass: 81, channel: 6, bssid: 'aa:bb:cc:00:00:24', colocated: false },
      ],
    }),
  );
  assert.equal(extra.tpcReport.txPowerDbm, 19);
  assert.equal(extra.extCaps.ftmResponder, true);
  assert.equal(extra.chipsetHint, 'Broadcom');
  assert.deepEqual(extra.multiLink, { present: true, type: 'basic', mldMac: '02:00:5e:10:20:30', linkId: 1, maxSimultaneousLinks: 3 });
  assert.equal(extra.rnr.neighbors.length, 2);
  assert.equal(extra.rnr.neighbors[0].shortSsid, shortSsid('Casa'));
  assert.equal(extra.rnr.neighbors[0].sameSsid, true);
  assert.equal(extra.rnr.neighbors[0].band, '6');
  assert.equal(extra.rnr.neighbors[1].colocated, false);
  assert.deepEqual(summarizeIes(extra).colocated, [{ band: '6', channel: 5, bssid: 'aa:bb:cc:00:00:06' }]);
});

test('encodeIes com frequência: canal primário e centros corretos', () => {
  // 2,4 GHz, canal 6, 40 MHz: secundário acima; canal 11: abaixo
  const ch6 = parseIes(encodeIes({ frequency: 2437, ht: { nss: 2, width40: true } }));
  assert.deepEqual(ch6.ds, { channel: 6 });
  assert.equal(ch6.htOperation.primaryChannel, 6);
  assert.equal(ch6.htOperation.secondaryOffset, 'above');
  assert.ok(ch6.erp);
  const ch11 = parseIes(encodeIes({ frequency: 2462, ht: { nss: 2, width40: true } }));
  assert.equal(ch11.htOperation.primaryChannel, 11);
  assert.equal(ch11.htOperation.secondaryOffset, 'below');
  // 20 MHz: sem canal secundário
  const narrow = parseIes(encodeIes({ frequency: 2412, ht: { nss: 2, width40: false } }));
  assert.equal(narrow.htOperation.secondaryOffset, null);
  assert.equal(narrow.htOperation.staWidth, 20);

  // 5 GHz, canal 36, 80 MHz: bloco 36-48, centro 42; 40 MHz 36+40, secundário acima
  const ch36 = parseIes(encodeIes({ frequency: 5180, ht: { nss: 2, width40: true }, vht: { nss: 2 } }));
  assert.equal(ch36.ds, undefined);
  assert.equal(ch36.erp, undefined);
  assert.equal(ch36.htOperation.primaryChannel, 36);
  assert.equal(ch36.htOperation.secondaryOffset, 'above');
  assert.deepEqual(ch36.vhtOperation, { width: 1, centerSeg0: 42, centerSeg1: 0, widthMhz: 80, plus80: false });
  // canal 48 (5240 MHz) é o de cima do par 44+48
  assert.equal(parseIes(encodeIes({ frequency: 5240, ht: { nss: 2, width40: true }, vht: { nss: 2 } })).htOperation.secondaryOffset, 'below');

  // canal 100 com 160 MHz: centro dos 80 = 106, centro dos 160 = 114
  const ch100 = parseIes(encodeIes({ frequency: 5500, ht: { nss: 4, width40: true }, vht: { nss: 4, width160: true } }));
  assert.deepEqual(ch100.vhtOperation, { width: 1, centerSeg0: 106, centerSeg1: 114, widthMhz: 160, plus80: false });
  // canal 149 não tem bloco clássico de 160: cai para 80 (centro 155)
  const ch149 = parseIes(encodeIes({ frequency: 5745, ht: { nss: 4, width40: true }, vht: { nss: 4, width160: true } }));
  assert.equal(ch149.vhtOperation.widthMhz, 80);
  assert.equal(ch149.vhtOperation.centerSeg0, 155);
  // canal 165 só tem 20 MHz
  const ch165 = parseIes(encodeIes({ frequency: 5825, ht: { nss: 2, width40: true }, vht: { nss: 2 } }));
  assert.equal(ch165.htOperation.secondaryOffset, null);
  assert.equal(ch165.vhtOperation.widthMhz, null);
  // largura pedida menor do que a capacidade
  const limited = parseIes(encodeIes({ frequency: 5180, widthMhz: 40, ht: { nss: 2, width40: true }, vht: { nss: 2 } }));
  assert.equal(limited.vhtOperation.widthMhz, null);
  assert.equal(limited.htOperation.secondaryOffset, 'above');

  // 6 GHz, canal 37 (6135 MHz), 320 MHz: sem HT/VHT; HE anuncia a metade de 160
  const six = parseIes(encodeIes({ frequency: 6135, ht: { nss: 2, width40: true }, vht: { nss: 2 }, he: { nss: 2, bssColor: 5, width160: true }, eht: { nss: 2, width320: true } }));
  assert.equal(six.ht, undefined);
  assert.equal(six.vht, undefined);
  assert.equal(six.htOperation, undefined);
  assert.deepEqual(six.heOperation.sixGhz, { primaryChannel: 37, width: 160, centerSeg0: 39, centerSeg1: 47, duplicateBeacon: false, regInfo: 0, minRate: 6 });
  assert.deepEqual(six.ehtOperation, { present: true, width: 320, centerSeg0: 47, centerSeg1: 31, disabledSubchannels: null });
  assert.equal(six.eht.width320, true);
  assert.equal(six.he.width160, true);
  // 6 GHz de 80 MHz: centro 7 para o canal 1 (5955 MHz)
  const six80 = parseIes(encodeIes({ frequency: 5955, he: { nss: 2, bssColor: 1 }, eht: { nss: 2 } }));
  assert.deepEqual(six80.heOperation.sixGhz, { primaryChannel: 1, width: 80, centerSeg0: 7, centerSeg1: 0, duplicateBeacon: false, regInfo: 0, minRate: 6 });
  assert.deepEqual(six80.ehtOperation, { present: true, width: 80, centerSeg0: 7, centerSeg1: 0, disabledSubchannels: null });

  // frequência que não é canal de Wi-Fi: só as capacidades
  const odd = parseIes(encodeIes({ frequency: 3000, ht: { nss: 2, width40: true } }));
  assert.equal(odd.htOperation, undefined);
  assert.equal(odd.ht.nss, 2);
});

test('encodeIes reproduz, byte a byte, vetores escritos à mão', () => {
  const byId = (ies, id, ext = 0) => ies.find((e) => e.id === id && e.ext === ext).hex;
  assert.equal(byId(encodeIes({ rsn: { akms: ['PSK'], ciphers: ['CCMP'] } }), 48), RSN_WPA2_PSK);
  assert.equal(byId(encodeIes({ rsn: { akms: ['SAE'], ciphers: ['CCMP'], pmfRequired: true } }), 48), RSN_WPA3_SAE);
  assert.equal(byId(encodeIes({ country: 'BR' }), 7), COUNTRY_BR);
  assert.equal(byId(encodeIes({ he: { nss: 2, bssColor: 37 } }), 255, 36), HE_OP_COLOR_37);
  assert.equal(byId(encodeIes({ bssLoad: { stations: 7, utilization: 128 / 255, admissionCapacity: 0x1234 } }), 11), BSS_LOAD);
  assert.equal(byId(encodeIes({ wpa: { akms: ['PSK'], ciphers: ['TKIP'] } }), 221), VENDOR_WPA1_TKIP);
  assert.equal(byId(encodeIes({ roaming: { k: true } }), 70), '7300000000');
});

// ---------------------------------------------------------------------------
// fuzz
// ---------------------------------------------------------------------------

/** Gerador determinístico (mulberry32), para o teste falhar sempre do mesmo jeito. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHex(rnd, bytes) {
  let s = '';
  for (let i = 0; i < bytes; i++) s += Math.floor(rnd() * 256).toString(16).padStart(2, '0');
  return s;
}

/**
 * Uma leitura além do fim do corpo não lança em JavaScript: devolve undefined, que vira NaN
 * nas contas e "undefined" nos textos. É isso que este verificador procura.
 */
function assertClean(value, path = 'info') {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') return assert.ok(Number.isFinite(value), `${path} não é um número finito`);
  if (typeof value === 'string') return assert.ok(!/undefined|NaN/.test(value), `${path} = "${value}"`);
  assert.equal(typeof value, 'object', `${path} tem tipo ${typeof value}`);
  if (Array.isArray(value)) return value.forEach((v, i) => assertClean(v, `${path}[${i}]`));
  for (const [k, v] of Object.entries(value)) assertClean(v, `${path}.${k}`);
}

/** Roda a cadeia inteira e confere que o resultado continua bem formado. */
function digest(ies) {
  const info = parseIes(ies);
  assert.equal(typeof info, 'object');
  assert.ok(Array.isArray(info.vendorOuis));
  assert.ok(Number.isInteger(info.count));
  assertClean(info);
  const s = summarizeIes(info);
  assert.ok(s.gen === null || [4, 5, 6, 7].includes(s.gen));
  assert.ok(Array.isArray(s.colocated));
  assert.ok(s.nss === null || (Number.isInteger(s.nss) && s.nss >= 1 && s.nss <= 8));
  assert.ok(s.utilization === null || (s.utilization >= 0 && s.utilization <= 1));
  const sec = refineWithIes(parseCapabilities('[ESS]'), info);
  assert.ok(sec.level >= 0 && sec.level <= 4);
  assert.equal(typeof sec.label, 'string');
  JSON.stringify(info); // nada de BigInt ou referência circular
  return info;
}

const KNOWN_GOOD = [
  [1, '82848b960c121824', 0], [3, '06', 0], [7, COUNTRY_BR, 0], [7, COUNTRY_BR_5G, 0], [11, BSS_LOAD, 0], [32, '03', 0],
  [35, '1400', 0], [42, '07', 0], [45, HT_CAP_2SS, 0], [48, RSN_WPA2_PSK, 0], [48, RSN_WPA3_SAE, 0], [48, RSN_TKIP_CCMP, 0],
  [50, '3048606c', 0], [54, '341201', 0], [61, HT_OP_36_ABOVE, 0], [70, '7300000000', 0], [71, '03', 0],
  [107, '02001122334455', 0], [127, EXT_CAPS, 0], [133, CISCO_CCX, 0], [191, VHT_CAP_3SS, 0], [192, '012a32fcff', 0],
  [195, '0b0a0a0a0a', 0], [201, RNR, 0], [255, HE_CAP_24, 35], [255, HE_CAP_5_160_PPE, 35], [255, HE_OP_6GHZ, 36],
  [255, HE_OP_VHT_COHOSTED, 36], [255, EHT_OP_PUNCTURED, 106], [255, MULTI_LINK_BASIC, 107], [255, EHT_CAP_320, 108],
  [221, VENDOR_WPA1_TKIP, 0], [221, VENDOR_WMM, 0], [221, VENDOR_WPS, 0], [221, VENDOR_OWE_TRANSITION, 0],
  [221, VENDOR_RSN_OVERRIDE, 0], [221, '506f9a160101400401 01', 0], [221, '000b860103004150', 0],
  [221, '000c42000000011e00000000' + '1f660902ff0f' + '546f727265' + '00'.repeat(15), 0],
].map(([id, hex, ext]) => ({ id, ext, hex: hx(hex) }));

test('fuzz: corpos aleatórios para todos os ids (0 a 255)', () => {
  const rnd = prng(0x5eed1);
  let n = 0;
  for (let id = 0; id <= 255; id++) {
    for (let k = 0; k < 40; k++) {
      // tamanhos pequenos são os que mais pegam leitura fora do corpo
      const len = k < 20 ? k : Math.floor(rnd() * 255);
      const ext = id === 255 ? Math.floor(rnd() * 256) : 0;
      assert.doesNotThrow(() => digest([{ id, ext, hex: randomHex(rnd, len) }]), `id ${id}, ${len} bytes`);
      n += 1;
    }
  }
  assert.equal(n, 10240);
});

test('fuzz: todas as extensões (0 a 255) e todos os tipos de elemento de fabricante', () => {
  const rnd = prng(0xe1e7);
  for (let ext = 0; ext <= 255; ext++) {
    for (let k = 0; k < 24; k++) {
      const len = k < 14 ? k * 2 : Math.floor(rnd() * 120);
      assert.doesNotThrow(() => digest([{ id: 255, ext, hex: randomHex(rnd, len) }]), `ext ${ext}`);
    }
  }
  const ouis = ['0050f2', '506f9a', '000b86', '000c42', '00e0fc', '001977', '00156d', '004096', '001018'];
  for (const oui of ouis) {
    for (let type = 0; type <= 255; type++) {
      for (let k = 0; k < 6; k++) {
        const hex = oui + type.toString(16).padStart(2, '0') + randomHex(rnd, k < 3 ? k : Math.floor(rnd() * 90));
        assert.doesNotThrow(() => digest([{ id: 221, ext: 0, hex }]), `oui ${oui} tipo ${type}`);
      }
    }
  }
});

test('fuzz: elementos válidos truncados em todos os tamanhos e com bits trocados', () => {
  const rnd = prng(0xbadc0de);
  for (const e of KNOWN_GOOD) {
    // cada prefixo possível do corpo, inclusive com meio byte sobrando
    for (let cut = 0; cut <= e.hex.length; cut++) {
      assert.doesNotThrow(() => digest([{ id: e.id, ext: e.ext, hex: e.hex.slice(0, cut) }]), `id ${e.id} cortado em ${cut}`);
    }
    // um byte trocado por vez (valor aleatório, 0x00 e 0xFF) e lixo no fim
    for (let pos = 0; pos < e.hex.length; pos += 2) {
      for (const v of [randomHex(rnd, 1), '00', 'ff']) {
        const hex = e.hex.slice(0, pos) + v + e.hex.slice(pos + 2);
        assert.doesNotThrow(() => digest([{ id: e.id, ext: e.ext, hex }]), `id ${e.id} byte ${pos / 2} = ${v}`);
      }
    }
    assert.doesNotThrow(() => digest([{ id: e.id, ext: e.ext, hex: e.hex + randomHex(rnd, 40) }]));
    // o mesmo corpo entregue com o id de outro elemento
    for (const other of KNOWN_GOOD) assert.doesNotThrow(() => digest([{ id: other.id, ext: other.ext, hex: e.hex }]));
  }
});

// O try/catch do parseIes esconderia uma leitura fora do corpo, e contas com bits
// (`undefined | 0`) nem NaN deixam. Aqui o corpo vai embrulhado num Proxy que conta
// qualquer acesso a um índice que não existe: o total tem de ser zero.
let outOfBounds = 0;
function guarded(bytes) {
  return new Proxy(bytes, {
    get(target, prop) {
      if (typeof prop === 'string' && /^-?\d+$/.test(prop)) {
        if (Number(prop) < 0 || Number(prop) >= target.length) outOfBounds += 1;
        return target[prop];
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        const result = value.apply(target, args);
        // subarray enxerga a mesma memória: continua vigiado
        return prop === 'subarray' ? guarded(result) : result;
      };
    },
  });
}
const guardedIe = (id, ext, hex) => ({ id, ext, hex: guarded(Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16))) });

test('fuzz: nenhum decodificador lê além do fim do corpo', () => {
  // o vigia funciona: uma leitura fora é contada, uma dentro não
  const probe = guarded(Uint8Array.of(1, 2, 3));
  assert.equal(probe[2], 3);
  assert.equal(probe.subarray(1)[1], 3);
  assert.equal(outOfBounds, 0);
  assert.equal(probe[3], undefined);
  assert.equal(probe.subarray(1)[2], undefined);
  assert.equal(outOfBounds, 2);
  outOfBounds = 0;

  // e não muda o resultado
  for (const e of KNOWN_GOOD) assert.deepEqual(parseIes([guardedIe(e.id, e.ext, e.hex)]), parseIes([e]), `id ${e.id}`);
  assert.equal(outOfBounds, 0);

  const rnd = prng(0x0b0b);
  const check = (id, ext, hex, what) => {
    parseIes([guardedIe(id, ext, hex)]);
    if (outOfBounds !== 0) assert.fail(`leitura fora do corpo: ${what}, hex ${hex}`);
  };
  for (let id = 0; id <= 255; id++) {
    for (let k = 0; k < 48; k++) {
      const len = k < 32 ? k : Math.floor(rnd() * 255);
      check(id, id === 255 ? Math.floor(rnd() * 256) : 0, randomHex(rnd, len), `id ${id}`);
    }
  }
  for (const ext of [0, 35, 36, 106, 107, 108]) {
    for (let k = 0; k < 400; k++) check(255, ext, randomHex(rnd, k < 64 ? k : Math.floor(rnd() * 120)), `ext ${ext}`);
  }
  for (const oui of ['0050f2', '506f9a', '000b86', '000c42', '00e0fc', '001977', '00156d']) {
    for (let type = 0; type <= 255; type++) {
      for (let k = 0; k < 8; k++) {
        const hex = oui + type.toString(16).padStart(2, '0') + randomHex(rnd, k < 4 ? k : Math.floor(rnd() * 80));
        check(221, 0, hex, `oui ${oui} tipo ${type}`);
      }
    }
  }
  for (const e of KNOWN_GOOD) {
    for (let cut = 0; cut <= e.hex.length; cut += 2) check(e.id, e.ext, e.hex.slice(0, cut), `id ${e.id} cortado`);
    for (let pos = 0; pos < e.hex.length; pos += 2) {
      for (const v of [randomHex(rnd, 1), '00', 'ff']) check(e.id, e.ext, e.hex.slice(0, pos) + v + e.hex.slice(pos + 2), `id ${e.id} alterado`);
    }
  }
});

test('fuzz: beacons inteiros embaralhados e objetos malformados', () => {
  const rnd = prng(0xc0ffee);
  const junk = [null, undefined, 0, 'x', {}, [], { id: 48 }, { hex: 'zz' }, { id: null, hex: null }, { id: 255, ext: 'x', hex: '2' },
    { id: 255, ext: {}, hex: [] }, { id: 221, ext: -5, hex: '0050f2' }, { id: 48, ext: 0, hex: { length: 4 } }, { id: 1e9, hex: '00' },
    { id: 11, hex: ['a', 'b', 'c', 'd', 'e'] }, { id: 11, hex: [1.5, 2, 3, 4, 5] }];
  for (let round = 0; round < 400; round++) {
    const ies = [];
    const n = Math.floor(rnd() * 30);
    for (let i = 0; i < n; i++) {
      const pick = rnd();
      if (pick < 0.6) ies.push(KNOWN_GOOD[Math.floor(rnd() * KNOWN_GOOD.length)]);
      else if (pick < 0.9) ies.push({ id: Math.floor(rnd() * 256), ext: Math.floor(rnd() * 256), hex: randomHex(rnd, Math.floor(rnd() * 60)) });
      else ies.push(junk[Math.floor(rnd() * junk.length)]);
    }
    assert.doesNotThrow(() => digest(ies), `rodada ${round}`);
  }
});

test('fuzz: encodeIes com descrições aleatórias nunca lança e sempre gera hex válido', () => {
  const rnd = prng(0xfab);
  const weird = [undefined, null, -1, 0, 1, 2, 99, 1e9, NaN, Infinity, 'x', '', true, false, [], {}, { nss: 'a' }];
  const any = () => weird[Math.floor(rnd() * weird.length)];
  const freqs = [2412, 2437, 2472, 2484, 5180, 5500, 5745, 5825, 5955, 6135, 7115, 3000, -5, 'x', undefined];
  for (let round = 0; round < 600; round++) {
    const spec = {
      frequency: freqs[Math.floor(rnd() * freqs.length)],
      widthMhz: any(),
      rates: rnd() < 0.5 ? { legacy11b: any() } : any(),
      country: rnd() < 0.5 ? 'BR' : rnd() < 0.5 ? { code: any(), triplets: any() } : any(),
      bssLoad: rnd() < 0.5 ? { stations: any(), utilization: any() } : any(),
      txPowerDbm: any(),
      ht: rnd() < 0.6 ? { nss: any(), width40: any(), secondary: any() } : any(),
      vht: rnd() < 0.6 ? { nss: any(), width160: any(), maxMcs: any() } : any(),
      he: rnd() < 0.6 ? { nss: any(), bssColor: any(), width160: any() } : any(),
      eht: rnd() < 0.6 ? { nss: any(), width320: any(), mldMac: rnd() < 0.5 ? 'zz' : '02:00:00:00:00:01' } : any(),
      rsn: rnd() < 0.6 ? { akms: any(), ciphers: any(), pmfCapable: any(), pmfRequired: any() } : any(),
      wpa: rnd() < 0.3 ? { akms: [any()], ciphers: [any()] } : any(),
      wps: rnd() < 0.5 ? { configured: any(), deviceName: any(), manufacturer: any(), model: any() } : any(),
      roaming: rnd() < 0.5 ? { k: any(), v: any(), r: any(), mdid: any() } : any(),
      rnr: rnd() < 0.3 ? [any(), { opClass: any(), channel: any(), bssid: any(), ssid: any() }] : any(),
      vendorOuis: rnd() < 0.3 ? [any(), '00:10:18', 'zz'] : any(),
      wmm: any(),
    };
    let ies;
    assert.doesNotThrow(() => {
      ies = encodeIes(spec);
    }, `rodada ${round}`);
    for (const e of ies) {
      assert.ok(Number.isInteger(e.id) && e.id >= 0 && e.id <= 255);
      assert.match(e.hex, /^([0-9a-f]{2})*$/);
      assert.ok(e.hex.length / 2 <= 255, 'corpo cabe em um elemento');
    }
    assert.doesNotThrow(() => digest(ies), `rodada ${round}`);
  }
});
