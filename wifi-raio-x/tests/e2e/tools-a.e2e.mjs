// Ferramentas (grupo A), de ponta a ponta contra o simulador: o mostrador semicircular
// (ui/charts/gauge.js), o medidor de sinal e caça-roteador, os detalhes da conexão e o exportar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, withApp, shot, goto, back, settle, simEval, appState, waitForScans, horizontalOverflow } from './helpers.mjs';

const T = { timeout: 120_000 };
const FAST = { speed: 10 }; // o tempo do simulador corre 10x
const HOSTILE = '<img src=x onerror=alert(1)>';
const HOSTILE_BSSID = 'b0:95:75:13:37:00'; // o vizinho de nome hostil existe em todas as casas virtuais
const MINUS = String.fromCharCode(0x2212);
const THIN = String.fromCharCode(0x202f);
const BOM = String.fromCharCode(0xfeff);
const SCREEN = '.view > .screen';

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

const hash = (page) => page.evaluate(() => location.hash);
const data = (page) => page.evaluate(() => ({ ...document.querySelector('.view > .screen').dataset }));
const screenText = (page) => page.evaluate(() => document.querySelector('.view > .screen').innerText);
const connectedBssid = (page) => appState(page, (s) => s.connection.bssid);
/** Toques de vibração: os que o simulador recebeu e os que a tela diz ter enviado, lidos no mesmo instante. */
const vibration = async (page) => {
  await simEval(page, () => 0); // garante o gancho do simulador
  return page.evaluate(() => ({ sim: window.__e2eSim().device.vibrations, ticks: Number(document.querySelector('.view > .screen').dataset.ticks || 0) }));
};
const waitToast = async (page, pattern) => {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.toast')?.textContent || ''), pattern.source, { timeout: 8000 });
};
/** Quantas leituras do sinal chegam em `ms` (tempo real). */
const rssiRate = (page, ms = 600) =>
  page.evaluate(
    (wait) =>
      new Promise((resolve) => {
        let n = 0;
        const off = window.__wrx.app.bridge.on('rssi', () => {
          n += 1;
        });
        setTimeout(() => {
          off();
          resolve(n);
        }, wait);
      }),
    ms,
  );
/** Leituras de sinal de mentira, como se viessem do celular: uma a cada 100 ms. */
const emitRssi = (page, from, to, steps) =>
  page.evaluate(
    async ({ from: a, to: b, steps: n }) => {
      const { bridge, store } = window.__wrx.app;
      const conn = store.get().connection;
      for (let i = 0; i <= n; i++) {
        bridge._emit('rssi', { ts: Date.now(), rssi: Math.round(a + ((b - a) * i) / n), bssid: conn.bssid, frequency: conn.frequency });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    { from, to, steps },
  );

// ---------------------------------------------------------------------------
// Mostrador semicircular (reutilizado pelo teste de velocidade)
// ---------------------------------------------------------------------------

test('gauge: papel de medidor, texto, zonas, pico, escala, tema e destruição', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/sobre' }, async ({ page }) => {
    const out = await page.evaluate(async () => {
      const { createGauge } = await import('./js/ui/charts/gauge.js');
      const host = document.createElement('div');
      host.style.width = '300px';
      document.querySelector('.view > .screen').prepend(host);
      const gauge = createGauge(host, {
        min: -100,
        max: -30,
        zones: [
          { from: -100, to: -67, color: '--sig-5' },
          { from: -67, to: -30, color: 'var(--sig-1)' },
        ],
        format: (v) => `v${Math.round(v)}`,
        unit: 'dBm',
        label: 'Sinal',
      });
      const el = host.querySelector('.gauge');
      const canvas = el.querySelector('canvas');
      const ctx = canvas.getContext('2d');
      const snap = () => ({
        role: el.getAttribute('role'),
        now: el.getAttribute('aria-valuenow'),
        min: el.getAttribute('aria-valuemin'),
        max: el.getAttribute('aria-valuemax'),
        text: el.getAttribute('aria-valuetext'),
        value: el.querySelector('.gauge__number').textContent,
        unit: el.querySelector('.gauge__unit').textContent,
        unitHidden: el.querySelector('.gauge__unit').hidden,
        label: el.querySelector('.gauge__label').textContent,
        color: el.style.getPropertyValue('--gauge-color'),
        dataValue: el.dataset.value,
        dataPeak: el.dataset.peak,
      });
      const ink = () => {
        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
        return n;
      };
      // a ponta esquerda do arco (onde o valor começa a ser pintado)
      const startPixel = () => {
        const dpr = canvas.width / canvas.clientWidth;
        const p = ctx.getImageData(Math.round(19.5 * dpr), Math.round(150 * dpr), 1, 1).data;
        return `${p[0]},${p[1]},${p[2]},${p[3]}`;
      };
      const steps = {};
      steps.methods = ['set', 'setRange', 'resize', 'destroy'].every((name) => typeof gauge[name] === 'function');
      steps.empty = snap();
      steps.inkEmpty = ink();
      gauge.set(-50, { peak: -40, label: 'Ótimo' });
      steps.set = snap();
      steps.ink = ink();
      steps.dpr = canvas.width / canvas.clientWidth;
      steps.size = { w: canvas.clientWidth, h: canvas.clientHeight };
      steps.fits = el.querySelector('.gauge__readout').getBoundingClientRect().width <= 300;
      steps.pixelDark = startPixel();
      gauge.set(-90);
      steps.low = snap();
      steps.pixelLow = startPixel();
      gauge.set(-50, { peak: null });
      steps.noPeak = snap();
      gauge.set(null);
      steps.none = snap();
      gauge.setRange(0, 200);
      gauge.set(100, { animate: false });
      steps.range = snap();
      gauge.set(500);
      steps.over = snap();
      gauge.setLabel('Download');
      gauge.setUnit('Mb/s');
      steps.labels = snap();
      gauge.setRange(-100, -30);
      gauge.set(-50);

      // tema: as cores são lidas de novo
      const html = document.documentElement;
      const themeBefore = html.dataset.theme;
      html.dataset.theme = themeBefore === 'dark' ? 'light' : 'dark';
      await new Promise((resolve) => setTimeout(resolve, 60));
      steps.pixelOther = startPixel();
      html.dataset.theme = themeBefore;
      await new Promise((resolve) => setTimeout(resolve, 60));
      steps.pixelBack = startPixel();

      // largura: o canvas acompanha o contêiner
      host.style.width = '200px';
      gauge.resize();
      steps.narrow = { w: canvas.clientWidth, px: canvas.width };

      gauge.destroy();
      steps.gone = host.querySelector('.gauge') === null;
      gauge.set(5); // depois de destruído, nada acontece (e nada quebra)
      gauge.resize();
      gauge.destroy();
      steps.styles = document.querySelectorAll('#wrx-gauge-style').length;
      host.remove();
      return steps;
    });

    assert.equal(out.methods, true, 'a assinatura combinada: set, setRange, resize, destroy');
    assert.equal(out.empty.role, 'meter');
    assert.equal(out.empty.now, null, 'sem valor não há aria-valuenow');
    assert.equal(out.empty.value, '—');
    assert.equal(out.empty.unitHidden, true);
    assert.equal(out.empty.label, 'Sinal');
    assert.ok(out.inkEmpty > 0, 'o trilho e as zonas são desenhados mesmo sem valor');

    assert.equal(out.set.value, 'v-50', 'o número do centro vem de format()');
    assert.equal(out.set.unit, 'dBm');
    assert.equal(out.set.unitHidden, false);
    assert.equal(out.set.label, 'Ótimo');
    assert.equal(out.set.now, '-50');
    assert.equal(out.set.min, '-100');
    assert.equal(out.set.max, '-30');
    assert.equal(out.set.text, 'v-50 dBm, Ótimo');
    assert.equal(out.set.color, 'var(--sig-1)', 'a palavra leva a cor da zona do valor');
    assert.equal(out.set.dataValue, '-50');
    assert.equal(out.set.dataPeak, '-40');
    assert.ok(out.ink > out.inkEmpty, 'o arco do valor foi pintado');
    assert.equal(out.dpr, 2, 'o canvas tem um pixel por pixel físico');
    assert.equal(out.size.w, 300);
    assert.ok(out.size.h > 150 && out.size.h < 200, `meia-volta: ${out.size.h}px de altura para 300 de largura`);
    assert.equal(out.fits, true);

    assert.equal(out.low.color, 'var(--sig-5)');
    assert.equal(out.low.dataPeak, '-40', 'sem `peak` na chamada a marca fica onde estava');
    assert.notEqual(out.pixelLow, out.pixelDark, 'a cor do arco muda com a zona');
    assert.equal(out.noPeak.dataPeak, '', 'peak: null apaga a marca');
    assert.equal(out.none.value, '—');
    assert.equal(out.none.now, null);

    assert.equal(out.range.min, '0');
    assert.equal(out.range.max, '200');
    assert.equal(out.range.now, '100');
    assert.equal(out.over.now, '200', 'valor acima da escala fica preso no máximo para leitores de tela');
    assert.equal(out.over.value, 'v500', 'mas o número mostrado é o verdadeiro');
    assert.equal(out.labels.label, 'Download');
    assert.equal(out.labels.unit, 'Mb/s');

    assert.notEqual(out.pixelOther, out.pixelDark, 'ao trocar o tema as cores são lidas de novo');
    assert.equal(out.pixelBack, out.pixelDark);
    assert.deepEqual(out.narrow, { w: 200, px: 400 });
    assert.equal(out.gone, true);
    assert.equal(out.styles, 1, 'o estilo do mostrador entra uma vez só');
  });
});

