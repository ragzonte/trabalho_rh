// Testes de app/js/core/security.js.
//
// Os textos de capabilities usados aqui são os que o Android realmente gera em cada
// versão (conferidos em InformationElementUtil.Capabilities do AOSP e no wpa_supplicant).

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCapabilities, refineWithIes, securityTypeLabel } from '../app/js/core/security.js';
import { parseIes } from '../app/js/core/ies.js';

const codes = (s) => s.issues.map((i) => i.code);
const issue = (s, code) => s.issues.find((i) => i.code === code);

/** Confere só os campos listados em `want`. */
function check(capabilities, want, options) {
  const s = parseCapabilities(capabilities, options);
  for (const [key, value] of Object.entries(want)) {
    if (key === 'issues') assert.deepEqual(codes(s), value, `${capabilities}: issues`);
    else assert.deepEqual(s[key], value, `${capabilities}: ${key}`);
  }
  return s;
}

// ---------------------------------------------------------------------------
// parseCapabilities: os exemplos do contrato
// ---------------------------------------------------------------------------

test('WPA2 pessoal com WPS (Android 10+: bloco RSN duplicado como WPA2)', () => {
  const s = check('[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS][WPS]', {
    known: true,
    protocols: ['WPA2'],
    akms: ['PSK'],
    ciphers: ['CCMP'],
    personal: true,
    enterprise: false,
    open: false,
    encrypted: true,
    transition: false,
    wps: true,
    pmf: 'unknown', // sem [MFPC]/[MFPR] não dá para afirmar
    adhoc: false,
    ess: true,
    fastRoaming: false,
    label: 'WPA2',
    level: 3,
    issues: ['wps'],
    fromIes: false,
  });
  assert.equal(issue(s, 'wps').severity, 'medium');
  assert.deepEqual(s.sections, { wpa: null, rsn: { akms: ['PSK'], ciphers: ['CCMP'] }, wapi: null, osen: null });
});

test('WPA/WPA2 misto com TKIP ao lado do AES', () => {
  const s = check('[WPA-PSK-TKIP+CCMP][WPA2-PSK-TKIP+CCMP][ESS]', {
    protocols: ['WPA', 'WPA2'],
    akms: ['PSK'],
    ciphers: ['TKIP', 'CCMP'],
    personal: true,
    label: 'WPA/WPA2',
    level: 3,
    wps: false,
    issues: ['tkip-mixed'],
  });
  assert.equal(issue(s, 'tkip-mixed').severity, 'medium');
  assert.deepEqual(s.sections.wpa, { akms: ['PSK'], ciphers: ['TKIP', 'CCMP'] });
  assert.deepEqual(s.sections.rsn, { akms: ['PSK'], ciphers: ['TKIP', 'CCMP'] });
});

test('WPA3 pessoal com PMF obrigatório', () => {
  check('[RSN-SAE-CCMP][ESS][MFPR][MFPC]', {
    protocols: ['WPA3'],
    akms: ['SAE'],
    ciphers: ['CCMP'],
    personal: true,
    enterprise: false,
    open: false,
    transition: false,
    pmf: 'required',
    label: 'WPA3',
    level: 4,
    issues: [],
  });
});

test('transição WPA2/WPA3', () => {
  const s = check('[RSN-PSK+SAE-CCMP][ESS][MFPC]', {
    protocols: ['WPA2', 'WPA3'],
    akms: ['PSK', 'SAE'],
    transition: true,
    pmf: 'capable',
    label: 'WPA2/WPA3',
    level: 4,
    issues: ['wpa3-transition'],
  });
  assert.equal(issue(s, 'wpa3-transition').severity, 'low');
  // forma completa do Android 12+: o bloco "WPA2" para no primeiro AKM quando há SAE
  check('[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][MFPC]', { protocols: ['WPA2', 'WPA3'], akms: ['PSK', 'SAE'], label: 'WPA2/WPA3' });
});

test('WPA2 empresarial e WPA3 empresarial de 192 bits', () => {
  check('[WPA2-EAP/SHA1-CCMP][RSN-EAP/SHA1-CCMP][ESS]', {
    protocols: ['WPA2'],
    akms: ['EAP'],
    personal: false,
    enterprise: true,
    open: false,
    label: 'WPA2 Empresarial',
    level: 4,
    issues: [],
  });
  check('[RSN-EAP_SUITE_B_192-GCMP-256][ESS][MFPR]', {
    protocols: ['WPA3'],
    akms: ['SUITE-B-192'],
    ciphers: ['GCMP-256'],
    enterprise: true,
    personal: false,
    pmf: 'required',
    label: 'WPA3 Empresarial 192 bits',
    level: 4,
    issues: [],
  });
});

test('OWE e OWE em transição', () => {
  const owe = check('[RSN-OWE-CCMP][ESS]', {
    protocols: ['OWE'],
    akms: ['OWE'],
    personal: false,
    enterprise: false,
    open: true, // não pede credencial...
    encrypted: true, // ...mas cifra
    transition: false,
    oweTransition: false,
    label: 'Aberta (OWE)',
    level: 4,
    issues: ['owe'],
  });
  assert.equal(issue(owe, 'owe').severity, 'low');

  // o Android marca assim o lado ABERTO de um par "aberta + OWE"
  const tr = check('[RSN-OWE_TRANSITION-CCMP][ESS]', {
    protocols: ['OWE'],
    akms: ['OWE'],
    open: true,
    encrypted: false,
    transition: true,
    oweTransition: true,
    label: 'Aberta/OWE',
    level: 3,
    issues: ['owe-transition'],
  });
  assert.equal(issue(tr, 'owe-transition').severity, 'medium');
  // forma do wpa_supplicant para o mesmo caso
  check('[OWE-TRANS-OPEN][ESS]', { oweTransition: true, open: true, encrypted: false, label: 'Aberta/OWE' });
  // e a do lado cifrado do par
  check('[WPA2-OWE-CCMP][OWE-TRANS][ESS]', { oweTransition: false, encrypted: true, label: 'Aberta (OWE)', level: 4 });
});

