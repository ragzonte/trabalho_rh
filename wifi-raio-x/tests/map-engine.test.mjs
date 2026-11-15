// Motor do mapa (app/js/mapping/engine.js + worker.js) em Node: aqui não existe Web Worker, então
// vale o caminho de reserva na thread principal. A conversa com o worker é conferida com um
// Worker de mentira; o Worker de módulo de verdade é testado no Chromium, em
// tests/e2e/map-engine.e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMapEngine } from '../app/js/mapping/engine.js';
import { runJob, loadSolver, collectTransferables, abortError } from '../app/js/mapping/worker.js';
import { validateSurvey } from '../app/js/mapping/recorder.js';
import { planWalk, simulateSurvey } from '../app/js/sim/walk.js';
import { presetSpec } from '../app/js/sim/presets.js';
import { createWorld } from '../app/js/sim/world.js';

// ---------------------------------------------------------------------------
// Ajudas
// ---------------------------------------------------------------------------

/** Levantamento simulado pequeno (kitnet, ~1 minuto e meio de caminhada), o mesmo para todos os testes. */
function makeSurvey(world = 'kitnet', lengthM = 45) {
  const w = createWorld(presetSpec(world), 1);
  const { survey } = simulateSurvey(w, planWalk(w, { kind: 'tour', seed: 1, minLengthM: lengthM }), { seed: 1 });
  return survey;
}
const SURVEY = makeSurvey();
const OWN = Object.keys(SURVEY.aps).slice(0, 2);
const BUDGET = 2500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function abortOf(promise) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'devia ter sido cancelado');
  assert.equal(err.name, 'AbortError', err.stack);
  assert.ok(err instanceof Error);
  return err;
}

function checkResult(out, survey = SURVEY) {
  assert.equal(out.solution.points.length, survey.scans.length);
  assert.ok(out.solution.points.every((p) => [p.x, p.y, p.z].every(Number.isFinite)));
  assert.equal('debug' in out.solution, false, 'dados de bancada não saem do motor');
  const model = out.model;
  assert.equal(model.version, 1);
  assert.equal(model.path.length, survey.scans.length);
  assert.ok(model.floors.length >= 1);
  const f = model.floors[0];
  assert.ok(f.inside instanceof Uint8Array && f.conf instanceof Float32Array && f.room instanceof Int16Array);
  assert.equal(f.inside.length, model.nx * model.ny);
  assert.ok(Number.isFinite(out.ms) && out.ms >= 0);
  assert.ok(Number.isFinite(out.solveMs) && Number.isFinite(out.buildMs));
}

// ---------------------------------------------------------------------------
// Caminho de reserva (thread principal)
// ---------------------------------------------------------------------------

test('o levantamento de teste é um Survey válido', () => {
  assert.deepEqual(validateSurvey(SURVEY), []);
  assert.ok(SURVEY.scans.length >= 20 && SURVEY.scans.length <= 80, `${SURVEY.scans.length} varreduras`);
});

test('sem Web Worker o motor roda na thread principal e entrega solução, modelo e tempo', async () => {
  assert.equal(typeof Worker, 'undefined', 'este teste é o do caminho sem Worker');
  const engine = createMapEngine();
  assert.equal(engine.usesWorker, false);
  assert.equal(await engine.warmUp(), false);
  const seen = [];
  const out = await engine.run(SURVEY, { own: OWN, budgetMs: BUDGET, onProgress: (fraction, label) => seen.push([fraction, label]) });
  checkResult(out);
  assert.equal(out.worker, false);
  assert.ok(out.model.aps.some((a) => a.own), 'as redes da casa chegam ao modelo');

  // progresso: de 0 a 1, sem voltar, com rótulo em texto
  assert.ok(seen.length >= 4, `${seen.length} avisos`);
  assert.equal(seen[0][0], 0);
  assert.deepEqual(seen[seen.length - 1], [1, 'Pronto']);
  assert.ok(seen.every(([f], i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1][0])), JSON.stringify(seen));
  assert.ok(seen.every(([, label]) => typeof label === 'string' && label.length > 0));
  assert.ok(seen.some(([, label]) => label === 'Desenhando o mapa'));
  assert.ok(seen.length <= 120, 'os avisos do solucionador são dosados');
  engine.dispose();
});

