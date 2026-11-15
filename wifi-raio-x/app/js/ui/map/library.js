// Mapa 3D — biblioteca (#/mapa): a porta de entrada do recurso.
//
//   mountLibrary(root, env) -> { unmount() }
//       explicação em três passos, a promessa honesta, "Novo mapa", a demonstração automática
//       (só no modo demonstração), o rascunho em andamento, os mapas salvos e "Importar".
//   openStartSheet(env, { onStart })
//       o passo "antes de começar": quais redes são do usuário, as três dicas e, com o Android
//       limitando as buscas, a explicação do mapeamento "ponto a ponto".
//   defaultOwnSsids(store) -> string[]      as redes já marcadas (conectada + favoritas)
//
// Peças usadas também pelas outras partes do mapa:
//   actionSheet({ title, subtitle, actions })        menu de ações num painel inferior
//   promptSheet({ title, label, value, ... })        -> Promise<string|null>  pede um texto
//   draftSummaryText(draft)                          "42 leituras · 3 lugares marcados"
//
// Todo nome que vem de fora (mapa, rede, lugar) entra na página como texto, via h().

import { h, patch, sheet, toast, confirmDialog, fmtDateTime, fmtAgo, plural } from '../dom.js';
import { icon } from '../icons.js';
import { button, iconButton, badge, banner, sectionHeader, ssidLabel, signalBars, openThrottleHelp, spinner } from '../components.js';
import { candidateNetworks, metaLine, readRecord, cleanMapName, qualityInfo } from './map-ui-logic.js';

// ---------------------------------------------------------------------------
// Peças compartilhadas
// ---------------------------------------------------------------------------

/**
 * Menu de ações num painel inferior.
 * @param {{title:string, subtitle?:string, actions:({icon?:string, label:string, hint?:string, danger?:boolean, onClick:() => void}|null|false)[]}} o
 */
export function actionSheet({ title, subtitle, actions }) {
  const panel = sheet({
    title,
    subtitle,
    content: h(
      'div.map-actions',
      null,
      actions.filter(Boolean).map((a) =>
        h(
          'button.row.row--tappable',
          {
            type: 'button',
            class: a.danger ? 'map-actions__danger' : null,
            onClick: () => {
              panel.close();
              a.onClick();
            },
          },
          a.icon ? h('span', { class: ['row__icon', !a.danger && 'row__icon--neutral'] }, icon(a.icon)) : null,
          h('span.row__body', null, h('span.row__title', null, a.label), a.hint ? h('span.row__sub', null, a.hint) : null),
        ),
      ),
    ),
  });
  return panel;
}

/**
 * Pede um texto curto num painel inferior. Resolve com o texto (já aparado) ou null se o
 * usuário desistiu. `validate(texto)` devolve uma mensagem de erro ou null.
 */
export function promptSheet({ title, subtitle, label, value = '', placeholder, hint, confirmLabel = 'Salvar', maxLength = 60, inputMode, validate, allowEmpty = false }) {
  return new Promise((resolve) => {
    let answer = null;
    const error = h('span.field__error', { hidden: true, role: 'alert' });
    const input = h('input.input', { type: 'text', value, placeholder, maxlength: maxLength, inputmode: inputMode, autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'false', 'aria-label': label });
    const submit = () => {
      const text = input.value.trim();
      const problem = !text && !allowEmpty ? 'Digite alguma coisa.' : validate ? validate(text) : null;
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      answer = text;
      panel.close();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    });
    input.addEventListener('input', () => {
      error.hidden = true;
      input.removeAttribute('aria-invalid');
    });
    const panel = sheet({
      title,
      subtitle,
      content: h('label.field', null, h('span.field__label', null, label), input, error, hint ? h('span.field__hint', null, hint) : null),
      footer: [button('Cancelar', { variant: 'secondary', onClick: () => panel.close() }), button(confirmLabel, { variant: 'primary', onClick: submit })],
      onClose: () => resolve(answer),
    });
    // o foco vai para o campo (o painel já abriu com o foco nele mesmo)
    setTimeout(() => {
      if (panel.isOpen()) {
        input.focus({ preventScroll: true });
        input.select();
      }
    }, 60);
  });
}

