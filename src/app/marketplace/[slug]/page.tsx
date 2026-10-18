import { cache } from 'react';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  BadgeCheck,
  ShieldCheck,
  Truck,
  RotateCcw,
  Calendar,
  ArrowRight,
  ChevronRight,
  Building2,
  ClipboardCheck,
  FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getCatalogPolicy, getConditionGrades } from '@/lib/catalog/policy';
import { resolveWarranty, resolveInspection } from '@/lib/catalog/warranty';
import { resolveOfferPrice } from '@/lib/catalog/offer-price';
import { buildProductJsonLd, isPlaceholderBrand, productMetaDescription } from '@/lib/catalog/jsonld';
import { publicProductImages, firstPublicImage, absoluteSiteUrl } from '@/lib/media/public-src';
import { StartThreadButton } from '@/components/messages/StartThreadButton';
import { WishlistButton } from '@/components/marketplace/WishlistButton';
import { ProductGallery, type GalleryStatusBadge } from '@/components/marketplace/ProductGallery';
import { ProductCard } from '@/components/marketplace/ProductCard';
import { getProductBySlug, getRemovedListingOutcome, getSimilarProducts } from '@/lib/marketplace/queries';
import { isDeliverableEmail } from '@/lib/email-address';
import { resolveProductSlug } from '@/lib/products/slug';
import { prisma } from '@/lib/db';
import { startCheckout } from '@/lib/orders/actions';
import { addToCart } from '@/lib/cart/actions';
import { getMarketing } from '@/lib/marketing';
import { submitReview } from '@/lib/reviews/actions';
import { isWishlisted } from '@/lib/wishlist/actions';
import { getServerSession } from '@/lib/auth-server';
import { PriceTag } from '@/components/pricing/PriceTag';
import { loadPriceDisplay } from '@/lib/pricing/server';
import { sanitizeRichHtml } from '@/lib/sanitize';
import { ensureSettingsLoaded, settingBool } from '@/lib/settings';
import { reservedUnits } from '@/lib/stock/reserve';

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ review?: string; sold?: string; quoteonly?: string; canceled?: string; payment?: string }>;
}

// One lookup per request, shared by generateMetadata and the page. Imported
// slugs can hold a literal '%c2%b5' that the URL segment never spells the
// same way — match it as stored (see resolveProductSlug).
const loadListing = cache(async (param: string) => getProductBySlug(await resolveProductSlug(param)));

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const params = await props.params;
  const product = await loadListing(params.slug);
  // BUG-024 / S10: don't leak titles of non-public (DRAFT/PENDING_REVIEW/
  // ARCHIVED) products via metadata. Owner/admin preview still renders the
  // page itself; generic metadata is acceptable there.
  if (!product || product.status !== 'PUBLISHED') return { title: 'Not found', robots: { index: false, follow: true } };
  const [policy, grades] = await Promise.all([getCatalogPolicy(), getConditionGrades()]);
  // Never "Other …": a placeholder brand is not a brand.
  const brandName = isPlaceholderBrand(product.brand, policy.placeholderBrands) ? null : (product.brand?.name ?? null);
  // The admin's search title / description (product form → Search engines),
  // else the listing's own text (no sentence with another price), else one
  // built from its facts (Settings → Catalog & claims).
  const title = product.seoTitle?.trim() || product.title;
  const description = productMetaDescription({
    seoDescription: product.seoDescription,
    summary: product.summary,
    description: product.description,
    title: product.title,
    brandName,
    conditionLabel: grades[product.condition].label,
    categoryName: product.category.name,
    yearMade: product.yearMade,
    siteName: policy.siteName,
    format: policy.metaDescriptionFormat,
  });
  // OG image: our own copy, on our own domain — never the supplier's URL;
  // without one, the site's link-preview picture (Settings → Site texts & pages).
  const ownImage = firstPublicImage(product.images);
  const image = ownImage ? absoluteSiteUrl(ownImage) : policy.linkPreview.image;
  return {
    title,
    description,
    alternates: { canonical: `/marketplace/${product.slug}` },
    openGraph: {
      title,
      description,
      type: 'website',
      siteName: policy.siteName,
      locale: policy.linkPreview.locale,
      url: `/marketplace/${product.slug}`,
      images: image ? [image] : undefined,
    },
    twitter: { card: image ? 'summary_large_image' : 'summary', title, description },
  };
}

