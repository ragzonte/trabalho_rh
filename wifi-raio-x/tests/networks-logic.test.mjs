// Lógica da tela Redes (app/js/ui/networks-logic.js): modos, filtros, busca, ordem, resumo,
// cartão da conexão e os textos do painel de detalhes. Tudo sobre o estado de verdade do store,
// alimentado com as varreduras de tests/fixtures/scans.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../app/js/store.js';
import { MINUS, THIN } from '../app/js/ui/dom.js';
import { apartment, apartmentTruth, mesh, office, TS, withAps, makeAp, nextScan } from './fixtures/scans.mjs';
import {
  VIEW_MODES,
  SORTS,
  FILTERS,
  DEFAULT_CONTROLS,
  MAX_QUERY,
  LIVE_RSSI_MS,
  sanitizeControls,
  toggleFilter,
  hasFilters,
  buildRows,
  selectRows,
  sortRows,
  matchesQuery,
  summarize,
  connectionView,
  foldText,
  cleanName,
  bandsText,
  channelsText,
  countText,
  seriesLabels,
  securityWord,
  rangeText,
  coveredChannelsText,
  antennasText,
  apFacts,
  apFeatures,
  apDetailsText,
} from '../app/js/ui/networks-logic.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const OWN = apartmentTruth.own;

/** Estado do store depois de uma varredura (e, se pedido, com conexão e fabricantes). */
function stateOf(scan = apartment, { connect = false, vendors = false, favorites = [] } = {}) {
  const store = createStore({ now: () => TS });
  if (vendors) {
    store.setVendorLookup({
      loaded: true,
      vendor: (mac) => (mac.startsWith('98:da:c4') ? { name: 'TP-Link', guess: false } : mac.startsWith('e0:ca:94') ? { name: 'Askey', guess: true } : null),
    });
  }
  store.ingestScan(scan);
  if (connect) store.setConnection({ connected: true, ssid: OWN.ssid, bssid: OWN.b24, rssi: -50, frequency: 2437, linkSpeed: 144, txSpeed: 144, rxSpeed: 173, wifiStandard: 6 });
  for (const ssid of favorites) store.setFavorite(ssid, true);
  return { store, state: store.get() };
}

const controls = (patch = {}) => ({ ...DEFAULT_CONTROLS, filters: [], ...patch });

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

test('sanitizeControls: lixo vira o padrão, filtros repetidos ou desconhecidos somem', () => {
  assert.deepEqual(sanitizeControls(null), { mode: 'networks', sort: 'signal', filters: [], query: '' });
  assert.deepEqual(sanitizeControls({ mode: 'x', sort: 7, filters: 'abc', query: 12 }), { mode: 'networks', sort: 'signal', filters: [], query: '' });
  const c = sanitizeControls({ mode: 'signals', sort: 'channel', filters: ['5', '5', 'nope', 'mine', null], query: 'a'.repeat(200) });
  assert.equal(c.mode, 'signals');
  assert.equal(c.sort, 'channel');
  assert.deepEqual(c.filters, ['5', 'mine']);
  assert.equal(c.query.length, MAX_QUERY);
  for (const mode of VIEW_MODES) assert.equal(sanitizeControls({ mode }).mode, mode);
  for (const sort of SORTS) assert.equal(sanitizeControls({ sort }).sort, sort);
});

test('toggleFilter liga e desliga sem alterar o objeto recebido', () => {
  const before = controls();
  const on = toggleFilter(before, '2.4');
  assert.deepEqual(on.filters, ['2.4']);
  assert.deepEqual(before.filters, [], 'o original não muda');
  const two = toggleFilter(on, 'open');
  assert.deepEqual(two.filters, ['2.4', 'open']);
  assert.deepEqual(toggleFilter(two, '2.4').filters, ['open']);
  assert.deepEqual(toggleFilter(two, 'inexistente').filters, ['2.4', 'open']);
  for (const id of FILTERS) assert.deepEqual(toggleFilter(controls(), id).filters, [id]);
});

test('hasFilters: filtro ou busca (espaços não contam)', () => {
  assert.equal(hasFilters(controls()), false);
  assert.equal(hasFilters(controls({ query: '   ' })), false);
  assert.equal(hasFilters(controls({ query: 'a' })), true);
  assert.equal(hasFilters(controls({ filters: ['open'] })), true);
});

