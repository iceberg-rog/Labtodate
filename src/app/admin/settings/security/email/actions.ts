'use server';

import { revalidatePath } from 'next/cache';
import { requireSession, hasCapability } from '@/lib/auth-server';
import { audit } from '@/lib/observability';
import { releaseAddress, suppressAddress } from '@/lib/email-guard';

const ADDRESS = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

/** Admin → Security → E-mail protection: stop or release one address. Needs security:manage. */
export async function changeSuppression(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin/settings/security/email' });
  if (!(await hasCapability('security:manage'))) {
    return { ok: false, message: 'Changing the suppression list needs the security:manage permission.' };
  }
  const address = String(formData.get('address') ?? '').trim().toLowerCase();
  const op = String(formData.get('op') ?? '');
  if (!ADDRESS.test(address) || address.length > 254) return { ok: false, message: `“${address}” is not an e-mail address.` };
  if (op === 'release') {
    await releaseAddress(address);
    await audit('email.released', address, 'e-mail to this address allowed again (limits reset)');
    revalidatePath('/admin/settings/security/email');
    return { ok: true, message: `${address} can receive e-mail again.` };
  }
  if (op === 'suppress') {
    await suppressAddress(address);
    await audit('email.suppressed', address, 'stopped by an admin');
    revalidatePath('/admin/settings/security/email');
    return { ok: true, message: `No more e-mail goes to ${address}.` };
  }
  return { ok: false, message: 'Unknown action.' };
}
