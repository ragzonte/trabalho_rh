// Qualidade do mapa NO APP, de ponta a ponta: o que o usuário recebe do caminho inteiro (ponte
// simulada -> laço de buscas -> gravador -> piloto ou botões da tela -> motor no Worker ->
// armazenamento -> buildMap), medido contra a casa virtual com a régua da bancada (quality.mjs).
//
// Os limites daqui são FROUXOS de propósito: pegam erro de integração (tempo de caminhada fora de
// escala, pausa contada como caminhada, andar ou nome trocado, rede da casa mal escolhida, mapa do
// tamanho errado), não variação normal do solucionador. Os números típicos, medidos com o código
// final (a tabela completa sai de um roteiro à parte, fora do repositório):
//
//   sessão                      leituras  erro mediano  escala  área/real  IoU   nome certo
//   piloto, kitnet                 80        0,7 m       0,86     1,13     0,75    0,92
//   piloto, apartamento            80        0,7 m       0,94     0,84     0,69    0,82
//   piloto, sobrado               160        1,1 m       0,78     0,67     0,57    0,66
//   piloto, escritório            240        2,5 m       0,65     0,46     0,46    0,73
//   manual (botões), apartamento   78        1,0 m       0,74     0,74     0,66    0,74
//
// (na bancada, levantamentos parecidos: kitnet 0,8 m, apartamento 1,2 m, sobrado 1,7 m,
// escritório 2,2 m — o app não fica atrás.)
//
// Cada teste abre o app numa página nova; fechar a página falha o teste se houve erro,
// console.error, alert(), violação de CSP ou recurso que não carregou.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.mjs';
import { pilotSession, manualSession, hardSession } from './quality-sessions.mjs';
import { SESSION_HEADER, sessionRow } from './quality.mjs';

const LONG = { timeout: 420_000 };

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

const between = (value, lo, hi, what) => assert.ok(Number.isFinite(value) && value >= lo && value <= hi, `${what}: ${value} (esperado de ${lo} a ${hi})`);
const show = (name, m) => console.log(`${SESSION_HEADER}\n${sessionRow(name, m)}`);

/** O que não pode dar errado em NENHUMA sessão: é aqui que mora o erro de integração. */
function assertPlumbing(m, { cadence = [2.5, 4.5] } = {}) {
  between(m.clockRatio, 0.97, 1.03, 'tempo de caminhada do levantamento / tempo simulado');
  between(m.cadenceS, cadence[0], cadence[1], 'intervalo típico entre leituras (s de caminhada)');
  assert.ok(m.floorWrong <= Math.max(2, 0.03 * m.scans), `leituras com o andar errado: ${m.floorWrong} de ${m.scans}`);
  if (m.labelOk !== null) assert.ok(m.labelOk >= 0.95, `lugares marcados com o nome do cômodo certo: ${m.labelOk}`);
  assert.equal(m.ownMissing, 0, 'todos os rádios da casa entram como "da casa"');
  assert.equal(m.ownExtra, 0, 'nenhum vizinho entra como "da casa"');
  assert.equal(m.maxSkip <= 3, true, `o gravador pulou ${m.maxSkip} leituras novas seguidas`);
}

/** O cartão de qualidade diz o mesmo erro que o modelo, e ele não está longe do erro de verdade. */
function assertHonestCard(m) {
  const shown = m.ui.quality.match(/erro típico de ≈\s*([\d,]+)\s*m/);
  assert.ok(shown, `o cartão de qualidade não diz o erro típico: ${m.ui.quality.slice(0, 200)}`);
  const said = Number(shown[1].replace(',', '.'));
  assert.ok(Math.abs(said - m.expErr) <= 0.26, `cartão ${said} m x modelo ${m.expErr} m`);
  assert.ok(m.expErr <= 2.5 * m.medianErr + 0.5 && m.expErr >= 0.4 * m.medianErr, `erro declarado ${m.expErr} m x erro mediano real ${m.medianErr.toFixed(2)} m`);
  assert.match(m.ui.quality, /Tamanho (com folga de uns 25%|incerto \(pode errar 40%\)|ajustado)/);
}

// ---------------------------------------------------------------------------
// A demonstração automática
// ---------------------------------------------------------------------------

