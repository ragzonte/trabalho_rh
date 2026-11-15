// Partida do app, moldura (barra de cima, navegação) e roteador.
//
// Sequência: preferências -> tema -> ponte (celular ou simulador) -> info/status/conexão ->
// tabela de fabricantes em segundo plano -> laço de buscas -> roteador.
//
// ---------------------------------------------------------------------------------------------
// CONTRATO DAS TELAS
//
// Cada destino é um módulo com
//     export function mount(root, ctx) { ...; return { unmount() {}, onRoute?(route) {} }; }
// `root` é um <div class="screen"> vazio dentro da área que rola (ponha `screen--bleed` nele
// para ocupar tudo sem margens). mount pode ser async. Os módulos são carregados sob demanda
// (import()), então o código do mapa 3D e o three.js só são baixados quando a aba Mapa abre.
//
// ctx:
//   store       o estado do app (store.js). Inscrições feitas por aqui são canceladas sozinhas
//               ao sair da tela, e um erro dentro delas mostra o aviso "tentar de novo".
//   bridge      a ponte (bridge.js) para tudo o que NÃO é varredura: ping, conexão, compartilhar...
//   scanLoop    scanNow(), setMode('normal'|'mapping'|'paused'), getState()   (scan-loop.js)
//               O modo vale enquanto a tela estiver aberta: ao sair dela (ou se ela quebrar) o
//               roteador devolve o modo que estava antes, para uma pausa nunca ficar esquecida.
//   prefs       armazenamento "wrx.*" (prefs.js)
//   navigate(caminho, {replace})   ex.: ctx.navigate('/ferramentas/ping')
//   route       { path, tab, sub: string[], query: URLSearchParams }  a rota que abriu a tela
//   setTitle(texto)                troca o título da barra de cima enquanto a tela estiver aberta
//   setActions(...nós)             botões extras na barra de cima (iconButton de components.js)
//   onBack(fn)                     fn() é chamada no "voltar" antes de sair da tela; devolva true se tratou
//   onCleanup(fn)                  fn() roda ao sair da tela (além do unmount)
//   app         { version, hasNative, demoLocked, isDemo(), setDemo(ligado, {world}), reconnect(), goBack() }
//
// Sinal da rede conectada: o app mantém bridge.watchRssi(1000) ligado e guarda as leituras em
// store (state.rssi, store.rssiHistory()). Uma ferramenta que precise de leituras mais rápidas
// chama ctx.bridge.watchRssi(250) e, ao sair, ctx.bridge.watchRssi(1000).
// Posição da pessoa virtual na demonstração: ctx.bridge.on('sim', fn) (4 vezes por segundo; não
// passa pelo store). Controles do simulador: (await import('./sim/backend.js')).currentSim().
//
// Rotas: #/redes · #/canais · #/melhor · #/mapa · #/ferramentas · #/ferramentas/<id>
// Sub-rotas dos outros destinos (#/mapa/salvos/3) chegam à mesma tela: se ela devolveu
// onRoute, é avisada; senão é remontada.
//
// "Voltar" do Android (window.__wrx.back()): fecha painel -> onBack da tela -> sobe da sub-rota
// -> vai para Redes -> devolve false (o Android sai do app).
//
// Parâmetros de desenvolvimento e teste (na URL, antes do #), repassados ao simulador:
//   ?world=apartamento|sobrado|escritorio|kitnet&seed=1&speed=10&throttle=1
//   &permission=granted|denied|blocked&wifi=0&location=0&walk=auto|still|manual   e   &theme=dark|light
//
// Para testes: window.__wrx.app = { store, scanLoop, prefs, navigate, bridge, gates }
// e <html data-ready> quando a partida termina.
// ---------------------------------------------------------------------------------------------

