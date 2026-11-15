// Gera app/assets/oui.json: a tabela "prefixo do MAC -> fabricante" que o app consulta sem internet.
//
//   npm install && npm run oui            (reescreve app/assets/oui.json)
//   node tools/build-oui.mjs --stats      (mostra números e amostras, sem gravar nada)
//   node tools/build-oui.mjs --out <arq>  (grava em outro lugar; usado pelos testes)
//
// Fonte: pacote npm "oui-data" (https://github.com/silverwind/oui-data), licença BSD-2-Clause
// (permissiva; copyright (c) silverwind). Ele só reempacota o cadastro público da IEEE
// Registration Authority (blocos MA-L de 24 bits, MA-M de 28 e MA-S de 36). A versão fica travada
// no package.json para que o arquivo gerado seja reproduzível byte a byte.
//
// O que este script faz com o cadastro:
//   1. fica só com o nome do fabricante (o endereço postal é jogado fora);
//   2. limpa o nome para caber numa lista estreita de celular (cleanName);
//   3. grava tudo num formato compacto que js/core/oui.js sabe ler (o formato está descrito lá).
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { OUI_FORMAT, NAME_SEPARATOR, encodeVlq, createOuiLookup } from '../app/js/core/oui.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(ROOT, 'app/assets/oui.json');

/** Nomes mais longos que isto são cortados numa fronteira de palavra (a lista do celular é estreita). */
export const MAX_NAME_LENGTH = 32;

// ---------------------------------------------------------------------------
// Limpeza dos nomes
// ---------------------------------------------------------------------------

// Registros que não dizem quem fabricou: bloco com dono sigiloso e blocos que a própria IEEE
// reparte em pedaços menores (o dono de verdade aparece nas tabelas de 28 e 36 bits).
const DROP = [/^private$/i, /^ieee registration authority\b/i];

