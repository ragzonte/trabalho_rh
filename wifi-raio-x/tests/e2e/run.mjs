// Roda os testes de ponta a ponta: todos os tests/e2e/*.e2e.mjs, um arquivo por vez.
//   npm run test:e2e            todos
//   npm run test:e2e -- shell   só os arquivos com "shell" no nome
// Sai com código diferente de zero se algum falhar.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('-'));
const files = readdirSync(here)
  .filter((name) => name.endsWith('.e2e.mjs'))
  .filter((name) => filters.length === 0 || filters.some((f) => name.includes(f)))
  .sort()
  .map((name) => join(here, name));

if (files.length === 0) {
  console.error(filters.length ? `nenhum teste de ponta a ponta com "${filters.join('", "')}" no nome` : 'nenhum arquivo *.e2e.mjs em tests/e2e');
  process.exit(1);
}

// um arquivo por vez: cada um sobe o próprio servidor e o próprio navegador
const args = ['--test', '--test-concurrency=1', '--test-reporter=spec', ...flags, ...files];
const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
