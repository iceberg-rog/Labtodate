import type { EmailDef } from '../types';

/**
 * Order e-mails to the buyer (checkout, fulfilment, cancel, refund, payment
 * review, returns). "Payment received" with the invoice is in ./documents.ts.
 */

const ORDER_NUMBER = { name: 'order.number', label: 'Order number', example: 'L2D-2026-7KQ2XF' };
const LINK_ORDER = { name: 'link.order', label: 'Link to the order', example: 'https://labtodate.com/app/orders/L2D-2026-7KQ2XF' };

export const ORDER_EMAILS: EmailDef[] = [
  {
    key: 'order_received',
    group: 'Orders & payments',
    label: 'Order received (bank transfer)',
    when: 'A buyer places an order that is paid by bank transfer; nothing has been charged yet.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.payment',
    fields: [
      ORDER_NUMBER,
      { name: 'order.items', label: 'Order contents (one line per item)', example: 'Agilent 1260 Infinity II pump × 1\nEppendorf 5430 R centrifuge × 2' },
      { name: 'link.payment', label: 'Link to the payment page', example: 'https://labtodate.com/app/orders/L2D-2026-7KQ2XF/payment' },
      LINK_ORDER,
    ],
    defaults: {
      en: {
        subject: 'Order {{order.number}} received: bank transfer details to follow',
        body:
          'Dear {{customer.name}},\n\nWe have received your order **{{order.number}}**. **No charge has been taken.** Payment for this order is by bank transfer, manually verified by our team.\n\n**Next steps:**\n- Our team will e-mail you our bank transfer details (IBAN, reference) within one business day.\n- Send the transfer for the full order amount, quoting the reference.\n- Upload the bank receipt on your order payment page once the transfer is sent.\n- We verify the transfer and dispatch the order.\n\n**Order contents:**\n{{order.items}}\n\nYou can track everything on your order page: {{link.order}}',
        button: 'Pay & upload receipt',
      },
      nl: {
        subject: 'Bestelling {{order.number}} ontvangen: gegevens voor de bankoverschrijving volgen',
        body:
          'Geachte {{customer.name}},\n\nWij hebben uw bestelling **{{order.number}}** ontvangen. **Er is nog niets in rekening gebracht.** U betaalt deze bestelling per bankoverschrijving; ons team controleert de betaling handmatig.\n\n**Volgende stappen:**\n- Ons team stuurt u binnen één werkdag onze bankgegevens (IBAN en betalingskenmerk) per e-mail.\n- Maak het volledige bedrag van de bestelling over en vermeld daarbij het betalingskenmerk.\n- Upload het betalingsbewijs op de betaalpagina van uw bestelling zodra de overschrijving is verstuurd.\n- Wij controleren de betaling en verzenden uw bestelling.\n\n**Inhoud van de bestelling:**\n{{order.items}}\n\nU kunt alles volgen op de pagina van uw bestelling: {{link.order}}',
        button: 'Betalen en bewijs uploaden',
      },
    },
  },
  {
    key: 'payment_rejected',
    group: 'Orders & payments',
    label: 'Payment sent back (action needed)',
    when: 'An admin sends an order awaiting payment back to the buyer with a reason (for example an unreadable receipt).',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.payment',
    fields: [
      ORDER_NUMBER,
      { name: 'payment.rejection_reason', label: 'Reason given by the admin', example: 'The receipt does not show the transfer reference.' },
      { name: 'link.payment', label: 'Link to the payment page', example: 'https://labtodate.com/app/orders/L2D-2026-7KQ2XF/payment' },
    ],
    defaults: {
      en: {
        subject: 'Action needed: order {{order.number}}',
        body:
          'Dear {{customer.name}},\n\nWe reviewed the receipt for order **{{order.number}}** and need a corrected proof:\n\n{{payment.rejection_reason}}\n\nYou can resubmit your receipt on your payment page.',
        button: 'Resubmit your receipt',
      },
      nl: {
        subject: 'Actie vereist: bestelling {{order.number}}',
        body:
          'Geachte {{customer.name}},\n\nWij hebben het betalingsbewijs voor bestelling **{{order.number}}** bekeken en hebben een gecorrigeerd bewijs nodig:\n\n{{payment.rejection_reason}}\n\nU kunt uw betalingsbewijs opnieuw uploaden op uw betaalpagina.',
        button: 'Bewijs opnieuw uploaden',
      },
    },
  },
  {
    key: 'order_canceled',
    group: 'Orders & payments',
    label: 'Order canceled',
    when: 'An admin cancels an order before it was paid.',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.order',
    fields: [ORDER_NUMBER, LINK_ORDER],
    defaults: {
      en: {
        subject: 'Order {{order.number}} canceled',
        body: 'Your order **{{order.number}}** was canceled before payment. No charge was made.',
        button: 'View order {{order.number}}',
      },
      nl: {
        subject: 'Bestelling {{order.number}} geannuleerd',
        body: 'Uw bestelling **{{order.number}}** is geannuleerd voordat er werd betaald. Er is niets in rekening gebracht.',
        button: 'Bestelling {{order.number}} bekijken',
      },
    },
  },
  {
    key: 'order_shipped',
    group: 'Orders & payments',
    label: 'Order shipped',
    when: 'An admin marks an order as shipped.',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.order',
    fields: [
      ORDER_NUMBER,
      { name: 'shipping.carrier', label: 'Carrier (— when not set)', example: 'DHL Express' },
      { name: 'shipping.tracking', label: 'Tracking number (— when not set)', example: 'JD014600006281234567' },
      LINK_ORDER,
    ],
    defaults: {
      en: {
        subject: 'Your order {{order.number}} has shipped',
        body:
          'Dear {{customer.name}},\n\nYour order **{{order.number}}** is on its way.\n\n- Carrier: {{shipping.carrier}}\n- Tracking number: {{shipping.tracking}}\n\nYou can follow it in your account.',
        button: 'Track your order',
      },
      nl: {
        subject: 'Uw bestelling {{order.number}} is verzonden',
        body:
          'Geachte {{customer.name}},\n\nUw bestelling **{{order.number}}** is onderweg.\n\n- Vervoerder: {{shipping.carrier}}\n- Trackingnummer: {{shipping.tracking}}\n\nU kunt de zending volgen in uw account.',
        button: 'Bestelling volgen',
      },
    },
  },
  {
    key: 'order_delivered',
    group: 'Orders & payments',
    label: 'Order delivered',
    when: 'An admin marks an order as delivered.',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.order',
    fields: [ORDER_NUMBER, LINK_ORDER],
    defaults: {
      en: {
        subject: 'Order {{order.number}} delivered',
        body: 'Your order **{{order.number}}** has been marked as delivered. If anything is wrong with it, contact us from your order page.',
        button: 'View order {{order.number}}',
      },
      nl: {
        subject: 'Bestelling {{order.number}} afgeleverd',
        body: 'Uw bestelling **{{order.number}}** is gemarkeerd als afgeleverd. Is er iets mis met de bestelling? Neem dan contact met ons op via de pagina van uw bestelling.',
        button: 'Bestelling {{order.number}} bekijken',
      },
    },
  },
  {
    key: 'order_refunded',
    group: 'Orders & payments',
    label: 'Refund issued',
    when: 'An admin refunds a paid order.',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.order',
    fields: [ORDER_NUMBER, LINK_ORDER],
    defaults: {
      en: {
        subject: 'Refund issued for order {{order.number}}',
        body: 'Dear {{customer.name}},\n\nA refund for order **{{order.number}}** has been processed. It may take a few business days to appear.',
        button: '',
      },
      nl: {
        subject: 'Terugbetaling voor bestelling {{order.number}}',
        body: 'Geachte {{customer.name}},\n\nDe terugbetaling voor bestelling **{{order.number}}** is verwerkt. Het kan enkele werkdagen duren voordat het bedrag zichtbaar is.',
        button: '',
      },
    },
  },
  {
    key: 'return_request_received',
    group: 'Orders & payments',
    label: 'Return request received',
    when: 'A buyer requests a return or refund from their order page (a support ticket is opened).',
    audience: 'customer',
    canDisable: true,
    buttonLink: 'link.order',
    fields: [ORDER_NUMBER, { name: 'ticket.number', label: 'Ticket reference', example: 'TKT-4F7Q2A' }, LINK_ORDER],
    defaults: {
      en: {
        subject: '[{{ticket.number}}] We received your return request',
        body: 'We have logged your return/refund request for order **{{order.number}}**. Our team will follow up by e-mail.\n\n**Reference:** {{ticket.number}}',
        button: '',
      },
      nl: {
        subject: '[{{ticket.number}}] Wij hebben uw retourverzoek ontvangen',
        body: 'Wij hebben uw verzoek tot retour/terugbetaling voor bestelling **{{order.number}}** geregistreerd. Ons team neemt per e-mail contact met u op.\n\n**Referentie:** {{ticket.number}}',
        button: '',
      },
    },
  },
];
