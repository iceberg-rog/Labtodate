# Business core — integration guide (wave 1, foundation)

This branch adds the foundation every business rule builds on: a typed
settings registry, migration `4_business_core`, and six core libraries. This
page tells Stage 2 how to use them. Rule of thumb: **never re-implement a rule
that already exists here — call the library, and read every business value
through the settings registry.**

```
src/lib/settings/      typed settings registry + change history         (B00)
src/lib/tax/           VAT engine, VIES, order VAT resolution            (A01/B01)
src/lib/documents/     numbering, snapshots, issuing, stored PDFs        (A02–A05/B02)
src/lib/pricing/       single sell-price resolver                        (A07/A08/B05)
src/lib/shipping/      zones/rates shipping quote                        (A11/B12)
src/lib/compliance/    country ALLOW/REVIEW/BLOCK policy                 (A12/B13)
src/lib/stock/         stock reservations                                (A09/B28)
src/lib/payments/      payments ledger                                   (B06)
```

Tests: `npm test` (47 pure unit tests) and `npm run test:db` (10 DB
integration tests — local/test databases only, they create undeletable rows).

---

## 1. Settings registry — `@/lib/settings`

* Every rule is a `SettingDefinition` in `src/lib/settings/defs.ts`:
  `key, label, group, type, default, options, min/max, hint, effect,
  sensitive, pending, validate`.
* Effective value: **DB row (Admin → Settings) > server .env > `default`**.
* Server code: `await ensureSettingsLoaded()` once per request, then the sync
  typed getters:

  ```ts
  import { ensureSettingsLoaded, settingInt, settingBool, settingEnum, settingPercentBp, settingList, settingString } from '@/lib/settings';
  await ensureSettingsLoaded();
  const days = settingInt('PAYMENT_TERM_DAYS', 14);
  const policy = settingEnum<'NEVER' | 'ONLY_IF_NOT_SHIPPED' | 'ALWAYS'>('AUTO_RESTOCK_ON_REFUND');
  const rateBp = settingPercentBp('TAX_STANDARD_RATE_PCT');   // "21" → 2100
  ```
  Old code reading `process.env.X` keeps working (DB values are hydrated).
* **Adding a setting**: add one entry to `defs.ts` (group, type, default,
  hint). The admin page renders it automatically, validates it, records
  every change in `SettingChange` (Change history tab, with Revert).
* **`pending`**: a setting whose consumer is not built yet shows
  “Saved now, not applied yet — takes effect with …”. **When you wire a
  pending setting, delete its `pending` field in the same commit.** Still
  pending after stage 2 (s2a + s2b + s2c): `PAYMENT_REQUIRE_AMOUNT_ON_VERIFY`,
  `UNDERPAYMENT_TOLERANCE_CENTS` (`SHIPPING_REQUIRE_TRACKING_TO_SHIP` is wired
  by s2c, §13).
  Wired by checkout (s2a): `PRICE_DISPLAY_MODE`, all `SHIPPING_*` zone
  settings, `POST_PAYMENT_ADDRESS_CHANGE`, `COMPLIANCE_UNKNOWN_COUNTRY_POLICY`,
  `SALES_MODE`, `B2B_DECLARATION_TEXT`, `B2B_REQUIRE_COMPANY_AND_ID`. Wired by
  quotes / payment page (s2b): `PAYMENT_TERM_DAYS`, `PAYMENT_GRACE_DAYS`,
  `AUTO_CANCEL_UNPAID`, `CREDIT_TERMS_ENABLED`, `CREDIT_DEFAULT_TERM_DAYS`,
  `STOCK_RESERVE_ON`, `RESERVATION_HOLD_DAYS`, `SHOW_RESERVED_BADGE` (plus the
  new “Quotes & offers” group, `lib/quotes/settings-defs.ts`).
  `DETAILS_VAT_ID_REQUIRED` (s2b) is applied at checkout too (s2a's VAT ID
  field), so a checkout order is never blocked later on the payment page.
