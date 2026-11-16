// Ferramentas de rede, de ponta a ponta, contra o simulador: latência (ping), dispositivos na
// rede e teste de velocidade. Cada teste abre o app numa página nova; fechar a página falha o
// teste se houve erro, console.error ou violação de CSP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, withApp, shot, goto, back, settle, simState, simEval, waitForScreen, horizontalOverflow } from './helpers.mjs';

const T = { timeout: 120_000 };
const FAST = { speed: 10 }; // o tempo do simulador corre 10x
const SLOW = { speed: 1 }; // tempo real, para dar tempo de agir no meio de uma medição
const HOSTILE_LAN = '<b onmouseover=alert(3)>tv</b>';
const HOSTILE_SSID = '<img src=x onerror=alert(1)>';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

const text = (page, selector) => page.textContent(selector);
const opsPending = (page) => simEval(page, (sim) => sim.stats().ops);
const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(`wrx.${k}`)), key);
/** Acelera (ou freia) o tempo do simulador no meio de um teste. */
const setSpeed = (page, k) => simEval(page, (sim, value) => sim.setSpeed(value), k);

/** Quantos pixels do canvas foram pintados (para saber que o gráfico desenhou alguma coisa). */
const paintedPixels = (page, selector) =>
  page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    if (!canvas || !canvas.width || !canvas.height) return 0;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n += 1;
    return n;
  }, selector);

/** Valor de um número em destaque pelo rótulo ("Média" -> "4,4 ms"). */
const stat = (page, label) =>
  page.evaluate((wanted) => {
    for (const el of document.querySelectorAll('.stat')) {
      const name = el.querySelector('.stat__label');
      if (name && name.textContent.trim() === wanted) return el.querySelector('.stat__value').textContent;
    }
    return null;
  }, label);

// ---------------------------------------------------------------------------
// Latência
// ---------------------------------------------------------------------------

const pingState = (page, pattern, timeout = 30_000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.tb-run__state')?.textContent || ''), pattern.source, { timeout });
const startPing = (page) => page.click('.tb-setup .btn--primary');

test('latência: mede o roteador e a internet, mostra números, veredito, comparação e a lista da sessão', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/ping' }, async ({ page }) => {
    await page.waitForSelector('.tb-setup');
    assert.equal(await text(page, '.topbar__title'), 'Latência');
    // o roteador vem escolhido, com o endereço que o celular recebeu da rede
    const gateway = await page.evaluate(() => window.__wrx.app.store.get().connection.gateway);
    assert.equal(await page.getAttribute('.tb-setup .chip >> nth=0', 'aria-checked'), 'true');
    assert.match(await text(page, '.tb-note'), new RegExp(gateway.replace(/\./g, '\\.')));
    assert.match(await text(page, '.tb-idle'), /Medir latência/);
    assert.equal(await page.locator('.tb-chartwrap').isHidden(), true, 'sem medição não há gráfico');

    await startPing(page);
    await pingState(page, /Concluído/);
    assert.match(await text(page, '.tb-run__title'), new RegExp(`Roteador · ${gateway.replace(/\./g, '\\.')}`));
    assert.match(await stat(page, 'Média'), /^\d+(,\d)?ms$/);
    assert.match(await stat(page, 'Perda'), /^\d+(,\d)?%$/);
    for (const label of ['Mínimo', 'Máximo', 'Variação']) assert.match(await stat(page, label), /^\d+(,\d)?ms$/, label);
    assert.ok((await paintedPixels(page, '.tb-chart__canvas')) > 2000, 'o gráfico foi desenhado');
    assert.match(await page.getAttribute('.tb-chart__canvas', 'aria-label'), /de 25 recebidas, média de/);
    assert.match(await text(page, '.banner__title'), /Wi-Fi/, 'veredito sobre o Wi-Fi quando o destino é o roteador');
    assert.match(await text(page, '.banner__text'), /Média de \d/);
    assert.match(await text(page, '.tb-legend'), /média \d/);

    // tocar no gráfico mostra a medida daquela barra
    const box = await page.locator('.tb-chart__canvas').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForFunction(() => /Medida \d+ de 25:/.test(document.querySelector('.tb-readout').textContent));
    // e as setas do teclado andam de barra em barra
    const before = await text(page, '.tb-readout');
    await page.focus('.tb-chart__canvas');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((old) => document.querySelector('.tb-readout').textContent !== old, before);

    // segunda medição: a internet; aparecem a comparação e a lista da sessão
    await page.click('.tb-setup .chip:has-text("Internet") >> nth=0');
    assert.match(await text(page, '.tb-note'), /1\.1\.1\.1 · Cloudflare/);
    await startPing(page);
    await pingState(page, /Concluído/);
    assert.match(await text(page, '.tb-run__title'), /Internet · 1\.1\.1\.1/);
    await page.waitForSelector('.banner:has-text("Roteador:")');
    assert.match(await text(page, '.banner:has-text("Roteador:")'), /Roteador: \d.*Internet: \d/);
    const rows = page.locator('.screen .list .row');
    assert.equal(await rows.count(), 2);
    assert.match(await rows.nth(0).textContent(), /Internet · 1\.1\.1\.1.*média.*perda/);
    assert.equal(await rows.nth(0).getAttribute('aria-current'), 'true');
    // tocar numa medição antiga traz o resultado dela de volta
    await rows.nth(1).click();
    await page.waitForFunction(() => /Roteador/.test(document.querySelector('.tb-run__title').textContent));
    assert.equal(await page.getAttribute('.tb-setup .chip >> nth=0', 'aria-checked'), 'true');
    await shot(page, 'tools-b-ping');

    // o painel de ajuda explica os termos
    await page.click('text=Entenda');
    await page.waitForSelector('.sheet');
    assert.match(await text(page, '.sheet'), /Variação \(jitter\)/);
    assert.equal(await back(page), true);
    await page.waitForSelector('.sheet', { state: 'detached' });
    assert.deepEqual(await horizontalOverflow(page), []);
  });
});

