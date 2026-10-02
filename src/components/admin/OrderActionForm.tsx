'use client';

import { useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';

type Result = { ok: boolean; message: string } | null;

/**
 * <form> wrapper for admin order actions that return `{ ok, message }`.
 * Production builds redact errors thrown from server actions ("An error
 * occurred in the Server Components render"), so these actions RETURN their
 * failures and this wrapper shows the message right by the controls. After a
 * successful action the page data is refreshed.
 *
 * `confirmText` adds a confirmation step (for refund / cancel / delete).
 */
export function OrderActionForm({
  action,
  className,
  messageClassName,
  confirmText,
  children,
}: {
  action: (formData: FormData) => Promise<{ ok: boolean; message: string }>;
  className?: string;
  messageClassName?: string;
  confirmText?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<Result, FormData>(async (_prev, fd) => {
    try {
      const r = await action(fd);
      if (r?.ok) router.refresh();
      return r ?? { ok: false, message: 'No response — refresh to check the current state.' };
    } catch {
      return { ok: false, message: 'Something went wrong — refresh to check what was saved, then try again.' };
    }
  }, null);

  return (
    <form
      action={formAction}
      className={className}
      aria-busy={pending}
      onSubmit={
        confirmText
          ? (e) => {
              // Cancelling the native submit also cancels the form action.
              if (!window.confirm(confirmText)) e.preventDefault();
            }
          : undefined
      }
    >
      {children}
      {(pending || state) && (
        <p
          role="status"
          className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
            pending
              ? 'text-muted-foreground'
              : state?.ok
                ? 'text-emerald-700 dark:text-emerald-300'
                : 'text-red-700 dark:text-red-300'
          } ${messageClassName ?? ''}`}
        >
          {pending ? (
            <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…</>
          ) : state?.ok ? (
            <><CheckCircle2 className="h-3.5 w-3.5" /> {state.message}</>
          ) : (
            <><XCircle className="h-3.5 w-3.5" /> {state?.message}</>
          )}
        </p>
      )}
    </form>
  );
}
