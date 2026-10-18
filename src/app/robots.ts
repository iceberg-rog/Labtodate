import type { MetadataRoute } from 'next';

const BASE = process.env.BETTER_AUTH_URL ?? 'https://labtodate.com';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // Signed-in areas and the API only ('/app' and '/admin' without the
        // slash also cover the bare paths). Sign-in, checkout and thank-you
        // pages are NOT blocked here: they carry noindex, which a crawler can
        // only read when it may fetch them.
        disallow: ['/app', '/admin', '/api/'],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
  };
}