/** "42 leituras · 3 lugares marcados" para o cartão do rascunho. */
export function draftSummaryText(draft) {
  const s = (draft && draft.summary) || {};
  const parts = [plural(s.scans || 0, 'leitura', 'leituras')];
  if (s.spots) parts.push(plural(s.spots, 'lugar marcado', 'lugares marcados'));
  return parts.join(' · ');
}

/** As redes que já começam marcadas como "minhas": a conectada e as favoritas. */
export function defaultOwnSsids(store) {
  return candidateNetworks(store.get())
    .filter((n) => n.selected)
    .map((n) => n.ssid);
}

// ---------------------------------------------------------------------------
// Antes de começar
// ---------------------------------------------------------------------------

const TIPS = [
  { icon: 'walk', title: 'Ande devagar e por todos os cômodos', text: 'O app lê o Wi-Fi a cada poucos segundos. Quanto mais cantos da casa você visitar, melhor o mapa.' },
  { icon: 'pin', title: 'Pare e marque cada cômodo com o nome', text: 'Toque em “Marcar este lugar”, fique parado alguns segundos e siga andando.' },
  { icon: 'floor-up', title: 'Ao trocar de andar, avise', text: 'Mude o controle “Andar” assim que chegar ao outro piso.' },
];

/**
 * Painel "Antes de começar".
 * @param {object} env
 * @param {{onStart:(start:{ownSsids:string[], extraOwn:string[]}) => void}} o
 */
export function openStartSheet(env, { onStart }) {
  const { ctx } = env;
  const state = ctx.store.get();
  const nets = candidateNetworks(state);
  const chosen = new Set(nets.filter((n) => n.selected).map((n) => n.ssid));
  const throttled = !!state.loop.throttled;

  const netRows = nets.length
    ? h(
        'div.map-nets',
        null,
        nets.map((n) => {
          const id = `own-${Math.random().toString(36).slice(2, 9)}`;
          return h(
            'label.row.map-nets__row',
            { for: id },
            h('span.row__lead', null, signalBars(n.rssi ?? -100)),
            h(
              'span.row__body',
              null,
              h('span.row__title', null, ssidLabel(n.ssid)),
              h('span.row__sub', null, n.connected ? 'Conectada agora' : n.favorite ? 'Marcada como minha rede' : n.sameDevice ? 'Do mesmo roteador da rede conectada' : n.count > 1 ? `${n.count} sinais por perto` : 'Por perto'),
            ),
            h('input.switch', {
              id,
              type: 'checkbox',
              role: 'switch',
              checked: chosen.has(n.ssid),
              onChange: (ev) => {
                if (ev.currentTarget.checked) chosen.add(n.ssid);
                else chosen.delete(n.ssid);
              },
            }),
          );
        }),
      )
    : h('p.muted.t-sm', null, 'Nenhuma rede apareceu ainda. Você pode começar assim mesmo: as redes ouvidas durante a caminhada entram no mapa.');

  const panel = sheet({
    title: 'Antes de começar',
    subtitle: 'Leva de 3 a 10 minutos, conforme o tamanho da casa.',
    tall: true,
    content: h(
      'div.map-start',
      null,
      throttled
        ? banner({
            tone: 'warning',
            icon: 'clock',
            title: 'O mapa será feito ponto a ponto',
            text: 'O Android está limitando as buscas: chega uma leitura a cada 30 segundos, mais ou menos. Em vez de andar sem parar, vá de cômodo em cômodo, marque o lugar e espere parado a leitura chegar. Dá para liberar buscas rápidas nas opções do desenvolvedor.',
            actions: [{ label: 'Como liberar', onClick: () => openThrottleHelp(ctx) }],
          })
        : null,
      h(
        'section.map-start__block',
        null,
        h('h3.map-start__h', null, 'Como funciona'),
        h(
          'ol.map-tips',
          null,
          TIPS.map((tip) => h('li.map-tip', null, h('span.map-tip__icon', null, icon(tip.icon)), h('div.map-tip__body', null, h('strong', null, tip.title), h('span', null, tip.text)))),
        ),
      ),
      h(
        'section.map-start__block',
        null,
        h('h3.map-start__h', null, 'Quais redes são suas?'),
        h('p.muted.t-sm', null, 'O mapa mostra o sinal delas em cada lugar e separa o seu roteador dos vizinhos.'),
        netRows,
      ),
      h('p.map-start__note', null, icon('sun', { size: 16 }), 'A tela fica ligada durante o mapeamento. Segure o celular como você usa no dia a dia.'),
    ),
    footer: [
      button(throttled ? 'Começar ponto a ponto' : 'Começar a andar', {
        variant: 'primary',
        block: true,
        icon: 'play',
        onClick: () => {
          panel.close();
          const conn = ctx.store.get().connection;
          onStart({ ownSsids: [...chosen], extraOwn: conn && conn.connected && conn.bssid && chosen.has(conn.ssid) ? [conn.bssid] : [] });
        },
      }),
    ],
  });
  return panel;
}

