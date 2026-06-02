'use client';

import { useState, useTransition } from 'react';
import { Loader2, ArrowRight, UserCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { submitTicketAndRedirect } from '@/lib/support/actions';

const CATEGORIES = ['General', 'Order / delivery', 'Quote / pricing', 'Selling', 'Technical', 'Billing'];

export function SupportForm({
  defaultEmail = '',
  defaultName = '',
  signedIn = false,
}: {
  defaultEmail?: string;
  defaultName?: string;
  signedIn?: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handle(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const input = {
      name: signedIn ? defaultName : String(fd.get('name') ?? ''),
      email: signedIn ? defaultEmail : String(fd.get('email') ?? ''),
      subject: String(fd.get('subject') ?? ''),
      category: (fd.get('category') as string) || null,
      body: String(fd.get('body') ?? ''),
      hp: String(fd.get('company_website') ?? ''),
    };
    start(async () => {
      try {
        await submitTicketAndRedirect(input);
      } catch (err) {
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        setError(err instanceof Error ? err.message : 'Could not submit');
      }
    });
  }

  const f =
    'w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary';

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
            <span className="block text-sm font-semibold mb-1.5">Your name <span className="text-red-600">*</span></span>
            <input name="name" required minLength={2} placeholder="Dr. Jane Doe" className={`${f} h-10`} />
          </label>
          <label className="block">
            <span className="block text-sm font-semibold mb-1.5">Email <span className="text-red-600">*</span></span>
            <input name="email" type="email" required defaultValue={defaultEmail} placeholder="you@lab.com" className={`${f} h-10`} />
          </label>
        </div>
      )}
      <div className="grid sm:grid-cols-[2fr_1fr] gap-4">
        <label className="block">
          <span className="block text-sm font-semibold mb-1.5">Subject <span className="text-red-600">*</span></span>
          <input name="subject" required minLength={3} placeholder="Question about my order L2D-…" className={`${f} h-10`} />
        </label>
        <label className="block">
          <span className="block text-sm font-semibold mb-1.5">Topic</span>
          <select name="category" defaultValue="General" className={`${f} h-10`}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <input
        type="text"
        name="company_website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0 opacity-0"
      />
      <label className="block">
        <span className="block text-sm font-semibold mb-1.5">How can we help? <span className="text-red-600">*</span></span>
        <textarea name="body" required minLength={10} rows={6} placeholder="Describe your question or issue…" className={f} />
      </label>
      {error && <p className="rounded-md border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{error}</p>}
      <Button type="submit" size="lg" disabled={pending} className="rounded-2xl font-semibold w-full">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Submit ticket <ArrowRight className="h-4 w-4" /></>}
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        You&apos;ll get a reference number by email and our reply within 1 business day.
      </p>
    </form>
  );
}
