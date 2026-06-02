import { Suspense } from 'react';
import SignUpForm from './SignUpForm';

export const metadata = { title: 'Sign up' };

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUpForm />
    </Suspense>
  );
}
