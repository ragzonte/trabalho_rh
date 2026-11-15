// O app roda no WebView do Android, que em celulares sem atualização pode ser antigo.
// Piso escolhido: Chrome/WebView 80 (2020: módulos em Workers, `?.` e `??`). Este teste
// lê todo o JavaScript que vai para o APK e reprova sintaxe e funções mais novas que isso,
// porque um único arquivo com sintaxe desconhecida derruba o app inteiro (tela em branco).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = fileURLToPath(new URL('../app/', import.meta.url));

function listJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'vendor') listJs(full, out); // three.js já vem compilado para es2020 (veja tools/vendor.mjs)
    } else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Métodos e funções globais que só existem em versões mais novas que o piso.
const NEW_METHODS = new Map([
  ['at', 'Array/String.prototype.at (Chrome 92)'],
  ['replaceAll', 'String.prototype.replaceAll (Chrome 85)'],
  ['findLast', 'Array.prototype.findLast (Chrome 97)'],
  ['findLastIndex', 'Array.prototype.findLastIndex (Chrome 97)'],
  ['toSorted', 'Array.prototype.toSorted (Chrome 110)'],
  ['toReversed', 'Array.prototype.toReversed (Chrome 110)'],
  ['toSpliced', 'Array.prototype.toSpliced (Chrome 110)'],
  ['with', 'Array.prototype.with (Chrome 110)'],
  ['hasOwn', 'Object.hasOwn (Chrome 93)'],
  ['groupBy', 'Object.groupBy / Map.groupBy (Chrome 117)'],
  ['any', 'Promise.any (Chrome 85)'],
  ['withResolvers', 'Promise.withResolvers (Chrome 119)'],
  ['fromAsync', 'Array.fromAsync (Chrome 121)'],
]);
// `x.at(...)`, `x.with(...)` e `x.any(...)` também são nomes comuns em código próprio: só
// acusamos quando o objeto não é claramente nosso (heurística: chamada com 1 argumento em `at`).
const NEW_GLOBALS = new Map([
  ['structuredClone', 'structuredClone (Chrome 98)'],
  ['WeakRef', 'WeakRef (Chrome 84)'],
  ['FinalizationRegistry', 'FinalizationRegistry (Chrome 84)'],
  ['AggregateError', 'AggregateError (Chrome 85)'],
]);

function problemsOf(file) {
  const source = readFileSync(file, 'utf8');
  const found = [];
  const add = (node, what) => {
    const { line } = acorn.getLineInfo(source, node.start);
    found.push(`${relative(ROOT, file)}:${line} ${what}`);
  };
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch (err) {
    return [`${relative(ROOT, file)}: não deu para ler (${err.message})`];
  }
  walk.full(ast, (node) => {
    switch (node.type) {
      case 'MethodDefinition':
        if (node.key.type === 'PrivateIdentifier') add(node, 'método ou acessor privado (#nome()) — Chrome 84; use uma função do módulo');
        break;
      case 'BinaryExpression':
        if (node.operator === 'in' && node.left.type === 'PrivateIdentifier') add(node, '`#campo in objeto` — Chrome 91');
        break;
      case 'AssignmentExpression':
        if (['??=', '||=', '&&='].includes(node.operator)) add(node, `atribuição lógica (${node.operator}) — Chrome 85`);
        break;
      case 'StaticBlock':
        add(node, 'bloco static em classe — Chrome 94');
        break;
      case 'AwaitExpression': {
        break;
      }
      case 'ImportAttribute':
        add(node, 'atributos de import — Chrome 123');
        break;
      case 'Literal':
        if (node.regex && /[dv]/.test(node.regex.flags)) add(node, 'flag de regex d/v — Chrome 90/112');
        break;
      case 'CallExpression': {
        const callee = node.callee;
        if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
          const name = callee.property.name;
          if (!NEW_METHODS.has(name)) break;
          const obj = callee.object;
          const onBuiltin = obj.type === 'Identifier' && ['Object', 'Promise', 'Array', 'Map'].includes(obj.name);
          const builtinOnly = ['hasOwn', 'groupBy', 'any', 'withResolvers', 'fromAsync'].includes(name);
          if (builtinOnly ? onBuiltin : name !== 'with' && name !== 'any') add(node, NEW_METHODS.get(name));
        }
        break;
      }
      case 'Identifier':
        if (NEW_GLOBALS.has(node.name)) add(node, NEW_GLOBALS.get(node.name));
        break;
      default:
    }
  });
  // await solto no topo do módulo (Chrome 89)
  for (const stmt of ast.body) {
    walk.simple(
      stmt,
      { AwaitExpression: (n) => add(n, 'await no topo do módulo — Chrome 89') },
      { ...walk.base, FunctionDeclaration() {}, FunctionExpression() {}, ArrowFunctionExpression() {}, MethodDefinition() {}, PropertyDefinition() {}, ClassDeclaration() {}, ClassExpression() {} },
    );
  }
  return found;
}

