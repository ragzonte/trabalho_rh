// Camada de dados: a planilha (via script /exec) é o banco de dados.
//
// - Leitura: baixa tudo de uma vez (é pouco dado para um casal) e guarda uma
//   cópia no celular para o app abrir na hora, mesmo sem internet.
// - Escrita: cada alteração entra numa fila local e aparece na hora na tela.
//   A fila é enviada em lote para a planilha assim que houver conexão.
//   O script aplica tudo com trava, então os dois podem lançar ao mesmo tempo.

import * as api from './api.js';
import { uid } from './format.js';

export const state = {
  link: null,
  me: null, // nome de quem usa este celular
  tx: [],
  cats: [],
  members: [],
  planilha: '', // endereço da planilha no Google Sheets
  ready: false,
  syncing: false,
  pending: 0,
  offline: false,
  lastSync: 0,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = () => listeners.forEach((fn) => fn(state));

const handlers = { onError() {} };
export const setHandlers = (h) => Object.assign(handlers, h);

let prefix = 'cad.';
const K = (k) => `${prefix}${k}`;
const readJSON = (k) => {
  try { return JSON.parse(localStorage.getItem(K(k))); } catch { return null; }
};
const writeJSON = (k, v) => localStorage.setItem(K(k), JSON.stringify(v));

let base = { tx: [], cats: [], members: [] };
let outbox = [];
const saveOutbox = () => writeJSON('outbox', outbox);

const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/** Carrega o que está salvo no celular. `storagePrefix` separa a demonstração dos dados reais. */
export function load(storagePrefix = 'cad.') {
  prefix = storagePrefix;
  state.link = localStorage.getItem(K('link'));
  state.me = localStorage.getItem(K('eu'));
  const cache = readJSON('cache');
  if (cache?.base) {
    base = cache.base;
    state.planilha = cache.planilha || '';
    state.lastSync = cache.lastSync || 0;
    state.ready = true;
  }
  outbox = readJSON('outbox') || [];
  recompute();
}

function setBase(data) {
  base = { tx: data.lancamentos || [], cats: data.categorias || [], members: data.membros || [] };
  state.planilha = data.planilha || '';
  state.lastSync = Date.now();
  state.ready = true;
  writeJSON('cache', { base, planilha: state.planilha, lastSync: state.lastSync });
  recompute();
}

function applyOp(d, op) {
  switch (op.acao) {
    case 'addTx':
      if (!d.tx.some((t) => t.id === op.tx.id)) d.tx.push(op.tx);
      break;
    case 'updateTx':
      if (d.tx.some((t) => t.id === op.tx.id)) d.tx = d.tx.map((t) => (t.id === op.tx.id ? op.tx : t));
      else d.tx.push(op.tx);
      break;
    case 'deleteTx':
      d.tx = d.tx.filter((t) => t.id !== op.id);
      break;
    case 'addCat':
      if (!d.cats.some((c) => c.id === op.cat.id)) d.cats.push(op.cat);
      break;
    case 'updateCat':
      d.cats = d.cats.map((c) => (c.id === op.cat.id ? op.cat : c));
      if (op.nomeAntigo && op.nomeAntigo !== op.cat.nome) {
        d.tx = d.tx.map((t) => (t.categoria === op.nomeAntigo && t.tipo === op.cat.tipo ? { ...t, categoria: op.cat.nome } : t));
      }
      break;
    case 'deleteCat':
      d.cats = d.cats.filter((c) => c.id !== op.id);
      break;
    case 'addMembro':
      if (!d.members.some((m) => sameName(m.nome, op.nome))) d.members.push({ nome: op.nome, entrouEm: op.entrouEm });
      break;
    case 'renomearMembro':
      if (!d.members.some((m) => sameName(m.nome, op.para))) {
        d.members = d.members.map((m) => (sameName(m.nome, op.de) ? { ...m, nome: op.para } : m));
      }
      d.tx = d.tx.map((t) => ({
        ...t,
        pessoa: t.pessoa === op.de ? op.para : t.pessoa,
        criadoPor: t.criadoPor === op.de ? op.para : t.criadoPor,
      }));
      break;
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

// ---------------- Conectar / identidade ----------------

/** Testa o link e, se funcionar, passa a usar essa planilha. Lança NetError/ServerError. */
export async function connect(link) {
  const data = await api.getData(link);
  if (!data.versao) throw new api.ServerError('Esse link não é do Contas a Dois.', { notOurs: true });
  if (link !== state.link) {
    outbox = [];
    saveOutbox();
    localStorage.removeItem(K('eu'));
    state.me = null;
  }
  state.link = link;
  localStorage.setItem(K('link'), link);
  setBase(data);
  state.offline = false;
  emit();
}

/** Define quem usa este celular (cria o membro na planilha se for novo). */
export function setMe(nome) {
  const existing = state.members.find((m) => sameName(m.nome, nome));
  const final = existing ? existing.nome : nome.trim();
  state.me = final;
  localStorage.setItem(K('eu'), final);
  if (!existing) enqueue({ acao: 'addMembro', nome: final, entrouEm: new Date().toISOString() });
  else emit();
}

export function forgetMe() {
  state.me = null;
  localStorage.removeItem(K('eu'));
  emit();
}

export function renameMe(novo) {
  const de = state.me;
  const para = novo.trim();
  if (!para || para === de) return;
  state.me = para;
  localStorage.setItem(K('eu'), para);
  enqueue({ acao: 'renomearMembro', de, para });
}

export function disconnect() {
  for (const k of ['link', 'eu', 'cache', 'outbox']) localStorage.removeItem(K(k));
  base = { tx: [], cats: [], members: [] };
  outbox = [];
  Object.assign(state, { link: null, me: null, planilha: '', ready: false, pending: 0, lastSync: 0 });
  recompute();
  emit();
}

// ---------------- Sincronização ----------------

const BATCH = 100;
let running = null;
let again = false;

/**
 * Envia a fila (se houver) e traz os dados atualizados da planilha.
 * Nunca lança erro: problemas viram estado (offline) ou avisos.
 */
export function sync() {
  if (!state.link) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    state.syncing = true;
    emit();
    try {
      do {
        again = false;
        if (outbox.length) {
          const batch = outbox.slice(0, BATCH);
          const data = await api.sendOps(state.link, batch);
          const sent = new Set(batch.map((o) => o.opId));
          outbox = outbox.filter((o) => !sent.has(o.opId));
          saveOutbox();
          for (const r of data.rejeitadas || []) handlers.onError(`A planilha recusou uma alteração: ${r.erro}`);
          setBase(data);
          if (outbox.length) again = true;
        } else {
          setBase(await api.getData(state.link));
        }
      } while (again);
      state.offline = false;
    } catch (e) {
      if (e instanceof api.NetError) state.offline = true;
      else handlers.onError(e.message || 'Erro ao falar com a planilha');
    } finally {
      recompute();
      state.syncing = false;
      running = null;
      emit();
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
  sync();
}

/** Ids de lançamentos com alteração ainda não enviada. */
export function pendingTxIds() {
  return new Set(outbox.filter((o) => o.tx).map((o) => o.tx.id));
}

// ---------------- Alterações (usadas pelas telas) ----------------

export function saveTx(data) {
  const now = new Date().toISOString();
  const existing = data.id && state.tx.find((t) => t.id === data.id);
  if (existing) {
    enqueue({ acao: 'updateTx', tx: { ...existing, ...data, atualizadoEm: now } });
  } else {
    enqueue({ acao: 'addTx', tx: { ...data, id: uid(), criadoPor: state.me || '', criadoEm: now, atualizadoEm: '' } });
  }
}

export const deleteTx = (id) => enqueue({ acao: 'deleteTx', id });

export function saveCat(data) {
  const existing = data.id && state.cats.find((c) => c.id === data.id);
  if (existing) enqueue({ acao: 'updateCat', cat: { ...existing, ...data }, nomeAntigo: existing.nome });
  else enqueue({ acao: 'addCat', cat: { ...data, id: uid() } });
}

export const deleteCat = (id) => enqueue({ acao: 'deleteCat', id });
