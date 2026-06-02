# Browser Audit — 2026-05-29 (real production session)

**Site:** https://labtodate.com  **Front proxy:** nginx/1.26.3 (Ubuntu), no CDN.
**Session used:** the owner's own ADMIN account (Hossein Hashiri /
iceberg.rig@gmail.com). **No production data was created or modified.**

Evidence = live navigation + network logs + screenshots (held in the browser
session). Console-message capture was unreliable this pass, so any hydration
claim is "observed-clean, NOT certified".

> RULE HONOURED: nothing below is marked VERIFIED unless a real browser session
> actually exercised it. State-changing and non-admin-role flows were NOT run
> and remain UNVERIFIED pending magic-links + a designated test product.

---

## 1. Reliability / Performance

### BUG-015 · P1 · RSC prefetch 503 (infra, load-dependent) — DIAGNOSED
- Next.js `<Link>` prefetch requests (`?_rsc=…`) return **503** for a *fraction*
  of each page-load batch; full navigations of the same routes return **200**.
- **Not route-specific:** the same URL flips 200↔503 across batches
  (`/`, `/marketplace`, `/legal/cookies` all observed both ways).
- **Scales with batch size:** 12-request batches lost ~2; a 20-request batch
  lost ~10. A single `_rsc` fetch → 200 (`text/x-component`). 14 concurrent
  fetches to ONE cheap route → all 200.
- **No 503 code exists in `src/`.** Emitter is nginx in front of the single
  Next standalone process.
- **Root cause (high confidence):** upstream saturation — many concurrent
  server-component renders queue behind one Node event loop; nginx 503s the
  connections it can't proxy.
- **Fix (infra, deploy host):** nginx upstream keepalive + `proxy_http_version
  1.1`; raise `worker_connections`; relax/exclude any `limit_conn`/`limit_req`
  returning 503; and/or run 2–4 Next replicas; and/or micro-cache `_rsc` GETs of
  public routes; and/or reduce homepage Link prefetch pressure.
- **Impact:** degraded perceived navigation + 503 log noise. NOT a correctness
  or data blocker.

---

## 2. Content / Media

### BUG-016 · P2 · Blog cover images 403 (infra) — DIAGNOSED
- `/media/lab2date-media/blog-cover/*.jpg` → **403** with a MinIO
  `AccessDenied` XML body (served via nginx). The `/media/*`→MinIO rewrite
  resolves; the `lab2date-media` bucket lacks an anonymous-read policy for the
  `blog-cover/` objects.
- External product images (lab2.nl, conquerscientific.com) load fine.
- **Impact: low/cosmetic** — blog grid degrades to designed gradient
  placeholders (no broken-image icons).
- **Fix (infra):** `mc anonymous set download` on the bucket/prefix, re-upload
  missing covers, or serve via an authenticated proxy with a public exception.

---

## 3. Business-logic / data quality (read-only observations)

These are EXISTING records (the round-1/2 code fixes prevent NEW occurrences;
they don't retro-clean history). Mutations require user approval + the
cleanup SQL.

- **Address-less / fulfilment-less DELIVERED order:** `L2D-2026-TATSIL`
  (€12,345) shows status DELIVERED with an empty fulfilment column ("—").
  Exactly the class BUG-009 now blocks going forward.
- **Junk test data in production:** several orders carry placeholder addresses
  ("sdvsdv … NL"; Arabic placeholder text) and junk tracking numbers
  (e.g. `iuh987987987979hjg8765876`). Candidates for `scripts/cleanup-dry-run.sql`.
- **Quote→order conversion confirmed:** the "Quote-only — no fixed price"
  Shimadzu RF-5301PC product has a €4,000 paid order — flow works.
- **BUG-014 (payment.method "—")** NOT yet confirmed at detail level — the
  order-detail/payment view sits behind a control not reached this pass.
  Deferred to the next phase.

---

## 4. UX / manual-payment posture
- Homepage, marketplace, product detail, blog, /admin, /admin/orders all render
  correctly (200) under full navigation.
- Cookie banner is essential-only ("no tracking or ads") — privacy-friendly.
- `/admin` Overview shows live timestamp + "Errors 24h: 0" with no visible
  hydration crash → **BUG-012 fix appears to hold** (observed, not certified).
- Manual-payment copy correctness on the buyer checkout/success path was NOT
  re-walked here (cart was empty); deferred to the write phase.

---

## 5. B1–B17 status matrix

| Item | What it needs | Status |
|---|---|---|
| B1 (anon browse part) | none | observed OK (sign-up part = prohibited for agent) |
| B2 cart preserved on refresh | a non-empty cart (write) | UNVERIFIED |
| B3 multi-tab over-qty | writes | UNVERIFIED |
| B4/B5 checkout back/expiry | Stripe off (manual posture) + writes | UNVERIFIED |
| B6 payment-proof persist | write + test order | UNVERIFIED (needs go-ahead) |
| B7 buyer reads other's order | BUYER session | BLOCKED (magic-link) |
| B8 seller direct-publish | SELLER session | BLOCKED (magic-link) |
| B9 cross-seller edit | SELLER session | BLOCKED (magic-link) |
| B10 admin-without-cap refund | limited-cap admin | BLOCKED (magic-link) |
| B11 duplicate-submit checkout | write + test product | UNVERIFIED (needs go-ahead) |
| B12 /checkout/success reload race | write | UNVERIFIED |
| B13 notif mark-read multi-tab | writes/notifs | UNVERIFIED |
| B14 sign-out tab-sync | sign out live session | NOT DONE (would strand session) |
| B15 password-reset reuse | email inbox | BLOCKED |
| B16 magic-link expiry | email inbox | BLOCKED |
| B17 suspended sign-in | a suspended test account | BLOCKED |

---

## 6. What I need to finish the audit
1. **Magic-link sign-in URLs** for: a BUYER (non-admin), a SELLER (non-admin),
   and a LIMITED-CAP admin test account → unlocks B7–B10, B17.
2. **A designated TEST product** I may transact against, plus your standing
   go-ahead to create clearly-labelled TEST records (I'll still confirm each
   irreversible click) → unlocks B2–B6, B11–B13 and BUG-014 confirmation.
3. (Optional) email-inbox access (e.g. the Mailpit Ui on :8025, or forwarded
   links) → unlocks B15/B16 and email-content checks.

Until then: **no item is marked VERIFIED.** BUG-015 and BUG-016 are diagnosed
infra issues for the deploy host (no app-code change).
