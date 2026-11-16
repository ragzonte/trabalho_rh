// Revisão de texto, UX e acessibilidade, de ponta a ponta (a lógica está em tests/review-ux.test.mjs).
//
// Cada teste cita o achado que o motivou (ux-NN). O que eles conferem na tela de verdade:
//   - as instruções do mapa "ponto a ponto" (Android limitando as buscas) não se contradizem;
//   - o cartão "Melhor canal" não afirma do roteador uma largura que ele não usa, e a sugestão de
//     largura não manda usar o que o roteador não anuncia;
//   - o limite de buscas não promete "dá para liberar" num Android sem a opção;
//   - a mesma rede tem a mesma segurança e o mesmo sinal em telas diferentes;
//   - com a letra do sistema ampliada (zoom de texto do WebView) nada sai da tela nem se sobrepõe;
//   - "Wi-Fi" não se parte no hífen; botões lado a lado não vazam da caixa; contraste AA.
//
// Cada teste abre o app numa página nova; fechar a página falha o teste se houve erro,
// console.error, alert(), violação de CSP ou recurso que não carregou.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv, withApp, goto, back, settle, waitForScans, appState, horizontalOverflow } from './helpers.mjs';

const T = { timeout: 180_000 };
const FAST = { speed: 10 };

let env;
before(async () => {
  env = await startEnv();
});
after(async () => {
  await env.close();
});

// ---------------------------------------------------------------------------
// Ajudas (as funções "in page" rodam dentro da página: não usam nada de fora)
// ---------------------------------------------------------------------------

const flat = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const textOf = async (page, selector) => flat(await page.evaluate((s) => (document.querySelector(s) ? document.querySelector(s).innerText : ''), selector));

/**
 * Imita o zoom de texto do WebView (o "tamanho da fonte" do Android): multiplica todo font-size e
 * line-height em px das folhas de estilo, inclusive os tokens --fs-*. Pode ser chamada de novo
 * depois de trocar de tela: só mexe nas regras que ainda não viu (as folhas de cada tela chegam depois).
 */
function inPageTextZoom(factor) {
  const done = (window.__zoomed = window.__zoomed || new WeakSet());
  const scale = (value) => value.replace(/(-?\d*\.?\d+)px/g, (m, n) => `${(parseFloat(n) * factor).toFixed(2)}px`);
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules && rule.type !== 1) {
        visit(rule.cssRules);
        continue;
      }
      if (rule.type !== 1 || done.has(rule)) continue;
      done.add(rule);
      const st = rule.style;
      for (let i = 0; i < st.length; i++) if (/^--fs-/.test(st[i])) st.setProperty(st[i], scale(st.getPropertyValue(st[i])));
      const size = st.getPropertyValue('font-size');
      if (size && /px/.test(size) && !/var\(/.test(size)) st.setProperty('font-size', scale(size), st.getPropertyPriority('font-size'));
      const line = st.getPropertyValue('line-height');
      if (line && /px/.test(line)) st.setProperty('line-height', scale(line), st.getPropertyPriority('line-height'));
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules);
    } catch {
      // folha de outra origem
    }
  }
}
const textZoom = async (page, factor) => {
  await page.evaluate(`(${inPageTextZoom.toString()})(${factor})`);
  await settle(page);
  await page.waitForTimeout(120); // a navegação refaz a conta de "cabe ou não cabe" um quadro depois
  await settle(page);
};

/** A navegação de baixo: itens fora da tela ou com o rótulo vazando da caixa. */
function inPageNavProblems() {
  const out = [];
  const width = window.innerWidth;
  for (const item of document.querySelectorAll('.bottomnav__item')) {
    const r = item.getBoundingClientRect();
    const name = item.textContent.trim();
    if (r.left < -0.5 || r.right > width + 0.5) out.push(`${name}: de ${Math.round(r.left)} a ${Math.round(r.right)} px numa tela de ${width}`);
    if (item.scrollWidth > item.clientWidth + 1) out.push(`${name}: conteúdo de ${item.scrollWidth} px numa caixa de ${item.clientWidth}`);
    const label = item.querySelector('.bottomnav__label');
    const l = label.getBoundingClientRect();
    if (l.width > 2 && (l.left < -0.5 || l.right > width + 0.5)) out.push(`rótulo "${name}" fora da tela`);
  }
  const items = [...document.querySelectorAll('.bottomnav__item')].map((el) => el.getBoundingClientRect());
  for (let i = 1; i < items.length; i++) if (items[i].left < items[i - 1].right - 0.5) out.push(`itens ${i} e ${i + 1} se sobrepõem`);
  return out;
}

/** Texto cortado sem reticências, botões e chips fora da tela ou com o conteúdo maior que a caixa. */
function inPageClipProblems() {
  const out = [];
  const width = window.innerWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const scrolls = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll('#app .btn, #app .chip, #app .pill, .layer .btn, .sheet .btn')) {
    if (!visible(el) || el.closest('.chips--scroll, [data-hscroll]') || scrolls(el)) continue;
    const r = el.getBoundingClientRect();
    const name = el.textContent.trim().slice(0, 40);
    if (r.right > width + 1 || r.left < -1) out.push(`"${name}" sai da tela (${Math.round(r.left)} a ${Math.round(r.right)} px)`);
    const cs = getComputedStyle(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const content = range.getBoundingClientRect().width;
    const inner = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (content > inner + 1) out.push(`"${name}": conteúdo de ${Math.round(content)} px numa caixa de ${Math.round(inner)}`);
  }
  // a linha de estado e o título da barra de cima: se não cabem, têm de terminar em reticências
  for (const el of document.querySelectorAll('.topbar__status, .topbar__title')) {
    if (!visible(el) || el.scrollWidth <= el.clientWidth + 1) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow !== 'ellipsis' || cs.display.includes('flex')) out.push(`${el.className}: "${el.textContent}" cortado sem reticências`);
  }
  const view = document.querySelector('.view');
  if (view && view.scrollWidth > view.clientWidth + 1) out.push(`a tela rola para o lado (${view.scrollWidth} > ${view.clientWidth})`);
  return out;
}