test('WEP, aberta e ad hoc', () => {
  const wep = check('[WEP][ESS]', {
    protocols: ['WEP'],
    akms: [],
    ciphers: [],
    personal: true,
    open: false,
    encrypted: true,
    pmf: 'none',
    label: 'WEP',
    level: 1,
    issues: ['wep'],
  });
  assert.equal(issue(wep, 'wep').severity, 'high');

  const open = check('[ESS]', {
    known: true,
    protocols: [],
    akms: [],
    personal: false,
    enterprise: false,
    open: true,
    encrypted: false,
    pmf: 'none',
    ess: true,
    adhoc: false,
    label: 'Aberta',
    level: 0,
    issues: ['open'],
  });
  assert.equal(issue(open, 'open').severity, 'high');

  check('[IBSS]', { open: true, adhoc: true, ess: false, label: 'Aberta', level: 0 });
  check('[WEP][IBSS]', { adhoc: true, label: 'WEP', level: 1 });
});

test('FT (802.11r), SHA-256, WAPI, SAE-EXT-KEY e DPP', () => {
  check('[WPA2-FT/PSK+PSK-CCMP]', { protocols: ['WPA2'], akms: ['FT-PSK', 'PSK'], fastRoaming: true, label: 'WPA2', level: 3, ess: false });
  check('[RSN-FT/SAE+SAE-CCMP]', { protocols: ['WPA3'], akms: ['FT-SAE', 'SAE'], fastRoaming: true, label: 'WPA3', level: 4 });
  check('[RSN-PSK-SHA256-CCMP]', { protocols: ['WPA2'], akms: ['PSK-SHA256'], ciphers: ['CCMP'], personal: true, fastRoaming: false, label: 'WPA2' });
  check('[WAPI-PSK-SMS4]', { protocols: ['WAPI'], akms: ['WAPI-PSK'], ciphers: ['SMS4'], personal: true, label: 'WAPI', level: 3 });
  check('[WAPI-WAPI-PSK-SMS4][ESS]', { protocols: ['WAPI'], akms: ['WAPI-PSK'], ciphers: ['SMS4'], label: 'WAPI' });
  check('[WAPI-WAPI-CERT-SMS4][ESS]', { akms: ['WAPI-CERT'], enterprise: true, personal: false });
  check('[RSN-SAE_EXT_KEY-GCMP-256]', { protocols: ['WPA3'], akms: ['SAE-EXT-KEY'], ciphers: ['GCMP-256'], personal: true, label: 'WPA3', level: 4 });
  check('[RSN-FT/SAE_EXT_KEY+SAE_EXT_KEY-GCMP-256][ESS][MFPR][MFPC]', { akms: ['FT-SAE-EXT-KEY', 'SAE-EXT-KEY'], fastRoaming: true, pmf: 'required' });
  check('[RSN-DPP-CCMP]', { protocols: [], akms: ['DPP'], personal: false, enterprise: false, open: false, encrypted: true, label: 'Easy Connect (DPP)', level: 4 });
  // Hotspot 2.0 (cadastro on-line) e AKMs que não dizem a geração da rede
  check('[OSEN-OSEN-CCMP][ESS]', { protocols: [], akms: ['OSEN'], enterprise: true, open: false, label: 'OSEN', pmf: 'none' });
  check('[WPA2-OSEN-CCMP][ESS]', { protocols: [], akms: ['OSEN'], label: 'OSEN' });
  check('[RSN-PASN-CCMP][ESS]', { protocols: ['WPA2'], akms: ['PASN'], open: false, label: 'WPA2' });
});

test('flags soltas: WPS, MFPC, MFPR, P2P, ESS, IBSS, MESH', () => {
  check('[WPA2-PSK-CCMP][ESS][WPS]', { wps: true });
  check('[WPA2-PSK-CCMP][WPS-PBC][ESS]', { wps: true }); // wpa_supplicant: WPS-PBC, WPS-PIN, WPS-AUTH
  check('[WPA2-PSK-CCMP][ESS]', { wps: false });
  check('[RSN-PSK-CCMP][ESS][MFPC]', { pmf: 'capable' });
  check('[RSN-PSK-CCMP][ESS][MFPR][MFPC]', { pmf: 'required' });
  check('[RSN-PSK-CCMP][ESS][MFPR]', { pmf: 'required' });
  // Wi-Fi Direct: o WPS faz parte do pareamento, não é apontado como defeito
  check('[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS][WPS][P2P]', { p2p: true, wps: true, issues: [] });
  check('[MESH]', { mesh: true, known: true });
  check('[RSN-SAE-CCMP][MESH]', { mesh: true, protocols: ['WPA3'] });
  // flags que existem mas não mudam nada
  check('[RSN-PSK-CCMP][RSNO][ESS][HS20][UTF-8][SAE-H2E]', { protocols: ['WPA2'], label: 'WPA2', known: true });
});

// ---------------------------------------------------------------------------
// formatos por versão do Android
// ---------------------------------------------------------------------------

