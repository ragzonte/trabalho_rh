// Contas a Dois — telas, navegação e fluxo de conexão com a planilha.
// Sem login: o app fala com a planilha pelo link /exec do script da planilha.

import { CONFIG } from './config.js';
import * as api from './api.js';
import * as db from './db.js';
import * as S from './stats.js';
import * as native from './native.js';
import {
  brl, esc, monthLabel, dayLabel, currentMonth, addMonths, monthOf, todayISO, yesterdayISO,
  maskCents, timeLabel,
} from './format.js';
import { rankedBars, segmentedBar, columnsChart, initTooltips } from './charts.js';

const VERSION = '2.0.0';
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

// ---------------------------------------------------------------------------
// Ícones
// ---------------------------------------------------------------------------
const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  home: icon('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  list: icon('<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  chart: icon('<path d="M3 21h18M6 17v-5M11 17V7M16 17v-8M21 17v-3"/>'),
  more: icon('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
};

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

const logo = '<img class="logo" src="icons/icon.svg" alt="">';

function inviteText() {
  const apk = CONFIG.APK_URL ? `\n\n1) Instale o app: ${CONFIG.APK_URL}` : '';
  return `Vamos organizar nossas contas juntos no ${CONFIG.APP_NAME}! 💑${apk}\n${apk ? '2) ' : ''}Abra o app e cole este link:\n${db.state.link}`;
}

async function shareInvite() {
  const r = await native.share(inviteText());
  if (r === 'copied') toast('Convite copiado ✓ Cole no WhatsApp');
  else if (r === 'failed') openInviteSheet();
}

// ---------------------------------------------------------------------------
// Telas de entrada: conectar a planilha e escolher quem é você
// ---------------------------------------------------------------------------
function screenLoading() {
  return `<div class="welcome" style="text-align:center"><div class="spinner" style="margin:0 auto 16px"></div>
    <p class="lead">${esc(ui.data.text || 'Carregando…')}</p></div>`;
}

function screenConnect() {
  const err = ui.data.error;
  return `<form class="welcome" data-form="connect" novalidate>
    ${logo}
    <h1>${esc(CONFIG.APP_NAME)}</h1>
    <p class="lead">As finanças do casal num lugar só. Cola o link da planilha de vocês e pronto, sem login.</p>
    <label class="field"><span>Link da planilha do casal</span>
      <div class="row"><input class="input" name="link" value="${esc(ui.data.link || '')}" autocomplete="off" autocapitalize="off" spellcheck="false"
        placeholder="https://script.google.com/macros/s/…/exec">
      <button class="btn secondary" type="button" data-action="paste-link" style="flex:0 0 auto;width:auto">Colar</button></div></label>
    ${err ? `<p class="error-text">${err}</p>` : ''}
    <button class="btn" type="submit">Conectar</button>
    <div class="card" style="margin-top:22px">
      <h2>Ainda não tem o link?</h2>
      <p class="hint" style="margin:0 0 14px">Um de vocês cria a planilha uma vez (no computador, uns 3 minutos) e manda o link para o outro.</p>
      <button class="btn secondary" type="button" data-action="open-guide">Ver como criar</button>
    </div>
    <button class="link" type="button" data-action="demo">Ver uma demonstração</button>
  </form>`;
}

function screenWho() {
  const members = db.state.members;
  return `<form class="welcome" data-form="who" novalidate>
    ${logo}
    <h1>Quem é você?</h1>
    <p class="lead">Cada um escolhe o próprio nome. Os lançamentos ficam marcados com quem ganhou ou gastou.</p>
    ${members.length ? `<div class="card" style="padding-top:4px;padding-bottom:4px"><ul class="list">
      ${S.people(db.state).filter((p) => members.some((m) => m.nome === p.nome)).map((p) => `<li><button type="button" class="list-item" data-action="pick-me" data-name="${esc(p.nome)}">
        <span class="avatar" style="box-shadow:0 0 0 2px ${p.color}">${esc(p.nome.charAt(0).toUpperCase())}</span>
        <span class="grow"><b>${esc(p.nome)}</b></span><span class="chev">Sou eu ›</span></button></li>`).join('')}
    </ul></div>` : ''}
    <label class="field"><span>${members.length ? 'Ou, se for novo(a) aqui, digite seu nome' : 'Seu nome'}</span>
      <input class="input" name="nome" maxlength="40" autocomplete="given-name" placeholder="Ex.: Ana"></label>
    ${ui.data.error ? `<p class="error-text">${esc(ui.data.error)}</p>` : ''}
    <button class="btn" type="submit">Entrar</button>
    <button class="link" type="button" data-action="disconnect" style="margin-top:16px">Usar outro link</button>
  </form>`;
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
          <span class="name">${esc(p.person.label)}${p.person.nome === db.state.me ? ' <small style="color:var(--ink-muted);font-weight:400">(você)</small>' : ''}</span>
          <span class="bal">${brl(p.saldo)}</span>
          <span class="sub"><span>Ganhou ${brl(p.receitas)}</span><span>Gastou ${brl(p.despesas)}</span></span>
        </div>`).join('')}
      </div>
      ${t.despesas > 0 && persons.length > 1 ? `<div style="font-size:13px;color:var(--ink-2);margin-bottom:6px">Quem pagou as despesas</div>
        ${segmentedBar(persons.map((p) => ({ label: p.person.label, valor: p.despesas, color: p.person.color })), { label: 'Despesas' })}` : ''}
      ${solo ? '<button class="btn secondary" data-action="open-invite" style="margin-top:4px">💌 Mandar o link para meu amor</button>' : ''}
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

    return hero + peopleCard + catCard + recentCard;
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
      ${chip('person', '', 'Todos')}${list.map((p) => chip('person', p.nome, p.label, `<i class="mdot" style="background:${p.color}"></i>`)).join('')}
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
      <div class="chips">${chip('', 'Todos')}${list.map((p) => chip(p.nome, p.label, `<i class="mdot" style="background:${p.color}"></i>`)).join('')}</div>

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
    const avatar = (p) => `<span class="avatar" style="box-shadow:0 0 0 2px ${p.color}">${esc(p.label.charAt(0).toUpperCase())}</span>`;
    return `
      <div class="section-title">Vocês</div>
      <section class="card" style="padding-top:4px;padding-bottom:4px"><ul class="list">
        ${list.map((p) => `<li><button class="list-item" ${p.nome === st.me ? 'data-action="edit-name"' : 'disabled'}>
          ${avatar(p)}
          <span class="grow"><b>${esc(p.label)}</b>${p.nome === st.me ? ' (você)' : ''}</span>
          ${p.nome === st.me ? '<span class="chev">Mudar nome</span>' : ''}
        </button></li>`).join('')}
        <li><button class="list-item" data-action="open-invite"><span class="avatar">💌</span>
          <span class="grow"><b>Mandar o link para meu amor</b><div class="sub">É só ele(a) instalar o app e colar o link</div></span><span class="chev">›</span></button></li>
      </ul></section>

      <div class="section-title">Organização</div>
      <section class="card" style="padding-top:4px;padding-bottom:4px"><ul class="list">
        <li><button class="list-item" data-action="open-cats"><span class="avatar">🏷️</span>
          <span class="grow"><b>Categorias</b><div class="sub">${st.cats.length} categorias · criar, editar e remover</div></span><span class="chev">›</span></button></li>
        ${st.planilha ? `<li><button class="list-item" data-action="open-planilha"><span class="avatar">📊</span>
          <span class="grow"><b>Abrir a planilha</b><div class="sub">Ver e editar os dados no Google Sheets</div></span><span class="chev">↗</span></button></li>` : ''}
      </ul></section>

      <div class="section-title">Sincronização</div>
      <section class="card">
        <p style="margin:0 0 12px">${esc(last)}${st.pending ? ` · ${st.pending} alteração(ões) aguardando envio` : ''}</p>
        <button class="btn secondary" data-action="sync">Sincronizar agora</button>
      </section>

      <div class="section-title">Este celular</div>
      <section class="card">
        <p style="margin:0 0 12px">Você está como <b>${esc(st.me || '—')}</b>.</p>
        <button class="btn secondary" data-action="not-me">Não sou ${esc(st.me || 'eu')}</button>
        ${DEMO ? '<button class="btn secondary" data-action="exit-demo">Sair da demonstração</button>'
          : '<button class="btn danger" data-action="disconnect">Desconectar deste celular</button>'}
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
    pessoa: t?.pessoa || db.state.me,
    data: t?.data || defaultDate(),
  };
  const list = S.people(db.state);
  if (db.state.me && !list.some((p) => p.nome === db.state.me)) list.unshift({ nome: db.state.me, label: db.state.me, color: 'var(--c-mem1)' });

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
    <div class="field"><span>Quem</span><div class="chips" id="who">${list.map((p) => `<button type="button" class="chip" data-who="${esc(p.nome)}" aria-pressed="${p.nome === f.pessoa}"><i class="mdot" style="background:${p.color}"></i>${esc(p.label)}</button>`).join('')}</div></div>
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

// ----- Nome, convite e guia -----
function openNameSheet() {
  openSheet('Seu nome', `<form data-form="name" novalidate>
    <label class="field"><span>Como você aparece para o casal</span>
      <input class="input" name="nome" maxlength="40" required value="${esc(db.state.me || '')}"></label>
    <p class="hint">Os seus lançamentos antigos passam a usar o nome novo.</p>
    <p class="error-text" id="name-error" hidden></p>
    <button class="btn" type="submit">Salvar</button></form>`, (root) => {
    const form = root.querySelector('form');
    const err = root.querySelector('#name-error');
    form.nome.focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const nome = form.nome.value.trim().replace(/\s+/g, ' ');
      if (!nome) return;
      const taken = db.state.members.some((m) => m.nome !== db.state.me && m.nome.toLowerCase() === nome.toLowerCase());
      if (taken) { err.textContent = 'Já tem alguém com esse nome.'; err.hidden = false; return; }
      db.renameMe(nome);
      closeSheet();
      toast('Nome atualizado ✓');
    });
  });
}

