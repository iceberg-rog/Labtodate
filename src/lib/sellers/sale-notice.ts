import { prisma } from '@/lib/db';
import { legalIdentity, siteName } from '@/lib/brand/identity';
import { isDeliverableEmail, trySendEmail } from '@/lib/email';
import { escapeHtml } from '@/lib/email-html';
import { logError, notifyAdmins, notifyUser } from '@/lib/observability';
import { mailLayout, mailTable, siteBase } from '@/lib/quotes/mail';
import { ensureSettingsLoaded, settingString } from '@/lib/settings';
import { programmeBlocksHtml, programmeBlocksText, sellerProgramme } from './programme';
import { SALE_ORDER_SELECT, saleNoticeApplies, saleNoticeContent, supplierLinesOf, type SaleNoticeEvent } from './supplier-sales';

export type { SaleNoticeEvent } from './supplier-sales';

/**
 * Tells the supplier who owns a sold unit what happened to the sale (D06):
 *   PAID       “Unit sold — prepare it for dispatch” with the agreed supplier
 *              price and what to do next (Settings → Suppliers → Sold-unit notice)
 *   SHIPPED    the supplier's units left for the buyer
 *   DELIVERED  they arrived, with how the supplier is paid (Settings → Suppliers)
 *   CANCELED   the sale was canceled after the supplier was told to prepare it
 * In-app notification plus a branded e-mail. Never the buyer's name, address
 * or our sell price. Each notice goes once per order, supplier and stage
 * (ReminderLog), so a retried or repeated call sends nothing new. A supplier
 * without a deliverable e-mail address (imported shops) gets the in-app notice
 * and staff are asked to tell it about the sale themselves.
 *
 * Callers invoke it after the order change is committed: payment verified or
 * marked paid (PKG-04), shipped / delivered (PKG-10), canceled or refunded. It
 * never throws into them.
 */
export async function notifySupplierOfSale(orderId: string, event: SaleNoticeEvent): Promise<void> {
  try {
    await ensureSettingsLoaded();
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: SALE_ORDER_SELECT });
    if (!order) return;
    const groups = supplierLinesOf(order);
    if (!groups.size) return;
    const suppliers = await prisma.user.findMany({
      where: { id: { in: [...groups.keys()] }, role: 'SELLER' },
      select: { id: true, email: true, name: true },
    });
    const site = siteName();
    for (const s of suppliers) {
      const lines = groups.get(s.id) ?? [];
      if (!saleNoticeApplies(event, order, lines)) continue;
      // A cancellation only matters to a supplier that was told to prepare the unit.
      if (event === 'CANCELED' && !(await noticeSent(order.id, s.id, 'PAID'))) continue;
      if (!(await claim(order.id, s.id, event))) continue;

      const c = saleNoticeContent(event, order.orderNumber, lines, { dispatchText: settingString('SELLER_DISPATCH_TEXT') });
      const href = lines[0]?.quoteId ? `/app/seller/inbox/${lines[0].quoteId}` : '/app/seller/payouts';
      await notifyUser(s.id, c.title, c.body, href);

      if (!isDeliverableEmail(s.email)) {
        if (event === 'PAID') {
          await notifyAdmins(
            `Tell the supplier: unit sold — order ${order.orderNumber}`,
            `${s.name || 'The supplier'} has no e-mail address we can write to. Contact them to prepare “${lines[0]?.title ?? 'the unit'}” for dispatch.`,
            `/admin/orders/${order.id}`,
          );
        }
        continue;
      }
      const programme = event === 'DELIVERED' ? sellerProgramme() : null;
      const contactHref = programme ? (programme.contactHref.startsWith('/') ? `${siteBase()}${programme.contactHref}` : programme.contactHref) : '';
      const payoutHtml = programme ? programmeBlocksHtml(programme.payout, contactHref, programme.contactLabel) : [];
      const contact = legalIdentity().supportEmail;
      const html = mailLayout({
        heading: c.heading,
        body: [
          `Hi <span dir="auto">${escapeHtml(s.name || 'there')}</span>,`,
          escapeHtml(c.lead),
          mailTable(c.rows.map(([label, value, strong]) => [escapeHtml(label), escapeHtml(value), strong])),
          ...(c.next ? [escapeHtml(c.next)] : []),
          ...(payoutHtml.length ? ['<p style="margin:14px 0 6px;font-weight:700;">How you are paid</p>', ...payoutHtml] : []),
        ],
        cta: { href: `${siteBase()}${href}`, label: lines[0]?.quoteId ? 'Open the deal' : 'Open your sales' },
        footer: [
          `You receive this because you supply this unit through ${escapeHtml(site)}.${contact ? ` Questions: <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>.` : ''}`,
        ],
      });
      const text = [
        c.lead,
        ...c.rows.map(([label, value]) => `${label}: ${value}`),
        c.next ?? '',
        programme ? `How you are paid:\n${programmeBlocksText(programme.payout, programme.contactLabel)}` : '',
      ].filter(Boolean).join('\n\n');
      const mail = await trySendEmail({ to: s.email, subject: c.subject, html, text }, 'sellers:sale-notice');
      await prisma.reminderLog
        .updateMany({ where: claimWhere(order.id, s.id, event), data: { emailOk: mail.ok } })
        .catch(() => {});
    }
  } catch (e) {
    await logError('sellers:sale-notice', e);
  }
}

// One row per order, supplier and stage: the unique key of ReminderLog makes
// the claim atomic, so two concurrent calls never both send.
function claimWhere(orderId: string, supplierId: string, event: SaleNoticeEvent) {
  return { subjectType: 'ORDER_SUPPLIER', subjectId: `${orderId}:${supplierId}`, kind: `SUPPLIER_SALE_${event}`, step: 0 };
}

async function claim(orderId: string, supplierId: string, event: SaleNoticeEvent): Promise<boolean> {
  const r = await prisma.reminderLog.createMany({ data: [claimWhere(orderId, supplierId, event)], skipDuplicates: true });
  return r.count === 1;
}

async function noticeSent(orderId: string, supplierId: string, event: SaleNoticeEvent): Promise<boolean> {
  return (await prisma.reminderLog.count({ where: claimWhere(orderId, supplierId, event) })) > 0;
}