test('latência: endereço digitado é conferido antes de ir para o celular', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/ping' }, async ({ page }) => {
    await page.waitForSelector('.tb-setup');
    await page.click('.tb-setup .chip:has-text("Outro")');
    const input = page.locator('.tb-host input');
    // vazio: não começa nada e explica
    await startPing(page);
    await page.waitForSelector('.field__error');
    assert.match(await text(page, '.field__error'), /Digite um site/);
    assert.equal(await page.locator('.tb-run').count(), 0);
    assert.equal(await opsPending(page), 0);
    for (const [typed, message] of [
      ['dois nomes', /espaços/],
      ['-c 5', /hífen/],
      ['1.2.3', /quatro números/],
      ['café.com', /sem acento/],
      ['a;rm -rf', /espaços|não parece/],
    ]) {
      await input.fill(typed);
      await startPing(page);
      await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.field__error')?.textContent || ''), message.source);
      assert.equal(await input.getAttribute('aria-invalid'), 'true', typed);
      assert.equal(await opsPending(page), 0, `"${typed}" não pode chegar ao celular`);
    }
    // endereço de site colado inteiro: vai só o nome
    await input.fill('https://nao-existe.invalid/pagina?x=1');
    await page.waitForFunction(() => /Vamos medir: nao-existe\.invalid/.test(document.querySelector('.field__hint')?.textContent || ''));
    await startPing(page);
    await pingState(page, /Não mediu/);
    assert.match(await text(page, '.tb-result .banner'), /Não encontramos “nao-existe\.invalid”/);
    assert.equal(await page.locator('.tb-chartwrap').isHidden(), true);
    assert.equal(await page.locator('.stat').count(), 0, 'sem medição não há números');
    // um nome que existe, com Enter no campo
    await input.fill('Exemplo.com.br');
    await input.press('Enter');
    await pingState(page, /Concluído/);
    assert.equal(await text(page, '.tb-run__title'), 'exemplo.com.br');
    assert.match(await text(page, '.banner__title'), /chamadas|navegar|travar|perdeu/);
  });
});

test('latência: destino mudo dá 100% de perda, com o gráfico marcando as perdas', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/ping' }, async ({ page }) => {
    await page.waitForSelector('.tb-setup');
    const base = await page.evaluate(() => window.__wrx.app.store.get().connection.gateway.replace(/\.\d+$/, ''));
    await page.click('.tb-setup .chip:has-text("Outro")');
    await page.fill('.tb-host input', `${base}.254`);
    await page.click('.seg__opt:has-text("Curto")');
    await startPing(page);
    await pingState(page, /Concluído/);
    assert.equal(await stat(page, 'Perda'), '100%');
    assert.equal(await stat(page, 'Média'), '—');
    assert.equal(await text(page, '.banner__title'), 'Sem resposta');
    assert.match(await page.getAttribute('.tb-chart__canvas', 'aria-label'), /0 de 10 recebidas, 10 sem resposta/);
    assert.ok((await paintedPixels(page, '.tb-chart__canvas')) > 500, 'as perdas aparecem no gráfico');
    const box = await page.locator('.tb-chart__canvas').boundingBox();
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
    await page.waitForFunction(() => /sem resposta/.test(document.querySelector('.tb-readout').textContent));
  });
});

test('latência: dá para parar no meio; sair da tela cancela e a volta mostra o parcial', T, async () => {
  await withApp(env, { params: SLOW, route: '/ferramentas/ping' }, async ({ page }) => {
    await page.waitForSelector('.tb-setup');
    await page.click('.seg__opt:has-text("Longo")');
    await startPing(page);
    await pingState(page, /\d+ de 50/);
    assert.equal(await page.locator('.tb-setup .chip >> nth=1').isDisabled(), true, 'durante a medição o destino fica travado');
    await page.waitForFunction(() => /^[1-9]/.test(document.querySelector('.tb-run__state').textContent.trim()) && document.querySelectorAll('.stat').length === 5);
    await page.waitForTimeout(900);
    await page.click('.tb-setup .btn:has-text("Parar")');
    await pingState(page, /Interrompido/);
    assert.equal(await opsPending(page), 0, 'o celular parou de medir');
    assert.match(await text(page, '.banner__title'), /medição parcial/);
    const sent = Number((await text(page, '.stat:has-text("Perda") .stat__hint')).match(/(\d+)$/)[1]);
    assert.ok(sent >= 1 && sent < 50, `parcial: ${sent} de 50`);

    // de novo, e desta vez saindo da tela no meio
    await startPing(page);
    await pingState(page, /\d+ de 50/);
    await page.waitForTimeout(700);
    await goto(page, '/ferramentas');
    await page.waitForFunction(() => true);
    assert.equal(await opsPending(page), 0, 'sair da tela cancela a medição');
    await goto(page, '/ferramentas/ping');
    await page.waitForSelector('.tb-run');
    assert.match(await text(page, '.tb-run__state'), /Interrompido/);
    assert.equal(await page.locator('.screen .list .row').count(), 2, 'as duas medições parciais ficaram na sessão');
    // e uma medição nova funciona normalmente depois disso
    await page.click('.seg__opt:has-text("Curto")');
    await startPing(page);
    await pingState(page, /Concluído/);
    assert.equal(await opsPending(page), 0);
  });
});