test('o mesmo levantamento dá sempre o mesmo mapa, e o motor não mexe no que recebe', async () => {
  const engine = createMapEngine();
  const copy = JSON.parse(JSON.stringify(SURVEY));
  const a = await engine.run(copy, { own: OWN, budgetMs: BUDGET });
  assert.deepEqual(copy, SURVEY, 'o levantamento não foi alterado');
  const b = await engine.run(copy, { own: new Set(OWN), budgetMs: BUDGET });
  assert.deepEqual(b.solution, a.solution);
  assert.deepEqual(b.model.quality, a.model.quality);
  assert.deepEqual(Array.from(b.model.floors[0].inside), Array.from(a.model.floors[0].inside));
  engine.dispose();
});

test('prévia rápida (quick) devolve um mapa do mesmo formato, com ou sem solução anterior', async () => {
  const engine = createMapEngine();
  const first = await engine.run(SURVEY, { quick: true, budgetMs: 600 });
  checkResult(first);
  // a prévia seguinte parte da anterior; o levantamento cresceu no meio do caminho
  const longer = makeSurvey('kitnet', 70);
  assert.ok(longer.scans.length > SURVEY.scans.length);
  const second = await engine.run(longer, { quick: true, previous: first.solution, budgetMs: 600, own: OWN });
  checkResult(second, longer);
  const third = await engine.run(longer, { quick: true, previous: second.solution, budgetMs: 600 });
  checkResult(third, longer);
  // "previous" estranho não derruba
  checkResult(await engine.run(SURVEY, { quick: true, previous: 'x', budgetMs: 600 }));
  engine.dispose();
});

test('um cálculo por vez: o novo cancela o anterior, que rejeita com AbortError', async () => {
  const engine = createMapEngine();
  const progressOfFirst = [];
  const first = engine.run(SURVEY, { budgetMs: BUDGET, onProgress: (f) => progressOfFirst.push(f) });
  const second = engine.run(SURVEY, { budgetMs: BUDGET });
  const third = engine.run(SURVEY, { budgetMs: BUDGET, own: OWN });
  await abortOf(first);
  await abortOf(second);
  checkResult(await third);
  const count = progressOfFirst.length;
  await sleep(30);
  assert.equal(progressOfFirst.length, count, 'um cálculo cancelado não avisa mais nada');
  engine.dispose();
});

test('cancel(): rejeita com AbortError, e o motor continua servindo', async () => {
  const engine = createMapEngine();
  assert.equal(engine.cancel(), false, 'nada para cancelar');
  const pending = engine.run(SURVEY, { budgetMs: BUDGET });
  assert.equal(engine.cancel(), true);
  assert.equal(engine.cancel(), false);
  const err = await abortOf(pending);
  assert.match(err.message, /cancelado/);
  // cancelar no meio: depois de o cálculo ter começado
  let started = false;
  const mid = engine.run(SURVEY, {
    budgetMs: BUDGET,
    onProgress: () => {
      if (!started) {
        started = true;
        engine.cancel();
      }
    },
  });
  await abortOf(mid);
  assert.equal(started, true);
  checkResult(await engine.run(SURVEY, { budgetMs: BUDGET }));
  engine.dispose();
});

test('dispose(): cancela o que estiver rodando e não aceita mais pedidos', async () => {
  const engine = createMapEngine();
  const pending = engine.run(SURVEY, { budgetMs: BUDGET });
  engine.dispose();
  await abortOf(pending);
  await abortOf(engine.run(SURVEY));
  assert.equal(engine.usesWorker, false);
  engine.dispose(); // duas vezes: sem erro
  assert.equal(engine.cancel(), false);
});

test('levantamento que não presta rejeita com erro comum (não AbortError) e não trava o motor', async () => {
  const engine = createMapEngine();
  for (const junk of [null, undefined, 42, 'x', {}, { scans: 'x' }]) {
    await assert.rejects(engine.run(junk), (err) => err instanceof Error && err.name !== 'AbortError' && /inválido/.test(err.message));
  }
  // levantamento vazio é válido: dá um mapa vazio
  const empty = await engine.run({ version: 1, scans: [], aps: {} });
  assert.deepEqual(empty.solution.points, []);
  assert.equal(empty.model.path.length, 0);
  // um ouvinte de progresso que lança não derruba o cálculo
  checkResult(
    await engine.run(SURVEY, {
      budgetMs: BUDGET,
      onProgress: () => {
        throw new Error('ouvinte quebrado');
      },
    }),
  );
  engine.dispose();
});

