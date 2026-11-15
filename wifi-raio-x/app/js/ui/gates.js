// Bloqueios de tela cheia: aparecem sempre que o celular não pode listar as redes
// (Status.canScan === false) e somem sozinhos quando o Status volta a permitir.
// Cada um tem uma explicação curta e UMA ação principal; "Ver uma demonstração" está sempre lá.
//
//   const gates = createGates({ store, bridge, onDemo });
//   gates.isUp()    -> há um bloqueio na tela (o botão "voltar" então sai do app)
//   gates.current() -> 'permission' | 'blocked' | 'precise' | 'location' | 'wifi' | 'unknown' | null
//   gates.destroy()

import { h, mount, pushLayer, toast } from './dom.js';
import { icon } from './icons.js';
import { button } from './components.js';

/**
 * Qual bloqueio corresponde a este Status (null = nenhum). A ordem é a em que o usuário
 * consegue resolver: sem permissão não adianta ligar o resto.
 * @param {import('../bridge.js').Status|null} status
 * @returns {'permission'|'blocked'|'precise'|'location'|'wifi'|'unknown'|null}
 */
export function gateFor(status) {
  if (!status || status.canScan !== false) return null;
  if (status.permission === 'blocked') return 'blocked';
  // o contrato atual trata "só localização aproximada" como 'denied'; os dois campos abaixo
  // ficam previstos para quando o lado nativo souber diferenciar
  if (status.permission === 'approximate' || status.precise === false) return 'precise';
  if (status.permission === 'denied') return 'permission';
  if (status.locationEnabled === false) return 'location';
  if (status.wifiEnabled === false) return 'wifi';
  return 'unknown';
}

const PRIVACY = 'O app não usa GPS, não descobre onde você está e não envia nada para fora do celular.';

function gateContent(kind, { bridge, refresh }) {
  const request = async () => {
    try {
      const status = await bridge.requestPermission();
      refresh(status);
    } catch {
      refresh();
    }
  };
  const open = (which) => async () => {
    try {
      const res = await bridge.openSettings(which);
      if (res && res.ok === false) toast('Não foi possível abrir as configurações. Abra pelo menu do Android.');
    } catch {
      toast('Não foi possível abrir as configurações. Abra pelo menu do Android.');
    }
  };

  switch (kind) {
    case 'permission':
      return {
        icon: 'wifi',
        title: 'Vamos ver o Wi-Fi ao seu redor',
        text: 'O Android só mostra a lista de redes Wi-Fi a apps com a permissão de Localização, porque as redes por perto poderiam revelar onde você está. Se ele perguntar, escolha “Precisa”.',
        note: PRIVACY,
        action: { label: 'Permitir', onClick: request },
      };
    case 'blocked':
      return {
        icon: 'lock',
        tone: 'warning',
        title: 'A permissão está bloqueada',
        text: 'O Android parou de perguntar sobre a Localização. Para ver as redes, abra as configurações do app, toque em Permissões › Localização e escolha “Permitir durante o uso do app”.',
        note: PRIVACY,
        action: { label: 'Abrir configurações do app', icon: 'external', onClick: open('app') },
      };
    case 'precise':
      return {
        icon: 'location',
        title: 'Falta a localização precisa',
        text: 'O app recebeu só a localização aproximada, e o Android exige a opção “Localização precisa” para liberar a busca de redes Wi-Fi.',
        note: PRIVACY,
        action: { label: 'Permitir localização precisa', onClick: request },
        extra: { label: 'Abrir configurações do app', onClick: open('app') },
      };
    case 'location':
      return {
        icon: 'pin',
        tone: 'warning',
        title: 'A Localização do celular está desligada',
        text: 'Com a Localização desligada o Android não entrega a lista de redes a nenhum app. Ligue e volte: a lista aparece sozinha.',
        note: PRIVACY,
        action: { label: 'Ligar a Localização', icon: 'external', onClick: open('location') },
      };
    case 'wifi':
      return {
        icon: 'wifi-off',
        tone: 'warning',
        title: 'O Wi-Fi está desligado',
        text: 'Ligue o Wi-Fi do celular para o app enxergar as redes ao redor. Não precisa estar conectado a nenhuma.',
        action: { label: 'Ligar o Wi-Fi', icon: 'external', onClick: open('wifi') },
      };
    default:
      return {
        icon: 'alert-circle',
        tone: 'warning',
        title: 'Não foi possível buscar as redes',
        text: 'O celular não liberou a busca de redes Wi-Fi agora. Confira se o Wi-Fi e a Localização estão ligados e tente de novo.',
        action: { label: 'Tentar de novo', icon: 'refresh', onClick: () => refresh() },
      };
  }
}

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.bridge
 * @param {() => void} deps.onDemo   "Ver uma demonstração": troca para o simulador
 */
export function createGates({ store, bridge, onDemo }) {
  let el = null;
  let pop = null;
  let kind = null;

  // relê o Status (a pedido do usuário ou ao voltar das configurações)
  async function refresh(status) {
    try {
      store.setStatus(status && typeof status === 'object' ? status : await bridge.status());
    } catch {
      // sem resposta: o bloqueio fica como está
    }
  }

  function render() {
    const state = store.get();
    const next = gateFor(state.status);
    if (next === kind) return;
    kind = next;
    if (!next) {
      if (pop) pop();
      pop = null;
      if (el) el.remove();
      el = null;
      return;
    }
    const c = gateContent(next, { bridge, refresh });
    const titleId = 'gate-title';
    const children = [
      h(
        'div.gate__main',
        null,
        h('div', { class: ['gate__art', c.tone && `gate__art--${c.tone}`] }, icon(c.icon, { size: 48, stroke: 1.5 })),
        h('h1.gate__title', { id: titleId }, c.title),
        h('p.gate__text', null, c.text),
        c.note ? h('p.gate__note', null, icon('shield-check', { size: 18 }), h('span', null, c.note)) : null,
      ),
      h(
        'div.gate__actions',
        null,
        button(c.action.label, { variant: 'primary', block: true, icon: c.action.icon, onClick: c.action.onClick }),
        c.extra ? button(c.extra.label, { variant: 'secondary', block: true, onClick: c.extra.onClick }) : null,
        // no simulador já se está na demonstração: o atalho não faria nada
        state.backend === 'sim' ? null : button('Ver uma demonstração', { variant: 'quiet', block: true, onClick: () => onDemo() }),
      ),
    ];
    if (!el) {
      el = h('section.gate', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabIndex: -1, dataset: { gate: next } });
      document.body.appendChild(el);
      pop = pushLayer(el); // sem `close`: o "voltar" não dispensa um bloqueio
    } else {
      el.dataset.gate = next;
    }
    mount(el, children);
    el.focus({ preventScroll: true });
  }

  const offStatus = store.subscribe((s) => s.status, render);
  const offBackend = store.subscribe((s) => s.backend, () => {
    kind = undefined; // o botão da demonstração depende de quem responde
    render();
  });
  render();

  return {
    isUp: () => !!kind,
    current: () => kind || null,
    refresh,
    destroy() {
      offStatus();
      offBackend();
      if (pop) pop();
      if (el) el.remove();
      el = null;
      pop = null;
      kind = null;
    },
  };
}
