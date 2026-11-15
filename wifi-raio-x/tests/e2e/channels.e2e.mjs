// Tela Canais, de ponta a ponta, contra o simulador: faixas, gráfico (toque, zoom, gestos),
// recomendação, largura, ranking, painéis, rota com destaque, estados e atualização ao vivo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startEnv, withApp, shot, goto, back, settle, appState, waitForScans, horizontalOverflow } from './helpers.mjs';

const T = { timeout: 120_000 };
// o tempo do simulador corre 10x e a pessoa virtual fica parada (sem trocar de ponto de acesso)
const FAST = { speed: 10, walk: 'still' };
const HOSTILE = '<img src=x onerror=alert(1)>';
const HOSTILE_BSSID = 'b0:95:75:13:37:00';
// casa "apartamento": o celular está no 5 GHz do roteador VIVOFIBRA; o rádio de 2,4 GHz é do mesmo aparelho
const OWN_24 = 'cc:d4:a1:3c:0e:00';
const OWN_5 = 'cc:d4:a1:3c:0e:04';
const NEIGHBOUR_5 = '28:6c:07:c0:ff:e1';
// o painel completo de detalhes é de outra tela; sem ele a tela Canais abre um resumo próprio
const HAS_DETAIL = existsSync(fileURLToPath(new URL('../../app/js/ui/ap-detail.js', import.meta.url)));
const DETAIL_ALLOW = HAS_DETAIL ? [] : [/ap-detail\.js/];

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

const open = (options, fn) => withApp(env, { ...options, params: { ...FAST, ...(options.params || {}) }, allow: [...DETAIL_ALLOW, ...(options.allow || [])] }, fn);

/** Espera a tela Canais com dados (a parte principal à vista e o gráfico desenhado). */
async function ready(page, scans = 2) {
  await waitForScans(page, scans);
  await page.waitForSelector('.ch-main:not([hidden]) .chgraph canvas');
  await page.waitForFunction(() => document.querySelector('.chgraph').__graph.inspect().shapes > 0);
  await settle(page);
}

const inspect = (page) => page.evaluate(() => document.querySelector('.chgraph').__graph.inspect());
const zoomInfo = (page) => page.evaluate(() => document.querySelector('.chgraph').__graph.getZoom());
const checkedBand = (page) => page.getAttribute('.ch-band[aria-checked="true"]', 'data-band');
const selected = (page) => page.evaluate(() => document.querySelector('.ch-sel')?.dataset.bssid ?? null);

/** Toca dentro da forma de uma rede. Se o toque cair numa rede empilhada, toca de novo (o toque repetido passa para a de baixo). */
async function selectShape(page, bssid) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const point = await page.evaluate((id) => {
      const host = document.querySelector('.chgraph');
      const p = host.__graph.locate(id);
      const r = host.getBoundingClientRect();
      return p ? { x: r.left + p.x, y: r.top + p.y } : null;
    }, bssid);
    assert.ok(point, `a rede ${bssid} está desenhada`);
    await page.touchscreen.tap(point.x, point.y);
    await settle(page);
    if ((await selected(page)) === bssid) return;
  }
  assert.fail(`não foi possível escolher ${bssid} no gráfico`);
}

/** Dispara eventos de ponteiro no canvas (coordenadas a partir do canto do gráfico). */
async function pointers(page, steps) {
  await page.evaluate((list) => {
    const canvas = document.querySelector('.chgraph canvas');
    const rect = canvas.getBoundingClientRect();
    for (const [type, id, x, y] of list) {
      canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: rect.left + x, clientY: rect.top + y, bubbles: true, cancelable: true }));
    }
  }, steps);
  await settle(page);
}

// ---------------------------------------------------------------------------
// Abertura
// ---------------------------------------------------------------------------

