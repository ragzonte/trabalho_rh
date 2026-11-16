// Revisão "resiliência em celular real", de ponta a ponta.
//
// O que só aparece num aparelho de verdade: o Android continua mandando eventos com a demonstração
// ligada, a pessoa anda com o app aberto e a conexão não é reenviada, o bloqueio some sem a tela
// passar por "voltar ao app", o app vai para o bolso no meio de um mapeamento...
//
// Boa parte roda com um "celular" de mentira (fake-native.mjs + os botões de phoneKnobs, abaixo):
// a página parte no modo normal, com window.WrxNative, como dentro do APK. O resto roda no
// simulador, como a suíte toda.
//
// Cada teste abre o app numa página nova; fechar a página falha o teste se houve erro,
// console.error, alert(), violação de CSP ou recurso que não carregou.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, withApp, goto, settle, waitForScans, simState, simEval } from './helpers.mjs';
import { installFakeNative, REAL_BSSID, REAL_SSID } from './fake-native.mjs';

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

/**
 * Roda DENTRO da página, logo depois de installFakeNative: dá ao teste o controle do que o
 * "celular" responde em status/info/connection e de como ele trata os pedidos de busca.
 *   window.__fake.status        o Status que o celular informa (o teste pode trocar os campos)
 *   window.__fake.emitStatus()  o Android reenvia o Status (como em Bridge.onResume)
 *   window.__fake.identity      false = o Android esconde o nome e o BSSID da conexão
 *   window.__fake.emit(nome, dados)
 */
function phoneKnobs(options) {
  const fake = window.__fake;
  const native = window.WrxNative;
  const call = native.call.bind(native);
  const callAsync = native.callAsync.bind(native);
  fake.status = { wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: false, canScan: true, ...((options && options.status) || {}) };
  fake.info = (options && options.info) || null;
  fake.identity = !(options && options.identity === false);
  fake.emit = (name, data) => window.__wrx.emit(name, JSON.stringify(data));
  fake.emitStatus = () => fake.emit('status', fake.status);
  native.call = (method, args) => {
    if (method === 'status') {
      fake.calls.push(method);
      return JSON.stringify(fake.status);
    }
    const out = JSON.parse(call(method, args));
    if (method === 'info' && fake.info) return JSON.stringify({ ...out, ...fake.info });
    if (method === 'connection' && !fake.identity) {
      delete out.ssid;
      delete out.bssid;
    }
    return JSON.stringify(out);
  };
  native.callAsync = (id, method, args) => {
    if (method === 'scan' && !fake.status.canScan) {
      fake.calls.push(method);
      setTimeout(() => window.__wrx.resolve(id, JSON.stringify({ accepted: false, reason: 'no-permission' })), 10);
      return;
    }
    if (method === 'requestPermission') {
      fake.calls.push(method);
      setTimeout(() => window.__wrx.resolve(id, JSON.stringify(fake.status)), 10);
      return;
    }
    callAsync(id, method, args);
  };
}

/** Abre o app "dentro do celular": ponte nativa de mentira, com os botões de phoneKnobs. */
const withPhone = (options, fn) =>
  withApp(
    env,
    {
      ...options,
      before: async (page) => {
        await page.addInitScript(installFakeNative);
        await page.addInitScript(phoneKnobs, options.phone || null);
      },
    },
    fn,
  );

const backend = (page) => page.evaluate(() => window.__wrx.app.store.get().backend);
const viewText = async (page) => (await page.evaluate(() => document.querySelector('.view').innerText)).replace(/\s+/g, ' ');
const gateKind = (page) => page.evaluate(() => window.__wrx.app.gates.current());

/** O "celular" passa a mandar esta leitura do sinal conectado duas vezes por segundo (como o evento 'rssi'). */
const liveRssi = (page, dbm, more = {}) =>
  page.evaluate(
    ([value, extra]) => {
      clearInterval(window.__rssiTimer);
      const send = () => window.__fake.emit('rssi', { ts: Date.now(), rssi: value, bssid: 'd8:c6:78:11:22:30', frequency: 2437, linkSpeed: 72, ...extra });
      send();
      window.__rssiTimer = setInterval(send, 500);
    },
    [dbm, more],
  );

// ---------------------------------------------------------------------------
// realphone-01: com a demonstração ligada, o que o Android manda não entra (nem o bloqueio volta)
// ---------------------------------------------------------------------------

