// WebViews anteriores ao Chrome 84 (o 83 vem de fábrica no Android 11) ignoram `gap` em contêiner
// flex. Visto num aparelho de verdade: cartões, ícones e botões colados uns nos outros. O app carrega
// então css/flex-gap-fallback.css (gerada por tools/flex-gap-fallback.mjs, margens no lugar do gap).
//
// Aqui o Chromium atual faz o papel do WebView antigo: o `gap` de todo contêiner flex é zerado à
// força e a folha de reserva é carregada do jeito que js/polyfills.js faz. Os filhos de cada
// contêiner têm de continuar separados, e nada pode passar da largura da tela.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, withApp, goto, settle, waitForScans, horizontalOverflow } from './helpers.mjs';

const T = { timeout: 120_000 };
const ROUTES = ['/redes', '/canais', '/melhor', '/mapa', '/ferramentas', '/ferramentas/conexao', '/ferramentas/ping', '/ferramentas/exportar', '/ferramentas/ajustes'];

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

/** Zera o `gap` de todo contêiner flex da página (o que o WebView antigo faz, na prática). */
const dropFlexGap = (page) =>
  page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (s.display.includes('flex') && (parseFloat(s.rowGap) > 0 || parseFloat(s.columnGap) > 0)) {
        el.dataset.gapWas = `${parseFloat(s.rowGap) || 0} ${parseFloat(s.columnGap) || 0}`;
        el.style.setProperty('gap', '0px', 'important');
      }
    }
  });

/** Pares de filhos vizinhos (elementos visíveis, no fluxo) que ficaram colados onde havia gap. */
const touching = (page) =>
  page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 1 && r.height >= 1 && s.visibility !== 'hidden' && !/(absolute|fixed)/.test(s.position);
    };
    const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).trim().split(/\s+/).join('.')}`;
    const bad = [];
    let containers = 0;
    for (const el of document.querySelectorAll('[data-gap-was]')) {
      const [rowGap, colGap] = el.dataset.gapWas.split(' ').map(Number);
      const s = getComputedStyle(el);
      const kids = [...el.children].filter(visible);
      if (kids.length < 2 || !visible(el)) continue;
      containers += 1;
      const vertical = s.flexDirection.startsWith('column');
      for (let i = 1; i < kids.length; i += 1) {
        const a = kids[i - 1].getBoundingClientRect();
        const b = kids[i].getBoundingClientRect();
        const sameLine = vertical ? Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 : Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        if (!sameLine) continue; // quebrou de linha
        const want = vertical ? rowGap : colGap;
        const got = vertical ? b.top - a.bottom : b.left - a.right;
        // margens negativas do próprio app podem comer parte do espaço; colado é menos de 1 px
        if (want >= 2 && got < 1) bad.push(`${name(el)}: ${name(kids[i - 1])} | ${name(kids[i])} (${got.toFixed(1)} px, gap ${want})`);
      }
    }
    return { containers, bad };
  });

test('sem gap em flex: a folha de reserva mantém os itens separados em todas as telas', T, async () => {
  await withApp(env, { params: { speed: 10, walk: 'still' }, route: '/redes', viewport: { width: 393, height: 830 } }, async ({ page }) => {
    await waitForScans(page, 2);
    // o Chromium atual tem o recurso: sozinho, o app não carrega a reserva
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('no-flex-gap')), false);
    assert.equal(await page.evaluate(() => !!document.getElementById('wrx-flex-gap-css')), false);

    const loaded = await page.evaluate(async () => {
      const { ensureFlexGap } = await import('./js/polyfills.js');
      const ok = ensureFlexGap(document, true);
      const link = document.getElementById('wrx-flex-gap-css');
      await new Promise((resolve) => (link.sheet ? resolve() : link.addEventListener('load', resolve, { once: true })));
      return { ok, first: document.head.querySelector('link[rel="stylesheet"], style') === link, rules: link.sheet.cssRules.length, marked: document.documentElement.classList.contains('no-flex-gap') };
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.first, true, 'a reserva entra antes das folhas do app');
    assert.equal(loaded.marked, true);
    assert.ok(loaded.rules > 200, `a folha tem as regras (${loaded.rules})`);
    assert.equal(await page.evaluate(async () => (await import('./js/polyfills.js')).ensureFlexGap(document, true)), true, 'chamar de novo não duplica');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#wrx-flex-gap-css').length), 1);

    let total = 0;
    for (const route of ROUTES) {
      await goto(page, route);
      await settle(page);
      await page.waitForTimeout(400);
      await dropFlexGap(page);
      await settle(page);
      const result = await touching(page);
      total += result.containers;
      assert.deepEqual(result.bad, [], `${route}: itens colados mesmo com a folha de reserva`);
      assert.deepEqual(await horizontalOverflow(page), [], `${route}: nada passa da largura da tela`);
    }
    assert.ok(total > 150, `conferiu contêineres de verdade (${total})`);
  });
});

test('sem a folha de reserva os itens ficam colados (o teste acima mede o que diz medir)', T, async () => {
  await withApp(env, { params: { speed: 10, walk: 'still' }, route: '/ferramentas/conexao', viewport: { width: 393, height: 830 } }, async ({ page }) => {
    await waitForScans(page, 1);
    await settle(page);
    await dropFlexGap(page);
    await settle(page);
    const result = await touching(page);
    assert.ok(result.bad.length >= 10, `sem reserva deveria haver dezenas de pares colados (${result.bad.length})`);
  });
});
