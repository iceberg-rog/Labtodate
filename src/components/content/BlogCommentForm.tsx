'use client';

import { useRef, useState, useTransition } from 'react';
import { Send, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { submitBlogComment } from '@/lib/blog/actions';

export function BlogCommentForm({ postId }: { postId: string }) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [res, setRes] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <form
      ref={ref}
      action={(fd: FormData) =>
        start(async () => {
          const r = await submitBlogComment(fd);
          setRes(r);
          if (r.ok) ref.current?.reset();
        })
      }
      className="rounded-2xl border border-border bg-card p-5 space-y-3"
    >
      <input type="hidden" name="postId" value={postId} />
      {/* honeypot */}
      <input type="text" name="website" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden />

      <div className="grid sm:grid-cols-2 gap-3">
        <input
          name="authorName"
          required
          minLength={2}
          maxLength={80}
          placeholder="Your name"
          className="h-10 px-3 rounded-lg border border-input bg-background text-sm"
        />
        <input
          name="authorEmail"
          type="email"
          required
          placeholder="you@example.com (not published)"
          className="h-10 px-3 rounded-lg border border-input bg-background text-sm"
        />
      </div>
      <textarea
        name="body"
        required
        minLength={3}
        maxLength={2000}
        rows={4}
        placeholder="Share your thoughts…"
        className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm"
      />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-1.5 h-10 px-4 rounded-full bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Post comment
        </button>
        {res && (
          <span
            className={`inline-flex items-center gap-1.5 text-xs font-medium ${
              res.ok ? 'text-emerald-600' : 'text-red-600'
            }`}
          >
            {res.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {res.message}
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Comments are held for moderation. We never publish your email.
      </p>
    </form>
  );
}
