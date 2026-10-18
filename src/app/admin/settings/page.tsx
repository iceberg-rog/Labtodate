import Link from 'next/link';
import {
  KeyRound,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Mail,
  CreditCard,
  Bot,
  Building2,
  Clock,
  FileLock2,
  ShieldAlert,
} from 'lucide-react';
import { requireCapability, hasCapability } from '@/lib/auth-server';
import { emailTransportStatus } from '@/lib/email';
import { ShieldCheck } from 'lucide-react';
import { prisma } from '@/lib/db';
import {
  SETTING_DEFS,
  SETTING_GROUPS,
  PANEL_GROUPS,
  getEnvOnlySettingKeys,
  getSettingStates,
  listSettingChanges,
  ensureSettingsLoaded,
  type SettingDefinition,
  type SettingState,
} from '@/lib/settings';
import { BOOL_OPTIONS } from '@/lib/settings/defs';
import { numberSeriesOverview } from '@/lib/documents/issue';
import { loadNumberingSettings, nextNumberNow, type DocSeries } from '@/lib/documents/numbering';
import { loadShippingZones } from '@/lib/shipping/load';
import {
  saveAdminSettings,
  uploadCompanyLogo,
  listWebhooks,
  revertSettingAction,
  checkVatIdAction,
  saveCountryPolicy,
  deleteCountryPolicy,
  saveShippingZone,
  deleteShippingZone,
  saveShippingRate,
  deleteShippingRate,
} from '../actions';
import { getSecurityPolicy } from '@/lib/security/policy';
import { buildPolicyFields } from '@/lib/security/policy-fields';
import { SecurityPolicyForm } from '@/components/admin/SecurityPolicyForm';
import { saveSecurityPolicy } from './security/actions';
import { ConnTest } from '@/components/admin/ConnTest';
import { TestEmailButton } from '@/components/admin/TestEmailButton';
import { FieldVerify } from '@/components/admin/FieldVerify';
import { SettingsTabs } from '@/components/admin/SettingsTabs';
import { SettingsSaveForm } from '@/components/admin/SettingsSaveForm';
import { SettingRevertButton } from '@/components/admin/SettingRevertButton';
import { LogoUploadForm } from '@/components/admin/LogoUploadForm';
import { WebhooksPanel } from '@/components/admin/WebhooksPanel';
import { OrderActionForm as ActionForm } from '@/components/admin/OrderActionForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

const TAB_CONNECTION: Partial<Record<string, { kind: 'resend' | 'stripe' | 'ai' | 'storage'; label: string; help: string }>> = {
  Email: { kind: 'resend', label: 'Resend', help: 'Calls Resend /domains — proves the key works AND lists the verified sending domains.' },
  'Payments & credit terms': { kind: 'stripe', label: 'Stripe', help: 'Calls Stripe balance — proves the secret key is live and currencies are configured.' },
  'AI assistant': { kind: 'ai', label: 'AI provider', help: 'Calls the configured /v1/models endpoint — proves the API key and base URL.' },
  Company: { kind: 'storage', label: 'Object storage', help: 'Pings MinIO/S3 + ensures the upload bucket exists.' },
};

