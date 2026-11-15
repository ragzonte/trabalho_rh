// Gera app/css/flex-gap-fallback.css: o espaçamento dos contêineres flex para WebViews sem `gap` em flex.
//
// O `gap` em `display: flex` só existe do Chrome/WebView 84 em diante. Num WebView mais antigo (o 83
// vem de fábrica no Android 11) ele é ignorado em silêncio: cartões, ícones, rótulos e botões ficam
// colados uns nos outros e alguns blocos chegam a ficar cortados. Como o app usa `gap` em mais de 200
// regras, a reserva é gerada: para cada regra flex com `gap` sai uma regra equivalente com margens
// entre os filhos (`> *:not(:last-child)`: margem à direita, ou embaixo nas colunas).
//
// A margem fica do lado de trás de cada filho para se somar às margens que o app põe do lado da
// frente (um `margin-left: auto`, um `margin-top: -4px`), como o gap faria. A folha gerada só é
// carregada onde falta o recurso (veja app/js/polyfills.js); nos WebViews atuais ela nem é baixada.
//
//   node tools/flex-gap-fallback.mjs           regrava o arquivo
//   node tools/flex-gap-fallback.mjs --check   só confere (sai com 1 se estiver desatualizado)
//
// tests/compat.test.mjs reprova quando alguém muda um `gap` e esquece de rodar isto.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'css');
export const OUTPUT_NAME = 'flex-gap-fallback.css';
export const OUTPUT_PATH = join(CSS_DIR, OUTPUT_NAME);

/**
 * Leitor de CSS suficiente para as folhas do app: regras simples e blocos @media/@supports
 * (os demais blocos com @, como @keyframes, são pulados inteiros).
 * @returns {{selectors:string[], decls:Record<string,string>, media:string[], line:number}[]}
 */
export function parseCss(source) {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const rules = [];
  const media = [];
  let i = 0;
  let head = '';
  const lineAt = (pos) => src.slice(0, pos).split('\n').length;
  const blockEnd = (open) => {
    let depth = 0;
    for (let k = open; k < src.length; k += 1) {
      if (src[k] === '{') depth += 1;
      else if (src[k] === '}') {
        depth -= 1;
        if (depth === 0) return k;
      }
    }
    return src.length;
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      const text = head.trim().replace(/\s+/g, ' ');
      head = '';
      if (text.startsWith('@')) {
        if (/^@(media|supports)\b/.test(text)) {
          media.push(text);
          i += 1;
        } else {
          i = blockEnd(i) + 1; // @keyframes, @font-face...
        }
        continue;
      }
      const end = src.indexOf('}', i);
      const decls = {};
      for (const part of src.slice(i + 1, end).split(';')) {
        const colon = part.indexOf(':');
        if (colon > 0) decls[part.slice(0, colon).trim().toLowerCase()] = part.slice(colon + 1).trim();
      }
      rules.push({ selectors: splitSelectors(text), decls, media: [...media], line: lineAt(i) });
      i = end + 1;
      continue;
    }
    if (ch === '}') {
      media.pop();
      head = '';
      i += 1;
      continue;
    }
    head += ch;
    i += 1;
  }
  return rules;
}

/** "a, b:not(.c, .d)" -> ["a", "b:not(.c, .d)"] */
function splitSelectors(text) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** "8px" | "2px 6px" | "var(--a) calc(1px + 2px)" -> [linha, coluna] */
function splitValues(value) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of value.replace(/!important/g, '').trim()) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current);
      current = '';
    } else current += ch;
  }
  if (current) out.push(current);
  return out;
}

const isZero = (v) => !v || /^[+-]?0(\.0+)?(px|em|rem|%)?$/.test(v) || v === 'normal';

/** O que a regra diz sobre o gap: {row, col} (undefined = não fala daquele eixo). */
function gapOf(decls) {
  const out = {};
  // na ordem em que valem: o atalho primeiro, os específicos por cima
  if (decls.gap !== undefined) {
    const [a, b] = splitValues(decls.gap);
    out.row = a;
    out.col = b === undefined ? a : b;
  }
  if (decls['row-gap'] !== undefined) out.row = decls['row-gap'];
  if (decls['column-gap'] !== undefined) out.col = decls['column-gap'];
  return out;
}

