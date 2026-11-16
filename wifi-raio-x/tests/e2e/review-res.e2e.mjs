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
import { startEnv, withApp, goto, settle, waitForScans, waitForScreen, simState } from './helpers.mjs';
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
 *   window.__fake.cacheAgeMs    idade (ms) das leituras da lista guardada (lastScan); sem isto, 40 ms
 *   window.__fake.holdScans     true = os pedidos de busca são aceitos, mas a lista não chega...
 *   window.__fake.releaseScans()  ...até o teste soltar (chega uma lista nova)
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
  fake.cacheAgeMs = options && typeof options.cacheAgeMs === 'number' ? options.cacheAgeMs : null;
  fake.holdScans = !!(options && options.holdScans);
  fake.releaseScans = () => {
    fake.holdScans = false;
    fake.systemScan();
  };
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
    if (method === 'lastScan' && fake.cacheAgeMs !== null) out.aps = out.aps.map((ap, i) => ({ ...ap, ageMs: fake.cacheAgeMs + i * 700 }));
    return JSON.stringify(out);
  };
  native.callAsync = (id, method, args) => {
    if (method === 'scan' && !fake.status.canScan) {
      fake.calls.push(method);
      setTimeout(() => window.__wrx.resolve(id, JSON.stringify({ accepted: false, reason: 'no-permission' })), 10);
      return;
    }
    if (method === 'scan' && fake.holdScans) {
      fake.calls.push(method);
      setTimeout(() => window.__wrx.resolve(id, JSON.stringify({ accepted: true })), 10);
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

// ---------------------------------------------------------------------------
// realphone-06: uma varredura = uma atualização só da tela Redes
// ---------------------------------------------------------------------------

const layoutCount = async (cdp) => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'LayoutCount').value;

test('batch(): várias atualizações contam como uma só (um acerto de rolagem e de foco, no fim)', T, async () => {
  await withApp(env, { params: { speed: 1, walk: 'still' }, route: '/ferramentas/sobre' }, async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    // uma "tela" de teste: quem rola é o pai; dentro, cinco regiões atualizadas uma a uma
    await page.evaluate(async () => {
      const { h, patch, batch } = await import('./js/ui/dom.js');
      const regions = [0, 1, 2, 3, 4].map(() => h('div'));
      const root = h('div', null, regions);
      const scroller = h('div', { style: { position: 'fixed', top: '0', left: '0', width: '300px', height: '200px', overflow: 'auto', zIndex: 9999, background: '#000' } }, root);
      const other = h('div');
      const otherScroller = h('div', { style: { position: 'fixed', top: '0', left: '320px', width: '60px', height: '100px', overflow: 'auto', zIndex: 9999 } }, other);
      document.body.append(scroller, otherScroller);
      let round = 0;
      const block = (key, px) => h('div', { key, style: { height: `${px}px` } }, key);
      const draw = (i) => {
        const kids = [block(`a${i}`, 80 + round * 3), block(`b${i}`, 90), block(`c${i}`, 70 + round)];
        if (i === 2) kids.push(h('input', { key: 'campo', type: 'text', value: 'texto digitado' }));
        if (round % 2) kids.reverse(); // a ordem muda a cada rodada (o campo com foco muda de lugar)
        patch(regions[i], kids);
      };
      const drawOther = () => patch(other, [block('x', 400 + round), block('y', 300)]);
      const all = () => {
        round += 1;
        for (let i = 0; i < 5; i++) draw(i);
      };
      all();
      drawOther();
      scroller.scrollTop = 300;
      otherScroller.scrollTop = 150;
      const input = root.querySelector('input');
      input.focus({ preventScroll: true });
      input.setSelectionRange(2, 5);
      window.__lote = {
        separate: all,
        batched: () => batch(root, all),
        // dentro do lote, uma atualização FORA da raiz dele continua cuidando da própria rolagem
        mixed: () =>
          batch(root, () => {
            all();
            drawOther();
          }),
        state: () => ({ top: scroller.scrollTop, otherTop: otherScroller.scrollTop, focused: document.activeElement === root.querySelector('input'), selection: [root.querySelector('input').selectionStart, root.querySelector('input').selectionEnd], sameInput: root.querySelector('input') === input }),
        remove: () => {
          scroller.remove();
          otherScroller.remove();
        },
      };
    });
    const expected = { top: 300, otherTop: 150, focused: true, selection: [2, 5], sameInput: true };
    const measure = async (name) => {
      await settle(page);
      const before = await layoutCount(cdp);
      await page.evaluate((n) => window.__lote[n](), name);
      const after = await layoutCount(cdp);
      assert.deepEqual(await page.evaluate(() => window.__lote.state()), expected, `${name}: a rolagem, o foco e a seleção ficam onde estavam`);
      return after - before;
    };
    const separate = await measure('separate');
    const batched = await measure('batched');
    const mixed = await measure('mixed');
    await page.evaluate(() => window.__lote.remove());
    // cada patch() sozinho relê a rolagem depois de mexer (um layout forçado por região); o lote relê uma vez
    assert.ok(separate >= 5, `cinco atualizações separadas: ${separate} layouts`);
    assert.ok(batched <= 2, `as mesmas cinco num lote: ${batched} layouts`);
    assert.ok(mixed <= 4, `lote + uma atualização de fora: ${mixed} layouts`);
  });
});

