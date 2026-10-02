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
} from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { SETTING_DEFS, getEffectiveSettings } from '@/lib/settings';
import { saveAdminSettings, uploadCompanyLogo, listWebhooks } from '../actions';
import { ConnTest } from '@/components/admin/ConnTest';
import { TestEmailButton } from '@/components/admin/TestEmailButton';
import { FieldVerify } from '@/components/admin/FieldVerify';
import { SettingsTabs } from '@/components/admin/SettingsTabs';
import { SettingsSaveForm } from '@/components/admin/SettingsSaveForm';
import { LogoUploadForm } from '@/components/admin/LogoUploadForm';
import { WebhooksPanel } from '@/components/admin/WebhooksPanel';

export const dynamic = 'force-dynamic';

const TAB_CONNECTION: Partial<Record<string, { kind: 'resend' | 'stripe' | 'ai' | 'storage'; label: string; help: string }>> = {
  Email: {
    kind: 'resend',
    label: 'Resend',
    help: 'Calls Resend /domains — proves the key works AND lists the verified sending domains.',
  },
  Payments: {
    kind: 'stripe',
    label: 'Stripe',
    help: 'Calls Stripe balance — proves the secret key is live and currencies are configured.',
  },
  'AI assistant': {
    kind: 'ai',
    label: 'AI provider',
    help: 'Calls the configured /v1/models endpoint — proves the API key and base URL.',
  },
  Company: {
    kind: 'storage',
    label: 'Object storage',
    help: 'Pings MinIO/S3 + ensures the upload bucket exists.',
  },
};

const TAB_NOTE: Partial<Record<string, string>> = {
  Email:
    'Two ways to send real email: (1) a Resend API key (simplest — HTTPS, no SMTP ports), or (2) your own SMTP server (host/port/user/password below). Resend wins if its key is set; leave it blank to use SMTP. With neither, all emails fall back to the dev mailbox (Mailpit). After saving, use “Send test email” to confirm delivery.',
  Payments:
    'No Stripe keys = checkout will fall back to a PENDING_PAYMENT order with no card capture. Webhook secret is required for the order to flip to PAID automatically.',
  Brand: 'Brand display values — used in headers, footers, page metadata and outbound emails.',
  Company: 'Printed on invoices and proformas. Logo is uploaded separately below.',
  Marketing: 'Surface copy across landing pages. Use the “Preview on site” link to see exactly where each value renders.',
  Commerce: 'Applied at checkout to every paid order. Numbers only.',
  Selling: 'Public pricing & fees page. Be honest — these values are quoted to potential suppliers.',
  'AI assistant':
    'Powers the on-site chat widget. OpenAI-compatible — any provider that follows OpenAI’s /v1/chat/completions shape works.',
};

