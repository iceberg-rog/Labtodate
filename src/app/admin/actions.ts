'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { kickAnnouncementWorker, queueAnnouncement } from '@/lib/security/announcements';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { deleteOrArchiveProduct, productDeleteDbFrom } from '@/lib/products/delete-guard';
import { cancelOrderSaga, type StripeSessionApi } from '@/lib/orders/stripe-handoff';
import { orderReservedStock } from '@/lib/orders/checkout-tx';
import { invoiceMailSummary, sendOrderInvoice } from '@/lib/orders/internal';
import { recordPayment } from '@/lib/payments/ledger';
import { proxyProofUrl } from '@/lib/orders/display';
import { expireOnlyApi } from '@/lib/stripe/session-api';
import { requireSession, requireCapability, hasCapability, sendAdminPasswordReset, getServerSession } from '@/lib/auth-server';
import { evaluateAddressChange, recordAddressChange } from '@/lib/checkout/holds';
import {
  changeUserCaps,
  changeUserRole,
  resetUserTwoFactor,
  adminTargetProblems,
  getActor,
  refuseAccessChange,
  type AccessResult,
} from '@/lib/security/user-access';
import { stepUpRequired, type StepUpRequired } from '@/lib/security/stepup';
import { alertSuperAdmins } from '@/lib/security/alerts';
import { Prisma, UserRole, type OrderHoldReason } from '@prisma/client';
import { saveSettings as persistSettings, SETTING_DEFS, isSiteRelativePath, settingBool, settingInt, revertSettingChange, getEffectiveSettings, normaliseInput, settingDef, isSecurityPolicyKey, type SettingActor } from '@/lib/settings';
import { getSecurityPolicy, invalidatePolicyCache, planPolicySave, POLICY_DEFS } from '@/lib/security/policy';
import { documentAttachment, markDocumentSent, issueProforma, prePaymentHoldMessage, reissueProforma } from '@/lib/documents/issue';
import { orderDeletionBlockers } from '@/lib/documents/retention';
import { headers } from 'next/headers';
import { uploadObject } from '@/lib/storage/s3';
import { recordReceiptEvent, storeReceiptFile } from '@/lib/payments/receipts';
import { readVerifiedUpload } from '@/lib/storage/file-type';
import { emailTransportStatus, isDeliverableEmail, sendEmail, trySendEmail } from '@/lib/email';
import { escapeHtml, escapeHtmlLines } from '@/lib/email-html';
import { ensureSettingsLoaded } from '@/lib/settings';
import { getStripe } from '@/lib/stripe/client';
import { aiConfig } from '@/lib/ai';
import { ensureBucket } from '@/lib/storage/s3';
import { audit, notifyUser, notifyAdmins } from '@/lib/observability';
import { formatPrice } from '@/lib/utils';
import { fmtDocMoney } from '@/lib/documents/render';
import { MAX_ADMIN_PRODUCT_IMAGES, MAX_PRICE_CENTS, MAX_PRICE_MESSAGE, zodFieldErrors, zodMessage } from '@/lib/products/validation';
import { HOME_DEFAULTS, HOME_EXTRAS, HOME_ORDER_VERSION, HOME_TEXT_FIELDS, parseHeroStats } from '@/lib/home-sections';
import { isSafeImageUrl } from '@/lib/products/image-urls';
import { assertPublicHost, fetchPublic, localizeImageList } from '@/lib/media/localize';
import { firstPublicImage, ownMediaPath, publicProductImages } from '@/lib/media/public-src';
import { isLockableField, type LockableField } from '@/lib/marketplace/woo-sync-plan';
import { consentFromForm, hasConsent, CONSENT_MISSING_MESSAGE } from '@/lib/catalog/consent';
import { getCatalogPolicy } from '@/lib/catalog/policy';
import { orderDetailsProblems } from '@/lib/orders/details';

import { takeQuoteUnit } from '@/lib/quotes/stock';
import { requireDetailsBeforePayment, vatIdRule } from '@/lib/quotes/policy';
import { mailLayout, siteBase } from '@/lib/quotes/mail';
import { notifySupplierOfSale } from '@/lib/sellers/sale-notice';
import { PRE_PAYMENT_HOLDS } from '@/lib/checkout/holds';
import { holdTitle } from '@/lib/checkout/notify';
import { businessTimeZone } from '@/lib/documents/numbering';
import {
  announcementLinkProblem, bookingHoldBlocker, countryPolicyValue, fmtValueDay, holdResolvedAt, lowAmountNeedsConfirm, manualPaymentBlocker, MANUAL_PAY_BLOCKING_VERIFICATION,
  PAYMENT_REVIEW_HOLD, proofKeyOf, readReceived, shippingRateValue, shippingZoneValue, STOCK_SHORTAGE_HOLD, withoutHold,
} from '@/lib/payments/rules';
import { onStockShortage, stockShortageText } from '@/lib/payments/stock-shortage';
import { HOLD_PRIORITY } from '@/lib/checkout/engine';
import { cancelPaidOrder, cancelUnpaidOrder } from '@/lib/fulfilment/cancel';
import { heldMoneyCents, LIVE_REFUNDS_SELECT, requestRefundTx } from '@/lib/finance/refunds';
import { markDelivered, markOrderProcessing, recordShipment, updateShipmentTracking } from '@/lib/fulfilment/shipments';
import { buildTrackingUrl, findCarrier } from '@/lib/fulfilment/rules';
import { carriers as configuredCarriers } from '@/lib/fulfilment/policy';

/** Who is changing settings (for the change history). */
async function settingActor(id: string | null, email: string | null): Promise<SettingActor> {
  let ip: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    ip = (h.get('x-real-ip') || h.get('x-forwarded-for')?.split(',')[0] || '').trim() || null;
    userAgent = h.get('user-agent');
  } catch {
    /* outside a request */
  }
  return { id, email, ip, userAgent, source: 'ADMIN' };
}

async function requireAdmin() {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
}

// Sensitive-action gate. Use this at the top of any mutation that should
// be limited to admins with a specific capability (e.g. 'orders:refund').
async function requireCap(cap: string) {
  return requireCapability(cap, { redirectTo: '/admin' });
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) ||
  Math.random().toString(36).slice(2, 8);

/** Slug guaranteed unique for the given table — avoids a unique-constraint 500. */
async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  let slug = slugify(base);
  while (await exists(slug)) {
    slug = `${slug.slice(0, 64)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return slug;
}

// ---- Testimonials CRUD ----
/** Endorsements need recorded consent to be public (REQUIRE_CONSENT_TO_PUBLISH). */
async function consentRequired(): Promise<boolean> {
  return (await getCatalogPolicy()).requireConsentToPublish;
}

export async function createTestimonial(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('content:cms');
  const quote = String(formData.get('quote') ?? '').trim().slice(0, 400);
  const author = String(formData.get('author') ?? '').trim().slice(0, 120);
  if (!quote || !author) return { ok: false, message: 'Enter the quote and who said it.' };
  const consent = consentFromForm(formData);
  const publish = !(await consentRequired()) || hasConsent(consent);
  await prisma.testimonial.create({
    data: {
      quote,
      author,
      role: (formData.get('role') as string)?.trim() || null,
      company: (formData.get('company') as string)?.trim() || null,
      rating: Math.min(5, Math.max(1, parseInt(String(formData.get('rating') ?? '5'), 10) || 5)),
      sortOrder: parseInt(String(formData.get('sortOrder') ?? '0'), 10) || 0,
      published: publish,
      ...consent,
    },
  });
  await audit('testimonial.create', author, publish ? 'published' : 'hidden: no consent recorded');
  revalidatePath('/admin/testimonials');
  revalidatePath('/');
  return publish
    ? { ok: true, message: `Testimonial from ${author} published.` }
    : { ok: true, message: `Saved as hidden. ${CONSENT_MISSING_MESSAGE}` };
}
export async function deleteTestimonial(id: string) {
  await requireCap('content:cms');
  await prisma.testimonial.delete({ where: { id } });
  await audit('testimonial.delete', id);
  revalidatePath('/admin/testimonials');
  revalidatePath('/');
}
export async function toggleTestimonial(id: string, published: boolean): Promise<{ ok: boolean; message: string }> {
  await requireCap('content:cms');
  const t = await prisma.testimonial.findUnique({ where: { id }, select: { consentBy: true, consentAt: true } });
  if (!t) return { ok: false, message: 'Testimonial not found — it may have been deleted.' };
  if (published && (await consentRequired()) && !hasConsent(t)) return { ok: false, message: CONSENT_MISSING_MESSAGE };
  await prisma.testimonial.update({ where: { id }, data: { published } });
  await audit(published ? 'testimonial.publish' : 'testimonial.hide', id);
  revalidatePath('/admin/testimonials');
  revalidatePath('/');
  return { ok: true, message: published ? 'Published.' : 'Hidden.' };
}
/** Edit in place. A blank required field keeps its old value instead of
 *  failing (bare form action: a throw would be a 500 page). */
export async function updateTestimonial(id: string, formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('content:cms');
  const quote = String(formData.get('quote') ?? '').trim().slice(0, 400);
  const author = String(formData.get('author') ?? '').trim().slice(0, 120);
  const consent = consentFromForm(formData);
  const current = await prisma.testimonial.findUnique({ where: { id }, select: { published: true } });
  if (!current) return { ok: false, message: 'Testimonial not found — it may have been deleted.' };
  const mustHide = current.published && (await consentRequired()) && !hasConsent(consent);
  await prisma.testimonial.updateMany({
    where: { id },
    data: {
      ...(quote ? { quote } : {}),
      ...(author ? { author } : {}),
      role: (formData.get('role') as string)?.trim() || null,
      company: (formData.get('company') as string)?.trim() || null,
      rating: Math.min(5, Math.max(1, parseInt(String(formData.get('rating') ?? '5'), 10) || 5)),
      sortOrder: parseInt(String(formData.get('sortOrder') ?? '0'), 10) || 0,
      ...consent,
      ...(mustHide ? { published: false } : {}),
    },
  });
  await audit('testimonial.update', id, mustHide ? 'hidden: consent removed' : undefined);
  revalidatePath('/admin/testimonials');
  revalidatePath('/');
  return mustHide ? { ok: true, message: `Saved and hidden. ${CONSENT_MISSING_MESSAGE}` } : { ok: true, message: 'Saved.' };
}

// ---- Case studies CRUD ----
export async function createCaseStudy(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('content:cms');
  const title = String(formData.get('title') ?? '').trim();
  if (!title) return { ok: false, message: 'Enter a title — a case study can’t be published without one.' };
  const slug = await uniqueSlug(title, async (s) =>
    !!(await prisma.caseStudy.findUnique({ where: { slug: s }, select: { id: true } })),
  );
  const consent = consentFromForm(formData);
  const publish = !(await consentRequired()) || hasConsent(consent);
  await prisma.caseStudy.create({
    data: {
      slug,
      title,
      customer: String(formData.get('customer') ?? '').trim() || '—',
      outcomeMetric: String(formData.get('outcomeMetric') ?? '').trim() || '—',
      excerpt: String(formData.get('excerpt') ?? '').trim() || '',
      body: String(formData.get('body') ?? '').trim() || '',
      status: publish ? 'PUBLISHED' : 'DRAFT',
      publishedAt: publish ? new Date() : null,
      ...consent,
    },
  });
  await audit('casestudy.create', title, publish ? 'published' : 'draft: no consent recorded');
  revalidatePath('/admin/case-studies');
  revalidatePath('/case-studies');
  return publish ? { ok: true, message: `Published “${title}”.` } : { ok: true, message: `Saved “${title}” as a draft. ${CONSENT_MISSING_MESSAGE}` };
}
export async function deleteCaseStudy(id: string) {
  await requireCap('content:cms');
  await prisma.caseStudy.delete({ where: { id } });
  await audit('casestudy.delete', id);
  revalidatePath('/admin/case-studies');
  revalidatePath('/case-studies');
}
export async function toggleCaseStudy(id: string, publish: boolean): Promise<{ ok: boolean; message: string }> {
  await requireCap('content:cms');
  const c = await prisma.caseStudy.findUnique({ where: { id }, select: { slug: true, consentBy: true, consentAt: true } });
  if (!c) return { ok: false, message: 'Case study not found — it may have been deleted.' };
  if (publish && (await consentRequired()) && !hasConsent(c)) return { ok: false, message: CONSENT_MISSING_MESSAGE };
  await prisma.caseStudy.update({
    where: { id },
    data: { status: publish ? 'PUBLISHED' : 'DRAFT', publishedAt: publish ? new Date() : null },
  });
  await audit(publish ? 'casestudy.publish' : 'casestudy.unpublish', c.slug);
  revalidatePath('/admin/case-studies');
  revalidatePath('/case-studies');
  revalidatePath(`/case-studies/${c.slug}`);
  return { ok: true, message: publish ? 'Published.' : 'Unpublished (draft).' };
}
/** Edit in place; the slug is kept so published links keep working. */
export async function updateCaseStudy(id: string, formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('content:cms');
  const title = String(formData.get('title') ?? '').trim();
  const cs = await prisma.caseStudy.findUnique({ where: { id }, select: { slug: true, status: true } });
  if (!cs) return { ok: false, message: 'Case study not found — it may have been deleted.' };
  const consent = consentFromForm(formData);
  const mustUnpublish = cs.status === 'PUBLISHED' && (await consentRequired()) && !hasConsent(consent);
  await prisma.caseStudy.update({
    where: { id },
    data: {
      ...(title ? { title } : {}),
      customer: String(formData.get('customer') ?? '').trim() || '—',
      outcomeMetric: String(formData.get('outcomeMetric') ?? '').trim() || '—',
      excerpt: String(formData.get('excerpt') ?? '').trim(),
      body: String(formData.get('body') ?? '').trim(),
      ...consent,
      ...(mustUnpublish ? { status: 'DRAFT' as const, publishedAt: null } : {}),
    },
  });
  await audit('casestudy.update', cs.slug, mustUnpublish ? 'unpublished: consent removed' : undefined);
  revalidatePath('/admin/case-studies');
  revalidatePath('/case-studies');
  revalidatePath(`/case-studies/${cs.slug}`);
  return mustUnpublish ? { ok: true, message: `Saved as a draft. ${CONSENT_MISSING_MESSAGE}` } : { ok: true, message: 'Saved.' };
}

// ---- Lab facilities CRUD ----
/** Optional € rate field → cents (null when blank or out of range). */
function rateCents(v: FormDataEntryValue | null): number | null {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  const n = Math.round(Number(raw) * 100);
  return Number.isFinite(n) && n >= 0 && n <= MAX_PRICE_CENTS ? n : null;
}

export async function createFacility(formData: FormData) {
  await requireCap('content:cms');
  const name = String(formData.get('name') ?? '').trim();
  const slug = await uniqueSlug(name, async (s) =>
    !!(await prisma.labFacility.findUnique({ where: { slug: s }, select: { id: true } })),
  );
  await prisma.labFacility.create({
    data: {
      slug,
      name,
      city: String(formData.get('city') ?? '').trim() || '—',
      country: String(formData.get('country') ?? '').trim() || '—',
      description: String(formData.get('description') ?? '').trim() || '',
      capabilities: String(formData.get('capabilities') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      hourlyRateCents: rateCents(formData.get('hourlyRate')),
      dailyRateCents: rateCents(formData.get('dailyRate')),
      isPublished: true,
    },
  });
  await audit('facility.create', name);
  revalidatePath('/admin/lab-rental');
  revalidatePath('/lab-rental');
}
export async function deleteFacility(id: string) {
  await requireCap('content:cms');
  await prisma.labFacility.delete({ where: { id } });
  await audit('facility.delete', id);
  revalidatePath('/admin/lab-rental');
  revalidatePath('/lab-rental');
}
export async function toggleFacility(id: string, isPublished: boolean) {
  await requireCap('content:cms');
  await prisma.labFacility.update({ where: { id }, data: { isPublished } });
  revalidatePath('/admin/lab-rental');
  revalidatePath('/lab-rental');
}
/** Edit in place, including the hourly / daily rates shown on /lab-rental. */
export async function updateFacility(id: string, formData: FormData) {
  await requireCap('content:cms');
  const name = String(formData.get('name') ?? '').trim();
  const f = await prisma.labFacility.findUnique({ where: { id }, select: { slug: true } });
  if (!f) return;
  await prisma.labFacility.update({
    where: { id },
    data: {
      ...(name ? { name } : {}),
      city: String(formData.get('city') ?? '').trim() || '—',
      country: String(formData.get('country') ?? '').trim() || '—',
      description: String(formData.get('description') ?? '').trim(),
      capabilities: String(formData.get('capabilities') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      hourlyRateCents: rateCents(formData.get('hourlyRate')),
      dailyRateCents: rateCents(formData.get('dailyRate')),
    },
  });
  await audit('facility.update', f.slug);
  revalidatePath('/admin/lab-rental');
  revalidatePath('/lab-rental');
  revalidatePath(`/lab-rental/${f.slug}`);
}

/* ── Webhook config CRUD + test-fire ─────────────────────────────────── */

export async function listWebhooks(): Promise<{
  id: string; name: string; kind: string; url: string; chatId: string | null;
  events: string[]; isActive: boolean; lastError: string | null; lastOkAt: string | null;
}[]> {
  await requireCap('settings:view');
  const rows = await prisma.webhookConfig.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    url: r.url,
    chatId: r.chatId,
    events: r.events,
    isActive: r.isActive,
    lastError: r.lastError,
    lastOkAt: r.lastOkAt ? r.lastOkAt.toISOString() : null,
  }));
}

export async function createWebhook(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('settings:write');
  const name = String(formData.get('name') ?? '').trim().slice(0, 80);
  const kind = String(formData.get('kind') ?? '').trim().toUpperCase();
  const url = String(formData.get('url') ?? '').trim().slice(0, 600);
  const chatId = String(formData.get('chatId') ?? '').trim() || null;
  const eventsRaw = String(formData.get('events') ?? '*').trim();
  // Returned, not thrown: production redacts thrown messages to a generic one.
  if (!name || !url) return { ok: false, message: 'Name and URL are required.' };
  if (!['SLACK', 'DISCORD', 'TELEGRAM'].includes(kind)) return { ok: false, message: 'Unknown webhook kind — pick Slack, Discord or Telegram.' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'The URL must start with https:// (or http://).' };
  if (kind === 'TELEGRAM' && !chatId) return { ok: false, message: 'Telegram needs a chat_id.' };
  const events = eventsRaw === '*'
    ? ['*']
    : eventsRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  await prisma.webhookConfig.create({
    data: { name, kind, url, chatId, events, isActive: true },
  });
  await audit('webhook.create', name, kind);
  revalidatePath('/admin/settings');
  return { ok: true, message: `Webhook “${name}” added — use Test fire to check it.` };
}

export async function deleteWebhook(id: string): Promise<void> {
  await requireCap('settings:write');
  await prisma.webhookConfig.delete({ where: { id } });
  await audit('webhook.delete', id);
  revalidatePath('/admin/settings');
}

export async function toggleWebhook(id: string, isActive: boolean): Promise<void> {
  await requireCap('settings:write');
  await prisma.webhookConfig.update({ where: { id }, data: { isActive } });
  revalidatePath('/admin/settings');
}

/** Test-fire — sends a synthetic ANNOUNCEMENT event to THIS hook only (it
 *  used to fan out to every active hook) and reports this hook's response. */
export async function testWebhook(id: string): Promise<{ ok: boolean; message: string }> {
  await requireCap('settings:write');
  const { sendTestWebhook } = await import('@/lib/webhooks');
  const hook = await prisma.webhookConfig.findUnique({ where: { id }, select: { isActive: true } });
  if (!hook) return { ok: false, message: 'Webhook not found.' };
  if (!hook.isActive) return { ok: false, message: 'Webhook is disabled — enable it first.' };
  const r = await sendTestWebhook(id);
  if (!r) return { ok: false, message: 'Webhook not found.' };
  return r.ok
    ? { ok: true, message: 'Test event delivered to this hook (2xx). Check your channel.' }
    : { ok: false, message: `Not delivered: ${r.error}` };
}

/** Recent notifications for the signed-in admin (bell dropdown). */
export async function getMyAdminNotifications(): Promise<{
  items: { id: string; title: string; body: string; kind: string; href: string | null; readAt: string | null; createdAt: string }[];
  unreadCount: number;
}> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { id: true, title: true, body: true, kind: true, href: true, readAt: true, createdAt: true },
    }),
    prisma.notification.count({
      where: { userId: session.user.id, readAt: null },
    }),
  ]);
  return {
    items: items.map((n) => ({
      ...n,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt ? n.readAt.toISOString() : null,
    })),
    unreadCount,
  };
}

export async function markNotificationRead(id: string): Promise<void> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await prisma.notification.updateMany({
    where: { id, userId: session.user.id, readAt: null },
    data: { readAt: new Date() },
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await prisma.notification.updateMany({
    where: { userId: session.user.id, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath('/admin');
}

/** Summary used by the product quick-view popup (clickable title in order rows). */
export async function getProductQuickSummary(slug: string): Promise<{
  slug: string;
  title: string;
  brand: string | null;
  category: string;
  condition: string;
  status: string;
  priceCents: number | null;
  currency: string;
  quantity: number;
  images: string[];
  summary: string | null;
  salesUnits: number;
  salesOrders: number;
  liveSinceISO: string;
} | null> {
  await requireCap('products:view');
  const p = await prisma.product.findUnique({
    where: { slug },
    include: {
      brand: { select: { name: true } },
      category: { select: { name: true } },
    },
  });
  if (!p) return null;
  // How many of this product have been sold in PAID+ orders.
  const sold = await prisma.orderItem.aggregate({
    where: {
      productId: p.id,
      order: { status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] } },
    },
    _sum: { quantity: true },
    _count: { _all: true },
  });
  return {
    slug: p.slug,
    title: p.title,
    brand: p.brand?.name ?? null,
    category: p.category.name,
    condition: p.condition,
    status: p.status,
    priceCents: p.priceCents,
    currency: p.currency,
    quantity: p.quantity,
    // Only our own copies (what buyers see) — never a hotlink to the supplier's server.
    images: publicProductImages(p.images),
    summary: p.summary,
    salesUnits: sold._sum.quantity ?? 0,
    salesOrders: sold._count._all,
    liveSinceISO: p.createdAt.toISOString(),
  };
}

/** Full order snapshot used by the order quick-view popup. Same data as the
 *  detail page but trimmed to what fits in a modal. */
export async function getOrderQuickDetail(id: string): Promise<{
  id: string;
  orderNumber: string;
  status: string;
  totalCents: number;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  currency: string;
  createdAtISO: string;
  paidAtISO: string | null;
  /** paidAt is a value date from the bank statement (a day, no time) — not a card payment's timestamp. */
  paidAtIsValueDate: boolean;
  shippedAtISO: string | null;
  deliveredAtISO: string | null;
  buyer: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    company: string | null;
    vat: string | null;
    repeatOrderCount: number;
    lifetimeCents: number;
  };
  // Distinct supplier names across all line items of this order — denormalised
  // so the modal can render the "from X suppliers" badge without a re-query.
  supplierNames: string[];
  shippingAddress: unknown;
  billingAddress: unknown;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  trackingLink: string | null;
  paymentMethodBrand: string | null;
  paymentMethodLast4: string | null;
  paymentMethodWallet: string | null;
  paymentMethodManual: string | null;
  paymentProofUrl: string | null;
  paymentNote: string | null;
  paidByAdminEmail: string | null;
  buyerCountry: string | null;
  buyerIp: string | null;
  adminNotes: string | null;
  archivedAt: string | null;
  archivedByEmail: string | null;
  paymentSubmittedAt: string | null;
  paymentVerificationStatus: string | null;
  paymentVerifiedAt: string | null;
  paymentVerifiedByEmail: string | null;
  paymentRejectionReason: string | null;
  /** Open holds with their staff title (compliance, VAT, address, freight, stock …) and the order-page section that resolves each (null: none there yet). */
  holds: { code: string; title: string; resolvedAt: string | null }[];
  holdNote: string | null;
  /** Why “Mark as paid” is not offered now (receipt waiting, hold, terms request), or null. */
  manualPayBlocker: string | null;
  /** The viewer may book payments (finance:manage). */
  canBookPayments: boolean;
  /** Received and kept (part payments minus approved / sent refunds). */
  receivedCents: number;
  /** Still open on an unpaid order. */
  openCents: number;
  financialStatus: string;
  billingCompany: string | null;
  billingVat: string | null;
  items: { id: string; titleSnapshot: string; brandSnapshot: string | null; priceCentsSnapshot: number; quantity: number; image: string | null; productSlug: string | null; supplierName: string | null }[];
} | null> {
  await requireCap('orders:view');
  const o = await prisma.order.findUnique({
    where: { id },
    include: {
      refunds: LIVE_REFUNDS_SELECT,
      buyer: { select: { id: true, name: true, email: true, company: { select: { name: true } } } },
      items: {
        include: {
          product: {
            select: {
              slug: true,
              images: true,
              seller: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!o) return null;
  // Buyer history (only paid orders count toward repeat + LTV — pending /
  // canceled rows would over-estimate buyer value).
  const buyerStats = await prisma.order.aggregate({
    where: {
      buyerId: o.buyer.id,
      status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] },
    },
    _count: { _all: true },
    _sum: { totalCents: true },
  });
  const ship = (o.shippingAddress as { phone?: string; company?: string; vat?: string } | null) ?? null;
  const bill = (o.billingAddress as { company?: string; vat?: string } | null) ?? null;
  const received = heldMoneyCents(o.amountPaidCents, o.refunds);
  const holdCodes = Array.from(new Set([...o.openHolds, ...(o.holdReason ? [o.holdReason] : [])]));
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    totalCents: o.totalCents,
    subtotalCents: o.subtotalCents,
    shippingCents: o.shippingCents,
    taxCents: o.taxCents,
    currency: o.currency,
    createdAtISO: o.createdAt.toISOString(),
    paidAtISO: o.paidAt?.toISOString() ?? null,
    paidAtIsValueDate: !o.stripePaymentIntentId,
    shippedAtISO: o.shippedAt?.toISOString() ?? null,
    deliveredAtISO: o.deliveredAt?.toISOString() ?? null,
    buyer: {
      id: o.buyer.id,
      name: o.buyer.name,
      email: o.buyer.email,
      phone: ship?.phone ?? null,
      company: ship?.company ?? o.buyer.company?.name ?? null,
      vat: ship?.vat ?? null,
      repeatOrderCount: buyerStats._count._all,
      lifetimeCents: buyerStats._sum.totalCents ?? 0,
    },
    supplierNames: Array.from(new Set(o.items.map((it) => it.product?.seller?.name).filter(Boolean) as string[])),
    shippingAddress: o.shippingAddress,
    billingAddress: o.billingAddress,
    trackingCarrier: o.trackingCarrier,
    trackingNumber: o.trackingNumber,
    trackingLink: buildTrackingUrl(findCarrier(configuredCarriers(), o.trackingCarrier), o.trackingNumber),
    paymentMethodBrand: o.paymentMethodBrand,
    paymentMethodLast4: o.paymentMethodLast4,
    paymentMethodWallet: o.paymentMethodWallet,
    paymentMethodManual: o.paymentMethodManual,
    // Receipts live in the private order-proofs/ prefix — hand the modal the
    // auth-gated proxy URL, never the raw bucket URL.
    paymentProofUrl: proxyProofUrl(o.paymentProofUrl),
    paymentNote: o.paymentNote,
    paidByAdminEmail: o.paidByAdminId
      ? (await prisma.user.findUnique({ where: { id: o.paidByAdminId }, select: { email: true } }))?.email ?? null
      : null,
    buyerCountry: o.buyerCountry,
    buyerIp: o.buyerIp,
    adminNotes: o.adminNotes,
    archivedAt: o.archivedAt?.toISOString() ?? null,
    archivedByEmail: o.archivedById
      ? (await prisma.user.findUnique({ where: { id: o.archivedById }, select: { email: true } }))?.email ?? null
      : null,
    paymentSubmittedAt: o.paymentSubmittedAt?.toISOString() ?? null,
    paymentVerificationStatus: o.paymentVerificationStatus,
    paymentVerifiedAt: o.paymentVerifiedAt?.toISOString() ?? null,
    paymentVerifiedByEmail: o.paymentVerifiedById
      ? (await prisma.user.findUnique({ where: { id: o.paymentVerifiedById }, select: { email: true } }))?.email ?? null
      : null,
    paymentRejectionReason: o.paymentRejectionReason,
    holds: holdCodes.map((code) => ({ code, title: holdTitle(code), resolvedAt: holdResolvedAt(code, { unpaid: o.status === 'PENDING_PAYMENT', checkoutOrder: !o.sourcingRequestId }) })),
    holdNote: o.holdNote,
    manualPayBlocker: o.status === 'PENDING_PAYMENT'
      ? manualPaymentBlocker({ holdMessage: prePaymentHoldMessage(o), holdReason: o.holdReason, openHolds: o.openHolds, paymentVerificationStatus: o.paymentVerificationStatus })
      : null,
    canBookPayments: await hasCapability('finance:manage'),
    receivedCents: received,
    openCents: Math.max(0, o.totalCents - received),
    financialStatus: o.financialStatus,
    billingCompany: (typeof bill?.company === 'string' && bill.company.trim()) || null,
    billingVat: (typeof bill?.vat === 'string' && bill.vat.trim()) || null,
    items: o.items.map((it) => ({
      id: it.id,
      titleSnapshot: it.titleSnapshot,
      brandSnapshot: it.brandSnapshot,
      priceCentsSnapshot: it.priceCentsSnapshot,
      quantity: it.quantity,
      image: firstPublicImage(it.product?.images),
      productSlug: it.product?.slug ?? null,
      supplierName: it.product?.seller?.name ?? null,
    })),
  };
}

/** Summary used by the admin Users popup. Cheap (≤10 query). */
export async function getAdminUserSummary(id: string): Promise<{
  id: string;
  name: string;
  email: string;
  role: string;
  emailVerified: boolean;
  joined: string;
  company: string | null;
  phone: string | null;
  caps: string[];
  suspended: boolean;
  /** Whether the CURRENT admin may suspend/delete (has users:manage). */
  viewerCanManage: boolean;
  /** Why suspend / delete are not offered for this account (own account, admin out of reach). */
  actionBlockedReason: string | null;
  /** null = the viewer has no permission for that part (A31: no money,
   *  orders, quotes, seller offers or chats for e.g. a support-only admin). */
  totals: {
    orders: number | null;
    spendCents: number | null;
    currency: string;
    sourcing: number | null;
    sells: number | null;
    tickets: number | null;
    threads: number | null;
    reviews: number;
    wishlist: number;
    cart: number;
    notifications: number;
  };
  recent: {
    lastOrder: { number: string; status: string; createdAt: string } | null;
    lastTicket: { ref: string; subject: string; status: string; createdAt: string } | null;
    lastSourcing: { id: string; description: string; status: string; createdAt: string } | null;
  };
} | null> {
  await requireCap('users:view');
  const viewerCanManage = await hasCapability('users:manage');
  const [canOrders, canFinance, canQuotes, canSell, canTickets, canMessages] = await Promise.all(
    ['orders:view', 'finance:view', 'quotes:view', 'sell:view', 'tickets:view', 'messages:view'].map((c) => hasCapability(c)),
  );
  const user = await prisma.user.findUnique({
    where: { id },
    include: { company: { select: { name: true } } },
  });
  if (!user) return null;
  const none = Promise.resolve([] as never[]);
  const [orders, sourcing, sells, tickets, threads, reviews, wishlist, notif, cart] = await Promise.all([
    canOrders
      ? prisma.order.findMany({
          where: { buyerId: user.id },
          orderBy: { createdAt: 'desc' },
          select: { id: true, orderNumber: true, totalCents: true, currency: true, status: true, createdAt: true },
        })
      : none,
    canQuotes
      ? prisma.sourcingRequest.findMany({
          where: { OR: [{ submittedById: user.id }, { buyerEmail: user.email }] },
          orderBy: { createdAt: 'desc' },
          select: { id: true, description: true, status: true, createdAt: true },
        })
      : none,
    canSell
      ? prisma.sellSubmission.findMany({
          where: { OR: [{ submittedById: user.id }, { email: user.email }] },
          orderBy: { createdAt: 'desc' },
          select: { id: true, phone: true, status: true, createdAt: true },
        })
      : none,
    canTickets
      ? prisma.supportTicket.findMany({
          where: { OR: [{ submittedById: user.id }, { email: user.email }] },
          orderBy: { createdAt: 'desc' },
          select: { ref: true, subject: true, status: true, createdAt: true },
        })
      : none,
    canMessages ? prisma.messageThread.count({ where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] } }) : Promise.resolve(null),
    prisma.review.count({ where: { userId: user.id } }),
    prisma.wishlistItem.count({ where: { userId: user.id } }),
    prisma.notification.count({ where: { userId: user.id } }),
    prisma.cartItem.count({ where: { userId: user.id } }),
  ]);

  const paidOrders = orders.filter((o) =>
    ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(o.status),
  );
  const spendCents = paidOrders.reduce((s, o) => s + o.totalCents, 0);
  const currency = orders[0]?.currency ?? 'EUR';
  const phone = sells.find((s) => s.phone)?.phone ?? null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    emailVerified: !!user.emailVerified,
    joined: user.createdAt.toISOString(),
    company: user.company?.name ?? null,
    phone,
    caps: user.adminCaps,
    suspended: !!user.suspendedAt,
    viewerCanManage,
    actionBlockedReason: await (async () => {
      if (!viewerCanManage) return null;
      const actor = await getActor();
      const problems = await adminTargetProblems(actor, { id: user.id, role: user.role, adminCaps: user.adminCaps }, true);
      return problems.length ? problems.join(' ') : null;
    })(),
    totals: {
      orders: canOrders ? orders.length : null,
      spendCents: canOrders && canFinance ? spendCents : null,
      currency,
      sourcing: canQuotes ? sourcing.length : null,
      sells: canSell ? sells.length : null,
      tickets: canTickets ? tickets.length : null,
      threads,
      reviews,
      wishlist,
      cart,
      notifications: notif,
    },
    recent: {
      lastOrder: orders[0]
        ? { number: orders[0].orderNumber, status: orders[0].status, createdAt: orders[0].createdAt.toISOString() }
        : null,
      lastTicket: tickets[0]
        ? { ref: tickets[0].ref, subject: tickets[0].subject, status: tickets[0].status, createdAt: tickets[0].createdAt.toISOString() }
        : null,
      lastSourcing: sourcing[0]
        ? { id: sourcing[0].id, description: sourcing[0].description, status: sourcing[0].status, createdAt: sourcing[0].createdAt.toISOString() }
        : null,
    },
  };
}

export async function setUserRole(
  userId: string,
  role: UserRole,
  preset?: string | null,
): Promise<AccessResult> {
  return changeUserRole(userId, role, preset ?? null);
}

/** Soft-suspend a user: blocks sign-in and wipes active sessions.
 *  Reversible via [[unsuspendUser]]. Admins can only be suspended by someone
 *  who can reach them (never yourself, never the last active super-admin). */
export async function suspendUser(formData: FormData): Promise<AccessResult> {
  const actor = await getActor();
  if (!(await hasCapability('users:manage'))) return { ok: false, message: 'You need the users:manage permission.' };
  const id = String(formData.get('userId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 240) || 'Suspended by admin';
  if (!id) return { ok: false, message: 'Missing user.' };
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, email: true, adminCaps: true } });
  if (!target) return { ok: false, message: 'User not found.' };
  const problems = await adminTargetProblems(actor, target, true);
  if (target.role === 'ADMIN') {
    // Refuse to suspend the LAST active admin so we don't get locked out.
    const remainingAdmins = await prisma.user.count({
      where: { role: 'ADMIN', suspendedAt: null, NOT: { id } },
    });
    if (remainingAdmins === 0) problems.push('Cannot suspend the last active admin.');
  }
  if (problems.length) return refuseAccessChange(actor, 'user.suspend', target, problems, 'suspend them');
  const step = await stepUpRequired('users.delete');
  if (step) return step;
  await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: { suspendedAt: new Date(), suspendedReason: reason },
    }),
    prisma.session.deleteMany({ where: { userId: id } }),
  ]);
  await audit('user.suspend', id, reason);
  if (target.role === 'ADMIN') {
    await alertSuperAdmins('Admin suspended', [`${actor.email} suspended the admin ${target.email}: ${reason}`], `/admin/users/${id}`);
  }
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${id}`);
  return { ok: true, message: `${target.email} is suspended and signed out everywhere.` };
}

