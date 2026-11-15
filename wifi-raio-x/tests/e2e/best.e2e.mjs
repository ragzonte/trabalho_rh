// Tela Melhor Wi-Fi, de ponta a ponta: a recomendação, o ranking, o painel da nota, as "minhas
// redes", o diagnóstico com seus atalhos, os estados (carregando, vazio, dados velhos) e a
// atualização ao vivo. Parte roda contra o simulador como ele é; os casos difíceis de provocar
// (sem conexão, rede aberta, sinal no limite) usam as varreduras de tests/fixtures/scans.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startEnv, withApp, shot, goto, back, settle, appState, waitForScans, waitForScreen, horizontalOverflow } from './helpers.mjs';
import * as fx from '../fixtures/scans.mjs';

const T = { timeout: 120_000 };
// o tempo do simulador corre 10x e a pessoa virtual fica parada (sem trocar de ponto de acesso)
const FAST = { speed: 10, walk: 'still' };
const HOSTILE = '<img src=x onerror=alert(1)>';
// casa "apartamento" do simulador: o celular fica no 5 GHz do roteador VIVOFIBRA
const SIM_OWN_5 = 'cc:d4:a1:3c:0e:04';
// cenário "apartment" das varreduras de teste: a casa é "Familia Souza" (2,4 GHz) + "Familia Souza_5G"
const HOME_24 = '98:da:c4:3b:7e:10';
const HAS_DETAIL = existsSync(fileURLToPath(new URL('../../app/js/ui/ap-detail.js', import.meta.url)));

const INFO = { platform: 'android', sdk: 34, release: '14', manufacturer: 'Google', model: 'Pixel 7', appVersion: '1.0.0', bands: { b24: true, b5: true, b6: true, b60: false }, standards: [4, 5, 6], rtt: true };
const STATUS = { wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: false, canScan: true };

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

const open = (options, fn) => withApp(env, { route: '/melhor', ...options, params: { ...FAST, ...(options.params || {}) } }, fn);

const find = (scan, bssid) => scan.aps.find((a) => a.bssid === bssid);
const connectionTo = (ap, more = {}) => ({ connected: true, ssid: ap.ssid, bssid: ap.bssid, rssi: ap.level, frequency: ap.frequency, linkSpeed: 144, txSpeed: 144, rxSpeed: 144, wifiStandard: 6, securityType: 2, hidden: ap.ssid === '', validated: true, metered: false, ...more });
const HOME = { scan: fx.apartment, connection: connectionTo(find(fx.apartment, HOME_24)) };

/**
 * Troca o que o app sabe por uma varredura fabricada. O laço de buscas para: nem as buscas do
 * próprio Android (do simulador) entram, e a tela fica como o teste a deixou.
 * `scan: null` = nenhuma varredura ainda (carregando); `age` = lista em cache com essa idade (ms).
 */
async function inject(page, { scan, connection = { connected: false }, info = INFO, status = STATUS, favorites = [], age = 0 }) {
  await page.evaluate(
    (data) => {
      const { store, scanLoop } = window.__wrx.app;
      scanLoop.stop();
      store.batch(() => {
        store.resetScanData();
        store.setInfo(data.info);
        store.setStatus(data.status);
        for (const ssid of [...store.get().favorites]) store.setFavorite(ssid, false);
        for (const ssid of data.favorites) store.setFavorite(ssid, true);
        store.setConnection(data.connection);
        if (!data.scan) return;
        if (data.age) store.ingestScan({ ts: Date.now(), fresh: false, source: 'cache', aps: data.scan.aps.map((a) => ({ ...a, ageMs: data.age + (a.ageMs % 2000) })) });
        else store.ingestScan({ ...data.scan, ts: Date.now() });
      });
    },
    { scan, connection, info, status, favorites, age },
  );
  await settle(page);
}

/**
 * Mais uma varredura por cima da que está na tela (como o laço de buscas faria). `aheadMs`
 * adianta o relógio do "celular": o sinal de cada rede é suavizado no tempo, então uma mudança
 * só assenta depois de algumas varreduras espaçadas.
 */
async function nextScan(page, scan, aheadMs = 0) {
  await page.evaluate(({ ev, ahead }) => window.__wrx.app.store.ingestScan({ ...ev, ts: Date.now() + ahead }), { ev: scan, ahead: aheadMs });
  await settle(page);
}

/** Meia dúzia de varreduras iguais, de 12 em 12 s no relógio do celular: o sinal suavizado chega ao valor novo. */
async function settleScans(page, scan) {
  for (let i = 1; i <= 6; i++) await nextScan(page, scan, i * 12_000);
}

/** O que a análise do núcleo diz para o estado atual do app (para conferir com a tela). */
function coreView(page) {
  return page.evaluate(async () => {
    const { rankNetworks, advise } = await import('./js/core/best-network.js');
    const { buildInsights } = await import('./js/core/insights.js');
    const s = window.__wrx.app.store.get();
    const bssid = s.connection && s.connection.connected ? s.connection.bssid : '';
    const ranking = rankNetworks(s.aps, { device: s.info || undefined, connectionBssid: bssid, favorites: s.favorites });
    const advice = advise(ranking, { connectionBssid: bssid, favorites: s.favorites });
    const insights = buildInsights({ aps: s.aps, connection: s.connection || undefined, device: s.info || undefined, status: s.status || undefined });
    return {
      keys: ranking.map((r) => r.key),
      scores: ranking.map((r) => Math.round(r.score)),
      names: ranking.map((r) => r.name),
      connectedKey: (ranking.find((r) => r.connected) || {}).key || null,
      advice: { kind: advice.kind, headline: advice.headline, text: advice.text },
      insights: insights.map((i) => ({ id: i.id, severity: i.severity })),
    };
  });
}

const rowKeys = (page) => page.$$eval('.best-row', (rows) => rows.map((r) => r.dataset.key));
const rowScores = (page) => page.$$eval('.best-row .best-ring__num', (nums) => nums.map((n) => Number(n.textContent)));
const heroInfo = (page) => page.$eval('.best-hero', (el) => ({ kind: el.dataset.kind, hero: el.dataset.hero, headline: el.querySelector('.best-hero__headline').textContent, text: el.querySelector('.best-hero__text').textContent }));
const insightIds = (page, selector = '[data-region="diag"] [data-insight]') => page.$$eval(selector, (els) => els.map((el) => el.dataset.insight));
const toastText = async (page) => {
  await page.locator('.toast').waitFor();
  return page.textContent('.toast__text');
};
const rowByName = (page, name) => page.locator('.best-row').filter({ has: page.locator('.ssid', { hasText: name }) });
const sheetClosed = (page, selector = '.best-sheet') => page.waitForSelector(selector, { state: 'detached' });

