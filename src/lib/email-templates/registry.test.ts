import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMAIL_DEFS } from './registry';
import { checkEmailTexts } from './send';
import { COMMON_EMAIL_FIELDS } from './types';

const LANGS = ['en', 'nl'] as const;
const GROUPS = new Set(['Quotes', 'Orders & payments', 'Support', 'Selling to us', 'Account & security', 'Messages']);
const KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

test('every e-mail key is unique snake_case', () => {
  const seen = new Set<string>();
  for (const def of EMAIL_DEFS) {
    assert.match(def.key, KEY, `bad key "${def.key}"`);
    assert.ok(!seen.has(def.key), `duplicate key "${def.key}"`);
    seen.add(def.key);
  }
});

for (const def of EMAIL_DEFS) {
  test(`e-mail "${def.key}"`, () => {
    assert.ok(GROUPS.has(def.group), `unknown group "${def.group}"`);
    assert.ok(def.label.trim(), 'label is empty');
    assert.ok(def.when.trim(), '"when" is empty');

    const names = def.fields.map((f) => f.name);
    assert.equal(new Set(names).size, names.length, 'a field is listed twice');
    const common = new Set(COMMON_EMAIL_FIELDS.map((f) => f.name));
    for (const f of def.fields) {
      assert.ok(!common.has(f.name), `field ${f.name} repeats a common field`);
      assert.ok(f.label.trim() && f.example.trim(), `field ${f.name} needs a label and an example`);
    }
    if (def.buttonLink) assert.ok(names.includes(def.buttonLink), `buttonLink ${def.buttonLink} is not one of the fields`);

    for (const lang of LANGS) {
      const texts = def.defaults[lang];
      assert.ok(texts, `no ${lang} defaults`);
      assert.deepEqual(checkEmailTexts(def, texts), [], `${lang} defaults have problems`);
      if (texts.button.trim()) assert.ok(def.buttonLink, `${lang} has a button label but the e-mail has no buttonLink`);
    }
    // Both languages offer the same button (or both none).
    assert.equal(!!def.defaults.en.button.trim(), !!def.defaults.nl.button.trim(), 'en and nl disagree on having a button');
  });
}
