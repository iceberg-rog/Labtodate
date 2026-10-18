import type { SettingDefinitionInput } from '@/lib/settings/defs';
import { carriersProblem, returnReasonsProblem } from './rules';

/**
 * Admin settings owned by the fulfilment / cancellation / returns & refunds area
 * (wave 2, team s2c). Registered in the typed settings registry
 * (src/lib/settings/defs.ts): Admin → Settings → “Fulfilment & delivery”,
 * “Returns & refunds” and “Acquisitions”, with validation, the .env fallback and
 * the Change history. Read them through ./policy.ts after ensureSettingsLoaded().
 *
 * Placeholders in texts: {ORDER} order number, {ITEMS} the items in the shipment,
 * {CARRIER}, {TRACKING}, {DATE}, {AMOUNT}, {REFERENCE}, {RMA}, {DAYS},
 * {ADDRESS} (receiving address), {REASON}, {TICKET} (the return's support ticket).
 * The RMA texts are also posted on the return's support ticket.
 */

const yesNo = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
] as const;

const textList = (v: string): string | null => {
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return 'add at least one entry.';
  return parts.some((p) => p.length > 80) ? 'each entry may have at most 80 characters.' : null;
};

export const DEFAULT_CARRIERS = [
  'PostNL | https://jouw.postnl.nl/track-and-trace/{TRACKING}',
  'DHL Express | https://www.dhl.com/nl-en/home/tracking/tracking-express.html?submit=1&tracking-id={TRACKING}',
  'DHL Freight | https://www.dhl.com/nl-en/home/tracking/tracking-freight.html?submit=1&tracking-id={TRACKING}',
  'DB Schenker | https://www.dbschenker.com/app/tracking-public/?refNumber={TRACKING}',
  'UPS | https://www.ups.com/track?tracknum={TRACKING}',
  'FedEx | https://www.fedex.com/fedextrack/?trknbr={TRACKING}',
  'DPD | https://tracking.dpd.de/status/en_GB/parcel/{TRACKING}',
  'GLS | https://gls-group.com/NL/en/parcel-tracking?match={TRACKING}',
  'Kuehne+Nagel',
  'Own transport',
  'Collected by the buyer',
].join('\n');

export const DEFAULT_RETURN_REASONS = [
  'TRANSPORT_DAMAGE | Damaged in transport',
  'NOT_AS_DESCRIBED | Not as described',
  'NOT_AS_DESCRIBED | Parts or accessories missing',
  'WARRANTY | Does not work / defect',
  'RETURN | Ordered by mistake / no longer needed',
].join('\n');

const G_FUL = 'Fulfilment & delivery' as const;
const G_RET = 'Returns & refunds' as const;

