import { Suspense } from 'react';
import { authCaptchaFlags } from '@/lib/security/captcha';
import { getSecurityPolicy } from '@/lib/security/policy';
import Inner from './Inner';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Forgot password',
};

export default async function ForgotPasswordPage() {
  const [captcha, policy] = await Promise.all([authCaptchaFlags(), getSecurityPolicy()]);
  return (
    <Suspense fallback={null}>
      <Inner captcha={captcha} mailCooldownSec={policy.MAIL_ADDRESS_COOLDOWN_SEC} />
    </Suspense>
  );
}