test('Redes com 150 redes: cada varredura acerta a rolagem uma vez só, sem perder a posição nem o foco', T, async () => {
  await withApp(env, { params: { speed: 1, walk: 'still', hostile: 0 }, route: '/redes' }, async ({ page }) => {
    await waitForScans(page, 1);
    await page.evaluate(() => {
      window.__wrx.app.scanLoop.setMode('paused');
      const hx = (n) => (n & 255).toString(16).padStart(2, '0');
      let round = 0;
      const t0 = Date.now();
      // 150 redes; a cada rodada todos os sinais mudam e a ordem da lista muda junto
      window.__feed = () => {
        round += 1;
        const aps = [];
        for (let i = 0; i < 150; i++) {
          aps.push({ bssid: `02:11:22:00:${hx(i >> 8)}:${hx(i)}`, ssid: `Rede ${i}`, level: -40 - ((i * 7 + round * 3) % 50), frequency: i % 2 ? 5180 + 20 * (i % 8) : 2412 + 5 * (i % 11), channelWidth: 0, centerFreq0: 0, centerFreq1: 0, capabilities: '[WPA2-PSK-CCMP][ESS]', ageMs: 30, wifiStandard: 4 });
        }
        // cada rodada 2 s depois da anterior no relógio do "celular" (o mesmo beacon relido em menos de 0,5 s não conta como leitura nova)
        window.__wrx.app.store.ingestScan({ ts: t0 + round * 2000, fresh: true, source: 'request', aps });
      };
      window.__feed();
      window.__feed();
    });
    await settle(page);
    assert.equal(await page.locator('.net-list > .net-row').count(), 80, 'a lista desenha uma janela de 80 linhas');

    // a pessoa rolou a lista e deixou o foco numa linha (a 12ª); chega uma varredura
    const probe = await page.evaluate(() => {
      const view = document.querySelector('.view');
      view.scrollTop = 700;
      const row = document.querySelectorAll('.net-list > .net-row')[12];
      row.focus({ preventScroll: true });
      const bssid = row.dataset.bssid;
      // conta quantas vezes a rolagem da área de conteúdo é lida durante a varredura
      const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
      let reads = 0;
      Object.defineProperty(view, 'scrollTop', { configurable: true, get: () => ((reads += 1), desc.get.call(view)), set: (v) => desc.set.call(view, v) });
      const top = desc.get.call(view);
      const order = () => [...document.querySelectorAll('.net-list > .net-row')].map((r) => r.dataset.bssid).join(',');
      const before = order();
      window.__feed();
      const out = { top, topAfter: desc.get.call(view), reads, focused: document.activeElement && document.activeElement.dataset.bssid, bssid, reordered: order() !== before };
      delete view.scrollTop;
      return out;
    });
    assert.equal(probe.reordered, true, 'a varredura mudou a ordem das linhas');
    assert.equal(probe.topAfter, probe.top, 'a lista fica onde a pessoa a deixou');
    assert.equal(probe.focused, probe.bssid, 'o foco continua na mesma linha');
    assert.ok(probe.reads <= 4, `a rolagem foi lida ${probe.reads} vezes numa varredura (antes do lote: uma leitura antes e outra depois de CADA região)`);

  });
});

