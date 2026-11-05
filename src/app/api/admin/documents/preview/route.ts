import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getServerSession, hasCapability } from '@/lib/auth-server';
import { htmlResponse, pdfFailed, pdfResponse } from '@/lib/documents/http';
import { previewSnapshot } from '@/lib/documents/preview';
import { htmlToPdf } from '@/lib/documents/pdf';
import { pdfFooter, renderDocumentHtml } from '@/lib/documents/render';
import { asLang, DOC_KINDS, type DocKind } from '@/lib/documents/types';
import { documentFileName } from '@/lib/documents/issue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live preview for Admin → Documents → Templates: renders the document with
 * the admin's UNSAVED edits (validated like a save) as the HTML page the PDF
 * is printed from, or as the real PDF.
 */
type Stash = { at: number; body: Record<string, unknown> };
const g = globalThis as unknown as { __docPreviewStash?: Map<string, Stash> };
const stash: Map<string, Stash> = (g.__docPreviewStash ??= new Map());
const STASH_MS = 10 * 60_000;

async function allowed(): Promise<boolean> {
  const session = await getServerSession();
  return !!session?.user && session.user.role === 'ADMIN' && (await hasCapability('documents:edit'));
}

/**
 * POST { kind, lang, source, override } → the HTML preview (?format=html),
 * or with { stash: true } → { id } for GET ?id= (the PDF in a new tab: the
 * site's CSP only lets same-origin URLs into frames and windows, so a blob:
 * URL cannot be used).
 */
export async function POST(req: NextRequest) {
  if (!(await allowed())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  if (body.stash) {
    const now = Date.now();
    for (const [k, v] of stash) if (now - v.at > STASH_MS) stash.delete(k);
    const id = randomUUID();
    stash.set(id, { at: now, body });
    return NextResponse.json({ id });
  }
  return render(req, body);
}

export async function GET(req: NextRequest) {
  if (!(await allowed())) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const hit = stash.get(req.nextUrl.searchParams.get('id') ?? '');
  if (!hit) return new NextResponse('This preview link has expired. Click “View PDF” again.', { status: 410 });
  return render(req, hit.body);
}

async function render(req: NextRequest, body: Record<string, unknown>) {
  const kind = (DOC_KINDS.includes(body.kind as DocKind) ? body.kind : 'QUOTE') as DocKind;
  const snap = await previewSnapshot({
    kind,
    lang: asLang(body.lang),
    source: typeof body.source === 'string' ? body.source : 'sample:nl',
    override: (body.override ?? {}) as Record<string, unknown>,
  });
  const html = renderDocumentHtml(snap);
  if (req.nextUrl.searchParams.get('format') === 'html') return htmlResponse(html);
  try {
    const { footerText, pageLabel } = pdfFooter(snap);
    return pdfResponse(await htmlToPdf(html, { footerText, pageLabel }), documentFileName(snap), false);
  } catch (e) {
    return pdfFailed(e);
  }
}