/** Ocorrências de "Wi-Fi" partidas entre duas linhas ("Wi-" / "Fi"). */
function inPageBrokenWifi() {
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue;
    const el = node.parentElement;
    if (!text || !el || el.closest('script, style, noscript, .sr-only, [hidden], pre')) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    for (let at = text.indexOf('Wi-Fi'); at >= 0; at = text.indexOf('Wi-Fi', at + 1)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 5);
      const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
      if (tops.size > 1) out.push(text.slice(Math.max(0, at - 25), at + 20));
    }
  }
  return out;
}

/** Contraste (WCAG) do texto dos elementos de um seletor, contando a opacidade dos antepassados. */
function inPageContrast(selector) {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const background = (el) => {
    const stack = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a >= 1) break;
      }
    }
    let cur = stack.length && stack[stack.length - 1].a >= 1 ? stack.pop() : parse(getComputedStyle(document.body).backgroundColor);
    while (stack.length) cur = blend(stack.pop(), cur);
    return cur;
  };
  const opacity = (el) => {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  };
  const out = [];
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || !el.textContent.trim()) continue;
    const cs = getComputedStyle(el);
    const fg0 = parse(cs.color);
    const bg = background(el);
    const fg = blend({ ...fg0, a: fg0.a * opacity(el) }, bg);
    const la = lum(fg);
    const lb = lum(bg);
    out.push({ text: el.textContent.trim().slice(0, 30), ratio: Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100, size: parseFloat(cs.fontSize) });
  }
  return out;
}

const run = (page, fn, arg) => page.evaluate(`(${fn.toString()})(${JSON.stringify(arg ?? null)})`);

/** Põe no armazenamento do app um mapa pronto, feito de um levantamento simulado (como em map.e2e.mjs). */
function seedMap(page) {
  return page.evaluate(async () => {
    const { presetWorld } = await import('./js/sim/presets.js');
    const { planWalk, simulateSurvey } = await import('./js/sim/walk.js');
    const { createMapEngine } = await import('./js/mapping/engine.js');
    const { openMapStore } = await import('./js/mapping/storage.js');
    const w = presetWorld('apartamento', 1);
    const { survey } = simulateSurvey(w, planWalk(w, { kind: 'spots' }), { labelRate: 1 });
    const own = w.aps.filter((a) => a.own).map((a) => a.bssid);
    const engine = createMapEngine();
    const out = await engine.run(survey, { own });
    engine.dispose();
    const store = await openMapStore();
    const id = await store.put({ name: 'Casa de teste', survey, solution: out.solution, own, meta: { ownSsids: [...new Set(w.aps.filter((a) => a.own).map((a) => a.ssid))] }, stats: { areaM2: out.model.quality.areaM2, level: out.model.quality.level }, demo: true });
    store.close();
    return id;
  });
}

// ---------------------------------------------------------------------------
// As sondas: antes de confiar num "nenhum problema", conferem-se num defeito feito de propósito
// ---------------------------------------------------------------------------

test('as sondas destes testes enxergam os defeitos que procuram', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/ferramentas/sobre', viewport: 'small' }, async ({ page }) => {
    await page.waitForSelector('.view .prose');
    assert.deepEqual(await run(page, inPageBrokenWifi), []);
    assert.deepEqual(await run(page, inPageClipProblems), []);
    await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'probe-defects';
      const add = (tag, className, text, style) => {
        const el = document.createElement(tag);
        el.className = className;
        el.textContent = text;
        Object.assign(el.style, style);
        host.appendChild(el);
        return el;
      };
      // "Wi-Fi" numa caixa em que só cabe "Wi-": quebra no hífen
      add('p', 'probe-wifi', 'Wi-Fi', { width: '3ch', fontFamily: 'monospace', fontSize: '16px' });
      // o mesmo texto protegido por .nb: não quebra
      const safe = add('p', 'probe-wifi-nb', '', { width: '3ch', fontFamily: 'monospace', fontSize: '16px' });
      const span = document.createElement('span');
      span.className = 'nb';
      span.textContent = 'Wi-Fi';
      safe.appendChild(span);
      // botão estreito demais para o rótulo
      add('button', 'btn btn--secondary probe-btn', 'Rótulo comprido demais para a caixa', { width: '80px', minWidth: '0' });
      // texto opaco demais para ler
      add('span', 'probe-faint', 'quase invisível', { opacity: '0.3' });
      document.querySelector('.view').prepend(host);
    });
    const broken = await run(page, inPageBrokenWifi);
    assert.equal(broken.length, 1, JSON.stringify(broken));
    const clipped = await run(page, inPageClipProblems);
    assert.ok(clipped.some((line) => /Rótulo comprido demais/.test(line) && /conteúdo de \d+ px numa caixa de/.test(line)), JSON.stringify(clipped));
    const [faint] = await run(page, inPageContrast, '#probe-defects .probe-faint');
    assert.ok(faint.ratio < 3, `contraste do texto apagado: ${faint.ratio}`);
    // a navegação com um rótulo que não cabe: a sonda acusa (sem a rede de segurança do modo compacto)
    await page.evaluate(() => {
      const nav = document.querySelector('.bottomnav');
      nav.style.width = '220px';
      for (const label of nav.querySelectorAll('.bottomnav__label')) label.style.whiteSpace = 'nowrap';
      for (const item of nav.querySelectorAll('.bottomnav__item')) item.style.flex = 'none';
    });
    assert.ok((await run(page, inPageNavProblems)).length > 0);
  });
});