test('Redes: uma linha que muda de lugar não refaz o estilo da lista inteira', T, async () => {
  // Uma regra de CSS com `* + *` (o espaçamento "todos os filhos menos o primeiro" escrito como
  // `.card > * + *`) fazia o navegador recalcular o estilo de TODOS os descendentes do pai a cada
  // filho inserido, removido ou mudado de lugar: numa lista de 80 linhas, mais de 2 mil elementos por
  // varredura, e era a maior parte do tempo em que a tela ficava travada num celular modesto.
  await withApp(env, { params: { speed: 1, walk: 'still', hostile: 0 }, route: '/redes' }, async ({ page }) => {
    await waitForScans(page, 1);
    await page.evaluate(() => {
      window.__wrx.app.scanLoop.setMode('paused');
      const hx = (n) => (n & 255).toString(16).padStart(2, '0');
      const t0 = Date.now();
      let round = 0;
      // 150 redes com o sinal parado; `boost` é a única que muda (e sobe para o topo da lista)
      window.__feed = (boost) => {
        round += 1;
        const aps = [];
        for (let i = 0; i < 150; i++) {
          aps.push({ bssid: `02:11:22:00:${hx(i >> 8)}:${hx(i)}`, ssid: `Rede ${i}`, level: i === boost ? -30 : -40 - (i % 50), frequency: i % 2 ? 5180 : 2412, channelWidth: 0, centerFreq0: 0, centerFreq1: 0, capabilities: '[WPA2-PSK-CCMP][ESS]', ageMs: 30, wifiStandard: 4 });
        }
        window.__wrx.app.store.ingestScan({ ts: t0 + round * 2000, fresh: true, source: 'request', aps });
      };
      // várias rodadas iguais, até o minigráfico de cada linha parar de mudar
      for (let i = 0; i < 12; i++) window.__feed(-1);
    });
    await settle(page);
    const inList = await page.evaluate(() => document.querySelectorAll('.net-list *').length);
    assert.ok(inList > 1500, `a lista tem ${inList} elementos`);
    const top = await page.evaluate(() => document.querySelector('.net-list > .net-row .ssid').textContent);

    await env.browser.startTracing(page, { categories: ['devtools.timeline'] });
    await page.evaluate(() => window.__feed(45));
    await settle(page);
    const trace = JSON.parse((await env.browser.stopTracing()).toString());
    assert.equal(await page.evaluate(() => document.querySelector('.net-list > .net-row .ssid').textContent), 'Rede 45', `a rede que ficou forte foi para o topo (antes: ${top})`);
    const counts = trace.traceEvents.filter((ev) => ev.name === 'UpdateLayoutTree' && ev.args && typeof ev.args.elementCount === 'number').map((ev) => ev.args.elementCount);
    assert.ok(counts.length > 0, 'o rastro traz os recálculos de estilo');
    const worst = Math.max(...counts);
    assert.ok(worst < inList / 2, `uma linha mudou de lugar e o navegador recalculou o estilo de ${worst} elementos (a lista tem ${inList})`);
  });
});

// ---------------------------------------------------------------------------
// realphone-04: lista guardada velha demais não vira "nenhuma rede por perto"
// ---------------------------------------------------------------------------

