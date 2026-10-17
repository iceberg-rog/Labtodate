'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, ShieldCheck, LogOut, User as UserIcon, Loader2 } from 'lucide-react';
import { authClient, useSession } from '@/lib/auth-client';

export function HeaderUserMenu() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Mount gate: better-auth's useSession reads the cookie cache synchronously
  // on the client, so its first client render disagrees with the server
  // render (server has no cookie → pending=true). Forcing the first client
  // render to match the server (spinner) eliminates the hydration mismatch.
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!mounted || isPending) {
    return <div className="h-10 w-10 flex items-center justify-center text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  }

  if (!session) {
    return (
      <div className="flex items-center gap-2">
        {/* One lime "Sign in" pill (the redesign); account creation is one
            click further, on the sign-in page and in the phone menu. */}
        <Link
          href="/auth/sign-in"
          className="btn-lime hidden sm:inline-flex h-11 items-center gap-2 rounded-full pl-4 pr-5 text-sm font-semibold"
        >
          <UserIcon className="h-4 w-4" strokeWidth={2.2} />
          Sign in
        </Link>
      </div>
    );
  }

  const role = (session.user as { role?: string }).role || 'BUYER';
  const initials = (session.user.name || session.user.email)
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  async function handleSignOut() {
    await authClient.signOut();
    setOpen(false);
    router.push('/');
    router.refresh();
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-10 w-10 rounded-full bg-primary/10 text-primary text-sm font-semibold hover:bg-primary/15 transition-colors flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        aria-label="Account menu"
        aria-expanded={open}
      >
        {initials}
      </button>

      {open && (
        <>
          {/* Tap-anywhere-to-close backdrop. Stays subtle on desktop, helps
              the user understand the menu is a modal pop-up rather than
              part of the page (was confusing when it landed on top of a
              list row and hid the row's status/amount). */}
          <div
            className="fixed inset-0 z-40 bg-black/10"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 top-12 w-64 rounded-xl border bg-card shadow-2xl z-50 overflow-hidden ring-1 ring-black/5">
            {/* prevent backdrop's click from bubbling and closing immediately when interacting inside the panel */}
          <div className="px-4 py-3 border-b">
            <p className="text-sm font-semibold truncate">{session.user.name}</p>
            <p className="text-xs text-muted-foreground truncate">{session.user.email}</p>
            <p className="text-[10px] font-bold uppercase tracking-wider text-accent mt-1">{role}</p>
          </div>

          <nav className="py-1 text-sm">
            <Link href="/app" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 hover:bg-muted">
              <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
              Dashboard
            </Link>
            {role === 'ADMIN' && (
              <Link href="/admin" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 hover:bg-muted">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                Admin
              </Link>
            )}
            <Link href="/app/profile" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 hover:bg-muted">
              <UserIcon className="h-4 w-4 text-muted-foreground" />
              Profile
            </Link>
          </nav>

          <div className="border-t py-1">
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-left hover:bg-muted text-red-600 dark:text-red-400"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
          </div>
        </>
      )}
    </div>
  );
}