test('o JavaScript do app só usa o que o WebView 80 entende', () => {
  const files = listJs(ROOT);
  assert.ok(files.length > 30, 'achou os arquivos do app');
  const problems = files.flatMap(problemsOf);
  assert.deepEqual(problems, [], `sintaxe ou função nova demais para o WebView:\n${problems.join('\n')}`);
});

test('o three.js embutido foi compilado para es2020', () => {
  const source = readFileSync(join(ROOT, 'vendor/three.min.js'), 'utf8');
  // es2020 não tem campos de classe nem atribuição lógica; se o acorn aceitar com ecmaVersion 2020, serve.
  assert.doesNotThrow(() => acorn.parse(source, { ecmaVersion: 2020, sourceType: 'module' }));
});

// --- CSS ---------------------------------------------------------------------------------
// Uma declaração que o WebView não conhece é ignorada EM SILÊNCIO, e algumas sustentam a tela
// inteira: no WebView 83 (Android 11 de fábrica) `inset: 0` não existe, o `.app` deixava de
// ocupar a tela e a navegação de baixo ia parar fora dela. Aqui ficam barrados os atalhos e
// seletores mais novos que o piso; para cada um existe um equivalente antigo e exato.
// (O `gap` em contêiner flex — Chrome 84 — é tratado à parte: veja `no-flex-gap` em app.css.)

function listCss(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => join(dir, name));
}

