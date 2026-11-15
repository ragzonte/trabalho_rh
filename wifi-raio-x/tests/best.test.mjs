// Contas puras da tela Melhor Wi-Fi (app/js/ui/screens/best.js): o que a tela mostra a partir
// do ranking, da recomendação e do diagnóstico de app/js/core.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOP_ROWS,
  scoreLook,
  roundEstimate,
  estText,
  rowEntries,
  isMine,
  visibleRows,
  shortWarning,
  rowNotes,
  scoreParts,
  scoreReasons,
  splitInsights,
  diagSummary,
  channelsRoute,
  heroKind,
  gainText,
  analyse,
} from '../app/js/ui/screens/best.js';
import { createStore } from '../app/js/store.js';
import { THIN, MINUS } from '../app/js/ui/dom.js';
import * as fx from './fixtures/scans.mjs';

const INFO = { platform: 'android', sdk: 34, release: '14', manufacturer: 'Google', model: 'Pixel 7', appVersion: '1.0.0', bands: { b24: true, b5: true, b6: true, b60: false }, standards: [4, 5, 6], rtt: true };
const HOME_24 = '98:da:c4:3b:7e:10'; // "Familia Souza", 2,4 GHz, do cenário do apartamento

const connectionTo = (ap, more = {}) => ({ connected: true, ssid: ap.ssid, bssid: ap.bssid, rssi: ap.level, frequency: ap.frequency, linkSpeed: 144, txSpeed: 144, rxSpeed: 144, wifiStandard: 6, securityType: 2, ...more });

/** Estado do store como o app o teria depois de uma varredura. */
function stateFor(scan, { connection = { connected: false }, favorites = [], info = INFO } = {}) {
  const store = createStore();
  store.setInfo(info);
  for (const ssid of favorites) store.setFavorite(ssid, true);
  store.setConnection(connection);
  store.ingestScan({ ...scan, ts: Date.now() });
  return store.get();
}

const homeState = (options) => stateFor(fx.apartment, { connection: connectionTo(fx.apartment.aps.find((a) => a.bssid === HOME_24)), ...options });

/** Linha de ranking mínima para os testes que não precisam do núcleo. */
const fakeRow = (key, more = {}) => ({ key, ssid: key, name: key, hidden: false, best: { bssid: `aa:bb:cc:00:00:${key.length.toString(16).padStart(2, '0')}`, own: false }, others: [], score: 50, estMbps: 10, favorite: false, connected: false, ...more });

test('scoreLook: a palavra e o degrau de cor seguem a nota que aparece (arredondada)', () => {
  assert.deepEqual(scoreLook(100), { step: 1, word: 'Excelente' });
  assert.deepEqual(scoreLook(85), { step: 1, word: 'Excelente' });
  assert.deepEqual(scoreLook(84.4), { step: 1, word: 'Ótima' });
  assert.deepEqual(scoreLook(70), { step: 1, word: 'Ótima' });
  assert.deepEqual(scoreLook(69.6), { step: 1, word: 'Ótima' }, '69,6 aparece como 70');
  assert.deepEqual(scoreLook(69.4), { step: 2, word: 'Boa' });
  assert.deepEqual(scoreLook(55), { step: 2, word: 'Boa' });
  assert.deepEqual(scoreLook(54), { step: 3, word: 'Regular' });
  assert.deepEqual(scoreLook(40), { step: 3, word: 'Regular' });
  assert.deepEqual(scoreLook(39), { step: 4, word: 'Fraca' });
  assert.deepEqual(scoreLook(20), { step: 4, word: 'Fraca' });
  assert.deepEqual(scoreLook(19), { step: 5, word: 'Ruim' });
  assert.deepEqual(scoreLook(0), { step: 5, word: 'Ruim' });
  assert.deepEqual(scoreLook(NaN), { step: 5, word: 'Ruim' });
  assert.deepEqual(scoreLook(undefined), { step: 5, word: 'Ruim' });
  assert.deepEqual(scoreLook(90, false), { step: 5, word: 'Sem uso' });
});

test('roundEstimate e estText: dois algarismos significativos, como nas frases da recomendação', () => {
  assert.equal(roundEstimate(619.7), 620);
  assert.equal(roundEstimate(462.8), 460);
  assert.equal(roundEstimate(74.6), 75);
  assert.equal(roundEstimate(7.46), 7.5);
  assert.equal(roundEstimate(0.6), 0.6);
  assert.equal(roundEstimate(0), 0);
  assert.equal(roundEstimate(1134), 1100);
  assert.equal(roundEstimate(-1), null);
  assert.equal(roundEstimate(NaN), null);
  assert.equal(roundEstimate(null), null);

  assert.equal(estText(619.7), `≈${THIN}620${THIN}Mb/s`);
  assert.equal(estText(7.46), `≈${THIN}7,5${THIN}Mb/s`);
  assert.equal(estText(1134), `≈${THIN}1,1${THIN}Gb/s`);
  assert.equal(estText(null), '—');
  assert.equal(estText('rápida'), '—');
});

