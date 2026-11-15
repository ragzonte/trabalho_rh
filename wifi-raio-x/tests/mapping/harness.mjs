#!/usr/bin/env node
// Bancada do mapa 3D feito só com Wi-Fi.
//
//   node tests/mapping/harness.mjs --solver <módulo> [--export nome] [--set dev|holdout|all]
//        [--only <trecho do nome>] [--json] [--svg [pasta]] [--budget-ms N] [--jobs N] [--inline] [--list]
//
// O módulo exporta `solve(survey, options) -> MapSolution` (pode ser assíncrono).
//
// Regras do jogo:
//   - cada cenário roda numa thread própria, que recebe SÓ uma cópia do levantamento:
//     a verdade (posições reais, mundo) nunca chega ao solucionador;
//   - quem lança erro, devolve saída inválida ou passa do tempo leva a nota fixa de falha (200);
//   - o tempo padrão é 20 s por cenário NESTA máquina; um celular é de 3 a 5 vezes mais lento;
//   - 'dev' é para desenvolver e ajustar; 'holdout' (outras sementes, casas sorteadas e
//     propagação ±20%) é para julgar. Não ajuste nada olhando o holdout.
//
// A única exceção à regra da verdade é tests/mapping/baseline.mjs, cujos oráculos trapaceiam
// de propósito para mostrar o teto possível em cada cenário.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

import { createRng } from '../../app/js/sim/prng.js';
import { listPresets, presetSpec, randomSpec } from '../../app/js/sim/presets.js';
import { planWalk, simulateSurvey } from '../../app/js/sim/walk.js';
import { createWorld } from '../../app/js/sim/world.js';
import { FLOOR_HEIGHT } from '../../app/js/mapping/types.js';
import { aggregate, evaluate, failure, procrustes } from './metrics.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, 'baseline.mjs');
export const DEFAULT_BUDGET_MS = 20000;

// ---------------------------------------------------------------------------
// Cenários
// ---------------------------------------------------------------------------

// Modos de levantamento: três jeitos de andar com varredura livre (3,5 s) e o modo
// "pontos" com o limite padrão do Android (uma varredura a cada 30 s).
const MODES = [
  { key: 'tour-3.5s', kind: 'tour', interval: 3.5 },
  { key: 'perimetro-3.5s', kind: 'perimeter', interval: 3.5 },
  { key: 'pontos-3.5s', kind: 'spots', interval: 3.5, stillScans: 3 },
  { key: 'pontos-30s', kind: 'spots', interval: 30, stillScans: 1 },
];

// Tamanho do levantamento por mundo: metros andados (4 a 12 min) e quantidade de pontos marcados.
const EFFORT = {
  kitnet: { length: 155, spots: 14, spots30: 25 },
  apartamento: { length: 225, spots: 22, spots30: 30 },
  sobrado: { length: 310, spots: 32, spots30: 40 },
  escritorio: { length: 380, spots: 40, spots30: 45 },
};

function effortForArea(area) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  return { length: clamp(40 + 2.6 * area, 150, 380), spots: clamp(area / 3.2, 14, 40), spots30: clamp(area / 2.5, 25, 45) };
}

function walkOptions(mode, effort, seed, extra = {}) {
  const walk = { kind: mode.kind, seed, ...extra };
  if (mode.kind === 'spots') walk.count = mode.interval > 10 ? effort.spots30 : effort.spots;
  else walk.minLengthM = effort.length;
  return walk;
}

// No holdout a física muda um pouco (±20%): quem decorou as constantes do dev não leva vantagem.
function holdoutRf(name) {
  const rng = createRng('holdout-rf', name);
  const vary = (v) => Math.round(v * rng.float(0.8, 1.2) * 1000) / 1000;
  return {
    n: Math.round(2.1 * rng.float(0.88, 1.2) * 1000) / 1000,
    wallScale: vary(1),
    shadowSigmaDb: vary(3),
    fadeSigmaDb: vary(1.4),
    noiseSigmaDb: vary(1.4),
    bodyLossDb: [vary(5), vary(6), vary(6)],
  };
}

/**
 * Lista (determinística) dos cenários de um conjunto.
 * @param {'dev'|'holdout'|'all'} set
 */
