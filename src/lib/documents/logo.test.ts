import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SafeFetchError } from '../import/safe-fetch';
import { FAILURE_TTL_MS, LogoUnavailableError, checkDocumentLogo, companyLogoDataUri, documentLogo, logoCacheFresh, logoFailureIsPermanent } from './logo';

test('a loaded logo is cached for minutes, a failure only for about 30 seconds', () => {
  const now = 1_000_000_000;
  assert.equal(logoCacheFresh({ at: now - 5 * 60_000, value: 'data:image/png;base64,AA==' }, now), true);
  assert.equal(logoCacheFresh({ at: now - 11 * 60_000, value: 'data:image/png;base64,AA==' }, now), false);
  assert.equal(logoCacheFresh({ at: now - (FAILURE_TTL_MS - 1), error: 'timeout', permanent: false }, now), true);
  assert.equal(logoCacheFresh({ at: now - FAILURE_TTL_MS, error: 'timeout', permanent: false }, now), false);
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

test('logo failures: a wrong file / type / size / address is permanent; timeouts, network and storage errors are retried', () => {
  // Permanent — an admin must fix Settings → Company → Logo.
  assert.equal(logoFailureIsPermanent(Object.assign(new Error('no such file'), { code: 'ENOENT' })), true);
  assert.equal(logoFailureIsPermanent(Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })), true);
  assert.equal(logoFailureIsPermanent(Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })), true);
  assert.equal(logoFailureIsPermanent(new SafeFetchError('Blocked IP literal (loopback-127/8).', 'PRIVATE_IP')), true);
  assert.equal(logoFailureIsPermanent(new SafeFetchError('Body larger than 2097152 bytes.', 'TOO_LARGE')), true);
  // Retryable — the next download tries again.
  assert.equal(logoFailureIsPermanent(new Error('timeout')), false);
  assert.equal(logoFailureIsPermanent(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), false);
  assert.equal(logoFailureIsPermanent(Object.assign(new Error('Please reduce your request rate.'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } })), false);
  assert.equal(logoFailureIsPermanent(Object.assign(new Error('Too Many Requests'), { $metadata: { httpStatusCode: 429 } })), false);
  assert.equal(logoFailureIsPermanent(new SafeFetchError('Timed out after 4000 ms.', 'TIMEOUT')), false);
  assert.equal(logoFailureIsPermanent(new SafeFetchError('DNS lookup failed for x', 'DNS_FAIL')), false);
});

test('the stored PDF learns whether a logo failure is permanent (missing file, unsupported address) — and Verify agrees with the renderer', async () => {
  const png = readFileSync(path.join(process.cwd(), 'public', 'sampars-logo.png'));
  const dir = mkdtempSync(path.join(tmpdir(), 'logo-'));
  mkdirSync(path.join(dir, 'public'));
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(path.join(dir, 'public', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(path.join(dir, 'public', 'huge.gif'), Buffer.alloc(2 * 1024 * 1024 + 1, 1));
    writeFileSync(path.join(dir, 'public', 'ok.png'), png);
    for (const url of ['/missing.png', '/logo.svg', '/huge.gif', 'http://example.org/logo.png', 'ftp://example.org/logo.png']) {
      const r = await documentLogo(url, { fresh: true });
      assert.equal(r.dataUri, null, url);
      assert.equal(r.problem?.permanent, true, url);
      await assert.rejects(companyLogoDataUri(url, { strict: true }), (e: unknown) => e instanceof LogoUnavailableError && e.permanent, url);
      const v = await checkDocumentLogo(url);
      assert.equal(v.ok, false, url);
      assert.match(v.message, /Documents can not use this logo/, url);
    }
    assert.match((await documentLogo('/logo.svg', { fresh: true })).problem?.reason ?? '', /not a png \/ jpeg \/ webp \/ gif image/);
    assert.match((await documentLogo('/huge.gif', { fresh: true })).problem?.reason ?? '', /larger than 2 MB/);
    const ok = await checkDocumentLogo('/ok.png');
    assert.equal(ok.ok, true);
    assert.match(ok.message, /Usable on documents \(image\/png/);
    assert.deepEqual(await documentLogo(''), { dataUri: null, problem: null });
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
