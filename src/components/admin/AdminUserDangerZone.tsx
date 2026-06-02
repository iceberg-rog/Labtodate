'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ShieldOff,
  Trash2,
  KeyRound,
  AlertOctagon,
  Loader2,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  suspendUser,
  deleteUser,
  adminSendPasswordReset,
} from '@/app/admin/actions';

export function AdminUserDangerZone({
  userId,
  email,
  suspended,
  isAdmin,
}: {
  userId: string;
  email: string;
  suspended: boolean;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [resetRes, setResetRes] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [openDelete, setOpenDelete] = useState(false);
  const [openSuspend, setOpenSuspend] = useState(false);
  const [reason, setReason] = useState('');

  function triggerReset() {
    setResetRes(null);
    start(async () => {
      const fd = new FormData();
      fd.set('userId', userId);
      const r = await adminSendPasswordReset(fd);
      setResetRes(r);
    });
  }

  return (
    <div className="rounded-2xl border border-red-200 bg-red-50/40 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <AlertOctagon className="h-4 w-4 text-red-700" />
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-red-700">
          Account actions
        </h2>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        {/* Reset password */}
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm font-bold inline-flex items-center gap-1.5">
            <KeyRound className="h-4 w-4 text-primary" /> Password reset
          </p>
          <p className="text-xs text-muted-foreground mt-1 mb-3">
            Emails a fresh reset link to <strong className="text-foreground">{email}</strong>. Link expires in 1 hour.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={triggerReset}
            className="rounded-full font-medium w-full"
          >
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            Send reset email
          </Button>
          {resetRes && (
            <p className={`mt-2 text-[11px] inline-flex items-center gap-1 ${resetRes.ok ? 'text-emerald-700' : 'text-red-700'}`}>
              {resetRes.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
              {resetRes.message}
            </p>
          )}
        </div>

        {/* Suspend */}
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm font-bold inline-flex items-center gap-1.5">
            <ShieldOff className="h-4 w-4 text-amber-600" /> Suspend
          </p>
          <p className="text-xs text-muted-foreground mt-1 mb-3">
            Reversible block — wipes their sessions and stops sign-in until lifted. {suspended && <strong className="text-amber-700">Already suspended.</strong>}
          </p>
          {!suspended && (
            <>
              {!openSuspend ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpenSuspend(true)}
                  className="rounded-full font-medium w-full text-amber-700"
                >
                  <ShieldOff className="h-3.5 w-3.5" /> Suspend account
                </Button>
              ) : (
                <form
                  action={(fd) => {
                    start(async () => {
                      fd.set('userId', userId);
                      fd.set('reason', reason);
                      await suspendUser(fd);
                      setOpenSuspend(false);
                      setReason('');
                      router.refresh();
                    });
                  }}
                  className="space-y-2"
                >
                  <input
                    name="reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason (shown on sign-in error)"
                    maxLength={240}
                    className="w-full h-9 px-3 rounded-lg border border-input bg-background text-xs"
                  />
                  <div className="flex items-center gap-2">
                    <Button type="submit" size="sm" disabled={pending} className="rounded-full font-medium flex-1 bg-amber-600 hover:bg-amber-700 text-white">
                      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      Confirm suspend
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpenSuspend(false)}
                      className="rounded-full font-medium"
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </>
          )}
        </div>

        {/* Delete */}
        <div className="rounded-xl border border-red-200 bg-card p-4">
          <p className="text-sm font-bold inline-flex items-center gap-1.5">
            <Trash2 className="h-4 w-4 text-red-700" /> Delete forever
          </p>
          <p className="text-xs text-muted-foreground mt-1 mb-3">
            Permanent. Removes sessions, wishlist, cart, notifications, reviews. Order/ticket history is retained for audit.
          </p>
          {!openDelete ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpenDelete(true)}
              className="rounded-full font-medium w-full text-red-700"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete account…
            </Button>
          ) : (
            <form
              action={(fd) => {
                start(async () => {
                  fd.set('userId', userId);
                  fd.set('confirmEmail', confirmEmail);
                  try {
                    await deleteUser(fd);
                    router.push('/admin/users');
                  } catch (e) {
                    alert(e instanceof Error ? e.message : 'Delete failed');
                  }
                });
              }}
              className="space-y-2"
            >
              <input
                name="confirmEmail"
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                placeholder={`Type "${email}" to confirm`}
                className="w-full h-9 px-3 rounded-lg border border-red-200 bg-background text-xs"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={pending || confirmEmail.toLowerCase() !== email.toLowerCase()}
                  className="rounded-full font-medium flex-1 bg-red-600 hover:bg-red-700 text-white disabled:opacity-50"
                >
                  {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Delete forever
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setOpenDelete(false);
                    setConfirmEmail('');
                  }}
                  className="rounded-full font-medium"
                >
                  Cancel
                </Button>
              </div>
              {isAdmin && (
                <p className="text-[11px] text-amber-700">
                  This is an admin account. Deletion will be refused if they&apos;re the last active admin.
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
