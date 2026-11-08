// Emulador mínimo do Google Sheets + Apps Script.
// Roda o MESMO apps-script/Codigo.gs que vai na planilha de verdade, para a
// demonstração (no celular) e para os testes automatizados (Node).

const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]';
const pad = (n) => String(n).padStart(2, '0');

function makeSpreadsheet(db, save) {
  const sheetApi = (sh) => {
    const lastRow = () => {
      for (let i = sh.rows.length - 1; i >= 0; i--) {
        if ((sh.rows[i] || []).some((v) => v !== '' && v !== null && v !== undefined)) return i + 1;
      }
      return 0;
    };
    const api = {
      getName: () => sh.name,
      setName: (n) => { sh.name = n; return api; },
      getLastRow: lastRow,
      getMaxRows: () => sh.maxRows,
      insertRowsAfter: (after, how) => { sh.maxRows += how; return api; },
      setFrozenRows: () => api,
      deleteRow: (n) => {
        if (n < 1 || n > sh.maxRows) throw new Error('Linha fora do intervalo');
        sh.rows.splice(n - 1, 1);
        sh.maxRows -= 1;
        return api;
      },
      getRange: (row, col, numRows = 1, numCols = 1) => {
        if (row < 1 || col < 1 || numRows < 1 || numCols < 1 || row + numRows - 1 > sh.maxRows || col + numCols - 1 > 26) {
          throw new Error(`As coordenadas ou dimensões do intervalo são inválidas (${row},${col},${numRows},${numCols})`);
        }
        const range = {
          getValues: () => Array.from({ length: numRows }, (_, i) => Array.from({ length: numCols }, (_, j) => {
            const v = (sh.rows[row - 1 + i] || [])[col - 1 + j];
            return v === undefined || v === null ? '' : (isDate(v) ? new Date(v.getTime()) : v);
          })),
          setValues: (values) => {
            if (values.length !== numRows || values.some((r) => r.length !== numCols)) {
              throw new Error('O número de linhas/colunas dos dados não corresponde ao intervalo');
            }
            values.forEach((r, i) => {
              const idx = row - 1 + i;
              while (sh.rows.length <= idx) sh.rows.push([]);
              r.forEach((v, j) => { sh.rows[idx][col - 1 + j] = v; });
            });
            save();
            return range;
          },
          setValue: (v) => range.setValues([[v]]),
          setNumberFormat: () => range,
          setNumberFormats: () => range,
          setFontWeight: () => range,
        };
        return range;
      },
    };
    return api;
  };

  return {
    getActive: () => ({
      getSheetByName: (n) => { const sh = db.sheets.find((s) => s.name === n); return sh ? sheetApi(sh) : null; },
      getSheets: () => db.sheets.map(sheetApi),
      insertSheet: (n) => {
        if (db.sheets.some((s) => s.name === n)) throw new Error('Já existe uma aba com esse nome');
        const sh = { name: n, rows: [], maxRows: 1000 };
        db.sheets.push(sh);
        return sheetApi(sh);
      },
      getUrl: () => 'https://docs.google.com/spreadsheets/d/demo/edit',
      getName: () => 'Contas a Dois',
      getSpreadsheetTimeZone: () => 'America/Sao_Paulo',
    }),
    flush: () => {},
  };
}

const Utilities = {
  formatDate: (d, tz, fmt) => {
    if (fmt !== 'yyyy-MM-dd') throw new Error(`Formato não emulado: ${fmt}`);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },
  parseDate: (s, tz, fmt) => {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
    if (fmt !== 'yyyy-MM-dd HH:mm' || !m) throw new Error(`Data não emulada: ${s}`);
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  },
  getUuid: () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    })),
};

const ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: (s) => {
    const out = { content: s, mime: 'text/plain', setMimeType: (m) => { out.mime = m; return out; }, getContent: () => s };
    return out;
  },
};
const HtmlService = {
  createHtmlOutput: (html) => ({ content: html, mime: 'text/html', getContent: () => html }),
};

function serialize(db) {
  return JSON.stringify(db, (k, v) => v);
}
function revive(text) {
  return JSON.parse(text, (k, v) => (v && typeof v === 'object' && v.__d ? new Date(v.__d) : v));
}
function toStorable(db) {
  return {
    sheets: db.sheets.map((s) => ({
      ...s,
      rows: s.rows.map((r) => (r || []).map((v) => (isDate(v) ? { __d: v.toISOString() } : v))),
    })),
  };
}