// Marcas conhecidas: [padrão sobre o nome do cadastro, nome como as pessoas conhecem].
// A primeira que casar vence. Os padrões são ancorados de propósito, para não engolir empresas
// de nome parecido ("Harris" não é Arris, "BroadLink" não é D-Link, "Intelbras" não é Intel).
const BRANDS = [
  // Roteadores e modems comuns no Brasil
  [/^tp-?link\b/i, 'TP-Link'],
  [/^mercusys\b/i, 'Mercusys'],
  [/^intelbras\b/i, 'Intelbras'],
  [/^multilaser\b/i, 'Multilaser'],
  [/^elsys\b/i, 'Elsys'],
  [/^d-?link\b/i, 'D-Link'],
  [/\btenda technology\b/i, 'Tenda'],
  [/^totolink\b/i, 'Totolink'],
  [/^(routerboard\.com|mikrotik)/i, 'MikroTik'],
  [/^ubiquiti\b/i, 'Ubiquiti'],
  [/^huawei (technologies|device)\b/i, 'Huawei'],
  [/^zte corporation$/i, 'ZTE'],
  [/fiberhome/i, 'FiberHome'],
  [/^nokia\b/i, 'Nokia'],
  [/^alcatel[- ]lucent\b/i, 'Alcatel-Lucent'],
  [/^sagemcom\b/i, 'Sagemcom'],
  [/^askey\b/i, 'Askey'],
  [/^mitrastar\b/i, 'MitraStar'],
  [/^arcadyan\b/i, 'Arcadyan'],
  [/^zyxel\b/i, 'Zyxel'],
  // A IEEE renomeou os blocos da ARRIS para "Commscope" e os da Technicolor para "Vantiva",
  // mas no aparelho (e na cabeça das pessoas) continua escrito Arris / Technicolor.
  [/^arris\b/i, 'Arris'],
  [/^commscope$/i, 'Arris (CommScope)'],
  [/^commscope\b/i, 'CommScope'],
  [/^technicolor\b/i, 'Technicolor'],
  [/^vantiva\b/i, 'Technicolor (Vantiva)'],
  [/^(the )?linksys (group|usa)\b|^cisco-linksys\b/i, 'Linksys'],
  [/^belkin\b/i, 'Belkin'],
  [/^netgear\b/i, 'Netgear'],
  [/^asustek computer\b/i, 'Asus'],
  [/^cisco meraki\b/i, 'Cisco Meraki'],
  [/^cisco (systems|spvtg)\b/i, 'Cisco'],
  [/^ruckus\b/i, 'Ruckus'],
  // Os blocos da Aruba hoje estão no nome da HPE.
  [/^hewlett packard enterprise$/i, 'HPE / Aruba'],
  [/^(hewlett[- ]packard( company)?|hp inc\.?)$/i, 'HP'],
  [/^juniper networks\b/i, 'Juniper'],
  [/^extreme networks\b/i, 'Extreme Networks'],
  [/\bh3c\b/i, 'H3C'],
  [/^avm (audiovisuelles|gmbh)\b/i, 'AVM'],
  [/^eero\b/i, 'eero'],
  [/^nest labs\b/i, 'Google Nest'],
  [/^google\b/i, 'Google'],
  [/^amazon(\.com)?\b/i, 'Amazon'],
  [/^ring llc$/i, 'Ring'],
  // Celulares, computadores e TVs
  [/^apple,? inc\.?$/i, 'Apple'],
  [/^samsung electro(nics|[- ]mechanics)\b/i, 'Samsung'],
  [/^(beijing )?xiaomi (communications|mobile software|electronics|inc)\b/i, 'Xiaomi'],
  [/^motorola ?\(wuhan\)|^motorola mobility\b/i, 'Motorola'],
  [/^motorola solutions\b/i, 'Motorola Solutions'],
  [/^guangdong oppo\b/i, 'OPPO'],
  [/^vivo mobile\b/i, 'vivo'],
  [/^realme\b/i, 'realme'],
  [/^oneplus\b/i, 'OnePlus'],
  [/^honor device\b/i, 'Honor'],
  [/^infinix\b/i, 'Infinix'],
  [/^tecno mobile\b/i, 'Tecno'],
  [/^itel mobile\b/i, 'itel'],
  [/^lg electronics\b/i, 'LG'],
  [/^sony\b(?! ericsson)/i, 'Sony'],
  [/^microsoft\b/i, 'Microsoft'],
  [/^nintendo\b/i, 'Nintendo'],
  [/^dell\b/i, 'Dell'],
  [/^lenovo\b/i, 'Lenovo'],
  [/^(tct mobile|tcl)\b/i, 'TCL'],
  [/^positivo\b/i, 'Positivo'],
  [/^roku\b/i, 'Roku'],
  [/skyworth|chuangwei-rgb/i, 'Skyworth'], // Chuangwei é o nome chinês da Skyworth
  [/\bhisense\b/i, 'Hisense'],
  [/\bhaier\b/i, 'Haier'],
  [/^panasonic\b/i, 'Panasonic'],
  [/^seiko epson\b/i, 'Epson'],
  [/^brother industries\b/i, 'Brother'],
  [/^garmin\b/i, 'Garmin'],
  [/\bdji\b/i, 'DJI'],
  [/^sonos\b/i, 'Sonos'],
  // Chips e módulos Wi-Fi
  [/^espressif\b/i, 'Espressif'],
  [/^realtek\b/i, 'Realtek'],
  [/^intel (corporate|corporation|wireless)\b/i, 'Intel'],
  [/^qualcomm\b/i, 'Qualcomm'],
  [/^atheros\b/i, 'Atheros'],
  [/^broadcom\b/i, 'Broadcom'],
  [/^mediatek\b/i, 'MediaTek'],
  [/^texas instruments\b/i, 'Texas Instruments'],
  [/^hon hai precision\b/i, 'Foxconn'],
  [/^murata manufacturing\b/i, 'Murata'],
  [/^azurewave\b/i, 'AzureWave'],
  [/^alps ?alpine\b/i, 'Alps Alpine'],
  [/^giga-?byte\b/i, 'Gigabyte'],
  [/^micro-star int/i, 'MSI'],
  [/^nvidia\b/i, 'NVIDIA'],
  [/^3com\b/i, '3Com'],
  [/^annapurna labs\b/i, 'Annapurna Labs'],
  [/^lite-?on\b/i, 'Lite-On'],
  [/^tuya smart\b/i, 'Tuya'],
  // Câmeras
  [/hikvision/i, 'Hikvision'],
  [/ezviz/i, 'EZVIZ'],
  [/^zhejiang dahua\b/i, 'Dahua'],
];

