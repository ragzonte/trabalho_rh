import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OUI_FORMAT,
  NAME_SEPARATOR,
  encodeVlq,
  normalizeMac,
  isLocallyAdministered,
  isRandomized,
  createOuiLookup,
  loadOui,
} from '../app/js/core/oui.js';
import { MAX_NAME_LENGTH, cleanName, buildOui } from '../tools/build-oui.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = join(ROOT, 'app/assets/oui.json');
const BUILDER = join(ROOT, 'tools/build-oui.mjs');

/** Limite combinado para o arquivo dentro do APK (antes da compressão do próprio APK). */
const SIZE_BUDGET_BYTES = 700_000;

const assetText = readFileSync(ASSET, 'utf8');
const asset = JSON.parse(assetText);
const real = createOuiLookup(asset);

const exact = (name) => ({ name, randomized: false, guess: false });
const guessed = (name) => ({ name, randomized: false, guess: true });
const RANDOMIZED = { name: null, randomized: true, guess: false };

// Cadastro de mentira, pequeno o bastante para conferir cada regra à mão.
const REGISTRY = {
  '001122': 'ACME ROUTERS CO.,LTD\nRua Um, 1\nSao Paulo\nBrazil',
  '0011aa': 'Acme Routers Co., Ltd.\nRua Um, 1\nSao Paulo\nBrazil', // chave minúscula e nome repetido
  A0B1C2: 'IEEE Registration Authority\n445 Hoes Lane\nPiscataway NJ 08554\nUnited States', // repartido abaixo
  A0B1C2D: 'Beta Networks Inc.\nSomewhere', // 28 bits
  A0B1C2E: 'Delta Systems LLC\nSomewhere', // 28 bits...
  A0B1C2E00: 'Gamma Labs GmbH\nIrgendwo', // ...com um bloco de 36 bits dentro
  '00AA00': 'Private',
  '02AB01': 'Legacy Local Corp\nOldtown', // cadastro antigo, com o bit "local" ligado
  FCFFFF: 'Omega Telecom S.A.\nLonge',
  FCFFFFFFF: 'Omega Sub Unit\nLonge', // 36 bits perto do valor máximo
  ZZ1234: 'Chave que não é hexadecimal',
  12345: 'Chave de tamanho errado',
};
const built = buildOui(REGISTRY, 'teste');
const fake = createOuiLookup(JSON.parse(built.json));

describe('normalizeMac', () => {
  test('aceita os jeitos comuns de escrever um MAC', () => {
    for (const mac of [
      'aa:bb:cc:dd:ee:ff',
      'AA:BB:CC:DD:EE:FF',
      'AA-BB-CC-DD-EE-FF',
      'aabbccddeeff',
      'AABBCCDDEEFF',
      'aabb.ccdd.eeff',
      'AA BB CC DD EE FF',
      '  aa:bb:cc:dd:ee:ff\n',
    ]) {
      assert.equal(normalizeMac(mac), 'aabbccddeeff', mac);
    }
  });

  test('repõe o zero que alguns sistemas cortam de cada octeto', () => {
    assert.equal(normalizeMac('0:1e:8f:a:b:c'), '001e8f0a0b0c');
  });

  test('aceita só o começo do endereço', () => {
    assert.equal(normalizeMac('AA:BB:CC'), 'aabbcc');
    assert.equal(normalizeMac('aabbcc'), 'aabbcc');
    assert.equal(normalizeMac('AABBCCD'), 'aabbccd');
    assert.equal(normalizeMac('aa-bb-cc-dd'), 'aabbccdd');
  });

  test('qualquer outra coisa vira null, sem exceção', () => {
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      'xyz',
      'aa:bb',
      'aabbc',
      'zz:zz:zz:zz:zz:zz',
      'aa:bb:cc:dd:ee:fg',
      'aa:bb:cc:dd:ee:ff:00',
      'aa:bb:cc:dd:ee:ff:00:11',
      'aabbccddeeff0',
      'aa::bb:cc:dd:ee',
      'aabb.ccdd',
      'fe80::aabb:ccdd', // IPv6 não é MAC
      '192.168.0.1',
      42,
      0xaabbccddeeff,
      NaN,
      true,
      {},
      [],
      ['aa:bb:cc:dd:ee:ff'],
      Symbol('mac'),
      () => 'aa:bb:cc:dd:ee:ff',
    ]) {
      assert.equal(normalizeMac(bad), null, String(bad));
    }
  });
});

