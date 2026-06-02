import { ensureSettingsLoaded } from '@/lib/settings';

export async function legalContext() {
  await ensureSettingsLoaded();
  return {
    site: process.env.SITE_NAME || 'lab2date',
    legal: process.env.COMPANY_LEGAL_NAME || process.env.SITE_NAME || 'lab2date',
    address: process.env.COMPANY_ADDRESS || '',
    country: process.env.COMPANY_COUNTRY || '',
    vat: process.env.COMPANY_VAT || '',
    phone: process.env.COMPANY_PHONE || '',
    email:
      process.env.SUPPORT_EMAIL ||
      process.env.COMPANY_EMAIL ||
      'support@lab2date.com',
  };
}

export function LegalShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="container-px py-14 max-w-3xl mx-auto">
      <h1 className="text-4xl md:text-5xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }}>
        {title}
      </h1>
      {subtitle && <p className="mt-3 text-lg text-muted-foreground">{subtitle}</p>}
      <div className="prose-article mt-10 text-foreground">{children}</div>
      <p className="mt-12 text-xs text-muted-foreground">Last updated: {new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long' })}</p>
    </div>
  );
}