export const FULFILMENT_SETTING_DEFS: readonly SettingDefinitionInput[] = [
  // ── Fulfilment & delivery ─────────────────────────────────────────────────
  {
    key: 'SHIPPING_CARRIERS', label: 'Carriers', group: G_FUL, type: 'text', multiline: true, default: DEFAULT_CARRIERS,
    validate: carriersProblem,
    hint: 'One carrier per line: “Name | tracking link” where {TRACKING} is replaced by the tracking number. A carrier without a link (own transport, collected by the buyer, freight forwarders without public tracking) needs no tracking number. Staff choose from this list when they ship; the link goes into the shipped email and onto the buyer’s order page.',
  },
  {
    key: 'SHIPPING_REQUIRE_TRACKING_TO_SHIP', label: 'Tracking number required to mark shipped', group: G_FUL, type: 'bool', default: 'true', options: yesNo,
    hint: 'Yes: a shipment with a carrier that has a tracking link can only be recorded with its tracking number (bulk shipping asks for one per order). Carriers without a link never need one.',
  },
  {
    key: 'SHIPMENT_INSURE_BY_DEFAULT', label: 'Insure shipments by default', group: G_FUL, type: 'bool', default: 'true', options: yesNo,
    hint: 'Prefills “insured” with the goods value of the shipped lines when staff record a shipment (they can change it per shipment).',
  },
  {
    key: 'SHIPMENT_POD_MAX_MB', label: 'Proof-of-delivery file size limit (MB)', group: G_FUL, type: 'int', default: '8', min: 1, max: 9,
    hint: 'Signed delivery receipt / carrier POD uploaded on a shipment (JPG, PNG, WEBP or PDF). One upload can be at most 9 MB (server limit).',
  },
  {
    key: 'PACKING_SLIP_TITLE', label: 'Packing slip title', group: G_FUL, type: 'string', default: 'Packing slip',
    hint: 'Printed at the top of the packing slip PDF that goes in the parcel. The packing slip never shows prices.',
  },
  {
    key: 'PACKING_SLIP_NOTE', label: 'Packing slip note', group: G_FUL, type: 'text', multiline: true, optional: true,
    default: 'Please check the goods on arrival. Note any visible damage on the carrier’s delivery receipt before signing, and report it to us within {DAYS} days from your order page (order {ORDER}).',
    hint: 'Printed under the item list. {ORDER} = order number, {DAYS} = the return window (Returns & refunds).',
  },
  {
    key: 'EMAIL_PROCESSING_ENABLED', label: 'Email the buyer when an order is being prepared', group: G_FUL, type: 'bool', default: 'true', options: yesNo,
    hint: 'Sent once when staff mark a paid order “processing” (ready to ship). The in-app notification always goes out.',
  },
  {
    key: 'EMAIL_PROCESSING_TEXT', label: 'Email text — order being prepared', group: G_FUL, type: 'text', multiline: true,
    default: 'We are preparing order {ORDER} for dispatch. You receive a separate email with the carrier and tracking details as soon as it ships.',
    hint: '{ORDER} = order number.',
  },
  {
    key: 'EMAIL_SHIPPED_SUBJECT', label: 'Email subject — shipped', group: G_FUL, type: 'string', default: 'Order {ORDER} has shipped',
    hint: '{ORDER} = order number. Sent for every shipment (single and bulk shipping).',
  },
  {
    key: 'EMAIL_SHIPPED_TEXT', label: 'Email text — shipped', group: G_FUL, type: 'text', multiline: true,
    default: '{ITEMS} from order {ORDER} left our warehouse on {DATE} with {CARRIER}.',
    hint: '{ITEMS} = the items in this shipment, {ORDER}, {DATE} = ship date, {CARRIER}. The tracking link, parcels and the delivery address are added below the text automatically.',
  },
  {
    key: 'EMAIL_SHIPPED_REST_TEXT', label: 'Email text — rest of the order follows', group: G_FUL, type: 'text', multiline: true,
    default: 'The rest of your order follows in a separate shipment — we email you again when it ships.',
    hint: 'Added to the shipped email when the order is shipped in more than one shipment and items are still to come.',
  },
  {
    key: 'EMAIL_TRACKING_UPDATED_TEXT', label: 'Email text — tracking details changed', group: G_FUL, type: 'text', multiline: true,
    default: 'The tracking details of your shipment for order {ORDER} changed: {CARRIER}, tracking number {TRACKING}.',
    hint: 'Sent when staff add or correct the carrier or tracking number of a shipment that was already reported to you.',
  },
  {
    key: 'EMAIL_DELIVERED_TEXT', label: 'Email text — delivered', group: G_FUL, type: 'text', multiline: true,
    default: 'Order {ORDER} was delivered on {DATE}. Please check the goods. If anything is wrong, report it from your order page within {DAYS} days.',
    hint: '{ORDER}, {DATE} = delivery date, {DAYS} = the return window. Sent when staff (or the carrier proof) record the delivery — not when you confirm receipt yourself.',
  },

  // ── Returns & refunds ─────────────────────────────────────────────────────
  {
    key: 'RETURNS_ENABLED', label: 'Buyers can report a problem / request a return online', group: G_RET, type: 'bool', default: 'true', options: yesNo,
    hint: 'Yes: delivered orders show “Report a problem / request a return” within the window below. No: the order page tells buyers to contact support.',
  },
  {
    // One window for everything the buyer reads: Terms of Service §5/§6 and the FAQ (s2f), the
    // return request on the order page, the packing slip and the delivered e-mail (s2c), and —
    // when switched on (Catalog & claims) — the return policy in the structured data. The default
    // keeps the 7 days of the published terms.
    key: 'RETURN_WINDOW_DAYS', label: 'Return / complaint window (days after delivery)', group: G_RET, type: 'int', default: '7', min: 1, max: 365, verify: 'number',
    hint: 'Days to report an item that differs from its description or request a return, counted from the delivery date (or the ship date while delivery is not confirmed). One number for the Terms of Service (§5 and §6), the FAQ, the return requests on the order page, the packing slip, the delivered e-mail and — if switched on in Catalog & claims — the structured data search engines read. Warranty claims can still be filed afterwards while an item is under warranty (below).',
  },
  {
    key: 'RETURN_WARRANTY_AFTER_WINDOW', label: 'Warranty claims after the window', group: G_RET, type: 'bool', default: 'true', options: yesNo,
    hint: 'Yes: after the window, a buyer can still file a WARRANTY claim for an item whose warranty (as sold, in months) has not ended.',
  },
  {
    key: 'RETURN_REASONS', label: 'Reasons the buyer can choose', group: G_RET, type: 'text', multiline: true, default: DEFAULT_RETURN_REASONS,
    validate: returnReasonsProblem,
    hint: 'One per line: “TYPE | Reason shown to the buyer”. TYPE is one of RETURN, TRANSPORT_DAMAGE, NOT_AS_DESCRIBED, WARRANTY — it decides the queue and which reasons need photos.',
  },
  {
    key: 'RETURN_PHOTOS_REQUIRED_FOR', label: 'Photos required for', group: G_RET, type: 'list', default: 'TRANSPORT_DAMAGE,NOT_AS_DESCRIBED', optional: true,
    validate: (v) => (v.split(',').map((s) => s.trim()).filter(Boolean).every((t) => ['RETURN', 'TRANSPORT_DAMAGE', 'NOT_AS_DESCRIBED', 'WARRANTY'].includes(t)) ? null : 'use RETURN, TRANSPORT_DAMAGE, NOT_AS_DESCRIBED or WARRANTY, separated by commas.'),
    hint: 'Reason types for which the buyer must add at least one photo (or PDF). Empty = photos are always optional.',
  },
  {
    key: 'RETURN_MAX_FILES', label: 'Photos / files per request', group: G_RET, type: 'int', default: '6', min: 1, max: 20,
    hint: 'JPG, PNG, WEBP, GIF or PDF.',
  },
  {
    key: 'RETURN_FILE_MAX_MB', label: 'Size limit per photo / file (MB)', group: G_RET, type: 'int', default: '8', min: 1, max: 9,
    hint: 'Per file. One upload (all files sent together) can be at most 9 MB in total (server limit) — buyers can add more photos to an open request afterwards.',
  },
  {
    key: 'RETURN_FREIGHT_PAID_BY', label: 'Return shipping is paid by', group: G_RET, type: 'enum', default: 'CASE_BY_CASE',
    options: [
      { value: 'CASE_BY_CASE', label: 'Decided per case (stated in the approval)' },
      { value: 'BUYER', label: 'The buyer' },
      { value: 'SELLER', label: 'Us' },
    ],
    hint: 'Printed in the return instructions sent with the approval.',
  },
  {
    key: 'RETURN_INSTRUCTIONS_TEXT', label: 'Return instructions (sent with the approval)', group: G_RET, type: 'text', multiline: true,
    default: 'Pack the item in its original packaging or equivalent protection and write {RMA} on the outside of the parcel. Send it to:\n{ADDRESS}\nPlease do not send anything before you received this approval, and send us the carrier and tracking number from your order page.',
    hint: '{RMA} = return number, {ADDRESS} = Acquisitions → Receiving warehouse address (or the registered address). Staff can edit the text per return before approving.',
  },
  {
    key: 'RETURN_EMAIL_RECEIVED_TEXT', label: 'Email text — request received', group: G_RET, type: 'text', multiline: true,
    default: 'We received your request {RMA} for order {ORDER} ({REASON}). Our team reviews it and replies within one business day. Please do not send anything back before you receive our approval with the return instructions.',
    hint: 'Acknowledgement to the buyer. {RMA}, {ORDER}, {REASON}.',
  },
  {
    key: 'RETURN_EMAIL_APPROVED_TEXT', label: 'Email text — approved', group: G_RET, type: 'text', multiline: true,
    default: 'Your request {RMA} for order {ORDER} is approved.',
    hint: 'The return instructions (or “you do not need to send anything back”) follow below this text.',
  },
  {
    key: 'RETURN_EMAIL_REJECTED_TEXT', label: 'Email text — not approved', group: G_RET, type: 'text', multiline: true,
    default: 'We reviewed your request {RMA} for order {ORDER} and cannot approve it: {REASON}. If you want to discuss it, write to us on {TICKET} (Account → Support).',
    hint: '{REASON} = the reason staff give (required; a full stop at its end is dropped, so the text adds its own). {TICKET} = the support ticket of the request (“support ticket TKT-…”), where the buyer can reply. The same text is posted on that ticket.',
  },
  {
    key: 'RETURN_EMAIL_RECEIVED_GOODS_TEXT', label: 'Email text — returned goods received', group: G_RET, type: 'text', multiline: true,
    default: 'We received the returned goods for {RMA} (order {ORDER}) on {DATE}. We inspect them and let you know the outcome.',
    hint: 'Sent when staff record the receipt of a return.',
  },
  {
    key: 'REFUND_REASONS', label: 'Refund reasons (staff)', group: G_RET, type: 'list', default: 'Returned item,Damaged in transport,Not as described,Price adjustment / goodwill,Order canceled before shipping,Other',
    validate: textList,
    hint: 'Offered when staff record a refund; the reason is printed on the credit note and shown to the buyer.',
  },
  {
    key: 'REFUND_SHIPPED_REQUIRES_RETURN_OR_REASON', label: 'Refund of shipped goods without a return needs a justification', group: G_RET, type: 'bool', default: 'true', options: yesNo,
    hint: 'Yes (recommended): a refund on a shipped / delivered order that is not settled through a return (RMA) needs a written justification, which is audited.',
  },
  // Refund e-mails (approved / card / sent) are the Email texts EMAIL_REFUND_BANK_BODY,
  // EMAIL_REFUND_CARD_BODY and EMAIL_REFUND_SENT_BODY (one set for every refund); a credit
  // note that only cancels an unpaid amount prints CREDIT_NOTE_TEXT_NOT_PAID (Documents &
  // legal texts). The earlier keys REFUND_EMAIL_*_TEXT / CREDIT_NOTE_TEXT_UNPAID were merged
  // into those at integration (migration 8i_integration_settings carries stored values over).
  {
    key: 'STAFF_CANCEL_REASONS', label: 'Cancellation reasons (staff)', group: G_RET, type: 'list',
    default: 'Buyer asked to cancel,Item no longer available,Item failed pre-dispatch inspection,Payment problem,Export compliance,Duplicate order,Other',
    validate: textList,
    hint: 'Offered when staff cancel an order (before or after payment). The reason goes to the buyer, on the order and on the credit note.',
  },

  // ── Acquisitions (A22 / A23) ──────────────────────────────────────────────
  {
    key: 'ACQ_BANK_LOCK_STAGE', label: 'Lock the seller’s payout account from', group: 'Acquisitions', type: 'enum', default: 'AWAITING_SHIPPING', sensitive: true,
    options: [
      { value: 'AWAITING_SHIPPING', label: 'As soon as the seller gave it (recommended)' },
      { value: 'IN_TRANSIT', label: 'When the seller shipped the item' },
      { value: 'RECEIVED', label: 'When we received the item' },
    ],
    hint: 'From this stage on, a change of the payout bank account is not applied directly: it waits for staff review (call the seller back on a number you already had), staff are alerted, and the payout is blocked until the change is approved or rejected. Every change is kept in the history.',
  },
  {
    key: 'ACQ_BANK_CHANGE_REQUIRE_CALLBACK', label: 'Approving a bank change needs a confirmed call-back', group: 'Acquisitions', type: 'bool', default: 'true', options: yesNo, sensitive: true,
    hint: 'Yes: staff must tick that they confirmed the new account by phone with the seller (on a known number, not one from the change request) before approving.',
  },
  {
    key: 'ACQ_REQUIRE_VALID_IBAN', label: 'Payout account must be a valid IBAN', group: 'Acquisitions', type: 'bool', default: 'true', options: yesNo,
    hint: 'Yes: the IBAN is checked (country format + mod-97) and refused when invalid. No: sellers outside the IBAN area may give another account number — staff then verify it by hand.',
  },
];