test('latência: ?host= já abre medindo; tema claro e tela estreita não quebram', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/ping?host=1.0.0.1', viewport: 'small', colorScheme: 'light' }, async ({ page }) => {
    await waitForScreen(page, '/ferramentas/ping');
    await pingState(page, /Concluído/);
    assert.equal(await text(page, '.tb-run__title'), '1.0.0.1');
    assert.equal(await page.inputValue('.tb-host input'), '1.0.0.1');
    assert.equal(await page.getAttribute('.tb-setup .chip:has-text("Outro")', 'aria-checked'), 'true');
    assert.deepEqual(await horizontalOverflow(page), []);
    // trocar de tema com o gráfico na tela: redesenha sem erro
    const light = await paintedPixels(page, '.tb-chart__canvas');
    await page.evaluate(() => window.__wrx.app.store.updateSettings({ theme: 'dark' }));
    await settle(page);
    assert.ok((await paintedPixels(page, '.tb-chart__canvas')) > 0 && light > 0);
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    // o endereço do roteador na URL escolhe o destino "Roteador"
    const gateway = await page.evaluate(() => window.__wrx.app.store.get().connection.gateway);
    await page.evaluate((gw) => {
      location.hash = `#/ferramentas/ping?host=${gw}`;
    }, gateway);
    await page.waitForFunction(() => /Roteador/.test(document.querySelector('.tb-run__title')?.textContent || ''));
    await pingState(page, /Concluído/);
    assert.deepEqual(await horizontalOverflow(page), []);
  });
});

test('latência: sem Wi-Fi conectado o roteador fica indisponível e a escolha passa para a internet', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/ping' }, async ({ page }) => {
    await page.waitForSelector('.tb-setup');
    await page.evaluate(() => window.__wrx.app.store.setConnection({ connected: false }));
    await page.waitForFunction(() => document.querySelector('.tb-setup .chip').disabled === true);
    assert.equal(await page.getAttribute('.tb-setup .chip >> nth=1', 'aria-checked'), 'true');
    assert.match(await text(page, '.tb-note--warn'), /Sem Wi-Fi conectado/);
  });
});

test('latência: respostas atrasadas, repetidas e de outro destino (como o celular de verdade manda)', T, async () => {
  await withApp(env, { params: SLOW, route: '/ferramentas/ping' }, async ({ page }) => {
    await page.waitForSelector('.tb-setup');
    const base = await page.evaluate(() => window.__wrx.app.store.get().connection.gateway.replace(/\.\d+$/, ''));
    const host = `${base}.254`; // ninguém neste endereço: o simulador fica em silêncio até o fim
    await page.click('.tb-setup .chip:has-text("Outro")');
    await page.fill('.tb-host input', host);
    await page.click('.seg__opt:has-text("Longo")');
    // dois toques seguidos contam como um só
    await page.evaluate(() => {
      const go = document.querySelector('.tb-setup .btn--primary');
      go.click();
      go.click();
    });
    await pingState(page, /\d+ de 50/);
    assert.equal(await opsPending(page), 1, 'uma medição só');
    const label = () => page.getAttribute('.tb-chart__canvas', 'aria-label');
    const emit = (events) => page.evaluate((list) => list.forEach((ev) => window.__wrx.app.bridge._emit('ping', ev)), events);

    // o celular repete a série por TCP quando o ping comum fica mudo: as respostas chegam com os
    // mesmos números de sequência, e uma resposta atrasada vale mais que a "perda" já avisada
    await emit([
      { host, seq: 2, ok: false },
      { host, seq: 1, ok: true, ms: 12 },
      { host, seq: 3, ok: true, ms: 15 },
    ]);
    await page.waitForFunction(() => /2 de 50 recebidas/.test(document.querySelector('.tb-chart__canvas').getAttribute('aria-label')));
    assert.match(await label(), /média de 14\sms, 1 sem resposta/);
    assert.equal(await stat(page, 'Perda'), '33%');
    await emit([{ host, seq: 2, ok: true, ms: 13 }]);
    await page.waitForFunction(() => /3 de 50 recebidas/.test(document.querySelector('.tb-chart__canvas').getAttribute('aria-label')));
    assert.equal(await stat(page, 'Perda'), '0%');
    // uma "perda" atrasada não apaga a resposta; lixo e respostas de outro destino são ignorados
    await emit([{ host, seq: 2, ok: false }, { host: '9.9.9.9', seq: 4, ok: true, ms: 1 }, { host, seq: 0, ok: true, ms: 1 }, { host, seq: 99, ok: true, ms: 1 }, { host, seq: 5, ok: true }, null, { host }]);
    await settle(page);
    assert.match(await label(), /3 de 50 recebidas/);
    assert.equal(await stat(page, 'Mínimo'), '12ms');
    assert.equal(await stat(page, 'Máximo'), '15ms');
    await page.click('.tb-setup .btn:has-text("Parar")');
    await pingState(page, /Interrompido/);
    assert.equal(await opsPending(page), 0);
  });
});

