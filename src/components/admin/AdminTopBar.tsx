'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ShieldCheck, ExternalLink, LogOut, Loader2 } from 'lucide-react';
import { authClient } from '@/lib/auth-client';
import { AdminNotificationBell } from './AdminNotificationBell';
import { EmailText } from '@/components/util/EmailText';

export function AdminTopBar({ email, unreadCount }: { email: string; unreadCount: number }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await authClient.signOut();
    } catch {
      /* ignore */
    }
    router.replace('/');
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="px-6 h-14 flex items-center gap-4">
        <Link href="/admin" className="flex items-center gap-2 group">
          <span className="font-bold tracking-tight group-hover:text-primary transition-colors">
            lab2date
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
            <ShieldCheck className="h-3 w-3" /> Admin
          </span>
        </Link>

        <div className="flex-1" />

        <Link
          href="/"
          target="_blank"
          className="hidden sm:inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          View site <ExternalLink className="h-3 w-3" />
        </Link>

        <AdminNotificationBell initialCount={unreadCount} />

        <EmailText
          email={email}
          className="hidden md:inline text-xs text-muted-foreground truncate max-w-[220px]"
        />

        <button
          type="button"
          onClick={signOut}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
          Sign out
        </button>
      </div>
    </header>
  );
}
