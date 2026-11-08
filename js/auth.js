// Login com a conta Google (OAuth 2.0, fluxo por redirecionamento).
//
// Por que redirecionamento e não pop-up? Funciona igual no Android, no iPhone
// (inclusive com o app instalado na tela inicial) e no computador, sem
// bloqueador de pop-up e sem bibliotecas externas.

import { CONFIG } from './config.js';

export const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/spreadsheets', // ler/gravar a planilha do casal
  'https://www.googleapis.com/auth/drive.file', // criar a planilha e compartilhar com o parceiro(a)
  'https://www.googleapis.com/auth/drive.appdata', // lembrar qual é a planilha em qualquer aparelho
];
const REQUIRED = SCOPES.slice(3);

const K_TOKEN = 'cad.token';
const K_USER = 'cad.user';
const K_STATE = 'cad.oauthState';
const K_SILENT = 'cad.silentTried';

const readJSON = (k) => {
  try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
};

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function randomString() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Lê a resposta do Google na URL (#access_token=...) ao voltar do login.
 * Retorna null se não for um retorno de login.
 */
export function consumeRedirect() {
  const hash = location.hash;
  if (!hash || !/(access_token|error)=/.test(hash)) return null;
  const p = new URLSearchParams(hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);

  const expected = localStorage.getItem(K_STATE);
  localStorage.removeItem(K_STATE);
  if (!expected || p.get('state') !== expected) return { error: 'state_mismatch' };
  if (p.get('error')) return { error: p.get('error') };

  const scope = p.get('scope') || '';
  const granted = scope.split(/\s+/);
  const missingScopes = REQUIRED.filter((s) => !granted.includes(s));
  localStorage.setItem(K_TOKEN, JSON.stringify({
    token: p.get('access_token'),
    exp: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000,
  }));
  sessionStorage.removeItem(K_SILENT);
  return { ok: true, missingScopes };
}

/** Token válido por pelo menos `minValidityMs`, ou null. */
export function getToken(minValidityMs = 60_000) {
  const t = readJSON(K_TOKEN);
  return t && t.token && t.exp - minValidityMs > Date.now() ? t.token : null;
}

export const getUser = () => readJSON(K_USER);
export const setUser = (u) => localStorage.setItem(K_USER, JSON.stringify(u));
export const silentTried = () => sessionStorage.getItem(K_SILENT) === '1';
export const clearToken = () => localStorage.removeItem(K_TOKEN);

/**
 * Vai para a tela de login do Google.
 * silent: tenta renovar sem mostrar nada (só funciona se já autorizou antes).
 * consent: força a tela de permissões (quando alguma permissão foi desmarcada).
 */
export function signIn({ silent = false, consent = false } = {}) {
  const state = randomString();
  localStorage.setItem(K_STATE, state);
  const user = getUser();
  const params = new URLSearchParams({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES.join(' '),
    include_granted_scopes: 'true',
    state,
  });
  if (user?.email) params.set('login_hint', user.email);
  if (silent) {
    params.set('prompt', 'none');
    sessionStorage.setItem(K_SILENT, '1');
  } else if (consent) {
    params.set('prompt', 'consent');
  } else if (!user) {
    params.set('prompt', 'select_account');
  }
  // replace(): não deixa a página de login no histórico do botão "voltar".
  location.replace('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
}

export function signOut() {
  localStorage.removeItem(K_TOKEN);
  localStorage.removeItem(K_USER);
  sessionStorage.removeItem(K_SILENT);
}
