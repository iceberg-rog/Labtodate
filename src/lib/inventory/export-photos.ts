import { bucketKeyFromUrl, readObjectBytes } from '@/lib/storage/s3';
import type { InventoryRow } from './fields';

/**
 * Each row's main photo for the .xlsx export, at its original quality: the very bytes in the bucket (Excel keeps the
 * embedded file as it is and only shows it scaled into the cell). Only our own bucket objects are read; formats Excel
 * can not embed (WebP, AVIF) are left out, as are photos once the export's photo budget is spent, so a very large
 * export never takes the web container's memory down (the export itself still goes through, those rows without photo).
 */
export type ExportPhoto = { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif'; width: number; height: number };

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;   // one photo
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;  // all photos of one export
const CONCURRENCY = 6;

export async function loadExportPhotos(rows: InventoryRow[]): Promise<{ photos: Map<string, ExportPhoto>; skipped: number }> {
  const photos = new Map<string, ExportPhoto>();
  let total = 0, skipped = 0, next = 0;
  const work = rows.filter((r) => r.image);
  const one = async (row: InventoryRow) => {
    const key = bucketKeyFromUrl(row.image);
    if (!key || total >= MAX_TOTAL_BYTES) { skipped++; return; }
    try {
      const got = await readObjectBytes(key, MAX_PHOTO_BYTES);
      if (!got) { skipped++; return; }
      const info = imageInfo(got.bytes);
      if (!info || total + got.bytes.length > MAX_TOTAL_BYTES) { skipped++; return; }
      total += got.bytes.length;
      photos.set(row.id, { buffer: Buffer.from(got.bytes), ...info });
    } catch {
      skipped++;   // a missing or unreadable object: that row goes out without its photo
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, async () => {
    while (next < work.length) await one(work[next++]);
  }));
  return { photos, skipped };
}

/** Format and pixel size from the file's own header (JPEG, PNG, GIF), or null for anything else. */
export function imageInfo(b: Uint8Array): Omit<ExportPhoto, 'buffer'> | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
    const h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
    return w > 0 && h > 0 ? { extension: 'png', width: w, height: h } : null;
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const w = b[6] | (b[7] << 8), h = b[8] | (b[9] << 8);
    return w > 0 && h > 0 ? { extension: 'gif', width: w, height: h } : null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    // walk the JPEG segments to the first start-of-frame (SOF0..SOF15 except DHT/JPG/DAC)
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = (b[i + 5] << 8) | b[i + 6], w = (b[i + 7] << 8) | b[i + 8];
        return w > 0 && h > 0 ? { extension: 'jpeg', width: w, height: h } : null;
      }
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}
