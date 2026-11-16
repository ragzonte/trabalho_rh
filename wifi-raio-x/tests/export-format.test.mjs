// Exportar: CSV (com proteção contra injeção de fórmula), JSON e relatório em texto.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText,
  neutralizeFormula,
  csvQuote,
  csvCell,
  apRecord,
  networkRecord,
  buildCsv,
  buildJson,
  buildReport,
  dateTimeText,
  fileName,
  utf8Length,
  formatBytes,
  previewOf,
  CSV_COLUMNS,
} from '../app/js/ui/tools/export-format.js';
import { normalizeScan, groupByDevice, groupBySsid } from '../app/js/core/model.js';
import { apartment, TS } from './fixtures/scans.mjs';

const ch = (code) => String.fromCodePoint(code);
const RLO = ch(0x202e); // inverte a direção do texto
const LRM = ch(0x200e);
const LINE_SEP = ch(0x2028);
const BOM = ch(0xfeff);
const NUL = ch(0);

/** Um Ap como o store entrega (campos de core/model.js + os que o store acrescenta). */
function storeAp(more = {}) {
  return {
    id: 'aa:bb:cc:00:11:22',
    bssid: 'aa:bb:cc:00:11:22',
    ssid: 'Casa',
    hidden: false,
    rssi: -57.4,
    quality: 85,
    freq: 5180,
    band: '5',
    channel: 36,
    widthMHz: 80,
    gen: 6,
    standard: 'Wi-Fi 6',
    security: { known: true, label: 'WPA2', level: 3, wps: true, issues: [{ code: 'wps', severity: 'medium', text: 'WPS ligado' }] },
    distanceM: 6.34,
    ageMs: 1240,
    stations: 4,
    utilization: 0.31,
    vendor: 'TP-Link',
    vendorGuess: false,
    connected: true,
    favorite: true,
    own: true,
    ...more,
  };
}