// ---------------------------------------------------------------------------
// Biblioteca
// ---------------------------------------------------------------------------

const STEPS = [
  { icon: 'walk', label: 'Ande pela casa' },
  { icon: 'pin', label: 'Marque os cômodos' },
  { icon: 'cube', label: 'Veja o mapa' },
];

function stepsArt() {
  const kids = [];
  STEPS.forEach((step, i) => {
    if (i) kids.push(h('span.mlib-steps__arrow', { 'aria-hidden': 'true' }, icon('arrow-right', { size: 18 })));
    kids.push(h('li.mlib-step', null, h('span.mlib-step__icon', null, icon(step.icon, { size: 26 })), h('span.mlib-step__label', null, step.label)));
  });
  return h('ol.mlib-steps', { 'aria-label': 'Como funciona, em três passos' }, kids);
}

const QUALITY_TONE = { boa: 'good', razoavel: 'info', fraca: 'warning' };

function mapCard(rec, { onOpen, onMenu }) {
  const q = rec.meta.level ? qualityInfo({ level: rec.meta.level }) : null;
  const when = rec.updatedAt || rec.createdAt;
  return h(
    'li.mlib-map',
    { key: `map-${rec.id}` },
    h(
      'button.mlib-map__open',
      { type: 'button', onClick: () => onOpen(rec), dataset: { mapId: String(rec.id) } },
      h('span.mlib-map__thumb', null, rec.thumb ? h('img', { src: rec.thumb, alt: '', loading: 'lazy', decoding: 'async' }) : icon('cube', { size: 28 })),
      h(
        'span.mlib-map__body',
        null,
        h('span.mlib-map__name', { dir: 'auto' }, rec.name),
        h('span.mlib-map__meta', null, metaLine(rec.meta) || 'Mapa salvo'),
        h('span.mlib-map__foot', null, q ? badge(`Qualidade ${q.label.toLowerCase()}`, { tone: QUALITY_TONE[q.level] }) : null, h('span.mlib-map__date', null, [when ? fmtDateTime(when) : null, rec.meta.demo ? 'demonstração' : null].filter(Boolean).join(' · '))),
      ),
    ),
    iconButton('more', `Mais ações para ${rec.name}`, () => onMenu(rec), { muted: true, class: 'icon-btn icon-btn--muted mlib-map__more' }),
  );
}

/**
 * @param {HTMLElement} root
 * @param {object} env
 */
