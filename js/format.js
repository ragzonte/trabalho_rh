// Utilidades de formatação (moeda, datas, texto) — tudo em pt-BR.

const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCompactFmt = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });

export const brl = (n) => brlFmt.format(Number(n) || 0);

/** Valor curto para eixos de gráfico: 1.500 -> "1,5 mil" */
export function brlShort(n) {
  const v = Math.abs(Number(n) || 0);
  return v < 1000 ? String(Math.round(v)) : brlCompactFmt.format(v);
}

/** Converte "1.234,56" / "1234.56" / "1234,5" / número em número. */
export function parseMoney(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v ?? '').replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** Máscara de centavos: "12345" -> "123,45" */
export function maskCents(raw) {
  const digits = String(raw).replace(/\D/g, '').replace(/^0+/, '').slice(0, 11);
  const cents = digits.padStart(3, '0');
  const int = cents.slice(0, -2);
  const dec = cents.slice(-2);
  return `${Number(int).toLocaleString('pt-BR')},${dec}`;
}

const pad = (n) => String(n).padStart(2, '0');

export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const todayISO = () => toISODate(new Date());

export function yesterdayISO() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return toISODate(d);
}

/** Aceita "2026-11-08", "08/11/2026" ou número de série do Sheets. */
export function normalizeDate(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Série do Google Sheets: dias desde 30/12/1899.
    const ms = Date.UTC(1899, 11, 30) + Math.round(v * 86400000);
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return '';
}

export const monthOf = (iso) => (iso || '').slice(0, 7);
export const currentMonth = () => todayISO().slice(0, 7);

export function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function monthLabel(key, { short = false, year = true } = {}) {
  const [y, m] = key.split('-').map(Number);
  const name = short ? MONTHS[m - 1].slice(0, 3) : MONTHS[m - 1];
  return year ? `${name} ${y}` : name;
}

export function dayLabel(iso) {
  if (iso === todayISO()) return 'Hoje';
  if (iso === yesterdayISO()) return 'Ontem';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const label = date.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