test('demonstração automática no apartamento: tempo, andar, nomes e rede da casa certos; mapa do tamanho da casa', LONG, async () => {
  const m = await pilotSession(env, { world: 'apartamento' });
  show('piloto apartamento', m);
  assertPlumbing(m);
  between(m.scans, 70, 140, 'leituras');
  assert.equal(m.labels, 6, 'os seis cômodos foram marcados com nome');
  between(m.medianErr, 0, 2.0, 'erro mediano de posição (m)');
  between(m.scale, 0.55, 1.4, 'tamanho da nuvem de pontos / real');
  between(m.areaRatio, 0.55, 1.45, 'área do mapa / área da casa');
  assert.ok(m.iou >= 0.45, `sobreposição com a planta (IoU): ${m.iou}`);
  assert.equal(m.rooms, 6, 'seis ambientes, os que têm nome');
  assert.ok(m.nameAcc >= 0.55, `área de cada ambiente que é mesmo do cômodo com aquele nome: ${m.nameAcc}`);
  assert.ok(m.roomOfScan >= 0.6, `leituras no cômodo certo: ${m.roomOfScan}`);
  between(m.routerErr, 0, 4, 'erro do roteador da casa (m)');
  between(m.heatRmse, 0, 9, 'erro do campo de sinal (dB)');
  assert.ok(m.track > m.scans, 'o sinal da rede conectada foi gravado entre as leituras');
  assert.equal(m.level !== 'fraca', true, `nível declarado: ${m.level}`);
  assertHonestCard(m);
  assert.match(m.ui.legend, /ambiente estimado/);
  assert.equal(m.ui.show[0], 'Ambientes');
  assert.equal(m.ui.invite, null, 'com todos os cômodos marcados não há convite para marcar');
});

test('demonstração automática na kitnet, no sobrado e no escritório: o mapa cobre a casa e os números declarados são honestos', LONG, async () => {
  // área/real mínima: no sobrado e no escritório o solucionador encolhe o mapa (a escala só com o
  // Wi-Fi é fraca em lugar grande); o piso daqui pega o piloto voltar a andar pouco, não isso.
  for (const [world, floors, rooms, maxErr, minArea, minScans] of [
    ['kitnet', 1, 2, 1.6, 0.6, 70],
    ['sobrado', 2, 13, 2.6, 0.4, 130],
    ['escritorio', 1, 8, 4.0, 0.3, 200],
  ]) {
    const m = await pilotSession(env, { world });
    show(`piloto ${world}`, m);
    assertPlumbing(m);
    assert.ok(m.scans >= minScans, `${world}: ${m.scans} leituras (a caminhada acompanha o tamanho da casa)`);
    assert.ok(m.labels >= rooms - 1, `${world}: ${m.labels} de ${rooms} cômodos com nome`);
    between(m.medianErr, 0, maxErr, `${world}: erro mediano de posição (m)`);
    between(m.scale, 0.45, 1.4, `${world}: tamanho da nuvem / real`);
    between(m.areaRatio, minArea, 1.6, `${world}: área do mapa / área real`);
    assert.ok(m.idealAreaRatio >= 0.7, `${world}: a caminhada do piloto cobre a casa (com as posições reais, área ${m.idealAreaRatio})`);
    assert.ok(m.nameAcc >= 0.5, `${world}: ambientes com nome no lugar certo (${m.nameAcc})`);
    assertHonestCard(m);
    // casa de dois andares nunca é "boa"; lugar grande sai com o tamanho declarado como incerto
    if (floors > 1) assert.notEqual(m.level, 'boa', 'sobrado: no máximo "razoável"');
    if (m.scale < 0.7) assert.match(m.ui.quality, /Tamanho incerto|podem errar 40%/, `${world}: mapa ${Math.round((1 - m.scale) * 100)}% menor que o real precisa dizer que o tamanho é incerto`);
  }
});

// ---------------------------------------------------------------------------
// Uma pessoa usando os botões, no ritmo do app (simulador na velocidade 1, relógio adiantado)
// ---------------------------------------------------------------------------

test('levantamento manual pelos botões da tela, no ritmo de um celular: leituras a cada ~3 s e mapa equivalente ao da bancada', LONG, async () => {
  const m = await manualSession(env, { world: 'apartamento' });
  show('manual apartamento', m);
  assert.notEqual(m.blocked, true, `não deu para concluir: ${m.blocker}`);
  assertPlumbing(m);
  between(m.scans, 55, 140, 'leituras em ~5 minutos de caminhada');
  assert.ok(m.durationS >= 180, `pelo menos 3 minutos simulados (${m.durationS} s)`);
  assert.equal(m.labels, 6);
  between(m.medianErr, 0, 2.2, 'erro mediano de posição (m)');
  between(m.scale, 0.5, 1.4, 'tamanho da nuvem / real');
  between(m.areaRatio, 0.5, 1.5, 'área do mapa / real');
  assert.ok(m.iou >= 0.45, `IoU ${m.iou}`);
  assert.ok(m.nameAcc >= 0.5, `ambientes com nome no lugar certo (${m.nameAcc})`);
  assertHonestCard(m);
});

