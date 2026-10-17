'use client';

import { useState } from 'react';
import { Bell, Mail, Megaphone, Sparkles, AlertOctagon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AdminActionForm, AdminActionStatus, type AdminActionResult } from '@/components/admin/AdminActionForm';
import { useStepUp, type MaybeStepUp } from '@/components/security/useStepUp';

type Audience = 'ALL' | 'BUYER' | 'SELLER';
type Kind = 'OFFER' | 'ANNOUNCEMENT' | 'SYSTEM';

export type EmailReach = { emailable: number; noConsent: number; unsubscribed: number; notVerified: number; placeholder: number };

// Starting points only: every ⟨…⟩ must be replaced with real facts — the
// server refuses to send a text that still contains one (no invented offers,
// codes or stock claims go out by accident).
const TEMPLATES: { name: string; title: string; body: string; kind: Kind; href: string }[] = [
  {
    name: 'Offer',
    title: '⟨Product / category⟩: ⟨what is on offer⟩',
    body: 'Until ⟨end date⟩ we offer ⟨the offer — price, discount or bundle⟩ on ⟨products⟩. ⟨Conditions: quantities, how to order⟩.',
    kind: 'OFFER',
    href: '/marketplace',
  },
  {
    name: 'New arrivals',
    title: 'Now in stock: ⟨equipment⟩',
    body: '⟨Number⟩ ⟨refurbished / tested⟩ ⟨equipment⟩ just arrived. ⟨Condition, warranty and what makes them interesting⟩.',
    kind: 'ANNOUNCEMENT',
    href: '/marketplace',
  },
  {
    name: 'Service notice',
    title: 'Scheduled maintenance on ⟨date⟩',
    body: 'On ⟨date⟩ between ⟨start⟩ and ⟨end⟩ (Amsterdam time) the site will be ⟨unavailable / read-only⟩. ⟨What customers should do⟩.',
    kind: 'SYSTEM',
    href: '',
  },
];

