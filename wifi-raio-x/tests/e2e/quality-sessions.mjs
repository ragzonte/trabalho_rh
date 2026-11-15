// Sessões de levantamento conduzidas no app de verdade (Playwright + simulador), para medir a
// qualidade do mapa que o usuário recebe: veja quality.mjs. Usadas por map-quality.e2e.mjs.
//
//   pilotSession(env, { world, seed, throttle, fakeClock })               a demonstração automática
//   manualSession(env, { world, seed, throttle, labels, fakeClock })      uma pessoa usando os botões da tela
//
// Com `fakeClock` o relógio da página é o do Playwright (page.clock): o app roda na velocidade 1
// do simulador — o ritmo de um celular de verdade — e o teste adianta o tempo em vez de esperar.
import { openApp, settle, simEval } from './helpers.mjs';
import { installProbe, readProbe, savedRecord, evaluateSession, HARD_PLACES, hardWorld, loadHardPlace } from './quality.mjs';

const RESULT = '.mrs:not([hidden]) .mrs__stage canvas';

/** Adianta o relógio falso da página até `done()` valer (ou estourar o prazo, em segundos de app). */
async function advanceUntil(page, done, { stepMs = 1000, limitS = 3600, what = 'a condição' } = {}) {
  for (let spent = 0; spent < limitS * 1000; spent += stepMs) {
    if (await done()) return spent / 1000;
    await page.clock.runFor(stepMs);
    // o que não depende do relógio da página (Worker do mapa, IndexedDB) anda sozinho
    await page.evaluate(() => new Promise((resolve) => queueMicrotask(resolve)));
  }
  throw new Error(`${what} não aconteceu em ${limitS} s de app`);
}

