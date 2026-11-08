// Emulador mínimo das APIs do Google Drive/Sheets usadas pelo app.
// Usado no modo demonstração (no navegador) e nos testes automatizados (Node).
// Não é usado quando o app roda de verdade.

const SERIAL_EPOCH = Date.UTC(1899, 11, 30);
const toSerial = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - SERIAL_EPOCH) / 86400000;
};

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseCell(s) {
  const m = /^([A-Z]*)(\d*)$/.exec(s);
  if (!m) throw new Error(`Célula inválida: ${s}`);
  return { col: m[1] ? colIndex(m[1]) : null, row: m[2] ? Number(m[2]) : null };
}

/** "Aba!A2:J" -> { title, r1, r2, c1, c2 } (linhas 1-based, colunas 0-based, inclusivos). */
export function parseRange(a1) {
  const i = a1.lastIndexOf('!');
  const title = (i >= 0 ? a1.slice(0, i) : a1).replace(/^'(.*)'$/, '$1');
  const ref = i >= 0 ? a1.slice(i + 1) : '';
  if (!ref) return { title, r1: 1, r2: Infinity, c1: 0, c2: Infinity, single: false };
  const [a, b] = ref.split(':');
  const pa = parseCell(a);
  const pb = b !== undefined ? parseCell(b) : null;
  return {
    title,
    r1: pa.row ?? 1,
    c1: pa.col ?? 0,
    r2: pb ? (pb.row ?? Infinity) : (pa.row ?? Infinity),
    c2: pb ? (pb.col ?? Infinity) : (pa.col ?? Infinity),
    single: !pb,
  };
}

