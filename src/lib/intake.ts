import { logError } from '@/lib/observability';
import { ensureSettingsLoaded } from '@/lib/settings';

/**
 * The inbox that gets staff copies (new ticket, new quote request, new sell
 * offer, buyer replies), from Admin → Settings. There is deliberately no
 * built-in fallback address: the old ones (support@ / sourcing@ /
 * acquisitions@lab2date.com) are on a domain we do not own, so mail sent there
 * leaked customer messages to whoever holds it. When nothing is configured the
 * copy is skipped and logged (Admin → Errors) — the request itself is saved
 * and the admin notification bell still fires.
 */

export type IntakeKind = 'support' | 'quote' | 'sell';

const CHAINS: Record<IntakeKind, string[]> = {
  support: ['SUPPORT_INTAKE_EMAIL', 'SUPPORT_EMAIL', 'COMPANY_EMAIL'],
  quote: ['QUOTE_INTAKE_EMAIL', 'SUPPORT_INTAKE_EMAIL', 'SUPPORT_EMAIL', 'COMPANY_EMAIL'],
  sell: ['SELL_INTAKE_EMAIL', 'SUPPORT_INTAKE_EMAIL', 'SUPPORT_EMAIL', 'COMPANY_EMAIL'],
};

/** The first configured address of the chain, or '' (no logging). */
export function configuredIntakeEmail(kind: IntakeKind): string {
  for (const k of CHAINS[kind]) {
    const v = (process.env[k] || '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * The staff inbox for `kind`, or null — then the caller skips the e-mail; the
 * gap is written to the error log as "email.intake.missing".
 */
export async function intakeEmail(kind: IntakeKind, what: string): Promise<string | null> {
  await ensureSettingsLoaded();
  const to = configuredIntakeEmail(kind);
  if (to) return to;
  await logError('email.intake.missing', `${what}: no staff inbox configured (${CHAINS[kind].join(' / ')}), so the staff e-mail was not sent.`);
  return null;
}