test('formato antigo (até o Android 9, herdado do wpa_supplicant)', () => {
  check('[WPA2-PSK-CCMP][ESS]', { protocols: ['WPA2'], akms: ['PSK'], ciphers: ['CCMP'], label: 'WPA2', level: 3 });
  check('[WPA2-PSK-CCMP-preauth][ESS]', { akms: ['PSK'], ciphers: ['CCMP'], label: 'WPA2' });
  check('[WPA-PSK-CCMP+TKIP][WPA2-PSK-CCMP+TKIP][WPS][ESS]', { protocols: ['WPA', 'WPA2'], ciphers: ['CCMP', 'TKIP'], wps: true, label: 'WPA/WPA2' });
  check('[WPA2-EAP-CCMP][ESS]', { akms: ['EAP'], enterprise: true, label: 'WPA2 Empresarial' });
  check('[WPA2-EAP+FT/EAP-CCMP][ESS]', { akms: ['EAP', 'FT-EAP'], enterprise: true, fastRoaming: true });
  check('[WPA2-EAP-SHA256-CCMP][ESS]', { akms: ['EAP-SHA256'], enterprise: true });
  check('[WPA2-PSK+PSK-SHA256-CCMP][ESS]', { akms: ['PSK', 'PSK-SHA256'], label: 'WPA2' });
  // antes de existir o prefixo RSN, o SAE vinha dentro de um bloco "WPA2"
  check('[WPA2-SAE-CCMP][ESS]', { protocols: ['WPA3'], akms: ['SAE'], label: 'WPA3', level: 4 });
  check('[WPA2-PSK+SAE-CCMP][ESS]', { protocols: ['WPA2', 'WPA3'], label: 'WPA2/WPA3', transition: true });
  check('[WPA2-EAP-SUITE-B-192-GCMP-256][ESS]', { akms: ['SUITE-B-192'], ciphers: ['GCMP-256'], label: 'WPA3 Empresarial 192 bits' });
  check('[WPA2-SAE-EXT-KEY+FT/SAE-EXT-KEY-GCMP-256]', { akms: ['SAE-EXT-KEY', 'FT-SAE-EXT-KEY'], ciphers: ['GCMP-256'] });
  check('[WPA2-PSK-GCMP][ESS]', { ciphers: ['GCMP-128'] }); // o wpa_supplicant chama o GCMP-128 só de "GCMP"
  check('[WPA2-FILS-SHA256+FT-FILS-SHA256-CCMP][ESS]', { akms: ['FILS-SHA256', 'FT-FILS-SHA256'], enterprise: true, fastRoaming: true });
});

test('formato do Android 12+ ("/SHA1", "/SHA256") e do Android 16 ("CCMP-128")', () => {
  check('[WPA2-EAP/SHA1+FT/EAP-CCMP][RSN-EAP/SHA1+FT/EAP-CCMP][ESS]', { akms: ['EAP', 'FT-EAP'], label: 'WPA2 Empresarial' });
  check('[RSN-EAP-FILS-SHA256-CCMP][ESS]', { akms: ['FILS-SHA256'], enterprise: true });
  check('[RSN-EAP-FT-SHA384-GCMP-256][ESS][MFPR][MFPC]', { akms: ['FT-EAP-SHA384'], enterprise: true, fastRoaming: true, protocols: ['WPA3'] });
  check('[RSN-FT/PSK-SHA384-CCMP][ESS]', { akms: ['FT-PSK-SHA384'], personal: true, fastRoaming: true });
  // Android 16 escreve a cifra com o tamanho
  check('[WPA2-PSK-CCMP-128][RSN-PSK-CCMP-128][ESS]', { ciphers: ['CCMP'], label: 'WPA2', level: 3 });
  check('[RSN-SAE-CCMP-128+GCMP-256][ESS][MFPR][MFPC]', { ciphers: ['CCMP', 'GCMP-256'], label: 'WPA3' });
  check('[RSN-SAE-GCMP-128+CCMP-256][ESS]', { ciphers: ['GCMP-128', 'CCMP-256'] });
  check('[WPA-PSK-TKIP+CCMP-128][WPA2-PSK-TKIP+CCMP-128][RSN-PSK-TKIP+CCMP-128][ESS]', {
    protocols: ['WPA', 'WPA2'],
    ciphers: ['TKIP', 'CCMP'],
    issues: ['tkip-mixed'],
  });
});

test('WPA3 empresarial segue a regra do Android (PMF decide)', () => {
  // só SHA-256 + PMF obrigatório = WPA3-Empresarial
  check('[RSN-EAP/SHA256-CCMP][ESS][MFPR][MFPC]', { protocols: ['WPA3'], label: 'WPA3 Empresarial', level: 4, transition: false });
  // os dois AKMs + PMF opcional = transição empresarial
  check('[WPA2-EAP/SHA1+EAP/SHA256-CCMP][RSN-EAP/SHA1+EAP/SHA256-CCMP][ESS][MFPC]', {
    protocols: ['WPA2', 'WPA3'],
    label: 'WPA2/WPA3 Empresarial',
    transition: true,
    issues: ['wpa3-transition'],
  });
  // SHA-256 sem as flags de PMF continua sendo WPA2-Empresarial
  check('[RSN-EAP/SHA256-CCMP][ESS]', { protocols: ['WPA2'], label: 'WPA2 Empresarial' });
  check('[WPA2-EAP/SHA1+EAP/SHA256-CCMP][RSN-EAP/SHA1+EAP/SHA256-CCMP][ESS][MFPR][MFPC]', { protocols: ['WPA2'], transition: false });
  // pessoal e empresarial no mesmo BSS
  check('[RSN-PSK+EAP/SHA1-CCMP][ESS]', { personal: true, enterprise: true, label: 'WPA2 Pessoal/Empresarial' });
  check('[WPA-EAP-TKIP][ESS]', { label: 'WPA Empresarial', level: 2, issues: ['tkip-only'] });
});