// Formas jurídicas (já sem pontos e em minúsculas) que só ocupam espaço no fim do nome.
const LEGAL = new Set(
  (
    'co company ltd limited ltda lda limitada inc incorporated incorporation corp corporation corporate ' +
    'llc llp lp plc gmbh mbh ag kg ohg sa sas sarl sau sasu spa srl sl slu bv bvba nv ab as a/s asa aps ' +
    'oy oyj pty pte pvt private kk kft zrt sro doo dd sdn bhd jsc ojsc pjsc cjsc ooo tbk s/a p/l uab sia ' +
    'aş şti eirl eireli coltd cokg pteltd ptyltd gmbh&cokg'
  ).split(' '),
);
// Formas jurídicas inconfundíveis: no meio do nome, o que vem depois delas é divisão, filial ou
// descrição ("Foo GmbH Fernwartungssysteme", "Foo S/A Indústria de Implementos Agrícolas").
const HARD_LEGAL =
  /^(gmbh|ltd|ltda|limited|inc|incorporated|llc|corp|corporation|plc|s\.a\.?|s\/a|s\.p\.a\.?|s\.r\.l\.?|b\.v\.?|n\.v\.?|a\/s)[.,]*$/i;
// Ligações que sobram penduradas depois de tirar a forma jurídica ("GmbH & Co. KG", "Smith and Co.").
const DANGLING = new Set('& + - – and und et e y ve de do da of for für the'.split(' '));
// "Technologies" e parentes saem do fim, mas só se o que sobra ainda identifica alguém.
const FILLER = new Set(['technologies', 'technology', 'tech', 'tecnologia', 'technologie']);
const TOO_GENERIC = new Set(
  (
    'advanced applied digital general global information integrated international micro mobile network new ' +
    'smart united wireless communication communications electronic electronics industrial intelligent ' +
    'science sciences security power energy data system systems'
  ).split(' '),
);
// Siglas de três letras que parecem palavra (consoante-vogal-consoante) mas continuam em maiúsculas.
const KEEP_UPPER = new Set('led lan wan pon sim ram rom pos cad nec sap tec'.split(' '));
// Palavras que ficam em minúsculas no meio de um nome que veio todo em maiúsculas.
const SMALL_WORDS = new Set(
  'and of the for de da do dos das del di la le el et und von van der e y by in on to em'.split(' '),
);

const bare = (token) =>
  token
    .toLowerCase()
    .replace(/[.,;:]/g, '')
    .replace(/[/\\-]+$/, '');
/** A palavra sozinha ainda diz de quem se trata? ("Zebra" sim; "Digital" ou "Life" não.) */
const isDistinctive = (token) => bare(token).length >= 5 && !TOO_GENERIC.has(bare(token));

/**
 * Tira formas jurídicas e pontuação do fim; as ligações só saem se algo já saiu depois delas
 * (`loose` = já saiu). Nunca devolve a lista vazia.
 */
function stripTail(tokens, loose = false) {
  while (tokens.length > 1) {
    const last = bare(tokens[tokens.length - 1]);
    if (last === '' || LEGAL.has(last)) loose = true;
    else if (!(loose && DANGLING.has(last))) break;
    tokens.pop();
  }
  return tokens;
}

/**
 * "Foo Technologies" -> "Foo", "Foo Science & Technology" -> "Foo"; mas "Institute of Technology"
 * e "Digital Technology" ficam, porque sem a palavra o nome não diz mais nada.
 */
function stripFiller(tokens) {
  const n = tokens.length;
  if (n < 2 || !FILLER.has(bare(tokens[n - 1]))) return tokens;
  let keep = n - 1;
  if (/^(and|&|e|y|und|et)$/i.test(tokens[keep - 1])) {
    keep--;
    if (keep > 1 && /^sci(ence)?\.?$/i.test(tokens[keep - 1])) keep--;
  } else if (/^(of|for|de|di|für|in)$/i.test(tokens[keep - 1])) {
    return tokens;
  }
  if (keep < 1 || (keep === 1 && !isDistinctive(tokens[0]))) return tokens;
  return stripTail(tokens.slice(0, keep), true);
}