// ---------------------------------------------------------------------------
// Medidor: contas
// ---------------------------------------------------------------------------

test('medidor: tendência, temperatura, ritmo dos avisos e estatísticas (funções puras)', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/sobre' }, async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await import('./js/ui/tools/medidor.js');
      const ramp = (from, to, n, dt) => Array.from({ length: n }, (_, i) => ({ t: i * dt, v: from + ((to - from) * i) / (n - 1) }));
      const stats = m.createStats();
      const empty = stats.get();
      [-60, -50, -70].forEach((v, i) => stats.add(v, 1000 * (i + 1)));
      stats.add(NaN, 9000);
      const full = stats.get();
      stats.reset();
      const smooth = m.createSmoother(1000);
      const s1 = smooth(0, -60);
      const s2 = smooth(1000, -50);
      const raw = m.createSmoother(0);
      raw(0, -60);
      return {
        up: m.trendOf(ramp(-80, -60, 11, 500), { now: 5000 }),
        down: m.trendOf(ramp(-50, -75, 11, 500), { now: 5000 }),
        flat: m.trendOf(ramp(-60, -60.8, 11, 500), { now: 5000 }),
        few: m.trendOf([{ t: 4000, v: -60 }, { t: 5000, v: -40 }], { now: 5000 }),
        short: m.trendOf(ramp(-80, -40, 5, 100), { now: 400 }),
        old: m.trendOf(ramp(-80, -60, 11, 500), { now: 60_000 }),
        junk: m.trendOf([null, { t: 'x' }, { t: 1, v: NaN }], { now: 5 }),
        none: m.trendOf(null, { now: 5 }),
        scanUp: m.trendOf([{ t: 0, v: -70 }, { t: 10_000, v: -60 }], { now: 10_000, windowMs: 35_000, minDeltaDb: 3, minPoints: 2, minSpanMs: 1000 }),
        scanSame: m.trendOf([{ t: 0, v: -70 }, { t: 10_000, v: -69 }], { now: 10_000, windowMs: 35_000, minDeltaDb: 3, minPoints: 2, minSpanMs: 1000 }),
        heat: [-40, -50, -60, -70, -85, null].map((v) => m.heatOf(v)),
        fb: [-95, -90, -65, -40, -20, null].map((v) => m.feedbackFor(v)),
        empty,
        full,
        afterReset: stats.get(),
        s1,
        s2,
        rawNext: raw(10, -40),
        bssid: [m.normBssid('AA-BB-CC-00-11-22'), m.normBssid(' aa:bb:cc:00:11:22 '), m.normBssid('<img>'), m.normBssid(null), m.normBssid('aa:bb:cc:00:11')],
        zones: m.SIGNAL_ZONES.map((z) => [z.from, z.to, z.color]),
        range: [m.stripRange([]), m.stripRange([-57]), m.stripRange([-91, -38]), m.stripRange([-99, -98]), m.stripRange([-25, -22])],
        ages: [0, 30, 60, 120].map((s) => m.ageLabel(s)),
      };
    });

    assert.equal(r.up.state, 'closer');
    assert.ok(Math.abs(r.up.deltaDb - 20) < 0.01, 'o ajuste dá a variação ao longo da janela');
    assert.equal(r.up.spanMs, 5000);
    assert.equal(r.down.state, 'farther');
    assert.ok(Math.abs(r.down.deltaDb + 25) < 0.01);
    assert.equal(r.flat.state, 'steady', 'menos de 2 dB na janela não é tendência');
    assert.equal(r.few.state, 'unknown', 'duas leituras não bastam ao vivo');
    assert.equal(r.short.state, 'unknown', 'leituras que cobrem menos de 40% da janela não bastam');
    assert.equal(r.old.state, 'unknown', 'leituras fora da janela não contam');
    assert.equal(r.junk.state, 'unknown');
    assert.equal(r.none.state, 'unknown');
    assert.equal(r.scanUp.state, 'closer', 'rede lida a cada busca: duas leituras e 3 dB bastam');
    assert.equal(r.scanSame.state, 'steady');

    assert.deepEqual(
      r.heat.map((h) => h.level),
      [5, 4, 3, 2, 1, 0],
    );
    assert.deepEqual(
      r.heat.map((h) => h.label),
      ['Muito quente', 'Quente', 'Morno', 'Frio', 'Muito frio', 'Sem leitura'],
    );

    assert.deepEqual(r.fb[0], r.fb[1], 'abaixo de −90 dBm o ritmo não diminui mais');
    assert.deepEqual(r.fb[3], r.fb[4], 'acima de −40 dBm o ritmo não aumenta mais');
    assert.deepEqual(r.fb[5], r.fb[1], 'sem leitura = o ritmo mais lento');
    assert.equal(r.fb[1].intervalMs, 1400);
    assert.equal(r.fb[1].freqHz, 440);
    assert.equal(r.fb[3].intervalMs, 150);
    assert.ok(r.fb[3].freqHz > 1300 && r.fb[3].freqHz < 1330);
    assert.ok(r.fb[1].intervalMs > r.fb[2].intervalMs && r.fb[2].intervalMs > r.fb[3].intervalMs, 'quanto mais forte, mais rápido');
    assert.ok(r.fb[1].freqHz < r.fb[2].freqHz && r.fb[2].freqHz < r.fb[3].freqHz, 'e mais agudo');
    assert.ok(r.fb[1].vibrateMs >= 10 && r.fb[3].vibrateMs <= 40);

    assert.deepEqual(r.empty, { count: 0, min: null, max: null, maxAt: null, avg: null });
    assert.deepEqual(r.full, { count: 3, min: -70, max: -50, maxAt: 2000, avg: -60 });
    assert.deepEqual(r.afterReset, r.empty);
    assert.equal(r.s1, -60, 'a primeira leitura entra inteira');
    assert.ok(r.s2 > -55 && r.s2 < -52, `depois de uma constante de tempo anda ~63% do caminho (${r.s2})`);
    assert.equal(r.rawNext, -40, 'constante zero = sem suavizar');

    assert.deepEqual(r.bssid, ['aa:bb:cc:00:11:22', 'aa:bb:cc:00:11:22', '', '', '']);
    assert.deepEqual(r.zones[0], [-100, -82, '--sig-5']);
    assert.deepEqual(r.zones[4], [-60, -30, '--sig-1']);
    assert.deepEqual(r.range, [
      { min: -90, max: -40 },
      { min: -70, max: -40 },
      { min: -100, max: -30 },
      { min: -100, max: -70 },
      { min: -50, max: -20 },
    ]);
    assert.deepEqual(r.ages, ['agora', `${MINUS}30${THIN}s`, `${MINUS}1${THIN}min`, `${MINUS}2${THIN}min`]);
  });
});

// ---------------------------------------------------------------------------
// Medidor: a tela
// ---------------------------------------------------------------------------

