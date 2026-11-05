import { ACCOUNT_EMAILS } from './defs/account';
import { DOCUMENT_EMAILS } from './defs/documents';
import { MESSAGE_EMAILS } from './defs/messages';
import { ORDER_EMAILS } from './defs/orders';
import { QUOTE_EMAILS } from './defs/quotes';
import { SELL_EMAILS } from './defs/sell';
import { STAFF_EMAILS } from './defs/staff';
import { SUPPORT_EMAILS } from './defs/support';
import { COMMON_EMAIL_FIELDS, type EmailDef } from './types';

/**
 * Every e-mail the site sends to customers, sellers or staff, with its
 * built-in EN/NL texts. Admin → Documents → E-mails edits them; the code
 * only decides WHEN an e-mail goes out and fills its fields.
 *
 * To add an e-mail: add its definition to a file in ./defs, list that file
 * here, and send it with sendTemplatedEmail({ key, … }).
 */
export const EMAIL_DEFS: EmailDef[] = [
  ...DOCUMENT_EMAILS,
  ...QUOTE_EMAILS,
  ...ORDER_EMAILS,
  ...SUPPORT_EMAILS,
  ...SELL_EMAILS,
  ...ACCOUNT_EMAILS,
  ...MESSAGE_EMAILS,
  ...STAFF_EMAILS,
];

const BY_KEY = new Map(EMAIL_DEFS.map((d) => [d.key, d]));

export function emailDef(key: string): EmailDef {
  const d = BY_KEY.get(key);
  if (!d) throw new Error(`Unknown e-mail template "${key}"`);
  return d;
}

export function allowedEmailFields(def: EmailDef): string[] {
  return [...COMMON_EMAIL_FIELDS.map((f) => f.name), ...def.fields.map((f) => f.name)];
}

export const EMAIL_KEY = {
  texts: (key: string, lang: string) => `email:${key}:${lang}`,
  options: (key: string) => `email:${key}:options`,
  layout: 'email:layout',
};