export function listScenarios(set = 'dev') {
  const out = [];
  const presets = listPresets().map((p) => p.id);
  if (set === 'dev' || set === 'all') {
    for (const id of presets) {
      MODES.forEach((mode, m) => {
        for (const seed of [1, 2]) {
          out.push({
            name: `${id}-${mode.key}-s${seed}`,
            set: 'dev',
            group: id,
            mode: mode.key,
            world: { type: 'preset', id, seed },
            rf: {},
            walk: walkOptions(mode, EFFORT[id], 10 * seed + m),
            survey: { scanIntervalS: mode.interval, stillScans: mode.stillScans, seed: 10 * seed + m },
          });
        }
      });
    }
  }
  if (set === 'holdout' || set === 'all') {
    // Os mesmos mundos prontos, com outra vizinhança, outro canto do roteador e outra caminhada.
    presets.forEach((id, p) => {
      MODES.forEach((mode, m) => {
        const seed = 71 + 10 * p + m;
        const name = `${id}-${mode.key}-h${seed}`;
        // No sobrado, metade dos levantamentos começa pelo andar de cima.
        const extra = id === 'sobrado' && m % 2 === 1 ? { floorOrder: [1, 0] } : {};
        out.push({
          name,
          set: 'holdout',
          group: id,
          mode: mode.key,
          world: { type: 'preset', id, seed },
          rf: holdoutRf(name),
          walk: walkOptions(mode, EFFORT[id], seed, extra),
          survey: { scanIntervalS: mode.interval, stillScans: mode.stillScans, seed },
        });
      });
    });
    // Doze casas sorteadas: plantas que nenhum solucionador viu.
    const sizes = ['pequena', 'media', 'grande'];
    for (let i = 0; i < 12; i++) {
      const seed = 301 + i;
      const mode = MODES[i % MODES.length];
      const size = sizes[Math.floor(i / MODES.length) % sizes.length];
      const name = `casa${seed}-${size}-${mode.key}`;
      out.push({
        name,
        set: 'holdout',
        group: 'casa-sorteada',
        mode: mode.key,
        world: { type: 'random', seed, size },
        rf: holdoutRf(name),
        walk: { kind: mode.kind, seed, auto: true },
        survey: { scanIntervalS: mode.interval, stillScans: mode.stillScans, seed },
      });
    }
  }
  return out;
}

/**
 * Monta um cenário: mundo, caminhada, levantamento e verdade.
 * @returns {{desc:Object, world:Object, plan:Object, survey:Object, truth:Object}}
 */
export function buildScenario(desc) {
  const spec = desc.world.type === 'preset' ? presetSpec(desc.world.id, desc.world.seed) : randomSpec(desc.world.seed, { size: desc.world.size });
  const world = createWorld(spec, desc.world.seed, desc.rf || {});
  const walk = { ...desc.walk };
  if (walk.auto) {
    const mode = MODES.find((m) => m.key === desc.mode);
    Object.assign(walk, walkOptions(mode, effortForArea(world.bounds.width * world.bounds.height), walk.seed));
    delete walk.auto;
  }
  const plan = planWalk(world, walk);
  const { survey, truth } = simulateSurvey(world, plan, desc.survey);
  return { desc, world, plan, survey, truth };
}

// ---------------------------------------------------------------------------
// Execução isolada do solucionador
// ---------------------------------------------------------------------------

// Só os campos do contrato atravessam de volta (o `debug` pode ser enorme ou nem ser copiável).
function plainSolution(solution) {
  if (!solution || !Array.isArray(solution.points)) return null;
  const num = (v) => (typeof v === 'number' ? v : NaN);
  const aps = {};
  for (const [id, a] of Object.entries(solution.aps || {})) {
    if (a) aps[id] = { x: num(a.x), y: num(a.y), z: num(a.z), p0: num(a.p0), n: num(a.n), conf: num(a.conf) };
  }
  return {
    points: solution.points.map((p) => (p ? { x: num(p.x), y: num(p.y), z: num(p.z), conf: num(p.conf) } : null)),
    aps,
    scaleConf: num(solution.scaleConf),
  };
}

