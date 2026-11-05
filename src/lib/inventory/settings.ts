import { prisma } from '@/lib/db';

/**
 * Inventory business rules. Every rule the inventory applies is one of these
 * settings (stored in the Setting table under INVENTORY_*), edited on
 * /admin/inventory/settings. Nothing below is a hard-coded choice: the
 * `default` is only what applies until an admin saves another value.
 */

type Base = { key: string; group: string; label: string; hint: string };
export type InventorySettingDef =
  | (Base & { type: 'enum'; options: { value: string; label: string }[]; default: string })
  | (Base & { type: 'int'; min: number; max: number; default: number; suffix?: string })
  | (Base & { type: 'bool'; default: boolean })
  | (Base & { type: 'text'; maxLength: number; default: string; pattern?: RegExp; patternHint?: string; email?: boolean })
  | (Base & { type: 'category'; default: string });

export const INVENTORY_SETTING_DEFS = [
  // ── Public listing ──
  {
    key: 'INVENTORY_ZERO_STOCK',
    group: 'Public listing',
    type: 'enum',
    label: 'When an item has nothing available',
    hint: 'What buyers see once Available reaches 0. The listing comes back by itself when stock is added again; no setting changes the item itself.',
    options: [
      { value: 'label', label: 'Keep it listed, with the out-of-stock label' },
      { value: 'hide', label: 'Hide it from the marketplace and search (its page still opens)' },
      { value: 'unpublish', label: 'Hide it completely (its page returns "not found")' },
    ],
    default: 'label',
  },
  {
    key: 'INVENTORY_OOS_LABEL',
    group: 'Public listing',
    type: 'text',
    label: 'Out-of-stock label',
    hint: 'Shown on the product page and on marketplace cards.',
    maxLength: 40,
    default: 'Out of stock',
  },
  {
    key: 'INVENTORY_OOS_NOTE',
    group: 'Public listing',
    type: 'text',
    label: 'Out-of-stock note on the product page',
    hint: 'One sentence under the label. Leave empty to show none.',
    maxLength: 200,
    default: 'This item is not available right now. We can source one for you.',
  },
  {
    key: 'INVENTORY_PUBLIC_QTY',
    group: 'Public listing',
    type: 'enum',
    label: 'Show the quantity to buyers',
    hint: 'Buy-now and quote listings alike.',
    options: [
      { value: 'never', label: 'Never (only "In stock")' },
      { value: 'low', label: 'Only when few are left ("Only 2 left")' },
      { value: 'exact', label: 'Always the exact number' },
    ],
    default: 'never',
  },
  {
    key: 'INVENTORY_PUBLIC_LOW_AT',
    group: 'Public listing',
    type: 'int',
    label: '"Only N left" from',
    hint: 'With "only when few are left": the hint shows when Available is at or below this number.',
    min: 1,
    max: 1000,
    default: 3,
  },
  {
    key: 'INVENTORY_QUOTE_PRICE',
    group: 'Public listing',
    type: 'enum',
    label: 'Selling price on a quote-only item',
    hint: 'A quote-only listing never shows a price. Choose what entering a selling price on one does.',
    options: [
      { value: 'internal', label: 'Keep it quote-only; the price stays internal' },
      { value: 'buy_now', label: 'Switch it to "Buy now + quote" so the price shows' },
    ],
    default: 'internal',
  },
  // ── Alerts ──
  {
    key: 'INVENTORY_LOW_STOCK_DEFAULT',
    group: 'Low-stock alerts',
    type: 'int',
    label: 'Default low-stock threshold',
    hint: 'An item is "low" when Available is at or below this. 0 = only when it runs out. Each item can override it in the sheet (column "Low at").',
    min: 0,
    max: 100000,
    default: 0,
  },
  {
    key: 'INVENTORY_LOW_STOCK_NOTIFY',
    group: 'Low-stock alerts',
    type: 'bool',
    label: 'Admin notification when an item becomes low',
    hint: 'One notification per dip (bell icon, and any webhooks set up in Settings).',
    default: true,
  },
  {
    key: 'INVENTORY_LOW_STOCK_EMAIL',
    group: 'Low-stock alerts',
    type: 'bool',
    label: 'Also send an e-mail',
    hint: 'Sent to the address below.',
    default: false,
  },
  {
    key: 'INVENTORY_LOW_STOCK_EMAIL_TO',
    group: 'Low-stock alerts',
    type: 'text',
    label: 'Low-stock e-mail goes to',
    hint: 'One address.',
    maxLength: 200,
    default: '',
    email: true,
  },
  // ── Margins ──
  {
    key: 'INVENTORY_MIN_MARGIN_PCT',
    group: 'Margins',
    type: 'int',
    label: 'Minimum margin',
    hint: 'Margins below this percentage of the selling price turn red. 0 = only losses turn red.',
    min: -100,
    max: 1000,
    default: 0,
    suffix: '%',
  },
  // ── SKU ──
  {
    key: 'INVENTORY_SKU_AUTO',
    group: 'SKU',
    type: 'bool',
    label: 'Give new items a SKU automatically',
    hint: 'When an item is first saved without one. Existing items get one with the "Assign SKUs" button.',
    default: true,
  },
  {
    key: 'INVENTORY_SKU_PREFIX',
    group: 'SKU',
    type: 'text',
    label: 'SKU prefix',
    hint: 'Letters, digits and dashes, up to 12 characters.',
    maxLength: 12,
    default: 'LTD-',
    pattern: /^[A-Za-z0-9_-]*$/,
    patternHint: 'Use letters, digits, - and _ only.',
  },
  {
    key: 'INVENTORY_SKU_DIGITS',
    group: 'SKU',
    type: 'int',
    label: 'SKU number length',
    hint: 'Zero-padded, e.g. 5 gives LTD-00042.',
    min: 1,
    max: 9,
    default: 5,
  },
  // ── New items ──
  {
    key: 'INVENTORY_NEW_MODE',
    group: 'New items',
    type: 'enum',
    label: 'Sale mode of a new item',
    hint: 'For items added in the sheet, and imported rows without a Sale mode column.',
    options: [
      { value: 'QUOTE_ONLY', label: 'Quote only' },
      { value: 'BUY_NOW', label: 'Buy now' },
      { value: 'HYBRID', label: 'Buy now + quote' },
    ],
    default: 'QUOTE_ONLY',
  },
  {
    key: 'INVENTORY_NEW_CONDITION',
    group: 'New items',
    type: 'enum',
    label: 'Condition of a new item',
    hint: 'For items added in the sheet, and imported rows without a Condition column.',
    options: [
      { value: 'USED', label: 'Used' },
      { value: 'REFURBISHED', label: 'Refurbished' },
      { value: 'NEW', label: 'New' },
    ],
    default: 'USED',
  },
  // ── Import ──
  {
    key: 'INVENTORY_IMPORT_BLANK',
    group: 'Import',
    type: 'enum',
    label: 'An empty cell in an imported file',
    hint: 'Applies to columns that are present in the file.',
    options: [
      { value: 'keep', label: 'Leaves the current value unchanged' },
      { value: 'clear', label: 'Clears the value' },
    ],
    default: 'keep',
  },
  {
    key: 'INVENTORY_IMPORT_NEW_ROWS',
    group: 'Import',
    type: 'enum',
    label: 'A row that matches no item',
    hint: 'Rows are matched by ID, then SKU, then part number, then exact name.',
    options: [
      { value: 'draft', label: 'Becomes a new draft listing (not on the site)' },
      { value: 'published', label: 'Becomes a new published listing' },
      { value: 'skip', label: 'Is skipped' },
    ],
    default: 'draft',
  },
  {
    key: 'INVENTORY_IMPORT_DEFAULT_CATEGORY',
    group: 'Import',
    type: 'category',
    label: 'Category for new rows without one',
    hint: 'Used when a new row has no Category column or an empty one. Empty = such rows are refused.',
    default: '',
  },
  // ── Language ──
  {
    key: 'INVENTORY_LATIN_ONLY',
    group: 'Language',
    type: 'enum',
    label: 'Refuse Persian/Arabic script',
    hint: 'Persian and Arabic digits are always turned into 0-9. This decides where Persian/Arabic letters are refused.',
    options: [
      { value: 'all', label: 'In every text field' },
      { value: 'public', label: 'Only in fields shown on the site (name, brand)' },
      { value: 'off', label: 'Nowhere' },
    ],
    default: 'all',
  },
] as const satisfies readonly InventorySettingDef[];

