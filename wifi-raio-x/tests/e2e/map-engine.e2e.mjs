// Camada lógica do mapa no Chromium de verdade: o motor com Web Worker de módulo (andamento,
// cancelamento, caminho de reserva, tela sem travar), uma sessão inteira gravada no simulador do
// app com o piloto da demonstração, e os mapas salvos no IndexedDB.
//
// Os módulos são importados dentro da página do app (mesma origem, mesma política de segurança),
// então o que roda aqui é exatamente o que a tela do mapa usa.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, withApp, settle } from './helpers.mjs';
import { procrustes } from '../mapping/metrics.mjs';

const T = { timeout: 240_000 };
const STATIC_ROUTE = '/ferramentas/sobre'; // tela parada: nada redesenha a cada varredura

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

/** Carrega os módulos na página e deixa as ajudas em window.__t. */
async function prepare(page) {
  await page.evaluate(async () => {
    const [engineMod, storageMod, recorderMod, pilotMod, walk, presets, worldMod, simBackend] = await Promise.all([
      import('./js/mapping/engine.js'),
      import('./js/mapping/storage.js'),
      import('./js/mapping/recorder.js'),
      import('./js/mapping/demo-pilot.js'),
      import('./js/sim/walk.js'),
      import('./js/sim/presets.js'),
      import('./js/sim/world.js'),
      import('./js/sim/backend.js'),
    ]);
    const t = (window.__t = { engineMod, storageMod, recorderMod, pilotMod, simBackend });

    /** Levantamento simulado (o mesmo gerador da bancada): { survey, truth }. */
    t.survey = (world = 'apartamento', lengthM = 150, seed = 1) => {
      const w = worldMod.createWorld(presets.presetSpec(world), seed);
      const { survey, truth } = walk.simulateSurvey(w, walk.planWalk(w, { kind: 'tour', seed, minLengthM: lengthM }), { seed });
      return { survey, truth: truth.points.map((p) => ({ x: p.x, y: p.y })) };
    };

    /** Roda fn() medindo a maior parada da thread da tela (ms) enquanto ela não termina. */
    t.stall = async (fn) => {
      let last = performance.now();
      let max = 0;
      let ticks = 0;
      const id = setInterval(() => {
        const now = performance.now();
        max = Math.max(max, now - last);
        last = now;
        ticks += 1;
      }, 4);
      const t0 = performance.now();
      try {
        const result = await fn();
        await new Promise((resolve) => setTimeout(resolve, 0)); // a parada que entregou o resultado também conta
        return { result, maxStallMs: Math.round(Math.max(max, performance.now() - last)), totalMs: Math.round(performance.now() - t0), ticks };
      } finally {
        clearInterval(id);
      }
    };

    /** O que dá para trazer de volta ao teste sobre um resultado do motor. */
    t.summary = (out, survey) => {
      const f = out.model.floors[0];
      return {
        worker: out.worker,
        ms: out.ms,
        solveMs: out.solveMs,
        buildMs: out.buildMs,
        points: out.solution.points.map((p) => ({ x: p.x, y: p.y, z: p.z, conf: p.conf })),
        pointsOk: out.solution.points.length === survey.scans.length && out.solution.points.every((p) => [p.x, p.y, p.z].every(Number.isFinite)),
        solutionAps: Object.keys(out.solution.aps).length,
        modelVersion: out.model.version,
        path: out.model.path.length,
        floors: out.model.floors.length,
        cells: out.model.nx * out.model.ny,
        typed: f ? [f.inside instanceof Uint8Array, f.conf instanceof Float32Array, f.room instanceof Int16Array] : [],
        lengths: f ? [f.inside.length, f.conf.length, f.room.length] : [],
        insideCells: f ? f.inside.reduce((n, v) => n + v, 0) : 0,
        rooms: out.model.floors.flatMap((x) => x.rooms.map((r) => ({ label: r.label, auto: r.auto }))),
        spots: out.model.spots.map((s) => s.label),
        ownAps: out.model.aps.filter((a) => a.own).length,
        quality: out.model.quality,
      };
    };

    t.errorName = async (promise) => {
      try {
        await promise;
        return null;
      } catch (err) {
        return { name: err.name, message: err.message, isError: err instanceof Error };
      }
    };
  });
}

/** Erro mediano e p90 (m) da solução contra a verdade, depois do melhor alinhamento rígido. */
function errors(points, truth) {
  const fit = procrustes(points, truth, { scale: false });
  const list = fit.aligned.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y)).sort((a, b) => a - b);
  return { median: list[list.length >> 1], p90: list[Math.floor(list.length * 0.9)] };
}

const workerUrls = (page) => page.workers().map((w) => new URL(w.url()).pathname);
const waitWorkers = async (page, count) => {
  for (let i = 0; i < 100 && page.workers().length !== count; i++) await page.waitForTimeout(20);
  return page.workers().length;
};

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

