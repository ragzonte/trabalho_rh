// Segurança de uma rede Wi-Fi.
//
// Entrada principal: o texto cru de ScanResult.capabilities, por exemplo
//   "[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP][ESS][WPS][MFPC]"
// O formato mudou bastante entre versões do Android (conferido no código do AOSP,
// InformationElementUtil.Capabilities, e no wpa_supplicant, que gerava o texto antes):
//   - até o Android 9:  "[WPA2-PSK-CCMP]", "[WPA2-EAP-CCMP]", "[WPA2-FT/PSK+PSK-CCMP-preauth]"
//   - Android 10+:      cada bloco RSN aparece duas vezes ("[WPA2-...][RSN-...]"); o bloco
//                       "WPA2" para no primeiro AKM quando há SAE (compatibilidade)
//   - Android 12+:      "EAP" virou "EAP/SHA1" e "EAP/SHA256"; surgem [MFPR] e [MFPC]
//   - Android 16:       "CCMP" virou "CCMP-128"; surge "GCMP-128"; flag [RSNO]
// Por isso nada aqui depende de posição: cada bloco é lido por palavras conhecidas e o
// que não for reconhecido é ignorado. Nenhuma função lança exceção.

/**
 * @typedef {Object} SecurityIssue
 * @property {string} code       identificador estável ('open', 'wep', 'tkip-only', 'tkip-mixed', 'wps',
 *                               'no-pmf', 'wpa3-transition', 'owe', 'owe-transition')
 * @property {'high'|'medium'|'low'} severity
 * @property {string} text       frase em pt-BR para um leigo
 */

/**
 * @typedef {Object} Security
 * @property {boolean} known         false quando não havia texto para interpretar (aí o resto é "desconhecido")
 * @property {('WEP'|'WPA'|'WPA2'|'WPA3'|'OWE'|'WAPI')[]} protocols  em ordem do mais antigo para o mais novo
 * @property {string[]} akms         formas de autenticação, normalizadas: 'PSK', 'SAE', 'EAP', 'EAP-SHA256',
 *                                   'SUITE-B-192', 'OWE', 'FT-PSK', 'FT-SAE', 'FT-EAP', 'PSK-SHA256', 'DPP', 'SAE-EXT-KEY'...
 * @property {string[]} ciphers      cifras par a par: 'TKIP', 'CCMP', 'GCMP-256', 'GCMP-128', 'CCMP-256', 'SMS4'...
 * @property {string|null} groupCipher  cifra de grupo (broadcast); só é conhecida depois de refineWithIes
 * @property {boolean} personal      pede uma senha compartilhada (WEP, PSK, SAE)
 * @property {boolean} enterprise    pede login individual (802.1X/EAP)
 * @property {boolean} open          não pede credencial nenhuma (aberta comum ou OWE)
 * @property {boolean} encrypted     o tráfego deste BSSID é cifrado (false na aberta comum e no lado aberto da transição OWE)
 * @property {boolean} transition    modo de transição: WPA2+WPA3 juntos, ou OWE em transição
 * @property {boolean} oweTransition este BSSID é o lado aberto de um par "aberta + OWE"
 * @property {boolean} wps
 * @property {boolean|null} wpsLocked  o AP travou o PIN do WPS (só com refineWithIes; null = não se sabe)
 * @property {'required'|'capable'|'none'|'unknown'} pmf  proteção dos quadros de gerenciamento (802.11w)
 * @property {boolean} adhoc         rede ponto a ponto (IBSS)
 * @property {boolean} ess           rede de infraestrutura (tem um ponto de acesso)
 * @property {boolean} p2p           grupo Wi-Fi Direct
 * @property {boolean} mesh
 * @property {boolean} fastRoaming   algum AKM com FT (802.11r)
 * @property {string} label          rótulo curto para listas: "Aberta", "WPA2", "WPA2/WPA3", "WPA3 Empresarial"...
 * @property {0|1|2|3|4} level       0 nenhuma (aberta ou desconhecida) · 1 quebrada (WEP) · 2 fraca (só WPA1 ou só TKIP)
 *                                   · 3 boa (WPA2-AES, também WPA/WPA2 misto e OWE em transição) · 4 forte (WPA3, OWE, Empresarial)
 * @property {SecurityIssue[]} issues  do mais grave para o menos grave
 * @property {{wpa:?{akms:string[],ciphers:string[]}, rsn:?{akms:string[],ciphers:string[]},
 *             wapi:?{akms:string[],ciphers:string[]}, osen:?{akms:string[],ciphers:string[]}}} sections
 *                                   o que cada elemento anunciava (WPA = WPA1; RSN = WPA2/WPA3/OWE)
 * @property {boolean} fromIes       true quando refineWithIes usou os elementos RSN/WPA do beacon (dados exatos)
 */