test('medidor: abre na rede conectada, com leitura ao vivo, e devolve o ritmo normal ao sair', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/medidor' }, async ({ page }) => {
    await waitForScans(page, 1);
    assert.equal(await page.textContent('.topbar__title'), 'Medidor de sinal');
    const conn = await connectedBssid(page);
    await page.waitForFunction(() => Number(document.querySelector('.view > .screen').dataset.samples) >= 10);
    const d = await data(page);
    assert.equal(d.target, conn, 'o alvo padrão é a rede conectada');
    assert.equal(d.live, '1');
    assert.match(await page.textContent('.mtr-note'), /Leitura ao vivo/);
    assert.match(await page.textContent('.mtr-target__row'), /Conectada/);

    // o mostrador mostra o que o celular mede
    const gauge = page.locator('.mtr-gauge .gauge');
    assert.equal(await gauge.getAttribute('role'), 'meter');
    assert.equal(await gauge.getAttribute('aria-valuemin'), '-100');
    assert.equal(await gauge.getAttribute('aria-valuemax'), '-30');
    const now = Number(await gauge.getAttribute('aria-valuenow'));
    assert.ok(now <= -30 && now >= -100, `sinal plausível: ${now}`);
    assert.match(await page.textContent('.mtr-gauge .gauge__number'), new RegExp(`^${MINUS}\\d+$`));
    assert.equal(await page.textContent('.mtr-gauge .gauge__unit'), 'dBm');
    assert.match(await page.textContent('.mtr-gauge .gauge__label'), /^(Excelente|Ótimo|Bom|Regular|Fraco|Muito fraco)$/);
    assert.match(await page.textContent('[data-field="quality"]'), /^\d+%$/);
    assert.match(await page.textContent('[data-field="distance"]'), /^≈\s[\d,]+\sm$/, 'a distância é mostrada como estimativa');
    assert.match(await page.textContent('.mtr-meta'), /estimativa/);

    // mínimo <= média <= máximo, e a marca de pico acompanha o máximo
    const stats = await page.evaluate(() => Array.from(document.querySelectorAll('.mtr-stat__value')).map((el) => Number(el.firstChild.textContent.replace(String.fromCharCode(0x2212), '-'))));
    assert.equal(stats.length, 3);
    assert.ok(stats[0] <= stats[1] && stats[1] <= stats[2], `mín ${stats[0]} <= média ${stats[1]} <= máx ${stats[2]}`);
    const peak = Number(await page.evaluate(() => document.querySelector('.mtr-gauge .gauge').dataset.peak));
    assert.ok(Math.abs(peak - stats[2]) <= 1, 'a marca de pico é o máximo da medição');

    // o gráfico de fita foi desenhado e descreve o que mostra
    const chart = await page.evaluate(() => {
      const c = document.querySelector('.mtr-chart canvas');
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) ink += 1;
      return { ink, ratio: c.width / c.clientWidth, label: c.getAttribute('aria-label') };
    });
    assert.ok(chart.ink > 500, 'o gráfico tem conteúdo');
    assert.equal(chart.ratio, 2);
    assert.match(chart.label, /última leitura/);
    await shot(page, 'tools-a-medidor');

    // "zerar" recomeça a medição
    const before = Number((await data(page)).samples);
    await page.click('.mtr-stats__head .btn');
    await page.waitForFunction((n) => Number(document.querySelector('.view > .screen').dataset.samples) < n, before);

    // enquanto a tela está aberta as leituras vêm 4 vezes mais rápido; ao sair, voltam ao normal
    const fast = await rssiRate(page);
    assert.equal(await page.evaluate(() => window.__wrx.app.scanLoop.getState().mode), 'normal', 'rede conectada não precisa de buscas rápidas');
    await goto(page, '/ferramentas');
    await page.waitForTimeout(300);
    const slow = await rssiRate(page);
    assert.ok(fast >= slow * 2, `leituras em 0,6 s: ${fast} com o medidor aberto, ${slow} depois de sair`);
    assert.equal(await page.locator('.gauge').count(), 0, 'o mostrador saiu junto com a tela');
  });
});

test('medidor: ?bssid= abre noutra rede, avisa que ela só muda a cada busca e acelera as buscas', T, async () => {
  // pessoa parada: o celular não troca de ponto de acesso no meio do teste
  await withApp(env, { params: { ...FAST, walk: 'still' } }, async ({ page }) => {
    await waitForScans(page, 2);
    const conn = await connectedBssid(page);
    const other = await appState(page, (s) => s.aps.find((ap) => !ap.connected && !ap.stale && ap.ssid && ap.rssi > -80 && !ap.own).bssid);
    // com os dois-pontos codificados, do jeito que a tela Redes monta o endereço
    await goto(page, `/ferramentas/medidor?bssid=${encodeURIComponent(other)}`);
    await page.waitForFunction((id) => document.querySelector('.view > .screen').dataset.target === id, other);
    let d = await data(page);
    assert.equal(d.live, '');
    assert.match(await page.textContent('.mtr-note'), /só é lida a cada busca \(≈\s\d+\ss/);
    assert.match(await page.textContent('.mtr-note'), /conecte o celular a ela/);
    assert.equal(await page.evaluate(() => window.__wrx.app.scanLoop.getState().mode), 'mapping', 'pede o ritmo de buscas mais rápido');

    // cada busca em que a rede é ouvida vira uma leitura
    await page.waitForFunction(() => Number(document.querySelector('.view > .screen').dataset.samples) >= 2, null, { timeout: 40_000 });
    const shown = Number((await data(page)).rssi);
    const real = await appState(page, (s, id) => s.aps.find((ap) => ap.bssid === id).rssi, other);
    assert.ok(Math.abs(shown - real) <= 12, `o valor mostrado (${shown}) é o da última busca (${real})`);
    assert.match(await page.textContent('.mtr-chart__window'), /2\smin/);

    // a mesma tela aceita outro alvo pela rota (é assim que a tela Redes chega aqui)
    await page.evaluate((id) => {
      location.hash = `#/ferramentas/medidor?bssid=${id}`;
    }, conn);
    await page.waitForFunction((id) => document.querySelector('.view > .screen').dataset.target === id, conn);
    d = await data(page);
    assert.equal(d.live, '1', 'a rede conectada, mesmo escolhida pelo BSSID, tem leitura ao vivo');
    assert.equal(await page.evaluate(() => window.__wrx.app.scanLoop.getState().mode), 'normal');

    await page.evaluate((id) => {
      location.hash = `#/ferramentas/medidor?bssid=${id}`;
    }, other);
    await page.waitForFunction((id) => document.querySelector('.view > .screen').dataset.target === id, other);
    assert.equal(await page.evaluate(() => window.__wrx.app.scanLoop.getState().mode), 'mapping');
    await goto(page, '/ferramentas');
    assert.equal(await page.evaluate(() => window.__wrx.app.scanLoop.getState().mode), 'normal', 'ao sair o ritmo das buscas volta ao normal');
  });
});

test('medidor: "como ler o medidor" explica dBm e as faixas, sem cortar nada numa tela pequena', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/medidor', viewport: 'small' }, async ({ page }) => {
    await waitForScans(page, 1);
    await page.waitForFunction(() => Number(document.querySelector('.view > .screen').dataset.samples) >= 3);
    assert.equal(await page.textContent('.topbar__title'), 'Medidor de sinal', 'o título cabe inteiro na barra de cima');
    const title = await page.evaluate(() => {
      const el = document.querySelector('.topbar__title');
      return el.scrollWidth <= el.clientWidth;
    });
    assert.equal(title, true, 'sem reticências no título');
    assert.equal(await page.getAttribute('.mtr-help', 'aria-label'), 'Como ler o medidor');
    await page.click('.mtr-help');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.textContent('.sheet__title'), 'Como ler o medidor');
    const body = await page.textContent('.sheet__body');
    assert.match(body, /dBm é a unidade da força do sinal/);
    assert.match(body, /quanto mais perto de zero, mais forte/);
    for (const word of ['Excelente', 'Ótimo', 'Bom', 'Regular', 'Fraco', 'Muito fraco', 'Qualidade', 'tracinho no arco', 'estimativa', 'caça-roteador']) assert.ok(body.includes(word), `explica "${word}"`);
    assert.equal(await page.locator('.sheet .mtr-sheetcard .row').count(), 6);
    const clipped = await page.evaluate(() => {
      const card = document.querySelector('.sheet .mtr-sheetcard');
      return card.scrollHeight - card.clientHeight;
    });
    assert.ok(clipped <= 1, 'a tabela das faixas aparece inteira (o painel rola, o cartão não encolhe)');
    await shot(page, 'tools-a-medidor-ajuda');
    assert.equal(await back(page), true);
    await page.locator('.sheet').waitFor({ state: 'detached' });
  });
});

test('medidor: escolher a rede no painel, voltar à conectada, e o "voltar" fecha o painel', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/medidor' }, async ({ page }) => {
    await waitForScans(page, 2);
    const conn = await connectedBssid(page);
    const other = await appState(page, (s) => s.aps.find((ap) => !ap.connected && !ap.stale && ap.ssid).bssid);

    await page.click('.mtr-target__row');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.textContent('.sheet__title'), 'Qual rede medir?');
    assert.match(await page.textContent('.sheet__body'), /As outras redes só mudam a cada busca/);
    const rows = await page.evaluate(() => ({ shown: document.querySelectorAll('.sheet .mtr-pick').length, aps: window.__wrx.app.store.get().aps.length }));
    assert.equal(rows.shown, rows.aps, 'uma linha por sinal');
    // a lista inteira é alcançável: quem rola é o painel, e nenhum cartão fica cortado
    const clipped = await page.evaluate(() => Array.from(document.querySelectorAll('.sheet .mtr-sheetcard')).map((el) => el.scrollHeight - el.clientHeight));
    assert.ok(clipped.every((d) => d <= 1), `cartões do painel sem corte: ${clipped}`);
    assert.equal(await page.locator('.sheet .mtr-pick--on').count(), 0, 'seguindo a conectada, nenhuma linha fica marcada');
    await shot(page, 'tools-a-medidor-escolher');

    await page.click(`.sheet .mtr-pick[data-bssid="${other}"] button`);
    await page.locator('.sheet').waitFor({ state: 'detached' });
    await page.waitForFunction((id) => document.querySelector('.view > .screen').dataset.target === id, other);
    assert.equal((await data(page)).live, '');

    // o painel abre de novo com a escolha marcada; o "voltar" do Android só fecha o painel
    await page.click('.mtr-target__row');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.getAttribute('.sheet .mtr-pick--on', 'data-bssid'), other);
    assert.equal(await back(page), true);
    await page.locator('.sheet').waitFor({ state: 'detached' });
    assert.equal(await hash(page), '#/ferramentas/medidor', 'continua no medidor');
    assert.equal((await data(page)).target, other);

    // "Rede conectada" volta a acompanhar o celular
    await page.click('.mtr-target__row');
    await page.locator('.sheet').waitFor();
    await page.locator('.sheet .row', { hasText: 'Rede conectada' }).click();
    await page.locator('.sheet').waitFor({ state: 'detached' });
    await page.waitForFunction((id) => document.querySelector('.view > .screen').dataset.target === id, conn);
    assert.equal((await data(page)).live, '1');
  });
});

