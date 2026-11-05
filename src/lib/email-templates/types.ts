import type { Lang } from '@/lib/documents/types';

export type EmailGroup = 'Quotes' | 'Orders & payments' | 'Support' | 'Selling to us' | 'Account & security' | 'Messages';

export interface EmailTexts {
  subject: string;
  /** Rich text (see lib/cms/text): {{fields}}, **bold**, "- " lists, blank line = paragraph. */
  body: string;
  /** Button label; empty = no button. The link is fixed per e-mail. */
  button: string;
}

export interface EmailDef {
  key: string;
  group: EmailGroup;
  label: string;
  /** When it is sent, in one sentence (shown in the admin list). */
  when: string;
  audience: 'customer' | 'seller' | 'staff';
  /** Security e-mails (verification, password reset) cannot be switched off. */
  canDisable: boolean;
  /** Fields this e-mail may use (beyond COMMON_EMAIL_FIELDS). */
  fields: { name: string; label: string; example: string }[];
  /** Field holding the button's URL (always set by the code, never typed). */
  buttonLink?: string;
  /** Which documents are attached, for the admin list ("Quote PDF"). */
  attachments?: string;
  /** Fields the subject must keep (the reply throttle matches on them). */
  subjectMustKeep?: string[];
  defaults: Record<Lang, EmailTexts>;
}

export interface EmailOptions {
  enabled: boolean;
}

export const COMMON_EMAIL_FIELDS = [
  { name: 'customer.name', label: "Recipient's name", example: 'Anna de Vries' },
  { name: 'site.name', label: 'Site name', example: 'Labtodate' },
  { name: 'site.url', label: 'Site address', example: 'https://labtodate.com' },
  { name: 'company.name', label: 'Our legal name', example: 'Labtodate B.V.' },
  { name: 'support.email', label: 'Our support e-mail', example: 'support@labtodate.com' },
];
