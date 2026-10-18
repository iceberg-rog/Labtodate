import type { SettingDefinitionInput } from '@/lib/settings/defs';
import { HOME_FIELDS, HOME_GROUP_TITLE, homeFieldProblem, type HomeField } from '@/lib/home-sections';

/**
 * Admin settings owned by the homepage (group “Homepage”: stations shown and
 * their order, the items of each station, every visible text, button label and
 * link). Registered in the typed settings registry (src/lib/settings/defs.ts
 * spreads this list), so every key gets validation, the .env fallback and the
 * Change history. The fields themselves (labels, defaults, formats) are listed
 * once in src/lib/home-sections.ts; they are edited on Admin → Homepage (draft,
 * preview, publish), not on the generic settings page. Read them after
 * ensureSettingsLoaded().
 */
const TYPE: Record<HomeField['kind'], SettingDefinitionInput['type']> = {
  line: 'string',
  link: 'string',
  text: 'text',
  list: 'list',
  int: 'int',
};

export const HOME_SETTING_DEFS: readonly SettingDefinitionInput[] = HOME_FIELDS.map((f) => ({
  key: f.key,
  label: `${HOME_GROUP_TITLE[f.group]} — ${f.label}`,
  group: 'Homepage',
  type: TYPE[f.kind],
  hint: f.hint ?? `${f.label} on the homepage.`,
  ...(f.default ? { default: f.default } : {}),
  ...(f.kind === 'text' ? { multiline: true } : {}),
  ...(f.min !== undefined ? { min: f.min } : {}),
  ...(f.max !== undefined ? { max: f.max } : {}),
  optional: true,
  preview: '/',
  validate: (v: string) => homeFieldProblem(f.key, v),
}));