// Lado da thread: carrega o solucionador, resolve e devolve a solução com o tempo gasto.
async function workerMain() {
  const { solverUrl, exportName, survey, options, oracle } = workerData;
  try {
    const mod = await import(solverUrl);
    const solve = mod[exportName];
    if (typeof solve !== 'function') throw new Error(`o módulo não exporta a função "${exportName}"`);
    const opts = { ...options };
    // Canal lateral dos oráculos: só existe quando o módulo é tests/mapping/baseline.mjs.
    if (oracle) opts.truth = buildScenario(oracle).truth;
    const t0 = performance.now();
    const solution = await solve(survey, opts);
    const ms = performance.now() - t0;
    parentPort.postMessage({ ok: true, solution: plainSolution(solution), ms });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
}

function solveInWorker(job, budgetMs) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: job });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    // Folga para a thread subir e importar o módulo; o tempo de solve é medido lá dentro.
    const timer = setTimeout(() => finish({ ok: false, timeout: true, error: `passou do tempo (${budgetMs} ms)` }), budgetMs + 5000);
    worker.once('message', finish);
    worker.once('error', (err) => finish({ ok: false, error: String((err && err.stack) || err) }));
    worker.once('exit', (code) => finish({ ok: false, error: `a thread terminou sem resposta (código ${code})` }));
  });
}

/**
 * Roda um cenário e mede o resultado.
 * @param {Object} desc     descrição vinda de listScenarios()
 * @param {Object} run
 * @param {string} run.solverPath  caminho do módulo do solucionador
 * @param {string} [run.exportName]
 * @param {number} [run.budgetMs]
 * @param {boolean} [run.inline]   roda na thread principal (depuração): sem corte de tempo forçado
 * @param {string} [run.svgDir]
 */
export async function runScenario(desc, run) {
  const scenario = buildScenario(desc);
  const { survey, truth } = scenario;
  const budgetMs = run.budgetMs ?? DEFAULT_BUDGET_MS;
  const exportName = run.exportName || 'solve';
  const solverPath = path.resolve(run.solverPath);
  const isBaseline = solverPath === BASELINE;
  const options = { budgetMs };

  let reply;
  if (run.inline) {
    try {
      const mod = await import(pathToFileURL(solverPath).href);
      if (typeof mod[exportName] !== 'function') throw new Error(`o módulo não exporta a função "${exportName}"`);
      const opts = isBaseline ? { ...options, truth } : options;
      const t0 = performance.now();
      const solution = await mod[exportName](structuredClone(survey), opts);
      reply = { ok: true, solution: plainSolution(solution), ms: performance.now() - t0 };
    } catch (err) {
      reply = { ok: false, error: String((err && err.stack) || err) };
    }
  } else {
    reply = await solveInWorker(
      { solverUrl: pathToFileURL(solverPath).href, exportName, survey, options, oracle: isBaseline ? desc : null },
      budgetMs,
    );
  }

  let metrics;
  if (!reply.ok) metrics = failure(reply.error, reply.timeout ? budgetMs : null);
  else if (reply.ms > budgetMs) metrics = failure(`passou do tempo (${Math.round(reply.ms)} ms > ${budgetMs} ms)`, reply.ms);
  else metrics = evaluate(reply.solution, truth, survey, { runtimeMs: reply.ms });

  const result = {
    name: desc.name,
    set: desc.set,
    group: desc.group,
    mode: desc.mode,
    scans: survey.scans.length,
    aps: Object.keys(survey.aps).length,
    durationMin: Math.round((truth.durationS / 60) * 10) / 10,
    ...metrics,
  };
  if (run.svgDir) {
    fs.mkdirSync(run.svgDir, { recursive: true });
    fs.writeFileSync(path.join(run.svgDir, `${desc.name}.svg`), renderSvg(scenario, reply.ok ? reply.solution : null, result));
  }
  return result;
}

/**
 * Roda um conjunto inteiro de cenários, alguns em paralelo.
 * @returns {Promise<{results:Object[], aggregate:Object, groups:Object, modes:Object}>}
 */