// ---------------------------------------------------------------------------
// Linhas por modo
// ---------------------------------------------------------------------------

test('buildRows: uma linha por rede, por aparelho ou por BSSID, com chaves únicas', () => {
  const { state } = stateOf();
  const nets = buildRows(state, 'networks');
  const devices = buildRows(state, 'devices');
  const signals = buildRows(state, 'signals');
  assert.equal(nets.length, state.networks.length);
  assert.equal(devices.length, state.devices.length);
  assert.equal(signals.length, state.aps.length);
  assert.equal(signals.length, 28);
  for (const rows of [nets, devices, signals]) {
    assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'chaves únicas');
    for (const row of rows) {
      assert.ok(row.aps.length >= 1);
      assert.equal(row.count, row.aps.length);
      assert.equal(row.best, row.aps[0], 'o mais forte primeiro');
      assert.ok(row.aps.every((ap, i) => i === 0 || row.aps[i - 1].rssi >= ap.rssi));
    }
  }
  assert.ok(nets.every((r) => r.kind === 'network' && r.key.startsWith('n:') && typeof r.networkKey === 'string'));
  assert.ok(devices.every((r) => r.kind === 'device' && r.key.startsWith('d:')));
  assert.ok(signals.every((r) => r.kind === 'ap' && r.count === 1));
  // modo desconhecido cai em "redes"
  assert.equal(buildRows(state, 'qualquer').length, nets.length);
  // estado torto não derruba
  assert.deepEqual(buildRows(null, 'networks'), []);
  assert.deepEqual(buildRows({ networks: 'x', aps: null }, 'signals'), []);
});

test('buildRows: rede de duas faixas junta os dois rádios; rede oculta fica sem nome', () => {
  const { state } = stateOf();
  const rows = buildRows(state, 'networks');
  const ze = rows.find((r) => r.name === 'Casa do Zé');
  assert.equal(ze.count, 2);
  assert.deepEqual(ze.bands, ['2.4', '5']);
  assert.deepEqual(ze.channels, [1, 149]);
  assert.equal(ze.rssi, -69, 'vale o rádio mais forte');
  assert.equal(ze.deviceCount, 1);
  const hidden = rows.filter((r) => r.hidden);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].name, '');
  assert.deepEqual(hidden[0].names, []);
  // a rede aberta da operadora vem de dois aparelhos
  const claro = rows.find((r) => r.name === '#NET-CLARO-WIFI');
  assert.equal(claro.count, 2);
  assert.equal(claro.deviceCount, 2);
  assert.equal(claro.open, true);
});

test('buildRows por aparelho: o roteador da casa mostra os dois nomes que anuncia', () => {
  const { state } = stateOf();
  const own = buildRows(state, 'devices').find((r) => r.aps.some((ap) => ap.bssid === OWN.b24));
  assert.equal(own.count, 2);
  assert.deepEqual([...own.names].sort(), ['Familia Souza', 'Familia Souza_5G']);
  assert.equal(own.name, 'Familia Souza', 'o título é o nome do rádio mais forte');
  assert.deepEqual(own.bands, ['2.4', '5']);
});

test('filtro de faixa vale por BSSID: a rede de duas faixas aparece com o sinal do rádio pedido', () => {
  const { state } = stateOf();
  const five = buildRows(state, 'networks', ['5']);
  assert.ok(five.length > 0);
  assert.ok(five.every((r) => r.aps.every((ap) => ap.band === '5')));
  const ze = five.find((r) => r.name === 'Casa do Zé');
  assert.equal(ze.count, 1);
  assert.equal(ze.rssi, -78, 'o sinal do rádio de 5 GHz, não o de 2,4');
  assert.deepEqual(ze.bands, ['5']);
  assert.equal(five.some((r) => r.name === 'Familia Souza'), false, 'rede só de 2,4 GHz fica de fora');
  // duas faixas ligadas = uma OU a outra
  assert.equal(buildRows(state, 'signals', ['2.4', '5']).length, 28);
  assert.equal(buildRows(state, 'signals', ['6']).length, 0);
  assert.equal(buildRows(state, 'signals', ['2.4']).length + buildRows(state, 'signals', ['5']).length, 28);
  // faixa desconhecida é ignorada (não esvazia a lista)
  assert.equal(buildRows(state, 'signals', ['60', 'x']).length, 28);
});

