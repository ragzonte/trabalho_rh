/**
 * Contas a Dois — servidor da planilha do casal (Google Apps Script).
 *
 * Este código fica DENTRO da planilha (Extensões → Apps Script) e deixa o app
 * ler e gravar nela sem pedir login. Instalação (uma vez só, no computador):
 *
 *   1. Apague tudo o que estiver no editor e cole este código. Salve (Ctrl+S).
 *   2. Implantar → Nova implantação → (engrenagem) App da Web.
 *        Executar como: Eu        Quem pode acessar: Qualquer pessoa
 *   3. Implantar → Autorizar acesso → escolha sua conta.
 *      Se aparecer "O Google não verificou este app": Avançado → Acessar (não seguro).
 *   4. Copie o "URL do app da Web" (termina em /exec) e cole no app.
 *
 * As abas Lancamentos, Categorias e Membros são criadas sozinhas.
 * Quem tiver o link consegue ler e gravar: compartilhe só com quem você confia.
 */

var VERSAO = 1;

var ABAS = {
  lanc: {
    nome: 'Lancamentos',
    cols: ['id', 'data', 'tipo', 'valor', 'descricao', 'categoria', 'pessoa', 'criado_por', 'criado_em', 'atualizado_em'],
    formatos: ['@', 'dd/mm/yyyy', '@', '#,##0.00', '@', '@', '@', '@', '@', '@'],
  },
  cat: { nome: 'Categorias', cols: ['id', 'nome', 'tipo', 'icone'], formatos: ['@', '@', '@', '@'] },
  mem: { nome: 'Membros', cols: ['nome', 'entrou_em'], formatos: ['@', '@'] },
};

var CATEGORIAS_PADRAO = [
  ['🏠', 'Moradia', 'despesa'], ['🛒', 'Mercado', 'despesa'], ['🍽️', 'Restaurantes', 'despesa'],
  ['🚗', 'Transporte', 'despesa'], ['💡', 'Contas', 'despesa'], ['💊', 'Saúde', 'despesa'],
  ['🎉', 'Lazer', 'despesa'], ['📚', 'Educação', 'despesa'], ['🛍️', 'Compras', 'despesa'],
  ['📦', 'Outros', 'despesa'], ['💰', 'Salário', 'receita'], ['✨', 'Extra', 'receita'],
  ['📈', 'Rendimentos', 'receita'], ['🎁', 'Outras receitas', 'receita'],
];

// ---------------------------------------------------------------- Entradas

function doGet(e) {
  var acao = e && e.parameter && e.parameter.acao;
  if (!acao) {
    return HtmlService.createHtmlOutput(
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="font-family:system-ui,sans-serif;padding:24px;line-height:1.5">' +
      '<h2>✅ Contas a Dois está funcionando</h2>' +
      '<p>Copie o endereço desta página (termina em <b>/exec</b>) e cole no app.</p></div>');
  }
  return responder_(function () {
    comTrava_(preparar_);
    return dados_();
  });
}

function doPost(e) {
  return responder_(function () {
    var pedido = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var ops = pedido.ops || [];
    var rejeitadas = [];
    comTrava_(function () {
      preparar_();
      for (var i = 0; i < ops.length; i++) {
        try {
          aplicar_(ops[i]);
        } catch (err) {
          rejeitadas.push({ opId: ops[i] && ops[i].opId, erro: String((err && err.message) || err) });
        }
      }
    });
    var saida = dados_();
    saida.rejeitadas = rejeitadas;
    return saida;
  });
}

