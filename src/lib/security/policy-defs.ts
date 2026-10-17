/**
 * Security & platform policy definitions — pure data (no DB), so the B00
 * settings registry (src/lib/settings/defs.ts) can register every key in the
 * one typed list: the keys appear in Admin → Settings (Security tab) and their
 * changes in Change history. Runtime reading/saving stays in ./policy.ts.
 */

export const STEP_UP_ACTION_LABELS = {
  'users.role': 'Change someone’s role (promote / demote)',
  'users.caps': 'Change an admin’s permissions',
  'users.delete': 'Delete or suspend user accounts',
  'users.2fa_reset': 'Reset someone’s two-factor sign-in',
  'staff.invite': 'Invite staff',
  'settings.sensitive': 'Change bank, company, e-mail or payment settings',
  'security.settings': 'Change this security policy',
  'orders.delete': 'Permanently delete orders',
  'marketing.send': 'E-mail an announcement / offer to customers',
} as const;
export type StepUpAction = keyof typeof STEP_UP_ACTION_LABELS;

export const POLICY_ROLES = ['ADMIN', 'SELLER', 'BUYER'] as const;

type Base = { key: string; group: PolicyGroup; label: string; hint: string };
export type PolicyDef =
  | (Base & { type: 'bool'; default: boolean })
  | (Base & { type: 'int'; default: number; min: number; max: number; unit?: string })
  | (Base & { type: 'text'; default: string; pattern?: RegExp; patternHint?: string; placeholder?: string })
  | (Base & { type: 'set'; default: string[]; options: Record<string, string> })
  // A long list edited in a text box (one entry per line or comma-separated),
  // stored comma-separated and lower-cased. Every entry must match `item`.
  | (Base & { type: 'list'; default: string[]; item: RegExp; itemHint: string; maxItems: number; placeholder?: string });

export const POLICY_GROUPS = {
  twofactor: 'Two-factor sign-in & dangerous actions',
  admins: 'Admin accounts',
  sessions: 'Admin sessions',
  signin: 'Sign-in protection (brute force)',
  captcha: 'Bot check (“I’m not a robot” puzzle)',
  mailguard: 'E-mails a visitor can trigger without signing in',
  accounts: 'Unverified accounts',
  marketing: 'Marketing e-mail',
  backups: 'Backups',
} as const;
export type PolicyGroup = keyof typeof POLICY_GROUPS;

/** Where the bot check can be switched on (CAPTCHA_ALWAYS). */
export const CAPTCHA_ALWAYS_OPTIONS = {
  signup: 'Sign-up',
  password_reset: '“Forgot password” e-mails',
  magic_link: 'E-mailed sign-in links',
  verify_email: 'New verification codes and links (“Resend code”, unverified sign-in)',
  support: 'Support / contact form (guests)',
  sell: '“Sell your equipment” form (guests)',
} as const;

/** SMS / MMS gateways: an e-mail there becomes a text message to a phone number. */
export const SMS_GATEWAY_DOMAINS = [
  'txt.att.net',
  'mms.att.net',
  'vtext.com',
  'vzwpix.com',
  'tmomail.net',
  'messaging.sprintpcs.com',
  'sms.myboostmobile.com',
] as const;

/** Large mail providers whose users share a domain (exempt from the per-domain hourly cap). */
export const BIG_MAIL_PROVIDERS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com',
  'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'gmx.net', 'gmx.de', 'web.de', 't-online.de',
  'ziggo.nl', 'kpnmail.nl', 'xs4all.nl', 'planet.nl', 'hetnet.nl', 'home.nl', 'telenet.be', 'skynet.be',
] as const;