/**
 * Cria um "servidor" com o código do Apps Script.
 * Retorna { get(params), post(body), db } — as respostas são objetos { status, type, body }.
 */
export function createScriptServer(code, { storage = null, key = 'fake.sheets' } = {}) {
  let db = null;
  try { db = storage ? revive(storage.getItem(key)) : null; } catch { db = null; }
  if (!db) db = { sheets: [{ name: 'Página1', rows: [], maxRows: 1000 }] };
  const save = () => { if (storage) storage.setItem(key, serialize(toStorable(db))); };
  const SpreadsheetApp = makeSpreadsheet(db, save);
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  // eslint-disable-next-line no-new-func
  const script = new Function('SpreadsheetApp', 'LockService', 'ContentService', 'HtmlService', 'Utilities',
    `${code}\nreturn { doGet: doGet, doPost: doPost };`)(SpreadsheetApp, LockService, ContentService, HtmlService, Utilities);

  const reply = (out) => ({ status: 200, type: out.mime, body: out.getContent() });
  return {
    get: (params = {}) => reply(script.doGet({ parameter: params })),
    post: (body) => reply(script.doPost({ postData: { contents: body, type: 'text/plain' } })),
    db,
    save,
    sheet: (name) => db.sheets.find((s) => s.name === name),
  };
}

/** Lançamentos de exemplo (6 meses de um casal) para a demonstração. */
export function seedDemo(server) {
  const tab = (n) => server.sheet(n).rows;
  tab('Membros').push(['Ana', new Date().toISOString()], ['Beto', new Date().toISOString()]);
  const today = new Date();
  let seq = 0;
  let rnd = 7;
  const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
  const rows = tab('Lancamentos');
  const add = (y, mo, d, tipo, valor, desc, cat, who) => {
    const date = new Date(y, mo, d, 12, 0);
    if (date > today) return;
    rows.push([`demo-${++seq}`, date, tipo, Math.round(valor * 100) / 100, desc, cat, who, who, date.toISOString(), '']);
  };
  for (let back = 5; back >= 0; back--) {
    const ref = new Date(today.getFullYear(), today.getMonth() - back, 1);
    const y = ref.getFullYear();
    const mo = ref.getMonth();
    add(y, mo, 5, 'receita', 6200, 'Salário', 'Salário', 'Ana');
    add(y, mo, 5, 'receita', 4800, 'Salário', 'Salário', 'Beto');
    if (back % 2 === 0) add(y, mo, 18, 'receita', 650 + Math.round(rand() * 600), 'Freela de design', 'Extra', 'Beto');
    add(y, mo, 8, 'despesa', 2350, 'Aluguel', 'Moradia', 'Ana');
    add(y, mo, 10, 'despesa', 180 + Math.round(rand() * 90), 'Conta de luz', 'Contas', 'Beto');
    add(y, mo, 10, 'despesa', 119.9, 'Internet', 'Contas', 'Beto');
    add(y, mo, 12, 'despesa', 89.9, 'Plano do celular', 'Contas', 'Ana');
    for (let w = 0; w < 4; w++) {
      add(y, mo, 3 + w * 7, 'despesa', 210 + Math.round(rand() * 260), w % 2 ? 'Feira' : 'Mercado do mês', 'Mercado', w % 2 ? 'Beto' : 'Ana');
    }
    add(y, mo, 14, 'despesa', 220 + Math.round(rand() * 120), 'Combustível', 'Transporte', 'Beto');
    add(y, mo, 21, 'despesa', 80 + Math.round(rand() * 60), 'Uber', 'Transporte', 'Ana');
    add(y, mo, 16, 'despesa', 95 + Math.round(rand() * 140), 'Jantar fora', 'Restaurantes', back % 2 ? 'Ana' : 'Beto');
    add(y, mo, 25, 'despesa', 60 + Math.round(rand() * 90), 'Pizza de sexta', 'Restaurantes', 'Beto');
    if (back % 3 !== 1) add(y, mo, 20, 'despesa', 120 + Math.round(rand() * 200), 'Cinema e passeio', 'Lazer', 'Ana');
    if (back % 2 === 1) add(y, mo, 11, 'despesa', 140 + Math.round(rand() * 120), 'Farmácia', 'Saúde', 'Ana');
    if (back === 2) add(y, mo, 9, 'despesa', 890, 'Presente de aniversário', 'Compras', 'Beto');
  }
  server.save();
}