test('medidor: caça-roteador diz mais longe / estável / mais perto, vibra e não quebra com o som', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/medidor' }, async ({ page }) => {
    await waitForScans(page, 1);
    await page.waitForFunction(() => Number(document.querySelector('.view > .screen').dataset.samples) >= 5);
    assert.equal(await page.locator('.mtr-hunt').count(), 0, 'a caça começa desligada');
    assert.equal((await data(page)).trend, '');
    const start = await vibration(page);

    // daqui em diante as leituras são as do teste, não as do simulador
    await page.evaluate(() => window.__wrx.app.bridge.unwatchRssi());
    await page.locator('.mtr-hunt-host .switch').first().click();
    await page.locator('.mtr-trend').waitFor();
    assert.equal(await page.locator('.mtr-hunt-host .switch').count(), 3, 'aparecem as chaves de bipes e de vibração');
    assert.equal(await page.locator('.mtr-hunt-host .switch').nth(1).isChecked(), false, 'o som começa desligado');
    assert.equal(await page.locator('.mtr-hunt-host .switch').nth(2).isChecked(), true, 'a vibração começa ligada');
    assert.equal(await simEval(page, (sim) => sim.device.keepAwake), true, 'caçando, a tela do celular fica ligada');

    // o sinal cai: mais longe
    await emitRssi(page, -50, -88, 30);
    await page.waitForFunction(() => document.querySelector('.view > .screen').dataset.trend === 'farther');
    assert.equal(await page.textContent('.mtr-trend__title'), 'Mais longe');
    assert.equal(await page.textContent('.mtr-hunt [role="status"]'), 'Mais longe', 'o leitor de tela ouve só a mudança de direção');
    assert.match(await page.textContent('.mtr-trend__text'), /o sinal caiu \d+\sdB em \d+\ss/);
    assert.match(await page.textContent('.mtr-heat__text'), /^(Muito frio|Frio)/);
    await shot(page, 'tools-a-medidor-caca-longe');

    // parado (o bastante para a queda sair da janela de 5 s): estável
    await emitRssi(page, -88, -88, 90);
    await page.waitForFunction(() => document.querySelector('.view > .screen').dataset.trend === 'steady');
    assert.equal(await page.textContent('.mtr-trend__title'), 'Estável');
    assert.equal(await page.getAttribute('.mtr-heat', 'data-level'), '1');

    // o sinal sobe: mais perto, e a "temperatura" acompanha
    await emitRssi(page, -88, -42, 30);
    await page.waitForFunction(() => document.querySelector('.view > .screen').dataset.trend === 'closer');
    assert.equal(await page.textContent('.mtr-trend__title'), 'Mais perto');
    assert.match(await page.textContent('.mtr-trend__text'), /o sinal subiu \d+\sdB em \d+\ss/);
    await emitRssi(page, -42, -42, 25); // a "temperatura" usa o sinal suavizado: leva um instante para chegar lá
    assert.ok(Number(await page.getAttribute('.mtr-heat', 'data-level')) >= 4, 'perto do roteador a caça esquenta');
    assert.match(await page.textContent('.mtr-heat__text'), /^(Muito quente|Quente)/);
    await shot(page, 'tools-a-medidor-caca-perto');

    // os toques de vibração saíram pela ponte, no ritmo do sinal
    const mid = await vibration(page);
    assert.ok(mid.ticks >= 8, `houve toques durante a caça (${mid.ticks})`);
    assert.equal(mid.sim - start.sim, mid.ticks, 'cada toque foi um bridge.vibrate');

    // som: liga se o aparelho deixar; se não, avisa e segue (sem erro de qualquer jeito)
    await page.locator('.mtr-hunt-host .switch').nth(1).click();
    await emitRssi(page, -42, -42, 15);
    const sound = await page.evaluate(() => ({
      beeps: Number(document.querySelector('.view > .screen').dataset.beeps || 0),
      checked: document.querySelectorAll('.mtr-hunt-host .switch')[1].checked,
      toast: document.querySelector('.toast')?.textContent || '',
    }));
    if (sound.checked) assert.ok(sound.beeps > 0, 'com o som ligado os bipes tocam');
    else assert.match(sound.toast, /Não foi possível ligar o som/);

    // desligar a vibração para os toques
    await page.locator('.mtr-hunt-host .switch').nth(2).click();
    await settle(page);
    const stopped = await simEval(page, (sim) => sim.device.vibrations);
    await emitRssi(page, -42, -42, 12);
    assert.equal(await simEval(page, (sim) => sim.device.vibrations), stopped, 'sem vibração, nenhum toque');

    // sem leituras novas a tela para de fingir: o valor some e a caça avisa
    await page.locator('.mtr-hunt-host .switch').nth(2).click();
    await page.waitForFunction(() => document.querySelector('.mtr-gauge .gauge').dataset.value === '', null, { timeout: 15_000 });
    assert.equal(await page.textContent('.mtr-gauge .gauge__label'), 'Sem leitura');
    assert.match(await page.textContent('.mtr-hunt'), /Sem leituras novas do sinal/);
    const quiet = await simEval(page, (sim) => sim.device.vibrations);
    await page.waitForTimeout(1600);
    assert.equal(await simEval(page, (sim) => sim.device.vibrations), quiet, 'sem leitura não há toque');

    // ao sair, tudo para: nenhum toque depois, e nada de erro
    await emitRssi(page, -42, -42, 5);
    await goto(page, '/ferramentas');
    const left = await simEval(page, (sim) => sim.device.vibrations);
    await page.waitForTimeout(1200);
    assert.equal(await simEval(page, (sim) => sim.device.vibrations), left, 'a caça não continua depois de sair da tela');
    assert.equal(await simEval(page, (sim) => sim.device.keepAwake), false, 'e a tela do celular volta a poder apagar');
  });
});

test('medidor: distância por Wi-Fi RTT quando o roteador sabe (medir, cancelar, resultado, falha)', T, async () => {
  await withApp(env, { params: { ...FAST, world: 'sobrado', walk: 'still' } }, async ({ page }) => {
    await waitForScans(page, 2);
    const conn = await connectedBssid(page);
    // alvo fixado pelo BSSID (como quem chega pela tela Redes)
    await goto(page, `/ferramentas/medidor?bssid=${conn}`);
    await page.locator('.mtr-rtt').waitFor();
    assert.match(await page.textContent('.mtr-rtt'), /Wi-Fi RTT/);
    assert.equal(await page.locator('.mtr-rtt__result').count(), 0);
    const measure = () => page.evaluate(() => Array.from(document.querySelectorAll('.mtr-rtt .btn')).find((b) => /Medir/.test(b.textContent)).click());

    // devagar, para dar tempo de cancelar: a resposta que chega depois é ignorada
    await simEval(page, (sim) => sim.setSpeed(1));
    await measure();
    await page.locator('.mtr-rtt__busy').waitFor();
    assert.match(await page.textContent('.mtr-rtt__busy'), /Medindo/);
    await page.locator('.mtr-rtt__busy .btn', { hasText: 'Cancelar' }).click();
    await page.locator('.mtr-rtt__busy').waitFor({ state: 'detached' });
    await page.waitForTimeout(2200);
    assert.equal(await page.locator('.mtr-rtt__result').count(), 0, 'medição cancelada não vira resultado');

    await simEval(page, (sim) => sim.setSpeed(10));
    await measure();
    await page.locator('.mtr-rtt__result').waitFor({ timeout: 15_000 });
    const text = await page.textContent('.mtr-rtt__result');
    assert.match(text, /(\d+(,\d)?\sm|menos de 0,5\sm)/, `distância em metros: ${text}`);
    assert.match(text, /Medido (agora|há)/);
    assert.match(text, /pelo sinal a estimativa era ≈/);
    const dist = Number(await page.getAttribute('.mtr-rtt__result', 'data-dist'));
    assert.ok(dist >= 0 && dist < 40, `distância plausível dentro de casa: ${dist}`);
    assert.equal(await page.locator('.mtr-rtt .btn', { hasText: 'Medir de novo' }).count(), 1);
    await shot(page, 'tools-a-medidor-rtt');

    // sem permissão o Android não mede ninguém: aviso amigável, e o resultado anterior continua na tela
    // (o bloqueio de permissão cobre a tela; o toque vai direto no botão)
    await simEval(page, (sim) => sim.setState({ permission: 'denied' }));
    await measure();
    await page.waitForFunction(() => /O roteador não respondeu à medição/.test(document.querySelector('.mtr-rtt')?.textContent || ''));
    assert.equal(await page.locator('.mtr-rtt__result').count(), 1);
    assert.equal(await page.locator('.mtr-rtt__busy').count(), 0);
    await simEval(page, (sim) => sim.setState({ permission: 'granted' }));
  });
});