test('rowEntries e isMine: a estrela, a rede em uso e as redes do mesmo roteador contam como minhas', () => {
  assert.deepEqual(rowEntries(null), []);
  assert.deepEqual(rowEntries({}), []);
  const row = fakeRow('Casa', { others: [{ ap: { bssid: 'x', own: false }, score: 10, estMbps: 1 }, null, { score: 3 }] });
  assert.equal(rowEntries(row).length, 2, 'entradas tortas ficam de fora');
  assert.equal(rowEntries(row)[0].ap, row.best);

  assert.equal(isMine(fakeRow('A')), false);
  assert.equal(isMine(fakeRow('A', { favorite: true })), true);
  assert.equal(isMine(fakeRow('A', { connected: true })), true);
  assert.equal(isMine(fakeRow('A', { best: { bssid: 'y', own: true } })), true);
  assert.equal(isMine(fakeRow('A', { others: [{ ap: { bssid: 'z', own: true }, score: 1, estMbps: 1 }] })), true);
  assert.equal(isMine(null), false);
});

test('visibleRows: mostra as melhores, não esconde uma linha só e filtra as minhas', () => {
  const rows = Array.from({ length: 12 }, (_, i) => fakeRow(`rede-${i}`, { favorite: i === 7 || i === 9 }));
  const collapsed = visibleRows(rows);
  assert.equal(collapsed.rows.length, TOP_ROWS);
  assert.equal(collapsed.total, 12);
  assert.equal(collapsed.more, 12 - TOP_ROWS);
  assert.deepEqual(collapsed.rows, rows.slice(0, TOP_ROWS), 'a ordem do ranking é mantida');

  const expanded = visibleRows(rows, { expanded: true });
  assert.equal(expanded.rows.length, 12);
  assert.equal(expanded.more, 0);

  // TOP_ROWS + 1 redes: mostrar a sexta é melhor do que um botão "mostrar a outra 1 rede"
  const six = visibleRows(rows.slice(0, TOP_ROWS + 1));
  assert.equal(six.rows.length, TOP_ROWS + 1);
  assert.equal(six.more, 0);

  const mine = visibleRows(rows, { mineOnly: true });
  assert.deepEqual(mine.rows.map((r) => r.key), ['rede-7', 'rede-9']);
  assert.equal(mine.total, 2);

  assert.deepEqual(visibleRows(null), { rows: [], total: 0, more: 0 });
  assert.deepEqual(visibleRows([null, 3, 'x']), { rows: [], total: 0, more: 0 });
});

test('shortWarning: só o começo do aviso cabe na linha do ranking', () => {
  assert.equal(shortWarning('Sinal no limite: a conexão pode cair a qualquer momento.'), 'Sinal no limite');
  assert.equal(shortWarning('Rede aberta, sem senha e sem criptografia: quem estiver por perto pode ver o que você envia e recebe.'), 'Rede aberta, sem senha e sem criptografia');
  assert.equal(shortWarning('Não deu para estimar a velocidade desta rede.'), 'Não deu para estimar a velocidade desta rede');
  assert.equal(shortWarning(''), '');
  assert.equal(shortWarning(null), '');
});

test('rowNotes: no máximo três frases, o aviso primeiro, sem repetir a velocidade', () => {
  const good = rowNotes({ pros: ['Sinal excelente aqui', 'Muito rápida: cerca de 620 Mb/s', 'Canal livre', 'Roteador moderno (Wi-Fi 6)'], cons: [], warnings: [] });
  assert.deepEqual(good, { pros: ['Sinal excelente aqui', 'Canal livre'], cons: [], warning: null, moreWarnings: 0 });

  const mixed = rowNotes({ pros: ['Sinal bom aqui', 'Roteador moderno (Wi-Fi 6)'], cons: ['Canal ocupado 46% do tempo', 'Rede oculta: só entra quem sabe o nome'], warnings: [] });
  assert.deepEqual(mixed.cons, ['Canal ocupado 46% do tempo', 'Rede oculta: só entra quem sabe o nome']);
  assert.deepEqual(mixed.pros, ['Sinal bom aqui'], 'os contras têm prioridade quando não cabe tudo');

  const weak = rowNotes({
    pros: ['Roteador moderno (Wi-Fi 6)'],
    cons: ['Sinal muito fraco aqui', 'Lenta aqui: cerca de 3,8 Mb/s', 'Canal ocupado 45% do tempo'],
    warnings: ['Sinal no limite: a conexão pode cair a qualquer momento.', 'Não foi ouvida nas últimas buscas: a leitura pode estar desatualizada.'],
  });
  assert.deepEqual(weak, { pros: [], cons: ['Sinal muito fraco aqui', 'Canal ocupado 45% do tempo'], warning: 'Sinal no limite', moreWarnings: 1 });

  assert.deepEqual(rowNotes(null), { pros: [], cons: [], warning: null, moreWarnings: 0 });
  assert.deepEqual(rowNotes({ pros: 'x', cons: [null, 3, ''], warnings: [null] }), { pros: [], cons: [], warning: null, moreWarnings: 0 });
});

