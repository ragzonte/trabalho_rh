// Revisão de segurança e privacidade: regras pequenas que atravessam mais de uma tela.
//   node --test tests/review-seg.test.mjs
//
// (As regras maiores ficam nos testes de cada módulo: store, net-logic, export-format, recorder,
// mapmodel, map-storage; o comportamento de ponta a ponta em tests/e2e/review-seg.e2e.mjs.)

import test from 'node:test';
import assert from 'node:assert/strict';

import { isDemoOrigin, matchesMode, foreignDraftText } from '../app/js/ui/map/map-ui-logic.js';

// ---------------------------------------------------------------------------
// De onde é um levantamento (demonstração x Wi-Fi de verdade)
// ---------------------------------------------------------------------------

test('origem do rascunho: só é da demonstração quando diz isso com todas as letras', () => {
  assert.equal(isDemoOrigin({ demo: true }), true);
  assert.equal(isDemoOrigin({ demo: false }), false);
  // sem o campo (ou com lixo nele) conta como do Wi-Fi de verdade: nunca vira "demonstração" por engano
  assert.equal(isDemoOrigin({}), false);
  assert.equal(isDemoOrigin({ demo: 'true' }), false);
  assert.equal(isDemoOrigin({ demo: 1 }), false);
  assert.equal(isDemoOrigin(null), false);
  assert.equal(isDemoOrigin('demo'), false);
});

test('um rascunho só continua no modo em que foi feito', () => {
  assert.equal(matchesMode({ demo: true }, true), true);
  assert.equal(matchesMode({ demo: false }, false), true);
  assert.equal(matchesMode({}, false), true);
  assert.equal(matchesMode({ demo: true }, false), false, 'casa virtual não continua com o Wi-Fi de verdade');
  assert.equal(matchesMode({ demo: false }, true), false, 'Wi-Fi de verdade não continua na casa virtual');
  assert.equal(matchesMode({}, true), false);
});

test('cartão do rascunho do outro modo: diz de onde é e como continuar', () => {
  const demo = foreignDraftText({ demo: true });
  assert.equal(demo.title, 'Rascunho da demonstração');
  assert.match(demo.how, /ligue o modo demonstração/);
  const real = foreignDraftText({ demo: false });
  assert.equal(real.title, 'Rascunho do Wi-Fi de verdade');
  assert.match(real.how, /saia da demonstração/);
  // no navegador não existe "sair da demonstração"
  assert.match(foreignDraftText({}, { locked: true }).how, /no celular/);
});
