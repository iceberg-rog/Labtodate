'use client';

import { useRef, useState, useTransition } from 'react';
import { Paperclip, X, Loader2 } from 'lucide-react';

type Att = { url: string; name: string; type: string };

/**
 * Server-action reply box: clears itself after sending and supports
 * image / PDF attachments. Next 14 / React 18 does not auto-reset form
 * actions, so the typed message would otherwise stay after Send.
 */
export function ReplyForm({
  action,
  hidden,
  placeholder = 'Write a reply…',
  label = 'Send',
}: {
  action: (formData: FormData) => Promise<unknown>;
  hidden: Record<string, string>;
  placeholder?: string;
  label?: string;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [atts, setAtts] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setErr(null);
    setUploading(true);
    try {
      for (const f of files) {
        if (atts.length >= 5) break;
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/attachment-upload', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setErr(data.error || 'Upload failed.');
          continue;
        }
        if (data.url) {
          setAtts((p) =>
            p.length < 5 ? [...p, { url: data.url, name: data.name ?? 'file', type: data.type ?? '' }] : p,
          );
        }
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="pt-3 border-t border-border space-y-2">
      {atts.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {atts.map((a, i) => (
            <span
              key={a.url}
              className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs"
            >
              <Paperclip className="h-3 w-3" />
              <span className="max-w-[160px] truncate">{a.name}</span>
              <button
                type="button"
                onClick={() => setAtts((p) => p.filter((_, j) => j !== i))}
                aria-label="Remove attachment"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}
      <form
        ref={ref}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          fd.set('attachments', JSON.stringify(atts.map((a) => a.url)));
          const form = e.currentTarget;
          start(async () => {
            try {
              await action(fd);
              form.reset();
              setAtts([]);
            } catch (er) {
              if ((er as Error)?.message?.includes('NEXT_REDIRECT')) {
                form.reset();
                setAtts([]);
                return;
              }
            }
          });
        }}
        className="flex gap-2 items-center"
      >
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label
          className="flex-shrink-0 h-10 w-10 rounded-lg border border-input bg-background flex items-center justify-center cursor-pointer hover:bg-muted"
          title="Attach image or PDF"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Paperclip className="h-4 w-4 text-muted-foreground" />
          )}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
            multiple
            className="hidden"
            onChange={onFiles}
            disabled={uploading || atts.length >= 5}
          />
        </label>
        <input
          name="body"
          required
          placeholder={placeholder}
          autoComplete="off"
          className="flex-1 h-10 px-3 rounded-lg border border-input bg-background text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-primary text-primary-foreground px-5 h-10 text-sm font-semibold disabled:opacity-60"
        >
          {pending ? 'Sending…' : label}
        </button>
      </form>
    </div>
  );
}