// ---------------------------------------------------------------------------
// níveis e avisos
// ---------------------------------------------------------------------------

test('níveis: 0 aberta, 1 WEP, 2 fraca, 3 boa, 4 forte', () => {
  const levels = {
    '[ESS]': 0,
    '': 0,
    '[WEP][ESS]': 1,
    '[WPA-PSK-TKIP][ESS]': 2, //           só WPA1
    '[WPA-PSK-CCMP][ESS]': 2, //           WPA1 continua fraca mesmo com AES
    '[WPA2-PSK-TKIP][ESS]': 2, //          "WPA2" só com TKIP
    '[WPA-PSK-TKIP][WPA2-PSK-TKIP][ESS]': 2,
    '[WPA2-PSK-CCMP][ESS]': 3,
    '[WPA2-PSK-TKIP+CCMP][ESS]': 3,
    '[WPA-PSK-TKIP][WPA2-PSK-CCMP][ESS]': 3, // misto conta como boa (com aviso)
    '[RSN-OWE_TRANSITION-CCMP][ESS]': 3,
    '[RSN-PSK+SAE-CCMP][ESS]': 4,
    '[RSN-SAE-CCMP][ESS]': 4,
    '[RSN-OWE-CCMP][ESS]': 4,
    '[WPA2-EAP-CCMP][ESS]': 4,
    '[RSN-EAP_SUITE_B_192-GCMP-256][ESS]': 4,
  };
  for (const [caps, level] of Object.entries(levels)) assert.equal(parseCapabilities(caps).level, level, caps);
});

test('avisos: gravidade, ordem e texto em português', () => {
  const tkip = parseCapabilities('[WPA-PSK-TKIP][ESS][WPS]');
  assert.deepEqual(codes(tkip), ['tkip-only', 'wps']); // do mais grave para o menos grave
  assert.equal(issue(tkip, 'tkip-only').severity, 'high');

  const all = [
    '[ESS]', '[WEP][ESS]', '[WPA-PSK-TKIP][ESS]', '[WPA-PSK-TKIP+CCMP][WPA2-PSK-TKIP+CCMP][ESS][WPS]', '[RSN-PSK+SAE-CCMP][ESS][MFPC][WPS]',
    '[RSN-OWE-CCMP][ESS]', '[RSN-OWE_TRANSITION-CCMP][ESS]',
  ];
  const seen = new Set();
  const order = { high: 0, medium: 1, low: 2 };
  for (const caps of all) {
    const s = parseCapabilities(caps, { sdk: 34 });
    let last = 0;
    for (const i of s.issues) {
      seen.add(i.code);
      assert.ok(i.severity in order, `${caps}: gravidade ${i.severity}`);
      assert.ok(order[i.severity] >= last, `${caps}: fora de ordem`);
      last = order[i.severity];
      assert.equal(typeof i.text, 'string');
      assert.ok(i.text.length > 30 && /[.!]$/.test(i.text), `${i.code}: frase completa`);
      assert.ok(!/undefined|null/.test(i.text));
    }
  }
  assert.deepEqual([...seen].sort(), ['no-pmf', 'open', 'owe', 'owe-transition', 'tkip-mixed', 'tkip-only', 'wep', 'wpa3-transition', 'wps']);
  // cada código tem um texto diferente
  const texts = new Map();
  for (const caps of all) for (const i of parseCapabilities(caps, { sdk: 34 }).issues) texts.set(i.code, i.text);
  assert.equal(new Set(texts.values()).size, texts.size);
});

test('WPS só é apontado em rede com senha compartilhada', () => {
  assert.deepEqual(codes(parseCapabilities('[ESS][WPS]')), ['open']);
  assert.deepEqual(codes(parseCapabilities('[WPA2-EAP-CCMP][ESS][WPS]')), []);
  assert.deepEqual(codes(parseCapabilities('[WPA2-PSK-CCMP][ESS][WPS]')), ['wps']);
});

test('PMF: sem as flags fica "unknown", a não ser que o Android (14+) sempre as escreva', () => {
  check('[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]', { pmf: 'unknown', issues: [] });
  check('[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]', { pmf: 'unknown', issues: [] }, { sdk: 33 });
  const s = check('[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]', { pmf: 'none', issues: ['no-pmf'] }, { sdk: 34 });
  assert.equal(issue(s, 'no-pmf').severity, 'low');
  check('[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS][MFPC]', { pmf: 'capable', issues: [] }, { sdk: 34 });
  // sem RSN não existe PMF, em qualquer versão
  check('[WPA-PSK-TKIP][ESS]', { pmf: 'none' });
  check('[ESS]', { pmf: 'none' }, { sdk: 30 });
  // opções malformadas são ignoradas
  check('[RSN-PSK-CCMP][ESS]', { pmf: 'unknown' }, { sdk: 'trinta e quatro' });
  check('[RSN-PSK-CCMP][ESS]', { pmf: 'unknown' }, 34);
  check('[RSN-PSK-CCMP][ESS]', { pmf: 'unknown' }, null);
});

// ---------------------------------------------------------------------------
// tolerância
// ---------------------------------------------------------------------------

test('texto vazio, ausente ou irreconhecível vira "desconhecida", nunca "aberta"', () => {
  for (const bad of ['', '   ', undefined, null, 0, 42, {}, [], true, '[]', '[ ]', 'lixo', '[LIXO]', '[???][---]', '[[[', ']]][', '[+][-]']) {
    const s = parseCapabilities(bad);
    assert.equal(s.known, false, String(bad));
    assert.equal(s.open, false);
    assert.equal(s.encrypted, false);
    assert.equal(s.label, 'Desconhecida');
    assert.equal(s.level, 0);
    assert.equal(s.pmf, 'unknown');
    assert.deepEqual(s.protocols, []);
    assert.deepEqual(s.issues, []);
  }
});

