// Moldura do app, de ponta a ponta, contra o simulador: partida, abas e rotas, "voltar",
// bloqueios, tema, modo demonstração, ajustes guardados, CSP, texto hostil e layout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, openApp, withApp, shot, goto, back, settle, simState, simEval, appState, waitForScans, waitForScreen, horizontalOverflow, TABS, VIEWPORTS } from './helpers.mjs';

const T = { timeout: 90_000 };
const FAST = { speed: 10 }; // o tempo do simulador corre 10x: as varreduras chegam em ~0,25 s
const HOSTILE = '<img src=x onerror=alert(1)>';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

const title = (page) => page.textContent('.topbar__title');
const hash = (page) => page.evaluate(() => location.hash);

// ---------------------------------------------------------------------------
// Partida
// ---------------------------------------------------------------------------

test('abre no simulador: moldura montada, primeira varredura na tela, pílula de demonstração', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    assert.equal(await page.locator('#splash').count(), 0, 'a tela de abertura some');
    assert.equal(await page.isVisible('#app'), true);
    assert.equal(await hash(page), '#/redes', 'sem rota na URL abre em Redes');
    assert.equal(await title(page), 'Redes');
    assert.equal(await page.title(), 'Redes · WiFi Raio-X');
    assert.equal(await page.getAttribute('html', 'lang'), 'pt-BR');
    assert.equal(await appState(page, (s) => s.backend), 'sim');
    assert.equal(await appState(page, (s) => s.info.platform), 'sim');
    assert.equal(await appState(page, (s) => s.status.canScan), true);

    const labels = await page.locator('.bottomnav__item').allTextContents();
    assert.deepEqual(labels, ['Redes', 'Canais', 'Melhor Wi-Fi', 'Mapa 3D', 'Ferramentas']);
    assert.equal(await page.getAttribute('.bottomnav__item[aria-current="page"]', 'data-tab'), 'redes');

    const pill = page.locator('.pill');
    assert.equal(await pill.isVisible(), true);
    assert.match(await pill.textContent(), /Demonstração/);

    await waitForScans(page, 1);
    assert.ok((await appState(page, (s) => s.aps.length)) > 3, 'a casa virtual tem várias redes');
    assert.ok((await appState(page, (s) => s.networks.length)) > 2);
    assert.equal(await appState(page, (s) => s.aps.filter((a) => a.connected).length), 1, 'há uma rede conectada');
    await page.waitForFunction(() => /^Atualizado/.test(document.querySelector('.topbar__status').textContent));
    await page.waitForFunction(() => window.__wrx.app.store.get().vendorsReady === true);
    await shot(page, 'shell-redes');
  });
});

test('a idade dos dados aparece na barra de cima e cresce com o tempo', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await waitForScans(page, 1);
    // pausa o laço para a lista envelhecer
    await page.evaluate(() => window.__wrx.app.scanLoop.setMode('paused'));
    await page.waitForFunction(() => /Em pausa · há \d+\s*s/.test(document.querySelector('.topbar__status').textContent), null, { timeout: 15_000 });
    await page.evaluate(() => window.__wrx.app.scanLoop.setMode('normal'));
    await page.waitForFunction(() => /^(Atualizado|Buscando)/.test(document.querySelector('.topbar__status').textContent));
  });
});

test('tocar no indicador busca agora', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await waitForScans(page, 1);
    await page.waitForFunction(() => !window.__wrx.app.store.get().scan.scanning);
    // espera passar a folga entre pedidos seguidos
    await page.waitForTimeout(1600);
    const before = await appState(page, (s) => s.scan.seq);
    await page.click('.scan-btn');
    await page.waitForFunction((n) => window.__wrx.app.store.get().scan.seq > n, before);
    assert.equal(await appState(page, (s) => s.scan.lastAccepted), true);
    assert.equal(await page.locator('.scan-btn__dot').isHidden(), true, 'sem limite não há a bolinha de aviso');
  });
});

test('com o limite do Android: bolinha de aviso, ritmo lento e explicação ao ser recusado', T, async () => {
  await withApp(env, { params: { ...FAST, throttle: 1 } }, async ({ page }) => {
    await waitForScans(page, 1);
    assert.equal(await appState(page, (s) => s.loop.throttled), true);
    assert.equal(await appState(page, (s) => s.loop.intervalMs), 30_000);
    assert.equal(await page.locator('.scan-btn__dot').isVisible(), true);
    assert.match(await page.getAttribute('.scan-btn', 'aria-label'), /limitando/);

    // gasta a cota (4 a cada 2 min simulados) com toques seguidos, até o Android recusar
    let refused = null;
    for (let i = 0; i < 8 && !refused; i++) {
      await page.waitForFunction(() => !window.__wrx.app.store.get().scan.scanning);
      await page.waitForTimeout(1600);
      const res = await page.evaluate(() => window.__wrx.app.scanLoop.scanNow());
      if (!res.accepted && res.reason === 'throttled') refused = res;
    }
    assert.ok(refused, 'depois de 4 buscas o simulador recusa');
    await page.waitForFunction(() => !window.__wrx.app.store.get().scan.scanning);
    await page.waitForTimeout(1600);
    await page.click('.scan-btn');
    const toast = page.locator('.toast');
    await toast.waitFor();
    assert.match(await toast.textContent(), /O Android limitou as buscas/);
    await toast.locator('.toast__action').click();
    await page.locator('.sheet').waitFor();
    assert.match(await page.textContent('.sheet__title'), /demora a atualizar/);
    assert.match(await page.textContent('.sheet__body'), /4 vezes a cada 2 minutos/);
    await shot(page, 'shell-limite');
    assert.equal(await back(page), true, 'o voltar fecha o painel');
    await page.locator('.sheet').waitFor({ state: 'detached' });
  });
});

// ---------------------------------------------------------------------------
// Abas, rotas e "voltar"
// ---------------------------------------------------------------------------

test('as cinco abas trocam de tela, de título e de rota', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    for (const tab of [...TABS].reverse()) {
      await page.click(`.bottomnav__item[href="#${tab.route}"]`);
      await page.waitForFunction((t) => document.querySelector('.topbar__title').textContent === t, tab.title);
      assert.equal(await hash(page), `#${tab.route}`);
      assert.equal(await page.getAttribute('.bottomnav__item[aria-current="page"]', 'href'), `#${tab.route}`);
      assert.equal(await page.locator('.bottomnav__item[aria-current="page"]').count(), 1);
      assert.equal(await page.getAttribute('.view > .screen', 'data-screen'), tab.route.slice(1));
      await page.waitForFunction(() => document.querySelector('.view > .screen').childElementCount > 0);
    }
  });
});

test('abrir direto numa rota: cada aba, uma sub-tela e rotas inválidas', T, async () => {
  for (const tab of TABS) {
    await withApp(env, { params: FAST, route: tab.route }, async ({ page }) => {
      assert.equal(await title(page), tab.title);
      assert.equal(await page.getAttribute('.bottomnav__item[aria-current="page"]', 'href'), `#${tab.route}`);
      assert.equal(await page.locator('.topbar__back').isHidden(), true);
    });
  }
  await withApp(env, { params: FAST, route: '/ferramentas/sobre' }, async ({ page }) => {
    assert.equal(await title(page), 'Sobre');
    assert.equal(await page.locator('.topbar__back').isVisible(), true);
    assert.equal(await page.locator('.topbar__settings').isHidden(), true);
    assert.equal(await page.getAttribute('.bottomnav__item[aria-current="page"]', 'data-tab'), 'ferramentas');
    await page.waitForSelector('text=Nada sai do seu celular.');
    assert.match(await page.textContent('.view'), /speed\.cloudflare\.com/);
    assert.match(await page.textContent('.view'), /Versão \d+\.\d+/);
    assert.match(await page.textContent('.view'), /three\.js/);
  });
  await withApp(env, { params: FAST, route: '/nao-existe/x' }, async ({ page }) => {
    assert.equal(await hash(page), '#/redes');
    assert.equal(await title(page), 'Redes');
  });
  await withApp(env, { params: FAST, route: '/ferramentas/..%2F..%2Fmain' }, async ({ page }) => {
    assert.equal(await title(page), 'Ferramentas', 'ferramenta desconhecida cai no menu');
    assert.equal(await page.locator('.topbar__back').isHidden(), true);
  });
});

