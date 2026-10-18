import Link from 'next/link';
import { Logo } from '@/components/site/Logo';
import { Linkedin, Twitter, Github, Mail } from 'lucide-react';
import { ensureSettingsLoaded } from '@/lib/settings';
import { getMarketing } from '@/lib/marketing';
import { legalIdentity } from '@/lib/brand/identity';
import { siteBrand } from '@/lib/brand/site-logo';
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

export async function Footer() {
  await ensureSettingsLoaded();
  // Brand and legal identity (Settings → Brand / Company), the same source as
  // the e-mails and invoices — legal fields shown only when filled in, and
  // only a real support address (never a placeholder on a domain we don't own).
  const id = legalIdentity();
  const brand = siteBrand();
  const supportEmail = id.supportEmail;
  const siteName = id.siteName;
  const mk = await getMarketing();
  const legalParts = [
    id.legalName,
    id.addressLines.join(', '),
    id.kvk ? `KvK ${id.kvk}` : '',
    id.vat ? `VAT ${id.vat}` : '',
  ].filter(Boolean);
  return (
    <footer className="sfoot">
      <div className="sfoot-glow" aria-hidden />
      <div className="container-px relative">
        <div className="sfoot-grid">
          <div className="space-y-4">
            <Link href="/" aria-label={`${siteName} home`} className="inline-block">
              <Logo name={siteName} logoUrl={brand.logoUrl} logoOnLight={brand.logoOnLight} />
            </Link>
            <p className="text-sm text-muted-foreground max-w-xs">{mk.footerTagline}</p>
            <div className="sfoot-social">
              {mk.social.linkedin && (
                <Link href={mk.social.linkedin} aria-label="LinkedIn" target="_blank" rel="noopener noreferrer">
                  <Linkedin className="h-4 w-4" />
                </Link>
              )}
              {mk.social.twitter && (
                <Link href={mk.social.twitter} aria-label="Twitter" target="_blank" rel="noopener noreferrer">
                  <Twitter className="h-4 w-4" />
                </Link>
              )}
              {mk.social.github && (
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

          {COLUMNS.map((col) => (
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
            <p>© {new Date().getFullYear()} {siteName}. All rights reserved.</p>
            {legalParts.length > 0 && <p>{legalParts.join(' · ')}</p>}
          </div>
          {mk.footerSignoff && <p>{mk.footerSignoff}</p>}
        </div>
      </div>
    </footer>
  );
}
