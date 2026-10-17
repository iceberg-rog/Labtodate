import type { NextRequest } from 'next/server';
import { handleDocumentRequest } from '@/lib/documents/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The same document as clean, self-contained HTML (no site chrome) — auth-checked. */
export async function GET(req: NextRequest, props: { params: Promise<{ kind: string; orderNumber: string }> }) {
  return handleDocumentRequest(req, await props.params, 'preview');
}
