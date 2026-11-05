'use client';

import { deleteMyAccount } from '@/lib/account/actions';

const NOTICE: Record<string, string> = {
  confirm: 'Tick the box to confirm you understand this is permanent.',
  orders: 'You have an order that is still being handled (payment under review, paid or shipped). Wait until it is delivered, or contact support.',
  admin: 'Admin accounts cannot delete themselves. Ask another admin to remove your access.',
};

/** Profile → Delete account (GDPR right to erasure). */
export function DeleteAccountForm({ notice }: { notice?: string }) {
  return (
    <form
      action={deleteMyAccount}
      onSubmit={(e) => {
        if (!window.confirm('Delete your account permanently? You will be signed out and cannot sign in again with this email.')) {
          e.preventDefault();
        }
      }}
      className="rounded-2xl border border-red-200 dark:border-red-900 bg-card p-6 space-y-4"
    >
      <div>
        <h2 className="font-bold">Delete account</h2>
        <p className="text-sm text-muted-foreground">
          Removes your personal data and signs you out everywhere. Orders and invoices are kept anonymised because tax law
          requires it. This cannot be undone.
        </p>
      </div>
      {notice && NOTICE[notice] && (
        <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 dark:text-red-300 dark:bg-red-950/40 dark:border-red-800">
          {NOTICE[notice]}
        </p>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirm" className="mt-1" required />
        <span>I understand that my account is deleted permanently.</span>
      </label>
      <button
        type="submit"
        className="inline-flex items-center rounded-full border border-red-300 dark:border-red-800 px-4 py-2 text-sm font-semibold text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40"
      >
        Delete my account
      </button>
    </form>
  );
}