describe('bit "administrado localmente"', () => {
  test('é o 0x02 do primeiro octeto', () => {
    assert.equal(isLocallyAdministered('02:00:00:00:00:01'), true);
    assert.equal(isLocallyAdministered('da:a1:19:00:00:01'), true);
    assert.equal(isLocallyAdministered('16-75-90-AA-BB-CC'), true);
    assert.equal(isLocallyAdministered('14:75:90:aa:bb:cc'), false);
    assert.equal(isLocallyAdministered('01:00:5e:00:00:01'), false); // só o bit de grupo
    assert.equal(isLocallyAdministered('nada'), false);
    assert.equal(isLocallyAdministered(null), false);
  });

  test('isRandomized sem tabela olha só os bits (local ligado, grupo desligado)', () => {
    assert.equal(isRandomized('da:a1:19:00:00:01'), true);
    assert.equal(isRandomized('16:75:90:aa:bb:cc'), true);
    assert.equal(isRandomized('14:75:90:aa:bb:cc'), false);
    assert.equal(isRandomized('33:33:00:00:00:01'), false); // multicast IPv6: local + grupo
    assert.equal(isRandomized('02:00:00:00:00:00'), false); // endereço falso do Android
    assert.equal(isRandomized(''), false);
    assert.equal(isRandomized(undefined), false);
  });
});

