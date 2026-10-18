import { deliveryState, messageText, type MediationMode } from './mediation';

/**
 * What a buyer or a supplier sees of a buyer ↔ supplier thread (inbox page and
 * the polling API share this). Identities never cross: the other side is
 * “<Site> Supplier” / “<Site> Buyer”, staff are “<Site> team”, and messages
 * still held for (or withheld after) staff review are shown to their author
 * only, with a note.
 */

export interface ParticipantMessage {
  id: string;
  body: string;
  createdAt: string;
  authorName: string;
  authorEmail: null;
  isMine: boolean;
  /** Delivery note on the viewer's own held / withheld message. */
  note: string | null;
}

export function participantLabels(site: string) {
  return { supplier: `${site} Supplier`, buyer: `${site} Buyer`, team: `${site} team` };
}

export function participantMessages(
  rows: readonly { id: string; body: string; createdAt: Date; authorId: string; authorRole: string | null }[],
  ctx: { viewerId: string; viewerIsBuyer: boolean; site: string },
): ParticipantMessage[] {
  const labels = participantLabels(ctx.site);
  const counterpart = ctx.viewerIsBuyer ? labels.supplier : labels.buyer;
  const out: ParticipantMessage[] = [];
  for (const m of rows) {
    const isMine = m.authorId === ctx.viewerId;
    const state = deliveryState(m.body);
    if (!isMine && state !== 'DELIVERED') continue;
    out.push({
      id: m.id,
      body: messageText(m.body),
      createdAt: m.createdAt.toISOString(),
      authorName: isMine ? 'You' : m.authorRole === 'ADMIN' ? labels.team : counterpart,
      authorEmail: null,
      isMine,
      note:
        !isMine || state === 'DELIVERED'
          ? null
          : state === 'HELD'
            ? `Waiting for review by the ${ctx.site} team before it is delivered.`
            : `Not delivered: the ${ctx.site} team did not pass this message on.`,
    });
  }
  return out;
}

/** The on-page explanation of how the conversation is mediated (true for each mode). */
export function mediationNotice(mode: MediationMode, site: string, scope: 'thread' | 'inbox' = 'thread'): string {
  const [subject, it] = scope === 'inbox' ? ['Conversations run', 'them'] : ['This conversation runs', 'it'];
  const base = `${subject} through ${site}: your name and account details are not shown to the other side`;
  if (mode === 'OFF') return `${base}, and the ${site} team can read and join ${it}.`;
  const removed = 'contact details in messages (e-mail addresses, phone numbers, links, bank account numbers) are removed';
  if (mode === 'STAFF_REVIEW') return `${base}, ${removed}, and the ${site} team checks every supplier message before it is delivered.`;
  return `${base}, ${removed}, and the ${site} team can read and join ${it}.`;
}