test('menu de ferramentas: as nove, cada uma abrindo a sua sub-rota', T, async () => {
  // as ferramentas que ainda não foram escritas respondem 404: é o caminho do "em breve"
  await withApp(env, { params: FAST, route: '/ferramentas', allow: [/\/js\/ui\/tools\/[a-z]+\.js/] }, async ({ page }) => {
    const rows = page.locator('.view a.row');
    assert.equal(await rows.count(), 9);
    const hrefs = await rows.evaluateAll((els) => els.map((a) => a.getAttribute('href')));
    assert.deepEqual(hrefs, ['medidor', 'historico', 'velocidade', 'ping', 'conexao', 'dispositivos', 'exportar', 'ajustes', 'sobre'].map((id) => `#/ferramentas/${id}`));
    for (const a of await rows.all()) {
      assert.ok((await a.locator('.row__title').textContent()).length > 3);
      assert.ok((await a.locator('.row__sub').textContent()).length > 10, 'cada ferramenta tem uma linha de descrição');
      assert.equal(await a.locator('svg').count(), 2, 'ícone e seta');
    }
    await shot(page, 'shell-ferramentas');
    for (const href of hrefs) {
      await goto(page, href.slice(1));
      assert.equal(await page.locator('.topbar__back').isVisible(), true);
      await page.waitForFunction(() => document.querySelector('.view > .screen').childElementCount > 0);
      assert.equal(await page.locator('.view .empty__icon--critical').count(), 0, `${href} não pode abrir com erro`);
      await goto(page, '/ferramentas');
    }
  });
});

test('ferramenta sem módulo mostra "em breve" e deixa voltar', T, async () => {
  const missing = /\/js\/ui\/tools\/ping\.js/;
  await withApp(
    env,
    {
      params: FAST,
      route: '/ferramentas/ping',
      allow: [missing],
      before: (page) => page.route(missing, (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'não encontrado' })),
    },
    async ({ page }) => {
      assert.equal(await title(page), 'Latência');
      await page.waitForSelector('.empty__title');
      assert.equal(await page.textContent('.empty__title'), 'Em breve');
      assert.match(await page.textContent('.empty__text'), /Latência \/ ping/);
      await shot(page, 'shell-em-breve');
      await page.click('text=Voltar para Ferramentas');
      await waitForScreen(page, '/ferramentas');
      assert.equal(await hash(page), '#/ferramentas');
      assert.equal(await title(page), 'Ferramentas');
    },
  );
});

test('botão voltar: fecha painel -> sai da sub-tela -> vai para Redes -> deixa o Android sair', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/ajustes' }, async ({ page }) => {
    await page.click('.pill');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.evaluate(() => document.getElementById('app').inert), true, 'com o painel aberto o resto fica inerte');

    assert.equal(await back(page), true);
    await page.locator('.sheet').waitFor({ state: 'detached' });
    assert.equal(await hash(page), '#/ferramentas/ajustes', 'o primeiro voltar só fecha o painel');
    assert.equal(await page.evaluate(() => document.getElementById('app').inert), false);

    assert.equal(await back(page), true);
    await waitForScreen(page, '/ferramentas');
    assert.equal(await hash(page), '#/ferramentas');
    assert.equal(await title(page), 'Ferramentas');

    assert.equal(await back(page), true);
    await waitForScreen(page, '/redes');
    assert.equal(await hash(page), '#/redes');
    assert.equal(await title(page), 'Redes');

    assert.equal(await back(page), false, 'em Redes, sem nada aberto, o Android pode sair do app');
    assert.equal(await hash(page), '#/redes');
  });
});

test('voltar fecha um diálogo de confirmação antes de qualquer outra coisa (e conta como "cancelar")', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/ajustes', storage: { favorites: ['Casa'] } }, async ({ page }) => {
    await page.click('text=Apagar dados salvos');
    await page.locator('.dialog').waitFor();
    assert.equal(await back(page), true);
    await page.locator('.dialog').waitFor({ state: 'detached' });
    assert.deepEqual(await appState(page, (s) => [...s.favorites]), ['Casa'], 'nada foi apagado');
    assert.equal(await hash(page), '#/ferramentas/ajustes');
  });
});

test('seta da barra de cima sobe um nível; o painel fecha com Esc e tocando fora', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/sobre' }, async ({ page }) => {
    await page.click('.topbar__back');
    await waitForScreen(page, '/ferramentas');
    await page.click('.pill');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.getAttribute('.sheet', 'role'), 'dialog');
    assert.equal(await page.getAttribute('.sheet', 'aria-modal'), 'true');
    await page.keyboard.press('Escape');
    await page.locator('.sheet').waitFor({ state: 'detached' });
    await page.click('.pill');
    await page.locator('.sheet').waitFor();
    await page.mouse.click(20, 60); // fora do painel
    await page.locator('.sheet').waitFor({ state: 'detached' });
  });
});

// ---------------------------------------------------------------------------
// Bloqueios
// ---------------------------------------------------------------------------

const GATES = [
  { name: 'sem permissão', params: { permission: 'denied' }, kind: 'permission', title: /Vamos ver o Wi-Fi/, button: 'Permitir', fix: { permission: 'granted' } },
  { name: 'permissão bloqueada', params: { permission: 'blocked' }, kind: 'blocked', title: /permissão está bloqueada/, button: 'Abrir configurações do app', fix: { permission: 'granted' } },
  { name: 'localização desligada', params: { location: 0 }, kind: 'location', title: /Localização do celular está desligada/, button: 'Ligar a Localização', fix: { location: true } },
  { name: 'Wi-Fi desligado', params: { wifi: 0 }, kind: 'wifi', title: /Wi-Fi está desligado/, button: 'Ligar o Wi-Fi', fix: { wifi: true } },
];

for (const gate of GATES) {
  test(`bloqueio "${gate.name}": aparece na partida e some sozinho quando o status muda`, T, async () => {
    await withApp(env, { params: { ...FAST, ...gate.params } }, async ({ page }) => {
      const el = page.locator('.gate');
      await el.waitFor();
      assert.equal(await el.getAttribute('data-gate'), gate.kind);
      assert.match(await page.textContent('.gate__title'), gate.title);
      assert.ok((await page.textContent('.gate__text')).length > 60, 'explica o porquê');
      assert.equal(await page.locator('.gate .btn--primary').count(), 1, 'uma ação principal');
      assert.equal((await page.textContent('.gate .btn--primary')).trim(), gate.button);
      assert.equal(await page.evaluate(() => document.getElementById('app').inert), true);
      assert.equal(await appState(page, (s) => s.loop.paused), 'gate', 'o laço de buscas espera');
      assert.equal(await appState(page, (s) => s.scan.seq), 0);
      assert.equal(await back(page), false, 'o voltar não dispensa um bloqueio');
      assert.equal(await el.isVisible(), true);
      assert.deepEqual(await horizontalOverflow(page), []);
      await shot(page, `shell-bloqueio-${gate.kind}`);

      await simState(page, gate.fix);
      await el.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.getElementById('app').inert), false);
      await waitForScans(page, 1);
      assert.equal(await appState(page, (s) => s.loop.paused), null);
    });
  });
}

