'use client';

import { useRouter } from 'next/navigation';
import { AdminActionForm, AdminActionStatus } from './AdminActionForm';

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
  return (
    <AdminActionForm
      action={action}
      className={className}
      confirmMessage={confirmText}
      statusInChildren
      onResult={(r) => {
        if (r.ok) router.refresh();
      }}
    >
      {children}
      <AdminActionStatus className={messageClassName} />
    </AdminActionForm>
  );
}