* Interim flat values: no pricing reads them any more — checkout (s2a) and
  quote offers (s2b) both use the VAT engine. `DEFAULT_TAX_PERCENT` is only
  read by the documents' legacy CHARGED path (`lib/documents/issue.ts` →
  `chargedVat`) to print orders priced before the VAT rules; delete it once no
  such unpaid / un-invoiced orders remain. `DEFAULT_SHIPPING_CENTS` is the
  amount of `SHIPPING_MODE = FLAT` (checkout only); offers prefill
  `OFFER_DEFAULT_SHIPPING_CENTS`. `PROFORMA_VALID_DAYS` and
  `ORPHAN_ORDER_TTL_MINUTES` are retired (one due-date rule, §12).

## 2. VAT engine — `@/lib/tax`

* `determineVat(ctx, settings, countries)` (`determine.ts`) is **pure**. Inputs:
  ship-to country, billing country, customer kind, VAT-ID evidence (VIES
  result), lines (`netCents`, `lineType`, `scheme`). Output: `treatment`,
  `rateBp`, per-line rate/tax, per-rate `breakdown`, `legalText`,
  `buyerVatIdRequired`, `reviewRequired`, `blocked`, `reasons[]`.
* Settings/country facts: `loadTaxSettings()`, `loadCountryFacts()` (`settings.ts`).
* VIES: `checkVatId(raw)` (`vies.ts`) — cached in `VatValidation`
  (TAX_VIES_CACHE_HOURS), every answer kept as evidence incl. consultation
  number; `setViesClient()` to stub. Never call it inside a DB transaction.
* For an existing order: `resolveOrderVat(order)` (`order.ts`) → `RECORDED`
  (engine-priced order), `MATCH`, `MISMATCH`, `UNDETERMINED`.

**Checkout / offers (Stage 2) must:** call `determineVat` when pricing (cart,
checkout, offer send, acceptance), charge `decision.taxCents` on goods **and
shipping**, and persist on the Order: `vatTreatment`, `vatRateBp`,
`vatDecidedAt`, `vatNote` (= reasons), `buyerVatId`, `viesCheck`; per line
`OrderItem.vatRateBp/taxCents`. Refuse `blocked`; put `reviewRequired` orders
on `holdReason = VAT_REVIEW` without a payment request. Then remove the
`pending` flags above and retire `DEFAULT_TAX_PERCENT`.

## 3. Fiscal documents — `@/lib/documents/issue`

| Function | What it does |
|---|---|
| `issueProforma(orderId, { tx?, actorId?, dueDate? })` | current proforma (PF series), idempotent. With `tx` it runs in your transaction (no VIES call, PDF rendered after commit). |
| `reissueProforma(orderId, reason)` | new revision `PF-…-r2`, old one `supersededById`. Use after amounts/addresses change before payment. |
| `voidProformas(orderId, reason, tx?)` | void open proformas (a DB trigger also does this whenever an order becomes CANCELED). |
| `issueInvoice(orderId, { actorId })` | the tax invoice (INV series), once per order, only when paid / approved on terms. Runs `resolveOrderVat` + legal-details check; on mismatch (policy BLOCK) returns `VAT_REVIEW` and sets `Order.holdReason/holdNote`. |
| `issueCreditNote({ orderId, amountCents?, reason, refundMethod?, tx? })` | CN series against the order’s invoice (full = negated lines; partial = gross amount split over the invoice’s VAT rows). Content comes from the invoice snapshot. |
| `freezeLegacyDocuments(orderId)` | freezes pre-cutover documents under their old numbers (series LEGACY). |
| `ensureDocumentPdf(docId)` | renders the PDF once from the snapshot, stores it (S3 `documents/…`, sha256 in the row); later calls return the stored bytes after an integrity check. |
| `documentAttachment(doc)` / `markDocumentSent(docId)` | email attachment from the stored bytes; first send time. |
| `getOrderDocuments(orderId)` | `{ proforma, proformaHistory, invoice, creditNotes }`. |

* `sendOrderInvoice(orderId)` (`@/lib/orders/internal`) = issue + email + admin
  notification when not issued. Use it wherever an order becomes paid.
