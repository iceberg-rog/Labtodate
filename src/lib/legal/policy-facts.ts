import { ensureSettingsLoaded, settingInt } from '@/lib/settings';
import { legalIdentity } from '@/lib/brand/identity';
import { availablePaymentMethods } from '@/lib/checkout/server';
import { getSecurityPolicy } from '@/lib/security/policy';
import { policyContact, type PolicyFacts } from './policy-text';

/**
 * The facts the privacy and cookie pages state, read from the settings at
 * render time — so the pages change with the configuration (card payments
 * on or off, retention years, marketing basis, company identity).
 */
export async function loadPolicyFacts(): Promise<{ facts: PolicyFacts; contact: { href: string; label: string } }> {
  await ensureSettingsLoaded();
  const id = legalIdentity();
  const policy = await getSecurityPolicy();
  return {
    facts: {
      site: id.siteName,
      legalName: id.displayName,
      addressLines: id.addressLines,
      retentionYears: settingInt('DOC_RETENTION_YEARS', 7),
      cardPayments: availablePaymentMethods().includes('STRIPE_CARD'),
      marketingSoftOptIn: policy.MARKETING_SOFT_OPT_IN,
    },
    contact: policyContact(id.supportEmail, id.email),
  };
}