// ---------------------------------------------------------------------------
// Seleção: filtros, busca e ordem
// ---------------------------------------------------------------------------

test('selectRows por sinal: os números mostrados nunca sobem ao descer a lista', () => {
  const { state } = stateOf();
  for (const mode of VIEW_MODES) {
    const { rows, total, filtered } = selectRows(state, controls({ mode }));
    assert.equal(filtered, false);
    assert.equal(rows.length, total);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].rssi >= rows[i].rssi, `${mode}: linha ${i}`);
  }
  assert.equal(selectRows(state, controls()).rows[0].name, 'Familia Souza');
});

test('selectRows por nome: ordem alfabética sem ligar para maiúsculas e acentos; ocultas no fim', () => {
  const { state } = stateOf();
  const { rows } = selectRows(state, controls({ sort: 'name' }));
  const names = rows.map((r) => r.name);
  assert.equal(rows[rows.length - 1].hidden, true);
  const visible = names.slice(0, -1);
  const expected = [...visible].sort(new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' }).compare);
  assert.deepEqual(visible, expected);
  assert.ok(visible.indexOf('AP 302') < visible.indexOf('AP 304'));
  assert.ok(visible.indexOf('Mengão 2019') < visible.indexOf('NET_2GD4E5F6'));
});

test('selectRows por canal: 2,4 GHz antes de 5 GHz e, dentro da faixa, canal crescente', () => {
  const { state } = stateOf();
  const { rows } = selectRows(state, controls({ mode: 'signals', sort: 'channel' }));
  const rank = { 2.4: 0, 5: 1, 6: 2 };
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    assert.ok(rank[a.best.band] <= rank[b.best.band]);
    if (a.best.band === b.best.band) assert.ok(a.channel <= b.channel, `${a.channel} antes de ${b.channel}`);
    if (a.best.band === b.best.band && a.channel === b.channel) assert.ok(a.rssi >= b.rssi, 'no mesmo canal, o mais forte primeiro');
  }
  assert.equal(rows[0].channel, 1);
  assert.equal(rows[rows.length - 1].best.band, '5');
});

test('sortRows não altera a lista recebida e aguenta lixo', () => {
  const { state } = stateOf();
  const rows = buildRows(state, 'signals');
  const copy = [...rows];
  const sorted = sortRows(rows, 'name');
  assert.deepEqual(rows, copy);
  assert.notEqual(sorted, rows);
  assert.deepEqual(sortRows(null, 'signal'), []);
  assert.equal(sortRows(rows, 'ordem-que-não-existe').length, rows.length);
});

test('filtro "Abertas": só as redes sem senha; "Minhas": a conectada, o aparelho dela e as favoritas', () => {
  const plain = stateOf().state;
  const open = selectRows(plain, controls({ filters: ['open'] }));
  assert.equal(open.filtered, true);
  assert.equal(open.total, plain.networks.length);
  assert.deepEqual(open.rows.map((r) => r.name).sort(), ['#NET-CLARO-WIFI', 'INTELBRAS']);
  assert.ok(open.rows.every((r) => r.security.open === true));
  assert.equal(selectRows(plain, controls({ filters: ['mine'] })).rows.length, 0, 'sem conexão e sem favoritas não há "minhas"');

  const mine = stateOf(apartment, { connect: true }).state;
  const own = selectRows(mine, controls({ filters: ['mine'] })).rows;
  assert.deepEqual(own.map((r) => r.name).sort(), ['Familia Souza', 'Familia Souza_5G'], 'a rede em uso e o outro rádio do mesmo roteador');
  assert.equal(own.find((r) => r.name === 'Familia Souza').connected, true);

  const fav = stateOf(apartment, { connect: true, favorites: ['Casa do Zé'] }).state;
  const withFav = selectRows(fav, controls({ filters: ['mine'] })).rows;
  assert.equal(withFav.length, 3);
  assert.equal(withFav.find((r) => r.name === 'Casa do Zé').favorite, true);
  // filtros diferentes se somam (E): minhas E em 5 GHz
  assert.deepEqual(selectRows(fav, controls({ filters: ['mine', '5'] })).rows.map((r) => r.name).sort(), ['Casa do Zé', 'Familia Souza_5G']);
  // minhas E abertas: nada
  assert.equal(selectRows(fav, controls({ filters: ['mine', 'open'] })).rows.length, 0);
});

