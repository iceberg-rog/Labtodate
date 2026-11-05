import type { EmailDef } from '../types';

/**
 * Quote-request e-mails to the buyer and to the supplier handling the request
 * (lib/quotes/actions.ts, the SLA sweep). The issued quote itself is in
 * ./documents.ts.
 */

const QUOTE_NUMBER = { name: 'quote.number', label: 'Quote reference', example: 'RFQ-7KQ2XF' };
const QUOTE_ITEM = { name: 'quote.item', label: 'What was requested', example: 'Agilent 1260 Infinity II pump' };
const LINK_QUOTE = { name: 'link.quote', label: 'Link to the quote', example: 'https://labtodate.com/app/quotes/clx7kq2xf0001' };
const LINK_VALID_DAYS = { name: 'link.valid_days', label: 'Private link valid for (days)', example: '14' };

const RECEIVED_FIELDS = [
  QUOTE_NUMBER,
  QUOTE_ITEM,
  { name: 'quote.description', label: 'What the buyer wrote', example: 'We need a quaternary pump for our HPLC, delivery to Utrecht.' },
  { name: 'quote.turnaround', label: 'Reply time (Settings → Quote turnaround; may be empty)', example: '2 business days' },
];

export const QUOTE_EMAILS: EmailDef[] = [
  {
    key: 'quote_request_received',
    group: 'Quotes',
    label: 'Quote request received',
    when: 'A signed-in buyer sends a quote or sourcing request.',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.quote',
    fields: [...RECEIVED_FIELDS, { ...LINK_QUOTE, label: 'Link to the quotes in the dashboard', example: 'https://labtodate.com/app/quotes' }],
    defaults: {
      en: {
        subject: 'Quote request received: {{quote.item}}',
        body:
          'Dear {{customer.name}},\n\nThank you for your request **{{quote.number}}** for {{quote.item}}. Our team and the supplier will review it and reply as soon as we have something solid.\n\n**What you wrote:**\n{{quote.description}}',
        button: 'Open in your dashboard',
      },
      nl: {
        subject: 'Offerteaanvraag ontvangen: {{quote.item}}',
        body:
          'Geachte {{customer.name}},\n\nHartelijk dank voor uw aanvraag **{{quote.number}}** voor {{quote.item}}. Ons team en de leverancier bekijken uw aanvraag en reageren zodra wij iets concreets voor u hebben.\n\n**Uw bericht:**\n{{quote.description}}',
        button: 'Openen in uw dashboard',
      },
    },
  },
  {
    key: 'quote_request_received_guest',
    group: 'Quotes',
    label: 'Quote request received (guest, private link)',
    when: 'A buyer without an account sends a quote request; the e-mail carries their private link to the quote.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.quote',
    fields: [...RECEIVED_FIELDS, { ...LINK_QUOTE, label: 'Private link to the quote', example: 'https://labtodate.com/quotes/t/x8Yq…' }, LINK_VALID_DAYS],
    defaults: {
      en: {
        subject: 'Quote request received: {{quote.item}}',
        body:
          'Dear {{customer.name}},\n\nThank you for your request **{{quote.number}}** for {{quote.item}}. Our team and the supplier will review it and reply as soon as we have something solid.\n\n**What you wrote:**\n{{quote.description}}\n\nThe button below is a private link tied to your request; please keep it to yourself. It is valid for {{link.valid_days}} days.',
        button: 'View or reply to your quote',
      },
      nl: {
        subject: 'Offerteaanvraag ontvangen: {{quote.item}}',
        body:
          'Geachte {{customer.name}},\n\nHartelijk dank voor uw aanvraag **{{quote.number}}** voor {{quote.item}}. Ons team en de leverancier bekijken uw aanvraag en reageren zodra wij iets concreets voor u hebben.\n\n**Uw bericht:**\n{{quote.description}}\n\nDe knop hieronder is een persoonlijke link die aan uw aanvraag is gekoppeld; deel deze niet met anderen. De link is {{link.valid_days}} dagen geldig.',
        button: 'Uw offerte bekijken of beantwoorden',
      },
    },
  },
  {
    key: 'quote_reply',
    group: 'Quotes',
    label: 'New reply on a quote',
    when: 'Our team or the supplier replies in a quote thread (internal notes never e-mail).',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.quote',
    fields: [QUOTE_NUMBER, LINK_QUOTE],
    defaults: {
      en: {
        subject: 'New reply on your {{site.name}} quote',
        body: 'The supplier replied to your quote request **{{quote.number}}**.\n\nOpen the thread to read the reply.',
        button: 'Open the thread',
      },
      nl: {
        subject: 'Nieuwe reactie op uw offerteaanvraag bij {{site.name}}',
        body: 'De leverancier heeft gereageerd op uw offerteaanvraag **{{quote.number}}**.\n\nOpen het gesprek om de reactie te lezen.',
        button: 'Gesprek openen',
      },
    },
  },
  {
    key: 'quote_closed',
    group: 'Quotes',
    label: 'Quote request closed',
    when: 'The supplier or our team closes a quote request without a deal (no order had to be canceled).',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.quote',
    fields: [QUOTE_NUMBER, QUOTE_ITEM, LINK_QUOTE],
    defaults: {
      en: {
        subject: '[{{quote.number}}] Your quote request was closed',
        body:
          'Dear {{customer.name}},\n\nYour request **{{quote.number}}** for {{quote.item}} was closed without a deal.\n\nIf you still need the item, you can open a new request on {{site.name}} at any time.',
        button: 'View the quote',
      },
      nl: {
        subject: '[{{quote.number}}] Uw offerteaanvraag is gesloten',
        body:
          'Geachte {{customer.name}},\n\nUw aanvraag **{{quote.number}}** voor {{quote.item}} is gesloten zonder dat er een deal tot stand is gekomen.\n\nHeeft u het artikel nog steeds nodig? Dan kunt u op elk moment een nieuwe aanvraag indienen bij {{site.name}}.',
        button: 'Offerte bekijken',
      },
    },
  },
  {
    key: 'quote_closed_order_canceled',
    group: 'Quotes',
    label: 'Quote request closed (order canceled)',
    when: 'A quote request is closed without a deal and its unpaid order is canceled: tells the buyer not to pay.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.quote',
    fields: [QUOTE_NUMBER, QUOTE_ITEM, { name: 'order.number', label: 'Canceled order number', example: 'L2D-2026-7KQ2XF' }, LINK_QUOTE],
    defaults: {
      en: {
        subject: '[{{quote.number}}] Your quote request was closed',
        body:
          'Dear {{customer.name}},\n\nYour request **{{quote.number}}** for {{quote.item}} was closed without a deal.\n\nOrder **{{order.number}}** was canceled, so **no payment is due**. Please don’t send a transfer for it. If you already paid, contact our support team and we’ll sort it out.\n\nIf you still need the item, you can open a new request on {{site.name}} at any time.',
        button: 'View the quote',
      },
      nl: {
        subject: '[{{quote.number}}] Uw offerteaanvraag is gesloten',
        body:
          'Geachte {{customer.name}},\n\nUw aanvraag **{{quote.number}}** voor {{quote.item}} is gesloten zonder dat er een deal tot stand is gekomen.\n\nBestelling **{{order.number}}** is geannuleerd, dus **u hoeft niets te betalen**. Maak hiervoor geen bedrag over. Heeft u al betaald? Neem dan contact op met onze klantenservice, dan lossen wij het op.\n\nHeeft u het artikel nog steeds nodig? Dan kunt u op elk moment een nieuwe aanvraag indienen bij {{site.name}}.',
        button: 'Offerte bekijken',
      },
    },
  },
  {
    key: 'quote_expired',
    group: 'Quotes',
    label: 'Quote expired',
    when: 'A sent quote passes its validity date without the buyer acting on it (nightly sweep); the request moves to Lost.',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.quote',
    fields: [
      { ...QUOTE_NUMBER, example: 'PRO-2026-0007' },
      QUOTE_ITEM,
      { name: 'quote.expired_on', label: 'Expiry date', example: '2026-11-19' },
      LINK_QUOTE,
    ],
    defaults: {
      en: {
        subject: '[{{quote.number}}] Your quote has expired',
        body:
          'Dear {{customer.name}},\n\nYour quote **{{quote.number}}** for {{quote.item}} expired on {{quote.expired_on}}.\n\nIf you would still like to proceed, just reply in your quote thread and we’ll re-issue it with up-to-date pricing.',
        button: 'Open your quote',
      },
      nl: {
        subject: '[{{quote.number}}] Uw offerte is verlopen',
        body:
          'Geachte {{customer.name}},\n\nUw offerte **{{quote.number}}** voor {{quote.item}} is verlopen op {{quote.expired_on}}.\n\nWilt u toch verder? Reageer dan in het gesprek over uw offerte, dan sturen wij u een nieuwe offerte met actuele prijzen.',
        button: 'Uw offerte openen',
      },
    },
  },
  {
    key: 'quote_link_reissued',
    group: 'Quotes',
    label: 'New private link to a quote (guest)',
    when: 'An admin replaces the private link of a guest quote request; the old link stops working.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.quote',
    fields: [QUOTE_NUMBER, { ...LINK_QUOTE, label: 'New private link to the quote', example: 'https://labtodate.com/quotes/t/x8Yq…' }, LINK_VALID_DAYS],
    defaults: {
      en: {
        subject: '[{{quote.number}}] New link to view your quote',
        body:
          'Dear {{customer.name}},\n\nHere is a fresh link to quote **{{quote.number}}**. Our support team has replaced the previous access link, which no longer works.\n\nThe new link is valid for {{link.valid_days}} days. Please keep it private.',
        button: 'View quote',
      },
      nl: {
        subject: '[{{quote.number}}] Nieuwe link om uw offerte te bekijken',
        body:
          'Geachte {{customer.name}},\n\nHierbij ontvangt u een nieuwe link naar offerte **{{quote.number}}**. Onze klantenservice heeft de vorige toegangslink vervangen; die werkt niet meer.\n\nDe nieuwe link is {{link.valid_days}} dagen geldig. Deel deze niet met anderen.',
        button: 'Offerte bekijken',
      },
    },
  },
  {
    key: 'quote_request_new_seller',
    group: 'Quotes',
    label: 'New quote request (to the supplier)',
    when: 'A buyer requests a quote for a supplier’s listing. The supplier never sees who the buyer is.',
    audience: 'seller',
    canDisable: true,
    buttonLink: 'link.quote',
    fields: [
      QUOTE_NUMBER,
      QUOTE_ITEM,
      { name: 'quote.budget', label: 'Budget (— when not given)', example: '€ 15,000' },
      { name: 'quote.timeframe', label: 'Timeframe (— when not given)', example: 'Within 4 weeks' },
      { name: 'quote.description', label: 'What the buyer wrote', example: 'We need a quaternary pump for our HPLC, delivery to Utrecht.' },
      { ...LINK_QUOTE, label: 'Link to the seller inbox', example: 'https://labtodate.com/app/seller/inbox/clx7kq2xf0001' },
    ],
    defaults: {
      en: {
        subject: 'New quote request: {{quote.item}}',
        body:
          'You have a new quote request **{{quote.number}}** for {{quote.item}}.\n\n- Budget: {{quote.budget}}\n- Timeframe: {{quote.timeframe}}\n\n**Description:**\n{{quote.description}}\n\nPlease reply through your {{site.name}} seller inbox.',
        button: 'Open in seller inbox',
      },
      nl: {
        subject: 'Nieuwe offerteaanvraag: {{quote.item}}',
        body:
          'U heeft een nieuwe offerteaanvraag **{{quote.number}}** ontvangen voor {{quote.item}}.\n\n- Budget: {{quote.budget}}\n- Termijn: {{quote.timeframe}}\n\n**Omschrijving:**\n{{quote.description}}\n\nReageer via uw verkopersinbox op {{site.name}}.',
        button: 'Openen in verkopersinbox',
      },
    },
  },
  {
    key: 'quote_buyer_replied',
    group: 'Quotes',
    label: 'Buyer replied on a quote (to the supplier)',
    when: 'The buyer replies in a quote thread; goes to the supplier handling it, or to the quote intake inbox.',
    audience: 'seller',
    canDisable: true,
    buttonLink: 'link.quote',
    fields: [QUOTE_NUMBER, { ...LINK_QUOTE, label: 'Link to the thread (seller inbox or admin)', example: 'https://labtodate.com/app/seller/inbox/clx7kq2xf0001' }],
    defaults: {
      en: {
        subject: '[{{quote.number}}] The buyer replied on a quote',
        body: 'The buyer replied on quote **{{quote.number}}**.\n\nOpen the thread to read it and respond.',
        button: 'Open the thread',
      },
      nl: {
        subject: '[{{quote.number}}] De koper heeft gereageerd op een offerte',
        body: 'De koper heeft gereageerd op offerte **{{quote.number}}**.\n\nOpen het gesprek om de reactie te lezen en te antwoorden.',
        button: 'Gesprek openen',
      },
    },
  },
  {
    key: 'quote_transferred',
    group: 'Quotes',
    label: 'Quote transferred to you',
    when: 'An admin transfers a quote request to another admin or a supplier.',
    audience: 'seller',
    canDisable: true,
    buttonLink: 'link.quote',
    fields: [QUOTE_NUMBER, { ...LINK_QUOTE, label: 'Link to the quote (seller inbox or admin)', example: 'https://labtodate.com/app/seller/inbox/clx7kq2xf0001' }],
    defaults: {
      en: {
        subject: '[{{quote.number}}] A quote was transferred to you',
        body: 'Quote **{{quote.number}}** was transferred to you on {{site.name}}.\n\nOpen the quote to reply to the buyer.',
        button: 'Open the quote',
      },
      nl: {
        subject: '[{{quote.number}}] Er is een offerte aan u overgedragen',
        body: 'Offerte **{{quote.number}}** is aan u overgedragen op {{site.name}}.\n\nOpen de offerte om de koper te antwoorden.',
        button: 'Offerte openen',
      },
    },
  },
];
