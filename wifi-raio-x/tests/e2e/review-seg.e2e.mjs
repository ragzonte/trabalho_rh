// Revisão de segurança e privacidade, de ponta a ponta.
//
// A maior parte destes testes roda com um "celular" de mentira (fake-native.mjs): a página parte
// no modo normal, com window.WrxNative, e o teste liga e desliga a demonstração como o usuário
// faria no aparelho. É a costura que o resto da suíte (sempre no simulador) não alcança:
//   - o que foi feito na casa virtual não pode continuar, nem aparecer, como se fosse do Wi-Fi de
//     verdade (rascunho do mapa, histórico do teste de velocidade), e vice-versa;
//   - o que o Android manda por conta própria não entra na casa virtual.
// Os demais conferem, no simulador, limites contra dados hostis (lista com centenas de redes).
//
// Cada teste abre o app numa página nova; fechar a página falha o teste se houve erro,
// console.error, alert(), violação de CSP ou recurso que não carregou.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, withApp, goto, settle, waitForScreen } from './helpers.mjs';
import { installFakeNative, REAL_BSSID, REAL_NEIGHBOUR_BSSID } from './fake-native.mjs';

const T = { timeout: 180_000 };

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

// ---------------------------------------------------------------------------
// Ajudas
// ---------------------------------------------------------------------------

/** Abre o app "dentro do celular": com a ponte nativa de mentira instalada antes de tudo. */
const withPhone = (options, fn) => withApp(env, { ...options, before: (page) => page.addInitScript(installFakeNative) }, fn);

const backend = (page) => page.evaluate(() => window.__wrx.app.store.get().backend);
const hash = (page) => page.evaluate(() => location.hash);
const viewText = async (page) => (await page.evaluate(() => document.querySelector('.view').innerText)).replace(/\s+/g, ' ');

/** Liga ou desliga o modo demonstração pelo interruptor dos Ajustes, como o usuário. */
async function setDemo(page, on) {
  await goto(page, '/ferramentas/ajustes');
  const row = page.locator('.view label, .view .row', { hasText: 'Modo demonstração' }).first();
  await row.locator('input[type="checkbox"]').first().click();
  await page.waitForFunction((kind) => window.__wrx.app.store.get().backend === kind, on ? 'sim' : 'native');
  if (on) {
    // a pessoa virtual anda mais depressa: as leituras do levantamento ficam diferentes entre si
    await page.evaluate(async () => (await import('./js/sim/backend.js')).currentSim().setSpeed(10));
  }
  await settle(page);
}

/** Começa um mapa novo pela biblioteca e espera o levantamento ter pelo menos `min` leituras. */
async function startSurvey(page, min = 3) {
  await goto(page, '/mapa');
  await page.locator('.mlib-hero .btn', { hasText: 'Novo mapa' }).click();
  await page.locator('.sheet .btn--primary', { hasText: 'Começar' }).click();
  await waitForScreen(page, '/mapa/novo');
  await page.waitForSelector('.msv__bar .btn--primary');
  await page.waitForFunction((n) => Number(document.querySelector('.msv-count__value')?.textContent) >= n, min, { timeout: 90_000 });
}

/** O rascunho guardado: de qual modo é, quantas leituras tem e quais BSSIDs aparecem nelas. */
const storedDraft = (page) =>
  page.evaluate(async () => {
    const { openMapStore } = await import('./js/mapping/storage.js');
    const store = await openMapStore();
    const draft = await store.draft.load();
    store.close();
    if (!draft) return null;
    // o retrato do gravador traz o levantamento em `survey` (um rascunho feito pela tela de resultado é o próprio levantamento)
    const survey = (draft.recorder && draft.recorder.survey) || draft.recorder || {};
    const ids = new Set();
    for (const scan of survey.scans || []) for (const r of scan.readings || []) ids.add(r.id);
    for (const key of Object.keys(survey.aps || {})) ids.add(key);
    for (const key of Object.keys((draft.recorder && draft.recorder.meta) || {})) ids.add(key);
    for (const q of survey.track || []) ids.add(q.id);
    return { demo: draft.demo, scans: draft.summary ? draft.summary.scans : null, bssids: [...ids].filter((x) => typeof x === 'string') };
  });

const hasReal = (draft) => draft.bssids.includes(REAL_BSSID) || draft.bssids.includes(REAL_NEIGHBOUR_BSSID);

// ---------------------------------------------------------------------------
// security-01: um levantamento pertence ao modo em que começou
// ---------------------------------------------------------------------------

