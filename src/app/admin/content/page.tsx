import Link from 'next/link';
import { PenSquare } from 'lucide-react';
import { requireCapability } from '@/lib/auth-server';
import { groupValues, groupKey } from '@/lib/site/content';
import { SITE_GROUPS } from '@/lib/site/defs';
import { SITE_FIELDS } from '@/lib/site/types';
import { SiteContentEditor } from '@/components/admin/documents/SiteContentEditor';
import { HistoryPanel } from '@/components/admin/documents/DocumentsUI';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Site content' };

/**
 * Admin → Site content: every business text, claim, promise, page and menu
 * item of the public site, with defaults, field insertion and history.
 */
export default async function SiteContentPage(props: { searchParams?: Promise<{ g?: string; tab?: string }> }) {
  const sp = (await props.searchParams) ?? {};
  await requireCapability('content:cms');
  const showHistory = sp.tab === 'history';
  const group = SITE_GROUPS.find((g) => g.id === sp.g) ?? SITE_GROUPS[0];
  const values = await groupValues(group.id);

  return (
    <div className="container-px py-8 max-w-[1300px] mx-auto space-y-5">
      <header>
        <h1 className="text-2xl font-bold inline-flex items-center gap-2"><PenSquare className="h-6 w-6 text-primary" /> Site content</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          Claims, promises, page texts, legal pages and the menu. Documents and e-mails are under{' '}
          <Link href="/admin/documents" className="text-primary hover:underline">Documents</Link>; the homepage stations under{' '}
          <Link href="/admin/homepage" className="text-primary hover:underline">Homepage</Link>.
        </p>
      </header>
      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <nav className="rounded-2xl border border-border bg-card p-3 self-start" aria-label="Content groups">
          <ul className="space-y-0.5">
            {SITE_GROUPS.map((g) => (
              <li key={g.id}>
                <Link href={`/admin/content?g=${g.id}`} className={`block rounded-lg px-2 py-1.5 text-sm ${!showHistory && g.id === group.id ? 'bg-primary/10 text-primary font-semibold' : 'hover:bg-foreground/[0.04]'}`}>
                  {g.label}
                </Link>
              </li>
            ))}
            <li className="pt-2 mt-2 border-t border-border">
              <Link href={`/admin/content?tab=history&g=${group.id}`} className={`block rounded-lg px-2 py-1.5 text-sm ${showHistory ? 'bg-primary/10 text-primary font-semibold' : 'hover:bg-foreground/[0.04]'}`}>History</Link>
            </li>
          </ul>
        </nav>
        <div className="min-w-0">
          {showHistory ? (
            <HistoryPanel keys={SITE_GROUPS.map((g) => ({ key: groupKey(g.id), label: g.label }))} initialKey={groupKey(group.id)} />
          ) : (
            <SiteContentEditor
              key={group.id}
              groupId={group.id}
              title={group.label}
              description={group.description}
              page={group.page}
              fields={group.fields}
              initial={values}
              vars={SITE_FIELDS}
            />
          )}
        </div>
      </div>
    </div>
  );
}
