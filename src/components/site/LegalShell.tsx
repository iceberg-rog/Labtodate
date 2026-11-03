import { ensureSettingsLoaded } from '@/lib/settings';

export async function legalContext() {
  await ensureSettingsLoaded();
  // Never print an address on a domain we may not own. Fall through to the
  // inbox the support form already delivers to, and when nothing at all is
  // configured link to the contact page instead of an empty mailto:.
  const contactEmail = (
    process.env.SUPPORT_EMAIL ||
    process.env.COMPANY_EMAIL ||
    process.env.SUPPORT_INTAKE_EMAIL ||
    ''
  ).trim();
  return {
    site: process.env.SITE_NAME || 'Labtodate',
    legal: process.env.COMPANY_LEGAL_NAME || process.env.SITE_NAME || 'Labtodate',
    address: process.env.COMPANY_ADDRESS || '',
    country: process.env.COMPANY_COUNTRY || '',
    vat: process.env.COMPANY_VAT || '',
    phone: process.env.COMPANY_PHONE || '',
    email: contactEmail,
    contactHref: contactEmail ? `mailto:${contactEmail}` : '/contact',
    contactLabel: contactEmail || 'our contact page',
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