test('bloqueios ao vivo: aparecem quando o status piora, trocam entre si e somem', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await waitForScans(page, 1);
    assert.equal(await page.locator('.gate').count(), 0);

    await simState(page, { wifi: false });
    await page.waitForSelector('.gate[data-gate="wifi"]');
    await simState(page, { location: false });
    await page.waitForSelector('.gate[data-gate="location"]');
    await simState(page, { permission: 'denied' });
    await page.waitForSelector('.gate[data-gate="permission"]');
    assert.equal(await page.locator('.gate').count(), 1, 'nunca dois bloqueios empilhados');

    await simState(page, { permission: 'granted' });
    await page.waitForSelector('.gate[data-gate="location"]');
    await simState(page, { location: true });
    await page.waitForSelector('.gate[data-gate="wifi"]');
    await simState(page, { wifi: true });
    await page.locator('.gate').waitFor({ state: 'detached' });
    const seq = await appState(page, (s) => s.scan.seq);
    await page.waitForFunction((n) => window.__wrx.app.store.get().scan.seq > n, seq);
  });
});

test('"Permitir" pede a permissão; negar de novo mantém o bloqueio, aceitar libera', T, async () => {
  await withApp(env, { params: { ...FAST, permission: 'denied', permissionReply: 'denied' } }, async ({ page }) => {
    await page.waitForSelector('.gate[data-gate="permission"]');
    // o pedido demora (o "usuário" lê o diálogo do Android): espera a resposta chegar antes de seguir
    const answered = page.evaluate(
      () =>
        new Promise((resolve) => {
          const off = window.__wrx.app.bridge.on('status', (status) => {
            off();
            resolve(status.permission);
          });
          setTimeout(() => resolve('sem evento'), 5000);
        }),
    );
    await page.click('.gate .btn--primary');
    await answered;
    await settle(page);
    assert.equal(await appState(page, (s) => s.status.permission), 'denied');
    assert.equal(await page.locator('.gate[data-gate="permission"]').count(), 1, 'o usuário negou: continua bloqueado');
    await simState(page, { permissionReply: 'granted' });
    await page.click('.gate .btn--primary');
    await page.locator('.gate').waitFor({ state: 'detached' });
    await waitForScans(page, 1);
  });
});

test('permissão negada em definitivo vira o bloqueio de "abrir configurações"', T, async () => {
  await withApp(env, { params: { ...FAST, permission: 'denied', permissionReply: 'blocked' } }, async ({ page }) => {
    await page.waitForSelector('.gate[data-gate="permission"]');
    await page.click('.gate .btn--primary');
    await page.waitForSelector('.gate[data-gate="blocked"]');
    assert.equal((await page.textContent('.gate .btn--primary')).trim(), 'Abrir configurações do app');
  });
});

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------

const themeOf = (page) => page.getAttribute('html', 'data-theme');
const bodyColor = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('tema: segue o sistema, troca nos ajustes, avisa as barras do Android e fica guardado', T, async () => {
  const app = await openApp(env, { params: FAST, route: '/ferramentas/ajustes', colorScheme: 'dark' });
  const { page } = app;
  try {
    assert.equal(await themeOf(page), 'dark');
    assert.equal(await bodyColor(page), 'rgb(10, 15, 28)');
    assert.equal(await appState(page, (s) => s.theme), 'dark');
    assert.deepEqual(await simEval(page, (sim) => sim.device.bars), { color: '#0a0f1c', dark: true });

    // "Sistema": acompanha o celular ao vivo
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await bodyColor(page), 'rgb(243, 245, 249)');
    assert.deepEqual(await simEval(page, (sim) => sim.device.bars), { color: '#f3f5f9', dark: false });
    assert.equal(await page.getAttribute('meta[name="theme-color"]', 'content'), '#f3f5f9');

    // escolha explícita vale mais que o sistema
    await page.click('.seg__opt:has-text("Escuro")');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.getAttribute('.seg__opt:has-text("Escuro")', 'aria-checked'), 'true');
    assert.equal(await page.getAttribute('.seg__opt:has-text("Sistema")', 'aria-checked'), 'false');
    assert.equal(await appState(page, (s) => s.settings.theme), 'dark');
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('wrx.settings'))).theme, 'dark');
    await shot(page, 'shell-ajustes-escuro');

    await page.click('.seg__opt:has-text("Claro")');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await settle(page);
    assert.equal(await themeOf(page), 'light', 'tema fixo não segue mais o sistema');
    await shot(page, 'shell-ajustes-claro');

    await page.reload();
    await page.waitForSelector('html[data-ready]');
    assert.equal(await themeOf(page), 'light', 'continua claro depois de recarregar');
    assert.equal(await page.getAttribute('.seg__opt:has-text("Claro")', 'aria-checked'), 'true');
  } finally {
    await app.close();
  }
});

test('?theme= na URL vale para a sessão sem mexer no ajuste guardado', T, async () => {
  await withApp(env, { params: { ...FAST, theme: 'light' }, colorScheme: 'dark' }, async ({ page }) => {
    assert.equal(await themeOf(page), 'light');
    assert.equal(await appState(page, (s) => s.settings.theme), 'system');
    assert.equal(await page.evaluate(() => localStorage.getItem('wrx.settings')), null);
  });
});

// ---------------------------------------------------------------------------
// Modo demonstração e ajustes
// ---------------------------------------------------------------------------

test('demonstração: a pílula explica o modo e leva aos ajustes', T, async () => {
  await withApp(env, { params: FAST, route: '/canais' }, async ({ page }) => {
    await page.click('.pill');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.textContent('.sheet__title'), 'Modo demonstração');
    assert.match(await page.textContent('.sheet__body'), /casa virtual/);
    await shot(page, 'shell-demo-painel');
    await page.click('.sheet >> text=Escolher outra casa');
    await waitForScreen(page, '/ferramentas/ajustes');
    await page.locator('.sheet').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.pill').isVisible(), true, 'a pílula continua em todas as telas');
  });
});