export async function unsuspendUser(formData: FormData): Promise<AccessResult> {
  const actor = await getActor();
  if (!(await hasCapability('users:manage'))) return { ok: false, message: 'You need the users:manage permission.' };
  const id = String(formData.get('userId') ?? '');
  if (!id) return { ok: false, message: 'Missing user.' };
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true, email: true, adminCaps: true } });
  if (!target) return { ok: false, message: 'User not found.' };
  // Lifting an admin's suspension gives their access back: same reach rule.
  const problems = await adminTargetProblems(actor, target, false);
  if (problems.length) return refuseAccessChange(actor, 'user.unsuspend', target, problems, 'lift their suspension');
  await prisma.user.update({
    where: { id },
    data: { suspendedAt: null, suspendedReason: null },
  });
  await audit('user.unsuspend', id);
  if (target.role === 'ADMIN') {
    await alertSuperAdmins('Admin suspension lifted', [`${actor.email} lifted the suspension of the admin ${target.email}.`], `/admin/users/${id}`);
  }
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${id}`);
  return { ok: true, message: `${target.email} can sign in again.` };
}

/**
 * Bulk-delete selected users straight from the list. Guards: skips yourself and
 * any admin (delete those from their card so the last-admin check applies), and
 * skips anyone whose order/ticket history blocks a hard delete (FK) — those are
 * reported so the operator can suspend them instead.
 */
export async function bulkDeleteUsers(
  formData: FormData,
): Promise<{ ok: boolean; count: number; message: string } | (StepUpRequired & { count: number })> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  if (!(await hasCapability('users:manage'))) {
    return { ok: false, count: 0, message: 'You lack the users:manage permission.' };
  }
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return { ok: false, count: 0, message: 'No users selected.' };
  const step = await stepUpRequired('users.delete');
  if (step) return { ...step, count: 0 };
  const meId = session.user.id;
  const targets = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true, role: true },
  });
  let deleted = 0;
  const skipped: string[] = [];
  for (const t of targets) {
    if (t.id === meId) { skipped.push(`${t.email} (yourself)`); continue; }
    if (t.role === 'ADMIN') { skipped.push(`${t.email} (admin — delete from their card)`); continue; }
    try {
      await prisma.user.delete({ where: { id: t.id } });
      deleted++;
      await audit('user.delete', t.id, t.email);
    } catch {
      skipped.push(`${t.email} (has orders/history — suspend instead)`);
    }
  }
  revalidatePath('/admin/users');
  const parts = [`Deleted ${deleted}.`];
  if (skipped.length) {
    parts.push(`Skipped ${skipped.length}: ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '…' : ''}`);
  }
  return { ok: deleted > 0, count: deleted, message: parts.join(' ') };
}

/** Bulk-suspend selected users (reversible; wipes their sessions). Skips you
 *  and admins (suspend those from their card, where the access rules apply). */
export async function bulkSuspendUsers(
  formData: FormData,
): Promise<{ ok: boolean; count: number; message: string } | (StepUpRequired & { count: number })> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  if (!(await hasCapability('users:manage'))) {
    return { ok: false, count: 0, message: 'You lack the users:manage permission.' };
  }
  const requested = String(formData.get('ids') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .filter((id) => id !== session.user.id);
  if (!requested.length) return { ok: false, count: 0, message: 'No users selected (you can’t suspend yourself).' };
  const admins = await prisma.user.findMany({ where: { id: { in: requested }, role: 'ADMIN' }, select: { id: true } });
  const ids = requested.filter((id) => !admins.some((a) => a.id === id));
  if (!ids.length) return { ok: false, count: 0, message: 'Admins can only be suspended from their own user card.' };
  const step = await stepUpRequired('users.delete');
  if (step) return { ...step, count: 0 };
  // Who is suspended now (for the audit trail: one row per account).
  const toSuspend = await prisma.user.findMany({ where: { id: { in: ids }, suspendedAt: null }, select: { id: true, email: true } });
  const [updated] = await prisma.$transaction([
    prisma.user.updateMany({
      where: { id: { in: toSuspend.map((u) => u.id) }, suspendedAt: null },
      data: { suspendedAt: new Date(), suspendedReason: 'Suspended by admin (bulk)' },
    }),
    prisma.session.deleteMany({ where: { userId: { in: ids } } }),
  ]);
  for (const u of toSuspend) await audit('user.suspend', u.id, `bulk · ${u.email}`);
  revalidatePath('/admin/users');
  const skippedAdmins = admins.length ? ` Skipped ${admins.length} admin${admins.length === 1 ? '' : 's'} — suspend admins from their card.` : '';
  return {
    ok: updated.count > 0,
    count: updated.count,
    message: (updated.count > 0
      ? `Suspended ${updated.count} account${updated.count === 1 ? '' : 's'}.`
      : 'Nothing to suspend (already suspended?).') + skippedAdmins,
  };
}

/** Permanently delete a user and their owned data. Use only for GDPR
 *  erasure / clear spam accounts — soft-suspend is the safe default.
 *  Returns {ok, message}: refusals used to be thrown, which production shows
 *  only as the generic "Server Components render" error. */
export async function deleteUser(formData: FormData): Promise<AccessResult> {
  const actor = await getActor();
  if (!(await hasCapability('users:manage'))) return { ok: false, message: 'You need the users:manage permission.' };
  const id = String(formData.get('userId') ?? '');
  const confirm = String(formData.get('confirmEmail') ?? '').trim().toLowerCase();
  if (!id) return { ok: false, message: 'Missing user.' };
  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, adminCaps: true },
  });
  if (!target) return { ok: false, message: 'User not found.' };
  if (confirm !== target.email.toLowerCase()) {
    return { ok: false, message: 'Email confirmation did not match — nothing was deleted.' };
  }
  const problems = await adminTargetProblems(actor, target, true);
  if (target.role === 'ADMIN') {
    const remainingAdmins = await prisma.user.count({
      where: { role: 'ADMIN', NOT: { id } },
    });
    if (remainingAdmins === 0) problems.push('Cannot delete the last admin.');
  }
  if (problems.length) return refuseAccessChange(actor, 'user.delete', target, problems, 'delete the account');
  // Orders reference the buyer without a cascade (kept for the money trail):
  // an account with orders is ANONYMISED (GDPR erasure) — personal data
  // removed, invoices / orders kept for the fiscal retention period.
  const orderCount = await prisma.order.count({ where: { buyerId: id } });
  if (orderCount > 0) {
    const { erasurePlan, eraseAccount } = await import('@/lib/security/gdpr-erase');
    const plan = await erasurePlan(id, { forStaff: true });
    if (plan.blockers.length) return { ok: false, message: `Not deleted: ${plan.blockers.join(' ')}` };
    const step = await stepUpRequired('users.delete');
    if (step) return step;
    const r = await eraseAccount(id, { kind: 'STAFF', id: actor.id, email: actor.email }, 'Deleted by staff (GDPR request)');
    revalidatePath('/admin/users');
    return r.ok ? { ok: true, message: `${target.email} has ${orderCount} order${orderCount === 1 ? '' : 's'}, so the account was anonymised: ${r.message}` } : r;
  }
  const step = await stepUpRequired('users.delete');
  if (step) return step;
  // Cascading via FK onDelete handles sessions, accounts, wishlists, cart,
  // notifications, reviews. Records that reference the user WITHOUT a cascade
  // (authored content, seller chats, …) make the delete fail below.
  try {
    await prisma.user.delete({ where: { id } });
  } catch {
    return {
      ok: false,
      message: 'Delete blocked — this account still owns records that must be kept (content, conversations or history). Suspend the account instead.',
    };
  }
  await audit('user.delete', id, target.email);
  if (target.role === 'ADMIN') {
    await alertSuperAdmins('Admin account deleted', [`${actor.email} deleted the admin account ${target.email}.`]);
  }
  revalidatePath('/admin/users');
  return { ok: true, message: `${target.email} was deleted.` };
}

/** Send the user a password-reset email (admin-initiated). Useful when a
 *  customer can't get the link themselves. Email is sent via the same
 *  Better-Auth pipeline as the public "forgot password" flow, called
 *  in-process with its own per-account / per-admin caps. */
export async function adminSendPasswordReset(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireCap('users:manage');
  await ensureSettingsLoaded();
  const id = String(formData.get('userId') ?? '');
  if (!id) return { ok: false, message: 'Missing user.' };
  const target = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!target) return { ok: false, message: 'User not found.' };
  const transport = emailTransportStatus();
  if (!transport.configured) {
    return { ok: false, message: `Not sent — ${transport.problem ?? 'email is not configured'}.` };
  }
  const since = new Date();
  try {
    await sendAdminPasswordReset(session.user.id, { id, email: target.email });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : 'Reset request failed.' };
  }
  await audit('user.adminreset', id, target.email);
  // better-auth swallows mail errors inside the reset endpoint, so read the
  // e-mail log to say what really happened.
  const log = await prisma.emailLog.findFirst({
    where: { toAddr: target.email, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { status: true, error: true },
  });
  if (log && log.status !== 'sent') {
    return { ok: false, message: `The reset e-mail to ${target.email} could not be delivered: ${log.error ?? log.status}.` };
  }
  return {
    ok: true,
    message:
      transport.mode === 'dev-capture'
        ? `Reset link sent to the development mailbox (${target.email}) — this server does not deliver to real inboxes.`
        : `Reset e-mail sent to ${target.email} via ${transport.label}.`,
  };
}

/** Replace a user's admin capability set (preset or checkboxes). */
export async function setUserCaps(formData: FormData): Promise<AccessResult> {
  const userId = String(formData.get('userId') ?? '');
  const preset = String(formData.get('preset') ?? '').trim() || null;
  const raw = formData.getAll('cap').map((v) => String(v));
  if (!userId) return { ok: false, message: 'Missing user.' };
  return changeUserCaps(userId, preset, raw);
}

/** Lost authenticator: reset someone's two-factor sign-in (they set it up again). */
export async function resetTwoFactorForUser(formData: FormData): Promise<AccessResult> {
  const userId = String(formData.get('userId') ?? '');
  if (!userId) return { ok: false, message: 'Missing user.' };
  return resetUserTwoFactor(userId);
}

const LISTING_STATUS_TEXT: Record<string, { subject: string; line: string }> = {
  PUBLISHED: { subject: 'is live', line: 'Our team published your listing — buyers can now find it in the marketplace.' },
  PENDING_REVIEW: { subject: 'is back in review', line: 'Our team took your listing offline for another review; it is not visible to buyers until it is published again.' },
  DRAFT: { subject: 'was returned to draft', line: 'Our team took your listing offline and returned it to draft; it is not visible to buyers. You can correct it and submit it again.' },
  ARCHIVED: { subject: 'was archived', line: 'Our team archived your listing; it is no longer visible to buyers.' },
};

/**
 * Staff changed the status of a supplier's listing (publish, back to draft or
 * review, archive): the supplier is told in-app and by e-mail, with the reason
 * when one was given. Own-inventory listings (seller not a SELLER account)
 * notify nobody. Returns a sentence for the staff message; never throws.
 */
async function noticeListingModeration(product: { slug: string; title: string; sellerId: string }, status: string, reason: string | null): Promise<string> {
  const text = LISTING_STATUS_TEXT[status];
  if (!text) return '';
  try {
    const seller = await prisma.user.findUnique({ where: { id: product.sellerId }, select: { id: true, role: true, email: true, name: true } });
    if (!seller || seller.role !== 'SELLER') return '';
    await ensureSettingsLoaded();
    const subject = `Your listing “${product.title.slice(0, 80)}” ${text.subject}`;
    await notifyUser(seller.id, subject, `${text.line}${reason ? ` Reason: ${reason.slice(0, 200)}` : ''}`, '/app/seller/products');
    const mail = await trySendEmail({
      to: seller.email,
      subject,
      html: mailLayout({
        heading: subject,
        body: [
          `Hi <span dir="auto">${escapeHtml(seller.name || 'there')}</span>,`,
          escapeHtml(text.line),
          ...(reason ? [`<p style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #0E4F40;background:#f3f4f6;" dir="auto"><strong>Reason:</strong> ${escapeHtmlLines(reason)}</p>`] : []),
        ],
        cta: status === 'PUBLISHED'
          ? { href: `${siteBase()}/marketplace/${product.slug}`, label: 'View the listing' }
          : { href: `${siteBase()}/app/seller/products`, label: 'Open your listings' },
      }),
      text: `${text.line}${reason ? `\n\nReason: ${reason}` : ''}`,
    }, 'products:moderation');
    return mail.ok ? ' The supplier was notified.' : ` The supplier was notified in-app; the e-mail could not be delivered (${mail.error}).`;
  } catch {
    return '';
  }
}

/** Publishing or unpublishing a listing is moderation: products:approve. */
function moderationNeeded(from: string, to: string): boolean {
  return from !== to && (to === 'PUBLISHED' || from === 'PUBLISHED');
}
const NEEDS_APPROVE = 'Publishing or unpublishing a listing needs the “Approve / reject listings” permission (products:approve). Save it as Draft or Pending review instead — a moderator publishes it.';

/** Moderation: publish, archive or send back to draft / review, with an optional reason for the supplier. */
export async function setProductStatus(
  slug: string,
  status: 'PUBLISHED' | 'ARCHIVED' | 'DRAFT' | 'PENDING_REVIEW',
  reason?: string | null,
): Promise<{ ok: boolean; message: string }> {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  if (!(await hasCapability('products:approve'))) return { ok: false, message: NEEDS_APPROVE };
  if (!['PUBLISHED', 'ARCHIVED', 'DRAFT', 'PENDING_REVIEW'].includes(status)) return { ok: false, message: 'Unknown status.' };
  const cur = await prisma.product.findUnique({ where: { slug }, select: { slug: true, title: true, sellerId: true, status: true } });
  if (!cur) return { ok: false, message: 'Product not found.' };
  if (cur.status === status) return { ok: true, message: 'Nothing changed.' };
  const why = (reason ?? '').trim().slice(0, 500) || null;
  await prisma.product.update({ where: { slug }, data: { status } });
  await audit('product.status', slug, `${cur.status} → ${status}${why ? ` · ${why}` : ''}`.slice(0, 500));
  const told = await noticeListingModeration(cur, status, why);
  revalidatePath('/admin/products');
  revalidatePath(`/marketplace/${slug}`);
  return { ok: true, message: `Status set to ${status.toLowerCase().replace('_', ' ')}.${told}` };
}

/** In-place price / quantity / status edit from the admin product popup.
 *  Returns {ok,message} so the modal can render a confirmation without a
 *  full-page reload. Price / quantity are edits (products:edit); publishing or
 *  unpublishing is moderation (products:approve) and tells the supplier. */
export async function quickUpdateProduct(
  slug: string,
  patch: { priceCents?: number | null; quantity?: number; status?: 'DRAFT' | 'PENDING_REVIEW' | 'PUBLISHED' | 'ARCHIVED'; reason?: string | null },
): Promise<{ ok: boolean; message: string }> {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  const editsData = patch.priceCents !== undefined || patch.quantity !== undefined;
  const [canEdit, canApprove] = await Promise.all([hasCapability('products:edit'), hasCapability('products:approve')]);
  if (editsData && !canEdit) return { ok: false, message: 'Changing the price or quantity needs the products:edit permission.' };
  if (!canEdit && !canApprove) return { ok: false, message: 'Changing a listing needs the products:edit or products:approve permission.' };
  const data: Record<string, unknown> = {};
  if (patch.priceCents !== undefined) {
    if (patch.priceCents === null) {
      data.priceCents = null;
    } else {
      const n = Math.round(Number(patch.priceCents));
      if (!Number.isFinite(n) || n < 0 || n > 100_000_000)
        return { ok: false, message: 'Price out of range (0 – 1,000,000.00).' };
      data.priceCents = n;
    }
  }
  if (patch.quantity !== undefined) {
    const q = Number(patch.quantity);
    if (!Number.isInteger(q) || q < 0 || q > 100_000)
      return { ok: false, message: 'Quantity must be a whole number between 0 and 100,000.' };
    data.quantity = q;
  }
  if (patch.status !== undefined) {
    if (!['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED'].includes(patch.status))
      return { ok: false, message: 'Unknown status.' };
    data.status = patch.status;
  }
  if (Object.keys(data).length === 0) return { ok: false, message: 'Nothing to update.' };
  const cur = await prisma.product.findUnique({
    where: { slug },
    select: { slug: true, title: true, sellerId: true, status: true, externalId: true, lockedFields: true, priceCents: true, pendingPriceCents: true, priceOnHold: true },
  });
  if (!cur) return { ok: false, message: 'Product not found.' };
  const nextStatus = typeof data.status === 'string' && data.status !== cur.status ? data.status : null;
  if (!nextStatus) delete data.status;
  if (nextStatus && moderationNeeded(cur.status, nextStatus) && !canApprove) return { ok: false, message: NEEDS_APPROVE };
  if (data.priceCents !== undefined && data.priceCents !== cur.priceCents) {
    // A manual price on a supplier-synced product locks the price (field ownership).
    if (cur.externalId && !cur.lockedFields.includes('price')) data.lockedFields = [...cur.lockedFields, 'price'];
    // Staff setting the price decide a pending supplier price change too (as on the edit page).
    if (cur.pendingPriceCents !== null || cur.priceOnHold) {
      Object.assign(data, { pendingPriceCents: null, pendingPriceCurrency: null, pendingPriceAt: null, pendingPriceNote: null, priceOnHold: false });
    }
  }
  if (Object.keys(data).length === 0) return { ok: true, message: 'Nothing changed.' };
  try {
    await prisma.product.update({ where: { slug }, data });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : 'Update failed.' };
  }
  await audit('product.quickupdate', slug, `${Object.keys(data).join(',')}${nextStatus ? ` ${cur.status} → ${nextStatus}` : ''}`);
  const told = nextStatus ? await noticeListingModeration(cur, nextStatus, (patch.reason ?? '').trim().slice(0, 500) || null) : '';
  revalidatePath('/admin/products');
  revalidatePath(`/marketplace/${slug}`);
  return { ok: true, message: `Saved.${told}` };
}

/** Un-verify in one click. Verifying needs a written note of what was
 *  checked, so it goes through verifyShop (Admin → Shops → shop page). */
export async function setCompanyVerified(slug: string, verified: boolean): Promise<{ ok: boolean; message: string }> {
  await requireCap('companies:manage');
  if (verified) {
    return { ok: false, message: 'Open the shop page to verify it — record what you checked (KvK, VAT, references…).' };
  }
  await prisma.company.update({
    where: { slug },
    data: { isVerified: false, verifiedAt: null, verifiedByEmail: null, verificationNote: null },
  });
  await audit('company.unverify', slug);
  revalidatePath('/admin/companies');
  return { ok: true, message: 'No longer verified.' };
}

