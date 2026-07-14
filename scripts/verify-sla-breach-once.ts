/**
 * Offline regression matrix for BUG-042 — SLA-breach sweep idempotency in
 * `src/app/api/cron/sla-sweep/route.ts` (sibling of BUG-040/041 audit-integrity
 * and the BUG-002/026/035-039 atomic-claim family).
 *
 * The route runs on BOTH POST and GET (a sidecar wget triggers GET → POST) and a
 * slow sweep can still be running when the next scheduled tick fires. Two
 * overlapping invocations both `findMany` the same slaBreachAt=null ticket/quote
 * BEFORE either write lands. Compares:
 *   OLD: snapshot read (findMany) then an UNCONDITIONAL
 *        `update({where:{id}})` + UNCONDITIONAL notify/email/audit.
 *   NEW: atomic `updateMany({where:{id, slaBreachAt: null}})` claim, with
 *        notify/email/audit gated on `count === 1`.
 *
 * Asserts NEW stamps + notifies EXACTLY ONCE under two overlapping sweeps and
 * ZERO on an already-breached row; documents OLD double-notifying. The
 * proforma/orphan sweeps in the same file were already hardened this way — this
 * closes the last unguarded write path in the cron. No DB, no network.
 *
 * Run: node --experimental-strip-types scripts/verify-sla-breach-once.ts
 */
export {};

interface Row {
  slaBreachAt: Date | null;
}

// Models Prisma updateMany count under the WHERE {id, slaBreachAt: null}:
// applies (and returns 1) only if the row is still un-breached.
function claimBreach(row: Row): number {
  if (row.slaBreachAt !== null) return 0;
  row.slaBreachAt = new Date();
  return 1;
}

// OLD: both overlapping sweeps snapshot slaBreachAt=null, both write, both notify.
function runOldSweep(row: Row): number {
  const snap1 = row.slaBreachAt;
  const snap2 = row.slaBreachAt;
  let notifies = 0;
  for (const _snap of [snap1, snap2]) {
    // OLD had no per-row precondition: unconditional update({where:{id}}) + notify.
    row.slaBreachAt = new Date();
    notifies++;
  }
  return notifies;
}

// NEW: atomic claim per invocation; notify/email/audit only when count === 1.
function runNewSweep(row: Row): number {
  const snap1 = row.slaBreachAt;
  const snap2 = row.slaBreachAt;
  let notifies = 0;
  for (const _snap of [snap1, snap2]) {
    const count = claimBreach(row);
    if (count !== 1) continue; // another overlapping sweep already flagged it
    notifies++;
  }
  return notifies;
}

let failures = 0;
function check(name: string, got: number, want: number): void {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  got=${got} want=${want}`);
}

// Applies identically to tickets (supportTicket) and quotes (sourcingRequest) —
// both loops share the same claim+gate shape.
check('OLD overlapping sweep notifies (defect baseline)',
  runOldSweep({ slaBreachAt: null }), 2);
check('NEW overlapping sweep notifies once',
  runNewSweep({ slaBreachAt: null }), 1);
check('NEW sweep on already-breached row notifies zero',
  runNewSweep({ slaBreachAt: new Date() }), 0);

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
