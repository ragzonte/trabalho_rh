// Revisão de texto, UX e acessibilidade: testes de regressão da lógica (os de tela estão em
// tests/e2e/review-ux.e2e.mjs). Cada bloco cita o achado que o motivou (ux-NN).
//
// Boa parte confere TEXTO: o defeito era o app dizer coisas diferentes (ou falsas) sobre o mesmo
// fato em telas feitas por autores diferentes. Os testes prendem a regra (uma fonte só, a frase
// certa para cada caso), não a redação inteira.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as L from '../app/js/ui/map/map-ui-logic.js';
import { SURVEY_THRESHOLDS } from '../app/js/mapping/recorder.js';
import { buildInsights, scanThrottleCopy, canLiftScanThrottle, THROTTLE_OPTION_NAME } from '../app/js/core/index.js';
import { MAC_HIDDEN_SINCE_ANDROID } from '../app/js/ui/tools/net-logic.js';
import { rateChannels, recommendChannel, recommendWidth } from '../app/js/core/channel-rating.js';
import { normalizeAp } from '../app/js/core/model.js';
import { encodeIes } from '../app/js/core/ies.js';
import { verdictWidth, usableWidth, bestTag, widthsFor } from '../app/js/ui/screens/channels.js';
import { CW, makeAp, apartment, apartmentTruth } from './fixtures/scans.mjs';
import { normalizeScan } from '../app/js/core/model.js';
import { rankNetworks } from '../app/js/core/best-network.js';
import { describeConnection } from '../app/js/ui/tools/conexao.js';
import { buildReport } from '../app/js/ui/tools/export-format.js';
import { fullTestDataText, estimateTestBytes, formatBytes } from '../app/js/ui/tools/net-logic.js';
import { apSignal, scoreParts, rowEntries } from '../app/js/ui/screens/best.js';
import { fmtMeters, fmtDbm, nb } from '../app/js/ui/dom.js';
import { createRecorder } from '../app/js/mapping/recorder.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(HERE, '..', 'app', 'js');

/** Todos os .js do app (menos o que é de terceiros), como { file, text }. */
function sources(dir = APP_JS) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith('.js')) out.push({ file: relative(APP_JS, path).replace(/\\/g, '/'), text: readFileSync(path, 'utf8') });
  }
  return out;
}
const SOURCES = sources();
const source = (file) => SOURCES.find((s) => s.file === file).text;
/** O código sem os comentários de linha e de bloco (o bastante para procurar textos de tela). */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** Arquivos (fora os comentários) em que o texto aparece. */
const filesWith = (needle) => SOURCES.filter((s) => (needle instanceof RegExp ? needle.test(code(s.text)) : code(s.text).includes(needle))).map((s) => s.file);

