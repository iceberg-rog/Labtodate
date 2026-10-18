import type { SettingDefinitionInput } from '@/lib/settings/defs';

/**
 * Admin settings owned by the homepage (group “Homepage”: stations shown and
 * their order, the items of each station, every visible text, button label and
 * link — HOME_* keys). Registered in the typed settings registry
 * (src/lib/settings/defs.ts spreads this list), so every key gets validation,
 * the .env fallback and the Change history. Read them after
 * ensureSettingsLoaded().
 */
export const HOME_SETTING_DEFS: readonly SettingDefinitionInput[] = [];