/**
 * No public listing at this address: a Redirects rule or, for an archived
 * listing, Settings → Catalog & claims → “Address of an archived listing”
 * may send it on permanently; otherwise the "page not found" page (noindex).
 */
async function answerNonPublicListing(slug: string, listing: { status: string; categorySlug: string } | null): Promise<never> {
  const policy = await getCatalogPolicy();
  const outcome = await getRemovedListingOutcome(slug, listing, policy.archivedListingResponse);
  if (outcome.kind === 'redirect') permanentRedirect(outcome.to);
  notFound();
}

export default async function ProductDetailPage(props: PageProps) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const product = await loadListing(params.slug);
  if (!product) return await answerNonPublicListing(params.slug, null);

  const session = await getServerSession();

  // ─── BUG-024 / invariant S10 ──────────────────────────────────────────
  // Non-PUBLISHED products (DRAFT / PENDING_REVIEW / ARCHIVED) are not
  // public: direct-URL access 404s, same contract as /checkout/[slug].
  // The owning seller and ADMINs may still open the page as a preview.
  const viewerRole = (session?.user as { role?: string } | undefined)?.role;
  const canPreviewUnpublished =
    viewerRole === 'ADMIN' || (!!session?.user.id && session.user.id === product.sellerId);
  if (product.status !== 'PUBLISHED' && !canPreviewUnpublished) {
    return await answerNonPublicListing(product.slug, { status: product.status, categorySlug: product.category.slug });
  }

  const reviewNote = searchParams?.review === 'needpurchase';
  const reviewInvalid = searchParams?.review === 'invalid';
  const [mk, policy, grades, display] = await Promise.all([getMarketing(), getCatalogPolicy(), getConditionGrades(), loadPriceDisplay()]);

  const saved = await isWishlisted(session?.user.id ?? null, product.id);
  // Only a published listing can be saved (toggleWishlist refuses others);
  // an already saved one can still be removed from a preview.
  const wishlistButton =
    product.status === 'PUBLISHED' || saved ? <WishlistButton productSlug={product.slug} initiallySaved={saved} /> : null;
  // Only verified buyers may review (submitReview enforces it). Show the form
  // only to them, so nobody types a review that is then thrown away.
  const canReview = session
    ? !!(await prisma.orderItem.findFirst({
        where: {
          productId: product.id,
          order: { buyerId: session.user.id, status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] } },
        },
        select: { id: true },
      }))
    : false;
  // Checkout / cart bounced the buyer here — say why instead of landing silently.
  const bounceNote =
    searchParams?.sold
      ? 'This unit is no longer available as you saw it (sold, reserved or updated), so no order was created and nothing is due. The listing below shows its current state.'
      : searchParams?.quoteonly
        ? 'This item can’t be bought online right now — request a quote instead. No order was created.'
        : searchParams?.canceled || searchParams?.payment
          ? 'Checkout was not completed. No payment was taken.'
          : null;
  const similar = await getSimilarProducts(product.categoryId, product.slug, 4);
  // "Sold by" = the seller of record: its own number of live listings (never
  // the hidden supplier's, which would reveal who holds the unit) — the count
  // the header already made for this request (getMarketing), not a second one.
  const sellerListings = policy.sellerBoxShowListings
    ? /^\d+$/.test(mk.listings) ? Number(mk.listings).toLocaleString('en-GB') : mk.listings
    : null;
  // Imported items belong to importer accounts without an inbox: questions go
  // to the lab2date team (a support ticket), not to a "seller" nobody reads.
  const sellerReachable = isDeliverableEmail(product.seller.email);
  const contact = {
    channel: (sellerReachable ? 'SELLER' : 'TEAM') as 'SELLER' | 'TEAM',
    teamName: policy.sellerLegalName,
    minChars: policy.productQuestionMinChars,
  };
  // Aggregate for count+average (accurate over ALL reviews), but only render
  // the latest 24 — an unbounded findMany on a public page is a DoS lever.
  const [reviewAgg, reviews] = await Promise.all([
    prisma.review.aggregate({ where: { productId: product.id }, _avg: { rating: true }, _count: true }),
    prisma.review.findMany({
      where: { productId: product.id },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true } } },
      take: 24,
    }),
  ]);
  const reviewCount = reviewAgg._count;
  const avgRating =
    reviewCount > 0 && reviewAgg._avg.rating != null
      ? Math.round(reviewAgg._avg.rating * 10) / 10
      : null;

  const base = (process.env.BETTER_AUTH_URL ?? 'https://labtodate.com').replace(/\/+$/, '');
  // ── What we may truthfully say about THIS unit ──
  const grade = grades[product.condition];
  const conditionLabel = grade.label;
  const warranty = resolveWarranty(product, grade, policy.warrantyFallbackText, policy.warrantyMonthsFormat);
  const inspection = resolveInspection(product, policy.inspectionRequiresReport);
  // Reports are served by /api/inspection-report (only while the item is published).
  const inspectionReport = inspection.reportUrl?.startsWith('/api/inspection-report/') ? inspection.reportUrl : null;
  const photos = publicProductImages(product.images);
  const brandKnown = !isPlaceholderBrand(product.brand, policy.placeholderBrands);
  // Same resolver as the price block (shop markup / force-quote / hidden price).
  const offer = resolveOfferPrice(
    { priceCents: product.basePriceCents, currency: product.currency, mode: product.baseMode, priceOnHold: product.priceOnHold },
    product.company,
  );
  // Not sold here: the supplier no longer has it (out of stock / removed /
  // on backorder). Never "Sold" — and a backorder says so.
  const onBackorder = product.sourceAvailability === 'onbackorder';
  const unavailableAtSource =
    product.quantity <= 0 && (!!product.removedAtSourceAt || ['outofstock', 'removed', 'onbackorder'].includes(product.sourceAvailability ?? ''));
  const backorderUnavailable = unavailableAtSource && onBackorder && !product.removedAtSourceAt;
  const sellableBackorder = product.quantity > 0 && onBackorder;
  // A unit held for another buyer's accepted offer / unpaid order (A09) is
  // "Reserved", not "Sold" — it comes back if that order is not completed.
  await ensureSettingsLoaded();
  const reservedForOther = product.quantity <= 0 && !unavailableAtSource && settingBool('SHOW_RESERVED_BADGE') && (await reservedUnits(product.id)) > 0;
  const available = product.quantity > 0;
  const stockTitle = backorderUnavailable
    ? policy.texts.backorderTitle
    : unavailableAtSource ? policy.texts.unavailableTitle : reservedForOther ? 'Reserved' : policy.texts.soldTitle;
  // The price block: a unit that cannot be ordered never promises "Request a
  // quote"; a sold / unavailable one shows its last price or none (Settings →
  // Catalog & claims), a reserved one keeps its list price (it may come back).
  const priceShown = !product.priceOnHold && !!product.priceCents && (available || reservedForOther || policy.soldPriceShown);
  const priceLabel = available || reservedForOther ? 'List price' : policy.texts.soldPriceLabel;
  const priceHeader = available || priceShown;
  // Gallery badge: how this unit can be bought now, or why it cannot.
  const galleryBadge: GalleryStatusBadge | null = !available
    ? { label: stockTitle, tone: 'muted' }
    : product.buyable && product.mode === 'BUY_NOW'
      ? { label: 'Buy now', tone: 'success' }
      : product.mode === 'QUOTE_ONLY'
        ? { label: 'Quote only', tone: 'accent' }
        : null;
  // Product structured data only with an offer (the price the page shows, in
  // its VAT basis) or a rating; null otherwise (see buildProductJsonLd).
  const jsonLd = buildProductJsonLd({
    baseUrl: base,
    product,
    reserved: reservedForOther,
    images: photos,
    brand: product.brand,
    placeholderBrands: policy.placeholderBrands,
    categoryName: product.category.name,
    schemaOrgCondition: grade.schemaOrgCondition,
    offer,
    priceShown,
    display,
    sellerName: policy.sellerLegalName,
    returnPolicy: policy.seoReturnPolicy,
    rating: reviewCount > 0 && avgRating ? { average: avgRating, count: reviewCount } : null,
  });
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: base },
      { '@type': 'ListItem', position: 2, name: 'Marketplace', item: `${base}/marketplace` },
      { '@type': 'ListItem', position: 3, name: product.category.name, item: `${base}/marketplace?category=${product.category.slug}` },
      { '@type': 'ListItem', position: 4, name: product.title, item: `${base}/marketplace/${product.slug}` },
    ],
  };

  const specs = (product.specs as Record<string, string> | null) ?? null;
  const trustTiles = [
    {
      key: 'warranty',
      icon: ShieldCheck,
      title: warranty.headline,
      subtitle: warranty.hasWarranty ? (warranty.source === 'ITEM' ? 'On this unit' : `${conditionLabel} items`) : 'See terms',
      href: warranty.hasWarranty ? undefined : '/legal/terms',
    },
    ...(inspection.claim && inspection.date
      ? [{ key: 'inspected', icon: ClipboardCheck, title: 'Inspected', subtitle: inspection.date.toLocaleDateString('en-GB', { dateStyle: 'medium' }) }]
      : []),
    ...(policy.shippingClaim ? [{ key: 'shipping', icon: Truck, title: policy.shippingClaim, subtitle: 'Shipping' }] : []),
    ...(policy.returnsClaim ? [{ key: 'returns', icon: RotateCcw, title: policy.returnsClaim, subtitle: 'Returns' }] : []),
  ];

  return (
    <div className="container-px py-10 md:py-14">
      {jsonLd && <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd).replace(/</g, '\\u003c') }}
      />
      {bounceNote && (
        <div role="status" className="mb-6 rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-300">
          {bounceNote}
        </div>
      )}
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
            images={photos}
            photoMode={policy.missingPhotoMode}
            illustration={product.illustration}
            title={product.title}
            conditionLabel={conditionLabel}
            statusBadge={galleryBadge}
          />
          {photos.length === 0 && (
            <div className="mt-3">
              <StartThreadButton
                productSlug={product.slug}
                productTitle={product.title}
                kind="PHOTOS"
                {...contact}
                label={policy.texts.askPhotosLabel}
                initialMessage={policy.texts.askPhotosMessage.replace(/\{TITLE\}/g, product.title)}
              />
            </div>
          )}

          {/* Trust strip: only what is true for THIS unit, plus the promises
              the owner configured (Settings → Catalog & claims). */}
          <div className={`mt-6 grid gap-3 ${trustTiles.length === 3 ? 'grid-cols-3' : trustTiles.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
            {trustTiles.map((t) => (
              <TrustItem key={t.key} icon={t.icon} title={t.title} subtitle={t.subtitle} href={'href' in t ? t.href : undefined} />
            ))}
          </div>
        </div>

        {/* ── Right: detail ── */}
        <div>
          {brandKnown && (
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">
              {product.brand?.name}
            </p>
          )}
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
            {/* A unit that cannot be ordered: its stock box below is the
                header (no "Request a quote" promise above a sold unit). */}
            {available && product.priceOnHold ? (
              <div data-testid="pdp-price-review">
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground font-bold">Price</p>
                <p className="text-2xl font-bold mt-2">Being confirmed</p>
                <p className="mt-1 text-xs text-muted-foreground">{policy.texts.priceReview}</p>
              </div>
            ) : priceShown && product.priceCents ? (
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground font-bold" data-testid="pdp-price-label">
                  {priceLabel}
                </p>
                <div className="mt-2" data-testid="pdp-price">
                  <PriceTag netCents={product.priceCents} currency={product.currency} size="xl" scheme={product.vatScheme} settings={display} />
                </div>
                {display.note && <p className="mt-1.5 text-xs text-muted-foreground">{display.note}</p>}
                {sellableBackorder && (
                  <p className="mt-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300" data-testid="pdp-backorder-lead">
                    {policy.texts.backorderLeadTime}
                  </p>
                )}
                {available && mk.financing && (
                  <p className="mt-1 text-xs text-muted-foreground">{mk.financing}</p>
                )}
              </div>
            ) : available ? (
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground font-bold">Custom pricing</p>
                <p className="text-2xl font-bold mt-2">Request a quote</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {mk.quoteTurnaround
                    ? `We reply with a written offer, usually within ${mk.quoteTurnaround}.`
                    : 'We reply with a written offer.'}
                </p>
              </div>
            ) : null}

            <div className={`${priceHeader ? 'mt-5 ' : ''}flex flex-col gap-2.5`}>
              {!available ? (
                <>
                  <div className="rounded-2xl border border-border bg-muted/40 p-4 text-center">
                    <p className="text-sm font-bold text-foreground" data-testid="pdp-stock-title">
                      {stockTitle}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {backorderUnavailable
                        ? policy.texts.backorderText
                        : unavailableAtSource
                          ? policy.texts.unavailableText
                          : reservedForOther
                            ? policy.texts.reservedText
                            : policy.texts.soldText}
                    </p>
                  </div>
                  <Button size="lg" variant="accent" className="rounded-2xl font-semibold w-full" asChild>
                    <Link href={`/let-us-find-it?product=${encodeURIComponent(product.slug)}`}>Source a similar unit</Link>
                  </Button>
                  <StartThreadButton productSlug={product.slug} productTitle={product.title} {...contact} />
                  {wishlistButton}
                </>
              ) : product.buyable ? (
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
                  <StartThreadButton productSlug={product.slug} productTitle={product.title} {...contact} />
                  {wishlistButton}
                  <Link
                    href={`/let-us-find-it?product=${encodeURIComponent(product.slug)}`}
                    className="mt-1 text-center text-xs text-muted-foreground hover:text-foreground"
                  >
                    Buying in volume or need custom terms?{' '}
                    <span className="underline font-medium">Request a quote</span>
                  </Link>
                </>
              ) : (
                <>
                  <Button size="lg" variant="accent" className="rounded-2xl font-semibold w-full" asChild>
                    <Link href={`/let-us-find-it?product=${encodeURIComponent(product.slug)}`}>Request a quote</Link>
                  </Button>
                  <StartThreadButton productSlug={product.slug} productTitle={product.title} {...contact} />
                  {wishlistButton}
                </>
              )}
            </div>
          </div>

          {/* Quick facts */}
          <dl className="mt-6 grid grid-cols-2 gap-3">
            <Fact icon={BadgeCheck} label="Condition" value={conditionLabel} />
            {product.yearMade && <Fact icon={Calendar} label="Year" value={String(product.yearMade)} />}
            <Fact icon={Building2} label="Sold by" value={policy.sellerLegalName} />
            <Fact icon={ShieldCheck} label="Warranty" value={warranty.headline} />
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
                dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(product.description) }}
              />
            ) : (
              <p className="text-base text-muted-foreground leading-relaxed">
                {product.summary ?? policy.texts.noDescription}
              </p>
            )}
          </section>

          {/* Item details */}
          <section>
            <h2 className="text-2xl font-bold mb-5" style={{ letterSpacing: '-0.025em' }}>
              Item details
            </h2>
            <dl className="grid sm:grid-cols-2 gap-x-10 rounded-2xl border border-border bg-card p-6">
              <DetailRow
                label="Status"
                value={
                  product.quantity > 0
                    ? sellableBackorder ? 'For sale · on backorder at our supplier' : 'For sale · in stock'
                    : stockTitle
                }
              />
              <DetailRow label="Condition" value={conditionLabel} />
              {product.conditionNotes && <DetailRow label="Condition notes" value={product.conditionNotes} />}
              <DetailRow label="Brand" value={brandKnown && product.brand ? product.brand.name : 'Not specified'} />
              {product.mpn && <DetailRow label="Part number (MPN)" value={product.mpn} />}
              {product.sku && <DetailRow label="Stock number" value={product.sku} />}
              <DetailRow label="Category" value={product.category.name} />
              <DetailRow label="Sold by" value={policy.sellerLegalName} />
              {product.company?.country && <DetailRow label="Location" value={product.company.country} />}
              {product.yearMade && <DetailRow label="Year" value={String(product.yearMade)} />}
              <DetailRow label="Warranty" value={warranty.full} />
              {specs &&
                Object.entries(specs).map(([k, v]) => (
                  <DetailRow key={k} label={k} value={String(v)} />
                ))}
            </dl>
          </section>

          <section>
            <h2 className="text-2xl font-bold mb-3" style={{ letterSpacing: '-0.025em' }}>
              Inspection &amp; warranty
            </h2>
            <div className="space-y-3 text-base text-muted-foreground leading-relaxed">
              <p>
                <span className="font-semibold text-foreground">Warranty:</span> {warranty.full}.
              </p>
              {grade.description && (
                <p>
                  <span className="font-semibold text-foreground">{conditionLabel}:</span> {grade.description}
                </p>
              )}
              {inspection.claim && inspection.date ? (
                <p>
                  <span className="font-semibold text-foreground">Inspection:</span> this unit was inspected on{' '}
                  {inspection.date.toLocaleDateString('en-GB', { dateStyle: 'long' })}.
                  {inspection.notes ? ` ${inspection.notes}` : ''}
                  {inspectionReport && (
                    <>
                      {' '}
                      <a
                        href={inspectionReport}
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
                      >
                        <FileText className="h-3.5 w-3.5" /> View the inspection report
                      </a>
                    </>
                  )}
                </p>
              ) : (
                <p>
                  <span className="font-semibold text-foreground">Inspection:</span> {policy.inspectionNoneText}
                </p>
              )}
            </div>
          </section>

          <section>
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-2xl font-bold" style={{ letterSpacing: '-0.025em' }}>
                Reviews
              </h2>
              {avgRating !== null && (
                <span className="text-sm font-semibold text-muted-foreground">
                  ★ {avgRating} · {reviewCount} review{reviewCount === 1 ? '' : 's'}
                </span>
              )}
            </div>

            {reviews.length === 0 ? (
              <p className="text-sm text-muted-foreground">{policy.texts.reviewsEmpty}</p>
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

            {session && !canReview ? (
              <p className="mt-5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {reviewNote ? 'Your review wasn’t saved — ' : ''}Only verified buyers who purchased this item can leave a review.
              </p>
            ) : session ? (
              <form
                id="write-review"
                action={submitReview.bind(null, product.slug)}
                className="mt-5 rounded-2xl border border-border bg-card p-5 space-y-3 scroll-mt-24"
              >
                <p className="text-sm font-semibold">Write a review</p>
                {reviewNote && (
                  <p className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-300">
                    Only verified buyers who purchased this item can leave a review.
                  </p>
                )}
                {reviewInvalid && (
                  <p role="alert" className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-900 dark:text-amber-300">
                    Your review wasn&apos;t saved: it must be between 4 and 2,000 characters, with a rating from 1 to 5 stars.
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
                  maxLength={2000}
                  aria-label="Your review"
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
          <div className="rounded-2xl border border-border bg-card p-6 lg:sticky lg:top-24">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground mb-3">
              Sold by
            </p>
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-sm" style={{ letterSpacing: '-0.04em' }}>
                {policy.sellerLegalName.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'L2'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-foreground truncate">{policy.sellerLegalName}</p>
                {(policy.sellerKvk || policy.sellerVat) && (
                  <p className="text-xs text-muted-foreground">
                    {[policy.sellerKvk && `KvK ${policy.sellerKvk}`, policy.sellerVat && `VAT ${policy.sellerVat}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                )}
                {product.company?.verifiedAt && (
                  <p className="text-xs text-muted-foreground mt-0.5 inline-flex items-center gap-1">
                    <BadgeCheck className="h-3.5 w-3.5 text-primary" /> Sourced from a supplier we verified
                  </p>
                )}
              </div>
            </div>
            <div className={`mt-4 grid ${sellerListings !== null ? 'grid-cols-2' : 'grid-cols-1'} gap-3 pt-4 border-t border-border text-center`}>
              {sellerListings !== null && (
                <div data-testid="seller-live-listings">
                  <div className="text-base font-bold tabular-nums">{sellerListings}</div>
                  <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">live listings</div>
                </div>
              )}
              <div>
                <div className="text-base font-bold">{product.company?.country || '—'}</div>
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
                  supplier: policy.sellerLegalName,
                  illustration: s.illustration,
                  imageUrl: firstPublicImage(s.images),
                  condition: s.condition,
                  mode: s.mode,
                  priceCents: s.priceCents,
                  currency: s.currency,
                  yearMade: s.yearMade,
                  vatScheme: s.vatScheme,
                }}
                display={display}
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
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  href?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 text-center">
      <Icon className="h-5 w-5 mx-auto text-primary" />
      <p className="text-xs font-semibold mt-2">{title}</p>
      {href ? (
        <Link href={href} className="text-[11px] font-semibold text-primary hover:underline mt-0.5 inline-block">
          {subtitle}
        </Link>
      ) : (
        <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
      )}
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