test('abre em 2,4 GHz: três faixas, gráfico desenhado, recomendação e ranking coerentes com o store', T, async () => {
  await open({ route: '/canais' }, async ({ page }) => {
    await ready(page);
    assert.equal(await page.textContent('.topbar__title'), 'Canais');

    // faixas: 2,4 escolhida, 5 disponível, 6 sem redes (com o motivo escrito)
    const bands = await page.$$eval('.ch-band', (els) => els.map((el) => ({ band: el.dataset.band, on: el.getAttribute('aria-checked'), off: el.getAttribute('aria-disabled'), sub: el.querySelector('.ch-band__sub').textContent, label: el.getAttribute('aria-label') })));
    assert.deepEqual(bands.map((b) => b.band), ['2.4', '5', '6']);
    assert.deepEqual(bands.map((b) => b.on), ['true', 'false', 'false']);
    assert.equal(bands[2].off, 'true');
    assert.equal(bands[2].sub, 'nenhuma rede');
    assert.match(bands[2].label, /Nenhuma rede de 6.GHz por perto/);
    const counts = await appState(page, (s) => ({ b24: s.aps.filter((a) => a.band === '2.4').length, b5: s.aps.filter((a) => a.band === '5').length, own: [...s.own] }));
    assert.match(bands[0].sub, new RegExp(`^${counts.b24} redes?$`));
    assert.match(bands[1].sub, new RegExp(`^${counts.b5} redes?$`));

    // gráfico: uma forma por rede, as do usuário marcadas, eixo de 1 a 13 sem interrupção
    const g = await inspect(page);
    assert.equal(g.band, '2.4');
    assert.equal(g.shapes, counts.b24);
    assert.deepEqual([...g.own].sort(), [...counts.own].sort());
    assert.ok(g.own.includes(OWN_24), 'o rádio de 2,4 GHz do roteador conectado é "da casa"');
    for (const ch of [1, 6, 11]) assert.ok(g.ticks.includes(ch), `canal ${ch} no eixo`);
    assert.equal(g.breaks, 0);
    assert.equal(g.zoom, 1);
    assert.ok(g.labels.length >= 3, 'as redes mais fortes têm nome');
    assert.ok(g.labels.some((l) => l.bssid === OWN_24), 'a rede do usuário tem nome');
    // nenhum nome cobre outro
    for (let i = 0; i < g.labels.length; i++) {
      for (let j = i + 1; j < g.labels.length; j++) {
        const a = g.labels[i];
        const b = g.labels[j];
        assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `"${a.text}" cobre "${b.text}"`);
      }
    }
    // canvas na densidade da tela
    const canvas = await page.$eval('.chgraph canvas', (c) => ({ w: c.width, cw: c.clientWidth, h: c.height, ch: c.clientHeight, label: c.getAttribute('aria-label') }));
    assert.equal(canvas.w, canvas.cw * 2);
    assert.equal(canvas.h, canvas.ch * 2);
    assert.match(canvas.label, /Gráfico de canais de 2,4 GHz: \d+ redes/);
    assert.equal(await page.locator('.ch-chart .sr-only li').count(), counts.b24, 'há uma lista equivalente para leitor de tela');

    // recomendação para o roteador do usuário
    const verdict = await page.getAttribute('.ch-rec', 'data-verdict');
    assert.ok(['keep', 'change'].includes(verdict), `veredito: ${verdict}`);
    assert.match(await page.textContent('.ch-rec__title'), /canal \d+/);
    assert.match(await page.textContent('.ch-rec__text'), /^Seu roteador está no canal 6/);
    assert.equal(await page.textContent('.ch-own .ssid'), 'VIVOFIBRA-8F3C');
    assert.match(await page.textContent('.ch-own__label'), /Seu roteador · canal 6 · 20.MHz/);
    assert.match(await page.textContent('.ch-rec__caveat'), /Estimativa/);
    assert.equal(await page.locator('.ch-width').count(), 0, 'em 2,4 GHz não há seletor de largura');

    // ranking: 1, 6 e 11 à vista, com nota de 0 a 100; o canal do usuário marcado
    const rows = await page.$$eval('.ch-rank:not(.ch-rank--others) .ch-rank__row', (els) =>
      els.map((el) => ({ channel: Number(el.dataset.channel), score: Number(el.querySelector('.ch-rank__score').textContent), bar: Number(el.querySelector('.ch-bar').getAttribute('aria-valuenow')), tags: [...el.querySelectorAll('.badge')].map((b) => b.textContent), facts: el.querySelector('.ch-rank__facts').textContent })),
    );
    assert.deepEqual(rows.map((r) => r.channel).sort((a, b) => a - b), [1, 6, 11]);
    for (const r of rows) {
      assert.ok(r.score >= 0 && r.score <= 100, `nota do canal ${r.channel}: ${r.score}`);
      assert.equal(r.bar, r.score);
      assert.match(r.facts, /^(Livre|Tranquilo|Disputado|Cheio|Congestionado) · /);
    }
    assert.deepEqual(rows.filter((r) => r.tags.includes('Seu canal')).map((r) => r.channel), [6]);
    assert.equal(rows.filter((r) => r.tags.includes('Melhor') || r.tags.includes('Recomendado')).length, 1);
    assert.match(await page.textContent('.ch-more .btn'), /Mostrar os outros 10 canais/);

    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'canais-24');

    // faixa sem redes: não troca, e diz por quê
    await page.locator('.ch-band[data-band="6"]').click({ force: true });
    await page.locator('.toast').waitFor();
    assert.match(await page.textContent('.toast'), /Nenhuma rede de 6.GHz por perto agora/);
    assert.equal(await checkedBand(page), '2.4');
  });
});

// ---------------------------------------------------------------------------
// Gráfico: toque, destaque, detalhes
// ---------------------------------------------------------------------------

