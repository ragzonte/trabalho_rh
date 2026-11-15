// Teste de velocidade: tempo de resposta, download e upload da internet pelo Wi-Fi.
//
// Quem mede é o celular (bridge.speedTest, contra os servidores de teste da Cloudflare); a tela
// só acompanha os eventos 'speed' e apresenta: mostrador que passa por resposta -> download ->
// upload, os quatro números finais, quanto de dados o teste usou, de onde o servidor respondeu
// e a comparação com o que o Wi-Fi aguenta neste ponto ("o limite é o Wi-Fi ou o plano?").
//
// É a única função do app que usa a internet, então a tela diz isso com todas as letras antes
// do primeiro teste, junto com o gasto de dados de cada modo, e oferece o teste leve.
//
// Os últimos resultados ficam no aparelho (prefs "wrx.speed.history"); o modo escolhido também
// ("wrx.speed.mode"). Sair da tela cancela o teste (bridge.cancel('speed')).

import { h, patch, sheet, toast, confirmDialog, fmtNum, fmtMbps, fmtMs, fmtClock, THIN, NO_VALUE } from '../dom.js';
import { icon } from '../icons.js';
import { button, segmented, banner, sectionHeader, kvList, meter, badge, ssidLabel, spinner } from '../components.js';
import { createGauge } from '../charts/gauge.js';
import { speedVerdict, wifiVsInternet, gaugeMax, estimateTestBytes, LIGHT_MAX_BYTES, formatBytes, serverCity, sanitizeSpeedHistory, addSpeedResult } from './net-logic.js';

const KEY_HISTORY = 'speed.history';
const KEY_MODE = 'speed.mode';
const PHASES = ['latency', 'download', 'upload'];
const PHASE_TEXT = {
  latency: 'Medindo o tempo de resposta…',
  download: 'Medindo o download…',
  upload: 'Medindo o upload…',
};
const MODES = [
  { value: 'full', label: 'Completo' },
  { value: 'light', label: 'Leve' },
];

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function median(list) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// O teste em andamento (ou o último desta sessão). Fica no módulo para sobreviver a sair e voltar.
const session = {
  backend: null,
  run: null,
  pending: null, // Promise do teste em andamento
  pendingRun: null, // o teste que essa Promise vai fechar
  seq: 0,
  onChange: null, // a tela montada agora (se houver)
};

/** Fecha um teste: guarda o resultado (se houve) e avisa a tela. Vale mesmo sem tela montada. */
function finishRun(run, summary, prefs) {
  if (session.pendingRun === run) {
    session.pending = null;
    session.pendingRun = null;
  }
  const s = summary && typeof summary === 'object' ? summary : { ok: false, error: 'failed' };
  run.endedAt = Date.now();
  run.bytesDown = isNum(s.bytesDown) ? s.bytesDown : run.bytes.download;
  run.bytesUp = isNum(s.bytesUp) ? s.bytesUp : run.bytes.upload;
  if (s.ok === true && isNum(s.downMbps) && isNum(s.upMbps)) {
    run.state = 'done';
    run.downMbps = s.downMbps;
    run.upMbps = s.upMbps;
    if (isNum(s.latencyMs)) run.latencyMs = s.latencyMs;
    if (isNum(s.jitterMs)) run.jitterMs = s.jitterMs;
    run.server = typeof s.server === 'string' ? s.server : null;
    const link = median(run.linkSamples);
    const history = addSpeedResult(prefs.get(KEY_HISTORY, []), {
      ts: run.endedAt,
      mode: run.mode,
      downMbps: run.downMbps,
      upMbps: run.upMbps,
      latencyMs: run.latencyMs,
      jitterMs: run.jitterMs,
      bytesDown: run.bytesDown,
      bytesUp: run.bytesUp,
      server: run.server,
      ssid: run.ssid,
      linkMbps: link,
    });
    prefs.set(KEY_HISTORY, history);
    run.record = history.find((r) => r.ts === Math.round(run.endedAt)) || null;
  } else {
    const cancelled = s.error === 'cancelled' || !!run.cancelRequested;
    run.state = cancelled ? 'cancelled' : 'error';
    run.error = cancelled ? null : s.error === 'offline' ? 'offline' : 'failed';
  }
  if (session.onChange) session.onChange();
}

// ---------------------------------------------------------------------------
// Folha de estilos das ferramentas de rede (carregada uma vez)
// ---------------------------------------------------------------------------

