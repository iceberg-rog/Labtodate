import { NextResponse } from 'next/server';
import type { IssuedDocument } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getAdminCaps, getServerSession } from '@/lib/auth-server';
import { capsAllow } from '@/lib/capabilities';
import { documentFileName, documentPdf, snapshotOf } from './issue';
import { htmlToPdf, PdfRenderError } from './pdf';
import { pdfFooter, renderDocumentHtml } from './render';
import type { DocSnapshot } from './types';

/**
 * Shared HTTP plumbing for document routes: who may open a document, and the
 * PDF / HTML responses (the HTML is the same page the PDF is printed from,
 * served with a CSP that allows no scripts and no network requests).
 */

export async function canOpenDocument(doc: Pick<IssuedDocument, 'sourcingRequestId' | 'orderId' | 'kind'>): Promise<boolean> {
  const session = await getServerSession();
  if (!session?.user) return false;
  if (session.user.role === 'ADMIN') {
    const caps = await getAdminCaps();
    if (capsAllow(caps, doc.kind === 'QUOTE' ? 'quotes:view' : 'orders:view') || capsAllow(caps, 'documents:edit')) return true;
  }
  if (doc.sourcingRequestId) {
    const sr = await prisma.sourcingRequest.findUnique({
      where: { id: doc.sourcingRequestId },
      select: { submittedById: true, buyerEmail: true, assignedToId: true },
    });
    if (sr && (sr.submittedById === session.user.id || sr.buyerEmail === session.user.email || sr.assignedToId === session.user.id)) return true;
  }
  if (doc.orderId) {
    const order = await prisma.order.findUnique({ where: { id: doc.orderId }, select: { buyerId: true } });
    if (order && order.buyerId === session.user.id) return true;
  }
  return false;
}

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'",
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, { status: 200, headers: HTML_HEADERS });
}

export function pdfResponse(pdf: Buffer, filename: string, download: boolean): NextResponse {
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function pdfFailed(e: unknown): NextResponse {
  const msg = e instanceof PdfRenderError ? e.message : 'The PDF could not be made right now.';
  return new NextResponse(`The PDF could not be made right now (${msg}). Try again in a minute; the document itself is safe.`, {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30' },
  });
}

export async function serveIssued(doc: IssuedDocument, format: string | null, download: boolean): Promise<NextResponse> {
  const snap = snapshotOf(doc);
  if (format === 'html') return htmlResponse(renderDocumentHtml(snap));
  try {
    return pdfResponse(await documentPdf(doc), documentFileName(snap), download);
  } catch (e) {
    return pdfFailed(e);
  }
}

export async function serveSnapshot(snap: DocSnapshot, format: string | null, download: boolean): Promise<NextResponse> {
  const html = renderDocumentHtml(snap);
  if (format === 'html') return htmlResponse(html);
  try {
    const { footerText, pageLabel } = pdfFooter(snap);
    return pdfResponse(await htmlToPdf(html, { footerText, pageLabel }), documentFileName(snap), download);
  } catch (e) {
    return pdfFailed(e);
  }
}

export const notFound = () => NextResponse.json({ error: 'not found' }, { status: 404 });