test('tocar numa rede mostra quem é (nome hostil só como texto) e leva aos detalhes', T, async () => {
  await open({ route: '/canais' }, async ({ page }) => {
    await ready(page);
    assert.equal(await selected(page), null);
    assert.match(await page.textContent('.ch-legend'), /Sua rede.*Vizinhos.*Toque numa rede/s);

    await selectShape(page, HOSTILE_BSSID);
    assert.equal(await page.textContent('.ch-sel .ssid'), HOSTILE, 'o nome aparece inteiro, como texto');
    assert.equal(await page.locator('.screen img, .screen script').count(), 0, 'nenhum elemento nasceu do nome da rede');
    assert.match(await page.textContent('.ch-sel .row__sub'), /Canal 9.*20.MHz.*−\d+.dBm/s);
    const g = await inspect(page);
    assert.equal(g.highlight, HOSTILE_BSSID);
    const label = g.labels.find((l) => l.bssid === HOSTILE_BSSID);
    assert.ok(label && label.text.startsWith('<img'), 'a rede em destaque sempre tem nome no gráfico');
    assert.ok(g.ticks.includes(9), 'o canal dela ganha número no eixo');
    await shot(page, 'canais-destaque-nome-hostil');

    // o cartão abre os detalhes da rede
    await page.click('.ch-sel .row');
    await page.locator('.sheet').waitFor();
    assert.ok((await page.textContent('.sheet')).includes(HOSTILE));
    assert.equal(await page.locator('.sheet img').count(), 0);
    assert.equal(await back(page), true, 'o voltar fecha o painel');
    await page.locator('.sheet').waitFor({ state: 'detached' });
    assert.equal(await selected(page), HOSTILE_BSSID, 'o destaque continua depois de fechar o painel');

    // tirar o destaque pelo botão
    await page.click('button[aria-label="Tirar o destaque"]');
    assert.equal(await selected(page), null);
    assert.equal((await inspect(page)).highlight, null);

    // a rede do usuário, e depois um toque fora de qualquer forma
    await selectShape(page, OWN_24);
    assert.equal(await page.textContent('.ch-sel .ssid'), 'VIVOFIBRA-8F3C');
    assert.equal(await page.locator('.ch-sel [aria-label="Sua rede"]').count(), 1);
    const empty = await page.evaluate(() => {
      const host = document.querySelector('.chgraph');
      const { plot } = host.__graph.inspect();
      const r = host.getBoundingClientRect();
      return { x: r.left + plot.right - 4, y: r.top + plot.top + 3 };
    });
    await page.touchscreen.tap(empty.x, empty.y);
    await settle(page);
    assert.equal(await selected(page), null, 'tocar no vazio tira o destaque');
  });
});

test('zoom pelos botões, pinça, arrastar e teclado', T, async () => {
  await open({ route: '/canais' }, async ({ page }) => {
    await ready(page);
    const zoomIn = page.locator('button[aria-label="Aumentar o zoom do gráfico"]');
    const zoomOut = page.locator('button[aria-label="Diminuir o zoom do gráfico"]');
    assert.equal(await zoomOut.isDisabled(), true);
    assert.equal(await zoomIn.isDisabled(), false);

    await zoomIn.click();
    await settle(page);
    let z = await zoomInfo(page);
    assert.ok(z.zoom > 1.4 && z.zoom <= z.max, `zoom depois de um toque: ${z.zoom}`);
    assert.equal(await zoomOut.isDisabled(), false);
    const zoomed = await inspect(page);
    assert.ok(zoomed.ticks.length < 13, 'ampliado, só parte dos canais está à vista');
    assert.ok(zoomed.scroll > 0, 'o zoom dos botões abre a partir do meio');
    await shot(page, 'canais-zoom');

    // arrastar para a direita mostra o começo da faixa
    await pointers(page, [['pointerdown', 1, 120, 120], ['pointermove', 1, 180, 122], ['pointermove', 1, 300, 124], ['pointerup', 1, 300, 124]]);
    const panned = await inspect(page);
    assert.ok(panned.scroll < zoomed.scroll, `rolagem ${zoomed.scroll} -> ${panned.scroll}`);
    assert.equal(panned.highlight, null, 'arrastar não escolhe rede');

    // até o máximo e de volta
    for (let i = 0; i < 6 && !(await zoomIn.isDisabled()); i++) await zoomIn.click();
    z = await zoomInfo(page);
    assert.equal(z.zoom, z.max);
    assert.equal(z.canZoomIn, false);
    for (let i = 0; i < 8 && !(await zoomOut.isDisabled()); i++) await zoomOut.click();
    assert.equal((await zoomInfo(page)).zoom, 1);
    assert.equal((await inspect(page)).ticks.length, 13);

    // pinça com dois dedos
    await pointers(page, [['pointerdown', 1, 150, 120], ['pointerdown', 2, 190, 120], ['pointermove', 1, 120, 120], ['pointermove', 2, 220, 120], ['pointerup', 1, 120, 120], ['pointerup', 2, 220, 120]]);
    z = await zoomInfo(page);
    assert.ok(z.zoom > 1.5, `zoom depois da pinça: ${z.zoom}`);
    assert.equal((await inspect(page)).highlight, null, 'a pinça não escolhe rede');
    await pointers(page, [['pointerdown', 1, 120, 120], ['pointerdown', 2, 220, 120], ['pointermove', 1, 160, 120], ['pointermove', 2, 175, 120], ['pointerup', 1, 160, 120], ['pointerup', 2, 175, 120]]);
    assert.equal((await zoomInfo(page)).zoom, 1, 'fechar a pinça volta ao gráfico inteiro');

    // teclado: setas percorrem as redes, Esc tira o destaque, + e - mexem no zoom
    await page.focus('.chgraph canvas');
    await page.keyboard.press('ArrowRight');
    await settle(page);
    const first = await selected(page);
    assert.ok(first, 'a seta escolhe uma rede');
    await page.keyboard.press('ArrowRight');
    await settle(page);
    assert.notEqual(await selected(page), first);
    await page.keyboard.press('ArrowLeft');
    await settle(page);
    assert.equal(await selected(page), first);
    await page.keyboard.press('Escape');
    await settle(page);
    assert.equal(await selected(page), null);
    await page.keyboard.press('+');
    await settle(page);
    assert.ok((await zoomInfo(page)).zoom > 1);
    await page.keyboard.press('-');
    await settle(page);
    assert.equal((await zoomInfo(page)).zoom, 1);
  });
});

