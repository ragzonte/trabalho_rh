// Tela Redes, painéis de detalhes e a ferramenta "Sinal ao longo do tempo", de ponta a ponta
// contra o simulador: cartão da conexão, resumo, modos, ordem, filtros, busca, dados ao vivo
// (nada pula, nada fecha), painéis, ações, estados vazios e texto hostil.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, withApp, shot, goto, back, settle, appState, waitForScans, waitForScreen, horizontalOverflow } from './helpers.mjs';

const T = { timeout: 120_000 };
const FAST = { speed: 10 }; // o tempo do simulador corre 10x
const HOSTILE = '<img src=x onerror=alert(1)>';
const EMOJI = '🚀 WIFI_DA_FAMILIA_ALBUQUERQUE';
const MINUS = '\u2212';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

// As telas vizinhas são de outros autores: aqui elas viram páginas mínimas, para o teste das
// ações de navegação depender só do que esta tela faz (a rota e os parâmetros).
const STUB = (name) => `export function mount(root, ctx) { root.dataset.stub = '${name}'; root.textContent = '${name} ' + String(ctx.route.query); return { unmount() {} }; }`;
async function stubNeighbours(page) {
  for (const [glob, name] of [
    ['**/js/ui/tools/medidor.js*', 'medidor'],
    ['**/js/ui/screens/channels.js*', 'canais'],
    ['**/js/ui/screens/best.js*', 'melhor'],
  ]) {
    await page.route(glob, (route) => route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: STUB(name) }));
  }
}

const ready = async (page, scans = 1) => {
  await waitForScans(page, scans);
  await page.waitForFunction(() => window.__wrx.app.store.get().vendorsReady === true);
  await page.waitForSelector('.net-row');
  await settle(page);
};

/** Provoca `n` buscas seguidas (respeitando a folga entre pedidos) e espera cada lista chegar. */
async function pump(page, n = 1) {
  for (let i = 0; i < n; i++) {
    await page.waitForFunction(() => !window.__wrx.app.store.get().scan.scanning);
    const seq = await appState(page, (s) => s.scan.seq);
    await page.waitForTimeout(1600);
    await page.evaluate(() => window.__wrx.app.scanLoop.scanNow());
    await page.waitForFunction((s) => window.__wrx.app.store.get().scan.seq > s, seq, { timeout: 20_000 });
  }
  await settle(page);
}

const rowNames = (page) => page.locator('.net-row .row__title .ssid').allTextContents();
const rowDbm = async (page) => (await page.locator('.net-row .net-row__dbm').allTextContents()).map((t) => Number(t.replace(MINUS, '-').replace(/[^\d-]/g, '')));
const scrollTop = (page, sel = '.view') => page.evaluate((s) => document.querySelector(s).scrollTop, sel);
/** Quantos pixels do canvas foram pintados (alfa > 0). */
const inked = (page, sel) =>
  page.evaluate((s) => {
    const c = document.querySelector(s);
    if (!c || !c.width) return 0;
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  }, sel);

// ---------------------------------------------------------------------------
// A tela
// ---------------------------------------------------------------------------

test('Redes: cartão da conexão, resumo e lista batem com o estado do app', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);

    // cartão da conexão
    const conn = await appState(page, (s) => s.connection);
    assert.equal(await page.textContent('.net-conn__name .ssid'), conn.ssid);
    assert.match(await page.textContent('.net-conn__eyebrow'), /Conectado a/);
    assert.match(await page.textContent('.net-conn__dbm'), new RegExp(`^${MINUS}\\d{2}$`), 'o sinal usa o menos tipográfico');
    assert.equal(await page.textContent('.net-conn__unit'), 'dBm');
    assert.match(await page.textContent('.net-conn__word'), /^(Excelente|Ótimo|Bom|Regular|Fraco|Muito fraco)$/);
    assert.equal(await page.locator('.net-conn__signal .bars').count(), 1, 'barras junto do número e da palavra');
    const facts = await page.locator('.net-conn__facts .badge').allTextContents();
    assert.match(facts.join(' | '), /GHz/);
    assert.match(facts.join(' | '), /Canal \d+/);
    assert.match(facts.join(' | '), /\d+\s*MHz/);
    assert.match(facts.join(' | '), /Wi-Fi \d/);
    const stats = await page.locator('.net-conn__stat').allTextContents();
    assert.match(stats[0], /^Velocidade até o roteador↓[\d,]+↑[\d,]+\s*(Mb|Gb)\/s$/, 'recebendo e enviando, com a unidade uma vez só');
    assert.match(stats[1], /Distância estimada≈\s*[\d,]+\s*m/, 'a distância vem marcada como estimativa');
    // o aviso do diagnóstico é uma linha só e leva a Melhor Wi-Fi
    const insight = page.locator('.net-insight');
    assert.equal(await insight.count(), 1);
    assert.ok((await insight.locator('.net-insight__text').textContent()).length > 8);

    // resumo
    const sum = await appState(page, (s) => ({ nets: s.networks.length, devices: s.devices.length, b24: s.networks.filter((n) => n.bands.includes('2.4')).length, b5: s.networks.filter((n) => n.bands.includes('5')).length }));
    const cells = await page.locator('.net-sum__cell').allTextContents();
    assert.equal(cells[0], `${sum.nets}redes`);
    assert.equal(cells[1], `${sum.devices}roteadores`);
    assert.match(cells[2], new RegExp(`^${sum.b24}2,4\\s*GHz$`));
    assert.match(cells[3], new RegExp(`^${sum.b5}5\\s*GHz$`));

    // lista: uma linha por rede, da mais forte para a mais fraca
    assert.equal(await page.locator('.net-row').count(), sum.nets);
    const dbm = await rowDbm(page);
    for (let i = 1; i < dbm.length; i++) assert.ok(dbm[i - 1] >= dbm[i], `linha ${i}: ${dbm[i - 1]} antes de ${dbm[i]}`);
    // cada linha tem barras, número, palavra e minigráfico (a cor nunca vai sozinha)
    const first = page.locator('.net-row').first();
    assert.equal(await first.locator('.bars').count(), 1);
    assert.match(await first.locator('.net-row__dbm').textContent(), new RegExp(`^${MINUS}\\d+\\s*dBm$`));
    assert.ok((await first.locator('.net-row__word').textContent()).length > 2);
    assert.equal(await first.locator('svg.spark').count(), 1);
    // a rede em uso está marcada
    const connected = page.locator('.net-row--connected');
    assert.equal(await connected.count(), 1);
    assert.match(await connected.textContent(), /Conectado/);
    // rede oculta: nome em itálico apagado, com parênteses
    const hidden = page.locator('.net-row .ssid--hidden');
    if (await hidden.count()) assert.equal(await hidden.first().textContent(), '(rede oculta)');

    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'redes-inicio');
  });
});

test('Redes cabe em 360 px e no tema claro', T, async () => {
  await withApp(env, { params: { ...FAST, theme: 'light' }, viewport: 'small', colorScheme: 'light' }, async ({ page }) => {
    await ready(page, 2);
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    assert.deepEqual(await horizontalOverflow(page), []);
    // nada cortado no cartão: os dois números aparecem inteiros numa linha cada
    for (const value of await page.locator('.net-conn__stat-value').all()) {
      const box = await value.boundingBox();
      assert.ok(box.height <= 26, `valor em uma linha (${box.height}px)`);
    }
    await page.locator('.net-row').first().click();
    await page.locator('.ap-sheet').waitFor();
    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'redes-360-claro-detalhe');
  });
});