function openInviteSheet() {
  openSheet('Mandar o link', `
    <ol class="steps">
      <li>Seu amor instala o app${CONFIG.APK_URL ? ' (o link para baixar vai junto na mensagem)' : ''}.</li>
      <li>Abre o app e cola este link.</li>
      <li>Escolhe “Quem é você?” e pronto! 💑</li>
    </ol>
    <div class="linkbox"><span style="flex:1">${esc(db.state.link)}</span></div>
    <button class="btn" data-action="share-invite">Enviar pelo WhatsApp…</button>
    <button class="btn secondary" data-action="copy-invite">Copiar só o link</button>
    <p class="hint" style="margin-top:14px">🔒 Quem tiver este link consegue ver e editar as contas. Mande só para o seu amor.</p>`);
}

let codeCache = '';
async function scriptCode() {
  if (!codeCache) codeCache = await (await fetch('apps-script/Codigo.gs')).text();
  return codeCache;
}

function openGuideSheet() {
  openSheet('Criar a planilha do casal', `
    <p class="hint" style="margin:0 0 12px">Faça uma vez só, num computador (no celular o Google não mostra essas opções).</p>
    <ol class="steps">
      <li>Abra <b>sheets.new</b> no navegador: cria uma planilha nova no seu Google Drive. Dê um nome, por exemplo <i>Contas a Dois</i>.</li>
      <li>No menu da planilha, clique em <b>Extensões → Apps Script</b>.</li>
      <li>Apague o que estiver lá, cole o <b>código do app</b> (botões abaixo) e salve 💾.</li>
      <li>Clique em <b>Implantar → Nova implantação</b>. Na engrenagem ⚙️, escolha <b>App da Web</b> e deixe:
        <br>• Executar como: <b>Eu</b>
        <br>• Quem pode acessar: <b>Qualquer pessoa</b></li>
      <li>Clique em <b>Implantar → Autorizar acesso</b> e escolha sua conta. Se aparecer “O Google não verificou este app”, clique em <b>Avançado → Acessar</b> (é o seu próprio script).</li>
      <li>Copie o <b>URL do app da Web</b> (termina em <b>/exec</b>), mande para o celular de vocês dois e cole no app.</li>
    </ol>
    <button class="btn" data-action="share-code">Enviar o código para o computador</button>
    <button class="btn secondary" data-action="copy-code">Copiar o código</button>
    <p class="hint" style="margin-top:12px">“Enviar” abre o WhatsApp ou o e-mail: mande para você mesmo e abra no computador.</p>`);
}

