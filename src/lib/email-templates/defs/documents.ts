import type { EmailDef } from '../types';

/**
 * E-mails that carry an issued document (quote, invoice, receipt) or follow
 * the payment of an order.
 */
export const DOCUMENT_EMAILS: EmailDef[] = [
  {
    key: 'quote_sent',
    group: 'Quotes',
    label: 'Quote sent (offer to accept)',
    when: 'An admin sends a quote with a price. The buyer accepts or declines it on the quote page; nothing is ordered before that.',
    audience: 'customer',
    canDisable: false,
    attachments: 'Quote PDF',
    buttonLink: 'link.quote',
    fields: [
      { name: 'quote.number', label: 'Quote number', example: 'PRO-2026-0007' },
      { name: 'quote.item', label: 'Main item', example: 'Agilent 1260 Infinity II pump' },
      { name: 'quote.total', label: 'Total incl. VAT', example: '€ 14,452.00' },
      { name: 'quote.valid_until', label: 'Valid until', example: '19 November 2026' },
      { name: 'payment.instructions', label: 'Payment instructions (IBAN, reference)', example: 'IBAN NL00 BANK 0123 4567 89 · reference PRO-2026-0007' },
      { name: 'link.quote', label: 'Link to the offer (accept / decline)', example: 'https://labtodate.com/app/quotes/cm123' },
    ],
    defaults: {
      en: {
        subject: 'Your offer {{quote.number}} from {{site.name}}',
        body:
          'Dear {{customer.name}},\n\nThank you for your request. Our offer **{{quote.number}}** for {{quote.item}} is attached to this e-mail as a PDF.\n\n**Total: {{quote.total}}**, valid until {{quote.valid_until}}.\n\nPlease review the offer and **accept or decline it** in your account. Nothing is ordered until you accept. After you accept, we open your purchase workspace for the delivery details and the payment.\n\n**Payment instructions (after you accept)**\n{{payment.instructions}}\n\nIf you have any questions or need a different format (for example for your purchase order), simply reply to this e-mail.\n\nKind regards,\n{{company.name}}',
        button: 'Review the offer',
      },
      nl: {
        subject: 'Uw offerte {{quote.number}} van {{site.name}}',
        body:
          'Geachte {{customer.name}},\n\nHartelijk dank voor uw aanvraag. Onze offerte **{{quote.number}}** voor {{quote.item}} vindt u als pdf in de bijlage.\n\n**Totaal: {{quote.total}}**, geldig tot en met {{quote.valid_until}}.\n\nBekijk de offerte en **accepteer of weiger deze** in uw account. Er wordt niets besteld totdat u accepteert. Na uw akkoord openen wij uw aankooppagina voor het afleveradres en de betaling.\n\n**Betaalgegevens (na uw akkoord)**\n{{payment.instructions}}\n\nHeeft u vragen of een ander formaat nodig (bijvoorbeeld voor uw inkooporder)? Beantwoord dan gewoon deze e-mail.\n\nMet vriendelijke groet,\n{{company.name}}',
        button: 'Offerte bekijken',
      },
    },
  },
  {
    key: 'quote_updated',
    group: 'Quotes',
    label: 'Quote re-issued on an accepted order',
    when: 'An admin re-sends a quote after the buyer already accepted it and the order is still unpaid. The order is updated to the new amounts.',
    audience: 'customer',
    canDisable: false,
    attachments: 'Quote PDF',
    buttonLink: 'link.order',
    fields: [
      { name: 'quote.number', label: 'Quote number', example: 'PRO-2026-0007' },
      { name: 'quote.item', label: 'Main item', example: 'Agilent 1260 Infinity II pump' },
      { name: 'quote.total', label: 'Total incl. VAT', example: '€ 14,452.00' },
      { name: 'quote.valid_until', label: 'Valid until', example: '19 November 2026' },
      { name: 'order.number', label: 'Order number', example: 'L2D-2026-7KQ2XF' },
      { name: 'payment.instructions', label: 'Payment instructions (IBAN, reference)', example: 'IBAN NL00 BANK 0123 4567 89 · reference PRO-2026-0007' },
      { name: 'link.order', label: 'Link to the purchase page', example: 'https://labtodate.com/app/orders/L2D-2026-7KQ2XF/payment' },
    ],
    defaults: {
      en: {
        subject: 'Updated offer {{quote.number}} for order {{order.number}}',
        body:
          'Dear {{customer.name}},\n\nWe have updated offer **{{quote.number}}** for {{quote.item}} on your order {{order.number}}. The new version is attached as a PDF.\n\n**Total: {{quote.total}}**, valid until {{quote.valid_until}}.\n\nComplete your purchase in your workspace: delivery details and your payment proof.\n\n{{payment.instructions}}\n\nKind regards,\n{{company.name}}',
        button: 'Complete your purchase',
      },
      nl: {
        subject: 'Bijgewerkte offerte {{quote.number}} voor bestelling {{order.number}}',
        body:
          'Geachte {{customer.name}},\n\nWij hebben offerte **{{quote.number}}** voor {{quote.item}} bij uw bestelling {{order.number}} bijgewerkt. De nieuwe versie vindt u als pdf in de bijlage.\n\n**Totaal: {{quote.total}}**, geldig tot en met {{quote.valid_until}}.\n\nRond uw aankoop af op uw aankooppagina: afleveradres en betaalbewijs.\n\n{{payment.instructions}}\n\nMet vriendelijke groet,\n{{company.name}}',
        button: 'Bestelling afronden',
      },
    },
  },
  {
    key: 'order_confirmed',
    group: 'Orders & payments',
    label: 'Offer accepted: order confirmed',
    when: 'The buyer accepts an offer on the quote page; the order is created at that moment.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.order',
    fields: [
      { name: 'quote.number', label: 'Quote number', example: 'PRO-2026-0007' },
      { name: 'quote.item', label: 'Main item', example: 'Agilent 1260 Infinity II pump' },
      { name: 'order.number', label: 'Order number', example: 'L2D-2026-7KQ2XF' },
      { name: 'order.total', label: 'Total incl. VAT', example: '€ 14,452.00' },
      { name: 'rules.payment_verify_time', label: 'How fast we check a payment', example: '1 business day' },
      { name: 'link.order', label: 'Link to the purchase page', example: 'https://labtodate.com/app/orders/L2D-2026-7KQ2XF/payment' },
    ],
    defaults: {
      en: {
        subject: 'Order {{order.number}} confirmed — next: payment',
        body:
          'Dear {{customer.name}},\n\nThank you — you accepted offer **{{quote.number}}** for {{quote.item}}. Your order number is **{{order.number}}** ({{order.total}}).\n\nNext: open your purchase workspace, confirm the delivery address and upload your bank-transfer receipt. We check it within {{rules.payment_verify_time}} and then ship.\n\nKind regards,\n{{company.name}}',
        button: 'Complete your purchase',
      },
      nl: {
        subject: 'Bestelling {{order.number}} bevestigd — volgende stap: betaling',
        body:
          'Geachte {{customer.name}},\n\nHartelijk dank — u heeft offerte **{{quote.number}}** voor {{quote.item}} geaccepteerd. Uw bestelnummer is **{{order.number}}** ({{order.total}}).\n\nVolgende stap: open uw aankooppagina, bevestig het afleveradres en upload uw betaalbewijs. Wij controleren dit binnen {{rules.payment_verify_time}} en verzenden daarna.\n\nMet vriendelijke groet,\n{{company.name}}',
        button: 'Bestelling afronden',
      },
    },
  },
  {
    key: 'payment_received',
    group: 'Orders & payments',
    label: 'Payment received (invoice + receipt)',
    when: 'A payment is verified or an order is marked paid. The invoice (and the receipt, if switched on) is attached.',
    audience: 'customer',
    canDisable: false,
    attachments: 'Invoice PDF, receipt PDF',
    buttonLink: 'link.order',
    fields: [
      { name: 'order.number', label: 'Order number', example: 'L2D-2026-7KQ2XF' },
      { name: 'invoice.number', label: 'Invoice number', example: 'INV-2026-00012' },
      { name: 'order.total', label: 'Amount paid', example: '€ 14,452.00' },
      { name: 'payment.date', label: 'Payment date', example: '6 November 2026' },
      { name: 'link.order', label: 'Link to the order', example: 'https://labtodate.com/app/orders/L2D-2026-7KQ2XF' },
    ],
    defaults: {
      en: {
        subject: 'Payment received: invoice {{invoice.number}} for order {{order.number}}',
        body:
          'Dear {{customer.name}},\n\nWe have received your payment of **{{order.total}}** for order {{order.number}}. Thank you.\n\nYour invoice **{{invoice.number}}** is attached to this e-mail. We are now preparing your order for shipping and will let you know as soon as it is on its way.\n\nKind regards,\n{{company.name}}',
        button: 'View your order',
      },
      nl: {
        subject: 'Betaling ontvangen: factuur {{invoice.number}} voor bestelling {{order.number}}',
        body:
          'Geachte {{customer.name}},\n\nWij hebben uw betaling van **{{order.total}}** voor bestelling {{order.number}} ontvangen. Hartelijk dank.\n\nUw factuur **{{invoice.number}}** vindt u in de bijlage. Wij maken uw bestelling nu klaar voor verzending en laten u weten zodra deze onderweg is.\n\nMet vriendelijke groet,\n{{company.name}}',
        button: 'Bekijk uw bestelling',
      },
    },
  },
  {
    key: 'document_copy',
    group: 'Orders & payments',
    label: 'Billing copy of a document',
    when: 'A copy of every issued quote, invoice and receipt goes to the billing address (Documents → General).',
    audience: 'staff',
    canDisable: true,
    attachments: 'The issued document',
    fields: [
      { name: 'document.title', label: 'Document type', example: 'Invoice' },
      { name: 'document.number', label: 'Document number', example: 'INV-2026-00012' },
      { name: 'document.customer', label: 'Customer', example: 'Utrecht Bioanalytics B.V.' },
      { name: 'document.total', label: 'Total', example: '€ 14,452.00' },
    ],
    defaults: {
      en: {
        subject: '[copy] {{document.title}} {{document.number}}: {{document.customer}}',
        body: 'Copy for the administration: {{document.title}} **{{document.number}}** for {{document.customer}}, total {{document.total}}. The PDF is attached.',
        button: '',
      },
      nl: {
        subject: '[kopie] {{document.title}} {{document.number}}: {{document.customer}}',
        body: 'Kopie voor de administratie: {{document.title}} **{{document.number}}** voor {{document.customer}}, totaal {{document.total}}. De pdf is bijgevoegd.',
        button: '',
      },
    },
  },
];
