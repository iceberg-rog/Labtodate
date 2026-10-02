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