export async function testIntegration(
  kind: 'resend' | 'stripe' | 'ai' | 'storage',
): Promise<{ ok: boolean; message: string }> {
  await requireCap('settings:view');
  await ensureSettingsLoaded();
  try {
    if (kind === 'resend') {
      const key = process.env.RESEND_API_KEY;
      if (!key) return { ok: false, message: 'No Resend key set.' };
      const r = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const data = (await r.json().catch(() => null)) as { data?: { name: string; status: string }[] } | null;
        const verified = (data?.data ?? []).filter((d) => d.status === 'verified').map((d) => d.name);
        return {
          ok: true,
          message: verified.length
            ? `Resend key valid — verified domain(s): ${verified.join(', ')}.`
            : 'Resend key valid — email delivery is live.',
        };
      }
      // A Resend "Sending access" key CAN send but is not allowed to read
      // /domains (401/403). That's expected, not a bad key — the real proof of
      // delivery is the "Send test email" button, so surface it as a note
      // rather than a red "rejected".
      if (r.status === 401 || r.status === 403) {
        return {
          ok: true,
          message: 'Sending-only key — can’t list domains here, but it can send. Use “Send test email” to confirm delivery.',
        };
      }
      return { ok: false, message: `Resend rejected the key (HTTP ${r.status}).` };
    }
    if (kind === 'stripe') {
      const stripe = getStripe();
      if (!stripe) return { ok: false, message: 'No Stripe secret key set.' };
      const bal = await stripe.balance.retrieve();
      return { ok: true, message: `Stripe connected (currencies: ${bal.available.map((a) => a.currency).join(', ') || 'n/a'}).` };
    }
    if (kind === 'ai') {
      const c = aiConfig();
      if (!c.key) return { ok: false, message: 'No AI API key set.' };
      const r = await fetch(`${c.base}/models`, {
        headers: { Authorization: `Bearer ${c.key}` },
        signal: AbortSignal.timeout(15000),
      });
      return r.ok
        ? { ok: true, message: `AI provider reachable (model: ${c.model}).` }
        : { ok: false, message: `AI provider rejected the key (HTTP ${r.status}).` };
    }
    if (kind === 'storage') {
      await ensureBucket();
      return { ok: true, message: 'Object storage reachable and bucket ready.' };
    }
    return { ok: false, message: 'Unknown test.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 180) : 'Connection failed.' };
  }
}

/**
 * End-to-end email test: sends a real message to the signed-in admin's own
 * address through whatever transport is currently configured (Resend if a key
 * is set, otherwise SMTP, otherwise the dev mailbox). Reports which path was
 * used so the operator can tell Resend is overriding their SMTP config, and
 * surfaces the raw transport error (auth failed / connection refused / etc.)
 * when delivery fails. sendEmail() also writes an EmailLog row either way.
 */
export async function sendTestEmail(): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await ensureSettingsLoaded();
  const to = (session.user.email || '').trim();
  if (!to) return { ok: false, message: 'Your admin account has no email address to send to.' };

  const transport = emailTransportStatus();
  if (!transport.configured) {
    return { ok: false, message: `Not sent — e-mail is not configured: ${transport.problem}.` };
  }
  const via = transport.label;

  const site = process.env.SITE_NAME?.trim() || 'Labtodate';
  try {
    await sendEmail({
      to,
      trigger: 'admin',
      subject: `${site} — test email ✅`,
      html:
        '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
        '<h2 style="margin:0 0 8px;color:#0E4F40;">Your email is working 🎉</h2>' +
        `<p style="color:#374151;line-height:1.6;">This is a test message from your ${escapeHtml(site)} admin settings. ` +
        `Delivered via <strong>${escapeHtml(via)}</strong>.</p>` +
        '<p style="color:#6b7280;font-size:13px;">If this landed in your inbox, outbound email is configured correctly.</p>' +
        '</div>',
      text: `Your ${site} email is working. Delivered via ${via}.`,
    });
    return { ok: true, message: `Sent to ${to} via ${via}. Check your inbox (and spam folder).` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 220) : 'Send failed.' };
  }
}

export async function verifySetting(
  key: string,
): Promise<{ ok: boolean; message: string }> {
  await requireCap('settings:view');
  await ensureSettingsLoaded();
  const def = SETTING_DEFS.find((d) => d.key === key) as
    | { key: string; verify?: string }
    | undefined;
  const verify = def && 'verify' in def ? def.verify : undefined;
  if (!def || !verify) return { ok: false, message: 'Nothing to verify for this field.' };

  const rows = await prisma.setting.findMany({ where: { key } });
  const val = (rows[0]?.value || process.env[key] || '').trim();
  if (!val) return { ok: false, message: 'Empty — save a value first, then verify.' };

  try {
    if (verify === 'email') {
      const m = val.match(/^[^@\s]+@([^@\s]+\.[^@\s]+)$/);
      if (!m) return { ok: false, message: `“${val}” is not a valid email address.` };
      const dns = await import('dns');
      const mx = await dns.promises.resolveMx(m[1]).catch(() => [] as { exchange: string }[]);
      return mx.length > 0
        ? { ok: true, message: `Valid — ${m[1]} accepts mail (MX: ${mx[0].exchange}).` }
        : { ok: false, message: `Format OK but domain “${m[1]}” has no MX record — mail will bounce.` };
    }
    if (verify === 'number') {
      const n = Number(val);
      return Number.isFinite(n) && n >= 0
        ? { ok: true, message: `Parses as ${n}.` }
        : { ok: false, message: `“${val}” is not a valid non-negative number.` };
    }
    if (verify === 'url' || verify === 'image') {
      // A site-relative image path (an uploaded logo is stored as /media/…) is
      // accepted on Save — check it on this site, resolved exactly like the
      // invoice does (`${BETTER_AUTH_URL}${path}`), instead of rejecting it as
      // "not a valid URL". The host is our own configured origin, never the
      // setting's value, so this needs no SSRF guard (and the dev origin is
      // localhost, which safeFetch would refuse); redirects are not followed.
      if (verify === 'image' && isSiteRelativePath(val)) {
        const origin = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
        if (!origin) return { ok: false, message: 'Site-relative path, but the site address (BETTER_AUTH_URL) is not set — enter a full https:// URL instead.' };
        const target = new URL(`${origin}${val}`);
        if (target.origin !== new URL(origin).origin) return { ok: false, message: `“${val}” is not a valid path on this site.` };
        const r = await fetch(target, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(12000) });
        await r.body?.cancel().catch(() => {});
        if (r.status < 200 || r.status >= 300) return { ok: false, message: `Not found on this site — HTTP ${r.status} for ${target.pathname}.` };
        const ct = r.headers.get('content-type') || '';
        return ct.startsWith('image/')
          ? { ok: true, message: `Reachable image on this site (${ct}).` }
          : { ok: false, message: `Reachable but not an image (content-type: ${ct || 'unknown'}).` };
      }
      let u: URL;
      try {
        u = new URL(val);
      } catch {
        return { ok: false, message: `“${val}” is not a valid URL (include https://).` };
      }
      // SSRF guard: same fetcher as the URL importer — refuses private,
      // loopback, link-local / cloud-metadata addresses and re-checks every
      // redirect hop, so Verify can't be used to probe internal services.
      const { safeFetch, SafeFetchError } = await import('@/lib/import/safe-fetch');
      let r: Awaited<ReturnType<typeof safeFetch>>;
      try {
        r = await safeFetch(u.toString(), { timeoutMs: 12000, maxBytes: 5 * 1024 * 1024 });
      } catch (e) {
        if (e instanceof SafeFetchError && (e.code === 'PRIVATE_IP' || e.code === 'BAD_SCHEME')) {
          return { ok: false, message: 'Blocked — only public http(s) addresses can be checked from the server.' };
        }
        throw e;
      }
      if (r.status < 200 || r.status >= 300) return { ok: false, message: `Unreachable — HTTP ${r.status} from ${u.host}.` };
      if (verify === 'image') {
        const ct = r.contentType || '';
        return ct.startsWith('image/')
          ? { ok: true, message: `Reachable image (${ct}).` }
          : { ok: false, message: `Reachable but not an image (content-type: ${ct || 'unknown'}).` };
      }
      return { ok: true, message: `Reachable (HTTP ${r.status} from ${u.host}).` };
    }
    return { ok: false, message: 'Unknown verification type.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 180) : 'Verification failed.' };
  }
}

// Group names of the B00 registry (src/lib/settings/defs.ts), where
// 'Payments' became 'Payments & credit terms'. Whole groups whose every change
// needs a fresh authenticator code: where money and mail go, and everything
// fiscal — VAT rules, numbering, document texts and record retention.
const SENSITIVE_SETTING_GROUPS: readonly string[] = [
  'Email', 'Payments & credit terms', 'Company', 'Acquisitions',
  'Tax & VAT', 'Invoicing & numbering', 'Documents & legal texts',
];

/** Needs a fresh authenticator code: a sensitive group, or any key marked sensitive. */
function stepUpSetting(d: { group: string; sensitive?: boolean }): boolean {
  return SENSITIVE_SETTING_GROUPS.includes(d.group) || !!d.sensitive;
}

/** Does this submit change (or clear) a bank / company / e-mail / payment / fiscal setting? */
async function touchesSensitiveSettings(input: Record<string, string>): Promise<boolean> {
  const current = await getEffectiveSettings();
  return SETTING_DEFS.some((d) => {
    if (!stepUpSetting(d)) return false;
    if (input[`__clear_${d.key}`] === 'on') return true;
    if (!(d.key in input)) return false;
    // Compared in the stored unit: money fields are shown in euros, stored in cents.
    const v = normaliseInput(d, input[d.key] ?? '');
    if (d.secret) return v !== '';
    return v !== (current[d.key] ?? '').replace(/\r\n/g, '\n').trim();
  });
}

export async function saveAdminSettings(
  _prev: { ok: boolean; message: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  // Must be an admin (redirect if not signed in), but a missing settings:write
  // cap returns a clear message instead of a mysterious redirect to /admin —
  // that redirect was the "save makes the page jump away" symptom.
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  if (!(await hasCapability('settings:write'))) {
    return { ok: false, message: 'Your admin account lacks the “settings:write” permission — ask a super-admin to grant it.' };
  }
  const input: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === 'string') input[k] = v;
  }
  // Security-policy keys are registered in the same registry but are saved
  // only by saveSecurityPolicy (security:manage + step-up), never here.
  const policyKeys = Object.keys(input).map((k) => k.replace(/^__clear_/, '')).filter(isSecurityPolicyKey);
  if (policyKeys.length) {
    return { ok: false, message: 'Security settings are saved on the Security tab (needs security:manage and an authenticator code). Nothing was saved.' };
  }
  // Bank, company, e-mail, payment and fiscal settings (VAT, numbering,
  // document texts, retention) decide where money and mail go and what the
  // tax documents say: changing them needs a fresh authenticator code.
  if (await touchesSensitiveSettings(input)) {
    const step = await stepUpRequired('settings.sensitive');
    if (step) return step;
  }
  const session = await getServerSession();
  const actor = await settingActor(session?.user.id ?? null, session?.user.email ?? null);
  let saved: Awaited<ReturnType<typeof persistSettings>>;
  try {
    saved = await persistSettings(input, actor);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Save failed: ${e.message.slice(0, 900)}` : 'Save failed.' };
  }
  if (saved.changedKeys.length) await audit('settings.save', undefined, saved.changedKeys.join(','));
  if (saved.sensitiveChanged.length) {
    await notifyAdmins(
      `Sensitive settings changed by ${actor.email ?? 'an admin'}`,
      `${saved.sensitiveChanged.join(', ')} — see Settings → Change history.`,
      '/admin/settings?tab=Change%20history',
      'SYSTEM',
    );
  }
  await alertIdentityChange(actor.email ?? null, saved.changedKeys);
  revalidatePath('/admin/settings');
  // Say what actually happened: "Saved ✓" only when something was written,
  // and name fields that now use (or can only be removed in) the server .env.
  const list = (labels: string[]) => labels.map((l) => `“${l}”`).join(', ');
  const parts = [saved.changed.length || saved.envDefault.length || saved.registryDefault.length ? 'Saved ✓' : 'Nothing changed.'];
  if (saved.envDefault.length) {
    parts.push(`${list(saved.envDefault)} now ${saved.envDefault.length === 1 ? 'uses' : 'use'} the default value (from the server .env when it sets one, otherwise the built-in default).`);
  }
  if (saved.registryDefault.length) {
    parts.push(`${list(saved.registryDefault)} now ${saved.registryDefault.length === 1 ? 'uses' : 'use'} the default value.`);
  }
  if (saved.envKept.length) {
    parts.push(
      `${list(saved.envKept)} ${saved.envKept.length === 1 ? 'comes' : 'come'} from the server .env, so emptying it here removed nothing — change it in the .env file.`,
    );
  }
  return { ok: true, message: parts.join(' ') };
}

/**
 * Bank and identity changes (BANK_*, COMPANY_* — what every new proforma and
 * invoice prints, and where buyers send money) also e-mail the super-admins,
 * not only the in-app notice: a changed IBAN nobody agreed is the classic
 * payment fraud. Never throws.
 */
async function alertIdentityChange(actorEmail: string | null, keys: string[]): Promise<void> {
  const hit = keys.filter((k) => /^(BANK_|COMPANY_)/.test(k));
  if (!hit.length) return;
  await alertSuperAdmins('Bank or company details changed', [
    `${actorEmail ?? 'An admin'} changed: ${hit.map((k) => settingDef(k)?.label ?? k).join(', ')}.`,
    'These details are printed on new proformas, invoices and credit notes. If the change was not agreed, revert it in Settings → Change history and check that admin account.',
  ], '/admin/settings?tab=Change%20history');
}

export async function uploadCompanyLogo(
  _prev: { ok: boolean; message: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  // Same gate as saveAdminSettings: a missing cap is a message, not a redirect.
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  if (!(await hasCapability('settings:write'))) {
    return { ok: false, message: 'Your admin account lacks the “settings:write” permission — ask a super-admin to grant it.' };
  }
  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: 'Choose a logo file first.' };
  // Raster images only, checked by the file's bytes: an SVG logo could carry
  // script, and a non-image would show as a broken logo on every invoice.
  const checked = await readVerifiedUpload(file, { allow: ['png', 'jpeg', 'webp'], maxBytes: 2 * 1024 * 1024, label: 'Logo' });
  if (!checked.ok) return { ok: false, message: checked.error };
  // The logo is printed on every proforma, invoice and credit note (a Company
  // setting): the same fresh authenticator code as the other Company fields.
  const step = await stepUpRequired('settings.sensitive');
  if (step) return step;
  const { buf, mime, ext } = checked.upload;
  const s2 = await getServerSession();
  const actor = await settingActor(s2?.user.id ?? null, s2?.user.email ?? null);
  let changed: string[] = [];
  try {
    // Under products/ because that is the prefix the bucket policy makes
    // public; invoices and emails load the logo anonymously.
    const { url } = await uploadObject(`products/branding/logo-${Date.now()}.${ext}`, buf, mime);
    changed = (await persistSettings({ COMPANY_LOGO_URL: url }, actor)).changedKeys;
    await audit('settings.logo', undefined, url);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Upload failed: ${e.message.slice(0, 140)}` : 'Upload failed.' };
  }
  if (changed.length) {
    await notifyAdmins(
      `Sensitive settings changed by ${actor.email ?? 'an admin'}`,
      'COMPANY_LOGO_URL (the logo on proformas, invoices and credit notes) — see Settings → Change history.',
      '/admin/settings?tab=Change%20history',
      'SYSTEM',
    );
    await alertIdentityChange(actor.email ?? null, changed);
  }
  revalidatePath('/admin/settings');
  return { ok: true, message: 'Logo updated ✓' };
}

export async function saveHomepage(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('content:cms');
  // The seven stations are always shown in their fixed order (the 3D story is built on it); only the extra modules
  // below the story are switched on and ordered here. None switched on is a valid choice.
  const enabled: string[] = HOME_EXTRAS.filter((k) => formData.get(`enabled_${k}`) === 'on');
  enabled.sort((a, b) => {
    const oa = parseInt(String(formData.get(`order_${a}`) ?? '99'), 10) || 99;
    const ob = parseInt(String(formData.get(`order_${b}`) ?? '99'), 10) || 99;
    return oa - ob;
  });
  const sections = enabled.join(',');
  const popular = String(formData.get('popular') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(',');

  const txt = (k: string) => String(formData.get(k) ?? '').replace(/\r\n/g, '\n').trim();
  // A value identical to the built-in default is stored as "unset", so only
  // real edits land in Setting (and later default-copy changes still apply).
  const custom = (k: string, def: string) => (txt(k) === def ? '' : txt(k));
  const d = HOME_DEFAULTS;

  // Stats: empty = live catalogue counts. Never store the old zero
  // placeholder block (a stale editor tab may still post it).
  let stats = txt('heroStats');
  if (stats === d.stats.map((s) => `${s.value}|${s.suffix}|${s.label}`).join('\n')) stats = '';
  if (stats) {
    const bad = stats.split('\n').map((l) => l.trim()).find((l) => l && !parseHeroStats(l));
    if (bad !== undefined) {
      return {
        ok: false,
        message: `Stats line “${bad.slice(0, 60)}” isn’t in the value|suffix|label format (e.g. 12400|+|instruments listed). Fix it, or empty the box to show live counts. Nothing was saved.`,
      };
    }
  }

  for (const [key, value] of [
    ['HOMEPAGE_SECTIONS', sections],
    ['HOMEPAGE_SECTIONS_V', sections ? HOME_ORDER_VERSION : ''],
    ['HOMEPAGE_POPULAR', popular === d.popular.join(',') ? '' : popular],
    ['HERO_BADGE', custom('heroBadge', d.heroBadge)],
    ['HERO_TITLE', custom('heroTitle', d.heroTitle)],
    ['HERO_ACCENT', custom('heroAccent', d.heroAccent)],
    ['HERO_SUBTITLE', custom('heroSubtitle', d.heroSubtitle)],
    ['HERO_STATS', stats],
    ['TEST_HEADING', custom('testHeading', d.testHeading)],
    ['TEST_META', custom('testMeta', d.testMeta)],
    ['CTA_HEADING', custom('ctaHeading', d.ctaHeading)],
    ['CTA_SUBTITLE', custom('ctaSubtitle', d.ctaSubtitle)],
    // the stations' texts (one field each)
    ...HOME_TEXT_FIELDS.map((f) => [f.key, custom(f.field, String(d[f.field] ?? ''))] as const),
  ]) {
    if (value) {
      await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
      process.env[key] = value;
    } else {
      await prisma.setting.deleteMany({ where: { key } });
      delete process.env[key];
    }
  }
  await audit('homepage.save', undefined, sections);
  revalidatePath('/');
  revalidatePath('/admin/homepage');
  return {
    ok: true,
    message: `Homepage saved — the seven stations${enabled.length ? ` + ${enabled.length} extra module${enabled.length === 1 ? '' : 's'}` : ''}${stats ? '' : ', stats show live counts'}. Click ↻ Refresh in the preview to see it.`,
  };
}

/**
 * Broadcast an announcement / offer (A19): in-app to the audience at once;
 * e-mail only to people who may receive it (consent / soft opt-in for
 * marketing, verified + active always), queued and sent in the background
 * with unsubscribe link + List-Unsubscribe headers and the legal footer.
 * Staff accounts are never part of the audience.
 */
export async function sendAnnouncement(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  const session = await requireCap('content:cms');
  await ensureSettingsLoaded();
  const title = String(formData.get('title') ?? '').trim().slice(0, 140);
  const body = String(formData.get('body') ?? '').trim().slice(0, 5000);
  const href = String(formData.get('href') ?? '').trim() || null;
  const kind = (String(formData.get('kind') ?? 'ANNOUNCEMENT') || 'ANNOUNCEMENT').toUpperCase();
  const audience = String(formData.get('audience') ?? 'ALL');
  const alsoEmail = formData.get('email') === 'on';
  // Returned, not thrown — a thrown error replaced the whole admin page.
  if (title.length < 3 || body.length < 3) {
    return { ok: false, message: 'Title and message are required (at least 3 characters each, not just spaces).' };
  }
  if (/[⟨⟩]/.test(`${title} ${body}`)) {
    return { ok: false, message: 'Replace the ⟨…⟩ placeholders from the template with the real details first — nothing was sent.' };
  }
  if (!['OFFER', 'ANNOUNCEMENT', 'SYSTEM'].includes(kind)) return { ok: false, message: 'Unknown announcement type.' };
  if (!['ALL', 'BUYER', 'SELLER'].includes(audience)) return { ok: false, message: 'Unknown audience.' };
  const linkProblem = href ? announcementLinkProblem(href) : null;
  if (linkProblem) return { ok: false, message: `${linkProblem} Nothing was sent.` };
  if (alsoEmail) {
    if (!(await hasCapability('marketing:send'))) {
      return { ok: false, message: 'E-mailing customers needs the marketing:send permission — send it in-app only, or ask a super-admin.' };
    }
    const step = await stepUpRequired('marketing.send');
    if (step) return step;
  }
  const r = await queueAnnouncement({
    title,
    body,
    href,
    kind: kind as 'OFFER' | 'ANNOUNCEMENT' | 'SYSTEM',
    audience: audience as 'ALL' | 'BUYER' | 'SELLER',
    email: alsoEmail,
    createdById: session.user.id,
    createdByEmail: session.user.email,
  });
  if (!r.ok) return r;
  await audit('announcement.send', audience, title);
  if (alsoEmail) after(() => kickAnnouncementWorker());
  revalidatePath('/admin/announcements');
  revalidatePath('/app/notifications');
  return { ok: true, message: r.message };
}

/** Stop a queued / running e-mail broadcast (already sent e-mails can't be recalled). */
export async function cancelAnnouncementJob(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('marketing:send');
  const id = String(formData.get('jobId') ?? '');
  const r = await prisma.announcementJob.updateMany({
    where: { id, status: { in: ['QUEUED', 'RUNNING', 'FAILED'] } },
    data: { status: 'CANCELLED', finishedAt: new Date() },
  });
  if (!r.count) return { ok: false, message: 'This broadcast has already finished.' };
  await prisma.announcementDelivery.updateMany({ where: { jobId: id, status: 'PENDING' }, data: { status: 'SKIPPED', reason: 'broadcast cancelled' } });
  await audit('announcement.cancel', id);
  revalidatePath('/admin/announcements');
  return { ok: true, message: 'Cancelled — e-mails not yet sent will not go out.' };
}

/** Resume a broadcast that stopped (e.g. e-mail was not configured). */
export async function retryAnnouncementJob(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('marketing:send');
  await ensureSettingsLoaded();
  const id = String(formData.get('jobId') ?? '');
  const transport = emailTransportStatus();
  if (!transport.configured) return { ok: false, message: `E-mail is still not configured: ${transport.problem}.` };
  const r = await prisma.announcementJob.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'QUEUED', lastError: null, lockedUntil: null } });
  if (!r.count) return { ok: false, message: 'Only a stopped broadcast can be resumed.' };
  await audit('announcement.resume', id);
  after(() => kickAnnouncementWorker());
  revalidatePath('/admin/announcements');
  return { ok: true, message: 'Resumed — the remaining e-mails go out in the background.' };
}

/**
 * Refund / credit an order (kept for older callers — the order page uses the
 * refund / credit form, fulfilment-actions.ts createRefundAction). One core for
 * every refund (lib/finance/refunds.ts); a reason is required and money goes
 * back only when money came in. With an amount: a part refund / credit. Without:
 * before shipping it is “cancel & refund” (credit note + refund ledger + stock
 * per Settings); after shipping the order page decides (return or justification).
 */
export async function refundOrder(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:refund');
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 300);
  if (!id) return { ok: false, message: 'Missing order id.' };
  const raw = String(formData.get('amount') ?? '').replace(/[€\s]/g, '').replace(',', '.');
  const amount = raw ? Math.round(Number(raw) * 100) : null;
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) return { ok: false, message: 'Enter the amount to credit (incl. VAT).' };
  const order = await prisma.order.findUnique({
    where: { id },
    select: { orderNumber: true, status: true, stripePaymentIntentId: true, _count: { select: { shipments: true } } },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  const actor = { id: session.user.id, email: session.user.email };
  const method = order.stripePaymentIntentId ? 'STRIPE' as const : 'BANK_TRANSFER' as const;
  // An amount: a part refund / credit through THE refund / credit core (credit note with
  // exact VAT, refund ledger; after shipping it needs an RMA or a justification there).
  if (amount !== null) {
    const { createRefund } = await import('@/lib/finance/refunds');
    const r = await createRefund({ orderId: id, amountCents: amount, reason, method }, actor);
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${id}`);
    return { ok: r.ok, message: r.message };
  }
  // Before anything shipped, a "refund" is a cancellation with a refund + credit
  // note (lib/fulfilment/cancel.ts). After shipping, money goes back through the
  // order page (amount, reason, a return or a written justification) — never a
  // one-click full refund that restocks units still at the customer (A10).
  if ((order.status === 'PAID' || order.status === 'PROCESSING') && order._count.shipments === 0) {
    if (reason.length < 4) return { ok: false, message: 'Give the reason (at least 4 characters) — it goes to the buyer and on the credit note.' };
    return cancelPaidOrder({ orderId: id, reason, method }, actor);
  }
  return {
    ok: false,
    message: ['SHIPPED', 'DELIVERED'].includes(order.status) || order._count.shipments > 0
      ? `Order ${order.orderNumber} has shipped — refund it on the order page (Money back → Refund / credit an amount): choose the amount, the reason and a return (RMA) or a written justification.`
      : `Order ${order.orderNumber} is ${order.status.toLowerCase().replace(/_/g, ' ')} — there is nothing to refund here.`,
  };
}

/** Build the expire-only Stripe adapter the cancel saga needs (create() is never
 *  called for cancellation). Null when Stripe isn't configured — then only
 *  session-less (manual) orders can be canceled; an order with an active session
 *  would return `expire-failed` rather than be canceled behind a live session. */
function stripeExpireApi(): StripeSessionApi | null {
  const stripe = getStripe();
  // expireOnlyApi confirms expiry by RETRIEVING the session (status==='expired'),
  // never by error-message regex, so a "complete" session fails closed.
  return stripe ? expireOnlyApi(stripe) : null;
}

/**
 * Short buyer email for an order-state change (cancel / paid / delivered used
 * to be in-app only). Only system values (order number, fixed copy, link) go
 * into the HTML — no user-typed text. Best-effort: returns false, never throws.
 */
async function emailBuyerOrderUpdate(to: string, orderNumber: string, subject: string, line: string): Promise<boolean> {
  if (!isDeliverableEmail(to)) return true; // placeholder/seed address — nothing to send
  try {
    const link = `${(process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '')}/app/orders/${orderNumber}`;
    await sendEmail({
      to,
      subject,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:540px;">
          <h2 style="color:#0E4F40;">${escapeHtml(subject)}</h2>
          <p>${escapeHtml(line)}</p>
          <p><a href="${escapeHtml(link)}">View order ${orderNumber}</a></p>
        </div>`,
      text: `${line}\n\nView order ${orderNumber}: ${link}`,
    });
    return true;
  } catch {
    return false;
  }
}

/** Cancel an UNPAID order (checkout or quote) — lib/fulfilment/cancel.ts:
 *  void proforma, release the unit, expire a card session first, email the
 *  buyer with the reason. A paid order is canceled with a refund instead. */
export async function cancelOrder(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const staff = await requireCap('orders:fulfil');
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 300) || 'Canceled by lab2date before payment';
  const r = await cancelUnpaidOrder(id, { kind: 'STAFF', id: staff.user.id, email: staff.user.email }, { reason });
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath('/admin/quotes');
  return r;
}