/** Abre a tela com uma varredura fabricada já no lugar. */
const openWith = (scene, fn, options = {}) =>
  open({ route: '/ferramentas', ...options }, async (app) => {
    await waitForScans(app.page, 1);
    await inject(app.page, scene);
    await goto(app.page, '/melhor');
    await app.page.waitForSelector('.best-hero');
    await settle(app.page);
    return fn(app);
  });

// ---------------------------------------------------------------------------
// Contra o simulador
// ---------------------------------------------------------------------------

test('abre no simulador: recomendação, ranking e diagnóstico coerentes com o núcleo', T, async () => {
  await open({}, async ({ page }) => {
    await waitForScans(page, 2);
    await page.waitForSelector('.best-row');
    // para o laço: a tela e o estado são comparados no mesmo instante
    await page.evaluate(() => window.__wrx.app.scanLoop.stop());
    await settle(page);
    const core = await coreView(page);

    // 1. a recomendação é a primeira coisa da tela e diz o que o núcleo diz
    const first = await page.$eval('.view > .screen', (screen) => [...screen.children].find((el) => el.getBoundingClientRect().height > 0).dataset.region);
    assert.equal(first, 'hero');
    const hero = await heroInfo(page);
    assert.equal(hero.kind, core.advice.kind);
    assert.equal(hero.headline, core.advice.headline);
    assert.equal(hero.text, core.advice.text);
    assert.equal(hero.kind, 'ok', 'na casa do simulador o celular já está na melhor rede');
    assert.match(await page.getAttribute('.best-hero__score', 'aria-label'), /^Nota da sua conexão: \d+ de 100/);
    const heroBox = await page.locator('.best-hero').boundingBox();
    assert.ok(heroBox.y + heroBox.height < 915, 'a recomendação cabe inteira na primeira tela');

    // 2. ranking: mesma ordem e mesmas notas do núcleo, só as melhores à vista
    const keys = await rowKeys(page);
    assert.equal(keys.length, 5);
    assert.deepEqual(keys, core.keys.slice(0, 5));
    assert.deepEqual(await rowScores(page), core.scores.slice(0, 5));
    assert.equal(await page.textContent('[data-region="rank"] .section-h__count'), String(core.keys.length));
    assert.match(await page.textContent('.best-more'), new RegExp(`^Mostrar as outras ${core.keys.length - 5} redes$`));
    for (const text of await page.$$eval('.best-row__speed', (els) => els.map((el) => el.textContent))) assert.match(text, /^≈\s[\d,]+\s[MG]b\/s$/, `velocidade estimada: "${text}"`);
    assert.equal(await page.getAttribute('.best-row--connected', 'data-key'), core.connectedKey);
    assert.equal(await page.getAttribute('.best-row--connected', 'data-bssid'), SIM_OWN_5);
    assert.match(await page.textContent('.best-row--connected .best-row__connected'), /Conectado/);
    const ringLabel = await page.getAttribute('.best-row >> nth=0 >> .best-ring', 'aria-label');
    assert.match(ringLabel, /^Nota \d+ de 100: \w+/, 'a nota tem número e palavra para quem não vê a cor');

    // 3. diagnóstico: os mesmos avisos, com o "tudo certo" dito com todas as letras
    const shown = await insightIds(page);
    assert.deepEqual([...shown].sort(), core.insights.map((i) => i.id).sort());
    assert.ok(shown.includes('all-good'));
    assert.equal(shown[0], 'all-good', 'sem problemas, a boa notícia vem primeiro');
    assert.match(await page.textContent('.best-diag--good .best-diag__title'), /Tudo certo/);
    assert.equal(await page.textContent('.best-hero__diag-text'), 'Diagnóstico: tudo certo');

    // 4. a dica das "minhas redes" aparece enquanto nenhuma foi marcada
    assert.match(await page.textContent('[data-region="tip"] .banner__title'), /Quais redes são suas\?/);

    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'melhor-simulador');
  });
});

test('nome de rede hostil aparece só como texto, na lista, no painel e no seletor', T, async () => {
  await open({}, async ({ page }) => {
    await waitForScans(page, 2);
    await page.waitForSelector('.best-row');
    await page.evaluate(() => window.__wrx.app.scanLoop.stop());
    if (await page.locator('.best-more').count()) await page.click('.best-more');
    await settle(page);

    const row = page.locator(`.best-row[data-key="psk:${HOSTILE}"]`);
    assert.equal(await row.count(), 1, 'a rede de nome hostil está no ranking');
    assert.equal(await row.locator('.ssid').textContent(), HOSTILE);
    await row.click();
    await page.waitForSelector('.best-sheet');
    assert.equal(await page.textContent('.best-sheet .sheet__title'), HOSTILE);
    assert.equal(await page.locator('.best-sheet .best-part').count(), 4);
    await back(page);
    await sheetClosed(page);

    await page.click('[data-action="pick-mine"]');
    await page.waitForSelector('.best-picker');
    const names = await page.$$eval('.best-picker .best-pick .ssid', (els) => els.map((el) => el.textContent));
    assert.ok(names.includes(HOSTILE));
    await page.locator(`.best-pick[data-ssid="${HOSTILE}"] input.switch`).check();
    await settle(page);
    assert.equal(await appState(page, (s, name) => s.favorites.has(name), HOSTILE), true);
    await page.click('.best-picker .sheet__footer .btn');
    await sheetClosed(page, '.best-picker');
    assert.equal(await row.locator('.ssid').textContent(), HOSTILE);
    assert.equal(await row.locator('[aria-label="Minha rede"]').count(), 1);

    // nada do nome virou elemento, atributo com código ou imagem em lugar nenhum
    const injected = await page.evaluate(() => document.querySelectorAll('#app img, .layer img, [onerror]').length);
    assert.equal(injected, 0);
    assert.equal(await page.evaluate(() => window.__xss === true), false);
  });
});

