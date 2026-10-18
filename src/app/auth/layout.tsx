import Link from 'next/link';
import { Logo } from '@/components/site/Logo';
import { ensureSettingsLoaded } from '@/lib/settings';
import { siteBrand } from '@/lib/brand/site-logo';

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  // The brand from Settings (site name, website logo), as in the site header.
  await ensureSettingsLoaded();
  const brand = siteBrand();
  return (
    <div className="min-h-screen bg-muted/30 flex flex-col">
      <div className="container-px py-6 flex items-center justify-between">
        <Link href="/" className="inline-flex text-primary" aria-label={`${brand.name} home`}>
          <Logo name={brand.name} logoUrl={brand.logoUrl} logoOnLight={brand.logoOnLight} priority />
        </Link>
      </div>
      <div className="flex-1 flex items-start justify-center px-4 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </div>
    </div>
  );
}