test('nomes hostis e compridos são só texto, na lista e no painel', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 1);
    await page.waitForFunction((name) => window.__wrx.app.store.get().aps.some((a) => a.ssid === name), HOSTILE, { timeout: 60_000 });
    const label = page.locator('.view').getByText(HOSTILE, { exact: true }).first();
    await label.waitFor({ timeout: 15_000 });
    assert.equal(await label.evaluate((el) => el.childElementCount), 0);

    // o nome com emoji é cortado com reticências, não quebra a linha
    const emoji = page.locator('.net-row .ssid', { hasText: 'WIFI_DA_FAMILIA' }).first();
    await emoji.waitFor();
    assert.equal(await emoji.textContent(), EMOJI);
    const cut = await emoji.evaluate((el) => ({ clipped: el.scrollWidth > el.clientWidth, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) }));
    assert.equal(cut.clipped, true, 'nome comprido é cortado');
    assert.equal(cut.lines, 1);

    // busca com marcação: nada é interpretado
    await page.click('button[aria-label="Buscar na lista de redes"]');
    await page.fill('.net-search__input', '<img');
    await settle(page);
    assert.deepEqual(await rowNames(page), [HOSTILE]);
    await page.fill('.net-search__input', '"><script>alert(1)</script>');
    await settle(page);
    assert.equal(await page.locator('.net-row').count(), 0);
    assert.match(await page.textContent('.empty__title'), /Nada encontrado para “"><script>alert\(1\)<\/script>”/);
    await page.fill('.net-search__input', '<img');
    await settle(page);

    // painel de detalhes do vizinho hostil
    await page.locator('.net-row').first().click();
    await page.locator('.ap-sheet').waitFor();
    assert.equal(await page.textContent('.ap-sheet .sheet__title'), HOSTILE);
    assert.equal(await page.locator('.ap-sheet .sheet__title *').evaluateAll((els) => els.every((el) => el.tagName === 'SPAN')), true);
    // o roteador anuncia também um nome de aparelho hostil pelo WPS: aparece como texto em "Modelo"
    const model = page.locator('.ap-sheet .kv__row', { hasText: 'Modelo' });
    if (await model.count()) assert.match(await model.textContent(), /<script>|<svg|onload|alert/);
    assert.equal(await page.locator('img, script:not([src]), iframe, object, embed').count(), 0, 'nenhum elemento foi criado a partir de um nome');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[onerror], [onload], [onclick], [onmouseover]').length), 0);
    await shot(page, 'redes-detalhe-hostil');
  });
});

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

test('modos Redes / Roteadores / Sinais: uma linha por nome, por aparelho e por BSSID; a escolha fica guardada', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);
    const counts = await appState(page, (s) => ({ nets: s.networks.length, devices: s.devices.length, aps: s.aps.length }));
    assert.ok(counts.aps > counts.devices, 'o apartamento tem roteadores de duas faixas');

    await page.click('.seg__opt:has-text("Roteadores")');
    await settle(page);
    assert.equal(await page.locator('.net-row').count(), counts.devices);
    assert.equal(await page.locator('.net-row[data-kind="device"]').count(), counts.devices);
    assert.match(await page.textContent('.net-caption'), new RegExp(`${counts.devices} roteadores · uma linha por aparelho`));
    // o roteador da casa junta as duas faixas e avisa que anuncia outro nome
    const own = page.locator('.net-row--connected');
    assert.match(await own.textContent(), /2 sinais/);
    assert.equal(await own.locator('.badge', { hasText: '+1' }).count(), 1);

    await page.click('.seg__opt:has-text("Sinais")');
    await settle(page);
    assert.equal(await page.locator('.net-row').count(), counts.aps);
    assert.equal(await page.getAttribute('.seg__opt[aria-checked="true"]', 'role'), 'radio');
    assert.equal(await page.textContent('.seg__opt[aria-checked="true"]'), 'Sinais');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wrx.redes'))), { mode: 'signals', sort: 'signal' });

    // trocar de aba e voltar: o modo continua
    await page.click('.bottomnav__item[data-tab="ferramentas"]');
    await waitForScreen(page, '/ferramentas');
    await page.click('.bottomnav__item[data-tab="redes"]');
    await waitForScreen(page, '/redes');
    await page.waitForSelector('.net-row');
    assert.equal(await page.textContent('.seg__opt[aria-checked="true"]'), 'Sinais');
    assert.equal(await page.locator('.net-row').count(), await appState(page, (s) => s.aps.length));

    // recarregar o app: também
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await ready(page, 1);
    assert.equal(await page.textContent('.seg__opt[aria-checked="true"]'), 'Sinais');
  });
});

test('ordenar por sinal, nome e canal (a caixa de seleção do sistema, por trás de um chip)', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);
    const select = page.locator('.net-sort__native');
    assert.equal(await select.getAttribute('aria-label'), 'Ordenar por');
    assert.equal(await page.textContent('.net-sort__label'), 'Sinal');

    await select.selectOption('name');
    await settle(page);
    assert.equal(await page.textContent('.net-sort__label'), 'Nome');
    const names = (await rowNames(page)).filter((n) => n !== '(rede oculta)');
    const sorted = [...names].sort(new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' }).compare);
    assert.deepEqual(names, sorted);
    const all = await rowNames(page);
    if (all.includes('(rede oculta)')) assert.equal(all[all.length - 1], '(rede oculta)', 'ocultas por último');

    await page.click('.seg__opt:has-text("Sinais")');
    await select.selectOption('channel');
    await settle(page);
    assert.equal(await page.textContent('.net-sort__label'), 'Canal');
    const order = await page.evaluate(() => [...document.querySelectorAll('.net-row')].map((el) => window.__wrx.app.store.apById(el.dataset.bssid)).map((ap) => [ap.band === '2.4' ? 0 : ap.band === '5' ? 1 : 2, ap.channel]));
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i - 1][0] < order[i][0] || (order[i - 1][0] === order[i][0] && order[i - 1][1] <= order[i][1]), `linha ${i}: ${order[i - 1]} antes de ${order[i]}`);
    }

    // uma busca que chega não mexe na ordem escolhida
    await pump(page, 1);
    assert.equal(await page.textContent('.net-sort__label'), 'Canal');
    assert.equal(await select.inputValue(), 'channel');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wrx.redes')).sort), 'channel');
  });
});

