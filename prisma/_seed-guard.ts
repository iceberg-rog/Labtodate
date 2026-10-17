import type { PrismaClient } from '@prisma/client';

/**
 * Demo seed scripts (seed.ts, seed-content.ts, seed-own-catalogue.ts) create
 * fake suppliers, fabricated case studies and an ADMIN account. They must
 * never run against a real database. Refuses when:
 *  - NODE_ENV is "production", or
 *  - the database already holds real activity (any order or quote request, or
 *    a user that is not a seed / QA account).
 * Override for a throw-away local database only:  ALLOW_DEMO_SEED=yes-this-is-a-test-db
 */
export async function assertDemoSeedAllowed(prisma: PrismaClient, script: string): Promise<void> {
  if (process.env.ALLOW_DEMO_SEED === 'yes-this-is-a-test-db') {
    console.warn(`⚠ ${script}: ALLOW_DEMO_SEED set — seeding demo data on purpose.`);
    return;
  }
  const refuse = (why: string): never => {
    console.error(
      `✋ ${script} refused: ${why}\n` +
        '   Demo seeds create fake suppliers, fabricated case studies and an ADMIN account.\n' +
        '   They are for an empty local test database only. If that is what this is, set\n' +
        '   ALLOW_DEMO_SEED=yes-this-is-a-test-db. To clean seeded data out of a real\n' +
        '   database use: npx tsx prisma/audit-seed-content.ts',
    );
    process.exit(3);
  };
  if (process.env.NODE_ENV === 'production') refuse('NODE_ENV is "production".');
  const [orders, quotes, realUsers] = await Promise.all([
    prisma.order.count(),
    prisma.sourcingRequest.count(),
    prisma.user.count({ where: { NOT: [{ id: { startsWith: 'seed_user_' } }, { email: { endsWith: '.test' } }] } }),
  ]);
  if (orders > 0 || quotes > 0 || realUsers > 0) {
    refuse(`this database already has real activity (${orders} order(s), ${quotes} quote request(s), ${realUsers} non-seed account(s)).`);
  }
}
