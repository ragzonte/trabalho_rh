// Gera os ícones do app Android a partir do desenho do app.
// Rode: node tools/make-android-icons.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const RES = 'android/app/src/main/res';
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

// Dois círculos (as duas pessoas) com a interseção escura.
const circles = (size, cx, r, gap) => `
  <defs><clipPath id="a"><circle cx="${cx - gap}" cy="${size / 2}" r="${r}"/></clipPath></defs>
  <circle cx="${cx - gap}" cy="${size / 2}" r="${r}" fill="#2a78d6"/>
  <circle cx="${cx + gap}" cy="${size / 2}" r="${r}" fill="#eb6834"/>
  <circle cx="${cx + gap}" cy="${size / 2}" r="${r}" fill="#0b0b0b" clip-path="url(#a)"/>`;

const legacy = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect x="2" y="2" width="44" height="44" rx="10" fill="#fcfcfb"/>${circles(48, 24, 10.5, 9)}</svg>`;
const round = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <circle cx="24" cy="24" r="22" fill="#fcfcfb"/>${circles(48, 24, 9, 7.5)}</svg>`;
// Ícone adaptável: 108dp, desenho dentro da zona segura de 66dp.
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">${circles(108, 54, 19, 8.5)}</svg>`;

const jobs = [];
for (const [d, k] of Object.entries(DENSITIES)) {
  jobs.push([legacy, `mipmap-${d}/ic_launcher.png`, 48 * k]);
  jobs.push([round, `mipmap-${d}/ic_launcher_round.png`, 48 * k]);
  jobs.push([foreground, `mipmap-${d}/ic_launcher_foreground.png`, 108 * k]);
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [svg, out, size] of jobs) {
  mkdirSync(`${RES}/${out.split('/')[0]}`, { recursive: true });
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: `${RES}/${out}`, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();
console.log(`${jobs.length} ícones gerados em ${RES}`);