test('filtros de faixa, "Minhas" e "Abertas", com a contagem e o "limpar filtros"', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);
    const total = await appState(page, (s) => s.networks.length);
    assert.equal(await page.locator('.net-caption').isHidden(), true, 'sem filtro a legenda não aparece (o resumo já diz tudo)');

    const five = page.locator('.net-chip[data-filter="5"]');
    await five.click();
    await settle(page);
    assert.equal(await five.getAttribute('aria-pressed'), 'true');
    const fiveCount = await appState(page, (s) => s.networks.filter((n) => n.bands.includes('5')).length);
    assert.equal(await page.locator('.net-row').count(), fiveCount);
    assert.match(await page.textContent('.net-caption__text'), new RegExp(`^${fiveCount} de ${total} redes`));
    // toda linha mostra o rádio de 5 GHz (e só ele)
    for (const row of await page.locator('.net-row').all()) {
      const text = await row.locator('.row__sub').first().textContent();
      assert.match(text, /5\s*GHz/);
      assert.doesNotMatch(text, /2,4\s*GHz/);
    }

    // as duas faixas juntas = todas
    await page.click('.net-chip[data-filter="2.4"]');
    await settle(page);
    assert.equal(await page.locator('.net-row').count(), total);

    // minhas: a rede em uso (e o outro rádio do mesmo roteador)
    await page.click('.net-chip[data-filter="2.4"]');
    await page.click('.net-chip[data-filter="5"]');
    await page.click('.net-chip[data-filter="mine"]');
    await settle(page);
    const mine = await rowNames(page);
    assert.ok(mine.length >= 1 && mine.length <= 2);
    assert.ok(mine.every((n) => n.startsWith('VIVOFIBRA-8F3C')), mine.join(', '));

    // minhas E abertas: nada, com um caminho de volta
    await page.click('.net-chip[data-filter="open"]');
    await settle(page);
    assert.equal(await page.locator('.net-row').count(), 0);
    assert.equal(await page.locator('.net-list').isHidden(), true);
    assert.match(await page.textContent('.empty__title'), /Nenhuma rede com esses filtros/);
    await shot(page, 'redes-filtro-vazio');
    // os filtros continuam valendo quando chega uma busca
    await pump(page, 1);
    assert.equal(await page.locator('.net-row').count(), 0);
    assert.equal(await page.getAttribute('.net-chip[data-filter="open"]', 'aria-pressed'), 'true');

    await page.click('.empty .btn');
    await settle(page);
    assert.equal(await page.locator('.net-row').count(), await appState(page, (s) => s.networks.length));
    assert.equal(await page.locator('.net-chip[aria-pressed="true"]').count(), 0);

    // só abertas, sem nenhuma por perto: mensagem própria
    await page.click('.net-chip[data-filter="open"]');
    await settle(page);
    assert.match(await page.textContent('.empty__title'), /Nenhuma rede aberta por perto/);
  });
});

test('busca por nome, fabricante e BSSID; o "voltar" fecha a busca', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);
    const btn = page.locator('button[aria-label="Buscar na lista de redes"]');
    assert.equal(await btn.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.net-search').count(), 0);
    await btn.click();
    assert.equal(await btn.getAttribute('aria-pressed'), 'true');
    const input = page.locator('.net-search__input');
    await input.waitFor();
    assert.equal(await input.evaluate((el) => el === document.activeElement), true, 'o campo já abre com o foco');

    await input.fill('tp-link');
    await settle(page);
    const byVendor = await page.evaluate(() => [...document.querySelectorAll('.net-row')].map((el) => window.__wrx.app.store.apById(el.dataset.bssid)).map((ap) => `${ap.ssid}|${ap.vendor}`));
    assert.ok(byVendor.length >= 2);
    assert.ok(byVendor.every((t) => /tp-link/i.test(t)), byVendor.join(' ; '));
    assert.ok(byVendor.some((t) => !/tp-link/i.test(t.split('|')[0])), 'achou também pelo fabricante (o nome não diz TP-Link)');
    assert.match(await page.textContent('.net-caption__text'), /^\d+ de \d+ redes/);

    const bssid = await appState(page, (s) => s.aps.find((a) => a.connected).bssid);
    await input.fill(bssid.toUpperCase());
    await settle(page);
    assert.deepEqual(await rowNames(page), [await appState(page, (s) => s.aps.find((a) => a.connected).ssid)]);
    await input.fill(bssid.replace(/:/g, '').slice(0, 8));
    await settle(page);
    assert.ok((await page.locator('.net-row').count()) >= 1);

    // sem acento, sem maiúsculas
    await input.fill('OCULTA');
    await settle(page);
    const hiddenCount = await appState(page, (s) => s.networks.filter((n) => n.hidden).length);
    assert.equal(await page.locator('.net-row').count(), hiddenCount);

    await input.fill('zzzz');
    await settle(page);
    assert.match(await page.textContent('.empty__title'), /Nada encontrado para “zzzz”/);
    await shot(page, 'redes-busca-vazia');

    // "voltar" do Android: fecha a busca (e limpa), sem sair da tela
    assert.equal(await back(page), true);
    assert.equal(await page.locator('.net-search').count(), 0);
    assert.equal(await btn.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('.net-row').count(), await appState(page, (s) => s.networks.length));
    assert.equal(await page.evaluate(() => location.hash), '#/redes');
    // na tela inicial, sem nada aberto, o "voltar" sai do app
    assert.equal(await back(page), false);
  });
});

// ---------------------------------------------------------------------------
// Dados ao vivo
// ---------------------------------------------------------------------------

test('uma busca que chega atualiza no lugar: rolagem, foco, texto da busca e os nós das linhas ficam', T, async () => {
  await withApp(env, { params: FAST, viewport: 'small' }, async ({ page }) => {
    await ready(page, 2);
    // marca os nós das linhas e do cartão para ver que não foram recriados
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.net-row')) el.__mark = true;
      // quais redes já estavam na lista (a pessoa virtual está andando: redes novas vão aparecer)
      window.__rowsBefore = [...document.querySelectorAll('.net-row')].map((el) => `${el.dataset.kind}:${el.dataset.bssid}`);
      document.querySelector('.net-conn').__mark = 'conn';
      document.querySelector('.net-controls .seg').__mark = 'seg';
    });
    await page.evaluate(() => document.querySelector('.view').scrollTo(0, 500));
    await settle(page);
    const top = await scrollTop(page);
    assert.ok(top > 300, 'a lista rola');
    assert.equal(await page.locator('.net-controls[data-stuck]').count(), 1, 'os controles ficam presos no topo');
    const controlsBox = await page.locator('.net-controls').boundingBox();
    const topbar = await page.locator('.topbar').boundingBox();
    assert.ok(Math.abs(controlsBox.y - (topbar.y + topbar.height)) <= 1, 'colados sob a barra de cima');

    await page.click('button[aria-label="Buscar na lista de redes"]');
    await page.locator('.net-search__input').pressSequentially('a');
    await settle(page);
    const before = await scrollTop(page);

    await pump(page, 3);

    assert.equal(await scrollTop(page), before, 'a rolagem não se mexe');
    assert.equal(await page.locator('.net-search__input').inputValue(), 'a');
    assert.equal(await page.locator('.net-search__input').evaluate((el) => el === document.activeElement), true, 'o foco continua no campo');
    const marks = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('.net-row')].filter((el) => el.__mark === true).length,
      total: document.querySelectorAll('.net-row').length,
      // linha sem a marca cuja rede JÁ estava na lista = nó refeito. (Rede ouvida pela primeira vez
      // depois da marca não conta: a contagem delas depende de quanto a pessoa virtual andou, e a
      // tolerância fixa de antes, "no máximo 2 linhas novas", falhava de vez em quando.)
      recreated: [...document.querySelectorAll('.net-row')].filter((el) => el.__mark !== true && window.__rowsBefore.includes(`${el.dataset.kind}:${el.dataset.bssid}`)).length,
      conn: document.querySelector('.net-conn').__mark,
      seg: document.querySelector('.net-controls .seg').__mark,
    }));
    assert.ok(marks.total > 0);
    assert.ok(marks.rows > 0, 'linhas de antes continuam na lista');
    assert.equal(marks.recreated, 0, `nenhuma linha que já existia foi refeita (${marks.rows} de ${marks.total} são os mesmos nós)`);
    assert.equal(marks.conn, 'conn');
    assert.equal(marks.seg, 'seg');
    // nenhuma linha anima ao ser atualizada
    const anim = await page.evaluate(() => [...document.querySelectorAll('.net-row, .net-row *')].filter((el) => getComputedStyle(el).animationName !== 'none').length);
    assert.equal(anim, 0);
  });
});