test('trocar de casa virtual reconecta o simulador sem recarregar a página', T, async () => {
  // sem parâmetros de simulador na URL: é o ajuste que escolhe a casa
  await withApp(env, { route: '/ferramentas/ajustes' }, async ({ page }) => {
    await page.evaluate(() => {
      window.__naoRecarregou = true;
    });
    assert.equal(await simEval(page, (sim) => sim.worldId), 'apartamento');
    const sw = page.locator('input.switch');
    assert.equal(await sw.isChecked(), true);
    assert.equal(await sw.isDisabled(), true, 'no navegador não há Wi-Fi de verdade: a demonstração não desliga');

    const worlds = page.locator('[role="radiogroup"][aria-label="Casa virtual"] [role="radio"]');
    await worlds.first().waitFor();
    assert.equal(await worlds.count(), 4);
    assert.equal(await page.getAttribute('[role="radio"][aria-checked="true"] >> nth=-1', 'aria-checked'), 'true');
    await waitForScans(page, 1, 30_000);
    const apartment = await appState(page, (s) => s.aps.map((a) => a.bssid).sort());

    await page.click('[role="radio"]:has-text("Sobrado")');
    await page.waitForFunction(() => window.__e2eSim()?.worldId === 'sobrado'); // entre um simulador e outro não há nenhum
    await page.waitForFunction(() => window.__wrx.app.store.get().backend === 'sim' && window.__wrx.app.store.get().loop.running);
    assert.equal(await page.evaluate(() => window.__naoRecarregou), true, 'a página não foi recarregada');
    assert.equal(await appState(page, (s) => s.settings.demoWorld), 'sobrado');
    assert.equal(await page.getAttribute('[role="radio"]:has-text("Sobrado")', 'aria-checked'), 'true');
    await waitForScans(page, 1, 30_000);
    const house = await appState(page, (s) => s.aps.map((a) => a.bssid).sort());
    assert.notDeepEqual(house, apartment, 'as redes agora são as da outra casa');
    assert.equal(await page.locator('.pill').isVisible(), true);

    await page.reload();
    await page.waitForSelector('html[data-ready]');
    assert.equal(await simEval(page, (sim) => sim.worldId), 'sobrado', 'a casa escolhida fica guardada');
  });
});

test('ajustes ficam guardados entre uma abertura e outra (chaves wrx.*)', T, async () => {
  const app = await openApp(env, { params: FAST, route: '/ferramentas/ajustes', storage: { settings: { tipsDismissed: ['throttle', 'mapa'] }, favorites: ['Casa'] } });
  const { page } = app;
  try {
    assert.match(await page.textContent('.view'), /2 dicas dispensadas/);
    await page.selectOption('.select select', { label: 'A cada 30\u202fsegundos' });
    assert.equal(await appState(page, (s) => s.settings.scanIntervalS), 30);
    assert.equal(await appState(page, (s) => s.loop.intervalMs), 30_000, 'o laço passa a usar o intervalo escolhido');

    await page.click('text=Mostrar as dicas de novo');
    await page.locator('.toast').waitFor();
    assert.match(await page.textContent('.view'), /Nenhuma dica foi dispensada/);

    const keys = await page.evaluate(() => Object.keys(localStorage));
    assert.ok(keys.length >= 2 && keys.every((k) => k.startsWith('wrx.')), `chaves: ${keys}`);

    await page.reload();
    await page.waitForSelector('html[data-ready]');
    assert.equal(await appState(page, (s) => s.settings.scanIntervalS), 30);
    assert.deepEqual(await appState(page, (s) => s.settings.tipsDismissed), []);
    assert.deepEqual(await appState(page, (s) => [...s.favorites]), ['Casa']);
    assert.equal(await page.evaluate(() => document.querySelector('.select select').selectedOptions[0].textContent), 'A cada 30\u202fsegundos');

    // apagar tudo: pede confirmação e volta aos padrões
    await page.click('text=Apagar dados salvos');
    await page.locator('.dialog').waitFor();
    assert.equal(await page.getAttribute('.dialog', 'role'), 'alertdialog');
    await shot(page, 'shell-apagar');
    await page.click('.dialog >> text=Cancelar');
    await page.locator('.dialog').waitFor({ state: 'detached' });
    assert.deepEqual(await appState(page, (s) => [...s.favorites]), ['Casa']);

    await page.click('text=Apagar dados salvos');
    await page.click('.dialog >> text=Apagar tudo');
    await page.locator('.dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.__wrx.app.store.get().favorites.size === 0);
    assert.equal(await appState(page, (s) => s.settings.scanIntervalS), 'auto');
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), []);
  } finally {
    await app.close();
  }
});

test('ajuste guardado corrompido não impede o app de abrir', T, async () => {
  const app = await openApp(env, {
    params: FAST,
    before: (page) =>
      page.addInitScript(() => {
        localStorage.setItem('wrx.settings', '{"theme": "dark",,,');
        localStorage.setItem('wrx.favorites', '<script>alert(1)</script>');
      }),
  });
  try {
    assert.equal(await appState(app.page, (s) => s.settings.theme), 'system');
    assert.deepEqual(await appState(app.page, (s) => [...s.favorites]), []);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Segurança
// ---------------------------------------------------------------------------

test('CSP: a política está na página, sem código em linha e sem violações num passeio completo', T, async () => {
  // este bloco provoca uma violação de propósito; o passeio logo abaixo não tolera nenhuma
  await withApp(env, { params: FAST, allow: [/script-src/, /Refused to execute inline script/i] }, async ({ page }) => {
    const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
    assert.equal(
      csp,
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://speed.cloudflare.com; worker-src 'self' blob:; object-src 'none'; base-uri 'none'",
    );
    assert.equal(await page.locator('script:not([src])').count(), 0, 'nenhum <script> em linha');

    // o CSP está valendo: código em linha é barrado
    const blocked = await page.evaluate(
      () =>
        new Promise((resolve) => {
          document.addEventListener('securitypolicyviolation', (ev) => resolve(ev.violatedDirective), { once: true });
          const s = document.createElement('script');
          s.textContent = 'window.__inlineRan = true';
          document.head.appendChild(s);
          setTimeout(() => resolve(null), 2000);
        }),
    );
    assert.match(String(blocked), /script-src/);
    assert.equal(await page.evaluate(() => window.__inlineRan), undefined);
  });

  // passeio por todas as telas, painéis e bloqueios: nenhuma violação, nenhum atributo on*
  await withApp(env, { params: FAST, allow: [/\/js\/ui\/tools\/[a-z]+\.js/] }, async ({ page }) => {
    await waitForScans(page, 1);
    for (const route of ['/redes', '/canais', '/melhor', '/mapa', '/ferramentas', '/ferramentas/ajustes', '/ferramentas/sobre', '/ferramentas/medidor']) {
      await goto(page, route);
      await page.waitForFunction(() => document.querySelector('.view > .screen').childElementCount > 0);
    }
    await page.click('.pill');
    await page.locator('.sheet').waitFor();
    await back(page);
    await simState(page, { wifi: false });
    await page.waitForSelector('.gate');
    await simState(page, { wifi: true });
    await page.locator('.gate').waitFor({ state: 'detached' });
    const handlers = await page.evaluate(() => {
      const found = [];
      for (const el of document.querySelectorAll('*')) for (const attr of el.attributes) if (/^on/i.test(attr.name)) found.push(`${el.tagName}[${attr.name}]`);
      return found;
    });
    assert.deepEqual(handlers, [], 'nenhum atributo de evento em linha');
    const external = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((u) => !u.startsWith(location.origin) && !u.startsWith('data:')));
    assert.deepEqual(external, [], 'nenhum pedido para fora do próprio app');
  });
});

test('nome de rede hostil aparece como texto: nada é injetado, nada é executado', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await waitForScans(page, 1);
    // a casa virtual tem um vizinho com este nome; espera ele ser ouvido
    await page.waitForFunction((name) => window.__wrx.app.store.get().aps.some((a) => a.ssid === name), HOSTILE, { timeout: 60_000 });
    const label = page.locator('.view').getByText(HOSTILE, { exact: true }).first();
    await label.waitFor({ timeout: 15_000 });
    assert.equal(await label.evaluate((el) => el.childElementCount), 0, 'o nome é só texto');
    assert.equal(await label.evaluate((el) => el.textContent), HOSTILE);
    assert.equal(await page.locator('img[src="x"]').count(), 0, 'nenhum <img> foi criado');
    assert.equal(await page.locator('.view img, .view script, .view iframe, .view object').count(), 0);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[onerror], [onload], [onclick]').length), 0);
    await shot(page, 'shell-nome-hostil');
    // marcar como "minha rede" guarda e relê o nome sem mudar
    await page.evaluate((name) => window.__wrx.app.store.setFavorite(name, true), HOSTILE);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wrx.favorites'))), [HOSTILE]);
    await settle(page);
    assert.equal(await page.locator('img[src="x"]').count(), 0);
    // (um alert() teria sido registrado como problema e derrubaria o teste ao fechar)
  });
});

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

