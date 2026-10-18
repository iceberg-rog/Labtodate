import { ensureSettingsLoaded } from '@/lib/settings';
import { legalIdentity } from '@/lib/brand/identity';

/**
 * Brand and seller identity for the legal and company pages, from Settings
 * (Brand, Company) through legalIdentity() — the same source as the e-mail
 * footers and the invoices. Placeholder e-mail addresses read as not set.
 */
export async function legalContext() {
  await ensureSettingsLoaded();
  const id = legalIdentity();
  // The registered address on one line, without the country (printed after it).
  const last = id.addressLines[id.addressLines.length - 1];
  const lines = id.country && last === id.country ? id.addressLines.slice(0, -1) : id.addressLines;
  return {
    site: id.siteName,
    legal: id.displayName,
    address: lines.join(', '),
    country: id.country,
    kvk: id.kvk,
    vat: id.vat,
    phone: id.phone,
    email: id.supportEmail || id.email,
    // Where "contact us" points: the configured address, else the contact page
    // (never a made-up address — Settings → Brand → Public support email).
    get contactHref(): string {
      return this.email ? `mailto:${this.email}` : '/contact';
    },
    get contactLabel(): string {
      return this.email || 'our contact page';
    },
  };
}

export function LegalShell({
  title,
  subtitle,
  updated,
  children,
}: {
  title: string;
  subtitle?: string;
  /** When the text last changed. Without it no date is shown — it used to print the current month on every visit. */
  updated?: Date | null;
  children: React.ReactNode;
}) {
  return (
    <div className="container-px py-14 max-w-3xl mx-auto">
      <h1 className="text-4xl md:text-5xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }}>
        {title}
      </h1>
      {subtitle && <p className="mt-3 text-lg text-muted-foreground">{subtitle}</p>}
      <div className="prose-article mt-10 text-foreground">{children}</div>
      {updated && (
        <p className="mt-12 text-xs text-muted-foreground">
          Last updated: {updated.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Amsterdam' })}
        </p>
      )}
    </div>
  );
}
