import { siteTextsFrom } from '@/lib/catalog/site-texts';
import { linkPreviewFrom } from '@/lib/catalog/policy';
import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { Header } from '@/components/site/Header';
import { Footer } from '@/components/site/Footer';
import { CookieConsent } from '@/components/site/CookieConsent';
import { PublicChrome } from '@/components/site/PublicChrome';
import { ThemeScript } from '@/components/site/ThemeScript';
import { getMarketing } from '@/lib/marketing';
import { ensureSettingsLoaded } from '@/lib/settings';
import { isBuildPhase } from '@/lib/build-phase';

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

// Site name from Admin → Settings → Brand (SITE_NAME); it used to be
// hard-coded here, so changing the setting never reached <title> / OG tags.
export async function generateMetadata(): Promise<Metadata> {
  if (!isBuildPhase()) await ensureSettingsLoaded();
  // Settings → Site texts & pages (SITE_TITLE_SUFFIX / SITE_META_DESCRIPTION):
  // describe what is really sold — the defaults make no "refurbished" or
  // geographic claim.
  const t = siteTextsFrom((k) => process.env[k] ?? '');
  const site = t.siteName;
  // Settings → Site texts & pages: og:locale and the picture shared for a
  // page without its own (relative paths resolve against metadataBase).
  const preview = linkPreviewFrom((k) => process.env[k] ?? '');
  return {
    // Absolute canonical / og:url / og:image URLs for every page.
    metadataBase: new URL(process.env.BETTER_AUTH_URL || 'https://labtodate.com'),
    title: {
      default: `${site} — ${t.titleSuffix}`,
      template: `%s · ${site}`,
    },
    description: t.metaDescription,
    // No meta keywords: search engines ignore them, and a fixed list was not
    // the owner's to edit.
    applicationName: site,
    authors: [{ name: site }],
    // NOTE: no site-wide `alternates.canonical` — that would point every page at
    // the homepage. Canonicals are set per-page in each route's generateMetadata.
    robots: {
      index: true,
      follow: true,
      googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 },
    },
    // No og:title / og:description here: a page that does not set its own
    // Open Graph data shares ITS title and description (Next fills them from
    // the page metadata), never the homepage's.
    openGraph: {
      type: 'website',
      siteName: site,
      locale: preview.locale,
      images: preview.image ? [preview.image] : undefined,
    },
    twitter: {
      card: preview.image ? 'summary_large_image' : 'summary',
    },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAF8F2' },
    { media: '(prefers-color-scheme: dark)', color: '#031110' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // getMarketing() loads Settings (the admin's values) for the chrome below.
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
          // Support runs on tickets only (owner decision): no chat widget.
          overlays={<CookieConsent />}
        >
          {children}
        </PublicChrome>
      </body>
    </html>
  );
}