test('as varreduras chegam sem mexer na rolagem, no que está aberto nem no painel', T, async () => {
  await open({}, async ({ page }) => {
    await waitForScans(page, 2);
    await page.waitForSelector('.best-row');
    await page.click('.best-more');
    await page.locator('.best-fold__head').first().click();
    await page.evaluate(() => {
      document.querySelector('.view').scrollTop = 420;
    });
    await settle(page);
    const before = await page.evaluate(() => document.querySelector('.view').scrollTop);
    assert.ok(before > 300);
    const seq = await appState(page, (s) => s.scan.seq);
    await waitForScans(page, seq + 2);
    await settle(page);
    assert.equal(await page.evaluate(() => document.querySelector('.view').scrollTop), before, 'a tela não pulou');
    assert.equal(await page.getAttribute('.best-more', 'aria-expanded'), 'true', 'a lista continua aberta');
    assert.equal(await page.locator('.best-fold[data-open="1"]').count(), 1, 'a observação continua aberta');

    // com um painel aberto e rolado
    await page.evaluate(() => {
      document.querySelector('.view').scrollTop = 0;
    });
    await page.locator('.best-row--connected').click();
    await page.waitForSelector('.best-sheet');
    await page.evaluate(() => {
      document.querySelector('.best-sheet .sheet__body').scrollTop = 200;
    });
    await settle(page);
    const seq2 = await appState(page, (s) => s.scan.seq);
    await waitForScans(page, seq2 + 2);
    await settle(page);
    assert.equal(await page.locator('.best-sheet').count(), 1, 'o painel continua aberto');
    assert.equal(await page.evaluate(() => document.querySelector('.best-sheet .sheet__body').scrollTop), 200, 'e na mesma rolagem');
  });
});

// ---------------------------------------------------------------------------
// Recomendação
// ---------------------------------------------------------------------------

test('conectado no 2,4 GHz com o 5 GHz do roteador à mão: manda trocar, mostra de onde para onde e abre o Wi-Fi', T, async () => {
  await openWith(HOME, async ({ page }) => {
    const hero = await heroInfo(page);
    assert.equal(hero.kind, 'switch-band');
    assert.equal(hero.headline, 'Troque para a rede “Familia Souza_5G”');
    assert.match(hero.text, /5 GHz do mesmo roteador/);

    const current = page.locator('.best-side[data-side="current"]');
    const target = page.locator('.best-side[data-side="target"]');
    assert.equal(await current.locator('.best-side__label').textContent(), 'Agora');
    assert.equal(await current.locator('.ssid').textContent(), 'Familia Souza');
    assert.match(await current.locator('.best-side__where').textContent(), /2,4\sGHz.*canal 6/);
    assert.equal(await target.locator('.ssid').textContent(), 'Familia Souza_5G');
    assert.match(await target.locator('.best-side__where').textContent(), /5\sGHz.*canal 36/);
    assert.match(await target.locator('.best-side__gain').textContent(), /mais rápida|ou mais de velocidade/);
    const speed = (text) => Number(text.replace(/[^\d,]/g, '').replace(',', '.'));
    assert.ok(speed(await target.locator('.best-side__speed').textContent()) > speed(await current.locator('.best-side__speed').textContent()));

    // a ação é uma só e é a principal
    assert.equal(await page.locator('.best-hero__actions .btn').count(), 1);
    assert.equal(await page.textContent('.best-hero__actions .btn--primary'), 'Abrir o Wi-Fi do celular');
    await page.click('.best-hero__actions .btn--primary');
    assert.match(await toastText(page), /Na demonstração não há configurações do Android/);

    // os dois lados abrem o painel da própria rede
    await target.click();
    await page.waitForSelector('.best-sheet[data-key="psk:Familia Souza_5G"]');
    await back(page);
    await sheetClosed(page);
    await current.click();
    await page.waitForSelector('.best-sheet[data-key="psk:Familia Souza"]');
    await back(page);
    await sheetClosed(page);

    // no ranking: a rede em uso marcada, a outra faixa do mesmo roteador reconhecida
    assert.equal(await page.getAttribute('.best-row--connected', 'data-bssid'), HOME_24);
    assert.match(await rowByName(page, 'Familia Souza_5G').locator('.best-row__where').textContent(), /Mesmo roteador/);
    assert.equal(await rowByName(page, 'Familia Souza_5G').getAttribute('data-mine'), '1');
    assert.equal(await rowByName(page, 'CLARO_5G4F1D2A').getAttribute('data-mine'), '0');
    await shot(page, 'melhor-trocar-de-faixa');
  });
});

test('sem conexão: indica a melhor rede; com uma rede marcada, manda conectar nela', T, async () => {
  await openWith({ scan: fx.apartment }, async ({ page }) => {
    let hero = await heroInfo(page);
    assert.equal(hero.kind, 'no-connection');
    assert.equal(hero.hero, 'connect');
    assert.equal(hero.headline, 'Você não está conectado ao Wi-Fi');
    assert.match(hero.text, /Se você tiver a senha/);
    assert.equal(await page.locator('.best-side').count(), 1);
    assert.equal(await page.textContent('.best-side[data-side="target"] .best-side__label'), 'Melhor opção aqui');
    assert.equal(await page.locator('.best-row--connected').count(), 0);
    assert.equal(await page.locator('.best-hero__diag').count(), 0, '"não conectado" a recomendação já diz: sem atalho repetido');
    assert.deepEqual(await insightIds(page), ['not-connected']);
    await page.click('.best-hero__actions .btn--primary');
    assert.match(await toastText(page), /Na demonstração/);

    // "ver a melhor rede" do diagnóstico é esta tela: leva ao ranking
    await page.evaluate(() => document.querySelector('[data-region="diag"]').scrollIntoView());
    await page.click('.best-diag[data-insight="not-connected"] [data-action="open-best"]');
    await page.waitForFunction(() => {
      const rank = document.querySelector('[data-region="rank"]').getBoundingClientRect();
      const view = document.querySelector('.view').getBoundingClientRect();
      return rank.top >= view.top - 2 && rank.top < view.top + 80;
    });
    assert.equal(await page.evaluate(() => location.hash), '#/melhor');

    // a pessoa marca a rede de casa: a recomendação passa a ser sobre ela
    await page.evaluate(() => window.__wrx.app.store.setFavorite('Familia Souza', true));
    await settle(page);
    hero = await heroInfo(page);
    assert.equal(hero.headline, 'Conecte-se à rede “Familia Souza”');
    assert.match(hero.text, /Das suas redes/);
    assert.equal(await page.textContent('.best-side[data-side="target"] .ssid'), 'Familia Souza');
    await shot(page, 'melhor-sem-conexao');
  });
});