// ---------------------------------------------------------------------------
// ux-01: mapa "ponto a ponto"
// ---------------------------------------------------------------------------

test('ux-01: com o Android limitando as buscas, as instruções do mapa são as do ponto a ponto, com quantos lugares marcar', T, async () => {
  await withApp(env, { params: { world: 'apartamento', throttle: 1, speed: 10, walk: 'auto' }, route: '/mapa', viewport: 'small' }, async ({ page }) => {
    await page.waitForSelector('.mlib-hero');
    await page.waitForFunction(() => window.__wrx.app.store.get().loop.throttled === true, null, { timeout: 60_000 });
    await page.click('.mlib-hero .btn');
    await page.waitForSelector('.map-start');

    // o passo inicial: nada de "a cada poucos segundos" / "siga andando" ao lado do aviso de 30 s
    const start = await textOf(page, '.sheet');
    assert.match(start, /ponto a ponto/);
    assert.match(start, /uma leitura a cada 30 segundos/);
    assert.doesNotMatch(start, /a cada poucos segundos|siga andando|Ande devagar/);
    assert.match(start, /Marque pelo menos 12 lugares/);
    assert.match(start, /2 ou 3 por cômodo/);
    assert.match(await textOf(page, '.sheet__subtitle'), /Leva de 6 a \d+ minutos/, 'o tempo prometido fecha com 12 lugares × 30 s');
    assert.equal(await page.locator('.map-tip').count(), 3);
    await page.click('.sheet__footer .btn--primary');

    // no levantamento: o radar não manda "continuar andando" e o contador mostra o progresso
    await page.waitForSelector('.msv');
    assert.doesNotMatch(await textOf(page, '.msv-preview'), /Continue andando|você anda/);
    assert.match(await textOf(page, '.msv-radar__sub'), /a cada lugar marcado|Vá ao próximo lugar e marque|aparece com 5 leituras/);
    assert.equal(await textOf(page, '.msv-count__of'), 'de 12');
    assert.match(await textOf(page, '.msv__bar-note'), /marque pelo menos 12 lugares|faltam \d+ lugares marcados \(uma leitura em cada; vale mais de um por cômodo\)/);
    // o número continua sozinho no elemento de sempre (é o que os outros testes leem)
    assert.match(await page.textContent('.msv-count:nth-child(2) .msv-count__value'), /^\d+$/);

    // um lugar marcado: o contador anda e o texto continua sem mandar andar
    await page.click('.msv__bar .btn--primary');
    await page.locator('.msv-mark__chips .chip', { hasText: 'Sala' }).click();
    await page.waitForFunction(() => /Pode seguir/.test(document.querySelector('.msv-status__detail')?.textContent || ''), null, { timeout: 60_000 });
    await page.click('.msv__bar .btn--primary');
    await page.waitForSelector('.msv-status[data-state="walking"]');
    assert.equal(await page.textContent('.msv-count:nth-child(2) .msv-count__value'), '1');
    assert.match(await textOf(page, '.msv__bar-note'), /faltam 11 lugares marcados \(uma leitura em cada; vale mais de um por cômodo\)/);
    assert.doesNotMatch(await textOf(page, '.msv'), /Continue andando/);
    assert.deepEqual(await horizontalOverflow(page), []);

    // "Como fazer um bom mapa": as dicas do ponto a ponto
    await page.click('[aria-label="Mais opções do mapeamento"]');
    await page.locator('.sheet .row', { hasText: 'Como fazer um bom mapa' }).click();
    await page.waitForSelector('.sheet .map-tip');
    const tips = await textOf(page, '.sheet');
    assert.match(tips, /Marque pelo menos 12 lugares/);
    assert.doesNotMatch(tips, /Ande devagar|caminho andado/);
    await back(page);

    // o limite some no meio do levantamento (o usuário desligou a chave): os textos voltam aos de caminhada
    await page.evaluate(async () => {
      const mod = await import('./js/sim/backend.js');
      mod.currentSim().setState({ throttle: false });
    });
    await page.waitForFunction(() => window.__wrx.app.store.get().loop.throttled === false, null, { timeout: 90_000 });
    await page.waitForFunction(() => !document.querySelector('.msv-count__of'), null, { timeout: 20_000 });
    assert.doesNotMatch(await textOf(page, '.msv__bar-note'), /uma leitura em cada/);
  });
});

// ---------------------------------------------------------------------------
// ux-02 e ux-03: canais em 5 GHz
// ---------------------------------------------------------------------------

