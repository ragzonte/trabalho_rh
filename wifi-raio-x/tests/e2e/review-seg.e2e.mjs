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
import { startEnv, withApp, goto, settle, waitForScreen, waitForScans, horizontalOverflow } from './helpers.mjs';
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

test('sair do levantamento direto para outra aba guarda mesmo as primeiras leituras', T, async () => {
  // (o armazenamento era fechado antes de a gravação do rascunho terminar: com menos de 3 leituras
  // o aviso dizia "o rascunho ficou guardado" e nada ficava)
  await withApp(env, { route: '/mapa', params: { speed: 10 } }, async ({ page }) => {
    await startSurvey(page, 1);
    const shown = await page.evaluate(() => Number(document.querySelector('.msv-count__value').textContent));
    await goto(page, '/redes');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast__text')].some((el) => /rascunho ficou guardado/.test(el.textContent)));
    await page.waitForTimeout(500);
    const draft = await storedDraft(page);
    assert.ok(draft, 'o rascunho foi gravado de verdade');
    assert.ok(draft.scans >= 1 && draft.scans >= shown, `as leituras da tela (${shown}) estão no rascunho (${draft.scans})`);
    assert.equal(draft.demo, true);
  });
});

// ---------------------------------------------------------------------------
// security-02: teste de velocidade simulado não vira resultado do Wi-Fi de verdade
// ---------------------------------------------------------------------------

const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(`wrx.${k}`)), key);
const speedDone = (page, timeout = 60_000) => page.waitForFunction(() => /Resultado/.test(document.querySelector('.tb-hero .tb-run__title')?.textContent || ''), null, { timeout });

test('teste de velocidade da demonstração fica fora do histórico do Wi-Fi de verdade (e vice-versa)', T, async () => {
  await withPhone({ route: '/redes' }, async ({ page }) => {
    // 1) na demonstração: roda um teste (simulado) inteiro
    await setDemo(page, true);
    await page.evaluate(async () => (await import('./js/sim/backend.js')).currentSim().setSpeed(20));
    await goto(page, '/ferramentas/velocidade');
    await page.waitForSelector('.tb-intro');
    await page.click('.tb-intro .btn--primary');
    await speedDone(page);
    assert.equal(await page.evaluate(() => window.__fake.speedCalls), 0, 'quem mediu foi o simulador');
    assert.equal((await stored(page, 'speed.history.demo')).length, 1, 'o resultado simulado vai para a lista da demonstração');
    assert.equal(await stored(page, 'speed.history'), null, 'e não para a dos testes de verdade');

    // 2) de volta ao Wi-Fi de verdade: a tela abre como quem nunca testou
    await setDemo(page, false);
    await goto(page, '/ferramentas/velocidade');
    await page.waitForSelector('.tb-intro');
    assert.equal(await page.locator('.tb-hero').count(), 0, 'nada de "último teste" que nunca aconteceu');
    assert.doesNotMatch(await viewText(page), /Último teste|pela última medição/);

    // 3) nem depois de fechar e abrir o app
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await waitForScreen(page, '/ferramentas/velocidade');
    assert.equal(await backend(page), 'native');
    await page.waitForSelector('.tb-intro');
    assert.equal(await page.locator('.tb-hero').count(), 0);

    // 4) um teste de verdade vai para a lista de verdade e aparece só nela
    await page.click('.tb-intro .btn--primary');
    await speedDone(page);
    assert.equal(await page.evaluate(() => window.__fake.speedCalls), 1);
    const real = await stored(page, 'speed.history');
    assert.equal(real.length, 1);
    assert.equal(real[0].downMbps, 93.5);
    assert.equal((await stored(page, 'speed.history.demo')).length, 1, 'a lista da demonstração não mudou');
    assert.notEqual((await stored(page, 'speed.history.demo'))[0].downMbps, 93.5);

    // 5) com a tela aberta, trocar de modo troca a lista na hora (o "celular" pede a demonstração pelo bloqueio de permissão)
    await page.evaluate(() => window.__wrx.app.store.updateSettings({ demo: true }));
    await page.waitForFunction(() => window.__wrx.app.store.get().backend === 'sim');
    await page.waitForFunction(() => /Último teste/.test(document.querySelector('.tb-hero .tb-run__title')?.textContent || ''));
    assert.doesNotMatch((await page.textContent('[data-tile="download"] .stat__value')).replace(/\s/g, ''), /^93,5/, 'na demonstração aparece o teste simulado, não o de verdade');
    await setDemo(page, false);
  });
});