test('rascunho da demonstração não continua com o Wi-Fi de verdade (nem o contrário)', T, async () => {
  await withPhone({ route: '/redes' }, async ({ page }) => {
    assert.equal(await backend(page), 'native', 'com a ponte nativa o app parte no modo normal');

    // 1) demonstração ligada: começa um mapa na casa virtual, deixa leituras entrarem e sai
    await setDemo(page, true);
    await startSurvey(page, 3);
    await goto(page, '/redes');
    await page.waitForFunction(async () => {
      const { openMapStore } = await import('./js/mapping/storage.js');
      const store = await openMapStore();
      const draft = await store.draft.load();
      store.close();
      return !!draft;
    });
    const before = await storedDraft(page);
    assert.equal(before.demo, true, 'o rascunho guarda de onde veio');
    assert.ok(before.scans >= 3);
    assert.ok(before.bssids.length > 0 && !hasReal(before), 'só redes da casa virtual');

    // 2) de volta ao Wi-Fi de verdade: o cartão diz de onde é o rascunho e não oferece "Continuar"
    await setDemo(page, false);
    await goto(page, '/mapa');
    await page.waitForSelector('.mlib-draft');
    const card = (await page.textContent('.mlib-draft')).replace(/\s+/g, ' ');
    assert.match(card, /Rascunho da demonstração/);
    assert.match(card, /ligue o modo demonstração/i, 'explica como continuar');
    assert.doesNotMatch(card, /Mapeamento em andamento/);
    assert.equal(await page.locator('.mlib-draft .btn', { hasText: 'Continuar' }).count(), 0);
    assert.equal(await page.locator('.mlib-draft .btn', { hasText: 'Descartar' }).count(), 1);

    // 3) nem indo direto para o levantamento: volta para a biblioteca sem tocar no rascunho
    await page.evaluate(() => {
      location.hash = '#/mapa/novo';
    });
    await page.waitForFunction(() => location.hash === '#/mapa' && !!document.querySelector('.mlib-draft'));
    await page.waitForTimeout(4000); // tempo de sobra para uma busca do "celular" chegar
    const after = await storedDraft(page);
    assert.deepEqual({ demo: after.demo, scans: after.scans }, { demo: before.demo, scans: before.scans }, 'o rascunho ficou como estava');
    assert.ok(!hasReal(after), 'nenhuma rede de verdade entrou no rascunho da casa virtual');

    // 4) religando a demonstração, o mesmo rascunho volta a poder ser continuado
    await setDemo(page, true);
    await goto(page, '/mapa');
    await page.waitForSelector('.mlib-draft');
    assert.match(await page.textContent('.mlib-draft'), /Mapeamento em andamento/);
    await page.locator('.mlib-draft .btn', { hasText: 'Continuar' }).click();
    await waitForScreen(page, '/mapa/novo');
    await page.waitForFunction((n) => Number(document.querySelector('.msv-count__value')?.textContent) >= n, before.scans);
    await goto(page, '/redes');
  });
});

test('trocar de modo com o levantamento aberto encerra o levantamento; leitura do outro lado não entra', T, async () => {
  await withPhone({ route: '/redes' }, async ({ page }) => {
    await setDemo(page, true);
    await startSurvey(page, 3);
    // pela pílula "Demonstração" da barra de cima, sem sair da tela
    await page.click('.topbar .pill');
    await page.locator('.sheet .btn', { hasText: 'Usar o Wi-Fi de verdade' }).click();
    await page.waitForFunction(() => window.__wrx.app.store.get().backend === 'native');
    await page.waitForFunction(() => location.hash === '#/mapa' && !!document.querySelector('.mlib-draft'), null, { timeout: 15_000 });
    assert.match(await page.textContent('.mlib-draft'), /Rascunho da demonstração/);
    // o "celular" entrega buscas (pedidas e por conta própria): nenhuma vai para o rascunho
    await page.evaluate(() => window.__fake.systemScan());
    await page.waitForTimeout(4000);
    const draft = await storedDraft(page);
    assert.equal(draft.demo, true, 'o rascunho continua sendo da demonstração');
    assert.ok(draft.scans >= 3);
    assert.ok(!hasReal(draft), 'o gravador não recebeu nenhuma leitura do Wi-Fi de verdade');

    // o contrário: um levantamento do Wi-Fi de verdade, visto de dentro da demonstração
    await page.locator('.mlib-draft .btn', { hasText: 'Descartar' }).click();
    await page.locator('.sheet .btn, dialog .btn, [role="dialog"] .btn, [role="alertdialog"] .btn', { hasText: 'Descartar' }).last().click();
    await page.waitForFunction(() => !document.querySelector('.mlib-draft'));
    await startSurvey(page, 2);
    await goto(page, '/redes');
    await setDemo(page, true);
    await goto(page, '/mapa');
    await page.waitForSelector('.mlib-draft');
    const card = (await page.textContent('.mlib-draft')).replace(/\s+/g, ' ');
    assert.match(card, /Rascunho do Wi-Fi de verdade/);
    assert.match(card, /saia da demonstração/i);
    assert.equal(await page.locator('.mlib-draft .btn', { hasText: 'Continuar' }).count(), 0);
    const real = await storedDraft(page);
    assert.equal(real.demo, false);
    assert.ok(real.bssids.includes(REAL_BSSID), 'as leituras são do "celular"');
    assert.ok(real.bssids.every((b) => b === REAL_BSSID || b === REAL_NEIGHBOUR_BSSID), 'nenhuma rede da casa virtual entrou');
  });
});

test('o que o Android manda por conta própria não entra na casa virtual', T, async () => {
  await withPhone({ route: '/redes' }, async ({ page }) => {
    await setDemo(page, true);
    await goto(page, '/redes');
    await page.waitForFunction(() => window.__wrx.app.store.get().aps.length > 3);
    // busca do sistema, sinal da rede conectada e mudança de conexão vindos do celular de verdade
    await page.evaluate(() => {
      window.__fake.systemScan();
      window.__fake.rssi(-31);
      window.__wrx.emit('connection', JSON.stringify({ connected: true, ssid: 'MinhaCasaReal', bssid: 'd8:c6:78:11:22:30' }));
    });
    await settle(page);
    const state = await page.evaluate(() => {
      const s = window.__wrx.app.store.get();
      return { bssids: s.aps.map((a) => a.bssid), ssid: s.connection && s.connection.ssid, rssi: s.rssi && s.rssi.rssi };
    });
    assert.ok(!state.bssids.includes(REAL_BSSID), 'a rede de verdade não aparece na lista da demonstração');
    assert.notEqual(state.ssid, 'MinhaCasaReal', 'a conexão continua sendo a da casa virtual');
    assert.notEqual(state.rssi, -31);
    assert.doesNotMatch(await viewText(page), /MinhaCasaReal/);
    assert.equal(await hash(page), '#/redes');
  });
});
