import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvDocument, csvMoney, csvRate, fileSlug } from './csv';

test('cells: quoting and formula injection, amounts stay numeric', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-12.10'), '-12.10');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
  assert.equal(csvMoney(-1210), '-12.10');
  assert.equal(csvMoney(null), '');
  assert.equal(csvRate(2100), '21');
  assert.equal(csvRate(550), '5.5');
  assert.equal(csvRate(0), '0');
});

test('document: BOM, header, rows; brand as file prefix', () => {
  const csv = csvDocument(['a', 'b'], [['1', 'x y']]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.slice(1), 'a,b\n1,x y');
  assert.equal(fileSlug('Labtodate'), 'labtodate');
  assert.equal(fileSlug('Lab to Date B.V.'), 'lab-to-date-b-v');
  assert.equal(fileSlug('***'), 'export');
});