test('analyse no apartamento: manda trocar para o 5 GHz do mesmo roteador e explica cada nota', () => {
  const state = homeState();
  const { ranking, advice, insights, connected, band } = analyse(state);
  assert.equal(connected, true);
  assert.equal(band, '2.4');
  assert.ok(ranking.length >= 20, `${ranking.length} redes no ranking`);
  assert.equal(advice.kind, 'switch-band');
  assert.equal(heroKind(advice), 'switch');
  assert.equal(advice.target.ssid, 'Familia Souza_5G');
  assert.ok(gainText(advice.gain), 'o ganho vale um selo');
  assert.ok(insights.some((i) => i.id === 'band-upgrade'));

  // o ranking vem do melhor para o pior e a rede em uso está marcada
  for (let i = 1; i < ranking.length; i++) assert.ok(ranking[i - 1].score >= ranking[i].score);
  const current = ranking.find((r) => r.connected);
  assert.equal(current.ssid, 'Familia Souza');
  assert.equal(isMine(current), true);
  const twin = ranking.find((r) => r.ssid === 'Familia Souza_5G');
  assert.equal(isMine(twin), true, 'a outra faixa do mesmo roteador conta como minha');
  assert.ok(ranking.filter(isMine).length < ranking.length, 'os vizinhos não são meus');

  for (const row of ranking) {
    const parts = scoreParts(row);
    assert.deepEqual(parts.map((p) => p.id), ['signal', 'speed', 'congestion', 'security']);
    for (const part of parts) {
      assert.ok(Number.isInteger(part.value) && part.value >= 0 && part.value <= 100, `${row.name} ${part.id}: ${part.value}`);
      assert.ok(['good', 'warning', 'critical'].includes(part.tone));
      assert.ok(part.label && part.headline && part.text, `${row.name} ${part.id} tem rótulo, número e explicação`);
      assert.ok(!/undefined|NaN|null/.test(`${part.headline} ${part.text}`), `${row.name} ${part.id}: "${part.headline}" / "${part.text}"`);
    }
    const reasons = scoreReasons(row);
    assert.ok(reasons.length >= 1);
    for (const text of reasons) assert.ok(!/undefined|NaN|null/.test(text), `${row.name}: "${text}"`);
    if (row.detail.usable) assert.equal(reasons[reasons.length - 1], `Nota final: ${Math.round(row.score)} de 100.`);
  }

  const parts = scoreParts(twin);
  assert.ok(parts[0].headline.startsWith(`${MINUS}`), `o sinal vem em dBm: ${parts[0].headline}`);
  assert.ok(parts[1].headline.startsWith('até ≈'), parts[1].headline);
  assert.match(parts[2].text, /^Sobra cerca de \d+% do tempo do canal/);
  assert.match(parts[3].headline, /forte$/);
  assert.match(scoreReasons(twin)[0], /^Velocidade esperada aqui: ≈/);
});

