// Dispositivos na rede: quem mais está no mesmo Wi-Fi que o celular.
//
// A busca é feita pelo celular (bridge.lanScan): ele sonda os endereços da rede local e avisa
// cada aparelho que responde ('lan') e o andamento ('lanProgress'). A tela só organiza:
// lista ao vivo (roteador, este celular, depois os demais por endereço), um ícone palpitado
// pelo nome ou pelo fabricante, resumo da contagem e a explicação honesta de por que alguns
// aparelhos aparecem só com o IP (o Android 10+ esconde o MAC dos outros aparelhos).
//
// O resultado fica guardado no módulo enquanto o app estiver aberto: sair e voltar mostra a
// última lista com a idade dela, sem refazer a busca à toa. Sair no meio de uma busca a
// cancela (bridge.cancel('lan')); ao voltar ela recomeça sozinha.

import { h, patch, sheet, toast, fmtNum, fmtMs, fmtAgo, fmtPct, plural } from '../dom.js';
import { icon, makeIcon } from '../icons.js';
import { button, banner, badge, emptyState, kvList, meter, sectionHeader, skeletonList, spinner, ssidLabel } from '../components.js';
import { loadOui, isLocallyAdministered } from '../../core/oui.js';
import { guessDeviceType, deviceName, sortDevices, mergeDevice, summarizeDevices } from './net-logic.js';

/** Lista mais velha que isto é refeita ao abrir a tela. */
const FRESH_MS = 60_000;

// Ícones dos tipos de aparelho que ui/icons.js não tem, no mesmo estilo (grade de 24, só traço).
const TYPE_ICONS = {
  computer: [['r', 4, 5, 16, 11, 2], 'M2 19.5h20'],
  tv: [['r', 2.5, 4.5, 19, 13, 2], 'M8 21h8', 'M12 17.5V21'],
  printer: ['M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2', 'M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6', ['r', 6, 14, 12, 8, 1]],
  speaker: [['r', 5, 2, 14, 20, 2.5], 'M12 6.5h.01', ['c', 12, 14, 3.5]],
  console: [
    'M6 11h4',
    'M8 9v4',
    'M15 12h.01',
    'M18 10h.01',
    'M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z',
  ],
  camera: ['M16 13l5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5', ['r', 2, 6, 14, 12, 2]],
  tablet: [['r', 4, 2, 16, 20, 2.5], 'M12 18h.01'],
  iot: ['M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5', 'M9 18h6', 'M10 22h4'],
  server: [['r', 2, 2, 20, 8, 2], ['r', 2, 14, 20, 8, 2], 'M6 6h.01', 'M6 18h.01'],
  unknown: [['r', 5, 5, 14, 14, 3], ['r', 9.5, 9.5, 5, 5, 1.2]],
};

function typeIcon(type, options) {
  if (type === 'router') return icon('router', options);
  if (type === 'network') return icon('antenna', options);
  if (type === 'phone') return icon('phone', options);
  return makeIcon(TYPE_ICONS[type] || TYPE_ICONS.unknown, options);
}

// O que a busca achou desde que o app abriu. Fica no módulo para sobreviver a sair e voltar.
const session = {
  key: null, // identidade da rede (quem responde + roteador + rede): mudou, a lista não vale mais
  scanKey: null, // a rede em que a busca em andamento começou
  state: 'idle', // 'idle' | 'scanning' | 'done' | 'cancelled' | 'error'
  devices: [], // LanDevice + {stale?: true} para os que vieram da busca anterior
  progress: { done: 0, total: 0 },
  finishedAt: null,
  cancelledBy: null, // 'user' | 'leave'
  pending: null, // Promise da busca em andamento
  onChange: null, // a tela montada agora (se houver)
};

