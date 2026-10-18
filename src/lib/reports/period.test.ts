import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inPeriod, isDay, localDay, periodKeyLabel, periodParams, prefilterBounds, quarterOf, resolvePeriod } from './period';

const TZ = 'Europe/Amsterdam';
const NOW = new Date('2026-10-18T10:00:00Z');

test('days are counted in the business time zone', () => {
  // 00:30 on 1 April in Amsterdam is still 31 March in UTC: it belongs to Q2.
  const d = new Date('2026-03-31T22:30:00Z');
  assert.equal(localDay(d, TZ), '2026-04-01');
  assert.equal(quarterOf(localDay(d, TZ)), '2026-Q2');
  assert.equal(localDay(d, 'UTC'), '2026-03-31');
});

test('calendar presets', () => {
  assert.deepEqual(
    [resolvePeriod({ period: 'this-month' }, NOW, TZ)].map((p) => [p.from, p.to, p.label]),
    [['2026-10-01', '2026-10-31', 'October 2026']],
  );
  const lm = resolvePeriod({ period: 'last-month' }, new Date('2026-01-10T12:00:00Z'), TZ);
  assert.deepEqual([lm.from, lm.to], ['2025-12-01', '2025-12-31']);
  const q = resolvePeriod({ period: 'this-quarter' }, NOW, TZ);
  assert.deepEqual([q.from, q.to, q.label], ['2026-10-01', '2026-12-31', 'Q4 2026']);
  const lq = resolvePeriod({ period: 'last-quarter' }, new Date('2026-02-01T12:00:00Z'), TZ);
  assert.deepEqual([lq.from, lq.to, lq.label], ['2025-10-01', '2025-12-31', 'Q4 2025']);
  const feb = resolvePeriod({ period: 'last-month' }, new Date('2028-03-05T12:00:00Z'), TZ);
  assert.equal(feb.to, '2028-02-29');
  assert.equal(resolvePeriod({ period: 'last-year' }, NOW, TZ).label, '2025');
  assert.equal(resolvePeriod({ period: 'bogus' }, NOW, TZ).key, 'all');
});

test('custom range: valid days only, swapped when reversed, either end open', () => {
  const p = resolvePeriod({ from: '2026-10-31', to: '2026-10-01' }, NOW, TZ);
  assert.deepEqual([p.key, p.from, p.to], ['custom', '2026-10-01', '2026-10-31']);
  assert.equal(resolvePeriod({ from: '2026-02-30' }, NOW, TZ).key, 'all');
  assert.equal(isDay('2026-02-28'), true);
  assert.equal(isDay('2026-2-28'), false);
  const open = resolvePeriod({ from: '2026-07-01' }, NOW, TZ);
  assert.deepEqual([open.from, open.to], ['2026-07-01', null]);
  assert.deepEqual(periodParams(open), { from: '2026-07-01' });
  assert.deepEqual(periodParams(resolvePeriod({ period: 'this-year' }, NOW, TZ)), { period: 'this-year' });
  assert.deepEqual(periodParams(resolvePeriod({}, NOW, TZ)), {});
});

test('inPeriod: day bounds inclusive, rolling windows by instant, undated rows only in all time', () => {
  const q4 = resolvePeriod({ period: 'this-quarter' }, NOW, TZ);
  assert.equal(inPeriod(new Date('2026-09-30T22:30:00Z'), q4, TZ), true); // 1 Oct 00:30 local
  assert.equal(inPeriod(new Date('2026-09-30T21:30:00Z'), q4, TZ), false); // 30 Sep 23:30 local
  assert.equal(inPeriod(new Date('2026-12-31T22:59:00Z'), q4, TZ), true);
  const r30 = resolvePeriod({ period: '30d' }, NOW, TZ);
  assert.equal(inPeriod(new Date(NOW.getTime() - 29 * 864e5), r30, TZ), true);
  assert.equal(inPeriod(new Date(NOW.getTime() - 31 * 864e5), r30, TZ), false);
  assert.equal(inPeriod(null, r30, TZ), false);
  assert.equal(inPeriod(null, resolvePeriod({}, NOW, TZ), TZ), true);
});

test('the database pre-filter is wider than the period', () => {
  const p = resolvePeriod({ period: 'this-month' }, NOW, TZ);
  const b = prefilterBounds(p);
  assert.ok(b.gte && b.gte.getTime() < Date.parse('2026-09-30T22:00:00Z'));
  assert.ok(b.lt && b.lt.getTime() > Date.parse('2026-10-31T23:00:00Z'));
  assert.deepEqual(prefilterBounds(resolvePeriod({}, NOW, TZ)), {});
});

test('period key labels', () => {
  assert.equal(periodKeyLabel('2026-Q3'), 'Q3 2026');
  assert.equal(periodKeyLabel('2026-03'), 'March 2026');
});
