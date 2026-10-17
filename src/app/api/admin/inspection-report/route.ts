import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { uploadObject } from '@/lib/storage/s3';
import { readVerifiedUpload } from '@/lib/storage/file-type';
import { getServerSession, hasCapability } from '@/lib/auth-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Upload an inspection report (PDF or photo of it) for a product. Stored under
 * the private `inspection-reports/` prefix and served by
 * /api/inspection-report/<key> only while a published product references it.
 */
export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session || session.user.role !== 'ADMIN' || !(await hasCapability('products:edit'))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file was sent.' }, { status: 400 });
  const checked = await readVerifiedUpload(file, { allow: ['pdf', 'jpeg', 'png', 'webp'], maxBytes: MAX_BYTES, label: 'Report' });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  const key = `inspection-reports/${randomBytes(16).toString('hex')}.${checked.upload.ext}`;
  await uploadObject(key, checked.upload.buf, checked.upload.mime);
  return NextResponse.json({ url: `/api/inspection-report/${key}` });
}
