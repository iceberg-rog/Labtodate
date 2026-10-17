# Bot check and e-mail protection

Why: from 2026-10-05 scripts signed up 93 accounts through Tor (one user agent,
none verified) with addresses on US carriers' SMS gateways (`…@txt.att.net`),
and the site sent 171 verification and reset e-mails from the business mailbox
to strangers' phones. There was no CAPTCHA and every limit was per IP.

Every number and switch below is in **Admin → Settings → Security** (changes
need `security:manage` and a fresh authenticator code, and go to Change
history and the super-admins).

## Bot check (ALTCHA proof of work)

- Self-hosted: `altcha-lib` creates and verifies challenges on this server with
  HMAC keys derived from `BETTER_AUTH_SECRET` (or `CAPTCHA_HMAC_SECRET` if set).
  No call to any other service, no cookies, nothing to block from an
  Iran-hosted server. The widget is the `altcha` web component.
- The browser solves PBKDF2-SHA-256 puzzles (`CAPTCHA_COST` rounds per try,
  up to `CAPTCHA_MAX_TRIES` tries): about 1 s on a laptop, 1–3 s on a phone.
  Verifying is one HMAC. A solved challenge works once, for the form it was
  issued for, until `CAPTCHA_EXPIRY_MIN`.
- Always on (`CAPTCHA_ALWAYS`): sign-up, “Forgot password”, e-mailed sign-in
  links, new verification codes/links, and the support and sell forms for
  guests. `CAPTCHA_SIGNED_IN_FORMS` adds signed-in customers on the support,
  sell and quote forms.
- Progressive at password sign-in: after `CAPTCHA_SIGNIN_AFTER_FAILS` wrong
  passwords for the account (or `CAPTCHA_SIGNIN_AFTER_IP_FAILS` from one
  network) every further try needs the check; the lockouts still apply.
- A checked sign-up may send its first code without a second puzzle (one-use
  pass, 10 minutes). Networks that keep asking for puzzles get bigger ones
  (`CAPTCHA_ESCALATE_AFTER`).
- Enforced in better-auth's `before` hook on the endpoint's own path
  (`src/lib/auth.ts`), so server code calling `auth.api.*` (an admin's
  “Send reset e-mail”) is not asked. Code: `src/lib/security/captcha.ts`,
  `src/app/api/captcha/route.ts`, `src/components/security/Captcha.tsx`.

## E-mail guards (`src/lib/email-guard`)

Every `sendEmail` call has a trigger (`auth.signup-code`, `form.support`,
`transactional`, `internal` …), logged on its `EmailLog` row with the
recipient domain and the requester's IP.

- No e-mail of any kind to `MAIL_BLOCKED_DOMAINS` (default: the SMS gateways)
  or, with `MAIL_BLOCK_DISPOSABLE`, to ~9,900 throw-away domains
  (`disposable-domains.ts`, CC0 list; exceptions in `MAIL_ALLOWED_DOMAINS`).
  Sign-up and the guest forms refuse those addresses before anything is saved.
- E-mails a visitor can trigger without signing in: per address a wait
  (`MAIL_ADDRESS_COOLDOWN_SEC`) and a daily cap, per domain an hourly cap
  (big providers exempt), and an hourly total (`MAIL_ANON_MAX_PER_HOUR`,
  super-admins alerted). Orders, quotes, invoices and staff mail are not limited.
  A refusal about one address is answered like a sent e-mail (no account
  enumeration); a new verification code is not even made then, so the one
  already sent keeps working.
- A permanent rejection of the address (5xx at RCPT TO / 5.1.x) suppresses it
  (`MAIL_BOUNCE_SUPPRESS_AFTER`; table `email_suppression`, scope `ALL`).
  Bounces that arrive later as DSN mails in the sending mailbox are not read
  automatically: paste the address under E-mail protection → “Stop e-mailing”.
- Per-network limits for sign-up and code/link/reset requests are settings too
  (`MAIL_IP_*`).

Admin → Security → **E-mail protection** shows what was sent and held back in
the last 24 h, recipient domains, held-back e-mails with reason and IP, and
the suppressed addresses (release / add).

## Unverified accounts

Admin → Users → **Unverified accounts** previews abandoned unverified buyer
accounts (no order, quote, ticket, listing, message, review or billing
details; never staff or suppliers) by age, start date and domain, and deletes
them after a fresh authenticator code. The addresses go to the audit log
(`users.purge-unverified`). `UNVERIFIED_AUTO_PURGE` lets the security sweep do
it every 5 minutes (off by default).

For the October 2026 accounts: filter *older than 1 day*, *created on or after
2026-10-05*, check the list (93 accounts on txt.att.net / mms.att.net /
tmomail.net / vtext.com), then delete.

## Deploying

- Migration `9a_bot_abuse_guards` only adds nullable columns and indexes to
  `EmailLog`.
- `npm run build` copies the widget's worker to `public/altcha/pbkdf2.js`
  (`prebuild`); it is served from the site itself, which the nginx CSP
  (`script-src 'self'`, no `blob:`) allows.
- Nothing else to configure: the defaults are on.