// ---------------------------------------------------------------------------
// Atualização ao vivo
// ---------------------------------------------------------------------------

test('as varreduras chegam sem mexer no zoom, no destaque, na rolagem nem no painel aberto', T, async () => {
  await open({ route: '/canais' }, async ({ page }) => {
    await ready(page);
    await selectShape(page, OWN_24);
    await page.click('button[aria-label="Aumentar o zoom do gráfico"]');
    await settle(page);
    const before = await inspect(page);
    await page.evaluate(() => {
      document.querySelector('.chgraph canvas').__mark = 'mesmo';
      document.querySelector('.ch-rank__row[data-channel="6"]').__mark = 'mesma';
      document.querySelector('.view').scrollTop = 420;
    });
    await settle(page);

    await page.click('.ch-rank__row[data-channel="6"]');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.textContent('.sheet__title'), 'Canal 6');
    assert.match(await page.textContent('.sheet'), /Por que essa nota/);
    // (o clique do teste pode ter rolado um pouco mais para alcançar a linha: vale a posição de agora)
    const top = await page.evaluate(() => document.querySelector('.view').scrollTop);
    assert.ok(top > 200, 'a tela rolou');

    const seq = await appState(page, (s) => s.scan.seq);
    await waitForScans(page, seq + 3);
    await settle(page);

    assert.equal(await page.locator('.sheet').count(), 1, 'o painel continua aberto');
    assert.equal(await page.textContent('.sheet__title'), 'Canal 6');
    const now = await inspect(page);
    assert.equal(now.zoom, before.zoom, 'o zoom ficou');
    assert.equal(now.scroll, before.scroll, 'a posição do gráfico ampliado ficou');
    assert.equal(now.highlight, OWN_24, 'o destaque ficou');
    assert.equal(now.animating, false, 'nada de animação a cada varredura');
    assert.equal(await selected(page), OWN_24);
    assert.equal(await page.evaluate(() => document.querySelector('.view').scrollTop), top, 'a rolagem ficou');
    assert.equal(await page.evaluate(() => document.querySelector('.chgraph canvas').__mark), 'mesmo', 'o canvas é o mesmo');
    assert.equal(await page.evaluate(() => document.querySelector('.ch-rank__row[data-channel="6"]').__mark), 'mesma', 'as linhas do ranking são atualizadas no lugar');

    assert.equal(await back(page), true);
    await page.locator('.sheet').waitFor({ state: 'detached' });
  });
});

test('o painel de um canal explica a nota e lista quem pesa nele (nome hostil como texto)', T, async () => {
  await open({ route: '/canais' }, async ({ page }) => {
    await ready(page);
    await page.click('.ch-more .btn');
    const all = await page.locator('.ch-rank__row').count();
    assert.equal(all, 13, 'com "mostrar os outros", os 13 canais');
    assert.match(await page.textContent('.ch-others'), /Fora da recomendação.*1, 6 e 11/s);

    // o canal 9 é onde está a rede de nome hostil
    await page.click('.ch-rank__row[data-channel="9"]');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.textContent('.sheet__title'), 'Canal 9');
    assert.match(await page.textContent('.sheet__subtitle'), /2,4.GHz · 2452.MHz/);
    const score = Number(await page.textContent('.ch-sheet__num'));
    assert.ok(score >= 0 && score <= 100);
    const body = await page.textContent('.sheet__body');
    assert.match(body, /de 100/);
    assert.match(body, /usam? este mesmo canal/);
    assert.match(body, /Fora do trio 1, 6 e 11/);
    assert.match(body, /Quem pesa neste canal/);
    const names = await page.$$eval('.sheet .ch-who .ssid', (els) => els.map((el) => el.textContent));
    assert.ok(names.includes(HOSTILE), `vizinhos listados: ${names.join(' | ')}`);
    assert.ok(!names.includes('VIVOFIBRA-8F3C'), 'o roteador do usuário não entra como vizinho');
    assert.equal(await page.locator('.sheet img').count(), 0);
    await shot(page, 'canais-painel-canal');
    await page.click('.sheet [aria-label="Fechar"]');
    await page.locator('.sheet').waitFor({ state: 'detached' });

    await page.click('.ch-more .btn');
    assert.equal(await page.locator('.ch-rank__row').count(), 3, 'e dá para voltar aos melhores');
  });
});

// ---------------------------------------------------------------------------
// Rota
// ---------------------------------------------------------------------------