describe('createOuiLookup (cadastro de teste)', () => {
  test('prefixo de 24 bits, em qualquer formato', () => {
    assert.deepEqual(fake.vendor('00:11:22:33:44:55'), exact('Acme Routers'));
    assert.deepEqual(fake.vendor('00-11-AA-33-44-55'), exact('Acme Routers'));
    assert.deepEqual(fake.vendor('0011.2233.4455'), exact('Acme Routers'));
    assert.deepEqual(fake.vendor('001122334455'), exact('Acme Routers'));
    assert.deepEqual(fake.vendor('0:11:22:3:4:5'), exact('Acme Routers'));
    assert.deepEqual(fake.vendor('fc:ff:ff:00:00:00'), exact('Omega Telecom'));
  });

  test('o bloco mais específico vence: 36 bits, depois 28, depois 24', () => {
    assert.deepEqual(fake.vendor('a0:b1:c2:d1:23:45'), exact('Beta Networks'));
    assert.deepEqual(fake.vendor('a0:b1:c2:e0:01:23'), exact('Gamma Labs'));
    assert.deepEqual(fake.vendor('a0:b1:c2:e1:00:00'), exact('Delta Systems'));
    assert.deepEqual(fake.vendor('a0:b1:c2:e0:10:00'), exact('Delta Systems')); // fora do bloco de 36 bits
    assert.deepEqual(fake.vendor('fc:ff:ff:ff:f0:00'), exact('Omega Sub Unit'));
    assert.deepEqual(fake.vendor('fc:ff:ff:ff:e0:00'), exact('Omega Telecom'));
  });

  test('bloco repartido pela IEEE sem dono no pedaço: desconhecido', () => {
    assert.equal(fake.vendor('a0:b1:c2:00:00:01'), null);
    assert.equal(fake.vendor('00:aa:00:00:00:01'), null); // "Private" não entra na tabela
  });

  test('bit "local" ligado e prefixo desconhecido: tenta de novo com o bit desligado', () => {
    assert.deepEqual(fake.vendor('02:11:22:33:44:55'), guessed('Acme Routers'));
    assert.deepEqual(fake.vendor('a2:b1:c2:d1:23:45'), guessed('Beta Networks'));
    assert.deepEqual(fake.vendor('a2:b1:c2:e0:01:23'), guessed('Gamma Labs'));
    assert.deepEqual(fake.vendor('FE-FF-FF-00-00-00'), guessed('Omega Telecom'));
  });

  test('prefixo cadastrado com o bit "local" é resposta exata, não palpite', () => {
    assert.deepEqual(fake.vendor('02:ab:01:00:00:01'), exact('Legacy Local'));
  });

  test('bit "local" ligado e nada encontrado: endereço aleatório', () => {
    assert.deepEqual(fake.vendor('0a:00:00:00:00:01'), RANDOMIZED);
    assert.deepEqual(fake.vendor('da:a1:19:12:34:56'), RANDOMIZED);
    assert.equal(fake.isRandomized('da:a1:19:12:34:56'), true);
    assert.equal(isRandomized('da:a1:19:12:34:56', fake), true);
    // Com a tabela, o BSSID virtual de um roteador conhecido deixa de contar como aleatório.
    assert.equal(fake.isRandomized('02:11:22:33:44:55'), false);
    assert.equal(isRandomized('02:11:22:33:44:55', fake), false);
    assert.equal(fake.isRandomized('00:11:22:33:44:55'), false);
  });

  test('prefixo de fábrica desconhecido é só desconhecido', () => {
    assert.equal(fake.vendor('08:00:00:00:00:01'), null);
    assert.equal(fake.isRandomized('08:00:00:00:00:01'), false);
  });

  test('endereços de grupo e os endereços falsos do Android não têm fabricante', () => {
    assert.equal(fake.vendor('01:11:22:33:44:55'), null);
    assert.equal(fake.vendor('03:11:22:33:44:55'), null); // local + grupo: nem palpite, nem aleatório
    assert.equal(fake.isRandomized('03:11:22:33:44:55'), false);
    for (const mac of ['00:00:00:00:00:00', '02:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff']) {
      assert.equal(fake.vendor(mac), null, mac);
      assert.equal(fake.isRandomized(mac), false, mac);
    }
  });

  test('só o começo do endereço já resolve o que der', () => {
    assert.deepEqual(fake.vendor('00:11:22'), exact('Acme Routers'));
    assert.deepEqual(fake.vendor('A0B1C2D'), exact('Beta Networks'));
    assert.deepEqual(fake.vendor('A0B1C2E00'), exact('Gamma Labs'));
    assert.equal(fake.vendor('A0:B1:C2'), null); // faltam dígitos para saber de quem é o pedaço
  });

  test('entrada malformada devolve null', () => {
    for (const bad of [null, undefined, '', 'xyz', 'aa:bb', '00:11:22:33:44:5g', '00:11:22:33:44:55:66', 42, {}, [], NaN]) {
      assert.equal(fake.vendor(bad), null, String(bad));
      assert.equal(fake.isRandomized(bad), false, String(bad));
      assert.equal(fake.label(bad), 'Desconhecido', String(bad));
    }
  });

  test('label entrega o texto pronto para a tela', () => {
    assert.equal(fake.label('00:11:22:33:44:55'), 'Acme Routers');
    assert.equal(fake.label('02:11:22:33:44:55'), 'Acme Routers (provável)');
    assert.equal(fake.label('da:a1:19:12:34:56'), 'MAC aleatório ou virtual');
    assert.equal(fake.label('08:00:00:00:00:01'), 'Desconhecido');
  });

  test('expõe tamanho, origem e estado', () => {
    assert.equal(fake.loaded, true);
    assert.equal(fake.size, 8);
    assert.equal(fake.source, 'teste');
    assert.equal(fake.error, null);
  });

  test('aceita o arquivo ainda como texto', () => {
    assert.deepEqual(createOuiLookup(built.json).vendor('00:11:22:33:44:55'), exact('Acme Routers'));
  });

  test('tabela ausente ou corrompida vira consulta vazia, sem exceção', () => {
    const good = JSON.parse(built.json);
    const broken = [
      null,
      undefined,
      42,
      'isto não é JSON',
      [],
      {},
      { ...good, format: OUI_FORMAT + 1 },
      { ...good, names: null },
      { ...good, shared: -1 },
      { ...good, shared: 1e9 },
      { ...good, maL: undefined },
      { ...good, maL: '!!!' }, // caractere fora do alfabeto
      { ...good, maL: good.maL + 'A' }, // sobrou meio par
      { ...good, maL: good.maL.slice(0, -1) + 'g' }, // número cortado no fim
      { ...good, maM: encodeVlq(5) + encodeVlq(999) }, // referência a um nome que não existe
      { ...good, names: 'um' }, // nomes de menos para as referências
      { ...good, maS: 'é' },
    ];
    for (const data of broken) {
      const lookup = createOuiLookup(data);
      assert.equal(lookup.loaded, false);
      assert.equal(lookup.size, 0);
      assert.equal(lookup.source, '');
      assert.equal(lookup.vendor('00:11:22:33:44:55'), null);
      assert.equal(lookup.vendor('lixo'), null);
      // Sem tabela sobra só o bit "local".
      assert.deepEqual(lookup.vendor('02:11:22:33:44:55'), RANDOMIZED);
      assert.equal(lookup.label('00:11:22:33:44:55'), 'Desconhecido');
    }
  });
});

