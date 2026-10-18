import { capsAllow } from '@/lib/capabilities';

/**
 * Rules for listings managed in the seller panel (/app/seller/products). Pure:
 * the server actions, the pages and the admin moderation view share them, and
 * src/lib/sellers/listing-rules.test.ts pins them.
 *
 * Who may do what (D05):
 *  - the owner of a listing edits, deletes and asks for review;
 *  - staff act on somebody else's listing only with the permission for it:
 *    products:edit to change or delete it, products:approve to publish it;
 *  - publishing is moderation: only an admin with products:approve publishes,
 *    even on their own listing — everybody else sends it to review.
 */

export interface PanelActor {
  userId: string;
  role: string;
  /** Admin capabilities (empty for suppliers). */
  caps: readonly string[];
}

export type PanelAction = 'edit' | 'delete' | 'publish';

export type PanelAccess = { ok: true; asStaff: boolean } | { ok: false; message: string };

/** An admin who may publish / reject listings (products:approve). */
export function isListingModerator(actor: PanelActor): boolean {
  return actor.role === 'ADMIN' && capsAllow([...actor.caps], 'products:approve');
}

export function panelAccess(actor: PanelActor, ownerId: string, action: PanelAction): PanelAccess {
  if (actor.userId === ownerId) return { ok: true, asStaff: false };
  if (actor.role !== 'ADMIN') return { ok: false, message: 'Forbidden: you can only change your own listings.' };
  const cap = action === 'publish' ? 'products:approve' : 'products:edit';
  if (!capsAllow([...actor.caps], cap)) {
    return { ok: false, message: `Forbidden: changing another supplier’s listing needs the ${cap} permission.` };
  }
  return { ok: true, asStaff: true };
}

/**
 * A supplier's listing is sold by us at the supplier's price plus the margin
 * of the supplier's company (Admin → Companies). Without a linked company
 * there is no margin rule, so it must not go live (D84). Listings of admins
 * are our own stock and need no company.
 */
export function sellerListingPublishProblem(listing: { sellerRole: string | null | undefined; companyId: string | null | undefined }): string | null {
  if (listing.sellerRole !== 'SELLER' || listing.companyId) return null;
  return 'This supplier is not linked to a company yet, so the listing has no price rule. Link the supplier to a company first (Admin → Users → the supplier → Supplier company).';
}

/**
 * A company's pricing rule in words — what lib/pricing/resolve.ts does to a
 * supplier's price — and whether it leaves us no margin.
 */
export function companyPriceRule(mode: string, markupBp: number): { rule: string; noMargin: boolean } {
  const pct = (bp: number) => `${(Math.abs(bp) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} %`;
  switch (mode) {
    case 'MARKUP_PERCENT':
      if (markupBp > 0) return { rule: `we add ${pct(markupBp)} to the supplier price`, noMargin: false };
      if (markupBp < 0) return { rule: `${pct(markupBp)} below the supplier price`, noMargin: true };
      return { rule: 'markup 0 %: no margin', noMargin: true };
    case 'FORCE_QUOTE':
      return { rule: 'sold on quotation only', noMargin: false };
    case 'HIDE_PRICE':
      return { rule: 'price on request (quote only)', noMargin: false };
    default:
      return { rule: 'supplier price passed through: no margin', noMargin: true };
  }
}

/** The listing fields the seller panel edits, as stored. */
export interface ListingFields {
  title: string;
  summary: string | null;
  description: string | null;
  categoryId: string;
  brandId: string | null;
  condition: string;
  mode: string;
  priceCents: number | null;
  currency: string;
  quantity: number;
  yearMade: number | null;
  illustration: string | null;
  images: readonly string[];
  specs: unknown;
  warrantyMonths: number | null;
  warrantyText: string | null;
  conditionNotes: string | null;
  inspectedAt: string | null;
  inspectionNotes: string | null;
  shippingClass: string | null;
  weightKg: number | null;
  vatScheme: string;
}

/**
 * What buyers are promised commercially: price and how it is sold, the
 * condition and what is guaranteed about it. A change to one of these on a
 * live listing goes back to review (hidden until approved).
 */
const COMMERCIAL: Array<[keyof ListingFields, string]> = [
  ['priceCents', 'price'],
  ['currency', 'currency'],
  ['mode', 'buying mode'],
  ['condition', 'condition'],
  ['warrantyMonths', 'warranty'],
  ['warrantyText', 'warranty terms'],
  ['inspectedAt', 'inspection date'],
  ['vatScheme', 'VAT scheme'],
];

/** Descriptive content: stays live when changed, and staff are asked to check it. */
const CONTENT: Array<[keyof ListingFields, string]> = [
  ['title', 'title'],
  ['summary', 'summary'],
  ['description', 'description'],
  ['categoryId', 'category'],
  ['brandId', 'brand'],
  ['yearMade', 'year made'],
  ['illustration', 'illustration'],
  ['images', 'photos'],
  ['specs', 'specs'],
  ['conditionNotes', 'condition notes'],
  ['inspectionNotes', 'inspection notes'],
  ['shippingClass', 'shipping class'],
  ['weightKg', 'weight'],
];

function norm(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.join('\n');
  if (typeof v === 'object') return Object.keys(v as object).length ? JSON.stringify(v) : '';
  return String(v);
}

export interface ListingChanges {
  /** Buyer-facing terms (labels): back to review on a live listing. */
  commercial: string[];
  /** Descriptive content (labels): stays live, flagged for a check. */
  content: string[];
  /** The stock count changed (applies at once: a unit sold elsewhere must go off sale now). */
  stock: boolean;
}

export function listingChanges(before: ListingFields, after: ListingFields): ListingChanges {
  const diff = (fields: Array<[keyof ListingFields, string]>) =>
    fields.filter(([k]) => norm(before[k]) !== norm(after[k])).map(([, label]) => label);
  return { commercial: diff(COMMERCIAL), content: diff(CONTENT), stock: before.quantity !== after.quantity };
}

export type LiveEditOutcome = 'none' | 'review' | 'flagged';

/**
 * What an edit does to a listing's visibility (D69): a moderator's edit, or an
 * edit of a listing that is not live, changes nothing; a commercial change to a
 * live listing sends it back to review; a content-only change keeps it live
 * and asks staff to check it.
 */
export function liveEditOutcome(status: string, changes: ListingChanges, moderator: boolean): LiveEditOutcome {
  if (moderator || status !== 'PUBLISHED') return 'none';
  if (changes.commercial.length) return 'review';
  if (changes.content.length) return 'flagged';
  return 'none';
}

/** Key of the free-text spec row that holds the dimensions entered on the seller form. */
export const DIMENSIONS_SPEC_KEY = 'Dimensions';