// Palavras que o Android/wpa_supplicant escrevem dentro de um bloco, já em maiúsculas e
// com "_" trocado por "-". Valor = nome normalizado.
const AKM_WORDS = {
  PSK: 'PSK',
  'PSK-SHA256': 'PSK-SHA256',
  'PSK-SHA384': 'PSK-SHA384',
  EAP: 'EAP',
  'EAP/SHA1': 'EAP',
  'EAP-SHA1': 'EAP',
  'EAP/SHA256': 'EAP-SHA256',
  'EAP-SHA256': 'EAP-SHA256',
  'EAP/SHA384': 'EAP-SHA384',
  'EAP-SHA384': 'EAP-SHA384',
  'FT/EAP': 'FT-EAP',
  'FT-EAP': 'FT-EAP',
  'FT/PSK': 'FT-PSK',
  'FT-PSK': 'FT-PSK',
  'FT/PSK-SHA384': 'FT-PSK-SHA384',
  'FT-PSK-SHA384': 'FT-PSK-SHA384',
  'FT/SAE': 'FT-SAE',
  'FT-SAE': 'FT-SAE',
  'FT/SAE-EXT-KEY': 'FT-SAE-EXT-KEY',
  'FT-SAE-EXT-KEY': 'FT-SAE-EXT-KEY',
  'EAP-FT-SHA384': 'FT-EAP-SHA384',
  'FT/EAP-SHA384': 'FT-EAP-SHA384',
  'FT-EAP-SHA384': 'FT-EAP-SHA384',
  SAE: 'SAE',
  'SAE-EXT-KEY': 'SAE-EXT-KEY',
  'EAP-SUITE-B': 'SUITE-B',
  'SUITE-B': 'SUITE-B',
  'EAP-SUITE-B-192': 'SUITE-B-192',
  'SUITE-B-192': 'SUITE-B-192',
  OWE: 'OWE',
  'OWE-TRANSITION': 'OWE',
  DPP: 'DPP',
  OSEN: 'OSEN',
  PASN: 'PASN',
  CCKM: 'CCKM',
  'WAPI-PSK': 'WAPI-PSK',
  'WAPI-CERT': 'WAPI-CERT',
  CERT: 'WAPI-CERT',
  'FILS-SHA256': 'FILS-SHA256',
  'EAP-FILS-SHA256': 'FILS-SHA256',
  'FILS-SHA384': 'FILS-SHA384',
  'EAP-FILS-SHA384': 'FILS-SHA384',
  'FT-FILS-SHA256': 'FT-FILS-SHA256',
  'FT/FILS-SHA256': 'FT-FILS-SHA256',
  'FT-FILS-SHA384': 'FT-FILS-SHA384',
  'FT/FILS-SHA384': 'FT-FILS-SHA384',
};

const CIPHER_WORDS = {
  CCMP: 'CCMP',
  'CCMP-128': 'CCMP',
  'CCMP-256': 'CCMP-256',
  TKIP: 'TKIP',
  GCMP: 'GCMP-128',
  'GCMP-128': 'GCMP-128',
  'GCMP-256': 'GCMP-256',
  SMS4: 'SMS4',
  WEP40: 'WEP-40',
  'WEP-40': 'WEP-40',
  WEP104: 'WEP-104',
  'WEP-104': 'WEP-104',
};

