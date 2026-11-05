import { getGeneral, getVatSettings } from './config';
import { rateBpFor, vatCents, type VatTreatment } from '@/lib/tax/vat';

/**
 * VAT for cart / buy-now orders, where the buyer's country is not known yet:
 * the default treatment from Admin → Documents → VAT (21% NL out of the box),
 * on goods + shipping — the same base the documents use.
 */
/** Shipping on cart / buy-now orders (Admin → Documents → General). */
export async function checkoutShippingCents(): Promise<number> {
  return Math.max(0, (await getGeneral()).cartShippingCents || 0);
}

export async function checkoutVat(subtotalCents: number, shippingCents: number): Promise<{ treatment: Exclude<VatTreatment, 'REVIEW'>; rateBp: number; pct: number; taxCents: number }> {
  const s = await getVatSettings();
  const treatment = s.defaultTreatment;
  const rateBp = rateBpFor(treatment, s);
  return { treatment, rateBp, pct: rateBp / 100, taxCents: vatCents(subtotalCents + Math.max(0, shippingCents), rateBp) };
}