test('abrir o app com a lista guardada de 3 minutos atrás: as telas esperam a primeira busca em vez de dizer que não há redes', T, async () => {
  // o celular ficou parado: a última lista do Android tem 3 min, e a primeira busca do app ainda está rodando
  await withPhone({ route: '/redes', phone: { cacheAgeMs: 180_000, holdScans: true } }, async ({ page }) => {
    await page.waitForFunction(() => window.__wrx.app.store.get().scan.scanning === true);
    await settle(page);
    const state = await page.evaluate(() => {
      const s = window.__wrx.app.store.get();
      return { seq: s.scan.seq, aps: s.aps.length, connected: !!(s.connection && s.connection.connected) };
    });
    assert.deepEqual(state, { seq: 0, aps: 0, connected: true });
    assert.equal(await page.evaluate(() => window.__fake.calls.includes('lastScan')), true, 'a lista guardada foi lida');

    const NOTHING = /Nenhuma rede por perto|não ouviu nenhuma rede|Sem dados para comparar|não apareceu na última busca|Ainda não há redes/;
    let text = await viewText(page);
    assert.match(text, /Procurando redes por perto/);
    assert.doesNotMatch(text, NOTHING);
    assert.doesNotMatch(await page.textContent('.topbar__status'), /Atualizado/, 'a barra não diz "atualizado há 3 min"');
    for (const route of ['/canais', '/melhor', '/ferramentas/historico', '/ferramentas/exportar']) {
      await goto(page, route);
      text = await viewText(page);
      assert.doesNotMatch(text, NOTHING, `${route} não afirma que não há redes enquanto a primeira busca roda`);
    }

    // a primeira lista de verdade chega: as redes aparecem
    await goto(page, '/redes');
    await page.evaluate(() => window.__fake.releaseScans());
    await page.waitForFunction(() => document.querySelectorAll('.net-list > .net-row').length === 2);
    assert.equal(await page.evaluate(() => window.__wrx.app.store.get().scan.seq), 1);
    assert.doesNotMatch(await viewText(page), /Procurando redes por perto|Nenhuma rede por perto/);
  });
});

// ---------------------------------------------------------------------------
// realphone-05: o bloqueio some sem o app sair da tela -> a conexão é relida (com nome e BSSID)
// ---------------------------------------------------------------------------

/** O que o app sabe da própria rede: a conexão, a linha "Conectado" da lista e as redes da casa. */
const identity = (page) =>
  page.evaluate(() => {
    const s = window.__wrx.app.store.get();
    return {
      gate: window.__wrx.app.gates.current(),
      ssid: (s.connection && s.connection.ssid) || '',
      bssid: (s.connection && s.connection.bssid) || '',
      connectedAp: !!s.aps.find((ap) => ap.connected),
      own: s.own.size,
      card: (document.querySelector('.net-conn__name') || {}).textContent || '',
    };
  });

test('celular: a Localização é ligada pela cortina de notificações (só chega um Status) e o app relê em que rede está', T, async () => {
  const phone = { status: { locationEnabled: false, canScan: false }, identity: false };
  await withPhone({ route: '/redes', phone }, async ({ page }) => {
    assert.equal(await gateKind(page), 'location');
    assert.equal((await identity(page)).bssid, '', 'com a Localização desligada o Android não diz em que rede o celular está');
    // liga a Localização sem sair do app: o Android só reenvia o Status (nenhum evento de conexão)
    await page.evaluate(() => {
      window.__fake.status = { ...window.__fake.status, locationEnabled: true, canScan: true };
      window.__fake.identity = true;
      window.__fake.emitStatus();
    });
    await page.waitForFunction(() => window.__wrx.app.gates.current() === null);
    await page.waitForFunction(() => window.__wrx.app.store.get().scan.seq >= 1 && !!window.__wrx.app.store.get().aps.find((ap) => ap.connected), null, { timeout: 15_000 });
    const now = await identity(page);
    assert.equal(now.ssid, REAL_SSID);
    assert.equal(now.bssid, REAL_BSSID);
    assert.ok(now.own >= 1, 'o roteador em uso conta como "da casa"');
    assert.equal(now.card, REAL_SSID, 'o cartão diz o nome da rede, não "(rede oculta)"');
    assert.equal(await page.locator('.net-list > .net-row--connected').count(), 1);
    // Melhor Wi-Fi sabe comparar a conexão com as outras redes
    await goto(page, '/melhor');
    assert.doesNotMatch(await viewText(page), /não informou em qual rede/);
  });
});

