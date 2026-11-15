// Mapas salvos (app/js/mapping/storage.js): os armazenamentos de reserva — localStorage e
// memória — com um localStorage de mentira. O IndexedDB de verdade é testado no Chromium, em
// tests/e2e/map-engine.e2e.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openMapStore, MapStoreError, parseMapFile, serializeMap, cleanName, memoryStorage, MAP_FILE_FORMAT, MAP_FILE_VERSION, DB_NAME } from '../app/js/mapping/storage.js';
import { createRecorder, validateSurvey } from '../app/js/mapping/recorder.js';
import { buildMap } from '../app/js/mapping/mapmodel.js';

// ---------------------------------------------------------------------------
// Ajudas
// ---------------------------------------------------------------------------

/** localStorage de mentira, com cota opcional (soma dos caracteres de chaves e valores). */
function fakeStorage({ quota = Infinity } = {}) {
  const data = new Map();
  const used = () => [...data].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    data,
    quota,
    writes: 0,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem(k, v) {
      const key = String(k);
      const value = String(v);
      const next = used() - (data.has(key) ? key.length + data.get(key).length : 0) + key.length + value.length;
      if (next > this.quota) {
        const err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        err.code = 22;
        throw err;
      }
      this.writes += 1;
      data.set(key, value);
    },
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
  };
}

/** Armazenamento que lança em qualquer acesso (modo privado, WebView sem DOM storage). */
const brokenStorage = () => ({
  get length() {
    throw new Error('SecurityError');
  },
  key() {
    throw new Error('SecurityError');
  },
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('SecurityError');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
});