function flowOf(decls) {
  const text = `${decls['flex-flow'] || ''} ${decls['flex-direction'] || ''}`;
  const wrapText = `${decls['flex-flow'] || ''} ${decls['flex-wrap'] || ''}`;
  const direction = /column-reverse/.test(text) ? 'column-reverse' : /column/.test(text) ? 'column' : /row-reverse/.test(text) ? 'row-reverse' : /row/.test(text) ? 'row' : undefined;
  const wrap = /nowrap/.test(wrapText) ? false : /wrap/.test(wrapText) ? true : undefined;
  return { direction, wrap };
}

/** O último seletor composto: ".a .b > .c.d:hover" -> ".c.d:hover" */
function lastCompound(selector) {
  const parts = selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return parts[parts.length - 1] || selector;
}

/**
 * Candidatos a "seletor de base" de onde herdar display/direção quando a própria regra não diz:
 * o seletor inteiro, sem pseudo-classes, o último composto e cada classe dele (com e sem "--modificador").
 */
function baseCandidates(selector) {
  const out = [selector];
  const noPseudo = selector.replace(/:(?!:)[a-z-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '');
  out.push(noPseudo);
  const last = lastCompound(noPseudo);
  out.push(last);
  for (const cls of last.match(/\.[A-Za-z0-9_-]+/g) || []) {
    out.push(cls);
    if (cls.includes('--')) out.push(cls.slice(0, cls.indexOf('--')));
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * @param {{name:string, source:string}[]} files  as folhas do app (sem a gerada)
 * @returns {{css:string, rules:number, skipped:string[]}}
 */
export function generate(files) {
  const parsed = files.map((f) => ({ name: f.name, rules: parseCss(f.source) }));

  // O que cada seletor declara, juntando todas as folhas (a base de um componente pode estar em app.css).
  const known = new Map(); // seletor -> {display, direction, wrap, row, col}
  for (const file of parsed) {
    for (const rule of file.rules) {
      if (rule.media.length) continue; // a base é a regra fora de @media
      const flow = flowOf(rule.decls);
      const gap = gapOf(rule.decls);
      for (const selector of rule.selectors) {
        const entry = known.get(selector) || {};
        if (rule.decls.display) entry.display = rule.decls.display.replace(/!important/, '').trim();
        if (flow.direction) entry.direction = flow.direction;
        if (flow.wrap !== undefined) entry.wrap = flow.wrap;
        if (gap.row !== undefined) entry.row = gap.row;
        if (gap.col !== undefined) entry.col = gap.col;
        known.set(selector, entry);
      }
    }
  }
  const inherit = (selector, key) => {
    for (const candidate of baseCandidates(selector)) {
      const entry = known.get(candidate);
      if (entry && entry[key] !== undefined) return entry[key];
    }
    return undefined;
  };

  const blocks = [];
  const skipped = [];
  let count = 0;
  for (const file of parsed) {
    const lines = [];
    for (const rule of file.rules) {
      const ownGap = gapOf(rule.decls);
      const ownFlow = flowOf(rule.decls);
      const touchesGap = ownGap.row !== undefined || ownGap.col !== undefined;
      const touchesFlow = ownFlow.direction !== undefined || ownFlow.wrap !== undefined;
      if (!touchesGap && !touchesFlow) continue;

      const byBody = new Map(); // corpo da regra gerada -> seletores
      for (const selector of rule.selectors) {
        if (selector.includes('::')) continue; // pseudo-elemento não tem filhos
        const display = rule.decls.display || inherit(selector, 'display');
        if (!display) {
          if (touchesGap && !(isZero(ownGap.row) && isZero(ownGap.col))) skipped.push(`${file.name}:${rule.line} ${selector} (não dá para saber se é flex)`);
          continue;
        }
        if (!/flex/.test(display)) continue; // grid: o gap funciona desde sempre
        const row = ownGap.row !== undefined ? ownGap.row : inherit(selector, 'row');
        const col = ownGap.col !== undefined ? ownGap.col : inherit(selector, 'col');
        if (row === undefined && col === undefined) continue; // flex sem gap: nada a repor
        const baseDirection = inherit(selector, 'direction') || 'row';
        const baseWrap = inherit(selector, 'wrap') || false;
        const direction = ownFlow.direction || baseDirection;
        const wrap = ownFlow.wrap !== undefined ? ownFlow.wrap : baseWrap;
        // só a direção/quebra mudou e ficou igual à base: a regra da base já resolve
        if (!touchesGap && direction === baseDirection && wrap === baseWrap && !rule.media.length) continue;
        if (!touchesGap && direction === baseDirection && wrap === baseWrap) continue;

        const vertical = direction.startsWith('column');
        const reverse = direction.endsWith('reverse');
        const main = vertical ? row : col;
        // A margem vai do lado de TRÁS de cada filho (menos o último): assim ela se soma às margens que
        // o app põe do lado da frente (um `margin-left: auto`, um `margin-top: -4px`), como o gap faria.
        const sideOf = (dir) => (dir.startsWith('column') ? (dir.endsWith('reverse') ? 'margin-top' : 'margin-bottom') : dir.endsWith('reverse') ? 'margin-left' : 'margin-right');
        const mainSide = sideOf(direction);
        const baseSide = sideOf(baseDirection);
        const flipped = direction !== baseDirection || wrap !== baseWrap; // a regra da base pôs a margem em outro lado
        let body;
        let target = `${selector} > *:not(:last-child)`;
        if (wrap && !vertical) {
          // linhas que quebram: cada filho leva o espaço à direita e embaixo; a sobra de baixo é descontada no contêiner
          target = `${selector} > *`;
          body = `margin-right: ${isZero(col) ? '0' : col}; margin-bottom: ${isZero(row) ? '0' : row};`;
          if (!isZero(row)) {
            const own = `margin-bottom: calc(${row} * -1);`;
            byBody.set(`@self ${own}`, [...(byBody.get(`@self ${own}`) || []), selector]);
          }
        } else {
          body = `${mainSide}: ${isZero(main) ? '0' : main};`;
          if (flipped && baseSide !== mainSide) body += ` ${baseSide}: 0;`;
          if (flipped && baseWrap && !wrap && mainSide !== 'margin-bottom') body += ' margin-bottom: 0;';
        }
        byBody.set(`${body}`, [...(byBody.get(body) || []), target]);
      }
      for (const [body, targets] of byBody) {
        const self = body.startsWith('@self ');
        const text = `${targets.join(',\n')} {\n  ${self ? body.slice(6) : body}\n}`;
        const indent = '  '.repeat(rule.media.length);
        const wrapped = rule.media.reduceRight((inner, m) => `${m} {\n${inner}\n}`, text.split('\n').map((l) => indent + l).join('\n'));
        lines.push(rule.media.length ? wrapped.split('\n').map((l, n, all) => (n === 0 || n === all.length - 1 ? l.trimStart() : l)).join('\n') : text);
        count += 1;
      }
    }
    if (lines.length) blocks.push(`/* ---- ${file.name} ---- */\n\n${lines.join('\n\n')}`);
  }

  const header = [
    '/* GERADO por tools/flex-gap-fallback.mjs — não edite à mão: mude o `gap` na folha de origem e rode',
    '   `node tools/flex-gap-fallback.mjs`.',
    '',
    '   Espaçamento dos contêineres flex para WebViews sem `gap` em flex (anteriores ao Chrome 84; o',
    '   WebView 83 vem de fábrica no Android 11). Só é carregada nesses WebViews (app/js/polyfills.js).',
    '   A margem fica atrás de cada filho, menos o último, e se soma às margens do próprio app. */',
  ].join('\n');
  return { css: `${header}\n\n${blocks.join('\n\n')}\n`, rules: count, skipped };
}

/** As folhas de estilo do app, em ordem fixa (app.css primeiro: é a base das demais). */
export function readSources(dir = CSS_DIR) {
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.css') && n !== OUTPUT_NAME)
    .sort((a, b) => (a === 'app.css' ? -1 : b === 'app.css' ? 1 : a.localeCompare(b)));
  return names.map((name) => ({ name, source: readFileSync(join(dir, name), 'utf8') }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { css, rules, skipped } = generate(readSources());
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUTPUT_PATH, 'utf8');
    } catch {
      // ainda não existe
    }
    if (current !== css) {
      console.error(`${OUTPUT_NAME} está desatualizado: rode node tools/flex-gap-fallback.mjs`);
      process.exit(1);
    }
    console.log(`${OUTPUT_NAME} em dia (${rules} regras)`);
  } else {
    writeFileSync(OUTPUT_PATH, css);
    console.log(`${OUTPUT_NAME}: ${rules} regras`);
  }
  if (skipped.length) console.log(`sem reserva (${skipped.length}):\n  ${skipped.join('\n  ')}`);
}
