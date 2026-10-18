import Link from 'next/link';
import { Plus, Trash2, Eye, EyeOff, Star, MessageSquareQuote, ArrowRight, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireCapability } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { createTestimonial, deleteTestimonial, toggleTestimonial, updateTestimonial } from '@/app/admin/actions';
import { ConfirmSubmitButton } from '@/components/admin/ConfirmSubmitButton';
import { AdminActionForm } from '@/components/admin/AdminActionForm';
import { getCatalogPolicy } from '@/lib/catalog/policy';
import { ensureSettingsLoaded } from '@/lib/settings';
import { envRead, getHomeLayout, homeValue } from '@/lib/home-sections';
import { siteName } from '@/lib/brand/identity';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Testimonials' };

export default async function AdminTestimonialsPage() {
  await requireCapability('content:cms');
  const { requireConsentToPublish } = await getCatalogPolicy();
  await ensureSettingsLoaded();
  // the homepage shows testimonials only while its extra module is switched on (Admin → Homepage; off by default)
  const moduleOn = getHomeLayout(envRead).extras.includes('testimonials');
  const heading = homeValue(envRead, 'TEST_HEADING');
  const site = siteName();
  const list = await prisma.testimonial.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
  const published = list.filter((t) => t.published);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Testimonials</h1>
        <p className="text-muted-foreground mt-1">
          Short customer quotes for the homepage module “{heading}” — shown when the Testimonials module is on (Admin → Homepage).
          {published.length === 0 && ' The module stays hidden until at least one testimonial is published.'}
        </p>
      </div>

      <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 flex items-start gap-3">
        <MessageSquareQuote className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-sm">
          <p className="font-bold">What is this for?</p>
          <p className="text-muted-foreground mt-1">
            Up to six published testimonials appear as quote cards in the homepage’s Testimonials module, below the 3D stations —
            only while that module is switched on in Admin → Homepage. Quotes should be short (≤2 sentences) and credited
            with a real person + organisation who agreed to be quoted. With none published, the module is left out.
            {requireConsentToPublish
              ? ' A testimonial goes live only once you record who approved it and when (Settings → Catalog & claims).'
              : ' Consent recording is switched OFF in Settings → Catalog & claims.'}
          </p>
          {moduleOn ? (
            <Link
              href="/#testimonials"
              target="_blank"
              className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-primary hover:underline"
            >
              {published.length ? 'See them on the live homepage' : 'Open the live homepage'} <ArrowRight className="h-3 w-3" />
            </Link>
          ) : (
            <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
              The Testimonials module is off, so visitors see none of these.{' '}
              <Link href="/admin/homepage" className="underline">Switch it on in Admin → Homepage</Link> (Extra modules), then preview the draft there.
            </p>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
        <div className="space-y-6 min-w-0">
          <AdminActionForm
            action={createTestimonial}
            resetOnSuccess
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
            <fieldset className="rounded-xl border border-border p-3 space-y-2">
              <legend className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Consent to be quoted</legend>
              <div className="grid sm:grid-cols-3 gap-3">
                <input name="consentBy" defaultValue={''} aria-label="Approved by" placeholder="Approved by (name)" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                <input name="consentAt" type="date" defaultValue={''} aria-label="Approved on" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                <input name="consentNote" defaultValue={''} aria-label="How" placeholder="How (e.g. email of 2 Oct, filed in …)" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
              </div>
            </fieldset>
            <Button type="submit" className="rounded-full font-semibold">
              <Plus className="h-4 w-4" /> Add testimonial
            </Button>
          </AdminActionForm>

          <ul className="rounded-2xl border border-border bg-card divide-y divide-border overflow-hidden">
            {list.length === 0 && (
              <li className="p-6 text-sm text-muted-foreground">No testimonials yet — the homepage hides the section until you publish one.</li>
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
                  <p className={`text-[11px] mt-1 ${t.consentAt && t.consentBy ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400 font-semibold'}`}>
                    {t.consentAt && t.consentBy
                      ? `Consent: ${t.consentBy}, ${t.consentAt.toLocaleDateString('en-GB')}${t.consentNote ? ` (${t.consentNote})` : ''}`
                      : 'No consent recorded'}
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
                <AdminActionForm action={toggleTestimonial.bind(null, t.id, !t.published)}>
                  <Button type="submit" variant="outline" size="sm" className="rounded-full font-medium">
                    {t.published ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {t.published ? 'Hide' : 'Publish'}
                  </Button>
                </AdminActionForm>
                <form action={deleteTestimonial.bind(null, t.id)}>
                  <ConfirmSubmitButton
                    message={`Delete the testimonial from ${t.author}? This cannot be undone.`}
                    variant="outline"
                    size="sm"
                    className="rounded-full font-medium text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </ConfirmSubmitButton>
                </form>
                <details className="basis-full">
                  <summary className="cursor-pointer select-none w-fit text-xs font-semibold text-primary hover:underline">Edit</summary>
                  <AdminActionForm action={updateTestimonial.bind(null, t.id)} className="mt-3 space-y-3">
                    <textarea name="quote" required rows={3} maxLength={400} defaultValue={t.quote} aria-label="Quote" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                    <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
                      <input name="author" required defaultValue={t.author} aria-label="Author" placeholder="Author" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                      <input name="role" defaultValue={t.role ?? ''} aria-label="Role" placeholder="Role" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                      <input name="company" defaultValue={t.company ?? ''} aria-label="Company" placeholder="Company" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                      <input name="rating" type="number" min={1} max={5} defaultValue={t.rating} aria-label="Rating (1–5)" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                      <input name="sortOrder" type="number" defaultValue={t.sortOrder} aria-label="Sort order" className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                    </div>
                    <fieldset className="rounded-xl border border-border p-3 space-y-2">
              <legend className="px-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">Consent to be quoted</legend>
              <div className="grid sm:grid-cols-3 gap-3">
                <input name="consentBy" defaultValue={t.consentBy ?? ''} aria-label="Approved by" placeholder="Approved by (name)" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                <input name="consentAt" type="date" defaultValue={t.consentAt ? t.consentAt.toISOString().slice(0, 10) : ''} aria-label="Approved on" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
                <input name="consentNote" defaultValue={t.consentNote ?? ''} aria-label="How" placeholder="How (e.g. email of 2 Oct, filed in …)" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
              </div>
            </fieldset>
                    <Button type="submit" size="sm" className="rounded-full font-semibold">
                      <Save className="h-3.5 w-3.5" /> Save changes
                    </Button>
                  </AdminActionForm>
                </details>
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
            quote: `${site} found the HPLC on our shortlist and sent a written offer within the week.`,
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
              Layout preview only — this sample is never shown on the live site. Publish a real testimonial to show the section.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
