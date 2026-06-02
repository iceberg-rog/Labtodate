/** @type {import('next').NextConfig} */

// Media is self-hosted in MinIO and referenced with host-relative URLs
// (/media/<bucket>/<key>) so the site works under any domain/tunnel without
// re-baking image URLs. A rewrite lets the Next image optimizer resolve
// those relative paths against the internal MinIO service, so images are
// optimized/resized/WebP and cached — fast — while staying host-agnostic.
const MINIO_INTERNAL = 'http://minio:9000';

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // ESLint runs as a separate step (`npm run lint`) — don't fail production
  // builds on stylistic rules like react/no-unescaped-entities. TypeScript
  // errors still block (typescript.ignoreBuildErrors stays unset by design).
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    // optimizer fetches /media/* via the rewrite below (same origin).
    // For Product.images that point at external suppliers (lab2.nl,
    // lab2parts.com, plus any future supplier added through the AI shop
    // suggester or the URL importer) we widen the allowlist to all HTTPS
    // sources — the optimizer still validates the response is an image, so
    // the risk is bounded to bandwidth abuse, which is mitigated by Next's
    // built-in size+count limits on /_next/image.
    remotePatterns: [
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: '**' },
      { protocol: 'http',  hostname: '**' },
    ],
  },
  async rewrites() {
    return [
      { source: '/media/:path*', destination: `${MINIO_INTERNAL}/:path*` },
    ];
  },
};

export default nextConfig;
