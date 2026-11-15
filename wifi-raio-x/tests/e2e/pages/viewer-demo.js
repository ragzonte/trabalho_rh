// Página de demonstração do visualizador do mapa (só para testes e para olhar: não vai para o app).
//
// Tudo o que os controles fazem também entra pela URL, para tirar fotos direto num estado:
//   ?world=sobrado          apartamento | sobrado | escritorio | kitnet | big (200 x 200, 3 andares)
//   &seed=1&noise=0.7       semente do mundo e erro de posição do mapa de mentira (m)
//   &builder=real           usa o construtor de verdade (mapping/mapmodel.js) sobre um levantamento simulado
//   &theme=light            dark | light
//   &heat=0                 índice da rede que colore o piso (sem o parâmetro: cor por ambiente)
//   &layers=relief,neighbours,-grid   liga (ou desliga, com "-") camadas
//   &view=top&explode=1&focus=1       vista, afastamento dos andares e andar em foco
//   &labels=hostile         nomes longos, com emoji e com HTML
//   &renderer=2d            força o mapa 2D (ou 3d)
//   &progress=0.4           só o começo do levantamento
//   &walker=1               marcador "você está aqui"
//   &ui=0                   esconde os controles (o mapa ocupa a página toda)
//   &ambient=0              sem pulsação
//   &aa=1 | &aa=0           força a suavização de serrilhado (sem o parâmetro: desligada só em WebGL por software)
//   &maxdpr=1               teto da densidade de pixels
//
// Para os testes: window.__demo = { viewer, model, fake, picks, state, ready, apply(estado) }.

import { createViewer } from '../../../app/js/ui/map/viewer3d.js';
import { DEFAULT_LAYERS } from '../../../app/js/ui/map/viewer2d.js';
import { fakeMap, fakeBigMap, realMap, relabel, listPresets, HOSTILE_LABELS } from '../../helpers/fake-map.mjs';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const num = (key, fallback) => (params.has(key) && params.get(key) !== '' && Number.isFinite(Number(params.get(key))) ? Number(params.get(key)) : fallback);

const state = {
  world: params.get('world') || 'apartamento',
  builder: params.get('builder') === 'real' ? 'real' : 'fake',
  seed: num('seed', 1),
  noise: num('noise', 0.7),
  theme: params.get('theme') === 'light' ? 'light' : 'dark',
  heat: params.has('heat') ? num('heat', 0) : -1,
  view: params.get('view') === 'top' ? 'top' : 'orbit',
  explode: num('explode', 0),
  focus: params.has('focus') ? num('focus', null) : null,
  labels: params.get('labels') === 'hostile' ? 'hostile' : 'normal',
  progress: num('progress', 1),
  walker: params.get('walker') === '1',
  layers: { ...DEFAULT_LAYERS },
};
for (const item of (params.get('layers') || '').split(',').filter(Boolean)) {
  const off = item.startsWith('-');
  const name = off ? item.slice(1) : item;
  if (name in state.layers) state.layers[name] = !off;
}

document.documentElement.dataset.theme = state.theme;
if (params.get('ui') === '0') $('panel').hidden = true;

const picks = [];
const viewer = createViewer($('stage'), {
  theme: state.theme,
  renderer: params.get('renderer') || 'auto',
  ambient: params.get('ambient') !== '0',
  antialias: params.has('aa') ? params.get('aa') !== '0' : undefined,
  maxPixelRatio: num('maxdpr', 2),
  contextRestoreMs: num('restoreMs', 4000),
  onPick(pick) {
    picks.push(pick);
    const what = pick.kind === 'router' ? `roteador ${pick.label || '(oculto)'}` : pick.kind === 'spot' ? `ponto ${pick.label}` : `${pick.label || 'sem ambiente'}${pick.dbm !== null && pick.dbm !== undefined ? `, ${Math.round(pick.dbm)} dBm` : ''}`;
    status(`toque: ${pick.kind} · ${what} · andar ${pick.floor}`);
  },
  onFallback(reason) {
    status(`o 3D caiu (${reason}); mapa 2D no lugar`);
  },
});

let fake = null;
let model = null;
let walkTimer = 0;

function status(text) {
  $('status').textContent = text;
}

async function buildModel() {
  if (state.world === 'big') {
    fake = fakeBigMap({ seed: state.seed });
    fake.networks = fake.model.networks;
  } else if (state.builder === 'real') {
    fake = await realMap(state.world, { seed: state.seed, noiseM: state.noise, progress: state.progress });
  } else {
    fake = fakeMap(state.world, { seed: state.seed, noiseM: state.noise, progress: state.progress });
  }
  model = state.labels === 'hostile' ? relabel(fake.model, HOSTILE_LABELS) : fake.model;
}

function heatFields() {
  if (state.heat < 0 || !model.networks[state.heat]) return null;
  return fake.heat(model.networks[state.heat].key);
}

