// Mapa 3D — resultado (#/mapa/ver/<id> e #/mapa/ver/novo).
//
//   mountResult(root, env, { id }) -> Promise<{ unmount() }>
//       id = 'novo'  -> o levantamento que acabou de ser concluído (env.session.result) ou, depois de
//                       recarregar a página, o rascunho guardado (o mapa é refeito na hora);
//       outro id     -> um mapa salvo (mapping/storage.js). O modelo nunca é guardado: é refeito do
//                       levantamento e da solução (buildMap), e só se a solução faltar o motor roda.
//
// A tela é o visualizador (viewer3d.js, com queda para 2D) ocupando tudo, e por cima dele:
//   - a barra de cima do app com o nome do mapa, "Salvar" (enquanto não foi salvo) e o menu de compartilhar;
//   - um cartão pequeno quando se toca num ambiente, roteador ou lugar marcado (onPick);
//   - um painel embaixo (na horizontal, ao lado) que abre e fecha: "Mostrar" (ambientes ou o sinal
//     de uma rede, com a legenda em dBm e palavras), 3D / Planta, relevo do sinal, andares, camadas,
//     e os cartões Cobertura, Sugestão, Qualidade do mapa, "Como este mapa é feito" e as ações.
//
// Honestidade em dois casos que não são "um mapa com ambientes":
//   - menos de dois lugares com nome: o mapa mostra só a área (o construtor não inventa ambientes),
//     "Mostrar" oferece "Área" em vez de "Ambientes" e um cartão convida a marcar lugares;
//   - levantamento de que não sai mapa (quality.usable === false: um roteador só ao alcance,
//     leituras todas no mesmo lugar...): o desenho NÃO aparece; no lugar dele vai o motivo e o que fazer.
//
// Ações: salvar / renomear, ajustar a escala (distância real entre dois lugares marcados ->
// survey.knownDistances -> o motor refaz o mapa), continuar mapeando, imagem (PNG), arquivo do
// mapa (JSON), apagar. Renomear um ambiente mexe no levantamento (map-ui-logic.renameRoom) e
// refaz só o modelo.
//
// Para testes e aparelhos sem WebGL: "#/mapa/ver/<id>?visual=2d" força o visualizador 2D.
//
// Todo texto que vem de fora (nome do mapa, dos ambientes, das redes) entra como texto, via h().

import { h, patch, sheet, toast, confirmDialog, fmtDbm, fmtNum, plural, THIN } from '../dom.js';
import { icon } from '../icons.js';
import { button, iconButton, badge, banner, displaySsid, select, slider, errorState, spinner } from '../components.js';
import { buildMap, heatField, coverage, suggestRouterSpot, describeMap } from '../../mapping/mapmodel.js';
import { recorderFromJSON } from '../../mapping/recorder.js';
import { createViewer } from './viewer3d.js';
import { signalScale, signalGradientCss, SIGNAL_BREAKS_DBM } from './map-colors.js';
import { actionSheet, promptSheet } from './library.js';
import { processingView } from './survey.js';
import {
  floorName,
  qualityInfo,
  hasRooms,
  roomsInvite,
  ACCURACY,
  coverageParts,
  deadZoneLines,
  placeText,
  heatChoices,
  roomSignal,
  signalWordAt,
  spotOptions,
  spotDistance,
  parseMeters,
  withKnownDistance,
  renameRoom,
  ownBssidsFor,
  mapMeta,
  defaultMapName,
  cleanMapName,
  fileSlug,
  makeRecord,
  readRecord,
  approxMetersText,
  isDemoOrigin,
  matchesMode,
} from './map-ui-logic.js';

const LAYERS = [
  ['path', 'Caminho'],
  ['spots', 'Lugares marcados'],
  ['walls', 'Divisões'],
  ['routers', 'Roteadores'],
  ['neighbours', 'Vizinhos'],
  ['labels', 'Nomes'],
];
const LEGEND_MIN = -90;
const LEGEND_MAX = -50;
const QUALITY_TONE = { good: 'good', info: 'info', warning: 'warning' };

const abortError = () => Object.assign(new Error('cancelado'), { name: 'AbortError' });
const approxDbm = (dbm) => (Number.isFinite(dbm) ? `≈${THIN}${fmtDbm(dbm)}` : 'sem medição');
const landscapeQuery = '(orientation: landscape) and (max-height: 520px)';

// ---------------------------------------------------------------------------
// Imagens
// ---------------------------------------------------------------------------

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error || new Error('não foi possível ler a imagem'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('não foi possível abrir a imagem'));
    };
    img.src = url;
  });
}

/** Miniatura (4:3) da parte do mapa que não está coberta pelo painel. */
async function makeThumb(blob, pad) {
  const img = await loadImage(blob);
  const W = 384;
  const H = 288;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  // área livre da foto (o painel cobre a parte de baixo, ou a direita quando deitado)
  const k = img.naturalWidth / Math.max(1, pad.width);
  const fw = Math.max(40, (pad.width - pad.right) * k);
  const fh = Math.max(40, (pad.height - pad.bottom) * k);
  const scale = Math.max(W / fw, H / fh);
  const sw = W / scale;
  const sh = H / scale;
  g.drawImage(img, (fw - sw) / 2, (fh - sh) / 2, sw, sh, 0, 0, W, H);
  let url = canvas.toDataURL('image/webp', 0.8);
  if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', 0.8);
  return url.length < 380_000 ? url : null;
}

/** A foto do mapa com o nome e o aviso de que é uma estimativa (o que vai para os amigos). */
async function composeShareImage(blob, { name, subtitle, dark }) {
  const img = await loadImage(blob);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const g = canvas.getContext('2d');
  g.drawImage(img, 0, 0);
  const u = Math.max(1, canvas.width / 412); // 1 "px de tela"
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  g.textBaseline = 'top';
  const title = Array.from(String(name)).slice(0, 48).join('');
  g.font = `600 ${20 * u}px ${font}`;
  const wTitle = Math.min(canvas.width - 56 * u, g.measureText(title).width);
  g.font = `500 ${12 * u}px ${font}`;
  const wSub = Math.min(canvas.width - 56 * u, g.measureText(subtitle).width);
  const boxW = Math.max(wTitle, wSub) + 24 * u;
  g.fillStyle = dark ? 'rgba(10, 15, 28, 0.82)' : 'rgba(255, 255, 255, 0.88)';
  g.beginPath();
  if (typeof g.roundRect === 'function') g.roundRect(16 * u, 16 * u, boxW, 62 * u, 12 * u);
  else g.rect(16 * u, 16 * u, boxW, 62 * u);
  g.fill();
  g.fillStyle = dark ? '#e8eef9' : '#0f172a';
  g.font = `600 ${20 * u}px ${font}`;
  g.fillText(title, 28 * u, 25 * u, canvas.width - 56 * u);
  g.fillStyle = dark ? '#93a0b8' : '#5b6779';
  g.font = `500 ${12 * u}px ${font}`;
  g.fillText(subtitle, 28 * u, 53 * u, canvas.width - 56 * u);
  return new Promise((resolve, reject) => canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('não foi possível gerar a imagem'))), 'image/png'));
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} root
 * @param {object} env  veja ui/screens/map.js
 * @param {{id:string}} o
 */