export type InventorySettingKey = (typeof INVENTORY_SETTING_DEFS)[number]['key'];

type ValueOf<D> = D extends { type: 'int' }
  ? number
  : D extends { type: 'bool' }
    ? boolean
    : D extends { type: 'enum'; options: readonly { value: infer V }[] }
      ? V
      : string;

export type InventorySettings = {
  [D in (typeof INVENTORY_SETTING_DEFS)[number] as D['key']]: ValueOf<D>;
};

const DEF_BY_KEY = new Map<string, InventorySettingDef>(INVENTORY_SETTING_DEFS.map((d) => [d.key, d as InventorySettingDef]));

export function inventorySettingDef(key: string): InventorySettingDef | undefined {
  return DEF_BY_KEY.get(key);
}

/** Parse a stored (string) value; undefined when it is not valid for the def. */
export function parseSettingValue(def: InventorySettingDef, raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) return undefined;
  switch (def.type) {
    case 'int': {
      const t = raw.trim();
      if (!/^-?\d+$/.test(t)) return undefined;
      const n = Number(t);
      return n >= def.min && n <= def.max ? n : undefined;
    }
    case 'bool':
      return raw === 'true' ? true : raw === 'false' ? false : undefined;
    case 'enum':
      return def.options.some((o) => o.value === raw) ? raw : undefined;
    case 'text':
      if (raw.length > def.maxLength) return undefined;
      if (def.pattern && !def.pattern.test(raw)) return undefined;
      return raw;
    case 'category':
      return raw;
  }
}