function fakeClock(start = Date.UTC(2026, 5, 1, 9, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const mac = (n) => `a0:b1:c2:00:${(n >> 8).toString(16).padStart(2, '0')}:${(n & 255).toString(16).padStart(2, '0')}`;

/** Levantamento pequeno e válido: `n` varreduras, um ponto marcado, dois andares. */
function sampleSurvey(n = 6) {
  const scans = [];
  for (let i = 0; i < n; i++) {
    const spot = i === 2 || i === 3 ? 0 : null;
    const scan = {
      t: i * 3,
      floor: i >= n - 2 ? 1 : 0,
      still: spot !== null,
      spot,
      readings: [
        { id: mac(1), rssi: -40 - i, freq: 2437, ageMs: 1200 },
        { id: mac(2), rssi: -60 - i, freq: 5180, ageMs: 800 },
      ],
    };
    if (spot !== null) scan.label = 'Sala';
    scans.push(scan);
  }
  return {
    version: 1,
    scans,
    track: [{ t: 1, id: mac(1), rssi: -41 }],
    rtt: [],
    aps: { [mac(1)]: { ssid: 'Casa', freq: 2437, device: 'd1' }, [mac(2)]: { ssid: 'Casa_5G', freq: 5180, device: 'd1' } },
    knownDistances: [{ a: 0, b: 4, meters: 3.5 }],
  };
}

function sampleSolution(survey) {
  return {
    points: survey.scans.map((s, i) => ({ x: i * 0.7, y: Math.sin(i), z: s.floor * 2.8, conf: 0.8 })),
    aps: { [mac(1)]: { x: 1, y: 2, z: 1.5, p0: -38, n: 2.4, conf: 0.7 }, [mac(2)]: { x: 1, y: 2, z: 1.5, p0: -42, n: 2.9, conf: 0.6 } },
    scaleConf: 0.6,
  };
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function sampleRecord(extra = {}) {
  const survey = sampleSurvey();
  return {
    name: 'Apartamento da Ana',
    survey,
    solution: sampleSolution(survey),
    own: [mac(1), mac(2)],
    meta: { rooms: 3, errorM: 1.4, ownSsids: ['Casa'] },
    thumb: PNG,
    demo: false,
    stats: { areaM2: 48.26, level: 'boa' },
    ...extra,
  };
}

const local = (storage = fakeStorage(), extra = {}) => openMapStore({ indexedDB: null, localStorage: storage, ...extra });
const memory = (extra = {}) => openMapStore({ backend: 'memory', indexedDB: null, localStorage: null, ...extra });

async function rejects(promise, code, pattern) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'devia ter rejeitado');
  assert.ok(err instanceof MapStoreError, `erro inesperado: ${err && err.stack}`);
  assert.equal(err.name, 'MapStoreError');
  assert.equal(err.code, code, err.message);
  assert.ok(err.message.length > 10, 'a mensagem é texto para o usuário');
  if (pattern) assert.match(err.message, pattern);
  return err;
}

// ---------------------------------------------------------------------------
// Escolha do armazenamento
// ---------------------------------------------------------------------------

test('abrir: sem IndexedDB usa o localStorage; sem localStorage, a memória', async () => {
  const withLocal = await local();
  assert.equal(withLocal.kind, 'local');
  assert.equal(withLocal.persistent, true);
  assert.equal(withLocal.lastError, null);

  for (const storage of [null, undefined, brokenStorage(), {}, { getItem: () => null, setItem: () => {}, removeItem: () => {} /* grava e não lê de volta */ }]) {
    const store = await openMapStore({ indexedDB: null, localStorage: storage });
    assert.equal(store.kind, 'memory');
    assert.equal(store.persistent, false);
    assert.deepEqual(await store.list(), []);
  }
  const forced = await openMapStore({ backend: 'memory', localStorage: fakeStorage() });
  assert.equal(forced.kind, 'memory');
  assert.equal(DB_NAME, 'wrx-maps', 'o "apagar dados salvos" do app apaga os bancos que começam com wrx');
});

test('abrir: IndexedDB que lança, falha ou nunca responde não impede o app de guardar mapas', async () => {
  const request = () => ({ onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, error: null, result: null });
  const factories = {
    'lança ao abrir': {
      open() {
        throw new Error('SecurityError: acesso negado');
      },
    },
    'responde com erro': {
      open() {
        const req = request();
        req.error = new Error('UnknownError');
        setTimeout(() => req.onerror && req.onerror(), 0);
        return req;
      },
    },
    'nunca responde': { open: () => request() },
    'não é um IndexedDB': { open: 'x' },
  };
  for (const [name, factory] of Object.entries(factories)) {
    const storage = fakeStorage();
    const store = await openMapStore({ indexedDB: factory, localStorage: storage, openTimeoutMs: 30 });
    assert.equal(store.kind, 'local', name);
    const id = await store.put(sampleRecord());
    assert.equal((await store.list())[0].id, id, name);
  }
  // pedido explícito de IndexedDB que não funciona: desce a escada do mesmo jeito
  const forced = await openMapStore({ backend: 'idb', indexedDB: factories['lança ao abrir'], localStorage: null });
  assert.equal(forced.kind, 'memory');
});

// ---------------------------------------------------------------------------
// Operações (iguais nos dois armazenamentos)
// ---------------------------------------------------------------------------

for (const [kind, open] of [
  ['local', (clock) => local(fakeStorage(), { now: clock.now })],
  ['memory', (clock) => memory({ now: clock.now })],
]) {
  test(`${kind}: put -> list -> get devolve o mapa inteiro, limpo e copiado`, async () => {
    const clock = fakeClock();
    const store = await open(clock);
    assert.equal(store.kind, kind);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get('nada'), null);

    const input = sampleRecord();
    const id = await store.put(input);
    assert.match(id, /^[A-Za-z0-9_-]{6,40}$/);

    const list = await store.list();
    assert.deepEqual(list, [
      {
        id,
        name: 'Apartamento da Ana',
        createdAt: clock.now(),
        updatedAt: clock.now(),
        stats: { scans: 6, spots: 1, floors: 2, areaM2: 48.3, level: 'boa' },
        thumb: PNG,
        demo: false,
        meta: { rooms: 3, errorM: 1.4, ownSsids: ['Casa'] },
      },
    ]);

    const rec = await store.get(id);
    assert.deepEqual(Object.keys(rec).sort(), ['createdAt', 'demo', 'id', 'meta', 'name', 'own', 'solution', 'stats', 'survey', 'thumb', 'updatedAt']);
    assert.deepEqual(rec.survey, input.survey);
    assert.deepEqual(rec.solution, input.solution);
    assert.deepEqual(rec.own, input.own);
    assert.deepEqual(rec.meta, input.meta);
    assert.deepEqual(validateSurvey(rec.survey), []);

    // quem recebe pode mexer à vontade: o que está guardado não muda
    rec.survey.scans.length = 0;
    rec.meta.rooms = 99;
    input.survey.scans[0].readings[0].rssi = -1;
    const again = await store.get(id);
    assert.equal(again.survey.scans.length, 6);
    assert.equal(again.survey.scans[0].readings[0].rssi, -40);
    assert.equal(again.meta.rooms, 3);
  });

  test(`${kind}: atualizar mantém a data de criação; a lista vem do mais recente para o mais antigo`, async () => {
    const clock = fakeClock();
    const store = await open(clock);
    const t0 = clock.now();
    const a = await store.put(sampleRecord({ name: 'A' }));
    clock.advance(60_000);
    const b = await store.put(sampleRecord({ name: 'B', demo: true, thumb: null, stats: {} }));
    clock.advance(60_000);
    assert.deepEqual((await store.list()).map((e) => e.name), ['B', 'A']);

    const same = await store.put({ ...(await store.get(a)), name: 'A de novo', createdAt: 12345 });
    assert.equal(same, a, 'com id, atualiza o mesmo mapa');
    const list = await store.list();
    assert.deepEqual(list.map((e) => e.name), ['A de novo', 'B']);
    assert.equal(list[0].createdAt, t0, 'a criação não muda');
    assert.equal(list[0].updatedAt, clock.now());
    assert.equal(list[1].demo, true);
    assert.equal(list[1].thumb, null);
    assert.deepEqual(list[1].stats, { scans: 6, spots: 1, floors: 2, areaM2: null, level: null });
    assert.equal(list.length, 2);
    assert.notEqual(a, b);

    // id de quem chama: cria com esse id
    const mine = await store.put(sampleRecord({ id: 'meu-mapa_1', name: 'Com id próprio' }));
    assert.equal(mine, 'meu-mapa_1');
    assert.equal((await store.get('meu-mapa_1')).name, 'Com id próprio');
  });

  test(`${kind}: renomear, apagar e limpar`, async () => {
    const clock = fakeClock();
    const store = await open(clock);
    const a = await store.put(sampleRecord({ name: 'A' }));
    clock.advance(1000);
    const b = await store.put(sampleRecord({ name: 'B' }));
    clock.advance(1000);

    assert.equal(await store.rename(a, '  Casa\u0000 da   praia\n'), true);
    assert.equal((await store.get(a)).name, 'Casa da praia');
    assert.deepEqual((await store.list()).map((e) => e.name), ['B', 'Casa da praia'], 'renomear não muda a ordem');
    assert.equal(await store.rename(a, ''), true);
    assert.equal((await store.get(a)).name, 'Casa da praia', 'nome vazio não apaga o nome');
    assert.equal(await store.rename('não existe', 'x'), false);
    assert.equal(await store.rename(a, '<img src=x onerror=alert(1)>'), true);
    assert.equal((await store.list())[1].name, '<img src=x onerror=alert(1)>', 'nome é texto: quem desenha usa textContent');

    assert.equal(await store.remove(a), true);
    assert.equal(await store.get(a), null);
    assert.deepEqual((await store.list()).map((e) => e.id), [b]);
    assert.equal(await store.remove('../../etc'), false, 'id inválido');
    assert.equal(await store.remove(null), false);

    await store.draft.save({ recorder: { kind: 'wrx-recorder' } });
    await store.clear();
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.draft.load(), null);
    assert.equal(await store.get(b), null);
  });

  test(`${kind}: o que não é um mapa é recusado com MapStoreError 'invalid'`, async () => {
    const store = await open(fakeClock());
    for (const junk of [null, undefined, 42, 'mapa', [], {}, { name: 'sem levantamento' }, { survey: null }, { survey: { scans: 'x' } }, { survey: { version: 9, scans: [] } }, { ...sampleRecord(), id: 'com espaço' }, { ...sampleRecord(), id: 7 }, { ...sampleRecord(), id: 'x'.repeat(41) }]) {
      await rejects(store.put(junk), 'invalid');
    }
    assert.equal(store.lastError.code, 'invalid');
    assert.deepEqual(await store.list(), []);
  });

  test(`${kind}: tudo o que entra é conferido — solução, redes da casa, miniatura, meta e nome`, async () => {
    const store = await open(fakeClock());
    const survey = sampleSurvey();
    const cases = [
      [{ solution: { ...sampleSolution(survey), debug: { big: 'x'.repeat(1000) }, extra: 1 } }, (r) => assert.deepEqual(r.solution, sampleSolution(survey), 'dados de bancada não são guardados')],
      [{ solution: { points: sampleSolution(survey).points.slice(1), aps: {}, scaleConf: 1 } }, (r) => assert.equal(r.solution, null, 'solução de outro levantamento')],
      [{ solution: { points: survey.scans.map(() => ({ x: Number.NaN, y: 0, z: 0, conf: 1 })), aps: {}, scaleConf: 1 } }, (r) => assert.equal(r.solution, null)],
      [{ solution: 'x' }, (r) => assert.equal(r.solution, null)],
      [
        { solution: { points: survey.scans.map(() => ({ x: 1, y: 2, z: 0, conf: 7 })), aps: { lixo: { x: 1, y: 1, z: 1 }, [mac(1)]: { x: 1, y: 2, z: 3 }, [mac(2)]: { x: Infinity, y: 2, z: 3 } }, scaleConf: -3 } },
        (r) => {
          assert.equal(r.solution.points[0].conf, 1);
          assert.deepEqual(r.solution.aps, { [mac(1)]: { x: 1, y: 2, z: 3, p0: -40, n: 2.5, conf: 0 } });
          assert.equal(r.solution.scaleConf, 0);
        },
      ],
      [{ own: [mac(1).toUpperCase(), mac(1), 'lixo', 42, null, ` ${mac(2)} `] }, (r) => assert.deepEqual(r.own, [mac(1), mac(2)])],
      [{ own: new Set([mac(2)]) }, (r) => assert.deepEqual(r.own, [mac(2)])],
      [{ own: 'x' }, (r) => assert.deepEqual(r.own, [])],
      [{ thumb: 'javascript:alert(1)' }, (r) => assert.equal(r.thumb, null)],
      [{ thumb: 'https://exemplo.com/x.png' }, (r) => assert.equal(r.thumb, null, 'só imagem embutida')],
      [{ thumb: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }, (r) => assert.equal(r.thumb, null, 'SVG pode carregar script')],
      [{ thumb: `data:image/png;base64,${'A'.repeat(500_000)}` }, (r) => assert.equal(r.thumb, null, 'miniatura enorme')],
      [{ thumb: 'data:image/jpeg;base64,/9j/4AAQ' }, (r) => assert.equal(r.thumb, 'data:image/jpeg;base64,/9j/4AAQ')],
      [{ meta: { fn: () => 1, date: new Date(0), nested: { ok: true }, undef: undefined } }, (r) => assert.deepEqual(r.meta, { date: '1970-01-01T00:00:00.000Z', nested: { ok: true } })],
      [{ meta: JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":1},"ok":1}') }, (r) => assert.deepEqual(Object.keys(r.meta), ['ok'])],
      [{ meta: { big: 'x'.repeat(50_000) } }, (r) => assert.deepEqual(r.meta, {}, 'meta é para coisas pequenas')],
      [{ meta: 'texto' }, (r) => assert.deepEqual(r.meta, {})],
      [{ name: 42 }, (r) => assert.equal(r.name, 'Mapa sem nome')],
      [{ name: '   ' }, (r) => assert.equal(r.name, 'Mapa sem nome')],
      [{ name: 'n'.repeat(500) }, (r) => assert.equal(r.name.length, 60)],
      [{ demo: 'sim' }, (r) => assert.equal(r.demo, false)],
      [{ stats: { areaM2: -4, level: '<b>' } }, (r) => assert.deepEqual(r.stats, { scans: 6, spots: 1, floors: 2, areaM2: null, level: null })],
      [{ stats: { areaM2: 'grande', level: 'razoavel', scans: 9999 } }, (r) => assert.deepEqual(r.stats, { scans: 6, spots: 1, floors: 2, areaM2: null, level: 'razoavel' }, 'scans vem do levantamento, não de quem chama')],
    ];
    for (const [patch, check] of cases) {
      const id = await store.put(sampleRecord(patch));
      check(await store.get(id));
    }
    assert.equal({}.polluted, undefined);
    assert.equal((await store.list()).length, cases.length);
  });

  test(`${kind}: rascunho do levantamento em andamento`, async () => {
    const store = await open(fakeClock());
    assert.equal(await store.draft.load(), null);
    const rec = createRecorder();
    rec.start();
    const payload = { recorder: rec.toJSON(), name: 'Rascunho', savedAt: 1 };
    assert.equal(await store.draft.save(payload), true);
    assert.deepEqual(await store.draft.load(), JSON.parse(JSON.stringify(payload)));
    // texto JSON também serve
    assert.equal(await store.draft.save(JSON.stringify({ recorder: { kind: 'wrx-recorder', v: 1 } })), true);
    assert.deepEqual(await store.draft.load(), { recorder: { kind: 'wrx-recorder', v: 1 } });
    for (const junk of [null, undefined, 42, 'não é json', '[1,2]', []]) assert.equal(await store.draft.save(junk), false);
    assert.deepEqual(await store.draft.load(), { recorder: { kind: 'wrx-recorder', v: 1 } }, 'lixo não apaga o rascunho bom');
    // o rascunho não aparece na lista de mapas
    assert.deepEqual(await store.list(), []);
    await store.draft.clear();
    assert.equal(await store.draft.load(), null);
    await store.draft.clear(); // de novo: sem erro
  });
}

// ---------------------------------------------------------------------------
// localStorage: persistência, cota e registros estragados
// ---------------------------------------------------------------------------

test('local: os mapas continuam lá ao reabrir, e todas as chaves começam com "wrx."', async () => {
  const storage = fakeStorage();
  const first = await local(storage);
  const id = await first.put(sampleRecord());
  await first.draft.save({ recorder: { kind: 'wrx-recorder' } });
  first.close();

  const second = await local(storage);
  assert.deepEqual((await second.list()).map((e) => e.id), [id]);
  assert.deepEqual((await second.get(id)).survey, sampleSurvey());
  assert.deepEqual(await second.draft.load(), { recorder: { kind: 'wrx-recorder' } });
  assert.ok([...storage.data.keys()].every((k) => k.startsWith('wrx.maps.')), [...storage.data.keys()].join(', '));

  // "apagar dados salvos" do app: remove todas as chaves wrx.* por fora
  for (const key of [...storage.data.keys()]) if (key.startsWith('wrx.')) storage.removeItem(key);
  assert.deepEqual(await second.list(), []);
  assert.equal(await second.get(id), null);
  assert.equal(await second.draft.load(), null);
  assert.match(await second.put(sampleRecord()), /^m/, 'e continua funcionando depois');
});

test('local: sem espaço, put rejeita com MapStoreError "quota" e nada fica pela metade', async () => {
  const storage = fakeStorage();
  const store = await local(storage);
  const first = await store.put(sampleRecord({ name: 'Cabe' }));
  const before = new Map(storage.data);
  const sizeOfOne = [...storage.data].reduce((n, [k, v]) => n + k.length + v.length, 0);

  // 1) não cabe nem o registro
  storage.quota = sizeOfOne + 200;
  const err = await rejects(store.put(sampleRecord({ name: 'Não cabe' })), 'quota', /Sem espaço/);
  assert.equal(store.lastError, err);
  assert.deepEqual(new Map(storage.data), before, 'nada mudou no armazenamento');
  assert.deepEqual((await store.list()).map((e) => e.name), ['Cabe']);

  // 2) cabe o registro, mas não a lista atualizada: o registro é desfeito
  const itemSize = [...storage.data].find(([k]) => k.includes('.item.'))[1].length;
  storage.quota = sizeOfOne + itemSize + 60;
  await rejects(store.put(sampleRecord({ name: 'Cabe só o registro' })), 'quota');
  assert.deepEqual(new Map(storage.data), before, 'o registro sem linha na lista foi desfeito');

  // 3) atualizar um mapa existente sem espaço: a versão anterior continua inteira
  storage.quota = sizeOfOne + 10;
  const bigger = { ...(await store.get(first)), name: 'Cabe', meta: { nota: 'x'.repeat(5000) } };
  await rejects(store.put(bigger), 'quota');
  assert.deepEqual((await store.get(first)).meta, sampleRecord().meta);
  await rejects(store.rename(first, 'Um nome bem mais comprido do que o anterior, para não caber'), 'quota');
  assert.equal((await store.get(first)).name, 'Cabe');

  // o rascunho nunca lança: devolve false e deixa o motivo em lastError
  assert.equal(await store.draft.save({ recorder: { blob: 'y'.repeat(4000) } }), false);
  assert.equal(store.lastError.code, 'quota');
  assert.equal(await store.draft.load(), null);

  // liberando espaço, volta a gravar
  storage.quota = Infinity;
  await store.put(sampleRecord({ name: 'Agora cabe' }));
  assert.deepEqual((await store.list()).map((e) => e.name).sort(), ['Agora cabe', 'Cabe']);
});

test('local: registro estragado é pulado, não derruba a lista', async () => {
  const storage = fakeStorage();
  const clock = fakeClock();
  const store = await local(storage, { now: clock.now });
  const good = await store.put(sampleRecord({ name: 'Inteiro' }));
  clock.advance(1000);
  const broken = await store.put(sampleRecord({ name: 'Vai quebrar' }));
  clock.advance(1000);
  const gutted = await store.put(sampleRecord({ name: 'Sem levantamento' }));
  clock.advance(1000);
  const future = await store.put(sampleRecord({ name: 'Do futuro' }));
  clock.advance(1000);
  const vanished = await store.put(sampleRecord({ name: 'Sumiu' }));

  const key = (id) => `wrx.maps.item.${id}`;
  storage.data.set(key(broken), storage.data.get(key(broken)).slice(0, 80)); // JSON cortado no meio
  const g = JSON.parse(storage.data.get(key(gutted)));
  g.survey = { version: 1, scans: 'cadê?' };
  storage.data.set(key(gutted), JSON.stringify(g));
  const f = JSON.parse(storage.data.get(key(future)));
  f.v = 2; // gravado por uma versão mais nova do app
  storage.data.set(key(future), JSON.stringify(f));
  storage.data.delete(key(vanished)); // linha na lista sem o registro

  // um armazenamento recém-aberto (o app acabou de abrir) confere cada registro antes de listar:
  // só o inteiro aparece; abrir um estragado devolve null
  const fresh = await local(storage, { now: clock.now });
  assert.deepEqual((await fresh.list()).map((e) => e.name), ['Inteiro']);
  assert.equal(fresh.lastError, null, 'registro estragado não é erro: é só pulado');
  // o armazenamento que gravou os registros ainda confia neles (foram estragados por fora)...
  assert.ok((await store.list()).some((e) => e.name === 'Inteiro'));
  // ...até tentar abrir um: aí ele sai da lista
  assert.equal(await store.get(broken), null);
  assert.equal(await store.get(gutted), null);
  assert.equal(await store.get(future), null);
  assert.equal(await store.get(vanished), null);
  assert.deepEqual((await store.get(good)).survey, sampleSurvey());
  assert.ok(storage.data.has(key(future)), 'registro de versão futura não é apagado');
  assert.ok(storage.data.has(key(gutted)), 'nem o estragado: só sai da lista');
  assert.deepEqual((await store.list()).map((e) => e.name), ['Inteiro']);

  // lista corrompida: é refeita a partir dos registros inteiros
  for (const junk of ['{não é json', '"texto"', '{"a":1}', JSON.stringify([null, 42, 'x', { id: good }, { id: 'a b', name: 'x', createdAt: 1, updatedAt: 1, stats: {} }])]) {
    storage.data.set('wrx.maps.index', junk);
    const list = await store.list();
    assert.deepEqual(list.map((e) => e.name), ['Inteiro'], `lista = ${junk.slice(0, 20)}`);
    assert.deepEqual(list[0].stats, { scans: 6, spots: 1, floors: 2, areaM2: 48.3, level: 'boa' });
  }
  // e fica consertada
  assert.deepEqual(JSON.parse(storage.data.get('wrx.maps.index')).filter((e) => e && e.id === good).length, 1);
  // sem lista nenhuma também
  storage.data.delete('wrx.maps.index');
  assert.deepEqual((await store.list()).map((e) => e.id), [good]);

  // rascunho corrompido = sem rascunho
  storage.data.set('wrx.maps.draft', '{"recorder":');
  assert.equal(await store.draft.load(), null);
  storage.data.set('wrx.maps.draft', '[1,2,3]');
  assert.equal(await store.draft.load(), null);
});

test('local: um armazenamento que passa a falhar no meio do uso não vira exceção nas leituras', async () => {
  const storage = fakeStorage();
  const store = await local(storage);
  const id = await store.put(sampleRecord());
  const fail = () => {
    throw new Error('disco com defeito');
  };
  storage.getItem = fail;
  storage.setItem = fail;
  storage.removeItem = fail;
  storage.key = fail;
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.get(id), null);
  assert.equal(await store.draft.load(), null);
  assert.equal(await store.draft.save({ a: 1 }), false);
  assert.equal(await store.remove(id), false);
  await store.clear();
  await store.draft.clear();
  await rejects(store.put(sampleRecord()), 'failed', /Não foi possível gravar/);
  assert.equal(store.lastError.code, 'failed');
});

