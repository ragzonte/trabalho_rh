// Sobre e limitações: o que o app faz, o que ele NÃO manda para lugar nenhum e onde os números
// são estimativas. Texto estático, mais os dados do aparelho (DeviceInfo).

import { h, mount as render, sheet, fmtBand } from '../dom.js';
import { icon } from '../icons.js';
import { button, kvList, sectionHeader, spinner } from '../components.js';

const p = (...kids) => h('p', null, kids);
const b = (text) => h('strong', null, text);
const li = (...kids) => h('li', null, kids);

function bandsText(bands) {
  if (!bands || typeof bands !== 'object') return null;
  const list = [bands.b24 && fmtBand('2.4'), bands.b5 && fmtBand('5'), bands.b6 && fmtBand('6'), bands.b60 && fmtBand('60')].filter(Boolean);
  return list.length ? list.join(' · ') : null;
}

async function openLicense() {
  const body = h('div', { style: { minHeight: '120px' } }, spinner({ label: 'Carregando' }));
  sheet({ title: 'Licença do three.js', subtitle: 'Licença MIT', content: body, tall: true });
  try {
    const res = await fetch(new URL('../../../vendor/three.LICENSE.txt', import.meta.url));
    if (!res.ok) throw new Error(String(res.status));
    const text = await res.text();
    render(body, h('pre.t-xs.muted', { style: { whiteSpace: 'pre-wrap', margin: '0', fontFamily: 'inherit' } }, text));
  } catch {
    render(body, h('p.t-sm.muted', null, 'three.js é distribuído sob a licença MIT (Copyright © three.js authors).'));
  }
}

export function mount(root, ctx) {
  const view = (info) => [
    h(
      'section.card',
      { style: { textAlign: 'center', padding: '24px 16px' } },
      h('div', { class: 'accent', style: { display: 'grid', placeItems: 'center' } }, icon('wifi', { size: 48, stroke: 1.5 })),
      h('h2.t-lg', null, 'WiFi Raio-X'),
      h('p.t-sm.muted', null, 'Veja o seu Wi-Fi por dentro.'),
      h('p.t-xs.muted', null, info && info.appVersion ? `Versão ${info.appVersion}` : 'Versão não informada'),
    ),

    sectionHeader('O que o app faz'),
    h(
      'section.card',
      null,
      h(
        'ul.prose',
        null,
        li(b('Redes: '), 'lista as redes Wi-Fi ao redor, com sinal, canal, segurança e geração do Wi-Fi de cada uma.'),
        li(b('Canais: '), 'mostra quem divide o ar com o seu roteador e indica um canal mais livre.'),
        li(b('Melhor Wi-Fi: '), 'compara as redes onde você está e aponta problemas comuns em linguagem simples.'),
        li(b('Mapa 3D: '), 'desenha a sua casa e os pontos de sinal fraco usando só as leituras do Wi-Fi enquanto você anda.'),
        li(b('Ferramentas: '), 'medidor de sinal, detalhes da conexão, latência, teste de velocidade e aparelhos na rede.'),
      ),
    ),

    sectionHeader('Privacidade'),
    h(
      'section.card.card--good',
      null,
      h(
        'div.prose',
        null,
        p(b('O que o app encontra fica no seu celular. '), 'Ele não tem cadastro, anúncios nem estatísticas de uso. As redes, os mapas e os ajustes ficam guardados só aqui.'),
        p('A permissão de ', b('Localização'), ' é uma exigência do Android para listar redes Wi-Fi. O app não usa GPS e não registra onde você está.'),
        p(
          'O app só usa a internet quando você pede: no ',
          b('teste de velocidade'),
          ' (servidores da Cloudflare, speed.cloudflare.com) e no ',
          b('teste de latência'),
          ' até a internet (o destino que você escolher: Cloudflare 1.1.1.1, Google 8.8.8.8 ou um site). Nada do que o app analisa é enviado.',
        ),
      ),
    ),

    sectionHeader('Limitações, sem enrolação'),
    h(
      'section.card',
      null,
      h(
        'ul.prose',
        null,
        li(b('O Android limita as buscas. '), 'Cada app pode procurar redes 4 vezes a cada 2 minutos. Por isso a lista às vezes demora a atualizar; o app sempre mostra a idade dos dados. Dá para desligar o limite nas opções do desenvolvedor.'),
        li(b('Distância e velocidade são estimativas. '), 'São calculadas a partir da força do sinal; paredes, móveis e até pessoas mudam o resultado. Onde há estimativa, aparece “≈” ou “cerca de”.'),
        li(b('O app só enxerga Wi-Fi. '), 'Micro-ondas, babás eletrônicas e Bluetooth também atrapalham o sinal, mas não aparecem na lista.'),
        li(b('Nem todo celular informa tudo. '), 'Detalhes como a geração do Wi-Fi e a ocupação do canal dependem da versão do Android e do que cada roteador anuncia.'),
        li(b('Aparelhos na rede: '), 'o Android 11 ou mais novo esconde o endereço físico (MAC) dos outros aparelhos, então nem sempre dá para dizer o fabricante.'),
      ),
    ),

    sectionHeader('O que o mapa 3D consegue (e o que não)'),
    h(
      'section.card',
      null,
      h(
        'ul.prose',
        null,
        li(b('Consegue: '), 'montar o formato aproximado dos cômodos por onde você andou, mostrar onde o sinal é forte ou fraco e indicar mais ou menos onde ficam os roteadores.'),
        li(b('Não é uma planta baixa. '), 'Sem câmera, GPS ou bússola, o mapa não sabe onde é o norte e pode sair girado ou espelhado; as medidas são aproximadas.'),
        li(b('As paredes são deduzidas. '), 'O app não as vê: ele percebe onde o sinal cai de repente. Paredes finas e portas abertas podem passar despercebidas.'),
        li(b('Melhora com: '), 'mais roteadores visíveis (inclusive os dos vizinhos), caminhada lenta e pontos marcados parado em cada cômodo.'),
      ),
    ),

    sectionHeader('Este aparelho'),
    h(
      'section.card',
      null,
      kvList([
        ['Aparelho', info ? [info.manufacturer, info.model].filter(Boolean).join(' ') || null : null],
        ['Android', info && info.platform === 'android' ? info.release : null],
        ['Modo', info && info.platform === 'sim' ? 'Demonstração (simulador)' : null],
        ['Faixas de Wi-Fi', info ? bandsText(info.bands) : null],
        ['Distância por Wi-Fi (RTT)', info ? (info.rtt ? 'Mede' : 'Não mede') : null],
        ['Versão do app', info ? info.appVersion : null],
      ]),
    ),

    sectionHeader('Código aberto'),
    h(
      'section.card',
      null,
      h(
        'div.prose',
        null,
        p(b('three.js'), ' — desenho do mapa em 3D. Licença MIT, © three.js authors.'),
        p(b('Registro de fabricantes da IEEE'), ' — tabela pública (MA-L, MA-M e MA-S) usada para dizer quem fabricou cada roteador a partir do endereço MAC.'),
      ),
      button('Ver a licença do three.js', { variant: 'secondary', small: true, onClick: openLicense }),
    ),
  ];

  const draw = (info) => render(root, view(info));
  ctx.store.subscribe((s) => s.info, draw, { immediate: true });
  return { unmount() {} };
}
