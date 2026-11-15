// Ajudas dos testes de ponta a ponta (Playwright + simulador).
//
//   const env = await startEnv();                       // servidor numa porta livre + Chromium
//   const app = await openApp(env, { params: { speed: 10 }, route: '/canais', viewport: 'small' });
//   await app.page.click('text=Canais');
//   await shot(app.page, 'canais');                      // tests/e2e/shots/canais.png (fora do git)
//   await app.close();                                   // FALHA se a página teve erro, console.error,
//                                                        // violação de CSP, alert() ou recurso que não carregou
//   await env.close();
//
// Com node:test, prefira withApp(env, opções, async (app) => { ... }): fecha e confere sozinho.
//
// O que conta como erro pode ser liberado caso a caso com `allow` (textos ou expressões
// regulares comparados com "mensagem + endereço"), para testes que provocam o erro de propósito.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
export const SHOTS_DIR = join(HERE, 'shots');

export const VIEWPORTS = Object.freeze({
  phone: { width: 412, height: 915 },
  small: { width: 360, height: 740 },
  landscape: { width: 915, height: 412 },
  tablet: { width: 800, height: 1280 },
});

/** As cinco abas: rota, título da barra de cima e rótulo na navegação. */
export const TABS = Object.freeze([
  { route: '/redes', title: 'Redes' },
  { route: '/canais', title: 'Canais' },
  { route: '/melhor', title: 'Melhor Wi-Fi' },
  { route: '/mapa', title: 'Mapa 3D' },
  { route: '/ferramentas', title: 'Ferramentas' },
]);

/** Sobe o servidor do app numa porta livre e abre o Chromium. Um por arquivo de teste. */
export async function startEnv() {
  const server = await startServer(0);
  const port = server.address().port;
  const browser = await chromium.launch();
  return {
    server,
    port,
    browser,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function appUrl(baseUrl, params, route) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null) query.set(key, String(value));
  const text = query.toString();
  const hash = route ? `#${route.startsWith('/') ? route : `/${route}`}` : '';
  return `${baseUrl}/index.html${text ? `?${text}` : ''}${hash}`;
}

/**
 * Abre o app numa página nova (contexto próprio: armazenamento limpo) e espera a partida.
 * @param {Awaited<ReturnType<typeof startEnv>>} env
 * @param {object} [options]
 * @param {object} [options.params]      parâmetros do simulador e do tema: {world, seed, speed, throttle, permission, wifi, location, theme}
 * @param {string} [options.route]       rota inicial, ex.: '/ferramentas/ajustes' (padrão: nenhuma -> Redes)
 * @param {keyof typeof VIEWPORTS|{width:number,height:number}} [options.viewport]  padrão 'phone' (412 × 915)
 * @param {'dark'|'light'} [options.colorScheme]  tema do "sistema" (padrão 'dark')
 * @param {Record<string, unknown>} [options.storage]  valores postos no localStorage antes de o app abrir (chave sem o "wrx.")
 * @param {(string|RegExp)[]} [options.allow]  erros esperados neste teste
 * @param {(page: import('playwright').Page) => Promise<void>} [options.before]  roda antes de navegar (page.route...)
 * @param {boolean} [options.waitReady]  esperar <html data-ready> (padrão true)
 */
export async function openApp(env, options = {}) {
  const { params = {}, route = '', viewport = 'phone', colorScheme = 'dark', storage, allow = [], before, waitReady = true } = options;
  const size = typeof viewport === 'string' ? VIEWPORTS[viewport] : viewport;
  const context = await env.browser.newContext({
    viewport: size,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    colorScheme,
    locale: 'pt-BR',
    reducedMotion: 'reduce', // sem animações: os testes não esperam transições
  });
  const page = await context.newPage();
  const problems = [];
  const allowed = (text) => allow.some((rule) => (typeof rule === 'string' ? text.includes(rule) : rule.test(text)));
  const report = (kind, text) => {
    if (!allowed(text)) problems.push(`[${kind}] ${text}`);
  };

  page.on('console', (msg) => {
    if (msg.type() === 'error') report('console.error', `${msg.text()} ${msg.location().url || ''}`.trim());
  });
  page.on('pageerror', (err) => report('erro na página', err.stack || err.message));
  page.on('dialog', (dialog) => {
    report('dialog', `${dialog.type()}: ${dialog.message()}`);
    dialog.dismiss().catch(() => {});
  });
  page.on('requestfailed', (req) => report('pedido falhou', `${req.url()} ${req.failure()?.errorText || ''}`));
  page.on('response', (res) => {
    if (res.status() >= 400) report('resposta', `${res.status()} ${res.url()}`);
  });
  await page.exposeFunction('__e2eCsp', (text) => report('CSP', text));
  await context.addInitScript(
    ({ storage: values }) => {
      document.addEventListener('securitypolicyviolation', (ev) => window.__e2eCsp(`${ev.violatedDirective} bloqueou ${ev.blockedURI || 'código em linha'} (${ev.sourceFile || ''}:${ev.lineNumber || 0})`));
      // só na primeira carga: um reload tem de encontrar o que o app gravou
      if (values && !sessionStorage.getItem('__e2e_seeded')) {
        sessionStorage.setItem('__e2e_seeded', '1');
        for (const [key, value] of Object.entries(values)) localStorage.setItem(`wrx.${key}`, JSON.stringify(value));
      }
    },
    { storage: storage || null },
  );
  if (before) await before(page);

  await page.goto(appUrl(env.baseUrl, params, route));
  if (waitReady) await page.waitForSelector('html[data-ready]', { timeout: 20_000 });

  const app = {
    page,
    context,
    problems,
    /** Lança se a página teve algum problema até agora. */
    assertClean() {
      if (problems.length) throw new Error(`a página teve ${problems.length} problema(s):\n  ${problems.join('\n  ')}`);
    },
    /** Fecha a página; por padrão confere antes se houve problema. */
    async close({ check = true } = {}) {
      try {
        if (check) app.assertClean();
      } finally {
        await context.close();
      }
    },
  };
  return app;
}

