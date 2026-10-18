import { LegalShell } from '@/components/site/LegalShell';
import { PolicyText } from '@/components/site/PolicyText';
import { loadPolicyFacts } from '@/lib/legal/policy-facts';
import { privacyPolicyValues, renderPolicyBlocks } from '@/lib/legal/policy-text';
import { settingString } from '@/lib/settings';
import { DEFAULT_PRIVACY_POLICY_TEXT } from '@/lib/settings/page-texts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Privacy Policy' };

/**
 * The privacy policy is a setting (Settings → Site texts & pages →
 * PRIVACY_POLICY_TEXT). Its placeholders are filled from the settings that
 * rule them — company identity, retention years, card payments, the
 * marketing-mail basis — so the page names what the site really does.
 */
export default async function PrivacyPage() {
  const { facts, contact } = await loadPolicyFacts();
  const blocks = renderPolicyBlocks(settingString('PRIVACY_POLICY_TEXT') || DEFAULT_PRIVACY_POLICY_TEXT, privacyPolicyValues(facts));
  return (
    <LegalShell title="Privacy Policy">
      <PolicyText blocks={blocks} contact={contact} />
    </LegalShell>
  );
}