/** Save (or clear) the internal-only operator notes on an order. */
export async function setOrderNotes(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('orders:fulfil');
  const id = String(formData.get('orderId') ?? '');
  const notes = String(formData.get('notes') ?? '').slice(0, 4000).trim() || null;
  if (!id) return { ok: false, message: 'Missing order id.' };
  const updated = await prisma.order.updateMany({ where: { id }, data: { adminNotes: notes } });
  if (updated.count === 0) return { ok: false, message: 'Order not found — it may have been deleted.' };
  await audit('order.notes', id, notes ? 'set' : 'cleared');
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  return { ok: true, message: notes ? 'Notes saved.' : 'Notes cleared.' };
}

/** Booking money — verifying or rejecting a receipt, marking an order paid,
 *  issuing its tax invoice — is Finance work: finance:manage (“Register
 *  payments and credit terms”), not orders:fulfil (operations pack and ship). */
async function financeRefusal(): Promise<{ ok: false; message: string } | null> {
  if (await hasCapability('finance:manage')) return null;
  return { ok: false, message: 'Booking payments needs the “Register payments and credit terms” permission (finance:manage) — ask Finance or a super-admin. Nothing was changed.' };
}

/** Holds under which no money is booked by hand (bookingHoldBlocker, repeated in the claims' WHERE). */
const MANUAL_PAY_BLOCKING_HOLDS = [...PRE_PAYMENT_HOLDS, PAYMENT_REVIEW_HOLD] as OrderHoldReason[];

/** WHERE: none of MANUAL_PAY_BLOCKING_HOLDS open (a hold put on meanwhile loses the claim). */
const NO_BOOKING_HOLD_WHERE: Prisma.OrderWhereInput[] = [
  { NOT: { openHolds: { hasSome: [...MANUAL_PAY_BLOCKING_HOLDS] } } },
  // A nullable column: “not in” alone would also drop the NULL rows.
  { OR: [{ holdReason: null }, { holdReason: { notIn: MANUAL_PAY_BLOCKING_HOLDS } }] },
];

/** The atomic claim of “mark as paid”: still unpaid, no blocking hold, no receipt or terms request pending. */
function manualPayClaimWhere(id: string): Prisma.OrderWhereInput {
  return {
    id,
    status: 'PENDING_PAYMENT',
    AND: [
      ...NO_BOOKING_HOLD_WHERE,
      { OR: [{ paymentVerificationStatus: null }, { paymentVerificationStatus: { notIn: [...MANUAL_PAY_BLOCKING_VERIFICATION] } }] },
    ],
  };
}

/**
 * The atomic claim of “verify payment” (in full or as a part payment): the
 * receipt staff reviewed is still the one waiting (a new upload meanwhile
 * loses the claim) and no blocking hold was put on meanwhile.
 */
function verifyClaimWhere(id: string, paymentProofUrl: string | null): Prisma.OrderWhereInput {
  return { id, status: 'PENDING_PAYMENT', paymentVerificationStatus: 'AWAITING_VERIFICATION', paymentProofUrl, AND: NO_BOOKING_HOLD_WHERE };
}

/**
 * The receipt staff looked at (the form's `proofKey`) is not the one on the
 * order any more: the buyer uploaded a new one meanwhile. Absent = not checked
 * (older forms; the claim still pins the receipt read here).
 */
function reviewedProofChanged(formData: FormData, currentProofUrl: string | null): boolean {
  const reviewed = formData.get('proofKey');
  return typeof reviewed === 'string' && reviewed !== (proofKeyOf(currentProofUrl) ?? '');
}

const VERIFY_RACE_MESSAGE = 'The order changed meanwhile (another admin acted on it, the buyer sent a new receipt, or a hold was put on) — refresh and check the current state. Nothing was booked.';

/** The value-date / amount checks of every payment booking (verify, mark paid). */
function receivedFromForm(formData: FormData, openCents: number, orderCreatedAt: Date) {
  return readReceived({
    amount: String(formData.get('amount') ?? ''),
    date: String(formData.get('receivedAt') ?? ''),
    bankRef: String(formData.get('bankRef') ?? ''),
    required: settingBool('PAYMENT_REQUIRE_AMOUNT_ON_VERIFY'),
    openCents,
    orderCreatedAt,
    confirmEarlierDate: formData.get('confirmEarlierDate') === 'on',
    now: new Date(),
    timeZone: businessTimeZone(),
  });
}

/**
 * Paid, but the unit is gone (takeQuoteUnit came back short — e.g. sold to
 * another buyer under STOCK_RESERVE_ON = PAYMENT_VERIFIED). The order stays
 * PAID (the money arrived) and goes on the STOCK_SHORTAGE hold — dispatch is
 * blocked (lib/fulfilment/rules.ts) — with a line in the internal notes. No
 * invoice is issued until staff decide: refund, backorder or another unit.
 */
async function takeUnitOrHold(
  tx: Prisma.TransactionClient,
  order: { id: string; sourcingRequestId: string | null; items: Array<{ productId: string | null; quantity: number }> },
  by: string,
): Promise<{ short: boolean; warning: string }> {
  const unit = await takeQuoteUnit(tx, order);
  if (!unit.short) return { short: false, warning: unit.warning };
  const o = await tx.order.findUnique({ where: { id: order.id }, select: { openHolds: true, holdReason: true, holdNote: true, adminNotes: true } });
  if (o) {
    const detail = unit.warning.replace(/^\s*Warning:\s*/i, '').trim() || 'the unit could not be taken from stock';
    await tx.order.update({
      where: { id: order.id },
      data: {
        openHolds: Array.from(new Set([...o.openHolds, ...(o.holdReason ? [o.holdReason] : []), 'STOCK_SHORTAGE'])),
        holdReason: o.holdReason ?? 'STOCK_SHORTAGE',
        holdNote: [o.holdNote, `STOCK_SHORTAGE: ${detail}`].filter(Boolean).join(' | ').slice(0, 2000),
        holdAt: new Date(),
        adminNotes: `${o.adminNotes ? `${o.adminNotes}\n` : ''}[${new Date().toISOString().slice(0, 10)}] Paid, but the unit is no longer in stock (${detail}). No invoice was issued — decide: refund, backorder or another unit. (${by})`.slice(0, 4000),
      },
    });
  }
  return { short: true, warning: unit.warning };
}

/** After a STOCK_SHORTAGE: staff are alerted, the buyer is told the truth (no “we prepare your order”). */
async function announceStockShortage(
  o: { id: string; orderNumber: string; currency: string; buyer: { id: string; email: string; name: string | null } },
  rec: { amountCents: number; receivedAt: Date },
  warning: string,
): Promise<string> {
  const amount = fmtDocMoney(rec.amountCents, o.currency);
  await notifyAdmins(
    `Order ${o.orderNumber} paid — the unit is no longer in stock`,
    `${amount} received (value date ${fmtValueDay(rec.receivedAt)}). ${warning.trim()} No invoice was issued: refund it (Cancel & refund) or secure the unit and release the stock-shortage hold on the order page.`.slice(0, 500),
    `/admin/orders/${o.id}`,
    'ORDER_PAID',
  );
  // The same text the buyer's payment and order pages show while the hold is open.
  const t = stockShortageText({ orderNumber: o.orderNumber, currency: o.currency, amountCents: rec.amountCents, valueDate: rec.receivedAt });
  await notifyUser(o.buyer.id, `Payment received — order ${o.orderNumber}`, t.text.slice(0, 300), `/app/orders/${o.orderNumber}`);
  const mail = await trySendEmail({
    to: o.buyer.email,
    subject: `Payment received — order ${o.orderNumber}`,
    html: mailLayout({
      heading: 'Payment received',
      body: [`Hi <span dir="auto">${escapeHtml(o.buyer.name ?? 'there')}</span>,`, t.html],
      cta: { href: `${siteBase()}/app/orders/${o.orderNumber}`, label: 'View your order' },
    }),
    text: t.text,
  }, 'orders:stock-shortage');
  return ` The unit is no longer in stock: the order is on the STOCK SHORTAGE hold (no shipping) and NO invoice was issued — refund it (Cancel & refund), or secure the unit (another one, or the same one later) and release the hold on the order page. ${mail.ok ? 'The buyer was e-mailed that the payment arrived and that we contact them.' : `The e-mail to the buyer could not be delivered (${mail.error}).`}`;
}

/** Manually mark a non-Stripe order as PAID — money that landed off-platform
 *  (bank transfer, other), with the bank statement's amount and value date.
 *  Never while the buyer's own receipt waits for review, on a pre-payment
 *  hold (export compliance, VAT, address, freight), under a payment review or
 *  an invoice-terms request: those have their own decision first. */
export async function markOrderPaidManually(formData: FormData): Promise<{ ok: boolean; message: string; confirm?: 'EARLIER_DATE' }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  const refused = await financeRefusal();
  if (refused) return refused;
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  const method = String(formData.get('method') ?? '').toUpperCase();
  const note = String(formData.get('note') ?? '').trim().slice(0, 500) || null;
  if (!id) return { ok: false, message: 'Missing order id.' };
  if (method === 'INVOICE') {
    // Never "paid" without money: invoice payment is an approval of credit terms.
    return { ok: false, message: 'No money was received on “invoice” terms, so the order can not be marked paid. For an approved credit customer use “Approve on invoice terms” on the order page (an unpaid invoice with a due date is issued).' };
  }
  if (!['BANK_TRANSFER', 'RECEIPT', 'OTHER'].includes(method)) {
    return { ok: false, message: 'Unknown payment method.' };
  }
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true, orderNumber: true, status: true, totalCents: true, amountPaidCents: true, refunds: LIVE_REFUNDS_SELECT, currency: true, shippingAddress: true, billingAddress: true,
      proformaNumber: true, sourcingRequestId: true, createdAt: true, holdReason: true, openHolds: true, paymentVerificationStatus: true,
      items: { select: { productId: true, quantity: true }, take: 1 }, buyer: { select: { id: true, email: true, name: true } },
    },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  if (['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status)) {
    return { ok: false, message: `Order is already ${order.status.toLowerCase()}.` };
  }
  if (order.status !== 'PENDING_PAYMENT') return { ok: false, message: `Order ${order.orderNumber} is ${order.status.toLowerCase()} — no payment is due on it.` };
  const blocked = manualPaymentBlocker({ holdMessage: prePaymentHoldMessage(order), holdReason: order.holdReason, openHolds: order.openHolds, paymentVerificationStatus: order.paymentVerificationStatus });
  if (blocked) return { ok: false, message: `Not marked paid: ${blocked}` };
  const missingDetails = orderDetailsProblems(order, { vatIdRule: vatIdRule() });
  if (requireDetailsBeforePayment() && missingDetails.length) {
    return { ok: false, message: `Add the buyer’s billing and delivery details first (missing: ${missingDetails.join(', ')}) — they are needed for the invoice and the shipment. Use “Billing & delivery details” on the order page.` };
  }
  // What is still open: the total minus what was received and kept (a part payment that is
  // refunded — or approved to be refunded — is not counted).
  const open = Math.max(0, order.totalCents - heldMoneyCents(order.amountPaidCents, order.refunds));
  const rec = receivedFromForm(formData, open, order.createdAt);
  if (!rec.ok) return rec;
  const tolerance = settingInt('UNDERPAYMENT_TOLERANCE_CENTS', 0);
  // Money in payment messages always with cents ("€400.00", not "€400").
  const cur = (c: number) => fmtDocMoney(c, order.currency);
  if (rec.amountCents + tolerance < open) {
    return {
      ok: false,
      message: `${cur(rec.amountCents)} is ${cur(open - rec.amountCents)} less than the ${cur(open)} open on this order (tolerance ${cur(tolerance)}), so it can not be marked paid. If the buyer uploaded the receipt, “Verify payment” books it as a part payment and asks for the rest; otherwise wait for the full amount.`,
    };
  }
  const overpaid = rec.amountCents > open ? rec.amountCents - open : 0;

  // Manual-mode integrity: a bank-transfer or receipt booking needs the
  // receipt file (checked by its bytes, stored privately, kept as a
  // PaymentProof row); “other” is operator-attested. Every PAID transition
  // leaves an audit row (below).
  const file = formData.get('proof');
  let proof: { key: string; url: string; fileName: string | null } | null = null;
  if (file instanceof File && file.size > 0) {
    const stored = await storeReceiptFile(file, order.orderNumber);
    if (!stored.ok) return { ok: false, message: stored.message };
    proof = stored;
  }
  if ((method === 'BANK_TRANSFER' || method === 'RECEIPT') && !proof) {
    return {
      ok: false,
      message: `A ${method === 'RECEIPT' ? 'receipt' : 'bank-transfer'} payment needs the receipt — attach the bank’s transfer confirmation (PDF or image).`,
    };
  }

  // Atomic conditional update — concurrent admin clicks both decrement;
  // only one wins. The WHERE repeats every condition above (status, holds,
  // a receipt or terms request that arrived meanwhile).
  let stock = { short: false, warning: '' };
  const updateRes = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({
      where: manualPayClaimWhere(id),
      data: {
        status: 'PAID',
        // The value date of the money (bank statement), not the click.
        paidAt: rec.receivedAt,
        financialStatus: 'PAID',
        paidByAdminId: session.user.id,
        paymentMethodManual: method,
        paymentNote: note,
        ...(proof ? { paymentProofUrl: proof.url } : {}),
      },
    });
    if (res.count !== 1) return res;
    await recordPayment(tx, {
      orderId: id,
      amountCents: rec.amountCents,
      currency: order.currency,
      method,
      receivedAt: rec.receivedAt,
      reference: rec.bankRef ?? order.proformaNumber ?? order.orderNumber,
      proofKey: proof?.url ?? null,
      verifiedById: session.user.id,
      note: `Marked paid by ${session.user.email}: ${cur(rec.amountCents)}, value date ${rec.receivedAt.toISOString().slice(0, 10)}${note ? ` — ${note}` : ''}.`,
    });
    if (proof) await recordReceiptEvent(tx, { orderId: id, urlOrKey: proof.key, kind: 'MANUAL', fileName: proof.fileName, amountCents: rec.amountCents, actorId: session.user.id });
    if (overpaid > 0) {
      // Paid too much: the difference goes back (approved now, sent by staff) — the refund ledger.
      await requestRefundTx(tx, { orderId: id, amountCents: overpaid, currency: order.currency, method: 'BANK_TRANSFER', reason: `Overpayment: received ${cur(rec.amountCents)} for ${cur(open)} due.`, actorId: session.user.id });
    }
    stock = await takeUnitOrHold(tx, order, session.user.email);
    return res;
  });
  if (updateRes.count !== 1) {
    return { ok: false, message: 'The order changed meanwhile (paid, a receipt arrived, a hold or a cancellation) — refresh and check the current status. Nothing was booked.' };
  }
  const valueDay = fmtValueDay(rec.receivedAt);
  await audit('order.paid.manual', order.orderNumber, `${method} ${rec.amountCents} value=${rec.receivedAt.toISOString().slice(0, 10)}${proof ? ' +proof' : ''}${note ? ` "${note.slice(0, 60)}"` : ''}${stock.short ? ' STOCK_SHORTAGE' : ''}`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  const overNote = overpaid ? ` Overpaid by ${cur(overpaid)}: refund REQUESTED — transfer it back and mark it sent.` : '';
  if (stock.short) {
    const shortNote = await announceStockShortage(order, rec, stock.warning);
    return { ok: true, message: `Marked as paid (${cur(rec.amountCents)}, value date ${valueDay}).${overNote}${shortNote}` };
  }
  await notifyUser(
    order.buyer.id,
    `Payment received — order ${order.orderNumber}`,
    `We received your payment of ${cur(rec.amountCents)} (${valueDay}). We'll prepare your order for shipping.`,
    `/app/orders/${order.orderNumber}`,
  );
  await notifyAdmins(
    `Order ${order.orderNumber} marked PAID manually — ${cur(rec.amountCents)}`,
    `Method: ${method.toLowerCase().replace('_', ' ')}, value date ${valueDay}${proof ? ' · receipt attached' : ''}${note ? ` · note: ${note.slice(0, 80)}` : ''} (by ${session.user.email}).`,
    `/admin/orders/${id}`,
    'ORDER_PAID',
  );
  // Issue + email the invoice (the checkout success page promises it). Never
  // blocks — the outcome, incl. "not issued: VAT review", is reported.
  const invoiceMail = await sendOrderInvoice(order.id, { actorId: session.user.id });
  if (!invoiceMail.issued || !invoiceMail.emailed) {
    const { settingText } = await import('@/lib/finance/texts');
    const v = settingText('EMAIL_PAYMENT_VERIFIED_BODY', { AMOUNT: cur(rec.amountCents), ORDER: order.orderNumber, DATE: valueDay });
    const delayed = settingText('EMAIL_INVOICE_DELAYED_TEXT', { ORDER: order.orderNumber });
    await emailBuyerOrderUpdate(order.buyer.email, order.orderNumber, `Payment received — order ${order.orderNumber}`, `${v.text} ${invoiceMail.issued ? `Your invoice ${invoiceMail.number ?? ''} is on your order page.` : delayed.text}`);
  }
  // The supplier who owns the unit prepares it for dispatch (never throws).
  await notifySupplierOfSale(order.id, 'PAID').catch(() => {});
  return {
    ok: true,
    message: `Marked as paid (${cur(rec.amountCents)}, value date ${valueDay}).${overNote} ${invoiceMailSummary(invoiceMail)}${
      shippingAddressIsComplete(order.shippingAddress) ? '' : ' No complete shipping address on file yet — add it on the order page before shipping.'
    }${stock.warning}`,
  };
}

/** Bulk cancel UNPAID orders: each through cancelUnpaidOrder (proforma void,
 *  stock released, card session expired, buyer emailed with the reason). */
export async function bulkCancelOrders(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
  const staff = await requireCap('orders:fulfil');
  await ensureSettingsLoaded();
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No orders selected.' };
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 300) || 'Canceled by lab2date before payment';
  let canceled = 0;
  const problems: string[] = [];
  for (const id of ids) {
    const r = await cancelUnpaidOrder(id, { kind: 'STAFF', id: staff.user.id, email: staff.user.email }, { reason });
    if (r.ok) canceled++;
    else problems.push(r.message);
  }
  await audit('order.bulkcancel', undefined, `${canceled} of ${ids.length} canceled · ${reason}${problems.length ? ` · ${problems.length} refused` : ''}`);
  revalidatePath('/admin/orders');
  revalidatePath('/admin/quotes');
  return {
    ok: canceled > 0,
    count: canceled,
    message: `Canceled ${canceled} of ${ids.length} order${ids.length === 1 ? '' : 's'}; buyers were emailed with the reason.${problems.length ? ` Not canceled: ${problems.join(' ')}` : ''}`,
  };
}

/**
 * Predicate: does this Order.shippingAddress JSON have everything the
 * warehouse needs to actually dispatch a parcel?
 *
 * RB-fix: previously SHIPPED/DELIVERED transitions accepted any order,
 * including null-address rows (evidence: Q6BEQM, 5LX2KB, TATSIL).
 */
function shippingAddressIsComplete(sa: unknown): boolean {
  if (!sa || typeof sa !== 'object') return false;
  const o = sa as Record<string, unknown>;
  const addr = (o.address as Record<string, unknown> | undefined) ?? o;
  const name = String(o.name ?? '').trim();
  const line1 = String((addr as Record<string, unknown>).line1 ?? '').trim();
  const city = String((addr as Record<string, unknown>).city ?? '').trim();
  const postal = String(
    (addr as Record<string, unknown>).postal_code ??
      (addr as Record<string, unknown>).postal ??
      '',
  ).trim();
  const country = String((addr as Record<string, unknown>).country ?? '').trim();
  return Boolean(name && line1 && city && postal && country.length === 2);
}

/** The inline status form (order list row): processing / shipped / delivered
 *  through the shipments library (lib/fulfilment/shipments.ts) — the same
 *  address + billing-details gate, tracking rule, Shipment record and buyer
 *  email as the order page. Returns {ok, message}; never throws. */
