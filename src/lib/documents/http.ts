import { NextResponse } from 'next/server';
import type { FiscalDocument } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getServerSession } from '@/lib/auth-server';
import { capsAllow } from '@/lib/capabilities';
import { escapeHtml } from '@/lib/email-html';
import { logError } from '@/lib/observability';
import { documentHref, documentNumberHref } from './index';
import {
  documentFilename,
  documentHtml,
  ensureDocumentPdf,
  freezeLegacyDocuments,
  getOrderDocuments,
  issueProforma,
  prePaymentHoldMessage,
} from './issue';
import { fmtDocDate } from './render';

/**
 * Shared handler behind /api/documents/[kind]/[ref]/{pdf,preview}.
 *
 *  - kind proforma | invoice | credit-note: `ref` is the order number;
 *  - kind doc: `ref` is a document number (any issued document, incl. older
 *    proforma revisions and voided ones — the record).
 *
 * `pdf` streams the STORED bytes of the issued document (integrity-checked);
 * `preview` renders the same frozen snapshot as HTML. Nothing is ever built
 * from live order data here.
 *
 * Access: the order's buyer, or an admin holding `orders:view`. Anyone else
 * gets the same 404 as a missing document (no existence oracle).
 */

const SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function textPage(status: number, title: string, body: string, links: Array<{ href: string; label: string }> = []): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:#f4f4f0;color:#111827;margin:0;padding:48px 16px}
.card{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 12px;line-height:1.5}a{color:#0E4F40;font-weight:600}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${links.map((l) => `<p><a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a></p>`).join('')}</div></body></html>`;
  return new NextResponse(html, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

type Kind = 'proforma' | 'invoice' | 'credit-note' | 'doc';

export async function handleDocumentRequest(
  req: Request,
  params: { kind: string; orderNumber: string },
  format: 'pdf' | 'preview',
): Promise<NextResponse> {
  const kind = (['proforma', 'invoice', 'credit-note', 'doc'] as const).find((k) => k === params.kind) as Kind | undefined;
  const ref = decodeURIComponent(params.orderNumber || '').trim();
  if (!kind || !/^[A-Za-z0-9-]{4,60}$/.test(ref)) {
    return textPage(404, 'Document not found', 'This document does not exist.');
  }

  const session = await getServerSession();
  if (!session) {
    const url = new URL(req.url);
    const signIn = new URL('/auth/sign-in', url.origin);
    signIn.searchParams.set('redirect', url.pathname + url.search);
    return NextResponse.redirect(signIn, 303);
  }

  // Resolve the order (and, for kind=doc, the document).
  let byNumber: FiscalDocument | null = null;
  if (kind === 'doc') byNumber = await prisma.fiscalDocument.findUnique({ where: { number: ref } });
  const orderWhere = kind === 'doc' ? (byNumber?.orderId ? { id: byNumber.orderId } : null) : { orderNumber: ref };
  const order = orderWhere
    ? await prisma.order.findUnique({
        where: orderWhere,
        select: { id: true, buyerId: true, orderNumber: true, status: true, holdReason: true, holdNote: true, paidAt: true, openHolds: true },
      })
    : null;

  const role = (session.user as { role?: string }).role;
  let isAdmin = false;
  if (role === 'ADMIN') {
    const me = await prisma.user.findUnique({ where: { id: session.user.id }, select: { adminCaps: true } });
    isAdmin = capsAllow(me?.adminCaps ?? [], 'orders:view');
  }
  const allowed = order ? order.buyerId === session.user.id || isAdmin : !!byNumber && isAdmin;
  if (!allowed || (kind !== 'doc' && !order) || (kind === 'doc' && !byNumber)) {
    return textPage(404, 'Document not found', 'This document does not exist or you do not have access to it.');
  }
  const back = order
    ? isAdmin && order.buyerId !== session.user.id ? `/admin/orders/${order.id}` : `/app/orders/${order.orderNumber}`
    : '/admin/orders';
  // Unpaid order on a pre-payment hold (shipping / VAT / compliance / address):
  // no payment request for the buyer yet — even when a proforma number was
  // already reserved (quote accepted for a REVIEW country). Staff still see it.
  if (order && !isAdmin && order.status === 'PENDING_PAYMENT' && (kind === 'proforma' || byNumber?.kind === 'PROFORMA')) {
    const held = prePaymentHoldMessage(order);
    if (held) return textPage(409, 'Proforma not available yet', held, [{ href: back, label: 'Go back' }]);
  }

  // A void or replaced proforma is not payable: the buyer never gets its bytes
  // (they say "Payment request" with the IBAN and amount) — only what to do.
  if (byNumber && byNumber.kind === 'PROFORMA' && (byNumber.voidedAt || byNumber.supersededById) && !isAdmin) {
    const next = byNumber.supersededById ? await prisma.fiscalDocument.findUnique({ where: { id: byNumber.supersededById }, select: { number: true, voidedAt: true } }) : null;
    return textPage(
      410,
      `Proforma ${byNumber.number} is no longer payable`,
      byNumber.voidedAt
        ? `This proforma was voided on ${fmtDocDate(byNumber.voidedAt)}${byNumber.voidReason ? ` (${byNumber.voidReason})` : ''}. No payment is due for it — please do not transfer money for it.`
        : `This proforma was replaced by ${next?.number ?? 'a newer revision'}. Please do not pay this one${next && !next.voidedAt ? ` — pay ${next.number}, on your order page` : ''}.`,
      [{ href: back, label: 'Go to your order' }],
    );
  }

  let doc: FiscalDocument | null = byNumber;
  if (!doc && order) {
    let docs = await getOrderDocuments(order.id);
    if (kind === 'proforma') {
      if (!docs.proforma) {
        await freezeLegacyDocuments(order.id).catch((e) => logError('documents.freezeLegacy', e));
        docs = await getOrderDocuments(order.id);
      }
      if (!docs.proforma && order.status === 'PENDING_PAYMENT' && order.buyerId !== session.user.id) {
        // Staff opening a link never creates a fiscal document: issuing is an
        // explicit action on the order page (Documents → Issue proforma).
        return textPage(
          404,
          'No proforma issued yet',
          `No proforma has been issued for order ${order.orderNumber}. Opening a document never issues one — issue it on the order page (Documents → “Issue proforma”) when the order is ready for payment.`,
          [{ href: back, label: 'Open the order' }],
        );
      }
      if (!docs.proforma && order.status === 'PENDING_PAYMENT') {
        // The buyer asks for their own payment request (their payment page issues it the same way).
        const issued = await issueProforma(order.id);
        if (!issued.ok) return textPage(409, 'Proforma not available', issued.message, [{ href: back, label: 'Go back' }]);
        doc = issued.document;
      } else if (!docs.proforma) {
        const last = docs.proformaHistory.at(-1);
        if (last) {
          return textPage(
            410,
            `Proforma ${last.number} is no longer payable`,
            last.voidedAt
              ? `This proforma was voided on ${fmtDocDate(last.voidedAt)}${last.voidReason ? ` (${last.voidReason})` : ''}. No payment is due for it — please do not transfer money for it.`
              : `This proforma was replaced by a newer revision.`,
            isAdmin ? [{ href: documentNumberHref(last.number, 'pdf'), label: `Download the archived copy of ${last.number}` }, { href: back, label: 'Go back' }] : [{ href: back, label: 'Go back' }],
          );
        }
        return textPage(404, 'No proforma', `Order ${order.orderNumber} has no proforma invoice.`, [{ href: back, label: 'Go back' }]);
      } else {
        doc = docs.proforma;
      }
    } else if (kind === 'invoice') {
      if (!docs.invoice) {
        await freezeLegacyDocuments(order.id).catch((e) => logError('documents.freezeLegacy', e));
        docs = await getOrderDocuments(order.id);
      }
      doc = docs.invoice;
      if (!doc) {
        const paid = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'].includes(order.status);
        const msg = !paid
          ? `There is no invoice for order ${order.orderNumber} yet: the invoice is issued once the payment is verified.`
          : isAdmin
            ? `The invoice for order ${order.orderNumber} has not been issued. ${order.holdNote ?? 'Open the order to issue it.'}`
            : `Your invoice for order ${order.orderNumber} is being prepared — our team is completing the VAT and billing details. You will receive it by email.`;
        return textPage(409, 'No invoice yet', msg, [
          ...(!paid ? [{ href: documentHref('proforma', order.orderNumber, 'pdf'), label: 'Download the proforma invoice' }] : []),
          { href: back, label: 'Go back' },
        ]);
      }
    } else {
      doc = docs.creditNotes.at(-1) ?? null;
      if (!doc) return textPage(404, 'No credit note', `Order ${order.orderNumber} has no credit note.`, [{ href: back, label: 'Go back' }]);
    }
  }
  if (!doc) return textPage(404, 'Document not found', 'This document does not exist.');

  if (format === 'preview') {
    const html = await documentHtml(doc);
    return new NextResponse(html, {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `inline; filename="${doc.number}.html"`,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'",
        'X-Frame-Options': 'SAMEORIGIN',
      },
    });
  }

  const pdf = await ensureDocumentPdf(doc.id);
  if (!pdf.ok) {
    await logError('documents.pdf', new Error(`${doc.number}: ${pdf.error}`));
    if (pdf.reason === 'INTEGRITY' || pdf.reason === 'MISSING') {
      // Never served, never silently re-made: the stored original is the record.
      // Admins were alerted (ensureDocumentPdf).
      return textPage(
        503,
        `${doc.number} is unavailable`,
        isAdmin
          ? `The stored PDF of ${doc.number} ${pdf.reason === 'INTEGRITY' ? 'failed its integrity check (it does not match the sha256 recorded when it was issued)' : 'could not be read from storage'}. It is not served. Restore the original object from the backup or the bucket's version history — never re-issue it. Every admin was alerted.`
          : `This document is unavailable right now: its stored copy could not be verified. Our team has been alerted and will contact you — please do not rely on a copy of this document from anywhere else meanwhile.`,
        [{ href: back, label: 'Go back' }],
      );
    }
    return textPage(
      503,
      'The PDF could not be generated right now',
      `Please try again in a minute. You can still open ${doc.number} in your browser and print it from there.`,
      [{ href: documentNumberHref(doc.number, 'preview'), label: `Open ${doc.number}` }, { href: back, label: 'Go back' }],
    );
  }
  return new NextResponse(new Uint8Array(pdf.bytes), {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdf.bytes.length),
      'Content-Disposition': `attachment; filename="${documentFilename(doc)}"`,
      'X-Document-Sha256': pdf.sha256,
    },
  });
}
