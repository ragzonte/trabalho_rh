// Contas a Dois — app principal (telas, navegação e fluxo de login).

import { CONFIG } from './config.js';
import * as auth from './auth.js';
import * as G from './google.js';
import * as db from './db.js';
import * as S from './stats.js';
import {
  brl, esc, monthLabel, dayLabel, currentMonth, addMonths, monthOf, todayISO, yesterdayISO,
  maskCents, firstName, isEmail, timeLabel,
} from './format.js';
import { rankedBars, segmentedBar, columnsChart, initTooltips } from './charts.js';

const VERSION = '1.0.0';
const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');
const $toast = document.getElementById('toast-root');

const params = new URLSearchParams(location.search);
if (params.has('demo')) localStorage.setItem('cad.demo', '1');
const DEMO = localStorage.getItem('cad.demo') === '1';

const ui = {
  screen: 'loading',
  data: {},
  tab: 'inicio',
  month: currentMonth(),
  person: '',
  tipo: '',
  chartTipo: 'despesa',
  sheetOpen: false,
};
let me = null;
let pendingRenew = false;
let installPrompt = null;

// ---------------------------------------------------------------------------
// Ícones
// ---------------------------------------------------------------------------
const icon = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}${extra}</svg>`;
const I = {
  home: icon('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  list: icon('<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  chart: icon('<path d="M3 21h18M6 17v-5M11 17V7M16 17v-8M21 17v-3"/>'),
  more: icon('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
};
const GOOGLE_G = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

// ---------------------------------------------------------------------------
// Utilidades de interface
// ---------------------------------------------------------------------------
let toastTimer;
function toast(msg, ms = 2600) {
  clearTimeout(toastTimer);
  $toast.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  toastTimer = setTimeout(() => { $toast.innerHTML = ''; }, ms);
}

function go(screen, data = {}) {
  ui.screen = screen;
  ui.data = data;
  render();
}

const inviteLink = (id) => `${auth.redirectUri()}?convite=${encodeURIComponent(id)}`;
const sheetUrl = (id) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;

/** Extrai o id da planilha de um link de convite, link do Sheets ou código puro. */
function parseInvite(text) {
  const s = String(text || '').trim();
  const m = s.match(/convite=([\w-]+)/) || s.match(/\/d\/([\w-]{20,})/) || s.match(/^([\w-]{20,})$/);
  return m ? m[1] : '';
}

function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

async function shareText(text, url) {
  if (navigator.share) {
    try {
      await navigator.share({ title: CONFIG.APP_NAME, text, url });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  await copy(url);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copiado ✓');
  } catch {
    window.prompt('Copie o link:', text);
  }
}

// ---------------------------------------------------------------------------
// Telas de entrada (login, configuração, convite)
// ---------------------------------------------------------------------------
const logo = '<img class="logo" src="icons/icon.svg" alt="">';

function screenLoading() {
  return `<div class="welcome" style="text-align:center"><div class="spinner" style="margin:0 auto 16px"></div>
    <p class="lead">${esc(ui.data.text || 'Carregando…')}</p></div>`;
}

function screenLogin() {
  const invite = localStorage.getItem('cad.invite');
  const err = ui.data.error;
  return `<div class="welcome">
    ${logo}
    <h1>${esc(CONFIG.APP_NAME)}</h1>
    <p class="lead">As finanças do casal num lugar só. Cada um lança o que ganha e o que gasta — e vocês veem tudo juntos.</p>
    ${invite ? '<div class="banner">💌 Você recebeu um convite! Entre com sua conta Google para participar.</div>' : ''}
    ${err ? `<p class="error-text">${esc(err)}</p>` : ''}
    <button class="btn google" data-action="login">${GOOGLE_G} Entrar com Google</button>
    <p class="small">Os dados ficam numa planilha no Google Drive, compartilhada só entre vocês dois.</p>
    <button class="link" data-action="demo">Ver uma demonstração</button>
  </div>`;
}

function screenNoConfig() {
  return `<div class="welcome">
    ${logo}
    <h1>Quase lá!</h1>
    <p class="lead">Falta configurar o login do Google deste app (uma vez só, por quem publicou o app).</p>
    <div class="card"><ol class="steps">
      <li>Crie um <b>ID do cliente OAuth</b> (tipo “Aplicativo da Web”) no Google Cloud.</li>
      <li>Cole o ID em <code>js/config.js</code>.</li>
      <li>Publique de novo. O passo a passo completo está no <b>README</b>.</li>
    </ol></div>
    <button class="btn" data-action="demo">Ver uma demonstração</button>
  </div>`;
}

function screenScopes() {
  return `<div class="welcome">
    ${logo}
    <h1>Falta uma permissão</h1>
    <p class="lead">Para guardar os dados na planilha do casal, o app precisa de acesso às planilhas e aos arquivos que ele mesmo cria no seu Drive.</p>
    <p class="hint" style="margin:0 0 20px">Na tela do Google, deixe <b>todas as caixas marcadas</b>.</p>
    <button class="btn" data-action="login-consent">Tentar de novo</button>
  </div>`;
}

function screenSetup() {
  const pasted = ui.data.code || '';
  return `<div class="welcome">
    ${logo}
    <h1>Olá, ${esc(firstName(me.name) || 'tudo bem')}! 👋</h1>
    <p class="lead">Como vocês querem começar?</p>
    <div class="card">
      <h2>Sou o primeiro(a) a usar</h2>
      <p class="hint" style="margin:0 0 14px">O app cria a planilha do casal no seu Google Drive. Depois é só mandar o convite.</p>
      <button class="btn" data-action="go-create">Criar nosso espaço</button>
    </div>
    <form class="card" data-form="join">
      <h2>Recebi um convite</h2>
      <label class="field"><span>Cole aqui o link ou o código do convite</span>
        <input class="input" name="code" value="${esc(pasted)}" autocomplete="off" placeholder="https://…?convite=…"></label>
      ${ui.data.joinError ? `<p class="error-text">${esc(ui.data.joinError)}</p>` : ''}
      <button class="btn secondary" type="submit">Entrar no espaço</button>
    </form>
    <p class="small">Conectado como ${esc(me.email)} · <button class="link" data-action="switch-account">trocar de conta</button></p>
  </div>`;
}

function screenCreate() {
  return `<form class="welcome" data-form="create">
    ${logo}
    <h1>Nosso espaço</h1>
    <p class="lead">Só duas perguntas rápidas.</p>
    <label class="field"><span>Como você quer ser chamado(a)?</span>
      <input class="input" name="name" required maxlength="40" value="${esc(firstName(me.name))}" autocomplete="given-name"></label>
    <label class="field"><span>E-mail Google do seu amor (opcional, dá para fazer depois)</span>
      <input class="input" name="partner" type="email" inputmode="email" autocomplete="off" placeholder="nome@gmail.com"></label>
    <p class="hint">Vamos liberar o acesso à planilha para esse e-mail.</p>
    ${ui.data.error ? `<p class="error-text">${esc(ui.data.error)}</p>` : ''}
    <button class="btn" type="submit">Criar planilha</button>
    <button class="btn secondary" type="button" data-action="go-setup">Voltar</button>
  </form>`;
}

function inviteBlock({ shared = [], error = '' } = {}) {
  const link = inviteLink(db.state.spaceId);
  return `
    <ol class="steps">
      <li>Libere o acesso digitando o <b>e-mail Google</b> dele(a).</li>
      <li>Envie o <b>link do convite</b> (WhatsApp, por exemplo).</li>
      <li>Ele(a) abre o link, entra com o Google e pronto! 💑</li>
    </ol>
    ${shared.map((e) => `<div class="banner">✓ Acesso liberado para <b>${esc(e)}</b></div>`).join('')}
    <form data-form="invite">
      <label class="field"><span>E-mail Google do seu amor</span>
        <div class="row"><input class="input" name="email" type="email" inputmode="email" autocomplete="off" placeholder="nome@gmail.com" required>
        <button class="btn" type="submit" style="flex:0 0 auto;width:auto">Liberar</button></div></label>
      ${error ? `<p class="error-text">${esc(error)}</p>` : ''}
    </form>
    <div class="linkbox"><span style="flex:1">${esc(link)}</span></div>
    <button class="btn" data-action="share-invite">Enviar link do convite</button>
    <button class="btn secondary" data-action="copy-invite">Copiar link</button>`;
}

function screenCreated() {
  return `<div class="welcome">
    <div style="font-size:56px">🎉</div>
    <h1>Tudo pronto!</h1>
    <p class="lead">Agora convide seu amor para lançar junto com você.</p>
    <div class="card" id="invite-card">${inviteBlock(ui.data)}</div>
    <button class="btn secondary" data-action="start">Começar a usar</button>
  </div>`;
}

function screenNoAccess() {
  const invalid = ui.data.reason === 'invalid';
  return `<div class="welcome">
    <div style="font-size:56px">🔒</div>
    <h1>${invalid ? 'Planilha diferente' : 'Ainda sem acesso'}</h1>
    ${invalid
      ? `<p class="lead">${esc(ui.data.message || 'Essa planilha não é do Contas a Dois.')}</p>`
      : `<p class="lead">A planilha do convite ainda não foi compartilhada com <b>${esc(me.email)}</b>.</p>
         <div class="card"><p style="margin:0">Peça para quem te convidou abrir o app em <b>Ajustes → Convidar</b> e liberar exatamente este e-mail. Depois toque em “Tentar de novo”.</p></div>`}
    <button class="btn" data-action="retry-join">Tentar de novo</button>
    <button class="btn secondary" data-action="switch-account">Entrar com outra conta</button>
    <button class="btn secondary" data-action="cancel-invite">Voltar</button>
  </div>`;
}

function screenLost() {
  return `<div class="welcome">
    <div style="font-size:56px">🔒</div>
    <h1>Sem acesso à planilha</h1>
    <p class="lead">Não conseguimos abrir a planilha do casal com <b>${esc(me.email)}</b>. Ela pode ter sido apagada ou o compartilhamento removido.</p>
    <button class="btn" data-action="retry-open">Tentar de novo</button>
    <button class="btn secondary" data-action="forget-space">Usar outra planilha</button>
  </div>`;
}

function screenError() {
  return `<div class="welcome">
    <div style="font-size:56px">${ui.data.offline ? '📡' : '⚠️'}</div>
    <h1>${ui.data.offline ? 'Sem conexão' : 'Algo deu errado'}</h1>
    <p class="lead">${esc(ui.data.message || 'Verifique a internet e tente de novo.')}</p>
    <button class="btn" data-action="reload">Tentar de novo</button>
  </div>`;
}

// ---------------------------------------------------------------------------
// App principal (abas)
// ---------------------------------------------------------------------------
const TABS = [
  { id: 'inicio', label: 'Início', icon: I.home },
  { id: 'extrato', label: 'Extrato', icon: I.list },
  { id: 'graficos', label: 'Gráficos', icon: I.chart },
  { id: 'ajustes', label: 'Ajustes', icon: I.more },
];

function syncChip() {
  const st = db.state;
  let cls = '';
  let text = 'Salvo';
  if (st.syncing) { cls = 'busy'; text = st.pending ? 'Salvando…' : 'Atualizando…'; }
  if (st.offline) { cls = 'offline'; text = st.pending ? `Offline · ${st.pending} pendente${st.pending > 1 ? 's' : ''}` : 'Offline'; }
  else if (st.pending && !st.syncing) { cls = 'pending'; text = `${st.pending} pendente${st.pending > 1 ? 's' : ''}`; }
  return `<button class="sync ${cls} ${st.syncing ? 'busy' : ''}" data-action="sync" aria-label="Sincronizar agora">
    <span class="dot"></span>${esc(text)}</button>`;
}

function monthBar() {
  const isNow = ui.month === currentMonth();
  return `<div class="month">
    <button data-action="month" data-delta="-1" aria-label="Mês anterior">‹</button>
    <strong ${isNow ? '' : 'data-action="month-now" role="button" tabindex="0" title="Voltar para o mês atual"'}>${monthLabel(ui.month)}</strong>
    <button data-action="month" data-delta="1" aria-label="Próximo mês">›</button>
  </div>`;
}

function screenMain() {
  const tab = TABS.find((t) => t.id === ui.tab) || TABS[0];
  const title = tab.id === 'inicio' ? CONFIG.APP_NAME : tab.label;
  const body = !db.state.ready ? '<div class="spinner" style="margin-top:30vh"></div>' : VIEWS[tab.id]();
  const nav = (t) => `<button class="tab" data-action="tab" data-tab="${t.id}" ${t.id === ui.tab ? 'aria-current="page"' : ''}>${t.icon}${t.label}</button>`;
  return `
    <header class="topbar"><h1>${esc(title)}</h1>${syncChip()}</header>
    ${tab.id !== 'ajustes' ? monthBar() : ''}
    ${DEMO ? '<div style="margin:0 16px 12px" class="banner">🧪 Modo demonstração: os dados ficam só neste aparelho.</div>' : ''}
    <main id="view">${body}</main>
    <nav class="tabbar" aria-label="Navegação"><div class="tabbar-in">
      ${nav(TABS[0])}${nav(TABS[1])}
      <button class="fab" data-action="add" aria-label="Novo lançamento">${I.plus}</button>
      ${nav(TABS[2])}${nav(TABS[3])}
    </div></nav>`;
}

function sortTx(list) {
  return [...list].sort((a, b) => (b.data.localeCompare(a.data)) || String(b.criadoEm).localeCompare(String(a.criadoEm)));
}

function txRow(t, list, pending) {
  const cat = db.state.cats.find((c) => c.nome === t.categoria && c.tipo === t.tipo);
  const p = S.personOf(list, t.pessoa);
  const title = t.descricao || t.categoria || 'Sem descrição';
  const sub = t.descricao ? t.categoria : '';
  const rec = t.tipo === 'receita';
  return `<li><button class="tx" data-action="edit-tx" data-id="${esc(t.id)}">
    <span class="tx-ico" aria-hidden="true">${esc(cat?.icone || '🏷️')}</span>
    <span class="tx-main">
      <span class="tx-desc">${esc(title)}</span>
      <span class="tx-meta">${sub ? `${esc(sub)} ·` : ''}<i class="mdot" style="background:${p.color}"></i>${esc(p.label)}</span>
    </span>
    <span class="tx-val ${rec ? 'rec' : ''}">${rec ? '+' : '−'} ${brl(t.valor)}
      ${pending.has(t.id) ? '<span class="tx-pend">enviando…</span>' : ''}</span>
  </button></li>`;
}

function installBanner() {
  if (isStandalone() || localStorage.getItem('cad.installDismissed')) return '';
  if (!installPrompt && !isIOS()) return '';
  const how = installPrompt
    ? '<button class="btn" data-action="install" style="margin-top:10px">Instalar agora</button>'
    : '<p style="margin:6px 0 0">No iPhone: toque em <b>Compartilhar</b> <span aria-hidden="true">⬆️</span> e depois em <b>Adicionar à Tela de Início</b>.</p>';
  return `<div class="card"><div class="card-head"><h2>📲 Instale o app</h2>
    <button class="link" data-action="dismiss-install">Agora não</button></div>
    <p class="hint" style="margin:0">Abre mais rápido e funciona como um app normal.</p>${how}</div>`;
}

const VIEWS = {
  inicio() {
    const st = db.state;
    const list = S.people(st);
    const monthTx = S.filterTx(st.tx, { month: ui.month });
    const t = S.totals(monthTx);
    const persons = S.byPerson(monthTx, list);
    const cats = S.byCategory(monthTx, st.cats, 'despesa');
    const recent = sortTx(monthTx).slice(0, 5);
    const pending = db.pendingTxIds();
    const mName = monthLabel(ui.month, { year: false });

    const hero = `<section class="card hero">
      <div class="label">Saldo de ${mName}</div>
      <div class="value ${t.saldo < 0 ? 'neg' : ''}">${brl(t.saldo)}</div>
      <div class="tiles">
        <div class="tile"><div class="label"><i class="key-rect" style="background:var(--c-rec)"></i>Receitas</div><div class="v">${brl(t.receitas)}</div></div>
        <div class="tile"><div class="label"><i class="key-rect" style="background:var(--c-desp)"></i>Despesas</div><div class="v">${brl(t.despesas)}</div></div>
      </div>
    </section>`;

    const solo = st.members.length < 2;
    const peopleCard = `<section class="card">
      <h2>Cada um</h2>
      <div class="people">${persons.map((p) => `
        <div class="person">
          <i class="mdot" style="background:${p.person.color}"></i>
          <span class="name">${esc(p.person.label)}${p.person.email === me.email ? ' <small style="color:var(--ink-muted);font-weight:400">(você)</small>' : ''}</span>
          <span class="bal">${brl(p.saldo)}</span>
          <span class="sub"><span>Ganhou ${brl(p.receitas)}</span><span>Gastou ${brl(p.despesas)}</span></span>
        </div>`).join('')}
      </div>
      ${t.despesas > 0 && persons.length > 1 ? `<div style="font-size:13px;color:var(--ink-2);margin-bottom:6px">Quem pagou as despesas</div>
        ${segmentedBar(persons.map((p) => ({ label: p.person.label, valor: p.despesas, color: p.person.color })), { label: 'Despesas' })}` : ''}
      ${solo ? '<button class="btn secondary" data-action="open-invite" style="margin-top:4px">💌 Convidar meu amor</button>' : ''}
    </section>`;

    const catCard = cats.length ? `<section class="card">
      <div class="card-head"><h2>Para onde foi o dinheiro</h2><button class="link" data-action="tab" data-tab="graficos">Ver tudo</button></div>
      ${rankedBars(cats, { color: 'var(--c-desp)', limit: 5 })}
    </section>` : '';

    const recentCard = recent.length ? `<section class="card">
      <div class="card-head"><h2>Últimos lançamentos</h2><button class="link" data-action="tab" data-tab="extrato">Ver extrato</button></div>
      <ul class="txlist">${recent.map((x) => txRow(x, list, pending)).join('')}</ul>
    </section>` : `<section class="card empty"><div class="big">📝</div>
      Nada lançado em ${mName} ainda.<br>Toque no <b>+</b> para adicionar um salário ou uma despesa.</section>`;

    return installBanner() + hero + peopleCard + catCard + recentCard;
  },

  extrato() {
    const st = db.state;
    const list = S.people(st);
    const monthTx = S.filterTx(st.tx, { month: ui.month, person: ui.person, tipo: ui.tipo });
    const pending = db.pendingTxIds();
    const t = S.totals(monthTx);
    const chip = (kind, value, label, extra = '') => `<button class="chip" data-action="filter" data-kind="${kind}" data-value="${esc(value)}" aria-pressed="${ui[kind] === value}">${extra}${esc(label)}</button>`;
    const filters = `<div class="chips">
      ${chip('tipo', '', 'Tudo')}${chip('tipo', 'despesa', 'Despesas')}${chip('tipo', 'receita', 'Receitas')}
    </div>
    <div class="chips">
      ${chip('person', '', 'Todos')}${list.map((p) => chip('person', p.email, p.label, `<i class="mdot" style="background:${p.color}"></i>`)).join('')}
    </div>`;
    if (!monthTx.length) {
      return `${filters}<div class="empty"><div class="big">🔍</div>Nenhum lançamento aqui.</div>`;
    }
    const groups = new Map();
    for (const x of sortTx(monthTx)) {
      if (!groups.has(x.data)) groups.set(x.data, []);
      groups.get(x.data).push(x);
    }
    const summary = `<p class="hint" style="margin:0 4px 12px">${monthTx.length} lançamento${monthTx.length > 1 ? 's' : ''}
      ${ui.tipo !== 'receita' ? ` · despesas ${brl(t.despesas)}` : ''}${ui.tipo !== 'despesa' ? ` · receitas ${brl(t.receitas)}` : ''}</p>`;
    return filters + summary + [...groups.entries()].map(([day, items]) => {
      const dayTotal = items.reduce((a, x) => a + (x.tipo === 'receita' ? x.valor : -x.valor), 0);
      return `<div class="day"><span>${esc(dayLabel(day))}</span><span>${dayTotal >= 0 ? '+' : '−'} ${brl(Math.abs(dayTotal))}</span></div>
        <ul class="txlist">${items.map((x) => txRow(x, list, pending)).join('')}</ul>`;
    }).join('');
  },

  graficos() {
    const st = db.state;
    const list = S.people(st);
    const scoped = ui.person ? st.tx.filter((x) => x.pessoa === ui.person) : st.tx;
    const monthTx = S.filterTx(scoped, { month: ui.month });
    const data = S.trend(scoped, ui.month, 6);
    const cats = S.byCategory(monthTx, st.cats, ui.chartTipo);
    const withData = data.filter((d) => d.despesas > 0);
    const avg = withData.length ? withData.reduce((a, d) => a + d.despesas, 0) / withData.length : 0;
    const chip = (value, label, extra = '') => `<button class="chip" data-action="filter" data-kind="person" data-value="${esc(value)}" aria-pressed="${ui.person === value}">${extra}${esc(label)}</button>`;
    const mName = monthLabel(ui.month, { year: false });

    const allTx = S.filterTx(st.tx, { month: ui.month });
    const persons = S.byPerson(allTx, list);

    return `
      <div class="chips">${chip('', 'Todos')}${list.map((p) => chip(p.email, p.label, `<i class="mdot" style="background:${p.color}"></i>`)).join('')}</div>

      <section class="card">
        <h2>Receitas e despesas <small>· últimos 6 meses</small></h2>
        ${columnsChart(data, [
          { key: 'receitas', label: 'Receitas', color: 'var(--c-rec)' },
          { key: 'despesas', label: 'Despesas', color: 'var(--c-desp)' },
        ], { highlight: ui.month })}
        ${avg ? `<p class="hint" style="margin:8px 0 0">Média de despesas: <b>${brl(avg)}</b> por mês</p>` : ''}
      </section>

      <section class="card">
        <div class="card-head"><h2>Por categoria <small>· ${mName}</small></h2></div>
        <div class="seg-ctl" role="group" aria-label="Tipo">
          <button data-action="chart-tipo" data-value="despesa" aria-pressed="${ui.chartTipo === 'despesa'}">Despesas</button>
          <button data-action="chart-tipo" data-value="receita" aria-pressed="${ui.chartTipo === 'receita'}">Receitas</button>
        </div>
        ${cats.length ? rankedBars(cats, { color: ui.chartTipo === 'despesa' ? 'var(--c-desp)' : 'var(--c-rec)' })
          : `<p class="empty" style="padding:12px">Sem ${ui.chartTipo === 'despesa' ? 'despesas' : 'receitas'} em ${mName}.</p>`}
      </section>

      ${!ui.person && list.length > 1 ? `<section class="card">
        <h2>Por pessoa <small>· ${mName}</small></h2>
        ${persons.some((p) => p.receitas) ? `<div style="font-size:13px;color:var(--ink-2);margin-bottom:6px">Quem ganhou</div>
          ${segmentedBar(persons.map((p) => ({ label: p.person.label, valor: p.receitas, color: p.person.color })), { label: 'Receitas' })}` : ''}
        ${persons.some((p) => p.despesas) ? `<div style="font-size:13px;color:var(--ink-2);margin:10px 0 6px">Quem gastou</div>
          ${segmentedBar(persons.map((p) => ({ label: p.person.label, valor: p.despesas, color: p.person.color })), { label: 'Despesas' })}` : ''}
        ${persons.some((p) => p.receitas || p.despesas) ? '' : `<p class="empty" style="padding:12px">Sem lançamentos em ${mName}.</p>`}
      </section>` : ''}`;
  },

  ajustes() {
    const st = db.state;
    const list = S.people(st);
    const last = st.lastSync ? `Atualizado às ${timeLabel(st.lastSync)}` : 'Ainda não sincronizado';
    const avatar = (p) => (p.email === me.email && me.picture
      ? `<span class="avatar" style="box-shadow:0 0 0 2px ${p.color}"><img src="${esc(me.picture)}" alt="" referrerpolicy="no-referrer"></span>`
      : `<span class="avatar" style="box-shadow:0 0 0 2px ${p.color}">${esc(p.label.charAt(0).toUpperCase())}</span>`);
    return `
      <div class="section-title">Vocês</div>
      <section class="card" style="padding-top:4px;padding-bottom:4px"><ul class="list">
        ${list.map((p) => `<li><button class="list-item" ${p.email === me.email ? 'data-action="edit-name"' : 'disabled'}>
          ${avatar(p)}
          <span class="grow"><b>${esc(p.label)}</b>${p.email === me.email ? ' (você)' : ''}<div class="sub">${esc(p.email)}</div></span>
          ${p.email === me.email ? '<span class="chev">Editar</span>' : ''}
        </button></li>`).join('')}
        <li><button class="list-item" data-action="open-invite"><span class="avatar">💌</span>
          <span class="grow"><b>Convidar</b><div class="sub">Liberar acesso e enviar o link</div></span><span class="chev">›</span></button></li>
      </ul></section>

      <div class="section-title">Organização</div>
      <section class="card" style="padding-top:4px;padding-bottom:4px"><ul class="list">
        <li><button class="list-item" data-action="open-cats"><span class="avatar">🏷️</span>
          <span class="grow"><b>Categorias</b><div class="sub">${st.cats.length} categorias · criar, editar e remover</div></span><span class="chev">›</span></button></li>
        <li><a class="list-item" href="${DEMO ? '#' : sheetUrl(st.spaceId)}" target="_blank" rel="noopener" ${DEMO ? 'data-action="demo-sheet"' : ''} style="text-decoration:none">
          <span class="avatar">📊</span><span class="grow"><b>Abrir a planilha</b><div class="sub">Ver e editar os dados no Google Sheets</div></span><span class="chev">↗</span></a></li>
      </ul></section>

      <div class="section-title">Sincronização</div>
      <section class="card">
        <p style="margin:0 0 12px">${esc(last)}${st.pending ? ` · ${st.pending} alteração(ões) aguardando envio` : ''}</p>
        <button class="btn secondary" data-action="sync">Sincronizar agora</button>
      </section>

      <div class="section-title">Conta</div>
      <section class="card">
        <p style="margin:0 0 12px">Conectado como <b>${esc(me.email)}</b></p>
        ${!isStandalone() && (installPrompt || isIOS()) ? '<button class="btn secondary" data-action="install">📲 Instalar o app</button>' : ''}
        ${DEMO ? '<button class="btn secondary" data-action="exit-demo">Sair da demonstração</button>'
          : `<button class="btn secondary" data-action="signout">Sair da conta</button>
             <button class="btn danger" data-action="forget-space">Desconectar deste aparelho</button>`}
      </section>
      <p class="hint" style="text-align:center;margin-top:18px">${esc(CONFIG.APP_NAME)} · versão ${VERSION}</p>`;
  },
};

// ---------------------------------------------------------------------------
// Folhas (modais)
// ---------------------------------------------------------------------------
function openSheet(title, html, onMount) {
  $sheet.innerHTML = `<div class="sheet-wrap">
    <div class="sheet-bg" data-action="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grip"></div>
      <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-action="close-sheet" aria-label="Fechar">✕</button></div>
      <div class="sheet-body">${html}</div>
    </div></div>`;
  if (!ui.sheetOpen) {
    ui.sheetOpen = true;
    history.pushState({ sheet: true }, '');
  }
  onMount?.($sheet.querySelector('.sheet'));
}

function closeSheet() {
  if (!ui.sheetOpen) return;
  if (history.state?.sheet) history.back(); // dispara popstate -> finishClose
  else finishClose();
}

function finishClose() {
  ui.sheetOpen = false;
  $sheet.innerHTML = '';
  render();
  if (pendingRenew) renewAuth();
}

window.addEventListener('popstate', () => { if (ui.sheetOpen) finishClose(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.sheetOpen) closeSheet(); });

// ----- Lançamento -----
function defaultDate() {
  return ui.month === currentMonth() ? todayISO() : `${ui.month}-01`;
}

function openTxSheet(id, draft) {
  const t = id ? db.state.tx.find((x) => x.id === id) : null;
  if (id && !t) return;
  const f = draft || {
    id: t?.id,
    tipo: t?.tipo || 'despesa',
    cents: t ? Math.round(t.valor * 100) : 0,
    descricao: t?.descricao || '',
    categoria: t?.categoria || '',
    pessoa: t?.pessoa || me.email,
    data: t?.data || defaultDate(),
  };
  const list = S.people(db.state);
  if (!list.some((p) => p.email === me.email)) list.unshift({ email: me.email, label: firstName(me.name) || 'Eu', color: 'var(--c-mem1)' });

  const catGrid = () => {
    const cats = db.state.cats.filter((c) => c.tipo === f.tipo);
    return cats.map((c) => `<button type="button" class="catbtn" data-cat="${esc(c.nome)}" aria-pressed="${c.nome === f.categoria}">
      <span class="e">${esc(c.icone)}</span>${esc(c.nome)}</button>`).join('')
      + '<button type="button" class="catbtn" data-newcat="1"><span class="e">＋</span>Nova</button>';
  };

  const html = `<form data-form="tx" novalidate>
    <div class="seg-ctl" role="group" aria-label="Tipo">
      <button type="button" data-tipo="despesa" aria-pressed="${f.tipo === 'despesa'}">Despesa</button>
      <button type="button" data-tipo="receita" aria-pressed="${f.tipo === 'receita'}">Receita</button>
    </div>
    <label class="amount"><span>R$</span>
      <input name="valor" inputmode="numeric" autocomplete="off" aria-label="Valor" value="${maskCents(f.cents)}"></label>
    <label class="field"><span>Descrição (opcional)</span>
      <input class="input" name="descricao" maxlength="80" value="${esc(f.descricao)}" placeholder="Ex.: Aluguel, padaria, salário…" autocomplete="off"></label>
    <div class="field"><span>Categoria</span><div class="catgrid" id="catgrid">${catGrid()}</div></div>
    <div class="field"><span>Quem</span><div class="chips" id="who">${list.map((p) => `<button type="button" class="chip" data-who="${esc(p.email)}" aria-pressed="${p.email === f.pessoa}"><i class="mdot" style="background:${p.color}"></i>${esc(p.label)}</button>`).join('')}</div></div>
    <div class="field"><span>Data</span>
      <div class="row" style="align-items:center">
        <input class="input" type="date" name="data" value="${esc(f.data)}" required style="flex:1.4">
        <button type="button" class="chip" data-day="${todayISO()}">Hoje</button>
        <button type="button" class="chip" data-day="${yesterdayISO()}">Ontem</button>
      </div></div>
    <p class="error-text" id="tx-error" hidden></p>
    <button class="btn" type="submit">Salvar</button>
    ${f.id ? '<button class="btn danger" type="button" data-del="1">Excluir lançamento</button>' : ''}
  </form>`;

  openSheet(f.id ? 'Editar lançamento' : 'Novo lançamento', html, (root) => {
    const form = root.querySelector('form');
    const amount = form.valor;
    const err = root.querySelector('#tx-error');
    const showErr = (m) => { err.textContent = m; err.hidden = !m; };

    const fit = () => { amount.style.width = `${Math.max(4, amount.value.length) + 0.6}ch`; };
    fit();
    amount.addEventListener('input', () => {
      f.cents = Number(amount.value.replace(/\D/g, '').slice(0, 11)) || 0;
      amount.value = maskCents(f.cents);
      fit();
    });
    // Ao tocar no valor, seleciona tudo: é só digitar o novo valor.
    amount.addEventListener('focus', () => setTimeout(() => amount.select(), 0));
    form.descricao.addEventListener('input', () => { f.descricao = form.descricao.value; });
    form.data.addEventListener('change', () => { f.data = form.data.value; });

    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tipo) {
        f.tipo = b.dataset.tipo;
        if (!db.state.cats.some((c) => c.tipo === f.tipo && c.nome === f.categoria)) f.categoria = '';
        root.querySelectorAll('[data-tipo]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.tipo === f.tipo));
        root.querySelector('#catgrid').innerHTML = catGrid();
      } else if (b.dataset.cat !== undefined) {
        f.categoria = b.dataset.cat;
        root.querySelectorAll('[data-cat]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.cat === f.categoria));
        showErr('');
      } else if (b.dataset.newcat) {
        openCatSheet({ tipo: f.tipo, onDone: (cat) => openTxSheet(null, { ...f, categoria: cat ? cat.nome : f.categoria }) });
      } else if (b.dataset.who) {
        f.pessoa = b.dataset.who;
        root.querySelectorAll('[data-who]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.who === f.pessoa));
      } else if (b.dataset.day) {
        f.data = b.dataset.day;
        form.data.value = f.data;
      } else if (b.dataset.del) {
        if (b.dataset.confirm) {
          db.deleteTx(f.id);
          closeSheet();
          toast('Lançamento excluído');
        } else {
          b.dataset.confirm = '1';
          b.textContent = 'Toque de novo para excluir';
        }
      }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      f.data = form.data.value;
      if (!f.cents) { showErr('Digite o valor.'); amount.focus(); return; }
      if (!f.categoria) {
        showErr('Escolha uma categoria.');
        const g = root.querySelector('#catgrid');
        g.classList.remove('invalid');
        void g.offsetWidth;
        g.classList.add('invalid');
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.data)) { showErr('Escolha a data.'); return; }
      db.saveTx({
        id: f.id,
        tipo: f.tipo,
        valor: f.cents / 100,
        descricao: f.descricao.trim(),
        categoria: f.categoria,
        pessoa: f.pessoa,
        data: f.data,
      });
      const m = monthOf(f.data);
      closeSheet();
      const what = f.tipo === 'receita' ? 'Receita' : 'Despesa';
      toast(m === ui.month ? `${what} salva ✓` : `${what} salva em ${monthLabel(m)} ✓`);
    });

    if (!f.id && !draft) amount.focus();
  });
}

// ----- Categorias -----
const EMOJIS = ['🏠', '🛒', '🍽️', '🚗', '💡', '💊', '🎉', '📚', '🛍️', '📦', '🐾', '👶', '✈️', '🎮', '🏋️', '💇',
  '📱', '🎁', '☕', '🍺', '⛽', '🚌', '🏥', '🧾', '💳', '🏦', '💰', '✨', '📈', '💼', '🔧', '🧹'];

function openCatSheet({ cat, tipo = 'despesa', onDone } = {}) {
  const f = { id: cat?.id, nome: cat?.nome || '', tipo: cat?.tipo || tipo, icone: cat?.icone || '🏷️' };
  const html = `<form data-form="cat" novalidate>
    <div class="seg-ctl" role="group" aria-label="Tipo">
      <button type="button" data-tipo="despesa" aria-pressed="${f.tipo === 'despesa'}">Despesa</button>
      <button type="button" data-tipo="receita" aria-pressed="${f.tipo === 'receita'}">Receita</button>
    </div>
    <label class="field"><span>Nome</span>
      <input class="input" name="nome" maxlength="30" value="${esc(f.nome)}" placeholder="Ex.: Academia" autocomplete="off" required></label>
    <div class="field"><span>Ícone</span>
      <div class="emojis">${EMOJIS.map((e) => `<button type="button" data-emoji="${e}" aria-pressed="${e === f.icone}">${e}</button>`).join('')}</div>
      <label class="row" style="align-items:center;gap:10px"><span style="flex:0 0 auto;font-size:13px;color:var(--ink-2)">ou digite um emoji:</span>
        <input class="input" name="icone" value="${esc(f.icone)}" maxlength="4" style="max-width:90px;text-align:center"></label>
    </div>
    ${cat ? '<p class="hint">Ao renomear, os lançamentos dessa categoria são atualizados também.</p>' : ''}
    <p class="error-text" id="cat-error" hidden></p>
    <button class="btn" type="submit">${cat ? 'Salvar' : 'Criar categoria'}</button>
    ${cat ? '<button class="btn danger" type="button" data-del="1">Excluir categoria</button>' : ''}
    <button class="btn secondary" type="button" data-back="1">Voltar</button>
  </form>`;

  openSheet(cat ? 'Editar categoria' : 'Nova categoria', html, (root) => {
    const form = root.querySelector('form');
    const err = root.querySelector('#cat-error');
    const showErr = (m) => { err.textContent = m; err.hidden = !m; };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tipo) {
        f.tipo = b.dataset.tipo;
        root.querySelectorAll('[data-tipo]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.tipo === f.tipo));
      } else if (b.dataset.emoji) {
        f.icone = b.dataset.emoji;
        form.icone.value = f.icone;
        root.querySelectorAll('[data-emoji]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.emoji === f.icone));
      } else if (b.dataset.back) {
        onDone ? onDone(null) : closeSheet();
      } else if (b.dataset.del) {
        if (b.dataset.confirm) {
          db.deleteCat(f.id);
          toast('Categoria excluída');
          onDone ? onDone(null) : closeSheet();
        } else {
          b.dataset.confirm = '1';
          b.textContent = 'Toque de novo para excluir';
          showErr('Os lançamentos antigos continuam com o nome da categoria.');
        }
      }
    });
    form.icone.addEventListener('input', () => {
      f.icone = form.icone.value.trim() || '🏷️';
      root.querySelectorAll('[data-emoji]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.emoji === f.icone));
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const nome = form.nome.value.trim().replace(/\s+/g, ' ');
      if (!nome) { showErr('Dê um nome para a categoria.'); form.nome.focus(); return; }
      const dup = db.state.cats.some((c) => c.id !== f.id && c.tipo === f.tipo && c.nome.toLowerCase() === nome.toLowerCase());
      if (dup) { showErr('Já existe uma categoria com esse nome.'); return; }
      const saved = { ...f, nome };
      db.saveCat(saved);
      toast(cat ? 'Categoria salva ✓' : 'Categoria criada ✓');
      onDone ? onDone(saved) : closeSheet();
    });
    if (!cat) form.nome.focus();
  });
}

function openCatsSheet() {
  const group = (tipo, label) => {
    const cats = db.state.cats.filter((c) => c.tipo === tipo);
    return `<div class="section-title">${label}</div><ul class="list">${cats.map((c) => `
      <li><button class="list-item" data-edit-cat="${esc(c.id)}"><span class="avatar">${esc(c.icone)}</span>
        <span class="grow">${esc(c.nome)}</span><span class="chev">Editar</span></button></li>`).join('')}</ul>`;
  };
  openSheet('Categorias', `
    <button class="btn" data-new-cat="1">＋ Nova categoria</button>
    ${group('despesa', 'Despesas')}${group('receita', 'Receitas')}`, (root) => {
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.newCat) openCatSheet({ onDone: openCatsSheet });
      if (b.dataset.editCat) {
        const cat = db.state.cats.find((c) => c.id === b.dataset.editCat);
        if (cat) openCatSheet({ cat, onDone: openCatsSheet });
      }
    });
  });
}

// ----- Nome e convite -----
function openNameSheet() {
  const mine = db.state.members.find((m) => m.email === me.email);
  openSheet('Seu nome', `<form data-form="name">
    <label class="field"><span>Como você aparece para o casal</span>
      <input class="input" name="nome" maxlength="40" required value="${esc(mine?.nome || firstName(me.name))}"></label>
    <button class="btn" type="submit">Salvar</button></form>`, (root) => {
    const form = root.querySelector('form');
    form.nome.focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const nome = form.nome.value.trim();
      if (!nome) return;
      db.setMyName(nome);
      me = { ...me, name: nome };
      if (!DEMO) auth.setUser(me);
      closeSheet();
      toast('Nome atualizado ✓');
    });
  });
}

function openInviteSheet(data = {}) {
  openSheet('Convidar meu amor', inviteBlock(data));
}

async function submitInvite(form, rerender) {
  const email = form.email.value.trim().toLowerCase();
  const shared = ui.inviteShared || [];
  if (!isEmail(email)) { rerender({ shared, error: 'Digite um e-mail válido.' }); return; }
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await db.invite(email);
    ui.inviteShared = [...new Set([...shared, email])];
    rerender({ shared: ui.inviteShared });
    toast('Acesso liberado ✓ Agora envie o link.');
  } catch (e) {
    let error = 'Não foi possível liberar o acesso. Tente de novo.';
    if (e instanceof G.NetError) error = 'Sem conexão. Tente de novo quando estiver online.';
    else if (e instanceof G.AuthError) { renewAuth(); return; } else if (e instanceof G.ApiError && [403, 404].includes(e.status)) {
      error = 'Só quem criou a planilha consegue convidar pelo app. Peça para essa pessoa liberar, ou compartilhe a planilha direto no Google Sheets.';
    } else if (e instanceof G.ApiError && e.status === 400) {
      error = 'O Google não aceitou esse e-mail. Confira se é uma conta Google.';
    }
    rerender({ shared, error });
  }
}

// ---------------------------------------------------------------------------
// Ações (cliques)
// ---------------------------------------------------------------------------
const actions = {
  login: () => auth.signIn(),
  'login-consent': () => auth.signIn({ consent: true }),
  demo: () => { localStorage.setItem('cad.demo', '1'); location.href = `${auth.redirectUri()}?demo`; },
  'exit-demo': () => {
    Object.keys(localStorage).filter((k) => k.startsWith('cad.')).forEach((k) => localStorage.removeItem(k));
    location.href = auth.redirectUri();
  },
  'demo-sheet': (el, e) => { e.preventDefault(); toast('Na demonstração não há planilha real.'); },
  reload: () => location.reload(),
  'switch-account': () => { auth.signOut(); auth.signIn(); },
  signout: () => {
    db.forgetSpace();
    auth.signOut();
    go('login');
  },
  'forget-space': () => {
    if (ui.screen === 'main' && !window.confirm('Desconectar este aparelho da planilha? Os dados continuam salvos na planilha.')) return;
    db.forgetSpace();
    go('setup');
  },
  'go-create': () => go('create'),
  'go-setup': () => go('setup'),
  start: () => { ui.tab = 'inicio'; go('main'); },
  'retry-join': () => joinFlow(ui.data.id),
  'cancel-invite': () => { localStorage.removeItem('cad.invite'); enterSpace(); },
  'retry-open': () => openSpace(db.state.spaceId || db.localSpaceId(me.email)),
  'share-invite': () => shareText('Vamos organizar nossas contas juntos? Abra o link e entre com sua conta Google:', inviteLink(db.state.spaceId)),
  'copy-invite': () => copy(inviteLink(db.state.spaceId)),
  'open-invite': () => openInviteSheet({ shared: ui.inviteShared || [] }),
  'open-cats': () => openCatsSheet(),
  'edit-name': () => openNameSheet(),
  'close-sheet': () => closeSheet(),
  tab: (el) => { ui.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  month: (el) => { ui.month = addMonths(ui.month, Number(el.dataset.delta)); render(); },
  'month-now': () => { ui.month = currentMonth(); render(); },
  filter: (el) => { ui[el.dataset.kind] = el.dataset.value; render(); },
  'chart-tipo': (el) => { ui.chartTipo = el.dataset.value; render(); },
  add: () => openTxSheet(),
  'edit-tx': (el) => openTxSheet(el.dataset.id),
  sync: () => db.sync(),
  install: async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      render();
    } else {
      openSheet('Instalar no iPhone', `<ol class="steps">
        <li>Abra este app no <b>Safari</b>.</li>
        <li>Toque em <b>Compartilhar</b> (o quadrado com a seta para cima).</li>
        <li>Escolha <b>Adicionar à Tela de Início</b>.</li></ol>
        <button class="btn" data-action="close-sheet">Entendi</button>`);
    }
  },
  'dismiss-install': () => { localStorage.setItem('cad.installDismissed', '1'); render(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el, e);
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  const kind = form.dataset.form;
  if (kind === 'tx' || kind === 'cat' || kind === 'name') return; // tratados na própria folha
  e.preventDefault();
  if (kind === 'create') {
    const name = form.name.value.trim();
    const partner = form.partner.value.trim().toLowerCase();
    if (!name) return;
    if (partner && !isEmail(partner)) { go('create', { error: 'O e-mail do seu amor parece incompleto.' }); return; }
    createFlow(name, partner);
  } else if (kind === 'join') {
    const id = parseInvite(form.code.value);
    if (!id) { go('setup', { code: form.code.value, joinError: 'Não reconheci esse link. Cole o link inteiro que você recebeu.' }); return; }
    joinFlow(id);
  } else if (kind === 'invite') {
    const inSheet = !!form.closest('.sheet');
    await submitInvite(form, (data) => {
      if (inSheet) openInviteSheet(data);
      else { ui.data = { ...ui.data, ...data }; render(); }
    });
  }
});

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------
const SCREENS = {
  loading: screenLoading,
  login: screenLogin,
  noconfig: screenNoConfig,
  scopes: screenScopes,
  setup: screenSetup,
  create: screenCreate,
  created: screenCreated,
  noaccess: screenNoAccess,
  lost: screenLost,
  error: screenError,
  main: screenMain,
};

function render() {
  // Mantém abertas as tabelas (<details>) que o usuário abriu.
  const open = [...$app.querySelectorAll('details[data-key][open]')].map((d) => d.dataset.key);
  $app.innerHTML = SCREENS[ui.screen]();
  open.forEach((k) => $app.querySelector(`details[data-key="${k}"]`)?.setAttribute('open', ''));
}

db.subscribe(() => { if (ui.screen === 'main') render(); });

// ---------------------------------------------------------------------------
// Fluxos
// ---------------------------------------------------------------------------
function handleFatal(e) {
  if (e instanceof G.AuthError) { renewAuth(); return; }
  if (e instanceof G.NetError) { go('error', { offline: true }); return; }
  go('error', { message: e?.message });
}

function openSpace(id) {
  db.useSpace(id);
  go('main');
  db.sync();
}

async function createFlow(name, partner) {
  go('loading', { text: 'Criando a planilha do casal…' });
  try {
    await db.createSpace({ myName: name });
    db.useSpace(db.localSpaceId(me.email));
    db.sync();
    let shared = [];
    let error = '';
    if (partner) {
      try {
        await db.invite(partner);
        shared = [partner];
      } catch {
        error = 'A planilha foi criada, mas não conseguimos liberar o acesso para esse e-mail. Tente de novo abaixo.';
      }
    }
    ui.inviteShared = shared;
    go('created', { shared, error });
  } catch (e) {
    if (e instanceof G.ApiError) go('create', { error: `Não foi possível criar a planilha: ${e.message}` });
    else handleFatal(e);
  }
}

async function joinFlow(id) {
  go('loading', { text: 'Entrando no espaço do casal…' });
  try {
    const r = await db.joinSpace(id);
    if (!r.ok) { go('noaccess', { id, ...r }); return; }
    localStorage.removeItem('cad.invite');
    openSpace(id);
    toast('Pronto! Vocês estão conectados 💑', 3500);
  } catch (e) {
    handleFatal(e);
  }
}

async function enterSpace() {
  const invite = localStorage.getItem('cad.invite');
  let id = db.localSpaceId(me.email);
  if (invite && invite !== id) { joinFlow(invite); return; }
  if (invite) localStorage.removeItem('cad.invite');
  if (id) { openSpace(id); return; }
  go('loading', { text: 'Procurando seus dados…' });
  try {
    id = await db.discoverSpace();
  } catch (e) {
    handleFatal(e);
    return;
  }
  if (id) openSpace(id);
  else go('setup');
}

/** Renova o login sem mostrar nada (volta em ~1s). Espera fechar o formulário aberto. */
function renewAuth() {
  if (DEMO) return;
  if (ui.sheetOpen) { pendingRenew = true; return; }
  pendingRenew = false;
  const now = Date.now();
  const hist = JSON.parse(sessionStorage.getItem('cad.renews') || '[]').filter((t) => now - t < 120_000);
  if (hist.length >= 2) {
    // Evita ficar em loop se algo estiver errado com o login.
    sessionStorage.removeItem('cad.renews');
    auth.clearToken();
    go('login', { error: 'Sua sessão expirou. Entre de novo, por favor.' });
    return;
  }
  sessionStorage.setItem('cad.renews', JSON.stringify([...hist, now]));
  auth.clearToken();
  auth.signIn({ silent: true });
}

db.setHandlers({
  onAuthNeeded: renewAuth,
  onLostAccess: () => go('lost'),
  onError: (msg) => toast(msg, 4000),
});

function captureInvite() {
  const code = params.get('convite');
  if (!code) return;
  const id = parseInvite(`convite=${code}`);
  if (id) localStorage.setItem('cad.invite', id);
  params.delete('convite');
  const qs = params.toString();
  history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
}

async function startDemo() {
  const { createFakeGoogle, seedDemo } = await import('./fake-google.js');
  const fake = createFakeGoogle({ storage: localStorage, key: 'cad.demo.db' });
  me = { email: 'ana@demo.casal', name: 'Ana', picture: '' };
  G.configure({ fetch: fake.fetch, getToken: () => `demo:${me.email}` });
  db.setMe(me);
  let id = db.localSpaceId(me.email);
  if (!id) {
    go('loading', { text: 'Preparando a demonstração…' });
    id = await db.createSpace({ myName: 'Ana' });
    seedDemo(fake, id);
  }
  openSpace(id);
}

async function boot() {
  captureInvite();
  initTooltips();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    if (ui.screen === 'main') render();
  });

  if (DEMO) { await startDemo(); return; }
  if (!CONFIG.GOOGLE_CLIENT_ID) { go('noconfig'); return; }

  let back = auth.consumeRedirect();
  // Voltou para uma página antiga do Google pelo botão "voltar": ignora se já estamos logados.
  if (back?.error === 'state_mismatch' && auth.getToken() && auth.getUser()) back = null;
  if (back?.error) {
    const quiet = ['interaction_required', 'login_required', 'consent_required', 'account_selection_required'];
    const msg = quiet.includes(back.error) ? ''
      : back.error === 'access_denied' ? 'O login foi cancelado. Tente de novo quando quiser.'
        : 'Não foi possível entrar. Tente de novo.';
    go('login', { error: msg });
    return;
  }
  if (back?.ok && back.missingScopes.length) { go('scopes'); return; }

  if (!auth.getToken()) {
    if (auth.getUser() && !auth.silentTried()) {
      go('loading', { text: 'Entrando…' });
      auth.signIn({ silent: true });
      return;
    }
    go('login');
    return;
  }

  G.configure({ getToken: () => auth.getToken(0) });
  me = auth.getUser();
  if (!me || back?.ok) {
    go('loading', { text: 'Entrando…' });
    try {
      const info = await G.userInfo();
      me = { email: String(info.email).toLowerCase(), name: info.name || info.given_name || '', picture: info.picture || '' };
      auth.setUser(me);
    } catch (e) {
      handleFatal(e);
      return;
    }
  }
  db.setMe(me);
  await enterSpace();
}

// Mantém os dados atualizados: ao voltar para o app, ao reconectar e a cada 2 min.
let lastVisibleSync = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || ui.screen !== 'main') return;
  if (!DEMO && !auth.getToken(10 * 60_000) && !ui.sheetOpen) { renewAuth(); return; }
  if (Date.now() - lastVisibleSync > 10_000) {
    lastVisibleSync = Date.now();
    db.sync();
  }
});
window.addEventListener('online', () => { if (ui.screen === 'main') db.sync(); });
setInterval(() => {
  if (document.visibilityState === 'visible' && ui.screen === 'main' && (DEMO || auth.getToken(3 * 60_000))) db.sync();
}, 120_000);

boot().catch((e) => {
  console.error(e);
  go('error', { message: e?.message });
});
