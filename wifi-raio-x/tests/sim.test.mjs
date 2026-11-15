// Testes do simulador de rádio: gerador com semente, propagação, varreduras,
// mundos prontos, caminhada e o formato do levantamento.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FLOOR_HEIGHT } from '../app/js/mapping/types.js';
import { createRng, hashGaussian, hashSeed, hashUniform, mulberry32 } from '../app/js/sim/prng.js';
import { listPresets, presetSpec, presetWorld, randomSpec, randomWorld } from '../app/js/sim/presets.js';
import { navGrid, planWalk, simulateSurvey } from '../app/js/sim/walk.js';
import { DEFAULT_RF, MATERIALS, PHONE_HEIGHT, createWorld, pointInPolygon } from '../app/js/sim/world.js';

const SIM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'js', 'sim');
const PRESETS = listPresets().map((p) => p.id);
const KINDS = ['tour', 'perimeter', 'spots'];

// Mundo de laboratório: galpão de 40 x 10 m, dois andares, um roteador de duas faixas.
// Sem sombra nem ruído quando o teste quer conferir a conta exata.
function lab(walls = [], rf = {}) {
  const box = { device: 'caixa', own: true, x: 5, y: 5, z: PHONE_HEIGHT, capabilities: '[WPA2-PSK-CCMP][ESS]' };
  const spec = {
    name: 'Laboratório',
    floors: 2,
    outline: [
      [0, 0],
      [40, 0],
      [40, 10],
      [0, 10],
    ],
    walls,
    rooms: [],
    aps: [
      { ...box, bssid: 'AA:BB:CC:00:00:10', ssid: 'Lab', freq: 2437, widthMHz: 20, standard: 6, eirpDbm: 20 },
      { ...box, bssid: 'aa:bb:cc:00:00:14', ssid: 'Lab-5G', freq: 5220, widthMHz: 80, standard: 6, eirpDbm: 20 },
    ],
  };
  return createWorld(spec, 7, { shadowSigmaDb: 0, ...rf });
}
const wallAt = (x, material, floor = 0) => ({ floor, x1: x, y1: 0, x2: x, y2: 10, material });
const at = (x, y = 5, floor = 0) => ({ x, y, z: floor * FLOOR_HEIGHT + PHONE_HEIGHT });
const mean = (list) => list.reduce((s, v) => s + v, 0) / list.length;
const std = (list) => {
  const m = mean(list);
  return Math.sqrt(mean(list.map((v) => (v - m) ** 2)));
};

function tourSurvey(id, seed = 1, options = {}) {
  const world = presetWorld(id, seed);
  const plan = planWalk(world, {
    kind: options.kind || 'tour',
    seed,
    minLengthM: options.minLengthM ?? 120,
    count: options.count,
    floorOrder: options.floorOrder,
  });
  return { world, plan, ...simulateSurvey(world, plan, { seed, scanIntervalS: options.scanIntervalS ?? 3.5 }) };
}

// ---------------------------------------------------------------------------

test('gerador: mesma semente repete, sementes diferentes divergem', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  const seqA = Array.from({ length: 8 }, a);
  assert.deepEqual(seqA, Array.from({ length: 8 }, b));
  assert.notDeepEqual(seqA, Array.from({ length: 8 }, c));
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
  assert.equal(hashSeed('a', 1, 2.5), hashSeed('a', 1, 2.5));
  assert.notEqual(hashSeed(1), hashSeed(2));
  assert.notEqual(hashSeed(0.5), hashSeed(1.5));
  assert.notEqual(createRng('x', 1).next(), createRng('x', 2).next());
});

test('gerador: gaussiana, sorteio e embaralhamento', () => {
  const rng = createRng('estatística', 3);
  const g = Array.from({ length: 20000 }, () => rng.gaussian(2, 3));
  assert.ok(Math.abs(mean(g) - 2) < 0.1);
  assert.ok(Math.abs(std(g) - 3) < 0.1);
  const list = [1, 2, 3, 4, 5, 6, 7];
  const shuffled = rng.shuffle(list);
  assert.deepEqual(list, [1, 2, 3, 4, 5, 6, 7], 'shuffle não altera a lista original');
  assert.deepEqual(shuffled.slice().sort(), list);
  for (let i = 0; i < 50; i++) {
    assert.ok(list.includes(rng.pick(list)));
    const n = rng.int(3, 5);
    assert.ok(n >= 3 && n <= 5 && Number.isInteger(n));
  }
  assert.match(rng.hex(6), /^[0-9A-F]{6}$/);
  // Ruído sem estado: mesma chave, mesmo valor; estatística de normal padrão.
  assert.equal(hashGaussian(1, 2, 3), hashGaussian(1, 2, 3));
  const h = Array.from({ length: 20000 }, (_, i) => hashGaussian(99, i));
  assert.ok(Math.abs(mean(h)) < 0.05 && Math.abs(std(h) - 1) < 0.05);
  const u = Array.from({ length: 5000 }, (_, i) => hashUniform('u', i));
  assert.ok(u.every((v) => v >= 0 && v < 1) && Math.abs(mean(u) - 0.5) < 0.03);
});

