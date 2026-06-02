import Link from 'next/link';
import {
  KeyRound,
  CheckCircle2,
  XCircle,
  ExternalLink,
  Image as ImageIcon,
  Mail,
  CreditCard,
  Bot,
  Building2,
  Save,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireCapability } from '@/lib/auth-server';
import { SETTING_DEFS, getEffectiveSettings } from '@/lib/settings';
import { saveAdminSettings, uploadCompanyLogo, listWebhooks } from '../actions';
import { ConnTest } from '@/components/admin/ConnTest';
import { FieldVerify } from '@/components/admin/FieldVerify';
import { SettingsTabs } from '@/components/admin/SettingsTabs';
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
    'No Resend key = order/quote/sell/message emails fall back to the dev mailbox (Mailpit). Real delivery needs a verified Resend domain matching the From address.',
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

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams?: { tab?: string };
}) {
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
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-600">
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
          autoComplete="off"
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
      <form action={saveAdminSettings} className="rounded-2xl border border-border bg-card p-6 space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">{g}</h2>
          {conn && <ConnTest kind={conn.kind} label={conn.label} />}
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
        <div className="flex items-center gap-3 pt-2 border-t border-border">
          <Button type="submit" size="sm" className="rounded-full font-semibold">
            <Save className="h-4 w-4" /> Save {g}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Saves this tab only. Empty secret field = keep current. Tick “clear” to wipe.
          </p>
        </div>
      </form>
    );
  }

  // Logo upload — separate independent form, lives on its own tab so the
  // Brand/Company tabs aren't crowded with a file picker.
  panels['Logo'] = (
    <form
      action={uploadCompanyLogo}
      className="rounded-2xl border border-border bg-card p-6 space-y-5"
    >
      <div className="flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Brand logo</h2>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground bg-foreground/[0.02] border border-border rounded-xl p-3">
        Uploaded once, then surfaced on every invoice + proforma. Keep a transparent background — looks best on white documents.
      </p>
      <div className="flex items-center gap-5 flex-wrap">
        <div className="h-20 w-48 rounded-lg border border-border bg-white flex items-center justify-center overflow-hidden">
          {current['COMPANY_LOGO_URL'] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={current['COMPANY_LOGO_URL']}
              alt="Company logo"
              className="max-h-16 max-w-[180px] object-contain"
            />
          ) : (
            <span className="text-xs text-muted-foreground">No logo</span>
          )}
        </div>
        <div className="flex-1 min-w-[220px]">
          <p className="text-sm font-bold">Replace logo</p>
          <p className="text-xs text-muted-foreground mb-2">
            PNG / SVG / JPG / WEBP, max 2MB.
          </p>
          <input
            type="file"
            name="logo"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            required
            className="text-sm"
          />
        </div>
      </div>
      <div className="pt-2 border-t border-border">
        <Button type="submit" variant="outline" className="rounded-full font-semibold">
          Upload logo
        </Button>
      </div>
    </form>
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
              <span className="text-emerald-600">live</span>
            ) : (
              <span className="text-amber-600">dev mailbox</span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <CreditCard className="h-3 w-3" />
            Payments:&nbsp;
            {current['STRIPE_SECRET_KEY'] ? (
              <span className="text-emerald-600">live</span>
            ) : (
              <span className="text-amber-600">pending only</span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <Bot className="h-3 w-3" />
            AI:&nbsp;
            {current['AI_API_KEY'] ? (
              <span className="text-emerald-600">live</span>
            ) : (
              <span className="text-amber-600">off</span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground/5 px-2.5 py-1 font-semibold">
            <Building2 className="h-3 w-3" />
            Storage:&nbsp;
            {process.env.S3_ENDPOINT ? (
              <span className="text-emerald-600">wired</span>
            ) : (
              <span className="text-amber-600">unknown</span>
            )}
          </span>
        </div>
      </div>

      <SettingsTabs groups={fullGroups} panels={panels} initial={requested || groups[0]} />
    </div>
  );
}
