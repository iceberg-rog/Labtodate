import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft, ShoppingBag, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { Prisma } from '@prisma/client';
import { startCartCheckoutWithAddress } from '@/lib/cart/actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Checkout — shipping details' };

const COUNTRIES: { code: string; name: string }[] = [
  { code: 'NL', name: 'Netherlands' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'BE', name: 'Belgium' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'IE', name: 'Ireland' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'PT', name: 'Portugal' },
  { code: 'AT', name: 'Austria' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'PL', name: 'Poland' },
  { code: 'CZ', name: 'Czechia' },
  { code: 'US', name: 'United States' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'IR', name: 'Iran' },
  { code: 'TR', name: 'Türkiye' },
  { code: '__OTHER', name: 'Other — request a shipping quote' },
];

const FIELD_LABEL: Record<string, string> = {
  name: 'Full name',
  phone: 'Phone',
  line1: 'Address line 1',
  city: 'City',
  postal: 'Postal code',
  country: 'Country',
};

/**
 * Address-collection page for cart checkout.
 *
 * BUG-011 fix: previously /app/cart submitted directly to `checkoutCart`,
 * which created the order WITHOUT a shipping address whenever Stripe
 * was off (the current production posture). This route is the canonical
 * place to collect address before the order row exists.
 */