describe('formato compacto', () => {
  test('encodeVlq: dígitos de 5 bits, menos significativo primeiro, +32 = continua', () => {
    assert.equal(encodeVlq(0), 'A');
    assert.equal(encodeVlq(1), 'B');
    assert.equal(encodeVlq(31), 'f');
    assert.equal(encodeVlq(32), 'gB');
    assert.equal(encodeVlq(1023), '_f');
    assert.equal(encodeVlq(1024), 'ggB');
    assert.equal(encodeVlq(2 ** 36 - 1).length, 8); // 36 bits = 8 dígitos (os prefixos de 36 bits passam de 2^32)
    for (const junk of [-1, NaN, Infinity, undefined, null, 'x']) assert.equal(encodeVlq(junk), 'A');
  });

  test('o gerador escreve os campos que o leitor espera', () => {
    const data = JSON.parse(built.json);
    assert.deepEqual(Object.keys(data), ['format', 'source', 'prefixes', 'shared', 'names', 'maL', 'maM', 'maS']);
    assert.equal(data.format, OUI_FORMAT);
    assert.equal(data.prefixes, 8);
    assert.equal(data.shared, 1);
    // Tabela de nomes: o repetido primeiro (uma vez só), depois os de uso único na ordem dos prefixos.
    assert.deepEqual(data.names.split(NAME_SEPARATOR), [
      'Acme Routers',
      'Legacy Local',
      'Omega Telecom',
      'Beta Networks',
      'Delta Systems',
      'Gamma Labs',
      'Omega Sub Unit',
    ]);
    assert.ok(built.json.endsWith('\n'));
    assert.deepEqual(built.stats.perTier, { maL: 4, maM: 2, maS: 2 });
    assert.equal(built.stats.dropped, 2);
    assert.equal(built.stats.bytes, Buffer.byteLength(built.json));
  });

  test('gerador determinístico: mesma entrada, mesmos bytes, em qualquer ordem das chaves', () => {
    assert.equal(buildOui(REGISTRY, 'teste').json, built.json);
    const reversed = Object.fromEntries(Object.entries(REGISTRY).reverse());
    assert.equal(buildOui(reversed, 'teste').json, built.json);
  });

  test('gerador não quebra com cadastro vazio ou torto', () => {
    for (const registry of [{}, null, undefined, [], 'texto', { '001122': null }, { '001122': '' }, { '001122': '\n\n' }]) {
      const { json, stats } = buildOui(registry, 'vazio');
      assert.equal(stats.prefixes, 0);
      const lookup = createOuiLookup(JSON.parse(json));
      assert.equal(lookup.loaded, true);
      assert.equal(lookup.size, 0);
      assert.equal(lookup.vendor('00:11:22:33:44:55'), null);
    }
    // Valor que não é texto vira texto; o importante é não quebrar.
    const odd = createOuiLookup(buildOui({ '001122': 42, '0011AA': { toString: () => 'Objeto Ltda' } }, 'torto').json);
    assert.deepEqual(odd.vendor('00:11:22:33:44:55'), exact('42'));
    assert.deepEqual(odd.vendor('00:11:aa:33:44:55'), exact('Objeto'));
  });
});

