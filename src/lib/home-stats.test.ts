import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveStats } from './home-stats';
import { parsePairs } from './home-sections';

test('live counts carry the labels from Admin → Homepage (singular / plural); a count of 0 is not shown', () => {
  assert.deepEqual(liveStats({ listings: 812, suppliers: 1, countries: 0 }), [
    { value: 812, suffix: '', label: 'instruments listed' },
    { value: 1, suffix: '', label: 'supplier onboarded' },
  ]);
  const labels = parsePairs('Gerät|Geräte\nLieferant|Lieferanten\nLand|Länder');
  assert.deepEqual(liveStats({ listings: 1, suppliers: 3, countries: 2 }, labels).map((s) => s.label), ['Gerät', 'Lieferanten', 'Länder']);
  // a line left empty hides that stat rather than showing a bare number
  assert.deepEqual(liveStats({ listings: 5, suppliers: 2, countries: 2 }, parsePairs('a|b')).map((s) => s.label), ['b']);
});
