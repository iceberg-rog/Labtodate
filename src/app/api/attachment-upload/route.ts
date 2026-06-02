import { NextResponse } from 'next/server';
import { uploadObject, supportAttachmentKey } from '@/lib/storage/s3';
import { rateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
];

/**
 * Support / ticket attachment upload.
 * Stores under the PRIVATE `support-att/<unguessable>.<ext>` prefix and
 * returns a proxied URL that the /api/support-attachment route auth-gates
 * before issuing a short-lived presigned S3 URL. The raw S3 URL is never
 * exposed to the client.
 */
export async function POST(req: Request) {
  try {
    rateLimit('attachment-upload');
  } catch {
    return NextResponse.json({ error: 'Too many uploads, slow down.' }, { status: 429 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'no file' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'File too large (max 10 MB).' }, { status: 400 });
  }
  if (!ALLOWED.includes(file.type)) {
    return NextResponse.json(
      { error: 'Only images and PDF are allowed.' },
      { status: 400 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const key = supportAttachmentKey(file.name);
  await uploadObject(key, buf, file.type);
  const proxiedUrl = `/api/support-attachment/${key}`;
  return NextResponse.json({ url: proxiedUrl, name: file.name, type: file.type });
}
