import type { LegalIdentity } from '@/lib/brand/identity';

/**
 * The homepage's Organization data for search engines, built from the legal
 * identity (Settings → Company / Brand) instead of raw .env values: the
 * registered name and VAT ID, a structured address (street, postcode, city,
 * ISO country) and the company's own profiles (SOCIAL_LINKS). Pure.
 */
export interface PostalAddressLd {
  '@type': 'PostalAddress';
  streetAddress?: string;
  postalCode?: string;
  addressLocality?: string;
  addressCountry?: string;
}

/**
 * COMPANY_ADDRESS ("Industrieweg 12\n2712 LB Zoetermeer") → street, postcode and
 * city. A line that starts with a postcode (NL 1234 AB, or 4–5 digits) gives the
 * postcode and the city after it; without one the city is the issuing city.
 * A last line that is the country name is not part of the street.
 */
export function splitAddress(address: string, city: string, countryName: string): Omit<PostalAddressLd, '@type' | 'addressCountry'> {
  const rows = address.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (rows.length && countryName && rows[rows.length - 1].toLowerCase() === countryName.trim().toLowerCase()) rows.pop();
  let postalCode: string | undefined;
  let locality: string | undefined;
  const street: string[] = [];
  for (const row of rows) {
    const m = !postalCode ? row.match(/^(\d{4}\s?[A-Za-z]{2}|\d{4,5})\s+(.+)$/) : null;
    if (m) {
      postalCode = m[1].toUpperCase().replace(/^(\d{4})([A-Z]{2})$/, '$1 $2');
      locality = m[2].trim();
    } else if (!postalCode) street.push(row);
  }
  return {
    ...(street.length ? { streetAddress: street.join(', ') } : {}),
    ...(postalCode ? { postalCode } : {}),
    ...((locality || city.trim()) ? { addressLocality: locality || city.trim() } : {}),
  };
}

export interface OrganizationLdInput {
  identity: LegalIdentity;
  /** COMPANY_ADDRESS as stored (the identity's lines include the country). */
  address: string;
  /** TAX_HOME_COUNTRY (ISO 3166-1 alpha-2). */
  homeCountry: string;
  /** SOCIAL_LINKS (https:// profile pages). */
  sameAs: string[];
  /** The site's base URL. */
  url: string;
  description: string;
}

export function organizationJsonLd(i: OrganizationLdInput): Record<string, unknown> {
  const id = i.identity;
  const addr = splitAddress(i.address, id.city, id.country);
  const country = /^[A-Z]{2}$/.test(i.homeCountry.trim().toUpperCase()) ? i.homeCountry.trim().toUpperCase() : undefined;
  const hasAddress = Object.keys(addr).length > 0;
  const sameAs = i.sameAs.map((s) => s.trim()).filter((s) => /^https:\/\/\S+$/.test(s));
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: id.siteName,
    ...(id.legalName && id.legalName !== id.siteName ? { legalName: id.legalName } : {}),
    url: i.url,
    ...(id.logoAbsoluteUrl ? { logo: id.logoAbsoluteUrl } : {}),
    description: i.description,
    ...(id.supportEmail ? { email: id.supportEmail } : {}),
    ...(id.phone ? { telephone: id.phone } : {}),
    ...(id.vat ? { vatID: id.vat.replace(/[\s.-]+/g, '').toUpperCase() } : {}),
    ...(hasAddress ? { address: { '@type': 'PostalAddress', ...addr, ...(country ? { addressCountry: country } : {}) } } : {}),
    ...(sameAs.length ? { sameAs } : {}),
  };
}
