import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth-server';
import { firstPublicImage } from '@/lib/media/public-src';
import { countryOptions } from '@/lib/compliance/country';
import { checkoutPrefill, computeCheckout, loadCheckoutSettings } from '@/lib/checkout/server';
import { CheckoutForm } from '@/components/checkout/CheckoutForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Checkout' };

/**
 * Cart checkout. The whole cart is ordered or nothing: a row that can no
 * longer be bought (sold out, quote only, price hidden, unpublished) sends the
 * buyer back to the cart, which marks it. Same engine as Buy now.
 */
export default async function CartCheckoutPage(props: { searchParams: Promise<{ payment?: string; canceled?: string }> }) {
  const sp = await props.searchParams;
  const session = await requireSession({ redirectTo: '/checkout/cart' });
  const settings = await loadCheckoutSettings(session.user.id);
  const initial = { ...(await checkoutPrefill(session.user, settings)), source: 'cart' as const, slug: '' };
  const [q, countries] = await Promise.all([computeCheckout(session.user.id, { kind: 'cart' }, initial, settings), countryOptions()]);
  if (q.loaded.refusal?.code === 'EMPTY') redirect('/app/cart?empty=1');
  if (q.loaded.refusal) redirect('/app/cart?unavailable=1');
  const images = Object.fromEntries(Object.entries(q.loaded.images).map(([id, imgs]) => [id, firstPublicImage(imgs)]));
  const { rules } = settings;
  return (
    <div className="container-px py-10 pb-32 max-w-6xl mx-auto">
      <CheckoutForm
        source="cart"
        slug=""
        initial={initial}
        initialQuote={q.view}
        countries={countries}
        rules={{ salesMode: rules.salesMode, requireCompanyAndId: rules.requireCompanyAndId, poMode: rules.poMode, poRequiredByProfile: rules.poRequiredByProfile, askInvoiceEmail: rules.askInvoiceEmail, requirePhone: rules.requirePhone }}
        declarationText={settings.declarationText}
        termsNote={settings.termsNote}
        accountEmail={session.user.email}
        images={images}
        banner={sp.payment || sp.canceled ? 'The card payment was not completed. No payment was taken.' : null}
        backHref="/app/cart"
        backLabel="Back to cart"
      />
    </div>
  );
}
