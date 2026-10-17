/**
 * Find — and on request neutralise — demo content and demo accounts that the
 * seed scripts put into a database: fabricated case studies naming real
 * organisations, fabricated rental facilities, seeded blog/wiki posts, sample
 * testimonials, fake supplier companies with their demo listings, and seed
 * accounts (incl. the ADMIN admin@lab2date.com on a domain we do not own).
 *
 *   npx tsx prisma/audit-seed-content.ts                  # DRY RUN: report only
 *   npx tsx prisma/audit-seed-content.ts --apply          # unpublish / archive / suspend
 *   npx tsx prisma/audit-seed-content.ts --apply --delete # + hard-delete what nothing references
 *   … --keep=wiki,blog                                    # leave those kinds alone
 *   … --json=report.json                                  # also write the report as JSON
 *
 * Precision rules (never touch real data):
 *  - A row is "seed" only when its stable id/slug AND a second field (email,
 *    title, name, website) both match prisma/_seed-fingerprints.ts.
 *  - A row whose slug matches but whose title/email changed is reported as
 *    "seed origin, edited since" and left alone — someone adopted it.
 *  - Importer service accounts (sales@<shop>.import) own REAL imported
 *    listings: reported, never changed.
 *  - Placeholder addresses / settings are reported only.
 * Every change writes an AuditLog row (actor "script:audit-seed-content").
 * Self-contained (only @prisma/client) so it runs in the `setup` image:
 *   docker compose run --rm setup npx tsx prisma/audit-seed-content.ts
 */
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import {
  PLACEHOLDER_EMAIL_RE,
  SEED_ADMIN_USERS,
  SEED_BLOG_POSTS,
  SEED_CASE_STUDIES,
  SEED_COMPANIES,
  SEED_DEMO_USERS,
  SEED_FACILITIES,
  SEED_PRODUCT_SELLER_IDS,
  SEED_TESTIMONIALS,
  SEED_WIKI_ARTICLES,
} from './_seed-fingerprints';

const prisma = new PrismaClient();
const ACTOR = 'script:audit-seed-content';

type Kind = 'case-study' | 'facility' | 'blog' | 'wiki' | 'testimonial' | 'product' | 'company' | 'user';
type Verdict = 'SEED' | 'SEED_EDITED' | 'REPORT_ONLY';