export function AnnouncementComposer({
  action,
  audienceCounts,
  emailReach,
  mail,
  canEmail,
  legalMissing,
}: {
  action: (formData: FormData) => Promise<MaybeStepUp>;
  audienceCounts: { ALL: number; BUYER: number; SELLER: number };
  /** Per audience and category: who may get the e-mail and why the others don't. */
  emailReach: Record<Audience, { MARKETING: EmailReach; SERVICE: EmailReach }>;
  mail: { configured: boolean; label: string; problem?: string };
  /** The viewer holds marketing:send. */
  canEmail: boolean;
  /** Company identity fields still empty (marketing e-mail is refused until filled). */
  legalMissing: string[];
}) {
  const { run, dialog } = useStepUp();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<Kind>('OFFER');
  const [audience, setAudience] = useState<Audience>('ALL');
  const [href, setHref] = useState('');
  const [email, setEmail] = useState(false);

  function apply(t: (typeof TEMPLATES)[number]) {
    setTitle(t.title);
    setBody(t.body);
    setKind(t.kind);
    setHref(t.href);
  }

  const category = kind === 'SYSTEM' ? 'SERVICE' : 'MARKETING';
  const reach = emailReach[audience][category];
  const recipients = audienceCounts[audience];
  const KindIcon = kind === 'OFFER' ? Sparkles : kind === 'ANNOUNCEMENT' ? Megaphone : AlertOctagon;
  const emailPossible = canEmail && mail.configured && !(category === 'MARKETING' && legalMissing.length);

  const field =
    'w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

  const audienceLabel =
    audience === 'ALL' ? 'all buyers and internal suppliers' : audience === 'BUYER' ? 'buyers only' : 'internal suppliers only';

  return (
    <AdminActionForm
      action={(fd) => run(() => action(fd)) as Promise<AdminActionResult>}
      className="space-y-6"
      statusInChildren
      // A broadcast can reach thousands of people and can't be unsent.
      confirmMessage={() =>
        `Send “${title.trim()}” in-app to ${recipients} account${recipients === 1 ? '' : 's'} (${audienceLabel})${
          email && emailPossible ? ` and by e-mail to ${reach.emailable}` : ''
        }? This cannot be undone.`
      }
      onResult={(r) => {
        if (r.ok) {
          setTitle('');
          setBody('');
          setHref('');
        }
      }}
    >
      {dialog}
      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
        <div className="min-w-0 space-y-5">
          <div className="rounded-2xl border border-border bg-card p-5 space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Start from a template</h2>
            <div className="grid sm:grid-cols-3 gap-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => apply(t)}
                  className="text-left rounded-xl border border-border p-3 hover:bg-foreground/[0.03] transition-colors"
                >
                  <p className="text-xs font-bold">{t.name}</p>
                  <p className="text-[11px] text-muted-foreground line-clamp-2 mt-1">{t.title}</p>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">Replace every ⟨…⟩ with the real details — a text that still contains one is not sent.</p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">Title</span>
              <input
                name="title"
                required
                minLength={3}
                maxLength={140}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What is it about?"
                className={`${field} h-10`}
              />
              <span className="text-[11px] text-muted-foreground mt-1 block tabular-nums">{title.length} / 140</span>
            </label>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">Message</span>
              <textarea
                name="body"
                required
                minLength={3}
                rows={5}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write the offer / announcement…"
                className={field}
              />
            </label>
            <div className="grid sm:grid-cols-3 gap-4">
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">Type</span>
                <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={`${field} h-10`}>
                  <option value="OFFER">Offer (marketing)</option>
                  <option value="ANNOUNCEMENT">News / announcement (marketing)</option>
                  <option value="SYSTEM">Service notice (not marketing)</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">Audience</span>
                <select name="audience" value={audience} onChange={(e) => setAudience(e.target.value as Audience)} className={`${field} h-10`}>
                  <option value="ALL">Buyers + suppliers ({audienceCounts.ALL})</option>
                  <option value="BUYER">Buyers only ({audienceCounts.BUYER})</option>
                  <option value="SELLER">Internal suppliers ({audienceCounts.SELLER})</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">Link (optional)</span>
                <input
                  name="href"
                  value={href}
                  onChange={(e) => setHref(e.target.value)}
                  placeholder="/marketplace?category=hplc-lc"
                  className={`${field} h-10`}
                />
              </label>
            </div>
            <label className={`flex items-start gap-2 text-sm pt-1 ${emailPossible ? '' : 'opacity-60'}`}>
              <input
                type="checkbox"
                name="email"
                checked={email && emailPossible}
                disabled={!emailPossible}
                onChange={(e) => setEmail(e.target.checked)}
                className="accent-primary mt-0.5"
              />
              <span className="flex-1">
                <span className="font-semibold">Also send by e-mail</span>
                <span className="block text-[11px] text-muted-foreground mt-0.5" data-testid="email-reach">
                  {!canEmail ? (
                    <span className="text-amber-700 dark:text-amber-300">E-mailing customers needs the marketing:send permission.</span>
                  ) : !mail.configured ? (
                    <span className="text-red-700 dark:text-red-300">E-mail is not configured ({mail.problem}).</span>
                  ) : category === 'MARKETING' && legalMissing.length ? (
                    <span className="text-red-700 dark:text-red-300">
                      Marketing e-mail must show who it is from — fill in {legalMissing.join(', ')} under Settings → Company.
                    </span>
                  ) : (
                    <>
                      Goes to <strong>{reach.emailable}</strong> of {recipients} via {mail.label}, in the background.
                      {category === 'MARKETING'
                        ? ` Only people who opted in (or, if allowed, customers who haven’t objected). Not e-mailed: ${reach.noConsent} without consent, ${reach.unsubscribed} unsubscribed, ${reach.notVerified} unverified, ${reach.placeholder} placeholder addresses. Each e-mail has an unsubscribe link.`
                        : ` Service notice: every verified account (${reach.notVerified} unverified and ${reach.placeholder} placeholder addresses skipped).`}
                    </>
                  )}
                </span>
              </span>
            </label>
          </div>
        </div>

        <aside className="lg:sticky lg:top-20 space-y-4">
          <p className="text-xs uppercase tracking-wider font-bold text-muted-foreground">Live preview</p>

          <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
              <Bell className="h-3 w-3" /> In-app notification
            </div>
            <article className="border border-border rounded-xl p-3 bg-background">
              <p className="text-[10px] uppercase tracking-wider font-bold text-primary inline-flex items-center gap-1">
                <KindIcon className="h-3 w-3" /> {kind.toLowerCase()}
              </p>
              <p className="font-bold text-sm mt-1 break-words">{title || <span className="text-muted-foreground italic">Title…</span>}</p>
              <p className="text-xs text-foreground/80 mt-1 whitespace-pre-wrap break-words">
                {body || <span className="text-muted-foreground italic">Message…</span>}
              </p>
              {href && <p className="text-[11px] text-primary mt-2 font-semibold truncate">→ {href}</p>}
            </article>
          </div>

          {email && emailPossible && (
            <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
                <Mail className="h-3 w-3" /> E-mail preview
              </div>
              <article className="border border-border rounded-xl bg-background overflow-hidden">
                <div className="border-b border-border p-3">
                  <p className="text-[10px] text-muted-foreground">Subject: <strong>{title || '(no subject)'}</strong></p>
                </div>
                <div className="p-3 text-xs">
                  <p className="font-bold text-primary mb-2">{title || 'Title'}</p>
                  <p>Hi [recipient name],</p>
                  <p className="whitespace-pre-wrap leading-relaxed mt-2">{body || 'Message…'}</p>
                  <p className="mt-3 border-t border-border pt-2 text-[10px] text-muted-foreground">
                    {category === 'MARKETING'
                      ? 'Why they get it (opt-in / customer) · Unsubscribe · E-mail preferences · company name, address, KvK, VAT'
                      : 'Service message · E-mail preferences · company name, address, KvK, VAT'}
                  </p>
                </div>
              </article>
            </div>
          )}

          <div className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 text-xs text-amber-900 dark:text-amber-300">
            <strong>About to send:</strong> {audienceLabel} · <strong className="tabular-nums">{recipients}</strong> in-app
            {email && emailPossible ? (
              <>
                {' '}· <strong className="tabular-nums">{reach.emailable}</strong> by e-mail
              </>
            ) : null}
            . Staff accounts never receive announcements. Once sent, notifications cannot be unsent.
          </div>
        </aside>
      </div>
      <div className="sticky bottom-3 z-10 flex items-center gap-3 flex-wrap bg-background/95 backdrop-blur p-3 rounded-2xl border border-border shadow-sm">
        <Button type="submit" size="lg" className="rounded-2xl font-semibold">
          <Megaphone className="h-4 w-4" /> Send
        </Button>
        <span className="text-xs text-muted-foreground">
          In-app notifications appear at once. E-mails are queued and sent in the background — progress is listed below.
        </span>
        <AdminActionStatus />
      </div>
    </AdminActionForm>
  );
}
