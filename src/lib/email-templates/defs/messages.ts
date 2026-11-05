import type { EmailDef } from '../types';

/**
 * Chat e-mails: buyer-seller messages (lib/messages/actions.ts) and operator
 * replies in the site chat (lib/assistant/actions.ts). Both are throttled:
 * at most one e-mail per conversation every couple of hours, found by the
 * reference in the subject.
 */

export const MESSAGE_EMAILS: EmailDef[] = [
  {
    key: 'message_new',
    subjectMustKeep: ['message.ref'],
    group: 'Messages',
    label: 'New message',
    when: 'A buyer or seller writes in a conversation about a listing. At most one e-mail per conversation every couple of hours.',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.thread',
    fields: [
      { name: 'message.ref', label: 'Conversation reference (keep it in the subject: the throttle looks for it)', example: 'MSG-8KD2QX' },
      { name: 'message.product', label: 'Listing the conversation is about', example: 'Agilent 1260 Infinity II pump' },
      { name: 'link.thread', label: 'Link to the conversation', example: 'https://labtodate.com/app/inbox/clx8kd2qx0001' },
    ],
    defaults: {
      en: {
        subject: '[{{message.ref}}] New message on {{site.name}} about "{{message.product}}"',
        body:
          'You have a new message about **{{message.product}}** on {{site.name}}.\n\nOpen the conversation to read and reply.\n\nWhile a conversation is active, we e-mail at most once every couple of hours. Newer messages are in your inbox.',
        button: 'Open the conversation',
      },
      nl: {
        subject: '[{{message.ref}}] Nieuw bericht op {{site.name}} over "{{message.product}}"',
        body:
          'U heeft een nieuw bericht over **{{message.product}}** op {{site.name}}.\n\nOpen het gesprek om het bericht te lezen en te beantwoorden.\n\nZolang een gesprek actief is, sturen wij hooguit eens per paar uur een e-mail. Nieuwere berichten vindt u in uw inbox.',
        button: 'Gesprek openen',
      },
    },
  },
  {
    key: 'chat_reply',
    subjectMustKeep: ['chat.ref'],
    group: 'Messages',
    label: 'Reply in the site chat',
    when: 'An operator replies to a chat that was handed over to a person. At most one e-mail per chat every couple of hours.',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.chat',
    fields: [
      { name: 'chat.ref', label: 'Chat reference (keep it in the subject: the throttle looks for it)', example: 'CHT-3MZ8WE' },
      { name: 'chat.reply', label: 'The operator’s reply (first 500 characters)', example: 'Yes, the pump comes with a 12-month warranty.' },
      { name: 'link.chat', label: 'Link to the site', example: 'https://labtodate.com/app' },
    ],
    defaults: {
      en: {
        subject: '[{{chat.ref}}] We replied to your chat on {{site.name}}',
        body:
          'Hello,\n\nAn operator replied to your chat:\n\n{{chat.reply}}\n\nTo continue the conversation, open the chat at the bottom right of any page on {{site.name}}.',
        button: 'Continue the conversation',
      },
      nl: {
        subject: '[{{chat.ref}}] Wij hebben gereageerd op uw chat op {{site.name}}',
        body:
          'Goedendag,\n\nEen medewerker heeft gereageerd op uw chat:\n\n{{chat.reply}}\n\nWilt u het gesprek voortzetten? Open dan de chat rechtsonder op een willekeurige pagina van {{site.name}}.',
        button: 'Gesprek voortzetten',
      },
    },
  },
];
