// Faz `node --test tests/` funcionar: o Node 22 trata um diretório passado ao --test como um
// módulo a executar e procura este arquivo. Ele só carrega todos os tests/*.test.mjs, que se
// registram no mesmo processo. (O jeito normal continua sendo `npm test`, que roda cada arquivo
// em um processo separado e em paralelo. Os testes de ponta a ponta, em tests/e2e/, não entram:
// eles têm o seu próprio comando, `npm run test:e2e`.)

import { readdirSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const files = readdirSync(here)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

for (const name of files) await import(new URL(name, here).href);
