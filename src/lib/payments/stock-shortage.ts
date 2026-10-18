import { settingText } from '@/lib/finance/texts';
import { fmtDocMoney } from '@/lib/documents/render';
import { fmtValueDay, STOCK_SHORTAGE_HOLD } from './rules';

/**
 * Paid, but the unit is gone (STOCK_SHORTAGE hold): what the buyer is told —
 * in the e-mail, on the payment page and on the order page — is ONE text,
 * Settings → Email texts → EMAIL_PAYMENT_STOCK_CHECK_TEXT. Call after
 * ensureSettingsLoaded().
 */
export function stockShortageText(o: { orderNumber: string; currency: string; amountCents: number; valueDate: Date | null }): { text: string; html: string } {
  return settingText(
    'EMAIL_PAYMENT_STOCK_CHECK_TEXT',
    { AMOUNT: fmtDocMoney(o.amountCents, o.currency), ORDER: o.orderNumber, DATE: o.valueDate ? fmtValueDay(o.valueDate) : 'not recorded' },
    ['AMOUNT', 'ORDER'],
  );
}

/** The order is on the stock-shortage hold. */
export function onStockShortage(o: { openHolds: readonly string[]; holdReason: string | null }): boolean {
  return o.holdReason === STOCK_SHORTAGE_HOLD || o.openHolds.includes(STOCK_SHORTAGE_HOLD);
}