export async function setOrderFulfillment(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const staff = await requireCap('orders:fulfil');
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  let status = String(formData.get('status') ?? '');
  const carrier = String(formData.get('carrier') ?? '').trim();
  const trackingNumber = String(formData.get('trackingNumber') ?? '').trim() || null;
  if (!id || !status) return { ok: false, message: 'Pick a status first.' };
  const order = await prisma.order.findUnique({
    where: { id },
    select: { status: true, orderNumber: true, trackingCarrier: true, trackingNumber: true, shipments: { select: { id: true }, orderBy: { seq: 'desc' }, take: 1 } },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  const actor = { id: staff.user.id, email: staff.user.email };
  // Entering a tracking number on an unshipped order IS the shipping action.
  if (trackingNumber && (status === 'PAID' || status === 'PROCESSING') && (order.status === 'PAID' || order.status === 'PROCESSING')) status = 'SHIPPED';
  const RANK = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
  if (!RANK.includes(status)) return { ok: false, message: `Cancel or refund an order with its own action on the order page, not with the status field.` };
  if (['CANCELED', 'REFUNDED'].includes(order.status)) return { ok: false, message: `Order ${order.orderNumber} is ${order.status.toLowerCase()} — it can not be fulfilled.` };
  if (!RANK.includes(order.status)) return { ok: false, message: `Order ${order.orderNumber} is not paid yet — record the payment first.` };
  if (RANK.indexOf(status) < RANK.indexOf(order.status)) return { ok: false, message: `Fulfilment only moves forward (paid → processing → shipped → delivered); order ${order.orderNumber} is ${order.status.toLowerCase()}.` };
  let r: { ok: boolean; message: string };
  if (status === order.status) {
    if (status === 'SHIPPED' && order.shipments[0] && (carrier !== (order.trackingCarrier ?? '') || trackingNumber !== order.trackingNumber)) {
      r = await updateShipmentTracking({ shipmentId: order.shipments[0].id, carrier: carrier || order.trackingCarrier || '', trackingNumber }, actor);
    } else {
      r = { ok: true, message: 'Nothing changed.' };
    }
  } else if (status === 'PROCESSING') {
    r = await markOrderProcessing(id, actor);
  } else if (status === 'SHIPPED') {
    r = await recordShipment({ orderId: id, lines: 'ALL', carrier, trackingNumber, parcels: 1, grossKg: null, insuredValueCents: 'DEFAULT', shippedAt: new Date(), note: null }, actor);
  } else {
    r = order.status === 'SHIPPED'
      ? await markDelivered({ orderId: id, deliveredAt: new Date(), by: 'STAFF' }, actor)
      : { ok: false, message: `Order ${order.orderNumber} is not shipped yet — record the shipment (carrier + tracking) first.` };
  }
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath(`/app/orders/${order.orderNumber}`);
  return { ok: r.ok, message: r.message };
}

/**
 * Capture or correct an order's shipping address from the admin order page.
 * Proforma orders are created without an address, and the buyer's payment form
 * closes once the order is PAID, so without this a paid address-less order could
 * never ship. Allowed until the order ships; merges into the existing JSON so
 * company / VAT / email captured elsewhere survive.
 */
export async function setOrderShippingAddress(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const staff = await requireCap('orders:fulfil');
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const get = (k: string) => String(formData.get(k) ?? '').trim();
  const f = {
    name: get('name').slice(0, 120),
    phone: get('phone').slice(0, 40),
    line1: get('line1').slice(0, 200),
    line2: get('line2').slice(0, 200),
    city: get('city').slice(0, 80),
    postal: get('postal').slice(0, 24),
    state: get('state').slice(0, 80),
    country: get('country').toUpperCase(),
  };
  const missing: string[] = [];
  if (!f.name) missing.push('recipient name');
  if (!f.line1) missing.push('address line 1');
  if (!f.city) missing.push('city');
  if (!f.postal) missing.push('postal code');
  if (!/^[A-Z]{2}$/.test(f.country)) missing.push('2-letter country code');
  if (missing.length) return { ok: false, message: `Please fill in: ${missing.join(', ')}.` };

  const order = await prisma.order.findUnique({
    where: { id },
    select: { orderNumber: true, status: true, shippingAddress: true, openHolds: true },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  const EDITABLE = ['PENDING_PAYMENT', 'PAID', 'PROCESSING'];
  if (!EDITABLE.includes(order.status)) {
    return { ok: false, message: `The address can't be changed once an order is ${order.status.toLowerCase()}.` };
  }
  // A12: the same country policy as checkout (BLOCK refused, REVIEW held) and
  // a re-price when an unpaid order changes destination.
  const verdict = await evaluateAddressChange(order, f.country, 'STAFF');
  if (!verdict.ok) return { ok: false, message: verdict.message };
  const existing = (order.shippingAddress as Record<string, unknown> | null) ?? {};
  const existingAddr = (existing.address as Record<string, unknown> | undefined) ?? {};
  const next = {
    ...existing,
    name: f.name,
    phone: f.phone || (existing.phone as string | undefined) || '',
    address: {
      ...existingAddr,
      line1: f.line1,
      line2: f.line2 || null,
      city: f.city,
      postal_code: f.postal,
      state: f.state || null,
      country: f.country,
    },
  };
  // Status precondition in the WHERE: a concurrent ship can't be re-addressed.
  const res = await prisma.order.updateMany({
    where: { id, status: { in: EDITABLE as ('PENDING_PAYMENT' | 'PAID' | 'PROCESSING')[] } },
    data: { shippingAddress: next },
  });
  if (res.count !== 1) return { ok: false, message: 'The order changed while you were editing — refresh and try again.' };
  await recordAddressChange(prisma, {
    orderId: id, kind: 'SHIPPING', oldValue: order.shippingAddress, newValue: next,
    actorRole: 'STAFF', actorId: staff.user.id, verdict, nextCountry: f.country,
  });
  await audit('order.address', order.orderNumber, `${f.city}, ${f.country} — ${verdict.note}`.slice(0, 500));
  // Paid order sent to another country: the VAT of the invoice may no longer fit.
  let vatReview: string | null = null;
  if (verdict.countryChanged && order.status !== 'PENDING_PAYMENT') {
    const { vatCheckAfterDestinationChange } = await import('@/lib/finance/vat-resolution');
    vatReview = await vatCheckAfterDestinationChange(id);
  }
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath(`/app/orders/${order.orderNumber}`);
  if (vatReview) return { ok: true, message: `Shipping address saved — the order is now on VAT review (shipping stops): ${vatReview}` };
  return {
    ok: true,
    message: verdict.hold === 'ADDRESS_REVIEW'
      ? 'Shipping address saved. The destination country changed, so the order is on hold until shipping and VAT are re-priced (Pricing, VAT & holds).'
      : verdict.hold === 'COMPLIANCE'
        ? 'Shipping address saved. The destination needs an export-compliance review before the order continues.'
        : `Shipping address saved.${verdict.countryChanged ? ` ${verdict.note}` : ''}`,
  };
}

/**
 * Generic status change of a sell-to-us offer (not in its payout lifecycle).
 * The seller is told in-app (when they have an account) AND by e-mail — the
 * only channel a guest seller has — with the reason when one is given.
 */
export async function setSellStatus(
  id: string,
  status: 'PENDING' | 'RESPONDED' | 'ACCEPTED' | 'DECLINED' | 'CLOSED',
  opts: { reason?: string | null } = {},
): Promise<{ ok: boolean; message: string }> {
  await requireCap('sell:status');
  await ensureSettingsLoaded();
  // A22: a deal whose payout lifecycle runs (acquisitionStage set) only moves
  // through its own guarded steps — a generic status write (stale tab, crafted
  // POST) must never land on it.
  const cur = await prisma.sellSubmission.findUnique({ where: { id }, select: { status: true, acquisitionStage: true } });
  if (!cur) return { ok: false, message: 'Submission not found.' };
  if (cur.acquisitionStage) return { ok: false, message: 'This deal is in its payout lifecycle — use the lifecycle actions on the page.' };
  if (cur.status === status) return { ok: true, message: 'Nothing changed.' };
  const r = await prisma.sellSubmission.updateMany({ where: { id, acquisitionStage: null, status: cur.status }, data: { status } });
  if (r.count !== 1) return { ok: false, message: 'The submission changed meanwhile — reload.' };
  const sub = await prisma.sellSubmission.findUnique({ where: { id }, select: { submittedById: true, itemTitle: true, email: true, contactName: true } });
  if (!sub) return { ok: false, message: 'Submission not found.' };
  const reason = (opts.reason ?? '').trim().slice(0, 500) || null;
  const ref = `SS-${id.slice(-6).toUpperCase()}`;
  const msg =
    status === 'ACCEPTED'
      ? 'accepted — our team will follow up with next steps.'
      : status === 'DECLINED'
        ? 'declined. Thank you for the offer.'
        : status === 'CLOSED'
          ? 'closed — we will not continue with this offer.'
          : `updated to ${status.toLowerCase()}.`;
  await notifyUser(
    sub.submittedById,
    `Your equipment submission was ${status.toLowerCase()}`,
    `"${sub.itemTitle}" was ${msg}${reason ? ` Reason: ${reason.slice(0, 200)}` : ''}`,
    `/app/sell-submissions/${id}`,
  );
  const subject = `[${ref}] Your offer “${sub.itemTitle.slice(0, 80)}” was ${status.toLowerCase()}`;
  const mail = await trySendEmail({
    to: sub.email,
    subject,
    html: mailLayout({
      heading: `Your offer was ${status.toLowerCase()}`,
      body: [
        `Hi <span dir="auto">${escapeHtml(sub.contactName || 'there')}</span>,`,
        `Your offer <strong dir="auto">${escapeHtml(sub.itemTitle)}</strong> (${ref}) was ${escapeHtml(msg)}`,
        ...(reason ? [`<p style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #0E4F40;background:#f3f4f6;" dir="auto"><strong>Reason:</strong> ${escapeHtmlLines(reason)}</p>`] : []),
        sub.submittedById ? 'The details are in your dashboard.' : `Questions? Contact us and quote ${ref}.`,
      ],
      cta: sub.submittedById
        ? { href: `${siteBase()}/app/sell-submissions/${id}`, label: 'Open your offer' }
        : { href: `${siteBase()}/support`, label: 'Contact us' },
    }),
    text: `Your offer "${sub.itemTitle}" (${ref}) was ${msg}${reason ? `\n\nReason: ${reason}` : ''}`,
  }, 'sell:status');
  await audit('sell.status', ref, `${cur.status} → ${status}${reason ? ` · ${reason.slice(0, 200)}` : ''}`);
  revalidatePath('/admin/sell');
  revalidatePath(`/app/sell-submissions/${id}`);
  return { ok: true, message: `Status set to ${status.toLowerCase()}. ${mail.ok ? `The seller was e-mailed (${sub.email}).` : `The e-mail to ${sub.email} could not be delivered (${mail.error}).`}` };
}

export async function setCompanyFeatured(slug: string, featured: boolean) {
  await requireCap('companies:manage');
  await prisma.company.update({ where: { slug }, data: { isFeatured: featured } });
  await audit(featured ? 'company.feature' : 'company.unfeature', slug);
  revalidatePath('/admin/companies');
}

const CategoryInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(200).optional().nullable(),
});
const CATEGORY_LABELS = { name: 'Category name', description: 'Description' };

// Category actions return {ok,message} instead of throwing: they run from
// form submits, and a thrown error became a full-page 500.

export async function createCategory(input: z.infer<typeof CategoryInput>): Promise<{ ok: boolean; message: string }> {
  await requireCap('categories:manage');
  const r = CategoryInput.safeParse(input);
  if (!r.success) return { ok: false, message: zodMessage(r.error, CATEGORY_LABELS) };
  const parsed = r.data;
  const dup = await prisma.category.findFirst({
    where: { name: { equals: parsed.name, mode: 'insensitive' } },
    select: { id: true },
  });
  if (dup) return { ok: false, message: `A category named “${parsed.name}” already exists.` };
  // Names with no Latin letters/digits (e.g. Persian) have no ASCII slug of
  // their own; they get "category", "category-x7k2", … instead of ''.
  const slug = await uniqueSlug(/[a-z0-9]/i.test(parsed.name) ? parsed.name : 'category', async (s) =>
    !!(await prisma.category.findUnique({ where: { slug: s }, select: { id: true } })),
  );
  const count = await prisma.category.count();
  await prisma.category.create({
    data: { slug, name: parsed.name, description: parsed.description || null, sortOrder: count },
  });
  await audit('category.create', slug);
  revalidatePath('/admin/categories');
  return { ok: true, message: `Category “${parsed.name}” added.` };
}

export async function updateCategory(input: { id: string; name: string; description?: string | null }): Promise<{ ok: boolean; message: string }> {
  await requireCap('categories:manage');
  const r = CategoryInput.safeParse({ name: input.name, description: input.description ?? null });
  if (!r.success) return { ok: false, message: zodMessage(r.error, CATEGORY_LABELS) };
  const parsed = r.data;
  const dup = await prisma.category.findFirst({
    where: { name: { equals: parsed.name, mode: 'insensitive' }, NOT: { id: input.id } },
    select: { id: true },
  });
  if (dup) return { ok: false, message: `Another category is already named “${parsed.name}”.` };
  const existing = await prisma.category.findUnique({ where: { id: input.id }, select: { id: true } });
  if (!existing) return { ok: false, message: 'Category not found — it may have been deleted.' };
  await prisma.category.update({
    where: { id: input.id },
    data: { name: parsed.name, description: parsed.description || null },
  });
  revalidatePath('/admin/categories');
  return { ok: true, message: `Saved “${parsed.name}”.` };
}

export async function deleteCategory(id: string): Promise<{ ok: boolean; message: string }> {
  await requireCap('categories:manage');
  const [products, children] = await Promise.all([
    prisma.product.count({ where: { categoryId: id } }),
    prisma.category.count({ where: { parentId: id } }),
  ]);
  if (products > 0) return { ok: false, message: `Cannot delete: ${products} product(s) still use this category.` };
  if (children > 0) return { ok: false, message: `Cannot delete: it has ${children} sub-categor(ies).` };
  const cat = await prisma.category.findUnique({ where: { id }, select: { name: true } });
  if (!cat) return { ok: false, message: 'Category not found — it may already be deleted.' };
  await prisma.category.delete({ where: { id } });
  await audit('category.delete', id);
  revalidatePath('/admin/categories');
  return { ok: true, message: `Category “${cat.name}” deleted.` };
}

export async function replyToThread(threadId: string, body: string) {
  const session = await requireCap('messages:reply');
  const text = body.trim();
  if (!text) return;
  await prisma.message.create({
    data: { threadId, body: text.slice(0, 4000), authorId: session.user.id },
  });
  await prisma.messageThread.update({
    where: { id: threadId },
    data: { lastMessageAt: new Date() },
  });
  revalidatePath('/admin/messages');
}

const BrandInput = z.object({ name: z.string().trim().min(2).max(80), logoUrl: z.string().url().nullish() });
const BRAND_LABELS = { name: 'Brand name', logoUrl: 'Logo' };

/** Case-insensitive name clash (duplicates showed up twice in product dropdowns). */
async function brandNameTaken(name: string, exceptId?: string): Promise<boolean> {
  return !!(await prisma.brand.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  }));
}

export async function createBrand(input: z.infer<typeof BrandInput>): Promise<{ ok: boolean; message: string; slug?: string }> {
  await requireCap('products:edit');
  const r = BrandInput.safeParse(input);
  if (!r.success) return { ok: false, message: zodMessage(r.error, BRAND_LABELS) };
  const parsed = r.data;
  if (await brandNameTaken(parsed.name)) return { ok: false, message: `A brand named “${parsed.name}” already exists.` };
  const baseSlug = parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slug = await uniqueSlug(baseSlug.length >= 2 ? baseSlug : 'brand', async (s) =>
    !!(await prisma.brand.findUnique({ where: { slug: s }, select: { id: true } })),
  );
  await prisma.brand.create({ data: { slug, name: parsed.name, logoUrl: parsed.logoUrl ?? null } });
  await audit('brand.create', slug);
  revalidatePath('/admin/brands');
  revalidatePath('/admin/products');
  return { ok: true, message: `Brand “${parsed.name}” added.`, slug };
}

export async function updateBrand(id: string, input: z.infer<typeof BrandInput>): Promise<{ ok: boolean; message: string }> {
  await requireCap('products:edit');
  const r = BrandInput.safeParse(input);
  if (!r.success) return { ok: false, message: zodMessage(r.error, BRAND_LABELS) };
  const parsed = r.data;
  const existing = await prisma.brand.findUnique({ where: { id } });
  if (!existing) return { ok: false, message: 'Brand not found.' };
  if (await brandNameTaken(parsed.name, id)) return { ok: false, message: `Another brand is already named “${parsed.name}”.` };
  await prisma.brand.update({ where: { id }, data: { name: parsed.name, logoUrl: parsed.logoUrl ?? null } });
  await audit('brand.update', existing.slug);
  revalidatePath('/admin/brands');
  return { ok: true, message: 'Saved.' };
}

export async function deleteBrand(id: string): Promise<{ ok: boolean; message: string }> {
  await requireCap('products:edit');
  const usage = await prisma.product.count({ where: { brandId: id } });
  if (usage > 0) return { ok: false, message: `Cannot delete: ${usage} product${usage === 1 ? '' : 's'} still use this brand.` };
  const b = await prisma.brand.findUnique({ where: { id } });
  if (!b) return { ok: false, message: 'Brand not found.' };
  await prisma.brand.delete({ where: { id } });
  await audit('brand.delete', b.slug);
  revalidatePath('/admin/brands');
  return { ok: true, message: 'Deleted.' };
}

// ─── Admin product create / edit (admin own inventory, full edit) ──────────

// Limits are wide enough for every row the shop / URL importers write (titles
// up to 200 chars, all supplier photos, full descriptions), so an imported
// product can always be re-saved from the edit page.
const AdminProductInput = z.object({
  title: z.string().trim().min(2).max(200),
  summary: z.string().max(300).nullish(),
  description: z.string().max(100_000).nullish(),
  categoryId: z.string().min(1),
  brandId: z.string().nullish(),
  companyId: z.string().nullish(),               // null = lab2date own inventory
  condition: z.enum(['NEW', 'REFURBISHED', 'USED']),
  mode: z.enum(['BUY_NOW', 'QUOTE_ONLY', 'HYBRID']),
  priceCents: z.number().int().nonnegative().max(MAX_PRICE_CENTS, MAX_PRICE_MESSAGE).nullable(),
  currency: z.string().default('EUR'),
  yearMade: z.number().int().min(1900).max(2100).nullable(),
  // null = no drawing: buyers see the "Photo on request" placeholder.
  illustration: z.enum(['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector']).nullable().default(null),
  // A photo is an http(s) URL or a site path ("/media/…", what the importer stores).
  images: z
    .array(z.string().max(2048).refine((u) => isSafeImageUrl(u), 'Photos must be web image addresses.'))
    .max(MAX_ADMIN_PRODUCT_IMAGES)
    .default([]),
  specs: z.record(z.string()).default({}),
  status: z.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED']).default('PUBLISHED'),
  quantity: z.number().int().min(0).max(100000).default(1),
  // What we promise about THIS unit (see src/lib/catalog/warranty.ts).
  // warrantyMonths: null = use the condition default, 0 = no warranty.
  warrantyMonths: z.number().int().min(0).max(120).nullable().default(null),
  warrantyText: z.string().trim().max(500).nullish(),
  conditionNotes: z.string().trim().max(1000).nullish(),
  inspectedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Inspection date must be a date.').nullish(),
  inspectionReportUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((u) => !u || /^\/api\/inspection-report\/inspection-reports\/[a-f0-9]{32}\.(pdf|jpg|png|webp)$/.test(u), 'Upload the inspection report with “Upload report”.')
    .nullish(),
  inspectionNotes: z.string().trim().max(1000).nullish(),
  sku: z.string().trim().max(64).nullish(),
  mpn: z.string().trim().max(64).nullish(),
  // VAT: STANDARD, or the margin scheme for second-hand goods (bought without
  // deductible VAT) — the margin VAT is computed from the purchase cost.
  vatScheme: z.enum(['STANDARD', 'MARGIN']).default('STANDARD'),
  purchaseCostCents: z.number().int().nonnegative().max(MAX_PRICE_CENTS, MAX_PRICE_MESSAGE).nullish(),
  // Search title / meta description overrides (empty = derived from the listing).
  // Not sent = unchanged, so older forms never wipe them.
  seoTitle: z.string().trim().max(120, 'at most 120 characters').nullish(),
  seoDescription: z.string().trim().max(320, 'at most 320 characters').nullish(),
}).superRefine((p, ctx) => {
  if (p.vatScheme === 'MARGIN' && p.condition === 'NEW') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vatScheme'], message: 'The margin scheme is only for second-hand goods (Refurbished / Used).' });
  }
  if (p.vatScheme === 'MARGIN' && (p.purchaseCostCents == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['purchaseCostCents'], message: 'Enter what you paid for this unit — the margin VAT is computed from it.' });
  }
});

export type AdminProductInputType = z.infer<typeof AdminProductInput>;

const ADMIN_PRODUCT_LABELS: Record<string, string> = {
  title: 'Title',
  summary: 'Short summary',
  description: 'Description',
  categoryId: 'Category',
  brandId: 'Brand',
  companyId: 'Shop / supplier',
  condition: 'Condition',
  mode: 'Buying mode',
  priceCents: 'Price',
  currency: 'Currency',
  yearMade: 'Year made',
  illustration: 'Fallback illustration',
  images: 'Photos',
  specs: 'Technical specs',
  status: 'Status',
  quantity: 'Quantity in stock',
  warrantyMonths: 'Warranty (months)',
  warrantyText: 'Warranty terms',
  conditionNotes: 'Condition notes',
  inspectedAt: 'Inspection date',
  inspectionReportUrl: 'Inspection report',
  inspectionNotes: 'Inspection notes',
  sku: 'Stock number (SKU)',
  mpn: 'Manufacturer part number',
  vatScheme: 'VAT scheme',
  purchaseCostCents: 'Purchase cost',
  seoTitle: 'SEO title',
  seoDescription: 'SEO description',
};

/** The per-unit truth fields as Prisma data (shared by create + update). */
function truthData(p: AdminProductInputType) {
  const inspectedAt = p.inspectedAt ? new Date(`${p.inspectedAt}T12:00:00Z`) : null;
  return {
    warrantyMonths: p.warrantyMonths ?? null,
    warrantyText: p.warrantyText?.trim() || null,
    conditionNotes: p.conditionNotes?.trim() || null,
    inspectedAt: inspectedAt && !Number.isNaN(inspectedAt.getTime()) ? inspectedAt : null,
    inspectionReportUrl: p.inspectionReportUrl?.trim() || null,
    inspectionNotes: p.inspectionNotes?.trim() || null,
    sku: p.sku?.trim() || null,
    mpn: p.mpn?.trim() || null,
    vatScheme: p.vatScheme,
    purchaseCostCents: p.vatScheme === 'MARGIN' ? p.purchaseCostCents ?? null : p.purchaseCostCents ?? null,
    ...(p.seoTitle !== undefined ? { seoTitle: p.seoTitle?.trim() || null } : {}),
    ...(p.seoDescription !== undefined ? { seoDescription: p.seoDescription?.trim() || null } : {}),
  };
}

type AdminProductError = { ok: false; message: string; fieldErrors?: Record<string, string> };

/** safeParse with readable per-field messages (never the raw zod JSON). */
function parseAdminProduct(input: AdminProductInputType): { data: AdminProductInputType } | { error: AdminProductError } {
  const r = AdminProductInput.safeParse(input);
  if (r.success) return { data: r.data };
  return {
    error: {
      ok: false,
      message: zodMessage(r.error, ADMIN_PRODUCT_LABELS),
      fieldErrors: zodFieldErrors(r.error, ADMIN_PRODUCT_LABELS),
    },
  };
}

/** Own-store photos are stored host-relative ("/media/…"), so a domain or IP change never hides them. */
function storedImages(images: string[]): string[] {
  return images.map((u) => ownMediaPath(u) ?? u);
}

export async function adminCreateProduct(input: AdminProductInputType): Promise<{ ok: true; slug: string } | AdminProductError> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('products:edit');
  const result = parseAdminProduct(input);
  if ('error' in result) return result.error;
  // Going live is moderation: an edit-only admin creates drafts or review requests.
  if (result.data.status === 'PUBLISHED' && !(await hasCapability('products:approve'))) {
    return { ok: false, message: NEEDS_APPROVE, fieldErrors: { status: 'Choose Draft or Pending review — publishing needs products:approve.' } };
  }
  const parsed = { ...result.data, images: storedImages(result.data.images) };
  let slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  if (slug.length < 3) slug = `product-${Date.now().toString(36)}`;
  slug = await uniqueSlug(slug, async (s) => !!(await prisma.product.findUnique({ where: { slug: s }, select: { id: true } })));

  await prisma.product.create({
    data: {
      slug,
      title: parsed.title,
      summary: parsed.summary ?? null,
      description: parsed.description ?? null,
      condition: parsed.condition,
      mode: parsed.mode,
      status: parsed.status,
      priceCents: parsed.priceCents,
      currency: parsed.currency,
      quantity: parsed.quantity,
      yearMade: parsed.yearMade,
      illustration: parsed.illustration,
      images: parsed.images,
      hasImages: publicProductImages(parsed.images).length > 0,
      specs: Object.keys(parsed.specs).length ? parsed.specs : undefined,
      categoryId: parsed.categoryId,
      brandId: parsed.brandId || null,
      sellerId: session.user.id,
      companyId: parsed.companyId || null,
      ...truthData(parsed),
    },
  });
  await audit('product.admin.create', slug, parsed.companyId ? `company=${parsed.companyId}` : 'own');
  revalidatePath('/admin/products');
  revalidatePath('/marketplace');
  return { ok: true, slug };
}

export async function adminUpdateProduct(slug: string, input: AdminProductInputType): Promise<{ ok: true; message: string } | AdminProductError> {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('products:edit');
  const result = parseAdminProduct(input);
  if ('error' in result) return result.error;
  const parsed = { ...result.data, images: storedImages(result.data.images) };
  const existing = await prisma.product.findUnique({
    where: { slug },
    select: {
      id: true, externalId: true, lockedFields: true, title: true, summary: true, description: true,
      images: true, priceCents: true, currency: true, pendingPriceCents: true, priceOnHold: true, status: true, sellerId: true,
    },
  });
  if (!existing) return { ok: false, message: 'Product not found.' };
  const statusChanged = parsed.status !== existing.status;
  if (statusChanged && moderationNeeded(existing.status, parsed.status) && !(await hasCapability('products:approve'))) {
    return { ok: false, message: NEEDS_APPROVE, fieldErrors: { status: `Keep it ${existing.status.toLowerCase().replace('_', ' ')} — publishing or unpublishing needs products:approve.` } };
  }
  // Field ownership: an admin edit of a synced product locks the edited
  // fields, so the next supplier sync cannot silently undo it.
  const locks = new Set(existing.lockedFields);
  if (existing.externalId) {
    const edited: [LockableField, boolean][] = [
      ['title', parsed.title !== existing.title],
      ['summary', (parsed.summary ?? null) !== existing.summary],
      ['description', (parsed.description ?? null) !== existing.description],
      ['images', parsed.images.join('\n') !== existing.images.join('\n')],
      ['price', parsed.priceCents !== existing.priceCents || parsed.currency !== existing.currency],
    ];
    for (const [f, changed] of edited) if (changed && isLockableField(f)) locks.add(f);
  }
  // An admin who sets the price decides a pending supplier price change too.
  const priceDecided =
    (existing.pendingPriceCents !== null || existing.priceOnHold) &&
    (parsed.priceCents !== existing.priceCents || parsed.currency !== existing.currency);
  await prisma.product.update({
    where: { id: existing.id },
    data: {
      lockedFields: [...locks],
      ...(priceDecided ? { pendingPriceCents: null, pendingPriceCurrency: null, pendingPriceAt: null, pendingPriceNote: null, priceOnHold: false } : {}),
      ...truthData(parsed),
      title: parsed.title,
      summary: parsed.summary ?? null,
      description: parsed.description ?? null,
      condition: parsed.condition,
      mode: parsed.mode,
      status: parsed.status,
      priceCents: parsed.priceCents,
      currency: parsed.currency,
      quantity: parsed.quantity,
      yearMade: parsed.yearMade,
      illustration: parsed.illustration,
      images: parsed.images,
      hasImages: publicProductImages(parsed.images).length > 0,
      // DbNull, not undefined: undefined means "leave unchanged", so removing
      // every spec row used to keep the old specs.
      specs: Object.keys(parsed.specs).length ? parsed.specs : Prisma.DbNull,
      categoryId: parsed.categoryId,
      brandId: parsed.brandId || null,
      companyId: parsed.companyId || null,
    },
  });
  const newLocks = [...locks].filter((f) => !existing.lockedFields.includes(f));
  await audit('product.admin.update', slug, [newLocks.length ? `locked=${newLocks.join(',')}` : '', statusChanged ? `${existing.status} → ${parsed.status}` : ''].filter(Boolean).join(' ') || undefined);
  const told = statusChanged ? await noticeListingModeration({ slug, title: parsed.title, sellerId: existing.sellerId }, parsed.status, null) : '';
  revalidatePath('/admin/products');
  revalidatePath(`/admin/products/${slug}`);
  revalidatePath(`/marketplace/${slug}`);
  return {
    ok: true,
    message: `${newLocks.length
      ? `Saved. Supplier syncs will no longer change: ${newLocks.join(', ')} (unlock on this page).`
      : 'Saved.'}${told}`,
  };
}

export async function adminDeleteProduct(slug: string): Promise<{ ok: boolean; message: string; outcome?: 'deleted' | 'archived' }> {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('products:edit');
  const existing = await prisma.product.findUnique({ where: { slug }, select: { id: true } });
  if (!existing) return { ok: false, message: 'Product not found.' };
  // A product with ANY order history is never hard-deleted: the OrderItem →
  // Product FK is RESTRICT and order lines must retain their audit/analytics
  // link (invoice regen, chargeback defence). The shared, TOCTOU-safe guard
  // archives instead — same rule the seller path and import cleanup enforce.
  const outcome = await deleteOrArchiveProduct(productDeleteDbFrom(prisma), existing.id);
  revalidatePath('/admin/products');
  if (outcome === 'archived') {
    await audit('product.admin.archive', slug, 'had order history — archived instead of hard-deleted');
    revalidatePath(`/marketplace/${slug}`);
    return { ok: true, message: 'Product has order history — archived instead of deleted.', outcome: 'archived' };
  }
  await audit('product.admin.delete', slug);
  return { ok: true, message: 'Deleted.', outcome: 'deleted' };
}

// ─── Company pricing rules + Cloud-API import trigger ──────────────────────

const CompanyPricingInput = z.object({
  pricingMode: z.enum(['PASS_THROUGH', 'MARKUP_PERCENT', 'FORCE_QUOTE', 'HIDE_PRICE']),
  pricingMarkupBp: z.number().int().min(-9000).max(50000).default(0),
});

export async function updateCompanyPricing(slug: string, input: z.infer<typeof CompanyPricingInput>): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  await requireCap('companies:manage');
  const r = CompanyPricingInput.safeParse(input);
  if (!r.success) return { ok: false, message: zodMessage(r.error, { pricingMode: 'Pricing mode', pricingMarkupBp: 'Markup' }) };
  const parsed = r.data;
  const co = await prisma.company.findUnique({ where: { slug } });
  if (!co) return { ok: false, message: 'Company not found.' };
  await prisma.company.update({
    where: { slug },
    data: {
      pricingMode: parsed.pricingMode,
      pricingMarkupBp: parsed.pricingMode === 'MARKUP_PERCENT' ? parsed.pricingMarkupBp : 0,
    },
  });
  await audit('company.pricing', slug, `${parsed.pricingMode}/${parsed.pricingMarkupBp}bp`);
  revalidatePath('/admin/companies');
  revalidatePath('/admin/products');
  revalidatePath('/marketplace');
  return { ok: true, message: `Pricing rule saved for ${co.name}.` };
}

const CreateCompanyInput = z.object({
  name: z.string().trim().min(2).max(120),
  country: z.string().trim().max(80).nullish(),
  website: z.string().trim().url().nullish(),
  importSourceUrl: z.string().trim().url().nullish(),       // e.g. https://lab2parts.com
});
const COMPANY_LABELS = { name: 'Shop name', country: 'Country', website: 'Public website', importSourceUrl: 'Import URL' };

/** Case-insensitive name clash — two shops with one name are indistinguishable in every picker. */
async function companyNameTaken(name: string, exceptSlug?: string): Promise<boolean> {
  return !!(await prisma.company.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(exceptSlug ? { NOT: { slug: exceptSlug } } : {}) },
    select: { id: true },
  }));
}

export async function createCompany(input: z.infer<typeof CreateCompanyInput>): Promise<{ ok: boolean; message: string; slug?: string }> {
  await requireAdmin();
  await requireCap('companies:manage');
  const r = CreateCompanyInput.safeParse(input);
  if (!r.success) return { ok: false, message: zodMessage(r.error, COMPANY_LABELS) };
  const parsed = r.data;
  if (await companyNameTaken(parsed.name)) {
    return { ok: false, message: `A shop named “${parsed.name}” already exists. Use a different name or edit the existing shop.` };
  }
  const slug = await uniqueSlug(parsed.name, async (s) =>
    !!(await prisma.company.findUnique({ where: { slug: s }, select: { id: true } })),
  );
  await prisma.company.create({
    data: {
      slug,
      name: parsed.name,
      country: parsed.country ?? null,
      website: parsed.website ?? null,
      importSourceUrl: parsed.importSourceUrl ?? null,
      // Verification is a recorded decision (verifyShop), never a default.
      isVerified: false,
    },
  });
  await audit('company.create', slug, parsed.importSourceUrl ?? '');
  revalidatePath('/admin/companies');
  return { ok: true, message: `Shop “${parsed.name}” added.`, slug };
}

/** Edit a shop's name, country, website and import URL. The slug is kept so
 *  existing links and ?shop= filters keep working. */
export async function updateCompany(slug: string, input: z.infer<typeof CreateCompanyInput>): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  await requireCap('companies:manage');
  const r = CreateCompanyInput.safeParse(input);
  if (!r.success) return { ok: false, message: zodMessage(r.error, COMPANY_LABELS) };
  const parsed = r.data;
  const co = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
  if (!co) return { ok: false, message: 'Shop not found — it may have been deleted.' };
  if (await companyNameTaken(parsed.name, slug)) return { ok: false, message: `Another shop is already named “${parsed.name}”.` };
  await prisma.company.update({
    where: { id: co.id },
    data: {
      name: parsed.name,
      country: parsed.country || null,
      website: parsed.website || null,
      importSourceUrl: parsed.importSourceUrl || null,
    },
  });
  await audit('company.update', slug, parsed.importSourceUrl ?? '');
  revalidatePath('/admin/companies');
  revalidatePath('/admin/products');
  return { ok: true, message: `Shop “${parsed.name}” saved.` };
}

