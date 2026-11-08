// Teste ponta a ponta: simula o casal usando o app de verdade (login Google,
// criação da planilha, convite, lançamentos, sessão expirada e modo offline).
// As APIs do Google são substituídas pelo emulador js/fake-google.js.
//
// Rodar: npm test   (precisa do Playwright instalado)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { startServer } from './server.mjs';
import { createFakeGoogle } from '../js/fake-google.js';

const { chromium } = createRequire(import.meta.url)('playwright');

const fake = createFakeGoogle({ profiles: { 'ana@gmail.com': { name: 'Ana Souza' }, 'beto@gmail.com': { name: 'Beto Lima' } } });
const server = await startServer(0);
const BASE = `http://localhost:${server.address().port}/`;
const CLIENT_ID = 'teste.apps.googleusercontent.com';
const configJs = (await readFile(new URL('../js/config.js', import.meta.url), 'utf8'))
  .replace("GOOGLE_CLIENT_ID: ''", `GOOGLE_CLIENT_ID: '${CLIENT_ID}'`);

const browser = await chromium.launch();
let tokenSeq = 0;
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);
const shot = (page, name) => (process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${name}.png` }) : null);

/** Cria um "aparelho" (contexto do navegador) logado como `email`. */
async function device(email, { signedIn = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const dev = { ctx, email, offline: false, googleSession: signedIn, authCalls: [] };
  await ctx.route('**/js/config.js', (r) => r.fulfill({ body: configJs, contentType: 'text/javascript' }));
  await ctx.route('https://accounts.google.com/**', (route) => {
    const u = new URL(route.request().url());
    const p = u.searchParams;
    dev.authCalls.push(p.get('prompt') || '');
    assert.equal(p.get('client_id'), CLIENT_ID);
    assert.equal(p.get('response_type'), 'token');
    assert.equal(p.get('redirect_uri'), BASE);
    const back = new URLSearchParams({ state: p.get('state') });
    if (p.get('prompt') === 'none' && !dev.googleSession) back.set('error', 'interaction_required');
    else {
      dev.googleSession = true;
      back.set('access_token', `tok${++tokenSeq}:${dev.email}`);
      back.set('token_type', 'Bearer');
      back.set('expires_in', '3599');
      back.set('scope', p.get('scope'));
    }
    return route.fulfill({ status: 302, headers: { location: `${p.get('redirect_uri')}#${back}` } });
  });
  await ctx.route((url) => url.hostname.endsWith('googleapis.com'), async (route) => {
    if (dev.offline) return route.abort('internetdisconnected');
    const req = route.request();
    if (process.env.DEBUG) console.log(`[${email}] API ${req.method()} ${req.url().slice(0, 140)}`);
    const res = await fake.fetch(req.url(), { method: req.method(), headers: await req.allHeaders(), body: req.postData() ?? undefined });
    return route.fulfill({
      status: res.status,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: await res.text(),
    });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { throw new Error(`[${email}] erro na página: ${e.message}`); });
  if (process.env.DEBUG) {
    page.on('console', (m) => console.log(`[${email}] console.${m.type()}: ${m.text()}`));
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log(`[${email}] nav ${f.url()}`); });
  }
  dev.page = page;
  return dev;
}

const sheetRows = (title) => {
  const file = Object.values(fake.db().files).find((f) => f.sheet);
  return file.sheet.sheets.find((s) => s.title === title).rows.slice(1);
};
const spreadsheet = () => Object.values(fake.db().files).find((f) => f.sheet);

