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
