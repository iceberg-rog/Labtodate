import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acqMoveRefusal, bankLocked, canMoveAcq, holderMatches, maskIban, payoutAccountProblem } from './stages';

test('acquisition stages only move forward, one step (A22)', () => {
  assert.equal(canMoveAcq('AWAITING_BANK', 'AWAITING_SHIPPING'), true);
  assert.equal(canMoveAcq('AWAITING_SHIPPING', 'IN_TRANSIT'), true);
  assert.equal(canMoveAcq('AWAITING_SHIPPING', 'RECEIVED'), true, 'a parcel can arrive before tracking was entered');
  assert.equal(canMoveAcq('COMPLETED', 'IN_TRANSIT'), false, 'a stale tab can not move a completed deal back');
  assert.equal(canMoveAcq('IN_TRANSIT', 'COMPLETED'), false, 'no payout before receipt');
  assert.equal(canMoveAcq('RECEIVED', 'RECEIVED'), false, 'a double click is not a move');
  assert.equal(canMoveAcq(null, 'AWAITING_SHIPPING'), false);
  assert.match(acqMoveRefusal('COMPLETED', 'IN_TRANSIT'), /completed/);
});

test('payout account locks from the configured stage (A23)', () => {
  assert.equal(bankLocked('AWAITING_BANK', 'AWAITING_SHIPPING'), false);
  assert.equal(bankLocked('AWAITING_SHIPPING', 'AWAITING_SHIPPING'), true);
  assert.equal(bankLocked('IN_TRANSIT', 'RECEIVED'), false);
  assert.equal(bankLocked('COMPLETED', 'RECEIVED'), true);
});

test('IBAN mod-97, SWIFT shape, holder match', () => {
  const a = { holder: 'Lab Pars B.V.', iban: 'NL91 ABNA 0417 1643 00', swift: 'ABNANL2A', bankName: '', country: 'NL', notes: '' };
  assert.equal(payoutAccountProblem(a, true), null);
  assert.match(payoutAccountProblem({ ...a, iban: 'NL91 ABNA 0417 1643 01' }, true) ?? '', /not valid/);
  assert.match(payoutAccountProblem({ ...a, iban: '123456789' }, true) ?? '', /valid IBAN/);
  assert.equal(payoutAccountProblem({ ...a, iban: '123456789' }, false), null, 'non-IBAN account allowed when the setting is off');
  assert.match(payoutAccountProblem({ ...a, swift: 'XX' }, true) ?? '', /SWIFT/);
  assert.equal(holderMatches('Lab Pars BV', ['Dr. Someone', 'Lab Pars B.V.']), true);
  assert.equal(holderMatches('John Smith', ['Lab Pars B.V.', 'Ali Rezaei']), false);
  assert.equal(maskIban('NL91ABNA0417164300'), 'NL91 •••• 4300');
});
