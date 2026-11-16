// Mapa 3D — levantamento (#/mapa/novo): a caminhada com as leituras do Wi-Fi.
//
//   mountSurvey(root, env) -> Promise<{ unmount() }>
//       Começa um levantamento novo (env.session.start, vindo do painel "Antes de começar") ou
//       continua o rascunho guardado. Enquanto a tela está aberta:
//         - o gravador (mapping/recorder.js) recebe os eventos 'scan' e 'rssi' da ponte e, quando
//           o celular e um roteador sabem medir distância, o resultado de bridge.rtt;
//         - a tela fica ligada (bridge.keepAwake) e as buscas vão para o ritmo de mapeamento
//           (scanLoop.setMode('mapping')); os dois voltam ao normal ao sair;
//         - a cada poucas leituras o motor (mapping/engine.js) refaz uma prévia rápida do mapa,
//           sem travar a tela, e o visualizador a mostra;
//         - o rascunho é guardado sozinho (storage.draft): sair da tela ou um travamento do app
//           não perde nada, e o "voltar" do Android pergunta antes de sair.
//       "Concluir" roda o cálculo completo, deixa o resultado em env.session.result e abre
//       #/mapa/ver/novo.
//
//   processingView({ title, onCancel }) -> { el, set(fração, etapa) }
//       a tela calma de "montando o mapa", usada aqui e pelo resultado (ajuste de escala).
//
// Na demonstração: a planta de verdade da casa virtual aparece num canto (mini-plan.js) e o
// piloto automático (mapping/demo-pilot.js) pode conduzir tudo sozinho.

import { h, s, patch, sheet, toast, confirmDialog, plural } from '../dom.js';
import { icon } from '../icons.js';
import { button, iconButton, banner, openThrottleHelp, throttleCopy, errorState } from '../components.js';
import { createRecorder, recorderFromJSON, SURVEY_THRESHOLDS } from '../../mapping/recorder.js';
import { createViewer } from './viewer3d.js';
import { createMiniPlan } from './mini-plan.js';
import { actionSheet, defaultOwnSsids } from './library.js';
import { roomChips, cleanLabel, floorName, clampFloor, FLOOR_MIN, FLOOR_MAX, levelInfo, fmtTimer, pulseInfo, previewDue, ownBssidsFor, rttTargets, finishBlocker, isDemoOrigin, matchesMode, surveyTips, pointByPointNote, radarInfo, spotCounter } from './map-ui-logic.js';

const TICK_MS = 500;
const AUTOSAVE_MS = 10_000;
const AUTOSAVE_SCANS = 3;
const RTT_EVERY_MS = 6000;
const PREVIEW_MIN_SCANS = 5;
const RING_R = 19;
const RING_C = 2 * Math.PI * RING_R;

// ---------------------------------------------------------------------------
// "Montando o mapa"
// ---------------------------------------------------------------------------

/**
 * Tela calma de progresso, com as etapas que o motor informa e um botão de cancelar.
 * @param {{title?:string, text?:string, onCancel?:() => void, cancelLabel?:string}} [o]
 */