test('o sinal da conexão anda sozinho (uma leitura por segundo) e os minigráficos ganham traço', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 1);
    const seen = new Set();
    for (let i = 0; i < 8; i++) {
      seen.add(await page.textContent('.net-conn__dbm'));
      await page.waitForTimeout(700);
    }
    assert.ok(seen.size >= 2, `o número mudou sem esperar uma busca (${[...seen].join(', ')})`);
    const live = await appState(page, (s) => s.rssi.rssi);
    const shown = Number((await page.textContent('.net-conn__dbm')).replace(MINUS, '-'));
    assert.ok(Math.abs(shown - live) <= 12, 'o cartão acompanha a leitura ao vivo');
    assert.match(await page.getAttribute('.net-conn__spark .spark__line', 'd'), /^M[\d. ]+L/, 'minigráfico do cartão com traço');

    await pump(page, 3);
    const paths = await page.locator('.net-row .spark__line').evaluateAll((els) => els.map((el) => el.getAttribute('d')));
    assert.ok(paths.filter((d) => /L/.test(d)).length >= 3, 'depois de algumas buscas, as redes ouvidas têm traço');
    assert.ok(paths.every((d) => !/NaN|undefined/.test(d)));
  });
});

test('rede que não apareceu na última busca fica apagada e mostra a idade', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);
    // uma lista em que só o vizinho hostil NÃO foi ouvido de novo (o Android repete a leitura velha)
    const target = await page.evaluate(async () => {
      const app = window.__wrx.app;
      app.scanLoop.stop(); // nem as buscas do próprio Android entram: a lista fica como o teste deixou
      const last = await app.bridge.lastScan();
      const victim = last.aps.find((a) => a.ssid.startsWith('TP-Link')) || last.aps[last.aps.length - 1];
      const ts = Date.now() + 15_000;
      app.store.ingestScan({ ts, fresh: true, source: 'request', aps: last.aps.map((a) => (a.bssid === victim.bssid ? { ...a, ageMs: a.ageMs + 15_000 } : { ...a, ageMs: 150 })) });
      return victim.bssid;
    });
    await settle(page);
    const row = page.locator(`.net-row[data-bssid="${target}"]`);
    assert.match(await row.getAttribute('class'), /row--stale/);
    assert.match(await row.locator('.net-row__age').textContent(), /visto há 1\d\s*s/);
    assert.equal(await page.locator('.net-row.row--stale').count(), 1);
    // "apagada" é o desenho (barras, gráfico) e o nome na cor secundária; o texto não perde contraste
    // (opacidade 0,6 na linha toda deixava "visto há 15 s" abaixo de 4,5:1: veja review-ux.e2e.mjs)
    assert.ok(Number(await row.locator('.row__lead').evaluate((el) => getComputedStyle(el).opacity)) < 1);
    assert.equal(Number(await row.locator('.row__body').evaluate((el) => getComputedStyle(el).opacity)), 1);
    assert.notEqual(await row.locator('.row__title').evaluate((el) => getComputedStyle(el).color), await page.locator('.net-row:not(.row--stale) .row__title').first().evaluate((el) => getComputedStyle(el).color));
    // no painel de detalhes a mesma coisa é dita com palavras
    await row.click();
    await page.locator('.ap-sheet').waitFor();
    assert.match(await page.textContent('.ap-signal__note'), /Não apareceu na última busca; leitura de há 1\d\s*s/);
    await shot(page, 'redes-rede-velha');
  });
});

// ---------------------------------------------------------------------------
// Painéis de detalhes
// ---------------------------------------------------------------------------

