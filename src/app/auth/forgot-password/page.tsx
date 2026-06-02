import { Suspense } from 'react';
import Inner from './Inner';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Forgot password · lab2date',
};

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