// ---------------------------------------------------------------------------
// runJob e as peças do worker
// ---------------------------------------------------------------------------

test('runJob: confere o sinal de cancelamento entre as etapas e devolve a vez em cada uma', async () => {
  const solver = await loadSolver();
  assert.equal(typeof solver.solve, 'function');
  assert.equal(typeof solver.solveQuick, 'function');
  assert.equal(await loadSolver(), solver, 'o solucionador é carregado uma vez só');

  let breaths = 0;
  const out = await runJob({ survey: SURVEY, own: OWN, budgetMs: BUDGET }, { breathe: async () => void (breaths += 1) });
  checkResult(out);
  assert.equal(breaths, 2, 'antes de resolver e antes de desenhar');

  // cancelado antes de começar
  await abortOf(runJob({ survey: SURVEY }, { signal: { cancelled: true } }));
  // cancelado durante a solução: não chega a montar o modelo
  const signal = { cancelled: false };
  let stage = 0;
  const cancelled = runJob(
    { survey: SURVEY, budgetMs: BUDGET },
    {
      signal,
      breathe: async () => {
        stage += 1;
        if (stage === 2) signal.cancelled = true;
      },
    },
  );
  await abortOf(cancelled);
  assert.equal(stage, 2);
  assert.equal(abortError().name, 'AbortError');
});

test('collectTransferables: acha os buffers dos vetores tipados do modelo, sem repetir', async () => {
  const { model } = await runJob({ survey: SURVEY, budgetMs: BUDGET });
  const buffers = collectTransferables(model);
  assert.ok(buffers.length >= 3 * model.floors.length, `${buffers.length} buffers`);
  assert.ok(buffers.every((b) => b instanceof ArrayBuffer));
  assert.equal(new Set(buffers).size, buffers.length);
  for (const f of model.floors) for (const key of ['inside', 'conf', 'room']) assert.ok(buffers.includes(f[key].buffer), key);

  const shared = new ArrayBuffer(16);
  const tree = { a: new Uint8Array(shared, 0, 8), b: [{ c: new Float32Array(shared, 8, 2) }], d: [1, 2, 3], e: 'x', f: null, g: new Float64Array(2) };
  tree.self = tree; // ciclo: não pode travar
  assert.equal(collectTransferables(tree).length, 2);
  assert.deepEqual(collectTransferables(null), []);
  assert.deepEqual(collectTransferables(42), []);

  // o modelo atravessa uma cópia estruturada (é o que o postMessage faz) com os vetores inteiros
  const clone = structuredClone(model, { transfer: collectTransferables(model) });
  assert.equal(clone.floors[0].inside.length, clone.nx * clone.ny);
  assert.equal(model.floors[0].inside.length, 0, 'transferido: o original ficou vazio, sem cópia');
  assert.deepEqual(clone.quality, JSON.parse(JSON.stringify(clone.quality)));
});

// ---------------------------------------------------------------------------
// Conversa com o worker (Worker de mentira)
// ---------------------------------------------------------------------------

/**
 * Instala um Worker de mentira em globalThis. `behaviour` decide o que cada instância faz:
 *   'ok'        avisa 'ready' e resolve os pedidos com o runJob de verdade
 *   'throws'    o construtor lança
 *   'load-error' dispara onerror antes de ficar pronto (script 404 ou sem suporte a módulo)
 *   'silent'    nunca fica pronto
 *   'hang'      fica pronto, aceita o pedido e nunca responde
 *   'crash'     fica pronto e morre ao receber o pedido
 *   'fail'      fica pronto e responde com erro
 */
