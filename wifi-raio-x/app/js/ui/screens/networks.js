// Redes — PROVISÓRIA. Quem escrever a tela de verdade substitui este arquivo inteiro.
//
// Serve de exemplo mínimo do contrato das telas: lê do store (nunca da ponte), refaz a árvore a
// cada varredura e aplica com patch(), que reaproveita as linhas (a rolagem e o foco ficam onde
// estavam) — e mostra nomes de rede só como texto.

import { h, patch, plural } from '../dom.js';
import { apRow, banner, emptyState, sectionHeader, skeletonList, throttleTip } from '../components.js';

export function mount(root, ctx) {
  const view = (state) => {
    const { aps, scan } = state;
    if (!aps.length) {
      return scan.seq === 0
        ? [sectionHeader('Procurando redes por perto…'), skeletonList(6)]
        : emptyState({ icon: 'wifi-off', title: 'Nenhuma rede por perto', text: 'O celular não ouviu nenhuma rede Wi-Fi na última busca.', action: { label: 'Buscar de novo', icon: 'refresh', onClick: () => ctx.scanLoop.scanNow() } });
    }
    return [
      banner({ tone: 'neutral', icon: 'tools', title: 'Tela em construção', text: 'Esta é uma lista provisória; a tela de Redes completa entra aqui.' }),
      throttleTip(ctx),
      sectionHeader('Redes por perto', { count: aps.length }),
      h('div.card.card--flush.list', { 'aria-label': plural(aps.length, 'rede', 'redes') }, aps.map((ap) => apRow(ap))),
    ];
  };
  const draw = () => patch(root, view(ctx.store.get()));
  ctx.store.subscribe((s) => s.aps, draw);
  ctx.store.subscribe((s) => s.loop.throttled, draw);
  ctx.store.subscribe((s) => s.settings.tipsDismissed, draw);
  draw();
  return { unmount() {} };
}