test('detalhes de um ponto de acesso: sinal, gráfico, fatos, segurança, recursos, BSSID', T, async () => {
  await withApp(env, { params: FAST }, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await ready(page, 2);
    await pump(page, 2);
    const ap = await appState(page, (s) => {
      const a = s.aps.find((x) => x.connected);
      return { bssid: a.bssid, ssid: a.ssid, channel: a.channel, widthMHz: a.widthMHz, standard: a.standard, security: a.security.label, vendor: a.vendor, stations: a.stations };
    });
    await page.click('.net-conn__main');
    const panel = page.locator('.ap-sheet');
    await panel.waitFor();
    assert.equal(await panel.getAttribute('data-bssid'), ap.bssid);
    assert.equal(await panel.locator('.sheet__title').textContent(), ap.ssid);
    assert.match(await panel.locator('.sheet__subtitle').textContent(), new RegExp(`${ap.vendor} · .*GHz · canal ${ap.channel}`));

    // sinal: número, palavra, frase e "ao vivo" (é a rede conectada)
    assert.match(await panel.locator('.ap-signal__dbm').textContent(), new RegExp(`^${MINUS}\\d+\\s*dBm$`));
    assert.ok((await panel.locator('.ap-signal__word').textContent()).length > 2);
    assert.ok((await panel.locator('.ap-signal__note').textContent()).length > 10);
    assert.match(await panel.locator('.ap-signal .badge').textContent(), /ao vivo/);
    assert.match(await panel.locator('.ap-badges').textContent(), /Conectado/);

    // gráfico: canvas nítido (2 pixels por pixel CSS), com algo desenhado e com descrição
    const canvas = panel.locator('canvas.time-chart');
    await canvas.waitFor();
    const size = await canvas.evaluate((c) => ({ w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, dpr: devicePixelRatio }));
    assert.equal(size.dpr, 2);
    assert.equal(size.w, size.cw * 2);
    assert.equal(size.h, size.ch * 2);
    assert.ok(size.cw > 250);
    assert.ok((await inked(page, '.ap-sheet canvas.time-chart')) > 2000, 'o gráfico tem conteúdo');
    assert.match(await canvas.getAttribute('aria-label'), new RegExp(`Sinal desta rede.*${MINUS}\\d+ dBm`));
    assert.match(await panel.locator('.ap-chart-card__note').textContent(), /ao vivo · 1 leitura por segundo/);

    // quadradinhos de fatos
    const fact = (id) => panel.locator(`.fact[data-fact="${id}"]`);
    assert.equal(await fact('channel').locator('.fact__value').textContent(), String(ap.channel));
    assert.match(await fact('channel').locator('.fact__hint').textContent(), /GHz · \d{4}\s*MHz/);
    assert.match(await fact('width').locator('.fact__value').textContent(), new RegExp(`^${ap.widthMHz}\\s*MHz$`));
    assert.match(await fact('width').locator('.fact__hint').textContent(), /^ocupa \d{4}–\d{4}\s*MHz$/);
    assert.equal(await fact('standard').locator('.fact__value').textContent(), ap.standard);
    assert.equal(await fact('security').locator('.fact__value').textContent(), ap.security);
    assert.match(await fact('speed').locator('.fact__value').textContent(), /^≈\s*[\d,]+\s*(Mb|Gb)\/s$/);
    assert.match(await fact('speed').locator('.fact__hint').textContent(), /^estimativa · máximo teórico: [\d,]+\s*(Mb|Gb)\/s$/);
    assert.match(await fact('distance').locator('.fact__value').textContent(), /^≈\s*[\d,]+\s*m$/);
    assert.match(await fact('distance').locator('.fact__hint').textContent(), /estimativa/);
    assert.match(await fact('antennas').locator('.fact__value').textContent(), /^\d×\d$/);
    if (ap.stations != null) assert.match(await fact('stations').locator('.fact__value').textContent(), /^\d+$/);

    // segurança explicada, recursos em palavras simples
    const sec = panel.locator('.ap-sec');
    assert.match(await sec.textContent(), /A segurança é a forma como a rede embaralha/);
    assert.ok((await sec.locator('.ap-issue').count()) >= 1, 'cada ponto de atenção numa linha');
    const features = await panel.locator('.ap-feature .ap-feature__label').allTextContents();
    for (const name of ['Roaming assistido (802.11k/v)', 'Roaming rápido (802.11r)', 'MU-MIMO', 'Beamforming', 'TWT', 'BSS Color', 'WPS']) assert.ok(features.includes(name), name);
    assert.ok((await panel.locator('.ap-feature .ap-feature__hint').allTextContents()).every((t) => t.length > 15), 'cada recurso tem uma linha de explicação');

    // o outro rádio do mesmo roteador
    const sibling = panel.locator('.ap-radio');
    assert.equal(await sibling.count(), 1);
    assert.match(await sibling.textContent(), /VIVOFIBRA-8F3C/);

    // mais detalhes + copiar
    const kv = await panel.locator('.ap-kv .kv__label').allTextContents();
    for (const label of ['BSSID', 'Fabricante', 'Frequência', 'Trecho ocupado', 'País', 'Visto pela primeira vez', 'Visto pela última vez']) assert.ok(kv.includes(label), label);
    await panel.locator('button[aria-label="Copiar o BSSID"]').click();
    await page.locator('.toast').waitFor();
    assert.match(await page.textContent('.toast'), /BSSID copiado/);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), ap.bssid);
    await panel.getByRole('button', { name: 'Copiar todos os detalhes' }).click();
    await page.waitForFunction(() => /Detalhes copiados/.test(document.querySelector('.toast')?.textContent || ''));
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(text.startsWith(`Rede: ${ap.ssid}\nBSSID: ${ap.bssid}\n`));
    assert.match(text, /Canal: \d+/);
    assert.match(text, /Recursos:\n- Roaming assistido/);
    assert.match(text, /Gerado pelo WiFi Raio-X$/);
    assert.doesNotMatch(text, /undefined|null|NaN/);

    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'redes-detalhe');
    assert.equal(await back(page), true, 'o voltar fecha o painel');
    await panel.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => location.hash), '#/redes');
  });
});

test('o painel aberto acompanha as buscas sem fechar nem perder a rolagem', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);
    await page.locator('.net-row', { hasText: 'TP-Link' }).first().click();
    const panel = page.locator('.ap-sheet');
    await panel.waitFor();
    await page.evaluate(() => {
      const body = document.querySelector('.ap-sheet .sheet__body');
      body.scrollTo(0, 700);
      body.__mark = 'corpo';
      document.querySelector('.ap-sheet canvas').__mark = 'canvas';
    });
    await settle(page);
    const top = await scrollTop(page, '.ap-sheet .sheet__body');
    assert.ok(top > 400);
    const seenBefore = await panel.locator('.kv__row', { hasText: 'Visto pela última vez' }).textContent();

    await pump(page, 3);

    assert.equal(await panel.count(), 1, 'o painel continua aberto');
    assert.equal(await scrollTop(page, '.ap-sheet .sheet__body'), top, 'a rolagem do painel não se mexe');
    assert.deepEqual(
      await page.evaluate(() => [document.querySelector('.ap-sheet .sheet__body').__mark, document.querySelector('.ap-sheet canvas').__mark]),
      ['corpo', 'canvas'],
      'o corpo e o canvas do gráfico são os mesmos nós',
    );
    assert.equal(await page.locator('.ap-sheet canvas').count(), 1, 'um canvas só, sem duplicar a cada busca');
    const seenAfter = await panel.locator('.kv__row', { hasText: 'Visto pela última vez' }).textContent();
    assert.notEqual(seenAfter, seenBefore, 'os dados do painel foram atualizados');
    assert.match(await panel.locator('.ap-chart-card__note').textContent(), /1 leitura a cada ~\d+ s/, 'rede não conectada: o gráfico avisa o ritmo das leituras');
    // nenhum cartão do painel foi espremido pela coluna flexível
    const heights = await panel.locator('.sheet__body > *').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    assert.ok(heights.every((h) => h >= 40), `alturas: ${heights.map(Math.round).join(', ')}`);
  });
});

test('"Esta rede é minha": a estrela marca a rede, aparece na lista e alimenta o filtro "Minhas"', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);
    const row = page.locator('.net-row', { hasText: 'TP-Link_FE9F' }).first();
    assert.equal(await row.locator('svg[aria-label="Minha rede"]').count(), 0);
    await row.click();
    const panel = page.locator('.ap-sheet');
    await panel.waitFor();
    const toggle = panel.locator('.ap-own input[role="switch"]');
    assert.equal(await toggle.isChecked(), false);
    assert.match(await panel.locator('.ap-own').textContent(), /Esta rede é minha/);
    await toggle.check();
    await settle(page);
    assert.equal(await toggle.isChecked(), true);
    assert.deepEqual(await appState(page, (s) => [...s.favorites]), ['TP-Link_FE9F']);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wrx.favorites'))), ['TP-Link_FE9F']);
    assert.match(await panel.locator('.ap-own').textContent(), /O app fala desta rede quando diz “seu roteador”/);
    assert.match(await panel.locator('.ap-badges').textContent(), /Minha/);
    // a chave não volta sozinha quando chega uma busca
    await pump(page, 1);
    assert.equal(await toggle.isChecked(), true);
    await back(page);
    await panel.waitFor({ state: 'detached' });

    assert.equal(await row.locator('svg[aria-label="Minha rede"]').count(), 1, 'a estrela aparece na linha');
    await page.click('.net-chip[data-filter="mine"]');
    await settle(page);
    assert.ok((await rowNames(page)).includes('TP-Link_FE9F'));

    // desmarcar
    await page.locator('.net-row', { hasText: 'TP-Link_FE9F' }).first().click();
    await panel.waitFor();
    await panel.locator('.ap-own input[role="switch"]').uncheck();
    await settle(page);
    assert.deepEqual(await appState(page, (s) => [...s.favorites]), []);
  });
});