test('motor: Worker de módulo de verdade — solução e modelo inteiros, andamento do começo ao fim', T, async () => {
  await withApp(env, { route: STATIC_ROUTE, params: { walk: 'still' } }, async ({ page }) => {
    await prepare(page);
    assert.deepEqual(workerUrls(page), [], 'nenhum worker antes de precisar');
    const out = await page.evaluate(async () => {
      const t = window.__t;
      const { survey, truth } = t.survey('apartamento', 150);
      const engine = (t.engine = t.engineMod.createMapEngine());
      const before = engine.usesWorker;
      const warm = await engine.warmUp();
      const seen = [];
      const res = await engine.run(survey, { own: Object.keys(survey.aps).slice(0, 2), onProgress: (fraction, label) => seen.push([fraction, label]) });
      return { before, warm, after: engine.usesWorker, seen, truth, scans: survey.scans.length, sum: t.summary(res, survey) };
    });
    assert.equal(out.before, true);
    assert.equal(out.warm, true);
    assert.equal(out.after, true);
    assert.deepEqual(workerUrls(page), ['/js/mapping/worker.js'], 'o cálculo rodou num worker próprio');

    const s = out.sum;
    assert.equal(s.worker, true);
    assert.equal(s.pointsOk, true);
    assert.ok(out.scans >= 50, `${out.scans} varreduras`);
    assert.equal(s.path, out.scans);
    assert.equal(s.modelVersion, 1);
    assert.deepEqual(s.typed, [true, true, true], 'os vetores tipados atravessam o worker como vetores tipados');
    assert.deepEqual(s.lengths, [s.cells, s.cells, s.cells]);
    assert.ok(s.insideCells > 100, `${s.insideCells} células dentro da área`);
    assert.ok(s.solutionAps >= 3);
    assert.ok(s.ownAps >= 1, 'as redes da casa chegam ao modelo');
    assert.ok(s.ms > 0 && s.solveMs > 0 && s.buildMs >= 0 && s.ms >= s.solveMs);
    const err = errors(s.points, out.truth);
    assert.ok(err.median < 2.5, `erro mediano ${err.median.toFixed(2)} m`);

    // andamento: 0 -> 1, nunca volta, rótulos em texto, e as etapas do solucionador aparecem
    const seen = out.seen;
    assert.ok(seen.length >= 5, JSON.stringify(seen));
    assert.equal(seen[0][0], 0);
    assert.deepEqual(seen[seen.length - 1], [1, 'Pronto']);
    assert.ok(seen.every(([f, label], i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1][0]) && typeof label === 'string' && label.length > 0), JSON.stringify(seen));
    assert.ok(seen.some(([, label]) => label === 'Desenhando o mapa'));
    assert.ok(new Set(seen.map(([, label]) => label)).size >= 4, 'mais de uma etapa anunciada');
    assert.equal(seen.filter(([, label]) => label === 'Pronto').length, 1, '"Pronto" só no fim de verdade');

    // dispose encerra o worker
    await page.evaluate(() => window.__t.engine.dispose());
    assert.equal(await waitWorkers(page, 0), 0);
    const afterDispose = await page.evaluate(() => window.__t.errorName(window.__t.engine.run(window.__t.survey('kitnet', 40).survey)));
    assert.equal(afterDispose.name, 'AbortError');
  });
});

test('motor: a tela não trava enquanto o mapa é calculado no worker (e trava no caminho de reserva)', T, async () => {
  await withApp(env, { route: STATIC_ROUTE, params: { walk: 'still' }, allow: [/nao-existe\.js/] }, async ({ page }) => {
    await prepare(page);
    const out = await page.evaluate(async () => {
      const t = window.__t;
      const { survey } = t.survey('escritorio', 260);
      const own = Object.keys(survey.aps).slice(0, 2);
      const engine = t.engineMod.createMapEngine();
      await engine.warmUp(); // o que se mede é o cálculo, não a carga do worker
      const idle = await t.stall(() => new Promise((resolve) => setTimeout(resolve, 400)));
      // Três medidas de cada, e vale a melhor: uma parada causada pelo nosso código se repete em
      // todas; uma causada pela máquina ocupada com outra coisa (os testes rodam em paralelo), não.
      const best = async (fn) => {
        const runs = [];
        for (let i = 0; i < 3; i++) runs.push(await t.stall(fn));
        return runs.sort((a, b) => a.maxStallMs - b.maxStallMs)[0];
      };
      const inWorker = await best(() => engine.run(survey, { own }));
      const quick = await best(() => engine.run(survey, { own, quick: true, previous: inWorker.result.solution }));
      engine.dispose();
      const fallback = t.engineMod.createMapEngine({ workerUrl: './js/mapping/nao-existe.js' });
      const onMain = await t.stall(() => fallback.run(survey, { own }));
      fallback.dispose();
      const pick = (m) => ({ maxStallMs: m.maxStallMs, totalMs: m.totalMs, ticks: m.ticks, worker: m.result && m.result.worker, ms: m.result && m.result.ms });
      return { scans: survey.scans.length, idle: pick(idle), inWorker: pick(inWorker), quick: pick(quick), onMain: pick(onMain) };
    });
    console.log(
      `    paradas da tela (${out.scans} varreduras): ociosa ${out.idle.maxStallMs} ms · worker ${out.inWorker.maxStallMs} ms em ${out.inWorker.totalMs} ms de cálculo · ` +
        `prévia ${out.quick.maxStallMs} ms em ${out.quick.totalMs} ms · reserva na thread principal ${out.onMain.maxStallMs} ms em ${out.onMain.totalMs} ms`,
    );
    assert.equal(out.inWorker.worker, true);
    assert.equal(out.quick.worker, true);
    assert.equal(out.onMain.worker, false);
    assert.ok(out.inWorker.totalMs > 300, `o cálculo foi longo o bastante para medir (${out.inWorker.totalMs} ms)`);
    // com o worker, a tela nunca fica parada mais que um punhado de quadros
    assert.ok(out.inWorker.maxStallMs < 150, `maior parada com worker: ${out.inWorker.maxStallMs} ms`);
    assert.ok(out.quick.maxStallMs < 150, `maior parada na prévia: ${out.quick.maxStallMs} ms`);
    assert.ok(out.inWorker.ticks > out.inWorker.totalMs / 40, `a tela continuou viva: ${out.inWorker.ticks} batidas em ${out.inWorker.totalMs} ms`);
    // na reserva o cálculo segura a thread da tela por etapas inteiras — é por isso que o worker existe
    assert.ok(out.onMain.maxStallMs > 2 * out.inWorker.maxStallMs, `reserva ${out.onMain.maxStallMs} ms x worker ${out.inWorker.maxStallMs} ms`);
    assert.ok(out.quick.totalMs < out.inWorker.totalMs, 'a prévia é mais rápida que o cálculo completo');
  });
});