const STYLE_ID = 'wrx-tools-b-css';

function ensureStyles() {
  let link = document.getElementById(STYLE_ID);
  if (!link) {
    link = document.createElement('link');
    link.id = STYLE_ID;
    link.rel = 'stylesheet';
    link.href = new URL('../../../css/tools-b.css', import.meta.url).href;
    link.__ready = new Promise((resolve) => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 1500); // nunca segura a tela por causa do estilo
    });
    document.head.appendChild(link);
  }
  return link.__ready || Promise.resolve();
}

// ---------------------------------------------------------------------------
// Peças
// ---------------------------------------------------------------------------

/** "286 Mb/s" -> ['286', 'Mb/s'] (a unidade muda para Gb/s sozinha). */
function speedParts(mbps) {
  if (!isNum(mbps)) return [NO_VALUE, null];
  const [value, unit] = fmtMbps(mbps).split(THIN);
  return [value, unit || 'Mb/s'];
}

/** Data curta para listas: "hoje, 14:32", "ontem, 09:10", "12/11, 18:38" (com o ano só quando é outro). */
function shortDate(ts) {
  if (!isNum(ts)) return NO_VALUE;
  const d = new Date(ts);
  const now = new Date();
  const dayOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayOf(now) - dayOf(d)) / 86_400_000);
  const time = fmtClock(ts, { seconds: false });
  if (days === 0) return `hoje, ${time}`;
  if (days === 1) return `ontem, ${time}`;
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear() !== now.getFullYear() ? `/${d.getFullYear()}` : '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}${year}, ${time}`;
}

function msParts(ms) {
  if (!isNum(ms)) return [NO_VALUE, null];
  return [fmtNum(ms, ms < 9.95 ? 1 : 0), 'ms'];
}

/**
 * Número em destaque do teste: serve de passo ("medindo agora") e de resultado.
 * @param {{key:string, label:string, icon:string, parts:[string, string|null], hint?:string, active?:boolean, big?:boolean}} o
 */
function speedTile({ key, label, icon: iconName, parts, hint, active = false, big = false }) {
  return h(
    'div',
    { key, class: ['stat', 'tb-tile', !big && 'stat--compact', active && 'tb-tile--active'], dataset: { tile: key } },
    h('span.stat__label', null, icon(iconName, { size: 14 }), label, active ? h('span.tb-tile__live', { role: 'img', 'aria-label': 'medindo agora' }) : null),
    h('span.stat__value', null, parts[0], parts[1] ? h('span.stat__unit', null, parts[1]) : null),
    hint ? h('span.stat__hint', null, hint) : null,
  );
}

function aboutContent({ compact = false } = {}) {
  const item = (iconName, title, text) => h('div.tb-fact', null, h('span.tb-fact__icon', null, icon(iconName, { size: 20 })), h('p', null, h('strong', null, title, ' '), text));
  return [
    item(
      'globe',
      'Fala com a Cloudflare.',
      compact
        ? 'Baixa e envia dados sem conteúdo para os servidores de medição dela (speed.cloudflare.com). É a única função do app que usa a internet, e só quando você pede.'
        : 'O teste baixa e envia dados sem conteúdo para os servidores de medição da Cloudflare (speed.cloudflare.com). É a única função do app que usa a internet, e só quando você pede. A Cloudflare vê o endereço IP da sua internet, como qualquer site que você visita; nada do que o app analisa (nomes de redes, aparelhos) é enviado.',
    ),
    item('wifi', 'Só pelo Wi-Fi.', 'Nunca usa os dados móveis do chip.'),
    item(
      'download',
      'Gasta dados da internet da casa.',
      [
        `Completo: cerca de 1${THIN}MB para cada Mb/s de velocidade (≈${THIN}450${THIN}MB num plano de 300${THIN}Mb/s). Leve: até cerca de ${formatBytes(LIGHT_MAX_BYTES)}.`,
        compact ? null : ' Se o seu Wi-Fi tem franquia (internet via rádio ou satélite, ou roteada de outro celular), prefira o leve.',
      ],
    ),
  ];
}

