/**
 * Upload type checks by file signature ("magic bytes").
 *
 * The browser-declared `File.type` and the filename extension are both
 * client-controlled, so every upload path takes the stored Content-Type and
 * extension from the bytes instead. Only raster images and PDF are recognised:
 * SVG, HTML and anything else is refused, because those can run script when
 * opened from the site's own /media origin.
 */

export type UploadKind = 'jpeg' | 'png' | 'webp' | 'gif' | 'pdf';

const KINDS: Record<UploadKind, { mime: string; ext: string; label: string }> = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', label: 'JPG' },
  png: { mime: 'image/png', ext: 'png', label: 'PNG' },
  webp: { mime: 'image/webp', ext: 'webp', label: 'WEBP' },
  gif: { mime: 'image/gif', ext: 'gif', label: 'GIF' },
  pdf: { mime: 'application/pdf', ext: 'pdf', label: 'PDF' },
};

export const IMAGE_KINDS: readonly UploadKind[] = ['jpeg', 'png', 'webp', 'gif'];

function hasBytesAt(buf: Uint8Array, offset: number, sig: string | number[]): boolean {
  const bytes = typeof sig === 'string' ? Array.from(sig, (c) => c.charCodeAt(0)) : sig;
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

/** The real type of an upload from its leading bytes, or null if it isn't one we accept. */
export function sniffUploadKind(buf: Uint8Array): UploadKind | null {
  if (hasBytesAt(buf, 0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (hasBytesAt(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (hasBytesAt(buf, 0, 'GIF87a') || hasBytesAt(buf, 0, 'GIF89a')) return 'gif';
  if (hasBytesAt(buf, 0, 'RIFF') && hasBytesAt(buf, 8, 'WEBP')) return 'webp';
  if (hasBytesAt(buf, 0, '%PDF-')) return 'pdf';
  return null;
}

export type VerifiedUpload = { buf: Buffer; mime: string; ext: string };

/**
 * Reads an uploaded File and checks its size and real type. Failures come back
 * as a readable message for the form, never a throw.
 */
export async function readVerifiedUpload(
  file: File,
  opts: { allow: readonly UploadKind[]; maxBytes: number; label?: string },
): Promise<{ ok: true; upload: VerifiedUpload } | { ok: false; error: string }> {
  const label = opts.label ?? 'File';
  if (file.size === 0) return { ok: false, error: `${label} is empty.` };
  if (file.size > opts.maxBytes) {
    const mb = Number((opts.maxBytes / (1024 * 1024)).toFixed(1));
    return { ok: false, error: `${label} too large (max ${mb} MB).` };
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const kind = sniffUploadKind(buf);
  if (!kind || !opts.allow.includes(kind)) {
    const labels = opts.allow.map((k) => KINDS[k].label);
    const list = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}` : labels[0];
    const noun = opts.allow.includes('pdf') ? 'files' : 'images';
    return { ok: false, error: `Unsupported file — only ${list} ${noun} are allowed.` };
  }
  const { mime, ext } = KINDS[kind];
  return { ok: true, upload: { buf, mime, ext } };
}

const INLINE_MIMES = new Set(Object.values(KINDS).map((k) => k.mime));

/** True for the content types the app ever lets a browser render inline. */
export function isInlineSafeMime(contentType: string): boolean {
  return INLINE_MIMES.has(contentType.split(';')[0].trim().toLowerCase());
}

// Same policy nginx sends on /media/: a stored file opened directly can show
// itself but never run script or load anything on this origin.
const STORED_FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

/**
 * Response headers for streaming a stored upload from our own origin (the
 * auth-gated proxies). Types off the allowlist go out as an opaque download,
 * and sniffing is off so a mislabeled file is never rendered as a page.
 */
export function storedFileHeaders(
  contentType: string,
  contentLength: number | undefined,
  cacheControl: string,
): Record<string, string> {
  const mime = contentType.split(';')[0].trim().toLowerCase();
  const inline = INLINE_MIMES.has(mime);
  const headers: Record<string, string> = {
    'content-type': inline ? mime : 'application/octet-stream',
    'content-disposition': inline ? 'inline' : 'attachment',
    'x-content-type-options': 'nosniff',
    'cache-control': cacheControl,
  };
  // No sandbox on PDFs: Chrome refuses to show a PDF in a sandboxed document,
  // and its viewer never runs a PDF's script on our origin anyway.
  if (mime !== 'application/pdf') headers['content-security-policy'] = STORED_FILE_CSP;
  if (typeof contentLength === 'number') headers['content-length'] = String(contentLength);
  return headers;
}
