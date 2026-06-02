import Link from 'next/link';
import { Plus, Trash2, Eye, EyeOff, Award, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { createCaseStudy, deleteCaseStudy, toggleCaseStudy } from '@/app/admin/actions';
import { CaseStudyPreviewButton } from '@/components/admin/CaseStudyPreview';

export const dynamic = 'force-dynamic';

export default async function AdminCaseStudiesPage() {
  await requireCapability('content:cms');
  const list = await prisma.caseStudy.findMany({ orderBy: { createdAt: 'desc' } });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Case studies</h1>
        <p className="text-muted-foreground mt-1">
          {list.length} case stud{list.length === 1 ? 'y' : 'ies'} · published ones appear on /case-studies and the homepage trust bar.
        </p>
      </div>

      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 flex items-start gap-3">
        <Award className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-sm">
          <p className="font-bold">What is a case study?</p>
          <p className="text-muted-foreground mt-1">
            A longer success story used to convince a hesitant buyer. Each study has a customer (e.g. “Acme Biotech”),
            an outcome metric (e.g. “40% lower capex”), a short excerpt that appears on the listing card, and a body
            paragraph rendered on its own page. Click <em>Preview</em> on any row to see how it will render before publishing.
          </p>
          <Link
            href="/case-studies"
            target="_blank"
            className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-primary hover:underline"
          >
            Open the live listing <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      <form action={createCaseStudy} className="rounded-2xl border border-border bg-card p-5 space-y-4">
        <h2 className="font-semibold">Add case study</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium">Title</label>
            <input name="title" required className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="How Acme cut instrument spend 40%" />
          </div>
          <div>
            <label className="text-sm font-medium">Customer</label>
            <input name="customer" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="Acme Biotech" />
          </div>
          <div>
            <label className="text-sm font-medium">Outcome metric</label>
            <input name="outcomeMetric" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="40% lower capex" />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium">Excerpt</label>
          <textarea name="excerpt" rows={2} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="One-sentence summary shown on the listing card" />
        </div>
        <div>
          <label className="text-sm font-medium">Body</label>
          <textarea name="body" rows={6} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="Full case study text" />
        </div>
        <Button type="submit" className="rounded-full font-semibold">
          <Plus className="h-4 w-4" /> Add case study
        </Button>
      </form>

      <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
        {list.length === 0 && (
          <li className="p-6 text-sm text-muted-foreground">
            No case studies yet — published ones populate <code>/case-studies</code>.
          </li>
        )}
        {list.map((c) => {
          const published = c.status === 'PUBLISHED';
          return (
            <li key={c.id} className="p-4 flex items-start gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <Link href={`/case-studies/${c.slug}`} className="font-semibold hover:text-primary block truncate">
                  {c.title}
                </Link>
                <p className="text-xs text-muted-foreground mt-1">
                  {c.customer} · {c.outcomeMetric}
                </p>
                {c.excerpt && (
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-1 italic">
                    “{c.excerpt}”
                  </p>
                )}
              </div>
              <Badge variant={published ? 'success' : 'secondary'}>
                {published ? 'published' : 'draft'}
              </Badge>
              <CaseStudyPreviewButton
                item={{
                  id: c.id,
                  slug: c.slug,
                  title: c.title,
                  customer: c.customer,
                  outcomeMetric: c.outcomeMetric,
                  excerpt: c.excerpt ?? '',
                  body: c.body ?? '',
                  published,
                }}
              />
              <form action={toggleCaseStudy.bind(null, c.id, !published)}>
                <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium">
                  {published ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  {published ? 'Unpublish' : 'Publish'}
                </Button>
              </form>
              <form action={deleteCaseStudy.bind(null, c.id)}>
                <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium text-destructive">
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              </form>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
