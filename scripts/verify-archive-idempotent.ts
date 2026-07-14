/**
 * Offline regression matrix for BUG-040 — admin `archiveOrder` / `unarchiveOrder`
 * idempotency (audit-integrity, sibling of BUG-010 "setOrderFulfillment idempotent").
 *
 * Models a concurrent double-click (two requests that both read the row BEFORE
 * either write lands). Compares:
 *   OLD: snapshot read + caller-side guard, then an UNCONDITIONAL
 *        `order.update({where:{id}})` + UNCONDITIONAL `audit()`.
 *   NEW: keep the friendly fast-path guard, then an atomic
 *        `order.updateMany({where:{id, archivedAt: null}})` (or `{not:null}` for
 *        unarchive) claim, with `audit()` gated on `count === 1`.
 *
 * Asserts NEW archives/unarchives + audits EXACTLY ONCE under a double-submit;
 * documents OLD double-auditing. No DB, no network — pure logic model.
 *
 * Run: node --experimental-strip-types scripts/verify-archive-idempotent.ts
 */
export {};

interface Row {
  archivedAt: Date | null;
  archivedById: string | null;
}

// Atomic predicate-write: applies only if the row currently matches `wantArchived`.
// Returns rows claimed (0 or 1) — models Prisma updateMany's count under WHERE.
function claimArchive(row: Row, wantArchivedNull: boolean, set: Row): number {
  const matches = wantArchivedNull ? row.archivedAt === null : row.archivedAt !== null;
  if (!matches) return 0;
  row.archivedAt = set.archivedAt;
  row.archivedById = set.archivedById;
  return 1;
}

// OLD archive: both requests snapshot archivedAt=null, both pass the guard,
// both write + both audit.
function runOldArchive(row: Row): number {
  const snap1 = row.archivedAt;
  const snap2 = row.archivedAt;
  let audits = 0;
  for (const snap of [snap1, snap2]) {
    if (snap) continue;
    row.archivedAt = new Date();
    row.archivedById = 'admin';
    audits++;
  }
  return audits;
}

// NEW archive: fast-path guard then atomic claim; audit only when count === 1.
function runNewArchive(row: Row): number {
  const snap1 = row.archivedAt;
  const snap2 = row.archivedAt;
  let audits = 0;
  for (const snap of [snap1, snap2]) {
    if (snap) continue;
    const count = claimArchive(row, true, { archivedAt: new Date(), archivedById: 'admin' });
    if (count !== 1) continue;
    audits++;
  }
  return audits;
}

// NEW unarchive: symmetric — claim only while archivedAt is non-null.
function runNewUnarchive(row: Row): number {
  const snap1 = row.archivedAt;
  const snap2 = row.archivedAt;
  let audits = 0;
  for (const snap of [snap1, snap2]) {
    if (!snap) continue;
    const count = claimArchive(row, false, { archivedAt: null, archivedById: null });
    if (count !== 1) continue;
    audits++;
  }
  return audits;
}

let failures = 0;
function check(name: string, got: number, want: number): void {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${got} want=${want}`);
}

check('OLD archive double-click audits (defect baseline)',
  runOldArchive({ archivedAt: null, archivedById: null }), 2);
check('NEW archive double-click audits once',
  runNewArchive({ archivedAt: null, archivedById: null }), 1);
check('NEW archive on already-archived audits zero',
  runNewArchive({ archivedAt: new Date(), archivedById: 'admin' }), 0);
check('NEW unarchive double-click audits once',
  runNewUnarchive({ archivedAt: new Date(), archivedById: 'admin' }), 1);
check('NEW unarchive on not-archived audits zero',
  runNewUnarchive({ archivedAt: null, archivedById: null }), 0);

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
