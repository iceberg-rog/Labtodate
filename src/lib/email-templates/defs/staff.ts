import type { EmailDef } from '../types';

/**
 * Notifications to our own inboxes (the quote / support / sell intake
 * addresses from Settings → Email) and to the admin handling an item. They
 * are sent in English.
 */

const LINK_ADMIN = { name: 'link.admin', label: 'Link to the item in admin', example: 'https://labtodate.com/admin/tickets/clx4f7q2a0001' };
const QUOTE_NUMBER = { name: 'quote.number', label: 'Quote reference', example: 'RFQ-7KQ2XF' };
const TICKET_NUMBER = { name: 'ticket.number', label: 'Ticket reference', example: 'TKT-4F7Q2A' };
const TICKET_SUBJECT = { name: 'ticket.subject', label: 'Ticket subject', example: 'Missing power cable' };
const REPLY_FIELDS = [
  { name: 'reply.author', label: 'Who replied', example: 'Anna de Vries' },
  { name: 'reply.author_email', label: 'Their e-mail address', example: 'anna@utrecht-bio.nl' },
  { name: 'reply.body', label: 'The reply', example: 'The cable is still missing, can you check again?' },
];
const SLA_FIELDS = [
  { name: 'sla.priority', label: 'Priority', example: 'HIGH' },
  { name: 'sla.overdue_minutes', label: 'Minutes overdue', example: '45' },
];