function responder_(fn) {
  var saida;
  try {
    saida = fn();
    saida.ok = true;
  } catch (err) {
    saida = { ok: false, erro: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(saida)).setMimeType(ContentService.MimeType.JSON);
}

function comTrava_(fn) {
  var trava = LockService.getScriptLock();
  trava.waitLock(25000);
  try {
    fn();
    SpreadsheetApp.flush();
  } finally {
    trava.releaseLock();
  }
}

// ---------------------------------------------------------------- Estrutura

function planilha_() {
  return SpreadsheetApp.getActive();
}

function aba_(def) {
  return planilha_().getSheetByName(def.nome);
}

/** Cria as abas que faltarem e dá id às linhas digitadas direto na planilha. */
function preparar_() {
  var ss = planilha_();
  var nomes = Object.keys(ABAS);
  for (var i = 0; i < nomes.length; i++) {
    var def = ABAS[nomes[i]];
    if (ss.getSheetByName(def.nome)) continue;
    var abas = ss.getSheets();
    var nossas = nomes.some(function (k) { return ss.getSheetByName(ABAS[k].nome); });
    var sh;
    if (!nossas && abas.length === 1 && abas[0].getLastRow() === 0) {
      sh = abas[0]; // reaproveita a "Página1" vazia
      sh.setName(def.nome);
    } else {
      sh = ss.insertSheet(def.nome);
    }
    sh.getRange(1, 1, 1, def.cols.length).setValues([def.cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (def === ABAS.cat) {
      for (var c = 0; c < CATEGORIAS_PADRAO.length; c++) {
        var p = CATEGORIAS_PADRAO[c];
        anexar_(ABAS.cat, [novoId_(), p[1], p[2], p[0]]);
      }
    }
  }
  completarIds_(ABAS.lanc);
  completarIds_(ABAS.cat);
}

function completarIds_(def) {
  var sh = aba_(def);
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  var vals = sh.getRange(2, 1, n, def.cols.length).getValues();
  for (var i = 0; i < n; i++) {
    var vazia = vals[i].slice(1).every(function (v) { return v === '' || v === null; });
    if (!texto_(vals[i][0]) && !vazia) {
      sh.getRange(i + 2, 1).setNumberFormat('@').setValue(novoId_());
    }
  }
}

// ---------------------------------------------------------------- Leitura

function dados_() {
  var ss = planilha_();
  var tz = ss.getSpreadsheetTimeZone();
  return {
    versao: VERSAO,
    planilha: ss.getUrl(),
    nomePlanilha: ss.getName(),
    lancamentos: linhas_(ABAS.lanc).map(function (r) {
      return {
        id: texto_(r[0]),
        data: dataIso_(r[1], tz),
        tipo: texto_(r[2]).toLowerCase() === 'receita' ? 'receita' : 'despesa',
        valor: Math.abs(numero_(r[3])),
        descricao: texto_(r[4]),
        categoria: texto_(r[5]),
        pessoa: texto_(r[6]),
        criadoPor: texto_(r[7]),
        criadoEm: texto_(r[8]),
        atualizadoEm: texto_(r[9]),
      };
    }).filter(function (t) { return t.id && t.data; }),
    categorias: linhas_(ABAS.cat).map(function (r) {
      return {
        id: texto_(r[0]),
        nome: texto_(r[1]),
        tipo: texto_(r[2]).toLowerCase() === 'receita' ? 'receita' : 'despesa',
        icone: texto_(r[3]) || '🏷️',
      };
    }).filter(function (c) { return c.id && c.nome; }),
    membros: linhas_(ABAS.mem).map(function (r) {
      return { nome: texto_(r[0]), entrouEm: texto_(r[1]) };
    }).filter(function (m) { return m.nome; }),
  };
}

function linhas_(def) {
  var sh = aba_(def);
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, def.cols.length).getValues();
}

function texto_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return String(v).trim();
}

function numero_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var s = String(v || '').replace(/[^\d,.-]/g, '');
  if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  var n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function dataIso_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var s = String(v || '').trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + dois_(m[2]) + '-' + dois_(m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + dois_(m[2]) + '-' + dois_(m[1]);
  return '';
}

function dois_(n) {
  return ('0' + n).slice(-2);
}

// ---------------------------------------------------------------- Escrita

function aplicar_(op) {
  switch (op && op.acao) {
    case 'addTx': {
      var t = validarTx_(op.tx);
      if (!acharLinha_(ABAS.lanc, 0, t.id)) anexar_(ABAS.lanc, linhaTx_(t));
      return;
    }
    case 'updateTx': {
      var u = validarTx_(op.tx);
      var n = acharLinha_(ABAS.lanc, 0, u.id);
      if (n) escrever_(ABAS.lanc, n, linhaTx_(u));
      else anexar_(ABAS.lanc, linhaTx_(u));
      return;
    }
    case 'deleteTx': {
      var d = acharLinha_(ABAS.lanc, 0, String(op.id || ''));
      if (d) aba_(ABAS.lanc).deleteRow(d);
      return;
    }
    case 'addCat': {
      var c = validarCat_(op.cat);
      if (!acharLinha_(ABAS.cat, 0, c.id)) anexar_(ABAS.cat, [c.id, c.nome, c.tipo, c.icone]);
      return;
    }
    case 'updateCat': {
      var uc = validarCat_(op.cat);
      var nc = acharLinha_(ABAS.cat, 0, uc.id);
      if (!nc) return;
      escrever_(ABAS.cat, nc, [uc.id, uc.nome, uc.tipo, uc.icone]);
      var antigo = texto_(op.nomeAntigo);
      if (antigo && antigo !== uc.nome) {
        trocarNaColuna_(ABAS.lanc, 5, antigo, uc.nome, function (linha) { return texto_(linha[2]) === uc.tipo; });
      }
      return;
    }
    case 'deleteCat': {
      var dc = acharLinha_(ABAS.cat, 0, String(op.id || ''));
      if (dc) aba_(ABAS.cat).deleteRow(dc);
      return;
    }
    case 'addMembro': {
      var nome = limitar_(op.nome, 40);
      if (!nome) throw new Error('Nome vazio');
      if (!acharLinha_(ABAS.mem, 0, nome)) anexar_(ABAS.mem, [nome, limitar_(op.entrouEm, 40) || new Date().toISOString()]);
      return;
    }
    case 'renomearMembro': {
      var de = limitar_(op.de, 40);
      var para = limitar_(op.para, 40);
      if (!de || !para) throw new Error('Nome vazio');
      var nm = acharLinha_(ABAS.mem, 0, de);
      if (nm && !acharLinha_(ABAS.mem, 0, para)) aba_(ABAS.mem).getRange(nm, 1).setValue(para);
      trocarNaColuna_(ABAS.lanc, 6, de, para);
      trocarNaColuna_(ABAS.lanc, 7, de, para);
      return;
    }
    default:
      throw new Error('Operação desconhecida: ' + (op && op.acao));
  }
}

function validarTx_(t) {
  if (!t || !t.id) throw new Error('Lançamento sem id');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(t.data))) throw new Error('Data inválida');
  var valor = Math.round(Number(t.valor) * 100) / 100;
  if (!(valor > 0) || valor > 1e10) throw new Error('Valor inválido');
  return {
    id: limitar_(t.id, 60),
    data: String(t.data),
    tipo: t.tipo === 'receita' ? 'receita' : 'despesa',
    valor: valor,
    descricao: limitar_(t.descricao, 200),
    categoria: limitar_(t.categoria, 60),
    pessoa: limitar_(t.pessoa, 40),
    criadoPor: limitar_(t.criadoPor, 40),
    criadoEm: limitar_(t.criadoEm, 40),
    atualizadoEm: limitar_(t.atualizadoEm, 40),
  };
}

