import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { firstPublicImage } from '@/lib/media/public-src';
import { countryOptions } from '@/lib/compliance/country';
import { sellPriceOf, SELL_PRICE_SELECT } from '@/lib/pricing/server';
import { checkoutPrefill, computeCheckout, loadCheckoutSettings } from '@/lib/checkout/server';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Checkout' };

/**
 * Buy-now checkout for one unit. Prices, shipping, VAT and the country policy
 * come from the shared checkout engine (lib/checkout) — the same one the cart
 * uses — and the order is created with exactly the total shown here.
 */
export default async function CheckoutProductPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ payment?: string; canceled?: string }>;
}) {
  const [{ slug }, sp] = await Promise.all([props.params, props.searchParams]);
  const session = await requireSession({ redirectTo: `/checkout/${slug}` });
  const product = await prisma.product.findUnique({ where: { slug }, select: { slug: true, images: true, id: true, ...SELL_PRICE_SELECT } });
  if (!product) notFound();
  // Not buyable: explain on the product page instead of a dead form.
  if (product.status !== 'PUBLISHED') redirect('/marketplace?gone=1');
  const price = sellPriceOf(product);
  if (price.soldOut) redirect(`/marketplace/${product.slug}?sold=1`);
  if (!price.buyable) redirect(`/marketplace/${product.slug}?quoteonly=1`);

  const settings = await loadCheckoutSettings(session.user.id);
  const initial = { ...(await checkoutPrefill(session.user, settings)), source: 'single' as const, slug: product.slug };
  const [q, countries] = await Promise.all([computeCheckout(session.user.id, { kind: 'single', slug: product.slug }, initial, settings), countryOptions()]);
  const { rules } = settings;
  return (
    <div className="container-px py-10 pb-32 max-w-6xl mx-auto">
      <CheckoutForm
        source="single"
        slug={product.slug}
        initial={initial}
        initialQuote={q.view}
        countries={countries}
        rules={{ salesMode: rules.salesMode, requireCompanyAndId: rules.requireCompanyAndId, poMode: rules.poMode, poRequiredByProfile: rules.poRequiredByProfile, askInvoiceEmail: rules.askInvoiceEmail, requirePhone: rules.requirePhone }}
        declarationText={settings.declarationText}
        termsNote={settings.termsNote}
        accountEmail={session.user.email}
        images={{ [product.id]: firstPublicImage(product.images) }}
        banner={sp.payment || sp.canceled ? 'The card payment was not completed. No payment was taken.' : null}
        backHref={`/marketplace/${product.slug}`}
        backLabel="Back to product"
      />
    </div>
  );
}
