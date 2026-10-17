import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from '@/lib/auth-server';
import { streamSupportAttachment } from '@/lib/storage/s3';
import { storedFileHeaders } from '@/lib/storage/file-type';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Inspection reports linked from product pages. Public while a PUBLISHED
 * product references the report (admins can always open it); everything else
 * is a 404. PDFs are served inline without the sandbox CSP that /media/ uses
 * (Chrome refuses to show a PDF in a sandboxed document).
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ key: string[] }> }) {
  const { key: segments = [] } = await props.params;
  const key = segments.join('/');
  if (!/^inspection-reports\/[a-f0-9]{32}\.(pdf|jpg|png|webp)$/.test(key)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const url = `/api/inspection-report/${key}`;
  const product = await prisma.product.findFirst({ where: { inspectionReportUrl: url }, select: { status: true } });
  if (!product) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (product.status !== 'PUBLISHED') {
    const session = await getServerSession();
    if (session?.user.role !== 'ADMIN') return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  try {
    const { body, contentType, contentLength } = await streamSupportAttachment(key);
    if (!body) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return new NextResponse(body, { status: 200, headers: storedFileHeaders(contentType, contentLength, 'public, max-age=300') });
  } catch {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
}
