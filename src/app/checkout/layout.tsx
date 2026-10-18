import type { Metadata } from 'next';

// Checkout, cart checkout and the order confirmation: never in search
// results. Not blocked in robots.txt, so crawlers can read this noindex.
export const metadata: Metadata = { robots: { index: false, follow: true } };

export default function NoIndexLayout({ children }: { children: React.ReactNode }) {
  return children;
}