test('com filtro de faixa, o total continua sendo o do modo inteiro', () => {
  const { state } = stateOf();
  const res = selectRows(state, controls({ mode: 'signals', filters: ['5'] }));
  assert.equal(res.total, 28);
  assert.ok(res.rows.length < 28 && res.rows.length > 0);
  assert.equal(res.filtered, true);
});

test('busca por nome: sem maiúsculas, sem acentos, pedaço do nome, vários termos', () => {
  const { state } = stateOf();
  const find = (query, mode = 'networks') => selectRows(state, controls({ query, mode })).rows.map((r) => r.name);
  assert.deepEqual(find('vovo'), ['Wi-Fi da Vovó']);
  assert.deepEqual(find('MENGAO'), ['Mengão 2019']);
  assert.deepEqual(find('  familia  ').sort(), ['Familia Souza', 'Familia Souza_5G']);
  assert.deepEqual(find('souza 5g'), ['Familia Souza_5G'], 'todos os termos têm de aparecer');
  assert.deepEqual(find('zzz-nada'), []);
  assert.equal(find('').length, state.networks.length, 'busca vazia não filtra');
  assert.deepEqual(find('oculta'), [''], 'rede oculta é achada pela palavra');
  // caracteres de expressão regular na busca não quebram nada
  for (const q of ['(', '[a-', '\\', '.*', '<img', '$^']) assert.doesNotThrow(() => find(q));
  assert.equal(find('.*').length, 0);
});

test('busca por BSSID: com ou sem dois-pontos, com hífens, só um pedaço', () => {
  const { state } = stateOf();
  const find = (query) => selectRows(state, controls({ query, mode: 'signals' })).rows.map((r) => r.best.bssid);
  assert.deepEqual(find(OWN.b24), [OWN.b24]);
  assert.deepEqual(find(OWN.b24.toUpperCase()), [OWN.b24]);
  assert.deepEqual(find(OWN.b24.replace(/:/g, '')), [OWN.b24]);
  assert.deepEqual(find(OWN.b24.replace(/:/g, '-')), [OWN.b24]);
  assert.deepEqual(find('98:da:c4').sort(), [OWN.b24, OWN.b5].sort(), 'o começo do endereço acha os dois rádios');
  assert.deepEqual(find('98dac43b').sort(), [OWN.b24, OWN.b5].sort());
  // na visão por rede, o BSSID de qualquer rádio acha a rede
  const net = selectRows(state, controls({ query: OWN.b5 })).rows;
  assert.deepEqual(net.map((r) => r.name), ['Familia Souza_5G']);
});

test('busca por fabricante', () => {
  const { state } = stateOf(apartment, { vendors: true });
  const tp = selectRows(state, controls({ query: 'tp-link', mode: 'devices' })).rows;
  assert.ok(tp.some((r) => r.vendor === 'TP-Link' && r.aps.some((ap) => ap.bssid === OWN.b24)));
  // "TP-Link_A9C4" casa pelo nome; o roteador da casa, só pelo fabricante
  assert.ok(tp.length >= 2);
  const askey = selectRows(state, controls({ query: 'ASKEY', mode: 'signals' })).rows;
  assert.ok(askey.length > 0 && askey.every((r) => r.vendor === 'Askey' && r.vendorGuess === true));
});

test('matchesQuery guarda o texto preparado na linha e continua certo em chamadas seguidas', () => {
  const { state } = stateOf();
  const row = buildRows(state, 'networks').find((r) => r.name === 'Casa do Zé');
  assert.equal(matchesQuery(row, 'ze'), true);
  assert.equal(matchesQuery(row, 'zé'), true);
  assert.equal(matchesQuery(row, 'casa  do'), true);
  assert.equal(matchesQuery(row, 'vizinho'), false);
  assert.equal(matchesQuery(row, null), true);
});

// ---------------------------------------------------------------------------
// Resumo
// ---------------------------------------------------------------------------