/** Abre o app, roda `fn(app)` e fecha conferindo os problemas (mesmo se `fn` falhar, a página é fechada). */
export async function withApp(env, options, fn) {
  const app = await openApp(env, options);
  let failed = false;
  try {
    return await fn(app);
  } catch (err) {
    failed = true;
    if (app.problems.length) err.message += `\n(problemas na página:\n  ${app.problems.join('\n  ')})`;
    throw err;
  } finally {
    await app.close({ check: !failed });
  }
}

/** Foto da página em tests/e2e/shots/<nome>.png (a pasta fica fora do git). Devolve o caminho. */
export async function shot(page, name, { fullPage = false } = {}) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const file = join(SHOTS_DIR, `${name.replace(/[^\w.-]+/g, '-')}.png`);
  await page.screenshot({ path: file, fullPage });
  return file;
}

/** Nome da tela (data-screen) que o roteador monta para uma rota: '/ferramentas/ping' -> 'ferramentas/ping'. */
export function screenKey(route) {
  const parts = route.split('?')[0].split('/').filter(Boolean);
  return parts[0] === 'ferramentas' && parts[1] ? `ferramentas/${parts[1]}` : parts[0];
}

/** Espera a tela desta rota estar montada (o evento de troca de rota chega depois da mudança do hash). */
export async function waitForScreen(page, route) {
  await page.waitForFunction((key) => document.querySelector('.view > .screen')?.dataset.screen === key, screenKey(route));
  await settle(page);
}

/** Troca de rota pelo hash e espera a tela certa estar montada. */
export async function goto(page, route) {
  await page.evaluate((r) => {
    location.hash = `#${r}`;
  }, route);
  await waitForScreen(page, route);
}

/** O botão "voltar" do Android. Devolve o que o app respondeu (true = tratou; false = pode sair). */
export async function back(page) {
  const handled = await page.evaluate(() => window.__wrx.back());
  await settle(page);
  return handled;
}

/** Deixa a página assentar: dois quadros de animação e as Promises pendentes. */
export async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
}

async function ensureSimHook(page) {
  await page.evaluate(async () => {
    if (window.__e2eSim) return;
    const mod = await import('./js/sim/backend.js');
    window.__e2eSim = () => mod.currentSim();
  });
}

/** Muda o "celular" simulado: simState(page, { wifi: false }), { permission: 'denied' }, { throttle: true }... */
export async function simState(page, patch) {
  await ensureSimHook(page);
  return page.evaluate((p) => window.__e2eSim().setState(p), patch);
}

// O CSP do app proíbe eval/new Function dentro da página; um texto avaliado pelo Playwright
// (protocolo de depuração) não passa pelo CSP, então a função vai como texto.
const call = (fn, target, arg) => `(${fn.toString()})(${target}, ${JSON.stringify(arg ?? null)})`;

/** Roda uma função com o controle do simulador: simEval(page, (sim) => sim.worldId). */
export async function simEval(page, fn, arg) {
  await ensureSimHook(page);
  return page.evaluate(call(fn, 'window.__e2eSim()', arg));
}

/** Lê um pedaço do estado do app: appState(page, (s) => s.scan.seq). */
export async function appState(page, selector, arg) {
  return page.evaluate(call(selector, 'window.__wrx.app.store.get()', arg));
}

/** Espera chegarem pelo menos `count` varreduras desde a partida. */
export async function waitForScans(page, count = 1, timeout = 20_000) {
  await page.waitForFunction((n) => window.__wrx?.app?.store.get().scan.seq >= n, count, { timeout });
}

/** Não há rolagem para o lado: nem na página, nem na área de conteúdo, e nada visível sai da tela. */
export async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const issues = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > width + 1) issues.push(`documento com ${doc.scrollWidth}px de largura (janela: ${width}px)`);
    const view = document.querySelector('.view');
    if (view && view.scrollWidth > view.clientWidth + 1) issues.push(`.view rola para o lado (${view.scrollWidth} > ${view.clientWidth})`);
    for (const el of document.querySelectorAll('#app *, .gate *, .layer *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // quem está dentro de uma faixa que rola de propósito (chips) não conta
      if (el.closest('.chips--scroll, [data-hscroll]')) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (r.right > width + 1 || r.left < -1) {
        issues.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} vai de ${Math.round(r.left)} a ${Math.round(r.right)}px`);
        if (issues.length > 8) break;
      }
    }
    return issues;
  });
}