const DOMAIN_LIST = /^\s*$|^\s*[a-z0-9.-]+\.[a-z]{2,}(\s*,\s*[a-z0-9.-]+\.[a-z]{2,})*\s*$/i;
/** One domain entry of a 'list' field, e.g. txt.att.net. */
export const DOMAIN_ITEM = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const EMAIL_LIST = /^\s*$|^\s*[^@\s,]+@[^@\s,]+\.[^@\s,]+(\s*,\s*[^@\s,]+@[^@\s,]+\.[^@\s,]+)*\s*$/;
// rclone:<remote>:<path>  or  scp:<user>@<host>:<absolute path>
const BACKUP_TARGET = /^\s*$|^rclone:[A-Za-z0-9_.-]+:[^\s]*$|^scp:[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:\/[^\s]*$/;

export const POLICY_DEFS: readonly PolicyDef[] = [
  // ── Two-factor ───────────────────────────────────────────────────────────
  {
    key: 'TWO_FACTOR_REQUIRED_ROLES', group: 'twofactor', type: 'set', default: ['ADMIN'],
    options: { ADMIN: 'Admins (staff)', SELLER: 'Internal suppliers', BUYER: 'Buyers' },
    label: 'Require an authenticator app for',
    hint: 'Accounts with these roles must set up a TOTP authenticator app (Google/Microsoft Authenticator, 1Password …) before they can use their account. They get 10 one-time recovery codes.',
  },
  {
    key: 'ADMIN_MAGIC_LINK_ALLOWED', group: 'twofactor', type: 'bool', default: false,
    label: 'Allow e-mailed sign-in links for admins',
    hint: 'Off: admins (and anyone with two-factor on) sign in with password + authenticator only — someone who gets into an admin’s mailbox can’t take over the console.',
  },
  {
    key: 'STEP_UP_ACTIONS', group: 'twofactor', type: 'set',
    default: Object.keys(STEP_UP_ACTION_LABELS),
    options: STEP_UP_ACTION_LABELS,
    label: 'Ask for a fresh authenticator code before',
    hint: 'A signed-in admin must re-confirm with a code (or password, if they have no authenticator) before these actions.',
  },
  {
    key: 'STEP_UP_MAX_AGE_MIN', group: 'twofactor', type: 'int', default: 10, min: 1, max: 120, unit: 'minutes',
    label: 'A confirmation is valid for',
    hint: 'After confirming once, further dangerous actions in the same session don’t ask again for this long.',
  },
  // ── Admin accounts ───────────────────────────────────────────────────────
  {
    key: 'ONLY_SUPER_ADMIN_CREATES_ADMINS', group: 'admins', type: 'bool', default: true,
    label: 'Only super-admins can make someone an admin',
    hint: 'On: promoting a user to admin and inviting staff need a super-admin. Off: anyone with users:manage can, but only with permissions they hold themselves.',
  },
  {
    key: 'ADMIN_EMAIL_DOMAINS', group: 'admins', type: 'text', default: '',
    pattern: DOMAIN_LIST, patternHint: 'comma-separated domains, e.g. labtodate.com, samparsbenelux.com',
    placeholder: 'labtodate.com, samparsbenelux.com',
    label: 'Admin e-mail domains',
    hint: 'If set, only addresses on these domains can be promoted to admin or invited as staff (domains your company controls). Empty = any domain. Existing admins are not affected.',
  },
  {
    key: 'STAFF_INVITE_TTL_HOURS', group: 'admins', type: 'int', default: 72, min: 1, max: 720, unit: 'hours',
    label: 'Staff invitations expire after',
    hint: 'An unused invitation link stops working after this long.',
  },
  // ── Sessions ─────────────────────────────────────────────────────────────
  {
    key: 'ADMIN_SESSION_ABSOLUTE_HOURS', group: 'sessions', type: 'int', default: 12, min: 0, max: 720, unit: 'hours',
    label: 'Admins must sign in again after',
    hint: 'Maximum age of an admin session, active or not. 0 = same as everyone else (7 days, renewed while used).',
  },
  {
    key: 'ADMIN_IDLE_TIMEOUT_MIN', group: 'sessions', type: 'int', default: 30, min: 0, max: 1440, unit: 'minutes',
    label: 'Sign admins out after inactivity of',
    hint: 'An admin session with no page loads or actions for this long is ended. 0 = off.',
  },
  // ── Sign-in protection ───────────────────────────────────────────────────
  {
    key: 'LOGIN_MAX_FAILS_PER_ACCOUNT_IP', group: 'signin', type: 'int', default: 8, min: 3, max: 100,
    label: 'Wrong passwords per account and network before a pause',
    hint: 'After this many wrong passwords for one account from one IP address within the window below, password sign-in for that account is paused from that address. Colleagues on the same network (e.g. a university) are not affected.',
  },
  {
    key: 'LOGIN_MAX_FAILS_PER_ACCOUNT', group: 'signin', type: 'int', default: 30, min: 5, max: 1000,
    label: 'Wrong passwords per account from all networks before a pause',
    hint: 'Stops slow guessing spread over many addresses (window: 1 hour). The account owner can always get in with “Forgot password”, which lifts the pause.',
  },
  {
    key: 'LOGIN_FAIL_WINDOW_MIN', group: 'signin', type: 'int', default: 15, min: 1, max: 1440, unit: 'minutes',
    label: 'Counting window for wrong passwords (per network)',
    hint: 'Wrong passwords older than this no longer count.',
  },
  {
    key: 'LOCKOUT_BASE_MINUTES', group: 'signin', type: 'int', default: 15, min: 1, max: 1440, unit: 'minutes',
    label: 'First pause lasts',
    hint: 'Each further pause in a row doubles, up to the maximum below.',
  },
  {
    key: 'LOCKOUT_MAX_MINUTES', group: 'signin', type: 'int', default: 1440, min: 1, max: 10080, unit: 'minutes',
    label: 'Longest pause',
    hint: 'Cap for the doubling pauses.',
  },
  {
    key: 'IP_SIGNIN_LIMIT_PER_15MIN', group: 'signin', type: 'int', default: 100, min: 10, max: 10000,
    label: 'Wrong passwords per IP address per 15 minutes',
    hint: 'Across all accounts (password spraying). Only wrong passwords count, and it is generous on purpose: a whole university or company often shares one address.',
  },
  {
    key: 'NEW_DEVICE_ALERT', group: 'signin', type: 'bool', default: true,
    label: 'E-mail people when their account signs in from a new device',
    hint: 'Browser + operating system they never signed in with before. Tells them how to react if it wasn’t them.',
  },
  {
    key: 'LOCKOUT_EMAIL_ENABLED', group: 'signin', type: 'bool', default: true,
    label: 'E-mail the account owner when sign-in is paused',
    hint: 'Tells them what happened and links to “Forgot password”. Pauses on admin accounts are also reported to super-admins.',
  },
  // ── Bot check (ALTCHA proof-of-work, verified on this server) ───────────
  {
    key: 'CAPTCHA_ALWAYS', group: 'captcha', type: 'set',
    default: Object.keys(CAPTCHA_ALWAYS_OPTIONS),
    options: CAPTCHA_ALWAYS_OPTIONS,
    label: 'Always ask for the bot check on',
    hint: 'The visitor’s browser solves a small puzzle (about a second, no images to click, no cookies, nothing sent to another company) before the request is accepted. Scripts that mail strangers through these forms have to pay that cost for every e-mail.',
  },
  {
    key: 'CAPTCHA_SIGNED_IN_FORMS', group: 'captcha', type: 'bool', default: false,
    label: 'Also ask signed-in customers on the support, sell and quote forms',
    hint: 'Off: only guests get the check on those forms (signed-in accounts have a confirmed e-mail address and their own limits). Quote requests always need sign-in, so this switch is the only one that adds the check there.',
  },
  {
    key: 'CAPTCHA_SIGNIN_AFTER_FAILS', group: 'captcha', type: 'int', default: 3, min: 0, max: 100, unit: 'wrong passwords',
    label: 'Ask at password sign-in after',
    hint: 'Wrong passwords for one account (from one network within the counting window above, or from all networks within an hour). The person can keep trying after solving the check; the pauses above still apply. 0 = ask at every password sign-in.',
  },
  {
    key: 'CAPTCHA_SIGNIN_AFTER_IP_FAILS', group: 'captcha', type: 'int', default: 10, min: 1, max: 10000, unit: 'wrong passwords',
    label: '…or after this many wrong passwords from one network (any account, 15 minutes)',
    hint: 'Password spraying across many accounts from one address.',
  },
  {
    key: 'CAPTCHA_COST', group: 'captcha', type: 'int', default: 1000, min: 100, max: 100000, unit: 'rounds per try',
    label: 'Puzzle work per try',
    hint: 'PBKDF2-SHA-256 rounds the browser computes for each try. Together with the puzzle size below this sets how long the check takes: the default (1,000 × up to 3,000 tries) is about 1 second on a laptop and 2–4 seconds on an older phone. Doubling either value doubles the time for people and for bots.',
  },
  {
    key: 'CAPTCHA_MAX_TRIES', group: 'captcha', type: 'int', default: 3000, min: 50, max: 1000000, unit: 'tries',
    label: 'Puzzle size (most tries needed)',
    hint: 'Each puzzle needs a random number of tries between a third of this and this value.',
  },
  {
    key: 'CAPTCHA_ESCALATE_AFTER', group: 'captcha', type: 'int', default: 10, min: 0, max: 1000, unit: 'puzzles / hour',
    label: 'Harder puzzles for a network after',
    hint: 'When one IP address has asked for more puzzles than this within an hour, each further batch of the same size doubles the work (up to 8×). Normal visitors never get there. 0 = always the normal size.',
  },
  {
    key: 'CAPTCHA_EXPIRY_MIN', group: 'captcha', type: 'int', default: 15, min: 1, max: 120, unit: 'minutes',
    label: 'A puzzle is valid for',
    hint: 'Solved or not; the form fetches a fresh one by itself after that. Each solved puzzle is accepted once.',
  },
  // ── Anonymous e-mail guards (sendEmail) ─────────────────────────────────
  {
    key: 'MAIL_BLOCKED_DOMAINS', group: 'mailguard', type: 'list', default: [...SMS_GATEWAY_DOMAINS],
    item: DOMAIN_ITEM, itemHint: 'a domain such as txt.att.net', maxItems: 2000,
    placeholder: 'txt.att.net\nvtext.com',
    label: 'Never e-mail these domains (and their subdomains)',
    hint: 'Sign-up, “Forgot password”, sign-in links and the guest forms refuse these addresses, and no e-mail of any kind is sent there. The default list holds the SMS gateways of US phone carriers: mail to them is delivered as a text message to a stranger’s phone. One domain per line.',
  },
  {
    key: 'MAIL_BLOCK_DISPOSABLE', group: 'mailguard', type: 'bool', default: true,
    label: 'Refuse disposable (throw-away) e-mail addresses',
    hint: 'A built-in list of about 9,900 throw-away mail domains (mailinator, 10minutemail, …), refused like the list above.',
  },
  {
    key: 'MAIL_ALLOWED_DOMAINS', group: 'mailguard', type: 'list', default: [],
    item: DOMAIN_ITEM, itemHint: 'a domain such as example-university.edu', maxItems: 500,
    label: 'Never treat as disposable',
    hint: 'Domains on the built-in throw-away list that your customers really use. Does not override the “Never e-mail” list above.',
  },
  {
    key: 'MAIL_ADDRESS_COOLDOWN_SEC', group: 'mailguard', type: 'int', default: 60, min: 0, max: 86400, unit: 'seconds',
    label: 'Wait at least this long between two such e-mails to one address',
    hint: 'Codes, sign-in links, reset links, “no account yet” notices and guest-form confirmations. The visitor is told how long to wait (except on “Forgot password”, which never says whether an account exists). 0 = no wait.',
  },
  {
    key: 'MAIL_ADDRESS_MAX_PER_DAY', group: 'mailguard', type: 'int', default: 8, min: 1, max: 1000, unit: 'e-mails / 24 h',
    label: 'At most this many to one address per day',
    hint: 'Counted over the last 24 hours.',
  },
  {
    key: 'MAIL_DOMAIN_MAX_PER_HOUR', group: 'mailguard', type: 'int', default: 20, min: 1, max: 100000, unit: 'e-mails / hour',
    label: 'At most this many to one domain per hour',
    hint: 'Stops a script working through many addresses of one domain (e.g. one phone carrier’s gateway, or one company). Large mail providers listed below are exempt.',
  },
  {
    key: 'MAIL_DOMAIN_CAP_EXEMPT', group: 'mailguard', type: 'list', default: [...BIG_MAIL_PROVIDERS],
    item: DOMAIN_ITEM, itemHint: 'a domain such as gmail.com', maxItems: 500,
    label: 'Domains exempt from the per-domain cap',
    hint: 'Mail providers shared by many unrelated people. The per-address limits and the hourly total still apply.',
  },
  {
    key: 'MAIL_ANON_MAX_PER_HOUR', group: 'mailguard', type: 'int', default: 100, min: 1, max: 100000, unit: 'e-mails / hour',
    label: 'Hourly total of such e-mails',
    hint: 'Above this, these e-mails stop until the hour is over (orders, quotes, invoices and staff mail are not affected) and super-admins are alerted. Protects the sending mailbox from being blocked by your mail provider.',
  },
  {
    key: 'MAIL_IP_SIGNUPS_PER_HOUR', group: 'mailguard', type: 'int', default: 5, min: 1, max: 10000, unit: 'sign-ups / hour',
    label: 'Sign-ups per network per hour',
    hint: 'Per IP address. A whole university behind one address rarely signs up more than a few people an hour.',
  },
  {
    key: 'MAIL_IP_REQUESTS_PER_15MIN', group: 'mailguard', type: 'int', default: 5, min: 1, max: 10000, unit: 'requests / 15 min',
    label: 'Code, link and reset requests per network per 15 minutes',
    hint: 'Per IP address and per kind (verification code, sign-in link, “Forgot password”, verification link).',
  },
  {
    key: 'MAIL_BOUNCE_SUPPRESS_AFTER', group: 'mailguard', type: 'int', default: 1, min: 0, max: 20, unit: 'rejections',
    label: 'Stop e-mailing an address after the mail server rejected it',
    hint: 'A permanent rejection (5xx: no such mailbox, mailbox disabled) of the address itself. Suppressed addresses are listed under Admin → Security → E-mail protection, where you can release them. Staff copies are never suppressed. 0 = off.',
  },
  {
    key: 'MAIL_GUARD_ALERTS', group: 'mailguard', type: 'bool', default: true,
    label: 'Alert super-admins when the hourly total is reached',
    hint: 'At most one alert per hour.',
  },
  // ── Unverified accounts ──────────────────────────────────────────────────
  {
    key: 'UNVERIFIED_PURGE_DAYS', group: 'accounts', type: 'int', default: 7, min: 1, max: 365, unit: 'days',
    label: 'An unverified account counts as abandoned after',
    hint: 'Accounts whose e-mail address was never confirmed can’t sign in. Admin → Users → Unverified accounts lists the abandoned ones and deletes them (preview first). Accounts with any order, quote, ticket, listing or message are never deleted.',
  },
  {
    key: 'UNVERIFIED_AUTO_PURGE', group: 'accounts', type: 'bool', default: false,
    label: 'Delete abandoned unverified accounts automatically',
    hint: 'The security sweep (every 5 minutes) deletes them with the same rules as the admin tool and writes each run to the audit log.',
  },
  // ── Marketing e-mail ─────────────────────────────────────────────────────
  {
    key: 'MARKETING_SOFT_OPT_IN', group: 'marketing', type: 'bool', default: true,
    label: 'E-mail offers to existing customers who haven’t opted out (soft opt-in)',
    hint: 'Dutch Telecommunicatiewet art. 11.7(3): customers who bought from you may get offers for similar products unless they opted out; every e-mail carries an unsubscribe link. Off: only people who explicitly opted in get offer e-mails.',
  },
  {
    key: 'ANNOUNCEMENT_EMAILS_PER_MINUTE', group: 'marketing', type: 'int', default: 60, min: 1, max: 3000, unit: 'e-mails / minute',
    label: 'Sending speed for announcement e-mails',
    hint: 'Announcement e-mails go out in the background at this rate. Keep it below your mail provider’s hourly limit (TransIP, Resend …).',
  },
  {
    key: 'EMAIL_REPLY_TO', group: 'marketing', type: 'text', default: '',
    pattern: EMAIL_LIST, patternHint: 'one e-mail address',
    placeholder: 'support@labtodate.com',
    label: 'Reply-To for announcement e-mails',
    hint: 'Where replies to announcements go. Empty = the public support e-mail (Settings → Brand).',
  },
  // ── Backups ──────────────────────────────────────────────────────────────
  {
    key: 'BACKUP_TARGET', group: 'backups', type: 'text', default: '',
    pattern: BACKUP_TARGET, patternHint: 'rclone:<remote>:<path> or scp:<user>@<host>:/<path>',
    placeholder: 'rclone:b2:lab2date-backups/prod',
    label: 'Off-site backup destination',
    hint: 'Where scripts/backup-v2.sh ships the encrypted archive: an rclone remote (Backblaze B2, S3, Hetzner Storage Box …) configured on the server, or an SSH/SCP target. The server’s own .env (BACKUP_TARGET) is used when this is empty.',
  },
  {
    key: 'BACKUP_KEEP_DAILY', group: 'backups', type: 'int', default: 30, min: 1, max: 365, unit: 'days',
    label: 'Keep daily backups for',
    hint: 'Older daily archives are deleted from the destination after each successful run.',
  },
  {
    key: 'BACKUP_KEEP_MONTHLY', group: 'backups', type: 'int', default: 12, min: 0, max: 120, unit: 'months',
    label: 'Also keep one backup per month for',
    hint: 'The first archive of each month is kept this many months.',
  },
  {
    key: 'BACKUP_MAX_AGE_HOURS', group: 'backups', type: 'int', default: 26, min: 2, max: 336, unit: 'hours',
    label: 'Alert when the last good backup is older than',
    hint: 'Checked by the security sweep cron and shown on the admin overview.',
  },
  {
    key: 'BACKUP_ALERT_EMAILS', group: 'backups', type: 'text', default: '',
    pattern: EMAIL_LIST, patternHint: 'comma-separated e-mail addresses',
    placeholder: 'ops@labtodate.com',
    label: 'Send backup failure alerts to',
    hint: 'Empty = every super-admin.',
  },
];