export default async function CartCheckoutPage(
  props: {
    searchParams: Promise<{ missing?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const session = await requireSession({ redirectTo: '/checkout/cart' });

  const items = await prisma.cartItem.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    include: { product: { select: { slug: true, title: true, priceCents: true, currency: true, images: true, status: true, mode: true } } },
  });
  const valid = items.filter(
    (i) => i.product.status === 'PUBLISHED' && i.product.priceCents && i.product.mode !== 'QUOTE_ONLY',
  );
  if (valid.length === 0) redirect('/app/cart?empty=1');

  const currency = valid[0].product.currency || 'EUR';
  const subtotal = valid.reduce((s, i) => s + (i.product.priceCents ?? 0) * i.quantity, 0);
  const shipping = Math.max(0, parseInt(process.env.DEFAULT_SHIPPING_CENTS || '0', 10) || 0);
  const taxPct = Math.max(0, parseFloat(process.env.DEFAULT_TAX_PERCENT || '0') || 0);
  const tax = Math.round((subtotal * taxPct) / 100);
  const total = subtotal + shipping + tax;

  // Prefill from the buyer's most recent order that has an address.
  const last = await prisma.order.findFirst({
    where: { buyerId: session.user.id, shippingAddress: { not: Prisma.JsonNull } },
    orderBy: { createdAt: 'desc' },
    select: { shippingAddress: true },
  });
  const seed = (last?.shippingAddress as { name?: string; phone?: string; address?: Record<string, string> } | null) ?? null;
  const seedAddr = seed?.address ?? {};

  const missing = (searchParams.missing ?? '').split(',').filter(Boolean);

  return (
    <div className="container-px py-10 pb-32 max-w-4xl mx-auto">
      <Link
        href="/app/cart"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6"
      >
        <ChevronLeft className="h-4 w-4" /> Back to cart
      </Link>
      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
        <form action={startCartCheckoutWithAddress} className="space-y-5">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Shipping details</h1>
            <p className="text-muted-foreground mt-1">
              Tell us where to ship this. We&rsquo;ll dispatch as soon as your bank transfer
              clears our manual verification.
            </p>
          </div>

          {missing.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              Please fill in: <strong>{missing.map((m) => FIELD_LABEL[m] ?? m).join(', ')}</strong>.
            </div>
          )}

          <section className="rounded-2xl border border-border bg-card p-5 space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Contact</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              <Field label="Full name" name="name" required minLength={2}
                autoComplete="name"
                defaultValue={seed?.name ?? session.user.name}
                placeholder="Jane Doe" />
              <Field label="Phone (we use this if there's a delivery issue)" name="phone" required type="tel"
                pattern="[\d\s+\(\)\-]{6,20}"
                title="Digits, spaces, +, ( ), and dashes only (6–20 chars)"
                autoComplete="tel"
                defaultValue={seed?.phone ?? ''}
                placeholder="+31 6 12345678" />
            </div>
            <Field label="Email" name="emailDisplay" defaultValue={session.user.email} disabled />
          </section>

          <section className="rounded-2xl border border-border bg-card p-5 space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-primary">Ship to</h2>
            <Field label="Address line 1" name="line1" required minLength={3} autoComplete="address-line1" defaultValue={String(seedAddr.line1 ?? '')} placeholder="Street, building, unit" />
            <Field label="Address line 2 (optional)" name="line2" autoComplete="address-line2" defaultValue={String(seedAddr.line2 ?? '')} placeholder="Floor, suite, attention-to" />
            <div className="grid sm:grid-cols-[1fr_1fr] gap-4">
              <Field label="City" name="city" required minLength={2} autoComplete="address-level2" defaultValue={String(seedAddr.city ?? '')} placeholder="Amsterdam" />
              <Field label="Postal code" name="postal" required minLength={2} autoComplete="postal-code" defaultValue={String(seedAddr.postal_code ?? '')} placeholder="1011 AB" />
            </div>
            <div className="grid sm:grid-cols-[1fr_1fr] gap-4">
              <Field label="State / region (optional)" name="state" autoComplete="address-level1" defaultValue={String(seedAddr.state ?? '')} placeholder="Noord-Holland" />
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">Country</span>
                <select
                  name="country"
                  required
                  defaultValue={String(seedAddr.country ?? 'NL')}
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
            <h2 className="text-sm font-bold uppercase tracking-[0.15em] text-amber-900 flex items-center gap-2">
              <Building2 className="h-4 w-4" /> Payment: bank transfer
            </h2>
            <p className="text-sm text-amber-900 mt-2 leading-relaxed">
              Once you submit your order, we&rsquo;ll email you our bank details. After your
              transfer arrives, upload the receipt from your order page and our team will
              verify it manually. <strong>No charge is taken at this step.</strong>
            </p>
          </section>

          <div className="flex items-center gap-3 flex-wrap">
            <Button type="submit" size="lg" className="rounded-2xl font-semibold">
              Submit order — bank-transfer details to follow
            </Button>
            <span className="text-xs text-muted-foreground">
              Address is stored against the order — never shared with other buyers.
            </span>
          </div>
        </form>

        <aside className="lg:sticky lg:top-20 rounded-2xl border border-border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b border-border bg-foreground/[0.02] flex items-center gap-2">
            <ShoppingBag className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-bold">Order summary</h2>
          </div>
          <div className="p-5 space-y-4">
            <ul className="space-y-3">
              {valid.map((i) => (
                <li key={i.id} className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex-shrink-0 overflow-hidden">
                    {i.product.images[0] && (
                      // eslint-disable-next-line @next/next/no-img-element
                      (<img src={i.product.images[0]} alt="" className="w-full h-full object-cover" />)
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold leading-tight line-clamp-2">{i.product.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">qty {i.quantity}</p>
                  </div>
                  <p className="text-sm font-bold tabular-nums">
                    {formatPrice((i.product.priceCents ?? 0) * i.quantity, currency)}
                  </p>
                </li>
              ))}
            </ul>
            <div className="space-y-1 text-sm border-t border-border pt-3">
              <Row label="Subtotal" value={formatPrice(subtotal, currency)} />
              {shipping > 0 && <Row label="Shipping" value={formatPrice(shipping, currency)} muted />}
              {tax > 0 && <Row label={`Tax (${taxPct}%)`} value={formatPrice(tax, currency)} muted />}
              <div className="pt-2 border-t border-border" />
              <Row label="Total" value={formatPrice(total, currency)} bold />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({
  label, name, type, required, defaultValue, placeholder, disabled, minLength, pattern, title, autoComplete,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  minLength?: number;
  pattern?: string;
  title?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1.5">
        {label} {required && <span className="text-red-600">*</span>}
      </span>
      <input
        type={type ?? 'text'}
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        minLength={minLength}
        pattern={pattern}
        title={title}
        autoComplete={autoComplete}
        className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary invalid:focus:border-red-500 invalid:focus:ring-red-500/20 disabled:opacity-60 disabled:cursor-not-allowed"
      />
    </label>
  );
}

function Row({ label, value, muted, bold }: { label: string; value: string; muted?: boolean; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? 'text-xs text-muted-foreground' : 'text-sm'}>{label}</span>
      <span className={`tabular-nums ${bold ? 'font-bold text-base' : muted ? 'text-xs text-muted-foreground' : 'font-semibold'}`}>{value}</span>
    </div>
  );
}
