'use client';

import { useRouter } from 'next/navigation';
import { AdminActionForm, AdminActionStatus } from './AdminActionForm';
import { announceAdminResult } from './AdminResultToast';

/**
 * <form> wrapper for admin order actions that return `{ ok, message }`.
 * Production builds redact errors thrown from server actions ("An error
 * occurred in the Server Components render"), so these actions RETURN their
 * failures and this wrapper shows the message right by the controls. After a
 * successful action the page data is refreshed.
 *
 * Built on the shared <AdminActionForm>, so order forms behave like every
 * other admin form: a rejected save keeps what the operator typed (no form
 * reset), a second submit while one is in flight is ignored, and the result
 * renders through <AdminActionStatus>.
 *
 * `confirmText` adds a confirmation step (for refund / cancel / delete).
 *
 * `announce`: report a success in the admin-wide toast instead of inline — for
 * forms that may disappear once the action lands (a refunded order loses its
 * "Order actions" card, a moved row leaves a filtered list), so every outcome
 * of that control reads the same. When the form is already gone by the time
 * the result arrives, <AdminActionForm> hands it to the toast itself (with or
 * without `announce`).
 */
export function OrderActionForm({
  action,
  className,
  messageClassName,
  confirmText,
  announce = false,
  children,
}: {
  action: (formData: FormData) => Promise<{ ok: boolean; message: string }>;
  className?: string;
  messageClassName?: string;
  confirmText?: string;
  announce?: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <AdminActionForm
      action={action}
      className={className}
      confirmMessage={confirmText}
      statusInChildren
      onResult={(r) => {
        if (r.ok && announce) announceAdminResult(r);
        if (r.ok) router.refresh();
      }}
    >
      {children}
      <AdminActionStatus className={messageClassName} hideSuccess={announce} />
    </AdminActionForm>
  );
}