test('medidor: num roteador comum não há botão de RTT', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/medidor' }, async ({ page }) => {
    await waitForScans(page, 2);
    await page.waitForFunction(() => Number(document.querySelector('.view > .screen').dataset.samples) >= 3);
    assert.equal(await appState(page, (s) => s.aps.find((ap) => ap.connected).rttResponder), false);
    assert.equal(await page.locator('.mtr-rtt').count(), 0);
  });
});

test('medidor: nome de rede hostil é só texto; rede que sumiu e celular desconectado têm estados próprios', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: `/ferramentas/medidor?bssid=${HOSTILE_BSSID}` }, async ({ page }) => {
    await waitForScans(page, 2);
    await page.waitForFunction((name) => document.querySelector('.mtr-target__row .ssid')?.textContent === name, HOSTILE);
    assert.equal(await page.locator(`${SCREEN} img, ${SCREEN} script`).count(), 0, 'o nome não virou elemento');
    assert.match(await page.getAttribute('.mtr-target__row', 'aria-label'), /<img src=x onerror=alert\(1\)>/);
    await page.click('.mtr-target__row');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.locator('.sheet img, .sheet script').count(), 0);
    assert.equal(await page.textContent(`.sheet .mtr-pick[data-bssid="${HOSTILE_BSSID}"] .ssid`), HOSTILE);
    assert.equal(await back(page), true);
    await page.locator('.sheet').waitFor({ state: 'detached' });

    // um BSSID que não está ao alcance
    await page.evaluate(() => {
      location.hash = '#/ferramentas/medidor?bssid=02:00:00:00:00:01';
    });
    await page.waitForFunction(() => document.querySelector('.view > .screen').dataset.target === '02:00:00:00:00:01');
    assert.match(await page.textContent('.mtr-note'), /não apareceu nas últimas buscas/);
    assert.equal(await page.textContent('.mtr-gauge .gauge__number'), '—');
    assert.equal(await page.textContent('.mtr-gauge .gauge__label'), 'Sem leitura');
    assert.match(await page.textContent('.mtr-meta'), /Aguardando esta rede aparecer/);
    assert.equal(await page.locator('.mtr-rtt').count(), 0);
    await shot(page, 'tools-a-medidor-sumiu');

    // rota com lixo no lugar do BSSID: ignora e mede a conectada
    await goto(page, '/ferramentas');
    await goto(page, '/ferramentas/medidor?bssid=%3Cimg%3E');
    await page.waitForFunction(() => document.querySelector('.view > .screen').dataset.target === window.__wrx.app.store.get().connection.bssid);
    assert.equal((await data(page)).live, '1');

    // celular fora do Wi-Fi e nenhuma rede escolhida: convite para escolher
    await page.evaluate(() => window.__wrx.app.store.setConnection({ connected: false }));
    await page.locator('.mtr-pickme').waitFor();
    assert.match(await page.textContent('.mtr-pickme'), /Qual rede você quer medir\?/);
    assert.equal((await data(page)).target, '');
    assert.equal(await page.textContent('.mtr-gauge .gauge__number'), '—');
    await shot(page, 'tools-a-medidor-sem-alvo');
    await page.locator('.mtr-pickme .btn').click();
    await page.locator('.sheet').waitFor();
    assert.match(await page.textContent('.sheet__body'), /O celular não está conectado agora/);
  });
});

// ---------------------------------------------------------------------------
// Detalhes da conexão
// ---------------------------------------------------------------------------

test('conexão: máscara, validade do endereço e montagem das linhas (funções puras)', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/sobre' }, async ({ page }) => {
    const r = await page.evaluate(async () => {
      const m = await import('./js/ui/tools/conexao.js');
      const full = m.describeConnection(
        { connected: true, ssid: 'Casa', bssid: 'aa:bb:cc:00:11:22', rssi: -61, frequency: 2437, linkSpeed: 72, txSpeed: 65, rxSpeed: 72, maxTxSpeed: 144, maxRxSpeed: 144, wifiStandard: 4, securityType: 2, ip: '10.0.0.7', prefix: 22, gateway: '10.0.0.1', dns: ['1.1.1.1', '', '8.8.8.8'], ipv6: [], iface: 'wlan0', mtu: 1500, leaseSec: 86_400, validated: true, metered: false },
        null,
      );
      const bare = m.describeConnection({ connected: true }, null);
      return {
        masks: [24, 0, 32, 20, 30, 33, -1, '24', 2.5].map((p) => m.maskOf(p)),
        leases: [86_400, 172_800, 7200, 3600, 5400, 0, -5, null].map((x) => m.leaseText(x)),
        groups: full.groups.map((g) => [g.id, g.rows.map((row) => row.label), g.textRows.map((row) => row.label)]),
        mask: full.groups[2].rows.find((row) => row.field === 'mask'),
        channel: full.channel,
        band: full.band,
        speed: full.speed,
        text: m.connectionText(full),
        bare: { groups: bare.groups.map((g) => [g.id, g.rows.map((row) => `${row.label}=${row.text}`)]), speed: bare.speed, text: m.connectionText(bare) },
      };
    });
    assert.deepEqual(r.masks, ['255.255.255.0', '0.0.0.0', '255.255.255.255', '255.255.240.0', '255.255.255.252', null, null, null, null]);
    assert.deepEqual(r.leases.slice(0, 4), ['1 dia', '2 dias', '2 horas', '1 hora']);
    assert.match(r.leases[4], /^1\sh 30\smin$/);
    assert.deepEqual(r.leases.slice(5), [null, null, null]);
    assert.deepEqual(r.groups, [
      ['rede', ['Nome da rede', 'BSSID', 'Segurança', 'Padrão', 'Internet', 'Franquia de dados'], []],
      ['sinal', ['Sinal', 'Qualidade', 'Distância do roteador', 'Faixa', 'Canal', 'Frequência'], ['Velocidade do enlace (receber)', 'Velocidade do enlace (enviar)']],
      ['enderecos', ['IP do celular', 'Máscara de sub-rede', 'Roteador (gateway)', 'DNS 1', 'DNS 2', 'Interface', 'MTU', 'Endereço válido por'], []],
    ]);
    assert.equal(r.mask.text, '255.255.252.0');
    assert.match(r.mask.hint, /^Prefixo \/22: cabem até 1\.022 aparelhos nesta rede\.$/);
    assert.equal(r.channel, 6, 'sem o Ap da varredura, o canal sai da frequência');
    assert.equal(r.band, '2.4');
    assert.deepEqual({ rx: r.speed.rx, tx: r.speed.tx, maxRx: r.speed.maxRx, maxTx: r.speed.maxTx }, { rx: 72, tx: 65, maxRx: 144, maxTx: 144 });
    assert.ok(r.speed.usable > 30 && r.speed.usable < 72, 'a velocidade útil é uma fração da taxa do enlace');
    const lines = r.text.split('\n');
    assert.equal(lines[0], 'Detalhes da conexão Wi-Fi');
    assert.ok(lines.includes('  Nome da rede: Casa'));
    assert.ok(lines.includes('  Máscara de sub-rede: 255.255.252.0 (/22)'));
    assert.ok(lines.includes('  DNS 2: 8.8.8.8'), 'DNS vazio é pulado');
    assert.ok(lines.some((l) => l.startsWith('  Velocidade do enlace (receber): 72')));
    assert.equal(lines[lines.length - 1], 'Gerado no celular pelo WiFi Raio-X.');
    // conexão sem dado nenhum além de "conectado": nada quebra e nada é inventado
    assert.deepEqual(r.bare.groups, [['rede', ['Nome da rede=O Android não informou']]]);
    assert.deepEqual(r.bare.speed, { rx: null, tx: null, maxRx: null, maxTx: null, usable: null });
    assert.equal(/undefined|NaN/.test(r.bare.text), false);
  });
});