function finishScan(result, failed, key) {
  session.pending = null;
  if (key !== session.key) {
    // a rede mudou no meio da busca: o que ela achou é de outra rede e não entra na lista
    if (session.state === 'scanning') session.state = 'idle';
    if (session.onChange) session.onChange();
    return;
  }
  session.finishedAt = Date.now();
  if (failed) {
    session.state = 'error';
  } else {
    // o resultado final completa o que os avisos trouxeram (não deveria faltar nada)
    const list = result && Array.isArray(result.devices) ? result.devices : [];
    for (const device of list) {
      const before = session.devices;
      session.devices = mergeDevice(session.devices, device);
      if (session.devices !== before) unstale(device.ip);
    }
    if (session.cancelledBy) session.state = 'cancelled';
    else {
      session.state = 'done';
      // busca completa: quem só vinha da lista anterior e não respondeu agora sai
      session.devices = session.devices.filter((d) => !d.stale);
    }
  }
  if (session.onChange) session.onChange();
}

function unstale(ip) {
  const at = session.devices.findIndex((d) => d.ip === ip);
  if (at >= 0 && session.devices[at].stale) {
    const next = session.devices.slice();
    const { stale, ...rest } = next[at];
    next[at] = rest;
    session.devices = next;
  }
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

/** Copia um texto; devolve false se o aparelho não deixou. */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // sem permissão: tenta o jeito antigo
  }
  try {
    const area = h('textarea', { value: text, readOnly: true, 'aria-hidden': 'true', style: { position: 'fixed', top: '0', left: '0', opacity: '0' } });
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export async function mount(root, ctx) {
  const { store, bridge } = ctx;
  await ensureStyles();
  root.classList.add('tb');

  let alive = true;
  let frame = 0;
  let vendors = null; // OuiLookup, quando carregar
  let openSheet = null; // {ip, panel} do painel de detalhes aberto
  const cleanups = [];

  const connection = () => {
    const conn = store.get().connection;
    return conn && conn.connected ? conn : null;
  };

  function networkKey() {
    const conn = connection();
    if (!conn) return null;
    return [store.get().backend, conn.gateway || '', conn.bssid || conn.ssid || '', (conn.ip || '').replace(/\.\d+$/, '')].join('|');
  }

  /** Rede diferente (ou modo demonstração ligado/desligado): a lista guardada não vale mais. */
  function syncNetwork() {
    const key = networkKey();
    if (session.key === key) return false;
    session.key = key;
    session.devices = [];
    session.progress = { done: 0, total: 0 };
    session.finishedAt = null;
    session.cancelledBy = null;
    if (session.pending) {
      // uma busca da rede antiga ainda rodando: é dispensada e a lista começa do zero
      session.cancelledBy = 'leave';
      bridge.cancel('lan').catch(() => {});
    } else session.state = 'idle';
    return true;
  }

  // --- busca ------------------------------------------------------------------------------

  async function scan() {
    if (!alive) return;
    if (session.pending) {
      // espera a anterior fechar (o celular só roda uma busca por vez)
      await session.pending;
      if (!alive || session.pending) return;
    }
    if (!connection()) {
      session.state = 'idle';
      schedule();
      return;
    }
    session.state = 'scanning';
    session.cancelledBy = null;
    session.progress = { done: 0, total: 0 };
    session.devices = session.devices.map((d) => ({ ...d, stale: true }));
    const key = session.key;
    session.scanKey = key;
    session.pending = bridge.lanScan().then(
      (result) => finishScan(result, false, key),
      () => finishScan(null, true, key),
    );
    schedule();
  }

  function stop(by) {
    if (!session.pending) return;
    session.cancelledBy = by;
    bridge.cancel('lan').catch(() => {});
    schedule();
  }

  function onDevice(device) {
    if (session.state !== 'scanning' || session.scanKey !== session.key || !device || typeof device.ip !== 'string') return;
    session.devices = mergeDevice(session.devices, device);
    unstale(device.ip);
    schedule();
  }

  function onProgress(progress) {
    if (session.state !== 'scanning' || session.scanKey !== session.key || !progress) return;
    const total = Number.isFinite(progress.total) ? Math.max(0, progress.total) : 0;
    const done = Number.isFinite(progress.done) ? Math.max(0, Math.min(total, progress.done)) : 0;
    session.progress = { done, total };
    schedule();
  }

  // --- o que mostrar ----------------------------------------------------------------------

  function vendorOf(device) {
    if (!device.mac) return null;
    // Endereço "administrado localmente": celulares e notebooks inventam um MAC por rede para não
    // serem rastreados. (O palpite de fabricante que core/oui.js faz nesses casos vale para os
    // rádios virtuais de roteador, não para os aparelhos da casa.)
    if (isLocallyAdministered(device.mac)) return { name: null, randomized: true };
    const info = vendors ? vendors.vendor(device.mac) : null;
    return info && info.name ? { name: info.name, randomized: false } : null;
  }

  /** Sem o MAC do roteador, o fabricante dele ainda aparece pelo sinal Wi-Fi em que o celular está. */
  function routerVendor() {
    const ap = store.connectedAp();
    return ap && typeof ap.vendor === 'string' && ap.vendor ? ap.vendor : null;
  }

  function describe(device) {
    const vendor = vendorOf(device);
    const name = deviceName(device.host);
    const guess = guessDeviceType({ host: name, vendor: vendor && vendor.name, self: device.self, gateway: device.gateway });
    return { name, vendor, guess };
  }

  function openWifiSettings() {
    if (store.get().backend === 'sim') {
      toast('Na demonstração não há configurações do Android para abrir.');
      return;
    }
    bridge
      .openSettings('wifi')
      .then((res) => {
        if (!res || res.ok === false) toast('Não foi possível abrir. Procure “Wi-Fi” nas configurações do Android.');
      })
      .catch(() => toast('Não foi possível abrir. Procure “Wi-Fi” nas configurações do Android.'));
  }

  function detailContent(device) {
    const { name, vendor, guess } = describe(device);
    const rows = [
      ['Endereço IP', h('span.num', null, device.ip), 'o “número da casa” deste aparelho dentro da sua rede'],
      name ? ['Nome informado', h('span.wrap', { dir: 'auto' }, name)] : ['Nome', 'Não informado', 'nem o aparelho nem o roteador disseram o nome dele'],
      [
        'Tipo',
        guess.type === 'unknown' ? 'Não deu para saber' : guess.label,
        guess.source === 'name' ? 'palpite pelo nome' : guess.source === 'vendor' ? 'palpite pelo fabricante' : undefined,
      ],
      device.self ? null : ['Tempo de resposta', typeof device.ms === 'number' ? fmtMs(device.ms) : 'Não respondeu ao teste', typeof device.ms === 'number' ? 'quanto ele demorou a responder à busca' : undefined],
      device.mac ? ['Endereço físico (MAC)', h('span.num', null, device.mac)] : null,
      device.mac
        ? ['Fabricante', vendor ? (vendor.randomized ? 'Endereço aleatório' : vendor.name) : 'Desconhecido', vendor && vendor.randomized ? 'o aparelho usa um MAC inventado para proteger a privacidade' : undefined]
        : device.self
          ? null
          : device.gateway && routerVendor()
            ? ['Fabricante', routerVendor(), 'provável: é o fabricante do sinal Wi-Fi em que o celular está conectado']
            : ['Fabricante', 'Não disponível', 'o Android não mostra o endereço físico (MAC) deste aparelho'],
    ];
    return [
      device.stale ? banner({ tone: 'neutral', icon: 'clock', text: 'Este aparelho apareceu na busca anterior e ainda não respondeu nesta.' }) : null,
      device.gateway ? h('p.tb-note', null, 'É o aparelho que distribui o Wi-Fi e liga a casa à internet. A página de configuração dele costuma abrir neste endereço, pelo navegador.') : null,
      device.self ? h('p.tb-note', null, 'É o celular que você está usando agora.') : null,
      kvList(rows),
    ];
  }

  function openDetails(ip) {
    const device = session.devices.find((d) => d.ip === ip);
    if (!device) return;
    const { name, guess } = describe(device);
    const panel = sheet({
      title: device.gateway ? 'Roteador' : device.self ? 'Este celular' : name ? h('span.wrap', { dir: 'auto' }, name) : 'Aparelho sem nome',
      subtitle: guess.type !== 'unknown' && !device.gateway && !device.self ? `Parece ser: ${guess.label}` : undefined,
      content: detailContent(device),
      footer: [
        button('Copiar IP', {
          variant: 'secondary',
          icon: 'copy',
          onClick: async () => {
            const ok = await copyText(device.ip);
            toast(ok ? 'Endereço copiado.' : `Não deu para copiar. O endereço é ${device.ip}.`);
          },
        }),
        device.self
          ? null
          : button('Medir latência', {
              variant: 'primary',
              icon: 'ping',
              onClick: () => {
                panel.close();
                ctx.navigate(`/ferramentas/ping?host=${encodeURIComponent(device.ip)}`);
              },
            }),
      ],
      onClose: () => {
        if (openSheet && openSheet.panel === panel) openSheet = null;
      },
    });
    openSheet = { ip, panel };
  }

  function deviceRow(device) {
    const { name, vendor, guess } = describe(device);
    // Segunda linha: o IP inteiro e mais um dado. Quando o MAC aparece é o fabricante (nome de
    // fora, pode ser comprido: encolhe com reticências); senão, o tipo palpitado pelo nome.
    const sub = [h('span.num', null, device.ip)];
    if (device.stale) sub.push(h('span', null, 'busca anterior'));
    if (vendor) sub.push(h('span.tb-sub__flex', null, vendor.randomized ? 'MAC aleatório' : vendor.name));
    else if (guess.type !== 'unknown' && !device.gateway && !device.self) sub.push(h('span.tb-sub__flex', null, guess.short));
    const role = device.gateway ? 'Roteador' : device.self ? 'Este celular' : null;
    return h(
      'button.row.row--tappable.tb-dev',
      { key: device.ip, type: 'button', class: { 'row--stale': !!device.stale }, onClick: () => openDetails(device.ip) },
      h('span', { class: ['row__icon', guess.type === 'unknown' && 'row__icon--neutral'] }, typeIcon(guess.type)),
      h(
        'span.row__body',
        null,
        h(
          'span.row__title',
          null,
          name ? h('span.truncate', { dir: 'auto' }, name) : role ? h('span.truncate', null, role) : h('span.truncate.tb-dev__noname', null, 'Aparelho sem nome'),
          role && name ? badge(role, { tone: 'accent' }) : null,
        ),
        h('span.row__sub.tb-sub', null, sub),
      ),
      // como nas linhas de rede (apRow): o valor à direita, sem seta, para sobrar largura para o nome
      typeof device.ms === 'number' ? h('span.row__trail.num', { title: 'Tempo de resposta' }, fmtMs(device.ms)) : null,
    );
  }

  function summaryCard(devices) {
    const conn = connection();
    const scanning = session.state === 'scanning';
    const current = devices.filter((d) => !d.stale);
    const shown = scanning ? current : devices;
    const sum = summarizeDevices(shown);
    const { done, total } = session.progress;
    const pct = total > 0 ? (100 * done) / total : 0;

    const where = conn && typeof conn.ssid === 'string' && conn.ssid ? [' na rede ', ssidLabel(conn.ssid, { tag: 'strong' })] : ' nesta rede';
    let caption;
    if (scanning) caption = h('p.tb-sum__label', null, sum.total === 1 ? 'aparelho encontrado até agora' : 'aparelhos encontrados até agora');
    else caption = h('p.tb-sum__label', null, sum.total === 1 ? 'aparelho' : 'aparelhos', where);

    const details = [];
    if (!scanning && sum.total > 0) {
      details.push(sum.named === sum.total ? 'Todos informaram o nome' : `${plural(sum.named, 'informou o nome', 'informaram o nome')} · ${plural(sum.unnamed, 'aparece só pelo endereço', 'aparecem só pelo endereço')}`);
    }

    let status = null;
    if (scanning) {
      status = h(
        'div.tb-sum__progress',
        { key: 'progress' },
        meter(pct, { label: 'Andamento da busca' }),
        h('p.tb-caption.num', { 'aria-live': 'off' }, session.cancelledBy ? 'Parando…' : total > 0 ? `Procurando em ${fmtNum(total)} endereços… ${fmtPct(pct)}` : 'Começando a busca…'),
      );
    } else if (session.state === 'cancelled') {
      status = h('p.tb-note', { key: 'status' }, 'Busca interrompida', total > 0 ? ` em ${fmtPct(pct)}` : '', ': a lista pode estar incompleta.');
    } else if (session.state === 'done' && session.finishedAt) {
      const age = Date.now() - session.finishedAt;
      status = h('p.tb-caption.num', { key: 'status' }, age < 5000 ? 'Conferido agora' : `Conferido ${fmtAgo(age)}`);
    }

    return h(
      'section.card.tb-sum',
      { key: 'summary' },
      h(
        'div.tb-sum__top',
        null,
        h('div.tb-sum__count', null, h('span.tb-sum__num.num', null, fmtNum(sum.total)), scanning ? spinner({ label: 'Procurando aparelhos' }) : null),
        scanning
          ? button('Parar', { key: 'stop', variant: 'secondary', icon: 'stop', small: true, onClick: () => stop('user'), disabled: !!session.cancelledBy })
          : button('Procurar de novo', { key: 'again', variant: 'secondary', icon: 'refresh', small: true, onClick: scan }),
      ),
      caption,
      details.length ? h('p.tb-note', { key: 'details' }, details.join(' ')) : null,
      status,
    );
  }

  function view() {
    const conn = connection();
    if (!conn) {
      return emptyState({
        icon: 'wifi-off',
        title: 'Conecte-se a um Wi-Fi',
        text: 'Esta ferramenta procura os aparelhos que estão na mesma rede Wi-Fi que o celular.',
        action: { label: 'Abrir o Wi-Fi', icon: 'wifi', onClick: openWifiSettings },
      });
    }
    if (session.state === 'error' && session.devices.length === 0) {
      return emptyState({
        icon: 'alert-circle',
        tone: 'critical',
        title: 'A busca não funcionou',
        text: 'Não foi possível procurar os aparelhos agora. Confira se o Wi-Fi continua conectado e tente de novo.',
        action: { label: 'Tentar de novo', icon: 'refresh', onClick: scan },
      });
    }

    const devices = sortDevices(session.devices);
    const scanning = session.state === 'scanning';
    const onlyUs = session.state === 'done' && devices.length > 0 && devices.every((d) => d.self || d.gateway);

    return [
      summaryCard(devices),
      session.state === 'error' ? banner({ key: 'err', tone: 'critical', title: 'A última busca falhou', text: 'A lista abaixo é da busca anterior.', actions: [{ label: 'Tentar de novo', onClick: scan }] }) : null,
      devices.length
        ? h('div.card.card--flush.list', { key: 'list', role: 'group', 'aria-label': 'Aparelhos encontrados' }, devices.map(deviceRow))
        : scanning
          ? h('div', { key: 'skeleton' }, skeletonList(4))
          : session.state === 'idle'
            ? h('div', { key: 'skeleton' }, skeletonList(4))
            : session.state === 'cancelled'
              ? banner({ key: 'none', tone: 'neutral', icon: 'devices', title: 'Nenhum aparelho respondeu ainda', text: 'A busca foi interrompida antes de alguém responder. Toque em “Procurar de novo”.' })
              : banner({
                  key: 'none',
                  tone: 'neutral',
                  icon: 'devices',
                  title: 'Nenhum aparelho encontrado',
                  text: 'A busca não achou ninguém nesta rede. Acontece em redes que não são de casa (com endereços públicos) ou que isolam os aparelhos uns dos outros.',
                }),
      onlyUs
        ? banner({
            key: 'isolated',
            tone: 'neutral',
            icon: 'shield',
            title: 'Só o roteador e este celular responderam',
            text: 'Redes de visitantes e redes públicas costumam isolar os aparelhos uns dos outros: nesse caso ninguém mais aparece, mesmo estando conectado.',
          })
        : null,
      sectionHeader('Bom saber'),
      h(
        'section.card.tb-facts',
        { key: 'facts' },
        h(
          'div.tb-fact',
          null,
          h('span.tb-fact__icon', null, icon('eye-off', { size: 20 })),
          h('p', null, h('strong', null, 'Por que alguns aparecem só com o endereço? '), 'O Android (do 10 em diante) esconde dos apps o endereço físico dos outros aparelhos, o MAC, que é o que revela o fabricante. O nome só aparece quando o próprio aparelho ou o roteador informa.'),
        ),
        h(
          'div.tb-fact',
          null,
          h('span.tb-fact__icon', null, icon('moon', { size: 20 })),
          h('p', null, h('strong', null, 'A lista pode não estar completa. '), 'Celulares com a tela apagada e aparelhos em economia de energia às vezes não respondem. Procure de novo com eles em uso.'),
        ),
        h(
          'div.tb-fact',
          null,
          h('span.tb-fact__icon', null, icon('shield-check', { size: 20 })),
          h('p', null, h('strong', null, 'A lista fica no celular. '), 'A busca conversa com os aparelhos da sua rede e pergunta os nomes deles ao servidor de nomes (DNS) que a rede usa. O resultado não é enviado a lugar nenhum.'),
        ),
      ),
    ];
  }

  function drawNow() {
    frame = 0;
    if (!alive) return;
    patch(root, view());
    // painel de detalhes aberto acompanha o que a busca for descobrindo
    if (openSheet && openSheet.panel.isOpen()) {
      const device = session.devices.find((d) => d.ip === openSheet.ip);
      if (device) patch(openSheet.panel.body, detailContent(device));
    }
  }

  function schedule() {
    if (alive && !frame) frame = requestAnimationFrame(drawNow);
  }

  // --- ligações ---------------------------------------------------------------------------

  session.onChange = schedule;
  cleanups.push(() => {
    if (session.onChange === schedule) session.onChange = null;
  });
  cleanups.push(bridge.on('lan', onDevice));
  cleanups.push(bridge.on('lanProgress', onProgress));
  cleanups.push(
    store.subscribe(
      () => networkKey(),
      () => {
        // trocou de rede, caiu o Wi-Fi ou voltou: a lista recomeça
        if (syncNetwork()) {
          drawNow();
          if (connection()) scan();
        }
      },
    ),
  );
  // a idade da lista ("conferido há 2 min") anda sozinha
  const ageTimer = setInterval(() => session.state === 'done' && !document.hidden && schedule(), 5000);
  cleanups.push(() => clearInterval(ageTimer));

  loadOui(new URL('../../../assets/oui.json', import.meta.url).href).then((lookup) => {
    if (!alive || !lookup || !lookup.loaded) return;
    vendors = lookup;
    schedule();
  });

  syncNetwork();
  drawNow();
  const stale = session.state === 'done' && session.finishedAt && Date.now() - session.finishedAt > FRESH_MS;
  const interrupted = session.state === 'cancelled' && session.cancelledBy === 'leave';
  if (connection() && (session.state === 'idle' || stale || interrupted || session.pending)) scan();

  return {
    unmount() {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (openSheet && openSheet.panel.isOpen()) openSheet.panel.close();
      openSheet = null;
      // a busca não continua às escondidas
      if (session.pending && !session.cancelledBy) {
        session.cancelledBy = 'leave';
        bridge.cancel('lan').catch(() => {});
      }
      for (const off of cleanups.splice(0)) off();
    },
  };
}
