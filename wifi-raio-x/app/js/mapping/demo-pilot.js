// Piloto da demonstração: faz a pessoa virtual percorrer a casa virtual sozinha enquanto um
// levantamento é gravado, para mostrar o mapa 3D sem ninguém precisar andar.
//
// SÓ para o modo demonstração (precisa dos controles do simulador: currentSim() de sim/backend.js).
//
//   const pilot = createDemoPilot({ sim, recorder, scanLoop, onStep });
//   pilot.start({ speed = 8, spots = true })   -> true se começou
//   pilot.stop()                               para e devolve o simulador como estava
//   pilot.running
//
//   onStep({ phase, room, progress, scans, spots, rooms: { marked, total }, complete })
//     phase: 'walking' (andando) | 'marking' (parado, marcando um ponto) | 'paused' (a gravação está em
//            pausa) | 'done' (terminou) | 'stopped' (interrompido por stop())
//     room:  nome do cômodo em que a pessoa virtual está (ou null); progress: 0..1
//
// O que ele faz: põe a pessoa para passear ('auto'); ao chegar ao meio de um cômodo ainda sem
// ponto, para ('still'), marca um ponto com o nome do cômodo (o simulador sabe onde ela está),
// espera 3 varreduras e segue. Para seguir, manda a pessoa direto ao cômodo sem ponto mais
// próximo (walker.goTo): o passeio 'auto' recomeça do ponto de partida a cada parada, e numa
// casa grande isso levaria vários minutos. Com todos os cômodos marcados, volta ao passeio
// 'auto' (marcando mais um ou dois pontos nos cômodos grandes) até juntar o mínimo de
// varreduras — é esse passeio que dá corpo à área do mapa. No fim, ou em stop(), devolve a
// velocidade e o modo de andar que o simulador tinha.
//
// Tempo: o simulador é acelerado (speed), então a casa inteira leva bem menos de um minuto de
// relógio. O gravador recebe a mesma escala (recorder.setTimeScale), para o levantamento sair em
// tempo de caminhada. E as varreduras são pedidas direto à ponte, uma a cada 3 s DE CAMINHADA:
// pelo laço de buscas do app (scan-loop.js) o intervalo mínimo é de 1,5 s de relógio, o que com
// o tempo 8x acelerado daria uma varredura a cada 8 metros andados. As listas chegam pelo
// evento 'scan' de sempre: passam pelo laço, entram no store e a tela as entrega ao gravador.

import { scan as bridgeScan } from '../bridge.js';
import { navGrid } from '../sim/walk.js';

export const PILOT_DEFAULTS = Object.freeze({
  speed: 8,
  /** intervalo entre pedidos de varredura (s de caminhada): o ritmo do app ao mapear */
  scanEveryS: 3,
  scansPerSpot: 3,
  /** varreduras para terminar: uma por m² de casa, entre estes limites (o nível 'bom' do gravador pede 60 medições úteis) */
  minScans: 80,
  maxScans: 110,
  scansPerM2: 1,
  /** trocar de andar "custa" isto (m) ao escolher o próximo cômodo */
  floorCostM: 15,
  tickS: 0.4,
  /** depois disto (s de caminhada) termina com o que tiver */
  maxWalkS: 1500,
  /** um ponto que não completa as varreduras neste tempo é encerrado assim mesmo */
  spotTimeoutS: 40,
  /** pontos a mais nos cômodos grandes: distância mínima dos outros pontos e da parede (m) */
  extraSpotM: 3.2,
  extraWallM: 0.5,
  extraGapS: 9,
});

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Cômodos em que dá para entrar andando. */
function reachableRooms(world) {
  try {
    const nav = navGrid(world);
    const ok = new Set();
    for (const g of nav.floors) {
      for (let c = 0; c < g.room.length; c++) if (g.room[c] >= 0 && g.comp[c] === nav.main) ok.add(g.room[c]);
    }
    const list = world.rooms.filter((r) => ok.has(r.index));
    return list.length ? list : world.rooms.slice();
  } catch {
    return Array.isArray(world.rooms) ? world.rooms.slice() : [];
  }
}