export async function runBench(run) {
  let scenarios = listScenarios(run.set || 'dev');
  if (run.only) scenarios = scenarios.filter((s) => s.name.includes(run.only));
  const results = new Array(scenarios.length);
  const jobs = Math.max(1, Math.min(run.jobs ?? 3, scenarios.length || 1));
  let next = 0;
  let printed = 0;
  const flush = () => {
    while (printed < results.length && results[printed]) {
      if (run.onResult) run.onResult(results[printed], printed, results.length);
      printed++;
    }
  };
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < scenarios.length) {
        const i = next++;
        results[i] = await runScenario(scenarios[i], run);
        flush();
      }
    }),
  );
  const by = (key) => {
    const groups = {};
    for (const r of results) (groups[r[key]] ||= []).push(r);
    return Object.fromEntries(Object.entries(groups).map(([k, list]) => [k, aggregate(list)]));
  };
  return { results, aggregate: aggregate(results), groups: by('group'), modes: by('mode') };
}

// ---------------------------------------------------------------------------
// Desenho (SVG) para conferir no olho
// ---------------------------------------------------------------------------

// Cores: superfície e tinta neutras; o erro usa um único tom (azul) do claro ao escuro;
// os roteadores da casa usam laranja. Texto nunca usa a cor do dado.
const INK = { surface: '#fcfcfb', room: '#f3f2ee', text: '#0b0b0b', text2: '#52514e', muted: '#8a8983', truth: '#b5b4ac' };
const ERROR_BINS = [
  { upTo: 0.5, color: '#86b6ef', label: 'até 0,5 m' },
  { upTo: 1, color: '#5598e7', label: '0,5 a 1 m' },
  { upTo: 2, color: '#2a78d6', label: '1 a 2 m' },
  { upTo: 4, color: '#1c5cab', label: '2 a 4 m' },
  { upTo: Infinity, color: '#0d366b', label: 'mais de 4 m' },
];
const AP_COLOR = '#eb6834';
const WALL_STYLE = {
  concrete: 'stroke="#3a3a37" stroke-width="3.5"',
  brick: 'stroke="#6b6a65" stroke-width="3"',
  drywall: 'stroke="#a3a29b" stroke-width="2"',
  glass: 'stroke="#a3a29b" stroke-width="1.5" stroke-dasharray="5 3"',
  wood: 'stroke="#d0cfc8" stroke-width="1.5"',
};

const br = (v, digits = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits).replace('.', ','));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Planta real com paredes e cômodos, caminho real em cinza, caminho estimado (depois do
 * alinhamento rígido) colorido pelo erro, e roteadores da casa: real x estimado.
 */
