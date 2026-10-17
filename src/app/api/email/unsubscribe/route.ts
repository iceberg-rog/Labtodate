import { NextResponse, type NextRequest } from 'next/server';
import { setMarketingConsent, verifyUnsubscribeToken } from '@/lib/security/marketing';
import { clientIpFrom } from '@/lib/ratelimit';
import { auditAs } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Unsubscribe from marketing e-mail without signing in.
 *  - POST with body "List-Unsubscribe=One-Click": RFC 8058 one-click, sent by
 *    the mail client (Gmail / Outlook "Unsubscribe" button) → 200.
 *  - POST from our /email/unsubscribe page → back to that page, "done".
 *  - GET (link previews / scanners must not unsubscribe anyone) → the page.
 * The token is an HMAC of the address, so it only works for that address.
 */
export async function POST(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('t');
  const target = verifyUnsubscribeToken(token);
  const form = await req.formData().catch(() => null);
  const oneClick = String(form?.get('List-Unsubscribe') ?? '') === 'One-Click';
  if (!target) {
    return oneClick
      ? new NextResponse('Invalid unsubscribe link.', { status: 400 })
      : NextResponse.redirect(new URL('/email/unsubscribe?error=1', req.url), 303);
  }
  const ip = clientIpFrom(req.headers);
  await setMarketingConsent({ email: target.email }, false, oneClick ? 'one-click' : 'unsubscribe-link', {
    ip,
    userAgent: req.headers.get('user-agent'),
  });
  await auditAs({ email: target.email, ip }, 'marketing.unsubscribe', target.email, oneClick ? 'one-click (mail client)' : 'unsubscribe page');
  if (oneClick) return new NextResponse('You are unsubscribed.', { status: 200 });
  return NextResponse.redirect(new URL(`/email/unsubscribe?t=${encodeURIComponent(token!)}&done=1`, req.url), 303);
}

export async function GET(req: NextRequest) {
  const t = req.nextUrl.searchParams.get('t') ?? '';
  return NextResponse.redirect(new URL(`/email/unsubscribe?t=${encodeURIComponent(t)}`, req.url), 303);
}