// ---------------------------------------------------------------------------
// Ações (cliques)
// ---------------------------------------------------------------------------
const actions = {
  'paste-link': async () => {
    const text = await native.readClipboard();
    const input = document.querySelector('form[data-form="connect"] input[name="link"]');
    if (text && input) input.value = text.trim();
    else toast('Não consegui ler a área de transferência. Toque e segure no campo para colar.');
  },
  'open-guide': () => openGuideSheet(),
  'share-code': async () => {
    const r = await native.share(await scriptCode());
    if (r === 'copied') toast('Código copiado ✓');
  },
  'copy-code': async () => toast((await native.copy(await scriptCode())) ? 'Código copiado ✓' : 'Não foi possível copiar'),
  demo: () => { localStorage.setItem('cad.demo', '1'); location.reload(); },
  'exit-demo': () => {
    Object.keys(localStorage).filter((k) => k.startsWith('cad.demo')).forEach((k) => localStorage.removeItem(k));
    location.replace(location.pathname);
  },
  'pick-me': (el) => enterAs(el.dataset.name),
  'not-me': () => { db.forgetMe(); go('who'); },
  disconnect: () => {
    if (ui.screen === 'main' && !window.confirm('Desconectar este celular da planilha? Os dados continuam salvos na planilha.')) return;
    db.disconnect();
    go('connect');
  },
  'open-invite': () => openInviteSheet(),
  'share-invite': () => shareInvite(),
  'copy-invite': async () => toast((await native.copy(db.state.link)) ? 'Link copiado ✓' : 'Não foi possível copiar'),
  'open-planilha': () => (DEMO ? toast('Na demonstração não há planilha de verdade.') : native.openExternal(db.state.planilha)),
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
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el, e);
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  const kind = form.dataset.form;
  if (kind === 'connect') {
    e.preventDefault();
    connectFlow(form.link.value);
  } else if (kind === 'who') {
    e.preventDefault();
    const nome = form.nome.value.trim().replace(/\s+/g, ' ');
    if (!nome) { go('who', { error: 'Digite seu nome ou escolha na lista.' }); return; }
    enterAs(nome);
  }
});

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------
const SCREENS = {
  loading: screenLoading,
  connect: screenConnect,
  who: screenWho,
  main: screenMain,
};

