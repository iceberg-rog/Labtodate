import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeHomeVersion, encodeHomeVersion, homeVersionConflict } from './editor-version';

const opened = { live: '12@2026-10-18T09:00:00.000Z', draft: '2026-10-18T09:05:00.000Z' };

test('the version posted by the editor round-trips; anything else reads as unknown', () => {
  assert.deepEqual(decodeHomeVersion(encodeHomeVersion(opened)), opened);
  assert.deepEqual(decodeHomeVersion(encodeHomeVersion({ live: '0@-', draft: '' })), { live: '0@-', draft: '' });
  for (const bad of [null, undefined, '', 'nope', '["a"]', '[1,2]', '{"live":"a","draft":"b"}', 'x'.repeat(201)]) assert.equal(decodeHomeVersion(bad), null, String(bad));
});

test('a submit from an editor opened before another admin published, reverted or saved a draft is refused', () => {
  const publishedSince = { ...opened, live: '13@2026-10-18T09:10:00.000Z' };
  const draftSince = { ...opened, draft: '2026-10-18T09:11:00.000Z' };
  const noDraftNow = { ...opened, draft: '' };
  for (const intent of ['draft', 'publish'] as const) {
    assert.equal(homeVersionConflict(intent, opened, opened), null, `${intent}: nothing changed`);
    assert.equal(homeVersionConflict(intent, opened, publishedSince), 'live', `${intent}: would put the old values back`);
    assert.equal(homeVersionConflict(intent, opened, draftSince), 'draft', `${intent}: would overwrite / drop the other draft`);
    assert.equal(homeVersionConflict(intent, opened, noDraftNow), 'draft', `${intent}: the draft was published or discarded`);
    assert.equal(homeVersionConflict(intent, null, opened), 'unknown');
  }
  // discarding drops only the draft: a newer live page does not matter, a newer draft does
  assert.equal(homeVersionConflict('discard', opened, publishedSince), null);
  assert.equal(homeVersionConflict('discard', opened, draftSince), 'draft');
  assert.equal(homeVersionConflict('discard', null, opened), 'unknown');
});