// Nomes compostos têm hífen dentro ("PSK-SHA256", "GCMP-256"), então a leitura tenta
// sempre a palavra mais longa primeiro.
const WORDS = [...new Set([...Object.keys(AKM_WORDS), ...Object.keys(CIPHER_WORDS)])].sort(
  (a, b) => b.length - a.length,
);

const SECTION = /^(WPA2|WPA|RSNO\d*|RSN|OSEN|WAPI)(?:-(.*))?$/;
// Flags que o Android/wpa_supplicant também escrevem entre colchetes.
const OTHER_FLAGS = new Set(['RSNO', 'HS20', 'FILS', 'UTF-8', 'SAE-H2E', 'SAE-PK', 'DMG', 'EDMG', 'PBSS', 'FST', 'OWE-TRANS']);

const PERSONAL_AKMS = new Set([
  'PSK', 'FT-PSK', 'PSK-SHA256', 'PSK-SHA384', 'FT-PSK-SHA384',
  'SAE', 'FT-SAE', 'SAE-EXT-KEY', 'FT-SAE-EXT-KEY', 'WAPI-PSK',
]);
const ENTERPRISE_AKMS = new Set([
  'EAP', 'FT-EAP', 'EAP-SHA256', 'EAP-SHA384', 'FT-EAP-SHA384', 'SUITE-B', 'SUITE-B-192',
  'FILS-SHA256', 'FILS-SHA384', 'FT-FILS-SHA256', 'FT-FILS-SHA384', 'WAPI-CERT', 'OSEN', 'CCKM',
]);
// AKMs que só existem no WPA3 (SAE e a família de 192 bits).
const WPA3_AKMS = new Set(['SAE', 'FT-SAE', 'SAE-EXT-KEY', 'FT-SAE-EXT-KEY', 'SUITE-B', 'SUITE-B-192', 'FT-EAP-SHA384']);
// AKMs que não dizem qual é a "geração" da rede.
const NEUTRAL_AKMS = new Set(['OWE', 'DPP', 'PASN', 'OSEN', 'EAP-SHA256']);
const AES_CIPHERS = new Set(['CCMP', 'CCMP-256', 'GCMP-128', 'GCMP-256']);
const PMF_VALUES = new Set(['required', 'capable', 'none', 'unknown']);

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

const ISSUE_TEXT = {
  open: 'Rede aberta, sem senha e sem criptografia: quem estiver por perto pode ver o que você envia e recebe.',
  wep: 'WEP é uma proteção ultrapassada que pode ser quebrada em poucos minutos; troque para WPA2 ou WPA3 no roteador.',
  'tkip-only':
    'A rede só oferece WPA/TKIP, um padrão antigo e frágil que ainda limita a velocidade a 54 Mbps; mude o roteador para WPA2 (AES) ou WPA3.',
  'tkip-mixed':
    'O modo antigo WPA/TKIP continua ligado junto com o AES, o que enfraquece a rede; deixe só WPA2 (AES) ou WPA3 no roteador.',
  wps: 'O WPS está ligado: esse atalho para conectar por botão ou PIN é uma brecha conhecida; desligue no roteador se não usa.',
  'wps-locked': 'O WPS está ligado, mas travado contra tentativas de PIN; se ninguém usa, o melhor é desligar no roteador.',
  'no-pmf':
    'A rede não protege os quadros de gerenciamento (PMF), então alguém por perto consegue derrubar a conexão dos aparelhos de propósito.',
  'wpa3-transition':
    'Modo de transição WPA2/WPA3: aparelhos antigos ainda entram com WPA2, então a rede não tem toda a proteção do WPA3.',
  owe: 'Rede sem senha: a conexão é criptografada (OWE), mas qualquer pessoa pode entrar nela.',
  'owe-transition':
    'Rede aberta em modo de transição: aparelhos novos usam criptografia (OWE), mas os antigos conectam sem proteção nenhuma.',
};