test('rede com mais de um rádio: painel da rede com um traço e uma linha por ponto de acesso', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 1);
    await page.waitForFunction((name) => (window.__wrx.app.store.get().networks.find((n) => n.ssid === name)?.aps.length || 0) >= 2, EMOJI, { timeout: 60_000 });
    await pump(page, 2);
    const row = page.locator('.net-row', { hasText: 'WIFI_DA_FAMILIA' }).first();
    assert.match(await row.textContent(), /2 sinais/);
    assert.match(await row.textContent(), /2,4\s*GHz.*5\s*GHz/);
    await row.click();
    const net = page.locator('.ap-sheet[data-network]');
    await net.waitFor();
    assert.equal(await net.locator('.sheet__title').textContent(), EMOJI);
    assert.match(await net.locator('.sheet__subtitle').textContent(), /^2 sinais em 1 roteador · 2,4 e 5\s*GHz$/);
    assert.equal(await net.locator('.ap-radio').count(), 2);
    assert.equal(await net.locator('.ap-radio__dot').count(), 2, 'cada rádio com a cor do seu traço');
    assert.match(await net.locator('canvas.time-chart').getAttribute('aria-label'), /2,4\s*GHz · canal \d+: .*5\s*GHz · canal \d+:/);
    assert.ok((await inked(page, '.ap-sheet[data-network] canvas.time-chart')) > 2000);
    await shot(page, 'redes-detalhe-rede');

    // tocar num rádio abre o painel dele por cima; o "voltar" desfaz um de cada vez
    await net.locator('.ap-radio').nth(1).click();
    const apPanel = page.locator('.ap-sheet[data-bssid]');
    await apPanel.waitFor();
    assert.equal(await page.locator('.ap-sheet').count(), 2);
    assert.match(await apPanel.locator('.sheet__subtitle').textContent(), /5\s*GHz · canal \d+/);
    assert.equal(await back(page), true);
    await apPanel.waitFor({ state: 'detached' });
    assert.equal(await net.count(), 1);
    assert.equal(await back(page), true);
    await net.waitFor({ state: 'detached' });
  });
});

test('ações do painel: localizar (medidor com o BSSID) e ver no gráfico de canais (faixa + BSSID)', T, async () => {
  await withApp(env, { params: FAST, before: stubNeighbours }, async ({ page }) => {
    await ready(page, 2);
    const ap = await appState(page, (s) => {
      const a = s.aps.find((x) => x.band === '5');
      return { bssid: a.bssid, ssid: a.ssid };
    });
    await page.click('.seg__opt:has-text("Sinais")');
    await page.locator(`.net-row[data-bssid="${ap.bssid}"]`).click();
    const panel = page.locator('.ap-sheet');
    await panel.waitFor();
    await panel.locator('.row', { hasText: 'Localizar este roteador' }).click();
    await page.waitForFunction(() => location.hash.startsWith('#/ferramentas/medidor'));
    assert.equal(await page.evaluate(() => location.hash), `#/ferramentas/medidor?bssid=${encodeURIComponent(ap.bssid)}`);
    await panel.waitFor({ state: 'detached' });
    await page.waitForSelector('.screen[data-stub="medidor"]');
    assert.equal(await page.textContent('.screen[data-stub="medidor"]'), `medidor bssid=${encodeURIComponent(ap.bssid)}`, 'a ferramenta recebe o BSSID na rota');

    await goto(page, '/redes');
    await page.waitForSelector('.net-row');
    await page.locator(`.net-row[data-bssid="${ap.bssid}"]`).click();
    await panel.waitFor();
    await panel.locator('.row', { hasText: 'Ver no gráfico de canais' }).click();
    await page.waitForFunction(() => location.hash.startsWith('#/canais'));
    assert.equal(await page.evaluate(() => location.hash), `#/canais?band=5&bssid=${encodeURIComponent(ap.bssid)}`);
    await page.waitForSelector('.screen[data-stub="canais"]');
    assert.equal(await page.locator('.layer').count(), 0, 'nenhum painel fica para trás');

    // o aviso do cartão leva a Melhor Wi-Fi
    await goto(page, '/redes');
    await page.waitForSelector('.net-insight');
    await page.click('.net-insight');
    await page.waitForFunction(() => location.hash === '#/melhor');
    await page.waitForSelector('.screen[data-stub="melhor"]');
  });
});

test('outras telas abrem os painéis pelo módulo: openApDetail e openNetworkDetail', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas' }, async ({ page }) => {
    await waitForScans(page, 2);
    const out = await page.evaluate(async () => {
      const mod = await import('./js/ui/ap-detail.js');
      const { store, bridge, navigate } = window.__wrx.app;
      const ctx = { store, bridge, navigate, onCleanup() {} };
      const state = store.get();
      const missing = mod.openApDetail(ctx, '00:00:00:00:00:99');
      const ap = mod.openApDetail(ctx, state.aps[0].bssid.toUpperCase());
      const single = state.networks.find((n) => n.aps.length === 1);
      const viaNet = mod.openNetworkDetail(ctx, single.key);
      const gone = mod.openNetworkDetail(ctx, 'psk:rede-que-não-existe');
      return {
        exports: Object.keys(mod).sort(),
        missing: missing === null,
        gone: gone === null,
        ap: !!ap && typeof ap.close === 'function' && ap.isOpen(),
        viaNet: !!viaNet && viaNet.el.dataset.bssid === single.best.bssid,
        css: !!document.querySelector('link[data-wrx="networks"]'),
        links: document.querySelectorAll('link[data-wrx="networks"]').length,
      };
    });
    assert.deepEqual(out.exports, ['closeDetails', 'copyText', 'ensureNetworksCss', 'openApDetail', 'openNetworkDetail']);
    assert.equal(out.missing, true, 'BSSID fora da lista: avisa e devolve null');
    assert.equal(out.gone, true);
    assert.equal(out.ap, true, 'aceita o BSSID em maiúsculas');
    assert.equal(out.viaNet, true, 'rede de um rádio só abre direto o painel do rádio');
    assert.equal(out.links, 1, 'a folha de estilo entra uma vez só');
    assert.equal(await page.locator('.ap-sheet').count(), 2);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ap-signal')).display === 'flex');
    // o painel do topo recebe as buscas mesmo fora da tela Redes
    await pump(page, 1);
    assert.equal(await page.locator('.ap-sheet').count(), 2);
    await page.evaluate(async () => (await import('./js/ui/ap-detail.js')).closeDetails());
    await page.waitForFunction(() => document.querySelectorAll('.ap-sheet').length === 0);
  });
});

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

