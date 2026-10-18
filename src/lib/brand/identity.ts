import { settingString } from '@/lib/settings';
import { isDeliverableEmail } from '@/lib/email-address';

/**
 * The brand and the legal identity as configured in Admin → Settings (Brand,
 * Company). The single source for the site name in mails, pages and
 * structured data, and for the seller identity in mail footers and the
 * Organization data — never a hard-coded brand.
 *
 * Synchronous: read after `await ensureSettingsLoaded()` (server code does that
 * at its entry point). Empty values stay empty — nothing is invented, and a
 * placeholder e-mail (billing@lab2date.local, *.example …) reads as not set.
 */

/** Used only when SITE_NAME is not set at all. */
export const DEFAULT_SITE_NAME = 'Labtodate';

/** The brand name customers see (SITE_NAME). */
export function siteName(): string {
  return settingString('SITE_NAME').trim() || DEFAULT_SITE_NAME;
}

export interface LegalIdentity {
  /** Brand name (SITE_NAME). */
  siteName: string;
  /** Registered company name (COMPANY_LEGAL_NAME); '' when not set. */
  legalName: string;
  /** The legal name, else the brand name — for sender lines and “© …”. */
  displayName: string;
  /** Registered address, one entry per line (street, postcode + city), then the country. */
  addressLines: string[];
  /** Issuing city (COMPANY_CITY). */
  city: string;
  /** Country name printed under the address (COMPANY_COUNTRY). */
  country: string;
  kvk: string;
  vat: string;
  eori: string;
  phone: string;
  /** Billing / accounts e-mail (COMPANY_EMAIL); '' when not set or a placeholder. */
  email: string;
  /** Public support e-mail (SUPPORT_EMAIL); '' when not set or a placeholder. */
  supportEmail: string;
  /** Website as configured (COMPANY_WEBSITE, e.g. “labtodate.com”). */
  website: string;
  /** The website as an absolute https:// URL, else the site's own base URL; '' when neither is known. */
  websiteUrl: string;
  /** Logo as stored (COMPANY_LOGO_URL: a URL or a site path such as /media/…); '' when none. */
  logoUrl: string;
  /** The logo as an absolute URL (mail clients need one); '' when none. */
  logoAbsoluteUrl: string;
}

/** Base URL of this site (BETTER_AUTH_URL), without a trailing slash. */
function siteBase(): string {
  return (process.env.BETTER_AUTH_URL ?? '').trim().replace(/\/+$/, '');
}

/** A stored URL or site path as an absolute http(s) URL ('' when it can't be one). */
export function absoluteSiteUrl(value: string, base: string = siteBase()): string {
  const v = value.trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  if (/^\/(?![/\\])/.test(v)) return base ? `${base}${v}` : '';
  return '';
}

/** COMPANY_WEBSITE ("labtodate.com", "https://…") as a URL; falls back to the site base. */
export function websiteUrlOf(website: string, base: string = siteBase()): string {
  const w = website.trim();
  if (/^https?:\/\//i.test(w)) return w.replace(/\/+$/, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(w)) return `https://${w.replace(/\/+$/, '')}`;
  return base;
}

/** The registered address split into lines, followed by the country when it is not already the last line. */
export function addressLinesOf(address: string, country: string): string[] {
  const lines = address.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const c = country.trim();
  if (c && lines[lines.length - 1]?.toLowerCase() !== c.toLowerCase()) lines.push(c);
  return lines;
}

/** A configured address, or '' when it is a placeholder no mail server accepts. */
function deliverable(email: string): string {
  return isDeliverableEmail(email) ? email : '';
}

/** The seller identity: legal name, address, KvK, VAT, EORI, contact, website, logo. */
export function legalIdentity(): LegalIdentity {
  const s = (key: string) => settingString(key).trim();
  const brand = siteName();
  const legalName = s('COMPANY_LEGAL_NAME');
  const country = s('COMPANY_COUNTRY');
  const website = s('COMPANY_WEBSITE');
  const logoUrl = s('COMPANY_LOGO_URL');
  return {
    siteName: brand,
    legalName,
    displayName: legalName || brand,
    addressLines: addressLinesOf(s('COMPANY_ADDRESS'), country),
    city: s('COMPANY_CITY'),
    country,
    kvk: s('COMPANY_KVK'),
    vat: s('COMPANY_VAT'),
    eori: s('COMPANY_EORI'),
    phone: s('COMPANY_PHONE'),
    email: deliverable(s('COMPANY_EMAIL')),
    supportEmail: deliverable(s('SUPPORT_EMAIL')),
    website,
    websiteUrl: websiteUrlOf(website),
    logoUrl,
    logoAbsoluteUrl: absoluteSiteUrl(logoUrl),
  };
}
