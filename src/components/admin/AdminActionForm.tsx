'use client';

import { createContext, startTransition, useActionState, useContext, useEffect, useRef } from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { announceAdminResult } from './AdminResultToast';

export type AdminActionResult = { ok: boolean; message: string };

const StatusCtx = createContext<{ state: AdminActionResult | null; pending: boolean } | null>(null);

/**
 * Form wrapper for admin server actions that REPORT a result ({ok, message})
 * instead of throwing — production builds redact thrown server-action
 * messages to "An error occurred in the Server Components render", so an
 * expected validation failure must come back as data to be readable.
 *
 * Differences from a plain `<form action={…}>`:
 *  - the result message is shown inline (green / red) — at the end of the
 *    form, or wherever an <AdminActionStatus /> is placed inside it;
 *  - the form is NOT auto-reset after a failed submit, so a rejected save
 *    never wipes what the operator typed (React resets `action` forms after
 *    every submission). `resetOnSuccess` clears it only once a save landed;
 *  - optional `confirmMessage` asks before submitting (destructive / broadcast);
 *  - a result that arrives after the form has unmounted goes to the admin
 *    result toast instead of being lost (see below).
 */
export function AdminActionForm({
  action,
  children,
  className,
  confirmMessage,
  resetOnSuccess = false,
  statusInChildren = false,
  onResult,
}: {
  action: (formData: FormData) => Promise<AdminActionResult | void>;
  children: React.ReactNode;
  className?: string;
  confirmMessage?: string | ((formData: FormData) => string | null);
  resetOnSuccess?: boolean;
  /** true when the children render their own <AdminActionStatus />. */
  statusInChildren?: boolean;
  /** Called with each new result (e.g. to clear controlled inputs on success). */
  onResult?: (result: AdminActionResult) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  // Each result is handled once (onResult may be a new function every render).
  const handled = useRef<AdminActionResult | null>(null);
  // A server action that revalidates re-renders the page in the same response,
  // and that render can drop this form: a refunded order loses its "Order
  // actions" card, a delivered row its fulfilment form, a row leaves a filtered
  // list. The form then unmounts before it ever renders the result, so neither
  // the inline status nor the onResult effect runs and the operator sees
  // nothing. `latest` keeps the result from the moment the action resolves;
  // whichever comes second — the result or the unmount — hands an unshown
  // result to the admin-wide toast, which lives in the layout.
  const latest = useRef<AdminActionResult | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const r = latest.current;
      if (r && handled.current !== r) {
        handled.current = r;
        announceAdminResult(r);
      }
    };
  }, []);

  const [state, dispatch, pending] = useActionState(
    async (_prev: AdminActionResult | null, fd: FormData): Promise<AdminActionResult | null> => {
      let result: AdminActionResult | null;
      try {
        result = (await action(fd)) ?? null;
      } catch (e) {
        // redirect() / notFound() are control flow, not failures — let Next handle them.
        const digest = (e as { digest?: unknown })?.digest;
        if (typeof digest === 'string' && digest.startsWith('NEXT_')) throw e;
        result = { ok: false, message: 'Something went wrong on the server — nothing was changed. Try again, or check Admin → Errors.' };
      }
      latest.current = result;
      if (result && !mounted.current) {
        handled.current = result;
        announceAdminResult(result);
      }
      return result;
    },
    null,
  );

  useEffect(() => {
    if (!state || handled.current === state) return;
    handled.current = state;
    if (state.ok && resetOnSuccess) formRef.current?.reset();
    onResult?.(state);
  }, [state, resetOnSuccess, onResult]);

  return (
    <StatusCtx.Provider value={{ state, pending }}>
      <form
        ref={formRef}
        className={className}
        aria-busy={pending}
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
          const ask = typeof confirmMessage === 'function' ? confirmMessage(fd) : confirmMessage;
          if (ask && !window.confirm(ask)) return;
          startTransition(() => dispatch(fd));
        }}
      >
        {children}
        {!statusInChildren && <AdminActionStatus />}
      </form>
    </StatusCtx.Provider>
  );
}

/** Inline result of the enclosing <AdminActionForm> (renders nothing idle).
 *  `hideSuccess`: a success is reported elsewhere (the admin result toast). */
export function AdminActionStatus({ className = '', hideSuccess = false }: { className?: string; hideSuccess?: boolean }) {
  const ctx = useContext(StatusCtx);
  if (!ctx || (!ctx.pending && !ctx.state)) return null;
  if (hideSuccess && !ctx.pending && ctx.state?.ok) return null;
  const { state, pending } = ctx;
  return (
    <p
      role="status"
      className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
        pending
          ? 'text-muted-foreground'
          : state?.ok
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-red-600 dark:text-red-400'
      } ${className}`}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
      ) : state?.ok ? (
        <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 flex-shrink-0" />
      )}
      {pending ? 'Working…' : state?.message}
    </p>
  );
}