test('erro ao montar uma tela: aviso com "tentar de novo", o resto do app e as buscas continuam', T, async () => {
  const target = /\/js\/ui\/screens\/best\.js/;
  const body = `
    export function mount(root) {
      if (window.__consertada !== true) throw new Error('tela quebrada de propósito');
      root.textContent = 'tela consertada';
      return { unmount() {} };
    }`;
  await withApp(
    env,
    { params: FAST, allow: ['[app] erro na tela', 'tela quebrada de propósito'], before: (page) => page.route(target, (r) => r.fulfill({ contentType: 'text/javascript', body })) },
    async ({ page }) => {
      await waitForScans(page, 1);
      await page.click('.bottomnav__item[data-tab="melhor"]');
      await page.waitForSelector('.view .empty__icon--critical');
      assert.equal(await title(page), 'Melhor Wi-Fi', 'a moldura continua de pé');
      assert.match(await page.textContent('.view .empty__title'), /Algo deu errado/);
      assert.equal(await page.locator('.view button:has-text("Tentar de novo")').count(), 1);
      await shot(page, 'shell-erro-na-tela');

      // as outras telas e o laço de buscas não foram afetados
      await page.click('.bottomnav__item[data-tab="redes"]');
      await waitForScreen(page, '/redes');
      await page.waitForFunction(() => document.querySelector('.view > .screen').childElementCount > 0);
      assert.equal(await page.locator('.view .empty__icon--critical').count(), 0);
      await page.waitForFunction(() => !window.__wrx.app.store.get().scan.scanning);
      await page.waitForTimeout(1600);
      const seq = await appState(page, (s) => s.scan.seq);
      await page.evaluate(() => window.__wrx.app.scanLoop.scanNow());
      await page.waitForFunction((n) => window.__wrx.app.store.get().scan.seq > n, seq);
      assert.equal(await appState(page, (s) => s.loop.running), true);

      // voltar à tela com defeito mostra o aviso de novo; consertado o motivo, "tentar de novo" resolve
      await page.click('.bottomnav__item[data-tab="melhor"]');
      await page.waitForSelector('.view .empty__icon--critical');
      await page.click('text=Tentar de novo');
      await page.waitForSelector('.view .empty__icon--critical');
      await page.evaluate(() => {
        window.__consertada = true;
      });
      await page.click('text=Tentar de novo');
      await page.waitForFunction(() => document.querySelector('.view > .screen').textContent === 'tela consertada');
    },
  );
});

test('erro num ouvinte do store dentro de uma tela: vira o aviso, e sair da tela cancela as inscrições', T, async () => {
  const target = /\/js\/ui\/screens\/channels\.js/;
  const body = `
    export function mount(root, ctx) {
      root.textContent = 'tela de teste';
      window.__calls = 0;
      ctx.store.subscribe((s) => s.theme, () => { window.__calls += 1; });
      ctx.store.subscribe((s) => s.settings.tipsDismissed, () => { throw new Error('ouvinte quebrado de propósito'); });
      return { unmount() { window.__unmounted = (window.__unmounted || 0) + 1; } };
    }`;
  await withApp(
    env,
    { params: FAST, route: '/canais', allow: ['[app] erro na tela', 'ouvinte quebrado de propósito'], before: (page) => page.route(target, (r) => r.fulfill({ contentType: 'text/javascript', body })) },
    async ({ page }) => {
      await page.waitForFunction(() => document.querySelector('.view > .screen').textContent === 'tela de teste');
      await page.evaluate(() => window.__wrx.app.store.setTheme('light'));
      assert.equal(await page.evaluate(() => window.__calls), 1);

      await page.evaluate(() => window.__wrx.app.store.dismissTip('qualquer'));
      await page.waitForSelector('.view .empty__icon--critical');
      assert.equal(await page.evaluate(() => window.__unmounted), 1, 'a tela com defeito foi desmontada');
      await page.evaluate(() => window.__wrx.app.store.setTheme('dark'));
      assert.equal(await page.evaluate(() => window.__calls), 1, 'as inscrições da tela morreram com ela');

      // "tentar de novo" remonta a tela
      await page.click('text=Tentar de novo');
      await page.waitForFunction(() => document.querySelector('.view > .screen').textContent === 'tela de teste');
      await goto(page, '/redes');
      assert.equal(await page.evaluate(() => window.__unmounted), 2);
      await page.evaluate(() => window.__wrx.app.store.setTheme('light'));
      assert.equal(await page.evaluate(() => window.__calls), 0, 'depois de sair, nenhum ouvinte da tela roda');
    },
  );
});

