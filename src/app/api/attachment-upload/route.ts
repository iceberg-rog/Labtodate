import { NextResponse } from 'next/server';
import { IMAGE_KINDS, readVerifiedUpload } from '@/lib/storage/file-type';
import { uploadObject, supportAttachmentKey } from '@/lib/storage/s3';
import { rateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Support / ticket attachment upload.
 * Stores under the PRIVATE `support-att/<unguessable>.<ext>` prefix and
 * returns a proxied URL that the /api/support-attachment route auth-gates
 * before issuing a short-lived presigned S3 URL. The raw S3 URL is never
 * exposed to the client.
 */
export async function POST(req: Request) {
  try {
    await rateLimit('attachment-upload');
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
  // Type and extension come from the file's bytes, not the browser's claim.
  const checked = await readVerifiedUpload(file, { allow: [...IMAGE_KINDS, 'pdf'], maxBytes: MAX_BYTES });
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: 400 });
  }

  const { buf, mime, ext } = checked.upload;
  const key = supportAttachmentKey(ext);
  await uploadObject(key, buf, mime);
  const proxiedUrl = `/api/support-attachment/${key}`;
  return NextResponse.json({ url: proxiedUrl, name: file.name, type: mime });
}