export async function mountResult(root, env, { id }) {
  const { ctx, storage } = env;
  const { store, bridge } = ctx;
  let dead = false;
  const offs = [];

  root.className = 'screen screen--bleed';
  const stage = h('div.mrs__stage');
  const floatEl = h('div.mrs__float');
  const quickEl = h('div.mrs__quick');
  const moreEl = h('div.mrs__more', { id: 'mrs-more' });
  const handleLabel = h('span.mrs__handle-label', null, 'Cobertura, qualidade e ações');
  const handleIcon = h('span.mrs__handle-icon', null, icon('chevron-up', { size: 18 }));
  const handle = h('button.mrs__handle', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'mrs-more' }, h('span.mrs__grab', { 'aria-hidden': 'true' }), h('span.mrs__handle-row', null, handleLabel, handleIcon));
  const panelEl = h('section.mrs__panel', { 'aria-label': 'Controles e detalhes do mapa' }, handle, quickEl, moreEl);
  const busyEl = h('div.mrs__busy', { hidden: true });
  // enquanto o mapa não foi salvo, o botão de salvar fica à vista por cima dele
  const saveFab = h('button.btn.btn--primary.btn--sm.mrs__save', { type: 'button', hidden: true, onClick: () => save() }, icon('save', { size: 18 }), 'Salvar mapa');
  const el = h('div.mrs', { hidden: true }, stage, floatEl, saveFab, panelEl, busyEl);
  const loadingEl = h('div.center.map-loading', null, spinner({ large: true, label: 'Abrindo o mapa' }));
  root.append(loadingEl, el);

  /** O mapa em mãos. */
  const S = { saved: false, id: null, name: null, survey: null, solution: null, model: null, own: [], ownSsids: [], extraOwn: [], demo: false, thumb: null };
  /** O que está sendo mostrado. */
  const V = { show: 'rooms', view: 'orbit', relief: false, layers: { path: true, spots: true, walls: true, routers: true, neighbours: false, labels: true }, floor: null, explode: 0.5, open: false, pick: null };
  let viewer = null;
  let viewerNote = null;
  let pad = { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };

  // --- cálculo com a tela de progresso -------------------------------------

  async function compute(survey, own, previous, title) {
    let cancelled = false;
    let engine = null;
    const view = processingView({
      title,
      onCancel: () => {
        cancelled = true;
        if (engine) engine.cancel();
      },
    });
    busyEl.replaceChildren(view.el);
    busyEl.hidden = false;
    loadingEl.hidden = true;
    try {
      engine = await env.engine();
      if (cancelled) throw abortError();
      const out = await engine.run(survey, { own, previous: previous || undefined, onProgress: (fraction, label) => view.set(fraction, label) });
      if (cancelled) throw abortError();
      return out;
    } finally {
      busyEl.hidden = true;
      busyEl.replaceChildren();
    }
  }

  // --- carregar ------------------------------------------------------------

  function showProblem(title, text) {
    loadingEl.hidden = true;
    el.hidden = true;
    root.className = 'screen';
    root.replaceChildren(errorState({ title, text }), h('div.center', null, button('Voltar para os mapas', { variant: 'secondary', icon: 'arrow-left', onClick: () => env.go('/mapa', { replace: true }) })));
  }

  async function load() {
    if (id === 'novo') {
      let res = env.session.result;
      if (!res) {
        // a página foi recarregada com o resultado na tela: refaz a partir do rascunho
        const draft = await storage.draft.load();
        const rec = draft && draft.recorder ? recorderFromJSON(draft.recorder) : null;
        const survey = rec ? rec.toSurvey() : null;
        if (!survey || survey.scans.length < 3) return 'redirect';
        const ownSsids = Array.isArray(draft.ownSsids) ? draft.ownSsids : [];
        const extraOwn = Array.isArray(draft.extraOwn) ? draft.extraOwn : [];
        const own = ownBssidsFor(survey, ownSsids, extraOwn);
        const out = await compute(survey, own, null, 'Montando o mapa…');
        res = { survey, solution: out.solution, model: out.model, own, ownSsids, extraOwn, recordId: draft.recordId ?? null, name: draft.name || null, demo: !!draft.demo };
      }
      Object.assign(S, { saved: false, id: res.recordId ?? null, name: res.name || null, survey: res.survey, solution: res.solution, model: res.model, own: res.own || [], ownSsids: res.ownSsids || [], extraOwn: res.extraOwn || [], demo: !!res.demo });
      if (S.id !== null) {
        // continuação de um mapa salvo: a miniatura antiga vale até a próxima gravação
        const before = readRecord(await storage.get(S.id));
        if (before) S.thumb = before.thumb;
        else S.id = null;
      }
      return 'ok';
    }
    const rec = readRecord(await storage.get(id));
    if (!rec || !rec.survey || !rec.survey.scans.length) return 'missing';
    let solution = rec.solution;
    let model = null;
    if (solution) model = buildMap(rec.survey, solution, { own: rec.own });
    else {
      const out = await compute(rec.survey, rec.own, null, 'Refazendo o mapa…');
      solution = out.solution;
      model = out.model;
    }
    Object.assign(S, { saved: true, id: rec.id, name: rec.name, survey: rec.survey, solution, model, own: rec.own, ownSsids: rec.ownSsids, extraOwn: rec.own, demo: rec.demo, thumb: rec.thumb });
    return 'ok';
  }

  let status;
  try {
    status = await load();
  } catch (err) {
    if (err && err.name === 'AbortError') status = 'redirect';
    else {
      console.error('[mapa] não foi possível abrir o mapa', err);
      status = 'failed';
    }
  }
  if (dead) return { unmount() {} };
  if (status === 'redirect') {
    env.go(id === 'novo' && (await storage.draft.load()) ? '/mapa/novo' : '/mapa', { replace: true });
    return { unmount() {} };
  }
  if (status === 'missing') {
    showProblem('Este mapa não existe mais', 'Ele pode ter sido apagado. Os outros mapas continuam na lista.');
    return { unmount() {} };
  }
  if (status === 'failed') {
    showProblem('Não deu para abrir este mapa', 'As leituras continuam guardadas. Tente abrir de novo.');
    return { unmount() {} };
  }

  // --- dados derivados -----------------------------------------------------

  const multiFloor = () => S.model.floors.length > 1;
  /** false = deste levantamento não sai mapa: nada de desenhar o que o solucionador devolveu. */
  const usable = () => !(S.model.quality && S.model.quality.usable === false);
  const choices = () => heatChoices(S.model);
  const netByKey = (key) => S.model.networks.find((n) => n.key === key) || null;
  /** A rede de que os cartões falam: a mostrada no mapa ou, sem nenhuma, a principal da casa. */
  const focusNet = () => netByKey(V.show) || S.model.networks.find((n) => n.own) || S.model.networks[0] || null;
  const fieldsFor = (key) => S.model.floors.map((_, i) => heatField(S.model, i, key));
  const displayName = () => S.name || (S.demo ? 'Casa virtual' : 'Mapa novo');
  /** Arquivos de um mapa da casa virtual levam "demonstracao" no nome (o mapa pode ter sido renomeado). */
  const demoPrefix = () => (S.demo ? 'demonstracao-' : '');

  // --- visualizador --------------------------------------------------------

  function applyHeat() {
    if (!viewer || !usable()) return;
    if (V.show !== 'rooms' && !netByKey(V.show)) V.show = 'rooms';
    viewer.setHeat(V.show === 'rooms' ? null : fieldsFor(V.show));
    viewer.setLayers({ ...V.layers, relief: V.relief && V.show !== 'rooms' });
  }

  function applyModel({ keepView = false } = {}) {
    if (!viewer) return;
    // sem mapa, o palco some: o motivo vai num cartão no lugar dele (drawPick)
    stage.style.visibility = usable() ? '' : 'hidden';
    if (!usable()) {
      viewer.setModel(null);
      viewer.setHeat(null);
      return;
    }
    viewer.setModel(S.model, { keepView });
    if (V.floor !== null && !S.model.floors.some((f) => f.floor === V.floor)) V.floor = null;
    viewer.setFocusFloor(V.floor);
    if (multiFloor()) viewer.setExplode(V.explode);
    applyHeat();
  }

  function measurePad() {
    const r = el.getBoundingClientRect();
    const side = window.matchMedia(landscapeQuery).matches;
    const p = panelEl.getBoundingClientRect();
    pad = side ? { top: 0, right: Math.round(p.width), bottom: 0, left: 0 } : { top: 0, right: 0, bottom: Math.round(collapsedHeight()), left: 0 };
    pad.width = Math.round(r.width);
    pad.height = Math.round(r.height);
    stage.style.setProperty('--mapv-inset-b', `${pad.bottom}px`);
    if (viewer) {
      viewer.setPadding({ top: pad.top, right: pad.right, bottom: pad.bottom, left: pad.left });
      viewer.resize();
    }
  }

  /** Altura do painel fechado (a parte que fica sempre por cima do mapa). */
  function collapsedHeight() {
    return handle.offsetHeight + quickEl.offsetHeight;
  }

  function createTheViewer() {
    const forced = ctx.route && ctx.route.query && ctx.route.query.get('visual') === '2d' ? '2d' : 'auto';
    viewer = createViewer(stage, {
      theme: store.get().theme,
      renderer: forced,
      label: 'Mapa aproximado da casa, feito com o sinal do Wi-Fi. Arraste para girar, use dois dedos para aproximar.',
      onPick: (pick) => {
        V.pick = pick || null;
        drawPick();
      },
      onFallback: () => {
        viewerNote = 'O 3D não está disponível agora neste aparelho: o mapa aparece em planta.';
        V.view = 'top';
        drawPanel();
      },
    });
    if (viewer.kind === '2d') V.view = 'top';
  }

  // --- guardar -------------------------------------------------------------

  async function snapshotThumb() {
    if (!viewer) return null;
    try {
      return await makeThumb(await viewer.snapshot(), pad);
    } catch {
      return null;
    }
  }

  async function writeRecord({ name = S.name, refreshThumb = false } = {}) {
    if (refreshThumb || !S.thumb) S.thumb = (await snapshotThumb()) || S.thumb;
    const record = makeRecord({ id: S.id, name, survey: S.survey, solution: S.solution, own: S.own, ownSsids: S.ownSsids, model: S.model, thumb: S.thumb, demo: S.demo });
    const newId = await storage.put(record);
    S.id = newId;
    S.name = record.name;
    S.saved = true;
    return newId;
  }

  /** Depois de uma mudança no mapa (nome de ambiente, escala): grava no lugar certo. */
  async function persistEdit() {
    if (S.saved) {
      try {
        await writeRecord({ refreshThumb: true });
      } catch (err) {
        toast(String((err && err.message) || 'A mudança não pôde ser guardada.'));
      }
    } else {
      // ainda é rascunho: o rascunho passa a ser o levantamento já com a mudança
      await storage.draft.save({ v: 1, recorder: S.survey, ownSsids: S.ownSsids, extraOwn: S.extraOwn, recordId: S.id, name: S.name, demo: S.demo, savedAt: Date.now(), summary: { scans: S.survey.scans.length, spots: mapMeta(S.model, S.survey).spots } });
    }
  }

  async function save() {
    const taken = (await storage.list()).map((r) => r && r.name).filter((n) => typeof n === 'string');
    const suggestion = S.name || defaultMapName(Date.now(), taken, S.demo ? 'Casa virtual' : null);
    const typed = await promptSheet({
      title: 'Salvar o mapa',
      subtitle: storage.persistent ? 'Ele fica guardado neste aparelho e aparece na lista de mapas.' : 'Atenção: este aparelho não deixou o app gravar dados. O mapa fica na lista só enquanto o app estiver aberto.',
      label: 'Nome do mapa',
      value: suggestion,
      placeholder: 'Ex.: Minha casa',
      confirmLabel: 'Salvar',
    });
    if (typed === null || dead) return;
    const name = cleanMapName(typed) || suggestion;
    try {
      const newId = await writeRecord({ name, refreshThumb: true });
      if (dead) return;
      await storage.draft.clear();
      env.session.result = null;
      toast(storage.persistent ? 'Mapa salvo.' : 'Mapa guardado até você fechar o app: este aparelho não deixou gravar dados.');
      setTop();
      drawPanel();
      // a mesma tela passa a ser a do mapa salvo (sem remontar o visualizador)
      if (typeof env.rekey === 'function') env.rekey(`result:${newId}`);
      env.go(`/mapa/ver/${encodeURIComponent(newId)}`, { replace: true });
    } catch (err) {
      console.warn('[mapa] não foi possível salvar', err);
      toast(String((err && err.name === 'MapStoreError' && err.message) || 'Não foi possível salvar o mapa neste aparelho. Ele continua aberto: você pode exportar a imagem.'));
    }
  }

  async function rename() {
    const typed = await promptSheet({ title: 'Renomear o mapa', label: 'Nome do mapa', value: displayName(), confirmLabel: 'Renomear' });
    const name = typed === null ? '' : cleanMapName(typed);
    if (!name || dead || name === S.name) return;
    try {
      if (S.saved && S.id !== null) await storage.rename(S.id, name);
      S.name = name;
      setTop();
      toast('Mapa renomeado.');
    } catch (err) {
      toast(String((err && err.message) || 'Não foi possível renomear o mapa.'));
    }
  }

  async function remove() {
    if (S.saved && S.id !== null) {
      const ok = await confirmDialog({ title: 'Apagar este mapa?', text: `“${displayName()}” será apagado deste aparelho. Não dá para desfazer.`, confirmLabel: 'Apagar', danger: true });
      if (!ok || dead) return;
      const gone = await storage.remove(S.id);
      toast(gone ? 'Mapa apagado.' : 'Não foi possível apagar o mapa.');
      if (gone) env.go('/mapa', { replace: true });
      return;
    }
    const ok = await confirmDialog({ title: 'Descartar este mapa?', text: 'O levantamento que você acabou de fazer será apagado. Não dá para desfazer.', confirmLabel: 'Descartar', danger: true });
    if (!ok || dead) return;
    await storage.draft.clear();
    env.session.result = null;
    toast('Mapa descartado.');
    env.go('/mapa', { replace: true });
  }

  // --- compartilhar --------------------------------------------------------

  async function shareImage() {
    if (!viewer) return;
    try {
      const raw = await viewer.snapshot();
      // mapa da casa virtual: a imagem (e o nome do arquivo) dizem que é demonstração
      const subtitle = S.demo ? 'Demonstração: mapa de uma casa virtual · WiFi Raio-X' : 'Mapa aproximado, feito só com o sinal do Wi-Fi · WiFi Raio-X';
      const blob = await composeShareImage(raw, { name: displayName(), subtitle, dark: store.get().theme === 'dark' }).catch(() => raw);
      const base64 = await blobToBase64(blob);
      const res = await bridge.saveFile({ name: `${demoPrefix()}${fileSlug(displayName())}.png`, mime: 'image/png', base64 });
      if (res && res.ok === false) throw new Error('recusado');
      if (env.isDemo()) toast('Imagem do mapa gerada.');
    } catch (err) {
      console.warn('[mapa] não foi possível gerar a imagem', err);
      toast('Não foi possível gerar a imagem do mapa agora.');
    }
  }

  async function exportFile() {
    if (!S.saved || S.id === null) {
      toast('Salve o mapa antes de exportar o arquivo.', { action: { label: 'Salvar', onClick: save } });
      return;
    }
    try {
      const text = await storage.exportMap(S.id);
      const res = await bridge.saveFile({ name: `${demoPrefix()}${fileSlug(displayName())}.wifi-raio-x.json`, mime: 'application/json', text });
      if (res && res.ok === false) throw new Error('recusado');
      if (env.isDemo()) toast('Arquivo do mapa gerado.');
    } catch (err) {
      console.warn('[mapa] não foi possível exportar', err);
      toast(String((err && err.name === 'MapStoreError' && err.message) || 'Não foi possível exportar o arquivo do mapa.'));
    }
  }

  async function shareText() {
    try {
      const lines = describeMap(S.model);
      const origin = S.demo ? 'Mapa de demonstração (casa virtual, dados simulados).\n\n' : '';
      const res = await bridge.share(displayName(), `${displayName()}\n\n${origin}${lines.join('\n')}\n\nFeito com o WiFi Raio-X.`);
      if (res && res.ok === false) throw new Error('recusado');
    } catch {
      toast('Não foi possível compartilhar agora.');
    }
  }

  function openShare() {
    actionSheet({
      title: 'Compartilhar o mapa',
      actions: [
        usable() ? { icon: 'share', label: 'Imagem do mapa', hint: 'A vista de agora, como PNG', onClick: shareImage } : null,
        { icon: 'file', label: 'Arquivo do mapa', hint: 'Para abrir em outro aparelho com o WiFi Raio-X', onClick: exportFile },
        { icon: 'copy', label: 'Resumo em texto', hint: usable() ? 'Área, ambientes e cobertura em palavras' : 'O que foi medido e por que não saiu um mapa', onClick: shareText },
      ].filter(Boolean),
    });
  }

  // --- refazer o mapa ------------------------------------------------------

  async function rebuildAfterSurveyEdit(survey, { resolve = false, title } = {}) {
    const before = S.model;
    if (resolve) {
      let out;
      try {
        out = await compute(survey, S.own, S.solution, title);
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          console.error('[mapa] não foi possível refazer o mapa', err);
          toast('Não deu para refazer o mapa agora. Nada foi alterado.');
        }
        if (viewer) viewer.resize();
        return false;
      }
      if (dead) return false;
      S.survey = survey;
      S.solution = out.solution;
      S.model = out.model;
    } else {
      S.survey = survey;
      S.model = buildMap(survey, S.solution, { own: S.own });
    }
    V.pick = null;
    if (viewer) viewer.resize();
    applyModel({ keepView: !resolve && !!before });
    drawPanel();
    drawPick();
    await persistEdit();
    return true;
  }

  function openScale() {
    const spots = spotOptions(S.model);
    const why = h(
      'div.prose',
      null,
      h('p', null, `Só com o Wi-Fi, as distâncias do mapa costumam sair um pouco menores que as da casa (uns ${ACCURACY.shrinkPct}%, em média) e podem errar ${ACCURACY.scalePct}% ou mais. Se você informar a `, h('strong', null, 'distância real'), ' entre dois lugares marcados, o mapa inteiro é reajustado por ela.'),
      h('p', null, 'Escolha dois lugares bem distantes um do outro e meça com uma trena, ou conte passos largos (um passo largo ≈ 1 m).'),
    );
    if (spots.length < 2) {
      const panel = sheet({
        title: 'Ajustar a escala',
        content: [why, banner({ tone: 'info', title: 'Faltam lugares marcados', text: 'O ajuste precisa de dois lugares marcados no mapa. Use “Continuar mapeando”, marque dois lugares (por exemplo, as duas pontas do corredor) e volte aqui.' })],
        footer: [
          button('Agora não', { variant: 'secondary', onClick: () => panel.close() }),
          button('Continuar mapeando', {
            variant: 'primary',
            onClick: () => {
              panel.close();
              void continueSurvey();
            },
          }),
        ],
      });
      return;
    }
    // começa pelo par mais distante: quanto maior a distância medida, melhor o ajuste
    let a = spots[0].id;
    let b = spots[1].id;
    let far = -1;
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const d = spotDistance(S.model, spots[i].id, spots[j].id);
        if (d !== null && d > far) {
          far = d;
          a = spots[i].id;
          b = spots[j].id;
        }
      }
    }
    const estimate = h('p.mrs-scale__now', { 'aria-live': 'polite' });
    const error = h('span.field__error', { hidden: true, role: 'alert' });
    const input = h('input.input', { type: 'text', inputmode: 'decimal', placeholder: 'Ex.: 4,5', maxlength: 8, autocomplete: 'off', 'aria-label': 'Distância real em metros' });
    const refresh = () => {
      const d = a === b ? null : spotDistance(S.model, a, b);
      estimate.textContent = a === b ? 'Escolha dois lugares diferentes.' : d === null ? '' : `Hoje o mapa estima ${approxMetersText(d)} entre eles.`;
    };
    const options = spots.map((sp) => ({ value: sp.id, label: sp.label }));
    const submit = async () => {
      const meters = parseMeters(input.value);
      const problem = a === b ? 'Escolha dois lugares diferentes.' : meters === null ? 'Digite a distância em metros, entre 0,5 e 200 (ex.: 4,5).' : null;
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        if (a !== b) input.focus();
        return;
      }
      const next = withKnownDistance(S.survey, a, b, meters);
      if (!next) {
        error.textContent = 'Não foi possível usar estes dois lugares. Escolha outros.';
        error.hidden = false;
        return;
      }
      const areaBefore = mapMeta(S.model, S.survey).areaM2;
      panel.close();
      const ok = await rebuildAfterSurveyEdit(next, { resolve: true, title: 'Ajustando a escala…' });
      if (ok && !dead) {
        const areaAfter = mapMeta(S.model, S.survey).areaM2;
        toast(`Escala ajustada. Área estimada: de ≈${THIN}${fmtNum(areaBefore)} para ≈${THIN}${fmtNum(areaAfter)}${THIN}m².`);
      }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void submit();
      }
    });
    input.addEventListener('input', () => {
      error.hidden = true;
    });
    const known = Array.isArray(S.survey.knownDistances) ? S.survey.knownDistances.length : 0;
    const panel = sheet({
      title: 'Ajustar a escala',
      content: h(
        'div.mrs-scale',
        null,
        why,
        h('label.field', null, h('span.field__label', null, 'De'), select(options, a, (v) => ((a = v), refresh()), { label: 'Primeiro lugar', block: true })),
        h('label.field', null, h('span.field__label', null, 'Até'), select(options, b, (v) => ((b = v), refresh()), { label: 'Segundo lugar', block: true })),
        estimate,
        h('label.field', null, h('span.field__label', null, 'Distância real entre os dois (em metros)'), input, error),
        known
          ? button(known === 1 ? 'Remover o ajuste já feito' : `Remover os ${known} ajustes já feitos`, {
              variant: 'quiet',
              onClick: async () => {
                panel.close();
                const ok = await rebuildAfterSurveyEdit({ ...S.survey, knownDistances: [] }, { resolve: true, title: 'Refazendo o mapa sem o ajuste…' });
                if (ok && !dead) toast('Ajuste de escala removido.');
              },
            })
          : null,
      ),
      footer: [button('Cancelar', { variant: 'secondary', onClick: () => panel.close() }), button('Ajustar', { variant: 'primary', icon: 'ruler', onClick: () => void submit() })],
    });
    refresh();
  }

  async function continueSurvey() {
    // um mapa da casa virtual não continua com o Wi-Fi de verdade (nem o contrário): as leituras
    // dos dois se misturariam num mapa só
    if (!matchesMode(S, env.isDemo())) {
      const locked = !!(ctx.app && ctx.app.demoLocked);
      toast(
        isDemoOrigin(S)
          ? 'Este mapa é da demonstração. Para continuar o mapeamento dele, ligue o modo demonstração nos Ajustes.'
          : locked
            ? 'Este mapa foi feito com o Wi-Fi de verdade. Só dá para continuar o mapeamento dele no celular, fora da demonstração.'
            : 'Este mapa foi feito com o Wi-Fi de verdade. Para continuar o mapeamento dele, saia da demonstração.',
      );
      return;
    }
    if (S.saved) {
      const draft = await storage.draft.load();
      if (dead) return;
      if (draft && draft.recorder && draft.recordId !== S.id) {
        const ok = await confirmDialog({ title: 'Continuar este mapa?', text: 'Há outro mapeamento em andamento guardado como rascunho. Ele será descartado.', confirmLabel: 'Descartar o rascunho e continuar', danger: true });
        if (!ok || dead) return;
      }
      await storage.draft.save({ v: 1, recorder: S.survey, ownSsids: S.ownSsids, extraOwn: S.own, recordId: S.id, name: S.name, demo: S.demo, savedAt: Date.now(), summary: { scans: S.survey.scans.length, spots: mapMeta(S.model, S.survey).spots } });
    }
    env.session.start = null;
    env.session.result = null;
    env.go('/mapa/novo');
  }

  async function renameRoomFlow(pick) {
    const room = pick.room;
    if (!room) return;
    const typed = await promptSheet({
      title: 'Nome do ambiente',
      subtitle: room.auto ? 'Esta parte do mapa está sem nome: nenhum lugar marcado por perto tem um. Que cômodo fica no meio dela?' : 'Todos os lugares marcados com este nome mudam junto.',
      label: 'Nome do ambiente',
      value: room.auto ? '' : room.label,
      placeholder: 'Ex.: Sala',
      maxLength: 40,
      confirmLabel: 'Renomear',
    });
    if (typed === null || dead) return;
    const next = renameRoom(S.survey, S.model, pick.floorIndex, room.id, typed);
    if (!next) {
      toast('Não foi possível dar nome a este ambiente: não há leituras dentro dele.');
      return;
    }
    await rebuildAfterSurveyEdit(next, { resolve: false });
    if (!dead) toast('Ambiente renomeado.');
  }

  // --- cartão do toque -----------------------------------------------------

  function signalRows(valueOf) {
    const nets = [];
    for (const c of choices()) if (c.kind === 'own' || (c.kind === 'other' && c.key === V.show)) nets.push(c);
    if (!nets.length && choices()[1]) nets.push(choices()[1]);
    const rows = nets.slice(0, 4).map((c) => {
      const dbm = valueOf(c.key);
      return h('li.mrs-pick__sig', null, h('span.mrs-pick__net', null, icon('wifi', { size: 16 }), h('span.ssid', { dir: 'auto' }, c.label)), h('span.mrs-pick__val', null, Number.isFinite(dbm) ? `${approxDbm(dbm)} · ${signalWordAt(dbm)}` : 'sem medição'));
    });
    return rows.length ? h('ul.mrs-pick__sigs', null, rows) : null;
  }

  function pickContent(pick) {
    const model = S.model;
    const multi = multiFloor();
    const floorText = multi && Number.isFinite(pick.floor) ? floorName(pick.floor) : null;
    if (pick.kind === 'router' && pick.ap) {
      const ap = pick.ap;
      const conf = ap.conf >= 0.6 ? 'boa' : ap.conf >= 0.3 ? 'média' : 'baixa';
      const where = ap.inside ? `${approxMetersText(ap.distanceM)} do centro do mapa` : `${approxMetersText(ap.distanceM)} do centro, fora da área por onde você andou`;
      return {
        title: h('span.ssid', { dir: 'auto' }, displaySsid(ap.ssid)),
        badge: ap.own ? badge('Seu roteador', { tone: 'accent', icon: 'router' }) : badge('Vizinho', { icon: 'router' }),
        body: [
          h('dl.mrs-pick__facts', null, h('div', null, h('dt', null, 'Distância estimada'), h('dd', null, where)), Number.isFinite(ap.bestRssi) ? h('div', null, h('dt', null, 'Sinal mais forte medido'), h('dd', null, `${fmtDbm(ap.bestRssi)} · ${signalWordAt(ap.bestRssi)}`)) : null, multi && ap.floor !== null ? h('div', null, h('dt', null, 'Andar provável'), h('dd', null, floorName(ap.floor))) : null, h('div', null, h('dt', null, 'Confiança da posição'), h('dd', null, conf))),
          h('p.mrs-pick__note', null, ap.inside ? 'A posição do roteador é uma estimativa a partir de como o sinal dele muda pela casa.' : 'Para roteadores fora da área andada, o mapa indica só a direção aproximada.'),
        ],
      };
    }
    if (pick.kind === 'spot' && pick.spot) {
      const sp = pick.spot;
      const fi = model.floors.findIndex((f) => f.floor === sp.floor);
      const cellOf = () => {
        const ix = Math.floor((sp.x - model.bounds.minX) / model.cell);
        const iy = Math.floor((sp.y - model.bounds.minY) / model.cell);
        return ix >= 0 && iy >= 0 && ix < model.nx && iy < model.ny ? iy * model.nx + ix : -1;
      };
      const c = cellOf();
      return {
        title: sp.label ? h('span', { dir: 'auto' }, sp.label) : 'Lugar marcado sem nome',
        badge: badge('Lugar marcado', { icon: 'pin' }),
        body: [h('p.mrs-pick__line', null, [plural(sp.scans, 'leitura feita aqui', 'leituras feitas aqui'), floorText].filter(Boolean).join(' · ')), fi >= 0 && c >= 0 ? signalRows((key) => heatField(model, fi, key).dbm[c]) : null],
      };
    }
    // ambiente (ou um ponto do piso, com o mapa de sinal ligado)
    const room = pick.room || null;
    const fi = pick.floorIndex;
    const roomIndex = room ? model.floors[fi].rooms.indexOf(room) : -1;
    const here = pick.kind === 'cell' && Number.isFinite(pick.dbm) && netByKey(V.show) ? h('p.mrs-pick__here', null, 'Neste ponto: ', h('strong', null, `${approxDbm(pick.dbm)} · ${signalWordAt(pick.dbm)}`)) : null;
    // andar sem divisão em ambientes (menos de dois lugares com nome): o toque cai na área inteira
    const plain = !room && model.floors[fi] && !model.floors[fi].rooms.length;
    return {
      title: room ? h('span', { dir: 'auto' }, room.label) : plain ? 'Área mapeada' : 'Trecho sem ambiente',
      badge: room && room.auto ? badge('Nome automático') : null,
      edit: room ? () => renameRoomFlow(pick) : null,
      body: [
        h('p.mrs-pick__line', null, [room && room.areaM2 > 0 ? `Área ≈${THIN}${fmtNum(Math.max(1, Math.round(room.areaM2)))}${THIN}m²` : null, floorText].filter(Boolean).join(' · ') || (plain ? 'Sem divisão em ambientes: faltam dois lugares com nomes diferentes neste andar.' : 'Área aproximada')),
        here,
        room && roomIndex >= 0 ? h('p.mrs-pick__sub', null, 'Sinal médio neste ambiente:') : null,
        room && roomIndex >= 0 ? signalRows((key) => roomSignal(model, fi, roomIndex, heatField(model, fi, key))) : null,
      ],
    };
  }

  function drawPick() {
    if (dead) return;
    if (!usable()) {
      // no lugar do desenho: por que não há mapa e o que fazer
      const q = qualityInfo(S.model.quality);
      patch(
        floatEl,
        h(
          'article.mrs-pick.mrs-nomap',
          { key: 'nomap', role: 'status' },
          h('div.mrs-nomap__head', null, icon('warning', { size: 22 }), h('h3.mrs-pick__title', null, 'Não deu para montar um mapa')),
          h('p.mrs-nomap__text', null, q.text),
          h('p.mrs-pick__note', null, 'As leituras continuam guardadas: dá para continuar este mapeamento de onde parou.'),
          h('div.mrs-nomap__actions', null, button('Continuar mapeando', { variant: 'primary', icon: 'walk', onClick: () => void continueSurvey() })),
        ),
      );
      return;
    }
    const pick = V.pick;
    if (!pick) {
      patch(floatEl, viewerNote ? h('p.mrs__note', { key: 'note' }, icon('info', { size: 16 }), viewerNote) : null);
      return;
    }
    let content = null;
    try {
      content = pickContent(pick);
    } catch (err) {
      console.warn('[mapa] toque sem detalhes', err);
    }
    if (!content) {
      V.pick = null;
      patch(floatEl);
      return;
    }
    patch(
      floatEl,
      h(
        'article.mrs-pick',
        { key: 'pick', 'aria-live': 'polite' },
        h(
          'header.mrs-pick__head',
          null,
          h('div.mrs-pick__titles', null, h('h3.mrs-pick__title', null, content.title), content.badge),
          content.edit ? iconButton('edit', 'Renomear este ambiente', content.edit, { muted: true }) : null,
          iconButton(
            'close',
            'Fechar detalhes',
            () => {
              V.pick = null;
              drawPick();
            },
            { muted: true },
          ),
        ),
        content.body,
      ),
    );
  }

  // --- painel --------------------------------------------------------------

  function legend() {
    if (V.show === 'rooms') {
      return hasRooms(S.model)
        ? h('p.mrs-legend.mrs-legend--text', { key: 'legend' }, 'Cada cor é um ambiente estimado. Toque num ambiente, roteador ou lugar marcado para ver os detalhes.')
        : h('p.mrs-legend.mrs-legend--text', { key: 'legend' }, 'A área por onde você andou, sem divisão em ambientes (nenhum lugar, ou só um, tem nome). Escolha uma rede acima para ver o sinal.');
    }
    const theme = store.get().theme;
    const scale = signalScale(theme);
    const pos = (dbm) => `${Math.max(0, Math.min(100, ((dbm - LEGEND_MIN) / (LEGEND_MAX - LEGEND_MIN)) * 100)).toFixed(1)}%`;
    const breaks = [...SIGNAL_BREAKS_DBM].sort((a, b) => a - b); // da esquerda (fraco) para a direita (forte), como a barra
    return h(
      'div.mrs-legend',
      { key: 'legend', role: 'img', 'aria-label': `Legenda do sinal: ${scale.map((b) => b.label).join(', ')}, do mais forte ao mais fraco; as divisas ficam em ${SIGNAL_BREAKS_DBM.join(', ')} dBm` },
      h('div.mrs-legend__ticks', { 'aria-hidden': 'true' }, breaks.map((d) => h('span', { style: { left: pos(d) } }, fmtDbm(d, { unit: false }))), h('span.mrs-legend__unit', null, 'dBm')),
      h('div.mrs-legend__bar', { style: { backgroundImage: signalGradientCss(theme, { min: LEGEND_MIN, max: LEGEND_MAX }) } }, breaks.map((d) => h('i', { style: { left: pos(d) } }))),
      h(
        'div.mrs-legend__words',
        { 'aria-hidden': 'true' },
        scale
          .slice()
          .reverse()
          .map((b) => h('span', null, b.label)),
      ),
    );
  }

  function coverageCard(net) {
    const cov = coverage(S.model, net.key);
    const parts = coverageParts(cov);
    const multi = multiFloor();
    const zones = deadZoneLines(cov, { multiFloor: multi });
    const spot = (place) => (place && Number.isFinite(place.dbm) ? `${placeText(place, multi)} (${approxDbm(place.dbm)})` : null);
    const best = spot(cov.best);
    const worst = spot(cov.worst);
    return h(
      'section.card.mrs-card',
      { key: 'cov' },
      h('h3.card__title', null, 'Cobertura · ', h('span.ssid', { dir: 'auto' }, displaySsid(net.ssid))),
      h('p.mrs-card__sub', null, 'Quanto da área por onde você andou tem cada nível de sinal (estimativa).'),
      h(
        'div.mrs-cov__bar',
        { role: 'img', 'aria-label': parts.map((p) => `${p.label}: ${p.pct}%`).join('; ') },
        parts.filter((p) => p.pct > 0).map((p) => h('i', { class: `mrs-cov--${p.key}`, style: { flexGrow: String(p.pct) } })),
      ),
      h(
        'ul.mrs-cov__list',
        null,
        parts.map((p) => h('li', null, h('i', { class: `mrs-cov__dot mrs-cov--${p.key}` }), h('span.mrs-cov__name', null, p.label, h('small', null, p.range)), h('strong', null, `${p.pct}%`))),
      ),
      zones.length
        ? h(
            'ul.mrs-zones',
            null,
            zones.map((z) => h('li', null, icon('warning', { size: 18 }), h('span', { dir: 'auto' }, z.text))),
          )
        : h('p.mrs-zones__none', null, icon('check-circle', { size: 18 }), 'Nenhum trecho sem sinal útil por onde você andou.'),
      best || worst ? h('dl.mrs-extremes', null, best ? h('div', null, h('dt', null, 'Melhor lugar'), h('dd', { dir: 'auto' }, best)) : null, worst ? h('div', null, h('dt', null, 'Pior lugar'), h('dd', { dir: 'auto' }, worst)) : null) : null,
    );
  }

  /** "Como este mapa é feito": os números são os da bancada (ACCURACY em map-ui-logic.js). */
  function howCard() {
    const [errLo, errHi] = ACCURACY.homeErrorM;
    const [roomHit, roomOf] = ACCURACY.rightRoom;
    const [roomHit2, roomOf2] = ACCURACY.rightRoomTwoFloors;
    return h(
      'section.card.mrs-card',
      { key: 'how' },
      h('h3.card__title', null, 'Como este mapa é feito'),
      h(
        'div.prose',
        null,
        h('p', null, h('strong', null, 'Só com o Wi-Fi. '), 'Em cada canto da casa o celular ouve os roteadores (o seu e os dos vizinhos) com uma força diferente. O app compara essas leituras para estimar onde cada uma foi feita e desenha a área por onde você andou.'),
        h(
          'p',
          null,
          h('strong', null, 'Por que é aproximado. '),
          `O sinal muda com paredes, móveis e até com o seu corpo. Em casas e apartamentos simulados, cada posição erra tipicamente de ${errLo} a ${errHi} metros (perto de ${fmtNum(ACCURACY.largeErrorM, 1)}${THIN}m num lugar grande, como um escritório), e cerca de ${roomHit} em cada ${roomOf} leituras caem no cômodo certo (${roomHit2} em cada ${roomOf2} numa casa de dois andares). As divisões entre ambientes são estimativas, não paredes medidas.`,
        ),
        h(
          'p',
          null,
          h('strong', null, 'O tamanho. '),
          `As distâncias em metros são a parte mais fraca: saem em média uns ${ACCURACY.shrinkPct}% menores que as reais e podem errar ${ACCURACY.scalePct}% ou mais, sobretudo em lugares grandes. A área do desenho compensa esse efeito na média, não em cada mapa: numa casa pequena costuma sair uns ${ACCURACY.smallAreaOverPct}% maior que a real, e num lugar grande, bem menor. Para acertar as distâncias, meça uma de verdade em “Ajustar a escala”.`,
        ),
        h('p', null, h('strong', null, 'Por que pode sair girado ou espelhado. '), 'O Wi-Fi não sabe onde fica o norte nem o que é esquerda ou direita. Gire o mapa com o dedo até reconhecer a casa. Os andares são os que você marcou.'),
        h(
          'p',
          null,
          h('strong', null, 'Ambientes só com nomes. '),
          `O mapa só é dividido em ambientes quando você marca pelo menos dois lugares com nomes diferentes no mesmo andar. Sem nomes, as divisões sairiam quase ao acaso, e o app prefere não inventar. Cada nome vale perto de onde foi dado: a parte da casa sem nenhum lugar com nome por perto aparece como “Ambiente”, sem divisões. Com todos os cômodos marcados, uns ${ACCURACY.namedAreaPct[0]} a ${ACCURACY.namedAreaPct[1]}% da área de cada ambiente são mesmo do cômodo daquele nome; com só alguns marcados, perto de ${ACCURACY.namedAreaPartialPct}%.`,
        ),
      ),
    );
  }

  function saveCard() {
    return !S.saved
      ? h(
          'section.card.card--accent.mrs-card.mrs-save',
          { key: 'save' },
          h('div', null, h('h3.card__title', null, S.id !== null ? 'Mapa atualizado, ainda não salvo' : 'Este mapa ainda não foi salvo'), h('p.mrs-card__sub', null, 'O levantamento está guardado como rascunho. Salve para o mapa aparecer na sua lista.')),
          button('Salvar', { variant: 'primary', icon: 'save', onClick: save }),
        )
      : null;
  }

  function actionsBlock() {
    return h(
      'section.mrs-block.mrs-actions',
      { key: 'actions' },
      h('h3.mrs-block__title', null, 'Ações'),
      h(
        'div.mrs-actions__list',
        null,
        S.saved ? button('Renomear', { icon: 'edit', onClick: rename }) : button('Salvar o mapa', { icon: 'save', variant: 'primary', onClick: save }),
        usable() ? button('Imagem do mapa', { icon: 'share', onClick: shareImage }) : null,
        button('Exportar arquivo', { icon: 'file', onClick: exportFile }),
        button(S.saved ? 'Apagar mapa' : 'Descartar', { icon: 'trash', variant: 'danger-quiet', onClick: remove }),
      ),
    );
  }

  /** Levantamento de que não saiu mapa: o painel fica só com o motivo, o que fazer e as ações. */
  function drawPanelNoMap() {
    const q = qualityInfo(S.model.quality);
    const meta = mapMeta(S.model, S.survey);
    patch(quickEl, h('p.mrs-legend.mrs-legend--text', { key: 'legend' }, 'Deste levantamento não saiu um mapa. Veja abaixo o motivo e o que fazer.'));
    patch(
      moreEl,
      saveCard(),
      h(
        'section.card.mrs-card',
        { key: 'quality' },
        h('div.mrs-card__head', null, h('h3.card__title', null, 'Por que não há mapa'), badge(q.label, { tone: QUALITY_TONE[q.tone] })),
        h('p.mrs-card__text', null, q.text),
        h('ul.mrs-facts', null, h('li', null, icon('route', { size: 18 }), `${plural(meta.scans, 'leitura', 'leituras')} · ${plural(meta.spots, 'lugar marcado', 'lugares marcados')} · ${plural(S.model.quality.aps || 0, 'roteador ouvido', 'roteadores ouvidos')}`)),
        q.notes.length ? h('div.mrs-notes', null, h('h4.mrs-notes__title', null, 'Também ajuda'), h('ul', null, q.notes.map((n) => h('li', null, n)))) : null,
        h('div.mrs-card__actions', null, button('Continuar mapeando', { icon: 'walk', variant: 'primary', onClick: () => void continueSurvey() })),
      ),
      howCard(),
      actionsBlock(),
    );
  }

  function drawPanel() {
    if (dead) return;
    syncHandle();
    if (!usable()) {
      drawPanelNoMap();
      return;
    }
    const model = S.model;
    const opts = choices();
    const net = focusNet();
    const multi = multiFloor();
    const is2d = !!viewer && viewer.kind === '2d';
    const q = qualityInfo(model.quality);
    const meta = mapMeta(model, S.survey);
    let tip = null;
    try {
      tip = net ? suggestRouterSpot(model, net.key) : null;
    } catch {
      tip = null;
    }
    const firstOther = opts.findIndex((o) => o.kind === 'other');

    patch(
      quickEl,
      h(
        'div.mrs-show',
        { key: 'show' },
        h('span.mrs-show__label', { id: 'mrs-show-label' }, 'Mostrar'),
        h(
          'div.chips.chips--scroll.mrs-show__chips',
          { role: 'group', 'aria-labelledby': 'mrs-show-label' },
          opts.map((o, i) => [
            i === firstOther ? h('span.mrs-show__sep', { key: 'sep', 'aria-hidden': 'true' }, 'Vizinhas') : null,
            h(
              'button.chip',
              {
                key: `show-${o.key}`,
                type: 'button',
                'aria-pressed': String(V.show === o.key),
                class: o.kind === 'other' ? 'mrs-show__other' : null,
                dataset: { show: o.kind },
                onClick: () => {
                  if (V.show === o.key) return;
                  V.show = o.key;
                  V.pick = null;
                  applyHeat();
                  drawPanel();
                  drawPick();
                  measurePad();
                },
              },
              o.kind === 'rooms' ? icon('layers', { size: 16 }) : icon('wifi', { size: 16 }),
              h('span', { dir: 'auto' }, o.label),
            ),
          ]),
        ),
      ),
      legend(),
      h(
        'div.mrs-tools',
        { key: 'tools' },
        is2d
          ? h('span.mrs-tools__flat', null, icon('grid', { size: 18 }), 'Vista em planta')
          : h(
              'div.seg.seg--inline.mrs-tools__view',
              { role: 'radiogroup', 'aria-label': 'Vista do mapa' },
              [
                ['orbit', '3D', 'cube'],
                ['top', 'Planta', 'grid'],
              ].map(([value, label, ic]) =>
                h(
                  'button.seg__opt',
                  {
                    type: 'button',
                    role: 'radio',
                    'aria-checked': String(V.view === value),
                    tabIndex: V.view === value ? 0 : -1,
                    onClick: () => {
                      if (V.view === value) return;
                      V.view = value;
                      viewer.setView(value);
                      drawPanel();
                    },
                  },
                  icon(ic, { size: 18 }),
                  label,
                ),
              ),
            ),
        is2d
          ? null
          : h(
              'button.chip.mrs-tools__relief',
              {
                type: 'button',
                'aria-pressed': String(V.relief && V.show !== 'rooms'),
                disabled: V.show === 'rooms',
                title: V.show === 'rooms' ? 'Escolha uma rede em “Mostrar” para ver o relevo do sinal' : undefined,
                onClick: () => {
                  V.relief = !V.relief;
                  applyHeat();
                  drawPanel();
                },
              },
              icon('signal', { size: 16 }),
              h('span', null, 'Relevo', h('span.mrs-tools__relief-long', null, ' do sinal')),
            ),
        iconButton('target', 'Recentralizar o mapa', () => viewer.resetView(), { class: 'icon-btn mrs-tools__reset' }),
      ),
      multi
        ? h(
            'div.mrs-floors',
            { key: 'floors' },
            h('span.mrs-show__label', { id: 'mrs-floor-label' }, 'Andar'),
            h(
              'div.chips.chips--scroll',
              { role: 'group', 'aria-labelledby': 'mrs-floor-label' },
              [{ floor: null, label: 'Todos' }, ...model.floors.map((f) => ({ floor: f.floor, label: floorName(f.floor) }))].map((f) =>
                h(
                  'button.chip',
                  {
                    type: 'button',
                    'aria-pressed': String(V.floor === f.floor),
                    onClick: () => {
                      V.floor = f.floor;
                      viewer.setFocusFloor(f.floor);
                      drawPanel();
                    },
                  },
                  f.label,
                ),
              ),
            ),
          )
        : null,
    );

    const invite = roomsInvite(model);
    patch(
      moreEl,
      saveCard(),
      // sem lugares com nome o mapa não tem ambientes: o convite para marcá-los vem antes de tudo
      invite
        ? h(
            'section.card.mrs-card.mrs-invite',
            { key: 'invite' },
            h('h3.card__title', null, icon('pin', { size: 18 }), invite.title),
            h('p.mrs-card__text', null, invite.text),
            h('div.mrs-card__actions', null, button('Continuar mapeando', { icon: 'walk', variant: invite.all ? 'primary' : 'secondary', onClick: () => void continueSurvey() })),
          )
        : null,
      h(
        'section.mrs-block',
        { key: 'layers' },
        h('h3.mrs-block__title', { id: 'mrs-layers-label' }, 'Camadas'),
        h(
          'div.chips',
          { role: 'group', 'aria-labelledby': 'mrs-layers-label' },
          LAYERS.map(([key, label]) =>
            h(
              'button.chip',
              {
                type: 'button',
                'aria-pressed': String(!!V.layers[key]),
                dataset: { layer: key },
                onClick: () => {
                  V.layers[key] = !V.layers[key];
                  viewer.setLayers({ [key]: V.layers[key] });
                  drawPanel();
                },
              },
              V.layers[key] ? icon('check', { size: 16 }) : null,
              label,
            ),
          ),
        ),
      ),
      multi && !is2d
        ? h(
            'section.mrs-block',
            { key: 'explode' },
            h('h3.mrs-block__title', null, 'Separar andares'),
            slider({
              min: 0,
              max: 100,
              step: 5,
              value: Math.round(V.explode * 100),
              label: 'Separar andares',
              onInput: (v) => {
                V.explode = v / 100;
                viewer.setExplode(V.explode);
              },
            }),
          )
        : null,
      net ? coverageCard(net) : null,
      tip && tip.gainText ? h('section.card.mrs-card.mrs-tip', { key: 'tip' }, h('h3.card__title', null, icon('sparkle', { size: 18 }), tip.currentIsCentral ? 'O roteador está bem colocado' : 'Sugestão para o roteador'), h('p.mrs-card__text', { dir: 'auto' }, tip.gainText)) : null,
      h(
        'section.card.mrs-card',
        { key: 'quality' },
        h('div.mrs-card__head', null, h('h3.card__title', null, 'Qualidade do mapa'), badge(q.label, { tone: QUALITY_TONE[q.tone] })),
        h('p.mrs-card__text', null, q.text),
        h(
          'ul.mrs-facts',
          null,
          h('li', null, icon('target', { size: 18 }), q.errorText),
          h('li', null, icon('ruler', { size: 18 }), q.scaleText),
          h('li', null, icon('route', { size: 18 }), `${plural(meta.scans, 'leitura', 'leituras')} · ${plural(meta.spots, 'lugar marcado', 'lugares marcados')} · ≈${THIN}${fmtNum(meta.areaM2)}${THIN}m²`),
        ),
        q.notes.length ? h('div.mrs-notes', null, h('h4.mrs-notes__title', null, 'Como melhorar'), h('ul', null, q.notes.map((n) => h('li', null, n)))) : null,
        h('div.mrs-card__actions', null, button('Ajustar a escala', { icon: 'ruler', onClick: openScale }), button('Continuar mapeando', { icon: 'walk', onClick: () => void continueSurvey() })),
      ),
      howCard(),
      actionsBlock(),
    );
  }

  function syncHandle() {
    handleLabel.textContent = V.open ? 'Fechar os detalhes' : usable() ? 'Cobertura, qualidade e ações' : 'O motivo e as ações';
  }

  function setOpen(open) {
    V.open = !!open;
    panelEl.dataset.open = String(V.open);
    el.classList.toggle('mrs--open', V.open);
    handle.setAttribute('aria-expanded', String(V.open));
    syncHandle();
    handleIcon.replaceChildren(icon(V.open ? 'chevron-down' : 'chevron-up', { size: 18 }));
    if (!V.open) moreEl.scrollTop = 0;
  }

  function setTop() {
    ctx.setTitle(displayName());
    ctx.setActions(iconButton('share', 'Compartilhar ou exportar o mapa', openShare));
    saveFab.hidden = S.saved;
    el.classList.toggle('mrs--unsaved', !S.saved);
  }

  // --- partida -------------------------------------------------------------

  loadingEl.remove();
  el.hidden = false;
  setOpen(false);
  setTop();
  drawPanel();
  try {
    createTheViewer();
  } catch (err) {
    console.error('[mapa] o visualizador não pôde ser criado', err);
    viewer = null;
    viewerNote = 'Este aparelho não conseguiu desenhar o mapa. Os detalhes continuam no painel abaixo.';
  }
  measurePad();
  if (viewer) {
    viewer.setLayers({ ...V.layers, relief: false });
    applyModel();
    if (viewer.kind === '2d' && !viewerNote) viewerNote = 'Este aparelho não desenha em 3D: o mapa aparece em planta.';
  }
  drawPanel();
  drawPick();
  measurePad();

  // Mapa salvo sem miniatura (um mapa importado chega sem: a imagem do arquivo nunca é aproveitada):
  // faz a miniatura aqui, com o desenho deste aparelho, para o cartão da biblioteca ganhar a foto.
  if (S.saved && S.id !== null && !S.thumb && viewer && usable()) {
    const thumbTimer = setTimeout(async () => {
      if (dead || S.thumb || !S.saved) return;
      const thumb = await snapshotThumb();
      if (dead || !thumb || S.thumb) return;
      if (await storage.setThumb(S.id, thumb)) S.thumb = thumb;
    }, 1200);
    offs.push(() => clearTimeout(thumbTimer));
  }

  // puxar ou tocar na alça abre e fecha o painel
  let drag = null;
  handle.addEventListener('pointerdown', (ev) => {
    drag = { y: ev.clientY, moved: false };
  });
  handle.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dy = ev.clientY - drag.y;
    if (Math.abs(dy) > 28 && !drag.moved) {
      drag.moved = true;
      setOpen(dy < 0);
    }
  });
  const endDrag = () => {
    setTimeout(() => {
      drag = null;
    }, 0);
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('click', () => {
    if (drag && drag.moved) return;
    setOpen(!V.open);
  });

  offs.push(
    store.subscribe(
      (st) => st.theme,
      (theme) => {
        if (viewer) viewer.setTheme(theme);
        drawPanel();
      },
    ),
  );
  let resizeRaf = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => !dead && measurePad());
  };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    ro.observe(quickEl);
    offs.push(() => ro.disconnect());
  } else {
    window.addEventListener('resize', onResize);
    offs.push(() => window.removeEventListener('resize', onResize));
  }
  offs.push(
    ctx.onBack(() => {
      if (dead) return false;
      if (V.open) {
        setOpen(false);
        return true;
      }
      if (V.pick) {
        V.pick = null;
        drawPick();
        return true;
      }
      // do resultado volta-se direto para a lista (e não para "#/mapa/ver")
      if (!S.saved) toast('O mapa não foi salvo: o levantamento continua guardado como rascunho.');
      env.go('/mapa', { replace: true });
      return true;
    }),
  );

  return {
    /** A rota mudou sem trocar de parte (ex.: o mapa acabou de ganhar um id): a moldura repôs o título. */
    onShow() {
      if (!dead) setTop();
    },
    unmount() {
      if (dead) return;
      dead = true;
      cancelAnimationFrame(resizeRaf);
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch {
          // segue limpando
        }
      }
      if (viewer) viewer.destroy();
      viewer = null;
    },
  };
}