function pushUnique(list, value) {
  if (value != null && !list.includes(value)) list.push(value);
}

function cleanList(value) {
  const out = [];
  if (Array.isArray(value)) for (const v of value) if (typeof v === 'string' && v) pushUnique(out, v);
  return out;
}

function cloneSection(section) {
  if (!section || typeof section !== 'object') return null;
  return { akms: cleanList(section.akms), ciphers: cleanList(section.ciphers) };
}

function emptyParts() {
  return {
    known: false,
    wep: false,
    sections: { wpa: null, rsn: null, wapi: null, osen: null },
    oweTransition: false,
    pmf: null, // null = decidir pelo que existir
    wps: false,
    wpsLocked: null,
    ess: false,
    adhoc: false,
    p2p: false,
    mesh: false,
    groupCipher: null,
    fromIes: false,
  };
}

/** Lê o miolo de um bloco ("PSK+SAE-CCMP") e junta os AKMs e as cifras em `section`. */
function readWords(body, section, kind) {
  let oweTransition = false;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '-' || c === '+') {
      i += 1;
      continue;
    }
    let hit = null;
    for (const word of WORDS) {
      if (!body.startsWith(word, i)) continue;
      const end = i + word.length;
      if (end === body.length || body[end] === '-' || body[end] === '+') {
        hit = word;
        break;
      }
    }
    if (hit === null) {
      // palavra desconhecida ("?", "None", "preauth", algo futuro): pula até o próximo separador
      while (i < body.length && body[i] !== '-' && body[i] !== '+') i += 1;
      continue;
    }
    if (hit in AKM_WORDS) {
      let akm = AKM_WORDS[hit];
      // alguns aparelhos escrevem "[WAPI-PSK-SMS4]" em vez de "[WAPI-WAPI-PSK-SMS4]"
      if (kind === 'wapi' && akm === 'PSK') akm = 'WAPI-PSK';
      pushUnique(section.akms, akm);
      if (hit === 'OWE-TRANSITION') oweTransition = true;
    } else {
      pushUnique(section.ciphers, CIPHER_WORDS[hit]);
    }
    i += hit.length;
  }
  return oweTransition;
}

function sectionKind(prefix) {
  if (prefix === 'WPA') return 'wpa';
  if (prefix === 'WAPI') return 'wapi';
  if (prefix === 'OSEN') return 'osen';
  return 'rsn'; // WPA2, RSN, RSNO
}

