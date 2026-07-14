/**
 * Source-contract guard — proforma-expiry transition wiring.
 * ----------------------------------------------------------------------------
 * The BEHAVIOURAL proofs (expired closes quote + cancels order together;
 * proof-in-flight leaves both unexpired with zero side effects; no-linked-order
 * still closes; overlapping sweeps fire exactly once; forced proof-vs-expiry
 * interleaving → proof-in-flight) run against a real DB in
 * scripts/it-order-atomicity.ts. This guard keeps the sweep coupled to
 * expireProformaTransition so it can't regress to the stale-external-read +
 * inline-transaction shape where a proof landing mid-flight let the quote close
 * (→ Lost) and expiry fire while the order stayed PENDING_PAYMENT with proof.
 *
 * Asserts:
 *  - expireProformaTransition exists and does its proof check INSIDE $transaction;
 *  - the sweep imports + calls it and gates side effects on `=== 'expired'`;
 *  - the proforma sweep keeps NO stale external paymentInFlight read and NO
 *    inline `won` RESPONDED→CLOSED claim.
 *
 * Run: npx tsx scripts/verify-proforma-expiry-once.ts
 */
import { readFileSync } from 'node:fs';
import { expireProformaTransition } from '../src/lib/quotes/proforma-expiry';

let pass = 0; let fail = 0; const rows: string[] = [];
const chk = (n: string, ok: boolean, d = '') => { rows.push(`${ok ? 'ok  ' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); ok ? pass++ : fail++; };
const src = (p: string) => readFileSync(p, 'utf8');

chk('expireProformaTransition is exported', typeof expireProformaTransition === 'function');

const helper = src('src/lib/quotes/proforma-expiry.ts');
chk('transition checks proof INSIDE the transaction, then guarded RESPONDED→CLOSED',
  /db\.\$transaction/.test(helper) &&
  /paymentSubmittedAt: \{ not: null \}/.test(helper) &&
  /ProofInFlightError/.test(helper) &&
  /status: 'RESPONDED'/.test(helper));

const sweep = src('src/app/api/cron/sla-sweep/route.ts');
const imports = /from ['"]@\/lib\/quotes\/proforma-expiry['"]/.test(sweep);
const calls = /expireProformaTransition\s*\(/.test(sweep);
const gated = /outcome !== 'expired'/.test(sweep);
const noStaleRead = !/const paymentInFlight/.test(sweep);
const noInlineWon = !/let won = false/.test(sweep);
chk('proforma sweep routes through expireProformaTransition + gates side effects',
  imports && calls && gated && noStaleRead && noInlineWon,
  `import=${imports} call=${calls} gated=${gated} no-stale-read=${noStaleRead} no-inline-won=${noInlineWon}`);

console.log('proforma-expiry transition wiring guard');
console.log('----------------------------------------------------------------');
console.log(rows.join('\n'));
console.log('----------------------------------------------------------------');
if (fail > 0) { console.error(`RESULT: ${fail} wiring violation(s)`); process.exit(1); }
console.log('RESULT: proforma sweep routes through the transactional expireProformaTransition and fires side effects only on the expired winner; behaviour proven in it-order-atomicity.ts');
process.exit(0);
