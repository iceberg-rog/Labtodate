import { isDeliverableEmail } from '@/lib/email-address';
import { headerText } from '@/lib/email-html';
import { deliveryState, messageText } from './mediation';

/**
 * House stock: listings the site sells itself — created by an admin (the
 * product's seller is that admin's account), owned by an account without a
 * supplier company, or by an importer placeholder without an inbox. A buyer's
 * question about such a unit is a support ticket for the whole team (SLA,
 * colleagues can pick it up), never a private thread in one person's inbox.
 * Pure: shared by startThreadWithSeller / sendMessage and the one-off script
 * scripts/threads-to-tickets.ts.
 */

export const PRODUCT_QUESTION_CATEGORY = 'Product question';

export function isHouseSeller(seller: { role: string; companyId: string | null; email: string }): boolean {
  return seller.role === 'ADMIN' || !seller.companyId || !isDeliverableEmail(seller.email);
}

export interface ThreadForTicket {
  subject: string | null;
  buyerId: string;
  buyer: { name: string; email: string };
  product: { title: string } | null;
  messages: readonly { authorId: string; body: string; createdAt: Date }[];
}

export interface TicketPlan {
  subject: string;
  name: string;
  email: string;
  category: string;
  status: 'WAITING_ON_SUPPORT' | 'WAITING_ON_CUSTOMER';
  lastReplyAt: Date;
  lastReplyByStaff: boolean;
  messages: { fromStaff: boolean; authorId: string; body: string; createdAt: Date }[];
}

/** The support ticket a house-stock thread becomes: same buyer, same product,
 *  every delivered message in order (the buyer's new one last). */
export function planTicketFromThread(thread: ThreadForTicket, opts: { now: Date; buyerMessage?: string | null }): TicketPlan {
  const messages = thread.messages
    .filter((m) => deliveryState(m.body) === 'DELIVERED' && messageText(m.body).trim())
    .map((m) => ({ fromStaff: m.authorId !== thread.buyerId, authorId: m.authorId, body: messageText(m.body), createdAt: m.createdAt }));
  if (opts.buyerMessage?.trim()) {
    messages.push({ fromStaff: false, authorId: thread.buyerId, body: opts.buyerMessage.trim(), createdAt: opts.now });
  }
  const last = messages[messages.length - 1];
  const about = thread.product?.title ?? thread.subject?.replace(/^About:\s*/i, '') ?? 'a listing';
  return {
    subject: headerText(`Question: ${about}`, 160),
    name: (thread.buyer.name || thread.buyer.email.split('@')[0] || 'Buyer').slice(0, 120),
    email: thread.buyer.email,
    category: PRODUCT_QUESTION_CATEGORY,
    status: !last || !last.fromStaff ? 'WAITING_ON_SUPPORT' : 'WAITING_ON_CUSTOMER',
    lastReplyAt: last?.createdAt ?? opts.now,
    lastReplyByStaff: !!last?.fromStaff,
    messages,
  };
}

/** Last line posted in the old thread, so both sides know where it went. */
export function movedToTicketText(ref: string, site: string): string {
  return `This conversation continues as support ticket ${ref}. Open Support in your account to read it and reply — the whole ${site} team sees it there.`;
}
