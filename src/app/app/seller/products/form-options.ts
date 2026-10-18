import { prisma } from '@/lib/db';
import { getCatalogPolicy, getConditionGrades } from '@/lib/catalog/policy';
import { offerCurrencies } from '@/lib/quotes/policy';
import { ensureSettingsLoaded, settingBool, settingEnum } from '@/lib/settings';
import type { SellerFormOptions } from '@/components/seller/ProductForm';

/**
 * What the seller listing form offers, from the admin settings: the
 * currencies staff quote in (Quotes & offers), the default shipping class
 * (Shipping), the warranty and inspection rules (Catalog & claims) and whether
 * the margin scheme is on (Tax & VAT).
 */
export async function sellerFormOptions(currentCurrency?: string): Promise<SellerFormOptions> {
  await ensureSettingsLoaded();
  const [categories, brands, policy, grades] = await Promise.all([
    prisma.category.findMany({ orderBy: { sortOrder: 'asc' }, select: { id: true, name: true, slug: true } }),
    prisma.brand.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } }),
    getCatalogPolicy(),
    getConditionGrades(),
  ]);
  const currencies = offerCurrencies();
  if (currentCurrency && !currencies.includes(currentCurrency)) currencies.push(currentCurrency);
  return {
    categories,
    brands,
    currencies,
    defaultShippingClass: settingEnum<'PARCEL' | 'PALLET' | 'FREIGHT_QUOTE'>('SHIPPING_DEFAULT_CLASS'),
    warrantyFallbackText: policy.warrantyFallbackText,
    warrantyMonthsFormat: policy.warrantyMonthsFormat,
    inspectionRequiresReport: policy.inspectionRequiresReport,
    marginSchemeEnabled: settingBool('TAX_MARGIN_SCHEME_ENABLED'),
    grades: Object.fromEntries(
      Object.values(grades).map((g) => [g.code, { label: g.label, defaultWarrantyMonths: g.defaultWarrantyMonths, warrantyScope: g.warrantyScope }]),
    ),
  };
}
