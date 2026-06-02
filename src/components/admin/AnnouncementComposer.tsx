'use client';

import { useState } from 'react';
import { Bell, Mail, Megaphone, Sparkles, AlertOctagon } from 'lucide-react';

type Audience = 'ALL' | 'BUYER' | 'SELLER';
type Kind = 'OFFER' | 'ANNOUNCEMENT' | 'SYSTEM';

const TEMPLATES: { name: string; title: string; body: string; kind: Kind; href: string }[] = [
  {
    name: 'Weekend promo',
    title: '20% off all Agilent HPLC parts this weekend',
    body: 'For the next 72 hours, use code LAB20 at checkout. Applies to all Agilent HPLC consumables in our catalogue.',
    kind: 'OFFER',
    href: '/marketplace?category=hplc-lc',
  },
  {
    name: 'New arrivals',
    title: 'Fresh inventory: refurbished centrifuges in stock',
    body: 'Twelve newly certified-refurbished benchtop and floor-standing centrifuges just landed. Limited units per model — typically gone within a week.',
    kind: 'ANNOUNCEMENT',
    href: '/marketplace?category=centrifuges',
  },
  {
    name: 'Maintenance window',
    title: 'Scheduled maintenance · Saturday 02:00 UTC',
    body: 'lab2date will be in read-only mode for ~20 minutes while we ship a database upgrade. No data loss; checkout will pause briefly.',
    kind: 'SYSTEM',
    href: '',
  },
];

export function AnnouncementComposer({
  audienceCounts,
  resendConfigured,
}: {
  audienceCounts: { ALL: number; BUYER: number; SELLER: number };
  resendConfigured: boolean;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<Kind>('OFFER');
  const [audience, setAudience] = useState<Audience>('ALL');
  const [href, setHref] = useState('');
  const [email, setEmail] = useState(true);

  function apply(t: (typeof TEMPLATES)[number]) {
    setTitle(t.title);
    setBody(t.body);
    setKind(t.kind);
    setHref(t.href);
  }

  const recipients = audienceCounts[audience];
  const KindIcon = kind === 'OFFER' ? Sparkles : kind === 'ANNOUNCEMENT' ? Megaphone : AlertOctagon;

  const field =
    'w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

  return (
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
              placeholder="20% off all Agilent HPLC parts this week"
              className={`${field} h-10`}
            />
            <span className="text-[11px] text-muted-foreground mt-1 block tabular-nums">
              {title.length} / 140
            </span>
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
                <option value="OFFER">Offer (with badge)</option>
                <option value="ANNOUNCEMENT">Announcement (neutral)</option>
                <option value="SYSTEM">System notice (urgent)</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">Audience</span>
              <select name="audience" value={audience} onChange={(e) => setAudience(e.target.value as Audience)} className={`${field} h-10`}>
                <option value="ALL">Everyone ({audienceCounts.ALL})</option>
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
          <label className="flex items-start gap-2 text-sm pt-1">
            <input
              type="checkbox"
              name="email"
              checked={email}
              onChange={(e) => setEmail(e.target.checked)}
              className="accent-primary mt-0.5"
            />
            <span className="flex-1">
              <span className="font-semibold">Also send by email</span>
              <span className="block text-[11px] text-muted-foreground mt-0.5">
                {resendConfigured ? (
                  <>Will deliver via Resend to <strong>{recipients}</strong> recipient{recipients === 1 ? '' : 's'}.</>
                ) : (
                  <span className="text-amber-700">Resend key not configured — emails will hit the dev mailbox only.</span>
                )}
              </span>
            </span>
          </label>
        </div>
      </div>

      <aside className="lg:sticky lg:top-20 space-y-4">
        <p className="text-xs uppercase tracking-wider font-bold text-muted-foreground">
          Live preview
        </p>

        <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
            <Bell className="h-3 w-3" /> In-app notification
          </div>
          <article className="border border-border rounded-xl p-3 bg-background">
            <p className="text-[10px] uppercase tracking-wider font-bold text-primary inline-flex items-center gap-1">
              <KindIcon className="h-3 w-3" /> {kind.toLowerCase()}
            </p>
            <p className="font-bold text-sm mt-1 break-words">
              {title || <span className="text-muted-foreground italic">Title…</span>}
            </p>
            <p className="text-xs text-foreground/80 mt-1 whitespace-pre-wrap break-words">
              {body || <span className="text-muted-foreground italic">Message…</span>}
            </p>
            {href && (
              <p className="text-[11px] text-primary mt-2 font-semibold truncate">→ {href}</p>
            )}
          </article>
        </div>

        {email && (
          <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">
              <Mail className="h-3 w-3" /> Email preview
            </div>
            <article className="border border-border rounded-xl bg-background overflow-hidden">
              <div className="border-b border-border p-3">
                <p className="text-[10px] text-muted-foreground">From: <strong>lab2date</strong> &lt;notifications@lab2date&gt;</p>
                <p className="text-[10px] text-muted-foreground">Subject: <strong>{title || '(no subject)'}</strong></p>
              </div>
              <div className="p-3 text-xs">
                <p className="font-bold text-primary mb-2">{title || 'Title'}</p>
                <p>Hi [recipient name],</p>
                <p className="whitespace-pre-wrap leading-relaxed mt-2">{body || 'Message…'}</p>
                <div className="mt-3">
                  <span className="inline-block bg-primary text-primary-foreground px-3 py-1.5 rounded-md text-[11px] font-bold">
                    View on lab2date
                  </span>
                </div>
              </div>
            </article>
          </div>
        )}

        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <strong>About to send:</strong> {audience === 'ALL' ? 'every registered user' : audience === 'BUYER' ? 'buyers only' : 'internal suppliers only'} ·{' '}
          <strong className="tabular-nums">{recipients}</strong> recipient{recipients === 1 ? '' : 's'}.
          Once sent, notifications cannot be unsent.
        </div>
      </aside>
    </div>
  );
}