function openAbout() {
  sheet({
    title: 'Sobre o teste de velocidade',
    content: [
      h('div.tb-facts', null, aboutContent()),
      h(
        'div.prose',
        { style: { marginTop: '16px' } },
        h('p', null, h('strong', null, 'O que é medido. '), 'Tempo de resposta (latência) e a variação dele; depois quanto chega por segundo (download) e quanto sai (upload). O teste completo mede por cerca de 8 segundos em cada direção; o leve, por 3.'),
        h('p', null, h('strong', null, 'Por que o resultado muda. '), 'O número depende do sinal do Wi-Fi no ponto em que você está, de quem mais está usando a internet e do horário. Para conferir o plano contratado, teste perto do roteador.'),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export async function mount(root, ctx) {
  const { store, bridge, prefs } = ctx;
  await ensureStyles();
  root.classList.add('tb');

  let alive = true;
  let frame = 0;
  let gauge = null;
  let gaugeHost = null;
  let gaugeKey = ''; // fase/escala em uso no mostrador
  let rangeMax = 0;
  let picked = null; // resultado antigo escolhido na lista
  let history = sanitizeSpeedHistory(prefs.get(KEY_HISTORY, []));
  let mode = prefs.get(KEY_MODE, null) === 'light' ? 'light' : prefs.get(KEY_MODE, null) === 'full' ? 'full' : null;
  const cleanups = [];

  // trocar de celular de verdade para a demonstração (ou o contrário): o teste da sessão não vale mais
  function syncBackend() {
    const backend = store.get().backend;
    if (session.backend === backend) return;
    session.backend = backend;
    if (!session.pending) session.run = null;
  }
  syncBackend();

  const connection = () => {
    const conn = store.get().connection;
    return conn && conn.connected ? conn : null;
  };
  const metered = () => !!(connection() && connection().metered === true);
  /** O modo que vale agora: o escolhido, ou "leve" por padrão num Wi-Fi com franquia. */
  const currentMode = () => mode || (metered() ? 'light' : 'full');
  const running = () => !!session.run && session.run.state === 'running';

  // --- teste ------------------------------------------------------------------------------

  function sampleLink(run) {
    const sample = store.get().rssi;
    const conn = connection();
    const rx = (sample && (isNum(sample.rxSpeed) ? sample.rxSpeed : sample.linkSpeed)) ?? (conn && (isNum(conn.rxSpeed) ? conn.rxSpeed : conn.linkSpeed));
    if (isNum(rx) && rx > 0) run.linkSamples.push(rx);
  }

  async function start() {
    if (!alive || !connection()) return;
    if (session.pending) {
      // o anterior ainda está fechando (cancelado ao sair da tela): espera para não misturar eventos
      await session.pending;
      if (!alive || session.pending) return;
    }
    const conn = connection();
    if (!conn) return;
    const run = {
      id: ++session.seq,
      mode: currentMode(),
      state: 'running',
      phase: 'latency',
      progress: 0,
      latencies: [],
      latencyMs: null,
      jitterMs: null,
      downMbps: null,
      upMbps: null,
      bytes: { latency: 0, download: 0, upload: 0 },
      bytesDown: 0,
      bytesUp: 0,
      server: null,
      error: null,
      record: null,
      cancelRequested: null,
      startedAt: Date.now(),
      endedAt: null,
      ssid: typeof conn.ssid === 'string' ? conn.ssid : '',
      linkSamples: [],
    };
    session.run = run;
    session.pendingRun = run;
    picked = null;
    sampleLink(run);
    session.pending = bridge.speedTest(run.mode).then(
      (summary) => finishRun(run, summary, prefs),
      () => finishRun(run, { ok: false, error: 'failed' }, prefs),
    );
    drawNow();
    const view = root.closest('.view');
    if (view) view.scrollTop = 0;
  }

  function cancel(by) {
    const run = session.run;
    if (!run || run.state !== 'running' || run.cancelRequested) return;
    run.cancelRequested = by;
    bridge.cancel('speed').catch(() => {});
    schedule();
  }

  function onSpeed(ev) {
    const run = session.run;
    if (!run || run.state !== 'running' || !ev || !PHASES.includes(ev.phase)) return;
    // as fases só andam para a frente (um evento atrasado da fase anterior é ignorado)
    if (PHASES.indexOf(ev.phase) < PHASES.indexOf(run.phase)) return;
    run.phase = ev.phase;
    run.progress = isNum(ev.progress) ? Math.max(0, Math.min(1, ev.progress)) : run.progress;
    if (isNum(ev.bytes) && ev.bytes >= 0) run.bytes[ev.phase] = ev.bytes;
    if (ev.phase === 'latency') {
      if (isNum(ev.ms) && ev.ms >= 0) {
        run.latencies.push(ev.ms);
        run.latencyMs = median(run.latencies);
      }
    } else if (isNum(ev.mbps) && ev.mbps >= 0) {
      if (ev.phase === 'download') {
        run.downMbps = ev.mbps;
        sampleLink(run);
      } else run.upMbps = ev.mbps;
    }
    schedule();
  }

  // --- o que mostrar ----------------------------------------------------------------------

  /** O que está na tela agora: um teste rodando, um resultado, um teste que parou, ou nada ainda. */
  function current() {
    const run = session.run;
    if (run && run.state === 'running') return { kind: 'running', run };
    if (picked) return { kind: 'record', record: picked, old: !history[0] || picked.ts !== history[0].ts };
    if (run && run.state === 'done' && run.record) return { kind: 'record', record: run.record, fresh: true };
    if (run && (run.state === 'cancelled' || run.state === 'error')) return { kind: 'stopped', run };
    if (history[0]) return { kind: 'record', record: history[0] };
    return { kind: 'empty' };
  }

  function modePicker(disabled) {
    const now = currentMode();
    const last = history[0];
    const estimate = estimateTestBytes(now, last && last.downMbps, last && last.upMbps);
    let caption;
    if (now === 'light') caption = `Cerca de 3${THIN}s em cada direção. Usa até cerca de ${formatBytes(LIGHT_MAX_BYTES)} de dados.`;
    else if (estimate) caption = `Cerca de 8${THIN}s em cada direção. Deve usar ≈${THIN}${formatBytes(estimate)} de dados (pela última medição).`;
    else caption = `Cerca de 8${THIN}s em cada direção. Usa cerca de 1${THIN}MB de dados para cada Mb/s da sua internet.`;
    return h(
      'div.tb-duration',
      { key: 'mode' },
      h(
        'div',
        { class: { 'tb-locked': disabled } },
        segmented(
          MODES,
          now,
          (value) => {
            if (disabled) return;
            mode = value;
            prefs.set(KEY_MODE, value);
            schedule();
          },
          { label: 'Tipo de teste' },
        ),
      ),
      h('p.tb-caption', null, caption),
    );
  }

  function meteredNote() {
    if (!metered()) return null;
    return banner({
      key: 'metered',
      tone: 'warning',
      icon: 'warning',
      title: 'Este Wi-Fi tem limite de dados',
      text: currentMode() === 'light' ? 'O celular marca esta rede como limitada (por exemplo, internet roteada de outro aparelho). O teste leve já está escolhido.' : 'O celular marca esta rede como limitada (por exemplo, internet roteada de outro aparelho). O teste completo pode consumir uma parte grande da franquia: prefira o leve.',
    });
  }

  function offlineNote() {
    if (connection()) return null;
    return banner({
      key: 'offline',
      tone: 'neutral',
      icon: 'wifi-off',
      title: 'Conecte-se a um Wi-Fi para testar',
      text: 'O teste roda só pelo Wi-Fi, para nunca gastar os dados móveis do chip por engano.',
      actions: [
        {
          label: 'Abrir o Wi-Fi',
          onClick: () => {
            if (store.get().backend === 'sim') {
              toast('Na demonstração não há configurações do Android para abrir.');
              return;
            }
            bridge.openSettings('wifi').catch(() => toast('Não foi possível abrir. Procure “Wi-Fi” nas configurações do Android.'));
          },
        },
      ],
    });
  }

  /** Primeira vez: sem mostrador vazio; o que o teste faz e quanto gasta vêm antes do botão. */
  function introCard() {
    return h(
      'section.card.tb-intro',
      { key: 'intro' },
      h('div.tb-intro__head', null, h('span.tb-idle__icon', null, icon('speed', { size: 28 })), h('div', null, h('h2.card__title', null, 'Meça a sua internet'), h('p.card__text', null, 'Download, upload e tempo de resposta em menos de meio minuto.'))),
      h('div.tb-facts', { key: 'about' }, aboutContent({ compact: true })),
      modePicker(false),
      button('Iniciar teste', { key: 'go', variant: 'primary', icon: 'play', block: true, onClick: start, disabled: !connection() }),
    );
  }

  function heroCard(now) {
    const isRunning = now.kind === 'running';
    const run = isRunning || now.kind === 'stopped' ? now.run : null;
    const rec = now.kind === 'record' ? now.record : null;
    const phase = isRunning ? run.phase : null;
    let src = rec || run || {};
    if (now.kind === 'stopped') {
      // teste que parou no meio: só valem os números das fases que chegaram ao fim
      const reached = PHASES.indexOf(run.phase);
      src = { latencyMs: reached > 0 ? run.latencyMs : null, downMbps: reached > 1 ? run.downMbps : null, upMbps: null, jitterMs: null };
    }

    const tiles = h(
      'div.tb-tiles',
      { key: 'tiles' },
      speedTile({ key: 'download', big: true, label: 'Download', icon: 'arrow-down', parts: speedParts(src.downMbps), active: phase === 'download', hint: rec ? 'o que chega até você' : undefined }),
      speedTile({ key: 'upload', big: true, label: 'Upload', icon: 'arrow-up', parts: speedParts(src.upMbps), active: phase === 'upload', hint: rec ? 'o que você envia' : undefined }),
      speedTile({ key: 'latency', label: 'Resposta', icon: 'ping', parts: msParts(src.latencyMs), active: phase === 'latency' }),
      speedTile({ key: 'jitter', label: 'Variação', icon: 'timeline', parts: msParts(isRunning ? null : src.jitterMs) }),
    );

    let status = null;
    if (isRunning) {
      const step = PHASES.indexOf(run.phase);
      const used = run.bytes.latency + run.bytes.download + run.bytes.upload;
      status = h(
        'div.tb-sum__progress',
        { key: 'progress' },
        meter(((step + run.progress) / PHASES.length) * 100, { label: 'Andamento do teste' }),
        h('p.tb-caption.num', null, run.cancelRequested ? 'Cancelando…' : `${step + 1} de 3 · ${PHASE_TEXT[run.phase]}`, used > 50_000 ? ` · ${formatBytes(used)} usados` : ''),
      );
    }

    let heading;
    if (isRunning) heading = h('div.tb-run', { key: 'head' }, h('h2.tb-run__title', null, run.mode === 'light' ? 'Teste leve' : 'Teste completo'), h('span.tb-run__state', null, spinner(), h('span', null, 'Em andamento')));
    else if (rec) {
      heading = h(
        'div.tb-run',
        { key: 'head' },
        h('h2.tb-run__title', null, now.fresh ? 'Resultado' : now.old ? 'Teste anterior' : 'Último teste'),
        h('span.tb-run__state.muted.num', null, now.fresh ? icon('check', { size: 16 }) : icon('clock', { size: 16 }), shortDate(rec.ts)),
      );
    } else heading = h('div.tb-run', { key: 'head' }, h('h2.tb-run__title', null, run.state === 'cancelled' ? 'Teste cancelado' : 'O teste não terminou'), h('span.tb-run__state.muted', null, icon(run.state === 'cancelled' ? 'stop' : 'alert-circle', { size: 16 }), run.state === 'cancelled' ? 'Interrompido' : 'Falhou'));

    return h(
      'section.card.tb-hero',
      { key: 'hero' },
      heading,
      h('div.tb-gauge', {
        key: 'gauge',
        keep: true,
        ref: (el) => {
          gaugeHost = el;
        },
      }),
      status,
      tiles,
      isRunning ? null : modePicker(false),
      isRunning
        ? button('Cancelar', { key: 'stop', variant: 'secondary', icon: 'stop', block: true, onClick: () => cancel('user'), disabled: !!run.cancelRequested })
        : button(now.kind === 'record' || now.kind === 'stopped' ? 'Testar de novo' : 'Iniciar teste', { key: 'go', variant: 'primary', icon: 'play', block: true, onClick: start, disabled: !connection() }),
    );
  }

  function stoppedNote(run) {
    const used = (run.bytesDown || 0) + (run.bytesUp || 0);
    const usedText = used > 50_000 ? ` Até parar, o teste usou ${formatBytes(used)} de dados.` : '';
    if (run.state === 'cancelled') {
      return banner({
        key: 'stopped',
        tone: 'neutral',
        icon: 'stop',
        title: run.cancelRequested === 'leave' ? 'O teste parou quando você saiu da tela' : 'Resultado incompleto',
        text: `${PHASES.indexOf(run.phase) > 0 ? 'Os números acima são só do que deu tempo de medir.' : 'O teste parou antes de medir qualquer coisa.'}${usedText}`,
      });
    }
    if (run.error === 'offline') {
      return banner({
        key: 'stopped',
        tone: 'critical',
        title: 'Sem acesso à internet',
        text: `O celular não conseguiu falar com os servidores de teste. Confira se a internet está funcionando neste Wi-Fi e tente de novo.${usedText}`,
        actions: [{ label: 'Tentar de novo', onClick: start }],
      });
    }
    return banner({
      key: 'stopped',
      tone: 'critical',
      title: 'O teste não conseguiu terminar',
      text: `A conexão caiu no meio da medição ou o servidor parou de responder. Tente de novo em instantes.${usedText}`,
      actions: [{ label: 'Tentar de novo', onClick: start }],
    });
  }

  function recordDetails(rec) {
    const verdict = speedVerdict(rec);
    const versus = wifiVsInternet({ downMbps: rec.downMbps, linkMbps: rec.linkMbps });
    const city = serverCity(rec.server);
    const total = rec.bytesDown + rec.bytesUp;
    return [
      banner({
        key: 'verdict',
        tone: verdict.tone,
        icon: verdict.tone === 'good' ? 'check-circle' : verdict.tone === 'warning' ? 'warning' : 'alert-circle',
        title: verdict.title,
        text: verdict.text,
      }),
      versus.bottleneck !== 'unknown'
        ? banner({
            key: 'versus',
            tone: versus.tone === 'good' ? 'neutral' : versus.tone,
            icon: versus.bottleneck === 'plan' ? 'globe' : 'wifi',
            title: versus.title,
            text: [versus.text, h('span.tb-estimate', null, ' Estimativa pela velocidade do link Wi-Fi durante o teste.')],
          })
        : null,
      sectionHeader('Detalhes do teste'),
      h(
        'section.card',
        { key: 'details' },
        kvList([
          ['Dados usados', total > 0 ? formatBytes(total) : null, total > 0 ? `download ${formatBytes(rec.bytesDown)} · upload ${formatBytes(rec.bytesUp)}` : undefined],
          ['Tipo de teste', rec.mode === 'light' ? 'Leve' : 'Completo'],
          rec.ssid ? ['Rede', ssidLabel(rec.ssid)] : null,
          isNum(rec.linkMbps) ? ['Link Wi-Fi no teste', fmtMbps(rec.linkMbps), 'a velocidade combinada entre o celular e o roteador'] : null,
          ['Servidor', rec.server ? (city ? `${city} (${rec.server})` : rec.server) : 'Cloudflare', rec.server ? 'Cloudflare' : undefined],
        ]),
      ),
    ];
  }

  function historyList(now) {
    if (history.length < 2 && !(history.length === 1 && now.kind !== 'record')) return null;
    const shown = now.kind === 'record' ? now.record : null;
    return [
      sectionHeader('Últimos testes', {
        count: history.length,
        action: running()
          ? undefined
          : {
              label: 'Apagar',
              icon: 'trash',
              onClick: async () => {
                const ok = await confirmDialog({ title: 'Apagar os testes guardados?', text: 'Os resultados anteriores do teste de velocidade serão apagados deste celular.', confirmLabel: 'Apagar', danger: true });
                if (!ok || !alive) return;
                history = [];
                picked = null;
                prefs.remove(KEY_HISTORY);
                if (session.run && session.run.state === 'done') session.run = null;
                drawNow();
              },
            },
      }),
      h(
        'div.card.card--flush.list',
        { key: 'history' },
        history.map((rec) =>
          h(
            'button.row.row--tappable.row--dense',
            {
              key: `rec-${rec.ts}`,
              type: 'button',
              'aria-current': shown && shown.ts === rec.ts ? 'true' : undefined,
              disabled: running(),
              onClick: () => {
                picked = rec;
                drawNow();
                const view = root.closest('.view');
                if (view) view.scrollTop = 0;
              },
            },
            h(
              'span.row__body',
              null,
              h('span.row__title.tb-rec', null, h('span.tb-rec__v', null, icon('arrow-down', { size: 16 }), fmtMbps(rec.downMbps)), h('span.tb-rec__v', null, icon('arrow-up', { size: 16 }), fmtMbps(rec.upMbps))),
              // data e resposta inteiras; o nome da rede (texto de fora) é quem encolhe com reticências
              h('span.row__sub.tb-sub.num', null, h('span', null, shortDate(rec.ts)), isNum(rec.latencyMs) ? h('span', null, fmtMs(rec.latencyMs)) : null, rec.ssid ? ssidLabel(rec.ssid) : null),
            ),
            rec.mode === 'light' ? h('span.row__trail', null, badge('Leve')) : null,
          ),
        ),
      ),
    ];
  }

  function view() {
    const now = current();
    if (now.kind === 'empty') return [offlineNote(), meteredNote(), introCard()];
    return [
      offlineNote(),
      meteredNote(),
      heroCard(now),
      now.kind === 'stopped' ? stoppedNote(now.run) : null,
      now.kind === 'record' ? recordDetails(now.record) : null,
      historyList(now),
      h(
        'p.tb-foot',
        { key: 'foot' },
        'O teste troca dados com os servidores da Cloudflare e roda só pelo Wi-Fi. ',
        h('button.tb-link', { type: 'button', onClick: openAbout }, 'Como funciona e quanto gasta'),
      ),
    ];
  }

  // --- mostrador --------------------------------------------------------------------------

  function syncGauge(now) {
    if (!gaugeHost || !gaugeHost.isConnected) {
      if (gauge) gauge.destroy();
      gauge = null;
      gaugeKey = '';
      return;
    }
    if (!gauge) {
      gauge = createGauge(gaugeHost, {
        min: 0,
        max: 100,
        format: (v) => fmtNum(v, v < 9.95 ? 1 : 0),
        formatTick: (v) => fmtNum(v),
        unit: 'Mb/s',
        ariaLabel: 'Velocidade',
        maxWidth: 300,
      });
      gaugeKey = '';
    }
    let key;
    let value = null;
    let unit = 'Mb/s';
    let label = '';
    let guess = 100;
    if (now.kind === 'running') {
      const run = now.run;
      key = `${run.id}:${run.phase}`;
      if (run.phase === 'latency') {
        unit = 'ms';
        label = 'Tempo de resposta';
        value = run.latencies.length ? run.latencies[run.latencies.length - 1] : null;
        guess = 50;
      } else if (run.phase === 'download') {
        label = 'Download';
        value = run.downMbps;
        guess = history[0] ? history[0].downMbps : 100;
      } else {
        label = 'Upload';
        value = run.upMbps;
        guess = history[0] ? history[0].upMbps : 50;
      }
    } else if (now.kind === 'record') {
      key = `rec:${now.record.ts}`;
      label = 'Download';
      value = now.record.downMbps;
      guess = value;
    } else {
      key = 'stopped';
      const run = now.run;
      // parou depois do download: o número medido continua valendo
      if (run && isNum(run.downMbps) && PHASES.indexOf(run.phase) > 1) {
        label = 'Download';
        value = run.downMbps;
        guess = value;
      } else label = run && run.state === 'cancelled' ? 'Cancelado' : 'Sem resultado';
    }

    if (key !== gaugeKey) {
      // fase nova: escala e unidade novas, e o arco recomeça do zero
      gaugeKey = key;
      rangeMax = gaugeMax(guess);
      gauge.set(null, { animate: false });
      gauge.setUnit(unit);
      gauge.setRange(0, rangeMax);
    }
    if (isNum(value) && value > rangeMax * 0.96) {
      rangeMax = gaugeMax(value);
      gauge.setRange(0, rangeMax);
    }
    gauge.set(value, { label });
  }

  function drawNow() {
    frame = 0;
    if (!alive) return;
    const now = current();
    gaugeHost = null;
    patch(root, view());
    syncGauge(now);
  }

  function schedule() {
    if (alive && !frame) frame = requestAnimationFrame(drawNow);
  }

  // --- ligações ---------------------------------------------------------------------------

  const onSessionChange = () => {
    history = sanitizeSpeedHistory(prefs.get(KEY_HISTORY, []));
    schedule();
  };
  session.onChange = onSessionChange;
  cleanups.push(() => {
    if (session.onChange === onSessionChange) session.onChange = null;
  });
  cleanups.push(bridge.on('speed', onSpeed));
  cleanups.push(store.subscribe((s) => s.connection, schedule));
  cleanups.push(
    store.subscribe((s) => s.backend, () => {
      syncBackend();
      schedule();
    }),
  );

  drawNow();

  return {
    unmount() {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      // o teste não continua às escondidas (nem gastando dados)
      const run = session.run;
      if (run && run.state === 'running' && !run.cancelRequested) {
        run.cancelRequested = 'leave';
        bridge.cancel('speed').catch(() => {});
      }
      for (const off of cleanups.splice(0)) off();
      if (gauge) gauge.destroy();
      gauge = null;
    },
  };
}
