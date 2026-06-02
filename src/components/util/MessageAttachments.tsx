import { Paperclip } from 'lucide-react';

/** Renders message attachments: images as thumbnails, others as file links.
 *  All attachments go through the auth-gated /api/support-attachment proxy.
 *  When viewed via guest magic-link, pass `guestToken` so the proxy can
 *  authorize the anonymous request via `?t=<token>`. */
export function MessageAttachments({
  urls,
  guestToken,
}: {
  urls: string[];
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
      {urls.map((u) => {
        const href = withToken(u);
        return isImage(u) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <a key={u} href={href} target="_blank" rel="noreferrer">
            <img
              src={href}
              alt="attachment"
              className="h-24 w-24 rounded-lg object-cover border border-border bg-background"
            />
          </a>
        ) : (
          <a
            key={u}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs hover:bg-muted"
          >
            <Paperclip className="h-3.5 w-3.5" />
            {decodeURIComponent(u.split('/').pop()?.split('?')[0] || 'file')}
          </a>
        );
      })}
    </div>
  );
}
