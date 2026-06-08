import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';
import { rateLimit } from '@/lib/ratelimit';

const handlers = toNextJsHandler(auth.handler);

export const GET = handlers.GET;

// BUG-025 / invariant A14: per-IP sliding-window rate limits on the
// credential-sensitive auth POST endpoints (credential stuffing, email
// enumeration, sign-up spam, email bombing via magic-link/forgot-password).
// All other auth traffic (session refresh, callbacks, sign-out) passes
// through untouched.
const LIMITS: Array<{ match: RegExp; bucket: string; max: number; windowMs: number }> = [
  { match: /\/sign-in\b/, bucket: 'auth:sign-in', max: 10, windowMs: 15 * 60_000 },
  { match: /\/sign-up\b/, bucket: 'auth:sign-up', max: 5, windowMs: 60 * 60_000 },
  { match: /\/(forget|forgot)-password\b/, bucket: 'auth:forgot', max: 5, windowMs: 15 * 60_000 },
  { match: /\/reset-password\b/, bucket: 'auth:reset', max: 5, windowMs: 15 * 60_000 },
  { match: /\/magic-link\b/, bucket: 'auth:magic', max: 5, windowMs: 15 * 60_000 },
];

export async function POST(req: Request) {
  const { pathname } = new URL(req.url);
  const rule = LIMITS.find((r) => r.match.test(pathname));
  if (rule) {
    try {
      await rateLimit(rule.bucket, rule.max, rule.windowMs);
    } catch {
      // Better-Auth clients surface `message` from JSON error bodies.
      return Response.json(
        { message: 'Too many attempts. Please wait a few minutes and try again.' },
        { status: 429 },
      );
    }
  }
  return handlers.POST(req);
}
