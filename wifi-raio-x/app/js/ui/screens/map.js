// Mapa 3D: o mapa da casa feito só com o Wi-Fi. Esta tela é a "portaria" do fluxo inteiro:
//
//   #/mapa              biblioteca: explicação, "Novo mapa", rascunho em andamento, mapas salvos
//   #/mapa/novo         levantamento: a caminhada com as leituras, a prévia ao vivo, "Concluir"
//   #/mapa/ver/<id>     resultado de um mapa salvo
//   #/mapa/ver/novo     resultado do levantamento que acabou de ser concluído (ainda não salvo)
//
// Cada parte mora num arquivo de ui/map/ (library.js, survey.js, result.js) e é montada por aqui
// dentro do mesmo <div class="screen">; trocar de sub-rota não remonta a tela (onRoute).
//
// O que as partes recebem (`env`):
//   ctx                        o contexto da tela (main.js)
//   storage                    mapas salvos e rascunho, com tudo protegido: sem armazenamento o fluxo
//                              continua (o mapa aparece) e salvar explica o problema
//                                .ready -> Promise · .available · list() · get(id) · put(reg) · rename(id, nome)
//                                remove(id) · exportMap(id) · importMap(texto) · draft.load()/save()/clear()
//   session                    o que passa de uma parte para a outra sem ir para o disco:
//                                .start   {ownSsids, extraOwn, pilot}   pedido de levantamento novo
//                                .result  {survey, solution, model, ...} resultado recém-calculado
//   engine()                   -> Promise<motor> (mapping/engine.js), um só para a tela toda
//   sim()                      -> Promise<controles do simulador | null> (só na demonstração)
//   isDemo()                   o app está no modo demonstração?
//   go(caminho, {replace})     navega
//
// As folhas de estilo da tela (css/map.css e css/map-viewer.css) são carregadas na primeira visita.

import { h, mount as render } from '../dom.js';
import { spinner } from '../components.js';
import { mountLibrary } from '../map/library.js';

// ---------------------------------------------------------------------------
// Folhas de estilo (uma vez por documento)
// ---------------------------------------------------------------------------

let cssReady = null;

function loadCss(file, tag) {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(`../../../css/${file}`, import.meta.url).href;
    link.dataset.wrx = tag;
    const done = () => resolve();
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    // nunca prende a tela à espera de um arquivo de estilo
    setTimeout(done, 1500);
    document.head.appendChild(link);
  });
}

function ensureCss() {
  if (!cssReady) cssReady = Promise.all([loadCss('map.css', 'map'), loadCss('map-viewer.css', 'map-viewer')]);
  return cssReady;
}

// ---------------------------------------------------------------------------
// Armazenamento protegido
// ---------------------------------------------------------------------------

/** Mensagem para o usuário quando guardar não deu certo. */
export const STORAGE_PROBLEM = 'Este aparelho não deixou o app guardar o mapa (armazenamento indisponível ou cheio).';

/**
 * Embrulha o armazenamento de mapas (mapping/storage.js): nada aqui lança erro para as telas,
 * a não ser put/importMap/exportMap, cujo erro é a explicação que o usuário precisa ver.
 * Sem armazenamento, o rascunho fica só na memória (vale enquanto o app estiver aberto).
 */
