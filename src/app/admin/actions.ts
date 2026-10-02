'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { deleteOrArchiveProduct, productDeleteDbFrom } from '@/lib/products/delete-guard';
import { cancelOrderSaga, cancelOrdersBatch, type StripeSessionApi } from '@/lib/orders/stripe-handoff';
import { orderReservedStock } from '@/lib/orders/checkout-tx';
import { sendOrderInvoice } from '@/lib/orders/internal';
import { proxyProofUrl } from '@/lib/orders/display';
import { expireOnlyApi } from '@/lib/stripe/session-api';
import { requireSession, requireCapability, hasCapability, sendAdminPasswordReset } from '@/lib/auth-server';
import { CAPABILITIES, CAPABILITY_PRESETS } from '@/lib/capabilities';
import { Prisma, UserRole } from '@prisma/client';
import { saveSettings as persistSettings, SETTING_DEFS } from '@/lib/settings';
import { uploadObject } from '@/lib/storage/s3';
import { readVerifiedUpload } from '@/lib/storage/file-type';
import { isDeliverableEmail, sendEmail } from '@/lib/email';
import { escapeHtml, escapeHtmlLines } from '@/lib/email-html';
import { ensureSettingsLoaded } from '@/lib/settings';
import { getStripe } from '@/lib/stripe/client';
import { aiConfig } from '@/lib/ai';
import { ensureBucket } from '@/lib/storage/s3';
import { audit, notifyUser, notifyAdmins } from '@/lib/observability';
import { MAX_ADMIN_PRODUCT_IMAGES, MAX_PRICE_CENTS, MAX_PRICE_MESSAGE, zodFieldErrors, zodMessage } from '@/lib/products/validation';
import { HOME_DEFAULTS, parseHeroStats } from '@/lib/home-sections';

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
export async function createTestimonial(formData: FormData) {
  await requireCap('content:cms');
  await prisma.testimonial.create({
    data: {
      quote: String(formData.get('quote') ?? '').trim(),
      author: String(formData.get('author') ?? '').trim(),
      role: (formData.get('role') as string)?.trim() || null,
      company: (formData.get('company') as string)?.trim() || null,
      rating: Math.min(5, Math.max(1, parseInt(String(formData.get('rating') ?? '5'), 10) || 5)),
      sortOrder: parseInt(String(formData.get('sortOrder') ?? '0'), 10) || 0,
    },
  });
  await audit('testimonial.create');
  revalidatePath('/admin/testimonials');
  revalidatePath('/');
}
export async function deleteTestimonial(id: string) {
  await requireCap('content:cms');
  await prisma.testimonial.delete({ where: { id } });
  await audit('testimonial.delete', id);
  revalidatePath('/admin/testimonials');
  revalidatePath('/');
}
export async function toggleTestimonial(id: string, published: boolean) {
  await requireCap('content:cms');
  await prisma.testimonial.update({ where: { id }, data: { published } });
  revalidatePath('/admin/testimonials');
  revalidatePath('/');
}
/** Edit in place. A blank required field keeps its old value instead of
 *  failing (bare form action: a throw would be a 500 page). */
export async function updateTestimonial(id: string, formData: FormData) {
  await requireCap('content:cms');
  const quote = String(formData.get('quote') ?? '').trim().slice(0, 400);
  const author = String(formData.get('author') ?? '').trim().slice(0, 120);
  await prisma.testimonial.updateMany({
    where: { id },
    data: {
      ...(quote ? { quote } : {}),
      ...(author ? { author } : {}),
      role: (formData.get('role') as string)?.trim() || null,
      company: (formData.get('company') as string)?.trim() || null,
      rating: Math.min(5, Math.max(1, parseInt(String(formData.get('rating') ?? '5'), 10) || 5)),
      sortOrder: parseInt(String(formData.get('sortOrder') ?? '0'), 10) || 0,
    },
  });
  await audit('testimonial.update', id);
  revalidatePath('/admin/testimonials');
  revalidatePath('/');
}

