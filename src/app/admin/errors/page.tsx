import { AlertTriangle } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function AdminErrorsPage() {
  await requireCapability('errors:view');
  const [errs, last24] = await Promise.all([
    prisma.errorLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.errorLog.count({ where: { createdAt: { gte: new Date(Date.now() - 864e5) } } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Errors</h1>
        <p className="text-muted-foreground mt-1">
          {last24} in the last 24h · {errs.length} shown
        </p>
      </div>
      {errs.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <AlertTriangle className="h-8 w-8 mx-auto text-emerald-600 mb-3" />
          <p className="text-lg font-semibold">No errors logged</p>
          <p className="text-sm text-muted-foreground mt-2">Captured server-side exceptions appear here.</p>
        </div>
      ) : (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
          {errs.map((e) => (
            <li key={e.id} className="p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-xs font-bold text-red-700">{e.where}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {new Date(e.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </div>
              <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap break-words">{e.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