test('ux-02: o seletor de largura muda o ranking, não o que o cartão "Melhor canal" diz do roteador', T, async () => {
  await withApp(env, { params: { ...FAST, world: 'apartamento', walk: 'still' }, route: '/canais?band=5' }, async ({ page }) => {
    await waitForScans(page, 2);
    await page.waitForSelector('.ch-rec[data-verdict]');
    const own = await appState(page, (s) => {
      const ap = s.aps.find((a) => a.connected);
      return { channel: ap.channel, width: ap.widthMHz };
    });
    assert.equal(own.width, 80);
    const card = async () => ({ verdict: await page.getAttribute('.ch-rec', 'data-verdict'), title: await textOf(page, '.ch-rec__title'), text: await textOf(page, '.ch-rec__text') });
    const real = await card();
    assert.match(real.text, new RegExp(`Seu roteador está no canal ${own.channel} \\(80.MHz\\)`));
    assert.equal(await page.locator('.ch-width__whatif').count(), 0);

    for (const width of [20, 40]) {
      await page.click(`.ch-widthopt[data-width="${width}"]`);
      await settle(page);
      assert.equal(await page.getAttribute(`.ch-widthopt[data-width="${width}"]`, 'aria-checked'), 'true');
      // o ranking segue o seletor...
      assert.match(await textOf(page, '.ch-rank__head'), width > 20 ? new RegExp(`Ranking dos canais de ${width}.MHz`) : /Ranking dos canais \d/);
      // ...o cartão, não: mesma frase, mesmo veredito, e nunca uma largura que o roteador não usa
      const now = await card();
      assert.equal(now.verdict, real.verdict, `${width} MHz`);
      assert.equal(now.title, real.title, `${width} MHz`);
      const cited = now.text.match(/Seu roteador está no canal \d+(?: \((\d+).MHz\))?/);
      assert.ok(cited, now.text);
      assert.equal(Number(cited[1] || 20), own.width, now.text);
      assert.match(await textOf(page, '.ch-own__label'), /80.MHz/);
      // e a tela diz que o ranking é um "e se"
      assert.match(await textOf(page, '.ch-width__whatif'), new RegExp(`como ficaria em ${width}.MHz.*continua valendo para os 80.MHz`));
      const tags = await page.$$eval('.ch-rank__row .badge', (els) => els.map((el) => el.textContent));
      assert.ok(tags.includes('Mais livre') && !tags.includes('Recomendado') && !tags.includes('Melhor'), tags.join(', '));
    }
    await page.click('.ch-widthopt[data-width="80"]');
    await settle(page);
    assert.equal(await page.locator('.ch-width__whatif').count(), 0);
    assert.deepEqual(await horizontalOverflow(page), []);
  });
});

test('ux-03: a largura sugerida não manda usar 160 MHz num roteador que usa (e só anuncia) 80', T, async () => {
  await withApp(env, { params: { ...FAST, world: 'apartamento', walk: 'still' }, route: '/canais?band=5' }, async ({ page }) => {
    await waitForScans(page, 2);
    await page.waitForSelector('.ch-advice');
    // com o roteador conhecido: nada de "Use 160 MHz" ao lado de "Pode ficar no canal..."
    const advice = await textOf(page, '.ch-advice');
    assert.doesNotMatch(advice, /^Use 160/);
    assert.doesNotMatch(advice, /160/);
    assert.match(await textOf(page, '.ch-width__now'), /Seu roteador usa 80.MHz hoje: já é a largura sugerida\./);
    // 160 MHz fica indisponível, e o motivo é o que o roteador anuncia (não "a geração do Wi-Fi")
    assert.equal(await page.getAttribute('.ch-widthopt[data-width="160"]', 'aria-disabled'), 'true');
    await page.click('.ch-widthopt[data-width="160"]', { force: true });
    await page.locator('.toast', { hasText: 'O seu roteador não anuncia suporte a 160' }).waitFor();

    // sem saber qual é o roteador: 160 MHz aparece como possibilidade, com a condição e o risco do DFS
    await page.evaluate(() => window.__wrx.app.store.setConnection({ connected: false }));
    await page.waitForSelector('.ch-rec[data-verdict="general"]');
    const general = await textOf(page, '.ch-advice');
    assert.match(general, /^Há espaço para 160.MHz: /);
    assert.match(general, /Só vale se o roteador e os aparelhos aceitarem essa largura\./);
    assert.match(general, /DFS, divididos com radares: o roteador pode demorar a entrar no ar ou trocar de canal sozinho/);
    assert.equal(await page.getAttribute('.ch-widthopt[data-width="160"]', 'aria-disabled'), null);
    await page.click('.ch-widthopt[data-width="160"]');
    await settle(page);
    assert.match(await textOf(page, '.ch-rank__head'), /Ranking dos canais de 160.MHz/);
    assert.ok((await page.locator('.ch-rank__row').count()) >= 2);
  });
});

// ---------------------------------------------------------------------------
// ux-04: canais 12 e 13
// ---------------------------------------------------------------------------