export const STAFF_EMAILS: EmailDef[] = [
  // ─── Quotes ─────────────────────────────────────────────────────────────
  {
    key: 'staff_quote_request_new',
    group: 'Quotes',
    label: 'New quote request (to our team)',
    when: 'A buyer sends a quote or sourcing request that is not handled by a supplier with a real address (goes to the quote intake inbox or the admin it is assigned to).',
    audience: 'staff',
    canDisable: true,
    buttonLink: 'link.admin',
    fields: [
      QUOTE_NUMBER,
      { name: 'quote.item', label: 'What was requested', example: 'Agilent 1260 Infinity II pump' },
      { name: 'buyer.name', label: 'Buyer name', example: 'Anna de Vries' },
      { name: 'buyer.email', label: 'Buyer e-mail', example: 'anna@utrecht-bio.nl' },
      { name: 'buyer.company', label: 'Buyer company (— when not given)', example: 'Utrecht Bioanalytics B.V.' },
      { name: 'quote.product', label: 'Listing (— when none)', example: 'Agilent 1260 Infinity II pump' },
      { name: 'quote.facility', label: 'Lab facility (— when none)', example: 'Lab rental: Bio Science Park (Leiden, NL)' },
      { name: 'quote.budget', label: 'Budget (— when not given)', example: '€ 15,000' },
      { name: 'quote.timeframe', label: 'Timeframe (— when not given)', example: 'Within 4 weeks' },
      { name: 'quote.description', label: 'What the buyer wrote', example: 'We need a quaternary pump for our HPLC, delivery to Utrecht.' },
      { ...LINK_ADMIN, example: 'https://labtodate.com/admin/quotes/clx7kq2xf0001' },
    ],
    defaults: {
      en: {
        subject: 'New quote request from {{buyer.name}}: {{quote.item}}',
        body:
          'New quote request **{{quote.number}}** from **{{buyer.name}}** <{{buyer.email}}>.\n\n- Company: {{buyer.company}}\n- Listing: {{quote.product}}\n- Facility: {{quote.facility}}\n- Budget: {{quote.budget}}\n- Timeframe: {{quote.timeframe}}\n\n**Description:**\n{{quote.description}}',
        button: 'Open in admin',
      },
      nl: {
        subject: 'Nieuwe offerteaanvraag van {{buyer.name}}: {{quote.item}}',
        body:
          'Nieuwe offerteaanvraag **{{quote.number}}** van **{{buyer.name}}** <{{buyer.email}}>.\n\n- Bedrijf: {{buyer.company}}\n- Advertentie: {{quote.product}}\n- Faciliteit: {{quote.facility}}\n- Budget: {{quote.budget}}\n- Termijn: {{quote.timeframe}}\n\n**Omschrijving:**\n{{quote.description}}',
        button: 'Openen in admin',
      },
    },
  },
  {
    key: 'staff_quote_guest_reply',
    group: 'Quotes',
    label: 'Guest replied on a quote (to our team)',
    when: 'A buyer replies on a quote through their private link (support intake inbox).',
    audience: 'staff',
    canDisable: true,
    buttonLink: 'link.admin',
    fields: [QUOTE_NUMBER, ...REPLY_FIELDS, { ...LINK_ADMIN, example: 'https://labtodate.com/admin/quotes/clx7kq2xf0001' }],
    defaults: {
      en: {
        subject: '[{{quote.number}}] Guest reply on a quote',
        body: '{{reply.author}} ({{reply.author_email}}) replied to quote **{{quote.number}}**:\n\n{{reply.body}}',
        button: 'Open in admin',
      },
      nl: {
        subject: '[{{quote.number}}] Reactie van een gast op een offerte',
        body: '{{reply.author}} ({{reply.author_email}}) heeft gereageerd op offerte **{{quote.number}}**:\n\n{{reply.body}}',
        button: 'Openen in admin',
      },
    },
  },
  {
    key: 'staff_quote_sla_breached',
    group: 'Quotes',
    label: 'Quote request overdue (SLA)',
    when: 'An assigned quote request passes its reply deadline (sweep); goes to the assignee, or the quote intake inbox for imported sellers.',
    audience: 'staff',
    canDisable: true,
    buttonLink: 'link.admin',
    fields: [
      QUOTE_NUMBER,
      { name: 'quote.item', label: 'What was requested', example: 'Agilent 1260 Infinity II pump' },
      ...SLA_FIELDS,
      { ...LINK_ADMIN, example: 'https://labtodate.com/admin/quotes/clx7kq2xf0001' },
    ],
    defaults: {
      en: {
        subject: '[SLA] Quote {{quote.number}} overdue by {{sla.overdue_minutes}} min',
        body: '**{{sla.priority}}** quote **{{quote.number}}** has breached its SLA.\n\n{{quote.item}}',
        button: 'Open in admin',
      },
      nl: {
        subject: '[SLA] Offerte {{quote.number}} {{sla.overdue_minutes}} min te laat',
        body: 'Offerte **{{quote.number}}** (prioriteit **{{sla.priority}}**) heeft de SLA overschreden.\n\n{{quote.item}}',
        button: 'Openen in admin',
      },
    },
  },

  // ─── Support ────────────────────────────────────────────────────────────
  {
    key: 'staff_ticket_new',
    group: 'Support',
    label: 'New support ticket (to our team)',
    when: 'Someone opens a support ticket (support intake inbox).',
    audience: 'staff',
    canDisable: true,
    buttonLink: 'link.admin',
    fields: [
      TICKET_NUMBER,
      TICKET_SUBJECT,
      { name: 'ticket.contact_name', label: 'Customer name', example: 'Anna de Vries' },
      { name: 'ticket.contact_email', label: 'Customer e-mail', example: 'anna@utrecht-bio.nl' },
      { name: 'ticket.category', label: 'Topic (— when not chosen)', example: 'Shipping' },
      { name: 'ticket.message', label: 'What the customer wrote', example: 'The centrifuge arrived without its power cable.' },
      LINK_ADMIN,
    ],
    defaults: {
      en: {
        subject: 'New support ticket {{ticket.number}}: {{ticket.subject}}',
        body:
          'New support ticket **{{ticket.number}}** from **{{ticket.contact_name}}** <{{ticket.contact_email}}>.\n\n- Topic: {{ticket.category}}\n\n**{{ticket.subject}}**\n{{ticket.message}}',
        button: 'Open in admin',
      },
      nl: {
        subject: 'Nieuw supportticket {{ticket.number}}: {{ticket.subject}}',
        body:
          'Nieuw supportticket **{{ticket.number}}** van **{{ticket.contact_name}}** <{{ticket.contact_email}}>.\n\n- Onderwerp: {{ticket.category}}\n\n**{{ticket.subject}}**\n{{ticket.message}}',
        button: 'Openen in admin',
      },
    },
  },
  {
    key: 'staff_ticket_customer_reply',
    group: 'Support',
    label: 'Customer replied on a ticket (to our team)',
    when: 'A signed-in customer replies on their ticket (support intake inbox).',
    audience: 'staff',
    canDisable: true,
    buttonLink: 'link.admin',
    fields: [TICKET_NUMBER, TICKET_SUBJECT, ...REPLY_FIELDS, LINK_ADMIN],
    defaults: {
      en: {
        subject: '[{{ticket.number}}] Customer reply: {{ticket.subject}}',
        body: '{{reply.author}} replied to ticket **{{ticket.number}}**:\n\n{{reply.body}}',
        button: 'Open in admin',
      },
      nl: {
        subject: '[{{ticket.number}}] Reactie van de klant: {{ticket.subject}}',
        body: '{{reply.author}} heeft gereageerd op ticket **{{ticket.number}}**:\n\n{{reply.body}}',
        button: 'Openen in admin',
      },
    },
  },
  {
    key: 'staff_ticket_guest_reply',
    group: 'Support',
    label: 'Guest replied on a ticket (to our team)',
    when: 'A customer replies on a ticket through their private link (support intake inbox).',
    audience: 'staff',
    canDisable: true,
    buttonLink: 'link.admin',
    fields: [TICKET_NUMBER, TICKET_SUBJECT, ...REPLY_FIELDS, LINK_ADMIN],
    defaults: {
      en: {
        subject: '[{{ticket.number}}] Guest reply: {{ticket.subject}}',
        body: '{{reply.author}} ({{reply.author_email}}) replied to ticket **{{ticket.number}}**:\n\n{{reply.body}}',
        button: 'Open in admin',
      },
      nl: {
        subject: '[{{ticket.number}}] Reactie van een gast: {{ticket.subject}}',
        body: '{{reply.author}} ({{reply.author_email}}) heeft gereageerd op ticket **{{ticket.number}}**:\n\n{{reply.body}}',
        button: 'Openen in admin',
      },
    },
  },
  {
    key: 'staff_ticket_sla_breached',
    group: 'Support',
    label: 'Ticket overdue (SLA)',
    when: 'An assigned support ticket passes its reply deadline (sweep); goes to the assigned admin.',
    audience: 'staff',
    canDisable: true,
    buttonLink: 'link.admin',
    fields: [TICKET_NUMBER, TICKET_SUBJECT, ...SLA_FIELDS, LINK_ADMIN],
    defaults: {
      en: {
        subject: '[SLA] {{ticket.number}} overdue by {{sla.overdue_minutes}} min',
        body: '**{{sla.priority}}** ticket **{{ticket.number}}** has breached its SLA.\n\n{{ticket.subject}}',
        button: 'Open in admin',
      },
      nl: {
        subject: '[SLA] {{ticket.number}} {{sla.overdue_minutes}} min te laat',
        body: 'Ticket **{{ticket.number}}** (prioriteit **{{sla.priority}}**) heeft de SLA overschreden.\n\n{{ticket.subject}}',
        button: 'Openen in admin',
      },
    },
  },

  // ─── Orders ─────────────────────────────────────────────────────────────
  {
    key: 'staff_order_received',
    group: 'Orders & payments',
    label: 'New bank-transfer order (to our team)',
    when: 'A buyer places an order paid by bank transfer: our team sends the transfer details (support intake inbox).',
    audience: 'staff',
    canDisable: true,
    buttonLink: 'link.admin',
    fields: [
      { name: 'order.number', label: 'Order number', example: 'L2D-2026-7KQ2XF' },
      { name: 'buyer.name', label: 'Buyer name', example: 'Anna de Vries' },
      { name: 'buyer.email', label: 'Buyer e-mail', example: 'anna@utrecht-bio.nl' },
      { ...LINK_ADMIN, example: 'https://labtodate.com/admin/orders/clx7kq2xf0001' },
    ],
    defaults: {
      en: {
        subject: '[action] New order {{order.number}}: send bank transfer details',
        body:
          '{{buyer.name}} ({{buyer.email}}) placed order **{{order.number}}**. Send the bank transfer instructions (IBAN and reference) so the buyer can wire the payment for manual verification.',
        button: 'Open the order in admin',
      },
      nl: {
        subject: '[actie] Nieuwe bestelling {{order.number}}: stuur de bankgegevens',
        body:
          '{{buyer.name}} ({{buyer.email}}) heeft bestelling **{{order.number}}** geplaatst. Stuur de instructies voor de bankoverschrijving (IBAN en betalingskenmerk), zodat de koper kan betalen en wij de betaling handmatig kunnen controleren.',
        button: 'Bestelling openen in admin',
      },
    },
  },
  {
    key: 'staff_return_request',
    group: 'Orders & payments',
    label: 'Return request (to our team)',
    when: 'A buyer requests a return or refund from their order page (support intake inbox).',
    audience: 'staff',
    canDisable: true,
    fields: [
      { name: 'order.number', label: 'Order number', example: 'L2D-2026-7KQ2XF' },
      TICKET_NUMBER,
      { name: 'buyer.name', label: 'Buyer name', example: 'Anna de Vries' },
      { name: 'buyer.email', label: 'Buyer e-mail', example: 'anna@utrecht-bio.nl' },
      { name: 'return.reason', label: 'Reason (— when not given)', example: 'The rotor is cracked.' },
    ],
    defaults: {
      en: {
        subject: 'Return request {{ticket.number}}: order {{order.number}}',
        body: '{{buyer.name}} ({{buyer.email}}) requested a return/refund for order **{{order.number}}**.\n\n**Reason:** {{return.reason}}',
        button: '',
      },
      nl: {
        subject: 'Retourverzoek {{ticket.number}}: bestelling {{order.number}}',
        body: '{{buyer.name}} ({{buyer.email}}) heeft een retour/terugbetaling aangevraagd voor bestelling **{{order.number}}**.\n\n**Reden:** {{return.reason}}',
        button: '',
      },
    },
  },

  // ─── Selling to us ──────────────────────────────────────────────────────
  {
    key: 'staff_sell_submission',
    group: 'Selling to us',
    label: 'New equipment offer (to our team)',
    when: 'Someone offers equipment through "Sell to us" (sell intake inbox).',
    audience: 'staff',
    canDisable: true,
    buttonLink: 'link.admin',
    fields: [
      { name: 'submission.number', label: 'Submission reference', example: 'clx7ihdy5j0001' },
      { name: 'submission.item', label: 'Item offered', example: 'Thermo Fisher Orbitrap Exploris 240' },
      { name: 'submission.seller_type', label: 'Seller type', example: 'COMPANY' },
      { name: 'seller.name', label: 'Seller name', example: 'Anna de Vries' },
      { name: 'seller.email', label: 'Seller e-mail', example: 'anna@utrecht-bio.nl' },
      { name: 'seller.phone', label: 'Phone (— when not given)', example: '+31 30 123 4567' },
      { name: 'seller.company', label: 'Company (— when not given)', example: 'Utrecht Bioanalytics B.V.' },
      { name: 'seller.country', label: 'Country (— when not given)', example: 'Netherlands' },
      { name: 'submission.brand_model', label: 'Brand / model', example: 'Thermo Fisher Exploris 240' },
      { name: 'submission.category', label: 'Category', example: 'Mass spectrometry' },
      { name: 'submission.condition', label: 'Condition', example: 'USED' },
      { name: 'submission.year', label: 'Year made', example: '2019' },
      { name: 'submission.quantity', label: 'Quantity', example: '1' },
      { name: 'submission.asking_price', label: 'Asking price', example: 'Open to offers' },
      { name: 'submission.location', label: 'Location', example: 'Leiden, NL' },
      { name: 'submission.description', label: 'Description', example: 'Fully serviced in 2025, all modules working.' },
      { name: 'submission.accessories', label: 'Accessories / extras (— when not given)', example: 'Nitrogen generator, spare source' },
      { name: 'submission.reason', label: 'Reason for selling (— when not given)', example: 'Lab relocation' },
      { name: 'submission.availability', label: 'Availability (— when not given)', example: 'From January' },
      { name: 'submission.photos_url', label: 'Link to photos (— when not given)', example: 'https://drive.example.com/photos' },
      { ...LINK_ADMIN, example: 'https://labtodate.com/admin/sell/clx7ihdy5j0001' },
    ],
    defaults: {
      en: {
        subject: 'New sell submission: {{submission.item}} ({{submission.seller_type}})',
        body:
          'New equipment submission from **{{seller.name}}** <{{seller.email}}>.\n\n- Phone: {{seller.phone}}\n- Company: {{seller.company}}\n- Country: {{seller.country}}\n\n- Item: {{submission.item}}\n- Brand / model: {{submission.brand_model}}\n- Category: {{submission.category}}\n- Condition: {{submission.condition}}\n- Year: {{submission.year}}\n- Quantity: {{submission.quantity}}\n- Asking price: {{submission.asking_price}}\n- Location: {{submission.location}}\n\n**Description:**\n{{submission.description}}\n\n- Accessories / extras: {{submission.accessories}}\n- Reason for selling: {{submission.reason}}\n- Availability: {{submission.availability}}\n- Photos: {{submission.photos_url}}\n\nReference: {{submission.number}}',
        button: 'Open in admin',
      },
      nl: {
        subject: 'Nieuw aanbod: {{submission.item}} ({{submission.seller_type}})',
        body:
          'Nieuw aanbod van apparatuur van **{{seller.name}}** <{{seller.email}}>.\n\n- Telefoon: {{seller.phone}}\n- Bedrijf: {{seller.company}}\n- Land: {{seller.country}}\n\n- Artikel: {{submission.item}}\n- Merk / model: {{submission.brand_model}}\n- Categorie: {{submission.category}}\n- Staat: {{submission.condition}}\n- Bouwjaar: {{submission.year}}\n- Aantal: {{submission.quantity}}\n- Vraagprijs: {{submission.asking_price}}\n- Locatie: {{submission.location}}\n\n**Omschrijving:**\n{{submission.description}}\n\n- Accessoires / extra’s: {{submission.accessories}}\n- Reden van verkoop: {{submission.reason}}\n- Beschikbaarheid: {{submission.availability}}\n- Foto’s: {{submission.photos_url}}\n\nReferentie: {{submission.number}}',
        button: 'Openen in admin',
      },
    },
  },
];