test('modo das buscas mudado por uma tela volta ao anterior quando ela sai; títulos e ações também', T, async () => {
  const target = /\/js\/ui\/screens\/map\.js/;
  const body = `
    import { h } from '../dom.js';
    export function mount(root, ctx) {
      root.textContent = 'mapeando';
      ctx.scanLoop.setMode('mapping');
      ctx.setTitle('Mapeando a sala');
      ctx.setActions(h('button', { class: 'icon-btn', id: 'acao-da-tela', 'aria-label': 'Ação' }, 'A'));
      ctx.onBack(() => (window.__voltou = (window.__voltou || 0) + 1) === 1);
      ctx.onCleanup(() => (window.__limpou = true));
      return { unmount() {} }; // "esquece" de devolver o modo
    }`;
  await withApp(env, { params: FAST, route: '/mapa', before: (page) => page.route(target, (r) => r.fulfill({ contentType: 'text/javascript', body })) }, async ({ page }) => {
    await page.waitForFunction(() => document.querySelector('.view > .screen').textContent === 'mapeando');
    assert.equal(await appState(page, (s) => s.loop.mode), 'mapping');
    assert.equal(await appState(page, (s) => s.loop.intervalMs), 3000);
    assert.equal(await title(page), 'Mapeando a sala');
    assert.equal(await page.locator('.topbar #acao-da-tela').count(), 1);

    assert.equal(await back(page), true, 'a tela tratou o primeiro voltar');
    assert.equal(await hash(page), '#/mapa');
    assert.equal(await back(page), true, 'no segundo ela não tratou: o roteador vai para Redes');
    await waitForScreen(page, '/redes');
    assert.equal(await appState(page, (s) => s.loop.mode), 'normal');
    assert.equal(await title(page), 'Redes');
    assert.equal(await page.locator('.topbar #acao-da-tela').count(), 0);
    assert.equal(await page.evaluate(() => window.__limpou), true);
  });
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const TOUR = ['/redes', '/canais', '/melhor', '/mapa', '/ferramentas', '/ferramentas/ajustes', '/ferramentas/sobre'];

for (const [name, size] of Object.entries(VIEWPORTS)) {
  test(`layout em ${size.width} × ${size.height} (${name}): nada vaza para os lados, navegação inteira e tocável`, T, async () => {
    await withApp(env, { params: FAST, viewport: name }, async ({ page }) => {
      await waitForScans(page, 1);
      for (const route of TOUR) {
        await goto(page, route);
        await page.waitForFunction(() => document.querySelector('.view > .screen').childElementCount > 0);
        assert.deepEqual(await horizontalOverflow(page), [], `${route} em ${name}`);
        await shot(page, `layout-${name}-${route.slice(1).replace(/\//g, '-')}`);
      }
      // painel e aviso também cabem
      await goto(page, '/redes');
      await page.click('.pill');
      await page.locator('.sheet').waitFor();
      assert.deepEqual(await horizontalOverflow(page), [], `painel em ${name}`);
      const sheet = await page.locator('.sheet').boundingBox();
      assert.ok(sheet.y >= 0 && sheet.y + sheet.height <= size.height + 1, 'o painel cabe na altura da tela');
      await back(page);

      const metrics = await page.evaluate(() => {
        const box = (sel) => {
          const r = document.querySelector(sel).getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
        };
        const items = [...document.querySelectorAll('.bottomnav__item')].map((el) => {
          const r = el.getBoundingClientRect();
          const label = el.lastElementChild;
          return { w: r.width, h: r.height, clipped: label.scrollWidth > label.clientWidth + 1 };
        });
        const buttons = [...document.querySelectorAll('.topbar .icon-btn:not([hidden])')].map((el) => el.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height }));
        return { nav: box('.bottomnav'), top: box('.topbar'), view: box('.view'), screen: box('.view > .screen'), items, buttons, vw: innerWidth, vh: innerHeight };
      });
      for (const item of metrics.items) {
        assert.ok(item.w >= 44 && item.h >= 44, `alvo de toque da navegação: ${item.w} × ${item.h}`);
        assert.equal(item.clipped, false, 'rótulo da navegação cortado');
      }
      for (const b of metrics.buttons) assert.ok(b.w >= 44 && b.h >= 44, 'botões da barra de cima com 44 px');
      assert.ok(metrics.view.h > 200, 'sobra área útil para o conteúdo');
      if (name === 'landscape') {
        assert.ok(metrics.nav.h > metrics.nav.w, 'deitado, a navegação vira uma coluna');
        assert.equal(Math.round(metrics.nav.x), 0);
        assert.ok(metrics.view.x >= metrics.nav.right - 1, 'o conteúdo fica ao lado da coluna');
      } else {
        assert.ok(metrics.nav.w > metrics.nav.h, 'em pé, a navegação fica embaixo');
        assert.ok(Math.abs(metrics.nav.bottom - metrics.vh) <= 1);
        assert.ok(metrics.view.bottom <= metrics.nav.y + 1);
      }
      if (name === 'tablet') {
        assert.ok(metrics.screen.w <= 721, 'no tablet o conteúdo tem largura máxima');
        const left = metrics.screen.x;
        const right = metrics.vw - metrics.screen.right;
        assert.ok(Math.abs(left - right) <= 2, 'e fica centralizado');
        const titleX = await page.evaluate(() => document.querySelector('.topbar__title').getBoundingClientRect().left);
        const cardX = await page.evaluate(() => document.querySelector('.view .card, .view .banner, .view .empty').getBoundingClientRect().left);
        assert.ok(Math.abs(titleX - (metrics.screen.x + 16)) <= 2, `o título (${titleX}) alinha com a coluna do conteúdo (${cardX})`);
      } else if (name !== 'landscape') {
        assert.ok(metrics.screen.w >= metrics.vw - 2, 'no celular o conteúdo usa a largura toda');
      }
    });
  });
}

test('no celular mais estreito a pílula encurta para o título caber inteiro', T, async () => {
  const titleFits = (page) =>
    page.evaluate(() => {
      const t = document.querySelector('.topbar__title');
      return t.scrollWidth <= t.clientWidth + 1;
    });
  await withApp(env, { params: FAST, viewport: 'small', route: '/ferramentas/ajustes' }, async ({ page }) => {
    assert.equal(await page.locator('.pill__short').isVisible(), true);
    assert.equal(await page.locator('.pill__full').isVisible(), false);
    assert.equal(await titleFits(page), true, 'o título "Ajustes" aparece inteiro');
    for (const tab of TABS) {
      await goto(page, tab.route);
      assert.equal(await titleFits(page), true, `o título "${tab.title}" aparece inteiro em 360 px`);
    }
  });
  await withApp(env, { params: FAST, viewport: 'phone', route: '/ferramentas' }, async ({ page }) => {
    assert.equal(await page.locator('.pill__full').isVisible(), true, 'em 412 px cabe a palavra inteira');
    assert.equal(await titleFits(page), true);
  });
});

test('a rolagem de cada aba é lembrada ao voltar para ela', T, async () => {
  await withApp(env, { params: FAST, viewport: 'small', route: '/ferramentas/sobre' }, async ({ page }) => {
    await page.evaluate(() => {
      document.querySelector('.view').scrollTop = 400;
    });
    await settle(page);
    assert.equal(await page.getAttribute('.topbar', 'data-scrolled'), '', 'a barra de cima ganha a linha ao rolar');
    await goto(page, '/ferramentas');
    assert.equal(await page.evaluate(() => document.querySelector('.view').scrollTop), 0);
    assert.equal(await page.getAttribute('.topbar', 'data-scrolled'), null);
    await goto(page, '/ferramentas/sobre');
    assert.equal(await page.evaluate(() => document.querySelector('.view').scrollTop), 400);
  });
});

// ---------------------------------------------------------------------------
// Base da interface (ui/dom.js, ui/components.js), dentro do navegador de verdade
// ---------------------------------------------------------------------------

const MINUS = String.fromCharCode(0x2212);
const THIN = String.fromCharCode(0x202f);

test('h(): dado vira texto ou atributo, nunca HTML nem código', T, async () => {
  await withApp(env, { params: FAST, allow: ['[dom] endereço recusado'] }, async ({ page }) => {
    const out = await page.evaluate(async (hostile) => {
      const { h } = await import('./js/ui/dom.js');
      const el = h('div.card.card--flush#alvo', { class: ['a', false && 'b', { c: true, d: false }], dataset: { kind: hostile, off: false }, title: hostile, 'aria-pressed': false, 'aria-hidden': true, style: { color: 'red', '--sig': 'blue' } }, hostile, 7, null, false, [h('b', null, hostile)]);
      let refused = false;
      try {
        h('div', { innerHTML: hostile });
      } catch {
        refused = true;
      }
      const link = h('a', { href: ' JaVaScRiPt:alert(1)', onclick: 'alert(2)' }, 'x');
      const ok = h('a', { href: '#/redes' }, 'x');
      let clicks = 0;
      const btn = h('button', { onClick: () => clicks++, disabled: false }, 'ok');
      btn.click();
      return {
        tag: el.tagName,
        id: el.id,
        cls: el.className,
        kids: el.childElementCount,
        text: el.textContent,
        html: el.innerHTML,
        kind: el.dataset.kind,
        hasOff: 'off' in el.dataset,
        title: el.title,
        pressed: el.getAttribute('aria-pressed'),
        hidden: el.getAttribute('aria-hidden'),
        color: el.style.color,
        token: el.style.getPropertyValue('--sig'),
        refused,
        href: link.getAttribute('href'),
        onclick: link.getAttribute('onclick'),
        okHref: ok.getAttribute('href'),
        clicks,
        imgs: el.querySelectorAll('img').length,
      };
    }, HOSTILE);
    assert.equal(out.tag, 'DIV');
    assert.equal(out.id, 'alvo');
    assert.equal(out.cls, 'card card--flush a c');
    assert.equal(out.kids, 1, 'só o <b> é elemento; o texto hostil não virou marcação');
    assert.equal(out.text, `${HOSTILE}7${HOSTILE}`);
    assert.ok(out.html.includes('&lt;img'), 'o texto foi escapado');
    assert.equal(out.imgs, 0);
    assert.equal(out.kind, HOSTILE);
    assert.equal(out.hasOff, false);
    assert.equal(out.title, HOSTILE);
    assert.equal(out.pressed, 'false');
    assert.equal(out.hidden, 'true');
    assert.equal(out.color, 'red');
    assert.equal(out.token, 'blue');
    assert.equal(out.refused, true, 'innerHTML é recusado');
    assert.equal(out.href, null, 'endereço javascript: é descartado');
    assert.equal(out.onclick, null, 'on* com texto não vira atributo');
    assert.equal(out.okHref, '#/redes');
    assert.equal(out.clicks, 1);
  });
});