test('antes da primeira lista: esqueleto; sem nenhuma rede: aviso amigável com "buscar de novo"', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 1);
    await page.evaluate(() => {
      const app = window.__wrx.app;
      const { status, info } = app.store.get();
      app.scanLoop.stop(); // nem as buscas do próprio Android entram enquanto o teste olha a tela vazia
      app.store.resetScanData();
      app.store.setStatus(status);
      app.store.setInfo(info);
    });
    await settle(page);
    assert.equal(await page.locator('.net-row').count(), 0);
    assert.ok((await page.locator('.skel').count()) >= 6, 'esqueleto da lista e do cartão');
    assert.match(await page.textContent('.section-h__title'), /Procurando redes por perto/);
    assert.equal(await page.locator('.net-controls').isHidden(), true);
    assert.equal(await page.locator('.net-sum').count(), 0);
    await shot(page, 'redes-carregando');

    // chega uma lista vazia
    await page.evaluate(() => window.__wrx.app.store.ingestScan({ ts: Date.now(), fresh: true, source: 'request', aps: [] }));
    await settle(page);
    assert.equal(await page.locator('.skel').count(), 0, 'o esqueleto sai');
    assert.match(await page.textContent('.empty__title'), /Nenhuma rede por perto/);
    assert.equal(await page.locator('.net-conn--off').count(), 1, 'sem conexão conhecida, o cartão diz isso com calma');
    assert.equal(await page.locator('.empty .btn').textContent(), 'Buscar de novo');
    assert.equal(await page.locator('.net-controls').isHidden(), true);

    // "buscar de novo" pede uma busca ao laço (aqui ele está parado: só não pode dar erro)
    await page.click('.empty .btn');
    // as redes voltam: a tela se recompõe sozinha
    await page.evaluate(() => {
      window.__wrx.app.scanLoop.start();
      return window.__wrx.app.bridge.connection().then((c) => window.__wrx.app.store.setConnection(c));
    });
    await page.waitForSelector('.net-row', { timeout: 20_000 });
    assert.equal(await page.locator('.empty').count(), 0);
    assert.equal(await page.locator('.net-controls').isVisible(), true);
    await page.waitForSelector('.net-conn__name');
  });
});

test('lista guardada pelo celular (sem busca nova): a idade aparece na tela e em cada linha', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);
    // o app acabou de abrir e o Android só entregou a lista em cache, lida há 45 s
    await page.evaluate(async () => {
      const app = window.__wrx.app;
      const { status, info, connection } = app.store.get();
      const last = await app.bridge.lastScan();
      app.scanLoop.stop();
      app.store.resetScanData();
      app.store.setStatus(status);
      app.store.setInfo(info);
      app.store.setConnection(connection);
      app.store.ingestScan({ ts: Date.now(), fresh: false, source: 'cache', aps: last.aps.map((a) => ({ ...a, ageMs: 45_000 + (a.ageMs % 3000) })) });
    });
    await settle(page);
    const rows = await page.locator('.net-row').count();
    assert.ok(rows > 3);
    assert.match(await page.textContent('.net-caption__text'), /^\d+ redes · lista de há 4\d\s*s$/, 'a idade da lista vem escrita junto da contagem');
    assert.equal(await page.locator('.net-row.row--stale').count(), rows, 'todas as linhas aparecem como leitura velha');
    assert.match(await page.locator('.net-row__age').first().textContent(), /visto há 4\d\s*s/);
    assert.match(await page.textContent('.topbar__status'), /há 4\d\s*s/, 'e a barra de cima diz o mesmo');
    await shot(page, 'redes-lista-em-cache');
  });
});

test('sem conexão: cartão calmo com o botão do Wi-Fi; a lista continua', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);
    await page.evaluate(() => window.__wrx.app.store.setConnection({ connected: false }));
    await settle(page);
    assert.match(await page.textContent('.net-conn--off'), /Você não está conectado a um Wi-Fi/);
    assert.equal(await page.locator('.net-insight').count(), 0);
    assert.equal(await page.locator('.net-row--connected').count(), 0);
    assert.ok((await page.locator('.net-row').count()) > 3);
    await shot(page, 'redes-sem-conexao');
    await page.click('.net-conn--off .btn');
    await page.locator('.toast').waitFor();
    assert.match(await page.textContent('.toast'), /Na demonstração não há configurações do Android/);
    // a conexão volta: o cartão volta
    await page.evaluate(() => window.__wrx.app.bridge.connection().then((c) => window.__wrx.app.store.setConnection(c)));
    await page.waitForSelector('.net-conn__name');
    assert.equal(await page.locator('.net-row--connected').count(), 1);
  });
});

test('com o limite do Android: dica dispensável com o caminho para liberar', T, async () => {
  await withApp(env, { params: { ...FAST, throttle: 1 } }, async ({ page }) => {
    await ready(page, 1);
    const tip = page.locator('.screen .banner', { hasText: 'O Android está limitando as buscas' });
    await tip.waitFor();
    await shot(page, 'redes-limitado');
    await tip.getByRole('button', { name: 'Como liberar' }).click();
    await page.locator('.sheet').waitFor();
    assert.match(await page.textContent('.sheet__body'), /Limitar busca por Wi-Fi/);
    await back(page);
    await page.locator('.sheet').waitFor({ state: 'detached' });
    await tip.getByRole('button', { name: 'Dispensar' }).click();
    await tip.waitFor({ state: 'detached' });
    assert.deepEqual(await appState(page, (s) => s.settings.tipsDismissed), ['throttle']);
    // não volta quando chega a próxima lista
    await page.evaluate(() => {
      const app = window.__wrx.app;
      return app.bridge.lastScan().then((ev) => app.store.ingestScan({ ...ev, ts: Date.now(), fresh: false, source: 'cache' }));
    });
    await settle(page);
    assert.equal(await tip.count(), 0);
    assert.ok((await page.locator('.net-row').count()) > 3);
  });
});

test('escritório: lista longa, redes corporativas e de visitantes agrupadas por nome', T, async () => {
  await withApp(env, { params: { ...FAST, world: 'escritorio' } }, async ({ page }) => {
    await ready(page, 2);
    const counts = await appState(page, (s) => ({ nets: s.networks.length, aps: s.aps.length, mesh: s.networks.filter((n) => n.mesh).length }));
    assert.ok(counts.aps >= 8);
    assert.equal(await page.locator('.net-row').count(), counts.nets);
    if (counts.mesh > 0) {
      const multi = page.locator('.net-row', { hasText: /\d+ sinais em \d+ roteadores/ }).first();
      assert.match(await multi.textContent(), /sinais em \d+ roteadores/);
      await multi.click();
      const net = page.locator('.ap-sheet[data-network]');
      await net.waitFor();
      assert.match(await net.locator('.ap-badges').textContent(), /Vários roteadores/);
      assert.ok((await net.locator('.ap-radio').count()) >= 2);
      await shot(page, 'redes-escritorio-rede');
      await back(page);
    }
    await page.click('.seg__opt:has-text("Sinais")');
    await settle(page);
    assert.equal(await page.locator('.net-row').count(), counts.aps);
    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'redes-escritorio');
  });
});

test('trocar de tema redesenha o gráfico com as cores novas', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await ready(page, 2);
    await pump(page, 1);
    await page.click('.net-conn__main');
    await page.locator('.ap-sheet canvas.time-chart').waitFor();
    await page.waitForTimeout(700); // a animação de entrada do traço (só na primeira vez)
    const sample = () =>
      page.evaluate(() => {
        const c = document.querySelector('.ap-sheet canvas.time-chart');
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        // soma do brilho dos pixels opacos (texto e linhas): claro no tema escuro, escuro no claro
        let sum = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 200) {
            sum += data[i] + data[i + 1] + data[i + 2];
            n++;
          }
        }
        return n ? sum / n / 3 : 0;
      });
    const dark = await sample();
    await page.evaluate(() => window.__wrx.app.store.updateSettings({ theme: 'light' }));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await settle(page);
    const light = await sample();
    assert.ok(dark - light > 25, `tema escuro: brilho ${dark.toFixed(0)}; claro: ${light.toFixed(0)}`);
    // e acompanha a largura da tela
    await page.setViewportSize({ width: 360, height: 740 });
    await page.waitForFunction(() => {
      const c = document.querySelector('.ap-sheet canvas.time-chart');
      return c.width === c.clientWidth * 2 && c.clientWidth < 330;
    });
    assert.deepEqual(await horizontalOverflow(page), []);
  });
});

