import { z } from 'zod';
import { decideVat, rateBpFor, VAT_TREATMENTS, type VatDecision, type ViesEvidence } from '@/lib/tax/vat';
import { checkVies } from '@/lib/tax/vies';
import { parseVatId } from '@/lib/tax/vatid';
import { computeTotals, parseQuoteDetails, type QuoteDetails, type Totals } from './build';
import { getGeneral, getOptions, getVatSettings } from './config';
import type { DocLine, Lang } from './types';

/**
 * Turns what the admin typed in the quote composer into a QuoteDetails
 * record: lines, shipping, the buyer's billing block, the VAT decision (with
 * a live VIES check), language and validity. Shared by "Preview PDF" and
 * "Send", so the preview is exactly what gets sent.
 */

export const LineInput = z.object({
  title: z.string().trim().min(1, 'Every line needs a description.').max(300),
  detail: z.string().trim().max(300).optional().nullable(),
  qty: z.number().positive('Quantity must be above zero.').max(9_999),
  unitCents: z.number().int().min(-100_000_000).max(100_000_000),
});

export const ComposeInput = z.object({
  mainTitle: z.string().trim().max(300).optional().nullable(),
  mainDetail: z.string().trim().max(300).optional().nullable(),
  extraLines: z.array(LineInput).max(20).optional().default([]),
  shippingCents: z.number().int().min(0).max(10_000_000).optional().default(0),
  billing: z
    .object({
      name: z.string().trim().max(160).optional().nullable(),
      company: z.string().trim().max(180).optional().nullable(),
      address: z.string().trim().max(600).optional().nullable(),
      country: z.string().trim().max(2).optional().nullable(),
      vatId: z.string().trim().max(20).optional().nullable(),
    })
    .optional()
    .default({}),
  vatTreatment: z.enum(['AUTO', 'DOMESTIC', 'REVERSE_CHARGE', 'EXPORT']).optional().default('AUTO'),
  validDays: z.number().int().min(1).max(365).optional().nullable(),
  lang: z.enum(['en', 'nl']).optional().nullable(),
});

export type ComposeInputT = z.input<typeof ComposeInput>;

export interface ComposeResult {
  details: QuoteDetails;
  totals: Totals;
  suggestion: VatDecision;
  vies: ViesEvidence | null;
}

export async function composeQuote(args: {
  mainLine: DocLine;
  input: ComposeInputT;
  previous: unknown;
  buyerLang?: string | null;
  actorEmail: string;
}): Promise<ComposeResult | { error: string }> {
  const parsed = ComposeInput.safeParse(args.input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message || 'Check the quote fields.' };
  const p = parsed.data;
  const [vatSettings, general, quoteOptions] = await Promise.all([getVatSettings(), getGeneral(), getOptions('QUOTE')]);
  const prev = parseQuoteDetails(args.previous);

  const country = (p.billing.country || '').toUpperCase() || null;
  if (country && !/^[A-Z]{2}$/.test(country)) return { error: 'Country: use the two-letter code, e.g. NL, DE, US.' };
  const vatIdRaw = (p.billing.vatId || '').trim();
  const vatId = vatIdRaw ? parseVatId(vatIdRaw)?.vatId ?? vatIdRaw.toUpperCase() : null;

  // VIES only when it can change the outcome: an EU VAT ID outside the home country.
  let vies: ViesEvidence | null = null;
  if (vatId && country && country !== vatSettings.homeCountry && vatSettings.reverseChargeEnabled && vatSettings.requireVies) {
    const reuse = prev?.vies && prev.vies.vatId === vatId && prev.vies.status === 'VALID' ? prev.vies : null;
    vies = reuse ?? (await checkVies(vatId));
  }
  const suggestion = decideVat({ country, vatId, vies }, vatSettings);

  let treatment: QuoteDetails['vat']['treatment'];
  let reason: string;
  let overridden = false;
  if (p.vatTreatment === 'AUTO') {
    if (suggestion.treatment === 'REVIEW') {
      return { error: `${suggestion.reason}` };
    }
    treatment = suggestion.treatment;
    reason = suggestion.reason;
  } else {
    if (!vatSettings.allowOverride && p.vatTreatment !== suggestion.treatment) {
      return { error: 'Changing the suggested VAT treatment is switched off in Documents → VAT.' };
    }
    if (p.vatTreatment === 'REVERSE_CHARGE' && !vatId) {
      return { error: 'Reverse charge needs the buyer’s EU VAT ID on the quote.' };
    }
    treatment = p.vatTreatment;
    overridden = p.vatTreatment !== suggestion.treatment;
    const label = VAT_TREATMENTS.find((t) => t.value === treatment)?.label ?? treatment;
    reason = overridden ? `Set by ${args.actorEmail}: ${label} (suggested: ${suggestion.reason})` : suggestion.reason;
  }
  const rateBp = rateBpFor(treatment, vatSettings);

  const main: DocLine = {
    ...args.mainLine,
    title: p.mainTitle?.trim() || args.mainLine.title,
    detail: p.mainDetail?.trim() || null,
  };
  const lines: DocLine[] = [main, ...p.extraLines.map((l) => ({ title: l.title, qty: l.qty, unitCents: l.unitCents, detail: l.detail || null }))];
  const totals = computeTotals(lines, p.shippingCents, rateBp);
  if (totals.subtotalCents <= 0) return { error: 'The lines add up to zero or less. Check the prices.' };
  if (totals.totalCents > 1_000_000_00) return { error: 'That comes to more than EUR 1,000,000.' };

  const lang: Lang = p.lang === 'en' || p.lang === 'nl'
    ? p.lang
    : prev?.lang ?? (args.buyerLang === 'en' || args.buyerLang === 'nl' ? args.buyerLang : general.defaultLang);

  const details: QuoteDetails = {
    v: 1,
    lines,
    shippingCents: totals.shippingCents,
    billing: {
      name: p.billing.name || null,
      company: p.billing.company || null,
      addressLines: (p.billing.address || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 6),
      country,
      vatId,
    },
    vies,
    vat: { treatment, rateBp, reason, overridden },
    lang,
    validDays: p.validDays ?? quoteOptions.days,
  };
  return { details, totals, suggestion, vies };
}
