import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/auth-server';

export const dynamic = 'force-dynamic';

/**
 * Post-login landing dispatcher. Sends ADMINs straight to the admin dashboard
 * and everyone else to the buyer/seller app. Used as the default post-login
 * target (password + magic link) so an admin no longer lands on /app and has to
 * click through to /admin. An explicit `?redirect=` on sign-in still wins — this
 * only handles the default "just log me in" case.
 */
export default async function AuthContinuePage() {
  const session = await getServerSession();
  if (!session) redirect('/auth/sign-in');
  const role = (session.user as { role?: string }).role;
  redirect(role === 'ADMIN' ? '/admin' : '/app');
}