test('a melhor opção com sinal no limite: o cartão não comemora e oferece marcar a rede vizinha como minha', T, async () => {
  const weak = fx.mesh.aps[fx.mesh.aps.length - 1];
  await openWith({ scan: fx.mesh, connection: connectionTo(weak) }, async ({ page }) => {
    const hero = await heroInfo(page);
    assert.equal(hero.kind, 'ok');
    assert.equal(hero.headline, 'Você já está na melhor opção');
    assert.match(hero.text, /sinal está no limite/);
    assert.ok(await page.locator('.best-hero.best-hero--warning').count(), 'tom de atenção, não de sucesso');
    assert.match(await page.textContent('.best-hero__score-word'), /Fraca|Ruim/);
    assert.match(await page.textContent('.best-hero__diag-text'), /pontos? de atenção no diagnóstico/);

    // "essa rede é minha": marca a rede citada e a recomendação muda na hora
    const alt = await page.evaluate(async () => {
      const { rankNetworks, advise } = await import('./js/core/best-network.js');
      const s = window.__wrx.app.store.get();
      const ranking = rankNetworks(s.aps, { device: s.info, connectionBssid: s.connection.bssid, favorites: s.favorites });
      return advise(ranking, { connectionBssid: s.connection.bssid, favorites: s.favorites }).alternative.ssid;
    });
    assert.ok(hero.text.includes(`“${alt}”`));
    await page.click('.best-hero__actions .btn');
    assert.match(await toastText(page), new RegExp(`“${alt}” agora conta como sua`));
    assert.equal(await appState(page, (s, name) => s.favorites.has(name), alt), true);
    assert.match((await heroInfo(page)).kind, /^switch-/);
    await page.click('.toast__action');
    await settle(page);
    assert.equal(await appState(page, (s, name) => s.favorites.has(name), alt), false, '"desfazer" desmarca');
    assert.equal((await heroInfo(page)).kind, 'ok');

    // o aviso de sinal fraco leva ao mapa
    await page.evaluate(() => {
      window.__blockNav = (ev) => ev.stopImmediatePropagation();
      window.addEventListener('hashchange', window.__blockNav, true); // a rota muda, mas a tela do mapa não é carregada neste teste
    });
    await page.evaluate(() => document.querySelector('[data-region="diag"]').scrollIntoView());
    await page.click('.best-diag[data-insight="weak-signal"] [data-action="open-map"]');
    await page.waitForFunction(() => location.hash === '#/mapa');
    await page.evaluate(() => {
      location.hash = '#/melhor';
    });
    await page.waitForFunction(() => location.hash === '#/melhor');
    await settle(page);
    await page.evaluate(() => window.removeEventListener('hashchange', window.__blockNav, true));
    await shot(page, 'melhor-sinal-no-limite');
  });
});

// ---------------------------------------------------------------------------
// Ranking e painel da nota
// ---------------------------------------------------------------------------

test('painel da nota: quatro partes, a conta, os pontos de acesso; acompanha as varreduras sem fechar', T, async () => {
  await openWith(HOME, async ({ page }) => {
    const row = rowByName(page, 'Casa do Zé');
    assert.match(await row.locator('.best-row__where').textContent(), /2 sinais/);
    const score = Number(await row.locator('.best-ring__num').textContent());
    await row.click();
    await page.waitForSelector('.best-sheet');
    assert.equal(await page.textContent('.best-sheet .sheet__title'), 'Casa do Zé');
    assert.equal(await page.textContent('.best-sheet .sheet__subtitle'), `Nota ${score} de 100 neste ponto`);
    assert.equal(await page.textContent('.best-sheet-head .best-ring__num'), String(score));
    assert.match(await page.textContent('.best-sheet-head__speed'), /^≈\s[\d,]+\s[MG]b\/s$/);
    assert.match(await page.textContent('.best-sheet-head__hint'), /estimativa/);

    // as quatro partes, cada uma com rótulo, número, barra e explicação
    const parts = await page.$$eval('.best-sheet .best-part', (els) =>
      els.map((el) => ({
        id: el.dataset.part,
        label: el.querySelector('.best-part__label').textContent,
        value: Number(el.querySelector('.best-part__value').textContent),
        meter: Number(el.querySelector('.meter').getAttribute('aria-valuenow')),
        headline: el.querySelector('.best-part__headline').textContent,
        text: el.querySelector('.best-part__text').textContent,
      })),
    );
    assert.deepEqual(parts.map((p) => p.id), ['signal', 'speed', 'congestion', 'security']);
    assert.deepEqual(parts.map((p) => p.label), ['Sinal', 'Velocidade', 'Canal livre', 'Segurança']);
    for (const part of parts) {
      assert.ok(part.value >= 0 && part.value <= 100 && part.value === part.meter, `${part.id}: ${part.value}`);
      assert.ok(part.headline.length > 2 && part.text.length > 10, `${part.id} explica o número`);
    }
    assert.match(parts[0].headline, /dBm/);

    // a conta termina na nota que a lista mostra
    const steps = await page.$$eval('.best-why__steps li', (els) => els.map((el) => el.textContent));
    assert.ok(steps.length >= 3);
    assert.match(steps[0], /^Velocidade esperada aqui: ≈/);
    assert.equal(steps[steps.length - 1], `Nota final: ${score} de 100.`);
    assert.ok((await page.locator('.best-why__notes .best-note').count()) >= 1, 'os prós e contras completos');

    // os dois pontos de acesso da rede, o melhor primeiro
    assert.equal(await page.locator('.best-sheet .best-ap').count(), 2);
    assert.match(await page.locator('.best-sheet .best-ap').first().textContent(), /Melhor/);
    const apScores = await page.$$eval('.best-sheet .best-ap .best-ring__num', (els) => els.map((el) => Number(el.textContent)));
    assert.equal(apScores[0], score);
    assert.ok(apScores[0] >= apScores[1]);
    assert.equal(await page.textContent('.best-sheet .sheet__footer .btn'), 'Abrir o Wi-Fi do celular');
    await shot(page, 'melhor-painel-nota');

    // chega outra varredura com esta rede bem mais fraca: o painel acompanha, aberto e na mesma rolagem
    await page.evaluate(() => {
      document.querySelector('.best-sheet .sheet__body').scrollTop = 150;
    });
    const weaker = { ...fx.apartment, aps: fx.apartment.aps.map((a) => (a.ssid === 'Casa do Zé' ? { ...a, level: -88, ageMs: 100 } : { ...a, ageMs: 100 })) };
    await settleScans(page, weaker);
    assert.equal(await page.locator('.best-sheet').count(), 1);
    assert.equal(await page.evaluate(() => document.querySelector('.best-sheet .sheet__body').scrollTop), 150);
    const after = Number(await page.textContent('.best-sheet-head .best-ring__num'));
    assert.ok(after < score - 15, `a nota caiu com o sinal (${score} -> ${after})`);
    assert.equal(await page.textContent('.best-sheet .sheet__subtitle'), `Nota ${after} de 100 neste ponto`);
    assert.match(await page.textContent('.best-sheet .banner--warning'), /Sinal no limite/);

    // a rede some de vez: o painel fica com os últimos números e avisa
    await inject(page, { scan: { ...fx.apartment, aps: fx.apartment.aps.filter((a) => a.ssid !== 'Casa do Zé') }, connection: HOME.connection });
    assert.equal(await page.locator('.best-sheet').count(), 1);
    assert.match(await page.textContent('.best-sheet .banner--warning .banner__title'), /saiu do alcance/);
    assert.equal(await rowByName(page, 'Casa do Zé').count(), 0);

    // "voltar" fecha o painel e fica na tela
    assert.equal(await back(page), true);
    await sheetClosed(page);
    assert.equal(await page.evaluate(() => location.hash), '#/melhor');
  });
});

