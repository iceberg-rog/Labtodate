import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { canOpenDocument, notFound, serveIssued } from '@/lib/documents/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * An issued document (quote, invoice, receipt): the stored PDF, or with
 * ?format=html the page it was printed from (on-screen copy + Print).
 * 404 for anyone who may not see it — never reveals that it exists.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const doc = await prisma.issuedDocument.findUnique({ where: { id } });
  if (!doc || !(await canOpenDocument(doc))) return notFound();
  const sp = req.nextUrl.searchParams;
  return serveIssued(doc, sp.get('format'), sp.get('download') === '1');
}
