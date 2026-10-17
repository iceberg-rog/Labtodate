import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { getCatalogPolicy, getConditionGrades } from '@/lib/catalog/policy';
import { resolveWarranty } from '@/lib/catalog/warranty';
import { prisma } from '@/lib/db';
import { saveConditionGrades } from '@/app/admin/catalog-actions';
import { AdminActionForm } from '@/components/admin/AdminActionForm';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Conditions & warranty' };

const SCHEMA_OPTIONS = [
  { value: 'NewCondition', label: 'New' },
  { value: 'RefurbishedCondition', label: 'Refurbished' },
  { value: 'UsedCondition', label: 'Used' },
  { value: 'DamagedCondition', label: 'Damaged / for parts' },
];

const input =
  'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

export default async function ConditionGradesPage() {
  await requireCapability('products:edit');
  const [grades, policy, counts] = await Promise.all([
    getConditionGrades(),
    getCatalogPolicy(),
    prisma.product.groupBy({ by: ['condition'], where: { status: 'PUBLISHED' }, _count: true }),
  ]);
  const live = Object.fromEntries(counts.map((c) => [c.condition, c._count])) as Record<string, number>;
  const codes = ['NEW', 'REFURBISHED', 'USED'] as const;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <ShieldCheck className="h-7 w-7 text-primary" /> Conditions &amp; warranty
        </h1>
        <p className="text-muted-foreground mt-1">
          What each condition means and the warranty an item of that condition gets when the item itself does not
          state one. Leave the months empty for “no warranty”: those items show “{policy.warrantyFallbackText}”
          (change that text in <Link href="/admin/settings?tab=Catalog%20%26%20claims" className="text-primary hover:underline">Settings → Catalog &amp; claims</Link>).
          A warranty set on a product always wins. Orders keep the warranty they were sold with.
        </p>
      </div>

      <AdminActionForm action={saveConditionGrades} className="space-y-5">
        {codes.map((code) => {
          const g = grades[code];
          const preview = resolveWarranty({ warrantyMonths: null, warrantyText: null }, g, policy.warrantyFallbackText, policy.warrantyMonthsFormat);
          return (
            <section key={code} className="rounded-2xl border border-border bg-card p-5 space-y-3" data-grade={code}>
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h2 className="font-bold">
                  {code} <span className="text-xs font-medium text-muted-foreground">· {live[code] ?? 0} published item(s)</span>
                </h2>
                <p className="text-xs text-muted-foreground">
                  Items without their own warranty now show: <strong className="text-foreground">{preview.full}</strong>
                </p>
              </div>
              <div className="grid sm:grid-cols-3 gap-3">
                <label className="block">
                  <span className="block text-sm font-semibold mb-1">Label buyers see</span>
                  <input name={`${code}.label`} defaultValue={g.label} required minLength={2} maxLength={60} className={input} />
                </label>
                <label className="block">
                  <span className="block text-sm font-semibold mb-1">Default warranty (months)</span>
                  <input name={`${code}.months`} type="number" min={0} max={120} step={1} defaultValue={g.defaultWarrantyMonths ?? ''} placeholder="none" className={input} />
                </label>
                <label className="block">
                  <span className="block text-sm font-semibold mb-1">Search-engine condition</span>
                  <select name={`${code}.schema`} defaultValue={g.schemaOrgCondition} className={input}>
                    {SCHEMA_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block">
                <span className="block text-sm font-semibold mb-1">Warranty scope</span>
                <input name={`${code}.scope`} defaultValue={g.warrantyScope ?? ''} maxLength={300} placeholder="e.g. parts and labour, functional defects present at delivery" className={input} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold mb-1">What “{g.label}” means (shown on product pages)</span>
                <textarea name={`${code}.description`} defaultValue={g.description ?? ''} maxLength={600} rows={2} placeholder="Optional. e.g. Tested working; cosmetic marks possible." className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm" />
              </label>
            </section>
          );
        })}
        <Button type="submit" className="rounded-full font-semibold">Save conditions &amp; warranty</Button>
      </AdminActionForm>
    </div>
  );
}