for (const [name, params, unblock] of [
  ['Localização ligada', { location: 0 }, (page) => simState(page, { location: true })],
  ['permissão concedida em "Permitir"', { permission: 'denied' }, (page) => page.locator('.gate .btn', { hasText: 'Permitir' }).click()],
]) {
  test(`simulador: bloqueio some com ${name} e o app passa a saber em que rede está`, T, async () => {
    await withApp(env, { params: { speed: 10, walk: 'still', ...params }, route: '/redes' }, async ({ page }) => {
      assert.notEqual(await gateKind(page), null);
      assert.equal((await identity(page)).bssid, '');
      await unblock(page);
      await page.waitForFunction(() => window.__wrx.app.gates.current() === null, null, { timeout: 15_000 });
      await page.waitForFunction(() => window.__wrx.app.store.get().scan.seq >= 1 && !!window.__wrx.app.store.get().aps.find((ap) => ap.connected), null, { timeout: 20_000 });
      const now = await identity(page);
      assert.notEqual(now.ssid, '');
      assert.match(now.bssid, /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
      assert.ok(now.own >= 1);
      assert.equal(now.card, now.ssid, 'o cartão diz o nome da rede, não "(rede oculta)"');
      assert.doesNotMatch(await viewText(page), /\(rede oculta\)\s*−?\d+\s*dBm/);
      await goto(page, '/melhor');
      assert.doesNotMatch(await viewText(page), /não informou em qual rede/);
    });
  });
}

// ---------------------------------------------------------------------------
// realphone-07: o relógio de caminhada do mapeamento para quando o app não pode ler o Wi-Fi
// ---------------------------------------------------------------------------

/** O app vai para o segundo plano (ou volta), como quando o Android pausa a Activity. */
const setHidden = (page, hidden) =>
  page.evaluate((value) => {
    window.__hidden = value;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (window.__hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

/** Os contadores do levantamento: leituras e segundos de caminhada ("1:05" -> 65). */
const surveyCounters = (page) =>
  page.evaluate(() => {
    const value = (key) => {
      for (const el of document.querySelectorAll('.msv-count')) if (el.querySelector('.msv-count__label').textContent.includes(key)) return el.querySelector('.msv-count__value').textContent;
      return '';
    };
    const [m, sec] = value('de caminhada').split(':').map(Number);
    return { scans: Number(value('leitura')), walkS: m * 60 + sec, paused: !!document.querySelector('.msv__bar .btn--primary') && /Retomar/.test(document.querySelector('.msv__bar .btn--primary').textContent) };
  });

/** O retrato do gravador guardado no rascunho: o trecho e o tempo de caminhada de cada leitura. */
const draftScans = (page) =>
  page.evaluate(async () => {
    const { openMapStore } = await import('./js/mapping/storage.js');
    const store = await openMapStore();
    const draft = await store.draft.load();
    store.close();
    if (!draft || !draft.recorder) return null;
    const survey = draft.recorder.survey || {};
    return { segs: draft.recorder.segs || [], t: (survey.scans || []).map((scan) => Math.round(scan.t)) };
  });

test('mapeamento: com o app fora da tela (ou num bloqueio) o relógio de caminhada para e a volta abre um trecho novo', T, async () => {
  await withApp(env, { params: { speed: 1, walk: 'auto' }, route: '/mapa', before: (page) => page.clock.install() }, async ({ page }) => {
    await page.locator('.mlib-hero .btn', { hasText: 'Novo mapa' }).click();
    await page.locator('.sheet .btn--primary', { hasText: 'Começar' }).click();
    await waitForScreen(page, '/mapa/novo');
    await page.waitForFunction(() => Number(document.querySelector('.msv-count__value')?.textContent) >= 2, null, { timeout: 60_000 });
    const start = await surveyCounters(page);
    assert.ok(start.walkS < 40, `uns poucos segundos de caminhada até aqui (${start.walkS} s)`);

    // 1) celular no bolso por 5 minutos
    await setHidden(page, true);
    assert.equal(await page.evaluate(() => window.__wrx.app.store.get().loop.paused), 'hidden');
    await page.clock.fastForward(5 * 60_000);
    await setHidden(page, false);
    await page.waitForFunction((n) => Number(document.querySelector('.msv-count__value')?.textContent) > n, start.scans, { timeout: 60_000 });
    const back = await surveyCounters(page);
    assert.equal(back.paused, false, 'de volta à tela o mapeamento continua sozinho');
    assert.ok(back.walkS < start.walkS + 30 + 25, `os 5 min fora da tela não contam como caminhada: ${start.walkS} s antes, ${back.walkS} s depois (só o salto de 30 s da retomada)`);

    // 2) Wi-Fi desligado por um minuto, com a tela do mapeamento aberta
    await simState(page, { wifi: false });
    await page.waitForFunction(() => window.__wrx.app.gates.current() === 'wifi');
    await page.clock.fastForward(60_000);
    await simState(page, { wifi: true });
    await page.waitForFunction(() => window.__wrx.app.gates.current() === null, null, { timeout: 15_000 });
    await page.waitForFunction((n) => Number(document.querySelector('.msv-count__value')?.textContent) > n, back.scans, { timeout: 60_000 });
    const again = await surveyCounters(page);
    assert.equal(again.paused, false);
    assert.ok(again.walkS < back.walkS + 30 + 25, `o minuto de bloqueio não conta: ${back.walkS} s antes, ${again.walkS} s depois`);

    // 3) uma pausa pedida pelo usuário NÃO é desfeita por sair e voltar
    await page.locator('.msv__bar .btn', { hasText: 'Pausar' }).click();
    await page.waitForFunction(() => /Retomar/.test(document.querySelector('.msv__bar .btn--primary')?.textContent || ''));
    await setHidden(page, true);
    await page.clock.fastForward(30_000);
    await setHidden(page, false);
    await settle(page);
    const paused = await surveyCounters(page);
    assert.equal(paused.paused, true, 'continua em pausa até o usuário retomar');
    assert.ok(paused.walkS <= again.walkS + 8);

    // o rascunho: cada volta abriu um trecho novo e deu o salto de 30 s (nenhum "passo" de 5 minutos)
    await goto(page, '/redes');
    await page.waitForFunction(() => [...document.querySelectorAll('.toast__text')].some((el) => /rascunho ficou guardado/.test(el.textContent)));
    await page.waitForTimeout(300);
    const draft = await draftScans(page);
    assert.ok(draft && draft.segs.length === draft.t.length && draft.segs.length >= 4, 'o rascunho guarda o trecho de cada leitura');
    assert.equal(new Set(draft.segs).size, 3, `três trechos: antes do bolso, depois dele e depois do bloqueio (${draft.segs.join(',')})`);
    for (let i = 1; i < draft.t.length; i++) {
      const step = draft.t[i] - draft.t[i - 1];
      if (draft.segs[i] !== draft.segs[i - 1]) assert.ok(step >= 30 && step < 60, `entre um trecho e outro: salto de 30 s e pouco (foi ${step} s)`);
      else assert.ok(step < 30, `dentro do mesmo trecho as leituras vêm a poucos segundos uma da outra (foi ${step} s)`);
    }
  });
});

// ---------------------------------------------------------------------------
// realphone-08 e 09: Android 9 (o limite de buscas existe, é fixo e o celular não o informa)
// ---------------------------------------------------------------------------

test('Android 9: o app já abre no ritmo de 30 s e não manda desligar uma opção que não existe', T, async () => {
  const phone = { info: { sdk: 28, release: '9' }, status: { throttled: null } };
  await withPhone({ route: '/redes', phone }, async ({ page }) => {
    await waitForScans(page, 1);
    const loop = await page.evaluate(() => window.__wrx.app.store.get().loop);
    assert.equal(loop.throttled, true, 'o laço parte sabendo do limite (antes: 4 buscas em 30 s e depois quase 2 min sem lista nova)');
    assert.equal(loop.intervalMs, 30_000);
    assert.equal(loop.lastReason, null, 'sem nenhuma recusa');
    assert.equal(await page.locator('.scan-btn__dot').isVisible(), true, 'a barra de cima avisa do limite');
    // a dica explica o ritmo, sem "dá para liberar" nem passo a passo
    const tip = (await page.textContent('.net-region .banner, .net-region .tip')).replace(/\s+/g, ' ');
    assert.match(tip, /O Android está limitando as buscas/);
    assert.match(tip, /a cada 30 segundos/);
    assert.match(tip, /não dá para desligar esse limite/);
    assert.doesNotMatch(tip, /Dá para liberar|Como liberar/);
    // em 12 s (o intervalo normal seria de 10 s) nenhuma busca a mais foi pedida
    const asked = await page.evaluate(() => window.__fake.calls.filter((name) => name === 'scan').length);
    await page.waitForTimeout(12_000);
    assert.equal(await page.evaluate(() => window.__fake.calls.filter((name) => name === 'scan').length), asked);
  });
});

