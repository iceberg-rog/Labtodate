import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Header } from '@/components/site/Header';
import { Footer } from '@/components/site/Footer';
import { CookieConsent } from '@/components/site/CookieConsent';
import { Assistant } from '@/components/site/Assistant';
import { PublicChrome } from '@/components/site/PublicChrome';
import { ThemeScript } from '@/components/site/ThemeScript';
import { getMarketing } from '@/lib/marketing';

// Self-hosted variable fonts (next/font/local reads local files — no network
// at build time, unlike next/font/google which needs fonts.gstatic.com).
// Inter drives all UI text (its ss01/cv11 OpenType features are used in
// globals.css); JetBrains Mono renders prices / specs / data.
const inter = localFont({
  src: './fonts/Inter-latin.woff2',
  variable: '--font-inter',
  display: 'swap',
  weight: '100 900',
  fallback: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Arial', 'sans-serif'],
});
const mono = localFont({
  src: './fonts/JetBrainsMono-latin.woff2',
  variable: '--font-mono',
  display: 'swap',
  weight: '100 800',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.BETTER_AUTH_URL || 'https://labtodate.com'),
  title: {
    default: 'lab2date — Refurbished & surplus lab equipment marketplace',
    template: '%s · lab2date',
  },
  description:
    'B2B marketplace for laboratory & biotech equipment across Europe — new, refurbished and surplus HPLC, GC, mass spectrometry and analytical instruments, with end-to-end quote, proforma and insured shipping.',
  keywords: [
    'refurbished lab equipment',
    'used laboratory instruments',
    'HPLC',
    'gas chromatography',
    'mass spectrometry',
    'analytical instruments',
    'lab equipment marketplace',
    'laboratory equipment Netherlands',
    'surplus scientific instruments',
    'Europe',
  ],
  applicationName: 'lab2date',
  authors: [{ name: 'lab2date' }],
  // NOTE: no site-wide `alternates.canonical` — that would point every page at
  // the homepage. Canonicals are set per-page in each route's generateMetadata.
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 },
  },
  openGraph: {
    title: 'lab2date — Refurbished & surplus lab equipment marketplace',
    description:
      'Source refurbished and surplus laboratory equipment across Europe — quote, proforma and insured shipping handled end to end.',
    type: 'website',
    siteName: 'lab2date',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'lab2date — Lab equipment marketplace',
    description: 'Refurbished & surplus laboratory equipment for Europe.',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAF8F2' },
    { media: '(prefers-color-scheme: dark)', color: '#171E22' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const mk = await getMarketing();
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
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