import './polyfills.js'; // primeiro de tudo: completa o que falta em WebViews antigos
import * as bridge from './bridge.js';
import { createPrefs } from './prefs.js';
import { createStore } from './store.js';
import { createScanLoop } from './scan-loop.js';
import { loadOui } from './core/oui.js';
import { h, mount as render, sheet, toast, closeTopOverlay, cssVar, fmtAgo } from './ui/dom.js';
import { icon } from './ui/icons.js';
import { button, iconButton, emptyState, errorState, skeletonList, openThrottleHelp } from './ui/components.js';
import { createGates } from './ui/gates.js';
import { toolById } from './ui/screens/tools.js';

const TABS = [
  { id: 'redes', title: 'Redes', icon: 'wifi', load: () => import('./ui/screens/networks.js') },
  { id: 'canais', title: 'Canais', icon: 'channels', load: () => import('./ui/screens/channels.js') },
  { id: 'melhor', title: 'Melhor Wi-Fi', icon: 'trophy', load: () => import('./ui/screens/best.js') },
  { id: 'mapa', title: 'Mapa 3D', icon: 'cube', load: () => import('./ui/screens/map.js') },
  { id: 'ferramentas', title: 'Ferramentas', icon: 'tools', load: () => import('./ui/screens/tools.js') },
];
const HOME = 'redes';
const SIM_PARAMS = ['world', 'seed', 'speed', 'throttle', 'permission', 'permissionReply', 'wifi', 'location', 'walk', 'hostile'];
/** dados mais velhos que isto ganham destaque na barra de cima */
const STALE_MS = 60_000;

// ---------------------------------------------------------------------------
// Estado da moldura
// ---------------------------------------------------------------------------

const prefs = createPrefs();
const store = createStore({ prefs });
const scanLoop = createScanLoop({ bridge, store });

const url = new URL(location.href);
const urlSim = {};
for (const key of SIM_PARAMS) if (url.searchParams.has(key)) urlSim[key] = url.searchParams.get(key);
const urlWantsSim = Object.keys(urlSim).length > 0;
let urlTheme = ['dark', 'light'].includes(url.searchParams.get('theme')) ? url.searchParams.get('theme') : null;

const appEl = document.getElementById('app');
let ui = null; // nós da moldura, criados em buildShell()
let gates = null;
let current = null; // { key, route, root, scope, instance }
let currentRoute = null;
let navToken = 0;
let connected = false;
const scrollMemo = new Map();
const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------

function resolvedTheme() {
  const setting = urlTheme || store.get().settings.theme;
  if (setting === 'dark' || setting === 'light') return setting;
  return darkQuery && !darkQuery.matches ? 'light' : 'dark';
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  store.setTheme(theme);
  const bg = cssVar('--bg') || (theme === 'dark' ? '#0a0f1c' : '#f3f5f9');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
  // as barras do sistema acompanham o fundo do app
  if (connected) bridge.setBars(bg, theme === 'dark').catch(() => {});
}

// ---------------------------------------------------------------------------
// Ponte
// ---------------------------------------------------------------------------

const wantSim = () => !bridge.hasNative() || urlWantsSim || store.get().settings.demo;

let simWorld = null; // casa virtual carregada no simulador em uso

async function connect() {
  const sim = wantSim();
  const options = sim ? { world: store.get().settings.demoWorld, ...urlSim } : undefined;
  const kind = await bridge.connect(sim ? 'sim' : 'native', options);
  connected = true;
  simWorld = sim ? options.world : null;
  const safe = (promise) => promise.catch(() => null);
  const [info, status, connection] = await Promise.all([safe(bridge.info()), safe(bridge.status()), safe(bridge.connection())]);
  store.batch(() => {
    store.setBackend(kind);
    store.setInfo(info);
    store.setStatus(status);
    store.setConnection(connection);
  });
  bridge.watchRssi(1000).catch(() => {});
  applyTheme();
}

let reconnecting = null;
/** Troca de quem responde (celular <-> simulador) sem recarregar a página. */
function reconnect() {
  if (reconnecting) return reconnecting;
  reconnecting = (async () => {
    scanLoop.stop();
    // saindo do celular de verdade: ele para de mandar o sinal a cada segundo (a ponte já descarta
    // os eventos dele enquanto o simulador responde; isto só poupa o trabalho)
    if (bridge.kind() === 'native') bridge.unwatchRssi().catch(() => {});
    store.resetScanData();
    try {
      await connect();
    } finally {
      scanLoop.reset();
      scanLoop.start();
      reconnecting = null;
    }
  })();
  return reconnecting;
}

