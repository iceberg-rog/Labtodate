/**
 * What lab2date promises about ONE item: its warranty and whether it was
 * inspected. Pure functions (no DB) so the rule is unit-tested and identical on
 * the product page, the order line snapshot and the invoice.
 *
 * Warranty rule (owner-configurable, never a blanket claim):
 *   1. the item's own warranty (Product.warrantyMonths; 0 = explicitly none),
 *   2. else the default of its condition grade (Admin → Catalog → Conditions),
 *   3. else the "no warranty" fallback text (Settings → Catalog & claims).
 * Product.warrantyText is the item's warranty terms / notes; it refines the
 * scope of a warranty, or explains why there is none.
 *
 * Inspection rule: an item is "inspected" only when an inspection date is
 * recorded on it — and, while INSPECTION_CLAIM_REQUIRES_REPORT is on, a report
 * is attached. Nothing else (condition, shop, settings text) implies it.
 */

export const DEFAULT_WARRANTY_FALLBACK_TEXT = 'No warranty (sold as-is)';
/** How a warranty length is written (Settings → Catalog & claims → WARRANTY_MONTHS_FORMAT). */
export const DEFAULT_WARRANTY_MONTHS_FORMAT = '{MONTHS}-month warranty';

export interface ItemWarrantyInput {
  warrantyMonths: number | null | undefined;
  warrantyText: string | null | undefined;
}

export interface GradeWarrantyInput {
  label: string;
  defaultWarrantyMonths: number | null | undefined;
  warrantyScope: string | null | undefined;
}

export interface ResolvedWarranty {
  /** Where the promise comes from. NONE also covers an item set to "no warranty". */
  source: 'ITEM' | 'CONDITION' | 'NONE';
  hasWarranty: boolean;
  /** Months of warranty, 0 when there is none. */
  months: number;
  /** Scope / terms text, if any. */
  scope: string | null;
  /** Short line for badges and fact tiles: "12-month warranty" or the fallback text. */
  headline: string;
  /** Full sentence for the detail table, order line and invoice. */
  full: string;
}

function clean(s: string | null | undefined): string | null {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t : null;
}

export function warrantyMonthsLabel(months: number, format: string = DEFAULT_WARRANTY_MONTHS_FORMAT): string {
  const f = format.includes('{MONTHS}') ? format : DEFAULT_WARRANTY_MONTHS_FORMAT;
  return f.replace(/\{MONTHS\}/g, String(months));
}

export function resolveWarranty(
  item: ItemWarrantyInput,
  grade: GradeWarrantyInput | null | undefined,
  fallbackText: string = DEFAULT_WARRANTY_FALLBACK_TEXT,
  monthsFormat: string = DEFAULT_WARRANTY_MONTHS_FORMAT,
): ResolvedWarranty {
  const fallback = clean(fallbackText) ?? DEFAULT_WARRANTY_FALLBACK_TEXT;
  const itemText = clean(item.warrantyText);
  const itemMonths = item.warrantyMonths;
  const explicit = itemMonths !== null && itemMonths !== undefined;
  const months = explicit ? itemMonths : grade?.defaultWarrantyMonths ?? 0;

  if (Number.isFinite(months) && months > 0) {
    const scope = itemText ?? clean(grade?.warrantyScope);
    const headline = warrantyMonthsLabel(months, monthsFormat);
    return {
      source: explicit ? 'ITEM' : 'CONDITION',
      hasWarranty: true,
      months,
      scope,
      headline,
      full: scope ? `${headline} — ${scope}` : headline,
    };
  }
  return {
    source: 'NONE',
    hasWarranty: false,
    months: 0,
    scope: null,
    headline: fallback,
    full: itemText ? `${fallback} — ${itemText}` : fallback,
  };
}

export interface ItemInspectionInput {
  inspectedAt: Date | string | null | undefined;
  inspectionReportUrl: string | null | undefined;
  inspectionNotes?: string | null | undefined;
}

export interface ResolvedInspection {
  /** May the page say this unit was inspected? */
  claim: boolean;
  date: Date | null;
  reportUrl: string | null;
  notes: string | null;
  /** Why no claim is made (for admin previews). */
  reason: 'OK' | 'NO_DATE' | 'NO_REPORT';
}

export function resolveInspection(item: ItemInspectionInput, requireReport: boolean): ResolvedInspection {
  const date = item.inspectedAt ? new Date(item.inspectedAt) : null;
  const valid = date && !Number.isNaN(date.getTime()) ? date : null;
  const reportUrl = clean(item.inspectionReportUrl);
  const notes = clean(item.inspectionNotes);
  if (!valid) return { claim: false, date: null, reportUrl, notes, reason: 'NO_DATE' };
  if (requireReport && !reportUrl) return { claim: false, date: valid, reportUrl, notes, reason: 'NO_REPORT' };
  return { claim: true, date: valid, reportUrl, notes, reason: 'OK' };
}

/** What an order line records about the promise at the moment of sale. */
export interface OrderLineTruthSnapshot {
  conditionSnapshot: string;
  warrantySnapshot: string;
  warrantyMonthsSnapshot: number;
}

export function orderLineTruthSnapshot(
  item: ItemWarrantyInput,
  grade: GradeWarrantyInput,
  fallbackText?: string,
  monthsFormat?: string,
): OrderLineTruthSnapshot {
  const w = resolveWarranty(item, grade, fallbackText, monthsFormat);
  return { conditionSnapshot: grade.label, warrantySnapshot: w.full, warrantyMonthsSnapshot: w.months };
}