function validarCat_(c) {
  if (!c || !c.id || !limitar_(c.nome, 60)) throw new Error('Categoria inválida');
  return {
    id: limitar_(c.id, 60),
    nome: limitar_(c.nome, 60),
    tipo: c.tipo === 'receita' ? 'receita' : 'despesa',
    icone: limitar_(c.icone, 8) || '🏷️',
  };
}

function limitar_(v, max) {
  return String(v === null || v === undefined ? '' : v).trim().slice(0, max);
}

function linhaTx_(t) {
  var tz = planilha_().getSpreadsheetTimeZone();
  // Meio-dia evita que o fuso horário mude o dia.
  var data = Utilities.parseDate(t.data + ' 12:00', tz, 'yyyy-MM-dd HH:mm');
  return [t.id, data, t.tipo, t.valor, t.descricao, t.categoria, t.pessoa, t.criadoPor, t.criadoEm, t.atualizadoEm];
}

/** Número da linha (1 = títulos) cujo valor na coluna `col` é `chave` (sem diferenciar maiúsculas). */
function acharLinha_(def, col, chave) {
  var sh = aba_(def);
  var n = sh.getLastRow() - 1;
  if (n < 1 || !chave) return 0;
  var vals = sh.getRange(2, col + 1, n, 1).getValues();
  var k = String(chave).trim().toLowerCase();
  for (var i = 0; i < n; i++) {
    if (texto_(vals[i][0]).toLowerCase() === k) return i + 2;
  }
  return 0;
}

function anexar_(def, linha) {
  var sh = aba_(def);
  var n = sh.getLastRow() + 1;
  if (n > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
  escrever_(def, n, linha);
}

function escrever_(def, n, linha) {
  var r = aba_(def).getRange(n, 1, 1, def.cols.length);
  r.setNumberFormats([def.formatos]);
  r.setValues([linha]);
}

function trocarNaColuna_(def, col, de, para, filtro) {
  var sh = aba_(def);
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  var vals = sh.getRange(2, 1, n, def.cols.length).getValues();
  for (var i = 0; i < n; i++) {
    if (texto_(vals[i][col]) === de && (!filtro || filtro(vals[i]))) {
      sh.getRange(i + 2, col + 1).setValue(para);
    }
  }
}

function novoId_() {
  return Utilities.getUuid();
}