/** Leitor de CSV mínimo (RFC 4180), para conferir que o que sai volta igual. */
function parseCsv(text, delimiter = ';') {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe('texto seguro', () => {
  test('cleanText troca controles, quebras de linha e marcas de direção por "·"', () => {
    assert.equal(cleanText(`a${NUL}b`), 'a·b');
    assert.equal(cleanText('linha1\nlinha2\r\tfim'), 'linha1·linha2··fim');
    assert.equal(cleanText(`abc${RLO}def${LRM}`), 'abc·def·');
    assert.equal(cleanText(`x${LINE_SEP}y`), 'x·y');
    assert.equal(cleanText('Família Souza 🚀 “ok”'), 'Família Souza 🚀 “ok”', 'acentos, emoji e aspas ficam');
    assert.equal(cleanText(null), '');
    assert.equal(cleanText(42), '42');
  });

  test('neutralizeFormula põe apóstrofo no que uma planilha executaria', () => {
    for (const start of ['=', '+', '-', '@', '\t', '\r', '＝', '＋', '－', '＠']) {
      assert.equal(neutralizeFormula(`${start}cmd`), `'${start}cmd`, `começo ${JSON.stringify(start)}`);
    }
    assert.equal(neutralizeFormula('=HYPERLINK("http://x","clique")'), '\'=HYPERLINK("http://x","clique")');
    assert.equal(neutralizeFormula("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
    assert.equal(neutralizeFormula('Casa'), 'Casa');
    assert.equal(neutralizeFormula('a=b'), 'a=b', 'só o começo importa');
    assert.equal(neutralizeFormula(' =1+1'), ' =1+1', 'com espaço na frente a planilha já trata como texto');
    assert.equal(neutralizeFormula(''), '');
    assert.equal(neutralizeFormula(null), '');
  });

  test('csvQuote só põe aspas quando precisa, e dobra as de dentro', () => {
    assert.equal(csvQuote('Casa'), 'Casa');
    assert.equal(csvQuote('Casa do João'), 'Casa do João');
    assert.equal(csvQuote('a;b'), '"a;b"');
    assert.equal(csvQuote('a,b'), '"a,b"', 'vírgula também: o arquivo pode ser aberto com outro separador');
    assert.equal(csvQuote('diz "oi"'), '"diz ""oi"""');
    assert.equal(csvQuote('duas\nlinhas'), '"duas\nlinhas"');
    assert.equal(csvQuote('volta\rcarro'), '"volta\rcarro"');
    assert.equal(csvQuote(' espaço'), '" espaço"');
    assert.equal(csvQuote('espaço '), '"espaço "');
    assert.equal(csvQuote(''), '');
    assert.equal(csvQuote('a\tb', '\t'), '"a\tb"');
  });

  test('csvCell: números, booleanos, vazios e texto hostil', () => {
    assert.equal(csvCell(-57), '-57', 'número gerado pelo app não é fórmula');
    assert.equal(csvCell(6.3), '6,3');
    assert.equal(csvCell(6.3, { decimal: '.' }), '6.3');
    assert.equal(csvCell(6.3, { delimiter: ',', decimal: ',' }), '"6,3"', 'vírgula decimal num CSV separado por vírgula');
    assert.equal(csvCell(0), '0');
    assert.equal(csvCell(NaN), '');
    assert.equal(csvCell(Infinity), '');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
    assert.equal(csvCell(true), 'sim');
    assert.equal(csvCell(false), 'não');
    assert.equal(csvCell('=1+1'), "'=1+1");
    assert.equal(csvCell('-57'), "'-57", 'texto que parece número negativo veio de fora: é neutralizado');
    assert.equal(csvCell('+55 11 99999'), "'+55 11 99999");
    assert.equal(csvCell('@SUM(A1:A9)'), "'@SUM(A1:A9)");
    assert.equal(csvCell('=1;2'), '"\'=1;2"', 'neutraliza e depois protege com aspas');
    assert.equal(csvCell('=a"b'), '"\'=a""b"');
    assert.equal(csvCell('a\nb'), 'a·b', 'quebra de linha vinda de fora vira "·"');
    assert.equal(csvCell('\t=1+1'), '·=1+1', 'TAB na frente vira "·" e deixa de ser fórmula');
    assert.equal(csvCell(`${RLO}=1+1`), '·=1+1');
  });
});

describe('apRecord e networkRecord', () => {
  test('apRecord resume um Ap do store', () => {
    assert.deepEqual(apRecord(storeAp()), {
      ssid: 'Casa',
      hidden: false,
      bssid: 'aa:bb:cc:00:11:22',
      vendor: 'TP-Link',
      vendorGuess: false,
      rssi: -57,
      quality: 85,
      band: '5',
      channel: 36,
      frequencyMHz: 5180,
      widthMHz: 80,
      standard: 'Wi-Fi 6',
      security: 'WPA2',
      securityLevel: 3,
      securityIssues: ['wps'],
      wps: true,
      distanceM: 6.3,
      connected: true,
      mine: true,
      ageS: 1,
      stations: 4,
      utilizationPct: 31,
    });
  });

  test('apRecord aguenta dado torto', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}]) {
      const rec = apRecord(bad);
      assert.equal(rec.ssid, '');
      assert.equal(rec.hidden, true);
      assert.equal(rec.rssi, null);
      assert.equal(rec.security, null);
      assert.deepEqual(rec.securityIssues, []);
      assert.equal(rec.connected, false);
    }
    const unknown = apRecord(storeAp({ security: { known: false, label: 'Desconhecida', level: 0, issues: [] }, rssi: null, quality: 0, gen: null, standard: 'Wi-Fi' }));
    assert.equal(unknown.security, null, 'segurança desconhecida não vira "Desconhecida" no arquivo');
    assert.equal(unknown.wps, null);
    assert.equal(unknown.quality, null, 'sem sinal não há qualidade');
    assert.equal(unknown.standard, null, 'sem geração conhecida não há padrão');
  });

  test('apRecord: "minha" é a favorita ou um rádio da casa', () => {
    assert.equal(apRecord(storeAp({ favorite: false, own: false })).mine, false);
    assert.equal(apRecord(storeAp({ favorite: true, own: false })).mine, true);
    assert.equal(apRecord(storeAp({ favorite: false, own: true })).mine, true);
  });

  test('networkRecord junta os rádios de uma rede', () => {
    const a = storeAp({ rssi: -70, channel: 6, band: '2.4', connected: false });
    const b = storeAp({ bssid: 'aa:bb:cc:00:11:23', rssi: -52, channel: 36, band: '5' });
    const rec = networkRecord({ ssid: 'Casa', hidden: false, security: a.security, aps: [a, b], bands: ['2.4', '5'] });
    assert.deepEqual(rec, { name: 'Casa', hidden: false, bands: ['2.4', '5'], channels: [6, 36], bestRssi: -52, security: 'WPA2', radios: 2, connected: true, mine: true });
    assert.equal(networkRecord(null).radios, 0);
    assert.equal(networkRecord({ ssid: '', aps: [] }).hidden, true);
  });
});

