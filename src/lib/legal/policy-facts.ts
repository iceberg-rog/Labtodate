import { prisma } from '@/lib/db';
import { ensureSettingsLoaded, settingInt } from '@/lib/settings';
import { legalIdentity } from '@/lib/brand/identity';
import { availablePaymentMethods } from '@/lib/checkout/server';
import { getSecurityPolicy } from '@/lib/security/policy';
import {
  POLICY_SOURCES, policyContact, policyRevisionDate, teamNotificationsAddedAt, teamNotificationServices, type PolicyFacts,
} from './policy-text';

/**
 * The facts the privacy and cookie pages state, read from the settings at
 * render time — so the pages change with the configuration (card payments
 * on or off, retention years, marketing basis, company identity, the chat
 * services staff notices are posted to).
 */
export async function loadPolicyFacts(): Promise<{ facts: PolicyFacts; contact: { href: string; label: string } }> {
  await ensureSettingsLoaded();
  const id = legalIdentity();
  const [policy, hooks] = await Promise.all([
    getSecurityPolicy(),
    prisma.webhookConfig.findMany({ where: { isActive: true }, select: { kind: true, chatId: true } }),
  ]);
  return {
    facts: {
      site: id.siteName,
      legalName: id.displayName,
      addressLines: id.addressLines,
      retentionYears: settingInt('DOC_RETENTION_YEARS', 7),
      cardPayments: availablePaymentMethods().includes('STRIPE_CARD'),
      marketingSoftOptIn: policy.MARKETING_SOFT_OPT_IN,
      teamNotificationServices: teamNotificationServices(hooks),
    },
    contact: policyContact(id.supportEmail, id.email),
  };
}

/**
 * The “Last updated” date of /legal/privacy or /legal/cookies
 * (policyRevisionDate). Values set only in .env and removed webhooks leave no
 * trace, so they do not move the date.
 */
export async function loadPolicyUpdatedAt(page: keyof typeof POLICY_SOURCES): Promise<Date> {
  const src = POLICY_SOURCES[page];
  const [row, change, hooks] = await Promise.all([
    prisma.setting.findUnique({ where: { key: src.textKey }, select: { updatedAt: true } }),
    prisma.settingChange.findFirst({
      where: { key: { in: [src.textKey, ...src.factKeys] } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    src.webhooks ? prisma.webhookConfig.findMany({ where: { isActive: true }, select: { kind: true, chatId: true, createdAt: true } }) : [],
  ]);
  return policyRevisionDate({
    textUpdatedAt: row?.updatedAt ?? null,
    defaultTextDate: new Date(`${src.defaultDate}T12:00:00Z`),
    changes: [change?.createdAt, teamNotificationsAddedAt(hooks)],
  });
}
