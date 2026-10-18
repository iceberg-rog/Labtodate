import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { uploadObject } from '@/lib/storage/s3';
import { readVerifiedUpload, type UploadKind } from '@/lib/storage/file-type';
import { proofKeyOf } from './rules';

/**
 * Payment receipts of an order (buyer uploads, staff-attached proofs). The file
 * type is taken from the bytes, never from the declared type or the name, and
 * every receipt event is kept as a PaymentProof row — Order.paymentProofUrl
 * only points at the latest one, so earlier receipts stay viewable (the
 * /api/order-proof proxy authorises by these rows).
 */

export const RECEIPT_MAX_BYTES = 8_000_000;
export const RECEIPT_KINDS: readonly UploadKind[] = ['pdf', 'jpeg', 'png', 'webp'];
export const RECEIPT_TYPE_MESSAGE = 'The receipt is not a PDF or image — upload the bank’s transfer confirmation as a PDF, JPG, PNG or WEBP file.';

export type StoredReceipt = { ok: true; key: string; url: string; fileName: string | null } | { ok: false; code: 'large' | 'type'; message: string };

/** Check a receipt by its bytes and store it in the private order-proofs/ prefix. */
export async function storeReceiptFile(file: File, orderNumber: string): Promise<StoredReceipt> {
  if (file.size > RECEIPT_MAX_BYTES) return { ok: false, code: 'large', message: 'Receipt file too large (max 8 MB).' };
  const checked = await readVerifiedUpload(file, { allow: RECEIPT_KINDS, maxBytes: RECEIPT_MAX_BYTES, label: 'Receipt' });
  if (!checked.ok) return { ok: false, code: 'type', message: RECEIPT_TYPE_MESSAGE };
  const { buf, mime, ext } = checked.upload;
  const key = `order-proofs/${orderNumber.replace(/[^A-Za-z0-9-]/g, '')}-${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`;
  const { url } = await uploadObject(key, buf, mime);
  const fileName = file.name.replace(/[\\/\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200) || null;
  return { ok: true, key, url, fileName };
}

export type ReceiptEventKind = 'SUBMITTED' | 'REJECTED' | 'PART' | 'MANUAL';

/**
 * One receipt event (PaymentProof row): SUBMITTED (buyer upload), REJECTED
 * (staff rejected it, with the reason), PART (booked as a part payment),
 * MANUAL (staff attached it when booking a payment). `actorId` is who caused
 * the event (the uploader, or the staff member who decided). The file name of
 * a later event is copied from the receipt's upload.
 */
export async function recordReceiptEvent(
  db: Prisma.TransactionClient | typeof prisma,
  e: { orderId: string; urlOrKey: string | null | undefined; kind: ReceiptEventKind; fileName?: string | null; amountCents?: number | null; actorId?: string | null; rejectedReason?: string | null },
): Promise<void> {
  const key = proofKeyOf(e.urlOrKey);
  if (!key) return;
  let fileName = e.fileName ?? null;
  if (fileName === null && e.kind !== 'SUBMITTED' && e.kind !== 'MANUAL') {
    fileName = (await db.paymentProof.findFirst({ where: { orderId: e.orderId, key, fileName: { not: null } }, select: { fileName: true } }))?.fileName ?? null;
  }
  await db.paymentProof.create({
    data: {
      orderId: e.orderId,
      key,
      kind: e.kind,
      fileName,
      amountCents: e.amountCents ?? null,
      uploadedById: e.actorId ?? null,
      rejectedReason: e.rejectedReason ? e.rejectedReason.slice(0, 500) : null,
    },
  });
}
