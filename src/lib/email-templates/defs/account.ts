import type { EmailDef } from '../types';

/**
 * Account and security e-mails (better-auth callbacks in lib/auth.ts). None
 * of them can be switched off: they carry the link or code the person needs
 * to get into their account.
 */

const REMOVES_PASSWORD_NOTE = {
  en: 'This address hasn’t been confirmed yet, so opening the link confirms it and, for your security, removes the password set on the account before then. After signing in, set a new one with “Forgot password” on the sign-in page.',
  nl: 'Dit adres is nog niet bevestigd. Door de link te openen bevestigt u het adres en wordt, voor uw veiligheid, het wachtwoord verwijderd dat eerder voor dit account was ingesteld. Stel na het inloggen een nieuw wachtwoord in via “Forgot password” op de inlogpagina.',
};

const VERIFY_FIELDS = [
  { name: 'link.verify', label: 'Confirmation link', example: 'https://labtodate.com/api/auth/verify-email?token=…' },
  { name: 'link.valid_minutes', label: 'Link valid for (minutes)', example: '60' },
];

const SIGN_IN_FIELDS = [
  { name: 'link.sign_in', label: 'Personal sign-in link', example: 'https://labtodate.com/api/auth/magic-link/verify?token=…' },
  { name: 'link.valid_minutes', label: 'Link valid for (minutes)', example: '10' },
];

