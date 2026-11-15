// Ferramentas: o menu que leva às sub-telas (#/ferramentas/<id>).
//
// Para acrescentar uma ferramenta basta criar app/js/ui/tools/<id>.js (medidor.js, ping.js...)
// exportando mount(root, ctx) -> { unmount() }: o roteador (main.js) acha o módulo pelo nome.
// Enquanto o arquivo não existir, a sub-rota mostra um aviso de "em breve".

import { h, mount as render } from '../dom.js';
import { listRow, sectionHeader } from '../components.js';

/**
 * @typedef {Object} Tool
 * @property {string} id      nome da sub-rota e do arquivo em ui/tools/
 * @property {string} title   título curto, para a barra de cima
 * @property {string} name    nome no menu
 * @property {string} desc    uma linha sobre o que faz
 * @property {string} icon    nome em ui/icons.js
 * @property {'medir'|'rede'|'app'} group
 * @property {string} [file]  nome do arquivo em ui/tools/ quando não é o próprio id
 */

/** @type {readonly Tool[]} */
export const TOOLS = Object.freeze([
  { id: 'medidor', title: 'Medidor de sinal', name: 'Medidor de sinal e caça-roteador', desc: 'Ande pela casa e veja onde o sinal melhora', icon: 'target', group: 'medir' },
  { id: 'historico', title: 'Sinal no tempo', name: 'Sinal ao longo do tempo', desc: 'Gráfico das redes nos últimos minutos', icon: 'timeline', group: 'medir' },
  { id: 'velocidade', title: 'Velocidade', name: 'Teste de velocidade', desc: 'Download, upload e resposta da sua internet', icon: 'speed', group: 'medir' },
  { id: 'ping', title: 'Latência', name: 'Latência / ping', desc: 'Tempo de resposta e perda de pacotes', icon: 'ping', group: 'medir' },
  { id: 'conexao', title: 'Conexão', name: 'Detalhes da conexão', desc: 'Endereço IP, roteador, DNS e velocidade do enlace', icon: 'link', group: 'rede' },
  { id: 'dispositivos', title: 'Dispositivos', name: 'Dispositivos na rede', desc: 'Quem está conectado ao seu Wi-Fi agora', icon: 'devices', group: 'rede' },
  { id: 'exportar', title: 'Exportar', name: 'Exportar dados', desc: 'Salve ou compartilhe a lista de redes', icon: 'export', group: 'app' },
  { id: 'ajustes', title: 'Ajustes', name: 'Ajustes', desc: 'Tema, ritmo das buscas e modo demonstração', icon: 'settings', group: 'app', file: 'settings' },
  { id: 'sobre', title: 'Sobre', name: 'Sobre e limitações', desc: 'O que o app faz, privacidade e o que é estimativa', icon: 'info', group: 'app', file: 'about' },
]);

const GROUPS = [
  { id: 'medir', title: 'Medir' },
  { id: 'rede', title: 'Sua rede' },
  { id: 'app', title: 'Dados e app' },
];

/** A ferramenta com este id, ou null. */
export function toolById(id) {
  return TOOLS.find((t) => t.id === id) || null;
}

export function mount(root) {
  render(
    root,
    GROUPS.map((group) => [
      sectionHeader(group.title),
      h(
        'div.card.card--flush.list',
        null,
        TOOLS.filter((t) => t.group === group.id).map((tool) =>
          listRow({
            key: tool.id,
            icon: tool.icon,
            neutral: tool.group === 'app',
            title: tool.name,
            subtitle: tool.desc,
            chevron: true,
            href: `#/ferramentas/${tool.id}`,
          }),
        ),
      ),
    ]),
  );
  return { unmount() {} };
}