test('motor: cancelar encerra o worker na hora; um pedido novo substitui o anterior', T, async () => {
  await withApp(env, { route: STATIC_ROUTE, params: { walk: 'still' } }, async ({ page }) => {
    await prepare(page);
    const out = await page.evaluate(async () => {
      const t = window.__t;
      const { survey } = t.survey('escritorio', 260);
      const engine = (t.engine = t.engineMod.createMapEngine());
      await engine.warmUp();
      const log = {};

      // 1) cancel() no meio do cálculo
      let fired = 0;
      const t0 = performance.now();
      const doomed = engine.run(survey, {
        onProgress: (fraction) => {
          fired += 1;
          if (fraction > 0.02 && !log.cancelledAt) {
            log.cancelledAt = fraction;
            log.cancelReturned = engine.cancel();
          }
        },
      });
      log.cancelError = await t.errorName(doomed);
      log.cancelMs = Math.round(performance.now() - t0);
      const firedAtCancel = fired;
      await new Promise((resolve) => setTimeout(resolve, 300));
      log.progressAfterCancel = fired - firedAtCancel;
      log.usesWorkerAfterCancel = engine.usesWorker;

      // 2) o motor segue servindo (worker novo)
      const next = await engine.run(survey, {});
      log.afterCancel = { worker: next.worker, points: next.solution.points.length };

      // 3) um pedido novo substitui o que está rodando
      const first = engine.run(survey, {});
      await new Promise((resolve) => setTimeout(resolve, 60));
      const second = engine.run(survey, { quick: true });
      log.supersededError = await t.errorName(first);
      const res = await second;
      log.second = { worker: res.worker, points: res.solution.points.length };

      // 4) prévias em rajada: só a última vale, e nenhuma derruba o worker
      const burst = [1, 2, 3, 4].map(() => engine.run(survey, { quick: true }));
      log.burst = [];
      for (const p of burst.slice(0, 3)) log.burst.push((await t.errorName(p))?.name ?? 'resolveu');
      log.burstLast = (await burst[3]).worker;
      log.cancelNothing = engine.cancel();
      log.scans = survey.scans.length;
      return log;
    });
    assert.ok(out.cancelledAt > 0);
    assert.equal(out.cancelReturned, true);
    assert.deepEqual(out.cancelError, { name: 'AbortError', message: 'cálculo do mapa cancelado', isError: true });
    assert.equal(out.progressAfterCancel, 0, 'depois de cancelado, nenhum aviso de andamento');
    assert.equal(out.usesWorkerAfterCancel, true);
    assert.deepEqual(out.afterCancel, { worker: true, points: out.scans });
    assert.equal(out.supersededError.name, 'AbortError');
    assert.deepEqual(out.second, { worker: true, points: out.scans });
    assert.deepEqual(out.burst, ['AbortError', 'AbortError', 'AbortError']);
    assert.equal(out.burstLast, true);
    assert.equal(out.cancelNothing, false);
    assert.equal(await waitWorkers(page, 1), 1, 'sobra um worker só: os cancelados foram encerrados');
    await page.evaluate(() => window.__t.engine.dispose());
    assert.equal(await waitWorkers(page, 0), 0);
  });
});

