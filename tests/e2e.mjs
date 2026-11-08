// Teste ponta a ponta: simula o casal usando o app (sem login).
// O "Google" aqui é o emulador js/fake-sheets.js rodando o MESMO
// apps-script/Codigo.gs que vai na planilha de verdade.
//
// Rodar: npm test   (precisa do Playwright instalado)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { startServer } from './server.mjs';
import { createScriptServer } from '../js/fake-sheets.js';

const { chromium } = createRequire(import.meta.url)('playwright');

const code = await readFile(new URL('../apps-script/Codigo.gs', import.meta.url), 'utf8');
const sheets = createScriptServer(code);
const LINK = 'https://script.google.com/macros/s/AKfycbTESTE1234567890abcdefghijklmnop/exec';
const server = await startServer(0);
const BASE = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch();
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null);
const rows = (tab) => sheets.sheet(tab).rows.slice(1).filter((r) => r.some((v) => v !== '' && v !== undefined));

/** Um "celular". `android: true` simula o app Android (window.AndroidApp). */
async function phone(name, { android = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const dev = { ctx, offline: false, shared: [], copied: [], opened: [], clipboard: '' };
  await ctx.exposeBinding('__nativeLog', (src, kind, text) => { dev[kind].push(text); });
  if (android) {
    await ctx.addInitScript(() => {
      window.AndroidApp = {
        share: (t) => window.__nativeLog('shared', t),
        copy: (t) => window.__nativeLog('copied', t),
        openUrl: (u) => window.__nativeLog('opened', u),
        readClipboard: () => window.__clipboard || '',
      };
    });
  }
  await ctx.route((url) => url.hostname === 'script.google.com', async (route) => {
    if (dev.offline) return route.abort('internetdisconnected');
    const req = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/macros/s/AKfycbTESTE')) return route.fulfill({ status: 404, body: 'not found' });
    const res = req.method() === 'POST' ? sheets.post(req.postData()) : sheets.get(Object.fromEntries(url.searchParams));
    return route.fulfill({ status: 200, headers: { 'content-type': res.type, 'access-control-allow-origin': '*' }, body: res.body });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw new Error(`[${name}] erro na página: ${e.message}`); });
  dev.page = page;
  return dev;
}

async function waitFor(fn, msg, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch { /* tenta de novo */ }
    if (Date.now() - t0 > timeout) throw new Error(`Tempo esgotado: ${msg}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const synced = (page) => page.waitForFunction(() => document.querySelector('.sync')?.textContent.trim() === 'Salvo');

async function connect(page, link) {
  await page.goto(BASE);
  await page.fill('input[name="link"]', link);
  await page.click('form[data-form="connect"] button[type="submit"]');
}

async function addTx(page, { tipo = 'despesa', cents, cat, desc = '', who }) {
  await page.click('.fab');
  await page.waitForSelector('form[data-form="tx"]');
  if (tipo === 'receita') await page.click('[data-tipo="receita"]');
  await page.fill('input[name="valor"]', String(cents));
  if (desc) await page.fill('input[name="descricao"]', desc);
  await page.click(`[data-cat="${cat}"]`);
  if (who) await page.click(`[data-who="${who}"]`);
  await page.click('form[data-form="tx"] button[type="submit"]');
  await page.waitForSelector('.sheet', { state: 'detached' });
}

try {
  console.log('Contas a Dois — teste ponta a ponta (sem login)\n');

  // ---------------------------------------------------------------- Links errados
  const ana = await phone('Ana', { android: true });
  await connect(ana.page, 'https://docs.google.com/spreadsheets/d/1abcDEF/edit?usp=sharing');
  await ana.page.waitForSelector('text=Esse é o link da');
  await connect(ana.page, 'https://script.google.com/macros/s/AKfycbTESTE1234567890abcdefghijklmnop/dev');
  await ana.page.waitForSelector('text=link de teste');
  await connect(ana.page, 'https://script.google.com/macros/s/AKfycbOUTRO1234567890abcdefghijklmnop/exec');
  await ana.page.waitForSelector('text=não respondeu como o Contas a Dois');
  ok('Links errados (da planilha, de teste, de outro script) explicam o que fazer');

  await ana.page.click('[data-action="open-guide"]');
  await ana.page.waitForSelector('text=Criar a planilha do casal');
  await shot(ana.page, 'guia');
  await ana.page.click('[data-action="share-code"]');
  await waitFor(() => ana.shared.length === 1, 'código enviado');
  assert.match(ana.shared[0], /function doPost/);
  await ana.page.click('.sheet-head [data-action="close-sheet"]');
  ok('Guia de criação envia o código do script para o computador');

  // ---------------------------------------------------------------- Ana conecta
  await ana.page.evaluate((l) => { window.__clipboard = `  ${l}  `; }, LINK);
  await ana.page.click('[data-action="paste-link"]');
  assert.equal(await ana.page.inputValue('input[name="link"]'), LINK);
  await shot(ana.page, 'conectar');
  await ana.page.click('form[data-form="connect"] button[type="submit"]');
  await ana.page.waitForSelector('text=Quem é você?');
  assert.deepEqual(sheets.db.sheets.map((s) => s.name), ['Lancamentos', 'Categorias', 'Membros']);
  assert.equal(rows('Categorias').length, 14);
  await ana.page.fill('input[name="nome"]', 'Ana');
  await ana.page.click('form[data-form="who"] button[type="submit"]');
  await ana.page.waitForSelector('.hero');
  await synced(ana.page);
  assert.deepEqual(rows('Membros').map((r) => r[0]), ['Ana']);
  ok('Ana cola o link (botão Colar), o script cria as abas e ela entra como "Ana"');

  await addTx(ana.page, { cents: 12345, cat: 'Mercado', desc: 'Feira =SOMA(1)' });
  await addTx(ana.page, { tipo: 'receita', cents: 620000, cat: 'Salário' });
  await synced(ana.page);
  let tx = rows('Lancamentos');
  assert.equal(tx.length, 2);
  assert.equal(tx[0][3], 123.45);
  assert.equal(tx[0][4], 'Feira =SOMA(1)');
  assert.ok(tx[0][1] instanceof Date, 'data gravada como data de verdade');
  assert.equal(tx[0][6], 'Ana');
  assert.match(await ana.page.textContent('.hero .value'), /6\.076,55/);
  ok('Ana lança uma despesa e o salário; saldo R$ 6.076,55 confere');

  await ana.page.click('[data-tab="ajustes"]');
  await ana.page.click('[data-action="open-invite"]');
  await ana.page.click('[data-action="share-invite"]');
  await waitFor(() => ana.shared.length === 2, 'convite enviado');
  assert.ok(ana.shared[1].includes(LINK) && ana.shared[1].includes('.apk'));
  await ana.page.click('.sheet-head [data-action="close-sheet"]');
  ok('Ana manda o convite (link da planilha + link do app) pelo compartilhar do Android');

  // ---------------------------------------------------------------- Beto
  const beto = await phone('Beto');
  await connect(beto.page, `Abra o app e cole este link:\n${LINK}`);
  await beto.page.waitForSelector('text=Quem é você?');
  await shot(beto.page, 'quem');
  assert.ok(await beto.page.isVisible('[data-action="pick-me"][data-name="Ana"]'));
  await beto.page.fill('input[name="nome"]', 'Beto');
  await beto.page.click('form[data-form="who"] button[type="submit"]');
  await beto.page.waitForSelector('.hero');
  await synced(beto.page);
  assert.deepEqual(rows('Membros').map((r) => r[0]), ['Ana', 'Beto']);
  await beto.page.click('[data-tab="extrato"]');
  await beto.page.waitForSelector('text=Feira =SOMA(1)');
  ok('Beto cola a mensagem inteira do convite, entra como "Beto" e já vê os lançamentos');

  await addTx(beto.page, { cents: 8990, cat: 'Restaurantes', desc: 'Pizza' });
  await synced(beto.page);
  assert.equal(rows('Lancamentos').length, 3);
  assert.equal(rows('Lancamentos')[2][6], 'Beto');
  await ana.page.click('[data-action="sync"]');
  await synced(ana.page);
  await ana.page.click('[data-tab="extrato"]');
  await ana.page.waitForSelector('text=Pizza');
  ok('Beto lança uma pizza e ela aparece para a Ana');

  // ---------------------------------------------------------------- Ao mesmo tempo
  await Promise.all([
    addTx(ana.page, { cents: 1000, cat: 'Lazer', desc: 'Sorvete A' }),
    addTx(beto.page, { cents: 2000, cat: 'Lazer', desc: 'Sorvete B' }),
  ]);
  await Promise.all([synced(ana.page), synced(beto.page)]);
  assert.equal(rows('Lancamentos').length, 5);
  ok('Os dois lançando ao mesmo tempo: nada se perde');

  // ---------------------------------------------------------------- Editar / excluir
  await ana.page.click('.tx:has-text("Pizza")');
  await ana.page.fill('input[name="valor"]', '9990');
  await ana.page.click('[data-who="Ana"]');
  await ana.page.click('form[data-form="tx"] button[type="submit"]');
  await synced(ana.page);
  let pizza = rows('Lancamentos').find((r) => r[4] === 'Pizza');
  assert.equal(pizza[3], 99.9);
  assert.equal(pizza[6], 'Ana');
  await ana.page.click('.tx:has-text("Sorvete B")');
  await ana.page.click('[data-del]');
  await ana.page.click('[data-del]');
  await synced(ana.page);
  assert.equal(rows('Lancamentos').length, 4);
  ok('Editar (valor e quem pagou) e excluir lançamento atualizam a planilha');

  // ---------------------------------------------------------------- Categorias e nomes
  await ana.page.click('[data-tab="ajustes"]');
  await ana.page.click('[data-action="open-cats"]');
  await ana.page.click('[data-new-cat]');
  await ana.page.fill('input[name="nome"]', 'Academia');
  await ana.page.click('[data-emoji="🏋️"]');
  await ana.page.click('form[data-form="cat"] button[type="submit"]');
  await ana.page.waitForSelector('text=Academia');
  const mercadoId = await ana.page.getAttribute('.list-item:has-text("Mercado")', 'data-edit-cat');
  await ana.page.click(`[data-edit-cat="${mercadoId}"]`);
  await ana.page.fill('input[name="nome"]', 'Supermercado');
  await ana.page.click('form[data-form="cat"] button[type="submit"]');
  await ana.page.click('.sheet-head [data-action="close-sheet"]');
  await ana.page.click('[data-action="edit-name"]');
  await ana.page.fill('form[data-form="name"] input[name="nome"]', 'Aninha');
  await ana.page.click('form[data-form="name"] button[type="submit"]');
  await synced(ana.page);
  assert.ok(rows('Categorias').some((r) => r[1] === 'Academia' && r[3] === '🏋️'));
  assert.equal(rows('Lancamentos')[0][5], 'Supermercado', 'renomear categoria atualiza lançamentos');
  assert.deepEqual(rows('Membros').map((r) => r[0]), ['Aninha', 'Beto']);
  assert.ok(!rows('Lancamentos').some((r) => r[6] === 'Ana'), 'renomear pessoa atualiza lançamentos');
  ok('Nova categoria, renomear categoria e renomear pessoa refletem na planilha');

  // ---------------------------------------------------------------- Offline
  beto.offline = true;
  await beto.page.click('[data-tab="inicio"]');
  await addTx(beto.page, { cents: 1500, cat: 'Transporte', desc: 'Ônibus' });
  await beto.page.waitForFunction(() => /Offline/.test(document.querySelector('.sync')?.textContent));
  assert.ok(await beto.page.isVisible('text=enviando…'));
  await beto.page.reload();
  await beto.page.waitForSelector('text=Ônibus');
  assert.ok(!rows('Lancamentos').some((r) => r[4] === 'Ônibus'));
  beto.offline = false;
  await beto.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => rows('Lancamentos').some((r) => r[4] === 'Ônibus'), 'lançamento offline enviado');
  await synced(beto.page);
  ok('Sem internet: o lançamento fica guardado (mesmo fechando o app) e vai quando volta a conexão');

  // ---------------------------------------------------------------- Edição direto na planilha
  sheets.sheet('Lancamentos').rows.push(['', new Date(2026, 10, 2, 0, 0), 'despesa', '45,90', 'Padaria (digitado na planilha)', 'Supermercado', 'Beto']);
  await ana.page.click('[data-action="sync"]');
  await synced(ana.page);
  await ana.page.click('[data-tab="extrato"]');
  await ana.page.click('text=Todos');
  await ana.page.waitForSelector('text=Padaria (digitado na planilha)');
  ok('Linha digitada direto no Google Sheets aparece no app');

  // ---------------------------------------------------------------- Reabrir / trocar
  await ana.page.reload();
  await ana.page.waitForSelector('.hero');
  assert.ok(await ana.page.isVisible('text=Aninha'));
  await ana.page.click('[data-tab="ajustes"]');
  await ana.page.click('[data-action="not-me"]');
  await ana.page.waitForSelector('text=Quem é você?');
  await ana.page.click('[data-action="pick-me"][data-name="Aninha"]');
  await ana.page.waitForSelector('.hero');
  ok('Reabrir o app entra direto; "Não sou eu" deixa escolher a pessoa de novo');

  // ---------------------------------------------------------------- Demonstração
  const demo = await phone('Demo');
  await demo.page.goto(BASE);
  await demo.page.click('[data-action="demo"]');
  await demo.page.waitForSelector('.hero');
  await demo.page.waitForFunction(() => document.querySelectorAll('.tx').length > 0);
  await demo.page.click('[data-tab="ajustes"]');
  await demo.page.click('[data-action="exit-demo"]');
  await demo.page.waitForSelector('form[data-form="connect"]');
  ok('Demonstração funciona sem link e dá para sair dela');

  console.log(`\nTudo certo: ${step} cenários passaram.`);
} catch (e) {
  console.error('\n✗ FALHOU:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