test('ux-04: os canais 12 e 13 não são explicados como "entre os canais padrão"', T, async () => {
  await withApp(env, { params: { ...FAST, world: 'apartamento', walk: 'still' }, route: '/canais?band=2.4' }, async ({ page }) => {
    await waitForScans(page, 2);
    await page.waitForSelector('.ch-more .btn');
    await page.click('.ch-more .btn');
    const others = await textOf(page, '.ch-others');
    assert.doesNotMatch(others, /Ficam entre os canais padrão/);
    assert.match(others, /o 12 e o 13 ainda invadem o 11/);
    await page.click('.ch-rank__row[data-channel="13"]');
    await page.locator('.sheet').waitFor();
    const sheet13 = await textOf(page, '.sheet__body');
    assert.match(sheet13, /acima dele: um roteador aqui ainda invade o canal 11/);
    assert.doesNotMatch(sheet13, /dois canais padrão ao mesmo tempo/);
    await back(page);
    await page.click('.ch-rank__row[data-channel="9"]');
    await page.locator('.sheet').waitFor();
    assert.match(await textOf(page, '.sheet__body'), /dois canais padrão ao mesmo tempo/);
  });
});

// ---------------------------------------------------------------------------
// ux-05: limite de buscas num Android sem a chave
// ---------------------------------------------------------------------------

test('ux-05: num Android 9 nenhuma tela promete liberar as buscas; do 10 em diante, o passo a passo com o nome da chave', T, async () => {
  await withApp(env, { params: { ...FAST, throttle: 1 } }, async ({ page }) => {
    await waitForScans(page, 1);
    const tip = page.locator('.screen .banner', { hasText: 'O Android está limitando as buscas' });
    await tip.waitFor();
    // simulador (versão desconhecida): o comportamento de sempre, com o nome que o Android usa
    assert.match(flat(await tip.textContent()), /Dá para liberar buscas mais rápidas nas opções do desenvolvedor/);
    await tip.getByRole('button', { name: 'Como liberar' }).click();
    await page.locator('.sheet').waitFor();
    const help = await textOf(page, '.sheet');
    assert.match(help, /“Limitar busca por Wi-Fi”/);
    assert.match(help, /toque 7 vezes em "Número da versão"/);
    assert.ok(await page.locator('.sheet__footer .btn', { hasText: 'Abrir opções' }).count());
    await back(page);

    // o mesmo aparelho, agora um Android 9 (API 28): a chave não existe
    await page.evaluate(() => {
      const store = window.__wrx.app.store;
      store.setInfo({ ...store.get().info, sdk: 28, release: '9' });
    });
    await goto(page, '/canais');
    const tip9 = page.locator('.screen .banner', { hasText: 'O Android está limitando as buscas' });
    await tip9.waitFor();
    assert.match(flat(await tip9.textContent()), /Nesta versão do Android não dá para desligar esse limite/);
    assert.doesNotMatch(flat(await tip9.textContent()), /Dá para liberar/);
    assert.equal(await tip9.getByRole('button', { name: 'Como liberar' }).count(), 0);

    await goto(page, '/ferramentas/ajustes');
    const why = page.locator('.view .btn', { hasText: 'Por que o Android limita as buscas' });
    await why.waitFor();
    assert.equal(await page.locator('.view .btn', { hasText: 'Como liberar' }).count(), 0);
    await why.click();
    await page.locator('.sheet').waitFor();
    const help9 = await textOf(page, '.sheet');
    assert.match(help9, /Nesta versão do Android não dá para desligar esse limite/);
    assert.doesNotMatch(help9, /Abrir opções|toque 7 vezes|Limitar busca/);
    assert.equal(await page.locator('.sheet .steps').count(), 0);
    await back(page);

    await goto(page, '/mapa');
    await page.click('.mlib-hero .btn');
    await page.waitForSelector('.map-start .banner');
    assert.match(await textOf(page, '.map-start .banner'), /Nesta versão do Android não dá para desligar esse limite/);
    assert.equal(await page.locator('.map-start .banner .btn').count(), 0);
  });
});

// ---------------------------------------------------------------------------
// ux-06, ux-08 e ux-09: a mesma informação em telas diferentes
// ---------------------------------------------------------------------------

test('ux-06 e ux-09: segurança, sinal e velocidade da mesma rede dizem a mesma coisa em telas diferentes', T, async () => {
  await withApp(env, { params: { ...FAST, world: 'apartamento', walk: 'still' } }, async ({ page }) => {
    await waitForScans(page, 2);
    await page.waitForSelector('.net-row--connected');
    // Redes: o selo de segurança da rede conectada
    const listed = await appState(page, (s) => s.aps.find((a) => a.connected).security.label);
    assert.match(await textOf(page, '.net-row--connected .net-row__what'), new RegExp(`^${listed.replace('/', '\\/')}\\b`));

    // Conexão: o mesmo rótulo (e não "WPA/WPA2 Pessoal", o tipo genérico que o Android informa)
    await goto(page, '/ferramentas/conexao');
    await page.waitForSelector('[data-field="security"]');
    const shown = await textOf(page, '[data-field="security"] .cnx-kv__value');
    assert.equal(shown, listed);
    // ux-09: "≈" já é aproximação; e a conta diz de onde vem
    const usable = await textOf(page, '.cnx-speed__usable');
    assert.doesNotMatch(usable, /cerca de\s*≈/);
    assert.match(usable, /pela velocidade negociada agora, este Wi-Fi entrega ≈/);
    assert.equal(await textOf(page, '.cnx-speed .card__title'), 'Velocidade até o roteador');

    // Melhor Wi-Fi > painel da nota: a parte "Sinal" e a linha do sinal mostram o mesmo número
    await goto(page, '/melhor');
    await page.waitForSelector('.best-row');
    await page.locator('.best-row').first().click();
    await page.waitForSelector('.sheet .best-part');
    const dbm = (text) => (text.match(/(−\d+)\s*dBm/) || [])[1];
    const part = dbm(await textOf(page, '.sheet .best-part__headline'));
    const row = dbm(await textOf(page, '.sheet .best-ap'));
    assert.ok(part && row, `${part} / ${row}`);
    assert.equal(row, part, 'a linha do sinal usa a mesma leitura que a nota');
    assert.match(await textOf(page, '.sheet'), /Sinal desta rede|Sinais desta rede/);
  });
});

