'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Save, Send, Upload, X, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TiptapEditor } from './TiptapEditor';

type Kind = 'blog' | 'wiki';

interface BlogInitial {
  kind: 'blog';
  title?: string;
  excerpt?: string | null;
  body?: string;
  category?: string | null;
  illustration?: string | null;
  coverImage?: string | null;
  coverGradient?: string | null;
  readMinutes?: number;
}
interface WikiInitial {
  kind: 'wiki';
  title?: string;
  body?: string;
  category?: string | null;
}

export function ContentForm<T extends BlogInitial | WikiInitial>({
  initial,
  onSubmit,
}: {
  initial: T;
  onSubmit: (data: { title: string; excerpt?: string | null; body: string; category?: string | null; illustration?: string | null; coverImage?: string | null; coverGradient?: string | null; readMinutes?: number; publish: boolean }) => Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(initial.title ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [category, setCategory] = useState(initial.category ?? '');
  const [excerpt, setExcerpt] = useState(initial.kind === 'blog' ? (initial.excerpt ?? '') : '');
  const [illustration, setIllustration] = useState<string>(initial.kind === 'blog' ? (initial.illustration ?? '') : '');
  const [coverImage, setCoverImage] = useState<string>(initial.kind === 'blog' ? (initial.coverImage ?? '') : '');
  const [coverGradient, setCoverGradient] = useState(initial.kind === 'blog' ? (initial.coverGradient ?? '') : '');
  const [readMinutes, setReadMinutes] = useState<number>(initial.kind === 'blog' ? (initial.readMinutes ?? 5) : 5);
  const [coverUploading, setCoverUploading] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);

  async function handleCoverFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCoverUploading(true);
    setCoverError(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setCoverImage(data.url);
    } catch (err) {
      setCoverError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setCoverUploading(false);
      e.target.value = '';
    }
  }

  function submit(publish: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        await onSubmit({
          title: title.trim(),
          body,
          category: category.trim() || null,
          excerpt: initial.kind === 'blog' ? (excerpt.trim() || null) : null,
          illustration: initial.kind === 'blog' ? (illustration || null) : null,
          coverImage: initial.kind === 'blog' ? (coverImage.trim() || null) : null,
          coverGradient: initial.kind === 'blog' ? (coverGradient.trim() || null) : null,
          readMinutes: initial.kind === 'blog' ? readMinutes : undefined,
          publish,
        });
      } catch (err) {
        if ((err as Error)?.message?.includes('NEXT_REDIRECT')) return;
        setError(err instanceof Error ? err.message : 'Save failed');
      }
    });
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(false); }} className="space-y-6">
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} required minLength={6}
          className="w-full h-11 px-3 rounded-lg border border-input bg-background text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" />
      </Field>

      {initial.kind === 'blog' && (
        <>
          <Field label="Excerpt">
            <textarea value={excerpt} onChange={(e) => setExcerpt(e.target.value)} rows={2}
              className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" />
          </Field>
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Category">
              <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Buying guide"
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" />
            </Field>
            <Field label="Illustration">
              <select value={illustration} onChange={(e) => setIllustration(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary">
                <option value="">(none)</option>
                {['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector'].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label="Read minutes">
              <input type="number" min="1" max="60" value={readMinutes} onChange={(e) => setReadMinutes(parseInt(e.target.value, 10) || 5)}
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" />
            </Field>
          </div>
          <Field label="Cover photo (overrides illustration when set)">
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="flex gap-4 flex-wrap items-start">
                <div className="aspect-[16/10] w-56 rounded-xl border border-border bg-muted overflow-hidden flex items-center justify-center flex-shrink-0">
                  {coverImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={coverImage} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
                      <ImageIcon className="h-6 w-6" />
                      <span className="text-[11px]">No cover photo</span>
                      <span className="text-[10px] opacity-70">illustration fallback shown</span>
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-[200px] space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Upload a real photo of the instrument or scene. <strong>16:10</strong> ratio recommended (e.g. 1600×1000). JPG/PNG/WebP up to 8 MB.
                  </p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <label className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-border bg-background hover:bg-foreground/5 cursor-pointer text-xs font-semibold">
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={handleCoverFile}
                        disabled={coverUploading}
                        className="sr-only"
                      />
                      {coverUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {coverImage ? 'Replace photo' : 'Upload photo'}
                    </label>
                    {coverImage && (
                      <button
                        type="button"
                        onClick={() => setCoverImage('')}
                        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-border bg-background hover:bg-foreground/5 text-xs font-semibold text-destructive"
                      >
                        <X className="h-3.5 w-3.5" /> Remove
                      </button>
                    )}
                  </div>
                  {coverError && (
                    <p className="text-[11px] text-red-600">{coverError}</p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    When set, the photo replaces the illustration on the cover everywhere — homepage teaser, blog list, hero of the post.
                  </p>
                </div>
              </div>
            </div>
          </Field>
          <Field label="Cover gradient (Tailwind classes — only used when no photo)">
            <input value={coverGradient} onChange={(e) => setCoverGradient(e.target.value)} placeholder="from-[hsl(168_70%_18%)] via-[hsl(168_55%_30%)] to-[hsl(82_55%_50%)]"
              className="w-full h-10 px-3 rounded-lg border border-input bg-background text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" />
          </Field>
        </>
      )}

      {initial.kind === 'wiki' && (
        <Field label="Category">
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Centrifuges"
            className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary" />
        </Field>
      )}

      <Field label="Body">
        <TiptapEditor value={body} onChange={setBody} />
      </Field>

      {error && <p className="rounded-md border border-red-200 bg-red-50 text-red-700 px-3 py-2 text-sm">{error}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending} className="rounded-full font-semibold">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save as draft
        </Button>
        <Button type="button" onClick={() => submit(true)} disabled={pending} className="rounded-full font-semibold">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Publish
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} className="rounded-full font-medium ml-auto">Cancel</Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1.5">{label}</span>
      {children}
    </label>
  );
}
