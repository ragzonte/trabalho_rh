// Conversa com o script da planilha (Google Apps Script publicado como "App da Web").
// Não precisa de login: o link /exec é a chave de acesso.

export class NetError extends Error {
  constructor() { super('Sem conexão'); this.name = 'NetError'; }
}
export class ServerError extends Error {
  constructor(message, { notOurs = false } = {}) {
    super(message);
    this.name = 'ServerError';
    this.notOurs = notOurs; // o link respondeu, mas não é o script do Contas a Dois
  }
}

/** Valida o link colado. Retorna { url } ou { error: 'planilha' | 'dev' | 'invalido' }. */
export function parseLink(text) {
  const s = String(text || '').trim();
  const m = s.match(/https:\/\/script\.google\.com\/(?:a\/macros\/[^/\s]+|macros)\/s\/([\w-]{20,})\/(exec|dev)/);
  if (m) return m[2] === 'dev' ? { error: 'dev' } : { url: m[0] };
  if (/docs\.google\.com\/spreadsheets/.test(s)) return { error: 'planilha' };
  return { error: 'invalido' };
}

async function httpTransport(url, { method, body }) {
  let res;
  try {
    res = method === 'POST'
      ? await fetch(url, {
        method: 'POST',
        body,
        // text/plain evita a checagem extra (preflight) que o Apps Script não responde.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        redirect: 'follow',
        cache: 'no-store',
      })
      : await fetch(`${url}?acao=dados&_=${Date.now()}`, { redirect: 'follow', cache: 'no-store' });
  } catch {
    throw new NetError();
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ServerError('Esse link não respondeu como o script do Contas a Dois.', { notOurs: true });
  }
  if (!json || typeof json !== 'object' || !('ok' in json)) {
    throw new ServerError('Esse link não respondeu como o script do Contas a Dois.', { notOurs: true });
  }
  if (!json.ok) throw new ServerError(json.erro || 'A planilha respondeu com erro.');
  return json;
}

let transport = httpTransport;
/** Troca a forma de falar com o "servidor" (usado na demonstração). */
export const setTransport = (fn) => { transport = fn; };

export const getData = (url) => transport(url, { method: 'GET' });
export const sendOps = (url, ops) => transport(url, { method: 'POST', body: JSON.stringify({ ops }) });
