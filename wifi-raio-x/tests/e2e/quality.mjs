// Qualidade do mapa NO APP: o que o usuário recebe de verdade, medido com a mesma régua da bancada.
//
// A bancada (tests/mapping) mede o solucionador e o construtor com levantamentos montados por
// simulateSurvey(). O app monta os dele por outro caminho — ponte simulada, laço de buscas, gravador,
// piloto da demonstração, motor no Worker, armazenamento — e é nesse caminho que mora um erro de
// integração (tempo de caminhada fora de escala, pausa contada como caminhada, leitura velha...).
// Aqui o app de verdade roda no navegador contra o simulador, e de fora dele se observa:
//
//   installProbe(page)        dentro da página: guarda por onde a pessoa virtual andou de verdade e
//                             cada varredura nova entregue ao app (instante simulado + conteúdo)
//   readProbe(page)           -> o que a sonda guardou + o mundo em uso
//   savedRecord(page)         -> { survey, solution, own } do mapa salvo mais recente (armazenamento do app)
//   evaluateSession(...)      (Node) casa cada varredura do levantamento com o lugar real, refaz o
//                             modelo com buildMap (como o app ao abrir um mapa salvo) e mede com
//                             tests/mapping/metrics.mjs e map-eval.mjs: escala, erro de posição, área,
//                             ambientes, roteador, sinal
//
// A sonda só observa (eventos da ponte e sim.truth()); o app não sabe que ela existe.

import { hostileNeighbours } from '../../app/js/sim/demo-data.js';
import { presetSpec } from '../../app/js/sim/presets.js';
import { createWorld } from '../../app/js/sim/world.js';
import { buildMap } from '../../app/js/mapping/mapmodel.js';
import { FLOOR_HEIGHT } from '../../app/js/mapping/types.js';
import { evaluate } from '../mapping/metrics.mjs';
import { evaluateMap, truthSolution } from '../mapping/map-eval.mjs';

/** A lista de uma varredura chega ~1,35 s (simulados) depois do meio da escuta: é esse o instante da posição real. */
const SWEEP_MID_S = 1.35;

/** Liga a sonda (uma vez por página; sobrevive a trocas de rota, não a um reload). */
export async function installProbe(page, { everyMs = 20 } = {}) {
  await page.evaluate(async (every) => {
    if (window.__mq) return;
    const { currentSim } = await import('./js/sim/backend.js');
    const sim = currentSim();
    const mq = (window.__mq = { trace: [], scans: [], world: sim.worldId, seed: sim.seed });
    const push = () => {
      const p = sim.truth();
      const last = mq.trace[mq.trace.length - 1];
      if (!last || p.t > last[0]) mq.trace.push([p.t, p.x, p.y, p.z, p.floor]);
    };
    push();
    mq.timer = setInterval(push, every);
    mq.off = window.__wrx.app.bridge.on('scan', (ev) => {
      if (!ev || ev.fresh !== true || !Array.isArray(ev.aps) || !ev.aps.length) return;
      push();
      mq.scans.push({ t: sim.now(), ts: ev.ts, source: ev.source, aps: ev.aps.map((a) => [String(a.bssid).toLowerCase(), Math.round(a.level)]) });
    });
  }, everyMs);
}

/** O que a sonda viu até agora, mais o mundo e os roteadores dele (para conferir que o Node refez o mesmo mundo). */
export async function readProbe(page) {
  return page.evaluate(async () => {
    const { currentSim } = await import('./js/sim/backend.js');
    const sim = currentSim();
    const mq = window.__mq;
    return {
      trace: mq.trace,
      scans: mq.scans,
      world: sim.worldId,
      seed: sim.seed,
      speed: sim.speed,
      throttle: sim.state().throttle,
      aps: sim.world.aps.map((a) => [a.bssid, a.x, a.y, a.z]),
    };
  });
}

/** O mapa salvo mais recente, como está no armazenamento do app. */
export async function savedRecord(page) {
  return page.evaluate(async () => {
    const { openMapStore } = await import('./js/mapping/storage.js');
    const store = await openMapStore();
    const list = await store.list();
    if (!list.length) {
      store.close();
      return null;
    }
    list.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    const rec = await store.get(list[0].id);
    store.close();
    return { id: rec.id, name: rec.name, survey: rec.survey, solution: rec.solution, own: rec.own, stats: rec.stats, meta: rec.meta };
  });
}