test('patch(): reaproveita os nós — foco, texto digitado e rolagem ficam onde estavam', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    const out = await page.evaluate(async () => {
      const { h, patch } = await import('./js/ui/dom.js');
      const host = h('div', { style: { height: '120px', overflow: 'auto' } });
      document.body.appendChild(host);
      const calls = [];
      const view = (items, tag) =>
        items.map((id) =>
          h('div', { key: id, class: 'linha', style: { height: '50px' }, dataset: { id } }, h('input', { value: `valor-${id}`, 'aria-label': id }), h('button', { onClick: () => calls.push(`${tag}:${id}`) }, id), h('canvas', { keep: true, width: 10 })),
        );
      patch(host, view(['a', 'b', 'c', 'd', 'e', 'f'], 'v1'));
      const before = [...host.children];
      const inputC = before[2].querySelector('input');
      const canvasC = before[2].querySelector('canvas');
      canvasC.width = 77; // o dono do canvas mexeu nele por fora
      inputC.focus();
      inputC.value = 'digitando...';
      host.scrollTop = 130;

      // nova ordem, um item a menos, um a mais, ouvintes novos
      patch(host, view(['f', 'c', 'a', 'novo', 'b', 'e'], 'v2'));
      const after = [...host.children];
      after[1].querySelector('button').click();
      return {
        order: after.map((el) => el.dataset.id),
        sameNodes: ['f', 'c', 'a', 'b', 'e'].every((id) => after.find((el) => el.dataset.id === id) === before.find((el) => el.dataset.id === id)),
        dGone: !before[3].isConnected,
        focusKept: document.activeElement === inputC && inputC.isConnected,
        typed: inputC.value,
        otherValue: after[0].querySelector('input').value,
        scrollTop: host.scrollTop,
        calls,
        canvasKept: after[1].querySelector('canvas') === canvasC && canvasC.width === 77,
        cleanup: host.remove(),
      };
    });
    assert.deepEqual(out.order, ['f', 'c', 'a', 'novo', 'b', 'e']);
    assert.equal(out.sameNodes, true, 'as linhas com a mesma chave são os mesmos nós');
    assert.equal(out.dGone, true);
    assert.equal(out.focusKept, true);
    assert.equal(out.typed, 'digitando...', 'não atropela o que o usuário digita');
    assert.equal(out.otherValue, 'valor-f');
    assert.equal(out.scrollTop, 130);
    assert.deepEqual(out.calls, ['v2:c'], 'vale o ouvinte da árvore nova, uma vez só');
    assert.equal(out.canvasKept, true, 'nó com keep fica intocado');
  });
});

test('patchList(): cria só o que é novo e atualiza o resto no lugar', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    const out = await page.evaluate(async () => {
      const { h, patchList } = await import('./js/ui/dom.js');
      const ul = h('ul');
      let created = 0;
      let updated = 0;
      const spec = {
        key: (item) => item.id,
        create: (item) => (created++, h('li', null, item.label)),
        update: (el, item) => {
          updated++;
          el.textContent = item.label;
        },
      };
      patchList(ul, [{ id: 1, label: 'um' }, { id: 2, label: 'dois' }, { id: 3, label: 'três' }], spec);
      const first = ul.firstChild;
      patchList(ul, [{ id: 3, label: 'TRÊS' }, { id: 1, label: 'UM' }, { id: 4, label: 'quatro' }, { id: 1, label: 'repetido' }], spec);
      return { created, updated, texts: [...ul.children].map((li) => li.textContent), sameFirst: ul.children[1] === first };
    });
    assert.deepEqual(out, { created: 4, updated: 2, texts: ['TRÊS', 'UM', 'quatro'], sameFirst: true });
  });
});

test('formatadores: números para gente, em pt-BR', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    const f = await page.evaluate(async () => {
      const d = await import('./js/ui/dom.js');
      return {
        dbm: [d.fmtDbm(-57.3), d.fmtDbm(-57.3, { unit: false }), d.fmtDbm(null), d.fmtDbm(0)],
        num: [d.fmtNum(1234.5, 1), d.fmtNum(-0.04, 1), d.fmtNum(-2.5, 1), d.fmtNum(NaN), d.fmtNum(1e6)],
        mbps: [d.fmtMbps(8.46), d.fmtMbps(120.4), d.fmtMbps(120, { approx: true }), d.fmtMbps(1234), d.fmtMbps(-1), d.fmtMbps(0)],
        meters: [d.fmtMeters(2.46), d.fmtMeters(12.3), d.fmtMeters(6.2, { approx: true }), d.fmtMeters(2.3, { approx: true }), d.fmtMeters(3, { approx: false }), d.fmtMeters(undefined)],
        pct: [d.fmtPct(84.6), d.fmtPct(84.66, 1), d.fmtPct('x')],
        ms: [d.fmtMs(8.42), d.fmtMs(23.7), d.fmtMs(-1)],
        ago: [d.fmtAgo(0), d.fmtAgo(1999), d.fmtAgo(8000), d.fmtAgo(59_999), d.fmtAgo(190_000), d.fmtAgo(2 * 3600_000), d.fmtAgo(3 * 86_400_000), d.fmtAgo(-5000)],
        duration: [d.fmtDuration(45_000), d.fmtDuration(80_000), d.fmtDuration(300_000), d.fmtDuration(7_500_000), d.fmtDuration(400)],
        freq: [d.fmtFreq(2437), d.fmtFreq(5180.4), d.fmtWidth(80), d.fmtWidth(0)],
        band: [d.fmtBand('2.4'), d.fmtBand('5'), d.fmtBand(6115), d.fmtBand(2437), d.fmtBand('60'), d.fmtBand('7'), d.fmtBand(null)],
        plural: [d.plural(0, 'rede', 'redes'), d.plural(1, 'rede', 'redes'), d.plural(7, 'rede', 'redes')],
        clock: /^\d\d:\d\d:\d\d$/.test(d.fmtClock(Date.now())) && /^\d\d\/\d\d\/\d{4} \d\d:\d\d$/.test(d.fmtDateTime(Date.now())),
      };
    });
    const u = (n, unit) => `${n}${THIN}${unit}`;
    assert.deepEqual(f.dbm, [u(`${MINUS}57`, 'dBm'), `${MINUS}57`, '—', u('0', 'dBm')]);
    assert.deepEqual(f.num, ['1.234,5', '0,0', `${MINUS}2,5`, '—', '1.000.000']);
    assert.deepEqual(f.mbps, [u('8,5', 'Mb/s'), u('120', 'Mb/s'), `≈${THIN}${u('120', 'Mb/s')}`, u('1,2', 'Gb/s'), '—', u('0,0', 'Mb/s')]);
    assert.deepEqual(f.meters, [u('2,5', 'm'), u('12', 'm'), `≈${THIN}${u('6', 'm')}`, `≈${THIN}${u('2,5', 'm')}`, u('3', 'm'), '—']);
    assert.deepEqual(f.pct, ['85%', '84,7%', '—']);
    assert.deepEqual(f.ms, [u('8,4', 'ms'), u('24', 'ms'), '—']);
    assert.deepEqual(f.ago, ['agora', 'agora', `há ${u(8, 's')}`, `há ${u(59, 's')}`, `há ${u(3, 'min')}`, `há ${u(2, 'h')}`, `há ${u(3, 'd')}`, 'agora']);
    assert.deepEqual(f.duration, [u(45, 's'), `${u(1, 'min')} ${u(20, 's')}`, u(5, 'min'), `${u(2, 'h')} ${u('05', 'min')}`, u(0, 's')]);
    assert.deepEqual(f.freq, [u(2437, 'MHz'), u(5180, 'MHz'), u(80, 'MHz'), '—']);
    assert.deepEqual(f.band, [u('2,4', 'GHz'), u('5', 'GHz'), u('6', 'GHz'), u('2,4', 'GHz'), u('60', 'GHz'), '—', '—']);
    assert.deepEqual(f.plural, ['0 redes', '1 rede', '7 redes']);
    assert.equal(f.clock, true);
  });
});

