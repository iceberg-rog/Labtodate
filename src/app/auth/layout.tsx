import Link from 'next/link';
import { Logo } from '@/components/site/Logo';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[calc(100vh-4rem)] bg-muted/30 flex flex-col">
      <div className="container-px py-8">
        <Link href="/" className="inline-flex text-primary">
          <Logo />
        </Link>
      </div>
      <div className="flex-1 flex items-start justify-center px-4 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
