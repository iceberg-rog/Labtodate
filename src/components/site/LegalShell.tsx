import { ensureSettingsLoaded } from '@/lib/settings';
import { siteRich, siteText, siteUpdatedAt } from '@/lib/site/content';
import { BUILT_IN_TEXTS_DATE, siteDef } from '@/lib/site/defs';

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

/**
 * Layout of the legal and help pages. Pages edited in Admin → Site content
 * pass `html` (siteRich() output, escaped by construction) and `updated`: the
 * date their texts were last saved there (or the built-in texts' date).
 */
export function LegalShell({
  title,
  subtitle,
  html,
  updated,
  children,
}: {
  title: string;
  subtitle?: string;
  html?: string;
  updated?: Date;
  children?: React.ReactNode;
}) {
  const lastUpdated = updated
    ? updated.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' })
    : new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long' });
  return (
    <div className="container-px py-14 max-w-3xl mx-auto">
      <h1 className="text-4xl md:text-5xl font-bold tracking-tight" style={{ letterSpacing: '-0.035em' }}>
        {title}
      </h1>
      {subtitle && <p className="mt-3 text-lg text-muted-foreground">{subtitle}</p>}
      {html !== undefined ? (
        <div className="prose-article mt-10 text-foreground" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="prose-article mt-10 text-foreground">{children}</div>
      )}
      <p className="mt-12 text-xs text-muted-foreground">Last updated: {lastUpdated}</p>
    </div>
  );
}

/** Title, subtitle, body HTML and "Last updated" of a page group (Admin → Site content → Page: …). */
export async function sitePage(group: string, opts: { faq?: boolean } = {}) {
  const [title, subtitle, body, updated] = await Promise.all([
    siteText(`${group}.title`),
    siteDef(`${group}.subtitle`) ? siteText(`${group}.subtitle`) : Promise.resolve(''),
    siteRich(`${group}.body`, { headings: true }),
    siteUpdatedAt(group, BUILT_IN_TEXTS_DATE),
  ]);
  // FAQ: each "## Question" is styled as the FAQ's question heading (.faq h3, "Q." marker).
  const html = opts.faq ? `<div class="faq">${body.replace(/<(\/?)h2>/g, '<$1h3>')}</div>` : body;
  return { title, subtitle: subtitle || undefined, html, updated };
}
