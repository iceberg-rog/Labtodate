import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECEIPT_MAX_BYTES, RECEIPT_TYPE_MESSAGE, storeReceiptFile } from './receipts';

// Refusals happen before anything is uploaded (no storage needed here).

test('a text file renamed .pdf is refused as “not a PDF or image”', async () => {
  const fake = new File(['This is not a bank statement.'], 'receipt.pdf', { type: 'application/pdf' });
  const r = await storeReceiptFile(fake, 'L2D-2026-TEST01');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, 'type');
    assert.equal(r.message, RECEIPT_TYPE_MESSAGE);
    assert.match(r.message, /not a PDF or image/);
  }
});

test('SVG / HTML disguised as an image are refused too', async () => {
  for (const [body, name, type] of [
    ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'r.png', 'image/png'],
    ['<html><body>hi</body></html>', 'r.webp', 'image/webp'],
  ]) {
    const r = await storeReceiptFile(new File([body], name, { type }), 'L2D-2026-TEST01');
    assert.ok(!r.ok && r.code === 'type', name);
  }
});

test('an oversized receipt is refused with the size limit', async () => {
  const big = new File([new Uint8Array(RECEIPT_MAX_BYTES + 1)], 'scan.pdf', { type: 'application/pdf' });
  const r = await storeReceiptFile(big, 'L2D-2026-TEST01');
  assert.ok(!r.ok && r.code === 'large' && /8 MB/.test(r.message));
});