export default async function AdminSettingsPage(
  props: {
    searchParams?: Promise<{ tab?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  await requireCapability('settings:view');
  const current = await getEffectiveSettings();
  const groups = Array.from(new Set(SETTING_DEFS.map((d) => d.group)));
  const requested = (searchParams?.tab ?? '').trim();
  const webhooks = await listWebhooks().catch(() => []);

  const field =
    'w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

  function FieldRow(d: (typeof SETTING_DEFS)[number]) {
    const val = current[d.key] || '';
    const isSet = val.trim().length > 0;
    const verify = 'verify' in d ? (d as { verify?: string }).verify : undefined;
    const preview = 'preview' in d ? (d as { preview?: string }).preview : undefined;
    return (
      <div key={d.key} className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={d.key} className="text-sm font-semibold flex items-center gap-2">
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            {d.label}
          </label>
          {isSet ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Configured
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-muted-foreground">
              <XCircle className="h-3.5 w-3.5" /> Not set
            </span>
          )}
        </div>
        <input
          id={d.key}
          name={d.key}
          type={d.secret ? 'password' : 'text'}
          // Browsers ignore autoComplete="off" on password inputs and fill a saved
          // login password into the first one (the Resend key), which then silently
          // overrides SMTP. "new-password" + the password-manager opt-outs stop that.
          autoComplete={d.secret ? 'new-password' : 'off'}
          data-1p-ignore={d.secret || undefined}
          data-lpignore={d.secret ? 'true' : undefined}
          data-bwignore={d.secret || undefined}
          defaultValue={d.secret ? '' : val}
          placeholder={
            d.secret
              ? isSet
                ? '•••••••• (set — type to replace)'
                : 'Not set — paste the key here'
              : d.key
          }
          className={field}
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{d.hint}</p>
          {isSet && (
            <label className="text-xs text-muted-foreground inline-flex items-center gap-1.5 shrink-0">
              <input type="checkbox" name={`__clear_${d.key}`} className="accent-primary" />
              clear
            </label>
          )}
        </div>
        {(verify || preview) && (
          <div className="flex items-center gap-3 flex-wrap pt-0.5">
            {verify && <FieldVerify settingKey={d.key} />}
            {preview && (
              <Link
                href={preview}
                target="_blank"
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> Preview on site
              </Link>
            )}
            {verify && (
              <span className="text-[11px] text-muted-foreground">
                Save first — Verify checks the stored value.
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  const panels: Record<string, React.ReactNode> = {};
  for (const g of groups) {
    const conn = TAB_CONNECTION[g];
    const note = TAB_NOTE[g];
    panels[g] = (
      <SettingsSaveForm
        action={saveAdminSettings}
        group={g}
        saveNote="Saves this tab only. Empty secret field = keep current. Tick “clear” to wipe."
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">{g}</h2>
          <div className="flex items-center gap-3 flex-wrap">
            {g === 'Email' && <TestEmailButton />}
            {conn && <ConnTest kind={conn.kind} label={conn.label} />}
          </div>
        </div>
        {note && (
          <p className="text-xs leading-relaxed text-muted-foreground bg-foreground/[0.02] border border-border rounded-xl p-3">
            {note}
          </p>
        )}
        <div className="space-y-5">
          {SETTING_DEFS.filter((d) => d.group === g).map(FieldRow)}
        </div>
        {conn && (
          <p className="text-[11px] text-muted-foreground border-t border-border pt-3">
            <strong className="text-foreground">How the test works:</strong> {conn.help}
          </p>
        )}
      </SettingsSaveForm>
    );
  }

  // Logo upload — separate independent form, lives on its own tab so the
  // Brand/Company tabs aren't crowded with a file picker.
  panels['Logo'] = (
    <LogoUploadForm action={uploadCompanyLogo} currentUrl={current['COMPANY_LOGO_URL']} />
  );

  // Webhooks tab — separate from regular settings, full panel
  panels['Webhooks'] = <WebhooksPanel initial={webhooks} />;

  const fullGroups = [...groups, 'Logo', 'Webhooks'];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1">
            Base configuration. Stored in the database, hydrated at runtime — no SSH needed.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <Mail className="h-3 w-3" />
            Email:&nbsp;
            {current['RESEND_API_KEY'] ? (
              <span className="text-emerald-600 dark:text-emerald-400">live · Resend</span>
            ) : current['SMTP_USER'] && current['SMTP_PASS'] ? (
              <span className="text-emerald-600 dark:text-emerald-400">live · SMTP</span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">dev mailbox</span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <CreditCard className="h-3 w-3" />
            Payments:&nbsp;
            {current['STRIPE_SECRET_KEY'] ? (
              <span className="text-emerald-600 dark:text-emerald-400">live</span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">pending only</span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <Bot className="h-3 w-3" />
            AI:&nbsp;
            {current['AI_API_KEY'] ? (
              <span className="text-emerald-600 dark:text-emerald-400">live</span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">off</span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <Building2 className="h-3 w-3" />
            Storage:&nbsp;
            {process.env.S3_ENDPOINT ? (
              <span className="text-emerald-600 dark:text-emerald-400">wired</span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">unknown</span>
            )}
          </span>
        </div>
      </div>

      <SettingsTabs groups={fullGroups} panels={panels} initial={requested || groups[0]} />
    </div>
  );
}
