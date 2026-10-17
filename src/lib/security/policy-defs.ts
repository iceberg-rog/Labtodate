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
  | (Base & { type: 'set'; default: string[]; options: Record<string, string> });

export const POLICY_GROUPS = {
  twofactor: 'Two-factor sign-in & dangerous actions',
  admins: 'Admin accounts',
  sessions: 'Admin sessions',
  signin: 'Sign-in protection (brute force)',
  marketing: 'Marketing e-mail',
  backups: 'Backups',
} as const;
export type PolicyGroup = keyof typeof POLICY_GROUPS;

const DOMAIN_LIST = /^\s*$|^\s*[a-z0-9.-]+\.[a-z]{2,}(\s*,\s*[a-z0-9.-]+\.[a-z]{2,})*\s*$/i;
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