test('ux-08 e ux-13: Sobre e Dispositivos citam o mesmo Android; os destinos da latência dizem quem responde', T, async () => {
  await withApp(env, { params: FAST, route: '/ferramentas/sobre' }, async ({ page }) => {
    await page.waitForSelector('.view .prose');
    const about = await textOf(page, '.view');
    assert.match(about, /o Android 10 ou mais novo esconde o endereço físico \(MAC\)/);
    assert.match(about, /A partir do Android 10 dá para desligar o limite/);
    await goto(page, '/ferramentas/dispositivos');
    await page.waitForFunction(() => /do 10 em diante/.test(document.querySelector('.view').textContent), null, { timeout: 60_000 });
    await goto(page, '/ferramentas/ping');
    await page.waitForSelector('.tb-setup .chip');
    const chips = await page.$$eval('.tb-setup .chip', (els) => els.map((el) => el.textContent.trim()));
    assert.ok(chips.includes('Internet (Cloudflare)') && chips.includes('Internet (Google)'), chips.join(' | '));
    assert.ok(!chips.includes('Internet 2'));
  });
});

// ---------------------------------------------------------------------------
// ux-07: letra do sistema ampliada
// ---------------------------------------------------------------------------

test('ux-07: com o texto 30% maior (zoom de texto do Android), em 360 px nada sai da tela nem se sobrepõe', T, async () => {
  await withApp(env, { params: { ...FAST, throttle: 1, walk: 'still' }, viewport: 'small' }, async ({ page }) => {
    await waitForScans(page, 2);
    // sem zoom: a navegação é a de sempre (64 px, cinco rótulos numa linha)
    assert.equal(await page.$eval('.bottomnav', (el) => Math.round(el.getBoundingClientRect().height)), 64);
    assert.deepEqual(await run(page, inPageNavProblems), []);
    assert.equal(await page.$eval('.bottomnav', (el) => el.hasAttribute('data-compact')), false);

    for (const route of ['/redes', '/melhor', '/canais', '/ferramentas/dispositivos', '/ferramentas/ajustes', '/ferramentas/exportar', '/ferramentas/conexao']) {
      await goto(page, route);
      await textZoom(page, 1.3);
      if (route === '/ferramentas/dispositivos') await page.waitForSelector('.tb-dev', { timeout: 60_000 });
      await settle(page);
      assert.deepEqual(await run(page, inPageNavProblems), [], `navegação em ${route}`);
      assert.deepEqual(await run(page, inPageClipProblems), [], `texto e botões em ${route}`);
    }
    // os cinco rótulos continuam à vista (o de duas palavras quebra em duas linhas)
    assert.equal(await page.$eval('.bottomnav', (el) => el.hasAttribute('data-compact')), false);
    assert.ok((await page.$eval('.bottomnav', (el) => el.getBoundingClientRect().height)) > 64, 'a barra cresce para caber o rótulo em duas linhas');
    const icons = await page.$$eval('.bottomnav__icon', (els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
    assert.equal(new Set(icons).size, 1, `os ícones ficam alinhados: ${icons.join(', ')}`);

    // Redes: a velocidade quebra entre as duas direções em vez de invadir a célula da distância
    await goto(page, '/redes');
    await page.waitForSelector('.net-conn__rate');
    const cells = await page.evaluate(() => {
      const [speed, distance] = [...document.querySelectorAll('.net-conn__stat')].map((el) => el.getBoundingClientRect());
      const rates = [...document.querySelectorAll('.net-conn__rate')].map((el) => el.getBoundingClientRect());
      return { speedRight: speed.right, distanceLeft: distance.left, ratesRight: Math.max(...rates.map((r) => r.right)) };
    });
    assert.ok(cells.ratesRight <= cells.speedRight + 0.5, `a velocidade (até ${Math.round(cells.ratesRight)} px) fica na célula dela (até ${Math.round(cells.speedRight)} px)`);

    // Dispositivos: o tipo do aparelho aparece inteiro (antes virava "…")
    await goto(page, '/ferramentas/dispositivos');
    await page.waitForSelector('.tb-dev .tb-sub__flex', { timeout: 60_000 });
    const types = await page.$$eval('.tb-dev .tb-sub__flex', (els) => els.map((el) => ({ text: el.textContent, cut: el.scrollWidth > el.clientWidth + 1, width: Math.round(el.getBoundingClientRect().width) })));
    assert.ok(types.length > 0);
    for (const t of types) assert.ok(!t.cut || t.width > 60, `"${t.text}" cortado em ${t.width} px`);
  });
});

test('ux-07: com o texto no dobro do tamanho a navegação fica compacta, e as cinco abas continuam na tela e com nome', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, viewport: 'small' }, async ({ page }) => {
    await waitForScans(page, 1);
    await textZoom(page, 2);
    await page.waitForFunction(() => document.querySelector('.bottomnav').hasAttribute('data-compact'));
    assert.deepEqual(await run(page, inPageNavProblems), []);
    // só a aba atual mostra o rótulo; as outras continuam com nome para o leitor de tela
    const labels = await page.$$eval('.bottomnav__item', (els) => els.map((el) => ({ name: el.textContent.trim(), current: el.getAttribute('aria-current') === 'page', shown: el.querySelector('.bottomnav__label').getBoundingClientRect().width > 2 })));
    assert.deepEqual(labels.map((l) => l.name), ['Redes', 'Canais', 'Melhor Wi-Fi', 'Mapa 3D', 'Ferramentas']);
    assert.deepEqual(labels.filter((l) => l.shown).map((l) => l.name), ['Redes']);
    // trocar de aba: o rótulo acompanha
    await page.click('.bottomnav__item[data-tab="ferramentas"]');
    await page.waitForFunction(() => document.querySelector('.bottomnav__item[data-tab="ferramentas"] .bottomnav__label').getBoundingClientRect().width > 2);
    await settle(page);
    assert.deepEqual(await run(page, inPageNavProblems), []);
  });
});

