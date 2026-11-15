// Gera app/vendor/three.min.js (three.js + OrbitControls num único módulo minificado).
// O app não tem etapa de build: este arquivo fica versionado e só precisa ser
// refeito para trocar a versão do three.js.
//
//   npm install --no-save three@0.187.0 esbuild && node tools/vendor.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = require('esbuild');
const threeDir = dirname(require.resolve('three/package.json'));
const { version } = JSON.parse(readFileSync(join(threeDir, 'package.json'), 'utf8'));

const out = await esbuild.build({
  stdin: {
    contents: "export * from 'three';\nexport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\n",
    resolveDir: root,
  },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
  write: false,
});

const banner = `/* three.js r${version.split('.')[1]} + OrbitControls — MIT License, Copyright (c) 2010-2026 three.js authors. Gerado por tools/vendor.mjs. */\n`;
writeFileSync(join(root, 'app/vendor/three.min.js'), banner + out.outputFiles[0].text);
copyFileSync(join(threeDir, 'LICENSE'), join(root, 'app/vendor/three.LICENSE.txt'));
console.log(`app/vendor/three.min.js gerado (three ${version})`);