// ---------------------------------------------------------------------------
// Dispositivos
// ---------------------------------------------------------------------------

const scanDone = (page, timeout = 40_000) => page.waitForFunction(() => /Conferido/.test(document.querySelector('.tb-sum')?.textContent || ''), null, { timeout });
const deviceRows = (page) => page.locator('.tb-dev');

test('dispositivos: busca sozinha ao abrir e lista roteador, este celular e os demais, com nomes hostis como texto', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/dispositivos' }, async ({ page }) => {
    await page.waitForSelector('.tb-sum');
    assert.equal(await text(page, '.topbar__title'), 'Dispositivos');
    await scanDone(page);
    assert.equal(await opsPending(page), 0);
    const rows = deviceRows(page);
    const count = await rows.count();
    assert.ok(count >= 8, `a casa virtual tem vários aparelhos (${count})`);
    assert.equal(Number(await text(page, '.tb-sum__num')), count, 'o resumo conta o que está na lista');
    assert.match(await text(page, '.tb-sum__label'), /aparelhos na rede /);
    assert.match(await text(page, '.tb-sum'), /informaram o nome · \d+ aparecem? só pelo endereço/);

    // ordem: roteador, este celular, depois por endereço
    const conn = await page.evaluate(() => window.__wrx.app.store.get().connection);
    assert.match(await rows.nth(0).textContent(), /Roteador/);
    assert.ok((await rows.nth(0).textContent()).includes(conn.gateway));
    assert.match(await rows.nth(1).textContent(), /Este celular/);
    assert.ok((await rows.nth(1).textContent()).includes(conn.ip));
    const lastOctets = await rows.evaluateAll((els) => els.slice(2).map((el) => Number(el.querySelector('.row__sub .num').textContent.split('.').pop())));
    assert.deepEqual(lastOctets, [...lastOctets].sort((a, b) => a - b), 'os demais em ordem de endereço');

    // quem não diz o nome aparece como "Aparelho sem nome", só com o IP
    const unnamed = page.locator('.tb-dev:has(.tb-dev__noname)');
    assert.ok((await unnamed.count()) >= 1);
    assert.equal(await unnamed.first().locator('.tb-dev__noname').textContent(), 'Aparelho sem nome');
    // tipo palpitado pelo nome
    assert.match(await page.locator('.tb-dev:has-text("EPSON")').textContent(), /Impressora/);
    assert.match(await page.locator('.tb-dev:has-text("notebook")').textContent(), /Computador/);

    // nome hostil: texto puro, nenhum elemento criado a partir dele
    const hostile = page.locator('.tb-dev .row__title .truncate', { hasText: HOSTILE_LAN });
    assert.equal(await hostile.count(), 1);
    assert.equal(await hostile.textContent(), HOSTILE_LAN);
    assert.equal(await page.locator('.tb-dev b, .tb-dev [onmouseover]').count(), 0);
    // nome comprido: cortado com reticências, sem empurrar a linha para fora
    const long = page.locator('.tb-dev .row__title .truncate', { hasText: 'android-2f9c' });
    assert.equal(await long.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis'), true);
    assert.deepEqual(await horizontalOverflow(page), []);

    // o aviso honesto sobre o MAC está na tela
    assert.match(await text(page, '.tb-facts'), /esconde dos apps o endereço físico/);
    await shot(page, 'tools-b-dispositivos');

    // detalhes de um aparelho e o atalho para medir a latência dele
    await page.locator('.tb-dev:has-text("EPSON")').click();
    await page.waitForSelector('.sheet');
    assert.match(await text(page, '.sheet__title'), /EPSON/);
    assert.match(await text(page, '.sheet__subtitle'), /Parece ser: Impressora/);
    assert.match(await text(page, '.sheet'), /Endereço IP.*Tempo de resposta.*Fabricante.*Não disponível/s);
    const ip = (await text(page, '.sheet .kv__value .num')).trim();
    await page.click('.sheet .btn:has-text("Medir latência")');
    await waitForScreen(page, '/ferramentas/ping');
    await pingState(page, /Concluído/);
    assert.equal(await text(page, '.tb-run__title'), ip);
    assert.match(await text(page, '.banner__title'), /Aparelho|Wi-Fi|Sem resposta/);
  });
});