test('scoreReasons: rede aberta perde metade, sinal fraco põe teto, WPA3 ganha bônus', () => {
  const { ranking } = analyse(homeState());
  const open = ranking.find((r) => r.security && r.security.known && r.security.level === 0 && r.detail.usable);
  assert.ok(open, 'o apartamento tem uma rede aberta');
  assert.ok(scoreReasons(open).some((t) => /cai pela metade/.test(t)));
  assert.equal(scoreParts(open)[3].headline, 'Aberta');
  assert.equal(scoreParts(open)[3].tone, 'critical');

  const capped = ranking.find((r) => r.detail.usable && r.detail.cap < 60 && !r.p2p);
  assert.ok(capped, 'há uma rede com o sinal no limite');
  assert.ok(scoreReasons(capped).some((t) => /segura a nota em no máximo \d+/.test(t)), scoreReasons(capped).join(' | '));

  const wpa3 = ranking.find((r) => r.detail.usable && r.security.protocols.includes('WPA3') && r.score < 97 && r.detail.cap >= 100);
  if (wpa3) assert.ok(scoreReasons(wpa3).some((t) => /WPA3/.test(t)), scoreReasons(wpa3).join(' | '));

  // celular que não usa 5 GHz: a rede fica sem nota, com o motivo
  const noFive = analyse(homeState({ info: { ...INFO, bands: { b24: true, b5: false, b6: false, b60: false }, standards: [4] } }));
  const five = noFive.ranking.find((r) => r.best.band === '5');
  assert.equal(five.detail.usable, false);
  assert.deepEqual(scoreReasons(five), ['Este celular não funciona na faixa desta rede: não dá para usá-la, e por isso a nota é zero.']);
  assert.deepEqual(scoreLook(five.score, five.detail.usable), { step: 5, word: 'Sem uso' });

  assert.deepEqual(scoreReasons(null), ['Com o que o celular informou não deu para estimar a velocidade desta rede, então ela fica sem nota.']);
  assert.equal(scoreParts(null).length, 4);
});

test('analyse sem conexão: indica a melhor rede; com uma rede marcada, manda conectar nela', () => {
  const off = analyse(stateFor(fx.apartment));
  assert.equal(off.connected, false);
  assert.equal(off.advice.kind, 'no-connection');
  assert.equal(heroKind(off.advice), 'connect');
  assert.ok(off.insights.some((i) => i.id === 'not-connected'));
  assert.equal(diagSummary(off.insights), null, '"não conectado" a recomendação já diz');

  const mine = analyse(stateFor(fx.apartment, { favorites: ['Familia Souza'] }));
  assert.equal(mine.advice.target.ssid, 'Familia Souza');
  assert.match(mine.advice.headline, /^Conecte-se à rede/);
  assert.equal(mine.ranking.find((r) => r.ssid === 'Familia Souza').favorite, true);

  const nothing = analyse(stateFor({ ...fx.apartment, aps: [] }));
  assert.deepEqual(nothing.ranking, []);
  assert.equal(heroKind(nothing.advice), 'offline');
});

test('analyse nunca lança: estado torto, conexão sem BSSID, limite de buscas', () => {
  const empty = analyse({ scan: { seq: 0 }, aps: [], connection: null, favorites: new Set(), info: null, status: null, loop: {} });
  assert.deepEqual(empty.ranking, []);
  assert.equal(typeof empty.advice.headline, 'string');

  const garbage = analyse({ aps: [null, 3, { bssid: 'x' }, {}], connection: 'sim', favorites: ['a'], info: 7, status: 'ok', loop: null });
  assert.ok(Array.isArray(garbage.ranking) && Array.isArray(garbage.insights));
  assert.equal(typeof garbage.advice.headline, 'string');

  // conectado, mas o Android não informou a rede: não pode virar "você não está conectado"
  const unknown = analyse({ ...stateFor(fx.apartment), connection: { connected: true, rssi: -50, frequency: 2437 } });
  assert.equal(unknown.connected, true);
  assert.equal(unknown.advice.kind, 'ok');
  assert.equal(unknown.advice.headline, 'Sem dados para comparar');
  assert.equal(heroKind(unknown.advice), 'unknown');

  // o laço de buscas percebeu o limite, mesmo sem o celular informar
  const base = homeState();
  assert.ok(!analyse(base).insights.some((i) => i.id === 'scan-throttled'));
  assert.ok(analyse({ ...base, loop: { ...base.loop, throttled: true } }).insights.some((i) => i.id === 'scan-throttled'));
  assert.ok(analyse({ ...base, status: { throttled: true } }).insights.some((i) => i.id === 'scan-throttled'));
});