/** O mesmo mundo que o simulador do app monta para (id, semente): planta pronta + vizinhos da demonstração. */
export function simWorld(id, seed = 1) {
  const spec = presetSpec(id, seed);
  spec.aps.push(...hostileNeighbours(spec));
  return createWorld(spec, seed);
}

/**
 * Lugares difíceis de verdade, feitos do apartamento pronto tirando roteadores:
 *   'emulador'         um roteador só, sempre a -50 dBm (é o que o emulador do Android oferece)
 *   'um-roteador'      só o roteador da casa (um rádio)
 *   'dois-roteadores'  o da casa e um vizinho
 * Devolve a receita (quais BSSIDs ficam e a propagação); a página e o Node montam o mundo dela.
 */
export const HARD_PLACES = Object.freeze({
  emulador: { preset: 'apartamento', keep: ['cc:d4:a1:3c:0e:00'], eirpDbm: 8, rf: { n: 0.0001, wallScale: 0, shadowSigmaDb: 0, fadeSigmaDb: 0, noiseSigmaDb: 0, outlierProb: 0, bodyLossDb: [0, 0, 0], missProb: 0 } },
  'um-roteador': { preset: 'apartamento', keep: ['cc:d4:a1:3c:0e:00'], rf: {} },
  'dois-roteadores': { preset: 'apartamento', keep: ['cc:d4:a1:3c:0e:00', 'cc:d4:a1:bc:78:e0'], rf: {} },
});

/** O mundo de uma receita de HARD_PLACES (no Node). */
export function hardWorld(recipe) {
  const spec = presetSpec(recipe.preset, 1);
  spec.aps = spec.aps.filter((a) => recipe.keep.includes(a.bssid));
  if (recipe.eirpDbm !== undefined) for (const a of spec.aps) a.eirpDbm = recipe.eirpDbm;
  return createWorld(spec, 1, recipe.rf || {});
}

/** Troca o mundo do simulador da página pelo de uma receita de HARD_PLACES (antes de começar o levantamento). */
export async function loadHardPlace(page, recipe) {
  await page.evaluate(async (r) => {
    const { presetSpec } = await import('./js/sim/presets.js');
    const { createWorld } = await import('./js/sim/world.js');
    const { currentSim } = await import('./js/sim/backend.js');
    const spec = presetSpec(r.preset, 1);
    spec.aps = spec.aps.filter((a) => r.keep.includes(a.bssid));
    if (r.eirpDbm !== undefined) for (const a of spec.aps) a.eirpDbm = r.eirpDbm;
    // mundo já montado: o simulador usa como está (sem acrescentar os vizinhos da demonstração)
    currentSim().loadWorld(createWorld(spec, 1, r.rf || {}));
  }, recipe);
}

function positionAt(trace, t) {
  let lo = 0;
  let hi = trace.length - 1;
  if (t <= trace[0][0]) return trace[0];
  if (t >= trace[hi][0]) return trace[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trace[mid][0] <= t) lo = mid;
    else hi = mid;
  }
  const a = trace[lo];
  const b = trace[hi];
  const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
  const near = u < 0.5 ? a : b;
  return [t, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u, near[4]];
}

/**
 * Casa as varreduras do levantamento com as que a sonda viu chegar (mesma ordem, mesmo conteúdo) e
 * devolve, para cada uma, o lugar real no meio da escuta.
 * @returns {{points: {x:number,y:number,z:number}[], floors: number[], times: number[], gaps: number, unmatched: number}}
 */