test('palavras desconhecidas são ignoradas sem perder o resto', () => {
  check('[RSN-PSK+FUTURO-CCMP+XYZ-999][ESS][NOVA-FLAG]', { protocols: ['WPA2'], akms: ['PSK'], ciphers: ['CCMP'], ess: true, label: 'WPA2' });
  // "?" e "None" são o que o Android escreve para AKM/cifra que não conhece
  check('[RSN-?-CCMP][ESS]', { protocols: ['WPA2'], akms: [], ciphers: ['CCMP'], label: 'WPA2', level: 3 });
  check('[RSN-None-None][ESS]', { protocols: ['WPA2'], akms: [], ciphers: [] });
  check('[WPA2--CCMP][ESS]', { protocols: ['WPA2'], akms: [], ciphers: ['CCMP'] });
  check('[?-?-?][ESS]', { protocols: [], open: true, label: 'Aberta' });
  // nome parecido com um conhecido não é confundido
  check('[RSN-PSKX-CCMPY][ESS]', { akms: [], ciphers: [] });
  check('[WPA2PSK][ESS]', { protocols: [], open: true });
  check('[WPS-PBC]', { wps: true, protocols: [] });
});

test('maiúsculas/minúsculas, espaços e falta de colchetes', () => {
  check('[wpa2-psk-ccmp][rsn-psk-ccmp][ess][wps]', { protocols: ['WPA2'], akms: ['PSK'], ciphers: ['CCMP'], ess: true, wps: true });
  check(' [ WPA2-PSK-CCMP ] [ ESS ] ', { protocols: ['WPA2'], ess: true });
  check('WPA2-PSK-CCMP ESS', { protocols: ['WPA2'], akms: ['PSK'], ess: true });
  check('[RSN-EAP_SUITE_B_192-GCMP_256]', { akms: ['SUITE-B-192'], ciphers: ['GCMP-256'] });
  // bloco repetido não duplica nada
  check('[RSN-PSK-CCMP][RSN-PSK-CCMP][RSN-PSK-CCMP][ESS][ESS]', { akms: ['PSK'], ciphers: ['CCMP'] });
});

test('o resultado é sempre um objeto completo e independente', () => {
  const keys = [
    'known', 'protocols', 'akms', 'ciphers', 'groupCipher', 'personal', 'enterprise', 'open', 'encrypted', 'transition',
    'oweTransition', 'wps', 'wpsLocked', 'pmf', 'adhoc', 'ess', 'p2p', 'mesh', 'fastRoaming', 'label', 'level', 'issues',
    'sections', 'fromIes',
  ];
  for (const caps of ['', '[ESS]', '[WPA2-PSK-CCMP][ESS]', undefined]) {
    const s = parseCapabilities(caps);
    assert.deepEqual(Object.keys(s).sort(), keys.slice().sort());
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s); // serializável
  }
  // mexer num resultado não afeta o próximo
  const a = parseCapabilities('[WPA2-PSK-CCMP][ESS]');
  a.akms.push('X');
  a.sections.rsn.akms.push('X');
  a.issues.push({});
  const b = parseCapabilities('[WPA2-PSK-CCMP][ESS]');
  assert.deepEqual(b.akms, ['PSK']);
  assert.deepEqual(b.sections.rsn.akms, ['PSK']);
  assert.deepEqual(b.issues, []);
});

test('fuzz: textos aleatórios nunca lançam e o resultado é coerente', () => {
  // gerador determinístico (mulberry32)
  let a = 0x5ec0de;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const words = ['WPA', 'WPA2', 'RSN', 'RSNO', 'OSEN', 'WAPI', 'WEP', 'PSK', 'SAE', 'EAP', 'EAP/SHA1', 'EAP/SHA256', 'FT/PSK', 'FT/SAE', 'FT/EAP',
    'OWE', 'OWE_TRANSITION', 'EAP_SUITE_B_192', 'SAE_EXT_KEY', 'PSK-SHA256', 'DPP', 'CCMP', 'CCMP-128', 'TKIP', 'GCMP-256', 'SMS4', 'None', '?',
    'ESS', 'IBSS', 'WPS', 'MFPC', 'MFPR', 'P2P', 'MESH', 'preauth', '', 'ÇÃO', String.fromCodePoint(0x1f4a5), '256', '-', '+', '/', '[', ']', ' ', '_'];
  const seps = ['-', '+', '', '][', '[', ']', '/', '_', ' '];
  const levels = new Set();
  for (let round = 0; round < 6000; round++) {
    let text = rnd() < 0.8 ? '[' : '';
    const n = Math.floor(rnd() * 14);
    for (let i = 0; i < n; i++) text += pick(words) + pick(seps);
    if (rnd() < 0.8) text += ']';
    let s;
    assert.doesNotThrow(() => {
      s = parseCapabilities(text, rnd() < 0.3 ? { sdk: 34 } : undefined);
    }, text);
    levels.add(s.level);
    assert.ok([0, 1, 2, 3, 4].includes(s.level), text);
    assert.ok(typeof s.label === 'string' && s.label.length > 0, text);
    assert.ok(['required', 'capable', 'none', 'unknown'].includes(s.pmf), text);
    assert.ok(s.protocols.every((p) => ['WEP', 'WPA', 'WPA2', 'WPA3', 'OWE', 'WAPI'].includes(p)), text);
    assert.equal(new Set(s.akms).size, s.akms.length, text);
    assert.equal(new Set(s.ciphers).size, s.ciphers.length, text);
    for (const i of s.issues) assert.ok(['high', 'medium', 'low'].includes(i.severity) && i.text, text);
    // coerência: aberta sem cifra tem nível 0 e aviso; nível 4 nunca traz aviso grave
    if (s.open && !s.encrypted && !s.oweTransition) assert.equal(s.level, 0, text);
    if (s.level === 4) assert.ok(!s.issues.some((i) => i.severity === 'high'), text);
    if (!s.known) assert.deepEqual(s.issues, [], text);
    // refinar com nada, ou com lixo, devolve o mesmo conteúdo
    assert.deepEqual(refineWithIes(s, null), s, text);
    assert.deepEqual(refineWithIes(s, { rsn: 'x', wpa: 3, wps: true, oweTransition: 'y' }), s, text);
  }
  assert.deepEqual([...levels].sort(), [0, 1, 2, 3, 4]); // o gerador chega a todos os níveis
});