/** Garante que quem responde é quem os ajustes pedem (chamado quando `demo`/`demoWorld` mudam). */
function syncBackend() {
  const { backend, settings } = store.get();
  const sim = wantSim();
  const worldChanged = sim && backend === 'sim' && !urlSim.world && settings.demoWorld !== simWorld;
  if (!connected || ((backend === 'sim') === sim && !worldChanged)) return Promise.resolve();
  return reconnect().catch((err) => {
    console.error('[app] não foi possível trocar de modo', err);
    toast('Não foi possível trocar de modo agora. Tente de novo.');
  });
}

/** Liga/desliga o modo demonstração (e escolhe a casa virtual). Resolve quando a troca terminou. */
async function setDemo(on, { world } = {}) {
  const patchSettings = { demo: !!on };
  if (typeof world === 'string') patchSettings.demoWorld = world;
  store.updateSettings(patchSettings); // o ouvinte dos ajustes chama syncBackend()
  await syncBackend();
  if (reconnecting) await reconnecting.catch(() => {});
}

function wireBridge() {
  bridge.on('status', (status) => store.setStatus(status));
  bridge.on('connection', (conn) => store.setConnection(conn));
  bridge.on('rssi', (sample) => store.setRssi(sample));
  bridge.onBack(handleBack);
}

// ---------------------------------------------------------------------------
// Moldura
// ---------------------------------------------------------------------------

function buildShell() {
  const title = h('h1.topbar__title', null, '');
  const status = h('span.topbar__status', { 'aria-live': 'off' }, '');
  const back = iconButton('arrow-left', 'Voltar', () => goUp(), { class: 'icon-btn topbar__back', hidden: true });
  const pill = h(
    'button.pill',
    { type: 'button', hidden: true, 'aria-label': 'Modo demonstração: saiba mais', onClick: openDemoSheet },
    icon('flask', { size: 14 }),
    h('span.pill__full', null, 'Demonstração'),
    h('span.pill__short', null, 'Demo'),
  );
  const custom = h('div.topbar__actions');
  const scanDot = h('span.scan-btn__dot', { hidden: true });
  const scanBtn = h('button.icon-btn.scan-btn', { type: 'button', 'aria-label': 'Buscar redes agora', onClick: onScanTap }, icon('refresh'), scanDot);
  const settingsBtn = iconButton('settings', 'Ajustes', () => navigate('/ferramentas/ajustes'), { class: 'icon-btn topbar__settings' });
  const topbar = h('header.topbar', null, back, h('div.topbar__heading', null, title, status), pill, custom, scanBtn, settingsBtn);

  const view = h('main.view', { id: 'view', tabIndex: -1 });
  view.addEventListener(
    'scroll',
    () => {
      if (view.scrollTop > 2) topbar.dataset.scrolled = '';
      else delete topbar.dataset.scrolled;
    },
    { passive: true },
  );

  const links = new Map();
  const nav = h(
    'nav.bottomnav',
    { 'aria-label': 'Seções do app' },
    TABS.map((tab) => {
      const a = h('a.bottomnav__item', { href: `#/${tab.id}`, dataset: { tab: tab.id } }, h('span.bottomnav__icon', null, icon(tab.icon)), h('span', null, tab.title));
      links.set(tab.id, a);
      return a;
    }),
  );

  render(appEl, topbar, view, nav);
  ui = { topbar, title, status, back, pill, custom, scanBtn, scanDot, settingsBtn, view, nav, links };
}

