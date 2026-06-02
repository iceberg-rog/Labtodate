import Link from 'next/link';
import { Logo } from '@/components/site/Logo';
import { Linkedin, Twitter, Github, Mail } from 'lucide-react';
import { ensureSettingsLoaded } from '@/lib/settings';
import { getMarketing } from '@/lib/marketing';

const COLUMNS = [
  {
    title: 'Marketplace',
    links: [
      { label: 'Browse all', href: '/marketplace' },
      { label: 'Categories', href: '/marketplace#categories' },
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
  const supportEmail = process.env.SUPPORT_EMAIL || 'hello@lab2date.com';
  const siteName = process.env.SITE_NAME || 'lab2date';
  const mk = await getMarketing();
  return (
    <footer className="border-t bg-muted/40 mt-24">
      <div className="container-px py-12 grid grid-cols-2 md:grid-cols-6 gap-8">
        <div className="col-span-2 space-y-4">
          <div className="text-primary">
            <Logo />
          </div>
          <p className="text-sm text-muted-foreground max-w-xs">
            {mk.footerTagline}
          </p>
          <div className="flex gap-3 text-muted-foreground">
            {mk.social.linkedin && (
              <Link href={mk.social.linkedin} aria-label="LinkedIn" className="hover:text-foreground" target="_blank" rel="noopener noreferrer">
                <Linkedin className="h-5 w-5" />
              </Link>
            )}
            {mk.social.twitter && (
              <Link href={mk.social.twitter} aria-label="Twitter" className="hover:text-foreground" target="_blank" rel="noopener noreferrer">
                <Twitter className="h-5 w-5" />
              </Link>
            )}
            {mk.social.github && (
              <Link href={mk.social.github} aria-label="GitHub" className="hover:text-foreground" target="_blank" rel="noopener noreferrer">
                <Github className="h-5 w-5" />
              </Link>
            )}
            <Link href={`mailto:${supportEmail}`} aria-label="Email" className="hover:text-foreground">
              <Mail className="h-5 w-5" />
            </Link>
          </div>
        </div>

        {COLUMNS.map((col) => (
          <div key={col.title} className="space-y-3">
            <h4 className="text-sm font-semibold">{col.title}</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              {col.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="hover:text-foreground transition-colors">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t">
        <div className="container-px py-6 flex flex-col sm:flex-row justify-between gap-4 text-xs text-muted-foreground">
          <p>© {new Date().getFullYear()} {siteName}. All rights reserved.</p>
          <p>Made for scientists, by scientists.</p>
        </div>
      </div>
    </footer>
  );
}