test('summarize: redes, roteadores, sinais e redes por faixa', () => {
  const { state } = stateOf();
  const sum = summarize(state);
  assert.equal(sum.networks, state.networks.length);
  assert.equal(sum.devices, state.devices.length);
  assert.equal(sum.signals, 28);
  assert.equal(sum.bands['2.4'], state.networks.filter((n) => n.bands.includes('2.4')).length);
  assert.equal(sum.bands['5'], state.networks.filter((n) => n.bands.includes('5')).length);
  assert.equal(sum.bands['6'], 0);
  assert.ok(sum.bands['2.4'] + sum.bands['5'] >= sum.networks, 'rede de duas faixas conta nas duas');
  assert.deepEqual(summarize(null), { networks: 0, devices: 0, signals: 0, bands: { 2.4: 0, 5: 0, 6: 0 } });
});

// ---------------------------------------------------------------------------
// Conexão
// ---------------------------------------------------------------------------

test('connectionView: sem conexão', () => {
  assert.deepEqual(connectionView({ connection: null, aps: [] }), { connected: false });
  assert.deepEqual(connectionView({ connection: { connected: false }, aps: [] }), { connected: false });
  assert.deepEqual(connectionView(null), { connected: false });
});

test('connectionView: junta a conexão, o Ap da lista e a leitura ao vivo', () => {
  const { store } = stateOf(apartment, { connect: true });
  store.setRssi({ ts: TS, rssi: -47, bssid: OWN.b24, frequency: 2437, linkSpeed: 173, txSpeed: 173, rxSpeed: 207 });
  const view = connectionView(store.get(), TS + 800);
  assert.equal(view.connected, true);
  assert.equal(view.name, OWN.ssid);
  assert.equal(view.hidden, false);
  assert.equal(view.bssid, OWN.b24);
  assert.equal(view.ap.bssid, OWN.b24);
  assert.equal(view.live, true);
  assert.equal(view.rssi, -47, 'vale a leitura ao vivo');
  assert.equal(view.band, '2.4');
  assert.equal(view.channel, 6);
  assert.equal(view.widthMHz, view.ap.widthMHz);
  assert.equal(view.standard, 'Wi-Fi 6');
  assert.equal(view.downMbps, 207);
  assert.equal(view.upMbps, 173);
  assert.equal(view.linkMbps, 173);
  assert.ok(view.distanceM > 0.3 && view.distanceM < 10);
  assert.equal(view.favorite, false);

  // leitura velha: volta para o que a conexão informou
  const stale = connectionView(store.get(), TS + LIVE_RSSI_MS + 1);
  assert.equal(stale.live, false);
  assert.equal(stale.rssi, -50);
  assert.equal(stale.downMbps, 173);
  assert.equal(stale.upMbps, 144);

  // leitura de outro BSSID (o celular acabou de trocar de ponto de acesso) não vale
  store.setRssi({ ts: TS + 1000, rssi: -80, bssid: OWN.b5, frequency: 5180 });
  assert.equal(connectionView(store.get(), TS + 1200).rssi, -50);

  store.setFavorite(OWN.ssid, true);
  assert.equal(connectionView(store.get(), TS).favorite, true);
});

test('connectionView: nome ausente, "<unknown ssid>" e conexão fora da lista', () => {
  const { state } = stateOf();
  const base = { connected: true, bssid: OWN.b5, rssi: -61, frequency: 5180 };
  const fromAp = connectionView({ ...state, connection: base }, TS);
  assert.equal(fromAp.name, 'Familia Souza_5G', 'o nome vem do Ap quando a conexão não diz');
  assert.equal(fromAp.band, '5');
  assert.equal(fromAp.channel, 36);
  assert.equal(connectionView({ ...state, connection: { ...base, ssid: '<unknown ssid>' } }, TS).name, 'Familia Souza_5G');

  const unknown = connectionView({ ...state, connection: { connected: true, ssid: '', bssid: '02:00:00:00:00:00', rssi: -70, frequency: 2412 } }, TS);
  assert.equal(unknown.ap, null);
  assert.equal(unknown.name, '');
  assert.equal(unknown.hidden, true);
  assert.equal(unknown.channel, 1);
  assert.equal(unknown.widthMHz, null);
  assert.equal(unknown.standard, null);
  assert.equal(unknown.downMbps, null);

  // sem sinal nenhum informado não inventa distância
  const blind = connectionView({ ...state, aps: [], connection: { connected: true, ssid: 'X' } }, TS);
  assert.equal(blind.rssi, null);
  assert.equal(blind.distanceM, null);
  assert.equal(blind.channel, null);
});

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

