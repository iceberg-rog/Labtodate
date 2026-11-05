import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { getGeneral } from '@/lib/documents/config';
import { documentFileName, documentPdf, ensureInvoice, ensureReceipt, snapshotOf } from '@/lib/documents/issue';
import { fmtDate, fmtMoney } from '@/lib/documents/vars';
import { sendTemplatedEmail } from '@/lib/email-templates/send';
import { logError } from '@/lib/observability';
import { generateOrderNumber, loadOrderNumberPattern } from '@/lib/orders/checkout-tx';

/**
 * Server-internal order helpers. Deliberately NOT a 'use server' module: every
 * export of a 'use server' file becomes a callable Server Action endpoint, and
 * none of these check a session — they take an arbitrary order id (or a raw
 * Prisma create input) from trusted server code only. Import them from server
 * actions / route handlers; never from a client component.
 */

function siteBase(): string {
  return (process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
}

/**
 * A PAID order: issue its invoice (and receipt, when switched on in
 * Admin → Documents → General) and send ONE "payment received" e-mail with
 * the PDFs attached, plus the billing copy. Idempotent: the documents are
 * issued once; calling again re-sends the same documents. Failures never
 * block the order — they are logged.
 */
export async function sendOrderInvoice(orderId: string, actorId?: string | null): Promise<void> {
  try {
    await ensureSettingsLoaded();
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { buyer: { select: { name: true, email: true } } },
    });
    if (!order) return;
    const general = await getGeneral();
    const invoice = await ensureInvoice(orderId, actorId);
    if (!invoice) return;
    const receipt = general.receiptEnabled ? await ensureReceipt(orderId, actorId).catch(async (e) => {
      await logError('sendOrderInvoice.receipt', e);
      return null;
    }) : null;
    const docs = [general.attachInvoice ? invoice : null, receipt].filter((d): d is NonNullable<typeof d> => !!d);
    const attachments = [];
    for (const d of docs) {
      try {
        attachments.push({ filename: documentFileName(snapshotOf(d)), content: await documentPdf(d), contentType: 'application/pdf' });
      } catch (e) {
        await logError(`sendOrderInvoice.pdf.${d.kind.toLowerCase()}`, e);
      }
    }
    const snap = snapshotOf(invoice);
    const total = fmtMoney(order.totalCents, order.currency, snap.lang);
    await sendTemplatedEmail({
      key: 'payment_received',
      to: order.buyer.email,
      lang: snap.lang,
      vars: {
        'customer.name': snap.customer.name || order.buyer.name,
        'order.number': order.orderNumber,
        'invoice.number': invoice.number,
        'order.total': total,
        'payment.date': fmtDate(order.paidAt ?? new Date(), snap.lang),
        'link.order': `${siteBase()}/app/orders/${order.orderNumber}`,
      },
      attachments,
    });
    const billing = (process.env.COMPANY_EMAIL || '').trim();
    if (billing && general.billingCopy) {
      for (const [i, d] of docs.entries()) {
        const att = attachments[i];
        if (!att) continue;
        const ds = snapshotOf(d);
        await sendTemplatedEmail({
          key: 'document_copy',
          to: billing,
          lang: 'en',
          vars: {
            'document.title': ds.texts.title,
            'document.number': d.number,
            'document.customer': ds.customer.company || ds.customer.name,
            'document.total': fmtMoney(ds.totalCents, ds.currency, ds.lang),
          },
          attachments: [att],
        }).catch((e) => logError('sendOrderInvoice.billing_copy', e));
      }
    }
  } catch (e) {
    console.error('sendOrderInvoice failed', e);
    await logError('sendOrderInvoice', e);
  }
}

/**
 * Honest "we received your order" email for the no-online-payment path.
 * No invoice is issued because nothing has been paid yet — the team
 * follows up with a secure payment link. Never blocks the order.
 */
export async function sendOrderReceived(orderId: string): Promise<void> {
  try {
    await ensureSettingsLoaded();
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { buyer: { select: { name: true, email: true } }, items: true },
    });
    if (!order) return;
    const base = siteBase();
    // Direct links so the buyer can reach the payment workspace (bank details +
    // receipt upload) and ops can open the order without searching for it.
    await sendTemplatedEmail({
      key: 'order_received',
      to: order.buyer.email,
      vars: {
        'customer.name': order.buyer.name,
        'order.number': order.orderNumber,
        'order.items': order.items.map((i) => `${i.titleSnapshot} × ${i.quantity}`).join('\n'),
        'link.payment': `${base}/app/orders/${order.orderNumber}/payment`,
        'link.order': `${base}/app/orders/${order.orderNumber}`,
      },
    });
    const ops = process.env.SUPPORT_INTAKE_EMAIL || process.env.COMPANY_EMAIL;
    if (ops) {
      await sendTemplatedEmail({
        key: 'staff_order_received',
        to: ops,
        lang: 'en',
        vars: {
          'order.number': order.orderNumber,
          'buyer.name': order.buyer.name,
          'buyer.email': order.buyer.email,
          'link.admin': `${base}/admin/orders/${order.id}`,
        },
      });
    }
  } catch (e) {
    console.error('sendOrderReceived failed', e);
    await logError('sendOrderReceived', e);
  }
}

/**
 * Create a standalone order (no stock reservation — used by the quote/proforma
 * path), regenerating the order number on the (rare) unique collision instead of
 * throwing an unhandled 500. Each attempt is its own implicit transaction, so a
 * P2002 on one create never poisons the next. Reserving checkout paths use
 * reserveAndCreateOrder (transactional) instead.
 */
export async function createOrderWithUniqueNumber(
  data: Omit<Prisma.OrderUncheckedCreateInput, 'orderNumber'>,
) {
  await loadOrderNumberPattern();
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await prisma.order.create({
        data: { ...data, orderNumber: generateOrderNumber() },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        attempt < 5
      ) {
        continue;
      }
      throw e;
    }
  }
  throw new Error('Could not allocate an order number');
}
