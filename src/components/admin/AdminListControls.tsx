import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * Shared search box + pager for admin list pages so every operator screen
 * is searchable and paginated at catalogue scale (not capped at N).
 */
export function AdminSearch({
  basePath,
  q,
  status,
  params,
  placeholder,
}: {
  basePath: string;
  q: string;
  status?: string;
  /** Other active filters (e.g. category, shop) to keep when searching. */
  params?: Record<string, string | undefined>;
  placeholder: string;
}) {
  const keep = Object.entries({ status, ...params }).filter((e): e is [string, string] => !!e[1]);
  const clearQs = new URLSearchParams(keep).toString();
  return (
    <form method="GET" className="flex gap-2 flex-wrap">
      {keep.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <input
        name="q"
        defaultValue={q}
        placeholder={placeholder}
        className="flex-1 min-w-[260px] h-10 px-3 rounded-lg border border-input bg-background text-sm"
      />
      <Button type="submit" size="sm" className="rounded-full font-semibold">Search</Button>
      {q && (
        <a
          href={clearQs ? `${basePath}?${clearQs}` : basePath}
          className="inline-flex items-center px-3 h-10 rounded-full text-xs font-semibold bg-foreground/5 hover:bg-foreground/10"
        >
          Clear
        </a>
      )}
    </form>
  );
}

export function AdminPager({
  basePath,
  page,
  totalPages,
  total,
  q,
  status,
  tab,
  params,
}: {
  basePath: string;
  page: number;
  totalPages: number;
  total: number;
  q?: string;
  status?: string;
  /** Generic tab key (queues that use ?tab= instead of ?status=). */
  tab?: string;
  /** Other active filters (e.g. category, shop) to keep across pages. */
  params?: Record<string, string | undefined>;
}) {
  if (totalPages <= 1) return null;
  const href = (target: number) => {
    const sp = new URLSearchParams();
    if (status) sp.set('status', status);
    if (tab) sp.set('tab', tab);
    for (const [k, v] of Object.entries(params ?? {})) if (v) sp.set(k, v);
    if (q) sp.set('q', q);
    if (target > 1) sp.set('page', String(target));
    const s = sp.toString();
    return s ? `${basePath}?${s}` : basePath;
  };
  return (
    <div className="flex items-center justify-between gap-3">
      {page > 1 ? (
        <Button asChild variant="outline" size="sm" className="rounded-full font-medium">
          <Link href={href(page - 1)}>← Previous</Link>
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground px-3">← Previous</span>
      )}
      <span className="text-sm text-muted-foreground tabular-nums">
        Page {page} of {totalPages} · {total} total
      </span>
      {page < totalPages ? (
        <Button asChild variant="outline" size="sm" className="rounded-full font-medium">
          <Link href={href(page + 1)}>Next →</Link>
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground px-3">Next →</span>
      )}
    </div>
  );
}