test('foldText e cleanName', () => {
  assert.equal(foldText('  AÇÃO Vovó '), 'acao vovo');
  assert.equal(foldText(null), '');
  assert.equal(cleanName(`a${String.fromCharCode(0)}b${String.fromCharCode(0x2028)}c\n`), 'a·b·c·');
  assert.equal(cleanName(HOSTILE), HOSTILE, 'marcação fica como está: é só texto');
  assert.equal(cleanName(undefined), '');
});

test('bandsText, channelsText e countText', () => {
  assert.equal(bandsText(['2.4']), `2,4${THIN}GHz`);
  assert.equal(bandsText(['2.4', '5']), `2,4 e 5${THIN}GHz`);
  assert.equal(bandsText(['2.4', '5', '6']), `2,4, 5 e 6${THIN}GHz`);
  assert.equal(bandsText([]), '');
  assert.equal(bandsText(null), '');
  assert.equal(channelsText([6]), 'canal 6');
  assert.equal(channelsText([6, 44]), 'canais 6 e 44');
  assert.equal(channelsText([1, 6, 11]), 'canais 1, 6 e 11');
  assert.equal(channelsText([1, 6, 11, 36, 149]), 'canais 1, 6, 11 +2');
  assert.equal(channelsText([]), '');
  assert.equal(countText({ kind: 'ap', count: 1 }), '');
  assert.equal(countText({ kind: 'network', count: 2, deviceCount: 1 }), '2 sinais');
  assert.equal(countText({ kind: 'network', count: 3, deviceCount: 2 }), '3 sinais em 2 roteadores');
  assert.equal(countText({ kind: 'device', count: 4, deviceCount: 1 }), '4 sinais');
  assert.equal(countText(null), '');
});

test('seriesLabels: só acrescenta faixa, canal ou endereço quando o nome sozinho é ambíguo', () => {
  const { state } = stateOf();
  const labels = seriesLabels(state.aps);
  assert.equal(labels.size, 28);
  assert.equal(labels.get(OWN.b24), 'Familia Souza');
  const ze = state.networks.find((n) => n.name === 'Casa do Zé');
  assert.deepEqual(ze.aps.map((ap) => labels.get(ap.bssid)).sort(), [`Casa do Zé · 2,4${THIN}GHz`, `Casa do Zé · 5${THIN}GHz`]);
  // mesmo nome e mesma faixa em canais diferentes: entra o canal
  const claro = state.networks.find((n) => n.name === '#NET-CLARO-WIFI');
  assert.deepEqual(claro.aps.map((ap) => labels.get(ap.bssid)).sort(), [`#NET-CLARO-WIFI · 2,4${THIN}GHz · canal 11`, `#NET-CLARO-WIFI · 2,4${THIN}GHz · canal 6`]);
  assert.equal(new Set(labels.values()).size, labels.size, 'nenhum rótulo repetido');
  // dois nós no mesmo canal: só o fim do endereço desempata
  const twins = stateOf(withAps(apartment, [makeAp('aa:bb:cc:00:00:01', 'Gêmeos', -60, 2437), makeAp('aa:bb:cc:00:99:02', 'Gêmeos', -70, 2437)])).state;
  const twinLabels = seriesLabels(twins.aps.filter((ap) => ap.ssid === 'Gêmeos'));
  assert.deepEqual([...twinLabels.values()].sort(), [`Gêmeos · 2,4${THIN}GHz · canal 6 · 00:01`, `Gêmeos · 2,4${THIN}GHz · canal 6 · 99:02`]);
  assert.equal(seriesLabels(null).size, 0);
});

