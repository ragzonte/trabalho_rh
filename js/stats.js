// Cálculos para o painel e os gráficos.

import { addMonths, monthOf, firstName } from './format.js';

// Cores fixas por pessoa (segue a pessoa, nunca a posição no ranking).
const MEMBER_SLOTS = ['--c-mem1', '--c-mem2', '--c-mem3', '--c-mem4'];

/** Lista de pessoas: membros da planilha + quem aparece em lançamentos antigos. */
export function people(state) {
  const list = state.members.map((m) => ({ ...m }));
  for (const t of state.tx) {
    if (t.pessoa && !list.some((p) => p.email === t.pessoa)) list.push({ email: t.pessoa, nome: '' });
  }
  return list.map((p, i) => ({
    ...p,
    label: firstName(p.nome) || p.email.split('@')[0],
    color: `var(${MEMBER_SLOTS[i % MEMBER_SLOTS.length]})`,
  }));
}

export const personOf = (list, email) =>
  list.find((p) => p.email === email) || { email, label: email ? email.split('@')[0] : '—', color: 'var(--ink-muted)' };

export function filterTx(tx, { month, person, tipo } = {}) {
  return tx.filter((t) => (!month || monthOf(t.data) === month)
    && (!person || t.pessoa === person)
    && (!tipo || t.tipo === tipo));
}

export function totals(tx) {
  let receitas = 0;
  let despesas = 0;
  for (const t of tx) {
    if (t.tipo === 'receita') receitas += t.valor;
    else despesas += t.valor;
  }
  return { receitas, despesas, saldo: receitas - despesas };
}

export function byPerson(tx, list) {
  return list.map((p) => ({ person: p, ...totals(tx.filter((t) => t.pessoa === p.email)) }));
}

export function byCategory(tx, cats, tipo) {
  const map = new Map();
  for (const t of tx) {
    if (t.tipo !== tipo) continue;
    const key = t.categoria || 'Sem categoria';
    map.set(key, (map.get(key) || 0) + t.valor);
  }
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  return [...map.entries()]
    .map(([nome, valor]) => {
      const cat = cats.find((c) => c.nome === nome && c.tipo === tipo);
      return { nome, valor, icone: cat?.icone || '🏷️', pct: total ? valor / total : 0 };
    })
    .sort((a, b) => b.valor - a.valor);
}

export function trend(tx, endMonth, n = 6) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const month = addMonths(endMonth, -i);
    out.push({ month, ...totals(filterTx(tx, { month })) });
  }
  return out;
}
