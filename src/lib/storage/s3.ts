/**
 * S3-compatible storage layer.
 * Dev: MinIO (docker compose, bucket `lab2date-media`).
 * Prod: Cloudflare R2 (or any S3-compatible endpoint).
 *
 * Two zones in the same bucket:
 *   - `products/*` — public read (marketplace images, sell-submissions, etc.)
 *   - `support-att/*` — private; served ONLY via signed URLs from the
 *     /api/support-attachment proxy after auth + ticket-membership check.
 */

import { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketPolicyCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomBytes } from 'node:crypto';

const ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:9000';
const REGION = process.env.S3_REGION || 'us-east-1';
const BUCKET = process.env.S3_BUCKET || 'lab2date-media';
const ACCESS_KEY = process.env.S3_ACCESS_KEY || 'lab2date';
const SECRET_KEY = process.env.S3_SECRET_KEY || 'lab2date-secret';
const PUBLIC_URL = process.env.S3_PUBLIC_URL || `${ENDPOINT}/${BUCKET}`;

export const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: true, // required for MinIO
  // AWS SDK v3.730+ adds a CRC32 request checksum by default that older
  // MinIO releases reject as a signature mismatch. Opt out — uploads still
  // succeed on AWS/R2 without this since they only need it when explicitly
  // requested.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

// Presigned URLs need a PUBLIC host the user's browser can resolve. The main
// `s3` client points at the internal docker DNS name `minio:9000` (used for
// uploads from inside the web container). Browsers can't resolve that, so
// signed URLs minted from `s3` 302 the user to a dead host.
//
// We derive a presign endpoint from `S3_PUBLIC_URL` (strips the bucket
// suffix) and use a second client to mint signed GETs that hit the same
// MinIO behind the public reverse-proxy.
function derivePresignEndpoint(publicUrl: string, bucket: string): string {
  // publicUrl example: https://example.com/media/lab2date-media
  // bucket           : lab2date-media
  // -> returns        https://example.com/media
  if (publicUrl.endsWith('/' + bucket)) return publicUrl.slice(0, -(bucket.length + 1));
  return publicUrl;
}
const PRESIGN_ENDPOINT = derivePresignEndpoint(PUBLIC_URL, BUCKET);

const presignClient = new S3Client({
  endpoint: PRESIGN_ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

export const BUCKET_NAME = BUCKET;

let bucketReady = false;
let bucketReadyAttempt: Promise<void> | null = null;

/**
 * Best-effort bucket bootstrap. Tolerant of any error so that a flaky
 * MinIO/R2 boot doesn't permanently break uploads — once we successfully
 * complete, the work is cached; on transient failure we leave the flag
 * unset so the next call retries.
 */
export function ensureBucket(): Promise<void> {
  if (bucketReady) return Promise.resolve();
  if (bucketReadyAttempt) return bucketReadyAttempt;
  bucketReadyAttempt = (async () => {
    try {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
      } catch {
        // 404 (doesn't exist) → create. Any other error (403, auth) is
        // tolerated; if the bucket really doesn't exist the PutObject below
        // will surface a clean error to the caller.
        try { await s3.send(new CreateBucketCommand({ Bucket: BUCKET })); } catch {}
      }
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            // Public-read for products/* only (marketplace images,
            // sell submissions). Order receipts + support attachments are
            // PRIVATE — served via auth-gated streaming proxies
            // (/api/order-proof, /api/support-attachment) that check the
            // requesting user is the buyer/owner or an admin.
            Resource: [
              `arn:aws:s3:::${BUCKET}/products/*`,
            ],
          },
        ],
      };
      try {
        await s3.send(
          new PutBucketPolicyCommand({ Bucket: BUCKET, Policy: JSON.stringify(policy) }),
        );
      } catch {
        // Non-fatal — bucket may already have an equivalent policy applied
        // out-of-band (R2/AWS console). Uploads continue to work as long as
        // the object-level operations succeed.
      }
      bucketReady = true;
    } finally {
      bucketReadyAttempt = null;
    }
  })();
  return bucketReadyAttempt;
}

export async function uploadObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<{ url: string; key: string }> {
  await ensureBucket();
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  return { url: `${PUBLIC_URL}/${key}`, key };
}

export function safeKey(filename: string): string {
  const ext = (filename.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return `products/${stamp}.${ext || 'bin'}`;
}

/**
 * Unguessable S3 key for support attachments. 32 bytes of crypto-random hex
 * (~128 bits entropy) under a private prefix. Even if the bucket policy
 * regressed to public-all, brute-forcing one of these is computationally
 * infeasible.
 */
export function supportAttachmentKey(filename: string): string {
  const ext = (filename.split('.').pop() ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const id = randomBytes(32).toString('hex');
  return `support-att/${id}.${ext || 'bin'}`;
}

/**
 * Generate a short-lived presigned GET URL for a private S3 object. The URL
 * uses the PUBLIC endpoint (via `presignClient`) so the user's browser can
 * resolve it after the support-attachment proxy redirects them.
 *
 * NOTE: in setups where the public path differs from the internal path
 * (e.g. an nginx reverse-proxy that strips a `/media/` prefix), the
 * signature breaks. Use `streamSupportAttachment` instead — it auth-checks
 * + proxies the bytes through the web container, never exposing S3 URLs.
 */
export async function presignSupportAttachmentUrl(key: string, ttlSeconds = 60): Promise<string> {
  await ensureBucket();
  return getSignedUrl(
    presignClient,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: ttlSeconds },
  );
}

/**
 * Fetch a private S3 object from the INTERNAL endpoint and return its body
 * + content-type. Used by the auth-gated proxy route to stream attachment
 * bytes to the requester without ever exposing the S3 host to the browser.
 */
export async function streamSupportAttachment(key: string): Promise<{
  body: ReadableStream<Uint8Array> | null;
  contentType: string;
  contentLength: number | undefined;
}> {
  await ensureBucket();
  const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return {
    body: (out.Body as unknown as ReadableStream<Uint8Array>) ?? null,
    contentType: out.ContentType ?? 'application/octet-stream',
    contentLength: out.ContentLength,
  };
}