test('securityWord, rangeText, coveredChannelsText e antennasText', () => {
  const { state } = stateOf();
  const own = state.aps.find((ap) => ap.bssid === OWN.b24);
  const five = state.aps.find((ap) => ap.bssid === OWN.b5);
  const open = state.aps.find((ap) => ap.ssid === '#NET-CLARO-WIFI');
  assert.match(securityWord(own.security), /^Proteção (boa|forte)$/);
  assert.equal(securityWord(open.security), 'Sem proteção');
  assert.equal(securityWord(null), 'O celular não informou');
  assert.equal(securityWord({ known: false }), 'O celular não informou');
  assert.equal(securityWord({ known: true, open: true, encrypted: true, level: 3 }), 'Sem senha, mas criptografada');
  assert.equal(rangeText(own.occ), `2427–2447${THIN}MHz`);
  assert.equal(rangeText({ segments: [{ lo: 5170, hi: 5250 }, { lo: 5490, hi: 5570 }] }), `5170–5250 + 5490–5570${THIN}MHz`);
  assert.equal(rangeText(null), '');
  assert.equal(coveredChannelsText(own.occ), '');
  assert.match(coveredChannelsText(five.occ), /^canais \d+ a \d+$/);
  assert.equal(antennasText(2), '2×2');
  assert.equal(antennasText(null), '');
  assert.equal(antennasText(0), '');
});

// ---------------------------------------------------------------------------
// Detalhes de um BSSID
// ---------------------------------------------------------------------------

test('apFacts: só fatos com valor, na ordem, com os formatadores do app', () => {
  const { state } = stateOf(apartment, { vendors: true });
  const ap = state.aps.find((a) => a.bssid === OWN.b24);
  const facts = apFacts(ap, { estMbps: 87.4, maxMbps: 286.8, now: TS + 65_000 });
  const byId = Object.fromEntries(facts.map((f) => [f.id, f]));
  assert.equal(facts[0].id, 'name');
  assert.equal(byId.name.value, OWN.ssid);
  assert.equal(byId.bssid.value, OWN.b24);
  assert.equal(byId.vendor.value, 'TP-Link');
  assert.equal(byId.signal.value, `${MINUS}48${THIN}dBm (excelente)`);
  assert.equal(byId.band.value, `2,4${THIN}GHz`);
  assert.equal(byId.channel.value, '6');
  assert.equal(byId.freq.value, `2437${THIN}MHz`);
  assert.equal(byId.width.value, `${ap.widthMHz}${THIN}MHz`);
  assert.equal(byId.range.value, rangeText(ap.occ));
  assert.equal(byId.speed.value, `≈${THIN}87${THIN}Mb/s`);
  assert.equal(byId.max.value, `287${THIN}Mb/s`);
  assert.match(byId.distance.value, /^≈/);
  assert.match(byId['last-seen'].value, /\(há 1.min\)$/);
  for (const fact of facts) {
    assert.equal(typeof fact.label, 'string');
    assert.ok(fact.value.length > 0, fact.id);
    assert.doesNotMatch(fact.value, /undefined|null|NaN|—/, fact.id);
  }
  // sem estimativa de velocidade, o fato não existe (nada de "≈ —")
  assert.equal(apFacts(ap).some((f) => f.id === 'speed' || f.id === 'max'), false);
  assert.equal(apFacts(ap, { estMbps: 0 }).some((f) => f.id === 'speed'), false);
  // fabricante provável é dito como provável
  const guess = state.aps.find((a) => a.vendorGuess);
  assert.equal(apFacts(guess).find((f) => f.id === 'vendor').value, 'Askey (provável)');
  assert.deepEqual(apFacts(null), []);
});

test('apFacts de rede oculta e de nome hostil: o nome entra como veio', () => {
  const { state } = stateOf(withAps(apartment, [makeAp('aa:bb:cc:11:22:33', HOSTILE, -60, 2462)]));
  const hostile = state.aps.find((a) => a.ssid === HOSTILE);
  assert.equal(apFacts(hostile)[0].value, HOSTILE);
  assert.ok(apDetailsText(hostile).startsWith(`Rede: ${HOSTILE}\n`));
  const hidden = state.aps.find((a) => a.hidden);
  assert.equal(apFacts(hidden)[0].value, '(rede oculta)');
});