export function processingView({ title = 'Montando o mapa…', text = 'Tudo é calculado aqui no celular. Costuma levar poucos segundos.', onCancel, cancelLabel = 'Cancelar' } = {}) {
  const stage = h('p.mproc__stage', { 'aria-live': 'polite' }, 'Preparando as leituras…');
  const fill = h('span.meter__fill', { style: { width: '4%' } });
  const bar = h('span.meter.mproc__bar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 4, 'aria-label': 'Progresso do cálculo do mapa' }, fill);
  const el = h(
    'div.mproc',
    null,
    h('div.mproc__art', { 'aria-hidden': 'true' }, h('span.mproc__ring'), h('span.mproc__ring'), h('span.mproc__ring'), h('span.mproc__core', null, icon('cube', { size: 32 }))),
    h('h2.mproc__title', null, title),
    stage,
    bar,
    h('p.mproc__note', null, text),
    onCancel ? button(cancelLabel, { variant: 'quiet', onClick: onCancel }) : null,
  );
  let shown = 0.04;
  return {
    el,
    /** @param {number} fraction 0..1  @param {string} [label] etapa em palavras */
    set(fraction, label) {
      if (typeof fraction === 'number' && Number.isFinite(fraction)) {
        // a barra nunca anda para trás (as etapas do motor podem se sobrepor)
        shown = Math.max(shown, Math.min(1, fraction));
        fill.style.width = `${Math.round(shown * 100)}%`;
        bar.setAttribute('aria-valuenow', String(Math.round(shown * 100)));
      }
      if (typeof label === 'string' && label.trim()) {
        const textNow = /[.…!]$/.test(label.trim()) ? label.trim() : `${label.trim()}…`;
        if (stage.textContent !== textNow) stage.textContent = textNow;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Peças
// ---------------------------------------------------------------------------

function ring(fraction, center, tone) {
  const f = Math.max(0, Math.min(1, fraction || 0));
  return h(
    'span',
    { class: ['msv-ring', tone && `msv-ring--${tone}`], 'aria-hidden': 'true' },
    s(
      'svg',
      { viewBox: '0 0 44 44', width: 44, height: 44 },
      s('circle', { class: 'msv-ring__track', cx: 22, cy: 22, r: RING_R, fill: 'none', 'stroke-width': 3 }),
      s('circle', {
        class: 'msv-ring__value',
        cx: 22,
        cy: 22,
        r: RING_R,
        fill: 'none',
        'stroke-width': 3,
        'stroke-linecap': 'round',
        'stroke-dasharray': RING_C.toFixed(2),
        'stroke-dashoffset': (RING_C * (1 - f)).toFixed(2),
        transform: 'rotate(-90 22 22)',
      }),
    ),
    h('span.msv-ring__center', null, center),
  );
}

function levelMeter(info) {
  return h(
    'span.msv-level__bar',
    { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': info.steps, 'aria-valuenow': info.index, 'aria-label': `Progresso do mapeamento: ${info.label}` },
    Array.from({ length: info.steps }, (_, i) => h('i', { class: i < info.index ? `is-on is-${info.tone}` : null })),
  );
}

/** Um contador; `of` ("de 12") vai ao lado do número, menor (o número sozinho continua em .msv-count__value). */
function counter(label, value, key, of) {
  const number = h('span.msv-count__value', null, value);
  return h('div.msv-count', { key }, of ? h('span.msv-count__top', null, number, h('span.msv-count__of', null, ` ${of}`)) : number, h('span.msv-count__label', null, label));
}

// As dicas saem de map-ui-logic.js (surveyTips): andando sem parar e ponto a ponto pedem
// instruções diferentes, e o limite do Android pode ligar ou desligar com a tela aberta.
function openTips(ctx, throttled) {
  const lift = throttleCopy(ctx.store);
  const note = pointByPointNote({ during: true, canLift: lift.canLift });
  const panel = sheet({
    title: 'Como fazer um bom mapa',
    content: h(
      'div.map-start',
      null,
      throttled
        ? banner({
            tone: 'warning',
            icon: 'clock',
            title: note.title,
            text: note.text,
            actions: lift.canLift ? [{ label: 'Como liberar buscas rápidas', onClick: () => openThrottleHelp(ctx) }] : undefined,
          })
        : null,
      h(
        'ol.map-tips',
        null,
        surveyTips({ throttled: !!throttled, during: true }, SURVEY_THRESHOLDS).map((tip) => h('li.map-tip', null, h('span.map-tip__icon', null, icon(tip.icon)), h('div.map-tip__body', null, h('strong', null, tip.title), h('span', null, tip.text)))),
      ),
    ),
    footer: [button('Entendi', { variant: 'primary', block: true, onClick: () => panel.close() })],
  });
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} root
 * @param {object} env  veja ui/screens/map.js
 */
export async function mountSurvey(root, env) {
  const { ctx, storage } = env;
  const { bridge, scanLoop, store } = ctx;

  await storage.ready;
  const start = env.session.start;
  env.session.start = null;
  env.session.result = null;
  const draft = start ? null : await storage.draft.load();
  // Um levantamento pertence ao modo em que começou (casa virtual ou Wi-Fi de verdade). Rascunho
  // do outro modo não é retomado aqui: fica como está e a biblioteca explica como continuar.
  if (draft && draft.recorder && !matchesMode(draft, env.isDemo())) {
    toast(isDemoOrigin(draft) ? 'O mapeamento guardado é da demonstração. Ligue a demonstração para continuar.' : 'O mapeamento guardado é do Wi-Fi de verdade. Saia da demonstração para continuar.');
    env.go('/mapa', { replace: true });
    return { unmount() {} };
  }
  const sim = await env.sim();
  // quem estava respondendo quando o levantamento abriu ('sim' | 'native'): leitura de outro lado não entra
  const originKind = typeof bridge.kind === 'function' ? bridge.kind() : null;
  const sameSource = () => typeof bridge.kind !== 'function' || bridge.kind() === originKind;
  const speedNow = () => (sim && Number.isFinite(sim.speed) && sim.speed > 0 ? sim.speed : 1);

  // --- gravador ------------------------------------------------------------
  let rec = null;
  if (draft && draft.recorder) rec = recorderFromJSON(draft.recorder, { timeScale: speedNow() });
  const resumed = !!rec;
  if (!rec) rec = createRecorder({ timeScale: speedNow() });
  const info = {
    ownSsids: (resumed ? draft.ownSsids : start && start.ownSsids) || defaultOwnSsids(store),
    extraOwn: (resumed ? draft.extraOwn : start && start.extraOwn) || [],
    recordId: resumed ? (draft.recordId ?? null) : null,
    name: resumed ? draft.name || null : null,
    createdAt: resumed ? draft.createdAt || null : null,
    startedAt: (resumed && draft.startedAt) || Date.now(),
    // retomado: vale a origem guardada no rascunho, não o modo de agora
    demo: resumed ? isDemoOrigin(draft) : env.isDemo(),
  };
  const wantPilot = !!(start && start.pilot && sim);

  // --- estado da tela ------------------------------------------------------
  let dead = false;
  let switched = false; // o app trocou de modo (demonstração <-> Wi-Fi de verdade) com o levantamento aberto
  let mode = 'survey'; // 'survey' | 'processing' | 'error'
  let viewer = null;
  let miniPlan = null;
  let pilot = null;
  let pilotStep = null;
  let pilotStarted = false;
  let simNow = null; // último evento 'sim'
  let lastScanAt = null; // relógio de parede da última leitura aceita
  let gaps = [];
  let radarDots = 0;
  let lastSavedScans = resumed ? rec.stats().scans : 0;
  let lastSavedAt = Date.now();
  let lastRttAt = 0;
  let rttBusy = false;
  const preview = { running: false, lastScans: 0, lastAt: 0, solution: null, model: null };
  const offs = [];
  const prevLoopMode = scanLoop.getState().mode;

  // --- DOM fixo ------------------------------------------------------------
  root.className = 'screen screen--bleed';
  const viewerBox = h('div.msv-preview__viewer', { hidden: true });
  // (os dois textos do radar são postos por drawRadar(), conforme o ritmo das leituras)
  const radarText = h('p.msv-radar__text');
  const radarSub = h('p.msv-radar__sub');
  const radarDotsBox = h('span.msv-radar__dots', { 'aria-hidden': 'true' });
  const radar = h('div.msv-radar', null, h('div.msv-radar__art', { 'aria-hidden': 'true' }, h('span.msv-radar__wave'), h('span.msv-radar__wave'), h('span.msv-radar__wave'), radarDotsBox, h('span.msv-radar__core', null, icon('wifi', { size: 26 }))), radarText, radarSub);
  const tag = h('span.msv-preview__tag', { hidden: true }, 'Prévia · estimativa');
  const planBox = h('div.mini-plan__canvas-box');
  const planEl = sim
    ? h(
        'button.mini-plan',
        {
          type: 'button',
          'aria-label': 'Casa virtual de verdade (só na demonstração). Toque para ampliar ou reduzir.',
          'aria-pressed': 'false',
          onClick: (ev) => {
            const big = ev.currentTarget.classList.toggle('mini-plan--big');
            ev.currentTarget.setAttribute('aria-pressed', String(big));
          },
        },
        planBox,
        h('span.mini-plan__caption', null, 'Casa virtual (só na demonstração)'),
      )
    : null;
  const previewEl = h('div', { class: ['msv-preview', sim && 'msv-preview--demo'] }, viewerBox, radar, tag, planEl);
  const bodyEl = h('div.msv__body');
  const barEl = h('div.msv__bar');
  const liveEl = h('div.sr-only', { role: 'status', 'aria-live': 'polite' });
  const surveyEl = h('div.msv', null, h('div.msv__scroll', null, h('div.msv__col', null, previewEl, bodyEl)), barEl, liveEl);
  const stageEl = h('div.msv-stage');
  root.appendChild(surveyEl);
  root.appendChild(stageEl);
  stageEl.hidden = true;

  if (sim) miniPlan = createMiniPlan(planBox, { world: sim.world, floorName });

  // --- gravação ------------------------------------------------------------

  /**
   * Quantas leituras bastam num lugar marcado. Com o Android limitando as buscas (o que o laço de
   * buscas sabe na hora; o gravador só percebe depois de algumas leituras) uma já está ótimo.
   */
  function spotTarget(spot) {
    return store.get().loop.throttled ? 1 : Math.max(1, spot.target || 1);
  }

  /** Diz em voz (leitor de tela) só o que muda o que a pessoa deve fazer; a contagem regressiva fica de fora. */
  let lastSaid = '';
  let lastLevel = null;
  function say(text) {
    if (!text || text === lastSaid) return;
    lastSaid = text;
    liveEl.textContent = text;
  }

  function noteScanAccepted() {
    const t = Date.now();
    if (lastScanAt !== null) gaps = [...gaps, t - lastScanAt].slice(-5);
    lastScanAt = t;
    radarDots += 1;
    pingRadar();
  }

  function onScan(ev) {
    if (dead || mode !== 'survey' || switched || !sameSource()) return;
    let accepted = false;
    try {
      // o gravador fica sabendo do limite de buscas pelo laço (relógio de verdade), não pelo ritmo em tempo de caminhada
      accepted = rec.onScan(ev, { aps: store.get().aps, throttled: !!store.get().loop.throttled });
    } catch (err) {
      console.error('[mapa] o gravador recusou uma leitura', err);
    }
    if (!accepted) return;
    noteScanAccepted();
    const st = rec.stats();
    if (st.spot && st.spot.scans === spotTarget(st.spot)) {
      bridge.vibrate(30).catch(() => {});
      say(`${st.spot.label ? `${st.spot.label}: ` : ''}lugar marcado. Pode seguir para o próximo.`);
    }
    if (st.level !== lastLevel) {
      if (lastLevel !== null) say(levelInfo(st.level).label);
      lastLevel = st.level;
    }
    draw();
    void maybePreview();
    if (st.scans - lastSavedScans >= AUTOSAVE_SCANS) void saveDraft();
  }

  function onRssi(sample) {
    if (dead || mode !== 'survey' || switched || !sameSource()) return;
    try {
      rec.onRssi(sample);
    } catch {
      // uma leitura ruim do sinal conectado não interrompe o levantamento
    }
  }

  async function maybeRtt() {
    if (rttBusy || rec.state !== 'recording' || Date.now() - lastRttAt < RTT_EVERY_MS) return;
    const state = store.get();
    if (!state.info || !state.info.rtt) return;
    const targets = rttTargets(state.aps);
    if (!targets.length) return;
    rttBusy = true;
    lastRttAt = Date.now();
    try {
      const res = await bridge.rtt(targets);
      if (!dead && !switched && sameSource() && res && Array.isArray(res.results)) rec.onRtt(res.results);
    } catch {
      // sem RTT o mapa sai do mesmo jeito
    } finally {
      rttBusy = false;
    }
  }

  function draftPayload() {
    const st = rec.stats();
    return {
      v: 1,
      recorder: rec.toJSON(),
      ownSsids: info.ownSsids,
      extraOwn: info.extraOwn,
      recordId: info.recordId,
      name: info.name,
      createdAt: info.createdAt,
      startedAt: info.startedAt,
      savedAt: Date.now(),
      demo: info.demo,
      summary: { scans: st.scans, spots: st.spots, durationS: st.durationS },
    };
  }

  async function saveDraft() {
    const st = rec.stats();
    lastSavedAt = Date.now();
    lastSavedScans = st.scans;
    if (st.scans === 0) return;
    await storage.draft.save(draftPayload());
  }

  // --- prévia --------------------------------------------------------------

  function pingRadar() {
    if (viewer) return;
    radar.classList.remove('is-ping');
    void radar.offsetWidth; // reinicia a animação
    radar.classList.add('is-ping');
    const dot = h('i', { style: { '--a': `${(radarDots * 137.5) % 360}deg`, '--r': `${28 + ((radarDots * 17) % 34)}%` } });
    radarDotsBox.appendChild(dot);
    while (radarDotsBox.childNodes.length > 14) radarDotsBox.firstChild.remove();
    drawRadar();
  }

  /**
   * Os textos do radar (enquanto a prévia não aparece). Calculados a cada desenho: o limite do
   * Android pode ligar ou desligar no meio do levantamento, e "continue andando" não serve para
   * quem está mapeando ponto a ponto.
   */
  function drawRadar(st = rec.stats()) {
    if (viewer) return;
    const copy = radarInfo({ scans: st.scans, minScans: PREVIEW_MIN_SCANS, throttled: !!store.get().loop.throttled, spot: !!st.spot && st.state === 'recording', resumed: resumed && preview.lastScans === 0 });
    if (radarText.textContent !== copy.text) radarText.textContent = copy.text;
    if (radarSub.textContent !== copy.sub) radarSub.textContent = copy.sub;
  }

  function showPreview(model) {
    if (dead || !model || !Array.isArray(model.floors) || !model.floors.length) return;
    if (!viewer) {
      viewerBox.hidden = false;
      try {
        viewer = createViewer(viewerBox, { theme: store.get().theme, label: 'Prévia do mapa, feita com as leituras até agora' });
        viewer.setLayers({ neighbours: false, grid: true });
      } catch (err) {
        console.error('[mapa] não foi possível criar a prévia', err);
        viewerBox.hidden = true;
        viewer = null;
        return;
      }
      radar.hidden = true;
      tag.hidden = false;
    }
    viewer.setModel(model);
    // "você está aqui": a posição estimada da leitura mais recente
    const last = model.path && model.path.length ? model.path[model.path.length - 1] : null;
    viewer.setWalker(last ? { x: last.x, y: last.y, z: last.z, floor: last.floor } : null);
    if (model.floors.length > 1) viewer.setExplode(0.6);
  }

  async function maybePreview() {
    const st = rec.stats();
    if (mode !== 'survey' || !previewDue({ scans: st.scans, lastScans: preview.lastScans, running: preview.running, now: Date.now(), lastAt: preview.lastAt, throttled: st.throttled, minScans: PREVIEW_MIN_SCANS })) return;
    preview.running = true;
    const survey = rec.toSurvey();
    const count = survey.scans.length;
    try {
      const engine = await env.engine();
      const out = await engine.run(survey, { own: ownBssidsFor(survey, info.ownSsids, info.extraOwn), quick: true, previous: preview.solution, budgetMs: 700 });
      if (dead || mode !== 'survey') return;
      preview.solution = out.solution;
      preview.model = out.model;
      showPreview(out.model);
    } catch (err) {
      if (!err || err.name !== 'AbortError') console.warn('[mapa] a prévia falhou', err);
    } finally {
      preview.lastScans = count;
      preview.lastAt = Date.now();
      preview.running = false;
    }
  }

  // --- ações ---------------------------------------------------------------

  function mark(label) {
    const clean = cleanLabel(label);
    const id = rec.beginSpot(clean);
    if (id === null || id === undefined) {
      toast('Retome o mapeamento para marcar um lugar.');
      return;
    }
    bridge.vibrate(20).catch(() => {});
    say(clean ? `Parado em: ${clean}. Fique parado até as leituras chegarem.` : 'Lugar marcado. Fique parado até as leituras chegarem.');
    // ponto a ponto: pede uma leitura já (se o Android ainda tiver busca sobrando ela chega em
    // segundos; se não, vale a próxima do ritmo de 30 s)
    if (store.get().loop.throttled) scanLoop.scanNow().catch(() => {});
    draw();
  }

  function openMark() {
    if (rec.state !== 'recording') return;
    const st = rec.stats();
    const input = h('input.input', { type: 'text', placeholder: 'Outro nome', maxlength: 40, autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'false', 'aria-label': 'Nome do lugar' });
    const submit = () => {
      const text = cleanLabel(input.value);
      if (!text) {
        input.focus();
        return;
      }
      panel.close();
      mark(text);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    });
    const panel = sheet({
      title: 'Onde você está?',
      subtitle: st.throttled ? 'Depois de marcar, fique parado até a leitura chegar.' : 'Depois de marcar, fique parado aqui por alguns segundos.',
      content: h(
        'div.msv-mark',
        null,
        h(
          'div.chips.msv-mark__chips',
          null,
          roomChips(st.labels).map((c) =>
            h(
              'button.chip',
              {
                type: 'button',
                class: c.used ? 'msv-mark__used' : null,
                onClick: () => {
                  panel.close();
                  mark(c.label);
                },
              },
              c.used ? icon('check', { size: 16 }) : null,
              h('span', { dir: 'auto' }, c.label),
            ),
          ),
        ),
        st.labels.length ? h('p.msv-mark__hint', null, icon('check', { size: 14 }), 'Já marcados neste mapa. Marcar de novo com o mesmo nome junta os dois no mesmo ambiente.') : null,
        h('div.msv-mark__free', null, input, button('Marcar', { variant: 'primary', onClick: submit })),
      ),
      footer: [
        button('Marcar sem nome', {
          variant: 'quiet',
          onClick: () => {
            panel.close();
            mark('');
          },
        }),
      ],
    });
  }

  function moveOn() {
    rec.endSpot();
    draw();
    void saveDraft();
  }

  function undo() {
    const gone = rec.undoLastScan();
    if (!gone) return;
    toast('Última leitura desfeita.');
    preview.lastScans = Math.min(preview.lastScans, rec.stats().scans);
    draw();
  }

  function togglePause() {
    if (rec.state === 'recording') {
      rec.pause();
      scanLoop.setMode(prevLoopMode === 'mapping' ? 'normal' : prevLoopMode);
      void saveDraft();
    } else {
      rec.resume();
      scanLoop.setMode('mapping');
      bridge.keepAwake(true).catch(() => {});
      lastScanAt = null;
      gaps = [];
    }
    draw();
  }

  function changeFloor(delta) {
    const next = clampFloor(rec.floor + delta);
    if (next === rec.floor) return;
    rec.setFloor(next);
    draw();
  }

  async function discard() {
    const st = rec.stats();
    const ok = await confirmDialog({
      title: 'Descartar este mapeamento?',
      text: st.scans ? `${plural(st.scans, 'leitura será apagada', 'leituras serão apagadas')}. Não dá para desfazer.` : 'Nada foi coletado ainda.',
      confirmLabel: 'Descartar',
      cancelLabel: 'Continuar mapeando',
      danger: true,
    });
    if (!ok || dead) return;
    if (pilot && pilot.running) pilot.stop();
    rec.stop();
    rec.reset();
    await storage.draft.clear();
    env.go('/mapa', { replace: true });
  }

  function openMenu() {
    actionSheet({
      title: 'Mapeamento',
      actions: [
        { icon: 'help', label: 'Como fazer um bom mapa', onClick: () => openTips(ctx, store.get().loop.throttled) },
        // (num Android sem a chave do limite não há o que liberar: a explicação fica nas dicas)
        store.get().loop.throttled && throttleCopy(store).canLift ? { icon: 'clock', label: 'Liberar buscas mais rápidas', hint: 'O Android está limitando as leituras', onClick: () => openThrottleHelp(ctx) } : null,
        { icon: 'trash', label: 'Descartar este mapeamento', danger: true, onClick: discard },
      ],
    });
  }

  // --- concluir ------------------------------------------------------------

  let processing = null;
  let delivered = false; // o resultado já foi entregue à tela seguinte

  function showStage(node) {
    surveyEl.hidden = !!node;
    stageEl.hidden = !node;
    stageEl.replaceChildren(...(node ? [node] : []));
  }

  async function conclude({ force = false } = {}) {
    if (mode !== 'survey') return;
    const st = rec.stats();
    if (!force && !levelInfo(st.level).canFinish) return;
    if (pilot && pilot.running) pilot.stop();
    rec.endSpot();
    rec.stop();
    scanLoop.setMode(prevLoopMode === 'mapping' ? 'normal' : prevLoopMode);
    bridge.keepAwake(false).catch(() => {});
    await saveDraft();
    if (dead) return;

    mode = 'processing';
    ctx.setActions();
    const survey = rec.toSurvey();
    const own = ownBssidsFor(survey, info.ownSsids, info.extraOwn);
    let cancelled = false;
    let engine = null;
    processing = processingView({
      onCancel: () => {
        cancelled = true;
        if (engine) engine.cancel();
      },
    });
    showStage(processing.el);
    try {
      engine = await env.engine();
      if (cancelled) throw Object.assign(new Error('cancelado'), { name: 'AbortError' });
      const out = await engine.run(survey, { own, previous: preview.solution, onProgress: (fraction, label) => processing && processing.set(fraction, label) });
      if (dead) return;
      if (cancelled) throw Object.assign(new Error('cancelado'), { name: 'AbortError' });
      env.session.result = { survey, solution: out.solution, model: out.model, own, ownSsids: info.ownSsids, extraOwn: info.extraOwn, recordId: info.recordId, name: info.name, createdAt: info.createdAt, demo: info.demo };
      delivered = true;
      env.go('/mapa/ver/novo', { replace: true });
    } catch (err) {
      if (dead) return;
      processing = null;
      if (err && err.name === 'AbortError') {
        // de volta ao levantamento, em pausa: nada se perdeu
        mode = 'survey';
        if (switched) {
          // o app trocou de modo durante o cálculo: este levantamento não continua com o outro lado
          env.go('/mapa', { replace: true });
          return;
        }
        showStage(null);
        setTopActions();
        draw();
        if (viewer) viewer.resize();
        toast('Cálculo cancelado. O mapeamento continua guardado.');
        return;
      }
      console.error('[mapa] o cálculo do mapa falhou', err);
      mode = 'error';
      showStage(
        errorState({
          title: 'Não deu para montar o mapa',
          text: 'As leituras continuam guardadas. Tente de novo; se continuar, faça mais algumas leituras e conclua outra vez.',
          onRetry: () => {
            mode = 'survey';
            showStage(null);
            void conclude({ force: true });
          },
        }),
      );
    }
  }

  // --- piloto da demonstração ------------------------------------------------

  async function startPilot() {
    if (!sim || pilotStarted) return;
    pilotStarted = true;
    try {
      const mod = await import('../../mapping/demo-pilot.js');
      if (dead) return;
      pilot = mod.createDemoPilot({
        sim,
        recorder: rec,
        scanLoop,
        onStep: (step) => {
          pilotStep = step || null;
          if (!dead) draw();
        },
      });
      pilot.start({});
      draw();
    } catch (err) {
      console.error('[mapa] o piloto da demonstração não pôde começar', err);
      pilot = null;
      toast('A demonstração automática não pôde começar. Você pode marcar os lugares à mão.');
    }
  }

  function stopPilot() {
    if (pilot && pilot.running) pilot.stop();
    pilot = null;
    pilotStep = null;
    toast('Demonstração parada. Agora é com você: a pessoa virtual continua andando sozinha.');
    draw();
  }

  function pilotText() {
    const step = pilotStep;
    if (!step || typeof step !== 'object') return 'A pessoa virtual está andando pela casa.';
    const rooms = step.rooms && Number.isFinite(step.rooms.total) && step.rooms.total > 0 ? ` · ${step.rooms.marked} de ${step.rooms.total} cômodos marcados` : '';
    const where = typeof step.room === 'string' && step.room ? step.room : null;
    if (step.phase === 'marking') return `Parada para marcar${where ? `: ${where}` : ' um lugar'}${rooms}`;
    if (step.phase === 'paused') return 'À espera: o mapeamento está em pausa.';
    return `${where ? `Andando: ${where}` : 'Andando pela casa virtual'}${rooms}`;
  }

  function pilotProgress() {
    const p = pilotStep && Number.isFinite(pilotStep.progress) ? pilotStep.progress : 0;
    return Math.max(0, Math.min(1, p));
  }

  // --- desenho -------------------------------------------------------------

  function setTopActions() {
    ctx.setTitle(info.recordId !== null ? 'Continuar o mapa' : 'Novo mapa');
    ctx.setActions(iconButton('more', 'Mais opções do mapeamento', openMenu));
  }

  function draw() {
    if (dead || mode !== 'survey') return;
    const st = rec.stats();
    const loop = store.get().loop;
    const paused = st.state !== 'recording';
    // o limite que o usuário sente é o do relógio de parede (o do laço de buscas); o do gravador
    // conta tempo de caminhada, que na demonstração acelerada corre mais depressa
    const throttled = !!loop.throttled;
    const pulse = pulseInfo({ now: Date.now(), lastScanAt, gaps, loop, state: st.state === 'recording' ? 'recording' : 'paused' });
    const level = levelInfo(st.level);
    const piloting = !!(pilot && pilot.running);
    const spot = st.spot;
    const spotCount = spotCounter({ spots: st.spots, throttled, canFinish: level.canFinish }, SURVEY_THRESHOLDS);
    drawRadar(st);

    // o que a pessoa precisa saber agora, em uma linha
    let title = pulse.title;
    let detail = pulse.detail;
    let center = pulse.phase === 'paused' ? icon('pause', { size: 18 }) : throttled && pulse.secondsLeft !== null && pulse.phase === 'waiting' ? h('span.msv-ring__num', null, String(pulse.secondsLeft)) : icon('wifi', { size: 18 });
    let tone = pulse.phase === 'late' ? 'late' : null;
    if (spot && !paused) {
      title = spot.label ? h('span', null, 'Parado em: ', h('strong', { dir: 'auto' }, spot.label)) : 'Parado num lugar sem nome';
      const target = spotTarget(spot);
      const got = spot.scans >= target;
      const count = `${plural(spot.scans, 'leitura', 'leituras')} aqui`;
      if (got) {
        detail = `${count}. Pode seguir para o próximo lugar.`;
        tone = 'done';
        center = icon('check', { size: 20 });
      } else if (throttled) {
        detail = `Fique parado até a leitura chegar. ${pulse.phase === 'waiting' || pulse.phase === 'late' ? pulse.detail : 'A leitura pode levar até meio minuto.'}`;
      } else {
        detail = `${count} (o ideal são ${target}). Fique parado mais um pouco.`;
      }
    } else if (!paused && throttled && pulse.phase !== 'first') {
      detail = `${pulse.detail} · leituras a cada ≈ 30 s`;
    }

    const simFloorOff = sim && simNow && !piloting && !paused && Number.isFinite(simNow.floor) && simNow.floor !== st.floor;

    patch(
      bodyEl,
      piloting
        ? h(
            'section.msv-pilot',
            { key: 'pilot', role: 'status' },
            h('span.msv-pilot__icon', null, icon('flask', { size: 20 })),
            h('div.msv-pilot__body', null, h('strong', null, 'Demonstração automática'), h('span', { dir: 'auto' }, pilotText())),
            h('span.meter.msv-pilot__bar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pilotProgress() * 100), 'aria-label': 'Andamento da demonstração' }, h('span.meter__fill', { style: { width: `${Math.round(pilotProgress() * 100)}%` } })),
          )
        : null,
      simFloorOff
        ? banner({
            key: 'floor-nudge',
            tone: 'warning',
            icon: simNow.floor > st.floor ? 'floor-up' : 'floor-down',
            title: `A pessoa virtual foi para: ${floorName(simNow.floor)}`,
            text: 'Numa casa de verdade é você quem avisa: ajuste o controle “Andar” abaixo.',
            actions: [
              {
                label: `Marcar ${floorName(simNow.floor)}`,
                onClick: () => {
                  rec.setFloor(simNow.floor);
                  draw();
                },
              },
            ],
          })
        : null,
      h(
        'section.card.msv-status',
        { key: 'status', dataset: { state: paused ? 'paused' : spot ? 'spot' : 'walking' } },
        h('div.msv-status__now', null, ring(spot && !paused ? Math.min(1, spot.scans / spotTarget(spot)) || pulse.fraction : pulse.fraction, center, tone), h('div.msv-status__text', null, h('p.msv-status__title', null, title), h('p.msv-status__detail', null, detail))),
        h(
          'div.msv-level',
          null,
          h('div.msv-level__head', null, h('span.msv-level__label', null, level.label), h('span.msv-level__steps', null, level.index >= level.steps ? 'nível máximo' : `nível ${level.index} de ${level.steps}`)),
          levelMeter(level),
          // com um ponto aberto a orientação já está na linha de cima; sem poder concluir, ela vai junto do botão
          !spot && !paused && level.canFinish ? h('p.msv-level__hint', null, st.hint) : null,
          // (deitado, a barra de ações é baixa: o motivo de não poder concluir aparece aqui)
          !level.canFinish && !piloting ? h('p.msv-level__hint.msv-level__blocker', null, finishBlocker({ ...st, throttled: st.throttled || throttled }, SURVEY_THRESHOLDS)) : null,
        ),
      ),
      h(
        'div.msv-counts',
        { key: 'counts' },
        counter(st.scans === 1 ? 'leitura' : 'leituras', String(st.scans), 'c-scans'),
        counter(spotCount.label, spotCount.value, 'c-spots', spotCount.of),
        counter(st.devices === 1 ? 'roteador ouvido' : 'roteadores ouvidos', String(st.devices), 'c-aps'),
        counter('de caminhada', fmtTimer(st.durationS), 'c-time'),
      ),
      h(
        'div.msv-floor',
        { key: 'floor' },
        h('span.msv-floor__label', { id: 'msv-floor-label' }, 'Andar'),
        h(
          'div.msv-floor__ctl',
          { role: 'group', 'aria-labelledby': 'msv-floor-label' },
          iconButton('minus', 'Desci um andar', () => changeFloor(-1), { disabled: paused || st.floor <= FLOOR_MIN, class: 'icon-btn msv-floor__btn' }),
          h('output.msv-floor__value', { 'aria-live': 'polite' }, floorName(st.floor)),
          iconButton('plus', 'Subi um andar', () => changeFloor(1), { disabled: paused || st.floor >= FLOOR_MAX, class: 'icon-btn msv-floor__btn' }),
        ),
      ),
    );

    const canFinish = level.canFinish;
    const finishBtn = (label) =>
      h('button', { type: 'button', class: ['btn', 'btn--secondary', 'msv__finish', canFinish && 'is-ready'], disabled: !canFinish, onClick: () => conclude() }, icon('check', { size: 20 }), label);
    patch(
      barEl,
      piloting
        ? h(
            'div.msv__bar-in',
            { key: 'bar-pilot' },
            h('div.msv__bar-row', null, button('Assumir o controle', { icon: 'walk', onClick: stopPilot }), finishBtn('Concluir agora')),
            h('p.msv__bar-note', null, icon('info', { size: 14 }), 'A demonstração marca os cômodos e conclui sozinha. Você pode assumir quando quiser.'),
          )
        : h(
            'div.msv__bar-in',
            { key: 'bar' },
            paused
              ? button('Retomar o mapeamento', { variant: 'primary', icon: 'play', block: true, onClick: togglePause, key: 'main' })
              : spot
                ? button('Segui andando', { variant: 'primary', icon: 'walk', block: true, onClick: moveOn, key: 'main' })
                : button('Marcar este lugar', { variant: 'primary', icon: 'pin', block: true, onClick: openMark, key: 'main' }),
            h(
              'div.msv__bar-row',
              null,
              button('Desfazer', { icon: 'undo', onClick: undo, disabled: st.scans === 0, 'aria-label': 'Desfazer a última leitura' }),
              paused ? null : button('Pausar', { icon: 'pause', onClick: togglePause }),
              finishBtn('Concluir'),
            ),
            canFinish ? null : h('p.msv__bar-note', null, icon('info', { size: 14 }), finishBlocker({ ...st, throttled: st.throttled || throttled }, SURVEY_THRESHOLDS)),
          ),
    );
  }

  // --- laço de 0,5 s -------------------------------------------------------

  function tick() {
    if (dead || mode !== 'survey' || switched) return;
    if (sim && Math.abs(rec.timeScale - speedNow()) > 1e-6) rec.setTimeScale(speedNow());
    draw();
    void maybePreview();
    void maybeRtt();
    if (rec.state === 'recording' && Date.now() - lastSavedAt >= AUTOSAVE_MS && rec.stats().scans !== lastSavedScans) void saveDraft();
    if (pilotStarted && pilot && !pilot.running && mode === 'survey') {
      // o piloto terminou a volta pela casa: conclui sozinho
      pilot = null;
      pilotStep = null;
      if (rec.stats().scans >= PREVIEW_MIN_SCANS) {
        toast('A demonstração terminou a caminhada. Montando o mapa…');
        void conclude({ force: true });
      } else draw();
    }
  }

  // --- partida -------------------------------------------------------------

  if (resumed) rec.resume();
  else rec.start();
  bridge.keepAwake(true).catch(() => {});
  scanLoop.setMode('mapping');
  setTopActions();

  offs.push(bridge.on('scan', onScan));
  offs.push(bridge.on('rssi', onRssi));
  if (sim) {
    offs.push(
      bridge.on('sim', (ev) => {
        simNow = ev;
        if (miniPlan) miniPlan.setPerson(ev);
      }),
    );
  }
  offs.push(
    store.subscribe(
      (st) => st.theme,
      (theme) => {
        if (viewer) viewer.setTheme(theme);
        if (miniPlan) miniPlan.redraw();
      },
    ),
  );
  offs.push(
    store.subscribe(
      (st) => st.loop.throttled,
      (throttled) => {
        rec.setThrottled(!!throttled);
        draw();
      },
    ),
  );
  rec.setThrottled(!!store.get().loop.throttled);
  // O modo mudou com o levantamento aberto (pílula "Demonstração" ou Ajustes): ele para aqui. O que
  // foi lido até agora fica guardado como rascunho do modo em que começou (unmount grava com
  // info.demo); as leituras do outro lado nunca entram neste levantamento.
  offs.push(
    store.subscribe(
      (st) => st.backend,
      () => {
        if (dead || switched) return;
        switched = true;
        if (mode !== 'survey') return; // o cálculo final segue com as leituras que já tinha
        if (pilot && pilot.running) {
          try {
            pilot.stop();
          } catch {
            // o simulador já foi trocado
          }
        }
        if (rec.state === 'recording') rec.pause();
        env.go('/mapa', { replace: true });
      },
    ),
  );
  const onHide = () => {
    if (document.hidden && rec.stats().scans) void saveDraft();
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);
  offs.push(() => document.removeEventListener('visibilitychange', onHide));
  offs.push(() => window.removeEventListener('pagehide', onHide));

  // o "voltar" do Android pergunta antes de sair (o rascunho fica guardado de qualquer jeito)
  let asking = false;
  offs.push(
    ctx.onBack(() => {
      if (dead) return false;
      if (mode === 'processing') return true; // o botão "Cancelar" da própria tela é quem cancela
      if (mode !== 'survey' || asking) return mode === 'survey';
      asking = true;
      const count = rec.stats().scans;
      confirmDialog({
        title: 'Sair do mapeamento?',
        text: count ? `As ${count === 1 ? '1 leitura fica guardada' : `${count} leituras ficam guardadas`} como rascunho: dá para continuar depois.` : 'Nada foi coletado ainda.',
        confirmLabel: 'Sair',
        cancelLabel: 'Continuar mapeando',
      }).then((ok) => {
        asking = false;
        if (ok && !dead) env.go('/mapa', { replace: true });
      });
      return true;
    }),
  );

  const timer = setInterval(tick, TICK_MS);
  offs.push(() => clearInterval(timer));

  draw();
  void maybePreview();
  if (wantPilot) void startPilot();
  else if (resumed) toast('Mapeamento retomado de onde você parou.');

  return {
    onShow() {
      if (!dead && mode === 'survey') setTopActions();
    },
    unmount() {
      if (dead) return;
      dead = true;
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch {
          // segue limpando o resto
        }
      }
      if (pilot && pilot.running) {
        try {
          pilot.stop();
        } catch {
          // o simulador pode já ter sido trocado
        }
      }
      const leftMidSurvey = mode === 'survey' || mode === 'error';
      if (rec.state === 'recording') rec.pause();
      if (leftMidSurvey) {
        const count = rec.stats().scans;
        if (count > 0) {
          // quem abrir a biblioteca em seguida espera esta gravação antes de procurar o rascunho
          env.session.saving = storage.draft.save(draftPayload());
          if (switched) toast(info.demo ? 'O mapeamento da demonstração ficou guardado como rascunho.' : 'O mapeamento do Wi-Fi de verdade ficou guardado como rascunho.');
          else toast('Mapeamento em pausa. O rascunho ficou guardado.');
        } else if (!resumed) {
          void storage.draft.clear();
        }
      }
      // o cálculo em andamento (prévia ou final) não interessa mais
      if (!delivered) env.engine().then((e) => e.cancel()).catch(() => {});
      bridge.keepAwake(false).catch(() => {});
      if (scanLoop.getState().mode !== prevLoopMode) scanLoop.setMode(prevLoopMode);
      if (viewer) viewer.destroy();
      if (miniPlan) miniPlan.destroy();
      viewer = null;
      miniPlan = null;
    },
  };
}
