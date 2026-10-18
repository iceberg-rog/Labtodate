/**
 * Registry defaults of the editable public page and legal texts (Admin →
 * Settings → Site texts & pages, Suppliers, Acquisitions, Sales channel). Pure.
 *
 * Format — the same as the Terms of Service (lib/catalog/texts.ts →
 * renderTermsBlocks): a line starting with “## ” is a heading, an empty line
 * starts a new paragraph, and [link text](/site/path) is a link to a page of
 * this site. Placeholders are filled by the page from the setting that rules
 * them, so a text never states a number, a provider or an address the
 * settings do not:
 *   {SITE}           the brand name (Brand → Site / brand name)
 *   {LEGAL_NAME}     the registered company name (Company)
 *   {ADDRESS}        “, <registered address>, <country>” — empty when not set
 *   {CONTACT}        the public support e-mail as a link (else the contact page)
 *   {RETURN_DAYS}    days to report an item that differs from its description
 *   {RETENTION_YEARS} years financial records are kept (Documents & legal texts)
 *   {SHIPPING_CLAIM} “ <shipping claim>.” (Catalog & claims) — empty without a claim
 *   {SHIPPING_ANSWER} the shipping claim with “Shipping costs and any tax are
 *                    confirmed before you pay.”, or the no-claim answer
 *   {SELL_TURNAROUND} “, usually within <valuation reply time>” — empty when not set
 *   {CHECKOUT_PAYMENT_METHODS} the payment methods checkout really offers
 *   {CARD_PAYMENTS}  “ <who processes card payments>.” while card payments are
 *                    offered — empty otherwise
 *   {CARD_PAYMENT_COOKIES} “ <the card page of the payment provider sets its own
 *                    cookies>.” while card payments are offered — empty otherwise
 * The defaults describe only what the site really does; edit them when the
 * business changes.
 */

export const ABOUT_PAGE_TOKENS = ['{SITE}', '{LEGAL_NAME}', '{ADDRESS}', '{CONTACT}', '{SHIPPING_CLAIM}'] as const;

export const DEFAULT_ABOUT_PAGE_TEXT = `{SITE} is a marketplace for used, refurbished and surplus laboratory and analytical equipment — chromatography, mass spectrometry, spectroscopy and the parts that keep them running.

## What we do
We list used, refurbished and surplus instruments from a working supply network.{SHIPPING_CLAIM} We handle quotes, proforma invoices, payment and logistics end to end.

## Why buyers transact with us
You deal with {SITE} as a single accountable counterparty: one proforma, one invoice, one point of contact through delivery and after-sale support.

## Contact
{LEGAL_NAME}{ADDRESS}. E-mail {CONTACT}.`;

export const FAQ_TOKENS = ['{CONTACT}', '{RETURN_DAYS}', '{SHIPPING_ANSWER}', '{SELL_TURNAROUND}', '{CHECKOUT_PAYMENT_METHODS}'] as const;

export const DEFAULT_FAQ_TEXT = `## Is the equipment tested? Is there a warranty?
Each listing states the condition and the warranty of that unit — or that it is sold without warranty. A unit is described as inspected only when an inspection is recorded for it, with the report on the listing. If you need a test or inspection report that the listing does not show, ask us before you order.

## How does pricing work?
Some items have a list price (buy now); others are quote-only. Request a quote and we send you an offer with the price, terms and validity. When you accept it in your dashboard, we create your order and issue a proforma invoice.

## Do you ship internationally?
{SHIPPING_ANSWER}

## What payment methods are accepted?
At checkout you pay by {CHECKOUT_PAYMENT_METHODS}. For quote-based orders, accepting our offer issues a proforma invoice (PDF) with the bank-transfer instructions.

## Can I sell my equipment?
Yes — submit it via [Sell equipment](/sell) for a free valuation{SELL_TURNAROUND}.

## What if an item is not as described?
Contact {CONTACT} within {RETURN_DAYS} days of delivery; under our [terms](/legal/terms) we resolve it or refund you.

## How do I track my order?
Sign in and open the order under [My orders](/app/orders) — you see the fulfilment status, and the tracking number once it has shipped.`;

export const PRIVACY_POLICY_TOKENS = ['{SITE}', '{LEGAL_NAME}', '{ADDRESS}', '{CONTACT}', '{RETENTION_YEARS}', '{CARD_PAYMENTS}'] as const;

