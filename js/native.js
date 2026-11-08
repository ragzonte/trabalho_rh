// Pontes com o celular. No app Android existe window.AndroidApp (MainActivity.java);
// no navegador, usa as APIs da web.

const A = typeof window !== 'undefined' ? window.AndroidApp : undefined;
export const isAndroidApp = !!A;

export async function share(text) {
  if (A?.share) { A.share(text); return 'shared'; }
  if (navigator.share) {
    try { await navigator.share({ text }); return 'shared'; } catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
  }
  return (await copy(text)) ? 'copied' : 'failed';
}

export async function copy(text) {
  if (A?.copy) { A.copy(text); return true; }
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

export async function readClipboard() {
  if (A?.readClipboard) return A.readClipboard() || '';
  try { return (await navigator.clipboard.readText()) || ''; } catch { return ''; }
}

export function openExternal(url) {
  if (A?.openUrl) A.openUrl(url);
  else window.open(url, '_blank', 'noopener');
}
