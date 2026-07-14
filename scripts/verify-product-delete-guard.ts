/**
 * Offline regression harness — product hard-delete guard (order-history invariant)
 * --------------------------------------------------------------------------------
 * Proves the invariant is COUPLED to production, not just to a fake:
 *   (A) behaviour — drives the REAL deleteOrArchiveProduct for ordered / clean /
 *       P2003-race / non-P2003 cases;
 *   (B) wiring    — static source-contract assertions that the seller, admin and
 *       import-woo files each import + call the shared helper and contain NO
 *       direct product.delete / product.deleteMany path;
 *   (C) category  — asserts the EXPORTED production predicate
 *       EMPTY_CATEGORY_DELETE_WHERE selects `none: {}` (retains ARCHIVED-only
 *       categories, avoiding a Product.categoryId FK violation) and that
 *       import-woo consumes that exact export.
 *
 * Invariant: a Product with ANY OrderItem history is archived, never hard-deleted
 * (OrderItem.productId FK is ON DELETE RESTRICT). The helper is TOCTOU-safe: a
 * delete that races a new OrderItem raises P2003 and is downgraded to archive;
 * non-FK errors propagate.
 *
 * Run: npx tsx scripts/verify-product-delete-guard.ts
 * Exit 0 = guard + wiring + category invariant hold; exit 1 = a regression.
 */
import { readFileSync } from 'node:fs';
import {
  deleteOrArchiveProduct,
  isForeignKeyRestrict,
  EMPTY_CATEGORY_DELETE_WHERE,
  type ProductDeleteDb,
} from '../src/lib/products/delete-guard';

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];
const record = (name: string, ok: boolean, detail: string) => rows.push({ name, ok, detail });

// ── (A) behaviour — exercise the REAL helper ────────────────────────────────
function fakeDb(opts: { orderCount: number; deleteError?: unknown }) {
  const calls = { deleted: false, archived: false };
  const db: ProductDeleteDb = {
    orderItem: { count: async () => opts.orderCount },
    product: {
      update: async () => { calls.archived = true; return {}; },
      delete: async () => { if (opts.deleteError) throw opts.deleteError; calls.deleted = true; return {}; },
    },
  };
  return { db, calls };
}
const P2003 = { code: 'P2003', message: 'FK constraint failed' };
const P2010 = { code: 'P2010', message: 'raw query failed' };

async function behaviour() {
  {
    const { db, calls } = fakeDb({ orderCount: 2 });
    const out = await deleteOrArchiveProduct(db, 'P');
    record('behaviour · ordered → archived', out === 'archived' && calls.archived && !calls.deleted, `out=${out}`);
  }
  {
    const { db, calls } = fakeDb({ orderCount: 0 });
    const out = await deleteOrArchiveProduct(db, 'P');
    record('behaviour · never-ordered → deleted', out === 'deleted' && calls.deleted && !calls.archived, `out=${out}`);
  }
  {
    const { db, calls } = fakeDb({ orderCount: 0, deleteError: P2003 });
    let out = 'threw';
    try { out = await deleteOrArchiveProduct(db, 'P'); } catch { /* recorded below */ }
    record('behaviour · P2003 race → archived (no 500)', out === 'archived' && calls.archived, `out=${out}`);
  }
  {
    const { db, calls } = fakeDb({ orderCount: 0, deleteError: P2010 });
    let threw = false;
    try { await deleteOrArchiveProduct(db, 'P'); } catch { threw = true; }
    record('behaviour · non-FK error propagates', threw && !calls.archived, `threw=${threw}`);
  }
  record('behaviour · isForeignKeyRestrict classifier',
    isForeignKeyRestrict(P2003) && !isForeignKeyRestrict(P2010) && !isForeignKeyRestrict(null), 'P2003/P2010/null');
}

// ── (B) wiring — static source contract for every caller ────────────────────
const HELPER_IMPORT = /from ['"](?:@\/lib\/products\/delete-guard|\.\.\/src\/lib\/products\/delete-guard)['"]/;
const HELPER_CALL = /deleteOrArchiveProduct\s*\(/;
const DIRECT_DELETE = /\bproduct\.delete(?:Many)?\s*\(/; // forbidden in callers

function wiring() {
  const callers = [
    { role: 'seller', file: 'src/app/app/seller/products/actions.ts' },
    { role: 'admin', file: 'src/app/admin/actions.ts' },
    { role: 'import', file: 'prisma/import-woo.ts' },
  ];
  for (const c of callers) {
    const src = readFileSync(c.file, 'utf8');
    const imports = HELPER_IMPORT.test(src);
    const calls = HELPER_CALL.test(src);
    const noDirect = !DIRECT_DELETE.test(src);
    record(`wiring · ${c.role} routes via helper`, imports && calls && noDirect,
      `import=${imports} call=${calls} no-direct-delete=${noDirect}`);
  }
}

// ── (C) category — exported production predicate + import-woo consumption ────
function category() {
  const none = JSON.stringify(EMPTY_CATEGORY_DELETE_WHERE.products?.none ?? null);
  record('category · exported predicate is none:{} (retains ARCHIVED-only)', none === '{}', `products.none=${none}`);
  const importSrc = readFileSync('prisma/import-woo.ts', 'utf8');
  record('category · import-woo consumes EMPTY_CATEGORY_DELETE_WHERE',
    /EMPTY_CATEGORY_DELETE_WHERE/.test(importSrc) && !/none:\s*\{\s*status/.test(importSrc),
    'uses shared export, no inline none:{status}');
}

(async () => {
  await behaviour();
  wiring();
  category();
  const fails = rows.filter((r) => !r.ok).length;
  console.log('product-delete guard matrix (real helper + source-contract + exported predicate)');
  console.log('-----------------------------------------------------------------------------');
  for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(52)} ${r.detail}`);
  console.log('-----------------------------------------------------------------------------');
  if (fails > 0) { console.error(`RESULT: ${fails} failure(s) — guard/wiring/category invariant broken`); process.exit(1); }
  console.log('RESULT: real helper archives ordered (incl. P2003 race) & deletes only clean; seller/admin/import all route through it with no direct delete; exported category predicate retains ARCHIVED-only categories');
  process.exit(0);
})();