describe('cleanName', () => {
  test('marcas conhecidas saem como as pessoas conhecem', () => {
    const cases = {
      'TP-LINK TECHNOLOGIES CO.,LTD.': 'TP-Link',
      'TP-Link Systems Inc.': 'TP-Link',
      Intelbras: 'Intelbras',
      'Multilaser Industrial S.A.': 'Multilaser',
      'D-Link International': 'D-Link',
      'MERCUSYS TECHNOLOGIES CO., LTD.': 'Mercusys',
      'SHEN ZHEN TENDA TECHNOLOGY CO.,LTD': 'Tenda',
      'Routerboard.com': 'MikroTik',
      'Ubiquiti Inc': 'Ubiquiti',
      'HUAWEI TECHNOLOGIES CO.,LTD': 'Huawei',
      'Huawei Device Co., Ltd.': 'Huawei',
      'zte corporation': 'ZTE',
      'Xiaomi Communications Co Ltd': 'Xiaomi',
      'Beijing Xiaomi Mobile Software Co., Ltd': 'Xiaomi',
      'Samsung Electronics Co.,Ltd': 'Samsung',
      'Apple, Inc.': 'Apple',
      'Google, Inc.': 'Google',
      'Cisco Systems, Inc': 'Cisco',
      'Cisco-Linksys, LLC': 'Linksys',
      'ASUSTek COMPUTER INC.': 'Asus',
      NETGEAR: 'Netgear',
      Commscope: 'Arris (CommScope)',
      'Vantiva USA LLC': 'Technicolor (Vantiva)',
      'Sagemcom Broadband SAS': 'Sagemcom',
      'Nokia Solutions and Networks GmbH & Co. KG': 'Nokia',
      'Fiberhome Telecommunication Technologies Co.,LTD': 'FiberHome',
      'ASKEY COMPUTER CORP': 'Askey',
      'MitraStar Technology Corp.': 'MitraStar',
      'Motorola Mobility LLC, a Lenovo Company': 'Motorola',
      'Hewlett Packard Enterprise': 'HPE / Aruba',
      'Ruckus Wireless': 'Ruckus',
      'Amazon Technologies Inc.': 'Amazon',
      'Espressif Inc.': 'Espressif',
      'REALTEK SEMICONDUCTOR CORP.': 'Realtek',
      'Intel Corporate': 'Intel',
      'Qualcomm Inc.': 'Qualcomm',
      'Broadcom Limited': 'Broadcom',
      'MediaTek Inc': 'MediaTek',
      'GUANGDONG OPPO MOBILE TELECOMMUNICATIONS CORP.,LTD': 'OPPO',
      'Hon Hai Precision Ind. Co.,Ltd.': 'Foxconn',
    };
    for (const [raw, clean] of Object.entries(cases)) assert.equal(cleanName(raw), clean, raw);
  });

  test('nome parecido não é a mesma marca', () => {
    assert.equal(cleanName('Harris Corporation'), 'Harris'); // não é Arris
    assert.equal(cleanName('Hangzhou BroadLink Technology Co.,Ltd'), 'Hangzhou BroadLink'); // não é D-Link
    assert.equal(cleanName('Intellon Corporation'), 'Intellon'); // não é Intel
    assert.equal(cleanName('Applied Micro Circuits Corp.'), 'Applied Micro Circuits'); // não é Apple
    assert.equal(cleanName('CommScope Inc'), 'CommScope'); // este nunca foi Arris
  });

  test('tira formas jurídicas, filiais e descrições', () => {
    const cases = {
      'Nipron Co.,Ltd': 'Nipron',
      'Autonics Co., Ltd.': 'Autonics',
      'Rigado, LLC': 'Rigado',
      'Securosys SA': 'Securosys',
      'Alban Giacomo S.p.a.': 'Alban Giacomo',
      'eks Engel GmbH & Co. KG': 'eks Engel',
      'Bender GmbH &amp; Co.KG': 'Bender',
      'Dynacon Sp. z o.o.': 'Dynacon',
      'RACOM, s.r.o.': 'Racom',
      'Luminous Power Technologies Pvt. Ltd.': 'Luminous Power',
      'Zebra Technologies Inc.': 'Zebra',
      'Conlog (Pty) Ltd': 'Conlog',
      'OnePlus Technology (Shenzhen) Co., Ltd': 'OnePlus',
      'Samsung Electronics Co., Ltd., Memory Division': 'Samsung',
      'The Sapling Company': 'Sapling',
      'Positivo Tecnologia S.A.': 'Positivo',
      'Parks S/A Comunicacoes Digitais': 'Parks',
      'Cianet Industria e Comercio S/A': 'Cianet',
      'TELLESCOM INDUSTRIA E COMERCIO EM TELECOMUNICACAO': 'Tellescom',
      'Stara S/A Indústria de Implementos Agrícolas': 'Stara',
      'Multitek Elektronik Sanayi ve Ticaret A.S.': 'Multitek Elektronik',
      'Beijing DoSee Science and Technology Co., Ltd.': 'Beijing DoSee',
      'INVENTORY CONVERSION, INC./': 'Inventory Conversion',
      'BUFFALO.INC': 'Buffalo',
      'R&amp;M AG': 'R&M',
    };
    for (const [raw, clean] of Object.entries(cases)) assert.equal(cleanName(raw), clean, raw);
  });

  test('não limpa a ponto de o nome deixar de dizer alguma coisa', () => {
    assert.equal(cleanName('Texas Instruments'), 'Texas Instruments');
    assert.equal(cleanName('Digital Technology Inc.'), 'Digital Technology');
    assert.equal(cleanName('PLX Technology'), 'PLX Technology');
    assert.equal(cleanName('Dublin Institute of Technology'), 'Dublin Institute of Technology');
    assert.equal(cleanName('LG Innotek'), 'LG Innotek');
    assert.equal(cleanName('3M COMPANY'), '3M');
    assert.equal(cleanName('Q (Cue), Inc.'), 'Q (Cue), Inc'); // "Q" sozinho não diria nada
  });

  test('conserta nome GRITADO sem estragar siglas', () => {
    assert.equal(cleanName('SHENZHEN BILIAN ELECTRONIC CO.，LTD'), 'Shenzhen Bilian Electronic');
    assert.equal(cleanName('GSD VIET NAM TECHNOLOGY COMPANY LIMITED'), 'GSD Viet Nam');
    assert.equal(cleanName('NEC CORPORATION'), 'NEC');
    assert.equal(cleanName('HMD Global Oy'), 'HMD Global');
    assert.equal(cleanName('SKY UK LIMITED'), 'SKY UK');
    assert.equal(cleanName('PSL ELEKTRONİK SANAYİ VE TİCARET A.S.'), 'PSL Elektronik');
    assert.equal(cleanName('GREATEK'), 'Greatek');
    assert.equal(cleanName('FILIZOLA S.A. PESAGEM E AUTOMACAO'), 'Filizola');
    // Nome com maiúsculas e minúsculas misturadas fica como o fabricante escreveu.
    assert.equal(cleanName('Shenzhen YOUHUA Technology Co., Ltd'), 'Shenzhen YOUHUA');
    assert.equal(cleanName('alt digital s.r.o.'), 'Alt Digital');
    assert.equal(cleanName('ecobee inc'), 'ecobee');
  });

  test('registros que não identificam fabricante saem vazios', () => {
    for (const raw of ['Private', 'private', 'IEEE Registration Authority', '', '   ', null, undefined]) {
      assert.equal(cleanName(raw), '', String(raw));
    }
  });

  test('corta nomes longos em fronteira de palavra', () => {
    const long = cleanName('Beijing National Railway Research & Design Institute of Signal & Communication');
    assert.equal(long, 'Beijing National Railway');
    assert.ok(cleanName('A'.repeat(80)).length <= MAX_NAME_LENGTH);
    assert.equal(cleanName('Helmholtz Centre Berlin for Material and Energy'), 'Helmholtz Centre Berlin');
  });

  test('nunca devolve o separador da tabela nem quebra com lixo', () => {
    assert.equal(cleanName(`Foo${NAME_SEPARATOR}Bar Networks, Inc.`), 'Foo Bar Networks');
    for (const junk of [42, {}, [], NaN, '|||', '()', '.,;', '\u0000\u0001', 'x'.repeat(5000)]) {
      const out = cleanName(junk);
      assert.equal(typeof out, 'string');
      assert.ok(!out.includes(NAME_SEPARATOR));
      assert.ok(out.length <= MAX_NAME_LENGTH);
    }
  });
});