// ---------------------------------------------------------------------------
// security-06: centenas de redes falsas por busca não travam a tela Redes
// ---------------------------------------------------------------------------

test('lista com centenas de redes falsas: desenha uma janela com "mostrar mais" e não refaz o que não mudou', T, async () => {
  await withApp(env, { params: { speed: 1, walk: 'still' }, route: '/redes' }, async ({ page }) => {
    await waitForScans(page, 1);
    const mine = await page.evaluate(() => window.__wrx.app.store.connectedAp().ssid);

    // um "spammer" de beacons: 500 redes falsas, mais fortes que tudo, em cada busca que chega
    await page.evaluate(() => {
      const { store } = window.__wrx.app;
      const original = store.ingestScan;
      const hx = (n) => (n & 255).toString(16).padStart(2, '0');
      let round = 0;
      store.ingestScan = function (ev) {
        round += 1;
        const fakes = [];
        for (let i = 0; i < 500; i++) {
          fakes.push({ bssid: `02:13:${hx(round)}:00:${hx(i >> 8)}:${hx(i)}`, ssid: `FREE ${round}-${i}`, level: -20 - (i % 15), frequency: i % 2 ? 5180 : 2412, channelWidth: 0, centerFreq0: 0, centerFreq1: 0, capabilities: '[ESS]', ageMs: 20, wifiStandard: 4 });
        }
        return original.call(store, { ...ev, aps: (ev.aps || []).concat(fakes) });
      };
    });
    const seq = await page.evaluate(() => window.__wrx.app.store.get().scan.seq);
    await page.evaluate(() => window.__wrx.app.scanLoop.scanNow());
    await page.waitForFunction((n) => window.__wrx.app.store.get().scan.seq > n && window.__wrx.app.store.get().aps.length > 500, seq);
    await settle(page);

    // a lista inteira continua valendo para a contagem, o filtro e a busca...
    const total = Number((await page.getAttribute('.net-list', 'aria-label')).match(/de (\d+)/)[1]);
    assert.ok(total > 500, `a lista tem ${total} redes`);
    // ...mas só uma janela dela é desenhada
    const rows = await page.locator('.net-list > .net-row').count();
    assert.ok(rows >= 80 && rows <= 92, `${rows} linhas desenhadas (o teto é 80, mais a conectada e as minhas)`);
    assert.equal(await page.locator('.net-list > .net-row--connected').count(), 1, 'a rede em uso aparece mesmo sendo mais fraca que 500 falsas');
    const more = (await page.textContent('.net-more')).replace(/\s+/g, ' ');
    assert.match(more, new RegExp(`Mostrando ${rows} de ${total}\\sredes`));
    assert.match(more, /Mostrar mais 80/);
    assert.ok((await page.evaluate(() => document.querySelectorAll('.view *').length)) < 6000, 'a página não cresce com o número de redes');
    assert.deepEqual(await horizontalOverflow(page), []);

    // redesenhar sem dado novo (a busca aberta, mesmo texto) não refaz nenhuma linha
    await page.click('[aria-label="Buscar na lista de redes"]');
    await page.waitForSelector('.net-search__input');
    const created = await page.evaluate(() => {
      let n = 0;
      const make = document.createElement;
      const makeNS = document.createElementNS;
      document.createElement = function (...args) {
        n += 1;
        return make.apply(this, args);
      };
      document.createElementNS = function (...args) {
        n += 1;
        return makeNS.apply(this, args);
      };
      try {
        document.querySelector('.net-search__input').dispatchEvent(new Event('input', { bubbles: true }));
      } finally {
        document.createElement = make;
        document.createElementNS = makeNS;
      }
      return n;
    });
    assert.ok(created < 300, `redesenho sem mudança criou ${created} elementos (refazer ${rows} linhas criaria milhares)`);
    assert.equal(await page.locator('.net-list > .net-row').count(), rows);

    // a busca olha a lista inteira, não só a janela
    await page.fill('.net-search__input', 'FREE 1-499');
    await page.waitForFunction(() => document.querySelectorAll('.net-list > .net-row').length === 1);
    assert.match(await page.textContent('.net-list > .net-row .ssid'), /FREE 1-499/);
    assert.equal(await page.locator('.net-more').count(), 0);
    await page.fill('.net-search__input', mine);
    await page.waitForFunction(() => document.querySelectorAll('.net-list > .net-row--connected').length === 1);
    await page.fill('.net-search__input', '');
    await page.waitForFunction((n) => document.querySelectorAll('.net-list > .net-row').length === n, rows);

    // "mostrar mais" acrescenta outra página; trocar a ordem volta ao começo
    await page.locator('.net-more .btn').click();
    await page.waitForFunction((n) => document.querySelectorAll('.net-list > .net-row').length >= n + 60, rows);
    assert.match(await page.textContent('.net-more'), /Mostrando 1\d\d de/);

    // a busca seguinte troca as 500 falsas por outras 500: a tela continua do mesmo tamanho
    const seq2 = await page.evaluate(() => window.__wrx.app.store.get().scan.seq);
    await page.evaluate(() => window.__wrx.app.scanLoop.scanNow());
    await page.waitForFunction((n) => window.__wrx.app.store.get().scan.seq > n, seq2, { timeout: 30_000 });
    await settle(page);
    assert.ok((await page.locator('.net-list > .net-row').count()) <= 172);
    assert.equal(await page.locator('.net-list > .net-row--connected').count(), 1);
  });
});