test('a rota escolhe a faixa e destaca a rede, ao abrir e com a tela já aberta', T, async () => {
  await open({ route: `/canais?band=5&bssid=${encodeURIComponent(NEIGHBOUR_5)}` }, async ({ page }) => {
    await ready(page);
    assert.equal(await checkedBand(page), '5');
    assert.equal(await selected(page), NEIGHBOUR_5);
    const g = await inspect(page);
    assert.equal(g.band, '5');
    assert.equal(g.highlight, NEIGHBOUR_5);
    assert.equal(g.segments, 2, '36–64 e 100–165');
    assert.equal(g.breaks, 1, 'com o eixo interrompido entre o 64 e o 100');
    assert.ok(g.ticks.includes(44) && g.ticks.includes(149), `canais em uso no eixo: ${g.ticks.join(' ')}`);
    assert.ok(g.own.includes(OWN_5));
    assert.equal(await page.textContent('.ch-own .ssid'), 'VIVOFIBRA-8F3C-5G');
    await shot(page, 'canais-5ghz-rota');

    // mesma tela, outra rota: a tela não é remontada
    await page.evaluate(() => {
      document.querySelector('.chgraph canvas').__mark = 'mesmo';
    });
    await goto(page, `/canais?bssid=${OWN_24}`);
    assert.equal(await checkedBand(page), '2.4', 'só com o BSSID, a faixa é a da rede');
    assert.equal(await selected(page), OWN_24);
    assert.equal(await page.evaluate(() => document.querySelector('.chgraph canvas').__mark), 'mesmo');

    await goto(page, '/canais?band=5&bssid=00:11:22:33:44:55');
    assert.equal(await checkedBand(page), '5');
    assert.equal(await selected(page), null);
    await page.locator('.toast').waitFor();
    assert.match(await page.textContent('.toast'), /não está mais ao alcance/);

    await goto(page, '/canais?band=2,4');
    assert.equal(await checkedBand(page), '2.4');
    // parâmetros tortos não quebram nada
    await goto(page, '/canais?band=<b>&bssid=javascript:alert(1)');
    assert.equal(await checkedBand(page), '2.4');
    assert.equal(await page.locator('.ch-main:not([hidden])').count(), 1);
  });
});

test('trocar de faixa lembra a escolha ao sair e voltar para a aba', T, async () => {
  await open({ route: '/canais' }, async ({ page }) => {
    await ready(page);
    await page.click('.ch-band[data-band="5"]');
    await settle(page);
    assert.equal(await checkedBand(page), '5');
    assert.equal((await inspect(page)).band, '5');
    await goto(page, '/redes');
    await goto(page, '/canais');
    await ready(page);
    assert.equal(await checkedBand(page), '5');
    assert.equal(await page.locator('.chgraph canvas').count(), 1, 'um canvas só depois de remontar');
    assert.equal(await page.locator('link[rel="stylesheet"][href$="channels.css"]').count(), 1, 'a folha de estilos entra uma vez só');
    // setas do teclado no seletor pulam a faixa sem redes
    await page.focus('.ch-band[aria-checked="true"]');
    await page.keyboard.press('ArrowRight');
    await settle(page);
    assert.equal(await checkedBand(page), '2.4');
    await page.keyboard.press('ArrowLeft');
    await settle(page);
    assert.equal(await checkedBand(page), '5');
  });
});

// ---------------------------------------------------------------------------
// 5 GHz: largura e ranking
// ---------------------------------------------------------------------------