const TAB_NOTE: Partial<Record<string, string>> = {
  Company:
    'Your legal identity on every proforma, invoice and credit note. Each document keeps the identity it was issued with — changes here apply to documents issued after saving. KvK number and VAT ID are required on Dutch invoices: an invoice is not issued while they are missing.',
  'Tax & VAT':
    'These rules decide the VAT on every invoice and credit note issued from now on: when a payment is verified, the order’s delivery country and VAT ID are checked against them, and an order charged a different amount than the rules require is put on “VAT review” instead of being invoiced. Quote offers already use these rules (the buyer’s billing country and VAT ID decide the treatment). The cart checkout still prices with the interim flat rate at the bottom of this tab until it uses them.',
  'Invoicing & numbering':
    'Gap-free number series, one per document type, allocated when a document is issued (never reused, never skipped). Issued documents are stored as PDF and never change; corrections are credit notes or new proforma revisions.',
  'Payments & credit terms':
    'No Stripe keys = checkout falls back to bank transfer (proforma + manual verification). The IBAN is frozen into each proforma when it is issued.',
  Shipping:
    'Zones & rates (below) price shipping by destination and shipping class; anything not covered is “to be confirmed” by staff — never a silent €0. Carriers, tracking and shipping emails are under “Fulfilment & delivery”.',
  'Compliance & countries':
    'Ship-to policy per country. ALLOW: sell normally · REVIEW: order held until staff clear it (export screening) · BLOCK: refused. Seeded with SUGGESTED defaults — please confirm each row. EU membership and VAT rates are also used by the VAT rules.',
  'Quotes & offers':
    'Defaults for every new offer (validity, freight, Incoterms, lead time, warranty, payment terms), how supplier prices are reviewed and marked up before a buyer sees them, the SLA per priority, and what buyers can do themselves (decline with a reason, cancel an unpaid order). Every offer stores the values it was sent with, so changes here only affect offers sent afterwards.',
  'Fulfilment & delivery':
    'How orders leave the warehouse: the carriers staff choose from (each with its tracking link), whether a tracking number is required, insurance default, the packing slip, and the emails the buyer receives when an order is prepared, shipped (every shipment, also bulk), re-tracked or delivered. An order can only be prepared or shipped with complete delivery and billing details and no open hold — that is not a setting.',
  'Returns & refunds':
    'What buyers can report after delivery (window, reasons, photos), the return instructions sent with an approval, and the refund / credit texts. A bank-transfer refund stays “requested” until staff record the transfer (date + reference) — only then is the buyer told it was sent. Returned units go back to stock only after an inspection graded “resell”.',
  'Stock & reservation':
    'How long unpaid orders hold stock, and when units go back to stock. A shipped unit only returns to stock through a received return.',
  'Sales channel': 'Who may buy. Consumer sales bring withdrawal rights and incl.-VAT pricing.',
  'Documents & legal texts':
    'Texts printed on documents, and retention. Paid, invoiced or refunded orders and every issued document are kept (they can be archived, never deleted).',
  Email:
    'Two ways to send real email: (1) a Resend API key (simplest — HTTPS, no SMTP ports), or (2) your own SMTP server (host/port/user/password below; a relay that needs no login only with “SMTP server needs no login” = true). Resend wins if its key is set; leave it blank to use SMTP. With neither, the live site sends NO email at all, every attempt is logged as “not configured” and the admin shows a red warning. After saving, use “Send test email” to confirm delivery.',
  Brand: 'Brand display values — used in headers, footers, page metadata and outbound emails.',
  'AI assistant': 'Powers the admin AI tools (supplier-shop suggestions and risk checks, the import fallback); the site has no chat. OpenAI-compatible — any provider that follows OpenAI’s /v1/chat/completions shape works.',
  'Catalog & claims':
    'What the site promises buyers. Every promise here is OFF until you fill it in — the site never shows a warranty, shipping or returns claim you did not set. Per-condition warranty defaults live in Admin → Catalog → Conditions & warranty; per-item warranty and inspection on each product.',
  'Import & suppliers':
    'Rules for importing and syncing supplier shops: what supplier texts may say (claims, other prices, cross-sells are removed), how brand and category are chosen (nothing matched = held for review), when a supplier price change waits for you (Admin → Catalog → Price review), the mass-archive safety stop, backorders and the technical limits. Per-shop sync policy (what a sync may change, stock handling, auto-publish, schedule) is set on each shop’s Sync page. Existing listings: Admin → Catalog → Audit.',
  'Site texts & pages':
    'How the site describes itself: page title and search description, footer lines, the sourcing promise and the introductions of the content pages. Defaults make no claim — write only what is true for every order.',
};

const field =
  'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';
const small = 'h-9 px-2.5 rounded-lg border border-input bg-background text-xs focus:outline-none focus:ring-2 focus:ring-primary/30';

const UNIT: Partial<Record<string, string>> = { percent: '%', money: '€' };

function sourceBadge(st: SettingState | undefined) {
  if (!st) return null;
  const map = {
    db: { t: 'Saved here', c: 'text-emerald-700 dark:text-emerald-400' },
    env: { t: 'From server .env', c: 'text-sky-700 dark:text-sky-400' },
    default: { t: 'Default', c: 'text-muted-foreground' },
    unset: { t: 'Not set', c: 'text-muted-foreground' },
  } as const;
  const m = map[st.source];
  return <span className={`text-[11px] font-bold ${m.c}`}>{m.t}</span>;
}

