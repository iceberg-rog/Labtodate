import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FAILURE_TTL_MS, LogoUnavailableError, companyLogoDataUri, logoCacheFresh } from './logo';

test('a loaded logo is cached for minutes, a failure only for about 30 seconds', () => {
  const now = 1_000_000_000;
  assert.equal(logoCacheFresh({ at: now - 5 * 60_000, value: 'data:image/png;base64,AA==' }, now), true);
  assert.equal(logoCacheFresh({ at: now - 11 * 60_000, value: 'data:image/png;base64,AA==' }, now), false);
  assert.equal(logoCacheFresh({ at: now - (FAILURE_TTL_MS - 1), error: 'timeout' }, now), true);
  assert.equal(logoCacheFresh({ at: now - FAILURE_TTL_MS, error: 'timeout' }, now), false);
  assert.ok(FAILURE_TTL_MS <= 30_000);
  assert.equal(logoCacheFresh(undefined, now), false);
});

test('no logo configured: null; a logo that can not be loaded: null for previews, an error for the stored PDF', async () => {
  assert.equal(await companyLogoDataUri(''), null);
  assert.equal(await companyLogoDataUri(null, { strict: true }), null);
  assert.equal(await companyLogoDataUri('/no-such-logo-file.png'), null);
  await assert.rejects(companyLogoDataUri('/no-such-logo-file.png', { strict: true }), LogoUnavailableError);
  await assert.rejects(companyLogoDataUri('/../etc/passwd.png', { strict: true }), LogoUnavailableError);
  await assert.rejects(companyLogoDataUri('ftp://example.org/logo.png', { strict: true }), LogoUnavailableError);
});

test('an admin-set https logo on a private address is refused (SSRF guard), never fetched', async () => {
  await assert.rejects(companyLogoDataUri('https://127.0.0.1/logo.png', { strict: true }), /Blocked IP literal/);
  await assert.rejects(companyLogoDataUri('https://169.254.169.254/latest/meta-data.png', { strict: true }), /Blocked IP literal/);
});

test('a logo shipped in /public loads as a data: URI', async () => {
  const uri = await companyLogoDataUri('/sampars-logo.png', { strict: true });
  assert.match(uri ?? '', /^data:image\/png;base64,/);
});

test('a logo that failed once: the stored PDF tries again at once and is branded when it is back; previews wait ~30 s', async () => {
  const png = readFileSync(path.join(process.cwd(), 'public', 'sampars-logo.png'));
  const dir = mkdtempSync(path.join(tmpdir(), 'logo-'));
  mkdirSync(path.join(dir, 'public'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await assert.rejects(companyLogoDataUri('/flaky.png', { strict: true }), LogoUnavailableError);
    writeFileSync(path.join(dir, 'public', 'flaky.png'), png);
    // A preview within the failure window still prints the name…
    assert.equal(await companyLogoDataUri('/flaky.png'), null);
    // …the PDF render does not trust the cached failure.
    assert.match((await companyLogoDataUri('/flaky.png', { strict: true })) ?? '', /^data:image\/png;base64,/);
    assert.match((await companyLogoDataUri('/flaky.png')) ?? '', /^data:image\/png;base64,/);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