test('conexão: todos os campos, agrupados, batem com o que o celular informa', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/conexao' }, async ({ page }) => {
    await waitForScans(page, 1);
    await page.waitForFunction(() => window.__wrx.app.store.get().vendorsReady === true);
    await page.locator('.cnx-hero').waitFor();
    assert.equal(await page.textContent('.topbar__title'), 'Conexão');
    const conn = await page.evaluate(() => window.__wrx.app.bridge.connection());
    const ap = await appState(page, (s) => {
      const a = s.aps.find((x) => x.connected);
      return { vendor: a.vendor, channel: a.channel, band: a.band, widthMHz: a.widthMHz, security: a.security.label };
    });
    const field = (name) => page.textContent(`[data-field="${name}"] .cnx-kv__value`);

    assert.deepEqual(await page.locator('.section-h__title').allTextContents(), ['Rede', 'Sinal e velocidade', 'Endereços', 'Atalhos']);
    assert.equal(await page.textContent('.cnx-hero__name'), conn.ssid);
    assert.match(await page.textContent('.cnx-hero'), /Conectado/);
    assert.match(await page.textContent('.cnx-hero'), /Internet funcionando/);
    assert.match(await page.textContent('.cnx-hero__sub'), new RegExp(`Canal ${ap.channel}`));

    assert.equal(await field('ssid'), conn.ssid);
    assert.equal(await field('bssid'), conn.bssid);
    assert.equal(await field('security'), 'WPA/WPA2 Pessoal', 'o tipo de segurança do Android vira rótulo');
    assert.match(await field('standard'), /^Wi-Fi \d.* \(802\.11/);
    assert.equal(await field('validated'), 'Funcionando');
    assert.equal(await field('metered'), 'Sem limite');
    assert.match(await field('rssi'), new RegExp(`^${MINUS}\\d+\\sdBm · `));
    assert.match(await field('quality'), /^\d+%$/);
    assert.match(await field('distance'), /^≈\s/);
    assert.equal(await field('channel'), String(ap.channel));
    assert.equal(await field('ip'), conn.ip);
    assert.equal(await field('mask'), '255.255.255.0');
    assert.match(await page.textContent('[data-field="mask"]'), /Prefixo \/24: cabem até 254 aparelhos/);
    assert.equal(await field('gateway'), conn.gateway);
    assert.equal(await field('dns0'), conn.dns[0]);
    assert.equal(await field('ipv60'), conn.ipv6[0]);
    assert.match(await field('lease'), /\d+ (horas?|dias?|min)/);
    const all = await screenText(page);
    for (const piece of [ap.vendor, conn.iface, `${conn.mtu}`, 'Largura do canal', 'Frequência', 'Franquia de dados']) assert.ok(all.includes(piece), `falta "${piece}"`);

    // velocidade do enlace contra o máximo que a conexão suporta
    const speed = await page.textContent('.cnx-speed');
    assert.match(speed, /Receber/);
    assert.match(speed, /Enviar/);
    assert.match(speed, /\d+% do máximo desta conexão \(/);
    assert.match(speed, /Na prática, este Wi-Fi entrega cerca de ≈/);
    assert.match(speed, /estimativa/);
    assert.equal(await page.locator('.cnx-speed .meter').count(), 2);

    // o sinal acompanha as leituras ao vivo
    await page.waitForFunction(() => {
      const shown = document.querySelector('[data-field="hero-rssi"]').firstChild.textContent.replace(String.fromCharCode(0x2212), '-');
      return Number(shown) === Math.round(window.__wrx.app.store.get().rssi.rssi);
    });
    await shot(page, 'tools-a-conexao');
    assert.deepEqual(await horizontalOverflow(page), []);
  });
});

test('conexão: tocar copia (um campo, ou tudo pelo botão), e os atalhos funcionam', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/conexao' }, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await waitForScans(page, 1);
    await page.locator('.cnx-hero').waitFor();
    const conn = await page.evaluate(() => window.__wrx.app.bridge.connection());
    const clip = () => page.evaluate(() => navigator.clipboard.readText());

    assert.match(await page.getAttribute('[data-field="ip"]', 'aria-label'), new RegExp(`Copiar IP do celular: ${conn.ip.replace(/\./g, '\\.')}`));
    await page.click('[data-field="ip"]');
    await waitToast(page, /IP do celular: copiado/);
    assert.equal(await clip(), conn.ip);

    await page.click('[data-field="bssid"]');
    await waitToast(page, /BSSID: copiado/);
    assert.equal(await clip(), conn.bssid);

    // "copiar tudo": na barra de cima e no fim da tela
    await page.click('.topbar__actions .icon-btn');
    await waitToast(page, /Detalhes da conexão copiados/);
    const all = await clip();
    assert.match(all, /^Detalhes da conexão Wi-Fi\n/);
    for (const piece of ['Rede', 'Sinal e velocidade', 'Endereços', `Nome da rede: ${conn.ssid}`, `BSSID: ${conn.bssid}`, `IP do celular: ${conn.ip}`, `Roteador (gateway): ${conn.gateway}`, 'Máscara de sub-rede: 255.255.255.0 (/24)', 'Velocidade do enlace (receber): ']) {
      assert.ok(all.includes(piece), `o texto copiado traz "${piece}"`);
    }
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.locator('.cnx-actions .btn').click();
    await page.waitForFunction(async () => (await navigator.clipboard.readText()).startsWith('Detalhes da conexão Wi-Fi'));

    // atalho para o Wi-Fi do sistema: na demonstração só avisa
    await page.locator('.row', { hasText: 'Abrir o Wi-Fi do sistema' }).click();
    await waitToast(page, /Na demonstração não há configurações do Android/);

    // atalho para o medidor
    await page.locator('.row', { hasText: 'Medir o sinal ao vivo' }).click();
    await page.waitForFunction(() => document.querySelector('.view > .screen')?.dataset.screen === 'ferramentas/medidor');
    assert.equal(await page.locator('.topbar__actions .icon-btn').count(), 0, 'o botão de copiar some junto com a tela');
  });
});

test('conexão: sem área de transferência moderna, copia pelo caminho antigo', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/conexao' }, async ({ page }) => {
    await waitForScans(page, 1);
    await page.locator('.cnx-hero').waitFor();
    const conn = await page.evaluate(() => window.__wrx.app.bridge.connection());
    const copied = await page.evaluate(() => {
      window.__copied = [];
      navigator.clipboard.writeText = () => Promise.reject(new DOMException('negado', 'NotAllowedError'));
      document.addEventListener('copy', () => window.__copied.push(document.activeElement.value ?? String(getSelection())));
      return true;
    });
    assert.equal(copied, true);
    await page.click('[data-field="gateway"]');
    await page.waitForFunction(() => /copiado|Não foi possível copiar/.test(document.querySelector('.toast')?.textContent || ''));
    const result = await page.evaluate(() => ({ copied: window.__copied, toast: document.querySelector('.toast').textContent, left: document.querySelectorAll('textarea').length }));
    assert.equal(result.left, 0, 'o campo temporário não fica na página');
    if (/copiado/.test(result.toast)) assert.deepEqual(result.copied, [conn.gateway]);
    else assert.match(result.toast, /Não foi possível copiar aqui/, 'quando nem o caminho antigo funciona, a tela diz');
  });
});

test('conexão: fora do Wi-Fi mostra o convite; avisos de internet e franquia em palavras; nome hostil é texto', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/conexao' }, async ({ page }) => {
    await waitForScans(page, 1);
    await page.locator('.cnx-hero').waitFor();
    const conn = await appState(page, (s) => s.connection);

    // sem internet confirmada, rede com franquia, rede oculta, nome hostil
    await page.evaluate(
      ({ base, name }) => window.__wrx.app.store.setConnection({ ...base, ssid: name, validated: false, metered: true, hidden: true, securityType: 0 }),
      { base: conn, name: HOSTILE },
    );
    await page.waitForFunction((name) => document.querySelector('.cnx-hero__name')?.textContent === name, HOSTILE);
    assert.equal(await page.locator(`${SCREEN} img, ${SCREEN} script`).count(), 0, 'o nome não virou elemento');
    assert.equal(await page.textContent('[data-field="ssid"] .cnx-kv__value'), HOSTILE);
    assert.equal(await page.textContent('[data-field="validated"] .cnx-kv__value'), 'Sem acesso confirmado');
    assert.match(await page.textContent('[data-field="validated"]'), /falha do provedor ou uma rede que pede login/);
    assert.equal(await page.textContent('[data-field="metered"] .cnx-kv__value'), 'Rede com limite');
    assert.equal(await page.textContent('[data-field="security"] .cnx-kv__value'), 'Aberta');
    const hero = await page.textContent('.cnx-hero');
    assert.match(hero, /Sem internet confirmada/);
    assert.match(hero, /Rede com limite de dados/);
    assert.match(await screenText(page), /Rede oculta\s*Sim/);
    await shot(page, 'tools-a-conexao-avisos');

    // conexão sem os campos opcionais (Android antigo): nada de "undefined" nem linhas vazias
    await page.evaluate((base) => window.__wrx.app.store.setConnection({ connected: true, ssid: base.ssid, bssid: base.bssid, rssi: -61, frequency: base.frequency, linkSpeed: 72 }), conn);
    await page.waitForFunction(() => document.querySelectorAll('[data-group="enderecos"]').length === 0);
    const lean = await screenText(page);
    assert.equal(/undefined|NaN|null/.test(lean), false);
    assert.match(await page.textContent('.cnx-speed'), /Enviar/);
    assert.equal(await page.locator('.cnx-speed .meter').count(), 0, 'sem o máximo não há barra');
    assert.deepEqual(await page.locator('.section-h__title').allTextContents(), ['Rede', 'Sinal e velocidade', 'Atalhos']);

    // desconectado
    await page.evaluate(() => window.__wrx.app.store.setConnection({ connected: false }));
    await page.locator('.empty').waitFor();
    assert.equal(await page.textContent('.empty__title'), 'Você não está conectado a um Wi-Fi');
    assert.equal(await page.locator('.cnx-hero').count(), 0);
    assert.equal(await page.locator('.topbar__actions .icon-btn').count(), 0, 'sem conexão não há o que copiar');
    await shot(page, 'tools-a-conexao-desconectado');
    await page.locator('.empty .btn--primary').click();
    await waitToast(page, /Na demonstração não há configurações do Android/);
    await page.locator('.empty .btn--quiet').click();
    await page.waitForFunction(() => location.hash === '#/redes');
  });
});

