// Gera os ícones do app (Android + logo usado na interface) a partir de um desenho em SVG.
//   node tools/make-icons.mjs            -> grava em android/app/src/main/res e app/assets
//   node tools/make-icons.mjs --preview <pasta>   -> só uma prévia grande, para conferir o desenho
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'android/app/src/main/res');
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

const BG = '#0B1220';
// O desenho: a casa vista "por dentro" (contorno fino) e as ondas do Wi-Fi saindo do roteador.
// Tudo num quadro de 100 x 100 centrado em (50, 50); `s` escala o desenho dentro do ícone.
const art = (cx, cy, s) => `
  <g transform="translate(${cx} ${cy}) scale(${s}) translate(-50 -50)" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <defs>
      <linearGradient id="w" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="#38BDF8"/><stop offset="1" stop-color="#A78BFA"/>
      </linearGradient>
    </defs>
    <path d="M14 47 L50 16 L86 47 M22 41 V84 H78 V41" stroke="#E8EEF9" stroke-opacity=".55" stroke-width="4"/>
    <path d="M36.6 62.4 A19 19 0 0 1 63.4 62.4" stroke="url(#w)" stroke-width="5.5"/>
    <path d="M28.1 53.9 A31 31 0 0 1 71.9 53.9" stroke="url(#w)" stroke-width="5.5"/>
    <path d="M43.6 69.4 A9 9 0 0 1 56.4 69.4" stroke="url(#w)" stroke-width="5.5"/>
    <circle cx="50" cy="76.5" r="4" fill="#38BDF8" stroke="none"/>
  </g>`;

const svg = (size, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
const legacy = svg(48, `<rect x="2" y="2" width="44" height="44" rx="10" fill="${BG}"/>${art(24, 24, 0.36)}`);
const round = svg(48, `<circle cx="24" cy="24" r="22" fill="${BG}"/>${art(24, 24, 0.31)}`);
// Ícone adaptável: 108dp, com o desenho dentro da zona segura central de 66dp.
const foreground = svg(108, art(54, 54, 0.56));
const logo = svg(100, art(50, 50, 1));
const preview = svg(512, `<rect width="512" height="512" rx="112" fill="${BG}"/>${art(256, 256, 3.9)}`);

const args = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();
async function render(markup, file, size) {
  mkdirSync(dirname(file), { recursive: true });
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${markup.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

if (args[0] === '--preview') {
  const dir = args[1];
  await render(preview, join(dir, 'icon-512.png'), 512);
  await render(legacy, join(dir, 'icon-legacy-192.png'), 192);
  await render(round, join(dir, 'icon-round-192.png'), 192);
  console.log('prévia em', dir);
} else {
  let n = 0;
  for (const [d, k] of Object.entries(DENSITIES)) {
    await render(legacy, join(RES, `mipmap-${d}/ic_launcher.png`), 48 * k);
    await render(round, join(RES, `mipmap-${d}/ic_launcher_round.png`), 48 * k);
    await render(foreground, join(RES, `mipmap-${d}/ic_launcher_foreground.png`), 108 * k);
    n += 3;
  }
  writeFileSync(join(ROOT, 'app/assets/logo.svg'), logo);
  console.log(`${n} ícones Android + logo gerados`);
}
await browser.close();
