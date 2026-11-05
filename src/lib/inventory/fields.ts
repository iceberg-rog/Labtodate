/**
 * The inventory columns, shared by the sheet, the Excel/CSV export and the
 * import so the three can never disagree about names, order or meaning.
 * Client-safe: no server imports.
 */

export type EditableField =
  | 'sku'
  | 'mpn'
  | 'title'
  | 'brand'
  | 'category'
  | 'condition'
  | 'supplier'
  | 'costCents'
  | 'onHand'
  | 'priceCents'
  | 'location'
  | 'notes'
  | 'lowStockAt'
  | 'status'
  | 'mode';

export type ReadOnlyField = 'id' | 'reserved' | 'available' | 'margin' | 'marginPct' | 'link';
export type ColumnKey = EditableField | ReadOnlyField;

export type ColumnKind = 'text' | 'longtext' | 'money' | 'int' | 'enum' | 'ref' | 'readonly';

export type ColumnDef = {
  key: ColumnKey;
  header: string; // Excel / CSV header and sheet title
  kind: ColumnKind;
  editable: boolean;
  /** Needs the inventory:cost capability to see or change. */
  cost?: boolean;
  /** Shown to buyers on the site (the language rule "public" applies here). */
  public?: boolean;
  /** Can be emptied. */
  clearable?: boolean;
  /** Width in the sheet (px) and in Excel (characters). */
  width: number;
  xlsxWidth: number;
  /** Other header spellings the import recognises (compared lower-case, letters/digits only). */
  aliases: string[];
  hint?: string;
};

export const CONDITION_OPTIONS = [
  { value: 'NEW', label: 'New' },
  { value: 'REFURBISHED', label: 'Refurbished' },
  { value: 'USED', label: 'Used' },
] as const;

export const MODE_OPTIONS = [
  { value: 'QUOTE_ONLY', label: 'Quote only' },
  { value: 'BUY_NOW', label: 'Buy now' },
  { value: 'HYBRID', label: 'Buy now + quote' },
] as const;

