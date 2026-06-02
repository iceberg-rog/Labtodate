import { ScrollText } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function AdminAuditPage() {
  await requireCapability('audit:view');
  const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Audit log</h1>
        <p className="text-muted-foreground mt-1">Last {logs.length} admin actions.</p>
      </div>
      {logs.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-border bg-card p-12 text-center">
          <ScrollText className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-semibold">No actions logged yet</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-foreground/[0.02] text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3 font-bold">When</th>
                <th className="px-5 py-3 font-bold">Actor</th>
                <th className="px-5 py-3 font-bold">Action</th>
                <th className="px-5 py-3 font-bold">Target</th>
                <th className="px-5 py-3 font-bold">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((l) => (
                <tr key={l.id} className="hover:bg-foreground/[0.02]">
                  <td className="px-5 py-3 text-muted-foreground tabular-nums whitespace-nowrap">
                    {new Date(l.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="px-5 py-3">{l.actorEmail ?? '—'}</td>
                  <td className="px-5 py-3 font-mono text-xs">{l.action}</td>
                  <td className="px-5 py-3 font-mono text-xs text-muted-foreground">{l.target ?? '—'}</td>
                  <td className="px-5 py-3 text-muted-foreground">{l.meta ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
