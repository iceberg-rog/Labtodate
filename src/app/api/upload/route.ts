import { NextResponse } from 'next/server';
import { uploadObject, safeKey } from '@/lib/storage/s3';
import { getServerSession } from '@/lib/auth-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 8 * 1024 * 1024;          // 8 MB
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];

export async function POST(req: Request) {
  const session = await getServerSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  if (!session || (role !== 'SELLER' && role !== 'ADMIN')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'no file' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'too large (max 8 MB)' }, { status: 400 });
  }
  if (!ALLOWED.includes(file.type)) {
    return NextResponse.json({ error: `unsupported type ${file.type}` }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const key = safeKey(file.name);
  const { url } = await uploadObject(key, buf, file.type);
  return NextResponse.json({ url, key });
}