test('5 GHz: largura do canal com o conselho, ranking por blocos, DFS explicado', T, async () => {
  await open({ route: '/canais?band=5', params: { world: 'kitnet' } }, async ({ page }) => {
    await ready(page);
    const own = await appState(page, (s) => {
      const ap = s.aps.find((a) => a.connected);
      return { channel: ap.channel, width: ap.widthMHz, ssid: ap.ssid };
    });
    assert.equal(own.width, 80);

    const widths = await page.$$eval('.ch-widthopt', (els) => els.map((el) => ({ w: Number(el.dataset.width), on: el.getAttribute('aria-checked'), score: el.querySelector('.ch-widthopt__score').textContent })));
    assert.deepEqual(widths.map((w) => w.w), [20, 40, 80, 160]);
    assert.deepEqual(widths.filter((w) => w.on === 'true').map((w) => w.w), [80], 'começa na largura do roteador');
    for (const w of widths) assert.match(w.score, /^(nota \d+|—)$/);
    assert.match(await page.textContent('.ch-advice'), /^Use \d+ MHz/);
    assert.match(await page.textContent('.ch-width__now'), /Seu roteador usa 80.MHz hoje/);

    // em 80 MHz o ranking é por bloco, com o intervalo de canais
    assert.match(await page.textContent('.ch-rank__head'), /Ranking dos canais de 80.MHz/);
    let rows = await page.$$eval('.ch-rank:not(.ch-rank--others) .ch-rank__row', (els) => els.map((el) => ({ channel: Number(el.dataset.channel), cap: el.querySelector('.ch-rank__cap').textContent, tags: [...el.querySelectorAll('.badge')].map((b) => b.textContent) })));
    assert.ok(rows.length >= 5 && rows.length <= 7, `${rows.length} blocos de 80 MHz`);
    for (const r of rows) assert.match(r.cap, /^\d+–\d+$/);
    const mine = rows.filter((r) => r.tags.includes('Seu canal'));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].channel, own.channel);
    assert.ok(rows.some((r) => r.tags.includes('DFS')));
    assert.match(await page.textContent('.ch-glossary'), /DFS.*radares/s);
    assert.match(await page.textContent('.ch-rec__title'), /canal \d+/);
    await shot(page, 'canais-5ghz-largura');

    // 20 MHz: muitos canais; a lista principal mostra os melhores e o resto fica a um toque
    await page.click('.ch-widthopt[data-width="20"]');
    await settle(page);
    assert.equal(await page.getAttribute('.ch-widthopt[data-width="20"]', 'aria-checked'), 'true');
    assert.match(await page.textContent('.ch-rank__head'), /Ranking dos canais\s*28/);
    rows = await page.$$eval('.ch-rank:not(.ch-rank--others) .ch-rank__row', (els) => els.map((el) => Number(el.dataset.channel)));
    assert.ok(rows.length <= 7, `${rows.length} linhas antes de "mostrar os outros"`);
    assert.ok(rows.includes(own.channel), 'o canal do usuário está sempre à vista');
    await page.click('.ch-more .btn');
    assert.equal(await page.locator('.ch-rank__row').count(), 28);
    const others = await page.$$eval('.ch-rank--others .ch-rank__row', (els) => els.map((el) => Number(el.dataset.channel)));
    assert.deepEqual(others, [169, 173, 177]);
    assert.match(await page.textContent('.ch-others'), /U-NII-4/);
    assert.deepEqual(await horizontalOverflow(page), []);

    // um canal DFS explicado no painel
    await page.click('.ch-rank__row[data-channel="100"]');
    await page.locator('.sheet').waitFor();
    assert.match(await page.textContent('.sheet__body'), /DFS: divide a faixa com radares/);
    await page.click('.sheet [aria-label="Fechar"]');
    await page.locator('.sheet').waitFor({ state: 'detached' });
    await page.click('.ch-more .btn');

    // a largura escolhida fica ao trocar de faixa e voltar
    await page.click('.ch-band[data-band="2.4"]');
    await settle(page);
    assert.equal(await page.locator('.ch-width').count(), 0);
    await page.click('.ch-band[data-band="5"]');
    await settle(page);
    assert.equal(await page.getAttribute('.ch-widthopt[data-width="20"]', 'aria-checked'), 'true');

    // 160 MHz
    await page.click('.ch-widthopt[data-width="160"]');
    await settle(page);
    assert.match(await page.textContent('.ch-rank__head'), /Ranking dos canais de 160.MHz/);
    assert.ok((await page.locator('.ch-rank__row').count()) >= 2);
    await page.click('.ch-widthopt[data-width="80"]');
  });
});

// ---------------------------------------------------------------------------
// De quem é a rede
// ---------------------------------------------------------------------------

test('sem saber qual é a rede do usuário: mostra o canal mais livre e pede para marcar', T, async () => {
  await open({ route: '/canais' }, async ({ page }) => {
    await ready(page);
    // o celular "sai" do Wi-Fi: não há rede conectada nem favorita
    const verdict = await page.evaluate(() => {
      window.__wrx.app.store.setConnection({ connected: false });
      return document.querySelector('.ch-rec').dataset.verdict;
    });
    assert.equal(verdict, 'general');
    assert.match(await page.textContent('.ch-rec__title'), /^Canal mais livre agora: (1|6|11)$/);
    assert.match(await page.textContent('.ch-ask'), /Qual é a sua rede\?/);
    assert.equal(await page.locator('.ch-own').count(), 0);
    assert.deepEqual((await inspect(page)).own, [], 'sem rede do usuário, nenhuma forma em destaque');
    assert.equal(await page.locator('.ch-rank__row .badge:has-text("Seu canal")').count(), 0);
    assert.equal(await page.locator('.ch-rank__row .badge:has-text("Recomendado")').count(), 1);
    await shot(page, 'canais-qual-e-a-sua-rede');

    await page.click('.ch-ask .btn');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.textContent('.sheet__title'), 'Qual é a sua rede?');
    const names = await page.$$eval('.sheet .ch-who .ssid', (els) => els.map((el) => el.textContent));
    assert.ok(names.includes(HOSTILE), 'o nome hostil está na lista, como texto');
    assert.ok(names.includes('TP-Link_FE9F'));
    assert.equal(await page.locator('.sheet img').count(), 0);
    await shot(page, 'canais-painel-qual-rede');

    // marca a TP-Link_FE9F (canal 13 de 2,4 GHz)
    const row = page.locator('.sheet .ch-who .row', { has: page.locator('.ssid', { hasText: /^TP-Link_FE9F$/ }) });
    assert.equal(await row.getAttribute('aria-pressed'), 'false');
    await row.click();
    await settle(page);
    assert.equal(await row.getAttribute('aria-pressed'), 'true', 'o painel acompanha a marcação sem fechar');
    assert.deepEqual(await appState(page, (s) => [...s.favorites]), ['TP-Link_FE9F']);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wrx.favorites'))), ['TP-Link_FE9F']);
    await page.click('.sheet__footer .btn');
    await page.locator('.sheet').waitFor({ state: 'detached' });

    // agora a recomendação é sobre ela
    assert.ok(['keep', 'change'].includes(await page.getAttribute('.ch-rec', 'data-verdict')));
    assert.equal(await page.textContent('.ch-own .ssid'), 'TP-Link_FE9F');
    assert.match(await page.textContent('.ch-rec__text'), /Seu roteador está no canal 13/);
    const g = await inspect(page);
    assert.equal(g.own.length, 1);
    const mine = await page.$$eval('.ch-rank__row', (els) => els.filter((el) => [...el.querySelectorAll('.badge')].some((b) => b.textContent === 'Seu canal')).map((el) => Number(el.dataset.channel)));
    assert.deepEqual(mine, [13], 'o canal dela aparece no ranking mesmo fora do trio 1, 6 e 11');
    await shot(page, 'canais-rede-marcada');
  });
});