// ---------------------------------------------------------------------------
// Exportar e importar
// ---------------------------------------------------------------------------

test('arquivo: exportar de um aparelho e importar em outro dá o mesmo mapa', async () => {
  const clock = fakeClock();
  const a = await memory({ now: clock.now });
  const id = await a.put(sampleRecord({ demo: true }));
  const text = await a.exportMap(id);
  assert.equal(typeof text, 'string');
  const file = JSON.parse(text);
  assert.equal(file.format, MAP_FILE_FORMAT);
  assert.equal(file.version, MAP_FILE_VERSION);
  assert.equal(file.exportedAt, clock.now());
  assert.equal('id' in file.map, false, 'o id é de cada aparelho');

  clock.advance(86_400_000);
  const b = await local(fakeStorage(), { now: clock.now });
  const imported = await b.importMap(text);
  assert.notEqual(imported, id);
  const original = await a.get(id);
  const copy = await b.get(imported);
  for (const key of ['name', 'survey', 'solution', 'own', 'meta', 'stats', 'demo', 'createdAt']) assert.deepEqual(copy[key], original[key], key);
  // a miniatura não viaja no arquivo: o aparelho que importa faz a dele ao abrir o mapa
  assert.ok(original.thumb, 'o mapa de origem tem miniatura');
  assert.equal('thumb' in file.map, false);
  assert.equal(copy.thumb, null);
  assert.equal((await b.list())[0].updatedAt, original.updatedAt, 'importar não finge que o mapa foi mexido');

  // importar duas vezes cria dois mapas (ids diferentes), sem sobrescrever
  const twice = await b.importMap(text);
  assert.notEqual(twice, imported);
  assert.equal((await b.list()).length, 2);

  await rejects(a.exportMap('não existe'), 'invalid', /não existe mais/);
  // as funções puras fazem o mesmo sem armazenamento
  const parsed = parseMapFile(serializeMap(original), { id: 'fixo' });
  assert.equal(parsed.id, 'fixo');
  assert.deepEqual(parsed.survey, original.survey);
});