// ---------------------------------------------------------------------------
// securityTypeLabel
// ---------------------------------------------------------------------------

test('securityTypeLabel cobre todas as constantes WifiInfo.SECURITY_TYPE_*', () => {
  // valores conferidos em developer.android.com/reference/android/net/wifi/WifiInfo
  const want = {
    '-1': 'Desconhecida', //              SECURITY_TYPE_UNKNOWN
    0: 'Aberta', //                       SECURITY_TYPE_OPEN
    1: 'WEP', //                          SECURITY_TYPE_WEP
    2: 'WPA/WPA2 Pessoal', //             SECURITY_TYPE_PSK
    3: 'WPA/WPA2 Empresarial', //         SECURITY_TYPE_EAP
    4: 'WPA3 Pessoal', //                 SECURITY_TYPE_SAE
    5: 'WPA3 Empresarial 192 bits', //    SECURITY_TYPE_EAP_WPA3_ENTERPRISE_192_BIT
    6: 'Aberta (OWE)', //                 SECURITY_TYPE_OWE
    7: 'WAPI Pessoal', //                 SECURITY_TYPE_WAPI_PSK
    8: 'WAPI Certificado', //             SECURITY_TYPE_WAPI_CERT
    9: 'WPA3 Empresarial', //             SECURITY_TYPE_EAP_WPA3_ENTERPRISE
    10: 'OSEN', //                        SECURITY_TYPE_OSEN
    11: 'Passpoint R1/R2', //             SECURITY_TYPE_PASSPOINT_R1_R2
    12: 'Passpoint R3', //                SECURITY_TYPE_PASSPOINT_R3
    13: 'Easy Connect (DPP)', //          SECURITY_TYPE_DPP
  };
  for (const [n, label] of Object.entries(want)) assert.equal(securityTypeLabel(Number(n)), label, `tipo ${n}`);
  assert.equal(new Set(Object.values(want)).size, 15);
  for (const other of [14, 99, -2, 1.5, NaN, Infinity, undefined, null, 'x', '', {}, [], true]) {
    assert.equal(securityTypeLabel(other), 'Desconhecida', String(other));
  }
  assert.equal(securityTypeLabel('4'), 'WPA3 Pessoal'); // número vindo como texto do JSON
});

// ---------------------------------------------------------------------------
// refineWithIes (os elementos vêm de hex escrito à mão, via parseIes)
// ---------------------------------------------------------------------------

const hx = (...parts) => parts.join('').replace(/\s+/g, '');
const RSN = {
  // Version 1 | grupo CCMP | 1 par a par: CCMP | 1 AKM: PSK | capacidades 0x0000
  wpa2: hx('0100', '000fac04', '0100 000fac04', '0100 000fac02', '0000'),
  // ... | capacidades 0x0080 = MFPC
  wpa2Pmf: hx('0100', '000fac04', '0100 000fac04', '0100 000fac02', '8000'),
  // ... | 1 AKM: SAE (8) | capacidades 0x00C0 = MFPR + MFPC | 0 PMKIDs | BIP-CMAC-128
  wpa3: hx('0100', '000fac04', '0100 000fac04', '0100 000fac08', 'c000', '0000', '000fac06'),
  // ... | 2 AKMs: PSK e SAE | 0x0080
  transition: hx('0100', '000fac04', '0100 000fac04', '0200 000fac02 000fac08', '8000'),
  // grupo TKIP | par a par: CCMP e TKIP | PSK | 0x0000
  mixed: hx('0100', '000fac02', '0200 000fac04 000fac02', '0100 000fac02', '0000'),
  // grupo TKIP | par a par: só CCMP (o TKIP fica só no broadcast, para os aparelhos WPA1)
  groupTkip: hx('0100', '000fac02', '0100 000fac04', '0100 000fac02', '0000'),
  // 1 AKM: OWE (18 = 0x12) | 0x00C0
  owe: hx('0100', '000fac04', '0100 000fac04', '0100 000fac12', 'c000'),
  // 1 AKM: 802.1X SHA-256 (5) | 0x00C0
  eap256: hx('0100', '000fac04', '0100 000fac04', '0100 000fac05', 'c000'),
  // FT-PSK (4) e PSK (2)
  ft: hx('0100', '000fac04', '0100 000fac04', '0200 000fac04 000fac02', '0000'),
};
// WPA1 da Microsoft: OUI 00-50-F2 tipo 1 | Version 1 | grupo TKIP | par a par TKIP | AKM PSK
const WPA1 = hx('0050f201', '0100', '0050f202', '0100 0050f202', '0100 0050f202');
// WPS: Version 1.0 | estado 2 (configurado) | [AP Setup Locked = 1]
const WPS = hx('0050f204', '104a000110', '1044000102');
const WPS_LOCKED = hx(WPS, '1057000101');
// OWE Transition: OUI 50-6F-9A tipo 0x1C | BSSID | tamanho 4 | "Cafe"
const OWE_TRANSITION = hx('506f9a1c', '021122334455', '04', '43616665');
// RSNE Override: OUI 50-6F-9A tipo 0x29 | RSNE com GCMP-256 (9) e SAE-EXT-KEY (24 = 0x18)
const RSN_OVERRIDE = hx('506f9a29', '0100', '000fac04', '0100 000fac09', '0100 000fac18', 'c000');

