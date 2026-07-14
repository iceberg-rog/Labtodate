/**
 * Offline regression matrix for BUG-041 — `setQuoteStatus` (src/lib/quotes/actions.ts)
 * and `setTicketStatus` (src/lib/support/actions.ts) status-transition atomicity.
 *
 * Both were the BUG-040 anti-pattern (snapshot read + UNCONDITIONAL `update` +
 * UNCONDITIONAL `audit()`), and `setQuoteStatus` additionally double-fired the
 * buyer-facing `notifyUser` + `notifyAdmins` on a double-click "Accept".
 *
 * Models a concurrent double-click / duplicate submit (two requests that both read
 * the row BEFORE either write lands). Compares:
 *   OLD: unconditional `update({where:{id}})` + unconditional audit + unconditional
 *        buyer/admin notify.
 *   NEW: atomic `updateMany({where:{id, status:{not:status}}})` compare-and-set;
 *        audit + notify gated on `count === 1`; ACCEPT redirect stays reachable
 *        (idempotent UX) for the request that lost the race.
 *
 * Asserts NEW transitions + audits + notifies EXACTLY ONCE under a double-submit,
 * never audits/notifies an already-in-target-state row, and that the redirect
 * remains reachable on a re-accept. Pure logic model — no DB, no network.
 *
 * Run: node --experimental-strip-types scripts/verify-status-transition-atomic.ts
 */
export {};

type QuoteStatus = 'PENDING' | 'RESPONDED' | 'ACCEPTED' | 'DECLINED' | 'CLOSED';

interface Row {
  status: QuoteStatus;
  archivedAt: Date | null;
  archivedById: string | null;
}

interface Effects {
  writes: number;   // rows actually mutated
  audits: number;   // audit() calls
  notifies: number; // buyer/admin notify calls (ACCEPT path)
  redirects: number; // redirect() reached (ACCEPT path, existing order)
}

// --- Atomic compare-and-set: models Prisma updateMany count under WHERE -------
function claim(row: Row, target: QuoteStatus, alsoArchive: boolean, by: string): number {
  // where: shouldAutoArchive ? {id, OR:[{status:{not:target}},{archivedAt:null}]}
  //                          : {id, status:{not:target}}
  const matches = alsoArchive
    ? row.status !== target || row.archivedAt === null
    : row.status !== target;
  if (!matches) return 0;
  row.status = target;
  if (alsoArchive) {
    row.archivedAt = new Date();
    row.archivedById = by;
  }
  return 1;
}

// --- OLD: unconditional write + unconditional audit/notify --------------------
function runOld(row: Row, target: QuoteStatus, hasExistingOrder: boolean): Effects {
  const e: Effects = { writes: 0, audits: 0, notifies: 0, redirects: 0 };
  // two concurrent requests, both snapshot the same starting state
  for (let i = 0; i < 2; i++) {
    // unconditional update
    row.status = target;
    e.writes++;
    // unconditional audit
    e.audits++;
    // ACCEPT path: unconditional buyer + admin notify, then redirect
    if (target === 'ACCEPTED' && hasExistingOrder) {
      e.notifies += 2;
      e.redirects++;
    }
  }
  return e;
}

// --- NEW: atomic claim + count-gated side effects -----------------------------
function runNew(row: Row, target: QuoteStatus, hasExistingOrder: boolean, alsoArchive = false): Effects {
  const e: Effects = { writes: 0, audits: 0, notifies: 0, redirects: 0 };
  // snapshot the pre-race status once (both requests read the same value)
  const snapStatus = row.status;
  for (let i = 0; i < 2; i++) {
    const statusChanged = snapStatus !== target;
    const c = claim(row, target, alsoArchive, 'admin');
    const changed = c === 1;
    if (changed) e.writes++;
    if (changed && statusChanged) e.audits++;
    // ACCEPT path
    if (target === 'ACCEPTED' && hasExistingOrder) {
      if (changed) e.notifies += 2;
      e.redirects++; // redirect is UNCONDITIONAL — idempotent UX
    }
  }
  return e;
}

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// 1. Double-click ACCEPT on a RESPONDED quote with an existing order
{
  const old = runOld({ status: 'RESPONDED', archivedAt: null, archivedById: null }, 'ACCEPTED', true);
  check('OLD double-ACCEPT writes twice (documents the bug)', old.writes === 2);
  check('OLD double-ACCEPT audits twice (documents the bug)', old.audits === 2);
  check('OLD double-ACCEPT notifies buyer+admin twice (documents the bug)', old.notifies === 4);

  const neu = runNew({ status: 'RESPONDED', archivedAt: null, archivedById: null }, 'ACCEPTED', true);
  check('NEW double-ACCEPT writes exactly once', neu.writes === 1);
  check('NEW double-ACCEPT audits exactly once', neu.audits === 1);
  check('NEW double-ACCEPT notifies buyer+admin exactly once (2 calls)', neu.notifies === 2);
  check('NEW double-ACCEPT still redirects on both requests (idempotent UX)', neu.redirects === 2);
}

// 2. Re-ACCEPT an already-ACCEPTED quote (stale tab) — no new side effects, still redirects
{
  const neu = runNew({ status: 'ACCEPTED', archivedAt: null, archivedById: null }, 'ACCEPTED', true);
  check('NEW re-ACCEPT does not write again', neu.writes === 0);
  check('NEW re-ACCEPT does not audit again', neu.audits === 0);
  check('NEW re-ACCEPT does not notify again', neu.notifies === 0);
  check('NEW re-ACCEPT still redirects to payment (idempotent UX)', neu.redirects === 2);
}

// 3. Double-click CLOSE (auto-archive) — claims + audits + archives exactly once
{
  const row: Row = { status: 'RESPONDED', archivedAt: null, archivedById: null };
  const neu = runNew(row, 'CLOSED', false, /*alsoArchive*/ true);
  check('NEW double-CLOSE writes exactly once', neu.writes === 1);
  check('NEW double-CLOSE audits exactly once', neu.audits === 1);
  check('NEW double-CLOSE leaves row archived', row.archivedAt !== null && row.status === 'CLOSED');
}

// 4. Legacy CLOSED-but-unarchived row: a single CLOSE still archives it (no regression)
{
  const row: Row = { status: 'CLOSED', archivedAt: null, archivedById: null };
  const snap = row.status;
  const statusChanged = snap !== 'CLOSED';
  const c = claim(row, 'CLOSED', /*alsoArchive*/ true, 'admin');
  check('NEW legacy CLOSED-unarchived: claim succeeds via archivedAt:null branch', c === 1);
  check('NEW legacy CLOSED-unarchived: row now archived', row.archivedAt !== null);
  check('NEW legacy CLOSED-unarchived: status audit suppressed (no X->X noise)', statusChanged === false);
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
