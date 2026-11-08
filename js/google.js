// Cliente mínimo das APIs do Google (Sheets v4 e Drive v3) usando fetch.

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export class AuthError extends Error {
  constructor() { super('Sessão expirada'); this.name = 'AuthError'; }
}
export class NetError extends Error {
  constructor() { super('Sem conexão'); this.name = 'NetError'; }
}
export class ApiError extends Error {
  constructor(status, message) {
    super(message || `Erro ${status}`);
    this.name = 'ApiError';
    this.status = status;
  }
  get transient() { return this.status === 429 || this.status >= 500; }
}

let fetchImpl = (...a) => fetch(...a);
let tokenGetter = () => null;

/** Permite trocar o fetch (modo demonstração) e a origem do token. */
export function configure({ fetch: f, getToken } = {}) {
  if (f) fetchImpl = f;
  if (getToken) tokenGetter = getToken;
}

async function call(url, { method = 'GET', body, headers = {} } = {}) {
  const token = tokenGetter();
  if (!token) throw new AuthError();
  const h = { Authorization: `Bearer ${token}`, ...headers };
  let payload = body;
  if (body !== undefined && typeof body !== 'string') {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetchImpl(url, { method, headers: h, body: payload });
  } catch {
    throw new NetError();
  }
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json())?.error?.message || ''; } catch { /* sem corpo */ }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

const enc = encodeURIComponent;
const READ_OPTS = 'valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';

// ---------- Conta ----------
export const userInfo = () => call('https://www.googleapis.com/oauth2/v3/userinfo');

// ---------- Sheets ----------
export const sheetsMeta = (id) =>
  call(`${SHEETS}/${enc(id)}?fields=${enc('properties.title,sheets.properties(sheetId,title)')}`);

export const batchUpdate = (id, requests) =>
  call(`${SHEETS}/${enc(id)}:batchUpdate`, { method: 'POST', body: { requests } });

export function batchGet(id, ranges) {
  const qs = ranges.map((r) => `ranges=${enc(r)}`).join('&');
  return call(`${SHEETS}/${enc(id)}/values:batchGet?${qs}&${READ_OPTS}`);
}

export const getValues = (id, range) =>
  call(`${SHEETS}/${enc(id)}/values/${enc(range)}?${READ_OPTS}`);

export const appendRows = (id, range, values) =>
  call(`${SHEETS}/${enc(id)}/values/${enc(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: { values } });

export const updateRows = (id, range, values) =>
  call(`${SHEETS}/${enc(id)}/values/${enc(range)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: { values } });

export const valuesBatchUpdate = (id, data) =>
  call(`${SHEETS}/${enc(id)}/values:batchUpdate`,
    { method: 'POST', body: { valueInputOption: 'USER_ENTERED', data } });

// ---------- Drive ----------
export const createSpreadsheetFile = (name, appProperties) =>
  call(`${DRIVE}/files?fields=id`, {
    method: 'POST',
    body: { name, mimeType: 'application/vnd.google-apps.spreadsheet', appProperties },
  });

export const shareWith = (fileId, email, message) =>
  call(`${DRIVE}/files/${enc(fileId)}/permissions?sendNotificationEmail=true&emailMessage=${enc(message || '')}`, {
    method: 'POST',
    body: { type: 'user', role: 'writer', emailAddress: email },
  });

// Pasta oculta do app no Drive de cada um: guarda qual planilha usar.
const APP_CONFIG_NAME = 'contas-a-dois.json';

export async function readAppConfig() {
  const q = `name='${APP_CONFIG_NAME}'`;
  const list = await call(`${DRIVE}/files?spaces=appDataFolder&q=${enc(q)}&fields=${enc('files(id)')}`);
  const fileId = list?.files?.[0]?.id;
  if (!fileId) return { fileId: null, data: null };
  const data = await call(`${DRIVE}/files/${enc(fileId)}?alt=media`);
  return { fileId, data: typeof data === 'string' ? JSON.parse(data) : data };
}

export async function writeAppConfig(data) {
  const { fileId } = await readAppConfig();
  const content = JSON.stringify(data);
  if (fileId) {
    return call(`${UPLOAD}/files/${enc(fileId)}?uploadType=media`, {
      method: 'PATCH', body: content, headers: { 'Content-Type': 'application/json' },
    });
  }
  const boundary = 'cad' + Math.random().toString(36).slice(2);
  const meta = { name: APP_CONFIG_NAME, parents: ['appDataFolder'], mimeType: 'application/json' };
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(meta),
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return call(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST', body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
  });
}