function FieldRow({ d, st, envOnly }: { d: SettingDefinition; st: SettingState | undefined; envOnly: boolean }) {
  const val = st?.display ?? '';
  const isSet = (st?.value ?? '').trim().length > 0;
  const unit = UNIT[d.type];
  const options = d.type === 'bool' ? BOOL_OPTIONS : d.options;
  const shownDefault = d.default !== undefined && d.type !== 'secret'
    ? (d.type === 'bool' ? (d.default === 'true' ? 'Yes' : 'No') : d.type === 'enum' ? d.options?.find((o) => o.value === d.default)?.label ?? d.default : d.type === 'money' ? `€ ${(Number(d.default) / 100).toFixed(2)}` : d.default)
    : null;
  return (
    <div className="space-y-1.5" data-setting={d.key}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <label htmlFor={d.key} className="text-sm font-semibold flex items-center gap-2">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          {d.label}
        </label>
        <span className="inline-flex items-center gap-2 flex-wrap">
          {d.sensitive && (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700 dark:text-amber-400" title="Changes are announced to every admin">
              <ShieldAlert className="h-3 w-3" /> Sensitive
            </span>
          )}
          {d.type === 'secret' ? (
            isSet ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> Configured</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-muted-foreground"><XCircle className="h-3.5 w-3.5" /> Not set</span>
            )
          ) : sourceBadge(st)}
        </span>
      </div>
      {d.pending && (
        <p className="text-[11px] font-semibold rounded-md border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300 px-2 py-1">
          Saved now, not applied yet — takes effect with {d.pending}.
        </p>
      )}
      {options ? (
        <select id={d.key} name={d.key} defaultValue={val || d.default || ''} className={field}>
          {!(val || d.default) && <option value="">— choose —</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : d.multiline || d.type === 'text' ? (
        <textarea
          id={d.key}
          name={d.key}
          rows={d.key === 'LEGAL_TERMS_TEXT' ? 16 : d.key.startsWith('IMPORT_') || d.key === 'CONDITION_TEXT_WORDS' ? 6 : 3}
          autoComplete="off"
          defaultValue={val}
          placeholder={d.optional ? 'Optional' : d.key}
          className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
        />
      ) : (
        <div className="relative">
          {unit === '€' && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">€</span>}
          <input
            id={d.key}
            name={d.key}
            type={d.secret ? 'password' : 'text'}
            inputMode={d.type === 'int' || d.type === 'percent' || d.type === 'money' ? 'decimal' : undefined}
            // Browsers ignore autoComplete="off" on password inputs and fill a saved
            // login password into the first one (the Resend key), which then silently
            // overrides SMTP. "new-password" + the password-manager opt-outs stop that.
            autoComplete={d.secret ? 'new-password' : 'off'}
            data-1p-ignore={d.secret || undefined}
            data-lpignore={d.secret ? 'true' : undefined}
            data-bwignore={d.secret || undefined}
            defaultValue={d.secret ? '' : val}
            placeholder={d.secret ? (isSet ? '•••••••• (set — type to replace)' : 'Not set — paste the key here') : d.optional ? 'Optional — leave empty for none' : d.key}
            className={`${field} ${unit === '€' ? 'pl-7' : ''} ${unit === '%' ? 'pr-8' : ''}`}
          />
          {unit === '%' && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>}
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {d.hint}
          {shownDefault && <span className="block mt-0.5">Default: <span className={d.type === 'enum' || d.type === 'bool' ? 'font-semibold' : 'font-mono'}>{shownDefault}</span></span>}
          {d.effect === 'new-documents' && (
            <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-foreground/70"><FileLock2 className="h-3 w-3" /> Frozen into each document at issue — issued documents never change.</span>
          )}
          {envOnly && (
            <span className="block mt-0.5 text-amber-700 dark:text-amber-400">
              Current value comes from the server .env — enter a new value to override it here; it can only be removed in the .env file.
            </span>
          )}
        </p>
        {st?.source === 'db' && (
          <label className="text-xs text-muted-foreground inline-flex items-center gap-1.5 shrink-0" title={d.secret ? 'Remove the stored secret' : 'Back to the .env / default value'}>
            <input type="checkbox" name={`__clear_${d.key}`} className="accent-primary" />
            {d.secret ? 'clear' : 'reset'}
          </label>
        )}
      </div>
      {(d.verify || d.preview) && (
        <div className="flex items-center gap-3 flex-wrap pt-0.5">
          {d.verify && <FieldVerify settingKey={d.key} />}
          {d.preview && (
            <Link href={d.preview} target="_blank" className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline">
              <ExternalLink className="h-3 w-3" /> Preview on site
            </Link>
          )}
          {d.verify && <span className="text-[11px] text-muted-foreground">Save first — Verify checks the stored value.</span>}
        </div>
      )}
    </div>
  );
}

function fmtWhen(d: Date): string {
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });
}

export default async function AdminSettingsPage(props: { searchParams?: Promise<{ tab?: string }> }) {
  const searchParams = await props.searchParams;
  await requireCapability('settings:view');
  await ensureSettingsLoaded();
  const mail = emailTransportStatus();
  const canWrite = await hasCapability('settings:write');
  const canManageSecurity = await hasCapability('security:manage');
  const [states, envOnly, webhooks, history, countries, zones, series, securityPolicy] = await Promise.all([
    getSettingStates(),
    getEnvOnlySettingKeys(),
    listWebhooks().catch(() => []),
    listSettingChanges({ take: 150 }),
    prisma.countryPolicy.findMany({ orderBy: [{ isEu: 'desc' }, { name: 'asc' }] }),
    loadShippingZones(),
    numberSeriesOverview(),
    getSecurityPolicy(),
  ]);
  const numbering = loadNumberingSettings();
  const requested = (searchParams?.tab ?? '').trim();
  const groups = SETTING_GROUPS.filter((g) => SETTING_DEFS.some((d) => d.group === g));
  const current = Object.fromEntries(Object.entries(states).map(([k, s]) => [k, s.value]));

  const extras: Partial<Record<string, React.ReactNode>> = {
    'Tax & VAT': (
      <section className="rounded-2xl border border-border bg-card p-6 space-y-3" data-tool="vies">
        <h3 className="text-sm font-bold">Test a VAT ID with VIES</h3>
        <p className="text-xs text-muted-foreground">Asks the EU VIES service now (the answer is stored as evidence and re-used for {current.TAX_VIES_CACHE_HOURS || 24} h).</p>
        <ActionForm action={checkVatIdAction} className="flex items-center gap-2 flex-wrap">
          <input name="vatId" placeholder="e.g. DE123456789" className={`${small} w-56 font-mono`} />
          <button type="submit" className="h-9 px-4 rounded-full bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90">Check</button>
        </ActionForm>
      </section>
    ),
    'Invoicing & numbering': (
      <section className="rounded-2xl border border-border bg-card p-6 space-y-3" data-tool="number-series">
        <h3 className="text-sm font-bold">Number series</h3>
        <p className="text-xs text-muted-foreground">
          The next document of each type gets the number below (saved format, prefixes and fiscal year as of today). Issued counts per counter; a gap would mean a lost document — there should never be one.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-1.5 pr-3">Series</th><th className="py-1.5 pr-3">Next number now</th><th className="py-1.5 pr-3">Counters (issued)</th><th className="py-1.5">Gaps</th>
              </tr>
            </thead>
            <tbody>
              {(['INVOICE', 'CREDIT_NOTE', 'PROFORMA'] as DocSeries[]).map((code) => {
                const rows = series.filter((s) => s.series === code);
                const gaps = rows.flatMap((r) => r.gaps.map((g) => `${r.fiscalYear === 0 ? '' : `${r.fiscalYear}/`}${g}`));
                return (
                  <tr key={code} className="border-t border-border align-top">
                    <td className="py-2 pr-3 font-semibold">{code.replace('_', ' ').toLowerCase()}</td>
                    <td className="py-2 pr-3 font-mono">{nextNumberNow(code, numbering, series)}</td>
                    <td className="py-2 pr-3 text-xs">
                      {rows.length ? rows.map((r) => `${r.fiscalYear === 0 ? 'continuous' : r.fiscalYear}: ${r.issued}`).join(' · ') : 'none yet'}
                    </td>
                    <td className={`py-2 ${gaps.length ? 'text-red-600 font-bold' : 'text-muted-foreground'}`}>{gaps.length ? gaps.join(', ') : 'none'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Changes here need your authenticator code. The fiscal-year start and the yearly restart are locked once a series has started; prefixes must differ and the format must keep {'{PREFIX}'}, {'{SEQ}'} and — with a yearly restart — the year.
        </p>
      </section>
    ),
    'Compliance & countries': (
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4" data-tool="countries">
        <div>
          <h3 className="text-sm font-bold">Countries</h3>
          <p className="text-xs text-muted-foreground">Ship-to policy, EU membership and standard VAT rate (used for OSS). Rows marked “Suggested default” are not confirmed yet.</p>
        </div>
        <div className="space-y-2">
          {countries.map((c) => (
            <div key={c.country} className="rounded-xl border border-border p-2.5" data-country={c.country}>
              <ActionForm action={saveCountryPolicy} className="flex items-center gap-2 flex-wrap">
                <input type="hidden" name="country" value={c.country} />
                <span className="font-mono text-xs font-bold w-7">{c.country}</span>
                <input name="name" defaultValue={c.name} className={`${small} w-40`} aria-label="Name" />
                <select name="mode" defaultValue={c.mode} className={`${small} w-28 font-semibold ${c.mode === 'BLOCK' ? 'text-red-700' : c.mode === 'REVIEW' ? 'text-amber-700' : 'text-emerald-700'}`} aria-label="Policy">
                  <option value="ALLOW">Allow</option><option value="REVIEW">Review</option><option value="BLOCK">Block</option>
                </select>
                <select name="isEu" defaultValue={c.isEu ? 'true' : 'false'} className={`${small} w-24`} aria-label="EU member">
                  <option value="true">EU</option><option value="false">Non-EU</option>
                </select>
                <input name="vatRatePct" defaultValue={c.vatStandardRateBp != null ? String(c.vatStandardRateBp / 100) : ''} placeholder="VAT %" className={`${small} w-20`} aria-label="VAT %" />
                <input name="note" defaultValue={c.note ?? ''} placeholder="Note" className={`${small} flex-1 min-w-40`} aria-label="Note" />
                {canWrite && <button type="submit" className="h-9 px-3 rounded-full border border-border text-xs font-bold hover:bg-muted">Save</button>}
              </ActionForm>
              {canWrite && (
                <ActionForm action={deleteCountryPolicy} confirmText={`Remove ${c.name}? It then follows the policy for countries not in the table.`} className="mt-1">
                  <input type="hidden" name="country" value={c.country} />
                  <button type="submit" className="text-[11px] text-muted-foreground hover:text-red-600 underline">remove</button>
                </ActionForm>
              )}
            </div>
          ))}
        </div>
        {canWrite && (
          <div className="rounded-xl border border-dashed border-border p-3">
            <p className="text-xs font-bold mb-2">Add a country</p>
            <ActionForm action={saveCountryPolicy} className="flex items-center gap-2 flex-wrap">
              <input name="country" placeholder="Code (e.g. JP)" maxLength={2} className={`${small} w-28 font-mono uppercase`} />
              <input name="name" placeholder="Name" className={`${small} w-40`} />
              <select name="mode" defaultValue="REVIEW" className={`${small} w-28`}>
                <option value="ALLOW">Allow</option><option value="REVIEW">Review</option><option value="BLOCK">Block</option>
              </select>
              <select name="isEu" defaultValue="false" className={`${small} w-24`}>
                <option value="true">EU</option><option value="false">Non-EU</option>
              </select>
              <input name="vatRatePct" placeholder="VAT % (EU)" className={`${small} w-24`} />
              <input name="note" placeholder="Note" className={`${small} flex-1 min-w-40`} />
              <button type="submit" className="h-9 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold">Add</button>
            </ActionForm>
          </div>
        )}
      </section>
    ),
    Shipping: (
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4" data-tool="shipping-zones">
        <div>
          <h3 className="text-sm font-bold">Shipping zones &amp; rates</h3>
          <p className="text-xs text-muted-foreground">
            A zone is a list of countries (or * for “everywhere else”). Each rate is for one shipping class: flat, per item or per kg, with an optional free-above amount.
            {zones.length === 0 && ' No zones yet — until you add them every destination is “shipping to be confirmed”.'}
          </p>
        </div>
        {zones.map((z) => (
          <div key={z.id} className="rounded-xl border border-border p-3 space-y-2" data-zone={z.name}>
            <ActionForm action={saveShippingZone} className="flex items-center gap-2 flex-wrap">
              <input type="hidden" name="id" value={z.id} />
              <input name="name" defaultValue={z.name} className={`${small} w-44 font-semibold`} aria-label="Zone name" />
              <input name="countries" defaultValue={z.countries.join(', ')} className={`${small} flex-1 min-w-48 font-mono`} aria-label="Countries" />
              <select name="active" defaultValue={z.active ? 'true' : 'false'} className={`${small} w-24`}><option value="true">Active</option><option value="false">Off</option></select>
              <input name="sortOrder" defaultValue={String(z.sortOrder)} className={`${small} w-14`} aria-label="Order" />
              {canWrite && <button type="submit" className="h-9 px-3 rounded-full border border-border text-xs font-bold hover:bg-muted">Save zone</button>}
            </ActionForm>
            <div className="pl-3 border-l-2 border-border space-y-1.5">
              {z.rates.map((r) => (
                <ActionForm key={r.id} action={saveShippingRate} className="flex items-center gap-1.5 flex-wrap">
                  <input type="hidden" name="id" value={r.id} />
                  <input type="hidden" name="zoneId" value={z.id} />
                  <input name="name" defaultValue={r.name} className={`${small} w-36`} aria-label="Rate name" />
                  <select name="shippingClass" defaultValue={r.shippingClass} className={`${small} w-28`}><option value="PARCEL">Parcel</option><option value="PALLET">Pallet</option><option value="FREIGHT_QUOTE">Freight</option></select>
                  <select name="basis" defaultValue={r.basis} className={`${small} w-24`}><option value="FLAT">Flat</option><option value="PER_ITEM">Per item</option><option value="PER_KG">Per kg</option></select>
                  <input name="amount" defaultValue={(r.amountCents / 100).toFixed(2)} className={`${small} w-20`} aria-label="Amount €" />
                  <input name="freeAbove" defaultValue={r.freeAboveCents != null ? (r.freeAboveCents / 100).toFixed(2) : ''} placeholder="free above €" className={`${small} w-24`} />
                  <input name="handling" defaultValue={(r.handlingCents / 100).toFixed(2)} className={`${small} w-16`} aria-label="Handling €" />
                  <input name="minKg" defaultValue={r.minKg ?? ''} placeholder="min kg" className={`${small} w-16`} />
                  <input name="maxKg" defaultValue={r.maxKg ?? ''} placeholder="max kg" className={`${small} w-16`} />
                  <input name="leadTime" defaultValue={r.leadTimeText ?? ''} placeholder="lead time" className={`${small} w-24`} />
                  <select name="active" defaultValue={r.active ? 'true' : 'false'} className={`${small} w-20`}><option value="true">On</option><option value="false">Off</option></select>
                  {canWrite && <button type="submit" className="h-9 px-3 rounded-full border border-border text-xs font-bold hover:bg-muted">Save</button>}
                </ActionForm>
              ))}
              {canWrite && (
                <ActionForm action={saveShippingRate} className="flex items-center gap-1.5 flex-wrap pt-1">
                  <input type="hidden" name="zoneId" value={z.id} />
                  <input name="name" placeholder="New rate, e.g. DHL parcel" className={`${small} w-44`} />
                  <select name="shippingClass" defaultValue="PARCEL" className={`${small} w-28`}><option value="PARCEL">Parcel</option><option value="PALLET">Pallet</option><option value="FREIGHT_QUOTE">Freight</option></select>
                  <select name="basis" defaultValue="FLAT" className={`${small} w-24`}><option value="FLAT">Flat</option><option value="PER_ITEM">Per item</option><option value="PER_KG">Per kg</option></select>
                  <input name="amount" placeholder="€" className={`${small} w-20`} />
                  <input name="freeAbove" placeholder="free above €" className={`${small} w-24`} />
                  <input name="minKg" placeholder="min kg" className={`${small} w-16`} />
                  <input name="maxKg" placeholder="max kg" className={`${small} w-16`} />
                  <button type="submit" className="h-9 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold">Add rate</button>
                </ActionForm>
              )}
            </div>
            {canWrite && (
              <div className="flex gap-3">
                {z.rates.map((r) => (
                  <ActionForm key={r.id} action={deleteShippingRate} confirmText={`Remove rate “${r.name}”?`}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className="text-[11px] text-muted-foreground hover:text-red-600 underline">remove “{r.name}”</button>
                  </ActionForm>
                ))}
                <ActionForm action={deleteShippingZone} confirmText={`Remove zone “${z.name}” and all its rates?`}>
                  <input type="hidden" name="id" value={z.id} />
                  <button type="submit" className="text-[11px] text-muted-foreground hover:text-red-600 underline">remove zone</button>
                </ActionForm>
              </div>
            )}
          </div>
        ))}
        {canWrite && (
          <div className="rounded-xl border border-dashed border-border p-3">
            <p className="text-xs font-bold mb-2">Add a zone</p>
            <ActionForm action={saveShippingZone} className="flex items-center gap-2 flex-wrap">
              <input name="name" placeholder="Zone name, e.g. Benelux" className={`${small} w-44`} />
              <input name="countries" placeholder="NL, BE, LU" className={`${small} flex-1 min-w-48 font-mono`} />
              <button type="submit" className="h-9 px-3 rounded-full bg-primary text-primary-foreground text-xs font-bold">Add zone</button>
            </ActionForm>
          </div>
        )}
      </section>
    ),
  };

  const panels: Record<string, React.ReactNode> = {};
  // Security: the security team's own form (sets, units, cross-field rules,
  // security:manage + authenticator code); its keys are in the registry, so
  // every change also shows up under Change history.
  panels['Security'] = (
    <div className="space-y-4" data-tool="security-policy">
      <p className="text-xs leading-relaxed text-muted-foreground bg-foreground/[0.02] border border-border rounded-xl p-3">
        Two-factor sign-in, admin sessions, brute-force protection, marketing e-mail rules and backups. Saving needs the
        security:manage permission and a fresh authenticator code; every change is logged old → new, e-mailed to all
        super-admins and listed under Change history. Admin accounts, backup runs and security events:{' '}
        <Link href="/admin/settings/security" className="underline font-semibold">full security page</Link>.
      </p>
      <SecurityPolicyForm fields={buildPolicyFields(securityPolicy)} canEdit={canManageSecurity} action={saveSecurityPolicy} />
    </div>
  );
  // Homepage: edited on Admin → Homepage (draft, preview, publish); its changes are listed under Change history.
  panels['Homepage'] = (
    <p className="text-sm leading-relaxed text-muted-foreground bg-foreground/[0.02] border border-border rounded-xl p-4" data-tool="homepage-link">
      The homepage’s stations, categories, listings and texts are edited in{' '}
      <Link href="/admin/homepage" className="underline font-semibold">Admin → Homepage</Link>, with a draft preview before they go live.
      Published changes are listed under Change history and can be reverted there.
    </p>
  );
  for (const g of groups) {
    if (PANEL_GROUPS.includes(g)) continue;
    const conn = TAB_CONNECTION[g];
    const note = TAB_NOTE[g];
    panels[g] = (
      <div className="space-y-6">
        <SettingsSaveForm
          action={saveAdminSettings}
          group={g}
          saveNote="Saves this tab only. Every change is recorded in Change history. Empty a text field (or tick “reset”) to go back to the .env / default value; secret fields: empty = keep, tick “clear” to wipe."
        >
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">{g}</h2>
            <div className="flex items-center gap-3 flex-wrap">
              {g === 'Email' && <TestEmailButton />}
              {conn && <ConnTest kind={conn.kind} label={conn.label} />}
            </div>
          </div>
          {note && (
            <p className="text-xs leading-relaxed text-muted-foreground bg-foreground/[0.02] border border-border rounded-xl p-3">{note}</p>
          )}
          <div className="space-y-5">
            {SETTING_DEFS.filter((d) => d.group === g).map((d) => (
              <FieldRow key={d.key} d={d} st={states[d.key]} envOnly={envOnly.has(d.key)} />
            ))}
          </div>
          {conn && (
            <p className="text-[11px] text-muted-foreground border-t border-border pt-3">
              <strong className="text-foreground">How the test works:</strong> {conn.help}
            </p>
          )}
        </SettingsSaveForm>
        {extras[g]}
      </div>
    );
  }

  panels['Logo'] = <LogoUploadForm action={uploadCompanyLogo} currentUrl={current['COMPANY_LOGO_URL']} />;
  panels['Webhooks'] = <WebhooksPanel initial={webhooks} />;
  panels['Change history'] = (
    <section className="rounded-2xl border border-border bg-card p-6 space-y-3" data-tool="change-history">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Change history</h2>
      </div>
      <p className="text-xs text-muted-foreground">Every saved change, newest first. Secret values are never stored here (only a masked hint). “Revert” puts the old value back — itself recorded as a new change.</p>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-1.5 pr-3">When</th><th className="py-1.5 pr-3">Setting</th><th className="py-1.5 pr-3">From</th><th className="py-1.5 pr-3">To</th><th className="py-1.5 pr-3">By</th><th className="py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-t border-border align-top" data-change={h.key}>
                  <td className="py-2 pr-3 whitespace-nowrap text-xs">{fmtWhen(h.createdAt)}</td>
                  <td className="py-2 pr-3"><span className="font-semibold">{h.label}</span><span className="block text-[11px] text-muted-foreground">{h.group}{h.source !== 'ADMIN' ? ` · ${h.source.toLowerCase()}` : ''}</span></td>
                  <td className="py-2 pr-3 text-xs font-mono max-w-56 break-words">{h.oldValue ?? <span className="text-muted-foreground">(not set)</span>}</td>
                  <td className="py-2 pr-3 text-xs font-mono max-w-56 break-words">{h.newValue ?? <span className="text-muted-foreground">(not set)</span>}</td>
                  <td className="py-2 pr-3 text-xs">{h.actorEmail ?? '—'}{h.ip ? <span className="block text-[11px] text-muted-foreground">{h.ip}</span> : null}</td>
                  <td className="py-2">
                    {canWrite && h.revertable && (h.group !== 'Security' || canManageSecurity) && (
                      <SettingRevertButton action={revertSettingAction} changeId={h.id} confirmText={`Put “${h.label}” back to ${h.oldValue ?? 'its default'}?`} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  const fullGroups = [...groups, 'Logo', 'Webhooks', 'Change history'];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1">Every business rule in one place. Stored in the database, every change recorded.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <Mail className="h-3 w-3" />
            Email:&nbsp;
            {!mail.configured ? (
              <span className="text-red-600 dark:text-red-400">not configured — nothing is sent</span>
            ) : mail.mode === 'dev-capture' ? (
              <span className="text-amber-600 dark:text-amber-400">development mailbox only</span>
            ) : (
              <span className="text-emerald-600 dark:text-emerald-400" title={mail.label}>
                live · {mail.mode === 'resend' ? 'Resend' : mail.mode === 'smtp-relay' ? 'SMTP relay' : 'SMTP'}
              </span>
            )}
          </span>
          <Link
            href="/admin/settings/security"
            className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 text-primary px-2.5 py-1 font-semibold hover:bg-primary/15"
          >
            <ShieldCheck className="h-3 w-3" /> Security settings →
          </Link>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <CreditCard className="h-3 w-3" />
            Payments:&nbsp;
            {current['STRIPE_SECRET_KEY'] ? <span className="text-emerald-600 dark:text-emerald-400">card + bank transfer</span> : <span className="text-amber-600 dark:text-amber-400">bank transfer only</span>}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <Bot className="h-3 w-3" />
            AI:&nbsp;
            {current['AI_API_KEY'] ? <span className="text-emerald-600 dark:text-emerald-400">live</span> : <span className="text-amber-600 dark:text-amber-400">off</span>}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <Building2 className="h-3 w-3" />
            Storage:&nbsp;
            {process.env.S3_ENDPOINT ? <span className="text-emerald-600 dark:text-emerald-400">wired</span> : <span className="text-amber-600 dark:text-amber-400">unknown</span>}
          </span>
        </div>
      </div>

      <SettingsTabs groups={fullGroups} panels={panels} initial={requested || groups[0]} />
    </div>
  );
}