test('dispositivos: andamento, parar, procurar de novo e fabricante quando o MAC aparece', T, async () => {
  await withApp(env, { params: SLOW, route: '/ferramentas/dispositivos' }, async ({ page }) => {
    await page.waitForSelector('.tb-sum');
    // durante a busca: andamento, contagem ao vivo e o botão de parar
    await page.waitForFunction(() => /Procurando em 254 endereços… \d+%/.test(document.querySelector('.tb-sum')?.textContent || ''));
    assert.match(await text(page, '.tb-sum__label'), /encontrados? até agora/);
    assert.equal(await page.locator('.tb-sum .meter').count(), 1);
    await page.waitForFunction(() => document.querySelectorAll('.tb-dev').length >= 1);

    // um aparelho que deixa ver o MAC (Android antigo): o fabricante entra na linha
    const vendor = await page.evaluate(async () => {
      const { loadOui } = await import('./js/core/oui.js');
      const lookup = await loadOui(new URL('assets/oui.json', location.href).href);
      return lookup.vendor('b8:27:eb:12:34:56');
    });
    assert.ok(vendor && vendor.name, 'a tabela de fabricantes conhece o prefixo de teste');
    const base = await page.evaluate(() => window.__wrx.app.store.get().connection.ip.replace(/\.\d+$/, ''));
    await page.evaluate((b) => {
      const { bridge } = window.__wrx.app;
      bridge._emit('lan', { ip: `${b}.254`, mac: 'B8:27:EB:12:34:56', ms: 6.5 });
      bridge._emit('lan', { ip: `${b}.252`, mac: '02:11:22:33:44:55', ms: 40 });
      bridge._emit('lan', { ip: 'lixo' });
      bridge._emit('lan', null);
    }, base);
    const withMac = page.locator(`.tb-dev:has-text("${base}.254")`);
    await withMac.waitFor();
    assert.ok((await withMac.textContent()).includes(vendor.name), 'fabricante pelo MAC');
    assert.match(await page.locator(`.tb-dev:has-text("${base}.252")`).textContent(), /MAC aleatório/);

    await page.click('.tb-sum .btn:has-text("Parar")');
    await page.waitForFunction(() => /Busca interrompida/.test(document.querySelector('.tb-sum')?.textContent || ''));
    assert.equal(await opsPending(page), 0, 'o celular parou de procurar');
    assert.match(await text(page, '.tb-sum'), /a lista pode estar incompleta/);
    const partial = await deviceRows(page).count();
    assert.ok(partial >= 3);

    // o painel de detalhes mostra o MAC e o fabricante
    await withMac.click();
    await page.waitForSelector('.sheet');
    assert.match(await text(page, '.sheet'), /Endereço físico \(MAC\)\s*b8:27:eb:12:34:56/);
    assert.ok((await text(page, '.sheet')).includes(vendor.name));
    assert.equal(await back(page), true);
    await page.waitForSelector('.sheet', { state: 'detached' });

    // procurar de novo: os da busca anterior ficam apagados até responderem; quem não responde sai
    await setSpeed(page, 20);
    await page.click('.tb-sum .btn:has-text("Procurar de novo")');
    await scanDone(page);
    assert.equal(await page.locator('.tb-dev.row--stale').count(), 0);
    assert.equal(await page.locator(`.tb-dev:has-text("${base}.254")`).count(), 0, 'o aparelho inventado não respondeu à busca completa');
    assert.ok((await deviceRows(page).count()) >= partial - 2);
  });
});

test('dispositivos: sair no meio cancela; voltar recomeça; com a lista pronta, voltar não refaz a busca', T, async () => {
  await withApp(env, { params: SLOW, route: '/ferramentas/dispositivos' }, async ({ page }) => {
    await page.waitForSelector('.tb-sum');
    await page.waitForFunction(() => /Procurando em/.test(document.querySelector('.tb-sum')?.textContent || ''));
    await goto(page, '/ferramentas');
    assert.equal(await opsPending(page), 0, 'sair da tela cancela a busca');
    await setSpeed(page, 20);
    await goto(page, '/ferramentas/dispositivos');
    await scanDone(page);
    const count = await deviceRows(page).count();
    assert.ok(count >= 8);

    // com a lista pronta e recente: sair e voltar mostra a mesma lista, sem buscar de novo
    await goto(page, '/ferramentas');
    await goto(page, '/ferramentas/dispositivos');
    await page.waitForSelector('.tb-dev');
    assert.match(await text(page, '.tb-sum'), /Conferido/);
    assert.equal(await page.locator('.tb-sum .btn:has-text("Parar")').count(), 0);
    assert.equal(await deviceRows(page).count(), count);
    assert.equal(await opsPending(page), 0);
  });
});

test('dispositivos: fora do Wi-Fi explica o que falta; ao reconectar busca de novo; tema claro e 360 px', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/dispositivos', viewport: 'small', colorScheme: 'light' }, async ({ page }) => {
    await scanDone(page);
    assert.deepEqual(await horizontalOverflow(page), []);
    const conn = await page.evaluate(() => window.__wrx.app.store.get().connection);
    await page.evaluate(() => window.__wrx.app.store.setConnection({ connected: false }));
    await page.waitForSelector('.empty__title');
    assert.equal(await text(page, '.empty__title'), 'Conecte-se a um Wi-Fi');
    assert.equal(await deviceRows(page).count(), 0);
    await page.click('.empty .btn');
    await page.waitForSelector('.toast');
    assert.match(await text(page, '.toast'), /demonstração/);
    // voltou a conexão: a busca recomeça sozinha
    await page.evaluate((c) => window.__wrx.app.store.setConnection(c), conn);
    await scanDone(page);
    assert.ok((await deviceRows(page).count()) >= 8);
    await shot(page, 'tools-b-dispositivos-claro-360');
  });
});