describe('app/assets/oui.json', () => {
  test('cabe no orçamento de tamanho', () => {
    const { size } = statSync(ASSET);
    assert.ok(size < SIZE_BUDGET_BYTES, `oui.json tem ${size} bytes; o limite é ${SIZE_BUDGET_BYTES}`);
    assert.ok(size > 100_000, 'arquivo pequeno demais para ser a tabela inteira');
  });

  test('carrega inteiro e declara o que contém', () => {
    assert.equal(asset.format, OUI_FORMAT);
    assert.match(asset.source, /oui-data@\d+\.\d+\.\d+/);
    assert.equal(real.loaded, true);
    assert.equal(real.size, asset.prefixes);
    assert.ok(real.size > 50_000, `só ${real.size} prefixos`);
  });

  test('tabela de nomes sem repetição e com nomes apresentáveis', () => {
    const names = asset.names.split(NAME_SEPARATOR);
    assert.equal(new Set(names).size, names.length, 'há nomes repetidos na tabela');
    assert.ok(names.length < asset.prefixes);
    for (const name of names) {
      assert.ok(name.length >= 2 && name.length <= MAX_NAME_LENGTH, `tamanho ruim: "${name}"`);
      assert.equal(name, name.trim().replace(/\s+/g, ' '), `espaços sobrando: "${name}"`);
      assert.doesNotMatch(name, /[\u0000-\u001f\u007f"]/, `caractere de controle ou aspas: "${name}"`);
      assert.doesNotMatch(name, /[\s,;:&+/-]$/, `pontuação pendurada: "${name}"`);
    }
    // Nome todo em maiúsculas só passa se for sigla ou marca que se escreve assim.
    const shouting = names.filter((name) => {
      const letters = name.replace(/[^\p{L}]/gu, '');
      const longWord = name.split(/[^\p{L}\p{N}]+/u).some((w) => w.length >= 5 && /[AEIOU]/.test(w) && !/\d/.test(w));
      return letters && letters === letters.toUpperCase() && letters !== letters.toLowerCase() && longWord;
    });
    assert.deepEqual(shouting.sort(), ['EZVIZ', 'NVIDIA']);
  });

  test('prefixos reais resolvem para a marca limpa', () => {
    // Prefixos conferidos no cadastro da IEEE (oui-data); os formatos variam de propósito.
    const cases = [
      ['80:85:44:12:34:56', 'Intelbras'],
      ['14:75:90:12:34:56', 'TP-Link'],
      ['18-69-45-AB-CD-EF', 'TP-Link'],
      ['74:58:89:00:00:01', 'Multilaser'],
      ['802689abcdef', 'D-Link'],
      ['3408.04ab.cdef', 'D-Link'],
      ['00:eb:d8:01:02:03', 'Mercusys'],
      ['04:95:E6:01:02:03', 'Tenda'],
      ['c8:3a:35:01:02:03', 'Tenda'],
      ['00:0c:42:01:02:03', 'MikroTik'],
      ['60:22:32:01:02:03', 'Ubiquiti'],
      ['10:01:77:01:02:03', 'Huawei'],
      ['10:10:81:01:02:03', 'ZTE'],
      ['18:59:36:01:02:03', 'Xiaomi'],
      ['10:30:47:01:02:03', 'Samsung'],
      ['10:00:20:01:02:03', 'Apple'],
      ['20:33:89:01:02:03', 'Google'],
      ['10:57:25:01:02:03', 'Cisco'],
      ['58:11:22:01:02:03', 'Asus'],
      ['28:80:88:01:02:03', 'Netgear'],
      ['10:56:11:01:02:03', 'Arris (CommScope)'],
      ['48:00:33:01:02:03', 'Technicolor (Vantiva)'],
      ['10:06:45:01:02:03', 'Sagemcom'],
      ['10:98:26:01:02:03', 'Nokia'],
      ['10:58:87:01:02:03', 'FiberHome'],
      ['38:88:71:01:02:03', 'Askey'],
      ['34:57:60:01:02:03', 'MitraStar'],
      ['14:05:89:01:02:03', 'Motorola'],
      ['00:0c:41:01:02:03', 'Linksys'],
      ['20:58:69:01:02:03', 'Ruckus'],
      ['14:76:49:01:02:03', 'HPE / Aruba'],
      ['10:96:93:01:02:03', 'Amazon'],
      ['14:08:08:01:02:03', 'Espressif'],
      ['00:e0:4c:01:02:03', 'Realtek'],
      ['10:51:07:01:02:03', 'Intel'],
      ['00:a0:c6:01:02:03', 'Qualcomm'],
      ['00:62:0b:01:02:03', 'Broadcom'],
      ['00:0a:00:01:02:03', 'MediaTek'],
      ['00:9e:ee:01:02:03', 'Positivo'],
      ['e8:71:8d:01:02:03', 'Elsys'],
      ['f8:7f:a5:01:02:03', 'Greatek'],
      ['10:41:21:01:02:03', 'Tellescom'],
    ];
    for (const [mac, name] of cases) assert.deepEqual(real.vendor(mac), exact(name), mac);
  });

  test('blocos pequenos (28 e 36 bits) também resolvem', () => {
    assert.deepEqual(real.vendor('90:f4:21:a1:02:03'), exact('Proqualit Telecom')); // MA-M 90F421A
    assert.deepEqual(real.vendor('70:b3:d5:0a:c1:02'), exact('RoboCore')); // MA-S 70B3D50AC
  });

  test('BSSID virtual (bit "local" ligado no MAC de fábrica) vira palpite do fabricante', () => {
    assert.deepEqual(real.vendor('16:75:90:12:34:56'), guessed('TP-Link')); // 14:75:90
    assert.deepEqual(real.vendor('82:85:44:12:34:56'), guessed('Intelbras')); // 80:85:44
    assert.deepEqual(real.vendor('F2-9F-C2-12-34-56'), guessed('Ubiquiti')); // F0:9F:C2
    assert.equal(real.isRandomized('16:75:90:12:34:56'), false);
    assert.equal(real.label('16:75:90:12:34:56'), 'TP-Link (provável)');
  });

  test('os poucos prefixos antigos cadastrados com o bit "local" são resposta exata', () => {
    assert.deepEqual(real.vendor('02:60:8c:01:02:03'), exact('3Com'));
    assert.deepEqual(real.vendor('aa:00:03:01:02:03'), exact('Digital Equipment'));
  });

  test('entrada malformada e endereços falsos devolvem null', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'any',
      'aa:bb',
      'gg:hh:ii:jj:kk:ll',
      '14:75:90:12:34:56:78',
      42,
      {},
      '00:00:00:00:00:00',
      '02:00:00:00:00:00',
      'ff:ff:ff:ff:ff:ff',
      '01:00:5e:00:00:fb',
      '33:33:00:00:00:01',
    ]) {
      assert.equal(real.vendor(bad), null, String(bad));
    }
  });

  test('consulta rápida o bastante para rodar a cada varredura', () => {
    const macs = [];
    for (let i = 0; i < 2000; i++) {
      const hex = ((i * 2654435761) % 2 ** 32).toString(16).padStart(8, '0');
      macs.push(`${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}:12:34`);
    }
    const start = performance.now();
    let known = 0;
    for (let round = 0; round < 100; round++) for (const mac of macs) if (real.vendor(mac)) known++;
    const elapsed = performance.now() - start;
    assert.ok(known > 0);
    assert.ok(elapsed < 5000, `200 mil consultas levaram ${elapsed.toFixed(0)} ms`);
  });
});