// ---------------------------------------------------------------------------
// Exportar
// ---------------------------------------------------------------------------

test('exportar: o relatório traz conexão, melhor rede, melhor canal, diagnóstico e redes; compartilhar e copiar', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/exportar' }, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await waitForScans(page, 2);
    await page.locator('.exp-preview__text').waitFor();
    assert.equal(await page.textContent('.topbar__title'), 'Exportar');
    assert.equal((await data(page)).format, 'report');
    await simEval(page, () => 0); // garante o gancho do simulador
    // tudo lido no mesmo instante (a tela se refaz a cada busca)
    const seen = await page.evaluate(() => {
      const s = window.__wrx.app.store.get();
      return {
        aps: s.aps.length,
        nets: s.networks.length,
        ssid: s.connection.ssid,
        title: document.querySelector('.exp-summary__title').textContent,
        preview: document.querySelector('.exp-preview__text').textContent,
      };
    });
    const counts = seen;
    assert.equal(seen.title, `${seen.nets} redes · ${seen.aps} sinais`);
    assert.match(await page.textContent('.exp-summary'), /Lista atualizada (agora|há)/);
    assert.match(await page.textContent('.exp-summary'), /Simulado/);

    const preview = seen.preview;
    const lines = preview.split('\n');
    assert.equal(lines[0], 'WiFi Raio-X - relatório do Wi-Fi');
    assert.match(lines[1], /^\d\d\/\d\d\/\d{4} \d\d:\d\d · modo demonstração \(dados simulados\)$/);
    for (const title of ['Conexão', 'Melhor rede aqui', 'Melhor canal para o roteador', 'Diagnóstico']) assert.ok(lines.includes(title), `seção "${title}"`);
    assert.ok(lines.includes(`Redes ao redor (${counts.nets} redes, ${counts.aps} sinais)`));
    assert.ok(preview.includes(`Rede: "${counts.ssid}"`));
    assert.match(preview, /\n2,4 GHz: .+\n/);
    assert.match(preview, /\n5 GHz: .+\n/);
    assert.match(preview, /Sinal: -\d+ dBm \(/, 'no texto exportado o sinal usa hífen comum');
    assert.equal(preview.includes(MINUS), false);
    assert.ok(preview.includes(`"${HOSTILE}"`), 'o nome hostil aparece como texto, entre aspas');
    assert.equal(await page.locator(`${SCREEN} img, ${SCREEN} script`).count(), 0);
    assert.match(preview, /estimativa/);
    assert.match(await page.textContent('.banner'), /inclusive as dos vizinhos/);
    assert.match(await page.textContent('.banner'), /Nenhuma senha/);
    await shot(page, 'tools-a-exportar-relatorio');

    // compartilhar: o texto vai pela ponte
    await page.locator('.exp-actions .btn', { hasText: 'Compartilhar' }).click();
    await page.waitForFunction(() => window.__e2eSim().device.lastShare !== null);
    const shared = await simEval(page, (sim) => sim.device.lastShare);
    assert.equal(shared.title, 'Relatório do Wi-Fi (WiFi Raio-X)');
    assert.equal(shared.text.split('\n')[0], 'WiFi Raio-X - relatório do Wi-Fi');
    assert.ok(shared.text.includes('Redes ao redor ('));
    assert.ok(shared.text.endsWith('Nada foi enviado para a internet.\n'));

    // copiar
    await page.locator('.exp-actions .btn', { hasText: 'Copiar' }).click();
    await waitToast(page, /Relatório copiado/);
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).split('\n')[0], 'WiFi Raio-X - relatório do Wi-Fi');

    // a prévia inteira num painel
    await page.click('.exp-preview__open');
    await page.locator('.sheet').waitFor();
    assert.equal(await page.textContent('.sheet__title'), 'Relatório em texto');
    assert.ok((await page.textContent('.sheet .exp-preview__text')).includes('Nada foi enviado para a internet.'));
    const cut = await page.evaluate(() => {
      const pre = document.querySelector('.sheet .exp-preview__text');
      const body = document.querySelector('.sheet .sheet__body');
      return { pre: pre.scrollHeight - pre.clientHeight, scrolls: body.scrollHeight > body.clientHeight };
    });
    assert.ok(cut.pre <= 1 && cut.scrolls, 'o relatório inteiro rola dentro do painel');
    assert.equal(await page.locator('.sheet img').count(), 0);
    await shot(page, 'tools-a-exportar-painel');
    assert.equal(await back(page), true);
    await page.locator('.sheet').waitFor({ state: 'detached' });
    assert.deepEqual(await horizontalOverflow(page), []);
  });
});

test('exportar: planilha e JSON saem por bridge.saveFile, com fórmulas neutralizadas e nomes intactos', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/exportar' }, async ({ page }) => {
    await waitForScans(page, 2);
    await page.locator('.exp-preview__text').waitFor();
    // um vizinho com nome de fórmula entra na lista (e as buscas param, para ele não sair)
    const formula = "=cmd|' /C calc'!A0";
    await page.evaluate((ssid) => {
      const { store, scanLoop } = window.__wrx.app;
      scanLoop.setMode('paused');
      const s = store.get();
      const raws = s.aps.map((ap) => ap.raw);
      store.ingestScan({ ts: s.scan.ts + 1, fresh: true, source: 'request', aps: [...raws, { ...raws[0], bssid: '02:11:22:33:44:55', ssid, level: -40, ageMs: 0 }] });
    }, formula);
    const total = await appState(page, (s) => s.aps.length);

    // --- planilha
    await page.locator('.seg__opt', { hasText: 'Planilha' }).click();
    await page.waitForFunction(() => document.querySelector('.view > .screen').dataset.format === 'csv');
    assert.match(await page.textContent('.exp-preview__name'), /^wifi-raio-x-redes-\d{8}-\d{4}\.csv$/);
    assert.match(await page.textContent('.exp-preview__size'), /^[\d,]+ (bytes|kB)$/);
    const csvPreview = await page.textContent('.exp-preview__text');
    assert.ok(csvPreview.startsWith('Nome da rede (SSID);BSSID;Fabricante;Sinal (dBm);'));
    assert.ok(csvPreview.includes(`\n'${formula};02:11:22:33:44:55;`), 'a prévia já mostra o apóstrofo de proteção');
    await shot(page, 'tools-a-exportar-csv');

    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('.exp-actions .btn', { hasText: 'Salvar arquivo' }).click()]);
    assert.match(download.suggestedFilename(), /^wifi-raio-x-redes-\d{8}-\d{4}\.csv$/);
    await waitToast(page, /Na demonstração o arquivo é baixado pelo navegador/);
    const csv = await simEval(page, (sim) => sim.device.lastFile);
    assert.match(csv.name, /^wifi-raio-x-redes-\d{8}-\d{4}\.csv$/);
    assert.equal(csv.mime, 'text/csv');
    assert.equal(csv.text.startsWith(BOM), true, 'o arquivo começa com a marca UTF-8 (acentos certos no Excel)');
    const rows = csv.text.slice(1).split('\r\n');
    assert.equal(rows.length, total + 2, 'cabeçalho + uma linha por sinal + fim de linha final');
    assert.equal(rows[rows.length - 1], '');
    assert.equal(rows.some((r) => /^[=+@]/.test(r)), false, 'nenhuma linha começa com fórmula');
    assert.ok(rows.some((r) => r.startsWith(`'${formula};02:11:22:33:44:55;`)), 'a rede com nome de fórmula está lá, neutralizada');
    assert.ok(rows.some((r) => r.startsWith(`${HOSTILE};`)), 'o nome com <img> vai como texto comum');
    for (const r of rows.slice(1, -1)) assert.match(r, /;([0-9a-f]{2}:){5}[0-9a-f]{2};/);

    // --- JSON
    await page.locator('.seg__opt', { hasText: 'JSON' }).click();
    await page.waitForFunction(() => document.querySelector('.view > .screen').dataset.format === 'json');
    assert.match(await page.textContent('.exp-preview__name'), /\.json$/);
    assert.ok((await page.textContent('.exp-preview__text')).startsWith('{\n  "app": "WiFi Raio-X",'));
    assert.match(await page.textContent('.exp-preview__more'), /e mais \d+ linhas no arquivo/);
    const [download2] = await Promise.all([page.waitForEvent('download'), page.locator('.exp-actions .btn', { hasText: 'Salvar arquivo' }).click()]);
    assert.match(download2.suggestedFilename(), /\.json$/);
    const json = await simEval(page, (sim) => sim.device.lastFile);
    assert.equal(json.mime, 'application/json');
    const parsed = JSON.parse(json.text);
    assert.equal(parsed.app, 'WiFi Raio-X');
    assert.equal(parsed.count, total);
    assert.equal(parsed.networks.length, total);
    assert.ok(parsed.networks.some((n) => n.ssid === formula), 'no JSON o nome vai exatamente como é');
    assert.ok(parsed.networks.some((n) => n.ssid === HOSTILE));
    assert.equal(parsed.device.platform, 'sim');
    assert.equal(parsed.networks.filter((n) => n.connected).length, 1);
    assert.equal('ip' in parsed.connection, false);
    await shot(page, 'tools-a-exportar-json');
    assert.deepEqual(await horizontalOverflow(page), []);
  });
});

