import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { getImportSettings } from '@/lib/catalog/import-settings';
import { getCatalogPolicy, getConditionGrades } from '@/lib/catalog/policy';
import { AUDIT_SELECT, AUDIT_WHERE, auditProduct, type AuditKind } from '@/lib/catalog/audit';
import { applyStatedConditionAction, applySuggestedBrandsAction, cleanSupplierTextsAction } from '@/app/admin/catalog-actions';
import { AdminActionForm } from '@/components/admin/AdminActionForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Catalog audit' };

const KIND_LABEL: Record<AuditKind, string> = {
  CLAIMS: 'Supplier claims in the text',
  PRICES: 'Other prices in the text',
  CROSS_SELL: 'Cross-sell tails',
  TITLE_CLAIM: 'Claim in the title',
  CONDITION: 'Condition contradicts the text',
  BRAND: 'Brand missing or wrong',
  CATEGORY: 'No category rule matches',
};
const KIND_HELP: Record<AuditKind, string> = {
  CLAIMS: 'Warranty, “tested”, service or “like new” promises written by the supplier. Every listing states ONE warranty — yours — so these sentences are removed (the technical text stays).',
  PRICES: 'Prices inside the text (e.g. “€ 4,500.00”, “Prices from: 17.500 euro”) contradict or bypass your price, markup, force-quote or hidden price — also in search results.',
  CROSS_SELL: '“Also available: …” lists of the supplier’s other units — not this unit.',
  TITLE_CLAIM: 'A promise in the title (“Fully tested”, “Brand new”). Titles are never changed automatically: edit them on the product.',
  CONDITION: 'The grade (and so the warranty default and search-engine condition) says one thing, the listing’s own title or text another.',
  BRAND: 'No brand, a placeholder brand (“Other”), or a brand the title contradicts.',
  CATEGORY: 'None of the category rules matches the title — check the category by hand or add a rule (Settings → Import & suppliers).',
};
const ORDER: AuditKind[] = ['CLAIMS', 'PRICES', 'CROSS_SELL', 'CONDITION', 'TITLE_CLAIM', 'BRAND', 'CATEGORY'];
const SHOW = 60;