test('motor: endereço do worker com 404, ou navegador sem Worker — o mapa sai pela thread principal', T, async () => {
  await withApp(env, { route: STATIC_ROUTE, params: { walk: 'still' }, allow: [/nao-existe\.js/] }, async ({ page }) => {
    await prepare(page);
    const out = await page.evaluate(async () => {
      const t = window.__t;
      const { survey } = t.survey('kitnet', 60);
      const log = {};

      // 1) o arquivo do worker não existe
      const missing = t.engineMod.createMapEngine({ workerUrl: './js/mapping/nao-existe.js' });
      log.missingBefore = missing.usesWorker;
      const seen = [];
      const res = await missing.run(survey, { own: Object.keys(survey.aps).slice(0, 1), onProgress: (f, label) => seen.push([f, label]) });
      log.missing = t.summary(res, survey);
      log.missingAfter = missing.usesWorker;
      log.missingSeen = seen;
      log.missingWarm = await missing.warmUp();
      // prévia e cancelamento também funcionam na reserva
      const quick = await missing.run(survey, { quick: true, previous: res.solution });
      log.missingQuick = { worker: quick.worker, points: quick.solution.points.length };
      const doomed = missing.run(survey, {});
      missing.cancel();
      log.missingCancel = (await t.errorName(doomed))?.name;
      const a = missing.run(survey, {});
      const b = missing.run(survey, {});
      log.missingSuperseded = (await t.errorName(a))?.name;
      log.missingSecond = (await b).worker;
      missing.dispose();

      // 2) WebView sem Worker
      const RealWorker = window.Worker;
      try {
        window.Worker = undefined;
        const none = t.engineMod.createMapEngine();
        log.noneBefore = none.usesWorker;
        const r = await none.run(survey, {});
        log.none = { worker: r.worker, points: r.solution.points.length, cells: r.model.nx * r.model.ny };
        none.dispose();

        // 3) o construtor existe mas lança (política do WebView)
        window.Worker = function Blocked() {
          throw new DOMException('bloqueado', 'SecurityError');
        };
        const blocked = t.engineMod.createMapEngine();
        log.blockedBefore = blocked.usesWorker;
        const rb = await blocked.run(survey, {});
        log.blocked = { worker: rb.worker, after: blocked.usesWorker };
        blocked.dispose();
      } finally {
        window.Worker = RealWorker;
      }
      log.scans = survey.scans.length;
      return log;
    });
    assert.equal(out.missingBefore, true);
    assert.equal(out.missingAfter, false, 'depois da falha o motor não insiste no worker');
    assert.equal(out.missingWarm, false);
    assert.equal(out.missing.worker, false);
    assert.equal(out.missing.pointsOk, true);
    assert.deepEqual(out.missing.typed, [true, true, true]);
    assert.ok(out.missing.ownAps >= 1);
    assert.deepEqual(out.missingSeen[out.missingSeen.length - 1], [1, 'Pronto']);
    assert.ok(out.missingSeen.length >= 5, 'o andamento chega mesmo na thread principal');
    assert.deepEqual(out.missingQuick, { worker: false, points: out.scans });
    assert.equal(out.missingCancel, 'AbortError');
    assert.equal(out.missingSuperseded, 'AbortError');
    assert.equal(out.missingSecond, false);
    assert.equal(out.noneBefore, false);
    assert.equal(out.none.worker, false);
    assert.equal(out.none.points, out.scans);
    assert.ok(out.none.cells > 0);
    assert.equal(out.blockedBefore, true);
    assert.deepEqual(out.blocked, { worker: false, after: false });
    assert.deepEqual(workerUrls(page), [], 'nenhum worker ficou para trás');
  });
});

// ---------------------------------------------------------------------------
// Sessão completa: simulador do app + piloto + gravador + prévias + mapa final
// ---------------------------------------------------------------------------