/** Validate a value an admin submitted; returns the string to store or an error. */
export function validateSettingInput(def: InventorySettingDef, input: string): { value: string } | { error: string } {
  const v = input.trim();
  switch (def.type) {
    case 'int': {
      if (!/^-?\d+$/.test(v)) return { error: `${def.label}: enter a whole number.` };
      const n = Number(v);
      if (n < def.min || n > def.max) return { error: `${def.label}: use a number from ${def.min} to ${def.max}.` };
      return { value: String(n) };
    }
    case 'bool':
      return v === 'true' || v === 'false' ? { value: v } : { error: `${def.label}: choose on or off.` };
    case 'enum':
      return def.options.some((o) => o.value === v) ? { value: v } : { error: `${def.label}: choose one of the options.` };
    case 'text':
      if (v.length > def.maxLength) return { error: `${def.label}: at most ${def.maxLength} characters.` };
      if (def.pattern && !def.pattern.test(v)) return { error: `${def.label}: ${def.patternHint ?? 'invalid value.'}` };
      if (def.email && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: `${def.label}: enter a valid e-mail address.` };
      return { value: v };
    case 'category':
      return { value: v };
  }
}

export function defaultInventorySettings(): InventorySettings {
  const out: Record<string, unknown> = {};
  for (const d of INVENTORY_SETTING_DEFS) out[d.key] = d.default;
  return out as InventorySettings;
}

// Process-wide, not module-level: Next.js can load this module more than once
// (per route / server-action bundle), and a save must reach every copy at once.
type CacheBox = { entry: { at: number; value: InventorySettings } | null };
const box: CacheBox = ((globalThis as { __inventorySettingsCache?: CacheBox }).__inventorySettingsCache ??= { entry: null });
const TTL_MS = 5000;

/** Current inventory settings (DB value, else the default). Cached 5 s per process. */
export async function getInventorySettings(): Promise<InventorySettings> {
  const cached = box.entry;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const value = defaultInventorySettings() as Record<string, unknown>;
  try {
    const rows = await prisma.setting.findMany({ where: { key: { startsWith: 'INVENTORY_' } } });
    for (const r of rows) {
      const def = DEF_BY_KEY.get(r.key);
      if (!def) continue;
      const parsed = parseSettingValue(def, r.value);
      if (parsed !== undefined) value[r.key] = parsed;
    }
  } catch {
    // A settings read must never take a public page down: fall back to the defaults.
  }
  box.entry = { at: Date.now(), value: value as InventorySettings };
  return box.entry.value;
}

export function invalidateInventorySettings(): void {
  box.entry = null;
}