test('do painel da nota aos detalhes técnicos do ponto de acesso, e de volta', { ...T, skip: !HAS_DETAIL && 'ui/ap-detail.js ainda não existe' }, async () => {
  await openWith(HOME, async ({ page }) => {
    await page.locator('.best-row--connected').click();
    await page.waitForSelector('.best-sheet');
    assert.equal(await page.locator('.best-sheet .sheet__footer').count(), 0, 'na rede em uso não há o que conectar');
    await page.locator(`.best-sheet .best-ap[data-bssid="${HOME_24}"]`).click();
    await page.waitForSelector(`.ap-sheet[data-bssid="${HOME_24}"]`);
    assert.equal(await page.locator('.best-sheet').count(), 1, 'o painel da nota fica por baixo');
    assert.equal(await back(page), true);
    await page.waitForSelector('.ap-sheet', { state: 'detached' });
    assert.equal(await page.locator('.best-sheet').count(), 1);
    assert.equal(await back(page), true);
    await sheetClosed(page);
  });
});

test('ranking: mostrar todas, redes fracas com aviso curto, rede aberta, lembrança ao voltar para a aba', T, async () => {
  await openWith(HOME, async ({ page }) => {
    const total = Number(await page.textContent('[data-region="rank"] .section-h__count'));
    assert.ok(total > 20);
    assert.equal(await page.locator('.best-row').count(), 5);
    assert.match(await page.textContent('[data-region="rank"] .best-caption'), /estimativa/);
    await page.click('.best-more');
    await settle(page);
    assert.equal(await page.locator('.best-row').count(), total);
    assert.equal(await page.textContent('.best-more'), 'Mostrar só as 5 melhores');
    const scores = await rowScores(page);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'da melhor para a pior');

    // rede aberta: cadeado aberto com a palavra, aviso curto na linha e a frase inteira no painel
    const openNet = page.locator('.best-row').filter({ has: page.locator('.badge--warning', { hasText: 'Aberta' }) }).first();
    assert.ok(await openNet.count(), 'há uma rede aberta no cenário');
    assert.match(await openNet.locator('.best-note--warn').textContent(), /^Rede aberta, sem senha e sem criptografia/);
    assert.ok((await openNet.locator('.best-note').count()) <= 3, 'no máximo três frases por linha');
    await openNet.click();
    await page.waitForSelector('.best-sheet');
    assert.match(await page.textContent('.best-sheet .best-warnings'), /quem estiver por perto pode ver o que você envia e recebe/);
    assert.ok((await page.$$eval('.best-why__steps li', (els) => els.map((el) => el.textContent))).some((t) => /cai pela metade/.test(t)));
    assert.equal(await page.textContent('.best-sheet .best-part[data-part="security"] .best-part__headline'), 'Aberta');
    await back(page);
    await sheetClosed(page);

    assert.deepEqual(await horizontalOverflow(page), []);

    // sair da aba e voltar: a lista continua aberta
    await goto(page, '/ferramentas');
    await goto(page, '/melhor');
    await page.waitForSelector('.best-row');
    assert.equal(await page.locator('.best-row').count(), total);
    await page.click('.best-more');
    await settle(page);
    assert.equal(await page.locator('.best-row').count(), 5);
  });
});

test('celular que não usa 5 GHz: essas redes ficam sem nota, com o motivo', T, async () => {
  await openWith({ ...HOME, info: { ...INFO, bands: { b24: true, b5: false, b6: false, b60: false }, standards: [4] } }, async ({ page }) => {
    assert.equal((await heroInfo(page)).kind, 'ok', 'não manda trocar para uma faixa que o celular não alcança');
    await page.click('.best-more');
    await settle(page);
    const row = rowByName(page, 'Familia Souza_5G');
    assert.equal(await row.locator('.best-row__word').textContent(), 'Sem uso');
    assert.equal(await row.locator('.best-ring__num').textContent(), '–');
    assert.match(await row.locator('.best-ring').getAttribute('aria-label'), /Sem nota/);
    await row.click();
    await page.waitForSelector('.best-sheet');
    assert.equal(await page.textContent('.best-sheet .sheet__subtitle'), 'Sem nota neste celular');
    assert.match(await page.textContent('.best-why__steps'), /Este celular não funciona na faixa desta rede/);
    await back(page);
    await sheetClosed(page);
    assert.ok((await insightIds(page)).includes('phone-no-5ghz'));
  });
});

// ---------------------------------------------------------------------------
// Minhas redes
// ---------------------------------------------------------------------------

