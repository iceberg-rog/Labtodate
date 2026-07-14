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
  images: {
    // optimizer fetches /media/* via the rewrite below (same origin).
    // For Product.images that point at external suppliers (lab2.nl,
    // lab2parts.com, plus any future supplier added through the AI shop
    // suggester or the URL importer) we allow all HTTPS sources — the
    // optimizer still validates the response is an image, so the risk is
    // bounded to bandwidth (mitigated by Next's size+count limits and the
    // per-IP nginx limit on /_next/image).
    // SECURITY: `http` is intentionally NOT allowed. Plaintext internal
    // services (169.254.169.254 metadata, db:5432, minio:9000, xray:9443)
    // all speak http, so an http:** allowlist turned the optimizer into an
    // SSRF probe into the private network. HTTPS-only closes that.
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
  },
  async rewrites() {
    return [
      { source: '/media/:path*', destination: `${MINIO_INTERNAL}/:path*` },
    ];
  },
};

export default nextConfig;
