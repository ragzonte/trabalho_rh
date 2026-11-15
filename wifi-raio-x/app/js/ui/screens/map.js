// Mapa 3D — PROVISÓRIA. Quem escrever a tela de verdade substitui este arquivo inteiro.

import { mount as render } from '../dom.js';
import { emptyState } from '../components.js';

export function mount(root) {
  render(root, emptyState({ icon: 'cube', tone: 'accent', title: 'Mapa 3D', text: 'O mapa da casa desenhado só com o sinal do Wi-Fi aparece aqui.' }));
  return { unmount() {} };
}