* Links (client-safe, `@/lib/documents`): `documentHref('proforma'|'invoice'|'credit-note', orderNumber, 'pdf'|'preview')`,
  `documentNumberHref(number)`. UI: `<OrderDocumentsPanel order audience="buyer"|"admin" />`.
* **Immutability is enforced by the database** (migration 4 triggers): no
  UPDATE of number/dates/amounts/snapshot, PDF key written once, no DELETE or
  TRUNCATE, only proformas can be voided, number series never go backwards.
  Corrections = credit note (invoice) or new revision (proforma).
* Numbering: `allocateNumber(tx, series, date, settings)` — only inside the
  transaction that inserts the document (gap-free).
* Every value printed comes from the snapshot (`snapshot.ts`, versioned
  `v: 1`). If you add printed content, add it to the snapshot and keep the
  renderer able to render older versions.

**Stage 2 (fiscal & quotes) next steps:** proforma revision when billing
details are added before payment (call `reissueProforma`); admin VAT-review
screen that records the decision on the order and calls
`issueOrderInvoiceAction`; partial refunds (`issueCreditNote` with
`amountCents`); finance registers read `FiscalDocument`.

## 4. Pricing — `@/lib/pricing/resolve`

`resolveSellPrice(product, shop, { rounding })` → `{ basePriceCents,
sellPriceCents, appliedMarkupBp, mode, priceVisible, buyable, quotable,
soldOut, reasons }`; `assertBuyable(r)` for server actions. FORCE_QUOTE and
HIDE_PRICE are never buyable. **Stage 2:** use it on PDP, cards, search,
cart, both checkouts, Stripe lines, quote prefill, and snapshot
`OrderItem.basePriceCents/appliedMarkupBp`; replace `applyShopPricing`.

## 5. Shipping — `@/lib/shipping`

`quoteShippingFor(country, lines, currency)` (`load.ts`; pure core
`quoteShipping` in `quote.ts`) → `QUOTED { amountCents, parts, leadTimeText }`
| `TO_BE_CONFIRMED` | `NOT_SHIPPABLE`. Lines: `{ qty, shippingClass, weightKg, valueCents }`
(Product has `shippingClass`, `weightKg`). Zones/rates are edited in Admin →
Settings → Shipping. A `TO_BE_CONFIRMED` order must not get a payment
request until staff set the freight (`holdReason = SHIPPING_PENDING`).
`Shipment` rows record dispatches (carrier, tracking, parcels, insured, POD).

## 6. Country policy — `@/lib/compliance/country`

`checkCountry(code)` → `{ mode: ALLOW|REVIEW|BLOCK, reason, isEu, … }`;
`countryOptions()` for address selects; `stripeAllowedCountries()` for Stripe
Checkout. **Stage 2:** call `checkCountry` in all four address write paths
(both checkouts, payment-page address, admin address edit); REVIEW →
`holdReason = COMPLIANCE`; BLOCK → refuse with `reason`.

## 7. Stock — `@/lib/stock/reserve`

`reserveStock({ productId, qty, source, refId, orderId?, expiresAt? }, tx?)`
(guarded decrement + hold, idempotent), `releaseReservation(where, reason,
tx?)` (restocks exactly once), `consumeReservation(where, tx?)` (sold),
`releaseExpiredReservations()` (cron), `reservationExpiry()`.
`Product.quantity` remains the available count. **Stage 2 (A09):** reserve in
`acceptOffer`’s transaction (per `STOCK_RESERVE_ON`), release on expiry /
decline / cancel, consume on payment.

## 8. Money state on Order

* `financialStatus` (UNPAID, UNDER_REVIEW, PARTIALLY_PAID, PAID,
  INVOICED_ON_TERMS, CREDIT_APPROVED, OVERDUE, PARTIALLY_REFUNDED, REFUNDED,
  VOID) is separate from the fulfilment `status`. A trigger derives it from
  `status` whenever a write changes `status` without setting it; set it
  explicitly when you know better (e.g. INVOICED_ON_TERMS).
