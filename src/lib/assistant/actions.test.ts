import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ARCHIVE_FILTERS, ARCHIVE_OUTCOME_LABEL, archiveFilterOf, archiveFilterWhere, archiveOutcome, archiveSearchWhere } from './actions';

const ROOT = resolve(__dirname, '../../..');

type Row = { status: string; assignedToId: string | null };

/** Evaluates the subset of Prisma where-clauses archiveFilterWhere produces against one row. */
function matches(where: Record<string, unknown>, row: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => matches(w, row));
    if (k === 'AND') return (v as Record<string, unknown>[]).every((w) => matches(w, row));
    const value = row[k as keyof Row];
    if (v === null || typeof v === 'string') return value === v;
    const op = v as { in?: string[]; notIn?: string[]; not?: null };
    if (op.in) return op.in.includes(value as string);
    if (op.notIn) return !op.notIn.includes(value as string);
    if ('not' in op) return value !== op.not;
    throw new Error(`unexpected clause ${k}`);
  });
}

const ROWS: Row[] = ['AI', 'AWAITING_HUMAN', 'WITH_HUMAN', 'CLOSED', 'ARCHIVED', 'SOMETHING_OLD'].flatMap((status) => [
  { status, assignedToId: null },
  { status, assignedToId: 'staff-1' },
]);

test('each stored status reads as how the chat ended', () => {
  assert.equal(archiveOutcome({ status: 'AWAITING_HUMAN', assignedToId: null }), 'unanswered');
  assert.equal(archiveOutcome({ status: 'AWAITING_HUMAN', assignedToId: 'staff-1' }), 'unanswered');
  assert.equal(archiveOutcome({ status: 'WITH_HUMAN', assignedToId: 'staff-1' }), 'team');
  // The old reply action answered AI-mode chats without moving the status: still answered by the team.
  assert.equal(archiveOutcome({ status: 'AI', assignedToId: 'staff-1' }), 'team');
  assert.equal(archiveOutcome({ status: 'AI', assignedToId: null }), 'ai');
  assert.equal(archiveOutcome({ status: 'CLOSED', assignedToId: 'staff-1' }), 'closed');
  assert.equal(archiveOutcome({ status: 'ARCHIVED', assignedToId: null }), 'ended');
  for (const o of ['unanswered', 'team', 'ai', 'closed', 'ended'] as const) assert.ok(ARCHIVE_OUTCOME_LABEL[o]);
});

test('every filter lists exactly the conversations whose outcome it names', () => {
  const named: Record<string, string[]> = { unanswered: ['unanswered'], team: ['team'], ai: ['ai'], closed: ['closed', 'ended'] };
  for (const f of ARCHIVE_FILTERS) {
    for (const row of ROWS) {
      const expected = f.key === 'all' || named[f.key].includes(archiveOutcome(row));
      assert.equal(matches(archiveFilterWhere(f.key) as Record<string, unknown>, row), expected, `${f.key} ${JSON.stringify(row)}`);
    }
  }
});

test('unknown or missing filter falls back to all; search covers subject, customer and messages', () => {
  assert.equal(archiveFilterOf(undefined), 'all');
  assert.equal(archiveFilterOf('awaiting'), 'all', 'the old live-queue tab names are gone');
  assert.equal(archiveFilterOf('unanswered'), 'unanswered');
  assert.deepEqual(archiveSearchWhere('  '), {});
  const or = (archiveSearchWhere(' pump ') as { OR: Record<string, unknown>[] }).OR;
  assert.equal(or.length, 6);
  assert.deepEqual(or[0], { subject: { contains: 'pump', mode: 'insensitive' } });
});

test('the chat is gone: no widget, no public endpoint, no server actions, no guest cookie', () => {
  assert.ok(!existsSync(join(ROOT, 'src/components/site/Assistant.tsx')), 'the chat widget is deleted');
  assert.ok(!existsSync(join(ROOT, 'src/app/api/assistant')), 'POST /api/assistant no longer exists (404)');
  const archive = readFileSync(join(ROOT, 'src/lib/assistant/actions.ts'), 'utf8');
  assert.doesNotMatch(archive, /^\s*['"]use server['"]/m, 'archive reads are not public server actions');
  assert.doesNotMatch(archive, /\.(create|update|updateMany|upsert|delete|deleteMany)\(/, 'the archive never writes');
  const ai = readFileSync(join(ROOT, 'src/lib/ai.ts'), 'utf8');
  assert.doesNotMatch(ai, /aiChat|lab2date|ASSISTANT_NAME/);
  // Nothing in the app sets the old chat guest cookie any more.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) files.push(p);
    }
  };
  walk(join(ROOT, 'src'));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /cookies?\(\)?\.set\([^)]*lab2_asst_g|GUEST_COOKIE/, f);
    assert.doesNotMatch(src, /@\/components\/site\/Assistant['"]|\/api\/assistant['"]/, f);
  }
});
