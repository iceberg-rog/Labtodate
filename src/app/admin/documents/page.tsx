import Link from 'next/link';
import { AlertTriangle, CheckCircle2, FileText } from 'lucide-react';
import { requireCapability, requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { getEffectiveSettings } from '@/lib/settings';
import { recentChanges } from '@/lib/cms/store';
import { companySnapshot, readiness } from '@/lib/documents/company';
import { COMPANY_FIELDS, COMPANY_FIELD_META } from '@/lib/documents/company-fields';
import { configKeys, getGeneral, getLabels, getNumbering, getOptions, getTexts, getVatSettings, textFieldsFor } from '@/lib/documents/config';
import { LABEL_FIELDS } from '@/lib/documents/defaults';
import { peekNumber } from '@/lib/documents/numbering';
import { previewSources } from '@/lib/documents/preview';
import { DOC_KIND_LABEL, DOC_KINDS, asLang, type DocKind } from '@/lib/documents/types';
import { fieldsFor, LABEL_EXTRA_FIELDS } from '@/lib/documents/vars';
import { EMAIL_DEFS } from '@/lib/email-templates/registry';
import { getEmailLayout, getEmailOptions, getEmailTexts } from '@/lib/email-templates/send';
import { COMMON_EMAIL_FIELDS } from '@/lib/email-templates/types';
import { uploadCompanyLogo } from '../actions';
import { LogoUploadForm } from '@/components/admin/LogoUploadForm';
import {
  CompanyForm,
  EmailEditor,
  EmailFooterEditor,
  HistoryPanel,
  LabelsEditor,
  SettingsForm,
  TemplateEditor,
  VatTester,
} from '@/components/admin/documents/DocumentsUI';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Documents' };

const TABS = [
  { id: 'company', label: 'Company & bank' },
  { id: 'templates', label: 'Templates' },
  { id: 'emails', label: 'E-mails' },
  { id: 'numbering', label: 'Numbering' },
  { id: 'vat', label: 'VAT' },
  { id: 'general', label: 'General' },
  { id: 'history', label: 'History' },
] as const;

const TEXT_HINTS: Record<string, string> = {
  title: 'Printed as the heading, used in the PDF file name and as the page title on the customer’s screen.',
  titleUnpaid: 'Used while the order is not paid yet (a payment request, not a tax invoice).',
  stamp: 'Small badge next to the title. Empty = no badge.',
  greeting: 'Used when the customer’s name is known.',
  greetingFallback: 'Used when no name is known.',
  paymentTerms: 'Shown on quotes and on unpaid invoices only.',
  footer: 'Small print at the bottom (terms, registration lines).',
};

function tabHref(tab: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ tab, ...extra });
  return `/admin/documents?${q.toString()}`;
}