test('sessão: o piloto percorre o apartamento no simulador do app, com prévias pelo caminho, e o mapa final sai com os cômodos pelo nome', T, async () => {
  await withApp(env, { route: STATIC_ROUTE, params: { world: 'apartamento', seed: 1 } }, async ({ page }) => {
    await prepare(page);
    const out = await page.evaluate(async () => {
      const t = window.__t;
      const { store, scanLoop, bridge } = window.__wrx.app;
      const sim = t.simBackend.currentSim();
      const engine = t.engineMod.createMapEngine();
      const rec = t.recorderMod.createRecorder({ timeScale: sim.speed });
      const truth = [];
      const log = { previews: [], previewErrors: [], modes: [scanLoop.getState().mode], speeds: [sim.speed], walker: [sim.walker.mode] };
      let previous = null;
      let busy = false;
      let lastPreviewAt = 0;

      async function preview() {
        const count = rec.stats().scans;
        if (busy || count < 15 || count - lastPreviewAt < 12) return;
        busy = true;
        lastPreviewAt = count;
        try {
          const survey = rec.toSurvey();
          const res = await engine.run(survey, { quick: true, previous, own: [...store.get().own] });
          previous = res.solution;
          log.previews.push({ scans: survey.scans.length, points: res.solution.points.length, ms: res.ms, worker: res.worker, rooms: res.model.floors.reduce((n, f) => n + f.rooms.length, 0) });
        } catch (err) {
          log.previewErrors.push(`${err.name}: ${err.message}`);
        } finally {
          busy = false;
        }
      }

      const offScan = bridge.on('scan', (ev) => {
        if (!rec.onScan(ev, { aps: store.get().aps })) return;
        const p = sim.truth();
        truth.push({ x: p.x, y: p.y, room: p.room });
        void preview();
      });
      const offRssi = bridge.on('rssi', (sample) => rec.onRssi(sample));

      const steps = [];
      const pilot = t.pilotMod.createDemoPilot({ sim, recorder: rec, scanLoop, onStep: (step) => steps.push(step) });
      const session = await t.stall(
        () =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('o piloto não terminou em 120 s')), 120_000);
            const watch = setInterval(() => {
              if (pilot.running) return;
              clearInterval(watch);
              clearTimeout(timer);
              resolve();
            }, 50);
            if (!pilot.start({ speed: 16 })) reject(new Error('o piloto não começou'));
            log.modes.push(scanLoop.getState().mode);
            log.speeds.push(sim.speed);
            log.walker.push(sim.walker.mode);
            log.timeScaleDuring = rec.timeScale;
          }),
      );
      log.modes.push(scanLoop.getState().mode);
      log.speeds.push(sim.speed);
      log.walker.push(sim.walker.mode);
      log.timeScaleAfter = rec.timeScale;
      log.sessionMs = session.totalMs;
      log.sessionStallMs = session.maxStallMs;

      rec.stop();
      offScan();
      offRssi();
      while (busy) await new Promise((resolve) => setTimeout(resolve, 20));
      const survey = rec.toSurvey();
      const seen = [];
      const final = await t.stall(() => engine.run(survey, { own: [...store.get().own], previous, onProgress: (f, label) => seen.push([f, label]) }));
      engine.dispose();

      log.final = t.summary(final.result, survey);
      log.finalStallMs = final.maxStallMs;
      log.finalMs = final.totalMs;
      log.seen = seen.length;
      log.problems = t.recorderMod.validateSurvey(survey);
      log.stats = rec.stats();
      log.truth = truth;
      log.stillLabels = survey.scans.map((s, i) => (s.still ? [s.label, truth[i].room] : null)).filter(Boolean);
      log.rooms = sim.world.rooms.map((r) => r.name);
      log.steps = { count: steps.length, phases: [...new Set(steps.map((s) => s.phase))], last: steps[steps.length - 1], monotonic: steps.every((s, i) => i === 0 || s.progress >= steps[i - 1].progress) };
      log.trackSamples = survey.track.length;
      log.storeScans = store.get().scan.seq;
      return log;
    });

    console.log(
      `    sessão: ${(out.sessionMs / 1000).toFixed(1)} s de relógio, ${out.stats.scans} varreduras, ${out.stats.spots} pontos, ${out.previews.length} prévias ` +
        `(${out.previews.map((p) => p.ms).join('/')} ms), mapa final em ${out.finalMs} ms; maior parada da tela: ${out.sessionStallMs} ms na caminhada, ${out.finalStallMs} ms no cálculo final`,
    );

    // o piloto: terminou, marcou todos os cômodos, devolveu o simulador e o laço de buscas como estavam
    assert.equal(out.steps.last.phase, 'done');
    assert.equal(out.steps.last.complete, true);
    assert.equal(out.steps.last.progress, 1);
    assert.equal(out.steps.monotonic, true);
    assert.ok(out.steps.phases.includes('walking') && out.steps.phases.includes('marking'));
    assert.deepEqual(out.modes, ['normal', 'mapping', 'normal']);
    assert.deepEqual(out.speeds, [1, 16, 1]);
    assert.equal(out.walker[1], 'auto');
    assert.equal(out.walker[2], out.walker[0]);
    assert.equal(out.timeScaleDuring, 16);
    assert.equal(out.timeScaleAfter, 1);
    assert.ok(out.sessionMs < 45_000, `a demonstração levou ${(out.sessionMs / 1000).toFixed(1)} s`);

    // o levantamento: válido, no ritmo de uma caminhada de verdade, com os nomes certos nos lugares certos
    assert.deepEqual(out.problems, []);
    assert.ok(out.stats.scans >= 80, `${out.stats.scans} varreduras`);
    assert.ok(out.stats.cadenceS >= 2.4 && out.stats.cadenceS <= 4.5, `ritmo ${out.stats.cadenceS} s de caminhada`);
    assert.equal(out.stats.throttled, false);
    assert.ok(['bom', 'otimo'].includes(out.stats.level), out.stats.level);
    assert.deepEqual([...out.stats.labels].sort(), [...out.rooms].sort());
    assert.ok(out.stillLabels.length >= 3 * out.rooms.length - 2);
    for (const [label, room] of out.stillLabels) assert.equal(label, room);
    assert.ok(out.trackSamples > 5, 'o sinal da rede conectada também foi gravado');
    assert.ok(out.storeScans >= out.stats.scans, 'as varreduras do piloto passaram pelo laço de buscas e pelo store do app');

    // prévias: várias, no worker, cada uma com todas as varreduras até ali
    assert.deepEqual(out.previewErrors, []);
    assert.ok(out.previews.length >= 3, `${out.previews.length} prévias`);
    assert.ok(out.previews.every((p) => p.worker === true && p.points === p.scans));
    assert.ok(out.previews.every((p, i) => i === 0 || p.scans > out.previews[i - 1].scans));

    // o mapa final
    const f = out.final;
    assert.equal(f.worker, true);
    assert.equal(f.pointsOk, true);
    assert.equal(f.path, out.stats.scans);
    const named = f.rooms.filter((r) => !r.auto).map((r) => r.label);
    assert.ok(named.length >= out.rooms.length - 1, `ambientes com nome: ${named.join(', ')}`);
    assert.deepEqual([...new Set(f.spots)].sort(), [...out.rooms].sort());
    assert.ok(f.ownAps >= 1);
    assert.ok(['boa', 'razoavel'].includes(f.quality.level), f.quality.level);
    const err = errors(f.points, out.truth);
    assert.ok(err.median < 2.5, `erro mediano ${err.median.toFixed(2)} m (p90 ${err.p90.toFixed(2)} m)`);
    // (a medida fina das paradas da tela está no teste próprio, acima; aqui é só um teto folgado)
    assert.ok(out.finalStallMs < 400, `maior parada da tela no cálculo final: ${out.finalStallMs} ms`);
    assert.ok(out.seen >= 5);
    await settle(page);
  });
});

