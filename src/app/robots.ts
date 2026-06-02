import type { MetadataRoute } from 'next';

const BASE = process.env.BETTER_AUTH_URL ?? 'https://lab2date.com';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/app/', '/admin/', '/api/', '/auth/'],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
  };
}
