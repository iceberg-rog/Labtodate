import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentLabel } from './MessageAttachments';

test('attachment chips show the original file name, else the stored key', () => {
  const url = '/api/support-attachment/quote/afbf7a77c0d2ef6.pdf';
  assert.equal(attachmentLabel(url, 'G1-datasheet.pdf'), 'G1-datasheet.pdf');
  assert.equal(attachmentLabel(url, '  '), 'afbf7a77c0d2ef6.pdf');
  assert.equal(attachmentLabel(url), 'afbf7a77c0d2ef6.pdf');
  assert.equal(attachmentLabel('/api/support-attachment/x/r%C3%A9sum%C3%A9.pdf?t=abc'), 'résumé.pdf');
  // A malformed escape never breaks the page.
  assert.equal(attachmentLabel('/api/support-attachment/x/bad%E0.pdf'), 'bad%E0.pdf');
});