function installFakeWorker(t, behaviours) {
  const made = [];
  const queue = [...behaviours];
  class FakeWorker {
    constructor(url, options) {
      const behaviour = queue.length > 1 ? queue.shift() : queue[0];
      if (behaviour === 'throws') throw new Error('SecurityError');
      this.url = String(url);
      this.options = options;
      this.behaviour = behaviour;
      this.terminated = false;
      this.messages = [];
      this.onmessage = null;
      this.onerror = null;
      made.push(this);
      if (behaviour === 'load-error') setTimeout(() => this.onerror && this.onerror({ message: 'falha ao carregar', preventDefault() {} }), 0);
      else if (behaviour !== 'silent') setTimeout(() => this.emit({ type: 'ready' }), 0);
    }
    emit(data) {
      if (!this.terminated && this.onmessage) this.onmessage({ data });
    }
    postMessage(msg) {
      this.messages.push(msg);
      if (this.behaviour === 'hang') return;
      if (this.behaviour === 'crash') {
        setTimeout(() => this.onerror && this.onerror({ message: 'out of memory', preventDefault() {} }), 0);
        return;
      }
      if (this.behaviour === 'fail') {
        setTimeout(() => this.emit({ type: 'error', id: msg.id, name: 'RangeError', message: 'estourou' }), 0);
        return;
      }
      // como o worker de verdade: clona o pedido, roda e devolve (com transferência)
      const job = structuredClone(msg);
      runJob(job, { onProgress: (fraction, label) => this.emit({ type: 'progress', id: job.id, fraction, label }) }).then(
        (result) => this.emit(structuredClone({ type: 'done', id: job.id, ...result }, { transfer: collectTransferables(result.model) })),
        (err) => this.emit({ type: 'error', id: job.id, name: err.name, message: err.message }),
      );
    }
    terminate() {
      this.terminated = true;
    }
  }
  globalThis.Worker = FakeWorker;
  t.after(() => {
    delete globalThis.Worker;
  });
  return made;
}

test('worker: cria um Worker de módulo, espera o "ready" e entrega o resultado que ele manda', async (t) => {
  const made = installFakeWorker(t, ['ok']);
  const engine = createMapEngine();
  assert.equal(engine.usesWorker, true);
  assert.equal(made.length, 0, 'o worker só nasce quando é preciso');
  const seen = [];
  const out = await engine.run(SURVEY, { own: OWN, budgetMs: BUDGET, onProgress: (f, label) => seen.push([f, label]) });
  checkResult(out);
  assert.equal(out.worker, true);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].options, { type: 'module', name: 'wrx-mapa' });
  assert.match(made[0].url, /\/app\/js\/mapping\/worker\.js$/);
  assert.equal(made[0].messages.length, 1);
  const msg = made[0].messages[0];
  assert.equal(msg.type, 'run');
  assert.deepEqual(msg.own, OWN);
  assert.equal(msg.quick, false);
  assert.equal(msg.budgetMs, BUDGET);
  assert.deepEqual(seen[seen.length - 1], [1, 'Pronto']);

  // o segundo pedido reaproveita o mesmo worker
  checkResult(await engine.run(SURVEY, { quick: true, previous: out.solution, budgetMs: 600 }));
  assert.equal(made.length, 1);
  assert.equal(made[0].messages[1].quick, true);
  assert.deepEqual(made[0].messages[1].previous, out.solution);
  assert.equal(await engine.warmUp(), true);

  engine.dispose();
  assert.equal(made[0].terminated, true);
  assert.equal(engine.usesWorker, false);
});

test('worker: endereço próprio (workerUrl) é respeitado', async (t) => {
  const made = installFakeWorker(t, ['ok']);
  const engine = createMapEngine({ workerUrl: '/outro/lugar/worker.js' });
  assert.equal(await engine.warmUp(), true);
  assert.equal(made[0].url, '/outro/lugar/worker.js');
  engine.dispose();
});

test('worker: cancelar encerra o worker (o solucionador não cede a vez) e o próximo pedido cria outro', async (t) => {
  const made = installFakeWorker(t, ['hang', 'ok']);
  const engine = createMapEngine();
  const stuck = engine.run(SURVEY, { budgetMs: BUDGET });
  await sleep(20); // deixa o pedido chegar ao worker
  assert.equal(made[0].messages.length, 1);
  assert.equal(engine.cancel(), true);
  await abortOf(stuck);
  assert.equal(made[0].terminated, true);

  const out = await engine.run(SURVEY, { budgetMs: BUDGET });
  checkResult(out);
  assert.equal(out.worker, true);
  assert.equal(made.length, 2);
  engine.dispose();
});

