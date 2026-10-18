import { Paperclip } from 'lucide-react';

/** The label of one attachment: its original file name when stored, else the
 *  last URL segment (the stored key — a hash for uploads). */
export function attachmentLabel(url: string, name?: string | null): string {
  const n = (name ?? '').trim();
  if (n) return n;
  const last = url.split('?')[0]?.split('/').pop() || 'file';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Renders message attachments: images as thumbnails, others as file links.
 *  All attachments go through the auth-gated /api/support-attachment proxy.
 *  When viewed via guest magic-link, pass `guestToken` so the proxy can
 *  authorize the anonymous request via `?t=<token>`. `names` are the original
 *  file names, index-aligned with `urls` (attachmentNames). The chips set their
 *  own text colour, so they stay readable on any bubble (e.g. the lime staff one). */
export function MessageAttachments({
  urls,
  names,
  guestToken,
}: {
  urls: string[];
  names?: string[] | null;
  guestToken?: string;
}) {
  if (!urls || urls.length === 0) return null;
  const isImage = (u: string) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(u);
  const withToken = (u: string) =>
    guestToken && u.startsWith('/api/support-attachment/')
      ? `${u}${u.includes('?') ? '&' : '?'}t=${encodeURIComponent(guestToken)}`
      : u;
  return (
    <div className="mt-2 flex gap-2 flex-wrap">
      {urls.map((u, i) => {
        const href = withToken(u);
        const label = attachmentLabel(u, names?.[i]);
        return isImage(u) ? (
          <a key={u} href={href} target="_blank" rel="noreferrer" title={label}>
            {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated proxy URL, not optimisable */}
            <img
              src={href}
              alt={label}
              className="h-24 w-24 rounded-lg object-cover border border-border bg-background"
            />
          </a>
        ) : (
          <a
            key={u}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={label}
            className="inline-flex items-center gap-1.5 max-w-full rounded-lg border border-border bg-background text-foreground px-3 py-2 text-xs font-medium hover:bg-muted"
          >
            <Paperclip className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">{label}</span>
          </a>
        );
      })}
    </div>
  );
}