export default async function DocumentsPage(props: { searchParams?: Promise<Record<string, string | undefined>> }) {
  const sp = (await props.searchParams) ?? {};
  await requireCapability('documents:edit');
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/documents' });
  const tab = TABS.some((t) => t.id === sp.tab) ? sp.tab! : 'company';
  const company = await companySnapshot({ withLogo: true });
  const missing = readiness(company);
  const required = missing.filter((m) => m.required);

  let panel: React.ReactNode = null;

  if (tab === 'company') {
    const values = await getEffectiveSettings();
    panel = (
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <CompanyForm
          fields={COMPANY_FIELDS.map((k) => ({ key: k, ...COMPANY_FIELD_META[k] }))}
          values={Object.fromEntries(COMPANY_FIELDS.map((k) => [k, values[k] ?? '']))}
        />
        <div className="space-y-5">
          <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Ready to send?</h2>
            {missing.length === 0 ? (
              <p className="text-sm inline-flex items-center gap-2 text-emerald-700"><CheckCircle2 className="h-4 w-4" /> Everything a document needs is filled in.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {missing.map((m) => (
                  <li key={m.field} className={m.required ? 'text-red-800 dark:text-red-300' : 'text-amber-800 dark:text-amber-300'}>
                    <strong>{m.label}</strong> {m.required ? '(required)' : '(recommended)'} — {m.why}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Logo</h2>
            <LogoUploadForm action={uploadCompanyLogo} currentUrl={process.env.COMPANY_LOGO_URL} />
          </section>
        </div>
      </div>
    );
  }

  if (tab === 'templates') {
    const doc = sp.doc === 'LABELS' ? 'LABELS' : (DOC_KINDS.includes(sp.doc as DocKind) ? (sp.doc as DocKind) : 'QUOTE');
    const lang = asLang(sp.lang);
    const nav = (
      <div className="flex items-center gap-2 flex-wrap">
        {[...DOC_KINDS, 'LABELS' as const].map((k) => (
          <Link key={k} href={tabHref('templates', { doc: k, lang })} className={`h-9 px-3 inline-flex items-center rounded-lg border text-sm font-semibold ${doc === k ? 'border-primary text-primary bg-primary/5' : 'border-border hover:bg-foreground/[0.04]'}`}>
            {k === 'LABELS' ? 'Shared labels' : DOC_KIND_LABEL[k]}
          </Link>
        ))}
        <span className="mx-1 h-6 w-px bg-border" />
        {(['en', 'nl'] as const).map((l) => (
          <Link key={l} href={tabHref('templates', { doc, lang: l })} className={`h-9 px-3 inline-flex items-center rounded-lg border text-sm font-semibold ${lang === l ? 'border-primary text-primary bg-primary/5' : 'border-border hover:bg-foreground/[0.04]'}`}>
            {l === 'en' ? 'English' : 'Dutch'}
          </Link>
        ))}
      </div>
    );
    if (doc === 'LABELS') {
      panel = (
        <div className="space-y-4">
          {nav}
          <LabelsEditor
            key={`labels-${lang}`}
            lang={lang}
            labelFields={LABEL_FIELDS as unknown as { key: string; label: string; group: string; rich?: boolean }[]}
            initial={(await getLabels(lang)) as unknown as Record<string, string>}
            fields={[...fieldsFor(), ...LABEL_EXTRA_FIELDS.map((n) => ({ name: n, label: 'VAT rate (VAT row only)', example: '21%' }))]}
            sources={await previewSources('QUOTE')}
          />
        </div>
      );
    } else {
      panel = (
        <div className="space-y-4">
          {nav}
          <TemplateEditor
            key={`${doc}-${lang}`}
            kind={doc}
            lang={lang}
            textFields={textFieldsFor(doc).map((f) => ({ key: f.key, label: f.label, rich: f.rich, max: f.max }))}
            initialTexts={(await getTexts(doc, lang)) as unknown as Record<string, string>}
            initialOptions={(await getOptions(doc)) as unknown as Record<string, boolean | number>}
            fields={fieldsFor(doc)}
            sources={await previewSources(doc)}
            hints={TEXT_HINTS}
          />
        </div>
      );
    }
  }

  if (tab === 'emails') {
    const selected = EMAIL_DEFS.find((d) => d.key === sp.email) ?? EMAIL_DEFS[0];
    const groups = Array.from(new Set(EMAIL_DEFS.map((d) => d.group)));
    const enabled = Object.fromEntries(await Promise.all(EMAIL_DEFS.map(async (d) => [d.key, (await getEmailOptions(d.key)).enabled] as const)));
    const [en, nl, layoutEn, layoutNl] = await Promise.all([
      getEmailTexts(selected.key, 'en'),
      getEmailTexts(selected.key, 'nl'),
      getEmailLayout('en'),
      getEmailLayout('nl'),
    ]);
    panel = (
      <div className="grid gap-5 xl:grid-cols-[17rem_minmax(0,1fr)]">
        <nav className="rounded-2xl border border-border bg-card p-3 space-y-3 self-start" aria-label="E-mails">
          {groups.map((g) => (
            <div key={g}>
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground px-2 mb-1">{g}</p>
              <ul>
                {EMAIL_DEFS.filter((d) => d.group === g).map((d) => (
                  <li key={d.key}>
                    <Link href={tabHref('emails', { email: d.key })} className={`flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm ${d.key === selected.key ? 'bg-primary/10 text-primary font-semibold' : 'hover:bg-foreground/[0.04]'}`}>
                      <span className="truncate">{d.label}</span>
                      {!enabled[d.key] && <span className="text-[10px] font-bold uppercase text-muted-foreground">off</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="space-y-5 min-w-0">
          <EmailEditor
            key={selected.key}
            emailKey={selected.key}
            label={selected.label}
            when={selected.when}
            canDisable={selected.canDisable}
            enabled={enabled[selected.key]}
            attachments={selected.attachments}
            hasButton={!!selected.buttonLink}
            fields={[...COMMON_EMAIL_FIELDS, ...selected.fields]}
            initial={{ en, nl }}
            me={session.user.email}
          />
          <EmailFooterEditor initial={{ en: layoutEn.footer, nl: layoutNl.footer }} />
        </div>
      </div>
    );
  }

  if (tab === 'numbering') {
    const n = await getNumbering();
    const [nq, ni, nr] = await Promise.all([peekNumber(prisma, 'QUOTE', n.QUOTE), peekNumber(prisma, 'INVOICE', n.INVOICE), peekNumber(prisma, 'RECEIPT', n.RECEIPT)]);
    const series = (k: 'QUOTE' | 'INVOICE' | 'RECEIPT', label: string, next: string) => ({
      title: `${label} — next: ${next}`,
      fields: [
        { type: 'text' as const, name: `${k}_pattern`, label: 'Pattern', mono: true, hint: 'Tokens: {YYYY} {YY} {MM} {SEQ:5}. Example: INV-{YYYY}-{SEQ:5} → INV-2026-00001.' },
        { type: 'number' as const, name: `${k}_start`, label: 'Start number', hint: 'To continue an existing series. Numbers never go backwards.' },
        { type: 'checkbox' as const, name: `${k}_yearlyReset`, label: 'Restart at the start number every year', hint: 'Needs {YYYY} or {YY} in the pattern.' },
      ],
    });
    panel = (
      <SettingsForm
        action="numbering"
        title="Document numbers"
        historyKey="settings:numbering"
        initial={{
          QUOTE_pattern: n.QUOTE.pattern, QUOTE_start: n.QUOTE.start, QUOTE_yearlyReset: n.QUOTE.yearlyReset,
          INVOICE_pattern: n.INVOICE.pattern, INVOICE_start: n.INVOICE.start, INVOICE_yearlyReset: n.INVOICE.yearlyReset,
          RECEIPT_pattern: n.RECEIPT.pattern, RECEIPT_start: n.RECEIPT.start, RECEIPT_yearlyReset: n.RECEIPT.yearlyReset,
          RECEIPT_useInvoiceNumber: n.RECEIPT.useInvoiceNumber, ORDER_pattern: n.ORDER.pattern,
        }}
        sections={[
          series('QUOTE', 'Quotes', nq),
          series('INVOICE', 'Invoices (consecutive, required by law)', ni),
          { ...series('RECEIPT', 'Receipts', nr), fields: [...series('RECEIPT', 'Receipts', nr).fields, { type: 'checkbox', name: 'RECEIPT_useInvoiceNumber', label: 'Receipts carry the invoice number instead of their own series' }] },
          { title: 'Orders', fields: [{ type: 'text', name: 'ORDER_pattern', label: 'Pattern', mono: true, hint: 'Order numbers are references, not tax documents: {YYYY} {YY} {MM} and a random part {RAND:6}. Existing orders keep their numbers.' }] },
        ]}
      />
    );
  }

  if (tab === 'vat') {
    const v = await getVatSettings();
    panel = (
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <SettingsForm
          action="vat"
          title="VAT rules"
          historyKey="settings:vat"
          initial={{ ...v }}
          sections={[
            {
              fields: [
                { type: 'text', name: 'homeCountry', label: 'Home country', hint: 'Two letters. Sales to this country always carry the standard rate.' },
                { type: 'number', name: 'standardRatePct', label: 'Standard rate (%)', hint: 'NL: 21.' },
                { type: 'select', name: 'defaultTreatment', label: 'Default when the buyer’s country is unknown', options: [
                  { value: 'DOMESTIC', label: 'Standard VAT (recommended)' },
                  { value: 'REVERSE_CHARGE', label: 'EU reverse charge, 0%' },
                  { value: 'EXPORT', label: 'Export, 0%' },
                ] },
                { type: 'select', name: 'viesDownPolicy', label: 'When VIES cannot be reached', options: [
                  { value: 'HOLD', label: 'Let me decide in the quote (recommended)' },
                  { value: 'CHARGE_HOME', label: 'Charge the standard rate' },
                  { value: 'BLOCK', label: 'Block until VIES confirms' },
                ] },
                { type: 'checkbox', name: 'autoDecide', label: 'Decide the VAT automatically from the buyer’s country and VAT ID', hint: 'Off = every document uses the default above.' },
                { type: 'checkbox', name: 'reverseChargeEnabled', label: 'EU reverse charge (0%) for businesses with a valid EU VAT ID outside the home country' },
                { type: 'checkbox', name: 'requireVies', label: 'Reverse charge only after a successful live VIES check', hint: 'Recommended: the tax office expects proof that the VAT ID was valid on the day of the sale.' },
                { type: 'checkbox', name: 'exportZeroEnabled', label: '0% for buyers outside the EU (export)', hint: 'Keep the proof of export (shipping documents).' },
                { type: 'checkbox', name: 'allowOverride', label: 'Allow changing the suggested treatment in the quote composer', hint: 'Every change is written to the audit log with the reason.' },
              ],
            },
          ]}
        />
        <div className="space-y-5">
          <VatTester />
          <section className="rounded-2xl border border-border bg-card p-5 text-xs text-muted-foreground space-y-2">
            <p><strong className="text-foreground">Legal texts</strong> printed for reverse charge and export are edited in Templates → Shared labels (English and Dutch).</p>
            <p>Shipping always follows the VAT of the goods on the same document.</p>
          </section>
        </div>
      </div>
    );
  }

  if (tab === 'general') {
    const g = await getGeneral();
    panel = (
      <SettingsForm
        action="general"
        title="General"
        historyKey="doc:general"
        initial={{ ...g }}
        sections={[
          {
            fields: [
              { type: 'select', name: 'defaultLang', label: 'Default document language', hint: 'Used for customers who have no language set. The quote composer can change it per document.', options: [{ value: 'en', label: 'English' }, { value: 'nl', label: 'Dutch' }] },
              { type: 'text', name: 'accent', label: 'Accent colour', hint: 'Headings and lines on documents and e-mails, e.g. #0E4F40.', mono: true },
              { type: 'select', name: 'readiness', label: 'When company details are missing', options: [{ value: 'WARN', label: 'Warn and ask before sending' }, { value: 'BLOCK', label: 'Block sending until they are filled in' }] },
              { type: 'checkbox', name: 'receiptEnabled', label: 'Issue a receipt when a payment is verified', hint: 'Attached to the “Payment received” e-mail next to the invoice.' },
              { type: 'checkbox', name: 'attachInvoice', label: 'Attach the invoice PDF to the “Payment received” e-mail' },
              { type: 'checkbox', name: 'billingCopy', label: 'Send a copy of every issued document to the billing e-mail', hint: 'Company & bank → Billing e-mail.' },
            ],
          },
        ]}
      />
    );
  }

  if (tab === 'history') {
    const keys = [
      ...configKeys(),
      ...EMAIL_DEFS.flatMap((d) => [
        { key: `email:${d.key}:en`, label: `E-mail: ${d.label} (EN)` },
        { key: `email:${d.key}:nl`, label: `E-mail: ${d.label} (NL)` },
      ]),
      { key: 'email:layout:en', label: 'E-mail footer (EN)' },
      { key: 'email:layout:nl', label: 'E-mail footer (NL)' },
    ];
    const recent = await recentChanges(undefined, 20);
    const label = new Map(keys.map((k) => [k.key, k.label]));
    panel = (
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <HistoryPanel keys={keys} initialKey={sp.key && label.has(sp.key) ? sp.key : recent[0]?.entryKey} />
        <section className="rounded-2xl border border-border bg-card p-5 space-y-2 self-start">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Latest changes</h2>
          {recent.length === 0 && <p className="text-sm text-muted-foreground">Nothing changed yet.</p>}
          <ul className="space-y-1.5 text-sm">
            {recent.map((r) => (
              <li key={r.id}>
                <Link className="hover:underline" href={tabHref('history', { key: r.entryKey })}>{label.get(r.entryKey) ?? r.entryKey}</Link>
                <span className="block text-[11px] text-muted-foreground">v{r.version} · {r.createdByEmail ?? 'system'} · {r.createdAt.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    );
  }

  return (
    <div className="container-px py-8 max-w-[1500px] mx-auto space-y-5">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold inline-flex items-center gap-2"><FileText className="h-6 w-6 text-primary" /> Documents</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Quotes, invoices, receipts and every e-mail the site sends. Changes apply to new documents; documents already sent never change.
          </p>
        </div>
      </header>
      {required.length > 0 && tab !== 'company' && (
        <Link href={tabHref('company')} className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span><strong>Company block incomplete:</strong> {required.map((m) => m.label).join(', ')} missing. Documents go out without them. Fill them in →</span>
        </Link>
      )}
      <nav className="flex gap-1 overflow-x-auto border-b border-border" aria-label="Documents sections">
        {TABS.map((t) => (
          <Link key={t.id} href={tabHref(t.id)} className={`px-3 h-10 inline-flex items-center text-sm font-semibold whitespace-nowrap border-b-2 -mb-px ${tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      {panel}
    </div>
  );
}
