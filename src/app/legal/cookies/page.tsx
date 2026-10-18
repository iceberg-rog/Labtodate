import { LegalShell } from '@/components/site/LegalShell';
import { PolicyText } from '@/components/site/PolicyText';
import { loadPolicyFacts } from '@/lib/legal/policy-facts';
import { cookiePolicyValues, renderPolicyBlocks } from '@/lib/legal/policy-text';
import { settingString } from '@/lib/settings';
import { DEFAULT_COOKIE_POLICY_TEXT } from '@/lib/settings/page-texts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cookie Policy' };

/**
 * The cookie policy is a setting (Settings → Site texts & pages →
 * COOKIE_POLICY_TEXT). The default lists the cookies the site sets: the
 * sign-in session, its short-lived cache and the two-step sign-in cookie.
 * The on-site chat and its guest cookie are gone (support runs on tickets).
 */
export default async function CookiesPage() {
  const { facts, contact } = await loadPolicyFacts();
  const blocks = renderPolicyBlocks(settingString('COOKIE_POLICY_TEXT') || DEFAULT_COOKIE_POLICY_TEXT, cookiePolicyValues(facts));
  return (
    <LegalShell title="Cookie Policy">
      <PolicyText blocks={blocks} contact={contact} />
    </LegalShell>
  );
}
