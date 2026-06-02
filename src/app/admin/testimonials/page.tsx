import Link from 'next/link';
import { Plus, Trash2, Eye, EyeOff, Star, MessageSquareQuote, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { createTestimonial, deleteTestimonial, toggleTestimonial } from '@/app/admin/actions';

export const dynamic = 'force-dynamic';

export default async function AdminTestimonialsPage() {
  await requireCapability('content:cms');
  const list = await prisma.testimonial.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
  const published = list.filter((t) => t.published);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Testimonials</h1>
        <p className="text-muted-foreground mt-1">
          Short customer quotes shown in the “Loved by people who buy expensive things” section of the homepage.
          {list.length === 0 && ' Add one below to replace the built-in sample quotes.'}
          {published.length === 0 && list.length > 0 && ' (none published yet — homepage falls back to the built-in samples).'}
        </p>
      </div>

      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 flex items-start gap-3">
        <MessageSquareQuote className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-sm">
          <p className="font-bold">What is this for?</p>
          <p className="text-muted-foreground mt-1">
            Each published testimonial appears as a rotating quote card on the homepage. Quotes should be short
            (≤2 sentences) and credited with a real person + organisation — sample quotes are shown until you publish at least one real one.
          </p>
          <Link
            href="/#testimonials"
            target="_blank"
            className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-primary hover:underline"
          >
            Preview on the live homepage <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
        <div className="space-y-6 min-w-0">
          <form
            action={createTestimonial}
            className="rounded-2xl border border-border bg-card p-5 space-y-4"
          >
            <h2 className="font-semibold">Add testimonial</h2>
            <div>
              <label className="text-sm font-medium">Quote</label>
              <textarea
                name="quote"
                required
                rows={3}
                maxLength={400}
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                placeholder="What the customer said (max 400 chars, 2 sentences ideal)"
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Author</label>
                <input name="author" required className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="Dr. Jane Doe" />
              </div>
              <div>
                <label className="text-sm font-medium">Role</label>
                <input name="role" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="Lab Director" />
              </div>
              <div>
                <label className="text-sm font-medium">Company</label>
                <input name="company" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" placeholder="Acme Biotech" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium">Rating (1–5)</label>
                  <input name="rating" type="number" min={1} max={5} defaultValue={5} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-sm font-medium">Sort order</label>
                  <input name="sortOrder" type="number" defaultValue={0} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                </div>
              </div>
            </div>
            <Button type="submit" className="rounded-full font-semibold">
              <Plus className="h-4 w-4" /> Add testimonial
            </Button>
          </form>

          <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
            {list.length === 0 && (
              <li className="p-6 text-sm text-muted-foreground">No testimonials yet — the homepage shows our built-in samples.</li>
            )}
            {list.map((t) => (
              <li key={t.id} className="p-4 flex items-start gap-4 flex-wrap">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">&ldquo;{t.quote}&rdquo;</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t.author}
                    {[t.role, t.company].filter(Boolean).length > 0 && ' · '}
                    {[t.role, t.company].filter(Boolean).join(', ')} · order {t.sortOrder}
                  </p>
                  <div className="flex items-center gap-0.5 mt-1">
                    {Array.from({ length: t.rating }).map((_, i) => (
                      <Star key={i} className="h-3 w-3 fill-[hsl(82_76%_45%)] text-[hsl(82_76%_45%)]" />
                    ))}
                  </div>
                </div>
                <Badge variant={t.published ? 'success' : 'secondary'}>
                  {t.published ? 'published' : 'hidden'}
                </Badge>
                <form action={toggleTestimonial.bind(null, t.id, !t.published)}>
                  <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium">
                    {t.published ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {t.published ? 'Hide' : 'Publish'}
                  </Button>
                </form>
                <form action={deleteTestimonial.bind(null, t.id)}>
                  <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium text-destructive">
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </div>

        <aside className="lg:sticky lg:top-20 space-y-3">
          <p className="text-xs uppercase tracking-wider font-bold text-muted-foreground">
            How a card will look
          </p>
          {(published.length > 0 ? published : [{
            id: 'sample',
            quote: 'Lab2date saved us 6 weeks of vendor RFP — they matched our shortlist and shipped a refurb HPLC under budget.',
            author: 'Sample Customer',
            role: 'Lab Director',
            company: 'Acme Biotech',
            rating: 5,
          }]).slice(0, 3).map((t) => (
            <article key={t.id} className="rounded-2xl border border-border bg-card p-5 shadow-sm">
              <div className="flex items-center gap-0.5 mb-3">
                {Array.from({ length: t.rating }).map((_, i) => (
                  <Star key={i} className="h-3.5 w-3.5 fill-[hsl(82_76%_45%)] text-[hsl(82_76%_45%)]" />
                ))}
              </div>
              <p className="text-sm leading-relaxed">&ldquo;{t.quote}&rdquo;</p>
              <div className="mt-3 pt-3 border-t border-border">
                <p className="text-xs font-bold">{t.author}</p>
                {(t.role || t.company) && (
                  <p className="text-[11px] text-muted-foreground">
                    {[t.role, t.company].filter(Boolean).join(', ')}
                  </p>
                )}
              </div>
            </article>
          ))}
          {published.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              Sample preview shown above — publish a real testimonial to replace it on the live homepage.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