/** Delete a shop. Refused while products, user accounts or lab facilities are
 *  linked: those FKs are ON DELETE SET NULL, so deleting would silently turn
 *  the shop's products into lab2date own inventory. */
export async function deleteCompany(slug: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  await requireCap('companies:manage');
  const co = await prisma.company.findUnique({
    where: { slug },
    select: { id: true, name: true, _count: { select: { products: true, users: true, facilities: true } } },
  });
  if (!co) return { ok: false, message: 'Shop not found — it may already be deleted.' };
  const { products, users, facilities } = co._count;
  if (products > 0) return { ok: false, message: `Cannot delete “${co.name}”: ${products} product${products === 1 ? ' is' : 's are'} still linked. Move or delete them first.` };
  if (users > 0) return { ok: false, message: `Cannot delete “${co.name}”: ${users} user account${users === 1 ? ' belongs' : 's belong'} to this shop.` };
  if (facilities > 0) return { ok: false, message: `Cannot delete “${co.name}”: ${facilities} lab facilit${facilities === 1 ? 'y is' : 'ies are'} owned by this shop.` };
  await prisma.company.delete({ where: { id: co.id } });
  await audit('company.delete', slug, 'manual delete');
  revalidatePath('/admin/companies');
  return { ok: true, message: `Shop “${co.name}” deleted.` };
}

/**
 * Import / sync a shop's WooCommerce catalogue with the sync engine
 * (src/lib/marketplace/woo-sync.ts): field ownership, per-shop policy,
 * archive-when-removed, namespaced slugs, self-hosted photos and a full run
 * report. `whitelistSlugs` (from the live preview) imports only those source
 * items and never archives anything.
 */
export async function importShopProducts(
  slug: string,
  whitelistSlugs?: string[] | null,
): Promise<{ ok: boolean; message: string; imported?: number; runId?: string | null }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('companies:manage');
  const co = await prisma.company.findUnique({ where: { slug } });
  if (!co) return { ok: false, message: 'Company not found.' };
  if (!co.importSourceUrl) return { ok: false, message: 'No import source URL configured for this shop. Edit the shop to set one.' };
  const { runWooSync } = await import('@/lib/marketplace/woo-sync');
  const r = await runWooSync({
    companyId: co.id,
    dryRun: false,
    trigger: 'ADMIN',
    actorEmail: session.user.email,
    onlySourceSlugs: whitelistSlugs && whitelistSlugs.length ? whitelistSlugs : null,
  });
  revalidatePath('/admin/products');
  revalidatePath('/admin/companies');
  revalidatePath(`/admin/companies/${slug}`);
  return { ok: r.ok, message: r.message, imported: r.counts.created + r.counts.updated, runId: r.runId };
}

// ─── Shop preview (DB + live source) ────────────────────────────────────────

export interface PreviewProductCard {
  slug: string;
  title: string;
  brand: string | null;
  image: string | null;
  priceCents: number | null;
  currency: string;
  status?: string;
  /** present on live preview only; the slug that WOULD be created in DB */
  sourceSlug?: string;
  /** true if a Product with this slug already exists in our DB */
  alreadyImported?: boolean;
}

/** First N imported products for a shop, rendered as marketplace card data. */
export async function previewShopFromDb(
  slug: string,
  page = 1,
  pageSize = 24,
): Promise<{ ok: boolean; message?: string; items: PreviewProductCard[]; total: number }> {
  await requireAdmin();
  await requireCap('companies:manage');
  const co = await prisma.company.findUnique({ where: { slug } });
  if (!co) return { ok: false, message: 'Company not found.', items: [], total: 0 };
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where: { companyId: co.id },
      orderBy: [{ hasImages: 'desc' }, { updatedAt: 'desc' }],
      skip: (Math.max(1, page) - 1) * pageSize,
      take: pageSize,
      select: {
        slug: true, title: true, status: true, priceCents: true, currency: true, images: true,
        brand: { select: { name: true } },
      },
    }),
    prisma.product.count({ where: { companyId: co.id } }),
  ]);
  return {
    ok: true,
    items: items.map((p) => ({
      slug: p.slug,
      title: p.title,
      brand: p.brand?.name ?? null,
      image: firstPublicImage(p.images),
      priceCents: p.priceCents,
      currency: p.currency,
      status: p.status,
    })),
    total,
  };
}

interface WooStorePreview {
  id: number;
  name: string;
  slug: string;
  prices: { price: string; currency_code: string };
  images: { src: string }[];
  categories: { name: string }[];
}

/** Live fetch from a Woo Store API for preview-before-commit. Hits one page. */
export async function previewShopLive(
  url: string,
  page = 1,
  pageSize = 24,
): Promise<{ ok: boolean; message?: string; items: PreviewProductCard[]; total: number; existingCount?: number }> {
  await requireAdmin();
  await requireCap('companies:manage');
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'URL must start with http:// or https://', items: [], total: 0 };
  const base = url.replace(/\/+$/, '');
  const api = `${base}/wp-json/wc/store/v1/products?per_page=${pageSize}&page=${page}`;
  // The same SSRF guard as the sync: never fetch loopback / private addresses
  // (also not after a redirect).
  try {
    await assertPublicHost(new URL(api));
  } catch (e) {
    return { ok: false, message: `${e instanceof Error ? e.message : 'Refusing this address'}. Nothing was fetched.`, items: [], total: 0 };
  }
  let total = 0;
  let items: WooStorePreview[] = [];
  try {
    const res = await fetchPublic(api, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'lab2date-admin-preview/1.0' } });
    if (!res.ok) return { ok: false, message: `Source returned HTTP ${res.status}`, items: [], total: 0 };
    total = parseInt(res.headers.get('x-wp-total') ?? '0', 10) || 0;
    items = (await res.json()) as WooStorePreview[];
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Fetch failed: ${e.message}` : 'Fetch failed.', items: [], total: 0 };
  }
  // "Already imported" = THIS shop already has the item (by its Woo id, or by
  // the legacy slug of a row imported before ids were recorded). Another
  // shop using the same slug is a different product, not an import.
  const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase();
  const owner = (await prisma.company.findMany({ where: { importSourceUrl: { not: null } }, select: { id: true, importSourceUrl: true } }))
    .find((c) => c.importSourceUrl && norm(c.importSourceUrl) === norm(base)) ?? null;
  const existingSet = new Set<string>();
  if (owner) {
    const rows = await prisma.product.findMany({
      where: {
        companyId: owner.id,
        OR: [
          { externalSource: 'woo', externalId: { in: items.map((w) => String(w.id)) } },
          { externalId: null, slug: { in: items.map((w) => (w.slug || `imp-${w.id}`).slice(0, 90)) } },
        ],
      },
      select: { externalId: true, slug: true },
    });
    for (const r of rows) existingSet.add(r.externalId ? `id:${r.externalId}` : `slug:${r.slug}`);
  }
  return {
    ok: true,
    total,
    existingCount: existingSet.size,
    items: items.map((w) => {
      const slug = (w.slug || `imp-${w.id}`).slice(0, 90);
      const priceNum = parseFloat(w.prices?.price ?? '0');
      return {
        slug,
        sourceSlug: slug,
        title: w.name.replace(/<[^>]+>/g, ' ').slice(0, 200),
        brand: (w.categories ?? [])[0]?.name ?? null,
        image: (w.images ?? [])[0]?.src ?? null,
        priceCents: priceNum > 0 ? Math.round(priceNum) : null,
        currency: w.prices?.currency_code || 'EUR',
        alreadyImported: existingSet.has(`id:${w.id}`) || existingSet.has(`slug:${slug}`),
      };
    }),
  };
}

// ─── AI shop analysis + suggestions ─────────────────────────────────────────

interface AiRiskResult {
  score: number;             // 0-100, higher = safer
  verdict: 'safe' | 'caution' | 'risky';
  notes: string;             // 1-3 short sentences
}

/** Run AI risk-analysis on a candidate shop URL. Caches on Company.aiRiskScore if persistSlug provided. */
export async function aiAnalyzeShop(url: string, persistSlug?: string): Promise<{ ok: boolean; message?: string; result?: AiRiskResult }> {
  await requireAdmin();
  await requireCap('companies:manage');
  if (!/^https?:\/\//i.test(url)) return { ok: false, message: 'URL must start with http:// or https://' };
  const { aiJson } = await import('@/lib/ai-structured');
  try {
    const result = await aiJson<AiRiskResult>({
      systemPrompt:
        'You are an experienced procurement & e-commerce risk analyst for lab2date, a B2B marketplace for refurbished laboratory equipment in Europe. Evaluate a candidate supplier website by URL alone. Consider: legitimacy of the domain (TLD, branding), whether the URL looks like a real lab/scientific equipment retailer, signs of fraud or thin content, country jurisdiction, expected catalogue quality. Be honest and brief.',
      userPrompt:
        `Evaluate this candidate supplier URL: ${url}\n\nReturn a JSON object exactly: {"score": <0-100>, "verdict": "safe" | "caution" | "risky", "notes": "<1-3 short sentences explaining the risk assessment>"}.`,
      maxTokens: 400,
      temperature: 0.15,
    });
    if (typeof result.score !== 'number' || !['safe', 'caution', 'risky'].includes(result.verdict)) {
      return { ok: false, message: 'AI response shape invalid.' };
    }
    if (persistSlug) {
      await prisma.company.update({
        where: { slug: persistSlug },
        data: {
          aiRiskScore: Math.max(0, Math.min(100, Math.round(result.score))),
          aiRiskNotes: result.notes.slice(0, 1000),
          aiAnalyzedAt: new Date(),
        },
      }).catch(() => {});
      revalidatePath('/admin/companies');
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 240) : 'AI call failed.' };
  }
}

interface AiSuggestion {
  name: string;
  url: string;
  country: string;
  rationale: string;
}

/**
 * Ask the AI for 5-10 candidate suppliers, then materialize them as
 * `suggestedByAi=true` Company rows (idempotent on slug). Admin can then
 * preview each and decide to import or delete.
 */
export async function aiSuggestShops(): Promise<{ ok: boolean; message?: string; added?: number; skipped?: number; skippedHosts?: string[]; suggestions?: AiSuggestion[] }> {
  await requireAdmin();
  await requireCap('companies:manage');
  const { aiJson, aiJsonWithWebSearch } = await import('@/lib/ai-structured');
  // Gather every known hostname so the AI excludes them: shops we already
  // have (imported or otherwise) PLUS hostnames the operator has previously
  // BLOCKED. Suggestions that match either are silently skipped.
  const [existing, blocked] = await Promise.all([
    prisma.company.findMany({
      where: { OR: [{ importSourceUrl: { not: null } }, { website: { not: null } }] },
      select: { importSourceUrl: true, website: true },
    }),
    prisma.blockedSupplier.findMany({ select: { hostname: true } }),
  ]);
  const knownHosts = new Set<string>();
  for (const c of existing) {
    for (const u of [c.importSourceUrl, c.website]) {
      const h = u ? normaliseHost(u) : null;
      if (h) knownHosts.add(h);
    }
  }
  const blockedHosts = new Set(blocked.map((b) => b.hostname));
  const allExcluded = Array.from(new Set([...knownHosts, ...blockedHosts]));

  try {
    // Phase 1: ask Claude with WEB SEARCH enabled — it actually browses and
    // returns supplier sites with real URLs (no hallucinated domains).
    const out = await aiJsonWithWebSearch<{ suggestions: AiSuggestion[] }>({
      systemPrompt:
        'You are an experienced sourcing analyst for lab2date, a Netherlands-based B2B marketplace for refurbished / surplus laboratory & analytical equipment (HPLC, GC, mass spec, spectroscopy, centrifuges, parts). Use the web_search tool to find REAL, currently-operating supplier websites that sell used/refurbished lab equipment. Verify each URL exists by searching for it. Prefer Woo / Shopify / Magento e-commerce sites with public catalogues; reject blog posts, directories, manufacturer official pages, news, or sites that do not actually sell instruments. STRICT GEO PRIORITY — fill the slate in this order: (1) Netherlands first (highest priority — same-country logistics), (2) Western Europe — Germany, Belgium, France, UK, Italy, Switzerland, Austria, Denmark, Spain, (3) rest of EU + UK, (4) USA / Canada / global only if EU coverage is exhausted.',
      userPrompt:
        `Find 5 to 8 candidate supplier websites for lab2date to potentially partner with. EXCLUDE these hostnames entirely — they are either already imported or have been BLOCKED by the operator: ${allExcluded.join(', ') || '(none)'}. Use web_search to verify each candidate is a REAL active site that actually sells refurbished lab instruments (centrifuges, HPLC, GC, mass spec, etc.) to other businesses. Do NOT invent URLs. Do NOT include manufacturer pages, blog posts, auction houses, or general scientific equipment listings without product pages. APPLY THE GEO PRIORITY: aim for at least 2 Netherlands-based suppliers if possible, then fill the rest with Western Europe, then other EU, then global. Return ONLY JSON: {"suggestions": [{"name": "<company name>", "url": "<https://full-url>", "country": "<2-3 letter country code>", "rationale": "<1-2 sentences explaining why they fit lab2date AND what country they're in>"}]}. Order the array from highest geo priority (NL) to lowest.`,
      maxTokens: 4000,
      temperature: 0.2,
      maxSearches: 6,
    });
    if (!out.suggestions || !Array.isArray(out.suggestions)) {
      return { ok: false, message: 'AI did not return a suggestions array.' };
    }
    // Phase 2: Pre-flight reachability + BATCHED relevance classification.
    // We do reachability one-by-one (each is a single HTTP fetch, no AI),
    // collect the homepage summaries, then ONE single AI call classifies the
    // whole batch at once. This stays well under the 50K tpm rate limit
    // (web_search alone burns ~30K tokens of input).
    const { safeFetch, SafeFetchError } = await import('@/lib/import/safe-fetch');
    let added = 0;
    let skipped = 0;
    const createdSlugs: string[] = [];
    const skippedHosts: string[] = [];

    function summariseHomepage(html: string): string {
      const titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
                  || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
      const ogDescM = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return [
        titleM ? `TITLE: ${titleM[1].trim().slice(0, 160)}` : '',
        descM ? `META: ${descM[1].trim().slice(0, 220)}` : '',
        ogDescM && !descM ? `OG: ${ogDescM[1].trim().slice(0, 220)}` : '',
        `BODY: ${text.slice(0, 500)}`,
      ].filter(Boolean).join(' | ');
    }

    // Stage A: reachability + summary collection — no AI calls.
    interface ReachOk { suggestion: AiSuggestion; host: string; summary: string }
    const reached: ReachOk[] = [];
    for (const s of out.suggestions.slice(0, 10)) {
      if (!s.name || !s.url || !/^https?:\/\//i.test(s.url)) { skipped++; continue; }
      const host = normaliseHost(s.url);
      if (!host) { skipped++; continue; }
      // Belt-and-braces: drop any AI returned a known/blocked host despite
      // being told not to. This is essential — Claude sometimes ignores the
      // exclusion list.
      if (knownHosts.has(host)) { skipped++; skippedHosts.push(`${host} (already imported)`); continue; }
      if (blockedHosts.has(host)) { skipped++; skippedHosts.push(`${host} (previously blocked)`); continue; }
      try {
        const res = await safeFetch(s.url, { accept: 'text/html', maxBytes: 1 * 1024 * 1024, timeoutMs: 10_000 });
        if (res.status >= 400) { skipped++; skippedHosts.push(`${host} (HTTP ${res.status})`); continue; }
        if (!/html/i.test(res.contentType) && !res.body.startsWith('<')) { skipped++; skippedHosts.push(`${host} (non-HTML)`); continue; }
        reached.push({ suggestion: s, host, summary: summariseHomepage(res.body) });
      } catch (e) {
        const code = e instanceof SafeFetchError ? e.code : 'NETERR';
        skipped++; skippedHosts.push(`${host} (${code})`);
      }
    }

    // Stage B: ONE batched classifier call.
    interface BatchVerdict { url: string; relevant: boolean; confidence: number; category?: string; reason?: string }
    let verdicts: BatchVerdict[] = [];
    if (reached.length > 0) {
      try {
        const batch = await aiJson<{ verdicts: BatchVerdict[] }>({
          systemPrompt:
            'You validate which websites genuinely sell REFURBISHED / USED / SURPLUS scientific instruments (HPLC, GC, mass spec, microscopy, centrifuges, balances, parts) on a B2B basis. Reject manufacturer official sites, blog posts, news, sites that only do calibration / service / training without selling instruments, and auction/listing directories without their own catalogue. You will be shown a list of candidate homepages, each with TITLE / META / BODY excerpt. Score each independently.',
          userPrompt:
            `Candidates:\n\n${reached.map((r, i) => `--- #${i + 1} ---\nname: ${r.suggestion.name}\nurl: ${r.suggestion.url}\n${r.summary}`).join('\n\n')}\n\nReturn JSON ONLY: {"verdicts":[{"url":"<original url>","relevant":<bool>,"confidence":<0-100>,"category":"<hplc|gc|mass_spec|spectroscopy|microscopy|centrifuge|general_lab|parts|mixed|n/a>","reason":"<1 short sentence>"}]}.`,
          maxTokens: 1500,
          temperature: 0.1,
        });
        verdicts = batch.verdicts ?? [];
      } catch (e) {
        console.warn(`[ai_suggest] batch classifier failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown'} — falling back to permissive accept`);
        // Permissive fallback: treat all reachable as relevant (web_search already pre-filtered).
        verdicts = reached.map((r) => ({ url: r.suggestion.url, relevant: true, confidence: 60, category: 'mixed', reason: 'classifier unavailable, accepted from web_search trust' }));
      }
    }

    // Stage C: merge verdicts with reached and persist accepted ones.
    const verdictByUrl = new Map(verdicts.map((v) => [v.url, v]));
    for (const r of reached) {
      const s = r.suggestion;
      const v = verdictByUrl.get(s.url);
      if (!v) { skipped++; skippedHosts.push(`${r.host} (no verdict)`); continue; }
      if (!v.relevant || v.confidence < 55) {
        skipped++; skippedHosts.push(`${r.host} (off-topic · ${v.reason ?? 'low confidence'})`);
        continue;
      }
      s.rationale = `${s.rationale} — homepage check: ${v.category ?? 'mixed'} (${v.confidence}/100). ${v.reason ?? ''}`.trim();

      const slug = await uniqueSlug(s.name, async (q) => !!(await prisma.company.findUnique({ where: { slug: q }, select: { id: true } })));
      await prisma.company.create({
        data: {
          slug,
          name: s.name.slice(0, 120),
          country: (s.country ?? '').slice(0, 80) || null,
          website: s.url,
          importSourceUrl: s.url,
          isVerified: false,
          isFeatured: false,
          suggestedByAi: true,
          aiRiskNotes: s.rationale.slice(0, 1000),
          aiAnalyzedAt: new Date(),
        },
      });
      added++;
      createdSlugs.push(slug);
    }
    if (skippedHosts.length) {
      console.warn(`[ai_suggest] Skipped ${skipped} candidates: ${skippedHosts.join(', ')}`);
    }
    // NOTE: we used to also auto-run aiAnalyzeShop for each new slug here,
    // but that's another Claude call per shop and blows past the per-minute
    // token budget. The drawer already auto-runs aiAnalyzeShop on open, so
    // the score will appear the first time the admin clicks a card.
    await audit('company.ai_suggest', undefined, `added=${added} skipped=${skipped}`);
    revalidatePath('/admin/companies');
    return { ok: true, added, skipped, suggestions: out.suggestions, skippedHosts };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 240) : 'AI suggestion failed.' };
  }
}

// ─── Universal product URL importer (Woo/Shopify/JSON-LD/OG/AI fallback) ──

import type { ImportRunResult } from '@/lib/import/run';

/**
 * Run the URL → product extraction pipeline. Returns the parsed preview
 * without writing anything to the database. The admin reviews the preview,
 * optionally edits, then calls createDraftFromExtraction to persist.
 */
export async function previewProductFromUrl(url: string): Promise<ImportRunResult & { aborted?: boolean }> {
  await requireAdmin();
  await requireCap('products:edit');
  const { runImport } = await import('@/lib/import/run');
  return runImport(url);
}

const DraftFromExtraction = z.object({
  sourceUrl: z.string().url(),
  title: z.string().trim().min(2).max(200),
  summary: z.string().max(280).nullish(),
  description: z.string().max(8000).nullish(),
  brand: z.string().max(80).nullish(),                  // free-text, we map → Brand
  categorySlug: z.string().min(1).max(64),
  companySlug: z.string().max(64).nullish(),            // optional supplier
  condition: z.enum(['NEW', 'REFURBISHED', 'USED']).default('REFURBISHED'),
  priceCents: z.number().int().nonnegative().max(MAX_PRICE_CENTS, MAX_PRICE_MESSAGE).nullable(),
  currency: z.string().min(2).max(8).default('EUR'),
  images: z.array(z.string().url()).max(8).default([]),
  specs: z.record(z.string()).default({}),
  illustration: z.enum(['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector']).default('balance'),
});

export type DraftFromExtractionInput = z.infer<typeof DraftFromExtraction>;

export async function createDraftFromExtraction(input: DraftFromExtractionInput): Promise<{ ok: boolean; slug?: string; message: string; existing?: { slug: string; title: string } }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('products:edit');
  const r = DraftFromExtraction.safeParse(input);
  if (!r.success) {
    return {
      ok: false,
      message: zodMessage(r.error, { ...ADMIN_PRODUCT_LABELS, sourceUrl: 'Source URL', brand: 'Brand', categorySlug: 'Category', companySlug: 'Shop' }),
    };
  }
  const parsed = r.data;

  // Duplicate guard: same source URL already imported?
  const dup = await prisma.product.findUnique({
    where: { sourceUrl: parsed.sourceUrl },
    select: { slug: true, title: true },
  });
  if (dup) {
    return {
      ok: false,
      message: `This source URL is already imported as “${dup.title}”. Open the existing draft to edit it.`,
      existing: dup,
    };
  }

  // Resolve category by slug.
  const category = await prisma.category.findUnique({ where: { slug: parsed.categorySlug }, select: { id: true } });
  if (!category) return { ok: false, message: `Unknown category slug: ${parsed.categorySlug}` };

  // Optional supplier.
  let companyId: string | null = null;
  if (parsed.companySlug) {
    const co = await prisma.company.findUnique({ where: { slug: parsed.companySlug }, select: { id: true } });
    if (co) companyId = co.id;
  }

  // Upsert brand if provided.
  let brandId: string | null = null;
  if (parsed.brand) {
    const bSlug = parsed.brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    if (bSlug.length >= 2) {
      const b = await prisma.brand.upsert({
        where: { slug: bSlug },
        update: { name: parsed.brand.slice(0, 80) },
        create: { slug: bSlug, name: parsed.brand.slice(0, 80) },
      });
      brandId = b.id;
    }
  }

  let slug = parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  if (slug.length < 3) slug = `imported-${Date.now().toString(36)}`;
  slug = await uniqueSlug(slug, async (q) => !!(await prisma.product.findUnique({ where: { slug: q }, select: { id: true } })));

  // Photos are copied into our media store — never hotlinked from the source.
  const photos = await localizeImageList(parsed.images);
  await prisma.product.create({
    data: {
      slug,
      sourceUrl: parsed.sourceUrl,
      sourceImageUrls: parsed.images,
      title: parsed.title,
      summary: parsed.summary ?? null,
      description: parsed.description ?? null,
      condition: parsed.condition,
      mode: parsed.priceCents ? 'HYBRID' : 'QUOTE_ONLY',
      status: 'DRAFT',                  // ALWAYS draft from URL importer
      priceCents: parsed.priceCents,
      currency: parsed.currency,
      quantity: 1,
      images: photos.images,
      hasImages: publicProductImages(photos.images).length > 0,
      illustration: parsed.illustration,
      specs: Object.keys(parsed.specs).length ? parsed.specs : undefined,
      categoryId: category.id,
      brandId,
      sellerId: session.user.id,
      companyId,
    },
  });
  await audit('product.url_import', slug, parsed.sourceUrl.slice(0, 240));
  revalidatePath('/admin/products');
  const photoNote = photos.failures.length
    ? ` ${photos.failures.length} photo(s) could not be copied to our media store and stay hidden from buyers.`
    : '';
  return { ok: true, slug, message: `Draft created. Review and publish from the products list.${photoNote}` };
}

/**
 * Permanently block a supplier — delete the Company row AND add its
 * hostname to the BlockedSupplier table so future AI suggest runs will
 * never propose it again. The hostname comparison is case-insensitive
 * and strips `www.` so subdomain variants are still excluded.
 */
function normaliseHost(raw: string): string | null {
  try {
    let u = raw;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    return new URL(u).hostname.replace(/^www\./i, '').toLowerCase();
  } catch { return null; }
}

export async function blockSupplier(slug: string, reason?: string): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('companies:manage');
  const co = await prisma.company.findUnique({
    where: { slug },
    select: { id: true, name: true, importSourceUrl: true, website: true, _count: { select: { products: true } } },
  });
  if (!co) return { ok: false, message: 'Shop not found.' };
  if (co._count.products > 0) {
    return { ok: false, message: `Cannot block: ${co._count.products} products are still linked. Unlink them first.` };
  }
  const hosts = new Set<string>();
  for (const u of [co.importSourceUrl, co.website]) {
    const h = u ? normaliseHost(u) : null;
    if (h) hosts.add(h);
  }
  if (hosts.size === 0) {
    // No hostname to block — just delete the row.
    await prisma.company.delete({ where: { id: co.id } });
    await audit('company.delete', slug, 'no-hostname');
    revalidatePath('/admin/companies');
    return { ok: true, message: `Removed ${co.name}.` };
  }
  for (const hostname of hosts) {
    await prisma.blockedSupplier.upsert({
      where: { hostname },
      update: { reason: reason?.slice(0, 500) ?? null, blockedBy: session.user.email },
      create: { hostname, reason: reason?.slice(0, 500) ?? null, blockedBy: session.user.email },
    });
  }
  await prisma.company.delete({ where: { id: co.id } });
  await audit('company.block', slug, [...hosts].join(','));
  revalidatePath('/admin/companies');
  return { ok: true, message: `Blocked ${co.name} — won't appear in future AI suggestions.` };
}

/** Drop a suggested-but-rejected shop. Only allowed if no products were imported. */
export async function deleteSuggestedShop(slug: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  await requireCap('companies:manage');
  const co = await prisma.company.findUnique({
    where: { slug },
    select: { id: true, suggestedByAi: true, _count: { select: { products: true } } },
  });
  if (!co) return { ok: false, message: 'Shop not found.' };
  if (co._count.products > 0) return { ok: false, message: `Cannot delete: ${co._count.products} products linked.` };
  await prisma.company.delete({ where: { id: co.id } });
  await audit('company.delete', slug, co.suggestedByAi ? 'suggested' : 'manual');
  revalidatePath('/admin/companies');
  return { ok: true, message: 'Shop removed.' };
}

// ============================================================================
//   Slice A — order soft-archive + two-step payment verification (admin side)
// ============================================================================