test('arquivo: entrada hostil é recusada com um motivo, sem estragar nada', async () => {
  const store = await memory();
  const good = JSON.parse(serializeMap({ ...sampleRecord(), id: 'x', createdAt: 1, updatedAt: 2, stats: {} }));
  const file = (patch, mapPatch = {}) => JSON.stringify({ ...good, ...patch, map: { ...good.map, ...mapPatch } });

  const refused = [
    [null, /não é um mapa/],
    [undefined, /não é um mapa/],
    [42, /não é um mapa/],
    [{}, /não é um mapa/],
    ['', /não é um mapa/],
    ['olá', /não é um mapa/],
    ['{"format":', /não é um mapa/],
    ['[]', /não é um mapa/],
    ['null', /não é um mapa/],
    ['{}', /não é um mapa/],
    [JSON.stringify(sampleSurvey()), /não é um mapa/], // um levantamento solto não é um arquivo de mapa
    [file({ format: 'outro-app' }), /não é um mapa/],
    [file({ version: 'um' }), /não é um mapa/],
    [file({ version: 0 }), /não é um mapa/],
    [file({ version: MAP_FILE_VERSION + 1 }), /versão mais nova/],
    [JSON.stringify({ ...good, map: 'x' }), /não é um mapa/],
    [file({}, { survey: null }), /incompleto/],
    [file({}, { survey: { version: 1, scans: 'x' } }), /incompleto/],
    [file({}, { survey: { version: 1, scans: [], aps: {} } }), /nenhuma medição/],
    [`{"format":"${MAP_FILE_FORMAT}","version":1,"map":{"pad":"${'x'.repeat(16_000_001)}"}}`, /grande demais/],
  ];
  for (const [input, pattern] of refused) await rejects(store.importMap(input), 'invalid', pattern);
  assert.deepEqual(await store.list(), []);

  // o que dá para aproveitar é aproveitado, limpo
  const dirty = `{"format":"${MAP_FILE_FORMAT}","version":1,"__proto__":{"polluted":"sim"},"map":{
    "__proto__":{"polluted":"sim"},
    "name":"<script>alert(1)</script>\\u0000${'n'.repeat(200)}",
    "createdAt":9999999999999999,"updatedAt":"ontem","demo":"true","id":"../../roubado",
    "own":["AA:BB:CC:00:00:01","javascript:alert(1)"],
    "meta":{"__proto__":{"polluted":"sim"},"rooms":2,"html":"<img onerror=x>"},
    "thumb":"javascript:alert(1)",
    "stats":{"level":"<i>","areaM2":1e99},
    "solution":{"points":[],"aps":{}},
    "survey":${JSON.stringify({ ...sampleSurvey(), evil: '<x>', aps: JSON.parse('{"__proto__":{"ssid":"x","freq":1},"a0:b1:c2:00:00:01":{"ssid":"<b>Casa</b>","freq":2437}}') })}}}`;
  const id = await store.importMap(dirty);
  const rec = await store.get(id);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(rec.meta), Object.prototype);
  assert.match(id, /^m[a-z0-9]+$/);
  assert.equal(rec.name.length, 60);
  assert.ok(rec.name.startsWith('<script>alert(1)</script> n'), 'nome como texto, sem o caractere de controle');
  assert.ok(rec.createdAt <= Date.now() + 1000, 'data do futuro vira agora');
  assert.equal(rec.demo, false);
  assert.deepEqual(rec.own, ['aa:bb:cc:00:00:01']);
  assert.deepEqual(rec.meta, { rooms: 2, html: '<img onerror=x>' });
  assert.equal(rec.thumb, null);
  assert.equal(rec.solution, null, 'solução que não bate com o levantamento é descartada: o app resolve de novo');
  assert.deepEqual(rec.stats, { scans: 6, spots: 1, floors: 2, areaM2: null, level: null });
  assert.deepEqual(validateSurvey(rec.survey), []);
  assert.equal(rec.survey.aps[mac(1)].ssid, '<b>Casa</b>');
  assert.equal('evil' in rec.survey, false);
});

