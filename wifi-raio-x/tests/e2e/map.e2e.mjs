// Mapa 3D de ponta a ponta, contra o simulador: biblioteca -> levantamento (com a prévia ao vivo)
// -> cálculo -> resultado -> salvar -> reabrir -> ajustar a escala -> exportar -> apagar; mais o
// mapeamento "ponto a ponto" (Android limitando as buscas), a casa de dois andares, nomes hostis,
// o rascunho, o aparelho sem armazenamento e o visualizador 2D de reserva.
//
// Cada teste abre o app numa página nova; fechar a página falha o teste se houve erro,
// console.error, alert(), violação de CSP ou recurso que não carregou.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, withApp, shot, goto, back, settle, simEval, appState, horizontalOverflow } from './helpers.mjs';

const LONG = { timeout: 300_000 };
const T = { timeout: 150_000 };
const HOSTILE = '<img src=x onerror=alert(1)>';
const HOSTILE_NAME = '"><script>alert(2)</script>';
const SHARE = '[aria-label="Compartilhar ou exportar o mapa"]';

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

const text = (page, selector) => page.textContent(selector);
const hash = (page) => page.evaluate(() => location.hash);
const count = (page, selector) => page.locator(selector).count();
const device = (page) => simEval(page, (sim) => ({ keepAwake: sim.device.keepAwake, file: sim.device.lastFile ? { name: sim.device.lastFile.name, mime: sim.device.lastFile.mime, size: sim.device.lastFile.size } : null, share: sim.device.lastShare }));
const loopMode = (page) => page.evaluate(() => window.__wrx.app.scanLoop.getState().mode);
const toastWith = (page, pattern, timeout = 15_000) => page.waitForFunction((src) => [...document.querySelectorAll('.toast__text')].some((el) => new RegExp(src).test(el.textContent)), pattern.source, { timeout });
const resultReady = (page, timeout = 120_000) => page.waitForSelector('.mrs:not([hidden]) .mrs__stage canvas', { timeout });
/** Nada do texto hostil virou elemento na página. */
const noInjection = (page) => page.evaluate(() => document.querySelectorAll('img[src="x"], script:not([src]), [onerror], [onmouseover]').length);

/** Contadores do levantamento: [leituras, lugares marcados, roteadores]. */
const counters = (page) => page.$$eval('.msv-count__value', (els) => els.slice(0, 3).map((el) => Number(el.textContent)));

/**
 * Pede leituras direto à ponte até o levantamento ter `target` leituras (o laço do app pede uma a
 * cada 3 s de relógio; com o tempo do simulador acelerado isso seria uma leitura a cada dezenas de
 * metros andados — é o mesmo atalho do piloto da demonstração).
 */
async function pump(page, target, timeout = 90_000) {
  const t0 = Date.now();
  for (;;) {
    const [scans] = await counters(page);
    if (scans >= target) return scans;
    if (Date.now() - t0 > timeout) throw new Error(`só ${scans} de ${target} leituras em ${timeout} ms`);
    await page.evaluate(() => window.__wrx.app.bridge.scan().catch(() => null));
    await page.waitForTimeout(280);
  }
}

async function markPlace(page, label, { typed = false } = {}) {
  await page.click('.msv__bar .btn--primary');
  await page.waitForSelector('.msv-mark');
  if (typed) {
    await page.fill('.msv-mark__free input', label);
    await page.click('.msv-mark__free .btn--primary');
  } else {
    await page.locator('.msv-mark__chips .chip', { hasText: label }).first().click();
  }
  await page.waitForSelector('.msv-status[data-state="spot"]');
}

async function conclude(page) {
  await page.waitForSelector('.msv__finish:not([disabled])', { timeout: 60_000 });
  await page.click('.msv__finish');
  await resultReady(page);
  await settle(page);
}

/** Um levantamento manual curto (a pessoa virtual anda sozinha; o teste marca os lugares). */
async function quickSurvey(page, { places = ['Sala', 'Cozinha'], scans = 30 } = {}) {
  await page.waitForSelector('.msv__bar .btn--primary');
  let target = 4;
  await pump(page, target);
  for (const place of places) {
    await markPlace(page, place, { typed: place.includes('<') });
    target += 3;
    await pump(page, target);
    await page.click('.msv__bar .btn--primary'); // "Segui andando"
    await page.waitForSelector('.msv-status[data-state="walking"]');
    target += 3;
    await pump(page, target);
  }
  await pump(page, scans);
}

/** Põe no armazenamento do app um mapa pronto, feito de um levantamento simulado. */
function seedMap(page, { world = 'apartamento', name = 'Casa de teste', hostile = false, labels = true } = {}) {
  return page.evaluate(
    async (o) => {
      const { presetWorld } = await import('./js/sim/presets.js');
      const { planWalk, simulateSurvey } = await import('./js/sim/walk.js');
      const { createMapEngine } = await import('./js/mapping/engine.js');
      const { openMapStore } = await import('./js/mapping/storage.js');
      const w = presetWorld(o.world, 1);
      const { survey } = simulateSurvey(w, planWalk(w, { kind: 'spots' }), { labelRate: o.labels ? 1 : 0 });
      if (o.hostile) {
        const first = survey.scans.find((s) => s.spot !== null);
        for (const s of survey.scans) if (s.spot === first.spot) s.label = o.hostile;
      }
      const own = w.aps.filter((a) => a.own).map((a) => a.bssid);
      const engine = createMapEngine();
      const out = await engine.run(survey, { own });
      engine.dispose();
      const store = await openMapStore();
      const id = await store.put({ name: o.name, survey, solution: out.solution, own, meta: { ownSsids: [...new Set(w.aps.filter((a) => a.own).map((a) => a.ssid))] }, stats: { areaM2: out.model.quality.areaM2, level: out.model.quality.level }, demo: true });
      store.close();
      return { id, scans: survey.scans.length, floors: out.model.floors.length, rooms: out.model.floors.flatMap((f) => f.rooms.map((r) => r.label)) };
    },
    { world, name, hostile, labels },
  );
}