test('splitInsights e diagSummary: problemas na frente, "tudo certo" dito com todas as letras', () => {
  const list = [
    { id: 'weak-security', severity: 'critical', title: 'a', text: 'b' },
    { id: 'band-upgrade', severity: 'warning', title: 'a', text: 'b' },
    { id: 'no-pmf', severity: 'info', title: 'a', text: 'b' },
    null,
    { severity: 'warning' },
  ];
  const split = splitInsights(list);
  assert.deepEqual(split.problems.map((i) => i.id), ['weak-security', 'band-upgrade']);
  assert.equal(split.good, null);
  assert.deepEqual(split.notes.map((i) => i.id), ['no-pmf']);
  assert.deepEqual(diagSummary(list), { tone: 'critical', icon: 'alert-circle', text: '2 pontos de atenção no diagnóstico' });
  assert.deepEqual(diagSummary([list[1]]), { tone: 'warning', icon: 'warning', text: '1 ponto de atenção no diagnóstico' });

  const fine = [list[2], { id: 'all-good', severity: 'good', title: 'Tudo certo', text: '...' }];
  assert.equal(splitInsights(fine).good.id, 'all-good');
  assert.deepEqual(diagSummary(fine), { tone: 'good', icon: 'check-circle', text: 'Diagnóstico: tudo certo' });

  assert.deepEqual(diagSummary([list[2], { id: 'dfs-channel', severity: 'info', title: 'a', text: 'b' }]), { tone: 'info', icon: 'info', text: 'Diagnóstico: 2 observações' });
  assert.equal(diagSummary([{ id: 'not-connected', severity: 'info', title: 'a', text: 'b' }]), null);
  assert.equal(diagSummary([]), null);
  assert.equal(diagSummary(null), null);
  assert.deepEqual(splitInsights(undefined), { problems: [], good: null, notes: [] });
});

test('channelsRoute: o botão "Ver canais" já abre na faixa de que o aviso fala', () => {
  assert.equal(channelsRoute({ id: 'crowded-channel-24' }, '5'), '/canais?band=2.4');
  assert.equal(channelsRoute({ id: 'nonstandard-channel' }, null), '/canais?band=2.4');
  assert.equal(channelsRoute({ id: 'wide-channel-24' }, '5'), '/canais?band=2.4');
  assert.equal(channelsRoute({ id: 'crowded-channel-5' }, '2.4'), '/canais?band=5');
  assert.equal(channelsRoute({ id: 'dfs-channel' }, '2.4'), '/canais?band=5');
  assert.equal(channelsRoute({ id: 'crowded-channel-6' }, '5'), '/canais?band=6');
  assert.equal(channelsRoute({ id: 'busy-ap' }, '5'), '/canais?band=5', 'sem faixa no aviso: a da conexão');
  assert.equal(channelsRoute({ id: 'slow-link' }, null), '/canais');
  assert.equal(channelsRoute({ id: 'slow-link' }, '60'), '/canais');
  assert.equal(channelsRoute(null, '2.4'), '/canais?band=2.4');
});

test('heroKind e gainText', () => {
  assert.equal(heroKind({ kind: 'ok', current: { key: 'a' } }), 'ok');
  assert.equal(heroKind({ kind: 'ok', current: null }), 'unknown');
  assert.equal(heroKind({ kind: 'switch-band', current: {}, target: {} }), 'switch');
  assert.equal(heroKind({ kind: 'switch-ap', current: {}, target: {} }), 'switch');
  assert.equal(heroKind({ kind: 'switch-network', current: {}, target: {} }), 'switch');
  assert.equal(heroKind({ kind: 'no-connection', target: { key: 'a' } }), 'connect');
  assert.equal(heroKind({ kind: 'no-connection', target: null }), 'offline');
  assert.equal(heroKind(null), 'unknown');

  assert.equal(gainText(2.34), '≈ 2,3x mais rápida');
  assert.equal(gainText(8), '≈ 8x mais rápida');
  assert.equal(gainText(206), '10x ou mais de velocidade');
  assert.equal(gainText(1.1), null, 'ganho pequeno não vira selo');
  assert.equal(gainText(null), null);
});

test('os outros cenários passam inteiros pela análise', () => {
  for (const [name, scan] of Object.entries(fx.ALL)) {
    for (const connection of [{ connected: false }, connectionTo(scan.aps[0]), connectionTo(scan.aps[scan.aps.length - 1])]) {
      const result = analyse(stateFor(scan, { connection }));
      assert.ok(result.ranking.length > 0, name);
      assert.ok(result.advice.headline.length > 0 && result.advice.text.length > 0, name);
      for (const row of result.ranking) {
        const look = scoreLook(row.score, row.detail.usable);
        assert.ok(look.step >= 1 && look.step <= 5 && look.word, `${name}: ${row.name}`);
        const notes = rowNotes(row);
        assert.ok(notes.pros.length + notes.cons.length + (notes.warning ? 1 : 0) <= 3, `${name}: ${row.name}`);
        assert.equal(scoreParts(row).length, 4);
        assert.ok(scoreReasons(row).length > 0);
      }
      const summary = diagSummary(result.insights);
      assert.ok(summary === null || typeof summary.text === 'string');
    }
  }
});
