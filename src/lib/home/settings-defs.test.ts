import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_GROUPS, SETTING_DEFS, normaliseInput, settingDef, validateSettingValue } from '@/lib/settings/defs';
import { HOME_FIELDS } from '@/lib/home-sections';
import { HOME_SETTING_DEFS } from './settings-defs';

test('every homepage field is a registry setting in the Homepage group (validation, history, revert)', () => {
  assert.equal(HOME_SETTING_DEFS.length, HOME_FIELDS.length);
  for (const f of HOME_FIELDS) {
    const d = settingDef(f.key);
    assert.ok(d, f.key);
    assert.equal(d.group, 'Homepage', f.key);
    assert.equal(d.optional, true, `${f.key}: empty = the default`);
    assert.equal(d.default ?? '', f.default, f.key);
    assert.equal(validateSettingValue(d, normaliseInput(d, f.default)), null, f.key);
  }
  // labels name the station, so the Change history reads on its own
  assert.equal(settingDef('HERO_TITLE')?.label, 'Hero — Title');
  assert.equal(settingDef('HOME_CAT_ITEMS')?.label, 'Instruments — Categories on the station');
  assert.equal(new Set(HOME_SETTING_DEFS.map((d) => d.label)).size, HOME_SETTING_DEFS.length, 'labels are unique');
});

test('the registry runs the homepage validators', () => {
  const v = (k: string, raw: string) => validateSettingValue(settingDef(k)!, normaliseInput(settingDef(k)!, raw));
  assert.match(v('HOME_STATIONS', 'hero, intro') ?? '', /comes first/);
  assert.match(v('HOME_HERO_SOURCE', 'Source it|//evil.example') ?? '', /not a link/);
  assert.match(v('HOME_CAT_MAX', '40') ?? '', /at most 12/);
  assert.equal(v('HOME_EXTRAS', 'testimonials, featured'), null);
});

test('homepage keys are edited on Admin → Homepage, not as generic fields on the settings page', () => {
  assert.ok(PANEL_GROUPS.includes('Homepage'));
  assert.ok(SETTING_DEFS.filter((d) => d.group === 'Homepage').length >= 60);
});