test('dispositivos: o Wi-Fi cai no meio da busca e volta', T, async () => {
  await withApp(env, { params: { speed: 2 }, route: '/ferramentas/dispositivos' }, async ({ page }) => {
    await page.waitForFunction(() => document.querySelectorAll('.tb-dev').length >= 1);
    await simState(page, { wifi: false });
    await page.waitForFunction(() => window.__wrx.app.store.get().connection?.connected === false);
    assert.equal(await opsPending(page), 0);
    await setSpeed(page, 20);
    await simState(page, { wifi: true });
    await page.waitForFunction(() => window.__wrx.app.store.get().connection?.connected === true, null, { timeout: 20_000 });
    await scanDone(page);
    assert.ok((await deviceRows(page).count()) >= 8, 'a lista é a da busca nova, completa');
    assert.equal(await page.locator('.tb-dev.row--stale').count(), 0);
  });
});

// ---------------------------------------------------------------------------
// Velocidade
// ---------------------------------------------------------------------------

const tile = (page, key) => page.textContent(`[data-tile="${key}"] .stat__value`);
const speedDone = (page, timeout = 60_000) => page.waitForFunction(() => /Resultado/.test(document.querySelector('.tb-hero .tb-run__title')?.textContent || ''), null, { timeout });
const speedPhase = (page, word, timeout = 30_000) => page.waitForFunction((w) => (document.querySelector('.tb-hero .tb-caption')?.textContent || '').includes(w), word, { timeout });

// No navegador quem mede é sempre o simulador: os resultados ficam na lista da demonstração
// ("wrx.speed.history.demo"), nunca na dos testes do celular de verdade ("wrx.speed.history").
const OLD_TESTS = [
  { ts: Date.now() - 86_400_000, mode: 'full', downMbps: 271.4, upMbps: 138.2, latencyMs: 14.2, jitterMs: 1.4, bytesDown: 268e6, bytesUp: 137e6, server: 'GRU', ssid: 'CasaDaAna', linkMbps: 866 },
  { ts: Date.now() - 3 * 86_400_000, mode: 'light', downMbps: 48.3, upMbps: 22.9, latencyMs: 21.5, jitterMs: 6.1, bytesDown: 18e6, bytesUp: 8.6e6, server: 'GIG', ssid: HOSTILE_SSID, linkMbps: 86.7 },
];

test('velocidade: antes do primeiro teste a tela diz com quem fala e quanto gasta; depois mede e guarda', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/velocidade' }, async ({ page }) => {
    await page.waitForSelector('.tb-intro');
    assert.equal(await text(page, '.topbar__title'), 'Velocidade');
    const intro = await text(page, '.tb-intro');
    assert.match(intro, /Cloudflare/);
    assert.match(intro, /speed\.cloudflare\.com/);
    assert.match(intro, /só quando você pede/);
    assert.doesNotMatch(intro, /única função/, 'o teste de latência também usa a internet: a tela não afirma o contrário');
    assert.match(intro, /Nunca usa os dados móveis/);
    assert.match(intro, /para cada Mb\/s, em cada direção \(num plano de 300\sMb\/s de download e 150 de upload, ≈\s450\sMB\)/);
    assert.match(intro, /Leve: até cerca de 35\sMB/);
    assert.equal(await page.getAttribute('.seg__opt:has-text("Completo")', 'aria-checked'), 'true');
    assert.equal(await page.locator('.gauge').count(), 0, 'sem teste ainda não há mostrador vazio');
    assert.equal(await stored(page, 'speed.history.demo'), null);
    assert.equal(await opsPending(page), 0, 'nada começa sem a pessoa pedir');

    await page.click('.tb-intro .btn--primary');
    await page.waitForSelector('.tb-hero .gauge');
    assert.match(await text(page, '.tb-hero .tb-run__title'), /Teste completo/);
    assert.equal(await page.locator('.tb-hero .btn:has-text("Cancelar")').count(), 1);
    await speedPhase(page, 'download');
    assert.match(await text(page, '.tb-hero .tb-caption'), /2 de 3 · Medindo o download/);
    assert.equal(await page.locator('[data-tile="download"].tb-tile--active').count(), 1);
    assert.equal(await page.getAttribute('.gauge', 'role'), 'meter');
    await speedPhase(page, 'upload');
    assert.match(await tile(page, 'download'), /^\d+(,\d)?\s?[MG]b\/s$/, 'o download já tem número enquanto o upload roda');
    // um aviso atrasado da fase anterior (ou sem pé nem cabeça) não bagunça a tela
    const downloadSoFar = await tile(page, 'download');
    await page.evaluate(() => {
      const { bridge } = window.__wrx.app;
      bridge._emit('speed', { phase: 'download', progress: 0.5, mbps: 9999, bytes: 1 });
      bridge._emit('speed', { phase: 'voo', progress: 2, mbps: -5 });
      bridge._emit('speed', null);
    });
    await settle(page);
    assert.equal(await tile(page, 'download'), downloadSoFar);
    assert.match(await text(page, '.tb-hero .tb-caption'), /3 de 3 · Medindo o upload/);
    await speedDone(page);
    assert.equal(await opsPending(page), 0);

    for (const key of ['download', 'upload']) assert.match(await tile(page, key), /^\d+(,\d)?\s?[MG]b\/s$/, key);
    for (const key of ['latency', 'jitter']) assert.match(await tile(page, key), /^\d+(,\d)?ms$/, key);
    assert.match(await page.getAttribute('.gauge', 'aria-valuetext'), /Mb\/s, Download/);
    assert.match(await text(page, '.banner__title'), /Internet|Boa para/);
    // Wi-Fi ou plano?
    const versus = page.locator('.banner:has-text("Wi-Fi aguenta")');
    assert.equal(await versus.count(), 1);
    assert.match(await versus.textContent(), /Aqui o seu Wi-Fi aguenta ≈\s?\d.*a internet entregou \d.*Estimativa/s);
    // detalhes: dados usados, servidor, rede
    const details = await text(page, '.kv');
    assert.match(details, /Dados usados\s*\d+(,\d+)?\s?[MG]B.*download.*upload/s);
    assert.match(details, /Servidor\s*São Paulo \(GRU\)\s*Cloudflare/);
    assert.match(details, /Tipo de teste\s*Completo/);
    assert.match(details, /Rede/);
    await shot(page, 'tools-b-velocidade');

    // guardado no aparelho
    const history = await stored(page, 'speed.history.demo');
    assert.equal(history.length, 1);
    assert.equal(history[0].mode, 'full');
    assert.ok(history[0].downMbps > 1 && history[0].upMbps > 1 && history[0].bytesDown > 1e6);
    assert.equal(history[0].server, 'GRU');
    assert.ok(history[0].linkMbps > 0, 'a velocidade do link Wi-Fi foi anotada');
    assert.deepEqual(await horizontalOverflow(page), []);

    // recarregar: o último resultado continua lá e a apresentação inicial não volta
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await page.waitForSelector('.tb-hero');
    assert.equal(await page.locator('.tb-intro').count(), 0);
    assert.match(await text(page, '.tb-hero .tb-run__title'), /Último teste/);
    assert.match(await tile(page, 'download'), /^\d+(,\d)?\s?[MG]b\/s$/);
    assert.match(await text(page, '.tb-foot'), /Cloudflare/);
    await page.click('.tb-foot .tb-link');
    await page.waitForSelector('.sheet');
    assert.match(await text(page, '.sheet'), /speed\.cloudflare\.com.*endereço IP.*franquia/s);
  });
});

