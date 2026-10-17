import { clientIpFrom } from '@/lib/ratelimit';
import { getSecurityPolicy } from '@/lib/security/policy';
import { allowHit } from '@/lib/security/throttle';
import { CAPTCHA_PURPOSES, challengeFactorFor, issueChallenge, type CaptchaPurpose } from '@/lib/security/captcha';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/captcha?purpose=signup — a fresh signed ALTCHA challenge for the
 * bot-check widget (src/components/security/Captcha.tsx). Networks that keep
 * asking get bigger puzzles (CAPTCHA_ESCALATE_AFTER); issuing is cheap but
 * still capped per IP.
 */
export async function GET(req: Request) {
  const purpose = new URL(req.url).searchParams.get('purpose') ?? '';
  if (!(CAPTCHA_PURPOSES as readonly string[]).includes(purpose)) {
    return Response.json({ error: 'unknown purpose' }, { status: 400 });
  }
  const ip = clientIpFrom(req.headers);
  const hit = await allowHit(`rl:captcha-issue:${ip}`, 120, 10 * 60_000);
  if (!hit.allowed) {
    return Response.json(
      { error: 'Too many requests. Please wait a few minutes and try again.' },
      { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil((hit.resetAt.getTime() - Date.now()) / 1000))), 'Cache-Control': 'no-store' } },
    );
  }
  const policy = await getSecurityPolicy();
  const factor = await challengeFactorFor(ip, policy);
  const challenge = await issueChallenge(purpose as CaptchaPurpose, policy, factor);
  return Response.json(challenge, { headers: { 'Cache-Control': 'no-store' } });
}
