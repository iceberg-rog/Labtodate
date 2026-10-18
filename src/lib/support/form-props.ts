import { prisma } from '@/lib/db';
import { ensureSettingsLoaded } from '@/lib/settings';
import { formCaptchaFlag } from '@/lib/security/captcha';
import type { SupportOrderOption } from '@/components/support/SupportForm';
import { matchTopic, supportReplyPromise, supportTopics } from './policy';

type Session = { user: { id: string; name?: string | null; email: string } } | null;

/** Query parameters the ticket form understands (/support, /contact). */
export type SupportFormQuery = {
  /** Order number the ticket is about (linked from the order page). */
  order?: string;
  /** A topic from Settings → Support (case-insensitive). */
  topic?: string;
  /** A ticket reference to follow up on (closed tickets point here). */
  followup?: string;
};

const ORDER_NO = /^L2D-\d{4}-[A-Z0-9]{6}$/;
const TICKET_REF = /^TKT-\d{4}-[A-Z0-9]{6}$/;

/**
 * Everything the ticket form needs from the server: the topics and reply
 * promise (Settings → Support), the bot-check flag, the signed-in customer's
 * own orders (newest 50) and the defaults from ?order= / ?topic= /
 * ?followup=. A guest's ?order= only prefills the subject — the server links
 * the order when it belongs to the e-mail they type.
 */
export async function supportFormProps(session: Session, q: SupportFormQuery) {
  await ensureSettingsLoaded();
  const signedIn = !!session?.user;
  const captcha = await formCaptchaFlag('support', signedIn);
  const orderNo = (q.order ?? '').trim().toUpperCase();
  const order = ORDER_NO.test(orderNo) ? orderNo : '';
  const followup = (q.followup ?? '').trim().toUpperCase();

  let orders: SupportOrderOption[] = [];
  if (session?.user) {
    const rows = await prisma.order.findMany({
      where: { buyerId: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { orderNumber: true, createdAt: true, items: { take: 1, select: { titleSnapshot: true } } },
    });
    orders = rows.map((o) => ({
      orderNumber: o.orderNumber,
      label: [
        o.orderNumber,
        o.createdAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
        o.items[0]?.titleSnapshot ? o.items[0].titleSnapshot.slice(0, 50) : null,
      ].filter(Boolean).join(' · '),
    }));
  }
  const ownOrder = orders.some((o) => o.orderNumber === order);
  const orderTopic = order ? supportTopics().find((t) => /order|deliver/i.test(t)) : undefined;

  return {
    signedIn,
    captcha,
    defaultEmail: session?.user.email ?? '',
    defaultName: session?.user.name ?? '',
    topics: supportTopics(),
    defaultTopic: matchTopic(q.topic) ?? orderTopic ?? undefined,
    orders,
    defaultOrder: ownOrder ? order : '',
    defaultSubject: TICKET_REF.test(followup)
      ? `Follow-up to ${followup}`
      : order && !ownOrder
      ? `Question about order ${order}`
      : '',
    replyPromise: supportReplyPromise(),
  };
}