function userEntered(v) {
  if (typeof v !== 'string') return v ?? '';
  if (v.startsWith("'")) return v.slice(1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return toSerial(v);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function trimRow(row) {
  const r = [...row];
  while (r.length && (r[r.length - 1] === '' || r[r.length - 1] === undefined || r[r.length - 1] === null)) r.pop();
  return r.map((x) => (x === undefined || x === null ? '' : x));
}

export function createFakeGoogle({ storage = null, key = 'fake.google', profiles = {} } = {}) {
  let db = null;
  try { db = storage ? JSON.parse(storage.getItem(key)) : null; } catch { db = null; }
  if (!db) db = { seq: 1, files: {} };
  const invalidTokens = new Set();
  const log = [];

  const save = () => { if (storage) storage.setItem(key, JSON.stringify(db)); };
  const json = (status, obj) => new Response(obj === undefined ? null : JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const fail = (status, message) => json(status, { error: { code: status, message } });
  const newId = () => `f${(db.seq++).toString(36)}${Math.random().toString(36).slice(2, 12)}xyzxyzxyz`;

  const canAccess = (file, email) => file && (file.owner === email || file.shared.includes(email));
  const sheetByTitle = (ss, title) => ss.sheets.find((s) => s.title === title);

  function readRange(ss, a1) {
    const r = parseRange(a1);
    const sh = sheetByTitle(ss, r.title);
    if (!sh) throw Object.assign(new Error(`Unable to parse range: ${a1}`), { status: 400 });
    const rows = [];
    const last = Math.min(r.r2, sh.rows.length);
    for (let i = r.r1; i <= last; i++) {
      const row = sh.rows[i - 1] || [];
      rows.push(trimRow(row.slice(r.c1, r.c2 === Infinity ? undefined : r.c2 + 1)));
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    return { range: a1, majorDimension: 'ROWS', ...(rows.length ? { values: rows } : {}) };
  }

  function writeRange(ss, a1, values, mode) {
    const r = parseRange(a1);
    const sh = sheetByTitle(ss, r.title);
    if (!sh) throw Object.assign(new Error(`Unable to parse range: ${a1}`), { status: 400 });
    if (!r.single) {
      const height = values.length;
      const width = Math.max(0, ...values.map((v) => v.length));
      if (r.r1 + height - 1 > r.r2 || r.c1 + width - 1 > r.c2) {
        throw Object.assign(new Error(`Requested writing within range [${a1}], but tried writing outside it`), { status: 400 });
      }
    }
    values.forEach((row, i) => {
      const idx = r.r1 - 1 + i;
      while (sh.rows.length <= idx) sh.rows.push([]);
      row.forEach((v, j) => { sh.rows[idx][r.c1 + j] = mode === 'RAW' ? v : userEntered(v); });
    });
  }

  function appendRange(ss, a1, values, mode) {
    const r = parseRange(a1);
    const sh = sheetByTitle(ss, r.title);
    if (!sh) throw Object.assign(new Error(`Unable to parse range: ${a1}`), { status: 400 });
    let lastRow = sh.rows.length;
    while (lastRow > 0 && !trimRow(sh.rows[lastRow - 1] || []).length) lastRow--;
    sh.rows.length = lastRow;
    for (const row of values) sh.rows.push(row.map((v) => (mode === 'RAW' ? v : userEntered(v))));
    return { updates: { updatedRows: values.length } };
  }

  function batchUpdate(ss, requests) {
    for (const req of requests) {
      const [kind, p] = Object.entries(req)[0];
      if (kind === 'updateSpreadsheetProperties') Object.assign(ss.properties, p.properties);
      else if (kind === 'addSheet') {
        const { sheetId, title } = p.properties;
        if (ss.sheets.some((s) => s.sheetId === sheetId || s.title === title)) throw Object.assign(new Error('Sheet exists'), { status: 400 });
        ss.sheets.push({ sheetId, title, rows: [] });
      } else if (kind === 'deleteSheet') {
        if (ss.sheets.length <= 1) throw Object.assign(new Error('Cannot delete last sheet'), { status: 400 });
        ss.sheets = ss.sheets.filter((s) => s.sheetId !== p.sheetId);
      } else if (kind === 'repeatCell') {
        if (!ss.sheets.some((s) => s.sheetId === p.range.sheetId)) throw Object.assign(new Error('No grid'), { status: 400 });
      } else if (kind === 'deleteDimension') {
        const sh = ss.sheets.find((s) => s.sheetId === p.range.sheetId);
        if (!sh || p.range.dimension !== 'ROWS') throw Object.assign(new Error('Bad deleteDimension'), { status: 400 });
        sh.rows.splice(p.range.startIndex, p.range.endIndex - p.range.startIndex);
      } else {
        throw Object.assign(new Error(`Unsupported request ${kind}`), { status: 400 });
      }
    }
    return { replies: requests.map(() => ({})) };
  }

  function emailFrom(headers = {}) {
    const h = headers.Authorization || headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m || invalidTokens.has(m[1])) return null;
    const i = m[1].indexOf(':');
    return i > 0 ? m[1].slice(i + 1).toLowerCase() : null;
  }

  async function handle(url, opts = {}) {
    const u = new URL(url);
    const method = (opts.method || 'GET').toUpperCase();
    const email = emailFrom(opts.headers);
    log.push(`${method} ${u.hostname}${decodeURIComponent(u.pathname)}`);
    if (!email) return fail(401, 'Request had invalid authentication credentials.');
    const body = opts.body;
    const path = u.pathname;
    let m;

    if (path === '/oauth2/v3/userinfo') {
      const name = profiles[email]?.name || email.split('@')[0].replace(/^./, (c) => c.toUpperCase());
      return json(200, { email, name, given_name: name.split(' ')[0], picture: '' });
    }

    // ----- Drive -----
    if (u.hostname === 'www.googleapis.com' && path === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(body);
      const id = newId();
      const file = { id, name: meta.name, mimeType: meta.mimeType, owner: email, shared: [], parents: meta.parents || [], appProperties: meta.appProperties || {} };
      if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
        file.sheet = { properties: { title: meta.name }, sheets: [{ sheetId: 0, title: 'Página1', rows: [] }] };
      }
      db.files[id] = file;
      save();
      return json(200, { id });
    }
    if (path === '/drive/v3/files' && method === 'GET') {
      const q = u.searchParams.get('q') || '';
      const name = (/name='([^']+)'/.exec(q) || [])[1];
      const appData = u.searchParams.get('spaces') === 'appDataFolder';
      const files = Object.values(db.files).filter((f) => f.owner === email
        && (!appData || f.parents.includes('appDataFolder')) && (!name || f.name === name));
      return json(200, { files: files.map((f) => ({ id: f.id })) });
    }
    if ((m = path.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/)) && method === 'POST') {
      const file = db.files[decodeURIComponent(m[1])];
      // Com o escopo drive.file, só quem criou o arquivo pelo app o enxerga.
      if (!file || file.owner !== email) return fail(404, 'File not found.');
      const p = JSON.parse(body);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.emailAddress || '')) return fail(400, 'Invalid email');
      if (!file.shared.includes(p.emailAddress)) file.shared.push(p.emailAddress.toLowerCase());
      save();
      return json(200, { id: `perm-${file.shared.length}`, role: p.role, type: p.type });
    }
    if ((m = path.match(/^\/drive\/v3\/files\/([^/]+)$/)) && method === 'GET') {
      const file = db.files[decodeURIComponent(m[1])];
      if (!file || file.owner !== email) return fail(404, 'File not found.');
      return new Response(file.content ?? '', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/upload/drive/v3/files' && method === 'POST') {
      const ct = opts.headers['Content-Type'] || opts.headers['content-type'] || '';
      const boundary = (/boundary=(.+)$/.exec(ct) || [])[1];
      const parts = String(body).split(`--${boundary}`).slice(1, -1).map((p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
      const meta = JSON.parse(parts[0]);
      const id = newId();
      db.files[id] = { id, name: meta.name, mimeType: meta.mimeType, owner: email, shared: [], parents: meta.parents || [], content: parts[1] };
      save();
      return json(200, { id });
    }
    if ((m = path.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/)) && method === 'PATCH') {
      const file = db.files[decodeURIComponent(m[1])];
      if (!file || file.owner !== email) return fail(404, 'File not found.');
      file.content = String(body);
      save();
      return json(200, { id: file.id });
    }

    // ----- Sheets -----
    if (u.hostname === 'sheets.googleapis.com') {
      const idm = path.match(/^\/v4\/spreadsheets\/([^/:]+)/);
      const file = idm && db.files[decodeURIComponent(idm[1])];
      if (!file || !file.sheet) return fail(404, 'Requested entity was not found.');
      if (!canAccess(file, email)) return fail(403, 'The caller does not have permission');
      const ss = file.sheet;
      try {
        let out;
        if (path.endsWith('/values:batchGet') && method === 'GET') {
          out = { spreadsheetId: file.id, valueRanges: u.searchParams.getAll('ranges').map((r) => readRange(ss, r)) };
        } else if (path.endsWith('/values:batchUpdate') && method === 'POST') {
          const p = JSON.parse(body);
          for (const d of p.data) writeRange(ss, d.range, d.values, p.valueInputOption);
          out = { totalUpdatedRows: p.data.length };
        } else if ((m = path.match(/\/values\/(.+):append$/)) && method === 'POST') {
          out = appendRange(ss, decodeURIComponent(m[1]), JSON.parse(body).values, u.searchParams.get('valueInputOption'));
        } else if ((m = path.match(/\/values\/(.+)$/))) {
          const range = decodeURIComponent(m[1]);
          if (method === 'GET') out = readRange(ss, range);
          else if (method === 'PUT') {
            writeRange(ss, range, JSON.parse(body).values, u.searchParams.get('valueInputOption'));
            out = { updatedRange: range };
          }
        } else if (path.endsWith(':batchUpdate') && method === 'POST') {
          out = batchUpdate(ss, JSON.parse(body).requests);
        } else if (method === 'GET') {
          out = { properties: ss.properties, sheets: ss.sheets.map((s) => ({ properties: { sheetId: s.sheetId, title: s.title } })) };
        }
        if (out === undefined) return fail(404, 'Not found');
        save();
        return json(200, out);
      } catch (e) {
        return fail(e.status || 500, e.message);
      }
    }
    return fail(404, `Not found: ${path}`);
  }

  return {
    fetch: (url, opts) => handle(String(url), opts),
    invalidate: (token) => invalidTokens.add(token),
    log,
    db: () => db,
    save,
  };
}