test('demonstração a partir do bloqueio de permissão: o Status do celular não traz o bloqueio de volta', T, async () => {
  const phone = { status: { permission: 'denied', canScan: false }, identity: false };
  await withPhone({ route: '/redes', phone }, async ({ page }) => {
    // primeiro uso, sem a permissão: o bloqueio está na tela, com o atalho da demonstração
    assert.equal(await backend(page), 'native');
    assert.equal(await gateKind(page), 'permission');
    await page.locator('.gate .btn', { hasText: 'Ver uma demonstração' }).click();
    await page.waitForFunction(() => window.__wrx.app.store.get().backend === 'sim' && window.__wrx.app.store.get().scan.seq >= 1);
    assert.equal(await gateKind(page), null);
    const calls = await page.evaluate(() => window.__fake.calls.slice());
    assert.ok(calls.includes('unwatchRssi'), `ao sair do celular de verdade ele para de mandar o sinal a cada segundo (chamadas: ${calls.join(', ')})`);

    // o usuário troca de app e volta: o Android reenvia o Status (permissão negada) e segue mandando
    // buscas do sistema, o sinal e a conexão
    await page.evaluate(() => {
      window.__fake.emitStatus();
      window.__fake.systemScan();
      window.__fake.rssi(-31);
      window.__fake.emit('connection', { connected: true, ssid: 'MinhaCasaReal', bssid: 'd8:c6:78:11:22:30', rssi: -31 });
    });
    await settle(page);
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => {
      const s = window.__wrx.app.store.get();
      return { backend: s.backend, permission: s.status.permission, canScan: s.status.canScan, paused: s.loop.paused, bssids: s.aps.map((a) => a.bssid), ssid: s.connection && s.connection.ssid, rssi: s.rssi && s.rssi.rssi };
    });
    assert.equal(await gateKind(page), null, 'o bloqueio de permissão não reaparece por cima da demonstração');
    assert.equal(await page.locator('.gate').count(), 0);
    assert.deepEqual({ backend: state.backend, permission: state.permission, canScan: state.canScan, paused: state.paused }, { backend: 'sim', permission: 'granted', canScan: true, paused: null });
    assert.ok(!state.bssids.includes(REAL_BSSID), 'a rede de verdade não entra na casa virtual');
    assert.notEqual(state.ssid, REAL_SSID);
    assert.notEqual(state.rssi, -31);

    // a demonstração continua buscando (o laço não ficou em pausa por causa do Status do celular)
    const seq = await page.evaluate(() => window.__wrx.app.store.get().scan.seq);
    await page.evaluate(() => window.__wrx.app.scanLoop.scanNow());
    await page.waitForFunction((n) => window.__wrx.app.store.get().scan.seq > n, seq, { timeout: 30_000 });

    // saindo da demonstração, vale de novo o que o celular diz: sem permissão, o bloqueio volta
    await page.evaluate(() => window.__wrx.app.store.updateSettings({ demo: false }));
    await page.waitForFunction(() => window.__wrx.app.store.get().backend === 'native');
    await page.waitForFunction(() => window.__wrx.app.gates.current() === 'permission');
    assert.equal(await page.locator('.gate .btn', { hasText: 'Ver uma demonstração' }).count(), 1);
  });
});

// ---------------------------------------------------------------------------
// realphone-02: o diagnóstico acompanha o sinal de agora, não o de quando a conexão foi informada
// ---------------------------------------------------------------------------

test('andar até um ponto fraco sem trocar de rádio: o cartão, o diagnóstico e o relatório avisam (e desavisam na volta)', T, async () => {
  await withPhone({ route: '/redes' }, async ({ page }) => {
    await waitForScans(page, 1);
    await page.waitForSelector('.net-insight');
    // perto do roteador: a conexão foi informada com −55 dBm e o Android não a reenvia mais
    await liveRssi(page, -55);
    await page.waitForFunction(() => document.querySelector('.net-insight')?.dataset.insight === 'all-good');

    // a pessoa anda: a leitura de cada segundo cai para −84 dBm, no mesmo rádio
    await liveRssi(page, -84, { linkSpeed: 6 });
    await page.waitForFunction(() => document.querySelector('.net-insight')?.dataset.insight === 'weak-signal', null, { timeout: 15_000 });
    assert.match(await page.textContent('.net-insight__text'), /Sinal muito fraco aqui \(.84\sdBm\)/);
    assert.match(await page.textContent('.net-conn__dbm'), /84/);
    assert.equal(await page.evaluate(() => window.__wrx.app.store.get().connection.rssi), -55, 'a conexão guardada continua a de antes (não foi reenviada)');

    // Melhor Wi-Fi: o diagnóstico diz o mesmo
    await goto(page, '/melhor');
    await page.waitForSelector('.best-diag[data-insight="weak-signal"]');
    assert.match(await page.textContent('.best-diag[data-insight="weak-signal"] .best-diag__title'), /Sinal muito fraco aqui/);

    // Exportar: o relatório e o JSON levam o sinal e a velocidade de agora
    await goto(page, '/ferramentas/exportar');
    await page.waitForSelector('.exp-preview__text');
    const built = await page.evaluate(async () => {
      const { liveConnection, LIVE_RSSI_SAMPLES } = await import('./js/ui/networks-logic.js');
      const { store } = window.__wrx.app;
      return liveConnection(store.get(), { history: store.rssiHistory(LIVE_RSSI_SAMPLES) });
    });
    assert.deepEqual({ rssi: built.rssi, linkSpeed: built.linkSpeed }, { rssi: -84, linkSpeed: 6 });
    await page.locator('.exp-preview__open').click();
    await page.waitForSelector('.sheet');
    const report = (await page.textContent('.sheet')).replace(/\s+/g, ' ');
    assert.match(report, /Sinal: -84 dBm/);
    assert.match(report, /Sinal muito fraco aqui/);
    assert.doesNotMatch(report, /Tudo certo com a sua conexão/);
    await page.evaluate(() => window.__wrx.back());
    await page.waitForFunction(() => !document.querySelector('.sheet'));

    // voltou para perto do roteador: o aviso some sem esperar uma troca de rádio
    await goto(page, '/melhor');
    await page.waitForSelector('.best-diag[data-insight="weak-signal"]');
    await liveRssi(page, -52, { linkSpeed: 72 });
    await page.waitForFunction(() => !document.querySelector('.best-diag[data-insight="weak-signal"]'), null, { timeout: 15_000 });
    await goto(page, '/redes');
    await page.waitForFunction(() => document.querySelector('.net-insight')?.dataset.insight === 'all-good', null, { timeout: 15_000 });
    assert.doesNotMatch(await viewText(page), /Sinal (muito )?fraco aqui/);
    await page.evaluate(() => clearInterval(window.__rssiTimer));
  });
});

// (os testes das demais descobertas vêm abaixo)
void simState;
void simEval;
