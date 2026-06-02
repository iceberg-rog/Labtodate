import { NextResponse } from 'next/server';
import { uploadObject, safeKey } from '@/lib/storage/s3';
import { rateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Public (no-account) image upload for the "Sell your equipment" form.
// Rate-limited and strictly constrained because it is unauthenticated.
export async function POST(req: Request) {
  try {
    rateLimit('sell-upload');
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
    return NextResponse.json({ error: 'Image too large (max 8 MB).' }, { status: 400 });
  }
  if (!ALLOWED.includes(file.type)) {
    return NextResponse.json({ error: `Unsupported image type ${file.type}.` }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const key = safeKey(`sell/${file.name}`);
  const { url } = await uploadObject(key, buf, file.type);
  return NextResponse.json({ url });
}