export const DEFAULT_PRIVACY_POLICY_TEXT = `{LEGAL_NAME}{ADDRESS} (“{SITE}”) is the data controller for personal data processed through this site. This policy explains what we collect, why, who processes it for us and how long we keep it.

## Data we collect
Account data: your name, e-mail address, password (stored only as a hash), role, and sign-in security data such as sign-in times, IP address, browser and two-step verification settings.

Business and order data: company name, billing and delivery addresses, phone number, VAT ID, purchase-order numbers, quote requests, offers, orders, payment receipts you upload, invoices, returns, support tickets and messages.

Technical data: the server logs needed to run and protect the service (IP address, browser type, pages requested, errors).

## Why we use it
To create and secure your account; to answer quote requests and support tickets; to make offers and process orders, payments, shipping and returns; to issue proformas, invoices and credit notes and meet our tax and accounting duties; and to send the e-mails these require. Only if you opted in do we also e-mail you news and offers — you can opt out at any time in your [e-mail preferences](/app/email-preferences) or with the link in every such e-mail.

The legal bases are the contract with you, our legal obligations (tax and accounting records), our legitimate interest in keeping the service secure and, for news and offers, your consent. We do not sell personal data and do not build advertising profiles.

## Who processes data for us
E-mail: our e-mail provider delivers the account and order e-mails we send you.

Hosting and storage: the site, its database and uploaded files (photos, payment receipts, documents) are kept on servers we rent for this purpose, with encrypted backup copies.

VAT ID checks: a VAT ID you enter is checked with the European Commission’s VIES service; the answer is kept as evidence for the VAT treatment of your order.{CARD_PAYMENTS}

Shipping: the carrier of a shipment receives the delivery name, address and phone number.

Each of them processes the data only to perform that task for us.

## How long we keep it
Orders, invoices, credit notes, payments and the documents that belong to them are kept for {RETENTION_YEARS} years, as tax and accounting law requires. Account data is kept while you have an account; you can ask us to delete it at any time — records the law requires us to keep stay until their period ends.

## Your rights
You may ask for access to your data, its correction or deletion, a copy of the data you gave us, or object to or ask us to restrict its use: e-mail {CONTACT}. You may also complain to the data protection authority of your country (in the Netherlands: the Autoriteit Persoonsgegevens).

## Contact
{LEGAL_NAME}{ADDRESS} · {CONTACT}`;

export const COOKIE_POLICY_TOKENS = ['{SITE}', '{CONTACT}', '{CARD_PAYMENT_COOKIES}'] as const;

export const DEFAULT_COOKIE_POLICY_TEXT = `{SITE} uses only the cookies needed to make the site work. There are no advertising, analytics or cross-site tracking cookies.{CARD_PAYMENT_COOKIES}

## Cookies we set
Sign-in session: set when you sign in. It keeps you signed in until you sign out or the session expires, and protects your account.

Session check: a short-lived companion of the sign-in cookie that lets pages confirm your session quickly.

Two-step sign-in: while you enter an authenticator code, a short-lived cookie links the code to your sign-in attempt.

These cookies are strictly necessary — signing in does not work without them — so they are set without asking for consent.

## Kept in your browser only
Your light / dark theme choice and whether you closed the cookie notice are kept in your browser’s local storage. They are never sent to us.

## Managing cookies
You can clear or block cookies in your browser settings; signing in does not work without the session cookie.

## Contact
{CONTACT}`;

export const SELLER_TERMS_TOKENS = ['{SITE}', '{LEGAL_NAME}', '{CONTACT}'] as const;

export const DEFAULT_SELLER_TERMS_TEXT = `## How selling through {SITE} works
You list your equipment with the price you want to receive for it. {LEGAL_NAME} sells it to the buyer in its own name: the buyer’s offer, proforma, payment, invoice and VAT are handled by us, and we buy the unit from you at your price.

## Your price
The price you enter is the amount you receive for the unit (excluding VAT). Our sell price to the buyer is set separately and is never deducted from your price.

## Your listings
Keep the description, condition, photos and availability of every listing accurate; we may correct or unpublish a listing that is not.

## Questions
E-mail {CONTACT}.`;

export const DEFAULT_SELLER_PAYOUT_TERMS_TEXT = `When and how we pay you for a unit we bought from you is set out in your supplier agreement with {LEGAL_NAME}. Questions about a payment: e-mail {CONTACT}.`;

export const DEFAULT_SELL_TERMS_TEXT = `Sending this form asks us for an offer; it is not a sale. Nothing is agreed until you accept our written offer in your dashboard, and the price, payment and delivery are those of the offer you accept.

I confirm that I own this equipment or am authorised by its owner to sell it, that it is free of liens, leases, finance agreements and other claims of third parties, and that my description and photos are accurate.`;

export const DEFAULT_SELL_DECONTAMINATION_TEXT = `I declare that the equipment has been cleaned and decontaminated and is free of hazardous biological, chemical and radioactive substances — or I describe below every residue or hazard it may still carry, so it can be handled safely.`;

export const DEFAULT_CONSUMER_WITHDRAWAL_TEXT = `As a consumer you may withdraw from this purchase within 14 days after you (or someone you name) received the goods, without giving a reason. To withdraw, tell us within that period in a clear statement (for example by e-mail), and send the goods back within 14 days after telling us. We refund the price and the standard delivery costs within 14 days of your statement; we may wait until the goods are back or you show that you sent them. You pay the direct cost of returning the goods.`;

export const DEFAULT_BUYER_CANCEL_DISABLED_TEXT = 'Want to cancel this order? Contact our support team: we cancel it for you and confirm by e-mail.';
