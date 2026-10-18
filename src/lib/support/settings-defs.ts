import type { SettingDefinitionInput } from '@/lib/settings/defs';

/**
 * Admin settings owned by the support-ticket area (group “Support”: topics,
 * SLA per priority, business hours, response-time text, VIP rules, magic-link
 * and reopen periods, rate limits). Registered in the typed settings registry
 * (src/lib/settings/defs.ts spreads this list), so every key gets validation,
 * the .env fallback and the Change history. Read them after
 * ensureSettingsLoaded().
 */
export const SUPPORT_SETTING_DEFS: readonly SettingDefinitionInput[] = [];