test('vários pontos de acesso da minha rede na faixa: escolho qual analisar', T, async () => {
  await open({ route: '/canais?band=5', params: { world: 'escritorio' }, storage: { favorites: ['ANDRADE-CORP'] } }, async ({ page }) => {
    await ready(page);
    const connected = await appState(page, (s) => {
      const ap = s.aps.find((a) => a.connected);
      return { bssid: ap.bssid, channel: ap.channel };
    });
    assert.match(await page.textContent('.ch-own__label'), new RegExp(`^Roteador analisado · canal ${connected.channel} · `), 'por padrão, o conectado');
    assert.equal(await page.textContent('.ch-own .ssid'), 'ANDRADE-CORP');

    await page.click('.ch-own .btn');
    await page.locator('.sheet').waitFor();
    const radios = page.locator('.sheet [role="radio"]');
    const total = await radios.count();
    assert.ok(total >= 3, `${total} pontos de acesso da rede em 5 GHz`);
    assert.equal(await page.getAttribute('.sheet [role="radio"][aria-checked="true"]', 'data-bssid'), connected.bssid);
    await shot(page, 'canais-painel-varios-roteadores');

    const other = page.locator('.sheet [role="radio"][aria-checked="false"]').first();
    const otherBssid = await other.getAttribute('data-bssid');
    const otherChannel = await appState(page, (s, id) => s.aps.find((a) => a.bssid === id).channel, otherBssid);
    assert.notEqual(otherChannel, connected.channel);
    await other.click();
    await settle(page);
    assert.equal(await page.getAttribute('.sheet [role="radio"][aria-checked="true"]', 'data-bssid'), otherBssid);
    await page.click('.sheet__footer .btn');
    await page.locator('.sheet').waitFor({ state: 'detached' });

    assert.match(await page.textContent('.ch-own__label'), new RegExp(`^Roteador analisado · canal ${otherChannel} · `));
    const mine = await page.$$eval('.ch-rank__row', (els) => els.filter((el) => [...el.querySelectorAll('.badge')].some((b) => b.textContent === 'Seu canal')).map((el) => Number(el.dataset.channel)));
    assert.deepEqual(mine, [otherChannel]);

    // a escolha resiste às varreduras seguintes
    const seq = await appState(page, (s) => s.scan.seq);
    await waitForScans(page, seq + 2);
    await settle(page);
    assert.match(await page.textContent('.ch-own__label'), new RegExp(`canal ${otherChannel} · `));
  });
});

// ---------------------------------------------------------------------------
// Ajuda
// ---------------------------------------------------------------------------

test('ajuda: como mudar o canal (com o endereço do roteador) e como ler o gráfico', T, async () => {
  await open({ route: '/canais' }, async ({ page }) => {
    await ready(page);
    const gateway = await appState(page, (s) => s.connection.gateway);
    assert.match(gateway, /^\d+\.\d+\.\d+\.\d+$/);

    await page.click('text=Como mudar o canal do roteador');
    await page.locator('.sheet').waitFor();
    const text = await page.textContent('.sheet__body');
    assert.ok(text.includes(gateway), 'mostra o endereço do roteador que a conexão informa');
    assert.match(text, /VIVOFIBRA-8F3C-5G/);
    assert.match(text, /Não é a senha do Wi-Fi/);
    assert.match(text, /Automático/);
    assert.match(text, /faixa de 2,4.GHz/);
    assert.equal(await page.locator('.sheet ol.steps > li').count(), 6);
    await shot(page, 'canais-ajuda-mudar-canal');
    await page.click('.sheet__footer .btn--secondary');
    await page.locator('.toast').waitFor();
    assert.ok((await page.textContent('.toast')).includes(gateway));
    await page.click('.sheet__footer .btn--primary');
    await page.locator('.sheet').waitFor({ state: 'detached' });

    await page.click('text=Como ler este gráfico');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.textContent('.sheet__title'), 'Como ler este gráfico');
    assert.equal(await page.locator('.sheet svg.ch-art').count(), 1);
    assert.match(await page.textContent('.sheet__body'), /Cada montanha é uma rede Wi-Fi/);
    await shot(page, 'canais-ajuda-ler-grafico');
    assert.equal(await back(page), true);
    await page.locator('.sheet').waitFor({ state: 'detached' });
  });
});

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