export function renderSvg(scenario, solution, result) {
  const { world, truth, survey } = scenario;
  const b = world.bounds;
  const margin = 2.5; // metros de folga em volta da planta, para estimativas que caem fora
  const scale = Math.min(60, 620 / (b.width + 2 * margin));
  const panelW = (b.width + 2 * margin) * scale;
  const panelH = (b.height + 2 * margin) * scale;
  const top = 64;
  const legendH = 64;
  const W = Math.max(panelW * world.floors + 24, 640);
  const H = top + panelH + legendH;
  const X = (x, f) => 12 + f * panelW + (x - b.minX + margin) * scale;
  const Y = (y) => top + panelH - (y - b.minY + margin) * scale;
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" font-family="system-ui, sans-serif">`,
    `<rect width="100%" height="100%" fill="${INK.surface}"/>`,
    `<text x="12" y="24" font-size="16" font-weight="600" fill="${INK.text}">${esc(result.name)}</text>`,
  );
  const summary = result.ok
    ? `nota ${br(result.score, 1)} · erro mediano ${br(result.medianRigid)} m · p90 ${br(result.p90Rigid)} m · só a forma ${br(result.medianSim)} m · escala ${br(result.scaleRatio)} · cômodo certo ${result.roomPurity == null ? '–' : Math.round(result.roomPurity * 100) + '%'} · ${result.scans} varreduras em ${br(result.durationMin, 1)} min`
    : `FALHOU: ${esc(String(result.error).split('\n')[0]).slice(0, 140)}`;
  out.push(`<text x="12" y="46" font-size="12" fill="${INK.text2}">${summary}</text>`);

  const valid = result.ok && solution;
  const fit = valid ? procrustes(solution.points, truth.points, { scale: false }) : null;
  const colorOf = (err) => ERROR_BINS.find((bin) => err <= bin.upTo).color;

  for (let f = 0; f < world.floors; f++) {
    if (world.floors > 1) {
      out.push(`<text x="${X(b.minX, f).toFixed(1)}" y="${(Y(b.maxY) - 8).toFixed(1)}" font-size="12" fill="${INK.text2}">${f === 0 ? 'Térreo' : `${f}º andar`}</text>`);
    }
    for (const r of world.roomsOn(f)) {
      out.push(`<polygon points="${r.polygon.map((p) => `${X(p[0], f).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ')}" fill="${INK.room}"/>`);
      out.push(`<text x="${X(r.centroid.x, f).toFixed(1)}" y="${Y(r.centroid.y).toFixed(1)}" font-size="11" text-anchor="middle" fill="${INK.muted}">${esc(r.name)}</text>`);
    }
    for (const w of world.wallsOn(f)) {
      out.push(`<line x1="${X(w.x1, f).toFixed(1)}" y1="${Y(w.y1).toFixed(1)}" x2="${X(w.x2, f).toFixed(1)}" y2="${Y(w.y2).toFixed(1)}" ${WALL_STYLE[w.material]} stroke-linecap="round"/>`);
    }
    // Caminho real: trechos seguidos no mesmo andar.
    let run = [];
    const flush = () => {
      if (run.length > 1) out.push(`<polyline points="${run.join(' ')}" fill="none" stroke="${INK.truth}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      run = [];
    };
    truth.points.forEach((p, i) => {
      if (truth.floors[i] === f) run.push(`${X(p.x, f).toFixed(1)},${Y(p.y).toFixed(1)}`);
      else flush();
    });
    flush();
    if (fit) {
      // Fio fino ligando cada estimativa ao lugar real, depois os pontos por cima.
      const dots = [];
      fit.aligned.forEach((p, i) => {
        if (truth.floors[i] !== f) return;
        const t = truth.points[i];
        const err = Math.hypot(p.x - t.x, p.y - t.y);
        const px = X(p.x, f).toFixed(1);
        const py = Y(p.y).toFixed(1);
        out.push(`<line x1="${px}" y1="${py}" x2="${X(t.x, f).toFixed(1)}" y2="${Y(t.y).toFixed(1)}" stroke="${INK.truth}" stroke-width="0.6"/>`);
        dots.push(
          `<circle cx="${px}" cy="${py}" r="4" fill="${colorOf(err)}" stroke="${INK.surface}" stroke-width="1.5"><title>varredura ${i + 1} · ${br(survey.scans[i].t, 0)} s · erro ${br(err)} m</title></circle>`,
        );
      });
      out.push(...dots);
    }
    // Roteadores da casa: quadrado cheio = real; anel = estimado.
    for (const ap of world.aps) {
      if (!ap.own || Math.max(0, Math.min(world.floors - 1, Math.floor(ap.z / FLOOR_HEIGHT))) !== f) continue;
      const ax = X(ap.x, f);
      const ay = Y(ap.y);
      const guess = fit && solution.aps && solution.aps[ap.bssid];
      if (guess && Number.isFinite(guess.x) && Number.isFinite(guess.y)) {
        const g = fit.apply(guess);
        const gx = Math.max(6, Math.min(W - 6, X(g.x, f)));
        const gy = Math.max(top, Math.min(top + panelH, Y(g.y)));
        out.push(`<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${gx.toFixed(1)}" y2="${gy.toFixed(1)}" stroke="${AP_COLOR}" stroke-width="1"/>`);
        out.push(
          `<circle cx="${gx.toFixed(1)}" cy="${gy.toFixed(1)}" r="6" fill="${INK.surface}" stroke="${AP_COLOR}" stroke-width="2"><title>${esc(ap.ssid || '(oculta)')} ${ap.band === 0 ? '2,4' : ap.band === 1 ? '5' : '6'} GHz estimado · erro ${br(Math.hypot(g.x - ap.x, g.y - ap.y))} m</title></circle>`,
        );
      }
      out.push(
        `<rect x="${(ax - 5).toFixed(1)}" y="${(ay - 5).toFixed(1)}" width="10" height="10" rx="2" fill="${AP_COLOR}" stroke="${INK.surface}" stroke-width="1.5"><title>${esc(ap.ssid || '(oculta)')} · posição real</title></rect>`,
      );
    }
  }

  // Legenda.
  const ly = top + panelH + 22;
  let lx = 12;
  const item = (mark, label, width) => {
    out.push(mark(lx, ly), `<text x="${lx + 20}" y="${ly + 4}" font-size="11" fill="${INK.text2}">${label}</text>`);
    lx += width;
  };
  item((x, y) => `<line x1="${x}" y1="${y}" x2="${x + 14}" y2="${y}" stroke="${INK.truth}" stroke-width="2"/>`, 'caminho real', 100);
  for (const bin of ERROR_BINS) {
    item((x, y) => `<circle cx="${x + 7}" cy="${y}" r="4" fill="${bin.color}"/>`, bin.label, 88);
  }
  lx = 12;
  const ly2 = ly + 22;
  out.push(
    `<rect x="${lx + 2}" y="${ly2 - 5}" width="10" height="10" rx="2" fill="${AP_COLOR}"/><text x="${lx + 20}" y="${ly2 + 4}" font-size="11" fill="${INK.text2}">roteador da casa (real)</text>`,
    `<circle cx="${lx + 177}" cy="${ly2}" r="5" fill="${INK.surface}" stroke="${AP_COLOR}" stroke-width="2"/><text x="${lx + 190}" y="${ly2 + 4}" font-size="11" fill="${INK.text2}">roteador estimado</text>`,
    `<text x="${lx + 320}" y="${ly2 + 4}" font-size="11" fill="${INK.muted}">pontos = posição estimada de cada varredura (alinhamento rígido), cor = erro</text>`,
  );
  out.push('</svg>');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Linha de comando
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { set: 'dev', exportName: 'solve', budgetMs: DEFAULT_BUDGET_MS, jobs: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`falta o valor de ${a}`);
      return argv[++i];
    };
    if (a === '--solver') args.solverPath = value();
    else if (a === '--export') args.exportName = value();
    else if (a === '--set') args.set = value();
    else if (a === '--only') args.only = value();
    else if (a === '--json') args.json = true;
    else if (a === '--inline') args.inline = true;
    else if (a === '--list') args.list = true;
    else if (a === '--budget-ms') args.budgetMs = Number(value());
    else if (a === '--jobs') args.jobs = Number(value());
    else if (a === '--svg') {
      // A pasta é opcional: sem ela vale WRX_SVG_DIR ou a pasta temporária do sistema.
      const nextArg = argv[i + 1];
      args.svgDir = nextArg && !nextArg.startsWith('--') ? argv[++i] : process.env.WRX_SVG_DIR || path.join(os.tmpdir(), 'wifi-raio-x-svg');
    } else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`opção desconhecida: ${a}`);
  }
  if (!['dev', 'holdout', 'all'].includes(args.set)) throw new Error('--set aceita dev, holdout ou all');
  if (!Number.isFinite(args.budgetMs) || args.budgetMs <= 0) throw new Error('--budget-ms precisa ser um número positivo');
  if (!Number.isFinite(args.jobs) || args.jobs < 1) throw new Error('--jobs precisa ser 1 ou mais');
  return args;
}

