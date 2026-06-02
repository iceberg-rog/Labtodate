import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

function buildHref(baseParams: URLSearchParams, page: number): string {
  const next = new URLSearchParams(baseParams.toString());
  if (page <= 1) next.delete('page');
  else next.set('page', String(page));
  const qs = next.toString();
  return `/marketplace${qs ? `?${qs}` : ''}`;
}

export function Pagination({
  page,
  totalPages,
  searchParams,
}: {
  page: number;
  totalPages: number;
  searchParams: URLSearchParams;
}) {
  if (totalPages <= 1) return null;

  // Window of pages to render around current.
  const window: number[] = [];
  const start = Math.max(1, page - 2);
  const end   = Math.min(totalPages, page + 2);
  for (let i = start; i <= end; i++) window.push(i);

  return (
    <nav className="flex items-center justify-center gap-1 pt-12" aria-label="Pagination">
      <Link
        href={buildHref(searchParams, Math.max(1, page - 1))}
        aria-disabled={page === 1}
        className={`inline-flex items-center gap-1 px-3 h-10 rounded-lg text-sm font-medium ${
          page === 1
            ? 'pointer-events-none text-muted-foreground'
            : 'text-foreground hover:bg-foreground/5'
        }`}
      >
        <ChevronLeft className="h-4 w-4" /> Prev
      </Link>

      {start > 1 && (
        <>
          <PageLink page={1} active={false} searchParams={searchParams} />
          {start > 2 && <span className="px-2 text-muted-foreground">…</span>}
        </>
      )}

      {window.map((p) => (
        <PageLink key={p} page={p} active={p === page} searchParams={searchParams} />
      ))}

      {end < totalPages && (
        <>
          {end < totalPages - 1 && <span className="px-2 text-muted-foreground">…</span>}
          <PageLink page={totalPages} active={false} searchParams={searchParams} />
        </>
      )}

      <Link
        href={buildHref(searchParams, Math.min(totalPages, page + 1))}
        aria-disabled={page === totalPages}
        className={`inline-flex items-center gap-1 px-3 h-10 rounded-lg text-sm font-medium ${
          page === totalPages
            ? 'pointer-events-none text-muted-foreground'
            : 'text-foreground hover:bg-foreground/5'
        }`}
      >
        Next <ChevronRight className="h-4 w-4" />
      </Link>
    </nav>
  );
}

function PageLink({
  page,
  active,
  searchParams,
}: {
  page: number;
  active: boolean;
  searchParams: URLSearchParams;
}) {
  return (
    <Link
      href={buildHref(searchParams, page)}
      className={`min-w-[40px] h-10 inline-flex items-center justify-center rounded-lg text-sm font-medium tabular-nums ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-foreground hover:bg-foreground/5'
      }`}
      aria-current={active ? 'page' : undefined}
    >
      {page}
    </Link>
  );
}