// ---- Case studies CRUD ----
export async function createCaseStudy(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('content:cms');
  const title = String(formData.get('title') ?? '').trim();
  if (!title) return { ok: false, message: 'Enter a title — a case study can’t be published without one.' };
  const slug = await uniqueSlug(title, async (s) =>
    !!(await prisma.caseStudy.findUnique({ where: { slug: s }, select: { id: true } })),
  );
  await prisma.caseStudy.create({
    data: {
      slug,
      title,
      customer: String(formData.get('customer') ?? '').trim() || '—',
      outcomeMetric: String(formData.get('outcomeMetric') ?? '').trim() || '—',
      excerpt: String(formData.get('excerpt') ?? '').trim() || '',
      body: String(formData.get('body') ?? '').trim() || '',
      status: 'PUBLISHED',
      publishedAt: new Date(),
    },
  });
  await audit('casestudy.create', title);
  revalidatePath('/admin/case-studies');
  revalidatePath('/case-studies');
  return { ok: true, message: `Published “${title}”.` };
}
export async function deleteCaseStudy(id: string) {
  await requireCap('content:cms');
  await prisma.caseStudy.delete({ where: { id } });
  await audit('casestudy.delete', id);
  revalidatePath('/admin/case-studies');
  revalidatePath('/case-studies');
}
export async function toggleCaseStudy(id: string, publish: boolean) {
  await requireCap('content:cms');
  await prisma.caseStudy.update({
    where: { id },
    data: { status: publish ? 'PUBLISHED' : 'DRAFT', publishedAt: publish ? new Date() : null },
  });
  revalidatePath('/admin/case-studies');
  revalidatePath('/case-studies');
}
/** Edit in place; the slug is kept so published links keep working. */
export async function updateCaseStudy(id: string, formData: FormData) {
  await requireCap('content:cms');
  const title = String(formData.get('title') ?? '').trim();
  const cs = await prisma.caseStudy.findUnique({ where: { id }, select: { slug: true } });
  if (!cs) return;
  await prisma.caseStudy.update({
    where: { id },
    data: {
      ...(title ? { title } : {}),
      customer: String(formData.get('customer') ?? '').trim() || '—',
      outcomeMetric: String(formData.get('outcomeMetric') ?? '').trim() || '—',
      excerpt: String(formData.get('excerpt') ?? '').trim(),
      body: String(formData.get('body') ?? '').trim(),
    },
  });
  await audit('casestudy.update', cs.slug);
  revalidatePath('/admin/case-studies');
  revalidatePath('/case-studies');
  revalidatePath(`/case-studies/${cs.slug}`);
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
    images: p.images,
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
  items: { id: string; titleSnapshot: string; brandSnapshot: string | null; priceCentsSnapshot: number; quantity: number; image: string | null; productSlug: string | null; supplierName: string | null }[];
} | null> {
  await requireCap('orders:view');
  const o = await prisma.order.findUnique({
    where: { id },
    include: {
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
    items: o.items.map((it) => ({
      id: it.id,
      titleSnapshot: it.titleSnapshot,
      brandSnapshot: it.brandSnapshot,
      priceCentsSnapshot: it.priceCentsSnapshot,
      quantity: it.quantity,
      image: it.product?.images?.[0] ?? null,
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
  totals: {
    orders: number;
    spendCents: number;
    currency: string;
    sourcing: number;
    sells: number;
    tickets: number;
    threads: number;
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
  const user = await prisma.user.findUnique({
    where: { id },
    include: { company: { select: { name: true } } },
  });
  if (!user) return null;
  const [orders, sourcing, sells, tickets, threads, reviews, wishlist, notif, cart] = await Promise.all([
    prisma.order.findMany({
      where: { buyerId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, orderNumber: true, totalCents: true, currency: true, status: true, createdAt: true },
    }),
    prisma.sourcingRequest.findMany({
      where: { OR: [{ submittedById: user.id }, { buyerEmail: user.email }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, description: true, status: true, createdAt: true },
    }),
    prisma.sellSubmission.findMany({
      where: { OR: [{ submittedById: user.id }, { email: user.email }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, phone: true, status: true, createdAt: true },
    }),
    prisma.supportTicket.findMany({
      where: { OR: [{ submittedById: user.id }, { email: user.email }] },
      orderBy: { createdAt: 'desc' },
      select: { ref: true, subject: true, status: true, createdAt: true },
    }),
    prisma.messageThread.count({ where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] } }),
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
    totals: {
      orders: orders.length,
      spendCents,
      currency,
      sourcing: sourcing.length,
      sells: sells.length,
      tickets: tickets.length,
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

export async function setUserRole(userId: string, role: UserRole): Promise<{ ok: boolean; message: string }> {
  await requireCap('users:manage');
  if (!Object.values(UserRole).includes(role)) return { ok: false, message: 'Unknown role.' };
  // Never let the LAST admin be demoted — that locks everyone out of /admin
  // with no in-app way back (recovery then needs a direct DB update).
  if (role !== 'ADMIN') {
    const target = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (target?.role === 'ADMIN') {
      const otherAdmins = await prisma.user.count({ where: { role: 'ADMIN', NOT: { id: userId } } });
      if (otherAdmins === 0) {
        return { ok: false, message: 'Cannot change the last admin to a non-admin role — promote another admin first.' };
      }
    }
  }
  await prisma.user.update({ where: { id: userId }, data: { role } });
  await audit('user.role', userId, `role=${role}`);
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${userId}`);
  return { ok: true, message: `Role changed to ${role === 'SELLER' ? 'internal supplier' : role.toLowerCase()}.` };
}

/** Soft-suspend a user: blocks sign-in and wipes active sessions.
 *  Reversible via [[unsuspendUser]]. */
export async function suspendUser(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('users:manage');
  const id = String(formData.get('userId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 240) || 'Suspended by admin';
  if (!id) return { ok: false, message: 'Missing user.' };
  const target = await prisma.user.findUnique({ where: { id }, select: { role: true, email: true } });
  if (!target) return { ok: false, message: 'User not found.' };
  if (target.role === 'ADMIN') {
    // Refuse to suspend the LAST active admin so we don't get locked out.
    const remainingAdmins = await prisma.user.count({
      where: { role: 'ADMIN', suspendedAt: null, NOT: { id } },
    });
    if (remainingAdmins === 0) return { ok: false, message: 'Cannot suspend the last active admin.' };
  }
  await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: { suspendedAt: new Date(), suspendedReason: reason },
    }),
    prisma.session.deleteMany({ where: { userId: id } }),
  ]);
  await audit('user.suspend', id, reason);
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${id}`);
  return { ok: true, message: `${target.email} is suspended and signed out everywhere.` };
}

export async function unsuspendUser(formData: FormData): Promise<void> {
  await requireCap('users:manage');
  const id = String(formData.get('userId') ?? '');
  if (!id) return;
  await prisma.user.update({
    where: { id },
    data: { suspendedAt: null, suspendedReason: null },
  });
  await audit('user.unsuspend', id);
  revalidatePath('/admin/users');
  revalidatePath(`/admin/users/${id}`);
}

/**
 * Bulk-delete selected users straight from the list. Guards: skips yourself and
 * any admin (delete those from their card so the last-admin check applies), and
 * skips anyone whose order/ticket history blocks a hard delete (FK) — those are
 * reported so the operator can suspend them instead.
 */
export async function bulkDeleteUsers(
  formData: FormData,
): Promise<{ ok: boolean; count: number; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  if (!(await hasCapability('users:manage'))) {
    return { ok: false, count: 0, message: 'You lack the users:manage permission.' };
  }
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) return { ok: false, count: 0, message: 'No users selected.' };
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

/** Bulk-suspend selected users (reversible; wipes their sessions). Skips you. */
export async function bulkSuspendUsers(
  formData: FormData,
): Promise<{ ok: boolean; count: number; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  if (!(await hasCapability('users:manage'))) {
    return { ok: false, count: 0, message: 'You lack the users:manage permission.' };
  }
  const ids = String(formData.get('ids') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .filter((id) => id !== session.user.id);
  if (!ids.length) return { ok: false, count: 0, message: 'No users selected (you can’t suspend yourself).' };
  const [updated] = await prisma.$transaction([
    prisma.user.updateMany({
      where: { id: { in: ids }, suspendedAt: null },
      data: { suspendedAt: new Date(), suspendedReason: 'Suspended by admin (bulk)' },
    }),
    prisma.session.deleteMany({ where: { userId: { in: ids } } }),
  ]);
  await audit('user.suspend', undefined, `bulk:${updated.count}`);
  revalidatePath('/admin/users');
  return {
    ok: updated.count > 0,
    count: updated.count,
    message: updated.count > 0
      ? `Suspended ${updated.count} account${updated.count === 1 ? '' : 's'}.`
      : 'Nothing to suspend (already suspended?).',
  };
}

/** Permanently delete a user and their owned data. Use only for GDPR
 *  erasure / clear spam accounts — soft-suspend is the safe default.
 *  Returns {ok, message}: refusals used to be thrown, which production shows
 *  only as the generic "Server Components render" error. */
export async function deleteUser(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('users:manage');
  const id = String(formData.get('userId') ?? '');
  const confirm = String(formData.get('confirmEmail') ?? '').trim().toLowerCase();
  if (!id) return { ok: false, message: 'Missing user.' };
  const target = await prisma.user.findUnique({
    where: { id },
    select: { email: true, role: true },
  });
  if (!target) return { ok: false, message: 'User not found.' };
  if (confirm !== target.email.toLowerCase()) {
    return { ok: false, message: 'Email confirmation did not match — nothing was deleted.' };
  }
  if (target.role === 'ADMIN') {
    const remainingAdmins = await prisma.user.count({
      where: { role: 'ADMIN', NOT: { id } },
    });
    if (remainingAdmins === 0) return { ok: false, message: 'Cannot delete the last admin.' };
  }
  // Orders reference the buyer without a cascade (kept for the money trail),
  // so an account with orders can't be hard-deleted — say so up front.
  const orderCount = await prisma.order.count({ where: { buyerId: id } });
  if (orderCount > 0) {
    return {
      ok: false,
      message: `Delete blocked — this account has ${orderCount} order${orderCount === 1 ? '' : 's'}, which must be kept. Suspend the account instead.`,
    };
  }
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
  try {
    await sendAdminPasswordReset(session.user.id, { id, email: target.email });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : 'Reset request failed.' };
  }
  await audit('user.adminreset', id, target.email);
  return {
    ok: true,
    message:
      process.env.RESEND_API_KEY
        ? `Reset email queued to ${target.email}.`
        : `Reset link generated — without Resend key it landed in the dev mailbox (Mailpit), not their inbox.`,
  };
}

/** Replace a user's admin capability set. Granted only to users:manage. */
export async function setUserCaps(formData: FormData) {
  await requireCap('users:manage');
  const userId = String(formData.get('userId') ?? '');
  const preset = String(formData.get('preset') ?? '').trim();
  const raw = formData.getAll('cap').map((v) => String(v));

  let next: string[];
  if (preset && CAPABILITY_PRESETS[preset]) {
    next = CAPABILITY_PRESETS[preset].caps;
  } else {
    // Custom selection: allow only known capability strings (+ '*').
    next = raw.filter((c) => c === '*' || (CAPABILITIES as readonly string[]).includes(c));
  }
  // De-dup.
  next = Array.from(new Set(next));

  if (!userId) return;
  await prisma.user.update({ where: { id: userId }, data: { adminCaps: next } });
  await audit('user.caps', userId, next.join(','));
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath('/admin/users');
}

export async function setProductStatus(slug: string, status: 'PUBLISHED' | 'ARCHIVED' | 'DRAFT') {
  await requireCap('products:approve');
  await prisma.product.update({ where: { slug }, data: { status } });
  revalidatePath('/admin/products');
  revalidatePath(`/marketplace/${slug}`);
}

/** In-place price / quantity / status edit from the admin product popup.
 *  Returns {ok,message} so the modal can render a confirmation without a
 *  full-page reload. */
export async function quickUpdateProduct(
  slug: string,
  patch: { priceCents?: number | null; quantity?: number; status?: 'DRAFT' | 'PENDING_REVIEW' | 'PUBLISHED' | 'ARCHIVED' },
): Promise<{ ok: boolean; message: string }> {
  await requireCap('products:edit');
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
  try {
    await prisma.product.update({ where: { slug }, data });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : 'Update failed.' };
  }
  await audit('product.quickupdate', slug, Object.keys(data).join(','));
  revalidatePath('/admin/products');
  revalidatePath(`/marketplace/${slug}`);
  return { ok: true, message: 'Saved.' };
}

export async function setCompanyVerified(slug: string, verified: boolean) {
  await requireCap('companies:manage');
  await prisma.company.update({ where: { slug }, data: { isVerified: verified } });
  await audit(verified ? 'company.verify' : 'company.unverify', slug);
  revalidatePath('/admin/companies');
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

  const via = process.env.RESEND_API_KEY
    ? 'Resend API'
    : process.env.SMTP_USER
      ? `SMTP (${process.env.SMTP_HOST || 'localhost'}:${process.env.SMTP_PORT || '465'})`
      : 'the dev mailbox (Mailpit) — no Resend key or SMTP credentials set';

  const site = process.env.SITE_NAME?.trim() || 'lab2date';
  try {
    await sendEmail({
      to,
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

export async function saveAdminSettings(
  _prev: { ok: boolean; message: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
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
  try {
    await persistSettings(input);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Save failed: ${e.message.slice(0, 600)}` : 'Save failed.' };
  }
  await audit('settings.save', undefined, Object.keys(input).join(','));
  revalidatePath('/admin/settings');
  return { ok: true, message: 'Saved ✓' };
}

export async function uploadCompanyLogo(
  _prev: { ok: boolean; message: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; message: string }> {
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
  const { buf, mime, ext } = checked.upload;
  try {
    // Under products/ because that is the prefix the bucket policy makes
    // public; invoices and emails load the logo anonymously.
    const { url } = await uploadObject(`products/branding/logo-${Date.now()}.${ext}`, buf, mime);
    await persistSettings({ COMPANY_LOGO_URL: url });
    await audit('settings.logo', undefined, url);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Upload failed: ${e.message.slice(0, 140)}` : 'Upload failed.' };
  }
  revalidatePath('/admin/settings');
  return { ok: true, message: 'Logo updated ✓' };
}

const HOME_KEYS = [
  'hero', 'trustbar', 'categories', 'featured', 'suppliers', 'blog', 'testimonials', 'cta',
];

export async function saveHomepage(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('content:cms');
  const enabled = HOME_KEYS.filter((k) => formData.get(`enabled_${k}`) === 'on');
  // An empty list used to delete the row, which the site reads as "show
  // everything" — the opposite of what was asked. Refuse it explicitly.
  if (enabled.length === 0) {
    return { ok: false, message: 'Keep at least one module visible — with every module hidden the homepage would be blank. Nothing was saved.' };
  }
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
  ] as const) {
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
    message: `Homepage saved — ${enabled.length} module${enabled.length === 1 ? '' : 's'} shown${stats ? '' : ', stats show live counts'}. Click ↻ Refresh in the preview to see it.`,
  };
}

export async function sendAnnouncement(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('content:cms');
  await ensureSettingsLoaded();
  const title = String(formData.get('title') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  const href = String(formData.get('href') ?? '').trim() || null;
  const kind = (String(formData.get('kind') ?? 'ANNOUNCEMENT') || 'ANNOUNCEMENT').toUpperCase();
  const audience = String(formData.get('audience') ?? 'ALL');
  const alsoEmail = formData.get('email') === 'on';
  // Returned, not thrown — a thrown error replaced the whole admin page.
  if (title.length < 3 || body.length < 3) {
    return { ok: false, message: 'Title and message are required (at least 3 characters each, not just spaces).' };
  }
  if (!['OFFER', 'ANNOUNCEMENT', 'SYSTEM'].includes(kind)) return { ok: false, message: 'Unknown announcement type.' };

  const where =
    audience === 'BUYER'
      ? { role: UserRole.BUYER }
      : audience === 'SELLER'
        ? { role: UserRole.SELLER }
        : {};
  // Cap the broadcast so a single request can't fan out unboundedly as the
  // user base grows (holds a connection open + can exhaust the mail provider).
  const users = await prisma.user.findMany({
    where,
    select: { id: true, email: true, name: true },
    take: 5000,
  });

  if (users.length === 0) return { ok: false, message: 'Nobody in that audience — nothing was sent.' };

  await prisma.notification.createMany({
    data: users.map((u) => ({ userId: u.id, title, body, href, kind })),
  });

  let emailed = 0;
  let emailFailed = 0;
  let skipped = 0;
  if (alsoEmail) {
    const site = process.env.SITE_NAME || 'lab2date';
    const base = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
    const link = href
      ? href.startsWith('http')
        ? href
        : `${base}${href.startsWith('/') ? '' : '/'}${href}`
      : `${base}/app/notifications`;
    for (const u of users) {
      // Seed / importer accounts carry placeholder addresses (sales@shop.import,
      // *.example …) that bounce and hurt sender reputation — in-app only.
      if (!isDeliverableEmail(u.email)) {
        skipped++;
        continue;
      }
      // Best-effort per recipient — one bad address must not abort the whole
      // broadcast (and every notification row is already persisted above).
      try {
        await sendEmail({
          to: u.email,
          subject: title,
          html: `
          <div style="font-family:system-ui,sans-serif;max-width:560px;">
            <h2 style="color:#0E4F40;">${escapeHtml(title)}</h2>
            <p>Hi ${escapeHtml(u.name)},</p>
            <div style="font-size:14px;line-height:1.7;color:#333;">${escapeHtmlLines(body)}</div>
            <p style="margin:22px 0;">
              <a href="${escapeHtml(link)}" style="background:#0E4F40;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">View on ${escapeHtml(site)}</a>
            </p>
            <p style="color:#999;font-size:11px;">You receive this because you have a ${escapeHtml(site)} account.</p>
          </div>`,
        });
        emailed++;
      } catch {
        // swallow — logged in EmailLog by sendEmail; continue the broadcast
        emailFailed++;
      }
    }
  }

  await audit('announcement.send', audience, title);
  revalidatePath('/admin/announcements');
  revalidatePath('/app/notifications');
  const parts = [`Sent to ${users.length} user${users.length === 1 ? '' : 's'} in-app.`];
  if (alsoEmail) {
    parts.push(`Emailed ${emailed}.`);
    if (skipped) parts.push(`Skipped ${skipped} placeholder address${skipped === 1 ? '' : 'es'}.`);
    if (emailFailed) parts.push(`${emailFailed} email${emailFailed === 1 ? '' : 's'} failed (see the email log).`);
  }
  return { ok: true, message: parts.join(' ') };
}

export async function refundOrder(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('orders:refund');
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      status: true,
      stripePaymentIntentId: true,
      orderNumber: true,
      sourcingRequestId: true,
      buyer: { select: { id: true, name: true, email: true } },
      totalCents: true,
      currency: true,
      items: { select: { productId: true, quantity: true } },
    },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  // BUG-043: refund is only meaningful once money has actually been captured.
  // Positively allow-list the money-captured statuses (mirrors the UI's
  // `canRefund` gate and every sibling money-path action) instead of the old
  // negative `!= REFUNDED` guard. The old guard let refundOrder run on a
  // CANCELED order (already restocked by cancelOrder / the proforma sweep) —
  // restocking it AGAIN mints phantom inventory of a unique/used unit (the very
  // oversell hazard the reserve logic guards against) — and on a PENDING_PAYMENT
  // order (no money captured), where it would email the buyer "refund to your
  // original payment method" and stamp REFUNDED (corrupting refund/revenue
  // reporting). Not currently reachable through the shipped UI (a PAID-family
  // order cannot reach a restock-already state), but a stale/direct server-action
  // POST or any future caller could hit it; re-encode the precondition here and
  // in the atomic WHERE below so the write itself is the single source of truth.
  const REFUNDABLE = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;
  if (!REFUNDABLE.includes(order.status as (typeof REFUNDABLE)[number])) {
    // Includes the already-REFUNDED case (idempotent no-op) and every
    // non-captured status. No Stripe call, no restock, no email.
    return {
      ok: false,
      message: order.status === 'REFUNDED'
        ? `Order ${order.orderNumber} is already refunded.`
        : `Order ${order.orderNumber} is ${order.status.toLowerCase().replace(/_/g, ' ')} — only paid orders can be refunded.`,
    };
  }

  const stripe = getStripe();
  if (stripe && order.stripePaymentIntentId) {
    try {
      await stripe.refunds.create({ payment_intent: order.stripePaymentIntentId });
    } catch (e) {
      console.error('stripe refund failed', e);
      return { ok: false, message: 'Stripe refund failed — check the payment in Stripe. Nothing was changed here.' };
    }
  }
  // BUG-036: claim the REFUNDED transition atomically. The status guard at the
  // top reads a snapshot; without an atomic write two concurrent refund clicks
  // (or a manual order with no Stripe PI to natively dedupe) would each restock
  // and re-email. Gate restock + notifications on count===1 so they fire exactly
  // once. The Stripe refunds.create above is itself replay-safe (a second call
  // on a fully-refunded intent errors and is caught before reaching here).
  const flip = await prisma.order.updateMany({
    where: { id, status: { in: [...REFUNDABLE] } },
    data: { status: 'REFUNDED' },
  });
  // A concurrent click already refunded + restocked.
  if (flip.count !== 1) return { ok: false, message: `Order ${order.orderNumber} was already refunded by another action.` };
  // Return the reserved unit(s) to stock so the item can be sold again. Proforma
  // orders never reserved stock, so restocking them would mint phantom units.
  // updateMany: a hard-deleted product no-ops instead of throwing mid-loop.
  const restock = orderReservedStock(order);
  if (restock) {
    for (const it of order.items) {
      if (it.productId) {
        await prisma.product.updateMany({
          where: { id: it.productId },
          data: { quantity: { increment: it.quantity } },
        });
      }
    }
  }
  await sendEmail({
    to: order.buyer.email,
    subject: `Refund issued for order ${order.orderNumber}`,
    html: `<p>Hi ${escapeHtml(order.buyer.name)}, a refund for order <strong>${order.orderNumber}</strong> has been processed${
      stripe && order.stripePaymentIntentId ? ' to your original payment method' : ''
    }. It may take a few business days to appear.</p>`,
  });
  await notifyUser(
    order.buyer.id,
    `Refund issued — order ${order.orderNumber}`,
    'A refund has been processed. It may take a few business days to appear.',
    `/app/orders/${order.orderNumber}`,
  );
  await notifyAdmins(
    `Order ${order.orderNumber}: refunded — ${(order.totalCents / 100).toFixed(2)} ${order.currency}`,
    `Refund issued${stripe && order.stripePaymentIntentId ? ' via Stripe' : ' (manual)'}.${restock ? ' Stock returned to catalog.' : ''}`,
    `/admin/orders/${id}`,
    'ORDER_REFUNDED',
  );
  await audit('order.refund', order.orderNumber, `${order.totalCents} ${order.currency}`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  return {
    ok: true,
    message: `Order ${order.orderNumber} marked refunded${stripe && order.stripePaymentIntentId ? ' (Stripe refund issued)' : ' — return the money by bank transfer'}.${restock ? ' Stock returned to the catalog.' : ''}`,
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

/** Cancel an order that hasn't been paid (or is in PROCESSING). Releases
 *  reserved stock back to the catalog. Distinct from refundOrder which
 *  applies once money is taken. */
export async function cancelOrder(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('orders:fulfil');
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      status: true,
      orderNumber: true,
      paymentSubmittedAt: true,
      sourcingRequestId: true,
      buyer: { select: { id: true, name: true, email: true } },
      items: { select: { productId: true, quantity: true } },
    },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  if (['CANCELED', 'REFUNDED'].includes(order.status)) {
    return { ok: false, message: `Order ${order.orderNumber} is already ${order.status.toLowerCase()}.` };
  }
  if (['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status)) {
    return { ok: false, message: 'Order has been paid — use Refund instead.' };
  }
  // BUG-035: a buyer receipt awaiting verification leaves status=PENDING_PAYMENT
  // but paymentSubmittedAt set. Canceling here would bypass the verify/reject
  // queue and tell the buyer "no charge was made" — false when they have paid.
  // Decline via Reject first (which clears paymentSubmittedAt), then cancel.
  // Keeps "admin verify is the ONLY path that changes payment state" intact.
  if (order.paymentSubmittedAt) {
    return { ok: false, message: 'This order has a payment receipt awaiting verification — use Verify or Reject, not Cancel.' };
  }
  // Stripe-aware atomic cancel: expire any active payment session FIRST, then
  // claim PENDING_PAYMENT + restock in ONE transaction (CAS on the same session id
  // + no proof), so a concurrent session-persist / proof upload can't be raced and
  // an active payable session is never left pointing at canceled/restocked stock.
  const outcome = await cancelOrderSaga(prisma, stripeExpireApi(), id, { requireNoProof: true });
  if (outcome === 'expire-failed') {
    return { ok: false, message: "Could not expire the buyer's active payment session — the order was left reserved; please retry." };
  }
  if (outcome !== 'canceled') {
    // already canceled / raced / receipt in flight
    revalidatePath('/admin/orders');
    return { ok: false, message: `Order ${order.orderNumber} could not be canceled — its status changed. Refresh and check.` };
  }
  const restocked = orderReservedStock(order);
  await notifyUser(
    order.buyer.id,
    `Order ${order.orderNumber}: canceled`,
    `Your order was canceled before payment. No charge was made.${restocked ? ' Items are back in stock.' : ''}`,
    `/app/orders/${order.orderNumber}`,
  );
  await emailBuyerOrderUpdate(
    order.buyer.email,
    order.orderNumber,
    `Order ${order.orderNumber} canceled`,
    'Your order was canceled before payment. No charge was made.',
  );
  await notifyAdmins(
    `Order ${order.orderNumber}: canceled (pre-payment)`,
    `${restocked ? 'Reserved stock has been returned. ' : ''}No charge was made.`,
    `/admin/orders/${id}`,
    'ORDER_CANCELED',
  );
  await audit('order.cancel', order.orderNumber);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  return { ok: true, message: `Order ${order.orderNumber} canceled.${restocked ? ' Reserved stock released.' : ''}` };
}

/** Save (or clear) the internal-only operator notes on an order. */
export async function setOrderNotes(formData: FormData): Promise<void> {
  await requireCap('orders:fulfil');
  const id = String(formData.get('orderId') ?? '');
  const notes = String(formData.get('notes') ?? '').slice(0, 4000).trim() || null;
  if (!id) return;
  await prisma.order.update({ where: { id }, data: { adminNotes: notes } });
  await audit('order.notes', id, notes ? 'set' : 'cleared');
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
}

/** Mark every PAID/PROCESSING order as SHIPPED in one shot — bulk fulfilment
 *  from the overview tile. Carrier/tracking are not set; the operator can
 *  fill those in per-order afterwards. */
/** Manually mark a non-Stripe order as PAID — for quote/invoice/bank-transfer
 *  flows where money landed off-platform. Accepts an optional proof file. */
export async function markOrderPaidManually(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:fulfil');
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  const method = String(formData.get('method') ?? '').toUpperCase();
  const note = String(formData.get('note') ?? '').trim().slice(0, 500) || null;
  if (!id) return { ok: false, message: 'Missing order id.' };
  if (!['BANK_TRANSFER', 'INVOICE', 'RECEIPT', 'OTHER'].includes(method)) {
    return { ok: false, message: 'Unknown payment method.' };
  }
  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, orderNumber: true, status: true, totalCents: true, currency: true, shippingAddress: true, buyer: { select: { id: true, email: true } } },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  if (['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status)) {
    return { ok: false, message: `Order is already ${order.status.toLowerCase()}.` };
  }

  // Manual-mode integrity (per launch posture): a receipt/proof file MUST
  // accompany every admin-marked PAID transition for BANK_TRANSFER and
  // RECEIPT methods. INVOICE / OTHER are operator-attested but still
  // strongly encouraged. Without proof for BANK_TRANSFER/RECEIPT, refuse.
  // Every PAID transition leaves an audit row (line below).
  const file = formData.get('proof');
  let proofUrl: string | null = null;
  if (file && typeof file !== 'string' && (file as File).size > 0) {
    const f = file as File;
    if (f.size > 8_000_000) return { ok: false, message: 'Proof file too large (max 8 MB).' };
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    if (!allowed.includes(f.type)) return { ok: false, message: 'Proof must be image or PDF.' };
    const ext = (f.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    const buf = Buffer.from(await f.arrayBuffer());
    const { url } = await uploadObject(
      `order-proofs/${order.orderNumber}-${Date.now()}.${ext}`,
      buf,
      f.type,
    );
    proofUrl = url;
  }
  if ((method === 'BANK_TRANSFER' || method === 'RECEIPT') && !proofUrl) {
    return {
      ok: false,
      message: `${method.toLowerCase().replace('_', ' ')} payments require a receipt upload — please attach the bank-transfer PDF or screenshot.`,
    };
  }

  // Atomic conditional update — concurrent admin clicks both decrement;
  // only one wins. Lost-race admin sees a clean message rather than
  // double-firing the audit + email + notification.
  const updateRes = await prisma.order.updateMany({
    where: { id, status: 'PENDING_PAYMENT' },
    data: {
      status: 'PAID',
      paidAt: new Date(),
      paidByAdminId: session.user.id,
      paymentMethodManual: method,
      paymentNote: note,
      ...(proofUrl ? { paymentProofUrl: proofUrl } : {}),
    },
  });
  if (updateRes.count !== 1) {
    return { ok: false, message: 'Order is no longer pending — refresh and check the current status.' };
  }
  await notifyUser(
    order.buyer.id,
    `Payment received — order ${order.orderNumber}`,
    `Your payment has been confirmed${method === 'BANK_TRANSFER' ? ' (bank transfer)' : method === 'INVOICE' ? ' (invoice)' : ''}. We'll prepare your order for shipping.`,
    `/app/orders/${order.orderNumber}`,
  );
  await emailBuyerOrderUpdate(
    order.buyer.email,
    order.orderNumber,
    `Payment received — order ${order.orderNumber}`,
    `Your payment has been confirmed${method === 'BANK_TRANSFER' ? ' (bank transfer)' : method === 'INVOICE' ? ' (invoice)' : ''}. We'll prepare your order for shipping.`,
  );
  await notifyAdmins(
    `Order ${order.orderNumber} marked PAID manually — ${(order.totalCents / 100).toFixed(2)} ${order.currency}`,
    `Method: ${method.toLowerCase().replace('_', ' ')}${proofUrl ? ' · receipt attached' : ''}${note ? ` · note: ${note.slice(0, 80)}` : ''}`,
    `/admin/orders/${id}`,
    'ORDER_PAID',
  );
  await audit('order.paid.manual', order.orderNumber, `${method}${proofUrl ? ' +proof' : ''}${note ? ` "${note.slice(0, 60)}"` : ''}`);
  // The order is now PAID: email the real invoice (the checkout success page
  // promises it). Never blocks — sendOrderInvoice swallows + logs failures.
  await sendOrderInvoice(order.id);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  return {
    ok: true,
    message: shippingAddressIsComplete(order.shippingAddress)
      ? 'Marked as paid. Invoice emailed to the buyer.'
      : 'Marked as paid. Invoice emailed to the buyer. No complete shipping address on file yet — add it on the order page before shipping.',
  };
}

/** Bulk cancel a list of order IDs (PENDING_PAYMENT only — safe). */
export async function bulkCancelOrders(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
  await requireCap('orders:fulfil');
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, message: 'No orders selected.' };
  // BUG-035: exclude orders with a receipt in flight (paymentSubmittedAt set).
  // They sit at status=PENDING_PAYMENT but the buyer has paid and is awaiting
  // admin verify; bulk-canceling them would bypass the verify/reject queue and
  // tell the buyer "no charge was made" (false). Operator must Verify/Reject
  // those individually. Mirrors the cron proforma-expiry + orphan-sweep guards.
  const orders = await prisma.order.findMany({
    where: { id: { in: ids }, status: 'PENDING_PAYMENT', paymentSubmittedAt: null },
    select: { id: true, orderNumber: true, buyer: { select: { id: true } }, items: { select: { productId: true, quantity: true } } },
  });
  // Honest operator feedback: how many selected orders were held back purely
  // because a buyer receipt is awaiting verification.
  const inFlight = await prisma.order.count({
    where: { id: { in: ids }, status: 'PENDING_PAYMENT', paymentSubmittedAt: { not: null } },
  });
  if (orders.length === 0) {
    return {
      ok: false,
      count: 0,
      message:
        inFlight > 0
          ? `None canceled — ${inFlight} selected order${inFlight === 1 ? ' has a receipt' : 's have receipts'} awaiting verification; use Verify or Reject.`
          : 'None of the selected orders are cancelable.',
    };
  }
  // Process each candidate through the Stripe-aware atomic cancel saga. Only the
  // orders it actually CANCELS (its own authoritative guards win the race — status,
  // no-proof, and session-CAS after a confirmed expire) are restocked (inside the
  // tx) and notified. A proof/paid/session-race loser never mints stock or receives
  // a false "canceled" notification. Replaces the old select→bulk-updateMany→
  // restock-ALL shape whose subset-winning updateMany still restocked every row.
  const api = stripeExpireApi();
  const { canceled, expireFailed, errored } = await cancelOrdersBatch(
    prisma,
    api,
    orders.map((o) => o.id),
    { requireNoProof: true },
  );
  const winners = orders.filter((o) => canceled.includes(o.id));
  for (const o of winners) {
    await notifyUser(
      o.buyer.id,
      `Order ${o.orderNumber}: canceled`,
      'Your order was canceled. Items are back in stock; no charge was made.',
      `/app/orders/${o.orderNumber}`,
    );
  }
  await audit(
    'order.bulkcancel',
    undefined,
    `${winners.length} canceled${inFlight > 0 ? `; ${inFlight} awaiting-verification` : ''}${expireFailed.length ? `; ${expireFailed.length} session-expire-failed` : ''}${errored.length ? `; ${errored.length} errored` : ''}`,
  );
  revalidatePath('/admin/orders');
  // Surface every non-cancel outcome to the operator — nothing is silently dropped.
  const parts: string[] = [];
  if (inFlight > 0) parts.push(`skipped ${inFlight} with a receipt awaiting verification`);
  if (expireFailed.length) parts.push(`${expireFailed.length} left reserved — payment session could not be expired; retry`);
  if (errored.length) parts.push(`${errored.length} failed (see logs)`);
  const note = parts.length ? ` ${parts.join('; ')}.` : '';
  return { ok: winners.length > 0, count: winners.length, message: `Canceled ${winners.length} order${winners.length === 1 ? '' : 's'}.${note}` };
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

type BulkShipResult = { ok: boolean; count: number; skipped: number; message: string };

/** Overview tile: ship EVERY PAID/PROCESSING order that has a complete address.
 *  The button that calls this says so explicitly; row selections in the orders
 *  list use bulkMarkSelectedShipped instead. */
export async function bulkMarkAllShipped(): Promise<BulkShipResult> {
  await requireCap('orders:fulfil');
  return markShipped(null);
}

/** Orders list bulk bar: ship ONLY the selected PAID/PROCESSING orders. */
export async function bulkMarkSelectedShipped(formData: FormData): Promise<BulkShipResult> {
  await requireCap('orders:fulfil');
  const ids = String(formData.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: false, count: 0, skipped: 0, message: 'No orders selected.' };
  return markShipped(ids);
}

/** Shared body. `ids === null` means "all PAID/PROCESSING orders" (overview
 *  only); otherwise the WHERE is restricted to exactly those ids. */
async function markShipped(ids: string[] | null): Promise<BulkShipResult> {
  const scope = ids ? { id: { in: ids } } : {};
  const candidates = await prisma.order.findMany({
    where: { ...scope, status: { in: ['PAID', 'PROCESSING'] } },
    select: { id: true, orderNumber: true, shippingAddress: true, buyer: { select: { id: true } } },
  });
  if (candidates.length === 0) {
    return { ok: false, count: 0, skipped: 0, message: 'No paid or processing orders to ship.' };
  }

  // RB-fix: address-less orders cannot ship. Filter them out and surface
  // the skip count so the operator knows to chase those buyers first.
  const eligible = candidates.filter((o) => shippingAddressIsComplete(o.shippingAddress));
  const skipped = candidates.length - eligible.length;
  if (eligible.length === 0) {
    return {
      ok: false,
      count: 0,
      skipped,
      message: `${skipped} order${skipped === 1 ? '' : 's'} missing a complete shipping address — cannot bulk-ship.`,
    };
  }

  // RB-fix: status precondition kills double-fire. Concurrent admin
  // clicks both decrement, only the first wins (count===N), the second
  // sees the rows already moved out of PAID/PROCESSING.
  const res = await prisma.order.updateMany({
    where: { id: { in: eligible.map((o) => o.id) }, status: { in: ['PAID', 'PROCESSING'] } },
    data: { status: 'SHIPPED', shippedAt: new Date() },
  });
  // Only fan-out notifications for rows we actually moved.
  if (res.count > 0) {
    // Re-query to learn which IDs flipped (updateMany doesn't return rows).
    const shipped = await prisma.order.findMany({
      where: { id: { in: eligible.map((o) => o.id) }, status: 'SHIPPED' },
      select: { id: true, orderNumber: true, buyer: { select: { id: true } } },
    });
    for (const o of shipped) {
      await notifyUser(
        o.buyer.id,
        `Order ${o.orderNumber}: shipped`,
        'Your order has shipped. Tracking number will follow.',
        `/app/orders/${o.orderNumber}`,
      );
    }
    await audit('order.bulkship', undefined, `${res.count} orders${ids ? ' (selected)' : ' (all)'}${skipped ? ` (skipped ${skipped} address-less)` : ''}`);
  }
  revalidatePath('/admin');
  revalidatePath('/admin/orders');
  const shippedMsg = `Marked ${res.count} order${res.count === 1 ? '' : 's'} as shipped.`;
  return {
    ok: true,
    count: res.count,
    skipped,
    message: skipped > 0 ? `${shippedMsg} Skipped ${skipped} with no complete shipping address.` : shippedMsg,
  };
}

/** Returns {ok, message} rather than throwing — a rejected transition used to
 *  crash the whole admin page (production redacts thrown messages). */
export async function setOrderFulfillment(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('orders:fulfil');
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  let status = String(formData.get('status') ?? '') as
    | 'PAID' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELED' | 'REFUNDED';
  const carrier = String(formData.get('carrier') ?? '').trim() || null;
  const trackingNumber = String(formData.get('trackingNumber') ?? '').trim() || null;
  if (!id || !status) return { ok: false, message: 'Pick a status first.' };

  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      status: true,
      orderNumber: true,
      shippingAddress: true,
      trackingCarrier: true,
      trackingNumber: true,
      buyer: { select: { id: true, name: true, email: true } },
    },
  });
  if (!order) return { ok: false, message: 'Order not found.' };

  // F12 / S3 guard: REFUNDED and CANCELED are terminal money-states. Once an
  // order is refunded or canceled, no fulfilment transition may move it back
  // into an active state (PROCESSING/SHIPPED/DELIVERED) — that would ship goods
  // against money already returned, or resurrect a canceled order. The atomic
  // updateMany below only checks status==current, so without this guard an
  // admin could flip REFUNDED→SHIPPED. Refund/cancel have dedicated actions
  // (refundOrder/cancelOrder) that own those transitions and the restock.
  // Same-status edits (e.g. attaching tracking to a refunded row) are still
  // allowed; only a status CHANGE out of a terminal state is blocked.
  const TERMINAL_ORDER_STATES = new Set(['REFUNDED', 'CANCELED']);
  if (TERMINAL_ORDER_STATES.has(order.status) && status !== order.status) {
    return {
      ok: false,
      message: `Cannot change order ${order.orderNumber} to ${status.toLowerCase()} — it is ${order.status.toLowerCase()} (terminal). Refunded or canceled orders cannot be re-fulfilled.`,
    };
  }

  // Admin entered a tracking number on a not-yet-shipped order → that IS the
  // shipping action. Auto-bump status to SHIPPED so the funnel reflects reality
  // instead of staying at PAID/PROCESSING with tracking visible (was confusing).
  if (trackingNumber && (status === 'PAID' || status === 'PROCESSING')) {
    status = 'SHIPPED';
  }

  // S3 guard: forward-only monotonic fulfilment. setOrderFulfillment owns ONLY
  // the active-fulfilment funnel PAID → PROCESSING → SHIPPED → DELIVERED.
  // Payment (→PAID) is owned by markOrderPaidManually / verifyPayment — they set
  // paidAt + method; routing a PENDING_PAYMENT order to PAID through here would
  // leave paidAt null and break F14. Cancel/refund (→CANCELED/REFUNDED) are owned
  // by cancelOrder / refundOrder — they restock; routing through here would skip
  // the restock. Without this guard the funnel <select> (which always lists all
  // four funnel states regardless of current status) let an admin — or a
  // stale/duplicate/crafted POST — move an order BACKWARD (DELIVERED→PROCESSING,
  // SHIPPED→PAID) or fulfil an unpaid order (PENDING_PAYMENT→SHIPPED). The atomic
  // updateMany below only asserts the status is unchanged, not that the
  // transition is legal. (The terminal-state guard above already rejected exit
  // from REFUNDED/CANCELED, so by here a status change means current is active.)
  const FULFILMENT_CHAIN = ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;
  const stageRank = (s: string) => (FULFILMENT_CHAIN as readonly string[]).indexOf(s);
  if (status !== order.status) {
    if (status === 'CANCELED' || status === 'REFUNDED') {
      return {
        ok: false,
        message: `Cannot set order ${order.orderNumber} to ${status.toLowerCase()} from the fulfilment panel — use the ${status === 'REFUNDED' ? 'Refund' : 'Cancel'} action so reserved stock is restocked correctly.`,
      };
    }
    if (stageRank(order.status) === -1) {
      return {
        ok: false,
        message: `Cannot fulfil order ${order.orderNumber} — it is ${order.status.toLowerCase()}, not yet paid. Record payment first (manual payment / verify proof) before moving it through fulfilment.`,
      };
    }
    if (stageRank(status) < stageRank(order.status)) {
      return {
        ok: false,
        message: `Cannot move order ${order.orderNumber} backward from ${order.status.toLowerCase()} to ${status.toLowerCase()} — fulfilment status only moves forward (paid → processing → shipped → delivered).`,
      };
    }
  }

  // RB-fix: address-less orders cannot ship/deliver. Both Q6BEQM and
  // 5LX2KB shipped without an address through single + bulk + inline
  // paths. Block the transition server-side instead of trusting the UI.
  if ((status === 'SHIPPED' || status === 'DELIVERED') && !shippingAddressIsComplete(order.shippingAddress)) {
    return {
      ok: false,
      message: `Cannot mark order ${order.orderNumber} as ${status.toLowerCase()} — no complete shipping address on file. Add the shipping address on the order page first.`,
    };
  }

  // RB-fix: idempotency. Previously the action wrote + audited even when
  // the requested status was identical to the current status, causing
  // the order.fulfillment audit to fire ×17 on Q6BEQM and ×2 on 5LX2KB.
  // Now: if status, carrier, and tracking are unchanged, no-op silently.
  const statusUnchanged = status === order.status;
  const carrierUnchanged = (carrier ?? null) === (order.trackingCarrier ?? null);
  const trackingUnchanged = (trackingNumber ?? null) === (order.trackingNumber ?? null);
  if (statusUnchanged && carrierUnchanged && trackingUnchanged) {
    // Pure no-op — no write, no audit, no notification, no email.
    revalidatePath(`/admin/orders/${id}`);
    return { ok: true, message: 'Nothing changed.' };
  }

  // RB-fix: atomic transition. updateMany with the precondition that the
  // current status matches what we read above. If a concurrent admin
  // already moved the row, count===0 → we treat as no-op rather than
  // overwriting their change (and re-firing all side effects).
  const res = await prisma.order.updateMany({
    where: { id, status: order.status },
    data: {
      status,
      trackingCarrier: carrier,
      trackingNumber,
      ...(status === 'SHIPPED' ? { shippedAt: new Date() } : {}),
      ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
    },
  });
  if (res.count !== 1) {
    // Lost the race; another admin moved the row. Skip side effects.
    revalidatePath(`/admin/orders/${id}`);
    return { ok: false, message: 'Someone else updated this order a moment ago — refresh and check its status.' };
  }

  // The status change is already committed — an email failure must not turn
  // into an error for a save that DID happen; report it in the message.
  let emailFailed = false;
  if (status === 'SHIPPED' && order.status !== 'SHIPPED') {
    const site = process.env.SITE_NAME || 'lab2date';
    const base = (process.env.BETTER_AUTH_URL || '').replace(/\/+$/, '');
    await sendEmail({
      to: order.buyer.email,
      subject: `Your order ${order.orderNumber} has shipped`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:540px;">
          <h2 style="color:#0E4F40;">Your order is on its way 🚚</h2>
          <p>Hi ${escapeHtml(order.buyer.name)}, order <strong>${order.orderNumber}</strong> has shipped.</p>
          ${carrier ? `<p><strong>Carrier:</strong> ${escapeHtml(carrier)}</p>` : ''}
          ${trackingNumber ? `<p><strong>Tracking #:</strong> ${escapeHtml(trackingNumber)}</p>` : ''}
          <p><a href="${base}/app/orders">Track it in your account</a></p>
          <p style="color:#888;font-size:12px;">${escapeHtml(site)}</p>
        </div>`,
    }).catch(() => { emailFailed = true; });
  }
  if (status === 'DELIVERED' && order.status !== 'DELIVERED') {
    emailFailed = !(await emailBuyerOrderUpdate(
      order.buyer.email,
      order.orderNumber,
      `Order ${order.orderNumber} delivered`,
      'Your order has been marked as delivered. If anything is wrong with it, contact us from your order page.',
    ));
  }
  if (status !== order.status) {
    const msg =
      status === 'SHIPPED'
        ? `Your order has shipped${trackingNumber ? ` (tracking ${trackingNumber})` : ''}.`
        : status === 'DELIVERED'
          ? 'Your order has been delivered.'
          : status === 'PROCESSING'
            ? 'Your order is now being processed.'
            : `Order status updated to ${status.toLowerCase()}.`;
    await notifyUser(
      order.buyer.id,
      `Order ${order.orderNumber}: ${status.toLowerCase()}`,
      msg,
      `/app/orders/${order.orderNumber}`,
    );
  }
  // Fan-out admin notification + webhook for SHIPPED / DELIVERED transitions —
  // useful when ops is staffed by more than one admin (or a Slack channel).
  if (status !== order.status && (status === 'SHIPPED' || status === 'DELIVERED')) {
    await notifyAdmins(
      `Order ${order.orderNumber}: ${status.toLowerCase()}`,
      `${carrier ?? '—'}${trackingNumber ? ` · ${trackingNumber}` : ''}`,
      `/admin/orders/${id}`,
      status === 'SHIPPED' ? 'ORDER_SHIPPED' : 'ORDER_DELIVERED',
    );
  }
  await audit('order.fulfillment', id, status);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath('/app/orders');
  return {
    ok: true,
    message:
      (status !== order.status ? `Saved — order is now ${status.toLowerCase()}; buyer notified.` : 'Saved — tracking details updated.') +
      (emailFailed ? ' (The buyer email could not be sent — check Settings → Email; the in-app notification went out.)' : ''),
  };
}

/**
 * Capture or correct an order's shipping address from the admin order page.
 * Proforma orders are created without an address, and the buyer's payment form
 * closes once the order is PAID, so without this a paid address-less order could
 * never ship. Allowed until the order ships; merges into the existing JSON so
 * company / VAT / email captured elsewhere survive.
 */
export async function setOrderShippingAddress(formData: FormData): Promise<{ ok: boolean; message: string }> {
  await requireCap('orders:fulfil');
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
    select: { orderNumber: true, status: true, shippingAddress: true },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  const EDITABLE = ['PENDING_PAYMENT', 'PAID', 'PROCESSING'];
  if (!EDITABLE.includes(order.status)) {
    return { ok: false, message: `The address can't be changed once an order is ${order.status.toLowerCase()}.` };
  }
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
  await audit('order.address', order.orderNumber, `${f.city}, ${f.country}`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath(`/app/orders/${order.orderNumber}`);
  return { ok: true, message: 'Shipping address saved.' };
}

export async function setSellStatus(
  id: string,
  status: 'PENDING' | 'RESPONDED' | 'ACCEPTED' | 'DECLINED' | 'CLOSED',
) {
  await requireCap('sell:status');
  const sub = await prisma.sellSubmission.update({
    where: { id },
    data: { status },
    select: { submittedById: true, itemTitle: true },
  });
  const msg =
    status === 'ACCEPTED'
      ? 'accepted — our team will follow up with next steps.'
      : status === 'DECLINED'
        ? 'declined. Thank you for the offer.'
        : `updated to ${status.toLowerCase()}.`;
  await notifyUser(
    sub.submittedById,
    `Your equipment submission was ${status.toLowerCase()}`,
    `"${sub.itemTitle}" was ${msg}`,
    `/app/sell-submissions/${id}`,
  );
  revalidatePath('/admin/sell');
  revalidatePath(`/app/sell-submissions/${id}`);
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
  illustration: z.enum(['microscope', 'centrifuge', 'pcr', 'hplc', 'massspec', 'balance', 'gc', 'autosampler', 'detector']),
  images: z.array(z.string().url()).max(MAX_ADMIN_PRODUCT_IMAGES).default([]),
  specs: z.record(z.string()).default({}),
  status: z.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED']).default('PUBLISHED'),
  quantity: z.number().int().min(0).max(100000).default(1),
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
};

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

export async function adminCreateProduct(input: AdminProductInputType): Promise<{ ok: true; slug: string } | AdminProductError> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('products:edit');
  const result = parseAdminProduct(input);
  if ('error' in result) return result.error;
  const parsed = result.data;
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
      hasImages: parsed.images.length > 0,
      specs: Object.keys(parsed.specs).length ? parsed.specs : undefined,
      categoryId: parsed.categoryId,
      brandId: parsed.brandId || null,
      sellerId: session.user.id,
      companyId: parsed.companyId || null,
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
  const parsed = result.data;
  const existing = await prisma.product.findUnique({ where: { slug }, select: { id: true } });
  if (!existing) return { ok: false, message: 'Product not found.' };
  await prisma.product.update({
    where: { id: existing.id },
    data: {
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
      hasImages: parsed.images.length > 0,
      // DbNull, not undefined: undefined means "leave unchanged", so removing
      // every spec row used to keep the old specs.
      specs: Object.keys(parsed.specs).length ? parsed.specs : Prisma.DbNull,
      categoryId: parsed.categoryId,
      brandId: parsed.brandId || null,
      companyId: parsed.companyId || null,
    },
  });
  await audit('product.admin.update', slug);
  revalidatePath('/admin/products');
  revalidatePath(`/admin/products/${slug}`);
  revalidatePath(`/marketplace/${slug}`);
  return { ok: true, message: 'Saved.' };
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
      isVerified: true,
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
 * Run the WooCommerce importer for a single Company. Returns counts. The
 * actual fetch + insert happens inline (no background queue) so the admin
 * can watch the result land in /admin/products. Heavy imports (>500 SKUs)
 * may take 30-60s; the admin UI shows a spinner.
 *
 * Optional `whitelistSlugs` lets the preview UI ship only the products the
 * admin approved (rather than bulk-importing every SKU the source returns).
 */
export async function importShopProducts(
  slug: string,
  whitelistSlugs?: string[] | null,
): Promise<{ ok: boolean; message: string; imported?: number }> {
  await requireAdmin();
  await requireCap('companies:manage');
  const co = await prisma.company.findUnique({ where: { slug } });
  if (!co) return { ok: false, message: 'Company not found.' };
  if (!co.importSourceUrl) return { ok: false, message: 'No import source URL configured for this shop. Edit the shop to set one.' };
  const base = co.importSourceUrl.replace(/\/+$/, '');

  const { runWooImport } = await import('@/lib/marketplace/import-woo');
  try {
    const imported = await runWooImport({
      companyId: co.id,
      slug: co.slug,
      name: co.name,
      base,
      whitelistSlugs: whitelistSlugs && whitelistSlugs.length ? whitelistSlugs : null,
    });
    await prisma.company.update({
      where: { id: co.id },
      data: { lastImportedAt: new Date(), suggestedByAi: false },
    });
    await audit('company.import', slug, `${imported} products${whitelistSlugs?.length ? ' (selective)' : ''}`);
    revalidatePath('/admin/products');
    revalidatePath('/admin/companies');
    return { ok: true, message: `Imported ${imported} product${imported === 1 ? '' : 's'} from ${base}.`, imported };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Import failed: ${e.message.slice(0, 240)}` : 'Import failed.' };
  }
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
      image: p.images[0] ?? null,
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
  let total = 0;
  let items: WooStorePreview[] = [];
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'lab2date-admin-preview/1.0' } });
    if (!res.ok) return { ok: false, message: `Source returned HTTP ${res.status}`, items: [], total: 0 };
    total = parseInt(res.headers.get('x-wp-total') ?? '0', 10) || 0;
    items = (await res.json()) as WooStorePreview[];
  } catch (e) {
    return { ok: false, message: e instanceof Error ? `Fetch failed: ${e.message}` : 'Fetch failed.', items: [], total: 0 };
  }
  // Check which slugs already exist in our DB so the UI can show a badge.
  const candidateSlugs = items.map((w) => (w.slug || `imp-${w.id}`).slice(0, 90));
  const existing = await prisma.product.findMany({
    where: { slug: { in: candidateSlugs } },
    select: { slug: true },
  });
  const existingSet = new Set(existing.map((p) => p.slug));
  return {
    ok: true,
    total,
    existingCount: existing.length,
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
        alreadyImported: existingSet.has(slug),
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

  await prisma.product.create({
    data: {
      slug,
      sourceUrl: parsed.sourceUrl,
      title: parsed.title,
      summary: parsed.summary ?? null,
      description: parsed.description ?? null,
      condition: parsed.condition,
      mode: parsed.priceCents ? 'HYBRID' : 'QUOTE_ONLY',
      status: 'DRAFT',                  // ALWAYS draft from URL importer
      priceCents: parsed.priceCents,
      currency: parsed.currency,
      quantity: 1,
      images: parsed.images,
      hasImages: parsed.images.length > 0,
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
  return { ok: true, slug, message: 'Draft created. Review and publish from the products list.' };
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
export async function deleteOrderPermanently(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
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
export async function bulkDeleteOrders(formData: FormData): Promise<{ ok: boolean; count: number; message: string }> {
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
  // Unpaid orders release their reserved stock first (same as the single-row
  // delete); any that can't be released are kept and reported, never dropped.
  const targets: typeof candidates = [];
  const kept: string[] = [];
  let restocked = 0;
  for (const o of candidates) {
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
 * Admin verifies a buyer-submitted payment proof → status PAID.
 *
 * BUG-019 fix: race-protection. Concurrent admin Verify clicks used to
 * both fire side effects (audit + email + notification). Now wraps the
 * write in updateMany with the AWAITING_VERIFICATION precondition;
 * only one wins (count===1), the other gets a friendly message.
 */
export async function verifyPayment(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:fulfil');
  await ensureSettingsLoaded();
  const id = String(formData.get('orderId') ?? '');
  if (!id) return { ok: false, message: 'Missing order id.' };
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true, orderNumber: true, status: true, totalCents: true, currency: true,
      paymentVerificationStatus: true, paymentSubmittedAt: true,
      paymentMethodManual: true,
      sourcingRequestId: true,
      shippingAddress: true,
      buyer: { select: { id: true, email: true, name: true } },
    },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  if (order.paymentVerificationStatus !== 'AWAITING_VERIFICATION') {
    return { ok: false, message: `Cannot verify — current state: ${order.paymentVerificationStatus ?? 'none'}.` };
  }
  if (['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'].includes(order.status)) {
    return { ok: false, message: `Order is already ${order.status.toLowerCase()}.` };
  }
  const verifyRes = await prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({
      where: {
        id,
        paymentVerificationStatus: 'AWAITING_VERIFICATION',
        status: 'PENDING_PAYMENT',
      },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paymentVerificationStatus: 'VERIFIED',
        paymentVerifiedAt: new Date(),
        paymentVerifiedById: session.user.id,
        paymentRejectionReason: null,
        // BUG-014 defensive: manual posture has no Stripe brand; ensure a
        // verified order always records a method so it never renders '—'.
        paymentMethodManual: order.paymentMethodManual ?? 'BANK_TRANSFER',
      },
    });
    if (res.count === 1 && order.sourcingRequestId) {
      await tx.sourcingRequest.updateMany({
        where: { id: order.sourcingRequestId, status: { in: ['PENDING', 'RESPONDED'] } },
        data: { status: 'ACCEPTED' },
      });
    }
    return res;
  });
  if (verifyRes.count !== 1) {
    return {
      ok: false,
      message: 'Verification race — another admin acted on this order. Refresh to see the current state.',
    };
  }
  await notifyUser(
    order.buyer.id,
    `Payment verified — order ${order.orderNumber}`,
    "Your payment has been verified. We will prepare your order for shipping.",
    `/app/orders/${order.orderNumber}`,
  );
  try {
    await sendEmail({
      to: order.buyer.email,
      subject: `Payment verified — order ${order.orderNumber}`,
      html: `<p>Hi ${escapeHtml(order.buyer.name ?? 'there')},</p><p>Your payment for order <strong>${order.orderNumber}</strong> has been verified. We will arrange shipping shortly.</p><p><a href="${process.env.BETTER_AUTH_URL ?? ''}/app/orders/${order.orderNumber}">View order</a></p>`,
      text: `Your payment for order ${order.orderNumber} has been verified. We will arrange shipping shortly.`,
    });
  } catch { /* email failure non-fatal */ }
  await notifyAdmins(
    `Payment verified — order ${order.orderNumber} (${(order.totalCents / 100).toFixed(2)} ${order.currency})`,
    `Verified by ${session.user.email}.`,
    `/admin/orders/${id}`,
    'PAYMENT_VERIFIED',
  );
  await audit('order.payment.verify', order.orderNumber, `verifier=${session.user.email}`);
  // The order is now PAID: email the real invoice (+ billing copy), as the
  // checkout success page promises. Never blocks — failures are logged.
  await sendOrderInvoice(order.id);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  revalidatePath('/app/quotes');
  revalidatePath('/admin/quotes');
  if (order.sourcingRequestId) {
    revalidatePath(`/app/quotes/${order.sourcingRequestId}`);
    revalidatePath(`/admin/quotes/${order.sourcingRequestId}`);
  }
  return {
    ok: true,
    message: shippingAddressIsComplete(order.shippingAddress)
      ? 'Payment verified. Invoice emailed to the buyer.'
      : 'Payment verified. Invoice emailed to the buyer. No complete shipping address on file yet — add it on the order page before shipping.',
  };
}

/** Admin rejects a buyer-submitted payment proof; buyer can resubmit. */
export async function rejectPayment(formData: FormData): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession({ roles: ['ADMIN'], redirectTo: '/admin' });
  await requireCap('orders:fulfil');
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
      buyer: { select: { id: true, email: true, name: true } },
    },
  });
  if (!order) return { ok: false, message: 'Order not found.' };
  if (order.paymentVerificationStatus !== 'AWAITING_VERIFICATION') {
    return { ok: false, message: `Cannot reject — current state: ${order.paymentVerificationStatus ?? 'none'}.` };
  }
  // BUG-037: claim the transition atomically (mirror of verifyPayment). The
  // in-memory AWAITING_VERIFICATION check above races a concurrent verify /
  // buyer-resubmit / double-click reject. Re-encode the precondition in the
  // write's WHERE and gate ALL side effects on count===1 so reject can never
  // overwrite a just-verified PAID order (F15 regression) or double-notify.
  const rejectRes = await prisma.order.updateMany({
    where: {
      id,
      paymentVerificationStatus: 'AWAITING_VERIFICATION',
      status: 'PENDING_PAYMENT',
    },
    data: {
      paymentVerificationStatus: 'REJECTED',
      paymentRejectionReason: reason,
      paymentSubmittedAt: null,
      paymentVerifiedAt: null,
      paymentVerifiedById: null,
    },
  });
  if (rejectRes.count !== 1) {
    return {
      ok: false,
      message: 'Rejection race — another admin already acted on this order (likely verified it). Refresh to see the current state.',
    };
  }
  await notifyUser(
    order.buyer.id,
    `Payment proof needs attention — order ${order.orderNumber}`,
    `Your receipt was reviewed and we need to ask for a corrected proof. Reason: ${reason.slice(0, 120)}`,
    `/app/orders/${order.orderNumber}/payment`,
  );
  try {
    await sendEmail({
      to: order.buyer.email,
      subject: `Payment proof needs attention — order ${order.orderNumber}`,
      html: `<p>Hi ${escapeHtml(order.buyer.name ?? 'there')},</p><p>We reviewed the receipt for order <strong>${order.orderNumber}</strong> and need a corrected proof.</p><blockquote>${escapeHtmlLines(reason)}</blockquote><p>You can <a href="${process.env.BETTER_AUTH_URL ?? ''}/app/orders/${order.orderNumber}/payment">resubmit your receipt</a>.</p>`,
      text: `We need a corrected receipt for order ${order.orderNumber}. Reason: ${reason}\nResubmit: ${process.env.BETTER_AUTH_URL ?? ''}/app/orders/${order.orderNumber}/payment`,
    });
  } catch { /* email failure non-fatal */ }
  await notifyAdmins(
    `Payment rejected — order ${order.orderNumber}`,
    `Reason: ${reason.slice(0, 120)} (by ${session.user.email}).`,
    `/admin/orders/${id}`,
    'PAYMENT_REJECTED',
  );
  await audit('order.payment.reject', order.orderNumber, `reason="${reason.slice(0, 80)}"`);
  revalidatePath('/admin/orders');
  revalidatePath(`/admin/orders/${id}`);
  return { ok: true, message: 'Payment rejected; buyer notified.' };
}
