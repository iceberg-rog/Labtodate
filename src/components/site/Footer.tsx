import Link from 'next/link';
import { Logo } from '@/components/site/Logo';
import { Linkedin, Twitter, Github, Mail } from 'lucide-react';
import { ensureSettingsLoaded } from '@/lib/settings';
import { getMarketing } from '@/lib/marketing';
import { hiddenNavHrefs, siteText } from '@/lib/site/content';
import { getCompany } from '@/lib/invoice';
import { FooterWord } from '@/components/site/FooterWord';

const COLUMNS = [
  {
    title: 'Marketplace',
    links: [
      { label: 'Browse all', href: '/marketplace' },
      // The category grid (id="categories") lives on the home page, not /marketplace.
      { label: 'Categories', href: '/#categories' },
      { label: 'Request a quote', href: '/let-us-find-it' },
    ],
  },
  {
    title: 'Sell to us',
    links: [
      { label: 'Sell your equipment', href: '/sell' },
      { label: 'Let us source it', href: '/let-us-find-it' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Blog', href: '/blog' },
      { label: 'Equipment wiki', href: '/wiki' },
      { label: 'Lab rental', href: '/lab-rental' },
      { label: 'Case studies', href: '/case-studies' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '/about' },
      { label: 'Contact', href: '/contact' },
      { label: 'Support', href: '/support' },
      { label: 'FAQ', href: '/faq' },
      { label: 'Terms', href: '/legal/terms' },
      { label: 'Privacy', href: '/legal/privacy' },
      { label: 'Cookies', href: '/legal/cookies' },
    ],
  },
];

/** A social link is shown only as a full web address (older .env values were never checked). */
const webUrl = (u: string) => /^https?:\/\/\S+$/i.test(u);

export async function Footer() {
  await ensureSettingsLoaded();
  // Only a configured address — never a made-up one on a domain we do not own.
  const supportEmail = (process.env.SUPPORT_EMAIL || '').trim();
  const siteName = process.env.SITE_NAME || 'Labtodate';
  // Tagline + social links: Admin → Site content → Footer (via getMarketing).
  const [mk, hidden, copyright] = await Promise.all([getMarketing(), hiddenNavHrefs(), siteText('footer.copyright')]);
  // Sections switched off (or empty while "Automatic") in Site content → Menu & footer.
  const columns = COLUMNS.map((col) => ({ ...col, links: col.links.filter((l) => !hidden.includes(l.href)) })).filter((col) => col.links.length > 0);
  // Legal identity (Settings → Company), same source as the invoices — shown
  // only for the fields that are filled in.
  const co = getCompany();
  const legalParts = [
    process.env.COMPANY_LEGAL_NAME ? co.name : '',
    [...co.addrLines, co.country].filter(Boolean).join(', '),
    co.kvk ? `KvK ${co.kvk}` : '',
    co.vat ? `VAT ${co.vat}` : '',
  ].filter(Boolean);
  return (
    <footer className="sfoot">
      <div className="sfoot-glow" aria-hidden />
      <div className="container-px relative">
        <div className="sfoot-grid">
          <div className="space-y-4">
            <Link href="/" aria-label={`${siteName} home`} className="inline-block">
              <Logo name={siteName} />
            </Link>
            {mk.footerTagline && <p className="text-sm text-muted-foreground max-w-xs">{mk.footerTagline}</p>}
            <div className="sfoot-social">
              {webUrl(mk.social.linkedin) && (
                <Link href={mk.social.linkedin} aria-label="LinkedIn" target="_blank" rel="noopener noreferrer">
                  <Linkedin className="h-4 w-4" />
                </Link>
              )}
              {webUrl(mk.social.twitter) && (
                <Link href={mk.social.twitter} aria-label="Twitter" target="_blank" rel="noopener noreferrer">
                  <Twitter className="h-4 w-4" />
                </Link>
              )}
              {webUrl(mk.social.github) && (
                <Link href={mk.social.github} aria-label="GitHub" target="_blank" rel="noopener noreferrer">
                  <Github className="h-4 w-4" />
                </Link>
              )}
              {supportEmail && (
                <Link href={`mailto:${supportEmail}`} aria-label="Email">
                  <Mail className="h-4 w-4" />
                </Link>
              )}
            </div>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <h4>{col.title}</h4>
              <ul>
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <FooterWord word={siteName} />
        <div className="sfoot-bar">
          <div className="space-y-1">
            {copyright && <p>{copyright}</p>}
            {legalParts.length > 0 && <p>{legalParts.join(' · ')}</p>}
          </div>
        </div>
      </div>
    </footer>
  );
}