const rsnIe = (hex) => ({ id: 48, ext: 0, hex });
const vendor = (hex) => ({ id: 221, ext: 0, hex });
const refine = (caps, ...ies) => refineWithIes(parseCapabilities(caps), parseIes(ies));

test('refineWithIes: PMF exato a partir do RSN', () => {
  const none = refine('[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]', rsnIe(RSN.wpa2));
  assert.equal(none.pmf, 'none');
  assert.equal(none.fromIes, true);
  assert.equal(none.label, 'WPA2');
  assert.equal(none.level, 3);
  assert.equal(none.groupCipher, 'CCMP');
  assert.deepEqual(codes(none), ['no-pmf']);
  assert.equal(issue(none, 'no-pmf').severity, 'low');

  const capable = refine('[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]', rsnIe(RSN.wpa2Pmf));
  assert.equal(capable.pmf, 'capable');
  assert.deepEqual(codes(capable), []);

  const required = refine('[RSN-SAE-CCMP][ESS]', rsnIe(RSN.wpa3));
  assert.equal(required.pmf, 'required');
  assert.equal(required.label, 'WPA3');
  assert.equal(required.level, 4);
  assert.deepEqual(codes(required), []);

  // o elemento manda: mesmo que o texto dissesse outra coisa
  const overridden = refine('[RSN-PSK-CCMP][ESS][MFPR][MFPC]', rsnIe(RSN.wpa2));
  assert.equal(overridden.pmf, 'none');
});

test('refineWithIes: AKMs e cifras exatos, mesmo com texto vazio ou pobre', () => {
  const t = refine('', rsnIe(RSN.transition));
  assert.equal(t.known, true);
  assert.deepEqual(t.protocols, ['WPA2', 'WPA3']);
  assert.deepEqual(t.akms, ['PSK', 'SAE']);
  assert.deepEqual(t.ciphers, ['CCMP']);
  assert.equal(t.label, 'WPA2/WPA3');
  assert.equal(t.transition, true);
  assert.equal(t.pmf, 'capable');
  assert.equal(t.personal, true);
  assert.equal(t.open, false);

  // o bloco "WPA2" do Android esconde o SAE; o elemento mostra
  assert.equal(parseCapabilities('[WPA2-PSK-CCMP][ESS]').label, 'WPA2');
  assert.equal(refine('[WPA2-PSK-CCMP][ESS]', rsnIe(RSN.transition)).label, 'WPA2/WPA3');

  const ft = refine('[WPA2-PSK-CCMP][ESS]', rsnIe(RSN.ft));
  assert.deepEqual(ft.akms, ['FT-PSK', 'PSK']);
  assert.equal(ft.fastRoaming, true);

  // empresarial só com SHA-256 e PMF obrigatório: WPA3-Empresarial (só o elemento garante o PMF)
  const eap = refine('[WPA2-EAP-SHA256-CCMP][ESS]', rsnIe(RSN.eap256));
  assert.equal(eap.label, 'WPA3 Empresarial');
  assert.equal(eap.enterprise, true);

  const owe = refine('[ESS]', rsnIe(RSN.owe));
  assert.equal(owe.label, 'Aberta (OWE)');
  assert.equal(owe.open, true);
  assert.equal(owe.encrypted, true);
  assert.equal(owe.pmf, 'required');
  assert.equal(owe.level, 4);
});

test('refineWithIes: WPA1 + RSN, TKIP só no grupo e WPA1 sozinho', () => {
  const mixed = refine('[WPA-PSK-TKIP+CCMP][WPA2-PSK-TKIP+CCMP][ESS]', vendor(WPA1), rsnIe(RSN.mixed));
  assert.deepEqual(mixed.protocols, ['WPA', 'WPA2']);
  assert.deepEqual(mixed.ciphers, ['TKIP', 'CCMP']);
  assert.deepEqual(mixed.sections.wpa, { akms: ['PSK'], ciphers: ['TKIP'] });
  assert.deepEqual(mixed.sections.rsn, { akms: ['PSK'], ciphers: ['CCMP', 'TKIP'] });
  assert.equal(mixed.groupCipher, 'TKIP');
  assert.equal(mixed.level, 3);
  assert.deepEqual(codes(mixed), ['tkip-mixed', 'no-pmf']);

  // WPA2 que parece limpo no par a par, mas ainda usa TKIP no broadcast
  const group = refine('[WPA2-PSK-CCMP][ESS]', rsnIe(RSN.groupTkip));
  assert.deepEqual(group.ciphers, ['CCMP']);
  assert.equal(group.groupCipher, 'TKIP');
  assert.ok(codes(group).includes('tkip-mixed'));

  const wpa1 = refine('[WPA-PSK-TKIP][ESS]', vendor(WPA1));
  assert.deepEqual(wpa1.protocols, ['WPA']);
  assert.equal(wpa1.pmf, 'none');
  assert.equal(wpa1.level, 2);
  assert.equal(wpa1.groupCipher, 'TKIP');
  assert.deepEqual(codes(wpa1), ['tkip-only']);
});