export const ACCOUNT_EMAILS: EmailDef[] = [
  {
    key: 'password_changed',
    group: 'Account & security',
    label: 'Password changed',
    when: 'Right after someone resets the password of their account (all other sessions are signed out).',
    audience: 'customer',
    canDisable: false,
    fields: [
      { name: 'link.forgot_password', label: 'Link to "Forgot password"', example: 'https://labtodate.com/auth/forgot-password' },
    ],
    defaults: {
      en: {
        subject: 'Your {{site.name}} password was changed',
        body:
          'The password on your {{site.name}} account was just reset, and every device that was signed in has been signed out.\n\nIf this wasn’t you, reset your password again right away at {{link.forgot_password}} and contact support.',
        button: '',
      },
      nl: {
        subject: 'Uw wachtwoord voor {{site.name}} is gewijzigd',
        body:
          'Het wachtwoord van uw {{site.name}}-account is zojuist opnieuw ingesteld en alle apparaten die waren ingelogd, zijn afgemeld.\n\nWas u dit niet? Stel dan direct opnieuw een wachtwoord in via {{link.forgot_password}} en neem contact op met onze klantenservice.',
        button: '',
      },
    },
  },
  {
    key: 'password_reset',
    group: 'Account & security',
    label: 'Password reset link',
    when: 'Someone asks for a password reset on the "Forgot password" page (or an admin sends one).',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.reset',
    fields: [
      { name: 'link.reset', label: 'Reset link', example: 'https://labtodate.com/auth/reset-password?token=…' },
      { name: 'link.valid_minutes', label: 'Link valid for (minutes)', example: '60' },
    ],
    defaults: {
      en: {
        subject: 'Reset your {{site.name}} password',
        body:
          'Dear {{customer.name}},\n\nWe received a request to reset the password on your {{site.name}} account. Use the button below; the link expires in {{link.valid_minutes}} minutes.\n\nIf you didn’t request this, you can safely ignore this e-mail. Your password won’t change.',
        button: 'Reset password',
      },
      nl: {
        subject: 'Stel uw wachtwoord voor {{site.name}} opnieuw in',
        body:
          'Geachte {{customer.name}},\n\nWij hebben een verzoek ontvangen om het wachtwoord van uw {{site.name}}-account opnieuw in te stellen. Gebruik de knop hieronder; de link verloopt over {{link.valid_minutes}} minuten.\n\nHeeft u dit niet aangevraagd? Dan kunt u deze e-mail negeren. Uw wachtwoord blijft ongewijzigd.',
        button: 'Wachtwoord opnieuw instellen',
      },
    },
  },
  {
    key: 'verify_email',
    group: 'Account & security',
    label: 'Confirm e-mail address (link)',
    when: 'An e-mail address has to be confirmed with a link (for example after changing it).',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.verify',
    fields: VERIFY_FIELDS,
    defaults: {
      en: {
        subject: 'Verify your {{site.name}} e-mail address',
        body:
          'Dear {{customer.name}},\n\nClick the button below to confirm that this e-mail address belongs to you. The link expires in {{link.valid_minutes}} minutes.\n\nIf you didn’t request this, you can safely ignore this e-mail.',
        button: 'Verify my e-mail',
      },
      nl: {
        subject: 'Bevestig uw e-mailadres voor {{site.name}}',
        body:
          'Geachte {{customer.name}},\n\nKlik op de knop hieronder om te bevestigen dat dit e-mailadres van u is. De link verloopt over {{link.valid_minutes}} minuten.\n\nHeeft u dit niet aangevraagd? Dan kunt u deze e-mail negeren.',
        button: 'Mijn e-mailadres bevestigen',
      },
    },
  },
  {
    key: 'verify_email_removes_password',
    group: 'Account & security',
    label: 'Confirm e-mail address (link, account has a password)',
    when: 'Same as "Confirm e-mail address", for a not yet confirmed account that already has a password: confirming removes that password.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.verify',
    fields: VERIFY_FIELDS,
    defaults: {
      en: {
        subject: 'Verify your {{site.name}} e-mail address',
        body: `Dear {{customer.name}},\n\nClick the button below to confirm that this e-mail address belongs to you. The link expires in {{link.valid_minutes}} minutes.\n\n${REMOVES_PASSWORD_NOTE.en}\n\nIf you didn’t request this, you can safely ignore this e-mail.`,
        button: 'Verify my e-mail',
      },
      nl: {
        subject: 'Bevestig uw e-mailadres voor {{site.name}}',
        body: `Geachte {{customer.name}},\n\nKlik op de knop hieronder om te bevestigen dat dit e-mailadres van u is. De link verloopt over {{link.valid_minutes}} minuten.\n\n${REMOVES_PASSWORD_NOTE.nl}\n\nHeeft u dit niet aangevraagd? Dan kunt u deze e-mail negeren.`,
        button: 'Mijn e-mailadres bevestigen',
      },
    },
  },
  {
    key: 'verification_code',
    group: 'Account & security',
    label: 'Verification code (sign-up)',
    when: 'Someone signs up, or signs in to an account whose address is not confirmed yet: a 5-digit code confirms the address.',
    audience: 'customer',
    canDisable: false,
    fields: [
      { name: 'code', label: 'Verification code', example: '48213' },
      { name: 'code.valid_minutes', label: 'Code valid for (minutes)', example: '10' },
    ],
    defaults: {
      en: {
        subject: '{{code}} is your {{site.name}} verification code',
        body:
          'Enter this code to finish creating your {{site.name}} account:\n\n**{{code}}**\n\nThis code expires in {{code.valid_minutes}} minutes. If you didn’t sign up, you can safely ignore this e-mail.',
        button: '',
      },
      nl: {
        subject: '{{code}} is uw verificatiecode voor {{site.name}}',
        body:
          'Voer deze code in om het aanmaken van uw {{site.name}}-account af te ronden:\n\n**{{code}}**\n\nDeze code verloopt over {{code.valid_minutes}} minuten. Heeft u zich niet aangemeld? Dan kunt u deze e-mail negeren.',
        button: '',
      },
    },
  },
  {
    key: 'sign_up_existing_account',
    group: 'Account & security',
    label: 'Sign-up with an existing address',
    when: 'Someone tries to sign up with an address that already has a confirmed account (no code is sent).',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.sign_in',
    fields: [
      { name: 'link.sign_in', label: 'Sign-in page', example: 'https://labtodate.com/auth/sign-in' },
      { name: 'link.forgot_password', label: 'Link to "Forgot password"', example: 'https://labtodate.com/auth/forgot-password' },
    ],
    defaults: {
      en: {
        subject: 'You already have a {{site.name}} account',
        body:
          'Someone (hopefully you) tried to create a {{site.name}} account with this address, but it already has one.\n\nSign in, or reset your password at {{link.forgot_password}} if you don’t remember it.\n\nIf this wasn’t you, you can safely ignore this e-mail. Nothing has changed.',
        button: 'Sign in',
      },
      nl: {
        subject: 'U heeft al een {{site.name}}-account',
        body:
          'Iemand (hopelijk u) probeerde een {{site.name}}-account aan te maken met dit adres, maar er bestaat al een account voor.\n\nLog in, of stel uw wachtwoord opnieuw in via {{link.forgot_password}} als u het niet meer weet.\n\nWas u dit niet? Dan kunt u deze e-mail negeren. Er is niets gewijzigd.',
        button: 'Inloggen',
      },
    },
  },
  {
    key: 'sign_in_link',
    group: 'Account & security',
    label: 'Sign-in link',
    when: 'Someone asks for a sign-in link (passwordless sign-in) for an existing account.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.sign_in',
    fields: SIGN_IN_FIELDS,
    defaults: {
      en: {
        subject: 'Your {{site.name}} sign-in link',
        body:
          'Click the button below to sign in. The link expires in {{link.valid_minutes}} minutes.\n\nIf you didn’t request this, you can safely ignore this e-mail.',
        button: 'Sign in to {{site.name}}',
      },
      nl: {
        subject: 'Uw inloglink voor {{site.name}}',
        body:
          'Klik op de knop hieronder om in te loggen. De link verloopt over {{link.valid_minutes}} minuten.\n\nHeeft u dit niet aangevraagd? Dan kunt u deze e-mail negeren.',
        button: 'Inloggen bij {{site.name}}',
      },
    },
  },
  {
    key: 'sign_in_link_removes_password',
    group: 'Account & security',
    label: 'Sign-in link (account has a password)',
    when: 'Same as "Sign-in link", for a not yet confirmed account that already has a password: signing in removes that password.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.sign_in',
    fields: SIGN_IN_FIELDS,
    defaults: {
      en: {
        subject: 'Your {{site.name}} sign-in link',
        body: `Click the button below to sign in. The link expires in {{link.valid_minutes}} minutes.\n\n${REMOVES_PASSWORD_NOTE.en}\n\nIf you didn’t request this, you can safely ignore this e-mail.`,
        button: 'Sign in to {{site.name}}',
      },
      nl: {
        subject: 'Uw inloglink voor {{site.name}}',
        body: `Klik op de knop hieronder om in te loggen. De link verloopt over {{link.valid_minutes}} minuten.\n\n${REMOVES_PASSWORD_NOTE.nl}\n\nHeeft u dit niet aangevraagd? Dan kunt u deze e-mail negeren.`,
        button: 'Inloggen bij {{site.name}}',
      },
    },
  },
  {
    key: 'sign_in_no_account',
    group: 'Account & security',
    label: 'Sign-in link asked for an unknown address',
    when: 'Someone asks for a sign-in link for an address that has no account.',
    audience: 'customer',
    canDisable: false,
    buttonLink: 'link.sign_up',
    fields: [
      { name: 'link.sign_up', label: 'Sign-up page', example: 'https://labtodate.com/auth/sign-up' },
    ],
    defaults: {
      en: {
        subject: 'Sign-in request for {{site.name}}',
        body:
          'Someone asked for a sign-in link for this address, but there is no {{site.name}} account for it yet.\n\nTo get started, create an account.\n\nIf you didn’t request this, you can safely ignore this e-mail.',
        button: 'Create an account',
      },
      nl: {
        subject: 'Inlogverzoek voor {{site.name}}',
        body:
          'Iemand heeft een inloglink aangevraagd voor dit adres, maar er bestaat nog geen {{site.name}}-account voor.\n\nWilt u aan de slag? Maak dan een account aan.\n\nHeeft u dit niet aangevraagd? Dan kunt u deze e-mail negeren.',
        button: 'Account aanmaken',
      },
    },
  },
];
