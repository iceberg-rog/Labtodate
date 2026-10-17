/** @type {import('next').NextConfig} */

// Media is self-hosted in MinIO and referenced with host-relative URLs
// (/media/<bucket>/<key>) so the site works under any domain/tunnel without
// re-baking image URLs. A rewrite lets the Next image optimizer resolve
// those relative paths against the internal MinIO service, so images are
// optimized/resized/WebP and cached — fast — while staying host-agnostic.
// MEDIA_INTERNAL_ORIGIN overrides it for a non-Docker run (read at build time).
const MINIO_INTERNAL = process.env.MEDIA_INTERNAL_ORIGIN || 'http://minio:9000';

const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Document PDFs: puppeteer-core is loaded at runtime from node_modules (not
  // bundled), and the standalone output traces it in. Next lists it by default
  // too — explicit here so the PDF path never depends on that default.
  serverExternalPackages: ['puppeteer-core'],
  experimental: {
    serverActions: {
      // File uploads posted through Server Actions (company logo, payment
      // receipts from the buyer and the admin "mark as paid" form, which
      // advertise "max 8 MB") otherwise hit Next's 1 MB default and die with
      // a 413 / full-page crash before the action's own size check can
      // answer. 10 MB = 8 MB file + multipart overhead; nginx allows 25 MB,
      // middleware buffers 10 MB.
      bodySizeLimit: '10mb',
    },
  },
  images: {
    // Product photos are ALWAYS served from our own media store as
    // host-relative /media/<bucket>/<key> paths (src/lib/media/public-src.ts
    // normalises every stored URL; foreign URLs are dropped before rendering).
    // The optimizer fetches them via the rewrite below, so no remote host is
    // allowed at all: /_next/image can no longer proxy a supplier's site
    // (which exposed the hidden supplier and broke when its URLs changed) or
    // be used as an open image proxy. http(s) internal services stay out too.
    remotePatterns: [],
  },
  async headers() {
    return [
      {
        // User uploads proxied to MinIO from our own origin (deployments
        // without the nginx /media/ block): never sniff, and never let a
        // stored file run script here. Mirrors nginx/lab2date.conf.
        source: '/media/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Content-Security-Policy', value: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      { source: '/media/:path*', destination: `${MINIO_INTERNAL}/:path*` },
    ];
  },
};

export default nextConfig;