export function mountLibrary(root, env) {
  const { ctx, storage } = env;
  let dead = false;
  let maps = null; // null = carregando
  let draft = null;

  const body = h('div.mlib');
  root.appendChild(body);

  const demo = () => env.isDemo();

  async function refresh() {
    await storage.ready;
    // o levantamento que acabou de ser fechado pode ainda estar gravando o rascunho
    if (env.session.saving) await Promise.resolve(env.session.saving).catch(() => {});
    const [list, d] = await Promise.all([storage.list(), storage.draft.load()]);
    if (dead) return;
    maps = list
      .map(readRecord)
      .filter((r) => r && r.id !== null)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    draft = d && typeof d === 'object' && d.recorder ? d : null;
    draw();
  }

  // --- ações ---------------------------------------------------------------

  async function confirmReplaceDraft() {
    if (!draft) return true;
    const ok = await confirmDialog({
      title: 'Começar um mapa novo?',
      text: `O mapeamento em andamento (${draftSummaryText(draft)}) será descartado.`,
      confirmLabel: 'Descartar e começar',
      cancelLabel: 'Voltar',
      danger: true,
    });
    if (ok) {
      await storage.draft.clear();
      draft = null;
    }
    return ok;
  }

  async function newMap() {
    if (!(await confirmReplaceDraft()) || dead) return;
    openStartSheet(env, {
      onStart: (start) => {
        env.session.start = { ...start, pilot: false };
        env.go('/mapa/novo');
      },
    });
  }

  async function watchDemo() {
    if (!(await confirmReplaceDraft()) || dead) return;
    env.session.start = { ownSsids: defaultOwnSsids(ctx.store), extraOwn: [], pilot: true };
    env.go('/mapa/novo');
  }

  function resumeDraft() {
    env.session.start = null;
    env.go('/mapa/novo');
  }

  async function discardDraft() {
    const ok = await confirmDialog({
      title: 'Descartar o mapeamento em andamento?',
      text: `${draftSummaryText(draft)} serão apagadas. Não dá para desfazer.`,
      confirmLabel: 'Descartar',
      danger: true,
    });
    if (!ok || dead) return;
    await storage.draft.clear();
    draft = null;
    draw();
    toast('Mapeamento descartado.');
  }

  async function renameMap(rec) {
    const name = await promptSheet({ title: 'Renomear o mapa', label: 'Nome do mapa', value: rec.name, confirmLabel: 'Renomear' });
    const clean = name === null ? '' : cleanMapName(name);
    if (!clean || dead || clean === rec.name) return;
    try {
      const ok = await storage.rename(rec.id, clean);
      await refresh();
      toast(ok === false ? 'Este mapa não existe mais.' : 'Mapa renomeado.');
    } catch (err) {
      toast(String((err && err.message) || 'Não foi possível renomear o mapa.'));
    }
  }

  async function deleteMap(rec) {
    const ok = await confirmDialog({ title: 'Apagar este mapa?', text: `“${rec.name}” será apagado deste aparelho. Não dá para desfazer.`, confirmLabel: 'Apagar', danger: true });
    if (!ok || dead) return;
    const gone = await storage.remove(rec.id);
    toast(gone ? 'Mapa apagado.' : 'Não foi possível apagar o mapa.');
    await refresh();
  }

  function mapMenu(rec) {
    actionSheet({
      title: rec.name,
      actions: [
        { icon: 'cube', label: 'Abrir', onClick: () => env.go(`/mapa/ver/${encodeURIComponent(rec.id)}`) },
        { icon: 'edit', label: 'Renomear', onClick: () => renameMap(rec) },
        { icon: 'trash', label: 'Apagar', danger: true, onClick: () => deleteMap(rec) },
      ],
    });
  }

  async function importText(text) {
    try {
      const id = await storage.importMap(text);
      await refresh();
      toast('Mapa importado.', id != null ? { action: { label: 'Abrir', onClick: () => env.go(`/mapa/ver/${encodeURIComponent(id)}`) } } : undefined);
      return true;
    } catch (err) {
      console.warn('[mapa] arquivo de mapa recusado', err);
      toast(String((err && err.name === 'MapStoreError' && err.message) || 'Este arquivo não é um mapa do WiFi Raio-X (ou está danificado).'));
      return false;
    }
  }

  function openImport() {
    const area = h('textarea.input.map-import__text', { rows: 4, placeholder: 'Cole aqui o conteúdo do arquivo', 'aria-label': 'Conteúdo do arquivo do mapa', spellcheck: 'false', autocomplete: 'off' });
    const file = h('input', {
      type: 'file',
      accept: '.json,application/json,text/plain',
      class: 'sr-only',
      tabIndex: -1,
      'aria-hidden': 'true',
      onChange: async (ev) => {
        const picked = ev.currentTarget.files && ev.currentTarget.files[0];
        if (!picked) return;
        if (picked.size > 30 * 1024 * 1024) {
          toast('Arquivo grande demais para ser um mapa.');
          return;
        }
        const text = await picked.text().catch(() => null);
        if (text === null) {
          toast('Não foi possível ler o arquivo.');
          return;
        }
        if (await importText(text)) panel.close();
      },
    });
    const panel = sheet({
      title: 'Importar um mapa',
      subtitle: 'Use um arquivo exportado pelo WiFi Raio-X (neste ou em outro aparelho).',
      content: h(
        'div.map-import',
        null,
        file,
        button('Escolher arquivo', { variant: 'secondary', icon: 'file', block: true, onClick: () => file.click() }),
        h('span.map-import__or', null, 'ou'),
        area,
      ),
      footer: [
        button('Cancelar', { variant: 'secondary', onClick: () => panel.close() }),
        button('Importar', {
          variant: 'primary',
          onClick: async () => {
            const text = area.value.trim();
            if (!text) {
              toast('Escolha um arquivo ou cole o conteúdo dele.');
              return;
            }
            if (await importText(text)) panel.close();
          },
        }),
      ],
    });
  }

  // --- desenho -------------------------------------------------------------

  function draw() {
    if (dead) return;
    const isDemo = demo();
    const saved = maps || [];
    patch(
      body,
      h(
        'section.card.mlib-hero',
        { key: 'hero' },
        stepsArt(),
        h('h2.mlib-hero__title', null, 'O mapa da sua casa, feito só com o Wi-Fi'),
        h(
          'p.mlib-hero__text',
          null,
          'Você anda pela casa com o celular e o app desenha em 3D a área por onde passou, os cômodos que você marcou e onde o sinal é forte ou fraco. É uma ',
          h('strong', null, 'estimativa'),
          ', não uma planta com medidas exatas.',
        ),
        button(draft ? 'Novo mapa (do zero)' : 'Novo mapa', { variant: draft ? 'secondary' : 'primary', icon: 'plus', block: true, onClick: newMap }),
      ),
      isDemo
        ? h(
            'button.card.card--tappable.card--accent.mlib-demo',
            { key: 'demo', type: 'button', onClick: watchDemo },
            h('span.mlib-demo__play', null, icon('play', { size: 26 })),
            h(
              'span.mlib-demo__body',
              null,
              h('strong.mlib-demo__title', null, 'Ver a demonstração automática'),
              h('span.mlib-demo__text', null, 'Uma pessoa virtual anda pela casa virtual e o mapa se monta sozinho, em cerca de um minuto.'),
            ),
          )
        : null,
      draft
        ? h(
            'section.card.card--accent.mlib-draft',
            { key: 'draft' },
            h('div.mlib-draft__head', null, h('span.mlib-draft__icon', null, icon('route')), h('div', null, h('h3.card__title', null, 'Mapeamento em andamento'), h('p.card__text', null, draftSummaryText(draft), draft.savedAt ? ` · guardado ${fmtAgo(Date.now() - draft.savedAt)}` : ''))),
            h('div.mlib-draft__actions', null, button('Descartar', { variant: 'quiet', onClick: discardDraft }), button('Continuar', { variant: 'primary', icon: 'play', onClick: resumeDraft })),
          )
        : null,
      !storage.persistent && maps !== null
        ? banner({
            key: 'nostore',
            tone: 'warning',
            title: 'Os mapas não ficarão salvos',
            text: 'Este aparelho não deixou o app guardar dados. Você ainda pode fazer um mapa e ver o resultado, mas ele se perde ao fechar o app.',
          })
        : null,
      h(
        'section.mlib-list',
        { key: 'list' },
        sectionHeader('Mapas salvos', { count: saved.length || undefined, action: { label: 'Importar', icon: 'download', onClick: openImport } }),
        maps === null
          ? h('div.center.mlib-loading', null, spinner({ label: 'Carregando os mapas' }))
          : saved.length
            ? h(
                'ul.mlib-maps',
                null,
                saved.map((rec) => mapCard(rec, { onOpen: (r) => env.go(`/mapa/ver/${encodeURIComponent(r.id)}`), onMenu: mapMenu })),
              )
            : h('p.mlib-empty', null, icon('cube', { size: 20 }), 'Nenhum mapa salvo ainda. O primeiro leva poucos minutos.'),
      ),
      h('p.mlib-foot', { key: 'foot' }, icon('lock', { size: 14 }), 'Tudo é calculado no próprio celular. Nenhum dado da sua casa sai do aparelho.'),
    );
  }

  draw();
  refresh().catch((err) => {
    console.error('[mapa] erro ao carregar a biblioteca', err);
    maps = [];
    draw();
  });
  // a pílula "Demonstração" pode ligar/desligar com a tela aberta
  const off = ctx.store.subscribe((s) => s.backend, () => draw());

  return {
    unmount() {
      dead = true;
      off();
    },
  };
}
