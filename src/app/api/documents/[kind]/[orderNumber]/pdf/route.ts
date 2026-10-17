import type { NextRequest } from 'next/server';
import { handleDocumentRequest } from '@/lib/documents/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Download an order's proforma invoice / invoice as a PDF (auth-checked). */
export async function GET(req: NextRequest, props: { params: Promise<{ kind: string; orderNumber: string }> }) {
  return handleDocumentRequest(req, await props.params, 'pdf');
}