/** Soft-archive a single order. Reversible via unarchiveOrder. */
export async function archiveOrder(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:fulfil');
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const o = await prisma.order.findUnique({ where: { id }, select: { id: true, orderNumber: true, archivedAt: true } });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (o.archivedAt) return { ok: false, message: 'Order already archived.' };
  // BUG-040: atomic claim so a concurrent double-click archives (and audits) exactly once.
  const claim = await prisma.order.updateMany({
    where: { id, archivedAt: null },
    data: { archivedAt: new Date(), archivedById: session.user.id },
  });
  if (claim.count !== 1) {
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${id}`);
    return { ok: false, message: 'Order already archived.' };
  }
  await audit('order.archive', o.orderNumber, undefined);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  return { ok: true, message: 'Archived.' };
}

/** Reverse a soft-archive. */
export async function unarchiveOrder(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:fulfil');
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const o = await prisma.order.findUnique({ where: { id }, select: { id: true, orderNumber: true, archivedAt: true } });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (!o.archivedAt) return { ok: false, message: 'Order is not archived.' };
  // BUG-040: atomic claim so a concurrent double-click unarchives (and audits) exactly once.
  const claim = await prisma.order.updateMany({
    where: { id, archivedAt: { not: null } },
    data: { archivedAt: null, archivedById: null },
  });
  if (claim.count !== 1) {
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${id}`);
    return { ok: false, message: 'Order is not archived.' };
  }
  await audit('order.unarchive', o.orderNumber, undefined);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  return { ok: true, message: 'Restored.' };
}

/** Bulk-archive a list of order IDs. Skips already-archived rows. */
export async function bulkArchiveOrders(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:fulfil');
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No orders selected.' };
  const targets = await prisma.order.findMany({
    where: { id: { in: ids }, archivedAt: null },
    select: { id: true, orderNumber: true },
  });
  if (targets.length === 0) return { ok: false, count: 0, message: 'None of the selected orders are unarchived.' };
  await prisma.order.updateMany({
    where: { id: { in: targets.map((o) => o.id) } },
    data: { archivedAt: new Date(), archivedById: session.user.id },
  });
  await audit('order.bulkarchive', undefined, `${targets.length} orders`);
  revalidatePath('/admin/orders');
  return { ok: true, count: targets.length, message: `Archived ${targets.length} order${targets.length === 1 ? '' : 's'}.` };
}

/** Bulk-unarchive — used from the Archived tab to restore rows to the queue. */
export async function bulkUnarchiveOrders(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:fulfil');
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No orders selected.' };
  const targets = await prisma.order.findMany({
    where: { id: { in: ids }, archivedAt: { not: null } },
    select: { id: true, orderNumber: true },
  });
  if (targets.length === 0) return { ok: false, count: 0, message: 'None of the selected orders are archived.' };
  await prisma.order.updateMany({
    where: { id: { in: targets.map((o) => o.id) } },
    data: { archivedAt: null, archivedById: null },
  });
  await audit('order.bulkunarchive', undefined, `${targets.length} orders`);
  revalidatePath('/admin/orders');
  return { ok: true, count: targets.length, message: `Restored ${targets.length} order${targets.length === 1 ? '' : 's'}.` };
}

/** Permanently delete a single order. ARCHIVED-ONLY guard — the operator must
 *  archive first, then delete; that two-step gate prevents single-misclick
 *  destruction of live orders. Also requires the `orders:delete` cap (or
 *  super-admin `*`). The orderNumber + items snapshot is preserved in
 *  AuditLog.meta so the forensic trail survives even after row deletion. */
export async function deleteOrderPermanently(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:delete');
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const o = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true, orderNumber: true, status: true, totalCents: true, currency: true,
      archivedAt: true, paymentProofUrl: true,
      buyer: { select: { email: true } },
      items: { select: { titleSnapshot: true, quantity: true, priceCentsSnapshot: true } },
    },
  });
  if (!o) return { ok: false, message: 'Order not found.' };
  if (!o.archivedAt) return { ok: false, message: 'Archive the order first, then delete.' };
  // A05: financial records are retained (DOC_RETENTION_YEARS, min. 7) — the DB
  // refuses too; this gives the reason.
  const blockers = await orderDeletionBlockers(o.id);
  if (blockers.length) {
    await audit('order.delete.refused', o.orderNumber, blockers.join('; ').slice(0, 480));
    return { ok: false, message: `Order ${o.orderNumber} cannot be deleted: ${blockers.join('; ')}. Financial records are kept for ${settingInt('DOC_RETENTION_YEARS', 7)} years — it stays archived.` };
  }
  const step = await stepUpRequired('orders.delete');
  if (step) return step;
  // An unpaid order still holds its reserved unit(s). Release them through the
  // same Stripe-aware cancel saga as "Cancel order" BEFORE the row disappears —
  // otherwise the product sits at 0 stock forever (nothing can restock an order
  // that no longer exists).
  const release = await releaseBeforeDelete(o.id, o.status);
  if (!release.ok) return { ok: false, message: `Order ${o.orderNumber}: ${release.message}` };

  // Forensic snapshot — written BEFORE the row vanishes so the audit trail
  // can answer "what existed and was wiped?" without the live row.
  const snap = {
    orderNumber: o.orderNumber,
    status: o.status,
    total: `${(o.totalCents / 100).toFixed(2)} ${o.currency}`,
    buyer: o.buyer.email,
    items: o.items.map((it) => `${it.titleSnapshot} × ${it.quantity} @ ${(it.priceCentsSnapshot / 100).toFixed(2)}`),
    hadProof: !!o.paymentProofUrl,
  };
  await audit('order.delete.permanent', o.orderNumber, JSON.stringify(snap).slice(0, 480));

  // Cascade: delete child rows first (OrderItem). Notification rows that
  // referenced this order via title/body text stay — they're a separate
  // audit dimension. Stock of a PAID-family order is NOT restored on delete
  // (the row is gone for ops reasons, not because the buyer asked for a
  // return); an unpaid reservation was already released above.
  await prisma.orderItem.deleteMany({ where: { orderId: id } });
  await prisma.order.delete({ where: { id } });

  revalidatePath('/admin/orders');
  return {
    ok: true,
    message: `Order ${o.orderNumber} permanently deleted.${release.restocked ? ' Its reserved stock was released.' : ''}`,
  };
}

/** Pre-delete step for unpaid orders: cancel (and restock, when the order
 *  reserved stock) via the cancel saga. Paid-family / already-closed orders
 *  pass straight through — their stock is not ours to touch on delete. */
async function releaseBeforeDelete(
  orderId: string,
  status: string,
): Promise<{ ok: true; restocked: boolean } | { ok: false; message: string }> {
  if (status !== 'PENDING_PAYMENT') return { ok: true, restocked: false };
  const snap = await prisma.order.findUnique({
    where: { id: orderId },
    select: { paymentSubmittedAt: true, sourcingRequestId: true },
  });
  if (snap?.paymentSubmittedAt) {
    return { ok: false, message: 'has a payment receipt awaiting verification — verify or reject it before deleting.' };
  }
  const outcome = await cancelOrderSaga(prisma, stripeExpireApi(), orderId, { requireNoProof: true });
  if (outcome === 'expire-failed') {
    return { ok: false, message: "the buyer's payment session could not be expired — nothing was deleted; please retry." };
  }
  if (outcome !== 'canceled') {
    return { ok: false, message: 'its status changed while deleting — refresh and try again.' };
  }
  return { ok: true, restocked: !!snap && orderReservedStock(snap) };
}

/** Bulk permanent delete. Same archived-first guard + cap as the single-row
 *  action. Skipped IDs include not-found and not-archived rows. */
export async function bulkDeleteOrders(
  formData: FormData,
): Promise<{ ok: boolean; count: number; message: string } | (StepUpRequired & { count: number })> {
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:delete');
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No orders selected.' };
  const candidates = await prisma.order.findMany({
    where: { id: { in: ids }, archivedAt: { not: null } },
    select: {
      id: true, orderNumber: true, status: true, totalCents: true, currency: true,
      buyer: { select: { email: true } },
    },
  });
  if (candidates.length === 0) {
    return { ok: false, count: 0, message: 'None of the selected orders are archived. Archive them first.' };
  }
  const step = await stepUpRequired('orders.delete');
  if (step) return { ...step, count: 0 };
  // Unpaid orders release their reserved stock first (same as the single-row
  // delete); any that can't be released are kept and reported, never dropped.
  const targets: typeof candidates = [];
  const kept: string[] = [];
  let restocked = 0;
  for (const o of candidates) {
    const blockers = await orderDeletionBlockers(o.id);
    if (blockers.length) { kept.push(`${o.orderNumber} (${blockers.join(', ')} — kept, archived)`); continue; }
    const release = await releaseBeforeDelete(o.id, o.status);
    if (!release.ok) { kept.push(`${o.orderNumber} ${release.message}`); continue; }
    if (release.restocked) restocked++;
    targets.push(o);
  }
  for (const o of targets) {
    await audit('order.delete.permanent', o.orderNumber, `bulk · ${(o.totalCents / 100).toFixed(2)} ${o.currency} · buyer=${o.buyer.email} · status=${o.status}`);
  }
  if (targets.length > 0) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: targets.map((o) => o.id) } } });
    await prisma.order.deleteMany({ where: { id: { in: targets.map((o) => o.id) } } });
  }
  revalidatePath('/admin/orders');
  const skippedNote = ids.length > candidates.length
    ? ` ${ids.length - candidates.length} not archived — skipped.`
    : '';
  const keptNote = kept.length ? ` Not deleted: ${kept.join('; ')}.` : '';
  const stockNote = restocked ? ` Reserved stock released for ${restocked} unpaid order${restocked === 1 ? '' : 's'}.` : '';
  return {
    ok: targets.length > 0,
    count: targets.length,
    message: `Deleted ${targets.length} order${targets.length === 1 ? '' : 's'}.${stockNote}${skippedNote}${keptNote}`,
  };
}

/**
 * Admin verifies a buyer-submitted payment proof → status PAID (or a part
 * payment), with the amount and value date from the bank statement.
 *
 * BUG-019 fix: race-protection. Concurrent admin Verify clicks used to
 * both fire side effects (audit + email + notification). Now wraps the
 * write in updateMany with the AWAITING_VERIFICATION precondition;
 * only one wins (count===1), the other gets a friendly message.
 *
 * A receipt for less than PAYMENT_LOW_AMOUNT_CONFIRM_PCT of the open amount
 * (usually a typing mistake) and a value date before the order date are only
 * booked with their confirmation tick (confirmLowAmount / confirmEarlierDate).
 */
export async function verifyPayment(formData: FormData): Promise<{ ok: boolean; message: string; confirm?: 'EARLIER_DATE' | 'LOW_AMOUNT' }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  const refused = await financeRefusal();
  if (refused) return refused;
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true, orderNumber: true, status: true, totalCents: true, currency: true, createdAt: true,
      paymentVerificationStatus: true, paymentSubmittedAt: true,
      paymentMethodManual: true,
      paymentProofUrl: true,
      holdReason: true, openHolds: true,
      proformaNumber: true,
      sourcingRequestId: true,
      shippingAddress: true,
      billingAddress: true,
      amountPaidCents: true,
      refunds: LIVE_REFUNDS_SELECT,
      stripePaymentIntentId: true,
      items: { select: { productId: true, quantity: true }, take: 1 },
      buyer: { select: { id: true, email: true, name: true } },
    },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  if (order.paymentVerificationStatus === 'TERMS_REQUESTED') {
    return { ok: false, message: 'This is a request to pay on invoice — no money was received. Use “Approve on invoice terms” (approved credit customers only) or decline the request.' };
  }
  if (order.paymentVerificationStatus !== 'AWAITING_VERIFICATION') {
    return { ok: false, message: `Cannot verify — current state: ${order.paymentVerificationStatus ?? 'none'}.` };
  }
  // Only the receipt staff looked at is booked: a new upload since the page was opened is reviewed first.
  if (reviewedProofChanged(formData, order.paymentProofUrl)) {
    return { ok: false, message: 'The buyer uploaded a new receipt after you opened this page — reload the page and check the new receipt before verifying. Nothing was booked.' };
  }
  // A hold put on while the receipt waited (export compliance, VAT, address,
  // freight, payment review): no money is booked, no invoice issued, until it is cleared.
  const holdBlock = order.status === 'PENDING_PAYMENT'
    ? bookingHoldBlocker({ holdMessage: prePaymentHoldMessage(order), holdReason: order.holdReason, openHolds: order.openHolds }, 'VERIFY')
    : null;
  if (holdBlock) return { ok: false, message: `Not verified: ${holdBlock} Nothing was booked.` };
  // A legacy "Invoice (NET)" submission carries no money: never verify it as paid.
  if ((order.paymentMethodManual ?? '').toUpperCase() === 'INVOICE') {
    return { ok: false, message: 'This submission is “pay on invoice” — no money was received, so it can not be verified as a payment. Reject it (the buyer pays by bank transfer), or approve credit terms for an approved credit customer.' };
  }
  const missingDetails = orderDetailsProblems(order, { vatIdRule: vatIdRule() });
  if (requireDetailsBeforePayment() && missingDetails.length) {
    return { ok: false, message: `Add the buyer’s billing and delivery details first (missing: ${missingDetails.join(', ')}) — the invoice needs the billing address and the shipment the delivery address. Use “Billing & delivery details” on this page.` };
  }
  if (['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status)) {
    return { ok: false, message: `Order is already ${order.status.toLowerCase()}.` };
  }
  // What is still open: the total minus what was received and kept (a part payment that is
  // refunded — or approved to be refunded — is not counted).
  const open = Math.max(0, order.totalCents - heldMoneyCents(order.amountPaidCents, order.refunds));
  const rec = receivedFromForm(formData, open, order.createdAt);
  if (!rec.ok) return rec;
  const tolerance = settingInt('UNDERPAYMENT_TOLERANCE_CENTS', 0);
  // Money in payment messages always with cents ("€400.00", not "€400").
  const cur = (c: number) => fmtDocMoney(c, order.currency);
  const valueDay = fmtValueDay(rec.receivedAt);
  const lowPct = settingInt('PAYMENT_LOW_AMOUNT_CONFIRM_PCT', 50);
  if (lowAmountNeedsConfirm(rec.amountCents, open, lowPct) && formData.get('confirmLowAmount') !== 'on') {
    return {
      ok: false,
      confirm: 'LOW_AMOUNT',
      message: `${cur(rec.amountCents)} is less than ${lowPct}% of the ${cur(open)} open on this order. Check the amount on the bank statement (1.210 is not 1,210.00); if it is right, tick “Part payment below ${lowPct}% — confirmed” and verify again. Nothing was booked.`,
    };
  }
  const proofKey = proofKeyOf(order.paymentProofUrl);

  // ── Short by more than the tolerance: a part payment, not "paid" ──
  if (rec.amountCents + tolerance < open) {
    const stillOpen = open - rec.amountCents;
    const part = await prisma.$transaction(async (tx) => {
      const res = await tx.order.updateMany({
        where: verifyClaimWhere(id, order.paymentProofUrl),
        data: {
          // The receipt was booked (financialStatus PARTIALLY_PAID): the buyer
          // uploads the next one for the rest. The texts say “part payment”.
          paymentVerificationStatus: 'REJECTED',
          paymentRejectionReason: `Part payment received: ${cur(rec.amountCents)} on ${valueDay}. Still due: ${cur(stillOpen)} — please transfer the rest and upload that receipt.`,
          paymentSubmittedAt: null,
          financialStatus: 'PARTIALLY_PAID',
        },
      });
      if (res.count === 1) {
        await recordPayment(tx, {
          orderId: id, amountCents: rec.amountCents, currency: order.currency, method: (order.paymentMethodManual ?? 'BANK_TRANSFER').toUpperCase(),
          receivedAt: rec.receivedAt, reference: rec.bankRef ?? order.proformaNumber ?? order.orderNumber, proofKey: order.paymentProofUrl,
          verifiedById: session.user.id, note: `Part payment verified by ${session.user.email}: ${cur(rec.amountCents)} of ${cur(open)} open.`,
        });
        await recordReceiptEvent(tx, { orderId: id, urlOrKey: proofKey, kind: 'PART', amountCents: rec.amountCents, actorId: session.user.id });
      }
      return res;
    });
    if (part.count !== 1) return { ok: false, message: VERIFY_RACE_MESSAGE };
    const t = (await import('@/lib/finance/texts')).settingText('EMAIL_PART_PAYMENT_BODY', { PAID: cur(rec.amountCents), ORDER: order.orderNumber, DATE: valueDay, TOTAL: cur(order.totalCents), OPEN: cur(stillOpen), REFERENCE: order.proformaNumber ?? order.orderNumber }, ['OPEN']);
    const mail = await trySendEmail({
      to: order.buyer.email,
      subject: `Part payment received — ${cur(stillOpen)} still due for order ${order.orderNumber}`,
      html: mailLayout({ heading: 'Part payment received', body: [`Hi <span dir="auto">${escapeHtml(order.buyer.name ?? 'there')}</span>,`, t.html], cta: { href: `${siteBase()}/app/orders/${order.orderNumber}/payment`, label: 'Go to the payment page' } }),
      text: t.text,
    }, 'orders:part-payment');
    await notifyUser(order.buyer.id, `Part payment received — order ${order.orderNumber}`, t.text.slice(0, 300), `/app/orders/${order.orderNumber}/payment`);
    await audit('order.payment.part', order.orderNumber, `${rec.amountCents} of ${open} value=${rec.receivedAt.toISOString().slice(0, 10)} ref=${rec.bankRef ?? '-'} by ${session.user.email}`);
    revalidatePath('/admin/orders');
    revalidatePath(`/admin/orders/${id}`);
    return {
      ok: true,
      message: `Booked as a PART payment: ${cur(rec.amountCents)} received on ${valueDay}, ${cur(stillOpen)} still due (more than the ${cur(tolerance)} tolerance). The order stays unpaid and no invoice is issued; ${mail.ok ? `the buyer was e-mailed to pay the rest (${order.buyer.email}).` : `the e-mail to ${order.buyer.email} could not be delivered (${mail.error}).`}`,
    };
  }

  const overpaid = rec.amountCents > open ? rec.amountCents - open : 0;
  const short = rec.amountCents < open ? open - rec.amountCents : 0;
  let stock = { short: false, warning: '' };
  const verifyRes = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({
      // Still waiting, still the receipt read above, still no blocking hold.
      where: verifyClaimWhere(id, order.paymentProofUrl),
      data: {
        status: 'PAID',
        // The value date of the money, not the click.
        paidAt: rec.receivedAt,
        paymentVerificationStatus: 'VERIFIED',
        paymentVerifiedAt: new Date(),
        paymentVerifiedById: session.user.id,
        paymentRejectionReason: null,
        // BUG-014 defensive: manual posture has no Stripe brand; ensure a
        // verified order always records a method so it never renders '—'.
        paymentMethodManual: order.paymentMethodManual ?? 'BANK_TRANSFER',
        financialStatus: 'PAID',
      },
    });
    if (res.count !== 1) return res;
    await recordPayment(tx, {
      orderId: id,
      amountCents: rec.amountCents,
      currency: order.currency,
      method: (order.paymentMethodManual ?? 'BANK_TRANSFER').toUpperCase(),
      receivedAt: rec.receivedAt,
      reference: rec.bankRef ?? order.proformaNumber ?? order.orderNumber,
      proofKey: order.paymentProofUrl,
      verifiedById: session.user.id,
      note: `Verified by ${session.user.email} from the bank statement: ${cur(rec.amountCents)}, value date ${rec.receivedAt.toISOString().slice(0, 10)}${short ? ` (short ${cur(short)} — within the tolerance)` : ''}.`,
    });
    if (overpaid > 0) {
      // Paid too much: the difference goes back (approved now, sent by staff) — the refund ledger.
      await requestRefundTx(tx, { orderId: id, amountCents: overpaid, currency: order.currency, method: 'BANK_TRANSFER', reason: `Overpayment: received ${cur(rec.amountCents)} for ${cur(open)} due.`, actorId: session.user.id });
    }
    if (order.sourcingRequestId) {
      await tx.sourcingRequest.updateMany({
        where: { id: order.sourcingRequestId, status: { in: ['PENDING', 'RESPONDED'] } },
        data: { status: 'ACCEPTED' },
      });
    }
    // The unit is sold to this order — or, when it is gone, the order is
    // held (STOCK_SHORTAGE) and no invoice is issued below.
    stock = await takeUnitOrHold(tx, order, session.user.email);
    return res;
  });
  if (verifyRes.count !== 1) return { ok: false, message: VERIFY_RACE_MESSAGE };
  await audit('order.payment.verify', order.orderNumber, `verifier=${session.user.email} amount=${rec.amountCents} value=${rec.receivedAt.toISOString().slice(0, 10)} ref=${rec.bankRef ?? '-'}${overpaid ? ` overpaid=${overpaid}` : ''}${short ? ` short=${short}` : ''}${stock.short ? ' STOCK_SHORTAGE' : ''}`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath('/app/quotes');
  revalidatePath('/admin/quotes');
  if (order.sourcingRequestId) {
    revalidatePath(`/app/quotes/${order.sourcingRequestId}`);
    revalidatePath(`/admin/quotes/${order.sourcingRequestId}`);
  }
  const moneyNote = overpaid
    ? ` Received ${cur(rec.amountCents)} for ${cur(open)} due: the overpayment of ${cur(overpaid)} is recorded as a refund REQUESTED — transfer it back and mark it sent.`
    : short ? ` Received ${cur(rec.amountCents)} — ${cur(short)} short, within the tolerance of ${cur(tolerance)} (counts as paid in full).` : '';
  if (stock.short) {
    const shortNote = await announceStockShortage(order, rec, stock.warning);
    return { ok: true, message: `Payment verified (${cur(rec.amountCents)}, value date ${valueDay}).${moneyNote}${shortNote}` };
  }
  await notifyUser(
    order.buyer.id,
    `Payment verified — order ${order.orderNumber}`,
    'Your payment has been verified. We will prepare your order for shipping.',
    `/app/orders/${order.orderNumber}`,
  );
  // ONE email to the buyer: the invoice email ("Payment received — thank you",
  // invoice attached). Only when no invoice could go out is a separate
  // "payment verified" email sent — saying truthfully why the invoice waits.
  const invoiceMail = await sendOrderInvoice(order.id, { actorId: session.user.id });
  let verifiedMailNote = '';
  if (!invoiceMail.issued || !invoiceMail.emailed) {
    const { settingText } = await import('@/lib/finance/texts');
    const v = settingText('EMAIL_PAYMENT_VERIFIED_BODY', { AMOUNT: cur(rec.amountCents), ORDER: order.orderNumber, DATE: valueDay }, ['AMOUNT', 'ORDER']);
    const delayed = settingText('EMAIL_INVOICE_DELAYED_TEXT', { ORDER: order.orderNumber });
    const vm = await trySendEmail({
      to: order.buyer.email,
      subject: `Payment verified — order ${order.orderNumber}`,
      html: mailLayout({
        heading: 'Payment received — thank you',
        body: [
          `Hi <span dir="auto">${escapeHtml(order.buyer.name ?? 'there')}</span>,`,
          v.html,
          invoiceMail.issued ? `Your invoice ${escapeHtml(invoiceMail.number ?? '')} is available on your order page.` : delayed.html,
        ],
        cta: { href: `${siteBase()}/app/orders/${order.orderNumber}`, label: 'View your order' },
      }),
      text: `${v.text}\n${invoiceMail.issued ? `Your invoice ${invoiceMail.number ?? ''} is available on your order page.` : delayed.text}`,
    }, 'orders:verified');
    verifiedMailNote = vm.ok ? ' The buyer was emailed that the payment is verified.' : ` The “payment verified” email to ${order.buyer.email} could not be delivered either (${vm.error}).`;
  }
  await notifyAdmins(
    `Payment verified — order ${order.orderNumber} (${cur(rec.amountCents)} received ${valueDay})`,
    `Verified by ${session.user.email}.${overpaid ? ` Overpaid by ${cur(overpaid)} — refund REQUESTED, send it back.` : ''}`,
    `/admin/orders/${id}`,
    overpaid ? 'ORDER_REFUNDED' : 'PAYMENT_VERIFIED',
  );
  // The supplier who owns the unit prepares it for dispatch (never throws).
  await notifySupplierOfSale(order.id, 'PAID').catch(() => {});
  return {
    ok: true,
    message: `Payment verified (${cur(rec.amountCents)}, value date ${valueDay}).${moneyNote} ${invoiceMailSummary(invoiceMail)}${verifiedMailNote}${
      shippingAddressIsComplete(order.shippingAddress) ? '' : ' No complete shipping address on file yet — add it on the order page before shipping.'
    }${stock.warning}`,
  };
}

/** Admin rejects a buyer-submitted payment proof; buyer can resubmit. The
 *  rejected receipt stays on file (PaymentProof REJECTED) and viewable. */
export async function rejectPayment(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  const refused = await financeRefusal();
  if (refused) return refused;
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 500);
  if (!id) return { ok: false, message: 'Missing order id.' };
  if (reason.length < 4) return { ok: false, message: 'Rejection reason is required (min 4 chars).' };
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true, orderNumber: true, status: true,
      paymentVerificationStatus: true,
      paymentProofUrl: true,
      buyer: { select: { id: true, email: true, name: true } },
    },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  if (order.paymentVerificationStatus !== 'AWAITING_VERIFICATION') {
    return { ok: false, message: `Cannot reject — current state: ${order.paymentVerificationStatus ?? 'none'}.` };
  }
  // The reason is about the receipt staff looked at — never pin it on a newer upload.
  if (reviewedProofChanged(formData, order.paymentProofUrl)) {
    return { ok: false, message: 'The buyer uploaded a new receipt after you opened this page — reload the page and check the new receipt first. Nothing was rejected.' };
  }
  // BUG-037: claim the transition atomically (mirror of verifyPayment). The
  // in-memory AWAITING_VERIFICATION check above races a concurrent verify /
  // buyer-resubmit / double-click reject. Re-encode the precondition in the
  // write's WHERE and gate ALL side effects on count===1 so reject can never
  // overwrite a just-verified PAID order (F15 regression) or double-notify.
  const rejectRes = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({
      where: {
        id,
        paymentVerificationStatus: 'AWAITING_VERIFICATION',
        status: 'PENDING_PAYMENT',
        paymentProofUrl: order.paymentProofUrl,
      },
      data: {
        paymentVerificationStatus: 'REJECTED',
        paymentRejectionReason: reason,
        paymentSubmittedAt: null,
        paymentVerifiedAt: null,
        paymentVerifiedById: null,
      },
    });
    if (res.count === 1) await recordReceiptEvent(tx, { orderId: id, urlOrKey: order.paymentProofUrl, kind: 'REJECTED', actorId: session.user.id, rejectedReason: reason });
    return res;
  });
  if (rejectRes.count !== 1) {
    return {
      ok: false,
      message: 'Rejection race — another admin already acted on this order (likely verified it), or the buyer sent a new receipt. Refresh to see the current state.',
    };
  }
  await notifyUser(
    order.buyer.id,
    `Payment proof needs attention — order ${order.orderNumber}`,
    `Your receipt was reviewed and we need to ask for a corrected proof. Reason: ${reason.slice(0, 120)}`,
    `/app/orders/${order.orderNumber}/payment`,
  );
  const payUrl = `${siteBase()}/app/orders/${order.orderNumber}/payment`;
  const rejectMail = await trySendEmail({
      to: order.buyer.email,
      subject: `Payment proof needs attention — order ${order.orderNumber}`,
      html: mailLayout({
        heading: 'Your payment receipt needs attention',
        body: [
          `Hi <span dir="auto">${escapeHtml(order.buyer.name ?? 'there')}</span>,`,
          `We reviewed the receipt you uploaded for order <strong>${escapeHtml(order.orderNumber)}</strong> and need a corrected one:`,
          `<p style="margin:0 0 12px;padding:10px 14px;border-left:3px solid #d97706;background:#fffbeb;color:#78350f;" dir="auto">${escapeHtmlLines(reason)}</p>`,
          'Please upload the bank’s transfer confirmation for this order on the payment page.',
        ],
        cta: { href: payUrl, label: 'Upload a corrected receipt' },
      }),
      text: `We need a corrected receipt for order ${order.orderNumber}.\n\nReason: ${reason}\n\nUpload a corrected receipt: ${payUrl}`,
    }, 'orders:reject-proof');
  await notifyAdmins(
    `Payment rejected — order ${order.orderNumber}`,
    `Reason: ${reason.slice(0, 120)} (by ${session.user.email}).`,
    `/admin/orders/${id}`,
    'PAYMENT_REJECTED',
  );
  await audit('order.payment.reject', order.orderNumber, `reason="${reason.slice(0, 80)}"`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  return {
    ok: true,
    message: rejectMail.ok
      ? 'Payment rejected; the buyer was emailed and notified in-app.'
      : `Payment rejected; the buyer was notified in-app, but the email to ${order.buyer.email} could not be delivered (${rejectMail.error}).`,
  };
}