// ---------------------------------------------------------------------------
// ux-10: "Wi-Fi" inteiro
// ---------------------------------------------------------------------------

test('ux-10: "Wi-Fi" não se parte no hífen, nem no título da primeira tela', T, async () => {
  for (const viewport of [{ width: 360, height: 740 }, { width: 412, height: 915 }]) {
    // a primeira abertura, sem a permissão
    for (const params of [{ permission: 'denied' }, { permission: 'blocked' }, { wifi: 0 }]) {
      await withApp(env, { params, viewport }, async ({ page }) => {
        await page.waitForSelector('.gate__title');
        assert.deepEqual(await run(page, inPageBrokenWifi), [], `${viewport.width} px ${JSON.stringify(params)}`);
        if (params.permission === 'denied') {
          // o título da primeira tela: "Wi-Fi" protegido, e o texto continua o mesmo, com o hífen comum
          assert.equal(await page.textContent('.gate__title'), 'Vamos ver o Wi-Fi ao seu redor');
          assert.equal(await page.locator('.gate__title .nb').count(), 1);
          assert.equal(await page.$eval('.gate__title .nb', (el) => getComputedStyle(el).whiteSpace), 'nowrap');
        }
      });
    }
    await withApp(env, { params: { ...FAST, throttle: 1 }, viewport }, async ({ page }) => {
      await waitForScans(page, 1);
      for (const route of ['/redes', '/melhor', '/mapa', '/ferramentas', '/ferramentas/sobre', '/ferramentas/ajustes', '/ferramentas/velocidade']) {
        await goto(page, route);
        assert.deepEqual(await run(page, inPageBrokenWifi), [], `${viewport.width} px ${route}`);
      }
      // a navegação e os painéis
      assert.equal(await page.textContent('.bottomnav__item[data-tab="melhor"] .bottomnav__label'), 'Melhor Wi-Fi');
      assert.equal(await page.locator('.bottomnav__item[data-tab="melhor"] .nb').count(), 1);
      await page.click('.pill');
      await page.locator('.sheet').waitFor();
      assert.deepEqual(await run(page, inPageBrokenWifi), [], `${viewport.width} px painel da demonstração`);
    });
  }
});

// ---------------------------------------------------------------------------
// ux-11: botões lado a lado
// ---------------------------------------------------------------------------

test('ux-11: botões lado a lado não vazam da caixa nem cortam o ícone (360 e 412 px)', T, async () => {
  for (const viewport of ['small', 'phone']) {
    await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/melhor', viewport, colorScheme: 'light' }, async ({ page }) => {
      await waitForScans(page, 2);
      await page.locator('.view .btn, .view button', { hasText: 'Entenda a nota' }).first().click();
      await page.locator('.sheet__footer .btn', { hasText: 'Testar a velocidade' }).waitFor();
      assert.deepEqual(await run(page, inPageClipProblems), [], `${viewport}: painel da nota`);
      await back(page);

      await goto(page, '/canais');
      await page.locator('.view .row', { hasText: 'Como mudar o canal do roteador' }).click();
      await page.locator('.sheet').waitFor();
      await settle(page);
      assert.deepEqual(await run(page, inPageClipProblems), [], `${viewport}: como mudar o canal`);
      await back(page);

      await goto(page, '/ferramentas/exportar');
      await page.waitForSelector('.exp-actions .btn');
      assert.deepEqual(await run(page, inPageClipProblems), [], `${viewport}: exportar`);

      // resultado do mapa > qualidade: "Continuar mapeando" cabe (ou desce para a linha de baixo)
      const id = await seedMap(page);
      await goto(page, `/mapa/ver/${id}`);
      await page.waitForSelector('.mrs:not([hidden]) .mrs__stage canvas', { timeout: 120_000 });
      await page.locator('.mrs button', { hasText: 'Cobertura, qualidade e ações' }).click();
      const keepGoing = page.locator('.mrs-card__actions .btn', { hasText: 'Continuar mapeando' }).last();
      await keepGoing.scrollIntoViewIfNeeded();
      await settle(page);
      assert.ok(await keepGoing.isVisible(), 'o cartão "Qualidade do mapa" está à vista');
      assert.deepEqual(await run(page, inPageClipProblems), [], `${viewport}: resultado do mapa`);
    });
  }
});

// ---------------------------------------------------------------------------
// ux-12 e ux-16: resultado do mapa
// ---------------------------------------------------------------------------

