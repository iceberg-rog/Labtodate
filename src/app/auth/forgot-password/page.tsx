import { Suspense } from 'react';
import { authCaptchaFlags } from '@/lib/security/captcha';
import Inner from './Inner';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Forgot password',
};

export default async function ForgotPasswordPage() {
  const captcha = await authCaptchaFlags();
  return (
    <Suspense fallback={null}>
      <Inner captcha={captcha} />
    </Suspense>
  );
}