// ─── Business-core admin actions (4_business_core) ──────────────────────────

/** Issue (or retry issuing) the invoice of a paid order — e.g. after the VAT
 *  settings or the buyer's billing details were corrected. Finance work; never
 *  while the unit is missing (STOCK_SHORTAGE: refunded, or the unit secured
 *  and the hold released, first). */
export async function issueOrderInvoiceAction(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  const refused = await financeRefusal();
  if (refused) return refused;
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const held = await prisma.order.findUnique({ where: { id }, select: { holdReason: true, openHolds: true } });
  if (held && onStockShortage(held)) {
    return { ok: false, message: 'Not issued: the unit of this order is no longer in stock (STOCK SHORTAGE hold). Refund it (Cancel & refund), or secure the unit and release the hold under “Stock shortage” — that issues the invoice.' };
  }
  const r = await sendOrderInvoice(id, { actorId: session.user.id });
  await audit('order.invoice.issue', id, r.issued ? `${r.number}` : `not issued: ${(r.notIssuedReason ?? '').slice(0, 200)}`);
  revalidatePath(`/admin/orders/${id}`);
  return { ok: r.issued, message: invoiceMailSummary(r) };
}

/**
 * Stock shortage resolved: the unit is secured — back in this listing's stock
 * (it is taken from stock now) or arranged outside the listing (another unit
 * from the supplier; the listing's stock is unchanged), also at the end of a
 * backorder. The hold goes with a line in the internal notes, the invoice is
 * issued and e-mailed, and the order can ship. A refund instead is “Cancel &
 * refund”. Finance work (it issues the invoice).
 */
export async function releaseStockShortageAction(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  const refused = await financeRefusal();
  if (refused) return refused;
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  const source = String(formData.get('source') ?? '');
  const note = String(formData.get('note') ?? '').trim().slice(0, 300);
  if (!id) return { ok: false, message: 'Missing order id.' };
  if (source !== 'LISTING' && source !== 'OUTSIDE') return { ok: false, message: 'Choose where the unit comes from.' };
  if (note.length < 4) return { ok: false, message: 'Write down how the unit was secured (e.g. “second unit from the supplier, ships 24 Oct”) — it is kept on the order.' };
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true, orderNumber: true, status: true, currency: true, amountPaidCents: true, paidAt: true, sourcingRequestId: true, shippingAddress: true,
      openHolds: true, holdReason: true, holdNote: true, adminNotes: true,
      items: { select: { productId: true, quantity: true }, take: 1 }, buyer: { select: { id: true, email: true, name: true } },
    },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  if (!onStockShortage(order)) return { ok: false, message: `Order ${order.orderNumber} has no stock-shortage hold.` };
  if (!['PAID', 'PROCESSING'].includes(order.status)) {
    return { ok: false, message: `Order ${order.orderNumber} is ${order.status.toLowerCase()} — there is no stock-shortage hold to release on it.` };
  }
  const fromListing = source === 'LISTING';
  if (fromListing && !order.sourcingRequestId) {
    return { ok: false, message: 'This order holds no quote unit to take from stock — choose “arranged outside the listing” (and adjust the listing’s stock by hand if needed).' };
  }
  const next = withoutHold(order, STOCK_SHORTAGE_HOLD, HOLD_PRIORITY);
  let stillShort = '';
  const claimed = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({
      // CAS on the hold list: a second click, or another hold change meanwhile, loses.
      where: { id, status: { in: ['PAID', 'PROCESSING'] }, openHolds: { equals: order.openHolds } },
      data: {
        openHolds: next.openHolds as OrderHoldReason[],
        holdReason: next.holdReason as OrderHoldReason | null,
        holdNote: next.holdNote,
        ...(next.openHolds.length ? {} : { holdAt: null }),
        adminNotes: `${order.adminNotes ? `${order.adminNotes}\n` : ''}[${new Date().toISOString().slice(0, 10)}] Stock shortage resolved by ${session.user.email}: ${note} (${fromListing ? 'unit taken from the listing’s stock' : 'unit arranged outside the listing — its stock is unchanged'}).`.slice(0, 4000),
      },
    });
    if (res.count !== 1) return false;
    if (fromListing) {
      const unit = await takeQuoteUnit(tx, order);
      if (unit.short) {
        stillShort = unit.warning.replace(/^\s*Warning:\s*/i, '').trim() || 'the unit could not be taken from stock';
        throw new Error('stock still short');
      }
    }
    return true;
  }).catch((e: unknown) => {
    if (stillShort) return null;
    throw e;
  });
  if (claimed === null) {
    return { ok: false, message: `The listing still has no unit for this order (${stillShort}). Put the unit back in the listing’s stock first, or choose “arranged outside the listing”. Nothing was changed.` };
  }
  if (!claimed) return { ok: false, message: 'The order changed meanwhile (the hold was released, or another hold changed) — refresh and check the current state. Nothing was changed.' };
  await audit('order.stock-shortage.release', order.orderNumber, `${source} by ${session.user.email}: ${note}`.slice(0, 500));
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath(`/app/orders/${order.orderNumber}`);

  // The invoice follows now (it was withheld while the unit was missing).
  const invoiceMail = await sendOrderInvoice(order.id, { actorId: session.user.id });
  const { settingText } = await import('@/lib/finance/texts');
  const delayed = settingText('EMAIL_INVOICE_DELAYED_TEXT', { ORDER: order.orderNumber });
  await notifyUser(
    order.buyer.id,
    `Order ${order.orderNumber}: your item is confirmed`,
    `The item for your order is secured and we prepare it for shipping. ${invoiceMail.issued ? 'Your invoice is on your order page.' : delayed.text}`.slice(0, 300),
    `/app/orders/${order.orderNumber}`,
  );
  let buyerMailNote = '';
  if (!invoiceMail.issued || !invoiceMail.emailed) {
    // No invoice e-mail went out: the buyer is still told the order goes ahead.
    const v = settingText('EMAIL_PAYMENT_VERIFIED_BODY', { AMOUNT: fmtDocMoney(order.amountPaidCents, order.currency), ORDER: order.orderNumber, DATE: order.paidAt ? fmtValueDay(order.paidAt) : 'not recorded' }, ['AMOUNT', 'ORDER']);
    const invoiceLine = invoiceMail.issued ? { html: `Your invoice ${escapeHtml(invoiceMail.number ?? '')} is available on your order page.`, text: `Your invoice ${invoiceMail.number ?? ''} is available on your order page.` } : delayed;
    const m = await trySendEmail({
      to: order.buyer.email,
      subject: `Your item is confirmed — order ${order.orderNumber}`,
      html: mailLayout({
        heading: 'Your item is confirmed',
        body: [`Hi <span dir="auto">${escapeHtml(order.buyer.name ?? 'there')}</span>,`, v.html, invoiceLine.html],
        cta: { href: `${siteBase()}/app/orders/${order.orderNumber}`, label: 'View your order' },
      }),
      text: `${v.text}\n${invoiceLine.text}`,
    }, 'orders:stock-secured');
    buyerMailNote = m.ok ? ' The buyer was e-mailed that the order goes ahead.' : ` The e-mail to ${order.buyer.email} could not be delivered (${m.error}).`;
  }
  // The listing's supplier prepares the unit for dispatch; a unit arranged elsewhere is staff's to arrange.
  if (fromListing) await notifySupplierOfSale(order.id, 'PAID').catch(() => {});
  const stillOpen = next.openHolds.length ? ` Still on hold: ${next.openHolds.map(holdTitle).join(', ')}.` : '';
  return {
    ok: true,
    message: `Stock-shortage hold released (${fromListing ? 'unit taken from the listing’s stock' : 'unit arranged outside the listing — the listing’s stock is unchanged; tell the supplier who ships it'}). ${invoiceMailSummary(invoiceMail)}${buyerMailNote}${stillOpen}${
      shippingAddressIsComplete(order.shippingAddress) ? '' : ' No complete shipping address on file yet — add it on the order page before shipping.'
    }`,
  };
}

/**
 * Issue the first proforma of a payable order — an explicit staff action
 * (opening a document link never issues one for staff).
 */
export async function issueOrderProformaAction(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:fulfil');
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const r = await issueProforma(id, { actorId: session.user.id });
  if (!r.ok) return { ok: false, message: r.message };
  await audit('order.proforma.issue', id, r.document.number);
  revalidatePath(`/admin/orders/${id}`);
  return { ok: true, message: `Proforma ${r.document.number} issued. Download it below or email it to the buyer.` };
}

/** New revision of an unpaid order's proforma (amounts/addresses changed). */
export async function reissueOrderProformaAction(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:fulfil');
  const id = String(formData.get('orderId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 300);
  if (!id) return { ok: false, message: 'Missing order id.' };
  if (reason.length < 4) return { ok: false, message: 'Say why the proforma is re-issued (min. 4 characters).' };
  const before = await prisma.fiscalDocument.findFirst({ where: { orderId: id, kind: 'PROFORMA', supersededById: null, voidedAt: null }, select: { number: true } });
  const r = await reissueProforma(id, reason, { actorId: session.user.id });
  if (!r.ok) return { ok: false, message: r.message };
  await audit('order.proforma.reissue', id, `${r.document.number} · ${reason}`);
  // The buyer gets the new revision (and is told the old one must not be paid).
  const o = await prisma.order.findUnique({ where: { id }, select: { orderNumber: true, totalCents: true, currency: true, invoiceEmail: true, buyer: { select: { email: true, name: true } } } });
  let mail = '';
  if (o) {
    const att = await documentAttachment(r.document);
    const sent = await trySendEmail({
      to: o.invoiceEmail || o.buyer.email,
      subject: `Updated proforma ${r.document.number} — order ${o.orderNumber}`,
      html: mailLayout({
        heading: 'Your proforma was updated',
        body: [
          `Hi <span dir="auto">${escapeHtml(o.buyer.name || 'there')}</span>,`,
          `We issued proforma <strong>${escapeHtml(r.document.number)}</strong> for order <strong>${o.orderNumber}</strong> (${escapeHtml(formatPrice(o.totalCents, o.currency))}): ${escapeHtml(reason)}.`,
          before ? `It replaces <strong>${escapeHtml(before.number)}</strong> — please do not pay that one; quote <strong>${escapeHtml(r.document.number)}</strong> as the transfer reference.` : `Please quote <strong>${escapeHtml(r.document.number)}</strong> as the transfer reference.`,
          att.attachment ? 'The proforma is attached (PDF).' : 'The proforma is on your payment page.',
        ],
        cta: { href: `${process.env.BETTER_AUTH_URL ?? ''}/app/orders/${o.orderNumber}/payment`, label: 'Go to the payment page' },
      }),
      attachments: att.attachment ? [att.attachment] : [],
    }, 'orders:proforma-revision');
    if (sent.ok) await markDocumentSent(r.document.id);
    mail = sent.ok ? ` It was emailed to the buyer (${o.invoiceEmail || o.buyer.email}).` : ` The email to the buyer could not be delivered (${sent.error}) — send it from the order page.`;
  }
  revalidatePath(`/admin/orders/${id}`);
  return { ok: true, message: `Proforma ${r.document.number} issued (replaces ${before?.number ?? 'the previous revision'}).${mail}` };
}

export async function revertSettingAction(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  const changeId = String(formData.get('changeId') ?? '');
  await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  if (!(await hasCapability('settings:write'))) {
    return { ok: false, message: 'Your admin account lacks the “settings:write” permission.' };
  }
  // A revert is a change like any other: the same gates as saving it.
  const change = await prisma.settingChange.findUnique({ where: { id: changeId }, select: { key: true, oldValue: true } });
  const def = change ? settingDef(change.key) : undefined;
  const isPolicy = !!change && isSecurityPolicyKey(change.key);
  if (isPolicy && change && def) {
    if (!(await hasCapability('security:manage'))) {
      return { ok: false, message: 'Reverting a security setting needs the security:manage permission (super-admins).' };
    }
    // The policy's cross-field rules (e.g. longest pause ≥ first pause) apply to a revert too.
    const policy = await getSecurityPolicy();
    const policyInput: Record<string, string | string[]> = Object.fromEntries(
      POLICY_DEFS.map((d) => {
        const v = (policy as unknown as Record<string, unknown>)[d.key];
        return [d.key, Array.isArray(v) ? v.map(String) : String(v)];
      }),
    );
    const old = change.oldValue ?? def.default ?? '';
    policyInput[change.key] = def.type === 'list' ? old.split(',').map((s) => s.trim()).filter(Boolean) : old;
    const plan = planPolicySave(policy, policyInput);
    if (plan.problems.length) return { ok: false, message: `${plan.problems.join(' ')} Nothing was reverted.` };
    const step = await stepUpRequired('security.settings');
    if (step) return step;
  } else if (def && stepUpSetting(def)) {
    const step = await stepUpRequired('settings.sensitive');
    if (step) return step;
  }
  const session = await getServerSession();
  const actor = await settingActor(session?.user.id ?? null, session?.user.email ?? null);
  try {
    const r = await revertSettingChange(String(changeId ?? ''), actor);
    if (r.ok) await audit('settings.revert', changeId, r.message.slice(0, 200));
    if (r.ok && isPolicy && change && def) {
      invalidatePolicyCache();
      await audit('security.policy', change.key, `${def.label}: ${r.message}`.slice(0, 480));
      await alertSuperAdmins('Security policy changed', [`${actor.email ?? 'An admin'} reverted: ${r.message}`], '/admin/settings/security');
    }
    revalidatePath('/admin/settings');
    if (isPolicy) revalidatePath('/admin/settings/security');
    return r;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 600) : 'Revert failed.' };
  }
}

/** Admin "test a VAT ID" (Settings → Tax & VAT): live VIES check, stored as evidence. */
export async function checkVatIdAction(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const vatId = String(formData.get('vatId') ?? '').trim();
  if (!vatId) return { ok: false, message: 'Enter a VAT ID, e.g. DE123456789.' };
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  if (!(await hasCapability('settings:view'))) return { ok: false, message: 'Missing settings:view permission.' };
  const { checkVatId } = await import('@/lib/tax/vies');
  const r = await checkVatId(String(vatId ?? '').slice(0, 30), { force: true, actorId: session.user.id });
  const policy = (await import('@/lib/settings')).settingEnum<'MANUAL_REVIEW' | 'CHARGE_HOME_VAT' | 'BLOCK'>('TAX_VIES_DOWN_POLICY');
  const policyText = policy === 'BLOCK' ? 'sales to this buyer are blocked until VIES answers' : policy === 'CHARGE_HOME_VAT' ? 'home VAT is charged meanwhile' : 'orders go on VAT review meanwhile';
  const label =
    r.status === 'VALID' ? `VALID — VIES confirms it${r.name ? ` (${r.name})` : ''}${r.consultationNumber ? `, consultation ${r.consultationNumber}` : ''}.${r.error ? ` Warning: ${r.error}` : ''}`
      : r.status === 'INVALID' ? (r.source === 'FORMAT' ? `not an EU VAT ID — ${r.error ?? 'wrong format'} (not sent to VIES).` : `NOT VALID — VIES answered “invalid” for this number.${r.error ? ` (${r.error})` : ''}`)
      : r.status === 'NOT_CHECKED' ? 'not checked — live VIES checks are switched off (Tax & VAT).'
      : `could not be checked — VIES answered with an error: ${r.error ?? 'unknown error'}. This is not “invalid”: the “When VIES is unavailable” policy applies (${policyText}).`;
  return { ok: r.status === 'VALID' && !r.error, message: `${r.vatId || vatId}: ${label}` };
}

const CountryInput = z.object({
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a 2-letter country code.'),
  name: z.string().trim().min(2, 'Country name is required.').max(80),
  isEu: z.boolean(),
  vatRatePct: z.string().trim().regex(/^(\d{1,2}(\.\d{1,2})?)?$/, 'VAT rate like 21 or 25.5 (or empty).'),
  mode: z.enum(['ALLOW', 'REVIEW', 'BLOCK']),
  note: z.string().trim().max(300).optional(),
});

/**
 * The country table (VAT rate, EU membership, ship policy) and the shipping
 * zones / rates decide the VAT and freight of every order: the same gate as
 * the Tax & VAT settings — settings:write plus a fresh authenticator code
 * (settings.sensitive) — and every change is listed in Change history (a
 * SettingChange row with source COUNTRY_POLICY / SHIPPING) and announced to
 * the admins.
 */
async function fiscalTableGate(): Promise<{ ok: false; message: string } | StepUpRequired | { ok: true; actor: SettingActor }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  if (!(await hasCapability('settings:write'))) return { ok: false, message: 'Missing settings:write permission.' };
  const step = await stepUpRequired('settings.sensitive');
  if (step) return step;
  return { ok: true, actor: await settingActor(session.user.id, session.user.email) };
}

async function recordTableChange(
  actor: SettingActor,
  source: 'COUNTRY_POLICY' | 'SHIPPING',
  key: string,
  oldValue: string | null,
  newValue: string | null,
  title: string,
): Promise<void> {
  if (oldValue === newValue) return;
  await prisma.settingChange.create({
    data: {
      key: key.slice(0, 190),
      oldValue,
      newValue,
      source,
      actorId: actor.id ?? null,
      actorEmail: actor.email ?? null,
      ip: actor.ip ? actor.ip.slice(0, 80) : null,
      userAgent: actor.userAgent ? actor.userAgent.slice(0, 300) : null,
    },
  }).catch(() => {});
  await notifyAdmins(
    `${title} changed by ${actor.email ?? 'an admin'}`,
    `${oldValue ?? '(new)'} → ${newValue ?? '(removed)'} — see Settings → Change history.`.slice(0, 500),
    '/admin/settings?tab=Change%20history',
    'SYSTEM',
  );
}

export async function saveCountryPolicy(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  const parsed = CountryInput.safeParse({
    country: String(formData.get('country') ?? ''),
    name: String(formData.get('name') ?? ''),
    isEu: formData.get('isEu') === 'true',
    vatRatePct: String(formData.get('vatRatePct') ?? ''),
    mode: String(formData.get('mode') ?? ''),
    note: String(formData.get('note') ?? ''),
  });
  // Permission first: a crafted call never learns more than “no”.
  const gate = await fiscalTableGate();
  if (!gate.ok) return gate;
  if (!parsed.success) return { ok: false, message: zodMessage(parsed.error) };
  const d = parsed.data;
  const bp = d.vatRatePct ? Math.round(Number(d.vatRatePct) * 100) : null;
  if (d.isEu && bp == null) return { ok: false, message: 'An EU member state needs its standard VAT rate (used for OSS).' };
  const before = await prisma.countryPolicy.findUnique({ where: { country: d.country } });
  const after = await prisma.countryPolicy.upsert({
    where: { country: d.country },
    create: { country: d.country, name: d.name, isEu: d.isEu, vatStandardRateBp: bp, mode: d.mode, note: d.note || null, updatedById: gate.actor.id ?? null },
    update: { name: d.name, isEu: d.isEu, vatStandardRateBp: bp, mode: d.mode, note: d.note || null, updatedById: gate.actor.id ?? null },
  });
  await audit('settings.country', d.country, `${before ? `${before.mode}${before.isEu ? '/EU' : ''}/${before.vatStandardRateBp ?? '-'}` : 'new'} → ${d.mode}${d.isEu ? '/EU' : ''}/${bp ?? '-'}`);
  await recordTableChange(gate.actor, 'COUNTRY_POLICY', `COUNTRY_POLICY:${d.country}`, countryPolicyValue(before), countryPolicyValue(after), `Country policy ${d.country}`);
  revalidatePath('/admin/settings');
  return { ok: true, message: `${d.name} (${d.country}) saved: ${d.mode.toLowerCase()}${d.isEu ? ', EU member' : ', not an EU member'}${bp != null ? `, VAT ${d.vatRatePct}%` : ''}. Listed in Change history.` };
}

export async function deleteCountryPolicy(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  const c = String(formData.get('country') ?? '').toUpperCase();
  const gate = await fiscalTableGate();
  if (!gate.ok) return gate;
  const before = await prisma.countryPolicy.findUnique({ where: { country: c } });
  const r = await prisma.countryPolicy.deleteMany({ where: { country: c } });
  if (r.count) {
    await audit('settings.country.delete', c);
    await recordTableChange(gate.actor, 'COUNTRY_POLICY', `COUNTRY_POLICY:${c}`, countryPolicyValue(before), null, `Country policy ${c}`);
  }
  revalidatePath('/admin/settings');
  return r.count ? { ok: true, message: `${c} removed — it now follows the “countries not in the table” policy.` } : { ok: false, message: `${c} was not in the table.` };
}

const eurToCents = (v: FormDataEntryValue | null): number | null => {
  const s = String(v ?? '').trim().replace(',', '.').replace(/[€\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
};

export async function saveShippingZone(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  const gate = await fiscalTableGate();
  if (!gate.ok) return gate;
  const id = String(formData.get('id') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim().slice(0, 80);
  const countries = String(formData.get('countries') ?? '').split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (name.length < 2) return { ok: false, message: 'Give the zone a name.' };
  if (!countries.length || !countries.every((c) => c === '*' || /^[A-Z]{2}$/.test(c))) {
    return { ok: false, message: 'Countries: 2-letter codes separated by commas (or * for “everywhere else”).' };
  }
  const data = {
    name,
    countries: Array.from(new Set(countries)),
    active: formData.get('active') !== 'false',
    sortOrder: Number.parseInt(String(formData.get('sortOrder') ?? '0'), 10) || 0,
  };
  const before = id ? await prisma.shippingZone.findUnique({ where: { id } }) : null;
  if (id && !before) return { ok: false, message: 'Zone not found — it may have been removed.' };
  const zone = id ? await prisma.shippingZone.update({ where: { id }, data }) : await prisma.shippingZone.create({ data });
  await audit('settings.shipping.zone', zone.id, `${zone.name}: ${zone.countries.join(',')}`);
  await recordTableChange(gate.actor, 'SHIPPING', `SHIPPING_ZONE:${zone.name}`, shippingZoneValue(before), shippingZoneValue(zone), `Shipping zone “${zone.name}”`);
  revalidatePath('/admin/settings');
  return { ok: true, message: `Zone “${zone.name}” saved (${zone.countries.join(', ')}).` };
}

export async function deleteShippingZone(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  const id = String(formData.get('id') ?? '');
  const gate = await fiscalTableGate();
  if (!gate.ok) return gate;
  const z0 = await prisma.shippingZone.findUnique({ where: { id } });
  if (!z0) return { ok: false, message: 'Zone not found.' };
  await prisma.shippingZone.delete({ where: { id } });
  await audit('settings.shipping.zone.delete', id, z0.name);
  await recordTableChange(gate.actor, 'SHIPPING', `SHIPPING_ZONE:${z0.name}`, shippingZoneValue(z0), null, `Shipping zone “${z0.name}”`);
  revalidatePath('/admin/settings');
  return { ok: true, message: `Zone “${z0.name}” and its rates removed.` };
}

export async function saveShippingRate(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  const gate = await fiscalTableGate();
  if (!gate.ok) return gate;
  const id = String(formData.get('id') ?? '').trim();
  const zoneId = String(formData.get('zoneId') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim().slice(0, 80);
  const shippingClass = String(formData.get('shippingClass') ?? '');
  const basis = String(formData.get('basis') ?? 'FLAT');
  const amount = eurToCents(formData.get('amount'));
  const freeAbove = eurToCents(formData.get('freeAbove'));
  const handling = eurToCents(formData.get('handling')) ?? 0;
  const kg = (k: string) => {
    const v = String(formData.get(k) ?? '').trim().replace(',', '.');
    return v ? Number(v) : null;
  };
  const minKg = kg('minKg');
  const maxKg = kg('maxKg');
  const zone = zoneId ? await prisma.shippingZone.findUnique({ where: { id: zoneId }, select: { id: true, name: true } }) : null;
  if (!zone) return { ok: false, message: 'Choose a zone.' };
  if (name.length < 2) return { ok: false, message: 'Give the rate a name (e.g. “DHL parcel”).' };
  if (!['PARCEL', 'PALLET', 'FREIGHT_QUOTE'].includes(shippingClass)) return { ok: false, message: 'Choose a shipping class.' };
  if (!['FLAT', 'PER_ITEM', 'PER_KG'].includes(basis)) return { ok: false, message: 'Choose how the rate is charged.' };
  if (amount == null || Number.isNaN(amount)) return { ok: false, message: 'Amount in euros, e.g. 45.00.' };
  if (Number.isNaN(freeAbove as number) || Number.isNaN(handling) || [minKg, maxKg].some((v) => v != null && !(Number.isFinite(v) && v >= 0))) {
    return { ok: false, message: 'Amounts and weights must be positive numbers.' };
  }
  const data = {
    zoneId,
    name,
    shippingClass: shippingClass as 'PARCEL' | 'PALLET' | 'FREIGHT_QUOTE',
    basis: basis as 'FLAT' | 'PER_ITEM' | 'PER_KG',
    amountCents: amount,
    freeAboveCents: freeAbove,
    handlingCents: handling,
    minKg,
    maxKg,
    leadTimeText: String(formData.get('leadTime') ?? '').trim().slice(0, 80) || null,
    active: formData.get('active') !== 'false',
  };
  const before = id ? await prisma.shippingRate.findUnique({ where: { id } }) : null;
  if (id && !before) return { ok: false, message: 'Rate not found — it may have been removed.' };
  const rate = id ? await prisma.shippingRate.update({ where: { id }, data }) : await prisma.shippingRate.create({ data });
  await audit('settings.shipping.rate', rate.id, `${rate.name} ${rate.shippingClass} ${rate.basis} ${rate.amountCents}`);
  await recordTableChange(gate.actor, 'SHIPPING', `SHIPPING_RATE:${zone.name}/${rate.name}`, shippingRateValue(before), shippingRateValue(rate), `Shipping rate “${rate.name}” (${zone.name})`);
  revalidatePath('/admin/settings');
  return { ok: true, message: `Rate “${rate.name}” saved.` };
}

export async function deleteShippingRate(formData: FormData): Promise<{ ok: boolean; message: string } | StepUpRequired> {
  const id = String(formData.get('id') ?? '');
  const gate = await fiscalTableGate();
  if (!gate.ok) return gate;
  const before = await prisma.shippingRate.findUnique({ where: { id }, include: { zone: { select: { name: true } } } });
  const r = await prisma.shippingRate.deleteMany({ where: { id } });
  if (r.count) {
    await audit('settings.shipping.rate.delete', id);
    if (before) await recordTableChange(gate.actor, 'SHIPPING', `SHIPPING_RATE:${before.zone.name}/${before.name}`, shippingRateValue(before), null, `Shipping rate “${before.name}” (${before.zone.name})`);
  }
  revalidatePath('/admin/settings');
  return r.count ? { ok: true, message: 'Rate removed.' } : { ok: false, message: 'Rate not found.' };
}