test('ux-12 e ux-16: a legenda explica o riscado e o caminho; a vista de cima não se chama "planta"', T, async () => {
  await withApp(env, { params: { ...FAST, walk: 'still' }, route: '/mapa' }, async ({ page }) => {
    await page.waitForSelector('.mlib-hero');
    const id = await seedMap(page);
    await goto(page, `/mapa/ver/${id}`);
    await page.waitForSelector('.mrs:not([hidden]) .mrs__stage canvas', { timeout: 120_000 });
    await page.waitForSelector('.mrs-legend-notes');

    // ux-12: o piso riscado sempre; o caminho só com a camada ligada
    assert.match(await textOf(page, '.mrs-legend-notes'), /Riscado: trecho estimado, sem leitura por perto/);
    const pathOn = await page.getAttribute('.chip[data-layer="path"]', 'aria-pressed');
    const hasPathNote = async () => (await page.locator('.mrs-legend-note[data-note="path"]').count()) === 1;
    assert.equal(await hasPathNote(), pathOn === 'true');
    await page.evaluate(() => document.querySelector('.chip[data-layer="path"]').click());
    await settle(page);
    assert.equal(await hasPathNote(), pathOn !== 'true', 'a nota do caminho acompanha a camada');
    if (await hasPathNote()) assert.match(await textOf(page, '.mrs-legend-note[data-note="path"]'), /Caminho: azul no começo, rosa no fim/);
    // as amostras usam as cores do desenho
    assert.match(await page.$eval('.mrs-legend-note[data-note="hatch"] .mrs-legend-note__swatch', (el) => getComputedStyle(el).backgroundImage), /repeating-linear-gradient/);
    // a legenda vale também com o sinal de uma rede
    await page.locator('.mrs-show .chip').nth(1).click();
    await settle(page);
    assert.match(await textOf(page, '.mrs-legend-notes'), /Riscado/);

    // ux-16: "De cima", não "Planta"
    const views = await page.$$eval('.mrs-tools__view .seg__opt', (els) => els.map((el) => el.textContent.trim()));
    assert.deepEqual(views, ['3D', 'De cima']);
    assert.doesNotMatch(await textOf(page, '.mrs'), /\bPlanta\b|Vista em planta/);
    assert.deepEqual(await horizontalOverflow(page), []);
  });
});

// ---------------------------------------------------------------------------
// ux-14: contraste
// ---------------------------------------------------------------------------

test('ux-14: rede não ouvida na última busca, selo "bom" e nome do arquivo com contraste e tamanho de leitura', T, async () => {
  for (const colorScheme of ['dark', 'light']) {
    await withApp(env, { params: { ...FAST, walk: 'still' }, colorScheme }, async ({ page }) => {
      await waitForScans(page, 2);
      await page.waitForSelector('.net-row');
      // três redes somem de uma lista que chega 15 s depois: as linhas delas ficam "velhas" (não ouvidas há mais de 10 s)
      await page.evaluate(async () => {
        const app = window.__wrx.app;
        const ev = await app.bridge.lastScan();
        const connected = app.store.get().connection.bssid;
        const gone = ev.aps.filter((a) => a.bssid !== connected).slice(-3).map((a) => a.bssid);
        app.store.ingestScan({ ...ev, ts: Date.now() + 15_000, fresh: true, source: 'request', aps: ev.aps.filter((a) => !gone.includes(a.bssid)) });
      });
      await page.waitForSelector('.net-row.row--stale', { timeout: 30_000 });
      const stale = await run(page, inPageContrast, '.net-row.row--stale .row__title .ssid, .net-row.row--stale .row__sub span, .net-row.row--stale .net-row__dbm, .net-row.row--stale .net-row__word');
      assert.ok(stale.length >= 3, `${stale.length} textos na linha velha`);
      for (const t of stale) assert.ok(t.ratio >= 4.5, `${colorScheme}: "${t.text}" com contraste ${t.ratio}`);

      // o selo verde (WPA2/WPA3, "Boa") sobre o fundo secundário
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'probe-badge';
        host.style.cssText = 'padding:8px;background:var(--surface-2)';
        const badge = document.createElement('span');
        badge.className = 'badge badge--good';
        badge.textContent = 'WPA2/WPA3';
        host.appendChild(badge);
        document.querySelector('.view').prepend(host);
      });
      const [badge] = await run(page, inPageContrast, '#probe-badge .badge--good');
      assert.ok(badge.ratio >= 4.5, `${colorScheme}: selo "bom" com contraste ${badge.ratio}`);

      // Exportar: nenhum texto abaixo de 12 px (o nome do arquivo, em letra monoespaçada, encolhia)
      await goto(page, '/ferramentas/exportar');
      await page.waitForSelector('.exp-preview__name');
      await page.locator('.view .seg__opt, .view .chip, .view button', { hasText: 'Planilha' }).first().click();
      await page.waitForFunction(() => /\.csv$/.test(document.querySelector('.exp-preview__name').textContent));
      const small = await page.evaluate(() => {
        const out = [];
        const walker = document.createTreeWalker(document.querySelector('.view'), NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const el = node.parentElement;
          if (!node.nodeValue.trim() || !el || el.closest('.sr-only, [hidden]')) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const size = parseFloat(getComputedStyle(el).fontSize);
          if (size < 11.99) out.push(`${node.nodeValue.trim().slice(0, 30)}: ${size} px`);
        }
        return out;
      });
      assert.deepEqual(small, [], colorScheme);
    });
  }
});