test('velocidade: teste leve gasta pouco e a escolha fica guardada', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/velocidade' }, async ({ page }) => {
    await page.waitForSelector('.tb-intro');
    await page.click('.seg__opt:has-text("Leve")');
    await page.waitForFunction(() => /até cerca de 35/.test(document.querySelector('.tb-duration .tb-caption').textContent));
    assert.equal(await stored(page, 'speed.mode'), 'light');
    await page.click('.tb-intro .btn--primary');
    await page.waitForSelector('.tb-hero');
    assert.match(await text(page, '.tb-hero .tb-run__title'), /Teste leve/);
    await speedDone(page);
    const [record] = await stored(page, 'speed.history.demo');
    assert.equal(record.mode, 'light');
    assert.ok(record.bytesDown + record.bytesUp < 80e6, `o teste leve usou ${Math.round((record.bytesDown + record.bytesUp) / 1e6)} MB`);
    assert.match(await text(page, '.kv'), /Tipo de teste\s*Leve/);
    assert.equal(await page.getAttribute('.seg__opt:has-text("Leve")', 'aria-checked'), 'true');
    // depois de um teste, a estimativa do completo usa a velocidade medida
    await page.click('.seg__opt:has-text("Completo")');
    await page.waitForFunction(() => /Deve usar ≈\s?\d+.*pela última medição/.test(document.querySelector('.tb-duration .tb-caption').textContent));
  });
});

test('velocidade: cancelar no meio não guarda resultado; sair da tela cancela o teste', T, async () => {
  await withApp(env, { params: SLOW, route: '/ferramentas/velocidade' }, async ({ page }) => {
    await page.waitForSelector('.tb-intro');
    await page.click('.tb-intro .btn--primary');
    await speedPhase(page, 'download');
    await page.waitForTimeout(800);
    await page.click('.tb-hero .btn:has-text("Cancelar")');
    await page.waitForFunction(() => /Teste cancelado/.test(document.querySelector('.tb-hero .tb-run__title')?.textContent || ''));
    assert.equal(await opsPending(page), 0, 'o celular parou o teste');
    assert.equal(await stored(page, 'speed.history.demo'), null, 'teste cancelado não entra no histórico');
    assert.equal(await tile(page, 'download'), '—', 'fase interrompida não vira resultado');
    assert.match(await tile(page, 'latency'), /ms$/, 'a fase que terminou continua valendo');
    assert.match(await text(page, '.banner'), /Resultado incompleto.*o teste usou \d/s);

    // de novo, saindo da tela no meio
    await page.click('.tb-hero .btn--primary');
    await speedPhase(page, 'download');
    await goto(page, '/ferramentas');
    assert.equal(await opsPending(page), 0, 'sair da tela cancela o teste');
    await goto(page, '/ferramentas/velocidade');
    await page.waitForSelector('.tb-hero');
    assert.match(await text(page, '.banner'), /O teste parou quando você saiu da tela/);
    assert.equal(await stored(page, 'speed.history.demo'), null);

    // e um teste inteiro funciona depois disso
    await setSpeed(page, 20);
    await page.click('.seg__opt:has-text("Leve")');
    await page.click('.tb-hero .btn--primary');
    await speedDone(page);
    assert.equal((await stored(page, 'speed.history.demo')).length, 1);
  });
});