// ---------------------------------------------------------------------------
// Ferramenta: Sinal ao longo do tempo
// ---------------------------------------------------------------------------

test('Sinal ao longo do tempo: a conectada e as mais fortes entram sozinhas; janela, pausa e legenda', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await waitForScans(page, 2);
    await pump(page, 2);
    await goto(page, '/ferramentas/historico');
    assert.equal(await page.textContent('.topbar__title'), 'Sinal no tempo');
    const canvas = page.locator('.hist-chart canvas.time-chart');
    await canvas.waitFor();
    const connected = await appState(page, (s) => s.aps.find((a) => a.connected).bssid);
    const items = page.locator('.hist-item');
    assert.equal(await items.count(), 4);
    assert.equal(await items.first().getAttribute('data-bssid'), connected, 'a rede conectada vem primeiro');
    assert.match(await items.first().textContent(), /Conectado/);
    assert.match(await items.first().locator('.signal__dbm').textContent(), new RegExp(`^${MINUS}\\d+\\s*dBm$`));
    assert.equal(await page.locator('.hist-item .hist-swatch').count(), 4, 'cada linha da legenda com a cor do traço');
    const colours = await page.locator('.hist-item .hist-swatch').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    assert.equal(new Set(colours).size, 4, 'quatro cores diferentes');
    assert.match(await canvas.getAttribute('aria-label'), /Sinal das redes escolhidas/);
    assert.ok((await inked(page, '.hist-chart canvas.time-chart')) > 3000);
    assert.match(await page.textContent('.hist-add'), /4 de 6 no gráfico/);
    assert.match(await page.textContent('.hist-note'), /a cada busca \(cerca de \d+ s\)/);

    // janela de tempo
    assert.match(await page.textContent('.hist-card__head'), /Últimos 2 minutos.*ao vivo/);
    await page.click('.seg__opt:has-text("10 min")');
    assert.match(await page.textContent('.hist-card__head'), /Últimos 10 minutos/);
    await page.click('.seg__opt:has-text("5 min")');
    assert.match(await page.textContent('.hist-card__head'), /Últimos 5 minutos/);

    // pausar congela o desenho; continuar retoma
    const pause = page.locator('.hist-bar .btn');
    assert.equal(await pause.textContent(), 'Pausar');
    await pause.click();
    assert.equal(await pause.textContent(), 'Continuar');
    assert.equal(await pause.getAttribute('aria-pressed'), 'true');
    assert.match(await page.textContent('.hist-card__head'), /pausado às \d\d:\d\d:\d\d/);
    await settle(page);
    const frozen = await canvas.evaluate((c) => c.toDataURL());
    await page.waitForTimeout(2600);
    assert.equal(await canvas.evaluate((c) => c.toDataURL()), frozen, 'pausado: o gráfico não anda');
    await shot(page, 'historico-pausado');
    await pause.click();
    assert.equal(await pause.textContent(), 'Pausar');
    assert.match(await page.textContent('.hist-card__head'), /ao vivo/);
    await page.waitForFunction((img) => document.querySelector('.hist-chart canvas').toDataURL() !== img, frozen, { timeout: 8000 });

    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'historico');
  });
});

test('Sinal ao longo do tempo: pôr e tirar redes (até 6), abrir detalhes, e a escolha sobrevive à troca de tela', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await waitForScans(page, 2);
    await goto(page, '/ferramentas/historico');
    await page.locator('.hist-item').first().waitFor();
    const initial = await page.locator('.hist-item').evaluateAll((els) => els.map((el) => el.dataset.bssid));
    assert.equal(initial.length, 4);

    // tirar pela legenda
    await page.locator('.hist-item').nth(3).getByRole('button', { name: /^Tirar .* do gráfico$/ }).click();
    await settle(page);
    assert.equal(await page.locator('.hist-item').count(), 3);
    assert.match(await page.textContent('.hist-add'), /3 de 6 no gráfico/);

    // painel "adicionar": completa até 6 e barra o sétimo
    await page.click('.hist-add');
    const sheetEl = page.locator('.sheet');
    await sheetEl.waitFor();
    assert.equal(await sheetEl.locator('.sheet__title').textContent(), 'Redes no gráfico');
    assert.equal(await sheetEl.locator('.hist-row[aria-pressed="true"]').count(), 3);
    for (let i = 0; i < 3; i++) await sheetEl.locator('.hist-row[aria-pressed="false"]').first().click();
    assert.equal(await sheetEl.locator('.hist-row[aria-pressed="true"]').count(), 6);
    assert.match(await sheetEl.locator('.hist-note').first().textContent(), /6 redes no gráfico \(no máximo 6\)/);
    assert.ok((await sheetEl.locator('.hist-row[aria-disabled="true"]').count()) >= 1, 'as demais ficam indisponíveis');
    await sheetEl.locator('.hist-row[aria-pressed="false"]').first().click({ force: true });
    await page.locator('.toast').waitFor();
    assert.match(await page.textContent('.toast'), /No máximo 6 redes/);
    assert.equal(await sheetEl.locator('.hist-row[aria-pressed="true"]').count(), 6);
    // o nome hostil aparece na lista como texto
    const hostile = sheetEl.locator('.hist-row .ssid', { hasText: '<img' });
    if (await hostile.count()) assert.equal(await hostile.first().textContent(), HOSTILE);
    // o painel não fecha quando chega uma busca
    await pump(page, 1);
    assert.equal(await sheetEl.count(), 1);
    assert.equal(await sheetEl.locator('.hist-row[aria-pressed="true"]').count(), 6);
    await shot(page, 'historico-escolher');
    await sheetEl.locator('.sheet__footer .btn').click();
    await sheetEl.waitFor({ state: 'detached' });

    const six = await page.locator('.hist-item').evaluateAll((els) => els.map((el) => el.dataset.bssid));
    assert.equal(six.length, 6);
    const colours = await page.locator('.hist-item .hist-swatch').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    assert.equal(new Set(colours).size, 6, 'seis cores diferentes');
    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'historico-6-redes');

    // tocar numa linha da legenda abre os detalhes daquela rede
    await page.locator('.hist-item__main').nth(1).click();
    const detail = page.locator('.ap-sheet[data-bssid]');
    await detail.waitFor();
    assert.equal(await detail.getAttribute('data-bssid'), six[1]);
    await back(page);
    await detail.waitFor({ state: 'detached' });

    // sair e voltar: as mesmas redes, com as mesmas cores
    await goto(page, '/ferramentas');
    await goto(page, '/ferramentas/historico');
    await page.locator('.hist-item').first().waitFor();
    assert.deepEqual(await page.locator('.hist-item').evaluateAll((els) => els.map((el) => el.dataset.bssid)), six);
    assert.deepEqual(await page.locator('.hist-item .hist-swatch').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor)), colours);
    assert.equal(await page.locator('.hist-chart canvas').count(), 1);
    // o "voltar" sobe para Ferramentas
    assert.equal(await back(page), true);
    assert.equal(await page.evaluate(() => location.hash), '#/ferramentas');
  });
});
