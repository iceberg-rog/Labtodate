import { prisma } from '@/lib/db';
import { sendEmail } from '@/lib/email';
import { escapeHtml, headerText } from '@/lib/email-html';
import { logError, notifyAdmins } from '@/lib/observability';
import { getInventorySettings } from './settings';

/**
 * Low-stock alerts. Called after anything changes stock (sheet, import, bulk
 * edit, checkout, a paid quote, a cancel or refund). One alert per dip: the
 * first time an item's Available drops to its threshold an alert goes out and
 * lowStockAlertedAt is set; it is cleared once stock is above the threshold
 * again. Only Labtodate's own, non-archived listings are watched.
 *
 * Never throws: it runs after orders and payments, which must not fail
 * because an alert could not be sent.
 */
export async function checkLowStock(productIds: Array<string | null | undefined>): Promise<void> {
  const ids = [...new Set(productIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  try {
    const s = await getInventorySettings();
    const products = await prisma.product.findMany({
      where: { id: { in: ids }, companyId: null, status: { not: 'ARCHIVED' } },
      select: {
        id: true,
        title: true,
        quantity: true,
        inventory: { select: { sku: true, location: true, lowStockAt: true, lowStockAlertedAt: true } },
      },
    });
    const fresh: typeof products = [];
    for (const p of products) {
      const threshold = p.inventory?.lowStockAt ?? s.INVENTORY_LOW_STOCK_DEFAULT;
      const low = p.quantity <= threshold;
      if (!low) {
        if (p.inventory?.lowStockAlertedAt) {
          await prisma.productInventory.updateMany({ where: { productId: p.id }, data: { lowStockAlertedAt: null } });
        }
        continue;
      }
      if (p.inventory?.lowStockAlertedAt) continue;
      // Claim the alert atomically so two concurrent sales send one alert.
      let claimed = false;
      if (p.inventory) {
        const r = await prisma.productInventory.updateMany({
          where: { productId: p.id, lowStockAlertedAt: null },
          data: { lowStockAlertedAt: new Date() },
        });
        claimed = r.count === 1;
      } else {
        try {
          await prisma.productInventory.create({ data: { productId: p.id, lowStockAlertedAt: new Date() } });
          claimed = true;
        } catch {
          claimed = false; // created by a concurrent call, which sends the alert
        }
      }
      if (claimed) fresh.push(p);
    }
    if (!fresh.length) return;

    const line = (p: (typeof fresh)[number]) =>
      `${p.inventory?.sku ? `${p.inventory.sku} · ` : ''}${p.title}: ${p.quantity === 0 ? 'none available' : `${p.quantity} available`}${p.inventory?.location ? ` (location ${p.inventory.location})` : ''}`;
    const title = fresh.length === 1 ? `Low stock: ${fresh[0].title}` : `Low stock: ${fresh.length} items`;
    const body = fresh.map(line).join('\n');
    const href = fresh.length === 1 ? `/admin/inventory?focus=${fresh[0].id}` : '/admin/inventory?filter=low';

    if (s.INVENTORY_LOW_STOCK_NOTIFY) await notifyAdmins(title, body, href, 'SYSTEM');
    if (s.INVENTORY_LOW_STOCK_EMAIL && s.INVENTORY_LOW_STOCK_EMAIL_TO) {
      const base = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
      try {
        await sendEmail({
          to: s.INVENTORY_LOW_STOCK_EMAIL_TO,
          subject: headerText(title),
          html: `<p>These items reached their low-stock threshold:</p><ul>${fresh
            .map((p) => `<li>${escapeHtml(line(p))}</li>`)
            .join('')}</ul><p><a href="${base}${href}">Open the inventory</a></p>`,
        });
      } catch (e) {
        await logError('inventory.lowStockEmail', e);
      }
    }
  } catch (e) {
    await logError('inventory.checkLowStock', e).catch(() => {});
  }
}