/** Separa "[A][B]..." nos blocos; sem colchetes, aceita espaços ou vírgulas. */
function splitBlocks(text) {
  const blocks = [];
  const re = /\[([^[\]]*)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  if (blocks.length === 0) for (const piece of text.split(/[\s,;]+/)) if (piece) blocks.push(piece);
  return blocks;
}

function readCapabilities(text, parts) {
  let mfpr = false;
  let mfpc = false;
  let oweOpenSide = false;
  for (const raw of splitBlocks(text)) {
    const block = raw.trim().toUpperCase().replace(/_/g, '-');
    if (!block) continue;
    const m = SECTION.exec(block);
    if (m && !(m[1].startsWith('RSNO') && m[2] === undefined)) {
      const kind = sectionKind(m[1]);
      const section = parts.sections[kind] || (parts.sections[kind] = { akms: [], ciphers: [] });
      if (readWords(m[2] || '', section, kind)) parts.oweTransition = true;
      parts.known = true;
      continue;
    }
    let recognized = true;
    if (block === 'ESS') parts.ess = true;
    else if (block === 'IBSS') parts.adhoc = true;
    else if (block === 'WPS' || block.startsWith('WPS-')) parts.wps = true;
    else if (block === 'MFPR') mfpr = true;
    else if (block === 'MFPC') mfpc = true;
    else if (block === 'P2P') parts.p2p = true;
    else if (block === 'MESH') parts.mesh = true;
    else if (block === 'WEP' || /^WEP-?\d/.test(block)) parts.wep = true;
    // forma do wpa_supplicant para o lado aberto do par "aberta + OWE"
    else if (block === 'OWE-TRANS-OPEN') oweOpenSide = true;
    // estes existem, mas não mudam a análise
    else recognized = OTHER_FLAGS.has(block);
    // Só um texto com pelo menos um bloco conhecido vale como leitura: lixo não vira "rede aberta".
    if (recognized) parts.known = true;
  }
  if (oweOpenSide && !parts.sections.rsn) {
    parts.sections.rsn = { akms: ['OWE'], ciphers: ['CCMP'] };
    parts.oweTransition = true;
  }
  if (mfpr) parts.pmf = 'required';
  else if (mfpc) parts.pmf = 'capable';
}

/** Protocolos anunciados pelo elemento RSN, conforme os AKMs. */
function rsnGenerations(rsn, pmf) {
  const akms = new Set(rsn.akms);
  let wpa2 = false;
  let wpa3 = false;
  for (const akm of akms) {
    if (WPA3_AKMS.has(akm)) wpa3 = true;
    else if (!NEUTRAL_AKMS.has(akm)) wpa2 = true;
  }
  if (akms.has('EAP-SHA256')) {
    // Mesma regra do Android (ScanResultUtil): só é WPA3-Empresarial com PMF obrigatório e sem
    // o AKM antigo; os dois AKMs com PMF opcional é a transição empresarial.
    const tkip = rsn.ciphers.includes('TKIP');
    if (!akms.has('EAP') && pmf === 'required' && !tkip) wpa3 = true;
    else if (akms.has('EAP') && pmf === 'capable' && !tkip) wpa3 = true;
    else wpa2 = true;
  }
  // RSN sem AKM reconhecido ("[WPA2--CCMP]", "[RSN-?-CCMP]"): é no mínimo uma rede WPA2
  if (akms.size === 0) wpa2 = true;
  return { wpa2, wpa3, owe: akms.has('OWE') };
}

function buildLabel(s, onlySuiteB192) {
  if (!s.known) return 'Desconhecida';
  const generations = s.protocols.filter((p) => p === 'WEP' || p === 'WPA' || p === 'WPA2' || p === 'WPA3');
  if (generations.length > 0) {
    const base = generations.join('/');
    if (s.enterprise && s.personal) return `${base} Pessoal/Empresarial`;
    if (s.enterprise) return onlySuiteB192 ? `${base} Empresarial 192 bits` : `${base} Empresarial`;
    return base;
  }
  if (s.protocols.includes('OWE')) return s.oweTransition ? 'Aberta/OWE' : 'Aberta (OWE)';
  if (s.protocols.includes('WAPI')) return 'WAPI';
  if (s.akms.includes('DPP')) return 'Easy Connect (DPP)';
  if (s.akms.includes('OSEN')) return 'OSEN';
  return 'Aberta';
}

function buildLevel(s) {
  const { wpa, rsn, wapi, osen } = s.sections;
  if (!s.known) return 0;
  if (!s.encrypted && !s.oweTransition) return 0;
  if (!wpa && !rsn && !wapi && !osen) return 1; // só WEP
  if (!rsn) return wpa ? 2 : 3; // só WPA1 é fraca; WAPI/OSEN contam como "boa"
  // RSN só com TKIP continua fraco, mesmo se chamando "WPA2"
  if (rsn.ciphers.length > 0 && !rsn.ciphers.some((c) => AES_CIPHERS.has(c))) return 2;
  if (s.oweTransition) return 3;
  const strong =
    s.protocols.includes('WPA3') ||
    s.protocols.includes('OWE') ||
    rsn.akms.some((a) => ENTERPRISE_AKMS.has(a)) ||
    rsn.akms.includes('DPP');
  return strong ? 4 : 3;
}

function buildIssues(s) {
  const issues = [];
  const add = (code, severity, textCode = code) => issues.push({ code, severity, text: ISSUE_TEXT[textCode] });
  const { wpa, rsn } = s.sections;
  const aes = s.ciphers.some((c) => AES_CIPHERS.has(c));
  const tkip = s.ciphers.includes('TKIP') || s.groupCipher === 'TKIP';

  if (!s.known) return issues;
  if (s.oweTransition) add('owe-transition', 'medium');
  else if (s.open && !s.encrypted) add('open', 'high');
  else if (s.open) add('owe', 'low');

  if (s.protocols.includes('WEP')) add('wep', 'high');
  if (wpa || rsn) {
    if (s.level === 2) add('tkip-only', 'high');
    else if ((wpa && rsn) || (tkip && aes)) add('tkip-mixed', 'medium');
  }
  // No Wi-Fi Direct o WPS faz parte do pareamento, então lá não é defeito.
  if (s.wps && s.personal && !s.p2p) {
    if (s.wpsLocked === true) add('wps', 'low', 'wps-locked');
    else add('wps', 'medium');
  }
  if (s.protocols.includes('WPA2') && s.protocols.includes('WPA3')) add('wpa3-transition', 'low');
  else if (s.pmf === 'none' && s.protocols.includes('WPA2')) add('no-pmf', 'low');

  return issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** Monta o objeto Security completo a partir das partes já lidas. */
function build(parts) {
  const sections = {
    wpa: cloneSection(parts.sections.wpa),
    rsn: cloneSection(parts.sections.rsn),
    wapi: cloneSection(parts.sections.wapi),
    osen: cloneSection(parts.sections.osen),
  };
  const { wpa, rsn, wapi, osen } = sections;

  // PMF só existe com RSN. Sem as flags não dá para afirmar nada sobre uma rede RSN: o
  // Android só passou a escrevê-las sempre a partir do 14 (veja parseCapabilities).
  let pmf = PMF_VALUES.has(parts.pmf) ? parts.pmf : null;
  if (!rsn) pmf = parts.known ? 'none' : 'unknown';
  else if (pmf === null) pmf = 'unknown';

  const protocols = [];
  const gen = rsn ? rsnGenerations(rsn, pmf) : { wpa2: false, wpa3: false, owe: false };
  if (parts.wep) protocols.push('WEP');
  if (wpa) protocols.push('WPA');
  if (gen.wpa2) protocols.push('WPA2');
  if (gen.wpa3) protocols.push('WPA3');
  if (gen.owe) protocols.push('OWE');
  if (wapi) protocols.push('WAPI');

  const akms = [];
  const ciphers = [];
  for (const section of [wpa, rsn, wapi, osen]) {
    if (!section) continue;
    for (const a of section.akms) pushUnique(akms, a);
    for (const c of section.ciphers) pushUnique(ciphers, c);
  }

  const oweTransition = !!parts.oweTransition && !!rsn;
  const noCredential = !!rsn && rsn.akms.length > 0 && rsn.akms.every((a) => a === 'OWE');
  const plain = !parts.wep && !wpa && !rsn && !wapi && !osen;

  const s = {
    known: !!parts.known,
    protocols,
    akms,
    ciphers,
    groupCipher: typeof parts.groupCipher === 'string' ? parts.groupCipher : null,
    personal: akms.some((a) => PERSONAL_AKMS.has(a)) || (!!parts.wep && !wpa && !rsn),
    enterprise: akms.some((a) => ENTERPRISE_AKMS.has(a)),
    open: !!parts.known && !parts.wep && !wpa && !wapi && !osen && (plain || noCredential),
    encrypted: !!parts.known && !plain && !oweTransition,
    transition: (gen.wpa2 && gen.wpa3) || oweTransition,
    oweTransition,
    wps: !!parts.wps,
    wpsLocked: typeof parts.wpsLocked === 'boolean' ? parts.wpsLocked : null,
    pmf,
    adhoc: !!parts.adhoc,
    ess: !!parts.ess,
    p2p: !!parts.p2p,
    mesh: !!parts.mesh,
    fastRoaming: akms.some((a) => a.startsWith('FT-')),
    label: '',
    level: 0,
    issues: [],
    sections,
    fromIes: !!parts.fromIes,
  };
  const enterpriseAkms = akms.filter((a) => ENTERPRISE_AKMS.has(a));
  s.label = buildLabel(s, enterpriseAkms.length > 0 && enterpriseAkms.every((a) => a === 'SUITE-B-192'));
  s.level = buildLevel(s);
  s.issues = buildIssues(s);
  return s;
}

/**
 * Interpreta ScanResult.capabilities.
 *
 * Sobre o PMF: sem [MFPR]/[MFPC] uma rede WPA2/WPA3 fica com pmf 'unknown', porque o
 * Android 12 e 13 só escrevem essas flags quando o beacon traz a cifra de gerenciamento
 * de grupo (muitos roteadores com PMF não trazem) e o Android 11 ou anterior nunca escreve.
 * A partir do Android 14 (API 34) elas são sempre escritas; passando `options.sdk`, a
 * ausência vira 'none'. Com os elementos do beacon, refineWithIes dá o valor exato.
 *
 * @param {string} capabilities
 * @param {{sdk?: number}} [options]  Build.VERSION.SDK_INT do celular, se conhecido
 * @returns {Security}
 */
export function parseCapabilities(capabilities, options) {
  const parts = emptyParts();
  try {
    if (typeof capabilities === 'string') readCapabilities(capabilities, parts);
    const sdk = options && typeof options === 'object' ? options.sdk : undefined;
    if (parts.pmf === null && parts.sections.rsn && Number.isFinite(sdk) && sdk >= 34) parts.pmf = 'none';
  } catch {
    // texto estranho demais: fica com o que já foi lido
  }
  return build(parts);
}

function partsFromSecurity(security) {
  const parts = emptyParts();
  if (!security || typeof security !== 'object') return parts;
  const sections = security.sections && typeof security.sections === 'object' ? security.sections : {};
  parts.known = security.known !== false && (security.known === true || Array.isArray(security.protocols));
  parts.wep = Array.isArray(security.protocols) && security.protocols.includes('WEP');
  parts.sections = {
    wpa: cloneSection(sections.wpa),
    rsn: cloneSection(sections.rsn),
    wapi: cloneSection(sections.wapi),
    osen: cloneSection(sections.osen),
  };
  parts.oweTransition = security.oweTransition === true;
  parts.pmf = PMF_VALUES.has(security.pmf) && security.pmf !== 'unknown' ? security.pmf : null;
  parts.wps = security.wps === true;
  parts.wpsLocked = typeof security.wpsLocked === 'boolean' ? security.wpsLocked : null;
  parts.ess = security.ess === true;
  parts.adhoc = security.adhoc === true;
  parts.p2p = security.p2p === true;
  parts.mesh = security.mesh === true;
  parts.groupCipher = typeof security.groupCipher === 'string' ? security.groupCipher : null;
  parts.fromIes = security.fromIes === true;
  return parts;
}

/** Cifras par a par de um elemento RSN/WPA; "usar a de grupo" vira a própria cifra de grupo. */
function pairwiseOf(element) {
  const out = [];
  const group = typeof element.groupCipher === 'string' ? element.groupCipher : null;
  for (const c of cleanList(element.pairwiseCiphers)) {
    if (c === 'USE-GROUP') pushUnique(out, group);
    else if (c !== 'NONE' && c !== 'NO-GROUP') pushUnique(out, c);
  }
  return out;
}

/**
 * Troca o que foi deduzido do texto pelo que os elementos do beacon dizem de fato
 * (resultado de parseIes): AKMs e cifras do RSN e do WPA, PMF exato, cifra de grupo, WPS
 * (e se o PIN está travado) e a transição OWE. Sem esses elementos devolve o mesmo conteúdo.
 * Não altera os objetos recebidos.
 *
 * @param {Security} security  resultado de parseCapabilities
 * @param {object} ieInfo      resultado de parseIes (app/js/core/ies.js)
 * @returns {Security}
 */
export function refineWithIes(security, ieInfo) {
  const parts = partsFromSecurity(security);
  try {
    if (ieInfo && typeof ieInfo === 'object') {
      const rsn = ieInfo.rsn && typeof ieInfo.rsn === 'object' ? ieInfo.rsn : null;
      const wpa = ieInfo.wpa && typeof ieInfo.wpa === 'object' ? ieInfo.wpa : null;
      const wps = ieInfo.wps && typeof ieInfo.wps === 'object' ? ieInfo.wps : null;
      const owe = ieInfo.oweTransition && typeof ieInfo.oweTransition === 'object' ? ieInfo.oweTransition : null;

      if (rsn) {
        const section = { akms: cleanList(rsn.akms), ciphers: pairwiseOf(rsn) };
        // "RSNE Override" (modo de compatibilidade do WPA3): AKMs novos que o roteador esconde
        // dos aparelhos antigos. O Android 16 também os soma à lista.
        for (const extra of [ieInfo.rsnOverride, ieInfo.rsnOverride2]) {
          if (!extra || typeof extra !== 'object') continue;
          for (const a of cleanList(extra.akms)) pushUnique(section.akms, a);
          for (const c of pairwiseOf(extra)) pushUnique(section.ciphers, c);
        }
        parts.sections.rsn = section;
        parts.pmf = rsn.pmfRequired === true ? 'required' : rsn.pmfCapable === true ? 'capable' : 'none';
        parts.groupCipher = typeof rsn.groupCipher === 'string' ? rsn.groupCipher : null;
        parts.oweTransition = false; // quem tem RSN próprio não é o lado aberto do par
      } else if (owe) {
        // lado aberto do par "aberta + OWE": mesma leitura que o Android faz ([RSN-OWE_TRANSITION-CCMP])
        parts.sections.rsn = { akms: ['OWE'], ciphers: ['CCMP'] };
        parts.oweTransition = true;
      }
      if (wpa) {
        parts.sections.wpa = { akms: cleanList(wpa.akms), ciphers: pairwiseOf(wpa) };
        if (!rsn && typeof wpa.groupCipher === 'string') parts.groupCipher = wpa.groupCipher;
      }
      if (rsn || wpa || owe) {
        parts.known = true;
        parts.wep = false; // o Android só chama de WEP quando não há RSN nem WPA
        parts.fromIes = true;
      }
      if (wps) {
        parts.wps = true;
        parts.wpsLocked = wps.locked === true;
      }
    }
  } catch {
    // ieInfo fora do formato: mantém a leitura do texto
  }
  return build(parts);
}

// WifiInfo.SECURITY_TYPE_* (Android 12+), conferido em developer.android.com.
const SECURITY_TYPE_LABELS = {
  '-1': 'Desconhecida',
  0: 'Aberta',
  1: 'WEP',
  2: 'WPA/WPA2 Pessoal',
  3: 'WPA/WPA2 Empresarial',
  4: 'WPA3 Pessoal',
  5: 'WPA3 Empresarial 192 bits',
  6: 'Aberta (OWE)',
  7: 'WAPI Pessoal',
  8: 'WAPI Certificado',
  9: 'WPA3 Empresarial',
  10: 'OSEN',
  11: 'Passpoint R1/R2',
  12: 'Passpoint R3',
  13: 'Easy Connect (DPP)',
};

/**
 * Rótulo em pt-BR para WifiInfo.getCurrentSecurityType() (Connection.securityType).
 * @param {number} n  SECURITY_TYPE_*; qualquer outro valor vira "Desconhecida"
 * @returns {string}
 */
export function securityTypeLabel(n) {
  const key = typeof n === 'number' && Number.isInteger(n) ? String(n) : typeof n === 'string' ? n.trim() : '';
  return Object.prototype.hasOwnProperty.call(SECURITY_TYPE_LABELS, key) ? SECURITY_TYPE_LABELS[key] : 'Desconhecida';
}