test('velocidade: a internet cai no meio do teste', T, async () => {
  await withApp(env, { params: { speed: 2 }, route: '/ferramentas/velocidade' }, async ({ page }) => {
    await page.waitForSelector('.tb-intro');
    await page.click('.tb-intro .btn--primary');
    await speedPhase(page, 'download');
    await simState(page, { wifi: false });
    await page.waitForFunction(() => window.__wrx.app.store.get().connection?.connected === false);
    assert.equal(await opsPending(page), 0);
    await setSpeed(page, 20);
    await simState(page, { wifi: true });
    await page.waitForFunction(() => window.__wrx.app.store.get().connection?.connected === true, null, { timeout: 20_000 });
    await page.waitForSelector('.banner:has-text("Sem acesso à internet")');
    assert.match(await text(page, '.tb-hero .tb-run__title'), /O teste não terminou/);
    assert.equal(await stored(page, 'speed.history.demo'), null);
    // "tentar de novo" roda um teste inteiro
    await page.click('.banner .btn:has-text("Tentar de novo")');
    await speedDone(page);
  });
});

test('velocidade: histórico guardado (com nome de rede hostil), teste antigo na tela e apagar tudo', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/velocidade', storage: { 'speed.history.demo': [...OLD_TESTS, { lixo: true }, null] } }, async ({ page }) => {
    await page.waitForSelector('.tb-hero');
    assert.match(await text(page, '.tb-hero .tb-run__title'), /Último teste/);
    assert.match(await text(page, '.tb-hero .tb-run__state'), /ontem, \d\d:\d\d/);
    assert.equal((await tile(page, 'download')).replace(/\s/g, ''), '271Mb/s');
    assert.match(await text(page, '.banner:has-text("Wi-Fi aguenta")'), /limite é a internet/);
    const rows = page.locator('.screen .list .row');
    assert.equal(await rows.count(), 2, 'os registros inválidos ficam de fora');
    // nome de rede hostil: texto, sem virar elemento
    assert.equal(await rows.nth(1).locator('.ssid').textContent(), HOSTILE_SSID);
    assert.equal(await page.locator('.screen img, .screen [onerror]').count(), 0);
    assert.match(await rows.nth(1).textContent(), /Leve/);

    // tocar num teste antigo mostra os números dele
    await rows.nth(1).click();
    await page.waitForFunction(() => /Teste anterior/.test(document.querySelector('.tb-hero .tb-run__title').textContent));
    assert.equal((await tile(page, 'download')).replace(/\s/g, ''), '48Mb/s');
    assert.match(await text(page, '.banner:has-text("Wi-Fi aguenta")'), /O limite aqui é o Wi-Fi/);
    assert.match(await text(page, '.kv'), /Rio de Janeiro \(GIG\)/);
    assert.equal(await page.locator('.kv .ssid').textContent(), HOSTILE_SSID);
    assert.deepEqual(await horizontalOverflow(page), []);

    // um teste novo entra no topo da lista
    await page.click('.tb-hero .btn--primary');
    await speedDone(page);
    assert.equal(await page.locator('.screen .list .row').count(), 3);
    assert.equal(await page.locator('.screen .list .row').nth(0).getAttribute('aria-current'), 'true');

    // apagar: pergunta antes; depois a tela volta à apresentação inicial
    await page.click('.section-h .btn:has-text("Apagar")');
    await page.waitForSelector('.dialog');
    await page.click('.dialog .btn--quiet');
    await page.waitForSelector('.dialog', { state: 'detached' });
    assert.equal((await stored(page, 'speed.history.demo')).length, 3, 'cancelar a pergunta não apaga nada');
    await page.click('.section-h .btn:has-text("Apagar")');
    await page.click('.dialog .btn--danger');
    await page.waitForSelector('.tb-intro');
    assert.equal(await stored(page, 'speed.history.demo'), null);
    assert.equal(await page.locator('.gauge').count(), 0);
  });
});

test('velocidade: Wi-Fi com franquia sugere o teste leve; sem Wi-Fi não deixa começar; tema claro e 360 px', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/velocidade', viewport: 'small', colorScheme: 'light', storage: { 'speed.history.demo': OLD_TESTS } }, async ({ page }) => {
    await page.waitForSelector('.tb-hero .gauge');
    assert.deepEqual(await horizontalOverflow(page), []);
    assert.equal(await page.getAttribute('.seg__opt:has-text("Completo")', 'aria-checked'), 'true');
    await page.evaluate(() => {
      const { store } = window.__wrx.app;
      store.setConnection({ ...store.get().connection, metered: true });
    });
    await page.waitForSelector('.banner:has-text("limite de dados")');
    assert.equal(await page.getAttribute('.seg__opt:has-text("Leve")', 'aria-checked'), 'true', 'num Wi-Fi limitado o padrão é o teste leve');
    await shot(page, 'tools-b-velocidade-claro-360');

    await page.evaluate(() => window.__wrx.app.store.setConnection({ connected: false }));
    await page.waitForSelector('.banner:has-text("Conecte-se a um Wi-Fi para testar")');
    assert.equal(await page.locator('.tb-hero .btn--primary').isDisabled(), true);
    assert.deepEqual(await horizontalOverflow(page), []);
    assert.equal(await opsPending(page), 0);
  });
});