const savedMaps = (page) =>
  page.evaluate(async () => {
    const { openMapStore } = await import('./js/mapping/storage.js');
    const store = await openMapStore();
    const list = await store.list();
    const full = [];
    for (const row of list) {
      const rec = await store.get(row.id);
      full.push({ id: row.id, name: row.name, scans: rec.survey.scans.length, known: rec.survey.knownDistances || [], thumb: !!row.thumb, labels: [...new Set(rec.survey.scans.map((s) => s.label).filter(Boolean))], areaM2: row.stats.areaM2 });
    }
    const draft = await store.draft.load();
    store.close();
    return { kind: store.kind, maps: full, draft: draft ? { scans: draft.summary && draft.summary.scans, recordId: draft.recordId ?? null } : null };
  });

/**
 * Pede a imagem do mapa (menu de compartilhar) e conta as cores dela: o desenho do visualizador,
 * 3D ou 2D, não pode estar em branco.
 */
async function mapImage(page) {
  await simEval(page, (sim) => {
    sim.device.lastFile = null;
  });
  await page.click(SHARE);
  await page.locator('.map-actions .row', { hasText: 'Imagem do mapa' }).click();
  await page.waitForFunction(() => window.__e2eSim && window.__e2eSim().device.lastFile !== null, null, { timeout: 30_000 });
  const file = await simEval(page, (sim) => sim.device.lastFile);
  assert.equal(file.mime, 'image/png');
  assert.match(file.name, /^[a-z0-9-]+\.png$/);
  const stats = await page.evaluate(async (base64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${base64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = Math.max(1, Math.round((96 * img.height) / img.width));
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const colors = new Set();
    for (let i = 0; i < d.length; i += 4) colors.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
    return { width: img.width, height: img.height, colors: colors.size };
  }, file.base64);
  return { ...stats, size: file.size, name: file.name };
}

const openPanel = async (page) => {
  if ((await page.getAttribute('.mrs__handle', 'aria-expanded')) !== 'true' && (await page.locator('.mrs__handle').isVisible())) await page.click('.mrs__handle');
  await page.waitForSelector('.mrs__more .mrs-card');
};
const panelButton = (page, label) => page.locator('.mrs__more .btn', { hasText: label }).first();
const showChips = (page) => page.locator('.mrs-show .chip');

// ---------------------------------------------------------------------------
// O fluxo inteiro
// ---------------------------------------------------------------------------

test('fluxo completo: demonstração automática -> prévia -> resultado -> salvar -> reabrir -> escala -> exportar -> apagar', LONG, async () => {
  await withApp(env, { params: { world: 'apartamento' }, route: '/mapa' }, async ({ page }) => {
    // biblioteca: explicação honesta, três passos, mapa novo e a demonstração
    await page.waitForSelector('.mlib-hero');
    assert.equal(await count(page, '.mlib-step'), 3);
    assert.match(await text(page, '.mlib-hero__text'), /estimativa/);
    assert.match(await text(page, '.mlib-empty'), /Nenhum mapa salvo/);
    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'mapa-biblioteca');

    // demonstração automática: a tela fica ligada e as buscas aceleram
    await page.click('.mlib-demo');
    await page.waitForSelector('.msv');
    assert.equal(await hash(page), '#/mapa/novo');
    await page.waitForSelector('.msv-pilot');
    assert.equal((await device(page)).keepAwake, true);
    assert.equal(await loopMode(page), 'mapping');
    assert.match(await text(page, '.mini-plan__caption'), /Casa virtual \(só na demonstração\)/);
    // antes da prévia, o "radar" reage às leituras
    assert.equal(await page.locator('.msv-radar').isVisible(), true);
    await page.waitForSelector('.msv-preview__viewer:not([hidden]) canvas', { timeout: 60_000 });
    assert.equal(await page.locator('.msv-radar').isVisible(), false);
    assert.match(await text(page, '.msv-preview__tag'), /estimativa/);
    const [scansMid] = await counters(page);
    assert.ok(scansMid >= 5, `a prévia sai com poucas leituras (${scansMid})`);
    await shot(page, 'mapa-levantamento-piloto');

    // o piloto conclui sozinho: cálculo e resultado
    await resultReady(page);
    await settle(page);
    assert.equal(await hash(page), '#/mapa/ver/novo');
    assert.equal((await device(page)).keepAwake, false);
    assert.equal(await loopMode(page), 'normal');
    assert.equal(await text(page, '.topbar__title'), 'Casa virtual');
    assert.equal(await page.locator('.mrs__save').isVisible(), true);
    assert.ok((await savedMaps(page)).draft.scans >= 20, 'enquanto não é salvo, o levantamento continua guardado como rascunho');

    // o desenho não está em branco
    const first = await mapImage(page);
    assert.ok(first.colors >= 12, `mapa com ${first.colors} cores`);
    assert.ok(first.size > 8000);

    // mostrar: ambientes -> sinal de uma rede (legenda em dBm e palavras) -> relevo -> planta -> 3D
    assert.match(await text(page, '.mrs-legend'), /ambiente estimado/);
    const chips = showChips(page);
    assert.ok((await chips.count()) >= 2);
    await chips.nth(1).click();
    await page.waitForSelector('.mrs-legend__bar');
    assert.match(await text(page, '.mrs-legend__words'), /Muito fraco.*Fraco.*Regular.*Bom.*Ótimo/);
    assert.match(await text(page, '.mrs-legend__ticks'), /82.*75.*67.*60.*dBm/);
    assert.equal(await chips.nth(1).getAttribute('aria-pressed'), 'true');
    const is3d = (await count(page, '.mrs-tools__view')) === 1;
    if (is3d) {
      await page.click('.mrs-tools__relief');
      assert.equal(await page.getAttribute('.mrs-tools__relief', 'aria-pressed'), 'true');
      await page.locator('.mrs-tools__view .seg__opt', { hasText: 'Planta' }).click();
      await settle(page);
      await page.locator('.mrs-tools__view .seg__opt', { hasText: '3D' }).click();
    }
    const heat = await mapImage(page);
    assert.ok(heat.colors >= 12);
    await shot(page, 'mapa-resultado-sinal');

    // camadas: liga e desliga cada uma
    await openPanel(page);
    for (const key of ['path', 'spots', 'walls', 'routers', 'neighbours', 'labels']) {
      const chip = page.locator(`.mrs__more [data-layer="${key}"]`);
      const before = await chip.getAttribute('aria-pressed');
      await chip.click();
      assert.notEqual(await chip.getAttribute('aria-pressed'), before);
      await chip.click();
    }
    // cobertura (soma 100%), qualidade com o erro típico, e a explicação de como o mapa é feito
    const pcts = await page.$$eval('.mrs-cov__list strong', (els) => els.map((el) => parseInt(el.textContent, 10)));
    assert.equal(pcts.length, 4);
    assert.equal(pcts.reduce((a, b) => a + b, 0), 100);
    const body = await text(page, '.mrs__more');
    assert.match(body, /Melhor lugar/);
    assert.match(body, /Qualidade do mapa/);
    assert.match(body, /erro típico de ≈/);
    assert.match(body, /Só com o Wi-Fi/);
    assert.match(body, /girado ou espelhado/);
    assert.match(body, /ainda não foi salvo/);
    await shot(page, 'mapa-resultado-detalhes');

    // salvar com nome
    await page.click('.mrs-save .btn');
    await page.waitForSelector('.sheet input');
    assert.equal(await page.inputValue('.sheet input'), 'Casa virtual');
    await page.fill('.sheet input', 'Meu apê');
    await page.click('.sheet__footer .btn--primary');
    await toastWith(page, /Mapa salvo/);
    await page.waitForFunction(() => /^#\/mapa\/ver\/m[a-z0-9]+$/.test(location.hash));
    assert.equal(await text(page, '.topbar__title'), 'Meu apê');
    assert.equal(await page.locator('.mrs__save').isVisible(), false);
    let stored = await savedMaps(page);
    assert.equal(stored.maps.length, 1);
    assert.equal(stored.maps[0].name, 'Meu apê');
    assert.equal(stored.maps[0].thumb, true, 'a miniatura vai junto');
    assert.equal(stored.draft, null, 'salvo o mapa, o rascunho some');
    const id = stored.maps[0].id;
    const areaBefore = stored.maps[0].areaM2;

    // recarregar: o mapa abre do armazenamento
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await resultReady(page);
    assert.equal(await text(page, '.topbar__title'), 'Meu apê');

    // voltar: a biblioteca mostra o cartão com miniatura, nome, tamanho e qualidade
    assert.equal(await back(page), true);
    await page.waitForSelector('.mlib-map');
    assert.equal(await hash(page), '#/mapa');
    assert.equal(await text(page, '.mlib-map__name'), 'Meu apê');
    assert.match(await text(page, '.mlib-map__meta'), /m²/);
    assert.match(await text(page, '.mlib-map__foot'), /Qualidade (boa|razoável|fraca)/);
    assert.match(await page.getAttribute('.mlib-map__thumb img', 'src'), /^data:image\/(webp|jpeg);base64,/);
    await shot(page, 'mapa-biblioteca-com-mapa');

    // abrir de novo e ajustar a escala: o dobro da distância que o mapa estima entre dois lugares
    await page.click(`[data-map-id="${id}"]`);
    await resultReady(page);
    await openPanel(page);
    await panelButton(page, 'Ajustar a escala').click();
    await page.waitForSelector('.mrs-scale');
    const estimate = await text(page, '.mrs-scale__now');
    const meters = Number(estimate.match(/≈\s*([\d,]+)/)[1].replace(',', '.'));
    assert.ok(meters >= 1, `distância estimada: ${estimate}`);
    await page.fill('.mrs-scale input', 'abc');
    await page.click('.sheet__footer .btn--primary');
    assert.match(await text(page, '.mrs-scale .field__error'), /metros/);
    await page.fill('.mrs-scale input', String(meters * 2).replace('.', ','));
    await page.click('.sheet__footer .btn--primary');
    await toastWith(page, /Escala ajustada/, 60_000);
    stored = await savedMaps(page);
    assert.equal(stored.maps[0].known.length, 1);
    assert.equal(stored.maps[0].known[0].meters, meters * 2);
    assert.ok(stored.maps[0].areaM2 > areaBefore * 1.5, `o mapa cresceu: de ${areaBefore} para ${stored.maps[0].areaM2} m²`);
    await resultReady(page);

    // exportar o arquivo do mapa
    await page.click(SHARE);
    await page.locator('.map-actions .row', { hasText: 'Arquivo do mapa' }).click();
    await page.waitForFunction(() => /\.json$/.test((window.__e2eSim().device.lastFile || {}).name || ''));
    const exported = await simEval(page, (sim) => sim.device.lastFile);
    assert.equal(exported.name, 'meu-ape.wifi-raio-x.json');
    assert.equal(exported.mime, 'application/json');
    const fileData = JSON.parse(exported.text);
    assert.equal(fileData.format, 'wifi-raio-x.mapa');
    assert.equal(fileData.map.name, 'Meu apê');
    assert.equal(fileData.map.survey.knownDistances.length, 1);

    // resumo em texto
    await page.click(SHARE);
    await page.locator('.map-actions .row', { hasText: 'Resumo em texto' }).click();
    await page.waitForFunction(() => window.__e2eSim().device.lastShare !== null);
    assert.match((await device(page)).share.text, /Mapa aproximado, feito só com o sinal do Wi-Fi/);

    // apagar (com confirmação)
    await openPanel(page);
    await panelButton(page, 'Apagar mapa').click();
    await page.waitForSelector('.dialog');
    await page.click('.dialog .btn--quiet');
    assert.equal((await savedMaps(page)).maps.length, 1, 'cancelar não apaga');
    await panelButton(page, 'Apagar mapa').click();
    await page.click('.dialog .btn--danger');
    await page.waitForSelector('.mlib-empty');
    assert.equal(await hash(page), '#/mapa');
    assert.equal((await savedMaps(page)).maps.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Variantes
// ---------------------------------------------------------------------------

test('ponto a ponto: com o Android limitando as buscas, o passo inicial explica e o levantamento conta a espera', T, async () => {
  await withApp(env, { params: { world: 'apartamento', throttle: 1, speed: 20 }, route: '/mapa' }, async ({ page }) => {
    await page.waitForSelector('.mlib-hero');
    await page.waitForFunction(() => window.__wrx.app.store.get().loop.throttled === true, null, { timeout: 60_000 });
    await page.click('.mlib-hero .btn');
    await page.waitForSelector('.map-start');
    assert.match(await text(page, '.map-start .banner'), /ponto a ponto/);
    assert.match(await text(page, '.map-start .banner'), /30 segundos/);
    assert.equal(await count(page, '.map-tip'), 3);
    assert.ok((await count(page, '.map-nets__row')) >= 1, 'as redes do usuário vêm para escolher');
    assert.equal(await page.isChecked('.map-nets__row >> nth=0 >> input'), true, 'a rede conectada já vem marcada');
    await shot(page, 'mapa-antes-de-comecar-limitado');
    // a ajuda do limite é a mesma do resto do app
    await page.locator('.map-start .banner .btn').click();
    await page.waitForSelector('text=Limitação da busca por Wi-Fi');
    await back(page);
    await page.waitForSelector('.map-start');
    assert.match(await text(page, '.sheet__footer .btn--primary'), /ponto a ponto/);
    await page.click('.sheet__footer .btn--primary');

    await page.waitForSelector('.msv');
    assert.equal(await page.isDisabled('.msv__finish'), true);
    await markPlace(page, 'Cozinha');
    assert.match(await text(page, '.msv-status__title'), /Parado em: Cozinha/);
    assert.match(await text(page, '.msv-status__detail'), /Fique parado até a leitura chegar/);
    // a leitura pedida ao marcar chega e o ponto fica pronto com UMA leitura
    await page.waitForFunction(() => /1 leitura aqui/.test(document.querySelector('.msv-status__detail')?.textContent || ''), null, { timeout: 60_000 });
    assert.match(await text(page, '.msv-status__detail'), /Pode seguir/);
    assert.equal((await counters(page))[1], 1);
    await page.click('.msv__bar .btn--primary');
    await page.waitForSelector('.msv-status[data-state="walking"]');
    // andando: contagem regressiva até a próxima leitura (≈ 30 s) e o que falta para concluir
    await page.waitForSelector('.msv-ring__num', { timeout: 30_000 });
    assert.match(await text(page, '.msv-status__detail'), /leituras a cada ≈ 30/);
    assert.match(await text(page, '.msv__bar-note'), /faltam \d+ lugares marcados|faltam \d+ leituras/);
    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'mapa-levantamento-ponto-a-ponto');
  });
});

test('casa de dois andares: o piloto troca de andar e o resultado tem seletor de andar e "separar andares"', LONG, async () => {
  await withApp(env, { params: { world: 'sobrado' }, route: '/mapa' }, async ({ page }) => {
    await page.click('.mlib-demo');
    await page.waitForSelector('.msv-pilot');
    await resultReady(page, 240_000);
    await settle(page);
    const floors = page.locator('.mrs-floors .chip');
    assert.deepEqual(await floors.allTextContents(), ['Todos', 'Térreo', '1º andar']);
    await floors.nth(2).click();
    assert.equal(await floors.nth(2).getAttribute('aria-pressed'), 'true');
    await floors.nth(0).click();
    await openPanel(page);
    if ((await count(page, '.mrs-tools__view')) === 1) {
      assert.match(await text(page, '.mrs__more'), /Separar andares/);
      await page.locator('.mrs__more input[type="range"]').fill('90');
    }
    assert.match(await text(page, '.mrs__more'), /2 andares|andar/);
    const image = await mapImage(page);
    assert.ok(image.colors >= 12);
    await shot(page, 'mapa-resultado-sobrado');
  });
});

test('controle de andar no levantamento: "Térreo / 1º andar / Subsolo" e o aviso quando a pessoa virtual troca de andar', T, async () => {
  await withApp(env, { params: { world: 'sobrado', speed: 10, walk: 'still' }, route: '/mapa/novo' }, async ({ page }) => {
    await page.waitForSelector('.msv-floor');
    const value = () => text(page, '.msv-floor__value');
    assert.equal(await value(), 'Térreo');
    await page.click('[aria-label="Subi um andar"]');
    assert.equal(await value(), '1º andar');
    await page.click('[aria-label="Desci um andar"]');
    await page.click('[aria-label="Desci um andar"]');
    assert.equal(await value(), 'Subsolo');
    await page.click('[aria-label="Subi um andar"]');
    assert.equal(await value(), 'Térreo');
    // a pessoa virtual sobe a escada: o app sugere avisar
    await simEval(page, (sim) => {
      sim.walker.setMode('manual');
      sim.walker.setFloor(1);
    });
    await page.waitForSelector('.msv__body .banner', { timeout: 90_000 });
    assert.match(await text(page, '.msv__body .banner'), /A pessoa virtual foi para: 1º andar/);
    await page.click('.msv__body .banner .btn');
    assert.equal(await value(), '1º andar');
    assert.equal(await count(page, '.msv__body .banner'), 0);
  });
});

test('nome hostil: o lugar digitado e o nome do mapa aparecem como texto em todo lugar', LONG, async () => {
  await withApp(env, { params: { world: 'apartamento', speed: 10 }, route: '/mapa/novo' }, async ({ page }) => {
    await quickSurvey(page, { places: [HOSTILE, 'Cozinha'], scans: 30 });
    // no levantamento: chip "já marcado" com o texto exato
    await page.click('.msv__bar .btn--primary');
    await page.waitForSelector('.msv-mark');
    assert.equal(await page.locator('.msv-mark__used', { hasText: HOSTILE }).count(), 1);
    assert.equal(await noInjection(page), 0);
    await shot(page, 'mapa-marcar-nome-hostil');
    await back(page);

    await conclude(page);
    assert.equal(await noInjection(page), 0);
    // no resultado: lista de lugares do ajuste de escala e cartões
    await openPanel(page);
    await panelButton(page, 'Ajustar a escala').click();
    await page.waitForSelector('.mrs-scale select');
    const options = await page.$$eval('.mrs-scale select >> nth=0 >> option', (els) => els.map((el) => el.textContent));
    assert.ok(options.includes(HOSTILE), `opções: ${options.join(' | ')}`);
    await back(page);

    // o mapa salvo com nome hostil: barra de cima, biblioteca e arquivo
    await page.click('.mrs-save .btn');
    await page.fill('.sheet input', HOSTILE_NAME);
    await page.click('.sheet__footer .btn--primary');
    await toastWith(page, /Mapa salvo/);
    assert.equal(await text(page, '.topbar__title'), HOSTILE_NAME);
    const stored = await savedMaps(page);
    assert.ok(stored.maps[0].labels.includes(HOSTILE));
    await back(page);
    await page.waitForSelector('.mlib-map');
    assert.equal(await text(page, '.mlib-map__name'), HOSTILE_NAME);
    assert.equal(await noInjection(page), 0);
    await shot(page, 'mapa-biblioteca-nome-hostil');
    // menu do cartão: renomear continua tratando como texto
    await page.click('.mlib-map__more');
    assert.equal(await text(page, '.sheet__title'), HOSTILE_NAME);
    await back(page);
  });
});

test('nome hostil num mapa salvo: toque no ambiente, renomear e os rótulos do mapa não viram HTML', T, async () => {
  await withApp(env, { params: { world: 'apartamento' }, route: '/redes' }, async ({ page }) => {
    const seeded = await seedMap(page, { name: 'Apê', hostile: HOSTILE });
    assert.ok(seeded.rooms.includes(HOSTILE));
    await goto(page, `/mapa/ver/${seeded.id}`);
    await resultReady(page);
    await settle(page);
    // toca pelo mapa até abrir o cartão de um ambiente
    const box = await page.locator('.mrs__stage canvas').first().boundingBox();
    let opened = false;
    for (const [fx, fy] of [[0.5, 0.42], [0.4, 0.38], [0.6, 0.45], [0.5, 0.33], [0.35, 0.47], [0.65, 0.36], [0.45, 0.5]]) {
      await page.touchscreen.tap(box.x + box.width * fx, box.y + box.height * fy);
      try {
        await page.waitForSelector('.mrs-pick [aria-label="Renomear este ambiente"]', { timeout: 1500 });
        opened = true;
        break;
      } catch {
        if (await count(page, '.mrs-pick')) await page.click('.mrs-pick [aria-label="Fechar detalhes"]');
      }
    }
    assert.equal(opened, true, 'um toque no mapa abre o cartão do ambiente');
    assert.match(await text(page, '.mrs-pick'), /Área ≈|Área aproximada/);
    assert.match(await text(page, '.mrs-pick'), /Sinal médio neste ambiente/);
    await shot(page, 'mapa-resultado-cartao-ambiente');
    // renomear o ambiente com outro texto hostil: vai para o levantamento guardado, como texto
    await page.click('.mrs-pick [aria-label="Renomear este ambiente"]');
    await page.fill('.sheet input', '<b onmouseover=alert(3)>Sala</b>');
    await page.click('.sheet__footer .btn--primary');
    await toastWith(page, /Ambiente renomeado/);
    assert.equal(await noInjection(page), 0);
    const stored = await savedMaps(page);
    assert.ok(stored.maps[0].labels.includes('<b onmouseover=alert(3)>Sala</b>'));
    await resultReady(page);
    const image = await mapImage(page);
    assert.ok(image.colors >= 12);
    assert.equal(await noInjection(page), 0);
  });
});

test('rascunho: sair no meio (o "voltar" pergunta), recarregar e continuar de onde parou', T, async () => {
  await withApp(env, { params: { world: 'apartamento', speed: 10 }, route: '/mapa' }, async ({ page }) => {
    await page.click('.mlib-hero .btn');
    await page.waitForSelector('.map-start');
    await page.click('.sheet__footer .btn--primary');
    await page.waitForSelector('.msv');
    await pump(page, 6);
    await markPlace(page, 'Sala');
    await pump(page, 9);
    const [scans, places] = await counters(page);
    assert.ok(scans >= 9 && places === 1);

    // "voltar" do Android: pergunta; "continuar" fica; "sair" guarda o rascunho
    assert.equal(await back(page), true);
    await page.waitForSelector('.dialog');
    assert.match(await text(page, '.dialog'), /Sair do mapeamento\?/);
    assert.match(await text(page, '.dialog'), /rascunho/);
    await page.click('.dialog .btn--quiet');
    assert.equal(await hash(page), '#/mapa/novo');
    assert.equal(await back(page), true);
    await page.click('.dialog .btn--primary');
    await page.waitForSelector('.mlib-draft');
    assert.equal((await device(page)).keepAwake, false);
    assert.equal(await loopMode(page), 'normal');
    assert.match(await text(page, '.mlib-draft'), /Mapeamento em andamento/);
    const draftCard = (await text(page, '.mlib-draft')).match(/(\d+) leituras · 1 lugar marcado/);
    assert.ok(draftCard && Number(draftCard[1]) >= scans, `o cartão conta as leituras guardadas (${draftCard && draftCard[0]})`);
    await shot(page, 'mapa-biblioteca-rascunho');

    // recarregar a página: o rascunho continua lá
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await page.waitForSelector('.mlib-draft');
    await page.locator('.mlib-draft .btn', { hasText: 'Continuar' }).click();
    await page.waitForSelector('.msv');
    await toastWith(page, /retomado/);
    const [after, placesAfter] = await counters(page);
    assert.ok(after >= scans, `continua com as ${scans} leituras (tem ${after})`);
    assert.equal(placesAfter, 1);
    // o chip do lugar já marcado aparece no painel
    await page.click('.msv__bar .btn--primary');
    assert.equal(await page.locator('.msv-mark__used', { hasText: 'Sala' }).count(), 1);
    await back(page);

    // pausa e retomada
    await page.locator('.msv__bar-row .btn', { hasText: 'Pausar' }).click();
    assert.match(await text(page, '.msv-status__title'), /Em pausa/);
    assert.match(await text(page, '.msv__bar .btn--primary'), /Retomar/);
    await page.click('.msv__bar .btn--primary');
    await page.waitForSelector('.msv-status[data-state="walking"]');
    // desfazer a última leitura
    await pump(page, after + 2);
    const [beforeUndo] = await counters(page);
    await page.locator('.msv__bar-row .btn', { hasText: 'Desfazer' }).click();
    await page.waitForFunction((n) => Number(document.querySelector('.msv-count__value').textContent) === n - 1, beforeUndo);

    // trocar de aba também guarda; começar outro mapa pergunta antes de descartar
    await goto(page, '/redes');
    await goto(page, '/mapa');
    await page.waitForSelector('.mlib-draft');
    await page.click('.mlib-hero .btn');
    await page.waitForSelector('.dialog');
    assert.match(await text(page, '.dialog'), /será descartado/);
    await page.click('.dialog .btn--quiet');
    // descartar pelo cartão
    await page.locator('.mlib-draft .btn', { hasText: 'Descartar' }).click();
    await page.click('.dialog .btn--danger');
    await page.waitForFunction(() => !document.querySelector('.mlib-draft'));
    assert.equal((await savedMaps(page)).draft, null);
  });
});

test('continuar um mapa salvo: as leituras novas entram no mesmo mapa', LONG, async () => {
  await withApp(env, { params: { world: 'apartamento', speed: 10 }, route: '/redes' }, async ({ page }) => {
    const seeded = await seedMap(page, { name: 'Apê' });
    await goto(page, `/mapa/ver/${seeded.id}`);
    await resultReady(page);
    await openPanel(page);
    await panelButton(page, 'Continuar mapeando').click();
    await page.waitForSelector('.msv');
    assert.equal(await text(page, '.topbar__title'), 'Continuar o mapa');
    const [startScans] = await counters(page);
    assert.equal(startScans, seeded.scans);
    await pump(page, seeded.scans + 6);
    await conclude(page);
    assert.equal(await hash(page), '#/mapa/ver/novo');
    assert.equal(await text(page, '.topbar__title'), 'Apê');
    await openPanel(page);
    assert.match(await text(page, '.mrs-save'), /Mapa atualizado, ainda não salvo/);
    await page.click('.mrs-save .btn');
    assert.equal(await page.inputValue('.sheet input'), 'Apê');
    await page.click('.sheet__footer .btn--primary');
    await toastWith(page, /Mapa salvo/);
    const stored = await savedMaps(page);
    assert.equal(stored.maps.length, 1, 'atualiza o mesmo mapa, sem criar outro');
    assert.equal(stored.maps[0].id, seeded.id);
    assert.ok(stored.maps[0].scans >= seeded.scans + 6);
  });
});

test('cálculo: dá para cancelar e voltar ao levantamento sem perder nada', T, async () => {
  await withApp(env, { params: { world: 'apartamento', speed: 10 }, route: '/mapa/novo' }, async ({ page }) => {
    await quickSurvey(page, { places: ['Sala'], scans: 28 });
    // segura o cálculo para dar tempo de ver a tela de progresso e cancelar
    await page.evaluate(() => {
      const real = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, transfer) {
        if (message && message.type === 'run' && !message.quick) return; // o cálculo final nunca termina
        real.call(this, message, transfer);
      };
    });
    await page.click('.msv__finish');
    await page.waitForSelector('.mproc');
    assert.match(await text(page, '.mproc'), /Montando o mapa/);
    assert.match(await text(page, '.mproc'), /calculado aqui no celular/);
    assert.equal(await back(page), true, 'o "voltar" não abandona o cálculo por engano');
    assert.equal(await count(page, '.mproc'), 1);
    await shot(page, 'mapa-calculando');
    await page.locator('.mproc .btn', { hasText: 'Cancelar' }).click();
    await page.waitForSelector('.msv:not([hidden])');
    await toastWith(page, /Cálculo cancelado/);
    assert.match(await text(page, '.msv-status__title'), /Em pausa/);
    assert.ok((await counters(page))[0] >= 28);
    assert.ok((await savedMaps(page)).draft.scans >= 28);
  });
});

test('sem armazenamento: o mapa aparece do mesmo jeito e salvar explica o problema', LONG, async () => {
  const before = async (page) => {
    await page.addInitScript(() => {
      // aparelho que não deixa gravar nada: nem IndexedDB nem localStorage
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('negado', 'SecurityError');
        },
      });
    });
  };
  await withApp(env, { params: { world: 'apartamento', speed: 10 }, route: '/mapa', before }, async ({ page }) => {
    await page.waitForSelector('.mlib-hero');
    await page.waitForSelector('.mlib .banner');
    assert.match(await text(page, '.mlib .banner'), /não ficarão salvos/);
    await shot(page, 'mapa-biblioteca-sem-armazenamento');
    await page.click('.mlib-hero .btn');
    await page.click('.sheet__footer .btn--primary');
    await quickSurvey(page, { places: ['Sala'], scans: 28 });
    await conclude(page);
    const image = await mapImage(page);
    assert.ok(image.colors >= 12, 'o mapa aparece mesmo sem ter onde gravar');
    await page.click('.mrs__save');
    await page.waitForSelector('.sheet input');
    assert.match(await text(page, '.sheet__subtitle'), /não deixou o app gravar/);
    await page.click('.sheet__footer .btn--primary');
    await toastWith(page, /até você fechar o app/);
    await back(page);
    await page.waitForSelector('.mlib-map');
    assert.equal(await count(page, '.mlib-map'), 1, 'enquanto o app está aberto o mapa fica na lista');
  });
});

test('visualizador 2D de reserva, tema claro, 360 px e tela deitada', T, async () => {
  let id;
  await withApp(env, { params: { world: 'sobrado', theme: 'light' }, route: '/redes', viewport: 'small', colorScheme: 'light' }, async ({ page }) => {
    id = (await seedMap(page, { world: 'sobrado', name: 'Sobrado claro' })).id;
    await goto(page, `/mapa/ver/${id}?visual=2d`);
    await page.waitForSelector('.mrs:not([hidden]) .mrs__stage canvas');
    await settle(page);
    assert.equal(await count(page, '.mrs-tools__view'), 0, 'em 2D não há 3D / Planta');
    assert.equal(await count(page, '.mrs-tools__relief'), 0);
    assert.match(await text(page, '.mrs-tools__flat'), /planta/);
    assert.match(await text(page, '.mrs__note'), /não desenha em 3D/);
    await showChips(page).nth(1).click();
    await page.waitForSelector('.mrs-legend__bar');
    const image = await mapImage(page);
    assert.ok(image.colors >= 12, `mapa 2D com ${image.colors} cores`);
    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'mapa-resultado-2d-claro-360');
    await openPanel(page);
    assert.doesNotMatch(await text(page, '.mrs__more'), /Separar andares/);
    assert.deepEqual(await horizontalOverflow(page), []);
    await back(page); // fecha o painel
    await back(page); // volta para a biblioteca
    await page.waitForSelector('.mlib-map');
    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'mapa-biblioteca-claro-360');
    await page.click('.mlib-hero .btn');
    await page.click('.sheet__footer .btn--primary');
    await page.waitForSelector('.msv');
    await settle(page);
    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'mapa-levantamento-claro-360');
  });
  await withApp(env, { params: { world: 'sobrado' }, route: '/redes', viewport: 'landscape' }, async ({ page }) => {
    const seeded = await seedMap(page, { world: 'sobrado', name: 'Sobrado deitado' });
    await goto(page, `/mapa/ver/${seeded.id}`);
    await resultReady(page);
    await settle(page);
    // deitado, o painel é uma coluna ao lado e o mapa fica com o resto
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('.mrs__panel').getBoundingClientRect();
      const stage = document.querySelector('.mrs__stage').getBoundingClientRect();
      return { panelLeft: panel.left, panelHeight: panel.height, stageHeight: stage.height, stageRight: stage.right, handle: getComputedStyle(document.querySelector('.mrs__handle')).display };
    });
    assert.equal(layout.handle, 'none');
    assert.ok(layout.panelLeft > 300 && Math.abs(layout.panelHeight - layout.stageHeight) < 2);
    assert.match(await text(page, '.mrs__panel'), /Cobertura ·/);
    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'mapa-resultado-deitado');
    await goto(page, '/mapa/novo');
    await page.waitForSelector('.msv');
    await settle(page);
    assert.deepEqual(await horizontalOverflow(page), []);
    await shot(page, 'mapa-levantamento-deitado');
  });
});