// ---------------------------------------------------------------------------
// security-05: o que o app diz sobre a internet é exato
// ---------------------------------------------------------------------------

test('privacidade: nenhuma tela diz que o teste de velocidade é a única coisa que usa a internet', T, async () => {
  await withApp(env, { params: { speed: 10 }, route: '/ferramentas/sobre' }, async ({ page }) => {
    const about = await viewText(page);
    assert.match(about, /só usa a internet quando você pede/);
    assert.match(about, /teste de velocidade/);
    assert.match(about, /teste de latência/);
    assert.match(about, /1\.1\.1\.1/);
    assert.match(about, /8\.8\.8\.8/);
    assert.doesNotMatch(about, /única função/);

    // Latência: medir até a internet avisa com quem fala; até o roteador não sai de casa
    await goto(page, '/ferramentas/ping');
    await page.waitForSelector('.tb-setup');
    const chip = (label) => page.locator('.tb-setup .chip', { hasText: new RegExp(`^${label}$`) });
    await chip('Roteador').click();
    assert.equal(await page.locator('.tb-note--out').count(), 0, 'até o roteador nada sai da rede da casa');
    for (const label of ['Internet', 'Internet 2', 'Site']) {
      await chip(label).click();
      await page.waitForSelector('.tb-note--out');
      assert.match(await page.textContent('.tb-note--out'), /vê o endereço IP da sua internet/, label);
    }
    await chip('Outro').click();
    assert.equal(await page.locator('.tb-note--out').count(), 0, 'sem destino digitado não há o que avisar');
    await page.fill('.tb-host input', '192.168.0.7');
    await settle(page);
    assert.equal(await page.locator('.tb-note--out').count(), 0, 'endereço da rede local');
    await page.fill('.tb-host input', 'exemplo.com.br');
    await page.waitForSelector('.tb-note--out');

    // Velocidade e Dispositivos: sem a afirmação falsa
    await goto(page, '/ferramentas/velocidade');
    await page.waitForSelector('.tb-intro');
    const speed = await viewText(page);
    assert.match(speed, /speed\.cloudflare\.com/);
    assert.doesNotMatch(speed, /única função/);
    await goto(page, '/ferramentas/dispositivos');
    await settle(page);
    const lan = await page.evaluate(() => document.body.innerText);
    assert.doesNotMatch(lan, /Nada sai do celular|conversa só com/);
  });
});
