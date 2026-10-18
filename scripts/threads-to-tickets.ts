/**
 * One-off (PKG-16): move buyer questions about house stock out of personal
 * inboxes into the support-ticket queue. A MessageThread whose seller is an
 * ADMIN account, an account without a supplier company, or an importer
 * placeholder without an inbox (src/lib/messages/house.ts) becomes one
 * support ticket — topic “Product question”, product linked, every message
 * in order — and the old thread gets a closing line pointing to the ticket.
 * Same code as the live path (src/lib/messages/to-ticket.ts); moved threads
 * are skipped, so it is idempotent. Buyers get an in-app notice; staff see
 * the tickets in Admin → Tickets.
 *
 *   node --require ./scripts/react-cache-shim.cjs --env-file=.env --import tsx scripts/threads-to-tickets.ts          # dry run (report)
 *   node --require ./scripts/react-cache-shim.cjs --env-file=.env --import tsx scripts/threads-to-tickets.ts --apply
 */
import { prisma } from '../src/lib/db';
import { ensureSettingsLoaded } from '../src/lib/settings';
import { isHouseSeller, planTicketFromThread } from '../src/lib/messages/house';
import { moveThreadToTicket, threadTicket } from '../src/lib/messages/to-ticket';

async function main() {
  const apply = process.argv.includes('--apply');
  await ensureSettingsLoaded();
  const threads = await prisma.messageThread.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, subject: true, buyerId: true,
      buyer: { select: { name: true, email: true } },
      seller: { select: { email: true, role: true, companyId: true } },
      product: { select: { title: true } },
      messages: { orderBy: { createdAt: 'asc' }, select: { authorId: true, body: true, createdAt: true } },
    },
  });
  const house = threads.filter((t) => isHouseSeller(t.seller));
  console.log(`${apply ? 'Apply' : 'Dry run'}: ${threads.length} thread(s), ${house.length} about house stock.`);
  let moved = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const t of house) {
    const done = await threadTicket(t.id);
    if (done) {
      skipped++;
      console.log(`  = ${t.id} already moved to ${done.ref}`);
      continue;
    }
    const plan = planTicketFromThread(t, { now: new Date() });
    const label = `${t.id} (${t.seller.role}${t.seller.companyId ? '' : ', no company'} ${t.seller.email}) “${plan.subject}” — ${plan.messages.length} message(s), ${plan.status}`;
    if (!apply) {
      console.log(`  → ${label}`);
      continue;
    }
    try {
      const r = await moveThreadToTicket(t.id, { actor: { email: 'script:threads-to-tickets' }, notify: 'buyer' });
      if (r?.created) moved++;
      console.log(`  ✔ ${label} → ${r?.ref ?? '(thread gone)'}`);
    } catch (e) {
      failed.push(`${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`${apply ? 'Moved' : 'Would move'} ${apply ? moved : house.length - skipped}, already moved ${skipped}, failed ${failed.length}.`);
  for (const f of failed) console.log(`  ✖ ${f}`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