export default async function CatalogAuditPage(props: { searchParams: Promise<{ kind?: string; all?: string }> }) {
  await requireCapability('products:edit');
  const sp = await props.searchParams;
  const [rules, policy, grades, categories, products] = await Promise.all([
    getImportSettings(),
    getCatalogPolicy(),
    getConditionGrades(),
    prisma.category.findMany({ select: { slug: true, name: true } }),
    prisma.product.findMany({ where: AUDIT_WHERE, select: AUDIT_SELECT, orderBy: [{ status: 'asc' }, { title: 'asc' }] }),
  ]);
  const names = new Map(categories.map((c) => [c.slug, c.name]));
  const rows = products.map((p) => auditProduct(p, rules, policy.placeholderBrands, names));
  const count = (k: AuditKind) => rows.filter((r) => r.kinds.includes(k)).length;
  const kind = (ORDER as string[]).includes(sp.kind ?? '') ? (sp.kind as AuditKind) : ORDER.find((k) => count(k) > 0) ?? 'CLAIMS';
  const list = rows.filter((r) => r.kinds.includes(kind));
  const shown = sp.all ? list : list.slice(0, SHOW);
  const textIssues = rows.filter((r) => r.kinds.some((k) => k === 'CLAIMS' || k === 'PRICES' || k === 'CROSS_SELL'));
  const cleanable = textIssues.filter((r) => !r.textLocked).length;
  const brandFixable = rows.filter((r) => r.kinds.includes('BRAND') && !r.brand && r.suggestedBrand).length;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold tracking-tight inline-flex items-center gap-2">
          <ShieldCheck className="h-7 w-7 text-primary" /> Catalog audit
        </h1>
        <p className="text-muted-foreground mt-1 text-sm max-w-3xl">
          {products.length} supplier listing(s) (not archived) checked live against your rules in{' '}
          <Link href="/admin/settings?tab=Import%20%26%20suppliers" className="text-primary hover:underline">Settings → Import &amp; suppliers</Link> and{' '}
          <Link href="/admin/settings?tab=Catalog%20%26%20claims" className="text-primary hover:underline">Catalog &amp; claims</Link>. New imports are cleaned and
          checked by the sync; this page finds what older listings still say.
        </p>
      </div>

      <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
        <h2 className="font-bold">Fix in bulk</h2>
        <div className="flex flex-wrap gap-3 items-start">
          <AdminActionForm
            action={cleanSupplierTextsAction}
            confirmMessage={`Remove supplier claims, other prices and cross-sell tails from ${cleanable} listing(s)? Only those sentences are removed; the technical text stays. Texts you edited yourself are left alone.`}
          >
            <button type="submit" disabled={!cleanable} className="h-9 px-4 rounded-full bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90 disabled:opacity-50">
              Clean texts of {cleanable} listing(s)
            </button>
          </AdminActionForm>
          <AdminActionForm
            action={applyStatedConditionAction}
            confirmMessage={`Set the condition of ${count('CONDITION')} listing(s) to what their own title / text states? Their warranty default and search-engine condition follow the new grade.`}
          >
            <button type="submit" disabled={!count('CONDITION')} className="h-9 px-4 rounded-full border border-border text-xs font-bold hover:bg-muted disabled:opacity-50">
              Apply the stated condition to {count('CONDITION')} listing(s)
            </button>
          </AdminActionForm>
          <AdminActionForm
            action={applySuggestedBrandsAction}
            confirmMessage={`Give ${brandFixable} listing(s) without a brand the brand their title names?`}
          >
            <button type="submit" disabled={!brandFixable} className="h-9 px-4 rounded-full border border-border text-xs font-bold hover:bg-muted disabled:opacity-50">
              Set the brand named in the title on {brandFixable} listing(s)
            </button>
          </AdminActionForm>
        </div>
        <p className="text-xs text-muted-foreground">Every change is recorded in the audit log. Titles and category are never changed in bulk.</p>
      </section>

      <nav className="flex flex-wrap gap-2 text-xs" data-testid="audit-kinds">
        {ORDER.map((k) => (
          <Link
            key={k}
            href={`?kind=${k}`}
            className={`px-3 py-1.5 rounded-full border font-semibold ${kind === k ? 'border-primary bg-primary/10 text-primary' : 'border-border hover:bg-foreground/[0.03]'}`}
          >
            {KIND_LABEL[k]} · {count(k)}
          </Link>
        ))}
      </nav>
      <p className="text-sm text-muted-foreground">{KIND_HELP[kind]}</p>

      {shown.length === 0 ? (
        <p className="rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center text-muted-foreground">Nothing found here.</p>
      ) : (
        <ul className="rounded-2xl border border-border bg-card divide-y divide-border" data-testid="audit-rows">
          {shown.map((r) => (
            <li key={r.id} className="p-4 space-y-1.5 text-sm" data-slug={r.slug}>
              <div className="flex items-center gap-2 flex-wrap">
                <Link href={`/admin/products/${r.slug}`} className="font-semibold hover:text-primary break-words">{r.title}</Link>
                <span className="text-xs text-muted-foreground">
                  {r.shop ?? ''} · {r.status.toLowerCase().replace('_', ' ')} · {grades[r.condition]?.label ?? r.condition}
                  {r.textLocked ? ' · texts edited by you (not cleaned automatically)' : ''}
                </span>
              </div>
              {(kind === 'CLAIMS' || kind === 'PRICES' || kind === 'CROSS_SELL') && (
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  {r.removed
                    .filter((x) => (kind === 'CLAIMS' ? x.reason === 'CLAIM' || x.reason === 'SUPPLIER' : kind === 'PRICES' ? x.reason === 'PRICE' : x.reason === 'CROSS_SELL'))
                    .slice(0, 4)
                    .map((x, i) => (
                      <li key={i}>
                        <span className="line-through decoration-red-500/70">{x.text.length > 160 ? `${x.text.slice(0, 157)}…` : x.text}</span>
                      </li>
                    ))}
                </ul>
              )}
              {kind === 'TITLE_CLAIM' && <p className="text-xs text-muted-foreground">Edit the title on the product page.</p>}
              {kind === 'CONDITION' && r.statedCondition && (
                <div className="flex items-center gap-3 flex-wrap text-xs">
                  <span>
                    Graded <strong>{grades[r.condition]?.label ?? r.condition}</strong>, the text says <strong>{grades[r.statedCondition]?.label ?? r.statedCondition}</strong>.
                  </span>
                  <AdminActionForm action={applyStatedConditionAction}>
                    <input type="hidden" name="slug" value={r.slug} />
                    <button type="submit" className="h-7 px-3 rounded-full border border-border text-[11px] font-bold hover:bg-muted">
                      Set to “{grades[r.statedCondition]?.label ?? r.statedCondition}”
                    </button>
                  </AdminActionForm>
                </div>
              )}
              {kind === 'BRAND' && (
                <div className="flex items-center gap-3 flex-wrap text-xs">
                  <span>
                    Brand: <strong>{r.brand ?? 'none'}</strong>
                    {r.suggestedBrand ? <> · the title names <strong>{r.suggestedBrand}</strong></> : ' · no brand recognised in the title'}
                  </span>
                  {r.suggestedBrand && (
                    <AdminActionForm action={applySuggestedBrandsAction}>
                      <input type="hidden" name="slug" value={r.slug} />
                      <button type="submit" className="h-7 px-3 rounded-full border border-border text-[11px] font-bold hover:bg-muted">
                        Use “{r.suggestedBrand}”
                      </button>
                    </AdminActionForm>
                  )}
                </div>
              )}
              {kind === 'CATEGORY' && <p className="text-xs text-muted-foreground">Category now: {r.category}.</p>}
            </li>
          ))}
        </ul>
      )}
      {!sp.all && list.length > SHOW && (
        <Link href={`?kind=${kind}&all=1`} className="text-sm font-semibold text-primary hover:underline">
          Show all {list.length}
        </Link>
      )}
    </div>
  );
}
