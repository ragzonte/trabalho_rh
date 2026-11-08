// Camada de dados: a planilha do Google é o banco de dados.
//
// - Leitura: baixa as abas inteiras (é pouco dado para um casal) e guarda uma
//   cópia local para o app abrir instantaneamente, mesmo sem internet.
// - Escrita: toda alteração entra numa fila local ("outbox") e aparece na hora
//   na tela. A fila é enviada para a planilha assim que houver conexão.

import * as G from './google.js';
import { CONFIG } from './config.js';
import { normalizeDate, parseMoney, uid } from './format.js';

export const TABS = {
  tx: {
    title: 'Lancamentos', id: 101,
    header: ['id', 'data', 'tipo', 'valor', 'descricao', 'categoria', 'pessoa', 'criado_por', 'criado_em', 'atualizado_em'],
  },
  cat: { title: 'Categorias', id: 102, header: ['id', 'nome', 'tipo', 'icone'] },
  mem: { title: 'Membros', id: 103, header: ['email', 'nome', 'entrou_em'] },
  cfg: { title: 'Config', id: 104, header: ['chave', 'valor'] },
};

export const DEFAULT_CATEGORIES = [
  ['🏠', 'Moradia', 'despesa'],
  ['🛒', 'Mercado', 'despesa'],
  ['🍽️', 'Restaurantes', 'despesa'],
  ['🚗', 'Transporte', 'despesa'],
  ['💡', 'Contas', 'despesa'],
  ['💊', 'Saúde', 'despesa'],
  ['🎉', 'Lazer', 'despesa'],
  ['📚', 'Educação', 'despesa'],
  ['🛍️', 'Compras', 'despesa'],
  ['📦', 'Outros', 'despesa'],
  ['💰', 'Salário', 'receita'],
  ['✨', 'Extra', 'receita'],
  ['📈', 'Rendimentos', 'receita'],
  ['🎁', 'Outras receitas', 'receita'],
].map(([icone, nome, tipo]) => ({ icone, nome, tipo }));

const lastCol = (t) => String.fromCharCode(64 + t.header.length);
const dataRange = (t) => `${t.title}!A2:${lastCol(t)}`;

// Texto com apóstrofo inicial: o Sheets grava exatamente o texto (sem virar
// fórmula, número ou data). O apóstrofo não faz parte do valor salvo.
const txt = (s) => (s === undefined || s === null || s === '' ? '' : "'" + String(s));
const str = (v) => (v === undefined || v === null ? '' : String(v)).trim();

function txToRow(t) {
  return [txt(t.id), t.data, t.tipo, Number(t.valor) || 0, txt(t.descricao), txt(t.categoria),
    txt(t.pessoa), txt(t.criadoPor), txt(t.criadoEm), txt(t.atualizadoEm)];
}
function rowToTx(r) {
  const id = str(r[0]);
  const data = normalizeDate(r[1]);
  if (!id || !data) return null;
  return {
    id, data,
    tipo: str(r[2]).toLowerCase() === 'receita' ? 'receita' : 'despesa',
    valor: Math.abs(parseMoney(r[3])),
    descricao: str(r[4]),
    categoria: str(r[5]),
    pessoa: str(r[6]).toLowerCase(),
    criadoPor: str(r[7]).toLowerCase(),
    criadoEm: str(r[8]),
    atualizadoEm: str(r[9]),
  };
}
const catToRow = (c) => [txt(c.id), txt(c.nome), c.tipo, txt(c.icone)];
function rowToCat(r) {
  const id = str(r[0]);
  const nome = str(r[1]);
  if (!id || !nome) return null;
  return { id, nome, tipo: str(r[2]).toLowerCase() === 'receita' ? 'receita' : 'despesa', icone: str(r[3]) || '🏷️' };
}
const memToRow = (m) => [txt(m.email), txt(m.nome), txt(m.entrouEm)];
function rowToMem(r) {
  const email = str(r[0]).toLowerCase();
  return email ? { email, nome: str(r[1]), entrouEm: str(r[2]) } : null;
}