test('refineWithIes: WPS e PIN travado', () => {
  const on = refine('[WPA2-PSK-CCMP][ESS]', rsnIe(RSN.wpa2Pmf), vendor(WPS));
  assert.equal(on.wps, true);
  assert.equal(on.wpsLocked, false);
  assert.equal(issue(on, 'wps').severity, 'medium');

  const locked = refine('[WPA2-PSK-CCMP][ESS][WPS]', rsnIe(RSN.wpa2Pmf), vendor(WPS_LOCKED));
  assert.equal(locked.wps, true);
  assert.equal(locked.wpsLocked, true);
  assert.equal(issue(locked, 'wps').severity, 'low');
  assert.notEqual(issue(locked, 'wps').text, issue(on, 'wps').text);

  // só o WPS veio nos elementos: o resto continua o do texto
  const only = refine('[WPA2-PSK-CCMP][ESS]', vendor(WPS));
  assert.equal(only.wps, true);
  assert.equal(only.fromIes, false);
  assert.equal(only.pmf, 'unknown');
  // sem elemento WPS, o que o texto dizia continua valendo
  assert.equal(refine('[WPA2-PSK-CCMP][ESS][WPS]', rsnIe(RSN.wpa2)).wps, true);
  assert.equal(parseCapabilities('[WPA2-PSK-CCMP][ESS][WPS]').wpsLocked, null);
});

test('refineWithIes: transição OWE e RSNE Override', () => {
  const tr = refine('[ESS]', vendor(OWE_TRANSITION));
  assert.equal(tr.oweTransition, true);
  assert.equal(tr.transition, true);
  assert.equal(tr.open, true);
  assert.equal(tr.encrypted, false);
  assert.equal(tr.label, 'Aberta/OWE');
  assert.equal(tr.level, 3);
  assert.deepEqual(codes(tr), ['owe-transition']);
  // o lado cifrado do par tem RSN próprio: não é "transição" para quem conecta nele
  const hidden = refine('[RSN-OWE-CCMP][ESS]', rsnIe(RSN.owe), vendor(OWE_TRANSITION));
  assert.equal(hidden.oweTransition, false);
  assert.equal(hidden.encrypted, true);
  assert.equal(hidden.label, 'Aberta (OWE)');

  // modo de compatibilidade do WPA3: RSN só com PSK + AKM novo no RSNE Override
  const comp = refine('[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]', rsnIe(RSN.wpa2Pmf), vendor(RSN_OVERRIDE));
  assert.deepEqual(comp.akms, ['PSK', 'SAE-EXT-KEY']);
  assert.deepEqual(comp.ciphers, ['CCMP', 'GCMP-256']);
  assert.deepEqual(comp.protocols, ['WPA2', 'WPA3']);
  assert.equal(comp.label, 'WPA2/WPA3');
  assert.equal(comp.pmf, 'capable'); // o PMF é o do RSN principal
});

test('refineWithIes: WEP no texto some quando o beacon tem RSN; o resto do texto fica', () => {
  const s = refine('[WEP][ESS][P2P]', rsnIe(RSN.wpa2));
  assert.deepEqual(s.protocols, ['WPA2']);
  assert.equal(s.ess, true);
  assert.equal(s.p2p, true);
  // sem RSN/WPA nos elementos, WEP e aberta continuam como estavam
  const ht = { id: 45, ext: 0, hex: 'ef091bffff000000000000000000000100000000000000000000' };
  assert.deepEqual(refine('[WEP][ESS]', ht), parseCapabilities('[WEP][ESS]'));
  assert.deepEqual(refine('[ESS]', ht), parseCapabilities('[ESS]'));
  assert.deepEqual(refine('[WPA2-PSK-CCMP][ESS]'), parseCapabilities('[WPA2-PSK-CCMP][ESS]'));
});

test('refineWithIes não altera as entradas e aguenta qualquer coisa', () => {
  const base = parseCapabilities('[WPA2-PSK-CCMP][ESS]');
  const info = parseIes([rsnIe(RSN.transition), vendor(WPS_LOCKED)]);
  const baseCopy = JSON.parse(JSON.stringify(base));
  const infoCopy = JSON.parse(JSON.stringify(info));
  const out = refineWithIes(base, info);
  assert.deepEqual(base, baseCopy);
  assert.deepEqual(info, infoCopy);
  assert.notEqual(out, base);
  out.sections.rsn.akms.push('X');
  assert.deepEqual(info.rsn.akms, ['PSK', 'SAE']);

  for (const bad of [undefined, null, 0, 'x', [], {}, { rsn: null }, { rsn: {} }, { rsn: { akms: 'PSK', pairwiseCiphers: 5 } }, { wpa: [] }]) {
    assert.doesNotThrow(() => refineWithIes(base, bad));
    assert.doesNotThrow(() => refineWithIes(bad, info));
    assert.doesNotThrow(() => refineWithIes(bad, bad));
  }
  // sem Security válido, parte de "desconhecida" e usa só os elementos
  const fromNothing = refineWithIes(undefined, info);
  assert.equal(fromNothing.label, 'WPA2/WPA3');
  assert.equal(fromNothing.wps, true);
  assert.equal(refineWithIes(undefined, undefined).label, 'Desconhecida');
  // RSN vazio (só a versão) ainda é uma rede RSN
  const bare = refineWithIes(base, { rsn: {} });
  assert.deepEqual(bare.protocols, ['WPA2']);
  assert.equal(bare.pmf, 'none');
  // refinar duas vezes dá o mesmo resultado
  assert.deepEqual(refineWithIes(refineWithIes(base, info), info), refineWithIes(base, info));
});