test('minhas redes: a dica leva ao seletor, a estrela fica guardada, o filtro mostra só as minhas', T, async () => {
  await openWith(HOME, async ({ page }) => {
    // 1. a dica (só enquanto nada foi marcado) abre o seletor
    await page.click('[data-region="tip"] .banner__actions .btn');
    await page.waitForSelector('.best-picker');
    const first = await page.$eval('.best-picker .best-pick', (el) => ({ ssid: el.dataset.ssid, text: el.textContent }));
    assert.equal(first.ssid, 'Familia Souza', 'a rede em uso vem primeiro');
    assert.match(first.text, /Conectado/);
    assert.equal(await page.locator('.best-picker .best-pick[data-on="1"]').count(), 0);

    await page.locator('.best-pick[data-ssid="Casa do Zé"] input.switch').check();
    await settle(page);
    assert.equal(await page.locator('.best-picker').count(), 1, 'marcar não fecha o seletor');
    assert.equal(await page.getAttribute('.best-pick[data-ssid="Casa do Zé"]', 'data-on'), '1');
    assert.equal(await appState(page, (s) => s.favorites.has('Casa do Zé')), true);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wrx.favorites'))), ['Casa do Zé'], 'fica guardada no aparelho');
    await page.click('.best-picker .sheet__footer .btn');
    await sheetClosed(page, '.best-picker');

    // 2. a estrela aparece na linha, a dica some e o botão do seletor conta as marcadas
    assert.equal(await rowByName(page, 'Casa do Zé').locator('[aria-label="Minha rede"]').count(), 1);
    assert.equal(await page.locator('[data-region="tip"] .banner').count(), 0);
    assert.equal(await page.textContent('[data-action="pick-mine"] .chip__count'), '1');

    // 3. "só as minhas": a rede em uso, a outra faixa do mesmo roteador e a marcada
    await page.click('[data-filter="mine"]');
    await settle(page);
    assert.equal(await page.getAttribute('[data-filter="mine"]', 'aria-pressed'), 'true');
    const mine = await page.$$eval('.best-row', (rows) => rows.map((r) => ({ name: r.querySelector('.ssid').textContent, mine: r.dataset.mine })));
    assert.deepEqual(mine.map((m) => m.name).sort(), ['Casa do Zé', 'Familia Souza', 'Familia Souza_5G']);
    assert.ok(mine.every((m) => m.mine === '1'));
    assert.equal(await page.textContent('[data-region="rank"] .section-h__count'), '3');
    assert.equal(await page.locator('.best-more').count(), 0);
    await shot(page, 'melhor-so-as-minhas');

    // 4. o filtro fica guardado: sai da aba, volta, continua ligado
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wrx.melhor'))), { mineOnly: true });
    await goto(page, '/ferramentas');
    await goto(page, '/melhor');
    await page.waitForSelector('.best-row');
    assert.equal(await page.getAttribute('[data-filter="mine"]', 'aria-pressed'), 'true');
    assert.equal(await page.locator('.best-row').count(), 3);

    // 5. desmarcar pelo painel da própria rede
    await rowByName(page, 'Casa do Zé').click();
    await page.waitForSelector('.best-sheet');
    assert.equal(await page.isChecked('.best-own input.switch'), true);
    await page.locator('.best-own input.switch').uncheck();
    await settle(page);
    assert.equal(await appState(page, (s) => s.favorites.size), 0);
    assert.equal(await page.getAttribute('.best-own', 'data-on'), '0');
    await back(page);
    await sheetClosed(page);
    assert.equal(await page.locator('.best-row').count(), 2, 'sem a estrela ela sai do filtro');
    await page.click('[data-filter="mine"]');
    await settle(page);
    assert.equal(await page.locator('.best-row').count(), 5);
  });
});

test('só as minhas, sem nenhuma ao alcance: explica e oferece os dois caminhos; marcada fora do alcance dá para desmarcar', T, async () => {
  await openWith({ scan: fx.apartment, favorites: ['Rede Do Trabalho'] }, async ({ page }) => {
    await page.click('[data-filter="mine"]');
    await settle(page);
    assert.equal(await page.locator('.best-row').count(), 0);
    assert.match(await page.textContent('[data-region="rank"] .empty__title'), /Nenhuma rede sua ao alcance/);

    await page.click('[data-region="rank"] .empty .btn--primary');
    await page.waitForSelector('.best-picker');
    const away = page.locator('.best-pick[data-ssid="Rede Do Trabalho"]');
    assert.match(await away.textContent(), /Não apareceu na última busca/);
    assert.equal(await away.locator('input.switch').isChecked(), true);
    await away.locator('input.switch').uncheck();
    await settle(page);
    assert.equal(await appState(page, (s) => s.favorites.size), 0);
    // a linha fica enquanto o painel estiver aberto: um toque errado tem de poder ser desfeito
    assert.equal(await away.getAttribute('data-on'), '0');
    await away.locator('input.switch').check();
    await settle(page);
    assert.equal(await appState(page, (s) => s.favorites.has('Rede Do Trabalho')), true);
    await away.locator('input.switch').uncheck();
    await settle(page);
    await page.click('.best-picker .sheet__footer .btn');
    await sheetClosed(page, '.best-picker');
    assert.equal(await appState(page, (s) => s.favorites.size), 0);
    await page.click('[data-action="pick-mine"]');
    await page.waitForSelector('.best-picker');
    assert.equal(await page.locator('.best-pick[data-ssid="Rede Do Trabalho"]').count(), 0, 'desmarcada e fora do alcance: não volta a aparecer');
    await back(page);
    await sheetClosed(page, '.best-picker');

    await page.click('[data-region="rank"] .empty .btn--quiet');
    await settle(page);
    assert.equal(await page.getAttribute('[data-filter="mine"]', 'aria-pressed'), 'false');
    assert.equal(await page.locator('.best-row').count(), 5);
  });
});

test('a dica das minhas redes pode ser dispensada para sempre', T, async () => {
  await openWith(HOME, async ({ page }) => {
    assert.equal(await page.locator('[data-region="tip"] .banner').count(), 1);
    await page.click('[data-region="tip"] .banner__close');
    await settle(page);
    assert.equal(await page.locator('[data-region="tip"] .banner').count(), 0);
    assert.ok(await appState(page, (s) => s.settings.tipsDismissed.includes('best-mine')));
    await nextScan(page, fx.apartment);
    assert.equal(await page.locator('[data-region="tip"] .banner').count(), 0, 'não volta com a próxima varredura');
    await goto(page, '/ferramentas');
    await goto(page, '/melhor');
    await page.waitForSelector('.best-row');
    assert.equal(await page.locator('[data-region="tip"] .banner').count(), 0);
  });
});

// ---------------------------------------------------------------------------
// Diagnóstico
// ---------------------------------------------------------------------------

