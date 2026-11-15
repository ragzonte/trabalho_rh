// Ajustes: tema, ritmo das buscas, modo demonstração (com a casa virtual), dicas e dados salvos.

import { h, patch, toast, confirmDialog, plural, THIN } from '../dom.js';
import { icon } from '../icons.js';
import { button, listRow, sectionHeader, segmented, select, switchRow, spinner, openThrottleHelp } from '../components.js';

const THEME_OPTIONS = [
  { value: 'system', label: 'Sistema', icon: 'contrast' },
  { value: 'dark', label: 'Escuro', icon: 'moon' },
  { value: 'light', label: 'Claro', icon: 'sun' },
];

const INTERVAL_OPTIONS = [
  { value: 'auto', label: 'Automático (recomendado)' },
  { value: 5, label: `A cada 5${THIN}segundos` },
  { value: 10, label: `A cada 10${THIN}segundos` },
  { value: 15, label: `A cada 15${THIN}segundos` },
  { value: 30, label: `A cada 30${THIN}segundos` },
  { value: 60, label: 'A cada minuto' },
];

/** Apaga os bancos IndexedDB do app (mapas salvos). Convenção: o nome começa com "wrx". */
async function deleteAppDatabases() {
  try {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return;
    const list = await indexedDB.databases();
    await Promise.all(
      list
        .filter((db) => typeof db.name === 'string' && db.name.startsWith('wrx'))
        .map(
          (db) =>
            new Promise((resolve) => {
              const req = indexedDB.deleteDatabase(db.name);
              req.onsuccess = req.onerror = req.onblocked = () => resolve();
            }),
        ),
    );
  } catch {
    // sem IndexedDB não há mapas guardados para apagar
  }
}

export function mount(root, ctx) {
  const { store, app } = ctx;
  let presets = null; // casas virtuais; o simulador só é carregado quando esta tela precisa
  let switching = false;
  let alive = true;

  import('../../sim/presets.js')
    .then((m) => {
      presets = m.listPresets();
      draw();
    })
    .catch(() => {
      presets = [];
      draw();
    });

  async function setDemo(on, world) {
    switching = true;
    draw();
    await app.setDemo(on, world ? { world } : undefined);
    switching = false;
    draw();
  }

  async function clearData() {
    const ok = await confirmDialog({
      title: 'Apagar dados salvos?',
      text: 'Suas redes marcadas, os mapas salvos e os ajustes deste app serão apagados deste celular. Não dá para desfazer.',
      confirmLabel: 'Apagar tudo',
      danger: true,
    });
    if (!ok) return;
    await deleteAppDatabases();
    store.clearSavedData();
    toast('Dados apagados. O app voltou aos ajustes iniciais.');
  }

  function view(state) {
    const { settings, loop, backend, info } = state;
    const demoOn = backend === 'sim';
    const interval = INTERVAL_OPTIONS.some((o) => o.value === settings.scanIntervalS)
      ? INTERVAL_OPTIONS
      : [...INTERVAL_OPTIONS, { value: settings.scanIntervalS, label: `A cada ${settings.scanIntervalS}${THIN}segundos` }];
    const tips = settings.tipsDismissed.length;

    return [
      sectionHeader('Aparência'),
      h(
        'section.card',
        null,
        h('h3.card__title', null, 'Tema'),
        segmented(THEME_OPTIONS, settings.theme, (theme) => store.updateSettings({ theme }), { label: 'Tema' }),
        settings.theme === 'system' ? h('p.card__text', null, 'Acompanha o tema claro ou escuro do celular.') : null,
      ),

      sectionHeader('Busca de redes'),
      h(
        'section.card',
        null,
        h('h3.card__title', null, 'Intervalo entre as buscas'),
        select(interval, settings.scanIntervalS, (scanIntervalS) => store.updateSettings({ scanIntervalS }), { label: 'Intervalo entre as buscas', block: true }),
        h(
          'p.card__text',
          null,
          loop.throttled
            ? 'O Android está limitando as buscas a 4 a cada 2 minutos; por isso, abaixo de 30 segundos o intervalo não tem efeito.'
            : 'No automático o app busca a cada 10 segundos, e passa para 30 quando o Android limita as buscas.',
        ),
        button('Como liberar buscas mais rápidas', { variant: 'quiet', icon: 'bolt', small: true, onClick: () => openThrottleHelp(ctx), style: { marginLeft: '-12px' } }),
      ),

      sectionHeader('Demonstração'),
      h(
        'section.card.card--flush.list',
        null,
        switchRow({
          key: 'demo',
          icon: 'flask',
          title: 'Modo demonstração',
          subtitle: app.demoLocked
            ? 'Aqui o app não tem acesso ao Wi-Fi do aparelho e funciona só em demonstração.'
            : 'Uma casa virtual com redes simuladas, para conhecer o app.',
          checked: demoOn,
          disabled: app.demoLocked || switching,
          onChange: (on) => setDemo(on),
        }),
        demoOn
          ? h(
              'div.list__group',
              { key: 'worlds', role: 'radiogroup', 'aria-label': 'Casa virtual' },
              presets === null
                ? h('div.row', null, spinner({ label: 'Carregando' }))
                : presets.map((p) =>
                    h(
                      'button.row.row--tappable',
                      {
                        key: p.id,
                        type: 'button',
                        role: 'radio',
                        'aria-checked': p.id === settings.demoWorld,
                        disabled: switching,
                        onClick: () => p.id !== settings.demoWorld && setDemo(true, p.id),
                      },
                      h('span.row__icon.row__icon--neutral', null, icon(p.id === 'escritorio' ? 'building' : 'home')),
                      h('span.row__body', null, h('span.row__title', null, p.name), p.description ? h('span.row__sub', null, p.description) : null),
                      h('span.row__trail', { class: 'accent' }, p.id === settings.demoWorld ? icon('check', { label: 'Selecionada' }) : null),
                    ),
                  ),
            )
          : null,
      ),

      sectionHeader('Dicas e dados'),
      h(
        'section.card.card--flush.list',
        null,
        listRow({
          key: 'tips',
          icon: 'sparkle',
          neutral: true,
          title: 'Mostrar as dicas de novo',
          subtitle: tips ? `${plural(tips, 'dica dispensada', 'dicas dispensadas')}` : 'Nenhuma dica foi dispensada',
          onClick: () => {
            store.resetTips();
            toast('As dicas vão aparecer de novo.');
          },
        }),
        listRow({
          key: 'clear',
          icon: 'trash',
          neutral: true,
          title: h('span.critical', null, 'Apagar dados salvos'),
          subtitle: 'Minhas redes, mapas salvos e ajustes',
          onClick: clearData,
        }),
      ),

      h(
        'p.t-xs.muted.center',
        { style: { marginTop: '8px' } },
        `WiFi Raio-X${info && info.appVersion ? ` ${info.appVersion}` : ''}`,
        ' · ',
        h('a', { href: '#/ferramentas/sobre' }, 'Sobre e limitações'),
      ),
    ];
  }

  function draw() {
    if (alive) patch(root, view(store.get()));
  }

  store.subscribe((s) => s.settings, draw);
  store.subscribe((s) => s.backend, draw);
  store.subscribe((s) => s.loop.throttled, draw);
  store.subscribe((s) => s.info, draw);
  draw();

  return {
    unmount() {
      alive = false;
    },
  };
}