* `recordPayment(tx, {...})` (`@/lib/payments/ledger`) adds a `Payment` and
  bumps `amountPaidCents`. Refunds: `Refund` rows (REQUESTED → SENT →
  CONFIRMED), `amountRefundedCents`.
* `holdReason` / `holdNote` / `holdAt`: VAT_REVIEW, COMPLIANCE,
  ADDRESS_REVIEW, SHIPPING_PENDING, SUPPLIER_CONFIRMATION, FRAUD.
* Deleting: `orderDeletionBlockers()` / `quoteDeletionBlockers()`
  (`@/lib/documents/retention`) give the reason; triggers enforce it.

## 9. Other new tables

`BillingProfile` (per user; legal name, VAT ID + `VatValidation`, address,
invoice email, PO required), `ReturnRequest` / `ReturnItem` (RMA), offer
snapshot columns on `SourcingRequest` (`offerRevision`, `offerSubtotalCents`,
`offerShippingCents`, `offerVatTreatment`, `offerVatRateBp`, `offerVatCents`,
`offerTotalCents`, `offerTerms`) — **Stage 2 quotes must fill these in
`sendOffer` and price acceptance from them**, not from live settings.

## 10. Deploy

`docker compose up` runs `setup` = `prisma migrate deploy` +
`npm run docs:backfill-legacy` (idempotent). Node 22 image, Chromium in the
runner, web container 2 GB. Create the private `documents/` prefix policy
(never public) and enable bucket versioning / object lock on it.

## 11. Checkout & pricing (stage 2, s2a) — `@/lib/checkout`, `@/lib/pricing`

* **One sell price.** Server code: `sellPriceOf(product)` (`lib/pricing/server.ts`,
  select `SELL_PRICE_SELECT`). Public lists / filters / sort: `Product.displayPriceCents`
  (DB triggers of migration 7a keep it equal to the resolver; null = no public
  price). Never print `Product.priceCents` to buyers. Show prices with
  `<PriceTag netCents currency />` (VAT basis per `PRICE_DISPLAY_MODE`).
* **Checkout engine** (`engine.ts` pure, `server.ts` I/O): `computeCheckout()` =
  resolver + `checkCountry` + `quoteShippingFor` + VIES + `determineVat`;
  `placeCheckoutOrder()` creates the order with exactly the shown total
  (expected-total guard) and stores `vatTreatment/vatRateBp/shippingVatRateBp`,
  per-line `vatRateBp/taxCents/basePriceCents/appliedMarkupBp`, `customerType`,
  `b2bDeclarationAt`, `poNumber`, `invoiceEmail`, `billingAddress` (separate),
  `pricingSnapshot` (evidence), `openHolds/holdReason`, `payableSince`.
* **Holds** (`holds.ts`): `openHolds` lists every open hold; `holdReason` is the
  first by priority. Pre-payment holds (COMPLIANCE, VAT_REVIEW, ADDRESS_REVIEW,
  SHIPPING_PENDING) make the order not payable — `issueProforma` refuses,
  the payment page hides bank details / upload / card. Use `addHold()` and
  `releaseHold()` (the last release emails the final total + proforma).
  `PAYMENT_REVIEW` = money received ≠ order (Stripe mismatch / dispute).
* **Addresses (A12)**: every write path calls `evaluateAddressChange(order,
  country, 'BUYER' | 'STAFF')` and `recordAddressChange()` (AddressChange
  history, holds). BLOCK countries are refused everywhere; address selects use
  `countryOptions()` (no hard-coded lists).
* **Stripe**: card sessions carry `metadata.orderId/totalCents/currency`
  (+ `kind: 'existing'` for a payable order paid from the payment page — its
  expiry only drops the session). The webhook marks paid only when
  `amount_total`/`currency` equal the order. Stripe never collects or
  overwrites addresses. Tests: `STRIPE_API_BASE` (loopback only).
* Tests: `npm test` (engine/input/display/import-VAT/recorded-VAT units),
  `npm run test:checkout-db` (trigger == resolver).

## 12. Quotes, offers & payment page (stage 2, s2b) — `@/lib/quotes`, `@/lib/orders`