/** Dados de exemplo para a demonstração (6 meses de um casal). */
export function seedDemo(fake, spreadsheetId) {
  const ss = fake.db().files[spreadsheetId].sheet;
  const tab = (t) => ss.sheets.find((s) => s.title === t).rows;
  const ana = 'ana@demo.casal';
  const beto = 'beto@demo.casal';
  tab('Membros').push([beto, 'Beto', new Date().toISOString()]);

  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  let seq = 0;
  let rnd = 7;
  const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
  const rows = tab('Lancamentos');
  const add = (y, mo, d, tipo, valor, desc, cat, who) => {
    const date = new Date(y, mo, d);
    if (date > today) return;
    const iso = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    rows.push([`demo-${++seq}`, toSerial(iso), tipo, Math.round(valor * 100) / 100, desc, cat, who, who, `${iso}T12:00:00.000Z`, '']);
  };
  for (let back = 5; back >= 0; back--) {
    const ref = new Date(today.getFullYear(), today.getMonth() - back, 1);
    const y = ref.getFullYear();
    const mo = ref.getMonth();
    add(y, mo, 5, 'receita', 6200, 'Salário', 'Salário', ana);
    add(y, mo, 5, 'receita', 4800, 'Salário', 'Salário', beto);
    if (back % 2 === 0) add(y, mo, 18, 'receita', 650 + Math.round(rand() * 600), 'Freela de design', 'Extra', beto);
    add(y, mo, 8, 'despesa', 2350, 'Aluguel', 'Moradia', ana);
    add(y, mo, 10, 'despesa', 180 + Math.round(rand() * 90), 'Conta de luz', 'Contas', beto);
    add(y, mo, 10, 'despesa', 119.9, 'Internet', 'Contas', beto);
    add(y, mo, 12, 'despesa', 89.9, 'Plano do celular', 'Contas', ana);
    for (let w = 0; w < 4; w++) {
      add(y, mo, 3 + w * 7, 'despesa', 210 + Math.round(rand() * 260), w % 2 ? 'Feira e mercado' : 'Mercado do mês', 'Mercado', w % 2 ? beto : ana);
    }
    add(y, mo, 14, 'despesa', 220 + Math.round(rand() * 120), 'Combustível', 'Transporte', beto);
    add(y, mo, 21, 'despesa', 80 + Math.round(rand() * 60), 'Uber', 'Transporte', ana);
    add(y, mo, 16, 'despesa', 95 + Math.round(rand() * 140), 'Jantar fora', 'Restaurantes', back % 2 ? ana : beto);
    add(y, mo, 25, 'despesa', 60 + Math.round(rand() * 90), 'Pizza de sexta', 'Restaurantes', beto);
    if (back % 3 !== 1) add(y, mo, 20, 'despesa', 120 + Math.round(rand() * 200), 'Cinema e passeio', 'Lazer', ana);
    if (back % 2 === 1) add(y, mo, 11, 'despesa', 140 + Math.round(rand() * 120), 'Farmácia', 'Saúde', ana);
    if (back === 2) add(y, mo, 9, 'despesa', 890, 'Presente de aniversário', 'Compras', beto);
  }
  fake.save();
}