test('nomes: cleanName', () => {
  assert.equal(cleanName('  Casa   da\tvó\n'), 'Casa da vó');
  assert.equal(cleanName(''), 'Mapa sem nome');
  assert.equal(cleanName(null, 'x'), 'x');
  assert.equal(Array.from(cleanName('🏠'.repeat(100))).length, 60);
});

test('memoryStorage: comporta-se como um localStorage', () => {
  const s = memoryStorage();
  assert.equal(s.length, 0);
  assert.equal(s.getItem('a'), null);
  s.setItem('a', 1);
  s.setItem('b', 'dois');
  assert.equal(s.getItem('a'), '1');
  assert.equal(s.length, 2);
  assert.deepEqual([s.key(0), s.key(1), s.key(2)], ['a', 'b', null]);
  s.removeItem('a');
  assert.equal(s.length, 1);
  s.clear();
  assert.equal(s.length, 0);
});

// ---------------------------------------------------------------------------
// Um mapa de verdade
// ---------------------------------------------------------------------------

test('um levantamento gravado, salvo e reaberto refaz exatamente o mesmo modelo', async () => {
  // levantamento sintético com geometria conhecida, passando pelo gravador
  let t = Date.UTC(2026, 0, 1);
  const rec = createRecorder({ now: () => t });
  rec.start();
  const routers = [
    { id: mac(1), x: 0, y: 0, freq: 2437 },
    { id: mac(2), x: 8, y: 0, freq: 5180 },
    { id: mac(300), x: 4, y: 7, freq: 2462 },
    { id: mac(500), x: -3, y: 5, freq: 5500 },
  ];
  const truth = [];
  for (let i = 0; i < 40; i++) {
    t += 3000;
    const x = 4 + 3.5 * Math.cos(i / 6);
    const y = 3 + 2.5 * Math.sin(i / 4);
    truth.push({ x, y });
    if (i === 10) rec.beginSpot('Sala');
    if (i === 14) rec.endSpot();
    rec.onScan({
      ts: t,
      fresh: true,
      source: 'request',
      aps: routers.map((r) => ({ bssid: r.id, ssid: 'Rede', level: Math.round(-38 - 25 * Math.log10(Math.max(0.5, Math.hypot(x - r.x, y - r.y)))), frequency: r.freq, ageMs: 1500, capabilities: '[ESS]', channelWidth: 0, centerFreq0: 0, centerFreq1: 0 })),
    });
  }
  const survey = rec.toSurvey();
  const solution = { points: truth.map((p) => ({ x: p.x, y: p.y, z: 0, conf: 0.9 })), aps: Object.fromEntries(routers.map((r) => [r.id, { x: r.x, y: r.y, z: 1.5, p0: -38, n: 2.5, conf: 0.8 }])), scaleConf: 0.7 };
  const own = [mac(1), mac(2)];
  const model = buildMap(survey, solution, { own });

  const storage = fakeStorage();
  const store = await local(storage);
  const id = await store.put({ name: 'Teste', survey, solution, own, stats: { areaM2: model.quality.areaM2, level: model.quality.level } });
  const back = await (await local(storage)).get(id);
  assert.deepEqual(back.survey, survey);
  assert.deepEqual(back.solution, solution);
  const again = buildMap(back.survey, back.solution, { own: back.own });
  assert.deepEqual(again.quality, model.quality);
  assert.deepEqual(again.bounds, model.bounds);
  assert.equal(again.floors.length, model.floors.length);
  assert.deepEqual(Array.from(again.floors[0].inside), Array.from(model.floors[0].inside));
  assert.deepEqual(again.floors[0].rooms, model.floors[0].rooms);
  assert.deepEqual(again.spots, model.spots);
  assert.equal((await store.list())[0].stats.areaM2, Math.round(model.quality.areaM2 * 10) / 10);
});