test('exportar: quando salvar falha, avisa e oferece copiar; sem redes, estado vazio', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/exportar' }, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await waitForScans(page, 2);
    await page.locator('.exp-preview__text').waitFor();

    // o "celular" recusa criar o arquivo (no simulador: sem Blob o saveFile devolve ok:false)
    await page.locator('.seg__opt', { hasText: 'Planilha' }).click();
    await page.evaluate(() => {
      window.__Blob = window.Blob;
      window.Blob = undefined;
    });
    await page.locator('.exp-actions .btn', { hasText: 'Salvar arquivo' }).click();
    await waitToast(page, /Não foi possível criar o arquivo/);
    await page.evaluate(() => {
      window.Blob = window.__Blob;
    });
    assert.equal(await page.locator('.exp-actions .btn', { hasText: 'Salvar arquivo' }).isEnabled(), true, 'o botão volta a ficar disponível');
    await page.click('.toast__action');
    await waitToast(page, /Conteúdo copiado/);
    assert.ok((await page.evaluate(() => navigator.clipboard.readText())).startsWith('Nome da rede (SSID);BSSID;'));

    // nenhuma rede ao alcance
    await page.evaluate(() => {
      const { store, scanLoop } = window.__wrx.app;
      scanLoop.setMode('paused');
      store.ingestScan({ ts: store.get().scan.ts + 200_000, fresh: true, source: 'request', aps: [] });
    });
    await page.locator('.empty').waitFor();
    assert.equal(await page.textContent('.empty__title'), 'Ainda não há redes para exportar');
    assert.equal((await data(page)).count, '0');
    await shot(page, 'tools-a-exportar-vazio');

    // "buscar agora" traz a lista de volta
    await page.evaluate(() => window.__wrx.app.scanLoop.setMode('normal'));
    await page.locator('.empty .btn--primary').click();
    await page.locator('.exp-preview__text').waitFor({ timeout: 30_000 });
    assert.ok(Number((await data(page)).count) > 3);
  });
});

test('exportar: se as análises opcionais não carregam, o relatório sai sem elas', T, async () => {
  const allow = [/insights\.js/, /best-network\.js/, 'Failed to load resource'];
  const block = async (page) => {
    await page.route('**/js/core/insights.js', (route) => route.abort());
    await page.route('**/js/core/best-network.js', (route) => route.abort());
  };
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/exportar', allow, before: block }, async ({ page }) => {
    await waitForScans(page, 2);
    await page.locator('.exp-preview__text').waitFor();
    const preview = await page.textContent('.exp-preview__text');
    const lines = preview.split('\n');
    assert.ok(lines.includes('Conexão'));
    assert.ok(lines.includes('Melhor canal para o roteador'), 'a recomendação de canal não depende dos módulos opcionais');
    assert.ok(lines.some((l) => l.startsWith('Redes ao redor (')));
    assert.equal(lines.includes('Diagnóstico'), false);
    assert.equal(lines.includes('Melhor rede aqui'), false);
    // planilha e JSON seguem normais
    await page.locator('.seg__opt', { hasText: 'Planilha' }).click();
    await page.waitForFunction(() => document.querySelector('.view > .screen').dataset.format === 'csv');
    assert.ok((await page.textContent('.exp-preview__text')).startsWith('Nome da rede (SSID);'));
  });
});

// ---------------------------------------------------------------------------
// As três juntas
// ---------------------------------------------------------------------------

test('entrar e sair depressa das três ferramentas não deixa nada para trás', T, async () => {
  await withApp(env, { params: FAST }, async ({ page }) => {
    await waitForScans(page, 1);
    const routes = ['/ferramentas/medidor', '/ferramentas/conexao', '/ferramentas/exportar', '/ferramentas/medidor', '/redes', '/ferramentas/exportar', '/ferramentas/conexao', '/ferramentas'];
    // sem esperar: a troca chega enquanto a tela anterior ainda está montando
    for (const route of routes) {
      await page.evaluate((r) => {
        location.hash = `#${r}`;
      }, route);
      await page.waitForTimeout(40);
    }
    await page.waitForFunction(() => document.querySelector('.view > .screen')?.dataset.screen === 'ferramentas');
    await page.waitForTimeout(500);
    const left = await page.evaluate(() => ({
      gauges: document.querySelectorAll('.gauge').length,
      links: document.querySelectorAll('link[data-wrx-css="tools-a"]').length,
      styles: document.querySelectorAll('#wrx-gauge-style').length,
      layers: document.querySelectorAll('.layer').length,
      mode: window.__wrx.app.scanLoop.getState().mode,
      actions: document.querySelector('.topbar__actions').childElementCount,
    }));
    assert.ok(left.links <= 1 && left.styles <= 1, 'folha de estilo e estilo do mostrador entram no máximo uma vez');
    assert.deepEqual({ gauges: left.gauges, layers: left.layers, mode: left.mode, actions: left.actions }, { gauges: 0, layers: 0, mode: 'normal', actions: 0 });
    const rate = await rssiRate(page, 800);
    assert.ok(rate <= 12, `as leituras do sinal voltaram a 1 por segundo simulado (${rate} em 0,8 s a 10x)`);

    // e cada uma abre de novo normalmente
    await goto(page, '/ferramentas/medidor');
    await page.waitForFunction(() => Number(document.querySelector('.view > .screen').dataset.samples) >= 3);
    await goto(page, '/ferramentas/conexao');
    await page.locator('.cnx-hero').waitFor();
    await goto(page, '/ferramentas/exportar');
    await page.locator('.exp-preview__text').waitFor();
    assert.deepEqual(
      await page.evaluate(() => [document.querySelectorAll('link[data-wrx-css="tools-a"]').length, document.querySelectorAll('#wrx-gauge-style').length]),
      [1, 1],
    );
  });
});

test('telas estreitas e tema claro: nada estoura para o lado', T, async () => {
  for (const [viewport, theme] of [
    ['small', 'dark'],
    ['small', 'light'],
    ['landscape', 'dark'],
  ]) {
    await withApp(env, { params: { ...FAST, theme, walk: 'still' }, route: '/ferramentas/medidor', viewport, colorScheme: theme }, async ({ page }) => {
      await waitForScans(page, 2);
      await page.waitForFunction(() => window.__wrx.app.store.get().vendorsReady === true);
      await page.waitForFunction(() => Number(document.querySelector('.view > .screen').dataset.samples) >= 3);
      await page.locator('.mtr-hunt-host .switch').first().click();
      await page.locator('.mtr-trend').waitFor();
      assert.deepEqual(await horizontalOverflow(page), [], `medidor ${viewport} ${theme}`);
      const gauge = await page.evaluate(() => {
        const g = document.querySelector('.mtr-gauge .gauge').getBoundingClientRect();
        const r = document.querySelector('.mtr-gauge .gauge__readout').getBoundingClientRect();
        return { inside: r.left >= g.left && r.right <= g.right && r.top >= g.top && r.bottom <= g.bottom, width: g.width };
      });
      assert.equal(gauge.inside, true, 'o número fica dentro do arco');
      assert.ok(gauge.width <= 340);
      await shot(page, `tools-a-medidor-${viewport}-${theme}`);

      await goto(page, '/ferramentas/conexao');
      await page.locator('.cnx-hero').waitFor();
      assert.deepEqual(await horizontalOverflow(page), [], `conexão ${viewport} ${theme}`);
      await shot(page, `tools-a-conexao-${viewport}-${theme}`);

      await goto(page, '/ferramentas/exportar');
      await page.locator('.exp-preview__text').waitFor();
      for (const label of ['Planilha', 'JSON', 'Relatório']) {
        await page.locator('.seg__opt', { hasText: label }).click();
        await settle(page);
        assert.deepEqual(await horizontalOverflow(page), [], `exportar ${label} ${viewport} ${theme}`);
      }
      await shot(page, `tools-a-exportar-${viewport}-${theme}`);
    });
  }
});
