import { Suspense } from 'react';
import SignInForm from './SignInForm';

export const metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
