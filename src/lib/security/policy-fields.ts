import { defaultPolicy, POLICY_DEFS, POLICY_GROUPS, type PolicyKey, type SecurityPolicy } from '@/lib/security/policy';
import type { PolicyField } from '@/components/admin/SecurityPolicyForm';

/** The security policy as fields for <SecurityPolicyForm> (Settings → Security tab and /admin/settings/security). */
export function buildPolicyFields(policy: SecurityPolicy): PolicyField[] {
  const defaults = defaultPolicy();

  const fields: PolicyField[] = POLICY_DEFS.map((d) => {
    const value = policy[d.key as PolicyKey] as PolicyField['value'];
    const def = defaults[d.key as PolicyKey] as PolicyField['value'];
    return {
      key: d.key,
      group: d.group,
      groupLabel: POLICY_GROUPS[d.group],
      type: d.type,
      label: d.label,
      hint: d.hint,
      value,
      defaultValue: def,
      isDefault: JSON.stringify(Array.isArray(value) ? [...value].sort() : value) === JSON.stringify(Array.isArray(def) ? [...def].sort() : def),
      ...(d.type === 'set' ? { options: d.options } : {}),
      ...(d.type === 'int' ? { min: d.min, max: d.max, unit: d.unit } : {}),
      ...(d.type === 'text' || d.type === 'list' ? { placeholder: d.placeholder } : {}),
    };
  });
  return fields;
}
