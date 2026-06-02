import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ChevronLeft, Banknote, CheckCircle2, XCircle, Clock,
  AlertTriangle, Upload, FileText, Copy, Building2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { formatPrice } from '@/lib/utils';
import { ensureSettingsLoaded } from '@/lib/settings';
import { buyerSubmitPaymentProof } from './actions';

export const dynamic = 'force-dynamic';

const ERR_MSG: Record<string, string> = {
  method: 'Please pick a payment method.',
  large: 'Receipt file must be under 8 MB.',
  type: 'Receipt must be a JPG / PNG / WEBP / GIF or PDF.',
  proofreq: 'A receipt file is required for bank transfers.',
  closed: 'This order is no longer accepting payment proof.',
};

export default async function PaymentWorkspacePage({
  params,
  searchParams,
}: {
  params: { orderNumber: string };
  searchParams: { ok?: string; err?: string };
}) {
  const session = await requireSession({ redirectTo: `/app/orders/${params.orderNumber}/payment` });
  await ensureSettingsLoaded();

  const order = await prisma.order.findUnique({
    where: { orderNumber: params.orderNumber },
    include: {
      items: { select: { titleSnapshot: true, quantity: true, priceCentsSnapshot: true } },
    },
  });
  if (!order || order.buyerId !== session.user.id) notFound();

  // Check the originating proforma's expiry. If it expired (cron flips the
  // SR to CLOSED + this Order to CANCELED), the buyer must NOT see the upload
  // form — show an "expired" state with a path back to the quote thread to
  // request re-issuance instead.
  const sourcing = order.sourcingRequestId
    ? await prisma.sourcingRequest.findUnique({
        where: { id: order.sourcingRequestId },
        select: { id: true, status: true, validUntilAt: true, proformaNumber: true },
      })
    : null;
  const isProformaExpired =
    !!sourcing?.validUntilAt &&
    sourcing.validUntilAt.getTime() < Date.now() &&
    (sourcing.status === 'CLOSED' || order.status === 'CANCELED');

  const ship = order.shippingAddress as
    | { name?: string; phone?: string; company?: string; vat?: string; address?: Record<string, string> }
    | null;
  const seed = {
    name: ship?.name ?? session.user.name ?? '',
    phone: ship?.phone ?? '',
    company: ship?.company ?? '',
    vat: ship?.vat ?? '',
    line1: String(ship?.address?.line1 ?? ''),
    line2: String(ship?.address?.line2 ?? ''),
    city: String(ship?.address?.city ?? ''),
    postal: String(ship?.address?.postal_code ?? ''),
    state: String(ship?.address?.state ?? ''),
    country: String(ship?.address?.country ?? ''),
  };

  const verState = order.paymentVerificationStatus; // AWAITING_VERIFICATION | VERIFIED | REJECTED | null
  // Expired proformas: hard-block the upload path. Buyer can still see the
  // page (and the bank/totals for reference) but cannot submit a receipt.
  const canSubmit =
    !isProformaExpired &&
    order.status === 'PENDING_PAYMENT' &&
    verState !== 'AWAITING_VERIFICATION';
  const ok = searchParams.ok === '1';
  const err = searchParams.err && ERR_MSG[searchParams.err];

  const bank = {
    name: process.env.BANK_NAME || '',
    iban: process.env.BANK_IBAN || '',
    swift: process.env.BANK_SWIFT || '',
    refHint: process.env.BANK_REFERENCE_HINT || 'Use your order number as reference',
    company: process.env.COMPANY_LEGAL_NAME || process.env.SITE_NAME || '',
  };

  return (
    <div className="container-px py-10 max-w-3xl mx-auto">
      <Link
        href={`/app/orders/${order.orderNumber}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-6"
      >
        <ChevronLeft className="h-4 w-4" /> Back to order
      </Link>

      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Complete your purchase</h1>
        <p className="text-muted-foreground mt-1">
          Order <span className="font-mono font-semibold">{order.orderNumber}</span> ·{' '}
          <span className="font-semibold">{formatPrice(order.totalCents, order.currency)}</span>
        </p>
      </div>

      {/* === 4-step roadmap so the buyer knows what's expected =========== */}
      {canSubmit && (
        <div className="mb-6 rounded-2xl border border-border bg-card p-4">
          <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-3">
            What happens next
          </p>
          <ol className="grid sm:grid-cols-4 gap-3 text-[12px]">
            <li className="flex items-start gap-2">
              <span className="shrink-0 h-5 w-5 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center text-[10px] font-bold">1</span>
              <span><strong>Confirm shipping &amp; billing</strong> below.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="shrink-0 h-5 w-5 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center text-[10px] font-bold">2</span>
              <span><strong>Pay</strong> via bank transfer using the reference shown.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="shrink-0 h-5 w-5 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center text-[10px] font-bold">3</span>
              <span><strong>Upload receipt</strong> (and PO if applicable).</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="shrink-0 h-5 w-5 rounded-full bg-primary text-primary-foreground inline-flex items-center justify-center text-[10px] font-bold">4</span>
              <span>We <strong>verify</strong> within 1 business day &amp; ship.</span>
            </li>
          </ol>
        </div>
      )}

      {/* === Expired proforma banner =================================== */}
      {isProformaExpired && (
        <div className="rounded-2xl border border-red-300 bg-red-50 p-4 mb-6 flex items-start gap-3">
          <XCircle className="h-5 w-5 text-red-700 mt-0.5" />
          <div className="text-sm flex-1">
            <p className="font-bold text-red-900">This proforma has expired.</p>
            <p className="text-red-800 mt-1">
              Your proforma was valid until{' '}
              <strong>{sourcing?.validUntilAt?.toLocaleDateString('en-US', { dateStyle: 'long' })}</strong>.
              The order was automatically cancelled. To proceed, ask us to re-issue with
              up-to-date pricing — reply on the original quote thread.
            </p>
            {sourcing && (
              <Link
                href={`/app/quotes/${sourcing.id}`}
                className="inline-flex items-center gap-1.5 mt-3 h-9 px-4 rounded-full border border-red-300 bg-white text-red-900 text-xs font-bold hover:bg-red-100"
              >
                Open quote thread
              </Link>
            )}
          </div>
        </div>
      )}

      {/* === Status banners ============================================ */}
      {verState === 'AWAITING_VERIFICATION' && (
        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 mb-6 flex items-start gap-3">
          <Clock className="h-5 w-5 text-sky-700 mt-0.5" />
          <div className="text-sm">
            <p className="font-bold text-sky-900">Your receipt is being reviewed.</p>
            <p className="text-sky-800 mt-1">
              We'll email you within 1 business day. You'll be able to upload a corrected receipt
              if anything needs attention.
            </p>
          </div>
        </div>
      )}

      {verState === 'VERIFIED' && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 mb-6 flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-700 mt-0.5" />
          <div className="text-sm">
            <p className="font-bold text-emerald-900">Payment verified.</p>
            <p className="text-emerald-800 mt-1">
              Your order is being prepared for shipping. <Link href={`/app/orders/${order.orderNumber}`} className="underline font-semibold">Track it</Link>.
            </p>
          </div>
        </div>
      )}

      {verState === 'REJECTED' && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 mb-6 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-700 mt-0.5" />
          <div className="text-sm flex-1">
            <p className="font-bold text-amber-900">Your receipt needs attention.</p>
            <p className="text-amber-800 mt-1">
              {order.paymentRejectionReason || 'Please upload a corrected receipt below.'}
            </p>
          </div>
        </div>
      )}

      {ok && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 mb-6 text-sm text-emerald-900 inline-flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" /> Receipt uploaded — we'll verify within 1 business day.
        </div>
      )}
      {err && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3 mb-6 text-sm text-red-900 inline-flex items-center gap-2">
          <XCircle className="h-4 w-4" /> {err}
        </div>
      )}

      {/* === Payment instructions ====================================== */}
      <section className="rounded-2xl border border-border bg-card p-6 space-y-4 mb-6">
        <div className="flex items-center gap-2">
          <Banknote className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-bold">Bank transfer instructions</h2>
        </div>
        {bank.iban ? (
          <dl className="grid sm:grid-cols-[160px_1fr] gap-x-4 gap-y-2 text-sm">
            {bank.company && (
              <>
                <dt className="text-muted-foreground">Beneficiary</dt>
                <dd className="font-semibold">{bank.company}</dd>
              </>
            )}
            {bank.name && (
              <>
                <dt className="text-muted-foreground">Bank</dt>
                <dd className="font-semibold">{bank.name}</dd>
              </>
            )}
            <dt className="text-muted-foreground">IBAN</dt>
            <dd className="font-mono font-semibold inline-flex items-center gap-2 select-all">
              {bank.iban}
            </dd>
            {bank.swift && (
              <>
                <dt className="text-muted-foreground">SWIFT / BIC</dt>
                <dd className="font-mono font-semibold select-all">{bank.swift}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Reference</dt>
            <dd className="font-mono font-semibold select-all">{order.orderNumber}</dd>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="font-bold">{formatPrice(order.totalCents, order.currency)}</dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            Bank details haven't been configured yet. Please contact support — we'll send transfer
            instructions by email.
          </p>
        )}
        <p className="text-xs text-muted-foreground border-t border-border pt-3">
          {bank.refHint}. Once your transfer is sent, upload the bank confirmation below and we'll
          verify within 1 business day.
        </p>
      </section>

      {/* === Submit form ============================================== */}
      {canSubmit && (
        <form action={buyerSubmitPaymentProof} encType="multipart/form-data" className="space-y-6">
          <input type="hidden" name="orderNumber" value={order.orderNumber} />

          <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-lg font-bold inline-flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" /> Upload your receipt
            </h2>

            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">How did you pay?</span>
              <select
                name="method"
                defaultValue="BANK_TRANSFER"
                required
                className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
              >
                <option value="BANK_TRANSFER">Bank transfer (SEPA / wire)</option>
                <option value="INVOICE">Invoice (NET-30 / company account)</option>
                <option value="OTHER">Other</option>
              </select>
            </label>

            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">
                Receipt / proof <span className="text-muted-foreground font-normal">(JPG / PNG / WEBP / PDF, max 8 MB)</span>
              </span>
              <div className="rounded-lg border border-dashed border-border p-4 text-center">
                <input
                  type="file"
                  name="proof"
                  accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                  className="block mx-auto text-sm"
                />
                <p className="text-xs text-muted-foreground mt-2">
                  <Upload className="h-3 w-3 inline" /> A bank transfer confirmation, PO, or invoice.
                </p>
              </div>
            </label>

            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">
                  PO number <span className="text-muted-foreground font-normal">(optional)</span>
                </span>
                <input
                  name="po_number"
                  maxLength={60}
                  placeholder="e.g. PO-2026-00471"
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
                />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold mb-1.5">
                  Bank transfer reference <span className="text-muted-foreground font-normal">(optional)</span>
                </span>
                <input
                  name="bank_ref"
                  maxLength={60}
                  placeholder="e.g. SWIFT reference shown on your bank statement"
                  className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
                />
              </label>
            </div>

            <label className="block">
              <span className="block text-sm font-semibold mb-1.5">
                Note to support <span className="text-muted-foreground font-normal">(optional)</span>
              </span>
              <textarea
                name="note"
                rows={3}
                maxLength={500}
                placeholder="Anything we should know — split payment, accounts-payable contact, customs notes, etc."
                className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm"
              />
            </label>
          </section>

          <section className="rounded-2xl border border-border bg-card p-6 space-y-4">
            <h2 className="text-lg font-bold inline-flex items-center gap-2">
              <Building2 className="h-5 w-5 text-primary" /> Shipping & billing info
            </h2>
            <p className="text-xs text-muted-foreground -mt-2">
              Only filled-in fields are updated; leave blank to keep what's on file.
            </p>

            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Recipient name" name="addr_name" defaultValue={seed.name} />
              <Field label="Phone" name="addr_phone" defaultValue={seed.phone} />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Company (optional)" name="addr_company" defaultValue={seed.company} />
              <Field label="VAT / reg. number (optional)" name="addr_vat" defaultValue={seed.vat} />
            </div>
            <Field label="Address line 1" name="addr_line1" defaultValue={seed.line1} />
            <Field label="Address line 2 (optional)" name="addr_line2" defaultValue={seed.line2} />
            <div className="grid sm:grid-cols-[1fr_1fr_120px] gap-3">
              <Field label="City" name="addr_city" defaultValue={seed.city} />
              <Field label="Postal code" name="addr_postal" defaultValue={seed.postal} />
              <Field label="Country (2-letter)" name="addr_country" defaultValue={seed.country} maxLength={2} placeholder="NL" />
            </div>
          </section>

          <div className="flex items-center gap-3 flex-wrap">
            <Button type="submit" size="lg" className="rounded-2xl font-semibold">
              <Upload className="h-4 w-4" />
              {verState === 'REJECTED' ? 'Resubmit receipt' : 'Submit receipt for verification'}
            </Button>
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <Clock className="h-3 w-3" /> Typical verification: 1 business day.
            </span>
          </div>
        </form>
      )}

      {/* === Order summary footer ====================================== */}
      <section className="rounded-2xl border border-border bg-card p-5 mt-8">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-3">Items</p>
        <ul className="divide-y divide-border">
          {order.items.map((it, i) => (
            <li key={i} className="flex items-center justify-between py-2 text-sm">
              <span>{it.titleSnapshot} × {it.quantity}</span>
              <span className="font-semibold tabular-nums">
                {formatPrice(it.priceCentsSnapshot * it.quantity, order.currency)}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-border pt-3 mt-3 text-base font-bold">
          <span>Total</span>
          <span className="tabular-nums">{formatPrice(order.totalCents, order.currency)}</span>
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
  maxLength,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-semibold mb-1.5">{label}</span>
      <input
        name={name}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        maxLength={maxLength}
        className="w-full h-10 px-3 rounded-lg border border-input bg-background text-sm"
      />
    </label>
  );
}
