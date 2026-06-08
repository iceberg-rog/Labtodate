import { NextResponse } from 'next/server';
import { uploadObject } from '@/lib/storage/s3';
import { getServerSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { rateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — avatars stay small
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: 'forbidden' }, { status: 401 });

  try {
    rateLimit('avatar-upload');
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
  if (!(file instanceof File)) return NextResponse.json({ error: 'no file' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Photo too large (max 2 MB).' }, { status: 400 });
  if (!ALLOWED.includes(file.type)) return NextResponse.json({ error: 'Only JPG, PNG or WEBP allowed.' }, { status: 400 });

  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const stamp = Date.now().toString(36);
  const key = `products/avatars/${session.user.id}-${stamp}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  const { url } = await uploadObject(key, buf, file.type);
  await prisma.user.update({ where: { id: session.user.id }, data: { image: url } });
  return NextResponse.json({ url });
}