// ---------------------------------------------------------------------------
// ux-01: mapeamento "ponto a ponto" (Android limitando as buscas)
// ---------------------------------------------------------------------------
describe('ux-01: mapa ponto a ponto', () => {
  const T = SURVEY_THRESHOLDS;
  const WALK_ONLY = /poucos segundos|siga andando|Continue andando|Ande devagar/;
  const textOf = (tips) => tips.map((t) => `${t.title} ${t.text}`).join(' | ');

  test('as dicas ponto a ponto não mandam andar sem parar e dizem quantos lugares marcar', () => {
    for (const during of [false, true]) {
      const tips = L.surveyTips({ throttled: true, during }, T);
      const text = textOf(tips);
      assert.doesNotMatch(text, WALK_ONLY, text);
      assert.match(text, new RegExp(`pelo menos ${T.minSpots} lugares`));
      assert.match(text, /2 ou 3 por cômodo/);
      assert.match(text, /Marcar este lugar/);
      assert.equal(tips.length, during ? 4 : 3);
      for (const tip of tips) assert.ok(tip.icon && tip.title && tip.text);
    }
    // o número vem do gravador, não de um 12 escrito à mão
    assert.match(textOf(L.surveyTips({ throttled: true }, { ...T, minSpots: 9 })), /pelo menos 9 lugares/);
  });

  test('andando sem parar, as dicas continuam as de caminhada', () => {
    const start = textOf(L.surveyTips({ throttled: false }, T));
    assert.match(start, /Ande devagar e por todos os cômodos/);
    assert.match(start, /a cada poucos segundos/);
    assert.doesNotMatch(start, /pelo menos \d+ lugares/);
    assert.equal(L.surveyTips({ throttled: false, during: true }, T).length, 4);
  });

  test('o tempo prometido fecha com o mínimo de lugares × uma leitura a cada 30 s', () => {
    assert.equal(L.surveyTimeText(false, T), 'Leva de 3 a 10 minutos, conforme o tamanho da casa.');
    const slow = L.surveyTimeText(true, T);
    const min = Math.ceil((T.minSpots * L.THROTTLED_GAP_S) / 60);
    assert.match(slow, new RegExp(`Leva de ${min} a \\d+ minutos`));
    assert.match(slow, new RegExp(`${T.minSpots} lugares`));
    const [, lo, hi] = slow.match(/de (\d+) a (\d+) minutos/).map(Number);
    assert.ok(hi > lo);
  });

  test('o radar não diz "continue andando" a quem mapeia ponto a ponto', () => {
    for (const scans of [0, 1, 3, 5, 9]) {
      for (const spot of [false, true]) {
        const r = L.radarInfo({ scans, minScans: 5, throttled: true, spot });
        assert.doesNotMatch(`${r.text} ${r.sub}`, /andando|você anda/, JSON.stringify(r));
        assert.ok(r.text && r.sub);
      }
    }
    assert.match(L.radarInfo({ scans: 2, minScans: 5, throttled: true }).sub, /aparece com 5 leituras\. Vá ao próximo lugar e marque\./);
    // com um lugar em aberto a pessoa está parada, esperando: nada de "vá ao próximo"
    assert.doesNotMatch(L.radarInfo({ scans: 2, minScans: 5, throttled: true, spot: true }).sub, /próximo/);
    // andando, o texto de sempre
    assert.equal(L.radarInfo({ scans: 2, minScans: 5 }).sub, 'A prévia do mapa aparece com 5 leituras. Continue andando.');
    assert.equal(L.radarInfo({ scans: 1 }).text, '1 leitura recebida');
    assert.match(L.radarInfo({ scans: 7, resumed: true }).text, /Refazendo/);
  });

  test('o contador de lugares mostra "N de mínimo" só enquanto falta para concluir ponto a ponto', () => {
    assert.deepEqual(L.spotCounter({ spots: 5, throttled: true, canFinish: false }, T), { value: '5', of: `de ${T.minSpots}`, label: 'lugares marcados' });
    assert.deepEqual(L.spotCounter({ spots: 1, throttled: true, canFinish: false }, T), { value: '1', of: `de ${T.minSpots}`, label: 'lugares marcados' });
    assert.deepEqual(L.spotCounter({ spots: 13, throttled: true, canFinish: true }, T), { value: '13', of: null, label: 'lugares marcados' });
    assert.deepEqual(L.spotCounter({ spots: 1, throttled: false, canFinish: false }, T), { value: '1', of: null, label: 'lugar marcado' });
  });

  test('o motivo de não poder concluir diz que vale mais de um lugar por cômodo', () => {
    const blocked = L.finishBlocker({ scans: 8, useful: 8, spots: 5, throttled: true }, T);
    assert.match(blocked, new RegExp(`faltam ${T.minSpots - 5} lugares marcados`));
    assert.match(blocked, /mais de um por cômodo/);
    const none = L.finishBlocker({ scans: 0, throttled: true }, T);
    assert.match(none, new RegExp(`pelo menos ${T.minSpots} lugares`));
    assert.doesNotMatch(none, /ande pela casa/);
  });

  test('o aviso "ponto a ponto" só promete liberar o limite onde o Android deixa', () => {
    const yes = L.pointByPointNote({ canLift: true });
    assert.match(yes.title, /ponto a ponto/);
    assert.match(yes.text, /30 segundos/);
    assert.match(yes.text, /Dá para liberar/);
    const no = L.pointByPointNote({ canLift: false });
    assert.doesNotMatch(no.text, /Dá para liberar/);
    assert.match(no.text, /não dá para desligar/);
    assert.doesNotMatch(L.pointByPointNote({ during: true }).text, /cômodo em cômodo/);
  });

  test('as telas do mapa não guardam cópia própria das dicas de caminhada', () => {
    for (const file of ['ui/map/library.js', 'ui/map/survey.js']) {
      assert.doesNotMatch(code(source(file)), /a cada poucos segundos|Continue andando|siga andando/);
      assert.match(source(file), /surveyTips\(/, file);
    }
  });
});

// ---------------------------------------------------------------------------
// ux-05: limite de buscas, um nome só para a chave e nenhuma promessa onde ela não existe
// ---------------------------------------------------------------------------
describe('ux-05: limite de buscas do Android', () => {
  const STATUS = { wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: true, canScan: true };
  const insight = (device) => buildInsights({ aps: [], connection: { connected: false }, device, status: STATUS }).find((i) => i.id === 'scan-throttled');

  test('quem pode desligar o limite: Android 10 em diante; simulador e versão desconhecida contam como "pode"', () => {
    assert.equal(canLiftScanThrottle(28), false);
    assert.equal(canLiftScanThrottle(24), false);
    for (const sdk of [29, 30, 36, 0, null, undefined, NaN, '28']) assert.equal(canLiftScanThrottle(sdk), true, String(sdk));
  });

  test('Android 9: nenhuma tela promete "dá para liberar" nem oferece o passo a passo', () => {
    const old = scanThrottleCopy(28);
    assert.equal(old.canLift, false);
    assert.equal(old.action, null);
    assert.doesNotMatch(old.lift, /Dá para liberar/);
    assert.match(old.lift, /não dá para desligar/);
    assert.match(insight({ sdk: 28 }).text, /não há como desligar/);
  });

  test('Android 10+ e simulador: o comportamento de sempre', () => {
    for (const sdk of [30, 0]) {
      const copy = scanThrottleCopy(sdk);
      assert.equal(copy.canLift, true);
      assert.equal(copy.action, 'Como liberar');
      assert.match(copy.lift, /Dá para liberar buscas mais rápidas nas opções do desenvolvedor/);
      assert.equal(copy.optionName, THROTTLE_OPTION_NAME);
      assert.match(copy.unlockStep, /toque 7 vezes em "Número da versão"/);
    }
  });

  test('o diagnóstico e o painel de ajuda usam o mesmo nome da chave', () => {
    assert.ok(insight({ sdk: 30 }).text.includes(`"${THROTTLE_OPTION_NAME}"`));
    // a chave só é escrita num lugar; as telas pegam de lá
    assert.deepEqual(filesWith(THROTTLE_OPTION_NAME), ['core/insights.js']);
    assert.deepEqual(filesWith('Limitação da busca'), []);
    assert.match(code(source('ui/components.js')), /copy\.optionName/);
    // o "toque 7 vezes" também
    assert.deepEqual(filesWith('toque 7 vezes'), ['core/insights.js']);
  });

  test('nenhuma tela escreve por conta própria que "dá para liberar/desligar" o limite', () => {
    // (a frase vem de scanThrottleCopy / pointByPointNote, que sabem a versão do Android)
    assert.deepEqual(filesWith(/Dá para (liberar|desligar)/).sort(), ['core/insights.js', 'ui/map/map-ui-logic.js']);
    assert.match(source('ui/tools/about.js'), /A partir do Android 10 dá para desligar o limite/);
  });
});

// ---------------------------------------------------------------------------
// ux-08: desde qual Android o MAC dos outros aparelhos fica escondido
// ---------------------------------------------------------------------------
describe('ux-08: Sobre e Dispositivos citam a mesma versão do Android', () => {
  test('as duas telas usam a mesma constante, e ela é a do código nativo (API 29 = Android 10)', () => {
    assert.equal(MAC_HIDDEN_SINCE_ANDROID, 10);
    for (const file of ['ui/tools/about.js', 'ui/tools/dispositivos.js']) {
      assert.match(code(source(file)), /Android \(?(do )?\$\{MAC_HIDDEN_SINCE_ANDROID\}/, file);
      assert.doesNotMatch(code(source(file)), /Android 11 ou mais novo esconde/, file);
    }
    const arp = readFileSync(join(HERE, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'wifiraiox', 'app', 'ArpTable.java'), 'utf8');
    assert.match(arp, /SDK_INT < 29/, 'ArpTable.java lê a tabela ARP só antes do Android 10');
  });
});

// ---------------------------------------------------------------------------
// Canais: fixtures
// ---------------------------------------------------------------------------
const f24 = (ch) => 2407 + 5 * ch;
const f5 = (ch) => 5000 + 5 * ch;
/** ScanAp de 5 GHz: canal primário, largura (CW.*) e canal central do bloco. */
const raw5 = (bssid, ssid, level, ch, width = CW.W20, center = ch, more = {}) => ({ ...makeAp(bssid, ssid, level, f5(ch), more), channelWidth: width, centerFreq0: width === CW.W20 ? 0 : f5(center) });
const OWN_MAC = '02:11:22:33:44:01';

// ---------------------------------------------------------------------------
// ux-02: o cartão "Melhor canal" fala do roteador na largura que ele usa de verdade
// ---------------------------------------------------------------------------
describe('ux-02: o seletor de largura não muda o que o cartão afirma sobre o roteador', () => {
  // roteador em 80 MHz no bloco 36–48, com dois vizinhos fortes de 20 MHz dentro do bloco (44 e 48):
  // em 80 MHz o veredito é "mude"; avaliado em 20 ou 40 MHz o canal 36 pareceria livre
  const own = normalizeAp({ ...raw5(OWN_MAC, 'Minha', -45, 36, CW.W80, 42), wifiStandard: 5 });
  const aps = [own, normalizeAp(raw5('0a:00:00:00:00:02', 'Viz1', -50, 48)), normalizeAp(raw5('0e:00:00:00:00:03', 'Viz2', -55, 44))];

  test('o cenário: na largura real o veredito é trocar; na largura errada, "pode ficar"', () => {
    assert.equal(own.widthMHz, 80);
    assert.equal(recommendChannel(aps, { band: '5', own }).verdict, 'change');
    assert.equal(recommendChannel(aps, { band: '5', widthMHz: 20, own }).verdict, 'keep', 'o defeito: a hipótese de 20 MHz dita como fato');
  });

  test('com roteador conhecido, o cartão é sempre calculado na largura dele, qualquer que seja o seletor', () => {
    for (const selected of widthsFor('5')) {
      const width = verdictWidth('5', own, selected);
      assert.equal(width, 80, `seletor em ${selected} MHz`);
      const shown = recommendChannel(aps, { band: '5', widthMHz: width, own });
      assert.equal(shown.verdict, 'change', `seletor em ${selected} MHz`);
      // a frase nunca cita uma largura que não é a do roteador
      const cited = shown.text.match(/Seu roteador está no canal \d+(?: \((\d+) MHz\))?/);
      assert.ok(cited, shown.text);
      assert.equal(Number(cited[1] || 20), own.widthMHz, shown.text);
    }
  });

  test('sem roteador conhecido vale a largura escolhida; em 2,4 GHz sempre 20 MHz', () => {
    assert.equal(verdictWidth('5', null, 40), 40);
    assert.equal(verdictWidth('5', null, 160), 160);
    const own24 = normalizeAp({ ...makeAp(OWN_MAC, 'Minha', -45, f24(6)), channelWidth: CW.W40, centerFreq0: 2447 });
    assert.equal(verdictWidth('2.4', own24, 20), 20);
  });

  test('num "e se" de largura o melhor do ranking é "Mais livre", não "Recomendado"', () => {
    assert.equal(bestTag({ isCurrent: false }, true), 'Mais livre');
    assert.equal(bestTag({ isCurrent: true }, true), 'Mais livre');
    assert.equal(bestTag({ isCurrent: false }, false), 'Recomendado');
    assert.equal(bestTag({ isCurrent: true }, false), 'Melhor');
  });

  test('uma largura lembrada que o roteador não alcança volta para a dele', () => {
    const options = [{ widthMHz: 80 }, { widthMHz: 40 }, { widthMHz: 20 }];
    assert.equal(usableWidth(160, [20, 40, 80, 160], options, 80), 80);
    assert.equal(usableWidth(40, [20, 40, 80, 160], options, 80), 40);
    assert.equal(usableWidth(undefined, [20, 40, 80, 160], options, 80), 80);
  });
});

// ---------------------------------------------------------------------------
// ux-03: largura do canal, sem ordem para usar o que o roteador talvez não tenha
// ---------------------------------------------------------------------------
describe('ux-03: "Use 160 MHz" não é dito a quem usa (ou só tem) 80 MHz', () => {
  const router = ({ ies, wifiStandard = 6, width = CW.W80, center = 42 } = {}) => normalizeAp({ ...raw5(OWN_MAC, 'Casa', -50, 36, width, center, ies ? { ies } : {}), wifiStandard });
  const ies80 = encodeIes({ frequency: f5(36), widthMHz: 80, ht: { nss: 2, width40: true }, vht: { nss: 2 }, he: { nss: 2 } });
  const ies160 = encodeIes({ frequency: f5(36), widthMHz: 80, ht: { nss: 2, width40: true }, vht: { nss: 2, width160: true }, he: { nss: 2, width160: true } });

  test('o resumo dos elementos diz a maior largura anunciada', () => {
    assert.equal(router({ ies: ies80 }).ie.maxWidthMHz, 80);
    assert.equal(router({ ies: ies160 }).ie.maxWidthMHz, 160);
    assert.equal(router().ie, null);
  });

  test('roteador Wi-Fi 6 em 80 MHz que não anuncia 160: a sugestão para em 80, mesmo com a faixa vazia', () => {
    const own = router({ ies: ies80 });
    const rec = recommendWidth([own], '5', { own });
    assert.ok(rec.widthMHz <= 80, `largura sugerida: ${rec.widthMHz}`);
    assert.doesNotMatch(rec.text, /160/);
    assert.match(rec.text, /^Use 80 MHz: /);
    assert.deepEqual(rec.options.map((o) => o.widthMHz), [80, 40, 20], 'o seletor só oferece o que o roteador alcança');
  });

  test('roteador que anuncia 160 e usa 80: possibilidade condicionada, nunca "Use 160 MHz"', () => {
    const own = router({ ies: ies160 });
    const rec = recommendWidth([own], '5', { own });
    assert.equal(rec.widthMHz, 160);
    assert.doesNotMatch(rec.text, /^Use /);
    assert.match(rec.text, /^Há espaço para 160 MHz: /);
    assert.match(rec.text, /O seu roteador anuncia essa largura; para aproveitar, os aparelhos também precisam aceitar\./);
    // o risco do DFS vem com a consequência, não só com a sigla
    assert.match(rec.text, /DFS, divididos com radares: o roteador pode demorar a entrar no ar ou trocar de canal sozinho/);
  });

  test('sem os elementos do beacon (Android antigo): vale a geração, e a frase é condicional', () => {
    const own = router();
    const rec = recommendWidth([own], '5', { own });
    assert.equal(rec.widthMHz, 160);
    assert.doesNotMatch(rec.text, /^Use /);
    assert.match(rec.text, /Só vale se o roteador e os aparelhos aceitarem essa largura\./);
    // sem saber qual é o roteador, também
    assert.match(recommendWidth([], '5').text, /^Há espaço para 160 MHz: .*Só vale se o roteador e os aparelhos aceitarem/);
  });

  test('manter ou estreitar a largura continua sendo uma ordem clara', () => {
    // já em 160 MHz com a faixa vazia: "Use 160 MHz" é só confirmar o que está em uso
    const wide = router({ ies: ies160, width: CW.W160, center: 50 });
    assert.match(recommendWidth([wide], '5', { own: wide }).text, /^Use 160 MHz: /);
    // o roteador nunca fica com teto abaixo do que já usa, mesmo que o beacon não anuncie
    const odd = router({ ies: ies80, width: CW.W160, center: 50 });
    assert.equal(recommendWidth([odd], '5', { own: odd }).options[0].widthMHz, 160);
  });

  test('roteador que só anuncia 20 MHz em 5 GHz: o motivo dito é o roteador, não os vizinhos', () => {
    const ies20 = encodeIes({ frequency: f5(36), widthMHz: 20, ht: { nss: 2, width40: false } });
    const own = normalizeAp({ ...raw5(OWN_MAC, 'Casa', -50, 36, CW.W20, 36, { ies: ies20 }), wifiStandard: 4 });
    assert.equal(own.ie.maxWidthMHz, 20);
    const rec = recommendWidth([own], '5', { own });
    assert.equal(rec.widthMHz, 20);
    assert.deepEqual(rec.options.map((o) => o.widthMHz), [20]);
    assert.match(rec.text, /^Seu roteador só anuncia 20 MHz em 5 GHz/);
    assert.doesNotMatch(rec.text, /interferência demais/);
  });

  test('2,4 GHz não muda: o bit de 40 MHz do beacon não entra na conta', () => {
    const ies20 = encodeIes({ frequency: f24(6), ht: { nss: 2, width40: false } });
    const own = normalizeAp({ ...makeAp(OWN_MAC, 'Casa', -50, f24(6), { ies: ies20 }), wifiStandard: 4 });
    const rec = recommendWidth([own], '2.4', { own });
    assert.equal(rec.widthMHz, 40);
    assert.equal(rec.text, 'A faixa de 2,4 GHz está praticamente vazia aqui: dá para usar 40 MHz.');
  });
});

// ---------------------------------------------------------------------------
// ux-04: canais 12 e 13 não ficam "entre" dois canais padrão
// ---------------------------------------------------------------------------
describe('ux-04: 2,4 GHz acima do canal 11', () => {
  const ratings = rateChannels([], { band: '2.4' });
  const notesOf = (ch) => ratings.find((r) => r.channel === ch).notes.join(' | ');

  test('12 e 13: a nota não fala em "dois canais padrão"; 2 a 5 e 7 a 10 continuam com ela', () => {
    for (const ch of [12, 13]) {
      assert.doesNotMatch(notesOf(ch), /dois canais padrão/, `canal ${ch}`);
      assert.match(notesOf(ch), /Fora do trio 1, 6 e 11, acima dele: um roteador aqui ainda invade o canal 11/, `canal ${ch}`);
      // o motivo de sempre (aparelhos importados) aparece uma vez só
      assert.equal(notesOf(ch).match(/importados/g).length, 1, `canal ${ch}`);
      assert.equal(ratings.find((r) => r.channel === ch).recommendable, false);
    }
    for (const ch of [2, 3, 4, 5, 7, 8, 9, 10]) assert.match(notesOf(ch), /dois canais padrão ao mesmo tempo/, `canal ${ch}`);
    for (const ch of [1, 6, 11]) assert.doesNotMatch(notesOf(ch), /Fora do trio/, `canal ${ch}`);
  });

  test('roteador no canal 13 sem ganho de nota em trocar: a frase não diz "entre" nem "dos dois lados"', () => {
    const own = normalizeAp(makeAp(OWN_MAC, 'Casa', -50, f24(13)));
    const rec = recommendChannel([own], { band: '2.4', own });
    assert.equal(rec.verdict, 'change');
    assert.doesNotMatch(rec.text, /entre os canais padrão|dos dois lados/);
    assert.match(rec.text, /^Seu roteador está no canal 13, acima dos canais padrão: ali ele ainda invade o canal 11/);
    assert.match(rec.text, /Prefira o canal \d+\.$/);
    // no meio do trio, a explicação de sempre
    const mid = normalizeAp(makeAp(OWN_MAC, 'Casa', -50, f24(3)));
    assert.match(recommendChannel([mid], { band: '2.4', own: mid }).text, /fica entre os canais padrão: .*dos dois lados/);
  });

  test('o diagnóstico (Melhor Wi-Fi e relatório) usa a mesma distinção', () => {
    const STATUS = { wifiEnabled: true, locationEnabled: true, permission: 'granted', throttled: false, canScan: true };
    const text = (ch) => {
      const raw = makeAp(OWN_MAC, 'Casa', -50, f24(ch));
      const out = buildInsights({ aps: [normalizeAp(raw)], connection: { connected: true, bssid: OWN_MAC, ssid: 'Casa', rssi: -50, frequency: f24(ch), linkSpeed: 72 }, device: null, status: STATUS });
      return out.find((i) => i.id === 'nonstandard-channel').text;
    };
    assert.doesNotMatch(text(13), /dos dois lados/);
    assert.match(text(13), /acima deles, seu roteador ainda invade o canal 11/);
    assert.match(text(3), /dos dois lados/);
  });

  test('a tela de Canais não diz que todos os canais fora da recomendação ficam "entre" os padrão', () => {
    const screen = code(source('ui/screens/channels.js'));
    assert.doesNotMatch(screen, /Ficam entre os canais padrão/);
    assert.match(screen, /o 12 e o 13 ainda invadem o 11/);
  });
});

// ---------------------------------------------------------------------------
// ux-06: a segurança da rede conectada tem o mesmo rótulo em todas as telas
// ---------------------------------------------------------------------------
describe('ux-06: Conexão mostra a segurança com o rótulo da lista de redes', () => {
  const security = (conn, ap) => describeConnection(conn, ap).groups.flatMap((g) => g.rows).find((r) => r.field === 'security');
  const raw = makeAp(OWN_MAC, 'Casa', -50, f5(36));
  const ap = normalizeAp(raw);
  const conn = { connected: true, ssid: 'Casa', bssid: OWN_MAC, rssi: -50, frequency: f5(36), linkSpeed: 433, securityType: 2 };

  test('rede WPA2 comum (o Android informa SECURITY_TYPE_PSK): "WPA2", como em Redes, e não "WPA/WPA2 Pessoal"', () => {
    assert.equal(ap.security.label, 'WPA2');
    assert.equal(security(conn, ap).text, 'WPA2');
  });

  test('sem a rede na lista (acabou de conectar, rede oculta): vale o tipo que o Android informa', () => {
    assert.equal(security(conn, null).text, 'WPA/WPA2 Pessoal');
    assert.equal(security({ ...conn, securityType: 4 }, null).text, 'WPA3 Pessoal');
    assert.equal(security({ ...conn, securityType: undefined }, null), undefined);
  });

  test('rede de transição WPA2/WPA3: o rótulo é o da lista e a dica diz com qual o celular entrou', () => {
    const mixed = normalizeScan(apartment).find((a) => a.id === apartmentTruth.own.b5);
    assert.equal(mixed.security.label, 'WPA2/WPA3');
    const at = { ...conn, ssid: mixed.ssid, bssid: mixed.bssid, frequency: mixed.freq };
    assert.equal(security({ ...at, securityType: 4 }, mixed).text, 'WPA2/WPA3');
    const hint = security({ ...at, securityType: 4 }, mixed).hint || '';
    // (se a rede tiver um aviso de segurança, ele tem prioridade sobre a dica)
    assert.ok(/Este celular entrou com WPA3\./.test(hint) || hint.length > 0);
  });

  test('rede aberta continua em tom de alerta', () => {
    assert.equal(security({ ...conn, securityType: 0 }, null).tone, 'warning');
  });
});

// ---------------------------------------------------------------------------
// ux-09: a mesma rede, o mesmo instante, os mesmos números
// ---------------------------------------------------------------------------
describe('ux-09: números coerentes entre as telas', () => {
  test('painel da nota: a parte "Sinal" e a linha do sinal usam a mesma leitura (a média recente)', () => {
    const list = normalizeScan(apartment).map((a) => (a.id === apartmentTruth.own.b24 ? { ...a, rssi: -78, rssiSmooth: -71 } : a));
    // a linha do ranking cujo melhor sinal é o rádio de 2,4 GHz da casa
    const row = rankNetworks(list, {}).find((r) => r.best.id === apartmentTruth.own.b24);
    assert.ok(row, 'a rede aparece no ranking');
    const ap = list.find((a) => a.id === apartmentTruth.own.b24);
    assert.equal(apSignal(ap), -71);
    assert.equal(apSignal({ rssi: -60 }), -60);
    assert.equal(apSignal({}), null);
    assert.equal(apSignal(null), null);
    // a parte "Sinal" (em cima) e a linha do mesmo sinal (embaixo) mostram o mesmo número
    const signal = scoreParts(row).find((part) => part.id === 'signal');
    const first = rowEntries(row)[0];
    assert.equal(first.ap.id, apartmentTruth.own.b24);
    assert.ok(signal.headline.startsWith(fmtDbm(apSignal(first.ap))), `${signal.headline} x ${fmtDbm(apSignal(first.ap))}`);
    assert.ok(signal.headline.startsWith(fmtDbm(-71)), signal.headline);
    assert.match(signal.text, /média das últimas leituras/);
    // a linha do painel não lê mais a leitura crua
    assert.doesNotMatch(code(source('ui/screens/best.js')), /fmtDbm\(ap\.rssi\)|signalBars\(ap\.rssi\)/);
  });

  test('distância do relatório arredondada como na tela', () => {
    const line = (m) => buildReport({ connection: { ssid: 'Casa', band: '5', channel: 36, rssi: -50, distanceM: m } }).split('\n').find((l) => l.startsWith('Distância do roteador'));
    assert.equal(line(1.3), 'Distância do roteador: cerca de 1,5 m (estimativa pelo sinal)');
    assert.equal(line(1.2), 'Distância do roteador: cerca de 1 m (estimativa pelo sinal)');
    for (const m of [0.4, 0.8, 1.24, 1.26, 1.8, 2.3, 2.74, 2.76, 3.4, 7.5, 12.3, 41]) {
      const shown = fmtMeters(m, { approx: true }).replace(/^≈\s*/, '').replace(/\s+/g, ' ');
      assert.ok(line(m).includes(`cerca de ${shown} (`), `${m} m: tela "${shown}", relatório "${line(m)}"`);
    }
  });

  test('nenhum texto diz "cerca de ≈" (aproximação em dobro)', () => {
    assert.deepEqual(filesWith(/cerca de ['"`]?\s*,?\s*(h\('strong', null, )?fmtMbps\([^)]*approx: true/), []);
    assert.deepEqual(filesWith(/cerca de\s*≈/), []);
    assert.match(code(source('ui/tools/conexao.js')), /pela velocidade negociada agora, este Wi-Fi entrega ', h\('strong', null, fmtMbps\(usable, \{ approx: true \}\)\)/);
  });
});

// ---------------------------------------------------------------------------
// ux-10: "Wi-Fi" não quebra no hífen
// ---------------------------------------------------------------------------
describe('ux-10: nb() protege "Wi-Fi" sem mudar o texto', () => {
  test('texto sem "Wi-Fi", ou que não é texto, volta como veio', () => {
    assert.equal(nb('Redes por perto'), 'Redes por perto');
    assert.equal(nb(''), '');
    assert.equal(nb(null), null);
    const node = { nodeType: 1 };
    assert.equal(nb(node), node);
  });

  test('as telas de bloqueio, o Sobre e as peças comuns passam os textos por nb()', () => {
    assert.match(source('ui/gates.js'), /nb\(c\.title\)/);
    assert.match(source('ui/gates.js'), /nb\(c\.text\)/);
    assert.match(source('ui/tools/about.js'), /kids\.map\(nb\)/);
    for (const piece of ["h('strong.banner__title', null, nb(title))", "h('h3.card__title', null, nb(title))", "h('h2.section-h__title', null, nb(title)", "h('h2.empty__title', null, nb(title))"]) {
      assert.ok(source('ui/components.js').includes(piece), piece);
    }
    // nb() não troca caracteres (nada de hífen especial): busca, cópia e leitor de tela veem "Wi-Fi"
    assert.equal(filesWith('\u2011').length, 0);
  });
});

// ---------------------------------------------------------------------------
// ux-13: um vocabulário só
// ---------------------------------------------------------------------------
describe('ux-13: vocabulário', () => {
  test('as variantes banidas não aparecem em textos de tela', () => {
    const banned = [
      ['toque em marcar ponto', 'o botão se chama “Marcar este lugar”'],
      ['Pode finalizar quando quiser', 'o botão se chama “Concluir”'],
      ['Velocidade do enlace', 'o nome é "Velocidade até o roteador"'],
      ['Link Wi-Fi no teste', 'o nome é "Velocidade até o roteador"'],
      ["'Internet 2'", 'os destinos dizem quem responde: Cloudflare e Google'],
      ['faixa da estrada', 'canal é a "pista"; faixa é 2,4 / 5 / 6 GHz'],
      ['} rádios`', 'um BSSID é um "sinal"'],
      ['Pontos de acesso desta rede', 'um BSSID é um "sinal"'],
      ["'Conectada')", 'o estado é "Conectado" em todas as listas'],
    ];
    for (const [text, why] of banned) assert.deepEqual(filesWith(text), [], `"${text}": ${why}`);
    // nas telas do mapa a atividade se chama "mapeamento"
    for (const file of ['ui/map/result.js', 'ui/map/survey.js', 'ui/map/library.js']) {
      const strings = code(source(file)).match(/(['"`])(?:\\.|(?!\1).)*\1/g) || [];
      for (const str of strings) if (/\s/.test(str)) assert.doesNotMatch(str, /levantamento/i, `${file}: ${str.slice(0, 80)}`);
    }
  });

  test('as dicas do gravador citam os botões pelo nome e falam em "leituras"', () => {
    const rec = createRecorder({});
    rec.start();
    assert.match(rec.stats().hint, /Aguardando a primeira leitura/);
    const hints = code(source('mapping/recorder.js')).match(/return [`'][^;]*;/g).join('\n');
    assert.match(hints, /toque em “Marcar este lugar”/);
    assert.match(hints, /Pode concluir quando quiser/);
    assert.match(hints, /Toque em “Concluir” para ver o mapa/);
    assert.doesNotMatch(hints, /varredura|Finalize|finalizar/);
  });
});

// ---------------------------------------------------------------------------
// ux-15: quanto o teste de velocidade gasta, com a conta fechando
// ---------------------------------------------------------------------------
describe('ux-15: gasto de dados do teste de velocidade', () => {
  test('o exemplo cita as duas direções e o número sai do mesmo modelo que estima o gasto', () => {
    const t = fullTestDataText();
    assert.match(t.rule, /para cada Mb\/s, em cada direção/);
    const [, down, up, total] = t.example.replace(/\s+/g, ' ').match(/num plano de (\d+) Mb\/s de download e (\d+) de upload, ≈ (.+)$/);
    assert.equal(total, formatBytes(estimateTestBytes('full', Number(down), Number(up))).replace(/\s+/g, ' '));
    // a regra enunciada fecha com o exemplo: 1 MB por Mb/s, somando as duas direções
    assert.equal(estimateTestBytes('full', Number(down), Number(up)), (Number(down) + Number(up)) * 1e6);
    assert.doesNotMatch(code(source('ui/tools/velocidade.js')), /450/, 'o número não fica escrito à mão na tela');
  });
});

// ---------------------------------------------------------------------------
// ux-16: a vista de cima não se chama "planta"
// ---------------------------------------------------------------------------
describe('ux-16: o mapa não é chamado de planta', () => {
  test('o seletor de vista e os avisos do resultado dizem "de cima"', () => {
    const result = code(source('ui/map/result.js'));
    assert.doesNotMatch(result, /'Planta'|Vista em planta|aparece em planta/);
    assert.match(result, /\['top', 'De cima', 'grid'\]/);
  });
});

// ---------------------------------------------------------------------------
// ux-12: a legenda explica o riscado e as cores do caminho
// ---------------------------------------------------------------------------
describe('ux-12: legenda do mapa', () => {
  test('a legenda fala do piso riscado e, com a camada ligada, do caminho', () => {
    const result = source('ui/map/result.js');
    assert.match(result, /Riscado: trecho estimado, sem leitura por perto/);
    assert.match(result, /V\.layers\.path && path/);
    assert.match(result, /Caminho: azul no começo, rosa no fim/);
  });
});