// ---------------- Estado observável ----------------

export const state = {
  spaceId: null,
  me: null, // { email, name, picture }
  tx: [],
  cats: [],
  members: [],
  ready: false, // já temos dados (do cache ou da planilha)
  syncing: false,
  pending: 0, // alterações ainda não enviadas
  offline: false,
  lastSync: 0,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((fn) => fn(state));

const handlers = { onAuthNeeded() {}, onLostAccess() {}, onError() {} };
export const setHandlers = (h) => Object.assign(handlers, h);

let base = { tx: [], cats: [], members: [] };
let outbox = [];
let sheetIds = null;

const readJSON = (k) => {
  try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
};
const cacheKey = () => `cad.cache.${state.spaceId}`;
const outboxKey = () => `cad.outbox.${state.spaceId}`;
const saveCache = () => localStorage.setItem(cacheKey(), JSON.stringify(base));
const saveOutbox = () => localStorage.setItem(outboxKey(), JSON.stringify(outbox));

export const localSpaceId = (email) => localStorage.getItem(`cad.space.${email}`);
const rememberSpace = (email, id) => localStorage.setItem(`cad.space.${email}`, id);

export function forgetSpace() {
  if (state.me) localStorage.removeItem(`cad.space.${state.me.email}`);
  if (state.spaceId) {
    localStorage.removeItem(cacheKey());
    localStorage.removeItem(outboxKey());
  }
  Object.assign(state, { spaceId: null, tx: [], cats: [], members: [], ready: false, pending: 0 });
  base = { tx: [], cats: [], members: [] };
  outbox = [];
  sheetIds = null;
  memberChecked = false;
}

export const setMe = (me) => { state.me = me; };

function applyOp(d, op) {
  switch (op.type) {
    case 'addTx':
      if (!d.tx.some((t) => t.id === op.tx.id)) d.tx.push(op.tx);
      break;
    case 'updateTx':
      d.tx = d.tx.map((t) => (t.id === op.tx.id ? op.tx : t));
      break;
    case 'deleteTx':
      d.tx = d.tx.filter((t) => t.id !== op.id);
      break;
    case 'addCat':
      if (!d.cats.some((c) => c.id === op.cat.id)) d.cats.push(op.cat);
      break;
    case 'updateCat':
      d.cats = d.cats.map((c) => (c.id === op.cat.id ? op.cat : c));
      if (op.oldName && op.oldName !== op.cat.nome) {
        d.tx = d.tx.map((t) => (t.categoria === op.oldName && t.tipo === op.cat.tipo ? { ...t, categoria: op.cat.nome } : t));
      }
      break;
    case 'deleteCat':
      d.cats = d.cats.filter((c) => c.id !== op.id);
      break;
    case 'upsertMember': {
      const i = d.members.findIndex((m) => m.email === op.member.email);
      if (i >= 0) d.members[i] = { ...d.members[i], ...op.member };
      else d.members.push(op.member);
      break;
    }
    default:
  }
}

function recompute() {
  const d = { tx: [...base.tx], cats: [...base.cats], members: [...base.members] };
  for (const op of outbox) applyOp(d, op);
  state.tx = d.tx;
  state.cats = d.cats;
  state.members = d.members;
  state.pending = outbox.length;
}

/** Carrega o cache local de uma planilha. Retorna true se havia cache. */
export function useSpace(spaceId) {
  state.spaceId = spaceId;
  sheetIds = null;
  memberChecked = false;
  const cached = readJSON(cacheKey());
  base = cached || { tx: [], cats: [], members: [] };
  outbox = readJSON(outboxKey()) || [];
  state.ready = !!cached;
  recompute();
  emit();
  return !!cached;
}

// ---------------- Criar / entrar / descobrir ----------------

async function loadSheetIds(spaceId) {
  const meta = await G.sheetsMeta(spaceId);
  const ids = {};
  for (const s of meta.sheets || []) ids[s.properties.title] = s.properties.sheetId;
  const missing = Object.values(TABS).filter((t) => t.title !== TABS.cfg.title && ids[t.title] === undefined);
  if (missing.length) {
    throw new G.ApiError(422, `A planilha não tem as abas esperadas (${missing.map((t) => t.title).join(', ')}).`);
  }
  return ids;
}

/** Confere se o usuário atual consegue abrir a planilha. */
export async function checkAccess(spaceId) {
  try {
    await loadSheetIds(spaceId);
    return { ok: true };
  } catch (e) {
    if (e instanceof G.ApiError && [403, 404].includes(e.status)) return { ok: false, reason: 'no-access' };
    if (e instanceof G.ApiError && e.status === 422) return { ok: false, reason: 'invalid', message: e.message };
    throw e;
  }
}

async function rememberEverywhere(spaceId) {
  rememberSpace(state.me.email, spaceId);
  try { await G.writeAppConfig({ spreadsheetId: spaceId, salvoEm: new Date().toISOString() }); } catch { /* opcional */ }
}

/** Procura no Drive do usuário (pasta oculta do app) qual planilha ele usa. */
export async function discoverSpace() {
  let cfg;
  try { cfg = await G.readAppConfig(); } catch (e) {
    if (e instanceof G.AuthError || e instanceof G.NetError) throw e;
    return null;
  }
  const id = cfg?.data?.spreadsheetId;
  if (!id) return null;
  const access = await checkAccess(id);
  if (!access.ok) return null;
  rememberSpace(state.me.email, id);
  return id;
}

export async function createSpace({ myName }) {
  const me = state.me;
  const file = await G.createSpreadsheetFile(CONFIG.SPREADSHEET_TITLE, { contasADois: '1' });
  const id = file.id;
  const meta = await G.sheetsMeta(id);
  const oldSheets = (meta.sheets || []).map((s) => s.properties.sheetId);
  const tabs = Object.values(TABS);
  const tx = TABS.tx.id;
  await G.batchUpdate(id, [
    {
      updateSpreadsheetProperties: {
        properties: { locale: 'pt_BR', timeZone: 'America/Sao_Paulo' },
        fields: 'locale,timeZone',
      },
    },
    ...tabs.map((t) => ({
      addSheet: { properties: { sheetId: t.id, title: t.title, gridProperties: { frozenRowCount: 1 } } },
    })),
    ...oldSheets.map((sheetId) => ({ deleteSheet: { sheetId } })),
    ...tabs.map((t) => ({
      repeatCell: {
        range: { sheetId: t.id, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    })),
    {
      repeatCell: {
        range: { sheetId: tx, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
    {
      repeatCell: {
        range: { sheetId: tx, startRowIndex: 1, startColumnIndex: 3, endColumnIndex: 4 },
        cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '"R$" #,##0.00' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
  ]);
  const now = new Date().toISOString();
  const block = (t, rows) => ({ range: `${t.title}!A1:${lastCol(t)}${rows.length}`, values: rows });
  await G.valuesBatchUpdate(id, [
    block(TABS.tx, [TABS.tx.header]),
    block(TABS.cat, [TABS.cat.header, ...DEFAULT_CATEGORIES.map((c) => catToRow({ ...c, id: uid() }))]),
    block(TABS.mem, [TABS.mem.header, memToRow({ email: me.email, nome: myName, entrouEm: now })]),
    block(TABS.cfg, [
      TABS.cfg.header,
      ['versao', 1],
      ['criado_em', txt(now)],
      ['criado_por', txt(me.email)],
      ['aviso', txt('Não renomeie as abas nem a linha de títulos. Os dados podem ser editados à vontade.')],
    ]),
  ]);
  await rememberEverywhere(id);
  return id;
}

/** Entra numa planilha já compartilhada com este usuário. */
export async function joinSpace(spaceId) {
  const access = await checkAccess(spaceId);
  if (!access.ok) return access;
  await rememberEverywhere(spaceId);
  return { ok: true };
}

export function invite(email) {
  const msg = `${state.me?.name || 'Seu amor'} te convidou para o ${CONFIG.APP_NAME}. Abra o link do convite que te mandei e entre com esta conta Google.`;
  return G.shareWith(state.spaceId, email.trim().toLowerCase(), msg);
}

// ---------------- Sincronização ----------------

async function ensureSheetIds() {
  if (!sheetIds) sheetIds = await loadSheetIds(state.spaceId);
}

async function findRow(tab, key) {
  const r = await G.getValues(state.spaceId, `${tab.title}!A:A`);
  const vals = r?.values || [];
  const k = String(key).toLowerCase();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i]?.[0] ?? '').trim().toLowerCase() === k) return i + 1;
  }
  return 0;
}

async function addRow(tab, op, key, row) {
  // Se uma tentativa anterior caiu no meio, confere se a linha já foi gravada.
  if (op.tries && (await findRow(tab, key))) return;
  op.tries = (op.tries || 0) + 1;
  saveOutbox();
  await G.appendRows(state.spaceId, `${tab.title}!A:${lastCol(tab)}`, [row]);
}

async function updateRow(tab, key, row) {
  const n = await findRow(tab, key);
  if (!n) return false;
  await G.updateRows(state.spaceId, `${tab.title}!A${n}:${lastCol(tab)}${n}`, [row]);
  return true;
}

async function deleteRow(tab, key) {
  const n = await findRow(tab, key);
  if (!n) return;
  await G.batchUpdate(state.spaceId, [{
    deleteDimension: { range: { sheetId: sheetIds[tab.title], dimension: 'ROWS', startIndex: n - 1, endIndex: n } },
  }]);
}

async function renameCategoryInTx(oldName, newName, tipo) {
  const r = await G.getValues(state.spaceId, `${TABS.tx.title}!A2:F`);
  const data = [];
  (r?.values || []).forEach((row, i) => {
    if (str(row[5]) === oldName && str(row[2]).toLowerCase() === tipo) {
      data.push({ range: `${TABS.tx.title}!F${i + 2}`, values: [[txt(newName)]] });
    }
  });
  if (data.length) await G.valuesBatchUpdate(state.spaceId, data);
}

async function execOp(op) {
  switch (op.type) {
    case 'addTx': return addRow(TABS.tx, op, op.tx.id, txToRow(op.tx));
    case 'updateTx': return updateRow(TABS.tx, op.tx.id, txToRow(op.tx));
    case 'deleteTx': return deleteRow(TABS.tx, op.id);
    case 'addCat': return addRow(TABS.cat, op, op.cat.id, catToRow(op.cat));
    case 'updateCat':
      await updateRow(TABS.cat, op.cat.id, catToRow(op.cat));
      if (op.oldName && op.oldName !== op.cat.nome) await renameCategoryInTx(op.oldName, op.cat.nome, op.cat.tipo);
      return undefined;
    case 'deleteCat': return deleteRow(TABS.cat, op.id);
    case 'upsertMember':
      if (!(await updateRow(TABS.mem, op.member.email, memToRow(op.member)))) {
        await addRow(TABS.mem, op, op.member.email, memToRow(op.member));
      }
      return undefined;
    default: return undefined;
  }
}

async function flushAll() {
  if (!outbox.length) return;
  await ensureSheetIds();
  while (outbox.length) {
    const op = outbox[0];
    try {
      await execOp(op);
    } catch (e) {
      if (e instanceof G.ApiError && !e.transient) {
        // Erro definitivo (ex.: linha inválida): descarta para não travar a fila.
        outbox.shift();
        saveOutbox();
        handlers.onError(`Não foi possível salvar uma alteração: ${e.message}`);
        continue;
      }
      throw e;
    }
    outbox.shift();
    applyOp(base, op);
    saveOutbox();
    saveCache();
  }
}

async function fetchAll() {
  await ensureSheetIds();
  const r = await G.batchGet(state.spaceId, [dataRange(TABS.tx), dataRange(TABS.cat), dataRange(TABS.mem)]);
  const [tx = [], cats = [], mem = []] = (r?.valueRanges || []).map((v) => v.values || []);
  base = {
    tx: tx.map(rowToTx).filter(Boolean),
    cats: cats.map(rowToCat).filter(Boolean),
    members: mem.map(rowToMem).filter(Boolean),
  };
  saveCache();
  state.lastSync = Date.now();
  state.ready = true;
}

let running = null;
let rerun = false;
let rerunFetch = false;

/**
 * Envia a fila de alterações e (opcionalmente) baixa os dados da planilha.
 * Nunca lança erro: problemas viram estado (offline) ou avisos.
 */
export function sync({ fetch = true } = {}) {
  if (!state.spaceId) return Promise.resolve();
  if (running) {
    rerun = true;
    rerunFetch = rerunFetch || fetch;
    return running;
  }
  running = (async () => {
    let doFetch = fetch;
    let fetched = false;
    state.syncing = true;
    emit();
    try {
      do {
        rerun = false;
        await flushAll();
        if (doFetch) {
          await fetchAll();
          fetched = true;
        }
        doFetch = rerunFetch;
        rerunFetch = false;
      } while (rerun);
      state.offline = false;
    } catch (e) {
      if (e instanceof G.NetError) state.offline = true;
      else if (e instanceof G.AuthError) handlers.onAuthNeeded();
      else if (e instanceof G.ApiError && [403, 404].includes(e.status)) handlers.onLostAccess();
      else handlers.onError(e.message || 'Erro ao sincronizar');
    } finally {
      recompute();
      state.syncing = false;
      running = null;
      emit();
    }
    if (fetched) ensureMember();
    if (rerun) {
      const f = rerunFetch;
      rerun = false;
      rerunFetch = false;
      sync({ fetch: f });
    }
  })();
  return running;
}

function enqueue(op) {
  op.opId = uid();
  outbox.push(op);
  saveOutbox();
  recompute();
  emit();
  sync({ fetch: false });
}

let memberChecked = false;
function ensureMember() {
  if (memberChecked || !state.me || !state.ready) return;
  memberChecked = true;
  if (!state.members.some((m) => m.email === state.me.email)) {
    enqueue({
      type: 'upsertMember',
      member: { email: state.me.email, nome: state.me.name || state.me.email.split('@')[0], entrouEm: new Date().toISOString() },
    });
  }
}

// ---------------- Alterações (usadas pelas telas) ----------------

export function saveTx(data) {
  const now = new Date().toISOString();
  const existing = data.id && state.tx.find((t) => t.id === data.id);
  if (existing) {
    enqueue({ type: 'updateTx', tx: { ...existing, ...data, atualizadoEm: now } });
  } else {
    enqueue({
      type: 'addTx',
      tx: { ...data, id: uid(), criadoPor: state.me.email, criadoEm: now, atualizadoEm: '' },
    });
  }
}

export const deleteTx = (id) => enqueue({ type: 'deleteTx', id });

/** Ids de lançamentos com alteração ainda não enviada para a planilha. */
export function pendingTxIds() {
  return new Set(outbox.filter((o) => o.tx).map((o) => o.tx.id));
}

export function saveCat(data) {
  const existing = data.id && state.cats.find((c) => c.id === data.id);
  if (existing) enqueue({ type: 'updateCat', cat: { ...existing, ...data }, oldName: existing.nome });
  else enqueue({ type: 'addCat', cat: { ...data, id: uid() } });
}

export const deleteCat = (id) => enqueue({ type: 'deleteCat', id });

export function setMyName(nome) {
  const current = state.members.find((m) => m.email === state.me.email) || { email: state.me.email, entrouEm: new Date().toISOString() };
  enqueue({ type: 'upsertMember', member: { ...current, nome } });
}