test('worker: um pedido novo substitui o que está rodando', async (t) => {
  const made = installFakeWorker(t, ['hang', 'ok']);
  const engine = createMapEngine();
  const first = engine.run(SURVEY, { budgetMs: BUDGET });
  await sleep(20);
  const second = engine.run(SURVEY, { budgetMs: BUDGET });
  await abortOf(first);
  checkResult(await second);
  assert.equal(made.length, 2);
  assert.equal(made[0].terminated, true);
  assert.equal(made[1].terminated, false);
  // substituído antes mesmo de o worker ficar pronto: nenhum trabalho perdido chega a rodar
  const a = engine.run(SURVEY, { budgetMs: BUDGET });
  const b = engine.run(SURVEY, { budgetMs: BUDGET });
  await abortOf(a);
  checkResult(await b);
  assert.equal(made[1].messages.length, 2, 'o pedido cancelado antes de sair não foi enviado');
  engine.dispose();
});

for (const [behaviour, why] of [
  ['throws', 'o construtor do Worker lança'],
  ['load-error', 'o worker falha ao carregar (404, WebView sem Worker de módulo)'],
  ['silent', 'o worker nunca avisa que está pronto'],
]) {
  test(`reserva: quando ${why}, o cálculo roda na thread principal`, async (t) => {
    const made = installFakeWorker(t, [behaviour]);
    const engine = createMapEngine({ readyTimeoutMs: 60 });
    assert.equal(engine.usesWorker, true, 'antes de tentar, não há como saber');
    const out = await engine.run(SURVEY, { own: OWN, budgetMs: BUDGET });
    checkResult(out);
    assert.equal(out.worker, false);
    assert.equal(engine.usesWorker, false, 'e o motor não insiste no worker');
    const count = made.length;
    assert.ok(made.every((w) => w.terminated), 'o worker que não serviu foi encerrado');
    checkResult(await engine.run(SURVEY, { budgetMs: BUDGET }));
    assert.equal(made.length, count, 'nenhuma nova tentativa de criar worker');
    assert.equal(await engine.warmUp(), false);
    engine.dispose();
  });
}

test('reserva: worker que morre no meio de um cálculo — o mesmo cálculo é refeito na thread principal', async (t) => {
  const made = installFakeWorker(t, ['crash', 'crash', 'ok']);
  const engine = createMapEngine();
  const out = await engine.run(SURVEY, { budgetMs: BUDGET });
  checkResult(out);
  assert.equal(out.worker, false);
  assert.equal(made[0].terminated, true);
  assert.equal(engine.usesWorker, true, 'uma queda só não condena o worker');
  // segunda queda seguida: desiste do worker de vez
  const again = await engine.run(SURVEY, { budgetMs: BUDGET });
  assert.equal(again.worker, false);
  assert.equal(engine.usesWorker, false);
  assert.equal(made.length, 2);
  engine.dispose();
});

test('worker: erro do cálculo chega como erro (com o nome original), e o worker continua em uso', async (t) => {
  const made = installFakeWorker(t, ['fail']);
  const engine = createMapEngine();
  await assert.rejects(engine.run(SURVEY), (err) => err.name === 'RangeError' && err.message === 'estourou');
  await assert.rejects(engine.run(SURVEY), /estourou/);
  assert.equal(made.length, 1);
  assert.equal(made[0].terminated, false);
  assert.equal(engine.usesWorker, true);
  engine.dispose();
});

test('worker: levantamento que não atravessa a mensagem é resolvido na thread principal', async (t) => {
  installFakeWorker(t, ['ok']);
  const engine = createMapEngine();
  // uma função pendurada no objeto faz o structuredClone (postMessage) lançar
  const odd = { ...SURVEY, toString: () => 'x' };
  const made = globalThis.Worker;
  const original = made.prototype.postMessage;
  made.prototype.postMessage = function post(msg) {
    structuredClone(msg);
    return original.call(this, msg);
  };
  const out = await engine.run(odd, { budgetMs: BUDGET });
  checkResult(out);
  assert.equal(out.worker, false);
  engine.dispose();
});
