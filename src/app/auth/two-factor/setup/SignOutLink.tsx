'use client';

import { useRouter } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

export function SignOutLink() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="underline underline-offset-2 hover:text-foreground"
      onClick={async () => {
        await authClient.signOut().catch(() => {});
        router.push('/');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