// Os desenhos nunca vão para dentro do repositório.
function assertOutsideRepo(dir) {
  let root = path.resolve(HERE, '..', '..');
  for (let p = root; ; p = path.dirname(p)) {
    if (fs.existsSync(path.join(p, '.git'))) root = p;
    if (p === path.dirname(p)) break;
  }
  const rel = path.relative(root, path.resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`--svg: escolha uma pasta fora do repositório (${root})`);
  }
}

const HELP = `Bancada do mapa 3D por Wi-Fi

  node tests/mapping/harness.mjs --solver <módulo> [opções]

  --solver <caminho>   módulo que exporta solve(survey, options) -> MapSolution
  --export <nome>      nome da função exportada (padrão: solve)
  --set dev|holdout|all   conjunto de cenários (padrão: dev)
  --only <trecho>      só os cenários cujo nome contém o trecho
  --json               imprime o resultado completo em JSON
  --svg [pasta]        grava um desenho por cenário (fora do repositório)
  --budget-ms <n>      tempo máximo por cenário (padrão: ${DEFAULT_BUDGET_MS}; o celular é 3 a 5x mais lento)
  --jobs <n>           cenários em paralelo (padrão: 3; use 1 para medir tempo com calma)
  --inline             roda na thread principal, sem corte de tempo forçado (depuração)
  --list               só lista os cenários
`;

const f = (v, width, digits = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits)).padStart(width);