test('diagnóstico: problemas por gravidade com o atalho certo; observações recolhidas em "Bom saber"', T, async () => {
  const openAp = fx.apartment.aps.find((a) => a.capabilities === '[ESS]');
  await openWith({ scan: fx.apartment, connection: connectionTo(openAp, { securityType: 0 }), status: { ...STATUS, throttled: true } }, async ({ page }) => {
    // 1. o crítico vem primeiro, cada cartão diz a gravidade em palavras
    const cards = await page.$$eval('[data-region="diag"] .best-diag', (els) => els.map((el) => ({ id: el.dataset.insight, severity: el.dataset.severity, kind: el.querySelector('.best-diag__kind')?.textContent, title: el.querySelector('.best-diag__title').textContent, text: el.querySelector('.best-diag__text').textContent })));
    assert.equal(cards[0].id, 'weak-security');
    assert.equal(cards[0].severity, 'critical');
    assert.equal(cards[0].kind, 'Crítico');
    assert.match(cards[0].title, /Rede aberta/);
    const order = cards.map((c) => c.severity);
    assert.deepEqual(order, [...order].sort((a, b) => ['critical', 'warning'].indexOf(a) - ['critical', 'warning'].indexOf(b)));
    assert.ok(cards.slice(1).every((c) => c.kind === 'Atenção'));
    for (const card of cards) assert.ok(card.text.length > 40, `${card.id} traz o texto concreto`);
    assert.equal(await page.textContent('[data-region="diag"] .section-h__count'), String(cards.length));
    assert.equal(await page.textContent('.best-hero__diag-text'), `${cards.length} pontos de atenção no diagnóstico`);
    assert.ok(await page.locator('.best-hero__diag.best-hero__diag--critical').count());

    // 2. o atalho do cartão da recomendação rola até o diagnóstico
    await page.click('.best-hero__diag');
    await page.waitForFunction(() => {
      const diag = document.querySelector('[data-region="diag"]').getBoundingClientRect();
      const view = document.querySelector('.view').getBoundingClientRect();
      return diag.top >= view.top - 2 && diag.top < view.top + 120;
    });

    // 3. observações: recolhidas, abrem no toque, e a do limite de buscas tem o passo a passo
    assert.ok((await insightIds(page, '.best-fold')).includes('scan-throttled'));
    const fold = page.locator('.best-fold[data-insight="scan-throttled"]');
    assert.equal(await fold.locator('.best-fold__head').getAttribute('aria-expanded'), 'false');
    assert.equal(await fold.locator('.best-fold__body').isVisible(), false);
    await fold.locator('.best-fold__head').click();
    await settle(page);
    assert.equal(await fold.locator('.best-fold__head').getAttribute('aria-expanded'), 'true');
    assert.match(await fold.locator('.best-fold__text').textContent(), /4 vezes a cada 2 minutos/);
    await nextScan(page, fx.apartment);
    assert.equal(await fold.locator('.best-fold__body').isVisible(), true, 'continua aberta depois de uma varredura');
    await fold.locator('[data-action="throttle-help"]').click();
    await page.waitForSelector('.sheet');
    assert.match(await page.textContent('.sheet .sheet__title'), /Por que a lista demora a atualizar\?/);
    await back(page);
    await page.waitForSelector('.sheet', { state: 'detached' });
    await fold.locator('.best-fold__head').click();
    await settle(page);
    assert.equal(await fold.locator('.best-fold__body').isVisible(), false);
    await shot(page, 'melhor-diagnostico');

    // 4. "ver canais" abre a tela Canais já na faixa de que o aviso fala
    const channel = page.locator('.best-diag[data-insight="crowded-channel-24"] [data-action="open-channels"]');
    assert.equal(await channel.textContent(), 'Ver canais');
    await channel.click();
    await waitForScreen(page, '/canais');
    assert.equal(await page.evaluate(() => location.hash), '#/canais?band=2.4');
    assert.equal(await page.getAttribute('.ch-band[aria-checked="true"]', 'data-band'), '2.4');
  });
});

test('diagnóstico: abrir o Wi-Fi pelo aviso; só observações aparecem inteiras', T, async () => {
  await openWith(HOME, async ({ page }) => {
    const ids = await insightIds(page, '[data-region="diag"] .best-diag');
    assert.ok(ids.includes('band-upgrade'));
    await page.click('.best-diag[data-insight="band-upgrade"] [data-action="open-settings-wifi"]');
    assert.match(await toastText(page), /Na demonstração não há configurações do Android/);
  });
  // casa tranquila, tudo certo: a boa notícia em cartão, as observações recolhidas
  await openWith({ scan: fx.quietHouse, connection: connectionTo(fx.quietHouse.aps[0]), info: { ...INFO, bands: { b24: true, b5: false, b6: false, b60: false } } }, async ({ page }) => {
    const { problems, good, notes } = await page.evaluate(async () => {
      const { splitInsights, analyse } = await import('./js/ui/screens/best.js');
      const split = splitInsights(analyse(window.__wrx.app.store.get()).insights);
      return { problems: split.problems.map((i) => i.id), good: !!split.good, notes: split.notes.map((i) => i.id) };
    });
    assert.deepEqual(await insightIds(page, '[data-region="diag"] .best-diag'), [...(good ? ['all-good'] : []), ...problems]);
    assert.deepEqual(await insightIds(page, '.best-fold'), problems.length || good ? notes : []);
    assert.ok(notes.includes('phone-no-5ghz'));
  });
});

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

test('estados: carregando, nenhuma rede, dados chegando, lista velha com a idade escrita', T, async () => {
  await open({ route: '/ferramentas' }, async ({ page }) => {
    await waitForScans(page, 1);
    // 1. antes da primeira varredura: esqueleto, nada de números inventados
    await inject(page, { scan: null });
    await goto(page, '/melhor');
    await page.waitForSelector('.best-skel-hero');
    assert.equal(await page.locator('.best-hero, .best-row, .best-diag').count(), 0);
    assert.equal(await page.locator('[data-region="loading"] .skel').count() > 0, true);
    await shot(page, 'melhor-carregando');

    // 2. a varredura chega vazia: aviso amigável com "buscar de novo"
    await nextScan(page, { ...fx.apartment, aps: [] });
    await page.waitForSelector('.best-hero');
    assert.equal(await page.locator('.best-skel-hero, [data-region="loading"] .skel').count(), 0);
    assert.equal((await heroInfo(page)).hero, 'offline');
    assert.match(await page.textContent('[data-region="rank"] .empty__title'), /Nenhuma rede Wi-Fi ao alcance/);
    assert.equal(await page.locator('.best-filters, .best-more, [data-region="tip"] .banner').count(), 0);
    assert.equal(await page.locator('[data-action="open-best"]').count(), 0, 'sem ranking, "ver a melhor rede" não é oferecido');
    await page.click('[data-region="rank"] .empty .btn--primary');
    assert.match(await toastText(page), /As buscas estão em pausa agora/); // o teste parou o laço de buscas
    await shot(page, 'melhor-vazio');

    // 3. chegam redes: tudo aparece sem recarregar
    await page.evaluate((c) => window.__wrx.app.store.setConnection(c), HOME.connection);
    await nextScan(page, fx.apartment);
    await page.waitForSelector('.best-row');
    assert.equal((await heroInfo(page)).kind, 'switch-band');
    assert.equal(await page.locator('.best-hero__age').count(), 0, 'dado novo não ganha selo de idade');

    // 4. lista em cache de 45 s atrás: a idade vem escrita e as linhas aparecem apagadas
    await inject(page, { ...HOME, age: 45_000 });
    await page.waitForSelector('.best-hero__age');
    assert.match(await page.textContent('.best-hero__age'), /^Com base na busca de há 4\d\ss\.$/);
    assert.equal(await page.locator('.best-row.best-row--stale').count(), await page.locator('.best-row').count());
    assert.match(await page.locator('.best-row__where').first().textContent(), /visto há 4\d\ss/);
    await shot(page, 'melhor-dados-velhos');
  });
});

