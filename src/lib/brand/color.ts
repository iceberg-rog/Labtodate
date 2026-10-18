/**
 * The e-mail brand colour (Settings → Brand → EMAIL_BRAND_COLOR): headings,
 * links and the button of every customer e-mail. The button text is white, so
 * a colour too light to read white text on is refused at save time and, should
 * one still reach a mail (an old .env value), replaced by the default.
 * Pure — safe to import anywhere (the settings registry uses the validator).
 */

export const DEFAULT_BRAND_COLOR = '#0E4F40';
/** WCAG AA for normal text: white button text on the brand colour. */
export const MIN_CONTRAST_WITH_WHITE = 4.5;

const HEX = /^#([0-9a-f]{6})$/i;

/** Relative luminance (WCAG 2.x) of a #RRGGBB colour. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Contrast ratio of white text on a #RRGGBB background (1 … 21). */
export function contrastWithWhite(hex: string): number {
  return 1.05 / (luminance(hex) + 0.05);
}

/** Why a value can't be the e-mail brand colour, or null when it can. */
export function brandColorProblem(value: string): string | null {
  const v = value.trim();
  if (!HEX.test(v)) return 'use a colour code like #0E4F40 (# and six hex digits).';
  const ratio = contrastWithWhite(v);
  if (ratio < MIN_CONTRAST_WITH_WHITE) {
    return `too light: white button text on it has a contrast of ${ratio.toFixed(1)} : 1, at least ${MIN_CONTRAST_WITH_WHITE} : 1 is needed to read it. Choose a darker colour.`;
  }
  return null;
}

/** The configured colour when usable, else the default. */
export function emailBrandColor(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  return v && !brandColorProblem(v) ? v.toUpperCase() : DEFAULT_BRAND_COLOR;
}
