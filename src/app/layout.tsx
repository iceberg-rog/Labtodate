import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Header } from '@/components/site/Header';
import { Footer } from '@/components/site/Footer';
import { CookieConsent } from '@/components/site/CookieConsent';
import { Assistant } from '@/components/site/Assistant';
import { PublicChrome } from '@/components/site/PublicChrome';
import { getMarketing } from '@/lib/marketing';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '700'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://lab2date.com'),
  title: {
    default: 'lab2date — Find the right lab equipment, faster',
    template: '%s · lab2date',
  },
  description:
    'B2B marketplace for laboratory & biotech equipment. New and certified refurbished instruments from verified suppliers, with up to 50% savings.',
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
