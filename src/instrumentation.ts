import type { Instrumentation } from 'next';

/**
 * Every uncaught server error (render, route handler, server action) lands in
 * the ErrorLog table that Admin → Errors and the overview "Errors · 24h" tile
 * read. Before this hook only a handful of manual logError() calls wrote
 * there, so the page said "No errors logged" while the server log had dozens.
 * The digest is the same id production shows the user (and admin/error.tsx).
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  // The import stays inside this branch so the edge bundle never pulls in Prisma.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const e = err as Error & { digest?: string };
      // redirect() / notFound() are control flow, not failures.
      if (typeof e?.digest === 'string' && e.digest.startsWith('NEXT_')) return;
      const { prisma } = await import('@/lib/db');
      // Path only — query strings can carry tokens (magic links, resets).
      const path = request.path.split('?')[0];
      const where = `${request.method} ${path} · ${context.routeType}${context.routePath ? ` ${context.routePath}` : ''}`;
      const message = `${e?.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e?.message ?? String(err)}${e?.digest ? ` [digest ${e.digest}]` : ''}`;
      await prisma.errorLog.create({
        data: { where: where.slice(0, 200), message: message.slice(0, 2000) },
      });
    } catch {
      /* error reporting must never throw */
    }
  }
};

/**
 * Startup check (once per server start): product photos stored as an absolute
 * URL of a /media/ store under a host this server does not recognise are
 * hidden from buyers (src/lib/media/public-src.ts fails closed). Say so loudly
 * — server log + ErrorLog (Admin → Errors, overview tile) + admin bell —
 * instead of buyers silently seeing "Photo on request". The fix is
 * `npm run media:normalize -- --apply` (also part of the deploy setup step).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NEXT_PHASE === 'phase-production-build') return;
  const t = setTimeout(async () => {
    try {
      const [{ prisma }, { mediaUrlProblems }, { notifyAdmins }] = await Promise.all([
        import('@/lib/db'),
        import('@/lib/media/normalize'),
        import('@/lib/observability'),
      ]);
      const r = await mediaUrlProblems(prisma);
      if (!r.products) return;
      const message = `STARTUP CHECK: ${r.photos} photo(s) of ${r.products} published product(s) are stored under an unrecognised host (${r.hosts.join(', ')}) and are HIDDEN from buyers. Run: npm run media:normalize -- --apply`;
      console.error(`[media] ${message}`);
      await prisma.errorLog.create({ data: { where: 'startup · media URL check', message: message.slice(0, 2000) } });
      await notifyAdmins('Product photos hidden from buyers', message.slice(0, 400), '/admin/products', 'SYSTEM').catch(() => null);
    } catch {
      /* a startup check must never take the server down */
    }
  }, 5000);
  t.unref?.();
}
