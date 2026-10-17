import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingEnum, settingInt, settingIntOrNull } from '@/lib/settings';
import { quoteShipping, type ShippingLine, type ShippingQuote, type ShippingSettings, type ZoneRow } from './quote';

/** Shipping settings from the registry (Admin → Settings → Shipping). */
export async function loadShippingSettings(): Promise<ShippingSettings> {
  await ensureSettingsLoaded();
  return {
    mode: settingEnum('SHIPPING_MODE'),
    flatCents: settingInt('DEFAULT_SHIPPING_CENTS', 0),
    unmatched: settingEnum('SHIPPING_UNMATCHED_POLICY'),
    defaultClass: settingEnum('SHIPPING_DEFAULT_CLASS'),
    handlingCents: settingInt('SHIPPING_HANDLING_FEE_CENTS', 0),
    freeAboveCents: settingIntOrNull('SHIPPING_FREE_ABOVE_CENTS'),
  };
}

export async function loadShippingZones(): Promise<ZoneRow[]> {
  return prisma.shippingZone.findMany({ include: { rates: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
}

/** Quote shipping for a destination + lines with the live settings and table. */
export async function quoteShippingFor(country: string | null, lines: ShippingLine[], currency = 'EUR'): Promise<ShippingQuote> {
  const [s, zones] = await Promise.all([loadShippingSettings(), loadShippingZones()]);
  return quoteShipping({ country, lines, currency }, s, zones);
}
