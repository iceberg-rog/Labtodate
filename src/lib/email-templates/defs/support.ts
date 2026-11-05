import type { EmailDef } from '../types';

/**
 * Support-ticket e-mails to the customer (lib/support/actions.ts). The
 * acknowledgement has three versions because the form needs no account: the
 * ticket's own text is only echoed to the signed-in user's own address.
 */

const TICKET_NUMBER = { name: 'ticket.number', label: 'Ticket reference', example: 'TKT-4F7Q2A' };
const LINK_TICKET = { name: 'link.ticket', label: 'Link to the ticket', example: 'https://labtodate.com/app/support' };
const LINK_TICKET_PRIVATE = { name: 'link.ticket', label: 'Private link to the ticket', example: 'https://labtodate.com/support/t/x8Yq…' };

const RECEIVED_EN = 'We’re on it. Your support ticket has been logged and our team will reply by e-mail.';
const RECEIVED_NL = 'Wij gaan ermee aan de slag. Uw supportticket is geregistreerd en ons team reageert per e-mail.';
const NOT_YOU_EN = 'If you didn’t contact {{site.name}} support, you can ignore this e-mail.';
const NOT_YOU_NL = 'Heeft u geen contact opgenomen met de klantenservice van {{site.name}}? Dan kunt u deze e-mail negeren.';

export const SUPPORT_EMAILS: EmailDef[] = [
  {
    key: 'ticket_received',
    group: 'Support',
    label: 'Ticket received',
    when: 'A signed-in customer opens a support ticket with their own address; their message is repeated in the e-mail.',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.ticket',
    fields: [
      TICKET_NUMBER,
      { name: 'ticket.subject', label: 'Ticket subject', example: 'Missing power cable' },
      { name: 'ticket.message', label: 'What the customer wrote', example: 'The centrifuge arrived without its power cable.' },
      LINK_TICKET,
    ],
    defaults: {
      en: {
        subject: '[{{ticket.number}}] We received your request',
        body: `Dear {{customer.name}},\n\n${RECEIVED_EN}\n\n**Reference:** {{ticket.number}}\n**Subject:** {{ticket.subject}}\n\n{{ticket.message}}`,
        button: 'Open in your dashboard',
      },
      nl: {
        subject: '[{{ticket.number}}] Wij hebben uw verzoek ontvangen',
        body: `Geachte {{customer.name}},\n\n${RECEIVED_NL}\n\n**Referentie:** {{ticket.number}}\n**Onderwerp:** {{ticket.subject}}\n\n{{ticket.message}}`,
        button: 'Openen in uw dashboard',
      },
    },
  },
  {
    key: 'ticket_received_guest',
    group: 'Support',
    label: 'Ticket received (guest, private link)',
    when: 'Someone without an account opens a support ticket; the e-mail carries their private link to the ticket. Their own text is not repeated.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.ticket',
    fields: [TICKET_NUMBER, LINK_TICKET_PRIVATE],
    defaults: {
      en: {
        subject: '[{{ticket.number}}] We received your request',
        body: `${RECEIVED_EN}\n\n**Reference:** {{ticket.number}}\n\nUse the button below to view or reply to your ticket. It is a private link tied to your ticket; please keep it to yourself.\n\n${NOT_YOU_EN}`,
        button: 'View or reply to your ticket',
      },
      nl: {
        subject: '[{{ticket.number}}] Wij hebben uw verzoek ontvangen',
        body: `${RECEIVED_NL}\n\n**Referentie:** {{ticket.number}}\n\nMet de knop hieronder kunt u uw ticket bekijken of beantwoorden. Het is een persoonlijke link die aan uw ticket is gekoppeld; deel deze niet met anderen.\n\n${NOT_YOU_NL}`,
        button: 'Uw ticket bekijken of beantwoorden',
      },
    },
  },
  {
    key: 'ticket_received_other_address',
    group: 'Support',
    label: 'Ticket received (address differs from the account)',
    when: 'A signed-in customer opens a ticket but types a different e-mail address; the ticket text is not repeated.',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.ticket',
    fields: [TICKET_NUMBER, LINK_TICKET],
    defaults: {
      en: {
        subject: '[{{ticket.number}}] We received your request',
        body: `${RECEIVED_EN}\n\n**Reference:** {{ticket.number}}\n\n${NOT_YOU_EN}`,
        button: 'Open in dashboard',
      },
      nl: {
        subject: '[{{ticket.number}}] Wij hebben uw verzoek ontvangen',
        body: `${RECEIVED_NL}\n\n**Referentie:** {{ticket.number}}\n\n${NOT_YOU_NL}`,
        button: 'Openen in dashboard',
      },
    },
  },
  {
    key: 'ticket_reply',
    group: 'Support',
    label: 'Reply from support',
    when: 'An admin replies to a support ticket (internal notes never e-mail). The reply itself is in the e-mail.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.ticket',
    fields: [
      TICKET_NUMBER,
      { name: 'ticket.subject', label: 'Ticket subject', example: 'Missing power cable' },
      { name: 'reply.body', label: 'The reply', example: 'Thank you for letting us know. A new cable is on its way.' },
      { ...LINK_TICKET, label: 'Link to the ticket (private link for guests)' },
    ],
    defaults: {
      en: {
        subject: '[{{ticket.number}}] Reply from {{site.name}} support',
        body: 'Re: {{ticket.subject}}\n\n{{reply.body}}',
        button: 'Open ticket {{ticket.number}}',
      },
      nl: {
        subject: '[{{ticket.number}}] Antwoord van de klantenservice van {{site.name}}',
        body: 'Re: {{ticket.subject}}\n\n{{reply.body}}',
        button: 'Ticket {{ticket.number}} openen',
      },
    },
  },
  {
    key: 'ticket_link_reissued',
    group: 'Support',
    label: 'New private link to a ticket (guest)',
    when: 'An admin replaces the private link of a guest ticket; the old link stops working.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.ticket',
    fields: [TICKET_NUMBER, { ...LINK_TICKET_PRIVATE, label: 'New private link to the ticket' }, { name: 'link.valid_days', label: 'Private link valid for (days)', example: '14' }],
    defaults: {
      en: {
        subject: '[{{ticket.number}}] New link to view your ticket',
        body:
          'Dear {{customer.name}},\n\nHere is a fresh link to ticket **{{ticket.number}}**. Our support team has replaced the previous access link, which no longer works.\n\nThe new link is valid for {{link.valid_days}} days. Please keep it private.',
        button: 'View ticket {{ticket.number}}',
      },
      nl: {
        subject: '[{{ticket.number}}] Nieuwe link om uw ticket te bekijken',
        body:
          'Geachte {{customer.name}},\n\nHierbij ontvangt u een nieuwe link naar ticket **{{ticket.number}}**. Onze klantenservice heeft de vorige toegangslink vervangen; die werkt niet meer.\n\nDe nieuwe link is {{link.valid_days}} dagen geldig. Deel deze niet met anderen.',
        button: 'Ticket {{ticket.number}} bekijken',
      },
    },
  },
];