// ---------------------------------------------------------------------------
// Mapas salvos: IndexedDB de verdade
// ---------------------------------------------------------------------------

test('armazenamento: IndexedDB — salvar, listar, abrir, atualizar, rascunho, exportar/importar, e tudo continua lá ao recarregar', T, async () => {
  await withApp(env, { route: STATIC_ROUTE, params: { walk: 'still' } }, async ({ page }) => {
    await prepare(page);
    const first = await page.evaluate(async () => {
      const t = window.__t;
      const { survey } = t.survey('kitnet', 60);
      const engine = t.engineMod.createMapEngine();
      const res = await engine.run(survey, { own: Object.keys(survey.aps).slice(0, 2) });
      engine.dispose();
      const maps = await t.storageMod.openMapStore();
      const log = { kind: maps.kind, persistent: maps.persistent, empty: await maps.list(), missing: await maps.get('nada') };

      const thumb = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const record = { name: '  Kitnet <b>da</b> Ju  ', survey, solution: res.solution, own: Object.keys(survey.aps).slice(0, 2), meta: { rooms: 2, ownSsids: ['Casa'] }, thumb, demo: true, stats: { areaM2: res.model.quality.areaM2, level: res.model.quality.level } };
      const id = await maps.put(record);
      log.id = id;
      log.list = await maps.list();
      const back = await maps.get(id);
      log.sameSurvey = JSON.stringify(back.survey) === JSON.stringify(t.recorderMod.sanitizeSurvey(survey));
      log.samePoints = JSON.stringify(back.solution.points.map((p) => [p.x, p.y, p.z])) === JSON.stringify(res.solution.points.map((p) => [p.x, p.y, p.z]));
      log.debugKept = 'debug' in back.solution;
      log.name = back.name;
      log.own = back.own.length;

      // o modelo refeito do que foi guardado é o mesmo
      const again = await t.engineMod.createMapEngine().run(back.survey, { own: back.own });
      log.sameArea = again.model.quality.areaM2 === res.model.quality.areaM2;

      // atualizar, renomear
      await new Promise((resolve) => setTimeout(resolve, 15));
      const same = await maps.put({ ...back, name: 'Kitnet', meta: { rooms: 3 } });
      log.sameId = same === id;
      log.renamed = await maps.rename(id, 'Kitnet da Ju');
      const updated = (await maps.list())[0];
      log.updated = { name: updated.name, rooms: updated.meta.rooms, keptCreated: updated.createdAt === log.list[0].createdAt, bumped: updated.updatedAt > log.list[0].updatedAt };

      // rascunho: o retrato do gravador vai e volta pelo banco
      const rec = t.recorderMod.recorderFromJSON(survey);
      rec.resume();
      rec.beginSpot('Sala');
      log.draftSaved = await maps.draft.save({ recorder: rec.toJSON(), name: 'Em andamento' });
      const draft = await maps.draft.load();
      const restored = t.recorderMod.recorderFromJSON(draft.recorder);
      log.draft = { name: draft.name, state: restored.state, scans: restored.stats().scans, sameSurvey: JSON.stringify(restored.toSurvey()) === JSON.stringify(rec.toSurvey()) };

      // exportar e importar
      const text = await maps.exportMap(id);
      log.exportChars = text.length;
      log.exportFormat = JSON.parse(text).format;
      const copyId = await maps.importMap(text);
      log.copyIsNew = copyId !== id;
      log.importBad = await t.errorName(maps.importMap('{"format":"wifi-raio-x.mapa","version":99,"map":{}}'));
      log.putBad = await t.errorName(maps.put({ name: 'sem levantamento' }));
      log.count = (await maps.list()).length;
      log.databases = (await indexedDB.databases()).map((d) => d.name);
      log.localKeys = Object.keys(localStorage).filter((k) => k.startsWith('wrx.maps'));
      maps.close();
      return log;
    });

    assert.equal(first.kind, 'idb');
    assert.equal(first.persistent, true);
    assert.deepEqual(first.empty, []);
    assert.equal(first.missing, null);
    assert.equal(first.list.length, 1);
    const entry = first.list[0];
    assert.equal(entry.id, first.id);
    assert.equal(entry.name, 'Kitnet <b>da</b> Ju', 'o nome é guardado como texto');
    assert.equal(entry.demo, true);
    assert.ok(entry.thumb.startsWith('data:image/png;base64,'));
    assert.ok(entry.stats.scans > 10 && entry.stats.floors === 1 && entry.stats.areaM2 > 0 && typeof entry.stats.level === 'string');
    assert.deepEqual(entry.meta, { rooms: 2, ownSsids: ['Casa'] });
    assert.equal(first.sameSurvey, true);
    assert.equal(first.samePoints, true);
    assert.equal(first.debugKept, false, 'os dados de bancada do solucionador não são guardados');
    assert.equal(first.own, 2);
    assert.equal(first.sameArea, true);
    assert.equal(first.sameId, true);
    assert.equal(first.renamed, true);
    assert.deepEqual(first.updated, { name: 'Kitnet da Ju', rooms: 3, keptCreated: true, bumped: true });
    assert.equal(first.draftSaved, true);
    assert.equal(first.draft.name, 'Em andamento');
    assert.equal(first.draft.state, 'paused');
    assert.equal(first.draft.sameSurvey, true);
    assert.equal(first.exportFormat, 'wifi-raio-x.mapa');
    assert.equal(first.copyIsNew, true);
    assert.equal(first.importBad.name, 'MapStoreError');
    assert.match(first.importBad.message, /versão mais nova/);
    assert.equal(first.putBad.name, 'MapStoreError');
    assert.equal(first.count, 2);
    assert.ok(first.databases.includes('wrx-maps'));
    assert.deepEqual(first.localKeys, [], 'com IndexedDB nada vai para o localStorage');

    // recarrega a página: os mapas e o rascunho continuam lá
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    await prepare(page);
    const second = await page.evaluate(async (id) => {
      const t = window.__t;
      const maps = await t.storageMod.openMapStore();
      const list = await maps.list();
      const rec = await maps.get(id);
      const draft = await maps.draft.load();
      const log = { kind: maps.kind, names: list.map((e) => e.name), scans: rec.survey.scans.length, points: rec.solution.points.length, draft: draft && draft.name };
      log.removed = await maps.remove(id);
      log.afterRemove = (await maps.list()).length;
      log.gone = await maps.get(id);
      await maps.draft.clear();
      log.draftAfterClear = await maps.draft.load();
      await maps.clear();
      log.afterClear = (await maps.list()).length;
      maps.close();
      return log;
    }, first.id);
    assert.equal(second.kind, 'idb');
    assert.deepEqual([...second.names].sort(), ['Kitnet da Ju', 'Kitnet da Ju']);
    assert.equal(second.scans, entry.stats.scans);
    assert.equal(second.points, entry.stats.scans);
    assert.equal(second.draft, 'Em andamento');
    assert.equal(second.removed, true);
    assert.equal(second.afterRemove, 1);
    assert.equal(second.gone, null);
    assert.equal(second.draftAfterClear, null);
    assert.equal(second.afterClear, 0);
  });
});