test('o simulador não usa Math.random, Date.now nem APIs do Node', () => {
  for (const file of ['prng.js', 'world.js', 'presets.js', 'walk.js']) {
    // Os comentários podem citar os nomes proibidos; o código, não.
    const code = fs
      .readFileSync(path.join(SIM_DIR, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const found = code.match(/Math\.random|Date\.now|new Date\(|process\.|require\(|from 'node:|Buffer\./);
    assert.equal(found, null, `${file} usa ${found && found[0]}`);
  }
});

test('propagação: p0 perto de -38 dBm em 2,4 GHz e 6 a 8 dB abaixo em 5 GHz', () => {
  const world = lab();
  const [a24, a5] = world.aps;
  assert.ok(a24.p0 > -43 && a24.p0 < -33, `p0 2,4 GHz = ${a24.p0}`);
  const gap = a24.p0 - a5.p0;
  assert.ok(gap > 5.5 && gap < 8.5, `diferença 2,4 x 5 GHz = ${gap}`);
  assert.ok(a24.n >= 2.0 && a24.n <= 2.2);
  assert.equal(a24.bssid, 'aa:bb:cc:00:00:10', 'BSSID sempre em minúsculas');
});

test('propagação: mais perto é mais forte, com a queda do modelo log-distância', () => {
  const world = lab();
  const ap = world.aps[0];
  const near = world.meanRssi(ap, at(7));
  const far = world.meanRssi(ap, at(13));
  assert.ok(Math.abs(near - far - 10 * ap.n * Math.log10(8 / 2)) < 1e-9);
  // Colado no roteador a distância é limitada em 0,5 m.
  assert.equal(world.meanRssi(ap, at(5.1)), world.meanRssi(ap, at(5.3)));
  // Com sombra, vale na média.
  const shadowed = lab([], { shadowSigmaDb: 3 });
  const ring = (r) =>
    mean(Array.from({ length: 60 }, (_, i) => shadowed.meanRssi(shadowed.aps[0], at(5 + r * Math.cos(i), 5 + 0.1 * r * Math.sin(i)))));
  assert.ok(ring(3) > ring(9) + 6);
});

test('propagação: cada parede tira mais ou menos a perda do seu material', () => {
  for (const [material, { loss }] of Object.entries(MATERIALS)) {
    const open = lab();
    const walled = lab([wallAt(10, material)]);
    for (const band of [0, 1]) {
      const drop = open.meanRssi(open.aps[band], at(12)) - walled.meanRssi(walled.aps[band], at(12));
      assert.ok(Math.abs(drop - loss[band]) < 0.01, `${material} faixa ${band}: ${drop}`);
      // Antes da parede nada muda.
      assert.equal(open.meanRssi(open.aps[band], at(8)), walled.meanRssi(walled.aps[band], at(8)));
    }
    assert.ok(loss[1] > loss[0] && loss[2] >= loss[1], `${material}: perde mais nas faixas altas`);
  }
  const e = lab([wallAt(10, 'brick')]).explain('aa:bb:cc:00:00:10', at(12));
  assert.equal(e.wallCount, 1);
  assert.ok(Math.abs(e.walls - 6) < 0.01 && e.slabs === 0);
});

test('propagação: 5 GHz sofre mais que 2,4 GHz atrás de paredes', () => {
  const world = lab([wallAt(10, 'concrete')]);
  const gap = (pos) => world.meanRssi(world.aps[0], pos) - world.meanRssi(world.aps[1], pos);
  assert.ok(gap(at(12)) > gap(at(8)) + 4);
});

test('propagação: incidência rasante aumenta a perda, com teto', () => {
  const world = lab([wallAt(10, 'brick')]);
  const straight = world.explain(world.aps[0], at(12, 5)).walls;
  const oblique = world.explain(world.aps[0], at(10.5, 9.9)).walls;
  assert.ok(oblique > straight * 1.1 && oblique <= straight * 1.4 + 1e-9, `${straight} -> ${oblique}`);
});

test('propagação: muitas paredes saturam em vez de somar sem fim', () => {
  const walls = [8, 10, 12, 14, 16, 18, 20, 22].map((x) => wallAt(x, 'brick'));
  const world = lab(walls);
  const e = world.explain(world.aps[0], at(24));
  assert.equal(e.wallCount, 8);
  assert.ok(e.walls > 20 && e.walls < DEFAULT_RF.wallCapDb[0], `8 paredes = ${e.walls} dB`);
  // Com duas paredes ainda soma direto.
  assert.ok(Math.abs(world.explain(world.aps[0], at(11)).walls - 12) < 0.01);
});

test('propagação: a laje derruba bastante o sinal, mais ainda em 5 GHz', () => {
  const world = lab();
  const above = at(5, 5, 1);
  const e24 = world.explain(world.aps[0], above);
  const e5 = world.explain(world.aps[1], above);
  assert.equal(e24.slabCount, 1);
  assert.ok(e24.slabs >= 13 && e24.slabs <= 18, `laje 2,4 GHz = ${e24.slabs}`);
  assert.ok(e5.slabs > e24.slabs);
  // Mesma distância, mesmo andar: sem a perda da laje.
  const sameFloor = world.explain(world.aps[0], at(5 + FLOOR_HEIGHT));
  assert.ok(Math.abs(sameFloor.rssi - e24.rssi - e24.slabs) < 1e-6);
  // Paredes de cada andar só contam no trecho do raio que passa por ele.
  // (o raio até x = 11 no andar de cima já passou da laje quando chega à parede em x = 10;
  // o raio até x = 30 ainda está no térreo nesse ponto)
  const upstairsWall = lab([wallAt(10, 'concrete', 1)]);
  assert.equal(upstairsWall.explain(upstairsWall.aps[0], at(12)).wallCount, 0);
  assert.equal(upstairsWall.explain(upstairsWall.aps[0], at(11, 5, 1)).wallCount, 1);
  assert.equal(upstairsWall.explain(upstairsWall.aps[0], at(30, 5, 1)).wallCount, 0);
});

test('propagação: casa isolada só tem laje dentro do contorno; prédio tem em toda parte', () => {
  // Vizinho no andar de cima da casa ao lado; o celular está no térreo, perto da parede.
  const spec = (building) => ({
    name: 'casa',
    floors: 2,
    building,
    outline: [
      [0, 0],
      [8, 0],
      [8, 8],
      [0, 8],
    ],
    walls: [],
    rooms: [],
    aps: [{ bssid: '02:00:00:00:00:aa', ssid: 'vizinho', x: 20, y: 4, z: FLOOR_HEIGHT + 1.5, freq: 2437, eirpDbm: 20 }],
  });
  const phone = { x: 7, y: 4, z: PHONE_HEIGHT };
  const house = createWorld(spec(false), 1, { shadowSigmaDb: 0 });
  const tower = createWorld(spec(true), 1, { shadowSigmaDb: 0 });
  assert.equal(house.explain(house.aps[0], phone).slabCount, 0, 'o raio desce pelo ar livre');
  assert.equal(tower.explain(tower.aps[0], phone).slabCount, 1);
  assert.ok(house.meanRssi(house.aps[0], phone) > tower.meanRssi(tower.aps[0], phone) + 12);
  // Dentro da casa a laje existe: roteador próprio em cima, celular embaixo.
  const inside = createWorld(
    { ...spec(false), aps: [{ bssid: '02:00:00:00:00:bb', ssid: 'casa', x: 4, y: 4, z: FLOOR_HEIGHT + 1, freq: 2437, own: true }] },
    1,
  );
  assert.equal(inside.explain(inside.aps[0], { x: 5, y: 4, z: PHONE_HEIGHT }).slabCount, 1);
});

test('propagação: a sombra é repetível no lugar, suave e com uns 3 dB', () => {
  const world = lab([], { shadowSigmaDb: 3 });
  const ap = world.aps[0];
  const shadow = (x, y) => world.explain(ap, at(x, y)).shadow;
  assert.equal(shadow(20, 3), shadow(20, 3));
  const a = [];
  const near = [];
  const far = [];
  for (let i = 0; i < 400; i++) {
    const x = 12 + (i % 40) * 0.7;
    const y = 0.5 + Math.floor(i / 40) * 0.9;
    a.push(shadow(x, y));
    near.push(shadow(x + 0.3, y));
    far.push(shadow(x + 8, y + 0.2));
  }
  const corr = (p, q) => mean(p.map((v, i) => (v - mean(p)) * (q[i] - mean(q)))) / (std(p) * std(q));
  assert.ok(std(a) > 1.8 && std(a) < 4.5, `desvio da sombra = ${std(a)}`);
  assert.ok(corr(a, near) > 0.9, `correlação a 0,3 m = ${corr(a, near)}`);
  assert.ok(Math.abs(corr(a, far)) < 0.45, `correlação a 8 m = ${corr(a, far)}`);
  // As duas faixas do mesmo aparelho compartilham parte da sombra; outra semente muda tudo.
  const other = createWorld(world.spec, 8, { shadowSigmaDb: 3 });
  assert.notEqual(other.explain(other.aps[0], at(20, 3)).shadow, shadow(20, 3));
});

test('medição: o corpo do usuário atenua o roteador que fica às costas', () => {
  const world = lab();
  // (uma ou outra varredura perde o beacon: essas ficam de fora da média)
  const levels = (heading, band) =>
    mean(
      Array.from({ length: 300 }, (_, i) => world.scan({ ...at(11), heading, t: i * 3.5 }).find((r) => r.bssid === world.aps[band].bssid))
        .filter(Boolean)
        .map((r) => r.level),
    );
  for (const band of [0, 1]) {
    const facing = levels(Math.PI, band); // roteador à frente
    const back = levels(0, band); // roteador atrás
    const side = levels(Math.PI / 2, band);
    assert.ok(facing - back > 3.5 && facing - back <= 6.5, `faixa ${band}: ${facing - back} dB`);
    assert.ok(side < facing + 0.3 && side > back);
  }
});

test('medição: ruído de uns 2 dB por varredura, níveis inteiros, formato do ScanAp', () => {
  const world = lab();
  const scans = Array.from({ length: 400 }, (_, i) => world.scan({ ...at(11 + (i % 20) * 0.3), heading: null, t: i * 3.5 }));
  const ap = world.aps[0];
  const residual = [];
  scans.forEach((s, i) => {
    const r = s.find((q) => q.bssid === ap.bssid);
    if (r) residual.push(r.level - world.meanRssi(ap, at(11 + (i % 20) * 0.3)));
  });
  assert.ok(residual.length > 370, 'sinal forte quase nunca falha');
  assert.ok(std(residual) > 1.4 && std(residual) < 3, `ruído = ${std(residual)} dB`);
  assert.ok(Math.abs(mean(residual)) < 0.6);

  const sample = scans.find((s) => s.length === 2);
  for (const r of sample) {
    assert.deepEqual(Object.keys(r).sort(), [
      'ageMs',
      'bssid',
      'capabilities',
      'centerFreq0',
      'centerFreq1',
      'channelWidth',
      'frequency',
      'level',
      'ssid',
      'wifiStandard',
    ]);
    assert.match(r.bssid, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
    assert.ok(Number.isInteger(r.level) && Number.isInteger(r.ageMs));
    assert.ok(r.ageMs >= 0 && r.ageMs <= 3000, `leitura nova com ${r.ageMs} ms`);
  }
  const r24 = sample.find((r) => r.frequency === 2437);
  const r5 = sample.find((r) => r.frequency === 5220);
  assert.deepEqual([r24.channelWidth, r24.centerFreq0, r24.centerFreq1], [0, 0, 0]);
  assert.deepEqual([r5.channelWidth, r5.centerFreq0, r5.centerFreq1], [2, 5210, 0]);
  assert.equal(r5.wifiStandard, 6);
  // 2,4 GHz é ouvido antes de 5 GHz na mesma varredura: fica mais "velho" na lista.
  assert.ok(r24.ageMs > r5.ageMs);
  // Mesma consulta, mesma resposta (não depende da ordem das chamadas).
  assert.deepEqual(world.scan({ ...at(11), heading: 1, t: 77 }), world.scan({ ...at(11), heading: 1, t: 77 }));
});

test('medição: redes do mesmo rádio variam juntas; o estado interno não aparece em world.aps', () => {
  const world = presetWorld('escritorio');
  const box = world.aps.filter((a) => a.device === 'ap-teto-2');
  const [corp24, guest24] = box.filter((a) => a.band === 0);
  const corp5 = box.find((a) => a.band === 1);
  assert.ok(corp24 && guest24 && corp5 && corp24.ssid !== guest24.ssid);
  const sameRadio = [];
  const otherBand = [];
  for (let i = 0; i < 300; i++) {
    const list = world.scan({ x: 9 + (i % 10) * 0.4, y: 3 + Math.floor(i / 10) * 0.1, floor: 0, heading: null, t: 5 + i * 3.5 });
    const level = (ap) => list.find((r) => r.bssid === ap.bssid)?.level;
    if (level(corp24) != null && level(guest24) != null) sameRadio.push(level(corp24) - level(guest24));
    if (level(corp24) != null && level(corp5) != null) otherBand.push(level(corp24) - level(corp5));
  }
  assert.ok(sameRadio.length > 250 && otherBand.length > 250);
  // Espalhamento robusto (metade da faixa entre os percentis 16 e 84): ignora as leituras aberrantes.
  const spread = (list) => {
    const v = list.slice().sort((a, b) => a - b);
    return (v[Math.floor(v.length * 0.84)] - v[Math.floor(v.length * 0.16)]) / 2;
  };
  // Mesmo rádio: mesma sombra, mesmo desvanecimento e boa parte do ruído -> diferença pequena.
  assert.ok(spread(sameRadio) <= 1.5, `mesmo rádio: ${spread(sameRadio)} dB`);
  assert.ok(Math.abs(mean(sameRadio)) < 1.2);
  assert.ok(spread(otherBand) >= spread(sameRadio) + 1, `outra faixa: ${spread(otherBand)} dB`);
  // O que a interface enxerga de um roteador é só dado simples.
  const plain = JSON.parse(JSON.stringify(world.aps[0]));
  assert.ok(!Object.keys(plain).some((k) => k.startsWith('_')));
  assert.equal(plain.bssid, world.aps[0].bssid);
});

test('medição: larguras de canal e frequências centrais coerentes', () => {
  const ap = (bssid, freq, widthMHz) => ({
    bssid,
    ssid: 'x',
    freq,
    widthMHz,
    x: 1,
    y: 1,
    z: 1,
    eirpDbm: 20,
    standard: 6,
    capabilities: '[ESS]',
  });
  const world = createWorld(
    {
      name: 't',
      floors: 1,
      outline: [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      walls: [],
      rooms: [],
      aps: [
        ap('02:00:00:00:00:01', 2412, 40),
        ap('02:00:00:00:00:02', 2462, 40),
        ap('02:00:00:00:00:03', 5180, 40),
        ap('02:00:00:00:00:04', 5745, 80),
        ap('02:00:00:00:00:05', 5180, 160),
        ap('02:00:00:00:00:06', 5500, 80),
        ap('02:00:00:00:00:07', 6135, 80),
        ap('02:00:00:00:00:08', 5955, 320),
      ],
    },
    1,
  );
  const by = Object.fromEntries(world.scan({ x: 2, y: 2, t: 5 }).map((r) => [r.bssid.slice(-2), r]));
  assert.deepEqual([by['01'].channelWidth, by['01'].centerFreq0], [1, 2422]);
  assert.deepEqual([by['02'].channelWidth, by['02'].centerFreq0], [1, 2452]);
  assert.deepEqual([by['03'].channelWidth, by['03'].centerFreq0], [1, 5190]);
  assert.deepEqual([by['04'].channelWidth, by['04'].centerFreq0], [2, 5775]);
  assert.deepEqual([by['05'].channelWidth, by['05'].centerFreq0, by['05'].centerFreq1], [3, 5210, 5250]);
  assert.deepEqual([by['06'].channelWidth, by['06'].centerFreq0], [2, 5530]);
  assert.deepEqual([by['07'].channelWidth, by['07'].centerFreq0], [2, 6145]);
  assert.deepEqual([by['08'].channelWidth, by['08'].centerFreq0], [5, 6105]);
});

test('detecção: sempre acima de -85, some por volta de -93, nunca abaixo de -96', () => {
  const world = lab();
  const ap = world.aps[0];
  // Distância em que o sinal médio vale `target` (espaço livre, sem sombra).
  const distanceFor = (target) => 10 ** ((ap.p0 - target) / (10 * ap.n));
  const rate = (target) => {
    let hits = 0;
    const d = distanceFor(target);
    for (let i = 0; i < 400; i++) {
      const list = world.scan({ x: 5 + d, y: 5, z: PHONE_HEIGHT, heading: null, t: 10 + i * 30 });
      const r = list.find((q) => q.bssid === ap.bssid);
      if (r) {
        hits++;
        assert.ok(r.level >= DEFAULT_RF.floorDbm, `nível ${r.level} abaixo do piso`);
      }
    }
    return hits / 400;
  };
  assert.ok(rate(-70) > 0.93, 'sinal bom aparece quase sempre');
  assert.ok(rate(-80) > 0.85);
  const edge = rate(-90);
  assert.ok(edge > 0.1 && edge < 0.8, `na beira some às vezes: ${edge}`);
  assert.ok(rate(-95) < 0.12);
  assert.ok(rate(-99) < 0.02, 'abaixo do piso só com um pico raro de ruído');
  assert.equal(rate(-112), 0, 'muito abaixo do piso nunca aparece');
});

test('varredura: o Android repete leituras antigas com idade grande', () => {
  const { survey } = tourSurvey('apartamento', 1, { minLengthM: 200 });
  let stale = 0;
  let fresh = 0;
  survey.scans.forEach((scan, i) => {
    for (const r of scan.readings) {
      if (r.ageMs <= 3000) {
        fresh++;
        continue;
      }
      stale++;
      assert.ok(r.ageMs > 3400 && r.ageMs <= 20000 + 3000, `idade ${r.ageMs}`);
      // A leitura velha repete o nível da varredura anterior.
      const before = survey.scans[i - 1].readings.find((q) => q.id === r.id);
      assert.ok(before, 'leitura velha sem origem');
      assert.equal(r.rssi, before.rssi);
      assert.ok(r.ageMs > before.ageMs + 3000);
    }
  });
  assert.ok(stale > 20, `repetições encontradas: ${stale}`);
  assert.ok(fresh > stale, 'a maioria das leituras é nova');

  // Com o limite de 30 s do Android não sobra leitura velha nenhuma.
  const slow = tourSurvey('apartamento', 1, { kind: 'spots', scanIntervalS: 30, count: 12 }).survey;
  for (const scan of slow.scans) for (const r of scan.readings) assert.ok(r.ageMs <= 3000);
});

test('determinismo: mesma semente, mesmo levantamento; outra semente, outro', () => {
  const a = tourSurvey('kitnet', 4);
  const b = tourSurvey('kitnet', 4);
  assert.deepEqual(a.survey, b.survey);
  assert.deepEqual(a.truth.points, b.truth.points);
  assert.deepEqual(a.plan.steps, b.plan.steps);
  const c = tourSurvey('kitnet', 5);
  assert.notDeepEqual(a.survey.scans, c.survey.scans);
  // Mesmo mundo e mesma caminhada, outra semente de medição: muda o ruído.
  const world = presetWorld('kitnet', 4);
  const plan = planWalk(world, { kind: 'tour', seed: 4, minLengthM: 120 });
  const s1 = simulateSurvey(world, plan, { seed: 1 }).survey;
  const s2 = simulateSurvey(world, plan, { seed: 2 }).survey;
  assert.notDeepEqual(s1.scans, s2.scans);
  assert.deepEqual(presetSpec('sobrado', 3), presetSpec('sobrado', 3));
  assert.notDeepEqual(presetSpec('sobrado', 3).aps, presetSpec('sobrado', 4).aps);
});

test('mundos prontos: carregam e têm os roteadores combinados', () => {
  assert.deepEqual(PRESETS.slice().sort(), ['apartamento', 'escritorio', 'kitnet', 'sobrado']);
  const expected = {
    apartamento: { floors: 1, own: 2, ownDevices: 1, neighbours: [12, 18], size: [9, 7] },
    sobrado: { floors: 2, own: 4, ownDevices: 2, neighbours: [6, 11], size: [8, 10] },
    escritorio: { floors: 1, own: 20, ownDevices: 5, neighbours: [8, 12], size: [20, 14] },
    kitnet: { floors: 1, own: 2, ownDevices: 1, neighbours: [19, 24], size: [5, 6] },
  };
  let hidden = 0;
  for (const id of PRESETS) {
    for (const seed of [1, 2, 3]) {
      const world = presetWorld(id, seed);
      const exp = expected[id];
      assert.equal(world.floors, exp.floors);
      assert.deepEqual([world.bounds.width, world.bounds.height], exp.size);
      const own = world.aps.filter((a) => a.own);
      const neighbours = world.aps.filter((a) => !a.own);
      assert.equal(own.length, exp.own, `${id}: redes próprias`);
      assert.equal(new Set(own.map((a) => a.device)).size, exp.ownDevices);
      assert.ok(
        neighbours.length >= exp.neighbours[0] && neighbours.length <= exp.neighbours[1],
        `${id}#${seed}: ${neighbours.length} vizinhos`,
      );
      assert.equal(new Set(world.aps.map((a) => a.bssid)).size, world.aps.length, 'BSSIDs únicos');
      for (const a of world.aps) {
        assert.match(a.bssid, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
        assert.ok(a.capabilities.includes('[ESS]'));
        assert.ok(a.eirpDbm >= 10 && a.eirpDbm <= 30);
        assert.ok([1, 4, 5, 6, 8].includes(a.standard));
        if (a.own) assert.ok(world.isFree(a.x, a.y, Math.floor(a.z / FLOOR_HEIGHT), 0), `${id}: roteador próprio dentro da casa`);
        else if (a.z > 0 && a.z < world.floors * FLOOR_HEIGHT)
          assert.ok(!pointInPolygon(a.x, a.y, world.outline(0)), 'vizinho do mesmo andar fica fora da casa');
        if (a.ssid === '') hidden++;
      }
      // Rádios do mesmo aparelho: mesma posição e BSSIDs que só mudam no fim.
      const byDevice = new Map();
      for (const a of world.aps) byDevice.set(a.device, [...(byDevice.get(a.device) || []), a]);
      for (const radios of byDevice.values()) {
        for (const r of radios) {
          assert.deepEqual([r.x, r.y, r.z], [radios[0].x, radios[0].y, radios[0].z]);
          assert.equal(r.bssid.slice(0, 14), radios[0].bssid.slice(0, 14));
        }
      }
      // A maioria dos vizinhos está em 2,4 GHz, quase todos nos canais 1, 6 e 11.
      const n24 = neighbours.filter((a) => a.band === 0);
      assert.ok(n24.length > neighbours.length / 2);
      for (const r of world.rooms) assert.equal(typeof r.name, 'string');
    }
  }
  assert.ok(hidden > 0, 'há redes ocultas entre os vizinhos');
  assert.equal(presetWorld('sobrado').stairs.length, 1);
  assert.ok(
    presetWorld('apartamento')
      .rooms.map((r) => r.name)
      .includes('Cozinha'),
  );
  assert.throws(() => presetSpec('castelo'), /desconhecido/);
});

test('planta: roomAt e isFree respeitam paredes, portas e o contorno', () => {
  const world = presetWorld('apartamento');
  assert.equal(world.roomAt(1, 1, 0).name, 'Sala');
  assert.equal(world.roomAt(7, 1, 0).name, 'Cozinha');
  assert.equal(world.roomAt(8, 4.2, 0).name, 'Quarto 2');
  assert.equal(world.roomAt(-1, 1, 0), null);
  assert.ok(world.isFree(1, 1, 0));
  assert.ok(!world.isFree(5.4, 1.0, 0), 'em cima da parede sala | cozinha');
  assert.ok(world.isFree(5.4, 1.9, 0), 'no vão entre sala e cozinha');
  assert.ok(world.isFree(3.0, 4.3, 0), 'na porta do quarto 1');
  assert.ok(!world.isFree(9.5, 1, 0) && !world.isFree(1, 1, 3));
  assert.ok(world.crossesWall(1, 1, 7, 1, 0), 'sala -> cozinha em linha reta bate na parede');
  assert.ok(!world.crossesWall(5, 1.9, 6, 1.9, 0), 'pelo vão passa');
  assert.ok(world.crossesWall(1, 1, -1, 1, 0), 'não sai pela fachada');
});

test('mundos prontos: todo cômodo é alcançável andando', () => {
  for (const id of PRESETS) {
    const world = presetWorld(id);
    const nav = navGrid(world);
    for (const room of world.rooms) {
      const g = nav.floors[room.floor];
      let cells = 0;
      for (let c = 0; c < g.free.length; c++) if (g.room[c] === room.index && g.comp[c] === nav.main) cells++;
      assert.ok(cells >= 4, `${id}: ${room.name} tem ${cells} células alcançáveis`);
    }
    const visited = new Set(planWalk(world, { kind: 'tour', seed: 2 }).waypoints.map((w) => `${w.floor}:${w.room}`));
    assert.equal(visited.size, world.rooms.length, `${id}: o tour passa por todos os cômodos`);
  }
});

test('casas sorteadas: plausíveis, variadas e totalmente alcançáveis', () => {
  const areas = { pequena: [28, 48], media: [52, 84], grande: [86, 146] };
  const shapes = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    const size = ['pequena', 'media', 'grande'][seed % 3];
    const spec = randomSpec(seed, { size });
    assert.deepEqual(spec, randomSpec(seed, { size }), 'mesma semente, mesma casa');
    const world = createWorld(spec, seed);
    const area = world.bounds.width * world.bounds.height;
    assert.ok(area >= areas[size][0] && area <= areas[size][1], `${size}: ${area} m²`);
    assert.ok(world.rooms.length >= 3 && world.rooms.length <= 7, `${world.rooms.length} cômodos`);
    assert.equal(new Set(world.rooms.map((r) => r.name)).size, world.rooms.length);
    assert.ok(world.rooms.some((r) => r.name === 'Sala') && world.rooms.some((r) => r.name === 'Banheiro'));
    const own = world.aps.filter((a) => a.own);
    assert.ok(own.length >= 2);
    for (const a of own) assert.ok(world.isFree(a.x, a.y, 0, 0));
    assert.ok(world.aps.length - own.length >= 5);
    const nav = navGrid(world);
    for (const room of world.rooms) {
      let cells = 0;
      for (let c = 0; c < nav.floors[0].free.length; c++)
        if (nav.floors[0].room[c] === room.index && nav.floors[0].comp[c] === nav.main) cells++;
      assert.ok(cells >= 4, `casa ${seed}: ${room.name} isolado`);
    }
    shapes.add(`${world.bounds.width}x${world.bounds.height}/${world.rooms.length}`);
  }
  assert.ok(shapes.size >= 25, 'as casas são diferentes entre si');
  assert.equal(randomWorld(5).name, 'Casa sorteada 5');
});

// Confere uma caminhada inteira: nenhum trecho atravessa parede nem sai da casa.
function checkPlan(world, plan, label) {
  let prev = { ...plan.start };
  assert.ok(world.isFree(prev.x, prev.y, prev.floor), `${label}: começo fora de lugar`);
  let moves = 0;
  for (const step of plan.steps) {
    if (step.type === 'move') {
      moves++;
      assert.equal(step.floor, prev.floor, `${label}: troca de andar sem escada`);
      assert.ok(
        !world.crossesWall(prev.x, prev.y, step.x, step.y, step.floor),
        `${label}: atravessou parede em (${prev.x}, ${prev.y}) -> (${step.x}, ${step.y})`,
      );
      assert.ok(world.isFree(step.x, step.y, step.floor), `${label}: parou dentro de parede`);
      assert.ok(pointInPolygon(step.x, step.y, world.outline(step.floor)), `${label}: saiu da casa`);
      // Pontos intermediários do trecho também ficam livres.
      for (const u of [0.25, 0.5, 0.75]) {
        assert.ok(
          world.isFree(prev.x + (step.x - prev.x) * u, prev.y + (step.y - prev.y) * u, step.floor),
          `${label}: trecho raspa na parede`,
        );
      }
      prev = step;
    } else if (step.type === 'stairs') {
      const stair = world.stairs.find(
        (s) => (s.fromFloor === prev.floor && s.toFloor === step.floor) || (s.toFloor === prev.floor && s.fromFloor === step.floor),
      );
      assert.ok(stair, `${label}: mudou de andar onde não há escada`);
      const foot = stair.fromFloor === prev.floor ? [stair.x, stair.y] : [stair.x2, stair.y2];
      assert.ok(Math.hypot(prev.x - foot[0], prev.y - foot[1]) < 0.4, `${label}: escada longe do pé`);
      prev = step;
    } else {
      assert.equal(step.type, 'spot');
      assert.deepEqual([step.x, step.y, step.floor], [prev.x, prev.y, prev.floor]);
    }
  }
  assert.ok(moves > 5, `${label}: caminhada curta demais`);
}

test('caminhadas: nunca atravessam parede e ficam dentro do contorno', () => {
  for (const id of PRESETS) {
    for (const kind of KINDS) {
      for (const seed of [1, 2, 3]) {
        const world = presetWorld(id, seed);
        checkPlan(world, planWalk(world, { kind, seed, minLengthM: kind === 'spots' ? 0 : 150 }), `${id}/${kind}/${seed}`);
      }
    }
  }
  for (let seed = 1; seed <= 12; seed++) {
    const world = randomWorld(seed);
    checkPlan(world, planWalk(world, { kind: KINDS[seed % 3], seed }), `casa ${seed}`);
  }
  // Começando pelo andar de cima também funciona.
  const sobrado = presetWorld('sobrado');
  const down = planWalk(sobrado, { kind: 'tour', seed: 1, floorOrder: [1, 0] });
  assert.equal(down.start.floor, 1);
  checkPlan(sobrado, down, 'sobrado de cima para baixo');
  assert.throws(() => planWalk(sobrado, { kind: 'voando' }), /desconhecido/);
});

test('caminhadas: tipos, metas de comprimento e pontos marcados', () => {
  const world = presetWorld('apartamento');
  const short = planWalk(world, { kind: 'tour', seed: 1 });
  const long = planWalk(world, { kind: 'tour', seed: 1, minLengthM: 200 });
  assert.ok(long.lengthM >= 200 && long.lengthM < 300 && short.lengthM < 100);
  // Tour e perímetro fecham o circuito: terminam onde começaram.
  for (const plan of [short, long, planWalk(world, { kind: 'perimeter', seed: 1 })]) {
    const last = plan.steps.filter((s) => s.type === 'move').pop();
    assert.ok(Math.hypot(last.x - plan.start.x, last.y - plan.start.y) < 1e-9);
  }
  // Perímetro: anda perto das paredes.
  const ring = planWalk(world, { kind: 'perimeter', seed: 1 });
  const nearWall = ring.waypoints.filter((w) => world.wallDistance(w.x, w.y, w.floor) < 0.8).length;
  assert.ok(nearWall / ring.waypoints.length > 0.8);
  // Pontos: 2 a 4 por cômodo, ou o total pedido; o primeiro é revisitado no fim com o mesmo id.
  const spots = planWalk(world, { kind: 'spots', seed: 1 });
  const marks = spots.steps.filter((s) => s.type === 'spot');
  const perRoom = new Map();
  for (const m of new Map(marks.map((s) => [s.spot, s])).values()) perRoom.set(m.room, (perRoom.get(m.room) || 0) + 1);
  assert.equal(perRoom.size, world.rooms.length);
  for (const n of perRoom.values()) assert.ok(n >= 2 && n <= 4);
  assert.equal(marks[marks.length - 1].spot, marks[0].spot, 'revisita o primeiro ponto');
  assert.ok(Math.hypot(marks[marks.length - 1].x - marks[0].x, marks[marks.length - 1].y - marks[0].y) < 0.8);
  const many = planWalk(world, { kind: 'spots', seed: 1, count: 30 });
  assert.equal(new Set(many.steps.filter((s) => s.type === 'spot').map((s) => s.spot)).size, 30);
});

test('levantamento: formato exato de Survey e nenhuma verdade vazando', () => {
  for (const id of PRESETS) {
    for (const [kind, scanIntervalS] of [
      ['tour', 3.5],
      ['spots', 3.5],
      ['spots', 30],
    ]) {
      const { survey, truth, world } = tourSurvey(id, 2, { kind, scanIntervalS, count: kind === 'spots' ? 10 : undefined });
      assert.deepEqual(Object.keys(survey).sort(), ['aps', 'scans', 'track', 'version']);
      assert.equal(survey.version, 1);
      assert.ok(survey.scans.length >= 8);
      let last = -Infinity;
      for (const scan of survey.scans) {
        const keys = Object.keys(scan)
          .filter((k) => k !== 'label')
          .sort();
        assert.deepEqual(keys, ['floor', 'readings', 'spot', 'still', 't']);
        assert.ok(scan.t > last, 'varreduras em ordem de tempo');
        last = scan.t;
        assert.ok(Number.isInteger(scan.floor));
        assert.equal(typeof scan.still, 'boolean');
        assert.equal(scan.still, scan.spot !== null, 'parado <=> ponto marcado');
        if ('label' in scan) {
          assert.ok(scan.still && world.rooms.some((r) => r.name === scan.label));
        }
        for (const r of scan.readings) {
          assert.deepEqual(Object.keys(r).sort(), ['ageMs', 'freq', 'id', 'rssi']);
          assert.ok(survey.aps[r.id], 'toda leitura tem os dados do roteador');
          assert.equal(survey.aps[r.id].freq, r.freq);
          assert.ok(Number.isInteger(r.rssi) && r.rssi <= -18 && r.rssi >= -96);
        }
        assert.equal(new Set(scan.readings.map((r) => r.id)).size, scan.readings.length);
      }
      for (const meta of Object.values(survey.aps)) {
        assert.deepEqual(Object.keys(meta).sort(), ['device', 'freq', 'ssid']);
        assert.match(meta.device, /^d\d+$/, 'id de aparelho neutro');
      }
      // BSSIDs do mesmo aparelho no mundo têm o mesmo `device` no levantamento.
      const pairs = Object.entries(survey.aps);
      for (const [a, ma] of pairs)
        for (const [b, mb] of pairs) assert.equal(ma.device === mb.device, world.ap(a).device === world.ap(b).device);
      // Rede conectada: uma amostra a cada 2 s, sempre de um roteador da casa.
      survey.track.forEach((s, i) => {
        assert.deepEqual(Object.keys(s).sort(), ['id', 'rssi', 't']);
        assert.ok(world.ap(s.id).own && Number.isInteger(s.rssi));
        if (i) assert.equal(s.t - survey.track[i - 1].t, 2);
      });

      // Nada de coordenadas, nomes internos ou marca de "rede própria" no que vai para o solucionador.
      const json = JSON.stringify(survey);
      assert.doesNotMatch(json, /"(x|y|z|own|heading|world|truth|points)"\s*:/);
      assert.doesNotMatch(json, /viz-|roteador|ap-teto|mesh-cima/);
      assert.deepEqual(JSON.parse(json), survey, 'o levantamento é só dados');

      // A verdade vem à parte, um ponto por varredura, sempre num lugar pisável.
      assert.equal(truth.points.length, survey.scans.length);
      assert.equal(Object.keys(truth.aps).length, world.aps.length);
      assert.equal(truth.world, world);
      truth.points.forEach((p, i) => {
        assert.ok(world.isFree(p.x, p.y, truth.floors[i], 0.05), `${id}: ponto real ${i} dentro de parede`);
      });
    }
  }
});

test('levantamento: varreduras paradas ficam no ponto marcado; andando, cada canal num lugar', () => {
  const { survey, truth } = tourSurvey('apartamento', 3, { kind: 'spots' });
  const bySpot = new Map();
  survey.scans.forEach((s, i) => {
    if (s.spot === null) return;
    bySpot.set(s.spot, [...(bySpot.get(s.spot) || []), truth.points[i]]);
  });
  assert.ok(bySpot.size >= 12);
  let revisited = 0;
  for (const pts of bySpot.values()) {
    assert.ok(pts.length >= 3, 'três varreduras por ponto com a varredura livre');
    const spread = Math.max(...pts.map((p) => Math.hypot(p.x - pts[0].x, p.y - pts[0].y)));
    assert.ok(spread < 0.8, `mesmo ponto, lugares a ${spread} m`);
    if (pts.length > 3) revisited++;
  }
  assert.equal(revisited, 1, 'um ponto é revisitado');
  assert.ok(
    survey.scans.some((s) => !s.still),
    'entre os pontos o app continua varrendo',
  );
  assert.ok(survey.scans.some((s) => s.label) && survey.scans.some((s) => s.still && !s.label), 'só parte dos pontos ganha nome');

  // Com o limite de 30 s: uma varredura por ponto.
  const slow = tourSurvey('apartamento', 3, { kind: 'spots', scanIntervalS: 30, count: 20 });
  assert.ok(slow.survey.scans.filter((s) => s.still).length >= 20);
  for (let i = 1; i < slow.survey.scans.length; i++) assert.ok(slow.survey.scans[i].t - slow.survey.scans[i - 1].t > 29);

  // Andando, a velocidade fica entre 0,4 e 0,9 m/s (com paradas).
  const walk = tourSurvey('escritorio', 1, { minLengthM: 250 });
  const speeds = [];
  for (let i = 1; i < walk.truth.points.length; i++) {
    const d = Math.hypot(walk.truth.points[i].x - walk.truth.points[i - 1].x, walk.truth.points[i].y - walk.truth.points[i - 1].y);
    speeds.push(d / (walk.truth.times[i] - walk.truth.times[i - 1]));
  }
  assert.ok(Math.max(...speeds) <= 0.95, `velocidade máxima ${Math.max(...speeds)}`);
  assert.ok(mean(speeds) > 0.3 && mean(speeds) < 0.9);
});

test('levantamento em dois andares: o andar marcado acompanha a escada', () => {
  const up = tourSurvey('sobrado', 1, { minLengthM: 250 });
  const floors = new Set(up.survey.scans.map((s) => s.floor));
  assert.deepEqual([...floors].sort(), [0, 1]);
  let agree = 0;
  up.survey.scans.forEach((s, i) => {
    if (s.floor === up.truth.floors[i]) agree++;
  });
  assert.ok(agree / up.survey.scans.length > 0.95, 'o andar marcado bate com o real fora da escada');
  assert.ok(up.truth.points.some((p) => p.z > FLOOR_HEIGHT) && up.truth.points.some((p) => p.z < FLOOR_HEIGHT));
  assert.equal(up.truth.startFloor, 0);
  // Começando em cima, o andar de baixo vira -1.
  const down = tourSurvey('sobrado', 1, { minLengthM: 250, floorOrder: [1, 0] });
  assert.deepEqual([...new Set(down.survey.scans.map((s) => s.floor))].sort(), [-1, 0]);
  assert.equal(down.truth.startFloor, 1);
  // O celular troca de rádio (roteador de baixo, mesh de cima) ao longo do caminho.
  assert.ok(new Set(up.survey.track.map((s) => s.id)).size >= 2);
});

test('apartamento: níveis de sinal plausíveis para a casa e para os vizinhos', () => {
  const world = presetWorld('apartamento');
  const own24 = world.aps.find((a) => a.own && a.band === 0);
  const levels = [];
  for (let x = 0.25; x < 9; x += 0.25) {
    for (let y = 0.25; y < 7; y += 0.25) {
      if (world.isFree(x, y, 0, 0.15)) levels.push(world.meanRssi(own24, { x, y, z: PHONE_HEIGHT }));
    }
  }
  levels.sort((a, b) => a - b);
  assert.ok(levels.length > 800);
  assert.ok(levels[levels.length - 1] <= -30, `máximo ${levels[levels.length - 1]}`);
  assert.ok(levels[Math.floor(levels.length * 0.03)] >= -75, `3% mais fracos em ${levels[Math.floor(levels.length * 0.03)]}`);
  assert.ok(levels[0] >= -82, `mínimo ${levels[0]}`);

  const { survey } = tourSurvey('apartamento', 1, { minLengthM: 220 });
  const neighbour = [];
  const seenPerScan = [];
  for (const scan of survey.scans) {
    let n = 0;
    for (const r of scan.readings) {
      if (world.ap(r.id).own) continue;
      n++;
      neighbour.push(r.rssi);
    }
    seenPerScan.push(n);
  }
  const inRange = neighbour.filter((v) => v >= -92 && v <= -65).length / neighbour.length;
  assert.ok(inRange > 0.8, `vizinhos entre -92 e -65 dBm: ${(inRange * 100).toFixed(0)}%`);
  assert.ok(mean(seenPerScan) >= 3 && mean(seenPerScan) <= 15, `vizinhos por varredura: ${mean(seenPerScan)}`);
  assert.ok(Object.keys(survey.aps).length >= 10);
});
