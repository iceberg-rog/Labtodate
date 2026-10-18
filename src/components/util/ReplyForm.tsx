'use client';

import { useRef, useState, useTransition } from 'react';
import { Paperclip, X, Loader2 } from 'lucide-react';

type Att = { url: string; name: string; type: string };

const MAX_FILES = 5;

/** What a reply action may return: `{ error }` (or `{ ok: false, message }`) keeps the text, `{ warning }` / `{ notice }` are shown after sending. */
type ReplyResult = { error?: string; warning?: string; notice?: string; ok?: boolean; message?: string };

/**
 * Server-action reply box: a multi-line message (line breaks kept) with up to
 * five image / PDF attachments — text is optional when a file is attached.
 * It clears itself after sending (Next does not reset programmatic action
 * calls) and shows what the action returned: an error keeps the typed text
 * and files, a warning or notice is shown after a successful send.
 * Ctrl/⌘ + Enter sends.
 */
export function ReplyForm({
  action,
  hidden,
  placeholder = 'Write a reply…',
  label = 'Send',
  rows = 3,
}: {
  action: (formData: FormData) => Promise<unknown>;
  hidden: Record<string, string>;
  placeholder?: string;
  label?: string;
  rows?: number;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [atts, setAtts] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setErr(null);
    setNotice(null);
    const room = Math.max(0, MAX_FILES - atts.length);
    if (files.length > room) {
      setErr(`You can attach up to ${MAX_FILES} files${room > 0 ? ` — only the first ${room} were added` : ''}.`);
    }
    setUploading(true);
    try {
      for (const f of files.slice(0, room)) {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch('/api/attachment-upload', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setErr(`${f.name}: ${data.error || 'upload failed.'}`);
          continue;
        }
        if (data.url) {
          setAtts((p) =>
            p.length < MAX_FILES ? [...p, { url: data.url, name: data.name ?? f.name, type: data.type ?? '' }] : p,
          );
        }
      }
    } catch {
      setErr('Upload failed — check your connection and try again.');
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
                aria-label={`Remove ${a.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {err && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      {notice && <p role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
      <form
        ref={ref}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          if (!String(fd.get('body') ?? '').trim() && atts.length === 0) {
            setErr('Write a message or attach a file.');
            return;
          }
          fd.set('attachments', JSON.stringify(atts.map((a) => a.url)));
          fd.set('attachmentNames', JSON.stringify(atts.map((a) => a.name)));
          const form = e.currentTarget;
          setErr(null);
          setNotice(null);
          start(async () => {
            try {
              const r = await action(fd);
              const res: ReplyResult = r && typeof r === 'object' ? (r as ReplyResult) : {};
              const error = res.error ?? (res.ok === false ? res.message : undefined);
              if (error) {
                // Not sent: keep the text and the files so nothing is lost.
                setErr(error);
                return;
              }
              form.reset();
              setAtts([]);
              if (res.warning) setErr(res.warning);
              else if (res.notice) setNotice(res.notice);
            } catch (er) {
              if ((er as Error)?.message?.includes('NEXT_REDIRECT')) {
                form.reset();
                setAtts([]);
                return;
              }
              setErr('Your message was not sent — check your connection and try again. Your text is still here.');
            }
          });
        }}
        className="space-y-2"
      >
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <textarea
          name="body"
          // Text is optional when a file is attached (a photo can be the whole reply).
          required={atts.length === 0}
          rows={rows}
          maxLength={5000}
          placeholder={placeholder}
          aria-label={placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              ref.current?.requestSubmit();
            }
          }}
          className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm resize-y min-h-[2.75rem]"
        />
        <div className="flex gap-2 items-center">
          <label
            className="flex-shrink-0 h-10 w-10 rounded-lg border border-input bg-background flex items-center justify-center cursor-pointer hover:bg-muted"
            title={`Attach images or PDFs (up to ${MAX_FILES})`}
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Paperclip className="h-4 w-4 text-muted-foreground" />
            )}
            <span className="sr-only">Attach files</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
              multiple
              className="hidden"
              onChange={onFiles}
              disabled={uploading || atts.length >= MAX_FILES}
            />
          </label>
          <span className="flex-1 text-[11px] text-muted-foreground hidden sm:block">Images or PDF, up to {MAX_FILES} files.</span>
          <button
            type="submit"
            disabled={pending || uploading}
            className="rounded-full bg-primary text-primary-foreground px-5 h-10 text-sm font-semibold disabled:opacity-60 ml-auto"
          >
            {pending ? 'Sending…' : label}
          </button>
        </div>
      </form>
    </div>
  );
}
