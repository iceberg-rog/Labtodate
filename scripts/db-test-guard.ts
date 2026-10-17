/**
 * Guard for the DB test suites (scripts/test-*.db.ts). They create orders,
 * fiscal documents and number-series rows that — by design — can never be
 * deleted again, so they must only ever run against a database that is
 * EXPLICITLY a test database. Allow-list, not a deny-list:
 *
 *  - the server is on this machine (127.0.0.1 / localhost / ::1) — a Docker
 *    service name such as `db` (the production compose file) is refused;
 *  - the database name is a test name: `lab2date_test`, `lab2date_qa`,
 *    `lab2date_ci`, `lab2date_w<N>_<name>` (QA worktrees) or `<anything>_test`;
 *    any other name must be repeated in L2D_DB_TESTS_ALLOW (exact match) to
 *    opt in.
 */
export function testDatabaseProblem(url: string | undefined, allow = process.env.L2D_DB_TESTS_ALLOW ?? ''): string | null {
  if (!url) return 'DATABASE_URL is not set.';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'DATABASE_URL is not a URL.';
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return `DATABASE_URL is not a PostgreSQL URL (${u.protocol}).`;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return `the database host "${host}" is not this machine — DB tests only run against a local test database.`;
  const name = decodeURIComponent(u.pathname.replace(/^\//, '')).split('?')[0];
  const testName = /^lab2date_(test|qa|ci|w\d+(_[a-z0-9]+)+)$/i.test(name) || /_test$/i.test(name);
  if (!testName && allow !== name) {
    return `the database "${name}" is not marked as a test database (allowed: lab2date_test, lab2date_qa, lab2date_ci, lab2date_w<N>_<name>, *_test — or set L2D_DB_TESTS_ALLOW=${name} to opt in on purpose).`;
  }
  return null;
}

/** Throw before any test touches the database unless it is an allowed test database. */
export function assertTestDatabase(): void {
  const why = testDatabaseProblem(process.env.DATABASE_URL);
  if (why) throw new Error(`Refusing to run the DB tests: ${why} They create documents that can never be deleted.`);
}
