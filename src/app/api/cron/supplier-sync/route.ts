import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notifyAdmins } from '@/lib/observability';
import { runWooSync } from '@/lib/marketplace/woo-sync';
import { cronAuthorized } from '@/lib/security/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

/**
 * Scheduled supplier sync. Runs every shop whose Sync page has an automatic
 * interval set (Company.syncIntervalMinutes) and whose last sync is older than
 * that interval — so an item sold at the supplier stops being sold here within
 * one interval. Shops without an interval are manual only (the default).
 *
 * Auth: header X-Cron-Secret must equal CRON_SECRET (constant-time; refused
 * while CRON_SECRET is unset or still a 'change-me' placeholder — the same
 * rule as the security sweep, src/lib/security/cron-auth.ts).
 * The docker-compose cron container calls it every 15 minutes.
 * A failed or blocked run notifies the admins — never a silent failure — and so
 * does a run that needs a person (safety stop, price review, items held).
 */
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const now = Date.now();
  const shops = await prisma.company.findMany({
    where: { syncIntervalMinutes: { not: null }, importSourceUrl: { not: null } },
    select: { id: true, slug: true, name: true, syncIntervalMinutes: true, lastImportedAt: true },
  });
  const due = shops.filter(
    (s) => !s.lastImportedAt || now - s.lastImportedAt.getTime() >= (s.syncIntervalMinutes ?? 0) * 60_000 - 60_000,
  );
  const results: { shop: string; status: string; message: string }[] = [];
  for (const s of due) {
    const r = await runWooSync({ companyId: s.id, dryRun: false, trigger: 'CRON', actorEmail: 'system:cron' });
    results.push({ shop: s.slug, status: r.status, message: r.message });
    if (!r.ok) {
      await notifyAdmins(
        `Supplier sync ${r.status === 'BLOCKED' ? 'blocked' : 'failed'}: ${s.name}`,
        r.message.slice(0, 400),
        r.runId ? `/admin/companies/${s.slug}/runs/${r.runId}` : `/admin/companies/${s.slug}`,
      );
    } else if (r.attention.length) {
      // Unattended runs: a safety stop, price changes held for review, new
      // items held for review — someone has to look.
      await notifyAdmins(
        `Supplier sync needs you: ${s.name}`,
        r.attention.join(' ').slice(0, 400),
        r.runId ? `/admin/companies/${s.slug}/runs/${r.runId}` : `/admin/companies/${s.slug}`,
      );
    }
  }
  return NextResponse.json({ ok: true, checked: shops.length, ran: results.length, results });
}