export function truthOfSurvey(survey, probe) {
  const points = [];
  const floors = [];
  const times = [];
  let next = 0;
  let unmatched = 0;
  let maxSkip = 0;
  const same = (scan, ev) => {
    const seen = new Map(ev.aps);
    let hit = 0;
    for (const r of scan.readings) if (seen.get(r.id) === r.rssi) hit++;
    // o gravador descarta leitura velha demais: basta quase todas baterem
    return scan.readings.length > 0 && hit >= Math.max(1, Math.ceil(0.9 * scan.readings.length));
  };
  for (const scan of survey.scans) {
    let found = -1;
    for (let j = next; j < probe.scans.length; j++) {
      if (same(scan, probe.scans[j])) {
        found = j;
        break;
      }
    }
    if (found < 0) {
      unmatched++;
      const last = points[points.length - 1] || { x: NaN, y: NaN, z: NaN };
      points.push({ ...last });
      floors.push(floors[floors.length - 1] ?? 0);
      times.push(times[times.length - 1] ?? 0);
      continue;
    }
    maxSkip = Math.max(maxSkip, found - next);
    next = found + 1;
    const ev = probe.scans[found];
    const p = positionAt(probe.trace, ev.t - SWEEP_MID_S);
    points.push({ x: p[1], y: p[2], z: p[3] });
    floors.push(Math.max(0, Math.floor(p[3] / FLOOR_HEIGHT)));
    times.push(ev.t);
  }
  return { points, floors, times, unmatched, maxSkip };
}

