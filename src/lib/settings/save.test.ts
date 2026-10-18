import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// saveSettings against an in-memory stand-in for the two tables it writes
// (lib/db.ts re-uses globalThis.__prisma outside production), so the refusal
// rules are checked exactly as the admin form hits them — without a database.
const rows = new Map<string, string>();
const changes: Array<{ key: string; oldValue: string | null; newValue: string | null }> = [];
const fakeDb = {
  setting: {
    findMany: async (args?: { where?: { key?: { in?: string[] } } }) =>
      [...rows].filter(([k]) => !args?.where?.key?.in || args.where.key.in.includes(k)).map(([key, value]) => ({ key, value })),
    deleteMany: async ({ where }: { where: { key: string } }) => ({ count: rows.delete(where.key) ? 1 : 0 }),
    upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
      rows.set(where.key, create.value);
      return {};
    },
  },
  settingChange: {
    createMany: async ({ data }: { data: typeof changes }) => {
      changes.push(...data);
      return { count: data.length };
    },
  },
  invoiceSequence: { findFirst: async () => null, findMany: async () => [] },
};
(globalThis as { __prisma?: unknown }).__prisma = fakeDb;
// The server .env as index.ts snapshots it at boot: none here (the Prisma
// client would otherwise load the worktree's .env), unless a test sets one.
const envDefaults: Record<string, string | undefined> = {};
(globalThis as { __settingEnvDefaults?: unknown }).__settingEnvDefaults = envDefaults;

const load = () => import('./index');

beforeEach(() => {
  rows.clear();
  changes.length = 0;
  for (const k of Object.keys(envDefaults)) delete envDefaults[k];
});

test('a KvK number with letters or 7 digits is refused with the field name; nothing is saved', async () => {
  const { saveSettings } = await load();
  for (const bad of ['1234ABCD', '1234567']) {
    await assert.rejects(saveSettings({ COMPANY_KVK: bad, COMPANY_PHONE: '+31 79 123 4567' }), (e: Error) => {
      assert.match(e.message, /KvK number \(Chamber of Commerce\): a Dutch KvK number is exactly 8 digits/);
      assert.match(e.message, /Nothing was saved\.$/);
      return true;
    });
  }
  assert.equal(rows.size, 0);
  assert.equal(changes.length, 0);
});

test('a valid KvK number is saved and recorded in the change history', async () => {
  const { saveSettings } = await load();
  const r = await saveSettings({ COMPANY_KVK: '1234 5678' });
  assert.deepEqual(r.changedKeys, ['COMPANY_KVK']);
  assert.equal(rows.get('COMPANY_KVK'), '1234 5678');
  assert.deepEqual(changes.map((c) => [c.key, c.oldValue, c.newValue]), [['COMPANY_KVK', null, '1234 5678']]);
});

test('the KvK format follows the VAT home country saved in the same form', async () => {
  const { saveSettings } = await load();
  await saveSettings({ TAX_HOME_COUNTRY: 'DE', COMPANY_KVK: 'HRB 12345' });
  assert.equal(rows.get('COMPANY_KVK'), 'HRB 12345');
  assert.equal(rows.get('TAX_HOME_COUNTRY'), 'DE');
});

test('emptying the KvK number or the legal name once set is refused', async () => {
  const { saveSettings } = await load();
  rows.set('COMPANY_KVK', '12345678');
  rows.set('COMPANY_LEGAL_NAME', 'Labtodate B.V.');
  await assert.rejects(saveSettings({ COMPANY_KVK: '  ' }), /KvK number \(Chamber of Commerce\): required .*Nothing was saved\./);
  await assert.rejects(saveSettings({ __clear_COMPANY_LEGAL_NAME: 'on' }), /Legal company name: required .*Nothing was saved\./);
  // Refused as a whole: the other field of the same submit is not written either.
  await assert.rejects(saveSettings({ COMPANY_LEGAL_NAME: '', COMPANY_PHONE: '+31 79 123 4567' }), /Nothing was saved/);
  assert.equal(rows.get('COMPANY_KVK'), '12345678');
  assert.equal(rows.get('COMPANY_LEGAL_NAME'), 'Labtodate B.V.');
  assert.equal(rows.has('COMPANY_PHONE'), false);
  assert.equal(changes.length, 0);
  // Changing it is fine.
  await saveSettings({ COMPANY_LEGAL_NAME: 'Labtodate Holding B.V.' });
  assert.equal(rows.get('COMPANY_LEGAL_NAME'), 'Labtodate Holding B.V.');
});

test('a required field is not emptied back to a .env value either; a value only in .env stays as it is', async () => {
  const { saveSettings } = await load();
  envDefaults.COMPANY_LEGAL_NAME = 'Labtodate';
  rows.set('COMPANY_LEGAL_NAME', 'Labtodate B.V.');
  await assert.rejects(saveSettings({ COMPANY_LEGAL_NAME: '' }), /Legal company name: required .*Nothing was saved\./);
  assert.equal(rows.get('COMPANY_LEGAL_NAME'), 'Labtodate B.V.');
  // Typing the .env value in is a change like any other (the override goes, the value stays the same).
  await saveSettings({ COMPANY_LEGAL_NAME: 'Labtodate' });
  assert.equal(rows.has('COMPANY_LEGAL_NAME'), false);
  // Now only the .env has it: emptying the field removes nothing and is reported as such.
  const r = await saveSettings({ COMPANY_LEGAL_NAME: '' });
  assert.deepEqual(r.envKept, ['Legal company name']);
  assert.deepEqual(r.changedKeys, []);
});

test('an empty required field that was never set is not a problem (nothing to empty)', async () => {
  const { saveSettings } = await load();
  const r = await saveSettings({ COMPANY_VAT: '', BANK_IBAN: '', COMPANY_PHONE: '+31 79 123 4567' });
  assert.deepEqual(r.changedKeys, ['COMPANY_PHONE']);
});

test('new registry keys save like any other and appear in the change history', async () => {
  const { saveSettings } = await load();
  await saveSettings({ SELLER_PROGRAMME_PUBLIC: 'yes', MESSAGE_MEDIATION_MODE: 'STAFF_REVIEW', ABOUT_PAGE_TEXT: 'About {SITE}.\n\n## Contact\n{CONTACT}' });
  assert.equal(rows.get('SELLER_PROGRAMME_PUBLIC'), 'true');
  assert.deepEqual(changes.map((c) => c.key).sort(), ['ABOUT_PAGE_TEXT', 'MESSAGE_MEDIATION_MODE', 'SELLER_PROGRAMME_PUBLIC']);
  await assert.rejects(saveSettings({ MESSAGE_MEDIATION_MODE: 'SOMETIMES' }), /allowed choices.*Nothing was saved/);
});

test('valueAfterSave: what a key will be once the form is saved', async () => {
  const { valueAfterSave } = await load();
  const current = (k: string) => (k === 'TAX_HOME_COUNTRY' ? 'BE' : '');
  assert.equal(valueAfterSave('TAX_HOME_COUNTRY', {}, current), 'BE');
  assert.equal(valueAfterSave('TAX_HOME_COUNTRY', { TAX_HOME_COUNTRY: 'de' }, current), 'DE');
  assert.equal(valueAfterSave('TAX_HOME_COUNTRY', { TAX_HOME_COUNTRY: '' }, current), 'NL'); // emptied → registry default
  assert.equal(valueAfterSave('TAX_HOME_COUNTRY', { __clear_TAX_HOME_COUNTRY: 'on' }, current), 'NL');
  assert.equal(valueAfterSave('NOT_A_SETTING', { NOT_A_SETTING: 'x' }, current), '');
});
