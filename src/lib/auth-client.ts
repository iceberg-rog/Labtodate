'use client';

import { createAuthClient } from 'better-auth/react';
import { magicLinkClient, inferAdditionalFields } from 'better-auth/client/plugins';
import type { auth } from './auth';

export const authClient = createAuthClient({
  // Host-agnostic: in the browser always talk to the same origin the page
  // is served from, so auth works under any domain/tunnel without a rebuild.
  // (NEXT_PUBLIC_* is inlined at build time and would otherwise be stale.)
  baseURL:
    typeof window !== 'undefined'
      ? window.location.origin
      : process.env.NEXT_PUBLIC_BETTER_AUTH_URL || undefined,
  plugins: [
    magicLinkClient(),
    inferAdditionalFields<typeof auth>(),
  ],
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