test('arquivo: a miniatura que vem num arquivo nunca é aproveitada (imagem de terceiros na lista de mapas)', async () => {
  const store = await memory();
  // um PNG "válido" de 12000 x 12000 cabe em poucos kB e custaria centenas de MB para desenhar:
  // aqui basta o cabeçalho, porque o arquivo importado nem chega a ter a imagem olhada
  const ihdr = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x2e, 0xe0, 0, 0, 0x2e, 0xe0, 1, 0, 0, 0, 0]);
  const bomb = `data:image/png;base64,${ihdr.toString('base64')}`;
  const id = await store.put(sampleRecord());
  const file = JSON.parse(await store.exportMap(id));
  for (const thumb of [bomb, PNG, 'data:image/jpeg;base64,/9j/4AAQ', 'https://exemplo.com/x.png']) {
    file.map.thumb = thumb;
    const imported = await store.importMap(JSON.stringify(file));
    const rec = await store.get(imported);
    assert.equal(rec.thumb, null, thumb.slice(0, 30));
    assert.equal((await store.list()).find((e) => e.id === imported).thumb, null);
    assert.equal(rec.survey.scans.length, file.map.survey.scans.length, 'o mapa em si entra normalmente');
  }
});

test('setThumb: troca só a miniatura, sem mexer na data do mapa, e recusa o que não é imagem embutida', async () => {
  const clock = fakeClock();
  const store = await memory({ now: clock.now });
  const id = await store.put(sampleRecord({ thumb: null }));
  const before = await store.get(id);
  assert.equal(before.thumb, null);
  clock.advance(60_000);
  assert.equal(await store.setThumb(id, PNG), true);
  const after = await store.get(id);
  assert.equal(after.thumb, PNG);
  assert.equal(after.updatedAt, before.updatedAt, 'a miniatura não conta como mudança no mapa');
  assert.equal((await store.list())[0].thumb, PNG);
  for (const bad of ['javascript:alert(1)', 'https://exemplo.com/x.png', 'data:image/svg+xml;base64,AAAA', null, 7, `data:image/png;base64,${'A'.repeat(500_000)}`]) {
    assert.equal(await store.setThumb(id, bad), false);
  }
  assert.equal((await store.get(id)).thumb, PNG);
  assert.equal(await store.setThumb('mnaoexiste', PNG), false);
});