async function waitFor(fn, msg, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch { /* tenta de novo */ }
    if (Date.now() - t0 > timeout) throw new Error(`Tempo esgotado: ${msg}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const synced = (page) => page.waitForFunction(() => document.querySelector('.sync')?.textContent.trim() === 'Salvo');

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
  console.log('Contas a Dois — teste ponta a ponta\n');

  // ---------------------------------------------------------------- Ana
  const ana = await device('ana@gmail.com', { signedIn: true });
  await ana.page.goto(BASE);
  await shot(ana.page, 'login');
  await ana.page.click('[data-action="login"]');
  await ana.page.waitForSelector('[data-action="go-create"]');
  await shot(ana.page, 'setup');
  ok('Ana entra com Google e cai na tela de configuração');

  await ana.page.click('[data-action="go-create"]');
  assert.equal(await ana.page.inputValue('input[name="name"]'), 'Ana');
  await ana.page.fill('input[name="partner"]', 'Beto@Gmail.com');
  await ana.page.click('form[data-form="create"] button[type="submit"]');
  await ana.page.waitForSelector('text=Tudo pronto!');
  await ana.page.waitForSelector('text=Acesso liberado para');
  await shot(ana.page, 'criado');
  const ss = spreadsheet();
  assert.deepEqual(ss.sheet.sheets.map((s) => s.title), ['Lancamentos', 'Categorias', 'Membros', 'Config']);
  assert.deepEqual(ss.shared, ['beto@gmail.com']);
  assert.equal(sheetRows('Categorias').length, 14);
  assert.equal(sheetRows('Membros')[0][0], 'ana@gmail.com');
  const inviteUrl = (await ana.page.textContent('.linkbox')).trim();
  assert.equal(inviteUrl, `${BASE}?convite=${ss.id}`);
  ok('Planilha criada com as abas certas e compartilhada com o Beto');

  await ana.page.click('[data-action="start"]');
  await ana.page.waitForSelector('.hero');
  await addTx(ana.page, { cents: 12345, cat: 'Mercado', desc: 'Feira =SOMA(1)' });
  await addTx(ana.page, { tipo: 'receita', cents: 620000, cat: 'Salário' });
  await synced(ana.page);
  let tx = sheetRows('Lancamentos');
  assert.equal(tx.length, 2);
  assert.equal(tx[0][3], 123.45);
  assert.equal(tx[0][4], 'Feira =SOMA(1)', 'texto não pode virar fórmula');
  assert.equal(typeof tx[0][1], 'number', 'data gravada como data de verdade');
  assert.equal(tx[1][2], 'receita');
  assert.match(await ana.page.textContent('.hero .value'), /6\.076,55/);
  ok('Ana lança uma despesa e o salário; saldo R$ 6.076,55 confere');

  // ---------------------------------------------------------------- Beto
  const beto = await device('beto@gmail.com', { signedIn: true });
  await beto.page.goto(inviteUrl);
  await beto.page.waitForSelector('text=Você recebeu um convite');
  await beto.page.click('[data-action="login"]');
  await beto.page.waitForSelector('.hero');
  await synced(beto.page);
  await waitFor(() => sheetRows('Membros').length === 2, 'Beto registrado em Membros');
  assert.equal(sheetRows('Membros')[1][1], 'Beto Lima');
  await beto.page.click('[data-tab="extrato"]');
  assert.ok(await beto.page.isVisible('text=Feira =SOMA(1)'));
  ok('Beto abre o link do convite, entra e já vê os lançamentos da Ana');

  await addTx(beto.page, { cents: 8990, cat: 'Restaurantes', desc: 'Pizza' });
  await synced(beto.page);
  assert.equal(sheetRows('Lancamentos').length, 3);
  assert.equal(sheetRows('Lancamentos')[2][6], 'beto@gmail.com');

  await ana.page.click('[data-action="sync"]');
  await synced(ana.page);
  await ana.page.click('[data-tab="extrato"]');
  await ana.page.waitForSelector('text=Pizza');
  ok('Beto lança uma pizza e ela aparece para a Ana');

  // ---------------------------------------------------------------- Editar / excluir
  await ana.page.click('.tx:has-text("Pizza")');
  await ana.page.fill('input[name="valor"]', '9990');
  await ana.page.click('form[data-form="tx"] button[type="submit"]');
  await synced(ana.page);
  assert.equal(sheetRows('Lancamentos').find((r) => r[4] === 'Pizza')[3], 99.9);
  await ana.page.click('.tx:has-text("Pizza")');
  await ana.page.click('[data-del]');
  await ana.page.click('[data-del]');
  await synced(ana.page);
  assert.equal(sheetRows('Lancamentos').length, 2);
  assert.ok(!sheetRows('Lancamentos').some((r) => r[4] === 'Pizza'));
  ok('Editar valor e excluir lançamento atualizam a planilha');

  // ---------------------------------------------------------------- Categorias
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
  await synced(ana.page);
  assert.ok(sheetRows('Categorias').some((r) => r[1] === 'Academia' && r[3] === '🏋️'));
  assert.ok(sheetRows('Categorias').some((r) => r[1] === 'Supermercado'));
  assert.equal(sheetRows('Lancamentos')[0][5], 'Supermercado', 'renomear categoria atualiza lançamentos');
  ok('Nova categoria criada e renomeação refletida nos lançamentos');

  // ---------------------------------------------------------------- Sessão expirada
  const anaToken = await ana.page.evaluate(() => JSON.parse(localStorage.getItem('cad.token')).token);
  fake.invalidate(anaToken);
  await ana.page.click('[data-tab="inicio"]');
  await addTx(ana.page, { cents: 5000, cat: 'Lazer', desc: 'Cinema' });
  await waitFor(() => sheetRows('Lancamentos').some((r) => r[4] === 'Cinema'), 'lançamento enviado após renovar login');
  assert.equal(ana.authCalls.at(-1), 'none', 'renovação silenciosa (prompt=none)');
  await ana.page.waitForSelector('.hero');
  ok('Token expirado: renova o login sozinho e envia o que estava pendente');

  // ---------------------------------------------------------------- Offline
  ana.offline = true;
  await addTx(ana.page, { cents: 1500, cat: 'Transporte', desc: 'Ônibus' });
  await ana.page.waitForFunction(() => /Offline/.test(document.querySelector('.sync')?.textContent));
  assert.ok(await ana.page.isVisible('text=enviando…'));
  assert.ok(!sheetRows('Lancamentos').some((r) => r[4] === 'Ônibus'));
  ana.offline = false;
  await ana.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => sheetRows('Lancamentos').some((r) => r[4] === 'Ônibus'), 'lançamento offline enviado');
  await synced(ana.page);
  ok('Sem internet: lançamento fica pendente e é enviado ao reconectar');

  // ---------------------------------------------------------------- Novo aparelho
  const ana2 = await device('ana@gmail.com', { signedIn: true });
  await ana2.page.goto(BASE);
  await ana2.page.click('[data-action="login"]');
  await ana2.page.waitForSelector('.hero');
  await synced(ana2.page);
  await ana2.page.click('[data-tab="extrato"]');
  await ana2.page.waitForSelector('text=Ônibus');
  ok('Em outro aparelho, a Ana entra e o app acha a planilha sozinho');

  // ---------------------------------------------------------------- Sem permissão
  const carla = await device('carla@gmail.com', { signedIn: true });
  await carla.page.goto(inviteUrl);
  await carla.page.click('[data-action="login"]');
  await carla.page.waitForSelector('text=Ainda sem acesso');
  await shot(carla.page, 'sem-acesso');
  assert.ok(await carla.page.isVisible('text=carla@gmail.com'));
  ok('Quem abre o convite sem acesso liberado vê instruções claras');

  // ---------------------------------------------------------------- Reabrir o app
  await beto.page.goto(BASE);
  await beto.page.waitForSelector('.hero');
  assert.equal(beto.authCalls.length, 1, 'com token válido não precisa logar de novo');
  await beto.page.evaluate(() => localStorage.removeItem('cad.token'));
  await beto.page.goto(BASE);
  await beto.page.waitForSelector('.hero');
  assert.equal(beto.authCalls.at(-1), 'none');
  beto.googleSession = false;
  await beto.page.evaluate(() => { localStorage.removeItem('cad.token'); sessionStorage.clear(); });
  await beto.page.goto(BASE);
  await beto.page.waitForSelector('[data-action="login"]');
  ok('Reabrir o app: entra direto; sem sessão Google, mostra o botão de login');

  console.log(`\nTudo certo: ${step} cenários passaram.`);
} catch (e) {
  console.error('\n✗ FALHOU:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
