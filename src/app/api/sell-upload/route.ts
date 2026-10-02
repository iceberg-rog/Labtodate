import { NextResponse } from 'next/server';
import { IMAGE_KINDS, readVerifiedUpload } from '@/lib/storage/file-type';
import { uploadObject, safeKey } from '@/lib/storage/s3';
import { rateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

// Public (no-account) image upload for the "Sell your equipment" form.
// Rate-limited and strictly constrained because it is unauthenticated. The
// form takes up to 8 photos, so the window allows a full set plus a few
// retries/replacements (the old default of 5 cut the 8-photo form short).
export async function POST(req: Request) {
  try {
    await rateLimit('sell-upload', 24, 10 * 60_000);
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
  // Type and extension come from the file's bytes, not the client's claimed
  // MIME or filename, so this public endpoint can't host arbitrary files.
  const checked = await readVerifiedUpload(file, { allow: IMAGE_KINDS, maxBytes: MAX_BYTES, label: 'Image' });
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: 400 });
  }

  const { buf, mime, ext } = checked.upload;
  const key = safeKey(ext);
  const { url } = await uploadObject(key, buf, mime);
  return NextResponse.json({ url });
}