test('estados: procurando, nenhuma rede e de volta aos dados', T, async () => {
  await open({ route: '/canais', params: { speed: 1 } }, async ({ page }) => {
    await ready(page, 1);
    // antes da primeira varredura
    await page.evaluate(() => {
      const { store, scanLoop } = window.__wrx.app;
      scanLoop.setMode('paused');
      const keep = store.get();
      store.resetScanData();
      store.setInfo(keep.info);
      store.setStatus(keep.status);
    });
    await settle(page);
    assert.equal(await page.locator('.ch-main[hidden]').count(), 1);
    assert.match(await page.textContent('.ch-loading'), /Procurando redes por perto/);
    assert.ok((await page.locator('.skel').count()) >= 3);
    await shot(page, 'canais-procurando');

    // uma varredura sem rede nenhuma
    await page.evaluate(() => window.__wrx.app.store.ingestScan({ ts: Date.now(), fresh: true, source: 'request', aps: [] }));
    await settle(page);
    assert.equal(await page.textContent('.empty__title'), 'Nenhuma rede por perto');
    assert.equal(await page.locator('.ch-main[hidden]').count(), 1);
    await shot(page, 'canais-vazio');

    // "buscar de novo" traz os dados de volta, na mesma tela
    await page.evaluate(() => window.__wrx.app.scanLoop.setMode('normal'));
    await page.click('.empty .btn');
    await page.waitForSelector('.ch-main:not([hidden])');
    await page.waitForFunction(() => document.querySelector('.chgraph').__graph.inspect().shapes > 0);
    assert.equal(await page.locator('.empty').count(), 0);
    assert.equal(await checkedBand(page), '2.4');
  });
});

test('com o limite de buscas do Android: a dica aparece e pode ser dispensada', T, async () => {
  await open({ route: '/canais', params: { throttle: 1 } }, async ({ page }) => {
    await ready(page, 1);
    const tip = page.locator('.channels .banner');
    await tip.waitFor();
    assert.match(await tip.textContent(), /O Android está limitando as buscas/);
    await shot(page, 'canais-limite');
    await tip.locator('button[aria-label="Dispensar"]').click();
    await settle(page);
    assert.equal(await page.locator('.channels .banner').count(), 0);
    assert.equal(await page.locator('.ch-main:not([hidden]) .chgraph canvas').count(), 1);
  });
});

// ---------------------------------------------------------------------------
// Temas e tamanhos
// ---------------------------------------------------------------------------

test('tema claro e escuro: o gráfico é redesenhado com as cores do tema', T, async () => {
  await open({ route: '/canais', params: { theme: 'dark' } }, async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__wrx.app.scanLoop.setMode('paused'));
    await settle(page);
    // cor de um pixel do topo plano da forma do usuário (traço na cor de destaque do tema)
    const sample = () =>
      page.evaluate((id) => {
        const host = document.querySelector('.chgraph');
        const p = host.__graph.locate(id);
        const canvas = host.querySelector('canvas');
        const ctx = canvas.getContext('2d');
        // sobe do ponto de toque até achar o traço do topo
        let best = null;
        for (let dy = 0; dy <= 12; dy++) {
          const [r, g, b, a] = ctx.getImageData(Math.round(p.x * 2), Math.round((p.y - dy) * 2), 1, 1).data;
          if (!best || a > best[3]) best = [r, g, b, a];
        }
        return best;
      }, OWN_24);
    const dark = await sample();
    await page.evaluate(() => window.__wrx.app.store.updateSettings({ theme: 'light' }));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await settle(page);
    const light = await sample();
    assert.notDeepEqual(light.slice(0, 3), dark.slice(0, 3), 'a cor do traço mudou com o tema');
    assert.ok(light[2] > light[0], 'no claro, o traço da rede do usuário continua azul');
    await shot(page, 'canais-claro');
    assert.deepEqual(await horizontalOverflow(page), []);
  });
});

for (const [name, viewport, world] of [
  ['small', 'small', 'kitnet'],
  ['landscape', 'landscape', 'escritorio'],
  ['tablet', 'tablet', 'escritorio'],
]) {
  test(`cabe em ${name}: sem rolagem para o lado, gráfico redimensionado`, T, async () => {
    await open({ route: '/canais', viewport, params: { world } }, async ({ page }) => {
      await ready(page);
      assert.deepEqual(await horizontalOverflow(page), []);
      const g = await inspect(page);
      const box = await page.$eval('.chgraph', (el) => ({ w: el.clientWidth, h: el.clientHeight }));
      assert.equal(g.size.w, box.w);
      assert.equal(g.size.h, box.h);
      assert.ok(g.plot.width > 150 && g.plot.height > 100, `área do gráfico: ${g.plot.width} × ${g.plot.height}`);
      assert.ok(g.labels.length >= 2);
      for (const l of g.labels) assert.ok(l.x >= 0 && l.x + l.w <= box.w + 0.5, `"${l.text}" dentro do gráfico`);
      await page.click('.ch-band[data-band="5"]');
      await settle(page);
      assert.deepEqual(await horizontalOverflow(page), []);
      assert.equal((await inspect(page)).breaks, 1);
      await shot(page, `canais-${name}`);

      // girar/redimensionar: o canvas acompanha a caixa
      const size = page.viewportSize();
      await page.setViewportSize({ width: size.width + 60, height: size.height });
      await settle(page);
      const after = await inspect(page);
      const box2 = await page.$eval('.chgraph', (el) => el.clientWidth);
      assert.equal(after.size.w, box2);
      assert.equal(await page.$eval('.chgraph canvas', (c) => c.width), box2 * 2);
    });
  });
}