/** "HANGZHOU FOO ELECTRONICS" -> "Hangzhou Foo Electronics"; siglas curtas ou sem vogal ficam como estão. */
function fixShouting(tokens) {
  return tokens.map((token, i) =>
    token
      .split(/(?<=[-/&+])|(?=[-/&+])/)
      .map((part) => {
        const letters = part.replace(/[^\p{L}]/gu, '');
        if (!letters || /\d/.test(part)) return part;
        const lower = part.toLowerCase().replace(/i\u0307/g, 'i'); // o "İ" turco vira "i" + ponto solto
        if (SMALL_WORDS.has(lower)) return i === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
        // Sem vogal ou com até duas letras é sigla: "HMD", "LG".
        if (!/[aeiouyà-ü]/i.test(letters) || letters.length < 3) return part;
        // Três letras: no começo do nome quase sempre é sigla ("NEC", "RIM"); depois, palavra ("VIET NAM").
        const word = i > 0 && /^[^aeiou][aeiou][^aeiou]$/i.test(letters) && !KEEP_UPPER.has(lower);
        if (letters.length === 3 && !word) return part;
        return part[0] + lower.slice(1);
      })
      .join(''),
  );
}

/** Nome todo em minúsculas e com mais de uma palavra: quem cadastrou só não usou o Shift. */
function fixWhisper(tokens) {
  return tokens.map((token, i) =>
    i > 0 && SMALL_WORDS.has(token) ? token : token.replace(/^\p{Ll}/u, (c) => c.toUpperCase()),
  );
}

/** Corta numa fronteira de palavra para caber em MAX_NAME_LENGTH. */
function clip(tokens) {
  if (tokens.join(' ').length <= MAX_NAME_LENGTH) return tokens;
  const kept = [tokens[0].slice(0, MAX_NAME_LENGTH)];
  let length = kept[0].length;
  for (let i = 1; i < tokens.length && length + 1 + tokens[i].length <= MAX_NAME_LENGTH; i++) {
    kept.push(tokens[i]);
    length += 1 + tokens[i].length;
  }
  // O corte pode deixar no fim um "de", um "&" ou uma forma jurídica que estava no meio.
  return stripTail(kept, true);
}

/** Acerta maiúsculas/minúsculas, junta as palavras e tira a pontuação que sobrou no fim. */
function finish(tokens) {
  tokens = clip(tokens);
  const letters = tokens.join('').replace(/[^\p{L}]/gu, '');
  const upper = letters.toUpperCase();
  const lower = letters.toLowerCase();
  if (upper !== lower) {
    // Só mexe quando o nome inteiro veio num caso só; nome misto fica como o fabricante escreveu.
    if (letters === upper) tokens = fixShouting(tokens);
    else if (letters === lower && tokens.length > 1) tokens = fixWhisper(tokens);
  }
  return tokens.join(' ').replace(/[\s.,;:&+/-]+$/, '');
}

/**
 * Nome do cadastro da IEEE -> nome curto para mostrar. Devolve '' para registros que não
 * identificam um fabricante (o prefixo então fica fora da tabela).
 * @param {string} raw
 * @returns {string}
 */