test('arquivo: tetos contra arquivos feitos para travar o app (redes demais, lugares marcados demais)', async () => {
  const { MAX_IMPORT_APS, MAX_IMPORT_SPOTS, parseMapFile } = await import('../app/js/mapping/storage.js');
  const wrap = (survey) => JSON.stringify({ format: MAP_FILE_FORMAT, version: MAP_FILE_VERSION, exportedAt: Date.now(), map: { name: 'x', survey } });
  const id = (n) => `02:00:${((n >> 16) & 255).toString(16).padStart(2, '0')}:${((n >> 8) & 255).toString(16).padStart(2, '0')}:${(n & 255).toString(16).padStart(2, '0')}:01`;
  // cada leitura é um BSSID diferente: `scans` x `per` redes
  const flood = (scans, per) => ({
    version: 1,
    aps: {},
    scans: Array.from({ length: scans }, (_, s) => ({ t: s * 3, floor: 0, still: false, spot: null, readings: Array.from({ length: per }, (_, i) => ({ id: id(s * per + i), rssi: -50 - (i % 40), freq: 2412 })) })),
  });
  const store = await memory();

  // no teto: entra; acima dele: recusado com uma frase clara, e nada é gravado
  const atLimit = parseMapFile(wrap(flood(MAX_IMPORT_APS / 100, 100)));
  assert.equal(Object.keys(atLimit.survey.aps).length, MAX_IMPORT_APS);
  await rejects(store.importMap(wrap(flood(MAX_IMPORT_APS / 100 + 1, 100))), 'invalid', /redes demais/);
  // o arquivo do ataque medido na revisão: 80 varreduras x 390 redes diferentes (31.200), 1,6 MB
  await rejects(store.importMap(wrap(flood(80, 390))), 'invalid', /redes demais/);

  // lugares marcados: cada varredura um lugar com nome
  const spots = (n) => ({
    version: 1,
    aps: { [id(1)]: { ssid: 'Casa', freq: 2437 } },
    scans: Array.from({ length: n }, (_, i) => ({ t: i * 3, floor: 0, still: true, spot: i, label: `Lugar ${i}`, readings: [{ id: id(1), rssi: -50, freq: 2437 }] })),
  });
  assert.equal(parseMapFile(wrap(spots(MAX_IMPORT_SPOTS))).stats.spots, MAX_IMPORT_SPOTS);
  await rejects(store.importMap(wrap(spots(MAX_IMPORT_SPOTS + 1))), 'invalid', /lugares marcados demais/);
  await rejects(store.importMap(wrap(spots(4000))), 'invalid', /lugares marcados demais/);
  assert.deepEqual(await store.list(), []);
});
