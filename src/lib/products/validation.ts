import { defaultErrorMap, type ZodError, type ZodIssue } from 'zod';

/**
 * Highest price (in cents) a product may carry: €1,000,000.00. Product.priceCents
 * is an INT4 column, so an unbounded value crashed the save with a Prisma
 * conversion error. Same cap as the admin quick-edit popup.
 */
export const MAX_PRICE_CENTS = 100_000_000;
export const MAX_PRICE_MESSAGE = 'Price must be at most €1,000,000.';

/** Photo limit on the admin product form. Shop imports keep every supplier
 *  photo (16+ on some listings), so the seller form's limit of 8 would make
 *  those products impossible to re-save. */
export const MAX_ADMIN_PRODUCT_IMAGES = 40;

/**
 * One readable sentence for a zod issue. Server actions return this instead of
 * `ZodError.message`, which is the raw JSON issue array. A message given in the
 * schema (e.g. `.max(n, '…')`) wins; otherwise one is built from the field's
 * label in `labels` (keyed by the top-level field name).
 */
export function describeIssue(issue: ZodIssue, labels: Record<string, string> = {}): string {
  const key = String(issue.path[0] ?? '');
  const label = labels[key] ?? 'One of the fields';
  const fallback = defaultErrorMap(issue, { defaultError: '', data: undefined }).message;
  if (issue.message && issue.message !== fallback) return issue.message;

  switch (issue.code) {
    case 'too_small':
      if (issue.type === 'string') {
        return Number(issue.minimum) <= 1 ? `${label} is required.` : `${label} must be at least ${issue.minimum} characters.`;
      }
      if (issue.type === 'array') return `${label}: add at least ${issue.minimum}.`;
      return `${label} must be at least ${issue.minimum}.`;
    case 'too_big':
      if (issue.type === 'string') return `${label} must be at most ${issue.maximum} characters.`;
      if (issue.type === 'array') return `${label}: at most ${issue.maximum} allowed.`;
      return `${label} must be at most ${issue.maximum}.`;
    case 'invalid_string':
      if (issue.validation === 'url') {
        return issue.path.length > 1
          ? `${label}: one of the entries is not a valid web address.`
          : `${label} must be a full web address starting with http:// or https://.`;
      }
      if (issue.validation === 'email') return `${label} must be a valid email address.`;
      return `${label} has an invalid format.`;
    case 'invalid_type':
      return issue.received === 'undefined' || issue.received === 'null'
        ? `${label} is required.`
        : `${label} has an invalid value.`;
    case 'invalid_enum_value':
      return `${label} has an unknown value.`;
    default:
      return `${label} is invalid.`;
  }
}

/** First readable message per top-level field, for showing next to inputs. */
export function zodFieldErrors(err: ZodError, labels: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? '');
    if (!(key in out)) out[key] = describeIssue(issue, labels);
  }
  return out;
}

/** All distinct field messages joined into one line, for a form-level error box. */
export function zodMessage(err: ZodError, labels: Record<string, string> = {}): string {
  return Object.values(zodFieldErrors(err, labels)).join(' ');
}