export function cleanName(raw) {
  let s = String(raw ?? '')
    .normalize('NFKC') // vírgulas e parênteses de largura dupla viram os comuns
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .split(NAME_SEPARATOR)
    .join(' ')
    .replace(/&amp;/gi, '&') // o cadastro traz alguns nomes com entidades de HTML
    .replace(/&(quot|#0*34);|[“”„"]/gi, '')
    .replace(/[‘’`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || DROP.some((re) => re.test(s))) return '';
  for (const [re, brand] of BRANDS) if (re.test(s)) return brand;

  const original = s;
  s = s
    .replace(/\([^)]*\)?/g, ' ') // "(Shenzhen)", "(Mobile Communications)": local ou divisão
    .replace(/[,\s]+an? [^,]* company$/i, '') // ", a Lenovo Company"
    .replace(/[\s,.-]+(?:[\p{L}-]+ )?branch(?: office)?$/iu, '') // "... Taiwan Branch"
    // "Fulano Indústria e Comércio de Antenas Ltda" -> "Fulano" (e o equivalente turco, "Sanayi ve Ticaret")
    .replace(/(?<=\S)[\s,-]+ind(?:[úu]stria|\.)?(?:\s+e)?\s+com(?:[ée]rcio|\.)?(?=[\s,.]|$).*$/i, '')
    .replace(/(?<=\S)[\s,-]+san(?:ay[iİ]|\.)?(?:\s+ve)?\s+t[iİ]c(?:aret|\.)?(?=[\s,.]|$).*$/iu, '')
    .replace(/\s*[&+]\s*co\.?\s*(?:kg|ohg)\b\.?/gi, '') // "GmbH & Co. KG" -> "GmbH", que sai mais abaixo
    .replace(/[\s,]+sp\.?\s*z\.?\s*o\.?\s*o\.?$/i, '') // "Sp. z o.o." (Polônia)
    .replace(/[\s,]+(?:spol\.?\s*)?s\.?\s*r\.\s*o\.?$/i, '') // "s.r.o.", "spol. s r.o." (Tchéquia)
    .replace(/[;,]/g, ', ')
    .replace(/(?<=\p{L})\.(?=(?:inc|ltd|llc|corp|gmbh)\b)/giu, ' ') // "BUFFALO.INC", "Co.Ltd"
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) s = original.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();

  let tokens = s.split(' ');
  // "The Foo Company"; "PT. Foo" (o "Ltda" da Indonésia vem na frente)
  if (tokens.length > 1 && /^(the|pt\.?)$/i.test(tokens[0])) tokens.shift();
  const cut = tokens.findIndex((t, i) => i > 0 && HARD_LEGAL.test(t));
  if (cut > 0) tokens.length = cut;
  tokens = stripFiller(stripTail(tokens));
  // A vírgula que separava a forma jurídica não faz mais sentido.
  tokens = tokens.map((t) => t.replace(/,+$/, '')).filter(Boolean);
  if (!tokens.length) return '';

  const name = finish(tokens);
  // Limpou demais ("Q (Cue), Inc." -> "Q"): melhor o nome do cadastro do que uma letra solta.
  return name.replace(/[^\p{L}\p{N}]/gu, '').length >= 2 ? name : finish(original.split(' '));
}

// ---------------------------------------------------------------------------
// Montagem do arquivo
// ---------------------------------------------------------------------------

const TIERS = [
  { key: 'maL', hexLength: 6 },
  { key: 'maM', hexLength: 7 },
  { key: 'maS', hexLength: 9 },
];

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // ordem por código, igual em qualquer máquina

// O cadastro repete muito o mesmo nome (a Apple aparece 1.500 vezes): limpa cada um uma vez só.
const cleaned = new Map();
function cleanCached(raw) {
  let name = cleaned.get(raw);
  if (name === undefined) cleaned.set(raw, (name = cleanName(raw)));
  return name;
}

/**
 * Cadastro cru ({ "AABBCC": "NOME\nendereço...", ... }) -> texto do oui.json e alguns números.
 * Determinístico: a mesma entrada produz sempre os mesmos bytes.
 * @param {Record<string, string>} registry
 * @param {string} source  de onde veio (vai para o campo "source")
 */
export function buildOui(registry, source) {
  // 1. Prefixos válidos de cada tamanho, com o nome já limpo, em ordem crescente. A ordem das
  //    chaves na entrada não pode mudar o resultado; prefixo repetido fica com um nome só.
  let tiers = TIERS.map(() => []);
  let dropped = 0;
  for (const rawKey of Object.keys(registry ?? {})) {
    const hex = String(rawKey).toUpperCase();
    const tier = TIERS.findIndex((t) => t.hexLength === hex.length);
    if (tier < 0 || !/^[0-9A-F]+$/.test(hex)) continue;
    const name = cleanCached(String(registry[rawKey] ?? '').split('\n')[0]);
    if (name) tiers[tier].push({ prefix: parseInt(hex, 16), name });
    else dropped++;
  }
  tiers = tiers.map((list) =>
    list
      .sort((a, b) => a.prefix - b.prefix || compareText(a.name, b.name))
      .filter((entry, i) => i === 0 || entry.prefix !== list[i - 1].prefix),
  );
  const uses = new Map(); // nome -> em quantos prefixos aparece
  for (const { name } of tiers.flat()) uses.set(name, (uses.get(name) || 0) + 1);

  // 2. Tabela de nomes. Primeiro os que se repetem, do mais usado para o menos usado (ganham os
  //    números menores, que ocupam menos caracteres). Os que aparecem uma única vez vêm depois, na
  //    ordem em que os prefixos os encontram: assim nem precisam de número (referência 0 = "o próximo").
  const shared = [...uses].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
  const names = shared.map(([name]) => name);
  const idOf = new Map(names.map((name, i) => [name, i]));

  // 3. Cada tabela vira uma fila de pares (distância até o prefixo anterior, referência do nome).
  const out = {};
  TIERS.forEach(({ key }, t) => {
    let text = '';
    let previous = 0;
    for (const { prefix, name } of tiers[t]) {
      const id = idOf.get(name);
      if (id === undefined) names.push(name);
      text += encodeVlq(prefix - previous) + encodeVlq(id === undefined ? 0 : id + 1);
      previous = prefix;
    }
    out[key] = text;
  });
  const prefixes = tiers.reduce((sum, list) => sum + list.length, 0);

  const table = names.join(NAME_SEPARATOR);
  // Uma linha por campo: o arquivo continua compacto e o diff do git mostra o que mudou.
  const json =
    '{\n' +
    [
      ['format', OUI_FORMAT],
      ['source', source],
      ['prefixes', prefixes],
      ['shared', shared.length],
      ['names', table],
      ...TIERS.map(({ key }) => [key, out[key]]),
    ]
      .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
      .join(',\n') +
    '\n}\n';

  return {
    json,
    stats: {
      prefixes,
      dropped,
      names: names.length,
      shared: shared.length,
      perTier: Object.fromEntries(TIERS.map(({ key }, t) => [key, tiers[t].length])),
      bytes: Buffer.byteLength(json),
      nameBytes: Buffer.byteLength(table),
    },
  };
}

/** Confere o arquivo gerado contra o cadastro: todo prefixo tem de voltar com o nome que entrou. */
function verify(json, registry) {
  const lookup = createOuiLookup(JSON.parse(json));
  for (const hex of Object.keys(registry)) {
    const expected = cleanCached(registry[hex].split('\n')[0]);
    if (!expected) continue;
    const got = lookup.vendor(hex); // só o prefixo: completar com zeros cairia em "00:00:00:00:00:00"
    if (!got || got.name !== expected || got.guess) {
      throw new Error(`oui.json não confere em ${hex}: esperado "${expected}", veio ${JSON.stringify(got)}`);
    }
  }
}

function loadRegistry() {
  const require = createRequire(import.meta.url);
  let file;
  try {
    file = require.resolve('oui-data');
  } catch {
    throw new Error('pacote "oui-data" não encontrado: rode "npm install" em wifi-raio-x/ antes de "npm run oui"');
  }
  const { version } = JSON.parse(readFileSync(join(dirname(file), 'package.json'), 'utf8'));
  return {
    registry: JSON.parse(readFileSync(file, 'utf8')),
    source: `IEEE Registration Authority (MA-L, MA-M, MA-S) via oui-data@${version}, BSD-2-Clause`,
  };
}

function main(argv) {
  const { registry, source } = loadRegistry();
  const { json, stats } = buildOui(registry, source);
  verify(json, registry);
  if (argv.includes('--stats')) {
    console.log(stats);
    return;
  }
  const outIndex = argv.indexOf('--out');
  const target = outIndex >= 0 && argv[outIndex + 1] ? resolve(argv[outIndex + 1]) : DEFAULT_OUT;
  writeFileSync(target, json);
  const size = `${stats.bytes} bytes (${(stats.bytes / 1000).toFixed(1)} kB)`;
  console.log(`${target}: ${size}, ${stats.prefixes} prefixos, ${stats.names} fabricantes\n  fonte: ${source}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