export const STATUS_OPTIONS = [
  { value: 'PUBLISHED', label: 'On site' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_REVIEW', label: 'Pending review' },
  { value: 'ARCHIVED', label: 'Archived' },
] as const;

export const COLUMNS: ColumnDef[] = [
  { key: 'id', header: 'ID', kind: 'readonly', editable: false, width: 0, xlsxWidth: 28, aliases: ['id', 'rowid', 'productid', 'listingid', 'itemid'], hint: 'Do not change: matches the row to the item.' },
  { key: 'sku', header: 'SKU', kind: 'text', editable: true, clearable: true, width: 108, xlsxWidth: 13, aliases: ['sku', 'internalsku', 'itemcode', 'code', 'stockcode'] },
  { key: 'title', header: 'Name', kind: 'text', editable: true, public: true, width: 300, xlsxWidth: 48, aliases: ['name', 'title', 'productname', 'partname', 'itemname', 'product', 'item'] },
  { key: 'mpn', header: 'Part number', kind: 'text', editable: true, clearable: true, width: 140, xlsxWidth: 18, aliases: ['partnumber', 'mpn', 'pn', 'partno', 'partnr', 'manufacturerpartnumber', 'artnr'] },
  { key: 'brand', header: 'Brand', kind: 'ref', editable: true, public: true, clearable: true, width: 120, xlsxWidth: 16, aliases: ['brand', 'manufacturer', 'make', 'maker'] },
  { key: 'category', header: 'Category', kind: 'ref', editable: true, public: true, width: 170, xlsxWidth: 26, aliases: ['category', 'categoryname'] },
  { key: 'condition', header: 'Condition', kind: 'enum', editable: true, public: true, width: 108, xlsxWidth: 13, aliases: ['condition', 'state'] },
  { key: 'supplier', header: 'Supplier', kind: 'ref', editable: true, clearable: true, width: 150, xlsxWidth: 22, aliases: ['supplier', 'vendor', 'boughtfrom', 'purchasedfrom', 'suppliername'] },
  { key: 'costCents', header: 'Purchase cost', kind: 'money', editable: true, cost: true, clearable: true, width: 112, xlsxWidth: 14, aliases: ['purchasecost', 'cost', 'costprice', 'supplierprice', 'supplierpricing', 'buyprice', 'purchaseprice', 'costeur', 'purchasecosteur', 'costpereach'] },
  { key: 'onHand', header: 'On hand', kind: 'int', editable: true, width: 84, xlsxWidth: 10, aliases: ['onhand', 'quantity', 'qty', 'stock', 'instock', 'count', 'units', 'quantityonhand', 'howmany'] },
  { key: 'reserved', header: 'Reserved', kind: 'readonly', editable: false, width: 84, xlsxWidth: 10, aliases: ['reserved'], hint: 'In orders not shipped yet. Calculated; ignored on import.' },
  { key: 'available', header: 'Available', kind: 'readonly', editable: false, width: 88, xlsxWidth: 10, aliases: ['available', 'availableonsite', 'forsale'], hint: 'On hand minus reserved: what the site sells. Calculated; ignored on import.' },
  { key: 'priceCents', header: 'Selling price', kind: 'money', editable: true, clearable: true, public: true, width: 112, xlsxWidth: 14, aliases: ['sellingprice', 'price', 'priceeur', 'sellprice', 'saleprice', 'listprice', 'sellingpriceeur', 'mustsellfor'] },
  { key: 'margin', header: 'Margin', kind: 'readonly', editable: false, cost: true, width: 100, xlsxWidth: 12, aliases: ['margin', 'margineur', 'profit'], hint: 'Selling price minus purchase cost. Calculated; ignored on import.' },
  { key: 'marginPct', header: 'Margin %', kind: 'readonly', editable: false, cost: true, width: 84, xlsxWidth: 10, aliases: ['marginpct', 'marginpercent', 'margin%'], hint: 'Calculated; ignored on import.' },
  { key: 'location', header: 'Location', kind: 'text', editable: true, clearable: true, width: 110, xlsxWidth: 14, aliases: ['location', 'warehouselocation', 'shelf', 'bin', 'shelfbin', 'warehouse', 'storage', 'position'] },
  { key: 'notes', header: 'Notes', kind: 'longtext', editable: true, clearable: true, width: 200, xlsxWidth: 36, aliases: ['notes', 'note', 'remarks', 'remark', 'comment', 'comments', 'internalnotes'] },
  { key: 'lowStockAt', header: 'Low at', kind: 'int', editable: true, clearable: true, width: 76, xlsxWidth: 9, aliases: ['lowat', 'lowstockat', 'reorderpoint', 'lowstockthreshold', 'minstock', 'minimumstock'], hint: 'Low-stock threshold for this item; empty = the default in settings.' },
  { key: 'status', header: 'Site status', kind: 'enum', editable: true, width: 116, xlsxWidth: 14, aliases: ['sitestatus', 'status', 'listingstatus', 'published'] },
  { key: 'mode', header: 'Sale mode', kind: 'enum', editable: true, width: 136, xlsxWidth: 17, aliases: ['salemode', 'mode', 'buyingmode', 'listingmode'] },
  { key: 'link', header: 'Listing link', kind: 'readonly', editable: false, width: 64, xlsxWidth: 44, aliases: ['listinglink', 'link', 'url', 'listingurl'], hint: 'Ignored on import.' },
];

export const COLUMN_BY_KEY = new Map<ColumnKey, ColumnDef>(COLUMNS.map((c) => [c.key, c]));

export const FIELD_LABEL: Record<string, string> = Object.fromEntries(COLUMNS.map((c) => [c.key, c.header]));

export function enumOptions(field: ColumnKey): readonly { value: string; label: string }[] {
  if (field === 'condition') return CONDITION_OPTIONS;
  if (field === 'mode') return MODE_OPTIONS;
  if (field === 'status') return STATUS_OPTIONS;
  return [];
}

export function enumLabel(field: ColumnKey, value: string | null | undefined): string {
  if (!value) return '';
  return enumOptions(field).find((o) => o.value === value)?.label ?? value;
}

/** Match a typed enum value against value or label, case/space-insensitive. */
export function matchEnum(field: ColumnKey, input: string): string | undefined {
  const k = input.toLowerCase().replace(/[^a-z0-9+]/g, '');
  if (!k) return undefined;
  const extra: Record<string, Record<string, string>> = {
    status: { published: 'PUBLISHED', live: 'PUBLISHED', online: 'PUBLISHED', yes: 'PUBLISHED', hidden: 'DRAFT', no: 'DRAFT', offline: 'DRAFT', pending: 'PENDING_REVIEW' },
    mode: { quote: 'QUOTE_ONLY', buy: 'BUY_NOW', buynowquote: 'HYBRID', both: 'HYBRID', hybrid: 'HYBRID' },
    condition: { refurb: 'REFURBISHED', secondhand: 'USED', asnew: 'REFURBISHED' },
  };
  for (const o of enumOptions(field)) {
    if (o.value.toLowerCase().replace(/[^a-z0-9+]/g, '') === k) return o.value;
    if (o.label.toLowerCase().replace(/[^a-z0-9+]/g, '') === k) return o.value;
  }
  return extra[field]?.[k];
}

/** The row shape sent to the sheet (cost fields are null when the viewer may not see them). */
export type InventoryRow = {
  id: string;
  slug: string;
  image: string | null;
  sku: string | null;
  mpn: string | null;
  mpnFromSpecs: boolean;
  title: string;
  brand: string | null;
  category: string;
  condition: string;
  supplier: string | null;
  costCents: number | null;
  onHand: number;
  reserved: number;
  available: number;
  priceCents: number | null;
  /** Quote-only item: the selling price is internal and never shown on the site. */
  priceInternal: boolean;
  currency: string;
  location: string | null;
  notes: string | null;
  lowStockAt: number | null;
  status: string;
  mode: string;
  shop: string | null; // null = Labtodate's own listing
  updatedAt: string;
};

export function marginOf(row: Pick<InventoryRow, 'priceCents' | 'costCents'>): { cents: number | null; pct: number | null } {
  if (row.priceCents === null || row.costCents === null) return { cents: null, pct: null };
  const cents = row.priceCents - row.costCents;
  const pct = row.priceCents > 0 ? Math.round((cents / row.priceCents) * 1000) / 10 : null;
  return { cents, pct };
}

export function isLow(row: Pick<InventoryRow, 'available' | 'lowStockAt'>, defaultThreshold: number): boolean {
  return row.available <= (row.lowStockAt ?? defaultThreshold);
}

/** Value of a column on a row, as the sheet/export shows it (cents stay cents). */
export function rowValue(row: InventoryRow, key: ColumnKey): string | number | null {
  switch (key) {
    case 'margin':
      return marginOf(row).cents;
    case 'marginPct':
      return marginOf(row).pct;
    case 'link':
      return `/marketplace/${row.slug}`;
    default:
      return (row as unknown as Record<string, string | number | null>)[key] ?? null;
  }
}