function updateChrome(route) {
  const tab = TABS.find((t) => t.id === route.tab);
  const tool = route.tab === 'ferramentas' && route.sub.length ? toolById(route.sub[0]) : null;
  const titleText = tool ? tool.title : tab.title;
  ui.title.textContent = titleText;
  document.title = `${titleText} · WiFi Raio-X`;
  const isSub = route.sub.length > 0;
  ui.back.hidden = !isSub;
  ui.settingsBtn.hidden = isSub;
  if (isSub) ui.topbar.dataset.sub = '';
  else delete ui.topbar.dataset.sub;
  for (const [id, a] of ui.links) {
    if (id === route.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

/** Linha de estado sob o título: idade dos dados, sem fingir que dado velho é ao vivo. */
function updateStatusLine() {
  if (!ui) return;
  const { scan, loop, backend } = store.get();
  let text;
  let tone = null;
  // com dados na tela a idade continua à vista durante a busca (quem gira é o ícone)
  if (scan.scanning && !scan.dataAt) text = 'Buscando redes…';
  else if (!scan.dataAt && scan.seq > 0) text = 'Lista guardada pelo celular';
  else if (!scan.dataAt) text = loop.paused ? 'Busca em pausa' : 'Aguardando a primeira busca';
  else {
    const age = Date.now() - scan.dataAt;
    text = age < 2000 ? 'Atualizado agora' : `Atualizado ${fmtAgo(age)}`;
    if (age > STALE_MS) tone = 'warn';
    if (loop.paused === 'mode') text = `Em pausa · ${fmtAgo(age)}`;
  }
  if (ui.status.textContent !== text) ui.status.textContent = text;
  if (tone) ui.status.dataset.tone = tone;
  else delete ui.status.dataset.tone;

  if (scan.scanning) ui.scanBtn.dataset.scanning = '';
  else delete ui.scanBtn.dataset.scanning;
  ui.scanDot.hidden = !loop.throttled;
  ui.scanBtn.setAttribute('aria-label', loop.throttled ? 'Buscar redes agora. O Android está limitando as buscas.' : 'Buscar redes agora');
  ui.pill.hidden = backend !== 'sim';
}

async function onScanTap() {
  const res = await scanLoop.scanNow();
  if (!res || res.accepted || res.reason === 'busy' || res.reason === 'paused') return;
  if (res.reason === 'throttled') {
    const { scan } = store.get();
    const age = scan.dataAt ? ` Mostrando a lista de ${fmtAgo(Date.now() - scan.dataAt)}.` : '';
    toast(`O Android limitou as buscas por enquanto.${age}`, { action: { label: 'Por quê?', onClick: () => openThrottleHelp({ bridge, store }) } });
  } else {
    toast('Não deu para buscar agora. Tente de novo em instantes.');
  }
}

function openDemoSheet() {
  const canLeave = bridge.hasNative() && !urlWantsSim;
  const panel = sheet({
    title: 'Modo demonstração',
    content: h(
      'div.prose',
      null,
      h('p', null, 'Você está vendo uma ', h('strong', null, 'casa virtual'), ': as redes, os sinais e os aparelhos são simulados, com uma pessoa andando pelos cômodos. Serve para conhecer o app sem depender do Wi-Fi de verdade.'),
      h('p', null, canLeave ? 'Para analisar o seu Wi-Fi, desligue a demonstração.' : 'Neste navegador o app não tem acesso ao Wi-Fi do aparelho; no celular, com o app instalado, ele analisa as redes de verdade.'),
    ),
    footer: [
      button('Escolher outra casa', {
        variant: 'secondary',
        onClick: () => {
          panel.close();
          navigate('/ferramentas/ajustes');
        },
      }),
      canLeave
        ? button('Usar o Wi-Fi de verdade', {
            variant: 'primary',
            onClick: () => {
              panel.close();
              setDemo(false);
            },
          })
        : null,
    ],
  });
}

// ---------------------------------------------------------------------------
// Roteador
// ---------------------------------------------------------------------------

function parseRoute(hash) {
  const text = String(hash || '').replace(/^#/, '');
  const [pathPart, queryPart = ''] = text.split('?');
  const parts = pathPart.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const tab = TABS.find((t) => t.id === parts[0]);
  if (!tab) return null;
  let sub = parts.slice(1);
  // ferramenta que não existe: fica no menu
  if (tab.id === 'ferramentas' && sub.length && !toolById(sub[0])) sub = [];
  return { path: `/${[tab.id, ...sub].join('/')}`, tab: tab.id, sub, query: new URLSearchParams(queryPart) };
}

function navigate(path, { replace = false } = {}) {
  const hash = `#${String(path).replace(/^#/, '')}`;
  if (location.hash === hash) return;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function goUp() {
  const r = currentRoute;
  if (!r) return;
  if (r.sub.length) navigate(`/${[r.tab, ...r.sub.slice(0, -1)].join('/')}`, { replace: true });
  else if (r.tab !== HOME) navigate(`/${HOME}`, { replace: true });
}

function handleBack() {
  if (closeTopOverlay()) return true;
  if (gates && gates.isUp()) return false;
  if (current && current.scope) {
    for (const fn of [...current.scope.backHandlers].reverse()) {
      try {
        if (fn() === true) return true;
      } catch (err) {
        console.error('[app] erro no "voltar" da tela', err);
      }
    }
  }
  const r = currentRoute;
  if (!r) return false;
  if (r.sub.length || r.tab !== HOME) {
    goUp();
    return true;
  }
  return false;
}

/** A chave diz quando duas rotas são "a mesma tela" (sem remontar). */
function screenKey(route) {
  return route.tab === 'ferramentas' && route.sub.length ? `ferramentas/${route.sub[0]}` : route.tab;
}

function moduleFor(route, attempt) {
  if (route.tab === 'ferramentas' && route.sub.length) {
    // por convenção: ui/tools/<id>.js (o id já foi conferido contra a lista de ferramentas)
    const tool = toolById(route.sub[0]);
    const file = `./ui/tools/${tool.file || tool.id}.js`;
    return { url: new URL(file, import.meta.url).href, load: () => import(attempt ? `${file}?t=${attempt}` : file) };
  }
  const tab = TABS.find((t) => t.id === route.tab);
  return { url: null, load: tab.load };
}

function makeScope(route) {
  const scope = { route, dead: false, cleanups: [], backHandlers: [], failed: false, loopMode: scanLoop.getState().mode };
  // store "da tela": as inscrições morrem com ela e um erro num ouvinte vira o aviso de erro
  const scoped = Object.create(store);
  scoped.subscribe = (selector, listener, options) => {
    const off = store.subscribe(
      selector,
      (...args) => {
        if (scope.dead) return;
        try {
          listener(...args);
        } catch (err) {
          failScreen(scope, err);
        }
      },
      options,
    );
    scope.cleanups.push(off);
    return off;
  };
  scope.ctx = {
    store: scoped,
    bridge,
    scanLoop,
    prefs,
    navigate,
    route,
    setTitle(text) {
      if (!scope.dead && ui) ui.title.textContent = String(text ?? '');
    },
    setActions(...nodes) {
      if (!scope.dead && ui) render(ui.custom, nodes);
    },
    onBack(fn) {
      if (typeof fn !== 'function') return () => {};
      scope.backHandlers.push(fn);
      return () => {
        const i = scope.backHandlers.indexOf(fn);
        if (i >= 0) scope.backHandlers.splice(i, 1);
      };
    },
    onCleanup(fn) {
      if (typeof fn === 'function') scope.cleanups.push(fn);
    },
    app: {
      get version() {
        return store.get().info?.appVersion || '';
      },
      hasNative: bridge.hasNative(),
      // a demonstração foi imposta pela URL ou pela falta do celular (não dá para desligar)
      demoLocked: !bridge.hasNative() || urlWantsSim,
      isDemo: () => store.get().backend === 'sim',
      setDemo,
      reconnect,
      goBack: goUp,
    },
  };
  return scope;
}

function disposeScope(entry) {
  if (!entry) return;
  const { scope, instance } = entry;
  scope.dead = true;
  try {
    if (instance && typeof instance.unmount === 'function') instance.unmount();
  } catch (err) {
    console.error('[app] erro ao sair da tela', err);
  }
  for (const fn of scope.cleanups.splice(0)) {
    try {
      fn();
    } catch (err) {
      console.error('[app] erro ao limpar a tela', err);
    }
  }
  scope.backHandlers.length = 0;
  // a tela pode ter pausado ou acelerado as buscas e não ter devolvido (ou ter quebrado antes)
  if (scanLoop.getState().mode !== scope.loopMode) scanLoop.setMode(scope.loopMode);
}

/** Erro inesperado numa tela: aviso amigável com "tentar de novo", sem derrubar o resto do app. */
function failScreen(scope, err) {
  if (scope.failed) return;
  scope.failed = true;
  console.error('[app] erro na tela', scope.route.path, err);
  // depois do que estiver rodando agora (o erro pode ter vindo de dentro do próprio mount)
  queueMicrotask(() => {
    if (!current || current.scope !== scope) return;
    const { root } = current;
    disposeScope(current);
    current = { key: current.key, route: scope.route, root, scope, instance: null };
    render(ui.custom);
    root.className = 'screen';
    render(root, errorState({ onRetry: () => show(scope.route, { force: true }) }));
  });
}

let retries = 0;

async function show(route, { force = false } = {}) {
  const key = screenKey(route);
  const previous = currentRoute;
  currentRoute = route;
  updateChrome(route);

  if (!force && current && current.key === key && current.instance && !current.scope.failed) {
    if (previous && previous.path === route.path && String(previous.query) === String(route.query)) return;
    if (typeof current.instance.onRoute === 'function') {
      current.scope.ctx.route = route;
      try {
        current.instance.onRoute(route);
      } catch (err) {
        failScreen(current.scope, err);
      }
      return;
    }
  }

  const token = ++navToken;
  const hadFocusInside = current && current.root.contains(document.activeElement);
  if (current) {
    if (current.instance) scrollMemo.set(current.key, ui.view.scrollTop);
    disposeScope(current);
    current = null;
  }
  render(ui.custom);

  const scope = makeScope(route);
  const root = h('div.screen', { dataset: { screen: key } });
  render(ui.view, root);
  ui.view.scrollTop = 0;
  delete ui.topbar.dataset.scrolled;
  if (hadFocusInside) ui.view.focus({ preventScroll: true });
  current = { key, route, root, scope, instance: null };

  // esqueleto só se o módulo demorar (primeira visita com rede lenta)
  const skeleton = setTimeout(() => {
    if (token === navToken && !root.firstChild) render(root, skeletonList(6));
  }, 150);

  const { url: moduleUrl, load } = moduleFor(route, force ? ++retries : 0);
  let mod;
  try {
    mod = await load();
  } catch (err) {
    clearTimeout(skeleton);
    if (token !== navToken) return;
    if (moduleUrl && (await isMissing(moduleUrl))) {
      if (token === navToken) showComingSoon(root, route);
      return;
    }
    failScreen(scope, err);
    return;
  }
  clearTimeout(skeleton);
  if (token !== navToken) return;

  let instance = null;
  try {
    if (!mod || typeof mod.mount !== 'function') throw new Error(`a tela ${key} não exporta mount()`);
    render(root);
    instance = (await mod.mount(root, scope.ctx)) || null;
  } catch (err) {
    failScreen(scope, err);
    return;
  }
  if (token !== navToken || scope.dead) {
    // o usuário já saiu daqui enquanto a tela montava
    if (!scope.dead) disposeScope({ scope, instance });
    else if (instance && typeof instance.unmount === 'function') {
      try {
        instance.unmount();
      } catch {
        // nada a fazer
      }
    }
    return;
  }
  current.instance = instance;
  const top = scrollMemo.get(key);
  if (top && !force) ui.view.scrollTop = top;
}

// O módulo não existe (ferramenta ainda não escrita) ou existe e quebrou ao carregar?
async function isMissing(moduleUrl) {
  try {
    const res = await fetch(moduleUrl, { cache: 'no-store' });
    return res.status === 404;
  } catch {
    return false;
  }
}

function showComingSoon(root, route) {
  const tool = toolById(route.sub[0]);
  render(
    root,
    emptyState({
      icon: tool ? tool.icon : 'tools',
      tone: 'accent',
      title: 'Em breve',
      text: tool ? `${tool.name}: ${tool.desc.charAt(0).toLowerCase()}${tool.desc.slice(1)}. Esta ferramenta chega numa próxima versão.` : 'Esta ferramenta chega numa próxima versão.',
      secondary: { label: 'Voltar para Ferramentas', onClick: () => navigate('/ferramentas', { replace: true }) },
    }),
  );
}

function onHashChange() {
  const route = parseRoute(location.hash);
  if (!route) {
    navigate(`/${HOME}`, { replace: true });
    return;
  }
  void show(route);
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

let lastErrorToast = 0;
function onGlobalError(ev) {
  const reason = ev && (ev.error || ev.reason || ev.message);
  const text = String((reason && reason.message) || reason || '');
  if (/ResizeObserver loop/i.test(text)) return;
  console.error('[app] erro não tratado', reason);
  // no máximo um aviso a cada 10 s: um erro que se repete a cada leitura não pode virar chuva de avisos
  const t = Date.now();
  if (t - lastErrorToast < 10_000 || !ui) return;
  lastErrorToast = t;
  toast('Algo deu errado. Se a tela travar, recarregue.', { action: { label: 'Recarregar tela', onClick: () => currentRoute && show(currentRoute, { force: true }) } });
}

function showBootError(err) {
  console.error('[app] falha na partida', err);
  const splash = document.getElementById('splash');
  if (splash) splash.remove();
  appEl.hidden = false;
  const actions = { label: 'Tentar de novo', icon: 'refresh', onClick: () => location.reload() };
  render(appEl, h('div.screen', { style: { gridArea: 'view' } }, errorState({ title: 'O app não conseguiu abrir', text: 'Feche e abra de novo. Se continuar, reinstale o app.', onRetry: actions.onClick })));
}

// ---------------------------------------------------------------------------
// Partida
// ---------------------------------------------------------------------------

async function boot() {
  applyTheme();
  if (darkQuery) darkQuery.addEventListener('change', applyTheme);
  store.subscribe((s) => s.settings.theme, () => {
    urlTheme = null; // escolher um tema nos ajustes vale mais que o parâmetro da URL
    applyTheme();
  });
  store.subscribe((s) => `${s.settings.demo}|${s.settings.demoWorld}`, () => void syncBackend());

  window.addEventListener('error', onGlobalError);
  window.addEventListener('unhandledrejection', onGlobalError);

  wireBridge();
  await connect();

  buildShell();
  gates = createGates({
    store,
    bridge,
    onDemo: async () => {
      await setDemo(true);
      toast('Modo demonstração ligado. Para sair, abra os Ajustes.');
    },
  });

  // fabricantes: carrega em segundo plano; a lista aparece antes e ganha os nomes depois
  loadOui(new URL('../assets/oui.json', import.meta.url).href).then((lookup) => store.setVendorLookup(lookup));

  store.subscribe((s) => s.scan, updateStatusLine);
  store.subscribe((s) => s.loop, updateStatusLine);
  store.subscribe((s) => s.backend, updateStatusLine);
  setInterval(() => !document.hidden && updateStatusLine(), 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    updateStatusLine();
    // ao voltar das configurações do Android, confere de novo o que mudou
    gates.refresh();
    bridge.connection().then((conn) => store.setConnection(conn)).catch(() => {});
  });

  scanLoop.start();

  window.addEventListener('hashchange', onHashChange);
  const first = parseRoute(location.hash);
  if (first) await show(first);
  else {
    history.replaceState(null, '', `${location.pathname}${location.search}#/${HOME}`);
    await show(parseRoute(`#/${HOME}`));
  }

  const splash = document.getElementById('splash');
  if (splash) splash.remove();
  appEl.hidden = false;
  updateStatusLine();

  const hook = (globalThis.__wrx = globalThis.__wrx || {});
  hook.app = { store, scanLoop, prefs, navigate, bridge, gates };
  document.documentElement.dataset.ready = '';
}

boot().catch(showBootError);
