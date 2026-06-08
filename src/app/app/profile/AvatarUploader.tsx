'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, Loader2 } from 'lucide-react';

export function AvatarUploader({ name, image }: { name: string; image: string | null | undefined }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const initials = (name || '')
    .split(/\s+/)
    .map((s) => s[0])
    .filter((c) => c && c.match(/[A-Z]/i))
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    start(async () => {
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch('/api/avatar-upload', { method: 'POST', body: fd });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setErr(j.error || 'Upload failed');
          return;
        }
        router.refresh();
      } catch {
        setErr('Upload failed — try again');
      } finally {
        if (inputRef.current) inputRef.current.value = '';
      }
    });
  }

  return (
    <div className="relative inline-block">
      <div
        className="h-16 w-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xl font-bold overflow-hidden"
        style={{ letterSpacing: '-0.04em' }}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt={name} className="h-full w-full object-cover" />
        ) : (
          initials
        )}
      </div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        className="absolute -bottom-1 -right-1 h-7 w-7 rounded-full bg-card border-2 border-background shadow-md inline-flex items-center justify-center hover:bg-foreground/5 disabled:opacity-60"
        aria-label="Change photo"
        title="Change photo"
      >
        {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={onPick}
        className="hidden"
      />
      {err && <p className="absolute top-full left-0 mt-1 text-xs text-red-700 whitespace-nowrap">{err}</p>}
    </div>
  );
}
