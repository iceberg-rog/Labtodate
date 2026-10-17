'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { saveMarketingPreference } from './actions';

export function MarketingToggle({ receiving }: { receiving: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  // Shows the new choice at once; reverts if saving fails.
  const [on, setOn] = useState(receiving);
  useEffect(() => setOn(receiving), [receiving]);
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <label className="inline-flex items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          name="marketing"
          checked={on}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            setMsg(null);
            start(async () => {
              const r = await saveMarketingPreference(next).catch(() => ({ ok: false, message: 'Saving failed — try again.' }));
              setMsg(r);
              if (!r.ok) setOn(!next);
              router.refresh();
            });
          }}
          className="h-4 w-4 accent-primary"
        />
        Send me offers and news by e-mail
      </label>
      {pending && <Loader2 className="h-4 w-4 animate-spin" />}
      {msg && (
        <span role="status" className={`text-xs font-semibold ${msg.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-600 dark:text-red-400'}`}>
          {msg.message}
        </span>
      )}
    </div>
  );
}
