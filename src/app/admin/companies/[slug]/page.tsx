import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, RefreshCw, BadgeCheck, FileSignature, Settings2, History } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { adminDetailTitle } from '@/app/admin/admin-title';
import { getCatalogPolicy, getConditionGrades } from '@/lib/catalog/policy';
import { ShopSyncRunButtons, ShopSyncSettingsForm, ShopVerifyForm, ShopAgreementForm } from '@/components/admin/ShopSyncPanels';

export const dynamic = 'force-dynamic';

export function generateMetadata(props: { params: Promise<{ slug: string }> }) {
  return adminDetailTitle('companies:manage', 'Shop', async () => {
    const { slug } = await props.params;
    const co = await prisma.company.findUnique({ where: { slug }, select: { name: true } });
    return co && `Shop: ${co.name}`;
  });
}

type Counts = Record<string, number | string[] | undefined>;

export default async function AdminShopPage(props: { params: Promise<{ slug: string }> }) {
  await requireCapability('companies:manage');
  const { slug } = await props.params;
  const co = await prisma.company.findUnique({ where: { slug } });
  if (!co) notFound();
  const [policy, grades, byStatus, removed, synced, runs] = await Promise.all([
    getCatalogPolicy(),
    getConditionGrades(),
    prisma.product.groupBy({ by: ['status'], where: { companyId: co.id }, _count: true }),
    prisma.product.count({ where: { companyId: co.id, removedAtSourceAt: { not: null } } }),
    prisma.product.count({ where: { companyId: co.id, externalSource: 'woo' } }),
    prisma.importRun.findMany({
      where: { companyId: co.id },
      orderBy: { startedAt: 'desc' },
      take: 15,
      select: { id: true, dryRun: true, trigger: true, status: true, actorEmail: true, startedAt: true, finishedAt: true, counts: true, error: true },
    }),
  ]);
  const status = Object.fromEntries(byStatus.map((s) => [s.status, s._count])) as Record<string, number>;
  const total = byStatus.reduce((n, s) => n + s._count, 0);
  const agreementOk = co.agreementStatus === 'SIGNED' || co.agreementStatus === 'OWN_SHOP';
  const blockedReason =
    !co.importSourceUrl
      ? 'This shop has no import URL — edit the shop on the Shops page to add one.'
      : policy.importRequireSignedAgreement && !agreementOk
        ? 'A real sync is blocked until the supplier agreement is recorded as signed (or this is marked as your own shop). A dry run is allowed.'
        : null;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <Link href="/admin/companies" className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground mb-2">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to shops
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">{co.name}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {co.importSourceUrl ?? 'No import URL'} · {total} product(s): {status.PUBLISHED ?? 0} published, {status.PENDING_REVIEW ?? 0} pending review,{' '}
          {status.DRAFT ?? 0} draft, {status.ARCHIVED ?? 0} archived · {removed} removed at the source · {synced} linked to a source item
          {co.lastImportedAt ? ` · last sync ${co.lastImportedAt.toLocaleString('en-GB')}` : ''}
        </p>
      </div>

      <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-bold inline-flex items-center gap-2"><RefreshCw className="h-5 w-5 text-primary" /> Sync with the source shop</h2>
        <p className="text-sm text-muted-foreground">
          A sync reads the whole source catalogue first (if any page fails, nothing is changed), then applies this shop&apos;s policy:
          items sold or removed at the source stop being sold here, your edits and locked fields are kept, archived and draft items
          are never re-published, and every photo is copied to our own media store. Every run — including dry runs — is kept below
          with its full list of changes.
        </p>
        <ShopSyncRunButtons slug={co.slug} blockedReason={blockedReason} />
      </section>

      <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <h2 className="text-lg font-bold inline-flex items-center gap-2"><Settings2 className="h-5 w-5 text-primary" /> Sync policy</h2>
        <ShopSyncSettingsForm
          slug={co.slug}
          conditionLabels={{ NEW: grades.NEW.label, REFURBISHED: grades.REFURBISHED.label, USED: grades.USED.label }}
          initial={{
            syncPolicy: co.syncPolicy,
            syncStockMode: co.syncStockMode,
            autoPublishImports: co.autoPublishImports,
            archiveMissingAtSource: co.archiveMissingAtSource,
            importCondition: co.importCondition,
            importDefaultQuantity: co.importDefaultQuantity,
            syncIntervalMinutes: co.syncIntervalMinutes,
            importPricesIncludeVat: co.importPricesIncludeVat,
            importVatRateBp: co.importVatRateBp,
          }}
        />
      </section>

      <div className="grid lg:grid-cols-2 gap-6">
        <section className="rounded-2xl border border-border bg-card p-6 space-y-3">
          <h2 className="text-lg font-bold inline-flex items-center gap-2"><FileSignature className="h-5 w-5 text-primary" /> Supplier agreement</h2>
          <p className="text-xs text-muted-foreground">
            Reselling a supplier&apos;s items and using its photos and texts needs its written permission.
            {policy.importRequireSignedAgreement
              ? ' Imports are blocked without it (Settings → Import & suppliers).'
              : ' The import block is switched off in Settings → Import & suppliers.'}
          </p>
          <ShopAgreementForm
            slug={co.slug}
            initial={{
              status: co.agreementStatus,
              signedAt: co.agreementSignedAt ? co.agreementSignedAt.toISOString().slice(0, 10) : null,
              note: co.agreementNote,
            }}
          />
        </section>
        <section className="rounded-2xl border border-border bg-card p-6 space-y-3">
          <h2 className="text-lg font-bold inline-flex items-center gap-2"><BadgeCheck className="h-5 w-5 text-primary" /> Verification</h2>
          <ShopVerifyForm
            slug={co.slug}
            verified={co.verifiedAt ? { at: co.verifiedAt.toISOString(), by: co.verifiedByEmail, note: co.verificationNote } : null}
          />
        </section>
      </div>

      <section className="rounded-2xl border border-border bg-card p-6 space-y-3">
        <h2 className="text-lg font-bold inline-flex items-center gap-2"><History className="h-5 w-5 text-primary" /> Runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sync has run with the new engine yet. Start with a dry run.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="runs-table">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-3">Started</th>
                  <th className="py-2 pr-3">Kind</th>
                  <th className="py-2 pr-3">Result</th>
                  <th className="py-2 pr-3">Changes</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((r) => {
                  const c = (r.counts ?? {}) as Counts;
                  const n = (k: string) => (typeof c[k] === 'number' ? (c[k] as number) : 0);
                  return (
                    <tr key={r.id}>
                      <td className="py-2 pr-3 whitespace-nowrap">{r.startedAt.toLocaleString('en-GB')}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{r.dryRun ? 'Dry run' : 'Sync'} · {r.trigger.toLowerCase()}{r.actorEmail ? ` · ${r.actorEmail}` : ''}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <span className={`text-xs font-bold ${r.status === 'SUCCEEDED' ? 'text-emerald-700 dark:text-emerald-300' : r.status === 'RUNNING' ? 'text-muted-foreground' : 'text-red-700 dark:text-red-300'}`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {r.error && r.status !== 'SUCCEEDED'
                          ? r.error.slice(0, 160)
                          : `${n('created')} new · ${n('updated')} updated · ${n('archived')} archived · ${n('unchanged')} unchanged${n('failed') ? ` · ${n('failed')} failed` : ''}`}
                      </td>
                      <td className="py-2 text-right">
                        <Link href={`/admin/companies/${co.slug}/runs/${r.id}`} className="text-xs font-semibold text-primary hover:underline">Report</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