interface Finding {
  kind: Kind;
  verdict: Verdict;
  id: string;
  label: string;
  state: string;
  why: string;
  action?: string;
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DELETE = APPLY && args.includes('--delete');
const KEEP = new Set(
  (args.find((a) => a.startsWith('--keep='))?.slice(7) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const JSON_OUT = args.find((a) => a.startsWith('--json='))?.slice(7) ?? null;

const findings: Finding[] = [];
const add = (f: Finding) => findings.push(f);

async function auditLog(action: string, target: string, meta: string) {
  await prisma.auditLog.create({ data: { actorEmail: ACTOR, action: `seed.audit.${action}`, target, meta: meta.slice(0, 1000) } });
}

/** Try a hard delete; FK restrictions mean "still referenced" → keep the soft action. */
async function tryDelete(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

async function scan() {
  // ── Case studies ──
  for (const fp of SEED_CASE_STUDIES) {
    const row = await prisma.caseStudy.findUnique({ where: { slug: fp.slug } });
    if (!row) continue;
    const exact = row.customer === fp.customer && row.title === fp.title;
    add({
      kind: 'case-study', verdict: exact ? 'SEED' : 'SEED_EDITED', id: row.id, label: `${row.slug} (${row.customer})`, state: row.status,
      why: exact ? 'Fabricated case study from seed-content.ts: invented results credited to a real organisation.' : 'Seed slug, but the title/customer was edited since — left alone; check it is real.',
    });
  }
  // ── Facilities ──
  for (const fp of SEED_FACILITIES) {
    const row = await prisma.labFacility.findUnique({ where: { slug: fp.slug } });
    if (!row) continue;
    const exact = row.name === fp.name;
    add({
      kind: 'facility', verdict: exact ? 'SEED' : 'SEED_EDITED', id: row.id, label: `${row.slug} (${row.name})`, state: row.isPublished ? 'PUBLISHED' : 'HIDDEN',
      why: exact ? 'Fabricated rental facility from seed-content.ts (invented rates and equipment).' : 'Seed slug, but the name was edited since — left alone.',
    });
  }
  // ── Blog ──
  for (const fp of SEED_BLOG_POSTS) {
    const row = await prisma.blogPost.findUnique({ where: { slug: fp.slug } });
    if (!row) continue;
    const exact = row.title === fp.title && row.authorId === 'seed_user_admin';
    add({
      kind: 'blog', verdict: exact ? 'SEED' : 'SEED_EDITED', id: row.id, label: row.slug, state: row.status,
      why: exact
        ? `Seeded blog post written as if by lab2date: ${fp.claim}.`
        : 'Seed slug, but title/author changed since — left alone.',
    });
  }
  // ── Wiki ──
  for (const fp of SEED_WIKI_ARTICLES) {
    const row = await prisma.wikiArticle.findUnique({ where: { slug: fp.slug } });
    if (!row) continue;
    const exact = row.title === fp.title && row.authorId === 'seed_user_admin';
    add({
      kind: 'wiki', verdict: exact ? 'SEED' : 'SEED_EDITED', id: row.id, label: row.slug, state: row.status,
      why: exact ? 'Seeded wiki article (generic text) published under the seed admin account — review before re-publishing.' : 'Seed slug, edited since — left alone.',
    });
  }
  // ── Testimonials ──
  const testimonials = await prisma.testimonial.findMany();
  for (const t of testimonials) {
    const fp = SEED_TESTIMONIALS.find((f) => f.author === t.author && t.quote.startsWith(f.quoteStart));
    if (!fp) continue;
    add({ kind: 'testimonial', verdict: 'SEED', id: t.id, label: `${t.author} (${t.company ?? '—'})`, state: t.published ? 'PUBLISHED' : 'HIDDEN', why: 'Sample testimonial: invented person quoted at a real organisation.' });
  }
  // ── Demo products (by the seed sellers) ──
  const products = await prisma.product.findMany({
    where: { sellerId: { in: [...SEED_PRODUCT_SELLER_IDS] } },
    select: { id: true, slug: true, status: true, sellerId: true, _count: { select: { orderItems: true } } },
  });
  for (const p of products) {
    add({
      kind: 'product', verdict: 'SEED', id: p.id, label: p.slug, state: `${p.status}${p._count.orderItems ? `, ${p._count.orderItems} order line(s)` : ''}`,
      why: `Demo listing created by the seed account ${p.sellerId} — not a real unit for sale.`,
    });
  }
  // ── Fake supplier companies ──
  for (const fp of SEED_COMPANIES) {
    const row = await prisma.company.findUnique({
      where: { slug: fp.slug },
      select: { id: true, name: true, website: true, isFeatured: true, isVerified: true, _count: { select: { products: true, users: true, facilities: true } } },
    });
    if (!row) continue;
    const exact = row.website === fp.website && row.name === fp.name;
    add({
      kind: 'company', verdict: exact ? 'SEED' : 'SEED_EDITED', id: row.id, label: `${fp.slug} (${row.name})`,
      state: `${row.isFeatured ? 'featured' : 'not featured'}, ${row.isVerified ? 'verified' : 'not verified'}, ${row._count.products} product(s), ${row._count.users} user(s), ${row._count.facilities} facilit(ies)`,
      why: exact ? 'Fake supplier from seed.ts (placeholder .example website).' : 'Seed slug, but name/website changed since — left alone.',
    });
  }
  // ── Seed accounts ──
  for (const fp of [...SEED_ADMIN_USERS, ...SEED_DEMO_USERS]) {
    const row = await prisma.user.findUnique({ where: { id: fp.id }, select: { id: true, email: true, role: true, suspendedAt: true, adminCaps: true } });
    if (!row) continue;
    const exact = row.email.toLowerCase() === fp.email.toLowerCase();
    add({
      kind: 'user', verdict: exact ? 'SEED' : 'SEED_EDITED', id: row.id, label: row.email,
      state: `${row.role}${row.adminCaps.length ? ` caps=[${row.adminCaps.join(',')}]` : ''}${row.suspendedAt ? ', suspended' : ''}`,
      why: exact
        ? row.role === 'ADMIN'
          ? `Seed ADMIN account on ${row.email.split('@')[1]} (a domain this business does not use): whoever receives mail there could sign in by magic link.`
          : 'Seed demo account.'
        : 'Seed id, but the email was changed since — left alone; check who uses it.',
    });
  }
  // ── Report only: importer service accounts + placeholder addresses ──
  const importers = await prisma.user.findMany({
    where: { id: { startsWith: 'seed_user_seller_' }, email: { endsWith: '.import' } },
    select: { id: true, email: true, _count: { select: { productsOwned: true } } },
  });
  for (const u of importers) {
    add({ kind: 'user', verdict: 'REPORT_ONLY', id: u.id, label: u.email, state: `${u._count.productsOwned} product(s)`, why: 'Importer service account: owns real imported listings — kept. It has no password and its address cannot receive mail.' });
  }
  const known = new Set<string>([...[...SEED_ADMIN_USERS, ...SEED_DEMO_USERS].map((u): string => u.id), ...importers.map((u) => u.id)]);
  const others = await prisma.user.findMany({ select: { id: true, email: true, role: true } });
  for (const u of others) {
    if (known.has(u.id) || !PLACEHOLDER_EMAIL_RE.test(u.email)) continue;
    add({ kind: 'user', verdict: 'REPORT_ONLY', id: u.id, label: u.email, state: u.role, why: 'Account with a placeholder / test / non-company address — not touched; review by hand.' });
  }
  const settings = await prisma.setting.findMany({ where: { key: { in: ['COMPANY_EMAIL', 'SUPPORT_EMAIL', 'EMAIL_FROM', 'QUOTE_INTAKE_EMAIL', 'SELL_INTAKE_EMAIL', 'SUPPORT_INTAKE_EMAIL'] } } });
  for (const s of settings) {
    if (PLACEHOLDER_EMAIL_RE.test(s.value.trim())) {
      add({ kind: 'user', verdict: 'REPORT_ONLY', id: `setting:${s.key}`, label: `${s.key} = ${s.value}`, state: 'setting', why: 'Setting holds a placeholder address that cannot receive mail — fix it in Admin → Settings.' });
    }
  }
}

async function apply() {
  const seed = findings.filter((f) => f.verdict === 'SEED' && !KEEP.has(f.kind));
  const now = new Date();
  // Content first, then facilities and products, then users, then (now empty) companies.
  const order: Kind[] = ['case-study', 'testimonial', 'blog', 'wiki', 'facility', 'product', 'user', 'company'];
  for (const kind of order) {
    for (const f of seed.filter((x) => x.kind === kind)) {
      switch (kind) {
        case 'case-study':
          if (DELETE && (await tryDelete(() => prisma.caseStudy.delete({ where: { id: f.id } })))) f.action = 'deleted';
          else {
            await prisma.caseStudy.update({ where: { id: f.id }, data: { status: 'DRAFT', publishedAt: null } });
            f.action = 'unpublished (draft)';
          }
          break;
        case 'testimonial':
          if (DELETE && (await tryDelete(() => prisma.testimonial.delete({ where: { id: f.id } })))) f.action = 'deleted';
          else {
            await prisma.testimonial.update({ where: { id: f.id }, data: { published: false } });
            f.action = 'hidden';
          }
          break;
        case 'blog':
          if (DELETE && (await tryDelete(() => prisma.blogPost.delete({ where: { id: f.id } })))) f.action = 'deleted (with its comments)';
          else {
            await prisma.blogPost.update({ where: { id: f.id }, data: { status: 'DRAFT', publishedAt: null } });
            f.action = 'unpublished (draft)';
          }
          break;
        case 'wiki':
          if (DELETE && (await tryDelete(() => prisma.wikiArticle.delete({ where: { id: f.id } })))) f.action = 'deleted';
          else {
            await prisma.wikiArticle.update({ where: { id: f.id }, data: { status: 'DRAFT', publishedAt: null } });
            f.action = 'unpublished (draft)';
          }
          break;
        case 'facility':
          if (DELETE && (await tryDelete(() => prisma.labFacility.delete({ where: { id: f.id } })))) f.action = 'deleted';
          else {
            await prisma.labFacility.update({ where: { id: f.id }, data: { isPublished: false } });
            f.action = 'hidden';
          }
          break;
        case 'product': {
          // Only a listing nothing points at is deleted: order lines (RESTRICT),
          // quotes, message threads and reviews keep it (archived instead), so
          // no buyer's history is detached by a SET NULL.
          const refs = await prisma.product.findUnique({
            where: { id: f.id },
            select: { _count: { select: { orderItems: true, sourcingRequests: true, threads: true, reviews: true } } },
          });
          const unreferenced = !!refs && Object.values(refs._count).every((n) => n === 0);
          if (DELETE && unreferenced && (await tryDelete(() => prisma.product.delete({ where: { id: f.id } })))) f.action = 'deleted';
          else {
            await prisma.product.update({ where: { id: f.id }, data: { status: 'ARCHIVED' } });
            f.action = 'archived';
          }
          break;
        }
        case 'company': {
          // Company FKs are SET NULL: deleting a company that still has products,
          // users or facilities would silently re-label them — only delete an empty one.
          const c = await prisma.company.findUnique({
            where: { id: f.id },
            select: { _count: { select: { products: true, users: true, facilities: true } } },
          });
          const empty = !!c && c._count.products + c._count.users + c._count.facilities === 0;
          const deleted = DELETE && empty && (await tryDelete(() => prisma.company.delete({ where: { id: f.id } })));
          if (deleted) f.action = 'deleted';
          else {
            await prisma.company.update({ where: { id: f.id }, data: { isFeatured: false, isVerified: false, verifiedAt: null } });
            f.action = 'unfeatured + unverified';
          }
          break;
        }
        case 'user': {
          const deleted = DELETE && (await tryDelete(() => prisma.user.delete({ where: { id: f.id } })));
          if (deleted) {
            f.action = 'deleted';
          } else {
            await prisma.$transaction([
              prisma.session.deleteMany({ where: { userId: f.id } }),
              prisma.account.deleteMany({ where: { userId: f.id } }),
              prisma.user.update({
                where: { id: f.id },
                data: { role: 'BUYER', adminCaps: [], suspendedAt: now, suspendedReason: 'Seed/demo account disabled by audit-seed-content' },
              }),
            ]);
            f.action = 'suspended, demoted to BUYER, sessions + logins removed';
          }
          break;
        }
      }
      await auditLog(kind, f.label, `${f.action} — ${f.why}`);
    }
  }
}

function print() {
  const groups: [Verdict, string][] = [
    ['SEED', APPLY ? 'Seed rows — handled' : 'Seed rows — would be handled with --apply'],
    ['SEED_EDITED', 'Seed origin, edited since — LEFT ALONE (check by hand)'],
    ['REPORT_ONLY', 'Report only — never changed by this script'],
  ];
  console.log(`\naudit-seed-content — ${APPLY ? (DELETE ? 'APPLY + DELETE' : 'APPLY') : 'DRY RUN (nothing changed)'}${KEEP.size ? ` · keeping: ${[...KEEP].join(', ')}` : ''}\n`);
  for (const [v, title] of groups) {
    const rows = findings.filter((f) => f.verdict === v);
    console.log(`── ${title}: ${rows.length}`);
    for (const f of rows) {
      const kept = v === 'SEED' && KEEP.has(f.kind) ? ' [kept: --keep]' : '';
      console.log(`  [${f.kind}] ${f.label} — ${f.state}${f.action ? ` → ${f.action}` : kept}\n      ${f.why}`);
    }
    console.log('');
  }
  if (!APPLY) {
    const n = findings.filter((f) => f.verdict === 'SEED' && !KEEP.has(f.kind)).length;
    console.log(`Dry run. ${n} seed row(s) found. Run again with --apply to unpublish/archive/suspend them${n ? ' (add --delete to remove what nothing references)' : ''}.`);
  }
}

async function main() {
  await scan();
  if (APPLY) await apply();
  print();
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ mode: APPLY ? (DELETE ? 'apply+delete' : 'apply') : 'dry-run', at: new Date().toISOString(), findings }, null, 2));
    console.log(`Report written to ${JSON_OUT}`);
  }
}

main()
  .catch((e) => {
    console.error('audit-seed-content failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
