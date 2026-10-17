/** @type {import('next').NextConfig} */

// Media is self-hosted in MinIO and referenced with host-relative URLs
// (/media/<bucket>/<key>) so the site works under any domain/tunnel without
// re-baking image URLs. A rewrite lets the Next image optimizer resolve
// those relative paths against the internal MinIO service, so images are
// optimized/resized/WebP and cached — fast — while staying host-agnostic.
const MINIO_INTERNAL = 'http://minio:9000';

// Hosts whose /media/** the image optimizer may fetch. Every stored image is
// our own MinIO media (all 1565 Product.images on 2026-10-17 are
// https://labtodate.com/media/…). IMAGE_HOSTS (comma-separated, read at build
// time) adds hosts for other deployments, e.g. a local test domain.
const IMAGE_HOSTS = [
  'labtodate.com',
  'www.labtodate.com',
  ...(process.env.IMAGE_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
];

const nextConfig = {
  reactStrictMode: true,
  // src/lib/image-hosts.ts: images on any other host are loaded by the browser, not the optimizer
  env: { NEXT_PUBLIC_IMAGE_HOSTS: IMAGE_HOSTS.join(',') },
  output: 'standalone',
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
    // optimizer fetches /media/* via the rewrite below (same origin).
    // SECURITY (2026-10-17): the optimizer used to accept ANY https host.
    // Next 16.2.7 follows redirects from that host without re-checking
    // protocol or allowlist, so https://attacker → 302 → http://minio:9000
    // reached the private Docker network, and every attacker-chosen file went
    // through the sharp/libvips decoders — all without signing in. Supplier
    // photos are localized into MinIO on import (localize-images.ts), so only
    // our own /media/** is allowed. Unsplash demo photos never reach Next:
    // nginx answers those /_next/image URLs from local copies.
    remotePatterns: IMAGE_HOSTS.map((hostname) => ({ protocol: 'https', hostname, pathname: '/media/**' })),
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