test('painel inferior: prende o foco, devolve o foco ao fechar e fecha arrastando para baixo', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas' }, async ({ page }) => {
    await page.focus('.pill');
    await page.keyboard.press('Enter');
    await page.locator('.sheet').waitFor();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
      assert.equal(await page.evaluate(() => !!document.activeElement.closest('.sheet')), true, 'o Tab não sai do painel');
    }
    await page.keyboard.press('Escape');
    await page.locator('.sheet').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('pill')), true, 'o foco volta para quem abriu');

    // arrasto curto: o painel volta; arrasto longo: fecha
    const drag = async (dy) => {
      await page.click('.pill');
      const grab = page.locator('.sheet__grab');
      await grab.waitFor();
      const box = await grab.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await grab.dispatchEvent('pointerdown', { clientX: x, clientY: y, pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true });
      for (let step = 1; step <= 5; step++) await grab.dispatchEvent('pointermove', { clientX: x, clientY: y + (dy * step) / 5, pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true });
      await page.waitForTimeout(250); // devagar: só a distância decide
      await grab.dispatchEvent('pointerup', { clientX: x, clientY: y + dy, pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true });
    };
    await drag(30);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.sheet').count(), 1, 'arrasto curto não fecha');
    assert.equal(await page.evaluate(() => document.querySelector('.sheet').style.transform), '');
    await back(page);
    await page.locator('.sheet').waitFor({ state: 'detached' });
    await drag(260);
    await page.locator('.sheet').waitFor({ state: 'detached' });
  });
});

test('controle segmentado pelo teclado; aviso rápido único; confirmação responde sim e não', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/ajustes' }, async ({ page }) => {
    await page.focus('.seg__opt[aria-checked="true"]');
    await page.keyboard.press('ArrowRight');
    assert.equal(await appState(page, (s) => s.settings.theme), 'dark');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Escuro');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    assert.equal(await appState(page, (s) => s.settings.theme), 'system', 'as setas dão a volta');
    assert.equal(await page.locator('.seg__opt[tabindex="0"]').count(), 1, 'só a opção marcada entra na ordem do Tab');

    const result = await page.evaluate(async () => {
      const { toast, confirmDialog } = await import('./js/ui/dom.js');
      toast('primeiro');
      toast('segundo', { action: { label: 'Desfazer', onClick: () => (window.__desfez = true) } });
      const toasts = [...document.querySelectorAll('.toast')].map((t) => t.querySelector('.toast__text').textContent);
      document.querySelector('.toast__action').click();
      const yes = confirmDialog({ title: 'Continuar?', text: 'Texto', confirmLabel: 'Sim' });
      document.querySelector('.dialog .btn--primary').click();
      const no = confirmDialog({ title: 'Apagar?', danger: true });
      const focusOnCancel = document.activeElement.textContent === 'Cancelar';
      document.querySelector('.layer:last-of-type .scrim').click();
      return { toasts, undone: window.__desfez, yes: await yes, no: await no, focusOnCancel, left: document.querySelectorAll('.toast').length };
    });
    assert.deepEqual(result.toasts, ['segundo'], 'um aviso por vez');
    assert.equal(result.undone, true);
    assert.equal(result.left, 0);
    assert.equal(result.yes, true);
    assert.equal(result.no, false, 'tocar fora é cancelar');
    assert.equal(result.focusOnCancel, true, 'em ação destrutiva o foco começa no cancelar');
  });
});

test('componentes de sinal e selos: número, palavra e barras juntos; rótulos para leitor de tela', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    const out = await page.evaluate(async () => {
      const c = await import('./js/ui/components.js');
      const { parseCapabilities } = await import('./js/core/security.js');
      const badge = c.signalBadge(-72);
      const bars = c.signalBars(-45);
      const none = c.signalBars(undefined);
      const hidden = c.ssidLabel('');
      const ctl = c.ssidLabel('linha1\nlinha2\u0007');
      return {
        text: badge.textContent,
        cls: badge.className,
        bars: [bars.dataset.bars, bars.getAttribute('aria-label'), bars.getAttribute('role'), bars.children.length],
        none: [none.dataset.bars, none.getAttribute('aria-label')],
        band: [c.bandBadge('2.4').textContent, c.bandBadge(5180).className, c.bandBadge('x').textContent],
        sec: [c.securityBadge(parseCapabilities('[ESS]')).textContent, c.securityBadge(parseCapabilities('[ESS]')).className, c.securityBadge(parseCapabilities('[WPA2-PSK-CCMP][ESS]')).textContent, c.securityBadge(null).textContent],
        std: [c.standardBadge({ standard: 'Wi-Fi 6', gen: 6, genSource: 'android' }).textContent, c.standardBadge({ standard: 'Wi-Fi 5', gen: 5, genSource: 'inferred' }).textContent, c.standardBadge({ standard: 'Wi-Fi', gen: null }), c.standardBadge(null)],
        hidden: [hidden.textContent, hidden.className],
        ctl: ctl.textContent,
        meter: c.meter(140).getAttribute('aria-valuenow'),
      };
    });
    assert.equal(out.text, `${MINUS}72${THIN}dBmRegular`);
    assert.match(out.cls, /sig-fair/);
    assert.deepEqual(out.bars, ['4', 'Sinal: excelente', 'img', 4]);
    assert.deepEqual(out.none, ['0', 'Sinal: sem leitura']);
    assert.equal(out.band[0], `2,4${THIN}GHz`);
    assert.match(out.band[1], /badge--b5/);
    assert.equal(out.band[2], '—');
    assert.equal(out.sec[0], 'Aberta');
    assert.match(out.sec[1], /badge--warning/);
    assert.equal(out.sec[2], 'WPA2');
    assert.equal(out.sec[3], 'Segurança desconhecida');
    assert.deepEqual(out.std, ['Wi-Fi 6', 'Wi-Fi 5+', null, null]);
    assert.deepEqual(out.hidden, ['Rede oculta', 'ssid ssid--hidden']);
    assert.equal(out.ctl, 'linha1·linha2·', 'caracteres de controle não quebram a linha');
    assert.equal(out.meter, '100');
  });
});