* **Offer snapshot** (`lib/quotes/pricing.ts`, `engine.ts`): sending an offer
  freezes goods, freight, terms (`offerTerms` v1) and — when the buyer has a
  billing profile — the VAT decided by the engine; otherwise “VAT determined at
  acceptance”. Acceptance decides VAT again for the real billing + delivery
  details and creates the order with exactly the confirmed total, recording the
  same fields as a checkout order (`vatTreatment/vatRateBp/shippingVatRateBp`,
  per-line VAT, `customerType`, `invoiceEmail`, `poNumber`, `payableSince`,
  `openHolds`).
* **One due-date rule** (`lib/orders/payment-due.ts`, `due-sweep.ts`, run by
  `/api/cron/sla-sweep`): `Order.dueAt` (printed on the proforma) or
  `(payableSince ?? createdAt) + PAYMENT_TERM_DAYS`; reminders, one overdue
  notice, auto-cancel only after due + grace; every notice once (`ReminderLog`).
  Orders on ANY hold are skipped. Releasing the last pre-payment hold
  (`lib/checkout/holds.ts releaseHold`) restarts the term (new `dueAt`) and
  re-issues + emails the proforma.
* **Details before payment** (`lib/orders/details.ts`, `details-server.ts`):
  billing + delivery details (VAT ID per `DETAILS_VAT_ID_REQUIRED`, never for
  CONSUMER orders) before a receipt, a card payment, verify, mark paid or terms.
  `saveOrderDetails` follows the A12 address rule (history, BLOCK / REVIEW,
  checkout orders: no buyer country switch; staff switch → ADDRESS_REVIEW).
* **Credit terms** (`lib/credit/terms.ts`), **buyer cancel** and
  **deal cancellation by stage** (`lib/quotes/cancel.ts`), **unit holds**
  (`lib/quotes/stock.ts` — `sellQuoteUnit` on every paid path incl. the Stripe
  webhook). Tests: `npm run test:quotes`.


## 13. Fulfilment, cancellation, returns & refunds (stage 2, s2c) — `@/lib/fulfilment`, `@/lib/sell/stages`

Migration `8c_fulfilment_returns` (additive): `ShipmentItem` (lines per
shipment → partial shipments), shipment notification stamps, Refund ledger
fields (`returnId`, `payeeIban`, `sentById`, `confirmedAt/ById`, email stamps),
RMA workflow fields on `ReturnRequest`, `BankDetailsChange` (payout-account
history). Shipments / shipment lines / refunds / bank changes are never deleted
(trigger). The financialStatus trigger now keeps a PAID order's money state when
it is canceled (the refund is still owed); unpaid orders still become VOID.
Backfill: one Shipment (all lines) per order shipped before 8c.

* **One gate towards the carrier** (`shipments.ts`): `orderShipBlockers()` =
  complete billing + delivery details (`orderDetailsProblems`), destination not
  BLOCK, no dispatch hold (COMPLIANCE, ADDRESS_REVIEW, PAYMENT_REVIEW, FRAUD,
  SUPPLIER_CONFIRMATION, SHIPPING_PENDING). `markOrderProcessing`,
  `recordShipment` (lines or 'ALL', carrier from Settings → Carriers, tracking
  rule, insured value 'DEFAULT' = goods value of the shipped lines),
  `updateShipmentTracking`, `markDelivered` (staff / buyer / carrier POD),
  `attachPod`. Every path uses them: order page, list row status form
  (`setOrderFulfillment`), bulk ship (`bulkShipAction`, one carrier + tracking
  per order), buyer “Mark as received” (`confirmDelivery` delegates). The old
  `bulkMarkAllShipped` / `bulkMarkSelectedShipped` are gone. Tracking links come
  only from `SHIPPING_CARRIERS` (`rules.ts buildTrackingUrl`), stored on the
  Shipment; `lib/orders/display.trackingUrl` was removed.
* **Emails (A27)**: processing (optional), shipped (every shipment, incl. bulk;
  items, carrier, tracking link, delivery address, “rest follows”), tracking
  changed, delivered (staff/POD only) — texts in Settings → Fulfilment &
  delivery. `mail.ts sendBuyerMail` always attempts the primary recipient and
  `mailOutcomeText` reports the result to staff.