/**
 * @param {object} deps
 * @param {object} deps.sim            controles do simulador (currentSim())
 * @param {ReturnType<import('./recorder.js').createRecorder>} deps.recorder
 * @param {{setMode?:Function, getState?:Function}} [deps.scanLoop]   posto em modo 'mapping' enquanto o piloto roda
 * @param {(step:object) => void} [deps.onStep]
 * @param {() => Promise<{accepted:boolean, reason?:string}>} [deps.requestScan]  (testes) padrão: bridge.scan()
 * @param {{now:() => number, setTimeout:Function, clearTimeout:Function}} [deps.clock]  (testes)
 * @param {Partial<typeof PILOT_DEFAULTS>} [deps.config]
 */
export function createDemoPilot({ sim, recorder, scanLoop = null, onStep, requestScan, clock, config } = {}) {
  const cfg = { ...PILOT_DEFAULTS, ...(config || {}) };
  const time = clock && typeof clock.now === 'function' ? clock : { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) };
  const askScan = typeof requestScan === 'function' ? requestScan : () => bridgeScan();

  let running = false;
  let timer = null;
  let saved = null; // como o simulador estava antes
  let speed = 1;
  let wantSpots = true;
  let minScans = cfg.minScans;

  let rooms = [];
  let marks = new Map(); // índice do cômodo -> [{x, y}] pontos marcados nele
  let skipped = new Set(); // cômodos aonde não deu para chegar
  let visited = new Set();
  let target = null; // cômodo para onde a pessoa foi mandada (modo 'manual'); null = passeio 'auto'
  let targetSinceS = 0;
  let floorOffset = 0;
  let phase = 'walking';
  let startedAt = 0; // relógio (ms)
  let lastAskS = -Infinity;
  let spotRoom = null;
  let spotAt = null;
  let spotSinceS = 0;
  let lastSpotEndS = -Infinity;
  let inRoom = -1;
  let enteredS = 0;
  let closest = Infinity;
  let progress = 0;
  let lastStepKey = '';

  /** Segundos de caminhada desde o começo do piloto. */
  const walkS = () => ((time.now() - startedAt) * speed) / 1000;
  const roomByIndex = (index) => rooms.find((r) => r.index === index) || null;

  function report(extra = {}) {
    const stats = recorder.stats();
    const marked = rooms.reduce((n, r) => n + (marks.has(r.index) ? 1 : 0), 0);
    const total = rooms.length - (wantSpots ? rooms.reduce((n, r) => n + (skipped.has(r.index) && !marks.has(r.index) ? 1 : 0), 0) : 0);
    const scanPart = Math.min(1, stats.scans / Math.max(1, minScans));
    const roomPart = wantSpots ? (total ? marked / total : 1) : total ? Math.min(1, visited.size / total) : 1;
    progress = phase === 'done' ? 1 : Math.max(progress, Math.min(0.99, 0.65 * roomPart + 0.35 * scanPart));
    const step = {
      phase,
      room: extra.room !== undefined ? extra.room : null,
      progress: Math.round(progress * 1000) / 1000,
      scans: stats.scans,
      spots: stats.spots,
      rooms: { marked: wantSpots ? marked : visited.size, total },
      ...extra,
    };
    const key = `${step.phase}|${step.room}|${Math.round(step.progress * 100)}|${step.scans}|${step.spots}`;
    if (key === lastStepKey) return;
    lastStepKey = key;
    if (typeof onStep !== 'function') return;
    try {
      onStep(step);
    } catch (err) {
      console.error('[demo-pilot] erro em onStep', err);
    }
  }

  function ask(nowS) {
    lastAskS = nowS;
    Promise.resolve()
      .then(askScan)
      .catch(() => null); // recusada ou sem ponte: tenta de novo no próximo intervalo
  }

  const pending = () => rooms.filter((r) => !marks.has(r.index) && !skipped.has(r.index));

  /** Manda a pessoa ao cômodo sem ponto mais próximo; sem nenhum (ou sem caminho), volta ao passeio. */
  function headOn(pos, nowS) {
    const left = pending().sort((a, b) => cost(a, pos) - cost(b, pos));
    for (const room of left) {
      if (sim.walker.goTo(room.centroid.x, room.centroid.y, room.floor)) {
        target = room;
        targetSinceS = nowS;
        return;
      }
      skipped.add(room.index); // sem caminho até lá
    }
    target = null;
    sim.walker.setMode('auto');
  }
  const cost = (room, pos) => dist(room.centroid, pos) + cfg.floorCostM * Math.abs(room.floor - pos.floor);

  /** É hora de parar e marcar um ponto aqui? */
  function shouldMark(room, pos, nowS) {
    const list = marks.get(room.index);
    const d = dist(pos, room.centroid);
    if (!list) {
      const radius = Math.sqrt(room.area / Math.PI);
      const near = d <= Math.max(0.6, 0.35 * radius);
      // a caminho de outro cômodo, só marca este se passar pelo meio dele (senão volta depois)
      if (target && target !== room) return near;
      // chegou aonde foi mandada (o meio do cômodo pode não ser pisável: vale o ponto mais perto)
      if (target === room && !pos.moving && nowS - targetSinceS >= 1) return true;
      // no passeio: já passou pelo mais perto do meio a que ia chegar, ou está há um bom tempo no cômodo
      const leaving = !target && nowS - enteredS >= 2 && d > closest + 0.3;
      const long = !target && nowS - enteredS >= 8;
      closest = Math.min(closest, d);
      return near || leaving || long;
    }
    // pontos a mais só depois que todo cômodo tem o seu
    if (pending().length) return false;
    const quota = Math.max(1, Math.min(3, Math.round(room.area / 9)));
    if (list.length >= quota || nowS - lastSpotEndS < cfg.extraGapS) return false;
    if (typeof sim.world.wallDistance === 'function' && sim.world.wallDistance(pos.x, pos.y, pos.floor) < cfg.extraWallM) return false;
    return list.every((p) => dist(p, pos) >= cfg.extraSpotM);
  }

  function restore() {
    if (!saved) return;
    const before = saved;
    saved = null;
    try {
      sim.setSpeed(before.speed);
      sim.walker.setMode(before.mode);
    } catch {
      // o simulador foi trocado ou encerrado no meio: não há o que devolver
    }
    if (typeof recorder.setTimeScale === 'function') recorder.setTimeScale(before.timeScale);
    if (scanLoop && before.loopMode && typeof scanLoop.setMode === 'function') scanLoop.setMode(before.loopMode);
  }

  function finish(endPhase, extra = {}) {
    if (!running) return;
    running = false;
    if (timer !== null) time.clearTimeout(timer);
    timer = null;
    if (recorder.currentSpot) recorder.endSpot();
    phase = endPhase;
    restore();
    report({ room: null, ...extra });
  }

  function tick() {
    timer = null;
    if (!running) return;
    try {
      step();
    } catch (err) {
      console.error('[demo-pilot] parou por erro', err);
      finish('stopped', { error: String((err && err.message) || err) });
      return;
    }
    if (running) timer = time.setTimeout(tick, Math.max(10, (cfg.tickS * 1000) / speed));
  }

  function step() {
    const nowS = walkS();
    const state = recorder.state;
    if (state === 'stopped' || state === 'idle') return finish('stopped');
    const pos = sim.truth();
    const room = typeof sim.world.roomAt === 'function' ? sim.world.roomAt(pos.x, pos.y, pos.floor) : null;
    const roomName = room ? room.name : null;

    if (state === 'paused') {
      // o usuário pausou a gravação: a pessoa virtual espera
      if (phase !== 'paused') {
        phase = 'paused';
        spotRoom = null;
        sim.walker.setMode('still');
      }
      return report({ room: roomName });
    }
    if (phase === 'paused') {
      phase = 'walking';
      sim.walker.setMode('auto');
    }

    if (nowS - lastAskS >= cfg.scanEveryS) ask(nowS);

    if (phase === 'marking') {
      const spot = recorder.currentSpot;
      const enough = spot && spot.scans >= cfg.scansPerSpot;
      if (!spot || enough || nowS - spotSinceS > cfg.spotTimeoutS) {
        if (spot) recorder.endSpot();
        if (spotRoom && (!spot || spot.scans > 0)) {
          if (!marks.has(spotRoom.index)) marks.set(spotRoom.index, []);
          marks.get(spotRoom.index).push(spotAt);
        }
        spotRoom = null;
        lastSpotEndS = nowS;
        phase = 'walking';
        headOn(pos, nowS);
      }
      return report({ room: roomName });
    }

    // --- andando ---
    const floor = pos.floor + floorOffset;
    if (floor !== recorder.floor) recorder.setFloor(floor);
    if (room) visited.add(room.index);
    const index = room ? room.index : -1;
    if (index !== inRoom) {
      inRoom = index;
      enteredS = nowS;
      closest = Infinity;
    }

    const stats = recorder.stats();
    const allMarked = wantSpots ? pending().length === 0 : rooms.every((r) => visited.has(r.index));
    if (allMarked && stats.scans >= minScans) return finish('done', { complete: true });
    if (nowS > cfg.maxWalkS) return finish('done', { complete: false });

    if (wantSpots && room && roomByIndex(room.index) && shouldMark(room, pos, nowS)) {
      sim.walker.setMode('still');
      const id = recorder.beginSpot(room.name);
      if (id !== null) {
        phase = 'marking';
        spotRoom = room;
        spotAt = { x: pos.x, y: pos.y };
        spotSinceS = nowS;
        target = null;
        return report({ room: roomName });
      }
    }
    if (target && !pos.moving && nowS - targetSinceS >= 1) {
      // chegou e não havia o que marcar (parou fora do cômodo pedido): esse fica para trás
      skipped.add(target.index);
      headOn(pos, nowS);
    } else if (!target && sim.walker.mode !== 'auto') {
      sim.walker.setMode('auto'); // alguém mexeu no modo de andar: retoma o passeio
    }
    report({ room: roomName });
  }

  /**
   * @param {{speed?: number, spots?: boolean, minScans?: number}} [options]
   * @returns {boolean} false quando não dá para começar (sem simulador, ou já rodando)
   */
  function start(options = {}) {
    if (running) return false;
    if (!sim || !sim.walker || typeof sim.truth !== 'function' || !sim.world || !recorder) return false;
    const opts = options && typeof options === 'object' ? options : {};
    wantSpots = opts.spots !== false;

    saved = {
      speed: sim.speed,
      mode: sim.walker.mode,
      timeScale: typeof recorder.timeScale === 'number' ? recorder.timeScale : 1,
      loopMode: scanLoop && typeof scanLoop.getState === 'function' ? scanLoop.getState().mode : null,
    };
    speed = sim.setSpeed(Number.isFinite(opts.speed) && opts.speed > 0 ? opts.speed : cfg.speed);
    if (typeof recorder.setTimeScale === 'function') recorder.setTimeScale(speed);
    if (scanLoop && typeof scanLoop.setMode === 'function') scanLoop.setMode('mapping');
    if (recorder.state === 'idle') recorder.start();
    else if (recorder.state === 'paused') recorder.resume();

    rooms = reachableRooms(sim.world);
    const area = rooms.reduce((sum, r) => sum + (Number.isFinite(r.area) ? r.area : 0), 0);
    minScans = Number.isFinite(opts.minScans) && opts.minScans > 0 ? opts.minScans : Math.max(cfg.minScans, Math.min(cfg.maxScans, Math.round(area * cfg.scansPerM2)));
    marks = new Map();
    skipped = new Set();
    visited = new Set();
    target = null;
    floorOffset = recorder.floor - sim.truth().floor;
    phase = 'walking';
    startedAt = time.now();
    lastAskS = -Infinity;
    spotRoom = null;
    lastSpotEndS = -Infinity;
    inRoom = -1;
    progress = 0;
    lastStepKey = '';
    running = true;
    sim.walker.setMode('auto');
    report({ room: sim.truth().room });
    timer = time.setTimeout(tick, 0);
    return true;
  }

  return {
    start,
    /** Interrompe o piloto e devolve a velocidade e o modo de andar que o simulador tinha. */
    stop: () => finish('stopped'),
    get running() {
      return running;
    },
  };
}
