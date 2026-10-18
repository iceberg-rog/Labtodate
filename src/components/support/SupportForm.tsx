'use client';

import { useState, useTransition } from 'react';
import { Loader2, ArrowRight, UserCircle2, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { submitTicketAndRedirect } from '@/lib/support/actions';
import { CAPTCHA_NOT_SOLVED, useCaptcha } from '@/components/security/Captcha';

type Att = { url: string; name: string };
export type SupportOrderOption = { orderNumber: string; label: string };

const MAX_FILES = 5;

/**
 * The new-ticket form (/support and /contact). Topics come from Settings →
 * Support; signed-in customers pick one of their own orders (?order=<number>
 * preselects it) and the ticket uses the account's name and e-mail. Photos
 * and PDFs go through the same private upload as ticket replies.
 */
export function SupportForm({
  defaultEmail = '',
  defaultName = '',
  signedIn = false,
  captcha: captchaOn = false,
  topics,
  defaultTopic,
  orders = [],
  defaultOrder = '',
  defaultSubject = '',
  replyPromise = '',
}: {
  defaultEmail?: string;
  defaultName?: string;
  signedIn?: boolean;
  /** Bot check (Settings → Security; guests by default). */
  captcha?: boolean;
  /** Topic choices (Settings → Support); the server accepts only these. */
  topics: string[];
  defaultTopic?: string;
  /** The signed-in customer's own orders, newest first. */
  orders?: SupportOrderOption[];
  defaultOrder?: string;
  defaultSubject?: string;
  /** "1 business day" (Settings → Support); '' = no promise shown. */
  replyPromise?: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [atts, setAtts] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const captcha = useCaptcha('support', { required: captchaOn, start: 'focus' });

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setError(null);
    const room = Math.max(0, MAX_FILES - atts.length);
    if (files.length > room) {
      setError(`You can attach up to ${MAX_FILES} files${room > 0 ? ` — only the first ${room} were added` : ''}.`);
    }
    setUploading(true);
    try {
      for (const f of files.slice(0, room)) {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/attachment-upload', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(`${f.name}: ${data.error || 'upload failed.'}`);
          continue;
        }
        if (data.url) setAtts((p) => (p.length < MAX_FILES ? [...p, { url: data.url, name: data.name ?? f.name }] : p));
      }
    } catch {
      setError('Upload failed — check your connection and try again.');
    } finally {
      setUploading(false);
    }
  }

  function handle(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const input = {
      // Signed in: the server uses the account's name and e-mail.
      name: signedIn ? defaultName : String(fd.get('name') ?? ''),
      email: signedIn ? defaultEmail : String(fd.get('email') ?? ''),
      subject: String(fd.get('subject') ?? ''),
      category: (fd.get('category') as string) || null,
      body: String(fd.get('body') ?? ''),
      orderNumber: signedIn ? (String(fd.get('orderNumber') ?? '') || null) : null,
      attachments: atts.map((a) => a.url),
      attachmentNames: atts.map((a) => a.name),
      hp: String(fd.get('company_website') ?? ''),
    };
    start(async () => {
      try {
        const token = await captcha.token();
        if (token === null) {
          setError(CAPTCHA_NOT_SOLVED);
          return;
        }
        const res = await submitTicketAndRedirect({ ...input, ...(token ? { captcha: token } : {}) });
        if (token) captcha.reset();
        if (res?.captcha) captcha.require();
        // Not sent: the typed text and the files stay in the form.
        if (res?.error) setError(res.error);
      } catch (err) {
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        // Network failure, or a page loaded before a site update.
        setError('Your ticket was not sent. Reload the page and try again.');
      }
    });
  }

  const f =
    'w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';
  const topic = topics.find((t) => t.toLowerCase() === (defaultTopic ?? '').toLowerCase()) ?? topics[0];
  const order = orders.some((o) => o.orderNumber === defaultOrder) ? defaultOrder : '';

  return (
    <form onSubmit={handle} className="rounded-2xl border border-border bg-card p-6 md:p-8 space-y-4 shadow-sm">
      {signedIn ? (
        <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 inline-flex items-center gap-2 w-full">
          <UserCircle2 className="h-4 w-4 text-primary shrink-0" />
          <p className="text-[12px] text-primary">
            Signed in as <span className="font-semibold">{defaultName || defaultEmail}</span>
            {defaultName && <span className="text-muted-foreground"> · {defaultEmail}</span>}
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-sm font-semibold mb-1.5">Your name <span className="text-red-600 dark:text-red-400">*</span></span>
            <input name="name" required minLength={2} maxLength={120} placeholder="Dr. Jane Doe" className={`${f} h-10`} />
          </label>
          <label className="block">
            <span className="block text-sm font-semibold mb-1.5">Email <span className="text-red-600 dark:text-red-400">*</span></span>
            <input name="email" type="email" required defaultValue={defaultEmail} placeholder="you@lab.com" className={`${f} h-10`} />
          </label>
        </div>
      )}
      <div className="grid sm:grid-cols-[2fr_1fr] gap-4">
        <label className="block">
          <span className="block text-sm font-semibold mb-1.5">Subject <span className="text-red-600 dark:text-red-400">*</span></span>
          <input name="subject" required minLength={3} maxLength={160} defaultValue={defaultSubject} placeholder="Question about my order L2D-…" className={`${f} h-10`} />
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1.5">Topic</span>
          <select name="category" defaultValue={topic} className={`${f} h-10`}>
            {topics.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      {signedIn && orders.length > 0 && (
        <label className="block">
          <span className="block text-sm font-semibold mb-1.5">About an order</span>
          <select name="orderNumber" defaultValue={order} className={`${f} h-10`}>
            <option value="">Not about a specific order</option>
            {orders.map((o) => <option key={o.orderNumber} value={o.orderNumber}>{o.label}</option>)}
          </select>
        </label>
      )}
      <input
        type="text"
        name="company_website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0 opacity-0"
      />
      <label className="block">
        <span className="block text-sm font-semibold mb-1.5">How can we help? <span className="text-red-600 dark:text-red-400">*</span></span>
        <textarea name="body" required minLength={10} maxLength={5000} rows={6} placeholder="Describe your question or issue…" className={f} />
      </label>
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <label className={`inline-flex items-center gap-2 h-10 px-3 rounded-lg border border-input bg-background text-sm font-semibold ${atts.length >= MAX_FILES || uploading ? 'opacity-60' : 'cursor-pointer hover:bg-muted'}`}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <Paperclip className="h-4 w-4 text-muted-foreground" />}
            Attach photos or PDFs
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
              multiple
              className="hidden"
              onChange={onFiles}
              disabled={uploading || atts.length >= MAX_FILES}
            />
          </label>
          <span className="text-xs text-muted-foreground">Optional · up to {MAX_FILES} files, 10 MB each</span>
        </div>
        {atts.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {atts.map((a, i) => (
              <span key={a.url} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs">
                <Paperclip className="h-3 w-3" />
                <span className="max-w-[180px] truncate">{a.name}</span>
                <button type="button" onClick={() => setAtts((p) => p.filter((_, j) => j !== i))} aria-label={`Remove ${a.name}`}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      {captcha.widget}
      {error && <p role="alert" className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 px-3 py-2 text-sm">{error}</p>}
      <Button type="submit" size="lg" disabled={pending || uploading} className="rounded-2xl font-semibold w-full">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Submit ticket <ArrowRight className="h-4 w-4" /></>}
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        {replyPromise
          ? <>You&apos;ll get a reference number by email and our reply within {replyPromise}.</>
          : <>You&apos;ll get a reference number by email and our reply by email.</>}
      </p>
    </form>
  );
}