function fillSelect(el, options, value) {
  el.replaceChildren(
    ...options.map(([v, text]) => {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = text; // nomes de rede são texto de fora: nunca HTML
      return o;
    }),
  );
  el.value = String(value);
}

function syncControls() {
  fillSelect($('heat'), [[-1, 'por ambiente'], ...model.networks.map((n, i) => [i, `sinal: ${n.ssid || '(oculta)'}${n.own ? '' : ' (vizinho)'}`])], state.heat);
  fillSelect($('focus'), [['', 'todos'], ...model.floors.map((f) => [f.floor, `andar ${f.floor}`])], state.focus ?? '');
  $('world').value = state.world;
  $('view').value = state.view;
  $('theme').value = state.theme;
  $('labels').value = state.labels;
  $('explode').value = String(state.explode);
  $('progress').value = String(state.progress);
  for (const box of $('layers').querySelectorAll('input')) box.checked = !!state.layers[box.name];
}

/** Aplica um estado (parcial) e devolve quando a cena estiver desenhada. */
async function apply(patch = {}) {
  const rebuild = ['world', 'seed', 'noise', 'labels', 'progress', 'builder'].some((k) => k in patch && patch[k] !== state[k]) || !model;
  const before = { ...state };
  Object.assign(state, patch, patch.layers ? { layers: { ...state.layers, ...patch.layers } } : {});
  if (rebuild) {
    const sameWorld = before.world === state.world && before.seed === state.seed && model;
    if (!sameWorld && !('heat' in patch) && model) state.heat = -1;
    if (!sameWorld && !('focus' in patch) && model) state.focus = null;
    await buildModel();
    viewer.setModel(model);
  }
  document.documentElement.dataset.theme = state.theme;
  viewer.setTheme(state.theme);
  viewer.setLayers(state.layers);
  viewer.setHeat(heatFields());
  viewer.setView(state.view);
  viewer.setExplode(state.explode);
  viewer.setFocusFloor(state.focus);
  if (state.walker && model.path.length) {
    const p = model.path[Math.floor(model.path.length * 0.6)];
    viewer.setWalker({ x: p.x, y: p.y, z: p.z + 1.2 });
  } else if (!walkTimer) viewer.setWalker(null);
  syncControls();
  const q = model.quality;
  status(`${viewer.kind.toUpperCase()} · ${model.nx}×${model.ny} células de ${model.cell} m · ${model.floors.length} andar(es) · ${model.path.length} varreduras · erro esperado ≈ ${q.expectedErrorM} m`);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

// --- controles ---
fillSelect($('world'), [...listPresets().map((p) => [p.id, p.name]), ['big', 'Grande (200 × 200, 3 andares)']], state.world);
for (const name of Object.keys(DEFAULT_LAYERS)) {
  const label = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.name = name;
  box.addEventListener('change', () => apply({ layers: { [name]: box.checked } }));
  label.append(box, document.createTextNode(name));
  $('layers').append(label);
}
$('world').addEventListener('change', (ev) => apply({ world: ev.target.value }));
$('heat').addEventListener('change', (ev) => apply({ heat: Number(ev.target.value) }));
$('view').addEventListener('change', (ev) => apply({ view: ev.target.value }));
$('theme').addEventListener('change', (ev) => apply({ theme: ev.target.value }));
$('labels').addEventListener('change', (ev) => apply({ labels: ev.target.value }));
$('focus').addEventListener('change', (ev) => apply({ focus: ev.target.value === '' ? null : Number(ev.target.value) }));
$('explode').addEventListener('input', (ev) => apply({ explode: Number(ev.target.value) }));
$('progress').addEventListener('change', (ev) => apply({ progress: Number(ev.target.value) }));
$('reset').addEventListener('click', () => viewer.resetView());
$('panel').addEventListener('submit', (ev) => ev.preventDefault());
$('walk').addEventListener('click', () => {
  // "você está aqui" andando pelo caminho, como na pré-visualização ao vivo
  if (walkTimer) {
    clearInterval(walkTimer);
    walkTimer = 0;
    viewer.setWalker(null);
    return;
  }
  let i = 0;
  walkTimer = setInterval(() => {
    const p = model.path[i++ % model.path.length];
    viewer.setWalker({ x: p.x, y: p.y, z: p.z + 1.2 });
  }, 600);
});
$('shot').addEventListener('click', async () => {
  const blob = await viewer.snapshot();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mapa-${state.world}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`foto: ${Math.round(blob.size / 1024)} kB`);
});

const ready = apply({}).then(() => {
  document.documentElement.dataset.ready = '1';
});

window.__demo = {
  viewer,
  picks,
  state,
  ready,
  apply,
  get model() {
    return model;
  },
  get fake() {
    return fake;
  },
  fakeMap,
  fakeBigMap,
  realMap,
  relabel,
};