const NEW_CSS = [
  [/(^|[;{\s])inset(-inline|-block)?(-start|-end)?\s*:/, '`inset` (Chrome 87): escreva top/right/bottom/left'],
  [/(^|[;{\s])(margin|padding|border)-(inline|block)\s*:/, 'atalho lógico margin/padding/border-inline|block (Chrome 87): use os lados físicos'],
  [/(^|[;{\s])aspect-ratio\s*:/, '`aspect-ratio` (Chrome 88)'],
  [/:(is|where|has)\(/, 'seletor :is()/:where()/:has() (Chrome 88/105): a regra inteira seria descartada'],
  [/:not\([^)]*,/, ':not() com lista (Chrome 88): a regra inteira seria descartada'],
  [/\d(dvh|svh|lvh|dvw|svw|lvw)\b/, 'unidades dvh/svh/lvh (Chrome 108)'],
  [/(color-mix|light-dark)\(/, 'color-mix()/light-dark() (Chrome 111+)'],
  [/(^|[;{\s])(translate|rotate|scale)\s*:/, 'transformações individuais translate/rotate/scale (Chrome 104): use transform'],
  [/@(container|layer|scope|starting-style)\b/, '@container/@layer/@scope (Chrome 99+): o bloco inteiro seria descartado'],
  [/@media[^{]*[<>]/, 'faixa em @media com < ou > (Chrome 104): use min-width/max-width'],
];

test('o CSS do app só usa o que o WebView 80 entende', () => {
  const files = listCss(join(ROOT, 'css'));
  assert.ok(files.length >= 5, 'achou as folhas de estilo');
  const problems = [];
  for (const file of files) {
    // sem comentários, mantendo as quebras de linha para o número da linha continuar certo
    const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    source.split('\n').forEach((line, i) => {
      for (const [re, what] of NEW_CSS) if (re.test(line)) problems.push(`${relative(ROOT, file)}:${i + 1} ${what}`);
    });
    // `appearance` sem prefixo só existe do Chrome 84 em diante: precisa do -webkit- na mesma regra
    for (const rule of source.split('}')) {
      if (/(^|[;{\s])appearance\s*:/.test(rule) && !/-webkit-appearance\s*:/.test(rule)) {
        const line = source.slice(0, source.indexOf(rule)).split('\n').length + rule.slice(0, rule.search(/(^|[;{\s])appearance\s*:/)).split('\n').length - 1;
        problems.push(`${relative(ROOT, file)}:${line} \`appearance\` sem \`-webkit-appearance\` (Chrome 84)`);
      }
    }
  }
  assert.deepEqual(problems, [], `CSS novo demais para o WebView:\n${problems.join('\n')}`);
});

// --- `gap` em flex (Chrome 84) -----------------------------------------------------------
// O app usa `gap` em flex por toda parte; para os WebViews anteriores existe uma folha de reserva
// GERADA (tools/flex-gap-fallback.mjs), carregada só neles por js/polyfills.js.

test('a folha de reserva do gap em flex está em dia com as folhas do app', async () => {
  const { generate, readSources, OUTPUT_PATH } = await import('../tools/flex-gap-fallback.mjs');
  const { css, rules, skipped } = generate(readSources());
  assert.ok(rules > 200, 'gerou as regras');
  assert.equal(readFileSync(OUTPUT_PATH, 'utf8'), css, 'app/css/flex-gap-fallback.css está desatualizado: rode `node tools/flex-gap-fallback.mjs`');
  // Regras com `gap` cujo display vem de outra classe posta pelo JS: o gerador não tem como saber se
  // são flex. São ajustes de 3 a 6 px sobre uma base que já tem reserva; uma regra NOVA aqui pede
  // que se declare o display na mesma regra (ou que se aceite conscientemente, acrescentando-a à lista).
  const accepted = ['.best-row__connected', '.best-more', '.best-badges', '.net-row__connected', '.net-row__age', '.tb-rec'];
  const unknown = skipped.filter((line) => !accepted.some((sel) => line.includes(` ${sel} `)));
  assert.deepEqual(unknown, [], 'regra com gap sem display conhecido (sem reserva para WebView antigo)');
});

test('o gerador da reserva: linha, coluna, quebra de linha, @media e grid', async () => {
  const { generate } = await import('../tools/flex-gap-fallback.mjs');
  const source = `
    .row { display: flex; gap: 12px; }
    .col { display: inline-flex; flex-direction: column; gap: var(--sp-2); }
    .chips { display: flex; flex-wrap: wrap; gap: 4px 8px; }
    .grid { display: grid; gap: 16px; }
    .row--tight { gap: 4px; }
    .plain { display: flex; }
    .zero { display: flex; gap: 0; }
    .icon::after { display: flex; gap: 2px; }
    @media (max-width: 400px) {
      .row { flex-direction: column; }
      .col { gap: 2px; }
    }
    @keyframes spin { from { gap: 1px; } to { gap: 2px; } }
  `;
  const { css, skipped } = generate([{ name: 'x.css', source }]);
  const flat = css.replace(/\s+/g, ' ');
  assert.match(flat, /\.row > \*:not\(:last-child\) \{ margin-right: 12px; \}/);
  assert.match(flat, /\.col > \*:not\(:last-child\) \{ margin-bottom: var\(--sp-2\); \}/);
  assert.match(flat, /\.chips > \* \{ margin-right: 8px; margin-bottom: 4px; \}/);
  assert.match(flat, /\.chips \{ margin-bottom: calc\(4px \* -1\); \}/);
  assert.match(flat, /\.row--tight > \*:not\(:last-child\) \{ margin-right: 4px; \}/, 'modificador herda o display e a direção da base');
  assert.match(flat, /\.zero > \*:not\(:last-child\) \{ margin-right: 0; \}/, 'gap zerado também zera a margem herdada');
  assert.match(flat, /@media \(max-width: 400px\) \{ \.row > \*:not\(:last-child\) \{ margin-bottom: 12px; margin-right: 0; \} \}/, 'a direção trocou dentro do @media: a margem troca de lado');
  assert.match(flat, /@media \(max-width: 400px\) \{ \.col > \*:not\(:last-child\) \{ margin-bottom: 2px; \} \}/);
  assert.doesNotMatch(flat, /\.grid/, 'grid tem gap desde sempre');
  assert.doesNotMatch(flat, /\.plain|::after|spin|from|to \{/);
  assert.deepEqual(skipped, []);
});
