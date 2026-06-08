import type { Metadata } from 'next';
import './globals.css';
import { Header } from '@/components/site/Header';
import { Footer } from '@/components/site/Footer';
import { CookieConsent } from '@/components/site/CookieConsent';
import { Assistant } from '@/components/site/Assistant';
import { PublicChrome } from '@/components/site/PublicChrome';
import { getMarketing } from '@/lib/marketing';

// next/font/google requires fonts.gstatic.com at build time, which is
// blocked from this host. Fall back to system fonts — CSS variables stay
// undefined and css falls through to system-ui/monospace defaults.
const inter = { variable: '' };
const mono = { variable: '' };

export const metadata: Metadata = {
  metadataBase: new URL(process.env.BETTER_AUTH_URL || 'https://labtodate.com'),
  title: {
    default: 'lab2date — Find the right lab equipment, faster',
    template: '%s · lab2date',
  },
  description:
    'B2B marketplace for laboratory & biotech equipment — new, refurbished and surplus instruments with end-to-end quote, proforma and shipping support.',
  openGraph: {
    title: 'lab2date',
    description: 'Find the right lab equipment, faster.',
    type: 'website',
    siteName: 'lab2date',
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const mk = await getMarketing();
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-background font-sans antialiased flex flex-col">
        <PublicChrome
          header={<Header searchPlaceholder={`Search ${mk.listings} instruments…`} />}
          footer={<Footer />}
          overlays={<><CookieConsent /><Assistant /></>}
        >
          {children}
        </PublicChrome>
      </body>
    </html>
  );
}