test('uma análise por varredura: leituras de sinal e a conexão reenviada não redesenham nada', T, async () => {
  await openWith(HOME, async ({ page }) => {
    await page.evaluate(() => {
      window.__mutations = 0;
      window.__observer = new MutationObserver((list) => {
        window.__mutations += list.length;
      });
      for (const region of document.querySelectorAll('.best-region')) window.__observer.observe(region, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    const before = await page.textContent('.best-hero__text');
    // dez leituras do sinal (uma por segundo, na vida real) e a conexão reenviada com outro sinal
    await page.evaluate((conn) => {
      const { store } = window.__wrx.app;
      for (let i = 0; i < 10; i++) {
        store.setRssi({ ts: Date.now() + i, rssi: -50 - i, bssid: conn.bssid, frequency: conn.frequency, linkSpeed: 100 + i });
        store.setConnection({ ...conn, rssi: -50 - i, linkSpeed: 100 + i });
      }
    }, HOME.connection);
    await settle(page);
    assert.equal(await page.evaluate(() => window.__mutations), 0, 'nada foi tocado na tela');
    assert.equal(await page.textContent('.best-hero__text'), before);

    // uma varredura nova, aí sim
    const moved = { ...fx.apartment, aps: fx.apartment.aps.map((a) => ({ ...a, level: a.bssid === HOME_24 ? -86 : a.level, ageMs: 100 })) };
    await settleScans(page, moved);
    assert.ok((await page.evaluate(() => window.__mutations)) > 0);
    assert.notEqual(await page.textContent('.best-hero__text'), before);
    await page.evaluate(() => window.__observer.disconnect());
  });
});

test('sair da tela fecha os painéis dela e não deixa nada rodando', T, async () => {
  await openWith(HOME, async ({ page }) => {
    await page.locator('.best-row').first().click();
    await page.waitForSelector('.best-sheet');
    await goto(page, '/ferramentas');
    await sheetClosed(page);
    assert.equal(await page.locator('.layer').count(), 0);
    // varreduras que chegam com a tela fechada não têm quem ouvir (nenhum erro)
    await nextScan(page, fx.apartment);
    await nextScan(page, fx.mesh);
    await goto(page, '/melhor');
    await page.waitForSelector('.best-row');
    assert.equal(await page.locator('.best-sheet').count(), 0);

    // "como a nota funciona" leva ao teste de velocidade e some junto com a tela
    await page.click('[data-region="rank"] .section-h .btn');
    await page.waitForSelector('.best-sheet');
    assert.match(await page.textContent('.best-sheet .sheet__title'), /Como a nota funciona/);
    assert.match(await page.textContent('.best-sheet .sheet__body'), /estimativa/);
    await page.evaluate(() => {
      window.__blockNav = (ev) => ev.stopImmediatePropagation();
      window.addEventListener('hashchange', window.__blockNav, true); // a ferramenta de velocidade não é carregada neste teste
    });
    await page.click('.best-sheet .sheet__footer .btn--primary');
    await page.waitForFunction(() => location.hash === '#/ferramentas/velocidade');
    await sheetClosed(page);
    await page.evaluate(() => {
      location.hash = '#/melhor';
    });
    await page.waitForFunction(() => location.hash === '#/melhor');
    await settle(page);
    await page.evaluate(() => window.removeEventListener('hashchange', window.__blockNav, true));

    // "voltar" sem nada aberto sai para a tela inicial
    assert.equal(await back(page), true);
    await waitForScreen(page, '/redes');
  });
});

// ---------------------------------------------------------------------------
// Temas e tamanhos
// ---------------------------------------------------------------------------

test('tema claro: mesma tela, cores do tema, texto legível', T, async () => {
  await openWith(
    HOME,
    async ({ page }) => {
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
      const colors = await page.evaluate(() => {
        const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
        return { card: css('.best-hero', 'backgroundColor'), headline: css('.best-hero__headline', 'color'), ring: css('.best-row .best-ring__value', 'stroke'), text: css('.best-hero__text', 'color') };
      });
      assert.equal(colors.card, 'rgb(255, 255, 255)');
      assert.equal(colors.headline, 'rgb(15, 23, 42)');
      assert.equal(colors.ring, 'rgb(4, 120, 87)', 'o anel usa o verde do tema claro');
      await shot(page, 'melhor-claro');
      await page.locator('.best-row').first().click();
      await page.waitForSelector('.best-sheet');
      await shot(page, 'melhor-claro-painel');
    },
    { params: { theme: 'light' }, colorScheme: 'light' },
  );
});

for (const viewport of ['small', 'landscape', 'tablet']) {
  test(`cabe em ${viewport}: sem rolagem para o lado, na tela e nos painéis`, T, async () => {
    await openWith(
      HOME,
      async ({ page }) => {
        assert.deepEqual(await horizontalOverflow(page), []);
        await page.click('.best-more');
        await settle(page);
        assert.deepEqual(await horizontalOverflow(page), []);
        // nomes compridos quebram em até duas linhas em vez de virar "Fam…"
        const clipped = await page.$$eval('.best-row__name .ssid', (els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
        assert.equal(clipped, 0, 'nenhum nome cortado para o lado');
        await shot(page, `melhor-${viewport}`);

        await page.evaluate(() => {
          document.querySelector('.view').scrollTop = 0;
        });
        await page.locator('.best-row').first().click();
        await page.waitForSelector('.best-sheet');
        assert.deepEqual(await horizontalOverflow(page), []);
        await shot(page, `melhor-${viewport}-painel`);
        await back(page);
        await sheetClosed(page);
        await page.click('[data-action="pick-mine"]');
        await page.waitForSelector('.best-picker');
        assert.deepEqual(await horizontalOverflow(page), []);
        await back(page);
        await sheetClosed(page, '.best-picker');
      },
      { viewport },
    );
  });
}
