// Melhor Wi-Fi — PROVISÓRIA. Quem escrever a tela de verdade substitui este arquivo inteiro.

import { mount as render } from '../dom.js';
import { emptyState } from '../components.js';

export function mount(root) {
  render(root, emptyState({ icon: 'trophy', tone: 'accent', title: 'Melhor Wi-Fi', text: 'A melhor rede para usar aqui e o diagnóstico automático aparecem aqui.' }));
  return { unmount() {} };
}
