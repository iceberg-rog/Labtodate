import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDaysEndOfDay, cancelAfter, daysUntil, duePhase, effectiveDueDate, fmtDueDate, remindersToSend } from './payment-due';

const d = (s: string) => new Date(s);

test('one due date: Order.dueAt, else the legacy quote validity, else order date + term', () => {
  const created = d('2026-10-02T10:00:00Z');
  assert.equal(effectiveDueDate({ dueAt: d('2026-10-20T23:59:59.999Z'), createdAt: created }, 14).toISOString(), '2026-10-20T23:59:59.999Z');
  assert.equal(effectiveDueDate({ dueAt: null, createdAt: created, legacyValidUntil: d('2026-10-09T23:59:59.999Z') }, 14).toISOString(), '2026-10-09T23:59:59.999Z');
  assert.equal(effectiveDueDate({ dueAt: null, createdAt: created }, 14).toISOString(), '2026-10-16T23:59:59.999Z');
  assert.equal(addDaysEndOfDay(created, 0).toISOString(), '2026-10-02T23:59:59.999Z');
});

test('due phases: payable until the end of the due day, overdue during grace, cancel after grace', () => {
  const due = d('2026-10-16T23:59:59.999Z');
  assert.equal(duePhase(d('2026-10-16T22:00:00Z'), due, 3), 'OPEN');
  assert.equal(duePhase(d('2026-10-17T08:00:00Z'), due, 3), 'OVERDUE');
  assert.equal(duePhase(d('2026-10-19T23:00:00Z'), due, 3), 'OVERDUE');
  assert.equal(duePhase(d('2026-10-20T00:00:01Z'), due, 3), 'CANCEL_DUE');
  assert.equal(duePhase(d('2026-10-17T00:00:01Z'), due, 0), 'CANCEL_DUE');
  assert.equal(cancelAfter(due, 3).toISOString(), '2026-10-19T23:59:59.999Z');
});

test('reminders: each step once; a missed earlier step is skipped, not sent late', () => {
  const due = d('2026-10-16T23:59:59.999Z');
  assert.deepEqual(remindersToSend(d('2026-10-10T09:00:00Z'), due, [7, 3, 1], []), { send: 7, skip: [] });
  assert.deepEqual(remindersToSend(d('2026-10-12T09:00:00Z'), due, [7, 3, 1], [7]), { send: null, skip: [] });
  assert.deepEqual(remindersToSend(d('2026-10-13T09:00:00Z'), due, [7, 3, 1], [7]), { send: 3, skip: [] });
  // server was down from day -7 to day -1: only the 1-day reminder goes out
  assert.deepEqual(remindersToSend(d('2026-10-15T09:00:00Z'), due, [7, 3, 1], []), { send: 1, skip: [3, 7] });
  assert.deepEqual(remindersToSend(d('2026-10-17T09:00:00Z'), due, [7, 3, 1], []), { send: null, skip: [] });
  assert.equal(daysUntil(d('2026-10-16T01:00:00Z'), due), 0);
});

test('buyer-facing date format is the same everywhere', () => {
  assert.equal(fmtDueDate('2026-10-16T23:59:59.999Z'), '16 Oct 2026');
});

test('integration s2a+s2b: an order that was on a pre-payment hold counts its term from payableSince', () => {
  const created = d('2026-10-02T10:00:00Z');
  const payable = d('2026-10-12T09:00:00Z'); // hold released ten days later
  assert.equal(effectiveDueDate({ dueAt: null, createdAt: created, payableSince: payable }, 14).toISOString(), '2026-10-26T23:59:59.999Z');
  assert.equal(effectiveDueDate({ dueAt: null, createdAt: created, payableSince: null }, 14).toISOString(), '2026-10-16T23:59:59.999Z');
  // A due date already set (printed on the proforma) always wins.
  assert.equal(effectiveDueDate({ dueAt: d('2026-10-20T23:59:59.999Z'), createdAt: created, payableSince: payable }, 14).toISOString(), '2026-10-20T23:59:59.999Z');
});