* **Cancel** (`cancel.ts`): `cancelUnpaidOrder(orderId, actor, {reason})` for
  checkout AND quote orders (card session expired first; quote orders delegate
  to `cancelQuoteOrder`) — used by buyer, staff, bulk cancel.
  `cancelPaidOrder` (paid / on terms, nothing shipped): credit note + refund
  ledger + restock per `AUTO_RESTOCK_ON_REFUND` (options now ONLY_IF_NOT_SHIPPED
  | NEVER; a shipped unit is restocked only at RMA inspection). After anything
  shipped: no cancel — RMA / refund.
* **Refund ledger** — integrated with s2e into ONE refund / credit core,
  `lib/finance/refunds.ts` (the s2c module `lib/fulfilment/refunds.ts` was
  merged into it): `settleCredit()` (rules.ts) splits a credit into the unpaid
  receivable (no money, no Refund row — it goes first) and money;
  `creditAndRefundTx` issues the credit note (exact VAT per rate, see §3) and a
  Refund REQUESTED (bank / other) / SENT (Stripe). `markRefundSent` (date, bank
  ref, IBAN, proof) → SENT + buyer email (`EMAIL_REFUND_SENT_BODY`);
  `confirmRefund` → CONFIRMED (internal); Stripe `charge.refunded` confirms card
  refunds. `Order.amountRefundedCents` = money actually sent; REFUNDED money
  state only when everything paid was sent. What is still refundable / “held”
  counts every live refund (`lib/finance/held.ts heldMoneyCents`).
  `createRefund` (the one refund / credit form, also part payments on unpaid
  orders) restocks only before anything shipped, at most once per order, and on
  a shipped order needs an RMA or a written justification
  (`REFUND_SHIPPED_REQUIRES_RETURN_OR_REASON`). `refundOrder` (old action) now =
  a part refund with an amount, else cancel & refund before shipping, else
  refers to the order page.
* **Credit notes** (`issue.ts`): `issueCreditNote({ …, money })` (s2e
  `CreditMoney` → snapshot `settlement` kind REFUND / REFUND_CARD / NOT_PAID /
  PART_REFUND / REFUNDED / REPLACED) prints the settings line
  `CREDIT_NOTE_TEXT_*` after `CREDIT_NOTE_TEXT` (“corrects invoice X of
  <date>”): never “is refunded” before the money was sent (bank: “will be
  refunded … separate confirmation once sent”). The s2c `settlement` shape and
  `textRev: 2` were folded into that before any document was issued with them;
  `CREDIT_NOTE_TEXT_UNPAID` → `CREDIT_NOTE_TEXT_NOT_PAID`.
* **RMA** (`returns.ts`): `createReturnRequest` (window from delivery /
  first shipment, warranty claims after it, reasons `TYPE | label`, photos rule,
  one open request per order, linked HIGH-priority support ticket),
  `approveReturn` (instructions from Settings, optional label, or no return),
  `rejectReturn`, `recordReturnShipment` (buyer), `receiveReturn`,
  `inspectReturn` (the ONLY restock, grade RESELL), `resolveReturn` (refund /
  credit via the ledger, repair, replacement, none), `addReturnFiles`.