function tableHeader() {
  return (
    'cenário'.padEnd(34) +
    ' var' +
    '   nota' +
    '  medR' +
    '  p90R' +
    '  rmsR' +
    '  medS' +
    ' escala' +
    ' apCasa' +
    ' apPerto' +
    ' confi' +
    ' conti' +
    ' cômodo' +
    ' andar' +
    '     ms'
  );
}

function tableRow(r) {
  if (!r.ok) return `${r.name.padEnd(34)}${String(r.scans).padStart(4)}${f(r.score, 7, 1)}  FALHOU: ${String(r.error).split('\n')[0].slice(0, 90)}`;
  return (
    r.name.padEnd(34) +
    String(r.scans).padStart(4) +
    f(r.score, 7, 1) +
    f(r.medianRigid, 6) +
    f(r.p90Rigid, 6) +
    f(r.rmseRigid, 6) +
    f(r.medianSim, 6) +
    f(r.scaleRatio, 7) +
    f(r.apErrOwn, 7) +
    f(r.apErrNear, 8) +
    f(r.trust, 6) +
    f(r.continuity, 6) +
    f(r.roomPurity, 7) +
    (r.floorOk ? '    ok' : '  ERRO') +
    f(r.runtimeMs, 7, 0)
  );
}

function summaryHeader() {
  return 'grupo'.padEnd(18) + '  n' + ' falhas' + '   nota' + '  medR' + '  p90R' + '  medS' + ' escala' + ' apCasa' + ' apPerto' + ' confi' + ' conti' + ' cômodo' + '     ms';
}

function summaryRow(name, a) {
  const m = a.mean;
  return (
    name.padEnd(18) +
    String(a.count).padStart(3) +
    String(a.failures).padStart(7) +
    f(a.score, 7, 1) +
    f(m.medianRigid, 6) +
    f(m.p90Rigid, 6) +
    f(m.medianSim, 6) +
    f(m.scaleRatio, 7) +
    f(a.median.apErrOwn, 7) +
    f(a.median.apErrNear, 8) +
    f(m.trust, 6) +
    f(m.continuity, 6) +
    f(m.roomPurity, 7) +
    f(m.runtimeMs, 7, 0)
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.list) {
    for (const s of listScenarios(args.set)) if (!args.only || s.name.includes(args.only)) console.log(s.name);
    return;
  }
  if (!args.solverPath) throw new Error('informe o solucionador: --solver <caminho do módulo>');
  if (!fs.existsSync(path.resolve(args.solverPath))) throw new Error(`módulo não encontrado: ${args.solverPath}`);
  if (args.svgDir) assertOutsideRepo(args.svgDir);

  const started = performance.now();
  if (!args.json) {
    console.log(`solucionador: ${args.solverPath}#${args.exportName} · conjunto: ${args.set} · tempo máximo: ${args.budgetMs} ms`);
    console.log('nota: 0 = perfeito, 100 = tudo num ponto só, 200 = falha · distâncias em metros');
    console.log(tableHeader());
  }
  const bench = await runBench({ ...args, onResult: args.json ? null : (r) => console.log(tableRow(r)) });
  const wallMs = performance.now() - started;

  if (args.json) {
    console.log(
      JSON.stringify(
        { solver: args.solverPath, export: args.exportName, set: args.set, budgetMs: args.budgetMs, wallMs: Math.round(wallMs), ...bench },
        (key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v),
        2,
      ),
    );
  } else {
    console.log('\nresumo (médias; apCasa e apPerto são medianas entre cenários)');
    console.log(summaryHeader());
    for (const [name, a] of Object.entries(bench.groups)) console.log(summaryRow(name, a));
    console.log('');
    for (const [name, a] of Object.entries(bench.modes)) console.log(summaryRow(name, a));
    console.log('');
    console.log(summaryRow('TOTAL', bench.aggregate));
    console.log(`\nNOTA FINAL: ${bench.aggregate.score.toFixed(1)}  (${bench.results.length} cenários, ${bench.aggregate.failures} falhas, ${(wallMs / 1000).toFixed(1)} s)`);
    if (args.svgDir) console.log(`desenhos em ${path.resolve(args.svgDir)}`);
  }
}

if (!isMainThread) {
  workerMain();
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`erro: ${err.message}`);
    process.exitCode = 1;
  });
}
