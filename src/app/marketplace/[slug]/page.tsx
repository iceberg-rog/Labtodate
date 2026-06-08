import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import {
  BadgeCheck,
  ShieldCheck,
  Truck,
  RotateCcw,
  Calendar,
  ArrowRight,
  ChevronRight,
  MapPin,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { productImage } from '@/lib/images';
import { StartThreadButton } from '@/components/messages/StartThreadButton';
import { WishlistButton } from '@/components/marketplace/WishlistButton';
import { ProductGallery } from '@/components/marketplace/ProductGallery';
import { ProductCard } from '@/components/marketplace/ProductCard';
import { getProductBySlug, getSimilarProducts } from '@/lib/marketplace/queries';
import { prisma } from '@/lib/db';
import type { IllustrationName } from '@/components/illustrations/instruments';
import { startCheckout } from '@/lib/orders/actions';
import { addToCart } from '@/lib/cart/actions';
import { getMarketing } from '@/lib/marketing';
import { submitReview } from '@/lib/reviews/actions';
import { isWishlisted } from '@/lib/wishlist/actions';
import { getServerSession } from '@/lib/auth-server';
import { formatPrice } from '@/lib/utils';

interface PageProps {
  params: { slug: string };
  searchParams?: { review?: string; sold?: string; quoteonly?: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const product = await getProductBySlug(params.slug);
  if (!product) return { title: 'Not found' };
  const description = product.summary ?? `${product.brand?.name ?? ''} ${product.title}`;
  return {
    title: product.title,
    description,
    openGraph: {
      title: product.title,
      description,
      type: 'website',
      siteName: 'lab2date',
    },
    twitter: { card: 'summary_large_image', title: product.title, description },
  };
}

export default async function ProductDetailPage({ params, searchParams }: PageProps) {
  const product = await getProductBySlug(params.slug);
  if (!product) notFound();
  const reviewNote = searchParams?.review === 'needpurchase';
  const mk = await getMarketing();

  const session = await getServerSession();
  const saved = await isWishlisted(session?.user.id ?? null, product.id);
  const similar = await getSimilarProducts(product.categoryId, product.slug, 4);
  const companyListings = product.companyId
    ? await prisma.product.count({ where: { companyId: product.companyId, status: 'PUBLISHED' } })
    : 0;
  const reviews = await prisma.review.findMany({
    where: { productId: product.id },
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { name: true } } },
  });
  const avgRating =
    reviews.length > 0
      ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10
      : null;

  const base = process.env.BETTER_AUTH_URL ?? 'https://lab2date.com';
  const jsonLd = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: product.title,
    description: product.summary ?? product.description ?? undefined,
    sku: product.slug,
    brand: product.brand ? { '@type': 'Brand', name: product.brand.name } : undefined,
    category: product.category.name,
    url: `${base}/marketplace/${product.slug}`,
    offers: product.priceCents
      ? {
          '@type': 'Offer',
          priceCurrency: product.currency,
          price: (product.priceCents / 100).toFixed(2),
          availability: 'https://schema.org/InStock',
          itemCondition:
            product.condition === 'NEW'
              ? 'https://schema.org/NewCondition'
              : product.condition === 'REFURBISHED'
              ? 'https://schema.org/RefurbishedCondition'
              : 'https://schema.org/UsedCondition',
          seller: { '@type': 'Organization', name: 'lab2date' },
        }
      : undefined,
  };

  const heroImg = product.images?.[0] || productImage(product.illustration, product.slug, 900);
  const specs = (product.specs as Record<string, string> | null) ?? null;
  const conditionLabel =
    product.condition === 'NEW' ? 'New' : product.condition === 'REFURBISHED' ? 'Refurbished' : 'Used';

  return (
    <div className="container-px py-10 md:py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1 text-xs text-muted-foreground mb-8 flex-wrap">
        <Link href="/" className="hover:text-foreground">Home</Link>
        <ChevronRight className="h-3 w-3" />
        <Link href="/marketplace" className="hover:text-foreground">Marketplace</Link>
        <ChevronRight className="h-3 w-3" />
        <Link href={`/marketplace?category=${product.category.slug}`} className="hover:text-foreground">
          {product.category.name}
        </Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground truncate">{product.title}</span>
      </nav>

      <div className="grid lg:grid-cols-[1.2fr_1fr] gap-12">
        {/* ── Left: gallery ── */}
        <div>
          <ProductGallery
            images={product.images}
            fallback={heroImg}
            title={product.title}
            conditionLabel={conditionLabel}
            mode={product.mode}
          />

          {/* Trust strip */}
          <div className="mt-6 grid grid-cols-2 gap-3">
            <TrustItem icon={Truck} title="Worldwide shipping" subtitle="Crated & insured" />
            <TrustItem icon={RotateCcw} title="Buyer protection" subtitle="Refund if not as described" />
          </div>
        </div>

        {/* ── Right: detail ── */}
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">
            {product.brand?.name ?? 'Generic'}
          </p>
          <h1
            className="text-3xl md:text-4xl font-bold leading-tight text-foreground"
            style={{ letterSpacing: '-0.03em' }}
          >
            {product.title}
          </h1>
          <div className="mt-3 flex items-center gap-3 text-sm">
            <Link
              href={`/marketplace?category=${product.category.slug}`}
              className="text-muted-foreground hover:text-foreground"
            >
              {product.category.name}
            </Link>
          </div>

          {/* Price block */}
          <div className="mt-7 rounded-2xl border border-border bg-card p-6">
            {product.priceCents ? (
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground font-bold">
                  List price
                </p>
                <div className="flex items-baseline gap-3 mt-2">
                  <span className="text-4xl font-bold data">
                    {formatPrice(product.priceCents, product.currency)}
                  </span>
                  <span className="text-sm text-muted-foreground">ex. VAT</span>
                </div>
                {mk.financing && (
                  <p className="mt-1 text-xs text-muted-foreground">{mk.financing}</p>
                )}
              </div>
            ) : (
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground font-bold">Custom pricing</p>
                <p className="text-2xl font-bold mt-2">Request a quote</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Typical response within 24 business hours from the supplier.
                </p>
              </div>
            )}

            <div className="mt-5 flex flex-col gap-2.5">
              {product.quantity <= 0 ? (
                <>
                  <div className="rounded-2xl border border-border bg-muted/40 p-4 text-center">
                    <p className="text-sm font-bold text-foreground">Sold</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      This unit is no longer available. We can source a similar one.
                    </p>
                  </div>
                  <Button size="lg" variant="accent" className="rounded-2xl font-semibold w-full" asChild>
                    <Link href={`/let-us-find-it?product=${product.slug}`}>Source a similar unit</Link>
                  </Button>
                  <StartThreadButton productSlug={product.slug} productTitle={product.title} />
                  <WishlistButton productSlug={product.slug} initiallySaved={saved} />
                </>
              ) : product.mode !== 'QUOTE_ONLY' && product.priceCents ? (
                <>
                  <form action={startCheckout.bind(null, product.slug)}>
                    <Button type="submit" size="lg" className="rounded-2xl font-semibold w-full">
                      Buy now
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </form>
                  <form action={addToCart.bind(null, product.slug, 1)}>
                    <Button type="submit" size="lg" variant="outline" className="rounded-2xl font-semibold w-full">
                      Add to cart
                    </Button>
                  </form>
                  <StartThreadButton productSlug={product.slug} productTitle={product.title} />
                  <WishlistButton productSlug={product.slug} initiallySaved={saved} />
                  <Link
                    href={`/let-us-find-it?product=${product.slug}`}
                    className="mt-1 text-center text-xs text-muted-foreground hover:text-foreground"
                  >
                    Buying in volume or need custom terms?{' '}
                    <span className="underline font-medium">Request a quote</span>
                  </Link>
                </>
              ) : (
                <>
                  <Button size="lg" variant="accent" className="rounded-2xl font-semibold w-full" asChild>
                    <Link href={`/let-us-find-it?product=${product.slug}`}>Request a quote</Link>
                  </Button>
                  <StartThreadButton productSlug={product.slug} productTitle={product.title} />
                  <WishlistButton productSlug={product.slug} initiallySaved={saved} />
                </>
              )}
            </div>
          </div>

          {/* Quick facts */}
          <dl className="mt-6 grid grid-cols-2 gap-3">
            <Fact icon={BadgeCheck} label="Condition" value={conditionLabel} />
            {product.yearMade && <Fact icon={Calendar} label="Year" value={String(product.yearMade)} />}
            <Fact
              icon={MapPin}
              label="Supplier"
              value="lab2date"
            />
            {mk.warranty && <Fact icon={ShieldCheck} label="Warranty" value={mk.warranty} />}
          </dl>
        </div>
      </div>

      {/* ── Below the fold ── */}
      <div className="mt-20 grid lg:grid-cols-[1.5fr_1fr] gap-12">
        <div className="space-y-10">
          <section>
            <h2 className="text-2xl font-bold mb-4" style={{ letterSpacing: '-0.025em' }}>
              Product description
            </h2>
            {product.description ? (
              <div
                className="prose-article text-foreground"
                dangerouslySetInnerHTML={{ __html: product.description }}
              />
            ) : (
              <p className="text-base text-muted-foreground leading-relaxed">
                {product.summary ?? 'Contact the supplier for full specifications and availability.'}
              </p>
            )}
          </section>

          {/* Item details */}
          <section>
            <h2 className="text-2xl font-bold mb-5" style={{ letterSpacing: '-0.025em' }}>
              Item details
            </h2>
            <dl className="grid sm:grid-cols-2 gap-x-10 rounded-2xl border border-border bg-card p-6">
              <DetailRow label="Status" value={product.quantity > 0 ? 'For sale · in stock' : 'Sold'} />
              <DetailRow label="Condition" value={conditionLabel} />
              <DetailRow label="Brand" value={product.brand?.name ?? '—'} />
              <DetailRow label="Category" value={product.category.name} />
              <DetailRow label="Supplier" value="lab2date" />
              <DetailRow label="Location" value={product.company?.country ?? 'EU'} />
              {product.yearMade && <DetailRow label="Year" value={String(product.yearMade)} />}
              {mk.warranty && <DetailRow label="Warranty" value={mk.warranty} />}
              {specs &&
                Object.entries(specs).map(([k, v]) => (
                  <DetailRow key={k} label={k} value={String(v)} />
                ))}
            </dl>
          </section>

          {(mk.inspection || mk.warranty) && (
            <section>
              <h2 className="text-2xl font-bold mb-3" style={{ letterSpacing: '-0.025em' }}>
                {mk.warranty ? 'Inspection & warranty' : 'Inspection'}
              </h2>
              <p className="text-base text-muted-foreground leading-relaxed">
                {mk.inspection && <>Every item passes a {mk.inspection}. </>}
                {mk.warranty && <>Ships with a {mk.warranty} and buyer protection.</>}
              </p>
            </section>
          )}

          <section>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-2xl font-bold" style={{ letterSpacing: '-0.025em' }}>
                Reviews
              </h2>
              {avgRating !== null && (
                <span className="text-sm font-semibold text-muted-foreground">
                  ★ {avgRating} · {reviews.length} review{reviews.length === 1 ? '' : 's'}
                </span>
              )}
            </div>

            {reviews.length === 0 ? (
              <p className="text-sm text-muted-foreground">No reviews yet — be the first.</p>
            ) : (
              <ul className="space-y-4">
                {reviews.map((r) => (
                  <li key={r.id} className="rounded-2xl border border-border bg-card p-5">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold text-sm">{r.user.name}</p>
                      <span className="text-sm" aria-label={`${r.rating} out of 5`}>
                        {'★'.repeat(r.rating)}
                        <span className="text-muted-foreground">{'★'.repeat(5 - r.rating)}</span>
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap leading-relaxed">
                      {r.body}
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      {new Date(r.createdAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {session ? (
              <form
                action={submitReview.bind(null, product.slug)}
                className="mt-5 rounded-2xl border border-border bg-card p-5 space-y-3"
              >
                <p className="text-sm font-semibold">Write a review</p>
                {reviewNote && (
                  <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Only verified buyers who purchased this item can leave a review.
                  </p>
                )}
                <select
                  name="rating"
                  defaultValue="5"
                  className="h-10 px-3 rounded-lg border border-input bg-background text-sm"
                >
                  {[5, 4, 3, 2, 1].map((n) => (
                    <option key={n} value={n}>{n} star{n === 1 ? '' : 's'}</option>
                  ))}
                </select>
                <textarea
                  name="body"
                  required
                  minLength={4}
                  rows={3}
                  placeholder="Share your experience with this item…"
                  className="w-full px-3 py-2.5 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <Button type="submit" className="rounded-full font-semibold">Submit review</Button>
              </form>
            ) : (
              <p className="text-sm text-muted-foreground mt-5">
                <Link href="/auth/sign-in" className="text-primary font-semibold">Sign in</Link> to write a review.
              </p>
            )}
          </section>
        </div>

        <aside className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-6 sticky top-24">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground mb-3">
              Sold by
            </p>
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm" style={{ letterSpacing: '-0.04em' }}>
                L2
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-foreground truncate">
                  lab2date
                </p>
                <p className="text-xs text-muted-foreground">
                  Inspected &amp; warrantied · ships worldwide
                </p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 pt-4 border-t border-border text-center">
              <div>
                <div className="text-base font-bold tabular-nums">{companyListings.toLocaleString()}</div>
                <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">live listings</div>
              </div>
              <div>
                <div className="text-base font-bold">{product.company?.country ?? '—'}</div>
                <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">location</div>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* ── Similar items ── */}
      {similar.length > 0 && (
        <section className="mt-20">
          <div className="flex items-end justify-between mb-8 gap-4 flex-wrap">
            <h2 className="text-2xl md:text-3xl font-bold" style={{ letterSpacing: '-0.03em' }}>
              Similar in {product.category.name}
            </h2>
            <Link
              href={`/marketplace?category=${product.category.slug}`}
              className="text-sm font-semibold text-primary inline-flex items-center gap-1 hover:gap-2 transition-all"
            >
              View all <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {similar.map((s) => (
              <ProductCard
                key={s.slug}
                p={{
                  slug: s.slug,
                  title: s.title,
                  brand: s.brand?.name ?? '—',
                  supplier: 'lab2date',
                  illustration: (s.illustration ?? 'balance') as IllustrationName,
                  imageUrl: s.images?.[0] ?? null,
                  condition: s.condition,
                  mode: s.mode,
                  priceCents: s.priceCents,
                  currency: s.currency,
                  yearMade: s.yearMade,
                }}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-2.5 border-b border-dashed border-border last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-right">{value}</dd>
    </div>
  );
}

function TrustItem({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 text-center">
      <Icon className="h-5 w-5 mx-auto text-primary" />
      <p className="text-xs font-semibold mt-2">{title}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
    </div>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  href?: string;
}) {
  const inner = (
    <div className="rounded-xl border border-border bg-card p-4 hover:border-primary/40 transition-colors">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <dt className="text-[10px] font-bold uppercase tracking-[0.18em]">{label}</dt>
      </div>
      <dd className="text-sm font-semibold mt-1.5">{value}</dd>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}