test('biblioteca: renomear, exportar e importar de volta (arquivo colado), arquivo inválido e mapa que não existe', T, async () => {
  await withApp(env, { params: { world: 'apartamento' }, route: '/redes' }, async ({ page }) => {
    const seeded = await seedMap(page, { name: 'Original' });
    await goto(page, '/mapa');
    await page.waitForSelector('.mlib-map');
    // renomear pelo menu do cartão
    await page.click('.mlib-map__more');
    await page.locator('.map-actions .row', { hasText: 'Renomear' }).click();
    await page.fill('.sheet input', 'Casa da praia');
    await page.click('.sheet__footer .btn--primary');
    await toastWith(page, /renomeado/);
    assert.equal(await text(page, '.mlib-map__name'), 'Casa da praia');

    // exporta (pelo armazenamento), apaga pelo menu e importa de volta colando o conteúdo
    const fileText = await page.evaluate(async (mapId) => {
      const { openMapStore } = await import('./js/mapping/storage.js');
      const store = await openMapStore();
      const out = await store.exportMap(mapId);
      store.close();
      return out;
    }, seeded.id);
    await page.click('.mlib-map__more');
    await page.locator('.map-actions .row', { hasText: 'Apagar' }).click();
    await page.click('.dialog .btn--danger');
    await page.waitForSelector('.mlib-empty');

    await page.locator('.section-h .btn', { hasText: 'Importar' }).click();
    await page.waitForSelector('.map-import');
    await page.fill('.map-import__text', '{"isto":"não é um mapa"}');
    await page.click('.sheet__footer .btn--primary');
    await toastWith(page, /não é um mapa/);
    assert.equal(await count(page, '.map-import'), 1, 'o painel continua aberto para tentar de novo');
    await page.fill('.map-import__text', fileText);
    await page.click('.sheet__footer .btn--primary');
    await toastWith(page, /Mapa importado/);
    await page.waitForSelector('.mlib-map');
    assert.equal(await text(page, '.mlib-map__name'), 'Casa da praia');
    // escolher um arquivo também funciona
    await page.locator('.section-h .btn', { hasText: 'Importar' }).click();
    await page.setInputFiles('.map-import input[type="file"]', { name: 'mapa.json', mimeType: 'application/json', buffer: Buffer.from(fileText) });
    await page.waitForFunction(() => document.querySelectorAll('.mlib-map').length === 2);

    // um endereço de mapa que não existe mais
    await goto(page, '/mapa/ver/mnaoexiste');
    await page.waitForSelector('.empty');
    assert.match(await text(page, '.empty'), /Este mapa não existe mais/);
    await page.locator('.btn', { hasText: 'Voltar para os mapas' }).click();
    await page.waitForSelector('.mlib-map');
    // sub-rota desconhecida volta para a biblioteca
    await page.evaluate(() => {
      location.hash = '#/mapa/qualquer/coisa/errada';
    });
    await page.waitForFunction(() => location.hash === '#/mapa');
  });
});