test('armazenamento: "apagar dados salvos" com o banco aberto, registro estragado, duas telas e IndexedDB quebrado', T, async () => {
  await withApp(env, { route: STATIC_ROUTE, params: { walk: 'still' } }, async ({ page }) => {
    await prepare(page);
    const out = await page.evaluate(async () => {
      const t = window.__t;
      const { survey } = t.survey('kitnet', 40);
      const log = {};
      const maps = await t.storageMod.openMapStore();
      const other = await t.storageMod.openMapStore(); // outra tela com o armazenamento aberto
      const a = await maps.put({ name: 'A', survey });
      log.otherSees = (await other.list()).map((e) => e.name);

      // --- registro estragado, gravado por fora direto no banco ---
      const raw = (fn) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('wrx-maps');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(['maps', 'index'], 'readwrite');
            fn(tx.objectStore('maps'), tx.objectStore('index'));
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => reject(tx.error);
          };
        });
      await raw((mapsStore, index) => {
        mapsStore.put({ id: 'quebrado', v: 1, name: 'Quebrado', survey: { version: 1, scans: 'cadê?' } });
        index.put({ id: 'quebrado', name: 'Quebrado', createdAt: 1, updatedAt: 9e15, stats: { scans: 3, spots: 0, floors: 1 } });
        mapsStore.put({ id: 'futuro', v: 7, name: 'Do futuro', survey });
        index.put({ id: 'so-linha', name: 'Só a linha', createdAt: 1, updatedAt: 2, stats: { scans: 3, spots: 0, floors: 1 } });
        index.put({ id: 'lixo', stats: 'x' });
        mapsStore.put({ id: 'sem-linha', v: 1, name: 'Sem linha', createdAt: 5, updatedAt: 6, survey }); // inteiro, mas fora da lista
      });
      const list = await maps.list();
      log.names = list.map((e) => e.name).sort();
      log.quebrado = await maps.get('quebrado');
      log.futuro = await maps.get('futuro');
      log.semLinha = (await maps.get('sem-linha'))?.name;
      log.lastError = maps.lastError;

      // --- "apagar dados salvos" (o mesmo que ui/tools/settings.js faz), com dois armazenamentos abertos ---
      const wipe = async () => {
        const dbs = await indexedDB.databases();
        const results = await Promise.all(
          dbs
            .filter((db) => typeof db.name === 'string' && db.name.startsWith('wrx'))
            .map(
              (db) =>
                new Promise((resolve) => {
                  const req = indexedDB.deleteDatabase(db.name);
                  let blocked = false;
                  req.onblocked = () => (blocked = true);
                  req.onsuccess = () => resolve({ name: db.name, ok: true, blocked });
                  req.onerror = () => resolve({ name: db.name, ok: false, blocked });
                }),
            ),
        );
        for (const key of Object.keys(localStorage)) if (key.startsWith('wrx.maps')) localStorage.removeItem(key);
        return results;
      };
      const t0 = performance.now();
      log.wipe = await wipe();
      log.wipeMs = Math.round(performance.now() - t0);
      // os armazenamentos que estavam abertos continuam funcionando, agora vazios
      log.afterWipe = [(await maps.list()).length, (await other.list()).length, await maps.get(a), await maps.draft.load()];
      const b = await maps.put({ name: 'Depois de apagar', survey });
      log.afterWipePut = (await other.list()).map((e) => e.name);
      log.afterWipeError = maps.lastError;
      await maps.remove(b);

      // --- IndexedDB quebrado: cai para o localStorage ---
      const broken = {
        open() {
          throw new DOMException('negado', 'SecurityError');
        },
      };
      const local = await t.storageMod.openMapStore({ indexedDB: broken });
      log.localKind = local.kind;
      const c = await local.put({ name: 'Guardado no localStorage', survey });
      await local.draft.save({ recorder: { kind: 'wrx-recorder' }, name: 'Rascunho local' });
      log.localKeys = Object.keys(localStorage).filter((k) => k.startsWith('wrx.maps')).length;
      log.localList = (await local.list()).map((e) => e.name);

      // --- e quando o IndexedDB volta a funcionar, o que ficou no localStorage é trazido para o banco ---
      const healed = await t.storageMod.openMapStore();
      log.healedKind = healed.kind;
      log.healedList = (await healed.list()).map((e) => e.name);
      log.healedScans = (await healed.get(c)).survey.scans.length;
      log.healedDraft = (await healed.draft.load())?.name;
      log.localKeysAfter = Object.keys(localStorage).filter((k) => k.startsWith('wrx.maps')).length;
      log.scans = survey.scans.length;

      // --- sem IndexedDB e sem localStorage: memória ---
      const mem = await t.storageMod.openMapStore({ indexedDB: null, localStorage: null });
      log.memKind = [mem.kind, mem.persistent];
      await healed.clear();
      for (const s of [maps, other, local, healed, mem]) s.close();
      // fechado, um armazenamento responde sem lançar
      log.closedList = await maps.list();
      return log;
    });

    assert.deepEqual(out.otherSees, ['A']);
    assert.deepEqual(out.names, ['A', 'Sem linha'], 'estragado, futuro e linha órfã ficam de fora; o inteiro sem linha volta para a lista');
    assert.equal(out.quebrado, null);
    assert.equal(out.futuro, null);
    assert.equal(out.semLinha, 'Sem linha');
    assert.equal(out.lastError, null, 'registro estragado não é erro: é só pulado');
    assert.deepEqual(
      out.wipe.map((w) => [w.name, w.ok, w.blocked]),
      [['wrx-maps', true, false]],
      'o banco aberto não bloqueia o "apagar dados salvos"',
    );
    assert.ok(out.wipeMs < 3000, `apagar levou ${out.wipeMs} ms`);
    assert.deepEqual(out.afterWipe, [0, 0, null, null]);
    assert.deepEqual(out.afterWipePut, ['Depois de apagar']);
    assert.equal(out.afterWipeError, null);
    assert.equal(out.localKind, 'local');
    assert.ok(out.localKeys >= 3, 'registro, lista e rascunho no localStorage');
    assert.deepEqual(out.localList, ['Guardado no localStorage']);
    assert.equal(out.healedKind, 'idb');
    assert.deepEqual(out.healedList, ['Guardado no localStorage']);
    assert.equal(out.healedScans, out.scans);
    assert.equal(out.healedDraft, 'Rascunho local');
    assert.equal(out.localKeysAfter, 0, 'o que foi trazido para o banco sai do localStorage');
    assert.deepEqual(out.memKind, ['memory', false]);
    assert.deepEqual(out.closedList, []);
  });
});