test('sem lugares com nome o mapa não inventa ambientes: área só, convite para marcar e textos coerentes', LONG, async () => {
  const m = await manualSession(env, { world: 'apartamento', labels: false });
  show('manual sem nomes', m);
  assert.notEqual(m.blocked, true, `não deu para concluir: ${m.blocker}`);
  assertPlumbing(m);
  assert.equal(m.labels, 0);
  assert.equal(m.rooms, 0, 'nenhum ambiente desenhado');
  assert.equal(m.ui.show[0], 'Área', 'a primeira opção de "Mostrar" é a área, não "Ambientes"');
  assert.match(m.ui.legend, /sem divisão em ambientes/);
  assert.match(m.ui.invite, /Quer ver os cômodos no mapa\?/);
  assert.match(m.ui.invite, /não inventa divisões/);
  assert.match(m.ui.quality, /nenhum lugar tem nome/);
  // o resto do mapa continua valendo
  between(m.areaRatio, 0.5, 1.5, 'área do mapa / real');
  between(m.routerErr, 0, 4, 'erro do roteador da casa (m)');
  assertHonestCard(m);
});

test('Android limitando as buscas (uma leitura a cada ~30 s): ponto a ponto, com lugares bastantes dá mapa; com poucos, a tela diz o que falta', LONG, async () => {
  // seis lugares marcados (um por cômodo) e mais uma volta: ainda é pouco, e a tela explica
  const few = await manualSession(env, { world: 'apartamento', throttle: true, tourS: 60 });
  assert.equal(few.blocked, true, 'com seis leituras marcadas não dá para concluir');
  assert.match(few.blocker, /faltam? \d+ lugar(es)? marcados?/);

  // o piloto no mesmo aparelho limitado: uma leitura por lugar, e o mapa sai
  const m = await pilotSession(env, { world: 'apartamento', throttle: true, fakeClock: true });
  show('piloto, buscas limitadas', m);
  assertPlumbing(m, { cadence: [2.5, 40] });
  assert.ok(m.scans >= 20, `${m.scans} leituras`);
  between(m.medianErr, 0, 3, 'erro mediano de posição (m)');
  between(m.areaRatio, 0.4, 1.6, 'área do mapa / real');
  assertHonestCard(m);
});

// ---------------------------------------------------------------------------
// Casos em que não há mapa a tirar: o app diz por quê e o que fazer
// ---------------------------------------------------------------------------

test('um roteador só ao alcance (o emulador do Android: um ponto de acesso a -50 dBm constantes): sem mapa, com o motivo', LONG, async () => {
  for (const place of ['emulador', 'um-roteador']) {
    const r = await hardSession(env, { place, walkS: 60 });
    assert.equal(r.concluded, false, `${place}: não deixa concluir`);
    assert.ok(r.during.counts[0] >= 8, `${place}: ${r.during.counts[0]} leituras`);
    assert.equal(r.during.counts[2], 1, `${place}: um roteador ouvido`);
    assert.match(r.during.blocker, /Só um roteador ao alcance.*pelo menos três/, place);
    assert.match(r.during.level, /pouco para um mapa/);
  }
});

test('dois roteadores: deixa concluir, mas o levantamento e o resultado dizem que o mapa é fraco', LONG, async () => {
  const r = await hardSession(env, { place: 'dois-roteadores', walkS: 150 });
  assert.equal(r.concluded, true);
  assert.match(r.during.hint, /Só dois roteadores ao alcance/);
  assert.doesNotMatch(r.during.level, /bom mapa|ótimo mapa/, 'com dois roteadores o nível não passa do mínimo');
  assert.equal(r.ui.noMap, null);
  assert.match(r.ui.quality, /Fraca/);
  assert.match(r.ui.quality, /Só dois roteadores ao alcance/);
  assert.equal(r.metrics.level, 'fraca');
});

test('quem não sai do lugar, ou faz dez leituras, não conclui: a tela diz o que falta', LONG, async () => {
  const still = await hardSession(env, { still: true, walkS: 90 });
  assert.equal(still.concluded, false);
  assert.match(still.during.blocker, /ande por mais cômodos: até aqui o sinal quase não mudou/);

  const ten = await hardSession(env, { walkS: 33 });
  assert.equal(ten.concluded, false);
  between(ten.during.counts[0], 6, 14, 'leituras em meio minuto');
  assert.match(ten.during.blocker, /faltam \d+ leituras andando pela casa/);
});
