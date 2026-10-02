'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Image as ImageIcon, Loader2, Upload, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Result = { ok: boolean; message: string } | null;

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Brand-logo upload on the Settings → Logo tab. Uses useActionState so a
 * rejected file (wrong type, too big) or a successful upload shows a message
 * by the button instead of a server-error page. Oversized files are stopped
 * here before they are sent.
 */
export function LogoUploadForm({
  action,
  currentUrl,
}: {
  action: (prev: Result, formData: FormData) => Promise<Result>;
  currentUrl: string | undefined;
}) {
  const [state, formAction] = useActionState(action, null);
  const [localError, setLocalError] = useState<string | null>(null);
  const shown: Result = localError ? { ok: false, message: localError } : state;

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const input = e.currentTarget.elements.namedItem('logo') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (file && file.size > MAX_BYTES) {
      e.preventDefault();
      setLocalError('Logo too large (max 2 MB).');
      return;
    }
    setLocalError(null);
  }

  return (
    <form
      action={formAction}
      onSubmit={onSubmit}
      className="rounded-2xl border border-border bg-card p-6 space-y-5"
    >
      <div className="flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Brand logo</h2>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground bg-foreground/[0.02] border border-border rounded-xl p-3">
        Uploaded once, then surfaced on every invoice + proforma. Keep a transparent background — looks best on white documents.
      </p>
      <div className="flex items-center gap-5 flex-wrap">
        <div className="h-20 w-48 rounded-lg border border-border bg-card flex items-center justify-center overflow-hidden">
          {currentUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            (<img
              src={currentUrl}
              alt="Company logo"
              className="max-h-16 max-w-[180px] object-contain"
            />)
          ) : (
            <span className="text-xs text-muted-foreground">No logo</span>
          )}
        </div>
        <div className="flex-1 min-w-[220px]">
          <p className="text-sm font-bold">Replace logo</p>
          <p className="text-xs text-muted-foreground mb-2">
            PNG / JPG / WEBP, max 2MB.
          </p>
          <input
            type="file"
            name="logo"
            accept="image/png,image/jpeg,image/webp"
            required
            onChange={() => setLocalError(null)}
            className="text-sm"
          />
        </div>
      </div>
      <div className="flex items-center gap-3 pt-2 border-t border-border flex-wrap">
        <UploadButton />
        {shown && (
          <span
            role="status"
            className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
              shown.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {shown.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {shown.message}
          </span>
        )}
      </div>
    </form>
  );
}

function UploadButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" disabled={pending} className="rounded-full font-semibold">
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
      {pending ? 'Uploading…' : 'Upload logo'}
    </Button>
  );
}