async function saveMap(page, name) {
  await page.click('.mrs__save');
  await page.waitForSelector('.sheet input');
  await page.fill('.sheet input', name);
  await page.click('.sheet__footer .btn--primary');
  await page.waitForFunction(() => /^#\/mapa\/ver\/m[a-z0-9]+$/.test(location.hash), null, { timeout: 30_000 });
}

/** O que a tela de resultado diz (para conferir que o texto bate com o mapa). */
async function resultTexts(page) {
  return page.evaluate(() => ({
    legend: document.querySelector('.mrs-legend')?.textContent || '',
    show: [...document.querySelectorAll('.mrs-show .chip')].map((el) => el.textContent.trim()),
    noMap: document.querySelector('.mrs-nomap')?.textContent || null,
    invite: document.querySelector('.mrs-invite')?.textContent || null,
    quality: [...document.querySelectorAll('.mrs__more .mrs-card')].find((el) => /Qualidade do mapa|Por que não há mapa/.test(el.textContent))?.textContent || '',
    canvases: document.querySelectorAll('.mrs__stage canvas').length,
  }));
}

async function finishSession(app, name, world) {
  const { page } = app;
  await settle(page);
  const ui = await resultTexts(page);
  await saveMap(page, name);
  const probe = await readProbe(page);
  const record = await savedRecord(page);
  const metrics = evaluateSession({ probe, record, world });
  return { ...metrics, ui };
}

/**
 * A demonstração automática, do toque em "Ver uma demonstração" ao mapa salvo.
 * @param {object} o  world, seed, throttle; fakeClock (adianta o relógio em vez de esperar)
 */
export async function pilotSession(env, { world = 'apartamento', seed, throttle = false, fakeClock = false, timeoutMs = 600_000 } = {}) {
  const params = { world, seed, throttle: throttle ? 1 : undefined };
  const app = await openApp(env, { params, route: '/mapa', before: fakeClock ? (page) => page.clock.install() : undefined });
  const { page } = app;
  let failed = true;
  try {
    await page.waitForSelector('.mlib-demo');
    await installProbe(page);
    await page.click('.mlib-demo');
    await page.waitForSelector('.msv-pilot', { timeout: 30_000 });
    if (fakeClock) await advanceUntil(page, async () => (await page.locator(RESULT).count()) > 0, { limitS: 3600, what: 'o resultado do piloto' });
    else await page.waitForSelector(RESULT, { timeout: timeoutMs });
    const out = await finishSession(app, `Ensaio ${world}`);
    failed = false;
    return out;
  } finally {
    await app.close({ check: !failed });
  }
}

/**
 * Uma pessoa usando a tela: anda de cômodo em cômodo (o ensaio manda a pessoa virtual para lá, como
 * quem anda pela própria casa), toca em "Marcar este lugar", escolhe ou digita o nome, espera as
 * leituras, toca em "Segui andando" e, no fim, dá mais uma volta pela casa e toca em "Concluir".
 * O ritmo das leituras é o do app (laço de buscas), não o do piloto.
 * @param {object} o  world, seed, throttle; labels: false = marca os lugares sem dar nome;
 *                    spots: false = só anda, sem marcar nada; extraSpots: lugares a mais, em outros
 *                    cantos dos mesmos cômodos (no modo ponto a ponto o app pede 12 ou mais);
 *                    tourS: segundos de volta livre no fim
 */
export async function manualSession(env, { world = 'apartamento', seed, throttle = false, labels = true, spots = true, extraSpots = 0, tourS = 150, still = false, maxS = 0 } = {}) {
  const params = { world, seed, throttle: throttle ? 1 : undefined, speed: 1 };
  const app = await openApp(env, { params, route: '/mapa', before: (page) => page.clock.install() });
  const { page } = app;
  let failed = true;
  // adianta o relógio e, se a tela avisar que a pessoa virtual trocou de andar, toca no aviso
  // (numa casa de verdade é o usuário quem ajusta o controle "Andar" ao subir ou descer)
  const run = async (ms) => {
    for (let left = ms; left > 0; left -= 2000) {
      await page.clock.runFor(Math.min(2000, left));
      const nudge = page.locator('.msv__body .banner button', { hasText: /^Marcar / });
      if ((await nudge.count()) > 0) await nudge.first().click();
    }
  };
  const stats = () => page.$$eval('.msv-count__value', (els) => els.slice(0, 3).map((el) => Number(el.textContent)));
  try {
    await page.waitForSelector('.mlib-hero');
    await installProbe(page, { everyMs: 100 });
    // "Novo mapa" -> painel "Antes de começar" -> começar
    await page.locator('.mlib-hero .btn', { hasText: 'Novo mapa' }).click();
    await page.waitForSelector('.sheet .map-start');
    await page.click('.sheet__footer .btn--primary');
    await page.waitForSelector('.msv__bar .btn--primary');
    if (still) await simEval(page, (sim) => sim.walker.setMode('still'));

    if (spots && !still) {
      const rooms = await simEval(page, (sim) => sim.world.rooms.map((r) => ({ name: r.name, x: r.centroid.x, y: r.centroid.y, floor: r.floor })));
      let floorNow = await simEval(page, (sim) => sim.truth().floor);
      const floor0 = floorNow;
      // do cômodo mais perto para o mais longe, um andar de cada vez
      const here = await simEval(page, (sim) => sim.truth());
      rooms.sort((a, b) => Math.abs(a.floor - here.floor) - Math.abs(b.floor - here.floor) || Math.hypot(a.x - here.x, a.y - here.y) - Math.hypot(b.x - here.x, b.y - here.y));
      // lugares a mais: outros cantos dos mesmos cômodos (pontos livres sorteados com semente fixa)
      const more = extraSpots > 0 ? await simEval(page, (sim, n) => {
        const w = sim.world;
        let state = 12345;
        const rnd = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648);
        const out = [];
        for (let guard = 0; guard < 4000 && out.length < n; guard++) {
          const room = w.rooms[Math.floor(rnd() * w.rooms.length)];
          const xs = room.polygon.map((p) => p[0]);
          const ys = room.polygon.map((p) => p[1]);
          const x = Math.min(...xs) + rnd() * (Math.max(...xs) - Math.min(...xs));
          const y = Math.min(...ys) + rnd() * (Math.max(...ys) - Math.min(...ys));
          if (w.roomAt(x, y, room.floor) !== room || !w.isFree(x, y, room.floor, 0.5)) continue;
          if (Math.hypot(x - room.centroid.x, y - room.centroid.y) < 1.2 || out.some((q) => q.floor === room.floor && Math.hypot(q.x - x, q.y - y) < 1.5)) continue;
          out.push({ name: room.name, x, y, floor: room.floor });
        }
        return out;
      }, extraSpots) : [];
      for (const room of [...rooms, ...more]) {
        const ok = await simEval(page, (sim, r) => sim.walker.goTo(r.x, r.y, r.floor), room);
        if (!ok) continue;
        // anda até chegar (parou de se mexer)
        await run(1500);
        await advanceUntil(
          page,
          async () => {
            // trocou de andar no caminho: avisa na hora, pelo controle "Andar", como o usuário faria
            const now = await simEval(page, (sim) => sim.truth());
            if (now.floor !== floorNow) {
              const up = now.floor > floorNow;
              for (let k = 0; k < Math.abs(now.floor - floorNow); k++) await page.click(up ? '[aria-label="Subi um andar"]' : '[aria-label="Desci um andar"]');
              floorNow = now.floor;
            }
            return !now.moving;
          },
          { stepMs: 500, limitS: 240, what: `chegar em ${room.name}` },
        );
        const at = await simEval(page, (sim) => sim.truth());
        if (at.room !== room.name) continue; // parou fora do cômodo: não marca com o nome errado
        await page.click('.msv__bar .btn--primary'); // "Marcar este lugar"
        await page.waitForSelector('.msv-mark');
        if (!labels) await page.locator('.sheet__footer .btn', { hasText: 'Marcar sem nome' }).click();
        else {
          const chip = page.locator('.msv-mark__chips .chip', { hasText: new RegExp(`^${room.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
          if ((await chip.count()) > 0) await chip.first().click();
          else {
            await page.fill('.msv-mark__free input', room.name);
            await page.click('.msv-mark__free .btn--primary');
          }
        }
        await page.waitForSelector('.msv-status[data-state="spot"]');
        // espera a tela dizer que já pode seguir (ou desiste depois de 75 s parado)
        await advanceUntil(page, async () => /Pode seguir/.test(await page.textContent('.msv-status__detail')), { stepMs: 500, limitS: 75, what: 'as leituras do lugar' }).catch(() => {});
        await page.click('.msv__bar .btn--primary'); // "Segui andando"
        await page.waitForSelector('.msv-status[data-state="walking"]');
      }
      void floor0;
    }
    // uma volta livre pela casa (a pessoa virtual anda sozinha), como quem passa pelos cantos
    if (!still) await simEval(page, (sim) => sim.walker.setMode('auto'));
    if (tourS > 0) await run(tourS * 1000);
    if (maxS > 0) await run(maxS * 1000);
    const before = await stats();
    const canFinish = await page.evaluate(() => !document.querySelector('.msv__finish').disabled);
    const blocker = await page.evaluate(() => document.querySelector('.msv__bar-note')?.textContent || document.querySelector('.msv-level__hint')?.textContent || '');
    const level = await page.textContent('.msv-level__label');
    if (!canFinish) {
      failed = false;
      return { blocked: true, blocker, level, scans: before[0], spots: before[1] };
    }
    await page.click('.msv__finish');
    await advanceUntil(page, async () => (await page.locator(RESULT).count()) > 0, { stepMs: 250, limitS: 300, what: 'o resultado' });
    const out = await finishSession(app, `Ensaio manual ${world}`);
    failed = false;
    return { ...out, levelAtFinish: level, hintAtFinish: blocker };
  } finally {
    await app.close({ check: !failed });
  }
}

/**
 * Casos difíceis de verdade, do começo ao fim no app (relógio adiantado, simulador na velocidade 1):
 *   place: 'emulador' | 'um-roteador' | 'dois-roteadores' (HARD_PLACES) ou nenhum (o apartamento inteiro)
 *   still: a pessoa não sai do lugar · walkS: quanto tempo anda antes de tentar concluir
 * Devolve o que a tela disse durante o levantamento e, se deu para concluir, o que o resultado mostrou
 * (e as medidas do mapa, quando há mapa).
 */
export async function hardSession(env, { place = null, still = false, walkS = 240 } = {}) {
  const app = await openApp(env, { params: { world: 'apartamento', speed: 1 }, route: '/mapa', before: (page) => page.clock.install() });
  const { page } = app;
  let failed = true;
  try {
    await page.waitForSelector('.mlib-hero');
    const recipe = place ? HARD_PLACES[place] : null;
    if (recipe) {
      await loadHardPlace(page, recipe);
      await page.clock.runFor(4000); // a lista do lugar novo chega e a tela de redes se atualiza
    }
    await installProbe(page, { everyMs: 100 });
    await page.locator('.mlib-hero .btn', { hasText: 'Novo mapa' }).click();
    await page.waitForSelector('.sheet .map-start');
    await page.click('.sheet__footer .btn--primary');
    await page.waitForSelector('.msv__bar .btn--primary');
    if (still) await simEval(page, (sim) => sim.walker.setMode('still'));
    await page.clock.runFor(walkS * 1000);
    await page.evaluate(() => new Promise((resolve) => queueMicrotask(resolve)));
    const during = await page.evaluate(() => ({
      counts: [...document.querySelectorAll('.msv-count__value')].slice(0, 3).map((el) => Number(el.textContent)),
      level: document.querySelector('.msv-level__label')?.textContent || '',
      hint: document.querySelector('.msv-level__hint:not(.msv-level__blocker)')?.textContent || '',
      blocker: document.querySelector('.msv__bar-note')?.textContent || document.querySelector('.msv-level__blocker')?.textContent || '',
      canFinish: !document.querySelector('.msv__finish').disabled,
    }));
    if (!during.canFinish) {
      failed = false;
      return { concluded: false, during };
    }
    await page.click('.msv__finish');
    await advanceUntil(page, async () => (await page.locator('.mrs:not([hidden])').count()) > 0 && (await page.locator('.mrs__busy:not([hidden])').count()) === 0 && (await page.locator('.msv-stage:not([hidden])').count()) === 0, { stepMs: 250, limitS: 600, what: 'a tela de resultado' });
    await settle(page);
    const ui = await resultTexts(page);
    let metrics = null;
    if (!ui.noMap) {
      const out = await finishSession(app, `Ensaio ${place || 'apartamento'}`, recipe ? hardWorld(recipe) : undefined);
      metrics = out;
    }
    failed = false;
    return { concluded: true, during, ui, metrics };
  } finally {
    await app.close({ check: !failed });
  }
}