describe('CSV', () => {
  test('cabeçalho + uma linha por BSSID, com ";" e vírgula decimal', () => {
    const csv = buildCsv([storeAp(), storeAp({ bssid: 'aa:bb:cc:00:11:99', ssid: 'Vizinho', rssi: -80, connected: false, favorite: false, own: false, vendor: null })]);
    const lines = csv.split('\r\n');
    assert.equal(lines.length, 4, 'cabeçalho, duas redes e o fim de linha final');
    assert.equal(lines[3], '');
    assert.equal(lines[0].split(';').length, CSV_COLUMNS.length);
    assert.equal(lines[0].split(';')[0], 'Nome da rede (SSID)');
    assert.equal(lines[1], 'Casa;aa:bb:cc:00:11:22;TP-Link;-57;85;5;36;5180;80;Wi-Fi 6;WPA2;6,3;sim;sim;não;1;4;31');
    assert.equal(lines[2], 'Vizinho;aa:bb:cc:00:11:99;;-80;85;5;36;5180;80;Wi-Fi 6;WPA2;6,3;não;não;não;1;4;31');
    assert.equal(csv.startsWith(BOM), false);
  });

  test('opções: BOM para o Excel, separador e decimal', () => {
    assert.equal(buildCsv([storeAp()], { bom: true }).startsWith(BOM), true);
    const comma = buildCsv([storeAp()], { delimiter: ',', decimal: '.', eol: '\n' });
    assert.equal(comma.split('\n')[1], 'Casa,aa:bb:cc:00:11:22,TP-Link,-57,85,5,36,5180,80,Wi-Fi 6,WPA2,6.3,sim,sim,não,1,4,31');
    assert.equal(buildCsv([]).split('\r\n').length, 2, 'lista vazia: só o cabeçalho');
    assert.equal(buildCsv(null).split('\r\n').length, 2);
  });

  test('SSID que começa com = + - @ ganha apóstrofo (injeção de fórmula)', () => {
    const attacks = ['=cmd|\' /C calc\'!A0', '+SUM(1;2)', '-2+3', '@SUM(A1)', '=HYPERLINK("http://mal.example";"clique")'];
    const rows = parseCsv(buildCsv(attacks.map((ssid, i) => storeAp({ ssid, bssid: `aa:bb:cc:00:11:0${i}` }))));
    assert.equal(rows.length, attacks.length + 1);
    attacks.forEach((ssid, i) => {
      const cell = rows[i + 1][0];
      assert.equal(cell, `'${ssid}`, 'o valor volta com o apóstrofo na frente');
      assert.equal(/^[=+\-@]/.test(cell), false, 'nenhuma planilha vê fórmula aqui');
      assert.equal(rows[i + 1].length, CSV_COLUMNS.length, 'o separador dentro do nome não cria coluna');
    });
  });

  test('o fabricante também é texto de fora', () => {
    const rows = parseCsv(buildCsv([storeAp({ vendor: '=EVIL()', vendorGuess: true })]));
    assert.equal(rows[1][2], "'=EVIL() (provável)");
  });

  test('aspas, separadores e quebras de linha no nome não quebram o arquivo', () => {
    const names = ['a;b;c', 'diz "oi"', 'linha1\nlinha2', '<img src=x onerror=alert(1)>', ' com espaços ', 'vírgula, aqui', `dir${RLO}eita`, '🚀 Família'];
    const csv = buildCsv(names.map((ssid, i) => storeAp({ ssid, bssid: `aa:bb:cc:00:11:1${i}` })));
    const rows = parseCsv(csv);
    assert.equal(rows.length, names.length + 1, 'uma linha por rede');
    for (const row of rows) assert.equal(row.length, CSV_COLUMNS.length);
    assert.deepEqual(
      rows.slice(1).map((r) => r[0]),
      ['a;b;c', 'diz "oi"', 'linha1·linha2', '<img src=x onerror=alert(1)>', ' com espaços ', 'vírgula, aqui', 'dir·eita', '🚀 Família'],
    );
    assert.equal(csv.split('\r\n').length, names.length + 2, 'nenhuma quebra de linha a mais');
  });

  test('rede oculta e valores ausentes', () => {
    const rows = parseCsv(buildCsv([storeAp({ ssid: '', hidden: true, rssi: null, stations: null, utilization: null, distanceM: null, band: null, channel: null })]));
    assert.equal(rows[1][0], '(rede oculta)');
    assert.equal(rows[1][3], '', 'sem sinal: célula vazia');
    assert.equal(rows[1][5], '');
    assert.equal(rows[1][11], '');
    assert.equal(rows[1][14], 'sim');
    assert.equal(rows[1][16], '');
  });

  test('uma varredura de verdade (fixture do apartamento) vira um CSV íntegro', () => {
    const aps = normalizeScan(apartment, { now: TS });
    const rows = parseCsv(buildCsv(aps));
    assert.equal(rows.length, aps.length + 1);
    for (const row of rows) assert.equal(row.length, CSV_COLUMNS.length);
    const bssids = rows.slice(1).map((r) => r[1]);
    assert.deepEqual(bssids, aps.map((a) => a.bssid));
    for (const row of rows.slice(1)) {
      assert.match(row[3], /^-\d+$/, 'sinal como número inteiro');
      assert.match(row[5], /^(2,4|5|6)$/);
    }
  });
});

