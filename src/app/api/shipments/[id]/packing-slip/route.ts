import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession, hasCapability } from '@/lib/auth-server';
import { packingSlipPdf } from '@/lib/fulfilment/packing-slip';
import { logError } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Packing slip (delivery note, no prices) of one shipment as a PDF — staff
 * only (orders:view). Not a fiscal document: rendered on demand from the
 * shipment record (lib/fulfilment/packing-slip.ts).
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await getServerSession();
  if (!session?.user || session.user.role !== 'ADMIN' || !(await hasCapability('orders:view'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  try {
    const pdf = await packingSlipPdf(id);
    if (!pdf) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const download = req.nextUrl.searchParams.get('download') === '1';
    return new NextResponse(new Uint8Array(pdf.bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${pdf.filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    await logError('packing-slip', e);
    return new NextResponse('The packing slip could not be generated right now (PDF engine). Try again in a minute; the error is logged.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
