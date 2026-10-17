import { isValidIban } from '@/lib/settings/defs';

/**
 * The acquisition (buy-from-lab) lifecycle as a guarded state machine (A22) and
 * the payout-account rules (A23). Pure — unit tests: stages.test.ts.
 *
 *   (accepted) → AWAITING_BANK → AWAITING_SHIPPING → IN_TRANSIT → RECEIVED → COMPLETED
 *
 * Every write moves exactly one step from the stage the writer saw
 * (`updateMany({ where: { id, acquisitionStage: from } })`), so a stale tab or a
 * double click changes nothing and sends no second email.
 */

export const ACQ_STAGES = ['AWAITING_BANK', 'AWAITING_SHIPPING', 'IN_TRANSIT', 'RECEIVED', 'COMPLETED'] as const;
export type AcqStage = (typeof ACQ_STAGES)[number];

/** Allowed moves. A package can arrive before the seller entered tracking. */
export const ACQ_TRANSITIONS: Record<AcqStage, readonly AcqStage[]> = {
  AWAITING_BANK: ['AWAITING_SHIPPING'],
  AWAITING_SHIPPING: ['IN_TRANSIT', 'RECEIVED'],
  IN_TRANSIT: ['RECEIVED'],
  RECEIVED: ['COMPLETED'],
  COMPLETED: [],
};

export const ACQ_STAGE_LABEL: Record<AcqStage, string> = {
  AWAITING_BANK: 'waiting for the payout bank details',
  AWAITING_SHIPPING: 'waiting for the seller to ship',
  IN_TRANSIT: 'in transit to us',
  RECEIVED: 'received — inspection and payout',
  COMPLETED: 'completed (paid out)',
};

export function stageRank(s: string | null | undefined): number {
  return ACQ_STAGES.indexOf((s ?? '') as AcqStage);
}

export function canMoveAcq(from: string | null | undefined, to: AcqStage): boolean {
  const f = (from ?? '') as AcqStage;
  return (ACQ_TRANSITIONS[f] ?? []).includes(to);
}

/** Readable refusal for a move that is not allowed from the current stage. */
export function acqMoveRefusal(from: string | null | undefined, to: AcqStage): string {
  const cur = from ? ACQ_STAGE_LABEL[from as AcqStage] ?? from.toLowerCase() : 'not accepted yet';
  return `This deal is ${cur} — it can not move to “${ACQ_STAGE_LABEL[to]}” from there. Reload the page to see its current state.`;
}

/** Is the payout account locked (changes need staff review) at this stage? */
export function bankLocked(stage: string | null | undefined, lockFrom: string): boolean {
  const r = stageRank(stage);
  return r >= 0 && r >= stageRank(lockFrom);
}

export interface PayoutAccount {
  holder: string;
  iban: string;
  swift: string;
  bankName: string;
  country: string;
  notes: string;
}

export function normaliseIban(v: string): string {
  return v.replace(/\s+/g, '').toUpperCase();
}

/** Problem with the account the seller entered, or null. */
export function payoutAccountProblem(a: PayoutAccount, requireValidIban: boolean): string | null {
  if (a.holder.trim().length < 2) return 'Enter the account holder’s name.';
  const iban = normaliseIban(a.iban);
  if (iban.length < 5) return 'Enter the account number (IBAN).';
  const looksIban = /^[A-Z]{2}\d{2}/.test(iban);
  if ((requireValidIban || looksIban) && !isValidIban(iban)) {
    return looksIban ? 'This IBAN is not valid — check it for typos (the check digits do not match).' : 'Enter a valid IBAN (e.g. NL91 ABNA 0417 1643 00).';
  }
  if (a.swift && !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(a.swift.replace(/\s+/g, '').toUpperCase())) return 'The SWIFT / BIC code is not valid (8 or 11 characters).';
  return null;
}

const tokens = (s: string) =>
  s.toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(b\.?v\.?|n\.?v\.?|gmbh|ltd|inc|llc|bv|vof|the|of|and|en|de|van|der)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);

/** Does the account holder plausibly match the seller (person or company)? */
export function holderMatches(holder: string, names: Array<string | null | undefined>): boolean {
  const h = new Set(tokens(holder));
  if (!h.size) return false;
  return names.some((n) => {
    const t = tokens(n ?? '');
    return t.length > 0 && t.some((x) => h.has(x));
  });
}

/** IBAN for display: grouped by 4, middle masked (seller / admin history). */
export function maskIban(iban: string): string {
  const v = normaliseIban(iban);
  if (v.length <= 8) return v;
  return `${v.slice(0, 4)} •••• ${v.slice(-4)}`;
}