describe('tools/build-oui.mjs', () => {
  test('rodar duas vezes dá os mesmos bytes, iguais aos do arquivo versionado', () => {
    assert.ok(
      existsSync(join(ROOT, 'node_modules/oui-data/index.json')),
      'falta o pacote oui-data: rode "npm install" dentro de wifi-raio-x/',
    );
    const dir = mkdtempSync(join(tmpdir(), 'wrx-oui-'));
    try {
      const first = join(dir, 'a.json');
      const second = join(dir, 'b.json');
      execFileSync(process.execPath, [BUILDER, '--out', first], { cwd: ROOT, stdio: 'pipe' });
      execFileSync(process.execPath, [BUILDER, '--out', second], { cwd: ROOT, stdio: 'pipe' });
      const a = readFileSync(first);
      assert.ok(a.equals(readFileSync(second)), 'duas execuções do gerador deram arquivos diferentes');
      assert.ok(
        a.equals(readFileSync(ASSET)),
        'app/assets/oui.json não é o que o gerador produz hoje: rode "npm run oui" e versione o resultado',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadOui', () => {
  const response = (body, extra = {}) => ({ ok: true, status: 200, json: async () => body, ...extra });

  test('busca, monta a consulta e guarda a Promise por URL', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls++;
      assert.equal(url, 'assets/oui.json?t=cache');
      return response(JSON.parse(built.json));
    };
    const first = loadOui('assets/oui.json?t=cache', fetchImpl);
    const second = loadOui('assets/oui.json?t=cache', fetchImpl);
    assert.equal(first, second);
    const lookup = await first;
    assert.equal(lookup.loaded, true);
    assert.equal(lookup.error, null);
    assert.deepEqual(lookup.vendor('00:11:22:33:44:55'), exact('Acme Routers'));
    assert.equal(await loadOui('assets/oui.json?t=cache', fetchImpl), lookup);
    assert.equal(calls, 1);
  });

  test('lê o arquivo de verdade', async () => {
    const lookup = await loadOui('assets/oui.json?t=real', async () => response(JSON.parse(assetText)));
    assert.equal(lookup.size, asset.prefixes);
    assert.deepEqual(lookup.vendor('80:85:44:12:34:56'), exact('Intelbras'));
  });

  test('falha vira consulta vazia (nunca rejeita) e a chamada seguinte tenta de novo', async () => {
    const failures = [
      async () => {
        throw new Error('sem rede');
      },
      () => {
        throw new Error('fetch explodiu na hora');
      },
      async () => response(null, { ok: false, status: 404 }),
      async () => response({ format: 999 }),
      async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('JSON inválido');
        },
      }),
      async () => undefined,
      undefined, // usa o fetch global, que não aceita URL relativa no Node
      null,
      'não é função',
    ];
    for (const [i, fetchImpl] of failures.entries()) {
      const url = `assets/oui.json?t=falha${i}`;
      const lookup = await loadOui(url, fetchImpl);
      assert.equal(lookup.loaded, false, `caso ${i}`);
      assert.equal(lookup.size, 0);
      assert.match(lookup.error, /não foi possível carregar/);
      assert.equal(lookup.vendor('00:11:22:33:44:55'), null);
      // A falha não ficou guardada: agora o arquivo "chega" e a consulta funciona.
      const retry = await loadOui(url, async () => response(JSON.parse(built.json)));
      assert.equal(retry.loaded, true, `nova tentativa do caso ${i}`);
      assert.deepEqual(retry.vendor('00:11:22:33:44:55'), exact('Acme Routers'));
    }
  });
});