const median = (v) => {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/**
 * Mede uma sessão do app.
 * @param {{probe: object, record: {survey:object, solution:object, own:string[]}}} o
 * @returns {object} números da sessão (ver as chaves no fim)
 */
export function evaluateSession({ probe, record, world: given }) {
  const world = given || simWorld(probe.world, probe.seed);
  // O Node refez o mesmo mundo da página?
  const mine = new Map(world.aps.map((a) => [a.bssid, a]));
  for (const [id, x, y] of probe.aps) {
    const a = mine.get(id);
    if (!a || Math.abs(a.x - x) > 1e-6 || Math.abs(a.y - y) > 1e-6) throw new Error(`o mundo refeito no Node não é o da página (roteador ${id})`);
  }
  const { survey, solution } = record;
  const t = truthOfSurvey(survey, probe);
  if (t.unmatched > 0) throw new Error(`${t.unmatched} de ${survey.scans.length} varreduras do levantamento não foram vistas chegando pela ponte`);
  const startFloor = t.floors.length ? t.floors[0] - survey.scans[0].floor : 0;
  const truth = {
    points: t.points,
    floors: t.floors,
    times: t.times,
    world,
    startFloor,
    aps: Object.fromEntries(world.aps.map((a) => [a.bssid, { x: a.x, y: a.y, z: a.z }])),
    durationS: t.times.length ? t.times[t.times.length - 1] - t.times[0] : 0,
  };
  const scenario = { survey, truth, world, desc: { name: `${probe.world}-app` } };
  const pos = evaluate(solution, truth, survey);
  const map = evaluateMap(scenario, solution, { own: record.own || [] });
  const model = buildMap(survey, solution, { own: record.own || [] });
  // O teto deste levantamento: o mesmo mapa com as posições reais (o que falta aqui é caminhada, não conta).
  const ideal = evaluateMap(scenario, truthSolution(scenario), { own: record.own || [] }).metrics;

  // Relógio de caminhada x tempo simulado: os intervalos entre varreduras seguidas têm de bater
  // (é aqui que aparece tempo fora de escala, pausa contada como caminhada...).
  const ratios = [];
  let floorWrong = 0;
  for (let i = 1; i < survey.scans.length; i++) {
    const walk = survey.scans[i].t - survey.scans[i - 1].t;
    const real = t.times[i] - t.times[i - 1];
    if (real > 1 && walk > 0 && walk < 25) ratios.push(walk / real);
  }
  survey.scans.forEach((s, i) => {
    if (s.floor + startFloor !== t.floors[i]) floorWrong++;
  });
  const gaps = [];
  for (let i = 1; i < survey.scans.length; i++) gaps.push(survey.scans[i].t - survey.scans[i - 1].t);
  // Passo real entre varreduras seguidas (m/s): o que o solucionador tem de adivinhar para a escala.
  const speeds = [];
  for (let i = 1; i < survey.scans.length; i++) {
    const dt = t.times[i] - t.times[i - 1];
    if (dt > 0.5 && dt < 12 && !survey.scans[i].still && !survey.scans[i - 1].still) speeds.push(Math.hypot(t.points[i].x - t.points[i - 1].x, t.points[i].y - t.points[i - 1].y) / dt);
  }
  // Rótulos: o nome que o lugar marcado recebeu é o do cômodo em que a pessoa estava?
  let labelled = 0;
  let labelOk = 0;
  survey.scans.forEach((s, i) => {
    if (!s.label) return;
    labelled++;
    const room = world.roomAt(t.points[i].x, t.points[i].y, t.floors[i]);
    if (room && room.name === s.label) labelOk++;
  });
  const ownWorld = world.aps.filter((a) => a.own).map((a) => a.bssid);
  const ownGot = new Set(record.own || []);
  return {
    world: probe.world,
    scans: survey.scans.length,
    spots: new Set(survey.scans.map((s) => s.spot).filter((v) => v !== null)).size,
    labels: new Set(survey.scans.map((s) => s.label).filter(Boolean)).size,
    track: (survey.track || []).length,
    durationS: survey.scans.length ? survey.scans[survey.scans.length - 1].t : 0,
    cadenceS: median(gaps),
    clockRatio: median(ratios),
    walkSpeed: median(speeds),
    floorWrong,
    labelOk: labelled ? labelOk / labelled : null,
    ownMissing: ownWorld.filter((id) => survey.aps[id] && !ownGot.has(id)).length,
    ownExtra: [...ownGot].filter((id) => !ownWorld.includes(id)).length,
    // posições (régua de harness.mjs)
    score: pos.score,
    medianErr: pos.medianRigid,
    p90Err: pos.p90Rigid,
    scale: pos.scaleRatio,
    roomOfScan: pos.roomPurity,
    apErrOwn: pos.apErrOwn,
    // mapa (régua de map-eval.mjs)
    iou: map.metrics.iou,
    areaRatio: map.metrics.ratio,
    areaM2: map.metrics.areaM2,
    ari: map.metrics.ari,
    ariIn: map.metrics.ariIn,
    roomPurity: map.metrics.roomPurity,
    nameAcc: map.metrics.nameAcc,
    rooms: map.metrics.rooms,
    // ambientes com nome dado pelo usuário, e quanto da área com ambientes é só "trecho sem nome" (Ambiente N)
    roomsNamed: model.floors.reduce((n, f) => n + f.rooms.filter((r) => !r.auto).length, 0),
    unnamedShare: 1 - (map.metrics.namedShare ?? 0),
    roomsTrue: map.metrics.roomsTrue,
    routerErr: map.metrics.routerErr,
    heatRmse: map.metrics.heatRmse,
    heatBias: map.metrics.heatBias,
    expErr: map.metrics.expErr,
    level: map.metrics.level,
    notes: model.quality.notes,
    scaleConf: model.quality.scaleConf,
    solverConf: median(solution.points.map((p) => p.conf)),
    idealAreaRatio: ideal.ratio,
    idealIou: ideal.iou,
    idealAriIn: ideal.ariIn,
    idealNameAcc: ideal.nameAcc,
    idealHeatRmse: ideal.heatRmse,
    maxSkip: t.maxSkip,
  };
}

/** Linha de tabela para os relatórios. */
export function sessionRow(name, m) {
  const f = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(d));
  return [
    name.padEnd(30),
    String(m.scans).padStart(4),
    String(m.spots).padStart(4),
    f(m.cadenceS, 1).padStart(6),
    f(m.clockRatio).padStart(6),
    f(m.score, 1).padStart(6),
    f(m.medianErr).padStart(6),
    f(m.scale).padStart(6),
    f(m.areaRatio).padStart(6),
    f(m.iou).padStart(6),
    f(m.ariIn).padStart(6),
    f(m.nameAcc).padStart(6),
    f(m.roomOfScan).padStart(6),
    f(m.routerErr, 1).padStart(6),
    f(m.heatRmse, 1).padStart(6),
    f(m.expErr, 1).padStart(6),
    String(m.level).padStart(9),
  ].join('');
}
export const SESSION_HEADER =
  'sessão'.padEnd(30) + ' var' + ' lug' + '  cad.' + ' relóg' + '  nota' + '  erro' + '   esc' + '  área' + '   IoU' + ' ARIin' + '  nome' + ' cômodo' + '   rot' + ' calor' + '  errE' + '    nível';
