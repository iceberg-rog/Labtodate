import { NextResponse } from 'next/server';
import { uploadObject } from '@/lib/storage/s3';
import { readVerifiedUpload } from '@/lib/storage/file-type';
import { getServerSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { rateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — avatars stay small

export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: 'forbidden' }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'no file' }, { status: 400 });
  // Type and extension come from the file's bytes, not the browser's claim.
  const checked = await readVerifiedUpload(file, { allow: ['jpeg', 'png', 'webp'], maxBytes: MAX_BYTES, label: 'Photo' });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  // Only files that passed the checks count, and the budget is per account,
  // so a few rejected picks (or colleagues on one office IP) don't lock
  // someone out of changing their photo.
  try {
    await rateLimit(`avatar-upload:${session.user.id}`);
  } catch {
    return NextResponse.json({ error: 'Too many uploads, slow down.' }, { status: 429 });
  }

  const { buf, mime, ext } = checked.upload;
  const stamp = Date.now().toString(36);
  const key = `products/avatars/${session.user.id}-${stamp}.${ext}`;
  const { url } = await uploadObject(key, buf, mime);
  await prisma.user.update({ where: { id: session.user.id }, data: { image: url } });
  return NextResponse.json({ url });
}
