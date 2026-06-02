import { Suspense } from 'react';
import Inner from './Inner';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Reset password · lab2date',
};

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
