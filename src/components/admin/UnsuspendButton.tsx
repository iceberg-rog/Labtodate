'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MaybeStepUp } from '@/components/security/useStepUp';

/** "Lift suspension" with the server's answer shown (refusals used to vanish). */
export function UnsuspendButton({ userId, action }: { userId: string; action: (fd: FormData) => Promise<MaybeStepUp> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<MaybeStepUp | null>(null);
  return (
    <div className="mt-3 space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        className="rounded-full font-medium"
        onClick={() =>
          start(async () => {
            const fd = new FormData();
            fd.set('userId', userId);
            const r = await action(fd).catch(() => ({ ok: false, message: 'Failed — please try again.' }));
            setMsg(r);
            if (r.ok) router.refresh();
          })
        }
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Lift suspension
      </Button>
      {msg && !msg.ok && <p role="alert" className="text-xs font-semibold text-red-700 dark:text-red-300">{msg.message}</p>}
    </div>
  );
}
