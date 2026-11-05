import type { EmailDef } from '../types';

/**
 * "Sell to us" e-mails to the person offering equipment (lib/sell/actions.ts):
 * the acknowledgement, chat replies and every step of the acquisition.
 */

const SUB_REF = { name: 'submission.number', label: 'Offer reference', example: 'SS-IHDY5J' };
const SUB_ITEM = { name: 'submission.item', label: 'Item offered', example: 'Thermo Fisher Orbitrap Exploris 240' };
const LINK_SUB = { name: 'link.submission', label: 'Link to the offer in the dashboard', example: 'https://labtodate.com/app/sell-submissions/clx7ihdy5j0001' };
const AMOUNT = { name: 'offer.amount', label: 'Offered amount', example: '18,500 EUR' };

const SUMMARY_FIELDS = [
  { name: 'submission.brand_model', label: 'Brand / model (— when not given)', example: 'Thermo Fisher Exploris 240' },
  { name: 'submission.category', label: 'Category (— when not given)', example: 'Mass spectrometry' },
  { name: 'submission.condition', label: 'Condition', example: 'USED' },
  { name: 'submission.year', label: 'Year made (— when not given)', example: '2019' },
  { name: 'submission.quantity', label: 'Quantity', example: '1' },
  { name: 'submission.asking_price', label: 'Asking price (— when not given)', example: '€ 20,000' },
  { name: 'submission.location', label: 'Location (— when not given)', example: 'Leiden, NL' },
];

const SUMMARY_EN =
  '- Item: {{submission.item}}\n- Brand / model: {{submission.brand_model}}\n- Category: {{submission.category}}\n- Condition: {{submission.condition}}\n- Year: {{submission.year}}\n- Quantity: {{submission.quantity}}\n- Asking price: {{submission.asking_price}}\n- Location: {{submission.location}}';
const SUMMARY_NL =
  '- Artikel: {{submission.item}}\n- Merk / model: {{submission.brand_model}}\n- Categorie: {{submission.category}}\n- Staat: {{submission.condition}}\n- Bouwjaar: {{submission.year}}\n- Aantal: {{submission.quantity}}\n- Vraagprijs: {{submission.asking_price}}\n- Locatie: {{submission.location}}';

const REVIEW_EN = 'Our acquisitions team will review your submission and reply within **2 business days** with a valuation and next steps.';
const REVIEW_NL = 'Ons inkoopteam beoordeelt uw aanbod en reageert binnen **2 werkdagen** met een waardebepaling en de volgende stappen.';

