import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotationAttachment, quotationPath } from './quotation';

test('quotation PDF: path per quote (and revision); no attachment until PDFs are rendered', async () => {
  assert.equal(quotationPath('clx1'), '/api/documents/quotation/clx1');
  assert.equal(quotationPath('clx1', 2), '/api/documents/quotation/clx1?rev=2');
  assert.equal(quotationPath('a/b', 0), '/api/documents/quotation/a%2Fb');
  assert.equal(await quotationAttachment('clx1'), null);
});