function render() {
  // Mantém abertas as tabelas (<details>) que o usuário abriu.
  const open = [...$app.querySelectorAll('details[data-key][open]')].map((d) => d.dataset.key);
  $app.innerHTML = SCREENS[ui.screen]();
  open.forEach((k) => $app.querySelector(`details[data-key="${k}"]`)?.setAttribute('open', ''));
}

db.subscribe(() => { if (ui.screen === 'main') render(); });
db.setHandlers({ onError: (msg) => toast(msg, 4500) });

// ---------------------------------------------------------------------------
// Fluxos
// ---------------------------------------------------------------------------
const LINK_ERRORS = {
  planilha: 'Esse é o link da <b>planilha</b>. O Google não deixa gravar nela só com esse link. '
    + 'Use o link do <b>script da planilha</b>, que termina em <b>/exec</b> — veja “Ver como criar”.',
  dev: 'Esse é o link de <b>teste</b> (termina em /dev). Use o link da implantação, que termina em <b>/exec</b>.',
  invalido: 'Não reconheci esse link. Ele começa com <b>https://script.google.com/macros/s/</b> e termina em <b>/exec</b>.',
};

async function connectFlow(text) {
  const parsed = api.parseLink(text);
  if (parsed.error) { go('connect', { link: text, error: LINK_ERRORS[parsed.error] }); return; }
  go('loading', { text: 'Conectando à planilha…' });
  try {
    await db.connect(parsed.url);
  } catch (e) {
    let error = esc(e.message);
    if (e instanceof api.NetError) {
      error = navigator.onLine === false
        ? 'Sem internet. Conecte-se e tente de novo.'
        : 'Não consegui falar com a planilha. Confira se, na implantação, <b>Quem pode acessar</b> está como <b>Qualquer pessoa</b> e se o link termina em <b>/exec</b>.';
    } else if (e instanceof api.ServerError && e.notOurs) {
      error = 'Esse link não respondeu como o Contas a Dois. Confira se colou o código do app no Apps Script, salvou e implantou como <b>App da Web</b>.';
    } else if (e instanceof api.ServerError) {
      error = `A planilha respondeu com erro: ${esc(e.message)}`;
    }
    go('connect', { link: text, error });
    return;
  }
  go('who');
}