describe('JSON', () => {
  test('retrato completo, com valores crus', () => {
    const hostile = `=x"\n${RLO}<b>`;
    const text = buildJson({
      generatedAt: Date.UTC(2026, 10, 15, 17, 32, 5),
      appVersion: '1.0.0',
      device: { platform: 'android', manufacturer: 'motorola', model: 'moto g84', release: '14', sdk: 34 },
      connection: { connected: true, ssid: 'Casa', bssid: 'aa:bb:cc:00:11:22', rssi: -57, frequency: 5180, linkSpeed: 433, rxSpeed: 433, txSpeed: 390, ip: '192.168.0.23' },
      scannedAt: Date.UTC(2026, 10, 15, 17, 32, 0),
      aps: [storeAp(), storeAp({ ssid: hostile, bssid: 'aa:bb:cc:00:11:33' })],
    });
    assert.equal(text.endsWith('\n'), true);
    const data = JSON.parse(text);
    assert.equal(data.app, 'WiFi Raio-X');
    assert.equal(data.appVersion, '1.0.0');
    assert.equal(data.format, 1);
    assert.equal(data.generatedAt, '2026-11-15T17:32:05.000Z');
    assert.equal(data.scannedAt, '2026-11-15T17:32:00.000Z');
    assert.deepEqual(data.device, { platform: 'android', manufacturer: 'motorola', model: 'moto g84', android: '14' });
    assert.deepEqual(data.connection, { ssid: 'Casa', bssid: 'aa:bb:cc:00:11:22', rssi: -57, frequencyMHz: 5180, linkSpeedMbps: 433, rxSpeedMbps: 433, txSpeedMbps: 390 });
    assert.equal('ip' in data.connection, false, 'endereços IP não vão no arquivo');
    assert.equal(data.count, 2);
    assert.equal(data.networks[1].ssid, hostile, 'o nome vai exatamente como veio (o JSON já protege)');
    assert.equal(data.networks[0].rssi, -57);
  });

  test('sem conexão, sem aparelho, sem redes', () => {
    const data = JSON.parse(buildJson({ generatedAt: 0, connection: { connected: false }, aps: [] }));
    assert.equal(data.connection, null);
    assert.equal(data.device, null);
    assert.equal(data.scannedAt, null);
    assert.deepEqual(data.networks, []);
    assert.equal(data.generatedAt, '1970-01-01T00:00:00.000Z');
    assert.doesNotThrow(() => JSON.parse(buildJson(null)));
    assert.equal(JSON.parse(buildJson({ aps: [storeAp()] }, { indent: 0 })).count, 1);
  });

  test('a fixture do apartamento passa inteira', () => {
    const aps = normalizeScan(apartment, { now: TS });
    const data = JSON.parse(buildJson({ generatedAt: TS, aps }));
    assert.equal(data.networks.length, aps.length);
    for (const n of data.networks) {
      assert.match(n.bssid, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
      assert.equal(typeof n.hidden, 'boolean');
    }
  });
});

describe('relatório em texto', () => {
  const when = new Date(2026, 10, 15, 14, 32).getTime();
  const base = () => ({
    generatedAt: when,
    appVersion: '1.0.0',
    device: { platform: 'android', manufacturer: 'motorola', model: 'moto g84', release: '14' },
    dataAgeMs: 8000,
    connection: { ssid: 'Casa_5G', rssi: -52, band: '5', channel: 36, widthMHz: 80, linkSpeed: 433, standard: 'Wi-Fi 5 (802.11ac)', security: 'WPA2', distanceM: 4.2 },
    advice: { headline: 'Você já está na melhor opção', text: '“Casa_5G” em 5 GHz é a melhor das suas opções neste ponto.' },
    ranking: [
      { name: 'Casa_5G', hidden: false, score: 86.4, estMbps: 182, connected: true, mine: true },
      { name: 'Vizinho', hidden: false, score: 40, estMbps: 7.46, connected: false, mine: false },
    ],
    channels: [
      { band: '2.4', text: 'Seu roteador está no canal 6, que você divide com 7 redes. O canal 1 está mais livre.' },
      { band: '5', text: 'Pode deixar como está.' },
    ],
    insights: [{ severity: 'warning', title: 'Canal congestionado', text: 'Troque para o canal 1.' }],
    networks: [
      { name: 'Casa_5G', hidden: false, bands: ['2.4', '5'], channels: [6, 36], bestRssi: -52, security: 'WPA2', radios: 2, connected: true, mine: true },
      { name: '', hidden: true, bands: ['2.4'], channels: [11], bestRssi: -80, security: null, radios: 1, connected: false, mine: false },
    ],
    signals: 3,
  });

  test('todas as seções, em português simples', () => {
    const text = buildReport(base());
    const lines = text.split('\n');
    assert.equal(lines[0], 'WiFi Raio-X - relatório do Wi-Fi');
    assert.equal(lines[1], `${dateTimeText(when)} · motorola moto g84 (Android 14)`);
    assert.equal(dateTimeText(when), '15/11/2026 14:32');
    for (const title of ['Conexão', 'Melhor rede aqui', 'Melhor canal para o roteador', 'Diagnóstico', 'Redes ao redor (2 redes, 3 sinais)']) {
      const at = lines.indexOf(title);
      assert.ok(at > 0, `seção "${title}"`);
      assert.equal(lines[at + 1], '-'.repeat(title.length), 'sublinhado do tamanho do título');
      assert.equal(lines[at - 1], '', 'linha em branco antes da seção');
    }
    assert.ok(lines.includes('Rede: "Casa_5G" (5 GHz, canal 36, 80 MHz)'));
    assert.ok(lines.includes('Sinal: -52 dBm (ótimo)'));
    assert.ok(lines.includes('Velocidade até o roteador: 433 Mb/s'));
    assert.ok(lines.includes('Distância do roteador: cerca de 4 m (estimativa pelo sinal)'));
    assert.ok(lines.includes('Padrão: Wi-Fi 5 (802.11ac)'));
    assert.ok(lines.includes('Segurança: WPA2'));
    assert.ok(lines.includes('Você já está na melhor opção'));
    assert.ok(lines.includes('1. "Casa_5G": nota 86 de 100, cerca de 182 Mb/s (conectada, minha)'));
    assert.ok(lines.includes('2. "Vizinho": nota 40 de 100, cerca de 7,5 Mb/s'));
    assert.ok(lines.includes('2,4 GHz: Seu roteador está no canal 6, que você divide com 7 redes. O canal 1 está mais livre.'));
    assert.ok(lines.includes('5 GHz: Pode deixar como está.'));
    assert.ok(lines.includes('[Atenção] Canal congestionado'));
    assert.ok(lines.includes('  Troque para o canal 1.'));
    assert.ok(lines.includes(' 1. "Casa_5G" · -52 dBm (ótimo) · 2,4 GHz e 5 GHz canais 6, 36 · WPA2 · conectada, minha, 2 sinais'));
    assert.ok(lines.includes(' 2. (rede oculta) · -80 dBm (fraco) · 2,4 GHz canal 11'));
    assert.ok(text.includes('estimativas'), 'as estimativas são chamadas de estimativas');
    assert.ok(text.endsWith('Gerado no celular pelo WiFi Raio-X 1.0.0. Nada foi enviado para a internet.\n'));
    assert.equal(text.includes('Atenção: a lista de redes é de'), false, 'dado recente não ganha aviso de idade');
  });

  test('números do relatório: sem ",0" sobrando, Gb/s acima de mil', () => {
    const data = base();
    data.connection.linkSpeed = 1201;
    data.connection.distanceM = 1.04;
    data.ranking = [
      { name: 'A', hidden: false, score: 99.6, estMbps: 9.02, connected: false, mine: false },
      { name: 'B', hidden: false, score: 12.2, estMbps: 0.44, connected: false, mine: false },
      { name: 'C', hidden: false, score: 80, estMbps: 2000, connected: false, mine: false },
      { name: 'D', hidden: true, score: null, estMbps: null, connected: false, mine: false },
      { name: 'E', hidden: false, score: 5, estMbps: 0, connected: false, mine: false },
    ];
    const text = buildReport(data);
    assert.ok(text.includes('Velocidade até o roteador: 1,2 Gb/s'));
    assert.ok(text.includes('Distância do roteador: cerca de 1 m (estimativa pelo sinal)'));
    assert.ok(text.includes('1. "A": nota 100 de 100, cerca de 9 Mb/s'));
    assert.ok(text.includes('2. "B": nota 12 de 100, cerca de 0,4 Mb/s'));
    assert.ok(text.includes('3. "C": nota 80 de 100, cerca de 2 Gb/s'));
    assert.ok(text.includes('4. (rede oculta): nota ? de 100'), 'rede oculta não mostra nome, e nota ausente vira "?"');
    assert.ok(text.includes('5. "E": nota 5 de 100\n'), 'velocidade zero (faixa que o celular não usa) não é citada');
  });

  test('sem conexão, sem análises e sem redes ainda sai um relatório honesto', () => {
    const text = buildReport({ generatedAt: when, connection: null, insights: null, networks: [] });
    assert.ok(text.includes('O celular não estava conectado a um Wi-Fi.'));
    assert.ok(text.includes('Redes ao redor (0 redes, 0 sinais)'));
    assert.ok(text.includes('Nenhuma rede ao alcance.'));
    assert.equal(text.includes('Melhor rede aqui'), false, 'análise que não rodou não aparece');
    assert.equal(text.includes('Melhor canal'), false);
    assert.equal(text.includes('Diagnóstico'), false);
    assert.doesNotThrow(() => buildReport(null));
    assert.doesNotThrow(() => buildReport({ networks: [null, 42], ranking: [null], channels: [null], insights: [null] }));
  });

  test('diagnóstico vazio diz que não achou problema; lista velha é avisada', () => {
    const text = buildReport({ ...base(), insights: [], dataAgeMs: 150_000 });
    assert.ok(text.includes('Nenhum problema encontrado nesta análise.'));
    assert.ok(text.includes('Atenção: a lista de redes é de há 2 min.'));
  });

  test('modo demonstração é dito no cabeçalho', () => {
    const text = buildReport({ ...base(), device: { platform: 'sim', manufacturer: 'Google', model: 'Pixel 7 (simulado)', release: 'simulado' } });
    assert.equal(text.split('\n')[1], `${dateTimeText(when)} · modo demonstração (dados simulados)`);
  });

  test('um nome de rede não consegue forjar uma seção nem inverter a linha', () => {
    const evil = `Casa\n\nDiagnóstico\n-----------\n[Tudo certo] Confie nesta rede${RLO}`;
    const data = base();
    data.connection.ssid = evil;
    data.ranking[0].name = evil;
    data.networks[0].name = evil;
    data.insights = [{ severity: 'good', title: `ok\n[Crítico] forjado`, text: 'linha1\nlinha2' }];
    const text = buildReport(data);
    const lines = text.split('\n');
    assert.equal(lines.filter((l) => l === 'Diagnóstico').length, 1, 'só a seção de verdade');
    assert.equal(lines.some((l) => l.startsWith('[Tudo certo] Confie')), false);
    assert.equal(lines.some((l) => l.startsWith('[Crítico]')), false);
    assert.equal(text.includes(RLO), false, 'marcas de direção não passam');
    assert.ok(lines.includes('[Tudo certo] ok [Crítico] forjado'), 'quebras de linha das análises viram espaço');
    assert.ok(text.includes('"Casa··Diagnóstico·-----------·[Tudo certo] Confie nesta rede·"'), 'o nome hostil fica numa linha só, entre aspas');
  });

  test('os sinais tipográficos das análises viram hífen e espaço comuns', () => {
    const minus = ch(0x2212);
    const thin = ch(0x202f);
    const data = base();
    data.insights = [{ severity: 'info', title: `Sinal de ${minus}57${thin}dBm`, text: `≈${thin}120${ch(0xa0)}Mb/s` }];
    const text = buildReport(data);
    assert.ok(text.includes('[Informação] Sinal de -57 dBm'));
    assert.ok(text.includes('  ≈ 120 Mb/s'));
    assert.equal(text.includes(minus), false);
    assert.equal(text.includes(thin), false);
  });

  test('lista longa é cortada com a contagem do que ficou de fora', () => {
    const data = base();
    data.networks = Array.from({ length: 30 }, (_, i) => ({ name: `Rede ${i + 1}`, hidden: false, bands: ['2.4'], channels: [6], bestRssi: -50 - i, security: 'WPA2', radios: 1, connected: false, mine: false }));
    data.signals = 30;
    const text = buildReport(data);
    assert.ok(text.includes('25. "Rede 25"'));
    assert.equal(text.includes('"Rede 26"'), false);
    assert.ok(text.includes('... e mais 5 redes mais fracas.'));
    assert.ok(buildReport({ ...data, limit: 29 }).includes('... e mais 1 rede mais fraca.'));
  });

  test('a fixture do apartamento gera um relatório com todas as redes', () => {
    const aps = normalizeScan(apartment, { now: TS });
    const networks = groupBySsid(aps, { devices: groupByDevice(aps) }).map(networkRecord);
    const text = buildReport({ generatedAt: TS, networks, signals: aps.length, limit: 100 });
    assert.ok(text.includes(`Redes ao redor (${networks.length} redes, ${aps.length} sinais)`));
    for (const n of networks) if (!n.hidden) assert.ok(text.includes(`"${cleanText(n.name)}"`), `rede ${n.name}`);
  });
});

describe('arquivo e prévia', () => {
  test('fileName: nome seguro com data e hora locais', () => {
    const when = new Date(2026, 10, 5, 9, 7).getTime();
    assert.equal(fileName('redes', 'csv', when), 'wifi-raio-x-redes-20261105-0907.csv');
    assert.equal(fileName('Relatório Final', 'TXT', when), 'wifi-raio-x-relat-rio-final-20261105-0907.txt');
    assert.match(fileName('../../etc/passwd', 'j/s', when), /^wifi-raio-x-etc-passwd-\d{8}-\d{4}\.j-s$/);
    assert.match(fileName('redes', 'json'), /^wifi-raio-x-redes-\d{8}-\d{4}\.json$/);
  });

  test('utf8Length conta bytes como o arquivo', () => {
    for (const text of ['', 'abc', 'ação', '🚀', 'a🚀b', '“aspas”', `x${BOM}y`, 'é'.repeat(100)]) {
      assert.equal(utf8Length(text), Buffer.byteLength(text, 'utf8'), JSON.stringify(text));
    }
    assert.equal(utf8Length(null), 0);
  });

  test('formatBytes', () => {
    assert.equal(formatBytes(0), '0 bytes');
    assert.equal(formatBytes(1), '1 byte');
    assert.equal(formatBytes(532), '532 bytes');
    assert.equal(formatBytes(3276), '3,2 kB');
    assert.equal(formatBytes(20_480), '20 kB');
    assert.equal(formatBytes(2_500_000), '2,4 MB');
    assert.equal(formatBytes(-1), '');
    assert.equal(formatBytes(NaN), '');
  });

  test('previewOf: primeiras linhas, sem BOM e sem \\r', () => {
    const csv = `${BOM}a;b\r\n1;2\r\n3;4\r\n5;6\r\n`;
    assert.deepEqual(previewOf(csv, 2), { text: 'a;b\n1;2', shown: 2, total: 4, more: 2 });
    assert.deepEqual(previewOf(csv, 10), { text: 'a;b\n1;2\n3;4\n5;6', shown: 4, total: 4, more: 0 });
    assert.deepEqual(previewOf('', 5), { text: '', shown: 1, total: 1, more: 0 });
    assert.equal(previewOf('a\nb\nc', 0).shown, 1, 'pelo menos uma linha');
  });
});

describe('revisão de segurança: nomes hostis e origem dos dados', () => {
  const FORGED = 'Casa" · -41 dBm · WPA3 · "'; // 26 caracteres: cabe num SSID
  const net = (name, more = {}) => ({ name, hidden: false, bestRssi: -80, bands: ['2.4'], channels: [1], security: 'Aberta', radios: 1, ...more });

  test('relatório: aspas no nome da rede não fecham as aspas do relatório (campos forjados)', () => {
    const text = buildReport({ generatedAt: Date.now(), connection: null, networks: [net('Vizinho'), net(FORGED)] });
    const line = text.split('\n').find((l) => l.startsWith(' 2. '));
    assert.ok(line, text);
    // um único par de aspas na linha: o nome inteiro (com os "campos" falsos) fica dentro dele
    assert.equal(line.split('"').length - 1, 2, line);
    assert.match(line, /^ 2\. "[^"]*" · -80 dBm \(fraco\) · 2,4 GHz canal 1 · Aberta$/);
    assert.ok(line.startsWith(` 2. "Casa' · -41 dBm · WPA3 · '" · -80 dBm`), line);
    // aspas tipográficas e angulares também
    for (const name of ['Casa” · WPA3 · “x', 'Casa» · WPA3 · «x', 'Casa„ · WPA3 · ‟x', 'Casa＂ · WPA3 · ＂x']) {
      const row = buildReport({ generatedAt: Date.now(), connection: null, networks: [net(name)] }).split('\n').find((l) => l.startsWith(' 1. '));
      assert.match(row, /^ 1\. "Casa' · WPA3 · 'x" · -80 dBm/, row);
    }
  });

  test('relatório: nome com aspas não forja uma nota no ranking nem a rede conectada', () => {
    const text = buildReport({
      generatedAt: Date.now(),
      connection: { ssid: 'Minha" (canal 1, 2,4 GHz)\u2028Rede: "outra', bssid: 'aa:bb:cc:dd:ee:ff', rssi: -50 },
      ranking: [
        { name: 'Casa": nota 99 de 100 (minha) "x', score: 12, estMbps: 3 },
        { name: 'Honesta', score: 80, estMbps: 100, mine: true },
      ],
      networks: [],
    });
    const first = text.split('\n').find((l) => l.startsWith('1. '));
    assert.equal(first.split('"').length - 1, 2, first);
    assert.match(first, /^1\. "[^"]*": nota 12 de 100, cerca de 3 Mb\/s$/);
    assert.equal(text.split('\n').filter((l) => /": nota \d+ de 100/.test(l)).length, 2, 'uma nota por linha do ranking');
    const conn = text.split('\n').find((l) => l.startsWith('Rede: '));
    assert.equal(conn.split('"').length - 1, 2, conn);
    assert.equal(text.split('\n').filter((l) => l.startsWith('Rede: ')).length, 1);
  });

  test('relatório: nomes comuns saem como sempre (apóstrofo, acento e ponto do meio ficam)', () => {
    const text = buildReport({ generatedAt: Date.now(), connection: null, networks: [net("Casa d'Ávila · 5G"), net('Família Souza')] });
    assert.ok(text.includes(` 1. "Casa d'Ávila · 5G" · -80 dBm`));
    assert.ok(text.includes(' 2. "Família Souza" · -80 dBm'));
    // cleanText em si não muda (a planilha e o JSON têm a própria proteção)
    assert.equal(cleanText('a "b" c'), 'a "b" c');
  });

  test('exportFileName: o que sai da demonstração leva "demonstracao" no nome', async () => {
    const { exportFileName } = await import('../app/js/ui/tools/export-format.js');
    const when = new Date(2026, 10, 5, 9, 7).getTime();
    assert.equal(exportFileName('redes', 'csv', { when }), 'wifi-raio-x-redes-20261105-0907.csv');
    assert.equal(exportFileName('redes', 'csv', { demo: false, when }), fileName('redes', 'csv', when));
    assert.equal(exportFileName('redes', 'csv', { demo: true, when }), 'wifi-raio-x-redes-demonstracao-20261105-0907.csv');
    assert.equal(exportFileName('redes', 'json', { demo: true, when }), 'wifi-raio-x-redes-demonstracao-20261105-0907.json');
    assert.equal(exportFileName('relatorio', 'txt', { demo: true, when }), 'wifi-raio-x-relatorio-demonstracao-20261105-0907.txt');
    assert.match(exportFileName('redes', 'csv', { demo: true }), /^wifi-raio-x-redes-demonstracao-\d{8}-\d{4}\.csv$/);
  });
});
