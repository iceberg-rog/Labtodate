import { notFound } from 'next/navigation';
import { Clock, AlertTriangle, Banknote } from 'lucide-react';
import { requireSession } from '@/lib/auth-server';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { renderInvoiceHtml } from '@/lib/invoice';
import { PrintButton } from '@/components/util/PrintButton';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Proforma invoice' };

export default async function ProformaPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await requireSession({ redirectTo: `/app/quotes/${params.id}/proforma` });
  await ensureSettingsLoaded();

  const sr = await prisma.sourcingRequest.findUnique({
    where: { id: params.id },
    include: { product: { select: { title: true } } },
  });
  if (!sr || sr.quotedPriceCents == null) notFound();

  const role = (session.user as { role?: string }).role;
  const allowed =
    sr.submittedById === session.user.id ||
    sr.buyerEmail === session.user.email ||
    role === 'ADMIN' ||
    sr.assignedToId === session.user.id;
  if (!allowed) notFound();

  // Persisted number is the authoritative reference; only fall back when an
  // older quote was issued before slice B (legacy fallback keeps old proformas
  // accessible — they don't get a unique persisted number).
  const number = sr.proformaNumber ?? `PRO-${new Date((sr.quotedAt ?? sr.createdAt)).getFullYear()}-${sr.id.slice(-6).toUpperCase()}`;
  const issuedAt = sr.proformaIssuedAt ?? sr.quotedAt ?? sr.createdAt;
  const validUntil = sr.validUntilAt;
  const isExpired = !!validUntil && validUntil.getTime() < Date.now();

  const { html } = renderInvoiceHtml({
    kind: 'PROFORMA',
    number,
    dateISO: issuedAt.toISOString(),
    currency: sr.quotedCurrency || 'EUR',
    buyer: { name: sr.buyerName, email: sr.buyerEmail, company: sr.companyName },
    lines: [
      {
        title: sr.product?.title ?? sr.productCategory ?? 'Requested equipment',
        qty: 1,
        unitCents: sr.quotedPriceCents,
      },
    ],
    status: validUntil ? `Valid until ${validUntil.toISOString().slice(0, 10)}` : 'Awaiting acceptance',
    note: sr.quotedNote ?? null,
  });

  return (
    <div className="container-px py-10 max-w-3xl mx-auto">
      {/* === Status header (proforma number + expiry banner) === */}
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4 print:hidden">
        <div>
          <p className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">Proforma invoice</p>
          <h1 className="text-2xl font-bold font-mono mt-0.5">{number}</h1>
          <p className="text-xs text-muted-foreground mt-1">Issued {issuedAt.toISOString().slice(0, 10)}</p>
        </div>
        <PrintButton />
      </div>
      {validUntil && (
        <div
          className={`rounded-2xl border p-3 mb-5 inline-flex items-start gap-2 text-sm print:hidden ${
            isExpired
              ? 'border-red-200 bg-red-50 text-red-900'
              : 'border-emerald-200 bg-emerald-50 text-emerald-900'
          }`}
        >
          {isExpired ? <AlertTriangle className="h-4 w-4 mt-0.5" /> : <Clock className="h-4 w-4 mt-0.5" />}
          <div>
            <p className="font-bold">
              {isExpired
                ? `Expired ${validUntil.toISOString().slice(0, 10)}`
                : `Valid until ${validUntil.toISOString().slice(0, 10)}`}
            </p>
            {isExpired && (
              <p className="text-xs mt-1">Contact us to re-confirm the price before paying.</p>
            )}
          </div>
        </div>
      )}

      {/* === Proforma document === */}
      <div className="rounded-2xl border border-border bg-white p-8 print:border-0 print:p-0">
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>

      {/* === Payment instructions block (snapshot at issuance time) === */}
      {sr.paymentInstructionsSnapshot && (
        <section className="rounded-2xl border border-border bg-card p-5 mt-6 print:hidden">
          <h2 className="text-sm font-bold uppercase tracking-wider text-primary inline-flex items-center gap-2 mb-3">
            <Banknote className="h-4 w-4" /> Payment instructions
          </h2>
          <pre className="text-xs font-mono whitespace-pre-wrap bg-foreground/[0.03] border border-border rounded-lg p-3">
{sr.paymentInstructionsSnapshot}
          </pre>
          <p className="text-[11px] text-muted-foreground mt-3">
            These details were captured when the quote was issued. They stay attached to this proforma
            even if our banking details change later.
          </p>
        </section>
      )}
    </div>
  );
}
