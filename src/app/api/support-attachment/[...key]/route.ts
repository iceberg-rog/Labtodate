import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { streamSupportAttachment } from '@/lib/storage/s3';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Auth-gated proxy for ticket attachments stored under `support-att/*`.
 *
 * Allowed callers:
 *   - Admin role (any tickets:view-capable user)
 *   - The buyer who submitted the ticket containing this attachment
 *     (matched by submittedById OR ticket.email == session.user.email)
 *   - An anonymous request that passes `?t=<accessToken>` matching the GUEST
 *     ticket the attachment belongs to.
 *
 * On success: 302 redirect to a 60s-presigned S3 URL.
 * Otherwise: 404 (never reveal whether the key exists vs is forbidden).
 */
export async function GET(req: NextRequest, props: { params: Promise<{ key: string[] }> }) {
  const params = await props.params;
  const segments = params.key ?? [];
  if (segments.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const key = segments.join('/');

  // The proxy is ONLY for the private support-att prefix. Block anything else
  // so this route can't be turned into a generic S3 reader.
  if (!key.startsWith('support-att/')) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // The same proxy serves attachments for BOTH SupportMessage and QuoteMessage.
  // Look up whichever parent contains this key.
  const proxiedUrl = `/api/support-attachment/${key}`;
  const session = await getServerSession();
  const userId = session?.user.id ?? null;
  const userEmail = session?.user.email ?? null;
  const isAdmin = session?.user.role === 'ADMIN';
  const queryToken = req.nextUrl.searchParams.get('t');

  type OwnerCtx = {
    submittedById: string | null;
    contactEmail: string | null;
    assignedToId?: string | null;
    accessToken: string | null;
    accessTokenExpiresAt: Date | null;
  };

  // 1) Support ticket message
  const ticketMsg = await prisma.supportMessage.findFirst({
    where: { attachments: { has: proxiedUrl } },
    select: {
      ticket: {
        select: {
          id: true, email: true, submittedById: true,
          accessToken: true, accessTokenExpiresAt: true,
        },
      },
    },
  });

  // 2) Quote message
  const quoteMsg = !ticketMsg
    ? await prisma.quoteMessage.findFirst({
        where: { attachments: { has: proxiedUrl } },
        select: {
          sourcingRequest: {
            select: {
              id: true, buyerEmail: true, submittedById: true, assignedToId: true,
              accessToken: true, accessTokenExpiresAt: true,
            },
          },
        },
      })
    : null;

  if (!ticketMsg?.ticket && !quoteMsg?.sourcingRequest) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const owner: OwnerCtx = ticketMsg?.ticket
    ? {
        submittedById: ticketMsg.ticket.submittedById,
        contactEmail: ticketMsg.ticket.email,
        accessToken: ticketMsg.ticket.accessToken,
        accessTokenExpiresAt: ticketMsg.ticket.accessTokenExpiresAt,
      }
    : {
        submittedById: quoteMsg!.sourcingRequest.submittedById,
        contactEmail: quoteMsg!.sourcingRequest.buyerEmail,
        assignedToId: quoteMsg!.sourcingRequest.assignedToId,
        accessToken: quoteMsg!.sourcingRequest.accessToken,
        accessTokenExpiresAt: quoteMsg!.sourcingRequest.accessTokenExpiresAt,
      };

  const isBuyer =
    !!userId &&
    ((!!owner.submittedById && owner.submittedById === userId) ||
      (!!owner.contactEmail && !!userEmail && owner.contactEmail.toLowerCase() === userEmail.toLowerCase()));
  const isAssignedSeller = !!userId && !!owner.assignedToId && owner.assignedToId === userId;

  let allowed = isAdmin || isBuyer || isAssignedSeller;

  if (!allowed && queryToken && owner.accessToken && queryToken === owner.accessToken) {
    const exp = owner.accessTokenExpiresAt;
    if (!exp || exp.getTime() > Date.now()) allowed = true;
  }

  if (!allowed) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // Stream the bytes through our auth-gated route — the browser never sees
  // an S3 URL. Works even when the public reverse-proxy path differs from
  // the internal MinIO path (no signature-mismatch headache).
  try {
    const { body, contentType, contentLength } = await streamSupportAttachment(key);
    if (!body) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const headers: Record<string, string> = {
      'content-type': contentType,
      'cache-control': 'private, max-age=300',
    };
    if (typeof contentLength === 'number') headers['content-length'] = String(contentLength);
    return new NextResponse(body, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}