test('apFeatures: lista em palavras simples quando o celular entrega os elementos do beacon', () => {
  const { state } = stateOf(mesh);
  const withIes = state.aps.find((ap) => ap.ie);
  if (withIes) {
    const features = apFeatures(withIes);
    assert.ok(features.length >= 7);
    assert.deepEqual(features.slice(0, 6).map((f) => f.id), ['roam-kv', 'roam-r', 'mu-mimo', 'beamforming', 'twt', 'bss-color']);
    assert.equal(features[features.length - 1].id, 'wps');
    for (const f of features) {
      assert.equal(typeof f.on, 'boolean');
      assert.ok(f.label && f.hint);
    }
  }
  // sem os elementos: nada é presumido
  assert.deepEqual(apFeatures({ ie: null }), []);
  assert.deepEqual(apFeatures(null), []);
  // WPS ligado é ponto de atenção, não uma qualidade
  const base = { ie: { roaming: {}, wps: { enabled: true, locked: false } } };
  assert.equal(apFeatures(base).find((f) => f.id === 'wps').tone, 'warning');
  assert.equal(apFeatures({ ie: { roaming: {}, wps: { enabled: true, locked: true } } }).find((f) => f.id === 'wps').tone, 'neutral');
  const off = apFeatures({ ie: { roaming: { k: true, r: true }, wps: null, bssColor: 12, muMimo: true }, rttResponder: true });
  assert.equal(off.find((f) => f.id === 'wps').on, false);
  assert.equal(off.find((f) => f.id === 'wps').value, 'desligado');
  assert.equal(off.find((f) => f.id === 'roam-kv').on, true);
  assert.equal(off.find((f) => f.id === 'roam-r').on, true);
  assert.equal(off.find((f) => f.id === 'bss-color').value, 'cor 12');
  assert.equal(off.find((f) => f.id === 'rtt').on, true);
  assert.equal(off.find((f) => f.id === 'twt').on, false);
});

test('apDetailsText: texto completo para copiar, sem campos vazios', () => {
  for (const scan of [apartment, mesh, office]) {
    const { state } = stateOf(scan);
    for (const ap of state.aps) {
      const text = apDetailsText(ap, { estMbps: 42, maxMbps: 144 });
      assert.ok(text.startsWith('Rede: '));
      assert.ok(text.endsWith('Gerado pelo WiFi Raio-X'));
      assert.match(text, new RegExp(`BSSID: ${ap.bssid}`));
      assert.doesNotMatch(text, /undefined|null|NaN|\[object/, ap.bssid);
      assert.doesNotMatch(text, /: \n/, 'nenhum rótulo sem valor');
    }
  }
  const { state } = stateOf();
  const open = state.aps.find((ap) => ap.ssid === '#NET-CLARO-WIFI');
  const text = apDetailsText(open);
  assert.match(text, /Segurança: Aberta/);
  assert.match(text, /Pontos de atenção na segurança:\n- /);
});

// ---------------------------------------------------------------------------
// Dados ao vivo: uma varredura nova muda os números, não a identidade das linhas
// ---------------------------------------------------------------------------

test('as chaves das linhas são estáveis de uma varredura para a outra', () => {
  const store = createStore({ now: () => TS });
  store.ingestScan(apartment);
  const before = selectRows(store.get(), controls()).rows.map((r) => r.key).sort();
  // todos ouvidos de novo, 3 dB mais fracos
  const all = (skip) => Object.fromEntries(apartment.aps.filter((a) => a.bssid !== skip).map((a) => [a.bssid, a.level - 3]));
  const second = nextScan(apartment, { dtMs: 10_000, heard: all() });
  store.ingestScan(second);
  const after = selectRows(store.get(), controls()).rows.map((r) => r.key).sort();
  assert.deepEqual(after, before);
  assert.equal(selectRows(store.get(), controls()).rows[0].rssi, -51, 'os números mudam, as linhas são as mesmas');
  // quem não foi ouvido na última busca continua na lista, marcado como velho
  store.ingestScan(nextScan(second, { dtMs: 12_000, heard: all(OWN.b5) }));
  const rows = selectRows(store.get(), controls({ mode: 'signals' })).rows;
  const gone = rows.find((r) => r.best.bssid === OWN.b5);
  assert.ok(gone, 'continua na lista');
  assert.equal(gone.stale, true);
  assert.ok(gone.ageMs >= 10_000);
  assert.equal(rows.filter((r) => r.stale).length, 1);
});