* **Pages**: admin order page — `NextSteps`, `AdminShipments`, `AdminReturns`,
  `AdminMoney` (#money), `AdminCancelCard`; Orders → Returns & refunds queue
  (`/admin/orders/returns`); buyer order page — `NextSteps`, `BuyerShipments`,
  `BuyerRefunds`, `BuyerReturns`, cancel for any unpaid order. One loader:
  `view.ts orderFulfilmentView()`. Packing slip PDF (no prices, not fiscal):
  `/api/shipments/<id>/packing-slip` (staff). Private files (return photos,
  labels, POD, refund proofs): `/api/order-files/<key>` (buyer of the order or
  staff with orders:view).
* **Acquisitions** (`lib/sell/stages.ts` pure + `lib/sell/actions.ts`): every
  stage move is a compare-and-set from the stage the writer saw (stale tabs /
  double clicks change nothing, emails once); `setSellStatus` refuses deals in
  their payout lifecycle. Payout account: IBAN mod-97 (`ACQ_REQUIRE_VALID_IBAN`),
  holder match flag; from `ACQ_BANK_LOCK_STAGE` a change is PENDING_REVIEW
  (alerts, payout blocked) until `reviewBankDetailsChange` (call-back tick per
  `ACQ_BANK_CHANGE_REQUIRE_CALLBACK`).
* Settings: `lib/fulfilment/settings-defs.ts` (groups “Fulfilment & delivery”,
  “Returns & refunds”, plus Acquisitions / Documents keys).
* Tests: `npm test` (`rules.test.ts`, `stages.test.ts`),
  `npm run test:fulfilment` (DB).

## 14. Catalog truth & supplier sync (stage 2, s2f) — `@/lib/catalog`, `@/lib/marketplace`

* **Owner rules** (Settings → *Import & suppliers*, *Catalog & claims*, *Site texts & pages*;
  typed by `getImportSettings()` / `getCatalogPolicy()` / `getSiteTexts()`): supplier claim
  phrases, price stripping, cross-sell headings, brand names + aliases, category rules,
  condition words, unmapped/condition/claim actions, price-review thresholds + hold,
  archive safety stop (% + always-allowed items), backorder mode, timeouts / lock / report
  retention / photo size, placeholder brands, agreement-end action, every product-page text
  (sold / not available / backorder / reserved / price review / no description / photo
  request / reviews), warranty wording, the JSON-LD return-policy switch (the return
  window itself is ONE setting, `RETURN_WINDOW_DAYS` in Settings → Returns & refunds,
  shared with the RMA window — see §15), site title /
  meta / footer / page intros, Terms of Service text with placeholders.
* **Import cleaning** (`lib/marketplace/import-clean.ts`, rules in `lib/catalog/import-rules.ts`):
  sentence-level — claims, other prices, supplier mentions and "Also available" tails go;
  the technical text stays. `cleanSupplierHtmlDetailed()` reports every removed sentence
  (run reports, Admin → Catalog → Audit). Meta description / JSON-LD go through
  `publicPlainText()` (no sentence with a price).
* **Price review (migration 8f)**: a sync never applies a source price change beyond the
  thresholds — `Product.pendingPrice*` + `priceOnHold`. While on hold the resolver
  (`resolveSellPrice`, `priceOnHold` input — **required** in `SellPriceInput`, part of
  `SELL_PRICE_SELECT`) and the SQL trigger (`displayPriceCents` NULL) make the listing
  quote-only with no public price. Admin → Catalog → Price review approves (price goes
  live) or rejects (current price kept, `price` locked). An admin who edits the price on
  the product decides it too.
* **Mapping**: brand = source field (through aliases) else the brand named first in the
  title as a whole word; category = first matching rule; nothing matched → the new item is
  held for review with the reason (never a silent first category). Imports get a drawing
  only from `illustrationForCategory()`; 8f set the old blanket `balance` to NULL.
* **Catalog audit** (`lib/catalog/audit.ts`, Admin → Catalog → Audit, CLI
  `npm run catalog:clean-claims [-- --apply]`): live detection on supplier listings +
  bulk fixes (clean texts, stated condition, brand from title). **Deploy: run
  `npm run catalog:clean-claims -- --apply` once (or click "Clean texts")** — production
  listings still carry supplier warranties / "tested" / other prices until then.
* **Product questions** (`lib/catalog/product-question.ts`): on listings whose seller has
  no inbox (imports) "Ask a question" / "Request photos" create a support ticket linked
  to the product (never a quote request); the buyer lands on `/app/support?sent=REF`.
* **Agreement terminated** → the shop's live listings are archived (setting), admins
  notified, open orders / quotes counted.
* **Media URLs**: product photos are stored host-relative (`/media/<bucket>/<key>`);
  `npm run media:normalize -- --apply` (now in the compose `setup` step) rewrites old
  absolute URLs of our store (any host, object checked in the bucket). A startup check
  (`src/instrumentation.ts`) logs + notifies when photos are stored under an unknown host.
  `MEDIA_LEGACY_PUBLIC_URLS` is no longer needed for a host move.
* **Documents**: staff opening `/api/documents/proforma/<order>/pdf` never issues a
  proforma — "Issue proforma" on the admin order page does (`issueOrderProformaAction`).
* Tests: `npm run test:catalog` (cleaner, mapping, terms, warranty wording, plan incl.
  price review + archive stop), `npm test` (resolver hold), `npm run test:checkout-db`
  (trigger == resolver incl. the hold).

## 15. Stage 2, batch 2 integration (s2e + s2c + s2f) — one refund core, one set of keys

s2e (fiscal + security fixes, migration `8e_fiscal_security`): e-mail OTP never
signs in (`lib/auth.ts`), GDPR erasure that keeps fiscal records
(`lib/security/gdpr-erase.ts`), VIES errors = UNAVAILABLE (`lib/tax/vies.ts`),
VAT review resolution per order (`lib/finance/vat-resolution.ts`), payments
ledger on verify (amount + value date + reference), honest documents (frozen
labels / locale `DOC_LANGUAGE`, `DOC_TEXT_*`, advance-payment date, full country
names, “corrects invoice X of <date>”), numbering rules, legacy invoices frozen
before any invoice decision, margin scheme, step-up for the fiscal groups.

* **ONE refund / credit-note core**: `lib/finance/refunds.ts` (s2e's
  `creditAndRefund` and s2c's `lib/fulfilment/refunds.ts` merged). Callers: the
  refund / credit form (Money back section, `createRefundAction`), cancel &
  refund before shipping and cancel on NET terms (`lib/fulfilment/cancel.ts`),
  RMA resolution (`lib/fulfilment/returns.ts`), overpayments on verify / mark
  paid / VAT rules (`requestRefundTx`), the missing credit note of an older
  refund (`issueMissingCreditNote`), Stripe `charge.refunded`
  (`confirmStripeRefunds`). Semantics: see §13 “Refund ledger” and “Credit notes”.
* **Money state** = money actually SENT (`Order.amountRefundedCents`, financial
  status, order REFUNDED); money still “held” for the buyer (cancel guards, open
  amount on verify / mark paid, payment page, reminders / auto-cancel, GDPR
  blockers) = received − every live refund: `lib/finance/held.ts`.
* **Settings reconciled** (one key per concept; migration
  `8i_integration_settings` carries saved values over and records a
  SettingChange):
  `REFUND_EMAIL_REQUESTED_TEXT` → `EMAIL_REFUND_BANK_BODY`,
  `REFUND_EMAIL_CARD_TEXT` → `EMAIL_REFUND_CARD_BODY`,
  `REFUND_EMAIL_SENT_TEXT` → `EMAIL_REFUND_SENT_BODY` (Email texts),
  `CREDIT_NOTE_TEXT_UNPAID` → `CREDIT_NOTE_TEXT_NOT_PAID` (Documents & legal
  texts), `SEO_RETURN_POLICY_DAYS` → `RETURN_WINDOW_DAYS` +
  `SEO_ADVERTISE_RETURN_POLICY`; `RETURN_WINDOW_DAYS` (defined by both s2c and
  s2f) is one definition in Returns & refunds, default 7 (the published terms);
  `AUTO_RESTOCK_ON_REFUND=ALWAYS` (option removed) → `ONLY_IF_NOT_SHIPPED`.
* Migrations apply in lexical order: `8c_fulfilment_returns`,
  `8e_fiscal_security`, `8f_catalog_review`, `8i_integration_settings` (data only).
* **Deploy** (in this order, after `prisma migrate deploy`): `npm run
  docs:backfill-legacy` (as before), `npm run media:normalize -- --apply`
  (compose setup, s2f), then — after the owner approved it — `npm run
  catalog:clean-claims -- --apply` once (s2f; a dry run without `--apply`
  reports the counts).