function createStorage() {
  let store = null;
  let memoryDraft = null;
  const api = {
    available: false,
    error: null,
    ready: null,
    async list() {
      await api.ready;
      if (!store) return [];
      try {
        const list = await store.list();
        return Array.isArray(list) ? list : [];
      } catch (err) {
        console.warn('[mapa] não foi possível listar os mapas', err);
        return [];
      }
    },
    async get(id) {
      await api.ready;
      if (!store) return null;
      try {
        return (await store.get(id)) || null;
      } catch (err) {
        console.warn('[mapa] não foi possível abrir o mapa', err);
        return null;
      }
    },
    async put(record) {
      await api.ready;
      if (!store) throw new Error(STORAGE_PROBLEM);
      return store.put(record);
    },
    async rename(id, name) {
      await api.ready;
      if (!store) throw new Error(STORAGE_PROBLEM);
      return store.rename(id, name);
    },
    async remove(id) {
      await api.ready;
      if (!store) return;
      await store.remove(id);
    },
    async exportMap(id) {
      await api.ready;
      if (!store) throw new Error(STORAGE_PROBLEM);
      return store.exportMap(id);
    },
    async importMap(text) {
      await api.ready;
      if (!store) throw new Error(STORAGE_PROBLEM);
      return store.importMap(text);
    },
    draft: {
      async load() {
        await api.ready;
        if (!store) return memoryDraft;
        try {
          return (await store.draft.load()) || memoryDraft || null;
        } catch {
          return memoryDraft;
        }
      },
      async save(json) {
        memoryDraft = json;
        await api.ready;
        if (!store) return false;
        try {
          await store.draft.save(json);
          return true;
        } catch (err) {
          console.warn('[mapa] não foi possível guardar o rascunho', err);
          return false;
        }
      },
      async clear() {
        memoryDraft = null;
        await api.ready;
        if (!store) return;
        try {
          await store.draft.clear();
        } catch {
          // sem armazenamento não há o que limpar
        }
      },
    },
  };
  api.ready = (async () => {
    try {
      const mod = await import('../../mapping/storage.js');
      store = await mod.openMapStore();
      if (!store) throw new Error('sem armazenamento');
      api.available = store.available !== false && store.persistent !== false;
    } catch (err) {
      store = store || null;
      api.available = false;
      api.error = err;
      console.warn('[mapa] armazenamento de mapas indisponível', err);
    }
  })();
  return api;
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

function parse(route) {
  const sub = (route && route.sub) || [];
  if (!sub.length) return { view: 'library' };
  if (sub[0] === 'novo' && sub.length === 1) return { view: 'survey' };
  if (sub[0] === 'ver' && sub.length === 2 && sub[1]) return { view: 'result', id: sub[1] };
  return { view: 'redirect' };
}

export async function mount(root, ctx) {
  await ensureCss();

  let engine = null;
  let current = null; // { key, instance }
  let token = 0;
  let dead = false;

  const env = {
    ctx,
    storage: createStorage(),
    session: { start: null, result: null },
    isDemo: () => ctx.app.isDemo(),
    async sim() {
      if (!ctx.app.isDemo()) return null;
      try {
        const mod = await import('../../sim/backend.js');
        return mod.currentSim();
      } catch {
        return null;
      }
    },
    engine() {
      if (!engine) engine = import('../../mapping/engine.js').then((mod) => mod.createMapEngine());
      return engine;
    },
    go: (path, options) => ctx.navigate(path, options),
  };

  function leave() {
    const gone = current;
    current = null;
    if (gone && gone.instance && typeof gone.instance.unmount === 'function') {
      try {
        gone.instance.unmount();
      } catch (err) {
        console.error('[mapa] erro ao sair de', gone.key, err);
      }
    }
    ctx.setActions();
  }

  async function show(route) {
    const target = parse(route);
    if (target.view === 'redirect') {
      ctx.navigate('/mapa', { replace: true });
      return;
    }
    const key = target.view === 'result' ? `result:${target.id}` : target.view;
    if (current && current.key === key) return;
    const my = ++token;
    leave();
    root.className = 'screen';
    root.dataset.mapView = target.view;
    render(root, h('div.center.map-loading', null, spinner({ large: true, label: 'Abrindo' })));

    let instance = null;
    if (target.view === 'library') {
      ctx.setTitle('Mapa 3D');
      render(root);
      instance = mountLibrary(root, env);
    } else if (target.view === 'survey') {
      ctx.setTitle('Novo mapa');
      const mod = await import('../map/survey.js');
      if (my !== token || dead) return;
      render(root);
      instance = await mod.mountSurvey(root, env);
    } else {
      ctx.setTitle('Mapa');
      const mod = await import('../map/result.js');
      if (my !== token || dead) return;
      render(root);
      instance = await mod.mountResult(root, env, { id: target.id });
    }
    if (my !== token || dead) {
      // o usuário já foi para outro lugar enquanto esta parte montava
      if (instance && typeof instance.unmount === 'function') instance.unmount();
      return;
    }
    current = { key, instance };
  }

  await show(ctx.route);

  return {
    onRoute(route) {
      // um erro aqui vira o aviso "tentar de novo" da moldura
      return show(route);
    },
    unmount() {
      dead = true;
      token += 1;
      leave();
      if (engine) {
        engine.then((e) => e.dispose()).catch(() => {});
        engine = null;
      }
    },
  };
}
