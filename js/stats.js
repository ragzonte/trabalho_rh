// Cálculos para o painel e os gráficos.

import { addMonths, monthOf } from './format.js';

// Cores fixas por pessoa (segue a pessoa, nunca a posição no ranking).
const MEMBER_SLOTS = ['--c-mem1', '--c-mem2', '--c-mem3', '--c-mem4'];

/** Lista de pessoas: membros da planilha + nomes que aparecem em lançamentos antigos. */
export function people(state) {
  const list = state.members.map((m) => ({ nome: m.nome }));
  for (const t of state.tx) {
    if (t.pessoa && !list.some((p) => p.nome === t.pessoa)) list.push({ nome: t.pessoa });
  }
  return list.map((p, i) => ({
    ...p,
    label: p.nome,
    color: `var(${MEMBER_SLOTS[i % MEMBER_SLOTS.length]})`,
  }));
}

export const personOf = (list, nome) =>
  list.find((p) => p.nome === nome) || { nome, label: nome || '—', color: 'var(--ink-muted)' };

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
  return list.map((p) => ({ person: p, ...totals(tx.filter((t) => t.pessoa === p.nome)) }));
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
