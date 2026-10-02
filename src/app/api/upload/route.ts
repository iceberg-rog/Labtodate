import { NextResponse } from 'next/server';
import { uploadObject, safeKey } from '@/lib/storage/s3';
import { IMAGE_KINDS, readVerifiedUpload } from '@/lib/storage/file-type';
import { getServerSession } from '@/lib/auth-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 8 * 1024 * 1024;          // 8 MB

export async function POST(req: Request) {
  const session = await getServerSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!session || (role !== 'SELLER' && role !== 'ADMIN')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
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
  // Type and extension come from the file's bytes, not the browser's claim:
  // SVG (script) and anything mislabeled as an image are refused.
  const checked = await readVerifiedUpload(file, { allow: IMAGE_KINDS, maxBytes: MAX_BYTES, label: 'Image' });
  if (!checked.ok) {
    return NextResponse.json({ error: checked.error }, { status: 400 });
  }

  const { buf, mime, ext } = checked.upload;
  const key = safeKey(ext);
  const { url } = await uploadObject(key, buf, mime);
  return NextResponse.json({ url, key });
}
