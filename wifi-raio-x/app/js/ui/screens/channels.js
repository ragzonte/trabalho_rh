// Canais — PROVISÓRIA. Quem escrever a tela de verdade substitui este arquivo inteiro.

import { mount as render } from '../dom.js';
import { emptyState } from '../components.js';

export function mount(root) {
  render(root, emptyState({ icon: 'channels', tone: 'accent', title: 'Canais', text: 'O gráfico dos canais e o melhor canal para o seu roteador aparecem aqui.' }));
  return { unmount() {} };
}