function enterAs(nome) {
  db.setMe(nome);
  ui.tab = 'inicio';
  go('main');
  toast(`Oi, ${db.state.me}! 👋`);
  if (db.state.members.length < 2) setTimeout(() => toast('Agora mande o link para o seu amor em Ajustes 💌', 4000), 2800);
}

async function setupDemo() {
  const code = await scriptCode();
  const { createScriptServer, seedDemo } = await import('./fake-sheets.js');
  const fresh = !localStorage.getItem('cad.demo.sheets');
  const server = createScriptServer(code, { storage: localStorage, key: 'cad.demo.sheets' });
  if (fresh) {
    server.get({ acao: 'dados' });
    seedDemo(server);
    localStorage.setItem('cad.demo.link', 'https://script.google.com/macros/s/DEMONSTRACAO-contas-a-dois/exec');
    localStorage.setItem('cad.demo.eu', 'Ana');
  }
  api.setTransport(async (url, { method, body }) => {
    await new Promise((r) => setTimeout(r, 150));
    const res = method === 'POST' ? server.post(body) : server.get({ acao: 'dados' });
    const json = JSON.parse(res.body);
    if (!json.ok) throw new api.ServerError(json.erro);
    return json;
  });
}

async function boot() {
  initTooltips();
  if (!native.isAndroidApp && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  if (DEMO) await setupDemo();
  db.load(DEMO ? 'cad.demo.' : 'cad.');
  const st = db.state;
  if (!st.link) { go('connect'); return; }
  if (!st.me) {
    if (!st.ready) {
      go('loading', { text: 'Conectando à planilha…' });
      try { await db.connect(st.link); } catch { /* mostra a lista do cache, se houver */ }
    }
    go('who');
    return;
  }
  go('main');
  db.sync();
}

// Mantém os dados atualizados: ao voltar para o app, ao reconectar e a cada 2 min.
let lastVisibleSync = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || ui.screen !== 'main') return;
  if (Date.now() - lastVisibleSync > 5_000) {
    lastVisibleSync = Date.now();
    db.sync();
  }
});
window.addEventListener('online', () => { if (ui.screen === 'main') db.sync(); });
setInterval(() => {
  if (document.visibilityState === 'visible' && ui.screen === 'main') db.sync();
}, 120_000);

boot().catch((e) => {
  console.error(e);
  go('connect', { error: `Erro ao abrir: ${esc(e?.message || e)}` });
});