export const SELL_EMAILS: EmailDef[] = [
  {
    key: 'sell_submission_received',
    group: 'Selling to us',
    label: 'Equipment offer received',
    when: 'A signed-in user offers equipment with their own address; the summary of the offer is repeated.',
    audience: 'seller',
    canDisable: true,
    fields: [{ ...SUB_REF, label: 'Submission reference', example: 'clx7ihdy5j0001' }, SUB_ITEM, ...SUMMARY_FIELDS],
    defaults: {
      en: {
        subject: 'We received your equipment submission: {{submission.item}}',
        body: `Dear {{customer.name}},\n\nThank you, we’ve got it. ${REVIEW_EN}\n\n${SUMMARY_EN}\n\nReference: {{submission.number}}`,
        button: '',
      },
      nl: {
        subject: 'Wij hebben uw aanbod ontvangen: {{submission.item}}',
        body: `Geachte {{customer.name}},\n\nHartelijk dank, wij hebben uw aanbod ontvangen. ${REVIEW_NL}\n\n${SUMMARY_NL}\n\nReferentie: {{submission.number}}`,
        button: '',
      },
    },
  },
  {
    key: 'sell_submission_received_generic',
    group: 'Selling to us',
    label: 'Equipment offer received (no details)',
    when: 'Equipment is offered by a guest, or with an address other than the account’s; the offer itself is not repeated.',
    audience: 'seller',
    canDisable: true,
    fields: [{ ...SUB_REF, label: 'Submission reference', example: 'clx7ihdy5j0001' }],
    defaults: {
      en: {
        subject: 'We received your equipment submission',
        body: `Thank you, we’ve got it. ${REVIEW_EN}\n\nIf you didn’t offer equipment to {{site.name}}, you can ignore this e-mail.\n\nReference: {{submission.number}}`,
        button: '',
      },
      nl: {
        subject: 'Wij hebben uw aanbod ontvangen',
        body: `Hartelijk dank, wij hebben uw aanbod ontvangen. ${REVIEW_NL}\n\nHeeft u geen apparatuur aangeboden aan {{site.name}}? Dan kunt u deze e-mail negeren.\n\nReferentie: {{submission.number}}`,
        button: '',
      },
    },
  },
  {
    key: 'sell_reply',
    subjectMustKeep: ['submission.number'],
    group: 'Selling to us',
    label: 'New reply on an equipment offer',
    when: 'Our acquisitions team replies in the offer chat. At most one e-mail per offer every couple of hours (Settings → e-mail throttle).',
    audience: 'seller',
    canDisable: true,
    buttonLink: 'link.submission',
    fields: [
      { ...SUB_REF, label: 'Offer reference (keep it in the subject: the throttle looks for it)' },
      SUB_ITEM,
      LINK_SUB,
    ],
    defaults: {
      en: {
        subject: '[{{submission.number}}] New reply on your equipment offer "{{submission.item}}"',
        body:
          'Dear {{customer.name}},\n\nOur acquisitions team replied on your equipment offer **{{submission.item}}**.\n\nWe send at most one of these e-mails every couple of hours while we are actively chatting. Check your dashboard for newer replies.',
        button: 'Open the conversation',
      },
      nl: {
        subject: '[{{submission.number}}] Nieuwe reactie op uw aanbod "{{submission.item}}"',
        body:
          'Geachte {{customer.name}},\n\nOns inkoopteam heeft gereageerd op uw aanbod **{{submission.item}}**.\n\nZolang wij actief met u in gesprek zijn, sturen wij hooguit eens per paar uur zo’n e-mail. Nieuwere reacties vindt u in uw dashboard.',
        button: 'Gesprek openen',
      },
    },
  },
  {
    key: 'sell_price_offer',
    group: 'Selling to us',
    label: 'Price offer',
    when: 'Our acquisitions team proposes a price for the offered equipment.',
    audience: 'seller',
    canDisable: false,
    buttonLink: 'link.submission',
    fields: [
      SUB_REF,
      SUB_ITEM,
      AMOUNT,
      { name: 'offer.note', label: 'Note with the offer (may be empty)', example: 'Includes pickup from your lab.' },
      LINK_SUB,
    ],
    defaults: {
      en: {
        subject: '[{{submission.number}}] We proposed {{offer.amount}} for "{{submission.item}}"',
        body:
          'Dear {{customer.name}},\n\nWe’ve put a price on your equipment offer:\n**{{offer.amount}}**\n\n{{offer.note}}\n\nOpen the offer in your dashboard to accept or counter.',
        button: 'Open the offer',
      },
      nl: {
        subject: '[{{submission.number}}] Ons bod van {{offer.amount}} voor "{{submission.item}}"',
        body:
          'Geachte {{customer.name}},\n\nWij hebben een prijs voor uw aanbod bepaald:\n**{{offer.amount}}**\n\n{{offer.note}}\n\nOpen het bod in uw dashboard om het te accepteren of een tegenbod te doen.',
        button: 'Bod openen',
      },
    },
  },
  {
    key: 'sell_offer_accepted',
    group: 'Selling to us',
    label: 'Offer accepted (add bank details)',
    when: 'Our acquisitions team accepts the offer at an agreed price; the seller is asked for their bank details.',
    audience: 'seller',
    canDisable: false,
    buttonLink: 'link.submission',
    fields: [
      SUB_REF,
      SUB_ITEM,
      { ...AMOUNT, label: 'Agreed price' },
      { name: 'submission.email', label: 'Address the offer was made with', example: 'anna@utrecht-bio.nl' },
      LINK_SUB,
    ],
    defaults: {
      en: {
        subject: '[{{submission.number}}] We accepted your offer at {{offer.amount}}',
        body:
          'Dear {{customer.name}},\n\nGood news: we’ll buy **{{submission.item}}** for **{{offer.amount}}**.\n\nNext step: add your bank details so we know where to wire the payout. Then we’ll send you the shipping instructions.\n\nTo use the dashboard, sign in (or create an account) with {{submission.email}}.',
        button: 'Add your bank details',
      },
      nl: {
        subject: '[{{submission.number}}] Wij hebben uw aanbod geaccepteerd voor {{offer.amount}}',
        body:
          'Geachte {{customer.name}},\n\nGoed nieuws: wij kopen **{{submission.item}}** voor **{{offer.amount}}**.\n\nVolgende stap: vul uw bankgegevens in, zodat wij weten waar wij de uitbetaling naartoe kunnen overmaken. Daarna sturen wij u de verzendinstructies.\n\nOm het dashboard te gebruiken, logt u in (of maakt u een account aan) met {{submission.email}}.',
        button: 'Bankgegevens invullen',
      },
    },
  },
  {
    key: 'sell_offer_declined',
    group: 'Selling to us',
    label: 'Offer declined',
    when: 'Our acquisitions team declines the offered equipment.',
    audience: 'seller',
    canDisable: true,
    buttonLink: 'link.submission',
    fields: [SUB_REF, SUB_ITEM, LINK_SUB],
    defaults: {
      en: {
        subject: '[{{submission.number}}] About your equipment offer',
        body:
          'Dear {{customer.name}},\n\nThank you for offering us **{{submission.item}}**. After reviewing it, we can’t make an offer this time.\n\nYou’re welcome to submit other equipment any time.',
        button: '',
      },
      nl: {
        subject: '[{{submission.number}}] Over uw aanbod',
        body:
          'Geachte {{customer.name}},\n\nHartelijk dank dat u ons **{{submission.item}}** heeft aangeboden. Na beoordeling kunnen wij u deze keer helaas geen bod doen.\n\nU bent van harte welkom om op elk moment andere apparatuur aan te bieden.',
        button: '',
      },
    },
  },
  {
    key: 'sell_item_received',
    group: 'Selling to us',
    label: 'Equipment received',
    when: 'An admin marks the shipped equipment as received at the warehouse; inspection starts.',
    audience: 'seller',
    canDisable: true,
    buttonLink: 'link.submission',
    fields: [SUB_REF, SUB_ITEM, LINK_SUB],
    defaults: {
      en: {
        subject: '[{{submission.number}}] We received "{{submission.item}}": inspection started',
        body:
          'Dear {{customer.name}},\n\nYour equipment for offer **{{submission.number}}** arrived at our warehouse and is now being inspected.\n\nOnce it passes inspection, we wire the payment to the bank details on file and e-mail you the transfer receipt.',
        button: 'Track the status',
      },
      nl: {
        subject: '[{{submission.number}}] Wij hebben "{{submission.item}}" ontvangen: inspectie gestart',
        body:
          'Geachte {{customer.name}},\n\nUw apparatuur voor aanbod **{{submission.number}}** is aangekomen in ons magazijn en wordt nu geïnspecteerd.\n\nZodra de inspectie is afgerond, maken wij de betaling over naar de bij ons bekende bankgegevens en sturen wij u het betalingsbewijs per e-mail.',
        button: 'Status volgen',
      },
    },
  },
  {
    key: 'sell_payment_sent',
    group: 'Selling to us',
    label: 'Payment wired (acquisition complete)',
    when: 'An admin completes the acquisition and uploads the transfer receipt.',
    audience: 'seller',
    canDisable: true,
    buttonLink: 'link.submission',
    fields: [SUB_REF, SUB_ITEM, { name: 'payout.amount', label: 'Amount paid', example: '18,500 EUR' }, LINK_SUB],
    defaults: {
      en: {
        subject: '[{{submission.number}}] Payment wired: acquisition complete',
        body:
          'Dear {{customer.name}},\n\nWe’ve wired **{{payout.amount}}** to your bank for offer **{{submission.number}}**.\n\nOpen your dashboard to download the transfer receipt.\n\nThank you for selling through {{site.name}}. The instrument is going to a new home.',
        button: 'Open dashboard',
      },
      nl: {
        subject: '[{{submission.number}}] Betaling overgemaakt: aankoop afgerond',
        body:
          'Geachte {{customer.name}},\n\nWij hebben **{{payout.amount}}** naar uw bankrekening overgemaakt voor aanbod **{{submission.number}}**.\n\nOpen uw dashboard om het betalingsbewijs te downloaden.\n\nHartelijk dank voor uw verkoop via {{site.name}}. Het instrument krijgt een nieuw thuis.',
        button: 'Dashboard openen',
      },
    },
  },
];
