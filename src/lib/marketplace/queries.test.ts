import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removedListingOutcome } from './queries';

const archived = { status: 'ARCHIVED', categorySlug: 'hplc-lc' };

test('a Redirects rule for the address wins: 301 to its target, 410 = gone', () => {
  assert.deepEqual(
    removedListingOutcome({ rule: { toPath: '/marketplace/new-slug', statusCode: 301 }, listing: archived, archivedResponse: 'GONE' }),
    { kind: 'redirect', to: '/marketplace/new-slug' },
  );
  assert.deepEqual(
    removedListingOutcome({ rule: { toPath: null, statusCode: 410 }, listing: null, archivedResponse: 'REDIRECT_CATEGORY' }),
    { kind: 'gone' },
  );
  // A 410 rule never redirects, even with a target typed in.
  assert.deepEqual(removedListingOutcome({ rule: { toPath: '/x', statusCode: 410 }, listing: null, archivedResponse: 'GONE' }), { kind: 'gone' });
  // A target that is not a site path or an http(s) URL is not followed.
  for (const toPath of ['//evil.example/x', 'javascript:alert(1)', '', null]) {
    assert.deepEqual(removedListingOutcome({ rule: { toPath, statusCode: 301 }, listing: null, archivedResponse: 'GONE' }), { kind: 'gone' }, String(toPath));
  }
  assert.deepEqual(
    removedListingOutcome({ rule: { toPath: 'https://labtodate.com/marketplace', statusCode: 301 }, listing: null, archivedResponse: 'GONE' }),
    { kind: 'redirect', to: 'https://labtodate.com/marketplace' },
  );
});

test('an archived listing is gone, or redirected to its category (setting)', () => {
  assert.deepEqual(removedListingOutcome({ rule: null, listing: archived, archivedResponse: 'GONE' }), { kind: 'gone' });
  assert.deepEqual(removedListingOutcome({ rule: null, listing: archived, archivedResponse: 'REDIRECT_CATEGORY' }), {
    kind: 'redirect',
    to: '/marketplace?category=hplc-lc',
  });
});

test('unknown, draft and pending listings are simply not found (nothing reveals them)', () => {
  assert.deepEqual(removedListingOutcome({ rule: null, listing: null, archivedResponse: 'REDIRECT_CATEGORY' }), { kind: 'not-found' });
  for (const status of ['DRAFT', 'PENDING_REVIEW']) {
    assert.deepEqual(
      removedListingOutcome({ rule: null, listing: { status, categorySlug: 'hplc-lc' }, archivedResponse: 'REDIRECT_CATEGORY' }),
      { kind: 'not-found' },
      status,
    );
  }
});
